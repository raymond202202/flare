/**
 * server 协议 mcp_resources 测试（v0.6.26）
 *
 * 资源桥接的协议层验证：flare server --mcp <config> 连接外部 MCP 服务器（mock fixture，
 * 真实 stdio 子进程）后，宿主可经 mcp_resources 请求查看其资源/模板清单（按服务器分组）。
 * 只读、不触发生成、不创建会话。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'dist', 'cli', 'index.js')
const MOCK_SERVER = path.join(__dirname, 'fixtures', 'mcp-mock-server.mjs')

let child: ChildProcess
let rl: Interface
let tempDir: string

function request(msg: any, expectTypes: string[], timeout = 15000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const msgs: any[] = []
    const timer = setTimeout(() => { cleanup(); reject(new Error(`超时（请求 ${JSON.stringify(msg).slice(0, 80)}）`)) }, timeout)
    const handler = (line: string) => {
      try {
        const parsed = JSON.parse(line)
        if (expectTypes.includes(parsed.type)) {
          msgs.push(parsed)
          cleanup()
          resolve(msgs)
        }
      } catch { /* 非 JSON 行忽略 */ }
    }
    const cleanup = () => { clearTimeout(timer); rl.removeListener('line', handler) }
    rl.on('line', handler)
    child.stdin!.write(JSON.stringify(msg) + '\n')
  })
}

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'flare-server-mcp-res-test-'))
  // --mcp 配置文件：连接 mock 服务器（真实 stdio 子进程，暴露 3 工具 + 2 资源 + 1 模板）
  const mcpConfig = path.join(tempDir, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify({
    servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }],
  }))
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  delete env.DEEPSEEK_API_KEY
  child = spawn(process.execPath, [CLI, 'server', '--storage', path.join(tempDir, 'test.db'), '--mcp', mcpConfig], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  rl = createInterface({ input: child.stdout! })
  // 等待服务就绪（version 响应）
  await request({ type: 'version' }, ['version'])
})

afterAll(() => {
  child.kill()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('flare host server mcp_resources 协议', () => {
  it('mcp_resources → 已连接服务器的资源/模板清单（真实子进程闭环）', async () => {
    const msgs = await request({ type: 'mcp_resources' }, ['mcp_resources'])
    const res = msgs[0]
    expect(res.type).toBe('mcp_resources')
    expect(Array.isArray(res.servers)).toBe(true)
    expect(res.servers.length).toBe(1)
    const s = res.servers[0]
    expect(s.name).toBe('mock')
    expect(s.connected).toBe(true)
    // 资源：mock 服务器暴露 2 个（memory://preferences + file:///etc/hosts）
    expect(Array.isArray(s.resources)).toBe(true)
    expect(s.resources.length).toBe(2)
    expect(s.resources[0]).toMatchObject({ server: 'mock', uri: 'memory://preferences', name: '用户偏好' })
    expect(s.resources[1].uri).toBe('file:///etc/hosts')
    // 模板：1 个动态资源模板
    expect(Array.isArray(s.templates)).toBe(true)
    expect(s.templates.length).toBe(1)
    expect(s.templates[0]).toMatchObject({ server: 'mock', uriTemplate: 'memory://{noteId}', name: '记忆条目' })
  }, 30000)

  it('mcp_status → 已连接带 resourceCount/templateCount（与 mcp_resources 一致）', async () => {
    const msgs = await request({ type: 'mcp_status' }, ['mcp_status'])
    const s = msgs[0].servers[0]
    expect(s.name).toBe('mock')
    expect(s.connected).toBe(true)
    expect(s.toolCount).toBe(3)
    expect(s.resourceCount).toBe(2)
    expect(s.templateCount).toBe(1)
  }, 30000)
})

describe('flare host server mcp_prompts 协议（v0.6.36 prompts 桥接）', () => {
  it('mcp_prompts → 已连接服务器的提示词清单（真实子进程闭环）', async () => {
    const msgs = await request({ type: 'mcp_prompts' }, ['mcp_prompts'])
    const res = msgs[0]
    expect(res.type).toBe('mcp_prompts')
    expect(Array.isArray(res.servers)).toBe(true)
    expect(res.servers.length).toBe(1)
    const s = res.servers[0]
    expect(s.name).toBe('mock')
    expect(s.connected).toBe(true)
    // 提示词：mock 服务器暴露 2 个（greet + summarize）
    expect(Array.isArray(s.prompts)).toBe(true)
    expect(s.prompts.length).toBe(2)
    expect(s.prompts[0]).toMatchObject({ server: 'mock', name: 'greet', description: '打招呼' })
    expect(s.prompts[1]).toMatchObject({ server: 'mock', name: 'summarize' })
    // 参数声明透传
    expect(s.prompts[1].arguments[0]).toMatchObject({ name: 'topic', required: true })
  }, 30000)

  it('mcp_status → 已连接带 promptCount（与 mcp_prompts 一致）', async () => {
    const msgs = await request({ type: 'mcp_status' }, ['mcp_status'])
    const s = msgs[0].servers[0]
    expect(s.name).toBe('mock')
    expect(s.connected).toBe(true)
    expect(s.promptCount).toBe(2)
  }, 30000)
})

describe('flare host server mcp_read_resource 协议（v0.6.38 资源内容读取代理）', () => {
  it('mcp_read_resource → 读取已连接服务器的资源内容（真实子进程闭环）', async () => {
    const msgs = await request({ type: 'mcp_read_resource', server: 'mock', uri: 'memory://preferences' }, ['mcp_read_resource'])
    const res = msgs[0]
    expect(res.type).toBe('mcp_read_resource')
    expect(res.server).toBe('mock')
    expect(res.uri).toBe('memory://preferences')
    expect(Array.isArray(res.contents)).toBe(true)
    expect(res.contents[0]).toMatchObject({ uri: 'memory://preferences', mimeType: 'text/plain', text: '主题: 浅色' })
  }, 30000)

  it('mcp_read_resource → 未知资源 error（透传外部服务器错误，服务不崩）', async () => {
    const msgs = await request({ type: 'mcp_read_resource', server: 'mock', uri: 'memory://ghost' }, ['error'])
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toMatch(/未知资源/)
  }, 30000)

  it('mcp_read_resource → 缺 server / uri error（含用法）', async () => {
    const msgs = await request({ type: 'mcp_read_resource', uri: 'memory://preferences' }, ['error'])
    expect(msgs[0].message).toMatch(/server 和 uri/)
    const msgs2 = await request({ type: 'mcp_read_resource', server: 'mock' }, ['error'])
    expect(msgs2[0].message).toMatch(/server 和 uri/)
  }, 30000)

  it('mcp_read_resource → 未连接服务器 error（清晰提示）', async () => {
    const msgs = await request({ type: 'mcp_read_resource', server: 'ghost', uri: 'memory://preferences' }, ['error'])
    expect(msgs[0].message).toMatch(/未连接/)
  }, 30000)
})

describe('flare host server mcp_get_prompt 协议（v0.6.38 提示词渲染代理）', () => {
  it('mcp_get_prompt → 渲染已连接服务器的提示词（真实子进程闭环）', async () => {
    const msgs = await request({ type: 'mcp_get_prompt', server: 'mock', prompt: 'greet' }, ['mcp_get_prompt'])
    const res = msgs[0]
    expect(res.type).toBe('mcp_get_prompt')
    expect(res.server).toBe('mock')
    expect(res.prompt).toBe('greet')
    expect(Array.isArray(res.messages)).toBe(true)
    expect(res.messages[0]).toMatchObject({ role: 'user', content: { type: 'text', text: '你好' } })
  }, 30000)

  it('mcp_get_prompt → 带参数渲染（arguments 补全）', async () => {
    const msgs = await request({ type: 'mcp_get_prompt', server: 'mock', prompt: 'summarize', args: { topic: 'flare 引擎' } }, ['mcp_get_prompt'])
    const res = msgs[0]
    expect(res.type).toBe('mcp_get_prompt')
    expect(res.description).toBe('总结内容')
    expect(res.messages[0].content.text).toBe('请总结关于「flare 引擎」的内容')
  }, 30000)

  it('mcp_get_prompt → 未知提示词 error（透传外部服务器错误，服务不崩）', async () => {
    const msgs = await request({ type: 'mcp_get_prompt', server: 'mock', prompt: 'ghost' }, ['error'])
    expect(msgs[0].message).toMatch(/未知提示词/)
  }, 30000)

  it('mcp_get_prompt → 缺 server / prompt error（含用法）', async () => {
    const msgs = await request({ type: 'mcp_get_prompt', server: 'mock' }, ['error'])
    expect(msgs[0].message).toMatch(/server 和 prompt/)
    const msgs2 = await request({ type: 'mcp_get_prompt', prompt: 'greet' }, ['error'])
    expect(msgs2[0].message).toMatch(/server 和 prompt/)
  }, 30000)

  it('mcp_get_prompt → 未连接服务器 error（清晰提示）', async () => {
    const msgs = await request({ type: 'mcp_get_prompt', server: 'ghost', prompt: 'greet' }, ['error'])
    expect(msgs[0].message).toMatch(/未连接/)
  }, 30000)
})

describe('flare host server mcp_call 协议（v0.6.40 工具调用代理）', () => {
  it('mcp_call → 调用已连接服务器的工具（真实子进程闭环，参数透传）', async () => {
    const msgs = await request({ type: 'mcp_call', server: 'mock', tool: 'add_numbers', args: { a: 2, b: 3 } }, ['mcp_call'])
    const res = msgs[0]
    expect(res.type).toBe('mcp_call')
    expect(res.server).toBe('mock')
    expect(res.tool).toBe('add_numbers')
    expect(res.success).toBe(true)
    expect(res.output).toBe('5')
  }, 30000)

  it('mcp_call → 工具级失败 success:false + error（isError 透传，服务不崩）', async () => {
    const msgs = await request({ type: 'mcp_call', server: 'mock', tool: 'fail_tool' }, ['mcp_call'])
    const res = msgs[0]
    expect(res.type).toBe('mcp_call')
    expect(res.success).toBe(false)
    expect(res.error).toContain('出错了')
  }, 30000)

  it('mcp_call → 未知工具 error（透传外部服务器错误，服务不崩）', async () => {
    const msgs = await request({ type: 'mcp_call', server: 'mock', tool: 'ghost_tool' }, ['error'])
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toMatch(/未知工具/)
  }, 30000)

  it('mcp_call → 缺 server / tool error（含用法）', async () => {
    const msgs = await request({ type: 'mcp_call', tool: 'echo_text' }, ['error'])
    expect(msgs[0].message).toMatch(/server 和 tool/)
    const msgs2 = await request({ type: 'mcp_call', server: 'mock' }, ['error'])
    expect(msgs2[0].message).toMatch(/server 和 tool/)
  }, 30000)

  it('mcp_call → 未连接服务器 error（清晰提示）', async () => {
    const msgs = await request({ type: 'mcp_call', server: 'ghost', tool: 'echo_text' }, ['error'])
    expect(msgs[0].message).toMatch(/未连接/)
  }, 30000)
})

describe('flare host server mcp_call 非 text 内容（v0.6.117）', () => {
  let richChild: ChildProcess
  let richRl: Interface
  let richDir: string

  function richRequest(msg: any, expectTypes: string[], timeout = 15000): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const msgs: any[] = []
      const timer = setTimeout(() => { richCleanup(); reject(new Error(`超时（请求 ${JSON.stringify(msg).slice(0, 80)}）`)) }, timeout)
      const handler = (line: string) => {
        try {
          const parsed = JSON.parse(line)
          if (expectTypes.includes(parsed.type)) {
            msgs.push(parsed)
            richCleanup()
            resolve(msgs)
          }
        } catch { /* 非 JSON 行忽略 */ }
      }
      const richCleanup = () => { clearTimeout(timer); richRl.removeListener('line', handler) }
      richRl.on('line', handler)
      richChild.stdin!.write(JSON.stringify(msg) + '\n')
    })
  }

  beforeAll(async () => {
    richDir = mkdtempSync(path.join(os.tmpdir(), 'flare-server-mcp-rich-'))
    const mcpConfig = path.join(richDir, 'mcp.json')
    writeFileSync(mcpConfig, JSON.stringify({
      servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }],
    }))
    const env: Record<string, string> = { ...process.env, MOCK_MODE: 'rich' } as Record<string, string>
    delete env.DEEPSEEK_API_KEY
    richChild = spawn(process.execPath, [CLI, 'server', '--storage', path.join(richDir, 'test.db'), '--mcp', mcpConfig], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    richRl = createInterface({ input: richChild.stdout! })
    await richRequest({ type: 'version' }, ['version'])
  })

  afterAll(() => {
    richChild.kill()
    rmSync(richDir, { recursive: true, force: true })
  })

  it('mcp_call 非 text 内容（rich 模式）→ output 含占位描述，绝不含 base64 明文', async () => {
    const msgs = await richRequest({ type: 'mcp_call', server: 'mock', tool: 'echo_text', args: { text: 'hi' } }, ['mcp_call'])
    const res = msgs[0]
    expect(res.type).toBe('mcp_call')
    expect(res.success).toBe(true)
    expect(res.output).toContain('echo: hi')
    expect(res.output).toContain('[图片 mimeType: image/png')
    expect(res.output).toContain('[音频 mimeType: audio/wav')
    expect(res.output).toContain('[资源 uri: file:///tmp/a.txt')
    expect(res.output).not.toContain('aGVsbG8taW1hZ2U=')
    expect(res.output).not.toContain('YXVkaW8tZGF0YQ==')
  }, 30000)

  it('mcp_call 纯 text 回归（非 rich 服务器）→ output 与旧版逐字一致', async () => {
    // 复用外层默认服务器（非 rich）：add_numbers 仍返回纯 text '5'，与旧行为一致
    const msgs = await request({ type: 'mcp_call', server: 'mock', tool: 'add_numbers', args: { a: 2, b: 3 } }, ['mcp_call'])
    expect(msgs[0].output).toBe('5')
  }, 30000)
})
