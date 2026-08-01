/**
 * Flare 引擎库入口（@flare/core）
 *
 * 导出 Flare 的 Agent 引擎公共 API，供外部应用（如 Pulse / StorySpire）集成：
 *   import { Agent, createProvider, Tool, MemoryStore } from 'flare-agent'
 *
 * CLI 是第一个消费者（src/cli/index.ts 从这里 import）。
 */

// ===== Agent 引擎 =====
export { Agent, type AgentConfig } from './core/agent.js'

// ===== LLM 抽象 =====
export {
  createProvider,
  OpenAIProvider,
  type LLMProvider,
  type LLMResponse,
  type Message,
  type MessageRole,
  type ToolCall,
  type ToolDefinition,
} from './core/llm.js'

// ===== 工具基座 =====
export {
  tools,
  getToolDefinitions,
  executeTool,
  type Tool,
  type ToolResult,
} from './tools/index.js'

// ExpertProfile 需要 Tool 类型（re-export 不引入当前作用域，显式导入）
import type { Tool } from './tools/index.js'

// ===== 记忆系统 =====
export { MemoryStore, getMemoryStore } from './memory/store.js'

// ===== 配置（M2 将解耦为可注入；先导出保留现状）=====
export { config } from './core/config.js'

// ===== 专家配置（Expert Profile）=====
/**
 * 领域专家配置——应用通过注入工具、人设、品牌话术、存储路径，
 * 把通用引擎定制为领域专家（如 Pulse 的网络专家、StorySpire 的写作专家）。
 *
 * M1 定义基础结构，M2 实现机制（工具注入 / 身份话术 / 独立存储）。
 */
export interface ExpertProfile {
  /** 专家名称（面板显示，如 "pulse 助手"） */
  name: string
  /** 身份话术：用户问"你是谁"时的回答（如 "我是 pulse 助手，是集成到 pulse 的 flare 网络专家"） */
  identity: string
  /** Flare 介绍：用户追问"flare 是什么"时的回答（品牌共生话术） */
  flareIntro: string
  /** 领域工具集（可选；缺省用 Flare 内置工具） */
  tools?: Tool[]
  /** 专家系统提示词（可选；缺省用 Flare 默认） */
  systemPrompt?: string
  /** 独立记忆库路径（可选；缺省用 Flare 默认库） */
  storage?: string
}
