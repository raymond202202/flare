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
  summarizeTrimmedMessages,  // v0.6.19：裁剪时把丢弃历史压缩成摘要消息
  buildSummaryText,          // v0.6.19：摘要文本组装（纯函数）
  SUMMARY_MARKER,            // v0.6.19：摘要消息识别标记 '[历史摘要]'
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

### 一键执行（v0.6.35 apply_trim / v0.6.46 CLI /trim / v0.6.103 单次命令）

- **server 协议**：`apply_trim {budgetTokens, reserveForOutput?}` 或 `{keepIndexes}` → 服务器按
  suggestTrim 计算并执行 `agent.applyTrim`（内存裁剪 + store 同步删除被裁消息，重建后依然生效）
- **CLI 交互模式**：`/trim [预算tokens]` 一键智能裁剪（缺省用当前配置 maxContextTokens）；
  `/context` 超预算时提示可裁剪条数与 `/trim` 指引——宿主/终端用户无需手工算索引
- **CLI 单次命令 `flare trim <会话ID>`（v0.6.103，与 server apply_trim 对称）**：宿主/脚本场景的
  非交互裁剪入口——`--budget <tokens>` 按预算智能裁剪（缺省用会话 maxContextTokens 或 16000），
  `--keep <索引列表>` 精确裁剪（v0.6.105：逗号分隔整数或 JSON 数组，与 context-status --json 的
  suggestion.keepIndexes **同一索引空间**，可直接程序化消费）；空 id/会话不存在或无消息/非法
  budget/非法或越界 keep 各 exit 1，未超预算或全索引保留幂等 exit 0
- **CLI 单次命令 `flare context-status [<会话ID>] --json`（v0.6.104，与 server context_status 同构）**：
  输出 `{ sessionId, messageCount, estimatedTokens, suggestion? }`——`--budget N` 时附
  `suggestion.keepIndexes`（建议保留的消息索引，含开头 system 前缀，与 trim --keep 同一索引空间）；
  与 trim 配对形成「查看建议 → 精确执行」程序化闭环

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

## 上下文压缩摘要（v0.6.19，summarizeTrimmedMessages）

`trimContextMessages` 把丢弃的历史**直接删除**（旧话题对 AI 完全不可见）；`summarizeTrimmedMessages`
在同样裁剪策略的基础上，把被丢弃的历史**压缩成一条摘要消息**而非直接丢弃——AI 保留话题连续性
（长会话裁剪后仍知道之前聊过什么、调过哪些工具）。

```ts
import { summarizeTrimmedMessages } from 'flare-agent'

// 与 trimContextMessages 同参数；发生裁剪时返回 system 保底 + 摘要 + 保留消息
const result = summarizeTrimmedMessages(messages, { maxMessages: 30, maxTokens: 8000 })
```

| 特性 | 说明 |
|------|------|
| 纯启发式 | 摘要由**统计**生成（条数 / 角色分布 / 估算 tokens / 涉及工具去重列表 / 最后话题片段），**不调用 LLM**——零额外成本、可离线确定性测试 |
| 零拷贝契约 | 未发生裁剪 → 返回**原数组引用**（与 trimContextMessages 一致，调用方无感知） |
| 摘要位置 | 裁剪后摘要紧随 system 之后（`role` 默认 `'system'`，可配 `'user'`）——AI 明确知道这是压缩的历史 |
| 摘要链防堆积 | 摘要以 `SUMMARY_MARKER`（`[历史摘要]`）开头；下次裁剪时旧摘要无论被保留还是被裁掉，都被识别并合并进新摘要（新摘要含"更早历史"行，多次裁剪不越滚越大） |
| 参数 | `role` / `maxChars`（默认 400，超长截断）/ `maxTools`（默认 8）/ `includeTail`（默认 true）/ `tailChars`（默认 80） |

**AgentConfig 接入**：`contextSummarize: true`（默认 false，不配置行为与旧版完全一致）——

```ts
const agent = new Agent({
  maxContextMessages: 30,   // 裁剪条数上限
  contextSummarize: true,   // 开启后裁剪时生成摘要（纯启发式，不调 LLM）
})
```

**server 协议透传**：chat 请求带 `contextSummarize`（布尔，非法值回 error 不触发生成）；
`flare server --context-summarize` 设置 server 级默认（chat 未指定时应用，请求优先）；
`get_config` 响应回显 `defaultContextSummarize`。详见 docs/host-protocol.md。

## 未来方向（记录）

- 摘要内容升级为 LLM 生成（当前纯启发式统计；如需语义级压缩摘要可评估在 run 循环外异步生成）
- 工具确认机制完善：allow_session/always 记忆化 + 超时（已完成 v0.5.7/v0.6.1/v0.6.7）
