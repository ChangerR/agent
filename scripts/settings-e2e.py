#!/usr/bin/env python3
"""权限设置真实键盘验收（Python 标准库；不调用保存函数或 UI 回调）。

运行：python3 scripts/settings-e2e.py [--cols 80 --rows 24] [--output /tmp/settings-e2e]
仅复现旧行为：加 --legacy-ref <旧提交>（在临时副本使用该提交的权限 UI，预期失败）。
半帧回归自测：python3 scripts/settings-e2e.py --self-test（不启动 CLI）。
隔离 HOME 与项目，实际执行 pnpm dev，使用内置 fake provider 离线读取 sample.md。
每一步均等待 PTY 屏幕重绘后检查，保留 ANSI 原始录制、按键日志和文本屏幕；文本
屏幕是终端字节的回放，不是截图。初始配置可写入夹具，所有待测变更必须经键盘。
"""
from __future__ import annotations

import argparse
import codecs
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unicodedata


class Screen:
    """只解释实际 TUI 使用的 VT 序列；保留 UTF-8 分片与完整可见行。"""
    def __init__(self, cols: int, rows: int):
        self.cols, self.rows = cols, rows
        self.lines = [[" "] * cols for _ in range(rows)]
        self.x = self.y = 0
        self.pending = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.frames = 0
        self.frame_open = False

    def feed(self, data: bytes):
        self.pending += self.decoder.decode(data)
        i = 0
        while i < len(self.pending):
            ch = self.pending[i]
            if ch == "\x1b":
                if i + 1 == len(self.pending):
                    break
                if self.pending[i + 1] == "[":
                    match = re.match(r"\x1b\[([0-?]*)([ -/]*)([@-~])", self.pending[i:])
                    if not match:
                        break
                    self.csi(match[1], match[3])
                    i += match.end()
                    continue
                if self.pending[i + 1] == "]":
                    match = re.match(r"\x1b\].*?(?:\x07|\x1b\\)", self.pending[i:], re.S)
                    if not match:
                        break
                    i += match.end()
                    continue
                i += 2
                continue
            if ch == "\r":
                self.x = 0
            elif ch == "\n":
                self.y += 1
                if self.y >= self.rows:
                    self.lines.pop(0)
                    self.lines.append([" "] * self.cols)
                    self.y = self.rows - 1
            elif ch == "\b":
                self.x = max(0, self.x - 1)
            elif ch >= " " and ch != "\x7f":
                width = 0 if unicodedata.combining(ch) else 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
                if width and self.x < self.cols:
                    self.lines[self.y][self.x] = ch
                    if width == 2 and self.x + 1 < self.cols:
                        self.lines[self.y][self.x + 1] = ""
                    self.x += width
            i += 1
        self.pending = self.pending[i:]

    def csi(self, raw: str, command: str):
        if raw == "?2026":
            if command == "h":
                self.frame_open = True
            elif command == "l":
                self.frame_open = False
                self.frames += 1
        params = [int(x) if x.isdigit() else 0 for x in raw.lstrip("?>").split(";")]
        n = params[0] or 1
        if command in "Hf":
            self.y = min(self.rows - 1, n - 1)
            self.x = min(self.cols - 1, (params[1] if len(params) > 1 and params[1] else 1) - 1)
        elif command == "G":
            self.x = min(self.cols - 1, n - 1)
        elif command == "A":
            self.y = max(0, self.y - n)
        elif command == "B":
            self.y = min(self.rows - 1, self.y + n)
        elif command == "C":
            self.x = min(self.cols - 1, self.x + n)
        elif command == "D":
            self.x = max(0, self.x - n)
        elif command == "J" and params[0] in (2, 3):
            self.lines = [[" "] * self.cols for _ in range(self.rows)]
        elif command == "K":
            start, end = (0, self.cols) if params[0] == 2 else (0, min(self.cols, self.x + 1)) if params[0] == 1 else (self.x, self.cols)
            self.lines[self.y][start:end] = [" "] * (end - start)

    @property
    def complete(self) -> bool:
        # 一次 os.read 可能仅含半帧；旧帧计数递增过不代表新屏幕已完成。
        return self.frames > 0 and not self.frame_open and not self.pending

    def input_tokens(self) -> int | None:
        if not self.complete:
            return None
        match = re.search(r"^\s*↑(\d+)\s+↓", "\n".join(self.text().splitlines()[-2:]), re.M)
        return int(match[1]) if match else None

    def tokens_at_least(self, count: int) -> bool:
        tokens = self.input_tokens()
        return tokens is not None and tokens >= count

    def text(self) -> str:
        return "\n".join("".join(row).rstrip() for row in self.lines)

    def selected(self) -> str | None:
        for line in self.text().splitlines():
            match = re.match(r"^\s*(?:│\s*)?> (.*?)\s*(?:│)?$", line)
            if match:
                return match[1].strip()
        return None


class Terminal:
    def __init__(self, suite, project: Path, name: str, expected_mode: str):
        self.suite, self.name, self.project = suite, name, project
        self.screen = Screen(suite.cols, suite.rows)
        self.raw = bytearray()
        self.raw_file = (suite.output / f"{name}.ansi.raw").open("wb")
        self.dead = False
        self.step = 0
        self.snapshot_index = 0
        env = {"HOME": str(suite.home), "PATH": os.environ["PATH"], "TERM": "xterm-256color", "LANG": "C.UTF-8",
               "pnpm_config_verify_deps_before_run": "false"}
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(project)
            os.execvpe("pnpm", ["pnpm", "dev"], env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", suite.rows, suite.cols, 0, 0))
        suite.terminals.append(self)
        self.log("启动", f"cwd={project}; HOME={suite.home}; pnpm dev; {suite.cols}x{suite.rows}")
        self.wait(lambda: "AgentLab" in self.screen.text() and f"{expected_mode} · 思考" in self.screen.text(), "等待 CLI 启动", timeout=30)

    def log(self, action: str, detail: str):
        record = {"进程": self.name, "步骤": self.step, "动作": action, "详情": detail, "时间": round(time.monotonic() - self.suite.started, 3), "原始字节位置": len(self.raw)}
        self.suite.events.write(json.dumps(record, ensure_ascii=False) + "\n")
        self.suite.events.flush()

    def pump(self, timeout=0.1):
        if self.dead:
            return
        ready, _, _ = select.select([self.fd], [], [], timeout)
        if ready:
            try:
                data = os.read(self.fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                self.dead = True
                return
            self.raw.extend(data)
            self.raw_file.write(data)
            self.raw_file.flush()
            self.screen.feed(data)

    def snapshot(self, label: str):
        self.snapshot_index += 1
        path = self.suite.output / f"{self.name}-{self.snapshot_index:03d}.screen.txt"
        path.write_text(f"PTY 可见屏幕文本回放（非截图）: {label}\n{self.screen.text()}\n", encoding="utf-8")
        self.log("屏幕通过", label)

    def wait(self, predicate, label: str, timeout=8, after_frame=None):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.pump()
            if self.screen.complete and (after_frame is None or self.screen.frames > after_frame) and predicate():
                self.snapshot(label)
                return
            if self.dead:
                break
        self.snapshot("失败: " + label)
        raise AssertionError(f"{self.name}: {label}\n{self.screen.text()}")

    def expect(self, text: str):
        self.wait(lambda: text in self.screen.text(), f"可见 {text}")

    def key(self, data: bytes, label: str, predicate=None, timeout=8):
        self.step += 1
        frame = self.screen.frames
        before = self.screen.text()
        self.log("按键", f"{label}: {data!r}")
        os.write(self.fd, data)
        self.wait(lambda: self.screen.text() != before and (predicate is None or predicate()), label, timeout, after_frame=frame)

    def visible(self, expected: str) -> bool:
        if "· 思考" in expected:
            return expected in "\n".join(self.screen.text().splitlines()[-2:])
        # 菜单转场必须等目标标题，不能被旧菜单的同名选项提前满足。
        return any(line.startswith("╭ ") and expected in line for line in self.screen.text().splitlines())

    def choose(self, label: str, expect: str, exact=False):
        seen = set()
        for _ in range(24):
            selected = self.screen.selected()
            if selected is not None and (selected == label if exact else label in selected):
                self.key(b"\r", f"Enter 选择 {selected}", lambda: self.visible(expect))
                return
            if selected in seen:
                raise AssertionError(f"找不到菜单选项 {label}，已扫描 {seen}\n{self.screen.text()}")
            seen.add(selected)
            self.key(b"\x1b[B", f"Down 寻找 {label}", lambda: self.screen.selected() != selected)
        raise AssertionError(f"菜单循环超限: {label}")

    def command(self, line: str, expect: str):
        self.key(line.encode(), f"输入 {line}", lambda: line in self.screen.text())
        self.key(b"\r", f"Enter 提交 {line}", lambda: self.visible(expect) if line.startswith("/") else expect in self.screen.text())

    def mode(self, mode: str):
        self.wait(lambda: self.visible(f"{mode} · 思考"), f"页脚当前模式 {mode}")

    def dismiss(self):
        for _ in range(6):
            text = self.screen.text()
            if "╭" not in text and "Tab 查看完整详情" not in text:
                return
            self.key(b"\x1b", "Esc 返回上一层")
        raise AssertionError("未能返回输入框")

    def read_file(self, auto: bool):
        self.dismiss()
        self.suite.read_number += 1
        marker = f"SETTINGS_E2E_READ_OK_{self.suite.read_number:02d}"
        (self.project / "sample.md").write_text(marker + "\n")
        self.wait(lambda: self.screen.input_tokens() is not None, "等待读取前完整页脚")
        tokens_before = self.screen.input_tokens()
        assert tokens_before is not None
        start = len(self.raw)
        self.command("请读取 sample.md", "sample.md")
        self.wait(lambda: "Agent 正在请求权限" in self.screen.text() or self.screen.tokens_at_least(tokens_before + 20), "等待真实 read_file 权限或结果")
        output = bytes(self.raw[start:]).decode("utf-8", "replace")
        if auto:
            assert "Agent 正在请求权限" not in output, "auto 仍弹出权限审批"
            self.expect("[fake provider]")
            assert "✓ read_file" in self.screen.text(), "缺少真实工具成功标记"
            assert marker in self.screen.text() and marker in output, "缺少本次唯一文件内容，不能用旧回复代替成功"
            self.log("断言", "read_file 完成且录制中没有权限面板")
        else:
            self.expect("Agent 正在请求权限")
            self.expect("read_file")
            self.key(b"\x1b", "Esc 拒绝本次 read_file", lambda: "Agent 正在请求权限" not in self.screen.text() and self.screen.tokens_at_least(tokens_before + 20))
            self.log("断言", "ask 确实要求审批，已拒绝且未新增规则")

    def close(self):
        if not self.dead:
            os.write(self.fd, b"\x03")
            end = time.monotonic() + 3
            while not self.dead and time.monotonic() < end:
                self.pump()
            if not self.dead:
                # 只结束本验收创建的隔离 CLI 进程组。
                os.killpg(self.pid, signal.SIGTERM)
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass
        os.close(self.fd)
        self.raw_file.close()
        self.dead = True


class Suite:
    def __init__(self, args):
        self.root = Path(__file__).resolve().parent.parent
        self.legacy = args.legacy_ref
        self.output = Path(args.output).resolve() if args.output else Path(tempfile.mkdtemp(prefix="agent-settings-e2e-"))
        self.output.mkdir(parents=True, exist_ok=False) if args.output else None
        self.home = self.output / "home"
        self.home.mkdir()
        self.cols, self.rows = args.cols, args.rows
        self.started = time.monotonic()
        self.terminals = []
        self.events = (self.output / "steps.jsonl").open("w", encoding="utf-8")
        self.passed = []
        self.read_number = 0
        script = Path(__file__).read_bytes()
        (self.output / "settings-e2e.executed.py").write_bytes(script)
        self.metadata = {"git_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.root, text=True).strip(),
                         "working_diff_sha256": hashlib.sha256(subprocess.check_output(["git", "diff", "HEAD", "--", "src", "package.json"], cwd=self.root)).hexdigest(),
                         "legacy_ref": self.legacy,
                         "legacy_commit": subprocess.check_output(["git", "rev-parse", f"{self.legacy}^{{commit}}"], cwd=self.root, text=True).strip() if self.legacy else None,
                         "script_sha256": hashlib.sha256(script).hexdigest(),
                         "dev_script": json.loads((self.root / "package.json").read_text())["scripts"]["dev"],
                         "node": subprocess.check_output(["node", "--version"], text=True).strip(),
                         "pnpm": subprocess.check_output(["pnpm", "--version"], text=True).strip(),
                         "lockfile_sha256": hashlib.sha256((self.root / "pnpm-lock.yaml").read_bytes()).hexdigest()}
        (self.output / "source-metadata.json").write_text(json.dumps(self.metadata, ensure_ascii=False, indent=2) + "\n")
        print(f"验收证据目录: {self.output}", flush=True)

    def project(self, name: str, mode="ask"):
        path = self.output / name
        path.mkdir()
        (path / ".git").mkdir()
        for entry in ("src", "node_modules"):
            if entry == "src":
                shutil.copytree(self.root / entry, path / entry)
                if self.legacy:
                    old_ui = subprocess.check_output(["git", "show", f"{self.legacy}:src/builtin/policy-legacy/tui.ts"], cwd=self.root)
                    (path / "src/builtin/policy-legacy/tui.ts").write_bytes(old_ui)
            else:
                (path / entry).symlink_to(self.root / entry, target_is_directory=True)
        shutil.copy2(self.root / "package.json", path / "package.json")
        manifest = {str(file.relative_to(path)): hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted((path / "src").rglob("*")) if file.is_file()}
        manifest["package.json"] = hashlib.sha256((path / "package.json").read_bytes()).hexdigest()
        (self.output / f"{name}-source-sha256.json").write_text(json.dumps(manifest, indent=2) + "\n")
        config = {"provider": "fake", "model": "fake-offline", "permissions": {"allow": [], "ask": [], "deny": []}}
        if mode is not None:
            config["permissionMode"] = mode
        (path / "agent.config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n")
        (path / "sample.md").write_text("SETTINGS_E2E_READ_OK\n", encoding="utf-8")
        return path

    def disk(self, project):
        return ((project / "agent.config.json").read_bytes(), (self.home / ".agent/config.json").read_bytes())

    def check(self, label: str, condition: bool):
        assert condition, label
        self.passed.append(label)
        print("通过: " + label, flush=True)

    def scope(self, terminal, scope="project", settings=False):
        terminal.dismiss()
        if settings:
            terminal.command("/settings", "设置 · 本次会话")
            terminal.choose("权限", "权限设置", exact=True)
        else:
            terminal.command("/permissions", "权限设置")
        terminal.choose("本项目默认设置" if scope == "project" else "全局默认设置", "项目默认设置" if scope == "project" else "全局默认设置")

    def draft(self, terminal, mode: str, scope="project"):
        label = "项目" if scope == "project" else "全局"
        terminal.choose("默认模式", f"{label}默认模式 · 草稿")
        terminal.choose("继承全局" if mode == "inherit" else mode, f"{label}默认设置 · 未保存", exact=mode != "inherit")

    def save(self, terminal, scope="project", apply=True, legacy=False):
        label = "项目" if scope == "project" else "全局"
        terminal.choose(f"Save · 保存{label}草稿", f"确认 Save {label}权限设置")
        choice = f"Save · 确认写入{label}配置" if legacy else "应用" if apply else "仅保存"
        if apply and not legacy:
            terminal.choose(choice, "确认保存并应用模式")
            terminal.choose("确认保存并应用", f"{label}默认设置")
        else:
            terminal.choose(choice, f"{label}默认设置")

    def run(self, legacy=False):
        project = self.project("project")
        terminal = Terminal(self, project, "01-save-apply", "ask")
        self.scope(terminal, settings=True)
        self.draft(terminal, "auto")
        self.save(terminal, legacy=legacy)
        self.check("项目 Save 已落盘 auto", json.loads((project / "agent.config.json").read_text())["permissionMode"] == "auto")
        terminal.mode("auto")
        self.check("同一进程页脚即时切为 auto", True)
        terminal.read_file(auto=True)
        self.check("同一进程 auto 实际读取免审批", True)
        terminal.close()
        if legacy:
            return
        terminal = Terminal(self, project, "02-restart-save-only-cancel", "auto")
        terminal.read_file(auto=True)
        self.check("新进程继承项目 auto 并真实读取免审批", True)
        self.scope(terminal)
        self.draft(terminal, "ask")
        self.save(terminal, apply=False)
        terminal.mode("auto")
        self.check("仅保存 ask 不改变当前 auto", json.loads((project / "agent.config.json").read_text())["permissionMode"] == "ask")
        terminal.read_file(auto=True)
        before = self.disk(project)
        self.scope(terminal)
        self.draft(terminal, "yolo")
        terminal.choose("Save · 保存项目草稿", "确认 Save 项目权限设置")
        terminal.choose("保存并应用模式", "确认保存并应用模式")
        terminal.choose("取消", "确认 Save 项目权限设置", exact=True)
        terminal.mode("auto")
        self.check("取消最终应用确认不写配置也不改变当前模式", before == self.disk(project))
        terminal.choose("取消", "项目默认设置", exact=True)
        terminal.mode("auto")
        self.check("取消 Save 不写配置也不改变当前模式", before == self.disk(project))
        terminal.key(b"\x1b", "Esc 返回并询问放弃草稿", lambda: "放弃未保存" in terminal.screen.text())
        terminal.choose("放弃草稿并返回", "权限设置")
        terminal.dismiss()
        before = self.disk(project)
        terminal.command("/mode ask", "确认会话模式 → ask")
        terminal.choose("确认切换为 ask", "ask · 思考")
        self.check("/mode ask 即时生效且项目/全局配置逐字节未变", before == self.disk(project))
        terminal.read_file(auto=False)
        terminal.close()
        terminal = Terminal(self, project, "03-global-override-inherit", "ask")
        self.check("仅保存的 ask 在重启后生效", True)
        self.scope(terminal, scope="global")
        self.draft(terminal, "auto", scope="global")
        self.save(terminal, scope="global")
        terminal.mode("ask")
        self.check("全局保存 auto，项目 ask 覆盖后当前仍为 ask", json.loads((self.home / ".agent/config.json").read_text())["permissionMode"] == "auto")
        terminal.read_file(auto=False)
        self.scope(terminal)
        self.draft(terminal, "inherit")
        self.save(terminal)
        terminal.mode("auto")
        self.check("项目继承删除本层模式并即时应用全局 auto", "permissionMode" not in json.loads((project / "agent.config.json").read_text()))
        terminal.read_file(auto=True)
        terminal.close()
        terminal = Terminal(self, project, "04-restart-inherited", "auto")
        terminal.read_file(auto=True)
        self.check("新进程继承全局 auto 并实际读取免审批", True)
        terminal.close()
        untouched = self.project("second-project", mode=None)
        terminal = Terminal(self, untouched, "05-new-project-global", "auto")
        terminal.read_file(auto=True)
        self.check("另一项目也继承全局 auto", True)
        terminal.close()

    def finish(self, error=None):
        for terminal in self.terminals:
            if not terminal.raw_file.closed:
                terminal.close()
        result = {"源码与运行版本": self.metadata, "通过": error is None, "终端尺寸": [self.cols, self.rows], "断言": self.passed, "错误": str(error) if error else None,
                  "说明": "ANSI 原始录制及文本终端回放，不是截图；仅初始夹具直接写配置，待测更改均经真实 PTY 键盘。"}
        (self.output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        self.events.close()


def self_test():
    """模拟真实失败：新帧清屏后 footer 尚未到达，逐字节送入且绝不提前通过。"""
    screen = Screen(100, 30)
    screen.feed("\x1b[?2026h\x1b[2J\x1b[30;1H ↑40 ↓40 · cache 0%\x1b[?2026l".encode())
    assert screen.complete and screen.input_tokens() == 40
    screen.feed(b"\x1b[?2026h\x1b[2J")
    assert screen.frames == 1 and not screen.complete
    assert screen.input_tokens() is None and not screen.tokens_at_least(60)
    footer = "\x1b[30;1H ↑60 ↓60 · cache 0%\x1b[?2026l".encode()
    for index, byte in enumerate(footer):
        screen.feed(bytes([byte]))
        if index < len(footer) - 1:
            assert not screen.complete and not screen.tokens_at_least(60)
    assert screen.complete and screen.frames == 2 and screen.tokens_at_least(60)
    # 完整帧若缺少真实 footer，也不能伪造 token 进度或吞掉超时。
    screen.feed(b"\x1b[?2026h\x1b[2J\x1b[?2026l")
    assert screen.complete and screen.input_tokens() is None and not screen.tokens_at_least(60)
    print("通过: 半帧清屏、UTF-8/CSI 逐字节分片、完整帧缺少 footer 均不误判或抛异常")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="只运行终端半帧回归，不启动 CLI")
    parser.add_argument("--output", help="保存证据的新目录（不得已存在）")
    parser.add_argument("--cols", type=int, default=100)
    parser.add_argument("--rows", type=int, default=30)
    parser.add_argument("--legacy-ref", help="临时副本使用显式 Git 旧提交的权限 UI，运行即时 auto 断言（预期失败）")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    version = subprocess.check_output(["node", "--version"], text=True).strip()
    if tuple(map(int, version.lstrip("v").split("."))) < (22, 19, 0):
        parser.error("需要 Node.js >= 22.19.0")
    if not shutil.which("pnpm"):
        parser.error("需要已安装 pnpm 和项目依赖")
    suite = Suite(args)
    try:
        suite.run(legacy=bool(args.legacy_ref))
    except BaseException as error:
        suite.finish(error)
        print(f"失败: {error}\n原始证据: {suite.output}", file=sys.stderr)
        return 1
    suite.finish()
    print(f"全部 {len(suite.passed)} 项通过；证据: {suite.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
