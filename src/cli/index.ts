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

    try {
      for await (const chunk of agent.run(input)) {
        switch (chunk.type) {
          case 'text':
            process.stdout.write(chunk.content)
            break
          case 'tool_call':
            process.stdout.write(chalk.dim(`\n🔧 调用工具: ${chunk.content}\n`))
            break
          case 'tool_result':
            if (chunk.toolName === 'terminal') {
              process.stdout.write(chalk.dim(chunk.content.slice(0, 500)) + '\n')
            } else {
              process.stdout.write(chalk.dim(chunk.content.slice(0, 300)) + '\n')
            }
            break
          case 'error':
            process.stdout.write(chalk.yellow(`\n⚠️  ${chunk.content}\n`))
            break
          case 'done':
            process.stdout.write('\n\n')
            break
        }
      }
    } catch (e: any) {
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
    let fullOutput = ''
    for await (const chunk of agent.run(query)) {
      switch (chunk.type) {
        case 'text':
          fullOutput += chunk.content
          break
        case 'tool_call':
          fullOutput += `\n🔧 工具: ${chunk.content}\n`
          break
        case 'tool_result':
          fullOutput += `📎 ${chunk.content.slice(0, 200)}\n`
          break
        case 'error':
          fullOutput += `\n⚠️  ${chunk.content}\n`
          break
        case 'done':
          break
      }
    }
    console.log(fullOutput)
    // Force stdout flush
    process.stdout.write('')
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
