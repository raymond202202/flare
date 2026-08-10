/**
 * CLI 交互模式 ConfirmationGate 接入测试（v0.6.7）
 *
 * 覆盖：
 * - parseConfirmAnswer：终端确认输入 → 决策映射（y/s/a/n/空/未知 → 安全默认 deny）
 * - formatConfirmPrompt：确认 UI 文案（工具名 + 参数摘要 + 超长截断）
 * - terminalConfirmer：决策流转 / onPause-onResume 包裹 / ask 抛错安全 deny
 * - ConfirmationGate × terminalConfirmer 集成：allow_once 执行 / deny 拒绝 /
 *   allow_session 会话记忆（第二次不再 ask）/ always 持久化到 MemoryStore
 * - /allow 命令：列出 / revoke / 无 hooks 提示 / 用法
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/memory/store.js'
import {
  handleSlashCommand,
  parseConfirmAnswer,
  formatConfirmPrompt,
  terminalConfirmer,
  CLI_CONFIRM_TOOLS,
  type AllowGateHooks,
} from '../src/cli/index.js'
import { ConfirmationGate, memoryStoreKv } from '../src/core/confirm.js'
import type { ConfirmDecision } from '../src/core/confirm.js'
import type { Tool } from '../src/tools/index.js'

let store: MemoryStore
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-cli-confirm-test-'))
  store = new MemoryStore(join(dir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 写回类工具（模拟 memory_save 语义：写入数组） */
function makeSaveTool(saved: string[]): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'memory_save',
        description: '保存一条持久记忆',
        parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
      },
    },
    execute: async (args: any) => {
      saved.push(args.content)
      return { success: true, output: `已保存：${args.content}` }
    },
  }
}

describe('parseConfirmAnswer', () => {
  it('y/yes/allow/allow_once → allow_once（大小写不敏感）', () => {
    for (const a of ['y', 'Y', 'yes', 'allow', 'allow_once', '  y  ']) {
      expect(parseConfirmAnswer(a)).toBe('allow_once')
    }
  })

  it('s/session/allow_session → allow_session', () => {
    for (const a of ['s', 'S', 'session', 'allow_session']) {
      expect(parseConfirmAnswer(a)).toBe('allow_session')
    }
  })

  it('a/always → always', () => {
    for (const a of ['a', 'A', 'always']) {
      expect(parseConfirmAnswer(a)).toBe('always')
    }
  })

  it('n/空/未知 → deny（安全默认）', () => {
    for (const a of ['n', 'N', 'no', '', '   ', 'abc', '42']) {
      expect(parseConfirmAnswer(a)).toBe('deny')
    }
  })
})

describe('formatConfirmPrompt', () => {
  it('包含工具名与参数摘要', () => {
    const p = formatConfirmPrompt('memory_save', { content: '用户喜欢浅色主题', kind: 'preference' })
    expect(p).toContain('memory_save')
    expect(p).toContain('用户喜欢浅色主题')
    expect(p).toContain('[y] 允许一次')
    expect(p).toContain('[n] 拒绝（默认）')
  })

  it('超长参数截断到 120 字符并加省略号', () => {
    const long = 'x'.repeat(300)
    const p = formatConfirmPrompt('memory_save', { content: long })
    expect(p).toContain('…')
    const line = p.split('\n')[0]
    expect(line.length).toBeLessThan(200)
  })

  it('无参数时不显示括号', () => {
    const p = formatConfirmPrompt('memory_save', {})
    expect(p).toContain('⚠️ AI 想调用「memory_save」')
    expect(p).not.toContain('（）')
  })
})

describe('terminalConfirmer', () => {
  it('ask 返回 y → allow_once + 反馈；onPause 先于 onResume', async () => {
    const ask = vi.fn(async () => 'y')
    const onPause = vi.fn()
    const onResume = vi.fn()
    const onFeedback = vi.fn()
    const d = await terminalConfirmer({ toolName: 'memory_save', args: { content: 'hi' }, ask, onPause, onResume, onFeedback })
    expect(d).toBe('allow_once')
    expect(ask).toHaveBeenCalledTimes(1)
    // prompt 文案传给 ask
    expect(ask.mock.calls[0][0]).toContain('memory_save')
    expect(onFeedback.mock.calls[0][0]).toContain('已允许本次')
    expect(onPause).toHaveBeenCalledTimes(1)
    expect(onResume).toHaveBeenCalledTimes(1)
    // onPause 在 ask 之前，onResume 在 ask 之后
    expect(onPause.mock.invocationCallOrder[0]).toBeLessThan(ask.mock.invocationCallOrder[0])
    expect(ask.mock.invocationCallOrder[0]).toBeLessThan(onResume.mock.invocationCallOrder[0])
  })

  it('ask 返回空/未知 → deny + 拒绝反馈', async () => {
    const onFeedback = vi.fn()
    const d = await terminalConfirmer({ toolName: 't', args: {}, ask: async () => '  ' , onFeedback })
    expect(d).toBe('deny')
    expect(onFeedback.mock.calls[0][0]).toContain('已拒绝')
  })

  it('ask 抛错 → deny（安全默认）+ 异常反馈，onResume 仍执行', async () => {
    const onResume = vi.fn()
    const onFeedback = vi.fn()
    const d = await terminalConfirmer({
      toolName: 't', args: {}, ask: async () => { throw new Error('stdin 异常') }, onResume, onFeedback,
    })
    expect(d).toBe('deny')
    expect(onFeedback.mock.calls[0][0]).toContain('异常')
    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it('always → 反馈含跨会话说明', async () => {
    const onFeedback = vi.fn()
    const d = await terminalConfirmer({ toolName: 't', args: {}, ask: async () => 'a', onFeedback })
    expect(d).toBe('always')
    expect(onFeedback.mock.calls[0][0]).toContain('永久放行')
  })
})

describe('ConfirmationGate × terminalConfirmer 集成（CLI 语义）', () => {
  it('allow_once：执行一次；下次再调仍会确认', async () => {
    const saved: string[] = []
    const tool = makeSaveTool(saved)
    const asks: string[] = []
    const gate = new ConfirmationGate({
      sessionId: 'cli-session',
      store: memoryStoreKv(store),
      confirmer: (name, args) => terminalConfirmer({
        toolName: name, args, ask: async () => { asks.push('asked'); return 'y' },
      }),
    })
    const wrapped = gate.wrap(tool)
    const r1 = await wrapped.execute({ content: '第一条' })
    expect(r1.success).toBe(true)
    expect(saved).toEqual(['第一条'])
    const r2 = await wrapped.execute({ content: '第二条' })
    expect(r2.success).toBe(true)
    expect(asks).toHaveLength(2) // allow_once 不记忆 → 每次都确认
    expect(saved).toEqual(['第一条', '第二条'])
  })

  it('deny：不执行，结果带 denied 标记', async () => {
    const saved: string[] = []
    const gate = new ConfirmationGate({
      sessionId: 'cli-session',
      store: memoryStoreKv(store),
      confirmer: (name, args) => terminalConfirmer({
        toolName: name, args, ask: async () => 'n',
      }),
    })
    const wrapped = gate.wrap(makeSaveTool(saved))
    const r = await wrapped.execute({ content: '不应写入' })
    expect(r.success).toBe(false)
    expect((r as any).denied).toBe(true)
    expect(saved).toHaveLength(0)
  })

  it('allow_session：本会话内第二次直接放行（不再 ask）', async () => {
    const saved: string[] = []
    const asks: string[] = []
    const gate = new ConfirmationGate({
      sessionId: 'cli-session',
      store: memoryStoreKv(store),
      confirmer: (name, args) => terminalConfirmer({
        toolName: name, args, ask: async () => { asks.push('asked'); return 's' },
      }),
    })
    const wrapped = gate.wrap(makeSaveTool(saved))
    await wrapped.execute({ content: 'a' })
    await wrapped.execute({ content: 'b' })
    expect(asks).toHaveLength(1) // 第二次不再确认
    expect(saved).toEqual(['a', 'b'])
  })

  it('always：持久化到 MemoryStore settings，新 gate 实例（新会话）也放行', async () => {
    const saved: string[] = []
    const asks: string[] = []
    const makeGate = () => new ConfirmationGate({
      sessionId: 'another-session',
      store: memoryStoreKv(store),
      confirmer: (name, args) => terminalConfirmer({
        toolName: name, args, ask: async () => { asks.push('asked'); return 'a' },
      }),
    })
    // 第一个会话：always → 写入 settings
    const g1 = makeGate()
    await g1.wrap(makeSaveTool(saved)).execute({ content: 'a' })
    expect(asks).toHaveLength(1)
    // 新实例 + 新会话：直接放行（跨会话持久化生效）
    const g2 = makeGate()
    await g2.wrap(makeSaveTool(saved)).execute({ content: 'b' })
    expect(asks).toHaveLength(1) // 不再 ask
    expect(saved).toEqual(['a', 'b'])
    // /allow revoke 可撤销持久化放行
    g2.revoke('memory_save')
    expect(g2.isAllowed('memory_save')).toBe(false)
  })

  it('CLI_CONFIRM_TOOLS 默认名单与 server 端一致（写回类工具）', () => {
    expect(CLI_CONFIRM_TOOLS).toEqual(['memory_save'])
  })
})

describe('/allow 命令', () => {
  const makeHooks = (gate: ConfirmationGate): AllowGateHooks => ({
    list: () => CLI_CONFIRM_TOOLS.filter((t) => gate.isAllowed(t)),
    revoke: (name) => {
      if (gate.isAllowed(name)) {
        gate.revoke(name)
        return true
      }
      return false
    },
  })

  /** 完整 hooks（v0.6.10：含显式放行 + 范围明细，与 CLI 注入点同构） */
  const makeFullHooks = (gate: ConfirmationGate): AllowGateHooks => ({
    list: () => CLI_CONFIRM_TOOLS.filter((t) => gate.isAllowed(t)),
    revoke: (name) => {
      if (gate.isAllowed(name)) {
        gate.revoke(name)
        return true
      }
      return false
    },
    allow: (name, mode) => {
      if (mode === 'always') gate.allowAlways(name)
      else gate.allowSession(name)
      return true
    },
    listDetailed: () => {
      const always = new Set(gate.listAlwaysAllowed(CLI_CONFIRM_TOOLS))
      const session = new Set(gate.listAllowed())
      const names = new Set([...always, ...session])
      return [...names].map((name) => ({
        name,
        scope: (always.has(name) && session.has(name) ? 'both' : always.has(name) ? 'always' : 'session') as 'session' | 'always' | 'both',
      }))
    },
  })

  const run = (cmd: string, hooks?: AllowGateHooks) => {
    const lines: string[] = []
    return handleSlashCommand(cmd, store, (s) => lines.push(s), undefined, undefined, undefined, hooks).then((r) => ({ r, lines }))
  }

  it('/allow（无 hooks）→ 提示确认门未启用', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/allow', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('确认门未启用')
  })

  it('/allow 列出已放行工具', async () => {
    const gate = new ConfirmationGate({
      sessionId: 's', store: memoryStoreKv(store),
      confirmer: async () => 'deny',
    })
    gate.allowSession('memory_save')
    const { lines } = await run('/allow', makeHooks(gate))
    const out = lines.join('\n')
    expect(out).toContain('已放行的确认工具')
    expect(out).toContain('memory_save')
  })

  it('/allow（空名单）→ 提示每次都会确认', async () => {
    const gate = new ConfirmationGate({
      sessionId: 's', store: memoryStoreKv(store),
      confirmer: async () => 'deny',
    })
    const { lines } = await run('/allow', makeHooks(gate))
    expect(lines.join('\n')).toContain('每次都会请求确认')
  })

  it('/allow 有 listDetailed → 标注范围（会话级 / 持久化 / 两者）', async () => {
    const gate = new ConfirmationGate({
      sessionId: 's', store: memoryStoreKv(store),
      confirmer: async () => 'deny',
    })
    gate.allowSession('memory_save') // 会话级
    gate.allowAlways('memory_save') // 持久化（本会话也放行 → 两者）
    const { lines } = await run('/allow', makeFullHooks(gate))
    const out = lines.join('\n')
    expect(out).toContain('memory_save')
    expect(out).toContain('（会话+持久化）')
    // 新会话（新 gate 实例）：持久化放行仍在 → 标注跨会话持久化
    const gate2 = new ConfirmationGate({
      sessionId: 'other', store: memoryStoreKv(store),
      confirmer: async () => 'deny',
    })
    const { lines: lines2 } = await run('/allow', makeFullHooks(gate2))
    const out2 = lines2.join('\n')
    expect(out2).toContain('memory_save')
    expect(out2).toContain('（跨会话持久化）')
    expect(out2).not.toContain('（会话+持久化）')
  })

  it('/allow 无 listDetailed（旧 hooks）→ 回退 list() 不标注范围', async () => {
    const gate = new ConfirmationGate({
      sessionId: 's', store: memoryStoreKv(store),
      confirmer: async () => 'deny',
    })
    gate.allowAlways('memory_save')
    const { lines } = await run('/allow', makeHooks(gate))
    const out = lines.join('\n')
    expect(out).toContain('memory_save')
    expect(out).not.toContain('（跨会话持久化）')
    expect(out).not.toContain('（本会话）')
  })

  it('/allow add <工具名>（缺省 mode）→ 会话级放行，不写持久化', async () => {
    const gate = new ConfirmationGate({
      sessionId: 's', store: memoryStoreKv(store),
      confirmer: async () => 'deny',
    })
    const { lines } = await run('/allow add memory_save', makeFullHooks(gate))
    expect(lines.join('\n')).toContain('已放行 memory_save')
    expect(gate.isAllowed('memory_save')).toBe(true)
    expect(gate.listAllowed()).toEqual(['memory_save']) // 会话级
    expect(store.getSetting('confirm.always.memory_save')).toBeFalsy() // 未持久化
  })

  it('/allow add <工具名> session → 会话级放行', async () => {
    const gate = new ConfirmationGate({
      sessionId: 's', store: memoryStoreKv(store),
      confirmer: async () => 'deny',
    })
    const { lines } = await run('/allow add memory_save session', makeFullHooks(gate))
    expect(lines.join('\n')).toContain('已放行 memory_save')
    expect(gate.listAllowed()).toEqual(['memory_save'])
    expect(store.getSetting('confirm.always.memory_save')).toBeFalsy()
  })

  it('/allow add <工具名> always → 持久化放行（settings 表写入，跨会话生效）', async () => {
    const gate = new ConfirmationGate({
      sessionId: 's', store: memoryStoreKv(store),
      confirmer: async () => 'deny',
    })
    const { lines } = await run('/allow add memory_save always', makeFullHooks(gate))
    expect(lines.join('\n')).toContain('跨会话持久化')
    expect(gate.isAllowed('memory_save')).toBe(true)
    expect(store.getSetting('confirm.always.memory_save')).toBe('1')
    // 新实例（新会话）也放行
    const gate2 = new ConfirmationGate({
      sessionId: 'other', store: memoryStoreKv(store),
      confirmer: async () => 'deny',
    })
    expect(gate2.isAllowed('memory_save')).toBe(true)
  })

  it('/allow add 缺工具名 → 用法提示', async () => {
    const gate = new ConfirmationGate({
      sessionId: 's', store: memoryStoreKv(store),
      confirmer: async () => 'deny',
    })
    const { lines } = await run('/allow add', makeFullHooks(gate))
    expect(lines.join('\n')).toContain('用法: /allow add')
  })

  it('/allow add 非法模式 → 报错不放行', async () => {
    const gate = new ConfirmationGate({
      sessionId: 's', store: memoryStoreKv(store),
      confirmer: async () => 'deny',
    })
    const { lines } = await run('/allow add memory_save forever', makeFullHooks(gate))
    const out = lines.join('\n')
    expect(out).toContain('非法模式')
    expect(gate.isAllowed('memory_save')).toBe(false)
  })

  it('/allow add 无 allow 回调（旧 hooks）→ 提示不支持', async () => {
    const gate = new ConfirmationGate({
      sessionId: 's', store: memoryStoreKv(store),
      confirmer: async () => 'deny',
    })
    const { lines } = await run('/allow add memory_save', makeHooks(gate))
    expect(lines.join('\n')).toContain('不支持显式放行')
  })

  it('/allow add 后 revoke → 恢复每次确认（会话级 + 持久化都清）', async () => {
    const gate = new ConfirmationGate({
      sessionId: 's', store: memoryStoreKv(store),
      confirmer: async () => 'deny',
    })
    await run('/allow add memory_save always', makeFullHooks(gate))
    expect(gate.isAllowed('memory_save')).toBe(true)
    const { lines } = await run('/allow revoke memory_save', makeFullHooks(gate))
    expect(lines.join('\n')).toContain('已撤销 memory_save')
    expect(gate.isAllowed('memory_save')).toBe(false)
    expect(store.getSetting('confirm.always.memory_save')).toBeFalsy()
  })

  it('/allow revoke 已放行工具 → 撤销成功', async () => {
    const gate = new ConfirmationGate({
      sessionId: 's', store: memoryStoreKv(store),
      confirmer: async () => 'deny',
    })
    gate.allowAlways('memory_save')
    const lines: string[] = []
    await handleSlashCommand('/allow revoke memory_save', store, (s) => lines.push(s), undefined, undefined, undefined, makeHooks(gate))
    expect(lines.join('\n')).toContain('已撤销 memory_save')
    expect(gate.isAllowed('memory_save')).toBe(false)
    // 持久化也已清除（MemoryStore setSetting 空串 = 删除键）
    expect(store.getSetting('confirm.always.memory_save')).toBeFalsy()
  })

  it('/allow revoke 未放行工具 → 提示未被放行', async () => {
    const gate = new ConfirmationGate({
      sessionId: 's', store: memoryStoreKv(store),
      confirmer: async () => 'deny',
    })
    const lines: string[] = []
    await handleSlashCommand('/allow revoke memory_save', store, (s) => lines.push(s), undefined, undefined, undefined, makeHooks(gate))
    expect(lines.join('\n')).toContain('未被放行')
  })

  it('/allow 未知子命令 → 用法提示', async () => {
    const gate = new ConfirmationGate({
      sessionId: 's', store: memoryStoreKv(store),
      confirmer: async () => 'deny',
    })
    const lines: string[] = []
    await handleSlashCommand('/allow foo bar', store, (s) => lines.push(s), undefined, undefined, undefined, makeHooks(gate))
    expect(lines.join('\n')).toContain('用法: /allow')
  })

  it('/help 包含 /allow 说明（含 add）', async () => {
    const lines: string[] = []
    await handleSlashCommand('/help', store, (s) => lines.push(s))
    const out = lines.join('\n')
    expect(out).toContain('/allow')
    expect(out).toContain('/allow add')
  })
})

describe('/tools 命令（v0.6.11 当前 Agent 可用工具清单）', () => {
  it('/tools 无回调 → 提示工具清单不可用', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/tools', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('工具清单不可用')
  })

  it('/tools 列出工具：名称/来源/描述 + memory_save 需确认标注', async () => {
    const toolsInfo = () => [
      { name: 'memory_save', description: '保存一条持久记忆', confirmed: true, source: 'builtin' as const },
      { name: 'read_file', description: '读取文件', confirmed: false, source: 'builtin' as const },
      { name: 'mcp_note', description: 'MCP 笔记工具', confirmed: false, source: 'mcp' as const },
    ]
    const lines: string[] = []
    const r = await handleSlashCommand('/tools', store, (s) => lines.push(s), undefined, undefined, undefined, undefined, () => toolsInfo())
    expect(r).toBe('continue')
    const out = lines.join('\n')
    expect(out).toContain('当前可用工具（3）')
    expect(out).toContain('memory_save')
    expect(out).toContain('⚠需确认') // 确认门标注
    expect(out).toContain('保存一条持久记忆')
    expect(out).toContain('mcp_note')
    expect(out).toContain('MCP') // 来源标注
  })

  it('/tools 空清单 → 提示当前没有可用工具', async () => {
    const lines: string[] = []
    await handleSlashCommand('/tools', store, (s) => lines.push(s), undefined, undefined, undefined, undefined, () => [])
    expect(lines.join('\n')).toContain('当前没有可用工具')
  })

  it('/help 包含 /tools 说明', async () => {
    const lines: string[] = []
    await handleSlashCommand('/help', store, (s) => lines.push(s))
    expect(lines.join('\n')).toContain('/tools')
  })
})

describe('/usage 本会话用量（v0.6.17）', () => {
  it('无用量记录 → 提示暂无', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/usage', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('暂无用量记录')
  })

  it('有全局用量 + 提供 sessionId → 显示本会话用量行', async () => {
    // 本会话 2 次调用
    store.logUsage('my-session', 100, 50, 'deepseek-chat')
    store.logUsage('my-session', 200, 80, 'deepseek-chat')
    // 其他会话 1 次（验证按会话过滤）
    store.logUsage('other-session', 999, 999, 'deepseek-chat')

    const lines: string[] = []
    await handleSlashCommand('/usage', store, (s) => lines.push(s), undefined, undefined, undefined, undefined, undefined, 'my-session')
    const out = lines.join('\n')
    expect(out).toContain('📊 Token 用量')
    // 全局统计（3 次调用：prompt 1299 + completion 1129 = 2428）
    expect(out).toContain('2,428')
    // 按模型分解（v0.6.18：perModel——用量分布）
    expect(out).toContain('模型 deepseek-chat')
    expect(out).toContain('3 次调用')
    // 本会话行：430 tokens / 2 次调用
    expect(out).toContain('本会话')
    expect(out).toContain('430 tokens')
    expect(out).toContain('2 次调用')
  })

  it('不提供 sessionId → 不显示本会话行（向后兼容）', async () => {
    store.logUsage('x', 10, 20, 'deepseek-chat')
    const lines: string[] = []
    await handleSlashCommand('/usage', store, (s) => lines.push(s))
    const out = lines.join('\n')
    expect(out).toContain('📊 Token 用量')
    expect(out).not.toContain('本会话')
  })
})
