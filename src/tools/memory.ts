/**
 * Flare 记忆工具（RAG，v0.5.1；记忆生命周期 v0.5.4）
 *
 * memory_search：让 AI 主动检索持久记忆（memories）和历史消息（messages）。
 * 中文友好：trigram FTS 全文检索 + bm25 相关度排序（<3 字 LIKE 回退）。
 *
 * memory_save：让 AI 在用户明确要求"记住"时真正落库持久记忆。
 *
 * 用法：
 * - 默认 memorySearchTool / memorySaveTool：绑定全局库（~/.flare/flare.db）——CLI 等默认场景
 * - createMemorySearchTool(store) / createMemorySaveTool(store)：绑定指定 MemoryStore
 *   （宿主应用如 Pulse/StorySpire 用它检索/保存自己的独立库，如 ~/.pulse/pulse-ai.db）
 */

import type { Tool } from './index.js'
import type { MemoryStore } from '../memory/store.js'
import { getMemoryStore } from '../memory/store.js'

/** 检索范围 */
export type MemorySearchScope = 'memories' | 'messages' | 'both'

export interface MemorySearchArgs {
  query: string
  scope?: MemorySearchScope
  limit?: number
}

/**
 * 单条结果折叠（v0.6.0）：控制每条输出长度，防止长记忆/长消息撑爆上下文
 * - 超长内容截断到 maxLen 并在尾部加折叠标记（保留开头，信息主体在前）
 * - 空白折叠为单空格（历史消息常有多余换行）
 */
function foldItem(raw: string, maxLen = 150): string {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '…'
}

/**
 * 用指定 store 创建 memory_search 工具（宿主可绑定自己的独立记忆库）
 * store 为 null 时延迟绑定全局库（模块加载不触发单例创建，避免副作用）
 */
export function createMemorySearchTool(store: MemoryStore | null): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'memory_search',
        description: '检索持久记忆和历史对话（全文检索）。当需要回忆用户偏好、之前讨论过的话题、历史任务结论时使用。支持中文。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词（中文 3 字以上效果最佳，如"网络请求超时"）' },
            scope: {
              type: 'string',
              enum: ['memories', 'messages', 'both'],
              description: '检索范围：memories=持久记忆，messages=历史消息，both=两者（默认）',
            },
            limit: { type: 'number', description: '每个范围最多返回条数（默认 5）' },
          },
          required: ['query'],
        },
      },
    },
    execute: async (args: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }> => {
      const { query, scope = 'both', limit } = (args || {}) as MemorySearchArgs
      const q = (query || '').trim()
      if (!q) {
        return { success: false, output: '', error: 'memory_search 需要 query 参数（检索关键词）' }
      }
      const max = Math.min(Math.max(Number(limit) || 5, 1), 20)
      // 延迟绑定：store 为 null 时用全局库（默认工具）
      const activeStore = store || getMemoryStore()

      const parts: string[] = []
      if (scope === 'memories' || scope === 'both') {
        try {
          const mems = activeStore.searchMemories(q, max)
          if (mems.length > 0) {
            parts.push(`【持久记忆】${mems.length} 条：\n` + mems.map(m => `- ${foldItem(m.content)}`).join('\n'))
          }
        } catch (e: any) {
          parts.push(`【持久记忆】检索失败: ${e?.message || e}`)
        }
      }
      if (scope === 'messages' || scope === 'both') {
        try {
          const msgs = activeStore.searchMessages(q, max)
          if (msgs.length > 0) {
            parts.push(`【历史消息】${msgs.length} 条：\n` + msgs.map(m => `- [${m.createdAt || ''} ${m.role === 'user' ? '用户' : '助手'}] ${foldItem(m.content)}`).join('\n'))
          }
        } catch (e: any) {
          parts.push(`【历史消息】检索失败: ${e?.message || e}`)
        }
      }

      if (parts.length === 0) {
        return { success: true, output: `未找到与「${q}」相关的记忆或历史消息。` }
      }
      return { success: true, output: `检索「${q}」结果：\n\n${parts.join('\n\n')}` }
    },
  }
}

/** 默认记忆检索工具（延迟绑定全局库 ~/.flare/flare.db） */
export const memorySearchTool: Tool = createMemorySearchTool(null)

/**
 * 用指定 store 创建 memory_save 工具（宿主可绑定自己的独立记忆库）
 * store 为 null 时延迟绑定全局库（模块加载不触发单例创建，避免副作用）
 *
 * 约束（与系统提示一致）：仅当用户明确要求"记住"某事时保存（如"记住我偏好 X"），
 * 不自作主张记录——记忆是用户主动托付给 AI 的长期事实。
 */
export function createMemorySaveTool(store: MemoryStore | null): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'memory_save',
        description: '保存一条持久记忆（跨会话长期记住）。仅当用户明确要求记住某件事时使用（如"记住我的偏好：…"、"记住这个结论"）；不要自作主张保存无关内容。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '要记住的内容（用户明确要求记住的事实/偏好/结论）' },
            type: { type: 'string', description: '记忆类型（默认 note）' },
          },
          required: ['content'],
        },
      },
    },
    execute: async (args: Record<string, any>): Promise<{ success: boolean; output: string; error?: string }> => {
      const { content, type } = (args || {}) as { content?: string; type?: string }
      const text = (content || '').trim()
      if (!text) {
        return { success: false, output: '', error: 'memory_save 需要 content 参数（要记住的内容）' }
      }
      // 延迟绑定：store 为 null 时用全局库（默认工具）
      const activeStore = store || getMemoryStore()
      activeStore.saveMemory(text, type || 'note')
      return { success: true, output: `已保存持久记忆：${text.slice(0, 80)}` }
    },
  }
}

/** 默认记忆保存工具（延迟绑定全局库 ~/.flare/flare.db） */
export const memorySaveTool: Tool = createMemorySaveTool(null)
