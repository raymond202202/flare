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
import * as readline from 'readline'
import { execSync } from 'child_process'

const pkg = { version: '0.1.0' } as const
const FLARE_ASCII = `
  ╔══════════════════════════════════╗
  ║          ✦  F L A R E  ✦        ║
  ║     Your AI Agent, Your Way      ║
  ╚══════════════════════════════════╝
`

const PROMPT_STR = chalk.green('🔥 flare> ')

/**
 * 获取终端行列数
 */
function getTerminalSize(): { cols: number; rows: number } {
  try {
    const output = execSync('stty size', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    const [rows, cols] = output.trim().split(' ').map(Number)
    return { rows, cols }
  } catch {
    return { rows: 24, cols: 80 }
  }
}

/**
 * 计算字符串在终端中的可视宽度（考虑中文字符占2列）
 */
function visualWidth(str: string): number {
  let width = 0
  for (const ch of str) {
    // 中文字符（包括中文标点）在终端中占2列
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) {
      width += 2
    } else {
      width += 1
    }
  }
  return width
}

/**
 * 清除当前终端行
 */
function clearCurrentLine() {
  readline.clearLine(process.stdout, 0)
  readline.cursorTo(process.stdout, 0)
}

/**
 * 禁用终端本地回显
 */
function disableEcho() {
  try {
    execSync('stty -echo', { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {}
}

/**
 * 启用终端本地回显
 */
function enableEcho() {
  try {
    execSync('stty echo', { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {}
}

function startInteractive() {
  console.log(chalk.cyan(FLARE_ASCII))
  console.log(chalk.gray('输入 /help 查看命令，/exit 退出\n'))

  const store = getMemoryStore()
  const sessionId = store.createSession('CLI 会话')
  const agent = new Agent({ sessionId })

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT_STR,
  })

  rl.prompt()

  rl.on('line', async (line: string) => {
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

    // ★ 核心修复：在 Agent 运行前关闭终端回显
    // 这样 execSync 执行子进程时，终端不会把 stdin 残留数据 echo 到屏幕上
    disableEcho()

    // 清除当前行（去掉 prompt 和输入内容）
    clearCurrentLine()

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

    // ★ Agent 执行完毕：恢复终端回显
    enableEcho()

    rl.prompt()
  })

  rl.on('close', () => {
    console.log(chalk.cyan('\n再见！✨'))
    process.exit(0)
  })
}

async function handleSlashCommand(
  cmd: string,
  rl: readline.Interface,
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
