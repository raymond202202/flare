/**
 * 渲染层测试（P0-B / S1：追加式内容 + 底部固定输入栏）
 *
 * 全部断言都在 VtScreen（tests/helpers/vt-screen.ts）上做「真实终端效果」验证：
 * 把 composeFrame 产生的字节流喂进模拟网格，检查屏幕与 scrollback 的最终状态。
 * 只看 writes 字符串无法证明「输入框贴底」这类空间性质。
 *
 * S0 阶段这里曾是「与旧整屏实现逐字节等价」的测试（commit f5ad548）。
 * S1 有意改变行为，等价性测试随之完成使命，替换为下面的三条不变量测试。
 */
import { describe, it, expect } from 'vitest'
import { VtScreen } from './helpers/vt-screen.js'
import {
  composeFrame,
  createRenderState,
  displayRows,
  contentRowsOf,
  FrameInput,
  Layout,
  RenderState,
} from '../src/cli/render.js'
import { stringWidth } from '../src/cli/line-input.js'
import { breathTimeMs, flameBreathColor } from '../src/cli/flame-banner.js'

const PROMPT = '🔥 flare> '
const LAYOUT: Layout = { cols: 80, rows: 24 }

function mk(over: Partial<FrameInput> = {}): FrameInput {
  return {
    banner: 'FIRE-LINE-1\nFIRE-LINE-2',
    hint: '输入 /help 查看命令，/exit 退出',
    agentOutput: '',
    inputLine: PROMPT,
    inputCursor: { row: 0, col: stringWidth(PROMPT) },
    agentRunning: false,
    paused: false,
    ...over,
  }
}

/** 依次渲染多帧，返回每帧 writes 与最终状态 */
function play(frames: FrameInput[], layout: Layout = LAYOUT, screen = new VtScreen(layout.cols, layout.rows)) {
  let state: RenderState = createRenderState()
  const writes: string[] = []
  for (const f of frames) {
    const plan = composeFrame(state, f, layout)
    state = plan.state
    writes.push(plan.writes)
    screen.write(plan.writes)
  }
  return { writes, state, screen }
}

/** 把输入行文本变成带光标位置的帧（模拟 LineInput 的输出） */
function typed(line: string, opts: Partial<FrameInput> = {}): FrameInput {
  return mk({ inputLine: line, inputCursor: { row: 0, col: stringWidth(line) }, ...opts })
}

describe('VtScreen 模拟器自检', () => {
  it('\\n 到底部时滚屏并进 scrollback', () => {
    const s = new VtScreen(20, 3)
    s.write('a\nb\nc\nd')
    expect(s.scrollback[0]).toBe('a')
    expect(s.line(0)).toBe('b')
    expect(s.line(2)).toBe('d')
  })

  it('CSI 0J 从光标处擦到屏末、相对移动可用', () => {
    const s = new VtScreen(20, 5)
    s.write('line1\nline2\nline3')
    s.write('\x1b[1A\r\x1b[0J') // 上移到 line2 行首，从这里擦到屏末
    expect(s.line(0)).toBe('line1')
    expect(s.line(1)).toBe('')
    expect(s.line(2)).toBe('')
  })

  it('自动折行：超过列宽写到下一行', () => {
    const s = new VtScreen(10, 5)
    s.write('0123456789AB')
    expect(s.line(0)).toBe('0123456789')
    expect(s.line(1)).toBe('AB')
  })

  it('CJK/emoji 按 2 列计', () => {
    const s = new VtScreen(10, 2)
    s.write('中文')
    expect(s.cur.c).toBe(4)
  })
})

describe('I3：除启动外不再全屏清屏', () => {
  it('首帧恰好一次 \\x1b[2J，后续帧为 0 次', () => {
    const { writes } = play([
      typed(PROMPT),
      typed(PROMPT + 'a'),
      mk({ agentOutput: '答案\n' }),
      typed(PROMPT + 'ab'),
    ])
    expect(writes[0].split('\x1b[2J').length - 1).toBe(1)
    for (let i = 1; i < writes.length; i++) {
      expect(writes[i]).not.toContain('\x1b[2J')
    }
  })

  it('banner 与提示语只出现一次（不随重绘重复堆叠）', () => {
    const frames = Array.from({ length: 30 }, (_, i) => typed(PROMPT + 'x'.repeat(i)))
    const { screen } = play(frames)
    const all = screen.allLines().join('\n')
    expect(all.split('FIRE-LINE-1').length - 1).toBe(1)
    expect(all.split('FIRE-LINE-2').length - 1).toBe(1)
    expect(all.split('/help').length - 1).toBe(1)
  })
})

describe('I2：输入区永远贴屏幕底部', () => {
  it('连续 100 行回答后，输入行仍在最后一行', () => {
    const frames = [mk({ agentOutput: '' })]
    for (let i = 1; i <= 100; i++) {
      frames.push(mk({ agentOutput: Array.from({ length: i }, (_, k) => `line-${k + 1}`).join('\n') + '\n' }))
    }
    frames.push(typed(PROMPT + 'hello'))
    const { screen } = play(frames)
    expect(screen.line(LAYOUT.rows - 1)).toBe(PROMPT + 'hello')
    expect(screen.cursorLine()).toBe(PROMPT + 'hello')
  })

  it('窗口只有 10 行、内容 200 行时，输入行仍在最后一行', () => {
    const layout: Layout = { cols: 40, rows: 10 }
    const frames = [mk() as FrameInput]
    for (let i = 1; i <= 200; i++) {
      frames.push(mk({ agentOutput: Array.from({ length: i }, (_, k) => `L${k}`).join('\n') + '\n' }))
    }
    frames.push(typed(PROMPT + 'tail'))
    const { screen } = play(frames, layout)
    expect(screen.line(layout.rows - 1)).toBe(PROMPT + 'tail')
  })

  it('超长输入行折行后，输入行仍占据屏幕底部若干行', () => {
    const layout: Layout = { cols: 40, rows: 12 }
    const longLine = PROMPT + 'y'.repeat(200)
    const width = stringWidth(longLine)
    const rows = displayRows(longLine, layout.cols)
    const cursorCol = width % layout.cols
    const frames = [
      mk(),
      mk({
        inputLine: longLine,
        inputCursor: { row: rows - 1, col: cursorCol },
      }),
    ]
    const { screen } = play(frames, layout)
    for (let i = 0; i < rows; i++) {
      expect(screen.line(layout.rows - rows + i)).toContain('y')
    }
    expect(screen.cursorLine()).toContain('y')
    expect(screen.cur.r).toBe(layout.rows - 1)
  })
})

describe('I1：内容只追加、进 scrollback、不重复', () => {
  it('逐行增长的内容按顺序完整出现且每条只出现一次', () => {
    const frames = [mk()]
    for (let i = 1; i <= 30; i++) {
      frames.push(mk({ agentOutput: Array.from({ length: i }, (_, k) => `uniq-${k + 1}`).join('\n') + '\n' }))
    }
    const { screen } = play(frames)
    const all = screen.allLines()
    for (let i = 1; i <= 30; i++) {
      const hits = all.filter((l) => l.trim() === `uniq-${i}`).length
      expect(hits, `uniq-${i} 出现 ${hits} 次`).toBe(1)
    }
    // 顺序：uniq-1 必须在 uniq-30 之前
    const idx = (s: string) => all.findIndex((l) => l.trim() === s)
    expect(idx('uniq-1')).toBeGreaterThanOrEqual(0)
    expect(idx('uniq-1')).toBeLessThan(idx('uniq-30'))
  })

  it('滚出屏幕的内容进入 scrollback（可回滚）', () => {
    const frames = [mk()]
    for (let i = 1; i <= 60; i++) {
      frames.push(mk({ agentOutput: Array.from({ length: i }, (_, k) => `s-${k + 1}`).join('\n') + '\n' }))
    }
    const { screen } = play(frames)
    expect(screen.scrollback.length).toBeGreaterThan(40)
    expect(screen.scrollback.join('\n')).toContain('s-1')
    expect(screen.allLines().join('\n')).toContain('s-60')
  })

  it('新一轮对话（agentOutput 重置）不重写旧内容，旧内容留在 scrollback', () => {
    const { writes, screen } = play([
      mk({ agentOutput: 'round-1\n' }),
      typed(PROMPT + '第二个问题'),
      mk({ agentOutput: '🔥 flare> 第二个问题\n\nround-2\n' }),
    ])
    const all = screen.allLines().join('\n')
    expect(all.split('round-1').length - 1).toBe(1)
    expect(all.split('round-2').length - 1).toBe(1)
    // 第二轮的 writes 只含新内容，不含 round-1
    expect(writes[2]).not.toContain('round-1')
  })

  it('未收尾的半行不提交（避免流式中间态重复追加）', () => {
    const { screen } = play([
      mk({ agentOutput: 'done\nhalf' }),
      mk({ agentOutput: 'done\nhalf-line\n' }),
    ])
    const all = screen.allLines().join('\n')
    expect(all.split('half').length - 1).toBe(1)
    expect(all).toContain('half-line')
  })
})

describe('光标：只用相对移动，不做绝对定位', () => {
  it('首帧之外不出现 \\x1b[<row>;<col>H', () => {
    const frames = [typed(PROMPT), typed(PROMPT + 'abc'), mk({ agentOutput: 'x\n' }), typed(PROMPT + 'abcd')]
    const { writes } = play(frames)
    for (let i = 1; i < writes.length; i++) {
      expect(writes[i], `第 ${i} 帧`).not.toMatch(/\x1b\[\d+;\d+H/)
    }
  })

  it('光标落在输入文本末尾', () => {
    const { screen } = play([mk(), typed(PROMPT + 'hello')])
    expect(screen.cur.r).toBe(LAYOUT.rows - 1)
    expect(screen.cur.c).toBe(stringWidth(PROMPT + 'hello'))
  })

  it('编辑后按新内容定位（删除字符时光标左移）', () => {
    const { screen } = play([mk(), typed(PROMPT + 'hello'), typed(PROMPT + 'hel')])
    expect(screen.cursorLine()).toBe(PROMPT + 'hel')
    expect(screen.cur.c).toBe(stringWidth(PROMPT + 'hel'))
  })
})

describe('输入区重绘不留残影', () => {
  it('输入行变短时旧字符被清掉', () => {
    const { screen } = play([mk(), typed(PROMPT + 'abcdefg'), typed(PROMPT + 'ab')])
    expect(screen.line(LAYOUT.rows - 1)).toBe(PROMPT + 'ab')
  })

  it('折行输入变短后，多余的行被清空', () => {
    const layout: Layout = { cols: 40, rows: 12 }
    const long = PROMPT + 'z'.repeat(120)
    const rows = displayRows(long, layout.cols)
    const { screen } = play(
      [
        mk(),
        mk({ inputLine: long, inputCursor: { row: rows - 1, col: stringWidth(long) % layout.cols } }),
        typed(PROMPT + 'z'),
      ],
      layout,
    )
    expect(screen.line(layout.rows - 1)).toBe(PROMPT + 'z')
    for (let i = 1; i < rows; i++) {
      expect(screen.line(layout.rows - 1 - i)).toBe('')
    }
  })
})

describe('空闲帧与运行态', () => {
  it('内容与输入都没变时空闲帧零写入', () => {
    const ctx = { state: createRenderState() }
    const first = composeFrame(ctx.state, mk(), LAYOUT)
    ctx.state = first.state
    const second = composeFrame(ctx.state, mk(), LAYOUT)
    expect(second.writes).toBe('')
  })

  it('Agent 运行中输入行消失，结束后回来（内容不被覆盖）', () => {
    const { screen } = play([
      typed(PROMPT + '问题'),
      mk({ agentRunning: true, agentOutput: '🔥 flare> 问题\n\n' }),
      mk({ agentRunning: true, agentOutput: '🔥 flare> 问题\n\n  🔧 调用工具: read\n' }),
      mk({ agentOutput: '🔥 flare> 问题\n\n答案在此\n' }),
      typed(PROMPT),
    ])
    const all = screen.allLines().join('\n')
    expect(all).toContain('答案在此')
    expect(all).not.toContain(PROMPT + '问题🔥') // 没有粘行
    expect(screen.line(LAYOUT.rows - 1)).toBe(PROMPT.trimEnd())
  })
})

describe('折行输入 + 光标在首行（回归：擦除不能吃掉上方内容）', () => {
  it('多行折行输入、光标停在首行时，下一帧增量不会擦掉内容', () => {
    const L: Layout = { cols: 40, rows: 12 }
    const screen = new VtScreen(L.cols, L.rows)
    // 输入共 3 个显示行（40 列），光标停在输入区第一行 → 上一帧结束时光标不在末行
    const long = PROMPT + 'z'.repeat(100) // 用 z：提示语里含 x("/exit")，会污染计数
    const rowsNeeded = displayRows(long, L.cols)
    expect(rowsNeeded).toBe(3)

    const f1 = composeFrame(
      createRenderState(),
      mk({ agentOutput: 'A1\nA2\nA3\n', inputLine: long, inputCursor: { row: 0, col: stringWidth(PROMPT) } }),
      L,
    )
    screen.write(f1.writes)
    expect(f1.state.cursorRow).toBe(0)
    expect(f1.state.curRow).toBe(L.rows - rowsNeeded)

    // 第二帧：agent 又来了一行输出（增量），同时输入行不变
    const f2 = composeFrame({ ...f1.state }, mk({ agentOutput: 'A1\nA2\nA3\nA4\n', inputLine: long, inputCursor: { row: 0, col: stringWidth(PROMPT) } }), L)
    screen.write(f2.writes)

    // 内容必须还在（旧实现按 inputRows-1=2 上移，会把 A2/A3 擦掉）
    const all = screen.allLines().join('\n')
    expect(all).toContain('A1')
    expect(all).toContain('A2')
    expect(all).toContain('A3')
    expect(all).toContain('A4')
    // 输入行仍然贴底且完整
    expect(screen.allLines().join('').split('z').length - 1).toBe(100)
    expect(screen.line(L.rows - 1)).toContain('z')
  })

  it('光标在中间行时也按 cursorRow 上移（不多不少）', () => {
    const L: Layout = { cols: 40, rows: 12 }
    const screen = new VtScreen(L.cols, L.rows)
    const long = PROMPT + 'y'.repeat(100) // 3 行
    const f1 = composeFrame(
      createRenderState(),
      mk({ agentOutput: 'B1\nB2\nB3\n', inputLine: long, inputCursor: { row: 1, col: 2 } }),
      L,
    )
    screen.write(f1.writes)
    expect(f1.state.cursorRow).toBe(1)
    const f2 = composeFrame({ ...f1.state }, mk({ agentOutput: 'B1\nB2\nB3\nB4\n', inputLine: long, inputCursor: { row: 1, col: 2 } }), L)
    screen.write(f2.writes)
    const all = screen.allLines().join('\n')
    for (const tag of ['B1', 'B2', 'B3', 'B4']) expect(all).toContain(tag)
    expect(screen.allLines().join('').split('y').length - 1).toBe(100)
  })
})

describe('窗口大小变化（S2）', () => {
  it('resize 后跳到底部重画输入区，上方内容不被擦掉', () => {
    const screen = new VtScreen(LAYOUT.cols, LAYOUT.rows)
    const first = composeFrame(createRenderState(), mk({ agentOutput: 'A1\nA2\nA3\n' }), LAYOUT)
    screen.write(first.writes)
    // 复刻 index.ts 的 onResize：跳到底部（终端 clamp）+ 擦到屏末 + 行号模型归位
    screen.write('\x1b[999B\r\x1b[0J')
    const state: RenderState = { ...first.state, curRow: LAYOUT.rows - 1, inputRows: 0, lastInputLine: '' }
    screen.write(composeFrame(state, mk({ agentOutput: 'A1\nA2\nA3\n' }), LAYOUT).writes)

    expect(screen.line(LAYOUT.rows - 1)).toBe(PROMPT.trimEnd())
    const all = screen.allLines().join('\n')
    expect(all).toContain('A1')
    expect(all).toContain('A3')
  })

  it('窄窗口里折行输入仍然贴底，resize 后内容不丢', () => {
    const narrow: Layout = { cols: 40, rows: 12 }
    const screen = new VtScreen(narrow.cols, narrow.rows)
    // 先渲染一帧空输入（模拟 resize 前的稳定状态）
    const first = composeFrame(createRenderState(), mk({ agentOutput: 'A1\nA2\n' }), narrow)
    screen.write(first.writes)
    // resize 事件：跳底 + 擦到屏末 + 行号模型归位
    screen.write('\x1b[999B\r\x1b[0J')
    const state: RenderState = { ...first.state, curRow: narrow.rows - 1, inputRows: 0, lastInputLine: '' }
    // resize 后用户输入了 60 个字符（在 40 列下要折行）
    const long = PROMPT + 'q'.repeat(60)
    const rowsNeeded = displayRows(long, narrow.cols)
    screen.write(
      composeFrame(state, mk({ agentOutput: 'A1\nA2\n', inputLine: long, inputCursor: { row: 0, col: 0 } }), narrow).writes,
    )
    expect(screen.allLines().join('').split('q').length - 1).toBe(60)
    // 折行占满的每一行都贴着屏幕底部
    for (let i = 0; i < rowsNeeded; i++) {
      expect(screen.line(narrow.rows - 1 - i)).not.toBe('')
    }
    expect(screen.allLines().join('\n')).toContain('A1')
  })
})

describe('呼吸色量化（S2）', () => {
  it('同一档位内颜色恒定，跨档才变化', () => {
    expect(breathTimeMs(0)).toBe(breathTimeMs(100))
    expect(flameBreathColor(breathTimeMs(0))).toBe(flameBreathColor(breathTimeMs(100)))
    expect(breathTimeMs(0)).not.toBe(breathTimeMs(400))
    // 量化后仍连续变化：相邻档颜色不同
    expect(flameBreathColor(breathTimeMs(0))).not.toBe(flameBreathColor(breathTimeMs(400)))
  })
})

describe('内容区行数工具（保留旧语义）', () => {
  it('空内容 0 行，末尾换行多算一行', () => {
    expect(contentRowsOf('')).toBe(0)
    expect(contentRowsOf('   ')).toBe(0)
    expect(contentRowsOf('a')).toBe(1)
    expect(contentRowsOf('a\n')).toBe(2)
  })
})
