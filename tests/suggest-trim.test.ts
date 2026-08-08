/**
 * suggestTrim 上下文裁剪建议测试（v0.5.9，纯函数）
 *
 * 策略：system 保底 + 最近优先 + 预算极小保底最新一条 + reserveForOutput 预留。
 * 不修改任何状态（纯函数），零 agent.ts 依赖。
 */
import { describe, it, expect } from 'vitest'
import { suggestTrim, estimateMessagesTokens } from '../src/core/context.js'
import type { Message } from '../src/core/llm.js'

function msg(role: Message['role'], content: string): Message {
  return { role, content }
}

/** 估算示例：'你是助手'=8，'你好'=6，'你好！有什么可以帮你？'=14，'帮我写代码'=9 → 总量 37 */
const SAMPLE: Message[] = [
  msg('system', '你是助手'),
  msg('user', '你好'),
  msg('assistant', '你好！有什么可以帮你？'),
  msg('user', '帮我写代码'),
]

describe('suggestTrim（上下文裁剪建议，纯函数）', () => {
  it('空消息 → keep 空，全部统计为 0', () => {
    const r = suggestTrim([], 1000)
    expect(r.keep).toEqual([])
    expect(r.droppedCount).toBe(0)
    expect(r.estimatedKeptTokens).toBe(0)
    expect(r.estimatedDroppedTokens).toBe(0)
  })

  it('预算充足（≥ 总量）→ keep 全部，不丢弃', () => {
    const r = suggestTrim(SAMPLE, 40)
    expect(r.keep).toHaveLength(4)
    expect(r.droppedCount).toBe(0)
    expect(r.keep).toEqual(SAMPLE) // 顺序保持
  })

  it('预算不足 → system 保底 + 最近优先（丢弃最早的中间消息）', () => {
    const r = suggestTrim(SAMPLE, 20)
    // system(8) + 最新 user(9) = 17 ≤ 20；assistant(14) 放不下 → 丢弃前两条
    expect(r.keep.map((m) => m.content)).toEqual(['你是助手', '帮我写代码'])
    expect(r.droppedCount).toBe(2)
    expect(r.estimatedKeptTokens).toBe(estimateMessagesTokens(r.keep))
    expect(r.estimatedKeptTokens).toBeLessThanOrEqual(20)
  })

  it('预算极小（连 system 都超）→ 仍保底保留最新一条（AI 必须看到最新输入）', () => {
    const r = suggestTrim(SAMPLE, 5)
    // system(8) 已超 5：保底放最新 user，哪怕超预算
    expect(r.keep.map((m) => m.content)).toEqual(['你是助手', '帮我写代码'])
    expect(r.droppedCount).toBe(2)
  })

  it('reserveForOutput：预留输出 tokens → 保留更少', () => {
    // 总量 37；预算 40 无预留 → 全保留
    expect(suggestTrim(SAMPLE, 40).droppedCount).toBe(0)
    // 预留 10 → 有效预算 30 → assistant(14) 放不下 → 丢 2 条
    const r = suggestTrim(SAMPLE, 40, { reserveForOutput: 10 })
    expect(r.droppedCount).toBe(2)
    expect(r.keep.map((m) => m.content)).toEqual(['你是助手', '帮我写代码'])
  })

  it('keepSystem: false → system 也可被裁剪', () => {
    const r = suggestTrim(SAMPLE, 5, { keepSystem: false })
    // 无 system 保底：预算 5 一条都放不下 → 保底最新一条
    expect(r.keep.map((m) => m.content)).toEqual(['帮我写代码'])
    expect(r.droppedCount).toBe(3)
  })

  it('首条非 system → 无 system 保底（正常最近优先）', () => {
    const noSystem: Message[] = [msg('user', '第一条'), msg('user', '第二条很长很长很长很长很长'), msg('user', '最新')]
    const r = suggestTrim(noSystem, 12)
    // 尾部收集：最新(6+4=10? '最新'=2CJK+4=6)… '最新'=2 CJK → 2+4=6 ≤12；'第二条...' 估 >6 → 停
    expect(r.keep[r.keep.length - 1].content).toBe('最新')
    expect(r.droppedCount).toBeGreaterThan(0)
  })

  it('统计一致性：kept + dropped ≈ 总量（dropped 不为负）', () => {
    const r = suggestTrim(SAMPLE, 15)
    const total = estimateMessagesTokens(SAMPLE)
    expect(r.estimatedKeptTokens + r.estimatedDroppedTokens).toBeLessThanOrEqual(total)
    expect(r.estimatedDroppedTokens).toBeGreaterThanOrEqual(0)
  })

  it('空预算/负预算 → 仍保底 system + 最新一条（不崩溃）', () => {
    const r = suggestTrim(SAMPLE, 0)
    expect(r.keep.length).toBeGreaterThanOrEqual(1)
    expect(r.keep[r.keep.length - 1].content).toBe('帮我写代码')
  })
})
