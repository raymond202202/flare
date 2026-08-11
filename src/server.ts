/**
 * Flare 宿主协议服务（最小版）
 *
 * 供非 Node 宿主（Qt 等）通过 stdin/stdout JSON Lines 调用 flare 引擎：
 *   - chat（流式）/ cancel / set_context / list_sessions / get_messages / tool_result
 *   - 会话管理：create_session / delete_session（含消息/用量）
 *   - 记忆接口（v0.5.4）：remember / get_memories / delete_memory
 *   - 诊断：ping / version / get_usage
 *   - 宿主代理工具：宿主在 chat 请求声明 tools，服务经 tool_execute 事件请宿主执行
 *
 * 用法：
 *   flare server --profile <expert.json> --storage <db-path>
 * 或编程方式：
 *   startHostServer({ profile, storage })
 */

import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import {
  Agent,
  createProvider,
  profileToConfig,
  McpManager,
  estimateMessagesTokens,
  suggestTrim,
  MemoryStore,
  getMemoryStore,
  ConfirmationGate,
  memoryStoreKv,
  resolveProviderOptions,
  listOllamaModels,
  config,
  tools as builtinTools,
  validateToolOutputPolicy,
  type ExpertProfile,
  type ToolDefinition,
  type Tool,
  type ToolResult,
  type McpServerConfig,
  type ConfirmDecision,
  type OllamaModelsResult,
  type ToolOutputPolicy,
} from './index.js'

// 从 package.json 读取引擎版本（不硬编码；宿主 version 协商用）
// 注意：编译产物 dist/server.js 位于 dist/ 下，package.json 在项目根（../package.json）
const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

/** 宿主协议版本（协议演进时递增；与引擎版本独立） */
export const HOST_PROTOCOL_VERSION = '1.0'

export interface HostServerOptions {
  profile: ExpertProfile
  storage?: string
  /** 工具执行超时（毫秒），默认 30s */
  toolTimeoutMs?: number
  /** 消息来源标识（记忆库隔离用） */
  namespace?: string
  /** MCP 服务器配置（v0.5.5）：启动时连接外部 MCP 服务器，工具并入 Agent 工具集 */
  mcp?: McpServerConfig[]
  /** 需要用户确认的工具名名单（v0.6.1）：命中名单的工具经 ConfirmationGate，宿主弹窗确认后才执行。
   *  默认 ['memory_save']（写回类工具）；传空数组关闭确认门。 */
  confirmTools?: string[]
  /** 确认超时毫秒（v0.6.1，默认 30000）：宿主未在时限内回 confirm_result 按安全默认（deny）处理 */
  confirmTimeoutMs?: number
  /** 默认最大输出 token 数（v0.6.5）：chat 请求未指定 maxTokens 时应用（CLI --max-tokens） */
  defaultMaxTokens?: number
  /** 默认采样温度 0~2（v0.6.5）：chat 请求未指定 temperature 时应用（CLI --temperature） */
  defaultTemperature?: number
  /** 默认上下文裁剪条数上限（v0.6.17）：chat 请求未指定 maxContextMessages 时应用（CLI --max-context-messages） */
  defaultMaxContextMessages?: number
  /** 默认上下文裁剪 token 预算（v0.6.17）：chat 请求未指定 maxContextTokens 时应用（CLI --max-context-tokens） */
  defaultMaxContextTokens?: number
  /** 默认上下文压缩摘要开关（v0.6.19）：chat 请求未指定 contextSummarize 时应用（CLI --context-summarize） */
  defaultContextSummarize?: boolean
  /** 默认工具输出治理策略（v0.6.34）：chat 请求未指定 toolOutputPolicy 时应用（CLI --tool-output-policy）；
   *  缺省与旧版统一 slice 截断完全一致。 */
  defaultToolOutputPolicy?: ToolOutputPolicy
}

/** 默认需确认的工具（v0.6.1）：AI 写持久记忆前经确认门（宿主弹窗"AI 想记住…"，用户知情授权） */
export const DEFAULT_CONFIRM_TOOLS = ['memory_save']

/** 合法确认决策（confirm_result 请求校验用） */
const VALID_CONFIRM_DECISIONS: ConfirmDecision[] = ['allow_once', 'allow_session', 'always', 'deny', 'alternative']

/** 单个工具元数据（tools 请求响应项，v0.6.11） */
export interface ToolMeta {
  name: string
  description?: string
  /** JSON Schema 参数定义（tools/list 同构） */
  parameters?: Record<string, unknown>
  /** 是否经确认门（命中 confirmTools 名单；宿主面板"写回类工具需确认"标注） */
  confirmed: boolean
  /** 工具来源：host（宿主代理）/ profile（专家配置）/ mcp（外部 MCP 服务器）/ builtin（内置回退） */
  source: 'host' | 'profile' | 'mcp' | 'builtin'
}

/** describeTools 来源判定输入（v0.6.11） */
export interface ToolSourceSets {
  host?: Set<string>
  profile?: Set<string>
  mcp?: Set<string>
}

/**
 * 收集工具元数据（v0.6.11，纯函数可单测）：工具集 → 名称/描述/参数 + 确认门标注 + 来源。
 * 宿主面板"AI 可用工具清单"数据源（tools 请求用；只读，不触发生成）。
 */
export function describeTools(tools: Tool[], confirmTools: string[], sources: ToolSourceSets = {}): ToolMeta[] {
  const confirmSet = new Set(confirmTools)
  const sourceOf = (name: string): ToolMeta['source'] => {
    if (sources.host?.has(name)) return 'host'
    if (sources.mcp?.has(name)) return 'mcp'
    if (sources.profile?.has(name)) return 'profile'
    return 'builtin'
  }
  return tools.map((t) => {
    const def = t.definition.function
    return {
      name: def.name,
      ...(def.description ? { description: def.description } : {}),
      ...(def.parameters ? { parameters: def.parameters as Record<string, unknown> } : {}),
      confirmed: confirmSet.has(def.name),
      source: sourceOf(def.name),
    }
  })
}

/**
 * 对工具集应用确认门（v0.6.1，纯函数可单测）：
 * 命中 confirmTools 名单的工具用 gate.wrap 包装（执行前经宿主确认），其余原样返回。
 * 名单为空 → 全部原样（确认门关闭）。
 */
export function wrapConfirmTools(tools: Tool[], gate: ConfirmationGate, confirmTools: string[]): Tool[] {
  if (!confirmTools || confirmTools.length === 0) return tools
  const set = new Set(confirmTools)
  return tools.map(t => (set.has(t.definition.function.name) ? gate.wrap(t) : t))
}

/** confirm 事件消息（宿主弹窗确认请求，v0.6.27 起可选带工具描述） */
export interface ConfirmEvent {
  type: 'confirm'
  sessionId: string
  id: string
  name: string
  args: Record<string, any>
  /** 工具描述（可选）：工具定义有描述时带上——宿主弹窗可展示「AI 想做什么」，而非只有工具名+参数 */
  description?: string
}

/**
 * 构造 confirm 事件（v0.6.27，纯函数可单测）：宿主弹窗确认请求。
 * description 可选——有描述才输出该字段（JSON.stringify 丢 undefined，向后兼容：旧宿主忽略未知字段）。
 */
export function buildConfirmEvent(
  sessionId: string,
  id: string,
  toolName: string,
  args: Record<string, any>,
  description?: string,
): ConfirmEvent {
  return {
    type: 'confirm',
    sessionId,
    id,
    name: toolName,
    args: args || {},
    ...(description ? { description } : {}),
  }
}

/**
 * 推断模型 provider 类型（v0.6.9，纯函数可单测）：模型名 → ollama / deepseek / openai / other。
 * 与 resolveProviderOptions 的自动检测规则一致（含 ':' 的 Ollama 命名 / deepseek 系列 / gpt·o1·o3·chatgpt 系列）。
 */
export function detectProvider(model: string): 'ollama' | 'deepseek' | 'openai' | 'other' {
  if (model.includes(':')) return 'ollama'
  if (model.includes('deepseek')) return 'deepseek'
  if (model.includes('gpt') || model.includes('o1') || model.includes('o3') || model.includes('chatgpt')) return 'openai'
  return 'other'
}

/** 单个模型的端点信息（models 响应 configured 项，v0.6.9） */
export interface ModelEndpointInfo {
  model: string
  baseURL: string
  hasApiKey: boolean
  provider: 'ollama' | 'deepseek' | 'openai' | 'other'
  /** 解析失败原因（如 Claude 系列明确报错）；此时不抛错，接口仍返回其余字段 */
  error?: string
}

/** models 请求的响应体（v0.6.9）：configured 当前配置 + ollama 本地模型列表 */
export interface ModelInfoResponse {
  configured: {
    /** 当前主模型（DEFAULT_MODEL 或环境配置解析） */
    main: ModelEndpointInfo
    /** 视觉模型（未配置时 null） */
    vision: ModelEndpointInfo | null
  }
  ollama: OllamaModelsResult
}

/**
 * 收集模型信息（v0.6.9，纯逻辑可单测；供 server 协议 models 请求使用）：
 * - configured：当前配置的主/视觉模型端点信息（resolveProviderOptions 解析 + provider 推断 + apiKey 是否存在）
 * - ollama：本地 Ollama 已拉取模型列表（listOllamaModels；Ollama 不可达返回 ok:false + error，不抛错）
 * fetchImpl 可注入（测试 mock）；默认全局 fetch。
 */
export async function collectModelInfo(fetchImpl: typeof fetch = fetch): Promise<ModelInfoResponse> {
  const resolveOne = (model?: string): ModelEndpointInfo => {
    const name = model || config.get('DEFAULT_MODEL') || 'gpt-4o'
    try {
      const r = resolveProviderOptions(model ? { model } : {})
      return { model: r.model, baseURL: r.baseURL, hasApiKey: Boolean(r.apiKey), provider: detectProvider(r.model) }
    } catch (e: any) {
      return { model: name, baseURL: '', hasApiKey: false, provider: detectProvider(name), error: e?.message || String(e) }
    }
  }
  const visionModel = config.get('VISION_MODEL')
  return {
    configured: {
      main: resolveOne(),
      vision: visionModel ? resolveOne(visionModel) : null,
    },
    ollama: await listOllamaModels(undefined, undefined, fetchImpl),
  }
}

interface PendingTool {
  resolve: (r: ToolResult) => void
  timer: NodeJS.Timeout
}

/** 创建宿主代理工具（execute 时经 stdout 问宿主） */
function makeHostTools(defs: ToolDefinition[], reply: (msg: any) => void, pending: Map<string, PendingTool>, timeoutMs: number): Tool[] {
  return defs.map(def => ({
    definition: def,
    execute: (args: Record<string, any>): Promise<ToolResult> => {
      return new Promise((resolve) => {
        const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve({ success: false, output: '', error: '工具执行超时（宿主未在时限内回 tool_result）' })
        }, timeoutMs)
        pending.set(id, { resolve, timer })
        reply({ type: 'tool_execute', id, name: def.function.name, args: args || {} })
      })
    },
  }))
}

/** chat 请求可透传的 LLM 采样控制（v0.6.3：maxTokens/temperature，创建 provider 时生效） */
interface LlmChatOpts {
  maxTokens?: number
  temperature?: number
}

/** chat 请求可透传的上下文自动裁剪控制（v0.6.17：maxContextMessages/maxContextTokens，Agent 构造时生效；
 *  v0.6.19：contextSummarize 压缩摘要开关；v0.6.34：toolOutputPolicy 工具输出治理策略） */
interface CtxChatOpts {
  maxContextMessages?: number
  maxContextTokens?: number
  /** 上下文压缩摘要（v0.6.19）：裁剪时把丢弃历史压缩成摘要（AI 保留话题连续性） */
  contextSummarize?: boolean
  /** 工具输出治理策略（v0.6.34）：按工具类型定制工具结果截断（探索型留头尾/终端型留尾部/
   *  长度预算/省略标记）；缺省与旧版统一 slice 截断一致。 */
  toolOutputPolicy?: ToolOutputPolicy
}

const llmOptsChanged = (a?: LlmChatOpts, b?: LlmChatOpts): boolean =>
  (a?.maxTokens ?? undefined) !== (b?.maxTokens ?? undefined) ||
  (a?.temperature ?? undefined) !== (b?.temperature ?? undefined)

const ctxOptsChanged = (a?: CtxChatOpts, b?: CtxChatOpts): boolean =>
  (a?.maxContextMessages ?? undefined) !== (b?.maxContextMessages ?? undefined) ||
  (a?.maxContextTokens ?? undefined) !== (b?.maxContextTokens ?? undefined) ||
  (a?.contextSummarize ?? undefined) !== (b?.contextSummarize ?? undefined) ||
  // 策略是对象：JSON 序列化比较（validateToolOutputPolicy 归一化后字段顺序固定，稳定可复现）
  JSON.stringify(a?.toolOutputPolicy ?? null) !== JSON.stringify(b?.toolOutputPolicy ?? null)

/** 启动宿主协议服务（阻塞读 stdin） */
export function startHostServer(opts: HostServerOptions) {
  const { profile, storage, toolTimeoutMs = 30000, namespace } = opts
  // 确认门配置（v0.6.1）：名单默认写回类工具；显式传空数组 = 关闭
  const confirmTools = opts.confirmTools ?? DEFAULT_CONFIRM_TOOLS
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? 30000
  // 会话 → { agent, model, llmOpts, ctxOpts, toolMeta }：model / 采样控制 / 上下文裁剪控制变化时重建 Agent（同 sessionId，历史从记忆库恢复）
  // toolMeta（v0.6.11）：该会话 Agent 当前工具清单元数据（tools 请求只读查询用）
  const agents = new Map<string, { agent: Agent; model?: string; llmOpts?: LlmChatOpts; ctxOpts?: CtxChatOpts; toolMeta?: ToolMeta[] }>()
  const cancels = new Map<string, { cancelled: boolean }>()
  const pending = new Map<string, PendingTool>()
  // 确认门（v0.6.1）：按 sessionId 缓存——allow_session 放行记忆跨模型重建保留；always 持久化到记忆库 settings 表
  const gates = new Map<string, ConfirmationGate>()
  // 挂起的确认请求：confirm 事件发出后等待宿主 confirm_result
  const pendingConfirms = new Map<string, { resolve: (d: ConfirmDecision) => void; timer: NodeJS.Timeout }>()
  // 工具描述（v0.6.27）：confirm 事件带工具描述（宿主弹窗可展示「AI 想做什么」）；getAgent 构建工具集时填充
  const toolDescriptions = new Map<string, string>()
  // MCP 管理器（v0.5.5）：外部 MCP 服务器工具并入 Agent 工具集
  const mcpManager = new McpManager({ configPath: '' })
  if (opts.mcp && opts.mcp.length > 0) {
    mcpManager.setConfig(opts.mcp)
  }
  // 启动时后台连接 MCP 服务器（失败不阻塞服务；mcp_status 可见错误）
  const mcpConnects: Promise<unknown>[] = []
  for (const s of mcpManager.servers) {
    mcpConnects.push(mcpManager.connect(s.name).catch(() => {}))
  }

  const reply = (msg: any) => {
    process.stdout.write(JSON.stringify(msg) + '\n')
  }

  /**
   * 向宿主发起确认请求（v0.6.1）：发 confirm 事件 → 宿主弹窗 → 回 confirm_result。
   * 超时兜底：宿主一直不回时由 ConfirmationGate 自身超时（安全 deny）处理；
   * 本函数只负责在稍后清理挂起条目（防泄漏），resolve 值不会被 gate 采用（已处理完）。
   * description（v0.6.27）：工具描述，宿主弹窗展示「AI 想做什么」；无描述不输出字段（向后兼容）。
   */
  const askHostConfirm = (sessionId: string, toolName: string, args: Record<string, any>, description?: string): Promise<ConfirmDecision> => {
    return new Promise((resolve) => {
      const id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      const timer = setTimeout(() => {
        pendingConfirms.delete(id)
        resolve('deny')
      }, confirmTimeoutMs + 5000)
      timer.unref?.()
      pendingConfirms.set(id, { resolve, timer })
      reply(buildConfirmEvent(sessionId, id, toolName, args, description))
    })
  }

  /** 会话确认门（v0.6.1，按 sessionId 缓存）：confirmer = 宿主弹窗（confirm 事件）；always 持久化到记忆库 settings 表 */
  const getGate = (sessionId: string): ConfirmationGate => {
    let gate = gates.get(sessionId)
    if (!gate) {
      const kv = memoryStoreKv(storage ? new MemoryStore(storage) : getMemoryStore())
      gate = new ConfirmationGate({
        // 描述在工具执行时实时查（getAgent 已填充）——仅命中确认名单的工具可能触发
        confirmer: (toolName, args) => askHostConfirm(sessionId, toolName, args, toolDescriptions.get(toolName)),
        sessionId,
        store: kv,
        timeoutMs: confirmTimeoutMs,
      })
      gates.set(sessionId, gate)
    }
    return gate
  }

  const getAgent = (sessionId: string, tools?: ToolDefinition[], model?: string, llmOpts?: LlmChatOpts, ctxOpts?: CtxChatOpts): Agent => {
    let entry = agents.get(sessionId)
    // 请求带 model 且与会话当前模型不同 → 重建；采样控制（maxTokens/temperature）任一变化 → 重建（立即生效）；
    // 上下文裁剪控制（maxContextMessages/maxContextTokens）任一变化 → 重建（v0.6.17）
    if (entry && ((model && entry.model !== model) || llmOptsChanged(entry.llmOpts, llmOpts) || ctxOptsChanged(entry.ctxOpts, ctxOpts))) {
      entry = undefined
    }
    if (!entry) {
      const hostTools = tools && tools.length > 0
        ? makeHostTools(tools, reply, pending, toolTimeoutMs)
        : undefined
      // model 字段 → 指定主模型 provider（如本地 Ollama qwen2.5:7b）；缺省用默认路由
      // maxTokens/temperature（v0.6.3）→ 采样控制透传（需显式创建 provider；仅 model 或采样参数任一存在时）
      const hasLlmParams = Boolean(model) || llmOpts?.maxTokens !== undefined || llmOpts?.temperature !== undefined
      const llm = hasLlmParams
        ? createProvider({
            ...(model ? { model } : {}),
            ...(llmOpts?.maxTokens !== undefined ? { maxTokens: llmOpts.maxTokens } : {}),
            ...(llmOpts?.temperature !== undefined ? { temperature: llmOpts.temperature } : {}),
          })
        : undefined
      // MCP 工具（v0.5.5）：已连接的服务器工具并入工具集（与宿主代理工具/专家工具并存）
      const mcpTools = mcpManager.getAllTools()
      const mergedTools = [...(hostTools || profile.tools || []), ...mcpTools]
      // 无注入工具时用内置工具集（与 Agent 默认一致）——否则 Agent 回退内置工具会绕过确认门
      const baseTools = mergedTools.length > 0 ? mergedTools : builtinTools
      // 确认门（v0.6.1）：命中 confirmTools 名单的工具执行前经宿主弹窗确认（写回类工具知情授权）
      const gatedTools = wrapConfirmTools(baseTools, getGate(sessionId), confirmTools)
      // 工具描述（v0.6.27）：confirm 事件带描述——宿主弹窗可展示「AI 想做什么」（无描述不输出，向后兼容）
      for (const t of gatedTools) {
        const fn = t.definition.function
        if (fn.description) toolDescriptions.set(fn.name, fn.description)
      }
      // 工具元数据（v0.6.11）：来源标注（宿主代理 / 专家配置 / MCP / 内置回退）
      const toolMeta = describeTools(gatedTools, confirmTools, {
        host: new Set((hostTools || []).map((t) => t.definition.function.name)),
        profile: new Set((profile.tools || []).map((t) => t.definition.function.name)),
        mcp: new Set(mcpTools.map((t) => t.definition.function.name)),
      })
      entry = {
        agent: new Agent({
          ...profileToConfig(profile),
          ...(gatedTools.length > 0 ? { tools: gatedTools } : {}),
          ...(llm ? { llm } : {}),
          sessionId: namespace ? `${namespace}:${sessionId}` : sessionId,
          storage,
          // 上下文自动裁剪（v0.6.17）：maxContextMessages/maxContextTokens 透传到 Agent
          ...(ctxOpts?.maxContextMessages !== undefined ? { maxContextMessages: ctxOpts.maxContextMessages } : {}),
          ...(ctxOpts?.maxContextTokens !== undefined ? { maxContextTokens: ctxOpts.maxContextTokens } : {}),
          // 上下文压缩摘要（v0.6.19）：contextSummarize 透传到 Agent
          ...(ctxOpts?.contextSummarize !== undefined ? { contextSummarize: ctxOpts.contextSummarize } : {}),
          // 工具输出治理策略（v0.6.34）：toolOutputPolicy 透传到 Agent（缺省与旧版统一 slice 一致）
          ...(ctxOpts?.toolOutputPolicy !== undefined ? { toolOutputPolicy: ctxOpts.toolOutputPolicy } : {}),
        }),
        model,
        llmOpts,
        ctxOpts,
        toolMeta,
      }
      agents.set(sessionId, entry)
    }
    return entry.agent
  }

  const rl = createInterface({ input: process.stdin })
  rl.on('line', async (line) => {
    let req: any
    try {
      req = JSON.parse(line)
    } catch (e: any) {
      reply({ type: 'error', message: `JSON 解析失败: ${e?.message || e}` })
      return
    }
    try {
      switch (req.type) {
        case 'chat': {
          const sessionId = String(req.sessionId || 'default')
          // model 可选：指定本次会话主模型（如 qwen2.5:7b 本地 Ollama / deepseek-chat 远端）；缺省用默认路由
          // maxTokens / temperature（v0.6.3）：采样控制透传——非法值直接 error，不触发生成
          let llmOpts: LlmChatOpts | undefined
          if (req.maxTokens !== undefined && req.maxTokens !== null) {
            const v = Number(req.maxTokens)
            if (!Number.isInteger(v) || v <= 0) {
              reply({ type: 'error', message: 'chat 的 maxTokens 必须是正整数（最大输出 token 数）' })
              break
            }
            llmOpts = { ...llmOpts, maxTokens: v }
          }
          if (req.temperature !== undefined && req.temperature !== null) {
            const v = Number(req.temperature)
            if (!Number.isFinite(v) || v < 0 || v > 2) {
              reply({ type: 'error', message: 'chat 的 temperature 必须是 0~2 的数值' })
              break
            }
            llmOpts = { ...llmOpts, temperature: v }
          }
          // v0.6.5：chat 未指定采样参数时应用 server 级默认（CLI --max-tokens/--temperature）
          // 注意：请求只带一个参数时另一个不用默认补（请求优先，行为可预期）
          if (!llmOpts && (opts.defaultMaxTokens !== undefined || opts.defaultTemperature !== undefined)) {
            llmOpts = {}
            if (opts.defaultMaxTokens !== undefined) {
              const v = Number(opts.defaultMaxTokens)
              if (!Number.isInteger(v) || v <= 0) {
                reply({ type: 'error', message: 'server 默认 maxTokens 必须是正整数（最大输出 token 数）' })
                break
              }
              llmOpts = { ...llmOpts, maxTokens: v }
            }
            if (opts.defaultTemperature !== undefined) {
              const v = Number(opts.defaultTemperature)
              if (!Number.isFinite(v) || v < 0 || v > 2) {
                reply({ type: 'error', message: 'server 默认 temperature 必须是 0~2 的数值' })
                break
              }
              llmOpts = { ...llmOpts, temperature: v }
            }
          }
          // v0.6.17：上下文自动裁剪控制（maxContextMessages/maxContextTokens）——非法值直接 error，不触发生成
          let ctxOpts: CtxChatOpts | undefined
          if (req.maxContextMessages !== undefined && req.maxContextMessages !== null) {
            const v = Number(req.maxContextMessages)
            if (!Number.isInteger(v) || v < 0) {
              reply({ type: 'error', message: 'chat 的 maxContextMessages 必须是非负整数（0 = 不按条数裁剪）' })
              break
            }
            ctxOpts = { ...ctxOpts, maxContextMessages: v }
          }
          if (req.maxContextTokens !== undefined && req.maxContextTokens !== null) {
            const v = Number(req.maxContextTokens)
            if (!Number.isInteger(v) || v <= 0) {
              reply({ type: 'error', message: 'chat 的 maxContextTokens 必须是正整数（上下文 token 预算）' })
              break
            }
            ctxOpts = { ...ctxOpts, maxContextTokens: v }
          }
          // v0.6.19：上下文压缩摘要开关（contextSummarize）——非法值直接 error，不触发生成
          if (req.contextSummarize !== undefined && req.contextSummarize !== null) {
            if (typeof req.contextSummarize !== 'boolean') {
              reply({ type: 'error', message: 'chat 的 contextSummarize 必须是布尔值（true/false，压缩摘要开关）' })
              break
            }
            ctxOpts = { ...ctxOpts, contextSummarize: req.contextSummarize }
          }
          // v0.6.34：工具输出治理策略（toolOutputPolicy）——非法值直接 error，不触发生成
          if (req.toolOutputPolicy !== undefined && req.toolOutputPolicy !== null) {
            const v = validateToolOutputPolicy(req.toolOutputPolicy)
            if (!v.ok) {
              reply({ type: 'error', message: v.message })
              break
            }
            ctxOpts = { ...ctxOpts, toolOutputPolicy: v.value }
          }
          // chat 未指定裁剪控制时应用 server 级默认（CLI --max-context-messages/--max-context-tokens/--context-summarize/--tool-output-policy）
          if (!ctxOpts && (opts.defaultMaxContextMessages !== undefined || opts.defaultMaxContextTokens !== undefined || opts.defaultContextSummarize !== undefined || opts.defaultToolOutputPolicy !== undefined)) {
            ctxOpts = {}
            if (opts.defaultMaxContextMessages !== undefined) {
              const v = Number(opts.defaultMaxContextMessages)
              if (!Number.isInteger(v) || v < 0) {
                reply({ type: 'error', message: 'server 默认 maxContextMessages 必须是非负整数（0 = 不按条数裁剪）' })
                break
              }
              ctxOpts = { ...ctxOpts, maxContextMessages: v }
            }
            if (opts.defaultMaxContextTokens !== undefined) {
              const v = Number(opts.defaultMaxContextTokens)
              if (!Number.isInteger(v) || v <= 0) {
                reply({ type: 'error', message: 'server 默认 maxContextTokens 必须是正整数（上下文 token 预算）' })
                break
              }
              ctxOpts = { ...ctxOpts, maxContextTokens: v }
            }
            if (opts.defaultContextSummarize !== undefined) {
              ctxOpts = { ...ctxOpts, contextSummarize: opts.defaultContextSummarize }
            }
            if (opts.defaultToolOutputPolicy !== undefined) {
              ctxOpts = { ...ctxOpts, toolOutputPolicy: opts.defaultToolOutputPolicy }
            }
          }
          const agent = getAgent(sessionId, req.tools, req.model ? String(req.model) : undefined, llmOpts, ctxOpts)
          if (req.context && typeof agent.setContext === 'function') {
            agent.setContext(String(req.context))
          }
          const flag = { cancelled: false }
          cancels.set(sessionId, flag)
          try {
            for await (const chunk of agent.run(String(req.input || ''))) {
              if (flag.cancelled) {
                reply({ type: 'cancelled', sessionId })
                break
              }
              reply({ ...chunk, sessionId })
            }
          } finally {
            cancels.delete(sessionId)
          }
          if (!flag.cancelled) {
            reply({ type: 'done', sessionId })
          }
          break
        }
        case 'cancel': {
          const flag = cancels.get(String(req.sessionId || 'default'))
          if (flag) flag.cancelled = true
          reply({ type: 'ok', sessionId: String(req.sessionId || 'default') })
          break
        }
        case 'ping': {
          // 宿主健康检查：进程存活即回 pong（不依赖任何初始化）
          reply({ type: 'pong', ts: Date.now() })
          break
        }
        case 'version': {
          // 宿主版本协商：协议版本 + 引擎版本（宿主启动时探测兼容性）
          reply({ type: 'version', protocol: HOST_PROTOCOL_VERSION, engine: pkg.version })
          break
        }
        case 'delete_session': {
          // 宿主清理会话（含消息/用量；隐私数据清除）
          const sessionId = String(req.sessionId || 'default')
          const agent = getAgent(sessionId)
          // Agent 内部 sessionId 可能带 namespace 前缀，用它删除才一致
          const sid = (agent as any).config?.sessionId || sessionId
          const deleted = (typeof (agent as any).store?.deleteSession === 'function')
            ? await (agent as any).store.deleteSession(sid)
            : false
          agents.delete(sessionId)
          reply({ type: 'ok', sessionId, deleted })
          break
        }
        case 'end_session': {
          // 会话归档（v0.6.31）：标记 archived=1（数据保留），从「最近会话」隐藏；
          // 销毁缓存 Agent（下次 chat 重建）；list_archived_sessions 找回 / restore_session 恢复。
          // 会话不存在幂等 ok（archived:false），不触发生成
          const sessionId = String(req.sessionId || 'default')
          const agent = getAgent(sessionId)
          const sid = (agent as any).config?.sessionId || sessionId
          const archived = (typeof (agent as any).store?.archiveSession === 'function')
            ? await (agent as any).store.archiveSession(sid)
            : false
          agents.delete(sessionId)
          reply({ type: 'ok', sessionId, archived })
          break
        }
        case 'restore_session': {
          // 恢复归档会话（v0.6.31）：标记 archived=0，重新出现在最近会话；销毁缓存 Agent
          const sessionId = String(req.sessionId || 'default')
          const agent = getAgent(sessionId)
          const sid = (agent as any).config?.sessionId || sessionId
          const restored = (typeof (agent as any).store?.restoreSession === 'function')
            ? await (agent as any).store.restoreSession(sid)
            : false
          agents.delete(sessionId)
          reply({ type: 'ok', sessionId, restored })
          break
        }
        case 'list_archived_sessions': {
          // 列出归档会话（v0.6.31）：宿主面板\"已归档\"视图数据源（只读不触发生成）
          const agent = getAgent(String(req.sessionId || 'default'))
          const rows = (typeof (agent as any).store?.listArchivedSessions === 'function')
            ? (agent as any).store.listArchivedSessions(50)
            : []
          const sessions = rows.map((r: any) => ({
            id: r.id,
            title: r.title || '新会话',
            updatedAt: r.updated_at || '',
            preview: (r.first_user_msg || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          }))
          reply({ type: 'archived_sessions', sessions })
          break
        }
        case 'create_session': {
          // 宿主显式创建会话（带标题；UPSERT 幂等——已存在则更新标题）
          const sessionId = String(req.sessionId || 'default')
          const agent = getAgent(sessionId)
          const title = req.title ? String(req.title) : '新会话'
          if (typeof (agent as any).store?.updateSessionTitle === 'function') {
            (agent as any).store.updateSessionTitle((agent as any).config?.sessionId || sessionId, title)
          }
          reply({ type: 'ok', sessionId })
          break
        }
        case 'rename_session': {
          // 宿主重命名已有会话（v0.6.18）：{ sessionId, title }——面板\"重命名会话\"，
          // 与 create_session（创建语义）分离；title 非空必填，非法回 error 不触发生成
          const sessionId = String(req.sessionId || 'default')
          const title = req.title === undefined || req.title === null ? '' : String(req.title).trim()
          if (!title) {
            reply({ type: 'error', message: 'rename_session 需要 title 参数（非空的新会话标题）' })
            break
          }
          const agent = getAgent(sessionId)
          if (typeof (agent as any).store?.updateSessionTitle === 'function') {
            (agent as any).store.updateSessionTitle((agent as any).config?.sessionId || sessionId, title)
          }
          reply({ type: 'ok', sessionId, title })
          break
        }
        case 'clear_session': {
          // 宿主清空会话消息（保留会话记录与用量；v0.6.18）——面板"清空对话"按钮：
          //   销毁缓存 Agent（内存上下文同步清空，下次 chat 重建干净会话；与 delete_session 同模式）
          const sessionId = String(req.sessionId || 'default')
          const agent = getAgent(sessionId)
          const sid = (agent as any).config?.sessionId || sessionId
          let cleared = 0
          if (typeof (agent as any).store?.clearSessionMessages === 'function') {
            cleared = (agent as any).store.clearSessionMessages(sid)
          }
          agents.delete(sessionId)
          reply({ type: 'ok', sessionId, cleared })
          break
        }
        case 'set_context': {
          const sessionId = String(req.sessionId || 'default')
          const agent = getAgent(sessionId)
          if (typeof agent.setContext === 'function') {
            agent.setContext(String(req.context || ''))
          }
          reply({ type: 'ok', sessionId })
          break
        }
        case 'list_sessions': {
          const sessionId = String(req.sessionId || 'default')
          const agent = getAgent(sessionId)
          const sessions = (typeof (agent as any).store?.getAllSessions === 'function')
            ? await (agent as any).store.getAllSessions()
            : []
          reply({ type: 'sessions', sessions })
          break
        }
        case 'recent_sessions': {
          // 最近会话列表 + 预览（v0.6.0）：首条 user 消息作标题/预览，宿主会话面板展示用（只读不生成）
          const agent = getAgent(String(req.sessionId || 'default'))
          const limit = Math.min(Math.max(Number(req.limit) || 10, 1), 50)
          const rows = (typeof (agent as any).store?.getRecentSessions === 'function')
            ? (agent as any).store.getRecentSessions(limit)
            : []
          const sessions = rows.map((r: any) => ({
            id: r.id,
            title: r.title || '',
            updatedAt: r.updated_at || '',
            preview: (r.first_user_msg || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          }))
          reply({ type: 'recent_sessions', sessions })
          break
        }
        case 'get_messages': {
          // 宿主读取指定会话的消息历史（同 list_sessions 模式，只读不生成）
          // v0.6.21：可选 limit（正整数 1~500，默认 50，向后兼容）+ recent（布尔）——
          //   recent:true → 返回**最近** limit 条（宿主面板\"最近对话\"数据源；长会话下 getMessages
          //   默认取最早 limit 条看不到最新内容）；缺省行为与旧版完全一致
          const sessionId = String(req.sessionId || 'default')
          let limit = 50
          if (req.limit !== undefined && req.limit !== null) {
            limit = Number(req.limit)
            if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
              reply({ type: 'error', message: 'get_messages 的 limit 必须是 1~500 的整数' })
              break
            }
          }
          const agent = getAgent(sessionId)
          // Agent 内部 sessionId 可能带 namespace 前缀，用它查询才一致
          const sid = (agent as any).config?.sessionId || sessionId
          const recent = req.recent === true
          const messages = (typeof (agent as any).store?.getMessages === 'function')
            ? (recent
                ? (typeof (agent as any).store?.getRecentMessages === 'function'
                    ? await (agent as any).store.getRecentMessages(sid, limit)
                    : [])
                : await (agent as any).store.getMessages(sid, limit))
            : []
          reply({ type: 'messages', sessionId, messages, ...(recent ? { recent: true } : {}) })
          break
        }
        case 'search_messages': {
          // 全文搜索历史对话（v0.6.24）：宿主面板"搜索历史"数据源——复用 store 的 FTS5
          // trigram 索引（bm25 相关度排序，中文友好；短查询 LIKE 回退），全局跨会话检索
          //（与 get_usage 同风格，只读不触发生成）
          const query = String(req.query ?? '').trim()
          if (!query) {
            reply({ type: 'error', message: 'search_messages 需要 query 参数（搜索关键词），用法: {"type":"search_messages","query":"关键词"}' })
            break
          }
          let limit = 10
          if (req.limit !== undefined && req.limit !== null) {
            limit = Number(req.limit)
            if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
              reply({ type: 'error', message: 'search_messages 的 limit 必须是 1~100 的整数' })
              break
            }
          }
          const agent = getAgent(String(req.sessionId || 'default'))
          const results = (typeof (agent as any).store?.searchMessages === 'function')
            ? await (agent as any).store.searchMessages(query, limit)
            : []
          reply({ type: 'search_results', query, results })
          break
        }
        case 'get_usage': {
          // 宿主读取 token 用量统计（同 get_messages 模式，只读不生成）
          const agent = getAgent(String(req.sessionId || 'default'))
          const stats = (typeof (agent as any).store?.getUsageStats === 'function')
            ? await (agent as any).store.getUsageStats()
            : { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, totalTokens: 0, sessionCount: 0, perModel: [] }
          reply({ type: 'usage', stats })
          break
        }
        case 'session_usage': {
          // 宿主读取单个会话的 token 用量（v0.6.17）：宿主面板"本会话用量"数据源（只读不生成）
          const sessionId = String(req.sessionId || 'default')
          const agent = getAgent(sessionId)
          // Agent 内部 sessionId 可能带 namespace 前缀，用它查询才一致
          const sid = (agent as any).config?.sessionId || sessionId
          const stats = (typeof (agent as any).store?.getSessionUsage === 'function')
            ? await (agent as any).store.getSessionUsage(sid)
            : { sessionId, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, totalTokens: 0, callCount: 0 }
          reply({ type: 'session_usage', sessionId, stats })
          break
        }
        case 'context_status': {
          // 宿主查看会话上下文占用（v0.5.6）：消息数 + 估算 tokens（只读，不触发生成）
          // v0.6.4：可选 budgetTokens → 附裁剪建议（suggestTrim 纯函数；宿主可据此自行按预算裁剪上下文）
          const sessionId = String(req.sessionId || 'default')
          const agent = getAgent(sessionId)
          const messages = agent.getMessages()
          const estimatedTokens = estimateMessagesTokens(messages)
          let suggestion: Record<string, unknown> | undefined
          if (req.budgetTokens !== undefined && req.budgetTokens !== null) {
            const budget = Number(req.budgetTokens)
            if (!Number.isInteger(budget) || budget <= 0) {
              reply({ type: 'error', message: 'context_status 的 budgetTokens 必须是正整数（上下文 token 预算）' })
              break
            }
            const reserve = (req.reserveForOutput === undefined || req.reserveForOutput === null)
              ? 0
              : Number(req.reserveForOutput)
            if (!Number.isFinite(reserve) || reserve < 0) {
              reply({ type: 'error', message: 'context_status 的 reserveForOutput 必须是非负数值' })
              break
            }
            const trim = suggestTrim(messages, budget, { reserveForOutput: reserve })
            suggestion = {
              // 建议保留的消息在原上下文中的索引（system 在前；宿主按索引裁剪后回 set_context 即可生效）
              keepIndexes: trim.keep.map((m) => messages.indexOf(m)),
              droppedCount: trim.droppedCount,
              estimatedKeptTokens: trim.estimatedKeptTokens,
              estimatedDroppedTokens: trim.estimatedDroppedTokens,
            }
          }
          reply({
            type: 'context_status',
            sessionId,
            messageCount: messages.length,
            estimatedTokens,
            ...(suggestion ? { suggestion } : {}),
          })
          break
        }
        case 'remember': {
          // 宿主保存持久记忆（记忆生命周期 v0.5.4：AI 面板"记住"、用户偏好写入）
          const sessionId = String(req.sessionId || 'default')
          const content = String(req.content || '').trim()
          if (!content) {
            reply({ type: 'error', message: 'remember 需要 content 参数（要记住的内容）' })
            break
          }
          const agent = getAgent(sessionId)
          if (typeof (agent as any).store?.saveMemory === 'function') {
            // kind 为记忆类型（如 preference/note）；注意不能用 type（请求判别符）
            (agent as any).store.saveMemory(content, req.kind ? String(req.kind) : 'note')
          }
          reply({ type: 'ok', sessionId })
          break
        }
        case 'get_memories': {
          // 宿主读取记忆：query 存在 → 全文搜索；否则列出全部（只读不生成）
          // v0.6.25：kind 可选按记忆类型过滤（如 preference/note，宿主面板"记忆管理"筛选；
          //  与 remember 的 kind 参数同语义）；limit 严格校验 1~100（对齐 get_messages v0.6.21
          //  风格，非法回 error 含提示不触发生成）
          const q = req.query ? String(req.query).trim() : ''
          const kind = req.kind !== undefined && req.kind !== null ? String(req.kind).trim() : ''
          // limit：显式提供必须 1~100 整数（缺省 50）
          if (req.limit !== undefined && req.limit !== null) {
            const n = Number(req.limit)
            if (!Number.isInteger(n) || n < 1 || n > 100) {
              reply({ type: 'error', message: 'get_memories 的 limit 必须是 1~100 的整数（要返回的记忆条数上限）' })
              break
            }
          }
          const limit = req.limit === undefined || req.limit === null ? 50 : Number(req.limit)
          const agent = getAgent(String(req.sessionId || 'default'))
          const store = (agent as any).store
          let memories: any[] = []
          if (q && typeof store?.searchMemories === 'function') {
            memories = store.searchMemories(q, limit)
            // 搜索 + kind 组合：结果按类型过滤（记忆行含 type 字段）
            if (kind) memories = memories.filter((m: any) => m.type === kind)
          } else if (kind && typeof store?.getMemoriesByType === 'function') {
            memories = store.getMemoriesByType(kind, limit)
          } else if (typeof store?.getAllMemories === 'function') {
            memories = store.getAllMemories().slice(0, limit)
          }
          reply({ type: 'memories', memories })
          break
        }
        case 'delete_memory': {
          // 宿主删除记忆：id → 删单条；content → 按关键词批量删（隐私管理）
          const agent = getAgent(String(req.sessionId || 'default'))
          const store = (agent as any).store
          let deleted = 0
          if (typeof store?.deleteMemory === 'function' && req.id !== undefined && req.id !== null) {
            deleted = store.deleteMemory(Number(req.id)) ? 1 : 0
          } else if (typeof store?.deleteMemoriesByContent === 'function' && req.content) {
            deleted = store.deleteMemoriesByContent(String(req.content))
          }
          reply({ type: 'ok', sessionId: String(req.sessionId || 'default'), deleted })
          break
        }
        case 'tool_result': {
          const pendingTool = pending.get(String(req.id))
          if (pendingTool) {
            clearTimeout(pendingTool.timer)
            pending.delete(req.id)
            const r = req.result || {}
            pendingTool.resolve({
              success: r.success !== false,
              output: typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? r),
              error: r.error || undefined,
              denied: r.denied,
              alternative: r.alternative,
            })
          }
          break
        }
        case 'confirm_result': {
          // 宿主回传用户确认决策（v0.6.1）：响应 confirm 事件（弹窗结果）
          const id = req.id === undefined || req.id === null ? '' : String(req.id)
          if (!id) {
            reply({ type: 'error', message: 'confirm_result 需要 id 参数（confirm 事件携带的 id）' })
            break
          }
          const decision = String(req.decision || '')
          if (!(VALID_CONFIRM_DECISIONS as string[]).includes(decision)) {
            reply({ type: 'error', message: `confirm_result 需要合法 decision（${VALID_CONFIRM_DECISIONS.join('/')}）` })
            break
          }
          const pendingConfirm = pendingConfirms.get(id)
          if (!pendingConfirm) break // 未知/已超时的确认 id：静默忽略（不污染事件流）
          clearTimeout(pendingConfirm.timer)
          pendingConfirms.delete(id)
          pendingConfirm.resolve(decision as ConfirmDecision)
          break
        }
        case 'confirm_status': {
          // 宿主查询确认门状态（v0.6.8）：放行名单（会话级 + always 持久化）+ 当前确认名单配置（只读）
          const sessionId = String(req.sessionId || 'default')
          const gate = gates.get(sessionId)
          reply({
            type: 'confirm_status',
            sessionId,
            confirmTools,
            allowedTools: gate ? gate.listAllAllowed(confirmTools) : [],
            sessionAllowed: gate ? gate.listAllowed() : [],
            alwaysAllowed: gate ? gate.listAlwaysAllowed(confirmTools) : [],
          })
          break
        }
        case 'confirm_revoke': {
          // 宿主撤销确认门放行（v0.6.8）：
          //   { tool }            → 撤销该工具（会话级 + always 持久化同步清除，恢复每次确认）
          //   { resetSession: 1 } → 清空会话级放行（不影响 always 持久化）
          const sessionId = String(req.sessionId || 'default')
          const tool = req.tool === undefined || req.tool === null ? '' : String(req.tool).trim()
          const resetSession = req.resetSession === true || req.resetSession === 1 || req.resetSession === '1'
          if (!tool && !resetSession) {
            reply({ type: 'error', message: 'confirm_revoke 需要 tool 参数（要撤销放行的工具名），或 resetSession: true（清空会话级放行）' })
            break
          }
          const gate = gates.get(sessionId)
          if (gate) {
            if (resetSession) gate.resetSession()
            if (tool) gate.revoke(tool)
          }
          // 无 gate = 无放行记录：幂等 ok（服务不崩、状态不变）
          reply({ type: 'ok', sessionId, ...(tool ? { tool } : {}), ...(resetSession ? { resetSession: true } : {}) })
          break
        }
        case 'confirm_allow': {
          // 宿主显式放行确认工具（v0.6.10）：无需等 confirm 事件触发——
          //   { tool, mode? } mode: session（默认，本会话内不再确认）| always（跨会话持久化）
          const sessionId = String(req.sessionId || 'default')
          const tool = req.tool === undefined || req.tool === null ? '' : String(req.tool).trim()
          if (!tool) {
            reply({ type: 'error', message: 'confirm_allow 需要 tool 参数（要放行的工具名）' })
            break
          }
          const mode = req.mode === undefined || req.mode === null ? 'session' : String(req.mode).toLowerCase()
          if (mode !== 'session' && mode !== 'always') {
            reply({ type: 'error', message: 'confirm_allow 需要合法 mode（session 本会话放行 / always 跨会话持久化）' })
            break
          }
          const gate = getGate(sessionId)
          if (mode === 'always') gate.allowAlways(tool)
          else gate.allowSession(tool)
          reply({ type: 'ok', sessionId, tool, mode })
          break
        }
        case 'tools': {
          // 宿主查询当前会话 Agent 可用工具清单（v0.6.11，只读不生成）：
          //   名称/描述/参数 + 确认门标注（confirmed）+ 来源（host/profile/mcp/builtin）
          //   宿主面板"AI 可用工具 + 哪些写回类工具需确认"的数据源
          const sessionId = String(req.sessionId || 'default')
          const entry = agents.get(sessionId)
          const toolMeta = entry?.toolMeta ?? describeTools(builtinTools, confirmTools)
          reply({ type: 'tools', sessionId, tools: toolMeta, confirmTools })
          break
        }
        case 'models': {
          // 宿主查询可切换模型（v0.6.9）：当前配置主/视觉模型端点信息 + 本地 Ollama 模型列表（只读，不触发生成）
          reply({ type: 'models', ...(await collectModelInfo()) })
          break
        }
        case 'get_config': {
          // 宿主查询服务器运行配置（v0.6.18，只读不触发生成）——面板"设置/关于"数据源：
          //   确认门配置、默认采样/裁剪参数、工具超时、namespace、storage、MCP 服务器清单（不含密钥）
          reply({
            type: 'config',
            confirmTools,
            confirmTimeoutMs,
            defaultMaxTokens: opts.defaultMaxTokens ?? null,
            defaultTemperature: opts.defaultTemperature ?? null,
            defaultMaxContextMessages: opts.defaultMaxContextMessages ?? null,
            defaultMaxContextTokens: opts.defaultMaxContextTokens ?? null,
            defaultContextSummarize: opts.defaultContextSummarize ?? null,
            defaultToolOutputPolicy: opts.defaultToolOutputPolicy ?? null,
            toolTimeoutMs,
            namespace: namespace ?? null,
            storage: typeof storage === 'string' ? storage : null,
            mcpServers: (opts.mcp || []).map((m) => ({
              name: m.name,
              transport: m.url ? 'http' : 'stdio',
            })),
          })
          break
        }
        case 'mcp_status': {
          // 宿主查看 MCP 服务器连接状态（v0.5.5；等待启动时的后台连接落定，保证确定性）
          await Promise.allSettled(mcpConnects)
          reply({ type: 'mcp_status', servers: mcpManager.status() })
          break
        }
        case 'mcp_resources': {
          // 宿主查看已连接 MCP 服务器的资源/模板清单（v0.6.26；只读，不触发生成、不创建会话）——
          // 资源桥接：连接时拉取 resources/list + resources/templates/list，此处按服务器分组透传
          await Promise.allSettled(mcpConnects)
          const servers = mcpManager.status().map((s) => ({
            name: s.name,
            connected: s.connected,
            toolCount: s.toolCount,
            ...(s.connected
              ? {
                  resources: mcpManager.getAllResources().filter((r) => r.server === s.name),
                  templates: mcpManager.getAllResourceTemplates().filter((t) => t.server === s.name),
                }
              : {}),
            ...(s.error ? { error: s.error } : {}),
          }))
          reply({ type: 'mcp_resources', servers })
          break
        }
        default:
          reply({ type: 'error', message: `未知请求类型: ${req.type}` })
      }
    } catch (e: any) {
      reply({ type: 'error', message: e?.message || String(e) })
    }
  })

  return {
    close: () => rl.close(),
  }
}
