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
  dir = mkdtempSync(join(tmpdir(), 'flare-usage-cli-'))
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
describe('flare usage', () => {
  it('全局汇总：总计 tokens 与 perModel 分解', async () => {
    store.logUsage('sess-a', 100, 50, 'deepseek-chat')
    store.logUsage('sess-b', 200, 80, 'deepseek-reasoner')
    const { code, stdout } = await runCli(['usage'])
    expect(code).toBe(0)
    expect(stdout).toContain('Token 用量')
    expect(stdout).toContain('430 tokens')
    expect(stdout).toContain('会话数:')
    expect(stdout).toContain('模型 deepseek-chat: 150 tokens（1 次调用）')
    expect(stdout).toContain('模型 deepseek-reasoner: 280 tokens（1 次调用）')
  }, 20000)
  it('缓存命中显示：tokens 数与命中率百分比', async () => {
    store.logUsage('sess-a', 200, 50, 'deepseek-chat', { cacheReadTokens: 100 })
    const { code, stdout } = await runCli(['usage'])
    expect(code).toBe(0)
    expect(stdout).toContain('缓存命中')
    expect(stdout).toContain('100 tokens')
    expect(stdout).toContain('50%')
  }, 20000)
  it('缓存写入显示（v0.6.131）：文本模式补缓存写入行', async () => {
    store.logUsage('sess-a', 200, 50, 'deepseek-chat', { cacheWriteTokens: 150 })
    const { code, stdout } = await runCli(['usage'])
    expect(code).toBe(0)
    expect(stdout).toContain('缓存写入')
    expect(stdout).toContain('150 tokens')
  }, 20000)
  it('缓存写入不显示（v0.6.131）：无写入时不出缓存写入行', async () => {
    store.logUsage('sess-a', 200, 50, 'deepseek-chat')
    const { code, stdout } = await runCli(['usage'])
    expect(code).toBe(0)
    expect(stdout).not.toContain('缓存写入')
  }, 20000)
  it('缓存写入显示（v0.6.131）：--session 单会话分支同样补缓存写入行', async () => {
    store.logUsage('sess-a', 200, 50, 'deepseek-chat', { cacheWriteTokens: 150 })
    const { code, stdout } = await runCli(['usage', '--session', 'sess-a'])
    expect(code).toBe(0)
    expect(stdout).toContain('缓存写入')
    expect(stdout).toContain('150 tokens')
  }, 20000)
  it('缓存写入显示（v0.6.131）：perModel 分解子行带缓存写入', async () => {
    store.logUsage('sess-a', 200, 50, 'deepseek-chat', { cacheWriteTokens: 150 })
    const { code, stdout } = await runCli(['usage'])
    expect(code).toBe(0)
    // 全局 perModel 子行：模型行下的缓存写入
    expect(stdout).toContain('模型 deepseek-chat')
    expect(stdout).toContain('缓存写入')
    expect(stdout).toContain('150 tokens')
  }, 20000)
  it('--session：只看单会话', async () => {
    store.logUsage('sess-a', 100, 50, 'deepseek-chat')
    store.logUsage('sess-b', 200, 80, 'deepseek-reasoner')
    const { code, stdout } = await runCli(['usage', '--session', 'sess-a'])
    expect(code).toBe(0)
    expect(stdout).toContain('会话 sess-a Token 用量')
    expect(stdout).toContain('150 tokens')
    expect(stdout).toContain('1 次调用')
    expect(stdout).not.toContain('模型 deepseek-reasoner')
  }, 20000)
  it('空库：文本提示暂无用量记录', async () => {
    const { code, stdout } = await runCli(['usage'])
    expect(code).toBe(0)
    expect(stdout).toContain('暂无用量记录')
  }, 20000)
  it('不存在的 --session：提示暂无用量记录，退出码 0', async () => {
    const { code, stdout } = await runCli(['usage', '--session', 'nope'])
    expect(code).toBe(0)
    expect(stdout).toContain('会话 nope 暂无用量记录')
  }, 20000)
  it('估算成本与缓存节省显示（deepseek-chat 可定价）', async () => {
    store.logUsage('sess-a', 200, 100, 'deepseek-chat', { cacheReadTokens: 100, estimatedCostUsd: 0.00123 })
    const { code, stdout } = await runCli(['usage'])
    expect(code).toBe(0)
    expect(stdout).toContain('估算成本')
    expect(stdout).toContain('$0.0012')
    expect(stdout).toContain('缓存节省')
  }, 20000)
  it('--json 全局：结构化 stats 可解析（totalTokens/sessionCount/perModel）', async () => {
    store.logUsage('sess-a', 100, 50, 'deepseek-chat')
    store.logUsage('sess-b', 200, 80, 'deepseek-reasoner')
    const { code, stdout } = await runCli(['usage', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.totalTokens).toBe(430)
    expect(parsed.sessionCount).toBe(2)
    expect(parsed.perModel.length).toBe(2)
  }, 20000)
  it('--session --json：单会话 stats 可解析（sessionId/totalTokens/callCount）', async () => {
    store.logUsage('sess-a', 100, 50, 'deepseek-chat')
    const { code, stdout } = await runCli(['usage', '--session', 'sess-a', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.sessionId).toBe('sess-a')
    expect(parsed.totalTokens).toBe(150)
    expect(parsed.callCount).toBe(1)
  }, 20000)
  it('--json 缓存字段：cacheReadTokens 与成本字段为数值', async () => {
    store.logUsage('sess-a', 200, 50, 'deepseek-chat', { cacheReadTokens: 100, estimatedCostUsd: 0.00123 })
    const { code, stdout } = await runCli(['usage', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.cacheReadTokens).toBe(100)
    expect(typeof parsed.cacheSavedUsd).toBe('number')
    expect(typeof parsed.estimatedCostUsd).toBe('number')
  }, 20000)
  it('--json 空库：零值 stats 可解析（totalTokens=0/sessionCount=0）', async () => {
    const { code, stdout } = await runCli(['usage', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.totalTokens).toBe(0)
    expect(parsed.sessionCount).toBe(0)
  }, 20000)
  it('--json 不存在的 --session：零值 stats 可解析（totalTokens=0）', async () => {
    const { code, stdout } = await runCli(['usage', '--session', 'nope', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.totalTokens).toBe(0)
  }, 20000)
})
