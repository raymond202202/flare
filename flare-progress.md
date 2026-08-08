# flare 夜间调研迭代进度

> 目标：调研 flare 引擎下一步迭代方向并推进（M4 已完成 = StorySpire 集成 + withConfirmation + 宿主协议；第一轮夜间已完成 RAG 里程碑 R0-R6；第二轮夜间已完成多模型里程碑 P0-P4；第三轮夜间已完成 server 协议里程碑 S0-S5；第四轮夜间已完成记忆生命周期闭环里程碑 T0-T5；第五轮夜间进行 MCP 协议支持里程碑 U0-U6）
> 铁律：**flare 是引擎，Pulse/StorySpire（Electron 版）当前都依赖它**——任何改动必须 tsc 0 错 + 全部测试通过才 commit
> 规则：每轮实现后 `npx tsc` 0 错 + `PATH=/usr/bin:$PATH npx vitest run` 全绿 + git commit（本地，**禁止 git push**）；每轮结束更新本文件

## 调研结论（2026-08-09 第五轮夜间）

### 现状盘点（读完 roadmap + README + docs/ + src/ + tests/，基线实测）

- **前四轮已完成**：RAG（trigram FTS + memory_search/memory_save 工具）✅；多模型（Ollama 路由 + /model + server model 字段）✅；server 协议（version/delete_session/get_usage/create_session/remember/get_memories/delete_memory）✅；记忆生命周期闭环（deleteMemory/deleteMemoriesByContent + /forget + server 记忆接口 + memoryStore→store 字段错位 bug 修复）✅
- **测试基线实测 129 项全绿**（11 文件）；`npx tsc` 0 错误；git 工作树干净；版本 v0.5.4
- **工具系统现状**：内置 read_file/write_file/search_files/terminal（含危险命令黑名单/受保护路径/原子写入）+ network（M3）+ story（M4）+ memory_search/memory_save + withConfirmation；工具注入走 `config.tools`（Agent 构造已支持，P0-2 的 joinPath/黑名单等安全机制齐全）
- **server 协议现状（src/server.ts）**：chat（含 model/tools 字段）/cancel/set_context/list_sessions/get_messages/get_usage/ping/version/create_session/delete_session/remember/get_memories/delete_memory/tool_result 已完整；协议测试用 spawn 子进程 + 临时隔离库 + 数据往返断言（防空过）
- **LLM 层**：resolveProviderOptions 纯函数路由（Ollama 冒号检测 / LLM_* 覆盖 / claude 明确报错）；createProvider 可传参注入
- **环境事实**：Node v22；零外部依赖约束友好（package.json 仅 openai/better-sqlite3/chalk/commander/dotenv/ora/readline）；MCP stdio 传输是 NDJSON JSON-RPC（子进程 stdin/stdout 管道），**可零依赖手写客户端 + mock server 离线测试**（不引入 @modelcontextprotocol/sdk，不依赖网络）

### 方向选择：✅ **MCP 协议支持（stdio MCP client + 工具桥接，零依赖）**（本轮选定）

| 候选方向 | 评估 | 结论 |
|---------|------|------|
| **MCP 协议支持** | 引擎能力增长点：连接外部 MCP 服务器（filesystem/github/数据库等）让 flare 进入 MCP 生态，Pulse/StorySpire AI 面板后续直接受益；纯外围（新模块 src/mcp/ + 工具桥 src/tools/mcp.ts + CLI /mcp + 配置 ~/.flare/mcp.json + server --mcp，**零 agent.ts 改动**，工具经已有 config.tools 注入）；零新依赖（MCP stdio = NDJSON JSON-RPC 子进程管道，手写客户端 + mock server fixture 离线确定性测试）；已被暂缓 3 轮，宿主协议成熟后正是时候 | ✅ 选定 |
| RAG 注入（Agent 构造按主题自动注入相关记忆） | 有价值但会碰 agent.ts 构造函数（Pulse/StorySpire 依赖构造行为），风险中等 | 暂缓 |
| 上下文与性能优化（token 计数） | token 计数优化会碰 agent.ts，风险高；纯计数器价值有限 | 暂缓 |
| 工具确认机制完善 | withConfirmation 已完成（allow_once/session/always/deny/alternative），剩余空间小 | 备选 |
| M5 发布与文档（npm 发布/集成指南） | 偏运营收尾，等用户明早验收后一并做（涉及发布决策） | 暂缓 |

### 迭代计划（分小步，每步独立验证 commit）

- [x] **U0** 调研：确定方向（MCP 协议支持）+ 基线实测（tsc 0 错 / 129 全绿）+ 本文件更新
- [ ] **U1** MCP 客户端（src/mcp/types.ts + src/mcp/client.ts）：`MCPClient`——spawn 子进程 + initialize 握手（JSON-RPC）+ tools/list + tools/call + close；NDJSON 行协议（零依赖手写）；请求超时/错误响应处理；导出供测试
- [ ] **U2** mock MCP server（tests/fixtures/mcp-mock-server.mjs：NDJSON JSON-RPC 响应 initialize/tools/list/tools/call）+ tests/mcp-client.test.ts（握手 / 列工具 / 调用工具 / 错误响应 / 超时 / close 清理）
- [ ] **U3** MCP 工具桥（src/tools/mcp.ts）：`createMcpTools(client)` → flare `Tool[]`（inputSchema → parameters 映射；execute → tools/call → 提取 text 内容；isError → success:false）+ src/index.ts 导出 + tests/mcp-tools.test.ts
- [ ] **U4** MCP 管理器 + CLI /mcp（src/mcp/manager.ts `McpManager`：loadConfig(~/.flare/mcp.json) / connect / disconnect / getAllTools；cli/index.ts /mcp 命令 list/connect/disconnect + 重建 Agent 注入工具 + /help 同步 + 测试）
- [ ] **U5** server 协议扩展：startHostServer 支持 `mcp` 配置（启动连接 MCP servers，工具并入 profile/host 工具）+ 新增 `mcp_status` 请求（宿主查看已连接 MCP 服务/工具数）+ `flare server --mcp <config.json>` + host-protocol.md + 协议测试（mock server 配置 + mcp_status 往返）
- [ ] **U6** 文档收尾：README Changelog + docs/mcp.md（MCP 集成指南）+ 版本号 0.5.5 + 全量回归

> 本轮里程碑目标：flare 引擎可连接外部 MCP 服务器（stdio），MCP 工具经桥接进入 Agent 工具集（CLI /mcp + server --mcp），零 agent.ts 改动、零新依赖。

## 调研结论（2026-08-09 第四轮夜间）

### 现状盘点（读完 roadmap + README + docs/ + src/ + tests/，基线实测）

- **前三轮已完成**：RAG（trigram FTS + memory_search 工具）✅；多模型（Ollama 路由 + /model + server model）✅；server 协议（version/delete_session/get_usage）✅
- **测试基线实测 107 项全绿**（11 文件）；`npx tsc` 0 错误；git 工作树干净；版本 v0.5.3
- **🐛 发现真实 bug（server.ts 记忆访问字段错位）**：server.ts 用 `(agent as any).memoryStore` 访问 Agent 的 store，但 Agent 字段是 `private store`（agent.ts:95）——`memoryStore` 恒为 undefined，导致 4 个 handler **静默失效**：
  - `delete_session`：`deleteSession` 从不真正执行（deleted 恒 false，隐私数据删不掉）
  - `list_sessions` / `get_messages`：恒返回空数组（getAllSessions/getMessages 未调用）
  - `get_usage`：恒返回 0 统计
  - 现有测试只断言响应形状（数组/数字/boolean），全部空过——**测试盲区**：协议层缺少数据往返断言
- **记忆系统缺口（RAG 只做了一半）**：AI 只能"搜"记忆（memory_search），不能"存"（用户说"记住X"时 AI 无法真正落库）；用户只能"加"不能"删"（无 /forget、MemoryStore 无 deleteMemory、server 无 delete_memory）——记忆生命周期（增/查/删）不闭环
- **server 协议现状**：chat/cancel/set_context/list_sessions/get_messages/get_usage/ping/version/delete_session/tool_result 已完整；无 create_session（宿主无法显式建会话）、无记忆接口（remember/get_memories/delete_memory）

### 方向选择：✅ **记忆生命周期闭环 + server 记忆访问修复**（本轮选定）

| 候选方向 | 评估 | 结论 |
|---------|------|------|
| **记忆生命周期闭环 + server 修复** | 修复真实 bug（memoryStore→store 字段错位，4 handler 静默失效——高价值）；补齐 RAG 缺口（AI 能搜不能存、用户只能加不能删）；server 增加记忆接口（宿主面板记忆管理）；纯外围（store.ts/tools/cli/server.ts/docs/tests），零 agent.ts 改动 | ✅ 选定 |
| MCP 协议支持 | 工作量大（网络协议 + 依赖），宿主协议刚完成，适合后续大版本规划 | 暂缓 |
| RAG 注入（Agent 构造按主题自动注入相关记忆） | 有价值但会碰 agent.ts 构造函数（Pulse/StorySpire 依赖构造行为），风险中等 | 暂缓 |
| 工具确认机制完善 | withConfirmation 已完成（allow_once/session/always/deny/alternative），剩余空间小 | 备选 |
| 上下文与性能优化 | trimContext 已有（30 条 + 配对保护）；token 计数优化会碰 agent.ts，风险高 | 暂缓 |

### 迭代计划（分小步，每步独立验证 commit）

- [x] **T0** 调研：确定方向（记忆生命周期闭环 + server 修复）+ 基线实测（tsc 0 错 / 107 全绿）+ 本文件更新
- [x] **T1** server 修复（server.ts）：`(agent as any).memoryStore` → `(agent as any).store`（4 处，delete_session/list_sessions/get_messages/get_usage 恢复真实数据）+ 新增 `create_session` 请求（宿主显式建会话，updateSessionTitle UPSERT 幂等）+ 确定性协议测试（create_session → delete_session deleted:true/false 往返，不再空过）
- [x] **T2** MemoryStore 删除（store.ts）：`deleteMemory(id)` 按 id 删单条（FTS 触发器联动清索引）+ `deleteMemoriesByContent(query)` 按内容 LIKE 匹配批量删（返回条数）；tests/store.test.ts（删除后 searchMemories 不再命中 / 不存在返回 false / 不影响其他记忆）
- [x] **T3** memory_save 工具 + CLI /forget（tools/memory.ts + tools/index.ts + cli/index.ts）：`createMemorySaveTool(store)`（AI 可真正落库用户要求记住的内容，description 约束"仅用户明确要求时保存"）+ 默认 `memorySaveTool` 加入内置工具集；CLI `/forget <关键词>`（deleteMemoriesByContent）+ /help 同步；测试（工具 schema/保存/参数校验/内置集 + /forget 命令）
- [x] **T4** server 记忆接口（server.ts）：`remember`（保存记忆）/ `get_memories`（列出或按 query 搜索）/ `delete_memory`（按 id 或 content 删除）+ host-protocol.md + 协议流测试（数据往返：remember → get_memories 命中 → delete_memory 消失，顺带证明 T1 修复）
- [x] **T5** 文档收尾：版本号 0.5.4 + README Changelog + docs/memory-rag.md 补记忆生命周期 + 全量回归

> 本轮里程碑完成：记忆生命周期闭环 + server 记忆访问修复（bug：memoryStore→store 字段错位），129 测试全绿（5 提交 T0-T5）；协议冒烟实测：create_session/remember/get_memories/delete_memory/delete_session deleted:true-false 全部真实生效。

> 里程碑完成后更新：备选后续方向（记录）：MCP 协议支持 / RAG 注入（Agent 构造按主题自动注入相关记忆）/ 上下文与性能优化（token 计数）

## 调研结论（2026-08-09 第三轮夜间）

### 现状盘点（读完 roadmap + README + docs/ + src/ + tests/，基线实测）

- **前两轮已完成**：RAG 里程碑（memories_fts trigram + searchMemories/searchMessages + memory_search 工具 + server ping/get_messages）✅；多模型 provider 增强（resolveProviderOptions 模型路由 + CLI /model + server chat model 字段）✅
- **测试基线实测 101 项全绿**（11 个文件：agent 4 / confirm 5 / expert 4 / memory-tool 8 / network 5 / server 9 / store 17 / story 11 / vision 19 / llm 13 / model-command 6）；`npx tsc` 0 错误；git 工作树干净；版本 v0.5.2
- **server 协议现状（src/server.ts）**：chat/cancel/set_context/list_sessions/get_messages/ping/tool_result 已完整；**缺 version（宿主无法协商协议版本）与 delete_session（宿主无法清理会话/隐私数据）**；MemoryStore 无 deleteSession 方法（sessions/messages/usage_log 三表无删除路径）
- **MemoryStore 表结构**：sessions + messages（FK）+ memories + usage_log + settings；FTS 触发器（messages_fts / messages_fts_trigram / memories_fts）DELETE 已联动清索引——**deleteSession 只需删 sessions 行，messages 的 DELETE 触发器自动清 FTS 索引**，实现成本低
- **测试基础设施**：server 测试已有 spawn 子进程 + 协议流收集框架（expect 过滤防乱序），新增协议测试模板成熟

### 方向选择：✅ **server 协议完善（version 版本协商 + delete_session 会话清理 + MemoryStore.deleteSession）**（本轮选定）

| 候选方向 | 评估 | 结论 |
|---------|------|------|
| **server 协议完善（version/delete_session）** | 宿主协议是 Qt/Pulse/StorySpire 集成核心；version 让宿主协商协议版本（协议演进基础），delete_session 是会话管理/隐私清理刚需；纯外围（server.ts/store.ts/docs/tests），不碰 agent.ts；MemoryStore 表结构天然支持（DELETE 触发器联动 FTS） | ✅ 选定 |
| MCP 协议支持 | 工作量大（网络协议 + 依赖），宿主协议刚完成，适合后续大版本规划 | 暂缓 |
| RAG 注入（Agent 构造按主题自动注入相关记忆） | 有价值但会碰 agent.ts 构造函数（Pulse/StorySpire 依赖构造行为），风险中等 | 暂缓 |
| 工具确认机制完善 | withConfirmation 已完成（allow_once/session/always/deny/alternative），剩余空间小 | 备选 |
| 上下文与性能优化 | trimContext 已有（30 条 + 配对保护）；token 计数优化会碰 agent.ts，风险高 | 暂缓 |

### 迭代计划（分小步，每步独立验证 commit）

- [x] **S0** 调研：确定方向（server 协议完善）+ 基线实测（tsc 0 错 / 101 全绿）+ 本文件更新
- [x] **S1** MemoryStore.deleteSession(sessionId)（store.ts）：删除 sessions 行（messages 由 FK + DELETE 触发器联动清 FTS 索引）+ usage_log 清理；返回是否删除成功；新增 tests/store.test.ts 用例（删除后 getMessages 为空 / FTS 不再命中 / 不存在时返回 false）
- [x] **S2** server 协议 `version`（server.ts）：返回 `{ type:'version', protocol:'1.0', engine:<版本> }`（宿主版本协商/健康检查升级）；host-protocol.md 文档；协议流测试
- [x] **S3** server 协议 `delete_session`（server.ts）：删除指定会话（含消息/用量），回 `ok`；host-protocol.md；协议流测试
- [x] **S4** 文档收尾：README Changelog v0.5.3 + 版本号 + host-protocol.md 完整同步 + 全量回归
- [x] **S5** server 协议 `get_usage`（server.ts）：返回 token 用量统计 `{ type:'usage', stats }`（宿主成本监控/AI 面板显示 token 消耗）；host-protocol.md；协议流测试

> 本轮里程碑完成：server 协议完善（version 版本协商 + delete_session 会话清理 + get_usage 用量统计 + MemoryStore.deleteSession），107 测试全绿（5 提交 S0-S5）。

> 本轮里程碑完成后更新：备选后续方向（记录）：MCP 协议支持 / RAG 注入（Agent 构造按主题自动注入相关记忆）/ 上下文与性能优化（token 计数）

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
- [x] **P3** 文档与收尾：README Changelog v0.5.2 + 版本号 + README 配置表（LLM_BASE_URL/LLM_API_KEY/DEFAULT_MODEL 说明）+ docs/multi-model.md 多模型指南 + 全量回归
- [x] **P4** server chat 支持 `model` 字段（宿主选模型）：chat 请求带 model → 注入 `llm: createProvider({ model })`；同会话 model 变化自动重建 Agent（历史从库恢复）；host-protocol.md 文档；协议流测试

> 本轮里程碑完成：多模型 provider 增强（模型路由 + CLI /model 切换 + server model 字段），101 测试全绿。

> 备选后续方向（记录）：server 协议补充（version/delete_session）/ MCP 协议支持 / 上下文与性能优化（token 计数）/ RAG 注入（Agent 构造按主题自动注入相关记忆）

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
| U0 | 2026-08-09 夜间 | 调研确定方向（MCP 协议支持：stdio MCP client + 工具桥接，零依赖）+ 基线实测 | tsc 0 错 / 129 全绿 | 第五轮夜间里程碑；MCP stdio = NDJSON JSON-RPC 子进程管道，mock server 离线测试；零 agent.ts 改动 |
| T0-T5 | 2026-08-09 夜间 | 记忆生命周期闭环 + server 记忆访问修复（memoryStore→store 字段错位 bug）+ create_session/remember/get_memories/delete_memory 协议 + memory_save 工具 + /forget | tsc 0 错 / 129 全绿 | 第四轮夜间里程碑（5 提交 T0-T5）；协议测试改临时隔离库 + 数据往返断言（防再空过）；冒烟实测全部真实生效；版本 0.5.4 |
| S0-S5 | 2026-08-09 夜间 | server 协议完善：version 版本协商 + delete_session 会话清理 + get_usage 用量统计 + MemoryStore.deleteSession | tsc 0 错 / 107 全绿 | 第三轮夜间里程碑（5 提交 S0-S5）；version 测试断言 engine 与 package.json 一致 |
| R0-R6 | 2026-08-09 凌晨 | RAG 里程碑（记忆检索增强）+ server ping/get_messages | tsc 0 错 / 81 全绿 | trigram FTS 中文检索 + memory_search 工具 + 宿主协议补充 |
| P0 | 2026-08-09 夜间 | 调研确定方向（多模型 provider 增强：Ollama 主模型切换）+ 基线实测 | tsc 0 错 / 81 全绿 | 复用 /vision + settings 模式；模型路由做成纯函数单测 |
| P1 | 2026-08-09 夜间 | LLM 模型路由：resolveProviderOptions 纯函数（Ollama 冒号检测/LLM_* 覆盖/兼容保留）+ createProvider 支持传参 | tsc 0 错 / 94 全绿 | +13 测试（tests/llm.test.ts，无网络）；.env.example 同步 |
| P2 | 2026-08-09 夜间 | CLI /model 命令（切换/显示/恢复默认，settings 持久化，重建 Agent 生效）+ CLI 入口守卫 | tsc 0 错 / 100 全绿 | +6 测试（tests/model-command.test.ts）；冒烟：--version/server ping 均正常 |
| P3 | 2026-08-09 夜间 | 文档收尾：README Changelog v0.5.2 + 配置表 + docs/multi-model.md + 版本号 0.5.2 | tsc 0 错 / 100 全绿 | --version = 0.5.2；多模型里程碑完成（4 提交 P0-P3） |
| P4 | 2026-08-09 夜间 | server chat 支持 model 字段（宿主选模型，同会话切换重建 Agent） | tsc 0 错 / 101 全绿 | +1 server 测试；host-protocol.md 同步 |

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
