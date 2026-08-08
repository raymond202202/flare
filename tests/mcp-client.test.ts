import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MCPClient } from '../src/mcp/client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MOCK_SERVER = join(__dirname, 'fixtures', 'mcp-mock-server.mjs')

function spawnMock(mode?: string, timeoutMs = 5000): MCPClient {
  return new MCPClient({
    command: process.execPath,
    args: [MOCK_SERVER],
    env: mode ? { MOCK_MODE: mode } : undefined,
    timeoutMs,
  })
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
})
