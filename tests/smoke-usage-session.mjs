// 冒烟实测（v0.6.49）：真实 MemoryStore + dist handleSlashCommand —— /usage 本会话行缓存命中显示
import { handleSlashCommand } from '../dist/cli/index.js'
import { MemoryStore } from '../dist/index.js'
import { rmSync } from 'node:fs'

const dbPath = '/tmp/flare-usage-smoke-49.db'
try { rmSync(dbPath, { force: true }) } catch { /* ignore */ }
const store = new MemoryStore(dbPath)
store.logUsage('smoke-s1', 1000, 500, 'deepseek-chat', { cacheReadTokens: 400 })
const lines = []
await handleSlashCommand('/usage', store, (s) => lines.push(s), undefined, undefined, undefined, undefined, undefined, 'smoke-s1')
console.log(lines.join('\n'))
store.close()
