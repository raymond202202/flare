# Flare 🔥

> **Let your inspiration flare** — 让你的灵感燃起来。
>
> 🧠 **由 AI 构建** — 本项目由 AI 智能体（Hermes Agent by Nous Research）在人类指导下开发，并由 Flare 自身持续迭代进化。

**Flare 是一个通用能力的 AI Agent**，从零构建。它不局限于编程——能读文件、写文件、执行命令、搜索、持久记忆，也能被嵌入到其他产品中充当 AI 能力核心（如桌面应用的 AI 面板）。兼容 OpenAI / DeepSeek 等多种 LLM。

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
| `FLARE_HOME` | 数据目录 | `~/.flare` |

### CLI 命令

| 命令 | 说明 |
|------|------|
| `flare` | 交互模式（默认） |
| `flare chat` | 交互模式 |
| `flare chat -q "问题"` | 单次查询模式 |

交互模式命令：

| 命令 | 功能 |
|------|------|
| `/help` | 显示帮助 |
| `/memory` | 查看持久记忆 |
| `/sessions` | 查看最近会话 |
| `/clear` | 清屏 |
| `/exit` | 退出 |

---

---

## English

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

### Changelog / 更新记录

#### v0.2.4 (2026-07-31) — 根治长输入折行重复

- 🎯 **弃用 Node readline，自研输入行（line-input.ts）**：readline 对中文/emoji 的宽度计算不可靠（ANSI 码算进长度、中文按 1 列算），折行重绘时清行不干净导致文字重复
- ✅ 输入时逐字符 echo，终端自然折行（宽度由终端计算，永远正确）
- ✅ 退格重绘用正确的 wcwidth（中文/emoji 算 2 列，ANSI 剥离），基于退格前宽度上移清除
- ✅ 已用 pyte 终端模拟器验证：长输入、退格、跨行删除三种场景最终显示均无重复

#### v0.2.3 (2026-07-31) — 答卷分隔线亮紫色

- 🎨 答卷分隔线从暗灰色改为亮紫色 `#6d4aff`（品牌色）

#### v0.2.2 (2026-07-31) — 终端视觉分层

- 🎨 **草稿/答卷视觉分层**：工具调用过程用灰色边框弱化（`🔧` 黄色 + `┌─│└─` 边框 + `💭` 灰色草稿），最终答案用分隔线框出、正常颜色突出
- 🐛 **read_file / write_file / search_files 支持 `~` 展开**（之前只有 terminal 支持）

#### v0.2.1 (2026-07-31) — AI 记忆隔离修复

- 🐛 **修复 Flare 误读其他 AI 记忆**：search_files 跳过 `~/.hermes`、`~/.agents`、`~/.codebuddy`、`~/.claude` 等目录
- 🧠 **系统提示明确记忆边界**：Flare 的记忆在 `~/.flare/flare.db`，禁止读取其他 AI 的记忆文件

#### v0.2.0 (2026-07-31) — 安全与健壮性大版本

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

#### v0.1.2 (2026-07-31)

- 🐛 **修复 Agent 迭代限制过紧**：迭代上限从 10 提升到 30（上限 50，与 Hermes 对齐），复杂任务（读文档→改代码→推送）不再中途停止
- 🐛 **改进死循环检测**：从"连续 5 次无文本输出即停止"改为"同一工具同参数重复 4 次才停止"，探索型任务（连续读文件收集信息）不再被误杀
- 🐛 **修复终端回显重复**：isRunning + `rl.pause()` + `stty -echo` 真正落地，长输入换行不再文字重复
- 🐛 **修复 `~` 展开**：terminal 工具改用 bash 执行，`cd ~/xxx` 不再失败
- 🐛 **修复会话历史 tool_calls 配对丢失**：messages 表新增 `tool_call_id`/`name` 列 + 老库自动迁移，多轮对话不再报 400 错误
- 🐛 **修复 .env 加载优先级**：`~/.flare/.env` 优先，本地 `.env` 不覆盖已有配置
- ✨ **上下文保留提升**：trimContext 保留 12 → 30 条消息，覆盖更长工具调用链

#### v0.1.1 (2026-07-30)

- 🐛 修复 CLI 交互模式输入重复回显问题（Agent 运行时暂停输入监听）

#### v0.1.0 (2026-07-30)

- 🎉 初次发布：CLI 交互/单次查询、Agent 循环、LLM 抽象、工具系统、SQLite 记忆

### License

MIT
