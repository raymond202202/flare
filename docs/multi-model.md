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

### 3. CLI 单次命令查看（flare models，v0.6.0 / v0.6.112 --json）

宿主/脚本场景（非交互终端）的模型查看入口——与 server 协议 `models`（v0.6.9）对称：

```bash
flare models               # 配置的主/视觉模型 + 本地 Ollama 已拉取模型清单
flare models --json        # 结构化输出（v0.6.112：{ configured, ollama } 与 server models 回包同构）
```

- 输出：`configured.main` 当前主模型（含解析端点 / hasApiKey 密钥是否配置 / provider 推断）、
  `configured.vision` 视觉模型（未配置 null）、`ollama` 本地 Ollama 已拉取模型列表（模型名 + 大小）
- Ollama 未启动/不可达 → 友好提示不崩（`ollama.ok:false`），其余字段照常
- 纯只读：不切换模型、不创建会话；切换请用交互模式 `/model`（见上节）

### 4. 代码里指定（宿主集成）

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

| | 主模型（文本对话） | 视觉模型（看图） | 本地路由模型（简单任务，v0.6.134） |
|---|---|---|---|
| 配置 | `DEFAULT_MODEL` + `LLM_*`（可选） | `VISION_MODEL` + `VISION_BASE_URL` + `VISION_API_KEY` | `LOCAL_MODEL` + `LOCAL_BASE_URL` + `LOCAL_API_KEY`（可选） |
| 切换 | `/model`（settings `main_model`） | `/vision`（settings `vision_model`） | 改 `.env` 的 `LOCAL_MODEL` |
| 默认 | deepseek-chat（远端） | qwen2.5vl:3b（本地 Ollama） | 未配置（不启用混合路由） |

三者独立：看图自动走视觉模型（本地 VLM），普通对话走主模型；`/model` 只影响主模型。

## 混合模式：本地小模型路由（v0.6.134）

**背景**：用户机器 64GB 内存 + 4GB 显存，已装 Ollama（qwen2.5:7b 等）。混合模式 = 简单任务走本地小模型
（省钱/隐私/离线），复杂任务走线上主模型（保质量）。**路由是外围增强，不改 Agent.run 核心循环**——
编排循环不能被小模型替代（丢指令/工具调用失败），路由决策由宿主/CLI 在调用 provider 前按需使用。

### 配置（~/.flare/.env）

```bash
LOCAL_MODEL=qwen2.5:7b        # 本地路由模型（Ollama 命名，含 ':' 自动走本地端点）
# LOCAL_BASE_URL=http://localhost:11434/v1   # 可选：覆盖默认 Ollama 端点
# LOCAL_API_KEY=ollama                        # 可选：覆盖默认 apiKey
```

### 路由规则（src/core/routing.ts，规则/启发式，零网络、零 LLM 调用）

`classifyTaskComplexity(text)` 按优先级判断：

| 优先级 | 特征 | 结论 |
|---|---|---|
| 1 | 代码特征（``` / function / import / 花括号等） | complex（长代码/代码任务） |
| 2 | 复杂特征词（分析/推理/为什么/对比/设计/创作/算法等） | complex |
| 3 | 长文本（> 300 字符） | complex（需上下文理解/推理） |
| 4 | 简单特征词（分类/抽取/摘要/翻译/格式化等） | simple |
| 5 | 默认短文本无特征 | simple（简单问答/闲聊） |

`routeTaskModel(text)` → 决策结果：simple → 本地路由模型（`LOCAL_MODEL`）；complex → 主模型（`DEFAULT_MODEL`）。
未配置 `LOCAL_MODEL` 时 simple 回退主模型并注明（不报错）。

### 查询面

- `flare models` 文本模式：`本地路由: <模型> → <端点>`（未配置给提示）
- `flare models --json`：`configured.local` 字段（ModelEndpointInfo 同款；未配置 `null`，与 server models 回包同构）
- server 协议 `models` 响应：`configured.local`（v0.6.134）

### 宿主集成（代码里）

```ts
import { classifyTaskComplexity, routeTaskModel } from 'flare-agent'

const r = routeTaskModel('把这句话翻译成英文：你好')
// → { tier: 'simple', model: 'qwen2.5:7b', provider: 'ollama', reason: '简单任务 → 本地模型（省钱/隐私/离线）' }
// 按 r.model 创建 provider 即可（createProvider({ model: r.model })）
```

## 常见问题

- **Ollama 没启动**：`/model qwen2.5:7b` 后对话报连接错误 → 先 `ollama serve` 并 `ollama pull qwen2.5:7b`
- **模型未下载**：Ollama 首次调用会自动拉取，较慢属正常
- **本地模型不支持 function calling**：部分 Ollama 模型（如 qwen2.5vl）不支持工具调用——看图时纯对话不传 tools（引擎已处理）；如需工具能力请用支持 function calling 的模型（如 qwen2.5:7b 非 vl 版）
