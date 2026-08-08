# Flare 引擎迭代进度（夜间调研 agent）

> 目标：flare 是 Pulse/StorySpire 依赖的 AI Agent 引擎（TS）。任何改动必须安全（tsc 0 错 + 测试全绿才 commit）。
> 铁律：禁止 push；禁止修改 src/core/agent.ts 的 Agent.run 核心循环。

> **最新状态（v0.5.8）**：MCP 服务器端已完成（MCPServer，208/208 全绿，commit 06eae7b 未 push）。
> 下一步候选：① CLI `flare mcp-server` 命令（MCP 服务器端收尾）；② CLI/server 接入 ConfirmationGate；③ 上下文 token 预算裁剪（agent.ts trimContext，风险高暂缓）。

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
