import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MCPClient } from '../src/mcp/client.js'
import { createMcpTools } from '../src/tools/mcp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MOCK_SERVER = join(__dirname, 'fixtures', 'mcp-mock-server.mjs')

async function makeTools() {
  const client = new MCPClient({ command: process.execPath, args: [MOCK_SERVER], timeoutMs: 5000 })
  await client.initialize()
  const tools = await createMcpTools(client)
  return { client, tools }
}

describe('createMcpTools（MCP 工具桥 → flare Tool[]）', () => {
  it('定义映射：MCP 工具 → flare ToolDefinition（name/description/parameters 来自 inputSchema）', async () => {
    const { client, tools } = await makeTools()
    expect(tools.length).toBe(3)
    const echo = tools.find(t => t.definition.function.name === 'echo_text')!
    expect(echo.definition.function.description).toContain('回显')
    const params = echo.definition.function.parameters as any
    expect(params.type).toBe('object')
    expect(params.properties.text.type).toBe('string')
    expect(params.required).toContain('text')
    client.close()
  })

  it('execute：调用成功 → success:true + 提取 text 内容', async () => {
    const { client, tools } = await makeTools()
    const echo = tools.find(t => t.definition.function.name === 'echo_text')!
    const res = await echo.execute({ text: '你好 flare' })
    expect(res.success).toBe(true)
    expect(res.output).toBe('echo: 你好 flare')
    client.close()
  })

  it('execute：多 content 项拼接（按序提取 text）', async () => {
    const { client, tools } = await makeTools()
    const add = tools.find(t => t.definition.function.name === 'add_numbers')!
    const res = await add.execute({ a: 10, b: 32 })
    expect(res.success).toBe(true)
    expect(res.output).toBe('42')
    client.close()
  })

  it('execute：isError=true → success:false + error 带工具输出内容', async () => {
    const { client, tools } = await makeTools()
    const fail = tools.find(t => t.definition.function.name === 'fail_tool')!
    const res = await fail.execute({})
    expect(res.success).toBe(false)
    expect(res.error).toBe('出错了')
    client.close()
  })

  it('execute：协议层错误（reject）→ success:false + error 信息（不抛出，遵循 flare 工具约定）', async () => {
    const { client, tools } = await makeTools()
    const echo = tools.find(t => t.definition.function.name === 'echo_text')!
    // 客户端已关闭 → callTool reject → 桥接层包装为 success:false（不抛出）
    client.close()
    const res = await echo.execute({ text: 'x' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('MCP 工具 echo_text 调用失败')
  })
})
