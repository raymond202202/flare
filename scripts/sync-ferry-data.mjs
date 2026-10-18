#!/usr/bin/env node
/**
 * 把 ferry 项目的 data/*.jsonc 同步成 flare 内嵌的 TS 模块。
 *
 * 为什么要生成 TS 而不是运行期读 JSON：
 * - Electron 打包后代码在 app.asar 里，运行期拼路径读 data/ 容易在打包/签名时漏文件；
 * - 内嵌模块让"装了 flare 就有 ferry"成为编译期事实，不依赖任何外部安装或文件布局。
 *
 * 用法：node scripts/sync-ferry-data.mjs [ferry data 目录]
 * 默认从 $FERRY_DATA_DIR 或 ~/.projects/ferry/data 读取。
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(process.argv[2] || process.env.FERRY_DATA_DIR || join(process.env.HOME || '', '.projects/ferry/data'))
const OUT = resolve(here, '../src/tools/ferry-core/data.generated.ts')

/** 去注释 + 去尾逗号（和 ferry.py 的 load_jsonc 同一套规则） */
function parseJsonc(text) {
  let out = ''
  let i = 0
  let inStr = false
  while (i < text.length) {
    const c = text[i]
    if (inStr) {
      out += c
      if (c === '\\' && i + 1 < text.length) { out += text[i + 1]; i += 2; continue }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') { inStr = true; out += c; i++; continue }
    if (text.startsWith('//', i)) {
      const j = text.indexOf('\n', i)
      i = j < 0 ? text.length : j
      continue
    }
    if (text.startsWith('/*', i)) {
      const j = text.indexOf('*/', i + 2)
      i = j < 0 ? text.length : j + 2
      continue
    }
    out += c
    i++
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

if (!existsSync(SRC)) {
  console.error(`找不到 ferry 数据目录：${SRC}`)
  console.error('用法：node scripts/sync-ferry-data.mjs /path/to/ferry/data')
  process.exit(1)
}

const files = readdirSync(SRC).filter((f) => f.endsWith('.jsonc')).sort()
if (!files.length) {
  console.error(`${SRC} 里没有 .jsonc`)
  process.exit(1)
}

const docs = []
const hash = createHash('sha256')
for (const f of files) {
  const raw = readFileSync(join(SRC, f), 'utf-8')
  hash.update(f).update(raw)
  try {
    docs.push(parseJsonc(raw))
  } catch (e) {
    console.error(`${f}: JSON 解析失败 — ${e.message}`)
    process.exit(1)
  }
}
const digest = hash.digest('hex').slice(0, 16)

const counts = docs.reduce((acc, d) => {
  acc.commands += (d.commands || []).length
  acc.patterns += (d.patterns || []).length
  acc.syntax += (d.syntax || []).length
  acc.pitfalls += (d.pitfalls || []).length
  acc.drills += (d.drills || []).length
  return acc
}, { commands: 0, patterns: 0, syntax: 0, pitfalls: 0, drills: 0 })

const header = `// AUTO-GENERATED — 不要手改。
// 来源：ferry 项目 data/*.jsonc（${files.length} 个文件 / sha256:${digest}）
// 重新生成：node scripts/sync-ferry-data.mjs
// 规模：${counts.commands} 条命令 / ${counts.patterns} 条管道惯用法 / ${counts.syntax} 条语法差异 / ${counts.pitfalls} 个已知坑 / ${counts.drills} 条真机断言
import type { FerryDoc } from './types.js'

export const FERRY_DATA_SHA = '${digest}'
export const FERRY_DATA_FILES = ${JSON.stringify(files)}

export const FERRY_DATA: FerryDoc[] = `

writeFileSync(OUT, header + JSON.stringify(docs) + '\n', 'utf-8')
const kb = (Buffer.byteLength(header + JSON.stringify(docs)) / 1024).toFixed(0)
console.log(`写入 ${OUT}`)
console.log(`  ${files.length} 个文件 → ${counts.commands} 命令 / ${counts.patterns} 惯用法 / ${counts.syntax} 语法 / ${counts.pitfalls} 坑 / ${counts.drills} 断言`)
console.log(`  ${kb} KB, sha256:${digest}`)
