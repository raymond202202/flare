/**
 * Flare 工具系统
 * 
 * Agent 可以调用的工具集合。
 * 参考 Hermes 的工具设计，但更轻量。
 */

import { ToolDefinition } from '../core/llm.js'
import { spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { memorySearchTool, memorySaveTool } from './memory.js'
import { ferryTranslateTool } from './ferry.js'
import {
  classifyCommand,
  detectFalseSuccess,
  getRiskConfirmer,
  isRiskRuleAllowed,
  allowRiskRule,
  parseCommandSegments,
} from './risk.js'

/**
 * 执行 shell 命令用的解释器。
 * Linux/macOS 优先 bash；FreeBSD base 没有 bash（只有 /bin/sh，
 * Almquist 派生，无 [[ ]]/数组/花括号扩展），所以按存在性挑。
 * ~ 展开已由调用方手动处理，因此 /bin/sh 也够用。
 */
const RUN_SHELL = ['/bin/bash', '/usr/local/bin/bash', '/bin/zsh', '/bin/sh']
  .find((p) => existsSync(p)) || '/bin/sh'

export interface ToolResult {
  success: boolean
  output: string
  error?: string
  /** 用户拒绝（withConfirmation 机制） */
  denied?: boolean
  /** 用户要求替代方案 */
  alternative?: boolean
  /** 确认超时（confirmer 未在时限内决策，已按安全默认处理） */
  timeout?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolExecutor = (args: Record<string, any>) => ToolResult | Promise<ToolResult>

export interface Tool {
  definition: ToolDefinition
  execute: ToolExecutor
}

/**
 * 展开路径中的 ~ 为 HOME（所有文件工具通用）
 */
function expandHome(p: string): string {
  const home = process.env.HOME || ''
  if (home && p === '~') return home
  if (home && p.startsWith('~/')) return home + p.slice(1)
  return p
}

/**
 * 读取文件工具
 */
export const readFileTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件内容，带行号。用于查看代码、配置文件等',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（绝对或相对路径）' },
          offset: { type: 'number', description: '起始行号（从1开始，默认1）' },
          limit: { type: 'number', description: '最多读取行数（默认500）' },
        },
        required: ['path'],
      },
    },
  },
  execute: ((args: { path: string; offset?: number; limit?: number }) => {
    try {
      const resolvedPath = resolve(expandHome(args.path))
      if (!existsSync(resolvedPath)) {
        return { success: false, output: '', error: `文件不存在: ${resolvedPath}` }
      }
      const content = readFileSync(resolvedPath, 'utf-8')
      const lines = content.split('\n')
      const offset = args.offset || 1
      const limit = args.limit || 500
      const selected = lines.slice(offset - 1, offset - 1 + limit)
      const output = selected.map((line, i) => `${offset + i}|${line}`).join('\n')
      return {
        success: true,
        output: `文件 ${resolvedPath}（共 ${lines.length} 行，显示 ${offset}-${Math.min(offset + limit - 1, lines.length)}）\n${output}`,
      }
    } catch (e: any) {
      return { success: false, output: '', error: `读取失败: ${e.message}` }
    }
  }) as ToolExecutor,
}

/**
 * 受保护路径前缀（write_file 拒绝写入这些位置）
 * 防止 AI 误覆盖系统关键文件
 */
const PROTECTED_PATHS: string[] = [
  '/etc/', '/usr/', '/boot/', '/var/', '/proc/', '/sys/', '/lib/',
  '/bin/', '/sbin/', '/dev/', '/run/', '/opt/', '/root/',
  '/usr/local/',
]

function isProtectedPath(path: string): boolean {
  const resolved = resolve(path)
  for (const prefix of PROTECTED_PATHS) {
    if (resolved.startsWith(prefix)) return true
  }
  // 保护 git 内部文件和 ssh 配置（防止 AI 覆盖 .git/config 或 ssh key）
  const pathParts = resolved.split('/')
  if (pathParts.includes('.git')) return true
  if (pathParts.includes('.ssh') && (pathParts.includes('id_rsa') || pathParts.includes('id_ed25519') || pathParts.includes('config'))) return true
  return false
}

/**
 * 写入文件工具
 */
export const writeFileTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入文件内容（覆盖整个文件）。用于创建新文件或完全重写已有文件',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  execute: ((args: { path: string; content: string }) => {
    try {
      const resolvedPath = resolve(expandHome(args.path))

      // 路径校验：拒绝写入受保护位置
      if (isProtectedPath(resolvedPath)) {
        return { success: false, output: '', error: `拒绝写入受保护路径: ${resolvedPath}。Flare 不会修改系统关键文件。` }
      }

      // 父目录不存在时自动创建（否则模型在新建项目里写 src/xxx.ts 会撞 ENOENT）
      try { mkdirSync(dirname(resolvedPath), { recursive: true }) } catch { /* 已存在 */ }

      // 原子写入：先写临时文件再 rename，避免中途崩溃损坏原文件
      const tmpPath = `${resolvedPath}.tmp-${process.pid}`
      try {
        writeFileSync(tmpPath, args.content, 'utf-8')
        renameSync(tmpPath, resolvedPath)
      } catch (e) {
        try { unlinkSync(tmpPath) } catch { /* 临时文件可能没建起来 */ }
        throw e
      }
      return { success: true, output: `已写入 ${resolvedPath}` }
    } catch (e: any) {
      return { success: false, output: '', error: `写入失败: ${e.message}` }
    }
  }) as ToolExecutor,
}

/**
 * 搜索文件工具
 */
export const searchFilesTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'search_files',
      description: '搜索文件内容或按文件名查找文件。支持正则表达式搜索',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '搜索模式（正则表达式或文件名通配符）' },
          path: { type: 'string', description: '搜索目录（默认当前目录）' },
          maxResults: { type: 'number', description: '最大结果数（默认20）' },
        },
        required: ['pattern'],
      },
    },
  },
  execute: ((args: { pattern: string; path?: string; maxResults?: number }) => {
    try {
      const searchPath = resolve(expandHome(args.path || '.'))
      const results: string[] = []
      const maxResults = args.maxResults || 20

      const walkDir = (dir: string) => {
        if (results.length >= maxResults) return
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch {
          return
        }
        for (const entry of entries) {
          if (results.length >= maxResults) return
          // 跳过隐藏目录、node_modules、.git、dist 等大目录
          if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'coverage' || entry === '.cache') continue
          // 跳过其他 AI 工具的内部目录（这些不是 Flare 的资产，不该被搜索/读取）
          if (entry === '.hermes' || entry === '.agents' || entry === '.codebuddy' || entry === '.claude' || entry === '.cursor' || entry === '.gemini' || entry === '.mimocode' || entry === '.windsurf' || entry === '.continue') continue
          if (entry.startsWith('.') && entry !== '.' && entry !== '..') continue
          const fullPath = join(dir, entry)
          try {
            const stat = statSync(fullPath)
            if (stat.isDirectory()) {
              walkDir(fullPath)
            } else if (stat.isFile()) {
              // 大文件（>500KB）只做文件名匹配，不做内容搜索（防 OOM）
              const nameMatches = fullPath.includes(args.pattern)
              if (stat.size <= 500 * 1024) {
                const content = readFileSync(fullPath, 'utf-8')
                if (content.includes(args.pattern) || nameMatches) {
                  results.push(fullPath.replace(searchPath, '.'))
                }
              } else if (nameMatches) {
                results.push(`${fullPath.replace(searchPath, '.')} (大文件，仅文件名匹配)`)
              }
            }
          } catch { /* skip unreadable */ }
        }
      }

      walkDir(searchPath)
      return {
        success: true,
        output: results.length > 0
          ? `找到 ${results.length} 个匹配：\n${results.join('\n')}`
          : '未找到匹配',
      }
    } catch (e: any) {
      return { success: false, output: '', error: `搜索失败: ${e.message}` }
    }
  }) as ToolExecutor,
}

function joinPath(...parts: string[]): string {
  return join(...parts)
}

/**
 * 危险命令判定（v0.6.155 起委托给 risk.ts 的命令分段引擎）
 *
 * 旧实现是「对整条命令行做正则匹配」，两类缺陷都出在这里：
 *   - 误伤：命令行里出现 `wget` 一词（哪怕在 echo/grep/for 列表里）就拦
 *   - 漏拦：heredoc 里写文档提到危险词 → 反而被当成命令拦下（#16 补充）
 *   - 漏拦：gh repo delete / rm -rf 非 tmp 等真不可逆操作却没有规则
 * 现在先做 shell 分词（丢 heredoc 正文、识别引号/注释/重定向），只在「命令位」判定。
 */
function isDangerousCommand(command: string): string | null {
  const v = classifyCommand(command)
  return v.level === 'block' ? `${v.rule}（${v.reason}）` : null
}

/* ══════════════════ 终端执行引擎（v0.6.154 重写） ══════════════════
 * 换掉 execSync 的四个硬伤：
 *   1. 同步阻塞事件循环；超时抛错时 e.stdout 为 null —— 超时前已产生的输出全部丢失
 *   2. 固定 SIGTERM 且无宽限期，程序来不及保存现场/清理临时文件
 *   3. 完全无法后台化，`nohup x &` 仍被同步等待，长任务必然超时
 *   4. 靠管道 EOF 判结束，孙进程持有 stdout 时误判超时/误报失败
 * 改为 spawn + 流式收集 + SIGINT→SIGKILL 双段超时 + exit 兜底 + background 模式。
 */

/** 单流累积上限（字符）：超限后丢头部保尾部，防内存爆 */
const MAX_CAPTURE_CHARS = 1024 * 1024
/** 输出超过此长度即落盘留档，上下文只放尾部（不丢数据，也不撑爆上下文） */
const SPILL_THRESHOLD = 4000
/** 落盘保留份数（超出按时间删旧） */
const SPILL_KEEP = 20

/** ANSI 控制序列（颜色/光标/清屏）——AI 读日志不需要这些 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

/**
 * 折叠回车覆盖（进度条刷屏）。
 * 终端里 `10%\r20%\r30%` 只显示 `30%`；纯文本搬运会把所有中间态都留下，
 * 几万字符的进度条会把真正的结果挤出上下文。
 */
function collapseCarriageReturns(input: string): string {
  if (!input.includes('\r')) return input
  return input
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line
      const segments = line.split('\r')
      for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i] !== '') return segments[i]
      }
      return ''
    })
    .join('\n')
}

/** 输出清洗：剥 ANSI 控制码 → 折叠 \r 覆盖 */
function cleanOutput(raw: string): string {
  return collapseCarriageReturns(raw.replace(ANSI_RE, ''))
}

/** 累积输出：超上限后丢头部保尾部（最新输出比开头更有价值） */
function appendCapped(buf: string, chunk: string, cap: number): string {
  if (!chunk) return buf
  const next = buf + chunk
  return next.length <= cap ? next : next.slice(next.length - cap)
}

interface RunResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  /** 我们主动触发的超时 */
  timedOut: boolean
  /** SIGINT 无效，已被 SIGKILL 强杀 */
  forceKilled: boolean
  /** 主进程已退出但管道仍被孙进程占用（靠兜底收尾） */
  pipeHeldOpen: boolean
}

/** 前台执行：spawn + 流式收集 + 双段超时 + exit 兜底 */
function runForeground(cmd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(RUN_SHELL, ['-c', cmd], {
      // stdin 置 ignore：避免 `cat`/交互式命令无限等待输入
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let forceKilled = false
    let pipeHeldOpen = false
    let settled = false
    let killTimer: NodeJS.Timeout | null = null
    let graceTimer: NodeJS.Timeout | null = null
    let flushTimer: NodeJS.Timeout | null = null

    const finish = () => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      if (graceTimer) clearTimeout(graceTimer)
      if (flushTimer) clearTimeout(flushTimer)
      resolve({
        code: child.exitCode,
        signal: (child.signalCode as string | null) ?? null,
        stdout: cleanOutput(stdout),
        stderr: cleanOutput(stderr),
        timedOut,
        forceKilled,
        pipeHeldOpen,
      })
    }

    child.stdout?.on('data', (d: Buffer) => {
      stdout = appendCapped(stdout, d.toString('utf-8'), MAX_CAPTURE_CHARS)
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr = appendCapped(stderr, d.toString('utf-8'), MAX_CAPTURE_CHARS)
    })

    killTimer = setTimeout(() => {
      timedOut = true
      // 先 SIGINT：给程序保存现场 / 清理临时文件的机会（旧版直接 SIGTERM）
      try { child.kill('SIGINT') } catch { /* 已退出 */ }
      graceTimer = setTimeout(() => {
        forceKilled = true
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      }, 2000)
    }, timeoutMs)

    // 主进程退出后管道可能仍被孙进程（`cmd &`、daemon）持有 —— 400ms 兜底收尾，
    // 不再傻等 'close'。这是旧版「明明跑完了却报超时 / 退出码 0 却报失败」的根因
    child.on('exit', () => {
      flushTimer = setTimeout(() => {
        pipeHeldOpen =
          child.stdout?.readableEnded === false || child.stderr?.readableEnded === false
        finish()
      }, 400)
    })
    child.on('close', () => finish())
    child.on('error', (e: Error) => {
      stderr += `\n[spawn 失败] ${e.message}`
      finish()
    })
  })
}

/** 落盘目录 */
function flareTmpDir(): string {
  const dir = join(process.env.HOME || '.', '.flare', 'tmp')
  try { mkdirSync(dir, { recursive: true }) } catch { /* 已存在 */ }
  return dir
}

/** 长输出落盘留档，返回文件路径；过短则返回 null */
function spillOutput(body: string): string | null {
  if (body.length <= SPILL_THRESHOLD) return null
  try {
    const dir = flareTmpDir()
    const p = join(dir, `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`)
    writeFileSync(p, body, 'utf-8')
    // 只留最近 SPILL_KEEP 份，防 ~/.flare/tmp 无限增长
    try {
      const logs = readdirSync(dir)
        .filter((n) => n.startsWith('term-') && n.endsWith('.log'))
        .map((n) => ({ n, t: (() => { try { return statSync(join(dir, n)).mtimeMs } catch { return 0 } })() }))
        .sort((a, b) => b.t - a.t)
      for (const old of logs.slice(SPILL_KEEP)) {
        try { unlinkSync(join(dir, old.n)) } catch { /* ignore */ }
      }
    } catch { /* 清理失败不影响主流程 */ }
    return p
  } catch {
    return null
  }
}

/** 后台执行：输出重定向到日志文件，立即返回 PID（记录 #7/#8 的正解） */
function runBackground(cmd: string): { pid: number | undefined; logPath: string } {
  const dir = flareTmpDir()
  const logPath = join(dir, `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`)
  const fd = openSync(logPath, 'a')
  try {
    const child = spawn(RUN_SHELL, ['-c', cmd], {
      detached: true,       // 独立进程组：父进程退出/被 kill 时不连带
      stdio: ['ignore', fd, fd],
    })
    child.unref()           // 不参与事件循环引用计数，主进程可正常退出
    return { pid: child.pid, logPath }
  } finally {
    try { closeSync(fd) } catch { /* 子进程已 dup，父进程句柄可关 */ }
  }
}

/**
 * 执行终端命令工具
 */
export const terminalTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'terminal',
      description: '在终端中执行命令。可用于运行代码、安装包、git操作等',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          timeout: { type: 'number', description: '超时时间（秒，默认30）。超时先发 SIGINT、2 秒后 SIGKILL，并完整返回超时前已产生的输出' },
          background: { type: 'boolean', description: '后台执行：不等待命令结束，立即返回 PID 和日志路径。用于启动服务、守护进程、nohup、长任务' },
        },
        required: ['command'],
      },
    },
  },
  execute: (async (args: { command: string; timeout?: number; background?: boolean }) => {
    try {
      // ── 风险分级（v0.6.155，#15/#16）：block 硬拦 / confirm 需确认 / safe 直接跑 ──
      const verdict = classifyCommand(args.command)
      if (verdict.level === 'block') {
        const seg = verdict.segment && verdict.segment.trim() !== args.command.trim()
          ? `\n命中片段: ${verdict.segment.slice(0, 200)}`
          : ''
        return {
          success: false,
          output: '',
          error: `命令被安全策略拦截（规则 ${verdict.rule}：${verdict.reason}）。Flare 拒绝执行可能造成不可逆损坏的命令。${seg}`,
        }
      }

      // confirm 档（不可逆但可能合理）：交互模式先征询；无人值守模式放行但显式标注
      let riskNote = ''
      if (verdict.level === 'confirm' && verdict.rule) {
        const rule = verdict.rule
        if (!isRiskRuleAllowed(rule)) {
          const confirmer = getRiskConfirmer()
          if (confirmer) {
            const decision = await confirmer({
              command: args.command,
              rule,
              level: verdict.level,
              reason: verdict.reason || '',
              segment: verdict.segment,
            })
            if (decision === 'deny' || decision === 'alternative') {
              return {
                success: false,
                output: '',
                denied: true,
                alternative: decision === 'alternative',
                error: `用户拒绝执行不可逆操作（规则 ${rule}：${verdict.reason}）${decision === 'alternative' ? '，并要求换用其他方案' : ''}`,
              }
            }
            if (decision === 'allow_session') allowRiskRule(rule, 'session')
            if (decision === 'always') allowRiskRule(rule, 'always')
          } else {
            riskNote = `\n\n⚠️ 不可逆操作未经确认即执行（规则 ${rule}：${verdict.reason}）——当前无交互确认器（无人值守模式）。在终端交互运行 flare 时会先征询；/allow 可查看与管理放行名单。`
          }
        }
      }

      // ~ 展开兜底（即使 shell 不支持也能工作）
      let cmd = args.command
      const home = process.env.HOME || ''
      if (home) {
        cmd = cmd.replace(/^~(?=\/|$)/, home).replace(/(?<=\s)~(?=\/|$)/g, home)
      }

      // pkill -f 自伤预警（记录 #9 / #14）：模式字符串留在自己的命令行里，pkill 会把执行它的 shell 也匹配上。
      // 只在真有 pkill 调用时提示（对 heredoc 里提到 pkill 的文档不再误报，见 #14/#16 补充）
      const usesPkillF = parseCommandSegments(args.command).some(
        (s) => s.name === 'pkill' && /(?:^|\s)-{1,2}f(?:\s|$)/.test(s.argText),
      )
      const selfKillWarn = usesPkillF
        ? [
            '',
            '⚠️ 自伤风险：pkill -f 的模式串会出现在它自己的命令行里，pkill 会把执行它的 shell 一并匹配上（有时把整个会话杀掉、后续输出全丢）。',
            '   可靠写法（任选）：',
            '   ① 按端口定位：ss -tlnp | grep ":8080"  拿到 pid 后 kill <pid>',
            '   ② 方括号技巧：pkill -f "[f]luxdl_server"  —— 模式里的 [f] 匹配真正的进程名，但不匹配命令行里字面的 "[f]luxdl_server"，因此不会自伤',
            '   ③ 先看后杀：pgrep -af "server.py" 确认列表，再 kill <具体pid>',
          ].join('\n')
        : ''

      // ── 后台模式：不等待结束，立即返回 PID + 日志路径（记录 #7/#8 的正解）──
      if (args.background) {
        const { pid, logPath } = runBackground(cmd)
        return {
          success: true,
          output: [
            `已在后台启动，不阻塞本轮对话。PID: ${pid ?? '未知'}`,
            `输出日志: ${logPath}`,
            `查看最新输出: read_file ${logPath}（或终端 tail -n 50 "${logPath}"）`,
            `存活检查: kill -0 ${pid ?? '<pid>'} 2>/dev/null && echo running || echo exited`,
          ].join('\n') + riskNote,
        }
      }

      const timeoutSec = args.timeout && args.timeout > 0 ? args.timeout : 30
      const r = await runForeground(cmd, timeoutSec * 1000)
      // stdout 在前、stderr 附后（保持原始先后语义）
      let body = r.stdout
      if (r.stderr) body += (body && !body.endsWith('\n') ? '\n' : '') + r.stderr

      // 长输出落盘留档：上下文只放尾部，但数据不丢（修复记录 #3 的「双重截断」）
      const spillPath = spillOutput(body)
      const spillNote = spillPath
        ? `\n\n[完整输出 ${body.length} 字符已留档: ${spillPath}\n 用 read_file + offset/limit 分段查看开头部分]`
        : ''

      if (r.timedOut) {
        return {
          success: false,
          // 自伤预警放 output：模型主要读 output，塞进 error 容易被忽略（#14）
          output: body + selfKillWarn,
          error: `命令超时（${timeoutSec}s）${r.forceKilled ? '，SIGINT 无效已 SIGKILL 强杀' : '，已发 SIGINT'}。以下是超时前已产生的输出（${body.length} 字符，未丢弃）。长时间任务请加 background: true。${spillNote}`,
        }
      }
      if (r.code === null || r.code !== 0) {
        const codeDesc = r.code !== null ? `退出码 ${r.code}` : `被信号 ${r.signal ?? '未知'} 终止`
        return {
          success: false,
          output: body + selfKillWarn,
          error: `命令执行失败（${codeDesc}）${body ? '' : '：无输出'}${spillNote}`,
        }
      }
      // gh 的「退出码 0 但实际失败」（#17）：gh 把 HTTP 错误写到输出里却正常退出，
      // 上游只看 exit code 就会以为 push/create 成功了。
      const falseSuccess = detectFalseSuccess(args.command, body, r.code ?? 0)
      if (falseSuccess) {
        return {
          success: false,
          output: body,
          error: `${falseSuccess}\ngh 打印错误但进程正常退出是 gh 的已知行为，不能凭退出码判断成功。请核对输出里的 HTTP 状态、仓库名与权限范围。${spillNote}`,
        }
      }

      const heldNote = r.pipeHeldOpen
        ? '\n\n[注：主进程已退出（退出码 0），但有子进程仍持有输出管道未关闭；已按完成处理并返回现有输出，不再误报超时]'
        : ''
      return { success: true, output: body + heldNote + spillNote + selfKillWarn + riskNote }
    } catch (e: any) {
      return {
        success: false,
        output: '',
        error: `命令执行异常: ${String(e?.message || e).slice(0, 500)}`,
      }
    }
  }) as ToolExecutor,
}

/**
 * 所有可用工具
 */
export const tools: Tool[] = [
  readFileTool,
  writeFileTool,
  searchFilesTool,
  terminalTool,
  // RAG（v0.5.1）：记忆/历史消息检索工具
  memorySearchTool,
  // 记忆保存（v0.5.4）：用户明确要求记住时落库
  memorySaveTool,
  // 跨平台命令翻译（v0.6.152）：ssh 到 mac/win 前先翻译并判定等价性
  ferryTranslateTool,
]

/**
 * 获取工具定义列表（用于 LLM function calling）
 */
export function getToolDefinitions(): ToolDefinition[] {
  return tools.map(t => t.definition)
}

/**
 * 根据名称查找并执行工具
 */
export async function executeTool(name: string, args: Record<string, any>): Promise<ToolResult> {
  const tool = tools.find(t => t.definition.function.name === name)
  if (!tool) {
    return { success: false, output: '', error: `未知工具: ${name}` }
  }
  return tool.execute(args)
}
