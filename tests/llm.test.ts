/**
 * LLM provider 模型路由测试（v0.5.2）
 *
 * 纯函数 resolveProviderOptions 单测（无网络）：模型名 → 端点/密钥推导，
 * 覆盖 Ollama 本地模型 / DeepSeek / OpenAI / Claude 报错 / 配置覆盖。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { resolveProviderOptions, estimateCostUsd, extractUsageCache } from '../src/core/llm.js'
import { config } from '../src/core/config.js'

const KEYS = ['DEFAULT_MODEL', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_BASE_URL', 'LLM_BASE_URL', 'LLM_API_KEY']

beforeEach(() => {
  // 干净起点：相关配置全部清空（config 是模块级单例，本文件独立 worker 不影响其他测试）
  for (const k of KEYS) config.set(k, '')
})

describe('resolveProviderOptions 模型路由', () => {
  it('无任何配置 → 回退默认模型 gpt-4o + OpenAI 端点', () => {
    const r = resolveProviderOptions()
    expect(r.model).toBe('gpt-4o')
    expect(r.baseURL).toBe('https://api.openai.com/v1')
  })

  it('deepseek 模型 → DeepSeek API + DEEPSEEK_API_KEY', () => {
    config.set('DEEPSEEK_API_KEY', 'sk-deepseek')
    const r = resolveProviderOptions({ model: 'deepseek-chat' })
    expect(r.baseURL).toBe('https://api.deepseek.com/v1')
    expect(r.apiKey).toBe('sk-deepseek')
  })

  it('gpt 模型 → OpenAI API + OPENAI_API_KEY', () => {
    config.set('OPENAI_API_KEY', 'sk-openai')
    const r = resolveProviderOptions({ model: 'gpt-4o' })
    expect(r.baseURL).toBe('https://api.openai.com/v1')
    expect(r.apiKey).toBe('sk-openai')
  })

  it('Ollama 模型（含冒号）→ 本地端点 + apiKey ollama，即使配置了远端 key 也不用', () => {
    config.set('DEEPSEEK_API_KEY', 'sk-deepseek')
    config.set('OPENAI_API_KEY', 'sk-openai')
    const r = resolveProviderOptions({ model: 'qwen2.5:7b' })
    expect(r.baseURL).toBe('http://localhost:11434/v1')
    expect(r.apiKey).toBe('ollama')
  })

  it('Ollama 上的 deepseek（deepseek-r1:7b）→ 冒号优先走本地 Ollama', () => {
    const r = resolveProviderOptions({ model: 'deepseek-r1:7b' })
    expect(r.baseURL).toBe('http://localhost:11434/v1')
    expect(r.apiKey).toBe('ollama')
  })

  it('claude 模型 → 明确报错（Anthropic 非 OpenAI 兼容格式）', () => {
    expect(() => resolveProviderOptions({ model: 'claude-3-5-sonnet' })).toThrow(/Claude/)
  })

  it('显式 options.baseURL / apiKey 优先于一切', () => {
    config.set('LLM_BASE_URL', 'https://proxy.example.com/v1')
    const r = resolveProviderOptions({ model: 'deepseek-chat', baseURL: 'https://custom.example.com/v1', apiKey: 'sk-custom' })
    expect(r.baseURL).toBe('https://custom.example.com/v1')
    expect(r.apiKey).toBe('sk-custom')
  })

  it('LLM_BASE_URL / LLM_API_KEY 配置覆盖自动检测', () => {
    config.set('LLM_BASE_URL', 'https://proxy.example.com/v1')
    config.set('LLM_API_KEY', 'sk-proxy')
    const r = resolveProviderOptions({ model: 'deepseek-chat' })
    expect(r.baseURL).toBe('https://proxy.example.com/v1')
    expect(r.apiKey).toBe('sk-proxy')
  })

  it('旧配置 OPENAI_BASE_URL 仍生效（兼容）', () => {
    config.set('OPENAI_BASE_URL', 'https://legacy.example.com/v1')
    const r = resolveProviderOptions({ model: 'gpt-4o' })
    expect(r.baseURL).toBe('https://legacy.example.com/v1')
  })

  it('options.model 优先于 DEFAULT_MODEL 配置', () => {
    config.set('DEFAULT_MODEL', 'deepseek-chat')
    config.set('DEEPSEEK_API_KEY', 'sk-deepseek')
    const r = resolveProviderOptions({ model: 'qwen2.5:14b' })
    expect(r.model).toBe('qwen2.5:14b')
    expect(r.baseURL).toBe('http://localhost:11434/v1')
  })

  it('DEFAULT_MODEL 配置生效（未显式传 model）', () => {
    config.set('DEFAULT_MODEL', 'deepseek-chat')
    config.set('DEEPSEEK_API_KEY', 'sk-deepseek')
    const r = resolveProviderOptions()
    expect(r.model).toBe('deepseek-chat')
    expect(r.baseURL).toBe('https://api.deepseek.com/v1')
  })

  it('未知模型（无冒号）→ 静默回退 OpenAI 端点（兼容旧行为，不抛错）', () => {
    const r = resolveProviderOptions({ model: 'mixtral-8x7b' })
    expect(r.baseURL).toBe('https://api.openai.com/v1')
  })

  it('Ollama 模型 + 显式 options.apiKey → 用显式 key', () => {
    const customKey = 'sk-' + 'local'
    const r = resolveProviderOptions({ model: 'llama3.1:8b', apiKey: customKey })
    expect(r.baseURL).toBe('http://localhost:11434/v1')
    expect(r.apiKey).toBe(customKey)
  })
})

describe('estimateCostUsd（成本估算，v0.6.29 P0）', () => {
  it('deepseek-chat：未命中 1M input + 1M output → $0.27 + $1.10', () => {
    expect(estimateCostUsd('deepseek-chat', 1_000_000, 1_000_000, 0)).toBe(1.37)
  })

  it('缓存命中按命中价计（0.07/M），未命中部分按原价', () => {
    // 1M prompt 全部命中缓存：0.07 + 输出 1.10
    expect(estimateCostUsd('deepseek-chat', 1_000_000, 1_000_000, 1_000_000)).toBe(1.17)
  })

  it('部分命中：500k 命中 + 500k 未命中', () => {
    const cost = estimateCostUsd('deepseek-chat', 1_000_000, 0, 500_000)
    // 0.5*0.27 + 0.5*0.07 = 0.135 + 0.035 = 0.17
    expect(cost).toBeCloseTo(0.17, 6)
  })

  it('deepseek-reasoner 用更高定价', () => {
    // 1M input 未命中 + 0 output：0.55
    expect(estimateCostUsd('deepseek-reasoner', 1_000_000, 0, 0)).toBe(0.55)
  })

  it('未知模型（本地 Ollama 等）→ null（无法可靠估算）', () => {
    expect(estimateCostUsd('qwen2.5:7b', 1000, 500, 0)).toBeNull()
    expect(estimateCostUsd('gpt-4o', 1000, 500, 0)).toBeNull()
  })

  it('负数/越界防御：cacheRead > prompt 时按 prompt 封顶', () => {
    const cost = estimateCostUsd('deepseek-chat', 1_000_000, 0, 2_000_000)
    expect(cost).toBe(0.07) // 全部按命中价
  })
})

describe('extractUsageCache（usage 缓存字段提取，v0.6.29 P0）', () => {
  it('DeepSeek 格式：prompt_cache_hit_tokens', () => {
    expect(extractUsageCache({ prompt_cache_hit_tokens: 123 })).toEqual({ cacheReadTokens: 123, cacheWriteTokens: 0 })
  })

  it('OpenAI 格式：prompt_tokens_details.cached_tokens', () => {
    expect(extractUsageCache({ prompt_tokens_details: { cached_tokens: 456 } })).toEqual({ cacheReadTokens: 456, cacheWriteTokens: 0 })
  })

  it('两格式共存 → DeepSeek 优先（取其有值者）', () => {
    expect(extractUsageCache({ prompt_cache_hit_tokens: 111, prompt_tokens_details: { cached_tokens: 222 } })).toEqual({ cacheReadTokens: 111, cacheWriteTokens: 0 })
  })

  it('Anthropic 风格 cache_creation_input_tokens → cacheWrite', () => {
    expect(extractUsageCache({ prompt_tokens_details: { cache_creation_input_tokens: 999 } })).toEqual({ cacheReadTokens: 0, cacheWriteTokens: 999 })
  })

  it('无缓存字段 → 全 0（不抛错）', () => {
    expect(extractUsageCache({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({ cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(extractUsageCache(undefined)).toEqual({ cacheReadTokens: 0, cacheWriteTokens: 0 })
  })

  it('负数/非数值 → 0（防御）', () => {
    expect(extractUsageCache({ prompt_cache_hit_tokens: -5 })).toEqual({ cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(extractUsageCache({ prompt_cache_hit_tokens: 'abc' })).toEqual({ cacheReadTokens: 0, cacheWriteTokens: 0 })
  })
})
