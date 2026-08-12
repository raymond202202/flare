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
  it('--json：合法 JSON + sessionId + messageCount（agent 数据源含 system 前缀，>= seed 数）+ 无 suggestion', async () => {
    store.saveMessage('sess-j1', { role: 'user', content: '第一条用户消息' })
    store.saveMessage('sess-j1', { role: 'assistant', content: '回复内容甲' })
    store.saveMessage('sess-j1', { role: 'user', content: '第二条用户消息' })
    const { code, stdout } = await runCli(['context-status', 'sess-j1', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.sessionId).toBe('sess-j1')
    expect(parsed.messageCount).toBeGreaterThanOrEqual(3)
    expect(typeof parsed.estimatedTokens).toBe('number')
    expect(parsed.suggestion).toBeUndefined()
  }, 20000)
  it('--json --budget：suggestion 含 keepIndexes（数字数组、与 droppedCount/messageCount 自洽）', async () => {
    for (let i = 1; i <= 15; i++) {
      store.saveMessage('sess-j2', {
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: '这是一条用于测试上下文裁剪建议的会话消息，内容足够长以占用较多 token，编号 ' + i + '。',
      })
    }
    const { code, stdout } = await runCli(['context-status', 'sess-j2', '--json', '--budget', '200'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.suggestion).toBeDefined()
    const s = parsed.suggestion
    expect(s.droppedCount).toBeGreaterThan(0)
    expect(Array.isArray(s.keepIndexes)).toBe(true)
    expect(s.keepIndexes.length).toBe(parsed.messageCount - s.droppedCount)
    for (const idx of s.keepIndexes) {
      expect(Number.isInteger(idx)).toBe(true)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(parsed.messageCount)
    }
    expect(typeof s.estimatedKeptTokens).toBe('number')
    expect(typeof s.estimatedDroppedTokens).toBe('number')
  }, 20000)
  it('--json --budget 0 / abc → exit 1 + 必须是正整数', async () => {
    store.saveMessage('sess-j3', { role: 'user', content: '任意消息' })
    const r0 = await runCli(['context-status', 'sess-j3', '--json', '--budget', '0'])
    expect(r0.code).toBe(1)
    expect(r0.stderr).toContain('必须是正整数')
    const ra = await runCli(['context-status', 'sess-j3', '--json', '--budget', 'abc'])
    expect(ra.code).toBe(1)
    expect(ra.stderr).toContain('必须是正整数')
  }, 20000)
  it('--json 输出与文本模式互斥：无 --json 时文本格式不变', async () => {
    store.saveMessage('sess-j4', { role: 'user', content: '文本模式消息' })
    const { code, stdout } = await runCli(['context-status', 'sess-j4'])
    expect(code).toBe(0)
    expect(stdout).toContain('上下文占用')
    expect(stdout).toContain('消息数: 1')
    // 文本模式输出不应是 JSON 对象
    expect(() => JSON.parse(stdout)).toThrow()
  }, 20000)
})
