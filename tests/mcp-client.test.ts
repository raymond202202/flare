import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { MCPClient } from '../src/mcp/client.js'
import type { McpLogMessage, McpRoot } from '../src/mcp/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MOCK_SERVER = join(__dirname, 'fixtures', 'mcp-mock-server.mjs')
const MOCK_ROOTS_SERVER = join(__dirname, 'fixtures', 'mcp-roots-server.mjs')

function spawnMock(mode?: string, timeoutMs = 5000): MCPClient {
  return new MCPClient({
    command: process.execPath,
    args: [MOCK_SERVER],
    env: mode ? { MOCK_MODE: mode } : undefined,
    timeoutMs,
  })
}

function spawnMockWithLog(mode?: string): { client: MCPClient; received: McpLogMessage[] } {
  const received: McpLogMessage[] = []
  const client = new MCPClient({
    command: process.execPath,
    args: [MOCK_SERVER],
    env: mode ? { MOCK_MODE: mode } : undefined,
    timeoutMs: 5000,
    onLog: (msg) => received.push(msg),
  })
  return { client, received }
}

/** 读取 JSON Lines 日志文件（fixture 事件记录） */
function readLogLines(path: string): any[] {
  try {
    return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

/** 轮询等待日志文件出现指定事件，超时抛错 */
async function waitForEvent(logFile: string, event: string, timeoutMs = 6000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = readLogLines(logFile).find((e) => e.event === event)
    if (found) return found
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`等待日志事件超时: ${event}`)
}

describe('MCPClient（stdio NDJSON JSON-RPC，零依赖）', () => {
  it('initialize 握手：返回协议版本 + 服务器信息 + capabilities', async () => {
    const client = spawnMock()
    const res = await client.initialize()
    expect(res.protocolVersion).toBeTruthy()
    expect(res.serverInfo?.name).toBe('flare-mock')
    expect(res.serverInfo?.version).toBe('1.0.0')
    expect(res.capabilities).toHaveProperty('tools')
    client.close()
  })

  it('tools/list：列出服务器工具（名称/描述/schema）', async () => {
    const client = spawnMock()
    await client.initialize()
    const tools = await client.listTools()
    expect(tools.length).toBe(3)
    expect(tools.map(t => t.name)).toEqual(['echo_text', 'add_numbers', 'fail_tool'])
    expect(tools[0].description).toContain('回显')
    expect((tools[0].inputSchema as any)?.required).toContain('text')
    client.close()
  })

  it('listPrompts：列出服务器提示词元数据（name/description/arguments）', async () => {
    const client = spawnMock()
    await client.initialize()
    const prompts = await client.listPrompts()
    expect(prompts.length).toBe(2)
    expect(prompts.map(p => p.name)).toEqual(['greet', 'summarize'])
    const summarize = prompts.find(p => p.name === 'summarize')
    expect(summarize?.description).toBe('总结内容')
    expect(summarize?.arguments).toEqual([{ name: 'topic', description: '主题', required: true }])
    client.close()
  })

  it('getPrompt：按 arguments 渲染提示词消息序列（description + messages）', async () => {
    const client = spawnMock()
    await client.initialize()
    const res = await client.getPrompt('summarize', { topic: 'flare 引擎' })
    expect(res.description).toBe('总结内容')
    expect(res.messages).toEqual([
      { role: 'user', content: { type: 'text', text: '请总结关于「flare 引擎」的内容' } },
    ])
    const greet = await client.getPrompt('greet')
    expect(greet.messages[0].content.text).toBe('你好')
    client.close()
  })

  it('getPrompt：未知 name → reject 带错误信息（JSON-RPC error -32602）', async () => {
    const client = spawnMock()
    await client.initialize()
    await expect(client.getPrompt('nonexist')).rejects.toThrow(/MCP 错误.*未知提示词/)
    client.close()
  })

  it('tools/call：调用成功返回 text 内容', async () => {
    const client = spawnMock()
    await client.initialize()
    const res = await client.callTool('echo_text', { text: '你好 flare' })
    expect(res.isError).toBe(false)
    expect(res.content[0]?.text).toBe('echo: 你好 flare')
    const sum = await client.callTool('add_numbers', { a: 2, b: 3 })
    expect(sum.content[0]?.text).toBe('5')
    client.close()
  })

  it('tools/call：JSON-RPC 错误响应 → reject 带错误信息', async () => {
    const client = spawnMock()
    await client.initialize()
    await expect(client.callTool('boom', {})).rejects.toThrow(/MCP 错误/)
    client.close()
  })

  it('tools/call：isError=true 结果 → 正常返回但标记 isError（工具级失败）', async () => {
    const client = spawnMock()
    await client.initialize()
    const res = await client.callTool('fail_tool', {})
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toBe('出错了')
    client.close()
  })

  it('请求超时：服务器不响应 → reject 超时错误（不悬挂）', async () => {
    const client = spawnMock('no-response', 500)
    await client.initialize()
    await expect(client.callTool('echo_text', { text: 'x' })).rejects.toThrow(/超时/)
    client.close()
  })

  it('close：关闭后请求被拒绝（幂等）', async () => {
    const client = spawnMock()
    await client.initialize()
    client.close()
    client.close() // 幂等
    await expect(client.callTool('echo_text', { text: 'x' })).rejects.toThrow(/已关闭/)
  })

  it('服务器进程退出：pending 请求被拒绝（不悬挂）', async () => {
    // 子进程立即退出（node -e ''），pending 请求必须被拒绝而不是悬挂
    const client = new MCPClient({ command: process.execPath, args: ['-e', ''], timeoutMs: 3000 })
    const p = client.callTool('echo_text', { text: 'x' })
    await expect(p).rejects.toThrow()
    client.close()
  })

  it('listResources：列出服务器资源元数据（uri/name/description/mimeType）', async () => {
    const client = spawnMock()
    await client.initialize()
    const resources = await client.listResources()
    expect(resources.length).toBe(2)
    expect(resources[0].uri).toBe('memory://preferences')
    expect(resources[0].name).toBe('用户偏好')
    expect(resources[0].mimeType).toBe('text/plain')
    expect(resources[1].uri).toBe('file:///etc/hosts')
    client.close()
  })

  it('readResource：按 uri 读取资源内容（contents 列表）', async () => {
    const client = spawnMock()
    await client.initialize()
    const contents = await client.readResource('memory://preferences')
    expect(contents.length).toBe(1)
    expect(contents[0].uri).toBe('memory://preferences')
    expect(contents[0].text).toContain('浅色')
    client.close()
  })

  it('readResource：未知 uri → reject 带错误信息（JSON-RPC error -32602）', async () => {
    const client = spawnMock()
    await client.initialize()
    await expect(client.readResource('memory://nope')).rejects.toThrow(/未知资源/)
    client.close()
  })
})

describe('MCPClient roots（v0.6.12：客户端暴露 roots + 响应服务器请求）', () => {
  const ROOTS: McpRoot[] = [{ uri: 'file:///home/user/projects', name: 'projects' }, { uri: 'memory://workspace' }]

  function spawnRootsMock(logFile: string, roots?: McpRoot[]): MCPClient {
    return new MCPClient({
      command: process.execPath,
      args: [MOCK_ROOTS_SERVER],
      env: { ROOTS_LOG_FILE: logFile },
      timeoutMs: 5000,
      ...(roots ? { roots } : {}),
    })
  }

  it('配置 roots → initialize 声明 capabilities.roots（listChanged），可经 roots getter 读取', async () => {
    const logFile = join(tmpdir(), `flare-roots-init-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`)
    const client = spawnRootsMock(logFile, ROOTS)
    await client.initialize()
    const init = await waitForEvent(logFile, 'initialize')
    expect(init.capabilities.roots).toEqual({ listChanged: true })
    expect(client.roots).toEqual(ROOTS)
    client.close()
  })

  it('未配置 roots → initialize 不声明 roots 能力（缺省兼容），roots 为空列表', async () => {
    const logFile = join(tmpdir(), `flare-roots-noinit-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`)
    const client = spawnRootsMock(logFile)
    await client.initialize()
    const init = await waitForEvent(logFile, 'initialize')
    expect(init.capabilities.roots).toBeUndefined()
    expect(client.roots).toEqual([])
    client.close()
  })

  it('服务器发 roots/list 请求 → 客户端自动响应注入的 roots（协议闭环）', async () => {
    const logFile = join(tmpdir(), `flare-roots-resp-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`)
    const client = spawnRootsMock(logFile, ROOTS)
    await client.initialize()
    const ev = await waitForEvent(logFile, 'roots-response')
    expect(ev.response.id).toBe(900)
    expect(ev.response.result.roots).toEqual(ROOTS)
    client.close()
  })

  it('notifyRootsChanged：发 notifications/roots/list_changed 通知（无 id），服务器可收到', async () => {
    const logFile = join(tmpdir(), `flare-roots-changed-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`)
    const client = spawnRootsMock(logFile, ROOTS)
    await client.initialize()
    client.notifyRootsChanged()
    const ev = await waitForEvent(logFile, 'roots-changed')
    expect(ev.event).toBe('roots-changed')
    client.close()
  })

  it('close 后 notifyRootsChanged 不抛错（幂等安全）', async () => {
    const logFile = join(tmpdir(), `flare-roots-closed-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`)
    const client = spawnRootsMock(logFile, ROOTS)
    await client.initialize()
    client.close()
    expect(() => client.notifyRootsChanged()).not.toThrow()
  })
})

describe('MCPClient sampling（v0.6.14：响应服务器 sampling/createMessage 请求）', () => {
  const MOCK_SAMPLING_SERVER = join(__dirname, 'fixtures', 'mcp-sampling-server.mjs')

  function spawnSamplingMock(logFile: string, sampling?: (req: any) => any): MCPClient {
    return new MCPClient({
      command: process.execPath,
      args: [MOCK_SAMPLING_SERVER],
      env: { SAMPLE_LOG_FILE: logFile },
      timeoutMs: 5000,
      ...(sampling ? { sampling } : {}),
    })
  }

  it('配置 sampling 回调 → initialize 声明 capabilities.sampling；服务器请求 → 回调执行并返回结果（协议闭环）', async () => {
    const logFile = join(tmpdir(), `flare-sample-init-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`)
    const received: any[] = []
    const client = spawnSamplingMock(logFile, (request: any) => {
      received.push(request)
      return { role: 'assistant', content: { type: 'text', text: '采样结果: ' + request.messages[0].content.text }, model: 'mock-llm' }
    })
    await client.initialize()
    // mock 服务器收到 initialize：客户端声明 sampling 能力
    const init = await waitForEvent(logFile, 'initialize')
    expect(init.capabilities.sampling).toEqual({})
    // mock 服务器主动发 sampling/createMessage（id 900）→ 客户端回调执行 → 响应回传
    const ev = await waitForEvent(logFile, 'sampling-response')
    expect(ev.response.id).toBe(900)
    expect(ev.response.result).toEqual({ role: 'assistant', content: { type: 'text', text: '采样结果: 请解释 MCP sampling' }, model: 'mock-llm' })
    // 回调收到的请求参数完整（含 systemPrompt/maxTokens）
    expect(received).toHaveLength(1)
    expect(received[0].messages[0].content.text).toBe('请解释 MCP sampling')
    expect(received[0].systemPrompt).toBe('你是 MCP 协议专家。')
    expect(received[0].maxTokens).toBe(50)
    client.close()
  })

  it('未配置 sampling 回调 → initialize 不声明 sampling 能力（缺省兼容）', async () => {
    const logFile = join(tmpdir(), `flare-sample-noinit-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`)
    const client = spawnSamplingMock(logFile)
    await client.initialize()
    const init = await waitForEvent(logFile, 'initialize')
    expect(init.capabilities.sampling).toBeUndefined()
    client.close()
  })

  it('服务器发 sampling/createMessage 但未配置回调 → 回 -32601（协议错误，不中断连接）', async () => {
    const logFile = join(tmpdir(), `flare-sample-nocb-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`)
    const client = spawnSamplingMock(logFile)
    await client.initialize()
    const ev = await waitForEvent(logFile, 'sampling-response')
    expect(ev.response.id).toBe(900)
    expect(ev.response.error.code).toBe(-32601)
    // 连接未断：后续请求照常工作
    const res = await client.callTool('echo_text', { text: 'still-alive' })
    expect(res.content[0]?.text).toBe('echo: still-alive')
    client.close()
  })

  it('sampling 回调抛错 → 回 -32603（客户端不崩，服务器收到错误）', async () => {
    const logFile = join(tmpdir(), `flare-sample-throw-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`)
    const client = spawnSamplingMock(logFile, () => { throw new Error('模型服务不可用') })
    await client.initialize()
    const ev = await waitForEvent(logFile, 'sampling-response')
    expect(ev.response.id).toBe(900)
    expect(ev.response.error.code).toBe(-32603)
    expect(ev.response.error.message).toContain('模型服务不可用')
    client.close()
  })

  it('sampling 回调异步（返回 Promise）也支持', async () => {
    const logFile = join(tmpdir(), `flare-sample-async-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`)
    const client = spawnSamplingMock(logFile, async (request: any) => {
      await new Promise((r) => setTimeout(r, 20))
      return { role: 'assistant', content: { type: 'text', text: 'async:' + request.maxTokens } }
    })
    await client.initialize()
    const ev = await waitForEvent(logFile, 'sampling-response')
    expect(ev.response.result.content.text).toBe('async:50')
    client.close()
  })
})

describe('MCPClient logging（v0.6.13：setLogLevel + onLog 接收 notifications/message）', () => {
  it('setLogLevel：发送 logging/setLevel 请求并收到 {} 响应（不抛错）', async () => {
    const client = spawnMock()
    await client.initialize()
    await expect(client.setLogLevel('debug')).resolves.toBeUndefined()
    await expect(client.setLogLevel('warning')).resolves.toBeUndefined()
    client.close()
  })

  it('close 后 setLogLevel → reject（客户端已关闭）', async () => {
    const client = spawnMock()
    await client.initialize()
    client.close()
    await expect(client.setLogLevel('info')).rejects.toThrow(/已关闭/)
  })

  it('onLog：服务器推送 notifications/message → 回调转发（level/logger/data 结构）', async () => {
    const { client, received } = spawnMockWithLog('log-notify')
    await client.initialize()
    await client.setLogLevel('warning')
    // mock 服务器收到 setLevel 后推送一条 notifications/message（同 level + logger + data）
    await new Promise((r) => setTimeout(r, 300))
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ level: 'warning', logger: 'mock', data: 'mock log data' })
    client.close()
  })

  it('未配置 onLog：服务器推送日志通知 → 静默忽略（不抛错、不影响后续请求）', async () => {
    const client = spawnMock('log-notify')
    await client.initialize()
    await client.setLogLevel('error')
    // 通知被忽略，但后续请求照常工作
    const res = await client.callTool('echo_text', { text: 'still-alive' })
    expect(res.content[0]?.text).toBe('echo: still-alive')
    client.close()
  })
})

describe('MCPClient resources 订阅（v0.6.15：subscribeResource/unsubscribeResource + onResourceUpdated 通知）', () => {
  it('subscribeResource / unsubscribeResource：发送请求并收到 {} 响应（不抛错）', async () => {
    const client = spawnMock()
    await client.initialize()
    await expect(client.subscribeResource('memory://preferences')).resolves.toBeUndefined()
    await expect(client.unsubscribeResource('memory://preferences')).resolves.toBeUndefined()
    client.close()
  })

  it('subscribeResource：未知 uri → reject（协议错误，与 readResource 一致）', async () => {
    const client = spawnMock()
    await client.initialize()
    await expect(client.subscribeResource('memory://nonexist')).rejects.toThrow(/未知资源/)
    client.close()
  })

  it('onResourceUpdated：服务器推送 notifications/resources/updated → 回调收到 uri（res-update 模式）', async () => {
    const received: string[] = []
    const client = new MCPClient({
      command: process.execPath,
      args: [MOCK_SERVER],
      env: { MOCK_MODE: 'res-update' },
      timeoutMs: 5000,
      onResourceUpdated: (uri) => received.push(uri),
    })
    await client.initialize()
    await client.subscribeResource('memory://preferences')
    // mock 服务器收到订阅后推送一条 notifications/resources/updated（同 uri）
    await new Promise((r) => setTimeout(r, 300))
    expect(received).toEqual(['memory://preferences'])
    client.close()
  })

  it('未配置 onResourceUpdated：订阅后服务器推送通知 → 静默忽略（不抛错、不影响后续请求）', async () => {
    const client = spawnMock('res-update')
    await client.initialize()
    await client.subscribeResource('memory://preferences') // 服务器推送通知但无回调 → 忽略
    const res = await client.callTool('echo_text', { text: 'still-alive' })
    expect(res.content[0]?.text).toBe('echo: still-alive')
    client.close()
  })

  it('close 后 subscribeResource → reject（客户端已关闭）', async () => {
    const client = spawnMock()
    await client.initialize()
    client.close()
    await expect(client.subscribeResource('memory://preferences')).rejects.toThrow(/已关闭/)
  })
})

describe('MCPClient progress + cancelled 通知（v0.6.16：onProgress 接收 + notifyCancelled 发送）', () => {
  it('callTool 带 progressToken：服务器推送 notifications/progress → onProgress 收到（progress 协议消费闭环）', async () => {
    const received: any[] = []
    const client = new MCPClient({
      command: process.execPath,
      args: [MOCK_SERVER],
      env: { MOCK_MODE: 'progress-notify' },
      timeoutMs: 5000,
      onProgress: (p) => received.push(p),
    })
    await client.initialize()
    const res = await client.callTool('echo_text', { text: 'hi' }, { progressToken: 'tk-1' })
    expect(res.content[0]?.text).toBe('echo: hi')
    // mock 服务器在响应前推送 2 条进度（带 message 与不带）
    expect(received).toHaveLength(2)
    expect(received[0]).toMatchObject({ progressToken: 'tk-1', progress: 1, total: 2, message: '第一步' })
    expect(received[1]).toMatchObject({ progressToken: 'tk-1', progress: 2, total: 2 })
    expect(received[1].message).toBeUndefined()
    client.close()
  })

  it('未配置 onProgress：服务器推送进度通知 → 静默忽略（不抛错、不影响后续请求）', async () => {
    const client = spawnMock('progress-notify')
    await client.initialize()
    const res = await client.callTool('echo_text', { text: 'no-callback' }, { progressToken: 'tk-2' })
    expect(res.content[0]?.text).toBe('echo: no-callback')
    client.close()
  })

  it('callTool 不带 options：不携带 _meta（向后兼容，行为不变）', async () => {
    const client = spawnMock('progress-notify') // 无 progressToken → mock 不推送进度
    await client.initialize()
    const res = await client.callTool('echo_text', { text: 'plain' })
    expect(res.content[0]?.text).toBe('echo: plain')
    client.close()
  })

  it('notifyCancelled：发送 notifications/cancelled（服务器记录 requestId + reason）', async () => {
    const cancelLog = join(tmpdir(), `flare-cancel-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`)
    const client = new MCPClient({
      command: process.execPath,
      args: [MOCK_SERVER],
      env: { MOCK_MODE: 'cancel-echo', CANCEL_LOG_FILE: cancelLog },
      timeoutMs: 5000,
    })
    await client.initialize()
    client.notifyCancelled(7, 'timeout')
    // 等待 mock 服务器把 cancelled 参数写入文件
    const deadline = Date.now() + 4000
    let lines: any[] = []
    while (Date.now() < deadline) {
      lines = readLogLines(cancelLog)
      if (lines.length > 0) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(lines).toHaveLength(1)
    expect(lines[0]).toEqual({ requestId: 7, reason: 'timeout' })
    client.close()
  })

  it('notifyCancelled 不带 reason：只发送 requestId；close 后静默不抛错', async () => {
    const cancelLog = join(tmpdir(), `flare-cancel-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`)
    const client = new MCPClient({
      command: process.execPath,
      args: [MOCK_SERVER],
      env: { MOCK_MODE: 'cancel-echo', CANCEL_LOG_FILE: cancelLog },
      timeoutMs: 5000,
    })
    await client.initialize()
    client.notifyCancelled(3)
    const deadline = Date.now() + 4000
    let lines: any[] = []
    while (Date.now() < deadline) {
      lines = readLogLines(cancelLog)
      if (lines.length > 0) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(lines).toEqual([{ requestId: 3 }])
    client.close()
    expect(() => client.notifyCancelled(1, 'after-close')).not.toThrow()
  })
})
