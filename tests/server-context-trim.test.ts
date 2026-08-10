/**
 * server 上下文自动裁剪参数测试（v0.6.17）
 *
 * spawn `flare server --max-context-messages 5 --max-context-tokens 1000`：
 * - 启动不因默认裁剪参数崩（version 协商正常）
 * - chat 不带裁剪参数 → 应用默认值（事件流完整，不破坏流程）
 * - chat 带非法 maxContextMessages / maxContextTokens → 请求校验优先回 error（默认值不掩盖请求错误）
 * - chat 带合法裁剪参数 → 透传流程完整（以 done/error 结束，不挂死）
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
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'flare-server-ctx-trim-'))
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  delete env.DEEPSEEK_API_KEY
  child = spawn(process.execPath, [CLI, 'server', '--storage', path.join(tempDir, 'test.db'), '--max-context-messages', '5', '--max-context-tokens', '1000'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  rl = createInterface({ input: child.stdout! })
})

afterAll(() => {
  child.kill()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('flare server 上下文自动裁剪参数（--max-context-messages/--max-context-tokens，v0.6.17）', () => {
  it('version 协商正常（默认裁剪参数不破坏启动）', async () => {
    const msgs = await request({ type: 'version' }, ['version'])
    expect(msgs[0].type).toBe('version')
    expect(msgs[0].engine).toBeTruthy()
  })

  it('chat 不带裁剪参数 → 应用默认值（事件流完整，以 done/error 结束）', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-ctx-dflt', input: '你好' }, ['done', 'error'])
    expect(msgs.length).toBeGreaterThan(0)
    const last = msgs[msgs.length - 1]
    expect(['done', 'error']).toContain(last.type)
  })

  it('chat 带非法 maxContextMessages → 请求校验优先回 error（默认值不掩盖请求错误）', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-ctx-bad1', input: 'hi', maxContextMessages: 'abc' }, ['error'])
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('maxContextMessages')
  })

  it('chat 带负数 maxContextMessages → error', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-ctx-bad2', input: 'hi', maxContextMessages: -3 }, ['error'])
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('maxContextMessages')
  })

  it('chat 带非法 maxContextTokens（0）→ error', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-ctx-bad3', input: 'hi', maxContextTokens: 0 }, ['error'])
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('maxContextTokens')
  })

  it('chat 带合法裁剪参数 → 透传流程完整（以 done/error 结束，不挂死）', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-ctx-ok', input: '你好', maxContextMessages: 8, maxContextTokens: 500 }, ['done', 'error'])
    const last = msgs[msgs.length - 1]
    expect(['done', 'error']).toContain(last.type)
  })
})

/**
 * 上下文压缩摘要 server 参数测试（v0.6.19）
 *
 * spawn `flare server --context-summarize`（默认开启压缩摘要）：
 * - 默认值不破坏启动（version 协商正常）
 * - chat 带非法 contextSummarize → 请求校验优先回 error（默认值不掩盖请求错误）
 * - chat 不带 contextSummarize → 应用默认值（事件流完整，不破坏流程）
 * - chat 带合法 contextSummarize → 透传流程完整（以 done/error 结束，不挂死）
 * - get_config 回显 defaultContextSummarize
 */
describe('flare server 上下文压缩摘要（--context-summarize，v0.6.19）', () => {
  let child2: ChildProcess
  let rl2: Interface
  let tempDir2: string

  function request2(msg: any, expectTypes: string[], timeout = 45000): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const msgs: any[] = []
      const timer = setTimeout(() => { cleanup(); reject(new Error(`超时（请求 ${JSON.stringify(msg).slice(0, 80)}）`)) }, timeout)
      const handler = (line: string) => {
        try {
          const parsed = JSON.parse(line)
          if (expectTypes.includes(parsed.type)) {
            msgs.push(parsed)
            if (parsed.type === 'done' || parsed.type === 'error' || parsed.type === 'cancelled') {
              cleanup()
              resolve(msgs)
            } else if (!expectTypes.some(t => ['done', 'error', 'cancelled'].includes(t))) {
              cleanup()
              resolve(msgs)
            }
          }
        } catch { /* 非 JSON 行忽略 */ }
      }
      const cleanup = () => { clearTimeout(timer); rl2.removeListener('line', handler) }
      rl2.on('line', handler)
      child2.stdin!.write(JSON.stringify(msg) + '\n')
    })
  }

  beforeAll(async () => {
    tempDir2 = mkdtempSync(path.join(os.tmpdir(), 'flare-server-ctx-summary-'))
    const env: Record<string, string> = { ...process.env } as Record<string, string>
    delete env.DEEPSEEK_API_KEY
    child2 = spawn(process.execPath, [CLI, 'server', '--storage', path.join(tempDir2, 'test.db'), '--context-summarize'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    rl2 = createInterface({ input: child2.stdout! })
  })

  afterAll(() => {
    child2.kill()
    rmSync(tempDir2, { recursive: true, force: true })
  })

  it('version 协商正常（--context-summarize 默认值不破坏启动）', async () => {
    const msgs = await request2({ type: 'version' }, ['version'])
    expect(msgs[0].type).toBe('version')
    expect(msgs[0].engine).toBeTruthy()
  })

  it('chat 带非法 contextSummarize（非布尔）→ 请求校验优先回 error', async () => {
    const msgs = await request2({ type: 'chat', sessionId: 's-sum-bad', input: 'hi', contextSummarize: 'yes' }, ['error'])
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('contextSummarize')
  })

  it('chat 不带 contextSummarize → 应用 server 级默认（事件流完整，以 done/error 结束）', async () => {
    const msgs = await request2({ type: 'chat', sessionId: 's-sum-dflt', input: '你好' }, ['done', 'error'])
    expect(msgs.length).toBeGreaterThan(0)
    const last = msgs[msgs.length - 1]
    expect(['done', 'error']).toContain(last.type)
  })

  it('chat 带合法 contextSummarize → 透传流程完整（以 done/error 结束，不挂死）', async () => {
    const msgs = await request2({ type: 'chat', sessionId: 's-sum-ok', input: '你好', contextSummarize: false }, ['done', 'error'])
    const last = msgs[msgs.length - 1]
    expect(['done', 'error']).toContain(last.type)
  })

  it('get_config 回显 defaultContextSummarize: true（server 级默认可见）', async () => {
    const msgs = await request2({ type: 'get_config' }, ['config'])
    expect(msgs[0].type).toBe('config')
    expect(msgs[0].defaultContextSummarize).toBe(true)
  })
})
