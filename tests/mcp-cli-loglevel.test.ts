/**
 * CLI `flare log-level <server> <level>` 测试（v0.6.83）
 *
 * spawn dist CLI 真实子进程，验证：
 * - 合法级别（stdio mock fixture / HTTP transport --url）→ 退出码 0 + 成功摘要
 * - 非法级别 → 退出码 1 + 错误提示（CLI 侧先校验，不发请求）
 * - 未配置服务器 → 退出码 1 + 清晰错误
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { startMcpHttpServer, type McpHttpServerHandle } from '../src/mcp/http.js'
import type { Tool } from '../src/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'dist', 'cli', 'index.js')
const MOCK_SERVER = join(__dirname, 'fixtures', 'mcp-mock-server.mjs')

const echoTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'echo',
      description: '回显输入文本',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    },
  },
  execute: async (args) => ({ success: true, output: String(args.text || '') }),
}

const handles: McpHttpServerHandle[] = []
const children: ChildProcess[] = []
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-mcp-loglevel-'))
})

afterEach(async () => {
  for (const h of handles.splice(0)) await h.close()
  for (const c of children.splice(0)) c.kill()
  rmSync(dir, { recursive: true, force: true })
})

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('close', (code) => resolve({ code, stdout: out, stderr: err }))
  })
}

describe('CLI flare log-level', () => {
  it('配置 command（--config 指定）→ stdio mock 服务器设置日志级别成功（退出码 0 + 摘要）', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const { code, stdout } = await runCli(['log-level', 'mock', 'warning', '--config', cfgPath])
    expect(code).toBe(0)
    expect(stdout).toContain('已设置 mock 日志级别为 warning')
  }, 20000)

  it('--url 直连 HTTP transport 服务器 → 设置日志级别成功（退出码 0）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const { code, stdout } = await runCli(['log-level', 'remote', 'error', '--url', h.url])
    expect(code).toBe(0)
    expect(stdout).toContain('已设置 remote')
  }, 20000)

  it('非法级别 → 退出码 1 + 错误提示（CLI 侧校验，不发请求）', async () => {
    const { code, stdout, stderr } = await runCli(['log-level', 'mock', 'verbose'])
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('无效日志级别: verbose')
  }, 20000)

  it('协议 8 级全量合法（debug/info/notice/warning/error/critical/alert/emergency，与 MCP_LOG_LEVELS 对齐）', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    for (const level of ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']) {
      const { code, stdout } = await runCli(['log-level', 'mock', level, '--config', cfgPath])
      expect(code).toBe(0)
      expect(stdout).toContain(`已设置 mock 日志级别为 ${level}`)
    }
  }, 30000)

  it('未配置服务器 → 退出码 1 + 清晰错误', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [] }))
    const { code, stderr } = await runCli(['log-level', 'ghost', 'info', '--config', cfgPath])
    expect(code).toBe(1)
    expect(stderr).toContain('未配置 MCP 服务器: ghost')
  }, 20000)
})
