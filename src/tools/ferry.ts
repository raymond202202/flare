/**
 * ferry 跨平台命令翻译工具（v0.6.152）
 *
 * 为什么放在工具层而不是塞进 system prompt：
 * - 命令是否等价是"事实问题"，不该让模型凭记忆猜；猜错在目标机上就是静默做错事。
 * - 工具返回三态（equivalent / approximate / unsupported），agent 能据此决定执行、先确认、还是换方案。
 *
 * 依赖：本机装了 ferry（~/.local/bin/ferry 或 PATH），零运行时依赖。
 */

import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Tool, ToolExecutor } from './index.js'

type Platform = 'linux' | 'macos' | 'windows'

interface FerryJson {
  status: 'equivalent' | 'approximate' | 'unsupported'
  command: string | null
  caveats: string[]
  target: Platform
  shell: string
  segments?: Array<{ kind: string; status: string }>
  inferred?: boolean
}

const STATUS_LABEL: Record<string, string> = {
  equivalent: '等价，可直接执行',
  approximate: '近似等价，执行前核对 caveats',
  unsupported: '无等价命令，不要执行',
}

const PLATFORM_LABEL: Record<Platform, string> = {
  linux: 'Linux',
  macos: 'macOS',
  windows: 'Windows',
}

/** 找 ferry 可执行文件：FERRY_BIN → ~/.local/bin → ~/.ferry/install → PATH */
function resolveFerry(): { cmd: string; prefix: string[] } {
  const env = process.env.FERRY_BIN
  if (env && existsSync(env)) return { cmd: env, prefix: [] }

  const link = join(homedir(), '.local/bin/ferry')
  if (existsSync(link)) return { cmd: link, prefix: [] }

  const py = join(homedir(), '.ferry/install/ferry.py')
  if (existsSync(py)) return { cmd: 'python3', prefix: [py] }

  return { cmd: 'ferry', prefix: [] }
}

/** 读 ~/.ferry/hosts.json：host 别名 → 平台（ferry ssh 与这里共用同一份配置） */
function hostPlatform(host: string): { platform?: Platform; user?: string } | null {
  const path = process.env.FERRY_HOSTS || join(homedir(), '.ferry/hosts.json')
  try {
    if (!existsSync(path)) return null
    const cfg = JSON.parse(readFileSync(path, 'utf-8'))
    const info = cfg?.hosts?.[host]
    if (!info) return null
    return { platform: info.platform, user: info.user }
  } catch {
    return null
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function runFerry(args: string[], timeoutMs = 15000): Promise<{ stdout: string; code: number }> {
  const { cmd, prefix } = resolveFerry()
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      [...prefix, ...args],
      { timeout: timeoutMs, maxBuffer: 1 << 20, encoding: 'utf-8' },
      (err, stdout) => {
        // ferry 用退出码表达状态：0 等价 / 2 近似 / 3 无等价 / 4 用法错误。
        // 2 和 3 带 err（非零退出），是正常结果而不是失败。
        const code = typeof (err as { code?: number })?.code === 'number'
          ? (err as unknown as { code: number }).code
          : err ? 4 : 0
        if (code === 4) {
          const msg = (err as Error)?.message || ''
          return reject(new Error(msg.includes('ENOENT')
            ? '找不到 ferry：请先安装（~/.projects/ferry/install.sh）或设置 FERRY_BIN'
            : `ferry 调用失败：${msg.slice(0, 300)}`))
        }
        resolve({ stdout, code })
      },
    )
  })
}

export const ferryTranslateTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'translate_command',
      description:
        '把一条 shell 命令翻译到另一个操作系统，并给出等价等级。' +
        '在给 macOS/Windows 写命令、或要通过 ssh 在另一台机器上执行命令之前调用它——' +
        '跨平台差异常常不在命令名而在参数（BSD 与 GNU 的 sed/date/stat 不同），凭记忆写会静默出错。' +
        '返回 status：equivalent 可执行 / approximate 需先核对 caveats / unsupported 无等价、换方案。' +
        '带 host 参数时会顺带给出可直接粘贴的 ssh 命令（平台从 ~/.ferry/hosts.json 读取）。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要翻译的命令，可包含管道和 &&' },
          target: { type: 'string', enum: ['linux', 'macos', 'windows'], description: '目标操作系统' },
          shell: {
            type: 'string',
            enum: ['bash', 'zsh', 'powershell', 'cmd'],
            description: '目标 shell；Windows 默认 powershell，确实要 cmd.exe 才指定 cmd',
          },
          host: {
            type: 'string',
            description: '可选的 ssh 主机别名（需在 ferry hosts 里登记过）。给了就返回可直接使用的 ssh 命令',
          },
        },
        required: ['command', 'target'],
      },
    },
  },
  execute: (async (args: { command: string; target: Platform; shell?: string; host?: string }) => {
    const command = String(args.command || '').trim()
    if (!command) return { success: false, output: '', error: '缺少 command' }

    // host 给了但没给 target 时，用 hosts 配置补平台
    let target = args.target as Platform | undefined
    let user: string | undefined
    if (args.host) {
      const info = hostPlatform(args.host)
      if (info?.user) user = info.user
      if (!target && info?.platform) target = info.platform
    }
    if (!target) {
      return {
        success: false, output: '',
        error: `不知道 ${args.host} 是什么系统：让用户补 --target，或先登记 ferry hosts add ${args.host} macos`,
      }
    }

    const cli = ['translate', command, '--to', target, '--json']
    if (args.shell) cli.push('--shell', args.shell)

    let parsed: FerryJson
    try {
      const { stdout } = await runFerry(cli)
      const start = stdout.indexOf('{')
      if (start < 0) throw new Error('输出不是 JSON')
      parsed = JSON.parse(stdout.slice(start)) as FerryJson
    } catch (e: unknown) {
      return { success: false, output: '', error: (e as Error).message }
    }

    const lines: string[] = []
    lines.push(`【${STATUS_LABEL[parsed.status] ?? parsed.status}】目标 ${PLATFORM_LABEL[parsed.target]} / ${parsed.shell}`)
    if (parsed.command) lines.push(`命令：${parsed.command}`)
    if (parsed.caveats?.length) {
      lines.push('注意事项：')
      for (const c of parsed.caveats) lines.push(`  - ${c}`)
    }

    if (args.host && parsed.command) {
      const remoteUser = user && user !== args.host ? `${user}@${args.host}` : args.host
      if (parsed.target === 'windows') {
        lines.push(`远端执行（Windows，注意先确认平台是 PowerShell）：ssh ${remoteUser} ${shellQuote(parsed.command)}`)
      } else {
        lines.push(`远端执行：ssh ${remoteUser} ${shellQuote(parsed.command)}`)
      }
    }

    if (parsed.status === 'unsupported') {
      // 失败要明确，但不能让模型以为"工具坏了"去重试——告诉它换方案
      return {
        success: false,
        output: lines.join('\n'),
        error: `目标平台无等价命令，不要执行。${parsed.caveats[0] ?? ''}`,
      }
    }

    if (parsed.status === 'approximate') {
      lines.push('（近似等价：执行前把上面的注意事项考虑进去，或先向用户说明差异）')
    }
    return { success: true, output: lines.join('\n') }
  }) as ToolExecutor,
}
