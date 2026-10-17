import os, pty, time, select, signal, re, fcntl, termios, struct
pid, fd = pty.fork()
if pid == 0:
    os.chdir("/tmp"); os.execvp("/home/fantastic/.local/bin/flare", ["flare","chat","-n"])
# 设置 pty 窗口为 24 行 x 80 列
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
out=b""
def drain(t):
    global out
    end=time.time()+t
    while time.time()<end:
        r,_,_=select.select([fd],[],[],0.05)
        if r:
            try: d=os.read(fd,65536)
            except OSError: return
            if not d: return
            out+=d
drain(1.0)
os.write(fd, b"/help\n")   # 输出 ~50 行，远超 24 行窗口
drain(2.0)
try: os.write(fd,b"\x03")
except OSError: pass
drain(0.3)
try: os.kill(pid,signal.SIGKILL)
except ProcessLookupError: pass
try: os.waitpid(pid,0)
except ChildProcessError: pass

raw = out.decode("utf-8","replace")
positions = re.findall(r"\x1b\[(\d+);(\d+)H", raw)
rows = [int(r) for r,c in positions]
print("窗口 24 行；光标绝对定位 row 值样本（最后 10 次）:", rows[-10:])
print("最大 row 值:", max(rows) if rows else None)
print("超过窗口高度的定位次数:", sum(1 for r in rows if r > 24))
# 最后几帧看输入行是否可见
frames = raw.split("\x1b[2J")
last = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]","",frames[-1])
print("最后一帧行数:", last.count("\n"))
print("最后一帧是否含 'flare>' 输入框:", "flare>" in last)
print("最后一帧尾部 200 字符:", repr(last[-200:]))
