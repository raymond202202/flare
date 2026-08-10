/**
 * MCP (Model Context Protocol) HTTP 客户端（v0.6.4，零依赖 node:http）
 *
 * 与 stdio MCPClient（v0.5.5）对称：通过 HTTP transport 连接 MCP 服务器
 * （POST /mcp 一次请求一个 JSON-RPC 消息，见 src/mcp/http.ts startMcpHttpServer）。
 *
 * 接口与 MCPClient 完全一致（initialize / listTools / callTool / listPrompts / getPrompt /
 * ping / close），可互换使用：
 *   - 本地子进程服务器 → MCPClient（stdio）
 *   - 远端/HTTP 服务器 → MCPHttpClient（POST http://host:port/mcp）
 *
 * 设计：
 * - 零依赖：node:http 手写 POST（与 http.ts 服务器端一致，不引入 SDK/fetch）
 * - 每个请求独立 HTTP 往返（MCP streamable HTTP 同步子集）；通知（无 id）→ 202 空体
 * - 每个请求带超时（默认 15s），服务器不响应不悬挂
 * - 服务器返回 JSON-RPC error → reject；HTTP 非 200 → reject（含状态码与响应片段）
 *
 * 用法：
 *   const client = new MCPHttpClient({ url: 'http://127.0.0.1:8931/mcp' })
 *   await client.initialize()
 *   const tools = await client.listTools()
 *   const res = await client.callTool('read_file', { path: '/tmp/a.txt' })
 *   client.close()
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createRequire } from 'node:module'
import type { McpTool, McpCallResult, McpPromptInfo, McpPromptResult, McpResourceInfo, McpResourceContents, McpCompletionResult, McpLogLevel } from './types.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

/** 客户端声明的 MCP 协议版本（与 stdio 客户端一致；服务器可返回自己的版本，客户端兼容接受） */
export const MCP_PROTOCOL_VERSION = '2025-03-26'
const DEFAULT_TIMEOUT_MS = 15000

export interface MCPHttpClientOptions {
  /** MCP HTTP 服务器端点（如 http://127.0.0.1:8931/mcp） */
  url: string
  /** 单请求超时（毫秒），默认 15s（测试可调小） */
  timeoutMs?: number
}

/** 一次 HTTP 响应的最小封装（状态码 + 文本体） */
interface HttpResponse {
  status: number
  body: string
}

/**
 * 发一次 JSON POST（零依赖）：支持 http/https，带超时（超时销毁连接并 reject）。
 */
function postJson(url: string, body: string, timeoutMs: number): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let u: URL
    try {
      u = new URL(url)
    } catch (e: any) {
      reject(new Error(`MCP HTTP 客户端 URL 无效: ${url}（${e?.message || e}）`))
      return
    }
    const isHttps = u.protocol === 'https:'
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c: Buffer) => { data += c.toString() })
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }))
      }
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`MCP HTTP 请求超时: ${u.pathname}`))
    })
    req.on('error', (e) => reject(new Error(`MCP HTTP 请求失败: ${e.message}`)))
    req.write(body)
    req.end()
  })
}

export class MCPHttpClient {
  private readonly url: string
  private readonly timeoutMs: number
  private nextId = 1
  private protocolVersion = MCP_PROTOCOL_VERSION
  private serverInfo: { name?: string; version?: string } | null = null
  private capabilities: Record<string, unknown> = {}
  private closed = false

  constructor(opts: MCPHttpClientOptions) {
    this.url = opts.url
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS
  }

  /** 发送 JSON-RPC 请求（带超时），返回 result；协议错误 reject */
  private async request<T = any>(method: string, params?: any): Promise<T> {
    if (this.closed) {
      throw new Error('MCP HTTP 客户端已关闭')
    }
    const id = this.nextId++
    const resp = await postJson(
      this.url,
      JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }),
      this.timeoutMs
    )
    // 服务器返回空体（如 202 通知响应 / 204）：无 result 可用
    if (resp.status === 202 || resp.status === 204 || !resp.body.trim()) {
      throw new Error(`MCP HTTP 请求无响应体: ${method}（HTTP ${resp.status}）`)
    }
    let msg: any
    try {
      msg = JSON.parse(resp.body)
    } catch {
      throw new Error(`MCP HTTP 响应非 JSON: ${method}（HTTP ${resp.status}）`)
    }
    if (msg?.error) {
      throw new Error(`MCP 错误: ${msg.error.message || JSON.stringify(msg.error)}`)
    }
    return msg?.result as T
  }

  /** 发送 JSON-RPC 通知（无 id；服务器回 202 空体，无需响应） */
  private async notify(method: string, params?: any): Promise<void> {
    if (this.closed) return
    try {
      await postJson(
        this.url,
        JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }),
        this.timeoutMs
      )
    } catch { /* 通知失败不致命（服务器可能已关闭；后续请求会报错） */ }
  }

  /**
   * initialize 握手：协商协议版本、读取服务器信息与能力。
   * 成功后发送 notifications/initialized 通知（无 id，服务器回 202）。
   */
  async initialize(): Promise<{ protocolVersion: string; serverInfo: { name?: string; version?: string } | null; capabilities: Record<string, unknown> }> {
    const res = await this.request<any>('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'flare', version: pkg.version },
    })
    this.protocolVersion = res?.protocolVersion || MCP_PROTOCOL_VERSION
    this.serverInfo = res?.serverInfo || null
    this.capabilities = res?.capabilities || {}
    // 通知服务器初始化完成（无 id 的通知；HTTP 下回 202 空体，忽略）
    await this.notify('notifications/initialized')
    return { protocolVersion: this.protocolVersion, serverInfo: this.serverInfo, capabilities: this.capabilities }
  }

  /** 列出服务器可用工具（tools/list） */
  async listTools(): Promise<McpTool[]> {
    const res = await this.request<any>('tools/list', {})
    return Array.isArray(res?.tools) ? (res.tools as McpTool[]) : []
  }

  /** 调用服务器工具（tools/call）；工具级失败以 isError 标记返回（协议层错误则 reject） */
  async callTool(name: string, args?: Record<string, any>): Promise<McpCallResult> {
    const res = await this.request<any>('tools/call', { name, arguments: args || {} })
    return {
      content: Array.isArray(res?.content) ? res.content : [],
      isError: !!res?.isError,
      structuredContent: res?.structuredContent,
    }
  }

  /** 列出服务器可用提示词（prompts/list，v0.6.2）：元数据（name/description/arguments），渲染经 getPrompt */
  async listPrompts(): Promise<McpPromptInfo[]> {
    const res = await this.request<any>('prompts/list', {})
    return Array.isArray(res?.prompts) ? (res.prompts as McpPromptInfo[]) : []
  }

  /** 获取并渲染提示词（prompts/get，v0.6.2）：按 arguments 补全模板返回消息序列；未知 name 协议错误则 reject */
  async getPrompt(name: string, args?: Record<string, string>): Promise<McpPromptResult> {
    return this.request<McpPromptResult>('prompts/get', { name, ...(args ? { arguments: args } : {}) })
  }

  /** 请求参数补全候选值（completion/complete，v0.6.11）：按 prompt 名 + 参数名 + 当前输入值返回建议；未知 prompt 协议错误则 reject */
  async completePrompt(name: string, argumentName: string, value: string): Promise<McpCompletionResult> {
    const res = await this.request<any>('completion/complete', {
      ref: { type: 'ref/prompt', name },
      argument: { name: argumentName, value },
    })
    const completion = res?.completion || {}
    return { values: Array.isArray(completion.values) ? completion.values : [], total: completion.total, hasMore: completion.hasMore }
  }

  /** 列出服务器可用资源（resources/list，v0.6.6）：元数据（uri/name/description/mimeType），内容经 readResource */
  async listResources(): Promise<McpResourceInfo[]> {
    const res = await this.request<any>('resources/list', {})
    return Array.isArray(res?.resources) ? (res.resources as McpResourceInfo[]) : []
  }

  /** 读取资源内容（resources/read，v0.6.6）：按 uri 返回内容列表；未知 uri 协议错误则 reject */
  async readResource(uri: string): Promise<McpResourceContents[]> {
    const res = await this.request<any>('resources/read', { uri })
    return Array.isArray(res?.contents) ? (res.contents as McpResourceContents[]) : []
  }

  /** 设置服务器日志级别阈值（logging/setLevel，v0.6.13）：HTTP transport 一请求一响应，可设置但收不到日志推送（无 SSE 长连接） */
  async setLogLevel(level: McpLogLevel): Promise<void> {
    await this.request('logging/setLevel', { level })
  }

  /** 健康检查（ping）：成功返回 true；服务器无响应 reject */
  async ping(): Promise<boolean> {
    await this.request('ping', {})
    return true
  }

  /** 服务器名称（initialize 后可用） */
  get serverName(): string | null {
    return this.serverInfo?.name || null
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** 关闭客户端（HTTP 无长连接；标记关闭后拒绝后续请求） */
  close(): void {
    this.closed = true
  }
}
