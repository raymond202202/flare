/**
 * Agent trimContext 自动裁剪集成测试（v0.6.17）
 *
 * AgentConfig.maxContextMessages / maxContextTokens → Agent.run 迭代前自动裁剪。
 * 验证：配置生效（条数/预算裁剪）+ 默认行为零回归（不配置时仍保留最近 30 条）。
 * 使用 Mock LLM（不发起真实 API 调用），不动 Agent.run 核心循环。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Agent } from '../src/core/agent.js'
import type { Message, LLMResponse } from '../src/core/llm.js'
import { estimateMessagesTokens } from '../src/core/context.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/** Mock LLM：固定返回纯文本（无工具调用，一轮结束） */
class StaticLLM {
  async chat(messages: Message[]): Promise<LLMResponse> {
    return { content: '完成', model: 'mock', usage: { prompt_tokens: 10, completion_tokens: 5 } }
  }
  async *chatStream() {
    yield ''
  }
}

describe('Agent trimContext 自动裁剪（v0.6.17）', () => {
  let tempDir: string
  let originalHome: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flare-agent-trim-'))
    originalHome = process.env.FLARE_HOME
    process.env.FLARE_HOME = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.FLARE_HOME
    else process.env.FLARE_HOME = originalHome
  })

  /** 构造带 N 条历史消息的 Agent（system + 若干 user/assistant 交替） */
  function agentWithHistory(count: number, cfg: Record<string, unknown> = {}): Agent {
    const agent = new Agent({ llm: new StaticLLM() as never, maxIterations: 2, ...cfg })
    const history: Message[] = [{ role: 'system', content: '你是助手' }]
    for (let i = 0; i < count; i++) {
      history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `历史消息${i}` })
    }
    ;(agent as any).messages = history
    return agent
  }

  it('默认行为零回归：不配置时保留最近 30 条 + system 保底', async () => {
    const agent = agentWithHistory(45)
    const before = (agent as any).messages.length
    expect(before).toBe(46) // system + 45

    // run 触发迭代前 trimContext（Mock LLM 一轮结束）
    for await (const _ of agent.run('继续')) { /* 消费流 */ }

    const after = agent.getMessages()
    // system + 最近 30 条（含本轮 user）+ 本轮 assistant 回复
    expect(after.length).toBeLessThanOrEqual(32)
    expect(after[0].role).toBe('system')
    // 最新 user 输入保留
    expect(after.map(m => m.content)).toContain('继续')
  })

  it('maxContextMessages=5：迭代前裁剪到 system + 最近 5 条', async () => {
    const agent = agentWithHistory(20, { maxContextMessages: 5 })
    for await (const _ of agent.run('继续')) { /* 消费流 */ }
    const after = agent.getMessages()
    // system + 最近 5 条 + 本轮 assistant 回复
    expect(after.length).toBeLessThanOrEqual(7)
    expect(after[0].role).toBe('system')
    // 最新输入保留
    expect(after.map(m => m.content)).toContain('继续')
  })

  it('maxContextMessages=0：不按条数裁剪（仅当无 token 预算时全部保留）', async () => {
    const agent = agentWithHistory(40, { maxContextMessages: 0 })
    for await (const _ of agent.run('继续')) { /* 消费流 */ }
    const after = agent.getMessages()
    // 40 条历史 + 本轮 user + assistant 全部保留（条数裁剪关闭）
    expect(after.length).toBeGreaterThan(30)
  })

  it('maxContextTokens 预算：迭代前按 token 裁剪', async () => {
    const agent = agentWithHistory(15, { maxContextTokens: 60 })
    // 每条历史约 4(结构)+5(文本)≈9 token；15 条 ≈ 135+ token，远超 60 → 应裁剪
    for await (const _ of agent.run('继续')) { /* 消费流 */ }
    const after = agent.getMessages()
    // 预算内（容忍 system 保底 + 本轮追加后的轻微上浮；估算非精确）
    expect(estimateMessagesTokens(after)).toBeLessThanOrEqual(60 + 40)
    // 最新输入必须保留
    expect(after.map(m => m.content)).toContain('继续')
    expect(after[0].role).toBe('system')
  })

  it('maxContextTokens 极小预算：保底保留最新一条输入', async () => {
    const agent = agentWithHistory(10, { maxContextTokens: 5 })
    for await (const _ of agent.run('最新输入')) { /* 消费流 */ }
    const after = agent.getMessages()
    expect(after.length).toBeGreaterThanOrEqual(1)
    expect(after.map(m => m.content)).toContain('最新输入')
  })
})
