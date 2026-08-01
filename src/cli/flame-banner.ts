/**
 * Flare 火焰 Banner —— 视觉令牌 + 粒子动画
 *
 * 多端复用的视觉规范：
 *   - FLAME_TOKENS：色阶 / 渐变 / 动画参数（CLI、桌面版、嵌入面板共用）
 *   - flameColor()：红→橙→黄插值（与所有端一致的渐变算法）
 *   - renderStaticBanner()：静态火焰招牌（无动画环境/动画结束后使用）
 *   - playFlameBanner()：粒子火焰 + 整体呼吸动画（启动欢迎画面）
 */
import chalk from 'chalk'

// ===== Flare 视觉令牌（多端复用）=====
export const FLAME_TOKENS = {
  colors: {
    red: '#ef4444',       // 火焰核心（答卷分隔线、错误）
    orange: '#f97316',    // 主行动色（prompt、工具调用）
    amber: '#f59e0b',     // 过渡色（草稿）
    yellow: '#fbbf24',    // 亮黄（思考中）
    dark: '#b45309',      // 暗琥珀（工具结果边框）
  },
  gradient: {
    red: [239, 68, 68] as const,
    orange: [249, 115, 22] as const,
    yellow: [251, 191, 36] as const,
  },
  animation: {
    frameMs: 80,          // 帧间隔（~12fps）
    durationMs: 5000,     // 动画总时长
    breathCycles: 4,      // 文字呼吸次数
    particleRate: 0.75,   // 每帧粒子生成概率
    particleMax: 320,     // 粒子上限
    canvasW: 42,          // 画布宽
    canvasH: 14,          // 画布高
  },
}

// ===== 颜色 helpers =====
export const R = (s: string) => chalk.hex(FLAME_TOKENS.colors.red)(s)
export const O = (s: string) => chalk.hex(FLAME_TOKENS.colors.orange)(s)
export const A = (s: string) => chalk.hex(FLAME_TOKENS.colors.amber)(s)
export const Y = (s: string) => chalk.hex(FLAME_TOKENS.colors.yellow)(s)
export const D = (s: string) => chalk.hex(FLAME_TOKENS.colors.dark)(s)

type RGB = [number, number, number]
const C_RED: RGB = [239, 68, 68]
const C_ORANGE: RGB = [249, 115, 22]
const C_YELLOW: RGB = [251, 191, 36]

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

/** 红→橙→黄 火焰渐变颜色（t: 0~1，自动取模） */
export function flameColor(t: number): string {
  let r: number, g: number, b: number
  const tt = ((t % 1) + 1) % 1
  if (tt < 0.5) {
    const u = tt * 2
    r = Math.round(C_RED[0] + (C_ORANGE[0] - C_RED[0]) * u)
    g = Math.round(C_RED[1] + (C_ORANGE[1] - C_RED[1]) * u)
    b = Math.round(C_RED[2] + (C_ORANGE[2] - C_RED[2]) * u)
  } else {
    const u = (tt - 0.5) * 2
    r = Math.round(C_ORANGE[0] + (C_YELLOW[0] - C_ORANGE[0]) * u)
    g = Math.round(C_ORANGE[1] + (C_YELLOW[1] - C_ORANGE[1]) * u)
    b = Math.round(C_ORANGE[2] + (C_YELLOW[2] - C_ORANGE[2]) * u)
  }
  return rgbToHex(r, g, b)
}

/** 逐字符火焰渐变（空格和 emoji 不着色；reverse 让句尾落在红色端） */
function gradientText(text: string, reverse = false): string {
  const chars = [...text]
  const len = chars.length
  return chars.map((ch, i) => {
    if (ch === ' ' || ch.codePointAt(0)! > 0xffff) return ch
    const t = len <= 1 ? 0 : i / (len - 1)
    const tt = reverse ? 1 - t : t
    return chalk.hex(flameColor(tt))(ch)
  }).join('')
}

/** 静态火焰招牌（无动画环境 / 动画结束后定格） */
export function renderStaticBanner(): string {
  return [
    gradientText('           F L A R E            '),
    '',
    gradientText('  Let your inspiration flare', true) + ' 🔥',
  ].join('\n')
}

// ===== 粒子火焰动画 =====

const FLARE_TEXT = 'F L A R E'
const TAGLINE = 'Let your inspiration flare 🔥'

interface Particle {
  x: number
  y: number
  life: number
  maxLife: number
  drift: number
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * 播放火焰欢迎动画（粒子火焰 + 整体呼吸，火苗与文字重叠燃烧）。
 * 动画期间隐藏光标；结束后恢复光标并清屏（由调用方显示静态 banner）。
 * 非 TTY / 终端过窄时直接返回（调用方显示静态版）。
 */
export async function playFlameBanner(): Promise<void> {
  if (!process.stdout.isTTY || (process.stdout.columns || 80) < 50) return

  const { canvasW: W, canvasH: H, frameMs, durationMs, particleRate, particleMax } = FLAME_TOKENS.animation
  const line1Y = 3
  const line2Y = 6

  // 动画期间 Ctrl+C：恢复光标退出
  const onSigint = () => {
    process.stdout.write('\x1b[?25h\x1b[0m\n')
    process.exit(0)
  }
  process.on('SIGINT', onSigint)
  process.stdout.write('\x1b[?25l')  // 隐藏光标

  try {
    const particles: Particle[] = []
    const start = Date.now()

    while (Date.now() - start < durationMs) {
      const t = (Date.now() - start) / durationMs

      // 生成粒子：整个画面随机点燃（与文字不分区，重叠燃烧）
      if (Math.random() < particleRate) {
        particles.push({
          x: Math.random() * W,
          y: Math.random() * H,
          life: 0,
          maxLife: 0.6 + Math.random() * 0.8,
          drift: (Math.random() - 0.5) * 1.2,
        })
      }
      for (const p of particles) {
        p.y -= 0.1 + Math.random() * 0.12
        p.x += p.drift
        p.life += 0.028
      }
      while (particles.length && particles[0].life > particles[0].maxLife) particles.shift()
      while (particles.length > particleMax) particles.shift()

      // 网格：先画文字（整体呼吸色），再画粒子（覆盖文字 → 重叠燃烧）
      const grid: string[][] = Array.from({ length: H }, () => Array(W).fill(' '))
      const colors: (string | null)[][] = Array.from({ length: H }, () => Array(W).fill(null))

      const breathPhase = (Math.sin(t * Math.PI * 2 * FLAME_TOKENS.animation.breathCycles) + 1) / 2
      const textColor = flameColor(breathPhase)
      const putText = (text: string, y: number) => {
        const x0 = Math.floor((W - text.length) / 2)
        ;[...text].forEach((ch, i) => {
          if (ch === ' ') return  // 空格不覆盖（火苗可见）
          const x = x0 + i
          if (x >= 0 && x < W && y >= 0 && y < H) {
            grid[y][x] = ch
            colors[y][x] = ch.codePointAt(0)! > 0xffff ? null : textColor  // emoji 不着色
          }
        })
      }
      putText(FLARE_TEXT, line1Y)
      putText(TAGLINE, line2Y)

      for (const p of particles) {
        const xi = Math.round(p.x)
        const yi = Math.round(p.y)
        if (xi >= 0 && xi < W && yi >= 0 && yi < H) {
          const k = p.life / p.maxLife
          const chars = ['█', '▓', '▒', '░']
          grid[yi][xi] = chars[Math.min(3, Math.floor(k * 4))]
          colors[yi][xi] = flameColor(0.12 + k * 0.88)  // 黄 → 红
        }
      }

      // 渲染帧
      process.stdout.write('\x1b[2J\x1b[H\n')
      for (let y = 0; y < H; y++) {
        process.stdout.write('  ')
        for (let x = 0; x < W; x++) {
          const ch = grid[y][x]
          if (ch === ' ') {
            process.stdout.write(' ')
          } else if (colors[y][x]) {
            process.stdout.write(chalk.hex(colors[y][x]!)(ch))
          } else {
            process.stdout.write(ch)  // emoji 原色
          }
        }
        process.stdout.write('\n')
      }

      await sleep(frameMs)
    }
  } finally {
    process.off('SIGINT', onSigint)
    // 恢复光标 + 清屏（由调用方从顶部显示静态 banner，避免动画残留）
    process.stdout.write('\x1b[?25h\x1b[2J\x1b[H')
  }
}
