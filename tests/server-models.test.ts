/**
 * server 协议 models 接口测试（v0.6.9）
 *
 * - detectProvider：模型名 → provider 类型推断（纯函数）
 * - collectModelInfo：mock fetch 注入验证 configured 解析 + ollama 可达/不可达/HTTP 错误（无网络依赖）
 * - e2e（子进程）：真实 server 响应 models 请求，结构完整、Ollama 不可达也不崩
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { collectModelInfo, detectProvider } from '../src/server.js'
import { config } from '../src/core/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'dist', 'cli', 'index.js')

/** 构造 mock fetch（listOllamaModels 用）：正常 / HTTP 500 / 连接拒绝 */
function mockFetch(behavior: 'ok' | 'error' | 'http500') {
  return (async (_url: string) => {
    if (behavior === 'ok') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            { name: 'qwen2.5:7b', size: 4_700_000_000, modified_at: '2026-08-01T00:00:00Z' },
            { name: 'qwen2.5vl:3b', size: 2_100_000_000, modified_at: '2026-08-02T00:00:00Z' },
          ],
        }),
      }
    }
    if (behavior === 'http500') {
      return { ok: false, status: 500, json: async () => ({}) }
    }
    throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
  }) as unknown as typeof fetch
}

describe('detectProvider（模型名 → provider 类型推断）', () => {
  it('Ollama 本地模型（含冒号命名）→ ollama', () => {
    expect(detectProvider('qwen2.5:7b')).toBe('ollama')
    expect(detectProvider('qwen2.5vl:7b-64k')).toBe('ollama')
  })
  it('deepseek 系列 → deepseek', () => {
    expect(detectProvider('deepseek-chat')).toBe('deepseek')
    expect(detectProvider('deepseek-reasoner')).toBe('deepseek')
  })
  it('openai 系列（gpt/o1/o3/chatgpt）→ openai', () => {
    expect(detectProvider('gpt-4o')).toBe('openai')
    expect(detectProvider('o3-mini')).toBe('openai')
  })
  it('其他（claude 等）→ other', () => {
    expect(detectProvider('claude-sonnet-4')).toBe('other')
  })
})

// config 是模块级单例（从 env 加载）：测试修改后恢复原值，避免污染其他测试
const savedMain = config.get('DEFAULT_MODEL') || 'deepseek-chat'
const savedVision = config.get('VISION_MODEL') || ''
afterEach(() => {
  config.set('DEFAULT_MODEL', savedMain)
  config.set('VISION_MODEL', savedVision)
})

describe('collectModelInfo（模型信息收集，mock fetch）', () => {
  it('Ollama 可达：configured 主模型解析 + 模型列表解析（名称/大小/时间）', async () => {
    config.set('VISION_MODEL', '') // 显式清除：断言"未配置 → null"，不受本机 ~/.flare/.env 影响
    const r = await collectModelInfo(mockFetch('ok'))
    expect(r.configured.main.model).toBe(savedMain)
    expect(r.configured.main.baseURL).toBeTruthy()
    expect(r.configured.main.provider).toBe(detectProvider(savedMain))
    expect(typeof r.configured.main.hasApiKey).toBe('boolean')
    // 视觉模型未配置 → null
    expect(r.configured.vision).toBeNull()
    expect(r.ollama.ok).toBe(true)
    expect(r.ollama.models).toHaveLength(2)
    expect(r.ollama.models[0]).toEqual({
      name: 'qwen2.5:7b',
      size: 4_700_000_000,
      modifiedAt: '2026-08-01T00:00:00Z',
    })
  })

  it('视觉模型已配置：vision 返回端点信息（ollama provider + 本地端点 + apiKey 占位）', async () => {
    config.set('VISION_MODEL', 'qwen2.5vl:7b')
    const r = await collectModelInfo(mockFetch('ok'))
    expect(r.configured.vision).not.toBeNull()
    expect(r.configured.vision!.model).toBe('qwen2.5vl:7b')
    expect(r.configured.vision!.provider).toBe('ollama')
    expect(r.configured.vision!.baseURL).toContain('localhost:11434')
    expect(r.configured.vision!.hasApiKey).toBe(true)
    // 主模型不受影响
    expect(r.configured.main.model).toBe(savedMain)
  })

  it('Ollama 不可达：ollama 返回 ok:false + error（不抛错），configured 仍正常', async () => {
    const r = await collectModelInfo(mockFetch('error'))
    expect(r.ollama.ok).toBe(false)
    expect(r.ollama.models).toEqual([])
    expect(r.ollama.error).toContain('Ollama 不可达')
    expect(r.configured.main.model).toBe(savedMain)
  })

  it('Ollama HTTP 500：ollama 返回 ok:false + HTTP 状态错误', async () => {
    const r = await collectModelInfo(mockFetch('http500'))
    expect(r.ollama.ok).toBe(false)
    expect(r.ollama.error).toContain('HTTP 500')
  })

  it('主模型 Claude 系列：configured.main.error 明确报错（不抛、不崩），ollama 仍查询', async () => {
    config.set('DEFAULT_MODEL', 'claude-sonnet-4')
    const r = await collectModelInfo(mockFetch('ok'))
    expect(r.configured.main.model).toBe('claude-sonnet-4')
    expect(r.configured.main.error).toContain('Claude')
    expect(r.configured.main.provider).toBe('other')
    expect(r.ollama.ok).toBe(true)
  })
})

// ===== e2e：真实 server 子进程 =====
let child: ChildProcess
let rl: Interface
let tempDir: string

function request(msg: any): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const msgs: any[] = []
    const timer = setTimeout(() => { cleanup(); reject(new Error('超时（models 请求）')) }, 15000)
    const handler = (line: string) => {
      try {
        const parsed = JSON.parse(line)
        if (parsed.type === 'models') {
          msgs.push(parsed)
          cleanup()
          resolve(msgs)
        }
      } catch { /* 非 JSON 行忽略 */ }
    }
    const cleanup = () => { clearTimeout(timer); rl.removeListener('line', handler) }
    rl.on('line', handler)
    child.stdin!.write(JSON.stringify(msg) + '\n')
  })
}

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'flare-server-models-test-'))
  child = spawn(process.execPath, [CLI, 'server', '--storage', path.join(tempDir, 'test.db')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  rl = createInterface({ input: child.stdout! })
})

afterAll(() => {
  child.kill()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('server 协议 models e2e', () => {
  it('models → configured（主/视觉）+ ollama 结构完整；Ollama 不可达也返回 ok:false 不崩服务', async () => {
    const msgs = await request({ type: 'models' })
    const m = msgs[0]
    expect(m.type).toBe('models')
    // configured：主模型必有 model/baseURL/provider/hasApiKey；视觉模型 null 或完整信息
    expect(m.configured.main.model).toBeTruthy()
    expect(m.configured.main.baseURL).toBeTruthy()
    expect(['ollama', 'deepseek', 'openai', 'other']).toContain(m.configured.main.provider)
    expect(typeof m.configured.main.hasApiKey).toBe('boolean')
    expect(m.configured.vision === null || Boolean(m.configured.vision.model && m.configured.vision.baseURL)).toBe(true)
    // ollama：本地有无 Ollama 均合法（ok + models 数组；不可达带 error）
    expect(typeof m.ollama.ok).toBe('boolean')
    expect(Array.isArray(m.ollama.models)).toBe(true)
    expect(m.ollama.error === undefined || typeof m.ollama.error === 'string').toBe(true)
  })
})
