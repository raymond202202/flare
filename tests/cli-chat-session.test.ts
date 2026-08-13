/**
 * flare chat -q --session <sessionId> 续聊已有会话测试（v0.6.128）
 *
 * 验证 CLI 命令注册：`flare chat --help` 输出包含 --session 说明；
 * 校验路径：指定的会话不存在 → exit 1 + 提示（不触发生成，快速稳定）；
 * 续聊行为（Agent 构造加载历史）由 Agent 集成测试覆盖（agent.test.ts 历史恢复）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { MemoryStore } from '../src/memory/store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'dist', 'cli', 'index.js')
const children: ChildProcess[] = []
let dir: string
let store: MemoryStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-chat-session-cli-'))
  store = new MemoryStore(join(dir, 'flare.db'))
})

afterEach(() => {
  store.close()
  for (const c of children.splice(0)) c.kill()
  rmSync(dir, { recursive: true, force: true })
})

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, FLARE_HOME: dir },
    })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('flare chat --session（续聊已有会话，v0.6.128）', () => {
  it('--help 输出包含 --session 说明（命令注册完整）', async () => {
    const r = await runCli(['chat', '--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('--session')
    expect(r.stdout).toContain('续聊已有会话')
  })

  it('指定的会话不存在 → exit 1 + 提示（不触发生成，快速返回）', async () => {
    const r = await runCli(['chat', '-q', '你好', '--session', 'no-such-session'])
    expect(r.code).toBe(1)
    expect(r.stdout + r.stderr).toContain('会话 no-such-session 不存在')
  })

  it('预建会话后 --session 续聊 → 校验通过进入生成（不因校验误杀）', async () => {
    // 预建带历史消息的会话（seed 直插，模拟已有对话）
    store.saveMessage('sess-cont', { role: 'user', content: '上一轮的问题' })
    store.updateSessionTitle('sess-cont', '续聊会话')
    const r = await runCli(['chat', '-q', '接着上一轮说', '--session', 'sess-cont'])
    // 校验通过 → 不出现「不存在」错误（后续真实生成可能 fallback 本地模型，只断言校验不误杀）
    expect(r.stdout + r.stderr).not.toContain('会话 sess-cont 不存在')
    // 无论生成成功与否（无 API key 时 fallback 本地模型可能慢/失败），会话记录必须存在且标题不变
    const all = store.getAllSessions()
    expect(all.find((s) => s.id === 'sess-cont')?.title).toBe('续聊会话')
  }, 45000)
})
