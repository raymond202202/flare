/**
 * CLI 渲染层（P0-B S1：追加式内容 + 底部固定输入栏）
 *
 * 三条不变量：
 *   I1 内容只追加，不重绘 —— 回答/工具输出一旦写屏就进 scrollback，可向上翻、可选中复制
 *   I2 输入区永远贴屏幕底部 —— 内容变长靠屏幕整体上滚，输入框不移动、不消失
 *   I3 除启动外不再发 \x1b[2J —— 全屏清屏是「输出放大 730 倍」和「输入框跑到 row 49」的共同根因
 *
 * 实现要点：渲染器自己维护「光标当前屏幕行」（curRow），因为每次写屏都经过它，
 * 终端宽度已知，行号可以离线推算。有了 curRow 就能把输入区精确停在最后 rows-inputRows 行，
 * 而不需要任何绝对定位序列 \x1b[row;colH —— 那种序列正是「改窗口就错位」的根因。
 *
 * 光标位置有两个真相：curRow（屏幕行）与 cursorRow（输入区内相对行）。
 * 后者必须有：输入折行时最后一帧结束时光标被相对定位到输入区第一行，
 * 下一帧擦除要按 cursorRow 上移，按 inputRows-1 上移会擦过头、吃掉上方内容。
 *
 * 所有换行都发 \r\n：Node 的 setRawMode 会清掉 OPOST/ONLCR，裸 \n 不再自动回车。
 */
import { stringWidth } from './line-input.js'

/**
 * 旧整屏模型的常量。S1 起渲染不再依赖它，保留导出仅为兼容既有引用。
 */
export const CONTENT_ROW = 6

export interface Layout {
  cols: number
  rows: number
}

export interface FrameInput {
  /** 启动 banner（含 ANSI 色）。只在首帧输出一次，之后永久留在 scrollback */
  banner: string
  /** 固定提示语，只在首帧输出一次 */
  hint: string
  /** Agent 累积输出（含 ANSI 色）。渲染器自己算增量，只写新出现的部分 */
  agentOutput: string
  /** 当前输入行（prompt 呼吸色 + buffer），可折行 */
  inputLine: string
  /** 输入光标在输入行内的相对位置（0 基） */
  inputCursor: { row: number; col: number }
  /** Agent 运行中：不画输入行（没有输入光标） */
  agentRunning: boolean
  /** 暂停：渲染循环已停，本字段不改变帧内容（屏幕天然静止） */
  paused: boolean
}

export interface RenderState {
  bannerDone: boolean
  /** 上一帧已提交的内容（用于算增量） */
  lastCommitted: string
  /** 上一帧输入区占的行数 */
  inputRows: number
  /** 上一帧输入行文本（用于跳过无变化重绘） */
  lastInputLine: string
  /** 光标当前所在的屏幕行（0 基，触底时饱和到 rows-1） */
  curRow: number
  /** 光标在输入区内的相对行（0 基；无输入行时为 0） */
  cursorRow: number
}

export interface FramePlan {
  /** 要写到 stdout 的字节序列；空串表示本帧无需写屏 */
  writes: string
  state: RenderState
}

export function createRenderState(): RenderState {
  return {
    bannerDone: false,
    lastCommitted: '',
    inputRows: 0,
    lastInputLine: '',
    curRow: 0,
    cursorRow: 0,
  }
}

/** 内容区行数（保留旧语义：空内容算 0 行，末尾换行多算一行） */
export function contentRowsOf(text: string): number {
  return text.trim() ? text.split('\n').length : 0
}

/** 文本在给定列数下占几行显示行 */
export function displayRows(text: string, cols: number): number {
  return Math.max(1, Math.ceil(stringWidth(text) / Math.max(1, cols)))
}

/** 裸 \n 换成 \r\n（raw mode 下 ONLCR 已关，必须显式回车） */
function crlf(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
}

const ANSI = /\x1b\[[0-9;?]*[@-~]/g

/**
 * 推算文本写完后光标落在哪一行。
 * 前提：从行首开始写（我们的内容总是从行首开始）。
 * 行号在触底时饱和 —— 终端继续换行就是滚屏，光标留在最后一行。
 */
function advance(row: number, text: string, cols: number, rows: number): number {
  const plain = text.replace(ANSI, '').replace(/\r/g, '')
  let r = row
  const parts = plain.split('\n')
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) r = Math.min(r + 1, rows - 1)
    const w = stringWidth(parts[i])
    if (w > 0) {
      const wraps = Math.max(0, Math.ceil(w / cols) - 1) // 写满整行不算折行（pending-wrap）
      r = Math.min(r + wraps, rows - 1)
    }
  }
  return r
}

/**
 * 只取已收尾的完整行（以 \n 结束的部分）。
 * 未收尾的尾巴可能是流式中间态，直接提交会导致下一帧重复追加、内容翻倍。
 */
function stablePrefix(text: string): string {
  const nl = text.lastIndexOf('\n')
  return nl >= 0 ? text.slice(0, nl + 1) : ''
}

/**
 * 编译一帧。帧结构（自上而下）：[scrollback 内容] → 底部输入区
 *
 * 1. 擦除上一帧输入区（按 cursorRow 上移到输入区首行 + 擦到屏末），只擦输入区，不动内容
 * 2. 首帧：清屏一次 + banner + 提示语
 * 3. 追加内容增量（内容写高了终端自己上滚，滚出的行进 scrollback）
 * 4. 用换行把光标送到 rows-inputRows 行，写输入行，相对定位光标
 */
export function composeFrame(state: RenderState, f: FrameInput, layout: Layout): FramePlan {
  const cols = Math.max(1, layout.cols || 80)
  const rows = Math.max(1, layout.rows || 24)
  const next: RenderState = { ...state }
  let writes = ''

  const committed = stablePrefix(f.agentOutput)
  // 增量：只在尾部增长时取差集；被重置/改写（新一轮对话）时整体追加，旧内容留在 scrollback
  const delta = committed.startsWith(state.lastCommitted)
    ? committed.slice(state.lastCommitted.length)
    : committed

  const drawInput = !f.agentRunning
  const inputRowsTarget = drawInput ? displayRows(f.inputLine, cols) : 0
  const inputUnchanged =
    drawInput && state.bannerDone && state.inputRows === inputRowsTarget && f.inputLine === state.lastInputLine

  // 空闲帧：内容无增量、输入行未变 → 不写屏（旧实现每 80ms 整屏重绘一次）
  if (state.bannerDone && !delta && (inputUnchanged || (!drawInput && state.inputRows === 0))) {
    return { writes: '', state: next }
  }

  // 1. 擦掉上一帧输入区，光标回到输入区首行行首
  //    上移行数按 cursorRow（光标在输入区内的相对行），不是 inputRows-1：
  //    折行输入时上一帧把光标留在了输入区第一行，按 inputRows-1 上移会擦掉上方内容。
  if (state.bannerDone && state.inputRows > 0) {
    const up = Math.max(0, Math.min(state.cursorRow, state.inputRows - 1))
    if (up > 0) {
      writes += `\x1b[${up}A`
      next.curRow = Math.max(0, state.curRow - up)
    }
    writes += '\r\x1b[0J'
    next.inputRows = 0
    next.lastInputLine = ''
    next.cursorRow = 0
  }

  // 2. 首帧：清一次屏 + 静态 banner + 提示语（I3：此后永不清屏）
  if (!state.bannerDone) {
    writes += '\x1b[2J\x1b[H'
    let head = ''
    if (f.banner) head += '\r\n' + crlf(f.banner) + '\r\n'
    if (f.hint) head += crlf(f.hint) + '\r\n'
    writes += head
    next.curRow = advance(0, head, cols, rows)
    next.bannerDone = true
  }

  // 3. 追加内容增量（I1：只追加；写高了终端自动上滚，滚出的行进 scrollback）
  if (delta) {
    writes += crlf(delta)
    next.curRow = advance(next.curRow, delta, cols, rows)
  }
  next.lastCommitted = committed

  // 4. 把输入区停到屏幕最后 inputRows 行（I2），再写输入行
  if (drawInput) {
    const targetFirst = Math.max(0, rows - inputRowsTarget)
    const gap = targetFirst - next.curRow
    if (gap > 0) {
      // 内容还没填满屏幕：向下补空行到底部，不触发滚屏
      writes += '\r\n'.repeat(gap)
      next.curRow = targetFirst
    } else if (gap < 0) {
      // 内容已经压到输入区要占的行：必须把内容整体上推 -gap 行（滚出屏幕的进 scrollback）。
      // 不能直接 \r\n × -gap 再上移：光标若没贴底，头几次换行只是下移不滚屏，上移就会错位。
      // 所以先把光标送到屏底，再换行滚屏，最后按影子行号上移回输入区首行。
      const down = rows - 1 - next.curRow
      if (down > 0) writes += `\x1b[${down}B`
      writes += '\r' + '\r\n'.repeat(-gap)
      const upBack = rows - 1 - targetFirst
      if (upBack > 0) writes += `\x1b[${upBack}A`
      next.curRow = targetFirst
    }

    writes += f.inputLine
    next.inputRows = inputRowsTarget
    next.lastInputLine = f.inputLine
    next.cursorRow = Math.max(0, Math.min(f.inputCursor.row, inputRowsTarget - 1))
    next.curRow = Math.max(0, Math.min(rows - 1, targetFirst + next.cursorRow))

    // 相对定位光标：写完输入行时光标在末行末列，先 \r 再上下移动
    const fromRow = inputRowsTarget - 1
    writes += '\r'
    if (fromRow > next.cursorRow) writes += `\x1b[${fromRow - next.cursorRow}A`
    else if (next.cursorRow > fromRow) writes += `\x1b[${next.cursorRow - fromRow}B`
    if (f.inputCursor.col > 0) writes += `\x1b[${f.inputCursor.col}C`
  } else {
    next.inputRows = 0
    next.lastInputLine = ''
    next.cursorRow = 0
  }

  return { writes, state: next }
}
