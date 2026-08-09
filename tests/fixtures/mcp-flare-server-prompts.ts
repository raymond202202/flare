// MCP flare 服务器 fixture（带 prompts，v0.6.2）
// 用真实 MCPServer 起 stdio 服务器：注入 2 个提示词模板，供 MCPClient 端到端互通测试
import { MCPServer } from '../../src/mcp/server.js'

const server = new MCPServer({
  prompts: [
    {
      name: 'summarize',
      description: '总结会话内容',
      arguments: [{ name: 'topic', description: '主题', required: true }],
      render: (args) => [
        { role: 'user', content: { type: 'text', text: `请总结关于「${args.topic ?? ''}」的会话` } },
        { role: 'assistant', content: { type: 'text', text: '好的，我来总结。' } },
      ],
    },
    { name: 'greet', render: () => [{ role: 'user', content: { type: 'text', text: '你好' } }] },
  ],
})
server.start()
