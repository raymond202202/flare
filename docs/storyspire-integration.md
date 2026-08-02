# StorySpire 集成指南（flare 写作专家 · M4）

> 状态：flare 侧已交付（v0.5.0），StorySpire 侧待接入
> 分支：flare-storyspire

---

## 一、架构

```
┌─────────────── StorySpire (Electron) ───────────────┐
│                                                     │
│  渲染进程                       主进程               │
│  ┌────────────────┐            ┌───────────────┐    │
│  │ AiPanel（写作助手）│            │ flare Agent    │    │
│  │ 对话区 + 章节树  │ ◄──IPC──► │ （写作专家）    │    │
│  │ 生成内容写回章节 │  ai:chat   │ story_* 工具   │    │
│  └────────────────┘  ai:chunk   │ 定义 + 执行器   │    │
│  storyStore ◄─IPC─┐             └───────┬───────┘    │
│  (章节/大纲)       │ ai:tool-execute      │ DeepSeek   │
│                   └──────────┐           │ API        │
│                               ▼           ▼            │
│                       真实 stores 修改    ~/.storyspire/│
│                       (章节写入)          story-ai.db   │
└─────────────────────────────────────────────────────┘
```

## 二、flare 侧交付（已完成）

| 文件 | 内容 |
|------|------|
| `src/tools/story.ts` | 5 个写作工具标准定义（story_get_story / get_chapter / list_chapters / create_chapter / update_chapter）+ 占位执行器 |
| `examples/storyspire/expert.ts` | 写作专家模板（品牌话术 + 写作提示词 + 独立存储） |
| `tests/story.test.ts` | 11 项测试（schema/品牌话术/占位执行器） |
| 导出 | `index.ts` 增加 storyTools / storyToolDefinitions / getStoryToolDefinitions |

## 三、StorySpire 接入步骤

### 1. 依赖（复制 Pulse 的教训配置）
```json
// package.json
"dependencies": {
  "flare-agent": "https://github.com/raymond202202/flare/archive/<commit-sha>.tar.gz"
}
// .npmrc
registry=https://registry.npmmirror.com
allow-remote=all
// scripts
"build:flare": "cd node_modules/flare-agent && npx tsc"
```
> 坑：不用 file: 本地路径（CI 挂）；tarball 无 dist（打包前 build:flare）；npm 12 禁 remote（allow-remote=all）

### 2. 主进程 aiAgent.js（仿 Pulse）
```javascript
// CJS 主进程 + ESM 动态 import
const { ipcMain } = require('electron')

async function getAgent(sender) {
  const { Agent, profileToConfig, storyTools } = await import('flare-agent')

  // ⚠️ 替换 story 工具执行器 → IPC 到渲染进程操作 storyStore
  const storyExecutors = storyTools.map(t => ({
    definition: t.definition,
    execute: (args) => makeIpcExecutor(sender)(t.definition.function.name, args),
  }))

  const agent = new Agent({
    ...profileToConfig({
      ...storyExpertBase,          // examples/storyspire/expert.ts
      tools: storyExecutors,
    }),
    sessionId: currentSessionId,
  })
  return agent
}
```
- key：渲染进程设置 → `ai:configureKey` IPC → `process.env.DEEPSEEK_API_KEY`（内存，不落盘）
- 存储：`~/.storyspire/story-ai.db`（flare 自动建目录）

### 3. 渲染进程工具执行器（对接 storyStore）
```typescript
// 监听 ai:tool-execute → 分发到 storyStore：
case 'story_get_story':      return storyStore.getState().story          // 结构摘要
case 'story_get_chapter':    return storyStore.getState().story.chapters.find(c => c.id === args.chapterId)
case 'story_list_chapters':  return storyStore.getState().story.chapters   // 标题/字数列表
case 'story_create_chapter': return createChapter(args.title)             // 新建 + 返回 id
case 'story_update_chapter': return updateChapter(args.chapterId, args.content) // 写回正文
```

### 4. IPC 桥（preload）
```javascript
aiChat: (input, sessionId, context) => ipcRenderer.invoke('ai:chat', { input, sessionId, context }),
onAiChunk: (cb) => ipcRenderer.on('ai:chunk', (_e, d) => cb(d)),
configureAiKey: (provider, key) => ipcRenderer.invoke('ai:configureKey', { provider, key }),
onAiToolExecute: (cb) => ipcRenderer.on('ai:tool-execute', (_e, d) => cb(d)),
aiToolResult: (id, result) => ipcRenderer.send('ai:tool-result', { id, result }),
// 会话管理（复用 flare 能力）
aiListSessions / aiCreateSession / aiSwitchSession / aiGetSessionMessages
```

### 5. 品牌话术（M4-5 验收）
问"你是谁" → 回答："我是 story 助手，是集成到 storyspire 里的 flare 写作专家"
问"flare 是什么" → 引导 GitHub 链接

## 四、安全红线
1. key 只存主进程内存（process.env），渲染进程不存明文（**StorySpire 现状是渲染进程直连 API + localStorage 明文——必须改**）
2. flare 侧无任何 key / 路径 / IP
3. 推 GitHub 前全历史扫密码模式 + key 模式

## 五、验收清单（M4）
- [ ] StorySpire AI 面板能用写作专家对话
- [ ] "帮我把这段改得更文学" → story_get_chapter 读原文 → 润色 → story_update_chapter 写回
- [ ] 品牌话术实测符合
- [ ] 会话：重启新会话 + 历史可续 + 全局记忆保留
- [ ] 安全：key 不在 localStorage / 不入 GitHub
