#!/usr/bin/env node
/**
 * 内嵌引擎与 Python 参考实现的行为对照。
 * 用法：npx tsx scripts/ferry-parity.mjs [cases.json]
 */
import { readFileSync } from 'node:fs'
import { translateCommand } from '../src/tools/ferry-core/engine.ts'

const cases = JSON.parse(readFileSync(process.argv[2] || 'tests/fixtures/ferry-cases.json', 'utf-8'))
let bad = 0
const byKind = {}
for (const c of cases) {
  const got = translateCommand({ command: c.input, target: c.target, shell: c.shell || undefined })
  const diff = []
  if (got.status !== c.status) diff.push(`status ${c.status} → ${got.status}`)
  if ((got.command || null) !== c.command) diff.push(`command ${JSON.stringify(c.command)} → ${JSON.stringify(got.command)}`)
  if (JSON.stringify(got.caveats) !== JSON.stringify(c.caveats)) diff.push(`caveats ${JSON.stringify(c.caveats)} → ${JSON.stringify(got.caveats)}`)
  if (diff.length) {
    bad++
    const kind = c.status
    byKind[kind] = (byKind[kind] || 0) + 1
    if (bad <= 25) console.log(`✗ [${c.target}${c.shell ? '/' + c.shell : ''}] ${c.input}\n   ${diff.join('\n   ')}`)
  }
}
console.log(`\n${cases.length - bad}/${cases.length} 一致，${bad} 处不一致`, byKind)
process.exit(bad ? 1 : 0)
