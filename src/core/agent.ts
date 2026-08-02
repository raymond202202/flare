/**
 * Flare Agent 核心
 * 
 * Agent Loop：系统提示 → LLM 调用 → 解析工具调用 → 执行 → 反馈 → 继续
 * 参考：Hermes、Claude Code 的 agent loop 设计
 */

import { Message, LLMProvider, createProvider, createVisionProvider, buildImageContent, parseAttachments, type ContentPart, type ToolDefinition } from './llm.js'
import { getToolDefinitions, executeTool, type Tool } from '../tools/index.js'
import { getMemoryStore, MemoryStore } from '../memory/store.js'
import { logger } from './logger.js'

export interface AgentConfig {
  systemPrompt?: string
  maxIterations?: number
  sessionId?: string
  model?: string
  /** M2: 注入工具集（含 execute）；缺省用 Flare 内置工具 */
  tools?: Tool[]
  /** M2: 独立记忆库路径（如 ~/.pulse/pulse-ai.db）；缺省用 Flare 默认库 */
  storage?: string
  /** M2: 身份话术——用户问"你是谁"时按此回答（如 "我是 pulse 助手…"） */
  identity?: string
  /** M2: Flare 介绍话术——用户追问"flare 是什么"时按此回答（品牌共生） */
  flareIntro?: string
  /** M3+: 视觉 LLM provider（消息含图片时用；缺省懒创建本地 VLM） */
  visionProvider?: LLMProvider
  /** 是否启用图片自动识别（默认 true；false 时忽略消息中的图片） */
  visionEnabled?: boolean
  /** 注入主 LLM provider（默认 createProvider()）；测试可注入 mock */
  llm?: LLMProvider
}

const DEFAULT_SYSTEM_PROMPT = `你是 Flare，一个通用能力的 AI Agent。
你的定位不局限于编程——你是用户的智能助手，可以完成各种任务，
也可以作为 AI 能力核心嵌入到其他产品中（如桌面应用的 AI 面板）。

## 你的能力
你可以使用各种工具来帮助用户完成任务：
- read_file：读取文件内容
- write_file：写/覆盖文件
- search_files：搜索文件
- terminal：执行终端命令（可以运行 node/npm/git/gh 等任何系统命令）

## 工作原则
1. 先理解用户需求，再行动
2. 使用工具完成任务，不要只描述
3. 每次工具调用后，根据结果决定下一步
4. 任务完成后，给用户一个清晰的总结
5. 代码要准确、安全，注意异常处理

## 探索型任务的正确模式
有些任务需要先收集大量信息才能回答（比如"读文档→对比代码→修改→推送"）。
这种任务你可以连续调用多个工具来收集信息，中间不需要每步都输出文字。
收集完所有信息后，再统一给用户一个完整的总结。

## 复杂任务的持续推进
复杂任务（如修改项目、推 GitHub）可能需要很多步骤：
1. 先探查现状（读文件、看目录）
2. 再执行修改（写文件、运行命令）
3. 最后验证（测试、git status）
只要任务还没完成，就继续调用工具推进，不要中途停下来等用户确认。

## 记忆
你的记忆存储在 ~/.flare/flare.db（SQLite 数据库），由你的记忆系统自动管理。
- 查看记忆：用户输入 /memory 或问你"你的记忆"时，回答基于你自己的记忆系统
- **绝对不要**去读取其他 AI 工具的记忆文件（如 ~/.hermes/memories/、~/.agents/、
  ~/.codebuddy/ 等目录）——那些是别的 AI 的记忆，不是你的
- 用户让你"记住"的内容（/remember）才会写入你的记忆

用中文回答用户的问题。`

export class Agent {
  private llm: LLMProvider
  private visionProvider: LLMProvider | null = null
  private config: AgentConfig
  private messages: Message[] = []
  private tools: ToolDefinition[] = []
  private toolExecutors: Map<string, Tool> = new Map()
  private store: MemoryStore

  constructor(config: AgentConfig = {}) {
    this.llm = config.llm || createProvider()
    this.config = config
    if (config.visionProvider) {
      this.visionProvider = config.visionProvider
    }

    // M2: 注入工具集（config.tools 优先，缺省用内置）
    const injected = config.tools || []
    this.toolExecutors = new Map(injected.map(t => [t.definition.function.name, t]))
    this.tools = injected.length > 0 ? injected.map(t => t.definition) : getToolDefinitions()

    // M2: 独立记忆库（config.storage 优先，缺省用 Flare 全局单例）
    this.store = config.storage ? new MemoryStore(config.storage) : getMemoryStore()

    // 加载会话历史
    const store = this.store
    if (config.sessionId) {
      const history = store.getMessages(config.sessionId)
      this.messages = history
      // 清理历史中不完整的 tool_calls 配对（尾部孤儿消息）
      this.cleanOrphanTail()
    }

    // M2: 身份 + flare 介绍注入系统提示（品牌共生话术）
    let basePrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT
    if (config.identity) {
      basePrompt += `\n\n## 你的身份\n当用户问"你是谁"、"你是什么助手"或"你叫什么"时，按以下话术回答（自然融入，不要生硬照抄）：\n${config.identity}`
    }
    if (config.flareIntro) {
      basePrompt += `\n\n## 关于 Flare\n当用户问"flare 是什么"、"你是由什么驱动的"、"flare 和你的关系"时，按以下话术回答（可稍作润色，保持核心信息）：\n${config.flareIntro}`
    }

    // 加载相关记忆
    const memories = store.getAllMemories()
    if (memories.length > 0) {
      const memoryContext = memories.slice(0, 5).map(m => m.content).join('\n')
      this.messages.unshift({
        role: 'system',
        content: `${basePrompt}\n\n## 关于这个用户\n${memoryContext}`,
      })
    } else {
      this.messages.unshift({
        role: 'system',
        content: basePrompt,
      })
    }
  }

  /**
   * 清理消息历史中的"孤儿"消息：
   * - assistant(tool_calls) 后面没有对应的 tool 响应 → 删除该 assistant
   * - 孤立的 tool 响应（前面没有 assistant(tool_calls) 配对）→ 删除
   * 
   * 这些消息发给 LLM 会导致 400 错误：
   * "assistant message with 'tool_calls' must be followed by tool messages"
   */
  private cleanOrphanTail() {
    const cleaned: Message[] = []

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i]

      // 主循环遇到的 tool 消息都是"孤立"的（前面没有 assistant(tool_calls) 配对）：
      // 配对完整的 tool 响应已经被下面的 assistant 前瞻逻辑消费掉了。
      // 孤立 tool 会导致 LLM 400 错误，直接丢弃。
      if (msg.role === 'tool') {
        continue
      }

      // 普通消息（system/user/纯文本 assistant）：直接保留
      if (msg.role !== 'assistant' || !msg.tool_calls) {
        cleaned.push(msg)
        continue
      }

      // assistant(tool_calls)：检查后面是否有完整的 tool 响应配对
      const toolCallIds = new Set(msg.tool_calls.map(tc => tc.id))
      let j = i + 1
      // 收集后面的 tool 响应
      while (j < this.messages.length && this.messages[j].role === 'tool') {
        const toolMsg = this.messages[j]
        if (toolMsg.tool_call_id && toolCallIds.has(toolMsg.tool_call_id)) {
          toolCallIds.delete(toolMsg.tool_call_id)
        }
        j++
      }

      if (toolCallIds.size === 0) {
        // 配对完整：保留 assistant(tool_calls) + 对应的 tool 响应
        cleaned.push(msg)
        for (let k = i + 1; k < j; k++) {
          cleaned.push(this.messages[k])
        }
        i = j - 1
      } else {
        // 配对不完整：丢弃这个 assistant(tool_calls)（连同后面可能的部分 tool 响应）
        // 但保留它可能的文本内容（如果有）
        if (msg.content) {
          cleaned.push({ role: 'assistant', content: msg.content })
        }
        i = j - 1
      }
    }

    this.messages = cleaned
  }

  /**
   * 执行一次完整的 Agent 推理循环
   * 直到 LLM 不再调用工具或达到最大迭代次数
   *
   * @param userInput 用户输入（会自动识别其中的图片路径 / data URL）
   * @param attachments 显式图片附件（本地路径或 data URL；与自动识别合并）
   */
  async *run(userInput: string, attachments?: string[]): AsyncGenerator<{ type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error'; content: string; toolName?: string }, void, unknown> {
    // 防御：清理内存中可能存在的孤儿消息（上次运行中途失败等）
    this.cleanOrphanTail()

    // 自动识别图片（路径 / data URL）；显式 attachments 合并
    const parsed = parseAttachments(userInput)
    const finalAttachments = [...(attachments || []), ...parsed.attachments]
    const hasImages = this.config.visionEnabled !== false && finalAttachments.length > 0
    const inputText = parsed.text || (hasImages ? '请描述这张图片' : userInput)

    // 构建用户消息（多模态：文本 + 图片）
    let content: string | ContentPart[]
    if (hasImages) {
      content = buildImageContent(inputText, finalAttachments)
      // 懒创建视觉 provider（仅在真正看图时初始化）
      if (!this.visionProvider) {
        try {
          // 运行时 /vision 切换的模型优先（存 settings 表）；否则 VISION_MODEL 或默认 3B
          const savedModel = this.store.getSetting('vision_model') || undefined
          this.visionProvider = createVisionProvider(savedModel)
        } catch (e: any) {
          yield { type: 'error', content: `视觉模型初始化失败: ${e.message}。请检查 ~/.flare/.env 的 VISION_* 配置。` }
          yield { type: 'done', content: '' }
          return
        }
      }
    } else {
      content = inputText
    }
    this.messages.push({ role: 'user', content })

    // 本轮使用的 provider：含图 → 视觉模型；否则主模型
    const provider = hasImages && this.visionProvider ? this.visionProvider : this.llm

    // 记录本轮消息的起始位置（用于会话保存）
    const turnStartIdx = this.messages.length - 1

    let iterations = 0
    // 复杂任务（读文档→改代码→推送）可能需要 20-40 次工具调用
    const maxIter = Math.min(this.config.maxIterations || 30, 50) // 上限50，默认30
    let noProgressCount = 0 // 连续无文本输出的工具调用次数
    const recentToolSignatures: string[] = [] // 最近工具调用签名（检测死循环）

    while (iterations < maxIter) {
      iterations++
      logger.debug(`迭代 #${iterations}/${maxIter}，上下文消息数: ${this.messages.length}`)

      // 截断消息上下文，防止内存暴涨
      this.trimContext()

      // 调用 LLM
      // 视觉模型（Ollama qwen2.5vl）不支持 function calling——看图时纯对话，不传 tools
      const response = await provider.chat(this.messages, hasImages ? undefined : this.tools)
      logger.debug(`LLM 响应: model=${response.model}, content=${(response.content || '').length}字符, tool_calls=${response.tool_calls?.length || 0}`)

      // 记录 token 用量（如果 provider 返回了 usage）
      if (response.usage && (response.usage.prompt_tokens > 0 || response.usage.completion_tokens > 0)) {
        try {
          const store = this.store
          store.logUsage(
            this.config.sessionId || null,
            response.usage.prompt_tokens,
            response.usage.completion_tokens,
            response.model
          )
        } catch { /* 用量记录失败不影响主流程 */ }
      }
      
      // 保存助手响应
      this.messages.push({
        role: 'assistant',
        content: response.content || '',
        ...(response.tool_calls ? { tool_calls: response.tool_calls } : {}),
      })

      // 生成文本输出
      if (response.content) {
        noProgressCount = 0 // 有文本输出，重置计数器
        yield { type: 'text', content: response.content }
      }

      // 处理工具调用
      if (response.tool_calls && response.tool_calls.length > 0) {
        if (!response.content) {
          noProgressCount++ // 工具调用没有伴随文本输出，算"无进展"
        } else {
          noProgressCount = 0
        }

        // 宽松无进展保护：探索型任务（连续读文件收集信息）允许较多次
        // 无文本工具调用，只有超过 15 次才强制停止
        if (noProgressCount >= 15) {
          yield { type: 'error', content: '连续多次工具调用均无进展，已自动停止。请简化任务后重试。' }
          break
        }

        // 限制每次工具调用的数量（允许并行 5 个）
        const callsToProcess = response.tool_calls.slice(0, 5)

        for (const tc of callsToProcess) {
          yield { type: 'tool_call', content: tc.function.name, toolName: tc.function.name }

          // 解析工具参数：LLM 可能返回格式异常的 JSON，不能让它崩溃整个循环
          let args: Record<string, any>
          try {
            args = JSON.parse(tc.function.arguments)
            if (typeof args !== 'object' || args === null || Array.isArray(args)) {
              throw new Error('参数必须是 JSON 对象')
            }
          } catch (parseErr: any) {
            const errMsg = `工具「${tc.function.name}」的参数解析失败: ${parseErr.message}`
            yield { type: 'tool_result', content: errMsg, toolName: tc.function.name }
            // 把错误喂回给 LLM，让它修正参数而不是崩溃
            this.messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              name: tc.function.name,
              content: `错误: ${errMsg}`,
            })
            continue
          }
          
          // 死循环检测：同一工具 + 相似参数连续出现 4 次 = 卡住
          const signature = `${tc.function.name}:${JSON.stringify(args).slice(0, 120)}`
          recentToolSignatures.push(signature)
          const repeatCount = recentToolSignatures.filter(s => s === signature).length
          if (repeatCount >= 4) {
            yield { type: 'error', content: `检测到重复调用工具「${tc.function.name}」多次，已自动停止。请换个方式描述你的需求。` }
            break
          }

          // M2: 注入工具优先执行（应用自定义工具），否则回退内置 executeTool
          const injectedTool = this.toolExecutors.get(tc.function.name)
          const result = injectedTool
            ? await injectedTool.execute(args)
            : await executeTool(tc.function.name, args)
          
          // 截断工具结果（防止上下文爆炸）
          const truncatedOutput = result.success
            ? result.output.slice(0, 2000)
            : (result.error || '执行失败').slice(0, 1000)

          yield {
            type: 'tool_result',
            content: truncatedOutput,
            toolName: tc.function.name,
          }

          // 将截断后的工具结果加入消息
          this.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: result.success ? truncatedOutput : `错误: ${result.error?.slice(0, 500)}`,
          })
        }
      } else {
        // 没有工具调用，对话结束
        break
      }
    }

    if (iterations >= maxIter) {
      yield { type: 'error', content: `已达到最大迭代次数(${maxIter})，已自动停止。请简化你的请求后重试。` }
    }

    // 保存到会话：把本轮所有消息（从 turnStartIdx 开始）完整保存
    if (this.config.sessionId) {
      const store = this.store
      for (let i = turnStartIdx; i < this.messages.length; i++) {
        store.saveMessage(this.config.sessionId, this.messages[i])
      }
    }

    yield { type: 'done', content: '' }
  }

  /**
   * 安全地截断上下文，防止内存和 token 爆炸。
   * 保留 system prompt + 最近若干条消息，
   * 且保证不截断 tool_calls ↔ tool 响应的配对关系。
   * 
   * 规则：从末尾往前找到最近的"完整对话轮次"边界：
   *   - 如果最后一条是 tool 响应，向前找到它的 tool_calls 一起保留
   *   - 如果有 assistant(tool_calls)+tool 配对，整对保留
   */
  private trimContext() {
    if (this.messages.length <= 30) return

    const systemMsg = this.messages.find(m => m.role === 'system')
    const maxKept = 30 // 保留最近 30 条（覆盖较长的工具调用链）

    // 从末尾向前收集消息，保证不拆散 tool_calls/tool 配对
    const kept: Message[] = []
    let pendingToolCallIds = new Set<string>() // 需要找 tool_calls 的 ID

    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]

      // 如果还有待配对的 tool_calls，继续往前找
      if (msg.role === 'tool' && msg.tool_call_id) {
        pendingToolCallIds.add(msg.tool_call_id)
        kept.unshift(msg)
        continue
      }

      if (msg.role === 'assistant' && msg.tool_calls) {
        // 这个 assistant 发了 tool_calls
        kept.unshift(msg)
        // 把它的 tool_call_id 从待配对中移除
        for (const tc of msg.tool_calls) {
          pendingToolCallIds.delete(tc.id)
        }
        // 如果这个 assistant 还有文本内容，说明一轮对话完整结束
        if (msg.content) {
          pendingToolCallIds.clear()
        }
        // 待配对清空 = 这一轮完整了，可以停
        if (pendingToolCallIds.size === 0 && kept.length >= maxKept) {
          break
        }
        continue
      }

      // user 或 assistant(无tool_calls) 或 system
      kept.unshift(msg)
      if (kept.length >= maxKept && pendingToolCallIds.size === 0) {
        break
      }
    }

    this.messages = systemMsg
      ? [systemMsg, ...kept]
      : kept
  }

  /** 获取当前消息列表 */
  getMessages(): Message[] {
    return this.messages
  }
}
