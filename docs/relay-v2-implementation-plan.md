# Relay v2 并行实施计划

状态：**实施协调文档；codec conformance 基础不等于 Relay v2 runtime 已交付，也不构成 capability、兼容性或发布日期声明。**

规范语义以冻结的 [`relay-v2-contract.md`](relay-v2-contract.md) 为准。本文件只定义如何把该契约拆成可以并行交付的 owner 模块、哪些依赖必须串行，以及每个模块何时可以进入集成。当前实现事实仍以 [`ARCHITECTURE.md`](../ARCHITECTURE.md) 和源码为准；进度不得靠本文件中的阶段名称或清单推断。

## 交付目标

首个基础交付只包含冻结契约的六项原子能力：

- `error.structured.v1`
- `command.ledger.v1`
- `command.query.v1`
- `snapshot.revision.v1`
- `event.sequence.v1`
- `terminal.stream.resume.v1`

这六项必须作为一个可互操作集合上线。Agent 入站 transcript、Agent lifecycle、通知、附件和跨 host 进程的 terminal resume 不属于基础集合；其中 transcript/lifecycle 作为独立 extension 并行设计，但只能在自己的 contract、codec 和跨端验收完成后单独协商。

“reply state”拆成两个不同 owner：

- 手机发送内容是否已被 host 接受、执行或陷入不确定状态，由基础 v2 command ledger/query 权威回答。
- Agent 是否已开始处理、等待用户、失败、完成或产生回复，由后续 Agent extension 的结构化事件权威回答；不得从 command ACK、terminal bytes 或本地计时推断。

## 并行拓扑

冻结契约已经给出跨端语义，因此各模块不必等待另一端生产实现，可以先对共享 fixture、fake transport 和 simulator 开发：

```text
 frozen Relay v2 wire + local state-store + external continuity contracts
                                   │
          ┌────────────────────────┼────────────────────────┐
          │                        │                        │
   B. broker control       H0. host state store     D/A/X domain work
      and carrier                  │                  against fakes
          │             ┌───────────┼───────────┐            │
          │             │           │           │            │
          │       H1. command  H2. resource  H3. terminal    │
          │           plane       state        manager       │
          │             └───────────┼───────────┘            │
          │                         │                        │
          ├──────── D. Dashboard enrollment/process ────────┤
          ├──────── A. Android v2 client/storage/UI ─────────┤
          └──────── X. Agent extension contract/prototype ───┘

          B + H carrier integration
                     │
          complete base-v2 interoperability
                     │
     capability/enrollment enablement and release evidence
                     │
      X host/client integration and separate negotiation
```

可立即并行的是 B、H0、Dashboard 的 fake-backed UI/domain、Android 的独立 v2 namespace/actor，以及 X 的 authority/contract 设计。H1/H2/H3 只需等待 H0 的最小事务接口，不互相等待；它们分别用 fake executor、materialized state fixture 和 fake byte backend 验收。真实跨端联调才进入后面的硬门槛；各 lane 必须持续通过已有的共享 codec conformance baseline。

## 工作包与验收标准

### E0. external continuity authority v1 契约

[`contracts/relay/v2/external-continuity-authority-v1`](../contracts/relay/v2/external-continuity-authority-v1/README.md) 仍是external backend/adapter互操作与安全语义的frozen source；Node adapter/config binder/opener、per-attempt credential/trust resolver + HTTPS transport provider seam及显式default-off Broker composition已实现，但 provider seam 仍不附带 production resolver/backend，必须由 deployment 显式注入，均不等于qualified backend deployment。它保持现有 owner 链：external backend 只拥有按 `anchorId` 的 rollback-independent durable monotonic linearizable record/lifecycle；`RelayV2ContinuityAnchor`拥有 local-state-before-anchor ordering、唯一 crash-window reconcile与bounded operation timeout；T1 credential authority拥有credential state、ready withdrawal与closed mapping；broker只消费auth-control authority。machine fixture使用closed vocabulary、共享defaults与case deltas覆盖竞态CAS、ACK loss/timeout reconcile、outer/inner malformed结果、rollback/divergence、restart/旧备份/failover、closed internal errors、namespace/reset/decommission/tombstone和namespace-scoped ready-loss fence。

E0 中的 `securityDomainId`、opaque `ownerBinding`、`broker-credential.v1`/`agent-transcript-lifecycle.v1` namespace及 external internal error taxonomy 是本 external v1 的新规范选择，不是 Relay wire字段或错误。现有Node adapter只decode outer envelope/error，backend success result必须原样使用existing continuity snapshot/CAS result shape并作为untrusted unknown交给existing decoder；adapter不能补authority字段或复制checkpoint decoder。outer HTTPS固定exact endpoint POST、no redirect、identity/no compression，请求与响应固定`Cache-Control: no-store`且请求固定JSON Accept；只有status 200与exact JSON Content-Type通过header gate后才解码closed envelope，非200或header mismatch不得读取、解析或回显proxy body。该boundary复用Relay v2 manifest的16384-byte body、depth 8、total keys 32与strict JSON规则；workload credential不得redirect转发。request fingerprint是decoded closed tuple字段级exact type/value equality，不依赖key order或canonical hash。read outer failure闭合为`ANCHOR_UNAVAILABLE`而malformed inner snapshot为`INVALID_AUTHORITY_RESPONSE`；CAS outer/inner failure都闭合为`ANCHOR_COMMIT_UNCERTAIN`。broker namespace failure再由T1撤回ready；Agent extension namespace failure复用现有`AGENT_AUTHORITY_STORE_CONTINUITY_UNAVAILABLE|COMMIT_UNCERTAIN|CORRUPT` mapping并只隔离extension；unavailable必须保留可证明lineage并repair/reopen，不能reset/new epoch，只有corrupt允许extension reset/new epoch。即使backend声称CAS在linearization前因capacity/rate被拒绝，现有port也没有可证明的definite-rejection union，不能授权盲重试。continuity operation timeout 的 5000ms 仍只属于 continuity owner；独立未接线的 transport close coordinator 另有 5000ms credential-fence deadline 并已实现 4401/4403/1013 policy，owning production composition 在开始 adapter 前仍须显式采用、接线和验收，external adapter 不得另行选择。

production E0 仍是 NO-GO：尚未选择并验收 rollback-independent backend、RPO=0/DR high-water、stable anchor provisioning/ACL、frozen outer HTTPS/auth/secret/config实现、quota/rate/capacity配置、restart/旧备份/failover演练，显式default-off authority injection/composition及采用caller-supplied `node:https.Server`的public lifecycle root已存在，但没有qualified deployment、真实public TLS/network/device或ready-loss证据。由显式activated composition采用的Broker live-authorization owner已覆盖exact revoke/kid removal、trusted-time expiry与credential-authority ready-loss同步fence，但`qualifiedRecords=[]`使真实activation不可达，仍不构成shipping active-connection fence。实现顺序固定为 native store open+self-check → external authority injection → credential authority open/reconcile → synchronous admission/active-data fence → broker auth-control injection；任何缺项都不产生ready、enrollment或capability，也不允许v1/BAU fallback。broker credential与Agent extension必须使用独立anchorId/namespace/ACL/reset/decommission/tombstone，不能覆盖或复用history。

### N0. broker credential native state-store 契约

`contracts/relay/v2/broker-credential-state-store-v1` 是 broker credential 本地持久化的唯一串行设计输入。当前顶层 contract revision 是 2；N-API interface、capability storage、binary/header、private-location derivation 与 fixture仍各自为 v1，artifact、magic、offset、length、fixture和 TypeScript ABI不变。它冻结 exact `open({trustedHome, maxStateBytes})`、TypeScript raw-store/transaction/revision/bytes closed wrapper、`RelayV2BrokerCredentialStateStore` deep port、transaction-scoped opaque revision、closed capability/open/error union，以及 single descriptor-backed binary v1。Container 的 canonical private location 只由 manifest 的 `binaryStorage.container.privateLocation` 定义；未接线的 platform-common crate由N0.2通过build script单点消费并生成shared `ContainerSpec`，并由N0.4成为shared lifecycle owner；N2/N3不能各自复制relative component literal、registry/PID/final-close状态机或直接消费N1。Container 固定 134,217,984 bytes：header0/header1 位于 absolute offset 0/128，payload0/payload1 位于 256/67,109,120，各 payload capacity 67,108,864。它不拥有 credential 业务语义。T1 已新增未接线的 `RelayV2BrokerCredentialAuthority` source foundation，通过该 port 独占 versioned issuer、enrollment、grant、replay、rate-limit、ready withdrawal 与 external continuity 业务语义；显式default-off Broker production composition与HTTP runtime现会注入该owner；默认CLI仍不注入，空qualification使真实open不可达。

Capability `supported` 只表示 pre-open artifact/target/interface 完整，不表示 ready。Ready 仍依次要求 exact open、native self-check 和 T1 external continuity。Existing unknown/corrupt/unsafe/identity-uncertain/durability-unsupported store 一律 `invalid` 并保留；`unsupported` 只允许 `native_artifact_missing`、`target_unsupported`、`interface_version_unsupported`，不得把磁盘失败伪装为 missing 重建。

N1、P1 与 T1 可以继续对同一 binary/interface seam 并行；platform lane 的唯一必要串行链是 `N0.3 contract revision 2 → N0.4 shared lifecycle → N2/N3 OS adapters`。N2/N3 不能跳过 N0.4或各自扩张 interface：

- N1 Rust core：实现 fixed-length sparse fixture parser/selector、generation、digest/checksum、absolute-offset positional write、exclusive transaction、compare-and-publish、terminal uncertain 与 close barrier；不拥有业务 state schema。
- N0.2 platform common foundation：独立未接线crate的build script验证contract revision 2及frozen private-location/fileLength/admission max并生成唯一immutable spec；它建立closed platform error与private N1 handoff基础，不接`trustedHome`、不构造path，也不实现syscall/filesystem/durability或N-API。N0.4在同一owner内扩展lifecycle，不建立平行crate。
- N0.3 secure-open/durability contract：revision 2已冻结 credential snapshot、native account-home proof、exact mode/ACL、qualification-before-registry/mutation、final A/B/C descriptor proof、traditional process-owned `F_SETLK`、同进程 registry/fork/close语义及 deny-by-default durability policy。Durability v1的 `qualifiedRecords=[]`，第一条 record必须新增 contract revision；本 revision没有可实例化 item schema/template/example/wildcard，runtime probe或 syscall success不能创建 qualification。
- N0.4 platform-common lifecycle：当前已在common内唯一实现显式eager `ProcessLifecycleToken`、registry key `(verifiedHome dev, ino, RelayV2BrokerCredentialStateStoreV1)`、`Opening/Open/Closing/CloseUncertain`、pre-fd reservation、unique token、opener-PID/descriptor fence、panic-aware permanent poison、common-owned exactly-once final close、private N1 bridge与opaque process-bound store/ticket/lease/snapshot/revision/outcome wrappers。Active collision返回`STORE_BUSY`；close uncertain和registry poison永久`STORE_CLOSED`；same-PID poison仍释放已admitted N1 ownership并attempt final close，publication `Uncertain`保持占优。Public `SoleContainer`不暴露N1 action，N2/N3/N-API不得直接依赖N1或复制lifecycle。该owner仍不做Darwin/Linux path/syscall/durability；当前N-API binding已在module init eager exactly-once捕获token。现有证据仍不包括真实OS fork、platform-adapter-qualified real open、真实kernel lock/filesystem/power-loss或device。
- N2 Darwin adapter：当前已有未接线foundation，消费 N0.4 lifecycle与唯一 `container_spec()`，按 exact open order实现 native account-home/no-follow/mode/ACL、read-only qualification probe、registry reservation、existing `fstatat(...AT_SYMLINK_NOFOLLOW)` preflight、sole-fd exact `openat` flags/`FD_CLOEXEC`验证、traditional `F_SETLK`和 final A/B/C proof；不复制 path component/registry、不打开 preflight fd、不使用 `O_TRUNC/O_EXLOCK`或修复 existing mode。Publication payload/header各使用 `F_FULLFSYNC`；creation依次为 container full sync、parent-dir fsync、必要时 trusted-home fsync、`fsync_volume_np(...SYNC_VOLUME_FULLSYNC|SYNC_VOLUME_WAIT)`。由于本 revision allowlist为空，production real open在 registry/mutation前返回 `DURABILITY_UNSUPPORTED`；production不可达的 `cfg(test)` qualification只验证 scaffold，不是qualified real-open证据。
- N3 Linux adapter：当前已有未接线foundation，消费与 N2 相同的 N0.4 lifecycle/spec/exact preflight+`openat` order，使用 traditional `F_SETLK`，明确禁止 `F_OFD_*`/`flock`/`O_TRUNC/O_EXLOCK`；实现同一 sole descriptor/offset/lifetime、`FD_CLOEXEC`和 final A/B/C proof与 ACL semantics，不把 `openat`/fd/inode/cleanup暴露给 Node port。Publication与 creation按 manifest的 exact `fsync` sequence；空 allowlist同样使production real open在 registry/mutation前返回 `DURABILITY_UNSUPPORTED`，production不可达的测试资格不构成qualified real-open证据。
- N4 raw N-API binding：当前已有独立未接线foundation，以同一crate按target选择Darwin/Linux public open seam；module contract只暴露冻结capability/open，module init eager exactly-once捕获`ProcessLifecycleToken`，raw store/transaction只转换platform-common `ProcessBound*`生命周期与bytes/revision/outcome/error边界，不拥有credential schema、readiness、continuity、fallback或capability advertisement。另有显式、未接线的本机target build/stage/npm-pack verifier，共用loader的四项fixed descriptor、验证exact Cargo产物的Mach-O/ELF target header/digest与pre-commit空layout，以final hard-link作为唯一不rollback的commit point，并从自建`npm pack --ignore-scripts`临时包用有界pure-ustar inspector导入packed fixed loader、运行packed JS/native closed binding test。Node path API不足以抵抗恶意同uid最终目录换名竞态，本foundation不作该声明。当前证据仅Darwin arm64；没有Darwin x64/Linux、四target matrix、bit reproducibility、Dashboard bundle、签名/notarization、minimum-OS/glibc/SDK、provenance或production wiring，空allowlist下仍没有qualified real open或actual opened JS transaction。
- T1 authority injection：让 `RelayV2BrokerCredentialAuthority` 只通过 port 读写 opaque bytes，并保留 external continuity/业务状态机；专项测试可继续使用 in-memory fake，但它不是 E0 production authority。显式default-off injection/composition已实现；可用的真实注入仍等待qualified E0 backend/deployment、native qualification以及真实public TLS/network/device与ready-loss验收证据；现有default-off public lifecycle root不替代这些证据。
- P1 loader：当前已有可注入显式default-off Broker composition的target/N-API/fixed-artifact optional loader foundation，按 closed capability/open/error union 调用 N0 wrapper；只有固定目标 artifact 自身确实缺失才映射为 `unsupported/native_artifact_missing`。它精确传 caller-owned absolute `trustedHome` 与 frozen admission limit，不产生 overall ready；只有 open+self-check+T1 continuity 全部成功才允许未来 authority 宣告 ready，invalid/unsupported 都保持 v2 unavailable。

E0 external contract、N1独立纯Rust binary/publication core、N0.2 spec/error foundation、N0.4 shared platform lifecycle owner、N2/N3 platform adapter foundations、N4 raw N-API binding foundation、P1 optional loader foundation与T1 credential authority source foundation已实现；显式default-off Broker production composition现会闭合loader、E0 binding/opener、credential authority、WSS/HTTP与close owner；相邻public lifecycle root接管caller-supplied `node:https.Server`的request/upgrade/listen/drain，但qualified E0 backend/deployment仍未实现。N0.3只冻结 revision 2 policy；空 durability allowlist使platform-adapter-qualified real open与actual opened JS transaction不可达，不能产生ready。显式、未接线的build/stage/npm-pack verification foundation当前只在Darwin arm64验证exact Cargo target header、fixed stage/tar/unpacked layout与closed binding；不覆盖Darwin x64、Linux targets、四target matrix、bit reproducibility、Dashboard bundle、签名/notarization、minimum-OS/glibc/SDK、provenance、真实kernel lock/filesystem/fork/power-loss或opened transaction。T1 已在现有 credential authority owner 内补齐未接线的 role=host bootstrap authority source foundation：管理侧一次性 `twhostboot2` selector+secret、per-secret失败耗尽、source admission、fresh host grant/credential与exact-response replay在authority专项层可达，并以显式envelope revision兼容读取旧合法state。Credential authority 的 enrollment create/redeem、client/host refresh、host reauthentication 与 host bootstrap API，以及 B1 ingress adapter，均可在隔离模块和专项测试中调用；B1/B4 已由上述default-off public root接到HTTP lifecycle，但默认CLI不调用且qualified E0 activation不可达，因此这些流程仍没有qualified外部生产HTTP路径，也不形成production ready/capability/enrollment或shipping声明。现由同一activated composition采用的live authorization/fence owner在credential authority owner内durably发布grant revoke与kid removal exact invalidation receipt，由BrokerCore用trusted time处理expiry、拒绝stale attach/auth-control/route/frame，并在authority首次withdraw时同步全局latch；once-only signal只携带typed symbolic reason与connection incarnation；同composition采用的transport close coordinator 已消费该 signal 并实现 4401/4403/1013 与 5000ms force-destroy policy，但默认CLI不调用public root，且qualified real public TLS/network/device/ready-loss证据仍缺失。T2 response replay-key rotation lifecycle 现由同一 credential authority 的私有 envelope v3 唯一拥有：bounded active + decrypt-only keyring、record exact key id、旧 v1/v2 单 key envelope 与 ciphertext/TTL 无损迁移、持久 rotationId 幂等、key-id non-reuse 和 fatal decode/AEAD 闭合均在专项层可达；它未接 production 管理入口/composition，不修改 public wire，也不产生 ready/capability。当前 external contract/native core/common/adapters/binding、in-memory wrapper/authority 与 loader evidence 分别证明冻结语义或各自 foundation 边界，不是跨进程 lock、filesystem、power-loss durability、真实双进程/网络/灾备或 production continuity readiness 证据；仍无Dashboard/production shipping、qualified authority activation、qualified real public-TLS/network/device wiring或continuity readiness。此前的 unsafe BAU path/JSON 设计已明确未通过 native security acceptance且未纳入当前交付源码；后续 lane 不得修补、复用或重新引入其 path rename/unlink，也不得自动迁移、删除或清理可能遗留的 prototype state/lock/temp artifact。任一 lane 单独完成都不启用 production v2、enrollment或六项 capability，也不建立到 BAU 设计或 v1 的 fallback。

B4四端点credential HTTPS ingress现由显式default-off activated Broker composition采用，并复用 B1 的严格 HTTP boundary；默认CLI不注入且qualified E0/native仍不可用，因此不改变上述 production NO-GO。

显式 default-off 的 Broker shipping root 与 local privileged admin seam 已实现（`src/relay/v2/brokerShippingRoot.ts`）：reference-only runtime profile 加 deployment 注入的 privileged resolver、external continuity attempt provider 与 native state-store loader 装配现有 production composition 与 public lifecycle root，profile/inputs validate 与 durable authority open 先于 listen，启动失败 reverse-order rollback，admin bootstrap secret 只同步交付调用方受限 sink，public route 无 admin 端点。`relay-server` CLI 仅在显式 `--v2-profile` 时选择该 root，且只经唯一 default-off trusted deployment activation/source owner（`src/relay/v2/brokerShippingDeploymentSource.ts`）：TLS/issuer keyring/E0 material 只来自 trustedHome 固定 namespace（`.tmux-worktree/relay-v2-broker-deployment/`）按严格 identifier 映射到固定 filename/schema 的 fd-bound regular-file/no-symlink、owner、exact 0600/0700、bounded 私有文件（JSON keyring/workload-header 做 closed-schema 校验，TLS PEM/CA/mTLS cert/key 只做 owner/0600/nlink=1/bounded secure-read，内容由 TLS/E0 消费边界验证），复用既有 fixed native loader 与 Node E0 attempt provider，错误 redacted；任何缺失/unsafe/malformed/unqualified（含 `qualifiedRecords=[]` 的 unqualified native）仍在监听或 native mutation 前 fail closed，无 v1 fallback。native `qualifiedRecords=[]`、默认 Relay v1 行为与整体 NO-GO 不变。

### B. relay-server / broker

B 内部可以按持久认证控制面、在线目录与 carrier router 三条 lane 并行，三者只通过明确的 auth context 和 connector/route contract 连接。

工作边界：

- credential authority 的 enrollment create/redeem、client/host refresh、host reauthentication 与 host bootstrap API、严格的 B1 `POST /v2/hosts/bootstrap` ingress adapter，以及 B4 四端点 credential HTTPS ingress foundation，均已在隔离模块和专项测试中可调用。B1/B4 只做 credential admission、bounded read、closed decode/mapping并调用 authority 窄 port；它们不构造 authority/native store/server，只由显式default-off activated Broker composition采用；默认CLI不注入且qualified E0/native仍不可用，因此这些流程没有外部生产 HTTP 可达路径，不产生 ready/capability，也不能宣告已经交付。
- issuer keyring、一次性 client enrollment、host bootstrap、refresh rotation、exact response replay、revoke 和 socket expiry。
- credential business authority 只经 N0 port 的 T1 injection 使用 native store；broker composition 不接收 storage path，也不拥有 native cleanup。
- broker/composition拥有`broker-credential.v1` ready-loss生产fence：T1同步撤回credential admission后，必须同步阻止新Upgrade/route/auth-control与既有连接业务frame，再由已实现的 isolated close policy 以 5000ms deadline close，并在到期时 force-destroy；production composition 必须显式采用并接线，external adapter 不选择 public close code 或 deadline。`agent-transcript-lifecycle.v1` authority failure不进入该全局fence。
- 独立 v1/v2 Upgrade dispatch；twcap2 只形成 v2 auth context，legacy shared secret 只形成 v1 route。
- brokerEpoch、授权 host 视图、host registration、duplicate/SUPERSEDED 仲裁和 presence。
- routeId/routeFence、双向 carrier sequence、公平调度、route/carrier backpressure 和结构化 pre-forward error。
- Broker Host/client WSS ingress 已在 socket 层执行冻结的 4408 handshake deadline（host.hello 5 秒、client.hello 5 秒、host.welcome 10 秒），一次性 token-scoped timer，scheduler 失败 fail closed 为 1013；Broker `host.auth_expiring` 的 `refreshRecommendedAtMs` authority/policy 与到期前 60 秒调度 owner 仍未交付。

验收：

- exchange/bootstrap/refresh 的 ACK 丢失在 retention 内精确重放同一 credential；secret 只轮换一次且不进入 URL、日志或普通业务帧。
- response replay-key rotation 的同 rotationId 重试只产生一个 active key；新 record exact 绑定 active key id，旧 key 仅在其全部 record 原 TTL 到期后移除。旧单 key state/ciphertext 不在读取时重加密或延长 TTL，unknown key、AEAD failure 和 malformed keyring 均撤回 authority 而不是 replay miss。
- revoke、expiry、kid removal 和 role/host mismatch 在规定 commit point 后阻止新 Upgrade/帧并关闭已有连接。
- `host.registered` 前不发布 online；同 hostInstanceId 拒绝 newcomer，不同 instance 原子 supersede loser且无中间 offline。
- 旧 connectorId、routeFence 或 sequence 不能影响 winner；1 MiB route、16 MiB carrier和 frame-count 上限 fail closed且不饿死控制消息。
- broker 不产生 command status/result、不保存 Session/ledger/eventSeq/ring，也不翻译 v1/v2 payload。


### H0. relay-host 事务状态与进程谱系

这是 host 内唯一需要先收敛的短依赖。它不是通用 service 层，而是 hostEpoch、命令、materialized resource 和 event cursor 的同一事务 owner。

工作边界：

- 0600、原子、可检测 rollback/corruption 的事务状态库。
- hostEpoch continuity、每进程 hostInstanceId、opaque scope/session identity、revision/eventSeq 分配和 serializer seam。
- v2 credential/profile/status namespace 与 v1 完全分离。

验收：

- 正常进程或网络重启保持 hostEpoch；数据库丢失、损坏、回滚或部分恢复更换 hostEpoch并拒绝沿用旧 cursor。
- 同名 backend 重建产生新 sessionId；partial/unreachable scan 不删除或按名称重定向旧 identity。
- revision、eventSeq、materialized mutation 和需要关联的命令状态能在同一事务边界提交。

### H1. relay-host command plane

H1 在 H0 的事务接口上独立实现 ledger/executor；底层 mutation 继续调用目标主机的 canonical `tw rpc` 和 terminal-control，不复制 git/tmux lifecycle。

工作边界：

- expectedHostEpoch、严格 schema、request fingerprint、dedupe window、principal-scoped ledger和 query。
- `create_worktree`、`create_terminal`、`send_agent_message`、`kill_session` 四类固定 operation。
- ACCEPTED/RUNNING/SUCCEEDED/FAILED/IN_DOUBT、24 小时结果和 7 天 tombstone。
- canonical structured mutation process adapter 已实现 command executor 的 `process` port：每次 execute 经 config foundation queryPort 的 live target generation 重解析 local/SSH target authority，严格 `tw rpc-v2` argv、byte/timeout 上限与 exact outcome，retired generation fail closed；但仍无 production 构造/注入 callsite。create target 的 target-side catalog observation/revision/fence 现已交付为显式 default-off foundation：companion ABI `contracts/tw-rpc/create-target-observation-v1`（独立 version、不扩展 frozen TW RPC v2、无 fallback）定义 observe/admit 两阶段，target 侧 `tw create-target-observation-v1` entrypoint 在 admit 时同进程现场重新观察并 exact 比较 revision/arguments/闭集 execution——revision 覆盖 config project、canonical realpath、canonical git-dir/common-dir identity digest 与 exact resolved base-ref OID，观察输入闭集内的漂移（含 OID/identity 漂移）零副作用 `OBSERVATION_STALE`，已证明边界为 observe→admit 间 target 侧 reobserve exact 比较，残余仅为 reobserve→mutation 间不可约本地 TOCTOU；Relay 侧 observation authority/store 保留在独立 authority module，由 admission 模块的 pair issuer 构造唯一实例并封入 record；claim wrapper、admission adapter 与 pair registry 共置 admission 模块，两个组件是模块私有 class，无公开 constructor 或 registry opener；唯一入口 `issueRelayV2CanonicalCreateTargetExecutionPairV1({ owner, runner, inner, ... })` 对所有 options 做一次 exact own-data 捕获（accessor/Proxy/symbol/多余 key 同步 fail closed）后打开 owner 的 same-owner bundle、构造唯一 observation store，并只返回 frozen null-prototype 空 ticket；私有 wrapper 与私有 adapter 延迟到一次性 H1 factory 内构造（base non-create process 在签发时封入），组件不可取得、hybrid 不可表达。Host canonical composition 以唯一 `createTargetExecutionPair` option 接收 ticket，在 hostState.read/H2/任何 lookup 前经 `captureRelayV2CanonicalCreateTargetH1FactoryV1` 同步 exactly-once capture（foreign/复制/replay 在该处 fail closed），所得一次性 lexical closure 被调用时对 input 做一次 exact own-data 捕获、装配 command target resolver/executor 并直接 openRecoveredAuthority，只返回 opaque readiness candidate；evidence 携带 catalogRevision，fence 同步一次性消费，admitted store 以不碰撞 opaque authority token 为唯一键（token 保留 per-实例唯一 digest 输入）、按逐-evidence exact identity（operation/arguments/闭集 execution 与携带 fenced command fingerprint 的 reservationCorrelation）恰一次消费，相同 execution 的并发 evidence 各自独立成行，create_terminal 的 admitted arguments 与 executor mutation 共享同一 exact canonical 形式（canonical cwd + derived label)；未接 production composition，无 capability advertisement 与 qualified 真实设备证据。dedupe window lifetime 已收敛为 H1 command plane 独占的固定策略：accept 窗口固定 15 分钟，`queryUntilMs` 固定覆盖 accept 截止后 `commandDedupeRetentionMs`（7 天），完整 result 保留 24 小时后压缩为 tombstone 至第 7 天；调用方不能注入其他 accept/query 期限。

验收：

- epoch mismatch 在 fingerprint/ledger 前拒绝且不留下行；相同 commandId/fingerprint不重复执行，不同 fingerprint 冲突。
- 第一次外部副作用前持久 RUNNING；正文/Enter 中断或无法证明边界时进入 IN_DOUBT，绝不自动重放。
- query 的八种状态、result/error nullability、window reissue规则全部通过 golden 和故障注入。
- 四类 mutation 只进入 canonical owner；v1 alias、名称 fallback、partial authority判断和 broker 代发 status 均被拒绝。

### H2. relay-host resource、snapshot 与 event

H2 使用现有 local/SSH discovery 作为查询 adapter，但以 H0 materialized state 为网络权威；不能在 snapshot request 中临时扫描并拼接事实。

本计划只定义 H2 工作边界与验收状态，不作为当前交付事实来源；当前实现与运行边界统一引用 [`README.md`](../README.md) 和 [`ARCHITECTURE.md`](../ARCHITECTURE.md)。在 `relay-host`/wire/G2 composition 与 capability gate 完成前，本工作包的 foundation 验收不得被解释为 runtime capability 已交付。

工作边界：

- scope/session materialization、完整与 partial reconciliation、per-dimension revision 和 host eventSeq。
- hello barrier、`scopes/sessions.snapshot` convenience API、pinned `state.snapshot` spool、cursor/digest/quota/release。
- H2 spool 已有 one-shot fresh-install bootstrap port：零 recovered pinned cut 时由同一 materialized owner 的 reconcile 捕获 fresh cut-source candidate 并复用同一 private canonical pair 完成 activation；任何 active cut/reservation/tombstone/in-flight build 或已签发过时返回 null，与 recovered-candidate 路径结构性互斥。仍属 default-off composition，不产生 capability。

验收：

- 只有完整扫描产生 delete；SSH 不可达只更新 reachability/stale并保留 Session。
- welcome 捕获 W、注册 subscriber 和入队 response 线性化；并发提交必在 W 内或从 W+1 连续投递。
- 单维 snapshot 永不推进全局 cursor；完整 cut 只有所有 chunk 的顺序、数量、byte 数和 digest 通过后才可原子替换。
- 断线续传、旧 cut 落后新 welcome、expiry、release 幂等、per-principal/per-host quota和 orphan cleanup都有故障注入证据。

### H3. relay-host terminal manager

H3 是 process-scoped terminal authority，复用现有 local/SSH byte transport和 terminal-control single writer，但不复用 v1 stream map、stream ID或 lease identity。

existing terminal-control protocol adapter现由canonical default-off Host composition采用。它只接受显式注入的 bounded request port，把 H3 acquire/renew/release/continuity/input/resize 翻译为现有 closed request；lease、operation 和 backend side-effect 事实仍由 `src/terminalControl/authority.ts` 独占。adapter 不 auto-start daemon、不重发 input/resize、不保存平行状态，也没有 direct tmux fallback；`relayHost run()` 的 CLI/public production activation 只经显式 `--profile v2` 进入 default-off shipping root 并在无受信注入时 fail closed，默认仍未接线；readiness → one-shot pre-carrier claim → host.hello 的 capability advertisement 链已 default-off 闭合；canonical composition已闭合H0/H1/H2/H3与carrier owner，因此该 foundation 不改变本工作包或 G2 的未完成状态。Node terminal manager 已修正 durable mode=new open 重试在 `stream_lost` reset 中丢失 `replayFromOffset` correlation 的缺陷（`new`/`resumed` 均携带 durable offset，仅 `reset` 为 null）；terminal byte plane 仍只有注入的 byte-backend port，Relay byte-plane production atomic byte observation owner/ABI 仍未交付；local terminal-control 侧已交付 process-local exact read observation owner/ABI（`src/terminalControl/authority.ts`：claim 同步单消费，canonical lock 内重新 inspect live backend、重验 target record 与 incarnation proof、prepareOutput 并登记 observer 后返回 controlEpoch/outputGeneration/outputCursor；observer 活跃时最后 interactive release 回 FREE 但不 reset output generation，stale observer 被 retire 而不抑制后续 release 的 deferred reset，observer close 先完成 reset/持久化再注销、失败保留可重试；remote exact compound 以 `observe`/`tail`/幂等 `close-observe` 帧在同一 canonical child 贯穿观察与后续 lease lifecycle，adapter close 按 rollback-claim→close-observation 顺序 drain，不引入 generic request port，也不复制 ring/tmux）。host 侧 default-off canonical composition 另已在未注入 byte-backend 时默认装配 exact-observation byte plane（open 只把 admitted claim 原子消费为只读 observation 并从其 outputCursor tail，首个 input 经 lazy lease 在同一 compound channel 重 prepare→fence→consume，release 后回 observing 继续 tail，cleanup 经可重试 barrier、失败留存 fenced record 由 adapter.close() 重 drain 并上抛）；这只是 host-side internal 装配事实，不改变本工作包或 G2 的未完成状态。

工作边界：

- generation、raw-byte offset ring、resume token、open/close dedupe、route rebind fence。
- output credit、inputSeq/hash ACK、resizeSeq/ACK、detached lease和 host-level quota。

验收：

- open/reset/close response 丢失只重放原 control result，不创建第二个 PTY或关闭新 generation。
- resumed stream 严格按 opened→replay→live→closed；offset 无缺口或重复，旧 route input 永久失效。
- input/resize 只在 backend/controller 接受后累计 ACK；generation 改变时未 ACK input为不确定且不写入新 PTY。
- 4 MiB/stream、64 MiB/host、512 KiB credit、120 秒 lease及 control-record 上限在压力下有界；hostInstanceId 改变必须 reset。

Host侧另有reference-only production profile store与显式default-off privileged intake：intake只读existing profile，消费外部已拥有的atomic cell与可选privileged byte source，构造同一Vault/credential authority/HTTPS coordinator并打开canonical Host composition。它不选择native loader或secret source；Host `qualifiedRecords=[]`，因此真实qualified intake、TLS与shipping路径仍不可达。显式 default-off 的 Host shipping root（`src/relay/v2/hostShippingRoot.ts`）现已把该链路与已启动的 materialized reconcile lifecycle owner（startup scan 即首轮 authoritative reconcile）、单一 opaque one-shot create target execution pair、canonical H0–H3 composition 与同 lineage 的 reauthentication lifecycle owner 闭合为单一 owner，统一持有 connector start/stop、signal fence、reverse-order startup rollback 与 close-and-drain；`relay-host --profile v2` 只选择该 root，但 CLI 无受信 native/deployment 注入渠道，在任何 profile/store/socket 前 fail closed，绝不回退 v1。Host native qualification、Host trusted deployment source 与真实 TLS/device 证据仍缺失，default-off 与整体 NO-GO 不变。

### D. macOS Dashboard

Dashboard 与 B/H 并行开发 domain state、fake backend和 UI；只有真实 enrollment/credential 操作进入 Tauri/bundled `tw` adapter，React 不直接持有 secret或 WebSocket。 当前 default-off canonical Host production composition 已在 facade 发布前依次激活 H0/H3，并可选唯一拥有同 lineage 的 protocol-v2 Dashboard management session，省略配置时 facade 不变；Tauri bundled management supervisor 的 production expected protocol 已固定为 v2，v1 ready 或其他 mismatch 均 fail closed 且无 fallback。hidden Node child现固定使用exact protocol v2，但在没有qualified same-lineage Host inputs时对所有operation只返回fail-closed `UNAVAILABLE`；`relay-host`/`relay-server` CLI 与 E0 仍未接真实 production owner，因此 Dashboard management 和 Relay v2 整体继续 NO-GO，且没有新增 qualification、TLS、真实设备或签名证据。

工作边界：

- 明确区分 v1 shared-secret profile 与 v2 host/client credential状态，不原地升级或共用字段。
- host bootstrap/refresh 状态、connector registration/capability，以及 client enrollment create和已知 grant revoke；基础契约没有设备枚举 API，不从本地记录伪造设备列表。
- v2 QR review信息、过期/撤销/重建流程，以及 SUPERSEDED 退出码 78 的进程编排。
- broker issuer/bootstrap、host credential、enrollment attempt和grant状态由 Node 本地管理接口持有；Tauri只编排，不能另建issuer、keyring或credential owner。Node protocol-v2 authority/session与same-lineage Host credential/connector adapters已由可选canonical Host composition闭合；renderer/model仍使用fake；bundled child虽已固定protocol v2，但只返回`UNAVAILABLE`，qualified Host session与CLI activation仍不可用。

验收：

- connector 未 `host.registered` 或基础能力不完整时，不生成 v2 enrollment、不显示可用二维码。
- QR 只含一次性 enrollment code，不含 access/refresh token；敏感值不进日志、clipboard telemetry或普通持久状态。
- host bootstrap secret不经过命令参数、环境变量或renderer IPC，只能使用Node接口定义的stdin/0600 handoff；Dashboard持久层只保存非敏感endpoint、credential kind和credential reference。
- v1 配对继续走原 shared-secret路径；v2 失败只给可执行错误，不降级、覆盖或旋转 v1 profile。
- Tauri、fake/preview backend、domain types和 platform boundary 同步；进程替换、重启和 revoke由可观察行为测试覆盖。
- v2 readiness来自`host.registered`与六项能力的完整交集，不能沿用v1单个`connected`布尔值，也不能把connector ready描述成手机在线。
- issuer/broker setup必须幂等且保留既有key/grant；当前适合v1的kill/recreate或Quick Tunnel换URL流程不能默认成为持久v2修复路径。

### A. Android v2 client

Android 的 profile/credential、codec/actor、Room state、Outbox、terminal和 UI 可以按六条 lane 并行。它们使用独立 v2 interfaces和 fake actor events集成；`RelayV1ConnectionActor`、v1 codec、v1 Room identity和升级 shim保持原样。

当前admitted explicit-v2 base runtime已接Room state/Outbox、bounded WSS、`host.presence`/`hosts.snapshot`恢复、durable terminal journal/parser/actor/Compose链路，以及被空optional capability关闭的Agent/notification owner。`auth.expiring` exact rollover已接入。本地 admitted-v2 用户驱动的 self-revoke quarantine/confirmed cleanup saga 已闭合但仍default-off；没有真实TLS/device/qualification/signing/release证据，因而不构成production availability或GO。这些事实不改变默认shipping v1、capability default-off、真实TLS/device/signing/release缺失与整体NO-GO。

工作边界：

- v2 enrollment review、Keystore credential blob、exchange/refresh CAS和 profile disconnect barrier。
- 独立 v2 codec/actor、handshake、capability intersection、bounded queues和 reconnect/query/resync reducer。
- hostEpoch/scopeId/sessionId Room namespace、snapshot staging/event buffer和原子 cut commit。
- commandId Outbox/query/reissue/AMBIGUOUS 收敛。
- terminal generation/offset/inputSeq/resizeSeq checkpoint与 xterm parser ACK。
- capability-aware UI；基础 v2 不显示尚未协商的 Agent transcript/lifecycle。

验收：

- `tmuxworktree://enroll` 只预填 review；用户确认前不兑换、不连接、不覆盖 profile，token只存 Keystore保护的版本化 blob。
- v2 profile只 offer v2；auth、schema、capability或 host dialect失败不创建临时 v1 profile。
- fresh/matched/behind/host-epoch-changed/ahead 五种 hello处置、gap snapshot和 event buffer溢出均按契约收敛。
- Outbox只在权威 `not_accepted` 证明下重发或 reissue；in_doubt/expired/unknown/lineage丢失进入不自动重发的状态。
- xterm parser callback 后才推进 offset/credit；Activity/WebView parser continuity丢失时 reset，不把旧 checkpoint接到空 terminal。
- queue、Room staging、WebView pending bytes和 UI effect都有硬上限；饱和触发明确 reset/query/resync而非静默丢事件。

### X. Agent transcript、lifecycle 与通知 extension

X 的 contract/authority spike 与基础 v2 并行，不阻塞 C/B/H/A。它使用独立 capability/manifest；基础六项完整实现也不能自动视为支持 X。

首个 extension slice 只覆盖结构化 user/agent text entry、turn/run lifecycle和由 lifecycle event驱动的通知。原始 terminal transcript、tool-call全文、附件和离线 push不是默认包含项。

工作边界：

- 选择由 Agent SDK/hook 或受控 Agent adapter产生的结构化权威事件；`tw`/relay-host只接收可验证事件，不解析 terminal文本猜测。
- 冻结 session/run/turn/entry identity、顺序/cursor、snapshot/page、重放/去重、retention、redaction和删除语义。
- 冻结 lifecycle状态及作用域，至少明确 running、waiting-for-user、failed、completed针对 turn还是 run，以及 Agent重启/迟到事件的处理。
- relay-host持久事件store与Android Room/UI consumer分开实现；Android对未协商或不支持的Agent显示 unavailable，不展示模拟状态。
- 收到结构化状态事件后的本地通知单独验收。若要求 App被杀或长期离线仍通知，另建受认证 push工作包；常驻 WebSocket不能作为该能力的证据。

验收：

- 同一 turn 的重复、乱序、断线重放和迟到终态得到确定结果；entry ID不因文本相同被错误合并。
- 手机发送状态来自 command ledger，Agent处理/回复状态来自 extension event，两者在UI和存储中不互相覆盖。
- 不支持结构化事件的 Agent仍可使用基础 session/terminal能力，但 transcript/lifecycle明确不可用。
- Node/Android分别消费独立 extension fixture；未协商时双方不发送未知frame，extension失败不破坏基础 v2 route。
- external Agent namespace故障注入必须覆盖existing store mapping的三组输入与`agentAuthorityError=AGENT_AUTHORITY_STORE_CONTINUITY_UNAVAILABLE|COMMIT_UNCERTAIN|CORRUPT`输出，并只隔离extension；unavailable case保留timeline/cache lineage且next action仅repair/reopen，独立corrupt case才允许reset/new epoch。基础credential readiness、Upgrade/route、command与terminal继续，既有基础v2 connection不因extension failure全局close。
- 通知去重、权限拒绝、锁屏内容策略和 profile切换隔离有Android行为证据；离线 push只有完成独立安全/后台验收后才可宣告。

### R. 生产与发布

R 可以提前准备 TLS、签名、升级矩阵和可观测性，但不能替代协议验收。

验收：

- 生产使用受信 WSS/HTTPS，secret/token不进入日志、URL、crash report或无权限持久层。
- Android签名、versionCode递增、1.x→当前升级、v1/v2 profile共存、revoke/refresh和真实设备网络切换完成验证。
- broker/host守护、SUPERSEDED、状态库备份/损坏、quota/backpressure和恢复操作有运行手册与隔离演练。
- unsigned Release、模拟器 loopback或本地 tunnel只能作为构建/开发证据，不能描述为生产发布。

## 仅保留的串行门槛

模块开发不按阶段串行，只有下列互操作或安全 commit point必须按顺序通过：

| Gate | 必须先完成 | Gate 通过的证据 | Gate 前禁止事项 |
| --- | --- | --- | --- |
| G1：broker↔host carrier | B 的 auth/directory/router与 H 的 carrier actor各自 simulator验收 | host register、route fencing、reauth、supersede、backpressure隔离联调 | 不接真实Android，不生成client enrollment |
| G2：host基础集合 | G1；H0/H1/H2/H3各自验收并经同一 host route集成 | command query、gap snapshot、terminal resume和crash/pressure故障注入 | 不宣告六项requiredCapabilities中的任何子集 |
| G3：端到端基础 v2 | G1-G2、D和A完成；E0 production choices/backend/injection/fence通过验收；共享 codec conformance baseline持续通过 | broker↔host↔Android真实WSS或等价隔离环境；五种hello、命令、snapshot、terminal、refresh/revoke、external restart/failover/ready-loss全链路 | 不默认启用v2配对，不替换v1 profile |
| G4：Agent extension | G3；X contract、host authority/store和Android consumer完成 | transcript/lifecycle重放、断线、去重、unsupported Agent、通知及external Agent namespace failure隔离跨端验收 | 不宣告Agent reply/state/notification capability |
| G5：生产发布 | G3；若发布X则还需G4；并完成R | 已签名构建、真实设备升级、受信TLS、凭证与恢复检查 | 不把build、unsigned APK或模拟器结果称为发布 |

G1-G2 通过前可以继续并行开发和 simulator验证，但能力开放必须原子：基础六项只在 G2/G3 集成证明完整时一起提供。任何 auth、dialect、schema、capability或 continuity失败都不得进入 v1 fallback；共享 codec conformance baseline 在每个 gate 都是必跑回归，而不是新的串行工作包。

## 计划维护与旧内容清理

- 本文件是唯一的 Relay v2 实施拆分入口；Android、Dashboard或运维文档不再维护各自的 A/B/C 阶段清单。
- 当前实现变化写入 `ARCHITECTURE.md` 和对应专题文档；规范变化进入显式版本化 contract；临时进度、负责人、日期、测试数量和分支状态不写入长期文档。
- 已完成或失效的实施步骤直接从本文件删除；需要追溯时使用 Git 历史，不保留“已完成 roadmap”作为架构基线。
- 冻结契约的 §8–§10、terminal ownership companion和仍在支持窗口内的 Android migration shim不是旧计划，不能因清理 roadmap而删除。
