/**
 * Flare 网络工具集（Pulse 网络专家使用）
 *
 * 提供给 Pulse 集成：http_request / url_parse / response_analyze
 * 安全：只允许 http/https 协议，禁止危险协议；请求超时 30s
 */
import type { Tool } from './index.js'

/** 展开路径中的 ~（与基础工具一致） */
function expandHome(p: string): string {
  const home = process.env.HOME || ''
  if (home && p === '~') return home
  if (home && p.startsWith('~/')) return home + p.slice(1)
  return p
}

/** 校验 URL 协议（只允许 http/https） */
function assertSafeUrl(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`无效的 URL: ${rawUrl}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`协议被安全策略拦截: ${url.protocol}//（只允许 http/https）`)
  }
  return url.toString()
}

/**
 * http_request：发送 HTTP 请求
 * 参数：{ method?, url, headers?, body?, timeout? }
 */
export const httpRequestTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'http_request',
      description: '发送 HTTP 请求（GET/POST/PUT/DELETE 等），支持自定义 headers 和 body。用于网络请求调试、API 联调。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '请求 URL（只支持 http/https）' },
          method: { type: 'string', description: '请求方法，默认 GET' },
          headers: { type: 'object', description: '请求头（如 {"Authorization": "Bearer xxx"}）' },
          body: { type: 'string', description: '请求体（POST/PUT 用）' },
          timeout: { type: 'number', description: '超时毫秒数，默认 30000' },
        },
        required: ['url'],
      },
    },
  },
  execute: async (args: Record<string, any>) => {
    try {
      const { url: rawUrl, method, headers, body, timeout } = args
      const url = assertSafeUrl(rawUrl)
      const controller = new AbortController()
      const timeoutMs = Math.min(timeout || 30000, 60000)
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const startedAt = Date.now()
        const res = await fetch(url, {
          method: method || 'GET',
          headers: headers || {},
          body,
          signal: controller.signal,
        })
        const elapsed = Date.now() - startedAt
        const text = await res.text()
        return {
          success: true,
          output: `状态码: ${res.status} ${res.statusText}\n耗时: ${elapsed}ms\n响应头:\n${[...res.headers.entries()].map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n响应体(${text.length}字符):\n${text.slice(0, 3000)}`,
        }
      } catch (e: any) {
        return {
          success: false,
          output: '',
          error: e.name === 'AbortError' ? `请求超时（>${timeoutMs}ms）` : `请求失败: ${e.message}`,
        }
      } finally {
        clearTimeout(timer)
      }
    } catch (e: any) {
      // assertSafeUrl 等前置校验失败
      return { success: false, output: '', error: e.message }
    }
  },
}

/**
 * url_parse：解析 URL 结构
 * 参数：{ url }
 */
export const urlParseTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'url_parse',
      description: '解析 URL 的协议、域名、端口、路径、查询参数、锚点等结构',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要解析的 URL' },
        },
        required: ['url'],
      },
    },
  },
  execute: (args: Record<string, any>) => {
    try {
      const u = new URL(args.url)
      const params: Record<string, string> = {}
      u.searchParams.forEach((v, k) => { params[k] = v })
      return {
        success: true,
        output: [
          `完整 URL: ${u.toString()}`,
          `协议: ${u.protocol}`,
          `主机: ${u.hostname}`,
          `端口: ${u.port || '(默认)'}`,
          `路径: ${u.pathname || '/'}`,
          `查询参数: ${Object.keys(params).length ? JSON.stringify(params, null, 2) : '(无)'}`,
          `锚点: ${u.hash || '(无)'}`,
        ].join('\n'),
      }
    } catch (e: any) {
      return { success: false, output: '', error: `解析失败: ${e.message}` }
    }
  },
}

/**
 * response_analyze：分析 HTTP 响应（状态码/耗时/头部）
 * 参数：{ statusCode?, elapsedMs?, headers? }
 */
export const responseAnalyzeTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'response_analyze',
      description: '分析 HTTP 响应质量：状态码含义、耗时评估、头部检查（缓存/安全头等）',
      parameters: {
        type: 'object',
        properties: {
          statusCode: { type: 'number', description: 'HTTP 状态码' },
          elapsedMs: { type: 'number', description: '请求耗时毫秒数' },
          headers: { type: 'object', description: '响应头' },
        },
        required: ['statusCode'],
      },
    },
  },
  execute: (args: Record<string, any>) => {
    const status = Number(args.statusCode)
    const statusText: Record<number, string> = {
      200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found',
      304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
      404: 'Not Found', 405: 'Method Not Allowed', 429: 'Too Many Requests',
      500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
    }
    const level = status < 300 ? '✅ 成功' : status < 400 ? '⚠️ 重定向' : status < 500 ? '❌ 客户端错误' : '❌ 服务端错误'
    const lines = [`状态码 ${status} ${statusText[status] || ''} → ${level}`]
    if (args.elapsedMs !== undefined) {
      const speed = args.elapsedMs < 200 ? '快' : args.elapsedMs < 1000 ? '正常' : args.elapsedMs < 5000 ? '慢' : '非常慢'
      lines.push(`耗时: ${args.elapsedMs}ms（${speed}）`)
    }
    if (args.headers) {
      const h = args.headers
      if (h['cache-control'] !== undefined) lines.push(`缓存: cache-control=${h['cache-control']}`)
      if (h['content-type'] !== undefined) lines.push(`内容类型: ${h['content-type']}`)
      if (h['set-cookie'] !== undefined) lines.push(`⚠️ 设置了 Cookie`)
    }
    return { success: true, output: lines.join('\n') }
  },
}

/** 网络工具集（供 Pulse 网络专家注入） */
export const networkTools: Tool[] = [
  httpRequestTool,
  urlParseTool,
  responseAnalyzeTool,
]

// 兼容 expandHome（基础工具同名单，这里保留以备路径类工具扩展）
export { expandHome }
