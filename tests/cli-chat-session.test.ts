/**
 * flare chat -q --session <sessionId> 续聊已有会话测试（v0.6.128）
 *
 * 验证 CLI 命令注册：`flare chat --help` 输出包含 --session 说明；
 * 校验路径：指定的会话不存在 → exit 1 + 提示（不触发生成，快速稳定）；
 * 续聊行为（Agent 构造加载历史）由 Agent 集成测试覆盖（agent.test.ts 历史恢复）。
 *
 * 测试稳定性（P181）：注入 mock LLM HTTP 服务器（OpenAI 兼容 /v1/chat/completions），
 * 消除历史偶发超时源（P173/174/177 三次记录的「真实生成 fallback 本地模型可能慢/失败」）——
 * spawn CLI 的 LLM_BASE_URL/LLM_API_KEY/DEFAULT_MODEL 指向本地 mock，生成快速稳定完成，
 * 不依赖外部模型/网络；断言聚焦校验路径（不误杀/提示/不改写归档），语义不变。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Server } from 'node:http'
import { MemoryStore } from '../src/memory/store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'dist', 'cli', 'index.js')
const children: ChildProcess[] = []
let dir: string
let store: MemoryStore

/** mock LLM HTTP 服务器（OpenAI 兼容）：任意 POST /v1/chat/completions → 固定回复，快速稳定 */
let mockLlm: Server | undefined
let mockLlmUrl = ''

beforeAll(async () => {
  const http = await import('node:http')
  mockLlm = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
      // 消费请求体（否则 keep-alive 连接挂起）
      req.resume()
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        id: 'mock-chat-1',
        object: 'chat.completion',
        created: 1700000000,
        model: 'mock-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'mock 回复（P181 测试稳定性：不走真实模型）' },
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
})

afterAll(() => {
  mockLlm?.close()
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-chat-session-cli-'))
  store = new MemoryStore(join(dir, 'flare.db'))
})

afterEach(() => {
  store.close()
  for (const c of children.splice(0)) c.kill()
  rmSync(dir, { recursive: true, force: true })
})

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        FLARE_HOME: dir,
        // P181：mock LLM 注入——显式覆盖外部配置（~/.flare/.env 的 key/模型不参与），
        // 生成路径稳定快速；config 构造时 process.env 优先于 dotenv 加载
        LLM_BASE_URL: mockLlmUrl,
        LLM_API_KEY: 'mock-key',
        DEFAULT_MODEL: 'mock-model',
      },
    })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('flare chat --session（续聊已有会话，v0.6.128）', () => {
  it('--help 输出包含 --session 说明（命令注册完整）', async () => {
    const r = await runCli(['chat', '--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('--session')
    expect(r.stdout).toContain('续聊已有会话')
  })

  it('指定的会话不存在 → exit 1 + 提示（不触发生成，快速返回）', async () => {
    const r = await runCli(['chat', '-q', '你好', '--session', 'no-such-session'])
    expect(r.code).toBe(1)
    expect(r.stdout + r.stderr).toContain('会话 no-such-session 不存在')
  })

  it('预建会话后 --session 续聊 → 校验通过进入生成（不因校验误杀）', async () => {
    // 预建带历史消息的会话（seed 直插，模拟已有对话）
    store.saveMessage('sess-cont', { role: 'user', content: '上一轮的问题' })
    store.updateSessionTitle('sess-cont', '续聊会话')
    const r = await runCli(['chat', '-q', '接着上一轮说', '--session', 'sess-cont'])
    // 校验通过 → 不出现「不存在」错误（生成走 mock LLM，稳定快速）
    expect(r.stdout + r.stderr).not.toContain('会话 sess-cont 不存在')
    // 非归档会话 → 不出现「已归档」提示
    expect(r.stdout + r.stderr).not.toContain('已归档')
    // 会话记录必须存在且标题不变
    const all = store.getAllSessions()
    expect(all.find((s) => s.id === 'sess-cont')?.title).toBe('续聊会话')
    // mock LLM 回复已到达（生成确实执行且成功）
    expect(r.stdout + r.stderr).toContain('mock 回复')
  })

  it('续聊已归档会话 → 黄色提示不拦截（exit 0 继续生成，会话保持归档）', async () => {
    // 预建会话并归档（seed 直插 + archiveSession 标记 archived=1）
    store.saveMessage('sess-arch', { role: 'user', content: '归档前的问题' })
    store.updateSessionTitle('sess-arch', '归档会话')
    store.archiveSession('sess-arch')
    const r = await runCli(['chat', '-q', '归档后还想续聊', '--session', 'sess-arch'])
    // v0.6.129：黄色提示出现（stderr，含已归档说明与 restore 提示）→ 不误杀
    expect(r.stdout + r.stderr).toContain('已归档')
    expect(r.stdout + r.stderr).toContain('restore')
    expect(r.stdout + r.stderr).not.toContain('会话 sess-arch 不存在')
    // 不拦截：提示后继续进入生成阶段（「思考中」在归档提示之后打印；若被拦截 exit 1 则不会出现）
    expect(r.stdout + r.stderr).toContain('思考中')
    // mock LLM 回复已到达（生成完整跑通，稳定断言——不再依赖外部模型可用性）
    expect(r.stdout + r.stderr).toContain('mock 回复')
    // 会话保持归档状态（提示不拦截不改写 archived 标记；与 server chat 同语义）
    const all = store.getAllSessions()
    expect(all.find((s) => s.id === 'sess-arch')?.archived).toBe(true)
    expect(all.find((s) => s.id === 'sess-arch')?.title).toBe('归档会话')
  }, 15000)
})
