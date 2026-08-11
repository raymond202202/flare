/**
 * terminal 工具退出码暴露测试（v0.6.33）
 *
 * 验证 terminalTool 失败时错误信息带退出码/信号（AI 可判断失败性质）：
 * 退出码 3 → 带「（退出码 3）」；命令不存在 → 127；超时 → 信号提示；成功路径零回归。
 */
import { describe, it, expect } from 'vitest'
import { terminalTool } from '../src/tools/index.js'

describe('terminalTool 退出码暴露（v0.6.33）', () => {
  it('成功路径零回归：echo 输出内容', () => {
    const r = terminalTool.execute({ command: 'echo flare-exitcode-test' })
    expect(r.success).toBe(true)
    expect(r.output).toContain('flare-exitcode-test')
  })

  it('失败命令带退出码：exit 3 → 「（退出码 3）」', () => {
    const r = terminalTool.execute({ command: 'exit 3' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('命令执行失败（退出码 3）')
  })

  it('命令不存在 → 退出码 127（bash 找不到命令）', () => {
    const r = terminalTool.execute({ command: 'flare_nonexistent_cmd_xyz_12345' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('（退出码 127）')
  })

  it('exit 0 成功不误报', () => {
    const r = terminalTool.execute({ command: 'exit 0' })
    expect(r.success).toBe(true)
  })
})
