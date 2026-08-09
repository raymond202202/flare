/**
 * MCP 工具桥（v0.5.5）
 *
 * 把外部 MCP 服务器的工具（tools/list）桥接为 flare 的 Tool 接口：
 * - definition：MCP inputSchema（JSON Schema）→ flare parameters（OpenAI 兼容格式）
 * - execute：调 MCPClient.callTool，提取 text 内容；isError → success:false；
 *   协议层错误（reject）→ success:false + error 信息（不抛出，遵循 flare 工具约定）
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
import type { McpTool, McpCallResult } from '../mcp/types.js'

/** 工具桥依赖的最小客户端接口（stdio MCPClient 与 HTTP MCPHttpClient 都满足） */
export interface McpToolClient {
  listTools(): Promise<McpTool[]>
  callTool(name: string, args?: Record<string, any>): Promise<McpCallResult>
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
        const text = res.content
          .filter(c => c.type === 'text' && typeof c.text === 'string')
          .map(c => c.text)
          .join('\n')
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
