/**
 * MCP (Model Context Protocol) stdio 服务器（v0.5.8，零依赖手写）
 *
 * 与 MCPClient（v0.5.5）对称：flare 把自己的工具集（内置工具 / 专家工具 / MCP 桥接工具）
 * 通过 MCP 标准协议暴露给外部 AI 客户端（Claude Desktop / Cursor / 其他 MCP 客户端），
 * 或给 Pulse/StorySpire 的宿主进程直接复用 flare 工具能力。
 *
 * 传输：JSON-RPC 2.0 over stdio——每行一个 JSON（NDJSON），与 MCPClient 完全互通。
 * 覆盖 MCP 核心子集（工具互通所需）：
 *   initialize / notifications/initialized / tools/list / tools/call / ping
 *   （v0.6.1 resources、v0.6.2 prompts、v0.6.11 completion/complete、v0.6.13 logging/setLevel）
 *
 * 设计：
 * - 零依赖：不引入 @modelcontextprotocol/sdk，直接手写 NDJSON 行协议
 * - 输入/输出可注入（write/input），便于测试与嵌入式使用（不限于 process.stdin/stdout）
 * - 请求按到达顺序串行响应（内部队列，避免慢工具导致响应乱序）
 * - 工具执行异常/失败 → isError 标记返回（协议层不中断）；未知方法 → -32601
 * - 安全继承：暴露的是 flare 原生工具，危险命令黑名单 / 路径保护 / 记忆边界照常生效
 *
 * 用法（库）：
 *   const server = new MCPServer({ tools: [...builtinTools] })
 *   server.start()          // 监听 stdin，处理请求直到 EOF
 *   server.close()
 */
import { createInterface, type Interface } from 'node:readline'
import { createRequire } from 'node:module'
import { tools, type Tool, type ToolResult } from '../tools/index.js'
import type { McpCompletionResult, McpContentItem, McpLogLevel, McpLogMessage, McpPrompt, McpPromptMessage, McpResource, McpResourceContents, McpRoot, McpSamplingRequest, McpSamplingResult, McpTool } from './types.js'
import { MCP_PROTOCOL_VERSION } from './client.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

/** MCP 日志级别（v0.6.13）：按严重程度升序，setLevel 阈值过滤用 */
export const MCP_LOG_LEVELS: McpLogLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']

/** 默认日志级别阈值（未 setLevel 时只发不低于此级别的日志） */
export const MCP_DEFAULT_LOG_LEVEL: McpLogLevel = 'info'

/** 级别权重（>= 阈值才推送） */
function logLevelWeight(level: McpLogLevel): number {
  return MCP_LOG_LEVELS.indexOf(level)
}

/** MCPServer 选项 */
export interface MCPServerOptions {
  /** flare 工具集（默认内置工具 tools：read_file/write_file/search_files/terminal/memory_search/memory_save） */
  tools?: Tool[]
  /** MCP 资源（v0.6.1）：resources/list 真实暴露 + resources/read 读取；缺省无资源能力（空列表） */
  resources?: McpResource[]
  /** MCP 提示词（v0.6.2）：prompts/list 真实暴露 + prompts/get 渲染；缺省无 prompts 能力（空列表） */
  prompts?: McpPrompt[]
  /** MCP logging（v0.6.13）：是否声明 capabilities.logging 并支持 logging/setLevel + sendLog 推送；
   *  缺省 true（协议标准能力，声明后客户端可设置日志级别）；false 关闭（不声明、sendLog 丢弃） */
  logging?: boolean
  /** 服务器信息（默认 name: 'flare'，version 读 package.json 不硬编码） */
  serverInfo?: { name: string; version: string }
  /** 输出函数（默认 process.stdout.write + 换行；测试可注入收集） */
  write?: (line: string) => void
  /** 输入流（默认 process.stdin；测试/嵌入式可注入） */
  input?: NodeJS.ReadableStream
  /** 服务器→客户端请求超时毫秒（v0.6.12 requestRoots 用，默认 15s） */
  requestTimeoutMs?: number
}

/** flare Tool → MCP 工具定义（tools/list 响应项） */
export function toMcpTool(tool: Tool): McpTool {
  const def = tool.definition.function
  return {
    name: def.name,
    description: def.description,
    inputSchema: (def.parameters as Record<string, unknown> | undefined) ?? { type: 'object' },
  }
}

export class MCPServer {
  private readonly toolList: Tool[]
  private readonly resourceList: McpResource[]
  private readonly promptList: McpPrompt[]
  private readonly serverInfo: { name: string; version: string }
  private readonly write: (line: string) => void
  private readonly input: NodeJS.ReadableStream
  private rl?: Interface
  private closed = false
  /** 串行响应队列：请求按到达顺序处理，避免慢工具导致响应乱序 */
  private queue: Promise<void> = Promise.resolve()
  /** 服务器→客户端请求的 pending 响应（v0.6.12 requestRoots 用）：客户端回响应行时按 id 匹配 */
  private pending = new Map<number, { resolve: (result: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>()
  private nextRequestId = 1
  private readonly requestTimeoutMs: number
  /** logging 能力开关（v0.6.13：声明 capabilities.logging 并推送日志；缺省 true） */
  private readonly loggingEnabled: boolean
  /** 当前日志级别阈值（v0.6.13：客户端 logging/setLevel 设置，未设置默认 info） */
  private logLevel: McpLogLevel = MCP_DEFAULT_LOG_LEVEL

  constructor(opts: MCPServerOptions = {}) {
    this.toolList = opts.tools ?? tools
    this.resourceList = opts.resources ?? []
    this.promptList = opts.prompts ?? []
    this.serverInfo = opts.serverInfo ?? { name: 'flare', version: pkg.version }
    this.write = opts.write ?? ((line) => process.stdout.write(line + '\n'))
    this.input = opts.input ?? process.stdin
    this.requestTimeoutMs = opts.requestTimeoutMs || 15000
    this.loggingEnabled = opts.logging !== false
  }

  /** 开始监听输入流（幂等：重复调用不重复监听） */
  start(): void {
    if (this.closed || this.rl) return
    this.rl = createInterface({ input: this.input })
    this.rl.on('line', (line) => this.handleLine(line))
  }

  /** 关闭服务器（停止监听；未完成的请求仍会尽力响应；pending 的服务器→客户端请求被拒绝） */
  close(): void {
    if (this.closed) return
    this.closed = true
    // v0.6.12：拒绝未完成的服务器→客户端请求（如 requestRoots），避免悬挂
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('MCP 服务器已关闭'))
    }
    this.pending.clear()
    try {
      this.rl?.close()
    } catch { /* 忽略 */ }
    this.rl = undefined
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** 处理一行输入：JSON 解析失败回 parse error；客户端对服务器请求的响应 → 匹配 pending；通知（无 id）忽略；请求入队串行 */
  private handleLine(line: string): void {
    if (!line.trim()) return
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      this.safeWrite({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    // v0.6.12：客户端对服务器主动请求（requestRoots）的响应行——按 id 匹配 pending，不当作新请求。
    // 注意：响应行无 method；带 method 的行是客户端发来的新请求（id 可能与 pending 撞车，如双方都从 1 自增），
    // 不能误判为响应——加 method 校验，请求行始终走正常分发。
    if (msg && msg.id !== undefined && typeof msg.method !== 'string' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) {
        p.reject(new Error(`MCP 错误: ${msg.error.message || JSON.stringify(msg.error)}`))
      } else {
        p.resolve(msg.result)
      }
      return
    }
    this.queue = this.queue.then(async () => {
      const resp = await this.handleMessage(msg)
      if (resp) this.safeWrite(resp)
    })
  }

  /**
   * 处理单个 JSON-RPC 消息（v0.6.3，传输无关）：返回响应对象（或 null——通知类消息无需响应）。
   * stdio（handleLine）与 HTTP（src/mcp/http.ts）共用；错误 → JSON-RPC error 对象（不抛出）。
   */
  async handleMessage(msg: any): Promise<any> {
    if (msg === null || typeof msg !== 'object' || msg.id === undefined || msg.id === null) {
      // 通知类消息（无 id）：MCP 的 notifications/initialized 等——无需响应
      return null
    }
    const id = msg.id
    const method = typeof msg.method === 'string' ? msg.method : ''
    try {
      const result = await this.dispatch(method, msg.params || {})
      return { jsonrpc: '2.0', id, result }
    } catch (e: any) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: typeof e?.code === 'number' ? e.code : -32603,
          message: e?.message || String(e),
        },
      }
    }
  }

  /** 方法分发（MCP 核心子集） */
  private async dispatch(method: string, params: any): Promise<any> {
    switch (method) {
      case 'initialize':
        // 握手：协商协议版本、声明能力（tools / 可选 resources / 可选 prompts / 可选 completions / logging）、返回服务器信息
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
            ...(this.resourceList.length > 0 ? { resources: {} } : {}),
            ...(this.promptList.length > 0 ? { prompts: {} } : {}),
            // v0.6.11：至少一个 prompt 提供补全回调时声明 completions 能力（completion/complete）
            ...(this.hasCompletions ? { completions: {} } : {}),
            // v0.6.13：logging 能力（logging/setLevel 设置日志级别 + sendLog 推送；缺省声明，logging:false 关闭）
            ...(this.loggingEnabled ? { logging: {} } : {}),
          },
          serverInfo: this.serverInfo,
        }
      case 'tools/list':
        return { tools: this.toolList.map(toMcpTool) }
      case 'tools/call':
        return this.callTool(params)
      case 'resources/list':
        // v0.6.1：真实暴露注入的资源（元数据；内容经 resources/read 读取）
        return {
          resources: this.resourceList.map(r => ({
            uri: r.uri,
            name: r.name,
            ...(r.description ? { description: r.description } : {}),
            ...(r.mimeType ? { mimeType: r.mimeType } : {}),
          })),
        }
      case 'resources/read':
        return this.readResource(params)
      case 'prompts/list':
        // v0.6.2：真实暴露注入的提示词模板（元数据；渲染经 prompts/get）
        return {
          prompts: this.promptList.map(p => ({
            name: p.name,
            ...(p.description ? { description: p.description } : {}),
            ...(p.arguments && p.arguments.length > 0 ? { arguments: p.arguments } : {}),
          })),
        }
      case 'prompts/get':
        return this.getPrompt(params)
      case 'completion/complete':
        // v0.6.11：prompt 参数补全候选值（客户端交互式输入时提供建议）
        return this.complete(params)
      case 'logging/setLevel':
        // v0.6.13：客户端设置日志级别阈值（此后低于该级别的 sendLog 不再推送）
        return this.setLogLevel(params)
      case 'ping':
        // JSON-RPC 标准健康检查
        return {}
      case 'notifications/initialized':
        // 客户端通知初始化完成（规范上无 id，不会走到这；容忍有 id 的畸形请求）
        return {}
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
    }
  }

  /**
   * 请求客户端暴露的 roots（v0.6.12 roots 协议）：服务器主动向客户端发 roots/list 请求，
   * 等待客户端响应（带超时，默认 requestTimeoutMs）。支持 roots 的客户端（如 flare MCPClient 配置了 roots）
   * 返回注入的根目录列表；客户端响应非数组容错返回 []；客户端回 error / 超时 / 服务器已关闭 → reject。
   */
  requestRoots(timeoutMs?: number): Promise<McpRoot[]> {
    if (this.closed) {
      return Promise.reject(new Error('MCP 服务器已关闭'))
    }
    const id = this.nextRequestId++
    return new Promise<McpRoot[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP roots/list 请求超时（客户端未响应）`))
      }, timeoutMs || this.requestTimeoutMs)
      this.pending.set(id, {
        resolve: (result: any) => {
          // 容错：响应缺 roots 或非数组 → 空列表（与客户端 listTools/listResources 的宽松解析一致）
          resolve(Array.isArray(result?.roots) ? (result.roots as McpRoot[]) : [])
        },
        reject,
        timer,
      })
      this.safeWrite({ jsonrpc: '2.0', id, method: 'roots/list', params: {} })
    })
  }

  /**
   * 请求客户端代为采样（v0.6.14 sampling 协议）：服务器主动向客户端发 sampling/createMessage 请求，
   * 请客户端（宿主应用）调用其 LLM 能力生成内容——服务器自身无模型时的标准 MCP 做法。
   * 等待客户端响应（带超时，默认 requestTimeoutMs）；客户端回 error / 超时 / 服务器已关闭 → reject；
   * 响应缺 content 或非 text → reject（不悬挂，与 roots 容错 [] 不同——采样结果必须有内容才可用）。
   */
  requestSample(request: McpSamplingRequest, timeoutMs?: number): Promise<McpSamplingResult> {
    if (this.closed) {
      return Promise.reject(new Error('MCP 服务器已关闭'))
    }
    if (!request || !Array.isArray(request.messages) || request.messages.length === 0) {
      return Promise.reject(new Error('MCP sampling/createMessage 需要 messages（至少一条消息）'))
    }
    const id = this.nextRequestId++
    return new Promise<McpSamplingResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP sampling/createMessage 请求超时（客户端未响应）`))
      }, timeoutMs || this.requestTimeoutMs)
      this.pending.set(id, {
        resolve: (result: any) => {
          // 响应必须有可用的文本内容才 resolve；否则 reject（不悬挂、不吞错）
          const content = result?.content
          if (!content || content.type !== 'text' || typeof content.text !== 'string') {
            reject(new Error('MCP sampling/createMessage 响应无效（缺 content.text）'))
            return
          }
          resolve({
            role: result.role === 'user' ? 'user' : 'assistant',
            content: { type: 'text', text: content.text },
            ...(typeof result.model === 'string' ? { model: result.model } : {}),
            ...(typeof result.stopReason === 'string' ? { stopReason: result.stopReason } : {}),
          } as McpSamplingResult)
        },
        reject,
        timer,
      })
      this.safeWrite({ jsonrpc: '2.0', id, method: 'sampling/createMessage', params: request })
    })
  }

  /** 读取资源（resources/read）：未知 uri → -32602；read() 异常 → -32603（服务器不崩） */
  private async readResource(params: any): Promise<{ contents: McpResourceContents[] }> {
    const uri = String(params?.uri || '')
    const resource = this.resourceList.find(r => r.uri === uri)
    if (!resource) {
      throw Object.assign(new Error(`Unknown resource: ${uri}`), { code: -32602 })
    }
    const text = await resource.read()
    return {
      contents: [{
        uri: resource.uri,
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        text: String(text),
      }],
    }
  }

  /** 渲染提示词（prompts/get）：未知 name → -32602；render() 异常 → -32603（服务器不崩） */
  private async getPrompt(params: any): Promise<{ description?: string; messages: McpPromptMessage[] }> {
    const name = String(params?.name || '')
    const prompt = this.promptList.find(p => p.name === name)
    if (!prompt) {
      throw Object.assign(new Error(`Unknown prompt: ${name}`), { code: -32602 })
    }
    const args: Record<string, string> = {}
    if (params?.arguments && typeof params.arguments === 'object') {
      for (const [k, v] of Object.entries(params.arguments)) {
        args[k] = String(v)
      }
    }
    const messages = await prompt.render(args)
    return {
      ...(prompt.description ? { description: prompt.description } : {}),
      messages,
    }
  }

  /** 是否有补全能力（v0.6.11）：任一 prompt 提供 complete 回调，或暴露了资源（uri 前缀建议） */
  private get hasCompletions(): boolean {
    return this.promptList.some(p => typeof p.complete === 'function') || this.resourceList.length > 0
  }

  /**
   * 参数补全（completion/complete，v0.6.11）：返回候选值供客户端交互式输入建议。
   * - ref/ref-prompt：查 prompt.complete(argumentName, value) 回调（无回调 → 空候选）
   * - ref/ref-resource：按已暴露资源 uri 前缀建议（资源 uri 模板补全）
   * 未知 prompt / 未知 ref 类型 → -32602；回调异常 → -32603（服务器不崩）。
   */
  private async complete(params: any): Promise<{ completion: McpCompletionResult }> {
    const ref = params?.ref
    const refType = ref?.type === 'ref/resource' ? 'ref/resource' : 'ref/prompt'
    const name = String(ref?.name ?? ref?.uri ?? '')
    const argumentName = String(params?.argument?.name || '')
    const value = String(params?.argument?.value ?? '')
    if (!name) {
      throw Object.assign(new Error('completion/complete 需要 ref（ref/prompt 的 name 或 ref/resource 的 uri）'), { code: -32602 })
    }
    let values: string[]
    if (refType === 'ref/resource') {
      // 资源 uri 补全：已暴露资源中 uri 以当前输入为前缀的建议
      values = this.resourceList.map(r => r.uri).filter(uri => uri.startsWith(value))
    } else {
      const prompt = this.promptList.find(p => p.name === name)
      if (!prompt) {
        throw Object.assign(new Error(`Unknown prompt: ${name}`), { code: -32602 })
      }
      values = typeof prompt.complete === 'function'
        ? await prompt.complete(argumentName, value)
        : []
    }
    return { completion: { values, total: values.length, hasMore: false } }
  }

  /**
   * 客户端设置日志级别（logging/setLevel，v0.6.13）：阈值过滤生效——低于该级别的 sendLog 不再推送。
   * 非法级别 → -32602；logging 关闭时宽容接受（返回 {}，客户端探测兼容）。
   */
  private setLogLevel(params: any): {} {
    const level = String(params?.level || '')
    if (!MCP_LOG_LEVELS.includes(level as McpLogLevel)) {
      throw Object.assign(
        new Error(`Invalid log level: ${level}（合法值: ${MCP_LOG_LEVELS.join(' | ')}）`),
        { code: -32602 }
      )
    }
    this.logLevel = level as McpLogLevel
    return {}
  }

  /**
   * 服务器推送结构化日志（v0.6.13）：发 notifications/message 通知（无 id，客户端无需响应）。
   * - 级别低于当前阈值（logging/setLevel 设置，默认 info）→ 丢弃（不推送）
   * - logging 关闭（logging:false）→ 丢弃
   * - 服务器已关闭 / 写失败 → 静默忽略（不抛错）
   */
  sendLog(level: McpLogLevel, data: unknown, logger?: string): void {
    if (!this.loggingEnabled || this.closed) return
    if (logLevelWeight(level) < logLevelWeight(this.logLevel)) return
    const msg: McpLogMessage = { level, data, ...(logger ? { logger } : {}) }
    this.safeWrite({ jsonrpc: '2.0', method: 'notifications/message', params: msg })
  }

  /** 当前日志级别阈值（v0.6.13，测试/调试用） */
  get currentLogLevel(): McpLogLevel {
    return this.logLevel
  }

  /** 执行 flare 工具并包装为 MCP 调用结果；工具级失败 → isError（协议层不抛） */
  private async callTool(params: any): Promise<{ content: McpContentItem[]; isError?: boolean }> {
    const name = String(params?.name || '')
    const tool = this.toolList.find((t) => t.definition.function.name === name)
    if (!tool) {
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 })
    }
    try {
      const result: ToolResult = await tool.execute((params?.arguments || {}) as Record<string, any>)
      const text = result.success
        ? result.output
        : `${result.error || '工具执行失败'}${result.output ? '\n' + result.output : ''}`
      return {
        content: [{ type: 'text', text }],
        ...(result.success ? {} : { isError: true }),
      }
    } catch (e: any) {
      // 工具内部抛异常（协议错误之外的意外）：按工具级失败返回，服务器不崩
      return {
        content: [{ type: 'text', text: `工具执行异常: ${e?.message || String(e)}` }],
        isError: true,
      }
    }
  }

  /** 写响应（服务器已关闭则不写；write 抛错不致命） */
  private safeWrite(msg: unknown): void {
    if (this.closed) return
    try {
      this.write(JSON.stringify(msg))
    } catch { /* 忽略 */ }
  }
}

/**
 * 便捷工厂：创建并启动 MCP 服务器（阻塞式监听 stdin）。
 * 供 CLI / 宿主进程把 flare 工具集暴露为 MCP stdio 服务器。
 */
export function startMcpServer(opts?: MCPServerOptions): MCPServer {
  const server = new MCPServer(opts)
  server.start()
  return server
}
