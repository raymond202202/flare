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
  dir = mkdtempSync(join(tmpdir(), 'flare-trim-keep-cli-'))
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

function seedSession(sid: string, count: number): void {
  for (let i = 1; i <= count; i++) {
    store.saveMessage(sid, {
      role: i % 2 === 1 ? 'user' : 'assistant',
      content: `这是一条用于测试上下文裁剪的会话消息，内容足够长以占用较多 token，编号 ${i}。`,
    })
  }
}

/** 动态取 agent 索引空间消息总数（含注入的 system 前缀；数量随配置 1~2 条不定，测试不硬编码） */
async function messageCountOf(sid: string): Promise<number> {
  const cs = await runCli(['context-status', sid, '--json'])
  expect(cs.code).toBe(0)
  return (JSON.parse(cs.stdout) as { messageCount: number }).messageCount
}

describe('flare trim --keep 精确裁剪', () => {
  it('手写 keep（开头块 + 第 1 条 + 最后 1 条）→ 精确裁剪 + store 持久生效', async () => {
    seedSession('sess-k1', 15)
    const N = await messageCountOf('sess-k1')
    const keep = `0,1,2,${N - 1}`
    const { code, stdout } = await runCli(['trim', 'sess-k1', '--keep', keep])
    expect(code).toBe(0)
    expect(stdout).toContain('已精确裁剪会话')
    const remaining = store.getMessages('sess-k1', 100000)
    // 编号 1（第一条 seed）与编号 15（最后一条）保留
    expect(remaining.some((m) => typeof m.content === 'string' && m.content.includes('编号 1。'))).toBe(true)
    expect(remaining.some((m) => typeof m.content === 'string' && m.content.includes('编号 15。'))).toBe(true)
    // 中间编号（7）被删
    expect(remaining.some((m) => typeof m.content === 'string' && m.content.includes('编号 7。'))).toBe(false)
  }, 20000)

  it('system 保底：--keep "3,14" 不含开头块 → 保留数 > keep 长度（applyTrim 补回 system 块）', async () => {
    seedSession('sess-k2', 15)
    const { code, stdout } = await runCli(['trim', 'sess-k2', '--keep', '3,14'])
    expect(code).toBe(0)
    // 保底补回 system 块：保留数 > 2（keep 长度）；seed 中 idx 3、14 两条留在 store
    const m = stdout.match(/保留:\s*(\d+)\s*条/)
    expect(m).toBeTruthy()
    expect(Number(m![1])).toBeGreaterThan(2)
    const remaining = store.getMessages('sess-k2', 100000)
    expect(remaining.length).toBe(2)
  }, 20000)

  it('端到端闭环：context-status --json 的 keepIndexes 直接喂 trim --keep → 删除数与建议一致', async () => {
    seedSession('sess-k3', 15)
    const cs = await runCli(['context-status', 'sess-k3', '--json', '--budget', '800'])
    expect(cs.code).toBe(0)
    const parsed = JSON.parse(cs.stdout)
    expect(parsed.suggestion).toBeDefined()
    const keepIndexes = parsed.suggestion.keepIndexes as number[]
    const droppedCount = parsed.suggestion.droppedCount as number
    const r = await runCli(['trim', 'sess-k3', '--keep', keepIndexes.join(',')])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('已精确裁剪会话')
    // seed 15 条：store 剩余 = 15 - 建议删除数（system 前缀不在 store，不影响）
    const remaining = store.getMessages('sess-k3', 100000)
    expect(remaining.length).toBe(15 - droppedCount)
  }, 20000)

  it('--keep 与 --budget 同时提供 → exit 1 + 互斥提示', async () => {
    seedSession('sess-k4', 5)
    const { code, stderr } = await runCli(['trim', 'sess-k4', '--keep', '0,1', '--budget', '800'])
    expect(code).toBe(1)
    expect(stderr).toContain('互斥')
  }, 20000)

  it('--keep 非法（abc / "1,x" / 空字符串）→ exit 1 + 索引列表提示', async () => {
    seedSession('sess-k5', 5)
    const ra = await runCli(['trim', 'sess-k5', '--keep', 'abc'])
    expect(ra.code).toBe(1)
    expect(ra.stderr).toContain('索引列表')
    const rb = await runCli(['trim', 'sess-k5', '--keep', '1,x'])
    expect(rb.code).toBe(1)
    expect(rb.stderr).toContain('索引列表')
    const rc = await runCli(['trim', 'sess-k5', '--keep', ''])
    expect(rc.code).toBe(1)
    expect(rc.stderr).toContain('索引列表')
  }, 20000)

  it('--keep 越界（99）→ exit 1 + 越界提示', async () => {
    seedSession('sess-k6', 5)
    const { code, stderr } = await runCli(['trim', 'sess-k6', '--keep', '99'])
    expect(code).toBe(1)
    expect(stderr).toContain('越界')
  }, 20000)

  it('--keep JSON 数组格式 → exit 0 正常裁剪（格式兼容）', async () => {
    seedSession('sess-k7', 15)
    const N = await messageCountOf('sess-k7')
    const keep = `[0,1,2,${N - 1}]`
    const { code, stdout } = await runCli(['trim', 'sess-k7', '--keep', keep])
    expect(code).toBe(0)
    expect(stdout).toContain('已精确裁剪会话')
    const remaining = store.getMessages('sess-k7', 100000)
    expect(remaining.length).toBeLessThan(15)
    expect(remaining.some((m) => typeof m.content === 'string' && m.content.includes('编号 15。'))).toBe(true)
  }, 20000)

  it('全部索引保留（--keep 0..N-1 全列）→ exit 0 + 无需裁剪 + 数据不变（幂等）', async () => {
    seedSession('sess-k8', 5)
    const N = await messageCountOf('sess-k8')
    const keep = Array.from({ length: N }, (_, i) => i).join(',')
    const { code, stdout } = await runCli(['trim', 'sess-k8', '--keep', keep])
    expect(code).toBe(0)
    expect(stdout).toContain('无需裁剪')
    expect(store.getMessages('sess-k8', 100000).length).toBe(5)
  }, 20000)

  it('空 id / 不存在会话 → exit 1（沿用现有校验）', async () => {
    const r1 = await runCli(['trim', '', '--keep', '0'])
    expect(r1.code).toBe(1)
    expect(r1.stderr).toContain('不能为空')
    const r2 = await runCli(['trim', 'sess-no-such', '--keep', '0'])
    expect(r2.code).toBe(1)
    expect(r2.stderr).toContain('不存在或无消息')
  }, 20000)
})
