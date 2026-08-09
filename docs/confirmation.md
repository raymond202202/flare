# 工具确认机制完善（ConfirmationGate）— v0.5.7

> flare 引擎的**有状态工具确认门**：在 `withConfirmation`（无状态，每次弹窗）基础上增加
> **allow_session 记忆化**（本会话不再重复确认）、**always 持久化**（跨会话记住，存记忆库 settings 表）、
> **确认超时**（confirmer 超时按安全默认 deny 处理）。
> 零 agent.ts 改动（`src/core/confirm.ts` + `src/tools/index.ts` 类型扩展），Pulse/StorySpire 等宿主注入自己的 confirmer 即可。

## 为什么需要

- v0.5.x 的 `withConfirmation` 是无状态纯函数：`allow_session` / `always` 只是透传给宿主 confirmer，
  每次执行都要弹窗——用户连续多次写入时反复确认，体验差；`always` 也无法跨会话记住；
- 弹窗可能永远等不到用户（宿主面板挂起/用户离开）——需要一个安全默认（超时按拒绝处理）；
- 目标：**一次确认，会话内放行；明确选择"总是允许"则持久化放行；超时安全兜底**。

## 快速上手

```ts
import { ConfirmationGate, memoryStoreKv, withConfirmation } from 'flare-agent'
import { MemoryStore } from 'flare-agent'

const store = new MemoryStore('~/.pulse/pulse-ai.db')

// 宿主注入弹窗确认器（如 Electron dialog / Qt 回调）
const gate = new ConfirmationGate({
  confirmer: async (toolName, args) => {
    const choice = await showConfirmDialog(`允许 ${toolName} 执行吗？`)
    return choice // 'allow_once' | 'allow_session' | 'always' | 'deny' | 'alternative'
  },
  sessionId: 's1',                       // allow_session 记忆按会话隔离
  store: memoryStoreKv(store),           // always 决策持久化到 settings 表（可选）
  timeoutMs: 30_000,                     // 确认超时（默认 30s）
  timeoutDecision: 'deny',               // 超时默认决策（默认 deny 安全；低风险可 'allow_once'）
})

// 包装工具（可批量：tools.map(t => gate.wrap(t))）
const safeWrite = gate.wrap(writeFileTool)
const res = await safeWrite.execute({ path: '/tmp/a.txt', content: 'hi' })
```

## 决策规则

| 决策 | 行为 | 记忆 |
|------|------|------|
| `allow_once` | 执行原工具 | 不记忆（每次都问） |
| `allow_session` | 执行原工具 | 本会话内（按 `sessionId`）该工具不再确认 |
| `always` | 执行原工具 | 持久化（`store` 注入时写入 `confirm.always.<toolName>`；无 store 退化为会话级） |
| `deny` | 拒绝，不执行 | 返回 `{ success:false, denied:true }`——AI 收到后调整策略 |
| `alternative` | 不执行 | 返回 `{ success:false, alternative:true }`——AI 与用户讨论替代方案 |
| 超时/confirmer 抛错 | 按 `timeoutDecision`（默认 deny） | 超时结果带 `timeout:true` 标记（抛错不标记） |

## 管理放行名单

```ts
gate.isAllowed('write_file')     // 是否被放行（always 持久化 或 会话级）
gate.listAllowed()               // 会话级放行名单
gate.allowSession('write_file')  // 显式放行（本会话）
gate.allowAlways('write_file')   // 显式永久放行（需 store）
gate.revoke('write_file')        // 撤销（会话级 + 持久化同步清除）
gate.resetSession()              // 清空会话级放行（不影响 always）
```

## 持久化（always）

- 通过 `ConfirmKeyValueStore` 接口注入（`get(key)` / `set(key, value)`，空串 = 删除）；
- `MemoryStore` 的 settings 表天然满足，官方适配器 `memoryStoreKv(store)` 一行接入；
- 键格式：`confirm.always.<toolName>`，值 `"1"`；
- **安全提示**：`always` 是用户明确选择才持久化；宿主应提供"管理已允许的工具"入口（`listAllowed`/`revoke`）；
  高危工具（terminal 等）建议不注入 store 或限制可 always 的工具名单。

## 向后兼容

- `withConfirmation(tool, confirmer)` 原签名不变（无状态行为不变：每次调 confirmer）；
- 新增第三参 `withConfirmation(tool, confirmer, { store, sessionId, timeoutMs, timeoutDecision })`——
  内部委托 `ConfirmationGate`，获得记忆化 + 超时；
- `ToolResult` 新增可选字段 `timeout?: boolean`（仅超时拒绝时出现），不影响现有消费方；
- 库导出：`ConfirmationGate` / `memoryStoreKv` + 类型 `ConfirmationGateOptions` / `ConfirmKeyValueStore` / `WithConfirmationOptions`。

## 测试

- `tests/confirm.test.ts`：19 项（原 5 项兼容 + 新增 14 项）——allow_session 只确认一次 / session 隔离 /
  always 持久化跨实例 / 无 store 退化 / 超时 deny / timeoutDecision 可配 / confirmer 抛错安全 /
  revoke / listAllowed / resetSession / 显式放行 / 元数据保留 / withConfirmation 三参 / MemoryStore 集成；
- 基线 180 + 新增 14 = **194/194 全绿**，tsc 0 错误。

## 与宿主协议的关系

- server 协议宿主工具走 `tool_execute` 事件（宿主自己确认），本机制是**宿主侧**增强——宿主把
  `tool_execute` 弹窗与 `ConfirmationGate` 结合即可获得记忆化；协议本身无需改动。
- **CLI 交互模式已内置确认门（v0.6.7）**：AI 调用写回类工具（`memory_save`）执行前弹终端确认——
  见下方章节。

## CLI 交互模式确认门（v0.6.7）

交互模式（`flare`）把 `ConfirmationGate` 接到终端：AI 想写持久记忆（`memory_save`）时暂停火焰动画，
弹确认行（恢复终端回显，readline 读一行），决策后反馈并继续 Agent 流。

```
🔧 调用工具: memory_save
⚠️ AI 想调用「memory_save」（{"content":"用户喜欢喝美式咖啡"}）
  [y] 允许一次    [s] 本次会话允许    [a] 总是允许    [n] 拒绝（默认）
  你的选择 [y/s/a/n]: y
⚠️ 工具「memory_save」已允许本次执行
```

- **决策**：`y`→allow_once / `s`→allow_session（本会话不再确认）/ `a`→always（持久化到全局库
  settings 表，跨会话记住）/ 其余（含 `n`、空、未知）→ deny（安全默认）；
- **默认名单** `CLI_CONFIRM_TOOLS = ['memory_save']`（与 server 端 `DEFAULT_CONFIRM_TOOLS` 一致）；
  交互模式始终显式传工具集（内置 + MCP）再包装，避免 Agent 回退内置工具绕过确认门；
- **/allow 命令**：`/allow` 查看已放行的确认工具（v0.6.10 起标注范围：`（本会话）` 会话级 / `（跨会话持久化）` always / `（会话+持久化）` 两者）；`/allow add <工具名> [session|always]` 显式放行（默认 session 本会话；always 跨会话持久化到 settings 表，无需等 AI 触发确认）；`/allow revoke <工具名>` 撤销放行（恢复每次确认）；
- **可复用纯函数**（库导出）：`parseConfirmAnswer(ans)`（输入→决策）/ `formatConfirmPrompt(toolName, args)`
  （确认 UI 文案）/ `terminalConfirmer({ toolName, args, ask, onPause?, onResume?, onFeedback? })`
  （可注入读行实现与暂停/恢复/反馈回调的终端确认流程）——其他宿主可复用同样的终端确认体验。

