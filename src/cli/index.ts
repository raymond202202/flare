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
import { LineInput } from './line-input.js'

const pkg = { version: '0.1.0' } as const
const FLARE_ASCII = `
  ╔══════════════════════════════════╗
  ║          ✦  F L A R E  ✦        ║
  ║     Your AI Agent, Your Way      ║
  ╚══════════════════════════════════╝
`

async function startInteractive() {
  console.log(chalk.cyan(FLARE_ASCII))
  console.log(chalk.gray('输入 /help 查看命令，/exit 退出\n'))

  const store = getMemoryStore()
  const sessionId = store.createSession('CLI 会话')
  const agent = new Agent({ sessionId })

  // 自研输入行：完全绕开 Node readline 的折行重绘 bug
  const lineInput = new LineInput(chalk.green('🔥 flare> '))
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

    process.stdout.write('\r\n' + chalk.yellow('⚡ Flare 思考中...\n\n'))

    // ===== 草稿/答卷 视觉分层 =====
    // 把 LLM 输出的文本缓冲起来，看到下一个 chunk 再决定它是
    // "过程中的话"（草稿，灰色）还是"最终答案"（答卷，紫色分隔线+正常色）
    let pendingText = ''

    const flushDraft = () => {
      if (!pendingText.trim()) return
      const lines = pendingText.trim().split('\n')
      process.stdout.write(lines.map(l => chalk.gray(`  💭 ${l}`)).join('\n') + '\n')
      pendingText = ''
    }

    const flushAnswer = () => {
      if (!pendingText.trim()) return
      const sep = chalk.hex('#6d4aff')('─'.repeat(44))
      process.stdout.write('\n' + sep + '\n')
      process.stdout.write(pendingText.replace(/\n+$/, '') + '\n')
      process.stdout.write(sep + '\n\n')
      pendingText = ''
    }

    const renderToolResult = (toolName: string, content: string) => {
      const maxLen = toolName === 'terminal' ? 500 : 300
      const truncated = content.slice(0, maxLen)
      const lines = truncated.split('\n')
      const body = lines.map(l => `  ${chalk.gray('│')} ${l}`).join('\n')
      return `\n${chalk.gray(`  ┌─ ${toolName}`)}\n${body}\n${chalk.gray('  └─')}\n`
    }

    try {
      for await (const chunk of agent.run(input)) {
        switch (chunk.type) {
          case 'text':
            pendingText += chunk.content
            break
          case 'tool_call':
            flushDraft()
            process.stdout.write(chalk.yellow(`  🔧 调用工具: ${chunk.content}\n`))
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
  console.log(chalk.cyan('\n再见！✨'))
  process.exit(0)
}

async function handleSlashCommand(
  cmd: string,
  store: ReturnType<typeof getMemoryStore>
): Promise<'exit' | 'continue'> {
  switch (cmd.toLowerCase()) {
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
    case '/remember':
      const rememberContent = cmd.replace(/^\/remember\s+/, '').trim()
      if (!rememberContent) {
        console.log(chalk.yellow('\n用法: /remember <要记住的内容>'))
      } else {
        store.saveMemory(rememberContent, 'note')
        console.log(chalk.green(`\n✅ 已记住: ${rememberContent.slice(0, 80)}`))
      }
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
        sessions.forEach(s => {
          console.log(`  ${chalk.gray(s.id.slice(0, 16))} ${s.title} (${s.updated_at})`)
        })
      }
      break
    case '/clear':
      console.clear()
      console.log(chalk.cyan(FLARE_ASCII))
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

  console.error(chalk.yellow('⚡ Flare 思考中...'))

  try {
    let pendingText = ''
    const parts: string[] = []

    const flushDraft = () => {
      if (!pendingText.trim()) return
      parts.push(chalk.gray(`  💭 ${pendingText.trim()}`))
      pendingText = ''
    }
    const flushAnswer = () => {
      if (!pendingText.trim()) return
      const sep = chalk.hex('#6d4aff')('─'.repeat(44))
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
          parts.push(chalk.yellow(`  🔧 调用工具: ${chunk.content}`))
          break
        case 'tool_result':
          parts.push(chalk.gray(`  ┌─ ${chunk.toolName || 'tool'}`))
          parts.push(chunk.content.slice(0, 200).split('\n').map(l => `  ${chalk.gray('│')} ${l}`).join('\n'))
          parts.push(chalk.gray('  └─'))
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
