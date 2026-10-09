#!/usr/bin/env python3
"""权限设置真实键盘验收（Python 标准库；不调用保存函数或 UI 回调）。

运行：python3 scripts/settings-e2e.py [--cols 80 --rows 24] [--output /tmp/settings-e2e]
仅复现旧行为：加 --source-ref <旧提交> --scenario mode（完整冻结旧源码，预期失败）。
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
import tarfile
import io
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
               "pnpm_config_verify_deps_before_run": "false",
               "ANTHROPIC_API_KEY": "settings-e2e-fake-key", "OPENAI_API_KEY": "settings-e2e-fake-key"}
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
        return any(line.startswith(("╭ ", "─ ")) and expected in line for line in self.screen.text().splitlines())

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

    def read_file(self, auto: bool, denied=False):
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
        if denied:
            assert "Agent 正在请求权限" not in output, "deny 规则不应被降级为询问"
            assert marker not in output, "deny 规则未阻止真实文件读取"
            assert "× read_file" in self.screen.text(), "缺少实际工具拒绝标记"
            self.log("断言", "deny 已阻止实际 read_file，且没有读出本次唯一文件内容")
        elif auto:
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
            self.step += 1
            self.log("按键", "Ctrl-C 退出隔离 CLI: b\'\\x03\'")
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
        self.source_ref = args.source_ref
        self.scenario = args.scenario
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
                         "source_ref": self.source_ref,
                         "source_commit": subprocess.check_output(["git", "rev-parse", f"{self.source_ref}^{{commit}}"], cwd=self.root, text=True).strip() if self.source_ref else None,
                         "scenario": self.scenario,
                         "script_sha256": hashlib.sha256(script).hexdigest(),
                         "dev_script": json.loads((self.root / "package.json").read_text())["scripts"]["dev"],
                         "node": subprocess.check_output(["node", "--version"], text=True).strip(),
                         "pnpm": subprocess.check_output(["pnpm", "--version"], text=True).strip(),
                         "lockfile_sha256": hashlib.sha256((self.root / "pnpm-lock.yaml").read_bytes()).hexdigest()}
        (self.output / "source-metadata.json").write_text(json.dumps(self.metadata, ensure_ascii=False, indent=2) + "\n")
        # 整轮验收从一个不可变源副本建立所有项目，避免其他改动污染重启和跨项目证据。
        self.source = self.output / "frozen-source"
        self.source.mkdir()
        if self.source_ref:
            archive = subprocess.check_output(["git", "archive", self.source_ref, "src", "package.json"], cwd=self.root)
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                tar.extractall(self.source, filter="data")
        else:
            shutil.copytree(self.root / "src", self.source / "src")
            shutil.copy2(self.root / "package.json", self.source / "package.json")
        manifest = {str(file.relative_to(self.source)): hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(self.source.rglob("*")) if file.is_file()}
        (self.output / "frozen-source-sha256.json").write_text(json.dumps(manifest, indent=2) + "\n")
        self.metadata["frozen_source_manifest_sha256"] = hashlib.sha256((self.output / "frozen-source-sha256.json").read_bytes()).hexdigest()
        (self.output / "source-metadata.json").write_text(json.dumps(self.metadata, ensure_ascii=False, indent=2) + "\n")
        print(f"验收证据目录: {self.output}", flush=True)

    def project(self, name: str, mode="ask"):
        path = self.output / name
        path.mkdir()
        (path / ".git").mkdir()
        for entry in ("src", "node_modules"):
            if entry == "src":
                shutil.copytree(self.source / entry, path / entry)
            else:
                (path / entry).symlink_to(self.root / entry, target_is_directory=True)
        shutil.copy2(self.source / "package.json", path / "package.json")
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
        global_path = self.home / ".agent/config.json"
        return ((project / "agent.config.json").read_bytes(), global_path.read_bytes() if global_path.exists() else None)

    def config(self, project):
        return json.loads((project / "agent.config.json").read_text())

    def check(self, label: str, condition: bool):
        assert condition, label
        self.passed.append(label)
        print("通过: " + label, flush=True)

    def assert_no_confirmation(self, terminal, start):
        output = bytes(terminal.raw[start:]).decode("utf-8", "replace")
        self.check("本次设置提交没有 Save 或二次确认面板", not any(text in output for text in ("确认会话模式", "确认 Save", "确认保存并应用", "Save ·", "放弃未保存")))

    def scope(self, terminal, scope="project"):
        terminal.dismiss()
        terminal.command("/settings", "设置")
        terminal.choose("权限", "本项目权限设置", exact=True)
        if scope == "global":
            terminal.choose("全局设置", "全局权限设置")

    def set_mode(self, terminal, mode: str, scope="project"):
        label = "本项目" if scope == "project" else "全局"
        terminal.choose("模式 ·", f"{label}权限模式")
        start = len(terminal.raw)
        terminal.choose("继承全局" if mode == "inherit" else mode, f"{label}权限设置", exact=mode != "inherit")
        self.assert_no_confirmation(terminal, start)

    def rules(self, terminal, kind="deny", scope="project"):
        label = "项目" if scope == "project" else "全局"
        terminal.choose("规则 ·", f"{label}权限规则")
        terminal.choose(f"{kind} ·", f"{label} {kind} 规则")

    def submit_rule(self, terminal, text="read_file", scope="project", kind="deny", cancel=False):
        label = "项目" if scope == "project" else "全局"
        terminal.choose("+ 添加规则", f"添加{label} {kind} 规则")
        terminal.key(text.encode(), f"键入规则 {text}", lambda: text in terminal.screen.text())
        start = len(terminal.raw)
        terminal.key(b"\x1b" if cancel else b"\r", "Esc 放弃未提交输入" if cancel else "Enter 一次提交规则", lambda: terminal.visible(f"{label} {kind} 规则"))
        self.assert_no_confirmation(terminal, start)

    def run_mode(self):
        project = self.project("mode-project")
        terminal = Terminal(self, project, "01-mode-command", "ask")
        start = len(terminal.raw)
        terminal.command("/mode auto", "auto · 思考")
        self.assert_no_confirmation(terminal, start)
        self.check("/mode auto 一次 Enter 已保存项目 auto", self.config(project)["permissionMode"] == "auto")
        terminal.read_file(auto=True)
        self.check("/mode auto 同一进程真实 read_file 免审批", True)
        terminal.close()
        terminal = Terminal(self, project, "02-mode-restart-menu", "auto")
        terminal.read_file(auto=True)
        self.check("/mode auto 退出重启后仍为 auto 且实际读取免审批", True)
        before = self.disk(project)
        terminal.command("/mode", "权限模式")
        terminal.key(b"\x1b", "Esc 未选择模式直接退出", lambda: terminal.visible("auto · 思考") and not terminal.visible("权限模式"))
        self.check("/mode 菜单 Esc 不提交且文件逐字节不变", self.disk(project) == before)
        terminal.command("/mode", "权限模式")
        start = len(terminal.raw)
        terminal.choose("ask", "ask · 思考", exact=True)
        self.assert_no_confirmation(terminal, start)
        self.check("/mode 菜单一次选择 ask 已保存并生效", self.config(project)["permissionMode"] == "ask")
        terminal.read_file(auto=False)
        self.check("设置无二次确认，但 ask 真实工具审批仍存在", True)
        terminal.close()
        terminal = Terminal(self, project, "03-mode-menu-restart", "ask")
        terminal.read_file(auto=False)
        self.check("/mode 菜单 ask 退出重启后仍要求真实工具审批", True)
        terminal.close()

    def run_settings(self):
        project = self.project("settings-project")
        terminal = Terminal(self, project, "04-settings-autosave", "ask")
        self.scope(terminal)
        self.set_mode(terminal, "auto")
        terminal.mode("auto")
        self.check("/settings 权限模式一次选择已保存项目并即时 auto", self.config(project)["permissionMode"] == "auto")
        terminal.read_file(auto=True)
        self.check("/settings auto 同一进程真实 read_file 免审批", True)
        self.scope(terminal)
        self.rules(terminal)
        before = self.disk(project)
        self.submit_rule(terminal, text="read_file(cancelled/**)", cancel=True)
        self.check("Esc 放弃未提交规则输入，项目和全局文件逐字节不变", self.disk(project) == before)
        self.submit_rule(terminal)
        self.check("规则输入一次 Enter 已自动落盘 deny read_file", self.config(project)["permissions"]["deny"] == ["read_file"])
        self.check("规则提交明确告知重启后生效", "重启" in terminal.screen.text())
        terminal.read_file(auto=True)
        self.check("规则重启前保持现有引擎，与界面说明一致", True)
        terminal.close()
        terminal = Terminal(self, project, "05-settings-restart-rules", "auto")
        terminal.read_file(auto=True, denied=True)
        self.check("自动保存的模式与 deny 规则重启后一致", True)
        self.scope(terminal)
        self.rules(terminal)
        terminal.choose("read_file", "项目 deny 规则", exact=True)
        start = len(terminal.raw)
        terminal.choose("删除规则", "项目 deny 规则")
        self.assert_no_confirmation(terminal, start)
        self.check("删除规则一次选择自动保存", self.config(project)["permissions"]["deny"] == [])
        terminal.read_file(auto=True, denied=True)
        self.check("删除规则已保存，重启前现有 deny 引擎保持不变", True)
        self.scope(terminal)
        terminal.choose("审批模型 ·", "项目审批模型")
        terminal.choose("输入模型名称", "项目审批模型名称")
        before = self.disk(project)
        terminal.key(b"cancelled-model", "键入未提交审批模型", lambda: "cancelled-model" in terminal.screen.text())
        terminal.key(b"\x1b", "Esc 放弃未提交审批模型", lambda: terminal.visible("项目审批模型"))
        self.check("Esc 放弃未提交模型输入不写盘", self.disk(project) == before)
        terminal.choose("输入模型名称", "项目审批模型名称")
        terminal.key(b"fake-settings-reviewer", "键入审批模型名称", lambda: "fake-settings-reviewer" in terminal.screen.text())
        start = len(terminal.raw)
        terminal.key(b"\r", "Enter 一次提交审批模型", lambda: terminal.visible("本项目权限设置"))
        self.assert_no_confirmation(terminal, start)
        self.check("审批模型输入一次 Enter 自动保存", self.config(project)["judgeModel"] == "fake-settings-reviewer")
        terminal.close()
        terminal = Terminal(self, project, "06-settings-restart-model", "auto")
        self.scope(terminal)
        terminal.choose("审批模型 ·", "项目审批模型")
        self.check("重启后设置显示自动保存的审批模型", "fake-settings-reviewer" in terminal.screen.text())
        terminal.read_file(auto=True)
        self.check("删除 deny 规则重启后真实读取恢复免审批", True)
        terminal.close()

    def run_inheritance(self):
        project = self.project("inherit-project")
        terminal = Terminal(self, project, "07-global-inheritance", "ask")
        self.scope(terminal, scope="global")
        self.set_mode(terminal, "auto", scope="global")
        terminal.mode("ask")
        self.check("全局一次选择保存 auto，项目 ask 覆盖后当前仍为 ask", json.loads((self.home / ".agent/config.json").read_text())["permissionMode"] == "auto")
        terminal.read_file(auto=False)
        self.scope(terminal)
        self.set_mode(terminal, "inherit")
        terminal.mode("auto")
        self.check("项目选择继承一次提交即删除本层模式并应用全局 auto", "permissionMode" not in self.config(project))
        terminal.read_file(auto=True)
        terminal.close()
        terminal = Terminal(self, project, "08-inherit-restart", "auto")
        terminal.read_file(auto=True)
        self.check("项目继承设置重启后一致", True)
        terminal.close()
        other = self.project("other-project", mode=None)
        terminal = Terminal(self, other, "09-other-project", "auto")
        terminal.read_file(auto=True)
        self.check("其他无覆盖项目继承全局 auto", True)
        terminal.close()

    def run_runtime_settings(self):
        project = self.project("runtime-settings-project", mode="auto")
        terminal = Terminal(self, project, "10-runtime-model-thinking", "auto")
        terminal.command("/settings", "设置")
        terminal.choose("模型", "选择模型", exact=True)
        before = self.disk(project)
        terminal.key(b"\x1b", "Esc 不提交模型选择", lambda: not terminal.visible("选择模型"))
        self.check("模型选择 Esc 不写配置", self.disk(project) == before)
        terminal.dismiss()
        terminal.command("/settings", "设置")
        terminal.choose("模型", "选择模型", exact=True)
        start = len(terminal.raw)
        terminal.choose("gpt-4o", "auto · 思考", exact=True)
        terminal.wait(lambda: "gpt-4o" in terminal.screen.text().splitlines()[-1], "模型选择后等待完整新页脚 gpt-4o")
        self.assert_no_confirmation(terminal, start)
        self.check("/settings 模型一次选择自动保存项目 model", self.config(project)["model"] == "gpt-4o")
        self.check("模型一次选择当前页脚立即生效", True)
        terminal.dismiss()
        terminal.command("/settings", "设置")
        terminal.choose("思考", "思考等级", exact=True)
        start = len(terminal.raw)
        terminal.choose("medium", "auto · 思考 medium", exact=True)
        self.assert_no_confirmation(terminal, start)
        self.check("/settings 思考一次选择自动保存项目 thinking", self.config(project)["thinking"] == "medium")
        self.check("思考一次选择当前页脚立即生效", terminal.visible("auto · 思考 medium"))
        self.check("模型选择保持离线 fake provider", self.config(project)["provider"] == "fake")
        terminal.read_file(auto=True)
        terminal.close()
        terminal = Terminal(self, project, "11-runtime-restart", "auto")
        self.check("模型与思考重启后和保存值一致", "gpt-4o" in terminal.screen.text().splitlines()[-1] and terminal.visible("auto · 思考 medium"))
        terminal.read_file(auto=True)
        terminal.close()

    def open_generic(self, terminal):
        terminal.dismiss()
        terminal.command("/settings", "设置")
        terminal.choose("插件实现与权限策略", "插件实现与权限策略 · 本项目", exact=True)
        terminal.wait(lambda: terminal.screen.selected() == "编辑 JSON", "通用设置直接打开本项目编辑入口")

    def edit_generic(self, terminal):
        terminal.choose("编辑 JSON", "插件实现与权限策略 · 本项目 · 编辑 JSON", exact=True)
        value = '{"reviewer":false}'
        terminal.key(b"\x05\x15" + value.encode(), "Ctrl-E Ctrl-U 替换为完整 JSON", lambda: value in terminal.screen.text())

    def run_generic_settings(self):
        project = self.project("generic-settings-project", mode="auto")
        terminal = Terminal(self, project, "12-generic-json-autosave", "auto")
        self.open_generic(terminal)
        self.check("通用插件设置默认本项目，全局仅为可选入口", "切换到全局" in terminal.screen.text())
        before = self.disk(project)
        self.edit_generic(terminal)
        terminal.key(b"\x1b", "Esc 放弃未提交 JSON", lambda: terminal.screen.selected() == "编辑 JSON")
        self.check("通用 JSON 输入 Esc 不写项目或全局配置", self.disk(project) == before)
        self.edit_generic(terminal)
        start = len(terminal.raw)
        terminal.key(b"\r", "Enter 一次保存通用 JSON", lambda: terminal.screen.selected() == "编辑 JSON")
        self.assert_no_confirmation(terminal, start)
        self.check("通用 JSON 一次 Enter 自动保存本项目", self.config(project)["capabilities"] == {"reviewer": False})
        self.check("通用本项目 JSON 保存不改全局文件", self.disk(project)[1] == before[1])
        self.check("通用插件设置明确提示重启生效", "重启后" in terminal.screen.text())
        before = self.disk(project)
        terminal.choose("切换到全局", "插件实现与权限策略 · 全局", exact=True)
        terminal.wait(lambda: terminal.screen.selected() == "编辑 JSON", "显式打开可选全局设置")
        self.check("只查看可选全局设置不写配置", self.disk(project) == before)
        terminal.read_file(auto=True)
        terminal.close()
        terminal = Terminal(self, project, "13-generic-json-restart", "auto")
        terminal.wait(lambda: "审批 未加载" in "\n".join(terminal.screen.text().splitlines()[-2:]), "重启后实际禁用已保存的 reviewer")
        self.check("通用 JSON 设置重启后真实装配生效", True)
        terminal.read_file(auto=True)
        terminal.close()

    def run_write_failure(self):
        project = self.project("failure-project", mode="auto")
        terminal = Terminal(self, project, "14-write-failure", "auto")
        original_mode = project.stat().st_mode & 0o777
        before = self.disk(project)
        try:
            project.chmod(0o555)
            self.check("写失败夹具真实不可创建配置文件", not os.access(project, os.W_OK))
            start = len(terminal.raw)
            terminal.key(b"/mode ask", "键入将失败的 /mode ask", lambda: "/mode ask" in terminal.screen.text())
            terminal.key(b"\r", "Enter 提交不可写项目模式", lambda: "保存失败" in terminal.screen.text())
            terminal.mode("auto")
            output = bytes(terminal.raw[start:]).decode("utf-8", "replace")
            self.check("/mode 写失败没有落盘、没有改变模式、没有虚假成功", self.disk(project) == before and not any(text in output for text in ("已保存", "已切换为 ask", "已应用为 ask")))
            terminal.read_file(auto=True)
            self.scope(terminal)
            terminal.choose("模式 ·", "本项目权限模式")
            start = len(terminal.raw)
            terminal.choose("ask", "本项目权限设置", exact=True)
            terminal.expect("保存失败")
            terminal.mode("auto")
            output = bytes(terminal.raw[start:]).decode("utf-8", "replace")
            self.check("/settings 写失败没有落盘、没有改变模式、没有虚假成功", self.disk(project) == before and not any(text in output for text in ("已保存", "已切换为 ask", "已应用为 ask")))
            terminal.read_file(auto=True)
            self.scope(terminal)
            self.rules(terminal)
            terminal.choose("+ 添加规则", "添加项目 deny 规则")
            terminal.key(b"read_file", "键入将写入失败的规则", lambda: "read_file" in terminal.screen.text())
            start = len(terminal.raw)
            terminal.key(b"\r", "Enter 提交不可写项目规则", lambda: terminal.visible("添加项目 deny 规则") and "保存失败" in terminal.screen.text())
            output = bytes(terminal.raw[start:]).decode("utf-8", "replace")
            self.check("规则写失败保留输入、不修改配置、不假报成功", self.disk(project) == before and "read_file" in terminal.screen.text() and "已保存" not in output)
            terminal.key(b"\x1b", "Esc 取消写失败规则输入", lambda: terminal.visible("项目 deny 规则"))
            terminal.read_file(auto=True)
        finally:
            project.chmod(original_mode)
        terminal.close()
        terminal = Terminal(self, project, "15-failure-restart", "auto")
        terminal.read_file(auto=True)
        self.check("写失败后重启仍保持原配置 auto", True)
        terminal.close()

    def run(self):
        if self.scenario in ("all", "mode"):
            self.run_mode()
        if self.scenario in ("all", "settings"):
            self.run_settings()
        if self.scenario in ("all", "inheritance"):
            self.run_inheritance()
        if self.scenario in ("all", "runtime"):
            self.run_runtime_settings()
        if self.scenario in ("all", "generic"):
            self.run_generic_settings()
        if self.scenario in ("all", "failure"):
            self.run_write_failure()

    def finish(self, error=None):
        for terminal in self.terminals:
            if not terminal.raw_file.closed:
                terminal.close()
        result = {"源码与运行版本": self.metadata, "通过": error is None, "终端尺寸": [self.cols, self.rows], "断言": self.passed, "错误": str(error) if error else None,
                  "说明": "ANSI 原始录制及文本终端回放，不是截图；仅初始夹具直接写配置，待测更改均经真实 PTY 键盘。"}
        (self.output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        self.events.close()
        evidence = {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(self.output.iterdir()) if file.is_file()}
        (self.output / "evidence-sha256.json").write_text(json.dumps(evidence, indent=2) + "\n")


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
    parser.add_argument("--source-ref", help="在隔离项目使用显式 Git 提交的完整 src + package.json；可用于旧版红灯复现")
    parser.add_argument("--scenario", choices=("all", "mode", "settings", "inheritance", "runtime", "generic", "failure"), default="all")
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
        suite.run()
    except BaseException as error:
        suite.finish(error)
        print(f"失败: {error}\n原始证据: {suite.output}", file=sys.stderr)
        return 1
    suite.finish()
    print(f"全部 {len(suite.passed)} 项通过；证据: {suite.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
