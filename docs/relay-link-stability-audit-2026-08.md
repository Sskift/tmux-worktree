# Relay 链路稳定性审计（手机连接视角，2026-08）

状态：**审计记录**。只读审计产出；关键论断已抽查复核（clientId 随机生成 `src/relay/broker/server.ts:743`、4MB 缓冲断连 `server.ts:123,180`、v2 WSS 无 ping/pong）。

## 总体结论

手机连接链路当前**尚未达到"日常可用"的健壮性**。v1 在"网络稳定、app 前台"下可用（有 ping/pong、指数退避、错误到 UI），但断线必丢数据、重连全量重来、后台不保活三个硬伤直接影响日常使用。v2 设计上已解决大部分（resume token + replay offset、outbox、credential reauth），但 **v2 自身缺 WebSocket 层心跳**，半开连接检测是待补缺口。

## P0 — 用户可感知的断连/丢数据（均为 v1 结构性问题）

| # | 问题 | 位置 |
|---|------|------|
| P0-1 | `terminal_data` 无序号/ack/缓冲，断线期间终端输出永久丢失，v1 无 resume | `relayHost.ts:3304-3313`、`broker/server.ts:713`、`v1/messages.ts:72-73` |
| P0-2 | 客户端重连 `clientId` 全新（randomUUID），订阅/流/pending 全部重来 | `broker/server.ts:743,898-926` |
| P0-3 | host 重连时 broker 主动关闭所有客户端终端流（`dropHostStreams`） | `broker/server.ts:377-388,437-452` |
| P0-4 | host↔broker 断开时 host 销毁本地所有 stream（杀进程/断 tmux WS） | `relayHost.ts:2268-2294,2403-2411,3622-3633` |

**处置决策**：不对 v1 做结构性手术（v1 将被 v2 取代，这些正是 v2 六大基础能力要解决的问题——terminal.stream.resume.v1、event.sequence.v1、command.ledger.v1）。P0 清单转为 **v2 默认路径切换的验收清单**：切换时逐项验证 v2 确实消除。

## P1 — 特定网络条件下不稳定

| # | 问题 | 位置 | 处置 |
|---|------|------|------|
| P1-1 | v1 半开连接假活窗口 30-60s（broker ping 30s / OkHttp ping 20s） | `broker/server.ts:930-942`、`RelayV1ConnectionActor.kt:1399-1402` | 随 v1 退役 |
| P1-2 | **v2 WSS 层完全无 ping/pong**，死连接只能靠 5s delivery timeout 或 TCP RST 发现 | `brokerHostWssNodeNoServerAdapter.ts:53-59`、`brokerClientWssNodeListenerFreeIngress.ts:477`、`hostWssTransportLifecycle.ts:860-873` | **立即修**（已派发） |
| P1-3 | 客户端命令无 outbox，断线瞬间的 terminal_input/agent 消息静默丢失 | `RelayV1ConnectionActor.kt:646-678,1013-1030` | v2 有 outbox；chat 功能靠 history 对账缓解 |
| P1-4 | Android 无前台 Service/WakeLock，切后台连接随时被杀 | `AndroidManifest.xml`、`V2Activity.kt` | 排队（chat UI 合并后做，避免 worktree 冲突） |
| P1-5 | v1 静态 secret 无续期，轮换即全员重新配对 | `broker/server.ts:155-159` | v2 reauth 已解决，随 v1 退役 |

## P2 — 可改进

- P2-1 重连退避封顶 15s 无慢重试档，长期离线耗电（`RelayConnectionReducer.kt:11-18`）→ 配合 P1-4 一起做（网络可用事件触发重连）
- P2-2 broker 发送缓冲超 4MB 直接 terminate，弱网+大输出误杀（`broker/server.ts:123,178-184`）→ v2 切换验收项（背压）
- P2-3 Android 事件队列 32 满即重置连接，UI 慢放大成断连（`RelayV1ConnectionActor.kt:74,1264-1268`）→ terminal_data 合并/丢弃策略，配合 P1-4
- P2-4 单 client streamId 预算 1024 用尽须重连（`broker/server.ts:120,866-876`）
- P2-5 v2 delivery timeout 5s 弱网误杀（`brokerClientSocketTransport.ts:31,877`）→ 与 P1-2 同轮调整
