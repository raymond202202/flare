// MCP mock 服务器（NDJSON JSON-RPC over stdio）
// 用于测试 flare 的 MCP 客户端：initialize / notifications/initialized / tools/list / tools/call
//
// 模式（环境变量 MOCK_MODE 控制）：
//   default      — 正常响应（2 个工具：echo_text / add_numbers；另有错误路径 boom / fail_tool）
//   no-response  — 不响应 tools/call（测客户端超时）
import readline from 'node:readline'

const mode = process.env.MOCK_MODE || 'default'

const TOOLS = [
  {
    name: 'echo_text',
    description: '回显输入文本',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
  },
  {
    name: 'add_numbers',
    description: '两个数相加',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number', description: '加数 a' }, b: { type: 'number', description: '加数 b' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'fail_tool',
    description: '总是失败的工具（测 isError 映射）',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
]

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  // 通知类消息（无 id）忽略
  if (msg.id === undefined) return

  const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
  const respondError = (code, message) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }) + '\n')

  switch (msg.method) {
    case 'initialize':
      respond({
        protocolVersion: msg.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'flare-mock', version: '1.0.0' },
      })
      break
    case 'tools/list':
      respond({ tools: TOOLS })
      break
    case 'tools/call': {
      if (mode === 'no-response') return // 不响应 → 客户端超时
      const { name, arguments: args } = msg.params || {}
      if (name === 'echo_text') {
        respond({ content: [{ type: 'text', text: `echo: ${args?.text || ''}` }] })
      } else if (name === 'add_numbers') {
        const a = Number(args?.a) || 0
        const b = Number(args?.b) || 0
        respond({ content: [{ type: 'text', text: String(a + b) }] })
      } else if (name === 'boom') {
        respondError(-32000, 'mock 工具调用失败')
      } else if (name === 'fail_tool') {
        respond({ content: [{ type: 'text', text: '出错了' }], isError: true })
      } else {
        respondError(-32602, `未知工具: ${name}`)
      }
      break
    }
    default:
      respondError(-32601, `未知方法: ${msg.method}`)
  }
})
