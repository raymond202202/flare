/**
 * 视觉 / 多模态功能测试（v0.4.0）
 * 覆盖：parseAttachments 自动识别、buildImageContent 构建、content 序列化往返
 */
import { describe, it, expect, afterAll } from 'vitest'
import {
  parseAttachments,
  buildImageContent,
  fileToDataUrl,
  isImageFile,
} from '../src/core/llm.js'
import { serializeContent, deserializeContent } from '../src/memory/store.js'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 临时假图片文件（parseAttachments 只看存在性 + 扩展名）
const tempDir = mkdtempSync(join(tmpdir(), 'flare-vision-'))
const pngPath = join(tempDir, 'test.png')
const spacedPath = join(tempDir, 'my photo 01.jpg')
const txtPath = join(tempDir, 'note.txt')
writeFileSync(pngPath, 'fake-png-bytes')
writeFileSync(spacedPath, 'fake-jpg-bytes')
writeFileSync(txtPath, 'not an image')

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('parseAttachments 自动识别图片', () => {
  it('裸路径 + 文本 → 识别并剥离路径', () => {
    const r = parseAttachments(`看看这张图 ${pngPath} 里面有什么`)
    expect(r.attachments).toEqual([pngPath])
    expect(r.text).toBe('看看这张图 里面有什么')
  })

  it('引号包裹的路径（含空格）', () => {
    const r = parseAttachments(`分析下 "${spacedPath}" 这个截图`)
    expect(r.attachments).toEqual([spacedPath])
    expect(r.text).toBe('分析下 这个截图')
  })

  it('data URL 直接识别', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    const r = parseAttachments(`这是截图 ${dataUrl} 请描述`)
    expect(r.attachments).toEqual([dataUrl])
    expect(r.text).toBe('这是截图 请描述')
  })

  it('不存在的路径 / 非图片文件 → 不识别', () => {
    const r = parseAttachments(`读一下 ${txtPath} 和 /nonexistent/path/img.png`)
    expect(r.attachments).toEqual([])
    expect(r.text).toContain(txtPath)
  })

  it('引号包裹但文件不存在的路径 → 保留原文不剥离（防误吞）', () => {
    const r = parseAttachments('"hello.png" 请解释这个')
    expect(r.attachments).toEqual([])
    expect(r.text).toContain('"hello.png"')
    expect(r.text).toContain('请解释这个')
  })

  it('尾部标点剥离（xxx.png？）', () => {
    const r = parseAttachments(`看 ${pngPath}？`)
    expect(r.attachments).toEqual([pngPath])
  })

  it('~ 展开', () => {
    // 用真实 home 下的文件（.env 必然存在但非图片；这里构造 ~ 形式并验证不炸）
    const r = parseAttachments(`看 ~/Pictures/不存在的图.png`)
    expect(r.attachments).toEqual([])
  })

  it('纯路径无文本 → text 为空', () => {
    const r = parseAttachments(pngPath)
    expect(r.attachments).toEqual([pngPath])
    expect(r.text).toBe('')
  })
})

describe('buildImageContent 构建多模态消息', () => {
  it('文本 + 本地路径 → text + image_url(data url)', () => {
    const parts = buildImageContent('这是什么', [pngPath])
    expect(parts[0]).toEqual({ type: 'text', text: '这是什么' })
    expect(parts[1].type).toBe('image_url')
    expect((parts[1] as any).image_url.url).toMatch(/^data:image\/png;base64,/)
  })

  it('纯文本 → 只有 text part', () => {
    const parts = buildImageContent('你好', [])
    expect(parts).toHaveLength(1)
    expect(parts[0]).toEqual({ type: 'text', text: '你好' })
  })

  it('data URL 直接透传', () => {
    const dataUrl = 'data:image/png;base64,AAAA'
    const parts = buildImageContent('看图', [dataUrl])
    expect((parts[1] as any).image_url.url).toBe(dataUrl)
  })
})

describe('fileToDataUrl / isImageFile', () => {
  it('fileToDataUrl 生成带 mime 的 data url', () => {
    const url = fileToDataUrl(pngPath)
    expect(url).toMatch(/^data:image\/png;base64,/)
  })

  it('isImageFile 识别存在图片，拒绝非图片', () => {
    expect(isImageFile(pngPath)).toBe(true)
    expect(isImageFile(txtPath)).toBe(false)
    expect(isImageFile('/nonexistent/a.png')).toBe(false)
  })
})

describe('content 序列化（图片不落库）', () => {
  it('字符串原样', () => {
    expect(serializeContent('你好')).toBe('你好')
  })

  it('多模态数组 → JSON，图片 part 变占位符', () => {
    const parts = buildImageContent('这是什么', [pngPath])
    const serialized = serializeContent(parts)
    expect(serialized).toContain('[图片]')
    expect(serialized).not.toContain('base64') // 图片数据不落库
  })

  it('反序列化往返：多模态 → 拼接文本', () => {
    const parts = buildImageContent('这是什么', [pngPath])
    const back = deserializeContent(serializeContent(parts))
    expect(back).toBe('这是什么[图片]')
  })

  it('老数据字符串反序列化原样', () => {
    expect(deserializeContent('普通历史消息')).toBe('普通历史消息')
    expect(deserializeContent('')).toBe('')
  })
})
