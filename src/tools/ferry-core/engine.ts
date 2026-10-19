/**
 * ferry 引擎 —— 从 ferry.py 移植的确定性命令翻译器。
 *
 * 移植原则：行为必须与 Python 版一致（同一批数据、同一批用例）。
 * 不一致的地方就是 bug —— tests/ferry-cases.json 是两边共同的裁判。
 *
 * 三类状态：
 *   equivalent   可直接执行
 *   approximate  语义近似，caveats 必须转达
 *   unsupported  无等价，不要执行
 */
import { existsSync, statSync } from 'node:fs'
import { FERRY_DATA, FERRY_DATA_SHA } from './data.generated.js'
import type {
  DrillRaw, EntryRaw, FlagRaw, PatternRaw, Platform, PlatformKey,
  RecipeRaw, SegResult, ShellName, Status, TranslationResult, TranslateOptions,
} from './types.js'

export const SCHEMA = 1
export const VERSION = '0.2.0'
export const PLATFORMS: Platform[] = ['linux', 'macos', 'freebsd', 'windows']
export const PLATFORM_LABEL: Record<string, string> = { linux: 'Linux', macos: 'macOS', freebsd: 'FreeBSD', windows: 'Windows' }
export const DEFAULT_SHELL: Record<string, string> = { linux: 'bash', macos: 'zsh', freebsd: 'sh', windows: 'powershell' }
export const SHELL_FAMILY: Record<string, 'posix' | 'powershell' | 'cmd'> = {
  bash: 'posix', zsh: 'posix', sh: 'posix', dash: 'posix',
  powershell: 'powershell', pwsh: 'powershell', cmd: 'cmd',
}
const STATUS_ORDER: Record<string, number> = { equivalent: 0, approximate: 1, unsupported: 2, error: 3 }

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

export function normalizePlatform(p: string | null | undefined): Platform | null {
  if (!p) return null
  const v = String(p).trim().toLowerCase()
  if (['linux', 'gnu', 'ubuntu', 'debian', 'fedora', 'arch', 'centos', 'rhel'].includes(v)) return 'linux'
  if (['macos', 'mac', 'osx', 'darwin', 'apple'].includes(v)) return 'macos'
  if (['freebsd', 'fbsd', 'bsd', 'free-bsd', 'freebsd13', 'freebsd14', 'freebsd15'].includes(v)) return 'freebsd'
  if (['windows', 'win', 'win32', 'win64', 'nt', 'cmd', 'powershell', 'pwsh'].includes(v)) return 'windows'
  return null
}

export function currentPlatform(): Platform {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'freebsd') return 'freebsd'
  return 'linux'
}

function worst(a: Status, b: Status): Status {
  return (STATUS_ORDER[a] ?? 3) >= (STATUS_ORDER[b] ?? 3) ? a : b
}

/** PATH 里找命令（替代 Python 的 shutil.which，避免额外依赖） */
function which(cmd: string): string | null {
  const path = process.env.PATH || ''
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.ps1'] : ['']
  for (const dir of path.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    for (const ext of exts) {
      const full = `${dir}/${cmd}${ext}`
      try {
        if (existsSync(full) && statSync(full).isFile()) return full
      } catch { /* 忽略权限错误 */ }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 词法：拆复合命令 / 拆 token
// ---------------------------------------------------------------------------

const OPS = ['2>&1', '1>&2', '&>>', '>>', '<<<', '<<', '&&', '||', '|&', '|', ';', '&']

export function splitChain(s: string): Array<{ op: string; text: string }> {
  const out: Array<{ op: string; text: string }> = []
  let buf = ''
  let pendingOp = ''
  let quote: string | null = null
  let depth = 0
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (quote) {
      buf += c
      if (c === '\\' && quote === '"' && i + 1 < s.length) { buf += s[i + 1]; i += 2; continue }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; buf += c; i++; continue }
    if (c === '\\' && i + 1 < s.length) { buf += s.slice(i, i + 2); i += 2; continue }
    if (c === '$' && s[i + 1] === '(') { depth++; buf += '$('; i += 2; continue }
    if (c === '(') { depth++; buf += c; i++; continue }
    if (c === ')' && depth > 0) { depth--; buf += c; i++; continue }
    if (depth === 0) {
      const matched = OPS.find((op) => s.startsWith(op, i))
      if (matched) {
        const text = buf.trim()
        if (text) out.push({ op: pendingOp, text })
        buf = ''
        pendingOp = matched
        i += matched.length
        continue
      }
    }
    buf += c
    i++
  }
  const text = buf.trim()
  if (text) out.push({ op: pendingOp, text })
  return out
}

export function tokenize(seg: string): string[] {
  const toks: string[] = []
  let buf = ''
  let quote: string | null = null
  let i = 0
  while (i < seg.length) {
    const c = seg[i]
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < seg.length) { buf += seg[i + 1]; i += 2; continue }
      if (c === quote) { quote = null; i++; continue }
      buf += c
      i++
      continue
    }
    if (c === "'" || c === '"') { quote = c; i++; continue }
    if (/\s/.test(c)) {
      if (buf) { toks.push(buf); buf = '' }
      i++
      continue
    }
    if (c === '\\' && i + 1 < seg.length && " \"'\\$`".includes(seg[i + 1])) {
      buf += seg[i + 1]; i += 2; continue
    }
    buf += c
    i++
  }
  if (buf) toks.push(buf)
  return toks
}

export function tokenizeQ(seg: string): Array<[string, boolean]> {
  const toks: Array<[string, boolean]> = []
  let buf = ''
  let quote: string | null = null
  let hadQuote = false
  let i = 0
  while (i < seg.length) {
    const c = seg[i]
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < seg.length) { buf += seg[i + 1]; i += 2; continue }
      if (c === quote) { quote = null; i++; continue }
      buf += c
      i++
      continue
    }
    if (c === "'" || c === '"') { quote = c; hadQuote = true; i++; continue }
    if (/\s/.test(c)) {
      if (buf || hadQuote) { toks.push([buf, hadQuote]); buf = ''; hadQuote = false }
      i++
      continue
    }
    if (c === '\\' && i + 1 < seg.length && " \"'\\$`".includes(seg[i + 1])) {
      buf += seg[i + 1]; i += 2; continue
    }
    buf += c
    i++
  }
  if (buf || hadQuote) toks.push([buf, hadQuote])
  return toks
}

export function forceQuote(tok: string, target: string): string {
  if (target === 'windows') {
    if (!tok.includes("'")) return `'${tok}'`
    return `"${tok.replace(/"/g, '`"')}"`
  }
  return `'${tok.replace(/'/g, `'\\''`)}'`
}

export function quoteFor(tok: string, target: string): string {
  if (!tok) return tok
  const needs = /\s/.test(tok) || /['"`$*?[\](){}|&;<>]/.test(tok)
  if (!needs) return tok
  return forceQuote(tok, target)
}

function pathStyleOf(tgt: string, style?: string | null): string {
  if (tgt === 'windows') return 'windows'
  return style || 'wsl'
}

// ---------------------------------------------------------------------------
// 知识库
// ---------------------------------------------------------------------------

export class Entry {
  raw: EntryRaw
  id: string
  category: string
  summary: string
  names: Partial<Record<PlatformKey, string>>
  aliases: Partial<Record<PlatformKey, string[]>>
  flags: FlagRaw[]
  directFlags: Set<string>
  recipes: RecipeRaw[]

  constructor(raw: EntryRaw) {
    this.raw = raw
    this.id = raw.id || ''
    this.category = raw.category || 'misc'
    this.summary = raw.summary || ''
    this.names = raw.names || {}
    this.aliases = raw.aliases || {}
    this.flags = raw.flags || []
    this.directFlags = new Set(raw.direct_flags || [])
    this.recipes = raw.recipes || []
  }

  get hint(): string { return this.raw.hint || '' }
  get universal(): boolean { return Boolean(this.raw.universal) }

  nameFor(platform: string, shell?: string | null): string | null {
    if (platform === 'windows') {
      if (shell === 'cmd') return this.names.windows_cmd || this.names.windows || null
      return this.names.windows || this.names.windows_cmd || null
    }
    return (this.names as Record<string, string | undefined>)[platform] || null
  }

  exactNameFor(platform: string, shell?: string | null): string | null {
    if (platform === 'windows') {
      if (shell === 'cmd') return this.names.windows_cmd || null
      return this.names.windows || null
    }
    return (this.names as Record<string, string | undefined>)[platform] || null
  }
}

export function flagKey(platform: string, shell?: string | null): PlatformKey {
  if (platform === 'windows') return shell === 'cmd' ? 'windows_cmd' : 'windows'
  return platform as PlatformKey
}

export class KB {
  entries: Entry[] = []
  byId = new Map<string, Entry>()
  index = new Map<string, Map<string, { score: number; entry: Entry }>>()
  syntax: unknown[] = []
  pitfalls: unknown[] = []
  patterns: PatternRaw[] = []
  drills: DrillRaw[] = []
  errors: string[] = []
  collisions: string[] = []

  constructor(docs = FERRY_DATA) {
    for (const doc of docs) this.loadDoc(doc)
  }

  private loadDoc(doc: (typeof FERRY_DATA)[number]): void {
    for (const item of doc.commands || []) {
      const e = new Entry(item)
      if (!e.id) { this.errors.push(`${JSON.stringify(e.names)}: 缺少 id`); continue }
      if (this.byId.has(e.id)) { this.errors.push(`重复 id: ${e.id}`); continue }
      this.byId.set(e.id, e)
      this.entries.push(e)
      for (const platform of PLATFORMS) {
        const shells: Array<string | null> = platform === 'windows' ? ['powershell', 'cmd'] : [null]
        for (const sh of shells) {
          const key = platform === 'windows' && sh === 'cmd' ? 'windows_cmd' : (platform as PlatformKey)
          const nm = e.names[key]
          if (!nm) continue
          const bucketKey = `${platform}|${sh || 'posix'}`
          let bucket = this.index.get(bucketKey)
          if (!bucket) { bucket = new Map(); this.index.set(bucketKey, bucket) }
          const aliasKey = key as PlatformKey
          for (const name of [nm.toLowerCase(), ...(e.aliases[aliasKey] || []).map((a) => a.toLowerCase())]) {
            const score = name.replace(/_/g, '') === e.id.replace(/_/g, '').toLowerCase() ? 2 : 1
            const prev = bucket.get(name)
            if (!prev || score > prev.score) {
              if (prev && prev.score === score && prev.entry !== e) {
                this.collisions.push(`${platform}/${sh || 'posix'}: \`${name}\` 同时属于 ${prev.entry.id} 与 ${e.id}（保留前者）`)
              }
              bucket.set(name, { score, entry: e })
            } else if (prev.entry !== e) {
              this.collisions.push(`${platform}/${sh || 'posix'}: \`${name}\` 同时属于 ${prev.entry.id} 与 ${e.id}（保留前者）`)
            }
          }
        }
      }
    }
    this.syntax.push(...(doc.syntax || []))
    this.pitfalls.push(...(doc.pitfalls || []))
    this.patterns.push(...(doc.patterns || []))
    this.drills.push(...(doc.drills || []))
  }

  find2(token: string, platform: string, shell?: string | null): [Entry | null, string | null] {
    const names = [token.toLowerCase()]
    if (token.includes('/')) names.push(token.split('/').pop()!.toLowerCase())
    if (platform === 'windows') {
      const order = shell === 'cmd' ? ['cmd', 'powershell'] : ['powershell', 'cmd']
      for (const sh of order) {
        const table = this.index.get(`windows|${sh}`)
        for (const nm of names) {
          const hit = table?.get(nm)
          if (hit) return [hit.entry, sh]
        }
      }
      return [null, null]
    }
    const table = this.index.get(`${platform}|posix`)
    for (const nm of names) {
      const hit = table?.get(nm)
      if (hit) return [hit.entry, 'posix']
    }
    return [null, null]
  }

  find(token: string, platform: string, shell?: string | null): Entry | null {
    return this.find2(token, platform, shell)[0]
  }

  findAny(token: string): Array<[string, Entry]> {
    const hits: Array<[string, Entry]> = []
    for (const [key, table] of this.index) {
      const rec = table.get(token.toLowerCase())
      if (rec) hits.push([key.split('|')[0], rec.entry])
    }
    return hits
  }

  stats() {
    const cats: Record<string, number> = {}
    let recipes = 0
    for (const e of this.entries) {
      cats[e.category] = (cats[e.category] || 0) + 1
      recipes += e.recipes.length
    }
    return {
      entries: this.entries.length,
      recipes,
      syntax: this.syntax.length,
      pitfalls: this.pitfalls.length,
      patterns: this.patterns.length,
      drills: this.drills.length,
      categories: cats,
    }
  }
}

let cachedKb: KB | null = null
export function getKB(): KB {
  if (!cachedKb) cachedKb = new KB()
  return cachedKb
}

// ---------------------------------------------------------------------------
// 路径 / 变量 / 特殊 token
// ---------------------------------------------------------------------------

/** 顺序有意义：先命中的优先（Python dict 保序的等价物） */
const POSIX_TO_WIN_ROOTS: Array<[string, string | null]> = [
  ['/home', null],
  ['/tmp', '$env:TEMP'],
  ['/var/tmp', '$env:TEMP'],
  ['/dev/null', '$null'],
  ['/proc', null],
  ['/sys', null],
  ['/etc', 'C:\\Windows\\System32\\drivers\\etc'],
  ['/usr/bin', null],
  ['/usr/local/bin', null],
  ['/opt', 'C:\\ProgramData'],
  ['/mnt', null],
  ['/dev', null],
]

export function isPosixPath(tok: string): boolean {
  return /^(~|\.{1,2})?\//.test(tok) || /^~[A-Za-z]/.test(tok)
}

export function isCmdSwitch(tok: string): boolean {
  return /^\/[A-Za-z]{1,2}(:[^\s]*)?$/.test(tok) || tok === '/?' || /^\/[A-Za-z]{1,2}\s$/.test(tok)
}

export function isWinPath(tok: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(tok) || tok.startsWith('\\\\')
}

export function pathToPosix(p: string, style = 'wsl'): [string, string[]] {
  const notes: string[] = []
  const q = p.replace(/\\/g, '/')
  if (q.startsWith('//')) return [q, ['UNC 网络路径在 POSIX 下需先挂载']]
  const m = /^([A-Za-z]):(.*)$/.exec(q)
  if (m) {
    const drive = m[1].toLowerCase()
    const rest = m[2]
    const root = style === 'msys' ? `/${drive}` : `/mnt/${drive}`
    notes.push(`盘符 ${m[1]}: 映射为 ${root}（--path-style=${style === 'msys' ? 'msys' : 'wsl'}）`)
    return [root + rest, notes]
  }
  return [q, notes]
}

export function pathToWindows(p: string): [string, string[]] {
  const notes: string[] = []
  if (p === '/dev/null') return ['$null', ['/dev/null → $null']]
  const m = /^\/(?:mnt\/)?([a-z])(\/.*)?$/.exec(p)
  if (m && (p.startsWith('/mnt/') || /^\/[a-z]\//.test(p))) {
    const drive = m[1].toUpperCase()
    const rest = m[2] || '/'
    return [`${drive}:${rest.replace(/\//g, '\\')}`, notes]
  }
  if (p.startsWith('~') || p.startsWith('/home/') || p.startsWith('/Users/')) {
    const sub = p.replace(/^(~|\/home\/[^/]+|\/Users\/[^/]+)/, '')
    notes.push('家目录映射为 $env:USERPROFILE')
    return ['$env:USERPROFILE' + (sub ? sub.replace(/\//g, '\\') : ''), notes]
  }
  for (const [root, mapped] of POSIX_TO_WIN_ROOTS) {
    if (p === root || p.startsWith(`${root}/`)) {
      if (mapped === null) {
        notes.push(`${root} 在 Windows 无直接等价路径，原样保留`)
        return [p, notes]
      }
      const sub = p.slice(root.length).replace(/^\//, '')
      if (mapped.includes('$env')) {
        notes.push(`${root} 在 Windows 下映射为 ${mapped}（近似）`)
        return [mapped + (sub ? `\\${sub.replace(/\//g, '\\')}` : ''), notes]
      }
      notes.push(`${root} → ${mapped}（近似）`)
      return [mapped + (sub ? `\\${sub.replace(/\//g, '\\')}` : ''), notes]
    }
  }
  notes.push('绝对路径按 C: 根处理（请核对）')
  return [`C:${p.replace(/\//g, '\\')}`, notes]
}

export function convertToken(tok: string, src: string, tgt: string, style: string, caveats: string[]): string {
  if (['/dev/null', '$null', 'NUL'].includes(tok)) {
    if (tgt === 'windows') {
      const out = style !== 'cmd' ? '$null' : 'NUL'
      if (out !== tok) caveats.push(`${tok} → ${out}`)
      return out
    }
    if (src === 'windows') return '/dev/null'
    return tok
  }
  if (src === tgt) return tok
  if (tgt === 'windows' && isPosixPath(tok)) {
    let [out, notes] = pathToWindows(tok)
    if (tok.endsWith('/') && out && !out.endsWith('\\') && !out.endsWith('/')) out += '\\'
    caveats.push(...notes)
    return out.includes(' ') ? quoteFor(out, 'windows') : out
  }
  if (tgt !== 'windows' && isWinPath(tok)) {
    const [out, notes] = pathToPosix(tok, style)
    caveats.push(...notes)
    return out.includes(' ') ? quoteFor(out, 'posix') : out
  }
  let m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(tok)
  if (m && tgt === 'windows') {
    caveats.push(`环境变量 $${m[1]} → $env:${m[1]}`)
    return `$env:${m[1]}`
  }
  m = /^%([A-Za-z_][A-Za-z0-9_]*)%$/.exec(tok)
  if (m && tgt !== 'windows') return `$${m[1]}`
  if (tgt === 'windows' && m) return `$env:${m[1]}`
  return tok
}

export function translateEnvAssign(tok: string, tgt: string): string | null {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(tok)
  if (!m) return null
  if (tgt === 'windows') return `$env:${m[1]}='${m[2]}'`
  return tok
}

// ---------------------------------------------------------------------------
// 单段翻译
// ---------------------------------------------------------------------------

const PREFIXES = new Set(['sudo', 'doas', 'env', 'time', 'command', 'builtin', 'exec', 'nohup'])
const DANGEROUS_FLAGS = new Set(['-delete', '-exec', '-execdir', '-rf', '-fr', '-9', '--delete', '-f'])

function normTokens(tokens: string[]): string[] {
  return tokens.map((t) => (t !== '' && t !== '/' ? t.replace(/\/+$/, '') || '/' : t))
}

export function slotMatch(recipeTok: string, inputTok: string): boolean {
  if (recipeTok === inputTok) return true
  if (recipeTok.startsWith('-') || inputTok.startsWith('-')) return false
  const sw = /^\/[A-Za-z?]{1,3}$/  // 必须行首锚定：Python 用的是 re.match，不是 search
  if (sw.test(recipeTok) || sw.test(inputTok)) return false
  return true
}

function splitPrefix(tokens: string[]): string[] {
  let i = 0
  while (i < tokens.length && (PREFIXES.has(tokens[i]) || /^[A-Za-z_]\w*=\S*$/.test(tokens[i]))) i++
  return tokens.slice(i)
}

/** recipe 与输入的"动词位"是否互斥（install vs update 这类同位置纯单词）。 */
function verbConflict(rt: string[], want: string[]): boolean {
  const rc = splitPrefix(rt)
  const wc = splitPrefix(want)
  if (rc.length < 2 || wc.length < 2) return false
  const a = rc[1], b = wc[1]
  if (a === b) return false
  const pure = /^[a-z][a-z0-9-]*$/
  return pure.test(a) && pure.test(b)
}

export function recipeMatch(entry: Entry, srcKey: string, tokens: string[]): RecipeRaw | null {
  const want = normTokens(tokens)
  const src = srcKey as keyof RecipeRaw
  for (const r of entry.recipes) {
    const s = r[src] as string | null | undefined
    if (!s) continue
    const rt = normTokens(tokenize(s))
    if (rt.length !== want.length) continue
    if (rt.every((t, i) => t === want[i])) return r
  }
  // 模糊轮：示例值当槽位，但动词位互斥时跳过——否则 `apt install nginx`
  // 会被 3 token 的 `sudo apt update` 吃掉，输出 `pkg nginx`。
  for (const r of entry.recipes) {
    const s = r[src] as string | null | undefined
    if (!s) continue
    const rt = normTokens(tokenize(s))
    if (rt.length !== want.length) continue
    if (verbConflict(rt, want)) continue
    if (rt.every((t, i) => slotMatch(t, want[i]))) return r
  }
  return null
}

function substituteRecipeLiterals(val: string, recipe: RecipeRaw, srcKey: string, inputToks: string[]): string {
  const s = recipe[srcKey as keyof RecipeRaw] as string | null | undefined
  const rt = tokenize(s || '')
  if (!rt.length || rt.length !== inputToks.length) return val
  for (let i = 0; i < rt.length; i++) {
    const a = rt[i]
    const b = inputToks[i]
    if (a === b || a.startsWith('-') || b.startsWith('-') || a.length < 2) continue
    const pattern = new RegExp(`(?<![\\w./\\\\-])${escapeRe(a)}(?![\\w/\\\\-])`)
    val = val.replace(pattern, () => b)  // 函数形式：避免 $& 与反斜杠被当成替换语法
  }
  return val
}

function preserveTrailingSlash(val: string, inputToks: string[]): string {
  for (const t of inputToks) {
    if (!t.endsWith('/') || t.length < 2) continue
    const base = t.replace(/\/+$/, '')
    if (!base) continue
    const pattern = new RegExp(`(?<![\\w./\\\\-])${escapeRe(base)}(?![\\w./\\\\-])`)
    val = val.replace(new RegExp(pattern.source, 'g'), `${base}/`)
  }
  return val
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function splitFlagValue(tok: string): [string, string | null] {
  if (tok.startsWith('--') && tok.includes('=')) {
    const idx = tok.indexOf('=')
    return [tok.slice(0, idx), tok.slice(idx + 1)]
  }
  return [tok, null]
}

function translateFlags(
  args: string[], entry: Entry, srcKey: string, tgtKey: string, tgt: string, shellTgt: string,
): { out: string[]; caveats: string[]; unknown: boolean; dropped: Set<string> } {
  const caveats: string[] = []
  const out: string[] = []
  let unknown = false
  const dropped = new Set<string>()

  type FlagHit = { f: FlagRaw; extra: number; ex: string[] }
  const table = new Map<string, FlagHit>()
  for (const f of entry.flags) {
    const s = f[srcKey as keyof FlagRaw] as string | null | undefined
    if (!s) continue
    const parts = s.split(/\s+/).filter((t) => t !== '')
    if (!parts.length) continue
    // 数据里的参数常写成 "-c %s" / "-n 100"（带示例值）：按首 token 建索引，
    // 记下后面有几个示例值 token，输入里才认得出这个参数吃了几个值
    table.set(parts[0], { f, extra: parts.length - 1, ex: parts.slice(1) })
  }

  const targetTokens = (f: FlagRaw): string[] => {
    const t = f[tgtKey as keyof FlagRaw] as string | null | undefined
    if (t === null || t === undefined) return []
    return t ? t.split(/\s+/) : []
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const hit = table.get(a)
    if (hit) {
      const { f, extra, ex } = hit
      const tts = targetTokens(f)
      if (extra === 0) {
        if (!tts.length) caveats.push(`参数 ${a} 在目标平台无直接对应，已丢弃（${f.semantic || ''}）`)
        out.push(...tts)
        continue
      }
      // 参数带示例值（大多是格式符，如 %s / %Lp）：只有输入与示例完全一致才整体替换，
      // 否则会把用户的真实值（行数、路径）错误地换成示例值
      const userVals = args.slice(i + 1, i + 1 + extra)
      const sameAsExample = userVals.length === extra && userVals.every((v, k) => v === ex[k])
      if (sameAsExample) {
        if (!tts.length) caveats.push(`参数 ${a} ${ex.join(' ')} 在目标平台无直接对应，已丢弃（${f.semantic || ''}）`)
        out.push(...tts)
        i += extra
        continue
      }
      if (!tts.length) {
        // 目标平台没这个参数、值又是用户自己的：整段吞掉会静默改语义，保留并提示
        caveats.push(`参数 ${a} ${userVals.join(' ')} 在目标平台无直接对应，原样保留，执行前务必核对（${f.semantic || ''}）`)
        out.push(a, ...userVals)
        i += extra
        continue
      }
      // 目标参数也吃值：保留用户的值，只换开关部分
      out.push(...tts.slice(0, Math.max(1, tts.length - extra)), ...userVals)
      i += extra
      continue
    }
    const [key, val] = splitFlagValue(a)
    if (key !== a && table.has(key)) {
      const tts = targetTokens(table.get(key)!.f)
      if (tts.length) {
        out.push(...tts)
        if (val !== null) out.push(val)
      }
      continue
    }
    // POSIX 组合短参数 -la
    if (srcKey !== 'windows' && srcKey !== 'windows_cmd' && /^-[A-Za-z]{2,}$/.test(a)) {
      const expanded: string[] = []
      const lost: string[] = []
      let ok = true
      for (const ch of a.slice(1)) {
        const single = `-${ch}`
        if (table.has(single)) {
          const tts = targetTokens(table.get(single)!.f)
          if (tts.length) expanded.push(...tts)
          else lost.push(single)
        } else { ok = false; break }
      }
      if (ok && lost.length) caveats.push(`参数 ${lost.join(', ')} 在目标平台无对应，已丢弃`)
      if (ok) {
        if (!lost.length && expanded.length === a.length - 1 && expanded.every((t, i) => t === `-${a[i + 1]}`)) {
          out.push(a)
        } else {
          out.push(...expanded)
        }
        continue
      }
    }
    if (['--help', '-h', '-?', '/?', '--version', '-V'].includes(a)) { out.push(a); continue }
    if (a.startsWith('-') && tgt === 'windows' && shellTgt === 'cmd') {
      caveats.push(`参数 ${a} 是 POSIX 风格，cmd.exe 不识别`)
      unknown = true
      out.push(a)
      continue
    }
    if (/^--?[A-Za-z][A-Za-z0-9_-]*(=.*)?$/.test(a) && tgt === 'windows' && srcKey !== 'windows' && srcKey !== 'windows_cmd') {
      dropped.add(a)
      caveats.push(`参数 ${a} 在 ${shellTgt} 无对应，已丢弃 —— 请核对结果是否符合原意`)
      continue
    }
    if (isCmdSwitch(a) && tgt !== 'windows' && !isPosixPath(a)) {
      caveats.push(`参数 ${a} 疑似 cmd 开关，POSIX 不识别`)
      unknown = true
      out.push(a)
      continue
    }
    out.push(a)
  }
  return { out, caveats, unknown, dropped }
}

export function translateSegment(seg: string, src: string, tgt: string, shellTgt: string, kb: KB, style: string): SegResult {
  const tq = tokenizeQ(seg)
  const tokens = tq.map(([v]) => v)
  if (!tokens.length) {
    return { input: seg, operator: '', command: null, status: 'equivalent', kind: 'passthrough', caveats: [], notes: [] }
  }

  let caveats: string[] = []
  const notes: string[] = []

  const prefix: string[] = []
  let idx = 0
  while (idx < tokens.length && (PREFIXES.has(tokens[idx]) || translateEnvAssign(tokens[idx], tgt))) {
    prefix.push(tokens[idx])
    idx++
  }
  if (idx >= tokens.length) {
    return { input: seg, operator: '', command: null, status: 'unsupported', kind: 'unsupported', caveats: ['仅有前缀，无实际命令'], notes: [] }
  }

  const head = tokens[idx]
  const args = tokens.slice(idx + 1)
  const quotedVals = new Set(tq.slice(idx + 1).filter(([v, q]) => q && v).map(([v]) => v))
  const [entryFound, srcShell] = kb.find2(head, src, null)
  let entry = entryFound

  const srcKey = flagKey(src, srcShell)
  const tgtKey = flagKey(tgt, shellTgt)

  // 1) recipe 命中
  if (entry) {
    const r = recipeMatch(entry, srcKey, tokens.slice(idx))
    if (r) {
      let val = r[tgtKey as keyof RecipeRaw] as string | null | undefined
      const status = (r.status || 'equivalent') as Status
      caveats = [...(r.caveats || [])]
      if (val === null || val === undefined) {
        const alt = entry.exactNameFor(tgt, shellTgt)
        return {
          input: seg, operator: '', command: null, status: 'unsupported', kind: 'unsupported',
          caveats: [...caveats, `${PLATFORM_LABEL[tgt]} / ${shellTgt} 无等价命令`], notes,
        }
      }
      val = substituteRecipeLiterals(val, r, srcKey, tokens.slice(idx))
      if (tgt !== 'windows') val = preserveTrailingSlash(val, tokens.slice(idx))
      return { input: seg, operator: '', command: val, status, kind: 'recipe', caveats, notes }
    }
  }

  // 2) 无条目：判同名 / 未知
  if (!entry) {
    const hits = kb.findAny(head)
    if (!hits.length) {
      if (which(head) && tgt === currentPlatform()) {
        return { input: seg, operator: '', command: seg, status: 'equivalent', kind: 'passthrough', caveats: ['本机已存在该命令，原样执行'], notes }
      }
      return { input: seg, operator: '', command: null, status: 'unsupported', kind: 'unsupported', caveats: [`映射库未收录 \`${head}\`，无法确定性翻译`], notes }
    }
    const tgtNames = new Set(hits.map(([, e]) => e.nameFor(tgt, shellTgt)).filter(Boolean) as string[])
    if (tgtNames.has(head)) {
      return { input: seg, operator: '', command: seg, status: 'equivalent', kind: 'passthrough', caveats: [`\`${head}\` 在目标平台同名可用`], notes }
    }
    entry = hits[0][1]
  }

  const tgtName = entry.exactNameFor(tgt, shellTgt)
  if (!tgtName) {
    const fb = entry.nameFor(tgt, null)
    let msg = `${PLATFORM_LABEL[tgt]}/${shellTgt} 无直接等价命令`
    if (entry.hint) msg += `；替代：${entry.hint}`
    else if (fb) msg += `；PowerShell 可用：${fb}`
    caveats.push(msg)
    return { input: seg, operator: '', command: null, status: 'unsupported', kind: 'unsupported', caveats, notes }
  }

  // 3) flag / 参数级翻译
  let outArgs: string[]
  let fcaveats: string[]
  let unknown = false
  let dropped = new Set<string>()
  if (entry.universal) {
    outArgs = [...args]
    fcaveats = []
  } else {
    const r = translateFlags(args, entry, srcKey, tgtKey, tgt, shellTgt)
    outArgs = r.out
    fcaveats = r.caveats
    unknown = r.unknown
    dropped = r.dropped
  }
  caveats.push(...fcaveats)
  const dangerousDropped = [...dropped].filter((d) => DANGEROUS_FLAGS.has(d))
  if (dangerousDropped.length) {
    caveats.push(`丢弃的参数 ${dangerousDropped.sort().join(', ')} 会影响语义，不能只删参数了事`)
    return { input: seg, operator: '', command: null, status: 'unsupported', kind: 'unsupported', caveats, notes }
  }

  const flagTokens = new Set<string>()
  for (const f of entry.flags) {
    const v = f[tgtKey as keyof FlagRaw] as string | null | undefined
    if (v) v.split(/\s+/).forEach((t) => flagTokens.add(t))
  }
  const converted: string[] = []
  let changedPath = false
  for (const a of outArgs) {
    if (flagTokens.has(a)) { converted.push(a); continue }
    if (a === '') { converted.push(tgt !== 'windows' ? "''" : '""'); continue }
    const val = convertToken(a, src, tgt, style, caveats)
    const final = quotedVals.has(a) ? forceQuote(val, tgt) : val
    if (final !== a) changedPath = true
    converted.push(final)
  }

  let targetTokens = [tgtName, ...converted]

  if (prefix.length) {
    if (tgt === 'windows') {
      for (const p of prefix) {
        if (p === 'sudo') caveats.push('Windows 无 sudo：需以管理员身份运行（Start-Process -Verb RunAs）')
        else if (p === 'nohup') caveats.push('nohup 在 Windows 无等价：用 Start-Process 或计划任务')
      }
    } else {
      targetTokens = [...prefix, ...targetTokens]
    }
  }

  let status: Status = unknown || caveats.length || changedPath ? 'approximate' : 'equivalent'
  if (!unknown && entry.directFlags.size && args.every((a) => entry!.directFlags.has(a) || (a.startsWith('--') && entry!.directFlags.has(a)))) {
    status = 'equivalent'
  }

  let kind: SegResult['kind'] = 'flags'
  if (entry.universal && tgtName === head) {
    kind = 'passthrough'
    status = 'equivalent'
    caveats.push('三平台同名，仅需注意 shell 差异')
  }

  return { input: seg, operator: '', command: targetTokens.join(' '), status, kind, caveats, notes }
}

// ---------------------------------------------------------------------------
// caveat 平台过滤
// ---------------------------------------------------------------------------

const PLATFORM_WORDS: Record<string, RegExp> = {
  windows: /PowerShell|PS ?5\.1|\bcmd\.exe\b|Select-String|Get-[A-Z]\w+|Remove-Item|Copy-Item|Start-Process|注册表|回收站|Windows|Win32|icacls|winget|\bNUL\b|tasklist|findstr/,
  macos: /macOS|OS X|launchctl|Homebrew|brew |plutil|shasum|diskutil|-j -f|ditto|\bpbpaste\b|\/Applications|~\/Library|\/Volumes/,
  freebsd: /FreeBSD|BSD|\/usr\/home|rc\.conf|sysrc|\bpkg (install|delete|search|info|upgrade)\b|ports|\bjail\b|pf\.conf|sockstat|\bfetch\b|\btruss\b|\/usr\/local\/etc|gpart/,
  linux: /Linux|GNU|systemd|systemctl|\bdnf\b|\bapt\b|\/proc|\/etc\/|\byum\b|netstat|\biproute\b/,
}

export function filterCaveats(caveats: string[], target: string): string[] {
  return caveats.filter((c) => {
    const mentioned = Object.keys(PLATFORM_WORDS).filter((p) => PLATFORM_WORDS[p].test(c))
    return !mentioned.length || mentioned.includes(target)
  })
}

function sameCommand(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  const strip = (s: string) => tokenize(s).map((t) => t.replace(/^['"]|['"]$/g, ''))
  const ta = strip(a)
  const tb = strip(b)
  return ta.length === tb.length && ta.every((t, i) => t === tb[i])
}

// ---------------------------------------------------------------------------
// 管道惯用法
// ---------------------------------------------------------------------------

const WILD = /\{[a-z_][a-z0-9_]*\}/g

function matchPattern(template: string, tokens: string[]): Record<string, string> | null {
  const tl = tokenize(template)
  if (tl.length !== tokens.length) return null
  const caps: Record<string, string> = {}
  for (let i = 0; i < tl.length; i++) {
    const t = tl[i]
    if (/^\{[a-z_][a-z0-9_]*\}$/.test(t)) caps[t.slice(1, -1)] = tokens[i]
    else if (t !== tokens[i]) return null
  }
  return caps
}

function fill(template: string, caps: Record<string, string>): string {
  return template.replace(WILD, (m) => caps[m.slice(1, -1)] ?? m)
}

function tryPatterns(cmd: string, src: string, tgt: string, shell: string, kb: KB): SegResult | null {
  const tokens = tokenize(cmd)
  let keys: PlatformKey[] = [flagKey(src, null)]
  const tkey = flagKey(tgt, shell)
  if (src === 'windows') keys = ['windows', 'windows_cmd']
  for (const pat of kb.patterns) {
    for (const k of keys) {
      const tpl = pat[k as keyof PatternRaw] as string | null | undefined
      if (!tpl) continue
      const caps = matchPattern(tpl, tokens)
      if (!caps) continue
      const out = pat[tkey as keyof PatternRaw] as string | null | undefined
      if (out === null || out === undefined) {
        return {
          input: cmd, operator: '', command: null, status: 'unsupported', kind: 'unsupported',
          caveats: [...(pat.caveats || []), `${PLATFORM_LABEL[tgt]}/${shell} 下没有这条命令的等价写法`], notes: [],
        }
      }
      return {
        input: cmd, operator: '', command: fill(out, caps), status: (pat.status || 'equivalent') as Status,
        kind: 'pattern', caveats: [...(pat.caveats || [])], notes: [],
      }
    }
  }
  return null
}

function detectSource(firstTok: string, kb: KB, _target: string): [Platform, boolean] {
  const cur = currentPlatform()
  if (kb.find(firstTok, cur, null)) return [cur, false]
  const hits = new Set(kb.findAny(firstTok).map(([p]) => p as Platform))
  hits.delete(cur)
  if (hits.size === 1) return [[...hits][0], true]
  if (hits.size) return [[...hits].sort()[0], true]
  return [cur, true]
}

function opFor(targetShell: string, op: string): [string, string[]] {
  const caveats: string[] = []
  if (!op) return ['', caveats]
  const fam = SHELL_FAMILY[targetShell] || 'posix'
  if (fam === 'powershell') {
    if (op === '&&' || op === '||') caveats.push(`PowerShell 5.1 不支持 \`${op}\`，需 PS7+ 或改写为 ; if ($?) { ... }`)
    if (op === '|&') {
      caveats.push('PowerShell 无 |&，用 2>&1 |')
      return ['2>&1 |', caveats]
    }
  }
  if (fam === 'cmd' && (op === '&&' || op === '||') && op === '||') caveats.push('cmd.exe 无 ||')
  return [op, caveats]
}

// ---------------------------------------------------------------------------
// 顶层入口
// ---------------------------------------------------------------------------

export function translateCommand(opts: TranslateOptions): TranslationResult {
  const input = String(opts.command || '')
  const tgt = normalizePlatform(String(opts.target)) || 'linux'
  let shell = String(opts.shell || DEFAULT_SHELL[tgt] || 'bash').toLowerCase()
  if (shell === 'pwsh') shell = 'powershell'
  const style = pathStyleOf(tgt, opts.pathStyle)

  const parts = splitChain(input)
  if (!parts.length) {
    return {
      schema: SCHEMA, input, source: (opts.source as Platform) || currentPlatform(), target: tgt, shell,
      status: 'error', command: null, confidence: 'none', inferred: false, llmUsed: false,
      caveats: ['空命令'], notes: [], segments: [],
    }
  }

  let src = normalizePlatform(String(opts.source || '')) || null
  let inferred = false
  if (!src) {
    const firstToks = tokenize(parts[0].text)
    const [s, inf] = detectSource(firstToks[0] || '', getKB(), tgt)
    src = s
    inferred = inf
  }

  const segs: SegResult[] = []
  let status: Status = 'equivalent'

  // 0) 整体管道惯用法优先
  const pat = tryPatterns(input, src, tgt, shell, getKB())
  if (pat) {
    pat.caveats = filterCaveats(pat.caveats, tgt)
    if (pat.status === 'approximate' && !pat.caveats.length && sameCommand(pat.command, pat.input)) pat.status = 'equivalent'
    return {
      schema: SCHEMA, input, source: src, target: tgt, shell, status: pat.status, command: pat.command,
      confidence: pat.status === 'equivalent' ? 'high' : pat.status === 'approximate' ? 'medium' : 'none',
      inferred, llmUsed: false, caveats: pat.caveats,
      notes: inferred ? [`源平台未指定，按命令名推断为 ${PLATFORM_LABEL[src]}`] : [],
      segments: [pat],
    }
  }

  for (const { op, text } of parts) {
    if (!text) continue
    const seg = translateSegment(text, src, tgt, shell, getKB(), style)
    const [tgtOp, opCaveats] = opFor(shell, op)
    seg.operator = tgtOp
    if (opCaveats.length) {
      seg.caveats.push(...opCaveats)
      if (seg.status === 'equivalent') seg.status = 'approximate'
    }
    segs.push(seg)
    status = worst(status, seg.status)
  }

  // caveat 按目标平台过滤；近似状态若唯一理由是别的平台的坑、且命令没变 → 其实是等价
  status = 'equivalent'
  for (const s of segs) {
    s.caveats = filterCaveats(s.caveats, tgt)
    if (s.status === 'approximate' && !s.caveats.length && sameCommand(s.command, s.input)) s.status = 'equivalent'
    status = worst(status, s.status)
  }
  if (segs.some((s) => s.status === 'unsupported')) status = 'unsupported'

  let command: string | null = null
  if (status !== 'unsupported') {
    const chunks: string[] = []
    for (const s of segs) {
      if (s.command === null) continue
      if (chunks.length && s.operator) chunks.push(s.operator)
      chunks.push(s.command)
    }
    command = chunks.length ? chunks.join(' ') : null
  }

  const seen = new Set<string>()
  const uniq: string[] = []
  for (const c of segs.flatMap((s) => s.caveats)) {
    if (!seen.has(c)) { seen.add(c); uniq.push(c) }
  }

  return {
    schema: SCHEMA, input, source: src, target: tgt, shell, status, command,
    confidence: status === 'equivalent' ? 'high' : status === 'approximate' ? 'medium' : 'none',
    inferred, llmUsed: false, caveats: uniq,
    notes: inferred ? [`源平台未指定，按命令名推断为 ${PLATFORM_LABEL[src]}`] : [],
    segments: segs,
  }
}

export type { Platform, ShellName, Status }
export { FERRY_DATA_SHA }
