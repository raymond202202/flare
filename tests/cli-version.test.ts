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
  dir = mkdtempSync(join(tmpdir(), 'flare-version-cli-'))
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
describe('flare version', () => {
  it('默认输出 flare v<version>，退出码 0', async () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
    const { code, stdout } = await runCli(['version'])
    expect(code).toBe(0)
    expect(stdout).toContain('flare v' + pkg.version)
  }, 20000)
  it('--json 输出 { engine: <version> }，与 package.json 一致', async () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
    const { code, stdout } = await runCli(['version', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.engine).toBe(pkg.version)
  }, 20000)
  it('不依赖 FLARE_HOME 初始化（默认 FLARE_HOME 即成功）', async () => {
    const env = { ...process.env }
    delete env.FLARE_HOME
    const { code, stdout } = await runCli(['version'], env)
    expect(code).toBe(0)
    expect(stdout).toContain('flare v')
  }, 20000)
})
