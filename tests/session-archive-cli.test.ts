/**
 * CLI 会话归档命令测试（v0.6.32）：/archived /archive /restore
 *
 * handleSlashCommand 是纯逻辑（store + output 注入），不依赖 TTY：
 * 验证 /archive 归档（缺省当前会话 / 指定 id / 幂等）、/restore 恢复（含无参列出）、
 * /archived 查看归档（含预览）、/help 注册；数据保留可恢复。
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
  dir = mkdtempSync(join(tmpdir(), 'flare-archive-cli-test-'))
  store = new MemoryStore(join(dir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('/archive 命令', () => {
  it('/archive <会话ID> → 归档成功：从最近会话隐藏、进归档列表、数据保留', async () => {
    const sid = store.createSession('归档目标')
    store.saveMessage(sid, { role: 'user', content: '归档首条消息' })
    const lines: string[] = []
    const r = await handleSlashCommand(`/archive ${sid}`, store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('已归档会话')
    // 从最近会话隐藏（与 server recent_sessions 语义一致）
    expect(store.getRecentSessions().map(s => s.id)).not.toContain(sid)
    // 进归档列表
    const archived = store.listArchivedSessions()
    expect(archived.map(s => s.id)).toContain(sid)
    // 数据保留
    expect(store.getMessages(sid).length).toBe(1)
  })

  it('/archive（无参数）→ 归档当前会话（sessionId 参数）', async () => {
    const sid = store.createSession('当前会话')
    const lines: string[] = []
    const r = await handleSlashCommand('/archive', store, (s) => lines.push(s), undefined, undefined, undefined, undefined, undefined, sid)
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('已归档会话')
    expect(store.listArchivedSessions().map(s => s.id)).toContain(sid)
  })

  it('/archive 无参数且无 sessionId → 用法提示', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/archive', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('用法: /archive')
  })

  it('/archive 不存在的会话 → 幂等黄色提示不报错', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/archive s-ghost', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    const out = lines.join('\n')
    expect(out).toContain('未归档')
    expect(out).toContain('s-ghost')
    expect(out).not.toContain('已归档会话')
  })

  it('重复归档同一会话 → 第二次幂等提示未归档', async () => {
    const sid = store.createSession('重复归档')
    const lines: string[] = []
    await handleSlashCommand(`/archive ${sid}`, store, (s) => lines.push(s))
    lines.length = 0
    const r = await handleSlashCommand(`/archive ${sid}`, store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('未归档')
  })
})

describe('/restore 命令', () => {
  it('/restore <会话ID> → 恢复成功：回最近会话、出归档列表', async () => {
    const sid = store.createSession('待恢复')
    store.archiveSession(sid)
    const lines: string[] = []
    const r = await handleSlashCommand(`/restore ${sid}`, store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('已恢复会话')
    expect(store.getRecentSessions().map(s => s.id)).toContain(sid)
    expect(store.listArchivedSessions().map(s => s.id)).not.toContain(sid)
  })

  it('/restore（无参数）→ 列出归档会话 + 用法提示', async () => {
    const sid = store.createSession('归档展示')
    store.saveMessage(sid, { role: 'user', content: '归档预览内容' })
    store.archiveSession(sid)
    const lines: string[] = []
    const r = await handleSlashCommand('/restore', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    const out = lines.join('\n')
    expect(out).toContain('归档会话')
    expect(out).toContain('归档预览内容')
    expect(out).toContain('/restore <会话ID>')
  })

  it('/restore（无参数）且无归档 → 用法提示', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/restore', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('用法: /restore <会话ID>')
  })

  it('/restore 不存在的会话 → 幂等黄色提示不报错', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/restore s-ghost', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    const out = lines.join('\n')
    expect(out).toContain('未恢复')
    expect(out).not.toContain('已恢复会话')
  })
})

describe('/archived 命令', () => {
  it('/archived → 列出归档会话（含首条消息预览与会话ID）', async () => {
    const sid = store.createSession('归档A')
    store.saveMessage(sid, { role: 'user', content: '归档A的首条消息' })
    store.archiveSession(sid)
    const lines: string[] = []
    const r = await handleSlashCommand('/archived', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    const out = lines.join('\n')
    expect(out).toContain('已归档会话')
    expect(out).toContain('归档A的首条消息')
    expect(out).toContain(sid)
    expect(out).toContain('/restore')
  })

  it('/archived 无归档 → 友好提示', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/archived', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('暂无归档会话')
  })

  it('/archived 只列归档：活跃会话不出现', async () => {
    const active = store.createSession('活跃会话')
    const archived = store.createSession('归档会话')
    store.archiveSession(archived)
    const lines: string[] = []
    await handleSlashCommand('/archived', store, (s) => lines.push(s))
    const out = lines.join('\n')
    expect(out).toContain('归档会话')
    expect(out).toContain(archived)
    expect(out).not.toContain(active)
  })
})

describe('/help 注册', () => {
  it('/help → 注册 /archived /archive /restore 三行', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/help', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    const out = lines.join('\n')
    expect(out).toContain('/archived')
    expect(out).toContain('/archive [会话ID]')
    expect(out).toContain('/restore <会话ID>')
  })
})
