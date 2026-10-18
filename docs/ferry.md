# ferry 集成：跨平台命令翻译

> v0.6.152 · 工具名 `translate_command` · 依赖本机 ferry（可选，缺失时只有这一个工具报错）

## 为什么需要它

flare 常在 Linux 上开发、却要**通过 ssh 在 macOS / Windows 上执行命令**（两台常用远端机：macOS 与 Windows）。模型凭记忆写远端命令有三个真实翻车点：

1. **命令名对、参数错**：Linux→macOS 上 `sed -i 's/a/b/' f` 会报错，必须写成 `sed -i '' 's/a/b/' f`；`date -d`、`stat -c`、`grep -P`、`sort -V` 同理。
2. **数据模型错**：Linux 是文本流，PowerShell 是对象流。`ps aux | grep nginx` 直译成 `Get-Process | Select-String nginx` 语法合法、语义全错，正确写法是 `Get-Process -Name nginx`。
3. **静默降级更危险**：`find -delete`、`chmod +x`、`rm -rf` 这类命令若被"翻译"成少了动作的版本，在远端会做错事而不报错。

所以这里不生成"看起来对"的命令，而是返回**等价等级 + 差异说明**，让 agent 自己决定执行、先确认、还是换方案。

## 工具签名

```jsonc
{
  "name": "translate_command",
  "arguments": {
    "command": "ps aux | grep nginx",   // 必填，可含管道和 &&
    "target": "windows",                // 必填：linux | macos | windows
    "shell": "powershell",              // 可选：默认 Windows 用 powershell，要 cmd.exe 才填 cmd
    "host": "macbook"                   // 可选：ssh 主机别名，会附带可直接执行的 ssh 命令
  }
}
```

返回的文本给模型读，`success` 给控制流读：

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
// 远端执行：ssh macbook 'sed -i '"'"''"'"' '"'"'s/a/b/'"'"' f.txt'
```

模型拿到这段后，正常走 `terminal` 工具执行——执行仍然受 flare 的危险命令黑名单与确认门管辖，`translate_command` 只翻译、不执行。

## ssh 主机登记

`host` 参数的平台来源与 `ferry ssh` 共用 `~/.ferry/hosts.json`：

```bash
ferry hosts add macbook macos --user dev     # macOS 目标
ferry hosts add t14 windows --user fantastic     # Windows 目标（需 OpenSSH Server）
ferry hosts                                       # 查看
```

不登记也能用：直接传 `target`，只是拿不到现成的 ssh 命令行。

## 实现要点

- **找 ferry**：`FERRY_BIN` → `~/.local/bin/ferry` → `~/.ferry/install/ferry.py`（用 `python3` 跑）→ `PATH`。找不到时给出安装提示，不是静默失败。
- **退出码当契约**：ferry 用 `0/2/3` 表达三种等价等级，`4` 才是真错误；代码区分这两类，避免把"近似"当异常抛出。
- **不缓存**：一次调用约 60ms，缓存反而会拿到过期的映射表。
- **零新依赖**：只用 `child_process` + fs。

## 限制

- ferry 未安装时该工具不可用（其余工具不受影响）。
- ferry 的 macOS / Windows 断言尚未真机验证（`ferry drills --to macos --emit sh` 可在目标机自证），所以 `approximate` 的判断依据是公开文档 + 实测经验，不是自证结果。
- 只覆盖 ferry 映射库里的 127 条命令；未收录的返回 `unsupported`，不会编。
- 不做执行：翻译与执行分离，安全边界清晰。
