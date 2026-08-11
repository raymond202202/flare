/**
 * 工具输出治理（v0.6.30）测试
 * 覆盖：truncateToolOutput 纯函数各策略 + Agent.run 集成（注入 mock 工具 + mock LLM）
 */
import { describe, it, expect } from 'vitest'
import { Agent } from '../src/index.js'
import { truncateToolOutput, toolOutputKind, DEFAULT_ELLIPSIS, validateToolOutputPolicy } from '../src/index.js'
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

describe('validateToolOutputPolicy 校验（v0.6.34，纯函数）', () => {
  it('合法完整对象 → ok 归一化（字段透传）', () => {
    const r = validateToolOutputPolicy({ maxOutputChars: 800, maxErrorChars: 500, headChars: 300, tailChars: 200, ellipsis: '[省略 {omitted}]' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual({ maxOutputChars: 800, maxErrorChars: 500, headChars: 300, tailChars: 200, ellipsis: '[省略 {omitted}]' })
    }
  })
  it('null/undefined → ok 空策略（等价缺省）', () => {
    expect(validateToolOutputPolicy(undefined).ok).toBe(true)
    expect(validateToolOutputPolicy(null).ok).toBe(true)
  })
  it('非对象（字符串/数组/数字/布尔）→ fail 含提示', () => {
    for (const bad of ['800', [1, 2], 800, true]) {
      const r = validateToolOutputPolicy(bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.message).toContain('必须是对象')
    }
  })
  it('整数字段非法值（0/-1/1.5/非数字）→ fail 含字段名', () => {
    for (const f of ['maxOutputChars', 'maxErrorChars', 'headChars', 'tailChars']) {
      for (const bad of [0, -1, 1.5, 'abc']) {
        const r = validateToolOutputPolicy({ [f]: bad })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toContain(f)
      }
    }
  })
  it('数字字符串可转（对齐既有 Number 转换风格）', () => {
    const r = validateToolOutputPolicy({ maxOutputChars: '800' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.maxOutputChars).toBe(800)
  })
  it('ellipsis 非字符串 → fail 含字段名', () => {
    const r = validateToolOutputPolicy({ ellipsis: 123 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('ellipsis')
  })
  it('未知字段忽略（宽松），空对象 ok', () => {
    const r = validateToolOutputPolicy({ foo: 'bar', maxOutputChars: 100 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ maxOutputChars: 100 })
  })
})

describe('Agent 集成：toolOutputPolicy 可配置（v0.6.34）', () => {
  it('终端型策略可配置：maxOutputChars/tailChars/ellipsis 生效（缺省默认策略零回归由既有用例覆盖）', async () => {
    const longOutput = 'x'.repeat(5000) + '\nTAIL_MARK'
    const mockLLM = new MockLLM()
    mockLLM.setResponses([
      {
        tool_calls: [{
          id: 'call_term2',
          type: 'function',
          function: { name: 'terminal', arguments: '{"command":"make"}' },
        }],
      },
      { content: '完成' },
    ])
    const agent = new Agent({
      llm: mockLLM,
      maxIterations: 3,
      toolOutputPolicy: { maxOutputChars: 300, tailChars: 150, ellipsis: '[省略]' },
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
    // 自定义省略标记在前（非默认「中间省略」）、尾部保留、总长 ≤ 预算 300
    expect(toolResults[0].startsWith('[省略]')).toBe(true)
    expect(toolResults[0].endsWith('TAIL_MARK')).toBe(true)
    expect(toolResults[0]).not.toContain('中间省略')
    expect(toolResults[0].length).toBeLessThanOrEqual(300)

    // 进入 LLM 上下文的消息同样按策略治理
    const toolMsg = agent.getMessages().find(m => m.role === 'tool' && m.tool_call_id === 'call_term2')
    expect(toolMsg).toBeTruthy()
    expect(typeof toolMsg!.content).toBe('string')
    expect((toolMsg!.content as string).startsWith('[省略]')).toBe(true)
    expect((toolMsg!.content as string).endsWith('TAIL_MARK')).toBe(true)
  })

  it('默认工具长度预算可配置：maxOutputChars 生效', async () => {
    const longOutput = 'y'.repeat(5000)
    const mockLLM = new MockLLM()
    mockLLM.setResponses([
      {
        tool_calls: [{
          id: 'call_cfg',
          type: 'function',
          function: { name: 'my_tool', arguments: '{}' },
        }],
      },
      { content: '完成' },
    ])
    const agent = new Agent({
      llm: mockLLM,
      maxIterations: 3,
      toolOutputPolicy: { maxOutputChars: 100 },
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
    expect(toolResults[0]).toBe('y'.repeat(100))
    expect(toolResults[0].length).toBeLessThanOrEqual(100)
  })
})
