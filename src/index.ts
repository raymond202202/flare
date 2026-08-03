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
  createVisionProvider,
  OpenAIProvider,
  type LLMProvider,
  type LLMResponse,
  type Message,
  type MessageRole,
  type ToolCall,
  type ToolDefinition,
} from './core/llm.js'

// ===== 多模态 / 图片识别（v0.4.0）=====
export {
  parseAttachments,
  buildImageContent,
  fileToDataUrl,
  resolveImagePath,
  isImageFile,
  IMAGE_EXTENSIONS,
  type ContentPart,
  type ParsedInput,
} from './core/llm.js'

export {
  tools,
  getToolDefinitions,
  executeTool,
  readFileTool,
  writeFileTool,
  searchFilesTool,
  terminalTool,
  type Tool,
  type ToolResult,
  type ToolExecutor,
} from './tools/index.js'

// ===== 网络工具集（M3：Pulse 网络专家）=====
export {
  networkTools,
  httpRequestTool,
  urlParseTool,
  responseAnalyzeTool,
} from './tools/network.js'

// ===== 写作工具集（M4：StorySpire 写作专家）=====
export {
  storyTools,
  storyToolDefinitions,
  getStoryToolDefinitions,
} from './tools/story.js'

// ===== 记忆系统 =====
export { MemoryStore, getMemoryStore, serializeContent, deserializeContent } from './memory/store.js'

// ===== 配置（M2 将解耦为可注入；先导出保留现状）=====
export { config } from './core/config.js'

// ===== 专家配置（Expert Profile）=====
export type { ExpertProfile } from './types.js'
export { profileToConfig } from './types.js'

// ===== 工具确认机制（withConfirmation）=====
export { withConfirmation, isDenied } from './core/confirm.js'
export type { ConfirmDecision, Confirmer } from './core/confirm.js'
