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

/**
 * summarizeTrimmedMessages 上下文压缩摘要测试（v0.6.19，纯函数）
 *
 * 在 trimContextMessages 基础上：发生裁剪时把丢弃的历史压缩成摘要消息
 * （条数/角色分布/涉及工具/最后话题）而非直接丢弃——AI 保留话题连续性。
 * 纯启发式不调 LLM；摘要以 SUMMARY_MARKER 开头，下次裁剪可识别并合并覆盖（不堆积）。
 */
import { summarizeTrimmedMessages, buildSummaryText, SUMMARY_MARKER } from '../src/core/context.js'

describe('summarizeTrimmedMessages（上下文压缩摘要，纯函数）', () => {
  it('未裁剪（未超限）→ 返回原数组引用（零拷贝，与 trimContextMessages 契约一致）', () => {
    const messages = [msg('system', '你是助手'), msg('user', '你好'), msg('assistant', '你好！')]
    const r = summarizeTrimmedMessages(messages, { maxMessages: 30 })
    expect(r).toBe(messages)
  })

  it('裁剪发生时生成摘要：紧随 system 之后、以 marker 开头、含条数统计', () => {
    const messages = [msg('system', '你是助手')]
    for (let i = 0; i < 40; i++) messages.push(msg(i % 2 === 0 ? 'user' : 'assistant', `历史消息${i}`))
    const r = summarizeTrimmedMessages(messages, { maxMessages: 5 })
    // system + 摘要 + 保留 5 条
    expect(r[0].role).toBe('system')
    expect(r[1].role).toBe('system')
    expect(r[1].content).toContain(SUMMARY_MARKER)
    // 摘要含条数统计（40 条历史中裁掉 35 条）
    expect(r[1].content).toContain('35 条消息')
    // 保留部分：最新输入保留
    expect(r[r.length - 1].content).toBe('历史消息39')
  })

  it('摘要含角色分布与涉及工具（tool 响应 name + assistant.tool_calls 去重）', () => {
    const messages = [
      msg('system', '你是助手'),
      msg('user', '第一轮'),
      assistantToolMsg('call_1', '查文件', { content: '查文件' }),
      toolMsg('call_1', 'read_file', '结果A'),
      assistantToolMsg('call_2', '', { content: '再查' }),
      toolMsg('call_2', 'grep_search', '结果B'),
      msg('user', '最后一轮'),
      assistantToolMsg('call_3', '', { content: '' }),
      toolMsg('call_3', 'read_file', '结果C'),
    ]
    const r = summarizeTrimmedMessages(messages, { maxMessages: 2 })
    const summary = r[1].content
    expect(summary).toContain(SUMMARY_MARKER)
    // 涉及工具去重：read_file 出现两次只列一次
    expect(summary).toContain('read_file')
    expect(summary).toContain('grep_search')
    expect(summary).toContain('涉及工具')
    // 角色分布：tool 响应 2 条（call_3 配对被保留，未计入丢弃区）
    expect(summary).toContain('tool 2 条')
  })

  it('最后话题：最新被裁消息的内容片段（AI 衔接最近话题）', () => {
    const messages = [msg('system', '你是助手')]
    for (let i = 0; i < 20; i++) messages.push(msg('user', `早期问题${i}`), msg('assistant', `早期回答${i}`))
    messages.push(msg('assistant', '最后的回答（保留区）'))
    const r = summarizeTrimmedMessages(messages, { maxMessages: 3 })
    // 保留 3 条：最后的回答 + 早期回答19 + 早期问题19；最新被裁的文本消息是早期回答18
    expect(r[1].content).toContain('最后话题：早期回答18')
  })

  it('摘要链防堆积：旧摘要被识别并合并覆盖（多次裁剪不越滚越大）', () => {
    // 第一次裁剪：生成摘要 S1
    const messages = [msg('system', '你是助手')]
    for (let i = 0; i < 20; i++) messages.push(msg('user', `问题${i}`))
    const once = summarizeTrimmedMessages(messages, { maxMessages: 5 })
    const s1 = once[1].content
    expect(s1).toContain(SUMMARY_MARKER)
    expect(s1).toContain('15 条消息')

    // 第二次裁剪：S1 在丢弃区 → 合并进新摘要（新摘要含"更早历史"）
    const twice = summarizeTrimmedMessages(once, { maxMessages: 3 })
    const s2 = twice[1].content
    expect(s2).toContain(SUMMARY_MARKER)
    expect(s2).toContain('更早历史')
    // 新摘要覆盖旧摘要：数组中只有一条摘要消息（不堆积）
    const summaryCount = twice.filter((m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_MARKER)).length
    expect(summaryCount).toBe(1)
  })

  it('旧摘要在保留区时也被移除并以新摘要替代（不堆积）', () => {
    // 构造：S1 保留在 kept 区（裁剪后仍有它）且本次又发生裁剪
    const messages = [msg('system', '你是助手')]
    for (let i = 0; i < 20; i++) messages.push(msg('user', `问题${i}`))
    const once = summarizeTrimmedMessages(messages, { maxMessages: 15 })
    // once: system + S1 + 15 条
    expect(once.filter((m) => m.role === 'system')).toHaveLength(2)
    // 再次裁剪：S1 在保留区（15 条 < 18），但发生裁剪（裁掉 3 条）→ S1 被提取合并、新摘要替代
    const twice = summarizeTrimmedMessages(once, { maxMessages: 12 })
    const summaries = twice.filter((m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_MARKER))
    expect(summaries).toHaveLength(1)
    expect(summaries[0].content).toContain('更早历史')
  })

  it('maxChars 截断：超长摘要截断加省略号（防止摘要反噬上下文预算）', () => {
    const messages = [msg('system', '你是助手')]
    for (let i = 0; i < 30; i++) messages.push(msg('user', `这是一段比较长的话题内容${i}`))
    const r = summarizeTrimmedMessages(messages, { maxMessages: 3, maxChars: 60 })
    expect((r[1].content as string).length).toBeLessThanOrEqual(61)
    expect((r[1].content as string).endsWith('…')).toBe(true)
  })

  it('role 可配：role=user 时摘要以 user 消息呈现', () => {
    const messages = [msg('system', '你是助手')]
    for (let i = 0; i < 20; i++) messages.push(msg('user', `问题${i}`))
    const r = summarizeTrimmedMessages(messages, { maxMessages: 3, role: 'user' })
    expect(r[0].role).toBe('system')
    expect(r[1].role).toBe('user')
    expect(r[1].content).toContain(SUMMARY_MARKER)
  })

  it('includeTail:false → 不含最后话题片段', () => {
    const messages = [msg('system', '你是助手')]
    for (let i = 0; i < 20; i++) messages.push(msg('user', `问题${i}`))
    const r = summarizeTrimmedMessages(messages, { maxMessages: 3, includeTail: false })
    expect(r[1].content).not.toContain('最后话题')
  })

  it('无 system 消息时摘要放最前', () => {
    const messages: Message[] = []
    for (let i = 0; i < 10; i++) messages.push(msg('user', `问题${i}`))
    const r = summarizeTrimmedMessages(messages, { maxMessages: 3 })
    expect(r[0].role).toBe('system')
    expect(r[0].content).toContain(SUMMARY_MARKER)
    expect(r[1].content).toBe('问题7')
  })

  it('maxTools 限制：工具名最多列出 N 个并标注总数', () => {
    const messages = [msg('system', '你是助手')]
    for (let i = 0; i < 10; i++) {
      messages.push(assistantToolMsg(`call_${i}`, `步骤${i}`))
      messages.push(toolMsg(`call_${i}`, `tool_${i}`, '结果'))
    }
    messages.push(msg('user', '最后一问'))
    const r = summarizeTrimmedMessages(messages, { maxMessages: 2, maxTools: 3 })
    expect(r[1].content).toContain('tool_0')
    expect(r[1].content).toContain('等 10 个')
    // 只列出前 3 个（tool_3 不在列表里）
    expect(r[1].content).not.toContain('tool_3')
  })
})

describe('buildSummaryText（摘要文本组装，纯函数）', () => {
  it('基础统计行：条数 + 角色分布 + 估算 tokens', () => {
    const text = buildSummaryText({ droppedCount: 42, userCount: 20, assistantCount: 15, toolCount: 7, droppedTokens: 1234, tools: [] })
    expect(text).toContain(SUMMARY_MARKER)
    expect(text).toContain('42 条消息')
    expect(text).toContain('user 20 / assistant 15 / tool 7')
    expect(text).toContain('1234 tokens')
  })

  it('previousSummary 合并：更早历史行', () => {
    const text = buildSummaryText({ droppedCount: 5, userCount: 5, assistantCount: 0, toolCount: 0, droppedTokens: 100, tools: [], previousSummary: '更早的 30 条已被压缩' })
    expect(text).toContain('更早历史：更早的 30 条已被压缩')
  })
})
