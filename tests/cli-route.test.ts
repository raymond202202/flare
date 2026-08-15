/**
 * flare route CLI 测试（v0.6.135）
 *
 * 任务复杂度路由单次命令（混合模式本地小模型路由查询面）：
 * - 纯函数决策（routeTaskModel），不触发生成、不创建会话
 * - 文本模式：简单/复杂标签 + 模型 + provider + 原因 + 本地/主模型
 * - --json：{ tier, model, provider, reason, localModel, mainModel }
 * - 缺参数 → 用法提示 + exit 1
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'dist', 'cli', 'index.js')
const children: ChildProcess[] = []
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-route-cli-'))
})
afterEach(() => {
  for (const c of children.splice(0)) c.kill()
  rmSync(dir, { recursive: true, force: true })
})
function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}, input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, FLARE_HOME: dir, ...envOverrides },
    })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    if (input !== undefined) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })
}

const SIMPLE_TEXT = '把这句话翻译成英文：你好世界'
const COMPLEX_TEXT = '分析一下这段代码的性能瓶颈'

describe('flare route', () => {
  it('简单任务：配置 LOCAL_MODEL → 文本模式输出本地模型 + ollama provider + 特征标签', async () => {
    const { code, stdout } = await runCli(['route', SIMPLE_TEXT], { LOCAL_MODEL: 'qwen2.5:7b' })
    expect(code).toBe(0)
    expect(stdout).toContain('简单任务')
    expect(stdout).toContain('qwen2.5:7b')
    expect(stdout).toContain('ollama')
    expect(stdout).toContain('本地模型: qwen2.5:7b')
    // v0.6.143：分类命中特征能力标签
    expect(stdout).toContain('特征:')
    expect(stdout).toContain('简单特征词')
  }, 20000)

  it('复杂任务 → 文本模式输出主模型 + deepseek provider + 特征标签', async () => {
    const { code, stdout } = await runCli(['route', COMPLEX_TEXT], { LOCAL_MODEL: 'qwen2.5:7b' })
    expect(code).toBe(0)
    expect(stdout).toContain('复杂任务')
    expect(stdout).toContain('deepseek-chat')
    expect(stdout).toContain('deepseek')
    // v0.6.143：分类命中特征能力标签
    expect(stdout).toContain('特征:')
    expect(stdout).toContain('复杂特征词')
  }, 20000)

  it('--json：结构化输出 { tier, feature, model, provider, reason, localModel, mainModel }，纯 JSON 无 ANSI', async () => {
    const { code, stdout } = await runCli(['route', SIMPLE_TEXT, '--json'], { LOCAL_MODEL: 'qwen2.5:7b' })
    expect(code).toBe(0)
    expect(stdout).not.toMatch(/\u001b\[/)
    const parsed = JSON.parse(stdout)
    expect(parsed.tier).toBe('simple')
    expect(parsed.model).toBe('qwen2.5:7b')
    expect(parsed.provider).toBe('ollama')
    expect(typeof parsed.reason).toBe('string')
    expect(parsed.localModel).toBe('qwen2.5:7b')
    expect(parsed.mainModel).toBe('deepseek-chat')
    // v0.6.143：分类命中特征能力标签
    expect(parsed.feature).toContain('简单特征词')
  }, 20000)

  it('--json：复杂任务输出主模型（保质量）', async () => {
    const { code, stdout } = await runCli(['route', COMPLEX_TEXT, '--json'], { LOCAL_MODEL: 'qwen2.5:7b' })
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.tier).toBe('complex')
    expect(parsed.model).toBe('deepseek-chat')
    expect(parsed.provider).toBe('deepseek')
  }, 20000)

  it('未配置 LOCAL_MODEL：简单任务回退主模型，--json localModel null', async () => {
    const { code, stdout } = await runCli(['route', SIMPLE_TEXT, '--json'], { LOCAL_MODEL: '' })
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.tier).toBe('simple')
    expect(parsed.model).toBe('deepseek-chat')
    expect(parsed.localModel).toBeNull()
    // 文本模式同口径：注明未配置
    const t = await runCli(['route', SIMPLE_TEXT], { LOCAL_MODEL: '' })
    expect(t.stdout).toContain('未配置')
  }, 20000)

  it('缺参数：用法提示 + exit 1（不崩溃）', async () => {
    const { code, stdout, stderr } = await runCli(['route'], {}, '')
    expect(code).toBe(1)
    expect(stderr).toContain('用法')
    expect(stdout).toBe('')
  }, 20000)

  it('空白参数：用法提示 + exit 1', async () => {
    const { code, stderr } = await runCli(['route', '   '], {}, '')
    expect(code).toBe(1)
    expect(stderr).toContain('用法')
  }, 20000)

  it('-j 短选项等价 --json', async () => {
    const { code, stdout } = await runCli(['route', COMPLEX_TEXT, '-j'], { LOCAL_MODEL: 'qwen2.5:7b' })
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.tier).toBe('complex')
  }, 20000)

  it('批量多参数（v0.6.140）：文本模式逐条输出 + 汇总行', async () => {
    const { code, stdout } = await runCli(['route', SIMPLE_TEXT, COMPLEX_TEXT], { LOCAL_MODEL: 'qwen2.5:7b' })
    expect(code).toBe(0)
    // 两条任务都出现（含序号前缀）
    expect(stdout).toContain('[1/2]')
    expect(stdout).toContain('[2/2]')
    expect(stdout).toContain('简单任务')
    expect(stdout).toContain('复杂任务')
    // 汇总行：共 2 个任务 · 简单 1 · 复杂 1
    expect(stdout).toContain('汇总: 共 2 个任务 · 简单 1 · 复杂 1')
  }, 20000)

  it('批量多参数（v0.6.140）：--json 输出 { results: [...] } 数组 + 公共模型字段（v0.6.143 起含 feature）', async () => {
    const { code, stdout } = await runCli(['route', SIMPLE_TEXT, COMPLEX_TEXT, '--json'], { LOCAL_MODEL: 'qwen2.5:7b' })
    expect(code).toBe(0)
    expect(stdout).not.toMatch(/\u001b\[/)
    const parsed = JSON.parse(stdout)
    expect(Array.isArray(parsed.results)).toBe(true)
    expect(parsed.results).toHaveLength(2)
    expect(parsed.results[0]).toMatchObject({ tier: 'simple', model: 'qwen2.5:7b', provider: 'ollama' })
    expect(parsed.results[1]).toMatchObject({ tier: 'complex', model: 'deepseek-chat', provider: 'deepseek' })
    // 每个结果带 task 原文 + 特征标签
    expect(parsed.results[0].task).toBe(SIMPLE_TEXT)
    expect(parsed.results[1].task).toBe(COMPLEX_TEXT)
    expect(parsed.results[0].feature).toContain('简单特征词')
    expect(parsed.results[1].feature).toContain('复杂特征词')
    expect(parsed.localModel).toBe('qwen2.5:7b')
    expect(parsed.mainModel).toBe('deepseek-chat')
  }, 20000)

  it('stdin 管道读取（v0.6.140）：无位置参数 + stdin 文本 → 按整体任务决策（echo "任务" | flare route）', async () => {
    const { code, stdout } = await runCli(['route'], { LOCAL_MODEL: 'qwen2.5:7b' }, SIMPLE_TEXT)
    expect(code).toBe(0)
    expect(stdout).toContain('简单任务')
    expect(stdout).toContain('qwen2.5:7b')
    // 单任务 stdin 走原单任务结构（--json 保持对象而非 results 数组）
    const j = await runCli(['route', '--json'], { LOCAL_MODEL: 'qwen2.5:7b' }, COMPLEX_TEXT)
    expect(j.code).toBe(0)
    const parsed = JSON.parse(j.stdout)
    expect(parsed.results).toBeUndefined()
    expect(parsed.tier).toBe('complex')
    expect(parsed.model).toBe('deepseek-chat')
  }, 20000)

  it('stdin 空内容（v0.6.140）：无位置参数 + stdin 空白 → 用法提示 + exit 1（不崩溃）', async () => {
    const { code, stderr } = await runCli(['route'], {}, '   \n  ')
    expect(code).toBe(1)
    expect(stderr).toContain('用法')
  }, 20000)

  it('批量含空白参数（v0.6.140）：空白位置参数被过滤，剩余任务正常决策', async () => {
    const { code, stdout } = await runCli(['route', '   ', SIMPLE_TEXT], { LOCAL_MODEL: 'qwen2.5:7b' })
    expect(code).toBe(0)
    // 空白过滤后剩 1 个任务 → 走单任务输出（无序号/汇总行）
    expect(stdout).not.toContain('[1/')
    expect(stdout).toContain('简单任务')
    expect(stdout).toContain('qwen2.5:7b')
  }, 20000)
})
