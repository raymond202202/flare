// MCP mock 服务器（NDJSON JSON-RPC over stdio）
// 用于测试 flare 的 MCP 客户端：initialize / notifications/initialized / tools/list / tools/call
//
// 模式（环境变量 MOCK_MODE 控制）：
//   default      — 正常响应（2 个工具：echo_text / add_numbers；另有错误路径 boom / fail_tool）
//   no-response  — 不响应 tools/call（测客户端超时）
//   log-notify   — initialize 后推送一条 notifications/message（测客户端 onLog 转发）
//   res-update   — 收到 resources/subscribe 后推送一条 notifications/resources/updated（测客户端 onResourceUpdated 转发）
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

const PROMPTS = [
  {
    name: 'greet',
    description: '打招呼',
  },
  {
    name: 'summarize',
    description: '总结内容',
    arguments: [{ name: 'topic', description: '主题', required: true }],
  },
]

const RESOURCES = [
  {
    uri: 'memory://preferences',
    name: '用户偏好',
    description: '用户偏好设置',
    mimeType: 'text/plain',
  },
  {
    uri: 'file:///etc/hosts',
    name: 'hosts 文件',
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
        capabilities: { tools: {}, prompts: {}, resources: { subscribe: true } },
        serverInfo: { name: 'flare-mock', version: '1.0.0' },
      })
      break
    case 'tools/list':
      respond({ tools: TOOLS })
      break
    case 'resources/list':
      respond({ resources: RESOURCES })
      break
    case 'resources/read': {
      const { uri } = msg.params || {}
      const res = RESOURCES.find((r) => r.uri === uri)
      if (!res) {
        respondError(-32602, `未知资源: ${uri}`)
        break
      }
      respond({
        contents: [{
          uri: res.uri,
          mimeType: res.mimeType || 'text/plain',
          text: res.uri === 'memory://preferences' ? '主题: 浅色' : '127.0.0.1 localhost',
        }],
      })
      break
    }
    case 'prompts/list':
      respond({ prompts: PROMPTS })
      break
    case 'prompts/get': {
      const { name, arguments: args } = msg.params || {}
      const prompt = PROMPTS.find((p) => p.name === name)
      if (!prompt) {
        respondError(-32602, `未知提示词: ${name}`)
        break
      }
      if (name === 'summarize') {
        respond({
          description: prompt.description,
          messages: [{ role: 'user', content: { type: 'text', text: `请总结关于「${args?.topic || ''}」的内容` } }],
        })
      } else {
        respond({ messages: [{ role: 'user', content: { type: 'text', text: '你好' } }] })
      }
      break
    }
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
    case 'logging/setLevel':
      // v0.6.13：接受客户端日志级别设置；log-notify 模式下收到设置后推送一条日志通知
      if (mode === 'log-notify') {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/message',
            params: { level: msg.params?.level || 'info', logger: 'mock', data: 'mock log data' },
          }) + '\n'
        )
      }
      respond({})
      break
    case 'resources/subscribe': {
      const { uri } = msg.params || {}
      if (!RESOURCES.some((r) => r.uri === uri)) {
        respondError(-32602, `未知资源: ${uri}`)
        break
      }
      // v0.6.15：res-update 模式下订阅后推送一条资源更新通知（模拟服务器资源变化）
      if (mode === 'res-update') {
        process.stdout.write(
          JSON.stringify({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } }) + '\n'
        )
      }
      respond({})
      break
    }
    case 'resources/unsubscribe': {
      const { uri } = msg.params || {}
      if (!RESOURCES.some((r) => r.uri === uri)) {
        respondError(-32602, `未知资源: ${uri}`)
        break
      }
      respond({})
      break
    }
    default:
      respondError(-32601, `未知方法: ${msg.method}`)
  }
})
