/**
 * 模型可观测性测试（v0.6.0）
 *
 * - listOllamaModels：mock fetch 验证解析/失败/超时（无网络依赖）
 * - formatModelSize：字节 → 人类可读
 * - CLI `flare models`：spawn dist CLI e2e（Ollama 不可达也不崩，配置部分必输出）
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { listOllamaModels, formatModelSize, OLLAMA_DEFAULT_BASE } from '../src/core/models.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'dist', 'cli', 'index.js')

/** 构造 mock fetch：返回固定 JSON / 抛错 / 挂起直到超时 */
function mockFetch(behavior: 'ok' | 'error' | 'hang' | 'http500') {
  return (async (_url: string, opts?: any) => {
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
    if (behavior === 'error') {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
    }
    // hang：不 resolve，但响应 AbortSignal（模拟真实 fetch 被 abort）→ 触发超时路径
    return new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
  }) as unknown as typeof fetch
}

describe('listOllamaModels', () => {
  it('正常解析：返回模型名/大小/时间，请求拼接 /api/tags', async () => {
    let calledUrl = ''
    const fetcher = (async (url: string) => {
      calledUrl = url
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            { name: 'qwen2.5:7b', size: 4_700_000_000, modified_at: '2026-08-01T00:00:00Z' },
          ],
        }),
      }
    }) as unknown as typeof fetch
    const r = await listOllamaModels('http://localhost:11434', 1000, fetcher)
    expect(r.ok).toBe(true)
    expect(calledUrl).toBe('http://localhost:11434/api/tags')
    expect(r.models).toHaveLength(1)
    expect(r.models[0].name).toBe('qwen2.5:7b')
    expect(r.models[0].size).toBe(4_700_000_000)
    expect(r.models[0].modifiedAt).toBe('2026-08-01T00:00:00Z')
  })

  it('尾斜杠端点：拼接不产生双斜杠', async () => {
    let calledUrl = ''
    const fetcher = (async (url: string) => {
      calledUrl = url
      return { ok: true, status: 200, json: async () => ({ models: [] }) }
    }) as unknown as typeof fetch
    await listOllamaModels('http://localhost:11434/', 1000, fetcher)
    expect(calledUrl).toBe('http://localhost:11434/api/tags')
  })

  it('HTTP 500 → ok:false + 错误信息（不抛）', async () => {
    const r = await listOllamaModels(OLLAMA_DEFAULT_BASE, 1000, mockFetch('http500'))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('HTTP 500')
    expect(r.models).toEqual([])
  })

  it('Ollama 不可达（连接拒绝）→ ok:false + 错误信息（不抛）', async () => {
    const r = await listOllamaModels(OLLAMA_DEFAULT_BASE, 1000, mockFetch('error'))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不可达')
    expect(r.models).toEqual([])
  })

  it('Ollama 挂起 → 超时 ok:false（abort 生效，不悬挂）', async () => {
    const r = await listOllamaModels(OLLAMA_DEFAULT_BASE, 100, mockFetch('hang'))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('超时')
  })
})

describe('formatModelSize', () => {
  it('字节 → 人类可读（KB/MB/GB）', () => {
    expect(formatModelSize(0)).toBe('?')
    expect(formatModelSize(512)).toBe('512 B')
    expect(formatModelSize(2048)).toBe('2.0 KB')
    expect(formatModelSize(4_700_000_000)).toBe('4.4 GB')
  })
})

describe('CLI flare models', () => {
  it('输出配置的模型（Ollama 不可达也不崩，配置部分必在）', async () => {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, 'models'], {
        env: { ...process.env, FLARE_HOME: '/tmp/flare-models-test-nonexist' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout!.on('data', (d) => { stdout += d })
      child.stderr!.on('data', (d) => { stderr += d })
      const timer = setTimeout(() => { child.kill(); reject(new Error(`超时: ${stdout}\n${stderr}`)) }, 15000)
      child.on('close', () => { clearTimeout(timer); resolve(stdout) })
      child.on('error', reject)
    })
    // 配置的模型部分必须输出（纯本地，不依赖 Ollama）
    expect(out).toContain('配置的模型')
    expect(out).toContain('主模型')
    expect(out).toContain('视觉模型')
    // Ollama 部分：不可达显示提示，或已连接显示模型——两者都不算崩溃
    expect(out).toContain('本地 Ollama')
  }, 20000)
})
