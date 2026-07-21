# Relay v2 Host Credential Atomic File Cell v1

状态：**Frozen contract revision 2；native ABI、fixture、platform resource contract 与 claim journal format 各为 v1。default-off、injected-only。Darwin arm64 与 Linux `x86_64-unknown-linux-gnu` descriptor-relative syscall adapter 已实现并有真实验证；native addon 与 production wiring 未实现。**

本目录冻结 Relay v2 Host credential vault 的专属 atomic byte-cell native seam。它不修改 Relay public wire，不产生 readiness/capability，也不复用 broker credential state store 的 logical store kind、binary container、private location、artifact、loader、lifecycle owner 或 continuity namespace。

## Owner

`RelayV2HostCredentialVault` 继续唯一拥有 credential envelope、Host/credential reference binding 和 secret 业务语义。未来 Host native cell 只拥有一个 cell 的 descriptor、lock、object identity、CAS、durability、recovery 和 final-close lifecycle。Node wrapper 只 closed-decode 本 ABI，并实现既有 `RelayV2HostCredentialAtomicByteCell` port。

未来 production composition 必须通过唯一 trusted factory 创建 `nativeModule`，并在进入本 ABI 前把它预绑定到 exact Host credential cell directory descriptor capability；4b2a 的独立 platform-common crate 只持有并验证该 descriptor authority。Wrapper 与本 ABI 的 `open` request 只消费这项已绑定 capability，不能选择或接收 HOME/path/env，也不能做 global lookup。

4b2a 新增的 `native/relay-v2-host-credential-atomic-file-cell-platform-common` 是 Host 专属、未接线的 admission owner。它只消费预绑定 directory descriptor、调用 descriptor-relative platform trait，并独占 process registry、lock descriptor、claim journal 和 final close。它不依赖、导入或复用 broker N0 的 namespace、path component、container/binary format、registry、lifecycle owner、artifact、loader 或 continuity namespace。

相邻的 `native/relay-v2-host-credential-atomic-file-cell-platform-darwin` 与 `native/relay-v2-host-credential-atomic-file-cell-platform-linux` 已分别实现该 trait 的 macOS 与 Linux descriptor-relative syscall seam。当前真实验证覆盖 `aarch64-apple-darwin` 与 `x86_64-unknown-linux-gnu`：descriptor-relative filesystem 操作、独立 subprocess 间 `F_SETLK` busy 与 raw-close release，以及 exec 边界的 `FD_CLOEXEC`。这不是完整 admission 验证；Darwin x86_64 与 Linux arm64 尚无证据。

Platform-common 现已唯一拥有 claimId 签发：接管预绑定 directory descriptor 并通过 parent-PID fence 后、任何 process registry、lock、claim、fsync 或 namespace mutation 前，它只调用一次 OS CSPRNG，生成 exact 32-byte non-zero opaque claimId。entropy source error 或全零结果固定映射为 `CELL_IO`；common 只把已接管的 directory descriptor raw-close 一次，不 reserve registry、不打开 lock/claim、不 fsync、不 fallback、预测或重试，也不接受 caller 提供的 claimId。claimId 只进入 `TWV2HAC1` journal，并在 normal close 时按 exact journal match 验证；它不进入公开 API、Debug、result、log 或 error。

本 revision 仍不实现 trusted factory、HOME/path/env 输入、global lookup、N-API、loader/packaging、credential byte-cell read/CAS/temp/rename、orphan recovery、continuity、Vault/Authority injection、`relay-host` composition、readiness 或 capability advertisement。现有 H4a path-based cell 不是本 ABI 或 admission owner 的 production fallback。

## Platform-common admission owner

Production durability qualification v1 是 deny-by-default：`qualifiedRecords=[]`，且没有 public constructor、template、wildcard 或 runtime-probe 通道。实现只在 `cfg(test)` 内能构造 test qualification；因此即使 Darwin 与 Linux trait 及上述真实 syscall 证据已经存在，完整 admission adopt 在 production 仍不可达，必须在 process registry 和任何 namespace mutation 前返回 `CELL_DURABILITY_UNSUPPORTED`，直到新 contract revision 显式加入 qualified record。Syscall 成功或 runtime probe 不能自行产生 qualification。

`aarch64-apple-darwin` 与 `x86_64-unknown-linux-gnu` 的验证只证明各自 target adapter 的列举 syscall 行为，不等于 durability qualification、credential read/CAS、完整 admission、orphan recovery、filesystem power-loss、N-API、Vault/Authority、`relay-host` production wiring、readiness 或 capability。

测试可达的 exact admission 顺序冻结为：

1. adopt 调用方预绑定的 sole directory descriptor，并通过 parent-PID fence。
2. common 调用 OS CSPRNG 一次，签发 exact 32-byte non-zero opaque claimId；error 或全零按上述 pre-mutation `CELL_IO` 路径关闭。
3. `fstat` 必须证明 directory、effective uid/effective gid owner、exact `0700` 和 `FD_CLOEXEC`。
4. 以 `(directory dev, directory ino, RelayV2HostCredentialAtomicFileCellAdmissionV1)` 在 Host 专属 process registry 中 reserve；随后立即重做 directory identity/safety 证明。第二个同进程 owner 必须在产生第二个 lock descriptor 前返回 `CELL_BUSY`。
5. `fstatat(directory, lock, AT_SYMLINK_NOFOLLOW)`。Existing 只能以 `openat(..., O_RDWR|O_NOFOLLOW|O_CLOEXEC)` 打开；absent 只能以 `O_RDWR|O_NOFOLLOW|O_CLOEXEC|O_CREAT|O_EXCL` 和 `0600` 创建。禁止 `O_TRUNC`、reopen、dup 或辅助 lock descriptor。
6. lock 文件完成 `A=fstat(fd) / B=fstatat(directory, lock, NOFOLLOW) / C=fstat(fd)` stable proof；A/B/C 必须是同一 dev+ino、regular、euid/egid owner、exact `0600`、`nlink=1`、size `0`，且 descriptor 必须 `FD_CLOEXEC`。
7. 只在该 lock fd 上执行 nonblocking traditional process-owned whole-file `fcntl(F_SETLK, {F_WRLCK, SEEK_SET, start=0, len=0})`。只有 `EACCES`/`EAGAIN` 映射 `CELL_BUSY`；禁止 `F_SETLKW`、`flock`、Linux `F_OFD_*` 和显式 unlock。锁只由 final raw close 释放。
8. `fstatat(directory, claim, AT_SYMLINK_NOFOLLOW)`。安全、fixed-length 的 existing claim 表示 `CELL_RECOVERY_REQUIRED`；foreign owner/mode、symlink/special/link、wrong length/corrupt observation 都原样保留，绝不修复或删除。Absent claim 只能在同一次 `openat` 以 exact `O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC` 和 `0600` 创建，禁止 `O_TRUNC`；不得以事后 `F_SETFD` 替代 atomic `O_CLOEXEC`，但仍必须独立验证 sole descriptor 已有 `FD_CLOEXEC`，以便 normal close 从同一 descriptor 读回 exact journal。若 preflight 为 absent、但 exclusive create 返回 `EEXIST`，必须再次以 `fstatat(..., AT_SYMLINK_NOFOLLOW)` 观察并执行同一完整 type/link/owner/mode/fixed-length 分类；只有合格的 192-byte existing claim 返回 `CELL_RECOVERY_REQUIRED`，type/link/identity race 返回 `CELL_IDENTITY_UNCERTAIN`，wrong length 返回 `CELL_CORRUPT`，owner/mode invalid 返回 `CELL_PERMISSION_INVALID`，且所有分支 unlink 次数都为零。
9. 向 sole claim fd 从 offset 0 写入 exact fixed journal，执行 claim `fsync`，再完成 claim A/B/C stable proof，最后 directory `fsync`。只有这些全部成功才把 registry 转为 `Open`。Durable cut 后的任何 failure 必须保留 claim。

Registry 只有 `Opening / Open / Closing / CloseUncertain`。Owner 捕获 opener PID，并在每个 descriptor-relative operation 前检查 PID。Fork 后 inherited owner 的所有 operation 只返回 `CELL_CLOSED`；child 不得 unlink、unlock、fsync 或 close 任何 inherited descriptor。

## Claim journal v1

Claim 是 exact 192-byte little-endian binary record，magic 为 `TWV2HAC1`。它只表达 `ADMISSION_HELD_NO_CREDENTIAL_MUTATION`，并包含 journal version/length、32-byte claimId、directory/lock/claim 的 dev+ino、opener PID、euid、egid、必须为零的 reserved bytes和对前 160 bytes 的 SHA-256 integrity digest。它不得包含 credential bytes、secret、HOME、path、business credential reference、hostId 或 continuity state。Exact layout 与 golden bytes 见 [`claim-journal-v1.json`](claim-journal-v1.json)。

## Close

Normal close 先永久 fence 新操作，再重做 directory、lock 和 claim 的 descriptor/path A/B/C identity/safety proof，从 sole claim fd 读回并严格解码 journal，并且只接受当前 owner 捕获的 exact claimId 和全部 identity。成功后只对 claim 执行一次 descriptor-relative `unlinkat`，再 directory `fsync`；永远不显式 unlock，不删除 credential 或 lock 文件。

claim、lock、directory 三个 descriptor 各自只 raw-close 一次，不 retry。只有 identity/journal/unlink/directory-fsync 和三次 raw close 全部成功才删除 registry entry。任何 identity、durability 或 close 不确定都转为永久 `CloseUncertain` tombstone，之后同一 process registry key 只返回 `CELL_CLOSED`。Foreign/corrupt/existing claim 始终保留；本 revision 没有 orphan recovery 或 cleanup API。每个 failure path 的 descriptor close 上限与 closed error mapping 由 [`platform-resource-cases.json`](platform-resource-cases.json) 冻结。

正常 open/mutation gate 必须同时验证 parent PID、registry poison 和 exact entry fence；cleanup gate 则只先验证 parent PID。Same-PID 的 registry poison、entry missing/mismatch 或 `begin_close` failure 不能阻止 `OpenAttempt`/owner 把每个已持有 descriptor 各 raw-close 最多一次：failure 必须留下 global poison 或 `CloseUncertain`、返回稳定 closed error，并阻断下一次 open。唯一例外是 fork child；PID fence 失败时不得 cleanup 任何 inherited descriptor。

## Frozen module and handle

Raw module 是 exact own-data method record：

```text
openRelayV2HostCredentialAtomicFileCellV1({ abiVersion: 1, operation: "open" })
```

成功返回 exact opened result 与一个 raw handle。Handle 是 exact own-data method record：

```text
read(request)
compareAndSwap(request)
close(request)
```

所有方法和结果严格同步；Proxy、accessor、`AsyncFunction`、Promise、thenable、unknown/extra/missing/wrong-type field 一律 fail closed。Node wrapper 不自行加载 addon，也不读取 HOME、path、environment、process 或 network。

## Requests and results

每个 request/result 都显式携带 `abiVersion=1` 和 exact `operation`。Closed request union：

```text
open  = { abiVersion: 1, operation: "open" }
read  = { abiVersion: 1, operation: "read" }
cas   = { abiVersion: 1, operation: "compare_and_swap", revision, bytes }
close = { abiVersion: 1, operation: "close" }
```

Open result 是 `opened(handle) | error(code)`；read result 是 `ok(current) | error(code)`；CAS result 是 `swapped | conflict(current) | uncertain | error(code)`；close result 是 `closed | error(code)`。`current` 恰为 `empty(revision) | present(revision, bytes)`。Bytes 必须是真实 `Uint8Array` 且最多 65,536 bytes；Node 在交付 Vault 或 native mutation 前分别复制 read bytes 和 replacement bytes。

Raw revision 是 native handle/transaction owner-bound opaque token，只能由 raw read/current 产生。Node 永不公开该 token；它签发无字段、不可伪造的 wrapper revision，并只允许同一 wrapper 当前且未消费的 exact revision进入 raw CAS。Foreign、copy、replay 和已被后继 read/conflict 替换的 stale revision 都在 raw mutation 前拒绝。

## Error, uncertainty and close

Raw native error 只有 exact `{code}`，其 closed code 集合见 [`manifest.json`](manifest.json) 的 `rawErrorUnion`。只有 raw call 安全返回后的 exact error result 才能保留该 code；raw call 抛出的任何 JavaScript 值（包括公开 wrapper error 实例或被修改的 `code`）都静态映射为 `NATIVE_INTERFACE_INVALID`，不读取或反射其 code/message/cause/detail，并永久 fence 已发布的 wrapper。`nodeWrapperErrorUnion` 另包含 wrapper 自己的 `REENTRANT`、`ASYNC_OPERATION_UNSUPPORTED` 与 `UNCERTAIN_FENCED`。Unknown error、malformed result、异步结果或 post-CAS closed-decode failure 同样永久 fence wrapper instance。

`uncertain` 不含 current/revision，不表示成功，并立即永久 fence同一 wrapper。它不得自动 retry、重读猜测、切 H4a、切 broker store或 fallback 到 Relay v1。

Raw handle 由 Node wrapper 唯一拥有。Opened handle 在公开 wrapper 前发生的任一可闭合失败都先调用一次 raw `close`；公开后的 `closeAndDrain()` 是稳定、幂等 barrier，同一 raw handle 的 `close` 最多调用一次。Barrier 开始后不再接受 read/CAS；resolve 只表示 exact closed result 已收到，reject 也不授权 retry raw close。

机器可读 union 和每个 conformance case 以 [`manifest.json`](manifest.json) 与 [`native-interface-cases.json`](native-interface-cases.json) 为准。Fixture 只含非敏感占位 bytes，不含 credential、secret、真实路径或 production readiness 声明。
