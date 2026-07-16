# Relay Agent transcript、lifecycle 与本地通知 extension v1

状态：**Frozen extension contract + 未接线的 Node durable host authority/public codec/replay runtime 与 Android lifecycle/notification reducer foundations；生产 capability 尚未交付，不得宣告 Agent reply、lifecycle 或 notification capability**

当前 Node 交付包含 contract/machine fixtures、完整消费 accepted authority machine cases 的纯 reducer、独立 public codec、durable authority store，以及只连接这些 extension owner 的 capability-gated replay runtime foundation。store 把 reducer snapshot、source cursor/dedupe、公开 event/replay log 与 pinned cut 放入同一持锁事务；retention 使用 host commit time并只裁连续前缀，最终 serialized bytes 在 publish 前执行与读取完全相同的 strict byte/key/node inspection 和完整 restore 校验，snapshot/replay cut 也在持久化前按真实 codec wire bytes 与 JSON limits逐页冻结。因此这些 foundation artifact 与对应专项测试已经存在。

当前本地 state 与 continuity witness 只覆盖损坏、ownership 和 state 已发布但 witness 落后一代的 crash cut。二者仍位于同一用户存储域，成对恢复旧 state+witness 会得到 exact match，不能充当独立 rollback guarantee；共享 Relay v2 monotonic/CAS continuity anchor 尚未接入。`nodeContinuityAnchorIntegrated=false`、`nodeDurabilitySecurityReviewPassed=false`、`pairedRollbackClosed=false`，因此 standalone store 的返回值不得被接成 production source ACK，也不得把当前 artifact 描述为已通过完整 durability security review。

这些 Node 模块仍没有接入基础 `HostRuntime`、`relayHost` 或 broker，也没有进入任何 production composition/adapter、capability intersection或 advertisement；`runtimeConsumers=pending`、`nodeRuntimeIntegrated=false`、G4 与 production capability 仍为 false。它们只能称为**可接线的 host authority foundation**，不能称为远端 Agent reply/lifecycle 已上线。

Android 生产源码另有一个独立、纯、确定性、可持久化友好的 lifecycle/notification reducer foundation，并由专项 JVM test 直接消费完整 `client-machine-cases.json`。共享 fixture 的 `command_status` 步骤由测试中的 base-owner composition stub处理，生产 reducer不拥有基础 command ledger，因此尚不存在 production composition consumer，`androidConsumerMachineConformance` 仍为 false；单独的 reducer fixture conformance不构成 runtime conformance。它没有接入 public extension codec、Room schema/DAO、repository、Relay actor/OkHttp、V2ViewModel/Compose、Android `NotificationManager` 或 capability negotiation/advertisement；Android codec conformance 与所有 runtime wiring 仍 pending，G4 尚未通过。

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
- 已协商后的 extension store、cursor、snapshot 或 adapter 故障：只返回 extension-scoped status/error/reset，基础 v2 route、command query、resource snapshot 和 terminal stream 保持独立。
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

Node reducer 的 restore API 只负责验证 closed schema、binding/lineage、索引关系、counter/record mirror 和资源 accounting，并把合法 JSON 一次规范化为不可变、index-safe 状态；任意 plain object 不能直接进入 reducer。独立 durable store 在该结构校验之外，以 commitSeq/commitId/parentCommitId、内容 checksum 和本地 continuity witness验证精确 one-ahead crash cut；state、witness、owner 或文件 ownership任一无法闭合时 fail closed。但本地 witness 与 state 的成对回滚仍可 exact match，只有未来接入不由该 store 自行创建、具有单调/CAS 语义的共享 Relay v2 continuity anchor 后，才能证明旧 snapshot 回滚。纯 reducer和当前本地 witness都不被描述成完整 durability owner。

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
- 本地 `AgentEvent` 输入必须由未来可信 actor/adapter标记为 `LIVE` 或 `REPLAY`，该 provenance不是 wire字段；LIVE新 seq只接受 CONNECTED active source，REPLAY可补旧 source历史但不把不匹配 activeSourceEpoch 的 record称为当前或用于通知。当前 foundation尚未接入能可信区分 `agent.timeline.event` 与 replay page的 adapter；
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

当前 reducer 只产出不含正文的 system-call intent，并提供 generation、status/source、当前 lifecycle record与完整 event identity 的**非消费型 preflight**。它不实现 one-shot claim；未来 Room/系统通知 executor 必须在调用 `NotificationManager` 前以持久事务原子 claim，不能把重复 preflight=true 描述成防重放证明。

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

- authority key 固定为 `(hostId, hostEpoch, scopeId, sessionId, timelineEpoch)`；冻结的唯一 ingestion 写路径是 trusted adapter binding → store transaction → reducer → 同事务 authority snapshot/source cursor+dedupe/public event+replay log → exact state durable commit → shared monotonic/CAS anchor commit → ACK。当前 standalone module尚未接入最后一个 shared anchor port，所以不得作为 production ACK 路径；
- store 默认把 0600 state 放在 `~/.tmux-worktree/relay-agent-transcript-lifecycle-v1/`，并写一个 0600 本地 continuity witness；相关目录/锁为 0700，逐层创建目录时 fsync每个 parent，写入使用同目录 temp、file fsync、rename和directory fsync。本地 witness只用于 crash cut，不是独立 rollback anchor；
- replay只读取 committed public log。首次请求持久化 `replayThroughAgentSeq`，continuation cursor按 principal、client和完整 authority lineage解析；floor、ahead、epoch与 snapshot expiry返回冻结的 extension error；
- runtime为独立 typed composition foundation，只标记内部 `LIVE`/`REPLAY` provenance并生成冻结 public frame；它不注册到 production route、不改变基础六项 capability、不持有 broker状态，也不接 Android/UI。

## 12. G4 接入验收边界

本 contract slice 本身只冻结互操作语义。生产接入至少还需要：

1. 先把 Node store接入共享 Relay v2 monotonic/CAS continuity anchor并通过 state+witness 成对回滚故障注入；G3 后再接入真实 relay-host composition，并交付结构化 SDK/adapter认证、disconnect barrier与 production capability intersection/advertisement；
2. 完成 Android 独立 public codec并与 Node共同消费 extension fixture，且未协商时双方不发送 agent frame；
3. 把现有独立 Android reducer foundation 接入独立 Room namespace、public codec/actor、unsupported UI，以及 durable notification claim/permission/lock-screen/profile隔离；
4. 重复、source gap、公开 event gap、断线 replay、Agent重启、旧 source迟到终态、redaction/delete和store reset的跨端故障注入；
5. 真实结构化 SDK/hook或受控 adapter证据。terminal文本、command ACK和计时测试不能替代。

在这些验收完成前，当前产品仍不支持 Agent 入站 reply、Waiting/Failed/Completed 或相关通知。
