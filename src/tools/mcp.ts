/**
 * MCP 工具桥（v0.5.5）
 *
 * 把外部 MCP 服务器的工具（tools/list）桥接为 flare 的 Tool 接口：
 * - definition：MCP inputSchema（JSON Schema）→ flare parameters（OpenAI 兼容格式）
 * - execute：调 MCPClient.callTool，提取内容；isError → success:false；
 *   协议层错误（reject）→ success:false + error 信息（不抛出，遵循 flare 工具约定）
 *
 * v0.6.117：内容提取升级——非 text 内容项（image/audio/resource）不再静默丢弃，
 * 输出安全占位描述（含类型/mimeType/数据量，**绝不含 base64 明文**）；structuredContent
 * （MCP 2025-06-18 协议结构化返回）在无文本时 JSON 兜底（截断保护）。
 *
 * 用法（client 需先 initialize）：
 *   const client = new MCPClient({ command: 'npx', args: [...] })
 *   await client.initialize()
 *   const tools = await createMcpTools(client)   // → flare Tool[]，可注入 Agent config.tools
 *
 * v0.6.6：client 参数放宽为 McpToolClient 接口——stdio MCPClient 与 HTTP MCPHttpClient
 * （接口完全一致）都满足，传输无关（McpManager 按服务器配置自动选传输）。
 */

import type { Tool } from './index.js'
import type { McpTool, McpCallResult, McpContentItem } from '../mcp/types.js'

/** 工具桥依赖的最小客户端接口（stdio MCPClient 与 HTTP MCPHttpClient 都满足） */
export interface McpToolClient {
  listTools(): Promise<McpTool[]>
  callTool(name: string, args?: Record<string, any>): Promise<McpCallResult>
}

/** 文本提取的最大长度（structuredContent JSON 兜底时截断保护，防止巨型结构化数据灌爆上下文） */
const STRUCTURED_MAX_CHARS = 4000

/**
 * 把 MCP tools/call 响应内容转为 flare 工具输出文本（v0.6.117，纯函数）
 *
 * 处理规则：
 * - text 项 → 原文提取（多项按序拼接）
 * - image/audio 项 → `[图片/音频 mimeType: X, 数据 N 字符]` 占位（**不输出 base64 明文**——
 *   避免把大体积/敏感二进制数据灌进上下文）
 * - resource 项（embedded resource）→ `[资源 uri: X mimeType: Y]` 占位；text 字段存在且较短时
 *   附文本内容（blob base64 绝不输出）
 * - 未知类型 → `[内容类型: X]` 占位（不再静默丢弃，调用方知道有非文本内容被省略）
 * - 全部无文本且 structuredContent 存在 → JSON 序列化兜底（超过 STRUCTURED_MAX_CHARS 截断 +
 *   省略标记，纯函数可离线单测）
 */
export function mcpContentToText(content: McpContentItem[] | undefined, structuredContent?: unknown): string {
  const parts: string[] = []
  for (const item of Array.isArray(content) ? content : []) {
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
      continue
    }
    if (item.type === 'image' || item.type === 'audio') {
      const kind = item.type === 'image' ? '图片' : '音频'
      const mime = typeof item.mimeType === 'string' && item.mimeType ? item.mimeType : '未知'
      const dataLen = typeof item.data === 'string' ? item.data.length : 0
      parts.push(`[${kind} mimeType: ${mime}, 数据 ${dataLen} 字符]`)
      continue
    }
    if (item.type === 'resource') {
      const res = (item.resource || {}) as Record<string, unknown>
      const uri = typeof res.uri === 'string' ? res.uri : '未知'
      const mime = typeof res.mimeType === 'string' && res.mimeType ? res.mimeType : undefined
      parts.push(`[资源 uri: ${uri}${mime ? ` mimeType: ${mime}` : ''}]`)
      // embedded resource 的 text 字段是文本内容（设计上给模型看的）→ 附上；blob 绝不输出
      if (typeof res.text === 'string' && res.text.length > 0 && res.text.length <= 2000) {
        parts.push(res.text)
      }
      continue
    }
    const type = typeof item.type === 'string' && item.type ? item.type : '未知'
    parts.push(`[内容类型: ${type}]`)
  }
  const joined = parts.join('\n')
  if (joined.trim().length > 0) return joined
  // 无文本内容但服务器返回结构化数据（2025-06-18 协议）→ JSON 兜底
  if (structuredContent !== undefined && structuredContent !== null) {
    let json: string
    try {
      json = JSON.stringify(structuredContent)
    } catch {
      return '[结构化内容无法序列化]'
    }
    if (json.length <= STRUCTURED_MAX_CHARS) return json
    return json.slice(0, STRUCTURED_MAX_CHARS) + `\n…[结构化内容过长，省略 ${json.length - STRUCTURED_MAX_CHARS} 字符]…`
  }
  return ''
}

/** 从 MCP 服务器创建 flare 工具（拉取 tools/list 并逐个桥接） */
export async function createMcpTools(client: McpToolClient): Promise<Tool[]> {
  const defs = await client.listTools()
  return defs.map(def => ({
    definition: {
      type: 'function',
      function: {
        name: def.name,
        description: def.description || `MCP 工具 ${def.name}`,
        parameters: (def.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
      },
    },
    execute: async (args: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }> => {
      try {
        const res = await client.callTool(def.name, args || {})
        const text = mcpContentToText(res.content, res.structuredContent)
        if (res.isError) {
          return { success: false, output: '', error: text || `MCP 工具 ${def.name} 执行失败` }
        }
        return { success: true, output: text || `（MCP 工具 ${def.name} 无文本输出）` }
      } catch (e: any) {
        return { success: false, output: '', error: `MCP 工具 ${def.name} 调用失败: ${e?.message || e}` }
      }
    },
  }))
}
