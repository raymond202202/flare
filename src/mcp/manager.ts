/**
 * MCP 管理器（v0.5.5；v0.6.6 起支持 HTTP transport 服务器）
 *
 * 管理多个 MCP 服务器连接：
 * - 配置：~/.flare/mcp.json（或自定义路径）——`{ "servers": [{ "name", "command", "args", "env" | "url" }] }`
 *   配了 `url`（HTTP 端点，如 http://127.0.0.1:8931/mcp）走 MCPHttpClient 直连；
 *   否则按 `command` spawn stdio 子进程（MCPClient）
 * - connect(name)：连接 + initialize 握手 + 桥接工具（v0.6.26 起同时桥接资源与资源模板）；
 *   disconnect(name)：关闭并移除
 * - getAllTools()：已连接服务器的工具并集（注入 Agent config.tools）
 * - getAllResources() / getAllResourceTemplates()：已连接服务器的资源/模板并集（含来源，宿主展示用）
 * - readResource(name, uri)：代理读取某服务器资源内容
 * - getAllPrompts()（v0.6.36 prompts 桥接）：已连接服务器的提示词并集（含来源，宿主展示/透传用）
 * - getPrompt(name, promptName, args?)：代理渲染某服务器提示词
 * - callTool(name, toolName, args?)（v0.6.40）：代理调用某服务器工具
 * - status()：连接状态列表（CLI /mcp、server mcp_status 用）
 *
 * 用法：
 *   const mgr = new McpManager()                          // 读 ~/.flare/mcp.json
 *   await mgr.connect('filesystem')                       // 连接并桥接工具（stdio 或 HTTP）
 *   new Agent({ ..., tools: mgr.getAllTools() })          // 注入 Agent
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { MCPClient } from './client.js'
import { MCPHttpClient } from './http-client.js'
import { createMcpTools } from '../tools/mcp.js'
import type {
  McpServerConfig,
  McpServerStatus,
  McpResourceInfo,
  McpResourceRef,
  McpResourceTemplateInfo,
  McpResourceTemplateRef,
  McpResourceContents,
  McpPromptInfo,
  McpPromptRef,
  McpPromptResult,
  McpCompletionResult,
  McpCallResult,
  McpToolRef,
} from './types.js'
import type { Tool } from '../tools/index.js'

const DEFAULT_HTTP_TIMEOUT_MS = 15000

/** 资源桥接依赖的最小客户端接口（stdio MCPClient 与 HTTP MCPHttpClient 都满足） */
export interface McpResourceClient {
  listResources(): Promise<McpResourceInfo[]>
  listResourceTemplates(): Promise<McpResourceTemplateInfo[]>
  readResource(uri: string): Promise<McpResourceContents[]>
}

/** prompts 桥接依赖的最小客户端接口（v0.6.36；stdio MCPClient 与 HTTP MCPHttpClient 都满足） */
export interface McpPromptClient {
  listPrompts(): Promise<McpPromptInfo[]>
  getPrompt(name: string, args?: Record<string, string>): Promise<McpPromptResult>
}

/** 工具调用代理依赖的最小客户端接口（v0.6.40；stdio MCPClient 与 HTTP MCPHttpClient 都满足） */
export interface McpToolClient {
  callTool(name: string, args?: Record<string, any>): Promise<McpCallResult>
}

export interface McpManagerOptions {
  /** 配置文件路径（默认 ~/.flare/mcp.json；空串表示不读文件） */
  configPath?: string
  /** HTTP transport 服务器单请求超时（毫秒，默认 15s；服务器配置 timeoutMs 可单独覆盖） */
  httpTimeoutMs?: number
}

export class McpManager {
  private configPath: string
  private httpTimeoutMs: number
  private config: McpServerConfig[] = []
  private clients = new Map<string, MCPClient | MCPHttpClient>()
  private tools = new Map<string, Tool[]>()
  // v0.6.26 资源桥接：已连接服务器的资源/模板（连接时拉取，断开清理）
  private resources = new Map<string, McpResourceInfo[]>()
  private templates = new Map<string, McpResourceTemplateInfo[]>()
  // v0.6.36 prompts 桥接：已连接服务器的提示词（连接时拉取，断开清理）
  private prompts = new Map<string, McpPromptInfo[]>()
  private errors = new Map<string, string>()

  constructor(opts: McpManagerOptions = {}) {
    this.configPath = opts.configPath || join(homedir(), '.flare', 'mcp.json')
    this.httpTimeoutMs = opts.httpTimeoutMs || DEFAULT_HTTP_TIMEOUT_MS
    if (this.configPath) {
      this.config = loadMcpConfig(this.configPath)
    }
  }

  /** 配置的服务器列表 */
  get servers(): McpServerConfig[] {
    return this.config
  }

  /** 直接设置配置（server 启动 --mcp 等场景，不依赖配置文件） */
  setConfig(servers: McpServerConfig[]) {
    this.config = Array.isArray(servers) ? servers : []
  }

  /** 全部已连接服务器的工具并集（注入 Agent config.tools） */
  getAllTools(): Tool[] {
    const all: Tool[] = []
    for (const tools of this.tools.values()) {
      all.push(...tools)
    }
    return all
  }

  /** 全部已连接服务器的工具引用并集（v0.6.58，含来源服务器名 + 名称/描述——与 getAllResources/
   *  getAllPrompts 同构；宿主展示/调用前发现：mcp_status 只能看到 toolCount 数量，宿主在 mcp_call
   *  前需要知道具体工具名/描述） */
  getAllToolsRef(): McpToolRef[] {
    const all: McpToolRef[] = []
    for (const [server, list] of this.tools) {
      for (const t of list) {
        all.push({
          name: t.definition.function.name,
          description: t.definition.function.description,
          server,
        })
      }
    }
    return all
  }

  /** 全部已连接服务器的资源并集（v0.6.26，含来源服务器名；宿主展示/透传外部 MCP 资源用） */
  getAllResources(): McpResourceRef[] {
    const all: McpResourceRef[] = []
    for (const [server, list] of this.resources) {
      for (const r of list) all.push({ ...r, server })
    }
    return all
  }

  /** 全部已连接服务器的资源模板并集（v0.6.26，含来源服务器名；动态资源 uri 形态声明） */
  getAllResourceTemplates(): McpResourceTemplateRef[] {
    const all: McpResourceTemplateRef[] = []
    for (const [server, list] of this.templates) {
      for (const t of list) all.push({ ...t, server })
    }
    return all
  }

  /** 代理读取某服务器资源内容（v0.6.26）：调该服务器 resources/read；服务器未连接 → reject 清晰错误 */
  async readResource(name: string, uri: string): Promise<McpResourceContents[]> {
    const client = this.clients.get(name) as McpResourceClient | undefined
    if (!client) {
      throw new Error(`MCP 服务器未连接: ${name}`)
    }
    return client.readResource(uri)
  }

  /** 全部已连接服务器的提示词并集（v0.6.36，含来源服务器名；宿主展示/透传外部 MCP 提示词用） */
  getAllPrompts(): McpPromptRef[] {
    const all: McpPromptRef[] = []
    for (const [server, list] of this.prompts) {
      for (const p of list) all.push({ ...p, server })
    }
    return all
  }

  /** 代理渲染某服务器提示词（v0.6.36）：调该服务器 prompts/get；服务器未连接 → reject 清晰错误 */
  async getPrompt(name: string, promptName: string, args?: Record<string, string>): Promise<McpPromptResult> {
    const client = this.clients.get(name) as McpPromptClient | undefined
    if (!client) {
      throw new Error(`MCP 服务器未连接: ${name}`)
    }
    return client.getPrompt(promptName, args)
  }

  /** 代理调用某服务器工具（v0.6.40）：调该服务器 tools/call；服务器未连接 → reject 清晰错误 */
  async callTool(name: string, toolName: string, args?: Record<string, any>): Promise<McpCallResult> {
    const client = this.clients.get(name) as McpToolClient | undefined
    if (!client) {
      throw new Error(`MCP 服务器未连接: ${name}`)
    }
    return client.callTool(toolName, args)
  }

  /**
   * 代理请求某服务器提示词参数补全（v0.6.57）：调该服务器 completion/complete——
   * 与 getPrompt（渲染）配套：宿主渲染提示词时对带补全声明的参数给出候选值；
   * 服务器未连接 → reject 清晰错误（与 callTool/getPrompt 同模式）
   */
  async completePrompt(name: string, promptName: string, argumentName: string, value: string): Promise<McpCompletionResult> {
    const client = this.clients.get(name) as (McpPromptClient & { completePrompt(n: string, a: string, v: string): Promise<McpCompletionResult> }) | undefined
    if (!client) {
      throw new Error(`MCP 服务器未连接: ${name}`)
    }
    return client.completePrompt(promptName, argumentName, value)
  }

  /** 连接状态列表（CLI /mcp、server mcp_status 用） */
  status(): McpServerStatus[] {
    return this.config.map(c => {
      // v0.6.50：传输类型 + 目标端点/命令（宿主面板区分 stdio/HTTP 并直接展示连接目标）
      const transport: 'stdio' | 'http' = c.url ? 'http' : 'stdio'
      const target = c.url
        ? c.url
        : `${c.command || ''}${c.args?.length ? ' ' + c.args.join(' ') : ''}`
      return {
        name: c.name,
        connected: this.clients.has(c.name),
        toolCount: this.tools.get(c.name)?.length || 0,
        transport,
        target,
        // v0.6.26：已连接时带资源/模板数（无资源能力为 0）
        ...(this.clients.has(c.name)
          ? { resourceCount: this.resources.get(c.name)?.length || 0, templateCount: this.templates.get(c.name)?.length || 0 }
          : {}),
        // v0.6.36：已连接时带提示词数（无 prompts 能力为 0）
        ...(this.clients.has(c.name) ? { promptCount: this.prompts.get(c.name)?.length || 0 } : {}),
        error: this.errors.get(c.name),
      }
    })
  }

  /** 连接指定服务器（幂等：已连接直接返回已有工具） */
  async connect(name: string): Promise<Tool[]> {
    const existing = this.tools.get(name)
    if (existing) return existing
    const cfg = this.config.find(c => c.name === name)
    if (!cfg) {
      throw new Error(`未配置 MCP 服务器: ${name}（~/.flare/mcp.json 的 servers 列表）`)
    }
    if (!cfg.url && !cfg.command) {
      throw new Error(`MCP 服务器 ${name} 配置无效：需提供 command（stdio）或 url（HTTP transport）`)
    }
    this.errors.delete(name)
    // v0.6.6：配了 url 走 HTTP transport（MCPHttpClient），否则 stdio spawn（MCPClient）
    // v0.6.67：HTTP 模式透传 cfg.headers（鉴权请求头，如 Authorization Bearer）
    const client: MCPClient | MCPHttpClient = cfg.url
      ? new MCPHttpClient({ url: cfg.url, timeoutMs: cfg.timeoutMs || this.httpTimeoutMs, headers: cfg.headers })
      : new MCPClient({ command: cfg.command as string, args: cfg.args, env: cfg.env })
    try {
      await client.initialize()
      const tools = await createMcpTools(client)
      // v0.6.26 资源桥接：拉取 resources/list + resources/templates/list（容错——服务器无资源
      // 能力/请求失败时静默降级为空数组，不阻塞连接；列表变化通知回调触发后宿主可重新连接刷新）
      // v0.6.36 prompts 桥接：同时拉取 prompts/list（容错同资源——无 prompts 能力降级为空数组）
      const [resources, templates, prompts] = await Promise.all([
        safeListResources(client),
        safeListResourceTemplates(client),
        safeListPrompts(client),
      ])
      this.clients.set(name, client)
      this.tools.set(name, tools)
      this.resources.set(name, resources)
      this.templates.set(name, templates)
      this.prompts.set(name, prompts)
      return tools
    } catch (e: any) {
      this.errors.set(name, e?.message || String(e))
      try {
        client.close()
      } catch { /* 忽略 */ }
      throw e
    }
  }

  /** 断开指定服务器（返回是否真的断开了） */
  disconnect(name: string): boolean {
    const client = this.clients.get(name)
    if (!client) return false
    try {
      client.close()
    } catch { /* 忽略 */ }
    this.clients.delete(name)
    this.tools.delete(name)
    // v0.6.26：资源/模板随连接一并清理
    this.resources.delete(name)
    this.templates.delete(name)
    // v0.6.36：提示词随连接一并清理
    this.prompts.delete(name)
    this.errors.delete(name)
    return true
  }

  /** 断开全部连接（进程退出清理） */
  closeAll() {
    for (const name of [...this.clients.keys()]) {
      this.disconnect(name)
    }
  }
}

/** 从配置文件读取 MCP 服务器列表（文件不存在 / 解析失败 → 空列表，不抛错） */
export function loadMcpConfig(configPath: string): McpServerConfig[] {
  try {
    if (!configPath || !existsSync(configPath)) return []
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.servers) ? (parsed.servers as McpServerConfig[]) : []
  } catch {
    return []
  }
}

/** 容错拉取资源列表（v0.6.26）：服务器无 resources 能力 / 请求失败 → 静默降级为空数组（不阻塞连接） */
async function safeListResources(client: McpResourceClient): Promise<McpResourceInfo[]> {
  try {
    const list = await client.listResources()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** 容错拉取资源模板列表（v0.6.26）：同上，无模板能力 → 空数组 */
async function safeListResourceTemplates(client: McpResourceClient): Promise<McpResourceTemplateInfo[]> {
  try {
    const list = await client.listResourceTemplates()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** 容错拉取提示词列表（v0.6.36）：服务器无 prompts 能力 / 请求失败 → 静默降级为空数组（不阻塞连接） */
async function safeListPrompts(client: McpPromptClient): Promise<McpPromptInfo[]> {
  try {
    const list = await client.listPrompts()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}
