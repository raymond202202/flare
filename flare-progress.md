# Flare 引擎迭代进度（夜间调研 agent）

> 目标：flare 是 Pulse/StorySpire 依赖的 AI Agent 引擎（TS）。任何改动必须安全（tsc 0 错 + 测试全绿才 commit）。
> 铁律：禁止 push；禁止修改 src/core/agent.ts 的 Agent.run 核心循环。

> **最新状态（v0.6.7）**：CLI 交互模式接入 ConfirmationGate（终端确认弹窗 + /allow 管理 + always 持久化）；340/340 全绿（commit `fc5763c`，未 push）。
> 下一步候选：① agent.ts trimContext 自动裁剪（风险高仍暂缓）；② 其他安全的外围增强（server 协议确认门管理请求 confirm_status/confirm_revoke 等）。

### 2026-08-09 第九轮实施（v0.6.7）——CLI 交互模式接入 ConfirmationGate

- **P18 CLI 交互模式接入 ConfirmationGate**（commit `fc5763c`）：
  - AI 调用写回类工具（`memory_save`）执行前**终端内确认弹窗**：`[y] 允许一次 / [s] 本次会话允许 /
    [a] 总是允许 / [n] 拒绝（默认）`——确认期间暂停火焰动画 + 恢复终端回显（readline 读一行），
    决策后反馈一行并继续 Agent 流；allow_session 会话记忆、always 持久化到全局库 settings 表
    （跨会话记住）；ConfirmationGate 超时安全 deny 继承
  - **防绕过**：交互模式始终显式传工具集（内置 + MCP）再 `wrapConfirmTools` 包装——避免 Agent
    回退内置工具绕过确认门（与 server 端 v0.6.1 同机制）；默认名单 `CLI_CONFIRM_TOOLS =
    ['memory_save']`（与 server `DEFAULT_CONFIRM_TOOLS` 一致）
  - **/allow 命令**：查看已放行的确认工具（含 always 持久化）/ `/allow revoke <工具名>` 撤销
    （恢复每次确认）；`handleSlashCommand` 新增可选 `allowGate` hooks（向后兼容）
  - **可测性**：库导出纯函数 `parseConfirmAnswer`（输入→决策，空/未知安全 deny）/ `formatConfirmPrompt`
    （确认 UI 文案，参数 JSON 截断 120 字符）/ `terminalConfirmer`（可注入 ask/onPause/onResume/onFeedback）
  - docs/confirmation.md CLI 交互章节 + README CLI 表/Changelog + 版本号 0.6.7
  - **340/340 全绿**（317 + 23 新增：parseConfirmAnswer 4 / formatConfirmPrompt 3 / terminalConfirmer 4 /
    Gate×terminal 集成 5 / /allow 命令 7），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：本机 Ollama qwen2.5:7b 真实触发——AI 调 memory_save → 确认弹窗（含参数摘要）→
    y →「已允许本次执行」→ 工具真实写入 → AI 回复，事件链完整；PTY 下 /allow 命令正常
- **下一步候选**：① agent.ts trimContext 自动裁剪（风险高仍暂缓）；② 其他安全的外围增强
  （server 协议确认门管理 confirm_status/confirm_revoke 请求、/forget 交互确认、CLI /allow 增强等）

---

### 2026-08-09 第八轮实施（v0.6.6）——MCP HTTP 接入 McpManager + CLI `flare mcp call`/`mcp status` + resources 客户端消费

- **P15 MCP HTTP 接入 McpManager**（commit `0be72bd`）：
  - `McpServerConfig` 新增 `url`（HTTP 端点）/ `timeoutMs`（可选）——配了 `url` 走 `MCPHttpClient`
    直连（HTTP transport），否则按 `command` stdio spawn（行为不变）；url 与 command 并存 url 优先、
    皆无抛清晰错误；`McpManager({ httpTimeoutMs })` 全局超时默认 15s
  - `createMcpTools` 参数放宽为 `McpToolClient` 接口（stdio MCPClient / HTTP MCPHttpClient 都满足，
    工具桥传输无关）+ 库导出类型；CLI 交互 `/mcp`、`flare server --mcp` 自动继承（零 agent.ts 改动）
- **P16 CLI `flare mcp call`**（commit `0be72bd`）：
  - `flare mcp call <server> <tool> [jsonArgs]`：一键调用 MCP 工具——服务器名查 `~/.flare/mcp.json`
    （url→HTTP / command→stdio），`--url` 直连 HTTP 端点跳过配置、`--config <path>` 指定配置、
    `--timeout <ms>` 调超时；工具参数 JSON 对象（缺省 `{}`）；工具级失败/协议错误/未配置服务器 → 退出码 1 + 明确错误
- **P16b CLI `flare mcp status`**（commit `ce7291f`）：列出配置的 MCP 服务器（名称 + 传输类型 HTTP/stdio +
  端点/命令，`--config` 可指定）；空配置友好提示退出码 0；与 mcp call 组成完整命令组
  （共享 `mcpCmd` 父命令，修复 call 误挂 status 下的 commander 注册问题）
- **P17 MCP resources 客户端消费**（commit `74306d0`）：stdio MCPClient 与 HTTP MCPHttpClient 新增
  `listResources()`（元数据 uri/name/description/mimeType）/ `readResource(uri)`（内容列表，未知 uri
  协议错误 reject）——与 MCPServer resources 暴露（v0.6.1）对称闭环；`McpResourceInfo` 类型 + 库导出；
  mock fixture 支持 resources（capabilities 声明 resources）
- 文档：docs/mcp.md McpManager 接入 + CLI mcp call/status + resources 客户端消费章节 + README CLI 表/Changelog + 版本号 0.6.6
- **317/317 全绿**（299 + 18 新增：McpManager×HTTP 5——配置 url 连接桥接+真实执行/HTTP 不可达错误记录/
  无 url 无 command 报错/disconnect/url 优先；CLI e2e 9——--url 直连/配置 url/配置 command stdio/
  无参数兜底/未配置服务器/非法 JSON/未知工具/status 列表/status 空配置；resources 消费 4——
  stdio 元数据/stdio 读取/stdio 未知 uri reject/HTTP 闭环），tsc 0 错误，零 agent.ts 改动
- **冒烟实测**：`flare mcp-server --http --port 19211 -t read_file` + `flare mcp call --url` /
  配置 url 走 HTTP——真实调用 read_file 输出文件内容；未知工具/未配置服务器退出码 1 提示清晰；
  `flare mcp status` 输出 HTTP/stdio 服务器清单与端点；startMcpHttpServer 注入 resources +
  MCPHttpClient 真实 listResources/readResource 成功、未知 uri reject
- **下一步候选**：① agent.ts trimContext 自动裁剪（风险高仍暂缓）；② 其他安全的外围增强

---

### 2026-08-09 第七轮实施（v0.6.4/v0.6.5）——context_status 预算建议 + MCP HTTP 客户端 + server 默认采样参数

- **P14 server 默认采样参数**（commit `6c65069`，v0.6.5）：
  - `HostServerOptions.defaultMaxTokens/defaultTemperature` + CLI `flare server --max-tokens/--temperature`——
    chat 请求未指定采样参数时应用（宿主免每请求传参）；请求带参数则请求优先（可覆盖默认）；
    请求只带一个参数时另一个不用默认补（行为可预期）；默认值非法回 error 不触发生成
  - docs/host-protocol.md chat 参数表 + README CLI 表/Changelog + 版本号 0.6.5
  - **299/299 全绿**（295 + 4 新增：spawn 带默认参数 server e2e——version 协商正常/chat 不带参数
    应用默认流程完整/非法 maxTokens 请求校验优先/合法请求参数覆盖默认），tsc 0 错误，零 agent.ts 改动
- **P12 context_status 预算建议**（commit `bc40e9f`，v0.6.4）：
  - server 协议 `context_status` 可选带 `budgetTokens`（正整数）/ `reserveForOutput`（非负）——
    响应附 `suggestion` 字段：`keepIndexes`（建议保留的消息索引，单调递增、首条必为 0 即 system 保底）、
    `droppedCount`、`estimatedKeptTokens`/`estimatedDroppedTokens`；复用 `suggestTrim` 纯函数
    （system 保底 + 最近优先 + 极小预算保底最新一条），非法值回 error 不触发生成
  - 宿主按预算自管理上下文推荐流程：`context_status` 带预算取建议 → 裁剪 → `set_context` 回写
    （零 agent.ts 改动）；docs/host-protocol.md §10.1 预算建议章节
- **P13 MCPHttpClient（MCP HTTP 消费端）**（commit `bc40e9f`）：
  - `src/mcp/http-client.ts`：与 stdio `MCPClient` 接口完全一致（initialize/listTools/callTool/
    listPrompts/getPrompt/ping/close），零依赖 node:http 每请求独立 POST（streamable HTTP 同步子集）；
    initialize 后自动发 notifications/initialized 通知（服务器回 202）；JSON-RPC error / 非 200 /
    无响应体 → reject（含原因）；超时默认 15s（timeoutMs 可调）；close 后拒绝后续请求
  - 与 P11 服务器端（startMcpHttpServer）对称闭环：本地子进程服务器用 stdio MCPClient、
    远端/HTTP 服务器用 MCPHttpClient；库导出 + docs/mcp.md HTTP 客户端章节
  - **295/295 全绿**（282 + 13 新增：server 协议 3——带预算 suggestion 结构/非法 budgetTokens
    0·负·非整数·abc/非法 reserveForOutput + MCPHttpClient 10——握手/工具列表/执行成功与工具级失败/
    未知工具 -32602/prompts 消费闭环/ping/服务器关闭 reject/close 后拒绝/非法 URL/404 路径），
    tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：startMcpHttpServer（随机端口）+ MCPHttpClient——握手 serverInfo 0.6.4、
    tools 6 个内置工具、真实执行 memory_search、ping true；suggestTrim 裁剪正确
- **下一步候选**：① agent.ts trimContext 自动裁剪（风险高仍暂缓）；② 其他安全的外围增强
  （CLI `flare server --max-tokens/--temperature` 默认值 / MCP HTTP 服务器接入 McpManager /
  CLI `flare mcp call` 走 HTTP 等）

---

### 2026-08-09 第六轮实施（v0.6.3）——chat 采样参数透传 + MCP HTTP transport

- **P10 chat 采样参数透传**（commit `784af29`）：
  - server 协议 chat 新增 `maxTokens`（正整数，最大输出 token 数）/ `temperature`（0~2，采样温度）——
    非法值直接回 error 不触发生成；合法值透传到 LLM 请求体（`max_tokens` / `temperature`）
  - `ProviderOptions` 扩展 `maxTokens`/`temperature` 可选字段；`OpenAIProvider.chat`/`chatStream` 请求体透传
    （仅显式传入时携带，缺省不传保持服务端默认——零行为回归）
  - 同一会话采样参数变化自动重建 Agent（与切换 model 同机制，历史从记忆库恢复）；`llmOptsChanged` 逐字段比较
  - docs/host-protocol.md chat 请求参数表 + README Changelog + 版本号 v0.6.3（src 无版本硬编码，server version 协商自动跟随）
  - **272/272 全绿**（262 + 10 新增：provider 请求体透传 5——chat/chatStream/缺省不传/temperature 0 不丢失；
    server 协议 5——非法 maxTokens/-5、1.5、非法 temperature/3、'abc' 回 error、合法值流程完整），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：本机 Ollama qwen2.5:7b 真实 chat 带 `maxTokens:50, temperature:0.2`——输出被截断在 ~50 token
    （未写完 200 字短文），证明 max_tokens 真实生效，事件流 text → done 完整
- **P11 MCP HTTP transport**（commit `aac28a6`）：
  - `src/mcp/http.ts`：`startMcpHttpServer`——零依赖 node:http，`POST /mcp` 一次请求一个 JSON-RPC 消息并回 JSON 响应
  - MCPServer 拆出传输无关的 `handleMessage(msg): Promise<响应|null>`（stdio 的 handleLine 与 HTTP 共用同一核心，
    删除旧 processRequest 死代码）；有 id 请求 → 200 + 响应（错误对象不抛出）、通知（无 id）→ 202 空体、
    非法 JSON → 400 + parse error（-32700）、非 POST / 错误路径 → 404；请求串行队列（响应不乱序）
  - 安全默认：仅监听 127.0.0.1；port 0 = 随机端口；暴露的仍是 flare 原生工具（危险命令黑名单照常生效）
  - CLI `flare mcp-server --http [--port <port>]` 一键起 HTTP 服务器（stdio 仍为默认传输）；库导出 + docs/mcp.md HTTP 章节
  - **282/282 全绿**（272 + 10 新增：握手 capabilities/工具列表/工具真实执行/未知工具 -32602/未知方法 -32601/
    非法 JSON/通知 202/404/并发响应 id 不串扰/CLI --http e2e），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：`flare mcp-server --http --port 18999` + curl——initialize 握手（capabilities.tools + serverInfo 0.6.3）、
    tools/list 真实内置工具、非法 JSON 回 400 parse error
- **下一步候选**：① agent.ts trimContext 自动裁剪（风险高仍暂缓）；② 其他安全的外围增强
  （CLI `flare server --max-tokens/--temperature` 默认值 / context_status 含 suggestTrim 预算建议 / MCPClient HTTP 消费端）

---

### 2026-08-09 第五轮实施（v0.6.2）——MCP prompts 真实暴露 + 客户端消费闭环

- **N7 MCP prompts 真实暴露**（commit `d780c5c`）：MCPServer 新增 `prompts` 选项（name/description/arguments/render 支持异步）——
  `prompts/list` 真实元数据（客户端探测清单）+ `prompts/get` 按客户端 arguments 渲染消息序列 `{ description?, messages }`；
  未知 name -32602、render 抛错 -32603 服务器不崩；注入后 initialize capabilities 声明 prompts（缺省不声明，v0.5.9 空列表兼容）；
  `McpPrompt`/`McpPromptArgument`/`McpPromptMessage` 类型库导出；docs/mcp.md 提示词暴露章节 + README Changelog + v0.6.2 版本号；
  **257/257 全绿**（251 + 6 新增测试），tsc 0 错误，零 agent.ts 改动
- **N8 MCPClient 消费 prompts**（commit `810c7df`）：MCPClient 新增 `listPrompts()`（元数据）+ `getPrompt(name, args?)`（渲染，未知 name 协议错误 reject）——
  与 MCPServer 暴露对称闭环；`McpPromptInfo`/`McpPromptResult` 类型库导出；mock server fixture 支持 prompts；
  新增 **prompts 真实互通 e2e**（MCPClient↔MCPServer 子进程：capabilities 声明 / listPrompts 元数据 / getPrompt 渲染 / 未知 name reject /
  无 prompts 缺省兼容返回空列表）；**262/262 全绿**（257 + 5 新增），tsc 0 错误，零 agent.ts 改动
- **下一步候选**：① server 协议 chat 参数透传（maxTokens/temperature，需评估）；② MCP HTTP transport（可选）；
  ③ agent.ts trimContext 自动裁剪（风险高，仍暂缓）

---

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

