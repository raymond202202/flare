// 冒烟实测（v0.6.47）：真实 dist CLI mcp-server --bridge-tools 全链路
// 外部 mock 服务器（echo_text/add_numbers/fail_tool）经 flare 透传 → listTools 并集 + callTool 代理转发
import { MCPClient } from '../dist/index.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'dist', 'cli', 'index.js')
const MOCK_SERVER = path.join(__dirname, 'fixtures', 'mcp-mock-server.mjs')
const configPath = '/tmp/bridge-tools-test-config.json'

const client = new MCPClient({
  command: process.execPath,
  args: [CLI, 'mcp-server', '--bridge-tools', '--config', configPath],
  timeoutMs: 15000,
})
try {
  const init = await client.initialize()
  console.log('serverInfo:', init.serverInfo?.name, init.serverInfo?.version)
  const tools = await client.listTools()
  console.log('工具集（并集）:', tools.map((t) => t.name).join(', '))
  const res = await client.callTool('add_numbers', { a: 2, b: 3 })
  console.log('callTool add_numbers {a:2,b:3} →', res.isError, res.content[0]?.text)
  const echo = await client.callTool('echo_text', { text: 'hi' })
  console.log('callTool echo_text →', echo.isError, echo.content[0]?.text)
  const fail = await client.callTool('fail_tool', {})
  console.log('callTool fail_tool →', fail.isError, fail.content[0]?.text)
  console.log('SMOKE PASS')
} finally {
  client.close()
}
