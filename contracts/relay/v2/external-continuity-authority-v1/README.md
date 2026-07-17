# Relay v2 external continuity authority v1

状态：**Frozen future interoperability/security contract; production backend、adapter、composition、readiness 与 capability 均未实现。**

本目录冻结 Relay v2 共享 monotonic/CAS continuity port 的外部 authority 语义。它不选择云厂商、数据库或部署拓扑，也不提供 production adapter。当前 Relay 生产路径仍是 v1；本 contract、fixture 或现有 in-memory foundation 都不能生成 v2 enrollment、注入 broker、宣告 capability 或触发 v1 fallback。

## Owner 与唯一链路

外部 backend 只拥有按 `anchorId` 查询的 rollback-independent、durable、monotonic、linearizable read/CAS record，以及使该 record 永不被旧备份、reset 或复用降级所必需的永久 lifecycle marker。它不拥有 credential、Agent timeline、local store、readiness、socket 或 capability。

现有 owner 不变：

1. `RelayV2ContinuityAnchor` 拥有 local-state-before-anchor ordering、唯一允许的一代 state-before-anchor crash-window reconcile、bounded timeout，以及 timeout/late result 后的 reconciliation fence。
2. `RelayV2BrokerCredentialAuthority` 拥有 credential checkpoint、credential business state、authority readiness withdrawal 和对现有 closed error 的映射。
3. `RelayV2BrokerCore` 只消费 auth-control authority；它不得读取 backend config、secret、record、CAS token 或 provisioning metadata。
4. future production composition 的唯一允许顺序是 native store open + self-check → 注入本 contract 的 external monotonic authority → credential authority open/reconcile → 形成同步 admission/connection fence → 最后才把 auth-control authority 注入 broker。

任何步骤缺失、失败、超时或 uncertain 时 v2 保持 unavailable。不存在 v1/BAU fallback、readiness shortcut、enrollment 或 capability advertisement。

## External record 与线性化

一个 provisioned `anchorId` 起初可以是 `uninitialized`。第一次 CAS 只能提交 sequence `0` genesis；此后只允许 exact immediate successor：sequence 加一且 `parentCommitId` 等于当前 `commitId`。每次 read 与 CAS 都必须在线性化历史中出现一次；两个实例从同一 expected token 并发提交不同 successor 时恰有一个 `swapped`，另一个得到包含 winner 的 `conflict`。

成功 CAS 的 ACK 只有在 record 已满足 durability/灾备保证后才能发出。其最低保证是：

- 已确认 CAS 的 RPO 为 0；service/process restart、serving failover 或 disaster recovery 不能丢失已确认 successor。
- backend、其 durable journal/high-water evidence 和恢复控制面不得与 Node local state、本地 witness、native credential store或它们的备份/restore 域共享 rollback fate。
- 旧备份只能作为恢复输入；恢复服务在证明其 high-water 不低于外部 durable history 前不得 serving。无法证明时保持 unavailable，不返回 `uninitialized` 或较旧 record。
- 本 contract 不承诺 availability 或 RTO。无法同时满足 linearizability、durability和 high-water proof 时，正确结果是 fail closed。

CAS ACK 丢失、deadline、transport reset 或未知 error enum 都不能证明未提交。adapter 必须把这类 CAS 结果向 `RelayV2ContinuityAnchor` 闭合为 uncertain；deadline 后的迟到结果不能完成原调用，也不能触发新 CAS。恢复只能由 fresh linearizable read 驱动 reconcile。

## Provisioning、ACL 与 lifecycle

`anchorId` 是不透明、稳定、具备抗碰撞 provisioning 证据的标识，必须由受认证 provisioning control plane 预留，并永久绑定 exact `(securityDomainId, namespace, ownerBinding)`。该control plane是external backend职责，不是新的稳定owner或runtime data-plane manager。`securityDomainId` 是本 external contract 新定义的 tenant/ACL 隔离键，不是 Relay wire claim或 credential字段；`ownerBinding` 是 provisioning 提供的不透明稳定 identity，不能从 display name、credential payload或临时配置猜测。首版 namespace 名称也是本 v1 external contract 的新规范选择：

- `broker-credential.v1` 的 ownerBinding 必须由 future provisioning 明确选择并持久化；本版不把它绑定到尚未冻结的 issuer/tenant credential字段。
- `agent-transcript-lifecycle.v1` 的 ownerBinding 沿用现有 extension store 已冻结的 exact `(hostId, hostEpoch)` owner。

runtime data plane 只有 exact read/CAS 权限，不拥有 provision/reset/decommission。ACL 默认拒绝，认证身份必须映射到一个 security domain 和显式 anchor/namespace allowlist。相同 anchor/binding 的 provisioning retry 幂等；同一 `anchorId` 的不同 security domain、namespace 或 ownerBinding 是 `NAMESPACE_COLLISION`，不得读取既有 record或泄露其存在、checkpoint、CAS token或 lifecycle。

同一个 `anchorId` 永远不能通过 rebuild、delete、reset、restore 或 decommission 回到新的 monotonic history：

- reset 必须保持同一 exact `(securityDomainId, namespace, ownerBinding)`，先把旧 anchor 变为永久 tombstone，再为该 exact owner tuple provision 新 `anchorId`；不得借reset改owner binding，旧 ID 不可复用。
- decommission 是 terminal lifecycle；后续 read/CAS 都闭合失败。
- 物理 payload 清理若因 retention/erasure policy 必需，只能在 rollback-independent lifecycle marker 保留最高 history evidence和永久 reservation 后进行；`anchorId` 仍不可复用。
- broker credential 与 Agent extension 必须使用不同 anchorId、namespace、ACL binding、reset 和 tombstone。两者不能覆盖、复制、迁移或复用对方 record。

## Transport、auth、config 与 request identity

future adapter seam只负责closed config、auth/secret reference解析、request encoding、response decoding和现有upper mapping；external backend保证authenticated linearizable read/CAS、exact closed response与idempotent decision replay，两者不进入稳定owner表。该seam只能使用manifest冻结的config：受信 `https://` endpoint、security domain、两种允许的workload auth mode之一、credential/trust reference、bounded timeout/in-flight limit和exact namespace binding。endpoint禁止userinfo、query、fragment和明文HTTP；其2048 UTF-8 byte上限是本v1为URL parse前有限分配新增的规范选择。credential/trust reference都是复用现有128-byte identifier规则的不透明resolver key，不是path或secret。`namespaceBindings`只允许1..2项，item exact keys为`namespace/ownerBinding/anchorId`；上限2直接来自本版仅有的两个namespace，namespace与anchorId都必须各自唯一，每项必须匹配enclosing securityDomainId下已provision的exact tuple。secret/key/token只能由reference在进程内解析，不能进入config file、URL、日志、error、trace、fixture或record。`operationTimeoutMs` 的1..30000、默认5000与`maxPendingOperations`的1..1024、默认64直接继承现有`RelayV2ContinuityAnchor` foundation；它们不是本external adapter新增的ready-loss或transport close时限。

external request/response使用manifest中的exact closed envelope与per-operation discriminated union。所有identifier/operationId最多128 UTF-8 bytes并使用冻结ASCII grammar，operationId还必须由collision-resistant CSPRNG生成；CAS token是1..512 bytes printable ASCII；sequence是canonical uint64 decimal string；checkpoint commit/parent ID与digest沿用现有continuity bounds。read snapshot固定exact `status/checkpoint/casToken`：`uninitialized`必须`checkpoint=null`，`committed`必须带anchorId等于request的valid checkpoint。CAS `expected`使用同一snapshot shape，`next.anchorId`必须等于request；CAS result的`current`也使用同一snapshot shape且casToken必须不同于expected，`swapped.current`还必须是checkpoint exact等于next的committed snapshot。adapter只在typed port translation时为snapshot补`protocolVersion/anchorId`，并在uninitialized分支移除external `checkpoint=null` key。未知字段/enum、operationId不匹配、`ok/result/error`非法组合、跨anchor checkpoint或malformed snapshot/CAS result都不能进入typed port。

每个 logical read/CAS 使用 collision-resistant CSPRNG opaque `operationId`；其具体编码属于 adapter实现，但不得被解析为业务 identity。同一 operationId + exact fingerprint 的 transport replay必须返回同一 committed decision；相同 ID 不同 fingerprint返回 `IDEMPOTENCY_CONFLICT`。adapter 可以在原 deadline内重放同一 request identity，但 deadline/uncertain之后禁止用新旧 identity盲重试 CAS，必须 read-reconcile。

manifest 中的 `AUTHENTICATION_FAILED`、`PERMISSION_DENIED`、`QUOTA_EXCEEDED`、`CAPACITY_EXHAUSTED`、`RATE_LIMITED`、`TIMEOUT` 等 code 是本 v1 **external backend/adapter internal** error namespace 的新规范选择，不是 Relay public wire error，也不能直接发给 Android/host carrier。closed external error只包含 `code/retryable/retryAfterMs/commitDisposition`，连backend message都不接受。read error一律`commitDisposition=not_applicable`；CAS error必须按对应code定义精确为`proven_no_commit`或`uncertain`，且code必须允许该request operation。capacity/rate的retryAfterMs是bounded JSON-safe非负整数，其他首版code为null；它只用于诊断，不授权自动重试。跨security domain访问统一为`PERMISSION_DENIED`，不另设会泄露租户存在性的public distinction。错误不得包含secret、record、checkpoint、digest、CAS token、security-domain inventory或另一namespace/domain的存在性。未知字段、未知enum、缺字段、类型coercion和malformed success/error一律fail closed。

到现有 owner 的映射固定为：external read error → `RelayV2ContinuityAnchor.ANCHOR_UNAVAILABLE`；malformed read success → `INVALID_AUTHORITY_RESPONSE`；任何 compareAndSwap seam error（即使 backend声称 pre-linearization `proven_no_commit`）→ `ANCHOR_COMMIT_UNCERTAIN`，因为现有 typed port没有可证明 pre-linearization的 error union；只有 exact closed CAS conflict result才能进入 `CAS_CONFLICT`/winner converge。credential authority继续把它们闭合为 `EXTERNAL_CONTINUITY_UNAVAILABLE|INVALID`、`EXTERNAL_ANCHOR_UNCERTAIN|CONFLICT`并同步撤回 admission。external `retryable=true` 只提供运维诊断/retryAfter，不授权上层自动重试 CAS。

## Ready 后撤权

一旦 credential authority 已 ready，任何 external read/CAS 失联、timeout、uncertain、stale/malformed result、DR rollback evidence、ACL/lifecycle failure或未知 response 都触发同一生产 fence：

1. `RelayV2BrokerCredentialAuthority`在失败逃逸前同步撤回ready/admission并发起close barrier；原instance不得恢复ready。
2. future production broker composition在同一同步turn阻止新的v2 Upgrade、route、auth-control、enrollment和capability advertisement，并先停止所有既有v2 connection的业务frame admission/forwarding。`RelayV2BrokerCore`仍只消费auth-control authority，不拥有external readiness或transport close。
3. 所有 active v2 connection 必须在一个明确、有限、可验证的 deadline内关闭；close delivery不能延迟前述同步 fence。
4. 只有新 authority instance 重新完成 native open+self-check、external linearizable reconcile 和完整 composition fence 安装后，才允许新的 ready generation。

具体 Relay client route/host carrier close code和 close deadline不由 external backend/adapter拥有，也不能借用现有 handshake/backpressure常量。本 v1将二者列为 production adapter开始前必须在 owning broker/composition contract冻结的 required choice；在选择完成前 production wiring继续 NO-GO。当前仓库没有上述 production readiness subscription、connection fence、backend transport或 adapter，因此本条只是冻结未来接线的验收语义，不描述当前 runtime。

## Machine fixture

`machine-cases.json` 使用 symbolic checkpoint，覆盖并发 CAS、ACK loss/timeout、stale read、唯一 crash-window reconcile、rollback/divergence、restart/旧备份/failover、closed error taxonomy、namespace/tenant隔离和 reset/decommission/tombstone。fixture 是规范输入；测试只验证其 closed schema、自洽性与必需 outcome，不复制 backend 或 continuity 算法。

在选择 backend 或开始 adapter 前，production 负责人仍必须提供 contract-level evidence：rollback-independent failure-domain diagram、linearizability model、RPO=0 durability/DR procedure、provisioning/ACL implementation、authenticated transport/config secret flow、quota/timeout bounds，以及 ready-loss connection-fence演练。任一项没有可验证答案时 adapter 保持 NO-GO。
