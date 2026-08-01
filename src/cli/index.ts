/**
 * Flare CLI 入口
 * 
 * 用法：
 *   flare              → 交互模式
 *   flare chat -q "xxx" → 单次查询
 *   flare --help       → 帮助
 */

import { Command } from 'commander'
import { Agent } from '../core/agent.js'
import { getMemoryStore } from '../memory/store.js'
import chalk from 'chalk'
import { execSync } from 'child_process'
import { createRequire } from 'module'
import { LineInput } from './line-input.js'
import { R, O, A, Y, D, renderStaticBanner, playFlameBanner } from './flame-banner.js'

// 从 package.json 读取版本号（不要硬编码，否则 --version 会过期）
const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

async function startInteractive() {
  // 非 TTY（管道/重定向输入）下无法交互，友好提示而不是崩溃
  if (!process.stdin.isTTY) {
    console.error(chalk.red('❌ 交互模式需要在终端中运行（当前输入不是终端）。'))
    console.error(chalk.gray('  用法：直接运行 `flare` 进入交互模式，或用 `flare chat -q "问题"` 单次查询。'))
    process.exit(1)
  }

  console.log()  // 欢迎词上方留一行空格

  // 播放火焰欢迎动画（粒子 + 呼吸），结束后定格静态火焰招牌
  if (process.stdout.isTTY) {
    await playFlameBanner()
  }
  console.log(renderStaticBanner())
  console.log()  // 提示语与标语隔一行
  console.log(chalk.gray('输入 /help 查看命令，/exit 退出'))

  const store = getMemoryStore()
  const sessionId = store.createSession('CLI 会话')
  const agent = new Agent({ sessionId })

  // 自研输入行：完全绕开 Node readline 的折行重绘 bug
  const lineInput = new LineInput(O('🔥 flare> '))
  const isUnix = process.platform !== 'win32'

  while (true) {
    // 读取一行输入（长中文/emoji 折行也不会重复）
    const raw = await lineInput.readLine()

    // Ctrl+C 退出
    if (raw === '\u0003') break

    const input = raw.trim()
    if (!input) continue

    // 斜杠命令
    if (input.startsWith('/')) {
      const action = await handleSlashCommand(input, store)
      if (action === 'exit') break
      continue
    }

    // ===== 进入 Agent 运行阶段 =====
    // 1. 暂停输入 + 关闭终端回显（仅 Unix；try/finally 保证恢复）
    lineInput.pause()
    let echoDisabled = false
    if (isUnix) {
      try {
        execSync('stty -echo', { stdio: 'ignore' })
        echoDisabled = true
      } catch { /* 非终端环境忽略 */ }
    }

    process.stdout.write('\r\n' + Y('⚡ Flare 思考中...\n\n'))

    // ===== 草稿/答卷 视觉分层 =====
    // 把 LLM 输出的文本缓冲起来，看到下一个 chunk 再决定它是
    // "过程中的话"（草稿，灰色）还是"最终答案"（答卷，紫色分隔线+正常色）
    let pendingText = ''

    const flushDraft = () => {
      if (!pendingText.trim()) return
      const lines = pendingText.trim().split('\n')
      process.stdout.write(lines.map(l => A(`  💭 ${l}`)).join('\n') + '\n')
      pendingText = ''
    }

    const flushAnswer = () => {
      if (!pendingText.trim()) return
      // 答卷：最终交付，用火焰红色分隔线框出（最醒目）
      const sep = R('─'.repeat(44))
      process.stdout.write('\n' + sep + '\n')
      process.stdout.write(pendingText.replace(/\n+$/, '') + '\n')
      process.stdout.write(sep + '\n\n')
      pendingText = ''
    }

    const renderToolResult = (toolName: string, content: string) => {
      const maxLen = toolName === 'terminal' ? 500 : 300
      const truncated = content.slice(0, maxLen)
      const lines = truncated.split('\n')
      const body = lines.map(l => `  ${D('│')} ${l}`).join('\n')
      return `\n${D(`  ┌─ ${toolName}`)}\n${body}\n${D('  └─')}\n`
    }

    try {
      for await (const chunk of agent.run(input)) {
        switch (chunk.type) {
          case 'text':
            pendingText += chunk.content
            break
          case 'tool_call':
            flushDraft()
            process.stdout.write(O(`  🔧 调用工具: ${chunk.content}\n`))
            break
          case 'tool_result':
            process.stdout.write(renderToolResult(chunk.toolName || 'tool', chunk.content))
            break
          case 'error':
            flushDraft()
            process.stdout.write(chalk.red(`\n❌ ${chunk.content}\n`))
            break
          case 'done':
            flushAnswer()
            break
        }
      }
    } catch (e: any) {
      flushDraft()
      process.stdout.write(chalk.red(`\n❌ 错误: ${e.message}\n`))
    } finally {
      // 2. 无论如何都恢复终端回显（Agent 崩溃也不丢失）
      if (isUnix && echoDisabled) {
        try {
          execSync('stty echo', { stdio: 'ignore' })
        } catch { /* 忽略 */ }
      }
      // 3. 恢复输入，重新绘制干净的 prompt
      lineInput.resume()
    }
  }

  // 退出：确保恢复终端状态
  if (isUnix) {
    try {
      execSync('stty echo', { stdio: 'ignore' })
    } catch { /* 忽略 */ }
  }
  console.log(Y('\n再见！✨'))
  process.exit(0)
}

async function handleSlashCommand(
  cmd: string,
  store: ReturnType<typeof getMemoryStore>
): Promise<'exit' | 'continue'> {
  const lower = cmd.toLowerCase()
  // /remember 带内容，必须用前缀匹配（switch 精确匹配会永远"未知命令"）
  if (lower === '/remember' || lower.startsWith('/remember ')) {
    const rememberContent = cmd.replace(/^\/remember\s+/, '').trim()
    if (!rememberContent) {
      console.log(chalk.yellow('\n用法: /remember <要记住的内容>'))
    } else {
      store.saveMemory(rememberContent, 'note')
      console.log(chalk.green(`\n✅ 已记住: ${rememberContent.slice(0, 80)}`))
    }
    console.log()
    return 'continue'
  }

  switch (lower) {
    case '/help':
      console.log(chalk.cyan('\n可用命令:'))
      console.log('  /help        - 显示帮助')
      console.log('  /exit        - 退出')
      console.log('  /memory      - 查看记忆')
      console.log('  /remember    - 保存一条记忆（如: /remember 用户喜欢浅色主题）')
      console.log('  /usage       - 查看 token 用量')
      console.log('  /sessions    - 查看会话列表')
      console.log('  /clear       - 清屏')
      break
    case '/usage':
      const usage = store.getUsageStats()
      if (!usage || usage.totalTokens === 0) {
        console.log(chalk.yellow('\n暂无用量记录'))
      } else {
        console.log(chalk.cyan('\n📊 Token 用量:'))
        console.log(`  ${chalk.gray('Prompt:')}     ${usage.promptTokens.toLocaleString()}`)
        console.log(`  ${chalk.gray('Completion:')} ${usage.completionTokens.toLocaleString()}`)
        console.log(`  ${chalk.gray('总计:')}       ${usage.totalTokens.toLocaleString()} tokens`)
        console.log(`  ${chalk.gray('会话数:')}     ${usage.sessionCount}`)
      }
      break
    case '/exit':
    case '/quit':
      return 'exit'
    case '/memory':
      const memories = store.getAllMemories()
      if (memories.length === 0) {
        console.log(chalk.yellow('\n暂无记忆'))
      } else {
        console.log(chalk.cyan('\n📝 记忆列表:'))
        memories.forEach(m => {
          console.log(`  ${chalk.gray(`[${m.created_at}]`)} ${m.content.slice(0, 80)}`)
        })
      }
      break
    case '/sessions':
      const sessions = store.getRecentSessions()
      if (sessions.length === 0) {
        console.log(chalk.yellow('\n暂无会话'))
      } else {
        console.log(chalk.cyan('\n💬 最近会话:'))
        const now = new Date()
        sessions.forEach(s => {
          // 会话标题：取第一条用户消息（可读），空会话标注
          const msg = (s as any).first_user_msg || '（空会话）'
          const preview = msg.replace(/\s+/g, ' ').trim().slice(0, 30)
          // 友好时间：今天显示 HH:MM，昨天显示"昨天"，更早显示 M月D日
          let timeStr = s.updated_at
          try {
            const d = new Date(s.updated_at.replace(' ', 'T'))
            const isToday = d.toDateString() === now.toDateString()
            const yesterday = new Date(now)
            yesterday.setDate(now.getDate() - 1)
            const isYesterday = d.toDateString() === yesterday.toDateString()
            if (isToday) {
              timeStr = d.toTimeString().slice(0, 5)
            } else if (isYesterday) {
              timeStr = '昨天'
            } else {
              timeStr = `${d.getMonth() + 1}月${d.getDate()}日`
            }
          } catch { /* 解析失败用原始时间 */ }
          console.log(`  ${chalk.gray(`[${timeStr}]`)} ${preview}`)
        })
      }
      break
    case '/clear':
      console.clear()
      console.log(renderStaticBanner())
      console.log(chalk.gray('输入 /help 查看命令，/exit 退出\n'))
      break
    default:
      console.log(chalk.yellow(`\n未知命令: ${cmd}。输入 /help 查看可用命令`))
  }
  console.log()
  return 'continue'
}

async function runQuery(query: string, maxIterations?: number) {
  const store = getMemoryStore()
  const sessionId = store.createSession('单次查询')
  const agent = new Agent({ sessionId, maxIterations })

  console.error(Y('⚡ Flare 思考中...'))

  try {
    let pendingText = ''
    const parts: string[] = []

    const flushDraft = () => {
      if (!pendingText.trim()) return
      parts.push(A(`  💭 ${pendingText.trim()}`))
      pendingText = ''
    }
    const flushAnswer = () => {
      if (!pendingText.trim()) return
      const sep = R('─'.repeat(44))
      parts.push('\n' + sep + '\n' + pendingText.replace(/\n+$/, '') + '\n' + sep + '\n')
      pendingText = ''
    }

    for await (const chunk of agent.run(query)) {
      switch (chunk.type) {
        case 'text':
          pendingText += chunk.content
          break
        case 'tool_call':
          flushDraft()
          parts.push(O(`  🔧 调用工具: ${chunk.content}`))
          break
        case 'tool_result':
          parts.push(D(`  ┌─ ${chunk.toolName || 'tool'}`))
          parts.push(chunk.content.slice(0, 200).split('\n').map(l => `  ${D('│')} ${l}`).join('\n'))
          parts.push(D('  └─'))
          break
        case 'error':
          flushDraft()
          parts.push(chalk.red(`❌ ${chunk.content}`))
          break
        case 'done':
          flushAnswer()
          break
      }
    }
    console.log(parts.join('\n'))
  } catch (e: any) {
    console.error(chalk.red(`\n❌ 错误: ${e.message}`))
    process.exit(1)
  }
}

export function main() {
  const program = new Command()

  program
    .name('flare')
    .description('Flare — 你的 AI 编程助手')
    .version(pkg.version)

  program
    .command('chat')
    .description('与 Flare 对话')
    .option('-q, --query <text>', '单次查询模式，直接提问')
    .option('-m, --max-iterations <n>', '最大工具调用迭代次数（默认30，上限50）')
    .action(async (options: { query?: string; maxIterations?: string }) => {
      if (options.query) {
        const maxIter = options.maxIterations ? parseInt(options.maxIterations, 10) : undefined
        await runQuery(options.query, maxIter)
      } else {
        startInteractive()
      }
    })

  // 默认命令（无参数时进入交互模式）
  program.action(() => {
    startInteractive()
  })

  program.parse(process.argv)
}

// 直接运行入口
main()
