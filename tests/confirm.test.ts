/**
 * withConfirmation 工具确认机制测试
 */
import { describe, it, expect, vi } from 'vitest'
import { withConfirmation, isDenied } from '../src/core/confirm.js'
import type { Tool } from '../src/tools/index.js'

function makeWriteTool(): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'write_something',
        description: '写内容',
        parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
      },
    },
    execute: async (args) => ({ success: true, output: `已写入: ${args.content}` }),
  }
}

describe('withConfirmation 工具确认', () => {
  it('allow_once 执行原工具', async () => {
    const tool = withConfirmation(makeWriteTool(), () => 'allow_once')
    const res = await tool.execute({ content: 'hello' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('hello')
  })

  it('deny 不执行原工具，返回用户拒绝', async () => {
    const spy = vi.fn()
    const tool = withConfirmation({
      ...makeWriteTool(),
      execute: async (args) => { spy(); return { success: true, output: '不应执行' } },
    }, () => 'deny')
    const res = await tool.execute({ content: 'x' })
    expect(res.success).toBe(false)
    expect(res.denied).toBe(true)
    expect(spy).not.toHaveBeenCalled()
    expect(isDenied(res)).toBe(true)
  })

  it('alternative 不执行，返回替代方案请求', async () => {
    const spy = vi.fn()
    const tool = withConfirmation({
      ...makeWriteTool(),
      execute: async () => { spy(); return { success: true, output: 'x' } },
    }, () => 'alternative')
    const res = await tool.execute({})
    expect(res.success).toBe(false)
    expect(res.alternative).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('confirmer 收到工具名和参数', async () => {
    const confirmer = vi.fn(() => 'allow_once')
    const tool = withConfirmation(makeWriteTool(), confirmer)
    await tool.execute({ content: 'abc' })
    expect(confirmer).toHaveBeenCalledWith('write_something', { content: 'abc' })
  })

  it('always / allow_session 也执行', async () => {
    for (const d of ['always', 'allow_session'] as const) {
      const tool = withConfirmation(makeWriteTool(), () => d)
      const res = await tool.execute({ content: 'y' })
      expect(res.success).toBe(true)
    }
  })
})
