/**
 * 上下文 token 估算纯函数测试（v0.5.6）
 *
 * estimateTokens / estimateMessagesTokens 是纯函数（无网络无依赖），
 * 离线确定性断言：空串 / 中文 / 英文 / 混合 / 消息结构开销 / 相对排序。
 */
import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  estimateMessagesTokens,
  IMAGE_TOKEN_COST,
  MESSAGE_STRUCTURE_TOKENS,
  TOOL_CALL_STRUCTURE_TOKENS,
} from '../src/core/context.js'
import type { Message } from '../src/core/llm.js'

describe('estimateTokens 文本估算', () => {
  it('空串 / 空内容 → 0', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('   ')).toBe(1) // 3 个非 CJK 字符 → ceil(3/4)=1
  })

  it('纯中文：1 字符 ≈ 1 token', () => {
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('记忆检索增强')).toBe(6)
  })

  it('纯英文：4 字符 ≈ 1 token（向上取整）', () => {
    expect(estimateTokens('hello')).toBe(2)      // 5/4 → ceil 2
    expect(estimateTokens('hello world')).toBe(3) // 11/4 → ceil 3
    expect(estimateTokens('a')).toBe(1)
  })

  it('中英混合：CJK 按字 + 非 CJK 按 4 字符', () => {
    // '测试 token 估算'：4 个 CJK（4 tokens）+ ' token ' 7 个非 CJK（ceil(7/4)=2）
    expect(estimateTokens('测试 token 估算')).toBe(4 + 2)
    // '你好abc'：2 CJK + 4 非 CJK = 2 + 1
    expect(estimateTokens('你好abc')).toBe(3)
  })

  it('长文本 > 短文本（相对排序稳定）', () => {
    const short = estimateTokens('短')
    const long = estimateTokens('这是一段明显更长的中文文本用于比较排序')
    expect(long).toBeGreaterThan(short)
  })
})

describe('estimateMessagesTokens 消息结构估算', () => {
  it('空数组 → 0', () => {
    expect(estimateMessagesTokens([])).toBe(0)
  })

  it('纯文本消息 = 结构开销 + 文本', () => {
    const msgs: Message[] = [{ role: 'user', content: '你好' }]
    expect(estimateMessagesTokens(msgs)).toBe(MESSAGE_STRUCTURE_TOKENS + 2)
  })

  it('system 提示 + user + assistant 多消息累加', () => {
    const msgs: Message[] = [
      { role: 'system', content: '你是 Flare' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！有什么可以帮你？' },
    ]
    const expected =
      MESSAGE_STRUCTURE_TOKENS + estimateTokens('你是 Flare') +
      MESSAGE_STRUCTURE_TOKENS + 2 +
      MESSAGE_STRUCTURE_TOKENS + estimateTokens('你好！有什么可以帮你？')
    expect(estimateMessagesTokens(msgs)).toBe(expected)
  })

  it('多模态图片 content：每张图 ≈ IMAGE_TOKEN_COST', () => {
    const msgs: Message[] = [{
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
      ],
    }]
    expect(estimateMessagesTokens(msgs)).toBe(MESSAGE_STRUCTURE_TOKENS + 2 + IMAGE_TOKEN_COST)
  })

  it('tool_calls 消息：每条 +3 + 函数名/参数文本', () => {
    const msgs: Message[] = [{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"/tmp/a.txt"}' },
      }],
    }]
    const expected =
      MESSAGE_STRUCTURE_TOKENS +
      TOOL_CALL_STRUCTURE_TOKENS +
      estimateTokens('read_file') +
      estimateTokens('{"path":"/tmp/a.txt"}')
    expect(estimateMessagesTokens(msgs)).toBe(expected)
  })

  it('tool 响应消息：tool_call_id + name 计入', () => {
    const msgs: Message[] = [{
      role: 'tool',
      tool_call_id: 'call_1',
      name: 'read_file',
      content: '文件内容',
    }]
    const expected =
      MESSAGE_STRUCTURE_TOKENS +
      estimateTokens('call_1') + estimateTokens('read_file') + estimateTokens('文件内容')
    expect(estimateMessagesTokens(msgs)).toBe(expected)
  })

  it('消息越多估算越大（上下文增长可观测）', () => {
    const one: Message[] = [{ role: 'user', content: '你好' }]
    const many: Message[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
      { role: 'user', content: '继续' },
    ]
    expect(estimateMessagesTokens(many)).toBeGreaterThan(estimateMessagesTokens(one))
  })
})
