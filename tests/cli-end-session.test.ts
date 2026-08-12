import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { MemoryStore } from '../src/memory/store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'dist', 'cli', 'index.js')

const children: ChildProcess[] = []
let dir: string
let store: MemoryStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-end-session-cli-'))
  store = new MemoryStore(join(dir, 'flare.db'))
})

afterEach(() => {
  store.close()
  for (const c of children.splice(0)) c.kill()
  rmSync(dir, { recursive: true, force: true })
})

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, FLARE_HOME: dir },
    })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('flare end-session', () => {
  it('归档会话：seed → end-session → exit 0 + 已归档', async () => {
    store.saveMessage('sess-e1', { role: 'user', content: '结束会话消息' })
    const { code, stdout } = await runCli(['end-session', 'sess-e1'])
    expect(code).toBe(0)
    expect(stdout).toContain('已归档会话')
    expect(store.listArchivedSessions().some((s) => s.id === 'sess-e1')).toBe(true)
  }, 20000)

  it('归档后消息与用量保留、从最近会话隐藏', async () => {
    store.saveMessage('sess-e2', { role: 'user', content: '保留消息验证' })
    const { code } = await runCli(['end-session', 'sess-e2'])
    expect(code).toBe(0)
    // 数据保留：消息仍可查到
    const msgs = store.getMessages('sess-e2')
    expect(msgs.some((m) => m.role === 'user' && m.content === '保留消息验证')).toBe(true)
    // 从最近会话隐藏
    expect(store.getAllSessions().find((s) => s.id === 'sess-e2')?.archived).toBe(true)
  }, 20000)

  it('不存在会话 → exit 1 + 提示', async () => {
    const { code, stdout } = await runCli(['end-session', 'sess-no-such'])
    expect(code).toBe(1)
    expect(stdout).toContain('不存在或已归档')
  }, 20000)

  it('已归档会话 end-session → exit 1（幂等 false）', async () => {
    store.saveMessage('sess-e3', { role: 'user', content: 'xxx' })
    store.archiveSession('sess-e3')
    const { code, stdout } = await runCli(['end-session', 'sess-e3'])
    expect(code).toBe(1)
    expect(stdout).toContain('不存在或已归档')
  }, 20000)

  it('端到端：sessions 列出 → end-session → archived-sessions 列出 → sessions 不再列出', async () => {
    store.saveMessage('sess-e4', { role: 'user', content: '归档测试消息' })
    const before = await runCli(['archived-sessions'])
    expect(before.stdout).not.toContain('sess-e4')
    const { code } = await runCli(['end-session', 'sess-e4'])
    expect(code).toBe(0)
    const archived = await runCli(['archived-sessions'])
    expect(archived.stdout).toContain('sess-e4')
  }, 20000)

  it('空 id → exit 1 + 会话ID不能为空', async () => {
    const { code, stdout } = await runCli(['end-session', '   '])
    expect(code).toBe(1)
    expect(stdout).toContain('会话ID不能为空')
  }, 20000)

  it('归档后 restore 恢复 → sessions 重新可见（归档管理闭环端到端）', async () => {
    store.saveMessage('sess-e5', { role: 'user', content: '闭环验证消息' })
    const { code } = await runCli(['end-session', 'sess-e5'])
    expect(code).toBe(0)
    const { code: code2 } = await runCli(['restore', 'sess-e5'])
    expect(code2).toBe(0)
    const all = store.getAllSessions()
    expect(all.find((s) => s.id === 'sess-e5')?.archived).toBe(false)
  }, 20000)

  it('不影响其他会话（其他会话仍在最近会话列表）', async () => {
    store.saveMessage('sess-e6', { role: 'user', content: '保留会话消息' })
    store.saveMessage('sess-e7', { role: 'user', content: '归档会话消息' })
    const { code } = await runCli(['end-session', 'sess-e7'])
    expect(code).toBe(0)
    const sessions = store.getAllSessions()
    expect(sessions.find((s) => s.id === 'sess-e6')?.archived).toBe(false)
    expect(sessions.find((s) => s.id === 'sess-e7')?.archived).toBe(true)
  }, 20000)
})
