/**
 * server 默认采样参数测试（v0.6.5）
 *
 * spawn `flare server --max-tokens 30 --temperature 0.5`：
 * - 启动不因默认参数崩（version 协商正常）
 * - chat 不带采样参数 → 应用默认值（事件流完整，不破坏流程）
 * - chat 带非法 maxTokens → 请求校验优先回 error（默认值不掩盖请求错误）
 *
 * 测试稳定性（P182）：注入 mock LLM HTTP 服务器（OpenAI 兼容 /v1/chat/completions），
 * 消除 chat 真实调用偶发源（P142 记录 server-default-params chat 5000ms 超时、补 45000ms
 * vitest 超时后仍依赖外部模型/网络）——spawn env 的 LLM_BASE_URL/LLM_API_KEY/DEFAULT_MODEL
 * 指向本地 mock（并显式删除真实 key），生成快速稳定完成，断言聚焦参数默认值语义不变。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'dist', 'cli', 'index.js')

let child: ChildProcess
let rl: Interface
let nextId = 0
let tempDir: string

/** mock LLM HTTP 服务器（OpenAI 兼容）：任意 POST /v1/chat/completions → 固定回复，快速稳定 */
let mockLlm: Server | undefined
let mockLlmUrl = ''

const CHAT_EVENTS = ['text', 'tool_call', 'tool_execute', 'tool_result', 'done', 'error', 'cancelled']

function request(msg: any, expectTypes: string[], timeout = 45000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const msgs: any[] = []
    const timer = setTimeout(() => { cleanup(); reject(new Error(`超时（请求 ${JSON.stringify(msg).slice(0, 80)}）`)) }, timeout)
    const handler = (line: string) => {
      try {
        const parsed = JSON.parse(line)
        if (expectTypes.includes(parsed.type)) {
          msgs.push(parsed)
          if (expectTypes.some(t => ['done', 'error', 'cancelled'].includes(t)) && parsed.type === 'done' || parsed.type === 'error' || parsed.type === 'cancelled') {
            cleanup()
            resolve(msgs)
          } else if (!expectTypes.some(t => ['done', 'error', 'cancelled'].includes(t))) {
            cleanup()
            resolve(msgs)
          }
        }
      } catch { /* 非 JSON 行忽略 */ }
    }
    const cleanup = () => { clearTimeout(timer); rl.removeListener('line', handler) }
    rl.on('line', handler)
    child.stdin!.write(JSON.stringify(msg) + '\n')
  })
}

beforeAll(async () => {
  // P182：mock LLM 服务器（起在随机端口；与 cli-chat-session.test.ts P181 同款）
  const http = await import('node:http')
  mockLlm = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
      req.resume()
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        id: 'mock-chat-1',
        object: 'chat.completion',
        created: 1700000000,
        model: 'mock-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'mock 回复（P182 测试稳定性：不走真实模型）' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      }))
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise<void>((resolve) => mockLlm!.listen(0, '127.0.0.1', resolve))
  const addr = mockLlm!.address()
  mockLlmUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`

  tempDir = mkdtempSync(path.join(os.tmpdir(), 'flare-server-default-'))
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  // P182：显式删除真实 key + 注入 mock 端点/模型——config 构造时 process.env 优先于 dotenv，
  // 测试子进程不继承真实凭据、不依赖外部网络
  delete env.DEEPSEEK_API_KEY
  delete env.OPENAI_API_KEY
  env.LLM_BASE_URL = mockLlmUrl
  env.LLM_API_KEY = 'mock-key'
  env.DEFAULT_MODEL = 'mock-model'
  child = spawn(process.execPath, [CLI, 'server', '--storage', path.join(tempDir, 'test.db'), '--max-tokens', '30', '--temperature', '0.5'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  rl = createInterface({ input: child.stdout! })
})

afterAll(() => {
  child.kill()
  mockLlm?.close()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('flare server 默认采样参数（--max-tokens/--temperature，v0.6.5）', () => {
  it('version 协商正常（默认参数不破坏启动）', async () => {
    const msgs = await request({ type: 'version' }, ['version'])
    expect(msgs[0].type).toBe('version')
    expect(msgs[0].engine).toBeTruthy()
  })

  it('chat 不带采样参数 → 应用默认值（事件流完整，以 done/error 结束）', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-dflt', input: '你好' }, ['done', 'error'])
    expect(msgs.length).toBeGreaterThan(0)
    const last = msgs[msgs.length - 1]
    expect(['done', 'error']).toContain(last.type)
    // mock LLM 下生成稳定成功（done 而非 error）——不再依赖外部模型可用性
    expect(last.type).toBe('done')
  }, 15000)

  it('chat 带非法 maxTokens → 请求校验优先回 error（默认值不掩盖请求错误）', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-dflt2', input: 'hi', maxTokens: 'abc' }, ['error'])
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('maxTokens')
  }, 15000)

  it('chat 带合法 maxTokens → 请求参数优先（覆盖默认，流程完整）', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-dflt3', input: 'hi', maxTokens: 10 }, ['done', 'error'])
    const last = msgs[msgs.length - 1]
    expect(['done', 'error']).toContain(last.type)
    // mock LLM 下生成稳定成功（done 而非 error）
    expect(last.type).toBe('done')
  }, 15000)
})
