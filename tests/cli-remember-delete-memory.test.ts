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
  dir = mkdtempSync(join(tmpdir(), 'flare-remdel-cli-'))
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

describe('flare remember', () => {
  it('默认 note 保存 → exit 0 + memories 命令端到端列出', async () => {
    const { code } = await runCli(['remember', '今日新增记忆：flare 自迭代任务'])
    expect(code).toBe(0)
    const { code: code2, stdout } = await runCli(['memories'])
    expect(code2).toBe(0)
    expect(stdout).toContain('今日新增记忆：flare 自迭代任务')
    expect(stdout).toContain('(note)')
  }, 20000)

  it('--kind preference 保存 → memories --kind preference 可见', async () => {
    const { code } = await runCli(['remember', '用户偏好：深色主题', '--kind', 'preference'])
    expect(code).toBe(0)
    const { code: code2, stdout } = await runCli(['memories', '--kind', 'preference'])
    expect(code2).toBe(0)
    expect(stdout).toContain('用户偏好：深色主题')
    expect(stdout).toContain('(preference)')
  }, 20000)

  it('空内容 → exit 1 + 提示', async () => {
    const { code, stderr } = await runCli(['remember', '   '])
    expect(code).toBe(1)
    expect(stderr).toContain('记忆内容不能为空')
  }, 20000)
})

describe('flare delete-memory', () => {
  it('按 id 删除单条 → exit 0 + memories 不再列出', async () => {
    store.saveMemory('待删除记忆XYZ', 'note')
    store.saveMemory('保留记忆ABC', 'note')
    const all = store.getAllMemories()
    const target = all.find((m) => m.content === '待删除记忆XYZ') as { id: number }
    expect(target).toBeTruthy()
    const { code } = await runCli(['delete-memory', String(target.id)])
    expect(code).toBe(0)
    const remaining = store.getAllMemories().map((m) => m.content)
    expect(remaining).not.toContain('待删除记忆XYZ')
    expect(remaining).toContain('保留记忆ABC')
  }, 20000)

  it('按 id 删除不存在 → exit 1', async () => {
    const { code, stderr } = await runCli(['delete-memory', '999999'])
    expect(code).toBe(1)
    expect(stderr).toContain('记忆 #999999 不存在')
  }, 20000)

  it('--content 批量删多条 → exit 0 + 删除条数正确', async () => {
    store.saveMemory('核心主题之一', 'note')
    store.saveMemory('核心主题之二', 'note')
    store.saveMemory('无关内容', 'note')
    const { code, stdout } = await runCli(['delete-memory', '--content', '核心主题'])
    expect(code).toBe(0)
    expect(stdout).toContain('已删除 2 条记忆')
    const remaining = store.getAllMemories().map((m) => m.content)
    expect(remaining).not.toContain('核心主题之一')
    expect(remaining).not.toContain('核心主题之二')
    expect(remaining).toContain('无关内容')
  }, 20000)

  it('--content 无匹配 → exit 0（幂等）', async () => {
    const { code, stdout } = await runCli(['delete-memory', '--content', '不存在的关键词'])
    expect(code).toBe(0)
    expect(stdout).toContain('已删除 0 条记忆')
  }, 20000)

  it('无参数 → exit 1 + 用法提示', async () => {
    const { code, stderr } = await runCli(['delete-memory'])
    expect(code).toBe(1)
    expect(stderr).toContain('用法: flare delete-memory')
  }, 20000)

  it('id 非法（abc）→ exit 1', async () => {
    const { code, stderr } = await runCli(['delete-memory', 'abc'])
    expect(code).toBe(1)
    expect(stderr).toContain('记忆ID必须是正整数')
  }, 20000)

  it('id 非法（0）→ exit 1', async () => {
    const { code, stderr } = await runCli(['delete-memory', '0'])
    expect(code).toBe(1)
    expect(stderr).toContain('记忆ID必须是正整数')
  }, 20000)

  it('id 非法（负数被 commander 当作未知选项）→ exit 1', async () => {
    const { code, stderr } = await runCli(['delete-memory', '-3'])
    expect(code).toBe(1)
    expect(stderr.length).toBeGreaterThan(0)
  }, 20000)

  it('删除后 memories 搜索不再命中（FTS 联动）', async () => {
    store.saveMemory('神秘关键词AlphaBeta', 'note')
    const all = store.getAllMemories()
    const target = all.find((m) => m.content === '神秘关键词AlphaBeta') as { id: number }
    const { code } = await runCli(['delete-memory', String(target.id)])
    expect(code).toBe(0)
    const { code: code2, stdout } = await runCli(['memories', 'AlphaBeta'])
    expect(code2).toBe(0)
    expect(stdout).not.toContain('神秘关键词AlphaBeta')
  }, 20000)

  it('id 与 --content 同时提供 → 以 id 为准', async () => {
    store.saveMemory('冲突记忆C', 'note')
    const all = store.getAllMemories()
    const target = all.find((m) => m.content === '冲突记忆C') as { id: number }
    const { code, stdout } = await runCli(['delete-memory', String(target.id), '--content', '冲突记忆'])
    expect(code).toBe(0)
    expect(stdout).toContain('已删除记忆 #' + target.id)
    expect(store.getAllMemories().map((m) => m.content)).not.toContain('冲突记忆C')
  }, 20000)
})
