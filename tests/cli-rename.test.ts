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
  dir = mkdtempSync(join(tmpdir(), 'flare-rename-cli-'))
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

describe('flare rename', () => {
  it('重命名会话：seed 会话 → rename → exit 0 + store 标题更新', async () => {
    store.saveMessage('sess-n1', { role: 'user', content: '重命名测试' })
    const { code, stdout } = await runCli(['rename', 'sess-n1', '新标题A'])
    expect(code).toBe(0)
    expect(stdout).toContain('已重命名会话')
    expect(stdout).toContain('新标题A')
    const all = store.getAllSessions()
    expect(all.find((s) => s.id === 'sess-n1')?.title).toBe('新标题A')
  }, 20000)

  it('标题首尾空格被 trim', async () => {
    store.saveMessage('sess-n2', { role: 'user', content: '重命名测试' })
    const { code } = await runCli(['rename', 'sess-n2', ' 修剪标题 '])
    expect(code).toBe(0)
    const all = store.getAllSessions()
    expect(all.find((s) => s.id === 'sess-n2')?.title).toBe('修剪标题')
  }, 20000)

  it('空标题 → exit 1 + 提示，标题不变', async () => {
    store.saveMessage('sess-n3', { role: 'user', content: '重命名测试' })
    const { code, stdout } = await runCli(['rename', 'sess-n3', ' '])
    expect(code).toBe(1)
    expect(stdout).toContain('标题不能为空')
    const all = store.getAllSessions()
    expect(all.find((s) => s.id === 'sess-n3')?.title).toBe('新会话')
  }, 20000)

  it('重命名后 sessions 命令显示新标题（端到端）', async () => {
    store.saveMessage('sess-n4', { role: 'user', content: '重命名测试' })
    await runCli(['rename', 'sess-n4', '端到端标题'])
    const { code, stdout } = await runCli(['sessions'])
    expect(code).toBe(0)
    expect(stdout).toContain('端到端标题')
  }, 20000)

  it('UPSERT 语义：会话不存在也创建（与 server rename_session 一致）', async () => {
    const { code } = await runCli(['rename', 'sess-n5', '新建标题'])
    expect(code).toBe(0)
    const all = store.getAllSessions()
    expect(all.find((s) => s.id === 'sess-n5')?.title).toBe('新建标题')
  }, 20000)

  it('中文标题支持', async () => {
    store.saveMessage('sess-n6', { role: 'user', content: '重命名测试' })
    const { code, stdout } = await runCli(['rename', 'sess-n6', '中文标题测试'])
    expect(code).toBe(0)
    expect(stdout).toContain('中文标题测试')
    const all = store.getAllSessions()
    expect(all.find((s) => s.id === 'sess-n6')?.title).toBe('中文标题测试')
  }, 20000)
})
