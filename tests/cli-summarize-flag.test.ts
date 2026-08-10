/**
 * flare chat --context-summarize 交互模式压缩摘要开关测试（v0.6.19）
 *
 * 验证 CLI 命令注册：`flare chat --help` 输出包含 --context-summarize 说明
 * （交互模式 Agent 构造在 startInteractive 内部，flag 注册正确即链路可达；
 * contextSummarize 生效行为由 Agent 集成测试覆盖）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'dist', 'cli', 'index.js')

function runCli(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', (d) => { stdout += d.toString() })
    child.stderr!.on('data', (d) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: stdout + stderr }))
  })
}

describe('flare chat --context-summarize（CLI 交互模式压缩摘要开关，v0.6.19）', () => {
  it('--help 输出包含 --context-summarize 说明（命令注册完整）', async () => {
    const r = await runCli(['chat', '--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('--context-summarize')
    expect(r.stdout).toContain('上下文压缩摘要')
  })
})
