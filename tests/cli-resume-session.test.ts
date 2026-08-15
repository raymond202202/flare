import { describe, it, expect } from 'vitest'
import { resolveStartSession } from '../src/cli/index.js'

// v0.6.147：每次开启新建会话（用户明确需求——不要恢复历史会话；
// 会话内多轮上下文由 Agent 实例复用天然保持，见 Agent 集成测试）
function fakeStore() {
  const created: string[] = []
  return {
    created,
    createSession: (title: string) => {
      created.push(title)
      return `new-${created.length}`
    },
  } as any
}

describe('resolveStartSession（每次开启新建会话，v0.6.147）', () => {
  it('始终新建「CLI 会话」（不恢复历史会话）', () => {
    const store = fakeStore()
    expect(resolveStartSession(store)).toBe('new-1')
    expect(store.created).toEqual(['CLI 会话'])
  })

  it('多次调用每次都新建（不同会话 id）', () => {
    const store = fakeStore()
    const a = resolveStartSession(store)
    const b = resolveStartSession(store)
    expect(a).not.toBe(b)
    expect(store.created).toEqual(['CLI 会话', 'CLI 会话'])
  })

  it('--new 参数无影响（语义一致：总是新建）', () => {
    const store = fakeStore()
    expect(resolveStartSession(store, { newSession: true })).toBe('new-1')
    expect(resolveStartSession(store, { newSession: false })).toBe('new-2')
  })
})
