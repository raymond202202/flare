import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'dist', 'cli', 'index.js')
const children: ChildProcess[] = []
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-tools-cli-'))
})

afterEach(() => {
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

describe('flare tools', () => {
  it('列出工具清单（含标题与内置工具名）', async () => {
    const { code, stdout } = await runCli(['tools'])
    expect(code).toBe(0)
    expect(stdout).toContain('可用工具（')
    expect(stdout).toContain('read_file')
    expect(stdout).toContain('write_file')
  }, 20000)

  it('确认门工具带 [确认] 标记', async () => {
    const { code, stdout } = await runCli(['tools'])
    expect(code).toBe(0)
    expect(stdout).toContain('memory_save')
    expect(stdout).toContain('[确认]')
  }, 20000)

  it('每行含描述（工具名 - 描述分隔）', async () => {
    const { code, stdout } = await runCli(['tools'])
    expect(code).toBe(0)
    const lines = stdout.split('\n').filter((l) => l.includes(' - '))
    expect(lines.length).toBeGreaterThan(0)
  }, 20000)

  it('--json 输出可解析且非空数组', async () => {
    const { code, stdout } = await runCli(['tools', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(0)
  }, 20000)

  it('--json 数组元素含 name/description/confirmed/source 字段', async () => {
    const { code, stdout } = await runCli(['tools', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    const first = parsed[0]
    expect(typeof first.name).toBe('string')
    expect(typeof first.confirmed).toBe('boolean')
    expect(typeof first.source).toBe('string')
    expect('description' in first).toBe(true)
  }, 20000)

  it('退出码 0（正常列出）', async () => {
    const { code } = await runCli(['tools'])
    expect(code).toBe(0)
  }, 20000)
})
