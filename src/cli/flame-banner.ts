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

// ===== 粒子火焰动画（常驻状态机）=====

const FLARE_TEXT = 'F L A R E'
const TAGLINE = 'Let your inspiration flare 🔥'
const BANNER_LINE1 = 0     // F L A R E 所在行（banner 区域内）
const BANNER_LINE2 = 2     // 标语所在行
const BANNER_HEIGHT = 4    // banner 区域高度（行0..3，行1/3 为空）

interface Particle {
  x: number
  y: number
  life: number
  maxLife: number
  drift: number
}

export interface FlameState {
  particles: Particle[]
  W: number
  H: number
}

/** 创建火焰动画状态（粒子系统） */
export function createFlameState(): FlameState {
  return {
    particles: [],
    W: FLAME_TOKENS.animation.canvasW,
    H: BANNER_HEIGHT,
  }
}

/** 推进一帧粒子系统（dt 为帧间隔秒数，用于控制生成率） */
export function updateFlame(state: FlameState, dt: number) {
  const { particleRate, particleMax } = FLAME_TOKENS.animation
  // 生成粒子：banner 区域内随机点燃（与文字重叠燃烧）
  if (Math.random() < particleRate * (dt / 0.08)) {
    state.particles.push({
      x: Math.random() * state.W,
      y: Math.random() * state.H,
      life: 0,
      maxLife: 0.6 + Math.random() * 0.8,
      drift: (Math.random() - 0.5) * 1.2,
    })
  }
  for (const p of state.particles) {
    p.y -= (0.1 + Math.random() * 0.12) * (dt / 0.08)
    p.x += p.drift * (dt / 0.08)
    p.life += 0.028 * (dt / 0.08)
  }
  while (state.particles.length && state.particles[0].life > state.particles[0].maxLife) state.particles.shift()
  while (state.particles.length > particleMax) state.particles.shift()
}

/**
 * 渲染一帧火焰 banner（4 行，融合方案 A：渐变 + 安静呼吸）。
 * 每个字母独立渐变色（相邻不同色），渐变整体随 sin 波来回呼吸——
 * 保留方案 A 的安静跳动感，同时每时每刻都是渐变色。
 * t 为动画时间（秒）。
 */
export function renderFlameFrame(_state: FlameState, t: number): string {
  // 呼吸：5s 一个完整周期，振幅 0.12（渐变整体轻轻起伏，不单向流动）
  const breath = Math.sin(t * Math.PI * 2 / 5) * 0.12
  const colorText = (text: string, reverse = false): string => {
    const chars = [...text]
    const len = chars.length
    return chars.map((ch, i) => {
      if (ch === ' ' || ch.codePointAt(0)! > 0xffff) return ch  // 空格/emoji 不着色
      // 位置相位（相邻不同色）+ 呼吸偏移（安静跳动）
      let phase = (i / len + breath) % 1
      if (reverse) phase = 1 - phase
      return chalk.hex(flameColor(phase))(ch)
    }).join('')
  }

  return [
    colorText('           F L A R E            '),
    '',
    colorText('  Let your inspiration flare', true) + ' 🔥',
    '',
  ].join('\n')
}

/** 火焰呼吸色（prompt 等持续元素用） */
export function flameBreathColor(timeMs: number): string {
  const t = (timeMs % 5000) / 5000
  const phase = (Math.sin(t * Math.PI * 4) + 1) / 2
  return flameColor(phase)
}
