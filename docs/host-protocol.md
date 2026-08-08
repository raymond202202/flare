# Flare 宿主协议（最小版）

> 供非 Node 宿主（如 Qt 应用）调用 flare 引擎的本地协议。
> 传输：stdin/stdout · JSON Lines（每行一个 JSON 对象）
> 实现：`src/server.ts`（`flare server` 命令）
> 请求类型：chat / cancel / set_context / list_sessions / get_messages / get_usage / ping / version / create_session / delete_session / remember / get_memories / delete_memory / tool_result

## 启动

```bash
flare server --profile <expert-profile-file> --storage <db-path>
```

- `--profile`：ExpertProfile JSON 文件（name/identity/systemPrompt/tools）
- `--storage`：记忆库路径（默认 `~/.flare-data/`）
- 环境变量注入 API key（如 `DEEPSEEK_API_KEY=...`），与现有 Agent 一致

## 请求（宿主 → 服务，stdin 每行一个）

### 1. chat — 发起对话（流式）

```json
{"type":"chat","sessionId":"s1","input":"帮我分析这个报错","context":"（可选状态快照）","tools":[<ToolDefinition>...],"model":"qwen2.5:7b"}
```

- `sessionId`：会话标识（同 id 连续对话，历史累积）
- `context`：可选，调用 `setContext` 注入宿主状态快照
- `tools`：可选，宿主声明的工具定义；服务为会话创建"宿主代理工具"（执行时经 `tool_execute` 事件问宿主）
- `model`：可选（v0.5.2），指定该会话主模型——本地 Ollama（如 `qwen2.5:7b`，自动走 localhost:11434/v1）/ 远端（如 `deepseek-chat`）；缺省用默认路由（.env DEFAULT_MODEL）；同一会话切换 model 会自动重建 Agent（历史从记忆库恢复）

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

### 10. create_session — 显式创建会话（宿主会话管理）

```json
{"type":"create_session","sessionId":"s1","title":"网络调试"}
```

响应：`{"type":"ok","sessionId":"s1"}`

- 幂等：会话已存在则更新标题（UPSERT），不报错
- 宿主管理会话列表、预建命名会话时使用（会话也可由 chat 首次写入时自动创建）

### 11. remember — 保存持久记忆（v0.5.4 记忆生命周期）

```json
{"type":"remember","content":"用户偏好深色主题","kind":"preference"}
```

响应：`{"type":"ok","sessionId":"default"}`

- `content`：要记住的内容（必填；缺失回 error）
- `kind`：记忆类型（可选，默认 `note`；注意不能叫 `type`——那是请求判别符）
- 宿主 AI 面板"记住"按钮、用户偏好写入时使用；记忆跨会话长期生效

### 12. get_memories — 读取记忆（列出或搜索，只读不生成）

```json
{"type":"get_memories"}                          // 列出全部（默认 50 条）
{"type":"get_memories","query":"深色主题"}        // 全文搜索（trigram FTS，中文友好）
{"type":"get_memories","query":"深色主题","limit":10}
```

响应：`{"type":"memories","memories":[{"id":1,"content":"...","type":"preference","created_at":"..."}]}`

- `query`：可选；有值 → `searchMemories`（trigram 全文检索 + bm25 排序），无值 → 列出全部
- `limit`：可选，默认 50，上限 100
- 宿主面板展示/管理记忆时使用

### 13. delete_memory — 删除记忆（隐私管理）

```json
{"type":"delete_memory","id":3}                    // 按 id 删单条
{"type":"delete_memory","content":"深色主题"}       // 按内容关键词批量删
```

响应：`{"type":"ok","sessionId":"default","deleted":1}`

- `deleted`：删除条数（0 = 无匹配/不存在，幂等不报错）
- 同时给 `id` 和 `content` 时优先按 `id`
- FTS 检索索引由 DELETE 触发器联动清理（删除后 get_memories 搜索不再命中）

### 14. tool_result — 宿主回传工具执行结果（响应 tool_execute）

```json
{"type":"tool_result","id":"t_1","result":{"success":true,"output":"...","error":null}}
```

`result` 必须为 flare 的 ToolResult 对象：`{ success: boolean, output: string, error?: string, denied?: boolean, alternative?: boolean }`

## 响应（服务 → 宿主，stdout 每行一个）

| type | 字段 | 说明 |
|------|------|------|
| `text` | `sessionId, content` | AI 生成的文本块（流式） |
| `tool_call` | `sessionId, name, args` | AI 请求调用工具 |
| `tool_execute` | `id, name, args` | **请求宿主执行工具**（宿主回 `tool_result`） |
| `tool_result` | `sessionId, name, content` | 工具执行结果摘要（喂回 AI） |
| `done` | `sessionId` | 本轮生成结束 |
| `cancelled` | `sessionId` | 生成被取消 |
| `error` | `message` | 错误（含未配置 key 等） |
| `sessions` | `sessions` | 会话列表 |
| `messages` | `sessionId, messages` | 指定会话的消息历史 |
| `memories` | `memories` | 记忆列表（get_memories 响应） |
| `ok` | `sessionId, deleted?` | 通用确认（set_context/cancel/create_session/delete_session/remember/delete_memory） |
| `pong` | `ts` | ping 响应（宿主健康检查） |
| `version` | `protocol, engine` | 版本协商（协议版本 + 引擎版本） |
| `usage` | `stats` | token 用量统计（get_usage 响应） |

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
