import os, pty, sys, time, select, signal, json

CMD = ["/home/fantastic/.local/bin/flare", "chat", "-n"]
PASTE = "\n".join([f"LINE-{i}-粘贴测试内容ABCDEFG" for i in range(1, 11)]) + "\n"

pid, fd = pty.fork()
if pid == 0:
    os.chdir("/tmp")
    os.execvp(CMD[0], CMD)

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
            if not d: return False
            out += d
    return True

drain(3.0)          # 等 banner
os.write(fd, PASTE.encode())   # 一次性写入（模拟终端粘贴）
drain(2.5)          # 收集到 agent 开始运行
try: os.write(fd, b"\x03")
except OSError: pass
drain(0.8)
try: os.write(fd, b"\x03")
except OSError: pass
drain(0.5)
try: os.kill(pid, signal.SIGKILL)
except ProcessLookupError: pass
try: os.waitpid(pid, 0)
except ChildProcessError: pass

raw = out.decode("utf-8", "replace")
# 去掉 ANSI
import re
clean = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", raw)
print("=== 干净输出（最后 3000 字符）===")
print(clean[-3000:])
print("=== 统计 ===")
for i in range(1, 11):
    print(f"LINE-{i} 出现次数:", raw.count(f"LINE-{i}"))
