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

---

## 记忆生命周期（v0.5.4 闭环）

RAG 里程碑补齐了"检索"；v0.5.4 补上"保存"与"删除"，记忆从只读/只增变为完整生命周期：

### 4. memory_save 工具（AI 保存）

让 AI 在用户**明确要求记住**时真正落库（此前 AI 只能口头答应、无法持久化）：

```ts
import { Agent, createMemorySaveTool, MemoryStore } from 'flare-agent'

const store = new MemoryStore('~/.pulse/pulse-ai.db')
const agent = new Agent({
  tools: [createMemorySaveTool(store)],   // 绑定宿主自己的库
})
```

- 参数：`{ content, type? }`（content 必填，缺失回 error）
- 约束：工具 description 明确"仅当用户明确要求记住时使用，不自作主张保存"——与系统提示一致
- 已加入**内置工具集**（`memorySaveTool`，绑定全局库）
- 与 memory_search 配合即完整闭环：用户说"记住 X" → AI 调 memory_save 落库 → 后续会话 memory_search 命中

### 5. 记忆删除（用户 / 宿主可删）

- `MemoryStore.deleteMemory(id)`：按 id 删单条，返回是否删除（幂等）
- `MemoryStore.deleteMemoriesByContent(keyword)`：按内容 LIKE 匹配批量删，返回条数
- FTS 索引由 memories 的 DELETE 触发器联动清理（删除后 searchMemories 不再命中）
- CLI：`/forget <关键词>` 删除包含该关键词的记忆

### 6. 宿主协议记忆接口（server）

| 请求 | 说明 |
|------|------|
| `remember` | 保存记忆 `{ content, kind? }`（kind 为类型如 preference/note；不能用 `type`——那是请求判别符） |
| `get_memories` | 列出或搜索 `{ query?, limit? }`（有 query → trigram 全文搜索） |
| `delete_memory` | 删除 `{ id }`（单条）或 `{ content }`（按关键词批量），回 `deleted` 条数 |

详见 `docs/host-protocol.md` 第 11-13 节。

## 迁移与兼容

- **老库自动回填**：`MemoryStore` 打开时检测到 memories/messages 有数据但 trigram FTS 表为空
  → 自动 `rebuild` 索引（幂等，无需手动迁移）
- **不破坏现有数据**：新表 `memories_fts` / `messages_fts_trigram` 独立创建；
  老 `messages_fts` 保留（默认 tokenizer，历史兼容）
- **触发器同步**：memories / messages 的 INSERT/DELETE/UPDATE 自动同步 FTS 索引

## 测试

v0.5.1 新增 19 项（`tests/store.test.ts` + `tests/memory-tool.test.ts`）：

- FTS 中文命中（3 字以上）/ bm25 排序 / 2 字 LIKE 回退 / 无结果兜底 / 空查询
- 触发器同步（插入即入索引、删除即出索引）
- 老库回填（先有数据再建 FTS 可检索）
- memory_search 工具：记忆 / 消息 / both / 无结果 / 缺参 / limit / 默认工具 / 内置集

v0.5.4 新增 16 项（记忆生命周期）：

- deleteMemory / deleteMemoriesByContent：删除即出索引、幂等、不影响其他记忆、批量计数
- memory_save 工具：落库 / 缺参 / 空白 / 存后可搜 / 默认工具 / 内置集
- CLI /forget：关键词删除 / 无匹配 / 无参数 / /help 同步
- server 协议（tests/server.test.ts 另有 6 项）：remember / get_memories / delete_memory 数据往返

## 后续候选

- RAG 注入：Agent 构造时按会话主题自动注入相关记忆（当前注入最近 5 条）
- memory_search 结果截断优化（长消息折叠）
- 记忆去重 / 摘要（相似记忆合并）
