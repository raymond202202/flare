#!/usr/bin/env python3
"""真实 PTY 粘贴回归：验证 bracketed paste 与旧式粘贴都不会截断。

用法（在仓库任意位置执行均可）:
  python3 tests/manual/pty_paste_verify.py bracketed   # 模拟支持 2004 模式的终端
  python3 tests/manual/pty_paste_verify.py legacy      # 模拟不支持 2004 的老终端
  FLARE_BIN=flare python3 tests/manual/pty_paste_verify.py bracketed   # 测已安装的生产二进制

隔离说明:
  会话数据全部写入临时 FLARE_HOME（tempfile.mkdtemp），脚本结束即删除。
  若存在 ~/.flare/.env，会复制一份到临时目录供 flare 读取模型配置；该副本随临时目录
  一起销毁，不进入仓库、不进入 git，也不打印任何配置值。
"""
import os
import re
import shutil
import signal
import sys
import tempfile
import time
import pty
import select
from pathlib import Path

MODE = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else "bracketed"
REPO = Path(__file__).resolve().parents[2]
HOME = tempfile.mkdtemp(prefix="flare-paste-verify-")

bin_env = os.environ.get("FLARE_BIN")
if bin_env:
    CMD = [shutil.which(bin_env) or bin_env, "chat", "-n"]
else:
    CMD = ["npx", "tsx", "src/cli/index.ts", "chat", "-n"]

src_env = Path.home() / ".flare" / ".env"
try:
    if src_env.exists():
        dst = Path(HOME) / ".env"
        shutil.copy(src_env, dst)
        os.chmod(dst, 0o600)

    lines = [f"LINE-{i}-粘贴测试内容ABCDEFG" for i in range(1, 11)]
    body = "\n".join(lines)
    payload = ("\x1b[200~" + body + "\x1b[201~") if MODE == "bracketed" else (body + "\n")

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(REPO)
        env = dict(os.environ)
        env["FLARE_HOME"] = HOME
        env["TERM"] = "xterm-256color"
        os.execvpe(CMD[0], CMD, env)

    out = b""

    def drain(t=0.3):
        global out
        end = time.time() + t
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try:
                    d = os.read(fd, 65536)
                except OSError:
                    return False
                if not d:
                    return False
                out += d
        return True

    drain(10.0)                      # 等 tsx 编译 + banner（生产二进制可缩短）
    before = len(out)
    os.write(fd, payload.encode())   # 一次性写入（模拟终端粘贴）
    drain(3.0)

    pid_out = len(out) - before
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass

    raw = out.decode("utf-8", "replace")
    clean = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", raw)
    clean = re.sub(r"\x1b\][^\x07]*\x07", "", clean)

    print(f"mode={MODE}  cmd={' '.join(CMD)}  粘贴输出字节={pid_out}")
    print("=== 统计（每行至少出现 1 次即通过）===")
    ok = True
    for i in range(1, 11):
        n = raw.count(f"LINE-{i}-")
        if n == 0:
            ok = False
        print(f"  LINE-{i}: {n}")
    print("U+FFFD 次数:", raw.count("\ufffd"))
    print("尾部输出:")
    print(clean[-800:])
    print("结果:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)
finally:
    shutil.rmtree(HOME, ignore_errors=True)
