// 冒烟实测（v0.6.50）：真实 McpManager.status() + CLI /mcp 状态行 transport/target 显示
// 临时配置一个 stdio 服务器（mock fixture）+ 一个 HTTP 服务器（in-process startMcpHttpServer）
import { McpManager } from '../dist/index.js'
import { startMcpHttpServer } from '../dist/mcp/http.js'
import { writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOCK_SERVER = path.join(__dirname, 'fixtures', 'mcp-mock-server.mjs')

const h = await startMcpHttpServer({ tools: [] })
const configPath = '/tmp/flare-mcp-status-50.json'
rmSync(configPath, { force: true })
writeFileSync(configPath, JSON.stringify({
  servers: [
    { name: 'local', command: process.execPath, args: [MOCK_SERVER] },
    { name: 'remote', url: h.url },
  ],
}))

const mgr = new McpManager({ configPath })
await Promise.allSettled([mgr.connect('local'), mgr.connect('remote')])
const st = mgr.status()
for (const s of st) {
  console.log(`${s.name}: connected=${s.connected} transport=${s.transport} target=${s.target} tools=${s.toolCount}`)
}
mgr.closeAll()
await h.close()
rmSync(configPath, { force: true })
console.log('SMOKE PASS')
