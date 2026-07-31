/**
 * MemoryStore 单元测试
 * 覆盖：CRUD、tool_calls 配对、FTS 触发器、用量记录
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryStore } from '../src/memory/store.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let tempDir: string
let store: MemoryStore

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'flare-test-'))
  store = new MemoryStore(join(tempDir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('MemoryStore', () => {
  it('创建会话并保存/读取消息', () => {
    const sessionId = store.createSession('测试会话')
    expect(sessionId).toBeTruthy()

    store.saveMessage(sessionId, { role: 'user', content: '你好' })
    store.saveMessage(sessionId, { role: 'assistant', content: '你好！有什么可以帮你？' })

    const messages = store.getMessages(sessionId)
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toBe('你好')
    expect(messages[1].role).toBe('assistant')
  })

  it('保存并恢复 tool_call_id 配对', () => {
    const sessionId = store.createSession('工具测试')

    // assistant 带 tool_calls
    store.saveMessage(sessionId, {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_001',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"/tmp/x"}' },
      }],
    })
    // tool 响应带 tool_call_id
    store.saveMessage(sessionId, {
      role: 'tool',
      tool_call_id: 'call_001',
      name: 'read_file',
      content: '文件内容',
    })

    const messages = store.getMessages(sessionId)
    expect(messages).toHaveLength(2)
    expect(messages[0].tool_calls?.[0].id).toBe('call_001')
    expect(messages[1].tool_call_id).toBe('call_001')
    expect(messages[1].name).toBe('read_file')
  })

  it('FTS 触发器同步索引', () => {
    const sessionId = store.createSession('FTS测试')
    store.saveMessage(sessionId, { role: 'user', content: 'flutter 是一个神奇的框架' })

    // 通过 FTS 表查询
    const rows = store['db'].prepare(
      "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'flutter'"
    ).all() as any[]
    expect(rows.length).toBeGreaterThan(0)
  })

  it('记忆 CRUD', () => {
    store.saveMemory('用户喜欢浅色主题', 'preference')
    const memories = store.getAllMemories()
    expect(memories).toHaveLength(1)
    expect(memories[0].content).toBe('用户喜欢浅色主题')

    const relevant = store.getRelevantMemories('浅色')
    expect(relevant.length).toBeGreaterThan(0)
  })

  it('用量记录与汇总', () => {
    store.logUsage('s1', 100, 50, 'deepseek-chat')
    store.logUsage('s1', 200, 80, 'deepseek-chat')
    store.logUsage('s2', 300, 120, 'deepseek-chat')

    const stats = store.getUsageStats()
    expect(stats.promptTokens).toBe(600)
    expect(stats.completionTokens).toBe(250)
    expect(stats.totalTokens).toBe(850)
    expect(stats.sessionCount).toBe(3)
  })

  it('老库迁移：缺少 tool_call_id 列时自动补充', () => {
    // 模拟旧库：先建表不带 tool_call_id
    const oldDb = store['db']
    oldDb.exec('DROP TABLE IF EXISTS messages')
    oldDb.exec(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`)

    // 重新打开（触发 init + migrate）
    store.close()
    store = new MemoryStore(join(tempDir, 'test.db'))

    // 验证列已补充
    const cols = store['db'].prepare('PRAGMA table_info(messages)').all() as any[]
    const colNames = cols.map(c => c.name)
    expect(colNames).toContain('tool_call_id')
    expect(colNames).toContain('name')
  })
})
