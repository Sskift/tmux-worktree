# Relay Agent Chat v1

状态：**实现中**。本文是 Node host 与移动客户端两端实现的共同契约；wire 形状在两端合入前冻结。

## 目标

移动 App 与某个 agent 会话像聊天软件一样收发消息：用户消息与 agent 的最终回复呈现为对话气泡，无需盯终端字节流。

## 机制

复用 Feishu bridge 已验证的 turn-marker 方案（`src/feishuBridge.ts` 的 `feishuTurnMarkers` / `extractFeishuMarkedReply`）：

1. 客户端发 `agent_chat_send`；host 通过既有 terminal control lease 路径把 prompt 注入 agent 终端。
2. prompt 用分段拼接方式指示 agent 把公开回复夹在 `[[notify-group:<nonce>]]` … `[[/notify-group:<nonce>]]` 之间（分段拼接避免 agent 从 prompt 原样回显标记）。
3. host 轮询 rendered 终端输出（带 cursor/generation 关联校验），清洗 ANSI 后按 nonce 提取回复。
4. 回复以 `agent_chat_event` 推给发起客户端；权威记录在 host 侧 turn history，客户端断线重连后用 `agent_chat_history` 对账。
5. turn 进行中再次 `agent_chat_send` 同一 session = steering：并入当前任务，不开新 turn（记入该 turn 的 `steeredMessages`）。

## 能力协商

Host 在 `host_ready.capabilities` 中声明 `"agent-chat-v1"`。客户端未见该能力时不得展示聊天入口（回退为既有终端视图）。

## Wire 形状（additive，加入 relay v1 messages）

Client → Host（`RelayClientMessage` 新增）：

```ts
| { type: "agent_chat_send"; hostId?: string; requestId?: string; session: string; message: string }
| { type: "agent_chat_history"; hostId?: string; requestId?: string; session: string; limit?: number }
```

Host → Client（`RelayHostMessage` 带 `clientId` 路由 / `RelayToClientMessage` 去掉 `clientId`，新增）：

```ts
| { type: "agent_chat_sent"; clientId: string; requestId?: string; session: string; turnId: string }
| { type: "agent_chat_event"; clientId: string; session: string; turn: AgentChatTurnView }
| { type: "agent_chat_history_result"; clientId: string; requestId?: string; session: string; turns: AgentChatTurnView[] }
```

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

## 语义约束

- **Additive only**：不修改任何既有 v1 消息形状；老客户端/老 host 互不感知即互不影响。
- 事件投递 best-effort 到发起 `clientId`；掉线丢失由 `agent_chat_history` 对账补齐（host 侧每 session 保留 capped ring buffer，默认 200 turns，内存态即可）。
- turn 超时、终端 correlation 变化（epoch/fence/generation 漂移）、控制权交接（HANDOFF_PENDING）→ turn 进入 `failed` / `recovery-required` 并附 `error`；不得静默吞。
- 轮询间隔与超时参数跟随 feishuBridge 现值；回复字节上限跟随其 `MAX_REPLY_BYTES`。
- `agent_chat_send.message` 中的 `[[` 按 feishuBridge 同款方式转义（`[​[`），防止用户文本伪造标记。

## 非目标（本轮）

- 多设备实时同步（其他客户端靠 history 对账，不做广播）。
- 持久化聊天历史到磁盘。
- v2 协议通道（v2 默认路径就绪后作为 extension 迁移）。
