/**
 * ferry 跨平台命令翻译工具（v0.6.153）
 *
 * 为什么放在工具层而不是塞进 system prompt：
 * - 命令是否等价是"事实问题"，不该让模型凭记忆猜；猜错在目标机上就是静默做错事。
 * - 工具返回三态（equivalent / approximate / unsupported），agent 能据此决定执行、先确认、还是换方案。
 *
 * 引擎与 127 条命令的映射数据已编译进 flare（src/tools/ferry-core/），
 * 所以「装了 flare 就有 ferry」——不依赖本机装 Python、也不依赖 PATH 里有 ferry。
 * 数据快照来自 ferry 项目 data/*.jsonc，用 scripts/sync-ferry-data.mjs 更新。
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Tool, ToolExecutor } from './index.js'
import { FERRY_DATA_SHA, PLATFORM_LABEL, translateCommand } from './ferry-core/engine.js'
import type { Platform } from './ferry-core/types.js'

const STATUS_LABEL: Record<string, string> = {
  equivalent: '等价，可直接执行',
  approximate: '近似等价，执行前核对 caveats',
  unsupported: '无等价命令，不要执行',
}

/** 读 ~/.ferry/hosts.json：host 别名 → 平台（与 ferry CLI 共用同一份配置，装了就一致） */
function hostPlatform(host: string): { platform?: Platform; user?: string } | null {
  const path = process.env.FERRY_HOSTS || join(homedir(), '.ferry/hosts.json')
  try {
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

export const ferryTranslateTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'translate_command',
      description:
        '把一条 shell 命令翻译到另一个操作系统，并给出等价等级。' +
        '在给 macOS/FreeBSD/Windows 写命令、或要通过 ssh 在另一台机器上执行命令之前调用它——' +
        '跨平台差异常常不在命令名而在参数（BSD 与 GNU 的 sed/date/stat 不同），凭记忆写会静默出错。' +
        '返回 status：equivalent 可执行 / approximate 需先核对 caveats / unsupported 无等价、换方案。' +
        '引擎与映射数据内置于 flare，离线可用，不需要外部安装。' +
        '带 host 参数时会顺带给出可直接粘贴的 ssh 命令（平台从 ~/.ferry/hosts.json 读取）。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要翻译的命令，可包含管道和 &&' },
          target: { type: 'string', enum: ['linux', 'macos', 'freebsd', 'windows'], description: '目标操作系统' },
          shell: {
            type: 'string',
            enum: ['bash', 'zsh', 'sh', 'powershell', 'cmd'],
            description: '目标 shell；Windows 默认 powershell，确实要 cmd.exe 才指定 cmd，FreeBSD 默认 sh',
          },
          source: {
            type: 'string',
            enum: ['linux', 'macos', 'freebsd', 'windows'],
            description: '源平台，默认按当前系统和命令名推断',
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
  execute: (async (args: {
    command: string; target?: Platform; shell?: string; source?: Platform; host?: string
  }) => {
    const command = String(args.command || '').trim()
    if (!command) return { success: false, output: '', error: '缺少 command' }

    // host 给了但没给 target 时，用 hosts 配置补平台
    let target = args.target
    let user: string | undefined
    if (args.host) {
      const info = hostPlatform(args.host)
      if (info?.user) user = info.user
      if (!target && info?.platform) target = info.platform
    }
    if (!target) {
      return {
        success: false, output: '',
        error: `不知道 ${args.host} 是什么系统：让用户补 target，或先登记 ferry hosts add ${args.host} <linux|macos|freebsd|windows>`,
      }
    }

    let parsed
    try {
      parsed = translateCommand({ command, target, source: args.source, shell: args.shell })
    } catch (e: unknown) {
      return { success: false, output: '', error: `翻译失败：${(e as Error).message}` }
    }

    const lines: string[] = []
    lines.push(`【${STATUS_LABEL[parsed.status] ?? parsed.status}】目标 ${PLATFORM_LABEL[parsed.target]} / ${parsed.shell}`)
    if (parsed.command) lines.push(`命令：${parsed.command}`)
    if (parsed.caveats.length) {
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

/** 内嵌数据的指纹，排障时能确认跑的是哪一版映射 */
export const FERRY_EMBEDDED_DATA = FERRY_DATA_SHA
