/**
 * CLI `flare mcp call` 测试（v0.6.6）
 *
 * spawn dist CLI 真实子进程，验证：
 * - `--url` 直连 HTTP transport 服务器（in-process startMcpHttpServer）→ 真实调用工具输出结果
 * - 配置文件 url → 走 HTTP；配置文件 command → 走 stdio（mock fixture）
 * - 错误路径：未配置服务器 / 非法 JSON 参数 / 未知工具 → 退出码 1 + 错误提示
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
  dir = mkdtempSync(join(tmpdir(), 'flare-mcp-call-'))
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

describe('CLI flare mcp call', () => {
  it('--url 直连 HTTP transport 服务器 → 真实调用工具输出结果', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const { code, stdout, stderr } = await runCli(['mcp', 'call', 'remote', 'echo', '{"text":"hello cli"}', '--url', h.url])
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('hello cli')
    expect(stderr).toBe('')
  }, 20000)

  it('配置 url（--config 指定）→ 走 HTTP transport', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'remote', url: h.url }] }))
    const { code, stdout } = await runCli(['mcp', 'call', 'remote', 'echo', '{"text":"via cfg"}', '--config', cfgPath])
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('via cfg')
  }, 20000)

  it('配置 command（--config 指定）→ 走 stdio（mock fixture 真实子进程）', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const { code, stdout } = await runCli(['mcp', 'call', 'mock', 'add_numbers', '{"a":2,"b":3}', '--config', cfgPath])
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('5')
  }, 20000)

  it('不传参数（默认 {}）也可调用；空输出走「无文本输出」兜底', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const { code, stdout } = await runCli(['mcp', 'call', 'remote', 'echo', '--url', h.url])
    expect(code).toBe(0)
    expect(stdout).toMatch(/无文本输出/)
  }, 20000)

  it('未配置服务器 → 退出码 1 + 错误提示', async () => {
    const { code, stderr } = await runCli(['mcp', 'call', 'nope', 'echo', '{}', '--config', join(dir, 'missing.json')])
    expect(code).toBe(1)
    expect(stderr).toMatch(/未配置 MCP 服务器/)
  }, 20000)

  it('非法 JSON 参数 → 退出码 1 + 提示', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const { code, stderr } = await runCli(['mcp', 'call', 'remote', 'echo', '{bad', '--url', h.url])
    expect(code).toBe(1)
    expect(stderr).toMatch(/不是合法 JSON/)
  }, 20000)

  it('未知工具（协议错误）→ 退出码 1 + 错误信息', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const { code, stderr } = await runCli(['mcp', 'call', 'remote', 'nope', '{}', '--url', h.url])
    expect(code).toBe(1)
    expect(stderr).toMatch(/MCP 错误|未知工具/)
  }, 20000)

  it('mcp status：列出配置服务器（名称 + 传输类型 + 端点/命令）', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({
      servers: [
        { name: 'remote', url: 'http://127.0.0.1:8931/mcp' },
        { name: 'mock', command: process.execPath, args: [MOCK_SERVER] },
      ],
    }))
    const { code, stdout } = await runCli(['mcp', 'status', '--config', cfgPath])
    expect(code).toBe(0)
    expect(stdout).toMatch(/remote/)
    expect(stdout).toMatch(/HTTP/)
    expect(stdout).toMatch(/mock/)
    expect(stdout).toMatch(/stdio/)
    expect(stdout).toMatch(/127\.0\.0\.1:8931/)
    // v0.6.51：连接标记（未连接 ○）+ 传输/端点 + 无工具数（未连接）
    expect(stdout).toMatch(/○/)
    expect(stdout).not.toMatch(/个工具/)
  }, 20000)

  it('mcp status --connect：连接真实服务器显示 ● 连接标记 + 工具数（v0.6.51 统一 status()）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({
      servers: [
        { name: 'remote', url: h.url },
      ],
    }))
    const { code, stdout } = await runCli(['mcp', 'status', '--connect', '--config', cfgPath])
    expect(code).toBe(0)
    // 已连接：● 标记 + 端点 url + 工具数（HTTP transport 服务器连接成功）
    expect(stdout).toMatch(/●/)
    expect(stdout).toMatch(/HTTP/)
    expect(stdout).toMatch(new RegExp(h.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    expect(stdout).toMatch(/1 个工具/)
  }, 20000)

  it('mcp status：无配置 → 未配置提示（退出码 0）', async () => {
    const { code, stdout } = await runCli(['mcp', 'status', '--config', join(dir, 'missing.json')])
    expect(code).toBe(0)
    expect(stdout).toMatch(/未配置 MCP 服务器/)
  }, 20000)
})

describe('CLI flare mcp prompts（v0.6.10）', () => {
  /** 带 prompts 的 HTTP MCP 服务器 */
  async function startPromptServer() {
    return startMcpHttpServer({
      tools: [echoTool],
      prompts: [
        {
          name: 'greet',
          description: '生成问候语',
          arguments: [{ name: 'name', description: '称呼', required: true }],
          render: async (args: any) => ([
            { role: 'user' as const, content: { type: 'text' as const, text: `你好，${args.name}！` } },
          ]),
        },
      ],
    })
  }

  it('列出提示词元数据（名称 + 参数 + 描述）', async () => {
    const h = await startPromptServer()
    handles.push(h)
    const { code, stdout } = await runCli(['mcp', 'prompts', 'remote', '--url', h.url])
    expect(code).toBe(0)
    expect(stdout).toMatch(/greet/)
    expect(stdout).toMatch(/生成问候语/)
    expect(stdout).toMatch(/name/)
  }, 20000)

  it('--get <name> 渲染提示词消息', async () => {
    const h = await startPromptServer()
    handles.push(h)
    const { code, stdout } = await runCli(['mcp', 'prompts', 'remote', '--get', 'greet', '--args', '{"name":"世界"}', '--url', h.url])
    expect(code).toBe(0)
    expect(stdout).toContain('你好，世界！')
  }, 20000)

  it('--get 未知提示词 → 退出码 1 + 协议错误', async () => {
    const h = await startPromptServer()
    handles.push(h)
    const { code, stderr } = await runCli(['mcp', 'prompts', 'remote', '--get', 'nope', '--url', h.url])
    expect(code).toBe(1)
    expect(stderr).toMatch(/MCP 错误|未知提示词|Unknown/i)
  }, 20000)
})

describe('CLI flare mcp resources（v0.6.10）', () => {
  async function startResServer() {
    return startMcpHttpServer({
      tools: [echoTool],
      resources: [
        {
          uri: 'flare://notes/hello',
          name: 'hello-note',
          description: '一条示例笔记',
          mimeType: 'text/plain',
          read: () => '你好，这是资源内容',
        },
      ],
    })
  }

  it('列出资源元数据（uri + 名称 + 描述 + mimeType）', async () => {
    const h = await startResServer()
    handles.push(h)
    const { code, stdout } = await runCli(['mcp', 'resources', 'remote', '--url', h.url])
    expect(code).toBe(0)
    expect(stdout).toMatch(/flare:\/\/notes\/hello/)
    expect(stdout).toMatch(/hello-note/)
    expect(stdout).toMatch(/一条示例笔记/)
    expect(stdout).toMatch(/text\/plain/)
  }, 20000)

  it('--read <uri> 读取资源内容', async () => {
    const h = await startResServer()
    handles.push(h)
    const { code, stdout } = await runCli(['mcp', 'resources', 'remote', '--read', 'flare://notes/hello', '--url', h.url])
    expect(code).toBe(0)
    expect(stdout.trim()).toContain('你好，这是资源内容')
  }, 20000)

  it('--read 未知 uri → 退出码 1 + 协议错误', async () => {
    const h = await startResServer()
    handles.push(h)
    const { code, stderr } = await runCli(['mcp', 'resources', 'remote', '--read', 'flare://nope', '--url', h.url])
    expect(code).toBe(1)
    expect(stderr).toMatch(/MCP 错误|未知资源|not found/i)
  }, 20000)

  it('未配置服务器 → 退出码 1 + 错误提示', async () => {
    const { code, stderr } = await runCli(['mcp', 'resources', 'nope', '--config', join(dir, 'missing.json')])
    expect(code).toBe(1)
    expect(stderr).toMatch(/未配置 MCP 服务器/)
  }, 20000)
})
