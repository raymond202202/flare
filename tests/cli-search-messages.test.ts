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
  dir = mkdtempSync(join(tmpdir(), 'flare-searchmsg-cli-'))
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
describe('flare search-messages（v0.6.86）', () => {
  it('消息内容命中 → 显示内容 + 会话 ID + user 角色图标', async () => {
    const sid = store.createSession('普通标题')
    store.saveMessage(sid, { role: 'user', content: '深度讨论 prompt caching 前缀稳定策略' })
    const { code, stdout } = await runCli(['search-messages', '前缀稳定'])
    expect(code).toBe(0)
    expect(stdout).toContain('搜索消息「前缀稳定」')
    expect(stdout).toContain('前缀稳定策略')
    expect(stdout).toContain(sid)
    expect(stdout).toContain('🧑')
  }, 20000)
  it('assistant 消息命中 → 🤖 图标', async () => {
    const sid = store.createSession('s')
    store.saveMessage(sid, { role: 'assistant', content: '缓存命中率 75% 属于正常范围' })
    const { code, stdout } = await runCli(['search-messages', '命中率'])
    expect(code).toBe(0)
    expect(stdout).toContain('🤖')
  }, 20000)
  it('无匹配 → 「未找到包含」', async () => {
    store.createSession('无关标题')
    const { code, stdout } = await runCli(['search-messages', '绝无此词xyz'])
    expect(code).toBe(0)
    expect(stdout).toContain('未找到包含「绝无此词xyz」')
  }, 20000)
  it('--limit 1 只显示 1 条消息', async () => {
    const a = store.createSession('A')
    store.saveMessage(a, { role: 'user', content: '缓存调研内容一' })
    const b = store.createSession('B')
    store.saveMessage(b, { role: 'user', content: '缓存调研内容二' })
    const { code, stdout } = await runCli(['search-messages', '缓存调研', '--limit', '1'])
    expect(code).toBe(0)
    const lines = stdout.split('\n').filter((l) => l.includes(']'))
    expect(lines.length).toBe(1)
  }, 20000)
  it('非法 --limit（0/101/abc）→ 退出码 1 + 提示含 1~100', async () => {
    for (const bad of ['0', '101', 'abc']) {
      const { code, stderr } = await runCli(['search-messages', 'kw', '--limit', bad])
      expect(code).toBe(1)
      expect(stderr).toContain('1~100')
    }
  }, 20000)
  it('短关键词（<3 字符）→ LIKE 回退也命中', async () => {
    const sid = store.createSession('s')
    store.saveMessage(sid, { role: 'user', content: '聊聊缓存' })
    const { code, stdout } = await runCli(['search-messages', '缓存'])
    expect(code).toBe(0)
    expect(stdout).toContain('聊聊缓存')
  }, 20000)
})
