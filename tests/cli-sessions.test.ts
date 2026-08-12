import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { MemoryStore } from '../src/memory/store.js'
import Database from 'better-sqlite3'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'dist', 'cli', 'index.js')
const children: ChildProcess[] = []
let dir: string
let store: MemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-sessions-cli-'))
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

describe('flare sessions', () => {
  it('--limit 越界（0）报错退出码 1', async () => {
    const { code, stderr } = await runCli(['sessions', '--limit', '0'])
    expect(code).toBe(1)
    expect(stderr).toContain('--limit')
  }, 20000)
  it('无会话时提示暂无会话', async () => {
    const { code, stdout } = await runCli(['sessions'])
    expect(code).toBe(0)
    expect(stdout).toContain('暂无会话')
  }, 20000)
  it('创建会话并列出（含标题预览）', async () => {
    const s = store.createSession('你好，请介绍一下你自己')
    store.saveMessage(s, { role: 'user', content: '你好，请介绍一下你自己' })
    const { code, stdout } = await runCli(['sessions'])
    expect(code).toBe(0)
    expect(stdout).toContain('你好，请介绍一下你自己')
    expect(stdout).toContain(s.slice(0, 8))
  }, 20000)
  it('默认列出最近 10 个会话', async () => {
    for (let i = 0; i < 15; i++) {
      const s = store.createSession(`会话${i}`)
      store.saveMessage(s, { role: 'user', content: `内容${i}` })
    }
    const { code, stdout } = await runCli(['sessions'])
    expect(code).toBe(0)
    // 输出含标题行「💬 最近会话:」→ 排除后仅数会话行（默认 10 条）
    const lines = stdout.trim().split('\n').filter((l) => !l.includes('最近会话'))
    expect(lines.length).toBe(10)
  }, 20000)
  it('空会话标注（空会话）', async () => {
    store.createSession('空空如也')
    const { code, stdout } = await runCli(['sessions'])
    expect(code).toBe(0)
    expect(stdout).toContain('（空会话）')
  }, 20000)
  it('按更新时间倒序（最新在前）', async () => {
    const a = store.createSession('旧会话')
    store.saveMessage(a, { role: 'user', content: '旧内容' })
    const b = store.createSession('新会话')
    store.saveMessage(b, { role: 'user', content: '新内容' })
    // 秒级 datetime('now') 同秒顺序不稳定 → 直接打毫秒递增时间戳保证稳定（第八十七轮同款方案）
    const db = new Database(join(dir, 'flare.db'))
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('2026-08-12 10:00:00.100', a)
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('2026-08-12 10:00:01.200', b)
    db.close()
    const { code, stdout } = await runCli(['sessions'])
    expect(code).toBe(0)
    const idxA = stdout.indexOf('旧会话')
    const idxB = stdout.indexOf('新会话')
    expect(idxB).toBeGreaterThan(-1)
    expect(idxA).toBeGreaterThan(-1)
    expect(idxB).toBeLessThan(idxA)
  }, 20000)
})
