import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'dist', 'cli', 'index.js')
const children: ChildProcess[] = []
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-ping-cli-'))
})
afterEach(() => {
  for (const c of children.splice(0)) c.kill()
  rmSync(dir, { recursive: true, force: true })
})
function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, FLARE_HOME: dir, ...envOverrides, },
    })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}
describe('flare ping', () => {
  it('默认输出 pong，退出码 0', async () => {
    const { code, stdout } = await runCli(['ping'])
    expect(code).toBe(0)
    expect(stdout).toContain('pong')
  }, 20000)
  it('--json 输出 { type: pong, ts }', async () => {
    const { code, stdout } = await runCli(['ping', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.type).toBe('pong')
    expect(typeof parsed.ts).toBe('number')
  }, 20000)
  it('--json ts 接近当前时间', async () => {
    const before = Date.now()
    const { code, stdout } = await runCli(['ping', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.ts).toBeGreaterThanOrEqual(before - 1000)
    expect(parsed.ts).toBeLessThanOrEqual(Date.now() + 1000)
  }, 20000)
  it('不依赖任何初始化：FLARE_HOME 指向不存在目录仍 pong exit 0', async () => {
    const { code, stdout } = await runCli(['ping'], { FLARE_HOME: join(dir, 'no-such-dir') })
    expect(code).toBe(0)
    expect(stdout).toContain('pong')
  }, 20000)
  it('无 FLARE_HOME 环境变量仍 pong exit 0（ping 不初始化存储）', async () => {
    const env = { ...process.env }
    delete env.FLARE_HOME
    const { code, stdout } = await runCli(['ping'], env)
    expect(code).toBe(0)
    expect(stdout).toContain('pong')
  }, 20000)
  it('非 json 输出含引擎版本号（与 package.json 一致）', async () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
    const { code, stdout } = await runCli(['ping'])
    expect(code).toBe(0)
    expect(stdout).toContain('v' + pkg.version)
  }, 20000)
})
