/**
 * server 协议 confirm 事件带工具描述测试（v0.6.27）
 *
 * 覆盖：
 * - buildConfirmEvent：confirm 事件构造——工具描述可选带（宿主弹窗展示「AI 想做什么」）
 * - 向后兼容：无描述不输出 description 字段（JSON 序列化后无该 key，旧宿主忽略未知字段）
 * - args 缺省归一为 {}（与旧版一致）
 */
import { describe, it, expect } from 'vitest'
import { buildConfirmEvent } from '../src/server.js'

describe('buildConfirmEvent（confirm 事件带工具描述，v0.6.27）', () => {
  it('带描述：事件含 name/args/id/sessionId + description 字段', () => {
    const evt = buildConfirmEvent('s1', 'c_abc', 'memory_save', { content: 'hi' }, '保存一条持久记忆（跨会话长期记住）')
    expect(evt).toEqual({
      type: 'confirm',
      sessionId: 's1',
      id: 'c_abc',
      name: 'memory_save',
      args: { content: 'hi' },
      description: '保存一条持久记忆（跨会话长期记住）',
    })
  })

  it('不带描述：无 description 字段（向后兼容，JSON 序列化后无该 key）', () => {
    const evt = buildConfirmEvent('s1', 'c_abc', 'host_write', { data: 1 })
    expect(evt.description).toBeUndefined()
    const parsed = JSON.parse(JSON.stringify(evt)) as Record<string, unknown>
    expect('description' in parsed).toBe(false)
    // 其余字段不受影响
    expect(parsed.name).toBe('host_write')
    expect(parsed.args).toEqual({ data: 1 })
  })

  it('描述为空字符串 → 视为无描述（不输出字段）', () => {
    const evt = buildConfirmEvent('s1', 'c_x', 't', {}, '')
    expect(evt.description).toBeUndefined()
    expect('description' in JSON.parse(JSON.stringify(evt))).toBe(false)
  })

  it('args 缺省/空 → 归一为 {}（与旧版一致）', () => {
    const evt = buildConfirmEvent('s1', 'c_x', 't', undefined as unknown as Record<string, any>)
    expect(evt.args).toEqual({})
  })
})
