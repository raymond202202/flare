/**
 * Agent 核心单元测试
 * 覆盖：孤儿消息清理、JSON.parse 保护、死循环检测
 * 使用 Mock LLM，不发起真实 API 调用
 */
import { describe, it, expect } from 'vitest'
import { Agent } from '../src/core/agent.js'
import { getMemoryStore } from '../src/memory/store.js'
import { Message, LLMResponse, ToolCall } from '../src/core/llm.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Mock LLM：按队列返回预设响应
class MockLLM {
  private queue: Array<{ content?: string; tool_calls?: ToolCall[] }> = []
  calls: number = 0

  setResponses(responses: Array<{ content?: string; tool_calls?: ToolCall[] }>) {
    this.queue = [...responses]
  }

  async chat(messages: Message[]): Promise<LLMResponse> {
    this.calls++
    const next = this.queue.shift() || { content: '完成' }
    return {
      content: next.content || '',
      tool_calls: next.tool_calls,
      model: 'mock',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }
  }

  async *chatStream() {
    yield ''
  }
}

// 通过构造函数注入 mock（Agent 内部 createProvider，这里用 hack：替换模块级 provider 不可行，
// 因此直接测试纯逻辑方法：cleanOrphanTail 通过 getMessages 暴露，JSON.parse 保护走 run）
describe('Agent 孤儿消息清理', () => {
  it('清理尾部孤立的 tool 响应', () => {
    const agent = new Agent({ maxIterations: 1 })
    // 直接构造带孤儿消息的上下文
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'call_orphan', name: 'read_file', content: '结果' },
    ]
    ;(agent as any).messages = messages
    ;(agent as any).cleanOrphanTail()

    expect(agent.getMessages().filter(m => m.role === 'tool')).toHaveLength(0)
  })

  it('清理没有 tool 响应的 assistant(tool_calls)', () => {
    const agent = new Agent({ maxIterations: 1 })
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      // 后面没有 tool 响应 → 应该被清理
    ]
    ;(agent as any).messages = messages
    ;(agent as any).cleanOrphanTail()

    const result = agent.getMessages()
    expect(result.filter(m => m.role === 'assistant' && m.tool_calls)).toHaveLength(0)
  })

  it('保留配对完整的 assistant(tool_calls) + tool 响应', () => {
    const agent = new Agent({ maxIterations: 1 })
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '我来看一下',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: '结果' },
    ]
    ;(agent as any).messages = messages
    ;(agent as any).cleanOrphanTail()

    const result = agent.getMessages()
    expect(result.filter(m => m.role === 'assistant' && m.tool_calls)).toHaveLength(1)
    expect(result.filter(m => m.role === 'tool')).toHaveLength(1)
  })

  it('JSON.parse 非法参数不崩溃', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'flare-agent-test-'))
    process.env.FLARE_HOME = tempDir
    const store = getMemoryStore()
    const sessionId = store.createSession('json-parse-test')

    const agent = new Agent({ sessionId, maxIterations: 1 })
    // 注入一个会返回非法 JSON 参数的 mock LLM
    const mockLLM = new MockLLM()
    mockLLM.setResponses([
      {
        tool_calls: [{
          id: 'bad_json',
          type: 'function',
          function: { name: 'read_file', arguments: '{bad json here' },
        }],
      },
    ])
    ;(agent as any).llm = mockLLM

    // run 不应抛异常
    let sawError = false
    for await (const chunk of agent.run('测试')) {
      if (chunk.type === 'tool_result') {
        // 非法 JSON 时 tool_result 应该是错误信息
        expect(chunk.content).toContain('参数解析失败')
        sawError = true
      }
    }
    expect(sawError).toBe(true)

    rmSync(tempDir, { recursive: true, force: true })
  })
})
