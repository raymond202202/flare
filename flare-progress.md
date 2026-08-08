# flare 夜间调研迭代进度

> 目标：调研 flare 引擎下一步迭代方向并推进（M4 已完成 = StorySpire 集成 + withConfirmation + 宿主协议；第一轮夜间已完成 RAG 里程碑 R0-R6）
> 铁律：**flare 是引擎，Pulse/StorySpire（Electron 版）当前都依赖它**——任何改动必须 tsc 0 错 + 全部测试通过才 commit
> 规则：每轮实现后 `npx tsc` 0 错 + `PATH=/usr/bin:$PATH npx vitest run` 全绿 + git commit（本地，**禁止 git push**）；每轮结束更新本文件

## 调研结论（2026-08-09 第二轮夜间）

### 现状盘点（读完 roadmap + README + docs/ + src/ + tests/，基线实测）

- **第一轮夜间已完成 RAG 里程碑（R0-R6）**：memories_fts trigram 全文检索 + searchMemories / searchMessages + memory_search 工具 + server ping / get_messages + 文档 v0.5.1
- **测试基线实测 81 项全绿**（9 个文件）：agent 4 / confirm 5 / expert 4 / memory-tool 8 / network 5 / server 8 / store 17 / story 11 / vision 19；`npx tsc` 0 错误
- **LLM 层现状（src/core/llm.ts）**：`OpenAIProvider` 支持 `{ model, baseURL, apiKey }` 选项；baseURL 自动检测只覆盖 deepseek / gpt（claude 明确报错）；**无 Ollama 主模型路径**（模型名含 `:` 如 `qwen2.5:7b` 时 baseURL 为空 → 静默走 openai.com 会 401）
- **视觉已有多模型模式可复用**：`VISION_*` 配置 + `createVisionProvider()` 走本地 Ollama + CLI `/vision` 运行时切换 + settings 表持久化（`vision_model`）——主模型切换可完全复用这套模式
- **CLI 现状**：交互模式 `new Agent({ sessionId })`（不传 llm → 默认 createProvider()，**无法切主模型**）；`AgentConfig.model` 字段存在但 Agent 构造未使用（不打算改 agent.ts，走 CLI 注入 llm provider 方案）
- **服务器现状**：chat/cancel/set_context/list_sessions/get_messages/ping/tool_result 已完整；无模型选择字段
- **环境事实**：本机已有本地 Ollama（视觉默认 localhost:11434）；persona 也在用本地 Qwen2.5-7B——本地主模型切换有真实使用场景（0 成本/隐私/离线）

### 方向选择：✅ **多模型 provider 增强（本地 Ollama 主模型切换 + 模型路由）**（本轮选定）

| 候选方向 | 评估 | 结论 |
|---------|------|------|
| **多模型 provider 增强（Ollama 主模型切换）** | 视觉已证明 Ollama 路径可行（/vision + settings 模式直接复用）；主模型切换价值高（本地 0 成本/隐私/离线，配合本机已有 Ollama）；纯外围改动（llm.ts/config.ts/cli，不碰 Agent.run）；模型路由可做成纯函数单测（无网络） | ✅ 选定 |
| MCP 协议支持 | 工作量大（网络协议 + 依赖），宿主协议刚完成，适合后续大版本规划 | 暂缓 |
| 记忆检索增强（RAG） | 第一轮夜间已完成（trigram FTS + memory_search 工具 + 文档） | ✅ 已完成 |
| 工具确认机制完善 | withConfirmation 已完成（allow_once/session/always/deny/alternative），剩余空间小 | 备选 |
| server 协议完善 | 基本完整；可加 version / delete_session / chat 带 model 小项 | 备选 |
| 上下文与性能优化 | trimContext 已有（30 条 + 配对保护）；token 计数优化会碰 agent.ts，风险高 | 暂缓 |

### 迭代计划（分小步，每步独立验证 commit）

- [x] **P0** 调研：确定方向（多模型 provider 增强）+ 基线实测（tsc 0 错 / 81 全绿）+ 本文件更新
- [x] **P1** LLM 模型路由（llm.ts）：抽出纯函数 `resolveProviderOptions({ model, baseURL, apiKey })`——模型名含 `:`（Ollama 命名如 `qwen2.5:7b`/`llama3.1:8b`）→ 本地 `http://localhost:11434/v1` + apiKey `ollama`；deepseek/gpt 自动检测保持；claude 明确报错保持；新增 `LLM_BASE_URL` / `LLM_API_KEY` 配置覆盖（config.ts + .env.example）；`createProvider(options?)` 支持传参；导出供测试。新增 tests/llm.test.ts（纯函数，无网络）
- [x] **P2** CLI `/model` 命令（cli/index.ts）：`/model` 显示当前主模型、`/model <name>` 切换（写 settings `main_model`）、`/model default` 回默认；切换后重建 Agent（同 sessionId，历史从记忆库恢复）并注入 `llm: createProvider({ model })`；单次查询模式同样读取 `main_model`；`/help` 同步；导出 handleSlashCommand 供单测。附带修复：CLI 入口守卫（作为库 import 不自动启动 main，避免测试触发 commander）
- [ ] **P3** 文档与收尾：README Changelog v0.5.2 + 版本号 + README 配置表（LLM_BASE_URL/LLM_API_KEY/DEFAULT_MODEL 说明）+ docs/ 多模型指南 + 全量回归

> 备选后续方向（记录）：server chat 支持 model 字段（宿主选模型）/ server 协议补充（version/delete_session）/ MCP 协议支持 / 上下文与性能优化（token 计数）

## 历史记录（第一轮夜间：记忆检索增强 RAG 里程碑 R0-R6）

> 方向：✅ 记忆检索增强（RAG）。理由：记忆是引擎核心能力；中文 FTS 短板实测确认（默认 unicode61 整段 CJK 当一个 token）；trigram 路径已验证（better-sqlite3 3.53.4 支持，3 字以上子串匹配正常）；对 Pulse（历史调试结论）/StorySpire（按主题找回章节/设定）价值直接；纯外围改动不碰 Agent.run。

- [x] **R0** 调研：确定 RAG 方向 + 技术验证（trigram）+ 修复 server 测试超时稳定性
- [x] **R1** memories_fts（trigram）+ 触发器 + searchMemories + getRelevantMemories 升级 + 老库回填
- [x] **R2** messages_fts_trigram + searchMessages（历史消息按主题找回）
- [x] **R3** memory_search 工具 + createMemorySearchTool（宿主绑定独立库）
- [x] **R4** README Changelog v0.5.1 + docs/memory-rag.md + 版本号 + 全量回归
- [x] **R5** server 协议补充 ping（宿主健康检查）+ host-protocol.md
- [x] **R6** server 协议补充 get_messages（读取会话历史）+ 测试基础设施修复（响应乱序过滤）

## 迭代记录

| 轮次 | 时间 | 完成 | 构建/测试 | 备注 |
|------|------|------|-----------|------|
| R0-R6 | 2026-08-09 凌晨 | RAG 里程碑（记忆检索增强）+ server ping/get_messages | tsc 0 错 / 81 全绿 | trigram FTS 中文检索 + memory_search 工具 + 宿主协议补充 |
| P0 | 2026-08-09 夜间 | 调研确定方向（多模型 provider 增强：Ollama 主模型切换）+ 基线实测 | tsc 0 错 / 81 全绿 | 复用 /vision + settings 模式；模型路由做成纯函数单测 |
| P1 | 2026-08-09 夜间 | LLM 模型路由：resolveProviderOptions 纯函数（Ollama 冒号检测/LLM_* 覆盖/兼容保留）+ createProvider 支持传参 | tsc 0 错 / 94 全绿 | +13 测试（tests/llm.test.ts，无网络）；.env.example 同步 |
| P2 | 2026-08-09 夜间 | CLI /model 命令（切换/显示/恢复默认，settings 持久化，重建 Agent 生效）+ CLI 入口守卫 | tsc 0 错 / 100 全绿 | +6 测试（tests/model-command.test.ts）；冒烟：--version/server ping 均正常 |

## 命令

```bash
cd ~/hermes-projects/flare
npx tsc                    # 必须 0 错误
PATH=/usr/bin:$PATH npx vitest run   # 必须全绿（当前 81 项）
```

## 铁律

- **禁止 git push**（用户明早验收后才决定推 GitHub）
- **禁止修改 src/core/agent.ts 的 Agent.run 核心循环**（大改风险，会破坏 Pulse/StorySpire 依赖）——只做外围增强（server 协议/工具/记忆/配置/CLI/测试）
- 不动其他仓库（pulse/storyspire 只读参考）
- 每轮 tsc 0 错 + 测试全绿才 commit；失败修复后继续（最多 3 次，仍失败记录到 progress.md 并停止本轮）
- 不要问问题，自主推进；全部完成后用中文简短汇报
