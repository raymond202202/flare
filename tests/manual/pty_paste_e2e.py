#!/usr/bin/env python3
"""端到端验证：粘贴 → 按 Enter 提交 → 从会话库读回 user 消息，确认逐字完整。"""
import os, pty, sys, time, select, signal, shutil, sqlite3, re

CWD = "/home/fantastic/hermes-projects/flare"
HOME = "/tmp/flare-paste-e2e"
CMD = ["npx", "tsx", "src/cli/index.ts", "chat", "-n"]

if os.path.isdir(HOME):
    shutil.rmtree(HOME)
os.makedirs(HOME, exist_ok=True)
src_env = os.path.expanduser("~/.flare/.env")
if os.path.exists(src_env):
    shutil.copy(src_env, os.path.join(HOME, ".env"))

lines = [f"PASTE-{i}: 第{i}行中文内容，含标点和符号 ABC-{i}" for i in range(1, 6)]
body = "\n".join(lines)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(CWD)
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

drain(10.0)
os.write(fd, ("\x1b[200~" + body + "\x1b[201~").encode())
drain(1.0)
os.write(fd, b"\r")       # 提交
drain(2.5)                # 让 user 消息入库（不等模型回复完）
try: os.write(fd, b"\x03")
except OSError: pass
drain(0.5)
try: os.kill(pid, signal.SIGKILL)
except ProcessLookupError: pass
try: os.waitpid(pid, 0)
except ChildProcessError: pass

db = os.path.join(HOME, "flare.db")
if not os.path.exists(db):
    print("FAIL: 会话库未生成", db)
    sys.exit(1)

con = sqlite3.connect(db)
con.row_factory = sqlite3.Row
rows = con.execute("select role, content from messages where role='user' order by rowid desc limit 3").fetchall()
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
print("行数:", len([l for l in content.split("\n") if l.strip()]))
print("结果:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
