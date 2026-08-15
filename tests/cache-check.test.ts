/**
 * prompt caching 验收工具测试（v0.6.45 runCacheCheck）
 *
 * fake LLMProvider 注入（不触网）：验证两次调用前缀逐字节一致、第二轮命中判定、
 * DeepSeek/OpenAI 两种 usage 格式兼容、调用失败不抛、成本估算。
 */
import { describe, it, expect } from 'vitest'
import { runCacheCheck, cacheCheckToJson } from '../src/core/cache-check.js'
import type { LLMProvider } from '../src/core/llm.js'

interface FakeCall {
  model?: string
  usage?: any
  error?: Error
}

/** 构造 fake provider：记录每次调用收到的 messages；calls 用尽后重复最后一个 */
function makeFake(calls: FakeCall[]) {
  const seen: any[][] = []
  let i = 0
  const llm: LLMProvider = {
    async chat(messages: any[]) {
      seen.push(messages)
      const c = calls[Math.min(i++, calls.length - 1)]
      if (c.error) throw c.error
      return { content: '1', model: c.model || 'fake-model', usage: c.usage || {} }
    },
    async *chatStream() { /* unused */ },
  }
  return { llm, seen }
}

describe('runCacheCheck（v0.6.45）', () => {
  it('第二轮命中（DeepSeek prompt_cache_hit_tokens 格式）→ ok:true + 命中量', async () => {
    const { llm, seen } = makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 650 } },
    ])
    const r = await runCacheCheck(llm)
    expect(r.ok).toBe(true)
    expect(r.model).toBe('deepseek-chat')
    expect(r.provider).toBe('deepseek')
    expect(r.first.cacheReadTokens).toBe(0)
    expect(r.second.cacheReadTokens).toBe(650)
    expect(r.hitTokens).toBe(650)
    expect(r.detail).toContain('命中缓存 650 tokens')
    // 前缀一致性：两次调用的 system 前缀逐字节一致，仅 user 内容不同
    expect(seen).toHaveLength(2)
    expect(seen[0][0].content).toBe(seen[1][0].content)
    expect(seen[0][1].content).toContain('数字 1')
    expect(seen[1][1].content).toContain('数字 2')
    // 前缀足够长（数百 token 才有验证意义）
    expect(seen[0][0].content.length).toBeGreaterThan(500)
  })

  it('OpenAI cached_tokens 格式兼容 → ok:true', async () => {
    const { llm } = makeFake([
      { model: 'gpt-4o', usage: { prompt_tokens: 900, completion_tokens: 10 } },
      { model: 'gpt-4o', usage: { prompt_tokens: 900, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 700 } } },
    ])
    const r = await runCacheCheck(llm)
    expect(r.ok).toBe(true)
    expect(r.second.cacheReadTokens).toBe(700)
    expect(r.provider).toBe('openai')
  })

  it('第二轮未命中（cache_read_tokens=0）→ ok:false + detail 说明外部因素', async () => {
    const { llm } = makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
    ])
    const r = await runCacheCheck(llm)
    expect(r.ok).toBe(false)
    expect(r.hitTokens).toBe(0)
    expect(r.detail).toContain('cache_read_tokens = 0')
  })

  it('第一次调用失败 → ok:false + detail，不抛异常', async () => {
    const { llm } = makeFake([
      { error: new Error('401 api key 无效') },
      { model: 'deepseek-chat', usage: {} },
    ])
    const r = await runCacheCheck(llm)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('第一次调用失败')
    expect(r.detail).toContain('401')
  })

  it('第二次调用失败 → ok:false + detail，不抛异常', async () => {
    const { llm } = makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 10, completion_tokens: 1 } },
      { error: new Error('网络超时') },
    ])
    const r = await runCacheCheck(llm)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('第二次调用失败')
    expect(r.detail).toContain('网络超时')
  })

  it('DeepSeek 模型估算节省成本（命中价 vs 未命中价）', async () => {
    const { llm } = makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 1000 } },
    ])
    const r = await runCacheCheck(llm)
    expect(r.savedUsd).not.toBeNull()
    expect(r.savedUsd!).toBeGreaterThan(0)
  })

  it('无法定价的模型 → savedUsd null（不报错）', async () => {
    const { llm } = makeFake([
      { model: 'qwen2.5:7b', usage: { prompt_tokens: 1000, completion_tokens: 10 } },
      { model: 'qwen2.5:7b', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 500 } },
    ])
    const r = await runCacheCheck(llm)
    expect(r.ok).toBe(true)
    expect(r.savedUsd).toBeNull()
    expect(r.provider).toBe('ollama')
  })

  it('多轮验收 savedUsd 累加所有命中轮（v0.6.75：修复此前只算最后一轮）', async () => {
    // 3 轮：第 1 轮 miss 基准，第 2/3 轮都命中 → 总节省 ≈ 两轮命中节省之和
    const { llm } = makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 900 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 900 } },
    ])
    const r = await runCacheCheck(llm, { rounds: 3 })
    expect(r.ok).toBe(true)
    expect(r.rounds).toBe(3)
    expect(r.hitTokens).toBe(900)
    expect(r.savedUsd).not.toBeNull()
    // 对照组：2 轮（单命中轮）的节省——3 轮两轮命中 → 总节省 ≈ 2 × 单轮节省
    const single = await runCacheCheck(makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 900 } },
    ]).llm)
    expect(single.savedUsd).not.toBeNull()
    expect(single.savedUsd!).toBeGreaterThan(0)
    expect(r.savedUsd!).toBeCloseTo(single.savedUsd! * 2, 4)
  })

  it('多轮验收中间某轮未命中 → 节省只累加命中轮（v0.6.75）', async () => {
    // 3 轮：第 2 轮命中、第 3 轮 miss（ok:false）→ 节省只算第 2 轮（与 2 轮单命中轮相当）
    const { llm } = makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 900 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
    ])
    const r = await runCacheCheck(llm, { rounds: 3 })
    expect(r.ok).toBe(false)
    const single = await runCacheCheck(makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 900 } },
    ]).llm)
    expect(single.savedUsd).not.toBeNull()
    expect(r.savedUsd).not.toBeNull()
    expect(r.savedUsd!).toBeCloseTo(single.savedUsd!, 4)
  })

  it('cacheCheckToJson（v0.6.48）：合法 JSON + 全部结构化字段（宿主/CI 消费）', async () => {
    const { llm } = makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 650 } },
    ])
    const r = await runCacheCheck(llm)
    const json = cacheCheckToJson(r)
    // 纯 JSON（首字符即 {，无彩色/前缀行）
    expect(json.trim().startsWith('{')).toBe(true)
    const parsed = JSON.parse(json)
    expect(parsed.ok).toBe(true)
    expect(parsed.model).toBe('deepseek-chat')
    expect(parsed.provider).toBe('deepseek')
    expect(parsed.prefixChars).toBeGreaterThan(500)
    expect(parsed.hitSegmentNote).toContain('部分命中')
    expect(parsed.hitTokens).toBe(650)
    expect(parsed.detail).toContain('命中缓存 650 tokens')
    expect(parsed.savedUsd).toBeGreaterThan(0)
    expect(parsed.first).toEqual({ promptTokens: 800, completionTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(parsed.second.cacheReadTokens).toBe(650)
    expect(parsed.second.promptTokens).toBe(800)
    // v0.6.76：--json 含每轮节省明细（与 runs 对齐：基准轮 0、命中轮 >0）
    expect(parsed.runSavedUsd).toHaveLength(2)
    expect(parsed.runSavedUsd![0]).toBe(0)
    expect(parsed.runSavedUsd![1]).toBeGreaterThan(0)
  })

  it('runSavedUsd 每轮节省明细（v0.6.76：多轮时每轮独立计算，与总节省同口径）', async () => {
    // 3 轮：基准 miss + 第 2/3 轮同 tokens 命中 → 两轮明细相等，且各 = 2 轮单命中轮的节省
    const { llm } = makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 900 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 900 } },
    ])
    const r = await runCacheCheck(llm, { rounds: 3 })
    const single = await runCacheCheck(makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 900 } },
    ]).llm)
    expect(r.runSavedUsd).toHaveLength(3)
    expect(r.runSavedUsd[0]).toBe(0) // 基准轮 miss → 无节省
    // 两命中轮 tokens 相同 → 每轮节省精确相等（同 round 同输入）
    expect(r.runSavedUsd[1]).toBe(single.savedUsd)
    expect(r.runSavedUsd[2]).toBe(single.savedUsd)
    expect(r.savedUsd).toBeCloseTo((r.runSavedUsd[1] as number) * 2, 6)
  })

  it('runSavedUsd 无法定价模型 → 全部 null（v0.6.76，与 savedUsd null 一致）', async () => {
    const { llm } = makeFake([
      { model: 'qwen2.5:7b', usage: { prompt_tokens: 1000, completion_tokens: 10 } },
      { model: 'qwen2.5:7b', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 500 } },
    ])
    const r = await runCacheCheck(llm)
    expect(r.savedUsd).toBeNull()
    expect(r.runSavedUsd).toEqual([null, null])
  })

  it('基准轮已命中 → detail 追加残留缓存诊断（v0.6.78：<5min 内重跑的真实场景）', async () => {
    // 第一次调用 cacheReadTokens > 0（服务端残留缓存/此前用过同前缀）→ miss 基准实际不纯
    const { llm } = makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 500 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 900 } },
    ])
    const r = await runCacheCheck(llm)
    expect(r.ok).toBe(true)
    expect(r.first.cacheReadTokens).toBe(500)
    // 原判定文本保留 + 诊断提示追加
    expect(r.detail).toContain('命中缓存 900 tokens')
    expect(r.detail).toContain('诊断：基准轮已有 500 tokens 命中')
    expect(r.detail).toContain('miss 基准可能不纯')
    // 基准轮命中 → 该轮 runSavedUsd > 0（与诊断一致，CLI 会显示基准轮节省）
    expect(r.runSavedUsd[0]).toBeGreaterThan(0)
  })

  it('基准轮未命中 → 无诊断提示（v0.6.78：detail 与旧版一致）', async () => {
    const { llm } = makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 900 } },
    ])
    const r = await runCacheCheck(llm)
    expect(r.detail).toContain('命中缓存 900 tokens')
    expect(r.detail).not.toContain('诊断：')
  })

  it('cacheCheckToJson（v0.6.48）：失败结果也结构化（ok:false + detail），不抛异常', async () => {
    const { llm } = makeFake([
      { error: new Error('401 api key 无效') },
      { model: 'deepseek-chat', usage: {} },
    ])
    const r = await runCacheCheck(llm)
    const parsed = JSON.parse(cacheCheckToJson(r))
    expect(parsed.ok).toBe(false)
    expect(parsed.detail).toContain('第一次调用失败')
    expect(parsed.model).toBe('')
    expect(parsed.provider).toBe('other')
    expect(parsed.hitTokens).toBe(0)
    expect(parsed.savedUsd).toBeNull()
  })

  it('多轮验收（v0.6.54 --rounds 3）：第 2/3 轮都命中 → ok:true + rounds/runs 快照', async () => {
    const { llm, seen } = makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 640 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 650 } },
    ])
    const r = await runCacheCheck(llm, { rounds: 3 })
    expect(r.ok).toBe(true)
    expect(r.rounds).toBe(3)
    expect(r.runs).toHaveLength(3)
    expect(r.runs.map((u) => u.cacheReadTokens)).toEqual([0, 640, 650])
    // first 为基准、second 为最后一轮
    expect(r.first.cacheReadTokens).toBe(0)
    expect(r.second.cacheReadTokens).toBe(650)
    expect(r.hitTokens).toBe(650)
    expect(r.detail).toContain('连续 2 轮命中缓存')
    // 三轮都调用、前缀逐字节一致、user 内容递增
    expect(seen).toHaveLength(3)
    expect(seen[0][0].content).toBe(seen[2][0].content)
    expect(seen[2][1].content).toContain('数字 3')
  })

  it('多轮验收（v0.6.54）：第 3 轮中断 → ok:false + detail 指出中断轮次', async () => {
    const { llm } = makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 640 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
    ])
    const r = await runCacheCheck(llm, { rounds: 3 })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('第 3 轮 cache_read_tokens = 0')
    expect(r.detail).toContain('连续命中中断')
  })

  it('多轮验收（v0.6.54）：rounds 非法（1 / 6 / 1.5 / abc）→ 回退默认 2 不崩', async () => {
    for (const bad of [1, 6, 1.5, Number('abc')]) {
      const { llm, seen } = makeFake([
        { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
        { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 650 } },
      ])
      const r = await runCacheCheck(llm, { rounds: bad })
      expect(r.rounds).toBe(2)
      expect(r.ok).toBe(true)
      expect(seen).toHaveLength(2)
    }
  })

  it('多轮 JSON（v0.6.54）：--json 含 rounds/runs 快照', async () => {
    const { llm } = makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 640 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 650 } },
    ])
    const r = await runCacheCheck(llm, { rounds: 3 })
    const parsed = JSON.parse(cacheCheckToJson(r))
    expect(parsed.rounds).toBe(3)
    expect(parsed.runs).toHaveLength(3)
    expect(parsed.runs[2].cacheReadTokens).toBe(650)
    expect(parsed.second.cacheReadTokens).toBe(650)
  })

  it('命中率百分比（v0.6.116）：hitRatio 末轮 + runHitRatios 每轮（与 CLI 文本模式同口径四舍五入）', async () => {
    const { llm } = makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 650 } },
    ])
    const r = await runCacheCheck(llm)
    // 650/800 = 81.25 → 81%；基准轮 0/800 = 0%
    expect(r.hitRatio).toBe(81)
    expect(r.runHitRatios).toEqual([0, 81])
    const parsed = JSON.parse(cacheCheckToJson(r))
    expect(parsed.hitRatio).toBe(81)
    expect(parsed.runHitRatios).toEqual([0, 81])
  })

  it('命中率百分比（v0.6.116）：多轮时与 runs 对齐（命中轮 >0、中断轮 0）', async () => {
    const { llm } = makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 640 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 650 } },
    ])
    const r = await runCacheCheck(llm, { rounds: 3 })
    expect(r.runHitRatios).toEqual([0, 80, 81]) // 640/800=80%、650/800=81.25→81%
    expect(r.hitRatio).toBe(81)
    // 中断场景：第 3 轮 miss → ok:false，命中率如实反映（末轮 0）
    const miss = await runCacheCheck(makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 640 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
    ]).llm, { rounds: 3 })
    expect(miss.ok).toBe(false)
    expect(miss.hitRatio).toBe(0)
    expect(miss.runHitRatios).toEqual([0, 80, 0])
  })

  it('命中率百分比（v0.6.116）：promptTokens=0 → null（避免除零）；失败路径同样 null', async () => {
    // promptTokens=0（异常空用量）→ hitRatio null，不抛错
    const { llm } = makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 } },
    ])
    const r = await runCacheCheck(llm)
    expect(r.hitRatio).toBeNull()
    expect(r.runHitRatios).toEqual([null, null])
    const parsed = JSON.parse(cacheCheckToJson(r))
    expect(parsed.hitRatio).toBeNull()
    expect(parsed.runHitRatios).toEqual([null, null])
    // 失败路径：第一次调用失败 → usages 为空、失败轮 null（第二次调用不会执行）
    const fail = await runCacheCheck(makeFake([
      { error: new Error('401 api key 无效') },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 600 } },
    ]).llm)
    expect(fail.ok).toBe(false)
    expect(fail.hitRatio).toBeNull()
    expect(fail.runHitRatios).toEqual([null])
    // 失败路径：第二次调用失败 → 第一轮成功按实际计算、失败轮 null
    const fail2 = await runCacheCheck(makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { error: new Error('网络超时') },
    ]).llm)
    expect(fail2.ok).toBe(false)
    expect(fail2.hitRatio).toBe(0) // 最后成功轮为基准轮
    expect(fail2.runHitRatios).toEqual([0, null])
  })

  it('provider 标注（v0.6.139）：本地 ollama 模型 → provider ollama + prefixChars 稳定前缀规模', async () => {
    // 混合模式观测面：本地模型无服务端缓存计费，命中 0 属预期（CLI 会给语义提示，不误报缓存故障）
    const { llm } = makeFake([
      { model: 'qwen2.5:7b', usage: { prompt_tokens: 800, completion_tokens: 10 } },
      { model: 'qwen2.5:7b', usage: { prompt_tokens: 800, completion_tokens: 10 } },
    ])
    const r = await runCacheCheck(llm)
    expect(r.provider).toBe('ollama')
    // 稳定 system 前缀字符数（预期命中内容片段规模：两次调用逐字节一致的 system 前缀）
    expect(r.prefixChars).toBeGreaterThan(500)
    expect(r.prefixChars).toBeLessThan(5000)
    // JSON 透传 provider/prefixChars（宿主/CI 可识别本地场景）
    const parsed = JSON.parse(cacheCheckToJson(r))
    expect(parsed.provider).toBe('ollama')
    expect(parsed.prefixChars).toBe(r.prefixChars)
  })

  it('provider 标注（v0.6.139）：deepseek/openai 模型 → provider 正确（线上缓存计费场景）', async () => {
    const ds = await runCacheCheck(makeFake([
      { model: 'deepseek-reasoner', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-reasoner', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 600 } },
    ]).llm)
    expect(ds.provider).toBe('deepseek')
    const oa = await runCacheCheck(makeFake([
      { model: 'gpt-4o', usage: { prompt_tokens: 800, completion_tokens: 10 } },
      { model: 'gpt-4o', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 600 } } },
    ]).llm)
    expect(oa.provider).toBe('openai')
    // 未知模型 → other（与 detectProvider 语义一致）
    const ot = await runCacheCheck(makeFake([
      { model: 'unknown-model', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'unknown-model', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 600 } },
    ]).llm)
    expect(ot.provider).toBe('other')
  })

  it('命中片段构成诊断（v0.6.142）：完整命中/部分命中/未命中三档说明', async () => {
    // 完整命中：命中 = prompt 全部（100%）
    const full = await runCacheCheck(makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 800 } },
    ]).llm)
    expect(full.hitSegmentNote).toContain('完整命中')
    // 部分命中（预期）：命中稳定前缀，user 尾部未命中
    const partial = await runCacheCheck(makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 650 } },
    ]).llm)
    expect(partial.hitSegmentNote).toContain('部分命中')
    expect(partial.hitSegmentNote).toContain('user 消息尾部')
    // 未命中：命中 0
    const miss = await runCacheCheck(makeFake([
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
      { model: 'deepseek-chat', usage: { prompt_tokens: 800, completion_tokens: 10, prompt_cache_hit_tokens: 0 } },
    ]).llm)
    expect(miss.hitSegmentNote).toContain('未命中')
    // 失败路径（第一次调用失败 → 命中率不可计算）
    const fail = await runCacheCheck(makeFake([
      { error: new Error('401 api key 无效') },
      { model: 'deepseek-chat', usage: {} },
    ]).llm)
    expect(fail.hitSegmentNote).toContain('不可计算')
    // JSON 透传
    const parsed = JSON.parse(cacheCheckToJson(partial))
    expect(parsed.hitSegmentNote).toBe(partial.hitSegmentNote)
  })
})
