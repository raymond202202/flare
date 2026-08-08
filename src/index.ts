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
  resolveProviderOptions,
  type LLMProvider,
  type LLMResponse,
  type Message,
  type MessageRole,
  type ToolCall,
  type ToolDefinition,
  type ProviderOptions,
  type ResolvedProviderOptions,
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

// ===== 记忆检索工具（RAG，v0.5.1）=====
export {
  memorySearchTool,
  createMemorySearchTool,
  type MemorySearchScope,
  type MemorySearchArgs,
} from './tools/memory.js'

// ===== MCP 协议支持（v0.5.5）：外部 MCP 服务器工具桥接 =====
export { MCPClient } from './mcp/client.js'
export type { MCPClientOptions } from './mcp/client.js'
export { McpManager, loadMcpConfig } from './mcp/manager.js'
export type { McpManagerOptions } from './mcp/manager.js'
export { createMcpTools } from './tools/mcp.js'
export type {
  McpServerConfig,
  McpConfigFile,
  McpTool,
  McpContentItem,
  McpCallResult,
  McpServerStatus,
} from './mcp/types.js'

// ===== 上下文可观测性（v0.5.6）：token 估算（宿主面板显示上下文占用/成本预估）=====
export {
  estimateTokens,
  estimateMessagesTokens,
  IMAGE_TOKEN_COST,
  MESSAGE_STRUCTURE_TOKENS,
  TOOL_CALL_STRUCTURE_TOKENS,
} from './core/context.js'

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

// ===== 宿主协议服务（Qt 等非 Node 宿主）=====
export { startHostServer } from './server.js'
export type { HostServerOptions } from './server.js'
