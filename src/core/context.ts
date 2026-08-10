/**
 * 上下文可观测性（v0.5.6）
 *
 * token 估算纯函数（无网络 / 无依赖 / 可离线确定性单测）。
 *
 * 估算不是精确计数（精确需要分词器）；目标是给宿主 / CLI 一个可比较的
 * 上下文占用度量（面板显示上下文用了多少、成本预估、未来按 token 预算裁剪的地基）。
 *
 * 启发式（贴近 OpenAI cl100k 的常用近似，偏保守）：
 *   - CJK 字符（中文/日文/韩文）：1 字符 ≈ 1 token
 *   - 非 CJK（英文/数字/符号）：4 字符 ≈ 1 token
 *   - 消息结构开销：每条消息 +4（role/name/终止符）；tool_calls 每条 +3；
 *     图片内容 ≈ 85 token/张（OpenAI 视觉 API 近似）
 */

import type { Message } from './llm.js'

/** CJK 统一表意文字 + 假名 + 谚文 */
const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g

/** 图片内容的近似 token 开销（OpenAI 视觉 API 每张图约 85 tokens） */
export const IMAGE_TOKEN_COST = 85
/** 每条消息的结构开销（role/name/终止符等） */
export const MESSAGE_STRUCTURE_TOKENS = 4
/** 每条 tool_calls 的结构开销 */
export const TOOL_CALL_STRUCTURE_TOKENS = 3

/**
 * 估算一段文本的 token 数：
 *   - CJK 字符按 1 字符 ≈ 1 token（中文实测约 0.6~1 token/字，取 1 偏保守）
 *   - 其余字符按 4 字符 ≈ 1 token（英文 cl100k 约 0.75 token/词）
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjkCount = (text.match(CJK_RE) || []).length
  const nonCjkCount = text.length - cjkCount
  return Math.ceil(cjkCount + nonCjkCount / 4)
}

/**
 * 估算一组消息的 token 数（含结构开销）：
 *   - 每条消息 +4（role/name/终止符）
 *   - 文本 content 按 estimateTokens；图片 content 按 IMAGE_TOKEN_COST/张
 *   - tool_calls 每条 +3 + 函数名/参数文本
 *   - tool_call_id / name 字段计入文本
 */
export function estimateMessagesTokens(messages: Message[]): number {
  if (!messages || messages.length === 0) return 0
  let total = 0
  for (const m of messages) {
    total += MESSAGE_STRUCTURE_TOKENS
    const content = m.content
    if (typeof content === 'string') {
      total += estimateTokens(content)
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'text') {
          total += estimateTokens(part.text)
        } else if (part.type === 'image_url') {
          total += IMAGE_TOKEN_COST
        }
      }
    }
    if (m.name) total += estimateTokens(m.name)
    if (m.tool_call_id) total += estimateTokens(m.tool_call_id)
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += TOOL_CALL_STRUCTURE_TOKENS
        total += estimateTokens(tc.function.name)
        total += estimateTokens(tc.function.arguments)
      }
    }
  }
  return total
}

/**
 * 上下文裁剪建议（v0.5.9，纯函数）
 *
 * 给定消息列表与 token 预算，建议保留哪些消息——供宿主（Pulse/StorySpire 面板）
 * 自行按预算管理上下文，不修改 Agent 内部状态（零 agent.ts 改动）。
 *
 * 策略（贴近 Hermes 的保留式裁剪）：
 *   - system 消息保底（首条 role=system 始终保留，AI 需要系统提示）
 *   - 其余消息按"最近优先"从尾部向前收集，直到估算 tokens 接近预算
 *   - 预算极小时仍保底保留最近一条（AI 必须能看到用户最新输入才能回复）
 *   - reserveForOutput：为模型输出预留的 token 预算（keep 部分最多 budget - reserve）
 */
export interface TrimSuggestion {
  /** 建议保留的消息（保持原顺序；system 在前） */
  keep: Message[]
  /** 被丢弃的消息数 */
  droppedCount: number
  /** 保留部分的估算 tokens */
  estimatedKeptTokens: number
  /** 丢弃部分的估算 tokens（≈ 总量 - 保留量，不为负） */
  estimatedDroppedTokens: number
}

export interface SuggestTrimOptions {
  /** 为模型输出预留的 token 数（默认 0）：保留部分最多 budgetTokens - reserve */
  reserveForOutput?: number
  /** 是否保底 system 消息（默认 true；首条 role=system 始终保留） */
  keepSystem?: boolean
}

/**
 * 上下文自动裁剪（v0.6.17，纯函数）
 *
 * 与 suggestTrim 的区别：**保证不拆散 tool_calls ↔ tool 响应配对**——
 * 这是 Agent 内部实际裁剪用的策略（suggestTrim 是给宿主的\"最近优先\"建议，
 * 不保证配对，宿主按索引裁剪后自行负责语义；trimContextMessages 用于 Agent
 * 内部安全裁剪，LLM 收到拆散的 tool 配对会 400）。
 *
 * 策略：
 *   - system 消息保底（首条 role=system 始终保留）
 *   - 其余从尾部向前收集，直到条数达到 maxMessages（默认 30）**或**
 *     token 预算 maxTokens 耗尽（两者任一先到即停；均未配置不裁剪）
 *   - 配对保护：tool 响应向后（实际向前收集时）连带它的 assistant(tool_calls)
 *     一起保留；assistant 有文本内容 = 一轮完整结束可停
 *   - 极小预算仍保底保留最近一条（AI 必须看到用户最新输入）
 *   - 未超限返回**原数组引用**（调用方无感知，零拷贝）
 */
export interface TrimContextOptions {
  /** 最大保留消息条数（默认 30）；与 maxTokens 任一先到即停 */
  maxMessages?: number
  /** token 预算（可选）：保留部分估算 tokens 不超过该值；不配置则只按条数裁剪 */
  maxTokens?: number
}

export function trimContextMessages(messages: Message[], options: TrimContextOptions = {}): Message[] {
  if (!messages || messages.length === 0) return []
  const maxMessages = options.maxMessages ?? 30
  const maxTokens = options.maxTokens
  // 无需裁剪：条数未超（或条数裁剪关闭）且 token 未超（或 token 裁剪关闭）→ 返回原引用（零拷贝）
  const messagesUnderLimit = maxMessages <= 0 || messages.length <= maxMessages
  const tokensUnderLimit = maxTokens === undefined || estimateMessagesTokens(messages) <= maxTokens
  if (messagesUnderLimit && tokensUnderLimit) {
    return messages
  }

  const systemMsg = messages.find(m => m.role === 'system')
  // 预计算每条消息 token（避免循环内重复估算）
  const tokens = messages.map(m => estimateMessagesTokens([m]))
  const kept: Message[] = []
  let pendingToolCallIds = new Set<string>() // 需要找 tool_calls 的 ID
  // system 保底占用预算（最后单独加回，但 token 计入预算，保证保留部分不超）
  let usedTokens = systemMsg ? estimateMessagesTokens([systemMsg]) : 0

  // 停止条件（普通消息加入前检查，放不下就不放——保留部分不超预算）：
  //   条数达到上限（maxMessages>0 时）或 加入本条后 token 预算耗尽
  //   极小预算时 kept 为空 → 不检查，无条件保底保留最新一条（AI 必须看到最新输入）
  const overLimit = (nextTokens: number) =>
    (maxMessages > 0 && kept.length >= maxMessages) ||
    (maxTokens !== undefined && usedTokens + nextTokens > maxTokens)

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const t = tokens[i]

    // tool 响应：无条件保留（配对链，不可拆散）并记录待配对
    if (msg.role === 'tool' && msg.tool_call_id) {
      pendingToolCallIds.add(msg.tool_call_id)
      kept.unshift(msg)
      usedTokens += t
      continue
    }

    // assistant(tool_calls)：无条件保留（配对链）；有文本内容 = 一轮完整结束
    if (msg.role === 'assistant' && msg.tool_calls) {
      kept.unshift(msg)
      usedTokens += t
      for (const tc of msg.tool_calls) {
        pendingToolCallIds.delete(tc.id)
      }
      if (msg.content) {
        pendingToolCallIds.clear()
      }
      // 配对完整且超限 → 停（后续不再收集）
      if (pendingToolCallIds.size === 0 && overLimit(0)) {
        break
      }
      continue
    }

    // user / assistant(无 tool_calls) / system：配对完整且放不下 → 停；否则保留
    // 极小预算保底：kept 为空时无条件保留第一条（最新输入）
    if (kept.length > 0 && pendingToolCallIds.size === 0 && overLimit(t)) {
      break
    }
    kept.unshift(msg)
    usedTokens += t
  }

  // system 保底（若被收集进 kept 则去重，避免重复）；其余保持原顺序
  return systemMsg
    ? [systemMsg, ...kept.filter(m => m !== systemMsg)]
    : kept
}

export function suggestTrim(messages: Message[], budgetTokens: number, options: SuggestTrimOptions = {}): TrimSuggestion {
  if (!messages || messages.length === 0) {
    return { keep: [], droppedCount: 0, estimatedKeptTokens: 0, estimatedDroppedTokens: 0 }
  }
  const reserve = Math.max(0, options.reserveForOutput ?? 0)
  const budget = Math.max(0, budgetTokens - reserve)

  // 分离 system（保底）与其余消息
  const system: Message[] = []
  let rest: Message[]
  if (options.keepSystem !== false && messages[0]?.role === 'system') {
    system.push(messages[0])
    rest = messages.slice(1)
  } else {
    rest = messages
  }
  const systemTokens = estimateMessagesTokens(system)

  // 从最新消息向前收集（保持原顺序）
  const keepRest: Message[] = []
  let used = systemTokens
  for (let i = rest.length - 1; i >= 0; i--) {
    const m = rest[i]
    const t = estimateMessagesTokens([m])
    if (used + t > budget) {
      // 放不下：若一条都还没保留，保底保留最近一条（AI 必须看到用户最新输入）
      if (keepRest.length === 0) {
        keepRest.unshift(m)
        used += t
      }
      break
    }
    keepRest.unshift(m)
    used += t
  }

  const keep = [...system, ...keepRest]
  const keptTokens = estimateMessagesTokens(keep)
  const totalTokens = estimateMessagesTokens(messages)
  return {
    keep,
    droppedCount: messages.length - keep.length,
    estimatedKeptTokens: keptTokens,
    estimatedDroppedTokens: Math.max(0, totalTokens - keptTokens),
  }
}
