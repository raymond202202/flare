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
 * 从 token 中提取可能的路径部分：
 * 输入可能粘连中文/标点（"识别这张图：/home/...png" 无空格时整句是一个 token），
 * 从第一个路径起点（~/、./、../、/）截取到结尾作为路径候选。
 */
function extractPathFromToken(token: string): string | null {
  const starts: number[] = []
  const tilde = token.indexOf('~/')
  const dotDot = token.indexOf('../')
  const dot = token.indexOf('./')
  const abs = token.indexOf('/')
  if (tilde >= 0) starts.push(tilde)
  if (dotDot >= 0) starts.push(dotDot)
  if (dot >= 0) starts.push(dot)
  if (abs >= 0) starts.push(abs)
  if (starts.length === 0) return null
  return token.slice(Math.min(...starts))
}

/**
 * 从用户输入中自动识别图片（路径 或 内嵌 data URL）：
 * - 引号包裹的路径（含空格）："我的截图 01.png"
 * - 裸路径 token：~/Pictures/a.png（支持粘连中文/标点：识别这张图：/home/...png）
 * - data URL：data:image/png;base64,...
 *
 * 命中且文件存在 → 从文本中剥离，加入 attachments（保留路径前的中文提示文本）。
 * 调用方无需显式传图；未来 GUI 贴截图（data URL）也能自动处理。
 */
export function parseAttachments(input: string): ParsedInput {
  const attachments: string[] = []
  let text = input

  // 1. data URL
  const dataUrls = text.match(DATA_URL_RE) || []
  for (const d of dataUrls) attachments.push(d)
  text = text.replace(DATA_URL_RE, ' ')

  // 2. 引号包裹的路径：提取真实路径部分，只有存在才剥离，否则保留原文
  text = text.replace(QUOTED_PATH_RE, (match, quote, p) => {
    const pathCandidate = extractPathFromToken(p)
    if (pathCandidate && isImageFile(pathCandidate)) {
      attachments.push(pathCandidate)
      const prefix = p.slice(0, p.length - pathCandidate.length)
      // 有前缀文本保留引号结构；纯路径直接替换为空格
      return prefix ? quote + prefix + ' ' + quote : ' '
    }
    return match
  })

  // 3. 裸路径 token：提取路径部分，只剥离存在的图片（保留前缀文本）
  text = text.replace(BARE_PATH_RE, (match, p) => {
    const cleaned = p.replace(/[),;:!?。，；：！？]+$/, '')
    const pathCandidate = extractPathFromToken(cleaned)
    if (pathCandidate && isImageFile(pathCandidate)) {
      attachments.push(pathCandidate)
      const prefix = cleaned.slice(0, cleaned.length - pathCandidate.length)
      return prefix + ' '
    }
    return match
  })

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
    /** P0（v0.6.29）：缓存命中 input tokens（DeepSeek prompt_cache_hit_tokens / OpenAI prompt_tokens_details.cached_tokens） */
    cache_read_tokens?: number
    /** P0（v0.6.29）：缓存写入 tokens（Anthropic 风格 cache_creation_input_tokens；DeepSeek/OpenAI 通常无此字段） */
    cache_write_tokens?: number
    /** P0（v0.6.29）：估算成本 USD（按模型定价；无法可靠估算的模型为 null） */
    estimated_cost_usd?: number | null
  }
}

/**
 * P0（v0.6.29）：按模型估算一次调用的成本（USD）。
 *
 * 定价（每百万 token，2026-08 公开价）：
 *   - deepseek-chat：输入未命中 $0.27 / 命中 $0.07 / 输出 $1.10
 *   - deepseek-reasoner：输入未命中 $0.55 / 命中 $0.14 / 输出 $2.19
 * 其余模型（本地 Ollama / 其他云端）无法可靠估算 → 返回 null（宿主自行处理）。
 *
 * 缓存命中的 input 按命中价计（≈1/4 未命中价）；prompt_tokens 已含命中部分。
 */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens = 0
): number | null {
  const pricing: Record<string, { input: number; cacheHit: number; output: number }> = {
    'deepseek-chat': { input: 0.27, cacheHit: 0.07, output: 1.10 },
    'deepseek-reasoner': { input: 0.55, cacheHit: 0.14, output: 2.19 },
  }
  const p = pricing[model]
  if (!p) return null
  const read = Math.min(Math.max(0, cacheReadTokens), Math.max(0, promptTokens))
  const miss = Math.max(0, promptTokens - read)
  const usd = (miss / 1e6) * p.input + (read / 1e6) * p.cacheHit + (Math.max(0, completionTokens) / 1e6) * p.output
  return Math.round(usd * 1e6) / 1e6
}

/**
 * P0（v0.6.29）：从 OpenAI 兼容 usage 响应提取缓存字段（纯函数，可单测）。
 *
 * 兼容两套格式：
 *   - DeepSeek：usage.prompt_cache_hit_tokens（命中数）
 *   - OpenAI：usage.prompt_tokens_details.cached_tokens（命中数）
 * 缓存写入：Anthropic 风格 prompt_tokens_details.cache_creation_input_tokens（多数兼容端点无此字段 → 0）
 */
export function extractUsageCache(usage: any): { cacheReadTokens: number; cacheWriteTokens: number } {
  const details = usage?.prompt_tokens_details || {}
  const cacheRead =
    usage?.prompt_cache_hit_tokens ??
    details?.cached_tokens ??
    // 归一化字段回退（v0.6.45）：OpenAIProvider.chat 归一化后只保留 cache_read_tokens，
    // 原始格式字段被丢弃——本函数需兼容两种形态（原始 usage / LLMResponse.usage）
    usage?.cache_read_tokens ??
    0
  const cacheWrite = details?.cache_creation_input_tokens ?? usage?.cache_write_tokens ?? 0
  return {
    cacheReadTokens: Number.isFinite(cacheRead) && cacheRead > 0 ? cacheRead : 0,
    cacheWriteTokens: Number.isFinite(cacheWrite) && cacheWrite > 0 ? cacheWrite : 0,
  }
}

export interface LLMProvider {
  chat(messages: Message[], tools?: ToolDefinition[]): Promise<LLMResponse>
  chatStream(messages: Message[], tools?: ToolDefinition[]): AsyncGenerator<string, void, unknown>
}

/** 创建 provider 的可选参数（模型 / 端点 / 密钥 / 采样控制） */
export interface ProviderOptions {
  apiKey?: string
  baseURL?: string
  model?: string
  /** 最大输出 token 数（v0.6.3）：透传到 API 请求体 max_tokens；缺省不传（用服务端默认） */
  maxTokens?: number
  /** 采样温度 0~2（v0.6.3）：透传到 API 请求体 temperature；缺省不传（用服务端默认） */
  temperature?: number
}

/** resolveProviderOptions 的解析结果（全部落定） */
export interface ResolvedProviderOptions {
  model: string
  baseURL: string
  apiKey: string
}

/**
 * 模型 → provider 配置推导（纯函数，可单测，无网络）
 *
 * 优先级（从高到低）：
 * 1. 显式传参 options.baseURL / options.apiKey
 * 2. 环境配置 LLM_BASE_URL / LLM_API_KEY（主模型通用覆盖，v0.5.2）
 * 3. 旧配置 OPENAI_BASE_URL（兼容，仅 baseURL）
 * 4. 按模型名自动检测端点：
 *    - 模型名含 ':'（Ollama 命名，如 qwen2.5:7b / llama3.1:8b / deepseek-r1:7b）
 *      → 本地 Ollama OpenAI 兼容端点（http://localhost:11434/v1，apiKey 'ollama'）
 *    - deepseek 系列 → DeepSeek API
 *    - gpt / o1 / o3 / chatgpt 系列 → OpenAI API
 *    - claude 系列 → 明确报错（Anthropic 原生 API 非 OpenAI 兼容格式）
 * 5. apiKey 按模型名回退：deepseek → DEEPSEEK_API_KEY；否则 OPENAI_API_KEY
 */
export function resolveProviderOptions(options: ProviderOptions = {}): ResolvedProviderOptions {
  const model = options.model || config.get('DEFAULT_MODEL') || 'gpt-4o'
  const baseURL = options.baseURL || config.get('LLM_BASE_URL') || config.get('OPENAI_BASE_URL') || ''
  let apiKey = options.apiKey || config.get('LLM_API_KEY') || ''

  let resolvedBase = baseURL
  if (!resolvedBase) {
    if (model.includes(':')) {
      // Ollama 本地模型：本地 OpenAI 兼容端点，文本/图片均不出本机
      resolvedBase = 'http://localhost:11434/v1'
    } else if (model.includes('deepseek')) {
      resolvedBase = 'https://api.deepseek.com/v1'
    } else if (model.includes('gpt') || model.includes('o1') || model.includes('o3') || model.includes('chatgpt')) {
      resolvedBase = 'https://api.openai.com/v1'
    } else if (model.includes('claude')) {
      // Anthropic 原生 API 不是 OpenAI 兼容格式，需要代理或 Anthropic SDK
      // 这里给出明确错误而不是静默用 OpenAI URL 导致 401
      throw new Error(
        `模型「${model}」是 Claude 系列。当前版本 Flare 通过 OpenAI 兼容 API 调用模型，` +
        `尚不支持 Anthropic 原生 API。请使用 DeepSeek (deepseek-chat)、OpenAI (gpt-4o) 或本地 Ollama (如 qwen2.5:7b) 模型。`
      )
    }
  }

  if (!apiKey) {
    if (model.includes(':')) {
      apiKey = 'ollama'
    } else if (model.includes('deepseek')) {
      apiKey = config.get('DEEPSEEK_API_KEY') || ''
    } else {
      apiKey = config.get('OPENAI_API_KEY') || ''
    }
  }

  return {
    model,
    baseURL: resolvedBase || 'https://api.openai.com/v1',
    apiKey,
  }
}

/**
 * OpenAI 兼容的 LLM 提供者
 * 支持：OpenAI、DeepSeek、OpenRouter 等所有 OpenAI 兼容 API
 */
export class OpenAIProvider implements LLMProvider {
  private client: OpenAI
  private model: string
  private maxTokens?: number
  private temperature?: number

  constructor(options?: ProviderOptions) {
    // 模型路由：显式参数 > LLM_* 配置 > 旧 OPENAI_BASE_URL > 按模型名自动检测（含 Ollama 本地模型）
    const resolved = resolveProviderOptions(options)
    this.client = new OpenAI({
      apiKey: resolved.apiKey,
      baseURL: resolved.baseURL,
    })
    this.model = resolved.model
    // 采样控制（v0.6.3）：仅显式传入时透传到 API 请求体（max_tokens / temperature）；缺省不传保持服务端默认
    this.maxTokens = options?.maxTokens
    this.temperature = options?.temperature
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
          ...(this.maxTokens !== undefined ? { max_tokens: this.maxTokens } : {}),
          ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
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
          usage: response.usage ? (() => {
            // P0（v0.6.29）：缓存命中/写入 + 成本估算（宿主可见缓存命中率）
            const cache = extractUsageCache(response.usage)
            const usage: NonNullable<LLMResponse['usage']> = {
              prompt_tokens: response.usage!.prompt_tokens,
              completion_tokens: response.usage!.completion_tokens,
              estimated_cost_usd: estimateCostUsd(
                response.model,
                response.usage!.prompt_tokens,
                response.usage!.completion_tokens,
                cache.cacheReadTokens
              ),
            }
            if (cache.cacheReadTokens > 0) usage.cache_read_tokens = cache.cacheReadTokens
            if (cache.cacheWriteTokens > 0) usage.cache_write_tokens = cache.cacheWriteTokens
            return usage
          })() : undefined,
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
      ...(this.maxTokens !== undefined ? { max_tokens: this.maxTokens } : {}),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
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
 *
 * 可传 options 覆盖模型/端点/密钥（v0.5.2）：
 *   createProvider()                          → 按 DEFAULT_MODEL 自动路由（deepseek/gpt/Ollama）
 *   createProvider({ model: 'qwen2.5:7b' })   → 本地 Ollama 主模型（0 成本/隐私/离线）
 */
export function createProvider(options?: ProviderOptions): LLMProvider {
  return new OpenAIProvider(options)
}

/**
 * 创建视觉 LLM 提供者（本地 VLM）
 *
 * 配置来源（~/.flare/.env）：
 *   VISION_MODEL=qwen2.5vl:3b
 *   VISION_BASE_URL=http://localhost:11434/v1
 *   VISION_API_KEY=ollama
 *
 * modelOverride 优先于 VISION_MODEL（运行时 /vision 命令切换用）。
 * 默认 qwen2.5vl:3b（快一倍，覆盖日常 OCR/截图）；质量优先可切 7B。
 * 仅在看图（消息含图片）时使用；普通文本对话仍走默认 provider。
 */
export function createVisionProvider(modelOverride?: string): LLMProvider {
  const model = modelOverride || config.get('VISION_MODEL') || 'qwen2.5vl:3b'
  const baseURL = config.get('VISION_BASE_URL') || 'http://localhost:11434/v1'
  const apiKey = config.get('VISION_API_KEY') || 'ollama'
  return new OpenAIProvider({ model, baseURL, apiKey })
}
