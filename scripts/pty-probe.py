#!/usr/bin/env python3
"""在 pty 中运行指定命令，捕获原始输出字节流（用于对比 kimi-code 与 agentlab 的 TUI 输出）。"""
import os, pty, select, sys, time

cmd = sys.argv[1:]  # 例如: node dist/cli/index.js 或 kimi
out_path = os.environ.get("PROBE_OUT", "/tmp/probe.log")
keystrokes = os.environ.get("PROBE_KEYS", "")  # 可选注入按键
probe_cols = int(os.environ.get("PROBE_COLS", "80"))
probe_rows = int(os.environ.get("PROBE_ROWS", "24"))

output = b""

def read_all(fd, duration):
    global output
    end = time.time() + duration
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            output += data

pid, fd = pty.fork()
if pid == 0:
    os.chdir(os.environ.get("PROBE_CWD", "/mnt/c/Users/dingj/Desktop/projects/agent"))
    os.execvp(cmd[0], cmd)

# 设置 pty 窗口尺寸（模拟窄终端）
import fcntl, struct, termios
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", probe_rows, probe_cols, 0, 0))

read_all(fd, 25.0)  # 等启动
if keystrokes:
    os.write(fd, keystrokes.encode())
    read_all(fd, float(os.environ.get("PROBE_WAIT_AFTER_KEYS", "2.0")))

os.write(fd, b"\x03\x03")  # Ctrl+C × 2
read_all(fd, 1.5)
try:
    os.close(fd)
except OSError:
    pass

with open(out_path, "wb") as f:
    f.write(output)
print(f"{cmd[0]}: {len(output)} bytes -> {out_path}", file=sys.stderr)
