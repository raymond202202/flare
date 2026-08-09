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
import type { McpContentItem, McpPrompt, McpPromptMessage, McpResource, McpResourceContents, McpTool } from './types.js'
import { MCP_PROTOCOL_VERSION } from './client.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

/** MCPServer 选项 */
export interface MCPServerOptions {
  /** flare 工具集（默认内置工具 tools：read_file/write_file/search_files/terminal/memory_search/memory_save） */
  tools?: Tool[]
  /** MCP 资源（v0.6.1）：resources/list 真实暴露 + resources/read 读取；缺省无资源能力（空列表） */
  resources?: McpResource[]
  /** MCP 提示词（v0.6.2）：prompts/list 真实暴露 + prompts/get 渲染；缺省无 prompts 能力（空列表） */
  prompts?: McpPrompt[]
  /** 服务器信息（默认 name: 'flare'，version 读 package.json 不硬编码） */
  serverInfo?: { name: string; version: string }
  /** 输出函数（默认 process.stdout.write + 换行；测试可注入收集） */
  write?: (line: string) => void
  /** 输入流（默认 process.stdin；测试/嵌入式可注入） */
  input?: NodeJS.ReadableStream
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

  constructor(opts: MCPServerOptions = {}) {
    this.toolList = opts.tools ?? tools
    this.resourceList = opts.resources ?? []
    this.promptList = opts.prompts ?? []
    this.serverInfo = opts.serverInfo ?? { name: 'flare', version: pkg.version }
    this.write = opts.write ?? ((line) => process.stdout.write(line + '\n'))
    this.input = opts.input ?? process.stdin
  }

  /** 开始监听输入流（幂等：重复调用不重复监听） */
  start(): void {
    if (this.closed || this.rl) return
    this.rl = createInterface({ input: this.input })
    this.rl.on('line', (line) => this.handleLine(line))
  }

  /** 关闭服务器（停止监听；未完成的请求仍会尽力响应） */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.rl?.close()
    } catch { /* 忽略 */ }
    this.rl = undefined
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** 处理一行输入：JSON 解析失败回 parse error；通知（无 id）忽略；请求入队串行 */
  private handleLine(line: string): void {
    if (!line.trim()) return
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      this.safeWrite({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    if (msg === null || typeof msg !== 'object' || msg.id === undefined || msg.id === null) {
      // 通知类消息（无 id）：MCP 的 notifications/initialized 等——无需响应
      return
    }
    const id = msg.id
    const method = typeof msg.method === 'string' ? msg.method : ''
    this.queue = this.queue.then(() => this.processRequest(id, method, msg.params || {}))
  }

  /** 处理单个请求并写响应（错误 → JSON-RPC error 对象） */
  private async processRequest(id: number | string | boolean, method: string, params: any): Promise<void> {
    try {
      const result = await this.dispatch(method, params)
      this.safeWrite({ jsonrpc: '2.0', id, result })
    } catch (e: any) {
      this.safeWrite({
        jsonrpc: '2.0',
        id,
        error: {
          code: typeof e?.code === 'number' ? e.code : -32603,
          message: e?.message || String(e),
        },
      })
    }
  }

  /** 方法分发（MCP 核心子集） */
  private async dispatch(method: string, params: any): Promise<any> {
    switch (method) {
      case 'initialize':
        // 握手：协商协议版本、声明能力（tools / 可选 resources / 可选 prompts）、返回服务器信息
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
            ...(this.resourceList.length > 0 ? { resources: {} } : {}),
            ...(this.promptList.length > 0 ? { prompts: {} } : {}),
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
