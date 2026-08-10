// 真实 MCPServer 子进程 fixture（sampling e2e，v0.6.14）
// 启动后延迟等待客户端握手，然后主动 requestSample() 请求客户端代为采样（LLM 生成），
// 结果写入 SAMPLE_RESULT_FILE（环境变量指定，JSON）：
//   { ok: true, text: '...', model: '...' } 或 { ok: false, error: '...' }
import { MCPServer } from '../../src/mcp/server.js'
import { writeFileSync } from 'node:fs'

const server = new MCPServer()
server.start()

setTimeout(async () => {
  try {
    const result = await server.requestSample({
      messages: [{ role: 'user', content: { type: 'text', text: '用一句话介绍 flare 引擎' } }],
      systemPrompt: '你是 flare 引擎的技术讲解员。',
      maxTokens: 100,
      temperature: 0.5,
    }, 5000)
    writeFileSync(process.env.SAMPLE_RESULT_FILE!, JSON.stringify({
      ok: true,
      text: result.content.text,
      role: result.role,
      model: result.model,
    }))
  } catch (e: any) {
    writeFileSync(process.env.SAMPLE_RESULT_FILE!, JSON.stringify({ ok: false, error: String(e?.message || e) }))
  }
}, 400)
