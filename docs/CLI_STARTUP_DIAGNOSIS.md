# 云端 CLI / PTY 启动失败对照

## 结论与边界

这组失败属于既有 CLI / PTY 全进程时限对云端冷启动、并发与 CPU 配额敏感的类别，未发现 App 设置 / 权限逻辑回归。判断依据是基线复现、退出信号、受控冷启动容量曲线与清理检查，不能仅凭单跑通过判断。

原失败的全量日志没有同步子进程信号或资源采样，因此不能精确重建每次历史停顿。下面的 12 并发控制比原全量的两 worker 更强，用于验证容量边界，不能冒充原始并发。本轮没有重复全量、放宽时限、跳过测试、清缓存、修改产品逻辑或系统设置；此前全量失败记录仍保留。

对照基线为 master `9fbffd634adb8b228b0f5fe9c147343fd914e24c`，App 为 PR #50 `a3a60d7cccc170ca6b9982d43da527a0889f054e`。同一独立 Linux x64 云端、Node v24.19.0、相同运行时依赖；CPU 配额为 400000/100000，即 4 CPU，内存上限 16 GiB。未使用用户电脑或真实 / 付费模型。

## 原失败的准确信息

1. `tests/bash-readonly-pty.test.ts`：“原样 pnpm dev、默认规划与 auto：原命令零审批，受控 reviewer 写入及拒绝生效”。错误 `pnpm dev 未启动`，15 秒等待内没有出现 `Enter 发送`。输出末尾仅为 node_modules 元数据告警和 `$ node --import tsx src/cli/index.ts`，没有应用异常堆栈。
2. `tests/permission-settings-restart.test.ts`：“本项目直接选 auto 后立即生效，子目录重启仍为 auto，其他项目保持 ask”。错误 `Command failed: ... node --import .../tsx/dist/loader.mjs .../src/cli/index.ts --command /permissions --json`。此 helper 的单个 execFile 限制为 10 秒；原 Vitest 输出未保留 killed / signal，不能只从该字符串推断具体信号。

这两个入口、权限控制器、PTY helper 与 master 的文件 SHA256 相同，详见结构化证据。App 没有替换这些逻辑。

## 相同六文件、两 worker 的交替对照

使用实际仓库测试，不改断言或时限，顺序为 master / App / App / master；不使用名称过滤或重试。App 因此前独立拆分权限状态多一个测试，仍是相同六文件及七次 headless CLI 调用。

| 轮次     | 测试结果         | 累计 CPU 节流指标      | 组合结束时活子进程 | 僵尸子进程 |
| -------- | ---------------- | ---------------------- | ------------------ | ---------- |
| master 1 | 12 通过 / 2 失败 | 17.210 秒，97/535 周期 | 0                  | 12         |
| App 1    | 15 通过          | 0.525 秒，13/404 周期  | 0                  | 12         |
| App 2    | 15 通过          | 1.308 秒，23/465 周期  | 0                  | 17         |
| master 2 | 14 通过          | 1.149 秒，15/441 周期  | 0                  | 17         |

master 首轮的失败是 `cli-pty` 的“CLI 未就绪”和 `planning-pty` 的“重启未就绪”，不是配置或权限断言。它们使用与原 `bash-readonly-pty` 相同的 helper，输出同样只到 Node 启动命令。监测到两个失败终端约在 3.306 / 8.998 秒才输出该命令；15 秒后由测试的 finally 发送 Ctrl+C 清理，`script` 的 close code 为 130、signal 为 null。这个退出码反映清理，不能当作应用自行崩溃。

完整六文件组合结束时，两边都没有活子进程残留。重归 PID 1 的 Node / esbuild 等僵尸两边都有；没有 PID 配额上限、OOM 或存活进程泄漏证据，不能将其认定为 App 新增问题。没有改动 PID 1 或用户系统。

## 实际 headless CLI 的有限冷启动容量控制

复制两边的真实 src / package / tsconfig 到独立临时项目；每个项目单独 HOME、`.git` 和 fake provider 配置。执行实际 `node --import tsx .../src/cli/index.ts --command /permissions --json`，保持 10 秒 execFile 上限。

| 控制                    | master                            | App                          | CPU 节流                                                                 |
| ----------------------- | --------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| 顺序冷启动              | 2.595 秒                          | 2.093 秒                     | 0                                                                        |
| 8 并发冷启动，双方各 4  | 7.320–7.924 秒，全部正确返回      | 6.662–7.925 秒，全部正确返回 | 77/79 周期，累计 5.927 秒                                                |
| 12 并发冷启动，双方各 6 | 5 次触及 10 秒、1 次 9.503 秒返回 | 6 次触及 10 秒               | 100/101 周期，累计 9.240 秒；约 10 秒消耗 40.412 CPU 秒，达到 4 CPU 容量 |
| 此后顺序暖启动          | 0.962 秒                          | 0.977 秒                     | 0                                                                        |

12 并发中两边均捕获 `signal=SIGTERM`、`killed=true`，约 10.03–10.08 秒结束；大多数 stdout / stderr 为空。一个 master 子进程已输出正确权限 JSON，仍在全进程退出前触及时限，说明该上限也覆盖加载与退出，不能将 Command failed 等同于权限逻辑错误。初版容量探针把 null 数值码合并为 0，证据不使用该数值字段；信号和 killed 原样保留，公开复现脚本已修正 null 保留方式。

此控制直接复现基线和 App 的相同超时信号，但不证明历史全量当时恰有 12 个冷进程。结合基线正常测试组合的 PTY 就绪失败，可以把这类失败合理归于既有全进程预算的容量敏感性；没有依据为 App 增加重试、降级权限或调整时限。

## 共享资源与后续处理

- 项目和 HOME 使用唯一 mkdtemp，未复用端口或用户配置。日志没有 EADDRINUSE；这些 fake / 无 MCP 配置的启动不配置监听服务。
- 依赖复用同一已安装 node_modules。PTY helper 明确将 pnpm 依赖校验设为 warn，禁止偷偷联网重装；该告警在成功与失败轮都出现，且随后已执行 Node 命令，不是退出错误。
- 同 UID 的 `/tmp/tsx-1000` 缓存在诊断中观察到 14086 个条目。它是共享资源，但未证明是瓶颈，未清理或以此断言根因。
- 四轮组合与容量控制没有 OOM 事件。保留固定时限和实际 pnpm dev / Node 命令，不通过跳过或增大预算制造全绿。

本 PR 无需为这些证据修改产品配置 / 权限逻辑。合并前如要求全量绿，应在独立、资源稳定且有进程回收的云端环境再验证；不能把本次对照结果改写为此前全量已通过。macOS 原生验证仍另行进行。

## 复现与证据

要求独立 Linux 云端、cgroup v2、util-linux script、Node >=22.19、已安装同一锁定依赖。准备两个独立 checkout，分别定位到上述 SHA；不修改 master 或已合并 PR。以下输出目录必须为空：

```sh
node docs/evidence/cli-startup-diagnosis/reproduce-pty.mjs /path/to/master-worktree /path/to/app-worktree /tmp/agent-pty-evidence
node docs/evidence/cli-startup-diagnosis/reproduce-cold-cli.mjs /path/to/master-worktree /path/to/app-worktree /tmp/agent-cold-8-evidence 8
node docs/evidence/cli-startup-diagnosis/reproduce-cold-cli.mjs /path/to/master-worktree /path/to/app-worktree /tmp/agent-cold-12-evidence 12
```

容量控制的预期是记录机器边界，不保证每台机器在相同并发数超时；不得为得到预期结果反复循环或修改时限。所有探针只运行 FakeProvider 测试 / `/permissions`，不发送模型请求。

[结构化证据](evidence/cli-startup-diagnosis/comparison.json) · [master 首轮原日志](evidence/cli-startup-diagnosis/1-master.log) · [App 首轮](evidence/cli-startup-diagnosis/2-app.log) · [App 次轮](evidence/cli-startup-diagnosis/3-app.log) · [master 次轮](evidence/cli-startup-diagnosis/4-master.log)。结构化证据保留文件 hash、资源前后差分、真实 close code / signal 与全部容量样本。
