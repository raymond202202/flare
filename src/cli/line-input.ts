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
 *   - 退格时用正确的 wcwidth 计算行数重绘（中文/emoji 算 2 列，ANSI 剥离）
 *   - 不依赖任何第三方行编辑库
 */

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

export class LineInput {
  private prompt: string
  private buffer = ''
  private lastDrawnBuffer = ''  // 最近一次绘制时的 buffer（退格重绘用）
  private onData: ((chunk: Buffer) => void) | null = null
  private paused = false

  constructor(prompt: string) {
    this.prompt = prompt
  }

  /**
   * 读取一行输入（prompt 由本类绘制）
   * @returns 用户输入的行；Ctrl+C 时返回 '\u0003'
   */
  readLine(): Promise<string> {
    return new Promise(resolve => {
      this.buffer = ''
      this.lastDrawnBuffer = ''
      this.drawPrompt()

      this.onData = (chunk: Buffer) => {
        const s = chunk.toString('utf8')
        for (const ch of s) {
          // 回车/换行：提交
          if (ch === '\r' || ch === '\n') {
            process.stdout.write('\n')
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
          // 退格：删除最后一个字符并重绘
          if (ch === '\u007f' || ch === '\u0008') {
            if (this.buffer.length > 0) {
              // 正确处理 emoji 代理对：如果最后一个 code point > 0xffff，删 2 个 UTF-16 单元
              const lastCodePoint = this.buffer.codePointAt(this.buffer.length - 1)!
              const charLen = lastCodePoint > 0xffff ? 2 : 1
              this.buffer = this.buffer.slice(0, this.buffer.length - charLen)
              this.redraw()
            }
            continue
          }
          // 其他控制字符（方向键等）：忽略
          if (ch.charCodeAt(0) < 32) continue
          // 可打印字符（含中文/emoji）：追加并直接 echo，终端自然折行
          this.buffer += ch
          this.lastDrawnBuffer = this.buffer
          process.stdout.write(ch)
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
    this.lastDrawnBuffer = ''
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

  /**
   * 退格后的整行重绘。
   * 用退格前的宽度计算占用行数（oldRows），把光标上移到旧输入区的
   * 顶部再清除重绘——避免新 buffer 变短后清不到旧行导致文字残留。
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
  }

  /** 是否处于暂停状态 */
  get isPaused() {
    return this.paused
  }
}
