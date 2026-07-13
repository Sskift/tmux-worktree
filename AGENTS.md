# Agent 入口与仓库约束

本文件是零上下文 Agent 进入仓库后的第一读物，描述当前实现状态、代码所有权和不可破坏的兼容边界。执行任务时，先读本文件，再按下方顺序阅读与任务相关的文档和测试；不要从类名、设计稿、分支名或构建产物猜测产品状态。

## 当前事实

- 仓库交付三个独立发布面：根目录 Node.js `tw` CLI、macOS React + Tauri Dashboard、原生 Kotlin + Compose Android APK。三者源码和构建产物分离，但 Dashboard 与 Android 都依赖 `tw`/Relay 的协议与运行时能力。
- `tw` 是 managed worktree、managed terminal、SSH Host 和自动化的 headless control plane。Dashboard 是展示与原生能力层，不应拥有第二套 worktree/tmux 生命周期实现。
- 当前 Dashboard、`relay-server`、`relay-host` 和 Android **只实现 Relay v1**。Relay v1 使用共享 secret；broker 负责鉴权和路由，Mac 上的 `relay-host` 负责聚合、执行和终端桥接，底层 managed/live 状态仍分别由目标主机的 `tw` 与 tmux 持有。
- Android 的 `V2Activity`、`V2ViewModel` 和“Android V2”表示新版产品/UI 架构，**不表示 Relay v2 已实现**。当前 Android 仍使用 `RelayV1ConnectionActor` 和 v1 codec。
- `docs/relay-v2-contract.md` 是冻结的未来 v2 最小互操作契约，实现尚未交付。任何一端都不得因为该文档存在就宣告 v2 capability、生成 v2 enrollment、把 v1 shared secret 提升为 v2 credential，或在失败时静默降级/重试到另一协议。
- Relay v1 没有 Agent 入站时间线、Waiting/Failed/Completed 状态或通知事件。Android Session detail 当前只能可靠展示本机发出的消息及投递状态；不得用本地推断伪造远端 Agent 回复或状态。
- 构建成功不等于完成生产发布：Tauri 构建、Android unsigned Release 验证、签名、TLS、上传和渠道发布是不同步骤。

当前运行关系：

```text
macOS Dashboard (React)
  -> DashboardBackend
  -> Tauri/Rust: PTY, files, Git, SSH, persistence
  -> bundled same-version tw CLI: canonical local/remote lifecycle RPC

Android (Compose)
  -> V2ViewModel -> Room / DataStore / Keystore
  -> Relay v1 actor -> relay-server -> Mac relay-host
  -> local tw serve or Mac SSH -> remote tw/tmux
```

## 阅读顺序

1. `README.md`：用户可见能力、安装、配置、开发和发布入口。
2. `ARCHITECTURE.md`：当前代码地图、managed session contract、运行时状态和发布边界。
3. 按任务选择：
   - CLI、Dashboard 或 SSH 使用流程：`MANUAL.md`。
   - 当前 Relay v1 部署、Dashboard 配对和 Android 接入：`docs/remote-relay-android.md`。
   - Android 产品信息架构、持久层、连接状态机、Outbox 和迁移层：`docs/android-v2-architecture.md`。
   - 未来 Relay v2 实现：完整阅读 `docs/relay-v2-contract.md`；它只规范 v2，不描述当前已交付能力。
4. 修改 wire/storage/RPC 前，先读对应 `contracts/**/manifest.json`、fixture 和消费它们的测试。
5. 最后读目标模块源码及相邻测试。测试既是回归保护，也是兼容行为的可执行说明。

若文档、契约、测试和代码互相矛盾，不要任选一个方便的解释。先确认当前可观察行为与兼容承诺，再在同一变更中收敛代码、测试和文档。不要保留会被误当作当前事实的实施计划、临时截图路径、测试数量或分支/commit 状态。

## 目录与职责

| 路径 | 所有权与职责 |
| --- | --- |
| `src/` | Node.js/TypeScript `tw` CLI：配置、managed state、git worktree/tmux 生命周期、JSON RPC、SSH Hosts、automations、`tw serve`、Relay v1 broker/host。 |
| `test/` | 根 CLI、RPC、storage、Relay、安全和兼容行为测试。根测试必须通过 `npm run test:cli` 串行运行。 |
| `contracts/tw-rpc/v1/` | Dashboard/CLI 共用的冻结 RPC v1 行协议与 fixture。 |
| `contracts/relay/v1/` | Node 与 Android 共用的 active-but-legacy-frozen Relay v1 wire fixture。 |
| `contracts/storage/` | host config、managed state、Dashboard terminal registry 的冻结磁盘契约。 |
| `app/src/` | React renderer、Dashboard 状态/交互模型及 `DashboardBackend` 抽象；不得直接承担 OS、tmux、SSH 或凭证操作。 |
| `app/tests/` | renderer、平台边界、持久化、安全、无障碍及结构回归测试。 |
| `app/src-tauri/` | Rust 原生适配层：Tauri IPC、PTY、Git/files、SSH、配置、catalog、持久化、Mobile Relay 进程编排，以及 bundled `tw` RPC 调用。 |
| `app/scripts/`、`app/installer/` | 隔离开发、Dashboard/DMG 构建和安装器；不是业务逻辑来源。 |
| `mobile/android/` | 独立 Android 生产代码与 Gradle 工程：Compose、Room、DataStore、Keystore、OkHttp Relay v1 actor、内置 xterm WebView 和 Android 测试。 |
| `scripts/` | 仓库级文档检查和统一验证入口。 |
| `.codex/skills/` | Agent 操作规程；不是应用运行时或用户状态。 |

`dist/`、`node_modules/`、Gradle `build/`、Rust `target/` 和生成的 DMG/APK 都不是源码事实。不要手改生成物，也不要为了“让 diff 干净”删除他人的本地构建或工作树内容。

## 不可破坏的架构约束

### Managed 生命周期与存储

- `src/session.ts` / `src/state.ts` 是唯一 canonical managed lifecycle 实现。交互式 `tw <ai-command> ...` 可以直接调用这套实现；Dashboard、Relay、headless Agent 和跨主机调用以目标主机的 `tw rpc` 为 canonical 入口。Dashboard 本地优先调用 `.app` 内 bundled 的同版本 CLI，远端通过 SSH 调用远端 `tw`；只有下述枚举的 legacy kill 信号允许离开 RPC 路径。
- 不得在 Rust、React、Android 或 Relay broker 中再实现一套 `git worktree` + direct tmux creator。旧 CLI/metadata 的兼容发现、attach 或经过严格判定的 fallback 不能被扩张成新路径。
- 新 session 遵循 managed single-pane contract：AI 命令在唯一 pane 中运行，结束后回到 login shell，并登记到 `~/.tmux-worktree/state.json`。不要恢复 status pane、额外 shell pane或 alternate-screen status TUI。
- `~/.tmux-worktree/state.json` 是 managed runtime state，不是可随意修补的缓存。写入必须使用锁、原子替换和 0600 权限；损坏 JSON、未知 schema 或不明 ownership 必须 fail closed，不能覆盖“修复”。
- Storage/RPC v1 contract 已冻结。保留已承诺的字段别名、未知扩展字段和 legacy discovery；需要破坏性语义时新增显式版本，而不是悄悄改写 v1 fixture。
- Host 选择属于调用/transport 层，不塞进已有 RPC v1 JSON。create/restore 遇到远端缺少或不兼容 RPC 时必须明确要求升级，不能回退到手写 SSH/git/tmux mutation。managed kill 只有在明确得到“不是 TW-managed”、旧 RPC 不支持或远端没有 `tw` 这三类 legacy 信号时才允许 direct tmux compatibility path；corrupt state、timeout、认证/transport 和普通执行错误必须 fail closed。

### Dashboard 边界

- React 业务代码只通过 `app/src/platform/dashboardBackend.ts` 暴露的 `DashboardBackend` 使用原生能力。只有 `app/src/platform/tauriBackend.ts` 可以导入 `@tauri-apps/*`。
- 修改 `DashboardBackend` 时同步更新 Tauri、fake/preview backend、domain types 和平台边界测试；不要让组件按运行环境分支调用原生 API。
- Tauri/Rust 是 adapter 和 orchestration 层。managed lifecycle 仍委托 `tw rpc`；PTY、文件、Git、SSH transport、窗口和本地 UI persistence 才属于 Rust/Dashboard。
- Dashboard 只连接 `~/.tmux-worktree.json` 明确配置的 Hosts。SSH config discovery 是 Add host 候选来源，不代表自动信任或自动连接。
- CLI 的 `profile=cli|dashboard` 只记录来源，不选择不同 tmux 布局。CLI 不复制 Dashboard 的 Editor、Files、Git graph、theme、layout 或 selection 状态。

### Relay 边界

- Relay v1 broker 是薄路由，但因 shared secret 和 TLS 内明文业务转发仍属于受信任 transport。不要把业务 authority、SSH 凭证、session 推断或 tmux mutation移入 broker。
- Mac `relay-host` 聚合本地与配置的 SSH scopes，只暴露 TW-managed session 和严格识别的 legacy worktree/managed terminal；普通 tmux session 默认不可见。
- Relay v1 shared secret 是敏感凭证：不得写入日志、异常、测试快照、网络 HTTP/WebSocket URL、仓库或无权限保护的持久层。当前桌面端只允许原子写入 0600 的 `~/.tmux-worktree.json` `mobileRelay.secret` 和 broker 的 0600 `~/.tmux-worktree/relay-secret`；Android 只能保存 Keystore 保护的密文。唯一的 URI query 例外是用户明确触发、仅供受信设备消费的 `tmuxworktree://pair?...` v1 QR payload；adb pairing 同样必须走可复核且不自动连接的受信设备流程。
- 生产 Android 只接受 `wss://`。debug cleartext 仅限已有的 emulator/loopback 例外；不要放宽为局域网通用 `ws://`。
- Relay v1 wire contract 是 legacy-frozen 但仍是当前生产协议。保持旧端所需的 requestId 兼容与 stream 归属语义；跨 Node/Android 改动必须同时更新 fixture 和两端测试。
- 实现 Relay v2 时，按冻结契约建立独立 actor、codec、repository、profile 和 credential namespace；不要把 v2 条件分支散落进 v1 actor，也不要把旧 profile、session name、Outbox 或 stream identity 原地“升级”。

### Android 边界与兼容层

- Compose UI 不直接访问 WebSocket、Room、DataStore 或 credential storage；状态与副作用通过 `V2ViewModel`/repository/actor 流动。Relay 可变状态只由串行 actor 持有。
- Room 是 session cache、时间线和 Outbox 的持久事实来源；DataStore 只保存非敏感偏好；Relay token 只保存为 Android Keystore 保护的密文。token 不得进入 Room、Intent 持久状态、日志或 crash report。
- QR、adb/Intent pairing 只能预填 review 页面。用户必须明确确认 Relay URL；外部输入不得自动连接、覆盖现有 profile，敏感 Intent extras 读取后必须清除。
- Profile 切换/重配对必须先完成旧 Relay actor 的 disconnect barrier，再清理旧 profile 的缓存、Outbox、草稿、terminal queue 和 credential，避免旧回调污染新身份。
- Outbox 的 v1 `AMBIGUOUS` 表示副作用可能已发生，不能自动重发或让同 session 后续消息越过。不得因 UI 方便把不确定状态改成 retryable。
- 下列内容当前必须保留，不能当作“旧代码清理”：
  - `MainActivity`：non-exported Activity 恢复兼容 shim，跳转到 `V2Activity`。
  - `LegacyIdentityImporter`：把旧 `identity` SharedPreferences 中的 profile 迁移到 DataStore/Keystore，并删除明文 secret。
  - `RelayV1ConnectionActor`、v1 codec 与 `contracts/relay/v1`：当前实际 wire runtime。
  - `TerminalWebView`、`androidx.webkit` 和 APK 内 xterm assets：Compose 终端的当前生产实现，不是迁移遗留。
- 只有支持的升级窗口结束、真实升级设备验证完成且产品明确停止 1.x 直升后，才能删除前两个 migration shim；删除必须连同针对升级路径的证据和文档一起评审。

## 变更到验证矩阵

先运行最小相关检查，交付前运行覆盖所有受影响层的统一 gate。不要用硬编码测试数量判断完成，也不要绕开根 CLI 的串行测试脚本。

| 变更范围 | 最小检查 | 交付 gate |
| --- | --- | --- |
| 仅 Markdown/链接 | `sh scripts/verify.sh docs` | 同左，并人工核对描述是否为当前事实 |
| 根 CLI、config、state、RPC、Hosts、automations | `npm run build && npm run test:cli` | `npm run verify` |
| Relay v1 Node/broker/host/serve | `npm run build && npm run test:cli` | `npm run verify:all`；涉及真实连接再做隔离的端到端验证 |
| Dashboard React/model/platform interface | `(cd app && npm run build && npm run test:typecheck && npm test)` | `npm run verify` |
| Tauri/Rust/IPC/PTY/SSH/storage | `(cd app/src-tauri && cargo fmt --check && cargo check && cargo test)` | `npm run verify`；IPC shape 变化还要跑 Dashboard 全测试 |
| Android Kotlin/Room/Relay/UI | `npm run verify:android` | `npm run verify:all`；需要设备行为时运行 `npm run verify:device` |
| `contracts/relay/v1` 或跨 Node/Android wire 行为 | 两端相关 contract/codec 测试 | `npm run verify:all`，必要时 `npm run verify:device` |
| `contracts/tw-rpc`、storage contract 或跨 CLI/Rust 行为 | 根 contract 测试 + Rust 测试 | `npm run verify:all` |
| 版本、bundle、签名或发布路径 | 所有受影响构建与 contract 检查 | `npm run verify:device`，再执行下面的发布检查清单 |

统一入口：

- `npm run verify`：CLI + Dashboard + Rust + docs。
- `npm run verify:android`：Android JVM、Lint、Debug/Release 构建 + docs。
- `npm run verify:all`：CLI + Dashboard + Rust + Android + docs，不含连接设备测试。
- `npm run verify:device`：完整 gate，并要求可用的 emulator/device 执行 connected Android tests。

失败检查不能用“与本次修改无关”直接忽略。先确认是否为既有失败；若无法在不扩大任务范围的情况下修复，交付时给出复现命令、失败位置和影响。

## 工作树与安全规则

- 开始和交付前运行 `git status --short --branch`。工作树可能包含用户或其他 Agent 的改动；只修改任务范围内文件，不 reset、checkout、clean、stash、覆盖或顺手格式化无关改动。
- 不假设当前分支、默认分支或 remote。提交前检查 scoped diff；commit、push、merge、tag、发布和外部上传都只在任务明确授权时执行。永不 force-push，永不改写现有 release tag。
- 不手改或删除用户的 `~/.tmux-worktree*.json`、Dashboard 状态、tmux session、git worktree、SSH config 或凭证。自动化测试必须使用临时 `HOME`/目录、fake transport 和隔离端口；真实运行时 mutation 需要任务明确授权。
- 不打印或提交 Relay secret、`TW_TOKEN`、SSH key、Keystore 内容、签名材料或完整环境变量。日志和错误只保留诊断所需的非敏感标识。
- 依赖变更要更新对应受跟踪 lockfile。不要提交 `dist/`、`target/`、Gradle build、APK、DMG、临时截图或机器本地配置，除非发布流程明确把某个资产列为受跟踪输入。
- wire、磁盘或 IPC schema 改动必须先定义兼容策略，再改生产代码。读取应兼容已承诺旧数据；写入应原子、安全并尽量保留未知字段。
- 修复安全或生命周期问题时，不要用宽泛 fallback 吞掉 corrupt state、capability mismatch、auth failure 或 unknown ownership。只有明确枚举且有测试的 legacy signal 可以进入兼容路径。

## 发布规则

- CLI、macOS Dashboard/DMG 和 Android APK 是不同发布物。不要因为其中一个构建通过，就宣告另外两个已发布或兼容。
- 发布前把版本一致更新到根 npm package、Dashboard npm package/lockfile、Tauri config、Rust package/lockfile和 Android `versionName`；Android `versionCode` 还必须满足渠道单调递增要求。不要复用已有 tag 发布不同代码。
- Dashboard build 必须把根 `dist/cli.cjs` 作为 `tw-cli/cli.cjs` resource 打入 `.app`，并保持 bundled CLI 的版本/capability 校验。bundle 不包含 Node runtime，不能把“本机恰好能运行”当作目标机器验证。
- `app/scripts/release.sh --dry-run`/`app/scripts/release.sh` 负责 arm64 Dashboard build、bundle/signature 验证和 DMG 复制；它不代表上传、notarization 或渠道发布已经完成。使用正式签名身份前先确认授权和证书环境。
- Android `assembleRelease` 当前只产生 unsigned build-verification artifact。正式 APK/AAB 的 keystore、签名、升级路径和渠道上传必须走独立、获授权的发布流程；debug-signed APK 只能用于设备测试。
- 生产 Relay 发布必须有受信 TLS/WSS、真实设备升级/配对/重连验证和 secret 处理检查。不得把本地 SSH forward、loopback `ws://` 或模拟器 Debug 结果描述为生产基础设施。
- 发布前保存实际执行的命令和结果摘要，但不要把会漂移的测试数量、当前 commit/branch 状态或本机绝对路径写进长期文档。

## 完成定义

一次变更只有在以下条件同时满足时才算完成：实现位于正确的所有权层；兼容和安全红线未被绕开；相关 contract、测试和文档同步；适用 gate 通过；diff 不包含无关或生成内容；交付说明明确区分已验证事实、未运行的设备/发布步骤以及任何剩余风险。
