/**
 * LineInput 输入层回归测试
 *
 * 覆盖 2026-10 的粘贴截断修复：
 *  - bracketed paste（\x1b[200~ … \x1b[201~）内容整段保留，多行不被当成多次回车
 *  - 不支持 bracketed paste 的终端：同一 chunk 内换行后还有内容 → 判为粘贴而非提交
 *  - 跨 chunk 切断的 UTF-8 多字节字符不会变成 U+FFFD
 *  - 粘贴内容里的 ANSI 颜色码被剥离
 *  - 换行/制表符渲染成单行可见形式（↵ / 4 空格），宽度与光标定位一致
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { LineInput, displayOf, stringWidth } from '../src/cli/line-input'

type Listener = (chunk: Buffer) => void

let dataListeners: Listener[] = []
let written = ''
let originalStdin: PropertyDescriptor | undefined

const fakeStdin = {
  setRawMode() { return true },
  on(event: string, fn: Listener) {
    if (event === 'data') dataListeners.push(fn)
    return fakeStdin
  },
  removeListener(event: string, fn: Listener) {
    if (event === 'data') dataListeners = dataListeners.filter(l => l !== fn)
    return fakeStdin
  },
  pause() { return fakeStdin },
  resume() { return fakeStdin },
}

/** 模拟终端把一段字节推给 stdin */
function feed(chunk: Buffer | string) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
  for (const l of [...dataListeners]) l(buf)
}

/** 等 IME 防抖窗口过去（Enter 后 200ms 才真正提交） */
const settle = () => new Promise(r => setTimeout(r, 260))

beforeEach(() => {
  dataListeners = []
  written = ''
  originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
  Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true, writable: true })
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { written += s; return true }) as never)
})

afterEach(() => {
  if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin)
  vi.restoreAllMocks()
})

describe('displayOf', () => {
  it('换行显示为 ↵，制表符展开为 4 空格', () => {
    expect(displayOf('a\nb\tc')).toBe('a\u21b5b    c')
  })

  it('宽度按显示形式计算（↵ 与 4 空格都能对上）', () => {
    expect(stringWidth('中文↵')).toBe(5)      // 2+2+1
    expect(stringWidth(displayOf('a\tb'))).toBe(6)   // a + 4 空格 + b
  })
})

describe('bracketed paste', () => {
  it('多行粘贴整段保留，换行不会触发提交', async () => {
    const li = new LineInput('> ')
    const p = li.readLine()
    feed('\u001b[200~LINE-1-粘贴\nLINE-2-粘贴\nLINE-3-粘贴\u001b[201~')
    await settle()
    // 粘贴本身不提交，必须再按一次 Enter
    feed('\r')
    await settle()
    expect(await p).toBe('LINE-1-粘贴\nLINE-2-粘贴\nLINE-3-粘贴')
  })

  it('粘贴内容与已有输入拼接在光标处', async () => {
    const li = new LineInput('> ')
    const p = li.readLine()
    feed('前缀-')
    feed('\u001b[200~粘贴A\n粘贴B\u001b[201~')
    feed('\r')
    await settle()
    expect(await p).toBe('前缀-粘贴A\n粘贴B')
  })

  it('结束标记被 chunk 切断时仍能正确结束粘贴态', async () => {
    const li = new LineInput('> ')
    const p = li.readLine()
    feed('\u001b[200~第一行\n第二行\u001b[20')
    feed('1~')
    feed('\r')
    await settle()
    expect(await p).toBe('第一行\n第二行')
  })

  it('\\r\\n 在粘贴内容里归一化为 \\n', async () => {
    const li = new LineInput('> ')
    const p = li.readLine()
    feed('\u001b[200~A\r\nB\r\nC\u001b[201~')
    feed('\r')
    await settle()
    expect(await p).toBe('A\nB\nC')
  })

  it('粘贴内容里的 ANSI 颜色码被剥离', async () => {
    const li = new LineInput('> ')
    const p = li.readLine()
    feed('\u001b[200~\u001b[31m红色文字\u001b[0m\u001b[201~')
    feed('\r')
    await settle()
    expect(await p).toBe('红色文字')
  })

  it('开启 bracketed paste 并提交后关闭', async () => {
    const li = new LineInput('> ')
    const p = li.readLine()
    expect(written).toContain('\u001b[?2004h')
    feed('hello')
    feed('\r')
    await settle()
    expect(await p).toBe('hello')
    expect(written).toContain('\u001b[?2004l')
  })
})

describe('无 bracketed paste 的终端兜底', () => {
  it('同一 chunk 里换行后还有内容 → 当粘贴整段插入，不截断', async () => {
    const li = new LineInput('> ')
    const p = li.readLine()
    feed('LINE-1\nLINE-2\nLINE-3')
    await settle()
    feed('\r')
    await settle()
    expect(await p).toBe('LINE-1\nLINE-2\nLINE-3')
  })

  it('单个换行且后面没内容 → 正常提交', async () => {
    const li = new LineInput('> ')
    const p = li.readLine()
    feed('单行内容\r')
    await settle()
    expect(await p).toBe('单行内容')
  })
})

describe('流式 UTF-8 解码', () => {
  it('中文被 chunk 从中间切断也不出现乱码', async () => {
    const li = new LineInput('> ')
    const p = li.readLine()
    const buf = Buffer.from('粘贴中文测试', 'utf8')
    // 故意在“文”字的字节中间切开
    feed(buf.subarray(0, 7))
    feed(buf.subarray(7))
    feed('\r')
    await settle()
    const line = await p
    expect(line).toBe('粘贴中文测试')
    expect(line).not.toContain('\ufffd')
  })

  it('emoji 跨 chunk 切断也完整', async () => {
    const li = new LineInput('> ')
    const p = li.readLine()
    const buf = Buffer.from('🔥灵感', 'utf8')
    feed(buf.subarray(0, 2))   // 🔥 的前 2 个字节
    feed(buf.subarray(2))
    feed('\r')
    await settle()
    expect(await p).toBe('🔥灵感')
  })
})

describe('制表符与编辑', () => {
  it('手输 Tab 被保留到 buffer（粘贴代码缩进不丢）', async () => {
    const li = new LineInput('> ')
    const p = li.readLine()
    feed('if (x) {\n\treturn 1\n}')
    await settle()
    feed('\r')
    await settle()
    expect(await p).toBe('if (x) {\n\treturn 1\n}')
  })
})
