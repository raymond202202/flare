# Pulse 集成指南（flare 引擎网络专家）

> 版本：v1.0（2026-08-01）· flare-pulse 分支
> 前提：flare 仓库已发布库入口（M1）+ Expert Profile 机制（M2）

---

## 1. 安装 flare 引擎

在 Pulse 项目（Electron 主进程侧）安装：

```bash
cd ~/hermes-projects/pulse
npm install /home/fantastic/hermes-projects/flare   # 本地路径（开发期）
# 发布后：npm install flare-agent
```

> ⚠️ better-sqlite3 是原生模块，Electron 需要 rebuild：
> ```bash
> npx electron-rebuild -f -w better-sqlite3
> ```

## 2. 主进程创建网络专家 Agent

新建 `electron/aiAgent.js`：

```javascript
const { Agent, profileToConfig } = require('flare-agent')
const { pulseExpert } = require('flare-agent/examples/pulse')

// 延迟初始化（等用户配好 API key 再创建）
let agent = null
function getAgent() {
  if (!agent) {
    agent = new Agent({
      ...profileToConfig(pulseExpert),
      sessionId: 'pulse-ai',
    })
  }
  return agent
}
```

> API key：Pulse 设置面板保存到 `~/.pulse/`，启动时写入环境变量
> （`process.env.OPENAI_API_KEY` 等），flare 的 config 自动读取。

## 3. IPC 桥接（main.js + preload.js）

main.js 注册：

```javascript
const { ipcMain } = require('electron')

ipcMain.handle('ai:chat', async (event, { input, sessionId }) => {
  const agent = getAgent()
  const chunks = []
  for await (const chunk of agent.run(input)) {
    // 流式回传
    event.sender.send('ai:chunk', { sessionId, ...chunk })
  }
  return { done: true }
})
```

preload.js 暴露：

```javascript
contextBridge.exposeInMainWorld('electronAPI', {
  aiChat: (input, sessionId) => ipcRenderer.invoke('ai:chat', { input, sessionId }),
  onAiChunk: (callback) => ipcRenderer.on('ai:chunk', (e, data) => callback(data)),
})
```

## 4. AiPanel 改造（渲染进程）

- 移除 `aiService.ts` 里直接 fetch DeepSeek/OpenAI 的逻辑
- 改调 `window.electronAPI.aiChat(input, sessionId)`
- 用 `onAiChunk` 流式渲染（复用 flare 的 text/tool_call/tool_result/done 事件）
- 面板标题显示 "pulse 助手"

## 5. 品牌话术（自动生效）

问"你是谁" → 系统提示中的 identity 生效：
> "我是 pulse 助手，是集成到 pulse 的 flare 网络专家"

追问"flare 是什么" → flareIntro 生效：
> "flare 是一款由我的作者开发的通用型 AI agent… https://github.com/raymond202202/flare"

## 6. 记忆独立

`pulseExpert.storage = '~/.pulse/pulse-ai.db'`（Agent storage 参数）——
Pulse 的对话历史、记忆独立存储，不与 flare CLI 共享。

## 7. 安全

- Pulse key 存 `~/.pulse/`，不入 GitHub
- 网络工具只允许 http/https（flare 引擎内已限制）
- 危险命令黑名单 / 路径保护继承引擎默认
