/**
 * LLM 提供者抽象层
 * 
 * 支持多种 LLM 提供者，统一接口调用。
 * 参考：Hermes、Aider 的 provider 设计
 */

import OpenAI from 'openai'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { extname, join, resolve } from 'path'
import { config } from '../core/config.js'

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

/**
 * 多模态消息内容片段（OpenAI 兼容格式）
 * - text: 纯文本
 * - image_url: 图片（本地路径转 data URL，或直接传 data URL / http URL）
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface Message {
  role: MessageRole
  /** 纯文本 或 多模态片段数组（含图片） */
  content: string | ContentPart[]
  tool_call_id?: string
  name?: string
  tool_calls?: ToolCall[]
}

// ===== 图片识别 / 多模态构建 =====

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic', '.avif', '.svg']

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}

/** 展开 ~ 并解析为绝对路径 */
export function resolveImagePath(p: string): string {
  const expanded = p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
  return resolve(expanded)
}

/** 本地图片文件 → data URL */
export function fileToDataUrl(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  const mime = MIME_TYPES[ext] || 'image/png'
  const b64 = readFileSync(filePath).toString('base64')
  return `data:${mime};base64,${b64}`
}

/** 判断是否为存在的本地图片文件（支持 ~ 展开、相对路径） */
export function isImageFile(p: string): boolean {
  try {
    const resolved = resolveImagePath(p)
    return existsSync(resolved) && IMAGE_EXTENSIONS.includes(extname(resolved).toLowerCase())
  } catch {
    return false
  }
}

/** 构建多模态消息内容：文本 + 图片列表（路径或 data URL） */
export function buildImageContent(text: string, attachments: string[]): ContentPart[] {
  const parts: ContentPart[] = []
  if (text.trim()) parts.push({ type: 'text', text })
  for (const p of attachments) {
    if (p.startsWith('data:image/')) {
      parts.push({ type: 'image_url', image_url: { url: p } })
    } else if (p.startsWith('data:')) {
      parts.push({ type: 'image_url', image_url: { url: p } })
    } else {
      parts.push({ type: 'image_url', image_url: { url: fileToDataUrl(resolveImagePath(p)) } })
    }
  }
  return parts
}

export interface ParsedInput {
  /** 剥离图片路径/data URL 后的纯文本 */
  text: string
  /** 识别出的图片附件（本地路径 或 data URL） */
  attachments: string[]
}

const DATA_URL_RE = /data:image\/[a-zA-Z0-9+./-]+;base64,[A-Za-z0-9+/=]+/g
const QUOTED_PATH_RE = /(["'])(.*?\.(?:png|jpe?g|webp|gif|bmp|heic|avif|svg))\1/gi
const BARE_PATH_RE = /(\S+\.(?:png|jpe?g|webp|gif|bmp|heic|avif|svg))/gi

/**
 * 从用户输入中自动识别图片（路径 或 内嵌 data URL）：
 * - 引号包裹的路径（含空格）："我的截图 01.png"
 * - 裸路径 token：~/Pictures/a.png
 * - data URL：data:image/png;base64,...
 *
 * 命中且文件存在 → 从文本中剥离，加入 attachments。
 * 调用方无需显式传图；未来 GUI 贴截图（data URL）也能自动处理。
 */
export function parseAttachments(input: string): ParsedInput {
  const attachments: string[] = []
  let text = input

  // 1. data URL
  const dataUrls = text.match(DATA_URL_RE) || []
  for (const d of dataUrls) attachments.push(d)
  text = text.replace(DATA_URL_RE, ' ')

  // 2. 引号包裹的路径
  const quotedMatches = [...text.matchAll(QUOTED_PATH_RE)]
  for (const m of quotedMatches) {
    if (isImageFile(m[2])) attachments.push(m[2])
  }
  text = text.replace(QUOTED_PATH_RE, ' ')

  // 3. 裸路径 token（去尾部标点）
  const bareMatches = [...text.matchAll(BARE_PATH_RE)]
  for (const m of bareMatches) {
    const cleaned = m[1].replace(/[),;:!?。，；：！？]+$/, '')
    if (isImageFile(cleaned)) attachments.push(cleaned)
  }
  text = text.replace(BARE_PATH_RE, ' ')

  return { text: text.replace(/\s+/g, ' ').trim(), attachments }
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
      } else if (model.includes('gpt') || model.includes('o1') || model.includes('o3') || model.includes('chatgpt')) {
        baseURL = 'https://api.openai.com/v1'
      } else if (model.includes('claude')) {
        // Anthropic 原生 API 不是 OpenAI 兼容格式，需要代理或 Anthropic SDK
        // 这里给出明确错误而不是静默用 OpenAI URL 导致 401
        throw new Error(
          `模型「${model}」是 Claude 系列。当前版本 Flare 通过 OpenAI 兼容 API 调用模型，` +
          `尚不支持 Anthropic 原生 API。请使用 DeepSeek (deepseek-chat) 或 OpenAI (gpt-4o) 模型。`
        )
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
    // 重试机制：网络抖动/限流自动重试（最多3次，指数退避）
    const maxRetries = 3
    let lastError: Error | null = null

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
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
      } catch (e: any) {
        lastError = e
        // 只对可重试错误重试：429 限流、5xx 服务端错误、网络错误
        const status = e?.status
        const retryable = status === 429 || (status >= 500 && status < 600) || !status
        if (!retryable || attempt === maxRetries - 1) {
          break
        }
        // 指数退避：1s → 2s → 4s
        const delay = 1000 * Math.pow(2, attempt)
        await new Promise(r => setTimeout(r, delay))
      }
    }

    throw lastError || new Error('LLM 调用失败')
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

/**
 * 创建视觉 LLM 提供者（本地 VLM）
 *
 * 配置来源（~/.flare/.env）：
 *   VISION_MODEL=qwen2.5vl:7b
 *   VISION_BASE_URL=http://localhost:11434/v1
 *   VISION_API_KEY=ollama
 *
 * 仅在看图（消息含图片）时使用；普通文本对话仍走默认 provider。
 */
export function createVisionProvider(): LLMProvider {
  const model = config.get('VISION_MODEL') || 'qwen2.5vl:7b'
  const baseURL = config.get('VISION_BASE_URL') || 'http://localhost:11434/v1'
  const apiKey = config.get('VISION_API_KEY') || 'ollama'
  return new OpenAIProvider({ model, baseURL, apiKey })
}
