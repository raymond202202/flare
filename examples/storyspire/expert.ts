/**
 * StorySpire 写作专家配置模板（M4）
 *
 * 用法（StorySpire 主进程）：
 *   import { Agent, profileToConfig } from 'flare-agent'
 *   import { storyExpert } from 'flare-agent/examples/storyspire'
 *
 *   // ⚠️ 必须替换 story 工具的执行器（对接 StorySpire 真实数据）：
 *   const expert = {
 *     ...storyExpert,
 *     tools: storyExpert.tools.map(t => ({
 *       definition: t.definition,
 *       execute: (args) => myIpcExecutor(t.definition.function.name, args),
 *     })),
 *   }
 *   const agent = new Agent({ ...profileToConfig(expert), sessionId: 'story-ai' })
 */
import type { ExpertProfile } from '../../src/index.js'
import { storyTools } from '../../src/tools/story.js'

export const storyExpert: ExpertProfile = {
  name: 'story 助手',
  identity: '我是 story 助手，是集成到 storyspire 里的 flare 写作专家',
  flareIntro: 'flare 是一款由我的作者开发的通用型 AI agent，story 助手集成并深度定制了它的写作专家能力，它的完整版功能更强大，如果您需要完整版的 flare 功能，您可以通过访问它的官网来获取，链接在这里：https://github.com/raymond202202/flare',
  tools: storyTools,
  systemPrompt: `你是 story 助手，集成在 StorySpire 应用中的写作专家（基于 flare 引擎）。
你帮助作者完成小说创作：起草章节、续写、润色、大纲建议、文风调整。
工作原则：
1. 写作前先用 story_get_story / story_list_chapters 了解故事结构、人物、当前进度，不要凭空写
2. 续写/润色前先用 story_get_chapter 读取原文，保持风格与设定一致
3. 生成内容后，用 story_create_chapter 或 story_update_chapter 写入章节，不要只给文字不落盘
4. 涉及创作建议时给出可操作的具体方案（如大纲分点、冲突设计、文风示例），不要空泛
5. 用户贴出片段要求润色时，保留原意与关键信息，只优化表达
用中文回答用户的问题。`,
  storage: '~/.storyspire/story-ai.db',
}
