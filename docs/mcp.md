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

// 方式二：管理器（多服务器 + 配置文件）
const mgr = new McpManager()                  // 读 ~/.flare/mcp.json
await mgr.connect('fs')                       // 连接 + 桥接
const agent2 = new Agent({ tools: [...builtinTools, ...mgr.getAllTools()] })
mgr.closeAll()
```

## 自定义 MCP 服务器（测试/开发）

flare 的 MCP 客户端只依赖 MCP 核心子集（`initialize` / `notifications/initialized` / `tools/list` / `tools/call`）。
任何符合该子集的 stdio 服务器都能接入——参考 `tests/fixtures/mcp-mock-server.mjs`（NDJSON JSON-RPC 示例）。

工具调用错误有两种形态，flare 都处理：
- 协议层错误（JSON-RPC `error` 响应）→ `execute` 返回 `success:false` + 错误信息（不抛出）
- 工具级失败（结果 `isError: true`）→ `execute` 返回 `success:false` + 输出内容

## 协议版本

- MCP 协议版本：`2025-03-26`（initialize 时协商，服务器返回自己的版本则兼容接受）
- flare 引擎版本：`0.5.5`（`clientInfo.version`，读取 package.json 不硬编码）
- 请求超时：默认 15s（`MCPClient({ timeoutMs })` 可调）
