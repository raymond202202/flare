/**
 * M2 专家模式（Expert Profile）单元测试
 * 覆盖：工具注入生效、身份话术注入、独立存储隔离
 * 使用 Mock LLM，不发起真实 API 调用
 */
import { describe, it, expect } from 'vitest'
import { Agent, MemoryStore, type Tool } from '../src/index.js'
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

  it('身份话术：identity 与 flareIntro 注入独立 system 消息（稳定前缀之后，v0.6.29）', () => {
    const agent = new Agent({
      identity: '我是 pulse 助手，是集成到 pulse 的 flare 网络专家',
      flareIntro: 'flare 是通用型 AI agent，完整版访问 https://github.com/raymond202202/flare',
      maxIterations: 1,
    })
    const sys = agent.getMessages().filter(m => m.role === 'system')
    // P0（v0.6.29）：身份拆成独立 system 消息（第二条），稳定前缀（第一条）不含身份
    expect(sys.length).toBeGreaterThanOrEqual(2)
    expect(sys[0].content).not.toContain('我是 pulse 助手') // 稳定前缀不被身份污染
    const identityMsg = sys.slice(1).find(m => typeof m.content === 'string' && m.content.includes('我是 pulse 助手'))
    expect(identityMsg).toBeTruthy()
    const content = String((identityMsg as any).content)
    expect(content).toContain('我是 pulse 助手，是集成到 pulse 的 flare 网络专家')
    expect(content).toContain('flare 是通用型 AI agent')
    expect(content).toContain('https://github.com/raymond202202/flare')
  })

  it('P0 前缀稳定：记忆变化不改变第一条 system（稳定前缀），只影响记忆 system（v0.6.29）', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'flare-prefix-'))
    const dbPath = join(tempDir, 'prefix.db')
    const store = new MemoryStore(dbPath)
    store.saveMemory('用户喜欢浅色主题', 'preference')

    const agent1 = new Agent({ storage: dbPath, maxIterations: 1 })
    const first1 = agent1.getMessages()[0]
    const memoryMsgs1 = agent1.getMessages().filter(m => m.role === 'system' && String(m.content).includes('## 关于这个用户'))

    // 记忆变化（新增一条）→ 重建 Agent
    store.saveMemory('用户喜欢深色主题', 'preference')
    const agent2 = new Agent({ storage: dbPath, maxIterations: 1 })
    const first2 = agent2.getMessages()[0]
    const memoryMsgs2 = agent2.getMessages().filter(m => m.role === 'system' && String(m.content).includes('## 关于这个用户'))

    // 稳定前缀完全一致（DeepSeek 前缀缓存可命中）；记忆 system 随记忆变化
    expect(first1.content).toBe(first2.content)
    expect(memoryMsgs1.length).toBe(1)
    expect(memoryMsgs2.length).toBe(1)
    expect(String(memoryMsgs2[0].content)).not.toBe(String(memoryMsgs1[0].content))

    rmSync(tempDir, { recursive: true, force: true })
  })

  it('setContext：当前状态作为独立 system 消息追加到末尾（不污染稳定前缀，v0.6.29）', () => {
    const agent = new Agent({ maxIterations: 1 })
    const stableBefore = agent.getMessages()[0]
    agent.setContext('宿主快照: 页面 A')
    const msgs = agent.getMessages()
    // 稳定前缀未被修改
    expect(msgs[0]).toBe(stableBefore)
    // 当前状态是独立 system 消息（消息末尾）
    const stateMsg = msgs[msgs.length - 1]
    expect(stateMsg.role).toBe('system')
    expect(String(stateMsg.content)).toContain('## 当前状态')
    expect(String(stateMsg.content)).toContain('宿主快照: 页面 A')
    // 重复调用替换（不累积）
    agent.setContext('宿主快照: 页面 B')
    const msgs2 = agent.getMessages()
    const stateMsgs = msgs2.filter(m => m.role === 'system' && String(m.content).startsWith('## 当前状态'))
    expect(stateMsgs).toHaveLength(1)
    expect(String(stateMsgs[0].content)).toContain('页面 B')
    // 清空移除
    agent.setContext('')
    expect(agent.getMessages().filter(m => String(m.content).startsWith('## 当前状态'))).toHaveLength(0)
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
