// 真实 MCPServer 子进程 fixture（列表变化通知 e2e，v0.6.20）
// 暴露 notify_changed 工具：执行时调用 notifyToolListChanged + notifyResourceListChanged——
// 客户端配置 onToolsChanged / onResourcesChanged 回调后收到通知，验证 list_changed 协议真实闭环。
import { MCPServer } from '../../src/mcp/server.js'
import type { Tool } from '../../src/tools/index.js'

let server: MCPServer

const changeTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'notify_changed',
      description: '触发工具/资源列表变化通知（list_changed 协议 e2e）',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: async () => {
    server.notifyToolListChanged()
    server.notifyResourceListChanged()
    return { success: true, output: 'changed-notified' }
  },
}

server = new MCPServer({ tools: [changeTool], resources: [{ uri: 'memory://note', name: '记忆' }] })
server.start()
