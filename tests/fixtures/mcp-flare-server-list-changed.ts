// 真实 MCPServer 子进程 fixture（列表变化通知 e2e，v0.6.20；v0.6.25 补齐 prompts/list_changed）
// 暴露 notify_changed 工具：执行时调用 notifyToolListChanged + notifyResourceListChanged +
// notifyPromptListChanged——客户端配置 onToolsChanged / onResourcesChanged / onPromptsChanged 回调后
// 收到通知，验证 list_changed 协议真实闭环。
import { MCPServer } from '../../src/mcp/server.js'
import type { Tool } from '../../src/tools/index.js'

let server: MCPServer

const changeTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'notify_changed',
      description: '触发工具/资源/提示词列表变化通知（list_changed 协议 e2e）',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: async () => {
    server.notifyToolListChanged()
    server.notifyResourceListChanged()
    server.notifyPromptListChanged()
    return { success: true, output: 'changed-notified' }
  },
}

server = new MCPServer({
  tools: [changeTool],
  resources: [{ uri: 'memory://note', name: '记忆', read: () => 'note-content' }],
  prompts: [{ name: 'greet', description: '问候', render: () => [] }],
})
server.start()
