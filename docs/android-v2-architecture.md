# Android Compose UI V2 产品与架构

## 当前边界

本文中的 **V2** 指第二代 Android 产品界面和客户端架构，即 Compose UI、`V2Activity` 与 `V2ViewModel`；它不代表 Relay v2。Dashboard、`relay-server` 和 `relay-host` 的生产路径仍只实现 Relay v1。Android production root 另有一个严格受限的 Relay v2 base-sync 路径：只有 cold-start credential/admission 已验证并直接携带的显式 v2 profile 才能进入；这不表示完整 Relay v2、ready 或 capability 已交付。Android 已有独立 Relay v2 strict codec，以及使用 v2 profile/credential、fakeable transport/clock、串行 socket ownership、双代际 fence、握手 watchdog 和显式 query/resync/reject effect 的 `RelayV2ConnectionActor` seam；其默认 action queue 为 64 个普通槽、8 个保留控制槽和 1 MiB raw UTF-8 byte budget，effect queue 为 32 项和 1 MiB raw UTF-8 byte budget。Android production root 对上述已验证 profile 复用同一个 `tw_mobile_relay_v2_state.db`/repository 实例执行基础 state-sync、exact activation Outbox query admission、recovered command status 的 post-commit Execute ordering，以及 bounded fresh `QUEUED` durable dispatch；v2 Outbox UI/enqueue、terminal 与 Agent extension 仍未接线。数据库 version 5 通过显式 `MIGRATION_1_2`、`MIGRATION_2_3`、`MIGRATION_3_4`、`MIGRATION_4_5` 保留原有六张 state-sync 表、version 2 新增的 Outbox/terminal 表、version 4 新增的 Agent lifecycle state/notification claim表，并在 version 5 加入独立 row-oriented Agent materialized entry、snapshot staging header/records与 snapshot/gap 期间的 durable LIVE buffer；4→5 只创建表、index、constraint，不解析、回填或改写旧 payload/row。version 3 在 authority row 上加入原子 snapshot release journal，持久保存旧 cut identity、durable cursor、release reason 与 ACK 后动作，partial/未知 journal 读取 fail closed。state-sync 表按 `profileId+principalId+clientInstanceId+hostId+hostEpoch` 隔离 authority、Scope、opaque Session、snapshot metadata/records 和 durable event buffer，支持 welcome required watermark、pinned cut 流式 staging、连续 event 合并及单事务 commit/discard/release-CAS。独立 recovery repository adapter 由 `RelayV2BaseRuntimeComposition` 的 effect pump 使用，只在 actor apply lease 下提交完整 Room mutation，事务提交后才把 exact receipt 交回 actor；UI 的 STOPPED/CONNECTING/RESYNCING/ONLINE/FAILED 只描述该显式 profile 的连接状态，不宣告 Relay v2 readiness 或 capability。Outbox meta/entry 表按 `profileId+profileActivationGeneration+principalId+clientInstanceId` 隔离 authority，entry 另以 `hostId+expectedHostEpoch+commandId` 定位并显式保存稳定 creation order；terminal checkpoint 表以 SendOpen 前已稳定的完整 target（包含客户端生成的 `streamId` 与 pane）为整行主键。三类 versioned canonical payload 都显式保存 UTF-8 byte count 与 SHA-256，读取时依次执行上限、实际 byte count、digest 和 strict roundtrip 校验。该数据库不复用或原地升级 v1 profile/session/Outbox/stream rows，也不保存 access、refresh、enrollment、resume token 值或其他敏感 credential material；terminal 涉及 resume credential 时只保存非敏感 Keystore reference/fingerprint。snapshot 每块最多 256 records/512 KiB canonical bytes，完整 cut 最多 100000 records/256 MiB canonical bytes，staged raw UTF-8 最多 512 MiB；RESYNC event buffer 最多 4096 条/16 MiB。这些是每个 state namespace 的硬上限。

Android 还包含纯 Relay v2 Outbox authority core foundation。它绑定 profile/principal/host lineage、dedupe window、command、operation、opaque Scope/Session 与 canonical request fingerprint，输出不可变 state、原子 mutation plan 和 typed effect。独立 Room repository 是这些事实的唯一持久写入口：同一 transaction 内 load、strict decode/restore、pure reduce、按 plan 写 meta/entries，commit 后调用者才可处理 effect；`AtomicReissue` 的原 entry replacement、新 entry 与 creation cursor 因而原子提交。Outbox 入站证据 seam 显式接收 actor 已严格解码的 `command.status`、`command.result` 和 `command.statuses` effect；adapter 不信任外部仍可变的 decoded frame，而是从其 immutable `canonicalWire` 经现有 PUBLIC codec 严格重解码并完成 exact canonical round-trip，再以同一份 adapter-private snapshot 判定 ownership、取得 apply lease 和执行完整 transaction。`command.statuses` 还会在 ownership 边界把 actor 提供的 expected-command batch 按原顺序复制为不可变私有批次；后续校验、lease 内 transaction 和 receipt 只消费该批次，外部列表变更不能删项、换项或改变恢复游标。malformed、canonical mismatch 或私有复制失败均 fail closed，不能降为 `NotOwned`，也不能进入 durable transaction；合法非 Outbox snapshot 才原样返回 `NotOwned`，不取得 apply lease 或访问 durable owner。Outbox effect 在 actor-owned apply lease 内按完整 namespace、host epoch、command、attempt kind/requestId、dedupe window、Scope/Session 与 operation/result shape 适配为现有 pure authority evidence；只有 repository 单事务提交成功后才返回 exact receipt 与 typed effects。repository batch rejection 的 reason 原样穿过 seam；`STATUS_IDENTITY_MISMATCH` 明确返回 protocol violation，普通 reducer rejection 返回带原 reason 的 rejection。stale generation、缺项、identity 不匹配、reducer rejection 或存储失败都不产生 receipt/effect，损坏或未知 Outbox namespace 继续 fail closed，不会当作空队列自动重发。Outbox query 准入屏障由 production base composition 先创建 exact authority pair，只把 verifier half 绑定 actor，并把不可见的 issuer half封装进配对 adapter；普通结构、复制或 foreign pair不能生成该 actor可消费的 proof。actor 冻结 generation/recovery step/requestId/host lineage 与不可变 command batch 后进入 `AWAITING_COMMAND_QUERY_COMMIT`，先发布 repository-scoped registration effect；独立 adapter 在同一 actor apply lease 内用该 requestId 提交 `BeginQueries`，严格确认 durable commit 恰好产生一个完整匹配的 `QueryCommands` 后才签发 opaque one-shot receipt。actor 以 pair identity、CAS 和完整冻结 identity 验证并永久消费 receipt，replay、wrong generation/step/request/batch 均不能触发发送。durable commit 前、receipt 不匹配或未被 actor 接受时均不触及 transport；已提交但 receipt 丢失时，Outbox 保留可恢复的 `CONFIRMING`/`AMBIGUOUS` query attempt，不执行 command、也不自动重发。exact receipt 被 actor 接受后才发送一次 `command.query`，原有 response→`ApplyCommandStatuses` 路径不变。没有 verifier 的 actor 默认 fail closed且不发 query；两个 adapter 自身都不订阅 actor effects，production `RelayV2BaseRuntimeComposition` 的唯一 pump 负责路由 registration 与 status effect，并复用 state-sync 的同一个 Room repository。durable status transaction 完整提交后，base composition 才保存该 commit 的 opaque Q2 Execute capability；actor 串行消费 exact `CommandStatusesApplied` 后，中间批只在下一批 query admission 已发布时返回 `ContinuedRecovery`，最终批只在 `lifecycleLock` 内把 ONLINE 与既有 Execute-ready cut 同时发布后返回 `OnlineReady(exact authority)`。composition 只在该最终 handoff 后按 durable commit 顺序经现有 dispatcher/actor `sendIfCurrent` flush。zero-effect batch 正常完成；未知或非 Execute effect、foreign lineage、overlimit、stale receipt 与 generation 前移继续 fail closed或清空且零发送。 同一 durable owner 现另提供 bounded fresh producer transaction：只在 actor apply lease 内由 core 按 creation order 选择最多 32 条 DispatchEligible，单事务提交 `QUEUED→SENDING` 后才把 Execute effects交给闭合 issue/consume seam；零 eligible 正常返回，不创建内存真相或观察旁路。

独立的 Outbox 出站 seam 不把可复制、可观察的 `RelayV2OutboxRecoveryCommit` 当作发送证明。canonical factory 创建 closed issue/consume composition；private-constructor issue port只进入配对 recovery adapter 的私有字段，private consume port只进入 private dispatcher implementation，composition 对调用方仅暴露 `recoveryAdapter`、具有明确 durable producer 职责的 `freshProducer` 与 `dispatcher(sendPort)`，没有 consume、delivery、wire 或 byte accessor。durable recovery 或 fresh transaction 返回 commit 后、actor apply lease 仍持有时，对应的私有 committed 路径立即完成有界深复制、完整校验和 PUBLIC strict codec 编码；opaque seal只持 detached immutable snapshot，不持 public commit/effects 的 List alias。离开 apply lease 后 issue只做 pair check、一次 CAS与 capability mint；Ready、`NoDispatch` 和 typed rejection seal都在首次 issue前原子消费，不能再次签发或改写结论。因此复制或伪造 commit、public result、identity都不能铸造可被配对 consume port接受的新 capability。

该 seam 只签发真实 durable owner 在 recovery retryable `not_accepted` transaction 或 fresh `DispatchEligible` transaction 中产生的 `ExecuteCommand`。Execute snapshot绑定完整 authority、receipt、effect index、attempt kind/requestId/ordinal/`retryAfterMs`、command lineage、Scope/Session、operation、canonical arguments及重算后的 request fingerprint；opaque capability 对外只暴露非敏感 correlation identity，没有 effect、frame、payload、fingerprint、claim 或 byte accessor。该 closed issue/consume seam不签发 `QueryCommands`；query 准入 adapter只把其自己提交的唯一 exact `QueryCommands` 当作 post-commit receipt proof，实际 `command.query` 仍由 actor 串行 owner发送。zero-effect或仅含本 seam不拥有的 effect返回 `NoDispatch`，不伪装成 `Issued(empty)`；mixed commit只为其中的 Execute签 capability，其余 typed effects仍完整保留在 public recovery commit中，由上层对应 owner处理，不表示已消费或静默丢弃。snapshot/encoding失败返回 typed dispatch rejection，但 durable recovery commit仍可见且不会回滚。

private dispatcher 在任何 send callback 前先通过配对 consume port永久消费 capability，再把私有 wire defensive copy和完整 `profileId`、profile activation、principal、`clientInstanceId`、host lineage与 socket generation authority交给 actor-owned exact-generation send port。`RelayV2ConnectionActor` 已实现该 Execute send port：它只在完整 repository/socket authority 仍精确 current 时于 lifecycle fence 临界段内随 `ONLINE` 发布 exact execute-ready cut，任何离开 ONLINE 或 owner/authority 撤销都先在同一个锁内撤该 cut。send 在该锁内核对 cut、完整 authority 与当前 socket owner 后执行唯一一次同步 transport send；输入 bytes 先受公共 frame 上限约束并 defensive copy，actor 不 retain或记录。`QUERYING`、首次 snapshot 与 ONLINE gap 后的 `RESYNCING`、profile 切换、client rebind、disconnect/reconnect、closing、handshake未完成或 socket generation 前移都在调用 transport 前返回 stale；`command.query` 仍由独立 actor sender 执行，不走该 Execute port。stale、transport `send=false` 和抛错均已永久消费：前者返回 `Stale`，后两者返回绑定原 Execute correlation 的 `ConfirmingRequired`，adapter 内不重发；并发、重入或再次提交同一 capability只会有一个调用进入 transport，其余返回 `AlreadyDispatched`。`retryAfterMs` 的等待与 successor attempt仍属于上层 scheduling owner。dispatcher seam 不生成 attempt/request ID、不改变 Outbox state，不决定 retry、`AMBIGUOUS` 或 query redrive，不持有平行 network generation，也没有 v1/profile fallback；它不订阅 flow、不构造 actor/socket。query-send/attempt-registration、recovered status ordering 与 fresh dispatch 已由 production base composition 接通：composition 在 status durable commit 后按 exact generation/query-recovery lineage 有界累积 capability，gap/resync/disconnect/close/profile failure 或 stale handoff 都清空；actor 返回最终 `OnlineReady` 后先 flush recovered，再调用 fresh producer。fresh producer 不观察 `StateFlow.ONLINE`，而是在每个 actor lease 内由 Room transaction 调用 core 的 DispatchEligible 选择；每批 commit 后才签 capability，发送仍必须通过 actor-owned ONLINE exact-generation gate。commit 后发送前崩溃或 partial send failure 都保留 `SENDING`，下次 activation 只 query、不盲发，也没有自动 retry。这个受限接线仍不构成 G2/G3、capability advertisement、ready 或完整 production Relay v2。

repository 必须在 actor-owned apply lease 内完成代际 effect 的整个 Room transaction；state `matchesGeneration` 只是非原子的代际预筛，不拥有 phase authority，也不能构成 disconnect/profile-switch barrier。切换时 actor 会先原子禁止旧代际取得新 lease，再等待已经进入的旧事务完成；repository 的 profile cleanup API 只接受该 v2 profile 的 exact disconnect receipt，并在一个 transaction 中删除原有六张 state-sync 表的数据、该 profile 的所有 activation-scoped Outbox/terminal、Agent lifecycle/notification rows，以及所有 activation/timeline 下的 row-oriented Agent transcript/snapshot/LIVE-buffer rows。Android 也已有未接 production composition 的 OkHttp HTTPS credential foundation：redeem/refresh 严格使用 HTTPS、精确 path、现有 closed codec schema 和单次 HTTP/1.1 exchange；bounded RFC6455 WSS adapter 现是 base composition 的唯一 socket 入口，以系统 trust 和 RFC2818 hostname verification 建立单次 HTTP/1.1 Upgrade，在读取或分配 payload 前执行 1 MiB frame/fragment 累计限界，并拒绝 extension negotiation。actor/profile startup admission、Room 基础 state-sync repository、Outbox query/recovered-status ordering、bounded fresh durable dispatch 与 bounded WSS 已通过 base composition 接入 `AppContainer`/`V2ViewModel`，但没有真实设备或公网 Relay TLS 互操作证据；HTTPS enrollment/refresh/self-revoke、v2 Outbox UI/enqueue、terminal、Agent extension、reconnect/backoff 与 capability advertisement 均未接线。它们与 Node codec 共同消费冻结 fixture 或按冻结契约建模，但当前连接状态不表示 runtime ready、capability advertisement 或完整生产可用。

现有 `RelayV2ProfileRepository` 提供由 Android production root 调用的 closed startup admission seam。它在已有 activation operation mutex 内先恢复 durable pending activation，再只对恢复后的 active profile 执行 credential reconciliation；exact completed credential 可以沿原 activation journal 完成发布，exact pending、缺失或不匹配的 completion proof 以及 incompatible credential 都返回 typed recovery/reenrollment 结果，不触发 enrollment exchange、HTTP、WSS 或其他 network。只有 active identity、credential reference 与 credential version 最终精确收敛到同一 durable winner，且 credential 为 `InSync` 或同 binding 单调 `Repaired`，才返回非敏感 `Ready(profile)`；credential missing、binding mismatch、blob version behind 或 repair conflict 均返回 typed unavailable。该 seam 的结果和诊断不包含 token/blob，不生成 enrollment、ready frame 或 capability；只有 `Ready(profile)` 的 exact 已验证 profile 才被直接交给 base composition，其他结果 fail closed 且不连接 actor/transport或启用 v1 fallback。

Android 还包含一个未接线、Android-free 的 Relay v2 terminal checkpoint/reducer core。其版本化 stable timeline identity 包含 `profileId`/activation generation、`principalId`、`clientInstanceId`、完整 host lineage、Scope/Session、stream/generation，以及 resume-token credential reference 与非敏感 fingerprint；`openId` 和 `closeId` 是独立持久、可精确关联的单次 logical attempt。首次发出 open effect 前，pre-open checkpoint 先持久化本地可信 target、mode、attempt fingerprint、delivery authority，以及 mode 所需的 frozen generation、nextOffset、resume credential reference/fingerprint；每次 network dispatch 必须使用该 logical attempt 的持久有界 history 中从未签发过的新 requestId，迟到 response 不能命中后一次 send，logical fingerprint 保持不变。RESET result 必须同时轮换 frozen resume generation 与 token fingerprint。成功 open 后保留原 logical result lineage，使 response-loss retry 和 host deduplicated replay 可逐字段幂等核对；deduplicated NEW/RESET 若已有输出，可从冻结 baseline 接受非零 tail 并按 ring replay。correlated pre-open reset 也持久化被消费 attempt 的精确 open fence，不能以无 fence effect 污染后续 attempt。client-local delivery fence 直接复用 actor authority 的 `RelayV2EffectGeneration(profileId, profileGeneration, connectionGeneration)`，再叠加同一 activation 内可恢复的 authority generation 与本地 callback-dispatch token；authority generation 可在进程重建后允许 actor counters 重新起步，同 authority 内才比较 connection/local counters，profile activation 变化不能原地 rebind。Android 不可见且不会伪造、推断或持久化 carrier `routeId`/`routeFence`。每个 network action、parser callback 与 effect 都带当前 client-local fence，parser callback 还绑定完整 timeline identity、当前 open attempt、delivery authority、`parserContinuityId` 和精确 byte start/end；restore 必须先用持久 operation 的原始完整 callback token 验 proof，再允许换绑 delivery，不能先改写旧 operation fence。Rebind/RESUMED 会用新 fence 确定性重驱同 generation 的 pending input/resize，旧 callback 永久无权。网络连续接收与 parser 实际应用使用不同 watermark；只有后者推进累计 output ACK，replay bytes 已接收到 captured tail 后，live bytes 可继续有界排队等待 parser 按序越过 replay boundary。restore 在任何深复制前先按 hard count 做 O(1) preflight，再在有界项目内检查 shape/raw bytes；持久 parser write/reset in-flight operation 只有在 adapter 提供精确完整 callback token、applied offset 与状态 proof 后才能完成或重驱，否则显式 reset。pending parser queue 同时受 512 KiB raw-byte 和 128 item 上限约束，control/replay/closed/reset 不因 output queue 饱和而静默丢失。input/resize 从 1 编号并与累计 ACK 分离；每个 queued send effect 还携带可撤销 control-dispatch lease，未来 adapter 必须在实际 socket write 前向 pure core 校验当前 lease 与 exact pending payload；closed、close intent 或 reset 会原子撤销 lease，使此前已排队但未开始的 send 失效。generation 改变、closed 到达或 finalize 时未 ACK input 进入 `AMBIGUOUS`，pending resize 直接丢弃；closed 后即使仍在 replay 尾字节也不再产生 backend input/resize/close effect，未收敛的 close intent 只通过 exact close correlation query 重驱。closed 的 final/reason/exit/generation tombstone 与可单调前移或失效的 retained-ring metadata 分开；known-final open/replay 必须同时满足 exact tail 与 retained ring 覆盖，否则进入 offset-expired reset。损坏、旧 authority 或超限 restore 返回当前本地 authority 可消费的最小 reset 结果，不保留不可信 queue。该 pure core 只产生 immutable typed result/effect；独立 Room repository 负责把 pre-open 或整行 checkpoint 先提交，再把 effect 返回调用者，并把损坏 codec payload 映射为 `Invalid` 交给 reducer 产生显式 reset。二者都未接入 `TerminalWebView`、xterm、Relay actor、socket、network、UI 或 composition，因此不表示 APK terminal v2 已完成。

Android 客户端采用原生 Kotlin + Jetpack Compose，桌面端使用 React + Tauri，双方当前通过 Relay v1 协作。原生实现直接控制 Keystore、网络切换、进程恢复、WebView 终端和系统无障碍能力。

## 产品信息架构

V2 把高频任务和低频管理拆到不同层级，避免所有能力挤在同一个页面。

```text
应用
├── 底部一级导航
│   ├── Inbox：待处理状态、全部会话、快速回复
│   ├── Workspaces：按电脑/Scope/项目浏览会话
│   └── Settings：主题、连接、配对、通知能力说明、诊断
├── 设备抽屉
│   ├── 当前电脑 / 多电脑切换
│   ├── Refresh sessions
│   └── Pair another computer
└── 二三级任务流
    ├── Session detail：时间线、回复、打开终端、结束会话
    ├── New worktree：目标 → 配置 → 确认
    ├── New terminal：电脑、Scope、工作目录、标签
    ├── Terminal：输入、只读、字号、键盘、重连
    ├── Pairing：扫码/手输 → 核对 Relay 地址 → 确认切换
    └── Appearance：持久化切换日间 / 夜间主题
```

视觉和无障碍回归覆盖 Inbox、Session detail、Connection health 以及核心导航、表单和终端控件；验收以待发布构建为准，不依赖历史原型截图。

## 核心用户闭环

### 1. 查看并回复 Agent

1. 启动后先展示 Room 缓存，不等待网络白屏。
2. Relay 在线后刷新电脑、Scope 和会话。
3. 用户进入会话，时间线来自本地数据库；Relay v1 没有远端 Agent 时间线事件，因此当前客户端只展示本机发起的出站消息及其投递状态，不伪造 Agent 回复。
4. 回复先在同一个事务中写入 Outbox 和时间线，再发送到 Relay。
5. 同一 host/session 同时只允许一条消息在途，收到严格匹配的 ACK 后才放行下一条；不同会话可以并行。
6. 断网时保留可解释状态；无法确认是否送达时标记为 `AMBIGUOUS`，不盲目重复发送。

### 2. 新建 Worktree 或 Terminal

1. 先选择电脑，再只展示该电脑可达的 Scope。
2. 表单在本地完成必填校验。
3. 命令携带 requestId、hostId 和请求上下文。
4. 成功后写入缓存并跳转到会话或终端；失败、断线和超时都会退出加载态并给出原因。

### 3. 配对与切换电脑

1. 二维码和深链只预填，不自动连接。
2. 用户必须核对 Relay URL 并点击 Connect。
3. 已配对时，URL、host 或 token 任一变化都需要二次确认。
4. 切换前清除旧凭证、缓存、Outbox、草稿和终端队列，再写入新凭证，避免跨 Relay 串数据。

## Android 分层

```text
Compose Screens
      │  UiState / UiEffect
      ▼
V2ViewModel
  ├── PreferencesStore ── DataStore
  ├── CredentialStore  ── Android Keystore + AES-GCM
  ├── TwRepository     ── Room
  ├── NetworkMonitor  ── 默认网络 identity
  └── RelayV1ConnectionActor
          ├── 串行 IO actor
          ├── epoch 防旧连接回调
          ├── 握手/请求 watchdog
          ├── request registry
          ├── reconnect backoff
          ├── terminal stream registry
          └── terminal open watchdog
```

关键原则：

- UI 不直接操作 WebSocket、数据库或凭证。
- Relay 的可变协议状态只由单线程 actor 修改。
- Room 是缓存、时间线和 Outbox 的持久化事实来源。
- DataStore 只保存非敏感偏好，包括日间 / 夜间主题选择；token 只保存在 Keystore 加密存储中。
- 终端使用随 APK 打包的 xterm 资源，通过受限 `WebViewAssetLoader` 加载，不依赖 CDN。
- Relay v1 二维码使用 CameraX 应用内预览和随 APK 打包的 ML Kit barcode model；扫码时按需申请相机权限，不依赖 Google Play services 运行时下载可选 scanner/model 模块。
- Release 只接受 `wss://`；debug 仅允许模拟器与 loopback 的明文连接。

## 升级兼容层

以下代码仍承担已安装旧版本的升级迁移，不能当作无用 legacy 删除：

- `MainActivity`：non-exported 升级兼容 shim，只负责把仍恢复旧 Activity class 的安装跳转到 `V2Activity`。当支持的升级窗口内已没有旧 task/显式组件入口，并完成升级设备验证后，可以 sunset。
- `LegacyIdentityImporter`：把旧 `identity` SharedPreferences 中的 Relay 配置迁移到 V2 偏好和 Android Keystore，并删除旧明文 token。只有支持的升级窗口结束、迁移完成标记稳定且不再支持从 1.x 直接升级时，才可以 sunset。

`TerminalWebView`、`androidx.webkit` 和 APK 内的 xterm assets 是 Compose V2 终端的当前生产实现，不属于迁移层。

## 连接状态机

```text
STOPPED
  └─ connect ─▶ CONNECTING ─▶ HANDSHAKING ─▶ ONLINE
                    │              │             │
                    ├─ auth ───────┴──────────▶ AUTH_REQUIRED
                    ├─ protocol ──────────────▶ INCOMPATIBLE
                    └─ socket/error ───────────▶ RECOVERING
                                                   │
                                              backoff
                                                   └────▶ CONNECTING

ONLINE / RECOVERING ── network unavailable ──▶ WAITING_FOR_NETWORK
WAITING_FOR_NETWORK ── new network identity ──▶ CONNECTING
```

每次连接递增 epoch，旧 socket 的回调不能修改新连接。重试次数只有在收到协议 `Ready` 后才清零，单纯打开 WebSocket 不视为恢复成功；服务端发起 `onClosing` 时客户端立即确认关闭并进入退避。握手、列表查询、创建命令和消息发送使用分类型超时，终端打开另有独立 watchdog。默认网络从 Wi-Fi 切到蜂窝、VPN 或新的局域网时，即使“仍然有网”，也会重建连接。

## Outbox 语义

```text
QUEUED → SENDING → SUCCEEDED
             ├── FAILED_RETRYABLE → SENDING
             ├── FAILED_FINAL
             └── AMBIGUOUS → EXPIRED / CANCELLED
```

- `FAILED_RETRYABLE`：确认命令没有写入或服务端明确拒绝，可自动重试。
- `AMBIGUOUS`：连接在确认前中断，服务端可能已经执行；为避免重复输入，不自动重发。
- Relay v1 的调度器按 host/session 串行投递；一条 `AMBIGUOUS` 消息会阻止该会话后续消息自动越过它，直到用户取消或 TTL 过期。
- 非空 requestId 必须精确命中当前 in-flight 记录，未知 ID 一律按过期 ACK 忽略；仅兼容旧 Relay 完全省略 requestId 的情况，并且只在匹配的 host/session 内回退。
- 应用重启，或 socket 在 ACK 前关闭时，原 `SENDING` / `ACCEPTED` / `CONFIRMING` 状态都会收敛为 `AMBIGUOUS`。
- 所有非最终状态都有 TTL，Outbox 与用户可见时间线在同一事务中过期。
- Relay v2 生产运行时必须使用幂等 commandId 和结果查询，使 `AMBIGUOUS` 只按权威结果收敛。

独立的纯 Relay v2 Outbox core 已按冻结契约建模发送、接受、确认查询、权威终态、结构化 `not_accepted` 重试/换号、host epoch 变化和 late final。它只依据权威 lineage 与 closed result fields 决策；客户端时间和 human-readable message 不授权自动重发。`AMBIGUOUS` / `REISSUED` 不进入自动发送，相同完整 identity 的 mutation/create lane 分别调度，容量失败保留原 state 且不产生部分换号。入站证据 seam 只把从 actor effect 的 immutable `canonicalWire` 私有重建的 `command.status` / `command.result` / `command.statuses` snapshot 交给该 core 和同一个 Room transaction owner：`accepted` 持久化 acceptance evidence，`running` 进入 `CONFIRMING`，`succeeded`/`failed`/`in_doubt` 分别收敛为 `SUCCEEDED`/`FAILED_FINAL`/`AMBIGUOUS`，无 requestId 的 late final event 仍可按完整 command/host/Scope/Session/window/result identity 收敛既有 `AMBIGUOUS`。query 准入、status recovery adapter 与 closed Q2 issue/consume composition 已由 base composition 的唯一 actor effect pump 接入同一个 Room repository：cold start strict snapshot只把当前 host lineage 的 `SENDING`/`ACCEPTED`/`CONFIRMING`/`AMBIGUOUS` 按 creation order交给查询，终态忽略；同 lineage bounded `QUEUED` 留给 fresh producer且绝不进入 `command.query`，foreign lineage、损坏或超限状态在 receipt/query/Execute 前 fail closed；`autoConnect=false` 不读取 Outbox。durable `BeginQueries` commit 后 actor 才发送一次 `command.query`；status durable commit 后产生的 recovered Execute capability 先按 exact recovery lineage 有界累积，中间批零发送，最终 actor `OnlineReady` 后才按 commit 顺序 exactly-once 消费并经 actor gate发送。崩溃会丢弃内存 capability，重启只从 durable attempted state重新 query；没有新的 exact `not_accepted` 不盲发。fresh producer 已接 exact `OnlineReady` 后的 base composition；v2 Outbox UI/enqueue 与 capability advertisement仍未接线。

## Relay 能力边界

| 能力 | Relay v1 | Android UI V2 当前处理 | 基础 Relay v2 | 独立 Agent extension |
|---|---:|---|---|---|
| 电脑、Scope、会话列表 | 支持 | 完整接入与缓存 | revision、event sequence 与原子 snapshot | 不涉及 |
| 新建 Worktree/Terminal | 支持 | requestId + 超时 | commandId、ledger 与结果查询 | 不涉及 |
| 手机发送消息 | 仅支持发送与 ACK | 持久 Outbox；真实时间线只展示本机出站消息 | 服务端去重、结果查询与明确不确定状态 | 不涉及 |
| Agent 入站 transcript | 不支持 | 不伪造 | 不属于冻结基础 slice | 结构化 entry、cursor、重放与去重 |
| 终端流 | 支持 | stream generation + 打开 watchdog + 同配置/网络恢复后自动重开 | generation、offset、ring 与 resume | 不涉及 |
| Waiting/Failed/Completed | 不支持 | 明确显示“Relay v1 不提供” | 不属于冻结基础 slice | 结构化 turn/run lifecycle |
| 系统通知 | 无事件来源 | 开关禁用并解释原因 | 不属于冻结基础 slice | lifecycle 事件驱动；离线 push 另行验收 |

Android UI V2 不会把 Relay v1 没有的数据伪造成完整功能。基础 Relay v2 只能完善手机出站命令的投递和结果状态；Agent 入站 transcript、lifecycle 和通知必须在独立 extension 协商并通过验收后再启用。

### 当前 Relay v1 可靠性边界

- **配对隔离**：Profile 切换、遗失凭证恢复和重新配对先向 Relay actor 投递带 barrierId 的断开动作。Actor 在旧连接已排队的 ACK、reject 和状态事件之后发出同一 barrier 的 `Disconnected`；ViewModel 等待该事件后才清理六类 Room 数据、草稿、凭证和内存状态，避免旧事件写入新 Profile。
- **分维快照**：Hosts、Sessions、Scopes 各自以 requestId 和 revision 提交。Hosts 响应只更新 host 维度并级联移除已经消失的 host；某个 host 的 sessions/scopes 只有在各自完整响应到达后才替换，不会因为响应先后顺序短暂清空其他维度或其他 host 的缓存。
- **严格响应归属**：所有带非空未知 requestId 的 hosts、sessions、scopes、created、killed、ACK 和 error 都视为旧响应并忽略。旧版 Relay 省略 ID 时，才按预期请求类型使用 registry 中最新的兼容请求上下文。
- **终端恢复**：成功写入 `open_terminal` 后启动 10 秒 watchdog；首个 terminal data 证明流已打开并取消计时。超时会主动关闭旧 stream、产生明确错误并将终端置为 `UNKNOWN`，不会无限停在 `RECOVERING`。断线、同配置重连或网络暂停会清理 active stream 但保留 desired terminal，待网络恢复、session 快照确认目标仍存在后以新 generation 重开；切换到不同配置则清除 desired terminal。
- **终端背压**：Relay actor 的所有动作都通过一个带 512 个普通槽和 16 个保留槽的固定容量单 FIFO；同一 WebSocket 的 callback 入口也串行化，因此 close / failure 不会越过先到的 terminal data 或 ACK。事件队列同样有界。UI effect 通过一个带保留容量的单 FIFO 转发，reset / clear 不会越过先到的 terminal write。终端输出按 16ms / 64K 聚合，WebView 同时只保留一笔 JavaScript write 在途，并把待写缓冲限制在 1M 字符。持续洪峰超过上限时会显示明确截断标记；协议动作队列溢出时主动断开并走恢复状态，而不是无界占用内存。
- **严格流归属**：终端 data / exit 必须携带并精确匹配当前 `streamId`。早期省略 `streamId` 的 relay-host 不再兼容，因为流切换后的迟到数据无法安全归属；当前仓库的 relay-host 始终回传 streamId。
- **明确限制**：当前运行路径没有 Relay v2 的幂等执行、远端命令结果查询、Agent 入站时间线、Agent 状态事件、通知事件或终端 offset 续传。这些能力不能由 Android 本地状态可靠推断。

## 当前交付与实施协调

当前源码已实现 Compose 信息架构、Room/DataStore/Keystore 持久层、Relay v1 actor、每会话串行 Outbox、配对切换 barrier、分维快照、终端恢复、二维码 review、WSS 校验，以及 Relay v2 codec conformance、独立 actor/profile seam、profile owner 内的 closed startup admission、Room state-sync repository、纯 Outbox authority及其 Room 持久 owner、入站 command evidence seam、durable command-query 准入屏障、post-commit exact-generation 出站 adapter seam及 actor-owned send port、OkHttp HTTPS credential adapter、bounded RFC6455 WSS adapter、纯 terminal checkpoint/reducer及其 Room 持久 owner。其中只有已存在且 admission/credential 验证成功的显式 v2 profile 会进入 production `RelayV2BaseRuntimeComposition`，复用同一 credential store 和 state repository，以 bounded WSS 执行基础 hello/query-or-resync、snapshot/release/expiry、scopes/sessions state-sync 和 recovered command status dispatch ordering。可选 Agent extension 的独立 public codec artifact、lifecycle/notification reducer、typed durable operations/Room repository、row-oriented Room v5 materialization、durable notification claim与revision-pinned read projection已在隔离模块和现有 `RelayV2StateDatabase`/DAO owner 内部接通，并已有 JVM 与定向 emulator 证据。新增的 default-off runtime composition seam只接收上层显式交给它的单个effect：已协商Agent frame复用同一个durable repository实例进入现有consumer、notification dispatch coordinator与read projection，未协商frame在任何durable访问前closed；非Agent effect与Agent unavailable effect都以携带完整原effect的`NotOwned`交给upper-layer dispatcher，只有携带exact failed request/admission identity的unavailable effect才归RequestSync redrive owner。它不自行订阅`RelayV2ConnectionActor.effects`。构造composition只装配注入port，不创建或启动database、network、actor、platform notification，也不执行notification intent。`RelayV2ConnectionActor` 的可选 capability 仍只能显式注入且默认为空，只有 host welcome 完成并形成 client/broker/host 三方交集后才会产出extension frame。该composition未在`AppContainer`、`V2Activity`、`V2ViewModel`、navigation或其他production root实例化，default capability advertisement仍为空，且没有接真实platform executor、Compose UI、通知启动或系统`NotificationManager`运行链；production base composition 会为上述 exact profile 实例化一个 `RelayV2ConnectionActor`，但 Agent composition 仍不接入该 effect pump，optional capability 始终为空。因此 APK 当前仍不能展示真实 Agent reply、Waiting/Failed/Completed 或相关通知，也不改变 Relay v1 仍是生产协议的事实。v2 Outbox 的 production query registration、recovered status ordering 与 bounded fresh durable dispatch 已接入唯一 base effect pump；最终 actor `OnlineReady` 后先消费本次 durable status commit 生成的 capability，再按 creation order生产 fresh batch。v2 Outbox UI/enqueue、terminal checkpoint 的 WebView/actor/socket/network/UI 接线、enrollment/refresh/self-revoke、reconnect/backoff、Agent extension/capability advertisement 及真实公网 Relay TLS 集成或互操作证据仍未交付。连接前 strict读取 exact activation Outbox：当前 lineage queryable state进入 query、终态忽略，同 lineage bounded `QUEUED` 留给 fresh producer且不进入 query，foreign/corrupt/overlimit fail closed；status commit 只允许 zero-effect 或本 owner 的 recovered Execute，其他 post-commit effect，以及 terminal/Agent/其他未拥有 effect，都会 typed fail closed，绝不 ACK、丢弃或 fallback 到 v1；`autoConnect=true` 只发起一次连接，false 保持 STOPPED 且不开 socket。不得据此生成 v2 enrollment、宣告 capability、把连接状态描述为 runtime ready、把受限 fresh durable dispatch描述为完整 command runtime、宣告 APK terminal v2 完成。Android JVM、Room migration validation、Lint、APK build、migration device execution 与连接设备验证仍是不同证据；`assembleRelease` 只生成 unsigned 构建验证产物，不代表生产签名、TLS 基础设施、后台通知或渠道发布已经完成。

纯 terminal authority 之上另有一个 default-off、显式调用的 effect adapter foundation。它只认领 `WriteParser`、`ResetParser`、`SendInput` 和 `SendResize`，其余 open/replay/close、ACK、finalize 与 UI effect 保留完整原 effect 返回 `NotOwned`。parser 的 phase、完整 callback token、queue head bytes 与 continuity 授权只由 pure reducer 决定；在调用 platform parser 前，reducer 先把 exact fence/token/head bytes/authorized phase claim 提交到 checkpoint，claim commit 失败不会调用 parser，同一未决 claim 也拒绝第二次注册。parser port 的 `false` 必须证明零 mutation、未注册且 callback 永不调用，但 adapter 仍以本地 admission latch 防守：只有方法返回 `true` 后观察到 `ACCEPTED` 的 callback 才能用 exact claim 进入 reducer；early、late-unaccepted 或竞态中未观察到 acceptance 的 callback 都不改 durable state且不触及 sink，未决 claim 留待 restore fail closed。platform parser 的普通异常以 exact claim 持久化 `PARSER_FAILURE`；`CancellationException` 不得降级为普通 Failed/Unknown，它保留 exact claim/H/A，在当前 apply lease 内先安装 `(authority, terminal key)` admission poison，离开 lease 后再以 `NonCancellable` 撤销 authority admission并原样重抛；cleanup failure 只作为 suppressed error 附着在原取消异常上，不得替换其实例或清除失败 poison。

异步 callback 的完整 effect batch（包括 callback(false) 产生的 `ResetRequired` 与 control ambiguity delta）先随 callback commit 写入阻塞型 handoff marker `H`，再通过覆盖等待和执行全程的真实 per-terminal serial gate 取得 upper sink 的有界 FIFO reservation。任何 callback fatal/取消路径都在持有 keyed gate 时先安装 exact poison；等待 gate 的取消则通过独立 admission monitor 立即 poison，不等待当前 holder 退出。poison 同时覆盖 callback 与 initial parser/control handle，因此后续入口在任何 durable transaction、parser、transport 或 sink 调用前 fail closed。withdraw 与按需 authority-scoped sink teardown 分别 single-flight、各只尝试一次；false poison 后的 late teardown upgrade 不会丢失，只有 withdraw 成功、所需 teardown 成功且所有已入场 user 离开后才清 poison，任一 cleanup 失败则 poison 保留。

adapter 在调用 sink 前生成 reservationId；`reserve(id, batch)` 只返回 sealed `Reserved(identity, handle)` 或能证明从未取得 FIFO/capacity 的 `Rejected`，返回 identity、handle identity 与 batch fingerprint 必须精确一致。reserve throw 即使发生在 partial acquire 之后也先按该 id exact、幂等 abort；identity contract 失配同样 exact abort，并与 unknown reserve 一起触发 authority-scoped sink teardown/rebuild。`Rejected`、throw 或 identity mismatch 都保留 exact `H`、持久收敛为 `RESET_REQUIRED/STREAM_LOST`。callback(false) 产生的 `H` 继续保留原始 `PARSER_FAILURE` batch provenance，即使当前 terminal reason 已因 reservation failure 收敛为 `STREAM_LOST`；该 failed-H 组合可被 restore 校验并消费，但 `ParserEffectsReserved` 仍严格拒绝 reason mismatch，绝不重新 activate。只有 callback token、adapter reservationId 和 batch fingerprint 全部匹配的 durable CAS 才能把 `H` 转成 recovery-only activation marker `A`；`A` 不阻止 batch owner 认领其中的下一项 `WriteParser`，但只允许与该 A callback 的已提交 parser watermark 连续、且与 current queue head 的 token/bytes/phase/fence 完全一致的 Write claim 共存，A clear 后该 claim 继续由 parser callback 独立 settle；reservation 仍只能调用一次 `activate()`。`ACCEPTED` 必须表示全部 effect 已同步完成或转交给 crash-durable/reconstructible owner，单纯放入内存队列不构成 acceptance；只有 exact `A` clear commit 后本次 handoff 才结束。activation `REJECTED`、`UNKNOWN`、throw、clear commit failure或 callback/prepare transaction 的不确定异常都不会重试 activation，也不会在 activation 已尝试后 abort reservation；它们保留 `A`（或未完成阶段的 `H`），以 exact `STREAM_LOST` fail closed。restore 先按原始 stored delivery和原始 callback batch provenance校验 `H`/`A`，再在同一持久 transaction 消耗 marker 与相关 parser proof、按需换绑当前 fresh delivery并写入规范化 `STREAM_LOST`；第二次 restore 仍稳定得到 `STREAM_LOST`，从不重放或重新 activate reservation，因此不会静默丢失或乱序执行 `OutputAck` 与下一项 `WriteParser`。

input/resize 的 socket side effect 不在 Room transaction 内执行：reducer 先把 exact delivery lease、Android-local dispatch attempt、generation、sequence 与 payload 组成一次性 claim 并以 `CLAIMED` 提交，即使目标 record 已有旧 `SENT` disposition 也不提前把新 claim 写成已发送。adapter 在同一个 actor apply lease 内、但在 claim transaction 返回后调用 transport；明确零字节拒绝只释放 exact `CLAIMED`，只有 exact `InputSent`/`ResizeSent` settle 才把 disposition 写成 `SENT` 并把该 claim 推进为 `LOCALLY_SENT`，接受结果不确定则收敛为 `RESET_REQUIRED/STREAM_LOST`。同一 delivery/attempt 重复 offer 不再触及 transport。对同 generation、同 delivery 的显式 `RetryUnackedControls`，reducer 只在 durable transaction 中清除 `SENT+LOCALLY_SENT` 的旧 claim，并随同一次 commit 重新产出 exact effect；input/resize `GAP` redrive 复用同一条 exact 清理规则。`CLAIMED` 无论位于 `QUEUED` 还是 retry 中的旧 `SENT` record，都不会被并发 retry 或迟到的 GAP response 清除。空 claim 槽是一次合并许可，新旧同 payload effect 或多次 retry effect 即使竞争，也只有第一个 claim winner 能到 transport。首次发送的 settle commit 失败会保留 `QUEUED+CLAIMED`，同 delivery 的显式 retry 不会清除它或盲重发；fresh-delivery rebind 才会撤销旧 delivery claim、换绑 lease 并重驱。已经具有 durable `SENT` 证据的 resend 若 settle transaction 失败，则保留 `SENT+CLAIMED` 阻断重复 offer；后续必须先完成确切 settle，或由新的 authority/recovery 决定去留，当前 retry 不能把正在使用的 permission 当成旧 `LOCALLY_SENT` proof 清除。两类重驱都依赖 host 的 generation+sequence+exact payload 去重保证 backend 不重复应用。这里必须区分三种证据：Android claim 只证明本地一次派发授权，host 去重才使同 generation redrive 安全；generation 改变时 input 仍进入 `AMBIGUOUS`，旧 resize 仍丢弃，不能把本地 claim 当作 host acceptance proof。schema v8 持久化 claim phase、attempt cursor、parser handoff `H` 与 activation `A` marker；合法 schema v7 payload 只按显式兼容读取归一为 v8 的无 claim/marker 状态，未知或损坏 schema 继续 fail closed。该 adapter 没有订阅 actor effects，也未接 WebView、xterm、socket、Room production composition、Activity、ViewModel 或 UI，因此不改变上一段的未交付结论，也不能作为 APK terminal v2 已完成或已启用的证据。

storage codec 只把当前 schema v8 的内存模型写回磁盘；schema v7 仅是受控 decode/migration 输入，encode 入口会拒绝非当前 schema，不能生成带 v8 keys 的伪 v7 payload。

Relay v2 不再在本 Android 专题中维护单端 A/B/C 路线。broker、relay-host、Dashboard、Android 和 Agent extension 的并行工作包、硬依赖与验收门槛统一见 [`relay-v2-implementation-plan.md`](relay-v2-implementation-plan.md)；冻结 wire 语义仍以 [`relay-v2-contract.md`](relay-v2-contract.md) 为准。

## 验收门槛

- 外部 Intent/QR 不能自动覆盖现有配对；导入 URL 的错误必须在 pairing review 上立即可见，不能推迟到 Connect。
- Profile 切换取得 exact disconnect receipt 后，六类既有 Room 数据、所有 v2 activation-scoped Outbox/terminal/Agent lifecycle rows、所有 activation/timeline 的 row-oriented Agent transcript/snapshot/LIVE-buffer rows、草稿和终端队列均无残留。
- Wi-Fi/蜂窝/VPN identity 切换可自动恢复。
- 多条 Outbox 乱序 ACK 或单条 reject 不互相污染。
- Relay 不回复时，握手、创建和发送不会永久加载。
- 终端高频输出不静默丢事件，切换会话不串屏。
- 所有核心 CTA、返回、底部导航、抽屉、表单和终端控件可操作。
- 使用当前待发布构建在 390×844 基准视口检查布局、交互与无障碍语义；验收证据必须来自本次构建，不依赖历史原型或临时截图。
