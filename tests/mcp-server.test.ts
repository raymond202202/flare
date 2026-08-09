import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { MCPServer, toMcpTool } from '../src/mcp/server.js'
import { MCPClient } from '../src/mcp/client.js'
import { readFileTool, type Tool } from '../src/tools/index.js'
import type { McpPrompt, McpResource } from '../src/mcp/types.js'
import { MCP_PROTOCOL_VERSION } from '../src/mcp/client.js'
import pkg from '../package.json' with { type: 'json' }

const __dirname = dirname(fileURLToPath(import.meta.url))
const TSK_CLI = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))
const FLARE_SERVER_FIXTURE = join(__dirname, 'fixtures', 'mcp-flare-server.ts')
const FLARE_SERVER_PROMPTS_FIXTURE = join(__dirname, 'fixtures', 'mcp-flare-server-prompts.ts')
const FLARE_SERVER_ROOTS_FIXTURE = join(__dirname, 'fixtures', 'mcp-flare-server-roots.ts')

/** 测试用工具：回显 / 慢（模拟慢工具验证串行响应） */
const echoTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'echo',
      description: '回显文本',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  },
  execute: (async (args: { text: string }) => ({ success: true, output: `echo: ${args.text}` })) as any,
}

const slowTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'slow',
      description: '慢工具（50ms）',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: (async () => {
    await new Promise((r) => setTimeout(r, 50))
    return { success: true, output: 'slow-done' }
  }) as any,
}

/** 进程内测试台：注入 input/write，模拟 MCP 客户端逐行发请求 */
function createHarness(customTools?: Tool[], customResources?: McpResource[], customPrompts?: McpPrompt[], requestTimeoutMs?: number) {
  const writes: string[] = []
  const input = new Readable({ read() {} })
  const server = new MCPServer({
    tools: customTools,
    resources: customResources,
    prompts: customPrompts,
    write: (l) => writes.push(l),
    input,
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
  })
  server.start()
  const send = (obj: unknown) => { input.push(JSON.stringify(obj) + '\n') }
  const flush = () => new Promise<void>((r) => setTimeout(r, 30))
  const responses = () => writes.map((w) => JSON.parse(w))
  const last = () => responses()[responses().length - 1]
  return { server, send, flush, responses, last, writes, input }
}

/** 轮询等待 JSON 文件出现（e2e fixture 写结果用），超时抛错 */
async function waitForFile(path: string, timeoutMs = 6000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const content = readFileSync(path, 'utf-8')
      if (content.trim()) return JSON.parse(content)
    } catch { /* 文件未就绪 */ }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`等待文件超时: ${path}`)
}

describe('MCPServer（stdio NDJSON JSON-RPC，零依赖）', () => {
  it('initialize 握手：协议版本 + capabilities.tools + serverInfo（name=flare，version=package.json）', async () => {
    const h = createHarness()
    h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } } })
    await h.flush()
    const res = h.last()
    expect(res.id).toBe(1)
    expect(res.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION)
    expect(res.result.capabilities).toHaveProperty('tools')
    expect(res.result.serverInfo.name).toBe('flare')
    expect(res.result.serverInfo.version).toBe(pkg.version)
    h.server.close()
  })

  it('tools/list：默认暴露内置工具集（read_file 等 6 个，含 schema）', async () => {
    const h = createHarness()
    h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    await h.flush()
    const res = h.last()
    const names = res.result.tools.map((t: any) => t.name)
    expect(names).toEqual(['read_file', 'write_file', 'search_files', 'terminal', 'memory_search', 'memory_save'])
    const readFile = res.result.tools.find((t: any) => t.name === 'read_file')
    expect(readFile.description).toContain('读取文件')
    expect(readFile.inputSchema).toHaveProperty('properties')
    expect(readFile.inputSchema.required).toContain('path')
    h.server.close()
  })

  it('tools/call：调用成功 → content text + 无 isError（read_file 读 package.json）', async () => {
    const h = createHarness()
    h.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'package.json' } } })
    await h.flush()
    const res = h.last()
    expect(res.result.isError).toBeUndefined()
    expect(res.result.content[0].type).toBe('text')
    expect(res.result.content[0].text).toContain('flare-agent')
    h.server.close()
  })

  it('tools/call：工具级失败 → isError=true + 错误文本（不抛协议错误）', async () => {
    const h = createHarness()
    h.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_file', arguments: { path: '/no/such/file-xyz' } } })
    await h.flush()
    const res = h.last()
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toContain('文件不存在')
    h.server.close()
  })

  it('tools/call：未知工具 → JSON-RPC error -32602', async () => {
    const h = createHarness()
    h.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } })
    await h.flush()
    const res = h.last()
    expect(res.error.code).toBe(-32602)
    expect(res.error.message).toContain('Unknown tool')
    h.server.close()
  })

  it('未知方法 → JSON-RPC error -32601', async () => {
    const h = createHarness()
    h.send({ jsonrpc: '2.0', id: 6, method: 'bogus/method', params: {} })
    await h.flush()
    const res = h.last()
    expect(res.error.code).toBe(-32601)
    expect(res.error.message).toContain('Method not found')
    h.server.close()
  })

  it('ping → result {}（JSON-RPC 健康检查）', async () => {
    const h = createHarness()
    h.send({ jsonrpc: '2.0', id: 7, method: 'ping', params: {} })
    await h.flush()
    expect(h.last().result).toEqual({})
    h.server.close()
  })

  it('JSON 解析失败 → parse error（id null, -32700）', async () => {
    const h = createHarness()
    h.input.push('{not valid json\n')
    await h.flush()
    const res = h.last()
    expect(res.id).toBeNull()
    expect(res.error.code).toBe(-32700)
    h.server.close()
  })

  it('通知（无 id）→ 无响应（notifications/initialized 被忽略）', async () => {
    const h = createHarness()
    h.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await h.flush()
    expect(h.writes.length).toBe(0)
    h.server.close()
  })

  it('自定义工具注入：tools/list 只暴露注入的工具', async () => {
    const h = createHarness([echoTool])
    h.send({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} })
    await h.flush()
    expect(h.last().result.tools.map((t: any) => t.name)).toEqual(['echo'])
    h.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } })
    await h.flush()
    expect(h.last().result.content[0].text).toBe('echo: hi')
    h.server.close()
  })

  it('慢工具不阻塞后续请求：响应按请求顺序返回（串行队列）', async () => {
    const h = createHarness([slowTool, echoTool])
    h.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: {} } })
    h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'after' } } })
    // 轮询等待两个响应都写出（slow 耗时 50ms > 单次 flush）
    const deadline = Date.now() + 3000
    while (h.responses().length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    const resps = h.responses()
    expect(resps[0].id).toBe(1)
    expect(resps[0].result.content[0].text).toBe('slow-done')
    expect(resps[1].id).toBe(2)
    expect(resps[1].result.content[0].text).toBe('echo: after')
    h.server.close()
  })

  it('close 后不再响应新请求（幂等）', async () => {
    const h = createHarness([echoTool])
    h.server.close()
    h.server.close()
    h.send({ jsonrpc: '2.0', id: 10, method: 'ping', params: {} })
    await h.flush()
    expect(h.writes.length).toBe(0)
  })

  it('resources/list 与 prompts/list：返回空列表（真实客户端探测兼容）', async () => {
    const h = createHarness()
    h.send({ jsonrpc: '2.0', id: 11, method: 'resources/list', params: {} })
    h.send({ jsonrpc: '2.0', id: 12, method: 'prompts/list', params: {} })
    await h.flush()
    const resps = h.responses()
    expect(resps[0].result).toEqual({ resources: [] })
    expect(resps[1].result).toEqual({ prompts: [] })
    h.server.close()
  })

  it('resources/list：注入的资源真实暴露（uri/name/description/mimeType 元数据）', async () => {
    const resources: McpResource[] = [
      { uri: 'memory://preferences', name: '用户偏好', description: '用户的持久偏好记忆', mimeType: 'text/plain', read: () => '偏好深色主题' },
      { uri: 'file:///etc/hostname', name: '主机名', read: () => 'flare-host' },
    ]
    const h = createHarness(undefined, resources)
    h.send({ jsonrpc: '2.0', id: 1, method: 'resources/list', params: {} })
    await h.flush()
    const res = h.last()
    expect(res.result.resources).toEqual([
      { uri: 'memory://preferences', name: '用户偏好', description: '用户的持久偏好记忆', mimeType: 'text/plain' },
      { uri: 'file:///etc/hostname', name: '主机名' },
    ])
    h.server.close()
  })

  it('resources/read：读取资源内容（同步 read + mimeType）', async () => {
    const resources: McpResource[] = [
      { uri: 'memory://preferences', name: '用户偏好', mimeType: 'text/plain', read: () => '偏好深色主题' },
    ]
    const h = createHarness(undefined, resources)
    h.send({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'memory://preferences' } })
    await h.flush()
    const res = h.last()
    expect(res.result.contents).toEqual([{ uri: 'memory://preferences', mimeType: 'text/plain', text: '偏好深色主题' }])
    h.server.close()
  })

  it('resources/read：异步 read 也支持（await 返回值）', async () => {
    const resources: McpResource[] = [
      { uri: 'async://status', name: '异步状态', read: async () => 'ok' },
    ]
    const h = createHarness(undefined, resources)
    h.send({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'async://status' } })
    await h.flush()
    const res = h.last()
    expect(res.result.contents[0].text).toBe('ok')
    h.server.close()
  })

  it('resources/read：未知 uri → -32602 协议错误', async () => {
    const h = createHarness(undefined, [{ uri: 'memory://preferences', name: '用户偏好', read: () => 'x' }])
    h.send({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'memory://nonexist' } })
    await h.flush()
    const res = h.last()
    expect(res.error.code).toBe(-32602)
    expect(res.error.message).toContain('Unknown resource')
    h.server.close()
  })

  it('resources/read：read() 抛错 → -32603（服务器不崩，后续请求正常）', async () => {
    const resources: McpResource[] = [
      { uri: 'broken://x', name: '坏资源', read: () => { throw new Error('读取失败: 磁盘错误') } },
    ]
    const h = createHarness(undefined, resources)
    h.send({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'broken://x' } })
    await h.flush()
    const res = h.last()
    expect(res.error.code).toBe(-32603)
    expect(res.error.message).toContain('磁盘错误')
    // 服务器未崩：ping 正常
    h.send({ jsonrpc: '2.0', id: 6, method: 'ping', params: {} })
    await h.flush()
    expect(h.last().result).toEqual({})
    h.server.close()
  })

  it('initialize：配置了 resources 时 capabilities 声明 resources 能力（缺省不声明）', async () => {
    const withRes = createHarness(undefined, [{ uri: 'memory://preferences', name: '用户偏好', read: () => 'x' }])
    withRes.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await withRes.flush()
    expect(withRes.last().result.capabilities).toHaveProperty('resources')
    withRes.server.close()

    const withoutRes = createHarness()
    withoutRes.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })
    await withoutRes.flush()
    expect(withoutRes.last().result.capabilities).not.toHaveProperty('resources')
    withoutRes.server.close()
  })

  it('prompts/list：注入的提示词真实暴露（name/description/arguments 元数据）', async () => {
    const prompts: McpPrompt[] = [
      {
        name: 'summarize',
        description: '总结会话内容',
        arguments: [{ name: 'topic', description: '主题', required: true }],
        render: (args) => [{ role: 'user', content: { type: 'text', text: `总结关于 ${args.topic ?? ''} 的内容` } }],
      },
      { name: 'greet', render: () => [{ role: 'user', content: { type: 'text', text: '你好' } }] },
    ]
    const h = createHarness(undefined, undefined, prompts)
    h.send({ jsonrpc: '2.0', id: 1, method: 'prompts/list', params: {} })
    await h.flush()
    const res = h.last()
    expect(res.result.prompts).toEqual([
      {
        name: 'summarize',
        description: '总结会话内容',
        arguments: [{ name: 'topic', description: '主题', required: true }],
      },
      { name: 'greet' },
    ])
    h.server.close()
  })

  it('prompts/get：渲染提示词（参数替换 + description 透传）', async () => {
    const prompts: McpPrompt[] = [
      {
        name: 'summarize',
        description: '总结会话内容',
        arguments: [{ name: 'topic', description: '主题', required: true }],
        render: (args) => [
          { role: 'user', content: { type: 'text', text: `请总结关于「${args.topic}」的会话` } },
          { role: 'assistant', content: { type: 'text', text: '好的，我来总结。' } },
        ],
      },
    ]
    const h = createHarness(undefined, undefined, prompts)
    h.send({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'summarize', arguments: { topic: 'flare 引擎' } } })
    await h.flush()
    const res = h.last()
    expect(res.result.description).toBe('总结会话内容')
    expect(res.result.messages).toEqual([
      { role: 'user', content: { type: 'text', text: '请总结关于「flare 引擎」的会话' } },
      { role: 'assistant', content: { type: 'text', text: '好的，我来总结。' } },
    ])
    h.server.close()
  })

  it('prompts/get：异步 render 也支持（await 返回值）；arguments 缺省传空对象', async () => {
    const prompts: McpPrompt[] = [
      {
        name: 'status',
        render: async (args) => [{ role: 'user', content: { type: 'text', text: `当前状态: ${args.mode ?? 'default'}` } }],
      },
    ]
    const h = createHarness(undefined, undefined, prompts)
    h.send({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'status' } })
    await h.flush()
    const res = h.last()
    expect(res.result.messages[0].content.text).toBe('当前状态: default')
    h.server.close()
  })

  it('prompts/get：未知 name → -32602 协议错误', async () => {
    const h = createHarness(undefined, undefined, [{ name: 'greet', render: () => [] }])
    h.send({ jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'nonexist' } })
    await h.flush()
    const res = h.last()
    expect(res.error.code).toBe(-32602)
    expect(res.error.message).toContain('Unknown prompt')
    h.server.close()
  })

  it('prompts/get：render() 抛错 → -32603（服务器不崩，后续请求正常）', async () => {
    const prompts: McpPrompt[] = [
      {
        name: 'broken',
        render: () => { throw new Error('模板渲染失败: 缺少参数') },
      },
    ]
    const h = createHarness(undefined, undefined, prompts)
    h.send({ jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: 'broken' } })
    await h.flush()
    const res = h.last()
    expect(res.error.code).toBe(-32603)
    expect(res.error.message).toContain('模板渲染失败')
    // 服务器未崩：ping 正常
    h.send({ jsonrpc: '2.0', id: 6, method: 'ping', params: {} })
    await h.flush()
    expect(h.last().result).toEqual({})
    h.server.close()
  })

  it('initialize：配置了 prompts 时 capabilities 声明 prompts 能力（缺省不声明）', async () => {
    const withPrompts = createHarness(undefined, undefined, [{ name: 'greet', render: () => [] }])
    withPrompts.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await withPrompts.flush()
    expect(withPrompts.last().result.capabilities).toHaveProperty('prompts')
    withPrompts.server.close()

    const withoutPrompts = createHarness()
    withoutPrompts.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })
    await withoutPrompts.flush()
    expect(withoutPrompts.last().result.capabilities).not.toHaveProperty('prompts')
    withoutPrompts.server.close()
  })

  it('completion/complete：按 prompt 补全回调返回候选值（ref/prompt）', async () => {
    const prompts: McpPrompt[] = [
      {
        name: 'topic',
        arguments: [{ name: 'name', description: '主题名' }],
        render: (args) => [{ role: 'user', content: { type: 'text', text: `topic: ${args.name}` } }],
        complete: (argName, value) => {
          if (argName === 'name') {
            const all = ['flare 引擎', 'Pulse', 'StorySpire', 'MCP 协议']
            return all.filter(v => v.includes(value))
          }
          return []
        },
      },
    ]
    const h = createHarness(undefined, undefined, prompts)
    h.send({ jsonrpc: '2.0', id: 1, method: 'completion/complete', params: { ref: { type: 'ref/prompt', name: 'topic' }, argument: { name: 'name', value: 'flare' } } })
    await h.flush()
    const res = h.last()
    expect(res.result.completion).toEqual({ values: ['flare 引擎'], total: 1, hasMore: false })
    h.server.close()
  })

  it('completion/complete：异步 complete 回调 + 空匹配返回空候选', async () => {
    const prompts: McpPrompt[] = [
      {
        name: 'async',
        render: () => [],
        complete: async (_argName, value) => (value === 'x' ? ['x1', 'x2'] : []),
      },
    ]
    const h = createHarness(undefined, undefined, prompts)
    h.send({ jsonrpc: '2.0', id: 1, method: 'completion/complete', params: { ref: { type: 'ref/prompt', name: 'async' }, argument: { name: 'a', value: 'x' } } })
    await h.flush()
    expect(h.last().result.completion.values).toEqual(['x1', 'x2'])
    h.send({ jsonrpc: '2.0', id: 2, method: 'completion/complete', params: { ref: { type: 'ref/prompt', name: 'async' }, argument: { name: 'a', value: 'zzz' } } })
    await h.flush()
    expect(h.last().result.completion.values).toEqual([])
    h.server.close()
  })

  it('completion/complete：ref/resource 按已暴露资源 uri 前缀建议', async () => {
    const resources: McpResource[] = [
      { uri: 'flare://note/alpha', name: 'alpha', read: () => 'a' },
      { uri: 'flare://note/beta', name: 'beta', read: () => 'b' },
    ]
    const h = createHarness(undefined, resources)
    h.send({ jsonrpc: '2.0', id: 1, method: 'completion/complete', params: { ref: { type: 'ref/resource', uri: 'flare://' }, argument: { name: 'uri', value: 'flare://note/' } } })
    await h.flush()
    expect(h.last().result.completion.values).toEqual(['flare://note/alpha', 'flare://note/beta'])
    h.server.close()
  })

  it('completion/complete：无补全回调的 prompt → 空候选；未知 prompt → -32602；缺 ref → -32602', async () => {
    const prompts: McpPrompt[] = [{ name: 'plain', render: () => [] }]
    const h = createHarness(undefined, undefined, prompts)
    // 无 complete 回调：空候选（不报错）
    h.send({ jsonrpc: '2.0', id: 1, method: 'completion/complete', params: { ref: { type: 'ref/prompt', name: 'plain' }, argument: { name: 'a', value: '' } } })
    await h.flush()
    expect(h.last().result.completion.values).toEqual([])
    // 未知 prompt：-32602
    h.send({ jsonrpc: '2.0', id: 2, method: 'completion/complete', params: { ref: { type: 'ref/prompt', name: 'nonexist' }, argument: { name: 'a', value: '' } } })
    await h.flush()
    expect(h.last().error.code).toBe(-32602)
    // 缺 ref：-32602
    h.send({ jsonrpc: '2.0', id: 3, method: 'completion/complete', params: { argument: { name: 'a', value: '' } } })
    await h.flush()
    expect(h.last().error.code).toBe(-32602)
    h.server.close()
  })

  it('initialize：有 complete 回调或资源时 capabilities 声明 completions（缺省不声明）', async () => {
    const withComplete = createHarness(undefined, undefined, [{ name: 'g', render: () => [], complete: () => ['x'] }])
    withComplete.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await withComplete.flush()
    expect(withComplete.last().result.capabilities).toHaveProperty('completions')
    withComplete.server.close()

    const withResource = createHarness(undefined, [{ uri: 'flare://a', name: 'a', read: () => 'a' }])
    withResource.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })
    await withResource.flush()
    expect(withResource.last().result.capabilities).toHaveProperty('completions')
    withResource.server.close()

    const without = createHarness(undefined, undefined, [{ name: 'g', render: () => [] }])
    without.send({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} })
    await without.flush()
    expect(without.last().result.capabilities).not.toHaveProperty('completions')
    without.server.close()
  })

  it('toMcpTool：flare Tool → MCP 工具定义（名称/描述/schema 映射）', () => {
    const mcp = toMcpTool(readFileTool)
    expect(mcp.name).toBe('read_file')
    expect(mcp.description).toContain('读取文件')
    expect((mcp.inputSchema as any).properties.path).toBeTruthy()
  })
})

describe('MCPServer ↔ MCPClient 端到端互通（真实子进程 stdio）', () => {
  it('MCPClient 能连接 flare 作为 MCP 服务器：握手/列工具/调工具', async () => {
    const client = new MCPClient({
      command: process.execPath,
      args: [TSK_CLI, FLARE_SERVER_FIXTURE],
      timeoutMs: 15000,
    })
    try {
      const init = await client.initialize()
      expect(init.serverInfo?.name).toBe('flare')
      expect(init.serverInfo?.version).toBe(pkg.version)
      expect(init.capabilities).toHaveProperty('tools')

      const tools = await client.listTools()
      expect(tools.length).toBe(6)
      expect(tools.map((t) => t.name)).toContain('read_file')

      const ok = await client.callTool('read_file', { path: 'package.json' })
      expect(ok.isError).toBe(false)
      expect(ok.content[0]?.text).toContain('flare-agent')

      const fail = await client.callTool('read_file', { path: '/no/such/file-xyz' })
      expect(fail.isError).toBe(true)

      // 危险命令黑名单继承：terminal 的 rm -rf / 被 flare 安全策略拦截
      const denied = await client.callTool('terminal', { command: 'rm -rf /' })
      expect(denied.isError).toBe(true)
      expect(denied.content[0]?.text).toContain('安全策略拦截')
    } finally {
      client.close()
    }
  })

  it('MCPClient 消费 flare 服务器 prompts：listPrompts 元数据 + getPrompt 渲染（prompts 真实互通 e2e）', async () => {
    const client = new MCPClient({
      command: process.execPath,
      args: [TSK_CLI, FLARE_SERVER_PROMPTS_FIXTURE],
      timeoutMs: 15000,
    })
    try {
      const init = await client.initialize()
      expect(init.capabilities).toHaveProperty('prompts')

      const prompts = await client.listPrompts()
      expect(prompts.map(p => p.name)).toEqual(['summarize', 'greet'])
      const summarize = prompts.find(p => p.name === 'summarize')
      expect(summarize?.description).toBe('总结会话内容')
      expect(summarize?.arguments).toEqual([{ name: 'topic', description: '主题', required: true }])

      const res = await client.getPrompt('summarize', { topic: 'flare 引擎' })
      expect(res.description).toBe('总结会话内容')
      expect(res.messages).toEqual([
        { role: 'user', content: { type: 'text', text: '请总结关于「flare 引擎」的会话' } },
        { role: 'assistant', content: { type: 'text', text: '好的，我来总结。' } },
      ])

      // 未知 name → 协议错误（-32602）经客户端 reject
      await expect(client.getPrompt('nonexist')).rejects.toThrow(/未知提示词|Unknown prompt/)

      // v0.6.11：completion/complete 消费闭环——capabilities 声明 + 候选值 + 未知 prompt reject
      expect(init.capabilities).toHaveProperty('completions')
      const comp = await client.completePrompt('summarize', 'topic', 'flare')
      expect(comp.values).toEqual(['flare 引擎'])
      const empty = await client.completePrompt('summarize', 'topic', '不存在')
      expect(empty.values).toEqual([])
      await expect(client.completePrompt('nonexist', 'topic', 'x')).rejects.toThrow(/未知提示词|Unknown prompt/)
    } finally {
      client.close()
    }
  })

  it('MCPClient 连接无 prompts 的 flare 服务器：listPrompts 返回空列表（缺省兼容）', async () => {
    const client = new MCPClient({
      command: process.execPath,
      args: [TSK_CLI, FLARE_SERVER_FIXTURE],
      timeoutMs: 15000,
    })
    try {
      const init = await client.initialize()
      expect(init.capabilities).toHaveProperty('tools')
      const prompts = await client.listPrompts()
      expect(prompts).toEqual([])
    } finally {
      client.close()
    }
  })
})

describe('MCPServer roots（v0.6.12：服务器→客户端主动请求）', () => {
  it('requestRoots：发起 roots/list 请求并解析客户端响应', async () => {
    const h = createHarness()
    const p = h.server.requestRoots()
    await h.flush()
    // 服务器向客户端写出一条 roots/list 请求（带自增 id）
    const req = h.last()
    expect(req.jsonrpc).toBe('2.0')
    expect(req.method).toBe('roots/list')
    expect(req.id).toBeGreaterThan(0)
    // 模拟客户端响应注入的 roots
    h.send({ jsonrpc: '2.0', id: req.id, result: { roots: [{ uri: 'file:///home/user/projects', name: 'projects' }] } })
    const roots = await p
    expect(roots).toEqual([{ uri: 'file:///home/user/projects', name: 'projects' }])
    h.server.close()
  })

  it('requestRoots：客户端回 error → reject 带错误信息（协议错误不悬挂）', async () => {
    const h = createHarness()
    const p = h.server.requestRoots()
    await h.flush()
    const req = h.last()
    h.send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found: roots/list' } })
    await expect(p).rejects.toThrow(/MCP 错误/)
    h.server.close()
  })

  it('requestRoots：客户端响应缺 roots/非数组 → 容错返回 []（与客户端宽松解析一致）', async () => {
    const h = createHarness()
    const p = h.server.requestRoots()
    await h.flush()
    const req = h.last()
    h.send({ jsonrpc: '2.0', id: req.id, result: {} })
    await expect(p).resolves.toEqual([])
    h.server.close()
  })

  it('requestRoots：超时 reject（不悬挂），服务器随后仍正常处理请求', async () => {
    const h = createHarness(undefined, undefined, undefined, 150) // 150ms 请求超时
    const p = h.server.requestRoots()
    await expect(p).rejects.toThrow(/超时/)
    // 超时后服务器仍可用（ping 正常）
    h.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })
    await h.flush()
    expect(h.last().result).toEqual({})
    h.server.close()
  })

  it('requestRoots：服务器已关闭 → reject', async () => {
    const h = createHarness()
    h.server.close()
    await expect(h.server.requestRoots()).rejects.toThrow(/已关闭/)
  })

  it('roots 真实互通 e2e：MCPServer requestRoots ↔ MCPClient（带 roots 注入）', async () => {
    // fixture 起真实 MCPServer 子进程，握手后主动 requestRoots，结果写 ROOTS_RESULT_FILE
    const resultFile = join(tmpdir(), `flare-roots-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`)
    const client = new MCPClient({
      command: process.execPath,
      args: [TSK_CLI, FLARE_SERVER_ROOTS_FIXTURE],
      env: { ROOTS_RESULT_FILE: resultFile },
      timeoutMs: 8000,
      roots: [{ uri: 'file:///home/user/projects', name: 'projects' }, { uri: 'memory://workspace' }],
    })
    try {
      await client.initialize()
      const res = await waitForFile(resultFile)
      expect(res.ok).toBe(true)
      expect(res.roots).toEqual([
        { uri: 'file:///home/user/projects', name: 'projects' },
        { uri: 'memory://workspace' },
      ])
    } finally {
      client.close()
    }
  })
})
