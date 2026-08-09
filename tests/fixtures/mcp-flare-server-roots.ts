// 真实 MCPServer 子进程 fixture（roots e2e，v0.6.12）
// 启动后延迟等待客户端握手，然后主动 requestRoots() 请求客户端 roots，
// 结果写入 ROOTS_RESULT_FILE（环境变量指定，JSON）：
//   { ok: true, roots: [...] } 或 { ok: false, error: '...' }
import { MCPServer } from '../../src/mcp/server.js'
import { writeFileSync } from 'node:fs'

const server = new MCPServer()
server.start()

setTimeout(async () => {
  try {
    const roots = await server.requestRoots(3000)
    writeFileSync(process.env.ROOTS_RESULT_FILE!, JSON.stringify({ ok: true, roots }))
  } catch (e: any) {
    writeFileSync(process.env.ROOTS_RESULT_FILE!, JSON.stringify({ ok: false, error: String(e?.message || e) }))
  }
}, 400)
