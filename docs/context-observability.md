# 上下文可观测性（Context Observability）— v0.5.6

> flare 引擎的上下文占用度量：**token 估算纯函数** + **宿主协议 `context_status`** + **CLI `/context`**。
> 零依赖、零 agent.ts 改动（`Agent.getMessages()` 是 public，无侵入读取）。

## 为什么需要

- Agent 运行时会累积上下文（system 提示 + 对话 + 工具调用链），`trimContext()` 保留最近 30 条；
- 但宿主（Pulse/StorySpire AI 面板）和 CLI 用户**看不到**当前会话上下文占了多少、接近多满；
- 精确 token 计数需要各模型分词器，太重；启发式估算足够用于：面板显示、成本预估、接近上限提醒。

## token 估算（src/core/context.ts，纯函数）

```ts
import { estimateTokens, estimateMessagesTokens } from 'flare-agent'

estimateTokens('你好世界')            // 4（CJK 1 字符 ≈ 1 token）
estimateTokens('hello world')        // 3（非 CJK 4 字符 ≈ 1 token）
estimateMessagesTokens(messages)     // 含结构开销
```

估算规则（贴近 OpenAI cl100k 的常用近似，偏保守）：

| 项 | 开销 |
|----|------|
| CJK 字符（中/日/韩） | 1 字符 ≈ 1 token |
| 非 CJK（英文/数字/符号） | 4 字符 ≈ 1 token（向上取整） |
| 每条消息结构（role/name/终止符） | +4 |
| 每条 tool_calls | +3 + 函数名/参数文本 |
| 图片 content | ≈85 token/张（OpenAI 视觉 API 近似） |

> ⚠️ 估算非精确——不同模型分词器有差异；用于**相对比较/趋势/粗预算**，不要用作计费依据。

## 宿主协议 context_status（只读，不触发生成）

```json
{"type":"context_status","sessionId":"s1"}
```

响应：

```json
{"type":"context_status","sessionId":"s1","messageCount":31,"estimatedTokens":2143}
```

- `messageCount`：当前会话上下文消息数（含 system 提示；空会话至少 1）
- `estimatedTokens`：估算 token 数（随对话增长而增大）
- 用途：面板显示"上下文占用/成本预估"、接近上限时提示用户精简
- 文档：`docs/host-protocol.md` §10

## CLI /context

```
🔥 flare> /context
📊 当前会话上下文:
  消息数:      31
  估算 tokens: 2,143
```

- 显示当前会话上下文占用（消息数 + 估算 tokens）
- 交互模式内置；宿主集成 CLI 时可注入自己的 `contextInfo` hook

## 库导出（@flare/core）

```ts
import {
  estimateTokens,
  estimateMessagesTokens,
  suggestTrim,               // v0.5.9：按预算建议保留哪些消息
  trimContextMessages,       // v0.6.17：Agent 内部安全自动裁剪（保证配对）
  IMAGE_TOKEN_COST,          // 85
  MESSAGE_STRUCTURE_TOKENS,  // 4
  TOOL_CALL_STRUCTURE_TOKENS,// 3
} from 'flare-agent'
```

## 按预算裁剪上下文（v0.5.9，suggestTrim）

`suggestTrim(messages, budgetTokens, opts?)` 是**纯函数**：给定消息列表与 token 预算，
返回建议保留的消息（宿主自行裁剪后再发给引擎，不修改 Agent 内部状态，零 agent.ts 改动）。

```ts
import { suggestTrim } from 'flare-agent'

const messages = agent.getMessages()          // 当前会话上下文（public，只读）
const r = suggestTrim(messages, 8000, { reserveForOutput: 1000 })
// 有效预算 7000：system 保底 + 最近优先
// 宿主按 r.keep 自行管理：本地缓存只保留这些消息、对新一轮输入前置精简后的摘要、
// 或调用引擎支持的重置方式（如 delete_session + 重新注入 keep 作为上下文）——接入方式由宿主决定
console.log(r.droppedCount, r.estimatedKeptTokens)
```

策略：

| 规则 | 说明 |
|------|------|
| system 保底 | 首条 `role=system` 始终保留（AI 需要系统提示）；`keepSystem:false` 可关 |
| 最近优先 | 从最新消息向前收集，直到估算 tokens 接近预算（最早的消息先被丢弃） |
| 极小预算保底 | 预算小到一条都放不下时，仍保底保留**最新一条**（AI 必须看到用户最新输入） |
| reserveForOutput | 为模型输出预留 tokens（保留部分最多 `budget - reserve`） |

返回值：

```ts
{
  keep: Message[],            // 建议保留的消息（原顺序；system 在前）
  droppedCount: number,       // 丢弃条数
  estimatedKeptTokens: number,// 保留部分估算 tokens
  estimatedDroppedTokens: number,
}
```

## 引擎内部自动裁剪（v0.6.17，trimContextMessages）

`suggestTrim` 是给**宿主**的建议（不保证 tool_calls ↔ tool 配对，宿主按索引裁剪后自行负责语义）；
引擎内部 `Agent` 的自动裁剪用 `trimContextMessages`——**保证不拆散配对**（LLM 收到拆散的 tool
配对会 400）。

```ts
import { trimContextMessages } from 'flare-agent'

// 纯函数：返回裁剪后的消息（未超限返回原数组引用，零拷贝）
const trimmed = trimContextMessages(messages, { maxMessages: 30, maxTokens: 8000 })
```

策略（Agent 每次迭代前 `trimContext()` 自动调用）：

| 规则 | 说明 |
|------|------|
| system 保底 | 首条 `role=system` 始终保留，且 token **计入预算**（保留部分严格不超） |
| 最近优先 | 从最新消息向前收集；`maxMessages`（默认 30）与 `maxTokens` 任一先到即停 |
| 配对保护 | `tool` 响应连带它的 `assistant(tool_calls)` 无条件保留（配对链不拆散）；`assistant(tool_calls)` 有文本内容 = 一轮完整结束可停 |
| 极小预算保底 | 预算小到一条都放不下时，仍保底保留**最新一条**（AI 必须看到用户最新输入） |
| maxMessages:0 | 关闭条数裁剪（仅按 token 预算） |

**AgentConfig 接入**（宿主免手动 set_context，Agent 自动管理）：

```ts
const agent = new Agent({
  maxContextMessages: 30,   // 可选，默认 30（不配置行为与旧版完全一致）
  maxContextTokens: 8000,   // 可选，token 预算；不配置则只按条数裁剪
})
```

**server 协议透传**：chat 请求带 `maxContextMessages` / `maxContextTokens`（非法值回 error 不触发
生成；变化自动重建 Agent 立即生效）；`flare server --max-context-messages <n> --max-context-tokens <n>`
设置 server 级默认（chat 未指定时应用，请求优先）。详见 docs/host-protocol.md。

## 未来方向（记录）

- 上下文压缩摘要（裁剪掉的历史压缩成摘要而非直接丢弃，需评估）
- 工具确认机制完善：allow_session/always 记忆化 + 超时（已完成 v0.5.7/v0.6.1/v0.6.7）
