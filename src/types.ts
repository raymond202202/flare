/**
 * Flare 引擎公共类型
 */

import type { Tool } from './tools/index.js'

/**
 * 领域专家配置（Expert Profile）
 *
 * 应用通过注入工具、人设、品牌话术、存储路径，
 * 把通用引擎定制为领域专家（如 Pulse 的网络专家、StorySpire 的写作专家）。
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

/**
 * 从 ExpertProfile 生成 AgentConfig（便于应用直接对接）
 */
export function profileToConfig(profile: ExpertProfile): {
  systemPrompt?: string
  tools?: Tool[]
  storage?: string
  identity?: string
  flareIntro?: string
} {
  return {
    systemPrompt: profile.systemPrompt,
    tools: profile.tools,
    storage: profile.storage,
    identity: profile.identity,
    flareIntro: profile.flareIntro,
  }
}
