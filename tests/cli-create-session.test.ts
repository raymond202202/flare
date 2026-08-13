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
  dir = mkdtempSync(join(tmpdir(), 'flare-create-session-cli-'))
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

describe('flare create-session', () => {
  it('创建新会话（带标题）→ exit 0 + 输出 + store 出现该会话', async () => {
    const { code, stdout } = await runCli(['create-session', 'sess-c1', '网络调试'])
    expect(code).toBe(0)
    expect(stdout).toContain('已创建会话')
    expect(stdout).toContain('sess-c1')
    expect(stdout).toContain('网络调试')
    const all = store.getAllSessions()
    expect(all.find((s) => s.id === 'sess-c1')?.title).toBe('网络调试')
  }, 20000)

  it('缺省标题 → 默认「新会话」', async () => {
    const { code, stdout } = await runCli(['create-session', 'sess-c2'])
    expect(code).toBe(0)
    expect(stdout).toContain('新会话')
    const all = store.getAllSessions()
    expect(all.find((s) => s.id === 'sess-c2')?.title).toBe('新会话')
  }, 20000)

  it('标题首尾空格被 trim', async () => {
    const { code } = await runCli(['create-session', 'sess-c3', ' 修剪标题 '])
    expect(code).toBe(0)
    const all = store.getAllSessions()
    expect(all.find((s) => s.id === 'sess-c3')?.title).toBe('修剪标题')
  }, 20000)

  it('UPSERT 幂等：已存在会话 → 更新标题不报错（与 server create_session 同语义）', async () => {
    store.saveMessage('sess-c4', { role: 'user', content: '已存在会话' })
    store.updateSessionTitle('sess-c4', '旧标题')
    const { code, stdout } = await runCli(['create-session', 'sess-c4', '新标题'])
    expect(code).toBe(0)
    expect(stdout).toContain('已创建会话')
    const all = store.getAllSessions()
    expect(all.find((s) => s.id === 'sess-c4')?.title).toBe('新标题')
  }, 20000)

  it('空会话 ID（纯空格）→ exit 1 + 提示，不写库', async () => {
    const { code, stdout, stderr } = await runCli(['create-session', '   ', '标题'])
    expect(code).toBe(1)
    expect(stdout + stderr).toContain('会话 ID 不能为空')
    const all = store.getAllSessions()
    expect(all.length).toBe(0)
  }, 20000)

  it('创建后出现在最近会话列表（数据往返：create → sessions 可见）', async () => {
    await runCli(['create-session', 'sess-c6', '往返验证'])
    const recent = store.getRecentSessions(10)
    expect(recent.some((s) => s.id === 'sess-c6')).toBe(true)
    expect(recent.find((s) => s.id === 'sess-c6')?.title).toBe('往返验证')
  }, 20000)
})
