/**
 * Flare Agent 核心
 * 
 * Agent Loop：系统提示 → LLM 调用 → 解析工具调用 → 执行 → 反馈 → 继续
 * 参考：Hermes、Claude Code 的 agent loop 设计
 */

import { Message, LLMProvider, createProvider, ToolDefinition } from './llm.js'
import { getToolDefinitions, executeTool } from '../tools/index.js'
import { getMemoryStore } from '../memory/store.js'

export interface AgentConfig {
  systemPrompt?: string
  maxIterations?: number
  sessionId?: string
  model?: string
}

const DEFAULT_SYSTEM_PROMPT = `你是 Flare，一个智能 AI 编程助手。

## 你的能力
你可以使用各种工具来帮助用户完成编程任务：
- read_file：读取文件内容
- write_file：写/覆盖文件
- search_files：搜索文件
- terminal：执行终端命令

## 工作原则
1. 先理解用户需求，再行动
2. 使用工具完成任务，不要只描述
3. 每次工具调用后，根据结果决定下一步
4. 任务完成后，给用户一个清晰的总结
5. 代码要准确、安全，注意异常处理

## 记忆
你记得这个用户的历史会话和偏好。
使用记忆来提供更个性化的帮助。

用中文回答用户的问题。`

export class Agent {
  private llm: LLMProvider
  private config: AgentConfig
  private messages: Message[] = []
  private tools: ToolDefinition[] = []

  constructor(config: AgentConfig = {}) {
    this.llm = createProvider()
    this.config = config
    this.tools = getToolDefinitions()

    // 加载会话历史
    const store = getMemoryStore()
    if (config.sessionId) {
      const history = store.getMessages(config.sessionId)
      this.messages = history
    }

    // 加载相关记忆
    const memories = store.getAllMemories()
    if (memories.length > 0) {
      const memoryContext = memories.slice(0, 5).map(m => m.content).join('\n')
      this.messages.unshift({
        role: 'system',
        content: `${config.systemPrompt || DEFAULT_SYSTEM_PROMPT}\n\n## 关于这个用户\n${memoryContext}`,
      })
    } else {
      this.messages.unshift({
        role: 'system',
        content: config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      })
    }
  }

  /**
   * 执行一次完整的 Agent 推理循环
   * 直到 LLM 不再调用工具或达到最大迭代次数
   */
  async *run(userInput: string): AsyncGenerator<{ type: 'text' | 'tool_call' | 'tool_result' | 'done'; content: string; toolName?: string }, void, unknown> {
    // 添加用户消息
    this.messages.push({ role: 'user', content: userInput })

    let iterations = 0
    const maxIter = this.config.maxIterations || 20

    while (iterations < maxIter) {
      iterations++

      // 调用 LLM
      const response = await this.llm.chat(this.messages, this.tools)
      
      // 保存助手响应
      this.messages.push({
        role: 'assistant',
        content: response.content || '',
        ...(response.tool_calls ? { tool_calls: response.tool_calls } : {}),
      })

      // 生成文本输出
      if (response.content) {
        yield { type: 'text', content: response.content }
      }

      // 处理工具调用
      if (response.tool_calls && response.tool_calls.length > 0) {
        for (const tc of response.tool_calls) {
          const args = JSON.parse(tc.function.arguments)
          yield { type: 'tool_call', content: tc.function.name, toolName: tc.function.name }
          
          const result = await executeTool(tc.function.name, args)
          
          yield {
            type: 'tool_result',
            content: result.success ? result.output : result.error || '执行失败',
            toolName: tc.function.name,
          }

          // 将工具结果加入消息
          this.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: result.success ? result.output : `错误: ${result.error}`,
          })
        }
      } else {
        // 没有工具调用，对话结束
        break
      }
    }

    // 保存到会话
    if (this.config.sessionId) {
      const store = getMemoryStore()
      store.saveMessage(this.config.sessionId, { role: 'user', content: userInput })
      
      const lastAssistant = this.messages[this.messages.length - 1]
      if (lastAssistant.role === 'assistant') {
        store.saveMessage(this.config.sessionId, lastAssistant)
      }
    }

    yield { type: 'done', content: '' }
  }

  /** 获取当前消息列表 */
  getMessages(): Message[] {
    return this.messages
  }
}
