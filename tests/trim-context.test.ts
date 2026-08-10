/**
 * trimContextMessages 上下文自动裁剪测试（v0.6.17，纯函数）
 *
 * Agent 内部安全裁剪策略（与 suggestTrim 的区别：保证不拆散 tool_calls ↔ tool 配对）：
 *   - system 保底 + 最近优先 + 配对保护 + 极小预算保底最新一条
 *   - maxMessages（条数上限，默认 30）/ maxTokens（token 预算）任一先到即停
 *   - 未超限返回原数组引用（零拷贝）
 */
import { describe, it, expect } from 'vitest'
import { trimContextMessages, estimateMessagesTokens } from '../src/core/context.js'
import type { Message, ToolCall } from '../src/core/llm.js'

function msg(role: Message['role'], content: string): Message {
  return { role, content }
}

function toolMsg(id: string, name = 'read_file', content = '结果'): Message {
  return { role: 'tool', tool_call_id: id, name, content }
}

function assistantToolMsg(id: string, content = '', extra?: { content?: string }): Message {
  const tc: ToolCall = { id, type: 'function', function: { name: 'read_file', arguments: '{}' } }
  return { role: 'assistant', content: extra?.content !== undefined ? extra.content : content, tool_calls: [tc] }
}

describe('trimContextMessages（上下文自动裁剪，纯函数）', () => {
  it('空消息 → 返回空', () => {
    expect(trimContextMessages([])).toEqual([])
    expect(trimContextMessages(undefined as unknown as Message[])).toEqual([])
  })

  it('未超限（条数与 token 均未达上限）→ 返回原数组引用（零拷贝）', () => {
    const messages = [msg('system', '你是助手'), msg('user', '你好'), msg('assistant', '你好！')]
    const r = trimContextMessages(messages, { maxMessages: 30 })
    expect(r).toBe(messages)
  })

  it('默认 maxMessages=30：超过 30 条 → 保留最近 30 条 + system 保底', () => {
    const messages = [msg('system', '你是助手')]
    for (let i = 0; i < 40; i++) {
      messages.push(msg(i % 2 === 0 ? 'user' : 'assistant', `消息${i}`))
    }
    const r = trimContextMessages(messages)
    // system 保底 + 最近 30 条
    expect(r[0].role).toBe('system')
    expect(r).toHaveLength(31)
    // 最新一条保留
    expect(r[r.length - 1].content).toBe('消息39')
    // 最早的非 system 消息被丢弃
    expect(r.find(m => m.content === '消息1')).toBeUndefined()
  })

  it('maxMessages 可配：较小上限 → 保留更少', () => {
    const messages = [msg('system', '你是助手')]
    for (let i = 0; i < 20; i++) messages.push(msg('user', `问题${i}`))
    const r = trimContextMessages(messages, { maxMessages: 5 })
    expect(r).toHaveLength(6) // system + 5
    expect(r[r.length - 1].content).toBe('问题19')
  })

  it('maxMessages=0 → 不按条数裁剪（仅按 token 预算；未配 token 预算则不裁剪）', () => {
    const messages = [msg('system', '你是助手')]
    for (let i = 0; i < 100; i++) messages.push(msg('user', `问题${i}`))
    const r = trimContextMessages(messages, { maxMessages: 0 })
    expect(r).toBe(messages) // 无 token 预算 → 零拷贝原引用
  })

  it('maxTokens 预算：按 token 裁剪（保留部分不超过预算）', () => {
    // system(8) + 3 条 20 字符中文（约 20 token/条 + 4 结构 = 24/条）
    const messages = [msg('system', '你是助手'), msg('user', '一二三四五六七八九十一二三四五六七八九十'), msg('user', '一二三四五六七八九十一二三四五六七八九十'), msg('user', '一二三四五六七八九十一二三四五六七八九十')]
    const budget = 8 + 24 + 24 // system + 最新 2 条
    const r = trimContextMessages(messages, { maxTokens: budget })
    expect(estimateMessagesTokens(r)).toBeLessThanOrEqual(budget)
    // 最新消息保留（AI 必须看到最新输入）
    expect(r[r.length - 1].content).toBe(messages[3].content)
  })

  it('maxTokens 极小预算 → 仍保底保留最新一条（AI 必须看到最新输入）', () => {
    const messages = [msg('system', '你是助手'), msg('user', '最新的问题在这里')]
    const r = trimContextMessages(messages, { maxTokens: 1 })
    expect(r.length).toBeGreaterThanOrEqual(1)
    expect(r[r.length - 1].content).toBe('最新的问题在这里')
  })

  it('maxTokens 与 maxMessages 任一先到即停（取更紧的）', () => {
    const messages = [msg('system', '你是助手')]
    for (let i = 0; i < 20; i++) messages.push(msg('user', `问题${i}中文内容`))
    // 条数上限 20（宽松）+ token 预算很小（紧）→ 按 token 停
    const r = trimContextMessages(messages, { maxMessages: 20, maxTokens: 50 })
    expect(estimateMessagesTokens(r)).toBeLessThanOrEqual(50)
    expect(r.length).toBeLessThan(21)
  })

  it('配对保护：tool 响应连带 assistant(tool_calls) 一起保留（不拆散）', () => {
    const messages = [
      msg('system', '你是助手'),
      msg('user', '第一轮问题'),
      assistantToolMsg('call_1', '', { content: '我来查一下' }),
      toolMsg('call_1', 'read_file', '第一轮结果'),
      msg('user', '第二轮问题'),
      assistantToolMsg('call_2', '', { content: '继续查' }),
      toolMsg('call_2', 'read_file', '第二轮结果'),
    ]
    // 条数上限很小，但配对必须完整：最新 user + assistant(tool_calls) + tool 一起保留
    const r = trimContextMessages(messages, { maxMessages: 3 })
    const contents = r.map(m => m.content || m.tool_call_id || '')
    expect(contents).toContain('第二轮问题')
    // tool 消息带 tool_call_id（call_2 被保留，配对未拆散）
    expect(r.some(m => m.tool_call_id === 'call_2')).toBe(true)
    // 配对完整性：每条 tool 响应前面有对应 assistant(tool_calls)
    const keptIds = new Set(r.filter(m => m.role === 'assistant' && m.tool_calls).flatMap(m => m.tool_calls!.map(tc => tc.id)))
    for (const m of r) {
      if (m.role === 'tool') expect(keptIds.has(m.tool_call_id!)).toBe(true)
    }
  })

  it('tail 是 tool 响应时向前找到它的 tool_calls 一起保留', () => {
    const messages = [
      msg('system', '你是助手'),
      msg('user', '问题'),
      assistantToolMsg('call_x'),
      toolMsg('call_x', 'read_file', '结果'),
    ]
    const r = trimContextMessages(messages, { maxMessages: 2 })
    // 最新是 tool → 必须连带 assistant(tool_calls) + user，不能只留 tool
    expect(r.filter(m => m.role === 'tool')).toHaveLength(1)
    expect(r.filter(m => m.role === 'assistant' && m.tool_calls)).toHaveLength(1)
    expect(r[r.length - 1].tool_call_id).toBe('call_x')
  })

  it('system 保底：即使预算极小 system 也保留', () => {
    const messages = [msg('system', '你是助手'), msg('user', '你好')]
    const r = trimContextMessages(messages, { maxTokens: 5 })
    expect(r[0].role).toBe('system')
  })
})
