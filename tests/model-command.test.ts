/**
 * CLI /model 命令测试（v0.5.2）
 *
 * handleSlashCommand 是纯逻辑（store + output 注入），不依赖 TTY：
 * 验证主模型切换持久化（settings main_model）、onModelSwitch 回调、default 恢复。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/memory/store.js'
import { handleSlashCommand } from '../src/cli/index.js'

let store: MemoryStore
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flare-model-test-'))
  store = new MemoryStore(join(dir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('/model 命令', () => {
  it('/model（无参数）→ 显示当前主模型', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/model', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('当前主模型')
    // 裸 /model 不得把 '/model' 当模型名写入
    expect(store.getSetting('main_model')).toBeNull()
  })

  it('/model qwen2.5:7b → 持久化 main_model + 回调通知 + 标注本地 Ollama', async () => {
    const lines: string[] = []
    let switched: string | undefined
    const r = await handleSlashCommand('/model qwen2.5:7b', store, (s) => lines.push(s), (m) => { switched = m })
    expect(r).toBe('continue')
    expect(store.getSetting('main_model')).toBe('qwen2.5:7b')
    expect(switched).toBe('qwen2.5:7b')
    expect(lines.join('\n')).toContain('已切换: qwen2.5:7b')
    expect(lines.join('\n')).toContain('本地 Ollama')
  })

  it('/model deepseek-chat → 远端模型不标本地', async () => {
    const lines: string[] = []
    await handleSlashCommand('/model deepseek-chat', store, (s) => lines.push(s))
    expect(store.getSetting('main_model')).toBe('deepseek-chat')
    expect(lines.join('\n')).toContain('已切换: deepseek-chat')
    expect(lines.join('\n')).not.toContain('本地 Ollama')
  })

  it('/model default → 清空 main_model + 回调空串', async () => {
    store.setSetting('main_model', 'qwen2.5:7b')
    const lines: string[] = []
    let switched = '未调用'
    await handleSlashCommand('/model default', store, (s) => lines.push(s), (m) => { switched = m })
    expect(store.getSetting('main_model')).toBeNull()
    expect(switched).toBe('')
    expect(lines.join('\n')).toContain('恢复默认')
  })

  it('/model reset 等价 default', async () => {
    store.setSetting('main_model', 'llama3.1:8b')
    const lines: string[] = []
    await handleSlashCommand('/model reset', store, (s) => lines.push(s))
    expect(store.getSetting('main_model')).toBeNull()
    expect(lines.join('\n')).toContain('恢复默认')
  })

  it('/model list → 列出本地 Ollama 模型（可达列模型/不可达友好提示；不写 main_model，v0.6.9）', async () => {
    const lines: string[] = []
    const r = await handleSlashCommand('/model list', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    const out = lines.join('\n')
    // 两种情况均合法：Ollama 可达 → 模型列表；不可达 → 友好提示（都含当前主模型行 + Ollama 字样）
    expect(out).toContain('当前主模型')
    expect(out).toContain('Ollama')
    expect(store.getSetting('main_model')).toBeNull()
  })

  it('/model list 不会把 list 当模型名写入 main_model', async () => {
    await handleSlashCommand('/model list', store, () => {})
    expect(store.getSetting('main_model')).toBeNull()
  })

  it('不触发 /model 的命令不碰 main_model', async () => {
    const lines: string[] = []
    await handleSlashCommand('/help', store, (s) => lines.push(s))
    expect(store.getSetting('main_model')).toBeNull()
  })
})

describe('/forget 命令（记忆删除，v0.5.4）', () => {
  it('/forget <关键词> → 删除匹配记忆 + 提示条数', async () => {
    store.saveMemory('用户喜欢浅色主题', 'note')
    store.saveMemory('关于浅色主题的配色讨论', 'note')
    store.saveMemory('香蕉的营养', 'note')

    const lines: string[] = []
    const r = await handleSlashCommand('/forget 浅色主题', store, (s) => lines.push(s))
    expect(r).toBe('continue')
    expect(lines.join('\n')).toContain('已删除 2 条记忆')
    expect(store.getAllMemories()).toHaveLength(1)
    expect(store.getAllMemories()[0].content).toBe('香蕉的营养')
  })

  it('/forget 无匹配 → 友好提示，不误删', async () => {
    store.saveMemory('唯一记忆', 'note')
    const lines: string[] = []
    await handleSlashCommand('/forget 不存在的词', store, (s) => lines.push(s))
    expect(lines.join('\n')).toContain('未找到')
    expect(store.getAllMemories()).toHaveLength(1)
  })

  it('/forget 无参数 → 用法提示，不删任何记忆', async () => {
    store.saveMemory('保留记忆', 'note')
    const lines: string[] = []
    await handleSlashCommand('/forget', store, (s) => lines.push(s))
    expect(lines.join('\n')).toContain('用法')
    expect(store.getAllMemories()).toHaveLength(1)
  })

  it('/help 包含 /forget 说明', async () => {
    const lines: string[] = []
    await handleSlashCommand('/help', store, (s) => lines.push(s))
    expect(lines.join('\n')).toContain('/forget')
  })
})
