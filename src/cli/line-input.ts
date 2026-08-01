/**
 * Flare 自研终端输入行
 *
 * 为什么不用 Node readline？
 * readline 的折行重绘依赖它内部的宽度计算，对中文/emoji 的处理不可靠：
 *   - prompt 含 ANSI 颜色码时，String.length 把转义序列也算进去
 *   - 中文每字显示占 2 列，但 readline 按 1 列算
 * 宽度算错 → 折行点错误 → 重绘时清行不干净 → 长输入换行时文字重复。
 * 这是 readline 内部缺陷，无法通过配置修复。
 *
 * 本实现：
 *   - 输入时逐字符 echo，让终端自然折行（宽度由终端自己算，永远正确）
 *   - 退格/插入/移动光标时用正确的 wcwidth 计算行数重绘（中文/emoji 算 2 列）
 *   - 方向键：←→ 移动光标（按字符移动，中文/emoji 一次移一个字），↑↓ 历史记录
 *   - 光标定位用 ANSI 绝对定位（\x1b[row;colH），跨行可靠
 *   - 帧模式（frameMode）：按键只更新状态 + 回调，由外部渲染循环统一重绘
 */
import chalk from 'chalk'

/** 字符显示宽度（wcwidth 简化版，正确处理中文/emoji/ANSI） */
export function charWidth(ch: string): number {
  const code = ch.codePointAt(0)!
  // 宽字符（CJK、全角标点、emoji 等）占 2 列
  if (
    (code >= 0x1100 && code <= 0x115f) ||          // Hangul Jamo
    code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || // CJK 部首/汉字
    (code >= 0xac00 && code <= 0xd7a3) ||          // Hangul 音节
    (code >= 0xf900 && code <= 0xfaff) ||          // CJK 兼容汉字
    (code >= 0xfe10 && code <= 0xfe19) ||          // 竖排标点
    (code >= 0xfe30 && code <= 0xfe6f) ||          // CJK 兼容标点
    (code >= 0xff00 && code <= 0xff60) ||          // 全角形式
    (code >= 0xffe0 && code <= 0xffe6) ||          // 全角符号
    (code >= 0x1f300 && code <= 0x1faff) ||        // emoji
    (code >= 0x20000 && code <= 0x3fffd)           // CJK 扩展 B
  ) {
    return 2
  }
  return 1
}

/** 字符串显示宽度（剥离 ANSI 转义码） */
export function stringWidth(s: string): number {
  const clean = s.replace(/\x1b\[[0-9;]*m/g, '')
  let w = 0
  for (const ch of clean) {
    w += charWidth(ch)
  }
  return w
}

const HISTORY_MAX = 100

export class LineInput {
  private prompt: string
  private buffer = ''
  private cursor = 0                        // 光标位置（UTF-16 单元索引）
  private lastDrawnBuffer = ''              // 最近一次绘制时的 buffer（退格重绘用）
  private history: string[] = []            // 命令历史
  private historyIndex = -1                 // 当前历史位置
  private inEscape = false                  // 是否在 ANSI 转义序列中（跨 chunk 保持）
  private escapeBuf = ''
  private onData: ((chunk: Buffer) => void) | null = null
  private paused = false
  /** 帧模式：按键只更新状态，不直接写终端，通过 onChange 通知外部重绘 */
  private frameMode = false
  private onChange: (() => void) | null = null

  constructor(prompt: string, options?: { frameMode?: boolean; onChange?: () => void }) {
    this.prompt = prompt
    this.frameMode = options?.frameMode ?? false
    this.onChange = options?.onChange ?? null
  }

  /**
   * 读取一行输入（prompt 由本类绘制）
   * @returns 用户输入的行；Ctrl+C 时返回 '\u0003'
   */
  readLine(): Promise<string> {
    return new Promise(resolve => {
      this.buffer = ''
      this.cursor = 0
      this.lastDrawnBuffer = ''
      this.inEscape = false
      this.escapeBuf = ''
      this.historyIndex = this.history.length   // 从最新位置开始
      this.drawPrompt()

      this.onData = (chunk: Buffer) => {
        const s = chunk.toString('utf8')
        for (const ch of s) {
          // 在转义序列中：直到字母或 ~ 结束（\x1b[A 方向键、\x1b[1~ Home 等）
          if (this.inEscape) {
            this.escapeBuf += ch
            if (/[a-zA-Z~]/.test(ch)) {
              const seq = this.escapeBuf
              this.inEscape = false
              this.escapeBuf = ''
              this.handleEscape(seq)
            }
            continue
          }
          // 遇到 ESC 开头：进入转义序列
          if (ch === '\u001b') {
            this.inEscape = true
            this.escapeBuf = '\u001b'
            continue
          }
          // 回车/换行：提交
          if (ch === '\r' || ch === '\n') {
            process.stdout.write('\n')
            this.saveHistory()
            this.cleanup()
            resolve(this.buffer)
            return
          }
          // Ctrl+C：退出
          if (ch === '\u0003') {
            process.stdout.write('\n')
            this.cleanup()
            resolve('\u0003')
            return
          }
          // 退格：删除光标前的字符
          if (ch === '\u007f' || ch === '\u0008') {
            this.backspace()
            continue
          }
          // 其他控制字符：忽略
          if (ch.charCodeAt(0) < 32) continue
          // 可打印字符（含中文/emoji）：在光标处插入
          this.insertChar(ch)
        }
      }

      // 进入 raw mode（关闭行缓冲和回显，逐字符接收）
      if (typeof process.stdin.setRawMode === 'function') {
        process.stdin.setRawMode(true)
      }
      process.stdin.on('data', this.onData)
    })
  }

  /** 暂停输入（Agent 运行期间调用，停止收集用户输入） */
  pause() {
    this.paused = true
    if (this.onData) {
      process.stdin.removeListener('data', this.onData)
    }
    // 恢复 cooked 模式（回显由终端处理；Agent 运行中配合 stty -echo 不显示）
    try {
      process.stdin.setRawMode(false)
    } catch { /* 忽略 */ }
  }

  /** 恢复输入（Agent 运行结束后调用，重新监听；prompt 由 readLine() 统一绘制） */
  resume() {
    this.paused = false
    this.buffer = ''
    this.cursor = 0
    this.lastDrawnBuffer = ''
    this.inEscape = false
    this.escapeBuf = ''
    // 注意：这里不画 prompt！readLine() 会画，否则一轮后出现两个 prompt
    try {
      process.stdin.setRawMode(true)
    } catch { /* 忽略 */ }
    if (this.onData) {
      process.stdin.on('data', this.onData)
    }
  }

  private cleanup() {
    if (this.onData) {
      process.stdin.removeListener('data', this.onData)
      this.onData = null
    }
    try {
      process.stdin.setRawMode(false)
    } catch { /* 忽略 */ }
  }

  private drawPrompt() {
    this.lastDrawnBuffer = ''
    process.stdout.write(this.prompt)
  }

  /** 处理 ANSI 转义序列（方向键） */
  private handleEscape(seq: string) {
    switch (seq) {
      case '\u001b[A': // ↑ 历史上一条
        if (this.historyIndex > 0) {
          this.historyIndex--
          this.setBuffer(this.history[this.historyIndex])
        }
        break
      case '\u001b[B': // ↓ 历史下一条
        if (this.historyIndex < this.history.length - 1) {
          this.historyIndex++
          this.setBuffer(this.history[this.historyIndex])
        } else {
          // 越过最新一条 → 回到空编辑状态
          this.historyIndex = this.history.length
          this.setBuffer('')
        }
        break
      case '\u001b[C': // → 光标右移（按字符，中文/emoji 一次移一字）
        if (this.cursor < this.buffer.length) {
          const cp = this.buffer.codePointAt(this.cursor)!
          this.cursor += cp > 0xffff ? 2 : 1
          this.afterCursorMove()
        }
        break
      case '\u001b[D': // ← 光标左移
        if (this.cursor > 0) {
          const cp = this.buffer.codePointAt(this.cursor - 1)!
          this.cursor -= cp > 0xffff ? 2 : 1
          this.afterCursorMove()
        }
        break
      // 其他序列（Home/End/Delete 等）：暂时忽略
    }
  }

  /** 光标移动后的处理：帧模式通知外部，否则直接定位 */
  private afterCursorMove() {
    if (this.frameMode) {
      this.onChange?.()
    } else {
      this.positionCursor()
    }
  }

  /** 整行替换（历史切换用） */
  private setBuffer(newBuf: string) {
    this.buffer = newBuf
    this.cursor = this.buffer.length
    if (this.frameMode) {
      this.lastDrawnBuffer = this.buffer
      this.onChange?.()
      return
    }
    this.redraw()
  }

  /** 在光标处插入字符 */
  private insertChar(ch: string) {
    if (this.frameMode) {
      this.buffer = this.buffer.slice(0, this.cursor) + ch + this.buffer.slice(this.cursor)
      this.cursor += ch.length
      this.lastDrawnBuffer = this.buffer
      this.onChange?.()
      return
    }
    if (this.cursor === this.buffer.length) {
      // 光标在末尾：直接 echo（快路径，终端自然折行）
      this.buffer += ch
      this.cursor = this.buffer.length
      this.lastDrawnBuffer = this.buffer
      process.stdout.write(ch)
    } else {
      // 光标在中间：插入并重绘
      this.buffer = this.buffer.slice(0, this.cursor) + ch + this.buffer.slice(this.cursor)
      this.cursor += ch.length
      this.redraw()
    }
  }

  /** 退格：删除光标前的字符 */
  private backspace() {
    if (this.cursor <= 0) return
    const cp = this.buffer.codePointAt(this.cursor - 1)!
    const charLen = cp > 0xffff ? 2 : 1
    this.buffer = this.buffer.slice(0, this.cursor - charLen) + this.buffer.slice(this.cursor)
    this.cursor -= charLen
    if (this.frameMode) {
      this.lastDrawnBuffer = this.buffer
      this.onChange?.()
      return
    }
    this.redraw()
  }

  /** 提交后保存历史 */
  private saveHistory() {
    const trimmed = this.buffer.trim()
    if (trimmed && this.history[this.history.length - 1] !== this.buffer) {
      this.history.push(this.buffer)
      if (this.history.length > HISTORY_MAX) {
        this.history.shift()
      }
    }
  }

  /**
   * 整行重绘：用退格/插入前的宽度计算占用行数（oldRows），把光标上移到旧输入区的
   * 顶部再清除重绘——避免新 buffer 变短后清不到旧行导致文字残留。
   * 重绘后光标用绝对定位放回 cursor 显示位置。
   */
  private redraw() {
    const cols = process.stdout.columns || 80
    const oldWidth = stringWidth(this.prompt) + stringWidth(this.lastDrawnBuffer)
    const oldRows = Math.max(1, Math.ceil(oldWidth / cols))

    // 光标上移到旧输入区顶部
    if (oldRows > 1) {
      process.stdout.write(`\x1b[${oldRows - 1}A`)
    }
    // 回行首 + 清除光标到屏幕末尾（清掉旧输入区全部内容）
    process.stdout.write('\r\x1b[J')
    // 重画
    process.stdout.write(this.prompt + this.buffer)
    this.lastDrawnBuffer = this.buffer
    // 光标绝对定位到 cursor 显示位置
    this.positionCursor()
  }

  /** 光标绝对定位（\x1b[row;colH，1 基）——跨行可靠 */
  private positionCursor() {
    const cols = process.stdout.columns || 80
    const prefixWidth = stringWidth(this.prompt) + stringWidth(this.buffer.slice(0, this.cursor))
    const row = Math.floor(prefixWidth / cols) + 1
    const col = (prefixWidth % cols) + 1
    process.stdout.write(`\x1b[${row};${col}H`)
  }

  /** 是否处于暂停状态 */
  get isPaused() {
    return this.paused
  }

  // ===== 帧模式渲染接口（供外部渲染循环使用）=====

  /** 渲染输入行（prompt 呼吸色 + buffer），供帧渲染拼装 */
  renderLine(promptColorHex: string): string {
    const prompt = chalk.hex(promptColorHex)('🔥 flare> ')
    return prompt + this.buffer
  }

  /**
   * 光标绝对定位（帧渲染后调用）。
   * baseRow/baseCol 是输入行起始位置（0 基），光标按显示宽度定位。
   */
  positionCursorAt(baseRow: number, baseCol: number) {
    const cols = process.stdout.columns || 80
    const prefixWidth = stringWidth(this.prompt) + stringWidth(this.buffer.slice(0, this.cursor))
    const row = baseRow + Math.floor(prefixWidth / cols)
    const col = baseCol + (prefixWidth % cols)
    process.stdout.write(`\x1b[${row + 1};${col + 1}H`)
  }

  /** 当前 buffer（提交/测试用） */
  get value() {
    return this.buffer
  }
}
