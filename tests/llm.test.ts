/**
 * LLM provider 模型路由测试（v0.5.2）
 *
 * 纯函数 resolveProviderOptions 单测（无网络）：模型名 → 端点/密钥推导，
 * 覆盖 Ollama 本地模型 / DeepSeek / OpenAI / Claude 报错 / 配置覆盖。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { resolveProviderOptions } from '../src/core/llm.js'
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
    const r = resolveProviderOptions({ model: 'llama3.1:8b', apiKey: 'sk-local' })
    expect(r.baseURL).toBe('http://localhost:11434/v1')
    expect(r.apiKey).toBe('sk-local')
  })
})
