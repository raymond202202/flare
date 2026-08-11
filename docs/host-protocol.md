# Flare 宿主协议（最小版）

> 供非 Node 宿主（如 Qt 应用）调用 flare 引擎的本地协议。
> 传输：stdin/stdout · JSON Lines（每行一个 JSON 对象）
> 实现：`src/server.ts`（`flare server` 命令）
> 请求类型：chat / cancel / set_context / list_sessions / recent_sessions / search_sessions / get_messages / search_messages / get_usage / session_usage / context_status / apply_trim / ping / version / create_session / rename_session / clear_session / delete_session / end_session / restore_session / list_archived_sessions / remember / get_memories / delete_memory / tool_result / confirm_result / confirm_status / confirm_revoke / confirm_allow / models / get_config / tools / mcp_status / mcp_resources / mcp_tools / mcp_prompts / mcp_read_resource / mcp_get_prompt / mcp_call / mcp_complete / mcp_connect / mcp_disconnect

## 启动

```bash
flare server --profile <expert-profile-file> --storage <db-path> [--mcp <mcp-config.json>]
```

- `--profile`：ExpertProfile JSON 文件（name/identity/systemPrompt/tools）
- `--storage`：记忆库路径（默认 `~/.flare-data/`）
- `--mcp`（可选，v0.5.5）：MCP 服务器配置 JSON——`{ "servers": [{ "name", "command", "args", "env", "url", "timeoutMs", "headers" }] }`。
  启动时连接各 MCP 服务器，其工具并入每个会话的 Agent 工具集（与宿主代理工具/专家工具并存）；
  连接失败不阻塞服务（`mcp_status` 可见错误）。
  - v0.6.6：配置项 `url`（HTTP transport 端点）→ 走 HTTP 直连（不 spawn 子进程）；`timeoutMs` 可
    单独覆盖单请求超时
  - v0.6.67：配置项 `headers`（HTTP 附加请求头，如 `{ "Authorization": "Bearer <token>" }` 鉴权）——
    仅 url 模式生效；stdio 用 `env` 传子进程环境变量
  例：
  ```json
  {
    "servers": [
      { "name": "fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
      { "name": "remote", "url": "http://127.0.0.1:8931/mcp", "headers": { "Authorization": "Bearer <token>" } }
    ]
  }
  ```
- 环境变量注入 API key（如 `DEEPSEEK_API_KEY=...`），与现有 Agent 一致

## 请求（宿主 → 服务，stdin 每行一个）

### 1. chat — 发起对话（流式）

```json
{"type":"chat","sessionId":"s1","input":"帮我分析这个报错","context":"（可选状态快照）","tools":[<ToolDefinition>...],"model":"qwen2.5:7b","maxTokens":2048,"temperature":0.3}
```

- `sessionId`：会话标识（同 id 连续对话，历史累积）
- `context`：可选，调用 `setContext` 注入宿主状态快照
- `tools`：可选，宿主声明的工具定义；服务为会话创建"宿主代理工具"（执行时经 `tool_execute` 事件问宿主）
- `model`：可选（v0.5.2），指定该会话主模型——本地 Ollama（如 `qwen2.5:7b`，自动走 localhost:11434/v1）/ 远端（如 `deepseek-chat`）；缺省用默认路由（.env DEFAULT_MODEL）；同一会话切换 model 会自动重建 Agent（历史从记忆库恢复）
- `maxTokens`：可选（v0.6.3），最大输出 token 数（正整数），透传到 LLM 请求体 `max_tokens`；缺省不传（用服务端默认；若 server 以 `--max-tokens` 启动则用该默认，v0.6.5）；非法值（非正整数）回 error
- `temperature`：可选（v0.6.3），采样温度 0~2，透传到 LLM 请求体 `temperature`；缺省不传（用服务端默认；若 server 以 `--temperature` 启动则用该默认，v0.6.5）；非法值（超出 0~2）回 error
- `maxContextMessages`：可选（v0.6.17），上下文自动裁剪条数上限（非负整数，0 = 不按条数裁剪）——Agent 每次迭代前自动裁剪到最近 N 条（system 保底 + tool_calls 配对保护）；缺省 30（或 server 以 `--max-context-messages` 启动的默认）；非法值（非负整数之外）回 error，不触发生成
- `maxContextTokens`：可选（v0.6.17），上下文自动裁剪 token 预算（正整数）——估算 tokens 超过预算时迭代前自动裁剪（最近优先 + 配对保护 + system 保底）；缺省不启用 token 裁剪（或 server 以 `--max-context-tokens` 启动的默认）；非法值（非正整数）回 error，不触发生成；与 `maxContextMessages` 任一先到即停
- `contextSummarize`：可选（v0.6.19），上下文压缩摘要开关（布尔）——开启后裁剪时把丢弃的历史压缩成摘要消息（纯启发式统计，不调 LLM：条数/角色分布/涉及工具/最后话题；摘要链防堆积）而非直接丢弃；缺省不开启（或 server 以 `--context-summarize` 启动的默认）；非法值（非布尔）回 error，不触发生成
- `toolOutputPolicy`：可选（v0.6.34），工具输出治理策略（对象）——按工具类型定制工具结果截断：`maxOutputChars`（成功输出最大字符数，默认 2000）/ `maxErrorChars`（失败错误最大字符数，默认 1000）/ `headChars`（探索型 read_file/search_files 头部保留，默认 1200）/ `tailChars`（探索型/终端型尾部保留）/ `ellipsis`（省略标记模板，含 `{omitted}` 替换为省略字符数）；探索型留头尾、终端型 terminal 留尾部、默认前 maxOutputChars（与旧版统一 slice 一致）；字段全部可选、未知字段忽略；非法值（非对象 / 字符数字段非正整数 / ellipsis 非字符串）回 error 含字段名，不触发生成；缺省不配置（或 server 以 `--tool-output-policy` 启动的默认）
- 请求只带其中一个参数时，另一个不用 server 默认补（请求优先，行为可预期）

### 2. cancel — 取消当前生成

```json
{"type":"cancel","sessionId":"s1"}
```

### 3. set_context — 更新会话上下文（不触发生成）

```json
{"type":"set_context","sessionId":"s1","context":"..."}
```

### 4. list_sessions — 历史会话

```json
{"type":"list_sessions"}
```

### 4.1 recent_sessions — 最近会话（含首条消息预览，v0.6.0）

```json
{"type":"recent_sessions"}                      // 最近 10 个会话（按更新时间倒序）
{"type":"recent_sessions","limit":5}            // 指定条数（默认 10，上限 50）
```

响应：`{"type":"recent_sessions","sessions":[{"id":"s1","title":"...","updatedAt":"...","preview":"第一条用户消息..."}]}`

- `preview`：该会话第一条 user 消息的前 120 字符（空白折叠）——宿主会话面板展示标题/预览用；
  空会话 preview 为空串
- 与 `list_sessions`（全量 + 消息数）互补：recent_sessions 面向"最近会话列表"展示场景，只读不生成

### 4.2 search_sessions — 按标题/消息内容搜索会话（v0.6.43）

```json
{"type":"search_sessions","query":"flutter"}                    // 搜索会话（默认返回最多 20 条）
{"type":"search_sessions","query":"flutter","limit":5}          // 指定条数（1~100，默认 20）
```

响应：`{"type":"search_sessions","query":"flutter","sessions":[{"id":"s1","title":"...","createdAt":"...","updatedAt":"...","messageCount":3,"archived":false}]}`

- `query` 必填（非空字符串）——LIKE 匹配**会话标题或会话内任意消息内容**（DISTINCT 去重，
  一个会话多条命中只出现一次）；结构同 `list_sessions`（含消息数/归档标记），按更新时间倒序
- 与 `search_messages`（v0.6.24，返回**消息级**结果）互补：本接口返回**会话级**结果——
  宿主面板搜索框先搜会话（可点进会话看详情），再按需 `search_messages` 定位具体消息
- 只读不触发生成；不存在的关键词返回空数组 `sessions:[]`（不报错）

### 5. get_messages — 读取指定会话消息历史（只读，不生成）

```json
{"type":"get_messages","sessionId":"s1"}                        // 最早 50 条（时间正序，默认，向后兼容）
{"type":"get_messages","sessionId":"s1","limit":100}            // 条数上限（1~500，默认 50）
{"type":"get_messages","sessionId":"s1","recent":true,"limit":20}  // 返回**最近** 20 条（时间正序）
```

响应：`{"type":"messages","sessionId":"s1","messages":[...]}`——宿主展示历史对话、会话恢复时读取。

- `recent:true`（v0.6.21）：返回**最近** limit 条（面板"最近对话/当前上下文"数据源；长会话下默认
  取最早 limit 条看不到最新内容）；响应带 `"recent":true` 标记；缺省行为与旧版完全一致
- `limit` 非法（非 1~500 整数）→ error 含用法提示（不触发生成）

### 5.1 search_messages — 全文搜索历史对话（只读，不生成，v0.6.24）

```json
{"type":"search_messages","query":"网络请求超时"}            // 全局跨会话搜索，默认最多 10 条
{"type":"search_messages","query":"flare","limit":20}       // 条数上限（1~100，默认 10）
```

响应：`{"type":"search_results","query":"网络请求超时","results":[{"sessionId":"s1","role":"user","content":"...","createdAt":"..."}]}`

- 宿主面板"搜索历史对话"数据源——复用记忆库 FTS5 trigram 索引（bm25 相关度排序，中文友好；
  短查询 <3 字自动 LIKE 回退），**跨全部会话**检索（与 `get_usage` 全局统计同风格）
- `query` 必填（空白裁剪判空）→ 缺失/空白回 error 含用法提示（不触发生成）
- `limit` 非法（非 1~100 整数）→ error 含用法提示；无结果返回空数组（幂等不报错）
- 只读不触发生成、不创建会话

### 6. ping — 宿主健康检查（进程存活探测）

```json
{"type":"ping"}
```

响应：`{"type":"pong","ts":<毫秒时间戳>}`——不依赖任何初始化，宿主启动/断线重连前可先探测。

### 7. version — 版本协商（协议版本 + 引擎版本）

```json
{"type":"version"}
```

响应：`{"type":"version","protocol":"1.0","engine":"0.5.3"}`

- `protocol`：宿主协议版本（协议演进时递增，与引擎版本独立）
- `engine`：flare 引擎版本（package.json）
- 宿主启动时探测：校验协议版本兼容性、展示引擎版本；协议演进时宿主可据此提示升级

### 8. delete_session — 清理会话（含消息/用量，隐私数据清除）

```json
{"type":"delete_session","sessionId":"s1"}
```

响应：`{"type":"ok","sessionId":"s1","deleted":true}`

- 删除指定会话的全部消息与 token 用量记录（FTS 检索索引联动清理）
- `deleted`：是否真的删除了会话记录（会话不存在时为 `false`，幂等不报错）
- 宿主管理会话列表、用户主动清除历史/隐私数据时使用

### 9. get_usage — 读取 token 用量统计（只读，不生成）

```json
{"type":"get_usage"}
```

响应：`{"type":"usage","stats":{"promptTokens":123,"completionTokens":456,"cacheReadTokens":80,"cacheWriteTokens":0,"estimatedCostUsd":0.0002,"cacheSavedUsd":0.00004,"totalTokens":579,"sessionCount":3,"perModel":[{"model":"deepseek-chat","calls":2,"promptTokens":80,"completionTokens":100,"cacheReadTokens":50,"totalTokens":180},{"model":"qwen2.5:7b","calls":1,"promptTokens":43,"completionTokens":356,"cacheReadTokens":0,"totalTokens":399}]}}`

- 宿主展示用量统计（成本监控）、AI 面板显示 token 消耗时使用
- `perModel`（v0.6.18）：按模型分组的用量分解（`model` / `calls` 调用次数 / `promptTokens` / `completionTokens` / `totalTokens`，按调用次数降序；无模型记录归 `unknown`）——成本核算/用量分布数据源；每项含 `cacheReadTokens`（v0.6.29）与 `cacheSavedUsd`（v0.6.65：本模型缓存节省，同口径单模型差值，无法定价为 0）
- `cacheReadTokens` / `cacheWriteTokens` / `estimatedCostUsd`（v0.6.29 P0）：缓存命中/写入 input tokens
  与估算成本 USD——宿主面板可显示「本轮缓存命中率」（promptTokens 中命中占比），引导连续执行省钱
  （DeepSeek 前缀缓存命中价 ≈ 未命中的 1/4；`estimatedCostUsd` 无法可靠估算的模型为 0）
- `cacheSavedUsd`（v0.6.64）：缓存命中省下的成本（未命中价 − 命中价的差值，按 perModel 逐模型
  估算求和）——命中量的价值量化，宿主面板可显示「缓存已节省 $X」；无法定价的模型（如本地
  Ollama）不计入；无命中/无可定价用量时为 0
- 与 get_messages 一样只读，不触发生成

#### 9.1 session_usage — 读取单个会话 token 用量（v0.6.17，只读，不生成）

```json
{"type":"session_usage","sessionId":"s1"}
```

响应：`{"type":"session_usage","sessionId":"s1","stats":{"sessionId":"s1","promptTokens":100,"completionTokens":50,"cacheReadTokens":40,"cacheWriteTokens":0,"estimatedCostUsd":0.0001,"cacheSavedUsd":0.00002,"totalTokens":150,"callCount":2,"perModel":[{"model":"deepseek-chat","calls":2,"promptTokens":100,"completionTokens":50,"cacheReadTokens":40,"totalTokens":150}]}}`

- 按会话过滤 usage_log：宿主面板"本会话用量/成本"数据源（区别于 get_usage 的全局汇总）
- `callCount`：该会话的 LLM 调用次数；无用量记录的会话返回全 0（幂等，不抛错）
- `perModel`（v0.6.52）：本会话按模型分组的用量分解（`model` / `calls` / `promptTokens` /
  `completionTokens` / `cacheReadTokens` / `totalTokens`，按调用次数降序；v0.6.65 起每项含
  `cacheSavedUsd`）——与 get_usage 的 perModel 对称，宿主面板"本会话用量"可直接显示每个模型的
  缓存命中分布（无需从全局统计里筛）
- `cacheSavedUsd`（v0.6.64）：本会话缓存命中省下的成本——与 get_usage 的 `cacheSavedUsd` 同口径
  （未命中价 − 命中价差值；无法定价模型不计入；无命中时为 0）
- 无 `sessionId` 时默认会话 `default`；只读，不触发生成

### 10. context_status — 读取会话上下文占用（v0.5.6，只读，不生成）

```json
{"type":"context_status","sessionId":"s1"}
```

响应：`{"type":"context_status","sessionId":"s1","messageCount":31,"estimatedTokens":2143}`

- `messageCount`：当前会话上下文中的消息数（含 system 提示；会话为空时至少 1）
- `estimatedTokens`：上下文估算 token 数（CJK 1 字符≈1 / 非 CJK 4 字符≈1 / 消息结构 +4 / tool_calls +3 / 图片≈85，启发式非精确）
- 宿主 AI 面板显示\"上下文占用/成本预估\"、接近上限提醒时使用；只读，不触发生成
- 无 `sessionId` 时默认会话 `default`；同会话多次调用随对话增长而增大

#### 10.1 预算建议（v0.6.4，可选参数）

```json
{"type":"context_status","sessionId":"s1","budgetTokens":4000,"reserveForOutput":500}
```

响应附加 `suggestion` 字段：

```json
{"type":"context_status","sessionId":"s1","messageCount":31,"estimatedTokens":2143,
 "suggestion":{"keepIndexes":[0,29,30],"droppedCount":28,"estimatedKeptTokens":1890,"estimatedDroppedTokens":253}}
```

- `budgetTokens`：上下文 token 预算（正整数）。带此参数时按建议式裁剪（system 保底 + 最近优先，见 `suggestTrim`）计算应保留哪些消息
- `reserveForOutput`（可选）：为模型输出预留的 token 数（非负数值），保留部分最多占 `budgetTokens - reserveForOutput`
- `suggestion.keepIndexes`：建议保留的消息在上下文中的索引（单调递增，首条必为 0 即 system 保底；宿主回传 `apply_trim` 即可让裁剪真正生效）
- `suggestion.droppedCount`：建议丢弃的消息数
- `suggestion.estimatedKeptTokens` / `suggestion.estimatedDroppedTokens`：保留/丢弃部分的估算 tokens
- 非法 `budgetTokens`（非正整数）或 `reserveForOutput`（负数）→ 回 `error`（含原因提示），不触发生成
- 宿主按预算自管理上下文的推荐流程：`context_status` 带预算取建议 → `apply_trim` 回传执行（v0.6.35，见 10.2；`set_context` 只能追加状态快照，不能删消息）

#### 10.2 apply_trim — 实际执行上下文裁剪（v0.6.35，不触发生成）

`context_status` 只返回裁剪**建议**；`apply_trim` 才是执行接口——立即裁剪 Agent 内存上下文，并同步删除记忆库中明确被裁的历史消息（重建 Agent 后裁剪依然生效）。双模式，任一必填：

```json
{"type":"apply_trim","sessionId":"s1","keepIndexes":[0,29,30]}
```

```json
{"type":"apply_trim","sessionId":"s1","budgetTokens":4000,"reserveForOutput":500}
```

响应：`{"type":"ok","sessionId":"s1","keptCount":3,"droppedCount":28,"messageCount":3,"estimatedKeptTokens":1890,"estimatedDroppedTokens":253}`

- `keepIndexes`（数组）：回传 `context_status` 建议的保留索引立即执行；元素必须是非负整数且 < 当前消息数（越界/负数/非整数 → `error` 含用法）
- `budgetTokens`（正整数）+ `reserveForOutput`（可选，非负数值）：服务器按 `suggestTrim` 计算保留集并执行（system 保底 + 最近优先 + tool_calls↔tool 配对保护）
- 安全规则：开头连续 system 块（稳定前缀/身份/记忆）无条件保底；只删除「构造时加载且被裁」的历史消息，`run`/`set_context` 新增与内存未加载的消息不受影响（不误删全量历史）；空数组保守不裁剪
- 响应 `keptCount` / `droppedCount`：保留/丢弃消息数；`messageCount`：裁剪后上下文消息数；`estimatedKeptTokens` / `estimatedDroppedTokens`：裁剪后保留/丢弃部分估算 tokens（宿主面板可展示裁剪效果）
- 两者都无 → `error`（用法提示）；只读操作不调 LLM、不触发生成

### 11. create_session — 显式创建会话（宿主会话管理）

```json
{"type":"create_session","sessionId":"s1","title":"网络调试"}
```

响应：`{"type":"ok","sessionId":"s1"}`

- 幂等：会话已存在则更新标题（UPSERT），不报错
- 宿主管理会话列表、预建命名会话时使用（会话也可由 chat 首次写入时自动创建）

### 12. remember — 保存持久记忆（v0.5.4 记忆生命周期）

```json
{"type":"remember","content":"用户偏好深色主题","kind":"preference"}
```

响应：`{"type":"ok","sessionId":"default"}`

- `content`：要记住的内容（必填；缺失回 error）
- `kind`：记忆类型（可选，默认 `note`；注意不能叫 `type`——那是请求判别符）
- 宿主 AI 面板"记住"按钮、用户偏好写入时使用；记忆跨会话长期生效

### 13. get_memories — 读取记忆（列出或搜索，只读不生成）

```json
{"type":"get_memories"}                          // 列出全部（默认 50 条）
{"type":"get_memories","query":"深色主题"}        // 全文搜索（trigram FTS，中文友好）
{"type":"get_memories","query":"深色主题","limit":10}
{"type":"get_memories","kind":"preference"}      // 按记忆类型过滤（v0.6.25）
{"type":"get_memories","query":"偏好","kind":"preference"}  // 搜索 + 类型组合
```

响应：`{"type":"memories","memories":[{"id":1,"content":"...","type":"preference","created_at":"..."}]}`

- `query`：可选；有值 → `searchMemories`（trigram 全文检索 + bm25 排序），无值 → 列出全部
- `kind`：可选（v0.6.25）；按记忆类型过滤（如 `preference` 偏好 / `note` 笔记；与 remember 的
  `kind` 同语义）——只返回该类型的记忆；与 `query` 组合时先搜索再按类型过滤
- `limit`：可选，默认 50，合法范围 1~100 整数（非法值如 0/-1/101/非数字回 error 含用法提示，
  对齐 get_messages 校验风格，v0.6.25）
- 宿主面板展示/管理记忆、按类型筛选记忆时使用

### 14. delete_memory — 删除记忆（隐私管理）

```json
{"type":"delete_memory","id":3}                    // 按 id 删单条
{"type":"delete_memory","content":"深色主题"}       // 按内容关键词批量删
```

响应：`{"type":"ok","sessionId":"default","deleted":1}`

- `deleted`：删除条数（0 = 无匹配/不存在，幂等不报错）
- 同时给 `id` 和 `content` 时优先按 `id`
- FTS 检索索引由 DELETE 触发器联动清理（删除后 get_memories 搜索不再命中）

### 15. tool_result — 宿主回传工具执行结果（响应 tool_execute）

```json
{"type":"tool_result","id":"t_1","result":{"success":true,"output":"...","error":null}}
```

`result` 必须为 flare 的 ToolResult 对象：`{ success: boolean, output: string, error?: string, denied?: boolean, alternative?: boolean }`

### 16. mcp_status — 查看 MCP 服务器连接状态（v0.5.5）

```json
{"type":"mcp_status"}
```

响应：`{"type":"mcp_status","servers":[{"name":"fs","connected":true,"toolCount":8,"transport":"stdio","target":"npx @modelcontextprotocol/server-filesystem /tmp","resourceCount":2,"templateCount":1,"promptCount":2},{"name":"db","connected":false,"toolCount":0,"transport":"http","target":"http://127.0.0.1:8931/mcp","error":"..."}]}`

- 列出 `--mcp` 配置的每个服务器：`connected`（是否连接成功）、`toolCount`（桥接的工具数）、`error`（连接失败原因，可选）
- v0.6.26：已连接服务器额外带 `resourceCount`（桥接的资源数）/ `templateCount`（桥接的资源模板数，均为可选字段，向后兼容）
- v0.6.50：每个服务器带 `transport`（`stdio` 或 `http`——配置 url 走 HTTP，command 走 stdio）与 `target`（http 为端点 url，stdio 为 command + args）——宿主面板可区分两种连接方式并直接展示连接目标（必填字段，与旧协议兼容性：新增字段不破坏旧客户端）
- v0.6.70：HTTP transport 配置了 `headers` → 服务器带 `auth: true`（鉴权标记；**只传布尔不传 token**，宿主面板可显示「鉴权」徽标；stdio/未配置 → 缺省，向后兼容）
- 宿主 AI 面板展示/诊断外部 MCP 工具时使用；连接是启动时后台完成的，本请求会等待其落定

### 16.1 mcp_resources — 查看已连接 MCP 服务器的资源/模板清单（v0.6.26）

```json
{"type":"mcp_resources"}
```

响应：`{"type":"mcp_resources","servers":[{"name":"mock","connected":true,"toolCount":3,"resources":[{"uri":"memory://preferences","name":"用户偏好","description":"用户偏好设置","mimeType":"text/plain","server":"mock"}],"templates":[{"uriTemplate":"memory://{noteId}","name":"记忆条目","description":"记忆库中的单条记忆","mimeType":"text/plain","server":"mock"}]}]}`

- 资源桥接：连接外部 MCP 服务器时拉取 `resources/list` + `resources/templates/list`（服务器无资源能力/请求失败 → 空数组，不阻塞连接）
- 已连接服务器带 `resources`（资源元数据数组，每项含来源 `server` 名）与 `templates`（动态资源 uri 模板数组）；未连接服务器不带这两个字段（仅 `connected:false` + 可选 `error`）
- 只读，不触发生成、不创建会话；等待启动时的后台连接落定（与 `mcp_status` 一致）
- 宿主 AI 面板「外部 MCP 资源」数据源：展示/透传外部服务器暴露的资源与动态资源形态

### 16.2 mcp_prompts — 查看已连接 MCP 服务器的提示词清单（v0.6.36）

```json
{"type":"mcp_prompts"}
```

响应：`{"type":"mcp_prompts","servers":[{"name":"mock","connected":true,"toolCount":3,"prompts":[{"name":"greet","description":"打招呼","server":"mock"},{"name":"summarize","description":"总结内容","arguments":[{"name":"topic","description":"主题","required":true}],"server":"mock"}]}]}`

- prompts 桥接：连接外部 MCP 服务器时拉取 `prompts/list`（服务器无 prompts 能力/请求失败 → 空数组，不阻塞连接）
- 已连接服务器带 `prompts`（提示词元数据数组，每项含来源 `server` 名与可选 `arguments` 参数声明）；未连接服务器不带该字段（仅 `connected:false` + 可选 `error`）
- 渲染提示词内容（prompts/get 代理）由库级 `McpManager.getPrompt(name, promptName, args?)` 提供——宿主若需把外部提示词注入对话，可经该 API 渲染后组装消息（不触发生成、不创建会话）
- 只读，不触发生成、不创建会话；等待启动时的后台连接落定（与 `mcp_status` 一致）
- 宿主 AI 面板「外部 MCP 提示词」数据源：展示/透传外部服务器暴露的提示词模板

### 16.3 mcp_read_resource — 读取已连接 MCP 服务器的资源内容（v0.6.38）

```json
{"type":"mcp_read_resource","server":"mock","uri":"memory://preferences"}
```

响应：`{"type":"mcp_read_resource","server":"mock","uri":"memory://preferences","contents":[{"uri":"memory://preferences","mimeType":"text/plain","text":"主题: 浅色"}]}`

- `server`：必填，MCP 服务器名（`mcp_status`/`mcp_resources` 清单里的名称）
- `uri`：必填，资源唯一标识（`mcp_resources` 清单里的 `uri`，或动态模板匹配的 uri）
- 代理转发 `resources/read`（McpManager.readResource）——与 `mcp_resources`（清单）配套：清单只能看到元数据，本接口取**真实内容**，宿主面板可展示外部资源内容/把资源喂给 AI
- 错误：缺 `server`/`uri` → error 含用法；服务器未连接 → error「MCP 服务器未连接: <name>」；未知资源/读取失败 → 透传外部服务器错误（服务不崩）
- 只读，不触发生成、不创建会话；等待启动时的后台连接落定（与 `mcp_status` 一致）

### 16.4 mcp_get_prompt — 渲染已连接 MCP 服务器的提示词（v0.6.38）

```json
{"type":"mcp_get_prompt","server":"mock","prompt":"summarize","args":{"topic":"flare 引擎"}}
```

响应：`{"type":"mcp_get_prompt","server":"mock","prompt":"summarize","description":"总结内容","messages":[{"role":"user","content":{"type":"text","text":"请总结关于「flare 引擎」的内容"}}]}`

- `server`：必填，MCP 服务器名（`mcp_status`/`mcp_prompts` 清单里的名称）
- `prompt`：必填，提示词名（`mcp_prompts` 清单里的 `name`）
- `args`：可选，提示词参数（对象；按服务器 `arguments` 声明补全，如 `{topic: "..."}`）
- 代理转发 `prompts/get`（McpManager.getPrompt）——与 `mcp_prompts`（清单）配套：清单只能看到元数据，本接口返回**渲染后的消息序列**（`description` 可选、`messages` 每项 `{role, content:{type:'text',text}}`），宿主可把外部提示词注入对话/展示
- 错误：缺 `server`/`prompt` → error 含用法；服务器未连接 → error「MCP 服务器未连接: <name>」；未知提示词 → 透传外部服务器错误（服务不崩）
- 只读，不触发生成、不创建会话；等待启动时的后台连接落定（与 `mcp_status` 一致）

### 16.5 mcp_call — 调用已连接 MCP 服务器的工具（v0.6.40）

```json
{"type":"mcp_call","server":"mock","tool":"add_numbers","args":{"a":2,"b":3}}
```

响应（成功）：`{"type":"mcp_call","server":"mock","tool":"add_numbers","success":true,"output":"5"}`

响应（工具级失败）：`{"type":"mcp_call","server":"mock","tool":"fail_tool","success":false,"error":"出错了","output":"出错了"}`

- `server`：必填，MCP 服务器名（`mcp_status`/`mcp_resources` 清单里的名称）
- `tool`：必填，工具名（`tools` 请求清单里 `source:"mcp"` 的工具，或该服务器 tools/list 暴露的工具）
- `args`：可选，工具参数（JSON 对象，按该工具 inputSchema 传；缺省不传）
- 代理转发 `tools/call`（McpManager.callTool）——与 `tools`（清单）配套：清单只能看到工具元数据，
  本接口**直接执行**外部 MCP 工具，宿主面板可一键触发/调试外部工具；**工具级失败**（isError）
  返回 `success:false` + `error`（服务不崩，工具结果原样透传）
- 错误：缺 `server`/`tool` → error 含用法；服务器未连接 → error「MCP 服务器未连接: <name>」；
  未知工具/协议层错误 → 透传外部服务器错误（服务不崩）
- 不触发生成、不创建会话；等待启动时的后台连接落定（与 `mcp_status` 一致）

### 16.6 mcp_connect — 动态连接 MCP 服务器（v0.6.56，控制面补齐）

```json
{"type":"mcp_connect","server":"mock"}
```

响应（成功）：`{"type":"mcp_connect","server":"mock","connected":true,"toolCount":3,"transport":"stdio","target":"node .../mcp-mock-server.mjs"}`

- `server`：必填，MCP 服务器名（须在 `--mcp` 配置里；见 `mcp_status` 列表）
- 代理转发 `McpManager.connect`（**幂等**：已连接直接返回已有工具，不重复连接）
- 响应与 `mcp_status` **同源**：`connected` / `toolCount` / `transport`（`stdio`/`http`）/ `target`（stdio 为 command+args，http 为端点 url）+ 已连接时的资源/模板/提示词数——连接后宿主立即可见连到哪种传输、连到哪
- 连接成功后**清空缓存 Agent**：下次 `chat` 重建时新 MCP 工具并入工具集（与 CLI `/mcp connect` 的 onChanged 语义一致）
- 错误：缺 `server` → error 含用法；服务器未配置 → error「未配置 MCP 服务器: <name>」；连接失败（initialize/工具拉取失败）→ error 透传原因（服务不崩）
- 控制面补齐：`mcp_status` 只能观测，宿主无法让「配置了但启动时未连上/想按需连接」的服务器连上——本接口让宿主面板可动态启用外部 MCP 工具

### 16.7 mcp_disconnect — 动态断开 MCP 服务器（v0.6.56，控制面补齐）

```json
{"type":"mcp_disconnect","server":"mock"}
```

响应：`{"type":"mcp_disconnect","server":"mock","disconnected":true}`

- `server`：必填，MCP 服务器名（见 `mcp_status` 列表）
- 代理转发 `McpManager.disconnect`：断开后工具/资源/模板/提示词从桥接清单移除，**缓存 Agent 清空**（下次 `chat` 重建后工具集不再含该服务器工具）
- 未连接的服务器 → `disconnected:false`（幂等，不回 error）；缺 `server` → error 含用法
- 等待启动时的后台连接落定（与 `mcp_status`/`mcp_call` 一致，保证断开的是真实连接）

### 16.8 mcp_complete — 请求 MCP 提示词参数补全候选（v0.6.57）

```json
{"type":"mcp_complete","server":"mock","prompt":"summarize","argument":"topic","value":"flare"}
```

响应：`{"type":"mcp_complete","server":"mock","prompt":"summarize","argument":"topic","value":"flare","values":["flare 缓存","flare MCP","flare 上下文","flare 用量"],"total":4,"hasMore":false}`

- `server`：必填，MCP 服务器名（见 `mcp_status` 列表）
- `prompt`：必填，提示词名（见 `mcp_prompts` 清单）
- `argument`：必填，要补全的参数名（该提示词声明了补全能力的参数；无补全能力 → 空 values 或协议错误透传）
- `value`：可选，当前已输入值（服务器按前缀建议候选；缺省空串）
- 代理转发 `completion/complete`（McpManager.completePrompt）——与 `mcp_get_prompt`（渲染）配套：
  宿主渲染提示词时对带补全声明的参数给出候选值，可做参数自动补全输入
- 错误：缺 `server`/`prompt`/`argument` → error 含用法；服务器未连接 → error「MCP 服务器未连接: <name>」；
  未知提示词/参数（服务器协议错误）→ 透传（服务不崩）
- 不触发生成、不创建会话；等待启动时的后台连接落定（与 `mcp_status` 一致）

### 16.9 mcp_tools — 查看已连接 MCP 服务器的工具清单（v0.6.58）

```json
{"type":"mcp_tools"}
```

响应：`{"type":"mcp_tools","servers":[{"name":"mock","connected":true,"toolCount":3,"tools":[{"name":"echo_text","description":"回显输入文本","server":"mock"},{"name":"add_numbers","description":"两个数相加","server":"mock"},{"name":"fail_tool","description":"总是失败的工具（测 isError 映射）","server":"mock"}]}]}`

- 无参数；按服务器分组返回（与 `mcp_resources`/`mcp_prompts` 同形状）：`servers[]` 每项含
  `name`/`connected`/`toolCount`，已连接时带 `tools[]`（每项 `name`/`description?`/`server` 来源名），
  连接失败时带 `error`
- 与 `mcp_status` 对称补齐：`mcp_status` 只能看到 **toolCount 数量**，宿主面板看不到具体工具
  名/描述——本接口返回工具桥接清单（连接时拉取 `tools/list`），宿主在 `mcp_call` 前可先发现
  可用工具（名称/描述），面板可直接展示/搜索
- 只读，不触发生成、不创建会话；等待启动时的后台连接落定（与 `mcp_status` 一致）

### 17. confirm_result — 回传用户确认决策（v0.6.1，响应 confirm 事件）

```json
{"type":"confirm_result","id":"c_1","decision":"allow_once"}
```

- `id`：必填，`confirm` 事件携带的确认请求 id
- `decision`：必填，合法值 `allow_once` / `allow_session` / `always` / `deny` / `alternative`
  （与 ConfirmationGate 决策一致；`deny` 拒绝、`alternative` 要求替代方案，均不执行工具）
- 缺 `id` / 非法 `decision` → 回 `error`（含合法值提示）；未知 `id`（已超时/不存在）→ 静默忽略（不污染事件流）
- 宿主弹窗让用户决策后回传；宿主未在时限内（默认 30s，`--confirm-timeout` 可配）回传 → 按安全默认 `deny` 处理
  （工具结果带超时提示，AI 收到拒绝后自然调整策略）
- `confirm` 事件（v0.6.27）可选带 `description`（工具描述）——宿主弹窗可展示说明行「AI 想做什么」；无描述不输出字段

### 18. confirm_status — 查询确认门状态（v0.6.8，确认门管理）

```json
{"type":"confirm_status","sessionId":"s1"}
```

响应：`{"type":"confirm_status","sessionId":"s1","confirmTools":["memory_save"],"allowedTools":[],"sessionAllowed":[],"alwaysAllowed":[]}`

- `sessionId`：可选，缺省 `default`——按会话查询（allow_session 放行按会话隔离）
- `confirmTools`：当前确认名单配置（`--confirm-tools` 可扩展；空数组 = 确认门关闭）
- `allowedTools`：完整放行名单（会话级 + always 持久化合并去重）——这些工具执行前不再弹窗
- `sessionAllowed`：会话级放行（allow_session / 本会话内的 always）；`alwaysAllowed`：持久化放行（跨会话）
- 只读查询：无放行记录时三名单均为空数组；不创建会话、不触发生成

### 19. confirm_revoke — 撤销确认门放行（v0.6.8，确认门管理）

```json
{"type":"confirm_revoke","sessionId":"s1","tool":"memory_save"}
{"type":"confirm_revoke","sessionId":"s1","resetSession":true}
```

- `tool`：撤销该工具的放行（会话级 + always 持久化同步清除，恢复每次确认）
- `resetSession: true`：清空会话级放行（不影响 always 持久化——跨会话记住的"总是允许"需逐个 `tool` 撤销）
- `tool` 与 `resetSession` 至少其一，否则回 `error`（含用法提示）
- 响应：`{"type":"ok","sessionId","tool"?,"resetSession"?}`；无放行记录时幂等 ok（服务不崩、状态不变）

### 21. confirm_allow — 显式放行确认工具（v0.6.10，确认门管理）

```json
{"type":"confirm_allow","sessionId":"s1","tool":"memory_save"}
{"type":"confirm_allow","sessionId":"s1","tool":"memory_save","mode":"always"}
```

- `tool`：要放行的工具名（必填，缺省回 `error` 含用法提示）——宿主面板操作，无需等 AI 触发 confirm 事件
- `mode`：可选，`session`（默认，本会话内不再确认）| `always`（跨会话持久化到记忆库 settings 表，新会话也放行）；
  其他值回 `error`（含合法值提示）
- 响应：`{"type":"ok","sessionId","tool","mode"}`；与 `confirm_status`（查询）/ `confirm_revoke`（撤销）组成确认门管理闭环
- 注意：`mode=always` 放行的工具在**当前会话内**也同时放行（`confirm_status.allowedTools` 可见）；仅跨会话持久化部分由 `alwaysAllowed` 体现

### 20. models — 查询可切换模型（v0.6.9，只读）

```json
{"type":"models"}
```

响应：`{"type":"models","configured":{"main":{"model":"deepseek-chat","baseURL":"https://api.deepseek.com/v1","hasApiKey":true,"provider":"deepseek"},"vision":null},"ollama":{"ok":true,"models":[{"name":"qwen2.5:7b","size":4700000000,"modifiedAt":"2026-08-01T00:00:00Z"}]}}`

- `configured.main`：当前主模型端点信息（`DEFAULT_MODEL` 解析）——`model` / `baseURL`（解析后端点）/ `hasApiKey`（密钥是否已配置）/ `provider`（`ollama` | `deepseek` | `openai` | `other`）
- `configured.vision`：视觉模型（`VISION_MODEL` 配置；未配置为 `null`）
- `ollama`：本地 Ollama 已拉取模型列表（复用 `listOllamaModels`）——宿主面板"可切换模型"数据源
- 降级安全：Ollama 未启动/不可达 → `ollama.ok:false` + `error`（服务不崩、其余字段照常）；主模型为 Claude 系列（不支持）→ `configured.main.error` 明确报错，不抛异常
- 只读查询：不触发生成、不创建会话

### 22. tools — 查询当前会话 Agent 可用工具清单（v0.6.11，只读）

```json
{"type":"tools"}
{"type":"tools","sessionId":"s1"}
```

响应：`{"type":"tools","sessionId":"s1","tools":[{"name":"memory_save","description":"保存一条持久记忆","parameters":{...},"confirmed":true,"source":"builtin"},{"name":"host_echo","description":"宿主回显工具","confirmed":false,"source":"host"}],"confirmTools":["memory_save"]}`

- `tools`：该会话 Agent 当前工具集（chat 带宿主工具后即反映；未 chat 过则默认内置工具集）——每项：
  - `name` / `description` / `parameters`（JSON Schema，缺省不带）：工具定义
  - `confirmed`：是否经确认门（命中 `confirmTools` 名单）——宿主面板"写回类工具需确认"标注
  - `source`：来源——`host`（宿主代理工具）/ `profile`（专家配置）/ `mcp`（外部 MCP 服务器）/ `builtin`（内置回退）
- `confirmTools`：当前确认名单配置（宿主可据此展示"哪些写回类工具需确认"）
- 只读查询：不触发生成、不创建会话（与 `models`/`context_status` 同级）

### 23. rename_session — 重命名会话（v0.6.18）

```json
{"type":"rename_session","sessionId":"s1","title":"新的会话标题"}
```

响应：`{"type":"ok","sessionId":"s1","title":"新的会话标题"}`

- `sessionId`：要重命名的会话标识（缺省 `default`）；复用 `MemoryStore.updateSessionTitle`（UPSERT——会话不存在时自动创建，与 `create_session` 同语义）
- `title`：必填，非空字符串（空白裁剪后判空）——缺失/空白回 error（含用法提示），不触发生成
- 与 `create_session`（创建语义，可幂等设标题）区分：`rename_session` 是宿主面板"重命名会话"的专用接口，语义清晰、只改标题不动其他数据

### 24. clear_session — 清空会话消息（v0.6.18）

```json
{"type":"clear_session","sessionId":"s1"}
```

响应：`{"type":"ok","sessionId":"s1","cleared":3}`

- `sessionId`：要清空的会话标识（缺省 `default`）
- 清空该会话全部消息（`MemoryStore.clearSessionMessages`，返回删除条数 `cleared`），**保留会话记录与用量统计**——区别于 `delete_session`（整个会话删除）：宿主面板"清空对话"按钮数据源
- 同时销毁该会话缓存 Agent（内存上下文同步清空；下次 chat 自动重建干净会话，与 delete_session 同模式）
- 幂等安全：空/不存在会话 `cleared:0` 不报错；清空后仍可继续写入（会话记录未删，无外键问题）；FTS 检索索引由触发器联动清理

### 25.1 会话归档（v0.6.31）：end_session / restore_session / list_archived_sessions

```json
{"type":"end_session","sessionId":"s1"}
{"type":"restore_session","sessionId":"s1"}
{"type":"list_archived_sessions"}
```

响应：`{"type":"ok","sessionId":"s1","archived":true}` / `{"type":"ok","sessionId":"s1","restored":true}` / `{"type":"archived_sessions","sessions":[{"id":"s1","title":"标题","updatedAt":"...","preview":"..."}]}`

- `end_session`：归档会话——标记 `archived=1`（**数据保留**：消息/用量都在，区别于 `delete_session` 整个删除），从 `recent_sessions` 隐藏；同时销毁缓存 Agent（下次 chat 自动重建）；宿主面板"归档会话"按钮数据源；会话不存在幂等 `archived:false` 不报错
- `restore_session`：恢复归档会话——标记 `archived=0`，重新出现在最近会话；不存在幂等 `restored:false`
- `list_archived_sessions`：列出归档会话（结构同 `recent_sessions` 含首条 user 消息预览），宿主面板"已归档"视图数据源；只读不触发生成、不创建会话
- `list_sessions` 响应每项带 `archived` 布尔字段（增量字段，向后兼容；宿主可据此在会话列表显示归档标记/筛选）

### 25. get_config — 查询服务器运行配置（v0.6.18，只读）

```json
{"type":"get_config"}
```

响应：`{"type":"config","confirmTools":["memory_save"],"confirmTimeoutMs":30000,"defaultMaxTokens":null,"defaultTemperature":null,"defaultMaxContextMessages":null,"defaultMaxContextTokens":null,"defaultContextSummarize":null,"defaultToolOutputPolicy":null,"toolTimeoutMs":30000,"namespace":null,"storage":"/path/flare.db","mcpServers":[{"name":"fs","transport":"stdio"}]}`

- 宿主面板"设置/关于"数据源：确认门配置（`confirmTools` 名单 / `confirmTimeoutMs` 超时）、默认采样参数（`defaultMaxTokens` / `defaultTemperature`，未配置为 null）、默认上下文裁剪参数（`defaultMaxContextMessages` / `defaultMaxContextTokens` / `defaultContextSummarize` 压缩摘要开关（v0.6.19），未配置为 null）、默认工具输出治理策略（`defaultToolOutputPolicy`，v0.6.34，未配置为 null）、`toolTimeoutMs` 工具超时、`namespace` 记忆隔离标识（无则 null）、`storage` 存储路径（非字符串配置为 null）、`mcpServers` MCP 服务器清单（名称 + 传输类型 http/stdio；v0.6.73：HTTP 配置了 `headers` → 带 `auth: true` 鉴权标记，只传布尔不传 token）
- 只读查询：不触发生成、不创建会话；**不含任何密钥/敏感配置**

## 响应（服务 → 宿主，stdout 每行一个）

| type | 字段 | 说明 |
|------|------|------|
| `text` | `sessionId, content` | AI 生成的文本块（流式） |
| `tool_call` | `sessionId, name, args` | AI 请求调用工具 |
| `tool_execute` | `id, name, args` | **请求宿主执行工具**（宿主回 `tool_result`） |
| `confirm` | `sessionId, id, name, args, description?` | **请求宿主弹窗确认**（v0.6.1，宿主回 `confirm_result`；写回类工具经确认门；`description` 工具描述 v0.6.27，可选） |
| `tool_result` | `sessionId, name, content` | 工具执行结果摘要（喂回 AI） |
| `done` | `sessionId` | 本轮生成结束 |
| `cancelled` | `sessionId` | 生成被取消 |
| `error` | `message` | 错误（含未配置 key 等） |
| `sessions` | `sessions` | 会话列表 |
| `recent_sessions` | `sessions` | 最近会话列表（含 preview，v0.6.0） |
| `search_sessions` | `query, sessions` | 会话搜索结果（search_sessions 响应，v0.6.43） |
| `messages` | `sessionId, messages` | 指定会话的消息历史 |
| `memories` | `memories` | 记忆列表（get_memories 响应） |
| `ok` | `sessionId, deleted?/tool?/resetSession?/mode?/title?/cleared?` | 通用确认（set_context/cancel/create_session/rename_session/clear_session/delete_session/remember/delete_memory/confirm_revoke/confirm_allow） |
| `pong` | `ts` | ping 响应（宿主健康检查） |
| `version` | `protocol, engine` | 版本协商（协议版本 + 引擎版本） |
| `usage` | `stats` | token 用量统计（get_usage 响应；v0.6.18 起 stats 含 `perModel` 按模型分解） |
| `mcp_status` | `servers` | MCP 服务器连接状态（mcp_status 响应，v0.5.5） |
| `confirm_status` | `sessionId, confirmTools, allowedTools, sessionAllowed, alwaysAllowed` | 确认门状态（confirm_status 响应，v0.6.8） |
| `models` | `configured, ollama` | 可切换模型（models 响应，v0.6.9） |
| `tools` | `sessionId, tools, confirmTools` | Agent 工具清单（tools 响应，v0.6.11） |
| `config` | `confirmTools, confirmTimeoutMs, defaultMaxTokens, defaultTemperature, defaultMaxContextMessages, defaultMaxContextTokens, toolTimeoutMs, namespace, storage, mcpServers` | 服务器运行配置（get_config 响应，v0.6.18，只读） |
| `mcp_read_resource` | `server, uri, contents` | 外部 MCP 资源内容（mcp_read_resource 响应，v0.6.38） |
| `mcp_get_prompt` | `server, prompt, description?, messages` | 外部 MCP 提示词渲染结果（mcp_get_prompt 响应，v0.6.38） |
| `mcp_call` | `server, tool, success, output?, error?` | 外部 MCP 工具调用结果（mcp_call 响应，v0.6.40） |
| `mcp_connect` | `server, connected, toolCount, transport, target, resourceCount?, templateCount?, promptCount?` | MCP 服务器动态连接结果（v0.6.56，与 mcp_status 同源） |
| `mcp_disconnect` | `server, disconnected` | MCP 服务器动态断开结果（v0.6.56） |
| `mcp_complete` | `server, prompt, argument, value?, values, total?, hasMore?` | MCP 提示词参数补全候选（v0.6.57） |

## 工具执行流（宿主代理工具）

```
宿主 → chat(带 tools)
服务 → tool_call（AI 决定调用）
服务 → tool_execute {id, name, args}    ← 宿主收到
宿主 → tool_result {id, result}          ← 宿主执行后回传
服务 → tool_result（喂回 AI）
服务 → text / done
```

宿主收到 `tool_execute` 后应尽快回 `tool_result`（服务侧默认 30s 超时返回"工具执行超时"）。

## 确认流（v0.6.1，写回类工具经确认门）

AI 调用需确认的工具（默认 `memory_save`；`flare server --confirm-tools` 可扩展名单）时：

```
服务 → confirm {sessionId, id, name, args, description?}   ← 宿主收到：弹窗让用户决策（description 工具描述 v0.6.27，弹窗可展示「AI 想做什么」）
宿主 → confirm_result {id, decision}          ← 用户决策：allow_once/allow_session/always/deny/alternative
服务 → 执行工具（allow_*）或返回拒绝（deny/alternative）
服务 → tool_result（结果/拒绝喂回 AI）
```

- `allow_session`：本会话内该工具不再重复确认（跨模型重建保留）；`always`：持久化到记忆库 settings 表，跨会话记住
- 宿主未回 `confirm_result` 超时（默认 30s，`--confirm-timeout` 可配）→ 安全默认 `deny`
- `deny` / `alternative` 不执行原工具，AI 收到拒绝提示后自然调整策略
- `description`（v0.6.27）：工具定义有描述时带上（如 `memory_save` 的「保存一条持久记忆…」）——宿主确认弹窗可展示说明行
  「AI 想做什么」而非只有工具名+参数；工具无描述（如宿主注入的空描述工具）不输出该字段，向后兼容（旧宿主忽略未知字段）

## 确认门管理（v0.6.8/v0.6.10）

宿主可随时查询/放行/撤销（如面板"已自动放行的工具"开关）：

```json
{"type":"confirm_status","sessionId":"s1"}          → 确认名单 + 会话级/持久化放行名单（只读）
{"type":"confirm_allow","sessionId":"s1","tool":"memory_save"}          → 显式放行（本会话，v0.6.10）
{"type":"confirm_allow","sessionId":"s1","tool":"memory_save","mode":"always"} → 显式放行（跨会话持久化）
{"type":"confirm_revoke","sessionId":"s1","tool":"memory_save"}   → 撤销该工具放行（恢复每次确认）
{"type":"confirm_revoke","sessionId":"s1","resetSession":true}    → 清空会话级放行（不影响 always 持久化）
```

- `confirm_status` 无放行记录时返回空名单（不创建会话）；`confirm_revoke` 无放行记录时幂等 ok；
  `confirm_allow` 缺 tool / 非法 mode 回 `error`（含用法提示）
- 宿主 UI 集成建议：确认弹窗内提供"管理已放行"入口 → `confirm_status` 列出 → 用户关闭某项 → `confirm_revoke`；
  "信任此工具"按钮 → `confirm_allow mode=always`（无需等下次触发确认）
- 完整语义见 §18 / §19 / §21

## 取消流

宿主发 `cancel` → 服务设置取消标志 → 当前 `chat` 循环尽快停止 → 回 `cancelled`（不再回 `done`）。

## 错误处理

- 未配置 key：`{"type":"error","message":"未配置 API 密钥..."}`（chat 请求的响应）
- 未知请求类型：`{"type":"error","message":"未知请求类型: xxx"}`
- JSON 解析失败：`{"type":"error","message":"JSON 解析失败: ..."}`

## 最小示例

```bash
# 服务端
flare server --profile examples/network-expert.json &

# 宿主发请求
echo '{"type":"chat","sessionId":"s1","input":"你好"}' | flare server --profile examples/network-expert.json
# → {"type":"text","sessionId":"s1","content":"我是 pulse 助手..."}
# → {"type":"done","sessionId":"s1"}
```

## 与同进程 import 的关系

- Electron 宿主：继续用 `new Agent(...)` 同进程 import（无 IPC 开销）
- Qt / 其他非 Node 宿主：用本协议（`flare server` 子进程）
- 两者共享同一 Agent/Expert 配置语义，宿主侧只需实现最小通信层
