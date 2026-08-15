import { describe, it, expect } from 'vitest'
import { resolveStartSession } from '../src/cli/index.js'

// v0.6.145：交互模式聊天记录保留在窗口中——启动自动恢复最近会话
// v0.6.146：优先恢复用户交互会话（标题「CLI 会话」），跳过 cron/测试/单次查询会话
function fakeStore(
  sessions: { id: string; title?: string; msgs: number }[],
) {
  const created: string[] = []
  const byId = new Map(sessions.map(s => [s.id, s]))
  return {
    created,
    getRecentSessions: () => sessions.map(({ id, title }) => ({ id, title: title ?? '' })),
    getMessages: (id: string) => {
      const s = byId.get(id)
      return s ? Array.from({ length: s.msgs }, (_, i) => ({ role: 'user', content: `m${i}` })) : []
    },
    createSession: (title: string) => {
      created.push(title)
      return `new-${created.length}`
    },
  } as any
}

describe('resolveStartSession（聊天记录保留：启动恢复最近会话，v0.6.145/146）', () => {
  it('优先恢复最近的「CLI 会话」（用户交互对话，即使有其他更新的测试会话）', () => {
    const store = fakeStore([
      { id: 'sess-test', title: 'json-parse-t', msgs: 9 },   // 更新的测试会话
      { id: 'sess-cli', title: 'CLI 会话', msgs: 8 },        // 用户交互会话
    ])
    expect(resolveStartSession(store)).toBe('sess-cli')
    expect(store.created.length).toBe(0)
  })

  it('无「CLI 会话」→ 兜底恢复最近任意有消息会话', () => {
    const store = fakeStore([
      { id: 'sess-test', title: '单次查询', msgs: 4 },
      { id: 'sess-empty', title: 'CLI 会话', msgs: 0 },      // 空 CLI 会话不选
    ])
    expect(resolveStartSession(store)).toBe('sess-test')
  })

  it('全空会话 → 新建「CLI 会话」', () => {
    const store = fakeStore([{ id: 'sess-empty', title: 'CLI 会话', msgs: 0 }])
    expect(resolveStartSession(store)).toBe('new-1')
    expect(store.created).toEqual(['CLI 会话'])
  })

  it('--new 强制新建（即使有用户会话）', () => {
    const store = fakeStore([{ id: 'sess-cli', title: 'CLI 会话', msgs: 8 }])
    expect(resolveStartSession(store, { newSession: true })).toBe('new-1')
    expect(store.created).toEqual(['CLI 会话'])
  })

  it('无任何会话 → 新建「CLI 会话」', () => {
    const store = fakeStore([])
    expect(resolveStartSession(store)).toBe('new-1')
    expect(store.created).toEqual(['CLI 会话'])
  })
})
