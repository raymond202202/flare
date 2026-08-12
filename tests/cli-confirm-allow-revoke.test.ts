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
  dir = mkdtempSync(join(tmpdir(), 'flare-confirm-write-cli-'))
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
      env: {
        ...process.env,
        FLARE_HOME: dir,
      },
    })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('flare confirm-allow / confirm-revoke', () => {
  it('confirm-allow 默认 always 跨会话持久化：confirm.always.memory_save 写入 settings', async () => {
    const { code, stdout } = await runCli(['confirm-allow', 'memory_save'])
    expect(code).toBe(0)
    expect(stdout).toContain('已放行')
    expect(stdout).toContain('memory_save')
    expect(stdout).toContain('跨会话持久化')
    // 默认 always：跨会话持久化键写入（单次命令进程内会话级放行恒为空，持久化才有实际效果）
    expect(store.getSetting('confirm.always.memory_save')).toBe('1')
  }, 20000)

  it('confirm-allow --session 仅本进程：磁盘不写 confirm.always 键', async () => {
    const { code, stdout } = await runCli(['confirm-allow', 'memory_save', '--session'])
    expect(code).toBe(0)
    expect(stdout).toContain('已放行')
    expect(stdout).toContain('本进程会话内')
    // 会话级放行不触碰 always 持久化键
    expect(store.getSetting('confirm.always.memory_save')).toBeNull()
  }, 20000)

  it('confirm-allow 空工具名：报错且退出码 1', async () => {
    const { code, stdout } = await runCli(['confirm-allow', ''])
    expect(code).toBe(1)
    expect(stdout).toContain('工具名不能为空')
  }, 20000)

  it('confirm-allow 默认 always 后 confirm-status 显示跨会话放行（端到端）', async () => {
    await runCli(['confirm-allow', 'memory_save'])
    const { code, stdout } = await runCli(['confirm-status', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.alwaysAllowed).toContain('memory_save')
  }, 20000)

  it('confirm-revoke 清除会话级放行（仅会话内存，不改磁盘），退出码 0', async () => {
    const { code, stdout } = await runCli(['confirm-revoke', 'memory_save'])
    expect(code).toBe(0)
    expect(stdout).toContain('已撤销')
    expect(stdout).toContain('memory_save')
    // 会话级 revoke 为幂等；磁盘无变化
    expect(store.getSetting('confirm.always.memory_save')).toBeNull()
  }, 20000)

  it('confirm-revoke 清除 always 持久化放行：confirm.always.memory_save 被删除', async () => {
    store.setSetting('confirm.always.memory_save', '1')
    const { code } = await runCli(['confirm-revoke', 'memory_save'])
    expect(code).toBe(0)
    // revoke 以空串写入删除持久化键
    expect(store.getSetting('confirm.always.memory_save') || '').toBe('')
  }, 20000)

  it('confirm-revoke 空工具名：报错且退出码 1', async () => {
    const { code, stdout } = await runCli(['confirm-revoke', ''])
    expect(code).toBe(1)
    expect(stdout).toContain('工具名不能为空')
  }, 20000)

  it('confirm-revoke 后 confirm-status 不再显示该工具（端到端）', async () => {
    await runCli(['confirm-allow', 'memory_save'])
    await runCli(['confirm-revoke', 'memory_save'])
    const { code, stdout } = await runCli(['confirm-status', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.alwaysAllowed).not.toContain('memory_save')
  }, 20000)
})
