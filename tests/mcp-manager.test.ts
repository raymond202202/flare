/**
 * McpManager 测试（v0.5.5；v0.6.6 起覆盖 HTTP transport）
 *
 * 配置加载（~/.flare/mcp.json 语义）+ connect/disconnect + 工具并集 + 错误记录。
 * 用 mock MCP server fixture（本地子进程，无网络）+ in-process HTTP 服务器（startMcpHttpServer）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { McpManager, loadMcpConfig } from '../src/mcp/manager.js'
import { startMcpHttpServer, type McpHttpServerHandle } from '../src/mcp/http.js'
import type { Tool } from '../src/tools/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
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

let dir: string
let configPath: string
const httpHandles: McpHttpServerHandle[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-mcp-mgr-test-'))
  configPath = join(dir, 'mcp.json')
})

afterEach(async () => {
  for (const h of httpHandles.splice(0)) await h.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('loadMcpConfig', () => {
  it('文件不存在 → 空列表（不抛错）', () => {
    expect(loadMcpConfig(join(dir, 'missing.json'))).toEqual([])
  })

  it('非法 JSON → 空列表（不抛错）', () => {
    writeFileSync(configPath, '{not json')
    expect(loadMcpConfig(configPath)).toEqual([])
  })

  it('合法配置 → 返回 servers 列表', () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'fs', command: 'npx' }, { name: 'db', command: 'node', args: ['srv.js'] }] }))
    const servers = loadMcpConfig(configPath)
    expect(servers.length).toBe(2)
    expect(servers[0].name).toBe('fs')
    expect(servers[1].args).toEqual(['srv.js'])
  })
})

describe('McpManager', () => {
  it('connect：连接 mock 服务器 → 工具桥接进入 getAllTools + 状态标记连接', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    const tools = await mgr.connect('mock')
    expect(tools.length).toBe(3)
    expect(tools.map(t => t.definition.function.name)).toContain('echo_text')
    expect(mgr.getAllTools().length).toBe(3)
    const st = mgr.status()
    expect(st[0].connected).toBe(true)
    expect(st[0].toolCount).toBe(3)
    expect(st[0].error).toBeUndefined()
    // v0.6.50：传输类型 + 目标命令（stdio 服务器显示 command + args）
    expect(st[0].transport).toBe('stdio')
    expect(st[0].target).toContain(MOCK_SERVER)
    mgr.closeAll()
  })

  it('getAllToolsRef：返回工具引用（含来源服务器名 + 名称/描述，v0.6.58 工具清单）', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('mock')
    const refs = mgr.getAllToolsRef()
    expect(refs.length).toBe(3)
    // 含来源服务器名（与 getAllResources/getAllPrompts 同构）
    for (const r of refs) expect(r.server).toBe('mock')
    // 名称 + 描述（mcp_status 只有 toolCount 数量，宿主在 mcp_call 前需要知道具体工具名/描述）
    const echo = refs.find((r) => r.name === 'echo_text')
    expect(echo?.description).toBe('回显输入文本')
    const add = refs.find((r) => r.name === 'add_numbers')
    expect(add?.description).toBe('两个数相加')
    const fail = refs.find((r) => r.name === 'fail_tool')
    expect(fail?.description).toBe('总是失败的工具（测 isError 映射）')
    mgr.closeAll()
  })

  it('getAllToolsRef：未连接时返回空数组（幂等不抛错）', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    expect(mgr.getAllToolsRef()).toEqual([])
    mgr.closeAll()
  })

  it('connect 幂等：重复连接返回已有工具（不重复 spawn）', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('mock')
    const again = await mgr.connect('mock')
    expect(again.length).toBe(3)
    expect(mgr.getAllTools().length).toBe(3) // 不重复累积
    mgr.closeAll()
  })

  it('connect 未配置名称 → 抛错 + 状态记录错误', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    await expect(mgr.connect('nope')).rejects.toThrow(/未配置 MCP 服务器/)
    expect(mgr.getAllTools().length).toBe(0)
    mgr.closeAll()
  })

  it('connect 启动失败（命令不存在）→ 抛错 + 状态记录错误（服务不崩溃）', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'bad', command: 'definitely-not-a-real-cmd-xyz', args: [] }] }))
    const mgr = new McpManager({ configPath })
    await expect(mgr.connect('bad')).rejects.toThrow()
    const st = mgr.status()
    expect(st[0].connected).toBe(false)
    expect(st[0].error).toBeTruthy()
    mgr.closeAll()
  })

  it('disconnect：断开后工具移除 + 状态标记断开', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('mock')
    expect(mgr.disconnect('mock')).toBe(true)
    expect(mgr.getAllTools().length).toBe(0)
    expect(mgr.status()[0].connected).toBe(false)
    // 幂等：再次断开返回 false
    expect(mgr.disconnect('mock')).toBe(false)
    mgr.closeAll()
  })

  it('setConfig：不依赖配置文件直接注入配置（server --mcp 场景）', async () => {
    const mgr = new McpManager({ configPath: '' })
    mgr.setConfig([{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }])
    const tools = await mgr.connect('mock')
    expect(tools.length).toBe(3)
    mgr.closeAll()
  })

  it('connect HTTP transport（配置 url）→ 工具桥接 + 真实执行 + 状态连接', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    httpHandles.push(h)
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'remote', url: h.url }] }))
    const mgr = new McpManager({ configPath })
    const tools = await mgr.connect('remote')
    expect(tools.length).toBe(1)
    expect(tools[0].definition.function.name).toBe('echo')
    // 桥接工具经 HTTP transport 真实执行到 in-process 服务器
    const res = await tools[0].execute({ text: 'via http' })
    expect(res.success).toBe(true)
    expect(res.output).toBe('via http')
    const st = mgr.status()
    expect(st[0].connected).toBe(true)
    expect(st[0].toolCount).toBe(1)
    expect(st[0].error).toBeUndefined()
    // v0.6.50：HTTP transport 服务器标记 http + 端点 url
    expect(st[0].transport).toBe('http')
    expect(st[0].target).toBe(h.url)
    mgr.closeAll()
  })

  it('connect HTTP transport 配置 headers → 每次请求携带鉴权头（v0.6.67）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    httpHandles.push(h)
    const seenAuth: string[] = []
    h.http.on('request', (req) => {
      const auth = req.headers['authorization']
      if (auth) seenAuth.push(String(auth))
    })
    writeFileSync(configPath, JSON.stringify({
      servers: [{ name: 'secure', url: h.url, headers: { Authorization: 'Bearer mgr-token-456' } }],
    }))
    const mgr = new McpManager({ configPath })
    const tools = await mgr.connect('secure')
    expect(tools.length).toBe(1)
    // 桥接工具执行也带鉴权头（HTTP 请求全部透传 headers）
    const res = await tools[0].execute({ text: 'via-auth' })
    expect(res.success).toBe(true)
    expect(res.output).toBe('via-auth')
    expect(seenAuth.length).toBeGreaterThanOrEqual(1)
    expect(seenAuth.every((a) => a === 'Bearer mgr-token-456')).toBe(true)
    const st = mgr.status()
    expect(st[0].connected).toBe(true)
    expect(st[0].error).toBeUndefined()
    // v0.6.70：配了 headers → auth 标记（只传 boolean 不传 token）
    expect(st[0].auth).toBe(true)
    mgr.closeAll()
  })

  it('connect HTTP transport 无 headers 配置 → status.auth 缺省 undefined（向后兼容，v0.6.70）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    httpHandles.push(h)
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'anon', url: h.url }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('anon')
    const st = mgr.status()
    expect(st[0].auth).toBeUndefined()
    mgr.closeAll()
  })

  it('connect HTTP 不可达（url 无服务器监听）→ 抛错 + 状态记录错误（服务不崩溃）', async () => {
    // 先起服务器拿端口，再关掉 → 端口无人监听（连接拒绝）
    const h = await startMcpHttpServer({ tools: [echoTool] })
    const url = h.url
    await h.close()
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'dead', url }] }))
    const mgr = new McpManager({ configPath, httpTimeoutMs: 1000 })
    await expect(mgr.connect('dead')).rejects.toThrow()
    const st = mgr.status()
    expect(st[0].connected).toBe(false)
    expect(st[0].error).toBeTruthy()
    expect(mgr.getAllTools().length).toBe(0)
    mgr.closeAll()
  })

  it('connect 配置既无 url 也无 command → 抛错（清晰提示）', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'empty', args: [] }] }))
    const mgr = new McpManager({ configPath })
    await expect(mgr.connect('empty')).rejects.toThrow(/配置无效/)
    mgr.closeAll()
  })

  // ===== v0.6.26 资源桥接：连接时拉取 resources/list + resources/templates/list =====

  it('connect 资源桥接：getAllResources / getAllResourceTemplates 返回带来源的资源（mock 服务器）', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('mock')
    const resources = mgr.getAllResources()
    expect(resources.length).toBe(2)
    expect(resources[0]).toMatchObject({ server: 'mock', uri: 'memory://preferences', name: '用户偏好' })
    expect(resources[1]).toMatchObject({ server: 'mock', uri: 'file:///etc/hosts', name: 'hosts 文件' })
    const templates = mgr.getAllResourceTemplates()
    expect(templates.length).toBe(1)
    expect(templates[0]).toMatchObject({ server: 'mock', uriTemplate: 'memory://{noteId}', name: '记忆条目' })
    // status 带资源/模板数（向后兼容：新增字段可选）
    const st = mgr.status()
    expect(st[0].connected).toBe(true)
    expect(st[0].resourceCount).toBe(2)
    expect(st[0].templateCount).toBe(1)
    mgr.closeAll()
  })

  it('readResource：代理读取某服务器资源内容；未知 uri reject；未连接服务器 reject', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('mock')
    const contents = await mgr.readResource('mock', 'memory://preferences')
    expect(contents.length).toBe(1)
    expect(contents[0].uri).toBe('memory://preferences')
    expect(contents[0].text).toContain('浅色')
    await expect(mgr.readResource('mock', 'memory://ghost')).rejects.toThrow()
    await expect(mgr.readResource('not-connected', 'memory://preferences')).rejects.toThrow(/未连接/)
    mgr.closeAll()
  })

  it('disconnect：资源/模板随连接清理（getAllResources 空 + status 不再带资源数）', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('mock')
    expect(mgr.getAllResources().length).toBe(2)
    expect(mgr.disconnect('mock')).toBe(true)
    expect(mgr.getAllResources().length).toBe(0)
    expect(mgr.getAllResourceTemplates().length).toBe(0)
    const st = mgr.status()
    expect(st[0].resourceCount).toBeUndefined()
    mgr.closeAll()
  })

  it('connect 无 resources 能力的服务器 → 资源空数组 + status resourceCount 0（不阻塞连接）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] }) // 无 resources 注入
    httpHandles.push(h)
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'remote', url: h.url }] }))
    const mgr = new McpManager({ configPath })
    const tools = await mgr.connect('remote')
    expect(tools.length).toBe(1)
    expect(mgr.getAllResources().length).toBe(0)
    expect(mgr.getAllResourceTemplates().length).toBe(0)
    const st = mgr.status()
    expect(st[0].resourceCount).toBe(0)
    expect(st[0].templateCount).toBe(0)
    mgr.closeAll()
  })

  it('connect HTTP transport 资源桥接：注入 resources 的 HTTP 服务器 → 资源拉取 + 读取闭环', async () => {
    const noteRes = {
      uri: 'memory://note-1',
      name: '笔记 1',
      description: '一条记忆',
      mimeType: 'text/plain',
    }
    const h = await startMcpHttpServer({
      tools: [echoTool],
      resources: [{
        ...noteRes,
        read: async () => '笔记内容: 你好',
      }],
    })
    httpHandles.push(h)
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'remote', url: h.url }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('remote')
    const resources = mgr.getAllResources()
    expect(resources.length).toBe(1)
    expect(resources[0]).toMatchObject({ server: 'remote', uri: 'memory://note-1', name: '笔记 1' })
    const contents = await mgr.readResource('remote', 'memory://note-1')
    expect(contents[0].text).toContain('你好')
    mgr.closeAll()
  })

  it('disconnect HTTP 服务器：工具移除 + 状态断开', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    httpHandles.push(h)
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'remote', url: h.url }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('remote')
    expect(mgr.disconnect('remote')).toBe(true)
    expect(mgr.getAllTools().length).toBe(0)
    expect(mgr.status()[0].connected).toBe(false)
    // 幂等：再次断开返回 false
    expect(mgr.disconnect('remote')).toBe(false)
    mgr.closeAll()
  })

  // ===== v0.6.36 prompts 桥接：连接时拉取 prompts/list + 代理渲染 prompts/get =====

  it('connect prompts 桥接：getAllPrompts 返回带来源的提示词（mock 服务器，stdio）', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('mock')
    const prompts = mgr.getAllPrompts()
    expect(prompts.length).toBe(2)
    expect(prompts[0]).toMatchObject({ server: 'mock', name: 'greet', description: '打招呼' })
    expect(prompts[1]).toMatchObject({ server: 'mock', name: 'summarize' })
    // 参数声明透传（prompts/list 元数据）
    expect(Array.isArray(prompts[1].arguments)).toBe(true)
    expect(prompts[1].arguments![0]).toMatchObject({ name: 'topic', required: true })
    // status 带提示词数（新增字段可选，向后兼容）
    const st = mgr.status()
    expect(st[0].connected).toBe(true)
    expect(st[0].promptCount).toBe(2)
    mgr.closeAll()
  })

  it('getPrompt：代理渲染某服务器提示词（带参数）；未连接服务器 reject', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('mock')
    const res = await mgr.getPrompt('mock', 'summarize', { topic: 'flare' })
    expect(res.messages.length).toBe(1)
    expect(res.messages[0].role).toBe('user')
    expect(res.messages[0].content.text).toContain('flare')
    // 未知提示词 → 协议错误 reject
    await expect(mgr.getPrompt('mock', 'ghost')).rejects.toThrow()
    // 未连接服务器 → 清晰错误
    await expect(mgr.getPrompt('not-connected', 'greet')).rejects.toThrow(/未连接/)
    mgr.closeAll()
  })

  it('callTool：代理调用某服务器工具（带参数）；工具失败 isError 透传；未连接服务器 reject', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('mock')
    // 成功路径（参数透传）
    const ok = await mgr.callTool('mock', 'add_numbers', { a: 2, b: 3 })
    expect(ok.isError).toBeFalsy()
    const text = ok.content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n')
    expect(text).toBe('5')
    // 工具级失败（isError 透传，不抛）
    const fail = await mgr.callTool('mock', 'fail_tool')
    expect(fail.isError).toBe(true)
    // 协议层错误（未知工具）→ reject
    await expect(mgr.callTool('mock', 'ghost_tool')).rejects.toThrow()
    // 未连接服务器 → 清晰错误
    await expect(mgr.callTool('not-connected', 'echo_text')).rejects.toThrow(/未连接/)
    mgr.closeAll()
  })

  it('completePrompt：代理请求提示词参数补全（v0.6.57）；未知引用 reject；未连接 reject', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('mock')
    // summarize 的 topic 参数：前缀 "flare" → 4 个候选
    const res = await mgr.completePrompt('mock', 'summarize', 'topic', 'flare')
    expect(res.values.length).toBe(4)
    expect(res.values).toContain('flare 缓存')
    expect(res.total).toBe(4)
    expect(res.hasMore).toBe(false)
    // 前缀过滤：'flare M' → 1 个
    const narrow = await mgr.completePrompt('mock', 'summarize', 'topic', 'flare M')
    expect(narrow.values).toEqual(['flare MCP'])
    // 未知提示词/参数 → 协议错误 reject
    await expect(mgr.completePrompt('mock', 'ghost', 'topic', 'x')).rejects.toThrow()
    await expect(mgr.completePrompt('mock', 'summarize', 'nope', 'x')).rejects.toThrow()
    // 未连接服务器 → 清晰错误
    await expect(mgr.completePrompt('not-connected', 'summarize', 'topic', 'x')).rejects.toThrow(/未连接/)
    mgr.closeAll()
  })

  it('callTool HTTP transport：代理调用注入工具的 HTTP 服务器', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    httpHandles.push(h)
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'remote', url: h.url }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('remote')
    const res = await mgr.callTool('remote', 'echo', { text: 'hi' })
    const text = res.content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n')
    expect(text).toContain('hi')
    mgr.closeAll()
  })

  it('disconnect：提示词随连接清理（getAllPrompts 空 + status 不再带提示词数）', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('mock')
    expect(mgr.getAllPrompts().length).toBe(2)
    expect(mgr.disconnect('mock')).toBe(true)
    expect(mgr.getAllPrompts().length).toBe(0)
    const st = mgr.status()
    expect(st[0].promptCount).toBeUndefined()
    mgr.closeAll()
  })

  it('connect 无 prompts 能力的服务器 → 提示词空数组 + status promptCount 0（不阻塞连接）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] }) // 无 prompts 注入
    httpHandles.push(h)
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'remote', url: h.url }] }))
    const mgr = new McpManager({ configPath })
    const tools = await mgr.connect('remote')
    expect(tools.length).toBe(1)
    expect(mgr.getAllPrompts().length).toBe(0)
    const st = mgr.status()
    expect(st[0].promptCount).toBe(0)
    mgr.closeAll()
  })

  it('connect HTTP transport prompts 桥接：注入 prompts 的 HTTP 服务器 → 提示词拉取 + 渲染闭环', async () => {
    const h = await startMcpHttpServer({
      tools: [echoTool],
      prompts: [{
        name: 'hello',
        description: '打招呼',
        render: async (args) => [{ role: 'user', content: { type: 'text', text: `你好 ${args?.who || '世界'}` } }],
      }],
    })
    httpHandles.push(h)
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'remote', url: h.url }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('remote')
    const prompts = mgr.getAllPrompts()
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toMatchObject({ server: 'remote', name: 'hello', description: '打招呼' })
    const res = await mgr.getPrompt('remote', 'hello', { who: 'flare' })
    expect(res.messages[0].content.text).toContain('flare')
    mgr.closeAll()
  })

  it('配置同时有 url 与 command → url 优先（HTTP transport）', async () => {
    const h = await startMcpHttpServer({ tools: [echoTool] })
    httpHandles.push(h)
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'both', url: h.url, command: 'should-not-spawn', args: [] }] }))
    const mgr = new McpManager({ configPath })
    const tools = await mgr.connect('both')
    expect(tools[0].definition.function.name).toBe('echo')
    const res = await tools[0].execute({ text: 'url wins' })
    expect(res.output).toBe('url wins')
    mgr.closeAll()
  })
})
