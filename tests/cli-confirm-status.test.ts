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
  dir = mkdtempSync(join(tmpdir(), 'flare-confirm-cli-'))
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

describe('flare confirm-status', () => {
  it('默认状态（空库）：确认名单 memory_save + 持久化/本会话无放行', async () => {
    const { code, stdout } = await runCli(['confirm-status'])
    expect(code).toBe(0)
    expect(stdout).toContain('确认门')
    expect(stdout).toContain('memory_save')
    expect(stdout).toContain('已放行（跨会话持久化）: 无')
    expect(stdout).toContain('已放行（本会话）: 无')
  }, 20000)

  it('always 持久化放行：seed settings 后跨会话名单含 memory_save', async () => {
    store.setSetting('confirm.always.memory_save', '1')
    const { code, stdout } = await runCli(['confirm-status'])
    expect(code).toBe(0)
    expect(stdout).toContain('已放行（跨会话持久化）: memory_save')
    expect(stdout).toContain('已放行（本会话）: 无')
  }, 20000)

  it('--json 结构：四字段均为数组且 confirmTools 含 memory_save', async () => {
    const { code, stdout } = await runCli(['confirm-status', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(Array.isArray(parsed.confirmTools)).toBe(true)
    expect(Array.isArray(parsed.allowedTools)).toBe(true)
    expect(Array.isArray(parsed.sessionAllowed)).toBe(true)
    expect(Array.isArray(parsed.alwaysAllowed)).toBe(true)
    expect(parsed.confirmTools).toContain('memory_save')
  }, 20000)

  it('--json + seed always：alwaysAllowed 为 memory_save、sessionAllowed 空', async () => {
    store.setSetting('confirm.always.memory_save', '1')
    const { code, stdout } = await runCli(['confirm-status', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.alwaysAllowed).toEqual(['memory_save'])
    expect(parsed.sessionAllowed).toEqual([])
    expect(parsed.allowedTools).toContain('memory_save')
  }, 20000)

  it('非候选键过滤：confirm.always.other_tool 不出现在任何名单', async () => {
    store.setSetting('confirm.always.other_tool', '1')
    const { code, stdout } = await runCli(['confirm-status', '--json'])
    expect(code).toBe(0)
    expect(stdout).not.toContain('other_tool')
  }, 20000)

  it('会话级放行恒空：seed always 后本会话仍显示无', async () => {
    store.setSetting('confirm.always.memory_save', '1')
    const { code, stdout } = await runCli(['confirm-status'])
    expect(code).toBe(0)
    expect(stdout).toContain('已放行（本会话）: 无')
  }, 20000)
})
