import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { terminalTool } from '../src/tools/index.js'
import { printResumeBriefing } from '../src/cli/index.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// v0.6.158 修复回归测试（记录 #33/#34/#35/#36）

describe('#34 端口占用不再被当成"代码写错"', () => {
  it('EADDRINUSE 失败时给出「端口占用」判定 + ss 定位命令', async () => {
    // 先用一个独立进程真正占住端口，再让另一个进程去 bind，制造真实的 Errno 98
    const dir = mkdtempSync(join(tmpdir(), 'flare-6158-port-'))
    const pyFile = join(dir, 'bind.py')
    writeFileSync(pyFile, 'import socket, sys, time\ns = socket.socket()\ns.bind(("127.0.0.1", int(sys.argv[1])))\ns.listen(1)\ntime.sleep(30)\n')
    const port = 20000 + Math.floor(Math.random() * 10000)
    const { spawn } = require('node:child_process') as typeof import('node:child_process')
    const holder = spawn('python3', [pyFile, String(port)], { detached: true, stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 500))
      const r = await terminalTool.execute({ command: `python3 ${pyFile} ${port}` })
      expect(r.success).toBe(false)
      expect(r.output).toContain('端口占用')
      expect(r.output).toContain(`sport = :${port}`)
      expect(r.output).toContain('kill <pid>')
    } finally {
      try { process.kill(-holder.pid!, 'SIGKILL') } catch { try { process.kill(holder.pid!, 'SIGKILL') } catch { /* 已退出 */ } }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20000)

  it('普通命令失败不误报端口占用', async () => {
    const r = await terminalTool.execute({ command: 'ls /definitely-not-exist-v6158' })
    expect(r.success).toBe(false)
    expect(r.output).not.toContain('端口占用')
  })
})

describe('#35 无人值守模式下 confirm 档默认拒绝（不可逆操作不能被静默执行）', () => {
  const KEY = 'FLARE_ALLOW_RISKY'
  beforeEach(() => { delete process.env[KEY] })
  afterEach(() => { delete process.env[KEY] })

  it('无人值守 + 未放行 → 拒绝执行，且告知放行方式', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flare-6158-'))
    const victim = join(dir, 'keep.txt')
    writeFileSync(victim, 'x')
    try {
      const r = await terminalTool.execute({ command: `rm -rf ${dir}` })
      expect(r.success).toBe(false)
      expect((r as any).denied).toBe(true)
      // 关键：不能真删掉
      expect(execFileSync('ls', [victim], { encoding: 'utf-8' })).toContain('keep.txt')
      expect(r.error).toContain('--allow-risky')
      expect(r.error).toContain('FLARE_ALLOW_RISKY')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20000)

  it('无人值守 + FLARE_ALLOW_RISKY=1 → 执行，但输出留放行痕迹', async () => {
    process.env[KEY] = '1'
    const dir = mkdtempSync(join(tmpdir(), 'flare-6158-ok-'))
    writeFileSync(join(dir, 'a.txt'), 'x')
    try {
      const r = await terminalTool.execute({ command: `rm -rf ${dir}` })
      expect(r.success).toBe(true)
      expect(r.output).toContain('显式放行')
      expect(() => execFileSync('ls', [dir])).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20000)

  it('安全命令不受影响（不因策略变更误伤日常操作）', async () => {
    const r = await terminalTool.execute({ command: 'echo safe-cmd-ok' })
    expect(r.success).toBe(true)
    expect(r.output).toContain('safe-cmd-ok')
  })
})

describe('#36 续跑前的断点摘要', () => {
  it('打印最近消息摘要 + 工作区状态 + HEAD', () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { lines.push(a.join(' ')) })
    const store = {
      getRecentMessages: () => [
        { role: 'user', content: '把 fluxdl 的 SIGTERM 死锁修掉\n顺带补测试' },
        { role: 'assistant', content: '已完成 _request_shutdown 改造' },
      ],
    } as any
    try {
      printResumeBriefing('sid-6158', store)
    } finally {
      spy.mockRestore()
    }
    const out = lines.join('\n')
    expect(out).toContain('断点摘要')
    expect(out).toContain('你: 把 fluxdl 的 SIGTERM 死锁修掉')
    expect(out).toContain('flare: 已完成 _request_shutdown 改造')
    expect(out).toMatch(/工作区: (干净|\d+ 个未提交改动)/)
    expect(out).toMatch(/HEAD: .+/)
  })
})
