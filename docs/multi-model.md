# Flare 多模型指南（v0.5.2）

> Flare 通过 OpenAI 兼容 API 调用模型，支持**远端模型**（DeepSeek / OpenAI / 任意兼容 API）与**本地模型**（Ollama，0 成本 / 隐私 / 离线）。
> 核心：`resolveProviderOptions` 模型路由（src/core/llm.ts）——按模型名自动推导端点和密钥，无需手配 URL。

## 模型路由规则（优先级从高到低）

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | 显式传参 `createProvider({ model, baseURL, apiKey })` | 完全指定，跳过自动检测 |
| 2 | `LLM_BASE_URL` / `LLM_API_KEY` | 主模型通用覆盖（~/.flare/.env） |
| 3 | `OPENAI_BASE_URL`（旧配置） | 兼容保留 |
| 4 | 按模型名自动检测 | 见下表 |

| 模型名 | 端点 | 密钥 |
|--------|------|------|
| 含 `:`（Ollama 命名，如 `qwen2.5:7b` / `llama3.1:8b` / `deepseek-r1:7b`） | `http://localhost:11434/v1`（本地） | `ollama` |
| 含 `deepseek`（如 `deepseek-chat`） | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| 含 `gpt` / `o1` / `o3` / `chatgpt` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| 含 `claude` | ❌ 明确报错（Anthropic 原生 API 非 OpenAI 兼容格式） | — |
| 其他（无冒号） | 回退 `https://api.openai.com/v1`（兼容旧行为） | `OPENAI_API_KEY` |

> 冒号优先：Ollama 上的 deepseek（`deepseek-r1:7b`）会正确走本地，不会误连远端 DeepSeek。

## 三种用法

### 1. 改 .env 默认模型（全局生效）

```bash
# ~/.flare/.env
DEFAULT_MODEL=qwen2.5:7b        # 本地 Ollama（自动走 localhost:11434/v1）
# DEFAULT_MODEL=deepseek-chat    # 远端 DeepSeek（默认）
```

### 2. CLI 运行时切换（/model，持久化）

```bash
flare
🔥 flare> /model qwen2.5:7b     # 切本地 Ollama（含冒号自动识别，立即生效）
🔥 flare> /model deepseek-chat  # 切远端 DeepSeek
🔥 flare> /model                # 查看当前主模型
🔥 flare> /model default        # 回 .env 的 DEFAULT_MODEL
```

- 切换写入 settings 表（`main_model`），下次启动仍生效
- 切换后自动重建当前会话（历史从记忆库恢复），无需重启
- 单次查询（`flare chat -q "..."`）同样尊重保存的模型

### 3. 代码里指定（宿主集成）

```ts
import { createProvider, Agent } from 'flare-agent'

// 指定本地模型
const agent = new Agent({
  sessionId: 's1',
  llm: createProvider({ model: 'qwen2.5:7b' }),
})

// 指定远端模型
const agent2 = new Agent({
  sessionId: 's2',
  llm: createProvider({ model: 'deepseek-chat' }),
})
```

## 与视觉模型的关系

| | 主模型（文本对话） | 视觉模型（看图） |
|---|---|---|
| 配置 | `DEFAULT_MODEL` + `LLM_*`（可选） | `VISION_MODEL` + `VISION_BASE_URL` + `VISION_API_KEY` |
| 切换 | `/model`（settings `main_model`） | `/vision`（settings `vision_model`） |
| 默认 | deepseek-chat（远端） | qwen2.5vl:3b（本地 Ollama） |

两者独立：看图自动走视觉模型（本地 VLM），普通对话走主模型；`/model` 只影响主模型。

## 常见问题

- **Ollama 没启动**：`/model qwen2.5:7b` 后对话报连接错误 → 先 `ollama serve` 并 `ollama pull qwen2.5:7b`
- **模型未下载**：Ollama 首次调用会自动拉取，较慢属正常
- **本地模型不支持 function calling**：部分 Ollama 模型（如 qwen2.5vl）不支持工具调用——看图时纯对话不传 tools（引擎已处理）；如需工具能力请用支持 function calling 的模型（如 qwen2.5:7b 非 vl 版）
