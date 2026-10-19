/**
 * ferry 内嵌引擎的类型定义。
 *
 * 结构与 ferry.py 的 JSON 契约一致（schema=1），因此 CLI 版和 flare 内嵌版
 * 可以共享同一批数据文件和同一批用例。
 */

export type Platform = 'linux' | 'macos' | 'freebsd' | 'windows'
export type ShellName = 'bash' | 'zsh' | 'sh' | 'powershell' | 'pwsh' | 'cmd'
export type Status = 'equivalent' | 'approximate' | 'unsupported' | 'error'

/** 平台键：windows 有 powershell / cmd 两套写法 */
export type PlatformKey = 'linux' | 'macos' | 'freebsd' | 'windows' | 'windows_cmd'

export interface FlagRaw {
  /** 数据文件允许带额外字段（desc 等），类型层不拒绝 */
  [extra: string]: unknown
  linux?: string | null
  macos?: string | null
  freebsd?: string | null
  windows?: string | null
  windows_cmd?: string | null
  semantic?: string
}

export interface RecipeRaw {
  /** 数据文件允许带额外字段（desc 等），类型层不拒绝 */
  [extra: string]: unknown
  linux?: string | null
  macos?: string | null
  freebsd?: string | null
  windows?: string | null
  windows_cmd?: string | null
  status?: Status
  caveats?: string[]
}

export interface EntryRaw {
  /** 数据文件允许带额外字段（desc 等），类型层不拒绝 */
  [extra: string]: unknown
  id: string
  category?: string
  summary?: string
  names?: Partial<Record<PlatformKey, string>>
  aliases?: Partial<Record<PlatformKey, string[]>>
  flags?: FlagRaw[]
  direct_flags?: string[]
  recipes?: RecipeRaw[]
  universal?: boolean
  hint?: string
}

export interface PatternRaw {
  /** 数据文件允许带额外字段（desc 等），类型层不拒绝 */
  [extra: string]: unknown
  linux?: string | null
  macos?: string | null
  freebsd?: string | null
  windows?: string | null
  windows_cmd?: string | null
  status?: Status
  caveats?: string[]
  summary?: string
}

export interface DrillRaw {
  [extra: string]: unknown
  id: string
  platform: Platform
  shell?: string
  summary?: string
  cmd: string
  expect?: 'success' | 'fail' | 'any'
}

export interface FerryDoc {
  commands?: EntryRaw[]
  syntax?: unknown[]
  pitfalls?: unknown[]
  patterns?: PatternRaw[]
  drills?: DrillRaw[]
}

export interface SegResult {
  input: string
  operator: string
  command: string | null
  status: Status
  kind: 'recipe' | 'flags' | 'passthrough' | 'pattern' | 'unsupported'
  caveats: string[]
  notes: string[]
}

export interface TranslationResult {
  schema: number
  input: string
  source: Platform
  target: Platform
  shell: string
  status: Status
  command: string | null
  confidence: 'high' | 'medium' | 'none'
  inferred: boolean
  llmUsed: boolean
  caveats: string[]
  notes: string[]
  segments: SegResult[]
}

export interface TranslateOptions {
  command: string
  target: Platform | string
  source?: Platform | string | null
  shell?: ShellName | string | null
  /** 当前运行平台，默认取 process.platform；测试可覆盖 */
  platform?: Platform
  /** WSL/MSYS 路径风格，默认 wsl */
  pathStyle?: 'wsl' | 'msys'
}
