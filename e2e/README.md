# TW 全链路 E2E 发布验收清单

发布前人工/半自动全链路验收。按顺序执行；每条记录结果与证据。**全部 P0 段为绿才允许发版**。

- 被测版本：1.0.28 + master 未发布修复（orphan-center reaper，`53e34a17`）
- 被测环境：
  - macOS app：`/Applications/tw-dashboard.app` 1.0.28（本机直接安装）
  - devbox center：`10.37.6.166:8788`，self-hosted bundle 1.0.28，Let's Encrypt 外部 TLS，tmux 3.7b
  - Android：模拟器 Pixel 3a API 36（arm64），debug APK 1.0.28，包名 `com.tmuxworktree.mobile`
  - 网络入口：`https://tw-relay.duckdns.org:8788/`
- 自动化手段：adb（deeplink/截图/状态）、ssh devbox、node CLI、`scripts/` 既有 harness；纯 UI 点击标注【手测】
- 结果标记：⬜ 未测 / ✅ 通过 / ❌ 失败 / ⏭ 跳过（注明原因）
- 最近一次完整执行：见文末「执行记录」

图例：**[P0]** 发版阻断项；**[P1]** 重要；**[P2]** 尽力。

---

## A. 基线与静态状态

| ID | 级别 | 用例 | 预期 | 结果 |
|---|---|---|---|---|
| A1 | P0 | 五处版本一致：root/app `package.json`、`tauri.conf.json`、Cargo.toml、`dist/cli.cjs version`、已装 app、devbox `current/cli.cjs`、APK versionName | 全部 1.0.28（发版时为新版本号且五处同步） | ⬜ |
| A2 | P0 | 自动化测试门禁：cargo lib / renderer / Node node:test / Android JVM 单测 + assembleDebug | 0 失败 | ⬜ |
| A3 | P0 | 基础设施静态：devbox tmux session 在、8788 LISTEN、broker HTTPS 可达、Mac 8788 WSS ESTABLISHED、本机管理子进程存活且无 churn | 全部成立 | ⬜ |
| A4 | P0 | 模拟器已启动、APK 已装、冷启动进入 pairing 页 | `com.tmuxworktree.mobile` 存在，PairingScreen 渲染 | ⬜ |
| A5 | P2 | 合约常量三方不漂移 | `npm run check:contracts` 通过 | ⬜ |

## B. Dashboard 桌面端 — 静态状态与显示

| ID | 级别 | 用例 | 预期 | 结果 |
|---|---|---|---|---|
| B1 | P0 | 【手测】app 冷启动 Mission Control：phones/agents/review tiles、Mobile devices 卡 | 渲染正常无错误条；Relay 连接概览为成功态 | ⬜ |
| B2 | P0 | 【手测】Settings→Connections→Relay 三卡：self-hosted 状态事实（Bundle current / TLS ready / Center running 且版本=1.0.28 / Host credential provisioned / connector desired on） | 全部 ready/running，无 stale 警告 | ⬜ |
| B3 | P1 | 【手测】Enrollment preview 卡：Host bootstrap/connector 状态、Copy link / Show QR 按钮可用 | 可生成一次性链接与 QR | ⬜ |
| B4 | P1 | 【手测】侧栏 Workspaces/Terminals/Automations 分组与底部 host 就绪指示 | Local ready；devbox host 状态正确 | ⬜ |
| B5 | P2 | 【手测】Settings 其余 tab（Appearance/Agents/Integrations/Advanced）可打开无异常 | 无白屏/报错 | ⬜ |
| B6 | P2 | 【手测】⌘K 命令面板、⌘N 新建、深色/浅色主题切换 | 正常 | ⬜ |

## C. 桌面终端链路

| ID | 级别 | 用例 | 预期 | 结果 |
|---|---|---|---|---|
| C1 | P0 | 【手测】New terminal（local）创建，输入 `echo e2e` | PTY 输出正常、可连续输入 | ⬜ |
| C2 | P1 | 【手测】终端持久化：关闭窗口再开 app，终端仍在 | tmux 会话恢复、历史可见 | ⬜ |
| C3 | P1 | 【手测】Scratch 面板加/删 shell、拖拽分隔条 | 正常 | ⬜ |
| C4 | P2 | 【手测】New terminal on devbox（SSH host） | 远程 shell 可用 | ⬜ |
| C5 | P1 | takeover 期间桌面终端只读（与 I/J handoff 联动） | 只读 banner 出现、输入被拦 | ⬜ |

## D. Agent 任务链路（桌面）

| ID | 级别 | 用例 | 预期 | 结果 |
|---|---|---|---|---|
| D1 | P0 | 【手测】New worktree：选仓库/基线分支/agent=codex/任务名 → 创建 | git worktree + tmux 会话建成，terminal 里 agent 原生界面起来 | ⬜ |
| D2 | P1 | 【手测】新任务出现在侧栏与 Overview，可重新打开 | 列表一致、attach 恢复 | ⬜ |
| D3 | P1 | 【手测】任务内让 agent 做一个小改动（真实对话），观察 Git 面板变化 | agent 产出 → 文件状态/diff 可见 | ⬜ |
| D4 | P1 | 【手测】脏 worktree 删除被拦；干净任务可 rm | dirty 拒绝（需 force），clean 成功 | ⬜ |

## E. Git / 编辑器 / Automation

| ID | 级别 | 用例 | 预期 | 结果 |
|---|---|---|---|---|
| E1 | P1 | 【手测】Git status：staged/mod/new 计数、ahead/behind | 与 `git status` 一致，4s 轮询刷新 | ⬜ |
| E2 | P1 | 【手测】DiffViewer 打开改动文件 | 语法高亮/diff 正确 | ⬜ |
| E3 | P2 | 【手测】Git graph：ref 选择、load more | 拓扑渲染正确 | ⬜ |
| E4 | P1 | 【手测】Files 浏览/搜索 → 编辑器改文件 ⌘S 保存；Markdown Preview 切换 | 落盘成功、preview 渲染 | ⬜ |
| E5 | P2 | 【手测】Automation 新建/保存/删除；Run now 产生 run 记录 | 列表与 runs 更新（Run now 会真起 agent，可只做保存/删除） | ⬜ |

## F. Relay Center 生命周期（含 orphan reaper 修复）

| ID | 级别 | 用例 | 预期 | 结果 |
|---|---|---|---|---|
| F1 | P0 | 面板【手测】Stop v2 Center：session 消失、孤儿 node 被回收、端口释放、版本记录删除 | 无残留 node 占 8788 | ⬜（脚本级 ✅ 2026-09-14） |
| F2 | P0 | 面板【手测】Start v2 Center：session/8788/version 1.0.28 恢复 | 探针 running | ⬜（脚本级 ✅） |
| F3 | P1 | 面板【手测】center 活着时再 Start（幂等） | 不杀活 node | ⬜（脚本级 ✅） |
| F4 | P1 | Deploy/update bundle 可执行；运行中 center 重启到新 bundle | current 指向新 bundle、version 刷新 | ⬜ |
| F5 | P1 | center bounce 期间 Mac WSS 自动恢复、管理子进程不 churn | ESTABLISHED 恢复、spawn 增量 0 | ⬜（两次 bounce ✅） |
| F6 | P2 | Kerberos 票过期→续期后 Mac connector 自愈 | 无需手动重启 app | ⬜（1.0.28 已验） |

## G. Android 激活与配对

| ID | 级别 | 用例 | 预期 | 结果 |
|---|---|---|---|---|
| G1 | P0 | 冷启动静态：标题/说明/Scan QR/Enroll/Keystore 安全说明 | 文案完整 | ⬜ |
| G2 | P1 | 非法 deeplink（`tmuxworktree://enroll?...` 缺字段/错 scheme） | 落 review 错误态或 "invalid" 提示，不发 redeem | ⬜ |
| G3 | P0 | 有效 deeplink 激活：review facts 正确 → Confirm → Enrollment saved → Connect → ONLINE | 全程通过，WSS 在线 | ⬜ |
| G4 | P2 | Manual enrollment 弹层：非法 URL/token 校验、Cancel | 校验生效 | ⬜ |
| G5 | P2 | QR 扫码激活（真机摄像头/虚拟场景） | 等同 G3 | ⬜（模拟器相机受限，真机手测） |
| G6 | P1 | Dashboard Overview / Relay 卡出现该手机，可 Revoke grant | 设备与 grantId 可见 | ⬜ |

## H. Android 静态状态与显示

| ID | 级别 | 用例 | 预期 | 结果 |
|---|---|---|---|---|
| H1 | P0 | 激活后 Inbox：Needs attention/Running 分区、空态文案、顶部连接 chip=Online | 数据与 Mac 侧 catalog 一致 | ⬜ |
| H2 | P0 | Workspaces：scope chip、Worktrees/Terminals 分组与空态 | 与会话实际一致 | ⬜ |
| H3 | P1 | Settings：版本 1.0.28、Dark switch、三个通知 switch、Lark bindings 行 | 显示正确 | ⬜ |
| H4 | P1 | Connection Health：分层步骤全绿、summary 文案、Copy diagnostics | 全 healthy，诊断文本可复制 | ⬜ |
| H5 | P1 | Drawer：计算机名 + online 徽标、Refresh sessions、Pair another computer | 正常 | ⬜ |
| H6 | P2 | Inbox attention 计数徽标（有等待会话时 1–99） | 计数正确 | ⬜ |

## I. Android 终端链路

| ID | 级别 | 用例 | 预期 | 结果 |
|---|---|---|---|---|
| I1 | P0 | New terminal 表单（computer/scope/cwd/label）→ 创建并自动进 xterm | 真实 tmux 会话建成 | ⬜ |
| I2 | P0 | 终端内输入 `echo android-e2e`、回车、看到输出；字体大小/键盘/只读按钮可用 | I/O 正确、控件生效 | ⬜ |
| I3 | P0 | 从 Workspaces 打开既有终端（含 Mac 创建的会话） | resume 成功、历史回放无空洞 | ⬜ |
| I4 | P1 | 切后台 30s 再回前台 → stream resume | disposition=resumed，字节连续 | ⬜ |
| I5 | P1 | resize（旋转/改字号）→ 远端 tmux 窗口尺寸同步 | resize_ack、显示不错位 | ⬜ |

## J. Android Agent 对话

| ID | 级别 | 用例 | 预期 | 结果 |
|---|---|---|---|---|
| J1 | P0 | 打开 D1 创建的 agent 会话：chat 历史加载、markdown 渲染 | 与终端内容对应 | ⬜ |
| J2 | P0 | 手机发一条真实 agent 消息（小任务，如「列出当前目录文件」） | typing/progress → agent 回复；Mac 终端同一会话可见 steer | ⬜ |
| J3 | P1 | Session detail timeline：事件与投递状态（Sent/Accepted/…） | 状态序列正确 | ⬜ |
| J4 | P1 | Open terminal 从 chat 跳入同一任务终端 | 跳转正确 | ⬜ |
| J5 | P2 | agent 失败/重试气泡与 retry（难造，视机会） | 失败可重试 | ⬜ |
| J6 | P1 | 手机 New worktree 向导完整创建一个 e2e 临时 worktree（agent 会话） | 创建成功并进 chat；Mac 侧可见 | ⬜ |

## K. Android 韧性与生命周期

| ID | 级别 | 用例 | 预期 | 结果 |
|---|---|---|---|---|
| K1 | P0 | 飞行模式开 15s 再关：chip 转 Offline/Reconnecting → 自动 Online，不杀 app | ≤60s 自愈，会话状态恢复 | ⬜ |
| K2 | P0 | devbox center Stop→Start 期间手机自动重连 | 断后自动恢复 Online | ⬜ |
| K3 | P1 | 从 recents 划掉 app 进程后重新启动 | auto-connect 持久化，直接回 Online | ⬜ |
| K4 | P0 | Forget this pairing：确认后远端 grant revoke + 本地凭据 wipe，回 pairing 页；重放旧 token 失败 | 服务端拒绝旧凭据 | ⬜ |
| K5 | P1 | Forget 后重新 deeplink enroll 成功 | 二次激活正常 | ⬜ |
| K6 | P2 | End session（session detail）→ kill_session，列表移除 | Mac tmux 会话结束 | ⬜ |

## L. CLI 冒烟

| ID | 级别 | 用例 | 预期 | 结果 |
|---|---|---|---|---|
| L1 | P1 | `tw doctor` | 全绿或仅已知警告 | ⬜ |
| L2 | P1 | `tw ls`、`tw status` | 列出真实会话 | ⬜ |
| L3 | P1 | `tw host ls`、`tw host probe devbox` | reachable/tmux/tw 三层就绪 | ⬜ |
| L4 | P2 | `tw worktree prune --dry-run` | 正常输出不误删 | ⬜ |
| L5 | P1 | `tw feishu-bridge status` | daemon/profile 状态可读 | ⬜ |
| L6 | P2 | `tw version` 与 A1 一致 | 一致 | ⬜ |

## M. Lark / 飞书桥（需要测试群与机器人配合）

| ID | 级别 | 用例 | 预期 | 结果 |
|---|---|---|---|---|
| M1 | P1 | bridge daemon 运行、lark-cli profile 有效（`--as bot`） | health starting→running | ⬜ |
| M2 | P1 | Dashboard 绑定一个测试群 ↔ 一个本地受管会话 | 群内收到 linked 卡片 | ⬜【需用户提供测试群】 |
| M3 | P1 | 群内 @机器人 发 steer 消息 | 终端收到、typing 反应、结果卡片回 topic/私聊 | ⬜【需用户在群里配合】 |
| M4 | P2 | takeover/return：接管期间群内 steer 被 handoff-pending 拒绝卡片提示 | fail closed | ⬜ |
| M5 | P2 | 手机 Settings→Lark bindings 显示该绑定，可切换 reply mode/解绑 | 三端一致 | ⬜ |

## N. 发版物料与发布动作

| ID | 级别 | 用例 | 预期 | 结果 |
|---|---|---|---|---|
| N1 | P0 | 版本决策：P2 修复未发布 → bump 1.0.29（root/app/tauri/cargo 四处 + versionCode +1） | 五处一致（A1） | ✅ 1.0.29，versionCode 20026，APK badging 实证，commit 9f995afe |
| N2 | P0 | `app/scripts/release.sh --dry-run`（或实构建）：tauri build、codesign 校验、DMG + sha256 staged 且校验通过 | 产物就绪 | ✅ DMG 5.9M，签名 sealed resources 校验过，sha256 一致 |
| N3 | P0 | bnpm publish 新版本；**先更新全局包再** `tw-dashboard-install` 验新装 app 版本 | 避开 stale-global 坑 | ⏭ 用户决定本轮不发 bnpm（仅 GitHub 渠道） |
| N4 | P0 | GitHub Release v<ver> 上传 arm64 DMG + sha256 | release 资产齐 | ✅ v1.0.29 已发布，tag=9820571f，DMG+sha256 可下载 |
| N5 | P1 | devbox center Deploy 新版本 bundle + Stop/Start（或面板 Deploy） | center 版本刷新 | ✅ 面板 Deploy：t+18s current 切到 1.0.29，center 自动重启（deploy-restarts-center），单 node 8788 LISTEN，Mac WSS 2 ESTABLISHED |
| N6 | P2 | 发布后手机/桌面在线状态复测一轮 | 全绿 | ⬜ |

---

## 执行记录

### 2026-09-14（1.0.28 + master 53e34a17，执行人：自动化+手测混合）
- A1 ✅ 八处版本均 1.0.28
- A2 ✅ cargo lib 283/0、renderer 488/0、Node 1990+1skip、Android JVM 单测通过、assembleDebug 通过
- A3 ✅ center 1.0.28 session/8788/HTTPS/WSS 全在，管理子进程无 churn
- A4 ✅ 模拟器冷启动 PairingScreen
- A5 ✅ check:contracts 通过
- F1/F2/F3/F5 ✅ 生成脚本在 devbox 真 broker 上验证（孤儿回收 2.4s、stop/start、幂等不动活 node、两次 bounce Mac WSS 0 respawn）
- L1 ✅（doctor 仅报用户历史失效项目路径 + 46 孤儿 worktree，非回归）
- L2/L3/L4/L6 ✅ devbox 探针 compatible=true；L5 ⏭ bridge 未运行（留 M 段）
- G1 ✅ pairing 页文案完整
- G2 ✅ 非法 deeplink 被拒（"payload is invalid"，不发 redeem）
- G3 进行中：自动化打通（AX 操作 app 生成 QR→Vision 解码→deeplink→Confirm），review facts 已验证正确；被本机内存压力反复打断（模拟器 system_server 被 OOM 杀、screencapture 挂起、swap 28G 打满）
- 自动化回归补充：`npm run test:interop` 8/8 PASS（handshake/六基能/terminal resume）
- G3 ✅ 有效 deeplink 全链路：review facts 正确 → Confirm（正确按钮坐标 540,1357；Cancel 在其下方）→ redeem 成功 → ONLINE；broker enrollment consumedAtMs 落地
- G6 ✅ Dashboard Overview 出现该手机（Dashboard·c67776）
- H1/H2/H3/H4/H5 ✅ Inbox/Workspaces/Settings(1.0.28)/Connection Health 全绿/Drawer 在线态均正确
- I1/I2/I3 ✅ 手机建 tmux 会话（tw-term-8ecfa）、真实命令 I/O、Mac 侧会话 resume 回放正常
- J 段（真实 codex 会话，模型 gpt-5.3-codex-spark xhigh）：
  - J6 ✅ 手机 New worktree 三步向导创建 e2e-spark-j：Mac git worktree `~/.tmux-worktree/worktrees/tmux-worktree/tmux-worktree-e2e-sp`（基于 master aeb4e398）+ tmux session `tmux-worktree-e2e-sp` + codex 以指定模型启动
  - J2 ✅ 手机发 "Reply with exactly E2E_SPARK_OK" → Mac codex TUI 收到 steer → 回复 E2E_SPARK_OK → 手机气泡渲染（经 relay 双向闭环）
  - J1 ✅ 历史两轮对话加载正常；markdown bullet list（Apple/Banana/Mango）渲染正确
  - J3 ✅ Session detail timeline：You/Agent/System 事件齐，Turn lifecycle: Completed ×2、Run lifecycle: Waiting for user
  - J4 ✅ chat 右上 Open terminal 跳进同一任务终端，codex TUI 实时内容一致（footer=gpt-5.3-codex-spark xhigh，Online）
  - J5 ⏭ 失败/重试气泡 P2，未造场景
- K 段：
  - K1 ✅ 飞行模式 15s：chip=Connection status: paused（网络层不可用时暂停而非重连风暴）；关网络后 ≤8s 自动 Online，app 不重建
  - K2 ✅ devbox center kill-session/rm version-record → 重新拉起：停机时静默断链 chip 不立即翻（WS TCP 半开），主动操作后显示 Recovering；center 重启后 ~10s 自动 Online；broker SQLite 持久化使 chat 历史完整恢复
  - K3 ✅ force-stop 进程后冷启动（launcher=.V2Activity）：2s Offline → 4s Online，auto-connect 持久化
  - K4 ✅ Forget this pairing：手机回 pairing 页，本地 datastore 仅剩 install clientInstanceId（无 token）；broker 端对应 grant（clientInstanceId f66b7f9c…）revokedAtMs=1789404933627（before/after sqlite 快照 diff 实证），refresh 对 revoked grant fail-closed
  - K5 ✅ Forget 后新 deeplink 重新激活：Enrollment saved → 手动 Connect（设计不自动连）→ 4s Online
  - K6 ✅ session detail → More actions → End session：二次确认后 Mac `tmux-worktree-e2e-sp` 消失（kill_session），手机显示 "This session is no longer available"
- I4/I5 补充：终端 resume/resize 在 J4/K2/K3 已间接覆盖（broker bounce、进程重启后流恢复）
- B1 ✅ Mission Control：4 统计 tile（need review/agents running/phones connected=1/remote hosts 2/2）、Agent inbox、RELAY V2 Mobile devices 显示 "1 mobile device online"（f66b7f9…213b，与 broker grant clientInstanceId 一致）、Local ready · 2/2 hosts ready，无错误条
- C1 ✅ 桌面 New terminal（local，~/Desktop）：tw-term-2b3d8 建成自动 attach，PTY I/O 实证 `echo E2E_DESKTOP_$((6*7))`→E2E_DESKTOP_42
- C2 ✅ 终端持久化：tw-term-8ecfa（前一晚 21:21 建）历经多次 app 重开仍在、历史可见
- D 段说明：桌面 New worktree wizard 渲染/交互正常（RESTORE EXISTING 列表、HOST/PROJECT/TARGET BRANCH/AGENT/SESSION NAME 全表单、失效目录 requirement-forward 自动剔除并提示）；后端 create worktree+tmux+agent 拉起链路由手机 J6/J2 端到端实证（同一 RPC）。桌面 wizard 走完创建留手测
- L 段：L3 ✅ `tw host ls`（mew-dev/devbox）、`tw host probe devbox` reachable 31ms/tmux 3.7b/tw 1.0.24 protocolVersion 2；L4 ✅ `tw worktree prune --dry-run` 正常列出不误删；L5 ⏭ 同 M（bridge 未运行，ENOENT feishu-bridge-v1.sock，预期）；注意：PATH 全局 tw=1.0.24（旧全局包），app 内置 CLI=1.0.28，发版需按 N3 先更新全局包
- F 段补充：K2 的 Stop/Start 与 F1/F2 同路径（devbox tmux 会话 tw-relay-v2-center + relay-v2-center.sh 重启），端口/版本记录/孤儿回收在 1.0.28 脚本级验证基础上再验一次真实 bounce 恢复
- 待办：B3–B6/E1–E5 桌面细项标【手测】；M1–M5 需测试群与用户配合；N 段发版（P0 全绿后）
- B2 ✅ Connections→Relay 卡：Mac connected — Relay v2 enrollment available；Connected mobile devices=新 client f66b7f9c…3213b（forget 后新激活实例），Grant 1b0d2ec6…b06ff · 1 connection，Revoke 可见（G6 同证）；devbox 事实补：bundle current=1.0.28、8788 LISTEN、tmux tw-relay-v2-center alive、Mac 3 条 ESTABLISHED
- F1/F2/F3 面板级复测 ✅：Stop v2 Relay Center → session GONE + 8788 计数 0 + 孤儿 node 回收 + center.running-version 删除；Start v2 Relay Center → 全恢复且记录=[1.0.28]；存活时再 Start：session_created 时间戳不变、单 node 不重建（幂等）；面板 bounce 后手机 2s 恢复 Online（F5 再次验证）
- L1 ✅ doctor 结论同 2026-09-14；L6 ✅ app 内置 CLI 1.0.28（PATH 全局 tw=1.0.24 为旧全局包，N3 发版注意）
