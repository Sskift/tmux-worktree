# Relay v2 实现状态

状态：**实现状态记录；不构成 capability、兼容性或发布日期声明。**

本文记录 Relay v2 在当前仓库中的实际实现状态。规范语义以冻结的 [`relay-v2-contract.md`](relay-v2-contract.md) 为准；本文不修改任何 wire 语义。

## 已实现

以下模块已在隔离模块和专项测试中可调用，但默认不接入生产路径：

- **codec**：Node 与 Android 各自实现 v2 codec，消费 `contracts/relay/v2` 共享 golden/invalid fixture。
- **Node broker runtime**：brokerCore、brokerCredentialAuthority、hostRuntime、hostState、hostCarrier、carrierPump、hostCommandPlane、resourceState、terminalManager、stateSnapshotSpool、hostRuntimeComposition。
- **Node host runtime**：H0 事务状态、H1 command plane、H2 resource state、H3 terminal manager。
- **Android runtime**：隔离的显式 v2 profile namespace、hostEpoch、opaque sessionId、durable Outbox/state、client terminal resume。
- **credential authority**：enrollment create/redeem、client/host refresh、host reauthentication、host bootstrap API、response replay-key rotation lifecycle。
- **default-off compositions**：显式 default-off Broker/Host compositions，默认 CLI 不启用。

## 已通过

- **G2（Node↔Node 端到端互操作）已于 2026-08-05 通过**：`scripts/relay-v2-interop.mjs` 以真实 broker + 真实 host + 真实 WSS/TLS 走完 bootstrap → enrollment → 握手协商 → command ledger/query（真实 create_terminal）→ snapshot revision → event sequence → 结构化错误表 → 断线重连 terminal resume（无字节丢失），7/7 通过。该 runner 是 G2 的可重跑证据。

## 未实现 / NO-GO

- G3（Android↔Node 端到端互操作）未通过。
- production v2 仍为 NO-GO：qualified E0/native durability/public TLS/network/device/signing/release 与 shipping activation 证据缺失（单机自托管 lane 按契约 §10.19(a) 分级豁免 E0）。
- 默认 Dashboard shipping 与 `relay-server`/`relay-host` CLI 路径仍只运行 Relay v1。
- 任何一端都不得仅凭本文、fixture、codec 或隔离 composition 存在而发布 v2 capability、生成可用 v2 配对二维码或把 v1 credential 当作 v2 credential。

## 已 Descoped

### 原生 credential state-store crates

9 个原生 Rust crates（`relay-v2-broker-credential-state-store-{core,napi,platform-common,platform-darwin,platform-linux}` 与 `relay-v2-host-credential-atomic-file-cell-{napi,platform-common,platform-darwin,platform-linux}`）已从仓库移除。

理由：在六项基础能力通过互操作之前过早进行 durability 工程；保持聚焦于功能交付。

JS loader（`hostCredentialNativeLoader.ts`、`brokerCredentialStateStoreLoader.ts`）在原生 artifact 缺失时返回 status `"missing"`，下游（`brokerCredentialStateStore.ts`、`hostCredentialNativeModuleSource.ts`）处理 `"missing"` 并回退到非原生路径（file/JSON/in-memory）。因此删除原生 crates 后 credential 功能在启用时降级到非原生持久化，不会硬失败。

### External continuity authority

`externalContinuityAuthority*`、`brokerCredentialExternalContinuityOpener` 及相关 contract/test 已 descope。

理由：同上——在基础互操作通过前不引入外部 durability 依赖。

`continuityAnchor.ts` 仍保留（被 `brokerCredentialAuthority.ts` 核心导入）。外部 HTTPS adapter、node attempt provider、config、opener 模块（`externalContinuityAuthorityConfig.ts`、`externalContinuityAuthorityHttpsAdapter.ts`、`externalContinuityAuthorityNodeAttemptProvider.ts`、`brokerCredentialExternalContinuityOpener.ts`）仍存在于源码中，但已 descope，不得用于 production activation。这些模块与 broker composition/shipping 层（`brokerServerRuntime.ts`、`brokerShippingRoot.ts`、`brokerShippingDeploymentSource.ts`、`brokerLocalDevelopmentActivation.ts`）深度集成（约 95 处引用），本轮未移除代码以避免破坏 composition 层构建；后续轮次在基础互操作通过后再统一清理。

### Agent transcript lifecycle v1 Codex app-server 实现模块

`src/relay/extensions/agentTranscriptLifecycle/v1/` 下除 `codec.ts` 外的 11 个实现模块（`authority.ts`、`store.ts`、`runtime.ts`、`codexAppServerTrustedSourceActivation.ts`、`codexAppServerProcessControllerAuthority.ts`、`codexAppServerNotificationSource.ts`、`codexAppServerProducer.ts`、`codexTrustedSourceComposition.ts`、`codexRolloutFileSourceAuthority.ts`、`codexRolloutJsonlNotificationByteSource.ts`、`codexAppServerThreadAcquisitionAuthority.ts`，共约 10,848 行）已作为死代码删除。

理由：这些模块未被 `src/`、`app/src/`、`app/src-tauri/src/` 中任何代码导入（仅扩展目录内部互相引用），属于未接线的 Codex app-server 实现。

`codec.ts` 保留（被 `brokerCore.ts`、`brokerServerRuntime.ts`、`relayV2DashboardManagementProtocolV2.ts` 导入）；dashboard self-hosted deployment 通过 `--v2-agent-transcript-lifecycle-v1` 启用的 capability gating 作为 live surface 保留。

## 非 production deployment policy

`non-production-single-node-co-located-sqlite-v1` policy（`--v2-single-node-self-hosted`）将 broker credential authority 的 state-store、continuity port 与 issuer keyring 绑定到同一 owner-only SQLite deployment owner。该 policy 不修改 public wire、closed schema、错误表或六项 required capabilities，且明确 **不是 E0**，不满足 rollback-independent production continuity 要求。

## 决策记录

### 2026-08-05：contract §10.19 按部署 profile 分层 E0 证据

contract 版本升至 v2.0.1-android-first。§10.19 的 external-continuity（E0）生产证据按部署 profile 分层：

- **`non-production-single-node-co-located-sqlite-v1`（自托管单节点 lane）**：不要求 E0 证据。耐久性边界是与 credential state-store、issuer keyring 同库共置的 SQLite 单调 continuity 行。§10.1–§10.18 全部通过后可宣告"self-hosted GO"，但不得宣告多租户生产可用或 rollback-independent durability。
- **多租户 / rollback-independent 生产 tier**：仍须提供完整 E0 证据（独立失败域、linearizable read/CAS、CAS RPO=0、stable provisioning/ACL、旧备份拒绝 serving、failover high-water、closed internal error mapping、broker-credential ready-loss 同步 admission/active-data fence）。当前 descoped，保持 NO-GO。

§1–§8 wire 语义、六项 requiredCapabilities、closed schema 与错误表未改动。§10.1–§10.17 对所有 profile 通用，任何 lane 不得跳过。

### 2026-08-05：Agent extension（G4/X）移出主线门槛

Agent transcript/lifecycle extension（`agent.transcript-lifecycle.v1`）的 frozen contract 与 `codec.ts` 保留，broker capability gating（`--v2-agent-transcript-lifecycle-v1`）作为 live surface 保留。Node 实现模块已于 2026-08 从仓库删除。

G4 不在主线门槛序列内；G5 的 precondition 不再要求 G4。该 extension 不属于 base v2 交付，未来作为独立 proposal 单独协商。
