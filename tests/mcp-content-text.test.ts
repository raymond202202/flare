/**
 * mcpContentToText 纯函数测试（v0.6.117）
 *
 * MCP tools/call 响应的非 text 内容项（image/audio/resource）此前被 createMcpTools /
 * CLI mcp call 静默丢弃（只提取 type === 'text'）；structuredContent（2025-06-18 协议
 * 结构化返回）也完全未处理。本测试验证 mcpContentToText 的占位描述与 JSON 兜底行为，
 * 以及 createMcpTools 桥接层对非 text 内容的输出。
 */
import { describe, it, expect } from 'vitest'
import { mcpContentToText, createMcpTools, type McpToolClient } from '../src/tools/mcp.js'
import type { McpContentItem } from '../src/mcp/types.js'

describe('mcpContentToText（MCP 内容项 → flare 工具输出文本）', () => {
  it('纯 text 项：原文提取（多项按序拼接，与旧行为逐字一致）', () => {
    const content: McpContentItem[] = [
      { type: 'text', text: '第一行' },
      { type: 'text', text: '第二行' },
    ]
    expect(mcpContentToText(content)).toBe('第一行\n第二行')
  })

  it('image 项：输出占位描述（mimeType + 数据量），绝不输出 base64 明文', () => {
    const content: McpContentItem[] = [{ type: 'image', data: 'aGVsbG8taW1hZ2U=', mimeType: 'image/png' }]
    const out = mcpContentToText(content)
    expect(out).toContain('[图片 mimeType: image/png')
    expect(out).toContain('数据 16 字符')
    expect(out).not.toContain('aGVsbG8taW1hZ2U=')
  })

  it('audio 项：输出占位描述（mimeType + 数据量），不输出 data 明文', () => {
    const content: McpContentItem[] = [{ type: 'audio', data: 'YXVkaW8tZGF0YQ==', mimeType: 'audio/wav' }]
    const out = mcpContentToText(content)
    expect(out).toContain('[音频 mimeType: audio/wav')
    expect(out).not.toContain('YXVkaW8tZGF0YQ==')
  })

  it('image/audio 缺 mimeType/data：占位仍完整（未知 mime、数据 0 字符）', () => {
    expect(mcpContentToText([{ type: 'image' }])).toContain('[图片 mimeType: 未知, 数据 0 字符]')
    expect(mcpContentToText([{ type: 'audio', data: 123 as any }])).toContain('[音频 mimeType: 未知, 数据 0 字符]')
  })

  it('resource 项：输出 uri/mimeType 占位 + 短 text 附内容；blob 不输出', () => {
    const content: McpContentItem[] = [
      { type: 'resource', resource: { uri: 'file:///tmp/a.txt', mimeType: 'text/plain', text: 'hello resource' } },
    ]
    const out = mcpContentToText(content)
    expect(out).toContain('[资源 uri: file:///tmp/a.txt mimeType: text/plain]')
    expect(out).toContain('hello resource')
    // blob（base64）绝不输出
    const blobContent: McpContentItem[] = [
      { type: 'resource', resource: { uri: 'file:///tmp/b.png', mimeType: 'image/png', blob: 'YmxvYi1kYXRh' } },
    ]
    const blobOut = mcpContentToText(blobContent)
    expect(blobOut).toContain('[资源 uri: file:///tmp/b.png mimeType: image/png]')
    expect(blobOut).not.toContain('YmxvYi1kYXRh')
  })

  it('resource 项超长 text（>2000 字符）：只输出占位，不附全文', () => {
    const content: McpContentItem[] = [
      { type: 'resource', resource: { uri: 'file:///tmp/long.txt', text: 'x'.repeat(3000) } },
    ]
    const out = mcpContentToText(content)
    expect(out).toContain('[资源 uri: file:///tmp/long.txt]')
    expect(out).not.toContain('x'.repeat(3000))
    expect(out.length).toBeLessThan(200)
  })

  it('未知类型：输出 [内容类型: X] 占位（不再静默丢弃）', () => {
    const content: McpContentItem[] = [{ type: 'video', data: 'xxx' }]
    expect(mcpContentToText(content)).toContain('[内容类型: video]')
  })

  it('混合顺序：text 与 image/resource 按序拼接', () => {
    const content: McpContentItem[] = [
      { type: 'text', text: '结果：' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      { type: 'text', text: '完成' },
    ]
    const out = mcpContentToText(content)
    expect(out).toBe('结果：\n[图片 mimeType: image/png, 数据 8 字符]\n完成')
  })

  it('无文本且 structuredContent 存在 → JSON 兜底', () => {
    const out = mcpContentToText([], { ok: true, count: 3 })
    expect(out).toBe('{"ok":true,"count":3}')
  })

  it('structuredContent 兜底超长 → 截断 + 省略标记', () => {
    const big = { list: 'x'.repeat(5000) }
    const out = mcpContentToText([], big)
    expect(out.length).toBeLessThanOrEqual(4100)
    expect(out).toMatch(/结构化内容过长，省略 \d+ 字符/)
  })

  it('content 非数组 / 空数组 / structuredContent 缺失 → 空串（不抛错）', () => {
    expect(mcpContentToText(undefined)).toBe('')
    expect(mcpContentToText([])).toBe('')
    expect(mcpContentToText([{ type: 'image' }] as any, undefined)).toContain('[图片')
    expect(mcpContentToText('not-array' as any)).toBe('')
  })

  it('structuredContent 无法序列化（循环引用）→ 占位提示', () => {
    const cyclic: any = {}
    cyclic.self = cyclic
    const out = mcpContentToText([], cyclic)
    expect(out).toBe('[结构化内容无法序列化]')
  })
})

describe('createMcpTools 桥接层（非 text 内容 → flare Tool 输出）', () => {
  it('stub client 返回 image/audio/resource 混合内容 → output 为占位拼接文本', async () => {
    const client: McpToolClient = {
      listTools: async () => [{ name: 'rich', description: '混合', inputSchema: { type: 'object', properties: {} } }],
      callTool: async () => ({
        content: [
          { type: 'text', text: '处理完成' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ],
      }),
    }
    const tools = await createMcpTools(client)
    const res = await tools[0].execute({})
    expect(res.success).toBe(true)
    expect(res.output).toContain('处理完成')
    expect(res.output).toContain('[图片 mimeType: image/png')
    expect(res.output).not.toContain('aGVsbG8=')
  })

  it('stub client 返回空 content + structuredContent → output 为 JSON 兜底', async () => {
    const client: McpToolClient = {
      listTools: async () => [{ name: 'struct', description: '结构化', inputSchema: { type: 'object', properties: {} } }],
      callTool: async () => ({ content: [], structuredContent: { rows: [1, 2] } }),
    }
    const tools = await createMcpTools(client)
    const res = await tools[0].execute({})
    expect(res.success).toBe(true)
    expect(res.output).toBe('{"rows":[1,2]}')
  })

  it('isError=true 且非 text 内容 → error 为占位文本', async () => {
    const client: McpToolClient = {
      listTools: async () => [{ name: 'richfail', description: '失败', inputSchema: { type: 'object', properties: {} } }],
      callTool: async () => ({
        content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
        isError: true,
      }),
    }
    const tools = await createMcpTools(client)
    const res = await tools[0].execute({})
    expect(res.success).toBe(false)
    expect(res.error).toContain('[图片 mimeType: image/png')
    expect(res.error).not.toContain('aGVsbG8=')
  })
})
