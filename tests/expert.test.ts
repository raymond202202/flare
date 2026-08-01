/**
 * M2 专家模式（Expert Profile）单元测试
 * 覆盖：工具注入生效、身份话术注入、独立存储隔离
 * 使用 Mock LLM，不发起真实 API 调用
 */
import { describe, it, expect } from 'vitest'
import { Agent, type Tool } from '../src/index.js'
import { Message, LLMResponse, ToolCall } from '../src/index.js'
import { mkdtempSync, rmSync, existsSync } from 'fs'
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
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }
  }

  async *chatStream() {
    yield ''
  }
}

describe('M2 专家模式（Expert Profile）', () => {
  it('工具注入：自定义工具可被 LLM 调用并执行', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'flare-expert-'))
    process.env.FLARE_HOME = tempDir

    let echoCalled = false
    const echoTool: Tool = {
      definition: {
        type: 'function',
        function: {
          name: 'echo_test',
          description: '回显参数内容',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: '要回显的文字' } },
            required: ['text'],
          },
        },
      },
      execute: async (args: any) => {
        echoCalled = true
        return { success: true, output: `echo:${args.text}` }
      },
    }

    const agent = new Agent({ tools: [echoTool], maxIterations: 1 })
    // 工具定义传给 LLM
    const toolNames = (agent as any).tools.map((t: any) => t.function.name)
    expect(toolNames).toContain('echo_test')

    // Mock LLM 调用自定义工具
    const mockLLM = new MockLLM()
    mockLLM.setResponses([{
      tool_calls: [{
        id: 'c1',
        type: 'function',
        function: { name: 'echo_test', arguments: '{"text":"hi"}' },
      }],
    }])
    ;(agent as any).llm = mockLLM

    let sawResult = false
    for await (const chunk of agent.run('测试工具')) {
      if (chunk.type === 'tool_result') {
        expect(chunk.content).toBe('echo:hi')
        sawResult = true
      }
    }
    expect(echoCalled).toBe(true)
    expect(sawResult).toBe(true)

    rmSync(tempDir, { recursive: true, force: true })
  })

  it('工具注入：不传 tools 时使用内置工具', () => {
    const agent = new Agent({ maxIterations: 1 })
    const toolNames = (agent as any).tools.map((t: any) => t.function.name)
    expect(toolNames).toEqual(expect.arrayContaining(['read_file', 'write_file', 'search_files', 'terminal']))
  })

  it('身份话术：identity 与 flareIntro 注入系统提示', () => {
    const agent = new Agent({
      identity: '我是 pulse 助手，是集成到 pulse 的 flare 网络专家',
      flareIntro: 'flare 是通用型 AI agent，完整版访问 https://github.com/raymond202202/flare',
      maxIterations: 1,
    })
    const sys = agent.getMessages()[0]
    expect(sys.content).toContain('我是 pulse 助手，是集成到 pulse 的 flare 网络专家')
    expect(sys.content).toContain('flare 是通用型 AI agent')
    expect(sys.content).toContain('https://github.com/raymond202202/flare')
  })

  it('存储隔离：storage 参数创建独立记忆库', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'flare-expert-'))
    const dbPath = join(tempDir, 'expert.db')

    const agent = new Agent({ storage: dbPath, sessionId: 'expert-session' })
    // 独立 db 文件已创建
    expect(existsSync(dbPath)).toBe(true)
    // store 是独立实例（非全局单例路径）
    const store = (agent as any).store
    expect(store).toBeTruthy()
    // 独立库可正常使用：创建会话 + 读写
    const sid = store.createSession('独立专家会话')
    store.saveMessage(sid, { role: 'user', content: '你好' })
    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('你好')

    rmSync(tempDir, { recursive: true, force: true })
  })
})
