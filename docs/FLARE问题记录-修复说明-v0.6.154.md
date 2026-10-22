# FLARE 问题记录修复说明（v0.6.154 终端引擎重写）

> 来源：`~/Projects/downloader-research/FLARE问题记录.md`（用户 2026-10-20 实际用 flare 做下载器时记录的 13 条问题）
> 修复日期：2026-10-22
> 备份：`~/flare-backup-20261022-145612/`（src 828K + install-dist 1.8M）
> 安装产物二次备份：`~/flare-install-dist-before-sync-20261022-150341/`

---

## 一、结论总表

| # | 问题 | 状态 | 落点 |
|---|---|---|---|
| 1 | 危险正则误伤（命令里出现 `wget` 就拦） | ✅ 已修 | `src/tools/index.ts` 危险模式表 |
| 2 | 超时丢输出（`e.stdout` 为 null） | ✅ 已修 | 执行体重写为 `spawn` 流式收集 |
| 3 | `\r` 进度条刷屏 + 双重截断头尾双失 | ✅ 已修 | `collapseCarriageReturns` + 落盘留档 |
| 4 | 超时硬 SIGTERM，程序来不及清理 | ✅ 已修 | SIGINT → 2s 宽限 → SIGKILL |
| 5 | 无流式输出（长命令全程静默） | ✅ 已修 | 随 #2，边跑边收集 |
| 6 | heredoc 不可靠 | ⚪ 非缺陷 | 工具用法问题，建议 `write_file` 落盘 |
| 7 | 无长任务后台化（服务起不来） | ✅ 已修 | 新增 `background: true` 参数 |
| 8 | `nohup cmd &` 仍被同步等待 | ✅ 已修 | 随 #7（detached + unref） |
| 9 | `pkill -f` 自杀无预警 | ✅ 已修 | 运行时自伤预警文案 |
| 10 | 退出码 0 却报失败（孙进程持有管道） | ✅ 已修 | exit 兜底，管道 EOF 不再误判 |
| 11 | 迭代上限 30 次 | ✅ 已修（前次） | `src/core/agent.ts:302-308` 硬顶 200 + env + `-m` |
| 12 | 交付后断流（前端永久"生成中"） | ✅ 已修 | `server.ts` `sawDone`+catch+finally；`agent.ts` 工具异常兜底 |
| 13 | 上限硬编码 | ✅ 已修（前次） | 环境变量可配 |

**12/13 已修，1 条判定为非 flare 缺陷（#6）。**

---

## 二、核心改动：为什么不是"换一个 API"，而是重写执行引擎

旧实现 `execSync(cmd, {timeout, maxBuffer})` 有五个硬伤，**每一个都对应记录里的一条问题**：

| execSync 硬伤 | 对应问题 |
|---|---|
| 同步阻塞事件循环，全程无任何输出 | #5 无流式 |
| 超时抛错时 `e.stdout` 为 `null`，已产出的输出全丢 | #2 超时丢输出 |
| 超时固定发 `SIGTERM`，不响应 SIGTERM 的程序拖到硬杀 | #4 清理逻辑不执行 |
| 无法后台化，`nohup cmd &` 仍被同步等待（管道不 EOF） | #7 #8 |
| 管道被孙进程持有 → 超时/挂死，即使主进程 exit 0 | #10 |

所以 `src/tools/index.ts` 的 `terminal.execute` 整体重写为**异步 + `spawn` + 流式收集**，并抽出独立执行引擎层：

```ts
const MAX_CAPTURE_CHARS = 1024 * 1024   // 内存捕获上限 1MB，超出后丢弃并标记
const SPILL_THRESHOLD = 4000            // 超过 4000 字符落盘留档
const SPILL_KEEP = 20                   // 临时日志只保留最近 20 份
const ANSI_RE = /.../g                  // 颜色/光标/清屏序列清洗
function collapseCarriageReturns(s: string): string  // \r 折叠：每行只留最后一段
```

超时策略：`SIGINT` → 等 2 秒 → `SIGKILL`，两段都记录在错误信息里，且**超时前已产出的输出完整返回**。

---

## 三、逐条改动细节

### #1 危险命令正则误伤

原 `src/tools/index.ts:249`：

```ts
/\bwget|curl\b.*\|\s*(ba)?sh\b/
```

`|` 优先级导致实际等价于 `(\bwget) OR (curl\b.*\|\s*(ba)?sh\b)` —— **命令里只要出现 "wget" 一词就被拦**。实测 7 用例 4 个误判：`echo hello wget`、`for c in yt-dlp aria2c wget curl; do ...`、`grep -rn "wget" README.md`、`pip install wget`。

改后（顺带收紧两条同类）：

```ts
/\b(?:wget|curl)\b[^\n]*\|\s*(?:ba)?sh\b/,                     // curl|bash
/(?:^|[;&|]\s*)(?:sudo\s+)?(?:shutdown|reboot|init\s+0)\b/,    // 关机重启（锚定命令位，放过 echo reboot）
/\bgit\s+push\b[^\n]*\s--force(?![-_\w])/,                      // 放过 --force-with-lease
```

### #2 #5 #10 流式收集 + 退出码语义

- `spawn` 的 `stdout`/`stderr` 增量收集，超过 `MAX_CAPTURE_CHARS` 截断并标记。
- 主进程 `exit` 后即判定结束（`close` 事件若因孙进程持有管道迟迟不来，用 exit 兜底并在输出里注明），**exit 0 就是成功**。
- 失败时错误信息保留退出码：`命令执行失败（退出码 3）：...`（旧测试断言语义不变）。

### #3 `\r` 折叠 + 长输出落盘

两个病根：

1. 进度条用 `\r` 原地刷新，整段被当成一行巨型文本；
2. **两段截断方向打架**：工具内部 `slice(0, 10000)` 留头，`src/core/tool-output.ts` 对 terminal 又"留尾部 2000"，5 万字符输出最终只剩原始第 8000–10000 字符，开头结论和结尾完成信息双失。

修法：`collapseCarriageReturns` 折叠 `\r`（每行只留最后一段）+ ANSI 清洗；超过 `SPILL_THRESHOLD` 的完整输出写入 `~/.flare/tmp/term-*.log`，上下文里给尾部 + 明确路径。**数据不再丢失，可用 `read_file` 全文回读。**

### #4 SIGINT 双段超时

```ts
child.kill('SIGINT')                      // 先礼：让程序跑清理逻辑
setTimeout(() => child.kill('SIGKILL'), 2000)  // 后兵：不响应就强杀
```

实测：普通 `sleep 30` 约 1.0s 结束（SIGINT 生效，不升级）；`trap '' INT; sleep 30` 约 3.0s 结束（1s 超时 + 2s 宽限后 SIGKILL，错误信息注明已升级）。

### #7 #8 `background: true`

schema 新增参数，执行体分支调用 `runBackground(cmd)`：`detached: true` + `unref()` + stdout/stderr 重定向到日志文件，立即返回 PID、日志路径、查看命令、存活检查命令。用于起服务、守护进程、`nohup`、长任务。

### #9 `pkill -f` 自伤预警

检测 `\bpkill\b[^\n]*\s-{1,2}f\b` 时追加预警：`pkill -f` 的模式会匹配到执行它的 shell 自身（命令行里就含这串字符），可能把自己杀掉、后续输出全部丢失。可靠做法：`pgrep -f <模式>` 取 PID 再 `kill`，或加解释器前缀 `pkill -f "python3 xxx.py"`。

> 这条坑是真实踩过的：`pkill -f 'fluxdl_server.py'` 直接把 shell 自己杀了（exit -15）。

### #12 交付后断流（最严重，用户实际卡死）

故障链：工具抛异常 → 从 `run()` 逃逸 → SSE 流断但 `done` 帧没发 → 前端永久"生成中"、输入框 disabled、无任何报错。

两处裸奔都补上：

```ts
// src/core/agent.ts —— 工具执行异常降级为工具结果，交模型自我修正
let result: Awaited<ReturnType<typeof executeTool>>
try {
  result = injectedTool ? await injectedTool.execute(args) : await executeTool(tc.function.name, args)
} catch (toolErr: any) {
  result = { success: false, output: '', error: `工具执行抛异常: ${String(toolErr?.message || toolErr).slice(0, 500)}` }
}

// src/server.ts —— done 帧三路径必达且不重复
let sawDone = false
try {
  for await (const chunk of agent.run(...)) {
    if ((chunk as any)?.type === 'done') sawDone = true
    reply({ ...chunk, sessionId })
  }
} catch (e: any) {
  reply({ type: 'error', message: `生成中断: ${...}` })
} finally {
  cancels.delete(sessionId)
  if (!flag.cancelled && !sawDone) reply({ type: 'done', sessionId })
}
```

---

## 四、验证证据

### 单元测试

```
npx tsc --noEmit          → EXIT 0，类型零错误
npx vitest run            → 85 files / 1305 tests 全绿
                            （原 84 files / 1287 tests，新增 18 条验收测试）
```

新增 `tests/flare-issues-13.test.ts` 共 18 条，逐条对应记录编号，全部是**行为断言**（不锁实现，允许内部再改）：

- `#1` 7 条：4 个误判用例放行（`echo hello wget` / for 循环列举 / grep 关键字 / `--force-with-lease`）、3 个真危险拦截（`curl|sh`、`wget -O- |bash`、`sudo shutdown`）
- `#2 #4` 4 条：超时保输出、SIGINT 快速收尾、`trap '' INT` 时 SIGKILL 兜底（实测 3008ms）、错误含 `background` 建议
- `#3` 3 条：`\r` 折叠只留最终态、ANSI 剥离、超长输出落盘且全文完整（头 1 和尾 3000 都在）
- `#7 #8` 2 条：秒回 PID + 日志路径（<2s）、后台任务确实继续写日志
- `#9` 2 条：预警文案含「自伤风险」「pgrep」、不带 `-f` 不误报
- `#10` 1 条：孙进程持有管道时 exit 0 → 成功返回且耗时 <2.6s（旧版会等满或报超时）

`tests/terminal-exitcode.test.ts` 4 条由同步改 `await`，断言语义未变 —— 属接口迁移（`execute` 同步 → 异步），非行为变更。

### 生产安装版实测（`~/.flare/install/dist`，非源码）

```
#1  echo hello wget        → success=true  "hello wget"
#1  curl|sh                → 拦截，错误含匹配到的正则
#2  echo KEEP; sleep 30    → success=false，output="KEEP-THIS-LINE"，error 说明输出未丢弃
#3  printf '1%\r55%\r99%'  → output="99%"（中间态未堆积）
#7  sleep 60 background    → 秒回 "PID: 2234156" + 日志路径 + 存活检查命令
#9  echo 'pkill -f xyz'    → 输出附 "⚠️ 自伤风险…pgrep…"
#10 (sleep 3)& exit 0      → success=true "MAIN-OK" + 管道占用说明，耗时 404ms
```

### 真实对话回归（`~/.flare/install/bin/flare chat -q`）

```
问：用 terminal 执行 'exit 3'，告诉退出码
答：退出码是 3，命令失败了（非零退出码即失败）。        ← 工具失败后仍正常收尾（旧版此处断流）

问：用 background 模式启动 'sleep 120; echo LONG-DONE'
答：已用 background 模式启动，未阻塞对话。PID 2235093，日志路径 …     ← 模型正确使用新参数
```

---

## 五、回滚

```bash
# 源码回滚
cp -a ~/flare-backup-20261022-145612/src/. ~/hermes-projects/flare/src/

# 安装产物回滚
rsync -a --delete ~/flare-backup-20261022-145612/install-dist/ ~/.flare/install/dist/
# 或
rsync -a --delete ~/flare-install-dist-before-sync-20261022-150341/ ~/.flare/install/dist/
```

改动**尚未 git commit**（6 个文件：4 改 + 1 改测试 + 1 新增测试），仍在工作区。

---

## 六、遗留

- `src/core/tool-output.ts` 对 terminal 的"留尾部 2000 字符"策略**未调整**。理由：落盘留档已解决"数据丢失"，而 `/tmp` 里给尾部恰好能保住末尾的「已留档: <路径>」提示，AI 可自行 `read_file` 回读全文。再调大只会多烧 token。
- #11 的 200 次硬顶与 `FLARE_MAX_ITERATIONS` 只存在于工作副本，未提交。
- #6（heredoc）的根治靠用法约束，可考虑在 terminal 工具描述里加一句"多行文本用 write_file 落盘"。
