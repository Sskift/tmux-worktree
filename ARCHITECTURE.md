# tmux-worktree 架构

本文描述当前源码已经实现的边界。用户安装与开发命令见 `README.md`，Agent 的阅读顺序和变更门禁见 `AGENTS.md`。如果文档、contract、源码和测试冲突，先以当前可观察生产行为与版本化 contract 确认兼容承诺；源码和测试都是证据，不能仅凭某个内部结构测试反推架构。确认后在同一变更同步修正冲突项。

## 架构结论

仓库有三类可独立发布的产物：Node.js CLI、macOS Dashboard 和 Android APK。三端生产源码彼此分离，但共享协议和运行时约束：

- 根目录 `tw` CLI 是 managed worktree/session 的 headless control plane，也是 Relay broker/connector 和 Web terminal 的 Node.js runtime。
- macOS Dashboard 是 React UI + 模块化 Rust/Tauri 后端。它不维护第二套 managed session creator，而是通过同版本 `tw rpc` 执行创建、恢复和关闭。
- Android 是独立 Gradle 工程和原生 Kotlin/Compose 客户端。它通过 Relay v1 使用 Mac connector 暴露的能力，不链接 React、Rust 或 Node.js 生产代码。
- Relay v1 是当前唯一实现的移动协议。`docs/relay-v2-contract.md` 是未来契约，不代表任何一端已经支持 v2。
- 独立的本地 terminal-control v1 是 Dashboard、受控 CLI、Relay v1 和 Feishu Bridge 共同使用的 terminal input authority；Feishu 与 Relay 不共享 transport、鉴权、credential 或业务协议。

最重要的所有权规则是：`tmux` 保存活进程事实，`tw` 保存 managed lifecycle 事实，local terminal-control 保存 Feishu/interactive 两类 input ownership、共享 lease/fence 和 single-writer 顺序，Feishu Bridge 保存 binding/turn/reply 事实，Dashboard 保存桌面展示状态，Android 保存手机侧缓存与待发送状态。Dashboard、APK/Relay、受控 CLI 和 `tw serve` 属于同一个 interactive 类，彼此不争锁；只有 Feishu 会独占一个 terminal。展示层缓存不能决定一次写入或破坏性操作应走哪条权威路径。

## 顶层依赖方向与变更落点

仓库以“权威状态与写路径”组织代码，不以页面、需求阶段或发布版本复制垂直功能。稳定依赖方向如下：

```text
CLI command / RPC / Relay adapter ──> tw domain owner ──> git / tmux / state

React view ──> renderer model/hooks ──> DashboardBackend
                                      └─> Tauri adapter ──> tw RPC or native OS capability

Compose screen ──> V2ViewModel ──> repository / Relay actor ──> storage / codec / socket

cross-surface implementation ──> versioned RPC / wire / storage contract
```

维护代码时遵守以下落点规则：

1. 状态、写权限和生命周期判断落在已有 authority owner；UI、transport、IPC DTO 和 composition root 只能传递意图、适配数据或编排调用。
2. 上层依赖下层公开边界，下层不反向依赖具体页面或 transport。跨发布面不直接共享实现；需要互操作时先定义或沿用版本化 contract。
3. 新模块只在形成独立职责、状态或生命周期边界时成立。单调用 wrapper、为测试导出的内部函数、按任务阶段拆分的文件，以及与现有 owner 并行的 `new`/`v2`/`legacy` 实现都不是架构分层。
4. 一次替换应收敛到一条生产路径；除明确支持的兼容入口外，不保留双写、双读或“失败后试另一套实现”。兼容入口必须枚举触发条件并有删除标准。
5. composition root 可以装配大量能力，但不能成为业务 owner。文件变长不是复制 owner 的理由；应先把逻辑移动到正确的现有 feature/domain，再判断是否需要新边界。
6. 架构不由精确文件布局、export manifest、函数调用图或组件树定义。只要 authority、依赖方向、contract 和可观察行为不变，内部结构应可自由重构；测试不得冻结这些实现形状。

代码审查首先检查 owner、依赖方向、canonical 写路径和失败语义，再检查局部实现。测试策略与新增准入见 `AGENTS.md`；测试用于保护行为和契约，不作为增加抽象或保留重复实现的理由。

## 发布物与源码边界

| 发布物 | 生产源码 | 构建结果 | 运行时边界 |
|---|---|---|---|
| `tw` / `tmux-worktree` CLI | 根目录 `src/` | `dist/cli.cjs`；根包还生成供测试和 import 的 ESM 模块 | 需要 Node.js 20+、git 和 tmux；同时包含 `serve`、`relay-server`、`relay-host` |
| macOS Dashboard | `app/src/` + `app/src-tauri/` | `tw-dashboard.app`、DMG；根包的 `tw-dashboard-install` 安装 DMG | `.app` 内含同版本 `dist/cli.cjs`，但不含 Node.js runtime |
| Android App | `mobile/android/` | Debug APK 或 Release APK | 独立 Kotlin/Compose 应用；不打包 CLI、React 或 Rust |

`contracts/` 是跨实现的机器可读契约，不是第四个运行时产物。Android 的 Gradle test source set 会读取 `contracts/relay/v1` fixture；这些 fixture 不进入 APK 的生产资源。

## 代码地图

### 根目录 TypeScript：CLI 与 Relay runtime

| 路径 | 职责 |
|---|---|
| `src/cli.ts`, `src/commands.ts`, `src/dev.ts` | CLI 路由、交互命令和直接创建开发 session 的入口 |
| `src/session.ts`, `src/state.ts`, `src/rpc.ts` | single-pane managed session、`~/.tmux-worktree/state.json` 和 TW RPC v1 |
| `src/tmux.ts` | git/tmux 进程边界与底层查询 |
| `src/config.ts`, `src/hosts.ts` | 项目/Host 配置、兼容解析、SSH ControlMaster 和远端 RPC |
| `src/automation.ts` | Dashboard 共用的本地 automation 定义 |
| `src/serve.ts` | 带 token 的本地 HTTP/WebSocket 终端后端 |
| `src/relayHost.ts` | Mac admin connector；聚合 local 与显式配置的 SSH scope |
| `src/relayServer.ts`, `src/relay/broker/` | Relay v1 鉴权、Host/Client 路由和连接生命周期 |
| `src/relay/v1/` | Relay v1 wire model 与消息类型 |
| `src/relay/v2/` | 未接入 runtime 的 Relay v2 strict codec、Broker/Host carrier foundations、H0 事务状态库、H1 command-plane core、materialized-only H2 foundation 与 process-scoped H3 terminal core；尚无完整生产 adapter/composition wiring，不宣告 capability |
| `src/terminalControl/` | 本地 input ownership contract client/server、lease/fence authority、受控 backend write 与 output cursor |
| `src/feishuBridge*.ts`, `src/larkCliBridge.ts` | 独立 Feishu binding/event/turn/reply daemon 与 Lark adapter；不调用 Relay transport |

`tw rpc` 是给 Dashboard、Relay 和 headless agent 使用的机器接口。当前协议提供 capabilities、list、create-worktree、create-terminal、restore-worktree 和 kill-session；JSON shape 由 `contracts/tw-rpc/v1` 固化。

### macOS 前端：React Dashboard

`app/src/App.tsx` 是组合根，不直接调用 shell、tmux 或 SSH。所有外部能力先经过 `app/src/platform/DashboardBackend`：

```text
React view / hook / coordinator
          |
          v
DashboardBackend interface
          |
          +-- tauriBackend   -> production Tauri invoke/event
          +-- fakeBackend    -> unit tests
          `-- previewBackend -> browser/design preview
```

主要边界：

- `app/src/dashboard/`：Dashboard shell、sidebar、workspace、settings、hooks、布局和纯模型。
- `app/src/platform/`：领域类型、Backend facade、Tauri transport 和测试/预览实现。
- `Terminal.tsx`、`FileTree.tsx`、`FileEditor.tsx`、`GitStatusPanel.tsx` 等：功能视图；通过 Backend 获取数据。
- `NewWorktreeModal.tsx`、`NewTerminalModal.tsx`：收集用户输入，不拥有后端生命周期规则。
- `terminalPersistence.ts`：桌面 terminal metadata 的恢复与兼容规则，不是 tmux runtime registry。

React 持有选择、打开面板、草稿和轮询状态；它不持有 managed session 的权威状态。

Dashboard 已有一个通过 `DashboardBackend` 驱动的 Relay v2 enrollment/process 领域切片，用于区分 Relay v1 shared-secret profile 与 v2 host credential reference，并建模 host bootstrap/refresh、`host.registered`、六项基础 capability、一次性 enrollment、已知 client grant revoke、过期和 SUPERSEDED。浏览器 preview 使用明确标记的内存 fake；生产 Tauri adapter 在 Node issuer/credential 本地管理接口交付前只返回 unavailable，不经 renderer IPC 传递 bootstrap/access/refresh secret，也不宣告真实 capability 或生成生产二维码。因此当前生产 Relay runtime 仍然只有 v1。

### macOS 后端：模块化 Rust/Tauri

`app/src-tauri/src/lib.rs` 只是 composition root：注册模块、进程级 state 和 Tauri commands，并处理应用退出清理。业务实现分布在：

| 路径 | 职责 |
|---|---|
| `config/` | projects、hosts 和跨进程配置写锁 |
| `features/control_plane/` | bundled/installed TW 发现、local/remote RPC、capability 和 lifecycle 路由 |
| `features/sessions/` | local/remote catalog、tmux identity、activity 和 legacy discovery |
| `features/worktrees/` | worktree 创建/恢复委托、orphan 发现与清理 |
| `features/terminals/` | managed terminal 委托和 Dashboard terminal registry |
| `features/pty.rs` | 本地与 SSH tmux attach 的 PTY 生命周期 |
| `features/terminal_control.rs` | Dashboard PTY 到 canonical terminal-control 的受控 input/resize/lifecycle adapter |
| `features/feishu_bridge.rs` | Feishu product daemon 的按需启动、binding 管理和持锁 handoff adapter |
| `features/git/`, `features/files.rs` | local/remote git 与文件能力 |
| `features/layout.rs`, `features/automation.rs` | Dashboard 持久化和 automation 执行 |
| `features/mobile_relay/` | broker 安装、connector/serve 子进程、配置和状态 |
| `ipc/` | Tauri command DTO 和 TW RPC response model |
| `remote/` | SSH command transport 与 Host model |
| `support/` | 原子文件、环境、process 和 shell helper |

Rust 可以直接做 catalog 查询、PTY、git、files、布局和 orphan 清理；它不能在 canonical TW runtime 不可用时悄悄改用另一套 git/tmux creator 创建 managed session。

### Android：独立原生客户端

Android 入口是 `V2Activity.kt`，产品 UI 位于 `app/`、`feature/` 和 `designsystem/`，数据与连接能力位于 `core/`：

```text
Compose screens / navigation
           |
           v
       V2ViewModel
       /    |     \
      v     v      v
  Room repo DataStore RelayV1ConnectionActor
      |        |             |
  cache/outbox prefs       OkHttp WebSocket
           \
            Android Keystore credential store
```

- Room 是 Host、Scope、Session snapshot、Timeline、Outbox 和 stream checkpoint 的手机侧持久缓存。
- DataStore 保存非敏感 profile/preferences；Relay secret 由 Android Keystore 的 AES-GCM key 加密后保存。
- `RelayV1ConnectionActor` 用单线程、有界队列串行拥有 socket、request 和 terminal stream 状态。
- `TerminalWebView` 加载 APK 内置 xterm assets，不依赖 CDN。
- `MainActivity.java` 只是旧安装恢复 activity class 的跳转 shim；launcher 和产品逻辑都在 `V2Activity`。

Android 的 `V2` 指当前产品/UI 代际，不表示它已经实现 Relay v2。

仓库已有相互独立的 Node 与 Android Relay v2 codec，并共同消费 `contracts/relay/v2` 的 strict framing、closed schema、limit、dialect 和 normalized-result fixture。Node 侧还包含未接线的 Broker/Host carrier foundations、H0 host 事务状态库与 H1 command-plane core：H1 在 H0 事务上持久化 `(hostEpoch, principalId, hostId, commandId)` scoped ledger、dedupe window、durable accepted runner、结果/tombstone；`clientInstanceId` 只记录首次 route/attempt，不参与 ledger identity。四类固定 mutation 只通过注入的 `tw rpc` / terminal-control executor seam 执行；create/kill 的成功终态还要求注入 H2 resource mutation owner，在同一 H0 transaction 内签发/解析 opaque Session identity，并提交 Session mapping/revision/eventSeq 和 ledger。这些 foundations 尚未接入 `relay-server` / `relay-host` composition root，不生成 credential/enrollment，也不宣告 v2 capability。

H2 当前只交付 materialized foundation 的持久 record 与受限 mutation primitive：注入 discovery 后在 H0 内维护 aggregate/scope coverage、以 `(hostEpoch, scopeId, backendKind, backendInstanceKey)` 区分的 opaque scope/Session mapping、lineage used-ID marker、per-dimension revision 和全局 eventSeq；这些内部安全不变量不代表完整 rebuild/non-reuse runtime 已交付。已建立 authority 的 SSH scope 不可达时只更新 reachability，并保留 last-known complete Session cut。H1 create 通过窄 owner seam 在 canonical ledger transaction 内预留/消费容量，真实 backend incarnation 只能来自 executor outcome；welcome capture、subscriber register 与严格同步 event enqueue 共享 H0 serializer。完整 root 在原子替换前受同一 H0 serialized-byte hard budget 约束，capacity、持续 generation conflict 或 materialized authority 矛盾会在 H0 锁存 readiness fence，只有稳定且预算合格的同-lineage reconcile 才原子清除。普通 discovery absence 不会结算不确定 reservation，已有 backend positive evidence 的 reservation 也不会进入 negative candidate；只有可选的 canonical executor fenced-negative adapter 能在同一 cut 释放无 positive evidence 的 reservation，释放结论以 host-lineage negative tombstone 保留，迟到或未知 positive correlation 会 fail closed。该 foundation 不实现 pinned `state.snapshot` builder/spool、chunk/cursor/lease/quota/release，也未接入真实 discovery、executor negative-evidence、broker carrier、`relay-host` composition root 或 Android actor。因此 H1/H2 runtime 与 required capability 都未交付，不生成 credential/enrollment。

Android 还提供独立的 `RelayV2ConnectionActor` seam：它复用 v2 profile/credential 与 production codec，以串行 socket ownership、有界 action/effect queue、双代际 fence、握手 watchdog 和 hello query/resync/reject effect 固化客户端 runtime 边界。repository 消费代际 effect 时必须在 actor-owned apply lease 内完成整个持久化事务；公开 state 的 `matchesGeneration` 只用于非原子的代际预筛，不拥有 phase authority，也不能充当 profile-switch barrier。disconnect/profile switch 会先原子禁止旧代际取得新 lease，再等待已进入的旧事务完成，receipt 之后才允许清理旧 profile。该 actor 尚未接入 Android repository/composition root 或真实 OkHttp transport；真实 target resolver、canonical executor adapter、H2 runtime adapter、production carrier pump、enrollment 和 capability advertisement 也仍未交付。当前发布和运行数据流仍全部是 Relay v1。

Node 侧还包含只依赖注入接口的 process-scoped H3 terminal core：它独立拥有 v2 generation、raw-byte ring、connector/route/generation fence、credit、input/resize dedupe 和 control tombstone，不复用 Relay v1 stream map。sessionId 到 backend/control target 仍必须由未来 H2 canonical resolver adapter 提供；跨进程 open lineage/close intent/tombstone 必须由未来 H0 durable adapter 原子实现，其中 open 使用带 claim token/fence 的 claim→complete/fail CAS，durable outcome 只保留 resumeToken hash 等非敏感证据，明文 token 仅存在于进程内 stream/exact-replay record，backend generation 在 complete CAS 胜出前只保留为不可见 provisional record。`terminal.open`/resume/rebind 始终只是 observer，cols/rows 只作为 attachment-local 显示提示，首次 input/resize 才通过未来 terminal-control adapter 懒申请完整 owner/lease/fence single-writer 权限；connector/route/fence 改绑会先释放并清空旧 route 控制窗口，释放结果不确定时只允许 observer 输出并把控制保持为 IN_DOUBT。当前没有生产 composition root 实现 H3 所需的 H0/H2/terminal-control adapters；它也未接入 carrier 或 Android actor。因此这只是可隔离验证的 in-process core，不表示 H3 或 G0 已完成。

## 运行数据流

### Dashboard：本机

```text
React
  -> DashboardBackend
  -> Tauri command
  -> Rust feature
       |-- read/catalog/PTY/git/files -> local tmux/git/filesystem
       `-- managed create/restore/kill
             -> bundled same-version cli.cjs + Node.js
             -> tw rpc v1
             -> git worktree + tmux + managed state
```

本机 managed mutation 优先使用 `.app` 内 bundled CLI。只有 bundled runtime 不可用时，才允许使用版本与完整 RPC capability 都和 Dashboard 匹配的全局 `tw`。两者都不可用就明确失败；不会进入 direct Rust/tmux creator。

catalog 是发现视图：Rust 将 live tmux 状态、managed state 和严格的 worktree/terminal identity 组合后返回。读取可以容忍某一路暂时不可用，写入则遵守更严格的权威边界。

### Dashboard：SSH Host

```text
React -> Tauri/Rust -> SSH Host
                       |-- tw rpc list / capabilities
                       |-- tmux/git/files read paths
                       `-- tw rpc mutation -> remote tmux/git/state
```

- 已连接 Host 只来自本机 `~/.tmux-worktree.json` 的显式 `hosts`；`~/.ssh/config` 只提供添加候选。
- 远端 catalog 合并 `tw rpc list` 的 managed 条目和严格匹配的 legacy tmux/worktree 发现，按原始 tmux name 去重；RPC 条目优先。
- 远端 create-worktree、create-terminal 和 restore 必须经过兼容的远端 `tw rpc`；缺失或 capability 不兼容时要求安装/升级，不回退到 Rust 手写 SSH git/tmux mutation。managed kill 先走 RPC，只有下文“Managed lifecycle 与兼容层”第 4 项枚举的 legacy 信号才允许 direct tmux compatibility path。
- New worktree 对话框按所选 Host 扫描 orphan。远端扫描和删除只接受该 Host 配置的 `worktreeBase` 下 `project/worktree` 两级真实 Git worktree；删除由 Dashboard 的 SSH/Git adapter 执行，保留分支，并在用户明确强制删除时于提供 `/proc` 的 Linux Host 上终止 cwd 仍位于目标目录内的残留进程。远端 restore 仍委托目标主机的 `tw rpc restore-worktree`。
- Dashboard 可以把 `.app` 中的 CLI 复制到 Host 并安装 wrapper；远端仍需要 Node.js、git 和 tmux。
- PTY、文件和 git 读取按 Host 路由通过 SSH 执行，不经过 Relay broker。

远端 managed terminal 的 SSH tmux attachment 保持 read-only，Dashboard 输入统一经过目标主机的 terminal-control authority。xterm 产生的 mouse/focus transport report 不得作为 `input.raw` 粘入 pane；受控 attachment 的滚轮使用显式、受 fence 保护的 `input.scroll`，不伪装成 raw mouse report。authority 进入 `RECOVERY_REQUIRED` 时，Dashboard 只有在用户明确确认后才发送 host-aware `handoff.force`，接受上一次操作可能已生效并推进 fence，不重放不确定输入。

远端 UI identity 使用 `<hostId>:<rawTmuxName>`；实际远端命令始终使用 `rawTmuxName`，不能把展示用 composite key 直接传给 tmux。

### Android：Relay v1

```text
Android RelayV1ConnectionActor
          |
          | WSS /client + shared Relay secret
          v
relay-server (broker: auth + routing)
          |
          | WSS /host
          v
relay-host on the Mac admin machine
          |-- observation -> tw serve / local or SSH terminal stream
          `-- input       -> target terminal-control -> fenced backend write
```

Mac connector 是业务桥接点：它读取和 Dashboard 相同的项目、Host、terminal metadata 与 managed state，并用 Mac 的 SSH 权限聚合 local 和 remote scope。broker 只鉴权、维护 Host/Client/stream 路由和转发 frame；它不拥有 session、worktree 或 Android Outbox 状态。

Dashboard 的 Rust mobile-relay feature 负责保存 Relay center 与 connector 配置、启动或停止 `tw serve` / `tw relay-host`，也可把 bundled CLI 安装到用户明确选择的稳定 SSH 主机上启动 broker。选择写入 `mobileRelay.brokerHostId`，与开发 session 运行在哪个 Host 无关。Dashboard 托管的 broker 只监听远端 loopback；一键设置优先复用该 center 已保存的固定 WSS，否则通过远端已有的 `cloudflared` 建立临时 Quick Tunnel，读取并校验生成的根 `wss://` URL。启动 connector 前，Mac 先通过不进入系统负缓存的 DNS 查询等待公网记录出现，再确认本机系统解析器可用；Relay center 不需要解析自己的公网 URL。阻塞的 SSH 与 DNS 编排运行在 Tauri 后台任务中，不占用 UI 线程。它不会创建 Mac LAN forward、公开明文 broker 或合成 `.local` URL。connector 的 Node.js 实现仍位于根 `src/`。

broker、WSS ingress 与 connector 在后端仍是可诊断的独立生命周期，但 Dashboard 的 **Set up Relay** 会按顺序编排它们：取得可信 WSS、部署/重启远端 broker 并轮换 Relay v1 shared secret、原子保存配置，再启动 Mac connector。固定 WSS 和单独 Save/Start 仍作为高级运维与恢复入口；`Stop connector` 只管理 Mac connector 与其本地 loopback `tw serve`。Dashboard 的 `connected` 只证明 Mac connector 已连接 broker，不证明 Android 在线；broker 部署成功也只是一轮命令结果，不伪装成持续健康状态。

Relay v1 支持 Host/Scope/Session snapshot、创建、关闭、发送 agent message 以及 terminal input/output，但没有：

- Agent 入站历史或完整双向 Timeline；
- Waiting/Failed/Completed 等 Agent lifecycle event；
- 幂等 command ledger 与结果查询；
- 带 offset 的 terminal replay/resume；
- role-scoped credential 和 enrollment runtime。

因此 Android Session detail 的 Timeline 只把本机发起的消息及投递状态作为持久事实，不能伪造 Agent 回复或从终端输出推断 Agent lifecycle。Relay v1 shared secret 和终端内容只受 TLS 保护，生产 Android 配对必须使用可信 `wss://`。同一把 v1 secret 也不能为无关用户提供租户隔离；面向多用户的统一 Relay center 必须等待独立的 Relay v2 role-scoped credential 与 enrollment 实现。

### 共享 terminal input 与 Feishu Bridge

Dashboard、受控 `tw attach`、`tw serve`、Relay v1 和 Feishu Bridge 的产品级真实写路径都映射到同一个 `controlTargetId`，并由目标主机上的 terminal-control authority 在一次 critical section 内完成 lease/fence 校验和 backend write。Relay terminal stream、Android 重连和 Feishu awaiting turn 都不是 input lease；observer 可以继续读 output，但不能据此取得或恢复写权。Dashboard、APK/Relay、受控 CLI 和 `tw serve` 在首个真实 input 时加入同一个 interactive lease/fence，多个实例可并行连接并由 single writer 串行提交 operation；某个 attachment release 只丢弃自己的本地 lease，不 fence 其他 interactive writer，最后一个登记的 producer 正常 release 时回到 `FREE`。只有 Feishu acquire/handoff 会把 interactive 端变为只读。异常退出后无人续租的 interactive lease 仍会在 exact target 复核和 output capture 换代后安全回到 `FREE`，Feishu 与不确定副作用继续 fail closed。

Feishu Bridge 是独立本地 daemon，拥有群 binding、群成员精确 @Bot 触发策略、event dedup、单轮 marker/output cursor 和幂等回帖。Dashboard 的正常绑定不要求管理员 Open ID：同一群内任意真实用户均可 @Bot 发起一轮，Bot/self、非用户事件和未 @Bot 的普通消息不会注入 session。Dashboard 可以按需启动和管理它，但退出 Dashboard 不得停止共享 Bridge/controller 或隐式释放 active Feishu ownership；它只丢弃自己的 interactive lease view。Feishu 占用时 Dashboard 的本地 takeover/pause 操作负责 drain 或取消当前 turn，再原子切回 interactive 类。Settings 只持久化非敏感的 `lark-cli` profile 名称，bot credential 继续由 `lark-cli` 拥有；更换 profile 只允许在没有任何 binding/turn 的空 Bridge 上执行。完整状态机、handoff commit point、Relay v1/v2 拒绝规则和 privileged raw-tmux bypass 见 [`docs/terminal-input-ownership-alignment.md`](docs/terminal-input-ownership-alignment.md)。

## 状态所有权

### Mac / CLI / remote Host

| 状态 | 权威 owner | 允许的主要写入者 | 说明 |
|---|---|---|---|
| live tmux sessions/panes | 各目标主机的 tmux server | `tw`；明确的 legacy compatibility path | 表示进程是否真实存在，不表示是否 TW-managed |
| git repositories/worktrees | 各目标主机的 git | `tw` managed create；Dashboard orphan cleanup | 工作区内容和 dirty 状态由 git 决定 |
| `~/.tmux-worktree/state.json` | 目标主机上的 `tw` | `tw` session/RPC lifecycle | managed worktree/terminal registry；mutation 使用跨进程锁和原子替换，损坏或未知 schema 时 fail closed |
| `~/.tmux-worktree.json` | 用户配置 | CLI 和 Dashboard | projects、hosts、worktree base、mobile relay，以及非敏感的 `feishuBridge.larkProfile`；跨进程写入必须持锁并保留未知字段，Lark credential 不写入这里 |
| `~/.tw-dashboard-terminals.json` | Dashboard metadata | Dashboard Rust 与 relay-host | label、order、cwd、host/raw name、managed marker；不是 tmux 或 managed state 的替代品 |
| `~/.tw-dashboard-layout.json` | Dashboard | Dashboard Rust | canonical schema、revision/CAS、窗口与工作区展示状态 |
| `~/.tw-dashboard-automations.json` | Dashboard/CLI 共用定义 | Dashboard Rust 与 `tw automation` | 本机 automation 定义；调度器随 Dashboard 进程运行 |
| `~/.tw-dashboard-automation-runs.json` | Dashboard | Dashboard Rust | 本地、有界的运行历史 |
| `~/.tw-dashboard-pending-worktree-cleanup.json` | Dashboard | Dashboard Rust | session 关闭后尚未完成的本机 worktree 清理队列 |
| `~/.tw-serve-token` | `tw serve` | `tw serve` | 本地 Web terminal bearer token |
| `~/.tmux-worktree/mobile-relay-status.json` | connector runtime | 当前 relay-host instance | 可丢弃的连接状态，不是配置或 session 权威 |
| `~/.tmux-worktree/terminal-control-state-v1.json` | local terminal-control | terminal-control daemon | exact target、control epoch、Feishu/interactive ownership、共享 lease/fence、handoff 与 operation disposition；严格 schema、锁和 0600 原子写 |
| `~/.tmux-worktree/terminal-control-output-v1/` | local terminal-control | terminal-control daemon | 有界、generation-fenced 的只读 output capture；不授予 input ownership |
| `~/.tmux-worktree/feishu-*.json` | Feishu Bridge | Feishu bridge daemon | 私有 binding、event dedup、turn 和 outbound reply disposition；不是 lease authority |

`profile=cli|dashboard` 只是 managed record 的来源标记，不选择不同的 tmux 布局。新 managed worktree 和 terminal 都是 single-pane contract：可选的 AI command 在唯一 pane 中运行，退出后回到 login shell；terminal 省略命令时直接进入 login shell。

### Android

| 状态 | Owner | 说明 |
|---|---|---|
| `tw_mobile_v2.db` | Android repository/Room | 当前 pairing 下的 Host、Scope、Session cache、Timeline、Outbox 和 checkpoint；profile 切换时按 barrier 清空 |
| `tw_mobile_v2_preferences` | Android DataStore | Relay URL、首选 Host/Scope、自动连接和通知偏好；不保存明文 secret |
| Android Keystore + secure preferences | credential store | Keystore 保存不可导出的 key，SharedPreferences 只保存 AES-GCM IV/ciphertext |
| actor 内存状态 | `RelayV1ConnectionActor` | socket epoch、pending request、stream generation 和重连状态；不能被 Compose 组件直接修改 |

Android cache 不是远端权威。离线时可以继续展示 stale snapshot 和 Outbox，但不能把本地缺失解释为远端资源已删除。

## Managed lifecycle 与兼容层

新代码必须维持以下边界：

1. **Canonical-first mutation。** create/restore/kill 先走目标主机的 TW RPC。UI 传来的 `managed` 是缓存提示，不能覆盖真实 managed state。
2. **写入 fail closed。** state、terminal registry、layout 或 config 无法安全解析时，不得用空对象覆盖原文件。共享文件写入使用相应跨进程锁与原子替换。
3. **兼容发现不等于兼容创建。** catalog 可以发现符合严格路径、git 和 tmux shape 的旧 session；远端 mutation 不能因此退回旧 creator。
4. **Legacy kill 范围有限。** canonical kill 只有明确返回“不是 TW-managed”、旧 RPC 不支持或远端没有 `tw` 等兼容信号时，才允许 direct tmux kill；state corruption、timeout 和普通执行错误不能授权 fallback。
5. **Terminal metadata 不复活 managed runtime。** 带 `managed=true` 的持久 terminal 只检查 live 状态；已消失就移除 metadata。缺少 marker 的旧记录才可以使用 `ensure_terminal_session` direct-tmux 恢复路径。
6. **配置格式继续兼容。** projects 接受历史对象/数组和 `projects`/`repositories`/`repos`，路径、分支和 worktree base 也保留已支持的字段别名；新写入不得无故清除未知字段。
7. **历史 worktree 只用于发现。** 默认新根目录是 `~/.tmux-worktree/worktrees`；`/private/tmp/tmux-worktree/projects` 仅作为 legacy discovery 边界。
8. **Android 升级 shim 有明确范围。** `MainActivity` 只重定向到 `V2Activity`；`LegacyIdentityImporter` 迁移旧明文 identity 到 DataStore/Keystore 后清理 secret。APK 内 xterm/WebView 是当前生产实现，不是迁移层。
9. **Relay v1 兼容保持局部。** Android 只在旧响应完全省略 `requestId` 时，按当前 request registry 做受限关联；未知非空 ID 必须视为迟到响应。Relay v2 必须另建 actor/codec/persistence，不能把 v2 语义散落进 v1 实现。
10. **Terminal input fail closed。** 所有受支持 writer 必须通过 target-scoped terminal-control；authority 不可用、lease/fence 不匹配、handoff pending 或 continuity 不明时不得回退 direct tmux/PTY write。Relay v1 wire 保持冻结，只用现有 error 拒绝；Feishu transport 与 Relay credential 永远分离。

兼容层的删除条件必须同时包含：不再支持对应升级来源、迁移遥测或明确版本策略证明安全，以及相关 contract/test 已同步更新。不能仅因当前开发机没有旧数据就删除。

## 构建与发布边界

### 根 CLI

根 `npm run build` 运行两套 tsup 配置：一套生成可被测试/import 的 ESM 模块，另一套把 `src/cli.ts` 及依赖打成唯一 standalone Node entry `dist/cli.cjs`。不要把 `dist/*.js` 当作可复制的 CLI。

根 npm package 发布 `dist/`、Dashboard installer 和准备好的 DMG 目录；它不构建 Android。

### macOS Dashboard

Tauri `beforeBuildCommand` 先构建 React，再构建根 CLI；`tauri.conf.json` 把 `dist/cli.cjs` 放入 `.app/Contents/Resources/tw-cli/cli.cjs`。这形成源码级分层、产物级组合：Dashboard 自己不实现 managed creator，但随包携带精确版本的 control plane。

`app/scripts/release.sh` 当前负责 macOS bundle/DMG 构建、签名完整性校验和把 DMG 复制到 installer 目录；上传、notarization 和发布渠道在脚本外处理。脚本不发布 APK，也不把 Node.js 嵌入 `.app`。

### Android

Android 使用自己的 Gradle wrapper、依赖图、测试和 Lint。根 npm build、Tauri build 和 macOS release script 都不会编译它。当前 Gradle 工程没有 production signing config，因此源码中的 `assembleRelease` 只产生未签名构建验证产物；可分发 APK 的签名和发布必须由外部 release 流程显式完成。

一次统一版本发布需要同步根 `package.json`、`app/package.json`、Tauri config、Rust package 和 Android `versionName`/`versionCode`，并分别验证 CLI、Dashboard/Rust 和 Android。不要用硬编码的测试数量判断完成；执行各工程当前定义的完整门禁。

## Contract 与文档分类

| 位置 | 类型 | 维护规则 |
|---|---|---|
| `README.md` | 用户与开发入口 | 安装、Quick Start、配置、构建和 release 命令；不承载深层实现细节 |
| `AGENTS.md` | Agent 入口 | 阅读顺序、架构红线、变更到验证的矩阵和交付规则 |
| `ARCHITECTURE.md` | 当前实现 | 代码地图、数据流、状态 owner、兼容与发布边界；只能描述已经落地的事实 |
| `docs/android-v2-architecture.md` | 当前 Android 专题 | Compose/Room/actor/Outbox 的详细产品和实现约束 |
| `docs/remote-relay-android.md` | 运维手册 | broker、Mac connector、TLS、配对和 Android 验证流程 |
| `docs/terminal-input-ownership-alignment.md` | 跨产品实现 companion | terminal-control、Feishu、Dashboard、CLI 与 Relay 的 lease、handoff、拒绝行为和测试矩阵 |
| `docs/relay-v2-contract.md` | 冻结契约 | codec conformance、H0 state seam 和独立 H3 terminal core 已落地；H0/H2/terminal-control adapter、runtime/capability 均未接线，不能据此声称 H3 完成、宣告 capability 或生成 v2 credential |
| `docs/relay-v2-implementation-plan.md` | 非规范性实施协调 | 按 owner 拆分可并行工作、硬依赖和验收 Gate；不描述当前完成状态，也不修改冻结契约 |
| `contracts/` | 机器契约 | Relay v1/v2、TW RPC v1 和共享 storage fixture；协议/存储变更必须同步生产实现和 contract tests |
| `.codex/skills/` | Agent 操作规程 | 固化跨机器等易误操作流程，不属于产品 runtime |

历史重构计划、一次性 QA 记录、临时截图路径和已经完成的迁移清单不应伪装成当前架构基线；需要追溯时使用 Git 历史。新增文档前先判断它属于用户手册、当前架构、专题运维、未来 contract 还是 Agent 规程，避免复制同一事实到多个位置。
