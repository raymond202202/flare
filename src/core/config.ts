/**
 * Flare 配置管理
 * 
 * 从 .env 和环境变量读取配置
 */

import * as dotenv from 'dotenv'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

// 加载 .env
const envPaths = [
  join(process.cwd(), '.env'),
  join(homedir(), '.flare', '.env'),
]
for (const p of envPaths) {
  if (existsSync(p)) {
    dotenv.config({ path: p })
    break
  }
}

// 确保 Flare 数据目录存在
const flareHome = process.env.FLARE_HOME || join(homedir(), '.flare')
try {
  mkdirSync(flareHome, { recursive: true })
} catch {}

class Config {
  private store: Map<string, string> = new Map()

  constructor() {
    // 从环境变量加载
    this.store.set('OPENAI_API_KEY', process.env.OPENAI_API_KEY || '')
    this.store.set('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY || '')
    this.store.set('DEEPSEEK_API_KEY', process.env.DEEPSEEK_API_KEY || '')
    this.store.set('DEFAULT_MODEL', process.env.DEFAULT_MODEL || 'deepseek-chat')
    this.store.set('OPENAI_BASE_URL', process.env.OPENAI_BASE_URL || '')
    this.store.set('FLARE_HOME', flareHome)
  }

  get(key: string): string | undefined {
    return this.store.get(key)
  }

  set(key: string, value: string) {
    this.store.set(key, value)
  }

  get flareHome(): string {
    return flareHome
  }
}

export const config = new Config()
