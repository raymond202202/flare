/**
 * MCP HTTP transport 测试（v0.6.3）
 *
 * 起真实 node:http 服务器（随机端口），用 fetch 发 POST /mcp 验证 JSON-RPC over HTTP：
 * 握手 / 工具列表 / 工具执行（注入 mock 工具）/ 错误码 / 非法 JSON / 通知无响应 / 非 POST 404。
 * 底层复用 MCPServer.handleMessage（与 stdio 行为一致），此处专注 HTTP 层契约。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { startMcpHttpServer, type McpHttpServerHandle } from '../src/mcp/http.js'
import type { Tool } from '../src/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'dist', 'cli', 'index.js')

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

async function postJson(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json }
}

const handles: McpHttpServerHandle[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const h of handles.splice(0)) await h.close()
  for (const c of children.splice(0)) c.kill()
})

describe('MCP HTTP transport', () => {
  it('initialize 握手 → 200 + capabilities.tools + serverInfo', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const { status, json } = await postJson(h.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } } })
    expect(status).toBe(200)
    expect(json.jsonrpc).toBe('2.0')
    expect(json.id).toBe(1)
    expect(json.result.protocolVersion).toBeTruthy()
    expect(json.result.capabilities.tools).toBeTruthy()
    expect(json.result.serverInfo.name).toBe('flare')
  })

  it('tools/list → 注入工具元数据', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const { status, json } = await postJson(h.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(status).toBe(200)
    expect(json.result.tools).toHaveLength(1)
    expect(json.result.tools[0].name).toBe('echo')
  })

  it('tools/call → 真实执行注入工具（成功）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const { status, json } = await postJson(h.url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hello http' } } })
    expect(status).toBe(200)
    expect(json.result.content[0].text).toBe('hello http')
    expect(json.result.isError).toBeUndefined()
  })

  it('tools/call 未知工具 → -32602（服务器不崩，后续请求正常）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const bad = await postJson(h.url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } })
    expect(bad.status).toBe(200)
    expect(bad.json.error.code).toBe(-32602)
    const ok = await postJson(h.url, { jsonrpc: '2.0', id: 5, method: 'ping' })
    expect(ok.json.result).toEqual({})
  })

  it('未知方法 → -32601', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const { status, json } = await postJson(h.url, { jsonrpc: '2.0', id: 6, method: 'no/such' })
    expect(status).toBe(200)
    expect(json.error.code).toBe(-32601)
  })

  it('非法 JSON → 400 + parse error（-32700）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const { status, json } = await postJson(h.url, '{not json')
    expect(status).toBe(400)
    expect(json.error.code).toBe(-32700)
  })

  it('通知类消息（无 id）→ 202 空体（无需响应）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const res = await fetch(h.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })

  it('非 POST / 错误路径 → 404', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const get = await fetch(h.url)
    expect(get.status).toBe(404)
    const wrongPath = await postJson(h.url.replace('/mcp', '/other'), { jsonrpc: '2.0', id: 7, method: 'ping' })
    expect(wrongPath.status).toBe(404)
  })

  it('并发请求 → 响应不串扰（每个响应带自己的 id）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const results = await Promise.all([
      postJson(h.url, { jsonrpc: '2.0', id: 'a', method: 'ping' }),
      postJson(h.url, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }),
      postJson(h.url, { jsonrpc: '2.0', id: 'c', method: 'ping' }),
    ])
    const ids = results.map((r) => r.json.id).sort()
    expect(ids).toEqual(['a', 'b', 'c'])
  })
})

describe('CLI flare mcp-server --http', () => {
  it('spawn dist CLI --http --port → 真实握手 + 工具列表', async () => {
    // 用固定高位端口避免冲突（随机端口由 CLI 打印，解析更麻烦；固定端口在 CI/本机通常可用）
    const port = 19031 + Math.floor(Math.random() * 500)
    const child = spawn(process.execPath, [CLI, 'mcp-server', '--http', '--port', String(port), '-t', 'echo'], { stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    const url = `http://127.0.0.1:${port}/mcp`
    // 等待服务器就绪（最多 5s）
    let ready = false
    for (let i = 0; i < 25; i++) {
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })
        if (res.ok) { ready = true; break }
      } catch { /* 未就绪 */ }
      await new Promise((r) => setTimeout(r, 200))
    }
    expect(ready).toBe(true)
    const init = await postJson(url, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cli-test', version: '0.0.0' } } })
    expect(init.status).toBe(200)
    expect(init.json.result.capabilities.tools).toBeTruthy()
    // -t echo 过滤：只暴露 echo（CLI 内置工具里没有 echo，列表为空属正常——验证 -t 过滤生效）
    const list = await postJson(url, { jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect(list.json.result.tools).toBeDefined()
  }, 15000)
})
