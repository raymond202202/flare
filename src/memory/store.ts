/**
 * Flare 记忆系统
 * 
 * SQLite 存储，支持会话管理和 FTS5 全文搜索。
 * 参考：Hermes 的 SQLite + FTS5 设计
 */

import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { config } from '../core/config.js'
import { Message } from '../core/llm.js'

const DB_PATH = join(config.flareHome, 'flare.db')

interface SessionRow {
  id: string
  title: string
  created_at: string
  updated_at: string
}

interface MemoryRow {
  id: number
  content: string
  type: string
  created_at: string
}

/**
 * content 序列化：多模态数组（含图片）存 JSON，纯文本原样
 * 图片 part 用占位符替代——不把 base64 图片数据落库（防止 SQLite 膨胀、FTS 污染）
 */
export function serializeContent(content: Message['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content || '')
  const parts = content.map(p => {
    if (p && p.type === 'text') return p.text
    return '[图片]'
  })
  return JSON.stringify({ type: 'multimodal', parts })
}

/** content 反序列化：多模态 JSON → 拼接文本（图片已占位）；老数据字符串原样 */
export function deserializeContent(raw: string): Message['content'] {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.type === 'multimodal' && Array.isArray(parsed.parts)) {
      return parsed.parts.join('')
    }
    return raw
  } catch {
    return raw
  }
}

export class MemoryStore {
  private db: Database.Database

  constructor(dbPath?: string) {
    const path = dbPath || DB_PATH
    // 自动创建父目录（better-sqlite3 不会自动建目录；支持任意外部路径如 ~/.pulse/pulse-ai.db）
    try {
      const dir = dirname(path)
      if (dir && dir !== '.') mkdirSync(dir, { recursive: true })
    } catch { /* 目录创建失败不阻塞（DB 打开时会报错） */ }
    const isNew = !existsSync(path)
    this.db = new Database(path)
    
    // 总是执行建表 + 迁移（CREATE TABLE IF NOT EXISTS 是幂等的，
    // migrate() 会为老库补充缺失的列）
    this.init()
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT DEFAULT '新会话',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        name TEXT,
        tool_calls TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'note',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='id'
      );

      -- FTS 同步触发器：messages 表 INSERT/DELETE 时同步索引
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE INDEX IF NOT EXISTS idx_messages_session 
        ON messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `)

    // 老库迁移：检查是否有 tool_call_id / name 列
    this.migrate()
  }

  /** 老版本数据库迁移：补充缺失的列 */
  private migrate() {
    const cols = this.db.prepare('PRAGMA table_info(messages)').all() as any[]
    const colNames = cols.map(c => c.name)
    if (!colNames.includes('tool_call_id')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN tool_call_id TEXT')
    }
    if (!colNames.includes('name')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN name TEXT')
    }
  }

  /** 创建新会话 */
  createSession(title?: string): string {
    const id = `flare_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const stmt = this.db.prepare(
      'INSERT INTO sessions (id, title) VALUES (?, ?)'
    )
    stmt.run(id, title || '新会话')
    return id
  }

  /** 保存消息到会话 */
  saveMessage(sessionId: string, message: Message) {
    const stmt = this.db.prepare(
      'INSERT INTO messages (session_id, role, content, tool_call_id, name, tool_calls) VALUES (?, ?, ?, ?, ?, ?)'
    )
    stmt.run(
      sessionId,
      message.role,
      serializeContent(message.content),
      message.tool_call_id || null,
      message.name || null,
      message.tool_calls ? JSON.stringify(message.tool_calls) : null
    )

    // 更新会话时间
    this.db.prepare(
      'UPDATE sessions SET updated_at = datetime(\'now\') WHERE id = ?'
    ).run(sessionId)
  }

  /** 获取会话消息历史 */
  getMessages(sessionId: string, limit = 50): Message[] {
    const rows = this.db.prepare(
      'SELECT role, content, tool_call_id, name, tool_calls FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
    ).all(sessionId, limit) as any[]

    return rows.map(r => ({
      role: r.role as Message['role'],
      content: deserializeContent(r.content || ''),
      ...(r.tool_call_id ? { tool_call_id: r.tool_call_id } : {}),
      ...(r.name ? { name: r.name } : {}),
      ...(r.tool_calls ? { tool_calls: JSON.parse(r.tool_calls) } : {}),
    }))
  }

  /** 获取最近会话 */
  getRecentSessions(limit = 10): SessionRow[] {
    // 为每个会话取第一条 user 消息作为标题（人类可读，用于区分会话）
    return this.db.prepare(
      `SELECT s.id, s.title, s.updated_at,
        (SELECT content FROM messages m
         WHERE m.session_id = s.id AND m.role = 'user'
         ORDER BY m.id LIMIT 1) as first_user_msg
       FROM sessions s
       ORDER BY s.updated_at DESC LIMIT ?`
    ).all(limit) as SessionRow[]
  }

  /** 保存持久记忆 */
  saveMemory(content: string, type = 'note') {
    this.db.prepare(
      'INSERT INTO memories (content, type) VALUES (?, ?)'
    ).run(content, type)
  }

  /** 记录一次 LLM 调用的 token 用量 */
  logUsage(sessionId: string | null, promptTokens: number, completionTokens: number, model?: string) {
    this.db.prepare(
      'INSERT INTO usage_log (session_id, prompt_tokens, completion_tokens, model) VALUES (?, ?, ?, ?)'
    ).run(sessionId, promptTokens, completionTokens, model || null)
  }

  /** 汇总 token 用量 */
  getUsageStats() {
    const row = this.db.prepare(
      `SELECT
         COALESCE(SUM(prompt_tokens), 0) as promptTokens,
         COALESCE(SUM(completion_tokens), 0) as completionTokens,
         COUNT(*) as sessionCount
       FROM usage_log`
    ).get() as any
    return {
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.promptTokens + row.completionTokens,
      sessionCount: row.sessionCount,
    }
  }

  /** 获取相关记忆 */
  getRelevantMemories(query: string, limit = 5): MemoryRow[] {
    try {
      return this.db.prepare(
        `SELECT * FROM memories WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?`
      ).all(`%${query}%`, limit) as MemoryRow[]
    } catch {
      return []
    }
  }

  /** 获取所有记忆 */
  getAllMemories(): MemoryRow[] {
    return this.db.prepare(
      'SELECT * FROM memories ORDER BY created_at DESC'
    ).all() as MemoryRow[]
  }

  /** 读取运行时设置（key-value，如看图模型切换） */
  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
    return row ? row.value : null
  }

  /** 写入运行时设置；value 为空串表示删除（回默认） */
  setSetting(key: string, value: string) {
    if (!value) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
      return
    }
    this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).run(key, value)
  }

  close() {
    this.db.close()
  }
}

// 单例
let _store: MemoryStore | null = null

export function getMemoryStore(): MemoryStore {
  if (!_store) {
    _store = new MemoryStore()
  }
  return _store
}
