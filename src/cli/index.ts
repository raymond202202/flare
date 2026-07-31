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
import { createInterface } from 'readline'
import { execSync } from 'child_process'

const pkg = { version: '0.1.0' } as const
const FLARE_ASCII = `
  ╔══════════════════════════════════╗
  ║          ✦  F L A R E  ✦        ║
  ║     Your AI Agent, Your Way      ║
  ╚══════════════════════════════════╝
`

function startInteractive() {
  console.log(chalk.cyan(FLARE_ASCII))
  console.log(chalk.gray('输入 /help 查看命令，/exit 退出\n'))

  const store = getMemoryStore()
  const sessionId = store.createSession('CLI 会话')
  const agent = new Agent({ sessionId })

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.green('🔥 flare> '),
  })

  // 标记 Agent 是否正在运行（防止并发输入干扰 readline 状态）
  let isRunning = false

  rl.prompt()

  rl.on('line', async (line: string) => {
    // Agent 运行期间忽略新的输入，避免 readline 状态错乱
    if (isRunning) return

    const input = line.trim()

    if (!input) {
      rl.prompt()
      return
    }

    // 处理斜杠命令
    if (input.startsWith('/')) {
      await handleSlashCommand(input, rl, store, sessionId)
      rl.prompt()
      return
    }

    // ===== 进入 Agent 运行阶段 =====
    isRunning = true

    // 1. 暂停 readline 输入监听（防止用户输入干扰终端状态）
    rl.pause()

    // 2. 关闭终端回显（仅 Linux/macOS；Windows 没有 stty，跳过）
    //    用 try/finally 保证无论 Agent 是否抛异常都恢复终端
    const isUnix = process.platform !== 'win32'
    let echoDisabled = false
    if (isUnix) {
      try {
        execSync('stty -echo', { stdio: 'ignore' })
        echoDisabled = true
      } catch { /* 非终端环境忽略 */ }
    }

    // 3. 光标移到新行，开始输出
    process.stdout.write('\r\n')
    process.stdout.write(chalk.yellow('⚡ Flare 思考中...\n\n'))

    // ===== 草稿/答卷 视觉分层 =====
    // 把 LLM 输出的文本缓冲起来，看到下一个 chunk 再决定它是
    // "过程中的话"（草稿，灰色）还是"最终答案"（答卷，分隔线+正常色）
    let pendingText = ''

    const flushDraft = () => {
      if (!pendingText.trim()) return
      // 草稿：过程中 LLM 说的话（"我来看看..."），灰色弱化
      const lines = pendingText.trim().split('\n')
      process.stdout.write(lines.map(l => chalk.gray(`  💭 ${l}`)).join('\n') + '\n')
      pendingText = ''
    }

    const flushAnswer = () => {
      if (!pendingText.trim()) return
      // 答卷：最终交付给用户的答案，用亮紫色分隔线框出，正常颜色突出
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
            // 先缓冲，等看到下一个 chunk 再定性
            pendingText += chunk.content
            break
          case 'tool_call':
            // 缓冲的文本是草稿（过程中说的话）
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
            // 缓冲的文本是最终答案（答卷）
            flushAnswer()
            break
        }
      }
    } catch (e: any) {
      flushDraft()
      process.stdout.write(chalk.red(`\n❌ 错误: ${e.message}\n`))
    } finally {
      // 4. 无论如何都恢复终端回显（Agent 崩溃也不丢失）
      if (isUnix && echoDisabled) {
        try {
          execSync('stty echo', { stdio: 'ignore' })
        } catch { /* 忽略 */ }
      }

      // 5. 恢复 readline，重新绘制干净的 prompt
      rl.resume()
      isRunning = false
      rl.prompt()
    }
  })

  rl.on('close', () => {
    // 确保退出时恢复终端状态
    if (process.platform !== 'win32') {
      try {
        execSync('stty echo', { stdio: 'ignore' })
      } catch { /* 忽略 */ }
    }
    console.log(chalk.cyan('\n再见！✨'))
    process.exit(0)
  })
}

async function handleSlashCommand(
  cmd: string,
  rl: ReturnType<typeof createInterface>,
  store: ReturnType<typeof getMemoryStore>,
  sessionId: string
) {
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
      rl.close()
      break
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
