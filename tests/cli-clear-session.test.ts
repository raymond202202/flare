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
  dir = mkdtempSync(join(tmpdir(), 'flare-clear-session-cli-'))
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

describe('flare clear-session（清空会话消息，保留会话记录与用量）', () => {
  it('清空消息：消息删除、会话记录保留、用量保留', async () => {
    store.saveMessage('sess-c1', { role: 'user', content: '第一条' })
    store.saveMessage('sess-c1', { role: 'assistant', content: '第二条' })
    // 写入该会话的用量记录
    store.logUsage('sess-c1', 100, 50, 'gpt-4o')

    expect(store.getMessages('sess-c1').length).toBe(2)
    expect(store.getSessionUsage('sess-c1').callCount).toBe(1)

    const { code, stdout } = await runCli(['clear-session', 'sess-c1'])
    expect(code).toBe(0)
    expect(stdout).toContain('已清空会话')
    expect(stdout).toContain('sess-c1')

    // 消息被清空
    expect(store.getMessages('sess-c1').length).toBe(0)
    // 会话记录仍保留（最近会话列表仍含）
    expect(store.getAllSessions().some((s) => s.id === 'sess-c1')).toBe(true)
    // 用量仍保留
    expect(store.getSessionUsage('sess-c1').callCount).toBe(1)
  }, 20000)

  it('只清空目标会话，不影响其他会话', async () => {
    store.saveMessage('sess-c2', { role: 'user', content: '要被清空' })
    store.saveMessage('sess-other', { role: 'user', content: '保留消息' })
    const { code } = await runCli(['clear-session', 'sess-c2'])
    expect(code).toBe(0)
    expect(store.getMessages('sess-c2').length).toBe(0)
    expect(store.getMessages('sess-other').length).toBe(1)
  }, 20000)

  it('清空不存在的会话 → exit 0 幂等（删除 0 条）', async () => {
    const { code, stdout } = await runCli(['clear-session', 'sess-no-such'])
    expect(code).toBe(0)
    expect(stdout).toContain('已清空会话')
    expect(stdout).toContain('0 条')
  }, 20000)

  it('清空空会话ID → exit 1 + 会话ID不能为空', async () => {
    const { code, stdout } = await runCli(['clear-session', ''])
    expect(code).toBe(1)
    expect(stdout).toContain('会话ID不能为空')
  }, 20000)
})

describe('flare delete-session（整体删除会话）', () => {
  it('删除会话：消息、用量、会话记录全部移除', async () => {
    store.saveMessage('sess-d1', { role: 'user', content: '要删除的消息' })
    store.logUsage('sess-d1', 200, 80, 'gpt-4o')

    const { code, stdout } = await runCli(['delete-session', 'sess-d1'])
    expect(code).toBe(0)
    expect(stdout).toContain('已删除会话')

    // 会话记录被删除
    expect(store.getAllSessions().some((s) => s.id === 'sess-d1')).toBe(false)
    // 消息被删除（getMessages 应返回空）
    expect(store.getMessages('sess-d1').length).toBe(0)
    // 用量被删除
    expect(store.getSessionUsage('sess-d1').callCount).toBe(0)
  }, 20000)

  it('删除不存在的会话 → exit 1（幂等 false）', async () => {
    const { code, stdout } = await runCli(['delete-session', 'sess-no-such'])
    expect(code).toBe(1)
    expect(stdout).toContain('不存在')
  }, 20000)

  it('只删除目标会话，不影响其他会话', async () => {
    store.saveMessage('sess-d2', { role: 'user', content: '要被删除' })
    store.saveMessage('sess-keep', { role: 'user', content: '保留' })
    const { code } = await runCli(['delete-session', 'sess-d2'])
    expect(code).toBe(0)
    expect(store.getAllSessions().some((s) => s.id === 'sess-d2')).toBe(false)
    expect(store.getAllSessions().some((s) => s.id === 'sess-keep')).toBe(true)
  }, 20000)

  it('删除空会话ID → exit 1 + 会话ID不能为空', async () => {
    const { code, stdout } = await runCli(['delete-session', ''])
    expect(code).toBe(1)
    expect(stdout).toContain('会话ID不能为空')
  }, 20000)

  it('delete vs clear 对比：delete 后会话消失，clear 后会话仍在', async () => {
    // delete-session：会话记录移除
    store.saveMessage('sess-vs-d', { role: 'user', content: '删除' })
    const r1 = await runCli(['delete-session', 'sess-vs-d'])
    expect(r1.code).toBe(0)
    expect(store.getAllSessions().some((s) => s.id === 'sess-vs-d')).toBe(false)
    // clear-session：会话记录保留（仅消息清空）
    store.saveMessage('sess-vs-c', { role: 'user', content: '清空' })
    const r2 = await runCli(['clear-session', 'sess-vs-c'])
    expect(r2.code).toBe(0)
    expect(store.getAllSessions().some((s) => s.id === 'sess-vs-c')).toBe(true)
    expect(store.getMessages('sess-vs-c').length).toBe(0)
  }, 20000)
})
