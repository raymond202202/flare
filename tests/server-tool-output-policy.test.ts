/**
 * server 工具输出治理策略参数测试（v0.6.34）
 *
 * spawn `flare server --storage <tmp> --tool-output-policy '{"maxOutputChars":800,"tailChars":200}'`：
 * - 启动不因默认策略崩（version 协商正常）
 * - get_config 回显 defaultToolOutputPolicy
 * - chat 带非法 toolOutputPolicy（非对象 / 整数字段非法 / ellipsis 非字符串）→ 请求校验优先回 error
 *   （默认值不掩盖请求错误，不触发生成）
 * - chat 带合法策略 → 透传流程完整（以 done/error 结束，不挂死）
 * - chat 不带策略 → 应用 server 级默认（事件流完整，不破坏流程）
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
let tempDir: string

/** mock LLM HTTP 服务器（OpenAI 兼容）：任意 POST /v1/chat/completions → 固定回复，快速稳定（P187，与 P181/P182/P186 同款） */
let mockLlm: Server | undefined
let mockLlmUrl = ''

function request(msg: any, expectTypes: string[], timeout = 45000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const msgs: any[] = []
    const timer = setTimeout(() => { cleanup(); reject(new Error(`超时（请求 ${JSON.stringify(msg).slice(0, 80)}）`)) }, timeout)
    const handler = (line: string) => {
      try {
        const parsed = JSON.parse(line)
        if (expectTypes.includes(parsed.type)) {
          msgs.push(parsed)
          if (['done', 'error', 'cancelled'].includes(parsed.type)) {
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
  // P187：mock LLM 服务器（起在随机端口；与 cli-chat-session.test.ts P181 / server-default-params.test.ts P182 /
  // server.test.ts P186 同款）——根治 chat 真实调用偶发慢源（无 key fallback 本地模型 / ~/.flare/.env 注入真实 key 走远端网络）
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
          message: { role: 'assistant', content: 'mock 回复（P187 测试稳定性：不走真实模型）' },
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

  tempDir = mkdtempSync(path.join(os.tmpdir(), 'flare-server-tool-policy-'))
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  delete env.DEEPSEEK_API_KEY
  delete env.OPENAI_API_KEY
  // P187：显式注入 mock 端点/模型（config 构造时 process.env 优先于 dotenv，测试子进程不继承真实凭据）
  env.LLM_BASE_URL = mockLlmUrl
  env.LLM_API_KEY = 'mock-key'
  env.DEFAULT_MODEL = 'mock-model'
  child = spawn(process.execPath, [CLI, 'server', '--storage', path.join(tempDir, 'test.db'), '--tool-output-policy', '{"maxOutputChars":800,"tailChars":200}'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  rl = createInterface({ input: child.stdout! })
})

afterAll(() => {
  child.kill()
  mockLlm?.close()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('flare server 工具输出治理策略（--tool-output-policy / chat toolOutputPolicy，v0.6.34）', () => {
  it('version 协商正常（默认策略不破坏启动）', async () => {
    const msgs = await request({ type: 'version' }, ['version'])
    expect(msgs[0].type).toBe('version')
    expect(msgs[0].engine).toBeTruthy()
  })

  it('get_config 回显 defaultToolOutputPolicy（server 级默认）', async () => {
    const msgs = await request({ type: 'get_config' }, ['config'])
    expect(msgs[0].type).toBe('config')
    expect(msgs[0].defaultToolOutputPolicy).toEqual({ maxOutputChars: 800, tailChars: 200 })
  })

  // P187：mock LLM 注入后生成稳定成功——不再依赖外部模型/网络（原注释：chat 走真实远端 API 放宽 45s）
  it('chat 带非法 toolOutputPolicy（非对象）→ error 含提示（默认值不掩盖请求错误）', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-top-bad0', input: 'hi', toolOutputPolicy: '800' }, ['error'], 45000)
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('toolOutputPolicy')
  }, 45000)

  it('chat 带非法 maxOutputChars（0）→ error 含字段名', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-top-bad1', input: 'hi', toolOutputPolicy: { maxOutputChars: 0 } }, ['error'], 45000)
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('maxOutputChars')
  }, 45000)

  it('chat 带非法 headChars（非数字）→ error 含字段名', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-top-bad2', input: 'hi', toolOutputPolicy: { headChars: 'abc' } }, ['error'], 45000)
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('headChars')
  }, 45000)

  it('chat 带非法 ellipsis（数字）→ error 含字段名', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-top-bad3', input: 'hi', toolOutputPolicy: { ellipsis: 123 } }, ['error'], 45000)
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('ellipsis')
  }, 45000)

  it('chat 带合法 toolOutputPolicy（请求覆盖默认）→ 透传流程完整（以 done 结束）', async () => {
    // P187：mock LLM 注入后生成稳定成功（done）——断言从「done/error 皆可」收紧为「稳定 done」
    const msgs = await request({ type: 'chat', sessionId: 's-top-ok', input: '你好', toolOutputPolicy: { maxOutputChars: 400, ellipsis: '[截断]' } }, ['done', 'error'], 15000)
    const last = msgs[msgs.length - 1]
    expect(last.type).toBe('done')
  }, 15000)

  it('chat 带空对象策略 → 等价缺省，事件流完整（以 done 结束，零回归）', async () => {
    // P187：mock LLM 注入后生成稳定成功（done）
    const msgs = await request({ type: 'chat', sessionId: 's-top-empty', input: '你好', toolOutputPolicy: {} }, ['done', 'error'], 15000)
    const last = msgs[msgs.length - 1]
    expect(last.type).toBe('done')
  }, 15000)

  it('chat 不带 toolOutputPolicy → 应用 server 级默认（事件流完整，以 done 结束）', async () => {
    // P187：mock LLM 注入后生成稳定成功（done）
    const msgs = await request({ type: 'chat', sessionId: 's-top-dflt', input: '你好' }, ['done', 'error'], 15000)
    expect(msgs.length).toBeGreaterThan(0)
    const last = msgs[msgs.length - 1]
    expect(last.type).toBe('done')
  }, 15000)
})
