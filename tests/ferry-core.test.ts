/**
 * 内嵌 ferry 引擎测试（v0.6.153）
 *
 * 核心断言：flare 自带的引擎与 Python 参考实现（ferry CLI）行为完全一致。
 * 用例表 tests/fixtures/ferry-cases.json 由 ferry 项目用同一批数据生成，
 * 覆盖 127 条命令 × 三个目标平台，共 1262 条。
 * 任何一条不一致都说明移植有 bug —— 不要放宽断言，去修引擎。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { FERRY_DATA_SHA, getKB, translateCommand } from '../src/tools/ferry-core/engine.js'

const here = dirname(fileURLToPath(import.meta.url))

interface Case {
  input: string
  target: 'linux' | 'macos' | 'windows'
  shell: string | null
  status: string
  command: string | null
  caveats: string[]
}

const cases: Case[] = JSON.parse(readFileSync(join(here, 'fixtures/ferry-cases.json'), 'utf-8'))

describe('内嵌 ferry 引擎', () => {
  it('映射数据已编译进包内（不依赖外部安装）', () => {
    expect(FERRY_DATA_SHA).toMatch(/^[0-9a-f]{16}$/)
    const kb = getKB()
    const stats = kb.stats()
    expect(stats.entries).toBe(127)
    expect(stats.patterns).toBe(21)
    expect(stats.syntax).toBe(24)
    expect(stats.pitfalls).toBe(22)
    expect(stats.drills).toBe(33)
    expect(kb.errors).toEqual([])
  })

  it(`与 Python 参考实现逐条一致（${cases.length} 条用例）`, () => {
    const bad: string[] = []
    for (const c of cases) {
      const got = translateCommand({ command: c.input, target: c.target, shell: c.shell || undefined })
      if (got.status !== c.status || (got.command || null) !== c.command
        || JSON.stringify(got.caveats) !== JSON.stringify(c.caveats)) {
        bad.push(`[${c.target}${c.shell ? '/' + c.shell : ''}] ${c.input}\n  期望 ${c.status} ${JSON.stringify(c.command)} ${JSON.stringify(c.caveats)}\n  实际 ${got.status} ${JSON.stringify(got.command)} ${JSON.stringify(got.caveats)}`)
      }
    }
    expect(bad.slice(0, 5).join('\n')).toBe('')
    expect(bad.length).toBe(0)
  })

  it('三态语义：等价 / 近似 / 无等价', () => {
    expect(translateCommand({ command: 'ps aux | grep nginx', target: 'windows' }).status).toBe('equivalent')
    // ls -la 是近似：列含义与 ls -l 不同，必须让模型知道
    const la = translateCommand({ command: 'ls -la', target: 'windows' })
    expect(la.status).toBe('approximate')
    expect(la.caveats.join()).toContain('列含义')
    const sed = translateCommand({ command: "sed -i 's/a/b/' f.txt", target: 'macos' })
    expect(sed.status).toBe('approximate')
    expect(sed.caveats.join()).toContain('BSD sed')
    const chmod = translateCommand({ command: 'chmod +x a.sh', target: 'windows' })
    expect(chmod.status).toBe('unsupported')
  })

  it('目标平台无等价时不返回命令（避免模型照着执行）', () => {
    const r = translateCommand({ command: 'chmod +x a.sh', target: 'windows' })
    expect(r.command).toBeNull()
  })

  it('源平台可显式指定，不被当前系统带偏', () => {
    const r = translateCommand({ command: "grep -P '\\d{3}' a.txt", target: 'macos', source: 'linux' })
    expect(r.status).toBe('unsupported')
    expect(r.source).toBe('linux')
  })
})
