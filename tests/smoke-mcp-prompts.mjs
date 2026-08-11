// MCP prompts 桥接冒烟测试（v0.6.36）：真实 dist CLI server 子进程 + 真实 stdio mock 服务器
// 验证：version → mcp_prompts 协议闭环 → mcp_status promptCount
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const CLI = join(root, 'dist', 'cli', 'index.js')
const MOCK_SERVER = join(root, 'tests', 'fixtures', 'mcp-mock-server.mjs')

const tmp = mkdtempSync(join(tmpdir(), 'flare-mcp-prompts-smoke-'))
const mcpConfig = join(tmp, 'mcp.json')
writeFileSync(mcpConfig, JSON.stringify({ servers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] }))

const child = spawn(process.execPath, [CLI, 'server', '--storage', join(tmp, 'test.db'), '--mcp', mcpConfig], {
  env: { ...process.env },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const rl = createInterface({ input: child.stdout })

const fail = (msg) => {
  console.error('SMOKE FAIL:', msg)
  child.kill()
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}

const timer = setTimeout(() => fail('超时'), 25000)

// 启动后立即发 version 请求（服务器是 stdin 驱动的，不请求不输出）
child.stdin.write(JSON.stringify({ type: 'version' }) + '\n')

rl.on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.type === 'version') {
    console.log('version:', m.engine)
    child.stdin.write(JSON.stringify({ type: 'mcp_prompts' }) + '\n')
  } else if (m.type === 'mcp_prompts') {
    const s = m.servers?.[0]
    if (!s || s.name !== 'mock' || s.connected !== true) return fail(`服务器状态异常: ${JSON.stringify(m.servers)}`)
    console.log('mcp_prompts → server:', s.name, 'connected:', s.connected, 'toolCount:', s.toolCount)
    const names = (s.prompts || []).map((p) => `${p.name}${p.arguments ? `(args:${p.arguments.map(a => a.name).join(',')})` : ''}@${p.server}`)
    console.log('prompts:', JSON.stringify(names))
    if (names.length !== 2) return fail(`期望 2 个提示词，实际 ${names.length}`)
    if (!names.includes('greet@mock') || !names.includes('summarize(args:topic)@mock')) return fail(`提示词内容异常: ${names}`)
    child.stdin.write(JSON.stringify({ type: 'mcp_status' }) + '\n')
  } else if (m.type === 'mcp_status') {
    const pc = m.servers?.[0]?.promptCount
    console.log('mcp_status promptCount:', pc)
    if (pc !== 2) return fail(`期望 promptCount 2，实际 ${pc}`)
    clearTimeout(timer)
    console.log('SMOKE PASS')
    child.kill()
    rmSync(tmp, { recursive: true, force: true })
    process.exit(0)
  }
})
