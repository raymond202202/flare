// 真实 MCPServer 子进程 fixture（动态资源提供器 e2e，v0.6.28）
// 静态资源 + 动态提供器（模拟外部 MCP 服务器资源经 flare 透传）——
// 客户端 listResources 看到合并列表、readResource 能读动态资源。
import { MCPServer, type McpResourceProvider } from '../../src/mcp/server.js'

const provider: McpResourceProvider = {
  listResources: () => [
    { uri: 'ext://remote', name: '外部资源', description: '经 flare 透传的外部服务器资源', mimeType: 'text/plain' },
  ],
  listResourceTemplates: () => [
    { uriTemplate: 'ext://{id}', name: '外部模板', description: '外部动态资源形态' },
  ],
  readResource: (uri) => (uri === 'ext://remote' ? '外部资源内容' : null),
}

const server = new MCPServer({
  resources: [{ uri: 'flare://static', name: '静态资源', read: () => '静态内容' }],
  resourceProvider: provider,
})
server.start()
