// 冒烟实测（v0.6.49 起）：真实 MemoryStore + dist handleSlashCommand —— /usage 本会话行缓存命中显示
// v0.6.64~66 扩展：断言缓存节省金额（总览/本会话/perModel 行）与 /help 同步描述
import { handleSlashCommand } from '../dist/cli/index.js'
import { MemoryStore } from '../dist/index.js'
import { rmSync } from 'node:fs'

const dbPath = '/tmp/flare-usage-smoke-49.db'
try { rmSync(dbPath, { force: true }) } catch { /* ignore */ }
const store = new MemoryStore(dbPath)
store.logUsage('smoke-s1', 1000, 500, 'deepseek-chat', { cacheReadTokens: 400 })

// /usage：本会话行 + 节省金额断言（400 命中 → 400/1e6 * 0.2 = 0.00008 → $0.0001）
let lines = []
await handleSlashCommand('/usage', store, (s) => lines.push(s), undefined, undefined, undefined, undefined, undefined, 'smoke-s1')
let out = lines.join('\n')
console.log(out)
if (!out.includes('缓存命中 400')) throw new Error('SMOKE FAIL: 本会话行缺缓存命中')
if (!out.includes('缓存节省')) throw new Error('SMOKE FAIL: 缺缓存节省金额')
if (!out.includes('（节省 $0.0001）')) throw new Error('SMOKE FAIL: perModel 子行缺节省金额')

// /help：/usage 描述含缓存命中/节省（v0.6.66）
lines = []
await handleSlashCommand('/help', store, (s) => lines.push(s))
out = lines.join('\n')
if (!out.includes('/usage') || !out.includes('缓存命中/节省')) throw new Error('SMOKE FAIL: /help 缺 /usage 缓存节省说明')

console.log('SMOKE PASS')
store.close()
