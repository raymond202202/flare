/**
 * Flare 记忆系统
 * 
 * SQLite 存储，支持会话管理和 FTS5 全文搜索。
 * 参考：Hermes 的 SQLite + FTS5 设计
 */

import Database from 'better-sqlite3'
import { join } from 'path'
import { existsSync } from 'fs'
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

export class MemoryStore {
  private db: Database.Database

  constructor(dbPath?: string) {
    const path = dbPath || DB_PATH
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

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='id'
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session 
        ON messages(session_id, created_at);
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
      message.content || '',
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
      content: r.content || '',
      ...(r.tool_call_id ? { tool_call_id: r.tool_call_id } : {}),
      ...(r.name ? { name: r.name } : {}),
      ...(r.tool_calls ? { tool_calls: JSON.parse(r.tool_calls) } : {}),
    }))
  }

  /** 获取最近会话 */
  getRecentSessions(limit = 10): SessionRow[] {
    return this.db.prepare(
      'SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?'
    ).all(limit) as SessionRow[]
  }

  /** 保存持久记忆 */
  saveMemory(content: string, type = 'note') {
    this.db.prepare(
      'INSERT INTO memories (content, type) VALUES (?, ?)'
    ).run(content, type)
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
