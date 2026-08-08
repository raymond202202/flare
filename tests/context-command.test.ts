/**
 * CLI /context 命令测试（v0.5.6）
 *
 * handleSlashCommand 是纯逻辑（store + output + hooks 注入），不依赖 TTY：
 * 验证 contextInfo hook 被调用、输出消息数/估算 tokens、未提供 hook 时提示不可用。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/memory/store.js'
import { handleSlashCommand } from '../src/cli/index.js'

let store: MemoryStore
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-context-test-'))
  store = new MemoryStore(join(dir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('/context 命令', () => {
  it('/context（有 hook）→ 显示消息数 + 估算 tokens', async () => {
    const lines: string[] = []
    const getter = vi.fn(() => ({ messageCount: 31, estimatedTokens: 2143 }))
    const r = await handleSlashCommand('/context', store, (s) => lines.push(s), undefined, undefined, getter)
    expect(r).toBe('continue')
    expect(getter).toHaveBeenCalledTimes(1)
    expect(lines.join('\n')).toContain('当前会话上下文')
    expect(lines.join('\n')).toContain('消息数:      31')
    expect(lines.join('\n')).toContain('2,143')
  })

  it('/context（无 hook）→ 提示不可用，不报错', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/context', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('上下文不可用')
  })

  it('/context（hook 返回 null）→ 提示不可用', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/context', store, (s) => lines.push(s), undefined, undefined, () => null)
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('上下文不可用')
  })

  it('不触发 /context 的命令不调用 hook', async () => {
    const getter = vi.fn(() => ({ messageCount: 1, estimatedTokens: 10 }))
    await handleSlashCommand('/help', store, () => {}, undefined, undefined, getter)
    expect(getter).not.toHaveBeenCalled()
  })

  it('/help 包含 /context 说明', async () => {
    const lines: string[] = []
    await handleSlashCommand('/help', store, (s) => lines.push(s))
    expect(lines.join('\n')).toContain('/context')
  })
})
