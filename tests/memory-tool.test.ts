/**
 * 记忆检索工具 memory_search 测试（RAG，v0.5.1）
 * 覆盖：记忆检索 / 消息检索 / scope 过滤 / 参数校验 / 宿主绑定独立库
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryStore } from '../src/memory/store.js'
import { createMemorySearchTool, memorySearchTool, createMemorySaveTool, memorySaveTool } from '../src/tools/memory.js'
import { tools, getToolDefinitions } from '../src/tools/index.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let tempDir: string
let store: MemoryStore

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'flare-memtool-'))
  store = new MemoryStore(join(tempDir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('memory_search 工具（createMemorySearchTool）', () => {
  it('检索持久记忆（memories）', async () => {
    store.saveMemory('用户喜欢浅色主题，偏好深色模式', 'preference')
    const tool = createMemorySearchTool(store)

    const res = await tool.execute({ query: '浅色主题', scope: 'memories' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('【持久记忆】')
    expect(res.output).toContain('浅色主题')
  })

  it('检索历史消息（messages）', async () => {
    const sid = store.createSession('工具测试')
    store.saveMessage(sid, { role: 'user', content: '帮我调试 flutter 网络请求超时问题' })
    const tool = createMemorySearchTool(store)

    const res = await tool.execute({ query: '网络请求超时', scope: 'messages' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('【历史消息】')
    expect(res.output).toContain('网络请求超时')
  })

  it('both 范围同时检索记忆和消息', async () => {
    store.saveMemory('用户喜欢浅色主题', 'preference')
    const sid = store.createSession('工具测试2')
    store.saveMessage(sid, { role: 'user', content: '浅色主题的设计讨论' })
    const tool = createMemorySearchTool(store)

    const res = await tool.execute({ query: '浅色主题' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('【持久记忆】')
    expect(res.output).toContain('【历史消息】')
  })

  it('无结果时返回友好提示（success 仍为 true）', async () => {
    store.saveMemory('无关记忆', 'note')
    const tool = createMemorySearchTool(store)

    const res = await tool.execute({ query: '完全不存在的内容', scope: 'memories' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('未找到')
  })

  it('缺少 query 返回错误', async () => {
    const tool = createMemorySearchTool(store)
    const res = await tool.execute({})
    expect(res.success).toBe(false)
    expect(res.error).toContain('query')
  })

  it('limit 生效', async () => {
    for (let i = 0; i < 8; i++) {
      store.saveMemory(`第 ${i} 条记忆：关于苹果的讨论`, 'note')
    }
    const tool = createMemorySearchTool(store)
    const res = await tool.execute({ query: '关于苹果', scope: 'memories', limit: 3 })
    expect(res.success).toBe(true)
    // 输出包含"3 条"
    expect(res.output).toContain('3 条')
  })
})

describe('memory_search 默认工具与内置工具集', () => {
  it('默认工具 schema 名称正确且可执行（未命中不炸）', async () => {
    expect(memorySearchTool.definition.function.name).toBe('memory_search')
    const res = await memorySearchTool.execute({ query: 'zzz_不存在的检索词_zzz', scope: 'memories' })
    expect(res.success).toBe(true)
  })

  it('memory_search 已加入内置工具集', () => {
    const names = getToolDefinitions().map(d => d.function.name)
    expect(names).toContain('memory_search')
    expect(tools.some(t => t.definition.function.name === 'memory_search')).toBe(true)
  })
})

describe('memory_save 工具（createMemorySaveTool，v0.5.4）', () => {
  it('保存记忆到绑定的 store（内容 + 类型落库）', async () => {
    const tool = createMemorySaveTool(store)
    const res = await tool.execute({ content: '用户喜欢深色模式', type: 'preference' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('已保存')

    const mems = store.getAllMemories()
    expect(mems).toHaveLength(1)
    expect(mems[0].content).toBe('用户喜欢深色模式')
    expect(mems[0].type).toBe('preference')
  })

  it('缺少 content 返回错误（不落库）', async () => {
    const tool = createMemorySaveTool(store)
    const res = await tool.execute({})
    expect(res.success).toBe(false)
    expect(res.error).toContain('content')
    expect(store.getAllMemories()).toHaveLength(0)
  })

  it('空白 content 视为缺参（不落库）', async () => {
    const tool = createMemorySaveTool(store)
    const res = await tool.execute({ content: '   ' })
    expect(res.success).toBe(false)
    expect(store.getAllMemories()).toHaveLength(0)
  })

  it('保存后 memory_search 可检索到（记忆生命周期闭环：存 → 搜）', async () => {
    const tool = createMemorySaveTool(store)
    await tool.execute({ content: '网络请求超时的排查结论：先查代理', type: 'conclusion' })

    const search = createMemorySearchTool(store)
    const res = await search.execute({ query: '排查结论', scope: 'memories' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('排查结论')
  })
})

describe('memory_save 默认工具与内置工具集（v0.5.4）', () => {
  it('默认工具 schema 名称正确（不执行，避免写真实全局库）', () => {
    expect(memorySaveTool.definition.function.name).toBe('memory_save')
    expect(memorySaveTool.definition.function.description).toContain('记住')
  })

  it('memory_save 已加入内置工具集', () => {
    const names = getToolDefinitions().map(d => d.function.name)
    expect(names).toContain('memory_save')
    expect(tools.some(t => t.definition.function.name === 'memory_save')).toBe(true)
  })
})
