// e2e fixture（v0.6.37）：真实 MCPServer 子进程，注入提示词（--bridge-prompts 桥接透传用）
// 客户端连接后：listPrompts（元数据 + arguments）→ getPrompt（渲染带参数补全）
// 注意：与 mcp-flare-server-prompts.ts（v0.6.2，prompts 消费互通）区分——此 fixture 专供
// CLI mcp-server --bridge-prompts 透传测试（greet 在前，顺序断言独立）
import { MCPServer } from '../../src/mcp/server.js'
import type { McpPrompt } from '../../src/mcp/types.js'

const prompts: McpPrompt[] = [
  {
    name: 'greet',
    description: '打招呼',
    render: async () => [{ role: 'user' as const, content: { type: 'text' as const, text: '你好' } }],
  },
  {
    name: 'summarize',
    description: '总结内容',
    arguments: [{ name: 'topic', description: '主题', required: true }],
    render: async (args) => [{ role: 'user' as const, content: { type: 'text' as const, text: `请总结关于「${args?.topic || ''}」的内容` } }],
  },
]

const server = new MCPServer({ prompts })
server.start()
