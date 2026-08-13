/**
 * CLI /memory 命令测试（v0.6.25 增强：带关键词全文搜索记忆）
 *
 * handleSlashCommand 是纯逻辑（store + output 注入），不依赖 TTY：
 * 验证 /memory 列出全部、/memory <关键词> FTS 搜索命中/未命中、/help 注册。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/memory/store.js'
import { handleSlashCommand } from '../src/cli/index.js'

let store: MemoryStore
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-memory-cmd-test-'))
  store = new MemoryStore(join(dir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('/memory 命令', () => {
  it('/memory → 列出全部记忆', async () => {
    store.saveMemory('用户喜欢浅色主题', 'preference')
    store.saveMemory('flare 支持 MCP 协议', 'note')
    const lines: string[] = []
    const r = await handleSlashCommand('/memory', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    const out = lines.join('\n')
    expect(out).toContain('记忆列表')
    expect(out).toContain('用户喜欢浅色主题')
    expect(out).toContain('flare 支持 MCP 协议')
  })

  it('/memory <关键词> → 全文搜索记忆（FTS 命中相关，不相关不出现）', async () => {
    store.saveMemory('用户喜欢浅色主题', 'preference')
    store.saveMemory('flare 支持 MCP 协议', 'note')
    store.saveMemory('今天天气不错', 'note')
    const lines: string[] = []
    const r = await handleSlashCommand('/memory 浅色主题', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    const out = lines.join('\n')
    expect(out).toContain('记忆「浅色主题」相关')
    expect(out).toContain('用户喜欢浅色主题')
    expect(out).not.toContain('flare 支持 MCP 协议')
    expect(out).not.toContain('今天天气不错')
  })

  it('/memory 无关键词且无记忆 → 「暂无记忆」', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/memory', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('暂无记忆')
  })

  it('/memory <关键词> 无结果 → 友好提示「未找到」', async () => {
    store.saveMemory('用户喜欢浅色主题', 'preference')
    const lines: string[] = []
    const r = await handleSlashCommand('/memory 绝不存在的词xyz', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('未找到包含「绝不存在的词xyz」')
  })

  it('/help 包含 /memory 说明', async () => {
    const lines: string[] = []
    await handleSlashCommand('/help', store, (s) => lines.push(s))
    expect(lines.join('\n')).toContain('/memory')
  })

  it('/memory similar → 检测近似记忆对（文本显示 id 对与相似度）', async () => {
    store.saveMemory('用户偏好浅色主题', 'preference')
    store.saveMemory('用户偏好浅色主题，还喜欢极简风', 'preference')
    store.saveMemory('香蕉营养价值很高', 'note')
    const lines: string[] = []
    const r = await handleSlashCommand('/memory similar', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    const out = lines.join('\n')
    expect(out).toContain('相似记忆（')
    expect(out).toContain('#1 ↔ #2')
    expect(out).toContain('相似度 0.46')
    expect(out).toContain('用户偏好浅色主题')
    expect(out).not.toContain('香蕉营养价值很高')
    // 提示删除入口
    expect(out).toContain('/forget')
  })

  it('/memory --similar 等价（别名）', async () => {
    store.saveMemory('用户偏好浅色主题', 'note')
    store.saveMemory('用户偏好浅色主题，还喜欢极简风', 'note')
    const lines: string[] = []
    const r = await handleSlashCommand('/memory --similar', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('相似记忆（')
  })

  it('/memory similar 无相似对 → 「未发现相似记忆」', async () => {
    store.saveMemory('苹果的营养价值', 'note')
    store.saveMemory('香蕉的种植技巧', 'note')
    const lines: string[] = []
    const r = await handleSlashCommand('/memory similar', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('未发现相似记忆')
  })

  it('/memory similar 空库 → 「未发现相似记忆」', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/memory similar', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('未发现相似记忆')
  })

  it('/memory similar <阈值> 带阈值 → 输出显示该阈值（v0.6.125）', async () => {
    store.saveMemory('用户偏好浅色主题', 'preference')
    store.saveMemory('用户偏好浅色主题，还喜欢极简风', 'preference')
    const lines: string[] = []
    const r = await handleSlashCommand('/memory similar 0.3', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    const out = lines.join('\n')
    expect(out).toContain('相似记忆（')
    expect(out).toContain('阈值 0.3')
  })

  it('/memory similar 0.9（高阈值）→ 近似对不过滤（未发现）', async () => {
    store.saveMemory('用户偏好浅色主题', 'preference')
    store.saveMemory('用户偏好浅色主题，还喜欢极简风', 'preference')
    const lines: string[] = []
    const r = await handleSlashCommand('/memory similar 0.9', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    const out = lines.join('\n')
    expect(out).toContain('阈值 0.9')
    expect(out).toContain('未发现相似记忆')
  })

  it('/memory similar 非法阈值 → 用法提示不崩溃', async () => {
    store.saveMemory('用户偏好浅色主题', 'preference')
    const lines: string[] = []
    const r = await handleSlashCommand('/memory similar abc', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('用法: /memory similar')
  })

  it('/memory similar 越界阈值（1.5）→ 用法提示不崩溃', async () => {
    store.saveMemory('用户偏好浅色主题', 'preference')
    const lines: string[] = []
    const r = await handleSlashCommand('/memory similar 1.5', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('用法: /memory similar')
  })

  it('/memory --similar 0.3（别名 + 阈值）等价', async () => {
    store.saveMemory('用户偏好浅色主题', 'preference')
    store.saveMemory('用户偏好浅色主题，还喜欢极简风', 'preference')
    const lines: string[] = []
    const r = await handleSlashCommand('/memory --similar 0.3', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('阈值 0.3')
  })

  it('/help 包含 /memory similar 说明（v0.6.123）', async () => {
    const lines: string[] = []
    await handleSlashCommand('/help', store, (s) => lines.push(s))
    expect(lines.join('\n')).toContain('/memory similar')
  })
})
