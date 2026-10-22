# FLARE 问题记录修复说明 v0.6.155

对应文档：`~/Projects/downloader-research/FLARE问题记录.md`（含追加部分 #13–#17）
基线版本：v0.6.154（见 `FLARE问题记录-修复说明-v0.6.154.md`）
本轮版本：v0.6.155，已装到 `~/.flare/install`（`flare version` → v0.6.155）

---

## 一、#13 迭代上限把长任务判死

**问题**：撞到迭代上限就回一句「请简化你的请求」，前面做的工作在上下文里但用户拿不到交接信息，等于任务作废；而且 50/200 两级上限对真实修 bug 的任务偏小（一次 build + 一轮测试 + 修 3 处就到顶）。

**修复**：

1. `HARD_MAX_ITERATIONS` 200 → 500（`src/core/agent.ts`）。
2. 撞上限时不再只说「简化请求」，改为输出结构化收尾报告 `formatBudgetReport()`：
   - 本轮执行摘要：N 次工具调用，按工具聚合（`terminal ×3`、`gh ×1`），失败项单独标注
   - 失败原因：从工具返回里截取前 120 字符
   - 未完成线索：模型最后一段文字输出（它自己知道卡在哪）
   - 明确给出续跑命令 `flare chat --continue`
3. 新增 `flare chat -c/--continue`（`src/cli/index.ts`）：
   - 默认接着**最近一个未归档会话**，也可配 `-s <id>` 指定
   - 注入固定提示语：从断点接着做，已完成的部分不要重做或重复验证；全完成就汇报结果、遗留项与阻塞原因
   - 本质区别在于历史工具结果仍在上下文里，模型不必重跑已完成步骤
   - 常配 `-m <n>` 给本轮更高预算
4. `-m` 帮助文案同步：默认 50 / 硬上限 500，并说明撞上限后的续跑方式。

验证：`flare chat -q "只回复两个字：收到"` 建会话 → `flare chat --continue` 成功接上该会话并接着输出（隔离 FLARE_HOME 实测）。

---

## 二、#14/#16 pkill -f 自伤预警：误报 + 预警位置不对

**问题**：旧实现按「文本里出现 pkill -f」判定，`echo 'pkill -f x'`、文档正文、heredoc 里提到都会触发；反过来预警文案只写进 `error` 字段，命令失败/超时分支里 `output` 为空，模型主要读 output，预警等于没发。

**修复**（`src/tools/index.ts`）：

1. 判定改到命令位：`parseCommandSegments(args.command)` 里 `seg.name === 'pkill'` 且 `argText` 命中 `-f` 才算，`echo`/heredoc/注释里的字样不再误报。
2. 预警文案同时进 `output`（失败分支、超时分支都补 `body + selfKillWarn`），不再只挂在 `error`。
3. 测试从「断言字符串出现」改为**真实执行**：`pkill -f "[f]lare_selftest_never_match"`（方括号技巧保证不匹配任何真实进程），断言输出含「自伤风险」与「pgrep」；另加 `echo 'pkill -f fluxdl_server.py'` 断言不误报。

---

## 三、#15 放行名单：会话语义不可查、硬拦可被放行

**修复**（`src/tools/risk.ts`）：

1. `listRiskAllowed()` 由 `string[]` 改为 `RiskAllowEntry[]`：`{ rule, scope: 'session' | 'always' | 'both' }`，会话放行与持久放行合并标注，按 rule 排序——用户能看清「这条只对本次会话有效，还是永久放行了」。
2. `allowRiskRule()` 返回 `boolean`，且**硬拦档一律拒绝放行**（`BLOCK_RULES` 命中直接 return false）。理由：`rm -rf /` 这类不可逆操作放行一次就没有回滚机会。
3. `revokeRiskRule()` 返回 `boolean`：会话级从内存删除、持久级置 `'0'`；撤销未放行的规则返回 false，供 CLI 给准确提示。

---

## 四、#16 黑名单误伤与漏拦

| 用例 | 旧行为 | 新行为 |
| --- | --- | --- |
| `:(){ :\|:& };:` | 分段后正则漏判 | fork-bomb 改用**原始输入** `input` 匹配，仍判 block |
| `kill -9 -1` / `killall node` / `pkill -9 fluxdl` | 无规则，静默执行 | 新增 `kill-all-processes`（confirm），reason 说明可能连当前会话一起杀 |
| `kill -9 1234` | 同上 | 仍 safe（单目标按 PID 杀是正常操作） |
| `git push --force` | 硬拦（block） | 降为 confirm |
| `git push --force-with-lease` | 无规则 | confirm（`git-push`），文案建议优先用 lease |
| `gh repo delete` / `gh release delete` | — | confirm |
| `gh repo create` 未指定可见性 | — | confirm，提示默认 `--private` |

**关键设计判断（#16）**：硬拦 `--force` 会把模型推向黑名单外的替代路径（删分支重建、改远端 URL 重推），风险更高且不可见。confirm 保留「人看一眼」的门，又不制造逃逸动机。同理，`pkill -f` 从「一刀拦」改为「拦 + 给出不自伤的替代写法」。

**本轮踩到的工程坑**：分级由**规则所在的数组**决定，不是对象上的 `level` 字段——`classifyCommand` 的两个循环各自硬编码返回的 level。只改 `level: 'block'` → `'confirm'` 无效，必须把规则对象从 `BLOCK_RULES` 移到 `CONFIRM_RULES`。测试 `git push --force` 期望 confirm 却拿到 block 才暴露出来。

---

## 五、#17 gh 假成功

`gh` 把 HTTP 403 写进输出却正常退出，上游只看 exit code 会误判成功。`detectFalseSuccess()` 已在退出码 0 分支生效（`src/tools/index.ts`），本轮补测试：`gh repo create foo` + `HTTP 403: Resource not accessible by integration` + code 0 → 判定失败；正常 PR URL 输出不误报。

---

## 六、测试与验证

- 新增 `tests/flare-issues-14.test.ts`（24 个用例）：三档分级、误伤回归（heredoc/引号/注释/`&&` 后的真实命令仍拦）、放行名单 scope 与撤销、block 不可放行、`formatBudgetReport` 文案（含「不能出现请简化你的请求」反断言）、`actionTarget`、gh 假成功。
- 改写 `tests/flare-issues-13.test.ts` 中 #1/#9 两处旧用例：`--force` 不再真跑 `git push`（旧用例会挂网络导致 5s 超时），改断言分级；pkill 用例改真实执行。
- 全量：`npx vitest run` → 86 文件 / 1330 用例全通过；`tsc --noEmit` 干净。
- 装机：`dist` 同步到 `~/.flare/install`（旧 dist 备份为 `dist.bak.<时间戳>`，只留最近 3 个），`~/.flare/install/bin/flare version` → v0.6.155。

---

## 七、下一轮候选（未做）

1. confirm 档在**非交互**场景（Pulse / StorySpire 嵌入、cron）目前只有 ⚠️ 文字提示，没有真正阻断；需要一个「无人值守策略」开关（例如 fail-closed）。
2. 风险规则支持用户自定义（配置文件追加），目前只能改代码。
3. `ferry drills` 的 mac/win 真机映射仍未自证（无真机在线）。
