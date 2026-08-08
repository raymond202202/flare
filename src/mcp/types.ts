/**
 * MCP (Model Context Protocol) 类型定义（v0.5.5）
 *
 * 覆盖 flare 使用的 MCP 核心子集：
 * - 服务器配置（~/.flare/mcp.json）
 * - 工具定义（tools/list 响应）
 * - 调用结果（tools/call 响应）
 * - 连接状态（CLI /mcp、server mcp_status 展示用）
 */

/** MCP 服务器配置（~/.flare/mcp.json 的 servers 列表项） */
export interface McpServerConfig {
  /** 服务器名称（CLI /mcp connect <name> 用） */
  name: string
  /** 启动命令（如 npx、node、python） */
  command: string
  /** 命令参数（如 ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]） */
  args?: string[]
  /** 附加环境变量（合并到 process.env） */
  env?: Record<string, string>
  /** 是否默认连接（CLI 启动时自动连接；预留） */
  default?: boolean
}

/** MCP 配置文件结构 */
export interface McpConfigFile {
  servers: McpServerConfig[]
}

/** MCP 工具定义（tools/list 响应项） */
export interface McpTool {
  name: string
  description?: string
  /** JSON Schema（inputSchema） */
  inputSchema?: Record<string, unknown>
}

/** MCP 调用结果内容项（tools/call 响应 content[]） */
export interface McpContentItem {
  type: string
  text?: string
  [key: string]: unknown
}

/** MCP 工具调用结果（tools/call 响应） */
export interface McpCallResult {
  content: McpContentItem[]
  /** 工具级错误标志（true = 工具执行失败，但协议层正常） */
  isError?: boolean
  structuredContent?: unknown
}

/** 服务器连接状态（CLI /mcp、server mcp_status 用） */
export interface McpServerStatus {
  name: string
  connected: boolean
  toolCount: number
  error?: string
}
