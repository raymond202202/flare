/**
 * 上下文裁剪执行 API（v0.6.35 apply_trim / Agent.applyTrim）测试
 * 覆盖：MemoryStore.getMessagesWithIds/deleteMessages + Agent.applyTrim（保底 system、store 同步、
 * 非法索引防御）+ server 协议 apply_trim e2e（真实子进程，budgetTokens / keepIndexes 双模式）
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { MemoryStore } from '../src/memory/store.js'
import { Agent } from '../src/core/agent.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'dist', 'cli', 'index.js')

/** 假 LLM（applyTrim 不调 LLM；仅构造 Agent 需要） */
const fakeProvider = {
  chat: async () => ({ content: '', model: 'mock' }),
} as any

// ===== MemoryStore 单测 =====
let tempDir: string
let store: MemoryStore

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'flare-applytrim-test-'))
  store = new MemoryStore(join(tempDir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('MemoryStore 消息 id 与删除（v0.6.35）', () => {
  it('getMessagesWithIds 返回 id + message（与 getMessages 内容一致，limit 生效）', () => {
    const sid = store.createSession('ids-s1')
    store.saveMessage(sid, { role: 'user', content: '第一条' })
    store.saveMessage(sid, { role: 'assistant', content: '回复' })
    store.saveMessage(sid, { role: 'user', content: '第三条' })

    const withIds = store.getMessagesWithIds(sid)
    expect(withIds).toHaveLength(3)
    // id 自增有序
    expect(withIds[0].id).toBeLessThan(withIds[1].id)
    expect(withIds[1].id).toBeLessThan(withIds[2].id)
    // message 结构与 getMessages 一致
    expect(withIds.map(w => w.message)).toEqual(store.getMessages(sid))
    // limit 生效
    expect(store.getMessagesWithIds(sid, 2)).toHaveLength(2)
    // 空会话幂等 []
    expect(store.getMessagesWithIds('ghost-s')).toEqual([])
  })

  it('deleteMessages 按 id 删除指定消息（只删明确指定的）', () => {
    const sid = store.createSession('ids-s2')
    store.saveMessage(sid, { role: 'user', content: 'A' })
    store.saveMessage(sid, { role: 'user', content: 'B' })
    store.saveMessage(sid, { role: 'user', content: 'C' })
    const withIds = store.getMessagesWithIds(sid)
    const delId = withIds[1].id // 删 B
    const deleted = store.deleteMessages(sid, [delId])
    expect(deleted).toBe(1)
    const remaining = store.getMessages(sid).map(m => m.content)
    expect(remaining).toEqual(['A', 'C'])
  })

  it('deleteMessages 幂等：空数组/不存在 id 返回 0 不报错', () => {
    const sid = store.createSession('ids-s3')
    store.saveMessage(sid, { role: 'user', content: 'A' })
    expect(store.deleteMessages(sid, [])).toBe(0)
    expect(store.deleteMessages(sid, [999999])).toBe(0)
    expect(store.deleteMessages('ghost', [1])).toBe(0)
    expect(store.getMessages(sid)).toHaveLength(1)
  })
})

// ===== Agent.applyTrim 集成 =====
describe('Agent.applyTrim（v0.6.35）', () => {
  it('保底开头 system 块 + 按索引保留（内存正确）', () => {
    const sid = store.createSession('trim-s1')
    store.saveMessage(sid, { role: 'user', content: '旧消息1' })
    store.saveMessage(sid, { role: 'assistant', content: '旧回复1' })
    store.saveMessage(sid, { role: 'user', content: '旧消息2' })
    const agent = new Agent({ sessionId: sid, storage: join(tempDir, 'test.db'), llm: fakeProvider })
    // 无身份/记忆 → 1 条 system + 3 条历史
    expect(agent.getMessages().map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    // 只保留索引 3（旧消息2）；system 自动保底
    const res = agent.applyTrim([3])
    expect(res).toEqual({ keptCount: 2, droppedCount: 2 })
    expect(agent.getMessages().map(m => m.role)).toEqual(['system', 'user'])
    expect(agent.getMessages()[1].content).toBe('旧消息2')
  })

  it('store 同步：被裁消息从 store 删除，重建 Agent 后裁剪依然生效', () => {
    const sid = store.createSession('trim-s2')
    store.saveMessage(sid, { role: 'user', content: '旧1' })
    store.saveMessage(sid, { role: 'assistant', content: '旧回复' })
    store.saveMessage(sid, { role: 'user', content: '新1' })
    const agent = new Agent({ sessionId: sid, storage: join(tempDir, 'test.db'), llm: fakeProvider })
    agent.applyTrim([3]) // 保留 system + 新1
    // store 中只剩保留的历史（system 不落库）
    expect(store.getMessages(sid).map(m => m.content)).toEqual(['新1'])
    // 重建 Agent：上下文确实变小（裁剪持久生效）
    const agent2 = new Agent({ sessionId: sid, storage: join(tempDir, 'test.db'), llm: fakeProvider })
    expect(agent2.getMessages().map(m => m.role)).toEqual(['system', 'user'])
    expect(agent2.getMessages()[1].content).toBe('新1')
  })

  it('非法索引（负数/越界/非整数）宽松过滤 + 重复去重', () => {
    const sid = store.createSession('trim-s3')
    store.saveMessage(sid, { role: 'user', content: '旧1' })
    store.saveMessage(sid, { role: 'user', content: '旧2' })
    store.saveMessage(sid, { role: 'user', content: '新1' })
    const agent = new Agent({ sessionId: sid, storage: join(tempDir, 'test.db'), llm: fakeProvider })
    const res = agent.applyTrim([3, 99, -1, 1.5, 3]) // 只有 3 合法，重复去重
    expect(res).toEqual({ keptCount: 2, droppedCount: 2 })
    expect(agent.getMessages()[1].content).toBe('新1')
    // 空数组/undefined：不裁剪不崩
    expect(agent.applyTrim([])).toEqual({ keptCount: 2, droppedCount: 0 })
  })

  it('无 sessionId：只裁内存不崩（无 store 同步）', () => {
    const agent = new Agent({ llm: fakeProvider })
    agent.setContext('宿主状态')
    expect(agent.getMessages().length).toBeGreaterThanOrEqual(2)
    const res = agent.applyTrim([0])
    expect(res.droppedCount).toBeGreaterThanOrEqual(0)
    expect(agent.getMessages().length).toBeGreaterThanOrEqual(1)
  })

  it('多 system 保底（身份/记忆独立消息 v0.6.29 形态）：整块保留相对顺序', () => {
    const sid = store.createSession('trim-s4')
    store.saveMessage(sid, { role: 'user', content: '旧1' })
    store.saveMessage(sid, { role: 'user', content: '新1' })
    store.saveMemory('用户偏好：喜欢简洁回答')
    // 构造带身份 + 记忆的 Agent（记忆在构造时读取）
    const agent2 = new Agent({
      sessionId: sid,
      storage: join(tempDir, 'test.db'),
      llm: fakeProvider,
      identity: '我是测试助手',
    })
    // 开头连续 system 块 = 稳定前缀 + 身份 + 记忆（3 条）
    const sysCount = agent2.getMessages().filter(m => m.role === 'system').length
    expect(sysCount).toBeGreaterThanOrEqual(3)
    const res = agent2.applyTrim([sysCount + 1]) // 只保留最新 user
    expect(res.keptCount).toBe(sysCount + 1)
    // 全部 system 保底且相对顺序不变
    const roles = agent2.getMessages().map(m => m.role)
    expect(roles.slice(0, sysCount).every(r => r === 'system')).toBe(true)
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
  srvTempDir = mkdtempSync(path.join(tmpdir(), 'flare-applytrim-srv-'))
  // 预置 db：建表 + 写入两个会话的历史消息（子进程打开同一 db 后可直接 apply_trim；
  // saveMessage 自动 INSERT OR IGNORE 创建指定 id 的会话记录）
  const preset = new MemoryStore(path.join(srvTempDir, 'test.db'))
  preset.saveMessage('trim-e2e-1', { role: 'user', content: '第一轮问题' })
  preset.saveMessage('trim-e2e-1', { role: 'assistant', content: '第一轮回答' })
  preset.saveMessage('trim-e2e-1', { role: 'user', content: '第二轮问题' })
  preset.saveMessage('trim-e2e-2', { role: 'user', content: '会话二问题' })
  preset.close()

  const env: Record<string, string> = { ...process.env } as Record<string, string>
  delete env.DEEPSEEK_API_KEY
  child = spawn(process.execPath, [CLI, 'server', '--storage', path.join(srvTempDir, 'test.db')], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  rl = createInterface({ input: child.stdout! })
  // 等待 server 就绪
  await request({ id: ++nextId, type: 'ping' }, ['pong'])
})

afterAll(async () => {
  child.kill()
  rl.close()
  rmSync(srvTempDir, { recursive: true, force: true })
})

describe('server 协议 apply_trim（v0.6.35）', () => {
  it('参数校验：无参数 / keepIndexes 非法 / budgetTokens 非法 / reserveForOutput 非法 → error 含用法', async () => {
    const none = await request({ id: ++nextId, type: 'apply_trim' }, ['error'])
    expect(none[0].message).toContain('keepIndexes')

    const negIdx = await request({ id: ++nextId, type: 'apply_trim', keepIndexes: [-1] }, ['error'])
    expect(negIdx[0].message).toContain('非负整数')
    const outOfRange = await request({ id: ++nextId, type: 'apply_trim', keepIndexes: [99] }, ['error'])
    expect(outOfRange[0].message).toContain('当前消息数')
    const floatIdx = await request({ id: ++nextId, type: 'apply_trim', keepIndexes: [1.5] }, ['error'])
    expect(floatIdx[0].message).toContain('非负整数')

    const zeroBudget = await request({ id: ++nextId, type: 'apply_trim', budgetTokens: 0 }, ['error'])
    expect(zeroBudget[0].message).toContain('正整数')
    const negBudget = await request({ id: ++nextId, type: 'apply_trim', budgetTokens: -1 }, ['error'])
    expect(negBudget[0].message).toContain('正整数')
    const floatBudget = await request({ id: ++nextId, type: 'apply_trim', budgetTokens: 1.5 }, ['error'])
    expect(floatBudget[0].message).toContain('正整数')

    const negReserve = await request({ id: ++nextId, type: 'apply_trim', budgetTokens: 100, reserveForOutput: -1 }, ['error'])
    expect(negReserve[0].message).toContain('reserveForOutput')
  })

  it('budgetTokens 模式：服务器按 suggestTrim 裁剪并同步 store（get_messages 被裁消息消失）', async () => {
    // 上下文 = 1 system + 3 历史
    const status = await request({ id: ++nextId, type: 'context_status', sessionId: 'trim-e2e-1' }, ['context_status'])
    expect(status[0].messageCount).toBe(4)

    // 极小预算 → 保底 system + 最新一条
    const trim = await request({ id: ++nextId, type: 'apply_trim', sessionId: 'trim-e2e-1', budgetTokens: 1 }, ['ok'])
    expect(trim[0]).toMatchObject({ type: 'ok', sessionId: 'trim-e2e-1' })
    expect(trim[0].keptCount).toBe(2)
    expect(trim[0].droppedCount).toBe(2)
    expect(trim[0].messageCount).toBe(2)

    // store 同步：被裁的旧消息已删除，最新消息保留
    const msgs = await request({ id: ++nextId, type: 'get_messages', sessionId: 'trim-e2e-1' }, ['messages'])
    const contents = msgs[0].messages.map((m: any) => m.content)
    expect(contents).not.toContain('第一轮问题')
    expect(contents).not.toContain('第一轮回答')
    expect(contents).toContain('第二轮问题')
  })

  it('keepIndexes 模式：回传索引立即裁剪；重复裁剪幂等', async () => {
    // trim-e2e-2 上下文 = 1 system + 1 历史
    const status = await request({ id: ++nextId, type: 'context_status', sessionId: 'trim-e2e-2' }, ['context_status'])
    expect(status[0].messageCount).toBe(2)

    // 保留 system + 历史（索引 0,1）→ 不裁
    const keepAll = await request({ id: ++nextId, type: 'apply_trim', sessionId: 'trim-e2e-2', keepIndexes: [0, 1] }, ['ok'])
    expect(keepAll[0]).toMatchObject({ type: 'ok', keptCount: 2, droppedCount: 0 })

    // 只保留 system（索引 0）→ 裁掉历史
    const keepSys = await request({ id: ++nextId, type: 'apply_trim', sessionId: 'trim-e2e-2', keepIndexes: [0] }, ['ok'])
    expect(keepSys[0]).toMatchObject({ type: 'ok', keptCount: 1, droppedCount: 1 })
    const msgs = await request({ id: ++nextId, type: 'get_messages', sessionId: 'trim-e2e-2' }, ['messages'])
    expect(msgs[0].messages).toHaveLength(0) // 历史已从 store 删除

    // 再裁一次（幂等不报错）
    const again = await request({ id: ++nextId, type: 'apply_trim', sessionId: 'trim-e2e-2', keepIndexes: [0] }, ['ok'])
    expect(again[0].type).toBe('ok')
  })

  it('budgetTokens + reserveForOutput：预算扣减输出预留', async () => {
    // 用默认会话（只有 system 块）——reserve 合法路径不报错
    const trim = await request({ id: ++nextId, type: 'apply_trim', budgetTokens: 5000, reserveForOutput: 1000 }, ['ok'])
    expect(trim[0].type).toBe('ok')
    expect(trim[0].droppedCount).toBe(0)
  })
})
