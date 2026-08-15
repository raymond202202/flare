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
import { detectProvider } from './models.js'

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
  /** provider 类型（v0.6.139：detectProvider(model)——混合模式下区分线上 deepseek/openai 与本地 ollama，
   *  宿主/CI 消费 --json 时可识别「本地模型无服务端缓存计费」场景，避免误读命中 0 为失败） */
  provider: 'ollama' | 'deepseek' | 'openai' | 'other'
  /** 构造的稳定 system 前缀字符数（v0.6.139：展示「预期命中内容片段」规模——cache-check 命中的就是
   *  两次调用逐字节一致的稳定前缀，宿主/CI 可据此理解命中片段构成） */
  prefixChars: number
  /** 命中片段构成诊断（v0.6.142：基于末轮命中率生成——完整命中/部分命中/未命中的人类可读说明，
   *  帮助理解「部分命中是预期行为」：未命中部分通常为每次变化的 user 消息尾部，不影响前缀缓存有效性） */
  hitSegmentNote: string
  /** 第一次调用（cache miss 基准） */
  first: CacheCallUsage
  /** 第二次调用（前缀一致，期望命中） */
  second: CacheCallUsage
  /** 轮数（v0.6.54：默认 2；>2 时为多轮连续命中验收，first 为基准、second 为最后一轮） */
  rounds: number
  /** 每一轮（含基准轮）的用量快照（v0.6.54；rounds=2 时 [first, second]） */
  runs: CacheCallUsage[]
  /** 命中判定说明（ok=false 时的原因） */
  detail: string
  /** 命中量（最后一轮 cache_read_tokens） */
  hitTokens: number
  /** 命中率百分比（最后一轮 cache_read_tokens / prompt_tokens × 100，四舍五入；promptTokens=0 或失败 → null；v0.6.116）
   *  与 CLI 文本模式（v0.6.79）及 /usage 命中率观测面对称，宿主/CI 消费 --json 时可程序化判定缓存效率 */
  hitRatio: number | null
  /** 每轮命中率百分比（v0.6.116：与 runs 对齐；第 i 项 = 第 i 轮 cacheReadTokens/promptTokens × 100，
   *  promptTokens=0 或调用失败轮 → null；基准轮未命中通常为 0） */
  runHitRatios: (number | null)[]
  /** 估算节省成本 USD（命中部分按命中价计 vs 未命中价；模型无法定价时为 null） */
  savedUsd: number | null
  /** 每轮节省明细（v0.6.76：与 runs 对齐；第 i 项 = 第 i+1 轮 miss 价 − hit 价，
   *  无法定价 → null；基准轮/未命中轮通常为 0） */
  runSavedUsd: (number | null)[]
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
 * 执行缓存命中验收（连续 rounds 轮调用：第 1 轮为 miss 基准，第 2..N 轮都应命中缓存）。
 *
 * @param llm provider（缺省 createProvider()——测试注入 fake 避免触网）
 * @param opts.rounds 验收轮数（默认 2；合法范围 2~5，非法回退 2）——>2 时为多轮连续命中
 *   验收（更严格验证服务端缓存稳定性：每一轮都命中才算 PASS，避免「偶尔命中一次」误判）
 * @returns 结构化结果（不抛异常：调用失败也返回 ok:false + detail，便于 CLI 报错不崩）
 */
export async function runCacheCheck(llm: LLMProvider = createProvider(), opts: { rounds?: number } = {}): Promise<CacheCheckResult> {
  const rounds = Number.isInteger(opts.rounds) && (opts.rounds as number) >= 2 && (opts.rounds as number) <= 5
    ? (opts.rounds as number)
    : 2
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

  const zero = (): CacheCallUsage => ({ promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })

  /** 单轮命中率百分比（v0.6.116）：promptTokens=0 → null（无法计算，避免除零）；与 CLI 文本模式同口径四舍五入 */
  const ratioOf = (u: CacheCallUsage): number | null =>
    u.promptTokens > 0 ? Math.round((u.cacheReadTokens / u.promptTokens) * 100) : null

  /** 命中片段构成诊断（v0.6.142）：基于命中率给出人类可读说明——帮助理解「部分命中是预期行为」：
   *  cache-check 的 prompt = 稳定 system 前缀 + 每次变化的 user 消息；服务端按前缀缓存，第二轮命中
   *  的是稳定前缀部分，user 消息尾部每次不同不参与命中（命中率 <100% 属正常，不代表缓存失效） */
  const segmentNoteOf = (ratio: number | null): string => {
    if (ratio === null) return '命中率不可计算（prompt tokens 为 0 或调用失败）'
    if (ratio === 100) return '完整命中：稳定前缀与本次 user 消息均被缓存命中'
    if (ratio > 0) return '部分命中（预期）：命中的是稳定 system 前缀；未命中的 user 消息尾部每次变化，不影响前缀缓存有效性'
    return '未命中：稳定前缀未建立或已过期（可间隔 <5min 重试）'
  }

  // 逐轮调用：第 1 轮建立缓存（miss 基准），第 2..N 轮期望命中；任一轮失败 → ok:false 不抛
  const usages: CacheCallUsage[] = []
  let model = ''
  for (let i = 0; i < rounds; i++) {
    let resp: LLMResponse
    try {
      resp = await llm.chat(mk(i + 1))
    } catch (e: any) {
      const failLabel = i === 0 ? '第一次' : i === 1 ? '第二次' : `第 ${i + 1} 轮`
      return {
        ok: false,
        model,
        provider: detectProvider(model),
        prefixChars: system.length,
        hitSegmentNote: segmentNoteOf(usages.length > 0 ? ratioOf(usages[usages.length - 1]) : null),
        first: usages[0] || zero(),
        second: zero(),
        rounds,
        runs: [...usages, zero()],
        detail: `${failLabel}调用失败: ${(e?.message || String(e)).slice(0, 200)}`,
        hitTokens: 0,
        hitRatio: usages.length > 0 ? ratioOf(usages[usages.length - 1]) : null,
        runHitRatios: [...usages.map(ratioOf), null],
        savedUsd: null,
        runSavedUsd: [...usages.map(() => null), null],
      }
    }
    model = resp.model || model
    usages.push(snapshot(resp))
  }

  const first = usages[0]
  const last = usages[usages.length - 1]
  const hitTokens = last.cacheReadTokens
  // 多轮验收：第 2..N 轮全部命中才算 ok（避免「仅偶发命中一次」误判为缓存稳定）
  const hitRuns = usages.slice(1)
  const ok = hitRuns.length > 0 && hitRuns.every((u) => u.cacheReadTokens > 0)

  // 节省估算：命中部分按命中价 vs 未命中价的差（复用定价表；无法定价 → null）
  // v0.6.75：多轮验收（--rounds>2）时**累加所有命中轮**的节省——修复此前只按最后一轮计算，
  // 导致宿主/CI 消费 cache-check --json 时总节省被低估（rounds=2 时只有一个命中轮，行为不变）
  // v0.6.76：同时产出每轮节省明细 runSavedUsd（与 runs 对齐；基准轮/未命中轮通常为 0）
  const runSavedUsd: (number | null)[] = []
  let savedUsd: number | null = null
  try {
    const { estimateCostUsd } = await import('./llm.js')
    let total = 0
    let priced = true
    for (let i = 0; i < usages.length; i++) {
      const u = usages[i]
      const miss = estimateCostUsd(model, u.promptTokens, u.completionTokens, 0)
      const hit = estimateCostUsd(model, u.promptTokens, u.completionTokens, u.cacheReadTokens)
      if (miss === null || hit === null) {
        runSavedUsd.push(null)
        if (i > 0) priced = false // 汇总只依赖命中轮（第 2..N 轮）；基准轮不可定价不影响
      } else {
        runSavedUsd.push(Math.round((miss - hit) * 1e6) / 1e6)
        if (i > 0 && u.cacheReadTokens > 0) total += miss - hit // 未命中轮没有节省
      }
    }
    if (priced) savedUsd = Math.round(total * 1e6) / 1e6
  } catch {
    for (let i = 0; i < usages.length; i++) runSavedUsd.push(null) // 定价不可用 → 全部 null
  }

  const detail = ok
    ? rounds === 2
      ? `第二轮命中缓存 ${hitTokens} tokens（前缀稳定生效）`
      : `连续 ${rounds - 1} 轮命中缓存（末轮 ${hitTokens} tokens，前缀稳定生效）`
    : rounds === 2
      ? `第二轮 cache_read_tokens = 0（前缀未命中：服务端缓存过期/未建立/外部因素；可间隔 <5min 重试）`
      : `第 ${hitRuns.findIndex((u) => u.cacheReadTokens <= 0) + 2} 轮 cache_read_tokens = 0（连续命中中断：服务端缓存过期/外部因素；可间隔 <5min 重试）`

  // v0.6.78 诊断：基准轮（第 1 轮）已命中 → 服务端残留缓存或此前 5min 内用过同前缀，
  // 「miss 基准」实际不纯（真实场景：<5min 内重跑 cache-check）——追加提示，避免用户误读
  const baselineHit = first.cacheReadTokens > 0
  const diag = baselineHit
    ? `（诊断：基准轮已有 ${first.cacheReadTokens} tokens 命中——服务端残留缓存或此前 <5min 用过同前缀，miss 基准可能不纯，节省估算偏保守）`
    : ''
  const detailWithDiag = detail + diag

  return {
    ok,
    model,
    provider: detectProvider(model),
    prefixChars: system.length,
    hitSegmentNote: segmentNoteOf(ratioOf(last)),
    first,
    second: last,
    rounds,
    runs: usages,
    detail: detailWithDiag,
    hitTokens,
    hitRatio: ratioOf(last),
    runHitRatios: usages.map(ratioOf),
    savedUsd,
    runSavedUsd,
  }
}

/**
 * 把验收结果序列化为 JSON（v0.6.48，宿主/CI 程序化消费用——`cache-check --json`；
 * v0.6.54 起含 rounds 与 runs 多轮快照）。
 *
 * 结构化字段与 CacheCheckResult 一致：ok / model / hitTokens / hitRatio / runHitRatios /
 * savedUsd / detail / rounds / runs / first / second（各含 promptTokens/completionTokens/
 * cacheReadTokens/cacheWriteTokens；v0.6.76 起含 runSavedUsd 每轮节省明细；v0.6.116 起含
 * hitRatio 末轮命中率与 runHitRatios 每轮命中率）。纯函数不触网、不读密钥；
 * CLI 只负责打印与 exit code（ok → 0，未命中/失败 → 1）。
 */
export function cacheCheckToJson(r: CacheCheckResult): string {
  return JSON.stringify(
    {
      ok: r.ok,
      model: r.model,
      provider: r.provider,
      prefixChars: r.prefixChars,
      hitSegmentNote: r.hitSegmentNote,
      hitTokens: r.hitTokens,
      hitRatio: r.hitRatio,
      runHitRatios: r.runHitRatios,
      savedUsd: r.savedUsd,
      detail: r.detail,
      rounds: r.rounds,
      runs: r.runs,
      first: r.first,
      second: r.second,
      runSavedUsd: r.runSavedUsd,
    },
    null,
    2
  )
}
