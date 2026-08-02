/**
 * Flare 写作工具集（StorySpire 集成）
 *
 * 写作域工具的标准定义：章节读取/创建/更新、故事结构查询。
 * 数据对接由宿主应用（StorySpire）注入 executor（同 Pulse 的 pulse_* 模式）：
 *   主进程定义工具 → 宿主注入执行器 → 经 IPC 操作宿主真实 stores。
 *
 * flare 侧只提供 schema（storyToolDefinitions）和占位执行器（storyTools），
 * 宿主应用 import 后替换 executor 即可。
 */

import { ToolDefinition } from '../core/llm.js'
import type { Tool } from './index.js'

/** 写作工具标准定义（schema，宿主应用可直接复制/引用） */
export const storyToolDefinitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'story_get_story',
      description: '获取当前故事的整体结构：标题、作者、卷、章节列表（含各章标题/字数）。写作前先了解故事背景与进度。无参数。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'story_get_chapter',
      description: '获取某个章节的完整内容（标题 + 正文）。需要 chapterId。用于续写、润色、分析某章。',
      parameters: {
        type: 'object',
        properties: { chapterId: { type: 'string', description: '章节 ID' } },
        required: ['chapterId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'story_list_chapters',
      description: '列出当前故事所有章节（标题/字数/所属卷）。查看写作进度时用。无参数。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'story_create_chapter',
      description: '创建新章节（AI 起草）。可指定标题；若给 content 则直接写入正文。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '章节标题' },
          content: { type: 'string', description: '可选：章节正文（AI 起草完成后写入）' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'story_update_chapter',
      description: '更新章节正文（润色、续写、修改后写回）。需要 chapterId 和 content。这是把 AI 生成内容写入故事的关键工具。',
      parameters: {
        type: 'object',
        properties: {
          chapterId: { type: 'string', description: '章节 ID' },
          content: { type: 'string', description: '新的章节正文（完整替换）' },
        },
        required: ['chapterId', 'content'],
      },
    },
  },
]

/** 占位执行器：宿主应用必须替换 executor（见 docs/storyspire-integration.md） */
export const storyTools: Tool[] = storyToolDefinitions.map(def => ({
  definition: def,
  execute: () => ({
    success: false,
    output: '',
    error: 'story 工具执行器未注入：请在宿主应用（StorySpire）主进程中用真实 stores 执行器替换（参考 docs/storyspire-integration.md）',
  }),
}))

/** 便捷：获取写作工具定义（供 LLM function calling） */
export function getStoryToolDefinitions(): ToolDefinition[] {
  return storyToolDefinitions
}
