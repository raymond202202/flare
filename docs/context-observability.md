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
  IMAGE_TOKEN_COST,          // 85
  MESSAGE_STRUCTURE_TOKENS,  // 4
  TOOL_CALL_STRUCTURE_TOKENS,// 3
} from 'flare-agent'
```

宿主可自行实现"按 token 预算裁剪"：调 `estimateMessagesTokens(agent.getMessages())` 判断是否超预算，再决定精简/摘要策略。

## 未来方向（记录）

- 按 token 预算裁剪上下文（碰 agent.ts trimContext，需谨慎评估，暂缓）
- 工具确认机制完善：allow_session/always 记忆化 + 超时（备选下轮）
