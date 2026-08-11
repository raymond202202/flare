/**
 * 工具输出治理（v0.6.30）
 *
 * 按工具类型定制工具结果的截断策略——纯函数（无网络 / 无依赖 / 可离线确定性单测）。
 *
 * 背景：Agent.run 循环原来对所有工具统一 `output.slice(0, 2000)`，两类明显浪费：
 *   - 探索型工具（read_file / search_files）：长文件只留了头部，**尾部丢掉**（AI 常需要看
 *     文件结尾/匹配列表尾部）；统一截断还可能把有用的中间内容整体错过
 *   - 终端类工具（terminal）：命令输出最有价值的信息在**尾部**（执行结果、报错堆栈），
 *     统一头部截断把尾部丢掉
 *
 * 策略（内置，按工具名匹配；不匹配走默认，与旧版逐字符一致——零回归）：
 *   - 默认：成功 output 前 2000 字符 / 失败 error 前 1000 字符（与旧版 slice 完全一致）
 *   - 探索型（read_file / search_files）：**留头尾**——头部 headChars + 省略标记 + 尾部
 *     tailChars（总长不超预算）
 *   - 终端型（terminal）：**留尾部**——尾部 tailChars + 省略标记（总长不超预算）
 *
 * 所有截断都保证总长 ≤ 预算（省略标记计入预算），且省略标记带被省略的字符数，
 * AI 可据此判断是否值得用 offset/limit 重新读取。
 */

/** 探索型工具：读文件/搜索类——长输出留头尾（头部上下文 + 尾部最新） */
const EXPLORATORY_TOOLS: ReadonlySet<string> = new Set(['read_file', 'search_files'])
/** 终端型工具：命令执行类——长输出留尾部（结果/报错在尾部最有价值） */
const TERMINAL_TOOLS: ReadonlySet<string> = new Set(['terminal'])

/** 省略标记模板：{omitted} 会被替换为被省略的字符数 */
export const DEFAULT_ELLIPSIS = '\n…[中间省略 {omitted} 字符]…\n'

export interface ToolOutputPolicy {
  /** 成功输出最大字符数（默认 2000） */
  maxOutputChars?: number
  /** 失败错误信息最大字符数（默认 1000） */
  maxErrorChars?: number
  /** 探索型工具头部保留字符数（默认 1200） */
  headChars?: number
  /** 探索型/终端型工具尾部保留字符数（探索型默认 700；终端型默认跟随 maxOutputChars） */
  tailChars?: number
  /** 省略标记（默认 DEFAULT_ELLIPSIS；不含 {omitted} 则直接使用） */
  ellipsis?: string
}

/** 工具分类（库导出，供宿主预览策略/自绘） */
export type ToolOutputKind = 'default' | 'exploratory' | 'terminal'

/** 按工具名判断截断分类（纯函数，库导出） */
export function toolOutputKind(toolName: string): ToolOutputKind {
  if (EXPLORATORY_TOOLS.has(toolName)) return 'exploratory'
  if (TERMINAL_TOOLS.has(toolName)) return 'terminal'
  return 'default'
}

function buildEllipsis(template: string, omitted: number): string {
  return template.includes('{omitted}') ? template.replace('{omitted}', String(omitted)) : template
}

/** 留尾部截断：省略标记在前（提示有内容被裁），保证总长 ≤ budget */
function truncateTail(output: string, tailChars: number, budget: number, ellipsis: string): string {
  if (output.length <= budget) return output
  const safeTail = Math.max(1, Math.min(tailChars, budget))
  const ell = buildEllipsis(ellipsis, output.length - safeTail)
  // 尾部保留 budget - ell.length（标记计入预算，总长严格不超）
  const keep = Math.max(1, budget - ell.length)
  return ell + output.slice(-keep)
}

/** 留头尾截断：头部 + 省略标记 + 尾部，总长 ≤ budget */
function truncateHeadTail(output: string, headChars: number, tailChars: number, budget: number, ellipsis: string): string {
  if (output.length <= budget) return output
  const head = Math.max(0, Math.min(headChars, budget))
  const tail = Math.max(0, Math.min(tailChars, budget))
  const ell = buildEllipsis(ellipsis, Math.max(0, output.length - head - tail))
  const headKeep = Math.min(head, Math.max(0, budget - ell.length))
  const tailKeep = Math.max(0, Math.min(tail, budget - headKeep - ell.length))
  return output.slice(0, headKeep) + ell + output.slice(-tailKeep)
}

/**
 * 按工具类型治理工具结果输出（v0.6.30，纯函数）
 *
 * @param toolName 工具名（决定截断策略分类）
 * @param result 工具执行结果（ToolResult 形状子集）
 * @param opts 策略覆盖（全部可选；缺省与旧版统一 slice 逐字符一致）
 * @returns 截断后的字符串（成功=输出，失败=错误信息）
 */
export function truncateToolOutput(
  toolName: string,
  result: { success: boolean; output?: string; error?: string },
  opts: ToolOutputPolicy = {},
): string {
  const maxOutputChars = opts.maxOutputChars ?? 2000
  const maxErrorChars = opts.maxErrorChars ?? 1000
  const ellipsis = opts.ellipsis ?? DEFAULT_ELLIPSIS

  if (!result.success) {
    const err = result.error || '执行失败'
    return err.slice(0, maxErrorChars)
  }

  const output = result.output || ''
  const kind = toolOutputKind(toolName)
  if (kind === 'exploratory') {
    return truncateHeadTail(output, opts.headChars ?? 1200, opts.tailChars ?? 700, maxOutputChars, ellipsis)
  }
  if (kind === 'terminal') {
    return truncateTail(output, opts.tailChars ?? maxOutputChars, maxOutputChars, ellipsis)
  }
  return output.slice(0, maxOutputChars)
}
