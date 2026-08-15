/**
 * flare models CLI 测试（v0.6.112 P142）
 *
 * 覆盖：
 * - 文本模式回归：配置的模型/主模型/本地 Ollama 区块仍在
 * - --json：输出与 server models 回包同构 { configured, ollama }（ModelEndpointInfo 同款字段），
 *   纯 JSON 无 ANSI 彩色码；vision 未配置 → null（与 server 语义一致）
 * - -j 短选项等价；--json 的 configured.main 反映运行时 /model 切换（settings 表 main_model 优先），
 *   与文本模式展示一致
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
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-models-cli-'))
})
afterEach(() => {
  for (const c of children.splice(0)) c.kill()
  rmSync(dir, { recursive: true, force: true })
})
function runCli(args: string[], env?: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, FLARE_HOME: dir, ...env },
    })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}
const PROVIDERS = ['ollama', 'deepseek', 'openai', 'other']
describe('flare models', () => {
  it('文本模式：列出配置的模型与本地 Ollama（回归，区块仍在）', async () => {
    const { code, stdout } = await runCli(['models'])
    expect(code).toBe(0)
    expect(stdout).toContain('配置的模型')
    expect(stdout).toContain('主模型:')
    expect(stdout).toContain('本地 Ollama')
  }, 20000)
  it('--json：输出与 server models 回包同构 { configured, ollama }，纯 JSON 无 ANSI 混入', async () => {
    const { code, stdout, stderr } = await runCli(['models', '--json'], { LOCAL_MODEL: '' })
    expect(code).toBe(0)
    // 纯 JSON：无 ANSI 彩色码、无其他日志混入
    expect(stdout).not.toMatch(/\u001b\[/)
    const parsed = JSON.parse(stdout)
    // configured.main：ModelEndpointInfo 同款字段
    expect(typeof parsed.configured.main.model).toBe('string')
    expect(parsed.configured.main.model.length).toBeGreaterThan(0)
    expect(typeof parsed.configured.main.baseURL).toBe('string')
    expect(typeof parsed.configured.main.hasApiKey).toBe('boolean')
    expect(PROVIDERS).toContain(parsed.configured.main.provider)
    // configured.vision：未配置 → null 或对象（与 server 语义一致）
    if (parsed.configured.vision !== null) {
      expect(typeof parsed.configured.vision.model).toBe('string')
      expect(typeof parsed.configured.vision.hasApiKey).toBe('boolean')
      expect(PROVIDERS).toContain(parsed.configured.vision.provider)
    }
    // configured.local：本地路由模型未配置 → null（v0.6.134 混合模式）
    expect(parsed.configured.local).toBeNull()
    // ollama：listOllamaModels 原始结果（可达 ok:true / 不可达 ok:false 均合法）
    expect(typeof parsed.ollama.ok).toBe('boolean')
    expect(Array.isArray(parsed.ollama.models)).toBe(true)
    expect(stderr).toBe('')
  }, 20000)

  it('--json：配置 LOCAL_MODEL 后 configured.local 返回本地路由模型端点信息（ollama provider）', async () => {
    const { code, stdout } = await runCli(['models', '--json'], { LOCAL_MODEL: 'qwen2.5:7b' })
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.configured.local).not.toBeNull()
    expect(parsed.configured.local.model).toBe('qwen2.5:7b')
    expect(parsed.configured.local.provider).toBe('ollama')
    expect(parsed.configured.local.baseURL).toContain('localhost:11434')
    expect(typeof parsed.configured.local.hasApiKey).toBe('boolean')
    // 文本模式同口径展示本地路由模型
    const t = await runCli(['models'], { LOCAL_MODEL: 'qwen2.5:7b' })
    expect(t.stdout).toContain('本地路由:')
    expect(t.stdout).toContain('qwen2.5:7b')
  }, 20000)
  it('-j 短选项等价；configured.main 反映运行时 /model 切换（settings 优先），与文本模式一致', async () => {
    // 运行时切换主模型（settings 表）→ 文本与 --json 应展示同一模型
    const store = new MemoryStore(join(dir, 'flare.db'))
    store.setSetting('main_model', 'qwen2.5:7b')
    store.close()
    const j = await runCli(['models', '-j'])
    const t = await runCli(['models'])
    expect(j.code).toBe(0)
    expect(t.code).toBe(0)
    const parsed = JSON.parse(j.stdout)
    // --json 的 configured.main 反映 settings 的 main_model（qwen2.5:7b → ollama provider）
    expect(parsed.configured.main.model).toBe('qwen2.5:7b')
    expect(parsed.configured.main.provider).toBe('ollama')
    // 文本模式展示同一主模型
    expect(t.stdout).toContain('qwen2.5:7b')
  }, 20000)
})
