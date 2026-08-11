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
import type { McpServerStatus, McpResourceRef, McpResourceTemplateRef, McpPromptRef } from '../src/mcp/types.js'

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
  initial: (Partial<McpServerStatus> & { name: string; connected: boolean; toolCount: number })[] = [],
  resourceData: { resources: McpResourceRef[]; templates: McpResourceTemplateRef[] } = { resources: [], templates: [] },
  promptData: McpPromptRef[] = [],
  readData: Record<string, { uri: string; mimeType?: string; text: string }[]> = {},
  renderData: Record<string, { description?: string; messages: { role: 'user' | 'assistant'; content: { type: 'text'; text: string } }[] }> = {},
  callData: Record<string, { isError?: boolean; content: { type: string; text?: string }[] }> = {},
): {
  hooks: McpCommandHooks
  calls: { connect: string[]; disconnect: string[]; changed: number; reads: string[]; renders: string[]; calls: string[] }
  setStatus: (s: McpServerStatus[]) => void
} {
  let status = initial.map((s) => ({
    // v0.6.50：旧形状 status（缺 transport/target）补默认值——CLI 渲染向后兼容
    transport: 'stdio' as const,
    target: '',
    ...s,
  })) as McpServerStatus[]
  const calls = { connect: [] as string[], disconnect: [] as string[], changed: 0, reads: [] as string[], renders: [] as string[], calls: [] as string[] }
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
      prompts: (name) => (name ? promptData.filter((p) => p.server === name) : promptData),
      // v0.6.39：读取资源内容 / 渲染提示词（真实代理由 McpManager.readResource/getPrompt 转发）
      readResource: async (server, uri) => {
        calls.reads.push(`${server}:${uri}`)
        const hit = readData[`${server}:${uri}`]
        if (!hit) throw new Error(`MCP 服务器未连接: ${server}`)
        return hit
      },
      renderPrompt: async (server, prompt, args) => {
        calls.renders.push(`${server}:${prompt}:${JSON.stringify(args || {})}`)
        const hit = renderData[`${server}:${prompt}`]
        if (!hit) throw new Error(`未知提示词: ${prompt}`)
        return hit
      },
      // v0.6.41：调用工具（真实代理由 McpManager.callTool 转发）
      callTool: async (server, tool, args) => {
        calls.calls.push(`${server}:${tool}:${JSON.stringify(args || {})}`)
        const hit = callData[`${server}:${tool}`]
        if (!hit) throw new Error(`MCP 服务器未连接: ${server}`)
        return hit
      },
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

  it('/mcp 显示传输类型与目标端点（v0.6.50：stdio/HTTP 区分 + 连接目标可见）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([
      { name: 'local', connected: true, toolCount: 2, transport: 'stdio', target: 'npx @modelcontextprotocol/server-filesystem /tmp' },
      { name: 'remote', connected: false, toolCount: 0, transport: 'http', target: 'http://127.0.0.1:8931/mcp' },
    ])
    const r = await handleSlashCommand('/mcp', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    const text = lines.join('\n')
    // stdio 服务器：标记 [stdio] + 命令目标
    expect(text).toContain('local')
    expect(text).toContain('[stdio]')
    expect(text).toContain('server-filesystem')
    // HTTP 服务器：标记 [HTTP] + 端点 url（未连接也显示传输与端点——配置即可见）
    expect(text).toContain('remote')
    expect(text).toContain('[HTTP]')
    expect(text).toContain('http://127.0.0.1:8931/mcp')
  })

  it('/mcp 旧形状 status（缺 transport/target）→ 默认 stdio + 不崩溃（向后兼容）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([
      { name: 'legacy', connected: true, toolCount: 1 },
    ])
    const r = await handleSlashCommand('/mcp', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    const text = lines.join('\n')
    expect(text).toContain('legacy')
    expect(text).toContain('[stdio]') // 缺省传输标记 stdio
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
    expect(lines.join('\\n')).toContain('已连接 fs（3 个 MCP 工具 · 2 个资源 · 1 个模板）')
  })

  it('/mcp connect 摘要带传输类型标记（v0.6.55：CLI 组装 [stdio]/[HTTP] + 目标，透传显示完整）', async () => {
    // stdio：摘要带 [stdio] + 命令目标
    const lines1: string[] = []
    const h1 = makeHooks([{ name: 'fs', connected: false, toolCount: 0 }])
    const withStdio = { ...h1.hooks, connect: async () => '已连接 fs [stdio] npx server /tmp（3 个 MCP 工具）' }
    const r1 = await handleSlashCommand('/mcp connect fs', store, (s) => lines1.push(s), undefined, withStdio)
    expect(r1).toBe('continue')
    expect(h1.calls.changed).toBe(1)
    const text1 = lines1.join('\n')
    expect(text1).toContain('已连接 fs [stdio] npx server /tmp')
    expect(text1).toContain('3 个 MCP 工具')
    // HTTP：摘要带 [HTTP] + 端点 url
    const lines2: string[] = []
    const h2 = makeHooks([{ name: 'remote', connected: false, toolCount: 0 }])
    const withHttp = { ...h2.hooks, connect: async () => '已连接 remote [HTTP] http://127.0.0.1:8931/mcp（3 个 MCP 工具）' }
    const r2 = await handleSlashCommand('/mcp connect remote', store, (s) => lines2.push(s), undefined, withHttp)
    expect(r2).toBe('continue')
    expect(h2.calls.changed).toBe(1)
    const text2 = lines2.join('\n')
    expect(text2).toContain('已连接 remote [HTTP] http://127.0.0.1:8931/mcp')
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

  // ===== v0.6.36 prompts 桥接 =====

  it('/mcp（有配置，已连接带提示词数）→ 状态行显示工具/资源/模板/提示词数（v0.6.36）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([{ name: 'fs', connected: true, toolCount: 3, resourceCount: 2, templateCount: 1, promptCount: 2 }])
    const r = await handleSlashCommand('/mcp', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    const text = lines.join('\n')
    expect(text).toContain('● fs')
    expect(text).toContain('3 个工具')
    expect(text).toContain('2 资源')
    expect(text).toContain('1 模板')
    expect(text).toContain('2 提示词')
  })

  it('/mcp prompts（无参）→ 列出全部已连接服务器的提示词（v0.6.36）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks(
      [{ name: 'fs', connected: true, toolCount: 3 }],
      undefined,
      [
        { server: 'fs', name: 'greet', description: '打招呼' },
        { server: 'fs', name: 'summarize', description: '总结内容', arguments: [{ name: 'topic', description: '主题', required: true }] },
      ],
    )
    const r = await handleSlashCommand('/mcp prompts', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    const text = lines.join('\n')
    expect(text).toContain('全部已连接服务器')
    expect(text).toContain('greet')
    expect(text).toContain('打招呼')
    expect(text).toContain('summarize')
    expect(text).toContain('topic')
  })

  it('/mcp prompts <name> → 只列该服务器的提示词（过滤生效）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks(
      [{ name: 'fs', connected: true, toolCount: 3 }, { name: 'db', connected: true, toolCount: 1 }],
      undefined,
      [
        { server: 'fs', name: 'greet', description: '打招呼' },
        { server: 'db', name: 'summarize', description: '总结内容' },
      ],
    )
    const r = await handleSlashCommand('/mcp prompts db', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    const text = lines.join('\n')
    expect(text).toContain('「db」')
    expect(text).toContain('summarize')
    expect(text).not.toContain('greet')
  })

  it('/mcp prompts（无提示词）→ 友好提示', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([{ name: 'fs', connected: true, toolCount: 3 }])
    const r = await handleSlashCommand('/mcp prompts', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('无已桥接提示词')
  })

  it('/mcp prompts（hooks 未提供 prompts 方法）→ 提示不可用（向后兼容旧宿主）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([{ name: 'fs', connected: true, toolCount: 3 }])
    // 移除 prompts 方法（旧版 hooks 形状）
    const legacy = { ...hooks } as McpCommandHooks
    delete (legacy as any).prompts
    const r = await handleSlashCommand('/mcp prompts', store, (s) => lines.push(s), undefined, legacy)
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('未提供提示词桥接')
  })

  it('/mcp 用法错误 → 提示用法（含 prompts 子命令）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([])
    const r = await handleSlashCommand('/mcp bogus', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('prompts')
  })

  // ===== v0.6.39 read / render =====
  it('/mcp read <server> <uri> → 显示资源内容（代理转发 readResource）', async () => {
    const lines: string[] = []
    const { hooks, calls } = makeHooks(
      [{ name: 'mock', connected: true, toolCount: 3 }],
      undefined,
      undefined,
      { 'mock:memory://preferences': [{ uri: 'memory://preferences', mimeType: 'text/plain', text: '主题: 浅色' }] },
    )
    const r = await handleSlashCommand('/mcp read mock memory://preferences', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(calls.reads).toEqual(['mock:memory://preferences'])
    const text = lines.join('\n')
    expect(text).toContain('mock 的资源 memory://preferences')
    expect(text).toContain('主题: 浅色')
    expect(text).toContain('text/plain')
  })

  it('/mcp read（服务器未连接）→ 错误输出不崩溃', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([])
    const r = await handleSlashCommand('/mcp read ghost memory://x', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('MCP 服务器未连接: ghost')
  })

  it('/mcp read（缺 uri）→ 提示用法（不调用）', async () => {
    const lines: string[] = []
    const { hooks, calls } = makeHooks([])
    const r = await handleSlashCommand('/mcp read mock', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(calls.reads).toEqual([])
    expect(lines.join('\n')).toContain('用法')
  })

  it('/mcp read（hooks 未提供 readResource 方法）→ 提示不可用（向后兼容旧宿主）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([])
    const legacy = { ...hooks } as McpCommandHooks
    delete (legacy as any).readResource
    const r = await handleSlashCommand('/mcp read mock memory://x', store, (s) => lines.push(s), undefined, legacy)
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('未提供资源读取')
  })

  it('/mcp render <server> <prompt> → 显示渲染消息（代理转发 renderPrompt）', async () => {
    const lines: string[] = []
    const { hooks, calls } = makeHooks(
      [{ name: 'mock', connected: true, toolCount: 3 }],
      undefined,
      undefined,
      undefined,
      { 'mock:greet': { messages: [{ role: 'user', content: { type: 'text', text: '你好' } }] } },
    )
    const r = await handleSlashCommand('/mcp render mock greet', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(calls.renders).toEqual(['mock:greet:{}'])
    const text = lines.join('\n')
    expect(text).toContain('mock 的提示词 greet')
    expect(text).toContain('user: 你好')
  })

  it('/mcp render <server> <prompt> k=v → 参数透传 + 描述展示', async () => {
    const lines: string[] = []
    const { hooks, calls } = makeHooks(
      [{ name: 'mock', connected: true, toolCount: 3 }],
      undefined,
      undefined,
      undefined,
      { 'mock:summarize': { description: '总结内容', messages: [{ role: 'user', content: { type: 'text', text: '请总结关于「flare」的内容' } }] } },
    )
    const r = await handleSlashCommand('/mcp render mock summarize topic=flare', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(calls.renders).toEqual(['mock:summarize:{"topic":"flare"}'])
    const text = lines.join('\n')
    expect(text).toContain('总结内容')
    expect(text).toContain('请总结关于「flare」的内容')
  })

  it('/mcp render（未知提示词）→ 错误输出不崩溃', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([])
    const r = await handleSlashCommand('/mcp render mock ghost', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('未知提示词: ghost')
  })

  it('/mcp render（缺 prompt）→ 提示用法（不调用）', async () => {
    const lines: string[] = []
    const { hooks, calls } = makeHooks([])
    const r = await handleSlashCommand('/mcp render mock', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(calls.renders).toEqual([])
    expect(lines.join('\n')).toContain('用法')
  })

  it('/mcp render（hooks 未提供 renderPrompt 方法）→ 提示不可用（向后兼容旧宿主）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([])
    const legacy = { ...hooks } as McpCommandHooks
    delete (legacy as any).renderPrompt
    const r = await handleSlashCommand('/mcp render mock greet', store, (s) => lines.push(s), undefined, legacy)
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('未提供提示词渲染')
  })

  it('/mcp 用法错误 → 提示用法（含 read / render 子命令）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([])
    const r = await handleSlashCommand('/mcp bogus', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    const text = lines.join('\n')
    expect(text).toContain('read <server> <uri>')
    expect(text).toContain('render <server> <prompt>')
  })

  // ===== v0.6.41 call =====
  it('/mcp call <server> <tool> [JSON参数] → 显示工具返回（代理转发 callTool）', async () => {
    const lines: string[] = []
    const { hooks, calls } = makeHooks(
      [{ name: 'mock', connected: true, toolCount: 3 }],
      undefined, undefined, undefined, undefined,
      { 'mock:add_numbers': { content: [{ type: 'text', text: '5' }] } },
    )
    const r = await handleSlashCommand('/mcp call mock add_numbers {"a":2,"b":3}', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(calls.calls).toEqual(['mock:add_numbers:{"a":2,"b":3}'])
    const text = lines.join('\n')
    expect(text).toContain('mock 的工具 add_numbers 返回')
    expect(text).toContain('5')
  })

  it('/mcp call → 工具级失败（isError）→ 失败输出不崩溃', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks(
      [{ name: 'mock', connected: true, toolCount: 3 }],
      undefined, undefined, undefined, undefined,
      { 'mock:fail_tool': { isError: true, content: [{ type: 'text', text: '出错了' }] } },
    )
    const r = await handleSlashCommand('/mcp call mock fail_tool', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    const text = lines.join('\n')
    expect(text).toContain('执行失败')
    expect(text).toContain('出错了')
  })

  it('/mcp call（非法 JSON 参数）→ 提示参数错误，不调用', async () => {
    const lines: string[] = []
    const { hooks, calls } = makeHooks([])
    const r = await handleSlashCommand('/mcp call mock echo not-json', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(calls.calls).toEqual([])
    expect(lines.join('\n')).toContain('不是合法 JSON')
  })

  it('/mcp call（缺 tool）→ 提示用法（不调用）', async () => {
    const lines: string[] = []
    const { hooks, calls } = makeHooks([])
    const r = await handleSlashCommand('/mcp call mock', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(calls.calls).toEqual([])
    expect(lines.join('\n')).toContain('用法')
  })

  it('/mcp call（服务器未连接）→ 错误输出不崩溃', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([])
    const r = await handleSlashCommand('/mcp call ghost echo_text', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('MCP 服务器未连接: ghost')
  })

  it('/mcp call（hooks 未提供 callTool 方法）→ 提示不可用（向后兼容旧宿主）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([])
    const legacy = { ...hooks } as McpCommandHooks
    delete (legacy as any).callTool
    const r = await handleSlashCommand('/mcp call mock echo_text', store, (s) => lines.push(s), undefined, legacy)
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('未提供工具调用')
  })

  it('/mcp 用法错误 → 提示用法（含 call 子命令）', async () => {
    const lines: string[] = []
    const { hooks } = makeHooks([])
    const r = await handleSlashCommand('/mcp bogus', store, (s) => lines.push(s), undefined, hooks)
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('call <server> <tool>')
  })
})
