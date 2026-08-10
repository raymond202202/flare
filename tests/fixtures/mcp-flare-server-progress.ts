// 真实 MCPServer 子进程 fixture（progress 通知 e2e，v0.6.16）
// 暴露 progress_work 工具：分 3 步执行，每步 notifyProgress 推送 notifications/progress——
// 客户端 callTool 带 _meta.progressToken 时 onProgress 回调收到全部进度，验证 progress 协议真实闭环。
import { MCPServer } from '../../src/mcp/server.js'
import type { Tool } from '../../src/tools/index.js'

let server: MCPServer

const workTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'progress_work',
      description: '分步执行并推送进度通知（progress 协议 e2e）',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: async () => {
    server.notifyProgress(1, 3, '开始处理')
    await new Promise((r) => setTimeout(r, 15))
    server.notifyProgress(2, 3, '处理中')
    await new Promise((r) => setTimeout(r, 15))
    server.notifyProgress(3, 3, '即将完成')
    return { success: true, output: 'work-done' }
  },
}

server = new MCPServer({ tools: [workTool] })
server.start()
