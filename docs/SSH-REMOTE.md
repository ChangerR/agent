# Desktop SSH 远程工作区

已实现首轮可用版本：本机 Electron 展示消息/审批，远程 Node 运行 AgentLoop、权限管线、工具、插件和会话；所有主模型、规划、审批、压缩与子 Agent 模型请求经 SSH 返回本机 Broker，再由现有 Provider 发送到模型端点。远程不接收本机 API key，也不自动回退远程模型连接。

首轮使用 `ubuntu@10.100.0.8` 做了隔离验收。测试只使用本机 mock API 与固定假 key，没有调用真实模型服务或使用服务器现有项目。

## 使用

1. 在系统终端确认 `ssh <目标>` 可通过已配置密钥/ssh-agent 登录，目标已在 known_hosts 或主机证书信任库中。首版不弹密码/MFA，也不自动跳过主机验证。
2. 在 App 的本机模型设置中配置并保存连接。API key 继续经 safeStorage 保存；环境变量方式也可用，但必须由启动 Desktop 的进程提供。本机 Broker 不读取某个本地项目的 `.env`。
3. 项目首页点击“添加主机”，只填写 Host alias 或 `ubuntu@10.100.0.8` 和可选名称。验证成功后主机单独保存；此时没有创建项目，也不启动 Agent 或模型请求。
4. 准备下节的 Linux 离线服务包并构建应用。点击已添加主机的“打开项目”，浏览远程目录、进入子目录或返回上一级，选好目录后点击“打开此目录为项目”。主机可对应多个项目。
5. “打开项目”的“项目位置”也可选择本机或其他已添加主机。模型默认采用本机连接；需要时展开“模型连接（本机）”修改连接或填写 Provider 映射。显式映射优先。
6. 项目打开后，顶部显示 SSH 主机与远程路径。聊天、文件预览、Git 检查与审批沿用原有操作。目录检查、Agent 文件读写和命令都在服务器执行。
7. 全局“新建会话”先选择项目：可搜索已有的本机/远程项目、按主机筛选，或通过“打开其他项目…”选择目录。选定后创建空白会话，不恢复该项目的最近会话；旧会话保留。尚未打开运行时也可使用此入口，取消不会创建会话或改变当前会话。
8. “新建会话 → 新建项目…”可选择本机或已保存的 SSH 主机，浏览父目录并输入项目名。应用创建一个新目录和空的 `agent.config.json` 项目标记，再打开新会话；不会覆盖已有目录，也不会自动初始化 Git。当前项目旁的“+”则直接在该项目中创建空白会话。

模型 ID 来自远程项目设置；项目未配置时采用本机默认模型。它必须在本机模型规格目录中有定义。远程只能选择当前已批准清单中的模型；增加模型或更改端点后重新打开远程项目。

主机列表单独保存在 Desktop 偏好中的 remoteHosts；项目记录通过 remoteHostId 关联主机。添加主机不要求项目目录或模型配置。旧版已添加的远程项目自动归属到对应主机，保留项目 ID 和最近会话。

项目设置、`/model`、`/mode` 和 `/think` 保存到远程项目；本机模型连接和凭据留在本机。高级设置仍遵守原来的原子写、CAS 和未知字段保留规则。

## 构建 Linux 离线服务包

首版目标为 Linux x64/glibc，运行时要求 Node.js 22.19.0+。Windows 的 node.exe 和原生模块不能直接作为 Linux 运行时。

在本机准备与目标平台匹配的官方 Node 二进制与该版本完整 LICENSE：

```text
desktop/remote-assets/linux-x64/
  node
  LICENSE
```

此目录被 Git 忽略。也可通过 `AGENTLAB_REMOTE_ASSETS` 指向另一个本机资产目录。应从可信 Node 发行包获取资产，并核对来源和校验和；构建器校验 ELF 架构、完整许可格式，远程安装时再次校验包 hash 和原生模块。

```powershell
pnpm desktop:remote:build
pnpm desktop:build
pnpm desktop
```

输出为 `desktop/dist/remote/linux-x64.tgz` 及其 `.json` 元数据。它包含独立 Node、worker bundle、三个 tree-sitter 原生依赖及其依赖闭包与许可。Desktop 构建不会删除该文件，后续打包应用时它会随 dist 进入应用。

首轮验收用的 Linux Node v22.23.3 与完整 LICENSE 从授权测试机复制到本机，再构建并通过 SSH 上传；这证明了完整离线包安装路径，不把测试资产当成已发布的通用官方安装包。

服务器部署到当前用户 HOME 下：

```text
~/.agentlab/remote/releases/<buildId>/
  node/bin/node
  worker/index.mjs
  node_modules/
  manifest.json
  .verified
```

包由本机 SFTP 上传，远程验证 SHA-256、归档路径、链接及 Node/native 模块后原子发布。启动使用具体不可变构建路径。相同版本直接复用；不在远程执行 npm install、curl 或编译依赖。

首次上传约数十 MiB，具体取决于 Node 与原生模块。当前界面显示部署阶段，尚未提供逐字节上传进度。用户可在连接中取消；已发布版本保留，未完成上传不会启动。

## 实现边界

- `desktop/main/ssh-host.ts`：系统 SSH/SFTP、部署、目标解析身份校验、双向 RPC、连接状态与取消。
- `desktop/main/broker-host.ts` / `desktop/remote/broker-worker.ts`：本机独立模型进程，凭据只经过本机 IPC。
- `desktop/remote/channel.ts`：64 KiB 物理帧、大消息重组、大小/队列限制、RPC 关联和断链拒绝。
- `desktop/remote/index.ts`：远程配置解析、初始化/激活、controller、项目锁、操作日志与租约。
- `src/providers/bridge.ts` / `src/builtin/provider-bridge.ts`：通过 manifest/setup 注册代理和授权模型目录。
- `src/providers/semantics.ts`：只暴露原 adapter 的同步转换方法，不调用 stream、不初始化 HTTP client，避免复制一套模型预算逻辑。
- `desktop/remote/snapshots.ts`：完整快照加有序字段/行增量；正文发送追加片段，慢链路合并未发送快照，避免排队完整历史。

core 不引入 SSH/Electron 分支。本地默认 preset 保持原装配；远程宿主使用同一共享 preset 组合，只替换 Provider 和模型目录。文件预览与 Git 检查仍经原有插件和唯一 ToolExecutor。

## 模型代理协议

本轮采用受控 pull 批次：BridgeProvider 发 `model.open`，随后请求 `model.next` 获取最多 64 个规范化事件或 trace；本地队列达到 512 KiB 后停止拉取 SDK。它承担原设计 credit 窗口的消费确认职责，减少协议状态。

取消通过独立 `model.cancel`，可以在 open 之前到达。每个 callId 仅能受理一次；完成后重放也会拒绝。调用、连接、路由句柄都有独立身份；连接失效撤销全部路由。本地 Broker 限制并发、预算和模型清单，不接受远程任意 URL/HTTP header。

`message_stop` 与迭代器结束分别检查；缺少模型结束事件时失败，不能执行残缺工具调用。usage、工具原参数来源、思考签名、缓存断点和调试 trace 沿原协议传输。诊断副本允许截断，执行事件不会静默丢弃。

模型调用串行使用同一路由的有状态 adapter。Anthropic 动态关闭缓存时，将有效状态与 revision 返回远程；过期请求明确报 ROUTE_STALE。错误不在 SSH 层重放；SDK 自身重试仍由本地 adapter 管理。

## 断线和恢复

正常停止会中止本机模型请求，并等待远程工具/会话结算。SSH 丢失时，本机撤销模型句柄，远程在 EOF 或租约过期后停止新执行并保存。界面显示“远程状态待确认”，不会声称外部副作用已经撤销。

远程项目锁以 PID 和进程启动身份判断 owner。锁获取/陈旧锁清理再用独占 guard 序列化，避免两个重连客户端同时抢占。guard 状态无法确定时保守返回 PROJECT_BUSY。该锁只协调本应用，不能阻止用户另外用 shell/CLI/编辑器操作同一目录。

submit 受理和终态写入远程操作日志；操作 ID 绑定会话，重复提交不会重新执行。同一进程的重复消息返回已知状态，崩溃后结果未知时拒绝自动重试。审批一次性消费，进程重启或连接变化后旧审批无效。

从项目列表重新打开项目恢复最后已保存会话；从“新建会话”选择项目始终创建空白会话。首版不恢复半条模型流，也不自动重新发送断线前的任务；没有常在线本机 Broker 时，远程不能继续新的模型推理。后台逃逸进程不保证因 SSH 关闭而退出。

## 验证与证据

```powershell
pnpm typecheck
pnpm test
pnpm desktop:remote:smoke -- ubuntu@10.100.0.8
pnpm desktop:remote:ui-smoke -- ubuntu@10.100.0.8
pnpm desktop:remote:ui-smoke -- ubuntu@10.100.0.8 --packaged
```

SSH smoke 在 `/tmp/agentlab-ssh-test-<UUID>/` 创建专用 HOME/项目。远程挂载测试插件，在 worker 内禁用 TCP connect/fetch；本机 mock 服务绑定 127.0.0.1。测试覆盖读取、写入、命令、规划/审批/压缩/子 Agent、项目锁、会话恢复、停止和强制断链、迟到审批拒绝，并扫描远程测试文件是否包含本机测试 key。

UI smoke 启动隔离 HOME/userData 的真实 Electron，先添加主机并验证项目数和模型请求数仍为零，再从该主机浏览/选择远程目录；随后通过 preload、main、独立 Broker、SSH 和远程工具完成读写与审批。还覆盖无运行时打开新会话选择器、跨项目空白会话、保留旧历史、项目旁“+”、取消选择、本地/远程新建目录以及按主机筛选。新建空会话不会发出模型请求。测试保留主机列表、目录选择以及宽/窄窗口截图。测试专用 `AGENTLAB_REMOTE_TEST_HOME` 只在测试进程中覆盖服务 HOME，用于隔离远程用户配置。

本机详细证据保存在被忽略的 `desktop/.validation/remote/`：

- `ssh-smoke.json`：SSH 各项断言与模型请求记录。
- `electron-smoke.json`：图形验收结果。
- `01-remote-form.png` 到 `04-remote-narrow.png`：真实应用截图。
- `05-new-session-projects.png` 到 `07-mixed-project-session-picker.png`：新会话选择项目与新建远程项目截图。
- `related-tests.json`：本轮相关测试结果。
- `new-session-related-tests.json` / `new-session-full-tests.json`：会话工作位置改动的相关/全量测试结果，与前轮报告比较无新增失败。
- `baseline-summary.json`：使用改动前默认 preset 的对照结果，不表示完整的历史提交基线。

当前 Windows 全量套件仍存在失败，包括符号链接权限、POSIX 文件模式、绝对路径 loader 与已有权限/展示断言；必须如实读取本轮报告，不能用 SSH smoke 通过替代全量通过。源码已有并行工作区改动，基线对照仅用于核对默认 preset 重构，不改写它们。

## 当前限制

首轮是单活跃顶层会话、Linux x64/glibc、已配置非交互 SSH。密码/MFA、远程守护进程无缝重挂接、多主机并发、PTY/LSP/完整编辑器以及完整发布签名/自动版本回收仍属于后续增强。

无秘密路由描述当前包含用于复用 adapter 同步语义的公开端点信息；它由本机生成，远程请求不能覆盖这个端点。实际认证与发送仍只在本机发生。

SSH 代理仅处理模型调用；远程包管理、Git 拉取和联网 MCP 的依赖须自行准备。参与推理的文件内容会经本机传给模型服务，调试正文也可能保留文件内容，分享报告前仍应检查。
