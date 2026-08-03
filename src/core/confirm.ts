/**
 * 工具确认机制（写入/覆盖类操作的用户授权）
 *
 * withConfirmation 包装一个工具：执行前调用宿主注入的 confirmer（如弹窗让用户选择），
 * 用户拒绝则不执行原工具，返回"用户拒绝"结果——AI 收到后自然调整策略。
 * 不动 Agent.run() 核心循环，Pulse/StorySpire 等宿主只需注入自己的确认器。
 */

import { Tool, ToolResult } from '../tools/index.js'

/** 用户确认决策 */
export type ConfirmDecision = 'allow_once' | 'allow_session' | 'always' | 'deny' | 'alternative'

/** 宿主注入的确认器：返回用户决策（可异步，如等待弹窗） */
export type Confirmer = (toolName: string, args: Record<string, any>) => Promise<ConfirmDecision> | ConfirmDecision

/**
 * 包装工具：执行前先确认
 * - allow_once / allow_session / always → 执行原工具
 * - deny → 返回"用户拒绝"（不执行）
 * - alternative → 返回"用户要求替代方案"（不执行）
 */
export function withConfirmation(tool: Tool, confirmer: Confirmer): Tool {
  return {
    ...tool,
    execute: async (args: Record<string, any>): Promise<ToolResult> => {
      const decision = await confirmer(tool.definition.function.name, args || {})
      if (decision === 'deny') {
        return {
          success: false,
          output: '',
          error: '用户拒绝了此操作（已提示：写入前需要确认）',
          denied: true,
        }
      }
      if (decision === 'alternative') {
        return {
          success: false,
          output: '',
          error: '用户要求提供替代方案（不要直接写入，先和用户讨论其他选择）',
          alternative: true,
        }
      }
      // allow_once / allow_session / always → 执行原工具
      return tool.execute(args)
    },
  }
}

/** 判断工具结果是否为用户拒绝 */
export function isDenied(result: ToolResult): boolean {
  return !!(result as any)?.denied
}
