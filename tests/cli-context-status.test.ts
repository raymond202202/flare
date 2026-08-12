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
  dir = mkdtempSync(join(tmpdir(), 'flare-ctx-cli-'))
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
describe('flare context-status', () => {
  it('空会话：消息数 0 与估算 tokens 0', async () => {
    store.createSession('default')
    const { code, stdout } = await runCli(['context-status'])
    expect(code).toBe(0)
    expect(stdout).toContain('会话 default 上下文占用')
    expect(stdout).toContain('消息数: 0')
    expect(stdout).toContain('估算 tokens: 0')
  }, 20000)
  it('指定会话：消息数与估算 tokens 正确', async () => {
    store.saveMessage('sess-x', { role: 'user', content: '第一条用户消息' })
    store.saveMessage('sess-x', { role: 'assistant', content: '回复内容甲' })
    store.saveMessage('sess-x', { role: 'user', content: '第二条用户消息' })
    const { code, stdout } = await runCli(['context-status', 'sess-x'])
    expect(code).toBe(0)
    expect(stdout).toContain('会话 sess-x 上下文占用')
    expect(stdout).toContain('消息数: 3')
    expect(stdout).toContain('估算 tokens:')
    expect(stdout).not.toContain('估算 tokens: 0')
  }, 20000)
  it('无参数默认会话 default', async () => {
    store.saveMessage('default', { role: 'user', content: '默认会话消息' })
    const { code, stdout } = await runCli(['context-status'])
    expect(code).toBe(0)
    expect(stdout).toContain('会话 default 上下文占用')
    expect(stdout).toContain('消息数: 1')
  }, 20000)
  it('--budget 附裁剪建议（多消息可裁剪）', async () => {
    for (let i = 1; i <= 10; i++) {
      store.saveMessage('sess-y', { role: 'user', content: '第' + i + '条用户消息内容' })
    }
    const { code, stdout } = await runCli(['context-status', 'sess-y', '--budget', '5'])
    expect(code).toBe(0)
    expect(stdout).toContain('裁剪建议')
    expect(stdout).toContain('保留:')
    expect(stdout).toContain('可裁剪:')
    expect(stdout).toContain('条（估算')
  }, 20000)
  it('非法 --budget 退出码 1', async () => {
    for (const bad of ['0', '-5', 'abc']) {
      const { code, stderr } = await runCli(['context-status', '--budget', bad])
      expect(code).toBe(1)
      expect(stderr).toContain('--budget')
    }
  }, 20000)
  it('空会话 + --budget：保留 0 可裁剪 0', async () => {
    const { code, stdout } = await runCli(['context-status', 'sess-z', '--budget', '100'])
    expect(code).toBe(0)
    expect(stdout).toContain('保留: 0 条')
    expect(stdout).toContain('可裁剪: 0 条')
  }, 20000)
})
