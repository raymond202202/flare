/**
 * parseAttachments 必须保留换行与行首缩进：
 * 历史上它用 /\s+/g 压成单空格，导致多行粘贴（代码、段落）提交后被压成一行。
 */
import { describe, it, expect } from 'vitest'
import { parseAttachments } from '../src/core/llm'

describe('parseAttachments 多行保真', () => {
  it('保留换行，不把多行压成一行', () => {
    const input = '第一行\n第二行\n第三行'
    expect(parseAttachments(input).text).toBe('第一行\n第二行\n第三行')
  })

  it('保留代码缩进（行首空格与 Tab 原样）', () => {
    const code = 'function f() {\n    return 1\n\t// tab 缩进\n}'
    expect(parseAttachments(code).text).toBe(code)
  })

  it('去掉首尾空行与行尾空白', () => {
    expect(parseAttachments('\n\n  内容  \n\n').text).toBe('内容')
  })

  it('行内多余空格仍被整理成一个（既有行为）', () => {
    expect(parseAttachments('这是   一段    文字').text).toBe('这是 一段 文字')
  })

  it('无附件时 attachments 为空', () => {
    expect(parseAttachments('多行\n文本').attachments).toEqual([])
  })
})
