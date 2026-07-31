# Flare v0.2.0 更新计划（基于 WPS Comate 评估报告）

> 计划日期：2026-07-31
> 依据：Flare-v0.1.0-评估报告.md（32 条问题，审核后 4 条已修复、19 条接受、9 条驳回）
> 原则：每项改动必须有验收标准，改完自己测试再交付

---

## 📦 P0 批：核心健壮性

### P0-1 工具参数 JSON.parse 保护
- **文件**：`src/core/agent.ts`
- **目标**：LLM 返回格式异常时给 LLM 反馈错误，而不是崩溃整个循环
- **改动**：`JSON.parse(tc.function.arguments)` 包 try-catch，解析失败时把错误作为 tool 结果返回，并跳过该调用
- **验收**：
  - [ ] 构造非法 JSON 参数（如 `{bad json`），Agent 不崩溃
  - [ ] 非法参数时，错误信息进入消息历史而非进程退出

### P0-2 joinPath 修复
- **文件**：`src/tools/index.ts`
- **目标**：路径拼接正确（Windows 反斜杠、`..` 解析）
- **改动**：删除自定义 `joinPath`，改用 `path.join`
- **验收**：
  - [ ] `search_files` 搜索嵌套目录结果正确
  - [ ] 不再有 `//` 重复斜杠路径

### P0-3 FTS 索引同步触发器
- **文件**：`src/memory/store.ts`
- **目标**：messages_fts 虚拟表与 messages 表数据同步
- **改动**：init() 中创建 FTS 后添加 INSERT/DELETE 触发器
- **验收**：
  - [ ] 插入消息后，FTS 表能查到（`SELECT * FROM messages_fts WHERE messages_fts MATCH 'xxx'`）
  - [ ] 删除消息后，FTS 索引同步删除

### P0-4 记忆写入功能
- **文件**：`src/memory/store.ts`、`src/cli/index.ts`、`src/core/agent.ts`
- **目标**：记忆系统可写可读（目前只能读）
- **改动**：
  - CLI 加 `/remember <内容>` 命令
  - Agent 运行中检测用户显式要求记住的内容
- **验收**：
  - [ ] `/remember 用户叫鑫哥` 后，`/memory` 能看到该记忆
  - [ ] 新会话中记忆被注入 system prompt

---

## ⚡ P1 批：安全与体验

### P1-1 危险命令黑名单
- **文件**：`src/tools/index.ts`
- **目标**：拦截毁灭性命令
- **改动**：terminal 工具执行前检查黑名单模式（`rm -rf /`、`rm -rf ~`、fork bomb、`mkfs`、`dd if=` 等），命中则拒绝
- **验收**：
  - [ ] 执行 `rm -rf /` 被拒绝并返回错误提示
  - [ ] 正常命令（`ls`、`npm run build`）不受影响

### P1-2 文件路径校验
- **文件**：`src/tools/index.ts`
- **目标**：防止写入系统关键文件
- **改动**：write_file 前检查目标路径是否在保护清单（`/etc/`、`/usr/`、`/boot/`、`/var/`、`.git/`、`.ssh/`、`/proc/`、`/sys/`），命中则拒绝
- **验收**：
  - [ ] 写入 `/etc/passwd` 被拒绝
  - [ ] 写入项目目录正常
  - [ ] 用户主目录下正常

### P1-3 API 调用重试
- **文件**：`src/core/llm.ts`
- **目标**：网络抖动自动重试
- **改动**：chat() 包 3 次重试（指数退避 1s/2s/4s），仅对 429/5xx/网络错误重试
- **验收**：
  - [ ] 模拟一次失败后成功，最终返回正常
  - [ ] 连续失败 3 次后抛出错误

### P1-4 token 用量追踪
- **文件**：`src/core/llm.ts`、`src/memory/store.ts`、`src/cli/index.ts`
- **目标**：记录每次对话的 token 消耗（用户要分账）
- **改动**：
  - llm.ts 返回 usage 时记录到 store
  - 新表 `usage_log`（session_id, prompt_tokens, completion_tokens, model, created_at）
  - CLI 加 `/usage` 命令显示累计用量
- **验收**：
  - [ ] 一次对话后 usage_log 有记录
  - [ ] `/usage` 显示累计 token 数

### P1-5 平台兼容 + 终端恢复
- **文件**：`src/cli/index.ts`
- **目标**：Windows 不崩；任何情况恢复终端
- **改动**：stty 调用前检查 `process.platform !== 'win32'`；Agent 运行块用 try/finally 保证恢复
- **验收**：
  - [ ] Linux 下正常（stty 生效）
  - [ ] 代码在 win32 下跳过 stty（静态检查）
  - [ ] Agent 抛异常后终端回显仍正常

### P1-6 searchFiles 内存优化
- **文件**：`src/tools/index.ts`
- **目标**：大文件不 OOM
- **改动**：读取前 stat 检查，>500KB 文件跳过内容搜索（仅文件名匹配）
- **验收**：
  - [ ] 搜索含大文件目录不崩溃
  - [ ] 小文件内容搜索仍正常

---

## 🛠️ P2 批：工程质量

### P2-1 核心单元测试
- **文件**：`tests/agent.test.ts`、`tests/store.test.ts`
- **目标**：核心逻辑有测试覆盖
- **改动**：用 vitest 写 agent loop（mock LLM）、memory store CRUD 测试
- **验收**：
  - [ ] `npm test` 全部通过
  - [ ] 至少覆盖：store CRUD、tool_calls 配对清理、配置加载

### P2-2 DEBUG 日志
- **文件**：`src/core/logger.ts`（新建）
- **目标**：调试可观测
- **改动**：轻量 logger（DEBUG 环境变量控制），agent loop 关键步骤打日志
- **验收**：
  - [ ] `DEBUG=1 flare chat -q "hi"` 输出日志
  - [ ] 默认运行无日志噪音

### P2-3 tsconfig nodenext
- **文件**：`tsconfig.json`
- **目标**：模块解析符合 Node CLI 规范
- **改动**：`moduleResolution: "nodenext"`，`module: "nodenext"`
- **验收**：
  - [ ] `npm run build` 通过
  - [ ] `flare chat -q "hi"` 正常运行

### P2-4 CLI --max-iterations 参数
- **文件**：`src/cli/index.ts`
- **目标**：迭代上限可配置
- **改动**：chat 命令加 `--max-iterations <n>`，传给 AgentConfig
- **验收**：
  - [ ] `flare chat -q "x" --max-iterations 3` 生效（3 次后停止）

### P2-5 记忆查询优化 + .gitignore 跳过
- **文件**：`src/memory/store.ts`、`src/tools/index.ts`
- **目标**：查询高效、搜索不扫大目录
- **改动**：getRelevantMemories 用 LIMIT；searchFiles 跳过 node_modules/.git/dist/大目录
- **验收**：
  - [ ] 记忆查询返回正确且限量
  - [ ] search_files 不进入 node_modules

### P2-6 写文件原子化
- **文件**：`src/tools/index.ts`
- **目标**：写入不损坏现有文件
- **改动**：writeFileSync 改为写 `path.tmp` + rename
- **验收**：
  - [ ] 写入成功且无 .tmp 残留
  - [ ] 目标文件内容正确

### P2-7 claude 模型检测
- **文件**：`src/core/llm.ts`
- **目标**：claude 模型不被误判为 OpenAI
- **改动**：模型名含 claude 时提示需要 Anthropic 配置（或走 baseURL）
- **验收**：
  - [ ] DEFAULT_MODEL=claude-sonnet-4 时给出明确提示而非静默用 OpenAI URL

---

## 执行顺序与验证

1. P0 → P1 → P2 顺序执行
2. 每批完成后：`npm run build` + 回归测试
3. 全部完成后：`npm test` + 手动冒烟（flare chat -q）
4. 更新 README Changelog + 版本号 0.2.0
5. 安全审计（API key 不泄露）后交付
