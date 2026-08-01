/**
 * 网络工具集单元测试（M3 flare 侧交付）
 */
import { describe, it, expect } from 'vitest'
import { httpRequestTool, urlParseTool, responseAnalyzeTool } from '../src/tools/network.js'

describe('网络工具集（M3）', () => {
  it('url_parse：解析 URL 结构', () => {
    const result = urlParseTool.execute({ url: 'https://api.example.com/v1/users?id=42&page=2#top' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('协议: https:')
    expect(result.output).toContain('主机: api.example.com')
    expect(result.output).toContain('路径: /v1/users')
    expect(result.output).toContain('"id": "42"')
  })

  it('url_parse：无效 URL 返回错误', () => {
    const result = urlParseTool.execute({ url: 'not a url' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('解析失败')
  })

  it('response_analyze：状态码分级', () => {
    const ok = responseAnalyzeTool.execute({ statusCode: 200, elapsedMs: 150 })
    expect(ok.output).toContain('✅ 成功')
    expect(ok.output).toContain('快')
    const err = responseAnalyzeTool.execute({ statusCode: 404 })
    expect(err.output).toContain('❌ 客户端错误')
    const server = responseAnalyzeTool.execute({ statusCode: 503 })
    expect(server.output).toContain('❌ 服务端错误')
  })

  it('http_request：危险协议被拦截', async () => {
    const result = await httpRequestTool.execute({ url: 'file:///etc/passwd' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('安全策略拦截')
  })

  it('http_request：真实请求（本地服务）', async () => {
    // 用本地 HTTP 服务验证（Node 内置 http 起一个临时服务）
    const http = await import('node:http')
    const server = http.createServer((req, res) => {
      res.setHeader('x-test-header', 'flare-test')
      res.end('hello from flare network tool')
    })
    await new Promise(resolve => server.listen(0, resolve))
    const port = (server.address() as any).port

    try {
      const result = await httpRequestTool.execute({ url: `http://127.0.0.1:${port}/api?q=1`, timeout: 5000 })
      expect(result.success).toBe(true)
      expect(result.output).toContain('状态码: 200')
      expect(result.output).toContain('x-test-header')
      expect(result.output).toContain('hello from flare network tool')
    } finally {
      server.close()
    }
  })
})
