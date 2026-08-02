/**
 * Flare CLI 入口
 * 
 * 用法：
 *   flare              → 交互模式
 *   flare chat -q "xxx" → 单次查询
 *   flare --help       → 帮助
 */

import { Command } from 'commander'
import { Agent, getMemoryStore, config } from '../index.js'
import chalk from 'chalk'
import { execSync } from 'child_process'
import { createRequire } from 'module'
import { LineInput } from './line-input.js'
import { R, O, A, Y, D, createFlameState, updateFlame, renderFlameFrame, flameBreathColor } from './flame-banner.js'

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

  const store = getMemoryStore()
  const sessionId = store.createSession('CLI 会话')
  const agent = new Agent({ sessionId })
  const isUnix = process.platform !== 'win32'

  // ===== 常驻火焰动画 =====
  const flame = createFlameState()

  // ===== 帧模式输入（按键只更新状态，由渲染循环重绘）=====
  const lineInput = new LineInput('🔥 flare> ', {
    frameMode: true,
    onChange: () => renderFrame(),
  })

  // ===== 状态 =====
  let agentRunning = false
  let agentOutput = ''
  let pendingText = ''   // Agent 草稿缓冲
  let exiting = false

  // ===== 渲染 =====
  const CONTENT_ROW = 6   // 内容区起始行（0 基）：banner 4 行 + 空行 + 提示语行

  const flushDraft = () => {
    if (!pendingText.trim()) return
    const lines = pendingText.trim().split('\n')
    agentOutput += lines.map(l => A(`  💭 ${l}`)).join('\n') + '\n'
    pendingText = ''
  }

  const flushAnswer = () => {
    if (!pendingText.trim()) return
    const sep = R('─'.repeat(44))
    agentOutput += '\n' + sep + '\n' + pendingText.replace(/\n+$/, '') + '\n' + sep + '\n'
    pendingText = ''
  }

  const renderToolResult = (toolName: string, content: string) => {
    const maxLen = toolName === 'terminal' ? 500 : 300
    const truncated = content.slice(0, maxLen)
    const body = truncated.split('\n').map(l => `  ${D('│')} ${l}`).join('\n')
    return `\n${D(`  ┌─ ${toolName}`)}\n${body}\n${D('  └─')}\n`
  }

  /** 渲染一帧：火焰 banner（常驻动画）+ 固定提示语 + 内容区（输入行或 Agent 输出） */
  function renderFrame() {
    const t = Date.now() / 1000
    const banner = renderFlameFrame(flame, t)
    const breath = flameBreathColor(Date.now())
    let out = '\x1b[2J\x1b[H'
    out += '\n'                       // 顶部空行（不顶格）
    out += banner + '\n'
    out += '输入 /help 查看命令，/exit 退出\n'
    if (agentRunning) {
      out += agentOutput
    } else {
      out += lineInput.renderLine(breath)  // prompt 呼吸色
    }
    process.stdout.write(out)
    // 输入模式下光标定位到输入位置（Agent 运行时无输入光标）
    if (!agentRunning) {
      lineInput.positionCursorAt(CONTENT_ROW, 0)
    }
  }

  // 渲染循环（常驻：火焰持续跳动）
  let renderTimer: ReturnType<typeof setInterval> | null = null
  const startRenderLoop = () => {
    renderTimer = setInterval(() => {
      updateFlame(flame, 0.08)
      renderFrame()
    }, 80)
  }
  const stopRenderLoop = () => {
    if (renderTimer) clearInterval(renderTimer)
    renderTimer = null
  }

  // Ctrl+C：恢复光标退出
  const onSigint = () => {
    stopRenderLoop()
    process.stdout.write('\x1b[?25h\x1b[0m\n')
    process.exit(0)
  }
  process.on('SIGINT', onSigint)

  // ===== Agent 运行（输出累积到内容区，火焰继续跳）=====
  async function runAgent(input: string, attachments?: string[]) {
    agentRunning = true
    agentOutput = ''
    pendingText = ''
    agentOutput += O(`🔥 flare> ${input}`) + '\n\n'

    let echoDisabled = false
    if (isUnix) {
      try { execSync('stty -echo', { stdio: 'ignore' }); echoDisabled = true } catch { /* 忽略 */ }
    }

    try {
      for await (const chunk of agent.run(input, attachments)) {
        switch (chunk.type) {
          case 'text':
            pendingText += chunk.content
            break
          case 'tool_call':
            flushDraft()
            agentOutput += O(`  🔧 调用工具: ${chunk.content}\n`)
            break
          case 'tool_result':
            agentOutput += renderToolResult(chunk.toolName || 'tool', chunk.content)
            break
          case 'error':
            flushDraft()
            agentOutput += chalk.red(`\n❌ ${chunk.content}\n`)
            break
          case 'done':
            flushAnswer()
            break
        }
        renderFrame()  // 即时反馈
      }
    } catch (e: any) {
      flushDraft()
      agentOutput += chalk.red(`\n❌ 错误: ${e.message}\n`)
    } finally {
      if (isUnix && echoDisabled) {
        try { execSync('stty echo', { stdio: 'ignore' }) } catch { /* 忽略 */ }
      }
      agentRunning = false
      renderFrame()
    }
  }

  // ===== 斜杠命令（输出到内容区）=====
  async function runCommand(cmd: string): Promise<'exit' | 'continue'> {
    agentRunning = true
    agentOutput = ''
    agentOutput += O(`🔥 flare> ${cmd}`) + '\n\n'
    pendingText = ''
    const result = await handleSlashCommand(cmd, store, (s) => { agentOutput += s + '\n' })
    agentRunning = false
    renderFrame()
    return result
  }

  // ===== 主循环 =====
  startRenderLoop()
  renderFrame()

  while (!exiting) {
    const raw = await lineInput.readLine()
    if (raw === '\u0003') break
    const input = raw.trim()
    if (!input) continue
    if (input.startsWith('/')) {
      // /image <路径> <问题> —— 显式看图（普通对话直接发图片路径也会自动识别）
      if (input.toLowerCase().startsWith('/image')) {
        const img = parseImageCommand(input)
        if (img.attachments.length === 0) {
          const action = await runCommand(input) // 显示用法提示
          if (action === 'exit') break
        } else {
          await runAgent(img.text || '请描述这张图片', img.attachments)
        }
        continue
      }
      const action = await runCommand(input)
      if (action === 'exit') break
      continue
    }
    await runAgent(input)
  }

  stopRenderLoop()
  process.off('SIGINT', onSigint)
  if (isUnix) {
    try { execSync('stty echo', { stdio: 'ignore' }) } catch { /* 忽略 */ }
  }
  console.log(Y('\n再见！✨'))
  process.exit(0)
}

/**
 * 解析 /image 命令：/image <图片路径> <问题>
 * 路径支持引号包裹（含空格）；剩余文本为问题
 */
function parseImageCommand(cmd: string): { text: string; attachments: string[] } {
  const rest = cmd.replace(/^\/image\s+/i, '').trim()
  if (!rest) return { text: '', attachments: [] }

  // 引号包裹的路径："我的截图 01.png" 剩下的都是问题
  const quoted = rest.match(/^["'](.+?)["']\s*([\s\S]*)$/)
  if (quoted) {
    return { text: quoted[2].trim(), attachments: [quoted[1]] }
  }

  // 第一个空格前的 token 当路径
  const sp = rest.indexOf(' ')
  if (sp === -1) {
    return { text: '', attachments: [rest] }
  }
  return { text: rest.slice(sp + 1).trim(), attachments: [rest.slice(0, sp)] }
}

async function handleSlashCommand(
  cmd: string,
  store: ReturnType<typeof getMemoryStore>,
  output: (s: string) => void = console.log
): Promise<'exit' | 'continue'> {
  const lower = cmd.toLowerCase()
  // /remember 带内容，必须用前缀匹配（switch 精确匹配会永远"未知命令"）
  if (lower === '/remember' || lower.startsWith('/remember ')) {
    const rememberContent = cmd.replace(/^\/remember\s+/, '').trim()
    if (!rememberContent) {
      output(chalk.yellow('\n用法: /remember <要记住的内容>'))
    } else {
      store.saveMemory(rememberContent, 'note')
      output(chalk.green(`\n✅ 已记住: ${rememberContent.slice(0, 80)}`))
    }
    return 'continue'
  }

  // /vision 切换看图模型（3B 快速 / 7B 质量）
  if (lower === '/vision' || lower.startsWith('/vision ')) {
    const arg = cmd.replace(/^\/vision\s+/, '').trim().toLowerCase()
    const current = store.getSetting('vision_model') || config.get('VISION_MODEL') || 'qwen2.5vl:3b'
    if (!arg) {
      output(chalk.cyan(`\n👁️ 当前看图模型: ${current}`))
      output('  /vision 3b|fast   - 快速模式（qwen2.5vl:3b，OCR/截图推荐）')
      output('  /vision 7b|quality- 质量模式（qwen2.5vl:7b，精细理解稍慢）')
      output('  /vision default   - 回默认（.env 的 VISION_MODEL）')
    } else if (arg === '3b' || arg === 'fast') {
      store.setSetting('vision_model', 'qwen2.5vl:3b')
      output(chalk.green('\n✅ 看图模型已切换: qwen2.5vl:3b（快速，OCR/截图推荐）'))
    } else if (arg === '7b' || arg === 'quality') {
      store.setSetting('vision_model', 'qwen2.5vl:7b')
      output(chalk.green('\n✅ 看图模型已切换: qwen2.5vl:7b（质量优先，稍慢）'))
    } else if (arg === 'default' || arg === 'reset') {
      store.setSetting('vision_model', '')
      output(chalk.green(`\n✅ 已恢复默认看图模型（${config.get('VISION_MODEL') || 'qwen2.5vl:3b'}）`))
    } else {
      output(chalk.yellow('\n用法: /vision [3b|fast|7b|quality|default]'))
    }
    return 'continue'
  }

  switch (lower) {
    case '/help':
      output(chalk.cyan('\n可用命令:'))
      output('  /help        - 显示帮助')
      output('  /exit        - 退出')
      output('  /memory      - 查看记忆')
      output('  /remember    - 保存一条记忆（如: /remember 用户喜欢浅色主题）')
      output('  /usage       - 查看 token 用量')
      output('  /sessions    - 查看会话列表')
      output('  /clear       - 清屏')
      output('  /image       - 显式看图（如: /image ~/Pictures/a.png 这张图里有什么）')
      output('  /vision      - 切换看图模型（/vision 3b 快速 | /vision 7b 质量）')
      output(chalk.gray('  💡 对话里直接发图片路径也会自动识别（如: 看看这张图 xxx.png）'))
      break
    case '/usage':
      const usage = store.getUsageStats()
      if (!usage || usage.totalTokens === 0) {
        output(chalk.yellow('\n暂无用量记录'))
      } else {
        output(chalk.cyan('\n📊 Token 用量:'))
        output(`  ${chalk.gray('Prompt:')}     ${usage.promptTokens.toLocaleString()}`)
        output(`  ${chalk.gray('Completion:')} ${usage.completionTokens.toLocaleString()}`)
        output(`  ${chalk.gray('总计:')}       ${usage.totalTokens.toLocaleString()} tokens`)
        output(`  ${chalk.gray('会话数:')}     ${usage.sessionCount}`)
      }
      break
    case '/exit':
    case '/quit':
      return 'exit'
    case '/memory':
      const memories = store.getAllMemories()
      if (memories.length === 0) {
        output(chalk.yellow('\n暂无记忆'))
      } else {
        output(chalk.cyan('\n📝 记忆列表:'))
        memories.forEach(m => {
          output(`  ${chalk.gray(`[${m.created_at}]`)} ${m.content.slice(0, 80)}`)
        })
      }
      break
    case '/sessions':
      const sessions = store.getRecentSessions()
      if (sessions.length === 0) {
        output(chalk.yellow('\n暂无会话'))
      } else {
        output(chalk.cyan('\n💬 最近会话:'))
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
          output(`  ${chalk.gray(`[${timeStr}]`)} ${preview}`)
        })
      }
      break
    case '/clear':
      output(chalk.gray('已清屏（帧模式自动重绘）'))
      break
    default:
      output(chalk.yellow(`\n未知命令: ${cmd}。输入 /help 查看可用命令`))
  }
  output('')
  return 'continue'
}

async function runQuery(query: string, maxIterations?: number, attachments?: string[]) {
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

    for await (const chunk of agent.run(query, attachments)) {
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
    .option('-i, --image <path>', '附带图片路径（可与 -q 一起用；也可在问题中直接写路径）')
    .option('-m, --max-iterations <n>', '最大工具调用迭代次数（默认30，上限50）')
    .action(async (options: { query?: string; image?: string; maxIterations?: string }) => {
      if (options.query) {
        const maxIter = options.maxIterations ? parseInt(options.maxIterations, 10) : undefined
        await runQuery(options.query, maxIter, options.image ? [options.image] : undefined)
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
