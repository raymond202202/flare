# Flare MCP 集成指南（v0.5.5）

> MCP（Model Context Protocol）是 AI Agent 与外部工具/数据源互通的标准协议。
> flare 实现了 **MCP stdio 客户端**（零依赖手写 NDJSON JSON-RPC），可以连接任何 stdio 型 MCP 服务器
> （filesystem / github / 数据库 / 自定义工具等），把它们的工具桥接进 flare 的 Agent 工具集。
>
> - 实现：`src/mcp/client.ts`（MCPClient）+ `src/tools/mcp.ts`（工具桥）+ `src/mcp/manager.ts`（McpManager）
> - 零外部依赖：不引入 `@modelcontextprotocol/sdk`，直接走 MCP stdio 行协议（newline-delimited JSON-RPC）
> - 零 `agent.ts` 改动：MCP 工具经已有的 `config.tools` 注入 Agent

## 快速开始（CLI）

### 1. 配置 MCP 服务器

编辑 `~/.flare/mcp.json`（不存在则新建）：

```json
{
  "servers": [
    {
      "name": "fs",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp", "~/Documents"],
      "env": {}
    },
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" }
    }
  ]
}
```

字段说明：

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | 服务器名称（`/mcp connect <name>` 用） |
| `command` | ✅ | 启动命令（`npx` / `node` / `python` / 任意可执行文件） |
| `args` | - | 命令参数（MCP 服务器通常需要 `-y <包名>` 及路径/配置参数） |
| `env` | - | 附加环境变量（合并到当前环境；如 API token） |

> ⚠️ 安全：MCP 服务器的 API token 写在 `~/.flare/mcp.json`（同 `.env`，不入 GitHub）。
> flare 只把 MCP 工具当作普通工具调用，仍受 Agent 自身安全机制约束。

### 2. 在交互模式使用

```
🔥 flare> /mcp
  ○ fs
  ○ github
  /mcp connect <name> 连接 | /mcp disconnect <name> 断开

🔥 flare> /mcp connect fs
  ✅ 已连接 fs（8 个 MCP 工具）
  （会话已按新工具集重建，历史从记忆库恢复）

🔥 flare> 帮我列出 /tmp 下的文件并读取 a.txt
```

- `/mcp`：查看全部配置服务器状态（`●` 已连接 + 工具数，连接失败显示原因）
- `/mcp connect <name>`：连接并桥接工具（内置工具保留，重建会话生效）
- `/mcp disconnect <name>`：断开并移除其工具
- v0.6.26：已连接服务器状态行带 `（N 个工具 · M 资源 · K 模板）`——连接时同时拉取该服务器
  `resources/list` + `resources/templates/list`（资源桥接），外部服务器暴露的资源/动态资源模板
  真实暴露给宿主（`mcp_resources` 协议请求可查看/透传）
- `/mcp resources [name]`（v0.6.26）：列出已桥接资源/模板（`📄 uri — 描述` + `🧩 uriTemplate`）；
  带 `<name>` 只列该服务器的；无资源友好提示
- v0.6.36：状态行再带 `· P 提示词`——连接时同时拉取 `prompts/list`（prompts 桥接，与资源桥接对称）
- `/mcp prompts [name]`（v0.6.36）：列出已桥接提示词（`✨ name（参数: a, b）— 描述`）；带 `<name>`
  只列该服务器的；无提示词友好提示；`mcp_prompts` 协议请求可查看/透传（渲染经库级
  `McpManager.getPrompt` 代理）
- `/mcp read <server> <uri>`（v0.6.39）：**读取已连接服务器的资源内容**（`resources/read` 代理，
  与 `mcp_read_resource` 协议请求同源）——`/mcp resources` 只能看元数据，本命令直接显示资源
  真实内容（uri + mimeType + text）；服务器未连接/未知资源错误输出不崩溃
- `/mcp render <server> <prompt> [k=v ...]`（v0.6.39）：**渲染已连接服务器的提示词**
  （`prompts/get` 代理，与 `mcp_get_prompt` 协议请求同源）——`/mcp prompts` 只能看元数据，
  本命令直接显示渲染后的消息序列（`💬 role: text` + 可选描述）；`k=v` 传提示词参数
  （如 `/mcp render mock summarize topic=flare`）；未知提示词错误输出不崩溃
- `/mcp call <server> <tool> [JSON参数]`（v0.6.41）：**调用已连接服务器的工具**
  （`tools/call` 代理，与 `mcp_call` 协议请求同源）——`/mcp call mock add_numbers {"a":2,"b":3}`
  直接显示工具返回（文本内容）；工具级失败（isError）显示失败信息；非法 JSON 参数提示不调用；
  未知工具/未连接错误输出不崩溃
- `/help` 已注册 read/render/call 三行用法（v0.6.39/v0.6.41）

### 3. 单次查询

单次查询模式暂不注入 MCP 工具（交互模式 + 宿主协议已覆盖主要场景）。

## 宿主协议（server）接入

非 Node 宿主（Qt 等）通过 `flare server` 使用 MCP 工具：

```bash
flare server --profile examples/network-expert.json --storage ~/.pulse/pulse-ai.db --mcp ~/.flare/mcp.json
```

- 启动时后台连接 `--mcp` 配置的每个服务器，工具并入每个会话的 Agent 工具集
  （与宿主代理工具、专家工具并存；MCP 工具由 flare 直接执行，不走 tool_execute 宿主回传）
- 连接失败不阻塞服务（`mcp_status` 可见错误）

宿主可发 `mcp_status` 请求诊断：

```json
// 请求
{"type":"mcp_status"}
// 响应
{"type":"mcp_status","servers":[{"name":"fs","connected":true,"toolCount":8},{"name":"db","connected":false,"toolCount":0,"error":"..."}]}
```

MCP 三大列表 + 操作闭环（清单 → 读取/渲染/调用，全部经 server 协议）：

- `tools` 请求：查看当前会话 Agent 工具清单（`source:"mcp"` 标注外部 MCP 工具）；**执行**经
  `mcp_call`（v0.6.40）——`{"type":"mcp_call","server":"fs","tool":"read_file","args":{...}}`
  → `{"type":"mcp_call","server":"fs","tool":"read_file","success":true,"output":"..."}`（工具级
  失败 `success:false` + `error`；未知工具/未连接 → error，服务不崩）
- `mcp_resources` 请求：查看资源/模板清单；**读取内容**经 `mcp_read_resource`（v0.6.38）
- `mcp_prompts` 请求：查看提示词清单；**渲染**经 `mcp_get_prompt`（v0.6.38）

## 编程方式（库）

```ts
import { MCPClient, createMcpTools, McpManager, Agent } from 'flare-agent'

// 方式一：直接客户端
const client = new MCPClient({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] })
await client.initialize()
const tools = await createMcpTools(client)   // MCP 工具 → flare Tool[]
const agent = new Agent({ tools: [...builtinTools, ...tools] })
await agent.run('帮我看看 /tmp 里有什么')
client.close()

// 健康检查（v0.6.24）：标准 ping 探测服务器存活——成功返回 true，断开/超时 reject；
// MCPClient（stdio）与 MCPHttpClient（HTTP）接口对称
if (await client.ping()) { /* 服务器存活，继续业务请求 */ }

// 方式二：管理器（多服务器 + 配置文件）
const mgr = new McpManager()                  // 读 ~/.flare/mcp.json
await mgr.connect('fs')                       // 连接 + 桥接
const agent2 = new Agent({ tools: [...builtinTools, ...mgr.getAllTools()] })

// 资源桥接（v0.6.26）：连接时同时拉取 resources/list + resources/templates/list——
// 外部服务器暴露的资源/动态资源模板真实暴露给宿主（只桥接工具的历史缺口已补齐）
const resources = mgr.getAllResources()       // [{ uri, name, description?, mimeType?, server }]
const templates = mgr.getAllResourceTemplates() // [{ uriTemplate, name, description?, mimeType?, server }]
const contents = await mgr.readResource('fs', 'memory://preferences') // 代理读取资源内容

// prompts 桥接（v0.6.36）：连接时同时拉取 prompts/list——外部服务器暴露的提示词模板真实暴露给宿主
// （与资源桥接对称；stdio 与 HTTP transport 双传输都支持）
const prompts = mgr.getAllPrompts()           // [{ name, description?, arguments?, server }]
const rendered = await mgr.getPrompt('fs', 'summarize', { topic: 'flare' }) // 代理渲染 prompts/get
//   → { description?, messages: [{ role: 'user', content: { type: 'text', text: '...' } }] }

mgr.status()                                  // v0.6.50 起每个服务器带 transport（stdio/http）+ target（端点/命令）
mgr.closeAll()
```

## flare 作为 MCP 服务器（v0.5.8）

flare 不只可以连接外部 MCP 服务器（客户端），也可以**把自己的工具集暴露成 MCP 服务器**，
让其他 AI 客户端（Claude Desktop / Cursor / 自研 MCP 客户端）或宿主进程直接复用 flare 工具能力。

- 实现：`src/mcp/server.ts`（MCPServer，零依赖 NDJSON JSON-RPC，与 MCPClient 完全互通）
- 覆盖 MCP 核心子集：`initialize` / `notifications/initialized` / `tools/list` / `tools/call` / `resources/list` /
  `resources/read` / `resources/subscribe` / `resources/unsubscribe` / `prompts/list` / `prompts/get` / `ping`
  （v0.6.15 起 resources 订阅；能力声明 `resources: { subscribe: true }`）
- 请求按到达顺序串行响应（慢工具不导致响应乱序）；工具失败 → `isError` 标记（协议层不中断）

```ts
import { MCPServer, readFileTool, writeFileTool, terminalTool } from 'flare-agent'

// 默认暴露内置工具集（read_file/write_file/search_files/terminal/memory_search/memory_save）
const server = new MCPServer()
server.start()   // 监听 stdin，处理请求直到 EOF

// 也可注入自定义工具集（专家工具 / MCP 桥接工具）
const custom = new MCPServer({ tools: [readFileTool, writeFileTool, terminalTool] })
custom.start()
```

### 资源暴露（v0.6.1）：resources/list 真实数据 + resources/read

MCPServer 可注入**资源**（如记忆、配置、状态快照），经 MCP 标准 `resources/list` / `resources/read`
暴露给客户端（Claude Desktop 等会先探测 resources 能力）：

```ts
import { MCPServer } from 'flare-agent'

const server = new MCPServer({
  resources: [
    {
      uri: 'memory://preferences',          // 资源唯一标识
      name: '用户偏好',
      description: '用户的持久偏好记忆',
      mimeType: 'text/plain',
      read: () => '偏好深色主题',            // 返回内容文本；支持异步
    },
    { uri: 'file:///etc/hostname', name: '主机名', read: () => 'flare-host' },
  ],
})
server.start()
```

- 注入资源后 `initialize` 的 `capabilities` 会声明 `resources`（缺省不声明，兼容探测）
- `resources/list`：返回资源元数据（uri/name/description/mimeType）
- `resources/read`：调 `read()` 返回 `{ contents: [{ uri, mimeType?, text }] }`；
  未知 uri → `-32602`；`read()` 抛错 → `-32603`（服务器不崩）
- 不注入资源时行为不变：`resources/list` 返回空列表（v0.5.9 兼容）

#### 资源订阅（v0.6.15）：resources/subscribe + notifications/resources/updated

客户端可**订阅**资源——订阅后服务器资源变化时推送更新通知（如记忆被修改、状态快照刷新），
客户端无需轮询 `resources/read`：

```ts
import { MCPClient } from 'flare-agent'

const client = new MCPClient({
  command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  // 收到 resources/updated 通知 → 回调转发被更新的资源 uri（未配置忽略）
  onResourceUpdated: (uri) => console.log('资源已更新:', uri),
})
await client.initialize()
await client.subscribeResource('memory://preferences')   // 订阅（未知 uri 协议错误 reject）
// …服务器侧 notifyResourceUpdated('memory://preferences') → 客户端收到 uri…
await client.unsubscribeResource('memory://preferences') // 退订（停止接收该资源更新）
```

- **服务器侧**：`MCPServer` 处理 `resources/subscribe` / `resources/unsubscribe`（未知/缺 uri → `-32602`，
  重复订阅幂等、未订阅退订幂等）；`notifyResourceUpdated(uri)` 推送 `notifications/resources/updated`——
  **仅向已订阅该 uri 的客户端推送**（未订阅/未知资源/已关闭/写失败 → 静默不抛错）；
  注入资源后 `capabilities.resources` 声明 `{ subscribe: true }`（v0.6.15 起，此前为 `{}`）
- **客户端侧**：`MCPClient.subscribeResource(uri)` / `unsubscribeResource(uri)` + `onResourceUpdated` 回调
  （stdio 客户端可接收推送；通知与日志通知分流互不干扰）
- **传输差异（文档记录）**：HTTP transport 共用 `handleMessage` 核心，subscribe/unsubscribe 一请求一响应正常；
  但无 SSE 长连接——服务器 `notifyResourceUpdated` 推送客户端**收不到**（MCPHttpClient 可订阅但无更新回调，
  与 roots/logging 推送差异一致，如实记录不假装支持）

#### 资源模板（v0.6.22）：resources/templates/list + matchResourceTemplate

**动态资源**（uri 含变量，如 `memory://{noteId}` 的每条记忆）无法在 `resources/list` 逐条列出时，
可注入**资源模板**声明其形态——客户端据此知道如何构造/发现这类资源：

```ts
import { MCPServer } from 'flare-agent'

const server = new MCPServer({
  resources: [{ uri: 'memory://preferences', name: '用户偏好', read: () => '主题: 浅色' }],
  resourceTemplates: [
    {
      uriTemplate: 'memory://{noteId}',   // RFC 6570 风格：{var} 为变量占位
      name: '记忆条目',
      description: '记忆库中的单条记忆（动态资源）',
      mimeType: 'text/plain',
    },
  ],
})
server.start()
```

- 注入模板后 `initialize` 的 `capabilities.resources` 声明 `{ subscribe: true, listTemplates: true }`
  （有模板时；仅静态资源无模板仍为 `{ subscribe: true }`，缺省行为与旧版完全一致零回归）
- `resources/templates/list`：返回模板元数据（`uriTemplate`/`name`/`description?`/`mimeType?`）；
  **未注入模板返回空列表**（方法始终可用，不报错）
- 客户端消费：`MCPClient.listResourceTemplates()` / `MCPHttpClient.listResourceTemplates()` → 模板数组
  （stdio / HTTP 同构，与 listResources 一致）
- **纯函数 `matchResourceTemplate(uri, template)`**（库导出）：判断 uri 是否匹配某模板——把模板编译为
  正则（`{var}` 为捕获组；`path`/`uri` 类变量允许任意字符含 `/`，其余变量为单段不含 `/`），
  匹配返回该模板对象、不匹配返回 `null`。宿主可据此校验动态资源 uri 合法性、或生成模板候选 uri 示例

```ts
import { matchResourceTemplate } from 'flare-agent'
matchResourceTemplate('memory://note-1', { uriTemplate: 'memory://{noteId}', name: '记忆条目' })
// → 匹配的模板对象（noteId 单段变量：'memory://a/b' 不匹配）
matchResourceTemplate('file://a/b/c.txt', { uriTemplate: 'file://{path}', name: '任意文件' })
// → 匹配（path 变量允许含 /）
```

- **与 completion 的关系**：v0.6.11 的 `completion/complete`（ref/resource）按**已暴露静态资源** uri 前缀
  补全；v0.6.23 起**并入资源模板 uriTemplate 候选**（静态资源在前、模板在后）——客户端输入 uri 前缀时
  可同时发现静态资源与动态资源形态；模板声明的是**动态资源形态**（客户端可自行构造变量段），两者互补——
  静态资源可枚举、动态资源靠模板发现

#### 动态资源提供器（v0.6.28）：外部 MCP 资源透传

MCPServer 除构造时注入的**静态资源**外，可挂一个**动态资源提供器**（`resourceProvider`）——
`resources/list` 实时拉取合并、`resources/read` 代理读取。典型场景：**flare 同时作为 MCP 客户端
连接外部 MCP 服务器（McpManager 资源桥接）时，把外部服务器的资源/模板透传给 flare 自身 MCPServer
的客户端（宿主）**——外部资源经 flare 中转暴露，宿主无需直连外部服务器：

```ts
import { MCPServer, McpManager, type McpResourceProvider } from 'flare-agent'

const mgr = new McpManager()                 // 读 ~/.flare/mcp.json
await mgr.connect('filesystem')              // 连接外部服务器（stdio/HTTP）

const provider: McpResourceProvider = {
  // 外部资源/模板实时合并（静态优先、同 uri/uriTemplate 去重；异步可注入）
  listResources: () => mgr.getAllResources().map(({ server, ...r }) => r),
  listResourceTemplates: () => mgr.getAllResourceTemplates().map(({ server, ...t }) => t),
  // 读取代理转发：按 uri 找到所属服务器，调该服务器 resources/read；找不到返回 null（→ Unknown resource）
  readResource: async (uri) => {
    const ref = mgr.getAllResources().find((r) => r.uri === uri)
    return ref ? mgr.readResource(ref.server, uri) : null
  },
}

const server = new MCPServer({ tools: [...], resourceProvider: provider })
server.start()
```

- **合并规则**：`resources/list` 返回静态资源在前 + 提供器动态资源（同 uri 去重，静态优先）；
  `resources/templates/list` 同理合并模板；**提供器抛错/返回非数组 → 降级只返回静态**（请求不中断，
  与连接外部 MCP 容错风格一致）
- **读取规则**：静态命中先读；否则问提供器——返回文本 → 包成 `{ uri, text }` contents，返回数组 →
  原样透传；返回 `null` / 抛错 → `-32602` Unknown resource（服务器不崩）
- **订阅**：动态提供器资源同样可 `resources/subscribe` / `unsubscribe`（提供器失败视为未知）
- **能力声明**：有提供器时 `initialize` 声明 `resources: { subscribe: true, listTemplates: true }`
  （动态列表可能非空；无提供器时行为与旧版完全一致）
- **CLI 一键接线**：`flare mcp-server --bridge-resources` 连接 ~/.flare/mcp.json 全部外部服务器并透传
  资源（stdio 与 `--http` 双传输都支持；提示走 stderr 不污染协议通道；未配置服务器时提示 + 仅暴露
  flare 自身资源）
- **嵌套循环风险（文档记录）**：若外部服务器恰好是另一个也做了同样透传的 flare 实例，
  `resources/read` 可能无限递归——实际部署宿主不把 flare 自身 MCP 端点配为 flare 的 MCP 服务器即可避免

#### 提示词透传（v0.6.37）：CLI `mcp-server --bridge-prompts`

与资源透传对称，外部 MCP 服务器的**提示词**也可经 flare 自身 MCPServer 暴露给客户端——
`flare mcp-server --bridge-prompts` 连接 ~/.flare/mcp.json 全部外部服务器（与 `--bridge-resources`
可同时用，`--config` 共用），把 `McpManager.getAllPrompts()` 包装成 `McpPrompt[]` 注入 MCPServer：

- **元数据透传**：`prompts/list` 返回外部提示词的 name/description/arguments 参数声明（原样透传）
- **渲染代理**：`prompts/get` 调 `render(args)` 时按 prompt 名找到所属服务器，代理转发该服务器的
  `prompts/get`（与资源读取代理转发同模式）——客户端拿到的是外部服务器渲染后的消息序列
- **能力声明**：有透传提示词时 `initialize` 声明 `capabilities.prompts`（客户端可探测）；未配置服务器 /
  服务器无 prompts → 仅暴露 flare 自身能力（提示词空列表，不中断）
- **嵌套循环风险（同资源透传）**：外部服务器若是另一个同样透传的 flare 实例，prompts/get 可能无限
  递归——部署时避免把 flare 自身 MCP 端点配为 flare 的 MCP 服务器即可

#### 工具透传（v0.6.47）：CLI `mcp-server --bridge-tools`

与资源/提示词透传对称，外部 MCP 服务器的**工具**也可经 flare 自身 MCPServer 暴露给客户端——
`flare mcp-server --bridge-tools` 连接 ~/.flare/mcp.json 全部外部服务器（与 `--bridge-resources` /
`--bridge-prompts` 可同时用，`--config` 共用），把 `McpManager.getAllTools()` 返回的 flare Tool 代理
（createMcpTools 包装）并入工具集：

- **工具并集**：`tools/list` 返回内置（`-t` 可收窄）+ 外部透传的全部工具——客户端拿到的是
  flare 工具与外部 MCP 工具的并集（stdio 与 `--http` 双传输都支持）
- **调用代理**：`tools/call` 调外部工具时，经 flare 转发到所属服务器的 `tools/call`（execute 代理
  与资源读取代理转发同模式）——内容往返，isError 原样透传（工具级失败不中断请求）
- **同名冲突**：同名工具保留原名、以先注册者（内置）为准——需要外部同名工具时可用 `-t` 收窄内置
  避免冲突
- **降级**：未配置服务器 / 连接失败 → 提示 + 仅暴露 flare 自身工具（不中断，与资源透传无配置降级一致）
- **嵌套循环风险（同资源透传）**：外部服务器若是另一个同样透传的 flare 实例，tools/call 可能无限
  递归——部署时避免把 flare 自身 MCP 端点配为 flare 的 MCP 服务器即可

### 提示词暴露（v0.6.2）：prompts/list 真实数据 + prompts/get 渲染

MCPServer 可注入**提示词模板**（如总结、翻译等可复用指令），经 MCP 标准 `prompts/list` / `prompts/get`
暴露给客户端——客户端先探测提示词清单，再按参数补全调用 `prompts/get` 得到渲染后的消息序列：

```ts
import { MCPServer } from 'flare-agent'

const server = new MCPServer({
  prompts: [
    {
      name: 'summarize',                        // 提示词唯一名称（prompts/get 定位用）
      description: '总结会话内容',
      arguments: [{ name: 'topic', description: '主题', required: true }], // 参数声明（列表暴露给客户端补全提示）
      render: (args) => [                       // 按客户端传入的 arguments 渲染消息；支持异步
        { role: 'user', content: { type: 'text', text: `请总结关于「${args.topic}」的会话` } },
        { role: 'assistant', content: { type: 'text', text: '好的，我来总结。' } },
      ],
    },
    { name: 'greet', render: () => [{ role: 'user', content: { type: 'text', text: '你好' } }] },
  ],
})
server.start()
```

- 注入提示词后 `initialize` 的 `capabilities` 会声明 `prompts`（缺省不声明，兼容探测）
- `prompts/list`：返回提示词元数据（name/description/arguments）
- `prompts/get`：调 `render(arguments)` 返回 `{ description?, messages }`；
  未知 name → `-32602`；`render()` 抛错 → `-32603`（服务器不崩）
- 不注入提示词时行为不变：`prompts/list` 返回空列表（v0.5.9 兼容）

#### 参数补全（v0.6.11）：completion/complete

prompt 可提供**可选 `complete` 回调**——客户端交互式输入参数时（如宿主面板的提示词表单），
经 MCP 标准 `completion/complete` 向服务器请求候选值（能力 `capabilities.completions`）：

```ts
const server = new MCPServer({
  prompts: [
    {
      name: 'summarize',
      arguments: [{ name: 'topic', description: '主题', required: true }],
      render: (args) => [{ role: 'user', content: { type: 'text', text: `总结 ${args.topic}` } }],
      // 参数补全：按参数名 + 当前输入值返回候选（可异步）
      complete: (argName, value) => {
        if (argName === 'topic') {
          const all = ['flare 引擎', 'Pulse', 'StorySpire', 'MCP 协议']
          return all.filter(v => v.includes(value))
        }
        return []
      },
    },
  ],
})
```

- 任一 prompt 提供 `complete` 回调（或注入了资源）→ `initialize` 声明 `completions`（缺省不声明）
- `completion/complete` 请求 `{ ref: { type: 'ref/prompt', name }, argument: { name, value } }`
  → 响应 `{ completion: { values, total, hasMore } }`；无回调的 prompt → 空候选（不报错）
- `ref: { type: 'ref/resource', uri }` → 按已暴露资源 uri 前缀给出候选（资源模板补全）
- 未知 prompt / 缺 ref → `-32602`；回调抛错 → `-32603`（服务器不崩）
- 客户端消费（stdio/HTTP 同构）：`completePrompt(name, argumentName, value)` → `{ values }`

其他 MCP 客户端连接方式（以 flare 官方 MCPClient 为例）：

```ts
const client = new MCPClient({ command: 'node', args: ['your-mcp-server-entry.js'] })
await client.initialize()
const tools = await client.listTools()            // flare 内置 6 工具
await client.callTool('read_file', { path: 'a.txt' })
const prompts = await client.listPrompts()        // v0.6.2：提示词清单（name/description/arguments）
const p = await client.getPrompt('summarize', { topic: 'flare' })  // v0.6.2：渲染消息序列
const comp = await client.completePrompt('summarize', 'topic', 'flare') // v0.6.11：参数补全候选
```

#### roots 协议（v0.6.12）：客户端暴露根目录 + 服务器主动请求

MCP **roots** 是客户端暴露给服务器的命名空间/根目录（如项目目录、工作区），
方向与 resources 相反（resources 是服务器暴露给客户端）。flare 两端都支持：

**客户端侧（flare 作为 MCP 客户端）**——`MCPClient` 配置 `roots` 后：
- `initialize` 声明 `capabilities.roots`（`{ listChanged: true }`；未配置 roots 不声明，缺省兼容）
- 服务器主动发 `roots/list` 请求 → 客户端**自动响应**注入的 roots（未知方法回 `-32601`，连接不断）
- `notifyRootsChanged()` 发 `notifications/roots/list_changed` 通知（roots 变化时告知服务器）

```ts
const client = new MCPClient({
  command: 'node', args: ['your-mcp-server-entry.js'],
  roots: [
    { uri: 'file:///home/user/projects', name: 'projects' },
    { uri: 'memory://workspace' },
  ],
})
await client.initialize()
// 连接的服务器可 requestRoots() 查询到上述两个根目录
client.notifyRootsChanged()   // roots 变化时通知服务器
```

**服务器侧（flare 作为 MCP 服务器）**——`MCPServer` 新增**主动请求能力**
（v0.6.12 起服务器可向客户端发请求，为未来 sampling 等服务器→客户端请求打基础）：

```ts
const server = new MCPServer({ tools: builtinTools })
server.start()
// 请求客户端暴露的 roots（带超时，默认 15s；MCPServerOptions.requestTimeoutMs 可配）
const roots = await server.requestRoots(5000)   // [{ uri: 'file:///...', name: 'projects' }, ...]
```

- 客户端回 error / 超时 / 服务器已关闭 → reject（不悬挂）；响应缺 roots 或非数组 → 容错返回 `[]`
- **注意**：HTTP transport（`startMcpHttpServer`）是"一请求一响应"同步子集，无服务器→客户端
  通道，故不提供 `requestRoots`（stdio 专属）；MCPHttpClient 因无 SSE 长连接也不声明 roots 能力

> ⚠️ 安全：暴露的是 flare **原生工具**，危险命令黑名单 / 路径保护 / 记忆边界照常生效
> （e2e 测试验证 `rm -rf /` 仍被安全策略拦截）。谁连接了服务器谁就获得这些工具能力，
> 仅对可信客户端开放（stdio 服务器由启动它的进程控制；HTTP 服务器默认只监听 127.0.0.1）。

#### logging 协议（v0.6.13）：日志级别设置 + 服务器日志推送

MCP **logging** 让服务器把结构化日志推送给客户端（调试 / 运行状态可观测），flare 两端都支持：

**服务器侧（flare 作为 MCP 服务器）**——`MCPServer` 缺省声明 `capabilities.logging`（`logging:false` 可关闭）：

```ts
import { MCPServer } from 'flare-agent'

const server = new MCPServer({ tools: builtinTools })  // 缺省 logging 开启
server.start()

// 推送结构化日志（发 notifications/message 通知，无 id，客户端无需响应）
server.sendLog('info', 'server started')
server.sendLog('warning', 'disk low', 'flare')         // 可选 logger 标注来源
server.sendLog('error', { code: 500, detail: 'boom' }) // data 可为任意 JSON 可序列化值
```

- 客户端发 `logging/setLevel`（`{ level }`）设置日志级别阈值——8 级按严重程度升序：
  `debug` < `info` < `notice` < `warning` < `error` < `critical` < `alert` < `emergency`
  （非法级别 → `-32602`，错误信息含合法值提示）
- 级别过滤：低于当前阈值的 `sendLog` 丢弃（未设置默认 `info`；`setLevel('warning')` 后 debug/info 不再推送）
- `logging:false` → 不声明能力、`sendLog` 全部丢弃；服务器已关闭 / 写失败 → 静默忽略（不抛错）

**客户端侧（flare 作为 MCP 客户端）**——`MCPClient` 新增 `onLog` 回调 + `setLogLevel()`：

```ts
const client = new MCPClient({
  command: 'node', args: ['your-mcp-server-entry.js'],
  onLog: (msg) => console.log(`[${msg.level}]`, msg.data),  // 接收服务器日志推送
})
await client.initialize()
await client.setLogLevel('debug')   // 让服务器推送所有级别（含 debug）
// 服务器 sendLog('warning', 'disk low', 'flare') → onLog({ level: 'warning', logger: 'flare', data: 'disk low' })
```

- `onLog` 未配置时日志通知被静默忽略（不干扰后续请求/响应）；通知（无 id）与响应 / 服务器请求分流处理
- **传输差异（文档记录）**：HTTP transport（`startMcpHttpServer`）是"一请求一响应"同步子集，无服务器→客户端
  通道——`MCPHttpClient.setLogLevel` 可正常设置级别（服务器接受），但收不到日志推送（无 SSE 长连接）

> 与 `resources`/`prompts`/`completions` 的"注入才声明"不同，logging 是协议标准能力，缺省声明
> （`logging:false` 显式关闭）——客户端可据此探测服务器是否支持日志推送。

#### sampling 协议（v0.6.14）：服务器→客户端请求 LLM 采样

MCP **sampling** 让服务器（自身无模型/不想直接调模型）请求**客户端（宿主应用）代为调用 LLM**
生成内容——对 AI Agent 引擎是天然场景：flare 服务器经 MCP 复用宿主已配置的模型能力。
方向与 roots 一致（服务器→客户端请求），复用 v0.6.12 建立的主动请求通道。flare 两端都支持：

**服务器侧（flare 作为 MCP 服务器）**——`MCPServer.requestSample(request, timeoutMs?)`：

```ts
const server = new MCPServer({ tools: builtinTools })
server.start()
// 请求客户端代为采样（带超时，默认 15s；MCPServerOptions.requestTimeoutMs 可配）
const result = await server.requestSample({
  messages: [{ role: 'user', content: { type: 'text', text: '用一句话介绍 flare 引擎' } }],
  systemPrompt: '你是 flare 引擎的技术讲解员。',
  maxTokens: 100,
  temperature: 0.5,
})
// result = { role: 'assistant', content: { type: 'text', text: '...' }, model: 'deepseek-chat', stopReason: 'endTurn' }
```

- 请求参数：`messages`（必填，至少一条）、`systemPrompt` / `temperature` / `maxTokens`（必填）/
  `stopSequences` / `modelPreferences`（模型偏好：hints + cost/speed/intelligence 优先级）/
  `includeContext`（'none' | 'thisServer' | 'allServers'）/ `metadata`
- 客户端回 error / 超时 / 服务器已关闭 → reject（不悬挂）；响应缺 `content.text` → reject
  （采样结果必须有内容才可用，与 roots 容错 `[]` 不同）；请求缺 messages → 立即 reject（不发请求）

**客户端侧（flare 作为 MCP 客户端）**——`MCPClient` 配置 `sampling` 回调后：

```ts
const client = new MCPClient({
  command: 'node', args: ['your-mcp-server-entry.js'],
  // 宿主注入 LLM 采样器：收到服务器 sampling/createMessage 请求时调用（真实 LLM 由宿主负责）
  sampling: async (request) => {
    const text = await yourLLM(request.messages, { system: request.systemPrompt, maxTokens: request.maxTokens })
    return { role: 'assistant', content: { type: 'text', text }, model: 'your-model' }
  },
})
await client.initialize()
// 连接的服务器可 requestSample() 请求客户端代为生成内容
```

- 配置了回调 → `initialize` 声明 `capabilities.sampling`（未配置不声明，缺省兼容——服务器不应请求采样）
- 服务器发 `sampling/createMessage` 请求 → 回调自动执行并回传结果（支持异步回调）
- 回调抛错 → 回 `-32603`（客户端不崩，服务器收到错误）；未配置回调却收到请求 → 回 `-32601`
  （协议错误，连接不断）
- **传输差异（文档记录）**：HTTP transport（`startMcpHttpServer`）是"一请求一响应"同步子集，
  无服务器→客户端通道，故不提供 `requestSample`（stdio 专属）；MCPHttpClient 因无 SSE 长连接
  也不声明 sampling 能力——与 roots 的传输差异一致

> ⚠️ 安全：sampling 是**客户端主动授权**的能力——只有配置了 `sampling` 回调的客户端才会
> 响应采样请求，服务器无法强制客户端调用模型；未配置的客户端一律回 `-32601`。

#### progress 通知协议（v0.6.16）：长请求进度推送

MCP **progress** 让服务器在处理**长请求**（如耗时工具调用）期间向客户端推送进度
（`notifications/progress`，无 id 通知），客户端无需轮询——长任务可视化的标准做法。
关联方式：客户端在请求参数 `_meta.progressToken` 指定令牌，服务器推送时原样回传。

**客户端侧（flare 作为 MCP 客户端）**——`callTool` 第三参带 `progressToken` + 配置 `onProgress` 回调：

```ts
const client = new MCPClient({
  command: 'node', args: ['your-mcp-server-entry.js'],
  onProgress: (p) => console.log(`${p.progressToken}: ${p.progress}/${p.total} ${p.message || ''}`),
})
await client.initialize()
const res = await client.callTool('long_task', { steps: 10 }, { progressToken: 'job-1' })
```

- `callTool(name, args?, options?)`：`options.progressToken`（string | number）→ 请求带
  `_meta.progressToken`；不带则行为与旧版完全一致（向后兼容）
- 服务器推送 `notifications/progress` → `onProgress` 回调收到 `{ progressToken, progress?, total?, message? }`；
  未配置回调 → 忽略不干扰后续请求（与 onLog/onResourceUpdated 同风格）

**服务器侧（flare 作为 MCP 服务器）**——`MCPServer.notifyProgress(progress?, total?, message?)`：

```ts
let server: MCPServer
const longTool: Tool = {
  definition: { type: 'function', function: { name: 'long_task', description: '', parameters: {} } },
  execute: async () => {
    server.notifyProgress(1, 10, '开始')
    // ... 长任务中间步骤
    server.notifyProgress(10, 10, '完成')
    return { success: true, output: 'done' }
  },
}
server = new MCPServer({ tools: [longTool] })
```

- 只在**正在处理的请求带 `_meta.progressToken`** 时推送（活动令牌机制；串行队列保证同一时刻
  只有一个活动请求，令牌不会串）；无活动令牌 / 已关闭 / 写失败 → 静默忽略（不抛错）
- 推送 `{ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress?, total?, message? } }`
  （无 id，客户端无需响应）；进度令牌原样回传供客户端关联请求
- **传输差异（文档记录）**：HTTP transport（`startMcpHttpServer`）共用 handleMessage 核心，请求带
  `_meta.progressToken` 可正常识别；但无 SSE 推送通道，服务器 `notifyProgress` 客户端收不到
  （与 logging/resources 订阅的传输差异一致）；MCPHttpClient `callTool` 同样可透传 progressToken

#### cancelled 通知协议（v0.6.16）：请求取消告知

MCP **cancelled** 让**请求方**在放弃一个已发出的请求时通知对方（`notifications/cancelled`，
无 id 通知），对方可停止处理/清理状态——超时或用户取消后礼貌告知的协议标准做法。

```ts
// 客户端：取消自己发出的请求（requestId 是本客户端发出请求时使用的 id；reason 可选）
client.notifyCancelled(7, 'timeout')          // stdio MCPClient（同步发送）
await httpClient.notifyCancelled(7, 'timeout') // HTTP MCPHttpClient（发通知，服务器回 202）
```

- **服务器侧**：收到 `notifications/cancelled` → 若 `requestId` 命中 pending（服务器→客户端请求，
  如 `requestRoots` / `requestSample` 等待客户端响应中）→ reject 并清理（不悬挂，错误信息含 reason）；
  未知/已完成请求 → 静默忽略（协议错误不致命，连接不断）
- **传输差异（文档记录）**：HTTP transport 共用 handleMessage 核心，`notifications/cancelled`
  通知同样处理（202）；但一请求一响应，取消通知到达时原请求可能已完成——尽力而为
- 边界说明：stdio 串行队列下，取消通知通常排在慢请求**之后**处理（此时原请求已完成、响应已发），
  故 cancelled 的主要价值是**协议完整性与客户端超时/取消后的礼貌告知**；对服务器→客户端
  pending 请求（roots/sampling）的取消则真实生效（reject 不悬挂）

#### 列表变化通知协议（v0.6.20；v0.6.25 补齐 prompts）：tools/list_changed + resources/list_changed + prompts/list_changed

MCP 标准通知让服务器在**工具/资源/提示词列表动态变化**（运行中新增或移除，而非内容更新）时告知客户端，
客户端收到后应重新拉取 `tools/list` / `resources/list` / `prompts/list` 刷新清单——与 v0.6.15 的
`resources/updated`（订阅的单个资源**内容**变化）互补：updated 面向已订阅的特定 uri，
list_changed 面向**列表整体**、无需订阅（所有已连接客户端都会收到）。

**服务器侧（flare 作为 MCP 服务器）**——`MCPServer.notifyToolListChanged()` /
`notifyResourceListChanged()` / `notifyPromptListChanged()`（v0.6.25 补齐第三个）：

```ts
let server: MCPServer
const dynamicTool: Tool = {
  definition: { type: 'function', function: { name: 'load_plugins', description: '', parameters: {} } },
  execute: async () => {
    // ... 宿主动态加载/卸载工具后
    server.notifyToolListChanged()      // 客户端应重新拉取 tools/list
    // ... 资源列表（uri 集合）变化后
    server.notifyResourceListChanged()  // 客户端应重新拉取 resources/list
    // ... 提示词列表变化后
    server.notifyPromptListChanged()    // 客户端应重新拉取 prompts/list（v0.6.25）
    return { success: true, output: 'done' }
  },
}
server = new MCPServer({ tools: [dynamicTool] })
```

- 推送 `{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }` /
  `{ jsonrpc: '2.0', method: 'notifications/resources/list_changed' }` /
  `{ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' }`（无 id、无 params，
  客户端无需响应）；三个方法相互独立，可分别按需调用
- 服务器已关闭 / 写失败 → 静默忽略（不抛错，与 sendLog/notifyResourceUpdated 同风格）

**客户端侧（flare 作为 MCP 客户端）**——配置 `onToolsChanged` / `onResourcesChanged` / `onPromptsChanged` 回调：

```ts
const client = new MCPClient({
  command: 'node', args: ['your-mcp-server-entry.js'],
  onToolsChanged: async () => {
    const tools = await client.listTools()        // 重新拉取工具清单
    console.log(`工具列表已变化，当前 ${tools.length} 个`)
  },
  onResourcesChanged: () => console.log('资源列表已变化'),
  onPromptsChanged: async () => {
    const prompts = await client.listPrompts()    // 重新拉取提示词清单（v0.6.25）
    console.log(`提示词列表已变化，当前 ${prompts.length} 个`)
  },
})
await client.initialize()
```

- 服务器推送 `notifications/tools/list_changed` → `onToolsChanged()`（无参）触发；
  `notifications/resources/list_changed` → `onResourcesChanged()`（无参）触发；
  `notifications/prompts/list_changed` → `onPromptsChanged()`（无参）触发（v0.6.25）
- 未配置对应回调 → 静默忽略不干扰后续请求（与 onLog/onResourceUpdated/onProgress 同风格）；
  三个回调独立，只配置其一互不影响
- **传输差异（文档记录）**：stdio（MCPServer）有服务器→客户端通道可推送；HTTP transport
  （`startMcpHttpServer`）是一请求一响应、无推送通道——服务器可调用通知方法（不抛错）但客户端
  收不到（与 sendLog/notifyResourceUpdated/progress 差异一致）；MCPHttpClient 无 SSE 长连接，
  故不提供这些回调，文档如实记录不假装支持

### HTTP transport（v0.6.3）：POST /mcp

除 stdio 外，MCPServer 可经 **HTTP** 暴露（`src/mcp/http.ts`，零依赖 node:http）——
streamable HTTP 的同步子集：一次 `POST /mcp` 处理一个 JSON-RPC 消息并回 JSON 响应，与 stdio 行为完全一致
（复用 `MCPServer.handleMessage`，传输无关）：

```ts
import { startMcpHttpServer } from 'flare-agent'

const h = await startMcpHttpServer({ tools: builtinTools, port: 8931 })
// POST http://127.0.0.1:8931/mcp  {"jsonrpc":"2.0","id":1,"method":"tools/list"}
await h.close()
```

- 有 id 的请求 → `200` + JSON-RPC 响应（错误对象不抛出，-32601/-32602/-32603 同 stdio）
- 通知类（无 id）→ `202` 空体（无需响应）；非法 JSON → `400` + parse error（-32700）
- 非 POST / 错误路径 → `404`；默认仅监听 `127.0.0.1`（安全默认），`port: 0` = 随机端口
- CLI 一键起 HTTP 服务器：`flare mcp-server --http --port 8931`（stdio 仍为默认传输）

#### HTTP 客户端（v0.6.4）：MCPHttpClient

与 stdio `MCPClient` 接口完全一致（`initialize` / `listTools` / `callTool` / `listPrompts` / `getPrompt` /
`listResources` / `readResource` / `completePrompt` / `setLogLevel` / `ping` / `close`），
可互换使用——本地子进程服务器用 stdio，远端/HTTP 服务器用 HTTP（`src/mcp/http-client.ts`，零依赖 node:http）：

```ts
import { MCPHttpClient } from 'flare-agent'

const client = new MCPHttpClient({ url: 'http://127.0.0.1:8931/mcp' })
await client.initialize()
const tools = await client.listTools()
const res = await client.callTool('read_file', { path: '/tmp/a.txt' })
client.close()
```

- 每个请求独立 HTTP 往返（MCP streamable HTTP 同步子集）；`initialize` 后自动发 `notifications/initialized` 通知（202 空体）
- 服务器返回 JSON-RPC error → `reject`（与 stdio 客户端一致）；HTTP 非 200 / 无响应体 → `reject`（含状态码与原因）
- 单请求超时默认 15s（`MCPHttpClient({ timeoutMs })` 可调）；`close()` 后拒绝后续请求
- **resources 消费（v0.6.6）**：`listResources()` → 元数据（uri/name/description/mimeType）；`readResource(uri)` → 内容列表；未知 uri 协议错误 reject（与 stdio 客户端对称，与 MCPServer 暴露闭环）

#### McpManager 接入（v0.6.6）：配置 `url` 即走 HTTP

`McpManager`（CLI 交互 `/mcp`、`flare server --mcp` 共用）现在同时支持 stdio 与 HTTP transport 服务器——
`~/.flare/mcp.json` 的 servers 列表项配置 `url`（HTTP 端点）即可直连，无需 spawn 子进程：

```json
{
  "servers": [
    { "name": "local-fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    { "name": "remote", "url": "http://127.0.0.1:8931/mcp" }
  ]
}
```

- 配了 `url` → `MCPHttpClient` 直连（HTTP transport）；否则按 `command` → stdio spawn（行为不变）
- 同时配了 `url` 与 `command` → `url` 优先；既无 `url` 也无 `command` → connect 抛清晰错误
- `timeoutMs` 可单独覆盖单服务器超时；`McpManager({ httpTimeoutMs })` 全局默认 15s
- `createMcpTools` 参数放宽为 `McpToolClient` 接口——stdio/HTTP 客户端都满足，工具桥传输无关

```ts
import { McpManager } from 'flare-agent'
const mgr = new McpManager()                 // 读 ~/.flare/mcp.json（含 url 服务器）
await mgr.connect('remote')                  // 自动选 HTTP transport
new Agent({ ..., tools: mgr.getAllTools() })
```

#### CLI `flare mcp call` / `flare mcp status` / `flare mcp resources` / `flare mcp prompts`（v0.6.6/v0.6.10）：一键调用/查看 MCP 工具

不启动交互模式直接调用 MCP 服务器工具（stdio 或 HTTP 均可）：

```bash
# HTTP transport 直连（跳过配置查找）
flare mcp call remote read_file '{"path":"/tmp/a.txt"}' --url http://127.0.0.1:8931/mcp

# 按配置调用（url → HTTP；command → stdio；--config 可指定配置文件）
flare mcp call local-fs read_file '{"path":"/tmp/a.txt"}'          # 默认 ~/.flare/mcp.json
flare mcp call mock add_numbers '{"a":2,"b":3}' --config ./mcp.json

# 查看配置的服务器（名称 + 传输类型 + 端点/命令；v0.6.51：统一走 status() 显示连接标记 ●/○ +
# 工具数；--connect 先连接全部配置服务器再显示真实连接状态，失败不阻塞、错误可见）
flare mcp status [--config ./mcp.json]
flare mcp status --connect [--config ./mcp.json]

# 调超时（毫秒）
flare mcp call remote ping --url http://127.0.0.1:8931/mcp --timeout 30000

# 查看服务器暴露的资源（v0.6.10：元数据 uri/name/description/mimeType）
flare mcp resources remote --url http://127.0.0.1:8931/mcp
flare mcp resources local-fs [--config ./mcp.json]

# 读取资源内容（--read <uri>）
flare mcp resources remote --read file:///tmp/a.txt --url http://127.0.0.1:8931/mcp

# 查看/渲染服务器暴露的提示词（v0.6.10：prompts/list 元数据；--get <name> 渲染，--args JSON 可选）
flare mcp prompts remote --url http://127.0.0.1:8931/mcp
flare mcp prompts remote --get greet --args '{"name":"世界"}' --url http://127.0.0.1:8931/mcp
```

- 工具参数为 JSON 对象（缺省 `{}`）；工具级失败（isError）/ 协议错误 / 未配置服务器 → 退出码 1 + 明确错误信息
- 便捷用途：冒烟验证 MCP 服务器、调试远端 HTTP 端点、脚本里调用 MCP 工具

## 自定义 MCP 服务器（测试/开发）

flare 的 MCP 客户端只依赖 MCP 核心子集（`initialize` / `notifications/initialized` / `tools/list` / `tools/call`）。
任何符合该子集的 stdio 服务器都能接入——参考 `tests/fixtures/mcp-mock-server.mjs`（NDJSON JSON-RPC 示例）。

工具调用错误有两种形态，flare 都处理：
- 协议层错误（JSON-RPC `error` 响应）→ `execute` 返回 `success:false` + 错误信息（不抛出）
- 工具级失败（结果 `isError: true`）→ `execute` 返回 `success:false` + 输出内容

## 协议版本

- MCP 协议版本：`2025-03-26`（initialize 时协商，服务器返回自己的版本则兼容接受）
- flare 引擎版本：`0.6.6`（`clientInfo.version`，读取 package.json 不硬编码）
- 请求超时：默认 15s（`MCPClient({ timeoutMs })` 可调）
