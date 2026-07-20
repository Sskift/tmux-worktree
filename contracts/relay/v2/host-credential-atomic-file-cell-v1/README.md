# Relay v2 Host Credential Atomic File Cell v1

状态：**Frozen internal native ABI；default-off、injected-only，未实现 native addon、真实文件系统或 production wiring。**

本目录冻结 Relay v2 Host credential vault 的专属 atomic byte-cell native seam。它不修改 Relay public wire，不产生 readiness/capability，也不复用 broker credential state store 的 logical store kind、binary container、private location、artifact、loader、lifecycle owner 或 continuity namespace。

## Owner

`RelayV2HostCredentialVault` 继续唯一拥有 credential envelope、Host/credential reference binding 和 secret 业务语义。未来 Host native cell 只拥有一个 cell 的 descriptor、lock、object identity、CAS、durability、recovery 和 final-close lifecycle。Node wrapper 只 closed-decode 本 ABI，并实现既有 `RelayV2HostCredentialAtomicByteCell` port。

未来 production composition 必须通过唯一 trusted factory 创建 `nativeModule`，并在进入本 ABI 前把它预绑定到 exact Host credential cell directory descriptor capability；未来 4b2 native 实现持有并验证该 descriptor authority。Wrapper 与本 ABI 的 `open` request 只消费这项已绑定 capability，不能选择或接收 HOME/path/env，也不能做 global lookup。

本 4b1 revision 不实现上述 factory、native Rust/syscall、descriptor open、HOME/path/env 输入、global lookup、loader/packaging、orphan recovery、durability qualification、continuity、Vault injection、`relay-host` composition 或 capability advertisement。现有 H4a path-based cell 不是本 ABI 的 production fallback。

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
