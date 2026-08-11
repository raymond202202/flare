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
    expect(parsed.hitTokens).toBe(650)
    expect(parsed.detail).toContain('命中缓存 650 tokens')
    expect(parsed.savedUsd).toBeGreaterThan(0)
    expect(parsed.first).toEqual({ promptTokens: 800, completionTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(parsed.second.cacheReadTokens).toBe(650)
    expect(parsed.second.promptTokens).toBe(800)
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
})
