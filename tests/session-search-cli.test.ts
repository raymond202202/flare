/**
 * CLI /sessions <关键词> 会话搜索命令测试（v0.6.44）
 *
 * handleSlashCommand 是纯逻辑（store + output 注入），不依赖 TTY：
 * 验证 /sessions <关键词> 按标题/消息内容搜索（与 server search_sessions 同源 store 方法）、
 * 归档标记、无匹配提示、/sessions 无关键词原行为零回归、/help 注册。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/memory/store.js'
import { handleSlashCommand } from '../src/cli/index.js'

let store: MemoryStore
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-session-search-cli-'))
  store = new MemoryStore(join(dir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('/sessions <关键词> 会话搜索（v0.6.44）', () => {
  it('按标题匹配 → 列出搜索会话（标题 + 消息数）', async () => {
    const sid = store.createSession('flutter 集成指南')
    store.saveMessage(sid, { role: 'user', content: '聊聊 flutter 布局' })
    const lines: string[] = []
    const r = await handleSlashCommand('/sessions 集成', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    const out = lines.join('\n')
    expect(out).toContain('搜索会话「集成」')
    expect(out).toContain('flutter 集成指南')
    expect(out).toContain('(1 条消息)')
  })

  it('按消息内容匹配（标题不含关键词也命中）', async () => {
    const sid = store.createSession('普通标题')
    store.saveMessage(sid, { role: 'user', content: '深度讨论 prompt caching 前缀稳定策略' })
    store.createSession('不相关会话')
    const lines: string[] = []
    await handleSlashCommand('/sessions 前缀稳定', store, (s) => lines.push(s))
    const out = lines.join('\n')
    expect(out).toContain('普通标题')
    expect(out).not.toContain('不相关会话')
  })

  it('归档会话带（已归档）标记（仍可被搜到）', async () => {
    const sid = store.createSession('已归档的缓存调研')
    store.saveMessage(sid, { role: 'user', content: '内容也提缓存' })
    store.archiveSession(sid)
    const lines: string[] = []
    await handleSlashCommand('/sessions 缓存调研', store, (s) => lines.push(s))
    expect(lines.join('\n')).toContain('已归档的缓存调研')
    expect(lines.join('\n')).toContain('（已归档）')
  })

  it('无匹配 → 友好提示未找到，不报错', async () => {
    store.createSession('无关标题')
    const lines: string[] = []
    const r = await handleSlashCommand('/sessions 绝无此词xyz', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('未找到包含「绝无此词xyz」的会话')
  })

  it('/sessions 后只有空白 → 用法提示', async () => {
    const lines: string[] = []
    await handleSlashCommand('/sessions   ', store, (s) => lines.push(s))
    expect(lines.join('\n')).toContain('用法: /sessions <关键词>')
  })

  it('/sessions（无关键词）→ 原行为零回归（最近会话列表）', async () => {
    const sid = store.createSession('最近会话A')
    store.saveMessage(sid, { role: 'user', content: '首条消息' })
    const lines: string[] = []
    await handleSlashCommand('/sessions', store, (s) => lines.push(s))
    const out = lines.join('\n')
    expect(out).toContain('最近会话')
    expect(out).toContain('首条消息')
    expect(out).not.toContain('搜索会话「') // 未走搜索分支
  })

  it('/help 注册 /sessions 搜索说明', async () => {
    const lines: string[] = []
    await handleSlashCommand('/help', store, (s) => lines.push(s))
    const out = lines.join('\n')
    expect(out).toContain('/sessions')
    expect(out).toContain('搜索会话')
  })
})
