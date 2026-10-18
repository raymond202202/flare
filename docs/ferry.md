# ferry 集成：跨平台命令翻译（引擎内嵌）

> v0.6.153 · 工具名 `translate_command` · **引擎与 127 条命令的映射数据编译进 flare**，不依赖任何外部安装

## 为什么需要它

flare 常在 Linux 上开发、却要**通过 ssh 在 macOS / Windows 上执行命令**。模型凭记忆写远端命令有三个真实翻车点：

1. **命令名对、参数错**：Linux→macOS 上 `sed -i 's/a/b/' f` 会报错，必须写成 `sed -i '' 's/a/b/' f`；`date -d`、`stat -c`、`grep -P` 同理。
2. **数据模型错**：Linux 是文本流，PowerShell 是对象流。`ps aux | grep nginx` 直译成 `Get-Process | Select-String nginx` 语法合法、语义全错，正确写法是 `Get-Process -Name nginx`。
3. **静默降级更危险**：`find -delete`、`chmod +x`、`rm -rf` 这类命令若被"翻译"成少了动作的版本，在远端会做错事而不报错。

所以这里不生成"看起来对"的命令，而是返回**等价等级 + 差异说明**，让 agent 自己决定执行、先确认、还是换方案。

## 为什么把引擎内嵌，而不是调用 ferry CLI

原来的实现是 `execFile('ferry', [...])`——要求目标机器装了 ferry（Python）。对"你自己这台开发机"够用，但：

- 把 flare 内嵌进桌面应用（Pulse / StorySpire）后，**终端用户的机器上没有 ferry、也不一定有 Python**；
- 工具表里挂着一个"当前环境不可用"的工具，比没有它更糟——模型会尝试、失败、再绕路。

所以 v0.6.153 把 ferry 的引擎（词法、recipe 匹配、参数映射、路径/变量转换、管道惯用法、三态判定）和映射数据一起编译进 flare：

```
src/tools/ferry-core/
  engine.ts          # 从 ferry.py 移植的确定性引擎（~800 行）
  types.ts           # 数据契约（与 CLI 的 JSON schema=1 对齐）
  data.generated.ts  # 127 命令 / 245 写法 / 21 惯用法 / 24 语法 / 22 坑（由脚本生成）
```

结果：任何引用 flare-agent 的应用（GitHub tarball + `build:flare`，或未来的 npm 包）都自带 ferry 能力；内嵌 flare 的应用 → 自动内嵌 ferry。零子进程、零 Python、离线可用——`ferry-core` 三个 `.js` 文件拷到空目录、`env -i` 下也能跑通。

## 数据从哪来、怎么更新

映射数据的事实源仍是 ferry 项目（`~/.projects/ferry/data/*.jsonc`，同名的独立 CLI 工具）。同步是单向的：

```bash
# 在 flare 仓库里
node scripts/sync-ferry-data.mjs                    # 默认读 ~/.projects/ferry/data
node scripts/sync-ferry-data.mjs /path/to/ferry/data
```

脚本去掉 JSONC 注释与尾逗号，输出 `data.generated.ts`（~108KB），并在文件头记录来源 sha256 指纹——`FERRY_DATA_SHA` 会出现在排障输出里，能确认跑的是哪一版映射。

**为什么提交生成物**：flare 的构建不能依赖本机存在 ferry 项目（别人 clone 要能直接 `npx tsc`）。数据是资产，跟着仓库走；更新时重新生成并提交。

## 一致性怎么保证

移植最大的风险是"看起来一样、边界处不一样"。做法是把 Python 版当参考实现，用同一批输入比对输出：

- `tests/fixtures/ferry-cases.json` — **1262 条用例**（127 条命令 × 三个目标平台 + 全部管道惯用法 + 手挑的边界命令），每条记录 `status` / `command` / `caveats` 的期望值，由 ferry 项目用同一份数据生成。
- `tests/ferry-core.test.ts` — 逐条跑内嵌引擎，**任何一条不一致就失败**。
- `scripts/ferry-parity.mjs` — 开发时快速对照（`npx tsx scripts/ferry-parity.mjs`），移植期间就是靠它把 33 处差异收敛到 0 的。

移植时抓到的三个真实差异（都修了，并在 Python 侧同步修了一处）：

| 现象 | 根因 |
|---|---|
| `sed -i '3d'` 不走 recipe | Python 用 `re.match`（行首锚定），TS 用了 `.test()`（任意位置），`s/old/new` 被误判成 `/new` 开关 |
| Windows 路径多出反斜杠 | Python `re.sub` 的替换串要吃转义，JS 的 `replace` 不吃；且要用函数形式避免 `$&` |
| 管道惯用法带出别的平台的提示 | Python 只过滤了分段 caveat，没过滤惯用法 caveat（本次两边一起修） |

## 工具签名

```jsonc
{
  "name": "translate_command",
  "arguments": {
    "command": "ps aux | grep nginx",   // 必填，可含管道和 &&
    "target": "windows",                // 必填：linux | macos | windows
    "shell": "powershell",              // 可选：默认 Windows 用 powershell，要 cmd.exe 才填 cmd
    "source": "linux",                  // 可选：源平台，默认按当前系统和命令名推断
    "host": "macbook"                   // 可选：ssh 主机别名，会附带可直接执行的 ssh 命令
  }
}
```

| ferry status | ToolResult | 含义 |
|---|---|---|
| `equivalent` | `success: true` | 可直接执行 |
| `approximate` | `success: true` + caveats | 执行前核对差异（路径改写、输出格式、权限模型） |
| `unsupported` | `success: false` + `error` | 目标平台无等价，**不要执行**，换方案 |

`unsupported` 故意用 `success: false`：让模型知道"这条路不通"，而不是拿到一段错误命令继续往下跑。

## 实际调用

```ts
import { executeTool } from './dist/tools/index.js'

const r = await executeTool('translate_command', {
  command: "sed -i 's/a/b/' f.txt",
  target: 'macos',
  host: 'macbook',
})
// success: true
// 【近似等价，执行前核对 caveats】目标 macOS / zsh
// 命令：sed -i '' 's/a/b/' f.txt
// 注意事项：
//   - BSD sed 的 -i 必须带一个备份后缀参数，空串 '' 表示不备份；这是 Linux→macOS 最高频的坑
```

模型拿到这段后，正常走 `terminal` 工具执行——执行仍然受 flare 的危险命令黑名单与确认门管辖，`translate_command` 只翻译、不执行。

## ssh 主机登记

`host` 参数的平台来源是 `~/.ferry/hosts.json`（与 ferry CLI 共用；纯 JSON，也可以手写）：

```bash
ferry hosts add macbook macos --user dev   # 装了 ferry CLI 时
ferry hosts add winbox windows --user dev
```

```jsonc
// 没装 CLI 也可以直接写 ~/.ferry/hosts.json
{ "hosts": { "macbook": { "platform": "macos", "user": "dev" } } }
```

不登记也能用：直接传 `target`，只是拿不到现成的 ssh 命令行。

## 独立性验证（生产包实测）

把 ferry CLI 移走、PATH 清空、`FERRY_BIN` 置空，再调用**安装后**的 `~/.flare/install/dist/tools/index.js`：

```
ferry 可执行文件存在? false
success: true
【近似等价，执行前核对 caveats】目标 macOS / zsh
命令：sed -i '' 's/a/b/' f.txt
注意事项：
  - BSD sed 的 -i 必须带一个备份后缀参数，空串 '' 表示不备份；这是 Linux→macOS 最高频的坑
unsupported success: false | 目标平台无等价命令，不要执行。Windows 无可执行位概念…
```

即：**装 flare 成功就一定有 ferry 能力**，与宿主机装了什么无关。

## 限制

- 映射库是快照。ferry 项目更新数据后，需要在 flare 里跑一次 `sync-ferry-data.mjs` 并提交——不会自动跟随。
- 只覆盖 ferry 映射库里的 127 条命令；未收录的返回 `unsupported`，不会编。
- 不做执行：翻译与执行分离，安全边界清晰。
- 不做 LLM 兜底：CLI 版的 `--llm` 是可选实验特性，内嵌版一律返回 `unsupported`，让 agent 自己换方案。
- Windows 侧的 14 条断言仍待真机（`ferry drills --to windows --emit ps1`）；macOS 侧已在 GitHub Actions 的 macOS runner 上逐条验证。
