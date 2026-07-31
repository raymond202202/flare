/**
 * Flare 轻量日志系统
 * 
 * 通过 DEBUG 环境变量控制：
 *   DEBUG=1 flare chat -q "hi"   → 输出调试日志
 *   默认运行无日志噪音
 */

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true'

function log(level: string, msg: string, ...args: any[]) {
  if (!DEBUG) return
  const time = new Date().toISOString().slice(11, 23)
  const prefix = `[${time}] [${level}]`
  if (args.length > 0) {
    console.error(prefix, msg, ...args)
  } else {
    console.error(prefix, msg)
  }
}

export const logger = {
  debug: (msg: string, ...args: any[]) => log('DEBUG', msg, ...args),
  info: (msg: string, ...args: any[]) => log('INFO', msg, ...args),
  warn: (msg: string, ...args: any[]) => log('WARN', msg, ...args),
  error: (msg: string, ...args: any[]) => log('ERROR', msg, ...args),
  /** 是否开启调试 */
  get enabled() {
    return DEBUG
  },
}
