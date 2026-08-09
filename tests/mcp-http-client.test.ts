/**
 * MCP HTTP 客户端测试（v0.6.4）
 *
 * 与 stdio MCPClient 对称：起真实 MCP HTTP 服务器（startMcpHttpServer，随机端口），
 * 用 MCPHttpClient 消费——握手 / 工具列表 / 工具执行 / prompts / 错误码 / 通知 / 关闭后拒绝。
 * 传输契约（POST /mcp、202 通知、错误对象）已在 mcp-http.test.ts 覆盖，此处专注客户端行为。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { startMcpHttpServer, type McpHttpServerHandle } from '../src/mcp/http.js'
import { MCPHttpClient } from '../src/mcp/http-client.js'
import type { Tool, McpPrompt, McpResource } from '../src/index.js'

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

const failTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'boom',
      description: '总是失败',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: async () => ({ success: false, output: '', error: 'boom 失败' }),
}

const greetPrompt: McpPrompt = {
  name: 'greet',
  description: '问候模板',
  arguments: [{ name: 'name', required: true }],
  render: async (args) => [{ role: 'user', content: { type: 'text', text: `你好，${args.name || '世界'}！` } }],
  // v0.6.11：参数补全候选（completion/complete HTTP 消费端测试用）
  complete: async (argName, value) => {
    if (argName === 'name') {
      const all = ['flare', 'pulse', 'storyspire']
      return all.filter(v => v.startsWith(value))
    }
    return []
  },
}

const prefsResource: McpResource = {
  uri: 'memory://preferences',
  name: '用户偏好',
  description: '用户偏好设置',
  mimeType: 'text/plain',
  read: async () => '主题: 浅色',
}

const handles: McpHttpServerHandle[] = []
const clients: MCPHttpClient[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const h of handles.splice(0)) await h.close()
})

describe('MCPHttpClient（HTTP transport 消费端，与 stdio MCPClient 对称）', () => {
  it('initialize 握手 → capabilities.tools + serverInfo + 通知不报错', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const client = new MCPHttpClient({ url: h.url })
    clients.push(client)
    const info = await client.initialize()
    expect(info.protocolVersion).toBeTruthy()
    expect(info.capabilities.tools).toBeTruthy()
    expect(info.serverInfo?.name).toBe('flare')
    expect(client.serverName).toBe('flare')
    expect(client.isClosed).toBe(false)
  })

  it('listTools → 注入工具元数据', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const client = new MCPHttpClient({ url: h.url })
    clients.push(client)
    await client.initialize()
    const tools = await client.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('echo')
    expect(tools[0].description).toContain('回显')
  })

  it('callTool → 真实执行（成功 / 工具级失败 isError 标记不 reject）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool, failTool] })
    handles.push(h)
    const client = new MCPHttpClient({ url: h.url })
    clients.push(client)
    await client.initialize()
    const ok = await client.callTool('echo', { text: 'hello http client' })
    expect(ok.content[0].text).toBe('hello http client')
    expect(ok.isError).toBeFalsy() // 成功无 isError 标记（与 stdio MCPClient 一致：!!res?.isError）
    const fail = await client.callTool('boom')
    expect(fail.isError).toBe(true)
  })

  it('未知工具 → 协议错误 reject（-32602）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const client = new MCPHttpClient({ url: h.url })
    clients.push(client)
    await client.initialize()
    await expect(client.callTool('nope')).rejects.toThrow(/Unknown tool|MCP 错误/)
  })

  it('prompts 消费：listPrompts 元数据 + getPrompt 渲染（与 MCPServer 暴露对称闭环）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool], prompts: [greetPrompt] })
    handles.push(h)
    const client = new MCPHttpClient({ url: h.url })
    clients.push(client)
    const info = await client.initialize()
    // 注入 prompts → capabilities 声明 prompts
    expect(info.capabilities.prompts).toBeTruthy()
    const prompts = await client.listPrompts()
    expect(prompts).toHaveLength(1)
    expect(prompts[0].name).toBe('greet')
    expect(prompts[0].arguments?.[0].name).toBe('name')
    const rendered = await client.getPrompt('greet', { name: 'flare' })
    expect(rendered.messages[0].content.text).toBe('你好，flare！')
    // 未知 name → reject
    await expect(client.getPrompt('nope')).rejects.toThrow(/Unknown prompt|MCP 错误/)
    // v0.6.11：completion/complete HTTP 消费闭环——capabilities 声明 + 候选值 + 空匹配 + 未知 prompt reject
    expect(info.capabilities.completions).toBeTruthy()
    const comp = await client.completePrompt('greet', 'name', 'fl')
    expect(comp.values).toEqual(['flare'])
    const empty = await client.completePrompt('greet', 'name', 'zzz')
    expect(empty.values).toEqual([])
    await expect(client.completePrompt('nope', 'name', 'x')).rejects.toThrow(/Unknown prompt|MCP 错误/)
  })

  it('resources 消费：listResources 元数据 + readResource 内容（与 MCPServer 暴露对称闭环）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool], resources: [prefsResource] })
    handles.push(h)
    const client = new MCPHttpClient({ url: h.url })
    clients.push(client)
    const info = await client.initialize()
    // 注入 resources → capabilities 声明 resources
    expect(info.capabilities.resources).toBeTruthy()
    const resources = await client.listResources()
    expect(resources).toHaveLength(1)
    expect(resources[0].uri).toBe('memory://preferences')
    expect(resources[0].name).toBe('用户偏好')
    expect(resources[0].mimeType).toBe('text/plain')
    const contents = await client.readResource('memory://preferences')
    expect(contents).toHaveLength(1)
    expect(contents[0].uri).toBe('memory://preferences')
    expect(contents[0].text).toContain('浅色')
    // 未知 uri → reject（-32602）
    await expect(client.readResource('memory://nope')).rejects.toThrow(/Unknown resource|MCP 错误/)
  })

  it('ping → 健康检查 true', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const client = new MCPHttpClient({ url: h.url })
    clients.push(client)
    await client.initialize()
    await expect(client.ping()).resolves.toBe(true)
  })

  it('服务器关闭后请求 → reject（连接失败）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    const url = h.url
    await h.close() // 先关服务器
    const client = new MCPHttpClient({ url, timeoutMs: 2000 })
    clients.push(client)
    await expect(client.initialize()).rejects.toThrow(/MCP HTTP 请求失败/)
  })

  it('close 后请求 → 立即 reject（已关闭标记）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    const client = new MCPHttpClient({ url: h.url })
    clients.push(client)
    client.close()
    expect(client.isClosed).toBe(true)
    await expect(client.listTools()).rejects.toThrow(/已关闭/)
  })

  it('非法 URL → reject（URL 无效）', async () => {
    const client = new MCPHttpClient({ url: 'not-a-url', timeoutMs: 1000 })
    clients.push(client)
    await expect(client.initialize()).rejects.toThrow(/URL 无效/)
  })

  it('未知方法（HTTP 404 路径）→ reject（服务器回 JSON-RPC 错误对象）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    handles.push(h)
    // 故意连错误路径（服务器只认 /mcp → 404 + JSON-RPC 错误对象）
    const client = new MCPHttpClient({ url: h.url.replace(/\/mcp$/, '/wrong'), timeoutMs: 2000 })
    clients.push(client)
    await expect(client.initialize()).rejects.toThrow(/Not found|MCP 错误/)
  })
})
