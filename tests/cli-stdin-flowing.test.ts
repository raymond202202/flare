/**
 * FLARE 问题记录 #18 回归测试：确认门 rl.close() 之后 stdin 卡在 paused
 *
 * 症状（用户报告）：一轮跑完后输入框再也收不到键盘，Ctrl+C 也退不出去，只能关终端。
 * 根因：app 内零散 `readline.createInterface({input: process.stdin}).close()` 会
 * 把 stdin pause 掉；LineInput 只做 setRawMode + on('data')，不会恢复流动。
 *
 * 覆盖：
 * - ensureStdinFlowing：paused → resume；flowing → 不重复 resume；无 isPaused 的流 → resume
 * - write_file：父目录不存在时自动创建（原 ENOENT 失败）
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureStdinFlowing } from '../src/cli/line-input.js'
import { writeFileTool } from '../src/tools/index.js'

describe('ensureStdinFlowing：修复确认门后 stdin 假死（问题记录 #18）', () => {
  it('paused 的 stdin 会被 resume', () => {
    let paused = true
    const resume = vi.fn(() => { paused = false })
    const fake = { isPaused: () => paused, resume } as unknown as NodeJS.ReadStream

    ensureStdinFlowing(fake)

    expect(resume).toHaveBeenCalledTimes(1)
    expect(paused).toBe(false)
  })

  it('已经 flowing 时不重复 resume（避免多次 resume 造成输入重复）', () => {
    const resume = vi.fn()
    const fake = { isPaused: () => false, resume } as unknown as NodeJS.ReadStream

    ensureStdinFlowing(fake)

    expect(resume).not.toHaveBeenCalled()
  })

  it('没有 isPaused 方法时保守 resume', () => {
    const resume = vi.fn()
    const fake = { resume } as unknown as { resume: () => void }

    ensureStdinFlowing(fake as unknown as NodeJS.ReadStream)

    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('resume 抛错不向外传播（不能让输入流程崩掉）', () => {
    const fake = {
      isPaused: () => true,
      resume: () => { throw new Error('boom') },
    } as unknown as NodeJS.ReadStream

    expect(() => ensureStdinFlowing(fake)).not.toThrow()
  })
})

describe('write_file：父目录自动创建', () => {
  it('写入不存在的多层目录时会自动 mkdir -p', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flare-write-'))
    try {
      const target = join(dir, 'scripts', 'nested', 'check_stdlib_only.py')

      const res = writeFileTool.execute({ path: target, content: 'print("ok")\n' })

      expect(res.success).toBe(true)
      expect(existsSync(target)).toBe(true)
      expect(readFileSync(target, 'utf-8')).toContain('print("ok")')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
