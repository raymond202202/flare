/**
 * Flare 记忆检索工具（RAG，v0.5.1）
 *
 * memory_search：让 AI 主动检索持久记忆（memories）和历史消息（messages）。
 * 中文友好：trigram FTS 全文检索 + bm25 相关度排序（<3 字 LIKE 回退）。
 *
 * 用法：
 * - 默认 memorySearchTool：检索全局库（~/.flare/flare.db）——CLI 等默认场景
 * - createMemorySearchTool(store)：绑定指定 MemoryStore（宿主应用如 Pulse/StorySpire
 *   用它检索自己的独立库，如 ~/.pulse/pulse-ai.db）
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
            parts.push(`【持久记忆】${mems.length} 条：\n` + mems.map(m => `- ${m.content}`).join('\n'))
          }
        } catch (e: any) {
          parts.push(`【持久记忆】检索失败: ${e?.message || e}`)
        }
      }
      if (scope === 'messages' || scope === 'both') {
        try {
          const msgs = activeStore.searchMessages(q, max)
          if (msgs.length > 0) {
            parts.push(`【历史消息】${msgs.length} 条：\n` + msgs.map(m => `- [${m.createdAt || ''} ${m.role === 'user' ? '用户' : '助手'}] ${m.content.slice(0, 200)}`).join('\n'))
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
