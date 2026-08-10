/**
 * CLI /search 命令测试（v0.6.24）
 *
 * handleSlashCommand 是纯逻辑（store + output 注入），不依赖 TTY：
 * 验证跨会话全文搜索历史对话（FTS5 trigram）、无关键词用法提示、空结果提示。
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
  dir = mkdtempSync(join(tmpdir(), 'flare-search-test-'))
  store = new MemoryStore(join(dir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('/search 命令', () => {
  it('/search <关键词> → 列出匹配消息（跨会话，含角色与内容截断）', async () => {
    // 两个会话各写一条，验证跨会话检索
    store.saveMessage('s-a', { role: 'user', content: 'flare 引擎的网络请求超时了怎么办' } as any)
    store.saveMessage('s-b', { role: 'assistant', content: '已自动重试成功，不用管' } as any)
    const lines: string[] = []
    const r = await handleSlashCommand('/search 网络请求超时', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    const out = lines.join('\n')
    expect(out).toContain('「网络请求超时」相关消息')
    expect(out).toContain('flare 引擎的网络请求超时了怎么办')
    // 不相关内容不出现
    expect(out).not.toContain('已自动重试成功')
  })

  it('/search 无关键词 → 用法提示，不报错', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/search', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('用法: /search <关键词>')
  })

  it('/search 无结果 → 友好提示「未找到」', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/search 绝不存在的词xyz', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('未找到包含「绝不存在的词xyz」')
  })

  it('/help 包含 /search 说明', async () => {
    const lines: string[] = []
    await handleSlashCommand('/help', store, (s) => lines.push(s))
    expect(lines.join('\n')).toContain('/search')
  })
})
