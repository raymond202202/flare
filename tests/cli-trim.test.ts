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
  dir = mkdtempSync(join(tmpdir(), 'flare-trim-cli-'))
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

function seedSession(sid: string, count: number): void {
  for (let i = 1; i <= count; i++) {
    store.saveMessage(sid, {
      role: i % 2 === 1 ? 'user' : 'assistant',
      content: `这是一条用于测试上下文裁剪的会话消息，内容足够长以占用较多 token，编号 ${i}。`,
    })
  }
}

describe('flare trim', () => {
  it('不存在会话 → exit 1 + 提示', async () => {
    const { code, stderr } = await runCli(['trim', 'sess-no-such'])
    expect(code).toBe(1)
    expect(stderr).toContain('不存在或无消息')
  }, 20000)

  it('seed 15 条 + --budget 800 → exit 0 + 已裁剪 + store 持久删除', async () => {
    seedSession('sess-t2', 15)
    const { code, stdout } = await runCli(['trim', 'sess-t2', '--budget', '800'])
    expect(code).toBe(0)
    expect(stdout).toContain('已裁剪会话')
    // 端到端持久验证：CLI 进程退出后 store 已同步删除被裁消息
    const remaining = store.getMessages('sess-t2', 100000)
    expect(remaining.length).toBeLessThan(15)
  }, 20000)

  it('消息少未超预算 → exit 0 + 无需裁剪 + 数据不变（幂等）', async () => {
    seedSession('sess-t3', 3)
    const { code, stdout } = await runCli(['trim', 'sess-t3', '--budget', '5000'])
    expect(code).toBe(0)
    expect(stdout).toContain('无需裁剪')
    expect(store.getMessages('sess-t3', 100000).length).toBe(3)
  }, 20000)

  it('--budget 0 / abc → exit 1 + 必须是正整数', async () => {
    seedSession('sess-t4', 5)
    const r0 = await runCli(['trim', 'sess-t4', '--budget', '0'])
    expect(r0.code).toBe(1)
    expect(r0.stderr).toContain('必须是正整数')
    const ra = await runCli(['trim', 'sess-t4', '--budget', 'abc'])
    expect(ra.code).toBe(1)
    expect(ra.stderr).toContain('必须是正整数')
  }, 20000)

  it('空 id → exit 1 + 不能为空', async () => {
    const { code, stderr } = await runCli(['trim', ''])
    expect(code).toBe(1)
    expect(stderr).toContain('不能为空')
  }, 20000)

  it('不影响其他会话：trim A 后 B 消息全保留', async () => {
    seedSession('sess-ta', 15)
    seedSession('sess-tb', 15)
    const { code } = await runCli(['trim', 'sess-ta', '--budget', '800'])
    expect(code).toBe(0)
    expect(store.getMessages('sess-tb', 100000).length).toBe(15)
    expect(store.getMessages('sess-ta', 100000).length).toBeLessThan(15)
  }, 20000)

  it('保底保留：极端小预算下最早消息被删、最后一条 user 消息仍保留', async () => {
    seedSession('sess-t7', 15)
    const { code, stdout } = await runCli(['trim', 'sess-t7', '--budget', '400'])
    expect(code).toBe(0)
    expect(stdout).toContain('已裁剪会话')
    const remaining = store.getMessages('sess-t7', 100000)
    // 最早的 seed 消息已被删除（用带句号的精确子串，避免误匹配「编号 15」）
    expect(remaining.some((m) => typeof m.content === 'string' && m.content.includes('编号 1。'))).toBe(false)
    // 最后一条 user 消息（编号 15）仍保留（最近消息保底）
    expect(remaining.some((m) => typeof m.content === 'string' && m.content.includes('编号 15。'))).toBe(true)
  }, 20000)
})
