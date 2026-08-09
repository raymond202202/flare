# Flare 宿主协议（最小版）

> 供非 Node 宿主（如 Qt 应用）调用 flare 引擎的本地协议。
> 传输：stdin/stdout · JSON Lines（每行一个 JSON 对象）
> 实现：`src/server.ts`（`flare server` 命令）
> 请求类型：chat / cancel / set_context / list_sessions / recent_sessions / get_messages / get_usage / context_status / ping / version / create_session / delete_session / remember / get_memories / delete_memory / tool_result / confirm_result / confirm_status / confirm_revoke / confirm_allow / models / tools / mcp_status

## 启动

```bash
flare server --profile <expert-profile-file> --storage <db-path> [--mcp <mcp-config.json>]
```

- `--profile`：ExpertProfile JSON 文件（name/identity/systemPrompt/tools）
- `--storage`：记忆库路径（默认 `~/.flare-data/`）
- `--mcp`（可选，v0.5.5）：MCP 服务器配置 JSON——`{ "servers": [{ "name", "command", "args", "env" }] }`。
  启动时连接各 MCP 服务器（stdio），其工具并入每个会话的 Agent 工具集（与宿主代理工具/专家工具并存）；
  连接失败不阻塞服务（`mcp_status` 可见错误）。例：
  ```json
  { "servers": [{ "name": "fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }] }
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

### 5. get_messages — 读取指定会话消息历史（只读，不生成）

```json
{"type":"get_messages","sessionId":"s1"}
```

响应：`{"type":"messages","sessionId":"s1","messages":[...]}`——宿主展示历史对话、会话恢复时读取。

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

响应：`{"type":"usage","stats":{"promptTokens":123,"completionTokens":456,"totalTokens":579,"sessionCount":3}}`

- 宿主展示用量统计（成本监控）、AI 面板显示 token 消耗时使用
- 与 get_messages 一样只读，不触发生成

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
- `suggestion.keepIndexes`：建议保留的消息在上下文中的索引（单调递增，首条必为 0 即 system 保底；宿主按索引裁剪后回 `set_context` 即可让裁剪生效）
- `suggestion.droppedCount`：建议丢弃的消息数
- `suggestion.estimatedKeptTokens` / `suggestion.estimatedDroppedTokens`：保留/丢弃部分的估算 tokens
- 非法 `budgetTokens`（非正整数）或 `reserveForOutput`（负数）→ 回 `error`（含原因提示），不触发生成
- 宿主按预算自管理上下文的推荐流程：`context_status` 带预算取建议 → 裁剪 → `set_context` 回写（零 agent.ts 改动）

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
```

响应：`{"type":"memories","memories":[{"id":1,"content":"...","type":"preference","created_at":"..."}]}`

- `query`：可选；有值 → `searchMemories`（trigram 全文检索 + bm25 排序），无值 → 列出全部
- `limit`：可选，默认 50，上限 100
- 宿主面板展示/管理记忆时使用

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

响应：`{"type":"mcp_status","servers":[{"name":"fs","connected":true,"toolCount":8},{"name":"db","connected":false,"toolCount":0,"error":"..."}]}`

- 列出 `--mcp` 配置的每个服务器：`connected`（是否连接成功）、`toolCount`（桥接的工具数）、`error`（连接失败原因，可选）
- 宿主 AI 面板展示/诊断外部 MCP 工具时使用；连接是启动时后台完成的，本请求会等待其落定

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

## 响应（服务 → 宿主，stdout 每行一个）

| type | 字段 | 说明 |
|------|------|------|
| `text` | `sessionId, content` | AI 生成的文本块（流式） |
| `tool_call` | `sessionId, name, args` | AI 请求调用工具 |
| `tool_execute` | `id, name, args` | **请求宿主执行工具**（宿主回 `tool_result`） |
| `confirm` | `sessionId, id, name, args` | **请求宿主弹窗确认**（v0.6.1，宿主回 `confirm_result`；写回类工具经确认门） |
| `tool_result` | `sessionId, name, content` | 工具执行结果摘要（喂回 AI） |
| `done` | `sessionId` | 本轮生成结束 |
| `cancelled` | `sessionId` | 生成被取消 |
| `error` | `message` | 错误（含未配置 key 等） |
| `sessions` | `sessions` | 会话列表 |
| `recent_sessions` | `sessions` | 最近会话列表（含 preview，v0.6.0） |
| `messages` | `sessionId, messages` | 指定会话的消息历史 |
| `memories` | `memories` | 记忆列表（get_memories 响应） |
| `ok` | `sessionId, deleted?/tool?/resetSession?/mode?` | 通用确认（set_context/cancel/create_session/delete_session/remember/delete_memory/confirm_revoke/confirm_allow） |
| `pong` | `ts` | ping 响应（宿主健康检查） |
| `version` | `protocol, engine` | 版本协商（协议版本 + 引擎版本） |
| `usage` | `stats` | token 用量统计（get_usage 响应） |
| `mcp_status` | `servers` | MCP 服务器连接状态（mcp_status 响应，v0.5.5） |
| `confirm_status` | `sessionId, confirmTools, allowedTools, sessionAllowed, alwaysAllowed` | 确认门状态（confirm_status 响应，v0.6.8） |
| `models` | `configured, ollama` | 可切换模型（models 响应，v0.6.9） |
| `tools` | `sessionId, tools, confirmTools` | Agent 工具清单（tools 响应，v0.6.11） |

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
服务 → confirm {sessionId, id, name, args}   ← 宿主收到：弹窗让用户决策
宿主 → confirm_result {id, decision}          ← 用户决策：allow_once/allow_session/always/deny/alternative
服务 → 执行工具（allow_*）或返回拒绝（deny/alternative）
服务 → tool_result（结果/拒绝喂回 AI）
```

- `allow_session`：本会话内该工具不再重复确认（跨模型重建保留）；`always`：持久化到记忆库 settings 表，跨会话记住
- 宿主未回 `confirm_result` 超时（默认 30s，`--confirm-timeout` 可配）→ 安全默认 `deny`
- `deny` / `alternative` 不执行原工具，AI 收到拒绝提示后自然调整策略

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
