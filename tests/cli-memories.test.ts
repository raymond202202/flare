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
  dir = mkdtempSync(join(tmpdir(), 'flare-mem-cli-'))
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
describe('flare memories', () => {
  it('列出全部记忆（含 id/类型/内容）', async () => {
    store.saveMemory('用户偏好浅色主题', 'preference')
    store.saveMemory('今日待办：完成 flare 迭代', 'note')
    const { code, stdout } = await runCli(['memories'])
    expect(code).toBe(0)
    expect(stdout).toContain('记忆（2 条）')
    expect(stdout).toContain('用户偏好浅色主题')
    expect(stdout).toContain('今日待办：完成 flare 迭代')
    expect(stdout).toContain('(preference)')
    expect(stdout).toContain('(note)')
  }, 20000)
  it('关键词搜索命中（2 字短查询走 LIKE 回退）', async () => {
    store.saveMemory('用户偏好浅色主题', 'preference')
    store.saveMemory('今日待办：完成 flare 迭代', 'note')
    const { code, stdout } = await runCli(['memories', '浅色'])
    expect(code).toBe(0)
    expect(stdout).toContain('关键词「浅色」')
    expect(stdout).toContain('用户偏好浅色主题')
    expect(stdout).not.toContain('今日待办')
  }, 20000)
  it('--kind 按类型过滤', async () => {
    store.saveMemory('用户偏好浅色主题', 'preference')
    store.saveMemory('今日待办：完成 flare 迭代', 'note')
    const { code, stdout } = await runCli(['memories', '--kind', 'preference'])
    expect(code).toBe(0)
    expect(stdout).toContain('类型「preference」')
    expect(stdout).toContain('用户偏好浅色主题')
    expect(stdout).not.toContain('今日待办')
  }, 20000)
  it('--limit 1 只显示 1 条', async () => {
    store.saveMemory('记忆甲', 'note')
    store.saveMemory('记忆乙', 'note')
    const { code, stdout } = await runCli(['memories', '--limit', '1'])
    expect(code).toBe(0)
    expect(stdout).toContain('记忆（1 条')
  }, 20000)
  it('非法 --limit 退出码 1', async () => {
    for (const bad of ['0', '101', 'abc']) {
      const { code, stderr } = await runCli(['memories', '--limit', bad])
      expect(code).toBe(1)
      expect(stderr).toContain('--limit')
    }
  }, 20000)
  it('空库「暂无记忆」退出码 0', async () => {
    const { code, stdout } = await runCli(['memories'])
    expect(code).toBe(0)
    expect(stdout).toContain('暂无记忆')
  }, 20000)

  it('--json 输出合法 JSON（含 id/content/type/created_at，content 不截断）', async () => {
    store.saveMemory('这是一个超长内容用于验证 JSON 输出不截断不折叠：' + 'X'.repeat(300), 'preference')
    store.saveMemory('今日待办：完成 flare 迭代', 'note')
    const { code, stdout } = await runCli(['memories', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.memories).toHaveLength(2)
    for (const m of parsed.memories) {
      expect(m).toHaveProperty('id')
      expect(m).toHaveProperty('content')
      expect(m).toHaveProperty('type')
      expect(m).toHaveProperty('created_at')
    }
    // 验证长内容不被截断和折叠
    expect(parsed.memories[0].content).toContain('X'.repeat(300))
    expect(parsed.memories[0].content).toBe('这是一个超长内容用于验证 JSON 输出不截断不折叠：' + 'X'.repeat(300))
  }, 20000)
  it('--json 与 --kind 组合只输出该类型', async () => {
    store.saveMemory('用户偏好浅色主题', 'preference')
    store.saveMemory('今日待办：完成 flare 迭代', 'note')
    const { code, stdout } = await runCli(['memories', '--json', '--kind', 'preference'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.memories).toHaveLength(1)
    expect(parsed.memories[0].type).toBe('preference')
    expect(parsed.memories[0].content).toBe('用户偏好浅色主题')
  }, 20000)
  it('--json 与关键词搜索组合输出命中项', async () => {
    store.saveMemory('用户偏好浅色主题', 'preference')
    store.saveMemory('今日待办：完成 flare 迭代', 'note')
    const { code, stdout } = await runCli(['memories', '--json', '浅色'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.memories).toHaveLength(1)
    expect(parsed.memories[0].content).toBe('用户偏好浅色主题')
  }, 20000)
  it('空库 --json 输出合法 JSON 空数组且 exit 0', async () => {
    const { code, stdout } = await runCli(['memories', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.memories).toEqual([])
  }, 20000)
  it('文本模式回归（无 --json 输出仍含记忆且非 JSON）', async () => {
    store.saveMemory('记忆甲', 'note')
    const { code, stdout } = await runCli(['memories'])
    expect(code).toBe(0)
    expect(stdout).toContain('🧠 记忆')
    expect(() => JSON.parse(stdout)).toThrow()
  }, 20000)
})
