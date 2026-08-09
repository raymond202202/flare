/**
 * ConfirmationGate × server 集成测试（v0.6.1）
 *
 * 覆盖：
 * - wrapConfirmTools：名单过滤（命中包装 / 未命中原样 / 空名单关闭）
 * - Agent 真实循环 + 确认门：allow_once / deny / allow_session / 超时 deny
 *   （fake LLM 触发 memory_save 工具调用，进程内跑完整 agent.run）
 * - DEFAULT_CONFIRM_TOOLS 默认名单
 *
 * e2e（子进程）协议层测试在 server.test.ts（confirm_result 校验/静默）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Agent } from '../src/core/agent.js'
import type { LLMProvider, LLMResponse } from '../src/core/llm.js'
import { ConfirmationGate } from '../src/core/confirm.js'
import type { ConfirmDecision, Confirmer } from '../src/core/confirm.js'
import { wrapConfirmTools, DEFAULT_CONFIRM_TOOLS } from '../src/server.js'
import type { Tool } from '../src/tools/index.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tempDirs: string[] = []
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 写回类工具（模拟 memory_save 语义：写入数组；结果文案与真实工具一致） */
function makeSaveTool(saved: string[]): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'memory_save',
        description: '保存一条持久记忆',
        parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
      },
    },
    execute: async (args: any) => {
      saved.push(args.content)
      return { success: true, output: `已保存持久记忆：${args.content}` }
    },
  }
}

/** 只读类工具（默认不在确认名单内） */
function makeReadTool(): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'memory_search',
        description: '检索记忆',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    },
    execute: async () => ({ success: true, output: '未找到匹配' }),
  }
}

/** 顺序响应 fake LLM（chat 每次取下一个响应；用尽抛错防静默通过） */
function makeFakeLLM(responses: LLMResponse[]): LLMProvider {
  const queue = [...responses]
  return {
    async chat() {
      const r = queue.shift()
      if (!r) throw new Error('FakeLLM 响应用尽（测试设计错误：LLM 调用次数超出预期）')
      return r
    },
    async *chatStream() {
      yield ''
    },
  }
}

function toolCall(name: string, args: Record<string, unknown>): LLMResponse {
  return {
    content: '',
    model: 'fake',
    tool_calls: [{
      id: `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
  }
}

function textResponse(content: string): LLMResponse {
  return { content, model: 'fake' }
}

/** 跑一轮 Agent（fake LLM + 确认门包装的 memory_save） */
async function runAgentWithGate(confirmer: Confirmer, responses: LLMResponse[], gateOpts: { timeoutMs?: number } = {}) {
  const saved: string[] = []
  const gate = new ConfirmationGate({ confirmer, timeoutMs: gateOpts.timeoutMs ?? 30000 })
  const tools = wrapConfirmTools([makeSaveTool(saved), makeReadTool()], gate, DEFAULT_CONFIRM_TOOLS)
  const dir = mkdtempSync(join(tmpdir(), 'flare-confirm-agent-'))
  tempDirs.push(dir)
  const agent = new Agent({
    llm: makeFakeLLM(responses),
    tools,
    storage: join(dir, 'test.db'),
    sessionId: `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  })
  const chunks: { type: string; content: string; toolName?: string }[] = []
  for await (const c of agent.run('请保存这条记忆')) chunks.push(c as any)
  return { saved, chunks }
}

function toolResults(chunks: { type: string; toolName?: string; content: string }[]) {
  return chunks.filter(c => c.type === 'tool_result')
}

describe('wrapConfirmTools（server 确认门名单过滤）', () => {
  it('命中名单的工具被包装：执行前经 confirmer，deny 不执行原工具', async () => {
    const saved: string[] = []
    const confirmer = vi.fn<Confirmer>(() => 'deny')
    const gate = new ConfirmationGate({ confirmer })
    const wrapped = wrapConfirmTools([makeSaveTool(saved)], gate, DEFAULT_CONFIRM_TOOLS)
    expect(wrapped.length).toBe(1)
    const res = await wrapped[0].execute({ content: 'X' })
    expect(res.success).toBe(false)
    expect((res as any).denied).toBe(true)
    expect(saved.length).toBe(0)
    expect(confirmer).toHaveBeenCalledWith('memory_save', { content: 'X' })
  })

  it('未命中名单的工具原样：confirmer 不被调用', async () => {
    const confirmer = vi.fn<Confirmer>(() => 'deny')
    const gate = new ConfirmationGate({ confirmer })
    const wrapped = wrapConfirmTools([makeReadTool()], gate, DEFAULT_CONFIRM_TOOLS)
    const res = await wrapped[0].execute({ query: 'q' })
    expect(res.success).toBe(true)
    expect(confirmer).not.toHaveBeenCalled()
  })

  it('空名单 = 确认门关闭：全部工具原样（同一引用）', async () => {
    const gate = new ConfirmationGate({ confirmer: () => 'deny' })
    const tools = [makeSaveTool([]), makeReadTool()]
    const wrapped = wrapConfirmTools(tools, gate, [])
    expect(wrapped).toBe(tools)
  })

  it('DEFAULT_CONFIRM_TOOLS 默认名单包含写回类 memory_save', () => {
    expect(DEFAULT_CONFIRM_TOOLS).toContain('memory_save')
  })

  it('内置工具集经确认门：memory_save 被包装、只读工具不被包装（无 profile 场景防回归）', async () => {
    // server 无 profile 时 Agent 回退内置工具集——确认门必须同样生效（防绕过回归）
    const { tools: builtinTools } = await import('../src/index.js')
    const confirmer = vi.fn<Confirmer>(() => 'deny')
    const gate = new ConfirmationGate({ confirmer })
    const wrapped = wrapConfirmTools(builtinTools, gate, DEFAULT_CONFIRM_TOOLS)
    const names = wrapped.map(t => t.definition.function.name)
    expect(names).toContain('memory_save')
    expect(names).toContain('read_file')

    const saveTool = wrapped.find(t => t.definition.function.name === 'memory_save')!
    const res = await saveTool.execute({ content: '不应落库' })
    expect(res.success).toBe(false)
    expect((res as any).denied).toBe(true)
    expect(confirmer).toHaveBeenCalledWith('memory_save', { content: '不应落库' })

    const readTool = wrapped.find(t => t.definition.function.name === 'read_file')!
    expect(confirmer).toHaveBeenCalledTimes(1) // read_file 未被确认
    expect(readTool.definition.function.name).toBe('read_file')
  })
})

describe('Agent 循环 × 确认门集成（宿主弹窗确认流程）', () => {
  it('allow_once：确认后执行 → 记忆落库，结果喂回 AI', async () => {
    const confirmer = vi.fn<Confirmer>(() => 'allow_once')
    const { saved, chunks } = await runAgentWithGate(
      confirmer,
      [toolCall('memory_save', { content: '用户偏好深色主题' }), textResponse('已记住')],
    )
    expect(saved).toEqual(['用户偏好深色主题'])
    expect(confirmer).toHaveBeenCalledTimes(1)
    const tr = toolResults(chunks)
    expect(tr.length).toBe(1)
    expect(tr[0].toolName).toBe('memory_save')
    expect(tr[0].content).toContain('已保存')
  })

  it('deny：用户拒绝 → 原工具不执行，AI 收到拒绝提示', async () => {
    const confirmer = vi.fn<Confirmer>(() => 'deny')
    const { saved, chunks } = await runAgentWithGate(
      confirmer,
      [toolCall('memory_save', { content: '不应落库的内容' }), textResponse('好的')],
    )
    expect(saved.length).toBe(0)
    expect(confirmer).toHaveBeenCalledTimes(1)
    const tr = toolResults(chunks)
    expect(tr.length).toBe(1)
    expect(tr[0].content).toContain('拒绝')
  })

  it('allow_session：连续两次写回只确认一次（会话记忆化）', async () => {
    const confirmer = vi.fn<Confirmer>(() => 'allow_session')
    const { saved, chunks } = await runAgentWithGate(
      confirmer,
      [
        toolCall('memory_save', { content: '记忆A' }),
        toolCall('memory_save', { content: '记忆B' }),
        textResponse('完成'),
      ],
    )
    expect(saved).toEqual(['记忆A', '记忆B'])
    // 第二次调用命中 allow_session 记忆 → confirmer 只调一次
    expect(confirmer).toHaveBeenCalledTimes(1)
    const tr = toolResults(chunks)
    expect(tr.length).toBe(2)
  })

  it('超时：宿主未在时限内回 confirm_result → 安全 deny（timeout 标记，不落库）', async () => {
    // confirmer 永不 resolve（模拟宿主一直不回）；gate 短超时 50ms
    const confirmer = vi.fn<Confirmer>(() => new Promise<ConfirmDecision>(() => { /* 永不 resolve */ }))
    const { saved, chunks } = await runAgentWithGate(
      confirmer,
      [toolCall('memory_save', { content: '超时内容' }), textResponse('好的')],
      { timeoutMs: 50 },
    )
    expect(saved.length).toBe(0)
    expect(confirmer).toHaveBeenCalledTimes(1)
    const tr = toolResults(chunks)
    expect(tr.length).toBe(1)
    expect(tr[0].content).toContain('超时')
  })
})
