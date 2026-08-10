// 真实 MCPServer 子进程 fixture（logging e2e，v0.6.13）
// 启动后延迟推送几条日志（debug 会被 info 阈值过滤），验证 sendLog → 客户端 onLog 闭环。
import { MCPServer } from '../../src/mcp/server.js'

const server = new MCPServer()
server.start()

setTimeout(() => {
  server.sendLog('debug', 'debug should be filtered')
  server.sendLog('info', 'hello from flare')
  server.sendLog('warning', 'warn: disk low', 'flare-log')
  server.sendLog('error', 'error: boom')
}, 400)
