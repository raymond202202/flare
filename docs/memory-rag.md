# Flare 记忆检索增强（RAG，v0.5.1）

> flare 引擎的记忆系统升级：中文全文检索 + 历史消息按主题找回。
> 不修改 Agent.run 核心循环——纯外围增强（MemoryStore + 工具），Pulse/StorySpire 可直接受益。

---

## 为什么做

原记忆检索存在明显短板：

1. `getRelevantMemories` 只用 `LIKE '%词%'` 匹配——无相关度排序、无全文索引利用
2. 老 `messages_fts` 用默认 tokenizer（unicode61），**中文检索效果差**：
   整段 CJK 被当一个 token，搜"框架"匹配不到"flutter 是一个神奇的框架"
3. 历史消息（messages 表）无按主题检索 API——旧对话"找不回来"

实测验证：better-sqlite3（SQLite 3.53.4）支持 **trigram tokenizer**，
中文 3 字以上子串匹配正常；2 字查询用 LIKE 回退。

## 新增能力

### 1. MemoryStore.searchMemories(query, limit)

持久记忆全文检索，返回 `MemoryRow[]`（含 content/type/created_at）。

- 查询 ≥3 个字符：`memories_fts`（trigram）FTS 精确子串匹配 + **bm25 相关度排序**
- 查询 <3 个字符（如 2 字中文）：LIKE 回退
- FTS 异常 / 无结果：LIKE 兜底（不静默失败）

```ts
const store = new MemoryStore('~/.pulse/pulse-ai.db')
const hits = store.searchMemories('网络请求超时', 5)
```

`getRelevantMemories` 已同步升级为 `searchMemories`（签名兼容，无需改调用方）。

### 2. MemoryStore.searchMessages(keyword, limit)

历史消息全文检索，返回 `{ sessionId, role, content, createdAt }[]`。
用于"找回旧对话"——宿主导航、Agent 按主题回忆。

- 索引：`messages_fts_trigram`（trigram，**不动老表 messages_fts**，无迁移风险）
- 排序：bm25 相关度 + 时间倒序

```ts
const msgs = store.searchMessages('龙族设定', 10)  // 按主题找回 StorySpire 旧章节讨论
```

### 3. memory_search 工具（AI 主动检索）

让 AI 在对话中主动检索记忆和历史消息：

```ts
import { Agent, createMemorySearchTool, MemoryStore } from 'flare-agent'

const store = new MemoryStore('~/.pulse/pulse-ai.db')
const agent = new Agent({
  tools: [createMemorySearchTool(store)],   // 绑定宿主自己的库
  sessionId: 'pulse-ai',
})
```

- 参数：`{ query, scope?: 'memories' | 'messages' | 'both', limit? }`（scope 默认 both）
- 已加入**内置工具集**：CLI / 不传 tools 的 Agent 默认可用（绑定全局库 `~/.flare/flare.db`）
- 宿主可用 `createMemorySearchTool(store)` 绑定独立库，检索范围隔离

## 迁移与兼容

- **老库自动回填**：`MemoryStore` 打开时检测到 memories/messages 有数据但 trigram FTS 表为空
  → 自动 `rebuild` 索引（幂等，无需手动迁移）
- **不破坏现有数据**：新表 `memories_fts` / `messages_fts_trigram` 独立创建；
  老 `messages_fts` 保留（默认 tokenizer，历史兼容）
- **触发器同步**：memories / messages 的 INSERT/DELETE/UPDATE 自动同步 FTS 索引

## 测试

新增 19 项（`tests/store.test.ts` + `tests/memory-tool.test.ts`）：

- FTS 中文命中（3 字以上）/ bm25 排序 / 2 字 LIKE 回退 / 无结果兜底 / 空查询
- 触发器同步（插入即入索引、删除即出索引）
- 老库回填（先有数据再建 FTS 可检索）
- memory_search 工具：记忆 / 消息 / both / 无结果 / 缺参 / limit / 默认工具 / 内置集

## 后续候选

- RAG 注入：Agent 构造时按会话主题自动注入相关记忆（当前注入最近 5 条）
- memory_search 结果截断优化（长消息折叠）
- 记忆去重 / 摘要（相似记忆合并）
