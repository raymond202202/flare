#!/usr/bin/env python3
"""端到端验证：粘贴 → 按 Enter 提交 → 从会话库读回 user 消息，确认逐字完整。

用法（在仓库任意位置执行均可）:
  python3 tests/manual/pty_paste_e2e.py
  FLARE_BIN=flare python3 tests/manual/pty_paste_e2e.py    # 测已安装的生产二进制

隔离说明:
  会话库写入临时 FLARE_HOME（tempfile.mkdtemp），脚本结束即删除；
  ~/.flare/.env 仅在存在时复制一份到该临时目录，随目录销毁，不打印任何配置值。
"""
import os
import re
import shutil
import signal
import sqlite3
import sys
import tempfile
import time
import pty
import select
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HOME = tempfile.mkdtemp(prefix="flare-paste-e2e-")

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

    lines = [f"PASTE-{i}: 第{i}行中文内容，含标点和符号 ABC-{i}" for i in range(1, 6)]
    body = "\n".join(lines)

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

    drain(10.0)                                  # 等 tsx 编译 + banner
    os.write(fd, ("\x1b[200~" + body + "\x1b[201~").encode())
    drain(1.0)
    os.write(fd, b"\r")                          # 提交
    drain(2.5)                                   # 等 user 消息入库（不等模型回完）
    try:
        os.write(fd, b"\x03")
    except OSError:
        pass
    drain(0.5)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass

    db = os.path.join(HOME, "flare.db")
    if not os.path.exists(db):
        print("FAIL: 会话库未生成", db)
        sys.exit(1)

    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "select role, content from messages where role='user' order by rowid desc limit 3"
    ).fetchall()
    con.close()
    if not rows:
        print("FAIL: 库里没有 user 消息")
        sys.exit(1)

    content = rows[0]["content"]
    if isinstance(content, bytes):
        content = content.decode("utf-8", "replace")
    if not isinstance(content, str):
        content = str(content)

    print("=== 库里读到的 user 消息 ===")
    print(repr(content[:400]))
    print("=== 逐行核对 ===")
    ok = True
    for ln in lines:
        hit = ln in content
        ok = ok and hit
        print(f"  {'OK ' if hit else 'MISS'} {ln}")
    print("行数:", len([ln for ln in content.split("\n") if ln.strip()]))
    print("结果:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)
finally:
    shutil.rmtree(HOME, ignore_errors=True)
