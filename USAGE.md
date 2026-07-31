# Flare 使用指南

> **灵感如闪光，Flare 帮你抓住它。**
> 一个通用能力的 AI Agent，完全属于你自己的代码。不局限于编程，可完成各种任务，也能嵌入其他产品（如桌面应用的 AI 面板）。

---

## 快速安装

```bash
# 1. 克隆/进入项目
cd ~/hermes-projects/flare

# 2. 安装依赖
npm install

# 3. 配置 API Key（必做）
cp .env.example .env
# 编辑 .env，填入你的 API Key：
#   DEEPSEEK_API_KEY=sk-xxx
#   或
#   OPENAI_API_KEY=sk-xxx

# 4. 构建
npm run build

# 5. 全局安装
sudo npm link

# 6. 试试
flare chat -q "你好"
```

---

## 基本用法

### 交互模式

直接在终端里对话，用 `/help` 查看内部命令：

```bash
flare
```

```
  ╔══════════════════════════════════╗
  ║          ✦  F L A R E  ✦        ║
  ║     Your AI Agent, Your Way      ║
  ╚══════════════════════════════════╝

🔥 flare> 帮我创建一个 Node.js 项目
⚡ Flare 思考中...
...
```

### 单次查询模式

适合脚本调用或快速提问：

```bash
# 直接提问
flare chat -q "帮我写一个排序算法"

# 带文件操作的任务
flare chat -q "阅读 src/app.ts 并帮我重构"
```

### 查看帮助

```bash
flare --help
flare chat --help
```

---

## 交互模式命令

在交互模式中输入 `/` 开头执行特殊命令：

| 命令 | 作用 |
|------|------|
| `/help` | 显示帮助信息 |
| `/exit` 或 `/quit` | 退出 |
| `/memory` | 查看记忆列表 |
| `/sessions` | 查看历史会话 |
| `/clear` | 清屏 |

---

## 工具能力

Flare 能在对话中自动调用以下工具：

| 工具 | 作用 | 示例场景 |
|------|------|---------|
| **read_file** | 读取文件内容（带行号） | 查看代码、配置文件 |
| **write_file** | 写入/覆盖文件 | 创建新文件、修改代码 |
| **search_files** | 搜索文件内容和文件名 | 定位代码、找引用 |
| **terminal** | 执行终端命令 | 运行代码、安装依赖、Git 操作 |

Flare 会根据你的需求，自动判断调用哪个工具、怎么调用。

---

## 配置说明

### 环境变量（.env）

| 变量 | 说明 | 示例 |
|------|------|------|
| `OPENAI_API_KEY` | OpenAI API Key | `sk-xxxx` |
| `ANTHROPIC_API_KEY` | Anthropic API Key | `sk-ant-xxxx` |
| `DEEPSEEK_API_KEY` | DeepSeek API Key | `sk-xxxx` |
| `DEFAULT_MODEL` | 默认模型 | `deepseek-chat` / `gpt-4o` / `claude-sonnet-4` |
| `OPENAI_BASE_URL` | 自定义 API 地址 | `https://api.openai.com/v1` |
| `FLARE_HOME` | 数据目录（默认 ~/.flare） | `~/.flare` |

### 支持的模型

Flare 自动适配 API 地址：

- **DeepSeek** — 设为 `DEFAULT_MODEL=deepseek-chat`，自动使用 `api.deepseek.com`
- **OpenAI** — 设为 `DEFAULT_MODEL=gpt-4o`，自动使用 `api.openai.com`
- **OpenRouter** — 设置 `OPENAI_BASE_URL=https://openrouter.ai/api/v1`，用 OpenRouter API Key
- **其他兼容 API** — 设置 `OPENAI_BASE_URL` 即可

---

## 数据存储

Flare 的数据存储在 `~/.flare/` 目录下：

```
~/.flare/
├── flare.db     # SQLite 数据库（会话、消息、记忆）
└── .env         # 可选的环境变量（优先级低于项目 .env）
```

### 记忆系统

Flare 会记住你的会话历史和关键信息：

- **会话历史**：每次对话自动保存，可回溯
- **持久记忆**：未来会支持用户显式保存关键信息

---

## 开发相关

```bash
# 构建
npm run build

# 开发模式（tsx 热加载）
npm run dev -- chat -q "你好"

# 运行测试
npm test

# 查看项目结构
ls src/
  cli/        # CLI 入口
  core/       # Agent 核心（Agent Loop, LLM 封装, 配置）
  tools/      # 工具系统
  memory/     # 记忆系统
```

---

## 项目结构

```
flare/
├── bin/flare           # 全局命令入口
├── src/
│   ├── cli/index.ts    # CLI 命令定义（commander）
│   ├── core/
│   │   ├── agent.ts    # Agent 推理循环
│   │   ├── config.ts   # 配置管理
│   │   └── llm.ts      # LLM 提供者抽象
│   ├── tools/
│   │   └── index.ts    # 工具定义和实现
│   └── memory/
│       └── store.ts    # SQLite 记忆存储
├── dist/               # 编译输出
├── .env                # API Key 配置（请勿提交 Git）
├── .env.example        # 配置模板
└── package.json
```

---

## FAQ

### Q: Flare 和 Hermes 有什么区别？
**A**: Flare 是从零写的 TypeScript 项目，更轻量、架构更干净。Hermes 是 Nous Research 的大型 Python 项目（55MB+），功能更多但也更重。

### Q: 怎么换模型？
**A**: 编辑 `.env` 修改 `DEFAULT_MODEL` 和对应的 `API_KEY`，立即生效。

### Q: 数据存在哪里？安全吗？
**A**: 存在本地 `~/.flare/flare.db`，全是本地文件，不上传任何地方。

### Q: 能加自定义工具吗？
**A**: 可以。编辑 `src/tools/index.ts`，按现有的工具模板添加即可。

### Q: 怎么卸载？
**A**: `sudo npm unlink -g flare-agent`，删除项目目录即可。
