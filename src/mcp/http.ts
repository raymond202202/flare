/**
 * MCP HTTP transport（v0.6.3，零依赖 node:http）
 *
 * streamable HTTP 的同步子集：POST /mcp 一次请求处理一个 JSON-RPC 消息并回 JSON 响应。
 * 与 stdio（NDJSON）行为完全一致——复用 MCPServer.handleMessage（传输无关）：
 *   - 有 id 的请求 → 200 + JSON-RPC 响应（含错误对象，不抛）
 *   - 通知类（无 id）→ 202 Accepted 空体（无需响应）
 *   - 非法 JSON → 400 + parse error（-32700）
 *   - 非 POST / 非目标路径 → 404
 *
 * 安全默认：仅监听 127.0.0.1（本机可访问），暴露的仍是 flare 原生工具（危险命令黑名单照常生效）。
 * 用法（库）：
 *   const h = await startMcpHttpServer({ tools: [...builtinTools], port: 8931 })
 *   // POST http://127.0.0.1:8931/mcp  {"jsonrpc":"2.0","id":1,"method":"tools/list"}
 *   await h.close()
 */
import { createServer, type Server as HttpServer } from 'node:http'
import { MCPServer, type MCPServerOptions } from './server.js'

export interface McpHttpServerOptions extends MCPServerOptions {
  /** 监听端口（默认 0 = 随机可用端口，测试/嵌入式用） */
  port?: number
  /** 监听地址（默认 127.0.0.1——仅本机可访问，安全默认） */
  host?: string
  /** 请求路径（默认 /mcp） */
  path?: string
}

export interface McpHttpServerHandle {
  /** 底层 MCPServer（可注入/复用工具集） */
  server: MCPServer
  /** node:http 服务器实例 */
  http: HttpServer
  /** 实际监听地址（含端口与路径；port 0 时端口随机） */
  url: string
  /** 关闭服务器 */
  close: () => Promise<void>
}

/** 启动 MCP HTTP 服务器（POST /mcp，JSON-RPC over HTTP） */
export function startMcpHttpServer(opts: McpHttpServerOptions = {}): Promise<McpHttpServerHandle> {
  const mcp = new MCPServer(opts)
  const path = opts.path || '/mcp'
  const host = opts.host || '127.0.0.1'
  // 请求串行队列（与 stdio 一致：慢工具不导致响应乱序）
  let queue: Promise<void> = Promise.resolve()

  const http = createServer((req, res) => {
    // 仅接受 POST 到目标路径；其余 404（方法不允许 / 路径不匹配）
    if (req.method !== 'POST' || (req.url || '/').split('?')[0] !== path) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Not found' } }))
      return
    }
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => {
      let msg: any
      try {
        msg = body.trim() ? JSON.parse(body) : {}
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
        return
      }
      queue = queue
        .then(async () => {
          const resp = await mcp.handleMessage(msg)
          if (resp === null || resp === undefined) {
            // 通知类消息（无 id）：无需响应
            res.writeHead(202, { 'Content-Type': 'application/json' })
            res.end()
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(resp))
        })
        .catch(() => {
          // handleMessage 内部已捕获协议错误；防御性兜底（理论不可达）
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }))
        })
    })
  })

  return new Promise<McpHttpServerHandle>((resolve, reject) => {
    http.once('error', reject)
    http.listen(opts.port ?? 0, host, () => {
      http.removeListener('error', reject)
      const addr = http.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        server: mcp,
        http,
        url: `http://${host}:${port}${path}`,
        close: () => new Promise<void>((resolveClose) => http.close(() => resolveClose())),
      })
    })
  })
}
