/**
 * 模型可观测性（v0.6.0）
 *
 * listOllamaModels：查询本地 Ollama 已拉取的模型列表（/api/tags），
 * 供 CLI `flare models`、宿主面板展示"可切换的本地模型"。
 *
 * - 零依赖：Node 18+ 全局 fetch
 * - Ollama 不可达 / 未安装 → 返回 { ok:false, error }，不抛错（CLI 友好降级）
 * - fetchImpl 可注入（测试 mock / 宿主替换），默认全局 fetch
 */

export interface OllamaModelInfo {
  /** 模型名（如 qwen2.5:7b） */
  name: string
  /** 模型大小（字节） */
  size: number
  /** 最近修改时间（ISO 字符串） */
  modifiedAt: string
}

export interface OllamaModelsResult {
  ok: boolean
  models: OllamaModelInfo[]
  /** ok=false 时的原因（Ollama 不可达 / 响应异常） */
  error?: string
}

/** 本地 Ollama 默认端点（与 src/core/llm.ts 模型路由一致） */
export const OLLAMA_DEFAULT_BASE = 'http://localhost:11434'

/**
 * 查询本地 Ollama 已拉取的模型列表。
 *
 * @param baseUrl Ollama 端点（默认 http://localhost:11434；注意是根地址，/api/tags 由本函数拼接）
 * @param timeoutMs 超时（默认 3000ms；Ollama 未启动时连接会很快失败，超时是兜底）
 * @param fetchImpl 可注入 fetch（测试 mock 用；默认全局 fetch）
 */
export async function listOllamaModels(
  baseUrl = OLLAMA_DEFAULT_BASE,
  timeoutMs = 3000,
  fetchImpl: typeof fetch = fetch
): Promise<OllamaModelsResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/tags`, { signal: ctrl.signal })
    if (!res.ok) {
      return { ok: false, models: [], error: `Ollama 响应异常: HTTP ${res.status}` }
    }
    const data: any = await res.json()
    const models = Array.isArray(data?.models) ? data.models : []
    return {
      ok: true,
      models: models.map((m: any) => ({
        name: String(m?.name || ''),
        size: Number(m?.size) || 0,
        modifiedAt: String(m?.modified_at || ''),
      })).filter((m: OllamaModelInfo) => m.name),
    }
  } catch (e: any) {
    return {
      ok: false,
      models: [],
      error: e?.name === 'AbortError'
        ? `Ollama 响应超时（${timeoutMs}ms）`
        : `Ollama 不可达: ${e?.message || e}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 人类可读的字节大小（如 4.7 GB） */
export function formatModelSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '?'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

/**
 * 推断模型 provider 类型（v0.6.9 起在 server.ts，v0.6.136 上移到 core 供 store/routing 复用）：
 * 模型名 → ollama / deepseek / openai / other。
 * 与 resolveProviderOptions 的自动检测规则一致（含 ':' 的 Ollama 命名 / deepseek 系列 / gpt·o1·o3·chatgpt 系列）。
 */
export function detectProvider(model: string): 'ollama' | 'deepseek' | 'openai' | 'other' {
  if (model.includes(':')) return 'ollama'
  if (model.includes('deepseek')) return 'deepseek'
  if (model.includes('gpt') || model.includes('o1') || model.includes('o3') || model.includes('chatgpt')) return 'openai'
  return 'other'
}

/** 模型能力标签（v0.6.137，ollama 模型发现增强：models 命令展示本地模型能力） */
export type ModelCapability = '文本' | '视觉' | '推理' | '嵌入' | '代码'

/**
 * 按模型名推断能力标签（v0.6.137，纯函数可单测，零网络）：
 * - 含 vl / vision / llava → 视觉（多模态）
 * - 含 r1 / reasoner / think → 推理
 * - 含 embedding / nomic-embed / bge → 嵌入
 * - 含 coder / code / deepseek-coder → 代码
 * - 其余 → 文本（默认）
 * 可返回多个标签（如 qwen2.5vl 视觉模型同时可做文本 → ['视觉', '文本'] 由调用方决定展示）。
 */
export function inferModelCapabilities(name: string): ModelCapability[] {
  const n = (name || '').toLowerCase()
  const caps: ModelCapability[] = []
  // vl 匹配 qwen2.5vl:3b / qwen2-vl:7b（vl 后跟分隔符或结尾）；vision/llava 直接匹配
  if (/vl([-_:]|$)|vision|llava/.test(n)) caps.push('视觉')
  if (/r1|reasoner|think/.test(n)) caps.push('推理')
  if (/embed|nomic-embed|bge/.test(n)) caps.push('嵌入')
  if (/coder|code|deepseek-coder/.test(n)) caps.push('代码')
  if (caps.length === 0) caps.push('文本')
  return caps
}
