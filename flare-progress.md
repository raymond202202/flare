# Flare 引擎迭代进度（夜间调研 agent）

> 目标：flare 是 Pulse/StorySpire 依赖的 AI Agent 引擎（TS）。任何改动必须安全（tsc 0 错 + 测试全绿才 commit）。
> 铁律：禁止 push；禁止修改 src/core/agent.ts 的 Agent.run 核心循环。

> **最新状态（v0.6.13）**：MCP logging 协议闭环（`logging/setLevel` 级别阈值 + `sendLog` 推送 `notifications/message` 通知）+ 客户端 `onLog`/`setLogLevel` 消费；426/426 全绿（commit `c9ba946`，未 push）。
> 下一步候选：① agent.ts trimContext 自动裁剪（风险高仍暂缓）；② 其他安全的外围增强（MCP 更多协议特性如 sampling、server 协议其他管理接口等）。

### 2026-08-10 第十五轮实施（v0.6.13）——MCP logging 协议闭环

- **P30 MCP logging 协议**（src/mcp/server.ts + client.ts + http-client.ts + types.ts）：
  - **服务器侧**：`MCPServer` 缺省声明 `capabilities.logging`（`logging:false` 可关闭，不声明）——客户端
    `logging/setLevel` 设置日志级别阈值（8 级 debug→emergency 升序，非法级别 -32602 错误信息含合法值提示）；
    `sendLog(level, data, logger?)` 推送 `notifications/message` 通知（无 id，客户端无需响应）——级别低于
    当前阈值丢弃（未设置默认 info）；logging 关闭 / 服务器已关闭 / 写失败 → 静默忽略不抛错
  - **客户端侧**：`MCPClient` 新增 `onLog` 回调选项（接收服务器日志通知，未配置忽略不干扰后续请求）+
    `setLogLevel(level)`；handleLine 新增通知通道分流（无 id + method → handleNotification，与响应/
    服务器请求分流，互不干扰）；`MCPHttpClient.setLogLevel` 对称支持（HTTP 一请求一响应：可设置但无
    SSE 长连接收不到推送——文档如实记录，与 roots 传输差异一致）
  - `McpLogLevel`/`McpLogMessage` 类型 + `MCP_LOG_LEVELS`/`MCP_DEFAULT_LOG_LEVEL` 常量库导出；
    docs/mcp.md logging 协议章节 + README Changelog + 版本号 0.6.13
  - **426/426 全绿**（413 + 13 新增：MCPServer 8——缺省声明/logging:false 不声明/setLevel 合法+阈值生效/
    非法级别 -32602/默认 info 阈值/logging:false 丢弃/已关闭不抛错/logging 真实互通 e2e 真实子进程
    sendLog → onLog 收到 info+warning+error 且 debug 被过滤 + MCPClient 4——setLogLevel 请求/close 后
    reject/onLog 转发结构/无 onLog 忽略不干扰 + MCPHttpClient 1——capabilities 声明 + setLogLevel 成功），
    tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 stdio 子进程闭环——capabilities.logging `{}`、setLogLevel('info') 后收到
    info/warning/error（debug 被过滤，warning 带 logger 标注）；HTTP 服务器 capabilities.logging +
    setLogLevel 成功，SMOKE PASS
- **下一步候选**：① agent.ts trimContext 自动裁剪（风险高仍暂缓）；② 其他安全的外围增强
  （MCP 更多协议特性如 sampling、server 协议其他管理接口、CLI 交互增强等）

---

### 2026-08-10 第十四轮实施（v0.6.12）——MCP roots 协议闭环

- **P29 MCP roots 协议**（commit `78954a5`）：
  - roots 是客户端暴露给服务器的命名空间/根目录（方向与 resources 相反）——**客户端侧**：
    `MCPClient` 新增 `roots` 选项，配置后 `initialize` 声明 `capabilities.roots`（`{ listChanged: true }`，
    未配置不声明，缺省兼容）+ 服务器主动发 `roots/list` 请求时**自动响应**注入的 roots
    （新增 handleServerRequest 分流：pending 响应之外带 id+method 的行视为服务器请求；
    未知方法回 -32601，连接不断）+ `notifyRootsChanged()` 发 `notifications/roots/list_changed` 通知
    （roots 变化告知服务器）+ `roots` getter
  - **服务器侧**：`MCPServer` 新增**主动请求能力** `requestRoots(timeoutMs?)`——v0.6.12 起服务器可向
    客户端发请求（为未来 sampling 等服务器→客户端请求打基础）：发 `roots/list` 等待客户端响应
    （pending 匹配 + 超时，默认 15s，`MCPServerOptions.requestTimeoutMs` 可配）；客户端回 error /
    超时 / 服务器已关闭 → reject（不悬挂）；响应缺 roots 或非数组 → 容错返回 `[]`（与客户端宽松
    解析一致）；close 拒绝 pending
  - **传输差异（文档记录）**：HTTP transport（startMcpHttpServer）是"一请求一响应"同步子集，
    无服务器→客户端通道，故不提供 `requestRoots`（stdio 专属）；MCPHttpClient 无 SSE 长连接也不声明
    roots 能力——文档如实记录，不假装支持
  - `McpRoot`/`McpRootsResult` 类型库导出；docs/mcp.md roots 协议章节 + README Changelog + 版本号 0.6.12
  - **412/412 全绿**（401 + 11 新增：MCPServer requestRoots 5——发起+解析客户端响应/客户端 error reject/
    响应非数组容错 []/超时 reject 后服务器仍可用/已关闭 reject + roots 真实互通 e2e——真实 MCPServer
    子进程 requestRoots ↔ 真实 MCPClient 带 roots 注入写文件断言 + MCPClient 5——配置 roots 声明+getter/
    未配置不声明/服务器 roots/list 请求自动响应/notifyRootsChanged 通知/close 后不抛错），tsc 0 错误，
    零 agent.ts 改动
  - **冒烟实测**：真实 dist 产物互通——MCPClient（带 2 个 roots）连接真实 MCPServer 子进程，
    requestRoots 拿到 `file:///tmp/projects` + `memory://workspace`，版本 0.6.12，SMOKE PASS
- **P29b id 空间冲突修复**（commit `8e566a0`）：requestRoots 发出 id=N 后客户端恰发来 id=N 的新请求
  （请求行带 method），handleLine 的 pending 匹配会把请求行误判为 roots 响应（响应行才无 method）——
  导致 roots promise 被错误 resolve 且该请求永远无响应（客户端超时）。修复：pending 匹配加
  `typeof msg.method !== 'string'` 校验（client.ts + server.ts 对称）；新增防御测试（同 id ping 正常
  分发 + 真 roots 响应仍 resolve）→ **413/413 全绿**（412 + 1）
- **下一步候选**：① agent.ts trimContext 自动裁剪（风险高仍暂缓）；② 其他安全的外围增强
  （MCP 更多协议特性如 logging/sampling、server 协议其他管理接口、CLI 交互增强等）

---

### 2026-08-10 第十三轮实施（v0.6.11）——MCP completion/complete 参数补全 + server 协议 tools 工具清单 + CLI /tools

- **P26 MCP `completion/complete` 协议特性**（commit `1aff83e`）：
  - `McpPrompt` 新增可选 `complete(argumentName, value)` 回调——客户端交互式输入参数时（如宿主面板提示词表单）
    向服务器请求候选值；`initialize` 在任一 prompt 有回调（或注入了资源）时声明 `capabilities.completions`
    （缺省不声明，兼容探测）
  - `MCPServer` dispatch 新增 `completion/complete`：`ref/prompt` 按回调返回候选（支持异步）/ `ref/resource`
    按已暴露资源 uri 前缀建议 / 无回调的 prompt 返回空候选（不报错）；未知 prompt、缺 ref → `-32602`，
    回调抛错 → `-32603`（服务器不崩）；响应 `{ completion: { values, total, hasMore } }`——
    stdio（MCPServer）与 HTTP（startMcpHttpServer）共用同一核心（handleMessage）
  - **客户端消费闭环**：`MCPClient.completePrompt` / `MCPHttpClient.completePrompt(name, argumentName, value)`
    → `{ values }`（stdio/HTTP 同构）；`McpCompletionResult` 类型库导出
  - docs/mcp.md 参数补全章节 + README Changelog + 版本号 0.6.11
  - **390/390 全绿**（384 + 6 新增：服务器端 5——ref/prompt 候选/异步+空匹配/ref/resource uri 前缀/
    无回调空候选+未知 prompt+缺 ref/capabilities 声明含资源不声明 + stdio e2e 消费闭环 + HTTP e2e 消费闭环
    计入对应文件），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 HTTP MCP 服务器（注入 complete 回调）——capabilities.completions true、
    completePrompt 返回候选（fl→flare）/ 空匹配空候选；真实 stdio MCPServer ref/resource 前缀候选
- **P27 server 协议 `tools` 接口**（commit `1aff83e`）：
  - `tools {sessionId?}` 请求 → 宿主面板查询当前会话 Agent 可用工具清单（只读、不触发生成）：
    每项 `name`/`description`/`parameters` + `confirmed`（是否经确认门，命中 confirmTools 名单）+
    `source`（host 宿主代理 / profile 专家配置 / mcp 外部 MCP / builtin 内置回退）；`confirmTools` 确认名单
    配置回显；chat 带宿主工具后 tools 查询反映该会话真实工具集（getAgent 记录 toolMeta 到会话条目）
  - **纯函数库导出**：`describeTools(tools, confirmTools, sources?)` + `ToolMeta`/`ToolSourceSets` 类型
    （宿主可复用；来源判定 host 优先→mcp→profile→builtin）
  - docs/host-protocol.md §22 + 请求类型列表 + 响应表 + README Changelog
  - **397/397 全绿**（390 + describeTools 单测 5：元数据+确认标注/来源判定/host 优先/空名单关闭/缺省字段
    + server e2e 3：默认内置清单+确认标注/指定 sessionId/chat 带宿主工具后 host 来源），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 server 子进程——tools 返回 6 内置工具 + memory_save confirmed:true source:builtin
    + confirmTools=['memory_save'] 回显
- **P28 CLI 交互 `/tools` 命令**（commit `0a85618`）：
  - `/tools` → 查看当前 Agent 可用工具清单（内置 + MCP）：每项名称/来源（内置/MCP）+ 描述 +
    `⚠需确认` 标注（命中确认名单的写回类工具执行前弹窗确认，与 /allow 呼应——先看清单哪些需确认再决定放行）
  - `handleSlashCommand` 新增可选 `toolsInfo` 回调（未提供提示不可用，向后兼容）；CLI 注入复用
    `describeTools` 纯函数；`/help` 帮助行 + docs/confirmation.md CLI 章节补充
  - **401/401 全绿**（397 + 4 新增：无回调提示/列表+确认标注+来源/空清单/help 含说明），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 PTY 交互 CLI——/tools 列出 6 内置工具 + memory_save ⚠需确认 标注
- **下一步候选**：① agent.ts trimContext 自动裁剪（风险高仍暂缓）；② 其他安全的外围增强
  （MCP 更多协议特性如 roots/logging、server 协议其他管理接口、CLI 更多交互增强等）

---

- **P22 CLI /allow 增强**（commit `713ac14`）：
  - `/allow add <工具名> [session|always]` → 显式放行确认工具（无需等 AI 触发确认弹窗）：缺省 `session`
    本会话内不再确认；`always` 跨会话持久化（写入全局库 settings 表，新会话/新实例也放行）；非法模式/缺参/
    无 allow 回调（旧 hooks）各有清晰提示，未知子命令仍回用法
  - `/allow` 列表带范围标注：`（本会话）` 会话级 / `（跨会话持久化）` always / `（会话+持久化）` 两者
    （同一会话内 allowAlways 同时写会话级+持久化 → 两者；新会话只见持久化）
  - **AllowGateHooks 新增可选方法**：`allow(name, mode)` / `listDetailed()`——未提供则回退旧 `list()`
    （向后兼容，宿主不受影响）；CLI 注入点用 `gate.allowSession/allowAlways` + `listAllowed/listAlwaysAllowed` 实现；
    注意 `listAlwaysAllowed` 只能按候选名单（CLI_CONFIRM_TOOLS）查持久化（KV store 无法枚举 key，v0.6.8 已知限制）
  - docs/confirmation.md CLI 章节 + README CLI 表/Changelog + 版本号 0.6.10
  - **373/373 全绿**（364 + 9 新增：/allow 范围标注 2——会话级/持久化/两者+新会话持久化、无 listDetailed 回退旧行为；
    /allow add 7——缺省 session 不写持久化、session、always 持久化+跨实例生效、缺参、非法模式、无 allow 回调、
    add 后 revoke 双清），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 PTY 交互 CLI——`/allow add memory_save always` → 「已放行 memory_save（跨会话持久化）」、
    `/allow` 列表标注 `memory_save（会话+持久化）`、`/allow add bad xyz` → 非法模式提示、`/allow revoke` → 恢复确认
- **P23 server 协议 confirm_allow**（commit `fc5942f`）：
  - `confirm_allow {tool, mode?}` → 宿主面板显式放行确认工具（无需等 AI 触发 confirm 事件）：mode 缺省 `session`
    本会话放行 / `always` 跨会话持久化；缺 tool / 非法 mode 回 error（含用法提示）
  - 与 `confirm_status`（查询）/ `confirm_revoke`（撤销）组成确认门管理闭环；复用 getGate 的
    `allowSession/allowAlways`；`mode=always` 当前会话内也放行（allowedTools 可见），持久化部分由 alwaysAllowed 体现
  - docs/host-protocol.md §21 + 确认门管理章节 + 响应表 + 请求类型列表 + README Changelog 0.6.10 补充
  - **377/377 全绿**（373 + 4 新增 server e2e：缺 tool error / 非法 mode error / 缺省 mode session 放行 status 可见 /
    mode=always 持久化 + revoke 撤销），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 server 子进程——confirm_allow 缺省 mode ok(session) / mode=always ok / 非法 mode error 清晰 /
    confirm_status 闭环（sessionAllowed+alwaysAllowed 可见） / revoke 后名单清空
- **P24 CLI `flare mcp resources`**（commit `e420989`）：
  - `flare mcp resources <服务器> [--read <uri>]` → 查看/读取 MCP 服务器暴露的资源：复用 v0.6.6 的
    `listResources`/`readResource`（stdio/HTTP 均可），连接参数 `--url`/`--config`/`--timeout` 与 mcp call 同构——
    与 mcp call/status 组成完整命令组；未暴露资源友好提示、未知 uri 协议错误退出码 1
  - docs/mcp.md CLI 章节 + README CLI 表/Changelog
  - **381/381 全绿**（377 + 4 新增 mcp-cli-call：列表元数据（uri+名称+描述+mimeType）/ --read 读取内容 / 未知 uri
    退出码 1 / 未配置服务器退出码 1），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 HTTP MCP 服务器（注入 resources）——`mcp resources` 列出 `flare://smoke/note  smoke-note · text/plain`
    + 描述、`--read` 输出「冒烟内容 OK」、未知 uri `MCP 错误: Unknown resource` 退出码 1
- **P25 CLI `flare mcp prompts`**（commit `b06f812`）：
  - `flare mcp prompts <服务器> [--get <名称>]` → 查看/渲染 MCP 服务器暴露的提示词：复用 v0.6.2 的
    `listPrompts`/`getPrompt`（stdio/HTTP 均可），`--get` 渲染 + `--args` JSON 可选——mcp 命令组完整闭环
    （call/status/resources/prompts）；未知提示词协议错误退出码 1
  - docs/mcp.md CLI 章节 + README CLI 表/Changelog（`14a22e7` 文档收尾）
  - **384/384 全绿**（381 + 3 新增 mcp-cli-call：列表元数据（名称+参数+描述）/ --get 渲染 / 未知提示词退出码 1），
    tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 HTTP MCP 服务器（注入 prompts）——`mcp prompts` 列出 `greet（参数: name）` + 描述、
    `--get greet --args '{"name":"flare"}'` 渲染「你好，flare！」、未知提示词 `MCP 错误: Unknown prompt` 退出码 1
- **下一步候选**：① agent.ts trimContext 自动裁剪（风险高仍暂缓）；② 其他安全的外围增强
  （MCP 更多协议特性、server 协议其他管理接口、CLI 更多交互增强等）

---

### 2026-08-10 第十一轮实施（v0.6.9）——server 协议 models 接口 + CLI /model list

- **P20 server 协议 models 接口**（commit `57dd1ac`）：
  - `models` 请求 → 宿主面板查询可切换模型（只读、不触发生成、不创建会话）：
    `configured.main` 当前主模型端点信息（`model` / `baseURL` 解析后端点 / `hasApiKey` 密钥是否配置 /
    `provider` 推断 ollama|deepseek|openai|other）、`configured.vision` 视觉模型（`VISION_MODEL` 配置，未配置 null）、
    `ollama` 本地 Ollama 已拉取模型列表（复用 v0.6.0 `listOllamaModels`）——宿主"可切换模型"下拉数据源
  - **库导出纯逻辑**：`detectProvider(model)` 模型名 → provider 类型推断（与 `resolveProviderOptions` 自动检测规则一致）；
    `collectModelInfo(fetchImpl?)` 收集 configured + ollama（fetch 可注入 mock，单测无网络依赖）
  - **降级安全**：Ollama 未启动/不可达 → `ollama.ok:false` + `error`（服务不崩、其余字段照常）；
    主模型 Claude 系列（不支持）→ `configured.main.error` 明确报错不抛异常；全程零 agent.ts 改动
  - docs/host-protocol.md §20 + 响应表 + 请求类型列表 + README Changelog + 版本号 0.6.9
  - **362/362 全绿**（352 + 10 新增：detectProvider 4——ollama 冒号命名/deepseek/gpt·o1·o3/other；
    collectModelInfo 5——Ollama 可达解析/视觉模型配置/不可达 ok:false/HTTP 500/Claude 主模型 error 不抛；
    server e2e 1——真实子进程 models 响应结构完整、Ollama 不可达不崩），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 server 子进程——models 返回 `deepseek-chat` 主模型（deepseek 端点 + hasApiKey true）、
    `qwen2.5vl:3b` 视觉模型（ollama 端点）、ollama 真实列出 4 个本地模型（qwen2.5:7b-64k/qwen2.5vl:3b/qwen2.5vl:7b/qwen2.5:7b）
- **P21 CLI 交互 `/model list`**（commit `5eb2189`）：
  - `/model list` → 列出本地 Ollama 可用模型（复用 `listOllamaModels`：模型名 + 大小 formatModelSize +
    当前主模型标记 ●/○ + 切换提示），并显示当前主模型；Ollama 不可达友好提示不崩；
    `list` 不是合法模型名——不写 main_model（防误切换）；`/help` 与裸 `/model` 帮助同步说明
  - **364/364 全绿**（362 + 2 新增 model-command.test.ts：/model list 输出合法且不写 main_model /
    list 不当模型名），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 PTY 交互 CLI——`/model list` 列出 qwen2.5:7b-64k（4.4 GB）/qwen2.5vl:3b（3.0 GB）/
    qwen2.5vl:7b（5.6 GB）/qwen2.5:7b（4.4 GB）+ 当前主模型 deepseek-chat，/exit 正常退出
- **下一步候选**：① agent.ts trimContext 自动裁剪（风险高仍暂缓）；② 其他安全的外围增强
  （CLI /allow 增强、MCP 更多协议特性、server 协议其他管理接口等）

---

### 2026-08-10 第十轮实施（v0.6.8）——server 协议确认门管理 confirm_status/confirm_revoke

- **P19 server 协议确认门管理**（commit `14444eb`）：
  - `confirm_status {sessionId?}` → 查询确认门状态（只读，不创建会话）：`confirmTools`（当前确认名单配置）、
    `allowedTools`（完整放行：会话级 + always 持久化合并去重）、`sessionAllowed`（会话级）、`alwaysAllowed`（持久化）——
    宿主面板"已自动放行工具"清单的数据源；无放行记录返回空名单
  - `confirm_revoke {tool}` → 撤销该工具放行（会话级 + always 持久化同步清除，恢复每次确认）；
    `{resetSession:true}` → 清空会话级放行（不影响 always 持久化，跨会话"总是允许"需逐个 tool 撤销）；
    缺参回 error（含用法提示）；无放行记录幂等 ok（服务不崩、状态不变）
  - **ConfirmationGate 新增名单查询方法**：`listAlwaysAllowed(candidates)`（KV store 无法枚举 key，
    按候选名单逐个查持久化 always）/ `listAllAllowed(candidates)`（会话级 + always 合并去重，
    含非候选的显式会话级放行）——类方法随类库导出
  - docs/host-protocol.md §18/§19 + 确认门管理章节 + 响应表 + README Changelog + 版本号 0.6.8
  - **352/352 全绿**（340 + 12 新增：名单查询 7——无 store always 退化/持久化命中/候选过滤/合并去重/
    非候选会话级并入/revoke 同步清除/空候选；协议 e2e 5——confirm_status 默认配置+空名单/指定 sessionId/
    revoke 缺参 error/幂等 ok+随后 status 仍空/resetSession），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 server 子进程——version 0.6.8、confirm_status 返回 confirmTools=['memory_save']+空名单、
    confirm_revoke 缺参 error 清晰、tool/resetSession 幂等 ok、撤销后 status 仍空
- **下一步候选**：① agent.ts trimContext 自动裁剪（风险高仍暂缓）；② 其他安全的外围增强
  （CLI /allow 增强/交互模式状态查看、MCP 更多协议特性、server 协议其他管理接口等）

---

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

