# Flare 🔥

> **Let your inspiration flare** — 让你的灵感燃起来。
>
> 🧠 **由 AI 构建** — 本项目由 AI 智能体（Hermes Agent by Nous Research）在人类指导下开发，并由 Flare 自身持续迭代进化。

**flare 的目标是成为你唯一需要的 AI 助理。** 兼容 OpenAI / DeepSeek 等多种 LLM。

![Node](https://img.shields.io/badge/Node-22-339933) ![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6) ![SQLite](https://img.shields.io/badge/SQLite-FTS5-003B57) ![License](https://img.shields.io/badge/License-MIT-yellow)

---

[English](#english) | [中文](#中文)

---

## 中文

### 快速开始

```bash
# 安装依赖
npm install

# 构建
npm run build

# 安装到本地（项目目录与安装目录分离）
bash scripts/install.sh

# 交互模式
flare

# 单次查询
flare chat -q "帮我写一个 FastAPI 服务"
```

### 架构

```
src/
├── cli/          # CLI 入口和命令（交互模式 + 单次查询）
├── core/
│   ├── agent.ts  # Agent 核心循环：系统提示 → LLM → 工具 → 反馈 → 继续
│   ├── config.ts # 配置管理：从 .env 和环境变量读取
│   └── llm.ts    # LLM 抽象层：支持 OpenAI / DeepSeek / 兼容 API
├── tools/
│   └── index.ts  # 工具系统：read_file / write_file / search_files / terminal
├── memory/
│   └── store.ts  # 记忆系统：SQLite + FTS5 全文搜索
└── skills/       # 技能系统（预留）
```

### 核心能力

#### 🤖 Agent 循环

```
用户输入
    ↓
加载记忆 + 会话历史
    ↓
调用 LLM（Function Calling）
    ├──→ 有工具调用 → 执行工具 → 反馈 → 继续
    └──→ 无工具调用 → 生成回复 → 输出
    ↓
保存到记忆数据库
```

#### 🛠️ 工具系统

| 工具 | 说明 | 参数 |
|------|------|------|
| `read_file` | 读取文件内容，带行号 | path, offset?, limit? |
| `write_file` | 写入/覆盖文件 | path, content |
| `search_files` | 搜索文件内容或文件名 | pattern, path?, maxResults? |
| `terminal` | 执行终端命令 | command, timeout? |

#### 🧠 记忆系统

基于 SQLite 的持久化记忆，支持：

- **会话管理**：多会话隔离，自动保存对话历史
- **全文搜索**：FTS5 引擎，高效检索历史消息
- **持久记忆**：跨会话记住用户偏好和上下文

### 安装体系

Flare 采用 **项目目录与安装目录分离** 的架构：

```
~/flare园地/flare/          # 📁 项目代码（TypeScript 源码）
    ├── src/                # 源代码
    ├── package.json
    └── scripts/install.sh  # 安装脚本

~/.flare/install/           # 📁 安装目录（构建产物）
    ├── dist/               # 编译后的 JS
    ├── bin/flare           # 启动入口
    └── node_modules/

~/.flare/                   # 📁 数据目录（运行时数据）
    ├── .env                # API Key 等敏感配置
    └── flare.db            # 记忆数据库
```

**迭代流程：**

```bash
# 1. 修改源码
# 2. 构建
npm run build
# 3. 安装到本地
bash scripts/install.sh
# 4. 验证
flare chat -q "你好"
```

### 配置

复制 `.env.example` 为 `.env` 并填入 API Key：

```bash
cp .env.example ~/.flare/.env
```

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 | — |
| `OPENAI_API_KEY` | OpenAI API 密钥 | — |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 | — |
| `DEFAULT_MODEL` | 默认模型 | `deepseek-chat` |
| `OPENAI_BASE_URL` | 自定义 API 地址 | 自动检测 |
| `LLM_BASE_URL` | 主模型 API 地址覆盖（不设时按模型名自动检测：deepseek/gpt/本地 Ollama） | 自动检测 |
| `LLM_API_KEY` | 主模型 API 密钥覆盖 | 自动检测 |
| `VISION_MODEL` | 视觉模型（看图时用，可 /vision 切换） | `qwen2.5vl:3b` |
| `VISION_BASE_URL` | 视觉模型 API 地址（本地 Ollama） | `http://localhost:11434/v1` |
| `VISION_API_KEY` | 视觉模型 API 密钥 | `ollama` |
| `FLARE_HOME` | 数据目录 | `~/.flare` |

### CLI 命令

| 命令 | 说明 |
|------|------|
| `flare` | 交互模式（默认） |
| `flare chat` | 交互模式 |
| `flare chat -q "问题"` | 单次查询模式 |
| `flare chat -q "问题" -i 图片.png` | 单次查询附带图片 |

交互模式命令：

| 命令 | 功能 |
|------|------|
| `/help` | 显示帮助 |
| `/image <路径> <问题>` | 显式看图 |
| `/vision [3b\|7b\|default]` | 切换看图模型（3b 快速 ~4s / 7b 质量 30-60s） |
| `/model [模型名\|default]` | 切换主模型（如 `/model qwen2.5:7b` 本地 Ollama，`/model deepseek-chat` 远端） |
| `/memory` | 查看持久记忆 |
| `/sessions` | 查看最近会话 |
| `/clear` | 清屏 |
| `/exit` | 退出 |

> 💡 **看图**：对话里直接发图片路径也会自动识别（如 `看看这张图 ~/Pictures/a.png`），
> 自动切换到本地视觉模型（VLM），图片不出本机。支持引号路径、data URL（未来 GUI 贴截图）。

---

---

## English

**Flare's goal is to be the only AI assistant you need.** Compatible with OpenAI / DeepSeek and more LLMs.

> 🧠 **Built by AI** — This project was developed by AI agents (Hermes Agent by Nous Research) under human guidance, and continuously evolves through Flare's own iteration.

### Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Install locally (project dir separated from install dir)
bash scripts/install.sh

# Interactive mode
flare

# Single query
flare chat -q "Write a FastAPI service for me"
```

### Architecture

```
src/
├── cli/          # CLI entry & commands (interactive + single query)
├── core/
│   ├── agent.ts  # Agent loop: system prompt → LLM → tools → feedback → continue
│   ├── config.ts # Configuration: read from .env and environment variables
│   └── llm.ts    # LLM abstraction: OpenAI / DeepSeek / compatible APIs
├── tools/
│   └── index.ts  # Tool system: read_file / write_file / search_files / terminal
├── memory/
│   └── store.ts  # Memory system: SQLite + FTS5 full-text search
└── skills/       # Skill system (reserved)
```

### Core Capabilities

#### 🤖 Agent Loop

```
User Input
    ↓
Load Memories + Session History
    ↓
Call LLM (Function Calling)
    ├──→ Tool call detected → Execute tool → Feedback → Continue
    └──→ No tool call → Generate response → Output
    ↓
Save to Memory Database
```

#### 🛠️ Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `read_file` | Read file contents with line numbers | path, offset?, limit? |
| `write_file` | Write / overwrite files | path, content |
| `search_files` | Search files by content or name | pattern, path?, maxResults? |
| `terminal` | Execute terminal commands | command, timeout? |

#### 🧠 Memory System

SQLite-based persistent memory with:

- **Session management**: Multi-session isolation, auto-save conversation history
- **Full-text search**: FTS5 engine for efficient history retrieval
- **Persistent memory**: Cross-session user preferences and context

### Installation Architecture

Flare uses a **project/install directory separation** pattern:

```
~/flaregarden/flare/          # 📁 Project code (TypeScript source)
    ├── src/                  # Source code
    ├── package.json
    └── scripts/install.sh    # Install script

~/.flare/install/             # 📁 Install directory (build artifacts)
    ├── dist/                 # Compiled JS
    ├── bin/flare             # Entry point
    └── node_modules/

~/.flare/                     # 📁 Data directory (runtime data)
    ├── .env                  # Sensitive config like API Keys
    └── flare.db              # Memory database
```

**Iteration workflow:**

```bash
# 1. Modify source code
# 2. Build
npm run build
# 3. Install locally
bash scripts/install.sh
# 4. Verify
flare chat -q "Hello"
```

### Configuration

Copy `.env.example` to `.env` and fill in your API Key:

```bash
cp .env.example ~/.flare/.env
```

| Config | Description | Default |
|--------|-------------|---------|
| `DEEPSEEK_API_KEY` | DeepSeek API key | — |
| `OPENAI_API_KEY` | OpenAI API key | — |
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `DEFAULT_MODEL` | Default model | `deepseek-chat` |
| `OPENAI_BASE_URL` | Custom API endpoint | Auto-detect |
| `LLM_BASE_URL` | Main model API endpoint override (auto-detect: deepseek/gpt/local Ollama) | Auto-detect |
| `LLM_API_KEY` | Main model API key override | Auto-detect |
| `FLARE_HOME` | Data directory | `~/.flare` |

### CLI Commands

| Command | Description |
|---------|-------------|
| `flare` | Interactive mode (default) |
| `flare chat` | Interactive mode |
| `flare chat -q "question"` | Single query mode |

Interactive mode commands:

| Command | Function |
|---------|----------|
| `/help` | Show help |
| `/memory` | View persistent memories |
| `/sessions` | View recent sessions |
| `/clear` | Clear screen |
| `/exit` | Exit |

### Changelog / Release Notes

> 中文条目 / Chinese entries · English summary for each version

#### v0.5.2 (2026-08-09) — 多模型 provider 增强：本地 Ollama 主模型 / Multi-model provider (local Ollama main model)
- 🧭 **模型路由（LLM 模型自动检测）**：模型名含 `:`（Ollama 命名，如 `qwen2.5:7b`/`llama3.1:8b`/`deepseek-r1:7b`）自动走本地 Ollama（`http://localhost:11434/v1`，apiKey `ollama`）——文本对话也可 0 成本/隐私/离线跑本地模型；deepseek/gpt 自动检测保持；claude 明确报错保持；新增 `LLM_BASE_URL` / `LLM_API_KEY` 通用覆盖；`createProvider({ model })` 支持指定主模型
- 🔄 **CLI `/model` 命令**：运行时切换主模型（`/model qwen2.5:7b` 本地 Ollama / `/model deepseek-chat` 远端 / `/model` 查看 / `/model default` 回默认），持久化 settings 表，切换后自动重建会话使新模型立即生效；单次查询同样生效
- 🧪 新增 19 项测试（模型路由 13 + /model 命令 6），共 100/100
- EN: Multi-model provider — auto-route Ollama local models (name with `:`), LLM_BASE_URL/LLM_API_KEY overrides, CLI /model runtime switch persisted in settings. 100/100 tests.

#### v0.5.1 (2026-08-09) — 记忆检索增强（RAG）/ Memory retrieval (RAG)
- 🧠 **memories_fts trigram 全文检索**：`MemoryStore.searchMemories(query)` 中文 3 字以上子串匹配 + bm25 相关度排序（默认 unicode61 tokenizer 中文检索差，trigram 解决）；`getRelevantMemories` 同步升级；老库自动回填索引
- 💬 **历史消息检索**：新增 `messages_fts_trigram`（不动老表）+ `searchMessages(keyword)` 按主题找回旧对话（含 sessionId/role/时间）
- 🔎 **memory_search 工具**：AI 可主动检索记忆与历史消息（`createMemorySearchTool(store)` 宿主可绑定独立库，如 `~/.pulse/pulse-ai.db`）；已加入内置工具集，CLI 默认可用
- 🧪 新增 19 项测试（FTS 检索/排序/2 字回退/触发器/老库回填/工具），共 79/79
- EN: Memory retrieval (RAG) — trigram FTS for Chinese, memories + messages search, memory_search tool. 79/79 tests.

#### v0.5.0 (2026-08-02) — 写作工具集 + StorySpire 专家模板（M4）/ Writing tools + StorySpire expert profile (M4)
- ✨ **写作工具集 `src/tools/story.ts`**：5 个标准写作工具定义（story_get_story / story_get_chapter / story_list_chapters / story_create_chapter / story_update_chapter），宿主应用注入执行器对接真实数据（同 Pulse pulse_* 模式）
- 🧑‍🏫 **写作专家模板 `examples/storyspire/expert.ts`**：品牌话术"我是 story 助手，是集成到 storyspire 里的 flare 写作专家" + 写作提示词（起草/续写/润色/大纲）
- 📚 **集成指南 `docs/storyspire-integration.md`**：主进程接入、工具注入、IPC 桥、key 安全
- 🧪 新增 11 项测试（工具 schema/品牌话术/占位执行器），共 49/49
- EN: Writing toolset (story_*) + StorySpire expert profile template. 49/49 tests.

#### v0.4.3 (2026-08-02) — 修复图片识别粘连 + 回答消失 / Fixed path detection + answer persistence
- 🐛 **parseAttachments 支持粘连中文/标点的路径**：`识别这张图：/home/...png`（无空格）之前整句被当 token 验证失败 → 消息误走 DeepSeek 文本（它只能装 OCR 硬啃）。现在提取路径部分（从 ~/、./、../、/ 起点截取）验证存在性，识别成功且保留前缀提示文本
- 🐛 **Agent 回答不再消失**：运行结束后 renderFrame 清掉输出区只留输入行（回答随重绘消失）。现在回答保留在屏幕，输入行动态定位到回答下方
- 🧪 新增 2 项测试（粘连路径识别/前缀保留），共 38/38
- EN: Path detection now handles Chinese/punctuation-adjacent paths (no space needed). Agent answers persist on screen after completion instead of vanishing on redraw. 38/38 tests.

#### v0.4.2 (2026-08-02) — 看图提速：默认 3B + /vision 切换 / Faster vision: 3B default + /vision switch
- ⚡ 看图默认模型改为 **qwen2.5vl:3b**：模型加载后单张 ~4 秒（7B 是 30-60 秒），日常 OCR/截图流畅
- 🔀 新增 `/vision` 命令：`/vision 3b|fast`（快速）/ `/vision 7b|quality`（质量）/ `/vision default`（回 .env 默认）；切换持久化到 settings 表，无需改 .env 重启
- 🗄️ MemoryStore 新增 settings 表（key-value getSetting/setSetting）
- EN: Default vision model now 3B (~4s/image after load vs 7B's 30-60s). New /vision command switches fast/quality modes at runtime, persisted in DB.

#### v0.4.1 (2026-08-02) — 修复 fcitx5 中文输入消息丢失 / Fixed IME input loss
- 🐛 LineInput Enter 延迟 200ms 提交（IME 防抖）：fcitx5 确认候选的 Enter 不再抢先提交半截内容；pending 期间有字符到达自动续等；连按两次 Enter 立即提交
- 🐛 parseAttachments 引号/裸路径只在文件真实存在时剥离（避免 `"hello.png"` 这类文本被误吞）
- 🧪 新增防误吞测试（36/36）
- EN: Fixed Chinese IME input loss (fcitx5) — Enter debounce before submit. Quoted non-existent paths no longer stripped. 36/36 tests.

#### v0.4.0 (2026-08-02) — 本地视觉能力 / Local vision (VLM)
- 👁️ **多模态支持**：`Message.content` 支持 `string | ContentPart[]`（text + image_url），OpenAI 兼容格式
- 🖼️ **自动识别图片**：对话中直接发图片路径（`看看这张图 xxx.png`）自动附加并切换本地视觉模型；支持 `~` 展开、引号路径（含空格）、data URL（未来 GUI 贴截图）
- 🧠 **视觉 / 文本双模型**：普通对话走默认模型（DeepSeek），看图自动走本地 VLM（`VISION_MODEL`/`VISION_BASE_URL`/`VISION_API_KEY` 配置，默认 qwen2.5vl:7b @ localhost:11434），图片不出本机
- ⌨️ 新命令 `/image <路径> <问题>`（显式看图）+ `chat -q -i <图片>`（单次模式带图）
- 🗄️ 会话存储兼容：多模态 content 序列化存取，图片数据不落库（`[图片]` 占位，防 SQLite 膨胀）
- 🧪 新增视觉单测 16 项（parseAttachments 自动识别 / buildImageContent / 序列化往返），共 35/35
- ⚠️ 已知：Ollama qwen2.5vl 不支持 function calling——看图时纯对话（不传 tools）
- EN: Local vision support — auto-detect image paths in chat, route to local VLM (qwen2.5vl:7b via Ollama), multimodal message type, /image command, image data not persisted. 35/35 tests.

#### v0.3.0 (2026-08-01) — 引擎库化 + 专家模式 / Engine as a library + Expert Profile
- 📦 **M1 flare-core 抽离**：新增库入口 `src/index.ts`，导出 `Agent` / `createProvider` / `Tool` / `MemoryStore` / `ExpertProfile`；package.json exports（`.` 与 `./core` 指向引擎，`./cli` 保留 CLI）；CLI 变第一个消费者
- 🧩 **M2 Expert Profile 机制**：`Agent` 支持注入工具集（`tools`）、独立记忆库（`storage`）、身份话术（`identity` / `flareIntro` 品牌共生）；工具可单独 import（read/write/search/terminal）
- 🧪 新增专家模式单测 4 项（工具注入 / 内置缺省 / 身份话术 / 存储隔离），共 14/14
- ✅ 外部项目验证：`import { Agent } from 'flare-agent'` 编译 + 运行通过
- EN: Engine extracted as importable library (@flare/core) with Expert Profile mechanism — tool injection, isolated storage, brand identity. 14/14 tests.

#### v0.2.20 (2026-08-01) — 常驻火焰动画（方案A定稿）/ Persistent flame animation
- 🔥 常驻渲染循环：火焰永久跳动，动画期间可正常打字输入（帧模式 LineInput）
- 🎨 方案 A 融合版定稿：逐字符渐变（相邻字母不同色）+ 整体 sin 呼吸（5s 周期，安静起伏）
- 📐 布局：顶部空行 + FLARE + 标语 + 提示语固定 + prompt 呼吸色
- 🏷️ tag v0.2.20 = fa4a853（最终版）；中间迭代（粒子/常驻/方案A/流动渐变）保留在历史
- EN: Persistent flame animation — breathing gradient (final plan A), typing works during animation. Tagged v0.2.20.

#### v0.2.19 (2026-08-01) — 火焰粒子动画启动画面 / Flame particle animation
- 🔥 启动画面：粒子火焰 + 整体呼吸动画（火苗与文字重叠燃烧，约 5 秒）
- 🎨 视觉令牌抽离（FLAME_TOKENS：色阶/渐变/动画参数），CLI 与未来桌面/嵌入版多端复用
- 📄 flame-banner.ts 模块化：静态招牌 + 动画分离；非 TTY / 窄终端自动降级静态
- 🏷️ tag v0.2.19 = a48e400（粒子动画里程碑）

#### v0.2.18 (2026-08-01) — 方向键移动光标 / Arrow key cursor movement
- 🎯 LineInput 支持 ←/→ 光标移动（中文/emoji 按字移动）、↑/↓ 历史记录、中间插入、退格删光标前
- EN: Arrow keys move cursor; up/down browse history; ANSI absolute positioning

#### v0.2.17 (2026-08-01) — 修复方向键输入乱码 / Fixed arrow key gibberish
- 🐛 方向键转义序列被拆成字符输入（出现 [D 乱码），改为整体识别忽略
- EN: Arrow key escape sequences were split into characters; now skipped as a whole

#### v0.2.16 (2026-08-01) — 英文 README 补 Built by AI / Built by AI note in EN README
- 📝 英文 README 补上"Built by AI"说明（与中文对应）
- EN: Added "Built by AI" note to the English README

#### v0.2.15 (2026-08-01) — Changelog 双语化 / Bilingual changelog
- 📝 Changelog 每个版本标题双语 + 英文概要，补齐 v0.2.5~v0.2.14
- EN: Bilingual changelog with English summary per version

#### v0.2.14 (2026-08-01) — README 定位文案更新 / Updated README positioning
- 📝 中文定位改为"flare 的目标是成为你唯一需要的 AI 助理"
- EN: Tagline updated to "flare's goal is to be the only AI assistant you need"

#### v0.2.13 (2026-08-01) — 修复两个 bug / Fixed two bugs
- 🐛 修复 `/remember` 命令永远"未知命令"（switch 精确匹配 bug，改为前缀匹配）
- 🐛 修复非 TTY 启动交互模式崩溃（友好提示退出）
- EN: Fixed `/remember` command never matching; fixed crash when stdin is not a TTY

#### v0.2.12 (2026-08-01) — /sessions 人类可读化 / Human-readable sessions
- ✨ 会话标题改为第一条用户消息，时间友好化（今天 HH:MM / 昨天 / M月D日）
- EN: Session list now shows first user message as title with friendly timestamps

#### v0.2.11 (2026-08-01) — 修复多轮会话 prompt 重复 / Fixed duplicate prompt
- 🐛 resume() 和 readLine() 都画 prompt，一轮后出现两个 `🔥 flare>`；统一由 readLine() 绘制
- EN: Fixed double prompt after each turn (resume no longer draws prompt)

#### v0.2.10 (2026-07-31) — 提示语布局 / Hint layout
- ✨ 提示语与标语隔一行、与 prompt 紧邻
- EN: Blank line between hint and tagline; prompt sits right below hint

#### v0.2.9 (2026-07-31) — FLARE 与标语间空行 / Blank line in banner
- ✨ Banner 两行内容之间加空行
- EN: Added blank line between FLARE and the tagline

#### v0.2.8 (2026-07-31) — Banner 上方空行 / Blank line above banner
- ✨ 启动时 Banner 上方留一行空格
- EN: Added blank line above the banner

#### v0.2.7 (2026-07-31) — Banner 去边框 / Borderless banner
- 🎨 移除边框，纯渐变文字；"再见！✨"改为火焰亮黄
- EN: Removed banner border; farewell message now flame yellow

#### v0.2.6 (2026-07-31) — 逐字符火焰渐变 / Per-character flame gradient
- 🎨 Banner 每个字母独立渐变（红→橙→黄），上下边框渐变，标语加火把 🔥
- EN: Every letter in the banner has its own flame gradient; torch emoji added

#### v0.2.5 (2026-07-31) — 火焰色系全面换装 / Flame color scheme
- 🔥 Banner/prompt/草稿/工具/答卷分隔线全部改为红橙黄火焰色系
- EN: Full flame color scheme (red-orange-yellow) across CLI UI

#### v0.2.4 (2026-07-31) — 根治长输入折行重复 / Fixed long-input duplication

- 🎯 **弃用 Node readline，自研输入行（line-input.ts）**：readline 对中文/emoji 的宽度计算不可靠（ANSI 码算进长度、中文按 1 列算），折行重绘时清行不干净导致文字重复
- ✅ 输入时逐字符 echo，终端自然折行（宽度由终端计算，永远正确）
- ✅ 退格重绘用正确的 wcwidth（中文/emoji 算 2 列，ANSI 剥离），基于退格前宽度上移清除
- ✅ 已用 pyte 终端模拟器验证：长输入、退格、跨行删除三种场景最终显示均无重复
- EN: Replaced buggy Node readline with a custom input line; verified with pyte terminal emulator

#### v0.2.3 (2026-07-31) — 答卷分隔线亮紫色 / Purple answer separator

- 🎨 答卷分隔线从暗灰色改为亮紫色 `#6d4aff`（品牌色）
- EN: Answer separator changed to brand purple #6d4aff

#### v0.2.2 (2026-07-31) — 终端视觉分层 / Visual layering

- 🎨 **草稿/答卷视觉分层**：工具调用过程用灰色边框弱化（`🔧` 黄色 + `┌─│└─` 边框 + `💭` 灰色草稿），最终答案用分隔线框出、正常颜色突出
- 🐛 **read_file / write_file / search_files 支持 `~` 展开**（之前只有 terminal 支持）
- EN: Draft/answer visual layering; ~ expansion for all file tools

#### v0.2.1 (2026-07-31) — AI 记忆隔离修复 / AI memory isolation

- 🐛 **修复 Flare 误读其他 AI 记忆**：search_files 跳过 `~/.hermes`、`~/.agents`、`~/.codebuddy`、`~/.claude` 等目录
- 🧠 **系统提示明确记忆边界**：Flare 的记忆在 `~/.flare/flare.db`，禁止读取其他 AI 的记忆文件
- EN: search_files skips other AI tools' dirs; system prompt defines memory boundary

#### v0.2.0 (2026-07-31) — 安全与健壮性大版本 / Security & robustness

- 🔒 **危险命令黑名单**：拦截 `rm -rf /`、fork bomb、`curl|bash`、格式化磁盘等毁灭性命令
- 🔒 **文件路径保护**：拒绝写入 `/etc/`、`.ssh/`、`.git/` 等系统关键位置
- 🛡️ **工具参数 JSON.parse 保护**：LLM 返回非法 JSON 不再崩溃，错误喂回给 LLM 修正
- 🧠 **记忆写入**：新增 `/remember` 命令，记忆系统可写可读
- 📊 **Token 用量追踪**：新增 `/usage` 命令，记录每次 LLM 调用的 token 消耗
- 🔁 **API 重试**：网络抖动/限流自动重试（3次，指数退避）
- 🖥️ **平台兼容**：Windows 跳过 stty；Agent 崩溃也保证恢复终端（try/finally）
- 📁 **原子写入**：write_file 先写临时文件再 rename，不损坏原文件
- 🔍 **搜索优化**：大文件只匹配文件名，跳过 node_modules/.git/dist
- 🧪 **单元测试**：10 个测试覆盖 store/agent 核心逻辑
- 🐛 修复 joinPath（用 path.join）、claude 模型检测、DEBUG 日志、--max-iterations 参数
- EN: Dangerous command blacklist, path protection, /remember memory, /usage tokens, API retry, atomic writes, 10 unit tests

#### v0.1.2 (2026-07-31) — Agent 健壮性修复 / Agent robustness fixes

- 🐛 **修复 Agent 迭代限制过紧**：迭代上限从 10 提升到 30（上限 50，与 Hermes 对齐），复杂任务（读文档→改代码→推送）不再中途停止
- 🐛 **改进死循环检测**：从"连续 5 次无文本输出即停止"改为"同一工具同参数重复 4 次才停止"，探索型任务（连续读文件收集信息）不再被误杀
- 🐛 **修复终端回显重复**：isRunning + `rl.pause()` + `stty -echo` 真正落地，长输入换行不再文字重复
- 🐛 **修复 `~` 展开**：terminal 工具改用 bash 执行，`cd ~/xxx` 不再失败
- 🐛 **修复会话历史 tool_calls 配对丢失**：messages 表新增 `tool_call_id`/`name` 列 + 老库自动迁移，多轮对话不再报 400 错误
- 🐛 **修复 .env 加载优先级**：`~/.flare/.env` 优先，本地 `.env` 不覆盖已有配置
- ✨ **上下文保留提升**：trimContext 保留 12 → 30 条消息，覆盖更长工具调用链
- EN: Iteration limit 10→30, smarter loop detection, tool_call pairing fix, .env priority fix

#### v0.1.1 (2026-07-30) — 回显修复 / Echo fix

- 🐛 修复 CLI 交互模式输入重复回显问题（Agent 运行时暂停输入监听）
- EN: Fixed duplicated echo while Agent is running

#### v0.1.0 (2026-07-30) — 初次发布 / Initial release

- 🎉 初次发布：CLI 交互/单次查询、Agent 循环、LLM 抽象、工具系统、SQLite 记忆
- EN: Initial release: CLI interactive/single query, Agent loop, LLM abstraction, tools, SQLite memory

### License

MIT
