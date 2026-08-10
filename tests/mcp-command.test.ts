/**
 * CLI /mcp 命令测试（v0.5.5）
 *
 * handleSlashCommand 是纯逻辑（store + output + mcp hooks 注入），不依赖 TTY：
 * 验证 /mcp 状态展示、connect/disconnect 调用、onChanged 重建回调、错误路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/memory/store.js'
import { handleSlashCommand, type McpCommandHooks } from '../src/cli/index.js'
import type { McpServerStatus, McpResourceRef, McpResourceTemplateRef } from '../src/mcp/types.js'

let store: MemoryStore
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-mcp-cmd-test-'))
  store = new MemoryStore(join(dir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** fake MCP hooks：记录调用，模拟状态 */
function makeHooks(
  initial: McpServerStatus[] = [],
  resourceData: { resources: McpResourceRef[]; templates: McpResourceTemplateRef[] } = { resources: [], templates: [] },
): {
  hooks: McpCommandHooks
  calls: { connect: string[]; disconnect: string[]; changed: number }
  setStatus: (s: McpServerStatus[]) => void
} {
  let status = initial
  const calls = { connect: [] as string[], disconnect: [] as string[], changed: 0 }
  return {
    calls,
    setStatus: (s) => { status = s },
    hooks: {
      list: () => status,
      connect: async (name) => {
        calls.connect.push(name)
        return `已连接 ${name}（3 个 MCP 工具）`
      },
      disconnect: (name) => {
        calls.disconnect.push(name)
        return true
      },
      resources: (name) => ({
        resources: name ? resourceData.resources.filter((r) => r.server === name) : resourceData.resources,
        templates: name ? resourceData.templates.filter((t) => t.server === name) : resourceData.templates,
      }),
      onChanged: () => { calls.changed++ },
    },
  }
}

describe('/mcp 命令', () => {
  it('/mcp（未配置）→ 提示配置位置，不崩溃', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([])
    const r = await handleSlashCommand('/mcp', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('未配置 MCP 服务器')
    expect(lines.join('\n')).toContain('mcp.json')
  })

  it('/mcp（有配置）→ 列出服务器状态（连接标记 + 工具数）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([
      { name: 'fs', connected: true, toolCount: 3 },
      { name: 'db', connected: false, toolCount: 0 },
    ])
    const r = await handleSlashCommand('/mcp', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    const text = lines.join('\n')
    expect(text).toContain('fs')
    expect(text).toContain('3 个工具')
    expect(text).toContain('db')
  })

  it('/mcp connect <name> → 调用 connect + onChanged 重建回调', async () => {
    const lines: string[] = []
    const { hooks, calls } = makeHooks([{ name: 'fs', connected: false, toolCount: 0 }])
    const r = await handleSlashCommand('/mcp connect fs', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(calls.connect).toEqual(['fs'])
    expect(calls.changed).toBe(1)
    expect(lines.join('\n')).toContain('已连接 fs')
    expect(lines.join('\n')).toContain('3 个 MCP 工具')
  })

  it('/mcp connect 摘要带资源/模板数（v0.6.26 格式透传不破坏）', async () => {
    const lines: string[] = []
    const { hooks, calls } = makeHooks([{ name: 'fs', connected: false, toolCount: 0 }])
    // 真实 CLI 的 connect 摘要由 manager 组装（含桥接资源/模板数）；这里验证 handleSlashCommand 透传完整摘要
    const withRes = { ...hooks, connect: async () => '已连接 fs（3 个 MCP 工具 · 2 个资源 · 1 个模板）' }
    const r = await handleSlashCommand('/mcp connect fs', store, (s) => lines.push(s), undefined, withRes)
    expect(r).toBe('continue')
    expect(calls.changed).toBe(1)
    expect(lines.join('\n')).toContain('已连接 fs（3 个 MCP 工具 · 2 个资源 · 1 个模板）')
  })

  it('/mcp connect <未配置名> → 错误输出（hook 抛错）', async () => {
    const lines: string[] = []
    const { hooks, calls } = makeHooks([{ name: 'fs', connected: false, toolCount: 0 }])
    // 让 connect 抛错（模拟未配置）
    const failing = { ...hooks, connect: async () => { throw new Error('未配置 MCP 服务器: nope') } }
    const r = await handleSlashCommand('/mcp connect nope', store, (s) => lines.push(s), undefined, failing)
    expect(r).toBe('continue')
    expect(calls.changed).toBe(0)
    expect(lines.join('\n')).toContain('未配置 MCP 服务器: nope')
  })

  it('/mcp disconnect <name> → 调用 disconnect + onChanged 重建回调', async () => {
    const lines: string[] = []
    const { hooks, calls } = makeHooks([{ name: 'fs', connected: true, toolCount: 3 }])
    const r = await handleSlashCommand('/mcp disconnect fs', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(calls.disconnect).toEqual(['fs'])
    expect(calls.changed).toBe(1)
    expect(lines.join('\n')).toContain('已断开 fs')
  })

  it('/mcp disconnect <未连接名> → 提示未连接（不触发重建）', async () => {
    const lines: string[] = []
    const { hooks, calls } = makeHooks([{ name: 'fs', connected: false, toolCount: 0 }])
    // disconnect 返回 false（未连接）
    const disconnected = { ...hooks, disconnect: () => false }
    const r = await handleSlashCommand('/mcp disconnect fs', store, (s) => lines.push(s), undefined, disconnected)
    expect(r).toBe('continue')
    expect(calls.changed).toBe(0)
    expect(lines.join('\n')).toContain('未连接')
  })

  it('/mcp 用法错误 → 提示用法', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([])
    const r = await handleSlashCommand('/mcp bogus', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('用法')
  })

  it('/mcp（无 hooks）→ 提示 MCP 未启用（库模式安全降级）', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/mcp', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('MCP 未启用')
  })

  it('/mcp（有配置，已连接带资源数）→ 状态行显示工具/资源/模板数（v0.6.26）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([
      { name: 'fs', connected: true, toolCount: 3, resourceCount: 2, templateCount: 1 },
      { name: 'db', connected: false, toolCount: 0 },
    ])
    const r = await handleSlashCommand('/mcp', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    const text = lines.join('\n')
    expect(text).toContain('3 个工具 · 2 资源 · 1 模板')
    expect(text).toContain('db') // 未连接不带资源段
  })

  it('/mcp resources（无参）→ 列出全部已连接服务器的资源与模板（v0.6.26）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks(
      [{ name: 'fs', connected: true, toolCount: 3 }],
      {
        resources: [
          { server: 'fs', uri: 'memory://preferences', name: '用户偏好', description: '用户偏好设置' },
          { server: 'fs', uri: 'file:///etc/hosts', name: 'hosts 文件' },
        ],
        templates: [{ server: 'fs', uriTemplate: 'memory://{noteId}', name: '记忆条目' }],
      },
    )
    const r = await handleSlashCommand('/mcp resources', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    const text = lines.join('\n')
    expect(text).toContain('全部已连接服务器')
    expect(text).toContain('memory://preferences')
    expect(text).toContain('file:///etc/hosts')
    expect(text).toContain('memory://{noteId}')
    expect(text).toContain('2')
  })

  it('/mcp resources <name> → 只列该服务器的资源（过滤生效）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks(
      [{ name: 'fs', connected: true, toolCount: 3 }, { name: 'db', connected: true, toolCount: 1 }],
      {
        resources: [
          { server: 'fs', uri: 'memory://preferences', name: '用户偏好' },
          { server: 'db', uri: 'db://users', name: '用户表' },
        ],
        templates: [],
      },
    )
    const r = await handleSlashCommand('/mcp resources db', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    const text = lines.join('\n')
    expect(text).toContain('「db」')
    expect(text).toContain('db://users')
    expect(text).not.toContain('memory://preferences')
  })

  it('/mcp resources（无资源）→ 友好提示', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([{ name: 'fs', connected: true, toolCount: 3 }])
    const r = await handleSlashCommand('/mcp resources', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    const text = lines.join('\n')
    expect(text).toContain('无已桥接资源')
  })

  it('/mcp resources（hooks 未提供 resources 方法）→ 提示不可用（向后兼容旧宿主）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([{ name: 'fs', connected: true, toolCount: 3 }])
    // 移除 resources 方法（旧版 hooks 形状）
    const legacy = { ...hooks } as McpCommandHooks
    delete (legacy as any).resources
    const r = await handleSlashCommand('/mcp resources', store, (s) => lines.push(s), undefined, legacy)
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('未提供资源桥接')
  })

  it('/mcp 用法错误 → 提示用法（含 resources 子命令）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([])
    const r = await handleSlashCommand('/mcp bogus', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('用法')
    expect(lines.join('\n')).toContain('resources')
  })
})
