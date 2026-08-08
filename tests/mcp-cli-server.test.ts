/**
 * CLI `flare mcp-server` 命令测试（v0.5.8）
 *
 * 通过真实子进程验证：spawn dist CLI `mcp-server` 命令（MCP stdio 服务器），
 * 再用官方 MCPClient 连接——握手/列工具/调工具全链路。
 */
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { MCPClient } from '../src/mcp/client.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'dist', 'cli', 'index.js')

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
})
