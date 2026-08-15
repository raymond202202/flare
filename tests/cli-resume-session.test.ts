import { describe, it, expect } from 'vitest'
import { resolveStartSession } from '../src/cli/index.js'

// v0.6.145：交互模式聊天记录保留在窗口中——启动自动恢复最近会话
function fakeStore(overrides: Partial<{ recent: { id: string }[] }> = {}) {
  const created: string[] = []
  return {
    created,
    getRecentSessions: () => overrides.recent ?? [],
    createSession: (title: string) => {
      created.push(title)
      return `new-${created.length}`
    },
  } as any
}

describe('resolveStartSession（聊天记录保留：启动恢复最近会话，v0.6.145）', () => {
  it('有最近会话 → 恢复最近（不新建）', () => {
    const store = fakeStore({ recent: [{ id: 'sess-1' }, { id: 'sess-0' }] })
    expect(resolveStartSession(store)).toBe('sess-1')
    expect(store.created.length).toBe(0)
  })

  it('无最近会话 → 新建「CLI 会话」', () => {
    const store = fakeStore()
    expect(resolveStartSession(store)).toBe('new-1')
    expect(store.created).toEqual(['CLI 会话'])
  })

  it('--new 强制新建（即使有最近会话）', () => {
    const store = fakeStore({ recent: [{ id: 'sess-1' }] })
    expect(resolveStartSession(store, { newSession: true })).toBe('new-1')
    expect(store.created).toEqual(['CLI 会话'])
  })
})
