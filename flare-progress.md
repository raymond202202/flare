# Flare 引擎迭代进度（夜间调研 agent）

> 目标：flare 是 Pulse/StorySpire 依赖的 AI Agent 引擎（TS）。任何改动必须安全（tsc 0 错 + 测试全绿才 commit）。
> 铁律：禁止 push；禁止修改 src/core/agent.ts 的 Agent.run 核心循环。

> **最新状态（v0.6.27）**：**confirm 事件带工具描述**——宿主弹窗确认流程打磨（方向 1「CLI/server 接入
> ConfirmationGate」的收尾：确认流/写回类工具经确认门早已就绪，缺口是弹窗只能看到工具名+参数、无法说明
> 「AI 想做什么」）；server 协议 confirm 事件可选带 `description`（getAgent 构建工具集时从工具定义填充，
> 无描述不输出字段向后兼容）；CLI 终端确认弹窗同样带说明行（内置+MCP 工具实时查描述）；`buildConfirmEvent`
> 纯函数库导出；593/593 全绿（584 + 9）。下一步候选：
> ① 其他安全的外围增强（server 协议其他管理接口、CLI 交互增强、MCP 工具集完善等）；
> ② 摘要内容升级为 LLM 生成（语义级压缩，需评估 run 循环外异步）；
> ③ 资源桥接的宿主接线打磨（如外部 MCP 资源透传到 flare 自身 MCPServer 的 resources，需评估循环）。

### 2026-08-11 第二十七轮实施（v0.6.27）——confirm 事件带工具描述（宿主弹窗确认流程打磨）

- **P54 confirm 事件带工具描述**（src/server.ts + cli/index.ts + index.ts + 测试，commit `fbb4104`）：
  - **缺口定位**：方向 1「CLI/server 接入 ConfirmationGate」的确认流早已闭环（v0.6.1 server confirm 事件
    → 宿主回 confirm_result；v0.6.7 CLI 终端确认；v0.6.8/0.6.10 确认门管理；v0.6.18 get_config 回显名单）——
    本轮收尾打磨：confirm 事件/终端弹窗只能看到**工具名+参数**，宿主弹窗无法说明「AI 想做什么」
  - **server 协议**：`confirm` 事件可选带 `description`（工具定义描述）——getAgent 构建工具集时从工具定义
    填充 `toolDescriptions` Map（gatedTools 循环 `fn.description` 非空才 set），getGate confirmer 执行时
    实时查（gate 早建无妨，工具执行必在 Agent 构建后）；**无描述不输出字段**（buildConfirmEvent 纯函数
    `...(description ? {description} : {})`，JSON.stringify 丢 undefined）——旧宿主忽略未知字段，向后兼容；
    宿主注入的空描述工具（如 `--confirm-tools host_write` + 无描述 host 工具）confirm 事件无 description key
  - **CLI 交互模式**：`formatConfirmPrompt(toolName, args, description?)` 可选第三参——说明行
    `  说明: <描述>`（截断 80 字符）置于选项行前；`TerminalConfirmOptions.description` + terminalConfirmer
    透传；startInteractive confirmer 用 `currentToolDescription` 实时查内置 + MCP 工具描述
    （/mcp connect 后新工具也生效）；**缺省（无描述）输出与旧版逐字符一致**（零回归，测试断言相等）
  - **库导出**：`buildConfirmEvent` 纯函数 + `ConfirmEvent` 类型（index.ts re-export，与 describeTools 等
    同模式可单测）
  - docs/host-protocol.md §17（confirm_result 补 description 说明）+ 确认流章节（事件示例 + 兼容性说明）
    + 事件表 confirm 行 `description?` + README Changelog + 版本号 0.6.27
  - **593/593 全绿**（584 + 9 新增：buildConfirmEvent 4——带描述字段完整 / 无描述序列化后无 key /
    空描述视为无 / args 归一 {}；CLI 5——formatConfirmPrompt 说明行、超长截断 80、缺省与旧版相等、
    terminalConfirmer 带描述透传 ask / 缺省无说明行），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**（真实 server 子进程 + mock OpenAI 兼容端点，两场景完整 chat 流）：场景1 默认名单——
    AI 调 memory_save → confirm 事件带完整描述（`保存一条持久记忆（跨会话长期记住）…`）→ 回 allow_once
    → done；场景2 `--confirm-tools host_write` + 宿主注入空描述工具 → confirm 事件**无 description 字段**
    （序列化后无该 key）→ 回 allow_once + tool_result → done，SMOKE PASS
- **下一步候选**：① 其他安全的外围增强（server 协议其他管理接口、CLI 交互增强、MCP 工具集完善等）；
  ② 摘要内容升级为 LLM 生成（语义级压缩，需评估 run 循环外异步）；
  ③ 资源桥接的宿主接线打磨（外部 MCP 资源透传 flare 自身 MCPServer 的 resources，需评估嵌套循环风险）

---

### 2026-08-11 第二十六轮实施（v0.6.26）——McpManager 资源桥接 + server 协议 mcp_resources

- **P51 McpManager 资源桥接**（src/mcp/manager.ts + types.ts + index.ts + 测试，commit `1abd6ae`）：
  - **客户端侧资源消费缺口**：flare 连接外部 MCP 服务器时只桥接工具（createMcpTools），外部服务器
    暴露的 **resources 完全没消费**——方向 2「resources 真实暴露打磨」的天然切入点；本轮补齐：
    连接时 `Promise.all` 拉取 `resources/list` + `resources/templates/list`
  - **容错设计**：服务器无 resources 能力/请求失败 → 静默降级为空数组（safeListResources /
    safeListResourceTemplates 辅助），**不阻塞连接**（与启动时后台连接失败的容错风格一致）——工具桥接
    失败仍整体失败（工具是硬依赖），资源是展示性数据可降级
  - **新 API**：`getAllResources()` / `getAllResourceTemplates()` → 带来源（`server` 名）的资源/
    模板并集（`McpResourceRef` / `McpResourceTemplateRef` 类型库导出）；`readResource(name, uri)`
    代理调对应服务器 `resources/read`（未连接服务器 reject 清晰错误「MCP 服务器未连接: <name>」）；
    `status()` 已连接时带 `resourceCount` / `templateCount`（可选字段，旧断言零回归）；
    `disconnect` 资源/模板随连接一并清理
  - **接口抽象**：`McpResourceClient` 最小客户端接口（listResources/listResourceTemplates/readResource）——
    stdio MCPClient 与 HTTP MCPHttpClient 都满足，传输无关（与 v0.6.6 工具桥同模式）
  - **server 协议 `mcp_resources`**（src/server.ts）：`{type:'mcp_resources'}` →
    `{type:'mcp_resources', servers:[{name, connected, toolCount, resources?, templates?, error?}]}`——
    宿主面板「外部 MCP 资源」数据源（展示/透传外部服务器暴露的资源与动态资源形态）；已连接服务器带
    resources/templates（每项含来源 server），未连接不带；只读不触发生成、不创建会话；等待启动时后台
    连接落定（与 mcp_status 一致）；docs/host-protocol.md §16.1 新章节 + 请求类型列表
  - **CLI `/mcp` 状态行增强 + `/mcp resources [name]` 子命令 + connect 摘要带资源数**：已连接服务器显示
    `（N 个工具 · M 资源 · K 模板）`（有资源/模板才显示对应段，无资源服务器输出与旧版一致）；
    `/mcp resources [name]`（handleSlashCommand mcp hooks 新增可选 `resources?(name?)` 方法——
    未提供回退提示「当前环境未提供资源桥接」，向后兼容旧宿主）列出已桥接资源/模板
    （`📄 uri — 描述` + `🧩 uriTemplate`；带 name 过滤单服务器；无资源友好提示；/help 注册）；
    `/mcp connect` 摘要带 `（N 个 MCP 工具 · M 个资源 · K 个模板）`（无资源时与旧版一致）
  - docs/mcp.md 交互模式 + 编程方式章节更新（资源桥接示例）+ README Changelog + 版本号 0.6.26
  - **584/584 全绿**（583 + 1 新增：CLI /mcp connect 摘要带资源/模板数透传不破坏；P51 的 7 项——
    McpManager 5 + server 协议 e2e 2；P52 的 6 项——CLI /mcp resources 系列，均见上），
    tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 mock 服务器 + 真实命令渲染组合——`/mcp` 状态行
    `● mock（3 个工具 · 2 资源 · 1 模板）`；`/mcp resources` 列出
    `📄 memory://preferences — 用户偏好设置` + `📄 file:///etc/hosts` +
    `🧩 memory://{noteId} — 记忆库中的单条记忆`，SMOKE PASS
- **下一步候选**：① 其他安全的外围增强（server 协议其他管理接口、CLI 交互增强、MCP 工具集完善等）；
  ② 摘要内容升级为 LLM 生成（语义级压缩，需评估 run 循环外异步）；
  ③ 资源桥接的宿主接线打磨（外部 MCP 资源透传 flare 自身 MCPServer 的 resources，需评估嵌套循环风险）

---

### 2026-08-11 第二十五轮实施（v0.6.25）——MCP 列表变化通知补齐 prompts/list_changed + CLI /memory 搜索 + get_memories 增强

- **P48 `notifications/prompts/list_changed` 对称补齐**（src/mcp/server.ts + client.ts + 测试，commit `af53cdc`）：
  - **协议缺口修复**：MCP 标准列表变化通知共三个（tools/resources/prompts），v0.6.20 只做了前两个——
    本轮补上第三个 `notifications/prompts/list_changed`（提示词**列表**动态变化，运行中新增/移除 prompt）
  - **服务器侧** `MCPServer.notifyPromptListChanged()`：发 `notifications/prompts/list_changed`
    （无 id、无 params，客户端无需响应）；已关闭 / 写失败 → 静默忽略（与 notifyToolListChanged 同风格）；
    与另两个方法独立，可分别按需调用
  - **客户端侧** `MCPClient` 新增 `onPromptsChanged()` 回调选项——handleNotification 新增分支
    （收到对应通知触发，建议回调内重新拉取 prompts/list 刷新清单）；未配置静默忽略不干扰后续请求；
    三个回调独立，只配置其一互不影响；MCPHttpClient 无 SSE 长连接不提供（传输差异与 v0.6.20 一致）
  - docs/mcp.md 列表变化通知章节更新（三通知同文档、示例含 prompts）+ README Changelog + 版本号 0.6.25
  - **562/562 全绿**（560 + 2 新增：MCPServer 2——notifyPromptListChanged 推送结构（无 id/params）/
    三者独立互不干扰；e2e 扩展——fixture notify_changed 工具改为推送三个通知，真实子进程三回调各收到
    2 次且连接不断；MCPClient list-changed 模式断言并入 prompts、已关闭静默并入既有用例），
    tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 stdio 子进程闭环——callTool notify_all → 工具执行中推送三个列表变化通知 →
    客户端三回调各收到 1 次，serverInfo 0.6.25，SMOKE PASS
- **P49 CLI `/memory <关键词>` 搜索记忆**（src/cli/index.ts + tests/memory-command.test.ts，commit `4ce0bcd`）：
  - **记忆侧搜索缺口**：`/memory` 只能列出全部、`/search`（v0.6.24）只搜消息——记忆的搜索查看缺失；
    现在 `/memory <关键词>` 复用 `store.searchMemories`（FTS5 trigram，中文友好）全文搜索持久记忆，
    与 /search 对称（命中列表、不相关不出现）
  - **行为**：`/memory`（无关键词）列出全部（与旧版一致，零回归）；`/memory <关键词>` 搜索最多 10 条
    命中（🔍 记忆「kw」相关 N 条）；无结果友好提示「未找到包含…」；命令处理从前缀匹配分支进入
    （与 /remember /search 同模式，避免带参落 switch 未知命令）；`/help` 注册说明更新
  - **567/567 全绿**（562 + 5 新增 memory-command.test.ts：列出全部 / 关键词 FTS 命中（不相关不出现）/
    无记忆提示 / 无结果提示 / help 注册），tsc 0 错误，零 agent.ts 改动
- **P50 server 协议 get_memories 增强**（src/server.ts + memory/store.ts + 测试，commit `ae40975`）：
  - **kind 按记忆类型过滤**：`get_memories {kind?}` 只返回该类型记忆（如 `preference` 偏好 / `note` 笔记；
    与 remember 的 kind 参数同语义；不用 type——那是请求判别符）——宿主面板"记忆管理"按类型筛选数据源；
    与 `query` 组合时先搜索再按类型过滤（searchMemories 结果 filter type）
  - **`MemoryStore.getMemoriesByType(type, limit=50)`**（新方法）：`WHERE type = ? ORDER BY
    created_at DESC, id DESC`（同秒插入用自增 id 次级排序，与 getRecentMessages v0.6.21 同模式）；
    空 type 等价列出全部（与 getAllMemories 一致）、无匹配类型幂等返回 []
  - **limit 严格校验**：显式提供必须 1~100 整数（0/-1/101/非数字/小数回 error 含用法提示，对齐
    get_messages v0.6.21 风格不触发生成）；缺省 50 行为与旧版一致（零回归）
  - docs/host-protocol.md §13 更新（kind 参数 + limit 校验说明，请求示例）
  - **570/570 全绿**（567 + 3 新增：store 单测 1——类型过滤+limit 截断+空 type 全部+无匹配空数组；
    server e2e 2——kind 过滤只返回该类型（含 query+kind 组合、无匹配幂等）/ limit 非法值
    （0/-1/101/'abc'/1.5）全 error 含提示 + 缺省不报错），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 server 子进程——remember 两条（preference + note）→ get_memories kind=preference
    只回「冒烟偏好A:preference」→ limit:0 → error「get_memories 的 limit 必须是 1~100 的整数」→
    kind=ghost 空数组，SMOKE PASS
- **下一步候选**：① 其他安全的外围增强（server 协议其他管理接口、CLI 交互增强、MCP 工具集完善等）；
  ② 摘要内容升级为 LLM 生成（语义级压缩，需评估 run 循环外异步）

---

### 2026-08-11 第二十四轮实施（v0.6.24）——search_messages 全文搜索 + MCPClient.ping 对称补齐

- **P46 server 协议 `search_messages`**（src/server.ts + cli/index.ts + 测试，commit `3162fa3`）：
  - **宿主面板"搜索历史对话"数据源**：复用记忆库 FTS5 trigram 全文索引（`MemoryStore.searchMessages`
    v0.5.1 已存在但协议层未暴露）——bm25 相关度排序、中文友好；短查询 <3 字自动 LIKE 回退
  - **协议请求** `search_messages {query?, limit?}` → `{ type:'search_results', query,
    results:[{sessionId,role,content,createdAt}] }`——**跨全部会话**检索（与 get_usage 全局统计同风格，
    只读不触发生成、不创建会话）；`query` 必填（缺失/空白回 error 含用法提示）、`limit` 1~100 整数
    默认 10（非法回 error 含提示）、无结果空数组幂等不报错
  - **CLI 交互 `/search <关键词>`**：跨会话搜索历史对话（找回旧对话），显示命中消息角色/时间/内容
    截断；无关键词用法提示、无结果友好提示；`/help` + README 命令表注册
  - docs/host-protocol.md §5.1 新章节 + 请求类型列表 + README Changelog + 版本号 0.6.24
  - **558/558 全绿**（550 + 8 新增：server e2e 4——缺 query/空白 error / 非法 limit（0/-1/101/非数字）/
    合法路径空结果幂等 / **数据往返**（测试进程写入临时库消息后协议可搜索到，含 sessionId/role/content
    断言 + 不相关内容不命中）；CLI /search 4——命中列表跨会话 / 无关键词用法提示 / 无结果提示 /
    help 注册），tsc 0 错误，零 agent.ts 改动；另修既有 rename_session e2e 的 recent_sessions 请求
    limit 放宽（测试会话累积防挤出，非业务改动，与 v0.6.21 同模式）
  - **冒烟实测**：真实 server 子进程——version 0.6.24、空白 query → error「search_messages 需要
    query 参数（搜索关键词）…」、limit:0 → 「limit 必须是 1~100 的整数」、合法路径 search_results
    空数组，SMOKE PASS
- **P47 MCPClient.ping() 对称补齐**（src/mcp/client.ts + 测试，同 commit）：
  - **接口不对称修复**：`MCPHttpClient.ping()` 早有（返回 boolean），stdio `MCPClient` 却缺（头注释
    也声明两端接口应一致）——补 `ping(): Promise<boolean>`：发 MCP 标准 `ping` 请求（服务器回空
    result 即存活），成功返回 `true`，断开/超时/协议错误 reject；无状态保活探测不干扰后续请求
  - **MCPServer 零改动**（dispatch 的 `case 'ping'` 早已返回 `{}`）；mock 测试 fixture 补 ping case
  - docs/mcp.md 编程方式章节补 ping 健康检查示例（stdio/HTTP 对称声明）+ README Changelog 并入 v0.6.24
  - **560/560 全绿**（558 + 2 新增：ping 真实互通——mock 服务器 ping 往返 + ping 后连接仍可用 /
    close 后 reject），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 stdio MCPClient ↔ 真实 MCPServer 子进程——initialize（flare 0.6.24）、
    ping true ×2、ping 后 listTools 6 个正常，SMOKE PASS
- **下一步候选**：① 其他安全的外围增强（server 协议其他管理接口、CLI 交互增强、MCP 工具集完善等）；
  ② 摘要内容升级为 LLM 生成（语义级压缩，需评估 run 循环外异步）

---

### 2026-08-11 第二十三轮实施（v0.6.22 + v0.6.23）——MCP 资源模板 + completion 模板候选

- **P44 MCP 资源模板协议**（src/mcp/types.ts + server.ts + client.ts + http-client.ts + 测试，commit `f4e13bf`）：
  - **动态资源场景**：uri 含变量的资源（如 `memory://{noteId}` 的每条记忆）无法在 `resources/list`
    逐条列出——MCP 标准用**资源模板**声明其形态，客户端据此知道如何构造/发现这类资源
  - **服务器侧** `MCPServerOptions.resourceTemplates?: McpResourceTemplate[]`（`uriTemplate` RFC 6570
    风格 `{var}` 占位 + `name` + 可选 `description`/`mimeType`）；dispatch 新增标准方法
    `resources/templates/list` → 返回模板元数据；**未注入返回空列表**（方法始终可用，不报错，与
    resources/list 同风格）；有模板时 `capabilities.resources` 声明 `{ subscribe: true, listTemplates: true }`，
    **仅静态资源无模板仍为 `{ subscribe: true }`**（缺省行为与旧版完全一致，既有断言零回归）；
    仅模板无静态资源也声明 resources 能力（客户端可发现模板）
  - **纯函数 `matchResourceTemplate(uri, template)`**（库导出）：判断 uri 是否匹配某模板——模板编译
    为正则（`{var}` 捕获组；`path`/`uri` 类变量允许任意字符含 `/`，其余变量单段不含 `/`），匹配返回
    模板对象、不匹配返回 `null`；宿主可校验动态资源 uri 合法性/生成模板候选 uri；修复转义顺序 bug
    （先整体转义 `{` 导致占位符无法识别 → 改按占位符分段再转义字面段）
  - **客户端消费**：`MCPClient.listResourceTemplates()` / `MCPHttpClient.listResourceTemplates()` → 模板
    数组（stdio / HTTP 同构，与 listResources 一致，非数组容错 []）；HTTP transport 复用 handleMessage
    核心**自动支持**（无需额外改动）
  - **与 completion 定位差异（文档记录）**：v0.6.11 `completion/complete`（ref/resource）按**已暴露
    静态资源** uri 前缀补全；模板声明**动态资源形态**（客户端自行构造变量段）——静态可枚举、动态靠模板发现
  - docs/mcp.md 资源模板章节 + README Changelog + 版本号 0.6.22
  - **549/549 全绿**（基线 541 + 8 新增：MCPServer 5——templates/list 返回注入模板含可选字段 / 未注入
    空列表 / capabilities 三形状（有模板+仅资源+仅模板）/ matchResourceTemplate 纯函数单段·path 含 /·
    不匹配 null / **资源模板真实互通 e2e**——真实 MCPServer 子进程静态资源+动态模板，客户端
    listResources+listResourceTemplates+readResource 闭环连接不断；MCPClient 1——listResourceTemplates
    解析（mock server 新增 templates case）；MCPHttpClient 2——HTTP 消费闭环 + 未注入模板零回归），
    tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 tsx 子进程——version 0.6.22、capabilities.resources 含 listTemplates、
    templates 列出 `memory://{noteId}`、静态资源 + readResource 正常，SMOKE PASS
- **P45 completion/complete 并入资源模板候选**（src/mcp/server.ts + 测试，commit `4f238cb`）：
  - **衔接自然**：v0.6.22 模板协议暴露后，v0.6.11 的 ref/resource 补全候选从**仅静态资源 uri**
    扩展为**静态资源 + 资源模板 uriTemplate**——客户端输入 uri 前缀（如 `memory://`）时同时建议
    静态资源（`memory://preferences`）与动态资源形态（`memory://{noteId}`）
  - **行为**：静态在前、模板在后（数组顺序明确）；仅模板前缀命中只回模板候选；空匹配空候选不报错；
    未注入模板时行为与旧版完全一致（零回归）；仍走既有 complete 方法体（无新接口）
  - docs/mcp.md 资源模板章节「与 completion 的关系」更新 + README Changelog + 版本号 0.6.23
  - **550/550 全绿**（549 + 1 新增：ref/resource 模板候选——静态+模板合并顺序 / 仅模板命中 / 空匹配
    空候选），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 tsx 子进程——version 0.6.23、completion ref/resource 输入 memory:// 同时建议
    `memory://preferences` + `memory://{noteId}`，SMOKE PASS
- **下一步候选**：① 其他安全的外围增强（server 协议其他管理接口、CLI 交互增强、MCP 工具集完善等）；
  ② 摘要内容升级为 LLM 生成（语义级压缩，需评估 run 循环外异步）

---

### 2026-08-11 第二十二轮实施（v0.6.20 + v0.6.21）——MCP 列表变化通知 + get_messages 分页增强

- **P42 MCP 列表变化通知**（src/mcp/server.ts + client.ts + fixtures + 测试，commit `f35f850`）：
  - **服务器侧** `MCPServer.notifyToolListChanged()` / `notifyResourceListChanged()`：工具集/资源列表
    **动态变化**（运行中新增或移除，非内容更新）时推送 MCP 标准通知 `notifications/tools/list_changed`
    / `notifications/resources/list_changed`（无 id、无 params，客户端无需响应）——客户端收到后应
    重新拉取 tools/list / resources/list 刷新清单；与 v0.6.15 的 `resources/updated`（订阅的单个资源
    **内容**变化）互补：updated 面向已订阅 uri，list_changed 面向**列表整体**、无需订阅（所有已连接
    客户端收到）；服务器已关闭 / 写失败 → 静默忽略（不抛错）；两方法相互独立可分别调用
  - **客户端侧** `MCPClient` 选项新增 `onToolsChanged()` / `onResourcesChanged()` 回调——handleNotification
    分流新增两分支：收到对应通知触发（无参，建议回调内重新 listTools/listResources）；未配置静默忽略
    不干扰后续请求；两个回调独立只配置其一互不影响
  - **传输差异（文档记录）**：stdio 可推送；HTTP transport 一请求一响应无推送通道（服务器可调用不抛错
    但客户端收不到）；MCPHttpClient 无 SSE 故不提供回调，文档如实记录不假装支持
  - docs/mcp.md 列表变化通知章节 + README Changelog + 版本号 0.6.20
  - **535/535 全绿**（527 + 8 新增：MCPServer 5——notifyToolListChanged 推送结构 / notifyResourceListChanged
    推送结构 / 两者独立互不干扰 / 已关闭静默 / **list_changed 真实互通 e2e**（真实子进程 callTool
    notify_changed → 两回调各收到 2 次且连接不断）；MCPClient 3——两回调各触发 / 只配其一互不干扰 /
    未配置忽略不抛错），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 tsx 子进程——version 0.6.20、工具结果正常、两回调真实触发，SMOKE PASS
- **P43 server 协议 get_messages 分页增强**（src/server.ts + memory/store.ts + 测试，commit `8f1116f`）：
  - **协议请求** `get_messages {sessionId?, limit?, recent?}`：`limit`（1~500 整数，默认 50，非法回
    error 含用法提示不触发生成）+ `recent`（布尔）——`recent:true` 返回**最近** limit 条（宿主面板
    "最近对话/当前上下文"数据源；长会话下默认取最早 limit 条看不到最新内容），响应带 `recent:true`
    标记；**缺省行为与旧版完全一致**（最早 50 条，向后兼容零回归）
  - **`MemoryStore.getRecentMessages(sessionId, limit=50)`**（新方法）：`ORDER BY created_at DESC,
    id DESC` 取最近 limit 条后反转回正序返回（同秒插入用自增 id 次级排序保证顺序确定）——与
    getMessages（最早 limit 条）差异明确；空/不存在会话幂等返回 []
  - docs/host-protocol.md §5 参数表 + README Changelog + 版本号 0.6.21
  - **542/542 全绿**（535 + 7 新增：store 单测 3——最近 limit 条正序返回 / 与 getMessages 取最早差异
    明确 / 缺省 50+空会话幂等；server e2e 4——limit 合法路径不破坏 / recent 标记透传 / 非法 limit
    （0/-1/501/非数字）全 error 含提示），tsc 0 错误，零 agent.ts 改动；
    另修既有 rename_session e2e 的 recent_sessions 请求 limit 放宽（测试会话累积防挤出，非业务改动）
  - **冒烟实测**：真实 server 子进程——version engine 0.6.21、缺省 get_messages 无 recent 标记、
    recent:true 响应带标记、非法 limit(0/'abc') 均 error「get_messages 的 limit 必须是 1~500 的整数」，
    SMOKE PASS
- **下一步候选**：① 其他安全的外围增强（server 协议其他管理接口、CLI 交互增强、MCP 工具集完善等）；
  ② 摘要内容升级为 LLM 生成（语义级压缩，需评估 run 循环外异步）

---

### 2026-08-10 第二十一轮实施（v0.6.19）——上下文压缩摘要：裁剪掉的历史压缩成摘要

- **P41 上下文压缩摘要**（src/core/context.ts + core/agent.ts + server.ts + cli/index.ts）：
  - **纯函数 `summarizeTrimmedMessages(messages, opts)`**（context.ts）：在 trimContextMessages
    基础上**把丢弃的历史压缩成摘要消息**而非直接丢弃——AI 保留话题连续性（长会话裁剪后仍知道
    之前聊过什么/调过哪些工具）；**未裁剪返回原数组引用**（零拷贝契约与 trimContextMessages 一致）；
    裁剪后摘要紧随 system 之后（`role` 默认 'system'，可配 'user'）
  - **`buildSummaryText` 纯启发式统计，不调 LLM**（零额外成本）：被压缩条数 + 角色分布
    （user/assistant/tool）+ 估算 tokens + 涉及工具**去重列表**（tool 响应 name + assistant.tool_calls，
    最多 maxTools 个）+ **最后话题**（最新被裁消息内容片段，AI 衔接最近话题）；
    参数 `role`/`maxChars`（默认 400 超长截断）/`maxTools`（默认 8）/`includeTail`/`tailChars`
  - **摘要链防堆积**：摘要以 `SUMMARY_MARKER`（`[历史摘要]`）开头；下次裁剪时旧摘要**无论被保留
    还是被裁掉**都被识别并合并进新摘要（新摘要含"更早历史"行，多次裁剪不越滚越大）
  - **AgentConfig 新增 `contextSummarize`（默认 false）**：trimContext 私有方法体委托
    （contextSummarize 时走 summarizeTrimmedMessages）——**run 循环调用点/结构零改动**，
    不配置行为与旧版完全一致（零回归）
  - **server 协议透传**：chat 请求带 `contextSummarize`（布尔，非布尔回 error 含提示不触发生成）；
    `HostServerOptions.defaultContextSummarize` + CLI `flare server --context-summarize` server 级
    默认（chat 未指定时应用，请求优先）；ctxOptsChanged 同机制自动重建 Agent；
    `get_config` 回显 `defaultContextSummarize`（只读，不含密钥）
  - **库导出**：`summarizeTrimmedMessages`/`buildSummaryText`/`SUMMARY_MARKER` + 类型
    `SummarizeOptions`/`TrimStats`
  - docs/context-observability.md 压缩摘要章节（含未来方向：LLM 语义级摘要需评估 run 循环外异步）
    + docs/host-protocol.md chat 参数表 + get_config 响应 + README Changelog/CLI 表 + 版本号 0.6.19
  - **526/526 全绿**（506 + 20 新增：summarizeTrimmedMessages 纯函数 11——未裁剪原引用零拷贝 /
    摘要紧随 system+条数统计 / 角色分布+涉及工具去重 / 最后话题最新被裁 / 摘要链防堆积（丢弃区+
    保留区旧摘要合并覆盖不堆积） / maxChars 截断 / role=user / includeTail:false / 无 system 摘要
    放最前 / maxTools 限制；buildSummaryText 2——基础统计行 / previousSummary 更早历史；
    Agent 集成 2——contextSummarize 生效含摘要 / 缺省 false 零回归；server e2e 5——默认值不破坏
    启动 / 非法 contextSummarize error / 缺省应用默认 / 合法透传流程完整 / get_config 回显），
    tsc 0 错误，**run 循环零改动**
  - **冒烟实测**：真实 server 子进程带 --context-summarize——version 协商正常、get_config 回显
    defaultContextSummarize true、非法 contextSummarize('yes') → 「必须是布尔值」error 清晰，
    SMOKE PASS（chat 合法链路由 e2e 真实子进程覆盖）
- **P41b CLI 交互模式接入**（src/cli/index.ts）：`flare chat --context-summarize` 开启交互模式压缩
  摘要（makeAgent 构造 Agent 时传 `contextSummarize`；长会话裁剪后 AI 保留话题连续性，与 server 端
  对称）——`--help` 注册测试 +1 → **527/527 全绿**（526 + 1），tsc 0 错误，零 agent.ts 改动
- **下一步候选**：① 其他安全的外围增强（CLI 交互增强、MCP 工具集完善、server 协议其他管理接口）；
  ② 摘要内容升级为 LLM 生成（语义级压缩，需评估 run 循环外异步）

---

### 2026-08-10 第二十轮实施（v0.6.18）——server 协议会话管理：rename_session + clear_session

- **P37 server 协议 `rename_session`**（src/server.ts + tests/server.test.ts）：
  - **协议请求** `rename_session {sessionId?, title}` → `{ type:'ok', sessionId, title }`——宿主面板
    "重命名会话"专用接口（与 create_session 创建语义分离）：title 非空必填（空白裁剪判空，缺失/空白
    回 error 含用法提示，不触发生成）；复用 `MemoryStore.updateSessionTitle`（UPSERT——会话不存在自动
    创建，与 create_session 同语义）；namespace 前缀处理与 create_session 一致
  - docs/host-protocol.md §23 + 请求类型列表 + 响应表 ok 行（title?）+ README Changelog + 版本号 0.6.18
  - **499/499 全绿**（496 + 3 新增 server e2e：重命名成功且 recent_sessions 反映新标题 / 缺 title·空白
    title error / 不存在会话 UPSERT 幂等），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 server 子进程——create_session 冒烟旧标题 → rename_session 冒烟新标题 ok（回显
    title）→ 缺 title / 空白 title 均 error「rename_session 需要 title 参数（非空的新会话标题）」→
    不存在会话 s-ghost UPSERT ok → recent_sessions 数据往返（冒烟新标题 + 幽灵会话）→ version 0.6.18，
    SMOKE PASS
- **P38 server 协议 `clear_session` + store 清空方法**（src/server.ts + memory/store.ts + 测试）：
  - **`MemoryStore.clearSessionMessages(sessionId)`**：DELETE 该会话全部消息（返回删除条数；FTS 触发器
    联动清索引）+ 刷新会话 updated_at；空/不存在会话幂等返回 0——**保留会话记录与用量统计**（区别于
    deleteSession 整个删除），清空后仍可继续写入（无外键问题）
  - **协议请求** `clear_session {sessionId?}` → `{ type:'ok', sessionId, cleared }`——宿主面板"清空对话"
    按钮数据源；同时 `agents.delete(sessionId)` 销毁缓存 Agent（内存上下文同步清空，下次 chat 重建干净
    会话；与 delete_session 同模式）
  - docs/host-protocol.md §24 + 请求类型列表 + 响应表 ok 行（cleared?）+ README Changelog 并入 v0.6.18
  - **504/504 全绿**（499 + 5 新增：store 单测 3——清空指定会话+会话保留+FTS 联动 / 不影响其他会话 /
    空会话幂等+清空后可继续写入；server e2e 2——清空保留会话+消息为空 / 幂等 cleared:0），tsc 0 错误，
    零 agent.ts 改动
  - **冒烟实测**：真实 server 子进程——create_session s-c → clear_session cleared:0 → 再 clear 幂等
    cleared:0 → list_sessions s-c 保留（messageCount 0）→ version 0.6.18，SMOKE PASS
- **P39 server 协议 `get_config`**（src/server.ts + tests/server.test.ts）：
  - **协议请求** `get_config {}` → `{ type:'config', ... }`——宿主面板"设置/关于"数据源（只读，
    不触发生成、不创建会话）：确认门配置（`confirmTools` 名单 / `confirmTimeoutMs` 超时）、默认采样
    参数（`defaultMaxTokens`/`defaultTemperature`，未配置 null）、默认上下文裁剪参数
    （`defaultMaxContextMessages`/`defaultMaxContextTokens`，未配置 null）、`toolTimeoutMs`、
    `namespace`、`storage`（非字符串 null）、`mcpServers` MCP 清单（名称 + 传输类型 http/stdio）
  - **安全**：不含任何密钥/敏感配置（只回显运行参数）
  - docs/host-protocol.md §25 + 请求类型列表 + 响应表 config 行 + README Changelog 并入 v0.6.18
  - **505/505 全绿**（504 + 1 新增 server e2e：config 结构完整——默认名单/30s 超时/默认参数 null/
    工具超时/storage 路径/mcpServers 数组），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 server 子进程带 --max-tokens 1024 --temperature 0.3 --max-context-messages 40——
    config 正确回显（defaultMaxTokens 1024 / defaultTemperature 0.3 / defaultMaxContextMessages 40 /
    confirmTools ['memory_save'] / storage 路径 / mcpServers []），SMOKE PASS
- **P40 用量按模型分解（perModel）**（src/memory/store.ts + cli/index.ts + server.ts）：
  - **`getUsageStats()` 新增 `perModel`**：GROUP BY model 分组（model/calls/promptTokens/completionTokens/
    totalTokens，按调用次数降序；无模型记录 COALESCE 'unknown'）——宿主成本核算/用量分布数据源；
    server 协议 get_usage 响应 stats 透传（fallback 补 perModel:[]）；CLI `/usage` 每个模型一行
  - docs/host-protocol.md §9 响应示例 + 响应表 usage 行 + README Changelog 并入 v0.6.18
  - **506/506 全绿**（505 + 1 新增 store 单测：多模型分组/次数降序/unknown 归并/token 分解；get_usage
    e2e 与 CLI /usage 断言补充进既有测试），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 server 子进程——空库 get_usage perModel:[]；带数据 getUsageStats 返回
    deepseek-chat 2 次 430 tokens + qwen2.5:7b 1 次 420 tokens（总量 850 一致），SMOKE PASS
- **下一步候选**：① 上下文压缩摘要（裁剪掉的历史压缩成摘要而非直接丢弃，需评估——涉及 run 循环则跳过）；
  ② 其他安全的外围增强（CLI 交互增强、MCP 工具集完善等）

---

### 2026-08-10 第十九轮实施（v0.6.17）——上下文自动裁剪：trimContext 支持 token 预算

- **P34 上下文自动裁剪**（src/core/context.ts + core/agent.ts + server.ts + cli/index.ts）：
  - **纯函数 `trimContextMessages(messages, { maxMessages?, maxTokens? })`**（context.ts）：
    与 suggestTrim（宿主建议、不保证配对）不同，这是 Agent 内部安全裁剪——**保证不拆散
    tool_calls ↔ tool 响应配对**（LLM 收到拆散配对会 400）：system 保底（token 计入预算，
    保留部分严格不超）+ 最近优先 + 配对链（tool/assistant(tool_calls)）无条件保留 +
    极小预算仍保底最新一条（AI 必须看到最新输入）+ `maxMessages:0` = 关闭条数裁剪 +
    未超限返回原数组引用（零拷贝）；默认 30 条行为与原 trimContext 逐条等价
  - **AgentConfig 新增 `maxContextMessages`（默认 30）/ `maxContextTokens`（可选）**：
    `trimContext()` 委托纯函数（私有方法体替换，**run 循环调用点/结构不动**）——
    不配置则行为与旧版完全一致（保留最近 30 条，零回归）；宿主免手动 set_context
  - **server 协议透传**：chat 请求带 `maxContextMessages`（非负整数，0=不按条数）/
    `maxContextTokens`（正整数）——非法回 error 不触发生成；变化自动重建 Agent 立即生效
    （ctxOptsChanged 与 model/采样参数同机制，agents entry 记录 ctxOpts）；
    `HostServerOptions.defaultMaxContextMessages/defaultMaxContextTokens` + CLI
    `flare server --max-context-messages <n> / --max-context-tokens <n>` server 级默认
    （chat 未指定时应用，请求优先）
  - docs/context-observability.md 自动裁剪章节（suggestTrim vs trimContextMessages 定位差异）
    + docs/host-protocol.md chat 参数表 + README Changelog/CLI 表 + 版本号 0.6.17
  - **491/491 全绿**（469 + 22 新增：trimContextMessages 纯函数 11——空/零拷贝原引用/默认
    30 条/maxMessages 可配/0 关闭条数/token 预算/极小预算保底/system 保底/token+条数取紧/
    配对保护/tail tool 连带配对；Agent 集成 5——默认零回归 30 条/maxContextMessages 生效/
    0 不裁/预算裁剪/极小预算保底最新输入；server e2e 6——默认值不破坏启动/不带参数应用默认/
    非法 maxContextMessages·负数·非法 maxContextTokens·0/合法透传流程完整），tsc 0 错误，
    **run 循环零改动**（仅 trimContext 私有方法体委托）
  - **冒烟实测**：真实 server 子进程——version 0.6.17、chat 协议流完整（text→done）、
    非法 maxContextMessages（-1）→「必须是非负整数」error、非法 maxContextTokens（0）→
    「必须是正整数」error、context_status 正常响应，SMOKE PASS
- **P35 server 协议 `session_usage`**（src/server.ts + memory/store.ts）：
  - **`MemoryStore.getSessionUsage(sessionId)`**：按 session_id 过滤 usage_log 汇总单会话用量
    （prompt/completion/totalTokens + callCount；无记录全 0 幂等不抛错）
  - **协议请求** `session_usage {sessionId?}` → `{ type:'session_usage', sessionId, stats }`——
    宿主面板"本会话用量/成本"数据源（区别于 get_usage 全局汇总；namespace 前缀处理与
    get_messages 一致）；缺省 default 会话；只读不触发生成
  - docs/host-protocol.md §9.1 + 请求类型列表 + README Changelog 并入 v0.6.17 条目
  - **493/493 全绿**（491 + 2 新增：store 单会话过滤+无记录幂等 / 协议响应结构+缺省 default），
    tsc 0 错误，零 agent.ts 改动
- **P36 CLI `/usage` 本会话用量**（src/cli/index.ts + tests/cli-confirm.test.ts）：
  - `/usage` 全局统计下方新增「本会话」行（`store.getSessionUsage(sessionId)`：tokens + 调用次数）
  - `handleSlashCommand` 新增可选 `sessionId` 参数（缺省不显示——向后兼容，宿主集成不受影响）
  - **496/496 全绿**（493 + 3 新增：无记录提示 / 带 sessionId 显示本会话行+按会话过滤（全局 2428 vs
    本会话 430）/ 缺省不显示），tsc 0 错误，零 agent.ts 改动
- **下一步候选**：① 上下文压缩摘要（裁剪掉的历史压缩成摘要而非直接丢弃，需评估）；
  ② 其他安全的外围增强（MCP 协议特性已基本覆盖，可考虑 server 协议其他管理接口、CLI 交互增强、
  MCP 工具集完善等）

---

### 2026-08-10 第十八轮实施（v0.6.16）——MCP progress + cancelled 通知协议闭环

- **P33 MCP progress + cancelled 通知**（src/mcp/server.ts + client.ts + http-client.ts + types.ts）：
  - **progress 协议语义**：服务器处理**长请求**（耗时工具调用）期间推送进度——客户端无需轮询；
    关联方式：客户端在请求 `_meta.progressToken` 指定令牌，服务器推送时原样回传
  - **服务器侧**：`MCPServer.notifyProgress(progress?, total?, message?)` 发 `notifications/progress`
    （无 id，客户端无需响应）——只在**正在处理的请求带 `_meta.progressToken`** 时推送（活动令牌机制，
    handleMessage 进入时记录、finally 恢复；串行队列保证同一时刻只有一个活动请求，令牌不串）；
    无活动令牌 / 已关闭 / 写失败 → 静默忽略不抛错
  - **客户端侧**：`MCPClient` 新增 `onProgress` 回调（收到 `notifications/progress` 转发
    `{ progressToken, progress?, total?, message? }`；未配置忽略不干扰后续请求）+ `callTool(name, args?,
    options?)` 第三参 `{ progressToken }` → 请求带 `_meta`（不带则行为与旧版一致，向后兼容）
  - **cancelled 协议语义**：请求方放弃已发出请求时通知对方——`MCPClient.notifyCancelled(requestId,
    reason?)` / `MCPHttpClient.notifyCancelled`（async，发通知回 202）发 `notifications/cancelled`
    （超时/用户取消后礼貌告知服务器）
  - **服务器侧接收**：handleMessage 通知分流新增 handleNotification——`notifications/cancelled` 命中
    pending（服务器→客户端请求如 `requestRoots` / `requestSample` 等待响应中）→ reject 并清理
    （不悬挂，错误含 reason）；未知/已完成请求 → 静默忽略（连接不断）
  - **传输差异（文档记录）**：HTTP transport 共用 handleMessage 核心，请求带 `_meta.progressToken`
    可识别、`notifications/cancelled` 正常处理（202）；但无 SSE 推送通道，`notifyProgress` 客户端
    收不到（与 logging/resources 订阅一致）；stdio 串行队列下取消通知通常排在慢请求之后到达——
    cancelled 的主要价值是**协议完整性与超时后的礼貌告知**，对 pending 请求的取消真实生效
  - `McpProgressParams` / `McpCancelledParams` / `McpCallOptions` 类型库导出；
    docs/mcp.md progress + cancelled 协议章节 + README Changelog + 版本号 0.6.16
  - **469/469 全绿**（454 + 15 新增：MCPServer 7——带 token 推送结构含无 id / 无 token 静默 /
    请求完成令牌清除 / 已关闭静默 / cancelled 取消 pending reject / 未知 requestId 静默后续正常 +
    **progress 真实互通 e2e**——真实 MCPServer 子进程 callTool 带 progressToken ↔ 工具执行中
    notifyProgress 3 次 → 客户端 onProgress 收到全部进度；MCPClient 5——onProgress 转发
    progress-notify 模式 / 无回调忽略 / 不带 options 无 _meta / notifyCancelled 发送含 reason +
    不带 reason / close 后静默；MCPHttpClient 3——callTool 透传 progressToken / notifyCancelled 202 /
    close 后静默），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 tsx 子进程闭环——HTTP callTool 带 progressToken 透传成功（version 0.6.16）、
    notifyCancelled 202 ok；stdio 真实 MCPServer 子进程 progress_work → onProgress 收到 3 条进度
    （token 回传 smoke-1、progress 1→2→3、message 完整），SMOKE PASS
- **下一步候选**：① agent.ts trimContext 自动裁剪（风险高仍暂缓）；② 其他安全的外围增强
  （MCP 协议特性已基本覆盖——tools/resources/prompts/completion/roots/logging/sampling/subscribe/
  progress/cancelled；可考虑 server 协议其他管理接口、CLI 交互增强、MCP 工具集完善等）

---

### 2026-08-10 第十七轮实施（v0.6.15）——MCP resources 订阅闭环

- **P32 MCP resources 订阅协议**（src/mcp/server.ts + client.ts + http-client.ts）：
  - **协议语义**：客户端**订阅**资源后，服务器资源变化时推送更新通知（如记忆被修改、状态快照刷新）——
    客户端无需轮询 resources/read；resources 闭环的最后一块（v0.6.1 暴露 + v0.6.6 消费 + 本轮订阅）
  - **服务器侧**：`MCPServer` dispatch 新增 `resources/subscribe` / `resources/unsubscribe`（未知/缺 uri →
    -32602；重复订阅幂等、未订阅退订幂等；内部 Set 记录订阅）+ `notifyResourceUpdated(uri)` 推送
    `notifications/resources/updated`（**仅向已订阅该 uri 的客户端推送**；未订阅/未知资源/已关闭/写失败 →
    静默不抛错）；capabilities.resources 升级声明 `{ subscribe: true }`（此前 `{}`，客户端可探测订阅能力）
  - **客户端侧**：`MCPClient` 新增 `subscribeResource(uri)` / `unsubscribeResource(uri)`（未知 uri 协议错误
    reject，与 readResource 一致）+ `onResourceUpdated` 回调选项（收到 `notifications/resources/updated`
    自动转发 uri；未配置忽略不干扰后续请求）；handleNotification 通知分流扩展（message 日志 /
    resources/updated 更新互不干扰）
  - **传输差异（文档记录）**：HTTP transport（startMcpHttpServer）共用 handleMessage 核心，
    subscribe/unsubscribe 一请求一响应正常；但无 SSE 长连接，服务器 `notifyResourceUpdated` 推送客户端收不到
    （与 roots/logging 推送差异一致）；MCPHttpClient 同样可订阅但无更新回调，文档如实记录不假装支持
  - **安全**：通知只推给已订阅客户端（服务器侧过滤），无订阅零流量；静默失败不抛错（与 sendLog 同风格）
  - docs/mcp.md 资源订阅章节 + README Changelog + 版本号 0.6.15
  - **454/454 全绿**（439 + 15 新增：MCPServer 9——subscribe 成功+subscribedResources 记录 / 未知 uri -32602 /
    缺 uri+重复订阅幂等 / unsubscribe 成功+未订阅幂等 / unsubscribe 未知 -32602 / notify 已订阅推送含无 id /
    未订阅+未知不推送 / 已关闭静默 + **订阅真实互通 e2e**——真实 MCPServer 子进程 subscribe → bump 工具触发
    notifyResourceUpdated → 客户端 onResourceUpdated 收到 uri、unsubscribe 后不再收到；MCPClient 5——
    subscribe/unsubscribe 请求成功 / 未知 uri reject / onResourceUpdated 转发 res-update 模式 / 无回调忽略不
    干扰后续请求 / close 后 reject；MCPHttpClient 1——HTTP subscribe/unsubscribe + 服务器记录 + 传输差异不抛错），
    tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 tsx 子进程闭环——capabilities.resources `{"subscribe":true}`、未订阅 bump 无通知、
    订阅后 bump 收到 memory://note、退订后 bump 不再收到、未知 uri 订阅回 Unknown resource，SMOKE PASS
- **下一步候选**：① agent.ts trimContext 自动裁剪（风险高仍暂缓）；② 其他安全的外围增强
  （MCP 更多协议特性如 progress/cancelled 通知、server 协议其他管理接口、CLI 交互增强等）

---

### 2026-08-10 第十六轮实施（v0.6.14）——MCP sampling 协议闭环

- **P31 MCP sampling 协议**（src/mcp/types.ts + client.ts + server.ts）：
  - **协议语义**：sampling 让服务器（自身无模型/不想直接调模型）请求**客户端（宿主应用）代为调用
    LLM** 生成内容——对 AI Agent 引擎是天然场景（flare 服务器经 MCP 复用宿主已配置的模型能力）；
    方向与 roots 一致（服务器→客户端请求），**复用 v0.6.12 建立的主动请求通道**（pending + handleServerRequest）
  - **服务器侧**：`MCPServer.requestSample(request, timeoutMs?)` 发 `sampling/createMessage` 请求——
    参数含 `messages`（必填，至少一条）/ `systemPrompt` / `temperature` / `maxTokens`（必填）/
    `stopSequences` / `modelPreferences`（hints + cost/speed/intelligence 优先级）/ `includeContext` /
    `metadata`；等待客户端响应（带超时，默认 requestTimeoutMs）；客户端回 error / 超时 / 服务器已关闭 →
    reject（不悬挂）；**响应缺 content.text → reject**（采样结果必须有内容才可用，与 roots 容错 [] 不同——
    文档明确记录差异）；请求缺 messages → 立即 reject（不发请求）
  - **客户端侧**：`MCPClient` 新增 `sampling` 回调选项——配置后 `initialize` 声明 `capabilities.sampling`
    （未配置不声明，缺省兼容——服务器不应请求采样）；服务器发 `sampling/createMessage` 请求 → 回调
    自动执行并回传结果（**支持异步回调**）；回调抛错 → 回 `-32603`（客户端不崩）；未配置回调却收到请求 →
    回 `-32601`（协议错误，连接不断）
  - **传输差异（文档记录）**：HTTP transport 一请求一响应、无服务器→客户端通道，不提供 `requestSample`
    （stdio 专属）；MCPHttpClient 无 SSE 长连接也不声明 sampling 能力——与 roots 一致
  - **安全**：sampling 是客户端主动授权能力——只有配置了回调的客户端才会响应，服务器无法强制调用模型
  - `McpSamplingRequest`/`McpSamplingResult`/`McpSamplingMessage`/`McpSamplingContent`/`McpModelPreferences`
    类型库导出；docs/mcp.md sampling 协议章节 + README Changelog + 版本号 0.6.14
  - **439/439 全绿**（426 + 13 新增：MCPServer 7——发起+解析响应含 model/stopReason / 客户端 error reject /
    缺 content reject / 缺 messages 立即 reject / 超时 reject 后服务器仍可用 / 已关闭 reject / sampling 真实
    互通 e2e——真实 MCPServer 子进程 requestSample ↔ MCPClient sampling 回调 + 未配置回调回 -32601 e2e；
    MCPClient 6——配置回调声明能力+协议闭环 / 未配置不声明 / 无回调回 -32601 连接不断 / 回调抛错 -32603 /
    异步回调 / 请求参数完整透传），tsc 0 错误，零 agent.ts 改动
  - **冒烟实测**：真实 stdio 子进程闭环——客户端带 sampling 回调连接真实 MCPServer，requestSample 拿到
    确定性采样文本（含 model 回显 deepseek-chat），SMOKE PASS
- **下一步候选**：① agent.ts trimContext 自动裁剪（风险高仍暂缓）；② 其他安全的外围增强
  （MCP 更多协议特性、server 协议其他管理接口、CLI 交互增强等）

---

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

