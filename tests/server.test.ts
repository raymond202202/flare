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

function request(msg: any): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const msgs: any[] = []
    const timer = setTimeout(() => { cleanup(); reject(new Error(`超时（请求 ${JSON.stringify(msg).slice(0,80)}）`)) }, 8000)
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

  it('chat（无 key）→ error 未配置密钥', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-test', input: '你好' })
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('API 密钥')
  })

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
