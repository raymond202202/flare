/**
 * 写作工具集 + 写作专家模板测试（M4）
 */
import { describe, it, expect } from 'vitest'
import { storyTools, storyToolDefinitions, getStoryToolDefinitions } from '../src/tools/story.js'
import { storyExpert } from '../examples/storyspire/expert.js'

describe('story 写作工具集', () => {
  it('导出 5 个标准写作工具', () => {
    expect(storyToolDefinitions).toHaveLength(5)
    expect(storyTools).toHaveLength(5)
  })

  it('工具名称符合 story_ 前缀规范', () => {
    const names = storyToolDefinitions.map(d => d.function.name)
    expect(names).toEqual([
      'story_get_story',
      'story_get_chapter',
      'story_list_chapters',
      'story_create_chapter',
      'story_update_chapter',
    ])
  })

  it('story_update_chapter 必须含 chapterId 和 content', () => {
    const upd = storyToolDefinitions.find(d => d.function.name === 'story_update_chapter')!
    expect(upd.function.parameters.required).toContain('chapterId')
    expect(upd.function.parameters.required).toContain('content')
    const props = upd.function.parameters.properties as Record<string, any>
    expect(props.content.type).toBe('string')
    expect(props.chapterId.type).toBe('string')
  })

  it('story_get_chapter 必须含 chapterId 参数', () => {
    const get = storyToolDefinitions.find(d => d.function.name === 'story_get_chapter')!
    expect(get.function.parameters.required).toContain('chapterId')
  })

  it('占位执行器提示宿主注入（不静默成功）', async () => {
    const res = await storyTools[4].execute({ chapterId: 'x', content: 'y' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('未注入')
  })

  it('getStoryToolDefinitions 返回相同定义', () => {
    expect(getStoryToolDefinitions()).toEqual(storyToolDefinitions)
  })
})

describe('story 写作专家模板', () => {
  it('品牌话术包含身份声明', () => {
    expect(storyExpert.name).toBe('story 助手')
    expect(storyExpert.identity).toContain('flare 写作专家')
  })

  it('flareIntro 引导到 flare 官网', () => {
    expect(storyExpert.flareIntro).toContain('github.com/raymond202202/flare')
  })

  it('工具集挂载 5 个写作工具', () => {
    expect(storyExpert.tools).toHaveLength(5)
  })

  it('存储路径指向 StorySpire 独立库', () => {
    expect(storyExpert.storage).toBe('~/.storyspire/story-ai.db')
  })

  it('系统提示包含写作原则', () => {
    expect(storyExpert.systemPrompt).toContain('story_get_story')
    expect(storyExpert.systemPrompt).toContain('story_update_chapter')
  })
})
