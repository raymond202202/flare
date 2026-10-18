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
import { StringDecoder } from 'string_decoder'

/** IME 防抖窗口：Enter 后等待输入法提交中文字符的毫秒数 */
const ENTER_DEBOUNCE_MS = 200

/** 终端 bracketed paste 模式开关（DECSET/DECRST 2004） */
const BRACKET_PASTE_ON = '\u001b[?2004h'
const BRACKET_PASTE_OFF = '\u001b[?2004l'
/** 粘贴内容的起止标记（终端在 2004 模式下自动包裹） */
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'


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

/**
 * 把 buffer 转成"单行可见形式"：换行显示为 ↵，制表符展开成 4 个空格。
 * 用于渲染和宽度计算，保证光标定位与实际显示宽度一致（buffer 原文仍保留 \n \t）。
 */
export function displayOf(s: string): string {
  return s.replace(/\n/g, '\u21b5').replace(/\t/g, '    ')
}

/** 粘贴内容末尾若是 PASTE_END 的前缀（跨 chunk 被切断），返回需要保留的字符数 */
function pasteEndPrefixLen(s: string): number {
  const max = Math.min(PASTE_END.length - 1, s.length)
  for (let n = max; n > 0; n--) {
    if (s.endsWith(PASTE_END.slice(0, n))) return n
  }
  return 0
}


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
  /** 粘贴态：收到 PASTE_START 后置真，内容先累积到 pasteBuf，收到 PASTE_END 一次性插入 */
  private pasteMode = false
  private pasteBuf = ''
  /** 流式 UTF-8 解码器：跨 chunk 切断的多字节字符不会变成 U+FFFD */
  private decoder: StringDecoder | null = null
  /** 帧模式：按键只更新状态，不直接写终端，通过 onChange 通知外部重绘 */
  private frameMode = false
  private onChange: (() => void) | null = null
  /** IME 防抖：Enter 后延迟提交的计时器与状态（等 fcitx5 提交完中文字符） */
  private enterTimer: ReturnType<typeof setTimeout> | null = null
  private enterPending = false
  private pendingResolve: ((v: string) => void) | null = null

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
      this.pasteMode = false
      this.pasteBuf = ''
      this.decoder = new StringDecoder('utf8')
      this.historyIndex = this.history.length   // 从最新位置开始
      this.drawPrompt()
      // 开启 bracketed paste：终端把粘贴内容用 \x1b[200~ … \x1b[201~ 包裹，
      // 于是内容里的换行不会被误判成"用户按了回车"
      process.stdout.write(BRACKET_PASTE_ON)

      let pending = ''

      /** 消费输入队列：粘贴态批量累积，普通态逐字符走编辑逻辑 */
      const consume = () => {
        while (pending.length > 0) {
          // ---- 粘贴态：只找结束标记，整段文本一次插入（不逐字符重绘）----
          if (this.pasteMode) {
            const end = pending.indexOf(PASTE_END)
            if (end < 0) {
              // 未到结束标记：全部吞进 pasteBuf，只保留可能是 PASTE_END 前缀的尾巴
              const keep = pasteEndPrefixLen(pending)
              this.pasteBuf += pending.slice(0, pending.length - keep)
              pending = pending.slice(pending.length - keep)
              return
            }
            this.pasteBuf += pending.slice(0, end)
            pending = pending.slice(end + PASTE_END.length)
            this.pasteMode = false
            const text = this.pasteBuf
            this.pasteBuf = ''
            if (text) this.insertText(text)
            continue
          }

          const ch = pending[0]

          // 在转义序列中：直到字母或 ~ 结束（\x1b[A 方向键、\x1b[200~ 粘贴标记等）
          if (this.inEscape) {
            pending = pending.slice(1)
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
            pending = pending.slice(1)
            this.inEscape = true
            this.escapeBuf = '\u001b'
            continue
          }
          // 回车/换行：提交（IME 防抖：Enter 可能是 fcitx5 确认候选，延迟提交等待输入法后续字符）
          if (ch === '\r' || ch === '\n') {
            const rest = pending.slice(1)
            // 兜底：不支持 bracketed paste 的终端（部分 IDE 内嵌终端、老 ssh 客户端）
            // 会把整段粘贴塞进同一个 chunk。换行后还有可见字符 → 这是粘贴不是提交，
            // 整段（含换行）当文本插入，绝不丢弃。
            if (rest.length > 0 && /[^\r\n]/.test(rest)) {
              pending = ''
              this.insertText(ch + rest)
              continue
            }
            pending = ''
            this.handleEnterSubmit(resolve)
            return
          }
          // Ctrl+C：退出
          if (ch === '\u0003') {
            pending = ''
            process.stdout.write('\n')
            this.cleanup()
            resolve('\u0003')
            return
          }
          // 退格：删除光标前的字符
          if (ch === '\u007f' || ch === '\u0008') {
            pending = pending.slice(1)
            this.backspace()
            continue
          }
          // 制表符：保留（粘贴代码的缩进），渲染时展开为 4 空格
          if (ch === '\t') {
            pending = pending.slice(1)
            this.insertChar('\t')
            continue
          }
          // 其他控制字符：忽略
          if (ch.charCodeAt(0) < 32) {
            pending = pending.slice(1)
            continue
          }
          // 可打印字符（含中文/emoji）：在光标处插入
          pending = pending.slice(1)
          this.insertChar(ch)
        }
      }

      this.onData = (chunk: Buffer) => {
        pending += this.decoder ? this.decoder.write(chunk) : chunk.toString('utf8')
        consume()
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
    // 关闭 bracketed paste：Agent 运行期间没有解析器，不能让粘贴内容被 200~/201~ 包裹
    process.stdout.write(BRACKET_PASTE_OFF)
    this.pasteMode = false
    this.pasteBuf = ''
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

  /**
   * Enter 提交（IME 防抖）：
   * - 第一次 Enter：进入 pending，延迟 ENTER_DEBOUNCE_MS 再提交——等 fcitx5 确认候选后提交的中文字符
   * - pending 期间有字符到达 → insertChar 重置计时器（输入法还在提交）
   * - 第二次 Enter：立即提交（用户确实要提交）
   */
  private handleEnterSubmit(resolve: (v: string) => void) {
    if (this.enterPending) {
      if (this.enterTimer) clearTimeout(this.enterTimer)
      this.enterTimer = null
      this.enterPending = false
      this.pendingResolve = null
      this.submitLine(resolve)
      return
    }
    this.enterPending = true
    this.pendingResolve = resolve
    this.enterTimer = setTimeout(() => {
      this.enterTimer = null
      this.enterPending = false
      const r = this.pendingResolve
      this.pendingResolve = null
      if (r) this.submitLine(r)
    }, ENTER_DEBOUNCE_MS)
  }

  /** 真正提交：存历史 + 清理 + resolve */
  private submitLine(resolve: (v: string) => void) {
    // 帧模式下不能自己写换行：渲染器用「影子行号」跟踪光标，外部偷偷 \n 会让它
    // 以为光标还在上一行，下一帧擦错行 → 旧输入行残留在屏上，回显另起一行成两遍。
    if (!this.frameMode) process.stdout.write('\n')
    this.saveHistory()
    this.cleanup()
    resolve(this.buffer)
  }

  private cleanup() {
    if (this.enterTimer) {
      clearTimeout(this.enterTimer)
      this.enterTimer = null
    }
    this.enterPending = false
    this.pasteMode = false
    this.pasteBuf = ''
    this.decoder = null
    // 关闭 bracketed paste，把终端模式还给 shell
    process.stdout.write(BRACKET_PASTE_OFF)
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
    if (this.frameMode) return // 帧模式：prompt 由渲染循环统一画，这里写会画重
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
      case PASTE_START: // 粘贴开始：后续内容整体累积，不当按键处理
        this.pasteMode = true
        this.pasteBuf = ''
        break
      case PASTE_END: // 粘贴结束（正常在粘贴态内被识别，这里兜底）
        this.pasteMode = false
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

  /** 重置 IME 防抖计时器（有新内容到达时调用：说明输入法还在提交后续字符） */
  private resetEnterTimer() {
    if (!this.enterPending || !this.enterTimer) return
    clearTimeout(this.enterTimer)
    this.enterTimer = setTimeout(() => {
      this.enterTimer = null
      this.enterPending = false
      const r = this.pendingResolve
      this.pendingResolve = null
      if (r) this.submitLine(r)
    }, ENTER_DEBOUNCE_MS)
  }

  /**
   * 批量插入文本（粘贴用）：\r\n 归一化为 \n，整段一次拼进 buffer，只重绘一次。
   * 粘贴不卡的关键——逐字符插入会每个字符触发一次整屏重绘。
   */
  private insertText(raw: string) {
    // 剥掉粘贴内容里夹带的 ANSI 颜色码（从终端彩色输出复制时会带上）
    const text = raw
      .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
    if (!text) return
    this.resetEnterTimer()
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor)
    this.cursor += text.length
    this.lastDrawnBuffer = this.buffer
    if (this.frameMode) {
      this.onChange?.()
      return
    }
    this.redraw()
  }

  /** 在光标处插入字符 */
  private insertChar(ch: string) {
    // IME 防抖：pending 期间有字符到达 → 重置计时器（输入法还在提交，等待完整内容）
    this.resetEnterTimer()
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
      process.stdout.write(displayOf(ch))
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
    const oldWidth = stringWidth(this.prompt) + stringWidth(displayOf(this.lastDrawnBuffer))
    const oldRows = Math.max(1, Math.ceil(oldWidth / cols))

    // 光标上移到旧输入区顶部
    if (oldRows > 1) {
      process.stdout.write(`\x1b[${oldRows - 1}A`)
    }
    // 回行首 + 清除光标到屏幕末尾（清掉旧输入区全部内容）
    process.stdout.write('\r\x1b[J')
    // 重画
    process.stdout.write(this.prompt + displayOf(this.buffer))
    this.lastDrawnBuffer = this.buffer
    // 光标绝对定位到 cursor 显示位置
    this.positionCursor()
  }

  /** 光标绝对定位（\x1b[row;colH，1 基）——跨行可靠 */
  private positionCursor() {
    const cols = process.stdout.columns || 80
    const prefixWidth = stringWidth(this.prompt) + stringWidth(displayOf(this.buffer.slice(0, this.cursor)))
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
    // 多行内容用 ↵ 代替换行，制表符展开：保证输入区恒为一行，不撑破 frame 布局
    const shown = displayOf(this.buffer).replace(/\u21b5/g, chalk.dim('\u21b5'))
    return prompt + shown
  }

  /**
   * 光标在输入行内的相对位置（0 基）：{ row, col }。
   * 供 P0-B 底部固定输入栏使用——相对定位只需要"行内偏移"，
   * 不再需要知道输入行的绝对屏幕行号（那是旧整屏模型的耦合点）。
   */
  cursorPosInLine(): { row: number; col: number } {
    const cols = process.stdout.columns || 80
    const prefixWidth = stringWidth(this.prompt) + stringWidth(displayOf(this.buffer.slice(0, this.cursor)))
    return { row: Math.floor(prefixWidth / cols), col: prefixWidth % cols }
  }

  /** 当前 buffer（提交/测试用） */
  get value() {
    return this.buffer
  }
}
