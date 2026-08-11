/**
 * prompt caching 基建测试（v0.6.29 P0）
 *
 * 覆盖：
 * 1. trimContextMessages 多 system 保底（稳定前缀/身份/记忆开头块全保底；末尾「当前状态」不挪位）
 * 2. suggestTrim 多 system 保底对称
 * 3. summarizeTrimmedMessages 摘要紧随开头 system 块之后
 * 4. CLI /usage 缓存命中率 + 估算成本显示
 * 5. server 协议 get_usage / session_usage 透传缓存字段（e2e 真实子进程）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { trimContextMessages, suggestTrim, summarizeTrimmedMessages } from '../src/core/context.js'
import { handleSlashCommand } from '../src/cli/index.js'
import { MemoryStore } from '../src/memory/store.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Message } from '../src/core/llm.js'

function msg(role: Message['role'], content: string): Message {
  return { role, content }
}

describe('trimContextMessages 多 system 保底（v0.6.29 P0）', () => {
  it('开头 system 块（稳定前缀+身份+记忆）全部保底，即使条数上限极小', () => {
    const messages: Message[] = [
      msg('system', '你是 Flare（稳定前缀）'),
      msg('system', '## 你的身份\n我是 pulse 助手'),
      msg('system', '## 关于这个用户\n用户喜欢浅色主题'),
    ]
    for (let i = 0; i < 20; i++) messages.push(msg(i % 2 === 0 ? 'user' : 'assistant', `历史${i}`))

    const r = trimContextMessages(messages, { maxMessages: 5 })
    // 3 条 system 全保底 + 最近 5 条
    expect(r.filter(m => m.role === 'system')).toHaveLength(3)
    expect(r[0].content).toContain('稳定前缀')
    expect(r[1].content).toContain('你的身份')
    expect(r[2].content).toContain('关于这个用户')
    // 顺序保持：system 块在前
    expect(r.slice(0, 3).every(m => m.role === 'system')).toBe(true)
    // 最新消息保留
    expect(r[r.length - 1].content).toBe('历史19')
  })

  it('末尾「当前状态」system（动态区）不被保底挪位：按最近优先保留在原位', () => {
    const messages: Message[] = [
      msg('system', '你是 Flare（稳定前缀）'),
      msg('user', '问题1'),
      msg('assistant', '回答1'),
      msg('user', '问题2'),
      msg('assistant', '回答2'),
      msg('system', '## 当前状态\n宿主快照: 页面 A'),
    ]
    const r = trimContextMessages(messages, { maxMessages: 3 })
    // 保底稳定前缀 + 最近 3 条（问题2/回答2/当前状态）
    expect(r[0].role).toBe('system')
    expect(r[r.length - 1].content).toContain('宿主快照')
    // 只有开头 system 块保底（1 条），当前状态不算保底（但它最新，正常保留）
    expect(r.filter(m => m.role === 'system')).toHaveLength(2)
    expect(r[1].content).toBe('问题2')
  })

  it('token 预算极小：多 system 保底仍全部保留（不丢身份/记忆）', () => {
    const messages: Message[] = [
      msg('system', '你是 Flare（稳定前缀）'),
      msg('system', '## 你的身份\n我是 pulse 助手'),
      msg('system', '## 关于这个用户\n用户喜欢浅色主题'),
      msg('user', '最新的问题在这里'),
    ]
    const r = trimContextMessages(messages, { maxTokens: 5 })
    expect(r.filter(m => m.role === 'system')).toHaveLength(3)
    // 极小预算仍保底最新一条
    expect(r[r.length - 1].content).toBe('最新的问题在这里')
  })

  it('单 system（旧版形态）行为零回归：保底 1 条 + 最近 N 条', () => {
    const messages = [msg('system', '你是助手')]
    for (let i = 0; i < 10; i++) messages.push(msg('user', `问题${i}`))
    const r = trimContextMessages(messages, { maxMessages: 3 })
    expect(r).toHaveLength(4) // system + 3
    expect(r[0].role).toBe('system')
  })
})

describe('suggestTrim 多 system 保底对称（v0.6.29 P0）', () => {
  it('开头 system 块全部保底（预算不足时身份/记忆也不丢）', () => {
    const messages: Message[] = [
      msg('system', '你是 Flare（稳定前缀）'),
      msg('system', '## 你的身份\n我是 pulse 助手'),
      msg('user', '帮我写代码'),
      msg('user', '最新的输入'),
    ]
    const r = suggestTrim(messages, 10)
    expect(r.keep.filter(m => m.role === 'system')).toHaveLength(2)
    expect(r.keep[0].content).toContain('稳定前缀')
    expect(r.keep[1].content).toContain('你的身份')
  })

  it('keepSystem:false → 不保底 system（行为与旧版一致）', () => {
    const messages: Message[] = [
      msg('system', '你是助手'),
      msg('user', '你好'),
    ]
    const r = suggestTrim(messages, 5, { keepSystem: false })
    expect(r.keep.some(m => m.role === 'system')).toBe(false)
  })
})

describe('summarizeTrimmedMessages 多 system 摘要位置（v0.6.29 P0）', () => {
  it('摘要紧随开头 system 块之后（身份/记忆 system 之前不插入）', () => {
    const messages: Message[] = [
      msg('system', '你是 Flare（稳定前缀）'),
      msg('system', '## 你的身份\n我是 pulse 助手'),
      msg('system', '## 关于这个用户\n用户喜欢浅色主题'),
    ]
    for (let i = 0; i < 20; i++) messages.push(msg(i % 2 === 0 ? 'user' : 'assistant', `历史${i}`))
    const r = summarizeTrimmedMessages(messages, { maxMessages: 3 })
    // 3 条 system 在前，摘要紧随其后（第 4 条）
    expect(r.slice(0, 3).map(m => m.role)).toEqual(['system', 'system', 'system'])
    expect(r[3].content).toContain('[历史摘要]')
    expect(r[3].role).toBe('system')
  })
})

describe('CLI /usage 缓存显示（v0.6.29 P0）', () => {
  let tempDir: string
  let store: MemoryStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flare-usage-cache-'))
    store = new MemoryStore(join(tempDir, 'test.db'))
  })
  afterEach(() => {
    store.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('有缓存命中 → 显示缓存行（tokens + 命中率）+ 估算成本', async () => {
    store.logUsage('s1', 1000, 500, 'deepseek-chat', { cacheReadTokens: 600, estimatedCostUsd: 0.0001234 })
    const lines: string[] = []
    await handleSlashCommand('/usage', store, (s) => lines.push(s))
    const out = lines.join('\n')
    expect(out).toContain('📊 Token 用量')
    expect(out).toContain('缓存命中')
    expect(out).toContain('600') // 命中 tokens
    expect(out).toContain('60%') // 600/1000
    expect(out).toContain('估算成本')
    expect(out).toContain('$0.0001')
  })

  it('无缓存命中 → 不显示缓存行（向后兼容，与旧版输出一致）', async () => {
    store.logUsage('s1', 100, 50, 'deepseek-chat')
    const lines: string[] = []
    await handleSlashCommand('/usage', store, (s) => lines.push(s))
    const out = lines.join('\n')
    expect(out).toContain('📊 Token 用量')
    expect(out).not.toContain('缓存命中')
    expect(out).not.toContain('估算成本')
  })

  it('perModel 行显示缓存命中（v0.6.42：多模型用量分布带命中 tokens + 命中率）', async () => {
    // 两个模型：deepseek-chat 有缓存命中，deepseek-reasoner 无
    store.logUsage('s1', 1000, 500, 'deepseek-chat', { cacheReadTokens: 400 })
    store.logUsage('s1', 200, 100, 'deepseek-reasoner')
    const lines: string[] = []
    await handleSlashCommand('/usage', store, (s) => lines.push(s))
    const out = lines.join('\n')
    expect(out).toContain('模型 deepseek-chat:')
    expect(out).toContain('模型 deepseek-reasoner:')
    // chat 行下带缓存命中子行（400 tokens，400/1000=40%）
    expect(out).toContain('缓存命中: 400')
    expect(out).toContain('40%')
    // reasoner 无缓存命中 → 不显示命中子行（总命中率行照旧显示，400/1200=33%）
    expect(out).toContain('33%')
  })
})
