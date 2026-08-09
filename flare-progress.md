# Flare 引擎迭代进度（夜间调研 agent）

> 目标：flare 是 Pulse/StorySpire 依赖的 AI Agent 引擎（TS）。任何改动必须安全（tsc 0 错 + 测试全绿才 commit）。
> 铁律：禁止 push；禁止修改 src/core/agent.ts 的 Agent.run 核心循环。

> **最新状态（v0.6.1）**：CLI/server 接入 ConfirmationGate 完成（宿主弹窗确认流程：confirm 事件 + confirm_result 请求；写回类工具默认 memory_save 经确认门；always 持久化到记忆库 settings 表；超时安全 deny）+ MCP resources 真实暴露（resources/list + resources/read）；251/251 全绿（commits bd80b9f/2673196 及 N6 待提交，未 push）。
> 下一步候选：① server 协议 chat 参数透传（maxTokens/temperature）；② MCP 更多特性（prompts 真实暴露/HTTP transport）；③ agent.ts trimContext 自动裁剪（风险高暂缓）。

### 2026-08-09 第四轮实施（v0.6.1）——CLI/server 接入 ConfirmationGate

- **N5 宿主弹窗确认流程**（commit `bd80b9f`）：
  - server 协议新增 `confirm` 事件（`{type, sessionId, id, name, args}`）→ 宿主弹窗 → 宿主回
    `confirm_result`（`{id, decision}`，decision ∈ allow_once/allow_session/always/deny/alternative）；
    缺 id/非法 decision 回 error（含合法值提示）；未知 id 静默忽略（不污染事件流）
  - 写回类工具经确认门：默认名单 `DEFAULT_CONFIRM_TOOLS = ['memory_save']`；`wrapConfirmTools` 纯函数
    （名单过滤：命中包装/未命中原样/空名单关闭）+ 库导出；HostServerOptions.confirmTools / confirmTimeoutMs 可配
  - 记忆化/持久化/超时全继承 ConfirmationGate：allow_session 按会话记忆（跨模型重建保留）、
    always 持久化到记忆库 settings 表（memoryStoreKv 适配器）、宿主未回 confirm_result 超时安全 deny
  - **修复关键缺口**：无 profile 时 mergedTools 为空 → Agent 回退内置工具会绕过确认门；
    改为显式传内置工具集再包装（baseTools = mergedTools || builtinTools）
  - CLI `flare server` 新增 `--confirm-tools <a,b,c>`（空串关闭）/ `--confirm-timeout <ms>`
  - docs/host-protocol.md：confirm_result 请求章节 + 响应表 confirm 事件 + 确认流图；
    README Changelog + CLI 表 + 版本号 v0.6.1
  - 测试 12 新增（wrapConfirmTools 名单过滤 5 含内置工具防绕过回归 + Agent×确认门集成 4：
    allow_once/deny/allow_session 记忆化/超时 deny + e2e 协议校验 3），**245/245 全绿**，
    tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：本机 Ollama qwen2.5:7b 真实触发——AI 调 memory_save → confirm 事件 →
    回 allow_once → tool_result → done（事件流 tool_call,confirm,tool_result,text,done PASS）
- **已知行为（非本轮引入，记录备忘）**：server 无 profile 时内置 memory_save 写全局库
  （~/.flare/flare.db）而非 --storage 指定库——与 Agent 默认一致，宿主应用应传 profile.tools 绑定独立库
- **N6 MCP resources 真实暴露**（commit `c2fa74e`）：MCPServer 新增 `resources` 选项（uri/name/description/mimeType/read 支持异步）——
  `resources/list` 真实元数据 + `resources/read` 内容（未知 uri -32602、read 抛错 -32603 服务器不崩）；
  注入后 initialize capabilities 声明 resources（缺省不声明，v0.5.9 空列表兼容）；`McpResource`/`McpResourceContents` 类型库导出；
  docs/mcp.md 资源暴露章节 + 6 测试（**251/251 全绿**，tsc 0 错误，零 agent.ts 改动）
- **下一步候选**：① server 协议 chat 参数透传（maxTokens/temperature，需评估）；② MCP 更多特性
  （prompts 真实暴露 / HTTP transport）；③ agent.ts trimContext 自动裁剪（风险高，仍暂缓）

---

### 2026-08-09 第三轮实施（v0.6.0）——N1/N2/N3 完成

- **N1 协议 recent_sessions**（commit `d7d27c1`）：`src/server.ts` 新增 `recent_sessions` 请求——
  会话列表 + 首条 user 消息预览（`preview` 折叠空白、截断 120 字符），`limit` 默认 10 上限 50；
  复用 `MemoryStore.getRecentSessions`（此前仅 CLI /sessions 用）；docs/host-protocol.md §4.1 + 响应表同步；
  store.test.ts +2、server.test.ts +2（225/225 全绿）
- **N2 flare models 命令**（commit `955a897`）：`src/core/models.ts` 新增 `listOllamaModels`（/api/tags 查询，
  AbortController 超时、Ollama 不可达返回 ok:false 不抛错、fetchImpl 可注入）+ `formatModelSize`；CLI `flare models`
  输出配置主/视觉模型（含解析端点）+ 本地 Ollama 已拉取模型列表；库导出 + README CLI 表/Changelog + v0.6.0 版本号；
  tests/models.test.ts 7 项（mock fetch：正常解析/尾斜杠/HTTP500/连接拒绝/超时 abort/大小格式化/CLI e2e 不可达不崩）；
  **冒烟实测**：本机 Ollama 列出 qwen2.5:7b-64k / qwen2.5vl:3b / qwen2.5vl:7b / qwen2.5:7b（232/232 全绿）
- **N3 memory_search 长消息折叠**（commit `6ba3a2d`）：`src/tools/memory.ts` 新增 `foldItem`（空白折叠 +
  150 字截断 + … 标记），memories 与 messages 统一折叠（此前 memories 无截断、messages 200 字）；
  memory-tool.test.ts +1（长记忆/长消息不输出完整原文、含折叠标记、单行长度受限）（233/233 全绿）
- **验证**：每步 tsc 0 错误 + 全量 vitest 全绿（225 → 232 → 233）；三步均零 agent.ts 改动
- **commit 汇总**：`d7d27c1` / `955a897` / `6ba3a2d`（均禁止 push，待用户明早验收）
- **下一步候选**：① N4 文档收尾核对（README/版本/协议文档一致性检查）；② server 协议 chat 参数透传
  （maxTokens/temperature，需评估）；③ agent.ts trimContext 自动裁剪（风险高，仍暂缓）

---

## 第一轮：调研（2026-08-09）

### 现状盘点

- **版本**：v0.5.6（2026-08-09），基线测试 **180/180 全绿**（README 有 17 个测试文件，`npx vitest run` 实测确认）
- **M1-M4 已完成**：flare-core 抽离（库入口）、Expert Profile、Pulse 网络专家集成、StorySpire 写作专家集成、withConfirmation 工具确认、宿主协议（chat/cancel/set_context/sessions/messages/usage/version/create_session/delete_session/remember/get_memories/delete_memory/tool_result/mcp_status/context_status）
- **候选方向完成度**：
  | 候选方向 | 状态 |
  |---|---|
  | MCP 协议支持 | ✅ v0.5.5（零依赖 stdio client + 工具桥 + McpManager + CLI /mcp + server --mcp） |
  | 记忆检索增强（RAG） | ✅ v0.5.1（trigram FTS + memory_search 工具）+ v0.5.4 生命周期闭环 |
  | 多模型 provider 增强 | ✅ v0.5.2（本地 Ollama 路由 + /model 切换） |
  | 工具确认机制完善 | ⚠️ **半成品**：withConfirmation 是**无状态纯函数**，allow_session/always 仅透传，无记忆化、无超时 |
  | server 协议完善 | ✅ v0.5.3/v0.5.4/v0.5.6（版本协商/会话清理/记忆接口/context_status） |
  | 上下文与性能优化 | ⚠️ token 估算已做（v0.5.6），按 token 预算裁剪需碰 agent.ts trimContext（暂缓，风险高） |

### 调研结论

**下一步方向：工具确认机制完善（v0.5.7）——ConfirmationGate（有状态确认门）**

依据：
1. docs/context-observability.md 未来方向明确点名：*"工具确认机制完善：allow_session/always 记忆化 + 超时（备选下轮）"*
2. 现实现 `src/core/confirm.ts` 只有 53 行，`allow_session`/`always` 决策由宿主 confirmer 每次弹窗，没有记忆化——用户每次写入都要确认，体验差；`always` 无法跨会话持久化
3. 纯外围增强：只动 `src/core/confirm.ts` + `src/tools/index.ts`（ToolResult 加 timeout 标记）+ 导出 + 测试 + 文档，**零 agent.ts 改动**

### 迭代计划（小步骤）

- [x] **K1** ConfirmationGate 核心：`src/core/confirm.ts` 扩展——session 级记忆（内存 Set，按 sessionId 隔离）+ always 持久化（注入 KV store，MemoryStore settings 表天然满足）+ 确认超时（默认 30s，超时按 deny 安全处理，结果带 timeout 标记）+ revoke/listAllowed/resetSession 管理方法 + wrap(tool) 包装
- [x] **K2** 向后兼容：`withConfirmation(tool, confirmer, options?)` 增加可选 options（委托 gate）；ToolResult 加 `timeout?: boolean`；`src/index.ts` 导出 ConfirmationGate / ConfirmKeyValueStore 类型
- [x] **K3** 测试：tests/confirm.test.ts 扩展 ~15 项（allow_session 只确认一次 / session 隔离 / always 持久化跨实例 / 无 store 退化 / 超时 deny / 超时可配 allow_once / deny & alternative / allow_once 每次确认 / revoke / listAllowed / resetSession / 元数据保留 / MemoryStore 集成）
- [x] **K4** 文档：docs/confirmation.md（宿主集成指南：弹窗确认 + 记忆化 + 超时 + revoke）+ README Changelog v0.5.7 + 版本号 + CLI/导出表同步
- [x] **K5** 验证收尾：tsc 0 错 + 全绿 + git commit + 本文件勾选追加

---

## 迭代记录

### 第一轮（2026-08-09）——调研 + 里程碑完成（v0.5.7）

- **调研结论**：候选方向中"工具确认机制完善"是唯一半成品（withConfirmation 无状态，allow_session/always 仅透传），且 docs/context-observability.md 未来方向点名；其余（MCP/RAG/多模型/server 协议）均已完成；上下文裁剪需碰 agent.ts 暂缓
- **完成 K1-K5**：ConfirmationGate（allow_session 记忆化按 sessionId 隔离 / always 持久化 + memoryStoreKv 适配器 / 超时 30s 安全 deny + timeout 标记 / revoke·listAllowed·isAllowed·resetSession 管理）；withConfirmation 三参向后兼容；ToolResult.timeout 可选字段；库导出扩展；docs/confirmation.md + README v0.5.7
- **验证**：npx tsc 0 错误；PATH=/usr/bin:$PATH npx vitest run **194/194 全绿**（180 基线 + 14 新增）；零 agent.ts 改动
- **commit**：`220cf87`（禁止 push，待用户明早验收）
- **下一步候选**：① 上下文 token 预算裁剪（需谨慎评估 agent.ts trimContext）；② CLI/server 接入 ConfirmationGate（宿主弹窗流程）；③ MCP 增强（server 端/更多协议特性）

---

### 第二轮（2026-08-09）——MCP 服务器端（v0.5.8）

- **方向**：MCP 增强的 server 端——flare 已有 MCP **客户端**（连外部服务器，v0.5.5），本轮补对称的 MCP **服务器**（把 flare 工具集经 MCP stdio 标准协议暴露给其他 AI 客户端/宿主进程复用）；纯新增文件，零 agent.ts 改动
- **完成**：
  - `src/mcp/server.ts`：**MCPServer**（零依赖 NDJSON JSON-RPC，与 MCPClient 完全互通）——`initialize`（协议版本协商 + capabilities.tools + serverInfo）/ `tools/list`（flare Tool → MCP 工具定义）/ `tools/call`（执行 + isError 标记，工具异常不崩服务器）/ `ping`；JSON-RPC 错误码规范（未知方法 -32601、未知工具 -32602、parse error -32700）；**串行响应队列**（慢工具不导致响应乱序）；输入/输出可注入（write/input，测试与嵌入式不限于 stdin/stdout）；close 幂等
  - `toMcpTool`（工具定义映射）+ `startMcpServer`（便捷工厂）+ 库导出（src/index.ts）
  - **安全继承**：暴露的是 flare 原生工具，危险命令黑名单/路径保护/记忆边界照常生效（e2e 实测 `rm -rf /` 仍被拦截）
  - docs/mcp.md 新增"flare 作为 MCP 服务器"章节 + README Changelog v0.5.8 + 版本号
- **验证**：npx tsc 0 错误；PATH=/usr/bin:$PATH npx vitest run **208/208 全绿**（194 基线 + 14 新增，含 **MCPClient↔MCPServer 真实子进程互通 e2e**——tsx fixture 起 flare 服务器，官方客户端握手/列工具/调工具全通）；零 agent.ts 改动
- **commit**：`06eae7b`（禁止 push，待用户明早验收）
- **下一步候选**：① CLI `flare mcp-server` 命令（MCP 服务器端收尾，让 CLI 一键起服务器）；② CLI/server 接入 ConfirmationGate（宿主弹窗流程）；③ 上下文 token 预算裁剪（agent.ts trimContext，风险高暂缓）

---

### 第二轮补充（2026-08-09）——CLI `flare mcp-server` 命令（v0.5.8 收尾）

- **完成**：`src/cli/index.ts` 新增 `flare mcp-server [-t 工具名,...]` 子命令——一键把 flare 内置工具集（或 `-t` 过滤子集）暴露为 MCP stdio 服务器（常驻监听 stdin）；README CLI 命令表同步（含 `flare server` 补列）
- **验证**：npx tsc 0 错误（build dist）；**211/211 全绿**（208 + 3 新增 CLI e2e：spawn dist CLI + 官方 MCPClient 真实连接——默认 6 工具 / -t 过滤 / 危险命令拦截继承）
- **commit**：`5779078`（禁止 push）
- **至此 MCP 增强里程碑完整**：客户端（v0.5.5）+ 服务器端核心（06eae7b）+ CLI 一键起服务器（5779078）
- **下一步候选**：① 上下文 token 预算裁剪**建议函数** `suggestTrim`（纯函数，宿主可自行按预算裁剪上下文，不碰 agent.ts）；② CLI/server 接入 ConfirmationGate；③ agent.ts trimContext 裁剪（风险高暂缓）

---

### 第二轮补充（2026-08-09）——suggestTrim 上下文裁剪建议（v0.5.9）

- **完成**：`src/core/context.ts` 新增 `suggestTrim(messages, budgetTokens, opts?)` 纯函数——按 token 预算建议保留哪些消息（**system 保底** + **最近优先** + **极小预算保底最新一条** + `reserveForOutput` 预留输出 + `keepSystem:false` 可关），返回 `{ keep, droppedCount, estimatedKeptTokens, estimatedDroppedTokens }`；库导出 + 类型；docs/context-observability.md"按预算裁剪上下文"章节（宿主自管理上下文的地基，零 agent.ts 改动）
- **验证**：tsc 0 错误；**220/220 全绿**（211 + 9 新增）
- **commit**：`7379a5e`（版本号 0.5.9）
- **补丁**：MCPServer 增加 `resources/list` + `prompts/list` 空列表响应（Claude Desktop 等真实客户端连接时探测，返回空列表比 -32601 更兼容）；2 测试；`d84b2ef`；**221/221 全绿**
- **下一步候选**：① CLI/server 接入 ConfirmationGate（宿主弹窗流程）；② agent.ts trimContext 自动裁剪（风险高暂缓）；③ MCP 更多协议特性（resources 真实暴露/HTTP transport）

---
### 第三轮（2026-08-09）——调研：server 协议会话/模型可观测性增强（v0.6.0 方向）

- **现状盘点（v0.5.9，221/221 全绿）**：
  | 方向 | 状态 |
  |---|---|
  | MCP 协议支持 | ✅ client v0.5.5 + server v0.5.8 + CLI mcp-server + resources/prompts compat v0.5.9 |
  | 工具确认机制 | ✅ ConfirmationGate v0.5.7 |
  | 上下文可观测 | ✅ estimateTokens + context_status + /context v0.5.6 + suggestTrim v0.5.9 |
  | 记忆 RAG | ✅ trigram FTS + memory_search/save/delete 生命周期 v0.5.1/v0.5.4 |
  | server 协议 | 🟡 大部分完成（version/delete_session/get_usage/create_session/remember/get_memories/delete_memory/context_status/mcp_status） |
  | 多模型 provider | 🟡 resolveProviderOptions + /model 切换 v0.5.2；**缺模型列表能力** |
- **明确缺口**：
  1. **协议无会话预览**：`MemoryStore.getRecentSessions()`（含首条 user 消息预览）已存在且 CLI /sessions 在用，
     但 server 协议 `list_sessions` 用 `getAllSessions()`（无预览）——Qt 宿主面板无法展示"最近会话+预览"
  2. **无模型列表**：宿主/CLI 无法查询本地 Ollama 有哪些模型可切换（`flare models` 命令 + 协议查询都缺）
  3. memory_search 长消息折叠（docs/memory-rag.md 后续候选，小而安全）
- **确定方向**：**server 协议完善（宿主会话/模型可观测性增强）** —— 纯外围（src/server.ts + src/cli + docs + tests），
  零 agent.ts 改动，Pulse/StorySpire 宿主直接受益
- **迭代计划（小步骤）**：
  - [x] **N1** 协议 `recent_sessions`（会话列表 + 首条 user 消息预览，复用 getRecentSessions）
        → host-protocol.md 文档 + server.test.ts 2-3 项测试
  - [x] **N2** `flare models` CLI 命令（列出默认/视觉模型 + 本地 Ollama 已拉取模型，Ollama 不可达不报错）
        → cli 测试（mock 或跳过网络）
  - [x] **N3**（可选）memory_search 长消息折叠（tools/memory.ts 截断优化）
  - [x] **N4** README Changelog + 版本号 v0.6.0 + 文档收尾（随 N2 完成）

---

