/**
 * server 默认采样参数测试（v0.6.5）
 *
 * spawn `flare server --max-tokens 30 --temperature 0.5`：
 * - 启动不因默认参数崩（version 协商正常）
 * - chat 不带采样参数 → 应用默认值（事件流完整，不破坏流程）
 * - chat 带非法 maxTokens → 请求校验优先回 error（默认值不掩盖请求错误）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'dist', 'cli', 'index.js')

let child: ChildProcess
let rl: Interface
let nextId = 0
let tempDir: string

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
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'flare-server-default-'))
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  delete env.DEEPSEEK_API_KEY
  child = spawn(process.execPath, [CLI, 'server', '--storage', path.join(tempDir, 'test.db'), '--max-tokens', '30', '--temperature', '0.5'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  rl = createInterface({ input: child.stdout! })
})

afterAll(() => {
  child.kill()
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
  })

  it('chat 带非法 maxTokens → 请求校验优先回 error（默认值不掩盖请求错误）', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-dflt2', input: 'hi', maxTokens: 'abc' }, ['error'])
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('maxTokens')
  })

  it('chat 带合法 maxTokens → 请求参数优先（覆盖默认，流程完整）', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-dflt3', input: 'hi', maxTokens: 10 }, ['done', 'error'])
    const last = msgs[msgs.length - 1]
    expect(['done', 'error']).toContain(last.type)
  })
})
