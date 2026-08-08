# flare 夜间调研迭代进度

> 目标：调研 flare 引擎下一步迭代方向并推进（M4 已完成 = StorySpire 集成 + withConfirmation + 宿主协议）
> 铁律：**flare 是引擎，Pulse/StorySpire（Electron 版）当前都依赖它**——任何改动必须 tsc 0 错 + 全部测试通过才 commit
> 规则：每轮实现后 `npx tsc` 0 错 + `PATH=/usr/bin:$PATH npx vitest run` 全绿 + git commit（本地，**禁止 git push**）；每轮结束更新本文件

## 迭代方向（第一轮先调研 roadmap 后定，候选）

- [ ] 方向调研：读 ~/Desktop/flare-engine-roadmap.md + 现状（M5 候选：MCP 协议/记忆检索增强/多模型 provider/工具确认完善/性能）
- [ ] 选定方向后的迭代项（第一轮调研后补充）

## 迭代记录

| 轮次 | 时间 | 完成 | 构建/测试 | 备注 |
|------|------|------|-----------|------|
| - | - | 调研待开始 | - | - |

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
