# v0.6.156 — 迭代上限后「输入框假死 / Ctrl+C 无效」修复

## 用户症状

一轮跑到迭代上限自动停止后，CLI 打印了续跑提示，但**输入框再也收不到键盘，Ctrl+C 也退不出去，只能关终端**。

## 根因（Node readline 语义陷阱）

`app` 里确认门用的是：

```ts
const rl = createInterface({ input: process.stdin, output: process.stdout })
rl.question(prompt, (a) => { rl.close(); ... })
```

`readline.Interface.close()` 内部会对 input 调用 **`pause()`**，把共享的 `process.stdin` 留在 **paused** 状态。
之后回到主循环，`LineInput.readLine()` 只做 `setRawMode(true)` + `stdin.on('data', ...)` ——
**给一个 paused 的流加 data 监听并不会让它重新流动**，于是：

- 键入的字符永远不到达应用 → 输入框完全不响应（终端本地回显仍正常，更容易误判）
- raw mode 关闭了 `ISIG`，Ctrl+C 不再产生 SIGINT，而只是一个 `\x03` 字节，同一时间没有任何人监听它 → **退不出去**

## 修复

1. `src/cli/line-input.ts` 新增 `ensureStdinFlowing(stdin)`：`isPaused()` 为真才 `resume()`，幂等、异常不外抛。
2. 所有「拿到 stdin 监听权之前」的入口统一调用它：
   - `LineInput.readLine()`（首次与续读）
   - `LineInput` pause→resume 恢复路径
   - `index.ts` 的两处 `rl.close()` 之后（确认门 + 不可逆命令风险确认）
   - 风险确认 `finally` 兜底（拒绝 / 抛错 / 超时都能恢复）
3. 顺手修同轮暴露的两个真实 bug：
   - `write_file` 父目录不存在时 `ENOENT`（用户本轮就撞到 `scripts/check_stdlib_only.py` 写不进去）→ 自动 `mkdir -p`，并做临时文件 + rename 原子写入、失败清理
   - 迭代上限文案口径不清（「上限(50)」与「61 次工具调用」看起来像计数 bug）→ 明确写「50 次模型迭代」并加一行「一次迭代可批量执行最多 5 个工具调用，所以工具调用数会多于迭代数」

## 验证

真实 pty（`pty.fork`）端到端，同一脚本跑新旧两份产物：

| 产物 | 结果 |
| --- | --- |
| 旧版已安装 `~/.flare/install/dist/cli/line-input.js` (0.6.155) | **FAIL**：`ANSWERED=y pausedAfterClose=true` 之后输入 `hello` 无任何反应（复现 bug） |
| 本仓库 `dist/cli/line-input.js` → 已装进 `~/.flare/install/dist` (0.6.156) | **PASS**，连跑 5 次全通过：`LINE="hello"`，第二次读行 `Ctrl+C` → `LINE2="\u0003"` 正常退出 |

真实生产二进制 `flare chat` 交互端到端（`e2e_flare_chat.py`）：起会话 → 一轮里真的调用 `terminal` 工具（`echo flare-e2e-marker` 输出被渲染）→ 回复 `42` → 回车后输入框仍能收到键入（`abc` 有回显）→ `Ctrl+C` 进程退出。四个检查点全过。

> 补丁还修掉一个残余窗口：`readLine()` 原先先 `drawPrompt()` 再 `setRawMode(true)` + 挂 `data` 监听，prompt 出现到监听挂上之间键入会丢、Ctrl+C 会被内核回显成 `^C`。现在顺序改为 **先 raw mode + 挂监听，最后画 prompt**。


单元/回归测试：`tests/cli-stdin-flowing.test.ts`（4 例 stdin 流动 + 1 例父目录自动创建），全量 `vitest run` 87 文件 / 1335 用例通过。

## 相关

- issue 记录：`FLARE 问题记录 #18`
- `-m` 单轮预算默认 50、硬上限 500，可用 `FLARE_MAX_ITERATIONS` 覆盖；长任务推荐 `flare chat --continue -m 200`
