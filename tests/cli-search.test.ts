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
  dir = mkdtempSync(join(tmpdir(), 'flare-search-cli-'))
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
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString()
    })
    child.on('close', (code) => resolve({ code, stdout: out, stderr: err }))
  })
}
describe('flare search（v0.6.85）', () => {
  it('按标题命中 → 列出会话（标题 + 条数 + 搜索摘要）', async () => {
    const sid = store.createSession('flutter 集成指南')
    store.saveMessage(sid, { role: 'user', content: '聊聊布局' })
    const { code, stdout } = await runCli(['search', '集成'])
    expect(code).toBe(0)
    expect(stdout).toContain('搜索会话「集成」')
    expect(stdout).toContain('flutter 集成指南')
    expect(stdout).toContain('1 条消息')
  }, 20000)
  it('按消息内容命中（标题不含关键词也命中）', async () => {
    const sid = store.createSession('普通标题')
    store.saveMessage(sid, { role: 'user', content: '深度讨论 prompt caching 前缀稳定策略' })
    store.createSession('不相关会话')
    const { code, stdout } = await runCli(['search', '前缀稳定'])
    expect(code).toBe(0)
    expect(stdout).toContain('普通标题')
    expect(stdout).not.toContain('不相关会话')
  }, 20000)
  it('无匹配 → 「未找到包含」', async () => {
    store.createSession('无关标题')
    const { code, stdout } = await runCli(['search', '绝无此词xyz'])
    expect(code).toBe(0)
    expect(stdout).toContain('未找到包含「绝无此词xyz」')
  }, 20000)
  it('--limit 1 只显示 1 个会话', async () => {
    const a = store.createSession('缓存调研A')
    store.saveMessage(a, { role: 'user', content: '内容也提缓存' })
    const b = store.createSession('缓存调研B')
    store.saveMessage(b, { role: 'user', content: '内容也提缓存' })
    const { code, stdout } = await runCli(['search', '缓存', '--limit', '1'])
    expect(code).toBe(0)
    expect(stdout).toContain('（1 个')
    const lines = stdout.split('\n').filter((l) => l.includes('条消息)'))
    expect(lines.length).toBe(1)
  }, 20000)
  it('非法 --limit（0/101/abc）→ 退出码 1 + 提示含 1~100', async () => {
    for (const bad of ['0', '101', 'abc']) {
      const { code, stderr } = await runCli(['search', 'kw', '--limit', bad])
      expect(code).toBe(1)
      expect(stderr).toContain('1~100')
    }
  }, 20000)
  it('归档会话带（已归档）标记', async () => {
    const sid = store.createSession('已归档的缓存调研')
    store.saveMessage(sid, { role: 'user', content: '内容也提缓存' })
    store.archiveSession(sid)
    const { code, stdout } = await runCli(['search', '缓存调研'])
    expect(code).toBe(0)
    expect(stdout).toContain('已归档的缓存调研')
    expect(stdout).toContain('已归档')
  }, 20000)
})
