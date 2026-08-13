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

  it('--json 输出与 server mcp_call 回包同构（server/tool/success/output）', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const { code, stdout, stderr } = await runCli(['mcp', 'call', 'mock', 'add_numbers', '{"a":2,"b":3}', '--config', cfgPath, '--json'])
    expect(code).toBe(0)
    expect(stderr).toBe('')
    const parsed = JSON.parse(stdout)
    expect(parsed.server).toBe('mock')
    expect(parsed.tool).toBe('add_numbers')
    expect(parsed.success).toBe(true)
    expect(parsed.output).toBe('5')
    expect('error' in parsed).toBe(false)
    // 纯 JSON 无 ANSI 彩色
    expect(stdout).not.toMatch(/\u001b\[/)
  }, 20000)

  it('--json 无文本输出 → { output: "" } success:true exit 0（不打印「无文本输出」兜底）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const { code, stdout } = await runCli(['mcp', 'call', 'remote', 'echo', '--url', h.url, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.success).toBe(true)
    expect(parsed.output).toBe('')
    expect(stdout).not.toMatch(/无文本输出/)
  }, 20000)

  it('--json 工具级失败（fail_tool isError）→ { success:false, error } 合法 JSON + exit 1', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const { code, stdout } = await runCli(['mcp', 'call', 'mock', 'fail_tool', '{}', '--config', cfgPath, '--json'])
    expect(code).toBe(1)
    const parsed = JSON.parse(stdout)
    expect(parsed.server).toBe('mock')
    expect(parsed.tool).toBe('fail_tool')
    expect(parsed.success).toBe(false)
    expect(parsed.error).toBe('出错了')
    expect(parsed.output).toBe('出错了')
  }, 20000)

  it('--json -j 短选项等价 + 文本模式回归（纯文本输出且非 JSON）', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const { stdout: shortStdout } = await runCli(['mcp', 'call', 'mock', 'add_numbers', '{"a":1,"b":2}', '--config', cfgPath, '-j'])
    expect(JSON.parse(shortStdout).output).toBe('3')
    const { stdout: textStdout } = await runCli(['mcp', 'call', 'mock', 'add_numbers', '{"a":1,"b":2}', '--config', cfgPath])
    expect(textStdout.trim()).toBe('3')
    // 文本模式是裸输出（非 JSON 对象结构）
    expect(textStdout.trim().startsWith('{')).toBe(false)
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
    // v0.6.61：提示行含 tools/complete 子命令入口
    expect(stdout).toMatch(/mcp tools/)
    expect(stdout).toMatch(/mcp complete/)
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

  it('mcp status --json：结构化输出（v0.6.80：host/脚本程序化消费）', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({
      servers: [
        { name: 'remote', url: 'http://127.0.0.1:8931/mcp', headers: { Authorization: 'Bearer x' } },
        { name: 'mock', command: process.execPath, args: [MOCK_SERVER] },
      ],
    }))
    const { code, stdout } = await runCli(['mcp', 'status', '--json', '--config', cfgPath])
    expect(code).toBe(0)
    // 纯 JSON（首字符即 [，无彩色/提示行）
    expect(stdout.trim().startsWith('[')).toBe(true)
    const parsed = JSON.parse(stdout)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ name: 'remote', transport: 'http', connected: false, auth: true })
    expect(parsed[0].target).toContain('127.0.0.1:8931')
    // 不泄漏 token（auth 只传布尔）
    expect(stdout).not.toContain('Bearer x')
    expect(parsed[1]).toMatchObject({ name: 'mock', transport: 'stdio' })
  }, 20000)

  it('mcp status --json：无配置 → []（结构化消费方稳定形状，退出码 0）', async () => {
    const { code, stdout } = await runCli(['mcp', 'status', '--json', '--config', join(dir, 'missing.json')])
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual([])
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

describe('CLI flare mcp tools（v0.6.59）', () => {
  it('列出工具清单（名称 + 描述）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const { code, stdout } = await runCli(['mcp', 'tools', 'remote', '--url', h.url])
    expect(code).toBe(0)
    expect(stdout).toMatch(/echo/)
    expect(stdout).toMatch(/回显输入文本/)
    expect(stdout).toMatch(/1\）/)
  }, 20000)

  it('配置 command（--config 指定）→ 走 stdio（mock fixture 真实子进程 3 工具）', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const { code, stdout } = await runCli(['mcp', 'tools', 'mock', '--config', cfgPath])
    expect(code).toBe(0)
    expect(stdout).toMatch(/echo_text/)
    expect(stdout).toMatch(/回显输入文本/)
    expect(stdout).toMatch(/add_numbers/)
    expect(stdout).toMatch(/两个数相加/)
    expect(stdout).toMatch(/fail_tool/)
    expect(stdout).toMatch(/3\）/)
  }, 20000)

  it('未配置服务器 → 退出码 1 + 错误提示', async () => {
    const { code, stderr } = await runCli(['mcp', 'tools', 'nope', '--config', join(dir, 'missing.json')])
    expect(code).toBe(1)
    expect(stderr).toMatch(/未配置 MCP 服务器/)
  }, 20000)
})

describe('CLI flare mcp complete（v0.6.60）', () => {
  it('请求参数补全候选（completion/complete 代理）', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const { code, stdout } = await runCli(['mcp', 'complete', 'mock', 'summarize', 'topic', 'flare', '--config', cfgPath])
    expect(code).toBe(0)
    expect(stdout).toMatch(/候选/)
    expect(stdout).toMatch(/flare 缓存/)
    expect(stdout).toMatch(/flare MCP/)
    // 数量 4/4（values.length/total）
    expect(stdout).toMatch(/4\/4/)
  }, 20000)

  it('前缀收窄 → 只显示匹配候选', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const { code, stdout } = await runCli(['mcp', 'complete', 'mock', 'summarize', 'topic', 'flare M', '--config', cfgPath])
    expect(code).toBe(0)
    expect(stdout).toMatch(/flare MCP/)
    expect(stdout).not.toMatch(/flare 缓存/)
    expect(stdout).toMatch(/1\/1/)
  }, 20000)

  it('未知引用（协议错误）→ 退出码 1 + 错误提示（不崩溃）', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const { code, stderr } = await runCli(['mcp', 'complete', 'mock', 'ghost', 'topic', 'x', '--config', cfgPath])
    expect(code).toBe(1)
    expect(stderr).toMatch(/未知补全引用|MCP 错误/i)
  }, 20000)

  it('未配置服务器 → 退出码 1 + 错误提示', async () => {
    const { code, stderr } = await runCli(['mcp', 'complete', 'nope', 'p', 'a', 'v', '--config', join(dir, 'missing.json')])
    expect(code).toBe(1)
    expect(stderr).toMatch(/未配置 MCP 服务器/)
  }, 20000)

  it('--json 输出与 server mcp_complete 回包同构（server/prompt/argument/value/values/total/hasMore）', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const { code, stdout, stderr } = await runCli(['mcp', 'complete', 'mock', 'summarize', 'topic', 'flare', '--config', cfgPath, '--json'])
    expect(code).toBe(0)
    expect(stderr).toBe('')
    const parsed = JSON.parse(stdout)
    expect(parsed.server).toBe('mock')
    expect(parsed.prompt).toBe('summarize')
    expect(parsed.argument).toBe('topic')
    expect(parsed.value).toBe('flare')
    // 4 个候选均以 'flare' 开头 → 全部命中（与 v0.6.60 文本用例 4/4 断言一致）
    expect(parsed.values).toEqual(['flare 缓存', 'flare MCP', 'flare 上下文', 'flare 用量'])
    expect(parsed.total).toBe(4)
    expect(parsed.hasMore).toBe(false)
    // 纯 JSON 无 ANSI 彩色
    expect(stdout).not.toMatch(/\u001b\[/)
  }, 20000)

  it('--json 前缀收窄 + 未传 value 时省略 value 字段（server 同款可选字段语义）', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const { code, stdout } = await runCli(['mcp', 'complete', 'mock', 'summarize', 'topic', 'flare M', '--config', cfgPath, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.values).toEqual(['flare MCP'])
    expect(parsed.total).toBe(1)
    expect(parsed.value).toBe('flare M')
    // 不带 value 参数（只传前缀场景省略 value 字段——与 server 回包 ...(value ? { value } : {}) 同构）
    const { stdout: stdout2 } = await runCli(['mcp', 'complete', 'mock', 'summarize', 'topic', '', '--config', cfgPath, '--json'])
    const parsed2 = JSON.parse(stdout2)
    expect(parsed2.values).toHaveLength(4)
    expect(parsed2.total).toBe(4)
    expect('value' in parsed2).toBe(false)
  }, 20000)

  it('--json 空候选 → { values: [] } 合法 JSON exit 0（不打印「无补全候选」提示）', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const { code, stdout } = await runCli(['mcp', 'complete', 'mock', 'summarize', 'topic', 'xyz', '--config', cfgPath, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.values).toEqual([])
    expect(parsed.total).toBe(0)
    expect(stdout).not.toMatch(/无补全候选/)
  }, 20000)

  it('--json -j 短选项等价 + 文本模式回归（含「候选」标题且非 JSON）', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const { stdout: shortStdout } = await runCli(['mcp', 'complete', 'mock', 'summarize', 'topic', 'flare', '--config', cfgPath, '-j'])
    expect(JSON.parse(shortStdout).values).toHaveLength(4)
    const { stdout: textStdout } = await runCli(['mcp', 'complete', 'mock', 'summarize', 'topic', 'flare', '--config', cfgPath])
    expect(textStdout).toMatch(/候选/)
    expect(textStdout).toMatch(/flare 缓存/)
    expect(() => JSON.parse(textStdout)).toThrow()
  }, 20000)
})

describe('CLI flare mcp 单次命令 --header（v0.6.68：HTTP transport 鉴权请求头，可重复）', () => {
  it('call --url --header → 服务器收到 Authorization + 调用成功', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const seenAuth: string[] = []
    h.http.on('request', (req) => {
      const auth = req.headers['authorization']
      if (auth) seenAuth.push(String(auth))
    })
    const { code, stdout, stderr } = await runCli([
      'mcp', 'call', 'remote', 'echo', '{"text":"hi-header"}', '--url', h.url,
      '--header', 'Authorization: Bearer cli-token-789',
    ])
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('hi-header')
    expect(stderr).toBe('')
    expect(seenAuth.length).toBeGreaterThanOrEqual(1)
    expect(seenAuth.every((a) => a === 'Bearer cli-token-789')).toBe(true)
  }, 20000)

  it('可重复 --header（多个键）→ 全部携带；与配置 headers 合并时 CLI 优先', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const seen: { auth?: string; xenv?: string }[] = []
    h.http.on('request', (req) => {
      seen.push({
        ...(req.headers['authorization'] ? { auth: String(req.headers['authorization']) } : {}),
        ...(req.headers['x-env'] ? { xenv: String(req.headers['x-env']) } : {}),
      })
    })
    const cfgPath = join(dir, 'mcp.json')
    // 配置带 headers；CLI --header 覆盖 Authorization（x-env 仅配置有 → 保留）
    writeFileSync(cfgPath, JSON.stringify({
      servers: [{ name: 'remote', url: h.url, headers: { Authorization: 'Bearer cfg-token', 'X-Env': 'prod' } }],
    }))
    const { code, stdout } = await runCli([
      'mcp', 'call', 'remote', 'echo', '{"text":"merge"}', '--config', cfgPath,
      '--header', 'Authorization: Bearer cli-token',
    ])
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('merge')
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen.every((s) => s.auth === 'Bearer cli-token')).toBe(true)
    expect(seen.every((s) => s.xenv === 'prod')).toBe(true)
  }, 20000)

  it('--header 非法格式（缺冒号）→ 退出码 1 + 用法提示（不崩溃）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const { code, stderr } = await runCli(['mcp', 'call', 'remote', 'echo', '{}', '--url', h.url, '--header', 'no-colon'])
    expect(code).toBe(1)
    expect(stderr).toMatch(/key:value/)
  }, 20000)

  it('mcp status：配置 headers 的服务器显示 [auth] 标记；无 headers 不显示（v0.6.70）', async () => {
    const cfgPath = join(dir, 'mcp.json')
    writeFileSync(cfgPath, JSON.stringify({
      servers: [
        { name: 'secure', url: 'http://127.0.0.1:8931/mcp', headers: { Authorization: 'Bearer x' } },
        { name: 'open', url: 'http://127.0.0.1:8932/mcp' },
      ],
    }))
    const { code, stdout } = await runCli(['mcp', 'status', '--config', cfgPath])
    expect(code).toBe(0)
    // secure 行：HTTP + [auth]（标记不显示 token 值）
    expect(stdout).toMatch(/secure\s+HTTP \[auth\]/)
    expect(stdout).not.toMatch(/Bearer x/)
    // open 行：HTTP 无 [auth]
    expect(stdout).toMatch(/open\s+HTTP\s+http:\/\/127\.0\.0\.1:8932/)
    expect(stdout).not.toMatch(/open\s+HTTP \[auth\]/)
  }, 20000)
})

describe('CLI flare mcp resources/prompts/tools --json（v0.6.113：结构化输出，与 server 协议回包同构）', () => {
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

  it('resources --json → { server, resources, templates }（空数组结构稳定）', async () => {
    const h = await startResServer()
    handles.push(h)
    const { code, stdout } = await runCli(['mcp', 'resources', 'remote', '--json', '--url', h.url])
    expect(code).toBe(0)
    const data = JSON.parse(stdout)
    expect(data.server).toBe('remote')
    expect(Array.isArray(data.resources)).toBe(true)
    expect(Array.isArray(data.templates)).toBe(true)
    expect(data.resources).toHaveLength(1)
    expect(data.resources[0]).toMatchObject({
      uri: 'flare://notes/hello',
      name: 'hello-note',
      description: '一条示例笔记',
      mimeType: 'text/plain',
    })
  }, 20000)

  it('resources --read --json → { server, uri, contents }（与 server mcp_read_resource 同构）', async () => {
    const h = await startResServer()
    handles.push(h)
    const { code, stdout } = await runCli(['mcp', 'resources', 'remote', '--read', 'flare://notes/hello', '--json', '--url', h.url])
    expect(code).toBe(0)
    const data = JSON.parse(stdout)
    expect(data.server).toBe('remote')
    expect(data.uri).toBe('flare://notes/hello')
    expect(Array.isArray(data.contents)).toBe(true)
    expect(data.contents[0].text).toBe('你好，这是资源内容')
  }, 20000)

  it('prompts --json → { server, prompts }（元数据 name/description/arguments）', async () => {
    const h = await startResServer()
    handles.push(h)
    const { code, stdout } = await runCli(['mcp', 'prompts', 'remote', '--json', '--url', h.url])
    expect(code).toBe(0)
    const data = JSON.parse(stdout)
    expect(data.server).toBe('remote')
    expect(Array.isArray(data.prompts)).toBe(true)
    expect(data.prompts).toHaveLength(1)
    expect(data.prompts[0]).toMatchObject({ name: 'greet', description: '生成问候语' })
    expect(data.prompts[0].arguments).toEqual([{ name: 'name', description: '称呼', required: true }])
  }, 20000)

  it('prompts --get --json → { server, prompt, description?, messages }（与 server mcp_get_prompt 同构）', async () => {
    const h = await startResServer()
    handles.push(h)
    const { code, stdout } = await runCli(['mcp', 'prompts', 'remote', '--get', 'greet', '--args', '{"name":"世界"}', '--json', '--url', h.url])
    expect(code).toBe(0)
    const data = JSON.parse(stdout)
    expect(data.server).toBe('remote')
    expect(data.prompt).toBe('greet')
    expect(data.description).toBe('生成问候语')
    expect(Array.isArray(data.messages)).toBe(true)
    expect(data.messages[0]).toEqual({
      role: 'user',
      content: { type: 'text', text: '你好，世界！' },
    })
  }, 20000)

  it('tools --json → { server, tools }（名称 + 描述 + inputSchema）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const { code, stdout } = await runCli(['mcp', 'tools', 'remote', '--json', '--url', h.url])
    expect(code).toBe(0)
    const data = JSON.parse(stdout)
    expect(data.server).toBe('remote')
    expect(Array.isArray(data.tools)).toBe(true)
    expect(data.tools).toHaveLength(1)
    expect(data.tools[0].name).toBe('echo')
    expect(data.tools[0].description).toMatch(/回显输入文本/)
    expect(data.tools[0].inputSchema).toBeTruthy()
  }, 20000)
})
