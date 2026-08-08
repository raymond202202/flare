# Flare 宿主协议（最小版）

> 供非 Node 宿主（如 Qt 应用）调用 flare 引擎的本地协议。
> 传输：stdin/stdout · JSON Lines（每行一个 JSON 对象）
> 实现：`src/server.ts`（`flare server` 命令）

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
{"type":"chat","sessionId":"s1","input":"帮我分析这个报错","context":"（可选状态快照）","tools":[<ToolDefinition>...]}
```

- `sessionId`：会话标识（同 id 连续对话，历史累积）
- `context`：可选，调用 `setContext` 注入宿主状态快照
- `tools`：可选，宿主声明的工具定义；服务为会话创建"宿主代理工具"（执行时经 `tool_execute` 事件问宿主）

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

### 7. tool_result — 宿主回传工具执行结果（响应 tool_execute）

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
| `pong` | `ts` | ping 响应（宿主健康检查） |

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
