/**
 * translate_command 工具测试（v0.6.153，引擎内嵌）
 *
 * 覆盖：工具注册 / 等价 / 近似 / 无等价 / 主机平台解析 / 参数校验。
 * 不再依赖本机安装 ferry —— 引擎和数据都在 src/tools/ferry-core/ 里编译进包。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { tools, getToolDefinitions, executeTool } from '../src/tools/index.js'

let hostsDir: string
const oldHosts = process.env.FERRY_HOSTS

beforeAll(() => {
  hostsDir = mkdtempSync(join(tmpdir(), 'flare-ferry-hosts-'))
  const path = join(hostsDir, 'hosts.json')
  writeFileSync(path, JSON.stringify({
    hosts: { macbook: { platform: 'macos', user: 'dev' }, winbox: { platform: 'windows', user: 'dev' } },
  }))
  process.env.FERRY_HOSTS = path
})

afterAll(() => {
  if (oldHosts === undefined) delete process.env.FERRY_HOSTS
  else process.env.FERRY_HOSTS = oldHosts
  rmSync(hostsDir, { recursive: true, force: true })
})

describe('translate_command 工具', () => {
  it('注册在工具列表里（模型能看到）', () => {
    const names = getToolDefinitions().map(t => t.function.name)
    expect(names).toContain('translate_command')
    expect(tools.find(t => t.definition.function.name === 'translate_command')).toBeTruthy()
  })

  it('Linux 管道命令 → Windows 等价', async () => {
    const r = await executeTool('translate_command', { command: 'ps aux | grep nginx', target: 'windows' })
    expect(r.success).toBe(true)
    expect(r.output).toContain('Get-Process -Name nginx')
    expect(r.output).toContain('等价')
  })

  it('BSD 差异 → 近似等价且带 caveat', async () => {
    const r = await executeTool('translate_command', { command: "sed -i 's/a/b/' f.txt", target: 'macos' })
    expect(r.success).toBe(true)
    expect(r.output).toContain("sed -i '' 's/a/b/' f.txt")
    expect(r.output).toContain('近似等价')
    expect(r.output).toContain('BSD sed')
  })

  it('无等价命令 → success=false 且明说不要执行', async () => {
    const r = await executeTool('translate_command', { command: 'chmod +x run.sh', target: 'windows' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('不要执行')
  })

  it('给 host 时附带可直接执行的 ssh 命令，并按主机表补平台', async () => {
    const r = await executeTool('translate_command', { command: 'ls -la /tmp', host: 'macbook' })
    expect(r.success).toBe(true)
    expect(r.output).toContain('目标 macOS')
    expect(r.output).toContain("ssh dev@macbook 'ls -la /tmp'")
  })

  it('Windows 主机给出 Windows 目标的翻译', async () => {
    const r = await executeTool('translate_command', { command: 'ls -la', host: 'winbox' })
    expect(r.success).toBe(true)
    expect(r.output).toContain('目标 Windows')
  })

  it('缺 command → 报错而不是静默成功', async () => {
    const r = await executeTool('translate_command', { command: '  ', target: 'macos' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('command')
  })

  it('未知 host 且没给 target → 提示登记而不是瞎猜平台', async () => {
    const r = await executeTool('translate_command', { command: 'ls', host: 'no-such-host-xyz' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('ferry hosts add')
  })
})
