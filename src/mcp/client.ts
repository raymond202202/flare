/**
 * MCP (Model Context Protocol) stdio 客户端（v0.5.5，零依赖手写）
 *
 * 传输：JSON-RPC 2.0 over stdio——每行一个 JSON（NDJSON）。
 * 流程：spawn 子进程 → initialize 握手 → notifications/initialized → tools/list → tools/call → close。
 *
 * 覆盖 MCP 核心子集（工具互通所需）：
 *   initialize / notifications/initialized / tools/list / tools/call
 *
 * 设计：
 * - 零依赖：不引入 @modelcontextprotocol/sdk，直接手写 NDJSON 行协议
 *   （MCP stdio 传输规范就是 newline-delimited JSON-RPC）
 * - 每个请求带超时（默认 15s），服务器不响应不悬挂
 * - 子进程退出 / close 时拒绝所有 pending 请求
 *
 * 用法：
 *   const client = new MCPClient({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] })
 *   await client.initialize()
 *   const tools = await client.listTools()
 *   const res = await client.callTool('read_file', { path: '/tmp/a.txt' })
 *   client.close()
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { createRequire } from 'node:module'
import type { McpTool, McpCallResult, McpPromptInfo, McpPromptResult, McpResourceInfo, McpResourceContents, McpCompletionResult, McpRoot, McpLogLevel, McpLogMessage, McpSamplingRequest, McpSamplingResult } from './types.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

/** 客户端声明的 MCP 协议版本（服务器可返回自己的版本，客户端兼容接受） */
export const MCP_PROTOCOL_VERSION = '2025-03-26'
const DEFAULT_TIMEOUT_MS = 15000

interface PendingRequest {
  resolve: (result: any) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export interface MCPClientOptions {
  /** 启动命令（如 npx / node / python） */
  command: string
  /** 命令参数 */
  args?: string[]
  /** 附加环境变量（合并到 process.env） */
  env?: Record<string, string>
  /** 单请求超时（毫秒），默认 15s（测试可调小） */
  timeoutMs?: number
  /** 客户端 roots（v0.6.12 roots 协议）：暴露给服务器的命名空间/根目录；配置后 initialize 声明 capabilities.roots，
   *  服务器可发 roots/list 请求查询（响应注入的 roots），roots 变化时可发 notifications/roots/list_changed 通知 */
  roots?: McpRoot[]
  /** 日志通知回调（v0.6.13）：服务器 sendLog 推送的 notifications/message 通知 → 按此回调转发；缺省忽略 */
  onLog?: (msg: McpLogMessage) => void
  /** 采样回调（v0.6.14 sampling 协议）：服务器发 sampling/createMessage 请求（请客户端代为调用 LLM 生成内容）
   *  时按此回调执行；配置后 initialize 声明 capabilities.sampling（未配置不声明，服务器不会请求采样）。
   *  回调返回采样结果（支持异步）；回调抛错 → 回 -32603（客户端不崩） */
  sampling?: (request: McpSamplingRequest) => McpSamplingResult | Promise<McpSamplingResult>
}

export class MCPClient {
  private child: ChildProcess
  private rl: Interface
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private protocolVersion = MCP_PROTOCOL_VERSION
  private serverInfo: { name?: string; version?: string } | null = null
  private capabilities: Record<string, unknown> = {}
  private closed = false
  private timeoutMs: number
  private readonly rootsList: McpRoot[]
  private readonly onLog?: (msg: McpLogMessage) => void
  private readonly sampling?: (request: McpSamplingRequest) => McpSamplingResult | Promise<McpSamplingResult>

  constructor(opts: MCPClientOptions) {
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS
    this.rootsList = opts.roots || []
    this.onLog = opts.onLog
    this.sampling = opts.sampling
    this.child = spawn(opts.command, opts.args || [], {
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.rl = createInterface({ input: this.child.stdout! })
    this.rl.on('line', (line) => this.handleLine(line))
    // stderr 是服务器日志通道（不阻塞）；DEBUG 时可在外层监听
    this.child.stderr!.on('data', () => { /* 忽略服务器日志 */ })
    this.child.on('exit', () => {
      // 服务器进程退出：拒绝所有 pending（避免悬挂）
      this.closed = true
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('MCP 服务器进程已退出'))
      }
      this.pending.clear()
    })
    this.child.on('error', () => {
      // spawn 失败（命令不存在等）：拒绝 pending
      this.closed = true
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`MCP 服务器启动失败: ${opts.command}`))
      }
      this.pending.clear()
    })
  }

  /** 处理服务器返回的一行（匹配 pending 请求；服务器主动发来的请求 → handleServerRequest；通知类消息无 id 按方法分发） */
  private handleLine(line: string) {
    if (!line.trim()) return
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg && msg.id !== undefined && typeof msg.method !== 'string' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) {
        p.reject(new Error(`MCP 错误: ${msg.error.message || JSON.stringify(msg.error)}`))
      } else {
        p.resolve(msg.result)
      }
    } else if (msg && msg.id !== undefined && typeof msg.method === 'string') {
      // v0.6.12：服务器主动发来的请求（如 roots/list）——不是对 flare 请求的响应
      void this.handleServerRequest(msg)
    } else if (msg && msg.id === undefined && typeof msg.method === 'string') {
      // v0.6.13：通知类消息（无 id）——目前支持 notifications/message（服务器日志推送）
      this.handleNotification(msg)
    }
  }

  /** 处理服务器通知（v0.6.13）：notifications/message → onLog 回调转发（缺省忽略；通知无需响应） */
  private handleNotification(msg: any): void {
    if (msg.method !== 'notifications/message' || typeof this.onLog !== 'function') return
    const p = msg.params || {}
    this.onLog({
      level: p.level as McpLogLevel,
      ...(p.logger !== undefined ? { logger: String(p.logger) } : {}),
      data: p.data,
    })
  }

  /**
   * 处理服务器发来的请求（v0.6.12 起，roots 协议方向）：支持 roots/list（返回注入的 roots）、
   * sampling/createMessage（v0.6.14：按采样回调执行），未知方法回 -32601（协议错误，不中断连接）。
   */
  private async handleServerRequest(msg: any): Promise<void> {
    if (this.closed) return
    let resp: any
    if (msg.method === 'roots/list') {
      resp = { jsonrpc: '2.0', id: msg.id, result: { roots: this.rootsList } }
    } else if (msg.method === 'sampling/createMessage') {
      // v0.6.14 sampling 协议：服务器请求客户端代为调用 LLM——按注入的采样回调执行
      if (typeof this.sampling !== 'function') {
        // 未配置采样回调：回 -32601（能力未声明，服务器不应请求；协议错误不中断连接）
        resp = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }
      } else {
        try {
          const result = await this.sampling((msg.params || {}) as McpSamplingRequest)
          resp = { jsonrpc: '2.0', id: msg.id, result }
        } catch (e: any) {
          // 采样回调异常 → -32603（客户端不崩，服务器收到错误）
          resp = { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `Sampling error: ${e?.message || String(e)}` } }
        }
      }
    } else {
      resp = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }
    }
    try {
      this.child.stdin!.write(JSON.stringify(resp) + '\n')
    } catch { /* 写入失败（子进程已退出）不致命 */ }
  }

  /** 发送 JSON-RPC 请求（带超时），返回 result */
  private request<T = any>(method: string, params?: any): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('MCP 客户端已关闭'))
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 请求超时: ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin!.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }) + '\n'
      )
    })
  }

  /**
   * initialize 握手：协商协议版本、读取服务器信息与能力。
   * 成功后发送 notifications/initialized 通知（无 id）。
   */
  async initialize(): Promise<{ protocolVersion: string; serverInfo: { name?: string; version?: string } | null; capabilities: Record<string, unknown> }> {
    const res = await this.request<any>('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      // v0.6.12：配置了 roots 时声明客户端 roots 能力（服务器可发 roots/list 查询；缺省不声明）
      capabilities: {
        ...(this.rootsList.length > 0 ? { roots: { listChanged: true } } : {}),
        // v0.6.14：配置了 sampling 回调时声明客户端 sampling 能力（服务器可发 sampling/createMessage 请求；缺省不声明）
        ...(typeof this.sampling === 'function' ? { sampling: {} } : {}),
      },
      clientInfo: { name: 'flare', version: pkg.version },
    })
    this.protocolVersion = res?.protocolVersion || MCP_PROTOCOL_VERSION
    this.serverInfo = res?.serverInfo || null
    this.capabilities = res?.capabilities || {}
    // 通知服务器初始化完成（无 id 的通知，服务器忽略响应）
    if (!this.closed) {
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    }
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

  /** 设置服务器日志级别阈值（logging/setLevel，v0.6.13）：此后服务器低于该级别的 sendLog 通知不再推送 */
  async setLogLevel(level: McpLogLevel): Promise<void> {
    await this.request('logging/setLevel', { level })
  }

  /** 读取资源内容（resources/read，v0.6.6）：按 uri 返回内容列表；未知 uri 协议错误则 reject */
  async readResource(uri: string): Promise<McpResourceContents[]> {
    const res = await this.request<any>('resources/read', { uri })
    return Array.isArray(res?.contents) ? (res.contents as McpResourceContents[]) : []
  }

  /** 服务器名称（initialize 后可用） */
  get serverName(): string | null {
    return this.serverInfo?.name || null
  }

  /** 当前暴露的 roots（v0.6.12） */
  get roots(): McpRoot[] {
    return this.rootsList
  }

  /** 通知服务器 roots 已变化（v0.6.12）：发 notifications/roots/list_changed 通知（无 id，服务器无需响应） */
  notifyRootsChanged(): void {
    if (this.closed) return
    try {
      this.child.stdin!.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }) + '\n'
      )
    } catch { /* 写入失败（子进程已退出）不致命 */ }
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** 关闭连接：结束子进程、拒绝 pending */
  close() {
    if (this.closed) return
    this.closed = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('MCP 客户端已关闭'))
    }
    this.pending.clear()
    try {
      this.rl.close()
    } catch { /* 忽略 */ }
    try {
      this.child.kill()
    } catch { /* 忽略 */ }
  }
}
