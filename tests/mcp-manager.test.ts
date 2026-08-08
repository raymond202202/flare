/**
 * McpManager 测试（v0.5.5）
 *
 * 配置加载（~/.flare/mcp.json 语义）+ connect/disconnect + 工具并集 + 错误记录。
 * 用 mock MCP server fixture（本地子进程，无网络）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { McpManager, loadMcpConfig } from '../src/mcp/manager.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MOCK_SERVER = join(__dirname, 'fixtures', 'mcp-mock-server.mjs')

let dir: string
let configPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-mcp-mgr-test-'))
  configPath = join(dir, 'mcp.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadMcpConfig', () => {
  it('文件不存在 → 空列表（不抛错）', () => {
    expect(loadMcpConfig(join(dir, 'missing.json'))).toEqual([])
  })

  it('非法 JSON → 空列表（不抛错）', () => {
    writeFileSync(configPath, '{not json')
    expect(loadMcpConfig(configPath)).toEqual([])
  })

  it('合法配置 → 返回 servers 列表', () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'fs', command: 'npx' }, { name: 'db', command: 'node', args: ['srv.js'] }] }))
    const servers = loadMcpConfig(configPath)
    expect(servers.length).toBe(2)
    expect(servers[0].name).toBe('fs')
    expect(servers[1].args).toEqual(['srv.js'])
  })
})

describe('McpManager', () => {
  it('connect：连接 mock 服务器 → 工具桥接进入 getAllTools + 状态标记连接', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    const tools = await mgr.connect('mock')
    expect(tools.length).toBe(3)
    expect(tools.map(t => t.definition.function.name)).toContain('echo_text')
    expect(mgr.getAllTools().length).toBe(3)
    const st = mgr.status()
    expect(st[0].connected).toBe(true)
    expect(st[0].toolCount).toBe(3)
    expect(st[0].error).toBeUndefined()
    mgr.closeAll()
  })

  it('connect 幂等：重复连接返回已有工具（不重复 spawn）', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('mock')
    const again = await mgr.connect('mock')
    expect(again.length).toBe(3)
    expect(mgr.getAllTools().length).toBe(3) // 不重复累积
    mgr.closeAll()
  })

  it('connect 未配置名称 → 抛错 + 状态记录错误', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    await expect(mgr.connect('nope')).rejects.toThrow(/未配置 MCP 服务器/)
    expect(mgr.getAllTools().length).toBe(0)
    mgr.closeAll()
  })

  it('connect 启动失败（命令不存在）→ 抛错 + 状态记录错误（服务不崩溃）', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'bad', command: 'definitely-not-a-real-cmd-xyz', args: [] }] }))
    const mgr = new McpManager({ configPath })
    await expect(mgr.connect('bad')).rejects.toThrow()
    const st = mgr.status()
    expect(st[0].connected).toBe(false)
    expect(st[0].error).toBeTruthy()
    mgr.closeAll()
  })

  it('disconnect：断开后工具移除 + 状态标记断开', async () => {
    writeFileSync(configPath, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))
    const mgr = new McpManager({ configPath })
    await mgr.connect('mock')
    expect(mgr.disconnect('mock')).toBe(true)
    expect(mgr.getAllTools().length).toBe(0)
    expect(mgr.status()[0].connected).toBe(false)
    // 幂等：再次断开返回 false
    expect(mgr.disconnect('mock')).toBe(false)
    mgr.closeAll()
  })

  it('setConfig：不依赖配置文件直接注入配置（server --mcp 场景）', async () => {
    const mgr = new McpManager({ configPath: '' })
    mgr.setConfig([{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }])
    const tools = await mgr.connect('mock')
    expect(tools.length).toBe(3)
    mgr.closeAll()
  })
})
