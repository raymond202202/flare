// MCP mock 服务器（roots 协议测试用，v0.6.12）
// 记录三类事件到 ROOTS_LOG_FILE（环境变量指定，JSON Lines 追加）：
//   { event: 'initialize', capabilities: <客户端 initialize 声明的 capabilities> }
//   { event: 'roots-response', response: <客户端对 roots/list 请求的响应> }
//   { event: 'roots-changed' }                              （收到 notifications/roots/list_changed）
// 时序：响应 initialize 后延迟 50ms，主动向客户端发 roots/list 请求（id 900）。
import readline from 'node:readline'
import { appendFileSync } from 'node:fs'

const logFile = process.env.ROOTS_LOG_FILE
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
  // 通知类消息（无 id）：检测 roots/list_changed
  if (msg.id === undefined) {
    if (msg.method === 'notifications/roots/list_changed') log({ event: 'roots-changed' })
    return
  }
  // 客户端对 roots/list 请求（id 900）的响应
  if (msg.id === 900) {
    log({ event: 'roots-response', response: msg })
    return
  }
  const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
  switch (msg.method) {
    case 'initialize':
      log({ event: 'initialize', capabilities: msg.params?.capabilities })
      respond({
        protocolVersion: msg.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'roots-mock', version: '1.0.0' },
      })
      // 主动向客户端发 roots/list 请求（id 900）
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'roots/list', params: {} }) + '\n')
      }, 50)
      break
    case 'ping':
      respond({})
      break
    default:
      respond({})
  }
})
