/**
 * server 协议 tools 接口测试（v0.6.11）
 *
 * 覆盖：
 * - describeTools 纯函数：元数据收集（名称/描述/参数）+ 确认门标注 + 来源判定
 *   （host/profile/mcp/builtin；同一工具多来源时 host 优先）
 * - e2e（子进程）tools 请求在 server.test.ts（协议层：默认内置清单 + 确认名单回显）。
 */
import { describe, it, expect } from 'vitest'
import { describeTools, DEFAULT_CONFIRM_TOOLS } from '../src/server.js'
import type { Tool } from '../src/tools/index.js'

function makeTool(name: string, description = `${name} 的描述`, params?: Record<string, unknown>): Tool {
  return {
    definition: {
      type: 'function',
      function: { name, description, ...(params ? { parameters: params } : {}) },
    },
    execute: async () => ({ success: true, output: '' }),
  }
}

describe('describeTools（server 协议 tools 接口的纯逻辑）', () => {
  it('收集元数据：名称/描述/参数 + confirmed 标注（命中确认名单）', () => {
    const tools = [
      makeTool('memory_save', '保存持久记忆', { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] }),
      makeTool('read_file', '读取文件'),
    ]
    const meta = describeTools(tools, DEFAULT_CONFIRM_TOOLS)
    expect(meta).toHaveLength(2)

    const save = meta.find((m) => m.name === 'memory_save')!
    expect(save.description).toBe('保存持久记忆')
    expect(save.parameters).toEqual({ type: 'object', properties: { content: { type: 'string' } }, required: ['content'] })
    expect(save.confirmed).toBe(true)

    const read = meta.find((m) => m.name === 'read_file')!
    expect(read.description).toBe('读取文件')
    expect(read.confirmed).toBe(false)
  })

  it('来源判定：host / profile / mcp / builtin（默认内置回退）', () => {
    const tools = [
      makeTool('host_tool'),
      makeTool('profile_tool'),
      makeTool('mcp_tool'),
      makeTool('builtin_tool'),
    ]
    const meta = describeTools(tools, [], {
      host: new Set(['host_tool']),
      profile: new Set(['profile_tool']),
      mcp: new Set(['mcp_tool']),
    })
    const byName = (n: string) => meta.find((m) => m.name === n)!.source
    expect(byName('host_tool')).toBe('host')
    expect(byName('profile_tool')).toBe('profile')
    expect(byName('mcp_tool')).toBe('mcp')
    expect(byName('builtin_tool')).toBe('builtin')
  })

  it('同一工具名多来源时 host 优先（再 mcp，再 profile）', () => {
    const meta = describeTools([makeTool('dup')], [], {
      host: new Set(['dup']),
      profile: new Set(['dup']),
      mcp: new Set(['dup']),
    })
    expect(meta[0].source).toBe('host')
  })

  it('空确认名单 → 全部 confirmed=false（确认门关闭）', () => {
    const meta = describeTools([makeTool('memory_save')], [])
    expect(meta[0].confirmed).toBe(false)
  })

  it('无描述/无参数的工具：字段缺省（undefined）不出现', () => {
    const meta = describeTools([makeTool('bare')], [])
    expect(meta[0].name).toBe('bare')
    expect(meta[0].description).toBe('bare 的描述') // makeTool 给了描述
    expect(meta[0].parameters).toBeUndefined()
    expect(meta[0].confirmed).toBe(false)
    expect(meta[0].source).toBe('builtin')
  })
})
