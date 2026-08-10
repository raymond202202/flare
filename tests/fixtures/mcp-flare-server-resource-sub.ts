// 真实 MCPServer 子进程 fixture（resources 订阅 e2e，v0.6.15）
// 暴露一个资源 memory://note + bump 工具：客户端 subscribe 后调 bump → 服务器 notifyResourceUpdated
// 推送 notifications/resources/updated → 客户端 onResourceUpdated 收到 uri。验证订阅协议真实闭环。
import { MCPServer } from '../../src/mcp/server.js'
import type { McpResource } from '../../src/mcp/types.js'
import type { Tool } from '../../src/tools/index.js'

const resource: McpResource = {
  uri: 'memory://note',
  name: '笔记',
  description: '一个可变笔记（订阅更新通知用）',
  mimeType: 'text/plain',
  read: () => '笔记内容 v1',
}

let server: MCPServer

const bumpTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'bump',
      description: '更新 memory://note 并推送 resources/updated 通知',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: async () => {
    server.notifyResourceUpdated('memory://note')
    return { success: true, output: 'bumped' }
  },
}

server = new MCPServer({ resources: [resource], tools: [bumpTool] })
server.start()
