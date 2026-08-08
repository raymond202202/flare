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

describe('MemoryStore 记忆检索增强（RAG, v0.5.1）', () => {
  it('searchMemories：trigram FTS 命中中文 3 字以上子串（bm25 排序）', () => {
    store.saveMemory('用户喜欢浅色主题，偏好深色模式', 'preference')
    store.saveMemory('flutter 是一个神奇的框架，用于跨平台开发', 'note')
    store.saveMemory('用户是 flare 引擎项目负责人', 'note')

    const hits = store.searchMemories('神奇的框架')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].content).toContain('神奇的框架')
  })

  it('searchMemories：FTS 结果按相关度排序（精确命中优先于部分命中）', () => {
    store.saveMemory('用户喜欢浅色主题', 'preference')
    store.saveMemory('浅色主题的护眼设置建议', 'note')
    store.saveMemory('今天天气不错', 'note')

    const hits = store.searchMemories('浅色主题')
    expect(hits.length).toBeGreaterThanOrEqual(2)
    // 第一个命中应该包含完整查询词（bm25 相关度更高）
    expect(hits[0].content).toContain('浅色主题')
  })

  it('searchMemories：2 字中文查询 LIKE 回退（trigram 需 3 字符）', () => {
    store.saveMemory('用户喜欢浅色主题', 'preference')
    store.saveMemory('flutter 框架', 'note')

    const hits = store.searchMemories('主题')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].content).toContain('主题')
  })

  it('searchMemories：FTS 无结果时 LIKE 兜底', () => {
    store.saveMemory('今天天气不错，适合出门散步', 'note')

    // FTS 命中不到（查询词在 trigram 索引外或特殊字符），LIKE 兜底
    const hits = store.searchMemories('天气')
    expect(hits.length).toBeGreaterThan(0)
  })

  it('searchMemories：空查询返回空', () => {
    store.saveMemory('任意记忆内容', 'note')
    expect(store.searchMemories('')).toEqual([])
    expect(store.searchMemories('   ')).toEqual([])
  })

  it('memories_fts 触发器：插入即入索引，删除即出索引', () => {
    const sid = store.createSession('fts-trigger')
    store.saveMessage(sid, { role: 'user', content: '占位消息' })
    store.saveMemory('触发器测试：龙族设定', 'note')
    expect(store.searchMemories('龙族设定').length).toBeGreaterThan(0)

    // 删除记忆 → FTS 同步删除
    const memId = (store.getAllMemories().find(m => m.content.includes('龙族设定')) as any).id
    store['db'].prepare('DELETE FROM memories WHERE id = ?').run(memId)
    expect(store.searchMemories('龙族设定').length).toBe(0)
  })

  it('老库回填：先有 memories 数据再建 FTS 也能检索', () => {
    // 模拟老库：直接建 memories 表（不带 FTS）+ 插入数据，然后重建 store
    store['db'].exec('DROP TABLE IF EXISTS memories_fts')
    store['db'].exec('DROP TRIGGER IF EXISTS memories_ai')
    store['db'].exec('DROP TRIGGER IF EXISTS memories_ad')
    store['db'].exec('DROP TRIGGER IF EXISTS memories_au')
    store['db'].prepare('INSERT INTO memories (content) VALUES (?)').run('回填测试：旧记忆数据')

    store.close()
    store = new MemoryStore(join(tempDir, 'test.db'))

    // 新库 init 时 FTS 建表 + 回填，老数据可检索
    const hits = store.searchMemories('回填测试')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].content).toContain('回填测试')
  })

  it('searchMessages：trigram FTS 检索历史消息（中文 3 字以上）', () => {
    const sid = store.createSession('消息检索')
    store.saveMessage(sid, { role: 'user', content: '帮我调试 flutter 网络请求超时问题' })
    store.saveMessage(sid, { role: 'assistant', content: '好的，先看下请求配置和超时设置' })

    const hits = store.searchMessages('网络请求超时')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].content).toContain('网络请求超时')
    expect(hits[0].sessionId).toBe(sid)
    expect(hits[0].role).toBe('user')
  })

  it('searchMessages：2 字查询 LIKE 回退', () => {
    const sid = store.createSession('消息检索2')
    store.saveMessage(sid, { role: 'user', content: '今天讨论浅色主题设计' })

    const hits = store.searchMessages('主题')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].content).toContain('主题')
  })

  it('searchMessages：空查询返回空', () => {
    const sid = store.createSession('消息检索3')
    store.saveMessage(sid, { role: 'user', content: '内容' })
    expect(store.searchMessages('')).toEqual([])
  })

  it('searchMessages：消息触发器同步（插入即入 trigram 索引）', () => {
    const sid = store.createSession('消息触发器')
    store.saveMessage(sid, { role: 'user', content: '龙族故事设定：主角叫林澈' })

    const hits = store.searchMessages('龙族故事')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].content).toContain('林澈')
  })
})

describe('MemoryStore.deleteSession', () => {
  it('删除会话：消息 / 用量记录一并清除，FTS 索引联动清理', () => {
    const sid = store.createSession('待删除会话')
    store.saveMessage(sid, { role: 'user', content: '龙族故事设定：主角叫林澈' })
    store.saveMessage(sid, { role: 'assistant', content: '好，记住了' })
    store.logUsage(sid, 10, 20, 'deepseek-chat')

    // 删除前 FTS 可命中
    expect(store.searchMessages('龙族故事').length).toBeGreaterThan(0)
    expect(store.getUsageStats().sessionCount).toBe(1)

    const ok = store.deleteSession(sid)
    expect(ok).toBe(true)

    // 会话记录 / 消息 / 用量全部清除
    expect(store.getAllSessions().some(s => s.id === sid)).toBe(false)
    expect(store.getMessages(sid)).toEqual([])
    expect(store.getUsageStats().sessionCount).toBe(0)
    // FTS 触发器已联动清索引，不再命中已删消息
    expect(store.searchMessages('龙族故事').some(h => h.sessionId === sid)).toBe(false)
  })

  it('删除不存在的会话返回 false（幂等，不抛错）', () => {
    expect(store.deleteSession('no_such_session')).toBe(false)
  })

  it('删除一个会话不影响其他会话', () => {
    const keep = store.createSession('保留会话')
    store.saveMessage(keep, { role: 'user', content: '天气怎么样' })
    const drop = store.createSession('丢弃会话')
    store.saveMessage(drop, { role: 'user', content: '待删除内容' })

    expect(store.deleteSession(drop)).toBe(true)

    const sessions = store.getAllSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe(keep)
    expect(store.getMessages(keep)).toHaveLength(1)
    expect(store.searchMessages('待删除内容')).toEqual([])
  })
})

describe('MemoryStore 记忆删除（v0.5.4）', () => {
  it('deleteMemory：按 id 删除单条，FTS 索引联动清理（searchMemories 不再命中）', () => {
    store.saveMemory('用户喜欢浅色主题', 'preference')
    const rows = store.searchMemories('浅色主题')
    expect(rows.length).toBeGreaterThan(0)
    const id = rows[0].id

    expect(store.deleteMemory(id)).toBe(true)
    expect(store.getAllMemories()).toHaveLength(0)
    expect(store.searchMemories('浅色主题')).toEqual([])
  })

  it('deleteMemory：不存在的 id 返回 false（幂等，不抛错）', () => {
    expect(store.deleteMemory(99999)).toBe(false)
  })

  it('deleteMemory：删除一条不影响其他记忆', () => {
    store.saveMemory('要删除的记忆内容', 'note')
    store.saveMemory('保留的记忆内容', 'note')

    const rows = store.searchMemories('要删除的')
    expect(store.deleteMemory(rows[0].id)).toBe(true)

    const rest = store.getAllMemories()
    expect(rest).toHaveLength(1)
    expect(rest[0].content).toBe('保留的记忆内容')
  })

  it('deleteMemoriesByContent：按关键词批量删除，返回条数', () => {
    store.saveMemory('关于苹果的讨论', 'note')
    store.saveMemory('苹果种植技巧', 'note')
    store.saveMemory('香蕉的营养价值', 'note')

    const n = store.deleteMemoriesByContent('苹果')
    expect(n).toBe(2)
    expect(store.getAllMemories()).toHaveLength(1)
    expect(store.getAllMemories()[0].content).toBe('香蕉的营养价值')
  })

  it('deleteMemoriesByContent：无匹配返回 0；空关键词返回 0（不误删）', () => {
    store.saveMemory('唯一记忆', 'note')
    expect(store.deleteMemoriesByContent('不存在的词')).toBe(0)
    expect(store.deleteMemoriesByContent('')).toBe(0)
    expect(store.deleteMemoriesByContent('  ')).toBe(0)
    expect(store.getAllMemories()).toHaveLength(1)
  })

  it('deleteMemoriesByContent：删除后 searchMemories 不再命中（FTS 索引联动）', () => {
    store.saveMemory('flutter 网络请求超时排查记录', 'note')
    expect(store.searchMemories('网络请求超时').length).toBeGreaterThan(0)

    store.deleteMemoriesByContent('网络请求超时')
    expect(store.searchMemories('网络请求超时')).toEqual([])
  })
})
