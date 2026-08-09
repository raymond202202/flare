/**
 * MCP 管理器（v0.5.5；v0.6.6 起支持 HTTP transport 服务器）
 *
 * 管理多个 MCP 服务器连接：
 * - 配置：~/.flare/mcp.json（或自定义路径）——`{ "servers": [{ "name", "command", "args", "env" | "url" }] }`
 *   配了 `url`（HTTP 端点，如 http://127.0.0.1:8931/mcp）走 MCPHttpClient 直连；
 *   否则按 `command` spawn stdio 子进程（MCPClient）
 * - connect(name)：连接 + initialize 握手 + 桥接工具；disconnect(name)：关闭并移除
 * - getAllTools()：已连接服务器的工具并集（注入 Agent config.tools）
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
import type { McpServerConfig, McpServerStatus } from './types.js'
import type { Tool } from '../tools/index.js'

const DEFAULT_HTTP_TIMEOUT_MS = 15000

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

  /** 连接状态列表（CLI /mcp、server mcp_status 用） */
  status(): McpServerStatus[] {
    return this.config.map(c => ({
      name: c.name,
      connected: this.clients.has(c.name),
      toolCount: this.tools.get(c.name)?.length || 0,
      error: this.errors.get(c.name),
    }))
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
    const client: MCPClient | MCPHttpClient = cfg.url
      ? new MCPHttpClient({ url: cfg.url, timeoutMs: cfg.timeoutMs || this.httpTimeoutMs })
      : new MCPClient({ command: cfg.command as string, args: cfg.args, env: cfg.env })
    try {
      await client.initialize()
      const tools = await createMcpTools(client)
      this.clients.set(name, client)
      this.tools.set(name, tools)
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
