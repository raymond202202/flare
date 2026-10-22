/**
 * 命令风险分级（v0.6.155）
 *
 * 背景：FLARE问题记录追加条目 #14 / #15 / #16 暴露的两类问题——
 *   1) 用整条命令做正则匹配，既误伤（heredoc 里写文档提到 `pkill -f` 就被拦、
 *      命令行里出现 wget 一词就拦），又漏拦（gh repo delete、rm -rf 放行）；
 *   2) 全部只有「拦/放」两档，没有「不可逆但合理」的确认档。
 *
 * 本模块的解法：
 *   - 真正的 shell 分段：识别 heredoc 正文、单/双引号、注释、重定向，
 *     只在**命令位**上做判定（`echo rm -rf /` 不算，`rm -rf /` 算）。
 *   - 三档分级：block（绝不执行）/ confirm（不可逆，需确认）/ safe。
 *   - confirm 档支持会话级与永久放行，规则 id 粒度（放行 git-push 不等于放行 gh-repo-delete）。
 */

export type RiskLevel = 'safe' | 'confirm' | 'block'

export interface RiskVerdict {
  level: RiskLevel
  /** 命中的规则 id（safe 时为空） */
  rule?: string
  /** 人类可读的拦截/确认原因 */
  reason?: string
  /** 命中的命令段（便于提示「哪一段出的问题」） */
  segment?: string
}

export type Sep = 'start' | ';' | '&&' | '||' | '|' | '&' | 'newline' | '(' | ')'

export interface CommandSegment {
  /** 原始段文本（保留引号与重定向） */
  raw: string
  /** 命令名（去引号、剥离 sudo/env/VAR= 前缀；无法确定时为空串） */
  name: string
  /** 命令名之后的参数（原始文本） */
  argText: string
  /** 段前分隔符（用于管道链判定） */
  sepBefore: Sep
  /** 段内是否含命令替换 / 反引号（动态命令，静态判定不可靠） */
  dynamic: boolean
}

/** 会被透明剥离的命令前缀（不改变「真正执行的是谁」） */
const PREFIX_WORDS = new Set([
  'sudo', 'doas', 'env', 'nohup', 'time', 'command', 'builtin', 'exec',
  'nice', 'ionice', 'stdbuf', 'setsid', 'then', 'do', 'else', 'if', 'while',
])

const SEPARATOR_CHARS = new Set([';', '&', '|', '(', ')', '\n'])

function stripQuotes(s: string): string {
  let out = s.trim()
  // 反复剥掉包住整个 token 的引号
  for (let i = 0; i < 3; i++) {
    if (
      (out.startsWith('"') && out.endsWith('"') && out.length >= 2) ||
      (out.startsWith("'") && out.endsWith("'") && out.length >= 2)
    ) {
      out = out.slice(1, -1)
    } else break
  }
  return out
}

/** 取段内第一个 token 作为命令名（不进入引号语义，引号内首 token 也照剥） */
function firstToken(rest: string): { token: string; tail: string } {
  const m = /^([^\s;&|()]+)\s*/.exec(rest)
  if (!m) return { token: '', tail: rest }
  return { token: m[1], tail: rest.slice(m[0].length) }
}

function makeSegment(raw: string, sep: Sep, dynamic: boolean): CommandSegment {
  let rest = raw.trim()
  let name = ''
  for (let guard = 0; guard < 10; guard++) {
    // VAR=value 赋值前缀
    const assign = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*/.exec(rest)
    if (assign) {
      rest = rest.slice(assign[0].length)
      continue
    }
    const { token, tail } = firstToken(rest)
    if (!token) break
    const bare = stripQuotes(token)
    if (PREFIX_WORDS.has(bare)) {
      rest = tail
      // sudo/doas 的短选项与其值（-u root / -E）
      if (bare === 'sudo' || bare === 'doas') {
        const opt = /^-(?:u|g|p|C|h|U)\s+\S+\s*|^-[A-Za-z]+\s*/.exec(rest)
        if (opt) rest = rest.slice(opt[0].length)
      }
      continue
    }
    name = bare
    rest = tail
    break
  }
  return { raw, name, argText: rest, sepBefore: sep, dynamic }
}

/**
 * 把命令行切成「命令段」，并丢弃 heredoc 正文、注释与重定向目标。
 *
 * 之所以必须做这一步：#14 记录的误报（在 heredoc 里写文档、内容提及 pkill）
 * 与 #16 补充（heredoc 写入被拦）都源于把「脚本文本」当成「要执行的命令」。
 */
export function parseCommandSegments(input: string): CommandSegment[] {
  const src = input.replace(/\r\n?/g, '\n')
  const segs: CommandSegment[] = []
  let buf = ''
  let sep: Sep = 'start'
  let dynamic = false
  let i = 0
  const pendingHeredocs: Array<{ delim: string; stripTabs: boolean }> = []

  const push = () => {
    const raw = buf.trim()
    if (raw) segs.push(makeSegment(raw, sep, dynamic))
    buf = ''
    dynamic = false
  }

  while (i < src.length) {
    const ch = src[i]

    // heredoc 起始记号：<<EOF / <<-'EOF' / <<<（herestring 不进入 heredoc 语义）
    if (ch === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      const m = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9_.\-\\]+))/.exec(src.slice(i))
      if (m) {
        const delim = m[2] ?? m[3] ?? m[4] ?? ''
        if (delim) pendingHeredocs.push({ delim, stripTabs: m[1] === '-' })
        buf += m[0]
        i += m[0].length
        continue
      }
    }

    if (ch === '\\') {
      buf += src.slice(i, i + 2)
      i += 2
      continue
    }

    if (ch === "'") {
      const end = src.indexOf("'", i + 1)
      const stop = end === -1 ? src.length : end + 1
      buf += src.slice(i, stop)
      i = stop
      continue
    }

    if (ch === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === '`') dynamic = true
        if (src[j] === '$' && src[j + 1] === '(') dynamic = true
        j++
      }
      const stop = Math.min(j + 1, src.length)
      buf += src.slice(i, stop)
      i = stop
      continue
    }

    // 注释：仅当 # 处于词首（前面是空白或行首）时生效
    if (ch === '#' && (buf === '' || /\s$/.test(buf))) {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl + 1
      if (!pendingHeredocs.length) {
        push()
        sep = 'newline'
      }
      continue
    }

    // 重定向：连同「目标」一起吞掉，避免 `2>&1` 里的 & 被当成分隔符
    if (ch === '>' || ch === '<') {
      const m = /^(?:>>|>|<)\s*(?:&(?:\d+|-)|[^\s;&|()]*)/.exec(src.slice(i))
      if (m) {
        buf += m[0]
        i += m[0].length
        continue
      }
    }

    if (ch === '$' && src[i + 1] === '(') dynamic = true
    if (ch === '`') dynamic = true

    if (SEPARATOR_CHARS.has(ch)) {
      // 组合分隔符
      if (ch === '&' && src[i + 1] === '&') {
        push(); sep = '&&'; i += 2; continue
      }
      if (ch === '|' && src[i + 1] === '|') {
        push(); sep = '||'; i += 2; continue
      }
      if (ch === '|' && src[i + 1] === '&') {
        push(); sep = '|'; i += 2; continue
      }

      const isNewline = ch === '\n'
      push()

      if (isNewline && pendingHeredocs.length) {
        // 消费 heredoc 正文——正文是数据，不是命令
        i++
        for (const hd of pendingHeredocs.splice(0)) {
          while (i < src.length) {
            let nl = src.indexOf('\n', i)
            if (nl === -1) nl = src.length
            const line = src.slice(i, nl)
            i = nl < src.length ? nl + 1 : nl
            const cmp = hd.stripTabs ? line.replace(/^\t+/, '') : line
            if (cmp.trimEnd() === hd.delim) break
          }
        }
        sep = 'newline'
        continue
      }

      sep = (isNewline ? 'newline' : (ch as Sep))
      i++
      continue
    }

    buf += ch
    i++
  }

  push()
  return segs
}

/** 去掉 heredoc 正文后的「纯命令文本」（供整串模式匹配，避免脚本文本误伤） */
export function commandPlainText(input: string): string {
  return parseCommandSegments(input).map((s) => s.raw).join('\n')
}

const DOWNLOADERS = new Set(['curl', 'wget', 'aria2c', 'fetch', 'http', 'httpie', 'xh'])
const INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'node',
  'perl', 'ruby', 'php', 'pwsh', 'powershell',
])
const FORCE_FS_ROOTS = new Set([
  '/', '/*', '~', '~/', '$HOME', '${HOME}', '/home', '/usr', '/etc', '/var',
  '/boot', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/srv', '/root', '/dev',
])
const POWER_WORDS = new Set(['shutdown', 'reboot', 'halt', 'poweroff'])
const PROD_SYSTEMCTL = new Set(['reboot', 'poweroff', 'halt', 'kexec', 'rescue', 'emergency', 'isolate'])

function tokens(s: string): string[] {
  return s
    .split(/\s+/)
    .map(stripQuotes)
    .filter(Boolean)
}

function hasShortFlag(argText: string, flag: string): boolean {
  // -rf / -fr / -r -f 等组合写法
  for (const t of tokens(argText)) {
    if (t === `-${flag}`) return true
    if (/^-[A-Za-z]+$/.test(t) && t.slice(1).includes(flag)) return true
  }
  return false
}

function rmTargets(argText: string): string[] {
  return tokens(argText).filter((t) => !t.startsWith('-'))
}

function isForceRoot(path: string): boolean {
  const p = path.replace(/\/+$/, '') || '/'
  if (FORCE_FS_ROOTS.has(p)) return true
  // /home 下的一级目录（用户家目录本身）也算：rm -rf /home/alice
  return /^\/home\/[^/]+$/.test(p) || /^\/root$/.test(p)
}

interface MatchCtx {
  seg: CommandSegment
  segs: CommandSegment[]
  idx: number
  /** 分段后的纯命令文本（已剥离 heredoc 正文/注释），用于跨段模式 */
  plain: string
  /** 原始输入（含分隔符），用于 fork bomb 这类必须看完整形态的模式 */
  input: string
}

interface Rule {
  id: string
  level: Exclude<RiskLevel, 'safe'>
  reason: string
  match: (ctx: MatchCtx) => boolean
}

const BLOCK_RULES: Rule[] = [
  {
    id: 'rm-recursive-root',
    level: 'block',
    reason: '递归删除文件系统根目录或系统目录，不可恢复且会摧毁系统',
    match: ({ seg }) =>
      seg.name === 'rm' &&
      (hasShortFlag(seg.argText, 'r') || hasShortFlag(seg.argText, 'R')) &&
      rmTargets(seg.argText).some((t) => isForceRoot(t)),
  },
  {
    id: 'mkfs',
    level: 'block',
    reason: '格式化文件系统，会清空目标分区全部数据',
    match: ({ seg }) => /^mkfs(\.|$)/.test(seg.name),
  },
  {
    id: 'dd-to-block-device',
    level: 'block',
    reason: '直接写入块设备，会覆盖磁盘/分区数据',
    match: ({ seg }) =>
      seg.name === 'dd' && /\bof=\/dev\/(sd|nvme|hd|vd|mmcblk|disk|loop)/.test(seg.raw),
  },
  {
    id: 'redirect-to-block-device',
    level: 'block',
    reason: '重定向写入块设备，会覆盖磁盘数据',
    match: ({ seg }) => /[<>]\s*\/dev\/(sd|nvme|hd|vd|mmcblk|disk)/.test(seg.raw),
  },
  {
    id: 'fork-bomb',
    level: 'block',
    reason: 'fork 炸弹，会耗尽进程表使系统失去响应',
    match: ({ input }) => /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&/.test(input) || /:\(\)\s*\{\s*:\|:&\s*\};:/.test(input),
  },
  {
    id: 'chmod-recursive-root',
    level: 'block',
    reason: '递归修改根目录权限，会破坏系统可执行性',
    match: ({ seg }) =>
      seg.name === 'chmod' &&
      hasShortFlag(seg.argText, 'R') &&
      rmTargets(seg.argText).some((t) => t === '/' || t === '/*'),
  },
  {
    id: 'power-off',
    level: 'block',
    reason: '关机/重启会中断当前会话与所有未保存工作',
    match: ({ seg }) => {
      if (POWER_WORDS.has(seg.name)) return true
      if (seg.name === 'init' && ['0', '6'].includes(tokens(seg.argText)[0] || '')) return true
      if (seg.name === 'systemctl' && PROD_SYSTEMCTL.has(tokens(seg.argText)[0] || '')) return true
      return false
    },
  },
  {
    id: 'pipe-download-to-shell',
    level: 'block',
    reason: '把网络下载内容直接交给解释器执行，等于执行未知代码',
    match: ({ seg, segs, idx }) => {
      if (!INTERPRETERS.has(seg.name)) return false
      const prev = segs[idx - 1]
      if (!prev) return false
      if (seg.sepBefore !== '|' && seg.sepBefore !== '&') return false
      return DOWNLOADERS.has(prev.name)
    },
  },
]

const CONFIRM_RULES: Rule[] = [
  {
    id: 'git-force-push',
    // v0.6.155：#16 指出「硬拦 --force 会诱发更危险的绕过（如删库重建）」→ 降为 confirm，
    // 既保留显式确认，又不把模型逼向黑名单外的替代方案。
    level: 'confirm',
    reason: '强制推送会覆盖远端历史，协作者提交可能永久丢失；如确需，优先 --force-with-lease 并说明原因',
    match: ({ seg }) => {
      if (seg.name !== 'git') return false
      const t = tokens(seg.argText)
      if (t[0] !== 'push') return false
      const hasLease = t.some((x) => x === '--force-with-lease' || x.startsWith('--force-with-lease='))
      if (hasLease) return false
      return t.some((x) => x === '--force' || x === '-f' || x === '--force-if-includes')
    },
  },
  {
    id: 'kill-all-processes',
    level: 'confirm',
    reason: 'kill -1 / killall / pkill 会一次终止大量进程（可能包含当前会话与未保存工作）',
    match: ({ seg }) => {
      if (seg.name !== 'killall' && seg.name !== 'pkill' && seg.name !== 'kill') return false
      if (seg.name === 'killall' || seg.name === 'pkill') {
        const targets = tokens(seg.argText).filter((x) => !x.startsWith('-'))
        return targets.length > 0 || /-[A-Z]/.test(seg.argText)
      }
      const raw = tokens(seg.argText)
      // kill -1 / kill -9 -1（向全部进程发信号）与一次杀多个 pid
      if (raw.includes('-1') || raw.includes('1')) return true
      return raw.filter((x) => !x.startsWith('-')).length > 3
    },
  },
  {
    id: 'git-push',
    level: 'confirm',
    reason: '推送会改写远端仓库（含 --force-with-lease / 删远端分支），别人可见且不易撤回',
    match: ({ seg }) => {
      if (seg.name !== 'git') return false
      const t = tokens(seg.argText)
      return t[0] === 'push'
    },
  },
  {
    id: 'git-reset-hard',
    level: 'confirm',
    reason: 'git reset --hard 会丢弃未提交改动',
    match: ({ seg }) =>
      seg.name === 'git' && tokens(seg.argText)[0] === 'reset' && tokens(seg.argText).includes('--hard'),
  },
  {
    id: 'git-clean-force',
    level: 'confirm',
    reason: 'git clean -f/-x 会删除未跟踪（含被忽略）的文件',
    match: ({ seg }) => {
      if (seg.name !== 'git') return false
      const t = tokens(seg.argText)
      if (t[0] !== 'clean') return false
      return t.some((x) => /^-[a-zA-Z]*[fx]/.test(x))
    },
  },
  {
    id: 'git-branch-delete',
    level: 'confirm',
    reason: '删除分支会丢失该分支独有提交',
    match: ({ seg }) => {
      if (seg.name !== 'git') return false
      const t = tokens(seg.argText)
      return t[0] === 'branch' && t.some((x) => x === '-D' || x === '--delete' || x === '-d')
    },
  },
  {
    id: 'gh-repo-delete',
    level: 'confirm',
    reason: '删除 GitHub 仓库不可恢复（连带 issues/PR/release）',
    match: ({ seg }) => seg.name === 'gh' && tokens(seg.argText).slice(0, 2).join(' ') === 'repo delete',
  },
  {
    id: 'gh-repo-create-visibility',
    level: 'confirm',
    reason: 'gh repo create 未显式指定可见性时会创建 public 仓库（默认公开）；建议加 --private',
    match: ({ seg }) => {
      if (seg.name !== 'gh') return false
      const t = tokens(seg.argText)
      if (t[0] !== 'repo' || t[1] !== 'create') return false
      return !t.some((x) => x === '--private' || x === '--public' || x === '--internal')
    },
  },
  {
    id: 'gh-repo-visibility',
    level: 'confirm',
    reason: '修改仓库可见性会立即改变访问权限（public 后历史提交全部公开）',
    match: ({ seg }) => {
      if (seg.name !== 'gh') return false
      const t = tokens(seg.argText)
      return t[0] === 'repo' && t[1] === 'edit' && t.some((x) => x.startsWith('--visibility'))
    },
  },
  {
    id: 'gh-release-delete',
    level: 'confirm',
    reason: '删除 Release 会连带删除其 tag 与产物',
    match: ({ seg }) => {
      if (seg.name !== 'gh') return false
      const t = tokens(seg.argText)
      return t[0] === 'release' && t[1] === 'delete'
    },
  },
  {
    id: 'rm-recursive',
    level: 'confirm',
    reason: '递归删除不可恢复（不在 /tmp 下）；确认目标路径无误',
    match: ({ seg }) => {
      if (seg.name !== 'rm') return false
      if (!(hasShortFlag(seg.argText, 'r') || hasShortFlag(seg.argText, 'R'))) return false
      const targets = rmTargets(seg.argText)
      if (!targets.length) return false
      const inTmp = targets.every((t) =>
        t.startsWith('/tmp/') || t.startsWith('/var/tmp/') || t === '/tmp' ||
        t.startsWith('$TMPDIR') || t.startsWith('${TMPDIR') || t.startsWith('.hermes/cache/scratch'),
      )
      return !inTmp
    },
  },
  {
    id: 'sql-destructive',
    level: 'confirm',
    reason: '会删除表结构或全部行（DROP/TRUNCATE），数据不可恢复',
    match: ({ plain }) => /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i.test(plain),
  },
  {
    id: 'package-publish',
    level: 'confirm',
    reason: '发布到公共仓库后版本号无法撤回（npm/cargo/pypi）',
    match: ({ seg }) =>
      (seg.name === 'npm' && tokens(seg.argText)[0] === 'publish') ||
      (seg.name === 'cargo' && tokens(seg.argText)[0] === 'publish') ||
      (seg.name === 'twine' && tokens(seg.argText)[0] === 'upload') ||
      (seg.name === 'yarn' && tokens(seg.argText)[0] === 'publish'),
  },
  {
    id: 'docker-prune',
    level: 'confirm',
    reason: 'prune 会删除所有未使用的镜像/卷/容器',
    match: ({ seg }) => seg.name === 'docker' && tokens(seg.argText).some((t) => t === 'prune'),
  },
  {
    id: 'git-submodule-deinit',
    level: 'confirm',
    reason: 'deinit 会移除子模块工作区文件',
    match: ({ seg }) => seg.name === 'git' && tokens(seg.argText)[0] === 'submodule' && tokens(seg.argText).includes('deinit'),
  },
]

/** 会话内放行的规则（内存）；持久放行走 store */
const sessionAllowed = new Set<string>()
let allowStore: { get(key: string): string | null | undefined; set(key: string, value: string): void } | null = null

const ALWAYS_KEY = (rule: string) => `risk.always.${rule}`

/** 注入持久化存储（settings/kv 均可），用于「总是允许」跨会话生效 */
export function setRiskAllowanceStore(
  store: { get(key: string): string | null | undefined; set(key: string, value: string): void } | null,
): void {
  allowStore = store
}

export function isRiskRuleAllowed(rule: string): boolean {
  if (sessionAllowed.has(rule)) return true
  if (!allowStore) return false
  try {
    return allowStore.get(ALWAYS_KEY(rule)) === '1'
  } catch {
    return false
  }
}

export function allowRiskRule(rule: string, scope: 'session' | 'always'): boolean {
  // block 档不可放行：硬拦规则必须保持生效
  if (BLOCK_RULES.some((r) => r.id === rule)) return false
  if (scope === 'session') {
    sessionAllowed.add(rule)
    return true
  }
  if (allowStore) {
    try {
      allowStore.set(ALWAYS_KEY(rule), '1')
      return true
    } catch {
      /* 落盘失败退化为会话放行 */
    }
  }
  sessionAllowed.add(rule)
  return true
}

export function revokeRiskRule(rule: string): boolean {
  let removed = false
  if (sessionAllowed.delete(rule)) removed = true
  if (allowStore) {
    try {
      if (allowStore.get(ALWAYS_KEY(rule)) === '1') removed = true
      allowStore.set(ALWAYS_KEY(rule), '0')
    } catch {
      /* ignore */
    }
  }
  return removed
}

/** 放行条目（v0.6.155）：scope 区分会话内与跨会话持久化，both 表示两处都有 */
export interface RiskAllowEntry {
  rule: string
  scope: 'session' | 'always' | 'both'
}

export function listRiskAllowed(): RiskAllowEntry[] {
  const out = new Map<string, 'session' | 'always' | 'both'>()
  for (const r of sessionAllowed) out.set(r, 'session')
  if (allowStore) {
    for (const r of allRuleIds()) {
      try {
        if (allowStore.get(ALWAYS_KEY(r)) === '1') out.set(r, out.has(r) ? 'both' : 'always')
      } catch {
        /* ignore */
      }
    }
  }
  return [...out.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([rule, scope]) => ({ rule, scope }))
}

export function resetRiskSession(): void {
  sessionAllowed.clear()
}

export function allRuleIds(): string[] {
  return [...BLOCK_RULES, ...CONFIRM_RULES].map((r) => r.id)
}

export type RiskDecision = 'allow_once' | 'allow_session' | 'always' | 'deny' | 'alternative'

export interface RiskConfirmInfo {
  command: string
  rule: string
  level: RiskLevel
  reason: string
  segment?: string
}

export type RiskConfirmer = (info: RiskConfirmInfo) => Promise<RiskDecision> | RiskDecision

let confirmer: RiskConfirmer | null = null

/** 注入确认器（交互式 CLI）；null 表示无人在场（自动化/库调用） */
export function setRiskConfirmer(fn: RiskConfirmer | null): void {
  confirmer = fn
}

export function getRiskConfirmer(): RiskConfirmer | null {
  return confirmer
}

/**
 * 分级判定入口。
 * 顺序：block 规则优先（安全兜底），其次 confirm。
 */
export function classifyCommand(command: string): RiskVerdict {
  const segs = parseCommandSegments(command)
  if (!segs.length) return { level: 'safe' }
  const plain = segs.map((s) => s.raw).join('\n')

  for (const rule of BLOCK_RULES) {
    for (let idx = 0; idx < segs.length; idx++) {
      if (rule.match({ seg: segs[idx], segs, idx, plain, input: command })) {
        return { level: 'block', rule: rule.id, reason: rule.reason, segment: segs[idx].raw }
      }
    }
  }
  for (const rule of CONFIRM_RULES) {
    for (let idx = 0; idx < segs.length; idx++) {
      if (rule.match({ seg: segs[idx], segs, idx, plain, input: command })) {
        return { level: 'confirm', rule: rule.id, reason: rule.reason, segment: segs[idx].raw }
      }
    }
  }
  return { level: 'safe' }
}

/**
 * gh / git 命令「退出码 0 但实际失败」检测（#17）。
 * 典型：gh 403（token 无 repo 权限）→ 打印 `HTTP 403: Resource not accessible`，退出码却是 0，
 * 上游据此以为推送成功。
 */
export function detectFalseSuccess(command: string, output: string, code: number): string | null {
  if (code !== 0) return null
  const segs = parseCommandSegments(command)
  const usesGh = segs.some((s) => s.name === 'gh')
  if (!usesGh) return null
  if (!output) return null

  const patterns: Array<{ re: RegExp; hint: string }> = [
    { re: /HTTP 40[13]\b/i, hint: 'HTTP 401/403：认证或权限不足（token scope / SSO / 仓库权限）' },
    { re: /HTTP 404\b/i, hint: 'HTTP 404：目标仓库或资源不存在（可能未创建成功）' },
    { re: /Resource not accessible by (?:integration|personal access token)/i, hint: '权限不足：当前 token 无法访问该资源' },
    { re: /must be a collaborator|Must have admin rights/i, hint: '当前账号对该仓库没有足够权限' },
    { re: /could not resolve to a Repository/i, hint: '仓库解析失败（名字写错或无权限）' },
  ]
  for (const p of patterns) {
    if (p.re.test(output)) return `命令退出码为 0，但 gh 实际失败 —— ${p.hint}`
  }
  return null
}
