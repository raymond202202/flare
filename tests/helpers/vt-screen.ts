/**
 * 极简 VT 屏幕模拟器（测试辅助）
 *
 * 存在的理由：P0-B 的验收点是「输入框是否始终贴在屏幕底部」「历史内容是否进了 scrollback」
 * 「清屏序列是否还在发」——这些只看 writes 字符串判断不了，必须真的把字节流"跑"到一块
 * rows×cols 的网格上，再断言网格和 scrollback 的最终状态。
 *
 * 支持：普通字符（含 CJK/emoji 宽度 2）、\r、\n、\b、
 *       CSI nA/nB/nC/nD（相对移动）、CSI J（0=擦到末尾）、CSI 2J（清屏）、CSI H（绝对定位）、
 *       SGR（忽略）、CSI ?25h/l（忽略）、自动折行 + 滚屏进 scrollback。
 */
import { stringWidth } from '../../src/cli/line-input.js'

function charWidth(ch: string): number {
  return stringWidth(ch)
}

export class VtScreen {
  readonly cols: number
  readonly rows: number
  /** 每格一个字符；宽字符占两格，第二格为空串 */
  grid: string[][]
  cur = { r: 0, c: 0 }
  scrollback: string[] = []
  private pendingWrap = false

  constructor(cols = 80, rows = 24) {
    this.cols = cols
    this.rows = rows
    this.grid = this.blankGrid()
  }

  private blankGrid(): string[][] {
    return Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, () => ' '))
  }

  /** 屏幕上第 n 行的文本（去掉行尾空格） */
  line(n: number): string {
    return (this.grid[n] || []).join('').replace(/\s+$/, '')
  }

  /** 屏幕上所有非空行 */
  nonEmptyLines(): string[] {
    return Array.from({ length: this.rows }, (_, i) => this.line(i)).filter((l) => l.trim() !== '')
  }

  /** scrollback + 屏幕，按显示顺序拼接 */
  allLines(): string[] {
    return [...this.scrollback, ...Array.from({ length: this.rows }, (_, i) => this.line(i))]
  }

  /** 光标所在行的文本 */
  cursorLine(): string {
    return this.line(this.cur.r)
  }

  write(s: string): void {
    let i = 0
    while (i < s.length) {
      const ch = s[i]

      if (ch === '\x1b') {
        const m = /^\x1b\[([0-9;?]*)([@-~])/.exec(s.slice(i, i + 32))
        if (m) {
          this.csi(m[1], m[2])
          i += m[0].length
          continue
        }
        i += 1 // 无法识别的转义：跳过 ESC
        continue
      }
      if (ch === '\r') {
        this.cur.c = 0
        this.pendingWrap = false
        i += 1
        continue
      }
      if (ch === '\n') {
        this.newline()
        this.pendingWrap = false
        i += 1
        continue
      }
      if (ch === '\b') {
        this.cur.c = Math.max(0, this.cur.c - 1)
        this.pendingWrap = false
        i += 1
        continue
      }

      this.putChar(ch, charWidth(ch))
      i += 1
    }
  }

  private csi(params: string, final: string): void {
    const args = params.replace(/^\?/, '').split(';').filter((x) => x !== '').map((x) => parseInt(x, 10))
    const n = Number.isFinite(args[0]) && args[0] > 0 ? args[0] : 1

    switch (final) {
      case 'A':
        this.cur.r = Math.max(0, this.cur.r - n)
        this.pendingWrap = false
        break
      case 'B':
        this.cur.r = Math.min(this.rows - 1, this.cur.r + n)
        this.pendingWrap = false
        break
      case 'C':
        this.cur.c = Math.min(this.cols - 1, this.cur.c + n)
        this.pendingWrap = false
        break
      case 'D':
        this.cur.c = Math.max(0, this.cur.c - n)
        this.pendingWrap = false
        break
      case 'H':
      case 'f': {
        const row = (args[0] || 1) - 1
        const col = (args[1] || 1) - 1
        this.cur = { r: Math.min(this.rows - 1, Math.max(0, row)), c: Math.min(this.cols - 1, Math.max(0, col)) }
        this.pendingWrap = false
        break
      }
      case 'J': {
        const mode = args[0] ?? 0
        if (mode === 0) {
          for (let c = this.cur.c; c < this.cols; c++) this.grid[this.cur.r][c] = ' '
          for (let r = this.cur.r + 1; r < this.rows; r++) this.grid[r] = Array.from({ length: this.cols }, () => ' ')
        } else if (mode === 2) {
          this.grid = this.blankGrid()
          this.cur = { r: 0, c: 0 }
        }
        this.pendingWrap = false
        break
      }
      default:
        break // SGR(m)、?25h/l 等：不影响布局
    }
  }

  private newline(): void {
    if (this.cur.r === this.rows - 1) {
      this.scrollback.push(this.line(0))
      this.grid.shift()
      this.grid.push(Array.from({ length: this.cols }, () => ' '))
      this.cur.c = 0
    } else {
      this.cur.r += 1
      this.cur.c = 0
    }
  }

  private putChar(ch: string, w: number): void {
    if (this.pendingWrap || this.cur.c + w > this.cols) {
      this.cur.c = 0
      this.newline()
      this.pendingWrap = false
    }
    this.grid[this.cur.r][this.cur.c] = ch
    if (w === 2 && this.cur.c + 1 < this.cols) this.grid[this.cur.r][this.cur.c + 1] = ''
    this.cur.c += w
    if (this.cur.c >= this.cols) {
      this.cur.c = this.cols - 1
      this.pendingWrap = true
    }
  }
}
