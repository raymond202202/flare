/**
 * 工具输出治理（v0.6.30）测试
 * 覆盖：truncateToolOutput 纯函数各策略 + Agent.run 集成（注入 mock 工具 + mock LLM）
 */
import { describe, it, expect } from 'vitest'
import { Agent } from '../src/index.js'
import { truncateToolOutput, toolOutputKind, DEFAULT_ELLIPSIS } from '../src/index.js'
import { Message, LLMResponse, ToolCall } from '../src/index.js'

// Mock LLM：按队列返回预设响应
class MockLLM {
  private queue: Array<{ content?: string; tool_calls?: ToolCall[] }> = []
  setResponses(responses: Array<{ content?: string; tool_calls?: ToolCall[] }>) {
    this.queue = [...responses]
  }
  async chat(messages: Message[]): Promise<LLMResponse> {
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

describe('toolOutputKind 分类', () => {
  it('探索型：read_file / search_files', () => {
    expect(toolOutputKind('read_file')).toBe('exploratory')
    expect(toolOutputKind('search_files')).toBe('exploratory')
  })
  it('终端型：terminal', () => {
    expect(toolOutputKind('terminal')).toBe('terminal')
  })
  it('其他工具 default（含空名）', () => {
    expect(toolOutputKind('write_file')).toBe('default')
    expect(toolOutputKind('memory_save')).toBe('default')
    expect(toolOutputKind('')).toBe('default')
  })
})

describe('truncateToolOutput 默认策略（零回归）', () => {
  it('成功输出前 2000 字符，与旧版 slice 逐字符一致', () => {
    const long = 'a'.repeat(5000)
    expect(truncateToolOutput('write_file', { success: true, output: long }))
      .toBe(long.slice(0, 2000))
  })
  it('短输出（≤预算）原样返回', () => {
    const short = 'hello world'
    expect(truncateToolOutput('write_file', { success: true, output: short })).toBe(short)
  })
  it('失败 error 前 1000 字符，与旧版 slice 逐字符一致', () => {
    const err = 'e'.repeat(3000)
    expect(truncateToolOutput('write_file', { success: false, error: err }))
      .toBe(err.slice(0, 1000))
  })
  it('失败且 error 缺省 → 执行失败', () => {
    expect(truncateToolOutput('write_file', { success: false })).toBe('执行失败')
  })
  it('成功且 output 缺省 → 空串', () => {
    expect(truncateToolOutput('write_file', { success: true })).toBe('')
  })
  it('maxOutputChars / maxErrorChars 可配', () => {
    expect(truncateToolOutput('write_file', { success: true, output: 'x'.repeat(500) }, { maxOutputChars: 100 })).toHaveLength(100)
    expect(truncateToolOutput('write_file', { success: false, error: 'e'.repeat(500) }, { maxErrorChars: 50 })).toHaveLength(50)
  })
})

describe('truncateToolOutput 探索型策略（读文件留头尾）', () => {
  it('短输出（≤预算）原样返回', () => {
    const short = '文件内容'
    expect(truncateToolOutput('read_file', { success: true, output: short })).toBe(short)
  })
  it('长输出：头部保留 + 省略标记（含被省略字符数）+ 尾部保留，总长不超预算', () => {
    const long = 'HEAD' + 'm'.repeat(5000) + 'TAIL'
    const out = truncateToolOutput('read_file', { success: true, output: long })
    expect(out.startsWith('HEAD')).toBe(true)
    expect(out.endsWith('TAIL')).toBe(true)
    expect(out).toContain('中间省略')
    expect(out).toMatch(/中间省略 \d+ 字符/) // 带被省略字符数（5008-1200-700=3108）
    expect(out.length).toBeLessThanOrEqual(2000)
  })
  it('search_files 同策略', () => {
    const long = 'A' + 'b'.repeat(3000) + 'Z'
    const out = truncateToolOutput('search_files', { success: true, output: long })
    expect(out.startsWith('A')).toBe(true)
    expect(out.endsWith('Z')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(2000)
  })
  it('headChars / tailChars 可配', () => {
    const long = 'H'.repeat(300) + 'm'.repeat(5000) + 'T'.repeat(300)
    const out = truncateToolOutput('read_file', { success: true, output: long }, { headChars: 300, tailChars: 300 })
    expect(out.startsWith('H'.repeat(300))).toBe(true)
    expect(out.endsWith('T'.repeat(300))).toBe(true)
    expect(out.length).toBeLessThanOrEqual(2000)
  })
  it('失败走错误分支（与默认策略一致）', () => {
    const err = 'e'.repeat(3000)
    expect(truncateToolOutput('read_file', { success: false, error: err })).toBe(err.slice(0, 1000))
  })
})

describe('truncateToolOutput 终端型策略（终端留尾部）', () => {
  it('短输出（≤预算）原样返回', () => {
    const short = 'command ok'
    expect(truncateToolOutput('terminal', { success: true, output: short })).toBe(short)
  })
  it('长输出：留尾部（最新结果/报错在末尾），省略标记在前，总长不超预算', () => {
    const long = 'NOISE'.repeat(1000) + '\nRESULT: build success'
    const out = truncateToolOutput('terminal', { success: true, output: long })
    expect(out.endsWith('RESULT: build success')).toBe(true)
    expect(out).toContain('中间省略')
    expect(out.length).toBeLessThanOrEqual(2000)
  })
  it('tailChars 可配', () => {
    const long = 'x'.repeat(5000) + 'END'
    const out = truncateToolOutput('terminal', { success: true, output: long }, { tailChars: 100 })
    expect(out.endsWith('END')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(2000)
  })
  it('失败走错误分支', () => {
    expect(truncateToolOutput('terminal', { success: false, error: '命令执行失败: boom' })).toBe('命令执行失败: boom')
  })
})

describe('truncateToolOutput 自定义省略标记', () => {
  it('无 {omitted} 的标记直接使用', () => {
    const long = 'a'.repeat(5000)
    const out = truncateToolOutput('read_file', { success: true, output: long }, { ellipsis: '[...]' })
    expect(out).toContain('[...]')
    expect(out.length).toBeLessThanOrEqual(2000)
  })
  it('自定义 {omitted} 模板被替换（终端型尾部 2000，省略 3000）', () => {
    const long = 'a'.repeat(5000)
    const out = truncateToolOutput('terminal', { success: true, output: long }, { ellipsis: '…({omitted})…' })
    expect(out).toContain('…(3000)…')
  })
  it('DEFAULT_ELLIPSIS 含占位符', () => {
    expect(DEFAULT_ELLIPSIS).toContain('{omitted}')
  })
})

describe('Agent.run 集成（v0.6.30 工具输出治理生效）', () => {
  it('read_file 超长输出进上下文：留头尾 + 省略标记', async () => {
    const longOutput = 'FILE_HEAD_' + 'x'.repeat(5000) + '_FILE_TAIL'
    const mockLLM = new MockLLM()
    mockLLM.setResponses([
      {
        tool_calls: [{
          id: 'call_read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"/tmp/x.txt"}' },
        }],
      },
      { content: '读完了' },
    ])
    const agent = new Agent({
      llm: mockLLM,
      maxIterations: 3,
      tools: [{
        definition: {
          type: 'function',
          function: { name: 'read_file', description: '读取文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
        },
        execute: () => ({ success: true, output: longOutput }),
      }],
    })

    const toolResults: string[] = []
    for await (const chunk of agent.run('读一下')) {
      if (chunk.type === 'tool_result') toolResults.push(chunk.content)
    }

    // tool_result 事件已治理
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0].startsWith('FILE_HEAD_')).toBe(true)
    expect(toolResults[0].endsWith('_FILE_TAIL')).toBe(true)
    expect(toolResults[0]).toContain('中间省略')
    expect(toolResults[0].length).toBeLessThanOrEqual(2000)

    // 进入 LLM 上下文的消息同样已治理
    const toolMsg = agent.getMessages().find(m => m.role === 'tool' && m.tool_call_id === 'call_read')
    expect(toolMsg).toBeTruthy()
    expect(typeof toolMsg!.content).toBe('string')
    expect((toolMsg!.content as string).startsWith('FILE_HEAD_')).toBe(true)
    expect((toolMsg!.content as string).endsWith('_FILE_TAIL')).toBe(true)
    expect((toolMsg!.content as string).length).toBeLessThanOrEqual(2000)
  })

  it('默认工具（非策略）超长输出仍为前 2000 字符（零回归）', async () => {
    const longOutput = 'D'.repeat(5000)
    const mockLLM = new MockLLM()
    mockLLM.setResponses([
      {
        tool_calls: [{
          id: 'call_other',
          type: 'function',
          function: { name: 'my_tool', arguments: '{}' },
        }],
      },
      { content: '完成' },
    ])
    const agent = new Agent({
      llm: mockLLM,
      maxIterations: 3,
      tools: [{
        definition: {
          type: 'function',
          function: { name: 'my_tool', description: '自定义工具', parameters: { type: 'object', properties: {} } },
        },
        execute: () => ({ success: true, output: longOutput }),
      }],
    })

    const toolResults: string[] = []
    for await (const chunk of agent.run('跑一下')) {
      if (chunk.type === 'tool_result') toolResults.push(chunk.content)
    }
    expect(toolResults[0]).toBe('D'.repeat(2000))
    expect(toolResults[0]).not.toContain('中间省略')
  })

  it('terminal 超长输出进上下文：留尾部', async () => {
    const longOutput = 'n'.repeat(3000) + '\nBUILD_OK'
    const mockLLM = new MockLLM()
    mockLLM.setResponses([
      {
        tool_calls: [{
          id: 'call_term',
          type: 'function',
          function: { name: 'terminal', arguments: '{"command":"make"}' },
        }],
      },
      { content: '构建成功' },
    ])
    const agent = new Agent({
      llm: mockLLM,
      maxIterations: 3,
      tools: [{
        definition: {
          type: 'function',
          function: { name: 'terminal', description: '执行命令', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
        },
        execute: () => ({ success: true, output: longOutput }),
      }],
    })

    const toolResults: string[] = []
    for await (const chunk of agent.run('构建')) {
      if (chunk.type === 'tool_result') toolResults.push(chunk.content)
    }
    expect(toolResults[0].endsWith('BUILD_OK')).toBe(true)
    expect(toolResults[0]).toContain('中间省略')
    expect(toolResults[0].length).toBeLessThanOrEqual(2000)
  })
})
