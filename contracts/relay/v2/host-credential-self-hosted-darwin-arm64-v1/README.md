# Relay v2 Host credential self-hosted Darwin arm64 admission v1

状态：**显式、default-off、非 production。** 本 contract 不修改
`host-credential-atomic-file-cell-v1` revision 7 的 production contract：
其 `qualifiedRecords=[]`、`productionWired=false`，production trusted
factory 仍必须在 registry、descriptor adoption 和 credential mutation 前以
`CELL_DURABILITY_UNSUPPORTED` fail closed。

本 lane 仅适用于 `darwin-arm64` self-hosted deployment。deployment owner
签发一个进程内 opaque one-shot policy ticket；只有 fixed self-hosted
Darwin arm64 loader 可以消费。ticket 选择独立 native factory，后者仍只用
既有 native account-home/private-location producer，把同一 directory
descriptor 交给 platform-common 唯一 `AdmissionOwner`，并复用其
read/CAS/close。不得新增 JavaScript credential store、native mutation owner、
动态 artifact/path/HOME 输入或 Relay v1 fallback。

Node hidden child 只接受：

```text
__relay-v2-dashboard-management-stdio --self-hosted \
  --credential-https-ca-input <0600-path> \
  --carrier-wss-ca-input <0600-path> \
  [--provision-profile-input <0600-path>] \
  [--bootstrap-secret-input <0600-path>]
```

该 lane 另签发一个绑定 exact native credential cell、随后再绑定 intake-owned
credential authority 的 one-shot base-capability handoff。只有它的 `host.hello`
携带冻结的六个 `RELAY_V2_REQUIRED_CAPABILITIES`；optional capability 仍为空。
无参数 production hidden child 不获得该 handoff，offer 仍为空。

承诺严格限于：CAS 已完成 temp fsync、rename、directory fsync，owner clean
close 已移除 exact claim，后续 fresh process 从同一固定目录重新 open 时可读回
credential。禁止把 snapshot rollback、目录复制/clone/migration 当成支持的
恢复方式；本 lane 没有 rollback-independent continuity authority，也不宣称
power-loss、abrupt termination 或 orphan recovery。进程崩溃留下 claim 时，
下一次 open 继续 `CELL_RECOVERY_REQUIRED` 并保留现场。

native producer 明确不创建目录，也不接受 caller path。Dashboard deployment
owner 必须在启动 child 前安全创建并验证 current-user-owned、非 symlink、
exact `0700` 的 `~/.tmux-worktree` 与固定
`~/.tmux-worktree/relay-v2-host-credential-atomic-file-cell-v1`。真实 account
home 只要求符合 frozen producer 的 owner/no-group-write/no-other-write 规则，
无需伪造成 `0700`。

artifact 被 stage、打进 npm package 或 Dashboard `tw-cli/relay/v2/native`
只说明固定
Darwin arm64 binary/resource 装配完成，不产生 production qualification、
production readiness/capability 或整体 Relay v2 GO。
