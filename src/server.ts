/**
 * Flare 宿主协议服务（最小版）
 *
 * 供非 Node 宿主（Qt 等）通过 stdin/stdout JSON Lines 调用 flare 引擎：
 *   - chat（流式）/ cancel / set_context / list_sessions / tool_result
 *   - 宿主代理工具：宿主在 chat 请求声明 tools，服务经 tool_execute 事件请宿主执行
 *
 * 用法：
 *   flare server --profile <expert.json> --storage <db-path>
 * 或编程方式：
 *   startHostServer({ profile, storage })
 */

import { createInterface } from 'node:readline'
import { Agent, profileToConfig, type ExpertProfile, type ToolDefinition, type Tool, type ToolResult } from './index.js'

export interface HostServerOptions {
  profile: ExpertProfile
  storage?: string
  /** 工具执行超时（毫秒），默认 30s */
  toolTimeoutMs?: number
  /** 消息来源标识（记忆库隔离用） */
  namespace?: string
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
  const agents = new Map<string, Agent>()
  const cancels = new Map<string, { cancelled: boolean }>()
  const pending = new Map<string, PendingTool>()

  const reply = (msg: any) => {
    process.stdout.write(JSON.stringify(msg) + '\n')
  }

  const getAgent = (sessionId: string, tools?: ToolDefinition[]): Agent => {
    let agent = agents.get(sessionId)
    if (!agent) {
      const hostTools = tools && tools.length > 0
        ? makeHostTools(tools, reply, pending, toolTimeoutMs)
        : undefined
      agent = new Agent({
        ...profileToConfig(profile),
        ...(hostTools ? { tools: hostTools } : {}),
        sessionId: namespace ? `${namespace}:${sessionId}` : sessionId,
        storage,
      })
      agents.set(sessionId, agent)
    }
    return agent
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
          const agent = getAgent(sessionId, req.tools)
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
          const sessions = (typeof (agent as any).memoryStore?.getAllSessions === 'function')
            ? await (agent as any).memoryStore.getAllSessions()
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
          const messages = (typeof (agent as any).memoryStore?.getMessages === 'function')
            ? await (agent as any).memoryStore.getMessages(sid)
            : []
          reply({ type: 'messages', sessionId, messages })
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
