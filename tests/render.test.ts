/**
 * 渲染层测试（P0-B / S0）
 *
 * S0 的目标是「把渲染从 index.ts 抽到 render.ts 且零行为变化」，
 * 所以这里用**参照实现等价性**（reference-implementation equivalence）来证明：
 * 把旧 index.ts 里 renderFrame 的字节序列逻辑原样复制成 oldCompose()，
 * 对同一份状态断言 composeFrame() 的输出逐字节相等。
 *
 * S1 换成「追加式内容 + 底部固定输入栏」后，这些等价性用例会整体删除，
 * 替换为新不变量（输入区贴底、不出现 \x1b[2J、光标不越界），见 tests/render-layout.test.ts。
 */
import { describe, it, expect } from 'vitest'
import { composeFrame, contentRowsOf, CONTENT_ROW, FrameInput } from '../src/cli/render.js'

/** 旧 index.ts renderFrame() 的逻辑，原样复制（v0.6.148, commit 0936d7d） */
function oldCompose(f: FrameInput): { writes: string; cursor: { row: number; col: number } | null } {
  const contentRows = f.agentOutput.trim() ? f.agentOutput.split('\n').length : 0

  if (f.paused) {
    const inputRow = CONTENT_ROW + contentRows
    return {
      writes: `\x1b[${inputRow};1H\x1b[2K` + f.inputLine,
      cursor: { row: inputRow - 1, col: 0 },
    }
  }

  let out = '\x1b[2J\x1b[H'
  out += '\n'
  out += f.banner + '\n'
  out += f.hint + '\n'
  if (f.agentRunning) {
    out += f.agentOutput
  } else {
    if (f.agentOutput.trim()) out += f.agentOutput
    out += f.inputLine
  }
  return {
    writes: out,
    cursor: f.agentRunning ? null : { row: CONTENT_ROW + contentRows, col: 0 },
  }
}

const base: FrameInput = {
  banner: '🔥🔥\n🔥🔥\n',
  hint: '输入 /help 查看命令，/exit 退出',
  agentOutput: '',
  inputLine: '🔥 flare> ',
  agentRunning: false,
  paused: false,
}

describe('contentRowsOf（内容区行数，S0 保持旧语义）', () => {
  it('空串 / 纯空白 → 0 行', () => {
    expect(contentRowsOf('')).toBe(0)
    expect(contentRowsOf('   ')).toBe(0)
    expect(contentRowsOf('\n\n')).toBe(0)
  })

  it('末尾换行会多算一行（作为光标落点，v0.6.x 一直如此）', () => {
    expect(contentRowsOf('a')).toBe(1)
    expect(contentRowsOf('a\n')).toBe(2)
    expect(contentRowsOf('a\nb\n')).toBe(3)
  })
})

describe('composeFrame 与旧实现逐字节等价（S0 零行为变化）', () => {
  const cases: Array<[string, Partial<FrameInput>]> = [
    ['空状态', {}],
    ['有回答、非运行', { agentOutput: '答案\n第二行\n' }],
    ['Agent 运行中', { agentRunning: true, agentOutput: '  💭 思考中\n' }],
    ['运行中但内容为空', { agentRunning: true }],
    ['暂停、无内容', { paused: true }],
    ['暂停、有内容', { paused: true, agentOutput: '答案\n第二行\n' }],
    ['暂停 + 运行中', { paused: true, agentRunning: true, agentOutput: 'x\n' }],
    ['长回答（多行）', { agentOutput: Array.from({ length: 40 }, (_, i) => `行${i + 1}`).join('\n') + '\n' }],
    ['含中文与 emoji 的内容', { agentOutput: '🎯 中文回答\n第二行 🔥\n' }],
  ]

  for (const [name, patch] of cases) {
    it(name, () => {
      const state: FrameInput = { ...base, ...patch }
      expect(composeFrame(state)).toEqual(oldCompose(state))
    })
  }

  it('随机状态 200 组：writes 与 cursor 全部一致', () => {
    const pools = {
      agentOutput: ['', 'a\n', 'a\nb\n', '\n\n', '   ', '🎯多行\n内容\n\n', Array.from({ length: 30 }, (_, i) => `L${i}`).join('\n') + '\n'],
      banner: ['', '🔥\n', '🔥🔥\n🔥🔥\n'],
      inputLine: ['', '🔥 flare> ', '🔥 flare> 长'.repeat(20)],
      hint: ['', 'hint'],
    }
    let seed = 42
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)]

    for (let i = 0; i < 200; i++) {
      const state: FrameInput = {
        banner: pick(pools.banner),
        hint: pick(pools.hint),
        agentOutput: pick(pools.agentOutput),
        inputLine: pick(pools.inputLine),
        agentRunning: rnd() > 0.5,
        paused: rnd() > 0.7,
      }
      expect(composeFrame(state), `第 ${i} 组：${JSON.stringify(state)}`).toEqual(oldCompose(state))
    }
  })
})
