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
import { DEFAULT_CONFIRM_TOOLS } from '../src/server.js'

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

  it('rename_session → ok（重命名已有会话；面板"重命名会话"数据往返）', async () => {
    await request({ type: 'create_session', sessionId: 's-rn1', title: '旧标题' }, { expect: ['ok'] })
    const msgs = await request({ type: 'rename_session', sessionId: 's-rn1', title: '新标题' }, { expect: ['ok'] })
    expect(msgs[0].type).toBe('ok')
    expect(msgs[0].sessionId).toBe('s-rn1')
    expect(msgs[0].title).toBe('新标题')
    // 数据往返：recent_sessions 必须反映新标题（证明真实写入）
    const list = await request({ type: 'recent_sessions' }, { expect: ['recent_sessions'] })
    const row = list[0].sessions.find((s: any) => s.id === 's-rn1')
    expect(row).toBeTruthy()
    expect(row.title).toBe('新标题')
  })

  it('rename_session 缺 title / 空白 title → error（含用法提示，不触发生成）', async () => {
    const missing = await request({ type: 'rename_session', sessionId: 's-rn1' }, { expect: ['error'] })
    expect(missing[0].message).toContain('rename_session 需要 title')
    const blank = await request({ type: 'rename_session', sessionId: 's-rn1', title: '   ' }, { expect: ['error'] })
    expect(blank[0].message).toContain('rename_session 需要 title')
  })

  it('rename_session 不存在会话 → UPSERT 幂等 ok（与 create_session 同语义）', async () => {
    const msgs = await request({ type: 'rename_session', sessionId: 's-rn-none', title: '新会话' }, { expect: ['ok'] })
    expect(msgs[0].type).toBe('ok')
    // 会话被 UPSERT 创建，列表可见
    const list = await request({ type: 'recent_sessions' }, { expect: ['recent_sessions'] })
    const row = list[0].sessions.find((s: any) => s.id === 's-rn-none')
    expect(row).toBeTruthy()
    expect(row.title).toBe('新会话')
  })

  it('clear_session → ok（清空会话消息保留会话；面板"清空对话"）', async () => {
    await request({ type: 'create_session', sessionId: 's-clear1' }, { expect: ['ok'] })
    const msgs = await request({ type: 'clear_session', sessionId: 's-clear1' }, { expect: ['ok'] })
    expect(msgs[0].type).toBe('ok')
    expect(msgs[0].sessionId).toBe('s-clear1')
    expect(typeof msgs[0].cleared).toBe('number')
    // 会话记录保留（区别于 delete_session）：list_sessions 全量列表仍包含（不受 limit 排序影响）
    const list = await request({ type: 'list_sessions' }, { expect: ['sessions'] })
    expect(list[0].sessions.some((s: any) => s.id === 's-clear1')).toBe(true)
    // 消息为空
    const hist = await request({ type: 'get_messages', sessionId: 's-clear1' }, { expect: ['messages'] })
    expect(hist[0].messages).toEqual([])
  })

  it('clear_session 幂等（空会话重复清空 cleared:0 不报错）', async () => {
    await request({ type: 'create_session', sessionId: 's-clear2' }, { expect: ['ok'] })
    const again = await request({ type: 'clear_session', sessionId: 's-clear2' }, { expect: ['ok'] })
    expect(again[0].cleared).toBe(0)
    // 不影响其他会话：s-clear1（前一个测试创建）消息仍为空、可正常查询
    const hist = await request({ type: 'get_messages', sessionId: 's-clear1' }, { expect: ['messages'] })
    expect(hist[0].messages).toEqual([])
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

  it('session_usage → 单会话 token 用量（v0.6.17，只读不生成；未记录会话全 0）', async () => {
    const msgs = await request({ type: 'session_usage', sessionId: 's-usage-1' }, { expect: ['session_usage'] })
    expect(msgs[0].type).toBe('session_usage')
    expect(msgs[0].sessionId).toBe('s-usage-1')
    expect(typeof msgs[0].stats).toBe('object')
    expect(typeof msgs[0].stats.promptTokens).toBe('number')
    expect(typeof msgs[0].stats.completionTokens).toBe('number')
    expect(typeof msgs[0].stats.totalTokens).toBe('number')
    expect(typeof msgs[0].stats.callCount).toBe('number')
    // 未产生用量的会话：全 0（幂等，不抛错）
    expect(msgs[0].stats.totalTokens).toBe(0)

    // 缺省 sessionId → default 会话，结构一致
    const dflt = await request({ type: 'session_usage' }, { expect: ['session_usage'] })
    expect(dflt[0].sessionId).toBe('default')
    expect(typeof dflt[0].stats.totalTokens).toBe('number')
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

  it('context_status 带 budgetTokens → 附裁剪建议 suggestion（v0.6.4：宿主按预算裁剪上下文）', async () => {
    // 默认会话已积累上下文（至少 system + 历史）；给一个足够小的预算触发裁剪建议
    const msgs = await request(
      { type: 'context_status', sessionId: 's-ctx2', budgetTokens: 500, reserveForOutput: 100 },
      { expect: ['context_status'] }
    )
    const s = msgs[0].suggestion
    expect(msgs[0].type).toBe('context_status')
    // suggestion 结构完整：keepIndexes 保留 system 且数量 ≥1、droppedCount ≥0、估算 tokens ≤ 预算（扣预留）
    expect(Array.isArray(s.keepIndexes)).toBe(true)
    expect(s.keepIndexes.length).toBeGreaterThanOrEqual(1)
    expect(s.keepIndexes[0]).toBe(0) // system 保底 → 首个建议保留索引必为 0
    expect(typeof s.droppedCount).toBe('number')
    expect(s.droppedCount).toBeGreaterThanOrEqual(0)
    expect(typeof s.estimatedKeptTokens).toBe('number')
    // 保留部分估算 ≤ 总量（裁剪只减不增）；预算充足时保留全部
    expect(s.estimatedKeptTokens).toBeLessThanOrEqual(msgs[0].estimatedTokens)
    expect(typeof s.estimatedDroppedTokens).toBe('number')
    // keepIndexes 单调递增（保持原顺序）
    for (let i = 1; i < s.keepIndexes.length; i++) {
      expect(s.keepIndexes[i]).toBeGreaterThan(s.keepIndexes[i - 1])
    }
  })

  it('context_status 带非法 budgetTokens（0 / 负数 / 非整数）→ error，不返回 suggestion', async () => {
    for (const bad of [0, -5, 1.5, 'abc']) {
      const msgs = await request({ type: 'context_status', budgetTokens: bad }, { expect: ['error'] })
      expect(msgs[0].type).toBe('error')
      expect(msgs[0].message).toContain('budgetTokens')
    }
  })

  it('context_status 带非法 reserveForOutput（负数）→ error', async () => {
    const msgs = await request(
      { type: 'context_status', budgetTokens: 100, reserveForOutput: -1 },
      { expect: ['error'] }
    )
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('reserveForOutput')
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

  it('confirm_result 缺 id → error（v0.6.1 确认门协议校验）', async () => {
    const msgs = await request({ type: 'confirm_result', decision: 'allow_once' }, { expect: ['error'] })
    expect(msgs[0].message).toContain('id')
  })

  it('confirm_result 非法 decision → error（合法值提示）', async () => {
    const msgs = await request({ type: 'confirm_result', id: 'c_x', decision: 'maybe' }, { expect: ['error'] })
    expect(msgs[0].message).toContain('decision')
    expect(msgs[0].message).toContain('allow_once')
  })

  it('confirm_result 未知 id → 静默忽略（服务不崩、不回 error，后续请求正常）', async () => {
    // 无挂起确认时回未知 id：静默（不污染事件流）；随后 ping 必须正常到达（服务未崩）
    const msgs = await new Promise<any[]>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('超时（confirm_result 未知 id 后服务无响应）')) }, 8000)
      let sawError = false
      const handler = (line: string) => {
        try {
          const parsed = JSON.parse(line)
          if (parsed.type === 'error') sawError = true
          if (parsed.type === 'pong') {
            cleanup()
            resolve([{ ...parsed, sawError }])
          }
        } catch { /* 非 JSON 行忽略 */ }
      }
      const cleanup = () => { clearTimeout(timer); rl.removeListener('line', handler) }
      rl.on('line', handler)
      child.stdin!.write(JSON.stringify({ type: 'confirm_result', id: 'c_nonexist', decision: 'deny' }) + '\n')
      child.stdin!.write(JSON.stringify({ type: 'ping' }) + '\n')
    })
    expect(msgs[0].type).toBe('pong')
    expect((msgs[0] as any).sawError).toBe(false)
  }, 15000)

  it('confirm_status 默认：返回确认名单配置 + 空放行名单（v0.6.8 确认门管理）', async () => {
    const msgs = await request({ type: 'confirm_status' }, { expect: ['confirm_status'] })
    expect(msgs[0].type).toBe('confirm_status')
    expect(msgs[0].sessionId).toBe('default')
    // 默认确认名单 = DEFAULT_CONFIRM_TOOLS（含 memory_save）；无放行记录时三名单均为空
    expect(msgs[0].confirmTools).toContain('memory_save')
    expect(msgs[0].allowedTools).toEqual([])
    expect(msgs[0].sessionAllowed).toEqual([])
    expect(msgs[0].alwaysAllowed).toEqual([])
  })

  it('confirm_status 指定 sessionId：独立查询，返回该会话配置与空名单', async () => {
    const msgs = await request({ type: 'confirm_status', sessionId: 's-confirm-mgmt' }, { expect: ['confirm_status'] })
    expect(msgs[0].sessionId).toBe('s-confirm-mgmt')
    expect(Array.isArray(msgs[0].confirmTools)).toBe(true)
    expect(msgs[0].allowedTools).toEqual([])
  })

  it('confirm_revoke 缺 tool 且无 resetSession → error（参数校验）', async () => {
    const msgs = await request({ type: 'confirm_revoke', sessionId: 's-confirm-mgmt' }, { expect: ['error'] })
    expect(msgs[0].message).toContain('confirm_revoke')
    expect(msgs[0].message).toContain('tool')
  })

  it('confirm_revoke 指定 tool（无放行记录）→ 幂等 ok，随后 confirm_status 仍空', async () => {
    const msgs = await request(
      { type: 'confirm_revoke', sessionId: 's-confirm-mgmt', tool: 'memory_save' },
      { expect: ['ok'] }
    )
    expect(msgs[0].type).toBe('ok')
    expect(msgs[0].sessionId).toBe('s-confirm-mgmt')
    expect(msgs[0].tool).toBe('memory_save')
    const st = await request({ type: 'confirm_status', sessionId: 's-confirm-mgmt' }, { expect: ['confirm_status'] })
    expect(st[0].allowedTools).toEqual([])
  })

  it('confirm_revoke resetSession（无放行记录）→ 幂等 ok', async () => {
    const msgs = await request(
      { type: 'confirm_revoke', sessionId: 's-confirm-mgmt', resetSession: true },
      { expect: ['ok'] }
    )
    expect(msgs[0].type).toBe('ok')
    expect(msgs[0].resetSession).toBe(true)
  })

  it('confirm_allow 缺 tool → error（参数校验）', async () => {
    const msgs = await request({ type: 'confirm_allow', sessionId: 's-allow' }, { expect: ['error'] })
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('confirm_allow')
    expect(msgs[0].message).toContain('tool')
  })

  it('confirm_allow 非法 mode → error（含合法值提示）', async () => {
    const msgs = await request(
      { type: 'confirm_allow', sessionId: 's-allow', tool: 'memory_save', mode: 'forever' },
      { expect: ['error'] }
    )
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('mode')
    expect(msgs[0].message).toContain('session')
    expect(msgs[0].message).toContain('always')
  })

  it('confirm_allow 缺省 mode → session 会话级放行，confirm_status 可见且 always 为空', async () => {
    const sid = 's-allow-session'
    const ok = await request({ type: 'confirm_allow', sessionId: sid, tool: 'memory_save' }, { expect: ['ok'] })
    expect(ok[0].type).toBe('ok')
    expect(ok[0].sessionId).toBe(sid)
    expect(ok[0].tool).toBe('memory_save')
    expect(ok[0].mode).toBe('session')
    const st = await request({ type: 'confirm_status', sessionId: sid }, { expect: ['confirm_status'] })
    expect(st[0].allowedTools).toContain('memory_save')
    expect(st[0].sessionAllowed).toContain('memory_save')
    expect(st[0].alwaysAllowed).toEqual([])
  })

  it('confirm_allow mode=always → 跨会话持久化，confirm_status always 可见；revoke 可撤销', async () => {
    const sid = 's-allow-always'
    const ok = await request(
      { type: 'confirm_allow', sessionId: sid, tool: 'memory_save', mode: 'always' },
      { expect: ['ok'] }
    )
    expect(ok[0].type).toBe('ok')
    expect(ok[0].mode).toBe('always')
    const st = await request({ type: 'confirm_status', sessionId: sid }, { expect: ['confirm_status'] })
    expect(st[0].allowedTools).toContain('memory_save')
    expect(st[0].alwaysAllowed).toContain('memory_save')
    // revoke 撤销后恢复每次确认
    const rv = await request(
      { type: 'confirm_revoke', sessionId: sid, tool: 'memory_save' },
      { expect: ['ok'] }
    )
    expect(rv[0].type).toBe('ok')
    const st2 = await request({ type: 'confirm_status', sessionId: sid }, { expect: ['confirm_status'] })
    expect(st2[0].allowedTools).toEqual([])
    expect(st2[0].alwaysAllowed).toEqual([])
  })

  it('tools 请求：默认返回内置工具清单 + 确认名单回显 + memory_save 确认标注（v0.6.11）', async () => {
    const msgs = await request({ type: 'tools' }, { expect: ['tools'] })
    expect(msgs[0].type).toBe('tools')
    expect(msgs[0].sessionId).toBe('default')
    // 确认名单配置回显（宿主可据此展示"哪些写回类工具需确认"）
    expect(msgs[0].confirmTools).toEqual(DEFAULT_CONFIRM_TOOLS)
    // 内置工具集（含 read_file 等）；每个工具带 name/description/confirmed/source
    const tools: any[] = msgs[0].tools
    expect(Array.isArray(tools)).toBe(true)
    const names = tools.map((t: any) => t.name)
    expect(names).toContain('read_file')
    expect(names).toContain('memory_save')
    const save = tools.find((t: any) => t.name === 'memory_save')
    expect(save.confirmed).toBe(true)
    expect(save.source).toBe('builtin')
    expect(save.description).toBeTruthy()
    // 非确认工具不标注
    const read = tools.find((t: any) => t.name === 'read_file')
    expect(read.confirmed).toBe(false)
  })

  it('tools 请求指定 sessionId：返回该会话 Agent 工具清单（含确认名单）', async () => {
    const msgs = await request({ type: 'tools', sessionId: 's-tools-1' }, { expect: ['tools'] })
    expect(msgs[0].sessionId).toBe('s-tools-1')
    const names = msgs[0].tools.map((t: any) => t.name)
    expect(names).toContain('memory_save')
    expect(msgs[0].confirmTools).toEqual(DEFAULT_CONFIRM_TOOLS)
  })

  it('tools 请求 chat 带宿主代理工具后：反映该会话工具集（含 host 来源标注）', async () => {
    const sid = 's-tools-host'
    // chat 不触发（无 API key 时 error 流），但 Agent 已按宿主工具构建——tools 查询应反映宿主工具
    await request(
      {
        type: 'chat',
        sessionId: sid,
        input: 'hi',
        tools: [{ type: 'function', function: { name: 'host_echo', description: '宿主回显工具', parameters: { type: 'object' } } }],
      },
      { expect: ['done', 'error', 'cancelled'], collectAll: true, timeout: 20000 }
    ).catch(() => {}) // 无 API key 可能 error：不关心生成结果，只关心会话工具集记录
    const msgs = await request({ type: 'tools', sessionId: sid }, { expect: ['tools'] })
    const names = msgs[0].tools.map((t: any) => t.name)
    expect(names).toContain('host_echo')
    const host = msgs[0].tools.find((t: any) => t.name === 'host_echo')
    expect(host.source).toBe('host')
  })

  it('chat 带非法 maxTokens → error（v0.6.3 采样参数校验，不触发生成）', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-param', input: 'hi', maxTokens: -5 }, { expect: ['error'] })
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('maxTokens')
  })

  it('chat 带非整数 maxTokens → error（必须是正整数）', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-param2', input: 'hi', maxTokens: 1.5 }, { expect: ['error'] })
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('maxTokens')
  })

  it('chat 带非法 temperature → error（0~2 范围校验）', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-param3', input: 'hi', temperature: 3 }, { expect: ['error'] })
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('temperature')
  })

  it('chat 带非数值 temperature → error', async () => {
    const msgs = await request({ type: 'chat', sessionId: 's-param4', input: 'hi', temperature: 'abc' }, { expect: ['error'] })
    expect(msgs[0].type).toBe('error')
    expect(msgs[0].message).toContain('temperature')
  })

  it('chat 带合法 maxTokens/temperature → 协议流完整（采样参数透传不破坏流程）', async () => {
    // 不断言具体错误（可能 fallback 本地 Ollama / 远端网络），只验证协议：参数被接受且事件流正常终止
    const msgs = await request(
      { type: 'chat', sessionId: 's-param5', input: '你好', maxTokens: 512, temperature: 0.5 },
      { collectAll: true, timeout: 45000 }
    )
    expect(msgs.length).toBeGreaterThan(0)
    const last = msgs[msgs.length - 1]
    expect(['done', 'error', 'cancelled'].includes(last.type)).toBe(true)
    for (const m of msgs) {
      expect(['text', 'tool_call', 'tool_execute', 'tool_result', 'done', 'error', 'cancelled'].includes(m.type)).toBe(true)
    }
  }, 45000)

  it('get_config → config 响应（服务器运行配置，v0.6.18 只读不触发生成）', async () => {
    const msgs = await request({ type: 'get_config' }, { expect: ['config'] })
    const c = msgs[0]
    expect(c.type).toBe('config')
    // 确认门配置（默认名单 + 默认 30s 超时）
    expect(c.confirmTools).toEqual(DEFAULT_CONFIRM_TOOLS)
    expect(c.confirmTimeoutMs).toBe(30000)
    // 默认采样/裁剪参数（本测试服务器未带 --max-* → null）
    expect(c.defaultMaxTokens).toBe(null)
    expect(c.defaultTemperature).toBe(null)
    expect(c.defaultMaxContextMessages).toBe(null)
    expect(c.defaultMaxContextTokens).toBe(null)
    // 工具超时 / namespace / storage / MCP 清单（不含密钥）
    expect(c.toolTimeoutMs).toBe(30000)
    expect(c.namespace).toBe(null)
    expect(typeof c.storage).toBe('string')
    expect(c.storage).toContain('test.db')
    expect(Array.isArray(c.mcpServers)).toBe(true)
  })
})
