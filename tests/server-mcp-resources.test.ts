/**
 * server 协议 mcp_resources 测试（v0.6.26）
 *
 * 资源桥接的协议层验证：flare server --mcp <config> 连接外部 MCP 服务器（mock fixture，
 * 真实 stdio 子进程）后，宿主可经 mcp_resources 请求查看其资源/模板清单（按服务器分组）。
 * 只读、不触发生成、不创建会话。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'dist', 'cli', 'index.js')
const MOCK_SERVER = path.join(__dirname, 'fixtures', 'mcp-mock-server.mjs')

let child: ChildProcess
let rl: Interface
let tempDir: string

function request(msg: any, expectTypes: string[], timeout = 15000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const msgs: any[] = []
    const timer = setTimeout(() => { cleanup(); reject(new Error(`超时（请求 ${JSON.stringify(msg).slice(0, 80)}）`)) }, timeout)
    const handler = (line: string) => {
      try {
        const parsed = JSON.parse(line)
        if (expectTypes.includes(parsed.type)) {
          msgs.push(parsed)
          cleanup()
          resolve(msgs)
        }
      } catch { /* 非 JSON 行忽略 */ }
    }
    const cleanup = () => { clearTimeout(timer); rl.removeListener('line', handler) }
    rl.on('line', handler)
    child.stdin!.write(JSON.stringify(msg) + '\n')
  })
}

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'flare-server-mcp-res-test-'))
  // --mcp 配置文件：连接 mock 服务器（真实 stdio 子进程，暴露 3 工具 + 2 资源 + 1 模板）
  const mcpConfig = path.join(tempDir, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify({
    servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }],
  }))
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  delete env.DEEPSEEK_API_KEY
  child = spawn(process.execPath, [CLI, 'server', '--storage', path.join(tempDir, 'test.db'), '--mcp', mcpConfig], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  rl = createInterface({ input: child.stdout! })
  // 等待服务就绪（version 响应）
  await request({ type: 'version' }, ['version'])
})

afterAll(() => {
  child.kill()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('flare host server mcp_resources 协议', () => {
  it('mcp_resources → 已连接服务器的资源/模板清单（真实子进程闭环）', async () => {
    const msgs = await request({ type: 'mcp_resources' }, ['mcp_resources'])
    const res = msgs[0]
    expect(res.type).toBe('mcp_resources')
    expect(Array.isArray(res.servers)).toBe(true)
    expect(res.servers.length).toBe(1)
    const s = res.servers[0]
    expect(s.name).toBe('mock')
    expect(s.connected).toBe(true)
    // 资源：mock 服务器暴露 2 个（memory://preferences + file:///etc/hosts）
    expect(Array.isArray(s.resources)).toBe(true)
    expect(s.resources.length).toBe(2)
    expect(s.resources[0]).toMatchObject({ server: 'mock', uri: 'memory://preferences', name: '用户偏好' })
    expect(s.resources[1].uri).toBe('file:///etc/hosts')
    // 模板：1 个动态资源模板
    expect(Array.isArray(s.templates)).toBe(true)
    expect(s.templates.length).toBe(1)
    expect(s.templates[0]).toMatchObject({ server: 'mock', uriTemplate: 'memory://{noteId}', name: '记忆条目' })
  }, 30000)

  it('mcp_status → 已连接带 resourceCount/templateCount（与 mcp_resources 一致）', async () => {
    const msgs = await request({ type: 'mcp_status' }, ['mcp_status'])
    const s = msgs[0].servers[0]
    expect(s.name).toBe('mock')
    expect(s.connected).toBe(true)
    expect(s.toolCount).toBe(3)
    expect(s.resourceCount).toBe(2)
    expect(s.templateCount).toBe(1)
  }, 30000)
})
