/**
 * translate_command 工具测试（ferry 集成，v0.6.152）
 * 覆盖：工具注册 / 等价 / 近似 / 无等价 / 主机平台解析 / 参数校验
 *
 * 这些用例会真的调用本机 ferry（~/.local/bin/ferry）；ferry 未安装时跳过。
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { tools, getToolDefinitions, executeTool } from '../src/tools/index.js'

const ferryAvailable =
  existsSync(process.env.FERRY_BIN || '') ||
  existsSync(join(homedir(), '.local/bin/ferry')) ||
  existsSync(join(homedir(), '.ferry/install/ferry.py'))

describe('translate_command 工具', () => {
  it('注册在工具列表里（模型能看到）', () => {
    const names = getToolDefinitions().map(t => t.function.name)
    expect(names).toContain('translate_command')
    expect(tools.find(t => t.definition.function.name === 'translate_command')).toBeTruthy()
  })

  it.runIf(ferryAvailable)('Linux 管道命令 → Windows 等价', async () => {
    const r = await executeTool('translate_command', { command: 'ps aux | grep nginx', target: 'windows' })
    expect(r.success).toBe(true)
    expect(r.output).toContain('Get-Process -Name nginx')
    expect(r.output).toContain('等价')
  })

  it.runIf(ferryAvailable)('BSD 差异 → 近似等价且带 caveat', async () => {
    const r = await executeTool('translate_command', { command: "sed -i 's/a/b/' f.txt", target: 'macos' })
    expect(r.success).toBe(true)
    expect(r.output).toContain("sed -i '' 's/a/b/' f.txt")
    expect(r.output).toContain('近似等价')
    expect(r.output).toContain('BSD sed')
  })

  it.runIf(ferryAvailable)('无等价命令 → success=false 且明说不要执行', async () => {
    const r = await executeTool('translate_command', { command: 'chmod +x run.sh', target: 'windows' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('不要执行')
  })

  it.runIf(ferryAvailable)('给 host 时附带可直接执行的 ssh 命令', async () => {
    const r = await executeTool('translate_command', { command: 'ls -la /tmp', target: 'macos', host: 'macbook' })
    expect(r.success).toBe(true)
    expect(r.output).toContain("ssh macbook 'ls -la /tmp'")
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
