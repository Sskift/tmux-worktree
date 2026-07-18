# Android Compose UI V2 产品与架构

## 当前边界

本文中的 **V2** 指第二代 Android 产品界面和客户端架构，即 Compose UI、`V2Activity` 与 `V2ViewModel`；它不代表 Relay v2。当前 Android、Dashboard、`relay-server` 和 `relay-host` 的运行路径仍只实现 Relay v1。Android 已有独立 Relay v2 strict codec，以及使用 v2 profile/credential、fakeable transport/clock、串行 socket ownership、双代际 fence、握手 watchdog 和显式 query/resync/reject effect 的 `RelayV2ConnectionActor` seam；其默认 action queue 为 64 个普通槽、8 个保留控制槽和 1 MiB raw UTF-8 byte budget，effect queue 为 32 项和 1 MiB raw UTF-8 byte budget。Android 还已有未接线的独立 `tw_mobile_relay_v2_state.db`/repository foundation。数据库 version 5 通过显式 `MIGRATION_1_2`、`MIGRATION_2_3`、`MIGRATION_3_4`、`MIGRATION_4_5` 保留原有六张 state-sync 表、version 2 新增的 Outbox/terminal 表、version 4 新增的 Agent lifecycle state/notification claim表，并在 version 5 加入独立 row-oriented Agent materialized entry、snapshot staging header/records与 snapshot/gap 期间的 durable LIVE buffer；4→5 只创建表、index、constraint，不解析、回填或改写旧 payload/row。version 3 在 authority row 上加入原子 snapshot release journal，持久保存旧 cut identity、durable cursor、release reason 与 ACK 后动作，partial/未知 journal 读取 fail closed。state-sync 表按 `profileId+principalId+clientInstanceId+hostId+hostEpoch` 隔离 authority、Scope、opaque Session、snapshot metadata/records 和 durable event buffer，支持 welcome required watermark、pinned cut 流式 staging、连续 event 合并及单事务 commit/discard/release-CAS。独立 recovery repository adapter foundation 只在 actor apply lease 下把这些 durable result 转成 exact receipt；它尚未接入 production composition，因此不宣告 Relay v2 capability。Outbox meta/entry 表按 `profileId+profileActivationGeneration+principalId+clientInstanceId` 隔离 authority，entry 另以 `hostId+expectedHostEpoch+commandId` 定位并显式保存稳定 creation order；terminal checkpoint 表以 SendOpen 前已稳定的完整 target（包含客户端生成的 `streamId` 与 pane）为整行主键。三类 versioned canonical payload 都显式保存 UTF-8 byte count 与 SHA-256，读取时依次执行上限、实际 byte count、digest 和 strict roundtrip 校验。该数据库不复用或原地升级 v1 profile/session/Outbox/stream rows，也不保存 access、refresh、enrollment、resume token 值或其他敏感 credential material；terminal 涉及 resume credential 时只保存非敏感 Keystore reference/fingerprint。snapshot 每块最多 256 records/512 KiB canonical bytes，完整 cut 最多 100000 records/256 MiB canonical bytes，staged raw UTF-8 最多 512 MiB；RESYNC event buffer 最多 4096 条/16 MiB。这些是每个 state namespace 的硬上限。

Android 还包含未接线的纯 Relay v2 Outbox authority core foundation。它绑定 profile/principal/host lineage、dedupe window、command、operation、opaque Scope/Session 与 canonical request fingerprint，输出不可变 state、原子 mutation plan 和 typed effect。独立 Room repository 是这些事实的唯一持久写入口：同一 transaction 内 load、strict decode/restore、pure reduce、按 plan 写 meta/entries，commit 后调用者才可处理 effect；`AtomicReissue` 的原 entry replacement、新 entry 与 creation cursor 因而原子提交。损坏或未知 Outbox namespace fail closed，不会当作空队列自动重发。该路径仍未接入 actor、`V2ViewModel`、UI、network 或 composition root，因此不改变 APK 当前只运行 Relay v1 的事实。

repository 必须在 actor-owned apply lease 内完成代际 effect 的整个 Room transaction；state `matchesGeneration` 只是非原子的代际预筛，不拥有 phase authority，也不能构成 disconnect/profile-switch barrier。切换时 actor 会先原子禁止旧代际取得新 lease，再等待已经进入的旧事务完成；repository 的 profile cleanup API 只接受该 v2 profile 的 exact disconnect receipt，并在一个 transaction 中删除原有六张 state-sync 表的数据、该 profile 的所有 activation-scoped Outbox/terminal、Agent lifecycle/notification rows，以及所有 activation/timeline 下的 row-oriented Agent transcript/snapshot/LIVE-buffer rows。Android 也已有未接 production composition 的 OkHttp HTTPS credential foundation：redeem/refresh 严格使用 HTTPS、精确 path、现有 closed codec schema 和单次 HTTP/1.1 exchange；另有未接线的 bounded RFC6455 WSS adapter foundation，以系统 trust 和 RFC2818 hostname verification 建立单次 HTTP/1.1 Upgrade，在读取或分配 payload 前执行 1 MiB frame/fragment 累计限界，并拒绝 extension negotiation。该 actor/profile seam、Room repository 与两类 adapter foundation 仍未接入 composition root，也没有真实设备或公网 Relay TLS 互操作证据；contract 已定义但当前 exchange interface 未包含的 self-revoke 也尚未接线。它们与 Node codec 共同消费冻结 fixture 或按冻结契约建模，但不表示已达到 runtime 互操作、capability advertisement 或生产可用状态。

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

独立的纯 Relay v2 Outbox core 已按冻结契约建模发送、接受、确认查询、权威终态、结构化 `not_accepted` 重试/换号、host epoch 变化和 late final。它只依据权威 lineage 与 closed result fields 决策；客户端时间和 human-readable message 不授权自动重发。`AMBIGUOUS` / `REISSUED` 不进入自动发送，相同完整 identity 的 mutation/create lane 分别调度，容量失败保留原 state 且不产生部分换号。独立 Room repository 已提供该 authority 的持久 owner，但仍未接入 actor、network、UI 或其他生产运行路径。

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

当前源码已实现 Compose 信息架构、Room/DataStore/Keystore 持久层、Relay v1 actor、每会话串行 Outbox、配对切换 barrier、分维快照、终端恢复、二维码 review、WSS 校验，以及尚未接入生产运行路径的 Relay v2 codec conformance、独立 actor/profile seam、Room state-sync repository、纯 Outbox authority及其 Room 持久 owner、OkHttp HTTPS credential adapter、bounded RFC6455 WSS adapter、纯 terminal checkpoint/reducer及其 Room 持久 owner，以及 Agent row-oriented Room v5 storage/entity/DAO/profile-cleanup foundations。Agent Room foundation 尚未接 transcript reducer、public extension codec消费链、production transcript repository/actor/composition、UI/notification或capability；AppContainer、V2ViewModel、Android production repository 与 composition root 仍未交付且只装配 v1。v2 Outbox 的 actor/runtime/UI/network 接线、terminal checkpoint 的 WebView/actor/socket/network/UI 接线、enrollment 与 capability advertisement 及真实 Room/device/公网 Relay TLS 集成或互操作证据也尚未交付。不得据此生成 v2 enrollment、宣告 capability、自动连接 v2 profile、描述为 runtime ready 或宣告 APK terminal v2 完成。Android JVM、Room migration validation、Lint、APK build、migration device execution 与连接设备验证仍是不同证据；`assembleRelease` 只生成 unsigned 构建验证产物，不代表生产签名、TLS 基础设施、后台通知或渠道发布已经完成。

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
