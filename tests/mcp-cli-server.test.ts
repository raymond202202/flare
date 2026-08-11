/**
 * CLI `flare mcp-server` 命令测试（v0.5.8）
 *
 * 通过真实子进程验证：spawn dist CLI `mcp-server` 命令（MCP stdio 服务器），
 * 再用官方 MCPClient 连接——握手/列工具/调工具全链路。
 */
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { MCPClient } from '../src/mcp/client.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'dist', 'cli', 'index.js')
const TSK_CLI = path.join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
const EXT_FIXTURE = path.join(__dirname, 'fixtures', 'mcp-flare-server-templates.ts')
const PROMPTS_FIXTURE = path.join(__dirname, 'fixtures', 'mcp-flare-server-prompts-bridge.ts')
const MOCK_SERVER = path.join(__dirname, 'fixtures', 'mcp-mock-server.mjs')

function spawnCli(args: string[], timeoutMs = 10000): MCPClient {
  return new MCPClient({
    command: process.execPath,
    args: [CLI, ...args],
    timeoutMs,
  })
}

describe('CLI mcp-server 命令（MCP stdio 服务器）', () => {
  it('flare mcp-server：默认暴露全部内置 6 工具，可握手/列工具/调用', async () => {
    const client = spawnCli(['mcp-server'])
    try {
      const init = await client.initialize()
      expect(init.serverInfo?.name).toBe('flare')

      const tools = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual([
        'read_file', 'write_file', 'search_files', 'terminal', 'memory_search', 'memory_save',
      ])

      const ok = await client.callTool('read_file', { path: 'package.json' })
      expect(ok.isError).toBe(false)
      expect(ok.content[0]?.text).toContain('flare-agent')
    } finally {
      client.close()
    }
  })

  it('flare mcp-server -t read_file,terminal：只暴露指定工具', async () => {
    const client = spawnCli(['mcp-server', '-t', 'read_file,terminal'])
    try {
      await client.initialize()
      const tools = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual(['read_file', 'terminal'])
    } finally {
      client.close()
    }
  })

  it('flare mcp-server：安全继承——危险命令仍被拦截', async () => {
    const client = spawnCli(['mcp-server'])
    try {
      await client.initialize()
      const res = await client.callTool('terminal', { command: 'rm -rf /' })
      expect(res.isError).toBe(true)
      expect(res.content[0]?.text).toContain('安全策略拦截')
    } finally {
      client.close()
    }
  })

  it('flare mcp-server --bridge-resources：外部 MCP 服务器资源/模板经 flare 透传给客户端（读取代理转发）', async () => {
    // 临时 MCP 配置：外部 stdio MCP 服务器（mcp-flare-server-templates fixture，暴露 memory://preferences + 模板）
    const dir = mkdtempSync(path.join(tmpdir(), 'flare-mcp-bridge-'))
    const configPath = path.join(dir, 'mcp.json')
    writeFileSync(configPath, JSON.stringify({
      servers: [
        { name: 'ext', command: process.execPath, args: [TSK_CLI, EXT_FIXTURE] },
      ],
    }))

    const client = spawnCli(['mcp-server', '--bridge-resources', '--config', configPath], 15000)
    try {
      const init = await client.initialize()
      expect(init.serverInfo?.name).toBe('flare')
      // 有提供器 → resources 能力声明（subscribe + listTemplates）
      expect((client as any).capabilities?.resources?.subscribe).toBe(true)
      expect((client as any).capabilities?.resources?.listTemplates).toBe(true)
      // 外部资源透传：listResources 能看到外部服务器的资源
      const resources = await client.listResources()
      expect(resources).toEqual([
        { uri: 'memory://preferences', name: '用户偏好', description: '用户偏好设置', mimeType: 'text/plain' },
      ])
      // 外部资源模板透传
      const templates = await client.listResourceTemplates()
      expect(templates).toEqual([
        { uriTemplate: 'memory://{noteId}', name: '记忆条目', description: '记忆库中的单条记忆（动态资源）', mimeType: 'text/plain' },
      ])
      // 读取外部资源：flare 代理转发到外部服务器（内容往返）
      const contents = await client.readResource('memory://preferences')
      expect(contents[0].text).toBe('主题: 浅色')
      // flare 自身工具照常可用（透传不破坏工具）
      const tools = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('read_file')
    } finally {
      client.close()
    }
  })

  it('flare mcp-server --bridge-resources（无配置）：提示 + 仅暴露 flare 自身资源（空列表，不中断）', async () => {
    const client = spawnCli(['mcp-server', '--bridge-resources', '--config', path.join(tmpdir(), 'flare-mcp-nonexistent.json')])
    try {
      await client.initialize()
      const resources = await client.listResources()
      expect(resources).toEqual([])
      const tools = await client.listTools()
      expect(tools.length).toBe(6)
    } finally {
      client.close()
    }
  })

  it('flare mcp-server --bridge-prompts：外部 MCP 服务器提示词经 flare 透传给客户端（渲染代理转发）', async () => {
    // 临时 MCP 配置：外部 stdio MCP 服务器（mcp-flare-server-prompts fixture，暴露 greet + summarize 提示词）
    const dir = mkdtempSync(path.join(tmpdir(), 'flare-mcp-bridge-prompts-'))
    const configPath = path.join(dir, 'mcp.json')
    writeFileSync(configPath, JSON.stringify({
      servers: [
        { name: 'ext', command: process.execPath, args: [TSK_CLI, PROMPTS_FIXTURE] },
      ],
    }))

    const client = spawnCli(['mcp-server', '--bridge-prompts', '--config', configPath], 15000)
    try {
      const init = await client.initialize()
      expect(init.serverInfo?.name).toBe('flare')
      // 有提示词 → prompts 能力声明
      expect((client as any).capabilities?.prompts).toBeTruthy()
      // 外部提示词透传：listPrompts 能看到外部服务器的提示词（元数据 + 参数声明）
      const prompts = await client.listPrompts()
      expect(prompts).toEqual([
        { name: 'greet', description: '打招呼' },
        { name: 'summarize', description: '总结内容', arguments: [{ name: 'topic', description: '主题', required: true }] },
      ])
      // 渲染外部提示词：flare 代理转发到外部服务器（内容往返，带参数补全）
      const greet = await client.getPrompt('greet')
      expect(greet.messages[0]?.content?.text).toBe('你好')
      const summary = await client.getPrompt('summarize', { topic: 'flare' })
      expect(summary.messages[0]?.content?.text).toContain('flare')
      // flare 自身工具照常可用（透传不破坏工具）
      const tools = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('read_file')
    } finally {
      client.close()
    }
  })

  it('flare mcp-server --bridge-prompts（无配置）：提示 + 仅暴露 flare 自身能力（prompts 空，不中断）', async () => {
    const client = spawnCli(['mcp-server', '--bridge-prompts', '--config', path.join(tmpdir(), 'flare-mcp-nonexistent.json')])
    try {
      await client.initialize()
      const prompts = await client.listPrompts()
      expect(prompts).toEqual([])
      const tools = await client.listTools()
      expect(tools.length).toBe(6)
    } finally {
      client.close()
    }
  })

  it('flare mcp-server --bridge-tools：外部 MCP 服务器工具经 flare 透传给客户端（调用代理转发）', async () => {
    // 临时 MCP 配置：外部 stdio MCP 服务器（mcp-mock-server.mjs，暴露 echo_text / add_numbers / fail_tool）
    const dir = mkdtempSync(path.join(tmpdir(), 'flare-mcp-bridge-tools-'))
    const configPath = path.join(dir, 'mcp.json')
    writeFileSync(configPath, JSON.stringify({
      servers: [
        { name: 'ext', command: process.execPath, args: [MOCK_SERVER] },
      ],
    }))

    const client = spawnCli(['mcp-server', '--bridge-tools', '--config', configPath], 15000)
    try {
      const init = await client.initialize()
      expect(init.serverInfo?.name).toBe('flare')
      // 外部工具透传：listTools 能看到外部服务器的工具（并集 = 内置 6 + 外部 3）
      const tools = await client.listTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain('echo_text')
      expect(names).toContain('add_numbers')
      expect(names).toContain('fail_tool')
      expect(names).toContain('read_file') // flare 自身工具照常
      expect(names.length).toBe(9)
      // 调用外部工具：flare 代理转发到外部服务器（内容往返）
      const res = await client.callTool('add_numbers', { a: 2, b: 3 })
      expect(res.isError).toBe(false)
      expect(res.content[0]?.text).toBe('5')
      const echo = await client.callTool('echo_text', { text: 'hello' })
      expect(echo.content[0]?.text).toBe('echo: hello')
    } finally {
      client.close()
    }
  })

  it('flare mcp-server --bridge-tools（无配置）：提示 + 仅暴露 flare 自身工具（不中断）', async () => {
    const client = spawnCli(['mcp-server', '--bridge-tools', '--config', path.join(tmpdir(), 'flare-mcp-nonexistent.json')])
    try {
      await client.initialize()
      const tools = await client.listTools()
      expect(tools.length).toBe(6)
      expect(tools.map((t) => t.name)).not.toContain('echo_text')
    } finally {
      client.close()
    }
  })
})
