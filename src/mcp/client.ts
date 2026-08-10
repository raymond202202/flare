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
import type { McpTool, McpCallResult, McpPromptInfo, McpPromptResult, McpResourceInfo, McpResourceContents, McpCompletionResult, McpRoot, McpLogLevel, McpLogMessage, McpSamplingRequest, McpSamplingResult, McpProgressParams, McpCallOptions, McpCancelledParams } from './types.js'

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
  /** 资源更新通知回调（v0.6.15 resources 订阅协议）：服务器 notifyResourceUpdated 推送的
   *  notifications/resources/updated 通知 → 按此回调转发 uri（已 subscribeResource 的资源）；缺省忽略 */
  onResourceUpdated?: (uri: string) => void
  /** 采样回调（v0.6.14 sampling 协议）：服务器发 sampling/createMessage 请求（请客户端代为调用 LLM 生成内容）
   *  时按此回调执行；配置后 initialize 声明 capabilities.sampling（未配置不声明，服务器不会请求采样）。
   *  回调返回采样结果（支持异步）；回调抛错 → 回 -32603（客户端不崩） */
  sampling?: (request: McpSamplingRequest) => McpSamplingResult | Promise<McpSamplingResult>
  /** 进度通知回调（v0.6.16 progress 通知协议）：服务器处理带 progressToken 的请求期间推送的
   *  notifications/progress 通知 → 按此回调转发（按 progressToken 关联请求）；缺省忽略 */
  onProgress?: (params: McpProgressParams) => void
  /** 工具列表变化通知回调（v0.6.20）：服务器推送 notifications/tools/list_changed（工具集动态变化）
   *  → 按此回调触发（无参）；收到后应重新拉取 tools/list 刷新清单；缺省忽略 */
  onToolsChanged?: () => void
  /** 资源列表变化通知回调（v0.6.20）：服务器推送 notifications/resources/list_changed（资源列表动态变化）
   *  → 按此回调触发（无参）；收到后应重新拉取 resources/list 刷新清单；缺省忽略 */
  onResourcesChanged?: () => void
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
  private readonly onResourceUpdated?: (uri: string) => void
  private readonly sampling?: (request: McpSamplingRequest) => McpSamplingResult | Promise<McpSamplingResult>
  private readonly onProgress?: (params: McpProgressParams) => void
  private readonly onToolsChanged?: () => void
  private readonly onResourcesChanged?: () => void

  constructor(opts: MCPClientOptions) {
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS
    this.rootsList = opts.roots || []
    this.onLog = opts.onLog
    this.onResourceUpdated = opts.onResourceUpdated
    this.sampling = opts.sampling
    this.onProgress = opts.onProgress
    this.onToolsChanged = opts.onToolsChanged
    this.onResourcesChanged = opts.onResourcesChanged
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

  /** 处理服务器通知（v0.6.13）：notifications/message → onLog 回调转发；v0.6.15：notifications/resources/updated
   *  → onResourceUpdated 回调转发（已订阅资源更新）；v0.6.16：notifications/progress → onProgress 回调转发；
   *  v0.6.20：notifications/tools/list_changed → onToolsChanged、notifications/resources/list_changed →
   *  onResourcesChanged（列表变化，应重新拉取）。缺省忽略对应回调；通知无需响应，不干扰后续请求 */
  private handleNotification(msg: any): void {
    if (msg.method === 'notifications/message') {
      if (typeof this.onLog !== 'function') return
      const p = msg.params || {}
      this.onLog({
        level: p.level as McpLogLevel,
        ...(p.logger !== undefined ? { logger: String(p.logger) } : {}),
        data: p.data,
      })
      return
    }
    if (msg.method === 'notifications/resources/updated') {
      if (typeof this.onResourceUpdated !== 'function') return
      this.onResourceUpdated(String((msg.params || {}).uri ?? ''))
      return
    }
    if (msg.method === 'notifications/progress') {
      // v0.6.16 progress 通知协议：服务器处理带 progressToken 的请求期间推送的进度更新
      if (typeof this.onProgress !== 'function') return
      const p = msg.params || {}
      this.onProgress({
        progressToken: p.progressToken as string | number,
        ...(p.progress !== undefined ? { progress: Number(p.progress) } : {}),
        ...(p.total !== undefined ? { total: Number(p.total) } : {}),
        ...(p.message !== undefined ? { message: String(p.message) } : {}),
      })
      return
    }
    if (msg.method === 'notifications/tools/list_changed') {
      // v0.6.20 列表变化通知：服务器工具集动态变化 → 客户端应重新拉取 tools/list
      if (typeof this.onToolsChanged !== 'function') return
      this.onToolsChanged()
      return
    }
    if (msg.method === 'notifications/resources/list_changed') {
      // v0.6.20 列表变化通知：服务器资源列表动态变化 → 客户端应重新拉取 resources/list
      if (typeof this.onResourcesChanged !== 'function') return
      this.onResourcesChanged()
    }
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

  /** 调用服务器工具（tools/call）；工具级失败以 isError 标记返回（协议层错误则 reject）。
   *  v0.6.16：options.progressToken → 请求带 _meta.progressToken，服务器处理期间可推送进度（onProgress 回调接收） */
  async callTool(name: string, args?: Record<string, any>, options?: McpCallOptions): Promise<McpCallResult> {
    const params: Record<string, any> = { name, arguments: args || {} }
    if (options?.progressToken !== undefined) {
      params._meta = { progressToken: options.progressToken }
    }
    const res = await this.request<any>('tools/call', params)
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

  /** 订阅资源（resources/subscribe，v0.6.15）：订阅后服务器 notifyResourceUpdated 推送更新通知 → onResourceUpdated 回调；
   *  未知 uri 协议错误则 reject（与 readResource 一致） */
  async subscribeResource(uri: string): Promise<void> {
    await this.request('resources/subscribe', { uri })
  }

  /** 退订资源（resources/unsubscribe，v0.6.15）：停止接收该资源的更新通知；未知 uri 协议错误则 reject */
  async unsubscribeResource(uri: string): Promise<void> {
    await this.request('resources/unsubscribe', { uri })
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

  /**
   * 通知服务器取消一个已发出的请求（v0.6.16 cancelled 通知协议）：发 notifications/cancelled（无 id，服务器无需响应）。
   * requestId 是**本客户端发出请求时使用的 id**（如 callTool 超时/用户取消后告知服务器停止处理）；
   * reason 可选（如 'timeout' / 'user cancelled'）。服务器已关闭 / 写失败 → 静默不抛错。
   */
  notifyCancelled(requestId: string | number, reason?: string): void {
    if (this.closed) return
    const params: McpCancelledParams = { requestId, ...(reason ? { reason } : {}) }
    try {
      this.child.stdin!.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params }) + '\n'
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
