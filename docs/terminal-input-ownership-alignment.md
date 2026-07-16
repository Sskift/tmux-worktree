# Terminal Input Ownership Alignment

状态：**跨 Feishu Bridge、Dashboard、TW 本地运行时和 Relay 的架构对齐说明；本地 terminal-control v1、Feishu Bridge、Relay v1、Dashboard、`tw serve` 和受控 CLI adapter 已实现；不修改 Relay v1/v2 wire contract。**

本文记录不同产品共同操作一个 TW-managed terminal 时的输入所有权边界。它是 [`relay-v2-contract.md`](relay-v2-contract.md) 的非规范性 companion，也是已实现的本地 terminal-control、Feishu Bridge 和各输入 adapter，以及未来 Relay v2 adapter 的共同边界说明。

本文不把 Feishu Bridge 合并进 Relay。二者不共享传输、鉴权、credential、配对、broker、消息 envelope 或业务协议；它们只共享同一个 canonical terminal target 和同一个本地输入所有权裁决结果。

当前实现位于 `contracts/terminal-control/v1/`、`src/terminalControl/`、`contracts/feishu-bridge/v1/`、Feishu Bridge daemon、Relay v1 relay-host adapter、Dashboard Tauri PTY adapter、`tw serve` 和受控 `tw attach`。Dashboard 的本机和 SSH managed terminal 都使用目标主机的 controller；SSH attachment 本身保持只读，目标主机缺少兼容 controller 时写入和 destructive lifecycle fail closed。Android Relay v1 只会在 Feishu 独占或 controller continuity 异常时通过现有 `error.message` 收到 ownership 拒绝并进入只读；它不会和 Dashboard 或其他 APK 竞争 interactive lease。Relay v2 runtime 尚未交付，因此本文中的 v2 行为仍是其未来 backend adapter 的实现要求，不能被描述为当前 capability。

## 1. 对齐结论

1. 独立的 local terminal-control plane 是每个受支持 terminal 的唯一 `InputOwnershipLease` authority。
2. terminal-control plane 随本地 TW runtime 交付，但不属于冻结的 `tw rpc v1`，不把 lease 写进 `~/.tmux-worktree/state.json`，也不接管 managed worktree/tmux lifecycle。
3. Relay v2 的 `RelayStreamAttachmentLease` 仍由 relay-host 的 process-scoped terminal manager 持有；它只管理 Android stream 的 generation、ring、route rebind 和短断线恢复，不授予跨产品输入权。
4. `FeishuAwaitingTurn` 仍由 Feishu Bridge 持有；它只关联一条群消息、output cursor、回复 attempt 和 deadline，不是 terminal lease。
5. Dashboard、受控本地 CLI、Feishu、Relay v1 和 Relay v2 的所有产品级真实写路径都必须进入同一个 target-scoped single writer，由它在写 backend 的同一 critical section 内校验 lease 和 fence。
   Dashboard 的 tmux 历史滚动也属于真实输入，必须使用 authority 内的 `input.scroll` 语义操作；受控附件不得把 SGR mouse 字节作为 `input.raw` 直接注入 pane，因为这会绕过 tmux client 的鼠标解析。
6. Input ownership 只分两类：Feishu 是独占类；Dashboard、APK/Relay、受控 CLI 和 `tw serve` 都属于共享 interactive 类。interactive producer 共享同一 lease/fence，彼此不触发 takeover 或只读。
7. 直接执行 `tmux attach`、`tmux send-keys` 或其他绕过 TW 产品入口的本地管理员操作是明确的 privileged bypass，不在产品级排他保证内，也不能被 UI 描述为已受保护。

## 2. 权威和产品边界

### 2.1 Local terminal-control plane

terminal-control plane 负责：

- 解析并验证 `controlTargetId` 对应一次仍然存在的 TW-managed backend lifecycle。
- 保存 Feishu/interactive ownership class、共享 leaseId、control epoch、单调 fence 和 handoff 状态；producer instance identity 只用于 operation 去重、审计和 adapter 生命周期，不把 interactive producer 彼此变成竞争 owner。
- 签发有界 TTL 的 lease；producer 必须定期 `lease.renew`。任一 interactive acquire/renew 都延长同一共享 lease；某个 interactive producer release 只丢弃自己的 lease view，不推进 fence，也不影响仍登记的 producer；最后一个 producer 正常 release 时立即重建 output capture 并回到 `FREE`。若 producer 异常退出，无人续租且无 in-flight/handoff 的 interactive `HELD` lease 可在旧 lease 已 fencing、exact backend 已复核且 output capture 已换代重建后安全回到 `FREE`。Feishu、`DRAINING`、已接受/不确定 operation 的 lease 过期或 controller 重启仍进入 `RECOVERY_REQUIRED`。
- 串行执行 terminal input、paste、Agent message body/submit 和会影响 backend 的 resize。
- 在同一 daemon 内维护有界、只读的 output capture，并用 `controlEpoch + outputGeneration + cursor` 关联 input 之后的 Feishu marker 输出；该 capture 不是可见 PTY/tmux scrollback，该 observation 也不授予 input ownership。每个 generation 使用两个各 4 MiB 的 segment，cursor 是跨 segment 单调递增的绝对 byte offset，滚动后通常保留最近约 4–8 MiB。Bridge 落后于 retention floor 时，只有重新证明同一 Feishu lease/fence/control epoch/output generation 后，才能从保证保留的 4 MiB 起点清空并重建 marker parser；不得重放 input。
- 使 lease 校验和 backend write 成为不可分割的控制层操作，禁止 adapter 采用“先查询、再自行写 tmux”的 TOCTOU 路径。
- 在 target 消失、状态连续性不明或 Feishu/interactive class 冲突时 fail closed。

当前实现使用单独版本化的 local contract、权限受保护的 Unix-domain socket、独立的 0600 状态库和有界的 0600 output generation 文件。Feishu turn adapter只持有已返回的 correlation tuple和解析进度，不另建 output authority；Dashboard/Relay 自己的 stream observation也不能提升为 input owner。cursor 落在已淘汰 segment 之前时，authority 返回 `STALE_OUTPUT_CURSOR`，而不是把 target 转成 `RECOVERY_REQUIRED`；该 observation 失败不锁 session，也不能被 adapter 当成授权重放输入的信号。binding、Relay credential、TW managed state 和 terminal-control state 不得相互冒充。

### 2.2 TW managed core

`src/session.ts`、`src/state.ts` 和 TW RPC 继续拥有 managed lifecycle。terminal-control plane 可以查询它们来验证目标，但不得：

- 在 controller 中实现第二套 worktree/tmux creator。
- 把短期 lease 混入 managed runtime state。
- 修改冻结的 `tw rpc v1` 来承载 input、output tail 或 ownership。
- 因 controller 不可用而回退到 direct tmux write。

### 2.3 Feishu Bridge

Feishu Bridge 拥有 Lark event 消费、群 binding、群成员精确 @Bot 触发策略、event dedup、单个 awaiting turn、`[[notify-group]]` 提取、Card JSON 2.0 回复位置和相关审计。每个 binding 持久化 `replyMode=topic|direct`：默认 `topic` 使用源消息话题，`direct` 仍回复源消息但不进入话题；两者不得互相 fallback，旧 binding 缺字段时归一化为 `topic`。该配置由 Bridge 的串行 mutation 修改，active turn 存在时拒绝修改，避免同一轮的出站位置在执行中变化。Dashboard 的正常绑定把空 `allowedSenderIds` 解释为同群任意真实用户，不要求用户填写管理员 Open ID；显式非空列表仅保留给兼容 CLI 调用。Bot/self、非用户事件和未精确 @Bot 的消息仍被过滤。处理中的 `Typing` 及确定失败时的 `CrossMark` 是 best-effort reaction，不得改变 terminal lease、turn 或 outbound reply 的确定性。Bridge 必须通过 terminal-control plane 取得 lease 和发送输入，不能保存或裁决全局 lease，也不能调用 Relay transport。

Feishu Bridge 是共享的本地 daemon。Dashboard 可以在首次管理 binding 时按需启动它，但 Dashboard 退出不得停止 daemon、释放 Feishu lease 或把 active binding 隐式改成 paused；daemon 的显式停止、崩溃和重启分别按 shutdown/recovery 规则处理，不能伪装成用户 handoff。

Dashboard 的 Integrations 页面只持久化非敏感 `lark-cli` profile 名称；它既可选择已有 profile，也可把新 Bot identity 的 app secret 一次性经 stdin 交给 `lark-cli` 创建 profile。app secret、token 和 user authorization 始终由 `lark-cli` 管理，不能进入 Dashboard 配置、命令参数或日志。Bridge profile 切换不是 handoff：本地 `bridge.shutdown` 管理操作只在 binding 和 active turn 均为空时成立，随后 Bridge 以显式 `--lark-profile` 和 bot identity 重启；存在 binding 时必须拒绝，不能让绑定静默换 bot。

### 2.4 Relay v1/v2

- Relay v1 保持 legacy-frozen wire，只在 relay-host 内部增加 controller adapter；不增加 status、takeover、error code 或 input ACK 字段。
- managed single-pane 在 terminal-control 边界内只有逻辑 pane `"0"`。tmux 的物理 `pane_index`（可以因 `pane-base-index` 从 `1` 开始）只用于本地/SSH attach 选 pane；Relay raw/agent-message adapter 不得把它作为 `input.raw` 或 `input.agent-message` 的逻辑 pane，Relay v1 attachment resize不进入terminal-control。
- Relay v2 继续拥有 twcap2、carrier、command ledger、snapshot/eventSeq、terminal stream generation、inputSeq、ring 和 detached lease。relay-host 在最终 backend write 前调用 controller，但 broker 永不感知或裁决本地 ownership。
- Relay v2 public `sessionId` 和 terminal-control `controlTargetId` 是不同 namespace，只在 relay-host 内部映射。

### 2.5 Dashboard 和本地 CLI

React 只能通过 `DashboardBackend` 使用 binding/ownership 能力；Tauri adapter 和受控 CLI attach 调用 terminal-control plane。Dashboard 不能直接编辑 bridge/controller 文件。Dashboard PTY 可以保持 output observation，但 mount/status 不取得 lease；首个真实 input 在 authority 内 lazy-acquire shared interactive lease。非活动 PTY release 只清除该 attachment 的 lease view，不影响其他 Dashboard 或 APK。write、paste 和 backend resize 仍必须携带当前 lease/fence。

## 3. 三类独立状态

| 状态 | Owner | Scope | 可以证明 | 不能证明 |
| --- | --- | --- | --- | --- |
| `InputOwnershipLease` | local terminal-control plane | 一个 `controlTargetId` | Feishu 是否独占，或 interactive 类是否可写 backend | 某个 interactive 产品实例是否是唯一 writer、Relay frame 已送达、群 turn 已回复 |
| `RelayStreamAttachmentLease` | relay-host v2 terminal manager | principal/client/stream/generation | stream、ring 和 route 短期可恢复 | Android 仍拥有全局 input ownership |
| `FeishuAwaitingTurn` | Feishu Bridge | binding + 群消息 + lease fence | 哪条群请求等待哪个 output/reply | 其他产品不能写 terminal |

约束：

- `terminal.open`、resumeToken、route rebind 或 120 秒 detached lease 都不得隐式取得或延长 `InputOwnershipLease`。
- binding 中的 `status=active` 不是已取得 lease 的证据；只有 controller 返回的当前 lease/fence 是权威。
- awaiting turn 必须绑定创建它时的 controlEpoch、leaseId、fence、controlTargetId 和 output generation。
- relay-host 重启/SUPERSEDED 可以 reset Relay stream，但不得替换 Feishu ownership；它重新加入现有 interactive lease 时也不能推进 fence。
- controller continuity 变化会使所有旧 lease/fence 失效；Relay command/stream 和 Feishu turn 必须分别按自己的不确定状态规则收敛。

## 4. Canonical `controlTargetId`

`controlTargetId` 是 terminal-control plane 签发的不透明 ID，标识一次具体 backend lifecycle，并满足：

- 不等于 UI row ID、display name、tmux raw name、Relay v1 `hostId+name` 或 Relay v2 `sessionId`。
- 在同一 controller authority lineage 内永不复用。
- 内部至少映射 authority scope、managed identity、backend kind 和可证明一次具体 backend lifecycle 的 instance key/birth evidence。
- 同名 tmux session 被删除后重建时产生新的 `controlTargetId`；Bridge 在确定旧 exact lifecycle 已结束后删除旧 Feishu binding 并发送失效原因卡片，不能按名称自动重定向。controller continuity 不明时仍保持 fail-closed/stale，不能误判为删除。
- Relay v1 adapter 只可在严格解析当前 host/session/backend instance 后映射 target；未知、partial、unreachable 或 identity 不确定时拒绝写入。
- Relay v2 relay-host 将 `(hostEpoch, scopeId, opaque sessionId)` 映射到 `controlTargetId`，但不把后者放进公共 v2 envelope。
- target closure 进入 `TARGET_GONE` 并撤销 lease；名称随后复用不能复活旧 target。

当前 Feishu Bridge 只支持本机 managed terminal，binding UI 和 contract 必须明确拒绝 SSH target。若以后支持 remote scope，必须在目标主机部署等价 controller或定义有 fencing 的受控 SSH proxy；Mac 上仅按远端名称保存一个本地 lease 不构成全局保证。

## 5. Owner identity

Owner ID 仍标识具体 producer instance，用于 operationId 归属、去重、诊断和精确的 pending-handoff 撤回：

```text
feishu-binding:<bindingId>:<daemonInstanceId>
dashboard:<dashboardInstanceId>:<ptyId>
local-cli:<processNonce>:<attachId>
relay-v1:<connectorId>:<clientId>:<stream-or-request-lane>
relay-v2:<principalId>:<clientInstanceId>:<target-lane>
```

ownership compatibility 只看两类：`feishu` 必须匹配精确 binding/daemon instance；其余 kind 全部兼容为 interactive。不同 interactive producer 收到各自 owner identity，但共享同一 `leaseId + fence`，因此它们不会彼此拒绝或 fence。owner kind 可以用于非敏感 UI，但 Dashboard 应把所有非 Feishu kind 展示为可写的 interactive 状态。Relay public wire不得暴露 Feishu chatId、Lark credential、群成员或 controller内部 leaseId/fence。

## 6. Input owner 状态机

```text
FREE
  |-- acquire(interactive) ----------------> HELD(interactive, shared leaseId/fence)
  `-- acquire(feishu) ---------------------> HELD(feishu, exclusive leaseId/fence)

HELD(interactive)
  |-- acquire/renew(any interactive) ------> same shared leaseId/fence
  |-- release(one; others remain) ---------> same shared leaseId/fence
  |-- release(last registered producer) ---> output reset -> FREE
  |-- explicit Feishu acquire/return ------> HELD(feishu, new leaseId/fence)
  `-- nobody renews -----------------------> exact-target/output reset -> FREE

HELD(feishu, IDLE)
  `-- graceful local takeover ------------> DRAINING(feishu -> local)

HELD(feishu, AWAITING|REPLYING)
  |-- graceful local takeover ------------> DRAINING; wait for reply certainty
  `-- explicit force takeover ------------> cancel turn -> DRAINING

DRAINING
  |-- drained/cancelled and persisted ----> atomic TRANSFER -> HELD(next, newLease, fence+1)
  `-- completion/continuity uncertain ----> RECOVERY_REQUIRED

any state
  |-- exact backend lifecycle disappears -> TARGET_GONE
  |-- Feishu/handoff/operation uncertain -> RECOVERY_REQUIRED
  |-- controller process restarts --------> new epoch; all old leases fenced
  `-- controller continuity is uncertain -> RECOVERY_REQUIRED
```

状态语义：

- `FREE`：没有 writer；observer仍可读。
- `HELD(interactive)`：所有非 Feishu producer 使用同一 leaseId/fence，在同一个 target critical section 中串行提交；producer owner identity 不形成互斥。
- `HELD(feishu)`：只有精确 Feishu owner/leaseId/fence 可以提交，所有 interactive input 只读。
- `DRAINING`：拒绝所有新业务输入，只允许在进入该状态前已经由 single writer 接受的原子 operation完成。
- `RECOVERY_REQUIRED`：无法证明旧写入、handoff 或 Feishu lease continuity；所有新写入 fail closed。只有受控本地 owner 在外部持久化取消/人工确认记录，并显式承认旧 operation 可能已生效后，才能用 force recovery 验证 exact backend、推进 fence 且不重放旧 operation；无 operation/handoff 的非 Feishu陈旧 lease 会走上面的安全回收，不要求用户确认。
- `TARGET_GONE`：exact backend lifecycle 已结束；Bridge 清除对应 binding 并通知群聊，且不能按名称恢复或自动指向同名新 session。

Feishu binding active 时默认长期持有独占 lease，即使当前没有 awaiting turn。Dashboard 的 **Take over locally**、binding pause 和 force pause 是解除占用的受控入口：它们先让 Bridge drain 或取消 turn，再切回所有 App/APK 共用的 interactive 类。当前这些 graceful/force 操作只允许本机 Dashboard 或受控本地 CLI 发起；Relay v1/v2 手机端不能远程暂停 Feishu。

Bridge 重启后不会伪造旧 lease token，原 active binding 因而进入 `stale`。此时手动 unlink 只有在 authority 已是 `FREE`/`TARGET_GONE`，或已经由受控 Dashboard/local CLI 持有时才能删除 binding；`HELD(feishu)`、`DRAINING` 和 `RECOVERY_REQUIRED` 必须保留记录并引导受控本地 recovery。生命周期群卡片走独立有序的 best-effort effect lane，不能占用 lease/turn mutation lane。Dashboard 迁移旧 Bridge 时只允许在 stale/pausing target 是 daemon 唯一 binding 且没有 active turn 的情况下停止整个 daemon；任何 sibling binding 都 fail closed，避免 snapshot 后 sibling 恢复所产生的 TOCTOU。已占用旧 daemon 的 active/paused binding 继续由旧 daemon canonical remove，这个一次性兼容路径无法补发新版生命周期卡。

## 7. Handoff commit point 和 fencing

Graceful handoff 的顺序固定为：

1. 记录 handoff intent，Feishu binding 进入 `pausing`，停止接受新群消息。
2. controller 将 lease 置为 `DRAINING`，所有新 input path开始拒绝。
3. 已有 Feishu turn 等待 marker、reply extraction 和 outbound reply 得到确定的幂等结果。
4. 当前 owner和controller确认没有已接受但未完成的 input operation。
5. controller single writer在一次持久原子提交中重新校验旧 lease/fence，递增 fence，替换 owner/leaseId，清除 handoff intent并提交新 `HELD` 状态。
6. 只有第5步成功后才向新 owner返回 acquired，并向群发送/确认 paused 状态。

尚未 commit 时，精确 pending next-owner 可以用 `handoff.withdraw` 撤回自己的 intent；controller 必须核对 `controlTargetId + handoffId + nextOwner instanceId`，并原子恢复旧 owner 的同一 lease/fence。它不能撤销他人的 handoff，也不能把状态转成 `FREE`。受控 CLI/Dashboard attachment 退出时必须执行该撤回，避免遗留无人接收的 `DRAINING`。

第5步的持久原子提交是唯一 handoff commit point。转移不经过可被第三方抢占的 `FREE` 窗口。

Force takeover 必须在 commit 前持久标记 awaiting turn 为 cancelled、撤销其 output cursor/reply authority，并使旧 fence 的所有回调失效。强制接管不是把不确定 reply 当作成功；如果群回复可能已发送但 ACK 未知，默认进入 `RECOVERY_REQUIRED`，除非用户明确确认 force policy。

commit 后：

- Feishu/interactive class transfer 后，任何旧 leaseId/fence 的 Dashboard PTY write、Relay input、command execution或 Feishu callback都在 backend write/群 post 前被拒绝；同一 interactive class 内新增或关闭 producer 不轮换 fence。
- controller只在 class transfer、Feishu release、最后一个 interactive producer 正常 release 或 shared interactive lease 确认过期时轮换 output generation；仍有其他 producer 时，单个 interactive attachment release 不轮换 generation，也不使其他 App/APK cursor 失效。旧 Feishu cursor 后来读到 `[[notify-group]]` 只能得到 stale-cursor拒绝，不得生成群回复。
- class transfer 时，已排队但尚未进入 controller critical section 的旧 class operation全部失败。
- Return to Feishu 使用同一 transfer流程：先停止/释放当前 writer，验证 target和bot health，再原子授予Feishu，最后恢复群消息消费。

## 8. Target-scoped single writer

所有受支持的 backend mutation 必须进入同一个按 `controlTargetId` 串行的执行器。每个调用至少携带：

```text
controlTargetId
controlEpoch
leaseId
fence
ownerInstanceId
operationId or producer sequence
operation kind and bounded payload
```

controller 在同一 critical section 中完成：去重/排序、target lifecycle校验、owner/lease/fence校验、backend write和结果提交。adapter不得在status查询后自行调用tmux、PTY writer或SSH。

操作分类：

- observation：inspect、output tail、Relay terminal open/output/replay；不取得input lease。
- input：keypress、paste、raw terminal bytes、`send_agent_message` body/submit；必须持有lease。
- backend presentation control：真实PTY/tmux resize；必须持有lease，observer resize不得改变共享backend。
- attachment-local close：只结束调用方自己的观察attachment且不结束tmux，可以不要求input owner。
- destructive lifecycle：kill session、结束managed backend、worktree cleanup；不能由observer执行，Feishu active/awaiting时必须先完成显式pause或force-cancel handoff。

### 8.1 `send_agent_message`

`send_agent_message` 的规范化正文和可选 Enter 必须作为一个不可被其他 producer插入的 controller operation。Relay v2 commandId/ledger负责网络重试和副作用收敛；controller critical section负责 interactive producer 间排序，lease/fence负责 Feishu/interactive class 隔离；三者不能相互替代。

Relay v2 执行顺序：

1. 保持冻结契约的 auth、expectedHostEpoch、fingerprint和已有ledger/tombstone lookup顺序。
2. 对已有 command key直接返回已有状态，不能因当前Feishu owner改变历史结果。
3. 只对缺失的新command检查target ownership。若被 Feishu 持有，使用既有 `PERMISSION_DENIED`，`retryable=false`、`commandDisposition=not_accepted`，不创建ledger；其他 interactive producer 已经持有 shared lease 时直接加入，不拒绝。
4. 可执行命令在ACCEPTED executionPlan中冻结controller reservation/fence；graceful handoff必须等待它完成。
5. force handoff后，controller若能证明第一字节尚未写入，可以最终失败；无法证明完整body/Enter边界时按Relay v2规则进入`IN_DOUBT`，不得自动重放。

### 8.2 Raw terminal input

Relay inputSeq只在同一generation内排序和去重。relay-host收到下一合法inputSeq后仍必须把bytes和当前controller lease/fence交给single writer：

- controller接受backend bytes后，relay-host才可推进/发送input ACK。
- Feishu 独占、class handoff 或 continuity 异常造成的 ownership 拒绝使用 `terminal.input_error` 携带既有 `PERMISSION_DENIED`、`retryable=false`、`commandDisposition=not_applicable`；另一个 interactive producer 不是拒绝条件。被拒绝的 input 不得写backend或发送ACK。
- Android必须丢弃该帧的自动重发意图并进入只读状态；以后只能由新的显式用户操作产生输入，不能在ownership释放后自动补发旧按键。
- output、ACK/replay和stream observation可以继续；input拒绝不伪造terminal.closed。
- route resume、同generation重连或detached lease都不能恢复旧InputOwnershipLease。

## 9. Relay v1 和 v2 拒绝行为

### 9.1 Relay v1

Relay v1 wire不变：

- list/session snapshot、terminal open和output继续可用。
- `send_agent_message` 由relay-host先严格映射target，再调用controller。Feishu持有时返回现有v1 `error`，尽可能回显原requestId；不调用tmux，不产生`agent_message_sent`。
- Feishu 独占时，`terminal_input`在stream write前被controller拒绝，relay-host发送现有带streamId的v1 `error`；不得缓存、重开stream后重放或写backend，output仍可继续。Dashboard 或另一个 APK 已持有 interactive lease 时，Relay v1 复用同一 lease/fence并正常写入。v1 `resize` 是 observation attachment 的私有 PTY 状态，不调用controller、不会改变共享 tmux window，Feishu 持有时也可继续使用。
- relay-host只在既有`error.message`内加稳定的`[input-ownership:<local-code>]`分类标记；不增加wire字段或message type。`PERMISSION_DENIED` 只有在controller明确表示 input 由 Feishu 持有时才使用该 marker，过期、fenced 或没有 current owner 的 shared lease 错误不能伪装成 Feishu ownership。relay-host在新 input operation 构造前检查缓存 lease 的 freshness，必要时续租或重新 acquire；不会以重放 input request 的方式恢复。Android v1把格式完整的 marker 视为当前 stream 的只读结果，停止input但仍允许 attachment resize；锁定图标表示客户端的 fail-closed latch，不表示 APK 持有服务端 lease。显式 `Retry input` 或正常 stream/transport 恢复都会创建 fresh stream并清除旧 latch，但旧按键永不重放；若 authority 仍拒绝，下一次新输入会再次进入只读。v1没有可提前查询owner或发起takeover的协议能力。
- socket/stream关闭不能把旧pending input交给新connection；Relay v1原有AMBIGUOUS语义保持不变。

### 9.2 Relay v2

首版Relay v2 frozen wire、requiredCapabilities、closed schema和错误表保持不变：

- 新command和raw input按§8使用错误表中已有的`PERMISSION_DENIED`。
- `terminal.open`只建立stream attachment/observer，不取得global ownership。
- command ledger、inputSeq和detached lease继续按冻结契约运行，但最终backend write必须经过controller。
- 没有ownership observation extension时，Android可能在首次拒绝后才进入只读UI；这不削弱服务端强制。
- broker只转发已验证frame，不读取controller状态、不产生ownership错误、不参与handoff。

## 10. 各输入路径规则

| Path | Feishu HELD时 | FREE或已显式授予时 | 断线/退出 |
| --- | --- | --- | --- |
| Feishu Bridge | 唯一writer；每target最多一个turn | paused/stale时不接受群输入 | continuity不明则fail closed，不盲发 |
| Dashboard PTY | output可读；write/paste/resize禁用；Take over走handoff | mount只观察，首次input加入shared interactive lease；其他Dashboard/APK不使其只读；SSH target在目标机裁决 | inactive/detach只清除自己的lease view；不fence其他interactive producer |
| 受控`tw attach` | 默认read-only/拒绝；`--take-over`走handoff | acquire后加入shared interactive lease | detach只释放自己的view |
| raw tmux | privileged bypass，无产品保证 | 同左 | 文档和UI必须明确 |
| Relay v1 | read/output和attachment resize可用；send/input/kill拒绝 | adapter加入Dashboard/其他APK共用的interactive lease后写；resize只调整自己的attachment PTY | 不继承旧pending input；fresh stream不继承旧read-only latch；close不fence其他interactive producer |
| Relay v2 | open/output/replay可用；send/input/resize/kill拒绝 | v2 adapter加入shared interactive lease后写 | detached stream不单独保留或fence shared lease |

## 11. Storage、恢复和安全

- controller状态使用独立version/schema、锁、原子替换、0600权限和fail-closed解析；不得从binding active或Relay stream猜测恢复。
- controlEpoch/authority continuity无法证明时更换epoch并使所有旧lease/fence失效。
- output capture与controller同属一个本地daemon，但仍是read-only Feishu marker-correlation capability，不是 Dashboard、`tw serve`、Relay/Android 或受控 CLI 展示的 terminal output。每个 generation 以两个各 4 MiB segment 形成有界 ring，使用绝对 cursor 并通常保留最近约 4–8 MiB；segment 淘汰只让过旧 cursor 收到 `STALE_OUTPUT_CURSOR`，不改变 target lifecycle/ownership。旧 generation 只有在 generation fence 后才回收，不能无限写盘或回退到未fence的inspect路径。
- 升级前由旧单文件硬上限遗留的 `OUTPUT_CONTINUITY_UNCERTAIN` 沿用 idle non-Feishu observation repair：仅在 authority 能复核 exact backend、当前 ownership 为 `FREE`、没有 in-flight/operation/handoff uncertainty，且 previous owner 不是 Feishu 时自动换代 capture 并回到可用状态。identity、Feishu turn、handoff 或 operation disposition 不明继续 fail closed。
- Feishu awaiting turn和outbound reply attempt必须持久记录，reply response丢失需要幂等查询/重试策略；只做inbound event dedup不够。
- target gone、bot membership丢失或daemon冲突必须先阻止旧turn继续tail/post，再释放或fence lease，避免接管后的本地输出被发到群。
- owner display信息按least disclosure返回。Relay可以展示通用`feishu`/`local` owner kind，不传chatId、群名、成员或credential。
- operation payload、terminal bytes、群消息、lease secret和cursor不得进入普通日志；只记录可信ID、owner kind、byte size和结果码。

## 12. 模块边界

### Terminal-control / Feishu 侧可以修改

- 新增独立的local terminal-control contract、daemon、状态库和controller client。
- 新增Feishu Bridge进程、binding/event/turn/reply persistence和Lark adapter。
- 修改DashboardBackend、Tauri/fake/preview backend和UI以管理binding、只读状态和本地handoff。
- 修改Dashboard PTY write/paste/backend resize、受控CLI attach和Relay v1 relay-host的raw/agent-message adapter，使真实backend mutation调用controller；Relay v1 attachment resize保持在私有PTY内。
- 按 `AGENTS.md` 的测试准入规则补充必要的 storage、安全、竞态或端到端证据；不要求每类都新建测试。

### Terminal-control / Feishu 侧不可修改

- `contracts/relay/v1`、Android v1 codec或legacy requestId/stream语义。
- Relay broker transport/auth、twcap2、enrollment、carrier或v2 command/snapshot/terminal schema。
- `tw rpc v1`或managed lifecycle的canonical ownership。
- 在Bridge中实现direct git/tmux creator，或复用Relay credential/URL传输Feishu消息。

### Relay v2 侧可以修改

- relay-host v2 backend adapter和`sessionId -> controlTargetId`内部映射。
- v2 command execution和terminal input/resize的controller调用与fencing。
- Android在既有`PERMISSION_DENIED`后的只读/不自动重发行为。
- companion实现说明、故障注入和跨产品ownership测试。
- 以后以独立extension contract增加ownership observation能力。

### Relay v2 侧不可修改

- 在relay-host或broker复制全局InputOwnershipLease store。
- 让routeFence、resumeToken、inputSeq或detached lease提升为全局owner。
- 把Feishu binding、chatId、Lark auth、marker或群回复逻辑放进Relay。
- 为了ownership修改Relay v1 wire，或在v2失败时回退到v1写入。

共享输入adapter应先依赖同一个terminal-control foundation，不能由Feishu和Relay分支分别实现两套check/write路径。

## 13. Future `input.ownership.observe.v1` extension

`input.ownership.observe.v1` 是**以后独立、可协商的capability extension**，不是Relay v2首个frozen slice的修订：

- 不加入当前六项requiredCapabilities。
- 不修改当前public envelope、closed message schema、Session schema或错误表。
- 当前安全强制不依赖该extension；没有它时仍由relay-host/controller拒绝写入。
- extension只提供通用、最小披露的owner kind/status/revision观察；不得携带Feishu chatId、credential或群成员。
- 若未来允许手机发起takeover，需要另行定义有授权scope、graceful/force语义和审计的control capability；observe capability本身不授权mutation。
- extension必须有独立manifest、fixture、Node/Android codec和capability negotiation测试，不能条件分支污染Relay v1 actor/codec。

## 14. 验收测试矩阵

本矩阵列出必须获得的风险证据，不表示一行对应一个自动化测试，也不要求每次修改运行或复制整个矩阵。相邻状态可由同一 authority 层状态机或端到端场景证明；跨端只在协议边界保留最小互操作证据，具体选择遵循 `AGENTS.md` 的测试准入与风险驱动验证规则。

| 场景 | 必须证明的结果 |
| --- | --- |
| Feishu active但IDLE | Feishu持有lease；Dashboard、CLI、v1/v2写拒绝，所有observer仍可读 |
| Feishu awaiting turn | 新群消息和其他产品input都拒绝；既有turn独占完成 |
| 多Dashboard/APK并发 | 所有interactive producer共享同一lease/fence并由single writer排序；任一attachment release不fence其余producer |
| Graceful takeover | reply确定完成前不commit；commit后新owner可写且旧owner永远失败 |
| Force takeover | cancel先持久、fence再前进；迟到marker/callback不发群回复 |
| Reply已发送但ACK未知 | 不误报完成、不自动transfer；进入recovery或显式force policy |
| Dashboard PTY write竞态 | lease/fence校验和writer.write不可被handoff插入 |
| output capture rollover | 两个 4 MiB segment 保持 generation 内绝对 cursor；保留窗口内连续 tail，已淘汰 cursor 返回 `STALE_OUTPUT_CURSOR` 且 target 不进入 recovery；同一 Feishu authority 可从保证保留窗口重建 parser 且不重放 input，generation/fence 变化仍 fail closed；可见 PTY output 不受 capture ring 影响；旧 generation 被回收 |
| legacy capture容量recovery | 走 idle non-Feishu observation repair：只有 exact target、`FREE`、无 operation/handoff uncertainty 且 previous owner 非 Feishu 时自动换代；其他 continuity 不确定性仍 fail closed |
| Relay v1 send message | 回显requestId error、无tmux副作用、无`agent_message_sent`、无自动重发 |
| Relay v1 raw input | error带streamId、无backend write/隐式reopen，output继续 |
| Relay v2新command | `PERMISSION_DENIED/not_accepted`且无ledger/tombstone |
| Relay v2已有command | ownership变化不覆盖已有status/result或导致第二次执行 |
| Relay v2 raw input | `PERMISSION_DENIED`、无input ACK/写入/自动补发，output继续 |
| send message与raw input并发 | 同一single writer排序；正文和Enter之间不能插入其他producer bytes |
| Graceful handoff遇到ACCEPTED命令 | 等命令收敛后transfer，不静默撤销或重放 |
| Force handoff遇到RUNNING命令 | 无副作用则明确失败；边界不明进入IN_DOUBT |
| route/socket重连 | 不恢复或重放旧pending input；fresh stream清除旧客户端latch并重发一次当前WebView attachment的desired size；旧attachment token的input/resize/close被丢弃；interactive adapter可重新加入当前shared lease，Feishu独占不变 |
| relay-host SUPERSEDED/重启 | 旧route/hostInstance不能写；global owner不被新进程猜测继承 |
| controller重启/状态损坏 | controlEpoch变化且所有旧lease/fence失效；idle非Feishu lease复核target并重建capture后回FREE，Feishu/handoff/in-doubt仍RECOVERY_REQUIRED |
| 显式force recovery | 先验证exact backend并确认旧operation可能已生效；推进fence且绝不重放旧operation |
| target同名重建 | 新controlTargetId；Bridge 确认旧 lifecycle 已结束后清除旧 binding、发送失效原因卡片，且不自动重定向 |
| target closure/kill竞态 | lease撤销、turn停止tail/post、observer不能用kill绕过handoff |
| resize/close | observer resize只改变自己的attachment PTY、不能改变shared backend/tmux几何尺寸；允许只关闭自己的observation attachment |
| Dashboard退出 | 不停止共享controller/Bridge，不释放Feishu lease，不暂停active binding；群事件继续由daemon处理 |
| Feishu remote target未实现 | binding/admission明确拒绝；Dashboard/Relay只调用目标机controller，不以本地名称lease伪装支持 |
| raw tmux privileged bypass | 产品文档/UI明确不保证，自动化验收不把它当受控路径 |
| extension未协商 | frozen v2正常运行并强制拒绝，不发送未知ownership frame |
| extension以后协商 | 只观察最小owner状态，不扩大takeover权限或泄露Feishu身份 |

当前自动化已覆盖local contract closed schema/严格存储、handoff commit/fencing/withdraw、同名target重建、backend不确定性与显式force recovery、Feishu turn/marker/reply和持久化故障、Relay v1 Feishu-owner拒绝和不重放、Dashboard/Tauri本机与SSH controller映射、Android v1只读收敛，以及真实terminal-control authority与Feishu Bridge之间的无群黑盒写入/接管/fencing路径。Relay v2 ledger/inputSeq和真实群出站仍须在后续实现或发布验证中补齐；在那些验证完成前，不得声称Relay v2 ownership adapter、ownership observation、手机takeover或Feishu生产发布已经实现。
