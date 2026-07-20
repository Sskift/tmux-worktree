# Relay Agent transcript、lifecycle 与本地通知 extension v1

状态：**Frozen extension contract + 未接线的 Node durable host authority/public codec/replay runtime、default-off且精确版本栅栏的 Codex app-server structured-event producer、bounded LF notification source、injectable/default-off process-controller lease authority、trusted-source composition与one-shot activation foundations，以及已在隔离模块/Room owner 内部接通的 Android public codec artifact、lifecycle/notification reducer、typed durable operations/repository、row-oriented Room materialization、durable notification claim、read projection与default-off runtime composition seam；production root、真实app-server process contract/implementation、默认advertisement、UI/通知启动仍未接，生产 capability 尚未交付，不得宣告 Agent reply、lifecycle 或 notification capability**

当前 Node 交付包含 contract/machine fixtures、完整消费 accepted authority machine cases 的纯 reducer、独立 public codec、durable authority store，以及只连接这些 extension owner 的 capability-gated replay runtime foundation。store 把 reducer snapshot、source cursor/dedupe、公开 event/replay log 与 pinned cut 放入同一个 optimistic transaction candidate，再在既有跨进程锁内以 expected-current CAS原子发布；retention 使用 host commit time并只裁连续前缀，最终 serialized bytes 在 publish 前执行与读取完全相同的 strict byte/key/node inspection 和完整 restore 校验，snapshot/replay cut 也在持久化前按真实 codec wire bytes 与 JSON limits逐页冻结。因此这些 foundation artifact 与对应专项测试已经存在。

Node store 已把唯一 durable commit 路径接到共享 Relay v2 monotonic/CAS continuity anchor。composition 必须显式注入 rollback-independent authority 与绑定 `(hostId, hostEpoch)` 的 `anchorId`，没有默认实现；anchor checkpoint 的 `stateDigest` 从通过读取侧同等 strict inspection 的 exact durable bytes重算。本地 publish在既有跨进程 store lock内执行 expected-current CAS，只有 exact successor可报告 `swapped`/`already_same`；之后才提交外部 anchor并 ACK。外部 authority缺失、超时、回滚、冲突或要求 reconcile时 foundation fail closed，不能回退本地 witness。state-before-anchor的一代 crash cut可通过外部 anchor恢复，成对回滚旧 state+witness会被外部单调 checkpoint拒绝。因此 manifest 的 foundation事实为 `nodeContinuityAnchorIntegrated=true`、`pairedRollbackClosedAtFoundationBoundary=true`。为兼容现有 consumer保留的 `pairedRollbackClosed=false` 由 `pairedRollbackClosedScope=production-end-to-end` 明确限定；它与 `productionMonotonicAuthorityAdapterIntegrated=false`、`nodeDurabilitySecurityReviewPassed=false`、`nodeRuntimeIntegrated=false` 和 production/G4/capability advertisement 全部为 false共同表示生产接入仍未交付，不能把专项 fake authority证据描述为 production durability交付。

Node 另有独立的 Codex app-server structured-event producer foundation。它默认关闭，只在调用方一次性显式注入 immutable exact `(hostId, hostEpoch, scopeId, sessionId)`、每进程唯一 `sourceEpoch`、`provider=codex-app-server`、`providerVersion=0.144.5`、`schemaVersion=2`、硬 limits 与可选 user-message exact correlation port 后启用。closed decode只接受该版本证据内的 `turn/started`、`item/completed`（`userMessage|agentMessage`）和 `turn/completed`；`userMessage`固定包含`clientId:string|null`，`agentMessage`固定包含`phase`与`memoryCitation`且本slice只接受citation为null。真实started/completed turn payload的`items`必须为空，canonical entry顺序只来自已经串行durable ingest的`item/completed`，终态不得要求或接受payload回显item。delta、reasoning/tool output、未知字段/状态、`interrupted`、identity或容量错误都会 seal。每个 Codex turn严格映射为 source started（仅首次）→ run running → turn running → text entries → turn terminal → run terminal；agent entry的`commandId`固定为null，user entry只接受correlation port的exact结果，failed只发布固定code与null summary。producer只有bounded FIFO、source sequence/dedupe和进程内seal状态，不拥有durable state、capability或route；唯一写调用是现有`RelayAgentTrustedSourceIngressLease`，再进入runtime与durable store/reducer。它未被`relay-host`、HostRuntime、broker或任何production composition构造，也不做capability advertisement；版本升级必须新增显式证据/栅栏，不能放宽当前decoder。

Node 同目录另有独立、未接线的 bounded notification source foundation。它独占一个由controller注入且控制的byte channel，以LF切分原始notification bytes，固定frame上限131072 bytes并限制输入fragment；每个非空frame只以defensive copy按原序交给sink，最多一个sink Promise在途。超限、partial EOF、source/chunk/empty或sink failure都会同步撤回新admission、一次性cancel source并永久seal；`closeAndDrain`先撤admission与cancel source，再等待pump和全部已admit sink，且对callback/cancel重入使用内部continuation避免形成public barrier环。该foundation不解析Codex schema、不认证或spawn进程；当前只由下述隔离process-controller authority桥接到lease，仍无任何production callsite。

Node 同目录现有独立、injectable且default-off的 Codex app-server process-controller authority foundation。公开`issueControlledSourceLease()`不接受binding、H2、source或其他caller authority参数；它最多一次向注入controller claim exact frozen plain-object非敏感binding与单一notification byte source，先用上述bounded source完成exact single-owner claim，再通过已有issuer/receiver为现有trusted composition签发one-shot opaque lease。并发/replay、controller/shape/binding/source claim/lease issue/attach失败都会fail closed并永久seal；关闭只cancel/drain该authority已经claim且尚未转交composition的source，且exactly once。该foundation不构造或消费H2，lease不能替代composition自己的H2映射证据；它也不启动、查找、认证、attest或restart真实Codex app-server，不是production process integration。

Node 同目录另有一个独立、default-off 的 Codex trusted-source composition foundation。它提供的进程内opaque receipt primitive本身不认证进程；上述injectable authority独占exact controller与bounded source，并只为该issuer绑定且已由一个composition独占claim的receiver签发one-shot lease。lease没有公开字段，binding与attach只保存在模块私有identity record；结构相同普通对象、copy、Proxy、replay、foreign issuer或foreign receiver均不能通过。显式一次性`enable`消费该exact receipt后，仍会在attach前核对runtime store owner的host lineage，并用既有canonical resolver的capture/resolve结果检查同一scope/session/backend instance/managed incarnation；该resolver结果的`authorization`必须仍为`evidence_only`，只构成当前H2映射证据，不能由controller-issued identity替代。composition内部为每个lease生成不可由caller注入的安全随机`sourceEpoch`，以固定`codex-app-server` / `0.144.5` / schema 2与有界producer limits启用既有producer后才attach source；同步首个callback也受同一个admission fence。event sink仅复制`Uint8Array` structured notification bytes再交给producer，不解析或猜测事件。close先发布唯一public barrier并同步撤回callback admission，再进入显式source-close phase等待唯一`closeAndDrain` barrier，最后一次性关闭producer并等待已accepted FIFO及ingress；source cleanup内部对`close()`的await/then重入只取得该phase的内部continuation，不与public barrier形成环，外部重复close仍取得同一public barrier。任一步失败仍继续其余清理并永久sealed。它不创建route、capability、broker、relay-host或HostRuntime状态；仓库仍没有真实Codex app-server controller contract/implementation、production app-server ingress或production external continuity backend。

Node 同目录现另有独立、default-off的 `CodexAppServerTrustedSourceActivation` owner，闭合上述两个foundation而不扩张接口。构造只接受controller、`RelayAgentTranscriptLifecycleRuntime`与canonical resource resolver；issuer、receiver、inner authority、trusted composition与opaque lease均由activation私有创建，构造不claim process/source且不调用H2。零参数`activate()`严格one-shot并固定执行controller claim→bounded source claim→lease issue→composition独立H2 `evidence_only`校验→attach，只有attach完成才成功；caller不能注入binding/source/lease/source factory、provider/version/schema、`sourceEpoch`或H2结果。`close()`在controller pending、lease issued未attach、H2 pending、attach中与enabled阶段永久latch；handoff前由authority唯一cancel，handoff后由composition唯一cancel，同一raw source只关闭一次。callback-phase identity continuation使controller、sink/ingress及raw cancel/closeAndDrain内部await activation close不等待自身，外部close仍等待late source、完整source drain与producer/ingress FIFO；任一侧失败仍尝试另一侧，cleanup失败永久sealed且不重试。built activation entry显式复用direct controller与notification-source entries的不可逆进程registry，任一入口先claim后另一入口都失败，close后也不释放identity。该owner没有真实app-server启动、身份认证、PID/version/session验证、signal/reap/restart或跨真实进程continuity语义，也未接任何production composition。

future external authority 的互操作/安全边界另由 frozen [`external-continuity-authority-v1`](../contracts/relay/v2/external-continuity-authority-v1/README.md) 冻结；它不提供 backend或adapter。其future transport固定bounded exact-endpoint POST、no redirect、identity/no compression、双向no-store与status-200-only closed decode；非200或required header mismatch不读取、解析或回显proxy body，workload credential不得redirect转发；当前没有该production adapter。extension固定使用独立 `agent-transcript-lifecycle.v1` namespace、独立anchorId/ACL/reset/decommission/tombstone history，owner binding沿用本extension既有exact `(hostId, hostEpoch)`。它不能覆盖、复用或迁移`broker-credential.v1` record；reset/delete/decommission也不能让旧anchorId回到uninitialized或新history。external internal error不能成为extension public frame error，仍只能经共享continuity port fail closed。该namespace复用现有store mapping：`ANCHOR_UNAVAILABLE|BUSY`映射`AGENT_AUTHORITY_STORE_CONTINUITY_UNAVAILABLE`，`STATE_COMMIT_UNCERTAIN|ANCHOR_COMMIT_UNCERTAIN|RECONCILIATION_REQUIRED`映射`AGENT_AUTHORITY_STORE_COMMIT_UNCERTAIN`，`INVALID_CHECKPOINT|INVALID_AUTHORITY_RESPONSE|LOCAL_STATE_CONFLICT|CAS_CONFLICT|ROLLBACK_DETECTED`映射`AGENT_AUTHORITY_STORE_CORRUPT`。unavailable只关闭extension可用性并保留可证明的timeline/cache lineage，repair/reopen authority不轮换timelineEpoch；commit uncertain保留lineage并reconcile；只有corrupt/明确continuity loss才允许extension reset/new epoch。三类都不得撤回broker credential ready/admission，不得阻止基础v2 Upgrade/route/command/terminal，也不得全局关闭基础v2 connection。

这些 Node 模块仍没有接入基础 `HostRuntime`、`relayHost` 或 broker，也没有进入任何 production composition、capability intersection或 advertisement；`runtimeConsumers=pending`、`nodeRuntimeIntegrated=false`、G4 与 production capability 仍为 false。Codex producer、injectable process-controller authority与composition也仅是default-off trusted-source foundations。它们只能称为**可接线的 host authority foundation**，不能称为远端 Agent reply/lifecycle 已上线。

Android 生产源码已有独立 strict public codec 及其不可由 consumer 自行构造的 codec-issued artifact，以及纯、确定性 lifecycle/notification reducer。隔离 extension 模块通过 typed durable operations 把 public artifact、replay/snapshot page 和 control 输入交给同一个 reducer/Room repository owner；repository 在现有 `RelayV2StateDatabase`/DAO 的单一 transaction 内提交 reducer state、materialized entry/lifecycle/evidence/notification ledger、pinned snapshot staging/records 与 snapshot/gap 期间的 durable LIVE buffer。notification intent 还可在同一 Room owner 内先完成 durable one-shot claim，再向 executor 返回 post-commit ticket。`RelayV2ConnectionActor` 已提供默认关闭、未接 production composition 的 gated runtime seam：可选 capability 只能显式注入且默认为空，只有 host welcome 完成并形成 client/broker/host 三方交集后才路由 extension frame；request-sync coordinator 先经 durable owner 准备 exact request identity，再委托 actor 当前 generation/fence 发送。新增的default-off `AgentTranscriptLifecycleRuntimeComposition`只接收上层显式传入的effect；它不构造或订阅actor，同一个durable repository实例同时装配现有runtime consumer、notification dispatch coordinator与revision-pinned read projection。未协商frame在任何durable访问前返回`ExtensionNotNegotiated`；非Agent effect与`AgentExtensionUnavailable`都以携带完整原effect的`NotOwned`交给upper-layer dispatcher，不折叠其generation、failed request或request admission；只有携带exact failed request/admission identity的unavailable effect才归RequestSync redrive owner。composition构造不启动database、network、actor或platform notification，也不执行notification intent；只有显式handle且通过capability closed gate的Agent frame才会进入consumer。handle中的candidate namespace load本身是只读transaction且不授权mutation；consumer随后取得actor generation apply lease，stale generation不产生mutation，durable mutation transaction再重新load并exact匹配完整namespace。frame commit后，notification coordinator另取generation lease并在claim transaction内再次exact匹配；其间namespace变化按所在阶段closed为persistence conflict或`NAMESPACE_CHANGED`/not-executable，任何失败都不会到达platform。上述 public codec、reducer、typed durable repository、row-oriented materialization、claim、read、actor/request-sync与composition seam 已有相邻 JVM 行为证据。共享 fixture 的 `command_status` 步骤仍由测试中的 base-owner composition stub处理，生产 reducer不拥有基础 command ledger；`AppContainer`/`V2Activity`/`V2ViewModel`/navigation等production root、默认 capability advertisement、Compose UI、通知启动与真实系统 `NotificationManager` executor均未接线，production也不实例化`RelayV2ConnectionActor`或该composition，因此`androidConsumerMachineConformance` 与 G4 仍为 false。

本 extension 是 Relay v2 的可选扩展，规范版本为 `1`，唯一 capability 名称为 `agent.transcript-lifecycle.v1`。它不属于 [`relay-v2-contract.md`](relay-v2-contract.md) 冻结的六项基础能力，也不修改基础 v2 envelope、command ledger、host `eventSeq`、terminal stream 或任何 Relay v1 wire。

本文件定义首个 slice：结构化 user/agent text entry、run/turn lifecycle，以及由已提交 lifecycle event 驱动的 Android 本地通知。以下内容不在本版：

- 原始 terminal transcript 或从 terminal bytes 提取的“回复”；
- tool-call 全文、tool result、reasoning、附件或富媒体；
- 从 `command.status`、`command.result`、terminal ACK、进程退出或本地计时推断 Agent 状态；
- App 被杀、设备长期离线时的远程 push；
- 对基础 v2、Relay v1 或不支持结构化事件的 Agent 做隐式升级或降级。

本文中的 MUST、MUST NOT、SHOULD 按规范性词语理解。所有 ID 都是不透明值，客户端不得解析其结构。

## 1. Authority 与 owner

Agent 事实的唯一上游权威必须是以下之一：

1. Agent SDK 提供的结构化 event/hook；
2. 与精确 session 绑定、受权限保护且按序串行的受控 Agent adapter。

`tw`/relay-host 只能验证、排序、持久化和转发这些结构化事件。terminal 文本、prompt echo、shell exit、command ACK 和静默时长都不是 Agent 事实来源。无法取得结构化来源时，extension 必须显式为 `unavailable`；基础 session、command 和 terminal 能力仍可继续使用。

relay-host 拥有单 host 的 extension authority store：

- 验证 adapter 与 `(hostId, hostEpoch, scopeId, sessionId)` 的精确绑定；
- 持久化 source dedupe、timeline lineage、entry、run/turn transition、replay log 与 retention tombstone；
- 分配 `timelineEpoch`、`agentEventSeq` 和公开 `eventId`；
- 产生 status、snapshot page、replay page 和 live event。

broker 仍是透明 route，不保存或推断 Agent 事实。Android Room 只是按 profile 隔离的持久 consumer/cache，不成为 lifecycle authority。extension store 与基础 v2 host store 是不同 owner；extension store 损坏或丢失只能隔离/重建 `timelineEpoch`，不得改写基础 `hostEpoch`、command ledger、resource revision 或 terminal generation。

## 2. 独立协商与失败隔离

`agent.transcript-lifecycle.v1` 只有同时出现在 client、broker route 和 relay-host 的可选 capability 交集时才可使用。它不得加入基础 v2 的六项 `requiredCapabilities`，基础 v2 完整可用也不意味着支持本 extension。

- 未协商：双方不得发送任何 `agent.*` frame；Android 本地显示 `unavailable / extension_not_negotiated`。
- 已协商但目标 Agent 不支持结构化事件：Android 请求 status，host 明确返回 `support=unavailable` 和固定 reason；不得模拟 timeline。
- 已协商后的 extension store、cursor、snapshot 或 adapter 故障：只返回适用的extension-scoped status/error；只有可信reset或明确continuity loss才发送reset，基础 v2 route、command query、resource snapshot 和 terminal stream 保持独立。
- `agent-transcript-lifecycle.v1` external authority failure必须精确复用`AGENT_AUTHORITY_STORE_CONTINUITY_UNAVAILABLE|AGENT_AUTHORITY_STORE_COMMIT_UNCERTAIN|AGENT_AUTHORITY_STORE_CORRUPT`三类既有store error mapping。unavailable保留可证明lineage并repair/reopen，commit uncertain在原lineage reconcile，只有corrupt允许reset/new epoch；未来composition必须保持broker credential ready/admission以及基础Upgrade/route/command/terminal，禁止启动全局connection close barrier。
- 通用 framing、UTF-8、duplicate JSON key 或基础 envelope 被破坏时仍遵守基础 v2 的 fail-closed 规则；“失败隔离”不授权接受 malformed wire。
- 任一 extension 失败都不得触发 Relay v1 fallback、重发 command、关闭 terminal backend或覆盖基础 Outbox 状态。

本 contract/fixture 存在不构成 capability 实现。只有基础 v2 通过 G3，且 host authority/store、Node/Android codec、Android consumer/notification 行为完成跨端验收后，才可在 G4 宣告该 capability。

## 3. Identity 与 lineage

每条公开记录和 cursor 都绑定：

```text
(profileId on Android, hostId, hostEpoch, scopeId, sessionId, timelineEpoch)
```

- `sessionId` 沿用基础 v2 opaque Session identity；extension 不接受 V1 session name 或显示名。
- `timelineEpoch` 是 relay-host 为该 session 的 Agent store 签发的不透明 lineage。正常 route 重连、broker 重启和可证明连续的 adapter transport 重连不改变它。
- extension store 丢失、回滚、损坏、显式全量删除或无法证明 cursor 连续时必须更换 `timelineEpoch`。这不要求更换基础 `hostEpoch`。
- `sourceEpoch` 标识产生 run/turn/entry 的结构化 source lineage；status 返回当前 activeSourceEpoch，lifecycle snapshot record 显式携带自己的 sourceEpoch。
- `runId` 由 SDK/受控 adapter 提供并由 host 验证，在同一 timelineEpoch 内永不复用。它标识一次结构化 Agent run，并永久绑定创建它的 sourceEpoch。
- `turnId` 在 run 内永不复用，并始终与一个精确 `runId` 绑定。
- `entryId` 在 timelineEpoch 内永不复用。文本相同的两个 entry 仍是两个 entry；禁止按文本 hash 合并。
- `eventId` 由 relay-host 为一次公开 mutation 签发，在 timelineEpoch 内永不复用。
- `agentEventSeq` 由 relay-host 按 session/timelineEpoch 分配，从 `1` 开始严格递增的规范无符号十进制 string。它独立于基础 host `eventSeq`，Agent event 不占用或推进后者。

Node reducer 的 restore API 只负责验证 closed schema、binding/lineage、索引关系、counter/record mirror 和资源 accounting，并把合法 JSON 一次规范化为不可变、index-safe 状态；任意 plain object 不能直接进入 reducer。独立 durable store 在该结构校验之外，以 commitSeq/commitId/parentCommitId、内容 checksum 和本地 continuity witness检查本地 exact/one-ahead crash cut；state、witness、owner 或文件 ownership任一无法闭合时 fail closed。真正的 rollback authority是显式注入、与本地 store不共享回滚域的 Relay v2 monotonic/CAS anchor：它绑定 exact durable-byte digest并拒绝旧 checkpoint、分叉 successor与 paired rollback。本地 witness只辅助修复 state-before-witness窗口，纯 reducer和 witness都不被描述成完整 durability owner。

公开 cursor 是 `(hostEpoch, sessionId, timelineEpoch, agentEventSeq)`。任一 lineage 字段变化都不能沿用旧 cursor、snapshot staging、notification dedupe 或 lifecycle state。

## 4. 上游 source 顺序、重放与 Agent 重启

受控 source 输入不是公共 Relay frame。它必须至少包含：

```json
{
  "sourceEpoch": "agent-source-process-uuid",
  "sourceSeq": "7",
  "sourceEventId": "sdk-event-opaque-id",
  "occurredAtMs": 1783700200000,
  "mutation": {}
}
```

规则：

- 每次真实 Agent SDK/adapter 进程启动生成新的 `sourceEpoch`；同一进程的短 transport 重连保持该值。
- `sourceSeq` 在 sourceEpoch 内从 `1` 严格连续。`source_started` 必须是 seq `1`，后续只接受 `lastSourceSeq+1`。
- source dedupe key 是 `(sessionId, timelineEpoch, sourceEpoch, sourceEventId)`；fingerprint 是完整 closed source event 的 canonical bytes。
- 相同 key/fingerprint 是 exact duplicate：不再次分配 agentEventSeq、不重复 entry、不重复通知。相同 key 不同 fingerprint 是 `source_event_conflict` 并隔离 source。
- 新事件出现 sourceSeq gap 时返回 `source_gap`，不推进 source cursor；adapter 必须先补齐缺口。已经低于 cursor 且没有 dedupe evidence 的事件返回 `source_history_expired`，不能猜测。
- 新 sourceEpoch 成为 active 后，旧 sourceEpoch 的迟到 frame 一律为 `stale_source`；尤其不得用旧进程迟到的 failed/completed 覆盖新 run。
- 真实进程重启不能仅凭相同显示名继续旧 run/turn。只有 SDK/adapter 能保留同一 sourceEpoch 和 durable ordered replay 时才算 transport continuity；否则新 sourceEpoch 必须使用新的 runId。旧非终态 lifecycle 保留为 last-known history，不合成 failed/completed；Android 只有把 record.sourceEpoch 与 status.activeSourceEpoch 匹配后才可称为当前状态，不匹配的一律显示为 interrupted history。
- source disconnect/restart 只能产生结构化 source availability mutation；它不是 run/turn terminal state。

除 `source.started` 外，受控 source 可按同一 `sourceSeq` 顺序发送 closed `source.availability` mutation：`interrupted/source_disconnected` 表示结构化 adapter 已确认断开，`connected/source_restarted` 表示同一 `sourceEpoch` 的短 transport 重连。该 mutation 不读取 timer、process exit、terminal 或 command 状态，不改变任何 run/turn；source interrupted 时其他 domain mutation 必须等待结构化 reconnect 后再继续。

host 必须在一个事务中完成 source dedupe/cursor、领域 transition、公开 mutation、agentEventSeq 和 replay log。无法原子提交时不 ACK source。

## 5. Text entry schema

snapshot 中的 materialized text entry 是 closed object：

```json
{
  "recordType": "text_entry",
  "entryId": "entry-opaque-id",
  "runId": "run-opaque-id",
  "turnId": "turn-opaque-id",
  "role": "user",
  "state": "visible",
  "text": "Please inspect the failure",
  "redactionReason": null,
  "commandId": "base-v2-command-id",
  "createdAtMs": 1783700200000,
  "createdAgentSeq": "4",
  "lastModifiedAgentSeq": "4"
}
```

- role 只能是 `user` 或 `agent`；text 是严格 UTF-8，最多 65536 bytes，允许空字符串但禁止 NUL。
- entry 必须绑定已存在的 run/turn。agent entry 只在 turn=`running` 时追加；user entry 可在 turn=`running` 或 `waiting_for_user` 时追加。终态 turn 不接受新 entry。
- `commandId` 必须显式 nullable。只有 user entry 可以引用基础 v2 commandId；agent entry 必须为 null。该引用只用于 UI correlation，不读取或改写 command ledger。
- `state=visible` 时 text 非 null、redactionReason=null；`state=redacted` 时 text=null、redactionReason 为 `user_request|policy|retention`。
- 同 entryId 的 identical retry 只能通过 source dedupe 收敛。同文本不同 entryId 必须保留为独立 entry；同 entryId 不同内容是 conflict。

公开 mutation 有三种：

- `text_entry.appended`：携带完整 visible entry；`createdAgentSeq` 和 `lastModifiedAgentSeq` 都等于当前 agentEventSeq。
- `entry.redacted`：携带 entryId 和 reason；host 原子清除正文、保留 identity/order metadata，推进 lastModifiedAgentSeq。
- `entry.deleted`：携带 entryId 和 reason=`user_request|policy|retention`；host 从 materialized snapshot 删除 entry 并保存防复活 tombstone。

原始正文不得出现在 redaction/delete mutation、错误、日志或 notification payload 中。

## 6. Run 与 turn lifecycle

run 和 turn 都使用四个状态，但作用域不可互换：

| scope | 状态 | 语义 |
| --- | --- | --- |
| run | `running` | Agent run 已由结构化 source 确认可以处理事件 |
| run | `waiting_for_user` | run 当前明确等待用户输入；不是本地 idle 推断 |
| run | `failed` | 整个 run 已权威失败，最终态 |
| run | `completed` | 整个 run 已权威完成，最终态 |
| turn | `running` | 精确 turn 正在被 Agent 处理 |
| turn | `waiting_for_user` | 精确 turn 明确等待用户补充，可恢复到 running |
| turn | `failed` | 精确 turn 权威失败，最终态 |
| turn | `completed` | 精确 turn 权威完成，最终态 |

合法 transition 对 run/turn 相同：

```text
NEW -> running
running -> waiting_for_user | failed | completed
waiting_for_user -> running | failed | completed
failed/completed -> no transition
```

附加约束：

- turn 的首次 running 需要所属 run 当前为 running；每个 run 同时最多一个非终态 turn。
- run 进入 waiting_for_user 前，活动 turn 必须已 waiting_for_user 或不存在。
- run 进入 failed/completed 前，所有已知 turn 必须已 failed/completed。source crash 不能跳过 turn transition 伪造 run 终态。
- exact source duplicate 不产生新 transition。不同 sourceEventId 重复发送同一终态是 `redundant_terminal`：消费有序 source event但不产生新公开 event。
- failed 与 completed 相互覆盖，或任何终态回到 running/waiting，都是 `terminal_conflict`/`invalid_transition`；不改变当前 state。
- 迟到的旧 sourceEpoch 终态是 `stale_source`；不与当前 source 的 state 比较。

lifecycle snapshot record 是 closed object：

```json
{
  "recordType": "lifecycle",
  "lifecycleEventId": "agent-event-opaque-id",
  "sourceEpoch": "agent-source-process-uuid",
  "scope": "turn",
  "runId": "run-opaque-id",
  "turnId": "turn-opaque-id",
  "state": "completed",
  "failure": null,
  "occurredAtMs": 1783700300000,
  "agentEventSeq": "8"
}
```

sourceEpoch、runId 和 turnId 的 binding 必须与 host authority store 一致。scope=run 时 turnId 必须为 null；scope=turn 时必须非空。state=failed 时 failure 必须是 `{"code":"opaque-stable-code","summary":"redacted-safe summary or null"}`；其他状态 failure 必须为 null。failure summary 最多 1024 UTF-8 bytes，不得包含 terminal dump、tool-call 全文或 secret。

## 7. Public wire

所有 frame 使用基础 v2 strict JSON/envelope 规则，并携带精确 host/session lineage。新增 type 只有：

- `agent.timeline.status.get` / `agent.timeline.status`
- `agent.timeline.snapshot.get` / `agent.timeline.snapshot.page`
- `agent.timeline.replay.get` / `agent.timeline.replay.page`
- `agent.timeline.event`
- `agent.timeline.reset`

### 7.1 Status 与 unsupported Agent

status request payload 是空 object。available response payload：

```json
{
  "capability": "agent.transcript-lifecycle.v1",
  "support": "available",
  "reason": null,
  "liveSource": "connected",
  "activeSourceEpoch": "agent-source-process-uuid",
  "timelineEpoch": "timeline-lineage-uuid",
  "currentAgentSeq": "12",
  "earliestReplaySeq": "5",
  "limits": {
    "maxTextUtf8Bytes": 65536,
    "maxPageRecords": 256,
    "eventReplayRetentionMs": 604800000,
    "snapshotLeaseMs": 300000
  }
}
```

unavailable response 必须把 liveSource 固定为 `absent`，activeSourceEpoch/timelineEpoch/currentAgentSeq/earliestReplaySeq/limits 全部设为 null，reason 只能是：

- `agent_unsupported`
- `session_not_agent_managed`
- `adapter_unavailable`
- `store_unavailable`

support=available 时 activeSourceEpoch 必须非空。`liveSource=interrupted` 表示该 source 的历史仍可读，但它的任何非终态 lifecycle 都是 last-known，不得显示成当前 running。新 source 启动后 activeSourceEpoch 改变，旧 sourceEpoch 的非终态 record 仍只能显示为 interrupted history。未协商 capability 时不得为了返回 unavailable 而发送 extension frame；该状态由 Android 本地确定。

### 7.2 Pinned snapshot page

首次 `agent.timeline.snapshot.get` 使用 `{snapshotRequestId, snapshotId:null, cursor:null, nextPageIndex:0}`。continuation 必须回显原 snapshotRequestId、snapshotId、opaque cursor 和下一连续 page index。

`agent.timeline.snapshot.page` 固定携带：capability、timelineEpoch、snapshotRequestId、snapshotId、pageIndex、isLast、nextCursor、throughAgentSeq、earliestRetainedSeq 和 records。snapshot 是同一 materialized cut 的 destructive projection：

- records 只含 materialized text entry 与 retained lifecycle record，按各自 agent sequence、再按 stable ID 的 UTF-8 bytes 排序；
- redacted entry 只返回 null text；已删除 entry 不返回；
- 所有 page 的 identity/watermark 必须一致，pageIndex 从 0 连续；isLast 与 nextCursor 的 nullability 必须匹配；
- 同 snapshot request/cursor 重试返回同一 page；page 最多 256 records；lease 默认 300000 ms；
- Android 使用按 timelineEpoch/snapshotId 隔离的 Room staging，收齐全部 page 后才原子替换。live seq>throughAgentSeq 的 event 在有界 durable buffer 中等待，不能跨 snapshot 拼接。

首次完整 snapshot 建立 `notificationBaselineAgentSeq=throughAgentSeq`，不得为历史记录批量发通知。

### 7.3 Replay page 与 live event

`agent.timeline.replay.get` 携带 timelineEpoch、稳定 afterAgentSeq、nullable cursor 和 1..256 limit。首次请求 cursor=null；后续 page 回显 host 签发的 opaque cursor。

`agent.timeline.replay.page` 固定携带 capability、timelineEpoch、afterAgentSeq、replayThroughAgentSeq、isLast、nextCursor 和 events。首次 page 捕获稳定 replayThroughAgentSeq；所有 page 只返回 `(afterAgentSeq, replayThroughAgentSeq]` 中按 agentEventSeq 连续排序的 event。空范围允许 events=[]。

live `agent.timeline.event` payload 与 replay item 共用：

```json
{
  "capability": "agent.transcript-lifecycle.v1",
  "timelineEpoch": "timeline-lineage-uuid",
  "agentEventSeq": "8",
  "eventId": "agent-event-opaque-id",
  "occurredAtMs": 1783700300000,
  "mutation": {}
}
```

mutation 是 `text_entry.appended|entry.redacted|entry.deleted|lifecycle.changed|source.availability` 的 closed union。source availability 只含 `state=connected|interrupted`、sourceEpoch 和 nullable reason=`source_disconnected|source_restarted`，不改变 run/turn state。

Android reducer：

- seq=`lastAgentSeq+1`：在一个 Room 事务中幂等应用并推进 cursor；
- seq<=lastAgentSeq：重复/replay，按 eventId/fingerprint 验证后忽略，不重复通知；
- seq>lastAgentSeq+1：停止应用、进入 extension-only RESYNCING，先 replay；cursor 过期或 replay 仍有 gap 时获取 pinned snapshot；
- timelineEpoch 不同：清空该 session 的 extension cache/staging/notification cursor，保留基础 Session/Outbox/terminal 状态，重新取 status/snapshot；
- 同 seq 不同 eventId/fingerprint 是 continuity error，只隔离 extension并要求 snapshot/reset，不能按到达顺序覆盖。

当前独立 Android reducer foundation 还固定以下本地安全语义：

- status/snapshot response 必须匹配本地 request token 与不可逆 generation；`adapter_unavailable`、裸 `store_unavailable`、未协商和 source interrupted 只 fence intent并保留可证明的同 timeline cache，只有可信 `timeline.reset`、新 timelineEpoch 或明确 continuity 丢失才退休旧 lineage；
- trusted snapshot commit 是有界 checkpoint：destructive替换 lifecycle materialization并压缩旧 applied exact-evidence，但同 timeline 已见的 eventId/seq/identity/digest witness永久保留并与 snapshot新增 record合并；witness饱和后 snapshot不能遗忘证据恢复，必须 quarantine并由 authority显式轮换 timeline；
- snapshot lifecycle record 的 agentEventSeq、lifecycleEventId、run/turn/sourceEpoch binding 必须闭合且与仍保留的 event witness一致；live transition先验证完整候选图，再原子推进 cursor/evidence/ledger；
- 本地 `AgentEvent` 输入必须由可信 actor/runtime consumer标记为 `LIVE` 或 `REPLAY`，该 provenance不是 wire字段；LIVE新 seq只接受 CONNECTED active source，REPLAY可补旧 source历史但不把不匹配 activeSourceEpoch 的 record称为当前或用于通知。当前默认关闭的 Android seam只把 strict codec-issued `agent.timeline.event` artifact标记为LIVE，并把 replay/snapshot page经各自 correlated ingress交给 typed durable operation；production composition尚未装配该 seam；
- 后续 resync snapshot不改首次 notification baseline，并保留与 retained record完整 event identity匹配的旧 notification disposition，避免清 ledger后重复 `shown`。单次 snapshot候选超过有界 effect batch时，按稳定顺序只产出有界前缀，并以独立 durable snapshot suppression watermark安全抑制该 cut 的其余历史候选；下一 live seq不被吞掉；
- retired timeline tombstone满额时，只有已通过 request/generation fence 的可信新-lineage status/reset可以建立 compaction checkpoint；临时 unavailable不能触发 compaction，旧 queued response仍因 generation失效。
- local generation到达 canonical uint64上界后所有需要 bump 的 reducer路径都原子返回 continuity conflict且不 wrap；恢复需要未来 repository在断连 barrier后重建 profile-scoped namespace，本 foundation不自行重置持久 generation。

cursor、snapshot、availability 与 timeline lineage 的公开错误使用 §7.5 的 closed extension error code。

### 7.4 Timeline reset

显式全量删除、extension store continuity 丢失或安全重建使用 `agent.timeline.reset`，携带 previousTimelineEpoch、nullable newTimelineEpoch 和 reason=`deleted|store_reset`。它不携带 agentEventSeq，也不改变 hostEpoch：

- deleted：旧 snapshot/replay/cursor立即失效；host 生成空的新 timelineEpoch。
- store_reset：旧数据 fail closed；newTimelineEpoch=null，status 变为 store_unavailable，直到 authority store安全重建。

Android 只清理 extension namespace，不删除基础 Session、command ledger映射或 terminal checkpoint。

### 7.5 Wire error 与 machine disposition namespace

公开 wire 的 extension error code 是 closed set，且只在 capability 已协商后用于 correlated request error；`commandDisposition` 固定为 `not_applicable`：

- `AGENT_TIMELINE_UNAVAILABLE`：status 已表明 unavailable，或 snapshot/replay 请求期间 authority 变为 unavailable。
- `AGENT_CURSOR_EXPIRED`：afterAgentSeq 小于 replay floor。
- `AGENT_CURSOR_AHEAD`：afterAgentSeq 大于 currentAgentSeq。
- `AGENT_SNAPSHOT_EXPIRED`：snapshot lease/cursor 已过期或不存在。
- `AGENT_TIMELINE_EPOCH_MISMATCH`：request 携带的 timelineEpoch 不是当前 lineage；response 不把旧 epoch 数据迁入新 lineage。

基础 envelope/schema malformed 继续使用基础 v2 已定义的 `INVALID_ENVELOPE`，不复制进 extensionErrorCodes。

以下 machine disposition 不是 wire error code：

- relay-host ingestion 的 `invalid_transition`、`terminal_conflict`、`stale_source`、`source_gap` 等只回答受控 SDK/adapter 输入；拒绝项不分配公开 agentEventSeq、不生成 `agent.timeline.event`，也不向 Android发送虚构 error。
- Android 的 `gap_resync`、`continuity_conflict`、`extension_not_active` 等是本地 reducer处置；它们决定 replay/snapshot/unavailable UI，不作为 Relay frame 的 `error.code`。

因此非法终态回退由 authority machine fixture 的 `expect.disposition=invalid_transition|terminal_conflict` 验收，不放入 `invalid-frames.json`，也不凭空增加 `AGENT_INVALID_TRANSITION` wire code。`invalid-frames.json` 只保存能够由 public closed-schema codec直接拒绝的 wire向量。

## 8. Retention、redaction 与 delete

- host.welcome/status 宣告的 `eventReplayRetentionMs` 不得小于 86400000；host 必须至少在该窗口内保留公开 event 与 source dedupe evidence。客户端不使用本地时钟推断可 replay，唯一依据是 earliestReplaySeq 或结构化 error。
- transcript retention 是 host policy。到期必须通过结构化 `entry.redacted` 或 `entry.deleted` 提交并进入 event log；不能只在下一次 snapshot 静默消失。
- redaction 事务必须先销毁/覆盖正文，再发布 redacted mutation。snapshot spool、日志、错误和后续 replay 都不得再包含正文。
- delete tombstone 至少保留到所有可能包含原 append 的 replay event、source dedupe record和 pinned snapshot都到期。期间任何新 source event 使用同 entryId 都必须拒绝，exact old source replay只命中 dedupe，绝不复活。
- Android 按 lastModifiedAgentSeq 应用 redaction/delete；较旧 snapshot page或 replay event不能覆盖较新 tombstone。全量 snapshot提交是 destructive replace，但只在所有 page完整后发生。
- 全 timeline delete 更换 timelineEpoch；旧 epoch 数据不得被新 epoch cursor或同名 run/turn/entry重新关联。

## 9. Command ledger 与 Agent state 互不覆盖

手机发送内容的 `QUEUED/SENDING/ACCEPTED/CONFIRMING/SUCCEEDED/FAILED_FINAL/AMBIGUOUS` 继续只由基础 v2 command ledger/query 驱动。Agent 的 running/waiting/failed/completed 和 text entry 只由本 extension 驱动。

- `send_agent_message` SUCCEEDED 只证明正文/submit 已写入 backend，不证明 Agent 看见、开始处理或回复。
- user text entry 的 nullable commandId 只做 correlation；它不能把 command 状态提升或降级。
- command.status/result 不创建 run、turn 或 entry；Agent lifecycle event 也不能把 AMBIGUOUS command 改成 succeeded。
- Android UI/Room 必须使用独立字段和 reducer；同一界面可以并列显示“已投递”和“Agent waiting”，但不能用一个 enum 覆盖另一个。

## 10. 本地通知

本版只保证 Android 进程正在运行并已经通过 WebSocket/replay/snapshot持久应用 lifecycle event 后的本地通知候选。常驻 socket不是离线 push 证明。

候选规则固定为：

- turn 的 waiting_for_user、failed、completed 是候选；running 不是。
- run 的 failed/completed 只有在该 run 从未有 turn record 时才是启动级 fallback 候选；run waiting_for_user 不单独通知，避免和 turn waiting 重复。
- 初次 snapshot 的 seq<=notificationBaselineAgentSeq 全部静默。之后 live/replay 或 gap snapshot 新发现、且 seq 大于原 durable baseline 的候选可以通知。

notification dedupe key：

```text
(profileId, hostId, hostEpoch, scopeId, sessionId, timelineEpoch, lifecycleEventId, state)
```

Android 必须在尝试系统通知前持久化该 key 与 disposition：`shown|suppressed_permission|suppressed_inactive_profile|suppressed_policy`。duplicate/replay、Activity 重建或进程重启不重复展示；权限拒绝不循环弹请求或重试旧通知。profile 切换后，inactive profile 的事件只能落库并标记 suppressed，不能以当前 profile 身份展示。

当前 reducer 产出不含正文的 system-call intent，并提供 generation、status/source、当前 lifecycle record与完整 event identity 的非消费型 preflight。隔离 Room owner 已实现 durable one-shot claim：只有 claim transaction 提交后才返回 execution ticket，重复、旧 generation/lineage、已失效 intent、损坏 state/claim 或提交失败都不能到达 platform executor；Android notification adapter foundation 也已有定向 emulator 证据。default-off composition seam已把现有runtime consumer的durable post-commit notification effect路由到复用同一repository实例的notification dispatch coordinator；构造composition本身不claim、不执行intent、不调用platform。production root没有实例化该composition，也没有注入真实platform executor或接入`V2ViewModel`/UI、通知启动和系统`NotificationManager`，因此这些 foundation 仍不构成 APK 通知运行能力。

锁屏默认使用 private policy：标题只表达 waiting/failed/completed，正文不包含 entry text、failure summary、cwd、project、session display name或 terminal bytes。只有用户在 Android 本地明确选择更宽松策略后才可使用本地已有的非敏感 label；wire 不携带通知正文模板。

## 11. 固定 limits 与安全边界

- extension frame 继续受基础 v2 1 MiB raw frame、strict UTF-8、closed schema、depth/key/node 和无 compression-bomb 约束；public encode 与 decode 对这些 limits使用同一检查。
- 单 text 最大 65536 UTF-8 bytes，failure summary 最大 1024 bytes。snapshot/replay 每页同时满足最多 256 records/events、1 MiB 完整 wire bytes 与 codec key/node limits；不能先固化一个超限 lease 再在发送时失败。
- 所有 opaque ID 与本地 request token 都必须是 well-formed Unicode、无 NUL/首尾空白且最多 128 UTF-8 bytes；Node public codec与 reducer constructor 分别是 public wire 和 trusted source 的 bounded trust boundary，两者都在构造领域输入前执行该约束。
- host source queue、replay log、snapshot spool、client replay buffer、Room staging 和 notification effect queue都必须有硬上限；饱和时 extension进入 unavailable/resync，不丢单个 event继续推进 cursor。
- 未接线 Node authority foundation 对 sources、source dedupe evidence、runs、turns、entries、delete tombstones、active-turn index 分别执行不可放宽的 production count/canonical-byte budget，并对完整 authority canonical bytes执行总预算；durable store另对 session、公开 log、snapshot/replay cut、tombstone和序列化文件执行硬上限。容量不足时整个事务不提交、不 ACK source，retained exact duplicate仍可命中；测试 override只能缩小预算。
- durable store不按 source `occurredAtMs` 淘汰 evidence。它用单调的 host commit time同时裁 source dedupe与公开 replay的连续前缀；pinned cut在 lease内保持稳定。redaction/delete在同一事务撤销所有可能含旧正文的 pinned snapshot/replay cut并推进 replay floor，authority 内的 used entryId delete tombstone不随 replay/dedupe retention裁剪。
- credential、terminal bytes、tool-call内容和未 redacted 原文不得进入 source错误、Relay日志、通知或 machine fixture。
- `extensions` 之外的未知字段、未知 mutation、null/coercion、非 canonical counter、scope/turnId不匹配和 lifecycle非法组合必须拒绝；不得为了前向兼容静默保存后执行。

### 11.1 当前 Node durable foundation 的边界

实现 owner 限于 `src/relay/extensions/agentTranscriptLifecycle/v1`：

- authority key 固定为 `(hostId, hostEpoch, scopeId, sessionId, timelineEpoch)`；冻结的唯一 ingestion 写路径是 trusted adapter binding → store transaction → reducer → 同事务 authority snapshot/source cursor+dedupe/public event+replay log → exact state durable commit → shared monotonic/CAS anchor commit → ACK。store已接入该 required typed port，并在既有 store lock内做本地 expected-current CAS；但没有 production authority adapter或 composition调用它，所以当前仍不是 production ACK 路径；
- default-off Codex producer是隔离的 trusted-source adapter owner，只接受显式冻结的binding/source/release/schema/limits/correlation并把`0.144.5` schema 2结构化通知串行送入既有`RelayAgentTrustedSourceIngressLease`。exact duplicate复用原sourceSeq且不再写；冲突、乱序、跨thread/turn、未知/超限/饱和与durable reject都会seal，close等待已接受输入的durable ingest。该进程内状态不替代store/reducer，不签发route/capability，也未被production root构造；
- bounded notification source只消费future controller注入的单一byte channel，并以LF framing、131072-byte frame上限、bounded fragment、单一在途sink、同步admission withdrawal、一次性cancel与幂等drain形成`CodexControlledSourceSubscription`兼容边界。它不读取Codex schema、不认证或spawn进程、不签lease，且没有production callsite；
- injectable/default-off process-controller authority公开issue不接收任何caller binding、source、H2或authority参数，只向注入controller claim一次exact frozen plain binding与byte source；它用bounded source完成single-owner claim后，经现有exact issuer/receiver最多签发一次one-shot opaque lease。controller/shape/binding/source claim/issue/attach失败永久seal，只exactly-once drain自身已claim且未转交的source；它不启动、发现、认证、attest或supervise真实Codex进程，也不构造H2；
- default-off Codex trusted-source composition只接受上述authority为该composition独占receiver签发的one-shot opaque process lease；本地receipt primitive不认证进程，structural/copy/Proxy/replay/foreign issuer或receiver都fail closed。composition在attach前交叉检查store owner与H2 canonical resolver的`evidence_only`映射，内部生成每lease安全随机`sourceEpoch`，先enable producer再attach，并按发布唯一public close barrier与撤admission → 显式source-close phase → producer/ingress一次性drain顺序关闭；source `closeAndDrain`内部await/then重入close不会与public barrier成环。严格binding、provider/schema、attach或barrier错误仍执行剩余cleanup并sealed；H2 evidence不构成process authority且不能被controller lease替代，本模块也不是app-server ingress、external continuity backend或production composition；
- default-off Codex app-server trusted-source activation只接受controller、既有runtime与canonical resolver，私有拥有issuer/receiver/inner authority/composition/lease并以零参数one-shot `activate()`完成固定handoff；构造不claim process/source、不访问H2，caller不能提供binding/source/source factory/lease/`sourceEpoch`/provider/version/schema或H2结果。其联合close在全部activation阶段latch，handoff前后分别只让authority或composition拥有raw cancel，并用callback-phase continuation避免内部close self-wait；外部barrier仍等待late source、source drain与producer/ingress FIFO，cleanup failure永久sealed且exactly once。built entry与direct controller/source entry共享不可逆registry。它不启动、认证或管理真实app-server进程，也不形成production runtime/capability；
- external anchor provisioning固定使用`agent-transcript-lifecycle.v1` namespace与owner-bound `(hostId, hostEpoch)`，并与broker credential anchor的anchorId、ACL和terminal lifecycle完全隔离；当前只有future contract与fixture，没有真实provisioning/backend/transport或灾备实现；
- 该external namespace的continuity error只允许按现有store mapping闭合为`AGENT_AUTHORITY_STORE_CONTINUITY_UNAVAILABLE`、`AGENT_AUTHORITY_STORE_COMMIT_UNCERTAIN`或`AGENT_AUTHORITY_STORE_CORRUPT`。unavailable只能保留可证明timeline/cache lineage并repair/reopen authority；commit uncertain保留lineage并reconcile；只有corrupt/明确continuity loss才explicit reset并生成新timelineEpoch。基础broker credential readiness、route/command/terminal与既有基础v2 connection不受其fence。当前没有实现该production isolation composition；
- store 默认把 0600 state 放在 `~/.tmux-worktree/relay-agent-transcript-lifecycle-v1/`，并写一个 0600 本地 continuity witness；相关目录/锁为 0700，逐层创建目录时 fsync每个 parent，写入使用同目录 temp、file fsync、rename和directory fsync。本地 witness只用于 crash cut，不是独立 rollback anchor；
- replay只读取 committed public log。首次请求持久化 `replayThroughAgentSeq`，continuation cursor按 principal、client和完整 authority lineage解析；floor、ahead、epoch与 snapshot expiry返回冻结的 extension error；
- runtime为独立 typed composition foundation，只标记内部 `LIVE`/`REPLAY` provenance并生成冻结 public frame；它不注册到 production route、不改变基础六项 capability、不持有 broker状态，也不接 Android/UI。

## 12. G4 接入验收边界

本 contract slice 本身只冻结互操作语义。Codex路径的production owner还必须在现有injectable authority之上提供真实app-server controller contract/implementation，认证精确进程并返回exact frozen lease binding与受控byte source；再由本composition为该lease生成每进程唯一`sourceEpoch`。同时还须按实际shipping release显式选择provider/schema栅栏、接入真实disconnect/close barrier，并与production capability intersection/advertisement共同验收。生产接入至少还需要：

1. 按 external continuity authority v1 contract交付真正 rollback-independent、linearizable、已确认CAS RPO=0的production backend/adapter与稳定`anchorId` provisioning/ACL；使用独立`agent-transcript-lifecycle.v1` namespace和`(hostId, hostEpoch)` owner binding，验证restart/旧备份拒绝serving/failover high-water/reset/decommission/tombstone，且不复用`broker-credential.v1` anchor；G3后才可在真实relay-host composition显式注入，并交付真实Codex app-server controller contract/implementation、结构化SDK/adapter认证、app-server ingress、disconnect barrier与production capability intersection/advertisement；
2. 在production root显式实例化并连接已有且默认关闭的 Android `RelayV2ConnectionActor`/request-sync/typed durable operation/runtime composition seam；upper layer必须逐个交付effect，不能让composition另起collector。随后与 Node共同完成真实 route capability intersection/advertisement 验收，保证未协商时双方不发送 agent frame；
3. 把已有 Android reducer、row-oriented Room materialization、durable notification claim、executor 与 platform adapter foundations 接入 `V2ViewModel`/Compose unsupported UI、通知启动和系统 `NotificationManager` 运行链，注入真实platform executor并完成 permission/lock-screen/profile 隔离的 production 验收；
4. 重复、source gap、公开 event gap、断线 replay、Agent重启、旧 source迟到终态、redaction/delete和store reset的跨端故障注入；另注入`agent-transcript-lifecycle.v1` external authority unavailable/BUSY、commit uncertain/reconcile-required与invalid/conflict/rollback，证明三组分别使用既有`AGENT_AUTHORITY_STORE_*` mapping且只隔离extension；unavailable不能reset或换epoch，只有独立corrupt case可reset/new epoch，基础credential、Upgrade/route、command、terminal与既有connection继续；
5. 真实结构化 SDK/hook或受控 adapter证据。terminal文本、command ACK和计时测试不能替代。

在这些验收完成前，当前产品仍不支持 Agent 入站 reply、Waiting/Failed/Completed 或相关通知。
