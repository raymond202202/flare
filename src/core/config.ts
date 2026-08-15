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

// 加载 .env — 先加载用户的，再加载本地的覆盖（这样 ~/.flare/.env 优先级更高）
const homeEnv = join(homedir(), '.flare', '.env')
const localEnv = join(process.cwd(), '.env')

if (existsSync(homeEnv)) {
  dotenv.config({ path: homeEnv })
}
if (existsSync(localEnv) && localEnv !== homeEnv) {
  dotenv.config({ path: localEnv, override: false })
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
    // 主模型通用覆盖（v0.5.2）：不设置时按模型名自动检测（deepseek/gpt/本地 Ollama）
    this.store.set('LLM_BASE_URL', process.env.LLM_BASE_URL || '')
    this.store.set('LLM_API_KEY', process.env.LLM_API_KEY || '')
    // 视觉模型（看图时用本地 VLM）
    this.store.set('VISION_MODEL', process.env.VISION_MODEL || '')
    this.store.set('VISION_BASE_URL', process.env.VISION_BASE_URL || '')
    this.store.set('VISION_API_KEY', process.env.VISION_API_KEY || '')
    // 本地路由模型（v0.6.134 混合模式）：简单任务走本地小模型（省钱/隐私/离线）——
    // LOCAL_MODEL 为 Ollama 命名（如 qwen2.5:7b，含 ':' 自动走本地端点）；
    // LOCAL_BASE_URL / LOCAL_API_KEY 可覆盖默认 Ollama 端点（http://localhost:11434/v1，apiKey 'ollama'）
    this.store.set('LOCAL_MODEL', process.env.LOCAL_MODEL || '')
    this.store.set('LOCAL_BASE_URL', process.env.LOCAL_BASE_URL || '')
    this.store.set('LOCAL_API_KEY', process.env.LOCAL_API_KEY || '')
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
