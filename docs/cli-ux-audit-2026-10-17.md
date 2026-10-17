# Flare CLI 现状审计（2026-10-17）

审计方式：读源码 + 真实 PTY（python pty.fork）驱动已安装的 0.6.147 二进制实测，非推测。

复现脚本（都在临时 FLARE_HOME 里跑，不碰真实会话库，结束自动清理）：

```bash
python3 tests/manual/pty_paste_verify.py bracketed   # 10 行粘贴完整性（bracketed / legacy）
python3 tests/manual/pty_paste_e2e.py                # 粘贴+提交后从会话库读回逐字核对
FLARE_BIN=flare python3 tests/manual/pty_paste_e2e.py  # 同样验证已安装的生产二进制
```

缺陷 3/4（输入框跑出屏幕、无 SIGWINCH）本轮未修，复现时需要把 pty 窗口设成 24x80
后发 `/help`（约 50 行输出），观察光标绝对定位 row 是否超过 24。

---

## 一、结论先行

Flare 的**能力层**（模型、MCP、记忆、路由、上下文裁剪）已经很完整，但**终端交互层**基本处于
"能用就行"的原始状态，而且这一层没有任何自动化测试覆盖。用户感知到的"不好用"不是模型不行，
是输入/渲染这一层在拖后腿。

一句话定位：**142 轮迭代几乎全部投在命令面和文档面，输入层 0 测试、0 演进。**

---

## 二、实测到的 5 个硬缺陷（含数据）

### 缺陷 1（用户报告的）：多行粘贴只进第一行 —— 确认存在

实测：一次性向 PTY 写入 10 行（每行 `LINE-N-粘贴测试内容ABCDEFG`），结果：

```
LINE-1 出现次数: 47
LINE-2..LINE-10 出现次数: 0
```

10 行只保留了 1 行。

根因（`src/cli/line-input.ts:117-120`）：

```ts
if (ch === '\r' || ch === '\n') {
  this.handleEnterSubmit(resolve)
  return          // ← 整个 data 回调退出，同一 chunk 剩余字符全部丢弃
}
```

粘贴是**一次 data 事件带一大段文本**，第一个 `\n` 就 `return`，剩余全部丢失。
这是字节级丢弃，不是显示问题——模型真的只收到了第一行。

放大因素：`src/cli/` 全库无 `bracketed paste` 支持（`\x1b[200~ / \x1b[201~` 零匹配），
程序无法区分"粘贴内容里的换行"和"用户按了回车"。

### 缺陷 2：粘贴 >10KB 直接卡死

| 粘贴体量 | 结果 | 终端输出量 |
|---|---|---|
| 2.4 KB | TAILMARK 完整到达 | 1.76 MB |
| 9.6 KB | TAILMARK 未在 3s 内出现 | 7.93 MB |
| 24 KB | 100s 超时，CLI 无响应 | 卡死 |

输出放大 730 倍。根因 `src/cli/index.ts:117` + `166` + `189-193`：
`frameMode` 下**每插入一个字符**就 `onChange()` → `renderFrame()` → `\x1b[2J` 全屏清屏重绘；
另外还有 80ms 定时器每帧也整屏重绘。粘贴 6000 字符 = 6000 次清屏 + 整帧重写。

### 缺陷 3：内容一长，输入框跑到屏幕外

PTY 设为 24 行，执行 `/help`（约 50 行输出）：

```
最大光标定位 row 值: 49
超过窗口高度的定位次数: 24
```

`CONTENT_ROW = 6` 固定，输入行位置 = `6 + agentOutput 行数`（`index.ts:183`）。
内容超过终端高度后，`positionCursorAt` 定位到 row 49（窗口只有 24 行），终端把光标 clamp 到
最后一行——用户看不到输入框，打字会顶到底部并破坏布局。

### 缺陷 4：无 SIGWINCH 处理

全库无 `SIGWINCH` 监听。窗口拖动改大小后，`columns` 变量在下次重绘时才重新读，
`positionCursor` 基于旧列宽算出的位置会错位；折行输入会出现错行/残影。

### 缺陷 5：标准编辑键全部缺失

`line-input.ts:264` 注释直白写着 `// 其他序列（Home/End/Delete 等）：暂时忽略`。
实际支持：← → ↑ ↓ Backspace Ctrl+C。不支持：Home、End、Delete、Ctrl+A、Ctrl+E、Ctrl+U、
Ctrl+K、Ctrl+W、Ctrl+L、Ctrl+R 历史搜索、Tab 补全。历史记录存在内存数组（`HISTORY_MAX=100`），
退出即丢，没有 `~/.flare/history` 落盘。

另外 `line-input.ts:134` `if (ch.charCodeAt(0) < 32) continue` 会把 `\t` 当控制字符丢掉，
粘贴代码的缩进会消失。

### 附加缺陷：多字节 UTF-8 跨 chunk 风险

`line-input.ts:97` 直接 `chunk.toString('utf8')`，没有 `StringDecoder`。PTY 分片落在
多字节字符中间时会产生 `U+FFFD`。小体量测不出，大粘贴/SSH 高延迟下会偶发。

---

## 三、功能面现状（这部分其实做得不错）

- 版本 0.6.147，482 提交，155 轮迭代，1227 个测试全绿
- 工具：terminal / 文件读写 / 网络 / story / memory，MCP 全套（stdio + HTTP、resources、
  prompts、completion、logging/setLevel、订阅面）
- 多模型：主模型 + 本地 Ollama + 视觉模型，`/model` 热切换重建 Agent
- 上下文：裁剪、摘要（`--context-summarize`）、`context-status`、`trim`、`usage`
- 记忆：SQLite + FTS5 + trigram，相似记忆检测
- 路由：本地/远端混合路由 + 特征分布统计
- 缓存：prompt caching 命中诊断
- 40+ 顶层子命令、30+ 斜杠命令

问题不在能力，在**重心**。提交类型分布：

```
132 docs:       70 Progress:     54 feat      8 test
```

文档/进度记录 202 条 vs 测试 8 条。`tests/` 下 79 个文件里**没有任何一个碰 LineInput、
没有任何 TTY/粘贴测试**——这就是为什么 155 轮之后基础粘贴仍然是坏的。

代码结构：`src/cli/index.ts` **3429 行**单文件，命令注册、渲染、Agent 循环、40 个 handler
全塞在一起，改输入层要动这个巨文件，改动风险高，于是更没人改。

---

## 四、优化方向（按性价比排序）

### P0-A 粘贴正确性（约半天）

1. `readLine()` 进入时 `\x1b[?2004h`，退出时 `\x1b[?2004l` 开启 bracketed paste
2. 状态机识别 `\x1b[200~` 进入粘贴态、`\x1b[201~` 退出；粘贴态内 `\r\n`/`\n`/`\t`
   作为普通字符插入（`\r\n` 归一成 `\n`）
3. 非粘贴态遇到 `\n` 且**同一 chunk 后面还有内容**时，判定为"终端不支持 bracketed paste 的
   粘贴"，改为继续插入而非提交（兜底启发式）
4. 用 `StringDecoder` 替换 `chunk.toString()`
5. 控制字符白名单：保留 `\t`，其余照旧忽略
6. 补 `tests/line-input.test.ts`（把 stdin/stdout 抽象成可注入接口，不用真 TTY 也能测）

### P0-B 渲染重构：从"整屏清屏"到"区域渲染"（1-2 天）

1. 用 DECSTBM 滚动区把屏幕切成：内容区（1..rows-3）+ 分隔线 + 固定输入区（底部 2 行）。
   输入行永远固定在底部，内容再长也只是内容区滚动，输入框不会消失（解缺陷 3）
2. 内容区只追加、不整屏重绘；banner 动画只重绘 banner 那 4 行
3. 粘贴/高速输入期间渲染节流到 16ms 合并一次（解缺陷 2）
4. `process.on('SIGWINCH')` → 重算布局重绘（解缺陷 4）
5. 保留 scrollback：不再 `\x1b[2J`，用户可以用终端自己的回滚复制输出，`/pause` 可以退休

### P1-A 多行输入（半天）

终端里 Shift+Enter 与 Enter 在传统协议下无法区分，可靠做法二选一：
- `Ctrl+J` 插入换行（自己解析，100% 可靠）
- `Ctrl+O` 调用 `$EDITOR`/`$VISUAL` 编辑长文本，保存后整段作为一次输入
  （这个对"写长 prompt"体验最好，且实现最省事，推荐先做这个）

### P1-B 编辑键与历史（半天）

Home/End/Delete/Ctrl+A/E/U/K/W、Ctrl+L、Ctrl+R 增量历史搜索；历史落盘
`~/.flare/history`（按会话或全局，参考 bash 的 `HISTFILE`）。

### P1-C 拆巨型文件（1 天，纯重构零行为变化）

```
src/cli/index.ts        → 只留 main() + 命令注册
src/cli/render.ts       → 布局/帧渲染/动画
src/cli/input/line-input.ts
src/cli/commands/*.ts   → 每个子命令一个模块
```
拆完输入层才能放心改。建议**在 P0 之后**做，避免大 diff 叠加。

### P2 迭代路线纠偏

建议冻结"新增命令"一段时间。当前 40+ 顶层命令里真正日常用的不超过 8 个，
每加一个命令都在加维护面。下一步的迭代候选应该是：TTY 层测试补齐、`/help` 分层
（常用/高级）、启动耗时、首次响应延迟。

---

## 五、建议执行顺序

```
第 1 步  P0-A 粘贴正确性 + line-input 单测       ← 直接解决用户报告的 bug，半天可验证
第 2 步  P1-A Ctrl+O 外部编辑器                    ← 长 prompt 立刻顺手
第 3 步  P0-B 区域渲染 + SIGWINCH                  ← 体验质变，风险最大，独立一轮做
第 4 步  P1-B 编辑键 + 历史落盘
第 5 步  P1-C 拆文件 / P2 路线纠偏
```

每步仍按现有规矩走：tsc 0 错误 → 全量 1227 测试 → PTY 脚本实测 → 自安装 → 独立验收。
P0-A 做完用 `tests/manual/pty-paste-regression.py` 验收，标准是 LINE-1 到 LINE-10 全部出现。
