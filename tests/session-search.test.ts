/**
 * 会话搜索 API（v0.6.43 search_sessions）测试
 * 覆盖：MemoryStore.searchSessions（标题/消息内容 LIKE 匹配、DISTINCT 去重、limit、排序、结构同 getAllSessions）
 *      + server 协议 e2e（真实子进程 + 预置 DB：标题匹配 / 内容匹配 / 参数校验 / 无匹配）
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { MemoryStore } from '../src/memory/store.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'dist', 'cli', 'index.js')

// ===== MemoryStore 单测 =====
let tempDir: string
let store: MemoryStore

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'flare-search-test-'))
  store = new MemoryStore(join(tempDir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('MemoryStore.searchSessions', () => {
  it('按标题 LIKE 匹配（中文关键词）', () => {
    const sid = store.createSession('flutter 集成指南')
    store.createSession('cooking 菜谱')
    const hits = store.searchSessions('集成')
    expect(hits.map(h => h.id)).toContain(sid)
    expect(hits.find(h => h.id === sid)!.title).toBe('flutter 集成指南')
    expect(hits.length).toBe(1)
  })

  it('按会话内消息内容 LIKE 匹配（标题不匹配也命中）', () => {
    const sid = store.createSession('普通标题')
    store.saveMessage(sid, { role: 'user', content: '深度讨论 prompt caching 前缀稳定策略' })
    const hits = store.searchSessions('前缀稳定')
    expect(hits.map(h => h.id)).toContain(sid)
    const row = hits.find(h => h.id === sid)!
    expect(row.title).toBe('普通标题')
    expect(row.messageCount).toBe(1) // 结构同 getAllSessions：带消息数
  })

  it('DISTINCT 去重：同一会话多条消息命中只出现一次', () => {
    const sid = store.createSession('去重测试')
    store.saveMessage(sid, { role: 'user', content: '第一条提到 flare 引擎' })
    store.saveMessage(sid, { role: 'assistant', content: '回复也提到 flare 引擎' })
    const hits = store.searchSessions('flare 引擎')
    expect(hits.filter(h => h.id === sid)).toHaveLength(1)
  })

  it('空/空白 query → 空数组（不误搜全部）', () => {
    store.createSession('任意会话')
    expect(store.searchSessions('')).toEqual([])
    expect(store.searchSessions('   ')).toEqual([])
    expect(store.searchSessions(undefined as unknown as string)).toEqual([])
  })

  it('无匹配 → 空数组', () => {
    store.createSession('不相关标题')
    expect(store.searchSessions('绝无此词xyz')).toEqual([])
  })

  it('limit 生效（默认 20，可收窄）', () => {
    for (let i = 0; i < 3; i++) store.createSession(`搜索命中会话 ${i}`)
    expect(store.searchSessions('搜索命中', 2)).toHaveLength(2)
    expect(store.searchSessions('搜索命中', 10)).toHaveLength(3)
  })

  it('按 updated_at 倒序（最近更新的会话在前）', async () => {
    const older = store.createSession('排序旧会话')
    store.saveMessage(older, { role: 'user', content: '关键词 alpha' })
    // datetime('now') 秒级粒度：等待越过下一秒再写入第二个会话
    await new Promise(r => setTimeout(r, 1100))
    const newer = store.createSession('排序新会话')
    store.saveMessage(newer, { role: 'user', content: '关键词 beta' })
    const hits = store.searchSessions('关键词')
    expect(hits.map(h => h.id)).toEqual([newer, older])
  })

  it('结构同 getAllSessions（id/title/createdAt/updatedAt/messageCount/archived）', () => {
    const sid = store.createSession('结构测试')
    store.saveMessage(sid, { role: 'user', content: '结构关键词' })
    store.archiveSession(sid)
    const hit = store.searchSessions('结构关键词')[0]
    expect(Object.keys(hit).sort()).toEqual(Object.keys(store.getAllSessions()[0]).sort())
    expect(hit.archived).toBe(true) // 与 getAllSessions 一致：不过滤归档
    expect(hit.id).toBe(sid)
    expect(hit.messageCount).toBe(1)
    expect(hit.createdAt).toBeTruthy()
    expect(hit.updatedAt).toBeTruthy()
  })
})

// ===== server 协议 e2e =====
let child: ChildProcess
let rl: Interface
let nextId = 0
let srvTempDir: string

function request(msg: any, expectTypes: string[], timeout = 15000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const msgs: any[] = []
    const timer = setTimeout(() => { cleanup(); reject(new Error(`超时（请求 ${JSON.stringify(msg).slice(0, 80)}）`)) }, timeout)
    const handler = (line: string) => {
      try {
        const parsed = JSON.parse(line)
        if (expectTypes.includes(parsed.type)) {
          msgs.push(parsed)
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
  srvTempDir = mkdtempSync(path.join(tmpdir(), 'flare-search-srv-'))
  // 预置 DB：server 启动前写入 3 个会话（2 个标题可搜 + 1 个仅消息内容可搜），
  // 这样 e2e 可在不触发 chat（不走 LLM/网络）的情况下验证「标题匹配」与「消息内容匹配」两条路径
  const dbPath = path.join(srvTempDir, 'test.db')
  const pre = new MemoryStore(dbPath)
  const titleHit = pre.createSession('flutter 集成指南')
  pre.saveMessage(titleHit, { role: 'user', content: '深度讨论 prompt caching 前缀稳定策略' })
  pre.createSession('cooking 菜谱')
  const contentOnly = pre.createSession('普通标题')
  pre.saveMessage(contentOnly, { role: 'user', content: '深度讨论 prompt caching 前缀稳定策略' })
  pre.close()

  const env: Record<string, string> = { ...process.env } as Record<string, string>
  delete env.DEEPSEEK_API_KEY
  child = spawn(process.execPath, [CLI, 'server', '--storage', dbPath], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  rl = createInterface({ input: child.stdout! })
  // 等待 server 就绪
  await request({ id: ++nextId, type: 'ping' }, ['pong'])
})

afterAll(async () => {
  child.kill()
  rl.close()
  rmSync(srvTempDir, { recursive: true, force: true })
})

describe('server 协议 search_sessions（v0.6.43）', () => {
  it('按标题搜索命中（真实子进程 + 预置 DB 闭环）', async () => {
    const res = await request({ id: ++nextId, type: 'search_sessions', query: '集成' }, ['search_sessions'])
    const body = res[0]
    expect(body.type).toBe('search_sessions')
    expect(body.query).toBe('集成')
    const ids = body.sessions.map((s: any) => s.id)
    expect(ids.length).toBeGreaterThanOrEqual(1)
    const hit = body.sessions.find((s: any) => s.title === 'flutter 集成指南')
    expect(hit).toBeTruthy()
    expect(hit.messageCount).toBe(1)
  })

  it('按消息内容搜索命中（标题不含关键词）', async () => {
    const res = await request({ id: ++nextId, type: 'search_sessions', query: '前缀稳定' }, ['search_sessions'])
    const body = res[0]
    const hit = body.sessions.find((s: any) => s.title === '普通标题')
    expect(hit).toBeTruthy()
    expect(hit.messageCount).toBe(1)
  })

  it('无匹配 → sessions 空数组（服务不崩）', async () => {
    const res = await request({ id: ++nextId, type: 'search_sessions', query: '绝无此词xyz' }, ['search_sessions'])
    expect(res[0].sessions).toEqual([])
  })

  it('缺 query → error 含用法，不触发生成', async () => {
    const res = await request({ id: ++nextId, type: 'search_sessions' }, ['error'])
    expect(res[0].message).toContain('query')
    expect(res[0].message).toContain('search_sessions')
  })

  it('limit 非法（0 / -1 / 1.5 / "abc" / 101）→ error 含提示', async () => {
    for (const bad of [0, -1, 1.5, 'abc', 101]) {
      const res = await request({ id: ++nextId, type: 'search_sessions', query: '集成', limit: bad }, ['error'])
      expect(res[0].message).toContain('limit')
      expect(res[0].message).toContain('1~100')
    }
  })

  it('limit 合法收窄生效（多命中会话时限制条数）', async () => {
    // 预置 DB 中「flutter 集成指南」与「普通标题」两个会话的消息内容都含「前缀稳定」——真实多命中
    const all = await request({ id: ++nextId, type: 'search_sessions', query: '前缀稳定' }, ['search_sessions'])
    expect(all[0].sessions.length).toBeGreaterThanOrEqual(2)
    const narrowed = await request({ id: ++nextId, type: 'search_sessions', query: '前缀稳定', limit: 1 }, ['search_sessions'])
    expect(narrowed[0].sessions).toHaveLength(1)
  })
})
