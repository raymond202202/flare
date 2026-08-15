/**
 * 本地小模型路由（v0.6.134，混合模式方向）
 *
 * 混合模式：简单任务走本地小模型（省钱/隐私/离线），复杂任务走线上主模型（保质量）。
 * 纯外围增强：不改 Agent.run 核心循环——路由决策由宿主/CLI 在调用 provider 前按需使用。
 *
 * - classifyTaskComplexity：规则/启发式任务复杂度分类（零网络、零 LLM 调用）
 * - routeTaskModel：按复杂度返回应使用的模型（simple → 本地路由模型；complex → 主模型）
 */

import { config } from './config.js'
import { detectProvider } from './models.js'

export type TaskComplexity = 'simple' | 'complex'

/** 简单任务特征词（分类/抽取/摘要/模板化/简单问答） */
const SIMPLE_HINTS = [
  '分类', '抽取', '提取', '摘要', '概括', '总结', '翻译', '格式化', '模板',
  '重命名', '列出', '列举', '关键词', '标题', '润色', '缩写', '纠错',
  '简单问答', '解释一下这个词', '什么意思',
]

/** 复杂任务特征词（推理/长代码/创作） */
const COMPLEX_HINTS = [
  '分析', '推理', '为什么', '原因', '对比', '比较', '评估', '设计', '架构',
  '优化', '调试', '重构', '推导', '证明', '规划', '方案', '实现',
  '创作', '写一篇', '写个故事', '写故事', '写文章', '写代码', '写诗', '小说', '剧本', '算法',
  '复杂度', '设计模式', '代码审查', '性能分析',
]

/** 代码特征标记（长代码/代码任务） */
const CODE_MARKERS = [
  '```', 'function ', 'const ', 'let ', 'import ', 'export ', 'class ',
  'def ', '=>', 'async ', 'await ', 'return ', '{', '}',
]

/** 代码特征检测：命中任一标记视为代码任务（长代码） */
function hasCode(text: string): boolean {
  return CODE_MARKERS.some((m) => text.includes(m))
}

/**
 * 任务复杂度分类（纯函数，规则/启发式，零网络、零 LLM 调用）。
 *
 * 规则（按优先级）：
 * 1. 代码特征（``` / function / import / 花括号等）→ complex（长代码/代码任务）
 * 2. 复杂特征词（分析/推理/为什么/对比/设计/创作/算法等）→ complex
 * 3. 长文本（> 300 字符）→ complex（需要上下文理解/推理）
 * 4. 简单特征词（分类/抽取/摘要/翻译/格式化等）→ simple
 * 5. 默认：短文本无特征 → simple（简单问答/闲聊）
 */
export function classifyTaskComplexity(text: string): TaskComplexity {
  return classifyTaskDetail(text).tier
}

/** 分类结果（含命中特征能力标签，v0.6.143） */
export interface TaskClassification {
  tier: TaskComplexity
  /** 命中的分类依据（人类可读能力标签：代码特征 / 复杂特征词 / 长文本 / 简单特征词 / 默认） */
  feature: string
}

/**
 * 任务复杂度分类（含命中特征说明，v0.6.143）。
 *
 * 判定顺序与 classifyTaskComplexity 完全一致（同一规则集），额外返回命中的能力标签，
 * 供 CLI route 展示「为什么这样路由」（宿主可据此做统计/审计）。
 */
export function classifyTaskDetail(text: string): TaskClassification {
  const t = (text || '').trim()
  if (!t) return { tier: 'simple', feature: '空文本默认简单' }
  if (hasCode(t)) return { tier: 'complex', feature: '代码特征（长代码/代码任务）' }
  if (COMPLEX_HINTS.some((h) => t.includes(h))) return { tier: 'complex', feature: '复杂特征词（分析/推理/创作/算法等）' }
  if (t.length > 300) return { tier: 'complex', feature: '长文本（>300 字符，需上下文理解）' }
  if (SIMPLE_HINTS.some((h) => t.includes(h))) return { tier: 'simple', feature: '简单特征词（分类/抽取/摘要/翻译/格式化等）' }
  return { tier: 'simple', feature: '短文本默认简单（问答/闲聊）' }
}

/** 路由决策结果 */
export interface RouteTaskResult {
  tier: TaskComplexity
  /** 应使用的模型名 */
  model: string
  /** provider 推断（复用 core/models.ts detectProvider：含 ':' → ollama / deepseek / openai / other） */
  provider: 'ollama' | 'deepseek' | 'openai' | 'other'
  /** 决策原因（人类可读，CLI 展示用） */
  reason: string
  /** 分类命中特征能力标签（v0.6.143：如「代码特征」「复杂特征词」「简单特征词」） */
  feature: string
}

/**
 * 按任务复杂度返回应使用的模型（纯决策，不发起任何调用）。
 *
 * - simple → 本地路由模型（LOCAL_MODEL 配置；未配置回退主模型并注明）
 * - complex → 主模型（DEFAULT_MODEL 配置）
 *
 * @param text 任务文本
 * @param opts 显式指定模型（缺省从 config 读取：LOCAL_MODEL / DEFAULT_MODEL）
 */
export function routeTaskModel(
  text: string,
  opts: { localModel?: string; mainModel?: string } = {}
): RouteTaskResult {
  const { tier, feature } = classifyTaskDetail(text)
  const localModel = (opts.localModel || config.get('LOCAL_MODEL') || '').trim()
  const mainModel = (opts.mainModel || config.get('DEFAULT_MODEL') || 'deepseek-chat').trim()

  if (tier === 'simple') {
    const model = localModel || mainModel
    return {
      tier,
      model,
      provider: detectProvider(model),
      reason: localModel
        ? '简单任务 → 本地模型（省钱/隐私/离线）'
        : '简单任务 → 未配置 LOCAL_MODEL，回退主模型',
      feature,
    }
  }
  return {
    tier,
    model: mainModel,
    provider: detectProvider(mainModel),
    reason: '复杂任务 → 线上主模型（保质量）',
    feature,
  }
}
