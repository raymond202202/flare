// e2e fixture（v0.6.22）：真实 MCPServer 子进程，注入资源 + 资源模板
// 客户端连接后：listResources（静态资源）→ listResourceTemplates（动态模板）→ readResource 读取静态资源
import { MCPServer } from '../../src/mcp/server.js'
import type { McpResource, McpResourceTemplate } from '../../src/mcp/types.js'

const resources: McpResource[] = [
  { uri: 'memory://preferences', name: '用户偏好', description: '用户偏好设置', mimeType: 'text/plain', read: () => '主题: 浅色' },
]

const templates: McpResourceTemplate[] = [
  { uriTemplate: 'memory://{noteId}', name: '记忆条目', description: '记忆库中的单条记忆（动态资源）', mimeType: 'text/plain' },
]

const server = new MCPServer({ resources, resourceTemplates: templates })
server.start()
