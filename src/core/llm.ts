/**
 * LLM 提供者抽象层
 * 
 * 支持多种 LLM 提供者，统一接口调用。
 * 参考：Hermes、Aider 的 provider 设计
 */

import OpenAI from 'openai'
import { config } from '../core/config.js'

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface Message {
  role: MessageRole
  content: string
  tool_call_id?: string
  name?: string
  tool_calls?: ToolCall[]
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface LLMResponse {
  content: string
  tool_calls?: ToolCall[]
  model: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
  }
}

export interface LLMProvider {
  chat(messages: Message[], tools?: ToolDefinition[]): Promise<LLMResponse>
  chatStream(messages: Message[], tools?: ToolDefinition[]): AsyncGenerator<string, void, unknown>
}

/**
 * OpenAI 兼容的 LLM 提供者
 * 支持：OpenAI、DeepSeek、OpenRouter 等所有 OpenAI 兼容 API
 */
export class OpenAIProvider implements LLMProvider {
  private client: OpenAI
  private model: string

  constructor(options?: { apiKey?: string; baseURL?: string; model?: string }) {
    const model = options?.model || config.get('DEFAULT_MODEL') || 'gpt-4o'
    let baseURL = options?.baseURL || config.get('OPENAI_BASE_URL') || ''

    // 自动检测模型对应的 baseURL
    if (!baseURL) {
      if (model.includes('deepseek')) {
        baseURL = 'https://api.deepseek.com/v1'
      } else if (model.includes('gpt') || model.includes('o1') || model.includes('o3')) {
        baseURL = 'https://api.openai.com/v1'
      }
    }

    const apiKey = options?.apiKey || (() => {
      if (model.includes('deepseek')) return config.get('DEEPSEEK_API_KEY') || ''
      return config.get('OPENAI_API_KEY') || ''
    })()

    this.client = new OpenAI({
      apiKey,
      baseURL: baseURL || 'https://api.openai.com/v1',
    })
    this.model = model
  }

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages as any,
      tools: tools as any,
      stream: false,
    })

    const choice = response.choices[0]
    return {
      content: choice.message.content || '',
      tool_calls: choice.message.tool_calls?.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
      model: response.model,
      usage: response.usage ? {
        prompt_tokens: response.usage.prompt_tokens,
        completion_tokens: response.usage.completion_tokens,
      } : undefined,
    }
  }

  async *chatStream(messages: Message[], tools?: ToolDefinition[]): AsyncGenerator<string, void, unknown> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages as any,
      tools: tools as any,
      stream: true,
      stream_options: { include_usage: true },
    })

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta
      if (delta?.content) {
        yield delta.content
      }
    }
  }
}

/**
 * 创建默认 LLM 提供者
 */
export function createProvider(): LLMProvider {
  return new OpenAIProvider()
}
