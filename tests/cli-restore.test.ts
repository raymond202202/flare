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
  dir = mkdtempSync(join(tmpdir(), 'flare-restore-cli-'))
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

describe('flare restore', () => {
  it('恢复归档会话：seed 归档 → restore → exit 0 + 归档列表不再含', async () => {
    store.saveMessage('sess-r1', { role: 'user', content: '归档测试消息' })
    expect(store.archiveSession('sess-r1')).toBe(true)
    const { code, stdout } = await runCli(['restore', 'sess-r1'])
    expect(code).toBe(0)
    expect(stdout).toContain('已恢复会话')
    expect(store.listArchivedSessions().some((s) => s.id === 'sess-r1')).toBe(false)
  }, 20000)

  it('恢复后重新出现在最近会话（archived=false）', async () => {
    store.saveMessage('sess-r2', { role: 'user', content: '归档测试消息' })
    store.archiveSession('sess-r2')
    const { code } = await runCli(['restore', 'sess-r2'])
    expect(code).toBe(0)
    const all = store.getAllSessions()
    expect(all.find((s) => s.id === 'sess-r2')?.archived).toBe(false)
  }, 20000)

  it('不存在会话 → exit 1 + 提示', async () => {
    const { code, stdout } = await runCli(['restore', 'sess-no-such'])
    expect(code).toBe(1)
    expect(stdout).toContain('不存在或未归档')
  }, 20000)

  it('未归档会话 restore → exit 1（幂等 false）', async () => {
    store.saveMessage('sess-r3', { role: 'user', content: '未归档' })
    const { code, stdout } = await runCli(['restore', 'sess-r3'])
    expect(code).toBe(1)
    expect(stdout).toContain('不存在或未归档')
  }, 20000)

  it('恢复后再次 restore → exit 1（已非归档）', async () => {
    store.saveMessage('sess-r4', { role: 'user', content: '归档测试消息' })
    store.archiveSession('sess-r4')
    await runCli(['restore', 'sess-r4'])
    const { code, stdout } = await runCli(['restore', 'sess-r4'])
    expect(code).toBe(1)
    expect(stdout).toContain('不存在或未归档')
  }, 20000)

  it('端到端：archived-sessions 列出 → restore → archived-sessions 不再列出', async () => {
    store.saveMessage('sess-r5', { role: 'user', content: '归档测试消息' })
    store.archiveSession('sess-r5')
    const before = await runCli(['archived-sessions'])
    expect(before.stdout).toContain('sess-r5')
    const { code } = await runCli(['restore', 'sess-r5'])
    expect(code).toBe(0)
    const after = await runCli(['archived-sessions'])
    expect(after.stdout).not.toContain('sess-r5')
  }, 20000)
})
