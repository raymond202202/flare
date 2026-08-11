/**
 * Flare CLI 入口
 * 
 * 用法：
 *   flare              → 交互模式
 *   flare chat -q "xxx" → 单次查询
 *   flare --help       → 帮助
 */

import { Command } from 'commander'
import { Agent, createProvider, getMemoryStore, config, tools, McpManager, estimateMessagesTokens, suggestTrim, ConfirmationGate, memoryStoreKv, wrapConfirmTools, describeTools, validateToolOutputPolicy, type AgentConfig, type McpServerStatus, type ConfirmDecision, type McpResourceRef, type McpResourceTemplateRef, type McpPromptRef, type McpResourceContents, type McpPromptResult, type McpCallResult, type ToolOutputPolicy } from '../index.js'
import chalk from 'chalk'
import { execSync } from 'child_process'
import { createRequire } from 'module'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { LineInput } from './line-input.js'
import { R, O, A, Y, D, createFlameState, updateFlame, renderFlameFrame, flameBreathColor } from './flame-banner.js'

// 从 package.json 读取版本号（不要硬编码，否则 --version 会过期）
const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

async function startInteractive(opts: { contextSummarize?: boolean } = {}) {
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
  // 确认门（v0.6.7）：写回类工具（memory_save）执行前终端内确认——allow_session 会话记忆、
  // always 持久化到全局库 settings 表（跨会话记住），超时安全 deny；/allow 管理放行名单
  // 工具描述（v0.6.27）：确认弹窗说明「AI 想做什么」——内置 + MCP 工具实时查（/mcp connect 后新工具也生效）
  const currentToolDescription = (name: string): string | undefined => {
    for (const t of [...tools, ...mcpManager.getAllTools()]) {
      if (t.definition.function.name === name) return t.definition.function.description || undefined
    }
    return undefined
  }
  const gate = new ConfirmationGate({
    sessionId,
    store: memoryStoreKv(store),
    confirmer: (toolName, args) => terminalConfirmer({
      toolName,
      args,
      description: currentToolDescription(toolName),
      ask: (prompt) => new Promise<string>((resolve) => {
        // 确认期间渲染循环已暂停、回显已恢复：readline 读一行即可
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        rl.question(prompt, (ans) => {
          rl.close()
          resolve(ans.trim().toLowerCase())
        })
      }),
      onPause: () => { stopRenderLoop(); restoreEcho() },
      onResume: () => { disableEcho(); startRenderLoop(); renderFrame() },
      onFeedback: (msg) => { agentOutput += Y(`  ${msg}\n`) },
    }),
  })
  // 主模型：settings main_model（/model 切换）优先，否则默认（.env DEFAULT_MODEL → 自动路由）
  // MCP 工具：已连接的服务器工具并入内置工具集（重建 Agent 时生效）
  const makeAgent = () => {
    const savedModel = store.getSetting('main_model') || undefined
    const mcpTools = mcpManager.getAllTools()
    const cfg: AgentConfig = { sessionId }
    if (savedModel) cfg.llm = createProvider({ model: savedModel })
    // 确认门（v0.6.7）：始终显式传工具集（内置 + MCP）再包装——避免 Agent 回退内置工具绕过确认门
    cfg.tools = wrapConfirmTools([...tools, ...mcpTools], gate, CLI_CONFIRM_TOOLS)
    // 上下文压缩摘要（v0.6.19）：--context-summarize 开启后裁剪把丢弃历史压缩成摘要（AI 保留话题连续性）
    if (opts.contextSummarize) cfg.contextSummarize = true
    return new Agent(cfg)
  }
  let agent = makeAgent()
  const isUnix = process.platform !== 'win32'
  // 终端回显开关（v0.6.7 提升为会话级）：Agent 运行期间关回显，确认弹窗期间临时恢复
  let echoDisabled = false
  const disableEcho = () => {
    if (isUnix && !echoDisabled) {
      try { execSync('stty -echo', { stdio: 'ignore' }); echoDisabled = true } catch { /* 忽略 */ }
    }
  }
  const restoreEcho = () => {
    if (isUnix && echoDisabled) {
      try { execSync('stty echo', { stdio: 'ignore' }); echoDisabled = false } catch { /* 忽略 */ }
    }
  }

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

    let echoWasOff = false
    disableEcho()
    echoWasOff = echoDisabled

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
      if (echoWasOff) restoreEcho()
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
        // v0.6.26：摘要带桥接资源/模板数（资源桥接——连接时已拉取 resources/list + templates/list）
        const resCount = mcpManager.getAllResources().filter((r) => r.server === name).length
        const tmplCount = mcpManager.getAllResourceTemplates().filter((t) => t.server === name).length
        // v0.6.36：摘要带桥接提示词数（prompts 桥接——连接时已拉取 prompts/list）
        const promptCount = mcpManager.getAllPrompts().filter((p) => p.server === name).length
        const extra = resCount || tmplCount || promptCount
          ? ` · ${resCount} 个资源${tmplCount ? ` · ${tmplCount} 个模板` : ''}${promptCount ? ` · ${promptCount} 个提示词` : ''}`
          : ''
        return `已连接 ${name}（${mcpTools.length} 个 MCP 工具${extra}）`
      },
      disconnect: (name) => mcpManager.disconnect(name),
      // v0.6.26：列出已桥接资源/模板（资源桥接——连接时拉取 resources/list + resources/templates/list）
      resources: (name) => ({
        resources: name
          ? mcpManager.getAllResources().filter((r) => r.server === name)
          : mcpManager.getAllResources(),
        templates: name
          ? mcpManager.getAllResourceTemplates().filter((t) => t.server === name)
          : mcpManager.getAllResourceTemplates(),
      }),
      // v0.6.36：列出已桥接提示词（prompts 桥接——连接时拉取 prompts/list）
      prompts: (name) =>
        name
          ? mcpManager.getAllPrompts().filter((p) => p.server === name)
          : mcpManager.getAllPrompts(),
      // v0.6.39：读取已连接服务器资源内容（代理转发 resources/read——与 server 协议 mcp_read_resource 同源）
      readResource: (server, uri) => mcpManager.readResource(server, uri),
      // v0.6.39：渲染已连接服务器提示词（代理转发 prompts/get——与 server 协议 mcp_get_prompt 同源）
      renderPrompt: (server, prompt, args) => mcpManager.getPrompt(server, prompt, args),
      // v0.6.41：调用已连接服务器工具（代理转发 tools/call——与 server 协议 mcp_call 同源）
      callTool: (server, tool, args) => mcpManager.callTool(server, tool, args),
      onChanged: () => {
        // 工具集变化后重建 Agent（同 sessionId，历史从记忆库恢复），使 MCP 工具立即生效
        agent = makeAgent()
        agentOutput += chalk.gray('  （会话已按新工具集重建，历史从记忆库恢复）') + '\n'
      },
    }, () => {
      // /context 命令（v0.5.6）：读取当前 Agent 的上下文占用（public getMessages()，无侵入）
      const msgs = agent.getMessages()
      return { messageCount: msgs.length, estimatedTokens: estimateMessagesTokens(msgs) }
    }, {
      // /allow 命令（v0.6.7；v0.6.10 新增显式放行 + 范围明细）：
      // 确认门放行名单管理（含 always 持久化——isAllowed 逐个查询确认名单）
      list: () => CLI_CONFIRM_TOOLS.filter((t) => gate.isAllowed(t)),
      revoke: (name) => {
        if (gate.isAllowed(name)) {
          gate.revoke(name)
          return true
        }
        return false
      },
      allow: (name, mode) => {
        if (mode === 'always') gate.allowAlways(name)
        else gate.allowSession(name)
        return true
      },
      listDetailed: () => {
        const always = new Set(gate.listAlwaysAllowed(CLI_CONFIRM_TOOLS))
        const session = new Set(gate.listAllowed())
        const names = new Set([...always, ...session])
        return [...names].map((name) => ({
          name,
          scope: (always.has(name) && session.has(name) ? 'both' : always.has(name) ? 'always' : 'session') as 'session' | 'always' | 'both',
        }))
      },
    }, () => {
      // /tools 命令（v0.6.11）：当前 Agent 可用工具清单（内置 + MCP；含确认门标注 + 来源）
      const mcpTools = mcpManager.getAllTools()
      const mcpNames = new Set(mcpTools.map((t) => t.definition.function.name))
      const allTools = [...tools, ...mcpTools]
      return describeTools(allTools, CLI_CONFIRM_TOOLS, { mcp: mcpNames })
    }, sessionId, {
      // /trim 命令（v0.6.46）：suggestTrim 建议 → applyTrim 执行（与 server apply_trim budget
      // 模式同源——保留开头稳定 system 块 + 最近消息 + tool_calls↔tool 配对；store 同步删除被裁消息）
      suggest: () => {
        const msgs = agent.getMessages()
        const budget = (agent as any).config?.maxContextTokens || 16000
        const trim = suggestTrim(msgs, budget, { reserveForOutput: 1024 })
        const before = estimateMessagesTokens(msgs)
        const after = estimateMessagesTokens(trim.keep)
        return {
          droppedCount: msgs.length - trim.keep.length,
          estimatedKeptTokens: after,
          estimatedDroppedTokens: Math.max(0, before - after),
        }
      },
      apply: (budgetTokens) => {
        const msgs = agent.getMessages()
        const budget = budgetTokens || (agent as any).config?.maxContextTokens || 16000
        const trim = suggestTrim(msgs, budget, { reserveForOutput: 1024 })
        return agent.applyTrim(trim.keep.map((m) => msgs.indexOf(m)))
      },
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

/**
 * CLI 交互模式确认名单（v0.6.7）：AI 写回类工具（持久记忆）执行前终端内确认。
 * 与 server 端默认名单（DEFAULT_CONFIRM_TOOLS）一致；allow_session/always 可免打扰。
 */
export const CLI_CONFIRM_TOOLS = ['memory_save']

/** 解析确认输入为决策（v0.6.7）：y/yes→allow_once，s/session→allow_session，a/always→always；其余（含 n/空/未知）→deny（安全默认） */
export function parseConfirmAnswer(ans: string): ConfirmDecision {
  switch ((ans || '').trim().toLowerCase()) {
    case 'y':
    case 'yes':
    case 'allow':
    case 'allow_once':
      return 'allow_once'
    case 's':
    case 'session':
    case 'allow_session':
      return 'allow_session'
    case 'a':
    case 'always':
      return 'always'
    default:
      return 'deny'
  }
}

/** 确认 UI 文案（v0.6.7）：工具名 + 参数摘要（JSON 截断 120 字符）；v0.6.27 可选带工具描述（说明行，截断 80 字符） */
export function formatConfirmPrompt(toolName: string, args: Record<string, any>, description?: string): string {
  const raw = args && Object.keys(args).length > 0 ? JSON.stringify(args) : ''
  const summary = raw ? raw.slice(0, 120) + (raw.length > 120 ? '…' : '') : ''
  const head = `⚠️ AI 想调用「${toolName}」${summary ? `（${summary}）` : ''}`
  const desc = description
    ? `  说明: ${description.slice(0, 80)}${description.length > 80 ? '…' : ''}`
    : ''
  return [
    `\n${head}`,
    ...(desc ? [desc] : []),
    '  [y] 允许一次    [s] 本次会话允许    [a] 总是允许    [n] 拒绝（默认）',
    '  你的选择 [y/s/a/n]: ',
  ].join('\n')
}

/** 决策反馈文案（确认后追加到输出区，用户能看到结果） */
function confirmFeedbackText(decision: ConfirmDecision): string {
  switch (decision) {
    case 'allow_once': return '已允许本次执行'
    case 'allow_session': return '已放行（本次会话内不再确认）'
    case 'always': return '已永久放行（跨会话记住；/allow revoke 可撤销）'
    case 'alternative': return '已要求替代方案'
    default: return '已拒绝'
  }
}

/** 终端确认器选项（v0.6.7） */
export interface TerminalConfirmOptions {
  toolName: string
  args: Record<string, any>
  /** 工具描述（v0.6.27）：确认弹窗说明行「AI 想做什么」；无描述不显示 */
  description?: string
  /** 读行实现（CLI 用 readline question；测试注入 fake） */
  ask: (prompt: string) => Promise<string>
  /** 确认前回调（暂停动画渲染、恢复终端回显） */
  onPause?: () => void
  /** 确认后回调（恢复动画渲染、关闭回显） */
  onResume?: () => void
  /** 反馈回调（向输出区追加一行确认结果） */
  onFeedback?: (message: string) => void
}

/**
 * 终端内确认流程（v0.6.7，可测）：显示确认 UI → ask 读一行 → 解析决策。
 * - 暂停/恢复回调包裹确认期间（避免常驻动画重绘干扰输入）
 * - ask 抛错按 deny（安全默认）处理
 */
export async function terminalConfirmer(opts: TerminalConfirmOptions): Promise<ConfirmDecision> {
  opts.onPause?.()
  try {
    const answer = await opts.ask(formatConfirmPrompt(opts.toolName, opts.args, opts.description))
    const decision = parseConfirmAnswer(answer)
    opts.onFeedback?.(`⚠️ 工具「${opts.toolName}」${confirmFeedbackText(decision)}`)
    return decision
  } catch {
    opts.onFeedback?.(`⚠️ 工具「${opts.toolName}」确认输入异常，已按拒绝处理`)
    return 'deny'
  } finally {
    opts.onResume?.()
  }
}

/** /allow 命令回调（v0.6.7 起；v0.6.10 新增 allow/listDetailed）：确认门放行名单管理 */
export interface AllowGateHooks {
  /** 列出确认名单内当前被放行的工具（含 always 持久化） */
  list(): string[]
  /** 撤销放行（返回是否确实撤销了） */
  revoke(name: string): boolean
  /** 显式放行（v0.6.10）：mode=session 本会话内放行 / always 跨会话持久化放行；返回是否成功 */
  allow?(name: string, mode: 'session' | 'always'): boolean
  /** 放行明细（v0.6.10）：每个放行工具的生效范围（会话级/持久化/两者）；未提供则回退 list() */
  listDetailed?(): { name: string; scope: 'session' | 'always' | 'both' }[]
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
  /** 列出已桥接资源/模板（v0.6.26）：name 缺省返回全部已连接服务器；未提供回退旧行为（提示不可用） */
  resources?(name?: string): McpResourceListing
  /** 列出已桥接提示词（v0.6.36）：name 缺省返回全部已连接服务器；未提供回退旧行为（提示不可用） */
  prompts?(name?: string): McpPromptRef[]
  /** 读取已连接服务器资源内容（v0.6.39）：代理转发 resources/read；未提供回退提示不可用 */
  readResource?(server: string, uri: string): Promise<McpResourceContents[]>
  /** 渲染已连接服务器提示词（v0.6.39）：代理转发 prompts/get；未提供回退提示不可用 */
  renderPrompt?(server: string, prompt: string, args?: Record<string, string>): Promise<McpPromptResult>
  /** 调用已连接服务器工具（v0.6.41）：代理转发 tools/call；未提供回退提示不可用 */
  callTool?(server: string, tool: string, args?: Record<string, any>): Promise<McpCallResult>
}

/** /mcp resources 返回的资源/模板清单（v0.6.26） */
export interface McpResourceListing {
  resources: McpResourceRef[]
  templates: McpResourceTemplateRef[]
}

/** /context 命令回调（v0.5.6）：返回当前会话上下文占用；null 表示不可用 */
export type ContextInfoGetter = () => { messageCount: number; estimatedTokens: number } | null

/** /trim 命令回调（v0.6.46）：suggestTrim 建议 → applyTrim 执行（与 server apply_trim budget 模式同源） */
export interface ContextTrimHooks {
  /** 智能裁剪建议（system 保底 + 最近优先 + tool_calls↔tool 配对保护）；null 表示不可用 */
  suggest(): { droppedCount: number; estimatedKeptTokens: number; estimatedDroppedTokens: number } | null
  /** 执行裁剪（budgetTokens 缺省用当前配置默认预算）；null 表示不可用 */
  apply(budgetTokens?: number): { keptCount: number; droppedCount: number } | null
}

/** /tools 命令回调（v0.6.11）：返回当前 Agent 可用工具清单元数据；null 表示不可用 */
export type ToolsInfoGetter = () => import('../index.js').ToolMeta[] | null

/** 会话时间友好显示（v0.6.32，/archived 等用）：今天 HH:MM / 昨天 / M月D日；解析失败回退原始字符串 */
function formatSessionTime(updatedAt: string, now = new Date()): string {
  try {
    const d = new Date(updatedAt.replace(' ', 'T'))
    const isToday = d.toDateString() === now.toDateString()
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    const isYesterday = d.toDateString() === yesterday.toDateString()
    if (isToday) return d.toTimeString().slice(0, 5)
    if (isYesterday) return '昨天'
    return `${d.getMonth() + 1}月${d.getDate()}日`
  } catch {
    return updatedAt
  }
}

export async function handleSlashCommand(
  cmd: string,
  store: ReturnType<typeof getMemoryStore>,
  output: (s: string) => void = console.log,
  /** /model 切换后回调（宿主/CLI 重建 Agent 使新模型生效） */
  onModelSwitch?: (model: string) => void,
  /** /mcp 命令回调（v0.5.5，外部 MCP 服务器管理） */
  mcp?: McpCommandHooks,
  /** /context 命令回调（v0.5.6，读取当前会话上下文占用） */
  contextInfo?: ContextInfoGetter,
  /** /allow 命令回调（v0.6.7，确认门放行名单管理） */
  allowGate?: AllowGateHooks,
  /** /tools 命令回调（v0.6.11，当前 Agent 可用工具清单） */
  toolsInfo?: ToolsInfoGetter,
  /** 当前会话 id（v0.6.17，/usage 显示本会话用量；缺省不显示） */
  sessionId?: string,
  /** /trim 命令回调（v0.6.46，智能裁剪上下文） */
  contextTrim?: ContextTrimHooks
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
    // 裸 /model（无参数）→ 显示当前；/model <name> → 切换；/model default → 回默认；/model list → 列出本地 Ollama 模型
    const arg = cmd.replace(/^\/model(?:\s+|$)/, '').trim()
    const current = store.getSetting('main_model') || config.get('DEFAULT_MODEL') || 'deepseek-chat'
    if (!arg) {
      output(chalk.cyan(`\n🤖 当前主模型: ${current}`))
      output('  /model <模型名> - 切换主模型（本地 Ollama 如 /model qwen2.5:7b | 远端如 /model deepseek-chat）')
      output('  /model list    - 查看本地 Ollama 可用模型')
      output('  /model default - 回默认（.env 的 DEFAULT_MODEL）')
    } else if (arg === 'list') {
      // /model list 列出本地 Ollama 可用模型（v0.6.9）：Ollama 不可达友好提示，不崩
      const { listOllamaModels, formatModelSize } = await import('../core/models.js')
      const r = await listOllamaModels()
      if (r.ok && r.models.length > 0) {
        output(chalk.cyan(`\n🤖 当前主模型: ${current}`))
        output(chalk.gray('  本地 Ollama 可用模型:'))
        for (const m of r.models) {
          const isCur = m.name === current
          output(`  ${isCur ? chalk.green('●') : chalk.gray('○')} ${m.name}${isCur ? chalk.gray('（当前）') : ''}  ${chalk.gray(formatModelSize(m.size))}`)
        }
        output(chalk.gray('  /model <模型名> 切换；远端模型（如 deepseek-chat）不在此列'))
      } else {
        output(chalk.yellow(`\n  ${r.error || 'Ollama 已连接但未拉取模型'}`))
        output(chalk.gray('  提示: /model <模型名> 切到远端模型（如 deepseek-chat）'))
      }
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
          const toolsInfo = s.connected ? chalk.gray(`（${s.toolCount} 个工具`) : ''
          // v0.6.26：已连接时显示桥接的资源/模板数（外部 MCP 服务器资源真实暴露）
          const resInfo = s.connected ? chalk.gray(`${s.resourceCount ? ` · ${s.resourceCount} 资源` : ''}${s.templateCount ? ` · ${s.templateCount} 模板` : ''}`) : ''
          // v0.6.36：已连接时显示桥接的提示词数（外部 MCP 服务器提示词真实暴露）
          const promptInfo = s.connected ? chalk.gray(`${s.promptCount ? ` · ${s.promptCount} 提示词` : ''}`) : ''
          const closeParen = s.connected ? chalk.gray('）') : ''
          // v0.6.50：传输类型 + 目标端点/命令（stdio/HTTP 区分 + 连接目标直接可见）
          const transportTag = chalk.gray(`[${s.transport === 'http' ? 'HTTP' : 'stdio'}]`)
          const targetInfo = s.target ? chalk.gray(` ${s.target}`) : ''
          const err = s.error ? chalk.red(` [${s.error}]`) : ''
          output(`  ${mark} ${s.name} ${transportTag}${toolsInfo}${resInfo}${promptInfo}${closeParen}${targetInfo}${err}`)
        }
      }
      output(chalk.gray('\n  /mcp resources [name] 查看资源 | /mcp prompts [name] 查看提示词 | /mcp connect <name> 连接 | /mcp disconnect <name> 断开'))
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
    // /mcp resources [name]（v0.6.26）：列出已桥接资源/模板（资源桥接——外部服务器暴露的资源真实可见）
    if (sub === 'resources') {
      if (typeof mcp.resources !== 'function') {
        output(chalk.yellow('\n  当前环境未提供资源桥接（MCP 管理器不支持资源拉取）'))
        return 'continue'
      }
      const name = rest.join(' ').trim() || undefined
      const { resources, templates } = mcp.resources(name)
      const scope = name ? `「${name}」` : '全部已连接服务器'
      if (resources.length === 0 && templates.length === 0) {
        output(chalk.yellow(`\n  ${scope} 无已桥接资源（服务器未暴露 resources 或未连接）`))
      } else {
        if (resources.length > 0) {
          output(chalk.gray(`\n  ${scope} 的资源（${resources.length}）：`))
          for (const r of resources) {
            const desc = r.description ? chalk.gray(` — ${r.description}`) : ''
            output(`    📄 ${chalk.cyan(r.uri)}${desc}`)
          }
        }
        if (templates.length > 0) {
          output(chalk.gray(`\n  ${scope} 的资源模板（${templates.length}）：`))
          for (const t of templates) {
            const desc = t.description ? chalk.gray(` — ${t.description}`) : ''
            output(`    🧩 ${chalk.cyan(t.uriTemplate)}${desc}`)
          }
        }
      }
      output(chalk.gray('\n  /mcp resources [name] 查看资源 | /mcp prompts [name] 查看提示词 | /mcp connect <name> 连接'))
      return 'continue'
    }
    // /mcp prompts [name]（v0.6.36）：列出已桥接提示词（prompts 桥接——外部服务器暴露的提示词真实可见）
    if (sub === 'prompts') {
      if (typeof mcp.prompts !== 'function') {
        output(chalk.yellow('\n  当前环境未提供提示词桥接（MCP 管理器不支持提示词拉取）'))
        return 'continue'
      }
      const name = rest.join(' ').trim() || undefined
      const prompts = mcp.prompts(name)
      const scope = name ? `「${name}」` : '全部已连接服务器'
      if (prompts.length === 0) {
        output(chalk.yellow(`\n  ${scope} 无已桥接提示词（服务器未暴露 prompts 或未连接）`))
      } else {
        output(chalk.gray(`\n  ${scope} 的提示词（${prompts.length}）：`))
        for (const p of prompts) {
          const args = Array.isArray(p.arguments) && p.arguments.length > 0
            ? chalk.gray(`（参数: ${p.arguments.map(a => a.name).join(', ')}）`)
            : ''
          const desc = p.description ? chalk.gray(` — ${p.description}`) : ''
          output(`    ✨ ${chalk.cyan(p.name)}${args}${desc}`)
        }
      }
      output(chalk.gray('\n  /mcp prompts [name] 查看提示词 | /mcp resources [name] 查看资源 | /mcp connect <name> 连接'))
      return 'continue'
    }
    // /mcp read <server> <uri>（v0.6.39）：读取已连接服务器资源内容（与 server 协议 mcp_read_resource 对称）
    if (sub === 'read' && rest.length >= 2) {
      if (typeof mcp.readResource !== 'function') {
        output(chalk.yellow('\n  当前环境未提供资源读取（MCP 管理器不支持 readResource）'))
        return 'continue'
      }
      const server = rest[0]
      const uri = rest.slice(1).join(' ')
      try {
        const contents = await mcp.readResource(server, uri)
        if (contents.length === 0) {
          output(chalk.yellow(`\n  ${server} 的资源 ${chalk.cyan(uri)} 无内容`))
        } else {
          output(chalk.gray(`\n  ${server} 的资源 ${chalk.cyan(uri)}（${contents.length} 项）：`))
          for (const c of contents) {
            const mime = c.mimeType ? chalk.gray(` [${c.mimeType}]`) : ''
            output(`    📄 ${chalk.cyan(c.uri)}${mime}`)
            output(`      ${c.text}`)
          }
        }
      } catch (e: any) {
        output(chalk.red(`\n  ❌ ${e?.message || e}`))
      }
      return 'continue'
    }
    // /mcp render <server> <prompt> [arg=value ...]（v0.6.39）：渲染已连接服务器提示词（与 server 协议 mcp_get_prompt 对称）
    if (sub === 'render' && rest.length >= 2) {
      if (typeof mcp.renderPrompt !== 'function') {
        output(chalk.yellow('\n  当前环境未提供提示词渲染（MCP 管理器不支持 renderPrompt）'))
        return 'continue'
      }
      const server = rest[0]
      const prompt = rest[1]
      const args: Record<string, string> = {}
      for (const kv of rest.slice(2)) {
        const eq = kv.indexOf('=')
        if (eq > 0) args[kv.slice(0, eq)] = kv.slice(eq + 1)
      }
      try {
        const result = await mcp.renderPrompt(server, prompt, Object.keys(args).length > 0 ? args : undefined)
        const desc = result.description ? chalk.gray(` — ${result.description}`) : ''
        output(chalk.gray(`\n  ${server} 的提示词 ${chalk.cyan(prompt)}${desc}：`))
        for (const m of result.messages) {
          const text = m.content && typeof m.content === 'object' && 'text' in m.content
            ? (m.content as { text: string }).text
            : JSON.stringify(m.content)
          output(`    💬 ${chalk.gray(m.role)}: ${text}`)
        }
      } catch (e: any) {
        output(chalk.red(`\n  ❌ ${e?.message || e}`))
      }
      return 'continue'
    }
    // /mcp call <server> <tool> [JSON参数]（v0.6.41）：调用已连接服务器工具（与 server 协议 mcp_call 对称）
    if (sub === 'call' && rest.length >= 2) {
      if (typeof mcp.callTool !== 'function') {
        output(chalk.yellow('\n  当前环境未提供工具调用（MCP 管理器不支持 callTool）'))
        return 'continue'
      }
      const server = rest[0]
      const tool = rest[1]
      const rawArgs = rest.slice(2).join(' ')
      let args: Record<string, any> | undefined
      if (rawArgs) {
        try {
          args = JSON.parse(rawArgs)
          if (args === null || typeof args !== 'object' || Array.isArray(args)) {
            throw new Error('参数必须是 JSON 对象')
          }
        } catch (e: any) {
          output(chalk.yellow(`\n  工具参数不是合法 JSON 对象: ${e?.message || e}（如 {"a":2,"b":3}）`))
          return 'continue'
        }
      }
      try {
        const res = await mcp.callTool(server, tool, args)
        const text = Array.isArray(res.content)
          ? res.content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n')
          : ''
        if (res.isError) {
          output(chalk.red(`\n  ❌ ${server} 的工具 ${chalk.cyan(tool)} 执行失败: ${text || '（无错误信息）'}`))
        } else {
          output(chalk.gray(`\n  ${server} 的工具 ${chalk.cyan(tool)} 返回：`))
          output(`    ${text || '（无文本输出）'}`)
        }
      } catch (e: any) {
        output(chalk.red(`\n  ❌ ${e?.message || e}`))
      }
      return 'continue'
    }
    output(chalk.yellow('\n  用法: /mcp | /mcp resources [name] | /mcp prompts [name] | /mcp read <server> <uri> | /mcp render <server> <prompt> [k=v ...] | /mcp call <server> <tool> [JSON参数] | /mcp connect <name> | /mcp disconnect <name>'))
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
    // v0.6.46：超出预算时给出智能裁剪建议（/trim 一键执行，保留稳定前缀与最近消息）
    const trimHint = contextTrim?.suggest?.()
    if (trimHint && trimHint.droppedCount > 0) {
      output(chalk.yellow(`  💡 可裁剪: 建议删 ${trimHint.droppedCount} 条消息（约 ${trimHint.estimatedDroppedTokens.toLocaleString()} tokens）——/trim 执行智能裁剪`))
    }
    return 'continue'
  }

  // /trim [budgetTokens] 智能裁剪上下文（v0.6.46：suggestTrim 建议 → applyTrim 执行——
  // 保留开头稳定 system 块 + 最近消息 + tool_calls↔tool 配对；与 server apply_trim budget 模式同源）
  if (lower === '/trim' || lower.startsWith('/trim ')) {
    if (!contextTrim) {
      output(chalk.yellow('\n  裁剪不可用（当前环境未提供 Agent 实例）'))
      return 'continue'
    }
    let budget: number | undefined
    const arg = cmd.replace(/^\/trim\s*/, '').trim()
    if (arg) {
      budget = Number(arg)
      if (!Number.isInteger(budget) || budget <= 0) {
        output(chalk.yellow('\n  用法: /trim [budgetTokens]（正整数上下文 token 预算；缺省用当前配置默认）'))
        return 'continue'
      }
    }
    const result = contextTrim.apply(budget)
    if (!result) {
      output(chalk.yellow('\n  裁剪不可用（当前环境未提供 Agent 实例）'))
      return 'continue'
    }
    if (result.droppedCount > 0) {
      output(chalk.green(`\n✅ 已智能裁剪: 保留 ${result.keptCount} 条，删除 ${result.droppedCount} 条（稳定前缀与最近消息保留）`))
    } else {
      output(chalk.gray('\n上下文无需裁剪（预算内）'))
    }
    return 'continue'
  }

  // /allow 确认门放行名单管理（v0.6.7；v0.6.10 新增 /allow add 显式放行 + 明细范围标注）：
  // /allow 列出已放行（含范围标注）| /allow add <工具名> [session|always] 显式放行 | /allow revoke <工具名> 撤销
  if (lower === '/allow' || lower.startsWith('/allow ')) {
    if (!allowGate) {
      output(chalk.yellow('\n  确认门未启用（当前环境未提供确认门）'))
      return 'continue'
    }
    const arg = cmd.replace(/^\/allow(?:\s+|$)/, '').trim()
    const [sub, ...rest] = arg ? arg.split(/\s+/) : []
    if (!sub) {
      const scopeLabel = (s: 'session' | 'always' | 'both') =>
        s === 'both' ? '（会话+持久化）' : s === 'always' ? '（跨会话持久化）' : '（本会话）'
      const detailed = allowGate.listDetailed?.() ?? null
      const allowed = detailed ?? allowGate.list().map((n) => ({ name: n, scope: null as 'session' | 'always' | 'both' | null }))
      if (allowed.length === 0) {
        output(chalk.gray('\n  当前没有已放行的确认工具（AI 写回类工具每次都会请求确认）'))
      } else {
        output(chalk.cyan('\n✅ 已放行的确认工具:'))
        for (const { name, scope } of allowed) {
          output(`  ${chalk.green(name)}${scope ? chalk.gray(scopeLabel(scope)) : ''}`)
        }
      }
      output(chalk.gray('  /allow add <工具名> [session|always] - 显式放行（默认本会话）'))
      output(chalk.gray('  /allow revoke <工具名> - 撤销放行（恢复每次确认）'))
      return 'continue'
    }
    if (sub === 'revoke' && rest.length > 0) {
      const name = rest.join(' ')
      const ok = allowGate.revoke(name)
      output(ok
        ? chalk.green(`\n  已撤销 ${name} 的放行（恢复每次确认）`)
        : chalk.yellow(`\n  ${name} 未被放行`))
      return 'continue'
    }
    if (sub === 'add') {
      if (rest.length === 0) {
        output(chalk.yellow('\n  用法: /allow add <工具名> [session|always]（默认 session 本会话放行；always 跨会话持久化）'))
        return 'continue'
      }
      const name = rest[0]
      const mode = (rest[1] ?? 'session').toLowerCase()
      if (mode !== 'session' && mode !== 'always') {
        output(chalk.yellow(`\n  非法模式「${rest[1]}」：仅支持 session（本会话）或 always（跨会话持久化）`))
        return 'continue'
      }
      if (!allowGate.allow) {
        output(chalk.yellow('\n  当前环境不支持显式放行（未提供 allow 回调）'))
        return 'continue'
      }
      const ok = allowGate.allow(name, mode)
      output(ok
        ? chalk.green(`\n  已放行 ${name}（${mode === 'always' ? '跨会话持久化' : '本会话内不再确认'}）`)
        : chalk.yellow(`\n  放行 ${name} 失败`))
      return 'continue'
    }
    output(chalk.yellow('\n  用法: /allow | /allow add <工具名> [session|always] | /allow revoke <工具名>'))
    return 'continue'
  }

  // /tools 查看当前 Agent 可用工具清单（v0.6.11：名称/描述/来源 + 确认门标注）
  if (lower === '/tools') {
    if (!toolsInfo) {
      output(chalk.yellow('\n  工具清单不可用（当前环境未提供 Agent 工具集）'))
      return 'continue'
    }
    const metas = toolsInfo()
    if (!metas || metas.length === 0) {
      output(chalk.yellow('\n  当前没有可用工具'))
      return 'continue'
    }
    const sourceLabel = (s: string) => (s === 'host' ? '宿主' : s === 'profile' ? '专家' : s === 'mcp' ? 'MCP' : '内置')
    output(chalk.cyan(`\n🔧 当前可用工具（${metas.length}）:`))
    for (const t of metas) {
      const flag = t.confirmed ? chalk.yellow(' ⚠需确认') : ''
      output(`  ${chalk.green(t.name)}${flag} ${chalk.gray(`· ${sourceLabel(t.source)}`)}`)
      if (t.description) output(`    ${chalk.gray(t.description)}`)
    }
    output(chalk.gray('  ⚠需确认 = 写回类工具，执行前会弹窗确认（/allow 管理放行）'))
    return 'continue'
  }

  // /search <关键词> 跨会话全文搜索历史对话（v0.6.24：FTS5 trigram，中文友好，找回旧对话）
  if (lower === '/search' || lower.startsWith('/search ')) {
    const kw = cmd.replace(/^\/search(?:\s+|$)/, '').trim()
    if (!kw) {
      output(chalk.yellow('\n  用法: /search <关键词>（跨会话搜索历史对话）'))
      return 'continue'
    }
    const hits = store.searchMessages(kw, 10)
    if (hits.length === 0) {
      output(chalk.gray(`\n未找到包含「${kw}」的历史消息`))
    } else {
      output(chalk.cyan(`\n🔍 「${kw}」相关消息（${hits.length} 条）:`))
      hits.forEach(h => {
        const who = h.role === 'user' ? '你' : h.role === 'assistant' ? 'AI' : h.role
        output(`  ${chalk.gray(`[${h.createdAt || ''}]`)} ${who}: ${h.content.replace(/\s+/g, ' ').trim().slice(0, 100)}`)
      })
    }
    return 'continue'
  }

  // /memory 列出全部记忆；/memory <关键词> 全文搜索记忆（v0.6.25：与 /search 对称，FTS5 中文友好）
  if (lower === '/memory' || lower.startsWith('/memory ')) {
    const kw = cmd.replace(/^\/memory(?:\s+|$)/, '').trim()
    const memories = kw
      ? store.searchMemories(kw, 10)
      : store.getAllMemories()
    if (memories.length === 0) {
      output(kw
        ? chalk.gray(`\n未找到包含「${kw}」的记忆`)
        : chalk.yellow('\n暂无记忆'))
    } else {
      output(kw
        ? chalk.cyan(`\n🔍 记忆「${kw}」相关（${memories.length} 条）:`)
        : chalk.cyan('\n📝 记忆列表:'))
      memories.forEach(m => {
        output(`  ${chalk.gray(`[${m.created_at}]`)} ${m.content.slice(0, 80)}`)
      })
    }
    return 'continue'
  }

  // 会话归档（v0.6.32）：/archived 查看归档会话、/archive [id] 归档、/restore [id] 恢复
  // ——CLI 端接线 v0.6.31 归档 API（archiveSession/restoreSession/listArchivedSessions），
  // 与 server 协议 end_session/restore_session/list_archived_sessions 对称；数据保留可恢复
  if (lower === '/archived') {
    const archived = store.listArchivedSessions()
    if (archived.length === 0) {
      output(chalk.gray('\n🗄️ 暂无归档会话（/archive 可归档当前会话）'))
    } else {
      output(chalk.cyan(`\n🗄️ 已归档会话（${archived.length} 个）:`))
      archived.forEach(s => {
        const msg = (s as any).first_user_msg || '（空会话）'
        const preview = msg.replace(/\s+/g, ' ').trim().slice(0, 30)
        output(`  ${chalk.gray(`[${formatSessionTime(s.updated_at)}]`)} ${preview} ${chalk.gray(`(${s.id})`)}`)
      })
      output(chalk.gray('  提示: /restore <会话ID> 恢复会话'))
    }
    return 'continue'
  }
  if (lower === '/archive' || lower.startsWith('/archive ')) {
    const target = cmd.replace(/^\/archive(?:\s+|$)/, '').trim()
    const sid = target || sessionId
    if (!sid) {
      output(chalk.yellow('\n用法: /archive [会话ID]（缺省归档当前会话；数据保留，/archived 可查看、/restore 恢复）'))
    } else if (store.archiveSession(sid)) {
      output(chalk.green(`\n🗄️ 已归档会话: ${sid}（数据保留，/archived 可查看、/restore 恢复）`))
    } else {
      output(chalk.yellow(`\n未归档: ${sid}（会话不存在或已归档）`))
    }
    return 'continue'
  }
  if (lower === '/restore' || lower.startsWith('/restore ')) {
    const target = cmd.replace(/^\/restore(?:\s+|$)/, '').trim()
    if (!target) {
      const archived = store.listArchivedSessions()
      if (archived.length === 0) {
        output(chalk.yellow('\n用法: /restore <会话ID>（恢复归档会话；当前无归档会话）'))
      } else {
        output(chalk.cyan('\n🗄️ 归档会话（/restore <会话ID> 可恢复）:'))
        archived.forEach(s => {
          const msg = (s as any).first_user_msg || '（空会话）'
          const preview = msg.replace(/\s+/g, ' ').trim().slice(0, 30)
          output(`  ${chalk.gray(`[${formatSessionTime(s.updated_at)}]`)} ${preview} ${chalk.gray(`(${s.id})`)}`)
        })
      }
    } else if (store.restoreSession(target)) {
      output(chalk.green(`\n✅ 已恢复会话: ${target}（重新出现在最近会话）`))
    } else {
      output(chalk.yellow(`\n未恢复: ${target}（会话不存在或未归档）`))
    }
    return 'continue'
  }

  // /sessions <关键词> 按标题/消息内容搜索会话（v0.6.44：与 server search_sessions 对称——
  // store.searchSessions LIKE 匹配标题或会话内任意消息内容，找回「聊过什么但忘了哪个会话」）
  if (lower.startsWith('/sessions ')) {
    const kw = cmd.replace(/^\/sessions\s+/, '').trim()
    if (!kw) {
      output(chalk.yellow('\n用法: /sessions <关键词>（搜索标题或消息内容含关键词的会话）'))
      return 'continue'
    }
    const hits = store.searchSessions(kw, 20)
    if (hits.length === 0) {
      output(chalk.gray(`\n未找到包含「${kw}」的会话（标题或消息内容）`))
    } else {
      output(chalk.cyan(`\n💬 搜索会话「${kw}」（${hits.length} 个，按更新时间倒序）:`))
      hits.forEach(s => {
        const arch = s.archived ? chalk.gray('（已归档）') : ''
        output(`  ${chalk.gray(`[${formatSessionTime(s.updatedAt)}]`)} ${s.title}${arch} ${chalk.gray(`(${s.messageCount} 条消息)`)}`)
      })
    }
    return 'continue'
  }

  switch (lower) {
    case '/help':
      output(chalk.cyan('\n可用命令:'))
      output('  /help        - 显示帮助')
      output('  /exit        - 退出')
      output('  /memory [关键词] - 查看记忆；带关键词全文搜索记忆（v0.6.25）')
      output('  /search <关键词> - 搜索历史对话（跨会话，v0.6.24）')
      output('  /remember    - 保存一条记忆（如: /remember 用户喜欢浅色主题）')
      output('  /forget      - 删除记忆（如: /forget 浅色主题，删除包含该关键词的记忆）')
      output('  /usage       - 查看 token 用量')
      output('  /context     - 查看当前会话上下文占用（消息数/估算 tokens；超预算提示 /trim）')
      output('  /trim [预算tokens] - 智能裁剪上下文（v0.6.46，保留稳定前缀与最近消息）')
      output('  /sessions    - 查看会话列表；带关键词搜索会话（如: /sessions 缓存，v0.6.44）')
      output('  /archived    - 查看归档会话（v0.6.32，/archive 归档的会话）')
      output('  /archive [会话ID] - 归档会话（缺省当前会话；数据保留，/restore 可恢复）')
      output('  /restore <会话ID> - 恢复归档会话')
      output('  /clear       - 清屏')
      output('  /image       - 显式看图（如: /image ~/Pictures/a.png 这张图里有什么）')
      output('  /vision      - 切换看图模型（/vision 3b 快速 | /vision 7b 质量）')
      output('  /model       - 切换主模型（/model qwen2.5:7b 本地 Ollama | /model deepseek-chat 远端）')
      output('  /model list  - 查看本地 Ollama 可用模型（v0.6.9）')
      output('  /mcp         - 查看 MCP 服务器状态（~/.flare/mcp.json 配置）')
      output('  /mcp resources [name] - 查看已桥接资源/模板（v0.6.26，外部 MCP 服务器暴露的资源）')
      output('  /mcp prompts [name] - 查看已桥接提示词（v0.6.36，外部 MCP 服务器暴露的提示词）')
      output('  /mcp read <server> <uri> - 读取外部 MCP 资源内容（v0.6.39，resources/read 代理）')
      output('  /mcp render <server> <prompt> [k=v ...] - 渲染外部 MCP 提示词（v0.6.39，prompts/get 代理）')
      output('  /mcp call <server> <tool> [JSON参数] - 调用外部 MCP 工具（v0.6.41，tools/call 代理）')
      output('  /mcp connect <name> - 连接 MCP 服务器并注入其工具')
      output('  /mcp disconnect <name> - 断开 MCP 服务器')
      output('  /allow     - 查看已放行的确认工具（AI 写回类工具执行前会请求确认）')
      output('  /allow add <工具名> [session|always] - 显式放行（默认本会话；always 跨会话持久化）')
      output('  /allow revoke <工具名> - 撤销放行（恢复每次确认）')
      output('  /tools     - 查看当前可用工具清单（含确认门标注与来源，v0.6.11）')
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
        // P0（v0.6.29）：缓存命中率 + 估算成本（宿主引导连续执行）
        const cacheRead = usage.cacheReadTokens || 0
        if (cacheRead > 0) {
          const hitRate = usage.promptTokens > 0 ? Math.round((cacheRead / usage.promptTokens) * 100) : 0
          output(`  ${chalk.gray('缓存命中:')}   ${cacheRead.toLocaleString()} tokens（${hitRate}%）`)
        }
        if (typeof usage.estimatedCostUsd === 'number' && usage.estimatedCostUsd > 0) {
          output(`  ${chalk.gray('估算成本:')}   $${usage.estimatedCostUsd.toFixed(4)}`)
        }
        // 按模型分解（v0.6.18：getUsageStats.perModel——用量分布/成本核算；v0.6.42：显示缓存命中）
        if (Array.isArray(usage.perModel) && usage.perModel.length > 0) {
          for (const m of usage.perModel) {
            output(`  ${chalk.gray(`模型 ${m.model}:`)} ${m.totalTokens.toLocaleString()} tokens（${m.calls} 次调用）`)
            const mCache = m.cacheReadTokens || 0
            if (mCache > 0) {
              const mRate = m.promptTokens > 0 ? Math.round((mCache / m.promptTokens) * 100) : 0
              output(`    ${chalk.gray('缓存命中:')} ${mCache.toLocaleString()} tokens（${mRate}%）`)
            }
          }
        }
        // 当前会话用量（v0.6.17：getSessionUsage 按 session 过滤；未提供 sessionId 不显示）
        // v0.6.49：本会话行追加缓存命中（有命中才显示，与总行/perModel 行对称）
        if (sessionId) {
          const mine = store.getSessionUsage(sessionId)
          let mineLine = `  本会话:     ${mine.totalTokens.toLocaleString()} tokens（${mine.callCount} 次调用）`
          const mineCache = mine.cacheReadTokens || 0
          if (mineCache > 0) {
            const mineRate = mine.promptTokens > 0 ? Math.round((mineCache / mine.promptTokens) * 100) : 0
            mineLine += ` · 缓存命中 ${mineCache.toLocaleString()} tokens（${mineRate}%）`
          }
          output(chalk.gray(mineLine))
        }
      }
      break
    case '/exit':
    case '/quit':
      return 'exit'
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
    .option('--context-summarize', '交互模式开启上下文压缩摘要（裁剪时把丢弃历史压缩成摘要消息，AI 保留话题连续性；v0.6.19）')
    .action(async (options: { query?: string; image?: string; maxIterations?: string; contextSummarize?: boolean }) => {
      if (options.query) {
        const maxIter = options.maxIterations ? parseInt(options.maxIterations, 10) : undefined
        await runQuery(options.query, maxIter, options.image ? [options.image] : undefined)
      } else {
        startInteractive({ contextSummarize: options.contextSummarize })
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
    .option('--max-tokens <n>', '默认最大输出 token 数（chat 请求未指定时应用，v0.6.5）')
    .option('--temperature <n>', '默认采样温度 0~2（chat 请求未指定时应用，v0.6.5）')
    .option('--max-context-messages <n>', '默认上下文裁剪条数上限（chat 请求未指定时应用；0 = 不按条数裁剪，v0.6.17）')
    .option('--max-context-tokens <n>', '默认上下文裁剪 token 预算（chat 请求未指定时应用；超过则迭代前自动裁剪，v0.6.17）')
    .option('--context-summarize', '默认开启上下文压缩摘要（chat 请求未指定时应用；裁剪时把丢弃历史压缩成摘要消息，v0.6.19）')
    .option('--tool-output-policy <json>', '默认工具输出治理策略 JSON（chat 请求未指定时应用，如 {"maxOutputChars":800,"tailChars":300}；探索型留头尾/终端型留尾部/长度预算/省略标记可定制，v0.6.34）')
    .action(async (options: { profile?: string; storage?: string; namespace?: string; mcp?: string; confirmTools?: string; confirmTimeout?: string; maxTokens?: string; temperature?: string; maxContextMessages?: string; maxContextTokens?: string; contextSummarize?: boolean; toolOutputPolicy?: string }) => {
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
      // --tool-output-policy <json>（v0.6.34）：JSON 解析 + 校验，作为 server 级默认工具输出治理策略
      let defaultToolOutputPolicy: ToolOutputPolicy | undefined
      if (options.toolOutputPolicy !== undefined) {
        try {
          const parsed = JSON.parse(options.toolOutputPolicy)
          const v = validateToolOutputPolicy(parsed)
          if (!v.ok) {
            console.error(chalk.red(`❌ --tool-output-policy 无效: ${v.message}`))
            process.exit(1)
          }
          defaultToolOutputPolicy = v.value
        } catch (e: any) {
          console.error(chalk.red(`❌ --tool-output-policy 必须是合法 JSON 对象: ${e?.message || e}`))
          process.exit(1)
        }
      }
      startHostServer({
        profile: profile as any,
        storage: options.storage,
        namespace: options.namespace,
        ...(mcp.length > 0 ? { mcp: mcp as any } : {}),
        ...(confirmTools !== undefined ? { confirmTools } : {}),
        ...(options.confirmTimeout ? { confirmTimeoutMs: Number(options.confirmTimeout) } : {}),
        ...(options.maxTokens !== undefined ? { defaultMaxTokens: Number(options.maxTokens) } : {}),
        ...(options.temperature !== undefined ? { defaultTemperature: Number(options.temperature) } : {}),
        ...(options.maxContextMessages !== undefined ? { defaultMaxContextMessages: Number(options.maxContextMessages) } : {}),
        ...(options.maxContextTokens !== undefined ? { defaultMaxContextTokens: Number(options.maxContextTokens) } : {}),
        ...(options.contextSummarize !== undefined ? { defaultContextSummarize: options.contextSummarize } : {}),
        ...(defaultToolOutputPolicy !== undefined ? { defaultToolOutputPolicy } : {}),
      })
    })

  program
    .command('mcp-server')
    .description('MCP 服务器：把 flare 工具集暴露给其他 AI 客户端（stdio 默认；--http 起 HTTP transport，见 docs/mcp.md）')
    .option('-t, --tools <names>', '要暴露的工具（逗号分隔，默认全部内置工具）')
    .option('--http', '用 HTTP transport 替代 stdio（POST /mcp，JSON-RPC over HTTP，v0.6.3）')
    .option('-p, --port <port>', 'HTTP 监听端口（默认 0 = 随机；仅监听 127.0.0.1 本机）')
    .option('--bridge-resources', '透传外部 MCP 服务器资源（v0.6.28：连接 ~/.flare/mcp.json 全部服务器，外部资源/模板经 flare 暴露给客户端，读取实时代理转发）')
    .option('--bridge-prompts', '透传外部 MCP 服务器提示词（v0.6.37：连接 ~/.flare/mcp.json 全部服务器，外部提示词经 flare 暴露给客户端，渲染实时代理转发）')
    .option('--bridge-tools', '透传外部 MCP 服务器工具（v0.6.47：连接 ~/.flare/mcp.json 全部服务器，外部工具经 flare 暴露给客户端，调用实时代理转发）')
    .option('--config <path>', 'MCP 配置文件路径（--bridge-resources / --bridge-prompts / --bridge-tools 用，默认 ~/.flare/mcp.json）')
    .action(async (options: { tools?: string; http?: boolean; port?: string; bridgeResources?: boolean; bridgePrompts?: boolean; bridgeTools?: boolean; config?: string }) => {
      const { MCPServer, startMcpHttpServer, tools: builtinTools, McpManager } = await import('../index.js')
      const names = options.tools
        ? options.tools.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined
      const selected = names
        ? builtinTools.filter((t) => names.includes(t.definition.function.name))
        : builtinTools
      // v0.6.28：--bridge-resources 把外部 MCP 服务器资源透传给 flare 自身 MCPServer 的客户端——
      // 连接配置的全部服务器，外部资源/模板实时合并进 resources/list，读取时按 uri 找到所属服务器代理转发
      // v0.6.37：--bridge-prompts 对称透传提示词（prompts/list 元数据 + prompts/get 渲染代理）
      // v0.6.47：--bridge-tools 对称透传工具（getAllTools 代理 Tool 并集——调用经 flare 转发到外部服务器）
      let resourceProvider: import('../index.js').McpResourceProvider | undefined
      let bridgedPrompts: import('../index.js').McpPrompt[] | undefined
      let bridgedToolList: import('../index.js').Tool[] = []
      if (options.bridgeResources || options.bridgePrompts || options.bridgeTools) {
        const mgr = new McpManager({ configPath: options.config })
        const servers = mgr.servers
        if (servers.length === 0) {
          console.error(chalk.yellow(`${options.bridgeResources ? '--bridge-resources' : ''}${options.bridgePrompts ? ' --bridge-prompts' : ''}${options.bridgeTools ? ' --bridge-tools' : ''} 但未配置 MCP 服务器（~/.flare/mcp.json 的 servers 列表），仅暴露 flare 自身能力`))
        } else {
          await Promise.allSettled(servers.map((s) => mgr.connect(s.name)))
          const connected = mgr.status().filter((s) => s.connected).length
          console.error(chalk.gray(`桥接：已连接 ${connected}/${servers.length} 个外部 MCP 服务器`))
          if (options.bridgeResources) {
            resourceProvider = {
              listResources: () => mgr.getAllResources().map((r) => ({ uri: r.uri, name: r.name, ...(r.description ? { description: r.description } : {}), ...(r.mimeType ? { mimeType: r.mimeType } : {}) })),
              listResourceTemplates: () => mgr.getAllResourceTemplates().map((t) => ({ uriTemplate: t.uriTemplate, name: t.name, ...(t.description ? { description: t.description } : {}), ...(t.mimeType ? { mimeType: t.mimeType } : {}) })),
              readResource: async (uri) => {
                const ref = mgr.getAllResources().find((r) => r.uri === uri)
                if (!ref) return null
                return mgr.readResource(ref.server, uri)
              },
            }
          }
          if (options.bridgePrompts) {
            // 外部提示词包装成 McpPrompt（render 按 prompt 名找到所属服务器代理转发 prompts/get）
            bridgedPrompts = mgr.getAllPrompts().map((p) => ({
              name: p.name,
              ...(p.description ? { description: p.description } : {}),
              ...(Array.isArray(p.arguments) && p.arguments.length > 0 ? { arguments: p.arguments } : {}),
              render: async (args) => {
                const ref = mgr.getAllPrompts().find((x) => x.name === p.name)
                if (!ref) return []
                const res = await mgr.getPrompt(ref.server, p.name, args)
                return res.messages
              },
            }))
          }
          if (options.bridgeTools) {
            // 外部工具并集（createMcpTools 已包装成 flare Tool 代理——execute 经 flare 转发到所属服务器；
            // 同名工具保留原名，与 flare 内置同名时客户端按名调用以先注册者为准，可用 -t 收窄内置避免冲突）
            bridgedToolList = mgr.getAllTools()
            console.error(chalk.gray(`工具透传：${bridgedToolList.length} 个外部工具已并入工具集（调用实时代理转发）`))
          }
        }
      }
      // 工具集 = 内置（-t 收窄）+ 透传的外部工具（--bridge-tools）
      const finalTools = [...selected, ...bridgedToolList]
      if (options.http) {
        // HTTP transport（v0.6.3）：常驻监听 POST /mcp，Ctrl+C 退出
        const h = await startMcpHttpServer({
          tools: finalTools,
          resourceProvider,
          ...(bridgedPrompts ? { prompts: bridgedPrompts } : {}),
          port: options.port ? Number(options.port) : undefined,
        })
        console.log(`MCP HTTP 服务器已启动: ${h.url}（POST JSON-RPC；Ctrl+C 退出）`)
        return
      }
      // 常驻监听 stdin（MCP 客户端经 stdio 连接），直到 EOF 退出
      const server = new MCPServer({
        tools: finalTools,
        resourceProvider,
        ...(bridgedPrompts ? { prompts: bridgedPrompts } : {}),
      })
      server.start()
      // 保持进程存活：stdin 未关闭前不退出（start 已注册监听；无需额外动作）
    })

  const mcpCmd = program
    .command('mcp')
    .description('MCP 服务器工具调用/状态（v0.6.6）')

  mcpCmd
    .command('status')
    .description('查看配置的 MCP 服务器（~/.flare/mcp.json，含传输类型与端点/命令）')
    .option('--config <path>', 'MCP 配置文件路径（默认 ~/.flare/mcp.json）')
    .action(async (options: { config?: string }) => {
      const { McpManager } = await import('../index.js')
      const mgr = new McpManager({ configPath: options.config })
      const servers = mgr.servers
      if (servers.length === 0) {
        console.log(chalk.yellow('未配置 MCP 服务器（~/.flare/mcp.json 的 servers 列表）'))
        return
      }
      const lines = servers.map((s) => {
        const transport = s.url ? 'HTTP' : 'stdio'
        const target = s.url || `${s.command || ''}${s.args?.length ? ' ' + s.args.join(' ') : ''}`
        return `  ${chalk.green(s.name)}  ${chalk.gray(transport)} ${target}`
      })
      console.log(chalk.cyan('配置的 MCP 服务器:'))
      console.log(lines.join('\n'))
      console.log(chalk.gray('  提示: flare mcp call <服务器> <工具> [JSON参数] 调用工具'))
    })

  mcpCmd
    .command('call <server> <tool> [jsonArgs]')
    .description('调用 MCP 服务器工具（stdio 或 HTTP transport；服务器名查 ~/.flare/mcp.json 配置，--url 直连 HTTP 端点）')
    .option('--url <url>', '直接连 HTTP transport 端点（如 http://127.0.0.1:8931/mcp），跳过配置查找')
    .option('--config <path>', 'MCP 配置文件路径（默认 ~/.flare/mcp.json）')
    .option('--timeout <ms>', '单请求超时毫秒（默认 15000）')
    .action(async (server: string, tool: string, jsonArgs: string | undefined, options: { url?: string; config?: string; timeout?: string }) => {
      try {
        const { MCPClient, MCPHttpClient, McpManager } = await import('../index.js')
        const timeoutMs = options.timeout ? Number(options.timeout) : 15000
        // 工具参数：jsonArgs 为 JSON 对象（可选，默认 {}）
        let args: Record<string, any> = {}
        if (jsonArgs !== undefined) {
          try {
            args = JSON.parse(jsonArgs)
          } catch (e: any) {
            throw new Error(`工具参数不是合法 JSON: ${e?.message || e}`)
          }
          if (args === null || typeof args !== 'object' || Array.isArray(args)) {
            throw new Error('工具参数必须是 JSON 对象（如 {"text":"hi"}）')
          }
        }
        // 连接客户端：--url 直连 HTTP；否则查配置（配了 url 走 HTTP，command 走 stdio）
        let client: InstanceType<typeof MCPClient> | InstanceType<typeof MCPHttpClient>
        let label = server
        if (options.url) {
          client = new MCPHttpClient({ url: options.url, timeoutMs })
          label = `${server}（${options.url}）`
        } else {
          const mgr = new McpManager({ configPath: options.config })
          const cfg = mgr.servers.find((s) => s.name === server)
          if (!cfg) {
            throw new Error(`未配置 MCP 服务器: ${server}（~/.flare/mcp.json 的 servers 列表，或 --url 直连 HTTP 端点）`)
          }
          if (!cfg.url && !cfg.command) {
            throw new Error(`MCP 服务器 ${server} 配置无效：需提供 command（stdio）或 url（HTTP transport）`)
          }
          client = cfg.url
            ? new MCPHttpClient({ url: cfg.url, timeoutMs: cfg.timeoutMs || timeoutMs })
            : new MCPClient({ command: cfg.command as string, args: cfg.args, env: cfg.env, timeoutMs })
          if (cfg.url) label = `${server}（${cfg.url}）`
        }
        await client.initialize()
        const res = await client.callTool(tool, args)
        const text = Array.isArray(res.content)
          ? res.content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n')
          : ''
        client.close()
        if (res.isError) {
          console.error(chalk.red(`❌ 工具 ${tool} 执行失败: ${text || '（无错误信息）'}`))
          process.exit(1)
        }
        console.log(text || `（工具 ${tool} 无文本输出）`)
      } catch (e: any) {
        console.error(chalk.red(`❌ ${e?.message || e}`))
        process.exit(1)
      }
    })

  mcpCmd
    .command('resources <server>')
    .description('查看 MCP 服务器暴露的资源（resources/list；--read <uri> 读取内容，v0.6.10）')
    .option('--url <url>', '直接连 HTTP transport 端点（如 http://127.0.0.1:8931/mcp），跳过配置查找')
    .option('--config <path>', 'MCP 配置文件路径（默认 ~/.flare/mcp.json）')
    .option('--timeout <ms>', '单请求超时毫秒（默认 15000）')
    .option('--read <uri>', '读取指定资源内容（替代列出元数据）')
    .action(async (server: string, options: { url?: string; config?: string; timeout?: string; read?: string }) => {
      try {
        const { MCPClient, MCPHttpClient, McpManager } = await import('../index.js')
        const timeoutMs = options.timeout ? Number(options.timeout) : 15000
        // 连接客户端：--url 直连 HTTP；否则查配置（配了 url 走 HTTP，command 走 stdio）——与 mcp call 同构
        let client: InstanceType<typeof MCPClient> | InstanceType<typeof MCPHttpClient>
        let label = server
        if (options.url) {
          client = new MCPHttpClient({ url: options.url, timeoutMs })
          label = `${server}（${options.url}）`
        } else {
          const mgr = new McpManager({ configPath: options.config })
          const cfg = mgr.servers.find((s) => s.name === server)
          if (!cfg) {
            throw new Error(`未配置 MCP 服务器: ${server}（~/.flare/mcp.json 的 servers 列表，或 --url 直连 HTTP 端点）`)
          }
          if (!cfg.url && !cfg.command) {
            throw new Error(`MCP 服务器 ${server} 配置无效：需提供 command（stdio）或 url（HTTP transport）`)
          }
          client = cfg.url
            ? new MCPHttpClient({ url: cfg.url, timeoutMs: cfg.timeoutMs || timeoutMs })
            : new MCPClient({ command: cfg.command as string, args: cfg.args, env: cfg.env, timeoutMs })
          if (cfg.url) label = `${server}（${cfg.url}）`
        }
        await client.initialize()
        if (options.read) {
          const contents = await client.readResource(options.read)
          client.close()
          if (contents.length === 0) {
            console.log(`（资源 ${options.read} 无内容）`)
            return
          }
          for (const c of contents) {
            console.log(c.text)
          }
          return
        }
        const resources = await client.listResources()
        client.close()
        if (resources.length === 0) {
          console.log(chalk.gray(`服务器 ${label} 未暴露任何资源（resources/list 为空）`))
          return
        }
        const lines = resources.map((r) => {
          const meta = [r.name, r.mimeType].filter(Boolean).join(' · ')
          return `  ${chalk.green(r.uri)}${meta ? chalk.gray(`  ${meta}`) : ''}${r.description ? `\n    ${chalk.gray(r.description)}` : ''}`
        })
        console.log(chalk.cyan(`服务器 ${label} 的资源（${resources.length}）:`))
        console.log(lines.join('\n'))
        console.log(chalk.gray('  提示: flare mcp resources <服务器> --read <uri> 读取资源内容'))
      } catch (e: any) {
        console.error(chalk.red(`❌ ${e?.message || e}`))
        process.exit(1)
      }
    })

  mcpCmd
    .command('prompts <server>')
    .description('查看 MCP 服务器暴露的提示词（prompts/list；--get <name> 渲染，v0.6.10）')
    .option('--url <url>', '直接连 HTTP transport 端点（如 http://127.0.0.1:8931/mcp），跳过配置查找')
    .option('--config <path>', 'MCP 配置文件路径（默认 ~/.flare/mcp.json）')
    .option('--timeout <ms>', '单请求超时毫秒（默认 15000）')
    .option('--get <name>', '渲染指定提示词（替代列出元数据）')
    .option('--args <json>', '渲染提示词的参数（--get 时可选，JSON 对象）')
    .action(async (server: string, options: { url?: string; config?: string; timeout?: string; get?: string; args?: string }) => {
      try {
        const { MCPClient, MCPHttpClient, McpManager } = await import('../index.js')
        const timeoutMs = options.timeout ? Number(options.timeout) : 15000
        // 连接客户端：--url 直连 HTTP；否则查配置——与 mcp call/resources 同构
        let client: InstanceType<typeof MCPClient> | InstanceType<typeof MCPHttpClient>
        let label = server
        if (options.url) {
          client = new MCPHttpClient({ url: options.url, timeoutMs })
          label = `${server}（${options.url}）`
        } else {
          const mgr = new McpManager({ configPath: options.config })
          const cfg = mgr.servers.find((s) => s.name === server)
          if (!cfg) {
            throw new Error(`未配置 MCP 服务器: ${server}（~/.flare/mcp.json 的 servers 列表，或 --url 直连 HTTP 端点）`)
          }
          if (!cfg.url && !cfg.command) {
            throw new Error(`MCP 服务器 ${server} 配置无效：需提供 command（stdio）或 url（HTTP transport）`)
          }
          client = cfg.url
            ? new MCPHttpClient({ url: cfg.url, timeoutMs: cfg.timeoutMs || timeoutMs })
            : new MCPClient({ command: cfg.command as string, args: cfg.args, env: cfg.env, timeoutMs })
          if (cfg.url) label = `${server}（${cfg.url}）`
        }
        await client.initialize()
        if (options.get) {
          let args: Record<string, any> = {}
          if (options.args !== undefined) {
            try {
              args = JSON.parse(options.args)
            } catch (e: any) {
              throw new Error(`--args 不是合法 JSON: ${e?.message || e}`)
            }
          }
          const result = await client.getPrompt(options.get, args)
          client.close()
          const texts = (result.messages || [])
            .filter((m: any) => m.content && typeof m.content.text === 'string')
            .map((m: any) => m.content.text)
          if (result.description) console.log(chalk.gray(result.description))
          console.log(texts.join('\n') || `（提示词 ${options.get} 渲染结果为空）`)
          return
        }
        const prompts = await client.listPrompts()
        client.close()
        if (prompts.length === 0) {
          console.log(chalk.gray(`服务器 ${label} 未暴露任何提示词（prompts/list 为空）`))
          return
        }
        const lines = prompts.map((p) => {
          const args = p.arguments && p.arguments.length > 0
            ? `（参数: ${p.arguments.map((a) => a.name).join(', ')}）`
            : ''
          return `  ${chalk.green(p.name)}${args ? chalk.gray(args) : ''}${p.description ? `\n    ${chalk.gray(p.description)}` : ''}`
        })
        console.log(chalk.cyan(`服务器 ${label} 的提示词（${prompts.length}）:`))
        console.log(lines.join('\n'))
        console.log(chalk.gray('  提示: flare mcp prompts <服务器> --get <提示词名> [--args \'{"k":"v"}\'] 渲染'))
      } catch (e: any) {
        console.error(chalk.red(`❌ ${e?.message || e}`))
        process.exit(1)
      }
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

  program
    .command('cache-check')
    .description('prompt caching 验收：连续两轮调用验证第二轮 cache_read_tokens > 0（v0.6.45，P0 验收自动化；v0.6.48 起 --json 结构化输出）')
    .option('-m, --model <model>', '指定模型（缺省用默认路由；如 deepseek-chat）')
    .option('-j, --json', 'JSON 结构化输出（宿主/CI 程序化消费：ok/model/hitTokens/savedUsd/detail/两轮用量；exit code 语义不变）')
    .action(async (options: { model?: string; json?: boolean }) => {
      // 真实调用走 ~/.flare/.env 配置的密钥（本地诊断；不输出任何密钥）
      const { createProvider } = await import('../core/llm.js')
      const { runCacheCheck, cacheCheckToJson } = await import('../core/cache-check.js')
      const llm = createProvider(options.model ? { model: options.model } : undefined)
      const r = await runCacheCheck(llm)
      if (options.json) {
        // 结构化输出：只打印 JSON（不混入彩色/人类可读行），exit code 语义保留
        console.log(cacheCheckToJson(r))
        if (!r.ok) process.exitCode = 1
        return
      }
      console.log(chalk.cyan('\n🧪 prompt caching 验收（连续两轮调用，第二轮应命中缓存）:'))
      if (!r.model) {
        console.log(chalk.red(`\n❌ ${r.detail}`))
        process.exitCode = 1
        return
      }
      console.log(`  模型: ${chalk.green(r.model)}`)
      console.log(`  第一轮: prompt ${r.first.promptTokens} · 命中 ${r.first.cacheReadTokens} tokens（miss 基准）`)
      console.log(`  第二轮: prompt ${r.second.promptTokens} · 命中 ${r.second.cacheReadTokens} tokens`)
      if (r.savedUsd !== null) {
        console.log(chalk.gray(`  估算节省: $${r.savedUsd.toFixed(6)}（命中价 vs 未命中价）`))
      }
      if (r.ok) {
        console.log(chalk.green(`\n✅ PASS: ${r.detail}`))
      } else {
        console.log(chalk.yellow(`\n⚠️  ${r.detail}`))
        process.exitCode = 1
      }
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
