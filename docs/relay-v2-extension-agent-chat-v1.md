# Relay v2 Extension: agent.chat.v1

状态：**实现中**。本文是 Relay v2 上 agent chat 的 additive extension 契约；wire 形状冻结后才能合入生产 host 接线。

## 目标

把 Relay v1 的 agent chat（`docs/relay-agent-chat-v1.md`）以 Relay v2 additive extension `agent.chat.v1` 的形式迁移到 v2 通道，复用同一套 v1 chat 语义与 host 侧 `AgentChatEngine`（不改写引擎）。能力协商与帧路由对齐 `agent.transcript-lifecycle.v1` 的先例。

## 机制

- v2 host 在 `host.welcome` 中声明可选能力 `agent.chat.v1`；客户端在 `client.hello` 中 offer；broker 必须显式开启 `--v2-agent-chat-v1` 且三方就绪后，该能力才进入协商交集。
- 客户端 `agent.chat.send` / `agent.chat.history` 走 v2 extension lane 转发到 host；host 复用 v1 的 turn-marker 方案（`feishuBridge.extractFeishuMarkedReply`）驱动 `AgentChatEngine`，并以 `agent.chat.event`（增量）、`agent.chat.sent`（确认）、`agent.chat.history.result`（对账）推回。
- 未协商/能力撤回时 broker 或 host 返回结构化 `error`（`commandDisposition: "not_applicable"`），不关闭连接。
- 语义约束（turn 超时、correlation 漂移、steering、`[[` 转义、历史 ring buffer 上限等）与 v1 完全一致，详见 `docs/relay-agent-chat-v1.md`。

## 能力协商

| 参与方 | 声明位置 | 值 |
|---|---|---|
| Host | `host.welcome.capabilities` | `agent.chat.v1` |
| Client | `client.hello.capabilities` | `agent.chat.v1` |
| Broker | 启动参数 | `--v2-agent-chat-v1` |

三方交集成立后，路由协商结果为 `selected`；任一方缺失则 `unselected`；broker 运行期能力丢失（`optionalCapabilityReadinessPort.withdraw`）则路由进入 `withdrawn`，后续请求返回结构化 `error`。客户端未见该能力时不得展示聊天入口（回退为既有终端视图）。

## Wire 形状（v2 extension lane）

帧信封沿用 v2 extension 公共形状：`protocolVersion: 2`、`kind`、`type`、`requestId`、`hostId`、`expectedHostEpoch`（请求）/`hostEpoch`（响应/事件）、`scopeId`、`sessionId`、`payload`。

### Client → Host

```ts
// 发送/steer：与 v1 agent_chat_send 语义一致
{
  protocolVersion: 2, kind: "request", type: "agent.chat.send",
  requestId, hostId, expectedHostEpoch, scopeId, sessionId,
  payload: { session: string, message: string }
}

// 历史对账：与 v1 agent_chat_history 语义一致
{
  protocolVersion: 2, kind: "request", type: "agent.chat.history",
  requestId, hostId, expectedHostEpoch, scopeId, sessionId,
  payload: { session: string, limit?: number }
}
```

### Host → Client

```ts
// 确认：与 v1 agent_chat_sent 语义一致
{
  protocolVersion: 2, kind: "response", type: "agent.chat.sent",
  requestId, hostId, hostEpoch, scopeId, sessionId,
  payload: { session: string, turnId: string }
}

// 增量事件：与 v1 agent_chat_event 语义一致
{
  protocolVersion: 2, kind: "event", type: "agent.chat.event",
  hostId, hostEpoch, scopeId, sessionId,
  payload: { session: string, turn: AgentChatTurnView }
}

// 历史结果：与 v1 agent_chat_history_result 语义一致
{
  protocolVersion: 2, kind: "response", type: "agent.chat.history.result",
  requestId, hostId, hostEpoch, scopeId, sessionId,
  payload: { session: string, turns: AgentChatTurnView[] }
}
```

`AgentChatTurnView` 复用 v1 定义（`src/relay/v1/messages.ts`）：

```ts
type AgentChatTurnView = {
  turnId: string;
  session: string;
  userMessage: string;              // 用户原文（不含包装 prompt）
  status: "working" | "replied" | "failed" | "recovery-required";
  reply?: string;                   // 提取出的标记回复（清洗后）
  error?: string;
  sentAt: string;                   // ISO 8601
  completedAt?: string;
  steeredMessages?: { message: string; sentAt: string }[];
};
```

### 错误映射（结构化 error）

extension 能力缺失/撤回时，broker 或 host 返回 `type: "error"` 响应帧，`payload: null`，`error` 走 v2 结构化错误表（`commandDisposition: "not_applicable"`）：

| code | 场景 | retryable |
|---|---|---|
| `AGENT_CHAT_UNAVAILABLE` | 能力未协商/已撤回；host 侧 chat 引擎不可用 | 按触发方（broker 撤回 false，host 瞬时失败 true） |
| `AGENT_CHAT_SESSION_UNAVAILABLE` | session 不是 agent 托管/不可解析 | false |
| `HOST_EPOCH_MISMATCH` | `expectedHostEpoch` 与当前 host epoch 不符（base v2 共有） | false |

`details` 只允许出现在 `HOST_EPOCH_MISMATCH`（`expectedHostEpoch` / `actualHostEpoch`），其余 code 禁止携带 `details`。

## Broker 路由

- `RELAY_V2_OPTIONAL_CAPABILITIES` 追加 `agent.chat.v1`（既有 `agent.transcript-lifecycle.v1` 保留）。
- 帧分类：`decodeBrokerPublicFrame` 先尝试 base codec，再依次尝试已注册 extension codec（transcript → chat）；命中 chat 的帧进入 `lane: "agent_extension"` 路由，按 chat 的 client→host / host→client 类型表做身份校验。
- 未协商的 chat 请求帧：`INVALID_ENVELOPE` + `unnegotiated_agent_extension`（close 4400）；已撤回的 chat 请求帧：结构化 `error` `AGENT_CHAT_UNAVAILABLE`。
- `host.welcome.capabilities` 含 `agent.chat.v1` 但 broker/client 未协商时，broker 从出站 welcome 中剥离该能力。

## 部署接线（仅记录，不在本 worktree 实现）

devbox v2 center 启动命令需追加 `--v2-agent-chat-v1`，对齐既有 `--v2-agent-transcript-lifecycle-v1` 的接线位：

- `self_hosted_deployment.rs`：`AGENT_TRANSCRIPT_LIFECYCLE_FLAG` 的同类位置追加 `--v2-agent-chat-v1`。
- host 侧生产接线（把 v2 host 的 terminal control 适配成 `AgentChatControl` 并注入 `AgentChatEngine`）由后续工作完成；本 extension 的 host 附件以构造注入的引擎端口实现，可独立测试。

## 非目标（本轮）

- 多设备实时广播（与 v1 一致，仅发起客户端 + history 对账）。
- 聊天历史持久化到磁盘。
- 修改 v1 的任何 wire 形状或 v1 `agent-chat-v1` 能力。
