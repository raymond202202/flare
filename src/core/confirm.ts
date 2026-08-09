/**
 * 工具确认机制（写入/覆盖类操作的用户授权）
 *
 * withConfirmation 包装一个工具：执行前调用宿主注入的 confirmer（如弹窗让用户选择），
 * 用户拒绝则不执行原工具，返回"用户拒绝"结果——AI 收到后自然调整策略。
 * 不动 Agent.run() 核心循环，Pulse/StorySpire 等宿主只需注入自己的确认器。
 *
 * ConfirmationGate（v0.5.7）：有状态确认门
 * - allow_session 记忆化：本会话内同一工具不再重复确认（按 sessionId 隔离）
 * - always 持久化：注入 KV store（MemoryStore settings 表天然满足）后跨会话记住
 * - 确认超时：confirmer 超时未决按安全默认（deny）处理，结果带 timeout 标记
 * - revoke / listAllowed / isAllowed / resetSession：管理放行名单
 */

import { Tool, ToolResult } from '../tools/index.js'

/** 用户确认决策 */
export type ConfirmDecision = 'allow_once' | 'allow_session' | 'always' | 'deny' | 'alternative'

/** 宿主注入的确认器：返回用户决策（可异步，如等待弹窗） */
export type Confirmer = (toolName: string, args: Record<string, any>) => Promise<ConfirmDecision> | ConfirmDecision

/** always 决策的持久化存储（MemoryStore 的 settings 表天然满足：getSetting/setSetting，空串=删除） */
export interface ConfirmKeyValueStore {
  get(key: string): string | null
  set(key: string, value: string): void
}

/** ConfirmationGate 选项 */
export interface ConfirmationGateOptions {
  confirmer: Confirmer
  /** 会话标识（默认 'default'）：allow_session 记忆按会话隔离 */
  sessionId?: string
  /** always 决策的持久化存储（可选）；不注入则 always 退化为会话级 */
  store?: ConfirmKeyValueStore
  /** 确认超时毫秒（默认 30000，与 server tool_execute 超时一致）；超时按安全默认处理 */
  timeoutMs?: number
  /** 超时默认决策（默认 'deny' 安全；低风险工具可配 'allow_once'） */
  timeoutDecision?: 'deny' | 'allow_once'
}

/** withConfirmation 的可选参数（向后兼容：原签名 withConfirmation(tool, confirmer) 不变） */
export type WithConfirmationOptions = Omit<ConfirmationGateOptions, 'confirmer'>

/** MemoryStore（settings 表）→ ConfirmKeyValueStore 适配器：always 决策持久化到记忆库 */
export function memoryStoreKv(store: {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
}): ConfirmKeyValueStore {
  return {
    get: (key) => store.getSetting(key),
    set: (key, value) => store.setSetting(key, value),
  }
}

/**
 * 有状态确认门：在 withConfirmation 基础上增加放行记忆化与超时保护。
 *
 * 决策规则：
 * - allow_once       → 执行，不记忆
 * - allow_session    → 执行，本会话内该工具不再确认
 * - always           → 执行，持久化放行（需 store；无 store 时仅会话内生效）
 * - deny             → 拒绝（denied: true，不执行）
 * - alternative      → 要求替代方案（alternative: true，不执行）
 * - confirmer 超时/抛错 → 按 timeoutDecision 处理（默认 deny，安全）
 */
export class ConfirmationGate {
  private readonly confirmer: Confirmer
  private readonly sessionId: string
  private readonly store?: ConfirmKeyValueStore
  private readonly timeoutMs: number
  private readonly timeoutDecision: 'deny' | 'allow_once'
  /** 会话级放行（allow_session / 本会话内产生的 always） */
  private sessionAllowed = new Set<string>()

  constructor(options: ConfirmationGateOptions) {
    this.confirmer = options.confirmer
    this.sessionId = options.sessionId ?? 'default'
    this.store = options.store
    this.timeoutMs = options.timeoutMs ?? 30000
    this.timeoutDecision = options.timeoutDecision ?? 'deny'
  }

  /** always 决策的持久化键 */
  private alwaysKey(toolName: string): string {
    return `confirm.always.${toolName}`
  }

  /** 判断工具是否被 always 持久化放行 */
  private isAlwaysPersisted(toolName: string): boolean {
    return !!this.store && !!this.store.get(this.alwaysKey(toolName))
  }

  /** 查询某工具当前是否被放行（持久化 always 或会话级） */
  isAllowed(toolName: string): boolean {
    return this.isAlwaysPersisted(toolName) || this.sessionAllowed.has(toolName)
  }

  /** 包装工具：命中放行记忆直接执行，否则调 confirmer 决策 */
  wrap(tool: Tool): Tool {
    const name = tool.definition.function.name
    return {
      ...tool,
      execute: async (args: Record<string, any>): Promise<ToolResult> => {
        // 放行记忆：always（持久化）或 allow_session（会话内）→ 不再打扰用户
        if (this.isAllowed(name)) {
          return tool.execute(args)
        }
        const { decision, timedOut } = await this.confirmWithTimeout(name, args || {})
        switch (decision) {
          case 'deny':
            return {
              success: false,
              output: '',
              error: timedOut
                ? '确认超时：用户未在时限内决策，已按拒绝处理'
                : '用户拒绝了此操作（已提示：写入前需要确认）',
              denied: true,
              // 仅超时时才带 timeout 标记（正常拒绝/抛错拒绝不标记）
              ...(timedOut ? { timeout: true } : {}),
            }
          case 'alternative':
            return {
              success: false,
              output: '',
              error: '用户要求提供替代方案（不要直接写入，先和用户讨论其他选择）',
              alternative: true,
            }
          case 'allow_session':
            this.sessionAllowed.add(name)
            return tool.execute(args)
          case 'always':
            this.sessionAllowed.add(name)
            if (this.store) this.store.set(this.alwaysKey(name), '1')
            return tool.execute(args)
          default: // allow_once
            return tool.execute(args)
        }
      },
    }
  }

  /** 显式放行：本会话内不再确认该工具 */
  allowSession(toolName: string): void {
    this.sessionAllowed.add(toolName)
  }

  /** 显式永久放行：跨会话记住（需注入 store；无 store 时仅会话内生效） */
  allowAlways(toolName: string): void {
    this.sessionAllowed.add(toolName)
    if (this.store) this.store.set(this.alwaysKey(toolName), '1')
  }

  /** 撤销放行（会话级 + 持久化同步清除） */
  revoke(toolName: string): void {
    this.sessionAllowed.delete(toolName)
    if (this.store) this.store.set(this.alwaysKey(toolName), '')
  }

  /** 查看当前会话级放行名单（always 持久化名单可用 isAllowed 逐个查询） */
  listAllowed(): string[] {
    return [...this.sessionAllowed]
  }

  /**
   * 查看 always 持久化放行名单（v0.6.8）：KV store 无法枚举 key，按候选名单逐个查询。
   * candidates 应为当前确认名单（如 server 的 confirmTools）——被包装的工具才可能产生 always。
   */
  listAlwaysAllowed(candidates: string[]): string[] {
    return candidates.filter((name) => this.isAlwaysPersisted(name))
  }

  /**
   * 查看完整放行名单（v0.6.8）：会话级 + always 持久化合并（按候选顺序去重）。
   * 宿主确认门管理面板用：展示哪些工具当前已被放行（不再弹窗）。
   */
  listAllAllowed(candidates: string[]): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const name of candidates) {
      if (seen.has(name)) continue
      if (this.isAlwaysPersisted(name) || this.sessionAllowed.has(name)) {
        seen.add(name)
        out.push(name)
      }
    }
    // 会话级放行中不在候选名单的工具（如显式 allowSession 的非名单工具）也并入
    for (const name of this.sessionAllowed) {
      if (!seen.has(name)) {
        seen.add(name)
        out.push(name)
      }
    }
    return out
  }

  /** 清空会话级放行（不影响持久化 always） */
  resetSession(): void {
    this.sessionAllowed.clear()
  }

  /**
   * 调用 confirmer 并施加超时。
   * - confirmer 超时未决 → timeoutDecision（默认 deny），timedOut: true
   * - confirmer 抛错 → deny（安全默认），timedOut: false
   */
  private confirmWithTimeout(toolName: string, args: Record<string, any>): Promise<{ decision: ConfirmDecision; timedOut: boolean }> {
    return new Promise((resolve) => {
      let done = false
      let handle: NodeJS.Timeout | undefined
      const finish = (decision: ConfirmDecision, timedOut: boolean) => {
        if (done) return
        done = true
        if (handle) clearTimeout(handle)
        resolve({ decision, timedOut })
      }
      handle = setTimeout(() => finish(this.timeoutDecision, true), this.timeoutMs)
      // 不阻塞进程退出（confirmer 长期未决时进程可正常结束）
      handle.unref?.()
      Promise.resolve()
        .then(() => this.confirmer(toolName, args))
        .then(
          (d) => finish(d, false),
          () => finish('deny', false),
        )
    })
  }
}

/**
 * 包装工具：执行前先确认
 * - allow_once / allow_session / always → 执行原工具
 * - deny → 返回"用户拒绝"（不执行）
 * - alternative → 返回"用户要求替代方案"（不执行）
 *
 * 默认无状态（每次调 confirmer）；传入 options（store/timeoutMs/sessionId）后
 * 内部委托 ConfirmationGate，获得 allow_session/always 记忆化 + 超时保护。
 */
export function withConfirmation(tool: Tool, confirmer: Confirmer, options?: WithConfirmationOptions): Tool {
  return new ConfirmationGate({ confirmer, ...options }).wrap(tool)
}

/** 判断工具结果是否为用户拒绝 */
export function isDenied(result: ToolResult): boolean {
  return !!(result as any)?.denied
}
