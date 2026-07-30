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

  let isRunning = false  // 防止 Agent 运行时触发重复输入

  rl.prompt()

  rl.on('line', async (line: string) => {
    const input = line.trim()

    // 如果 Agent 正在运行，忽略本次输入（防重复）
    if (isRunning) {
      return
    }

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

    // 运行 Agent
    isRunning = true
    // 停止 readline 内部的事件监听，防止输入重叠
    rl.pause()
    // 输出一个空行把 prompt 隔开
    process.stdout.write('\n')
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
          case 'done':
            process.stdout.write('\n\n')
            break
        }
      }
    } catch (e: any) {
      process.stdout.write(chalk.red(`\n❌ 错误: ${e.message}\n`))
    }

    // Agent 执行完毕，恢复 readline 并重新绘制干净的 prompt
    rl.resume()
    isRunning = false
    rl.prompt()
  })

  rl.on('close', () => {
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
      console.log('  /help      - 显示帮助')
      console.log('  /exit      - 退出')
      console.log('  /memory    - 查看记忆')
      console.log('  /sessions  - 查看会话列表')
      console.log('  /clear     - 清屏')
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

async function runQuery(query: string) {
  const store = getMemoryStore()
  const sessionId = store.createSession('单次查询')
  const agent = new Agent({ sessionId })

  console.error(chalk.yellow('⚡ Flare 思考中...'))

  try {
    let fullOutput = ''
    for await (const chunk of agent.run(query)) {
      switch (chunk.type) {
        case 'text':
          fullOutput += chunk.content
          break
        case 'tool_call':
          fullOutput += `\n[工具: ${chunk.content}]\n`
          break
        case 'tool_result':
          fullOutput += `[结果: ${chunk.content.slice(0, 200)}]\n`
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
    .action(async (options: { query?: string }) => {
      if (options.query) {
        await runQuery(options.query)
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
