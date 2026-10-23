# flare v0.6.158 修复说明（#33 / #34 / #35 / #36）

本轮问题全部来自**用 flare 自己跑长任务**（改造 fluxdl、推送 fluxdl 到 GitHub）时的实测，
记录在 `~/Projects/downloader-research/FLARE问题记录.md`【27】–【32】与本次新增的四条。

---

## #33 思考输出攒到最后才打印 → 长任务被中断时一个字都不剩

**实测**：无人值守跑 563s 的修复任务，日志文件里只有一行 `⚡ Flare 思考中...`；
进程被外部 `SIGKILL`（`status=9/KILL`）后，这 563s 里模型想过什么、跑了哪些工具，**全部丢失**。

**原因**：`runQuery` 把每轮输出先 `push` 进 `parts: string[]`，整个循环结束才 `console.log(parts.join(''))`。
只要没走到队尾，缓冲区就永远不落地。

**修复**（`src/cli/index.ts`）：
- 抽 `emitDraft()` / `emitAnswer()`，每产生一段就直接 `process.stdout.write` 落盘（重定向到文件也是实时 flush）。
- 心跳 `setInterval(15_000)`：距上次输出 ≥60s 才往 **stderr** 打一行
  `⏳ 已 Ns 无新输出（模型/工具仍在跑；Ctrl-C 中断，flare chat -c 可续跑）`，`unref()` 不吊住进程。
- stdout 只留正文，心跳走 stderr → 管道/重定向拿结果时不被污染。

---

## #34 `EADDRINUSE` 被模型当成"代码写错了"

**实测**（fluxdl e2e）：上一次任务残留的 python 还占着 8730，新服务起不来，
flare 看到 `OSError: [Errno 98] Address already in use` 后**去改了日志缓冲逻辑**——
方向完全错，因为端口被占是环境脏，跟被测代码无关。

**修复**（`src/tools/index.ts` `describePortConflict()`）：命令失败时若命中
`/EADDRINUSE|Address already in use/i`，直接追加一段归因：

```
[端口占用] 这是端口被占用，不是代码逻辑错误：多半是上一次任务遗留的进程还活着（记录 #27/#31）。
先确认再清理：ss -ltnp 'sport = :8730'
当前占用该端口的监听（ss 实时读取）:
LISTEN 0  1  127.0.0.1:8730  0.0.0.0:*  users:(("python3",pid=1561394,fd=3))
清理用具体 pid（kill <pid>），不要用 pkill -f 拍模式串（会自伤，见 #28）。
```

细节：python 的 `Errno 98` 消息里**不含端口号**，所以端口从「错误文本 + 命令行」两头猜，
**每个候选都用 `ss` 验证过确实有人在 LISTEN 才敢报**（验证不到就只给命令，不编数字）。
探测严格只读、3s 超时、失败静默。

---

## #35 无人值守模式下「不可逆操作」只警告一句就照做

**实测**：让 `flare chat -q` 自己 `git push`，工具层弹了「不可逆操作」告警——
但 `-q` 模式没有交互确认器，没人看得见，命令照样执行、照样推上去了。
告警等于装饰。

**修复**（`src/tools/index.ts`）：无人值守 + 没有确认器时，confirm 档（`rm -rf`、`git push`、
`pkill` 等）**默认拒绝**，返回 `denied: true`，且不执行：

```
命令未执行：规则 xxx 属于不可逆操作，当前是无人值守模式（没有交互确认器），按安全默认拒绝。
确认要执行时，用以下任一方式显式放行：
  · flare chat --allow-risky ...
  · FLARE_ALLOW_RISKY=1 flare chat ...
  · 交互模式直接运行 flare chat，会逐条询问，可选「本次/本会话/永久」
```

显式放行后仍执行，但输出留痕：`⚠️ 不可逆操作已在「无人值守 + 显式放行」下执行（规则 …）`。
同时补上 `--allow-risky` 参数（映射到 `FLARE_ALLOW_RISKY=1`）——文案里承诺的开关必须真的存在。

---

## #36 `--continue` 续跑不告诉你「上次到哪儿了」

原先只打一句「↩️ 续跑最近会话」，断点内容、工作区有没有未提交改动、HEAD 是什么，全要自己翻。
实测因此把已完成的事又问了一遍，等于抵消续跑的意义。

**修复**（`src/cli/index.ts` `printResumeBriefing()`）：续跑前打印

```
  ┌─ 断点摘要
  │ 你: 把 fluxdl 的 SIGTERM 死锁修掉 顺带补测试
  │ flare: 已完成 _request_shutdown 改造
  │ 工作区: 2 个未提交改动（M src/tools/index.ts / ?? tests/…）
  │ HEAD: 0765b9a feat: v0.6.157 …
  └─
```

非 git 目录、无历史消息时整块静默跳过，不阻断续跑。

---

## 测试

新增 `tests/flare-issues-33-36.test.ts`（6 例）：

| 用例 | 断言要点 |
|---|---|
| #34 真实端口占用 | 起一个进程真占端口，再让另一进程 bind → 输出含「端口占用」+ `sport = :<port>` + `kill <pid>` |
| #34 不误伤 | 普通 `ls` 失败不含「端口占用」 |
| #35 默认拒绝 | `rm -rf` 被拒、**目标目录真的还在**、错误里给出三种放行方式 |
| #35 显式放行 | `FLARE_ALLOW_RISKY=1` → 执行成功、输出含「显式放行」、目录真的被删 |
| #35 不误伤日常 | `echo` 正常执行 |
| #36 断点摘要 | 含消息摘要 / 工作区状态 / HEAD |

`tests/flare-issues-13.test.ts` 中 `pkill` 自伤预警用例同步加 `FLARE_ALLOW_RISKY=1`
（pkill 属 confirm 档，策略改了之后不放行就测不到执行期预警）。

全量 `npx vitest run` + `tsc --noEmit` 结果见提交说明。
