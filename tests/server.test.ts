/**
 * 宿主协议服务（stdin/stdout JSON Lines）测试
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'dist', 'cli', 'index.js')

let child: ChildProcess
let rl: Interface
let nextId = 0
let tempDir: string

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
  // 隔离测试库：协议测试全用临时库（不污染 ~/.flare/flare.db），数据往返断言确定
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'flare-server-test-'))
  // 不设 DEEPSEEK_API_KEY（真实"未配置"状态），验证协议错误路径
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  delete env.DEEPSEEK_API_KEY
  child = spawn(process.execPath, [CLI, 'server', '--storage', path.join(tempDir, 'test.db')], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  rl = createInterface({ input: child.stdout! })
})

afterAll(() => {
  child.kill()
  rmSync(tempDir, { recursive: true, force: true })
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

  it('list_sessions → sessions 数组（含显式创建的会话，T1 修复后真实读库）', async () => {
    await request({ type: 'create_session', sessionId: 's-list1', title: '列表会话' }, { expect: ['ok'] })
    const msgs = await request({ type: 'list_sessions' }, { expect: ['sessions'] })
    expect(msgs[0].type).toBe('sessions')
    expect(Array.isArray(msgs[0].sessions)).toBe(true)
    // 数据往返：create_session 写入的会话必须出现在列表里（证明 store 字段修复生效）
    expect(msgs[0].sessions.some((s: any) => s.id === 's-list1')).toBe(true)
  })

  it('recent_sessions → 会话列表 + preview（v0.6.0：宿主会话面板用，只读不生成）', async () => {
    // 数据往返：create_session 写入的会话必须出现在最近会话列表里
    await request({ type: 'create_session', sessionId: 's-recent1', title: '预览会话' }, { expect: ['ok'] })
    const msgs = await request({ type: 'recent_sessions' }, { expect: ['recent_sessions'] })
    expect(msgs[0].type).toBe('recent_sessions')
    expect(Array.isArray(msgs[0].sessions)).toBe(true)
    const row = msgs[0].sessions.find((s: any) => s.id === 's-recent1')
    expect(row).toBeTruthy()
    // 字段契约：id/title/updatedAt/preview（preview 为字符串，空会话可为空串）
    expect(typeof row.title).toBe('string')
    expect(typeof row.updatedAt).toBe('string')
    expect(typeof row.preview).toBe('string')
  })

  it('recent_sessions → limit 参数生效（上限 50，下限 1）', async () => {
    await request({ type: 'create_session', sessionId: 's-recent2' }, { expect: ['ok'] })
    await request({ type: 'create_session', sessionId: 's-recent3' }, { expect: ['ok'] })
    const one = await request({ type: 'recent_sessions', limit: 1 }, { expect: ['recent_sessions'] })
    expect(one[0].sessions.length).toBe(1)
    const many = await request({ type: 'recent_sessions', limit: 999 }, { expect: ['recent_sessions'] })
    expect(many[0].sessions.length).toBeLessThanOrEqual(50)
  })

  it('ping → pong（宿主健康检查）', async () => {
    const msgs = await request({ type: 'ping' }, { expect: ['pong'] })
    expect(msgs[0].type).toBe('pong')
    expect(typeof msgs[0].ts).toBe('number')
  })

  it('get_messages → messages 数组（只读历史；显式创建的空会话返回空数组）', async () => {
    await request({ type: 'create_session', sessionId: 's-hist2' }, { expect: ['ok'] })
    const msgs = await request({ type: 'get_messages', sessionId: 's-hist2' }, { expect: ['messages'] })
    expect(msgs[0].type).toBe('messages')
    expect(Array.isArray(msgs[0].messages)).toBe(true)
    expect(msgs[0].messages.length).toBe(0)
    expect(msgs[0].sessionId).toBe('s-hist2')
  })

  it('version → 协议版本 + 引擎版本（宿主版本协商）', async () => {
    const msgs = await request({ type: 'version' }, { expect: ['version'] })
    expect(msgs[0].type).toBe('version')
    expect(typeof msgs[0].protocol).toBe('string')
    expect(msgs[0].protocol.length).toBeGreaterThan(0)
    expect(typeof msgs[0].engine).toBe('string')
    expect(msgs[0].engine).toMatch(/^\d+\.\d+\.\d+/)
    // engine 版本必须与 package.json 一致（不硬编码路径验证）
    const pkg = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'))
    expect(msgs[0].engine).toBe(pkg.version)
  })

  it('create_session → ok（显式建会话；宿主会话管理用）', async () => {
    const msgs = await request({ type: 'create_session', sessionId: 's-new', title: '面板会话' }, { expect: ['ok'] })
    expect(msgs[0].type).toBe('ok')
    expect(msgs[0].sessionId).toBe('s-new')
  })

  it('create_session 幂等（已存在则更新标题，不报错）', async () => {
    const msgs = await request({ type: 'create_session', sessionId: 's-new', title: '更新标题' }, { expect: ['ok'] })
    expect(msgs[0].type).toBe('ok')
    expect(msgs[0].sessionId).toBe('s-new')
  })

  it('delete_session → 真实删除（T1 修复：先建会话再删 deleted:true；再删 deleted:false 幂等）', async () => {
    // 修复前 memoryStore 字段错位：deleteSession 从不执行，deleted 恒 false（隐私数据删不掉）
    await request({ type: 'create_session', sessionId: 's-del2' }, { expect: ['ok'] })
    const msgs = await request({ type: 'delete_session', sessionId: 's-del2' }, { expect: ['ok'] })
    expect(msgs[0].type).toBe('ok')
    expect(msgs[0].sessionId).toBe('s-del2')
    expect(msgs[0].deleted).toBe(true)
    // 幂等：已删除的会话再删 → deleted:false（不报错）
    const again = await request({ type: 'delete_session', sessionId: 's-del2' }, { expect: ['ok'] })
    expect(again[0].deleted).toBe(false)
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

  it('context_status → 消息数 + 估算 tokens（v0.5.6：上下文占用只读）', async () => {
    // 数据往返：create_session 后 context_status 必须能看到该会话的上下文
    await request({ type: 'create_session', sessionId: 's-ctx1', title: '上下文会话' }, { expect: ['ok'] })
    const msgs = await request({ type: 'context_status', sessionId: 's-ctx1' }, { expect: ['context_status'] })
    expect(msgs[0].type).toBe('context_status')
    expect(msgs[0].sessionId).toBe('s-ctx1')
    // 会话至少含 system 提示（messageCount ≥ 1）；估算 tokens 必然 > 0
    expect(typeof msgs[0].messageCount).toBe('number')
    expect(msgs[0].messageCount).toBeGreaterThanOrEqual(1)
    expect(typeof msgs[0].estimatedTokens).toBe('number')
    expect(msgs[0].estimatedTokens).toBeGreaterThan(0)
  })

  it('context_status 默认会话（无 sessionId）→ 正常返回（default 会话）', async () => {
    const msgs = await request({ type: 'context_status' }, { expect: ['context_status'] })
    expect(msgs[0].type).toBe('context_status')
    expect(msgs[0].sessionId).toBe('default')
    expect(msgs[0].messageCount).toBeGreaterThanOrEqual(1)
  })

  it('remember → 保存记忆 + get_memories 可检索到（记忆生命周期：存 → 查）', async () => {
    // 数据往返：remember 写入临时库 → get_memories 必须命中（同时证明 T1 store 字段修复）
    await request({ type: 'remember', content: '用户偏好深色主题', kind: 'preference' }, { expect: ['ok'] })
    const list = await request({ type: 'get_memories' }, { expect: ['memories'] })
    expect(list[0].type).toBe('memories')
    expect(Array.isArray(list[0].memories)).toBe(true)
    expect(list[0].memories.some((m: any) => m.content === '用户偏好深色主题' && m.type === 'preference')).toBe(true)

    const search = await request({ type: 'get_memories', query: '深色主题' }, { expect: ['memories'] })
    expect(search[0].memories.some((m: any) => m.content === '用户偏好深色主题')).toBe(true)
  }, 30000)

  it('remember 缺 content → error（不落库）', async () => {
    const msgs = await request({ type: 'remember' }, { expect: ['error'] })
    expect(msgs[0].message).toContain('content')
  }, 30000)

  it('delete_memory → 按 id 删单条（deleted:1），再删 deleted:0 幂等', async () => {
    await request({ type: 'remember', content: '待删除的记忆条目' }, { expect: ['ok'] })
    const list = await request({ type: 'get_memories', query: '待删除的' }, { expect: ['memories'] })
    const id = list[0].memories[0].id

    const del = await request({ type: 'delete_memory', id }, { expect: ['ok'] })
    expect(del[0].deleted).toBe(1)
    const again = await request({ type: 'delete_memory', id }, { expect: ['ok'] })
    expect(again[0].deleted).toBe(0)
  }, 30000)

  it('delete_memory → 按 content 关键词批量删（deleted 为条数）', async () => {
    await request({ type: 'remember', content: '关于苹果的讨论 A' }, { expect: ['ok'] })
    await request({ type: 'remember', content: '苹果种植技巧 B' }, { expect: ['ok'] })
    await request({ type: 'remember', content: '香蕉的营养价值 C' }, { expect: ['ok'] })

    const del = await request({ type: 'delete_memory', content: '苹果' }, { expect: ['ok'] })
    expect(del[0].deleted).toBe(2)

    const rest = await request({ type: 'get_memories' }, { expect: ['memories'] })
    const contents = rest[0].memories.map((m: any) => m.content)
    expect(contents).toContain('香蕉的营养价值 C')
    expect(contents.some((c: string) => c.includes('苹果'))).toBe(false)
  }, 30000)

  it('mcp_status（无 --mcp）→ 空列表（v0.5.5）', async () => {
    const msgs = await request({ type: 'mcp_status' }, { expect: ['mcp_status'] })
    expect(Array.isArray(msgs[0].servers)).toBe(true)
    expect(msgs[0].servers.length).toBe(0)
  }, 30000)

  it('mcp_status（--mcp mock 配置）→ 服务器连接成功 + 工具数（v0.5.5）', async () => {
    // 独立子进程：--mcp 指向 mock MCP server 配置（本地子进程，无网络）
    const dir = mkdtempSync(path.join(os.tmpdir(), 'flare-mcp-server-test-'))
    const mcpCfg = path.join(dir, 'mcp.json')
    const mockServer = path.join(__dirname, 'fixtures', 'mcp-mock-server.mjs')
    writeFileSync(mcpCfg, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [mockServer] }] }))
    const env: Record<string, string> = { ...process.env } as Record<string, string>
    delete env.DEEPSEEK_API_KEY
    const c = spawn(process.execPath, [CLI, 'server', '--storage', path.join(dir, 'test.db'), '--mcp', mcpCfg], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const rl2 = createInterface({ input: c.stdout! })
    try {
      const msgs = await new Promise<any[]>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('超时（mcp_status）')) }, 15000)
        const handler = (line: string) => {
          try {
            const parsed = JSON.parse(line)
            if (parsed.type === 'mcp_status') {
              cleanup()
              resolve([parsed])
            }
          } catch { /* 非 JSON 行忽略 */ }
        }
        const cleanup = () => { clearTimeout(timer); rl2.removeListener('line', handler) }
        rl2.on('line', handler)
        c.stdin!.write(JSON.stringify({ type: 'mcp_status' }) + '\n')
      })
      expect(msgs[0].servers.length).toBe(1)
      expect(msgs[0].servers[0].name).toBe('mock')
      expect(msgs[0].servers[0].connected).toBe(true)
      expect(msgs[0].servers[0].toolCount).toBe(3)
      expect(msgs[0].servers[0].error).toBeUndefined()
    } finally {
      c.kill()
      rl2.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)
})
