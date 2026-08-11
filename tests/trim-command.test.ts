/**
 * CLI /trim 智能裁剪命令测试（v0.6.46）
 *
 * handleSlashCommand 是纯逻辑（store + output + contextTrim hooks 注入）：
 * 验证 /trim 调 apply（缺省预算 / 显式预算 / 非法预算不调）、无 hooks 降级、
 * 预算内提示、/context 超预算裁剪提示、/help 注册。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/memory/store.js'
import { handleSlashCommand, type ContextTrimHooks } from '../src/cli/index.js'

let store: MemoryStore
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-trim-cli-'))
  store = new MemoryStore(join(dir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 构造可裁剪 hooks（droppedCount>0） */
function trimableHooks(applyImpl?: (budget?: number) => { keptCount: number; droppedCount: number } | null): { hooks: ContextTrimHooks; apply: ReturnType<typeof vi.fn> } {
  const apply = vi.fn(applyImpl || ((_budget?: number) => ({ keptCount: 3, droppedCount: 5 })))
  const hooks: ContextTrimHooks = {
    suggest: () => ({ droppedCount: 5, estimatedKeptTokens: 4200, estimatedDroppedTokens: 8800 }),
    apply,
  }
  return { hooks, apply }
}

describe('/trim 命令（v0.6.46）', () => {
  it('/trim（缺省预算）→ 调用 apply 并显示保留/删除条数', async () => {
    const { hooks, apply } = trimableHooks()
    const lines: string[] = []
    const r = await handleSlashCommand('/trim', store, (s) => lines.push(s), undefined, undefined, undefined, undefined, undefined, undefined, hooks)
    expect(r).toBe('continue')
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(undefined) // 缺省预算透传 undefined
    const out = lines.join('\n')
    expect(out).toContain('已智能裁剪')
    expect(out).toContain('保留 3 条')
    expect(out).toContain('删除 5 条')
  })

  it('/trim 8000 → apply 收到显式预算', async () => {
    const { hooks, apply } = trimableHooks()
    await handleSlashCommand('/trim 8000', store, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, hooks)
    expect(apply).toHaveBeenCalledWith(8000)
  })

  it('/trim 非法预算（abc/0/-5/1.5）→ 用法提示，不调用 apply', async () => {
    for (const bad of ['abc', '0', '-5', '1.5']) {
      const { hooks, apply } = trimableHooks()
      const lines: string[] = []
      await handleSlashCommand(`/trim ${bad}`, store, (s) => lines.push(s), undefined, undefined, undefined, undefined, undefined, undefined, hooks)
      expect(lines.join('\n')).toContain('用法: /trim')
      expect(apply).not.toHaveBeenCalled()
    }
  })

  it('/trim（无 hooks）→ 裁剪不可用，不报错', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/trim', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('裁剪不可用')
  })

  it('/trim（apply 返回 null）→ 裁剪不可用', async () => {
    const { hooks } = trimableHooks(() => null)
    const lines: string[] = []
    await handleSlashCommand('/trim', store, (s) => lines.push(s), undefined, undefined, undefined, undefined, undefined, undefined, hooks)
    expect(lines.join('\n')).toContain('裁剪不可用')
  })

  it('/trim（预算内 dropped=0）→ 无需裁剪提示', async () => {
    const apply = vi.fn(() => ({ keptCount: 8, droppedCount: 0 }))
    const hooks: ContextTrimHooks = { suggest: () => ({ droppedCount: 0, estimatedKeptTokens: 100, estimatedDroppedTokens: 0 }), apply }
    const lines: string[] = []
    await handleSlashCommand('/trim', store, (s) => lines.push(s), undefined, undefined, undefined, undefined, undefined, undefined, hooks)
    expect(lines.join('\n')).toContain('无需裁剪')
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('不触发 /trim 的命令不调用 apply', async () => {
    const { hooks, apply } = trimableHooks()
    await handleSlashCommand('/help', store, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, hooks)
    expect(apply).not.toHaveBeenCalled()
  })

  it('/help 注册 /trim 说明', async () => {
    const lines: string[] = []
    await handleSlashCommand('/help', store, (s) => lines.push(s))
    const out = lines.join('\n')
    expect(out).toContain('/trim')
    expect(out).toContain('智能裁剪上下文')
  })
})

describe('/context 裁剪提示（v0.6.46）', () => {
  it('/context 超预算（suggest droppedCount>0）→ 显示可裁剪提示', async () => {
    const { hooks } = trimableHooks()
    const lines: string[] = []
    await handleSlashCommand(
      '/context', store, (s) => lines.push(s),
      undefined, undefined,
      () => ({ messageCount: 8, estimatedTokens: 13000 }),
      undefined, undefined, undefined, hooks
    )
    const out = lines.join('\n')
    expect(out).toContain('可裁剪')
    expect(out).toContain('建议删 5 条消息')
    expect(out).toContain('8,800 tokens')
    expect(out).toContain('/trim')
  })

  it('/context 预算内（suggest droppedCount=0）→ 不显示裁剪提示', async () => {
    const hooks: ContextTrimHooks = {
      suggest: () => ({ droppedCount: 0, estimatedKeptTokens: 100, estimatedDroppedTokens: 0 }),
      apply: () => null,
    }
    const lines: string[] = []
    await handleSlashCommand(
      '/context', store, (s) => lines.push(s),
      undefined, undefined,
      () => ({ messageCount: 2, estimatedTokens: 500 }),
      undefined, undefined, undefined, hooks
    )
    expect(lines.join('\n')).not.toContain('可裁剪')
  })

  it('/context（无 contextTrim）→ 不显示裁剪提示（零回归）', async () => {
    const lines: string[] = []
    await handleSlashCommand(
      '/context', store, (s) => lines.push(s),
      undefined, undefined,
      () => ({ messageCount: 31, estimatedTokens: 2143 })
    )
    const out = lines.join('\n')
    expect(out).toContain('当前会话上下文')
    expect(out).not.toContain('可裁剪')
  })
})
