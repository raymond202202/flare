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
  tools as builtinTools,
  type ExpertProfile,
  type ToolDefinition,
  type Tool,
  type ToolResult,
  type McpServerConfig,
  type ConfirmDecision,
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
}

/** 默认需确认的工具（v0.6.1）：AI 写持久记忆前经确认门（宿主弹窗"AI 想记住…"，用户知情授权） */
export const DEFAULT_CONFIRM_TOOLS = ['memory_save']

/** 合法确认决策（confirm_result 请求校验用） */
const VALID_CONFIRM_DECISIONS: ConfirmDecision[] = ['allow_once', 'allow_session', 'always', 'deny', 'alternative']

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

const llmOptsChanged = (a?: LlmChatOpts, b?: LlmChatOpts): boolean =>
  (a?.maxTokens ?? undefined) !== (b?.maxTokens ?? undefined) ||
  (a?.temperature ?? undefined) !== (b?.temperature ?? undefined)

/** 启动宿主协议服务（阻塞读 stdin） */
export function startHostServer(opts: HostServerOptions) {
  const { profile, storage, toolTimeoutMs = 30000, namespace } = opts
  // 确认门配置（v0.6.1）：名单默认写回类工具；显式传空数组 = 关闭
  const confirmTools = opts.confirmTools ?? DEFAULT_CONFIRM_TOOLS
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? 30000
  // 会话 → { agent, model, llmOpts }：model / 采样控制变化时重建 Agent（同 sessionId，历史从记忆库恢复）
  const agents = new Map<string, { agent: Agent; model?: string; llmOpts?: LlmChatOpts }>()
  const cancels = new Map<string, { cancelled: boolean }>()
  const pending = new Map<string, PendingTool>()
  // 确认门（v0.6.1）：按 sessionId 缓存——allow_session 放行记忆跨模型重建保留；always 持久化到记忆库 settings 表
  const gates = new Map<string, ConfirmationGate>()
  // 挂起的确认请求：confirm 事件发出后等待宿主 confirm_result
  const pendingConfirms = new Map<string, { resolve: (d: ConfirmDecision) => void; timer: NodeJS.Timeout }>()
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
   */
  const askHostConfirm = (sessionId: string, toolName: string, args: Record<string, any>): Promise<ConfirmDecision> => {
    return new Promise((resolve) => {
      const id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      const timer = setTimeout(() => {
        pendingConfirms.delete(id)
        resolve('deny')
      }, confirmTimeoutMs + 5000)
      timer.unref?.()
      pendingConfirms.set(id, { resolve, timer })
      reply({ type: 'confirm', sessionId, id, name: toolName, args: args || {} })
    })
  }

  /** 会话确认门（v0.6.1，按 sessionId 缓存）：confirmer = 宿主弹窗（confirm 事件）；always 持久化到记忆库 settings 表 */
  const getGate = (sessionId: string): ConfirmationGate => {
    let gate = gates.get(sessionId)
    if (!gate) {
      const kv = memoryStoreKv(storage ? new MemoryStore(storage) : getMemoryStore())
      gate = new ConfirmationGate({
        confirmer: (toolName, args) => askHostConfirm(sessionId, toolName, args),
        sessionId,
        store: kv,
        timeoutMs: confirmTimeoutMs,
      })
      gates.set(sessionId, gate)
    }
    return gate
  }

  const getAgent = (sessionId: string, tools?: ToolDefinition[], model?: string, llmOpts?: LlmChatOpts): Agent => {
    let entry = agents.get(sessionId)
    // 请求带 model 且与会话当前模型不同 → 重建；采样控制（maxTokens/temperature）任一变化 → 重建（立即生效）
    if (entry && ((model && entry.model !== model) || llmOptsChanged(entry.llmOpts, llmOpts))) {
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
      entry = {
        agent: new Agent({
          ...profileToConfig(profile),
          ...(gatedTools.length > 0 ? { tools: gatedTools } : {}),
          ...(llm ? { llm } : {}),
          sessionId: namespace ? `${namespace}:${sessionId}` : sessionId,
          storage,
        }),
        model,
        llmOpts,
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
          const agent = getAgent(sessionId, req.tools, req.model ? String(req.model) : undefined, llmOpts)
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
          const sessionId = String(req.sessionId || 'default')
          const agent = getAgent(sessionId)
          // Agent 内部 sessionId 可能带 namespace 前缀，用它查询才一致
          const sid = (agent as any).config?.sessionId || sessionId
          const messages = (typeof (agent as any).store?.getMessages === 'function')
            ? await (agent as any).store.getMessages(sid)
            : []
          reply({ type: 'messages', sessionId, messages })
          break
        }
        case 'get_usage': {
          // 宿主读取 token 用量统计（同 get_messages 模式，只读不生成）
          const agent = getAgent(String(req.sessionId || 'default'))
          const stats = (typeof (agent as any).store?.getUsageStats === 'function')
            ? await (agent as any).store.getUsageStats()
            : { promptTokens: 0, completionTokens: 0, totalTokens: 0, sessionCount: 0 }
          reply({ type: 'usage', stats })
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
          const agent = getAgent(String(req.sessionId || 'default'))
          const q = req.query ? String(req.query).trim() : ''
          const limit = Math.min(Math.max(Number(req.limit) || 50, 1), 100)
          const store = (agent as any).store
          const memories = (q && typeof store?.searchMemories === 'function')
            ? store.searchMemories(q, limit)
            : (typeof store?.getAllMemories === 'function')
              ? store.getAllMemories().slice(0, limit)
              : []
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
        case 'mcp_status': {
          // 宿主查看 MCP 服务器连接状态（v0.5.5；等待启动时的后台连接落定，保证确定性）
          await Promise.allSettled(mcpConnects)
          reply({ type: 'mcp_status', servers: mcpManager.status() })
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
