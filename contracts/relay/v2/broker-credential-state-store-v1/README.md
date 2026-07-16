# Relay v2 Broker Credential State Store v1

状态：**Frozen native storage contract；无 native implementation、loader、authority injection 或 production capability。**

本目录冻结 Relay v2 broker credential 状态的唯一 native storage seam。它不修改 Relay v2 public wire，不启用 enrollment，不把 BAU prototype 提升为 production，也不改变 Relay v1。机器常量和 fixture 以 [`manifest.json`](manifest.json) 为准。

## Owner 与 interface

业务 owner 始终是 `RelayV2BrokerCredentialAuthority`。它拥有 issuer、enrollment、grant、replay、rate-limit 与 external continuity 的业务语义；store 只拥有 bytes 的排他事务、持久 publication 与本地 storage revision。

唯一 port 是 `RelayV2BrokerCredentialStateStore`：

```text
store.runExclusive(transaction => ...)
  transaction.read()
    -> missing(revision) | present(revision, bytes)
  transaction.compareAndPublish(revision, nextBytes)
    -> swapped(revision)
     | already_same(revision)
     | conflict(revision)
     | uncertain

store.close() -> barrier
```

Interface 不接受或暴露 state/lock/temp path、fd、directory handle、device/inode、`*at` primitive 或 cleanup。平台位置、secure object identity、locking、recovery 和清理全部在 native implementation 内。N-API open 无参数，只打开该用户唯一的 broker credential store。

`runExclusive` 是完整 critical section，同一 store 一次只运行一个 callback。revision 是 adapter 签发的 opaque object：没有 generation/path/digest 等公开字段，不能序列化，只能传回签发它的同一个 transaction；callback settle 后永久失效。`read` 返回独立 byte copy，`compareAndPublish` 在任何 await 或 I/O 前捕获独立 input copy。

`compareAndPublish` 先验证 revision 属于当前 transaction，再在同一已锁定 observation 中按以下顺序判定：

1. current bytes 与 `nextBytes` 逐 byte 相同：`already_same`。
2. expected revision 不再表示 current：`conflict`。
3. publication 的全部 durability commit point 可证明：`swapped`。
4. I/O 已开始而 commit 与否不能证明：只返回 `{outcome:"uncertain"}`，不得附 revision、猜测 conflict 或自动重试。业务 owner 必须在新的 `runExclusive` 中重读并结合 external continuity 收敛。

`close()` 幂等。barrier 一开始就拒绝新 transaction，等待已经 admission 的 callback settle，再关闭 native resource 后 resolve。不得把 close 变成 callback 外的 lock/unlink cleanup interface。

## Closed native unions

N-API binding 只导出 manifest 中两个固定函数。Capability 必须是完整 `supported`、枚举的 `unsupported` 或 `invalid(error)`；缺一个 feature、常量不匹配、未知字段或未知 variant 都是 `NATIVE_INTERFACE_INVALID`，不能按“部分可用”继续。

Open 只有：

- `opened(store)`：返回上面的唯一 port；
- `unsupported(reason)`：包括 native module 缺失、平台/runtime/interface/storage format 不支持；
- `invalid(error)`：native contract、store format、corruption 或 open 结果无法信任。

Error 只跨 seam 传 `{code}`，不传动态 message、path、errno detail 或 cleanup object。只有 `STORE_BUSY` 是 retryable；unsupported/invalid 都不授权 v1 fallback、v2 capability 或 alternate store。

## Binary storage v1

Native store 私有地拥有四个 logical object：`header0`、`header1`、`payload0`、`payload1`。这些是 format role，不是 interface path。payload 是业务 owner 提供的 opaque bytes，长度为 1..67,108,864。

每个 header 固定 128 bytes，使用 little-endian integer：

| Offset | Bytes | Field | Rule |
| ---: | ---: | --- | --- |
| 0 | 8 | magic | ASCII `TWV2BCS1` |
| 8 | 2 | formatVersion | u16 = 1 |
| 10 | 1 | slot | u8 = 0 or 1；必须等于 `(generation - 1) mod 2` |
| 11 | 1 | flags | u8 = 0 |
| 12 | 4 | headerLength | u32 = 128 |
| 16 | 8 | generation | u64，1..2^64-1 |
| 24 | 8 | payloadLength | u64，1..67,108,864 |
| 32 | 32 | payloadDigest | raw SHA-256(payload exact bytes) |
| 64 | 32 | reserved | 全零 |
| 96 | 32 | headerChecksum | raw SHA-256(header bytes 0..95) |

全空的四个 object 才是 `missing`。一个完整 header 必须通过 length、magic、version、slot、flags、reserved、checksum，并与同 slot payload 的 exact length/digest 一致。

Selection closed rules：

- 首次 commit 是 slot 0 / generation 1；只有该状态允许恰好一个 header。后续严格交替 slot，generation 每次只加 1，两个 header 必须都存在。
- 两个完整 candidate 只能相差一个 generation，选择更高者；同 generation、跳号或 generation 回绕均 fail closed。
- 最高 generation 的 header/payload 不完整、checksum/digest 不符或选择有歧义是 `STORE_CORRUPT`，绝不回退到更旧 state。
- checksum-valid 但未知 magic/version/flags 或出现未知 logical object 是 `STORE_FORMAT_UNSUPPORTED`，即使另一个 slot 可读也不能忽略未来格式。
- 只有已经存在一个完整 immediate successor 时，才允许忽略它的低 generation inactive payload 不完整。Generation 1 的首次 publication 尚无 header 1 时，可以忽略没有 header 的 inactive payload；generation 大于 1 时缺任一历史 header 都是 corruption。它们永不成为新 state，也不授权 cleanup。
- 没有完整 candidate 且又非全空时是 `STORE_CORRUPT`；unknown/partial 永远不能伪装成 `missing`。

## Publication 与 durability

`compareAndPublish` 在 exclusive transaction 内选择 inactive slot 和 `generation+1`：

1. atomically replace inactive payload object，并证明 payload data/metadata durable；
2. 以 payload length/digest 构造 header，atomically replace matching header object，并证明 header durable；
3. 执行 Darwin/Linux 所需的 container metadata durability barrier；
4. 所有步骤都已证明后才返回 `swapped` 和新 transaction revision。

Active slot 在新 header durable 前不能修改。实现必须使用平台 adapter 提供的 secure object primitives，不能从 Node 传 path 或在 JS 中补 rename/unlink。失败若能证明 header 未发布，返回 closed error；只要 commit 与否不确定就返回 `uncertain`，不得清理后声称 rollback、返回 conflict 或重试 publication。

## Legacy 与 production 边界

BAU prototype 的 JSON state、lock、temporary 或 cleanup artifact 不属于本格式。Native open 不读取、导入、迁移、重命名、删除或清理它们；不存在任何 legacy fallback。直到 Rust core、Darwin/Linux adapter、N-API、loader、authority injection、packaging 和生产 Gate 全部完成，production Relay v2 保持 disabled，Relay v1 继续独立构建和运行。
