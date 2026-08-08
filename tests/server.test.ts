/**
 * 宿主协议服务（stdin/stdout JSON Lines）测试
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'dist', 'cli', 'index.js')

let child: ChildProcess
let rl: Interface
let nextId = 0

function request(msg: any, timeoutMs = 45000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const msgs: any[] = []
    const timer = setTimeout(() => { cleanup(); reject(new Error(`超时（请求 ${JSON.stringify(msg).slice(0,80)}）`)) }, timeoutMs)
    const handler = (line: string) => {
      try {
        const parsed = JSON.parse(line)
        msgs.push(parsed)
        if (parsed.type === 'error' || parsed.type === 'done' || parsed.type === 'cancelled' || parsed.type === 'sessions' || parsed.type === 'ok') {
          cleanup()
          resolve(msgs)
        }
      } catch { /* 非 JSON 行忽略 */ }
    }
    const cleanup = () => { clearTimeout(timer); rl.removeListener('line', handler) }
    rl.on('line', handler)
    child.stdin!.write(JSON.stringify(msg) + '\n')
  })
}

beforeAll(async () => {
  // 不设 DEEPSEEK_API_KEY（真实"未配置"状态），验证协议错误路径
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  delete env.DEEPSEEK_API_KEY
  child = spawn(process.execPath, [CLI, 'server'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  rl = createInterface({ input: child.stdout! })
})

afterAll(() => {
  child.kill()
})

describe('flare host server 协议', () => {
  it('未知请求类型 → error', async () => {
    const msgs = await request({ type: 'foobar' })
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('未知请求类型')
  })

  it('非法 JSON → error', async () => {
    const msgs = await new Promise<any[]>((resolve) => {
      const handler = (line: string) => {
        rl.removeListener('line', handler)
        resolve([JSON.parse(line)])
      }
      rl.on('line', handler)
      child.stdin!.write('{not json}\n')
    })
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('JSON 解析失败')
  })

  it('chat（可能 fallback 本地模型）→ 协议流完整（事件 + 以 done/error 结束）', async () => {
    // 环境无 DEEPSEEK_API_KEY 时，引擎可能 fallback 到本地 Ollama（用户机器有）→ 不断言具体错误
    // 只验证协议：收到事件流且以 done / error 终止，不挂死
    // 注意：子进程 config.ts 会重新加载 ~/.flare/.env（dotenv），可能注入真实 key 走远端 API，
    // 远端网络慢时超过 vitest 默认 5s —— 显式放宽该测试超时（45s）
    const msgs = await request({ type: 'chat', sessionId: 's-test', input: '你好' }, 45000)
    expect(msgs.length).toBeGreaterThan(0)
    const last = msgs[msgs.length - 1]
    expect(['done', 'error', 'cancelled'].includes(last.type)).toBe(true)
    // 事件类型合法
    for (const m of msgs) {
      expect(['text', 'tool_call', 'tool_execute', 'tool_result', 'done', 'error', 'cancelled'].includes(m.type)).toBe(true)
    }
  }, 45000)

  it('set_context（无 key 会话）→ ok', async () => {
    const msgs = await request({ type: 'set_context', sessionId: 's-test', context: 'x' })
    expect(msgs[0].type).toBe('ok')
  })

  it('cancel（无活跃生成）→ ok', async () => {
    const msgs = await request({ type: 'cancel', sessionId: 's-test' })
    expect(msgs[0].type).toBe('ok')
  })

  it('list_sessions → sessions 数组', async () => {
    const msgs = await request({ type: 'list_sessions' })
    expect(msgs[0].type).toBe('sessions')
    expect(Array.isArray(msgs[0].sessions)).toBe(true)
  })
})
