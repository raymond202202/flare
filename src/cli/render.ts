/**
 * CLI 渲染层（P0-B / S0：从 index.ts 抽出，**零行为变化**）
 *
 * S0 阶段只做搬移：composeFrame() 产出的字节序列与旧 renderFrame() 逐字节等价
 * （`\x1b[2J\x1b[H` 全屏清屏重绘），便于 S1 换成「追加式内容 + 底部固定输入栏」时
 * 只改这一个文件的实现，index.ts 里 40 个 handler 一行不动。
 *
 * 为什么抽出来：src/cli/index.ts 3429 行，渲染逻辑和命令注册混在一起，
 * 输入层因此长期没有单元测试（审计 2026-10-17 结论）。抽成纯函数后，
 * composeFrame({...}) → 写入序列 可直接断言，不需要真 TTY。
 */

/** 内容区起始行（0 基）：banner 4 行 + 空行 + 提示语行 */
export const CONTENT_ROW = 6

/** 帧状态输入（全部由调用方准备好，本模块不读终端状态，保证可测） */
export interface FrameInput {
  /** 火焰 banner（含末尾换行；renderFlameFrame 产物） */
  banner: string
  /** 固定提示语行（如「输入 /help 查看命令」） */
  hint: string
  /** 内容区累积文本（Agent 输出 / 命令结果） */
  agentOutput: string
  /** 渲染好的输入行（含 prompt 呼吸色） */
  inputLine: string
  /** Agent 是否正在运行（运行时无输入光标） */
  agentRunning: boolean
  /** 是否处于 /pause 静止模式（只重绘输入行、不清屏） */
  paused: boolean
}

/** 帧状态输出 */
export interface FrameOutput {
  /** 要写给 stdout 的字节序列 */
  writes: string
  /** 输入光标位置（0 基），null = 不定位光标（Agent 运行时） */
  cursor: { row: number; col: number } | null
}

/**
 * 内容区占用的显示行数。
 *
 * 注意保留旧实现的语义：以 agentOutput 是否 trim 后非空做判空，
 * 但行数用原始 agentOutput 的 split('\n').length 计算——
 * 末尾的换行会多算一行（作为光标落点），这是 v0.6.x 一直的布局，
 * S0 阶段不改，避免"零行为变化"的搬移和修 bug 混在一起。
 */
export function contentRowsOf(agentOutput: string): number {
  if (!agentOutput.trim()) return 0
  return agentOutput.split('\n').length
}

/**
 * 编译一帧。
 *
 * paused 分支保留旧实现的一处不自洽（S1 一并修，见下）：
 * `\x1b[${inputRow};1H` 把 0 基的 inputRow 当 1 基用，
 * 而随后 positionCursorAt(inputRow - 1) 又按 0 基处理，两者差一行。
 * S0 只搬移不修，保证可逐字节对比新旧输出。
 */
export function composeFrame(f: FrameInput): FrameOutput {
  if (f.paused) {
    const inputRow = CONTENT_ROW + contentRowsOf(f.agentOutput)
    return {
      writes: `\x1b[${inputRow};1H\x1b[2K` + f.inputLine,
      cursor: { row: inputRow - 1, col: 0 },
    }
  }

  let out = '\x1b[2J\x1b[H'
  out += '\n' // 顶部空行（不顶格）
  out += f.banner + '\n'
  out += f.hint + '\n'
  if (f.agentRunning) {
    out += f.agentOutput
  } else {
    // 保留上一轮回答（不随运行结束清掉），输入行在回答下方
    if (f.agentOutput.trim()) out += f.agentOutput
    out += f.inputLine
  }

  return {
    writes: out,
    cursor: f.agentRunning ? null : { row: CONTENT_ROW + contentRowsOf(f.agentOutput), col: 0 },
  }
}
