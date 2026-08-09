/**
 * withConfirmation / ConfirmationGate 工具确认机制测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withConfirmation, isDenied, ConfirmationGate, memoryStoreKv } from '../src/core/confirm.js'
import type { ConfirmKeyValueStore, Confirmer } from '../src/core/confirm.js'
import type { Tool } from '../src/tools/index.js'
import { MemoryStore } from '../src/memory/store.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

function makeWriteTool(): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'write_something',
        description: '写内容',
        parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
      },
    },
    execute: async (args) => ({ success: true, output: `已写入: ${args.content}` }),
  }
}

/** 内存 KV（模拟 MemoryStore settings 表） */
function makeKvStore(): ConfirmKeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get: (k) => data.get(k) ?? null,
    set: (k, v) => { if (v) data.set(k, v); else data.delete(k) },
  }
}

/** 永不返回的 confirmer（测超时） */
function neverConfirmer(): Promise<'deny'> {
  return new Promise(() => { /* 永不 resolve */ })
}

describe('withConfirmation 工具确认', () => {
  it('allow_once 执行原工具', async () => {
    const tool = withConfirmation(makeWriteTool(), () => 'allow_once')
    const res = await tool.execute({ content: 'hello' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('hello')
  })

  it('deny 不执行原工具，返回用户拒绝', async () => {
    const spy = vi.fn()
    const tool = withConfirmation({
      ...makeWriteTool(),
      execute: async (args) => { spy(); return { success: true, output: '不应执行' } },
    }, () => 'deny')
    const res = await tool.execute({ content: 'x' })
    expect(res.success).toBe(false)
    expect(res.denied).toBe(true)
    expect(spy).not.toHaveBeenCalled()
    expect(isDenied(res)).toBe(true)
  })

  it('alternative 不执行，返回替代方案请求', async () => {
    const spy = vi.fn()
    const tool = withConfirmation({
      ...makeWriteTool(),
      execute: async () => { spy(); return { success: true, output: 'x' } },
    }, () => 'alternative')
    const res = await tool.execute({})
    expect(res.success).toBe(false)
    expect(res.alternative).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('confirmer 收到工具名和参数', async () => {
    const confirmer = vi.fn<Confirmer>(() => 'allow_once')
    const tool = withConfirmation(makeWriteTool(), confirmer)
    await tool.execute({ content: 'abc' })
    expect(confirmer).toHaveBeenCalledWith('write_something', { content: 'abc' })
  })

  it('always / allow_session 也执行', async () => {
    for (const d of ['always', 'allow_session'] as const) {
      const tool = withConfirmation(makeWriteTool(), () => d)
      const res = await tool.execute({ content: 'y' })
      expect(res.success).toBe(true)
    }
  })
})

describe('ConfirmationGate 放行记忆化', () => {
  it('allow_session：首次确认，之后同一会话直接放行（confirmer 只调一次）', async () => {
    const confirmer = vi.fn<Confirmer>(() => 'allow_session')
    const gate = new ConfirmationGate({ confirmer })
    const tool = gate.wrap(makeWriteTool())
    expect((await tool.execute({ content: 'a' })).success).toBe(true)
    expect((await tool.execute({ content: 'b' })).success).toBe(true)
    expect((await tool.execute({ content: 'c' })).success).toBe(true)
    expect(confirmer).toHaveBeenCalledTimes(1)
  })

  it('allow_session 按 sessionId 隔离：不同会话重新确认', async () => {
    const confirmer = vi.fn<Confirmer>(() => 'allow_session')
    const gateA = new ConfirmationGate({ confirmer, sessionId: 's1' })
    const gateB = new ConfirmationGate({ confirmer, sessionId: 's2' })
    await gateA.wrap(makeWriteTool()).execute({ content: 'a' })
    await gateB.wrap(makeWriteTool()).execute({ content: 'b' })
    expect(confirmer).toHaveBeenCalledTimes(2)
  })

  it('always + store：持久化放行，新 gate 实例（同一 store）不再确认', async () => {
    const store = makeKvStore()
    const confirmer = vi.fn<Confirmer>(() => 'always')
    const gate1 = new ConfirmationGate({ confirmer, store })
    const tool1 = gate1.wrap(makeWriteTool())
    expect((await tool1.execute({ content: 'a' })).success).toBe(true)
    expect(store.data.get('confirm.always.write_something')).toBe('1')

    // 新实例（如新会话/重启后）同一 store → 直接放行
    const confirmer2 = vi.fn<Confirmer>(() => 'deny')
    const gate2 = new ConfirmationGate({ confirmer: confirmer2, store })
    const tool2 = gate2.wrap(makeWriteTool())
    expect((await tool2.execute({ content: 'b' })).success).toBe(true)
    expect(confirmer2).not.toHaveBeenCalled()
    expect(gate2.isAllowed('write_something')).toBe(true)
  })

  it('always 无 store：不报错，退化为会话级放行', async () => {
    const confirmer = vi.fn<Confirmer>(() => 'always')
    const gate = new ConfirmationGate({ confirmer })
    const tool = gate.wrap(makeWriteTool())
    expect((await tool.execute({ content: 'a' })).success).toBe(true)
    expect((await tool.execute({ content: 'b' })).success).toBe(true)
    expect(confirmer).toHaveBeenCalledTimes(1) // 会话内记忆生效
  })

  it('allow_once 每次确认（不记忆）', async () => {
    const confirmer = vi.fn<Confirmer>(() => 'allow_once')
    const gate = new ConfirmationGate({ confirmer })
    const tool = gate.wrap(makeWriteTool())
    await tool.execute({ content: 'a' })
    await tool.execute({ content: 'b' })
    expect(confirmer).toHaveBeenCalledTimes(2)
  })

  it('revoke 撤销放行：store 同步清除 + 重新确认', async () => {
    const store = makeKvStore()
    const gate = new ConfirmationGate({ confirmer: () => 'always', store })
    gate.allowAlways('write_something')
    expect(gate.isAllowed('write_something')).toBe(true)
    expect(store.data.has('confirm.always.write_something')).toBe(true)

    const confirmer = vi.fn<Confirmer>(() => 'allow_once')
    gate.revoke('write_something')
    expect(gate.isAllowed('write_something')).toBe(false)
    expect(store.data.has('confirm.always.write_something')).toBe(false)
    const tool = new ConfirmationGate({ confirmer, store }).wrap(makeWriteTool())
    await tool.execute({ content: 'x' })
    expect(confirmer).toHaveBeenCalledTimes(1)
  })

  it('listAllowed / resetSession 管理会话级放行', async () => {
    const gate = new ConfirmationGate({ confirmer: () => 'allow_session' })
    const tool = gate.wrap(makeWriteTool())
    await tool.execute({ content: 'a' })
    expect(gate.listAllowed()).toEqual(['write_something'])
    gate.resetSession()
    expect(gate.listAllowed()).toEqual([])
    expect(gate.isAllowed('write_something')).toBe(false)
  })

  it('显式 allowSession / allowAlways 立即放行（不调 confirmer）', async () => {
    const confirmer = vi.fn<Confirmer>(() => 'deny')
    const gate = new ConfirmationGate({ confirmer })
    gate.allowSession('write_something')
    const res = await gate.wrap(makeWriteTool()).execute({ content: 'x' })
    expect(res.success).toBe(true)
    expect(confirmer).not.toHaveBeenCalled()
  })

  it('wrap 保留工具元数据（definition 不变）', () => {
    const gate = new ConfirmationGate({ confirmer: () => 'allow_once' })
    const wrapped = gate.wrap(makeWriteTool())
    expect(wrapped.definition.function.name).toBe('write_something')
    expect(wrapped.definition.function.description).toBe('写内容')
  })
})

describe('ConfirmationGate 放行名单查询（v0.6.8：listAlwaysAllowed / listAllAllowed）', () => {
  const candidates = ['memory_save', 'write_something']

  it('listAlwaysAllowed：无 store 时 always 退化为会话级，持久化名单为空（但 isAllowed 生效）', async () => {
    const gate = new ConfirmationGate({ confirmer: () => 'always' })
    const tool = gate.wrap(makeWriteTool())
    await tool.execute({ content: 'a' })
    expect(gate.isAllowed('write_something')).toBe(true)
    expect(gate.listAlwaysAllowed(candidates)).toEqual([])
  })

  it('listAlwaysAllowed：store 持久化 always → 返回命中候选', () => {
    const gate = new ConfirmationGate({ confirmer: () => 'always', store: makeKvStore() })
    gate.allowAlways('write_something')
    expect(gate.listAlwaysAllowed(candidates)).toEqual(['write_something'])
  })

  it('listAlwaysAllowed 按候选名单过滤：非候选工具不返回', () => {
    const gate = new ConfirmationGate({ confirmer: () => 'always', store: makeKvStore() })
    gate.allowAlways('other_tool') // 不在候选名单
    expect(gate.listAlwaysAllowed(candidates)).toEqual([])
    expect(gate.listAlwaysAllowed(['other_tool', ...candidates])).toEqual(['other_tool'])
  })

  it('listAllAllowed：会话级 + always 持久化合并去重', async () => {
    const gate = new ConfirmationGate({ confirmer: () => 'allow_session', store: makeKvStore() })
    const tool = gate.wrap(makeWriteTool())
    // allow_session → 会话级放行 write_something；显式 allowAlways → 持久化 memory_save
    await tool.execute({ content: 'a' })
    gate.allowAlways('memory_save')
    expect(gate.listAllAllowed(candidates)).toEqual(['memory_save', 'write_something'])
    // 去重：同一工具会话级 + always 双命中只出现一次
    gate.allowSession('memory_save')
    expect(gate.listAllAllowed(candidates)).toEqual(['memory_save', 'write_something'])
  })

  it('listAllAllowed 并入不在候选名单的会话级放行（显式 allowSession）', () => {
    const gate = new ConfirmationGate({ confirmer: () => 'deny' })
    gate.allowSession('custom_tool')
    expect(gate.listAllAllowed(candidates)).toEqual(['custom_tool'])
  })

  it('revoke 后名单查询同步清除（会话级 + 持久化）', () => {
    const store = makeKvStore()
    const gate = new ConfirmationGate({ confirmer: () => 'allow_session', store })
    gate.allowAlways('write_something')
    gate.allowSession('memory_save')
    expect(gate.listAllAllowed(candidates).length).toBe(2)
    gate.revoke('write_something')
    expect(gate.listAlwaysAllowed(candidates)).toEqual([])
    expect(gate.listAllAllowed(candidates)).toEqual(['memory_save'])
    expect(store.data.has('confirm.always.write_something')).toBe(false)
  })

  it('空候选名单：always 持久化无法枚举（返回空）；会话级放行仍可见（不依赖候选）', () => {
    const store = makeKvStore()
    const gate = new ConfirmationGate({ confirmer: () => 'always', store })
    gate.allowAlways('write_something')
    expect(gate.listAlwaysAllowed([])).toEqual([])
    // listAllAllowed 含会话级：allowAlways 同时写入会话级 → 即使无候选也可见
    expect(gate.listAllAllowed([])).toEqual(['write_something'])
    expect(gate.isAllowed('write_something')).toBe(true)
  })
})

describe('ConfirmationGate 超时保护', () => {
  it('confirmer 超时未决 → 默认 deny（安全），结果带 timeout 标记', async () => {
    const gate = new ConfirmationGate({ confirmer: neverConfirmer, timeoutMs: 50 })
    const res = await gate.wrap(makeWriteTool()).execute({ content: 'x' })
    expect(res.success).toBe(false)
    expect(res.denied).toBe(true)
    expect(res.timeout).toBe(true)
    expect(res.error).toContain('超时')
  })

  it('timeoutDecision 可配 allow_once：低风险工具超时放行', async () => {
    const gate = new ConfirmationGate({ confirmer: neverConfirmer, timeoutMs: 50, timeoutDecision: 'allow_once' })
    const res = await gate.wrap(makeWriteTool()).execute({ content: 'x' })
    expect(res.success).toBe(true)
    expect(res.timeout).toBeUndefined()
  })

  it('confirmer 抛错 → 按 deny 处理（安全默认）', async () => {
    const gate = new ConfirmationGate({
      confirmer: () => { throw new Error('弹窗坏了') },
      timeoutMs: 200,
    })
    const res = await gate.wrap(makeWriteTool()).execute({ content: 'x' })
    expect(res.success).toBe(false)
    expect(res.denied).toBe(true)
    expect(res.timeout).toBeUndefined()
  })

  it('withConfirmation 三参 options 生效（委托 gate，超时 deny）', async () => {
    const tool = withConfirmation(makeWriteTool(), neverConfirmer, { timeoutMs: 50 })
    const res = await tool.execute({ content: 'x' })
    expect(res.success).toBe(false)
    expect(res.denied).toBe(true)
    expect(res.timeout).toBe(true)
  })
})

describe('ConfirmationGate + MemoryStore 集成（settings 表持久化）', () => {
  let tempDir: string
  let store: MemoryStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flare-confirm-'))
    store = new MemoryStore(join(tempDir, 'test.db'))
  })

  afterEach(() => {
    store.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('always 决策写入 settings 表，重启后（新实例同库）仍放行', async () => {
    const gate1 = new ConfirmationGate({ confirmer: () => 'always', store: memoryStoreKv(store) })
    await gate1.wrap(makeWriteTool()).execute({ content: 'a' })
    expect(store.getSetting('confirm.always.write_something')).toBe('1')

    // 模拟重启：同一 MemoryStore 新 gate
    const gate2 = new ConfirmationGate({ confirmer: () => 'deny', store: memoryStoreKv(store) })
    const res = await gate2.wrap(makeWriteTool()).execute({ content: 'b' })
    expect(res.success).toBe(true)

    // revoke 同步清空 settings
    gate2.revoke('write_something')
    expect(store.getSetting('confirm.always.write_something')).toBeNull()
    const gate3 = new ConfirmationGate({ confirmer: () => 'deny', store: memoryStoreKv(store) })
    const res3 = await gate3.wrap(makeWriteTool()).execute({ content: 'c' })
    expect(res3.denied).toBe(true)
  })
})
