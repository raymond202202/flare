/**
 * Flare CLI 入口
 * 
 * 用法：
 *   flare              → 交互模式
 *   flare chat -q "xxx" → 单次查询
 *   flare --help       → 帮助
 */

import { Command } from 'commander'
import { Agent, createProvider, getMemoryStore, config, tools, McpManager, estimateMessagesTokens, type AgentConfig, type McpServerStatus } from '../index.js'
import chalk from 'chalk'
import { execSync } from 'child_process'
import { createRequire } from 'module'
import { pathToFileURL } from 'node:url'
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
  // MCP 管理器（v0.5.5）：~/.flare/mcp.json 配置外部 MCP 服务器，/mcp connect 注入工具
  const mcpManager = new McpManager()
  // 主模型：settings main_model（/model 切换）优先，否则默认（.env DEFAULT_MODEL → 自动路由）
  // MCP 工具：已连接的服务器工具并入内置工具集（重建 Agent 时生效）
  const makeAgent = () => {
    const savedModel = store.getSetting('main_model') || undefined
    const mcpTools = mcpManager.getAllTools()
    const cfg: AgentConfig = { sessionId }
    if (savedModel) cfg.llm = createProvider({ model: savedModel })
    if (mcpTools.length > 0) cfg.tools = [...tools, ...mcpTools]
    return new Agent(cfg)
  }
  let agent = makeAgent()
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
  let paused = false     // 动画暂停（便于复制输出；暂停时只重绘输入行不清屏）

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

    // 暂停模式：只重绘输入行（不清屏），屏幕静止可选中复制
    if (paused) {
      const inputRow = CONTENT_ROW + (agentOutput.trim() ? agentOutput.split('\n').length : 0)
      process.stdout.write(`\x1b[${inputRow};1H\x1b[2K` + lineInput.renderLine(breath))
      lineInput.positionCursorAt(inputRow - 1, 0)
      return
    }

    let out = '\x1b[2J\x1b[H'
    out += '\n'                       // 顶部空行（不顶格）
    out += banner + '\n'
    out += '输入 /help 查看命令，/exit 退出\n'
    if (agentRunning) {
      out += agentOutput
    } else {
      // 保留上一轮回答（不随运行结束清掉），输入行在回答下方
      if (agentOutput.trim()) {
        out += agentOutput
      }
      out += lineInput.renderLine(breath)  // prompt 呼吸色
    }
    process.stdout.write(out)
    // 输入模式下光标定位到输入位置（Agent 运行时无输入光标）
    if (!agentRunning) {
      const contentRows = agentOutput.trim() ? agentOutput.split('\n').length : 0
      lineInput.positionCursorAt(CONTENT_ROW + contentRows, 0)
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
    const result = await handleSlashCommand(cmd, store, (s) => { agentOutput += s + '\n' }, () => {
      // /model 切换后重建 Agent（同 sessionId，历史从记忆库恢复），使新模型立即生效
      agent = makeAgent()
      agentOutput += chalk.gray('  （会话已按新模型重建，历史从记忆库恢复）') + '\n'
    }, {
      // /mcp 命令（v0.5.5）：连接/断开外部 MCP 服务器
      list: () => mcpManager.status(),
      connect: async (name) => {
        const mcpTools = await mcpManager.connect(name)
        return `已连接 ${name}（${mcpTools.length} 个 MCP 工具）`
      },
      disconnect: (name) => mcpManager.disconnect(name),
      onChanged: () => {
        // 工具集变化后重建 Agent（同 sessionId，历史从记忆库恢复），使 MCP 工具立即生效
        agent = makeAgent()
        agentOutput += chalk.gray('  （会话已按新工具集重建，历史从记忆库恢复）') + '\n'
      },
    }, () => {
      // /context 命令（v0.5.6）：读取当前 Agent 的上下文占用（public getMessages()，无侵入）
      const msgs = agent.getMessages()
      return { messageCount: msgs.length, estimatedTokens: estimateMessagesTokens(msgs) }
    })
    agentRunning = false
    renderFrame()
    return result
  }

  // ===== 动画暂停/恢复（复制输出用）=====
  const togglePause = () => {
    if (paused) {
      // 恢复
      paused = false
      agentOutput += Y('（动画已恢复，/pause 可再次暂停）') + '\n'
      renderFrame()
      startRenderLoop()
    } else {
      // 暂停：停循环 → 全量渲染一次（含提示）→ 进入静止模式
      stopRenderLoop()
      paused = false
      agentOutput += Y('⏸ 动画已暂停：屏幕静止，可选中复制输出；输入 /resume 恢复') + '\n'
      renderFrame()
      paused = true
    }
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
      // /pause /resume：动画暂停（复制输出用）
      if (input === '/pause' || input === '/resume') {
        togglePause()
        continue
      }
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

/** /mcp 命令回调（CLI 注入真实实现；测试注入 fake） */
export interface McpCommandHooks {
  /** 列出配置的 MCP 服务器状态 */
  list(): McpServerStatus[]
  /** 连接指定服务器，返回摘要（如 \"已连接 xxx（N 个 MCP 工具）\"） */
  connect(name: string): Promise<string>
  /** 断开指定服务器（返回是否真的断开了） */
  disconnect(name: string): boolean
  /** 工具集变化后重建 Agent（使新工具立即生效） */
  onChanged(): void
}

/** /context 命令回调（v0.5.6）：返回当前会话上下文占用；null 表示不可用 */
export type ContextInfoGetter = () => { messageCount: number; estimatedTokens: number } | null

export async function handleSlashCommand(
  cmd: string,
  store: ReturnType<typeof getMemoryStore>,
  output: (s: string) => void = console.log,
  /** /model 切换后回调（宿主/CLI 重建 Agent 使新模型生效） */
  onModelSwitch?: (model: string) => void,
  /** /mcp 命令回调（v0.5.5，外部 MCP 服务器管理） */
  mcp?: McpCommandHooks,
  /** /context 命令回调（v0.5.6，读取当前会话上下文占用） */
  contextInfo?: ContextInfoGetter
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

  // /forget 删除记忆（按内容关键词批量删，v0.5.4 记忆生命周期闭环）
  if (lower === '/forget' || lower.startsWith('/forget ')) {
    const keyword = cmd.replace(/^\/forget(?:\s+|$)/, '').trim()
    if (!keyword) {
      output(chalk.yellow('\n用法: /forget <关键词>（删除包含该关键词的持久记忆）'))
    } else {
      const n = store.deleteMemoriesByContent(keyword)
      output(n > 0
        ? chalk.green(`\n✅ 已删除 ${n} 条记忆（关键词: ${keyword.slice(0, 40)}）`)
        : chalk.yellow(`\n未找到包含「${keyword.slice(0, 40)}」的记忆`))
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

  // /model 切换主模型（本地 Ollama / 远端；持久化 settings main_model，模式同 /vision）
  if (lower === '/model' || lower.startsWith('/model ')) {
    // 裸 /model（无参数）→ 显示当前；/model <name> → 切换；/model default → 回默认
    const arg = cmd.replace(/^\/model(?:\s+|$)/, '').trim()
    const current = store.getSetting('main_model') || config.get('DEFAULT_MODEL') || 'deepseek-chat'
    if (!arg) {
      output(chalk.cyan(`\n🤖 当前主模型: ${current}`))
      output('  /model <模型名> - 切换主模型（本地 Ollama 如 /model qwen2.5:7b | 远端如 /model deepseek-chat）')
      output('  /model default  - 回默认（.env 的 DEFAULT_MODEL）')
    } else if (arg === 'default' || arg === 'reset') {
      store.setSetting('main_model', '')
      onModelSwitch?.('')
      output(chalk.green(`\n✅ 已恢复默认主模型（${config.get('DEFAULT_MODEL') || 'deepseek-chat'}）`))
    } else {
      store.setSetting('main_model', arg)
      onModelSwitch?.(arg)
      const isLocal = arg.includes(':')
      output(chalk.green(`\n✅ 主模型已切换: ${arg}${isLocal ? '（本地 Ollama）' : ''}`))
    }
    return 'continue'
  }

  // /mcp 管理外部 MCP 服务器（v0.5.5）：/mcp 状态 | /mcp connect <name> | /mcp disconnect <name>
  if (lower === '/mcp' || lower.startsWith('/mcp ')) {
    const arg = cmd.replace(/^\/mcp(?:\s+|$)/, '').trim()
    if (!mcp) {
      output(chalk.yellow('\n  MCP 未启用（当前环境未提供 MCP 管理器）'))
      return 'continue'
    }
    const [sub, ...rest] = arg ? arg.split(/\s+/) : []
    if (!sub) {
      const st = mcp.list()
      if (st.length === 0) {
        output(chalk.yellow('\n  未配置 MCP 服务器（~/.flare/mcp.json 的 servers 列表）'))
      } else {
        for (const s of st) {
          const mark = s.connected ? chalk.green('●') : chalk.gray('○')
          const toolsInfo = s.connected ? chalk.gray(`（${s.toolCount} 个工具）`) : ''
          const err = s.error ? chalk.red(` [${s.error}]`) : ''
          output(`  ${mark} ${s.name}${toolsInfo}${err}`)
        }
      }
      output(chalk.gray('\n  /mcp connect <name> 连接 | /mcp disconnect <name> 断开'))
      return 'continue'
    }
    if (sub === 'connect' && rest.length > 0) {
      const name = rest.join(' ')
      try {
        const summary = await mcp.connect(name)
        output(chalk.green(`\n  ✅ ${summary}`))
        mcp.onChanged()
      } catch (e: any) {
        output(chalk.red(`\n  ❌ ${e?.message || e}`))
      }
      return 'continue'
    }
    if (sub === 'disconnect' && rest.length > 0) {
      const name = rest.join(' ')
      const ok = mcp.disconnect(name)
      if (ok) {
        output(chalk.green(`\n  已断开 ${name}`))
        mcp.onChanged()
      } else {
        output(chalk.yellow(`\n  ${name} 未连接`))
      }
      return 'continue'
    }
    output(chalk.yellow('\n  用法: /mcp | /mcp connect <name> | /mcp disconnect <name>'))
    return 'continue'
  }

  // /context 查看当前会话上下文占用（v0.5.6：消息数 + 估算 tokens）
  if (lower === '/context') {
    if (!contextInfo) {
      output(chalk.yellow('\n  上下文不可用（当前环境未提供 Agent 实例）'))
      return 'continue'
    }
    const info = contextInfo()
    if (!info) {
      output(chalk.yellow('\n  上下文不可用'))
      return 'continue'
    }
    output(chalk.cyan('\n📊 当前会话上下文:'))
    output(`  消息数:      ${info.messageCount}`)
    output(`  估算 tokens: ${info.estimatedTokens.toLocaleString()}`)
    output(chalk.gray('  （估算非精确：CJK 1字符≈1 / 英文 4字符≈1；含 system 提示与结构开销）'))
    return 'continue'
  }

  switch (lower) {
    case '/help':
      output(chalk.cyan('\n可用命令:'))
      output('  /help        - 显示帮助')
      output('  /exit        - 退出')
      output('  /memory      - 查看记忆')
      output('  /remember    - 保存一条记忆（如: /remember 用户喜欢浅色主题）')
      output('  /forget      - 删除记忆（如: /forget 浅色主题，删除包含该关键词的记忆）')
      output('  /usage       - 查看 token 用量')
      output('  /context     - 查看当前会话上下文占用（消息数/估算 tokens）')
      output('  /sessions    - 查看会话列表')
      output('  /clear       - 清屏')
      output('  /image       - 显式看图（如: /image ~/Pictures/a.png 这张图里有什么）')
      output('  /vision      - 切换看图模型（/vision 3b 快速 | /vision 7b 质量）')
      output('  /model       - 切换主模型（/model qwen2.5:7b 本地 Ollama | /model deepseek-chat 远端）')
      output('  /mcp         - 查看 MCP 服务器状态（~/.flare/mcp.json 配置）')
      output('  /mcp connect <name> - 连接 MCP 服务器并注入其工具')
      output('  /mcp disconnect <name> - 断开 MCP 服务器')
      output('  /pause       - 暂停动画（屏幕静止，可选中复制输出）')
      output('  /resume      - 恢复动画')
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
  // 单次查询同样尊重 /model 保存的主模型（settings main_model）
  const savedModel = store.getSetting('main_model') || undefined
  const agent = savedModel
    ? new Agent({ sessionId, maxIterations, llm: createProvider({ model: savedModel }) })
    : new Agent({ sessionId, maxIterations })

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

  program
    .command('server')
    .description('宿主协议服务（stdin/stdout JSON Lines，供 Qt 等非 Node 宿主调用，见 docs/host-protocol.md）')
    .option('-p, --profile <path>', 'ExpertProfile JSON 文件路径（可选）')
    .option('-s, --storage <path>', '记忆库路径（默认 ~/.flare-data/）')
    .option('-n, --namespace <name>', '会话命名空间（记忆库隔离）')
    .option('-m, --mcp <path>', 'MCP 服务器配置 JSON 文件路径（可选，v0.5.5；连接外部 MCP 服务器并入工具集）')
    .option('-c, --confirm-tools <names>', '需要用户确认的工具名（逗号分隔；默认 memory_save，传空串关闭确认门，v0.6.1）')
    .option('--confirm-timeout <ms>', '确认超时毫秒（默认 30000；宿主未在时限内回 confirm_result 按拒绝处理，v0.6.1）')
    .action(async (options: { profile?: string; storage?: string; namespace?: string; mcp?: string; confirmTools?: string; confirmTimeout?: string }) => {
      const { startHostServer } = await import('../server.js')
      const fs = await import('fs/promises')
      let profile: Record<string, unknown> = {}
      if (options.profile) {
        profile = JSON.parse(await fs.readFile(options.profile, 'utf-8'))
      }
      // --mcp <config.json>：{ "servers": [{ "name", "command", "args" }] }，连接失败不阻塞服务
      let mcp: unknown[] = []
      if (options.mcp) {
        const raw = JSON.parse(await fs.readFile(options.mcp, 'utf-8'))
        mcp = Array.isArray(raw?.servers) ? raw.servers : []
      }
      // --confirm-tools：逗号分隔名单（默认 memory_save；空串 = 关闭确认门）
      const confirmTools = options.confirmTools !== undefined
        ? options.confirmTools.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined
      startHostServer({
        profile: profile as any,
        storage: options.storage,
        namespace: options.namespace,
        ...(mcp.length > 0 ? { mcp: mcp as any } : {}),
        ...(confirmTools !== undefined ? { confirmTools } : {}),
        ...(options.confirmTimeout ? { confirmTimeoutMs: Number(options.confirmTimeout) } : {}),
      })
    })

  program
    .command('mcp-server')
    .description('MCP stdio 服务器：把 flare 工具集暴露给其他 AI 客户端（v0.5.8，见 docs/mcp.md）')
    .option('-t, --tools <names>', '要暴露的工具（逗号分隔，默认全部内置工具）')
    .action(async (options: { tools?: string }) => {
      const { MCPServer, tools: builtinTools } = await import('../index.js')
      const names = options.tools
        ? options.tools.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined
      const selected = names
        ? builtinTools.filter((t) => names.includes(t.definition.function.name))
        : builtinTools
      // 常驻监听 stdin（MCP 客户端经 stdio 连接），直到 EOF 退出
      const server = new MCPServer({ tools: selected })
      server.start()
      // 保持进程存活：stdin 未关闭前不退出（start 已注册监听；无需额外动作）
    })

  program
    .command('models')
    .description('查看可用模型：配置的主/视觉模型 + 本地 Ollama 已拉取模型（v0.6.0）')
    .action(async () => {
      const { config } = await import('../core/config.js')
      const { resolveProviderOptions } = await import('../core/llm.js')
      const { listOllamaModels, formatModelSize } = await import('../core/models.js')
      const lines: string[] = []

      // 配置的模型（纯本地，无网络）
      lines.push(chalk.cyan('⚙️  配置的模型:'))
      let mainModel = config.get('DEFAULT_MODEL') || 'gpt-4o'
      try {
        // 运行时 /model 切换的模型优先（settings 表）
        const { getMemoryStore } = await import('../memory/store.js')
        const saved = getMemoryStore().getSetting('main_model')
        if (saved) mainModel = saved
      } catch { /* 无全局库（宿主环境）用默认 */ }
      const mainResolved = resolveProviderOptions({ model: mainModel })
      lines.push(`  主模型:   ${chalk.green(mainModel)} → ${mainResolved.baseURL}`)
      const visionModel = config.get('VISION_MODEL') || 'qwen2.5vl:3b'
      const visionResolved = resolveProviderOptions({ model: visionModel })
      lines.push(`  视觉模型: ${chalk.green(visionModel)} → ${visionResolved.baseURL}`)

      // 本地 Ollama 已拉取模型（网络查询；不可达不报错）
      lines.push(chalk.cyan('🤖 本地 Ollama:'))
      const result = await listOllamaModels()
      if (result.ok && result.models.length > 0) {
        for (const m of result.models) {
          lines.push(`  ${chalk.green(m.name)}  ${chalk.gray(formatModelSize(m.size))}`)
        }
      } else if (result.ok) {
        lines.push(chalk.gray('  已连接，但未拉取任何模型（ollama pull <模型名> 下载）'))
      } else {
        lines.push(chalk.gray(`  ${result.error || 'Ollama 不可达'}（可用 /model 切到远端模型）`))
      }
      lines.push(chalk.gray('  提示: /model <模型名> 切换主模型；/vision <模型名> 切换视觉模型'))

      console.log(lines.join('\n'))
    })

  // 默认命令（无参数时进入交互模式）
  program.action(() => {
    startInteractive()
  })

  program.parse(process.argv)
}

// 直接运行入口：仅 CLI 场景执行（bin/flare 包装 / node dist / tsx dev）
// 作为库被 import（测试、宿主应用）时不自动启动 CLI（避免 commander 解析测试进程 argv）
const entry = process.argv[1] || ''
const isCliEntry =
  import.meta.url === pathToFileURL(entry).href ||
  entry.endsWith('bin/flare') ||
  entry.endsWith('cli/index.js') ||
  entry.endsWith('cli/index.ts')
if (isCliEntry) main()
