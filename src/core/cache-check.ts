/**
 * prompt caching 验收工具（v0.6.45）：连续两轮调用验证「第二轮 cache_read_tokens > 0」。
 *
 * 背景（flare-progress.md P0 验收标准）：前缀稳定已保证命中基础，实际命中取决于
 * DeepSeek 服务端缓存（外部因素）——验收标准为「连续两轮调用（间隔 <5min）第二轮
 * cache_read_tokens > 0」。本工具把验收自动化：
 *   1. 构造稳定的长 system 前缀（模拟真实会话的稳定前缀；两次调用前缀逐字节一致）
 *   2. 第一次调用（cache miss，服务端写入缓存）
 *   3. 第二次调用（前缀一致 → 命中缓存）
 *   4. 报告两次调用的 cache_read_tokens；ok = 第二次 > 0
 *
 * 纯外围工具：不触碰 Agent.run 核心循环；llm 依赖注入（默认 createProvider()）便于测试
 * 用 fake provider（不触网）。不读取/输出任何密钥。
 */
import { createProvider, extractUsageCache, type LLMProvider, type LLMResponse } from './llm.js'

/** 单次调用的用量快照 */
export interface CacheCallUsage {
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface CacheCheckResult {
  ok: boolean
  model: string
  /** 第一次调用（cache miss 基准） */
  first: CacheCallUsage
  /** 第二次调用（前缀一致，期望命中） */
  second: CacheCallUsage
  /** 命中判定说明（ok=false 时的原因） */
  detail: string
  /** 命中量（第二次 cache_read_tokens） */
  hitTokens: number
  /** 估算节省成本 USD（命中部分按命中价计 vs 未命中价；模型无法定价时为 null） */
  savedUsd: number | null
}

/** 稳定前缀填充段（重复 N 次构成数百 token 的可命中前缀；内容本身无意义，只求稳定） */
const PAD_BLOCK = [
  'flare 引擎是一个通用能力 AI Agent，面向桌面应用内嵌与终端使用场景。',
  '它支持工具调用、MCP 集成、上下文压缩与用量统计，并保持轻量、可嵌入。',
  '缓存验证需要稳定的系统前缀，以便服务端可以命中之前写入的缓存片段。',
  '前缀稳定性是 prompt caching 的第一性原理：同样的前缀必须逐字节一致。',
].join('')

/** 构造稳定长前缀：约 12 块（≈ 1.2K 字符，数百 token），两次调用共用同一字符串常量 */
function buildSystemPrefix(): string {
  return `你是 flare 引擎的缓存验证助手。请严格按要求输出，不要多余内容。\n\n${PAD_BLOCK.repeat(12)}\n\n规则：只输出要求的数字。`
}

/**
 * 执行缓存命中验收（两次调用）。
 *
 * @param llm provider（缺省 createProvider()——测试注入 fake 避免触网）
 * @returns 结构化结果（不抛异常：调用失败也返回 ok:false + detail，便于 CLI 报错不崩）
 */
export async function runCacheCheck(llm: LLMProvider = createProvider()): Promise<CacheCheckResult> {
  const system = buildSystemPrefix()
  const mk = (n: number): any[] => [
    { role: 'system', content: system },
    { role: 'user', content: `请只回复数字 ${n}` },
  ]

  const snapshot = (r: LLMResponse): CacheCallUsage => {
    const cache = extractUsageCache(r.usage)
    return {
      promptTokens: r.usage?.prompt_tokens || 0,
      completionTokens: r.usage?.completion_tokens || 0,
      cacheReadTokens: cache.cacheReadTokens,
      cacheWriteTokens: cache.cacheWriteTokens,
    }
  }

  // 第一次调用：建立缓存（miss 基准）；失败 → ok:false 不抛（CLI 直接展示）
  let first: LLMResponse
  try {
    first = await llm.chat(mk(1))
  } catch (e: any) {
    return {
      ok: false,
      model: '',
      first: { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      second: { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      detail: `第一次调用失败: ${(e?.message || String(e)).slice(0, 200)}`,
      hitTokens: 0,
      savedUsd: null,
    }
  }

  let second: LLMResponse
  try {
    second = await llm.chat(mk(2))
  } catch (e: any) {
    return {
      ok: false,
      model: first.model || '',
      first: snapshot(first),
      second: { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      detail: `第二次调用失败: ${(e?.message || String(e)).slice(0, 200)}`,
      hitTokens: 0,
      savedUsd: null,
    }
  }

  const f = snapshot(first)
  const s = snapshot(second)
  const hitTokens = s.cacheReadTokens
  const ok = hitTokens > 0

  // 节省估算：命中部分按命中价 vs 未命中价的差（复用定价表；无法定价 → null）
  let savedUsd: number | null = null
  try {
    const { estimateCostUsd } = await import('./llm.js')
    const miss = estimateCostUsd(second.model, s.promptTokens, s.completionTokens, 0)
    const hit = estimateCostUsd(second.model, s.promptTokens, s.completionTokens, s.cacheReadTokens)
    if (miss !== null && hit !== null) savedUsd = Math.round((miss - hit) * 1e6) / 1e6
  } catch { /* 定价不可用 → null */ }

  const detail = ok
    ? `第二轮命中缓存 ${hitTokens} tokens（前缀稳定生效）`
    : `第二轮 cache_read_tokens = 0（前缀未命中：服务端缓存过期/未建立/外部因素；可间隔 <5min 重试）`

  return { ok, model: second.model || first.model || '', first: f, second: s, detail, hitTokens, savedUsd }
}

/**
 * 把验收结果序列化为 JSON（v0.6.48，宿主/CI 程序化消费用——`cache-check --json`）。
 *
 * 结构化字段与 CacheCheckResult 一致：ok / model / hitTokens / savedUsd / detail /
 * first / second（各含 promptTokens/completionTokens/cacheReadTokens/cacheWriteTokens）。
 * 纯函数不触网、不读密钥；CLI 只负责打印与 exit code（ok → 0，未命中/失败 → 1）。
 */
export function cacheCheckToJson(r: CacheCheckResult): string {
  return JSON.stringify(
    {
      ok: r.ok,
      model: r.model,
      hitTokens: r.hitTokens,
      savedUsd: r.savedUsd,
      detail: r.detail,
      first: r.first,
      second: r.second,
    },
    null,
    2
  )
}
