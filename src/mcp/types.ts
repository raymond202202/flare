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
  /** 启动命令（stdio transport；与 url 二选一，v0.6.6 起可选——配了 url 则走 HTTP） */
  command?: string
  /** 命令参数（如 ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]） */
  args?: string[]
  /** 附加环境变量（合并到 process.env） */
  env?: Record<string, string>
  /** HTTP transport 端点（如 http://127.0.0.1:8931/mcp，v0.6.6）：配了 url 用 MCPHttpClient 直连，否则 stdio spawn */
  url?: string
  /** 单请求超时毫秒（HTTP transport 用，默认 15s；McpManager({ httpTimeoutMs }) 可全局覆盖） */
  timeoutMs?: number
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

/** MCP 资源（v0.6.1 resources 真实暴露）：宿主注入的资源描述 + 内容读取函数 */
export interface McpResource {
  /** 资源唯一标识（如 file:///etc/hosts、memory://preferences） */
  uri: string
  /** 资源名称（展示用） */
  name: string
  description?: string
  mimeType?: string
  /** 读取资源内容（返回纯文本；异步可注入） */
  read(): string | Promise<string>
}

/** MCP resources/read 响应内容项（contents[] 元素） */
export interface McpResourceContents {
  uri: string
  mimeType?: string
  text: string
}

/** MCP resources/list 响应项（客户端视角 v0.6.6：元数据，不含读取函数） */
export interface McpResourceInfo {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

/** MCP prompt 模板参数（prompts/list 响应 arguments[] 元素） */
export interface McpPromptArgument {
  name: string
  description?: string
  required?: boolean
}

/** MCP prompts/get 响应消息项（messages[] 元素） */
export interface McpPromptMessage {
  role: 'user' | 'assistant'
  content: { type: 'text'; text: string }
}

/** MCP prompt（v0.6.2 prompts 真实暴露）：宿主注入的提示词模板 + 渲染函数 */
export interface McpPrompt {
  /** 提示词唯一名称（prompts/get 定位用） */
  name: string
  description?: string
  /** 模板参数声明（prompts/list 暴露给客户端补全提示） */
  arguments?: McpPromptArgument[]
  /** 渲染提示词内容（按客户端传入的 arguments 填充模板；返回消息列表，支持异步） */
  render(args: Record<string, string>): McpPromptMessage[] | Promise<McpPromptMessage[]>
  /** 参数补全（v0.6.11）：按参数名 + 当前输入值返回候选值（completion/complete 用）；缺省无补全能力 */
  complete?(argumentName: string, value: string): string[] | Promise<string[]>
}

/** MCP prompts/list 响应项（客户端视角：元数据，不含渲染函数） */
export interface McpPromptInfo {
  name: string
  description?: string
  arguments?: McpPromptArgument[]
}

/** MCP prompts/get 响应（客户端视角：渲染后的消息序列） */
export interface McpPromptResult {
  description?: string
  messages: McpPromptMessage[]
}

/** MCP completion/complete 响应（v0.6.11）：prompt 参数补全候选值 */
export interface McpCompletionResult {
  /** 补全候选值（无补全能力时为空数组） */
  values: string[]
  /** 候选总数（可选；用于分页提示） */
  total?: number
  /** 是否还有更多（可选；默认 false） */
  hasMore?: boolean
}

/** MCP root（v0.6.12 roots 协议）：客户端暴露给服务器的命名空间/根目录（如项目目录、工作区） */
export interface McpRoot {
  /** 根目录 URI（如 file:///home/user/projects、memory://workspace） */
  uri: string
  /** 可选显示名称 */
  name?: string
}

/** MCP roots/list 响应（服务器视角 v0.6.12）：客户端暴露的根目录列表 */
export interface McpRootsResult {
  roots: McpRoot[]
}
