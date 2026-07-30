# Flare — Your AI Agent, Your Way

灵感如闪光（Flare），转瞬即逝。Flare 帮你抓住它。

一个轻量、干净、全栈可控的 AI Agent，从零构建。

## 快速开始

```bash
# 安装依赖
npm install

# 构建
npm run build

# 开发模式
npm run dev -- chat

# 交互模式
flare

# 单次查询
flare chat -q "帮我写一个 FastAPI 服务"
```

## 架构

```
src/
├── cli/          # CLI 入口和命令
├── core/         # Agent 核心（Agent Loop, LLM 封装）
├── tools/        # 工具系统（文件、终端、搜索等）
├── memory/       # 记忆系统（SQLite 存储、FTS5 搜索）
└── skills/       # 技能系统（Markdown 技能管理）
```
