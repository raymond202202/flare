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
import { Agent, createProvider, profileToConfig, McpManager, type ExpertProfile, type ToolDefinition, type Tool, type ToolResult, type McpServerConfig } from './index.js'

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

/** 启动宿主协议服务（阻塞读 stdin） */
export function startHostServer(opts: HostServerOptions) {
  const { profile, storage, toolTimeoutMs = 30000, namespace } = opts
  // 会话 → { agent, model }：model 变化时重建 Agent（同 sessionId，历史从记忆库恢复）
  const agents = new Map<string, { agent: Agent; model?: string }>()
  const cancels = new Map<string, { cancelled: boolean }>()
  const pending = new Map<string, PendingTool>()
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

  const getAgent = (sessionId: string, tools?: ToolDefinition[], model?: string): Agent => {
    let entry = agents.get(sessionId)
    // 请求带 model 且与会话当前模型不同 → 重建（新模型立即生效）
    if (entry && model && entry.model !== model) {
      entry = undefined
    }
    if (!entry) {
      const hostTools = tools && tools.length > 0
        ? makeHostTools(tools, reply, pending, toolTimeoutMs)
        : undefined
      // model 字段 → 指定主模型 provider（如本地 Ollama qwen2.5:7b）；缺省用默认路由
      const llm = model ? createProvider({ model }) : undefined
      // MCP 工具（v0.5.5）：已连接的服务器工具并入工具集（与宿主代理工具/专家工具并存）
      const mcpTools = mcpManager.getAllTools()
      const mergedTools = [...(hostTools || profile.tools || []), ...mcpTools]
      entry = {
        agent: new Agent({
          ...profileToConfig(profile),
          ...(mergedTools.length > 0 ? { tools: mergedTools } : {}),
          ...(llm ? { llm } : {}),
          sessionId: namespace ? `${namespace}:${sessionId}` : sessionId,
          storage,
        }),
        model,
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
          const agent = getAgent(sessionId, req.tools, req.model ? String(req.model) : undefined)
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
