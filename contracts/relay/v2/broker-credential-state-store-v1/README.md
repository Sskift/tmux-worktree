# Relay v2 Broker Credential State Store v1

状态：**Frozen native storage contract；已有独立未接线的纯 Rust binary/publication core、TypeScript closed decoder/wrapper、未接线 optional loader 与 credential authority source foundation，没有 N-API binary、Darwin/Linux platform adapter、production authority injection、ready capability 或 production wiring。**

本目录冻结 Relay v2 broker credential 状态的唯一 native storage seam。它不修改 Relay v2 public wire，不启用 enrollment，不重新引入已被拒绝且未纳入当前交付源码的 unsafe BAU path/JSON 设计，也不改变 Relay v1。机器常量和 fixture 以 [`manifest.json`](manifest.json) 为准。

## Owner 与 deep port

业务 owner 已由 T1 建立为唯一未接线的 `RelayV2BrokerCredentialAuthority` source foundation。它拥有 issuer、enrollment、grant、replay、rate-limit、ready withdrawal 与 external continuity；production composition 尚未注入该 owner，store 只拥有 opaque bytes 的排他事务、持久 publication、本地 revision 和 native resource lifetime。

唯一 authority-facing port 是：

```text
store.runExclusive(transaction => ...)
  transaction.read()
    -> missing(revision) | present(revision, bytes)
  transaction.compareAndPublish(revision, nextBytes)
    -> swapped(current)
     | already_same(current)
     | conflict(current)
     | uncertain

store.close() -> barrier
```

`current` 是 fresh `missing|present` snapshot 和当前 transaction revision；`swapped` / `already_same` 的 current 必须是 `present`。这让 authority 在同一 transaction 内收敛，而不读取 generation、path、digest 或 native handle。

Interface 不接受或暴露 state/lock/temp path、fd、directory handle、device/inode、`*at` primitive 或 cleanup。唯一 open 参数是 exact closed options：

```text
{
  trustedHome: absolute caller-supplied account-owned root,
  maxStateBytes: 67108864
}
```

`trustedHome` 不能由 binding 隐式读取 `HOME`，也不能替换为 derived state/lock/temp path。它必须是 caller 已信任的 account home **root 本身**；任何 descendant/subpath 都不是合法 `trustedHome`。TypeScript 边界先在一个 `try` 内取得 exact own **data descriptor** snapshot；accessor 被拒绝，hostile getter 不执行，每个 data value 只捕获一次。Native open 必须重新验证该绝对路径确为 caller-owned account home root。`maxStateBytes` 必须精确等于冻结值 `67,108,864`，caller 不可调小或调大；它同时是 native read/publish 的实际 admission upper limit，不是 advisory metadata。

## Raw N-API 与 TypeScript 边界

N-API raw store、transaction、revision 和 bytes 都不能进入业务 owner。`src/relay/v2/brokerCredentialStateStore.ts` 捕获并包装 raw `runExclusive/read/compareAndPublish/close`：

- 每个 closed union、binding/store/transaction method record 都先做一次 exact own-data-descriptor snapshot，再逐字段、逐 variant decode；accessor（包括先返回合法值再变化的 getter）、proxy/raw shape 异常映射为 `NATIVE_INTERFACE_INVALID`。Raw `Uint8Array` 用捕获的 TypedArray intrinsic brand/length/buffer/set 复制，不重复读取可变 getter。
- Native 抛出的 exact `{code}` 只接受 frozen error union，并重新封装为本地 `RelayV2BrokerCredentialStateStoreError`；普通 raw exception 不穿透。
- Raw revision 只保存在 wrapper 的 `WeakMap`；业务拿到的新 opaque object 无字段、不可 JSON 序列化，只能用于签发它的同一 transaction。伪造、跨 transaction、callback settle 后使用均为 `INVALID_REVISION`。
- Raw read/current bytes 每次复制为 caller-local `Uint8Array`；调用者修改结果不能改变 store。Publish input 在任何 await/native I/O 前同步复制，调用者随后修改原 buffer 不能改变 publication。
- Native `runExclusive` 必须 exactly once 调 callback，并在 callback settle 后才成功 resolve；业务 callback 的 result/error 由 wrapper 本地保存，不要求 native identity-echo result，也不要求业务异常穿过 native 再返回。Raw run 的任意 throw/reject（无论 callback 是否已经调用）、duplicate callback、callback 尚 pending 时提前成功 resolve，或成功 resolve 时完全未调用 callback，都是 protocol violation：wrapper 在向外返回 `NATIVE_INTERFACE_INVALID` 前立即 terminal-fence 同一 store。首个 callback 已触发 uncertain/malformed terminal fence 后的第二次调用仍是占优的 duplicate protocol violation；raw 即使吞掉第二次拒绝并成功 resolve，也不得让首个 operation result 外逃，外层只能得到 `NATIVE_INTERFACE_INVALID`。Native 此前保存或安排、但尚未进入 business operation 的非 duplicate 延迟 callback 随后触发时，wrapper 直接 reject `NATIVE_INTERFACE_INVALID`，business operation 调用次数保持 0；已经进入 operation 的 callback 则由 transaction fence 保证后续 read/publish 只能得到 `STORE_CLOSED`。同 instance 的新 admission 始终得到 `STORE_CLOSED`。

这个 TypeScript adapter 是 native seam 的 closed boundary，不是 optional artifact loader，也不是 production authority injection。

## Transaction、uncertain 与 close

`runExclusive` 是完整 critical section。同一 store 一次只运行一个 callback。`compareAndPublish` 先验证本 transaction revision，再在同一 locked observation 中依次判定：

1. current bytes 与 copied `nextBytes` 完全相同：`already_same(current)`；
2. expected revision 不再表示 current：`conflict(current)`；
3. payload/header 的全部 durability commit point 可证明：`swapped(current)`；
4. publication 已开始但 commit 与否无法证明：只返回 `{outcome:"uncertain"}`。

`uncertain` 会立即 terminal-close **整个 store instance**。当前 transaction 的后续 read/publish 和同 instance 的任何新 `runExclusive` 都以 `STORE_CLOSED` 闭合；不得自动 retry、猜测 committed、在原 instance 重读或清理。Authority 必须同步撤销 ready，完成 `close()`，显式重新 `open(options)`，通过新 self-check，再完成 external continuity 后才可恢复。

Raw `compareAndPublish` 一经调用即越过 publication trust boundary。只有 closed exact `swapped|already_same|conflict|uncertain` result，或 exact `INVALID_ARGUMENT|INVALID_REVISION|STATE_TOO_LARGE|GENERATION_EXHAUSTED`（native 保证在任何 publication 前产生）能够给出确定语义。Malformed/unstructured result、普通异常，以及其他任意 thrown/rejected code 都无法证明未提交：wrapper 仍把错误闭合映射，但同时按 uncertain 等价 terminal-fence 整个 store，禁止自动重发。

普通 `close()` 与 terminal fence 不同：barrier 开始后拒绝新 admission，但已 admission 的 callback 仍可完成 read/publish；close 等它们 settle，并在 native resource 与 lock 都关闭后 resolve。Close 幂等。只有 terminal fence（uncertain、raw callback protocol violation 或无法证明未提交的 post-publish failure）会让已 admission transaction 立即 `STORE_CLOSED`。

## Closed capability、open、error 与 readiness

Capability/open 都是 exact `supported|unsupported|invalid` closed union。`supported` 只证明 artifact target/interface manifest 可用，**不等于 ready**。Ready 的必要顺序是：

1. capability `supported`；
2. `open(options)` 返回 `opened`；
3. native owner/mode/link/identity/format/locking/durability self-check 返回 `passed`；
4. T1 注入的 `RelayV2BrokerCredentialAuthority` 完成 external continuity。

`unsupported` 只允许在未观察 store 前表示 `native_artifact_missing`、`target_unsupported` 或 `interface_version_unsupported`。一旦观察 existing disk，unknown format、corruption/partial、wrong owner/mode、link/identity uncertain、I/O 或 durability unavailable 都必须 `invalid` 并保留状态：

- unknown checksum-valid format：`STORE_FORMAT_UNSUPPORTED`；
- corrupt/ambiguous/invalid length：`STORE_CORRUPT`；
- wrong owner/mode：`STORE_PERMISSION_INVALID`；
- link、identity race 或无法证明 object identity：`STORE_IDENTITY_UNCERTAIN`；
- 无法满足 frozen durability：`DURABILITY_UNSUPPORTED`。

它们绝不能伪装成 `missing` 后重建。Error seam 只传 `{code}`，不传动态 message、path、errno detail 或 cleanup object。只有 `STORE_BUSY` retryable；任何 unsupported/invalid 都不授权 v1 fallback、prototype fallback、v2 capability 或 alternate store。

## Single descriptor binary storage v1

Native store 私有地拥有一个固定长度 `134,217,984` bytes 的 descriptor-backed container。打开后所有选择、read 与 publication 只使用该 descriptor。四个固定 range 是 format role，不是 interface path：

| Range | Absolute offset | Capacity |
| --- | ---: | ---: |
| `header0` | 0 | 128 |
| `header1` | 128 | 128 |
| `payload0` | 256 | 67,108,864 |
| `payload1` | 67,109,120 | 67,108,864 |

Layout alignment 冻结为 128 bytes：四个 absolute offset、四个 capacity 和 total fileLength 都必须是 128 的整数倍；这只是 on-disk layout 规则，不授权 adapter 自选 padding、memory mapping 或 alternate alignment。Header integer 一律 little-endian。

Container 不存在时，native 才能安全创建 owner-only 单文件、设定 exact length、把两个 header range 初始化为全零，并证明文件 metadata 与目录 entry durable 后返回 `opened`。Existing object 长度错误、ownership/identity 不安全或部分初始化必须 invalid 并原样保留，不能 truncate/recreate。

Open 必须在同一 container descriptor 上 **nonblocking** 取得 process-wide exclusive kernel lock，然后才做 identity 与完整 self-check。锁贯穿 store lifetime、所有 transaction、idle 和任意 terminal-fenced 状态；竞争返回 `STORE_BUSY`。不得创建 lock file，不得在 transaction 结束时释放。`close()` 等 admitted callback 后，以释放该 lock/descriptor 作为最后 native barrier 动作。

每个 header 固定 128 bytes，integer 为 little-endian：

| Offset | Length | Field | Rule |
| ---: | ---: | --- | --- |
| 0 | 8 | magic | ASCII `TWV2BCS1` |
| 8 | 2 | formatVersion | u16 = 1 |
| 10 | 1 | slot | 0/1；等于 `(generation - 1) mod 2` |
| 11 | 1 | flags | 0 |
| 12 | 4 | headerLength | u32 = 128 |
| 16 | 8 | generation | u64，1..2^64-1 |
| 24 | 8 | payloadLength | u64，1..67,108,864 |
| 32 | 32 | payloadDigest | raw SHA-256(exact payload bytes) |
| 64 | 32 | reserved | 全零 |
| 96 | 32 | headerChecksum | raw SHA-256(header offset 0, length 96) |

Container absent，或 exact-length container 的两个 header 与两个 payload range 都逻辑全零，才表示 `missing`。两个 header 全零但任一 payload 有首次 publication crash residue是 `STORE_CORRUPT`，不能伪装 missing。完整 candidate 要求 header checksum/字段通过，并与同 slot payload 的 exact declared length/digest 一致。

Selection closed rules：

- 首次 commit 是 slot 0 / generation 1；只有该状态允许另一个 header 全零。之后严格交替 slot，两个 header generation 必须恰差 1，选择较高完整 generation。
- 同 generation、跳号、generation 0/回绕、最高 candidate 不完整、valid header 对应 payload digest 不符均 `STORE_CORRUPT`，不回退旧 state。
- checksum-valid 但未知 magic/version/flags 是 `STORE_FORMAT_UNSUPPORTED`，即使另一 slot 可读也不能忽略未来格式。
- 只有另一个 slot 是完整 immediate successor 时，才可忽略 lower inactive payload 被下一次 positional write 部分覆盖后的 digest mismatch。
- Torn/invalid header fail closed；选择阶段绝不 repair/rewrite/cleanup。

Golden fixture 用 `fileLength + [{offset,bytesBase64}]` 表示一个完整 zero-filled container；未编码 byte 严格为 0，segments 必须排序后不重叠且界内。Oracle 用 sparse range reader 只读取两个 header 与声明 payload range；corrupt mutation 全部是 absolute container offset。Rust 可直接 `ftruncate(fileLength)` 后按 offset positional write segments/mutations，corpus schema 错误不算 native `STORE_FORMAT_UNSUPPORTED` 证据。

## Positional publication 与 durability

Publication 只能使用 explicit-offset positional `pwrite` / `write_at` 等价 primitive；禁止 shared cursor 和普通 `write`，也禁止 named replace、rename、temporary publication 或 unlink cleanup：

1. 在 single descriptor/exclusive transaction 内选 inactive payload absolute range 与 `generation+1`；
2. 完整 positional write copied payload，处理 short write/interruption，并通过 payload durability barrier；
3. 只有 payload barrier 成功后才构造并 positional write inactive header；
4. 通过 header durability barrier及任何必要的 container metadata barrier；
5. 全部可证明后才返回 `swapped(fresh current snapshot)`。

Durability 名称冻结为语义 `payload_then_header_durable_v1`，不把某个 syscall 名当跨平台契约。Darwin 与 Linux adapter 都必须证明此前 range 及所需 allocation/descriptor metadata 已到 stable storage、可承受 power loss，ordinary cache flush 不足。创建 container 时还要证明 exact length 与目录 entry durable。目标 filesystem/device 无法提供该保证时必须 `invalid/DURABILITY_UNSUPPORTED`，existing state 保留。

## Legacy、conformance 与 production 边界

此前被拒绝的 unsafe BAU path/JSON 设计直接处理 state/lock/temp path、fd/inode、rename/unlink 与 cleanup，未通过 native security acceptance，也未纳入当前交付源码。N0 不修补、不包装或重新引入该设计，不自动迁移或删除可能遗留的 artifact，也没有任何 fallback。

[`test/support/relayV2BrokerCredentialStateStoreConformance.mjs`](../../../../test/support/relayV2BrokerCredentialStateStoreConformance.mjs) 是未来 Rust/Darwin/Linux adapter 可复用的 authority-facing conformance harness。当前 in-memory raw adapter 只证明 TypeScript wrapper/port contract，**不是 native、device、filesystem、kernel-lock 或 power-loss durability 证据**。

独立未接线的纯 Rust binary/publication core、未接 production composition 的 optional loader 与 credential authority source foundation 已实现。loader 只做显式 target、最低 N-API、固定 artifact selection，固定一次 raw binding identity，并把 capability/open 原样交给本 contract 的 TypeScript wrapper；只有固定目标 artifact 本身在 resolve 阶段确实缺失才映射 `native_artifact_missing`。Darwin/Linux adapter、N-API binary、production authority injection、packaging 和 production Gate 均未实现；authority 仍无 host bootstrap、成功 credential 流或 live revoke/kid fence。core、Port、manifest、fixture、self-check contract、loader 与 authority source 的存在不表示 native 已 open，更不表示 continuity 或 ready；production Relay v2 保持 disabled，Relay v1 继续独立构建和运行。
