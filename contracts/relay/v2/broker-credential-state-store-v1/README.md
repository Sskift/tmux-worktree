# Relay v2 Broker Credential State Store v1

状态：**Frozen native storage contract revision 2；interface/storage/binary/fixture 仍为 v1。已有独立未接线的纯 Rust binary/publication core、platform-common lifecycle owner、Darwin/Linux platform adapter、raw N-API binding、TypeScript closed decoder/wrapper、optional loader、显式本机 target build/stage/npm-pack verification 与 credential authority source foundations；空 qualification allowlist 下仍没有 platform-adapter-qualified real open、actual opened JS transaction、production authority injection、ready capability 或 production wiring。**

本目录冻结 Relay v2 broker credential 状态的唯一 native storage seam。它不修改 Relay v2 public wire，不启用 enrollment，不重新引入已被拒绝且未纳入当前交付源码的 unsafe BAU path/JSON 设计，也不改变 Relay v1。机器常量和 fixture 以 [`manifest.json`](manifest.json) 为准。

顶层 `contractVersion=2` 只表示 secure-open、同进程 registry/fork/close lifecycle 与 deny-by-default durability qualification 语义已经被显式冻结。它没有升级 N-API `interfaceVersion=1`、capability `storageFormatVersion=1`、`binaryStorage.formatVersion=1`、header format 1、`privateLocation.derivationVersion=1` 或 `fixtureFormatVersion=1`；artifact 名、magic、offset、length、fixture 和 TypeScript ABI 均保持不变。N1 因而只消费独立版本化的 binary/publication section，不把顶层 contract revision 当作 binary format version。

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

未接线的 [`native/relay-v2-broker-credential-state-store-platform-common`](../../../../native/relay-v2-broker-credential-state-store-platform-common/) 是 N2/N3 platform adapters 与 N4 N-API binding 对 N1 的唯一shared lifecycle owner。其 build script 是 `privateLocation` 的唯一 native consumer并生成 private-field、无 public constructor 的 immutable container spec；runtime要求先执行显式 `initialize_process_lifecycle()`并把opaque token传给reserve，以 `(verifiedHome dev, ino, RelayV2BrokerCredentialStateStoreV1)`在任何container fd前进入 `OpenReservation → DescriptorOpenAdmission → OpenedContainer` typestate。Common拥有PID/descriptor fence、panic-aware permanent poison、common-owned exactly-once final close、private N1 adapter bridge，以及不暴露 raw N1 store/ticket/lease/revision/snapshot 的 process-bound wrappers。Platform通过public `SoleContainer`提供read/write/barrier/final-close primitive，但该trait不出现N1 `PublicationAction`；attach后sole container由common持有，N2/N3/N-API不得直接依赖N1或复制registry/PID/close状态机。N1 self-check失败保留primary并受控close；ordinary close先关闭registry admission再drain已admitted work；publication boundary的`Uncertain`不被same-PID registry poison改写。该owner本身仍不接收`trustedHome`、不构造`PathBuf`，也不实现secure path、真实fd/syscall/filesystem/durability、kernel lock或N-API。Darwin/Linux adapter foundations通过该owner提供target open seam；N-API module init已eager exactly-once捕获process token。父进程从未load/init就fork的ancestry仍无法观察，当前也没有真实OS fork证据。

## Raw N-API 与 TypeScript 边界

N-API raw store、transaction、revision 和 bytes 都不能进入业务 owner。`src/relay/v2/brokerCredentialStateStore.ts` 捕获并包装 raw `runExclusive/read/compareAndPublish/close`：

- 每个 closed union、binding/store/transaction method record 都先做一次 exact own-data-descriptor snapshot，再逐字段、逐 variant decode；accessor（包括先返回合法值再变化的 getter）、proxy/raw shape 异常映射为 `NATIVE_INTERFACE_INVALID`。Raw `Uint8Array` 用捕获的 TypedArray intrinsic brand/length/buffer/set 复制，不重复读取可变 getter。
- Native 抛出的 exact `{code}` 只接受 frozen error union，并重新封装为本地 `RelayV2BrokerCredentialStateStoreError`；普通 raw exception 不穿透。
- Raw revision 只保存在 wrapper 的 `WeakMap`；业务拿到的新 opaque object 无字段、不可 JSON 序列化，只能用于签发它的同一 transaction。伪造、跨 transaction、callback settle 后使用均为 `INVALID_REVISION`。
- Raw read/current bytes 每次复制为 caller-local `Uint8Array`；调用者修改结果不能改变 store。Publish input 在任何 await/native I/O 前同步复制，调用者随后修改原 buffer 不能改变 publication。
- Native `runExclusive` 必须 exactly once 调 callback，并在 callback settle 后才成功 resolve；业务 callback 的 result/error 由 wrapper 本地保存，不要求 native identity-echo result，也不要求业务异常穿过 native 再返回。Raw run 的任意 throw/reject（无论 callback 是否已经调用）、duplicate callback、callback 尚 pending 时提前成功 resolve，或成功 resolve 时完全未调用 callback，都是 protocol violation：wrapper 在向外返回 `NATIVE_INTERFACE_INVALID` 前立即 terminal-fence 同一 store。首个 callback 已触发 uncertain/malformed terminal fence 后的第二次调用仍是占优的 duplicate protocol violation；raw 即使吞掉第二次拒绝并成功 resolve，也不得让首个 operation result 外逃，外层只能得到 `NATIVE_INTERFACE_INVALID`。Native 此前保存或安排、但尚未进入 business operation 的非 duplicate 延迟 callback 随后触发时，wrapper 直接 reject `NATIVE_INTERFACE_INVALID`，business operation 调用次数保持 0；已经进入 operation 的 callback 则由 transaction fence 保证后续 read/publish 只能得到 `STORE_CLOSED`。同 instance 的新 admission 始终得到 `STORE_CLOSED`。

这个 TypeScript adapter 是 native seam 的 closed boundary，不是 optional artifact loader，也不是 production authority injection。

独立未接线的 [`native/relay-v2-broker-credential-state-store-napi`](../../../../native/relay-v2-broker-credential-state-store-napi/) 已实现冻结raw ABI foundation。它只导出 `relayV2BrokerCredentialStateCapability` 与 `openRelayV2BrokerCredentialStateStore`，只把platform-common `ProcessBound*`与编译target对应的Darwin/Linux public open seam转换为exact own-data N-API值；不读取`HOME`，不接受path override，也不拥有credential schema、readiness、continuity、fallback或capability advertisement。显式、未接线的本机target foundation现按共享fixed descriptor执行exact locked release Cargo build、验证Mach-O/ELF target header，并在全部header/digest/空layout证明完成后以hard-link作为final唯一commit point；commit后不rollback final，只identity-check清理脚本自建0700随机temp。它用有界typed ustar inspector拒绝PAX/GNU longname/link/special entry，只流式写出exact regular-file allowlist，再从自建`npm pack --ignore-scripts`临时解包导入fixed loader并运行focused Node require、exact export/prototype-safety、capability decode与绝对非account-home closed invalid open验证。Node没有`openat/linkat/unlinkat`，因此本foundation不宣称抵抗恶意同uid对最终目录的并发换名；已观察到的parent/leaf identity mismatch会保留对象并显式失败。当前实际证据仅Darwin arm64；没有Darwin x64/Linux、四target matrix、bit reproducibility、Dashboard bundle、签名/notarization、minimum-OS/glibc/SDK或provenance。空qualification allowlist没有为它提供platform-adapter-qualified real open，因此仍没有actual opened JS transaction证据；staged/temporary-pack artifact也不是production或Dashboard shipping artifact。

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

## Secure open、registry、fork 与 close

Contract revision 2 把 platform open 冻结为一条顺序唯一、mutation 前 fail-closed 的路径：

1. 在任何 path 观察前 snapshot native real/effective uid 与 gid；要求 real uid 等于 effective uid、real gid 等于 effective gid，且 real/effective uid 都不是 0。gid=0 本身不等同 root，也不单独拒绝。Credential/root规则不满足统一是 `STORE_PERMISSION_INVALID`。
2. 从 native account database 取得 effective uid 的 home root，要求 caller `trustedHome` 与其绝对 component sequence 精确相等，并用 read-only no-follow traversal证明 owner、mode 与 ACL。Account entry不存在或 caller/account home不匹配是 `STORE_PERMISSION_INVALID`；account DB真实 system/I/O failure是 `STORE_IO`。Home 不可 group/other write，ACL 不得授予非 owner namespace mutation；path/entry observation race或无法证明 identity是 `STORE_IDENTITY_UNCERTAIN`。
3. Existing private directory 必须 owner uid/gid匹配且 exact `0700`；container 必须 regular、owner uid/gid匹配、exact `0600`、`nlink=1`。Existing object 不允许通过 `chmod` 修复。共享 ACL 规则是不允许 ACL 给 non-owner 扩张 mode bit 之外的权限，也不允许 default/inheritable ACL 放宽后代；Darwin 按 NFSv4 effective ALLOW、Linux 按 POSIX ACL+mask 证明。无法证明是 `STORE_PERMISSION_INVALID`，真实 ACL read I/O failure 是 `STORE_IO`。
4. 在 private directory 已存在时对它、否则对 verified home 做只读 filesystem/storage probe并采集 qualification evidence。必须在 process registry、`mkdir/create/chmod/truncate/write` 之前精确命中 release-baked qualified record；随后才 reserve registry，并在 mutation 前重验 target fingerprint。
5. 按 manifest 的 exact component 做 private directory traversal/create。Existing leaf在任何 container open前先用 `fstatat(parentFd, leaf, AT_SYMLINK_NOFOLLOW)` 证明 regular/owner uid+gid/exact `0600`/`nlink=1`/exact length；该 preflight不能打开另一个 container fd，symlink、special、link或无法证明 type/identity必须 preserve并 `STORE_IDENTITY_UNCERTAIN`。Existing随后只能 `openat(parentFd, leaf, O_RDWR|O_NOFOLLOW|O_CLOEXEC, 0600)`；create只能 `openat(..., O_RDWR|O_NOFOLLOW|O_CLOEXEC|O_CREAT|O_EXCL, 0600)`，禁止 `O_TRUNC`/`O_EXLOCK`，并用 `F_GETFD`证明 `FD_CLOEXEC`。Existing绝不 `fchmod`修复；new object只可在 qualification之后 `fchmod`收敛 exact `0600`。取得进程内唯一 container fd后才取 lock并完成初始身份/安全证明。Existing container 在 open 时就必须是 exact `134,217,984` bytes；new container 完成 initialization 后必须达到该 exact length。Existing self-check或 new initialization及 creation durability完成后，执行 final A/B/C proof并关闭所有 directory fd，再以 by-value handoff 一步转换为只剩 sole container descriptor 的 N1 store。

Final stable proof 固定为 `A=fstat(fd)`、`B=fstatat(parent, leaf, AT_SYMLINK_NOFOLLOW)`、`C=fstat(fd)`；A/B/C 的 device+inode必须一致，file type、uid、gid、mode、link count和 size保持稳定，且 existing/open 与 new/init 后的 final size都必须是 `134,217,984`。完成该 named proof 后不再做 named lookup；final proof + directory-fd close之后的 by-value handoff就是 descriptor-only转换点，handoff 后只能剩 container fd。观测到 race 必须 `STORE_IDENTITY_UNCERTAIN`。同 uid 的任意外部 direct open 或 namespace mutation不在 trusted runtime threat model 内，但这不允许忽略已经观测到的 race。

跨 Darwin/Linux 的锁只允许同一 fd 上 nonblocking traditional process-owned whole-file POSIX record lock：`fcntl(F_SETLK, {F_WRLCK, SEEK_SET, start=0, len=0})`。只有 `EACCES`/`EAGAIN` 映射 `STORE_BUSY`；禁止 `flock`、`F_SETLKW` 和 Linux `F_OFD_*`。锁持有到 sole container fd 的 final close，禁止显式 unlock、dup、reopen、clone、辅助 container fd、descriptor lending或由其他 library 再 open container。

Traditional POSIX lock 是 process-owned，因此 platform-common 必须在任何 container fd 前以 `(verifiedHome dev, verifiedHome ino, RelayV2BrokerCredentialStateStoreV1)` reserve唯一 registry entry。状态只有 `Opening/Open/Closing/CloseUncertain`：与 active `Opening/Open/Closing` 碰撞必须在打开 fd 前返回 retryable `STORE_BUSY`，而 `CloseUncertain` 是永久 tombstone，后续 reserve/open只返回 non-retryable `STORE_CLOSED`。只有能证明从未产生 container fd 的失败才能删除 reservation；产生 fd 后 entry 保留到 final close。Close exactly once、不得 retry或显式 unlock：成功才删除 entry；首次实际 `EINTR`/`EIO`/不确定 close返回 `STORE_IO` 并永久进入 `CloseUncertain`，后续 close只返回缓存结果、不再执行 native close，后续 open返回 `STORE_CLOSED`。Registry mutex poison同样永久 fail closed为 non-retryable `STORE_CLOSED`。

Platform-common 还必须保存 opener PID，并在取得 registry mutex、进入 N1 mutex/condition variable或任何 descriptor 操作前先做 lock-free process-origin check。可保证的 fork 前提是发起线程当时不在 common/N1/platform method或 `Drop` 内；child 继承的 store 一律返回 public `Closed -> STORE_CLOSED`（private reason可为 `ForkedChild`），不得修改 parent registry，且 pre-exec只应 `exec`/`_exit`、不得 fresh open。`vfork` child执行 Rust/common、signal/raw fork后继续已经进入的 store调用栈都不支持并位于 threat model外；`pthread_atfork` 不作为正确性依赖。Exec 后才是新进程。该 registry/PID/fork wrapper现由未接线的 platform-common唯一实现，不得由 N2/N3各自实现；当前证据仍只来自fake PID/registry transition，不构成真实OS fork验收。

## Single descriptor binary storage v1

Native store 私有地拥有一个固定长度 `134,217,984` bytes 的 descriptor-backed container。打开后所有选择、read 与 publication 只使用该 descriptor。四个固定 range 是 format role，不是 interface path：

`binaryStorage.container.privateLocation` 冻结唯一 canonical private location：以已验证的 `trustedHome` 为 base，依次使用 relative component `.tmux-worktree` 与 `relay-v2-broker-credential-state-store-v1.bin`，即展示为 `${trustedHome}/.tmux-worktree/relay-v2-broker-credential-state-store-v1.bin`。Darwin 与 Linux native adapter 必须共同消费 manifest 中这一份定义，从已验证的 account-home root 开始逐 component 做 native traversal，并对每一层执行 no-link 与 owner/mode/stable-identity 检查；不得把展示字符串当作 caller 可配置 path。Caller 不能覆盖 base 或任一 relative component，也不能提供 alternate candidate。Native implementation 不得在其他位置查找候选或 prototype artifact，更不得读取、导入、迁移、删除或清理任何 alternate/prototype state、lock、temp 或 container artifact。

| Range | Absolute offset | Capacity |
| --- | ---: | ---: |
| `header0` | 0 | 128 |
| `header1` | 128 | 128 |
| `payload0` | 256 | 67,108,864 |
| `payload1` | 67,109,120 | 67,108,864 |

Layout alignment 冻结为 128 bytes：四个 absolute offset、四个 capacity 和 total fileLength 都必须是 128 的整数倍；这只是 on-disk layout 规则，不授权 adapter 自选 padding、memory mapping 或 alternate alignment。Header integer 一律 little-endian。

Container 不存在时，native 才能安全创建 owner-only 单文件、设定 exact length、把两个 header range 初始化为全零，并证明文件 metadata 与目录 entry durable 后返回 `opened`。Existing object 长度错误、ownership/identity 不安全或部分初始化必须 invalid 并原样保留，不能 truncate/recreate。

Open 必须按上一节在进程内 sole container descriptor 上取得 traditional `F_SETLK` whole-file record lock，然后才完成 identity 与完整 self-check。锁贯穿 store lifetime、所有 transaction、idle 和任意 terminal-fenced 状态；竞争返回 `STORE_BUSY`。不得创建 lock file，不得在 transaction 结束时释放。`close()` 等 admitted callback 后，以 sole fd 的 exactly-once close 作为最后 native barrier 动作。

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

Durability qualification policy 是 v1，publication protocol仍精确是 `payload_then_header_durable_v1`。它采用 release-baked exact match；本 revision 的 `qualifiedRecords` 精确为空、没有 item schema、template、example或 wildcard，第一条 record 必须通过新的 contract revision引入。因此所有真实 N2/N3 open都必须在 process registry和任何 mutation前返回 `invalid/DURABILITY_UNSUPPORTED`。Caller/environment不能 override；runtime probe或 syscall success只能采集/核对证据，不能创造 qualification。测试注入只能存在于 production不可达的 `cfg(test)`。

未来 revision 的最小准入证据必须同时绑定 exact native artifact/source revision、target triple、OS build、filesystem implementation/features/mount+superblock options与 forbidden layers、按顺序描述的 storage topology/controller/driver/device/firmware/transport/cache/flush/FUA/PLP、exact primitive sequence，以及 immutable controlled power-cut procedure/report ID/SHA-256/tested scope。任何未知或不可观察字段都必须 `DURABILITY_UNSUPPORTED`，不能凭一次 flush成功推断 power-loss guarantee。

Qualified Darwin profile 的 publication payload/header各执行 `fcntl(containerFd, F_FULLFSYNC)`；new-object creation顺序精确为 `F_FULLFSYNC(container)` → `fsync(container parent dir)` → 若本次创建 private dir则 `fsync(trustedHome)` → `fsync_volume_np(container, SYNC_VOLUME_FULLSYNC | SYNC_VOLUME_WAIT)`，且 `fsync_volume_np` 任意 nonzero return本身就是 error code。Qualified Linux profile 的 payload/header各 `fsync(container)`；creation为 `fsync(container)` → `fsync(container parent dir)` → 若新建 private dir再 `fsync(trustedHome)`。

任一 barrier失败都不能 unlink、rebuild或把已观察对象重新归类为 missing；已创建对象保留。能证明 primitive/guarantee不受支持时返回 `DURABILITY_UNSUPPORTED`，实际 I/O failure返回 `STORE_IO`；publication action一旦越过 N1 commit boundary仍遵守既有 `Uncertain` terminal semantics，不能据错误码自动重发。

## Legacy、conformance 与 production 边界

此前被拒绝的 unsafe BAU path/JSON 设计直接处理 state/lock/temp path、fd/inode、rename/unlink 与 cleanup，未通过 native security acceptance，也未纳入当前交付源码。N0 不修补、不包装或重新引入该设计，不自动迁移或删除可能遗留的 artifact，也没有任何 fallback。

[`test/support/relayV2BrokerCredentialStateStoreConformance.mjs`](../../../../test/support/relayV2BrokerCredentialStateStoreConformance.mjs) 是 Rust/Darwin/Linux adapter 可复用的 authority-facing conformance harness。当前 in-memory raw adapter 只证明 TypeScript wrapper/port contract；N-API focused Node evidence也只证明本机Darwin arm64临时产物的load与closed boundary，**两者都不是platform-adapter-qualified real open、device、filesystem、kernel-lock、fork或power-loss durability证据**。

独立未接线的纯 Rust binary/publication core、platform-common lifecycle owner、Darwin/Linux adapter、raw N-API binding、optional loader 与 credential authority source foundations 已实现。loader 只做显式 target、最低 N-API、固定 artifact selection，固定一次 raw binding identity，并把 capability/open 原样交给本 contract 的 TypeScript wrapper；只有固定目标 artifact 本身在 resolve 阶段确实缺失才映射 `native_artifact_missing`。空 qualification allowlist要求所有production real open在 registry/mutation前 fail closed，所以当前没有platform-adapter-qualified real open或actual opened JS transaction；authority 仍无host bootstrap、成功credential流或live revoke/kid fence。已有显式、未接线的本机target build/stage/npm-pack verification foundation；当前仍没有Dashboard/production shipping、production authority injection/composition/wiring或continuity readiness。上述foundation与本机Darwin arm64 fixed stage/temporary pack closed-boundary evidence不表示native已qualified open，更不表示Relay v2 capability、enrollment或ready已交付；production Relay v2保持disabled，Relay v1继续独立构建和运行。
