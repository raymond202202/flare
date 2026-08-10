// MCP mock 服务器（sampling 协议测试用，v0.6.14）
// 记录两类事件到 SAMPLE_LOG_FILE（环境变量指定，JSON Lines 追加）：
//   { event: 'initialize', capabilities: <客户端 initialize 声明的 capabilities> }
//   { event: 'sampling-response', request: <sampling/createMessage 请求参数>, response: <客户端响应> }
// 时序：响应 initialize 后延迟 50ms，主动向客户端发 sampling/createMessage 请求（id 900）。
import readline from 'node:readline'
import { appendFileSync } from 'node:fs'

const logFile = process.env.SAMPLE_LOG_FILE
const log = (obj) => {
  if (logFile) {
    try {
      appendFileSync(logFile, JSON.stringify(obj) + '\n')
    } catch { /* 日志写入失败不致命 */ }
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  // 客户端对 sampling/createMessage 请求（id 900）的响应
  if (msg.id === 900) {
    log({ event: 'sampling-response', response: msg })
    return
  }
  const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
  switch (msg.method) {
    case 'initialize':
      log({ event: 'initialize', capabilities: msg.params?.capabilities })
      respond({
        protocolVersion: msg.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'sampling-mock', version: '1.0.0' },
      })
      // 主动向客户端发 sampling/createMessage 请求（id 900）
      setTimeout(() => {
        const request = {
          messages: [{ role: 'user', content: { type: 'text', text: '请解释 MCP sampling' } }],
          systemPrompt: '你是 MCP 协议专家。',
          maxTokens: 50,
        }
        log({ event: 'sampling-request', request })
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'sampling/createMessage', params: request }) + '\n')
      }, 50)
      break
    case 'ping':
      respond({})
      break
    case 'tools/call': {
      const args = msg.params?.arguments || {}
      if (msg.params?.name === 'echo_text') {
        respond({ content: [{ type: 'text', text: `echo: ${args.text}` }] })
      } else {
        respond({ content: [{ type: 'text', text: 'ok' }] })
      }
      break
    }
    default:
      respond({})
  }
})
