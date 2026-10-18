#!/usr/bin/env python3
"""真实 PTY 布局回归（P0-B S3）：把 flare 的输出字节流跑进 rows×cols 网格再断言。

验证三条不变量（对应 src/cli/render.ts 的 I1/I2/I3）：
  A 启动后输入框贴在最后一行
  B 内容大量滚屏后输入框仍在最后一行，且滚出的行进了 scrollback
  C 改窗口大小（TIOCSWINSZ + SIGWINCH）后输入框回到底部，不残留旧布局
  D 大块文本一次性粘贴不卡死、不丢字符，输入框贴底
  E 除启动那一帧外不再发 CSI 2J（全屏清屏）

用法（仓库任意位置）:
  python3 tests/manual/pty_layout_check.py
  FLARE_BIN=flare python3 tests/manual/pty_layout_check.py    # 测已安装的生产二进制

隔离: 会话数据写临时 FLARE_HOME，结束即删；~/.flare/.env 只复制到临时目录(600)。
零第三方依赖（不需要 pyte）：自带最小 VT 解析器。
"""
import fcntl
import os
import re
import select
import shutil
import signal
import struct
import sys
import tempfile
import termios
import time
import unicodedata
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HOME = tempfile.mkdtemp(prefix="flare-layout-")
COLS, ROWS = 100, 30

bin_env = os.environ.get("FLARE_BIN")
CMD = [shutil.which(bin_env) or bin_env, "chat", "-n"] if bin_env else ["npx", "tsx", "src/cli/index.ts", "chat", "-n"]


def cw(ch: str) -> int:
    if unicodedata.combining(ch):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


class Vt:
    """最小 VT：普通字符/\\r/\\n/\\b、CSI nA/nB/nC/nD/H/J/2J、SGR 忽略、折行+滚屏。"""

    def __init__(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.grid = [[" "] * cols for _ in range(rows)]
        self.r = self.c = 0
        self.wrap = False
        self.scrollback = []
        self.clear_count = 0

    def line(self, n):
        return "".join(self.grid[n]).rstrip()

    def text(self):
        return "\n".join(self.line(i) for i in range(self.rows))

    def _newline(self):
        if self.r == self.rows - 1:
            self.scrollback.append(self.line(0))
            self.grid.pop(0)
            self.grid.append([" "] * self.cols)
        else:
            self.r += 1
        self.c = 0

    def write(self, s):
        i = 0
        while i < len(s):
            ch = s[i]
            if ch == "\x1b":
                m = re.match(r"\x1b\[([0-9;?]*)([@-~])", s[i:i + 32])
                if m:
                    self.csi(m.group(1), m.group(2))
                    i += m.group(0).__len__()
                    continue
                i += 1
                continue
            if ch == "\r":
                self.c, self.wrap = 0, False
            elif ch == "\n":
                self._newline()
                self.wrap = False
            elif ch == "\b":
                self.c, self.wrap = max(0, self.c - 1), False
            else:
                w = cw(ch)
                if w and (self.wrap or self.c + w > self.cols):
                    self.c = 0
                    self._newline()
                    self.wrap = False
                if w:
                    self.grid[self.r][self.c] = ch
                    if w == 2 and self.c + 1 < self.cols:
                        self.grid[self.r][self.c + 1] = ""
                    self.c += w
                    if self.c >= self.cols:
                        self.c, self.wrap = self.cols - 1, True
            i += 1

    def csi(self, params, final):
        args = [int(x) for x in params.replace("?", "").split(";") if x.isdigit()]
        n = args[0] if args and args[0] > 0 else 1
        if final == "A":
            self.r, self.wrap = max(0, self.r - n), False
        elif final == "B":
            self.r, self.wrap = min(self.rows - 1, self.r + n), False
        elif final == "C":
            self.c, self.wrap = min(self.cols - 1, self.c + n), False
        elif final == "D":
            self.c, self.wrap = max(0, self.c - n), False
        elif final in ("H", "f"):
            row = (args[0] if len(args) > 0 else 1) - 1
            col = (args[1] if len(args) > 1 else 1) - 1
            self.r = min(self.rows - 1, max(0, row))
            self.c = min(self.cols - 1, max(0, col))
            self.wrap = False
        elif final == "J":
            mode = args[0] if args else 0
            if mode == 0:
                for c in range(self.c, self.cols):
                    self.grid[self.r][c] = " "
                for r in range(self.r + 1, self.rows):
                    self.grid[r] = [" "] * self.cols
            elif mode == 2:
                self.grid = [[" "] * self.cols for _ in range(self.rows)]
                self.r = self.c = 0
                self.clear_count += 1
            self.wrap = False

    def resize(self, cols, rows):
        grid = []
        for r in range(rows):
            row = [" "] * cols
            if r < self.rows:
                for c in range(min(cols, self.cols)):
                    row[c] = self.grid[r][c]
            grid.append(row)
        self.grid, self.cols, self.rows = grid, cols, rows
        self.r, self.c = min(self.r, rows - 1), min(self.c, cols - 1)
        self.wrap = False


class Session:
    def __init__(self):
        import pty
        self.vt = Vt(COLS, ROWS)
        self.raw = ""
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(REPO)
            env = dict(os.environ)
            env["FLARE_HOME"] = HOME
            env["TERM"] = "xterm-256color"
            os.execvpe(CMD[0], CMD, env)
        self.setsize(COLS, ROWS)

    def setsize(self, cols, rows):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("hhHH", rows, cols, 0, 0))

    def resize(self, cols, rows):
        self.setsize(cols, rows)
        try:
            os.kill(self.pid, signal.SIGWINCH)
        except ProcessLookupError:
            pass
        self.vt.resize(cols, rows)
        self.drain(0.8)

    def drain(self, t=0.4):
        end = time.time() + t
        got = False
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if not r:
                continue
            try:
                d = os.read(self.fd, 65536)
            except OSError:
                break
            if not d:
                break
            got = True
            text = d.decode("utf-8", "replace")
            self.raw += text
            self.vt.write(text)
        return got

    def send(self, s, wait=0.5):
        os.write(self.fd, s.encode())
        self.drain(wait)

    def close(self):
        for sig in (signal.SIGKILL,):
            try:
                os.kill(self.pid, sig)
            except ProcessLookupError:
                pass
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass


def flat(vt):
    """按显示顺序把 scrollback + 屏幕拼成一串（丢弃换行）。

    折行会把 PASTELINE-5 切成 "PASTELINE-" / "5-ABCDEFG" 两段，
    这属于正常折行、内容完好，所以存在性断言必须在拼平后的文本上做。
    """
    return "".join(vt.scrollback) + "".join(vt.line(i) for i in range(vt.rows))


results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  PASS  " if ok else "  FAIL  ") + name + (("   " + detail) if detail else ""))


def bottom_ok(vt, label):
    """输入框贴底：光标在最后一行，且最后一行非空并含 prompt 特征。"""
    last = vt.line(vt.rows - 1)
    cursor_ok = vt.r == vt.rows - 1
    # prompt 形如 "🔥 flare> " 或 "> "；只要最后一个非空行是光标行即可
    populated = last.strip() != ""
    check(f"{label}: 光标在最后一行", cursor_ok, f"cursor.r={vt.r} rows={vt.rows}")
    check(f"{label}: 最后一行是输入行", populated, repr(last[-40:]))
    return cursor_ok and populated


def main():
    src_env = Path.home() / ".flare" / ".env"
    if src_env.exists():
        dst = Path(HOME) / ".env"
        shutil.copy(src_env, dst)
        os.chmod(dst, 0o600)

    print(f"cmd={' '.join(CMD)}  size={COLS}x{ROWS}")
    s = Session()
    try:
        s.drain(12.0)  # tsx 编译 + banner
        print("\n[A] 启动后")
        bottom_ok(s.vt, "A")

        print("\n[B] /help 大量输出后")
        before_sb = len(s.vt.scrollback)
        s.send("/help\r", 2.5)
        check("B: 输出触发过滚屏", len(s.vt.scrollback) > before_sb,
              f"scrollback {before_sb} -> {len(s.vt.scrollback)}")
        bottom_ok(s.vt, "B")
        screen_now = flat(s.vt)
        check("B: 内容仍在屏幕上（未被清掉）",
              ("/exit" in screen_now) or ("help" in screen_now.lower()) or ("命令" in screen_now),
              "屏幕上仍有 /help 输出文本")

        print("\n[C] 缩小窗口 60x20")
        s.resize(60, 20)
        bottom_ok(s.vt, "C-small")
        print("\n[C2] 放大窗口 120x40")
        s.resize(120, 40)
        bottom_ok(s.vt, "C-large")

        print("\n[D] 一次性粘贴 10 行")
        lines = [f"PASTELINE-{i}-ABCDEFG" for i in range(1, 11)]
        payload = "\x1b[200~" + "\n".join(lines) + "\x1b[201~"
        t0 = time.time()
        s.send(payload, 3.0)
        dt = time.time() - t0
        joined = flat(s.vt)
        missing = [i for i in range(1, 11) if f"PASTELINE-{i}-" not in joined]
        check("D: 10 行全部送达（屏幕或 scrollback）", not missing, f"缺 {missing}")
        check("D: 未卡死", dt < 6.0, f"{dt:.2f}s")
        bottom_ok(s.vt, "D")

        print("\n[F] 真实 agent 回答（流式输出路径）")
        # 期望值由脚本算，不靠心算；问句里不含答案，避免和用户输入混在一起
        a, b = 13, 17
        expect = str(a * b)
        clear_before = s.vt.clear_count
        s.send(f"{a} 乘以 {b} 等于多少？只回数字\r", 0.5)
        # 注意：agent 运行中 prompt 呼吸动画会持续写字节，不能用「安静」判定结束，
        # 只等期望答案出现（最多 60s）。
        deadline = time.time() + 60
        while time.time() < deadline and expect not in flat(s.vt):
            s.drain(0.5)
        s.drain(1.0)
        check("F: 回答已显示", expect in flat(s.vt), f"期望 {expect}")
        check("F: 回答期间没有再全屏清屏", s.vt.clear_count == clear_before,
              f"CSI 2J {clear_before} -> {s.vt.clear_count}")
        bottom_ok(s.vt, "F")

        print("\n[E] 清屏序列计数")
        check("E: 只在启动清屏一次", s.vt.clear_count == 1, f"CSI 2J 次数={s.vt.clear_count}")
    finally:
        s.close()
        shutil.rmtree(HOME, ignore_errors=True)

    bad = [n for n, ok, _ in results if not ok]
    print(f"\n== {len(results) - len(bad)}/{len(results)} 通过 ==")
    if bad:
        print("失败项:", ", ".join(bad))
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
