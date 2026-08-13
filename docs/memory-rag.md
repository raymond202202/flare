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

### 6. CLI 单次命令记忆管理（v0.6.91 memories / v0.6.100 remember、delete-memory）

宿主/脚本场景（非交互终端）的记忆管理入口——与 server 协议 `get_memories`/`remember`/`delete_memory`
对称的 CLI 单次命令形态，与交互模式 `/memory`（v0.6.25）/`/remember`/`/forget` 共用同一 store：

- **`flare memories [<关键词>]`（v0.6.91，只读）**：查看持久记忆——无关键词列出全部（limit 默认 50）；
  带关键词全文搜索（≥3 字 trigram FTS / 短查询 LIKE 回退）；`--kind <类型>` 按类型过滤（如
  preference）；`--limit 1~100`（非法退出码 1）；`--json` 输出 `{ memories }` 与 server get_memories
  回包同构（v0.6.109，content 不截断不折叠）；空库「暂无记忆」exit 0
- **`flare remember <内容> [--kind <类型>]`（v0.6.100，写操作）**：保存持久记忆——默认类型 note，
  `--kind` 指定（如 preference）；内容为空 exit 1；成功「已记住」exit 0
- **`flare delete-memory <记忆ID>` 或 `--content <关键词>`（v0.6.100，写操作）**：删除持久记忆——
  按 id 删单条（不存在 exit 1，正整数校验）；`--content` 按关键词批量删（幂等 exit 0，与 /forget
  一致）；id 与 --content 同时提供以 id 为准

```bash
flare memories                              # 列出最近 50 条记忆
flare memories 咖啡 --kind preference       # 按类型过滤搜索
flare remember 用户喜欢美式咖啡              # 保存记忆（默认 note）
flare remember "优先 DeepSeek" --kind preference
flare delete-memory 12                      # 按 id 删除
flare delete-memory --content 咖啡           # 按关键词批量删除（幂等）
```

### 7. 宿主协议记忆接口（server）

| 请求 | 说明 |
|------|------|
| `remember` | 保存记忆 `{ content, kind? }`（kind 为类型如 preference/note；不能用 `type`——那是请求判别符） |
| `get_memories` | 列出或搜索 `{ query?, limit? }`（有 query → trigram 全文搜索） |
| `find_similar_memories` | 检测重复/近似记忆 `{ threshold?, limit? }`（v0.6.122，回 `similar_memories` 的 pairs；纯只读） |
| `delete_memory` | 删除 `{ id }`（单条）或 `{ content }`（按关键词批量），回 `deleted` 条数 |

详见 `docs/host-protocol.md` 第 11-14 节。

### 8. 记忆相似度检测（去重检测面，v0.6.121/122）

让宿主/用户发现重复/近似记忆——记忆去重的第一步（**检测面**，只读不删除；自动合并/摘要留后续候选）：

```ts
import { MemoryStore, trigramJaccard } from 'flare-agent'

const store = new MemoryStore('~/.pulse/pulse-ai.db')
const pairs = store.findSimilarMemories({ threshold: 0.4, limit: 20 })
// → [{ idA, idB, contentA, contentB, similarity }]，idA < idB 不重复、相似度降序
```

- **相似度算法**：`trigramJaccard(a, b)`——字符 3-gram 集合 Jaccard 相似度（中文友好：按字符取
  连续 3 字子串集合，去除空白；交集/并集；<3 字短文本退化整段单个 gram；完全相同 = 1、
  无共同 3-gram = 0）
- **默认阈值 0.4**：能检出「一条是另一条超集」的常见重复模式（如「用户偏好浅色主题」vs
  「用户偏好浅色主题，还喜欢极简风」≈0.46），换词区分型（浅色/深色 ≈0.33）不误报；
  `threshold` 0~1 可调
- **CLI**：`flare memories --similar [--threshold <0~1>] [--json]`——文本模式显示
  `#idA ↔ #idB 相似度 X.XX` + 内容截断；`--json` 输出 `{ threshold, pairs }` 供宿主/脚本
  程序化消费；非法阈值 exit 1、无相似/空库 exit 0
- **交互命令**：`/memory similar [阈值]`（v0.6.123 默认阈值 0.4；v0.6.125 起可传 0~1 阈值如
  `/memory similar 0.6`，`/memory --similar [阈值]` 等价）——交互模式检测近似记忆对，显示
  id 对 + 相似度 + 内容截断 + `/forget` 删除提示；阈值非法（非数字/越界 0~1）输出用法提示不崩溃
- **server 协议**：`find_similar_memories` 请求（threshold 0~1 默认 0.4 / limit 1~100 默认 20，
  非法回 error）→ `similar_memories` 响应（pairs 同上）——宿主面板可程序化发现重复记忆后
  自行决定是否 `delete_memory` 清理

```bash
flare memories --similar                        # 默认阈值 0.4 检测近似记忆对
flare memories --similar --threshold 0.9        # 只报高度重复（接近完全相同）
flare memories --similar --json                 # 结构化输出供脚本消费
```

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

v0.6.121/122 新增 18 项（记忆去重检测面，tests/store.test.ts + tests/cli-memories.test.ts +
tests/server.test.ts）：

- trigramJaccard 纯函数 6：完全相同 1 / 完全无关 0 / 近似 0~1 且共享越多越相似 / 空白差异不影响 /
  短文本退化 / 空串边界
- findSimilarMemories 6：近似对检出且 idA<idB 降序 / 完全重复相似度 1 / threshold 过滤 / limit 截断 /
  空库 / 无相似空数组
- CLI `memories --similar` e2e 6：文本对显示 / 无相似 exit 0 / 空库 exit 0 / --json 结构 / --threshold
  调高无结果 / 非法阈值 exit 1
- server 协议 4（server.test.ts）：检出对 / threshold+limit 参数 / 纯只读 / 参数校验 error

## 后续候选

- RAG 注入：Agent 构造时按会话主题自动注入相关记忆（当前注入最近 5 条）
- 记忆自动合并 / 摘要（相似记忆合并）：检测面已完成（v0.6.121/122，见上方第 8 节）；自动合并/
  摘要（写操作 + LLM）留待后续候选
