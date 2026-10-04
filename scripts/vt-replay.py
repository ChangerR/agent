#!/usr/bin/env python3
"""极简终端模拟器：回放 TUI 输出的字节流，打印最终可见屏幕。

用于判定渲染字节流是否正确（app 侧问题 vs 终端侧问题）。
支持：可打印字符（EAW 宽字符感知）、\\r \\n、CSI A/B/C/D/G/K/J/H、OSC 跳过。
"""
import re, sys, unicodedata

COLS = int(sys.argv[1]) if len(sys.argv) > 1 else 80
ROWS = int(sys.argv[2]) if len(sys.argv) > 2 else 24

def w(ch):
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1

class Term:
    def __init__(self):
        self.screen = [[" "] * COLS for _ in range(ROWS * 10)]  # 含 scrollback
        self.x = 0
        self.y = 0
    def put(self, ch):
        cw = w(ch)
        if self.x + cw > COLS:
            self.x = 0
            self.y += 1
            self.screen.append([" "] * COLS)
        self.screen[self.y][self.x] = ch
        if cw == 2:
            self.screen[self.y][self.x + 1] = ""
        self.x += cw
    def nl(self):
        self.x = 0
        self.y += 1
        while self.y >= len(self.screen):
            self.screen.append([" "] * COLS)
    def cr(self):
        self.x = 0
    def up(self, n): self.y = max(0, self.y - n)
    def down(self, n): self.y += n
    def col(self, n): self.x = max(0, n - 1)
    def clear_line(self): self.screen[self.y] = [" "] * COLS
    def clear_screen(self):
        self.screen = [[" "] * COLS]
        self.y = 0
        self.x = 0
    def home(self): self.x = 0; self.y = 0
    def text(self):
        lines = []
        for row in self.screen:
            lines.append("".join(c for c in row if c != ""))
        # 去掉尾部空行
        while lines and not lines[-1].strip():
            lines.pop()
        return "\n".join(lines)

data = open(sys.argv[3] if len(sys.argv) > 3 else "/tmp/tui-bytes.log", "rb").read()
t = Term()
i = 0
while i < len(data):
    b = data[i]
    if b == 0x1B:
        m = re.match(rb"\x1b\[([0-9;?]*)([A-Za-z@~])", data[i:])
        if m:
            params, cmd = m.group(1), m.group(2)
            n = int(params.split(b";")[0].replace(b"?", b"") or b"1") if params else 1
            if cmd == b"A": t.up(n)
            elif cmd == b"B": t.down(n)
            elif cmd == b"G": t.col(n)
            elif cmd == b"K": t.clear_line()
            elif cmd == b"J" and b"2" in params: t.clear_screen()
            elif cmd == b"H": t.home()
            i += m.end()
            continue
        m2 = re.match(rb"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", data[i:])
        if m2:
            i += m2.end()
            continue
        m3 = re.match(rb"\x1b[()][0-9A-Z]", data[i:])
        if m3:
            i += m3.end()
            continue
        i += 1  # 未知 ESC 序列按单字节跳过
        continue
    if b == 0x0D:
        t.cr(); i += 1; continue
    if b == 0x0A:
        t.nl(); i += 1; continue
    ch = data[i:i+4].decode("utf-8", "replace")[0]
    blen = len(ch.encode("utf-8", "replace"))
    t.put(ch)
    i += blen

print(f"=== 模拟终端 {COLS}x{ROWS} 的最终画面 ===")
print(t.text())
