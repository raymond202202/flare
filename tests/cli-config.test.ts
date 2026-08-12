import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'dist', 'cli', 'index.js')
const children: ChildProcess[] = []
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-config-cli-'))
})

afterEach(() => {
  for (const c of children.splice(0)) c.kill()
  rmSync(dir, { recursive: true, force: true })
})

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, FLARE_HOME: dir, ...env },
    })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('flare config', () => {
  it('输出标题与数据目录（FLARE_HOME 隔离）', async () => {
    const { code, stdout } = await runCli(['config'])
    expect(code).toBe(0)
    expect(stdout).toContain('运行配置')
    expect(stdout).toContain('数据目录')
    expect(stdout).toContain(dir)
  }, 20000)

  it('确认门显示 memory_save 与超时', async () => {
    const { code, stdout } = await runCli(['config'])
    expect(code).toBe(0)
    expect(stdout).toContain('memory_save')
    expect(stdout).toContain('30000ms')
  }, 20000)

  it('DEFAULT_MODEL 环境变量 → 主模型显示该模型', async () => {
    const { code, stdout } = await runCli(['config'], { DEFAULT_MODEL: 'deepseek-test-model' })
    expect(code).toBe(0)
    expect(stdout).toContain('deepseek-test-model')
  }, 20000)

  it('--config 列出 MCP 服务器（stdio + HTTP [auth] 标记）', async () => {
    const mcpPath = join(dir, 'mcp.json')
    writeFileSync(
      mcpPath,
      JSON.stringify({
        servers: [
          { name: 'srv-a', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
          { name: 'srv-b', url: 'http://127.0.0.1:9999/mcp', headers: { Authorization: 'Bearer x' } },
        ],
      })
    )
    const { code, stdout } = await runCli(['config', '--config', mcpPath])
    expect(code).toBe(0)
    expect(stdout).toContain('srv-a')
    expect(stdout).toContain('srv-b')
    expect(stdout).toContain('[auth]')
  }, 20000)

  it('--json 输出可解析且含 model/flareHome/confirmTools/mcpServers 字段', async () => {
    const { code, stdout } = await runCli(['config', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(typeof parsed.model).toBe('string')
    expect(typeof parsed.flareHome).toBe('string')
    expect(Array.isArray(parsed.confirmTools)).toBe(true)
    expect(Array.isArray(parsed.mcpServers)).toBe(true)
  }, 20000)

  it('安全：注入假 API key 明文不得出现在输出', async () => {
    const fakeKey = 'sk-test-secret-1234567890abcdef'
    const { code, stdout } = await runCli(['config', '--json'], { DEEPSEEK_API_KEY: fakeKey })
    expect(code).toBe(0)
    expect(stdout).not.toContain(fakeKey)
  }, 20000)
})
