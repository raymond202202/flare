/**
 * OpenAIProvider 采样控制透传测试（v0.6.3）
 *
 * mock openai SDK（不发起真实网络）：验证 maxTokens / temperature 透传到
 * chat.completions.create 请求体（max_tokens / temperature），缺省不传保持服务端默认。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }))

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: createMock } }
  },
}))

import { OpenAIProvider } from '../src/core/llm.js'

// chat 响应形状（仅 choices[0].message.content / tool_calls 被消费）
const CHAT_RESPONSE = {
  choices: [{ message: { content: 'hi', tool_calls: undefined } }],
  model: 'mock-model',
  usage: undefined,
}
// chatStream 响应形状（逐 chunk 的 delta.content）
const STREAM_RESPONSE = [{ choices: [{ delta: { content: 'a' } }] }, { choices: [{ delta: { content: 'b' } }] }]

beforeEach(() => {
  createMock.mockReset()
})

describe('OpenAIProvider 采样控制透传', () => {
  it('maxTokens + temperature → 请求体含 max_tokens / temperature（chat）', async () => {
    createMock.mockResolvedValue(CHAT_RESPONSE)
    const p = new OpenAIProvider({ model: 'qwen2.5:7b', maxTokens: 2048, temperature: 0.3 })
    await p.chat([{ role: 'user', content: 'hi' }])
    const body = createMock.mock.calls[0][0]
    expect(body.model).toBe('qwen2.5:7b')
    expect(body.max_tokens).toBe(2048)
    expect(body.temperature).toBe(0.3)
  })

  it('缺省不传 → 请求体不含 max_tokens / temperature（保持服务端默认）', async () => {
    createMock.mockResolvedValue(CHAT_RESPONSE)
    const p = new OpenAIProvider({ model: 'gpt-4o' })
    await p.chat([{ role: 'user', content: 'hi' }])
    const body = createMock.mock.calls[0][0]
    expect('max_tokens' in body).toBe(false)
    expect('temperature' in body).toBe(false)
  })

  it('temperature 0 也透传（0 是合法值，不能因 falsy 被丢弃）', async () => {
    createMock.mockResolvedValue(CHAT_RESPONSE)
    const p = new OpenAIProvider({ model: 'qwen2.5:7b', temperature: 0 })
    await p.chat([{ role: 'user', content: 'hi' }])
    const body = createMock.mock.calls[0][0]
    expect(body.temperature).toBe(0)
    expect('max_tokens' in body).toBe(false)
  })

  it('maxTokens + temperature → 请求体透传（chatStream）', async () => {
    createMock.mockResolvedValue(STREAM_RESPONSE)
    const p = new OpenAIProvider({ model: 'qwen2.5:7b', maxTokens: 1024, temperature: 1.5 })
    const chunks: string[] = []
    for await (const c of p.chatStream([{ role: 'user', content: 'hi' }])) {
      chunks.push(c)
    }
    expect(chunks.join('')).toBe('ab')
    const body = createMock.mock.calls[0][0]
    expect(body.max_tokens).toBe(1024)
    expect(body.temperature).toBe(1.5)
    expect(body.stream).toBe(true)
  })

  it('chatStream 缺省不传 → 请求体不含采样参数', async () => {
    createMock.mockResolvedValue(STREAM_RESPONSE)
    const p = new OpenAIProvider({ model: 'gpt-4o' })
    for await (const _ of p.chatStream([{ role: 'user', content: 'hi' }])) { /* 消费完 */ }
    const body = createMock.mock.calls[0][0]
    expect('max_tokens' in body).toBe(false)
    expect('temperature' in body).toBe(false)
  })
})
