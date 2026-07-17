# Relay v2 Android-first Contract

状态：**Frozen contract — v2.0.0-android-first；codec conformance 基础已落地，runtime 尚未交付，不可宣告互操作或生产可用**

范围：Android、relay-server、relay-host 的首个可互操作 v2 slice。

当前仓库的 Dashboard、relay-server、relay-host 和 Android connection actor 仍只运行 Relay v1。Node 与 Android 已有相互独立的 strict v2 codec，共同消费 `contracts/relay/v2` fixture，但尚未接入 broker/host/client runtime。本文定义后续 v2 实现边界；任何一端都不得仅凭本文、fixture 或 codec 存在而发布 v2 capability、生成 v2 配对二维码或把 v1 credential 当作 v2 credential。

Broker credential 本地持久化另有独立的 frozen [native state-store contract revision 2](../contracts/relay/v2/broker-credential-state-store-v1/README.md)；N-API interface、capability storage、binary/header、private-location derivation与fixture仍各自为 v1，artifact、ABI和bytes未变化。Revision 2冻结 exact native account-home/mode/ACL secure-open、qualification-before-registry/mutation、final A/B/C descriptor proof、traditional process-owned `F_SETLK`、shared registry/PID/fork/final-close语义，以及 deny-by-default durability qualification；`qualifiedRecords=[]`且首条 record必须新增 contract revision，因此所有真实 open目前必须在 registry/mutation前 `DURABILITY_UNSUPPORTED`。它仍冻结 raw N-API closed wrapper、deep port、single descriptor/fixed-offset binary fixture与 positional two-barrier publication，不修改本文 public wire。当前已有未接线的独立纯 Rust binary/publication core、单点消费 manifest-derived container spec并拥有显式eager process token、pre-fd registry、PID/descriptor fence、panic-aware poison、common-owned exactly-once final close、private N1 bridge与opaque wrappers的platform-common lifecycle owner、Darwin/Linux platform adapter foundations、target-selected raw N-API binding foundation、显式 target/N-API/fixed-artifact optional loader，以及通过 opaque port 独占 credential state 与 external continuity 的authority source foundation。Platform-common本身不接`trustedHome`、path、syscall、filesystem/durability或N-API；adapter只通过其public lifecycle seam提供target open，binding在module init eager exactly-once捕获process token并只把`ProcessBound*`与target open seam转换为冻结raw ABI。空qualification allowlist使platform-adapter-qualified real open和actual opened JavaScript transaction均不可达。当前binding evidence仅限本机Darwin arm64临时本地产物的focused Node require、exact export/prototype safety、capability decode与closed invalid open；没有固定或分发artifact。Capability supported 不是 ready；open+self-check 后仍须 authority 完成 external continuity，并由 future production composition 注入整体链路。Existing unknown/corrupt/unsafe/identity/durability failure preserving-invalid，不能伪装 missing/unsupported。当前仍没有host bootstrap/成功credential流、artifact packaging/`npm pack`/Dashboard bundle、production authority injection/composition/wiring或continuity readiness；现有Rust/native/in-memory/loader evidence也不是qualified real open、真实filesystem/kernel lock/fork/power-loss、真实网络或production continuity证据。此前被拒绝的BAU path/JSON设计未纳入当前交付源码，不得重引入、迁移其artifact或作为fallback。Production v2仍disabled，Relay v1不依赖该native contract。

共享 continuity port 的 future external backend/adapter 语义由独立的 frozen [external continuity authority v1 contract](../contracts/relay/v2/external-continuity-authority-v1/README.md) 定义，不修改本文 public wire。external backend 只拥有按 `anchorId` 的 rollback-independent durable monotonic linearizable read/CAS record与 terminal lifecycle；`RelayV2ContinuityAnchor` 继续拥有 local-state-before-anchor ordering、唯一一代 crash-window reconcile和bounded timeout，`RelayV2BrokerCredentialAuthority`继续拥有 credential state、ready withdrawal与现有 closed error mapping，broker core只消费 auth-control authority。future adapter只closed-decode transport outer envelope/error并把success result作为untrusted unknown交给existing continuity decoder，禁止补`protocolVersion`/`anchorId`、复制checkpoint decoder或合成authority字段。outer HTTPS固定exact endpoint `POST`、no redirects、identity encoding/no compression，请求固定JSON Accept/Content-Type及`Cache-Control: no-store`，response也要求`Cache-Control: no-store`；只有status 200与exact JSON Content-Type通过header gate后才解码closed envelope，任何非200或header mismatch都在读取前按boundary failure处理且不得解析或回显proxy body。该boundary复用本文manifest的16384-byte body、depth 8、total keys 32及strict UTF-8/duplicate-key/trailing-JSON规则；workload credential不能随redirect转发。request identity按decoded closed tuple逐字段exact type/value比较，不依赖JSON key order或canonical serialization/hash。read transport/outer failure映射`ANCHOR_UNAVAILABLE`，well-formed read success中的malformed snapshot映射`INVALID_AUTHORITY_RESPONSE`；CAS的outer或inner malformed结果都映射`ANCHOR_COMMIT_UNCERTAIN`。该 contract 新定义的 auth/permission/quota/capacity/rate/timeout code只属于 external backend/adapter internal namespace，不能作为 Relay frame error或借用 handshake/backpressure close code。

当前仓库没有上述 production backend、transport/auth/config adapter、stable provisioning/ACL、真实 restart/旧备份/灾备 failover证据、authority injection或 ready 后 active-connection fence。future composition只能按 native store open+self-check → external authority injection → credential authority open/reconcile → synchronous admission/connection fence → broker auth-control injection 的顺序建立 ready；具体 close code与bounded close deadline仍须由 owning broker/composition contract先冻结，不能由 external adapter擅自选择。`broker-credential.v1`与`agent-transcript-lifecycle.v1`是独立 external namespace，使用不同 anchorId/ACL/reset/decommission/tombstone history；broker owner binding保持 provisioning提供的不透明稳定 identity，不从尚未冻结的 issuer/tenant credential字段推断。前者fatal failure必须撤credential ready/admission并全局fence基础v2 Upgrade/route/active data；后者精确复用现有extension store的`AGENT_AUTHORITY_STORE_CONTINUITY_UNAVAILABLE|COMMIT_UNCERTAIN|CORRUPT` mapping，只隔离Agent extension。unavailable保留可证明timeline/cache lineage并repair/reopen authority，不能reset/new epoch；只有独立corrupt/明确continuity loss才允许extension reset/new epoch。基础credential/route/command/terminal继续且不得全局close。任一 production choice或证据缺失时 adapter保持 NO-GO，v2不得 ready、enroll或advertise capability，也不得回退v1/BAU。

非规范性 companion：[`terminal-input-ownership-alignment.md`](terminal-input-ownership-alignment.md) 记录 Feishu Bridge、Dashboard、本地 CLI 与 Relay 共同操作同一 managed terminal 时的本地输入所有权对齐。该说明不修改本首版 frozen wire、六项 requiredCapabilities、任何 closed schema 或本契约错误表；本首版 adapter 在独立 local terminal-control authority 拒绝写入时使用错误表中既有的 `PERMISSION_DENIED`。未来的 `input.ownership.observe.v1` 是独立、可协商的 capability extension，不属于本首版契约。

非规范性实施拆分见 [`relay-v2-implementation-plan.md`](relay-v2-implementation-plan.md)。该计划只描述并行 owner、硬依赖和验收 Gate，不改变本文的 wire 语义，也不表示任何工作包已经完成。

不在本版：Agent 入站时间线、通知、附件、跨 relay-host 进程的终端续传、host event replay log。

本文中的 MUST、MUST NOT、SHOULD 按规范性词语理解。所有 UUID/ULID 示例均为不透明值，不允许客户端解析其结构。

## 1. 权威边界、身份和进程谱系

### 1.1 broker / relay-server

broker 继续是薄控制面，只负责：

- 持久管理 v2 issuer keyring、enrollment、refresh grant 和 revocation；这些是认证控制状态，不是 host 业务状态。
- 验证 WebSocket Upgrade 的 Authorization Bearer capability 和 grant 状态，并形成可信 auth context。
- WSS 终止、连接存活、临时 route、帧大小和基础 envelope 校验。
- 在线 host 目录、hosts.snapshot 和 host.presence。
- 按 hostId 路由 client 与 relay-host 消息。
- 在消息尚未到达 relay-host 前返回结构化路由错误。

broker 不得：

- 产生 command.status、command.result 或业务成功结果。
- 保存或推断 Scope、Session、command ledger、host eventSeq。
- 保存 terminal replay ring 或生成 terminal.closed。
- 因 client/host socket 断开伪造业务完成、terminal exit 或 terminal closed。
- 在 v1/v2 之间翻译业务消息。
- 从 legacy shared secret 合成 v2 principal、grant 或 capability。

broker 的在线目录由进程级 brokerEpoch 标识；对 role=client 暴露的 hostsRevision 是 claim hostId 的独立授权视图 revision，只在该 host 的可见事实变化时递增。broker 重启更换 brokerEpoch；客户端必须重新拉 hosts.snapshot。全局目录 revision 不得下发给单 host client。

### 1.2 v2 HMAC capability 身份

v2 只接受下面的 HTTP Upgrade 头：

~~~http
Authorization: Bearer twcap2.<payload-base64url>.<mac-base64url>
~~~

token 不得放在 URL query、Cookie、Sec-WebSocket-Protocol、client.hello、二维码日志或普通业务消息中；唯一例外是 §1.2.4 已建立 host carrier 上的专用 host.reauthenticate control。出现多个 Authorization、格式错误、过期或签名不匹配时，broker 在 Upgrade 阶段拒绝连接。

payload 是 UTF-8 JSON，冻结必填 claims：

~~~json
{
  "v": 2,
  "iss": "relay-issuer-id",
  "aud": "tw-relay-ws",
  "kid": "key-2026-07",
  "tokenUse": "access",
  "role": "client",
  "hostId": "mac-admin",
  "principalId": "principal-opaque-id",
  "grantId": "grant-uuid",
  "clientInstanceId": "android-install-uuid",
  "iat": 1783700000,
  "nbf": 1783700000,
  "exp": 1783703600,
  "jti": "token-instance-uuid"
}
~~~

签名定义：

~~~text
mac = HMAC-SHA256(secret[kid], ASCII("twcap2.") || payload-base64url)
~~~

验证要求：

- role 首版只能是 client 或 host。
- tokenUse 必须是 access，aud 必须精确匹配当前 broker 服务，iss 必须匹配其 issuer 配置。
- hostId 是单个精确 host，不支持通配符。
- principalId 是签发方分配的稳定、不透明授权主体。
- grantId 是可续期、可撤销授权的稳定 ID；jti 每个 access token 唯一。
- role=client 时 clientInstanceId 必填，且必须与 client.hello 一致；role=host 时该 claim 必须省略。clientInstanceId 仍不是 principal，不能扩张权限。
- iat、nbf、exp 必填；broker 允许的时钟偏差上限为 60 秒，access token 默认和最大 TTL 均为 1 小时。
- payload-base64url 必须无 padding，claims 使用 closed schema；重复键、未知键、类型错误或非 canonical base64url 都必须拒绝。
- HMAC 比较必须 constant-time；日志只能记录 iss、kid、role、hostId、principalId、grantId 和 jti，禁止记录 token。
- role=client 只能连接 claim 绑定的 hostId。
- role=host 只能注册 claim 绑定的 hostId。
- grant 必须仍有效、未撤销，且其 role、hostId、principalId、clientInstanceId 与 token 一致。

broker 将 role、hostId、principalId、grantId、clientInstanceId、jti、kid 和 exp 作为不可伪造的内部 auth context 注入 route。client/host 发往 broker 的入站公共 envelope 中出现 principalId、grantId 或 jti 时必须拒绝，绝不能覆盖后继续授权；broker 自己产生的 relay.welcome/auth.expiring 可信回显按 §2.2 fixed schema 处理。

#### 1.2.1 issuer keyring 与轮换

issuer keyring 是 broker 认证控制状态，必须持久化并在同一逻辑 broker 集群内一致。keyring 同时包含一个 active signing key 和零个或多个 verify-only key：

- 新 token 只使用 active key；kid 永不复用。
- 旧 key 至少保留到它最后签发的 access token 的最大 exp 加 60 秒时钟偏差；refresh 总是使用当前 active kid 签发新 access token。
- 删除仍可能验证有效 token 的 key 等价于紧急撤销，broker 必须同时关闭以该 kid 建立的在线连接。
- key material、enrollment code 和 refresh token 只保存于权限为 0600 的认证状态库；长期 verifier 只保存 enrollment/refresh secret 的 hash。唯一例外是下文 response-loss replay record，可在独立 replay key 下保存 exact response 的 AEAD ciphertext，绝不能保存明文，且必须按 10 分钟硬 TTL 删除。
- key rotation 不改变 brokerEpoch、hostEpoch、principalId 或 grantId。

#### 1.2.2 Dashboard enrollment

v2 pairing 不复用 Relay v1 shared secret。Dashboard 只能通过已经完成 host.registered 的 role=host carrier 为自己的 hostId 创建一次性 enrollment：

~~~json
{
  "carrierVersion": 1,
  "type": "enrollment.create",
  "requestId": "enroll-request-uuid",
  "connectorId": "connector-uuid",
  "payload": {
    "expiresInMs": 300000,
    "deviceLabel": null
  }
}
~~~

broker 返回：

~~~json
{
  "carrierVersion": 1,
  "type": "enrollment.created",
  "requestId": "enroll-request-uuid",
  "connectorId": "connector-uuid",
  "payload": {
    "deduplicated": false,
    "enrollmentId": "enrollment-uuid",
    "enrollmentCode": "twenroll2.opaque",
    "hostId": "mac-admin",
    "issuerUrl": "https://relay.example.com",
    "relayUrl": "wss://relay.example.com/client",
    "expiresAtMs": 1783700300000
  }
}
~~~

enrollment.create 的 requestId 是逻辑 attempt ID。broker 必须在创建 code 的同一事务中保存 10 分钟 exact enrollment.created AEAD replay record；相同 connectorId/requestId/payload 重试返回相同 enrollmentId/code/expiry且 deduplicated=true，不创建第二个 code。相同 requestId 不同 payload 返回 carrier.error(IDEMPOTENCY_CONFLICT)。

enrollmentCode 必须含至少 128 bit CSPRNG entropy，默认且最长有效 5 分钟，只能成功兑换一次，并绑定创建它的 hostId。broker 对每个 enrollmentId 最多允许 5 次失败、每来源 IP 每分钟最多 20 次 redeem；超限返回通用 RATE_LIMITED且不暴露 enrollment 是否存在，连续失败耗尽后原子作废 code。二维码使用固定格式：

~~~text
tmuxworktree://enroll?v=2&issuerUrl=<percent-encoded-https-url>&relayUrl=<percent-encoded-wss-url>&hostId=<percent-encoded-host-id>&enrollmentId=<percent-encoded-id>&enrollmentCode=<percent-encoded-code>
~~~

二维码和 Dashboard UI 不得包含 access token 或 refresh token；enrollmentCode 同样不得进入日志、剪贴板遥测或 URL 网络请求。Android 扫码后必须展示 issuer、relay 和 hostId 并要求用户确认，再用 HTTPS body 兑换：

~~~http
POST /v2/enrollments/redeem
Content-Type: application/json
Cache-Control: no-store
~~~

~~~json
{
  "exchangeAttemptId": "enrollment-exchange-uuid",
  "enrollmentId": "enrollment-uuid",
  "enrollmentCode": "twenroll2.opaque",
  "clientInstanceId": "android-install-uuid",
  "deviceLabel": "Pixel"
}
~~~

成功 response 必须使用 Cache-Control: no-store，并固定返回：

~~~json
{
  "exchangeAttemptId": "enrollment-exchange-uuid",
  "principalId": "principal-opaque-id",
  "grantId": "grant-uuid",
  "hostId": "mac-admin",
  "relayUrl": "wss://relay.example.com/client",
  "accessToken": "twcap2.payload.mac",
  "accessExpiresAtMs": 1783703600000,
  "refreshToken": "twref2.opaque",
  "refreshExpiresAtMs": 1786292000000
}
~~~

Android 必须把 refresh token 和当前 access token 保存在系统 credential storage；Room、SharedPreferences 明文、Intent、日志和 crash report 都不得包含它们。

#### 1.2.3 renew、revoke 与在线连接到期

Android 使用 HTTPS body 续期，refresh token 每次成功使用后立即轮换，旧 token 不得再次使用：

~~~http
POST /v2/tokens/refresh
Content-Type: application/json
Cache-Control: no-store
~~~

~~~json
{
  "refreshAttemptId": "refresh-attempt-uuid",
  "grantId": "grant-uuid",
  "clientInstanceId": "android-install-uuid",
  "refreshToken": "twref2.opaque"
}
~~~

成功 response 使用 Cache-Control: no-store，closed schema 固定为：

~~~json
{
  "refreshAttemptId": "refresh-attempt-uuid",
  "principalId": "principal-opaque-id",
  "grantId": "grant-uuid",
  "hostId": "mac-admin",
  "relayUrl": "wss://relay.example.com/client",
  "accessToken": "twcap2.payload.mac",
  "accessExpiresAtMs": 1783703600000,
  "refreshToken": "twref2.opaque",
  "refreshExpiresAtMs": 1786292000000
}
~~~

并发 refresh 只允许一个 winner；不同 attempt 的 loser 必须重新读取 winner 已原子保存的 credential 或要求重新 enrollment，不能继续使用旧 refresh token。

enrollment exchange 和 client/host refresh 的 response-loss 幂等规则统一如下：

- Android/host 的 credential blob 必须有单调 credentialVersion。在发请求前用 CAS 把 exchangeAttemptId、refreshAttemptId 或 bootstrapAttemptId、oldCredentialVersion 与所用 secret reference 原子保存；网络超时复用同 attempt ID/secret/version，不能生成新 attempt。
- broker 第一次成功时在同一事务中消耗/轮换旧 secret、写入新 verifier hash，并保存以 (operation, grant/enrollment, attemptId, oldSecretHash, clientInstanceId 或 host binding) 为 key 的 exact success response AEAD ciphertext，responseReplayRetentionMs 固定 600000。
- retention 内相同 key/fingerprint 重试解密并逐字段返回原 response，包括相同 principalId、grantId、access jti、access/refresh token 和 expiry；这只是 ACK replay，不算第二次 redeem/refresh。相同 attemptId 搭配不同 binding/secret 返回 IDEMPOTENCY_CONFLICT且不泄露原结果。
- 已消耗 secret 搭配不同 attemptId，或 exact replay record 到期后的旧 secret，只能返回通用 AUTH_INVALID。broker 不得签发第二个 refresh token来“补发”；客户端只能使用已保存 winner credential或重新 enrollment/bootstrap。
- replay ciphertext 使用与 issuer signing key 分离、可轮换的 AEAD key，AAD 覆盖上述 key；不得进入日志、trace、crash report 或普通数据库导出。达到 bounded replay-store 上限时必须在消耗 secret 前返回 BUSY，不能成功后丢弃 replay record。
- Android/host 收到 success response 时，只能在 pendingAttemptId、oldCredentialVersion 和 old secret reference 仍同时匹配当前 blob 时 CAS 写入新 credential、credentialVersion+1 并清除 pending。pending 已清除、version 已前进或 reference 不同表示迟到/重复 response，必须丢弃全部 credential 字段，绝不能覆盖或回滚当前 token。CAS loser 重新读取当前 blob，不按网络到达顺序强写。

Dashboard 通过当前 host carrier 撤销本 host 的 client grant：

~~~json
{
  "carrierVersion": 1,
  "type": "grant.revoke",
  "requestId": "revoke-request-uuid",
  "connectorId": "connector-uuid",
  "payload": {
    "grantId": "client-grant-uuid",
    "reason": "user_revoked"
  }
}
~~~

broker 必须在 revoke 事务提交后返回：

~~~json
{
  "carrierVersion": 1,
  "type": "grant.revoked",
  "requestId": "revoke-request-uuid",
  "connectorId": "connector-uuid",
  "payload": {
    "grantId": "client-grant-uuid",
    "revokedAtMs": 1783700200000,
    "alreadyRevoked": false
  }
}
~~~

相同 connectorId/requestId/grantId/reason 的 grant.revoke 重试必须返回相同 revokedAtMs；同一逻辑 request 的 alreadyRevoked 保持首次 response 的值。使用新 requestId 查询/再次撤销已撤销 grant时返回原 revokedAtMs、alreadyRevoked=true。相同 requestId 不同 fingerprint 返回 carrier.error(IDEMPOTENCY_CONFLICT)。

host 只能撤销 claim hostId 与自己相同且 role=client 的 grant；跨 host、host-role grant 或未知 grant 返回 PERMISSION_DENIED/GRANT_NOT_FOUND。

Android 自撤销使用精确 pathname、无 query 的 HTTPS endpoint：

~~~http
POST /v2/grants/self/revoke
Authorization: Bearer twcap2.<payload>.<mac>
Content-Type: application/json
Cache-Control: no-store
~~~

request body 是 closed schema，固定为：

~~~json
{
  "reason": "user_revoked"
}
~~~

broker 只接受当前有效的 role=client access token；grantId、hostId、principalId 和 clientInstanceId 只取可信 auth claims，body 出现这些字段必须拒绝。成功 response 使用 Cache-Control: no-store：

~~~json
{
  "grantId": "grant-uuid",
  "revokedAtMs": 1783700200000,
  "alreadyRevoked": false
}
~~~

并发且在第一次事务提交前已通过认证的重复请求返回相同 revokedAtMs、alreadyRevoked=true；事务提交后才到达的旧 access token 请求返回 401。撤销事务的 commit point 必须原子地让 grant 对所有新 Upgrade、refresh 和 frame authorization 立即失效；broker 随后写出 response，并在 5 秒内以 close code 4403 关闭该 grantId 的所有既有 socket。response 是否成功送达绝不能延迟或回滚鉴权失效。

本节 enrollment redeem、client/host refresh、host bootstrap 和 self-revoke 的所有非 2xx response 都使用 Cache-Control: no-store 与下列 closed body；HTTP status 只能是 400、401、403、404、409、413、415、429、500 或 503，RATE_LIMITED/BUSY 的 retryAfterMs 必须是非负 integer，其他 code 可以为 null：

~~~json
{
  "error": {
    "code": "AUTH_INVALID",
    "message": "Credential is invalid",
    "retryable": false,
    "retryAfterMs": null,
    "commandDisposition": "not_applicable",
    "details": null
  }
}
~~~

所有 /v2/enrollments/redeem、/v2/tokens/refresh、/v2/hosts/bootstrap、/v2/hosts/tokens/refresh 和 /v2/grants/self/revoke 请求的 raw HTTP body 上限固定为 16384 bytes。Content-Length>16384 必须在读取 body 前返回 HTTP 413 + error.code=INVALID_ENVELOPE/retryable=false；缺少 Content-Length 或使用 chunked 时也必须通过 counting reader 在第 16385 byte 立即中止，不能先聚合再检查。只接受 Content-Encoding 缺失或 identity，任何压缩 body 返回 HTTP 415 + error.code=PROTOCOL_UNSUPPORTED/retryable=false。限流在 body parse 前执行；随后只在有界 buffer 内接受严格 UTF-8、恰好一个 JSON object、最大深度 8、最多 32 keys，拒绝 duplicate key、尾随 JSON 和未知字段。未鉴权的 enrollment/bootstrap 同样适用，错误响应不得回显 body 或 credential。

公共 client WebSocket Authorization 不能原地更新；§1.2.4 的 active host carrier reauthenticate 是唯一例外。broker 在 client access token 到期前 60 秒可以发送不占 host eventSeq 的 auth.expiring；到 exp 后必须先停止接受和转发新 frame，再以 close code 4401 关闭连接并向 host 发送 route.unbind(reason=auth_expired)。Android 应先 refresh、建立新的 v2 socket并完成 host.welcome，再让 terminal 通过正常 resume route fencing 迁移。任何 refresh、revoke 或 expiry 失败都不得触发 V1 fallback。

#### 1.2.4 role=host bootstrap、refresh 与原子换证

role=host credential 不能由 client enrollment、V1 shared secret 或 Dashboard 自签发。broker 管理员通过本机管理 CLI 生成含至少 128 bit CSPRNG entropy 的一次性 twhostboot2 bootstrap secret；它默认且最长有效 5 分钟、只保存 hash、只允许兑换一次，并通过权限为 0600 的文件或 stdin 交给 relay-host，禁止命令行参数、环境变量、URL 和日志。每个 bootstrap secret 最多允许 5 次失败、每来源 IP 每分钟最多 20 次兑换；超限返回不泄露 token 是否存在的 RATE_LIMITED，失败次数耗尽后原子作废。

relay-host 用 HTTPS body 调用 POST /v2/hosts/bootstrap：

~~~json
{
  "bootstrapAttemptId": "host-bootstrap-attempt-uuid",
  "bootstrapToken": "twhostboot2.opaque",
  "hostId": "mac-admin",
  "hostEpoch": "authority-uuid",
  "hostInstanceId": "host-process-uuid"
}
~~~

成功 response 使用 Cache-Control: no-store：

~~~json
{
  "bootstrapAttemptId": "host-bootstrap-attempt-uuid",
  "principalId": "host-principal-uuid",
  "grantId": "host-grant-uuid",
  "hostId": "mac-admin",
  "accessToken": "twcap2.payload.mac",
  "accessExpiresAtMs": 1783703600000,
  "refreshToken": "twref2.opaque",
  "refreshExpiresAtMs": 1786292000000
}
~~~

host access token 默认和最大 TTL 为 1 小时。host credential 必须存入 OS credential storage 或 0600 credential file，与 host 事务型业务库分离。

host 通过 POST /v2/hosts/tokens/refresh 续期：

~~~json
{
  "refreshAttemptId": "host-refresh-attempt-uuid",
  "grantId": "host-grant-uuid",
  "hostInstanceId": "host-process-uuid",
  "refreshToken": "twref2.opaque"
}
~~~

成功 response 使用 Cache-Control: no-store，closed schema 固定为：

~~~json
{
  "refreshAttemptId": "host-refresh-attempt-uuid",
  "principalId": "host-principal-uuid",
  "grantId": "host-grant-uuid",
  "hostId": "mac-admin",
  "accessToken": "twcap2.payload.mac",
  "accessExpiresAtMs": 1783703600000,
  "refreshToken": "twref2.opaque",
  "refreshExpiresAtMs": 1786292000000
}
~~~

refresh 采用单 winner 原子轮换，并遵守 §1.2.3 的 exact-response replay。host grant 只绑定 role、hostId、principalId、grantId，不绑定 hostInstanceId；hostInstanceId 只用于审计和 connector 仲裁，因此同一 grant 在进程重启后仍可 refresh。issuer 返回同 grantId、当前 active kid 签发的新 access token和新 refresh token。

同一 active carrier 的换证使用唯一允许携带 access token 的敏感 carrier control：

~~~json
{
  "carrierVersion": 1,
  "type": "host.reauthenticate",
  "requestId": "reauth-uuid",
  "connectorId": "connector-uuid",
  "payload": {
    "accessToken": "twcap2.new-payload.new-mac"
  }
}
~~~

broker 验证新 token 的 role、hostId、principalId、grantId 与当前 connector 相同、jti 不同且有效后，原子替换 connector auth context，再返回：

~~~json
{
  "carrierVersion": 1,
  "type": "host.reauthenticated",
  "requestId": "reauth-uuid",
  "connectorId": "connector-uuid",
  "payload": {
    "grantId": "host-grant-uuid",
    "jti": "new-token-instance-uuid",
    "expiresAtMs": 1783707200000,
    "deduplicated": false
  }
}
~~~

host.reauthenticate 的 requestId 是持久逻辑 attempt ID：host 必须用 CAS 把 requestId、新 access jti、credentialVersion 和 credential reference 保存到收到 ACK 为止，超时重试复用相同 requestId/token。broker 为每个 connector 保存 10 分钟 bounded reauth record，key=(connectorId,requestId,jti,accessTokenHash)；首次原子换证后保存 exact host.reauthenticated。相同 key 重试必须在“新 jti 必须不同于当前 jti”的普通校验前命中并返回相同 ACK、deduplicated=true；相同 requestId 不同 token/jti 返回 carrier.error(IDEMPOTENCY_CONFLICT)，不得改变 auth context。host 只在 pending requestId/jti/version 仍匹配时清除 pending；若 credentialVersion 已前进或当前 access jti 已不同，迟到 ACK 只能丢弃，不能清除较新的 pending reauth或回滚 connector credential 状态。

host.reauthenticate/reauthenticated 不改变 connectorId、routeId、routeFence、seq、presence、terminal 或 command 状态，也不触发 SUPERSEDED。accessToken 必须由专用 redacted parser 处理，不得进入普通 carrier 日志、trace 或错误回显。reauth 失败时旧 auth context 保持到原 exp，不允许部分更新。reauth record 达到上限时必须在换证前返回 BUSY；不能先换 context 再丢失重放证据。

同 hostInstanceId 的第二 connector 必须 DUPLICATE_CONNECTOR 拒绝，不能误判为另一进程 supersede；hostInstanceId 不同的合法 connector 才执行 §1.4 SUPERSEDED。

broker 在 host access token 到期前 60 秒发送：

~~~json
{
  "carrierVersion": 1,
  "type": "host.auth_expiring",
  "connectorId": "connector-uuid",
  "payload": {
    "grantId": "host-grant-uuid",
    "expiresAtMs": 1783703600000,
    "refreshRecommendedAtMs": 1783703300000
  }
}
~~~

到 exp 或 host grant revoke 时 broker 先停止 connector route I/O，再以 4401/4403 关闭 carrier并对其 route执行 transport unbind；relay-host 进程不退出 78，可 refresh/bootstrap 后重连。只有收到 §1.4 host.superseded/4409 才进入不可逆 SUPERSEDED。

### 1.3 relay-host 权威与两种 ID

relay-host 是单个 hostId 的业务权威，负责：

- Scope/Session 聚合和版本快照。
- create_worktree、create_terminal、send_agent_message、kill_session 的持久 command ledger 与执行。
- host 领域 revision 和 eventSeq。
- terminal backend、generation、offset、ACK、ring、route fencing 和 resume lease。

每个 host 同时具有：

- hostEpoch：持久 authority-lineage UUID。正常 broker 断线和正常 relay-host 进程重启不改变。
- hostInstanceId：每次 relay-host 进程启动生成的新 UUID，绝不持久复用。

hostEpoch、command ledger、revision 和 eventSeq 必须在同一事务型状态库中保持连续。只要无法证明单调连续性，就必须更换 hostEpoch，包括数据库丢失、重建、显式清空、损坏、回滚、部分表丢失、revision/eventSeq 回退或恢复了较旧备份。不得在 continuity 不确定时沿用旧 hostEpoch。

hostInstanceId 用于识别进程替换和进程内 terminal 状态，不代表业务谱系。首版 terminal ring 不跨进程；因此 hostInstanceId 改变时 command/snapshot 可由持久状态恢复，但旧 terminal stream 必须 reset。

### 1.4 重复 host connector 与 SUPERSEDED

relay-host 连接 broker 时发送 host.hello，其中 hostId 必须同时匹配 role=host 的 Bearer claim。broker 对同一 hostId 只允许一个 active connector；同 hostInstanceId 的重复 connector 必须拒绝，不能触发替换。

当 hostInstanceId 不同的第二个合法 connector 完成 host.hello：

1. broker 原子地把新 connector 设为 active；之后的新 route 只发给新 connector。
2. broker 向旧 connector 发送 host.superseded，包含 winningHostInstanceId。
3. broker 以 WebSocket close code 4409 关闭旧 connector。
4. 原子替换期间不产生中间 offline；目录只产生一次 reason=superseded 的 online presence revision。

host.superseded 是 broker→host 的 carrier 消息，不是公共 v2 event：

~~~json
{
  "carrierVersion": 1,
  "type": "host.superseded",
  "connectorId": "losing-connector-uuid",
  "payload": {
    "hostId": "mac-admin",
    "losingConnectorId": "losing-connector-uuid",
    "winningConnectorId": "winning-connector-uuid",
    "losingHostInstanceId": "old-host-process-uuid",
    "winningHostInstanceId": "new-host-process-uuid",
    "reason": "new_authenticated_connector"
  }
}
~~~

旧 relay-host 收到 host.superseded 或 close 4409 后必须：

- 立即进入不可逆 SUPERSEDED 状态，停止接受新 route 和新副作用。
- 不再向 broker 自动重连；不得反向 supersede 获胜进程。
- 旧 connectorId、routeId 或 routeFence 的所有后续 frame 都无效，不得影响新 connector 的 route。
- 允许正在提交的本地数据库事务结束，但不得开始下一条 command。
- 不伪造 command result 或 terminal.closed。
- 在 5 秒内关闭本进程资源并以专用退出码 78 退出。

桌面打包/守护配置必须把退出码 78 设为 RestartPreventExitStatus；人工重新启动视为新的显式进程。relay-host 同时 SHOULD 使用本地单实例锁，broker 的 SUPERSEDED 仍是跨进程/跨机器的最终仲裁。

### 1.5 host.presence

host.presence 是 broker 领域事件，不使用 host eventSeq。每次该 host 的 active connector 连接、断开或原子替换，broker 递增该 host 授权视图的 hostsRevision：

~~~json
{
  "protocolVersion": 2,
  "kind": "event",
  "type": "host.presence",
  "hostId": "mac-admin",
  "payload": {
    "brokerEpoch": "broker-process-uuid",
    "revision": "18",
    "state": "online",
    "reason": "connected|reconnected|superseded|disconnected",
    "hostEpoch": "authority-uuid",
    "hostInstanceId": "host-process-uuid",
    "previousHostInstanceId": "old-host-process-uuid",
    "observedAtMs": 1783700100000
  }
}
~~~

规则：

- active connector 断开时 state=offline、reason=disconnected，并保留最后看到的 hostEpoch/hostInstanceId。
- 同一 hostEpoch 重新上线时发送 state=online、reason=reconnected 和当前进程的 hostInstanceId；同一 relay-host 进程的 carrier/network 重连必须保持该值，可与 previousHostInstanceId 相同。只有进程重新启动才生成新的 hostInstanceId并触发 terminal reset。
- connector 原子替换只发送 state=online、reason=superseded，不先发送 offline。
- Android 在 offline 时把 host 标记为 suspended，不删除缓存、不伪造 terminal closed。
- presence revision 不连续或 brokerEpoch 变化时，客户端重新获取 hosts.snapshot。
- online/reconnected 后客户端必须重新执行 client.hello/host.welcome；不能仅凭 presence 恢复为 ONLINE。
- role=client capability 绑定单一 hostId。broker 只能向该 client route发送 claim hostId 的 host.presence；其他 host 的 presence、数量、ID、状态和 capability 永不暴露。

hosts.snapshot 是 broker-authoritative request/response，不携带 expectedHostEpoch：

~~~json
{
  "protocolVersion": 2,
  "kind": "request",
  "type": "hosts.snapshot.get",
  "requestId": "hosts-1",
  "payload": {}
}
~~~

~~~json
{
  "protocolVersion": 2,
  "kind": "response",
  "type": "hosts.snapshot",
  "requestId": "hosts-1",
  "payload": {
    "brokerEpoch": "broker-process-uuid",
    "revision": "18",
    "items": [
      {
        "hostId": "mac-admin",
        "state": "online",
        "hostEpoch": "authority-uuid",
        "hostInstanceId": "host-process-uuid",
        "clientDialects": ["tw-relay.v1", "tw-relay.v2"],
        "capabilities": [
          "error.structured.v1",
          "command.ledger.v1",
          "command.query.v1",
          "snapshot.revision.v1",
          "event.sequence.v1",
          "terminal.stream.resume.v1"
        ],
        "observedAtMs": 1783700100000
      }
    ]
  }
}
~~~

对 role=client，hosts.snapshot 必须按可信 auth context 的 hostId 过滤，items 最多一项；目标 offline 时可以返回保留最后 lineage 的单项 offline record，不能用空项暗示全局目录，也不能返回其他 host。revision 是该授权视图的 revision，不泄露全局 host 数量或变化频率。同 brokerEpoch/revision 的授权视图 snapshot 是完整 destructive replace；brokerEpoch 改变时 revision 从任意值重新建立，客户端不能跨 epoch 比较 revision。host.reauthenticate 不改变 hostsRevision、hostInstanceId 或 presence。

## 2. WebSocket 协商与 capability handshake

### 2.1 客户端 dialect

credential kind 在 Upgrade 前已经决定 dialect；同一连接禁止同时 offer v1 和 v2。冻结矩阵：

| 连接 profile | Authorization | offered subprotocol | 唯一合法结果 | fallback |
| --- | --- | --- | --- | --- |
| V1 client | legacy shared secret | tw-relay.v1 | 老 broker 可不选择 subprotocol，但首包必须是 legacy ready | 只运行 V1 actor |
| V2 client | twcap2 role=client | tw-relay.v2 | server 必须明确选择 tw-relay.v2；101 后首个 application frame 按 §2.2 只能是成功 relay.welcome 或 pre-route 失败 relay.unavailable | 禁止 |
| V1 host | legacy shared secret | tw-relay.v1 | legacy host_ready/host_registered | 只运行 V1 connector |
| V2 host | twcap2 role=host | tw-relay.host.v2 | server 必须明确选择 tw-relay.host.v2，再完成 host.hello/host.registered | 禁止 |

规则：

- 新 broker 看到 twcap2. 前缀后只能调用 v2 verifier；即使整个 token 字符串碰巧等于配置的 legacy secret，也不能进入 V1。
- legacy secret 被新 broker 兼容接受时只能建立 V1 route；broker 不能为它合成 principalId、grantId 或 v2 auth context。
- V2 profile 遇到 HTTP 401/403/426、server 未选择 subprotocol、选择非 tw-relay.v2 或发送 legacy ready 时，必须以协议/升级错误终止并提示升级 broker，禁止用同一 credential 重连 V1。
- V1 profile 只允许 V1；显式完成 enrollment 并保存独立 v2 credential 后，用户才能切换 profile。
- V2 host connector 可以在内部 carrier 上声明同时承载 tw-relay.v1 和 tw-relay.v2 client route；这不改变公共连接“一条 socket 一种 dialect”的规则。

client route 与 active host connector 的矩阵：

| client dialect | host connector 宣告 | 结果 |
| --- | --- | --- |
| V2 | 包含 tw-relay.v2 且所需 capability 齐全 | 建立 V2 route |
| V2 | V1-only 或 capability 不全 | HOST_DIALECT_UNAVAILABLE 或 CAPABILITY_UNAVAILABLE；不降级 |
| V1 | V2 carrier 包含 tw-relay.v1 | carrier 原样承载 V1 frame；不翻译 |
| V1 | connector 不支持 tw-relay.v1 | V1 结构化能力不可用错误或关闭；不能改发 V2 |

broker 在 Upgrade 阶段对无效/过期 credential 返回 401，对 role/host/grant 不匹配返回 403，对 client/broker 或已知 active host 没有协议交集返回 426，对已知 target host offline 返回 503。Upgrade 失败时不发送 WebSocket JSON error。

V2 public endpoint pathname 必须精确是 /client，V2 carrier endpoint pathname 必须精确是 /host；search/query 必须为空，credential 和 hostId 都不能出现在 URL。/client/、/host/、自定义子路径或任意 query 都在 Upgrade 前拒绝。V1 legacy endpoint 行为保持独立，不可据此放宽 V2 parser。

### 2.2 handshake

v2 client handshake：

1. broker 验证 twcap2、明确选择 tw-relay.v2，并向 active connector 发送 route.open。
2. relay-host 保存 broker 注入的可信 auth context 并返回 route.opened。
3. broker 发送 relay.welcome；route.opened 之前不能向 client 宣告 v2 ready。
4. client 发送 client.hello request。
5. broker 通过已打开 route 原样转发；relay-host 按 client resume cursor 返回 host.welcome 或 EVENT_CURSOR_AHEAD error。
6. Android 收到合法 host.welcome 且 requiredCapabilities 全部满足后，按 resumeDisposition 进入 ONLINE 或 RESYNCING；不能一律直接 ONLINE。

HTTP 101 后 broker→client 的首个 application frame 是 closed discriminated union：route.opened 成功只能发送 relay.welcome 并继续握手；HTTP 101 后发生 pre-route race 只能发送 relay.unavailable 并立即按下文 close。两者恰好一个，relay.unavailable 后禁止 client.hello、host.welcome 或任何业务 frame。Upgrade 前已知的 offline/dialect/auth 失败仍必须直接用 HTTP status，不能为了发送 relay.unavailable 而先返回 101。

若 HTTP 101 与 route.open 之间发生 host disconnect、supersede 或 route.rejected，broker 绝不能发送 relay.welcome，必须先发送一次：

~~~json
{
  "protocolVersion": 2,
  "kind": "event",
  "type": "relay.unavailable",
  "hostId": "mac-admin",
  "payload": {
    "error": {
      "code": "HOST_OFFLINE",
      "message": "Host became unavailable before route opened",
      "retryable": true,
      "retryAfterMs": 1000,
      "commandDisposition": "not_applicable",
      "details": null
    }
  }
}
~~~

HOST_OFFLINE/BUSY 使用 1013 关闭；dialect/capability route rejection 使用 4406 route_unavailable。relay.unavailable 不携带 principalId、hostEpoch 或 eventSeq，且只允许 claim hostId。

relay.welcome：

~~~json
{
  "protocolVersion": 2,
  "kind": "event",
  "type": "relay.welcome",
  "payload": {
    "selectedVersion": 2,
    "connectionId": "broker-connection-uuid",
    "brokerEpoch": "broker-process-uuid",
    "principalId": "principal-opaque-id",
    "capabilities": [
      "error.structured.v1",
      "command.ledger.v1",
      "command.query.v1",
      "snapshot.revision.v1",
      "event.sequence.v1",
      "terminal.stream.resume.v1"
    ],
    "limits": {
      "maxFrameBytes": 1048576,
      "maxCarrierFrameBytes": 1500000,
      "brokerRouteBufferedBytesPerDirection": 1048576,
      "brokerRouteLowWaterBytesPerDirection": 524288,
      "brokerCarrierBufferedBytes": 16777216,
      "brokerCarrierLowWaterBytes": 8388608,
      "maxQueuedRouteFrames": 128,
      "maxInFlightRequestsPerRoute": 64
    }
  }
}
~~~

client.hello：

~~~json
{
  "protocolVersion": 2,
  "kind": "request",
  "type": "client.hello",
  "requestId": "hello-attempt-uuid",
  "hostId": "mac-admin",
  "payload": {
    "clientInstanceId": "android-install-uuid",
    "capabilities": [
      "error.structured.v1",
      "command.ledger.v1",
      "command.query.v1",
      "snapshot.revision.v1",
      "event.sequence.v1",
      "terminal.stream.resume.v1"
    ],
    "requiredCapabilities": [
      "error.structured.v1",
      "command.ledger.v1",
      "command.query.v1",
      "snapshot.revision.v1",
      "event.sequence.v1",
      "terminal.stream.resume.v1"
    ],
    "resume": {
      "hostEpoch": "last-seen-host-epoch",
      "lastEventSeq": "90"
    }
  }
}
~~~

client.hello.payload.resume 是必填但 nullable 的 closed union。首次连接、没有完整 cursor、旧 cursor schema 不兼容或客户端已主动丢弃 lineage 时必须显式为 null，禁止省略或发送半空 object。非 null 时 hostEpoch 和 lastEventSeq 两个字段都必填且非 null，不能只给其中一个；lastEventSeq 使用规范无符号十进制 string。resume 只表达已持久应用的 cursor，不证明 host 仍保留 event replay。

host.welcome：

~~~json
{
  "protocolVersion": 2,
  "kind": "response",
  "type": "host.welcome",
  "requestId": "hello-attempt-uuid",
  "hostId": "mac-admin",
  "hostEpoch": "authority-uuid",
  "hostInstanceId": "host-process-uuid",
  "payload": {
    "selectedVersion": 2,
    "capabilities": [
      "error.structured.v1",
      "command.ledger.v1",
      "command.query.v1",
      "snapshot.revision.v1",
      "event.sequence.v1",
      "terminal.stream.resume.v1"
    ],
    "eventSeq": "91",
    "resumeDisposition": "snapshot_required",
    "resumeReason": "cursor_behind",
    "commandDedupeWindow": {
      "windowId": "dedupe-window-uuid",
      "windowSeq": "42",
      "acceptUntilMs": 1783786400000,
      "queryUntilMs": 1784391200000
    },
    "limits": {
      "commandResultRetentionMs": 86400000,
      "commandDedupeRetentionMs": 604800000,
      "maxCommandQueryIds": 32,
      "stateSnapshotChunkBytes": 524288,
      "stateSnapshotChunkRecords": 256,
      "stateSnapshotMaxBytes": 268435456,
      "stateSnapshotMaxRecords": 100000,
      "stateSnapshotIdleLeaseMs": 300000,
      "stateSnapshotMaxLifetimeMs": 3600000,
      "stateSnapshotMaxPinnedPerPrincipal": 2,
      "stateSnapshotMaxPinnedPerHost": 16,
      "stateSnapshotPinnedBytesPerHost": 536870912,
      "stateSnapshotPinnedMetadataBytesPerHost": 16777216,
      "stateSnapshotChunkMaxJsonKeys": 8192,
      "stateSnapshotChunkMaxJsonNodes": 16384,
      "terminalReplayBytesPerStream": 4194304,
      "terminalReplayBytesPerHost": 67108864,
      "terminalDetachedLeaseMs": 120000,
      "terminalControlDedupeRetentionMs": 600000,
      "terminalMaxUnackedBytes": 524288,
      "terminalMaxFrameBytes": 65536,
      "terminalInputDedupeEntriesPerStream": 512,
      "terminalResizeDedupeEntriesPerStream": 256,
      "terminalMaxStreamsPerHost": 256,
      "terminalControlRecordsPerHost": 4096,
      "brokerRouteBufferedBytesPerDirection": 1048576,
      "brokerRouteLowWaterBytesPerDirection": 524288
    }
  }
}
~~~

relay-host 必须在生成 host.welcome 的同一 materialized-state read 中捕获 W=payload.eventSeq，并按下表冻结 resume 处置：

| client.hello.resume | 唯一 response/状态 |
| --- | --- |
| null | host.welcome：resumeDisposition=snapshot_required、resumeReason=fresh |
| hostEpoch != current hostEpoch | host.welcome：snapshot_required、host_epoch_changed |
| 同 hostEpoch 且 lastEventSeq < W | host.welcome：snapshot_required、cursor_behind |
| 同 hostEpoch 且 lastEventSeq = W | host.welcome：caught_up、matched |
| 同 hostEpoch 且 lastEventSeq > W | correlated EVENT_CURSOR_AHEAD error，随后 4400 close；不发送 host.welcome |

resumeDisposition 只能是 caught_up 或 snapshot_required；resumeReason 只能是 matched、fresh、host_epoch_changed、cursor_behind，且组合必须符合表格。caught_up 时 Android 才能在持久记录 requiredThroughEventSeq=W 后直接 ONLINE；snapshot_required 必须进入 RESYNCING并请求 §5.4 snapshot，在此之前禁止 mutation/terminal open。host_epoch_changed 还必须按 §4.6 清理旧 resource cursor并处理 Outbox lineage。

host.welcome.eventSeq 是 route 的强 hello barrier，不只是一次普通读取。relay-host 处理 client.hello 时必须通过同一个 host state-event serializer/critical section 原子排序以下动作：

1. 在 materialized transaction 已提交边界捕获 W，并计算 resumeDisposition。
2. 为该 route 注册从 W+1 开始的 live state subscriber，并为 welcome/control frame 预留 bounded outbound slot。
3. 把 correlated host.welcome 作为该 route 的首个 host-authoritative业务 frame入队。
4. 释放 serializer；之后任何提交 seq>W 的 state event 都必须经同一 serializer 排在 welcome 后投递或进入该 route 的 bounded buffer。

并发 state commit 必须被线性化为两种之一：发生在 capture 前则 eventSeq<=W并已包含于 barrier state；发生在 capture 后则 eventSeq>W且一定排在 welcome 后。不能存在“已提交但既不含于 W、也未注册投递”的缝隙。若 host 无法同时预留 subscriber/buffer和welcome，必须返回 correlated BUSY error并关闭/重试 route，不能返回 caught_up 或 snapshot_required 后静默漏 event。route buffer 饱和按 §6.8 fail-close/resync，不得丢单个 state event。

Android 在收到合法 correlated host.welcome 前若看到任何 host state event，必须视为 protocol violation并关闭 route；不得先应用或用它猜测 barrier。收到 welcome 后，caught_up 从 W+1 校验，snapshot_required 把 W+1 起的 event 持久写入 RESYNCING buffer。

cursor ahead error 的 closed response 为：

~~~json
{
  "protocolVersion": 2,
  "kind": "response",
  "type": "error",
  "requestId": "hello-attempt-uuid",
  "hostId": "mac-admin",
  "hostEpoch": "authority-uuid",
  "payload": null,
  "error": {
    "code": "EVENT_CURSOR_AHEAD",
    "message": "Client cursor is ahead of host authority",
    "retryable": false,
    "commandDisposition": "not_applicable",
    "details": {
      "clientLastEventSeq": "92",
      "hostEventSeq": "91"
    }
  }
}
~~~

这表示同 hostEpoch 的 continuity/client cache 至少一方损坏，禁止静默 snapshot 覆盖。Android 显示本地状态修复入口；用户确认后只清理 resource cache/cursor，按既有 Outbox lineage 将未决副作用保留为 CONFIRMING/AMBIGUOUS，再以 resume=null 重连。不得因该错误切 V1或自动重放 mutation。

首个 slice 冻结以下原子 capability：

- error.structured.v1
- command.ledger.v1
- command.query.v1
- snapshot.revision.v1
- event.sequence.v1
- terminal.stream.resume.v1

不得仅凭 protocolVersion=2 推断子能力。Android 只启用 client、broker、目标 relay-host 三方交集；requiredCapabilities 中任一项缺失都返回 CAPABILITY_UNAVAILABLE 并关闭 V2 route，不得切换到 V1 actor。

timeout 与 close code 冻结如下：host Upgrade 后 5 秒内未收到合法 host.hello、client 收到 relay.welcome 后 5 秒内未发送合法 client.hello、或 client.hello 后 10 秒内未收到 host.welcome，都以 4408 handshake_timeout 关闭。malformed/protocol violation 使用 4400，access expiry 使用 4401，grant revoke 使用 4403，route dialect/capability race 使用 4406，host process supersede 使用 4409，同 hostInstanceId duplicate connector 使用 4411，持续 backpressure/offline race 使用标准 1013。host.reauthenticate 在原 socket 上成功 ACK或失败 carrier.error，不因失败立即关闭；timeout 不授权 dialect fallback。

broker→client 的 auth.expiring 固定 schema：

~~~json
{
  "protocolVersion": 2,
  "kind": "event",
  "type": "auth.expiring",
  "payload": {
    "grantId": "grant-uuid",
    "expiresAtMs": 1783703600000,
    "refreshRecommendedAtMs": 1783703300000
  }
}
~~~

这是 broker control event，不携带 hostId、hostEpoch 或 eventSeq；principalId 已在可信 relay.welcome 中回显，不允许 client/host 入站 frame 自报 principalId。

### 2.3 broker↔relay-host carrier

内部 carrier 使用独立 closed schema，不是公共 protocolVersion=2 envelope。所有消息都包含 carrierVersion=1；除首个 host.hello 及其注册前 carrier.error 外，还必须包含由 broker 签发的 connectorId。公共 client payload 只能作为 route.data 的原始 bytes 承载，broker 不做业务翻译。

host.hello、host.reauthenticate、enrollment.create 和 grant.revoke 的失败统一使用 correlated carrier.error，不得只写日志、静默超时或返回公共 v2 error：

~~~json
{
  "carrierVersion": 1,
  "type": "carrier.error",
  "requestId": "request-uuid",
  "connectorId": "connector-uuid",
  "payload": {
    "failedType": "host.reauthenticate"
  },
  "error": {
    "code": "AUTH_INVALID",
    "message": "Replacement access token is invalid",
    "retryable": false,
    "retryAfterMs": null,
    "commandDisposition": "not_applicable",
    "details": null
  }
}
~~~

failedType 首版只能是 host.hello、host.reauthenticate、enrollment.create 或 grant.revoke。响应必须原样回显 requestId；host.hello 尚未注册时 connectorId 必须为 null，其他三类必须是当前 connectorId。error 是 closed object，retryAfterMs 必须为 null 或非负 integer，details 必须符合对应 error code 的 fixed schema。

- host.reauthenticate 失败保持旧 auth context，不部分更新、不回显 access token，也不立即关闭尚未到期的 carrier。
- enrollment.create 失败不创建或消耗 enrollment；grant.revoke 失败不改变 grant。
- 同 hostInstanceId 的第二 connector 返回 failedType=host.hello、code=DUPLICATE_CONNECTOR、connectorId=null 的 carrier.error，随后以 4411 关闭；不得发送 host.superseded、使用 4409 或让既有 connector 下线。
- route.open 的业务拒绝仍使用 route.rejected；已经绑定 route 的 protocol/backpressure 失败使用 route.close，不改写为 carrier.error。

#### 2.3.1 host.hello 与注册 ACK

host 在 tw-relay.host.v2 Upgrade 成功后的 5 秒内发送：

~~~json
{
  "carrierVersion": 1,
  "type": "host.hello",
  "requestId": "host-hello-uuid",
  "payload": {
    "hostId": "mac-admin",
    "hostEpoch": "authority-uuid",
    "hostInstanceId": "host-process-uuid",
    "clientDialects": ["tw-relay.v1", "tw-relay.v2"],
    "capabilities": [
      "error.structured.v1",
      "command.ledger.v1",
      "command.query.v1",
      "snapshot.revision.v1",
      "event.sequence.v1",
      "terminal.stream.resume.v1"
    ],
    "limits": {
      "maxFrameBytes": 1048576,
      "terminalMaxFrameBytes": 65536
    }
  }
}
~~~

broker 校验 hostId 与 role=host claim 一致、hostEpoch/hostInstanceId 格式有效后，原子完成 active connector 仲裁并返回：

~~~json
{
  "carrierVersion": 1,
  "type": "host.registered",
  "requestId": "host-hello-uuid",
  "connectorId": "connector-uuid",
  "payload": {
    "brokerEpoch": "broker-process-uuid",
    "hostsRevision": "18",
    "disposition": "connected|replaced",
    "supersededHostInstanceId": null,
    "limits": {
      "maxCarrierFrameBytes": 1500000,
      "brokerCarrierBufferedBytes": 16777216,
      "brokerCarrierLowWaterBytes": 8388608
    }
  }
}
~~~

host.registered 是唯一注册成功 ACK；在它产生前 broker 不得把 connector 放入在线目录或投递 route。host.hello 超时、重复、字段冲突或 claim 不匹配时关闭 connector，不得部分注册。broker 将 hello 的 dialect、capabilities、limits 写入 hosts.snapshot。同 hostInstanceId 的第二 connector 返回 DUPLICATE_CONNECTOR；同 connector 的 access token 更新只使用 §1.2.4 host.reauthenticate。

#### 2.3.2 route.open 与可信 auth context

每个公共 client WebSocket 对应一个不可复用的 routeId 和随机 128-bit routeFence：

~~~json
{
  "carrierVersion": 1,
  "type": "route.open",
  "requestId": "route-open-uuid",
  "connectorId": "connector-uuid",
  "routeId": "route-uuid",
  "routeFence": "random-128-bit-uuid",
  "payload": {
    "connectionId": "client-socket-uuid",
    "clientDialect": "tw-relay.v2",
    "authContext": {
      "scheme": "twcap2",
      "role": "client",
      "hostId": "mac-admin",
      "principalId": "principal-opaque-id",
      "grantId": "grant-uuid",
      "clientInstanceId": "android-install-uuid",
      "jti": "token-instance-uuid",
      "kid": "key-2026-07",
      "expiresAtMs": 1783703600000
    },
    "limits": {
      "maxFrameBytes": 1048576
    }
  }
}
~~~

host 必须在保存不可变 route state 后返回以下二者之一。成功：

~~~json
{
  "carrierVersion": 1,
  "type": "route.opened",
  "requestId": "route-open-uuid",
  "connectorId": "connector-uuid",
  "routeId": "route-uuid",
  "routeFence": "random-128-bit-uuid",
  "payload": {
    "acceptedAtMs": 1783700100000,
    "maxFrameBytes": 1048576
  }
}
~~~

拒绝：

~~~json
{
  "carrierVersion": 1,
  "type": "route.rejected",
  "requestId": "route-open-uuid",
  "connectorId": "connector-uuid",
  "routeId": "route-uuid",
  "routeFence": "random-128-bit-uuid",
  "payload": null,
  "error": {
    "code": "HOST_DIALECT_UNAVAILABLE",
    "message": "Requested client dialect is unavailable",
    "retryable": false,
    "commandDisposition": "not_applicable",
    "details": null
  }
}
~~~

V2 route 只接受 scheme=twcap2 且 principalId/grantId/clientInstanceId 完整的 authContext。V1 route 的 scheme=legacy_shared_secret，principalId、grantId、clientInstanceId 必须为 null，且永远不能进入 v2 decoder/ledger。

authContext 只允许来自 broker 的 route.open。host 必须拒绝公共 frame 中自报的 principalId、grantId、jti 或 role；route.data 不重复携带或更新 authContext。

#### 2.3.3 route.data、unbind 与 fencing

双向 route.data 固定 schema：

~~~json
{
  "carrierVersion": 1,
  "type": "route.data",
  "connectorId": "connector-uuid",
  "routeId": "route-uuid",
  "routeFence": "random-128-bit-uuid",
  "direction": "client_to_host",
  "seq": "1",
  "payload": {
    "opcode": "text",
    "encoding": "base64",
    "data": "eyJwcm90b2NvbFZlcnNpb24iOjJ9"
  }
}
~~~

- direction 只能是 client_to_host 或 host_to_client，且必须与发送方一致。
- seq 按 route、按方向从 1 严格连续；重复、gap、错误 direction 或非当前 fence 是 carrier protocol error。
- data 是公共 WebSocket text payload 的原始 UTF-8 bytes 的 canonical Base64。host/broker 解码后必须按原 bytes 转发，不得重排 key、补字段或翻译 dialect。
- route.data 只能在 route.opened 后出现。connector 重连、active connector 替换或 client socket 重建都生成新 routeId/fence；旧 connectorId、routeId 或 fence 的 frame 必须忽略并关闭其来源，不能影响 ledger、terminal 或新 route。

client socket 解绑时 broker 发送：

~~~json
{
  "carrierVersion": 1,
  "type": "route.unbind",
  "connectorId": "connector-uuid",
  "routeId": "route-uuid",
  "routeFence": "random-128-bit-uuid",
  "payload": {
    "reason": "client_closed|client_replaced|auth_expired|auth_revoked|slow_consumer|protocol_error|broker_shutdown",
    "lastClientToHostSeq": "17"
  }
}
~~~

host 删除 route auth context 和 binding 后固定返回：

~~~json
{
  "carrierVersion": 1,
  "type": "route.unbound",
  "connectorId": "connector-uuid",
  "routeId": "route-uuid",
  "routeFence": "random-128-bit-uuid",
  "payload": {
    "reason": "client_closed",
    "lastClientToHostSeq": "17",
    "lastHostToClientSeq": "23"
  }
}
~~~

host 主动终止 route 使用：

~~~json
{
  "carrierVersion": 1,
  "type": "route.close",
  "connectorId": "connector-uuid",
  "routeId": "route-uuid",
  "routeFence": "random-128-bit-uuid",
  "payload": {
    "closeCode": 1013,
    "reason": "slow_consumer|protocol_error|host_shutdown",
    "error": {
      "code": "SLOW_CONSUMER",
      "message": "Route cannot drain",
      "retryable": true,
      "commandDisposition": "not_applicable",
      "details": null
    }
  }
}
~~~

broker 关闭 client 后仍发送 route.unbind，host 再回 route.unbound。unbind 只解除 transport binding；不得关闭 terminal backend、清除 command ledger、生成业务 result 或伪造 terminal.closed。carrier socket 断开等价于对其所有 route unbind，但 terminal 继续受 detached lease 管理。

## 3. 统一 envelope 与资源 ID

~~~json
{
  "protocolVersion": 2,
  "kind": "request|response|event",
  "type": "command.execute",
  "requestId": "attempt-uuid",
  "commandId": "logical-command-uuid",
  "hostId": "mac-admin",
  "expectedHostEpoch": "authority-uuid",
  "hostEpoch": "authority-uuid",
  "hostInstanceId": "host-process-uuid",
  "scopeId": "scope-local",
  "sessionId": "ses_01JOPAQUE",
  "streamId": "terminal-uuid",
  "eventSeq": "1234",
  "payload": {},
  "error": null
}
~~~

规则：

- protocolVersion、kind、type 必填。
- 每个 request 必须有非空 requestId；response 必须原样回显。event 通常没有 requestId。
- 除 client.hello 外，所有 host-authoritative request 必须有 expectedHostEpoch；client request 禁止携带 hostEpoch。response/event 携带实际 hostEpoch，禁止携带 expectedHostEpoch。
- 适用的 commandId、hostId、hostEpoch、scopeId、sessionId、streamId 必须回显。
- 普通 response 只接受精确 requestId；v2 没有空 ID fallback。
- broker 只在 carrier route.open 注入不可伪造的 routeId、routeFence、clientDialect 和 auth context；它们不属于公共 envelope。client→broker 或 host→broker 的公共入站 envelope 中出现 principalId、grantId、jti、role、routeId 或 routeFence 必须拒绝。broker 自己产生的 relay.welcome 可以回显已验证 principalId，auth.expiring 可以回显 grantId；这两个 fixed schema 不能被入站方仿造。
- revision、eventSeq、terminal offset、inputSeq、resizeSeq 等单调计数编码为无符号十进制字符串。
- 时间和 byte limit 使用 JSON safe integer。
- envelope 和每种已知 payload 使用 closed schema；未识别字段、缺失必填字段、禁止出现的 null 或类型错误返回 INVALID_ENVELOPE。未来扩展只能放入显式 extensions object，并由已协商 capability 启用。

### 3.1 sessionId 与 scopeId

sessionId 由 relay-host 签发，在同一 hostEpoch 内不复用，是完全不透明的 ID。客户端不得从 sessionId 解析 scope、名称、tmux target、SSH hostname 或 pane。

scopeId 是独立字段。Session 快照项、Session 命令、terminal target 都必须同时携带 scopeId 和 sessionId；relay-host 必须验证二者关系。示例中的 ses_01JOPAQUE 不是 scope:name。

显示名称、tmux 原始名称、SSH 信息只能作为 payload 内的展示/诊断字段。hostEpoch 改变后，旧 sessionId 全部失效；Android 不得按显示名称自动把未决命令重定向到新 ID。

relay-host 在事务型状态库维护内部映射：

~~~text
(hostEpoch, scopeId, backendKind, backendInstanceKey) -> opaque sessionId
~~~

backendInstanceKey 必须标识一次具体 backend 生命周期，而不是显示名。tmux adapter 至少组合 scope 的 tmux server identity、精确 raw target和 session creation time；由 relay-host 创建的 session还必须写入不可变随机 birth marker。SSH adapter 的 key 同时绑定稳定 remote scope identity。backendInstanceKey 只存 host，不进入公共 Session。

- 完整扫描发现同 backendInstanceKey 时复用原 sessionId；仅 raw name/displayName 相同不得匹配。
- backend 被删除后保存 sessionId tombstone，在同 hostEpoch 内永不复用。随后同名重建具有新 creation/birth marker，必须签发新 sessionId，并按顺序发布旧 ID delete、新 ID upsert。
- relay-host 正常重启先加载持久映射，再扫描 backend；只有 exact backendInstanceKey 才恢复。无法证明是同一实例时签发新 ID，不能按名称猜测。
- scope 完整且成功扫描时，缺失 backend 才能标记删除。SSH unreachable、timeout、权限错误或 partial snapshot 时保留映射和 Android cache为 stale，禁止 delete、换 ID 或重用名称。
- remote tmux server 被重建、creation identity 回退或 birth marker 丢失时，旧实例视为删除并为现存 session签发新 ID；这不要求更换 hostEpoch，只要求 revision/eventSeq 原子前进。
- create_worktree/create_terminal 成功路径必须在发布 SUCCEEDED/result 前，把 backendInstanceKey→sessionId、Session resource、resulting revision/eventSeq 和 command final state以可恢复顺序持久化；无法确认映射提交边界时 command 进入 IN_DOUBT。

### 3.2 strict parsing 与资源限制

公共 v2 和 carrier parser 都必须先执行有界 framing，再执行 JSON/schema 解析：

- 业务消息只接受 WebSocket text opcode、严格 UTF-8 和恰好一个 JSON object；binary、数组、scalar、尾随 JSON、NaN/Infinity 和 duplicate key 全部拒绝。
- 原始公共 frame 最大 1 MiB。permessage-deflate 必须禁用；若部署层强制启用，则压缩前声明长度、压缩输入和解压输出都必须受 1 MiB 硬上限，不能先无界解压再检查。
- JSON 最大嵌套深度 16、任一单独 object 最多 256 个 direct key。除 state.snapshot.chunk 外，单消息全部 object 合计最多 1024 keys、4096 JSON nodes；state.snapshot.chunk 按协商 limit 最多 8192 keys、16384 nodes。parser 必须在流式 tokenization/建 node 时累计并在越界点停止，不能先构造完整 DOM。数组长度由各消息 schema 进一步限制。
- string 不做 number/boolean coercion；null 只在 schema 明确允许时合法。ID 必须非空且最多 128 UTF-8 bytes，除 display/message/path 外禁止前后空白和 NUL。
- 无符号 counter 必须匹配 0|[1-9][0-9]* 且不超过 18446744073709551615；禁止负号、加号、小数、指数和前导零。
- Base64 使用 canonical RFC 4648、必须有正确 padding 且无空白；Base64URL 使用无 padding canonical 形式。实现必须先由编码长度计算上界，再分配 decoded buffer。
- terminal input/output 单帧 decoded bytes 最大 64 KiB；时间戳和 byte limit 必须是 0..9007199254740991 的 JSON integer。
- token claims、carrier authContext、enrollment/refresh body、command arguments 一律拒绝未知字段；不得把未知字段纳入执行却排除在 requestFingerprint 之外。
- handshake 完成前的 malformed frame 直接以 4400 关闭且不发送反射性 JSON。handshake 后 malformed request 可在 requestId/route 尚可信时返回一次 correlated INVALID_ENVELOPE，随后关闭；malformed event 直接关闭。
- 日志只能记录 message type、可信 requestId/commandId、byte size 和 error code，禁止记录原始 frame、token、resumeToken、enrollmentCode、refreshToken 或 terminal bytes。

## 4. commandId、幂等 ledger 与结果查询

### 4.1 ID 和 fingerprint

- commandId：一次逻辑副作用的持久 UUID；重连、重试、查询保持不变。
- requestId：一次网络 attempt UUID；每次 execute/query 重新生成。
- snapshot/read 只有 requestId。
- terminal 消息不进入 command ledger。

ledger key 冻结为：

~~~text
(current hostEpoch, authenticated principalId, hostId, commandId)
~~~

principalId 只能来自 broker auth context，不能来自 client payload。

requestFingerprint 是以下规范对象经过 RFC-8785 canonical JSON 后的 UTF-8 bytes 的 SHA-256：

~~~json
{
  "schemaVersion": 1,
  "operation": "send_agent_message",
  "dedupeWindowId": "dedupe-window-uuid",
  "hostEpoch": "authority-uuid",
  "hostId": "mac-admin",
  "scopeId": "scope-local",
  "sessionId": "ses_01JOPAQUE",
  "arguments": {
    "pane": 0,
    "message": "continue",
    "submit": true
  }
}
~~~

requestFingerprint 只能依赖可信 auth/lineage 字段和纯 request 规范化：字段类型/范围、optional field 是否省略、message 的 CRLF/CR→LF 等不访问外部状态的规则。它不得依赖 realpath、symlink、project catalog、当前 cwd basename、自动 display suffix、backend lookup 或其他会随时间变化的解析结果。省略可选字段与显式传入后来恰好相同的派生默认值是不同 requestFingerprint；客户端对同 commandId 重试必须原样保留规范 request。

relay-host 的 admission 顺序冻结为两阶段：

1. 完整 envelope/framing 校验 → route auth 和权限 → expectedHostEpoch 比较 → operation/arguments 的纯 schema 校验与规范化 → requestFingerprint → 单事务 ledger/tombstone lookup。已有 key 必须立即按已存 requestFingerprint 返回当前/最终状态或 IDEMPOTENCY_CONFLICT，不得先访问 realpath、catalog、Session/backend 或当前默认值。
2. key 缺失时，才校验 dedupeWindowId admission-active，并解析/校验 target、realpath、catalog 和派生 defaults。解析结果必须先归为以下 closed union，再进入最终事务：
   - executable：形成不可变 executionPlan；最终事务再次 lookup key/window，仍缺失时与 requestFingerprint 一起插入 ACCEPTED。
   - immutable_business_failure：权威完整 lookup 已证明 SCOPE_NOT_FOUND、PROJECT_NOT_FOUND、SESSION_NOT_FOUND 或 PANE_NOT_FOUND；形成只含 fixed error/target evidence 的 failureExecutionPlan，最终事务再次 lookup key/window，仍缺失时与 requestFingerprint 一起直接插入最终 FAILED ledger，retryable=false、commandDisposition=completed，不进入 RUNNING且不产生副作用。
   - transient_admission_failure：SCOPE_UNREACHABLE、partial lookup、BUSY、RATE_LIMITED 或无法形成权威 target 结论；返回 correlated error，commandDisposition=not_accepted，不创建 ledger/tombstone。纯 INVALID_ARGUMENT/PERMISSION_DENIED 也保持 pre-ledger rejection。

并发 winner 已插入时一律按 winner 的 requestFingerprint 收敛，禁止执行第二份 plan。immutable failure 只有在 lookup coverage 明确 complete 时才能持久化；SSH partial/unreachable 绝不能伪装成 SESSION_NOT_FOUND。

expectedHostEpoch 不匹配必须在 requestFingerprint 和任何 ledger/tombstone 访问前返回；失效 window 可以读取已有 key但不得创建 ledger/tombstone或占用新 commandId。executionPlan 只驱动首次已接受命令及其进程重启恢复，不参与后续 requestFingerprint 重算。

相同 key：

- requestFingerprint 相同：绝不再次执行，返回已有当前/最终状态。
- requestFingerprint 不同：返回 IDEMPOTENCY_CONFLICT，不执行。

execute 示例：

~~~json
{
  "protocolVersion": 2,
  "kind": "request",
  "type": "command.execute",
  "requestId": "attempt-1",
  "commandId": "cmd-1",
  "hostId": "mac-admin",
  "expectedHostEpoch": "authority-uuid",
  "scopeId": "scope-local",
  "sessionId": "ses_01JOPAQUE",
  "payload": {
    "dedupeWindowId": "dedupe-window-uuid",
    "operation": "send_agent_message",
    "arguments": {
      "message": "continue",
      "pane": 0,
      "submit": true
    }
  }
}
~~~

### 4.2 durable state machine

~~~text
NEW ───────────────────────→ FAILED   (immutable authority failure, atomic)
ACCEPTED → RUNNING → SUCCEEDED
                   ├→ FAILED
                   └→ IN_DOUBT
~~~

语义：

- ACCEPTED 已持久入队，但尚未发生任何外部副作用。进程重启后可以安全重新入队。
- 在第一次外部副作用前，必须先持久转为 RUNNING。
- RUNNING 重启后若不能证明完成/未执行，必须持久转为 IN_DOUBT，不得自动重放。
- SUCCEEDED、FAILED、IN_DOUBT 都是 client 可观察的最终 ledger 状态。
- complete authoritative admission 得到的 immutable_business_failure 可以在一个事务中由 NEW 直接成为 FAILED；它仍是 durable accepted evidence，同 commandId 重试只返回该结果。其他 admission error 不得伪造 FAILED ledger。
- FAILED 是最终失败，retryable 必须为 false。可恢复的内部故障由 host 在 ACCEPTED/RUNNING 内部重试，不得先对 client 发布 FAILED 再重复执行。
- send_agent_message 的 SUCCEEDED 表示正文和 submit/Enter 都已写入 backend。正文与 Enter 之间崩溃属于 IN_DOUBT。

本 contract 保证 retention 内同 key 不重复执行和显式 IN_DOUBT，不虚假承诺所有 tmux/SSH 外部副作用 exactly-once。

### 4.3 execute 的统一 command.status

每个已经通过 auth、epoch、operation schema，且 target resolution 得到 executable 或 immutable_business_failure 的 command.execute，都必须得到一个 correlated command.status response；后者直接是 state=failed 与持久 error。首次 execute、重复 execute、已完成 execute 使用同一种 response。transient/pre-ledger admission failure 使用 correlated type=error response，不能伪造 ledger state：

~~~json
{
  "protocolVersion": 2,
  "kind": "response",
  "type": "command.status",
  "requestId": "attempt-1",
  "commandId": "cmd-1",
  "hostId": "mac-admin",
  "hostEpoch": "authority-uuid",
  "scopeId": "scope-local",
  "sessionId": "ses_01JOPAQUE",
  "payload": {
    "dedupeWindowId": "dedupe-window-uuid",
    "state": "accepted",
    "deduplicated": false,
    "updatedAtMs": 1783700200000,
    "dedupeUntilMs": null,
    "result": null
  },
  "error": null
}
~~~

command.status 只能由 relay-host 在对应 ledger 状态持久化后产生。broker 不得代发。

HOST_EPOCH_MISMATCH response 必须回显 requestId、commandId、hostId、scopeId/sessionId，顶层 hostEpoch 是当前实际值，payload 为 null，error.details 固定包含 expectedHostEpoch 和 actualHostEpoch，commandDisposition=not_accepted。broker 不能从目录缓存代发该错误。

host 可以在状态最终化后发送 command.result event 作为低延迟通知；它不是 host state event，不携带 eventSeq，丢失后只通过 command.query 恢复：

~~~json
{
  "protocolVersion": 2,
  "kind": "event",
  "type": "command.result",
  "commandId": "cmd-1",
  "hostId": "mac-admin",
  "hostEpoch": "authority-uuid",
  "scopeId": "scope-local",
  "sessionId": "ses_01JOPAQUE",
  "payload": {
    "dedupeWindowId": "dedupe-window-uuid",
    "state": "succeeded",
    "updatedAtMs": 1783700200000,
    "result": {
      "pane": 0,
      "submit": true,
      "messageUtf8Bytes": 8
    }
  },
  "error": null
}
~~~

command.status 和 command.result 的终态矩阵固定：succeeded 必须携带对应 operation 的 §4.5 result且 error=null；failed 必须 result=null、error.code=COMMAND_FAILED 或更具体的最终业务错误、retryable=false；in_doubt 必须 result=null、error.code=COMMAND_IN_DOUBT、retryable=false、commandDisposition=in_doubt。accepted/running 的 result/error 都为 null。不得把 union state 与无法判定 schema 的 result={} 组合。

Android 以 commandId 收敛迟到 status/result。requestId 若存在只对应 attempt；requestId 命中另一个 commandId 是协议违规。

### 4.4 command.query：只使用 not_accepted

query 不依赖 Android 时钟。每个 command 必须保存 relay-host 在 host.welcome 签发的 dedupeWindowId：

~~~json
{
  "protocolVersion": 2,
  "kind": "request",
  "type": "command.query",
  "requestId": "query-1",
  "hostId": "mac-admin",
  "expectedHostEpoch": "authority-uuid",
  "payload": {
    "items": [
      { "commandId": "cmd-1", "dedupeWindowId": "dedupe-window-uuid" },
      { "commandId": "cmd-2", "dedupeWindowId": "dedupe-window-uuid" }
    ]
  }
}
~~~

command.statuses response 的每项固定包含且不得省略：

- commandId
- dedupeWindowId
- state：not_accepted、accepted、running、succeeded、failed、in_doubt、expired、unknown
- updatedAtMs、nullable dedupeUntilMs
- retryable、nullable retryAfterMs
- reissueRequired
- nullable result、nullable结构化 error

~~~json
{
  "protocolVersion": 2,
  "kind": "response",
  "type": "command.statuses",
  "requestId": "query-1",
  "hostId": "mac-admin",
  "hostEpoch": "authority-uuid",
  "payload": {
    "dedupeWatermark": {
      "oldestQueryableWindowSeq": "35",
      "newestIssuedWindowSeq": "42",
      "observedAtMs": 1783700200000
    },
    "items": [
      {
        "commandId": "cmd-1",
        "dedupeWindowId": "dedupe-window-uuid",
        "state": "not_accepted",
        "updatedAtMs": 1783700200000,
        "dedupeUntilMs": null,
        "retryable": true,
        "retryAfterMs": 0,
        "reissueRequired": false,
        "result": null,
        "error": {
          "code": "COMMAND_NOT_ACCEPTED",
          "message": "Command was not durably accepted",
          "retryable": true,
          "commandDisposition": "not_accepted",
          "details": null
        }
      }
    ]
  }
}
~~~

八种 state 的 closed nullability/语义矩阵固定如下：

| state / window | dedupeUntilMs | retryable / retryAfterMs | reissueRequired | result | error |
| --- | --- | --- | --- | --- | --- |
| not_accepted / admission-active | null | true / 非负 integer | false | null | COMMAND_NOT_ACCEPTED，commandDisposition=not_accepted |
| not_accepted / queryable but admission-inactive | null | false / null | true | null | COMMAND_WINDOW_EXPIRED，commandDisposition=not_accepted，details={"reissueRequired":true} |
| accepted | null | false / null | false | null | null |
| running | null | false / null | false | null | null |
| succeeded | 非负 integer | false / null | false | §4.5 对应 operation result | null |
| failed | 非负 integer | false / null | false | null | COMMAND_FAILED 或更具体的最终业务 error，retryable=false、commandDisposition=completed |
| in_doubt | 非负 integer | false / null | false | null | COMMAND_IN_DOUBT，retryable=false、commandDisposition=in_doubt |
| expired | 非负 integer | false / null | false | null | COMMAND_RESULT_EXPIRED；details={"finalState":"succeeded|failed|in_doubt"}，disposition 按 finalState 为 completed 或 in_doubt |
| unknown | null | false / null | false | null | COMMAND_STATUS_UNKNOWN，retryable=false、commandDisposition=in_doubt |

updatedAtMs 在有 ledger/tombstone 时是最后权威更新时间；not_accepted/unknown 时是 host 完成本次查询的 observed time。accepted/running 永不按 TTL 淘汰，所以 dedupeUntilMs=null；最终/tombstone 状态的非负值是 host 当前保证 accepted evidence 至少保留到的时间，不授权客户端按本地时钟重放。item state 与 result/error 不符合本表必须视为协议违规。

冻结规则：

- 协议中不存在 not_found；状态、错误码和 commandDisposition 统一使用 not_accepted。
- host 在事务型状态库创建 opaque commandDedupeWindow，并在 hostEpoch 内分配严格递增 windowSeq。每个 window 有 host-clock acceptUntilMs 和 queryUntilMs，并至少保留到 queryUntilMs；时间和 watermark 只供 UI/诊断，client 不据此决定安全性。
- 新 command.execute 必须携带当前仍 admission-active 的 dedupeWindowId。window 已停止接受时，在写 ledger 前返回 COMMAND_WINDOW_EXPIRED/not_accepted、retryable=false、details.reissueRequired=true；Android 只有从未发送或得到该明确 response/query item 时，才能使用新 window和全新 commandId重建命令。
- 已有 ledger/tombstone 的重复 execute 即使 window 不再 admission-active，也先按 command key 返回既有状态，不能被 window expiry 绕过去重。
- not_accepted 只在 expectedHostEpoch 匹配、查询完整成功、item 的 window 仍 queryable、且该 window 范围的 ledger/tombstone 原子查询确认无记录时返回。window 仍 admission-active 才返回 COMMAND_NOT_ACCEPTED/retryable=true/reissueRequired=false，授权复用同 commandId/window；window 已 admission-inactive 则返回 COMMAND_WINDOW_EXPIRED/retryable=false/reissueRequired=true，只授权新 window+新 commandId。它不使用 clientCreatedAtMs，不接受客户端未来时间，也不依赖 Android 与 host 的时钟同步。
- expectedHostEpoch 不匹配返回 HOST_EPOCH_MISMATCH；不得把新 lineage 的空查询解释为 not_accepted。
- expired 表示 tombstone 仍证明该 commandId 曾被接受，但完整结果已过期；禁止自动重发。
- unknown 表示 dedupeWindowId 未知/已过 queryUntilMs、tombstone 已超出可证明窗口或 host 无法证明；禁止自动重发。client 省略/伪造 windowId 也不能得到 not_accepted。
- 单次最多查询 32 项；该值按最坏 succeeded Session result / structured error item 计算，保证完整 command.statuses 仍落在通用 1024 keys、4096 nodes 和 1 MiB frame 上限内。超出必须 INVALID_ARGUMENT，不能截断 items。

两阶段 retention：

- 完整 ledger/result 自最终化起至少保留 24 小时，即 commandResultRetentionMs=86400000。
- 已接受证据自最终化起累计至少保留 7 天，即 commandDedupeRetentionMs=604800000；24 小时后允许把 full result 压缩为 compact tombstone。tombstone 包含 key、requestFingerprint、已接受事实、最终类型和 expired 标记。
- window 的 queryUntilMs 必须覆盖其中最后允许 admission 的 command 至少 commandDedupeRetentionMs；window metadata 删除后，任何无 ledger item 的查询只能 unknown。command.statuses 的 dedupeWatermark 是 host 观察值，不能授权 client 将未列出的旧 window 当作安全。
- 非最终 ACCEPTED/RUNNING 永不按 TTL 淘汰。
- tombstone 期内重复 execute 不执行，返回 expired 或可恢复的最终摘要。
- tombstone 删除后只能返回 unknown，绝不返回 not_accepted。

### 4.5 四类 mutation 与 Session 固定 schema

首个 slice 中所有 snapshot、state event 和 command result 共用同一个 Session resource；relay-host 内部 tmux name、SSH target 和 pane target 不得代替或拼进 sessionId：

~~~json
{
  "scopeId": "scope-local",
  "sessionId": "ses_01JOPAQUE",
  "kind": "worktree|terminal",
  "displayName": "demo",
  "state": "running",
  "project": "demo",
  "label": null,
  "cwd": "/repo/demo",
  "attached": false,
  "windowCount": 1,
  "createdAtMs": 1783700000000,
  "activityAtMs": 1783700000000
}
~~~

字段规则：

- scopeId、sessionId、kind、displayName、state、attached、windowCount、createdAtMs、activityAtMs 必填。
- kind 首版只能是 worktree 或 terminal，state 首版只发布 running；结束通过 sessions.changed delete 表达，不在完整 snapshot 保留虚构 stopped 项。
- project、label、cwd 是显式 nullable 字段；worktree 的 project、cwd 必须非空，terminal 的 label、cwd 必须非空。
- raw tmux session name、SSH hostname、用户名和命令行不是 Session 公共字段。host 在本地持久映射 sessionId 到实际 target。

四种 operation 的 top-level target 和 payload.arguments 冻结如下：

| operation | scopeId | sessionId | arguments | succeeded result |
| --- | --- | --- | --- | --- |
| create_worktree | 必填 | 必须省略 | project?、path?、name?、branch?、aiCommand | { "session": Session } |
| create_terminal | 必填 | 必须省略 | cwd、label? | { "session": Session } |
| send_agent_message | 必填 | 必填 | pane、message、submit | { "pane": 0, "submit": true, "messageUtf8Bytes": 8 } |
| kill_session | 必填 | 必填 | 空 object | { "sessionId": "ses_01JOPAQUE", "terminated": true } |

create_worktree 示例：

~~~json
{
  "operation": "create_worktree",
  "arguments": {
    "project": "demo",
    "path": "/repo/demo",
    "name": "fix-auth",
    "branch": "main",
    "aiCommand": "codex"
  }
}
~~~

- project 和 path 至少一个必填；两者同时存在时 path 定位仓库，project 是项目标识。host 不得把 path/project 作为 shell source 拼接执行。
- project-only 时 host 必须在该 scope 的 authoritative project catalog 中解析到唯一 repository root；未找到返回 PROJECT_NOT_FOUND，多义或不是 repository 返回 INVALID_ARGUMENT。成功 Session.cwd 是 backend 实际创建的新 worktree canonical path，不能用 catalog source root代替。
- path 必须先在目标 scope解析 realpath和 authoritative repository root，拒绝不存在、非 repository 或越过授权 scope 的路径。path-only 的 effectiveProject 是解析后 canonical repository root 的最后一个非空 basename，不是含 ..、symlink alias 或末尾 slash 的原始 input segment；无法得到 basename 时使用 "project"。
- 未提供 name 时 requested display base 为 effectiveProject；若 backend 为避免冲突添加 suffix，最终 Session.displayName 必须返回实际 authoritative label。显式 project/name 与这些 effective default 等价。任何 derived effectiveProject/display base 超过 128 UTF-8 bytes 都返回 INVALID_ARGUMENT，禁止截断。
- v2 只接受 aiCommand；aiCmd 和其他 V1 alias 必须 INVALID_ARGUMENT。
- name 长度 1..20 UTF-8 characters；project/label 1..128 UTF-8 bytes；branch 1..255 UTF-8 bytes；path/cwd/aiCommand 最大 4096 UTF-8 bytes。所有非 message 字符串禁止 NUL 和首尾空白。

create_terminal 示例：

~~~json
{
  "operation": "create_terminal",
  "arguments": {
    "cwd": "/repo/demo",
    "label": "demo shell"
  }
}
~~~

label 省略时 effectiveLabel 固定为解析后 canonical cwd 的最后一个非空 path segment；cwd 为根或没有 segment 时为 "Terminal"。Session.label 和 Session.displayName 都使用 effectiveLabel。derived effectiveLabel 超过 128 UTF-8 bytes 时返回 INVALID_ARGUMENT，禁止截断。

send_agent_message 示例：

~~~json
{
  "operation": "send_agent_message",
  "arguments": {
    "pane": 0,
    "message": "continue",
    "submit": true
  }
}
~~~

- pane 是 0..65535 的 JSON integer，必须精确存在；无效 pane 返回 INVALID_ARGUMENT 或 PANE_NOT_FOUND，不能静默改为 active pane。
- message 最多 65536 UTF-8 bytes。CRLF 和 CR 在纯 schema admission 后、requestFingerprint 与执行前统一规范化为 LF；message 可以为空，但 message 为空且 submit=false 必须 INVALID_ARGUMENT。
- submit 必须显式 boolean。SUCCEEDED 的 messageUtf8Bytes 是规范化正文的 UTF-8 byte 数；正文和 submit/Enter 都完成后才能成功。

kill_session 的 arguments 必须是空 object。目标不存在时首次执行返回最终 FAILED/SESSION_NOT_FOUND；已经成功的同 commandId 重试返回 ledger 中的 SUCCEEDED，不能再次查找或杀死后来复用名称的 tmux session。

所有 operation arguments 使用 closed schema：未知键、null、string/number/boolean coercion、空的必填字段都必须在写 ledger 前拒绝。可选字段只能省略，不允许用 null 表示省略。host 在 requestFingerprint 后物化 effectiveProject、requested display base、effectiveLabel、canonical realpath 和其他解析结果，并把它们冻结进 executionPlan；环境变化不能改变已接受 command 的 plan。accepted/running/in_doubt/failed 的 result 为 null；只有 succeeded 使用上表固定 result。

create 成功 result 中的 Session 与对应 sessions.changed upsert 必须逐字段一致。kill 成功产生固定 change={"op":"delete","sessionId":"..."}；command result 本身不推进 revision/eventSeq，Android 仍以 state event 或 snapshot 推进 cursor。

### 4.6 Android Outbox

~~~text
QUEUED          → SENDING         发送 attempt
SENDING         → ACCEPTED        command.status=accepted
ACCEPTED        → CONFIRMING      running、断线或主动 query
CONFIRMING      → SUCCEEDED       authoritative succeeded
CONFIRMING      → FAILED_FINAL    authoritative failed
CONFIRMING      → REISSUED        proven not accepted, old window inactive
attempted       → AMBIGUOUS       in_doubt、expired、unknown、lineage 丢失
~~~

规则：

- 每行持久绑定 profileId、principalId、hostId、expectedHostEpoch、dedupeWindowId、commandId、operation、scopeId、nullable sessionId、canonical request arguments和 requestFingerprint schemaVersion；切换 profile/principal 不能消费另一身份的 Outbox。
- socket 断开或 request timeout 后进入 CONFIRMING；重连后 query，不盲重发。
- 只有明确 not_accepted、retryable=true、reissueRequired=false、commandDisposition=not_accepted 才自动重发，且复用 commandId和dedupeWindowId。
- 明确 COMMAND_WINDOW_EXPIRED/not_accepted、retryable=false、reissueRequired=true 时，Android 在一个 Room 事务中把原行标为 REISSUED并记录 replacementCommandId，同时用当前 window、新 commandId和同一用户 intent 创建新 QUEUED 行；原行永久禁止再发送。没有该 exact response、原行已 AMBIGUOUS/REISSUED 或 replacement lane 已存在时不得重建。
- QUEUED 和显式 pre-acceptance retryable 项从重复执行角度仍安全；hostEpoch 改变后必须重新验证 scopeId/sessionId，禁止按名称自动改目标。
- 已尝试的 SENDING、ACCEPTED、CONFIRMING 在 hostEpoch 改变且旧 lineage 不可查时进入 AMBIGUOUS；已有 AMBIGUOUS 不会因 epoch 改变变安全。
- 与命令 hostEpoch 一致的权威最终结果，可以把 SENDING、ACCEPTED、CONFIRMING、AMBIGUOUS 收敛为 SUCCEEDED 或 FAILED_FINAL。
- session mutation 的并发键是 (profileId, principalId, hostId, expectedHostEpoch, scopeId, sessionId)。create_worktree/create_terminal 的 sessionId 必须为 null，并使用 (profileId, principalId, hostId, expectedHostEpoch, scopeId, null, operation) 作为显式 create lane；AMBIGUOUS 只阻塞相同 lane，不能用空 sessionId 落入全局或名称键。
- Android 不解析 error.message 决定重试。

## 5. Snapshot revision 与 host eventSeq

### 5.1 authority 和 counter scope

- hosts.snapshot：broker 权威，cursor=(brokerEpoch, hostsRevision)。
- scopes.snapshot：relay-host 权威，revision key=(hostId, hostEpoch, scopes)。
- sessions.snapshot：relay-host 权威，每个 scope 独立 revision key=(hostId, hostEpoch, scopeId)。
- state.snapshot.chunk：relay-host 权威，对持久化 scopes+全部 sessions 的同一 pinned materialized cut 分块传输；只有完整校验并原子组装的 cut 可以携带/应用全局 throughEventSeq。它重建 host 已观察并写入 eventSeq 的状态，不同步阻塞于实时 SSH 枚举。
- host eventSeq 在 (hostId, hostEpoch) 内持久、严格递增，对可由 snapshot 重建的控制面 state event 形成全序。
- command.status/result、terminal、heartbeat、host.presence 和 snapshot response 不占用 host eventSeq。

revision 只在规范化事实变化时递增；重复读取相同内容不递增。

### 5.2 scopes.snapshot 固定 schema

~~~json
{
  "protocolVersion": 2,
  "kind": "request",
  "type": "scopes.snapshot.get",
  "requestId": "scopes-1",
  "hostId": "mac-admin",
  "expectedHostEpoch": "authority-uuid",
  "payload": {}
}
~~~

~~~json
{
  "protocolVersion": 2,
  "kind": "response",
  "type": "scopes.snapshot",
  "requestId": "scopes-1",
  "hostId": "mac-admin",
  "hostEpoch": "authority-uuid",
  "payload": {
    "coverageComplete": true,
    "revision": "7",
    "throughEventSeq": null,
    "items": [
      {
        "scopeId": "scope-local",
        "displayName": "本机",
        "kind": "local",
        "reachability": "online"
      }
    ]
  }
}
~~~

coverageComplete=true 只表示 scopes 维度可以 destructive replace；scopes.snapshot 的 throughEventSeq 永远必须为 null，不能推进跨 scopes+sessions 的全局 event cursor。coverageComplete=false 时 items 只能 upsert，不能 destructive replace。

scopes.snapshot 是单帧 convenience API，不分页。host 必须在发送前计算完整 response 的 raw UTF-8 bytes、keys 和 nodes；若会超过 1 MiB、1024 keys 或 4096 nodes，必须返回 correlated SNAPSHOT_TOO_LARGE、details={"useStateSnapshot":true}，Android 改用 §5.4 multipart state.snapshot。不得用 coverageComplete=false 返回截断 prefix。

### 5.3 sessions.snapshot 固定 schema

~~~json
{
  "protocolVersion": 2,
  "kind": "request",
  "type": "sessions.snapshot.get",
  "requestId": "sessions-1",
  "hostId": "mac-admin",
  "expectedHostEpoch": "authority-uuid",
  "payload": {
    "scopeIds": null
  }
}
~~~

scopeIds=null 表示请求全部已知 scope，用于初始加载或 gap resync。非空 array 是最多 100 个 scope 的 subset refresh；空 array 必须 INVALID_ARGUMENT。

~~~json
{
  "protocolVersion": 2,
  "kind": "response",
  "type": "sessions.snapshot",
  "requestId": "sessions-1",
  "hostId": "mac-admin",
  "hostEpoch": "authority-uuid",
  "payload": {
    "coverageComplete": false,
    "throughEventSeq": null,
    "scopes": [
      {
        "scopeId": "scope-local",
        "revision": "12",
        "completeness": "complete",
        "items": [
          {
            "scopeId": "scope-local",
            "sessionId": "ses_01JOPAQUE",
            "kind": "worktree",
            "displayName": "demo",
            "state": "running",
            "project": "demo",
            "label": null,
            "cwd": "/repo/demo",
            "attached": false,
            "windowCount": 1,
            "createdAtMs": 1783700000000,
            "activityAtMs": 1783700000000
          }
        ],
        "error": null
      },
      {
        "scopeId": "scope-devbox",
        "revision": "20",
        "completeness": "partial",
        "items": [],
        "error": {
          "code": "SCOPE_UNREACHABLE",
          "message": "SSH unavailable",
          "retryable": true,
          "commandDisposition": "not_applicable"
        }
      }
    ]
  }
}
~~~

规则：

- 只有 complete scope 可以按该 scope destructive replace 并记录该 scope revision。
- partial scope 只能 upsert 返回项、标记 stale/unreachable；不得删除缓存里未返回的 Session，也不得推进该 scope 的 last-complete revision。
- response 完全缺少一个已知 scope 不表示删除。
- request.scopeIds=null、host 枚举全部当前 scope且每项 complete 时，coverageComplete 可以为 true，表示 sessions 维度可以按 scope destructive replace；任何 subset request 即使每项 complete，coverageComplete 必须为 false。
- sessions.snapshot 的 throughEventSeq 永远必须为 null。单独覆盖全部 sessions 仍没有覆盖 scopes 维度，不能推进全局 cursor或关闭 gap RESYNCING。
- partial aggregate 只能更新局部 cache；gap recovery 必须继续请求 §5.4 state.snapshot，不能把 scopes.snapshot 与 sessions.snapshot 在 client 侧自行拼成同一 consistent cut。
- sessions.snapshot 同样是单帧 convenience API。完整 requested subset response 超过 1 MiB、1024 keys 或 4096 nodes 时必须整体返回 SNAPSHOT_TOO_LARGE/details.useStateSnapshot=true，不能截断 scope/items、伪造 partial 或省略超限 scope；Android 必须改用 §5.4 multipart。即使只有一个 scope 超限也适用。

### 5.4 state.snapshot 原子全覆盖与有界分块

只有同一 pinned materialized cut 同时覆盖 scopes 维度和所有 scope 的 sessions 维度，才允许推进全局 host eventSeq。它可以跨多个 frame 传输，但不能跨 cut 拼接。首次及 continuation request 使用同一 closed schema；首次 snapshotId/cursor 为 null、nextChunkIndex=0：

~~~json
{
  "protocolVersion": 2,
  "kind": "request",
  "type": "state.snapshot.get",
  "requestId": "state-attempt-1",
  "hostId": "mac-admin",
  "expectedHostEpoch": "authority-uuid",
  "payload": {
    "snapshotRequestId": "logical-snapshot-uuid",
    "snapshotId": null,
    "cursor": null,
    "nextChunkIndex": 0
  }
}
~~~

continuation 必须回显首块得到的 snapshotId、opaque cursor 和下一连续 chunk index；snapshotRequestId 在所有网络 attempt 中保持不变。每个成功 response 都是 state.snapshot.chunk：

~~~json
{
  "protocolVersion": 2,
  "kind": "response",
  "type": "state.snapshot.chunk",
  "requestId": "state-attempt-1",
  "hostId": "mac-admin",
  "hostEpoch": "authority-uuid",
  "payload": {
    "coverageComplete": true,
    "snapshotRequestId": "logical-snapshot-uuid",
    "snapshotId": "pinned-cut-uuid",
    "snapshotCreatedAtMs": 1783700000000,
    "snapshotLeaseExpiresAtMs": 1783700300000,
    "snapshotAbsoluteExpiresAtMs": 1783703600000,
    "chunkIndex": 0,
    "isLast": true,
    "nextCursor": null,
    "throughEventSeq": "91",
    "scopesRevision": "7",
    "totalRecords": 3,
    "totalCanonicalBytes": 920,
    "cutDigest": "sha256-base64url-no-padding",
    "records": [
      {
        "recordType": "scope",
        "item": {
          "scopeId": "scope-local",
          "displayName": "本机",
          "kind": "local",
          "reachability": "online"
        }
      },
      {
        "recordType": "sessions_scope",
        "scopeId": "scope-local",
        "revision": "12",
        "completeness": "complete"
      },
      {
        "recordType": "session",
        "scopeId": "scope-local",
        "item": {
          "scopeId": "scope-local",
          "sessionId": "ses_01JOPAQUE",
          "kind": "worktree",
          "displayName": "demo",
          "state": "running",
          "project": "demo",
          "label": null,
          "cwd": "/repo/demo",
          "attached": false,
          "windowCount": 1,
          "createdAtMs": 1783700000000,
          "activityAtMs": 1783700000000
        }
      }
    ]
  }
}
~~~

relay-host 在首次 request 的一个事务/MVCC cut 中捕获 N=eventSeq、scopesRevision、完整 scope 集和每个 scope 的 sessions revision/items；所有事实必须已反映 seq<=N 的 state event。snapshotId 至少含 128 bit 随机性，绑定 principalId、clientInstanceId、hostEpoch、snapshotRequestId 和 cut；cursor 必须 opaque、不可伪造并绑定下一 chunk。相同 snapshotRequestId 的首次重试和相同 snapshotId/cursor/index 的 continuation 重试必须返回同一 cut/同一 chunk，不能悄悄重开 snapshot。

record stream 的 canonical 顺序固定为 scopeId UTF-8 byte 升序；每个 scope 先一个 recordType=scope，再一个 recordType=sessions_scope，随后按 sessionId UTF-8 byte 升序给出零个或多个 recordType=session。每个已知 scope 恰有一个 scope 和 sessions_scope record；session.scopeId 必须与 record scopeId 相同。三种 recordType 都是 closed schema，不允许 error/partial 或未知字段。cutDigest=SHA-256(RFC-8785 canonical JSON 的完整有序 records array)，使用无 padding Base64URL；totalCanonicalBytes 是同一 canonical bytes 长度。

每块 records 的 canonical bytes 最多 524288、最多 256 records，完整 WebSocket frame 仍不得超过 1 MiB；chunk 全消息最多 8192 JSON keys、16384 nodes。完整 cut 最多 100000 records、268435456 canonical bytes；idle lease 为 300000 ms、absolute lifetime 为 3600000 ms，每个 principal 最多同时 pinned 2 个 cut，单 host 最多 16 个。host.welcome 必须宣告这些 limits。relay-host 必须在宣告 snapshot.revision.v1 前保证当前 materialized state 在总上限内，并在 command admission 阶段拒绝会越界的新资源；外部 reconciliation 使状态越界时必须撤下该 capability并以 CAPABILITY_UNAVAILABLE 关闭 V2 route，绝不能截断 snapshot或给虚假 coverageComplete。

host 不得让长生命周期 MVCC reader 无界保留 WAL/history。首次 request 必须在发送 chunk 0 前把 cut 序列化为权限 0600 的 immutable bounded spool（或具有等价硬资源证明的 snapshot store），随后释放构建用 MVCC transaction。所有 pinned spool canonical bytes 按未压缩 totalCanonicalBytes 计费，单 host 总额 536870912；snapshot metadata/cursor/index 总额 16777216 bytes。首次构建需先预留 principal slot、host slot和保守 byte/metadata额度，最终大小确定后原子调整；任一额度不足时删除未发布 spool并返回 BUSY，不能发送半个 cut。相同 snapshotRequestId 或 continuation 重试复用原 reservation，不重复计费。idle/absolute lease 到期或显式 release 必须关闭文件、删除 spool、cursor和reservation；进程崩溃恢复时验证持久 manifest/digest并清理无有效 lease 的 orphan spool。

isLast=false 时 nextCursor 必须非 null；isLast=true 时必须为 null。所有 chunk 的 snapshotId、snapshotCreatedAtMs、snapshotAbsoluteExpiresAtMs、throughEventSeq、scopesRevision、totalRecords、totalCanonicalBytes 和 cutDigest 必须逐字段相同，chunkIndex 从 0 连续。每次合法首次/continuation/retry request 都把 snapshotLeaseExpiresAtMs 单调延长为 min(hostNow+300000,snapshotAbsoluteExpiresAtMs)，因此该字段可以前进但不得回退或越过 absolute expiry；重复 request 的 records/cursor仍必须相同。idle 或 absolute cut 到期、cursor/index 不匹配、hostEpoch 改变分别返回 SNAPSHOT_EXPIRED、INVALID_ARGUMENT、HOST_EPOCH_MISMATCH；不返回 partial chunk。materialized store 读取失败、已知 scope 缺失或无法证明同一 cut 时返回 correlated INTERNAL/BUSY error，不发送 coverageComplete=false。

snapshotRequestId/snapshotId 必须是最多 128 UTF-8 bytes 的 opaque ID；cursor/nextCursor 最多 1024 UTF-8 bytes，cutDigest 必须是 43 characters 的 canonical无padding Base64URL SHA-256。chunkIndex、nextChunkIndex、totalRecords、totalCanonicalBytes 是 0..9007199254740991 的 JSON integer；其他 revision/event counter 继续使用规范十进制 string。任一字段越界必须在分配 records/staging 前拒绝。

客户端完成或放弃 cut 后使用显式 release：

~~~json
{
  "protocolVersion": 2,
  "kind": "request",
  "type": "state.snapshot.release",
  "requestId": "release-attempt-uuid",
  "hostId": "mac-admin",
  "expectedHostEpoch": "authority-uuid",
  "payload": {
    "snapshotRequestId": "logical-snapshot-uuid",
    "snapshotId": "pinned-cut-uuid",
    "reason": "completed|abandoned"
  }
}
~~~

~~~json
{
  "protocolVersion": 2,
  "kind": "response",
  "type": "state.snapshot.released",
  "requestId": "release-attempt-uuid",
  "hostId": "mac-admin",
  "hostEpoch": "authority-uuid",
  "payload": {
    "snapshotRequestId": "logical-snapshot-uuid",
    "snapshotId": "pinned-cut-uuid",
    "released": true,
    "alreadyReleased": false,
    "releasedAtMs": 1783700200000
  }
}
~~~

release 只允许原 principalId/clientInstanceId/hostEpoch，必须先原子删除 spool/cursor并释放额度再 ACK。相同 binding 重试由 bounded release tombstone 返回原 releasedAtMs、released=false、alreadyReleased=true；未知或其他身份的 snapshotId 返回 SNAPSHOT_EXPIRED且不泄露存在性。release tombstone 计入 metadata 上限并在 min(600000, snapshotAbsoluteExpiresAtMs-hostNow) 后删除。Android 在原子提交完整 cut 后和放弃 staging 前都 best-effort release；response 丢失可安全重试。

普通 SSH 不可达不得阻塞 pinned cut：host 返回截至 N 的 last-known materialized sessions，sessions_scope 仍 completeness=complete，同时在对应 Scope 上写 reachability=unreachable。这里的 complete 表示“完整覆盖 host 在该 event stream 中已观察并持久化的事实”，不承诺远端此刻新鲜；Android 必须把该 scope 的 Session 显示为 stale/unreachable，不能据此发送 mutation。scope 恢复后，host 先与 backend reconcile，再在同一事务中更新 materialized state、revision 和 eventSeq并发布差异 event。

Android 必须把 chunk、snapshotId、nextCursor、nextChunkIndex 和两个 expiry 流式写入按 snapshotId 隔离的 Room staging tables，逐块执行 byte/record/identity/order 上限校验，不能把全部 snapshot 放进 actor/WebView 内存。route/socket 断线不删除合法 staging：同 principalId、clientInstanceId、hostEpoch 在新 route 上必须用已提交的 cursor/index继续；snapshot binding 不包含 routeId、access jti 或 hostInstanceId。同 hostEpoch 的 host 进程重启可从持久 spool manifest恢复；无法恢复才返回 SNAPSHOT_EXPIRED，Android 丢弃并重开。

每次合法 host.welcome 都必须先在 Room 中把同 hostEpoch 的 requiredThroughEventSeq 单调更新为 max(旧值,W=welcome.eventSeq)；若同 hostEpoch 的新 W 小于已持久 required watermark，按 EVENT_CURSOR_AHEAD 对称地视为 authority continuity error，不能提交 snapshot。RESYNCING 期间收到的 state event 必须按 eventSeq 写入有界 Room buffer；只有已持久、无 gap 的连续区间才算恢复证据，volatile actor queue 不算。

跨 route 续传 staged cut 时，Android 在看到新 welcome 后立即比较 cut.throughEventSeq=N 与 requiredThroughEventSeq=R：N>=R 可以继续；N<R 但 Room 已完整持有 N+1..R 可以继续并在最终事务中顺序应用；N<R 且缺任一 event 时必须 best-effort release旧 cut、丢弃 staging，并用新的 snapshotRequestId 获取捕获点不早于该 welcome 的 cut。这是“普通断线不新建 cut”的唯一安全例外。最终只有 snapshot 加连续 buffered events 后的 cursor>=R 才能退出 RESYNCING；即使此后没有任何新 event也不得停在旧 N。

只有收齐 0..last、record/byte count 与 digest 全部匹配后，Android 才在一个本地事务中 destructive replace scopes+全部 sessions、把 cursor 设为 N、删除 staging，再应用已缓冲 seq>N event。idle/absolute expiry、任一校验失败或 RESYNC buffer 溢出时，Android 先 best-effort release旧 cut，再丢弃整个 staging并用新 snapshotRequestId重开；绝不能应用前缀、跨 snapshotId 拼接，或通过单维 snapshot 合成 N。Android 在旧 cut 未 release/expire 时不得因普通断线创建新 snapshotRequestId。

### 5.5 state event 固定语义

每个 host state event 必须包含：

- hostEpoch、eventSeq
- payload.dimension
- payload.resourceKey
- 适用时的 scopeId
- payload.resultingRevision
- 可幂等应用的 change

首版 state event type 只有 scopes.changed 与 sessions.changed，二者是 closed discriminated union；不允许发送泛化 state.changed 或把两种 change 字段混用。

示例：

~~~json
{
  "protocolVersion": 2,
  "kind": "event",
  "type": "sessions.changed",
  "hostId": "mac-admin",
  "hostEpoch": "authority-uuid",
  "scopeId": "scope-local",
  "eventSeq": "92",
  "payload": {
    "dimension": "sessions",
    "resourceKey": "scope-local",
    "resultingRevision": "13",
    "change": {
      "op": "upsert",
      "item": {
        "scopeId": "scope-local",
        "sessionId": "ses_01JOPAQUE",
        "kind": "worktree",
        "displayName": "demo",
        "state": "running",
        "project": "demo",
        "label": null,
        "cwd": "/repo/demo",
        "attached": false,
        "windowCount": 1,
        "createdAtMs": 1783700000000,
        "activityAtMs": 1783700000000
      }
    }
  }
}
~~~

scopes.changed upsert 完整示例：

~~~json
{
  "protocolVersion": 2,
  "kind": "event",
  "type": "scopes.changed",
  "hostId": "mac-admin",
  "hostEpoch": "authority-uuid",
  "scopeId": "scope-devbox",
  "eventSeq": "93",
  "payload": {
    "dimension": "scopes",
    "resourceKey": "scopes",
    "resultingRevision": "8",
    "change": {
      "op": "upsert",
      "item": {
        "scopeId": "scope-devbox",
        "displayName": "Devbox",
        "kind": "ssh",
        "reachability": "unreachable"
      }
    }
  }
}
~~~

四个合法 change shape 精确冻结为：

- scopes.changed/upsert：change 只能含 op="upsert" 和 item=Scope；Scope 必须恰含 scopeId、displayName、kind(local|ssh)、reachability(online|unreachable)。top-level scopeId 与 item.scopeId 相同，resourceKey 固定为 "scopes"。
- scopes.changed/delete：change 只能是 {"op":"delete","scopeId":"scope-devbox"}；top-level scopeId 相同，删除该 Scope 及 Android 中其全部 Session cache。被删 scopeId 在同 hostEpoch 内不得复用。
- sessions.changed/upsert：change 只能含 op="upsert" 和 item=§4.5 完整 Session；top-level scopeId、item.scopeId 与 resourceKey 三者相同。
- sessions.changed/delete：change 只能是 {"op":"delete","sessionId":"ses_01JOPAQUE"}；top-level scopeId/resourceKey 指定所属 scope，删除其他 scope 的同字符串 ID 必须拒绝。

scopes.changed 禁止 top-level sessionId；sessions.changed 的 upsert 可以回显 item.sessionId 但 event 顶层 sessionId 必须省略，避免两个 target source。每个 event 只承载一个 change，并在同一事务中把对应 dimension revision 与全局 eventSeq 各加 1；连续 event 的 resultingRevision 必须等于该 dimension 上次已应用 revision+1。scope delete 不要求先逐条发送 sessions delete；它的原子级联语义已由 closed change 冻结。只有完整权威扫描能产生 delete，partial/unreachable 永远只能 upsert reachability/stale事实。

Android 规则：

- seq<=lastSeq：重复，忽略。
- seq=lastSeq+1：应用，并校验 resultingRevision 单调。
- seq>lastSeq+1 或 revision 回退/跳变不可解释：停止应用 delta，进入 RESYNCING，请求 state.snapshot。
- RESYNCING 期间 event buffer 必须有硬上限；溢出时丢弃全部 delta 和 snapshot staging并重新请求 state.snapshot，不能部分推进 cursor。只有 coverageComplete=true、throughEventSeq 非 null、0..last chunks/count/digest 全部通过且已原子提交的 pinned cut 才能重建 cursor 并退出。
- hostEpoch 变化：清空旧 state cursor 和资源 ID，完整 resync；命令按 4.6 处理。

首 slice gap 后直接请求 state.snapshot，不要求 event replay log。

## 6. Terminal generation、恢复和流控

### 6.1 identity 与 token binding

- streamId：Android 为一个 live xterm view 生成的 UUID；该 view 跨 broker/socket 短重连保持不变。
- streamId 在同一 clientInstanceId/hostEpoch 内不得复用；显式关闭后要打开新的 view 必须生成新 streamId。
- generation：relay-host 签发、永不复用的 opaque ID，定义从 offset=0 开始的一条 raw-byte timeline。
- resumeToken：relay-host 签发的 opaque capability，至少绑定 authenticated principalId、clientInstanceId、hostId、scopeId、sessionId、pane、streamId、generation。
- hostInstanceId 改变、PTY 重建、目标 scope/session/pane 改变或无法保持 timeline 时必须新 generation。
- resize 不改变 generation。

clientInstanceId 参与 resume token 绑定但不是授权主体；最终权限仍来自当前 Bearer principalId/hostId。目标 scope/session/pane 任一变化都不能 resume。

WebView/Activity/process 重建、xterm pending queue 丢失或本地 parser state 不连续时必须 reset，不能把 Room 中的 offset 续到空 xterm。

成功 resume 必须原子地把 stream 绑定到当前 broker route，并 fence 旧 route。host 对每个 terminal client frame 校验当前 route binding；旧 route 的 ACK/input/resize/close 被忽略并返回 TERMINAL_ROUTE_STALE，不得影响新绑定。

### 6.2 raw bytes 与 counter

- terminal input/output 使用 Base64 原始 bytes。
- offset 按 Base64 解码后的 PTY byte 计数，不按 Unicode、UTF-16 或 JSON 长度。
- nextOffset 是排他的“parser 已连续应用、下一期待 byte”。
- 单个 input/output frame 解码后最大 64 KiB。
- xterm.js 使用 Uint8Array。
- inputSeq、resizeSeq 从 "1" 开始，累计 ACK baseline 是 "0"。
- terminal.open 和 terminal.resize 的 cols 必须是 1..1000、rows 必须是 1..500 的 JSON integer；超限返回 INVALID_ARGUMENT，不 clamp。

closed-schema 的唯一 target omission 例外是已经由 live (streamId,generation,routeFence) 绑定的 stream-scoped frame：terminal.output、output_ack、input、input_ack、resize、resize_ack、input_error、resize_error、异步 reset_required 和自然 terminal.closed event 可以省略 hostId、hostEpoch、scopeId、sessionId。terminal.open/replay_request/close request及 terminal.opened/replay_started/显式 terminal.closed response 必须携带完整 host/lineage/target；实现不能在两种 schema 间接受任意混合字段。

### 6.3 terminal.open 模式真值表

terminal.open 是 request，必须包含 expectedHostEpoch、scopeId、sessionId、streamId、稳定 openId、pane、cols、rows 和 mode。requestId 是每次网络 attempt；openId 是响应丢失后保持不变的逻辑控制 ID：

~~~json
{
  "protocolVersion": 2,
  "kind": "request",
  "type": "terminal.open",
  "requestId": "open-1",
  "hostId": "mac-admin",
  "expectedHostEpoch": "authority-uuid",
  "scopeId": "scope-local",
  "sessionId": "ses_01JOPAQUE",
  "streamId": "stream-uuid",
  "payload": {
    "openId": "logical-open-uuid",
    "pane": 0,
    "cols": 120,
    "rows": 36,
    "mode": "new|resume|reset",
    "resume": {
      "generation": "generation-uuid",
      "nextOffset": "1234",
      "resumeToken": "opaque-token"
    }
  }
}
~~~

真值表：

| mode | 必填恢复字段 | 语义 |
| --- | --- | --- |
| new | resume 必须省略 | 创建新 stream；同 openId 的精确重试按下文 retained-state 规则返回原 generation 或 reset_required，同 streamId 的不同 openId 返回 TERMINAL_STREAM_CONFLICT |
| resume | generation、nextOffset、resumeToken 全部必填 | 只允许相同 target 和 generation；失败返回 reset_required，绝不静默 new/reset |
| reset | 若旧 stream 仍存在，必须带其 generation 和 resumeToken | 显式替换 attachment，签发新 generation/token，offset 从 0 |

mode=resume 的 retained-state 决策固定如下；每个 request 只能先得到一个 correlated terminal.opened 或 terminal.reset_required，绝不能两者都发：

| host retained state | 唯一结果 |
| --- | --- |
| live/detached backend 与 generation 存在，ring 覆盖 nextOffset..tailOffset | terminal.opened(resumed) → replay → live |
| live/detached backend 存在，但 generation 不匹配 | correlated terminal.reset_required(reason=generation_stale) |
| live/detached backend 存在，但 ring 不覆盖 nextOffset | correlated terminal.reset_required(reason=offset_expired) |
| closed tombstone 与 ring 存在，bufferStartOffset <= nextOffset <= finalOffset | terminal.opened(resumed) → replay（可为零 bytes）→ terminal.closed |
| closed 但 ring 已淘汰、replayAvailable=false 或 nextOffset < bufferStartOffset | correlated terminal.reset_required(reason=offset_expired) |
| stream/control tombstone 不存在或 hostInstance lineage 无法证明 | correlated terminal.reset_required(reason=stream_lost) |

nextOffset 大于已知 tailOffset/finalOffset 必须 INVALID_ARGUMENT。ring 已淘汰时即使 nextOffset=finalOffset，也走 offset_expired，不能发送 opened→closed；这是首个 slice 为保持 closed schema 唯一性采用的保守规则。返回 reset_required 后，不得为该 request 继续发送 output 或 terminal.closed。

relay-host 为 process-scoped terminal control 保存至少 terminalControlDedupeRetentionMs=600000 的 bounded record，key 为：

~~~text
(authenticated principalId, clientInstanceId, hostEpoch, streamId, openId)
~~~

record fingerprint 包含 scopeId、sessionId、pane、cols、rows、mode，以及适用的旧 generation、nextOffset 和 resumeToken hash；禁止持久或记录明文 resumeToken。

- 同 key、同 fingerprint 的 new/resume/reset 重试，只有在原 generation/backend 仍存活，或 retained closed/control tombstone 足以完整回放原 terminal.opened→output→terminal.closed 时，才必须返回原 terminal.opened；不得再次创建 PTY、再次 reset 或签发新 generation。
- 同 key、不同 fingerprint 返回 TERMINAL_OPEN_CONFLICT。同一 live streamId 使用不同 openId 的 mode=new 返回 TERMINAL_STREAM_CONFLICT。
- mode=reset 的第一次 response 丢失后，只要上述 live state 或完整 tombstone 仍保留，使用同 openId 和原请求重试必须返回第一次 reset 已签发的 generation；不能再次 reset。
- hostInstanceId 改变而 record/stream 丢失时返回 terminal.reset_required(reason=stream_lost)，绝不能把重试静默解释为 new。
- detached lease 已过、tombstone 不足以完整回放或 stream/control state 无法恢复时，同 openId 的精确重试必须返回 terminal.reset_required(reason=stream_lost)，绝不能新建第二个 PTY或签发看似同一次 open 的新 generation。
- Android 必须持久保留 pending openId 和原 request fingerprint，直到收到 terminal.opened 或明确 reset_required。重试期间屏幕尺寸变化不能修改原 open；成功后使用 terminal.resize。

terminal.opened 是对应 response，且必须先于该 generation 的任何 output：

~~~json
{
  "protocolVersion": 2,
  "kind": "response",
  "type": "terminal.opened",
  "requestId": "open-1",
  "hostId": "mac-admin",
  "hostEpoch": "authority-uuid",
  "scopeId": "scope-local",
  "sessionId": "ses_01JOPAQUE",
  "streamId": "stream-uuid",
  "hostInstanceId": "host-process-uuid",
  "payload": {
    "openId": "logical-open-uuid",
    "deduplicated": false,
    "generation": "generation-uuid",
    "resumeToken": "opaque-token",
    "disposition": "new|resumed|reset",
    "replayFromOffset": "1234",
    "bufferStartOffset": "1024",
    "tailOffset": "1600",
    "maxUnackedBytes": 524288,
    "resetReason": null
  }
}
~~~

terminal.opened 是 open watchdog 的成功 ACK；安静终端不依赖首包 output。retained state 足以回放时，重复 open 回应使用新的 requestId、相同 openId/generation/token，并设 deduplicated=true；不足时改回 terminal.reset_required(stream_lost)。新 route 上可回放的重试必须先发送 terminal.opened，再从请求 nextOffset replay，最后衔接 live output。Android 发 reset 前不得先清空 xterm；只有收到 disposition=reset 的 terminal.opened 后，才在该 generation 首个 output 前清空。

### 6.4 output、ACK 与 replay

output event：

~~~json
{
  "protocolVersion": 2,
  "kind": "event",
  "type": "terminal.output",
  "streamId": "stream-uuid",
  "payload": {
    "generation": "generation-uuid",
    "offset": "1234",
    "encoding": "base64",
    "data": "..."
  }
}
~~~

output_ack event：

~~~json
{
  "protocolVersion": 2,
  "kind": "event",
  "type": "terminal.output_ack",
  "streamId": "stream-uuid",
  "payload": {
    "generation": "generation-uuid",
    "nextOffset": "1290"
  }
}
~~~

Android 只在 xterm.write(Uint8Array, callback) callback 返回后推进 nextOffset 并 ACK。建议累计 64 KiB 或 200 ms ACK；前后台切换和断线前 best-effort flush。

host 为当前 route binding 维护 ackedOffset 和 sentThroughOffset：

- ACK 单调；重复/落后 ACK 幂等忽略。
- ACK 上限是当前 binding 的 sentThroughOffset，不是 production tailOffset。
- sentThroughOffset-ackedOffset 不得超过 terminalMaxUnackedBytes=512 KiB。
- ACK 超过 sentThroughOffset 返回 TERMINAL_INVALID_ACK。

Android 期待 offset=N：

- frame.offset=N：应用。
- frame.end<=N：重复，丢弃并可重 ACK。
- 与 N 部分重叠：裁掉已应用前缀。
- frame.offset>N：不应用，发送 terminal.replay_request。

replay request 与成功 response：

~~~json
{
  "protocolVersion": 2,
  "kind": "request",
  "type": "terminal.replay_request",
  "requestId": "replay-1",
  "hostId": "mac-admin",
  "expectedHostEpoch": "authority-uuid",
  "scopeId": "scope-local",
  "sessionId": "ses_01JOPAQUE",
  "streamId": "stream-uuid",
  "payload": {
    "generation": "generation-uuid",
    "fromOffset": "1290"
  }
}
~~~

~~~json
{
  "protocolVersion": 2,
  "kind": "response",
  "type": "terminal.replay_started",
  "requestId": "replay-1",
  "hostId": "mac-admin",
  "hostEpoch": "authority-uuid",
  "scopeId": "scope-local",
  "sessionId": "ses_01JOPAQUE",
  "streamId": "stream-uuid",
  "payload": {
    "generation": "generation-uuid",
    "fromOffset": "1290",
    "tailOffsetAtStart": "1600"
  }
}
~~~

terminal.open(mode=resume 或精确重试) 与 terminal.replay_request 在 generation 不匹配、buffer gap、stream 丢失或 hostInstanceId 已改变时，共用下列 correlated terminal.reset_required response。origin 是 closed discriminator，必须与触发它的 request type 一致：

~~~json
{
  "protocolVersion": 2,
  "kind": "response",
  "type": "terminal.reset_required",
  "requestId": "replay-1",
  "hostId": "mac-admin",
  "hostEpoch": "authority-uuid",
  "scopeId": "scope-local",
  "sessionId": "ses_01JOPAQUE",
  "streamId": "stream-uuid",
  "payload": {
    "origin": "replay",
    "generation": "generation-uuid",
    "reason": "generation_stale|offset_expired|stream_lost|slow_consumer|host_buffer_pressure",
    "requestedOffset": "1290",
    "bufferStartOffset": "1500",
    "tailOffset": "2000"
  }
}
~~~

origin 只能是 open 或 replay。generation、requestedOffset、bufferStartOffset、tailOffset 都是必填但 nullable 的字段：有对应 request/generation 或 retained watermark 时为无符号十进制 string/opaque generation，否则为 null；stream_lost 通常只有 request 中已知的 generation/requestedOffset，bufferStartOffset/tailOffset 为 null；offset_expired 必须给 requestedOffset 和 tailOffset，ring 已淘汰时 bufferStartOffset=null。terminal.open 的首个 correlated response 只能是 terminal.opened 或 origin=open 的 reset_required；terminal.replay_request 只能是 terminal.replay_started 或 origin=replay 的 reset_required。response 后不得发送该 request 另一分支的 ACK/data。

异步发现也可发送同 type 的 stream-scoped event，但它是另一份 closed schema，不携带 requestId、origin 或 target：

~~~json
{
  "protocolVersion": 2,
  "kind": "event",
  "type": "terminal.reset_required",
  "streamId": "stream-uuid",
  "payload": {
    "generation": "generation-uuid",
    "reason": "slow_consumer",
    "requestedOffset": null,
    "bufferStartOffset": "1500",
    "tailOffset": "2000"
  }
}
~~~

同一 binding 的 output 必须严格按 offset 连续递增。replay 期间 backend 新 output 继续进入 ring，但不能越过 replay 插队；host 先重放到捕获的 tail，再按序衔接期间新增数据，最后进入 live。

### 6.5 input 与 input ACK

~~~json
{
  "protocolVersion": 2,
  "kind": "event",
  "type": "terminal.input",
  "streamId": "stream-uuid",
  "payload": {
    "generation": "generation-uuid",
    "inputSeq": "1",
    "encoding": "base64",
    "data": "..."
  }
}
~~~

~~~json
{
  "protocolVersion": 2,
  "kind": "event",
  "type": "terminal.input_ack",
  "streamId": "stream-uuid",
  "payload": {
    "generation": "generation-uuid",
    "ackedThroughInputSeq": "1"
  }
}
~~~

host 必须：

- 严格按 inputSeq 写 backend；gap 返回 TERMINAL_INPUT_GAP。
- backend transport 接受 bytes 后才累计 ACK；ACK 不代表 shell 已执行。
- 每个 generation 只保存最近 terminalInputDedupeEntriesPerStream=512 个已累计 ACK inputSeq 的 SHA-256 payload hash，并持久维护 ackedThroughInputSeq 与 inputDedupeFloorSeq；不得保存全部 payload 或无界历史。
- inputDedupeFloorSeq < seq <= ackedThroughInputSeq 时，相同 hash 只重发当前累计 ACK、不重复写，不同 hash 返回 TERMINAL_INPUT_CONFLICT。
- seq <= inputDedupeFloorSeq 表示记录已按序安全淘汰；host 不再声称能比较旧 hash，但必须不执行、只重发当前累计 ACK。seq=ackedThroughInputSeq+1 才能进入 backend；更大 seq 返回 TERMINAL_INPUT_GAP。
- 窗口超过 512 时只能淘汰已经累计 ACK 的最旧连续 prefix 并同步推进 floor；不能扩大容器或淘汰尚未累计 ACK 的状态。generation 改变或 detached lease 结束后清空该窗口。
- generation 相同可重发未 ACK input；generation 改变则未 ACK input 为 AMBIGUOUS，不得写入新 PTY。

input gap/conflict 使用 stream-scoped event：

~~~json
{
  "protocolVersion": 2,
  "kind": "event",
  "type": "terminal.input_error",
  "streamId": "stream-uuid",
  "payload": {
    "generation": "generation-uuid",
    "inputSeq": "3",
    "ackedThroughInputSeq": "1",
    "error": {
      "code": "TERMINAL_INPUT_GAP",
      "message": "Expected inputSeq 2",
      "retryable": true,
      "commandDisposition": "not_applicable",
      "details": null
    }
  }
}
~~~

### 6.6 resizeSeq 与 resize ACK

terminal.resize 是 event：

~~~json
{
  "protocolVersion": 2,
  "kind": "event",
  "type": "terminal.resize",
  "streamId": "stream-uuid",
  "payload": {
    "generation": "generation-uuid",
    "resizeSeq": "1",
    "cols": 120,
    "rows": 36
  }
}
~~~

host 应用 PTY/SSH resize 后发送：

~~~json
{
  "protocolVersion": 2,
  "kind": "event",
  "type": "terminal.resize_ack",
  "streamId": "stream-uuid",
  "payload": {
    "generation": "generation-uuid",
    "ackedThroughResizeSeq": "1"
  }
}
~~~

规则：

- Android 可以在发送前合并快速 resize，但每个实际发送帧的 resizeSeq 必须连续。
- host 严格按序应用；gap 返回 TERMINAL_RESIZE_GAP。
- 每个 generation 只保存最近 terminalResizeDedupeEntriesPerStream=256 个已累计 ACK resizeSeq 的 (cols,rows)，并维护 ackedThroughResizeSeq 与 resizeDedupeFloorSeq。
- resizeDedupeFloorSeq < seq <= ackedThroughResizeSeq 时，相同 cols/rows 只重 ACK，不同尺寸返回 TERMINAL_RESIZE_CONFLICT；seq <= resizeDedupeFloorSeq 时不再比较旧尺寸，但必须不执行、只重发当前累计 ACK。
- seq=ackedThroughResizeSeq+1 才能应用；更大 seq 返回 TERMINAL_RESIZE_GAP。窗口超过 256 时只淘汰已 ACK 的最旧连续 prefix 并推进 floor，generation 改变或 lease 结束时清空。
- ACK 前可以重发；generation 改变时丢弃旧 pending resize，新尺寸由 terminal.open 的 cols/rows 建立。

resize gap/conflict 使用：

~~~json
{
  "protocolVersion": 2,
  "kind": "event",
  "type": "terminal.resize_error",
  "streamId": "stream-uuid",
  "payload": {
    "generation": "generation-uuid",
    "resizeSeq": "3",
    "ackedThroughResizeSeq": "1",
    "error": {
      "code": "TERMINAL_RESIZE_GAP",
      "message": "Expected resizeSeq 2",
      "retryable": true,
      "commandDisposition": "not_applicable",
      "details": null
    }
  }
}
~~~

不能只发送无法关联 sequence 的通用 error。

### 6.7 close 与最终 watermark

显式 close 使用稳定 closeId；requestId 每次 attempt 变化。live backend 只允许当前 routeFence 绑定关闭，resumeToken 同时证明 principal/client/target/generation binding：

~~~json
{
  "protocolVersion": 2,
  "kind": "request",
  "type": "terminal.close",
  "requestId": "close-1",
  "hostId": "mac-admin",
  "expectedHostEpoch": "authority-uuid",
  "scopeId": "scope-local",
  "sessionId": "ses_01JOPAQUE",
  "streamId": "stream-uuid",
  "payload": {
    "closeId": "logical-close-uuid",
    "generation": "generation-uuid",
    "resumeToken": "opaque-token"
  }
}
~~~

显式 close 的 terminal.closed 必须是 response：

~~~json
{
  "protocolVersion": 2,
  "kind": "response",
  "type": "terminal.closed",
  "requestId": "close-1",
  "hostId": "mac-admin",
  "hostEpoch": "authority-uuid",
  "hostInstanceId": "host-process-uuid",
  "scopeId": "scope-local",
  "sessionId": "ses_01JOPAQUE",
  "streamId": "stream-uuid",
  "payload": {
    "closeId": "logical-close-uuid",
    "generation": "generation-uuid",
    "finalOffset": "2400",
    "replayAvailable": true,
    "bufferStartOffset": "1800",
    "reason": "backend_exit",
    "exitCode": 0,
    "deduplicated": false
  }
}
~~~

backend 自然退出时 terminal.closed 是无 requestId、无 closeId、无 deduplicated 的 stream-scoped event，但其 generation、finalOffset、replayAvailable、bufferStartOffset、reason、exitCode 与 response 相同。

~~~json
{
  "protocolVersion": 2,
  "kind": "event",
  "type": "terminal.closed",
  "streamId": "stream-uuid",
  "payload": {
    "generation": "generation-uuid",
    "finalOffset": "2400",
    "replayAvailable": false,
    "bufferStartOffset": null,
    "reason": "backend_exit",
    "exitCode": 0
  }
}
~~~

relay-host 为 close 保存至少 terminalControlDedupeRetentionMs 的 bounded tombstone，key 为 (principalId, clientInstanceId, hostEpoch, streamId, closeId)，fingerprint 包含 scopeId、sessionId、generation 和 resumeToken hash：

- 同 key、同 fingerprint 重试必须固定返回相同 generation、finalOffset、reason 和 exitCode，deduplicated=true；不得再次关闭任何 backend。replayAvailable 和 bufferStartOffset 不是 tombstone identity，必须按每次 response 时 ring 的当前状态重新计算。
- 同 key、不同 fingerprint 返回 TERMINAL_CLOSE_CONFLICT。
- close 与 backend 自然退出竞态采用第一个已原子提交的 terminal condition；close response 返回既有最终 reason，不伪造 client_closed。
- live stream 的 close 只能来自当前 route binding。stream 已关闭后，同 principal/client/token 可以从新 route 查询 tombstone；它不能影响后来使用新 streamId/generation 的 terminal。
- tombstone 可以在 output ring 到期后继续存在。replayAvailable=true 时 bufferStartOffset 是 ring 当前最早 offset，并且后续 response 中只能保持或单调前移；ring 淘汰后可以从 true 单调退化为 false，此后不得恢复为 true，bufferStartOffset 必须为 null。replayAvailable=false 只描述 close response/tombstone 查询时的当前 ring 状态，不授权后续 resume；Android nextOffset<finalOffset 时立即显示截断，不能等待或另发无法成功的 replay。

reason/exitCode 矩阵固定：client_closed 的 exitCode 必须为 null；backend_exit 的 exitCode 必须是 signed 32-bit integer；backend_error 在 backend 没有可靠退出码时为 null，有可靠退出码时可以是 signed 32-bit integer。自然 event 的 reason 只能 backend_exit/backend_error；显式 close response 可以返回三者，以表达 close 与自然退出竞态的实际 winner。

host 必须先按序发送所有可用 output，再发送 closed。finalOffset 是最终 terminal watermark。Android 只有 parser-applied nextOffset=finalOffset 才最终关闭；若小于则 replay，若已小于 bufferStartOffset 则显示截断并走 reset_required。只有 closed ring 完整覆盖请求区间时，resume 已 closed stream 的顺序才是 opened(resumed) → replay output → closed；ring 不可用或存在 gap 时按 §6.3 只返回 reset_required，不发送 opened、output 或 closed。

### 6.8 ring、slow consumer 与 broker backpressure

冻结 limits：

- 每 stream replay ring：4 MiB。
- 单 host 所有 stream ring 总和：64 MiB。
- 每 binding 未 ACK output credit：512 KiB。
- detached stream lease：120 秒。
- terminal open/close control record：至少 10 分钟。
- 单 input/output frame：64 KiB decoded。
- 每 stream input hash 去重窗口：512 entries；resize 去重窗口：256 entries。
- 单 host 最多 256 个 live/detached terminal stream、4096 个未过 retention 的 terminal control/tombstone record；open admission 必须预留其 open dedupe record 和一个未来 close tombstone slot，达到任一上限时在创建 backend 前以 BUSY 拒绝新的 open。close 不能因 control store 已满而失败，也不能提前淘汰未到期 record；预留 slot 在对应 retention 结束后释放。
- broker 单 client route 每方向高水位 1 MiB、低水位 512 KiB，最多 128 帧。
- broker 单 host carrier 聚合高水位 16 MiB、低水位 8 MiB。
- 单 route 同时未完成 request：64。

所有 queue limit 按 raw/UTF-8 byte 计算，不按 JavaScript UTF-16 或 Kotlin Char 数；application queue、WebSocket bufferedAmount 和尚未 ACK 的 carrier write 都必须计入。broker/host/Android 不得先放入无界 actor/channel 再在出口检查。

host 压力策略按顺序执行：

1. 达到 512 KiB credit 时停止向该 route 发送 output，不再增加 broker 队列。
2. output 可继续进入该 stream ring；接近会覆盖当前 binding 仍需数据时，先暂停 PTY/SSH 读取以施加 backend backpressure。
3. 达到 64 MiB host 总上限时，先淘汰 closed、再淘汰 detached 的 LRU ring；之后仍超限则暂停 active backend 读取。
4. adapter 无法暂停且不可避免丢失时，fence 该 binding，发送 terminal.reset_required(reason=slow_consumer 或 host_buffer_pressure)；绝不跳 offset 或伪造连续。

broker 不得无界缓存，并且 carrier 必须按 route 公平调度，单个 terminal route 不能让其他 route 或 enrollment/control message 永久饥饿：

- queue 达到高水位时必须暂停对应 source read，只有降到低水位以下才恢复，避免阈值抖动；高水位持续 5 秒仍不能排空时执行下述 route close/reject。frame-count 和 byte limit 任一先到都视为高水位。
- client→host frame 在尚未进入 carrier 前被拒绝时，broker 可以返回 SLOW_CONSUMER；只有能证明对应 command frame 从未转发时，commandDisposition 才能是 not_accepted。
- frame 一旦写入 carrier，broker 就不能再宣称 command 未接受；route/carrier 随后断开时 Android 必须通过 command.query 收敛。
- host→client route 达到 1 MiB 且不能排空时，broker best-effort 返回 SLOW_CONSUMER，以 close code 1013 关闭该 client route并发送 route.unbind(reason=slow_consumer)。
- carrier 聚合达到 16 MiB 时拒绝新 route，并关闭造成压力的 route；不能继续增长，也不能为了一个 route 清空其他 route 的已排队控制 response。
- broker 不关闭 backend、不生成 terminal.closed；host 保持 120 秒 lease 供 resume。

Android 的 network frame queue、actor action/event queue、RESYNCING delta buffer、terminal→WebView buffer 和 UI effect queue 都必须有文档化硬上限。任何 control/state queue 饱和都必须触发连接 reset、command query 或完整 snapshot；不能静默丢 command status、terminal reset/closed 或 snapshot cursor。terminal output 只有在 xterm parser callback 后才释放 credit。

显式 terminal.close 释放 live backend。已 closed stream 的尾部 ring 和 final state 保留到 lease 到期。broker/client 短断线只 unbind route；TerminalStreamManager 必须脱离单次 broker connection 生命周期。

## 7. 结构化错误

~~~json
{
  "code": "HOST_OFFLINE",
  "message": "Host is not connected",
  "retryable": true,
  "retryAfterMs": 1000,
  "commandDisposition": "not_accepted",
  "details": null
}
~~~

commandDisposition：

- not_accepted：命令尚未写入权威 ledger，可复用同 commandId 重试。
- accepted、running、completed：按 command.status/query 收敛。
- in_doubt：可能已有副作用，禁止自动重放。
- not_applicable：非 command 请求。

retryable=true 只表示条件恢复后可再次 attempt。对 command，它只有在 commandDisposition=not_accepted 时授权自动重发，且必须复用 commandId。持久 ledger 的 FAILED 是最终状态，retryable=false。

details 必须是 null 或由具体 error code 冻结的 closed object。HOST_EPOCH_MISMATCH 的 details 为 {"expectedHostEpoch":"...","actualHostEpoch":"..."}；EVENT_CURSOR_AHEAD 为 {"clientLastEventSeq":"...","hostEventSeq":"..."}；COMMAND_WINDOW_EXPIRED 为 {"reissueRequired":true}；SNAPSHOT_TOO_LARGE 为 {"useStateSnapshot":true}；不得把可机读 lineage 或重建授权只写在 message。

首版错误码：

- AUTH_REQUIRED
- AUTH_INVALID
- PERMISSION_DENIED
- GRANT_NOT_FOUND
- ROLE_MISMATCH
- PROTOCOL_UNSUPPORTED
- HOST_DIALECT_UNAVAILABLE
- CAPABILITY_UNAVAILABLE
- INVALID_ENVELOPE
- INVALID_ARGUMENT
- HOST_NOT_FOUND
- HOST_OFFLINE
- HOST_EPOCH_MISMATCH
- EVENT_CURSOR_AHEAD
- HOST_SUPERSEDED
- DUPLICATE_CONNECTOR
- SCOPE_NOT_FOUND
- SCOPE_UNREACHABLE
- SNAPSHOT_EXPIRED
- SNAPSHOT_TOO_LARGE
- PROJECT_NOT_FOUND
- SESSION_NOT_FOUND
- PANE_NOT_FOUND
- IDEMPOTENCY_CONFLICT
- COMMAND_NOT_ACCEPTED
- COMMAND_WINDOW_EXPIRED
- COMMAND_RESULT_EXPIRED
- COMMAND_STATUS_UNKNOWN
- COMMAND_IN_DOUBT
- COMMAND_FAILED
- RATE_LIMITED
- BUSY
- SLOW_CONSUMER
- TERMINAL_STREAM_NOT_FOUND
- TERMINAL_STREAM_CONFLICT
- TERMINAL_OPEN_CONFLICT
- TERMINAL_CLOSE_CONFLICT
- TERMINAL_ROUTE_STALE
- TERMINAL_GENERATION_STALE
- TERMINAL_OFFSET_EXPIRED
- TERMINAL_INVALID_ACK
- TERMINAL_INPUT_GAP
- TERMINAL_INPUT_CONFLICT
- TERMINAL_RESIZE_GAP
- TERMINAL_RESIZE_CONFLICT
- INTERNAL

最低语义：

- broker 在转发前返回 HOST_OFFLINE 时必须 commandDisposition=not_accepted。
- relay-host 写 ledger 前的临时失败可 retryable=true/not_accepted。
- 已进入 RUNNING 且不能证明副作用边界的 timeout/INTERNAL 必须 in_doubt。
- 所有 command error 回显 requestId、commandId、hostId 和适用的 scopeId/sessionId。
- Android 只看 code、retryable、commandDisposition，不解析 message。

## 8. Android v1/v2 迁移

当前 Android、Dashboard、relay-server 和 relay-host 实现仍是纯 Relay v1：Session identity 是 hostId+name，Outbox 保存 sessionName/body，配对 credential 是 shared secret。它们没有本文定义的 hostEpoch、opaque sessionId、durable command ledger、twcap2 enrollment 或 resumable terminal，因此当前构建必须只宣告 V1。

- 保留 RelayV1ConnectionActor 和 v1 codec，不改变 legacy 扁平消息及 requestId 兼容语义。新建独立 RelayV2 actor、codec、repository 和 profile；不得把 v2 分支散落进 v1 actor。
- profile 必须持久记录 credentialKind=legacy_shared_secret 或 twcap2_grant。V1 profile 只 offer tw-relay.v1；V2 profile 只 offer tw-relay.v2。旧 profile、旧二维码和旧 adb pairing 永远是 V1，不能原地把 shared secret 标记为 twcap2。
- v2 enrollment 使用独立 tmuxworktree://enroll payload和用户确认流程。现有 tmuxworktree://pair shared-secret payload 不能被 V2 parser 接受。
- V2 credential storage 以一个可原子替换的版本化 blob 保存 issuerUrl、relayUrl、hostId、principalId、grantId、clientInstanceId、access token/expiry、refresh token/expiry，以及 pending exchangeAttemptId/refreshAttemptId 与所用 secret reference；成功 response 的新 credential 与清除 pending attempt 必须在同一次 blob replace 中提交。Room 只保存不敏感 credential reference/version并可从该 blob 重建，secret token 不得进入 Room。
- V2 使用独立、版本化 Room namespace或完成原子 destructive migration；Session primary key 至少包含 profileId、hostId、hostEpoch、scopeId、opaque sessionId。旧 V1 hostId+name 行不得原地提升、猜测 sessionId、按显示名称合并或自动重定向。
- V2 Outbox 必须持久保存 profileId、principalId、schema/fingerprint version、expectedHostEpoch、dedupeWindowId、commandId、operation、scopeId、nullable sessionId、canonical normalized arguments、状态、attempt requestId 和创建时间。创建时间只用于 UI 排序，不参与 not_accepted 证明。旧 V1 sessionName/body Outbox 行不能转换为已尝试 V2 command；只能留在 V1 profile、由用户删除，或在从未发送且用户明确确认后创建全新 commandId。
- pending terminal state 必须版本化并绑定 profileId、hostId、hostEpoch、hostInstanceId、scopeId、sessionId、streamId、generation、openId、closeId、resume token credential reference、parser-applied nextOffset、inputSeq/resizeSeq checkpoint。缺失任一 identity/checkpoint、WebView parser state 不连续或 schema version 不兼容时必须 reset，不能从旧 V1 streamId/name 推导。
- 每个 client socket dialect 固定；mutation 一旦以 v2 commandId 发出，不得转 V1 重做。V2 profile 遇到 V1-only broker/host 只报告升级要求，不创建临时 V1 profile。
- brokerEpoch 变化重新获取 broker 目录；hostEpoch 变化清空旧 state cursor/resource ID，并按 Outbox lineage 规则进入 query/AMBIGUOUS；hostInstanceId 变化重新握手并 reset terminal，但不自动把 durable command 判为丢失。
- capability 可短期缓存，不跨 brokerEpoch/hostEpoch 信任。terminal.stream.resume.v1 未完整协商时不能混发部分 V2 terminal 帧。
- 只有 §9 的 broker、carrier、host ledger/snapshot/terminal manager 和独立 Android V2 persistence 全部通过 §10 验收后，构建才能生成 V2 enrollment、保存 twcap2 profile 或宣告任何 V2 capability。

## 9. 桌面端最小 v2 slice

Android 把目标 host 切为 v2 前，桌面端至少交付以下四个不可拆的 slice。

### A. broker identity、双栈与 presence

- 持久 issuer keyring、一次性 enrollment、rotating refresh grant、revoke 和在线 socket expiry；只从 twcap2 Authorization 形成 V2 auth context。
- credentialKind 决定单一 offered dialect；legacy/V2 互不提升，任何 auth、协议或 capability 失败都不 silent fallback。
- brokerEpoch、versioned hosts.snapshot、host.presence reconnect/gap 语义。
- hostEpoch+hostInstanceId registry；不同 hostInstanceId 的新合法 connector 原子 SUPERSEDED旧进程，同 hostInstanceId duplicate 只拒绝 newcomer。
- host.hello/host.registered ACK、route.open/data/unbind/close、connectorId+routeFence、可信 auth context；不做业务翻译。
- strict frame/schema parser、结构化 pre-forward error、每方向 1 MiB route和 16 MiB carrier backpressure。
- host 掉线只报告 suspended/offline，不伪造 terminal exit。

### B. relay-host command plane

- 0600 事务型状态库保存 hostEpoch、ledger、revision、eventSeq；每进程新 hostInstanceId。
- 四类 mutation 的 command.execute/status/query、principal-scoped key 和 requestFingerprint 冲突。
- command.execute/query 的 expectedHostEpoch 在 requestFingerprint/ledger 前校验；四种 arguments/result 和公共 Session schema closed、无 V1 alias。
- ACCEPTED 安全重排；第一次副作用前 RUNNING；崩溃后 RUNNING→IN_DOUBT。
- 24h full result + 7d tombstone；not_accepted/expired/unknown 明确区分。
- 故障注入：转发前断线、status 丢失、执行后 result 丢失、正文/Enter 中间崩溃、状态库回滚、host 重启。

### C. versioned scope/session snapshot

- scopeId 独立、host 签发 opaque sessionId。
- scopes host revision、sessions per-scope revision、host eventSeq。
- 单维 snapshot 固定 throughEventSeq=null；只有同一 pinned materialized cut 的全部 state.snapshot.chunk 通过 count/digest 后才能携带全局 cursor。
- live sessions.snapshot 的 partial SSH scope 不删除 Android 缓存、也不自行推进全局 cursor。
- gap→基于持久 last-known materialized cut 的 coverageComplete 分块 snapshot；SSH unreachable 通过 reachability/stale 表达但不阻塞 cursor。Android 使用 Room staging，全部 chunk 到齐后原子替换；首版无需 event replay。

### D. process-scoped terminal manager

- opened/open modes、host generation、raw-byte offset、current-binding ACK。
- openId/closeId control dedupe、response-loss 重试、10 分钟 bounded tombstone。
- route rebind fencing、严格 replay/live ordering、closed finalOffset。
- inputSeq/hash ACK；resizeSeq/ACK。
- 4 MiB/stream、64 MiB/host、512 KiB credit、120 秒 lease、broker/host backpressure。
- broker/client 短断线时 backend 与 ring 存活；hostInstanceId 改变则 reset。

Agent 时间线、Agent 状态、通知、附件和 event replay log 不属于最小 slice，不得提前宣告相关 capability。

## 10. 冻结验收点

1. V1 shared secret 只建立 V1；twcap2 只建立 V2。四种 client/host dialect 组合、HTTP 401/403/426/503、101 后 relay.unavailable race、旧 broker legacy ready 和 capability 缺失都证明无 silent fallback。client.hello 的 null/matched/behind/epoch-changed/ahead 五种 resume case 分别命中冻结 disposition，只有 matched 可直接 ONLINE；在 capture W、subscriber register、welcome enqueue 每个边界注入并发 state commit，证明 W+1 必定排在 welcome 后且无静默 gap。
2. enrollment/bootstrap code 满足 entropy、单次、限流和超时；exchange/bootstrap/refresh attempt 的 response 丢失能在 10 分钟内精确重放同一 credential，refresh token 仍只原子轮换一次；host.reauthenticate ACK 丢失用同 requestId/jti 重放且不换 connector或触发 SUPERSEDED；revoke 和 exp 后 broker 不再转发 frame并在规定时间关闭 socket。kid rotation 在旧 token 有效期内可验证，移除 key 会关闭对应连接。
3. v2 principal/grant/clientInstanceId 只来自验证后的 Authorization auth context；公共入站 frame 伪造这些字段必须拒绝。hosts.snapshot/host.presence 对 client 只暴露 claim hostId。
4. host.hello 只有 host.registered 后才上线；同 hostInstanceId duplicate 必须以 carrier.error/4411 拒绝 newcomer且保留既有 connector，不同 hostInstanceId 的 loser 才必须 SUPERSEDED且不重连。旧 connectorId、routeId、routeFence 的 data/unbind/close 都不能影响 winner。
5. carrier route.open/data/unbind/close 有严格 schema、双向连续 seq 和硬 buffer 上限；broker/host 不翻译 V1/V2 payload。
6. hostEpoch 是持久 lineage，hostInstanceId 是进程。command.execute/query 缺 expectedHostEpoch 必须 INVALID_ENVELOPE；epoch mismatch 在 requestFingerprint/ledger 前返回且状态库无 command/tombstone 行。
7. command.status 必须由 relay-host 在 durable ledger 后产生；broker不得代发。command.statuses 八种 state 的 result/error/nullability 逐项通过 golden codec；query 不存在 not_found，not_accepted、expired、unknown、in_doubt 和 epoch 丢失不能互换或授权盲重试。
8. create_worktree、create_terminal、send_agent_message、kill_session 的 target、arguments、defaults、result 和 Session resource 逐字段通过 golden codec；未知键、V1 alias、类型 coercion 和 pane fallback 都被拒绝。
9. sessionId 不透明且与 scopeId/hostEpoch 分离；V1 hostId+name cache/outbox 不得原地提升或按名称重定向。V2 Room key、Outbox fingerprint version和 credential namespace通过升级/回滚测试。
10. scopes/sessions 单维 snapshot 永不推进全局 event cursor；只有同一 pinned cut 的分块 snapshot 在 512 KiB/块、总 record/byte/key/node 上限内全部到齐并通过 digest 后才能原子推进。SSH 暂时失败不能删除远端 Session，也不能阻塞 materialized cut；普通 route 断线从 Room cursor 跨 route 续传，但新 host.welcome 的 requiredThroughEventSeq 是提交下限：旧 cut 未覆盖且缺连续 durable event buffer时必须 release并重取。压力测试覆盖“断线期间产生事件、之后再无事件”、高 RTT/断线续传、release 幂等，以及多 principal 的 per-host cut slots、512 MiB spool、16 MiB metadata与 lease/orphan 回收。
11. command lifecycle 不占 host eventSeq；status/result 丢失只能用同 commandId/query 恢复。故障注入覆盖转发前断线、ledger 后 status 丢失、外部副作用后崩溃和正文/Enter 中间崩溃。
12. terminal.opened 独立于首 output。new/reset response 丢失后，同 streamId/openId/fingerprint 仅在原 state/tombstone 可证明时返回相同 generation；lease 后丢失必须返回 origin=open 的 reset_required且不创建第二个 PTY。closed ring gap/淘汰只返回 offset_expired，不能再发送 opened/output/closed。
13. terminal.close response 丢失后，同 closeId 重试固定 generation/finalOffset/reason/exitCode且不关闭新 generation；replayAvailable/bufferStartOffset 只能随 ring 单调退化。
14. output ACK 上限是当前 binding sentThroughOffset，且只在 xterm parser 实际应用后推进；inputSeq 与 resizeSeq 都使用累计 ACK、固定 512/256 entry 去重窗口和单调 floor，旧于 floor 的重复只重 ACK、绝不再次执行。
15. route 重绑必须 fence 旧 route；opened→replay→live→closed 不得乱序。broker/网络断开不能伪造 terminal.closed，closed 必须带 finalOffset。
16. duplicate JSON key、错误 UTF-8、binary frame、深度/key 数超限、oversize frame、非 canonical counter/Base64 和 compression bomb 全部在有界分配前拒绝。
17. per-stream、per-host、每方向 route、carrier、Android actor/event/UI/WebView queue 都有硬上限；压力测试不得无界增长、饿死其他 route、静默丢 command status/control event 或跳 terminal offset。
18. 在以上测试全部通过前，当前 Android/Dashboard/relay-server/relay-host 继续只宣告和运行 Relay v1，不生成 v2 enrollment 或 capability。
19. production v2 ready 前必须对 external continuity authority 提供独立失败域、linearizable read/CAS、已确认 CAS RPO=0、stable provisioning/ACL、旧备份拒绝 serving、failover high-water、closed internal error mapping和 broker-credential ready-loss同步 admission/active-data fence证据。ACK丢失或timeout后的CAS只允许 uncertain→linearizable read reconcile；broker credential与Agent extension anchor不能复用，reset/delete/decommission不能重置旧 history。故障注入还必须证明broker namespace fatal会全局fence，而Agent extension namespace按现有三类`AGENT_AUTHORITY_STORE_*` mapping只隔离extension；unavailable保留lineage且不reset/new epoch，独立corrupt case才允许reset/new epoch，基础credential/route/command/terminal继续。external adapter、具体 close policy或上述证据缺一项均保持 NO-GO。
