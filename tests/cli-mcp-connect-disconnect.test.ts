/**
 * CLI `flare mcp connect` / `flare mcp disconnect` 测试（v0.6.120）
 *
 * spawn dist CLI 真实子进程，验证：
 * - `connect` 按名连接 HTTP transport（in-process startMcpHttpServer）→ 摘要含 transport/target/工具数，exit 0
 * - `connect` 按名连接 stdio（mock fixture 真实子进程）→ 摘要含工具数，exit 0
 * - `connect` 摘要含资源/模板/提示词数（mock fixture 声明 resources/prompts）与 [auth] 标记（HTTP 配 headers）
 * - `connect` 未配置服务器 → exit 1 + 错误提示
 * - `connect` 连接失败（HTTP 不可达）→ exit 1 + 错误提示
 * - `disconnect` 已配置但未连接 → 幂等提示 exit 0（单次命令进程内无持久连接）
 * - `disconnect` 未配置服务器 → exit 1 + 错误提示
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
  dir = mkdtempSync(join(tmpdir(), 'flare-mcp-connect-'))
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

describe('CLI flare mcp connect', () => {
  it('按名连接 HTTP transport 服务器 → 摘要含 [HTTP] + 端点 + 工具数，exit 0', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'remote', url: h.url }] }))
    const { code, stdout, stderr } = await runCli(['mcp', 'connect', 'remote', '--config', cfgPath])
    expect(code).toBe(0)
    expect(stdout).toMatch(/已连接 remote/)
    expect(stdout).toMatch(/\[HTTP\]/)
    expect(stdout).toMatch(h.url)
    expect(stdout).toMatch(/1 个 MCP 工具/)
    expect(stderr).toBe('')
  }, 20000)

  it('按名连接 stdio 服务器（mock fixture）→ 摘要含工具数 + 资源/模板/提示词数，exit 0', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const { code, stdout } = await runCli(['mcp', 'connect', 'mock', '--config', cfgPath])
    expect(code).toBe(0)
    expect(stdout).toMatch(/已连接 mock/)
    expect(stdout).toMatch(/3 个 MCP 工具/)
    // mock fixture 声明 2 资源 + 1 模板 + 2 提示词（v0.6.26/0.6.36 摘要口径）
    expect(stdout).toMatch(/2 个资源/)
    expect(stdout).toMatch(/1 个模板/)
    expect(stdout).toMatch(/2 个提示词/)
  }, 20000)

  it('HTTP transport 配 headers → 摘要含 [auth] 标记（不输出 token）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'secure', url: h.url, headers: { Authorization: 'Bearer test-token-value' } }] }))
    const { code, stdout } = await runCli(['mcp', 'connect', 'secure', '--config', cfgPath])
    expect(code).toBe(0)
    expect(stdout).toMatch(/\[auth\]/)
    // 铁律：输出不得含 token 明文
    expect(stdout).not.toMatch(/test-token-value/)
    expect(stdout).not.toMatch(/Bearer/)
  }, 20000)

  it('未配置服务器 → exit 1 + 错误提示', async () => {
    const { code, stderr } = await runCli(['mcp', 'connect', 'nope', '--config', join(dir, 'missing.json')])
    expect(code).toBe(1)
    expect(stderr).toMatch(/未配置 MCP 服务器/)
  }, 20000)

  it('连接失败（HTTP 端点不可达）→ exit 1 + 错误提示', async () => {
    const cfgPath = join(dir, 'mcp.json')
    // 用一个几乎肯定无人监听的本地端口
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'dead', url: 'http://127.0.0.1:1/mcp' }] }))
    const { code, stderr } = await runCli(['mcp', 'connect', 'dead', '--config', cfgPath, '--timeout', '2000'])
    expect(code).toBe(1)
    expect(stderr).toMatch(/❌/)
  }, 20000)

  it('--timeout 接线到 HTTP 单请求超时（静默服务器不响应 initialize → 快速超时 exit 1 而非默认 15s 挂住）', async () => {
    // 起一个「接收请求但永不响应」的原生 HTTP 服务器：MCPHttpClient.initialize 发请求后
    // 无响应，只能靠 timeoutMs 超时失败。若 --timeout 接线生效，800ms 内 exit 1；
    // 若未接线（默认 15s），测试会在 20s 超时前观察到明显更长的耗时——断言 exit 1 且耗时 < 5s
    const { createServer } = await import('node:http')
    const silent = createServer((_req, _res) => { /* 永不响应 */ })
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const addr = silent.address()
    const url = `http://127.0.0.1:${(addr as any).port}/mcp`
    children.push({ kill: () => silent.close() } as any)
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'silent', url }] }))
    const t0 = Date.now()
    const { code, stderr } = await runCli(['mcp', 'connect', 'silent', '--config', cfgPath, '--timeout', '800'])
    const elapsed = Date.now() - t0
    expect(code).toBe(1)
    expect(stderr).toMatch(/❌/)
    expect(elapsed).toBeLessThan(5000)
  }, 20000)
})

describe('CLI flare mcp disconnect', () => {
  it('已配置但未连接（单次命令进程内无持久连接）→ 幂等提示 exit 0', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const { code, stdout } = await runCli(['mcp', 'disconnect', 'mock', '--config', cfgPath])
    expect(code).toBe(0)
    expect(stdout).toMatch(/未连接/)
    expect(stdout).toMatch(/mock/)
  }, 20000)

  it('未配置服务器 → exit 1 + 错误提示', async () => {
    const { code, stderr } = await runCli(['mcp', 'disconnect', 'nope', '--config', join(dir, 'missing.json')])
    expect(code).toBe(1)
    expect(stderr).toMatch(/未配置 MCP 服务器/)
  }, 20000)
})
