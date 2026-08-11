# Flare 省 Token 架构设计（v1.0）

> 状态：已定稿（2026-08-11）· **P0-1/P0-2 已落地（v0.6.29）**
> 来源：fedora-hermes + macmini-hermes 双机方案整合（《省 Token 方案》两版对比后取优）
> 性质：**架构决策文档**。按此文档实施时，先看 flare-progress.md 的「下一步候选」是否已引用本文件——若已引用，迭代 agent 每轮读 progress.md 后应优先处理本文件方向；若未引用，本文档仅为存档。

## 核心认知

**压缩是「减重」，缓存是「打折」**——DeepSeek 缓存命中 input 约 1/10 价（0.02 元/M vs 1 元/M，50 倍差价）。
优先级：**缓存 > 往返 > 压缩**。

## 一、省 token 五大杠杆（不止压缩）

| 杠杆 | 原理 | 量级 | flare 现状 |
|---|---|---|---|
| ① Prompt 缓存命中 | 前缀不变 → 服务端缓存，命中部分近乎免费 | ⭐⭐⭐⭐⭐ | ❌ 最大缺口（见二） |
| ② 工具定义瘦身 | 每个工具的 description 每次请求全量发送 | ⭐⭐⭐⭐ | ⚠️ 无按需加载 |
| ③ 往返次数 | 少 1 轮请求 = 省 1 次全量 input | ⭐⭐⭐⭐ | ✅ 每轮最多 5 工具 |
| ④ 会话生命周期 | 挂起会话 = 随时继续烧 | ⭐⭐⭐⭐ | ❌ server 无归档 |
| ⑤ 输出截断 | 工具大输出不进上下文 | ⭐⭐⭐ | ✅ 2000 字符硬截 |

## 二、P0：Prompt Caching 一等公民（必须先做）

### 现状问题（agent.ts L127-140）

system prompt 拼成一条 = basePrompt + 身份 + flareIntro + 「关于这个用户」+ 记忆（最多 5 条）。
**记忆一变 → 整条 system 前缀变 → DeepSeek 缓存全失效**，每次请求按全价算。

### 定死的规则

```
稳定前缀（缓存区）：system prompt + 工具定义 —— 永远不变，固定顺序
动态后缀（非缓存区）：记忆 / 当前状态 / 新对话 —— 追加在后面
```

- 记忆和身份拆成**独立 system 消息**放后面，绝不拼进前缀
- 请求构造保证前缀稳定：禁止运行时重排 system 顺序 / 格式
- 支持 `cache_control: {type:"ephemeral"}` 标注可缓存段（Anthropic 协议；DeepSeek 系靠前缀匹配自动生效）
- 重试 / 循环调用间隔 < 缓存 TTL（DeepSeek 5min），别中断连续执行

## 三、P1：分层上下文 + 工具输出治理 + 会话归档

### 分层上下文（不只裁剪，要分优先级）

```
Layer 0: system（恒定，保底）        ← 始终缓存命中
Layer 1: 滚动摘要（每 N 轮更新一次）   ← 异步生成，不阻塞主循环
Layer 2: 最近 N 轮完整（配对保护）     ← 可裁剪
Layer 3: 当前轮（最新输入）           ← 必留
```

### 工具输出治理

- 输出截断：max_bytes + max_lines，超出部分自动摘要尾部
- 结构化数据（JSON 大响应）→ 紧凑格式转换
- 工具结果旁路存储：大结果写文件，上下文只留路径 + 摘要

### 会话生命周期 API

- 归档 / 翻篇：进度落盘 → 新会话（与使用层短会话模式打通）

### 模型路由

- 简单任务 → 本地 Ollama，复杂任务 → DeepSeek（flare 已支持多 provider，加按任务复杂度路由钩子）

## 四、P2：动态预算 + 成本可观测

- 每轮调用前估算，超预算先裁剪（estimateMessagesTokens 已有，做成自动）
- 暴露 usage 回传：input/output/cache_read/cache_write + 成本估算 API（llm.ts 已记录 usage，接 estimated_cost_usd）
- 宿主面板显示「本轮缓存命中率」，引导连续执行

## 五、已具备的能力（v0.6.19+，不用重做）

| 能力 | 实现 |
|---|---|
| token 估算 | context.ts estimateTokens / estimateMessagesTokens（CJK 感知，离线纯函数） |
| 配对安全裁剪 | trimContextMessages（不拆散 tool_calls ↔ tool 响应，maxMessages/maxTokens） |
| 启发式摘要压缩 | summarizeTrimmedMessages（v0.6.19，纯统计零 LLM 成本，摘要链防堆积） |
| suggestTrim | 宿主面板裁剪建议 API |
| 工具输出截断 | agent.ts 结果 2000 / 错误 1000 字符 |
| usage 记录 | llm.ts prompt/completion tokens，流式 include_usage |
| 多工具往返合并 | 每轮最多 5 个 tool_calls |

## 六、实施顺序建议

1. ✅ **P0-1 前缀稳定**（v0.6.29 已落地：agent.ts system 消息拆分——稳定 system 独立、身份/记忆独立 system 放后；
   稳定前缀 + 工具定义永远不变；setContext 状态快照追加消息末尾动态区；trim/suggestTrim 开头 system 块全保底）
2. ✅ **P0-2 usage 回传增强**（v0.6.29 已落地：llm.ts usage 补 cache_read/cache_write + estimated_cost_usd；
   usage_log 落库 + 老库迁移；get_usage/session_usage 透传；CLI /usage 显示缓存命中率）
3. **P1 分层上下文**（在现有 trim/summarize 基础上补 Layer 1 异步滚动摘要）
4. **P1 工具输出治理**（按工具类型定制截断：读文件留头尾、终端留尾部+退出码）
5. **P1 会话归档 API**（server 协议 endSession）
6. **P2 模型路由钩子**

## 验收标准

- ✅ P0-1 落地后：连续两轮调用（间隔 <5min），第二轮 input 缓存命中（usage.cache_read_tokens > 0）
  ——**前缀稳定已保证命中基础**（稳定前缀 + 工具定义逐字节不变）；实际命中率还取决于 DeepSeek 服务端缓存
  （外部因素，宿主经 /usage 缓存行可观测）
- ✅ **验收自动化（v0.6.45）**：`flare cache-check` 命令一键验收——构造稳定长前缀连续两轮调用，
  报告第二轮 cache_read_tokens 与估算节省（`--model` 可指定模型；本地诊断，不输出密钥）
- ⏳ 单次迭代 fire 的 prompt tokens 相比 v0.6.27 基线下降 ≥ 30%（P0-1 后测量；工具定义瘦身 P1 候选）
- ✅ 全部改动 tsc 0 错 + 测试全绿（v0.6.29：630/630）
