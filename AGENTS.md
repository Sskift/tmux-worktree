# Agent 入口与仓库约束

本文件是零上下文 Agent 进入仓库后的第一读物，描述当前实现状态、代码所有权和不可破坏的兼容边界。执行任务时，先读本文件，再按下方顺序阅读与任务相关的文档和测试；不要从类名、设计稿、分支名或构建产物猜测产品状态。

## 当前事实

- 仓库交付三个独立发布面：根目录 Node.js `tw` CLI、macOS React + Tauri Dashboard、原生 Kotlin + Compose Android APK。三者源码和构建产物分离，但 Dashboard 与 Android 都依赖 `tw`/Relay 的协议与运行时能力。
- `tw` 是 managed worktree、managed terminal、SSH Host 和自动化的 headless control plane。Dashboard 是展示与原生能力层，不应拥有第二套 worktree/tmux 生命周期实现。
- 当前 Dashboard、`relay-server` 和 `relay-host` **只实现 Relay v1**。Relay v1 使用共享 secret；broker 负责鉴权和路由，Mac 上的 `relay-host` 负责聚合、执行和终端桥接，底层 managed/live 状态仍分别由目标主机的 `tw` 与 tmux 持有。Android 另有严格受限的 Relay v2 base-sync production root，但这不改变 server/host 没有 production v2 readiness/capability 的事实。
- Android 的 `V2Activity`、`V2ViewModel` 和“Android V2”表示新版产品/UI 架构，**不表示完整 Relay v2 已实现**。没有显式 v2 profile 时 Android 仍使用 `RelayV1ConnectionActor` 和 v1 codec；只有已存在且 cold-start credential/admission 验证成功的显式 v2 profile 才进入独立 actor、bounded WSS 与 Room 基础 state-sync，连接状态不等于 ready/capability。
- `docs/relay-v2-contract.md` 是冻结的 v2 最小互操作契约；`contracts/relay/v2` 及 Node/Android 的独立 v2 codec 已形成 conformance 基础。Node 另有未接 production runtime 的 H0/H1、H2 materialized-state 与 pinned snapshot spool、H3 foundations，以及只连接这些 typed authority port、以同步 readiness withdrawal 和 exact route token 关闭竞态的 bounded host route/runtime composition core；`src/relayHost.ts` 和其他 production composition 均未构造该 core。Broker credential 已冻结独立的 native state-store contract revision 2（interface/storage/binary/fixture仍为 v1）、TypeScript deep port/raw N-API closed wrapper 和 single-descriptor fixture，并有未接线的独立纯 Rust binary/publication core、拥有 manifest-derived container spec、pre-fd registry、process-origin/descriptor fence、exactly-once final close、private N1 bridge与opaque process-bound wrappers的未接线 platform-common lifecycle owner、未接 production composition 的显式 target/N-API/fixed-artifact optional loader及未接线的 credential authority/external-continuity source foundation；revision 2 的 durability allowlist为空，真实 open必须在 registry/mutation前 fail closed。已有显式、未接线的本机 target N-API build/stage/npm-pack verification foundation，共用loader fixed descriptor并验证binary header/digest、固定命名、pre-commit空layout、有界pure-ustar tar/unpacked layout与packed loader/closed binding；final hard-link是唯一不rollback的commit point，Node path API不足以宣称抵抗恶意同uid最终目录换名。当前证据仅Darwin arm64，仍没有Darwin x64/Linux、四target matrix、bit reproducibility、qualified real open、真实 OS fork/kernel-lock/filesystem/power-loss/device、Dashboard bundle/签名/notarization/minimum-OS/glibc/SDK/provenance、production authority injection/composition/shipping证据。Credential authority 的 enrollment create/redeem、client/host refresh、host reauthentication 与 host bootstrap API，以及严格的 B1 `POST /v2/hosts/bootstrap` ingress adapter，均已在隔离模块和专项测试中可调用；B1 尚未接 production listener/router/composition/E0，因此这些流程没有外部生产 HTTP 可达路径，不产生 ready/capability，也不能宣告已经交付。Node 另有独立、未接线的 E1 external continuity authority HTTPS adapter foundation，可在隔离模块和专项测试中调用，只负责 exact endpoint POST、system TLS、caller-injected auth header、pre-body header gate、bounded strict outer decode与现有 read/CAS error闭合；它不设置第二个 operation timer，仍由 `RelayV2ContinuityAnchor` 的 signal 拥有 deadline。Node 现有未接线的 broker credential live-authorization/fence foundation：credential authority 在 revoke、kid removal 的 durable commit 后发布 exact revision/fence，BrokerCore 对 Upgrade 后 attach、auth-control、route与逐帧 dispatch执行 expiry、role/host binding和exact identity fence，并在 authority 首次 ready withdrawal 后通过同一窄 port 同步全局关闭 admission/active-data gate；close signal只有typed symbolic reason和connection incarnation；独立未接线的 transport close coordinator 已消费该 signal 并实现 4401/4403/1013 与 5000ms force-destroy policy，但 production composition adoption、listener/socket wiring 和真实 ready-loss 证据仍缺失。B1 与 E1 均未接 production listener/composition，E0 production backend、auth/config source、production authority injection和上述ready-loss seam的production wiring仍未实现；同一 authority 另有未接 production composition 的 response replay-key rotation lifecycle：私有 envelope v3 持有 bounded active + decrypt-only keyring 与永久有界 key-id/rotation history，每个 record exact 绑定 key id；旧 v1/v2 单 replayKeyBase64url state 和原 ciphertext/TTL 无损迁移，同 rotationId 重试不产生第二个 active key，unknown key、AEAD 或 malformed state 按既有 fatal 路径 withdraw；rotation 没有 production 管理入口，不修改 public wire，也不产生 ready/capability。loader 的 supported/opened+self-check 不表示 ready，且 native artifact 缺失或任一失败都不授权 v1/BAU fallback；此前被拒绝的 BAU path/JSON 设计未纳入当前交付源码，也不得作为 fallback 重新引入。Android 已把 closed startup admission、v2 actor、bounded RFC6455 WSS 与隔离 Room repository 的基础 state-sync 接入 production root，但只允许已存在且 credential/admission 已验证的显式 v2 profile；同一个 state DB 还持有未接 producer/dispatch 的 activation Outbox、未接 runtime 的 terminal checkpoint 与 Agent rows，不含 credential。HTTPS enrollment/refresh、自撤销、Outbox command runtime、terminal、Agent extension、reconnect/backoff、capability advertisement，以及真实设备/公网 Relay TLS 互操作证据仍未交付；durable Outbox 非空或收到未拥有 effect 时必须 typed fail closed，绝不 fallback 到 v1。可选 `agent.transcript-lifecycle.v1` 已有未接 production runtime 的 Node host authority reducer、独立 public codec、durable store/replay runtime foundations，以及 Android lifecycle/notification reducer foundation；Node store 的严格落盘 preflight、byte-aware pinned page、retention、本地 state/witness crash cut和显式注入的共享 Relay v2 monotonic/CAS continuity port已有专项测试，paired state+witness rollback由外部 checkpoint拒绝。仓库仍没有该 port 的 production monotonic authority adapter、trusted source/relay-host composition或 capability接线；broker、Android Room/actor/UI/系统通知、credential/enrollment和 capability advertisement也仍未交付。任何一端都不得因为 codec、契约、port 或 foundation 存在就宣告 v2/extension capability、生成 v2 enrollment、把 v1 shared secret 提升为 v2 credential，或在失败时静默降级/重试到另一协议。
- H2 materialized-state owner 现签发进程内 opaque bundle，把 runtime H2 四方法与唯一 cut source exact 绑定；只有以该 bundle 打开的 snapshot spool 才会再次签发 composition authority，把同一 H2 owner 与该 exact spool 的 get/release/receipt lifecycle 绑定。旧 `{ cutSource }` spool 入口继续服务非-readiness 调用，但不能生成 composition authority。default-off composition 装配的独立 `hostH2ReadinessActivation` owner 只接受第二段 exact bundle，并只能把该 spool 对当前 hostId/hostEpoch/hostInstanceId 验证成功的 receipt 转为 readiness。伪造、复制、Proxy/accessor、split H2/spool 或 binding mismatch 均保持 H2=false；cut release、owner takeover、spool/sink close 与 dispose 会同步撤回，replacement 先同步撤旧 generation 再以严格更大 generation 恢复。activation release 的同步异常、非法返回或 native Promise rejection 会把整个 H2 activation authority fail closed，撤当前 readiness、毒化 pending/future activation 且绝不重试 release；旧 late close 仍不能误撤新 generation。expiry 没有 composition timer，只有 spool owner 在后续 cleanup 或其他 owner operation 中观察并 prune 到期 cut/receipt/lease 后才撤回。该 seam 未接 `relay-host`、carrier、production readiness producer 或 capability advertisement，不改变当前 Relay v1 生产事实。
- Node 另有未接线的 B4 credential HTTPS ingress foundation，覆盖冻结的 enrollment redeem、client/host refresh 与 self-revoke 四端点，并复用 B1 的 method/path/header/body admission、严格 codec 与 response mapping boundary。B4 只调用 credential authority 的窄 port，未注册 production listener/router/composition/E0，不产生 ready/capability，也不创建 v1 fallback。
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
  -> admitted explicit Relay v2 profile -> base-sync actor / bounded WSS / Room
     (server/host production v2 readiness 尚未交付)
```

## 阅读顺序

1. `README.md`：用户可见能力、安装、配置、开发和发布入口。
2. `ARCHITECTURE.md`：当前代码地图、managed session contract、运行时状态和发布边界。
3. 按任务选择：
   - CLI、Dashboard 或 SSH 使用流程：`MANUAL.md`。
   - 当前 Relay v1 部署、Dashboard 配对和 Android 接入：`docs/remote-relay-android.md`。
   - Android 产品信息架构、持久层、连接状态机、Outbox 和迁移层：`docs/android-v2-architecture.md`。
   - Relay v2 工作：先完整阅读 `docs/relay-v2-contract.md`，再读 `docs/relay-v2-implementation-plan.md`；前者冻结协议语义，后者只拆分并行工作与验收，不描述当前已交付能力。
4. 修改 wire/storage/RPC 前，先读对应 `contracts/**/manifest.json`、fixture 和消费它们的测试。
5. 最后读目标模块源码及相邻测试。测试是理解当前行为的证据之一；只有面向稳定外部行为、版本化契约或关键安全不变量的测试才构成长期兼容说明，源码形状断言不能反过来定义架构。

若文档、契约、测试和代码互相矛盾，不要任选一个方便的解释。先确认当前可观察行为与兼容承诺，再在同一变更中收敛代码、测试和文档。不要保留会被误当作当前事实的实施计划、临时截图路径、测试数量或分支/commit 状态。

## 目录与职责

| 路径 | 所有权与职责 |
| --- | --- |
| `src/` | Node.js/TypeScript `tw` CLI：配置、managed state、git worktree/tmux 生命周期、JSON RPC、SSH Hosts、automations、`tw serve`、Relay v1 broker/host，以及尚未接入生产 runtime 的独立 Relay v2 codec、H0–H3、bounded host route composition 和可选 Agent transcript/lifecycle authority/codec/store/replay foundations。 |
| `test/` | 根 CLI、RPC、storage、Relay、安全和兼容行为测试。根测试必须通过 `npm run test:cli` 串行运行。 |
| `contracts/tw-rpc/v1/` | Dashboard/CLI 共用的冻结 RPC v1 行协议与 fixture。 |
| `contracts/relay/v1/` | Node 与 Android 共用的 active-but-legacy-frozen Relay v1 wire fixture。 |
| `contracts/relay/v2/` | Node 与 Android 独立 v2 codec 共用的 frozen wire fixture，以及独立的 broker credential native state-store contract revision 2；后者的 interface/storage/binary/fixture仍为 v1。通过任一 fixture 都不等于 runtime/native adapter 已接线或可宣告 capability。 |
| `native/relay-v2-broker-credential-state-store-core/` | 独立、未加入根 Cargo workspace 的 broker credential binary/publication 纯 Rust core；只拥有 bounded absolute-range selection、opaque transaction lease、两阶段 publication、uncertain poison 与 close barrier，不拥有 N-API、OS secure-open/lock/durability 或 credential schema。 |
| `native/relay-v2-broker-credential-state-store-platform-common/` | 独立、未加入根 Cargo workspace且未接线的 N2/N3 shared lifecycle owner；build-time 单点消费 manifest中的 canonical private-location定义，runtime拥有pre-fd registry、process-origin/descriptor fence、exactly-once final close、private N1 bridge和opaque process-bound store/transaction wrappers。它不接 `trustedHome`、path、syscall、filesystem、durability 或 N-API；N2/N3/N-API不得直接消费或暴露 N1 types，也不得复制该 lifecycle。 |
| `contracts/storage/` | host config、managed state、Dashboard terminal registry 的冻结磁盘契约。 |
| `app/src/` | React renderer、Dashboard 状态/交互模型及 `DashboardBackend` 抽象；不得直接承担 OS、tmux、SSH 或凭证操作。 |
| `app/tests/` | renderer 可观察行为、平台依赖边界、持久化、安全和无障碍测试；不用于冻结组件拆分、函数名、导出列表或调用形状。 |
| `app/src-tauri/` | Rust 原生适配层：Tauri IPC、PTY、Git/files、SSH、配置、catalog、持久化、Mobile Relay 进程编排，以及 bundled `tw` RPC 调用。 |
| `app/scripts/`、`app/installer/` | 隔离开发、Dashboard/DMG 构建和安装器；不是业务逻辑来源。 |
| `mobile/android/` | 独立 Android 生产代码与 Gradle 工程：Compose、v1 Room/DataStore/Keystore 与 OkHttp Relay v1 actor；对已存在且 admission/credential 已验证的显式 v2 profile，production root 另装配独立 Relay v2 actor、bounded WSS 和 Room 基础 state-sync。HTTPS credential exchange、Outbox command producer/dispatch、terminal、Agent extension、reconnect/backoff 与 capability advertisement 仍未接 runtime；内置 xterm WebView 仍只服务当前 v1 终端。 |
| `scripts/` | 仓库级文档检查和统一验证入口。 |
| `.codex/skills/` | Agent 操作规程；不是应用运行时或用户状态。 |

`dist/`、`node_modules/`、Gradle `build/`、Rust `target/` 和生成的 DMG/APK 都不是源码事实。不要手改生成物，也不要为了“让 diff 干净”删除他人的本地构建或工作树内容。

## 顶层架构与变更准入

- **先找 owner，再写代码。** 实现前必须能说明：这项行为的权威状态属于谁、唯一写路径在哪里、调用从哪一层进入、失败时由谁决定语义。无法回答时先读架构和现有入口，不新增平行的 manager/service/coordinator 来绕开问题。
- **依赖只朝权威边界收敛。** React view/hook 只能依赖 renderer model 与 `DashboardBackend`；Tauri command 只做 IPC 适配和编排；managed mutation 继续进入 `tw rpc`；Android Compose 只进入 `V2ViewModel`，再由 repository/actor 访问 Room、DataStore、Keystore 和 Relay。下层不得反向导入展示层，transport/adapter 不得成为业务事实 owner。
- **一个概念只有一个生产 owner 和一条 canonical 写路径。** 不能因修改现有 owner 较难就复制状态机、缓存、codec、生命周期或 fallback。跨 CLI、Dashboard、Android 的共享只能通过已定义的 RPC/wire/storage contract，不通过复制实现或跨发布面源码依赖。
- **composition root 只装配。** `App.tsx`、Tauri `lib.rs`、Android Activity/navigation root 和 CLI command router 可以连接模块，但不沉积可复用业务规则、持久状态机或第二套权限判断；逻辑应落在已经拥有该职责的 domain/feature 模块。
- **新抽象必须有独立职责。** 仅为减少单文件行数、迎合测试、包一层单次调用或保留旧实现而新增模块/接口，不构成新抽象的理由。新模块应拥有清晰输入输出、状态或生命周期边界；替换旧路径时在同一变更删除旧路径，除非它是有明确入口和删除条件的兼容层。
- **兼容与 fallback 必须局部、枚举、可删除。** 不建立散落的 `legacy`/`v2` 条件分支，不用 catch-all fallback 掩盖 authority、contract、auth 或 corrupt-state 错误。兼容入口必须写清触发信号、允许行为和删除条件。
- **架构约束描述稳定关系，不冻结实现形状。** 应优先用类型、接口、可见性、版本化 contract 和少量跨目录依赖检查表达边界。文件名、函数名、精确导出清单、hook 拆分、调用次数和组件嵌套不是架构契约，允许在 owner、依赖方向和可观察行为不变时重构。

修改范围应保持在最小 owner 闭包内。若一个需求同时迫使多个发布面、多个 authority 或无关重构一起变化，先确认是否确有 contract 变化；不要用扩大 diff 的方式制造“完整性”。

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
- 继续实现 Relay v2 时，保持现有独立 codec 边界，并按冻结契约建立独立 actor、repository、profile 和 credential namespace；不要把 v2 条件分支散落进 v1 actor，也不要把旧 profile、session name、Outbox 或 stream identity 原地“升级”。

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

## 测试准入与维护

验证矩阵规定一次变更需要运行哪些既有 gate，**不表示每次变更都要新增测试**。无测试增量可以是正确结果，尤其是纯重构、文档、构建编排或已被现有 contract/behavior 测试覆盖的修改。

新增测试必须同时满足以下条件：

1. 保护一项可观察行为、版本化 contract、关键状态转换，或曾真实发生且可能复发的安全/生命周期缺陷。
2. 能说明修改前它会因正确原因失败；若旧实现同样通过，该测试不能作为本次回归证据。
3. 仓库中没有别的测试已经覆盖同一风险；新增 case 提供的是新故障信号，不是换一组 mock、入口或参数重复证明。
4. 放在最便宜且最接近 authority 的边界，并允许不改变行为的内部重构继续通过。

不满足上述条件时，运行相关既有测试即可，不新增测试。修复缺陷时优先补一个最小回归 case；新增 feature 优先扩展最近的行为或 contract suite。只有出现新的独立公共边界、独立状态机或现有文件无法合理容纳的测试族时才新建测试文件，默认修改现有测试文件。

下列测试默认禁止：

- 读取生产源码文本或 AST，断言精确文件路径、函数/类型名、export 列表、直接调用次数或顺序、hook dependency array、组件嵌套、CSS 字面量；
- 为一次重构或任务阶段命名的 `*Structure.test.*`、里程碑编号测试，以及只证明“代码被拆到了某文件”的测试；
- 把生产实现复制到 fake/helper 后只验证副本，或只验证 mock 返回了测试自己配置的值；
- 用 `transpileModule` + `new Function` 或自制 hook/framework runtime 模拟 React、Compose、Tauri 等框架语义；应把纯状态机从框架中提取后测试，或使用真实框架 renderer 做少量边界集成；
- 同一语义在 unit、integration、source scan 和多端 fixture 中无差别重复；跨端 codec 各自消费同一 contract fixture不属于重复；
- 为追求测试数量、覆盖率数字或 diff 的“对称”而枚举没有独立风险的分支、getter、样式和透传 wrapper。

唯一允许的源码扫描是无法由编译器、类型系统、lint 或 contract 表达的**窄依赖禁令**，例如 renderer 中只有 Tauri adapter 可导入 `@tauri-apps/*`。这类检查只能查“禁止的依赖是否出现”，不得枚举允许的内部文件、export、函数或调用图。

测试所有权与生产代码所有权一致：根 `test/` 验证 CLI/Node runtime 和共享 contract，不扫描 Dashboard 或 Android 内部源码；`app/tests/` 不解析 Rust 实现；Android 行为、manifest 和 packaging 检查留在 Gradle source set。跨发布面互操作由各端独立消费 `contracts/**` fixture，不由某一端测试遍历另一端的内部文件。

测试不是只增不减的账本。行为删除、兼容窗口结束、实现被更高层 contract 测试覆盖，或新增 case 使旧 case 重复时，必须在同一变更删除或合并旧测试。现有源码形状测试属于待收敛债务，不得复制或扩写；触及相关区域时优先替换成行为/contract 测试，无法提供独立故障信号的直接删除。测试代码明显大于所保护的实现或状态空间时，先停下来合并 table case、收窄 fixture 和删除重复层，而不是继续追加 helper。

## 验证选择与证据质量

全量 gate 是检查集合，不是质量评分。全量通过只表示这些检查没有发现问题；它不能弥补相关场景没有行为测试，也不能把源码形状测试变成有效回归证据。运行不熟悉的 suite 前，先抽查与改动直接相关的 case，能说明其输入、动作、可观察结果以及会捕获的故障后，才把它列为交付证据。

验证证据按用途区分：

| 证据 | 可支持的结论 | 典型形式 |
| --- | --- | --- |
| 主要行为/契约证据 | 对指定风险有直接回归保护 | 共享 contract fixture、authority 层状态转换、失败注入、隔离文件/进程/网络集成、真实 renderer/device 行为 |
| 辅助静态证据 | 代码可构建且满足工具可检查的边界 | typecheck、compiler、lint、format、manifest/schema、窄依赖禁令、bundle 检查 |
| 弱证据 | 只能说明遗留检查仍通过，不能单独证明功能正确 | 源码/AST 形状、mock echo、无语义 snapshot、test-of-tests、自制 framework runtime |

Agent 交付时不得只写“全量测试通过”。应说明运行了哪些检查、它们覆盖哪个风险，以及仍缺少的 device、真实网络、签名或发布证据；弱证据即使在全量 gate 中通过，也不计作对应行为已验证。

默认执行风险驱动的最小验证，不自动运行 `npm run verify`、`verify:all` 或 `verify:device`。只有以下情况才扩大到统一 gate：

- 变更跨多个生产 owner 或发布面；
- 修改共享 RPC/wire/storage contract，或一个 adapter/interface 的多个消费者；
- 准备 release、签名、发布或用户明确要求全量验证；
- 最小检查暴露跨层影响，无法在单一 owner 层封闭风险。

同一轮工作先跑相关 case，再跑受影响层；确需统一 gate 时最多在收敛后跑一次。失败后先重跑失败层和直接相关 case，不因“保险”反复跑全仓。仅文档变更只跑 docs gate；没有 device/真实服务行为变化时不运行 device 或真实连接验证。

## 变更到验证矩阵

本矩阵给出默认最小证据和扩大验证的触发条件；“交付”本身不触发全量。测试新增仍必须通过上面的准入条件。不要用硬编码测试数量判断完成，也不要绕开根 CLI 的串行测试脚本。

| 变更范围 | 默认最小证据 | 何时扩大验证 |
| --- | --- | --- |
| 仅 Markdown/链接 | `sh scripts/verify.sh docs` | 同左，并人工核对描述是否为当前事实 |
| 根 CLI、config、state、RPC、Hosts、automations | `npm run build` + 直接相关的 `node --test --test-concurrency=1 test/<name>.test.mjs` | shared command/state/RPC 影响多个 suite 时跑 `npm run test:cli`；同时影响 Dashboard/Rust consumer 才跑 `npm run verify` |
| Relay v1 Node/broker/host/serve | `npm run build` + 直接相关的 broker/host/serve test | 跨 Node 模块跑 `npm run test:cli`；修改 Relay wire 或 Android consumer 才跑 `npm run verify:all`；真实连接变化再做隔离端到端 |
| Dashboard React/model | `npm run build`、`npm run test:typecheck` + `npm exec -- tsx --test tests/<name>.test.ts` | shared renderer model/hook 或 test infrastructure 变化时跑 `npm test`；跨 Tauri interface 才跑 `npm run verify` |
| Dashboard platform interface | 相关 platform test + build/typecheck，并同步 fake/preview/Tauri shape | interface 多消费者或 IPC shape 变化时跑 Dashboard 全 suite 与 Rust test；不因单一 adapter 修改自动跑 Android |
| Tauri/Rust/IPC/PTY/SSH/storage | `cargo fmt --check`、`cargo check` + 相关 `cargo test <filter>` | shared support/IPC/storage 影响多个 feature 时跑 `cargo test`；跨 Dashboard/CLI contract 才跑 `npm run verify` |
| Android Kotlin/Room/Relay/UI | 相关 `:app:testDebugUnitTest --tests <class>`；按改动补相应 lint/build | Room migration、manifest/packaging、共享 actor/repository 或广泛 UI 变化时跑 `npm run verify:android`；跨 Node contract 才跑 `verify:all` |
| `contracts/relay/v1` 或 `contracts/relay/v2`、跨 Node/Android wire 行为 | 两端最小 contract/codec consumer test | wire fixture/manifest 变化跑 `npm run verify:all`；真实 device 行为变化才跑 `verify:device` |
| `contracts/tw-rpc`、storage contract 或跨 CLI/Rust 行为 | 根 contract test + 对应 Rust consumer test | fixture/schema/双端解析变化跑 `npm run verify` 或 `verify:all`，按实际消费者决定 |
| 版本、bundle、签名或发布路径 | 所有受影响构建、artifact 和 contract 检查 | release candidate 才执行适用统一 gate；只有 Android device/release 行为在范围内时才要求 `verify:device` |

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

一次变更只有在以下条件同时满足时才算完成：实现位于正确的所有权层；兼容和安全红线未被绕开；受影响的 contract 和当前事实文档同步；测试增删符合准入与去重规则；适用 gate 通过；diff 不包含无关或生成内容；交付说明明确区分已验证事实、未运行的设备/发布步骤以及任何剩余风险。完成定义不要求测试数量增加。
