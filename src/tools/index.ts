/**
 * Flare 工具系统
 * 
 * Agent 可以调用的工具集合。
 * 参考 Hermes 的工具设计，但更轻量。
 */

import { ToolDefinition } from '../core/llm.js'
import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync } from 'fs'
import { resolve, join } from 'path'

export interface ToolResult {
  success: boolean
  output: string
  error?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolExecutor = (args: Record<string, any>) => ToolResult | Promise<ToolResult>

export interface Tool {
  definition: ToolDefinition
  execute: ToolExecutor
}

/**
 * 展开路径中的 ~ 为 HOME（所有文件工具通用）
 */
function expandHome(p: string): string {
  const home = process.env.HOME || ''
  if (home && p === '~') return home
  if (home && p.startsWith('~/')) return home + p.slice(1)
  return p
}

/**
 * 读取文件工具
 */
const readFileTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件内容，带行号。用于查看代码、配置文件等',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（绝对或相对路径）' },
          offset: { type: 'number', description: '起始行号（从1开始，默认1）' },
          limit: { type: 'number', description: '最多读取行数（默认500）' },
        },
        required: ['path'],
      },
    },
  },
  execute: ((args: { path: string; offset?: number; limit?: number }) => {
    try {
      const resolvedPath = resolve(expandHome(args.path))
      if (!existsSync(resolvedPath)) {
        return { success: false, output: '', error: `文件不存在: ${resolvedPath}` }
      }
      const content = readFileSync(resolvedPath, 'utf-8')
      const lines = content.split('\n')
      const offset = args.offset || 1
      const limit = args.limit || 500
      const selected = lines.slice(offset - 1, offset - 1 + limit)
      const output = selected.map((line, i) => `${offset + i}|${line}`).join('\n')
      return {
        success: true,
        output: `文件 ${resolvedPath}（共 ${lines.length} 行，显示 ${offset}-${Math.min(offset + limit - 1, lines.length)}）\n${output}`,
      }
    } catch (e: any) {
      return { success: false, output: '', error: `读取失败: ${e.message}` }
    }
  }) as ToolExecutor,
}

/**
 * 受保护路径前缀（write_file 拒绝写入这些位置）
 * 防止 AI 误覆盖系统关键文件
 */
const PROTECTED_PATHS: string[] = [
  '/etc/', '/usr/', '/boot/', '/var/', '/proc/', '/sys/', '/lib/',
  '/bin/', '/sbin/', '/dev/', '/run/', '/opt/', '/root/',
  '/usr/local/',
]

function isProtectedPath(path: string): boolean {
  const resolved = resolve(path)
  for (const prefix of PROTECTED_PATHS) {
    if (resolved.startsWith(prefix)) return true
  }
  // 保护 git 内部文件和 ssh 配置（防止 AI 覆盖 .git/config 或 ssh key）
  const pathParts = resolved.split('/')
  if (pathParts.includes('.git')) return true
  if (pathParts.includes('.ssh') && (pathParts.includes('id_rsa') || pathParts.includes('id_ed25519') || pathParts.includes('config'))) return true
  return false
}

/**
 * 写入文件工具
 */
const writeFileTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入文件内容（覆盖整个文件）。用于创建新文件或完全重写已有文件',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  execute: ((args: { path: string; content: string }) => {
    try {
      const resolvedPath = resolve(expandHome(args.path))

      // 路径校验：拒绝写入受保护位置
      if (isProtectedPath(resolvedPath)) {
        return { success: false, output: '', error: `拒绝写入受保护路径: ${resolvedPath}。Flare 不会修改系统关键文件。` }
      }

      // 原子写入：先写临时文件再 rename，避免中途崩溃损坏原文件
      const tmpPath = `${resolvedPath}.tmp-${process.pid}`
      writeFileSync(tmpPath, args.content, 'utf-8')
      renameSync(tmpPath, resolvedPath)
      return { success: true, output: `已写入 ${resolvedPath}` }
    } catch (e: any) {
      return { success: false, output: '', error: `写入失败: ${e.message}` }
    }
  }) as ToolExecutor,
}

/**
 * 搜索文件工具
 */
const searchFilesTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'search_files',
      description: '搜索文件内容或按文件名查找文件。支持正则表达式搜索',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '搜索模式（正则表达式或文件名通配符）' },
          path: { type: 'string', description: '搜索目录（默认当前目录）' },
          maxResults: { type: 'number', description: '最大结果数（默认20）' },
        },
        required: ['pattern'],
      },
    },
  },
  execute: ((args: { pattern: string; path?: string; maxResults?: number }) => {
    try {
      const searchPath = resolve(expandHome(args.path || '.'))
      const results: string[] = []
      const maxResults = args.maxResults || 20

      const walkDir = (dir: string) => {
        if (results.length >= maxResults) return
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch {
          return
        }
        for (const entry of entries) {
          if (results.length >= maxResults) return
          // 跳过隐藏目录、node_modules、.git、dist 等大目录
          if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'coverage' || entry === '.cache') continue
          // 跳过其他 AI 工具的内部目录（这些不是 Flare 的资产，不该被搜索/读取）
          if (entry === '.hermes' || entry === '.agents' || entry === '.codebuddy' || entry === '.claude' || entry === '.cursor' || entry === '.gemini' || entry === '.mimocode' || entry === '.windsurf' || entry === '.continue') continue
          if (entry.startsWith('.') && entry !== '.' && entry !== '..') continue
          const fullPath = join(dir, entry)
          try {
            const stat = statSync(fullPath)
            if (stat.isDirectory()) {
              walkDir(fullPath)
            } else if (stat.isFile()) {
              // 大文件（>500KB）只做文件名匹配，不做内容搜索（防 OOM）
              const nameMatches = fullPath.includes(args.pattern)
              if (stat.size <= 500 * 1024) {
                const content = readFileSync(fullPath, 'utf-8')
                if (content.includes(args.pattern) || nameMatches) {
                  results.push(fullPath.replace(searchPath, '.'))
                }
              } else if (nameMatches) {
                results.push(`${fullPath.replace(searchPath, '.')} (大文件，仅文件名匹配)`)
              }
            }
          } catch { /* skip unreadable */ }
        }
      }

      walkDir(searchPath)
      return {
        success: true,
        output: results.length > 0
          ? `找到 ${results.length} 个匹配：\n${results.join('\n')}`
          : '未找到匹配',
      }
    } catch (e: any) {
      return { success: false, output: '', error: `搜索失败: ${e.message}` }
    }
  }) as ToolExecutor,
}

function joinPath(...parts: string[]): string {
  return join(...parts)
}

/**
 * 危险命令黑名单（正则匹配）
 * 命中直接拒绝执行，防止 AI 误操作毁灭性命令
 */
const DANGEROUS_COMMANDS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\/\s*(\*|$)/,          // rm -rf /
  /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+~/,                        // rm -rf ~
  /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+\/home\b/,                 // rm -rf /home
  /\bmkfs\./,                                                   // mkfs 格式化
  /\bdd\s+if=.*\s+of=\/dev\/(sd|nvme|hd)/,                      // dd 写磁盘
  /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};?\s*:/,                 // fork bomb
  /\bchmod\s+-R\s+777\s+\//,                                    // chmod 根目录
  /\b>\/dev\/sda\b/,                                            // 直接写设备
  /\bwget|curl\b.*\|\s*(ba)?sh\b/,                              // curl | bash（下载执行）
  /\bshutdown\b|\breboot\b|\binit\s+0\b/,                       // 关机/重启
  /\bgit\s+push\s+.*\s+--force\b/,                              // force push（默认拒绝，防误推）
]

function isDangerousCommand(command: string): string | null {
  for (const pattern of DANGEROUS_COMMANDS) {
    if (pattern.test(command)) {
      return pattern.toString()
    }
  }
  return null
}

/**
 * 执行终端命令工具
 */
const terminalTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'terminal',
      description: '在终端中执行命令。可用于运行代码、安装包、git操作等',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          timeout: { type: 'number', description: '超时时间（秒，默认30）' },
        },
        required: ['command'],
      },
    },
  },
  execute: ((args: { command: string; timeout?: number }) => {
    try {
      // 危险命令拦截
      const danger = isDangerousCommand(args.command)
      if (danger) {
        return {
          success: false,
          output: '',
          error: `命令被安全策略拦截（匹配危险模式: ${danger}）。Flare 拒绝执行可能造成不可逆损坏的命令。`,
        }
      }

      // 用 bash 执行：支持 ~ 展开、&& 链式命令等
      // （execSync 默认 /bin/sh 不展开 ~，会导致 cd ~/xxx 失败）
      let cmd = args.command
      // 兜底：手动替换 ~ 为 HOME（即使 shell 不支持也能工作）
      const home = process.env.HOME || ''
      if (home) {
        cmd = cmd.replace(/^~(?=\/|$)/, home).replace(/(?<=\s)~(?=\/|$)/g, home)
      }
      const output = execSync(cmd, {
        encoding: 'utf-8',
        timeout: (args.timeout || 30) * 1000,
        maxBuffer: 1024 * 1024,
        shell: '/bin/bash',
      })
      return { success: true, output: output.slice(0, 10000) }
    } catch (e: any) {
      return {
        success: false,
        output: e.stdout || '',
        error: `命令执行失败: ${e.message.slice(0, 500)}`,
      }
    }
  }) as ToolExecutor,
}

/**
 * 所有可用工具
 */
export const tools: Tool[] = [
  readFileTool,
  writeFileTool,
  searchFilesTool,
  terminalTool,
]

/**
 * 获取工具定义列表（用于 LLM function calling）
 */
export function getToolDefinitions(): ToolDefinition[] {
  return tools.map(t => t.definition)
}

/**
 * 根据名称查找并执行工具
 */
export async function executeTool(name: string, args: Record<string, any>): Promise<ToolResult> {
  const tool = tools.find(t => t.definition.function.name === name)
  if (!tool) {
    return { success: false, output: '', error: `未知工具: ${name}` }
  }
  return tool.execute(args)
}
