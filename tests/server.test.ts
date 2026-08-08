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

/** 协议事件类型（chat 流式收集用） */
const CHAT_EVENTS = ['text', 'tool_call', 'tool_execute', 'tool_result', 'done', 'error', 'cancelled']

interface RequestOpts {
  timeout?: number
  /** 收集全部事件直到终止（chat 用）；false 时只取第一个匹配 expect 的消息，忽略其他残留 */
  collectAll?: boolean
  /** 单响应请求的期望类型（如 'ok'/'sessions'/'pong'/'messages'） */
  expect?: string[]
}

/**
 * 发送请求并等待响应。
 * 注意：服务端 async 并发处理（chat 慢、ping 快），stdout 响应可能乱序到达——
 * 因此单响应请求必须按 expect 过滤，忽略其他请求的残留消息。
 */
function request(msg: any, opts: RequestOpts = {}): Promise<any[]> {
  const { timeout = 45000, collectAll = false, expect } = opts
  return new Promise((resolve, reject) => {
    const msgs: any[] = []
    const timer = setTimeout(() => { cleanup(); reject(new Error(`超时（请求 ${JSON.stringify(msg).slice(0,80)}）`)) }, timeout)
    const handler = (line: string) => {
      try {
        const parsed = JSON.parse(line)
        if (collectAll) {
          // chat 流：收集协议事件，遇终止类型结束
          if (CHAT_EVENTS.includes(parsed.type)) msgs.push(parsed)
          if (parsed.type === 'done' || parsed.type === 'error' || parsed.type === 'cancelled') {
            cleanup()
            resolve(msgs)
          }
        } else {
          // 单响应：只匹配期望类型，其他类型（残留）忽略
          if (expect && expect.includes(parsed.type)) {
            msgs.push(parsed)
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
    const msgs = await request({ type: 'foobar' }, { expect: ['error'] })
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('未知请求类型')
  })

  it('非法 JSON → error', async () => {
    // 只发送非法 JSON 行，等待服务端回"JSON 解析失败"error（过滤其他残留消息）
    const msgs = await new Promise<any[]>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('超时（非法 JSON 请求）')) }, 8000)
      const handler = (line: string) => {
        try {
          const parsed = JSON.parse(line)
          if (parsed.type === 'error' && String(parsed.message || '').includes('JSON 解析失败')) {
            cleanup()
            resolve([parsed])
          }
        } catch { /* 非 JSON 行忽略 */ }
      }
      const cleanup = () => { clearTimeout(timer); rl.removeListener('line', handler) }
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
    const msgs = await request({ type: 'chat', sessionId: 's-test', input: '你好' }, { collectAll: true, timeout: 45000 })
    expect(msgs.length).toBeGreaterThan(0)
    const last = msgs[msgs.length - 1]
    expect(['done', 'error', 'cancelled'].includes(last.type)).toBe(true)
    // 事件类型合法
    for (const m of msgs) {
      expect(['text', 'tool_call', 'tool_execute', 'tool_result', 'done', 'error', 'cancelled'].includes(m.type)).toBe(true)
    }
  }, 45000)

  it('chat 带 model 字段（本地 Ollama 主模型）→ 协议流完整（模型选择不破坏流程）', async () => {
    // v0.5.2：chat 请求支持可选 model（如 qwen2.5:7b 本地 Ollama / deepseek-chat 远端）。
    // 不断言具体错误（本地 Ollama 可能未启动/未拉模型），只验证协议流正常终止。
    const msgs = await request(
      { type: 'chat', sessionId: 's-model', input: '你好', model: 'qwen2.5:7b' },
      { collectAll: true, timeout: 45000 }
    )
    expect(msgs.length).toBeGreaterThan(0)
    const last = msgs[msgs.length - 1]
    expect(['done', 'error', 'cancelled'].includes(last.type)).toBe(true)
    for (const m of msgs) {
      expect(['text', 'tool_call', 'tool_execute', 'tool_result', 'done', 'error', 'cancelled'].includes(m.type)).toBe(true)
    }
  }, 45000)

  it('set_context（无 key 会话）→ ok', async () => {
    const msgs = await request({ type: 'set_context', sessionId: 's-test', context: 'x' }, { expect: ['ok'] })
    expect(msgs[0].type).toBe('ok')
  })

  it('cancel（无活跃生成）→ ok', async () => {
    const msgs = await request({ type: 'cancel', sessionId: 's-test' }, { expect: ['ok'] })
    expect(msgs[0].type).toBe('ok')
  })

  it('list_sessions → sessions 数组', async () => {
    const msgs = await request({ type: 'list_sessions' }, { expect: ['sessions'] })
    expect(msgs[0].type).toBe('sessions')
    expect(Array.isArray(msgs[0].sessions)).toBe(true)
  })

  it('ping → pong（宿主健康检查）', async () => {
    const msgs = await request({ type: 'ping' }, { expect: ['pong'] })
    expect(msgs[0].type).toBe('pong')
    expect(typeof msgs[0].ts).toBe('number')
  })

  it('get_messages → messages 数组（只读历史，不生成）', async () => {
    const msgs = await request({ type: 'get_messages', sessionId: 's-hist' }, { expect: ['messages'] })
    expect(msgs[0].type).toBe('messages')
    expect(Array.isArray(msgs[0].messages)).toBe(true)
    expect(msgs[0].sessionId).toBe('s-hist')
  })

  it('version → 协议版本 + 引擎版本（宿主版本协商）', async () => {
    const msgs = await request({ type: 'version' }, { expect: ['version'] })
    expect(msgs[0].type).toBe('version')
    expect(typeof msgs[0].protocol).toBe('string')
    expect(msgs[0].protocol.length).toBeGreaterThan(0)
    expect(typeof msgs[0].engine).toBe('string')
    expect(msgs[0].engine).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('delete_session → ok（含 deleted 标志；不存在返回 deleted:false）', async () => {
    const msgs = await request({ type: 'delete_session', sessionId: 's-gone' }, { expect: ['ok'] })
    expect(msgs[0].type).toBe('ok')
    expect(msgs[0].sessionId).toBe('s-gone')
    expect(typeof msgs[0].deleted).toBe('boolean')
  })

  it('get_usage → usage 统计（token 用量，只读不生成）', async () => {
    const msgs = await request({ type: 'get_usage' }, { expect: ['usage'] })
    expect(msgs[0].type).toBe('usage')
    expect(typeof msgs[0].stats).toBe('object')
    expect(typeof msgs[0].stats.promptTokens).toBe('number')
    expect(typeof msgs[0].stats.completionTokens).toBe('number')
    expect(typeof msgs[0].stats.totalTokens).toBe('number')
    expect(typeof msgs[0].stats.sessionCount).toBe('number')
  })
})
