/**
 * Flare 工具系统
 * 
 * Agent 可以调用的工具集合。
 * 参考 Hermes 的工具设计，但更轻量。
 */

import { ToolDefinition } from '../core/llm.js'
import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { resolve } from 'path'

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
      const resolvedPath = resolve(args.path)
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
      const resolvedPath = resolve(args.path)
      writeFileSync(resolvedPath, args.content, 'utf-8')
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
      const searchPath = resolve(args.path || '.')
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
          if (entry.startsWith('.') || entry === 'node_modules') continue
          const fullPath = joinPath(dir, entry)
          try {
            const stat = statSync(fullPath)
            if (stat.isDirectory()) {
              walkDir(fullPath)
            } else if (stat.isFile()) {
              const content = readFileSync(fullPath, 'utf-8')
              if (content.includes(args.pattern) || fullPath.includes(args.pattern)) {
                results.push(fullPath.replace(searchPath, '.'))
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
  // Simple path join that avoids import issues
  return parts.join('/').replace(/\/+/g, '/')
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
      const output = execSync(args.command, {
        encoding: 'utf-8',
        timeout: (args.timeout || 30) * 1000,
        maxBuffer: 1024 * 1024,
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
