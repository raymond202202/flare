# flare 夜间调研迭代进度

> 目标：调研 flare 引擎下一步迭代方向并推进（M4 已完成 = StorySpire 集成 + withConfirmation + 宿主协议）
> 铁律：**flare 是引擎，Pulse/StorySpire（Electron 版）当前都依赖它**——任何改动必须 tsc 0 错 + 全部测试通过才 commit
> 规则：每轮实现后 `npx tsc` 0 错 + `PATH=/usr/bin:$PATH npx vitest run` 全绿 + git commit（本地，**禁止 git push**）；每轮结束更新本文件

## 调研结论（2026-08-09 第一轮）

### 现状盘点（读完 roadmap + README + docs/ + src/ + tests/）

- **M1-M4 已完成**：引擎库化（src/index.ts 导出 Agent/createProvider/Tool/MemoryStore/ExpertProfile）、Expert Profile 机制（工具注入/独立存储/品牌话术）、Pulse 网络专家（networkTools：http_request/url_parse/response_analyze）、StorySpire 写作专家（storyTools 5 个 + 模板）、withConfirmation 确认机制、宿主协议（src/server.ts：stdin/stdout JSON Lines，chat/cancel/set_context/list_sessions/tool_result）
- **测试 60 项全绿**（8 个文件）：agent 4 / confirm 5 / expert 4 / network 5 / server 6 / store 6 / story 11 / vision 19
- **记忆系统现状**：SQLite + FTS5，但存在明显短板：
  1. `getRelevantMemories` 只用 `LIKE '%query%'` 简单匹配，无相关度排序、无 FTS 利用
  2. `messages_fts` 用默认 tokenizer（unicode61）——**实测中文检索效果差**（搜"框架"匹配不到"flutter 是一个神奇的框架"），中文被整段当一个 token 或切分错位
  3. Agent 构造时只注入 `getAllMemories().slice(0,5)`（最近 5 条），不做相关性筛选
  4. 历史消息（messages 表）无关键词检索 API——宿主应用/工具无法按主题找回旧对话
- **技术验证**：better-sqlite3（SQLite 3.53.4）**支持 trigram tokenizer**，中文 3 字以上子串匹配正常（实测 `神奇` 2 字需 LIKE 回退，`神奇的框架` 3 字 FTS 命中）——RAG 增强路径可行

### 方向选择：✅ **记忆检索增强（RAG）**（本轮选定）

| 候选方向 | 评估 | 结论 |
|---------|------|------|
| **记忆检索增强（RAG）** | 记忆是引擎核心能力；中文 FTS 短板实测确认；trigram 路径已验证；对 Pulse（历史调试结论）/StorySpire（按主题找回章节/设定）价值直接；纯外围改动（memory/store.ts + tools/）不碰 Agent.run | ✅ 选定 |
| MCP 协议支持 | 工作量大（网络协议 + 依赖），宿主协议刚完成（server.ts），适合后续大版本规划 | 暂缓 |
| 多模型 provider 增强（本地 Ollama 切换） | 已有 vision provider 走 Ollama；可扩展主模型切换，价值中 | 备选 |
| 工具确认机制完善 | withConfirmation 已完成，剩余空间小 | 备选 |
| server 协议完善 | 基本完整，可加 ping/version 等小项 | 备选 |
| 上下文与性能优化 | trimContext 已有，token 计数可优化，风险中 | 备选 |

### 迭代计划（分小步，每步独立验证 commit）

- [x] **R0** 调研：读 roadmap/README/docs/tests/src + 技术验证（trigram）+ 修复 server 测试超时稳定性（dotenv 重新加载真实 key 走远端 API，放宽 chat 测试超时 45s）
- [x] **R1** MemoryStore 记忆检索升级：新建 `memories_fts`（trigram tokenizer）+ 触发器同步；`getRelevantMemories` 改 FTS 检索 + LIKE 回退（<3 字）+ 相关度排序；导出 `searchMemories`；新增测试
- [x] **R2** 历史消息检索：新建 `messages_fts_trigram`（trigram，不动老表）+ 触发器；新增 `searchMessages(keyword, limit)` API（按主题找回旧对话）；新增测试
- [x] **R3** 记忆检索工具：新增 `memory_search` 工具（AI 主动检索记忆/历史消息，注入 Agent 工具集），工具 schema + 执行器 + 测试
- [x] **R4** 文档与收尾：README Changelog + docs/memory-rag.md + 版本号 0.5.1 + 全量回归
- [x] **R5** server 协议补充 ping：宿主健康检查（进程存活探测，不依赖初始化）+ 测试 + host-protocol.md 文档

> 备选后续方向（记录）：RAG 注入（Agent 构造按主题自动注入相关记忆）/ MCP 协议支持 / 多模型 provider 增强（Ollama 主模型切换）/ server 协议补充（version/delete_session）

## 迭代记录

| 轮次 | 时间 | 完成 | 构建/测试 | 备注 |
|------|------|------|-----------|------|
| R0 | 2026-08-09 凌晨 | 调研确定方向（记忆检索增强 RAG）；修复 server 测试超时稳定性 | tsc 0 错 / 60 全绿 | chat 测试放宽超时 45s（子进程重载 ~/.flare/.env 注入真实 key 走远端 API） |
| R1 | 2026-08-09 凌晨 | memories_fts trigram 全文检索 + searchMemories + 老库回填 | tsc 0 错 / 67 全绿 | +7 测试（FTS/排序/2字回退/触发器/回填） |
| R2 | 2026-08-09 凌晨 | messages_fts_trigram + searchMessages（历史消息按主题找回） | tsc 0 错 / 71 全绿 | +4 测试 |
| R3 | 2026-08-09 凌晨 | memory_search 工具 + createMemorySearchTool（宿主绑定独立库） | tsc 0 错 / 79 全绿 | +8 测试；工具入内置集 |
| R4 | 2026-08-09 凌晨 | README Changelog v0.5.1 + docs/memory-rag.md + 版本号 | tsc 0 错 / 79 全绿 | RAG 四步完成 |
| R5 | 2026-08-09 凌晨 | server 协议补充 ping（宿主健康检查） | tsc 0 错 / 80 全绿 | +1 测试；host-protocol.md 同步 |

## 命令

```bash
cd ~/hermes-projects/flare
npx tsc                    # 必须 0 错误
PATH=/usr/bin:$PATH npx vitest run   # 必须全绿（当前 60 项）
```

## 铁律

- **禁止 git push**（用户明早验收后才决定推 GitHub）
- **禁止修改 Agent.run 核心循环**（大改风险，会破坏 Pulse/StorySpire 依赖）——只做外围增强（server 协议/工具/记忆/配置/测试）
- 不动其他仓库（pulse/storyspire 只读参考）
- 每轮 tsc 0 错 + 测试全绿才 commit；失败修复后继续（最多 3 次，仍失败记录到 progress.md 并停止本轮）
- 不要问问题，自主推进；全部完成后用中文简短汇报
