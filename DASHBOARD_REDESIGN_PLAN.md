# tw-dashboard v2 最终重构计划

> 状态：Final
>
> 日期：2026-07-10
>
> 实施分支：`tmux-worktree-app-re-ddf7c`
>
> 目标：把现有 Dashboard 从“可自由拆分的终端工具集合”重组为“以 worktree / agent session 为中心的 macOS 工作台”，同时保留现有 Tauri 后端、tmux、SSH、Git、文件、Automation 和 Mobile Relay 能力。

本文档是 Dashboard v2 的实施基线，替代 `~/Desktop/plan-a-tw-dashboard-redesign/PLAN.md` 中与当前仓库不一致的技术路线。后续实现、验收和合并均以本文档为准。

---

## 1. 已冻结的核心决策

1. **先继续使用 Tauri v2 + React。** 第一阶段不迁移 Electron、不重写 Rust 后端。
2. **先做 IA、组件边界和真实交互，再判断运行时。** 完成新 Shell 并 dogfood 后，用性能数据决定是否做 Electron 迁移。
3. **Terminal-first，不伪造 Chat。** 当前任意 `aiCmd` 只保证 tmux/PTY 输出，不保证结构化 agent event；在正式 agent adapter 完成前，中间主视图以 Terminal 为核心。
4. **三栏结构，但右栏必须可折叠、可响应。** 左侧统一导航、中间工作区、右侧 Inspector；窄窗口自动退化为抽屉或单栏。
5. **Settings 收纳低频、全局配置。** Host、Relay 参数、主题、agent probes、历史与隐私等进入 `⌘,` Settings；连接状态和当前 worktree 动作仍留在工作台。
6. **Feishu 是一等集成，但不是第一阶段阻塞项。** 全局授权和默认规则进入 Settings；当前 worktree 的 Bind / Pause / Unbind 放在 Inspector 和 `⌘K`。
7. **保留自由 `aiCmd`。** 不把 agent 类型收敛成枚举；后续通过可扩展 adapter/probe 描述能力。
8. **历史完全本地、默认关闭。** 后续会话历史以 append-only JSONL 为唯一基线，不引入云同步或 telemetry。
9. **产品外壳与终端主题解耦。** Dashboard 采用统一的深色产品主题；现有终端主题、字体和 tmux palette 继续保留。
10. **整个开发过程只在当前分支进行。** 所有阶段提交并 push 到 `origin/tmux-worktree-app-re-ddf7c`；完成并验收前不合并、不直接修改 `master`。

---

## 2. 为什么不直接重写 Electron

原方案中“Electron main process 直接复用 `dist/*.js`、后端基本不改”的前提与当前仓库不一致：

- Dashboard 前端根组件 `app/src/App.tsx` 为 3077 行，当前布局、轮询、选择、窗口状态、Relay 和 modal 都集中在这里；renderer 目前有 11 个文件直接依赖 Tauri API。
- 完整 Dashboard 后端位于 8713 行的 `app/src-tauri/src/lib.rs`，包含 PTY、Git、文件、SSH、Host、Automation、布局、Mobile Relay 等 64 个 Tauri command。
- Node 侧 `src/rpc.ts` 不是常驻 IPC/daemon，而是 `tw rpc` 的一次性 stdout CLI；实际 subcommand 只有 `list`、`capabilities`、`create-worktree`。`managed-state` 只是 capability 名，不是独立可调用 subcommand，远不能替代 Tauri command 层。

因此现在切 Electron 会同时引入 UI 重构、后端迁移、native module 打包、签名与升级四类风险，无法隔离问题来源。

最终策略：

1. 先在现有 renderer 中建立平台接口层和新 UI。
2. dogfood 并记录启动、渲染、Terminal、Git、diff 和轮询数据。
3. 只有确认剩余瓶颈来自 WebKit，而不是组件架构、轮询或数据流时，才进入 Electron spike。

---

## 3. 产品目标与非目标

### 3.1 产品目标

- 用户打开 app 后能快速找到正在运行、等待输入或停止的 worktree。
- 选择 worktree 后，Terminal、cwd、branch、Git 和文件上下文保持一致。
- 常用动作可以在当前视图或 `⌘K` 内完成，不需要在多列间寻找。
- Host、Relay、Feishu 等连接的状态始终可见，但配置不占用日常工作空间。
- 本地与 SSH worktree 使用同一套信息架构，差异通过 Host 状态和能力提示表达。
- 布局在 960、1100、1440 和 1600px 等常见窗口宽度下都可用。
- 现有用户数据和终端连接可以平滑迁移，不因 UI 重构丢失。

### 3.2 第一阶段非目标

- 不实现 ChatGPT 式结构化 Chat timeline。
- 不支持运行中随意切换 agent/model。
- 不迁移 Electron 或 SwiftUI。
- 不实现 Feishu bridge daemon。
- 不引入 SQLite、云同步、账户系统或 telemetry。
- 不重写现有 Terminal、FileTree、GitStatusPanel、DiffViewer 和 AutomationPanel 的核心能力。

---

## 4. 最终信息架构

### 4.1 App Shell

```text
┌────────────────────────────────────────────────────────────────────────┐
│ macOS titlebar / workspace title / current connection status           │
├───────────────┬──────────────────────────────────┬─────────────────────┤
│ Sidebar       │ Workspace                        │ Inspector           │
│               │                                  │                     │
│ Pinned        │ Header: worktree / branch / cwd  │ Files               │
│ Worktrees     │                                  │ Git                 │
│ Terminals     │ Primary: Terminal                │ Diff                │
│ Automations   │                                  │ Automation          │
│               │ Optional future: Chat            │ Feishu              │
│ Connections   │                                  │                     │
├───────────────┴──────────────────────────────────┴─────────────────────┤
│ Optional command palette / modal / settings overlay                    │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.2 左侧 Sidebar

默认宽度 280px，可在合理范围内调整，但不再垂直堆叠 Git 面板。

从上到下：

1. `New worktree` 主按钮。
2. 搜索入口；搜索 session/file，`⌘K` 进入全局命令面板。
3. `Pinned`：用户主动 pin 的 worktree/terminal。
4. `Worktrees`：按 `Host + Project` 分组，支持折叠。
5. `Terminals`：独立 tmux terminal。
6. `Automations`：展示状态和最近运行；配置详情在主区或 Settings。
7. `Connections` footer：显示本地、SSH Host、Mobile Relay 的汇总状态。
8. Settings 齿轮入口。

列表状态不能只靠颜色点表达，至少同时提供可读文本或 tooltip：

- Running
- Waiting / Idle
- Stopped
- Unknown
- SSH offline
- Reconnecting

### 4.3 中间 Workspace

#### Header

显示真实上下文：

- worktree / terminal 名称
- project
- branch
- cwd
- local / SSH Host
- agent identity 和运行状态（只读 chip）

首版动作：

- Split Terminal
- Toggle Inspector
- Cancel / Interrupt（仅能力存在时显示）
- More actions

首版不显示无法兑现的模型选择器和 Share。

#### 主内容

首版以 Terminal 为默认主视图，并保留当前能力：

- tmux attach
- 本地和 SSH PTY
- history snapshot
- resize
- copy/paste 和 copy mode
- link/file detection
- 选项切换时保持已打开 Terminal 挂载，避免重连和历史丢失

Files、Git、Diff 可以按需要进入主内容的 expanded state，但默认由 Inspector 承载，避免中栏和右栏重复 tabs。

### 4.4 右侧 Inspector

默认宽度 400–440px，可折叠。

Tabs：

- Files
- Git
- Diff
- Automation
- Feishu

规则：

- Inspector 只展示当前选中 workspace 的上下文。
- 打开大文件、编辑器或大 diff 时，可以“Expand to workspace”，而不是限制在窄栏。
- Agent 修改文件时可以显示 activity badge，但不能自动抢走用户当前 tab。
- Feishu 未配置时显示简短状态和进入 Settings 的 CTA；已配置时显示当前绑定及 Pause / Unbind。

### 4.5 响应式行为

| 窗口宽度 | 布局 |
|---|---|
| `>= 1440px` | Sidebar + Workspace + Inspector 三栏 |
| `1100–1439px` | Sidebar + Workspace；Inspector 作为右侧抽屉 |
| `960–1099px` | Workspace 优先；Sidebar 与 Inspector 均为可召回抽屉 |

补充规则：

- Workspace 的有效宽度不得小于 640px。
- 顶栏动作溢出时收进 More menu，不允许挤压标题/cwd。
- 不使用固定 820px composer 或固定 452px Inspector。
- Split Terminal 仅在有足够空间时并排，否则上下分屏。
- Sidebar/Inspector resize、折叠或窗口缩放后必须触发 xterm fit。
- 长 branch、cwd、Host 名和多语言文案使用中间省略与 tooltip，不能挤掉持续可见的主操作。
- 当前 Tauri 窗口最小宽度为 960px；该宽度下不得产生 app-level 横向滚动，打开 Drawer/Settings 也不能卸载 PTY。

---

## 5. Settings 最终设计

### 5.1 入口和形态

- 快捷键：`⌘,`
- Sidebar footer 齿轮
- macOS Application menu 的 `Settings…`

Settings 使用约 780×620 的双栏 overlay 或 secondary window。打开 Settings 时底层 Terminal 保持挂载，不丢失焦点上下文和 PTY。

交互约束：

- Overlay 打开后背景内容 inert，并把焦点移入 Settings。
- `Esc` 关闭，关闭后焦点返回原触发点。
- 窄窗口切为单栏分类导航，不出现横向滚动。
- 保存、测试连接和危险操作都有 pending / success / error 状态。
- 表单失败后保留用户输入；删除、Reset 和 Purge 必须二次确认。

齿轮的 quick menu 只保留：

- Settings…
- Keyboard Shortcuts
- Diagnostics
- Check for Updates

不在 quick menu 内堆叠具体配置。

### 5.2 工作台与 Settings 的职责边界

| 能力 | 工作台保留 | Settings 管理 |
|---|---|---|
| Host | 在线状态、当前 Host、快速重连 | 添加、编辑、测试、删除、SSH 参数 |
| Mobile Relay | Connected / reconnect 状态 | Relay URL、Broker、Host ID、Token |
| Feishu | 当前 worktree 的 Bind / Pause / Unbind | Bot 授权、默认转发规则、全部 bindings |
| Agent | 当前 agent 和运行状态 | 默认命令、agent adapters/probes、自定义能力 |
| Appearance | Inspector 展开/收起 | Dashboard 主题、Terminal 主题、字体、密度、减少动效 |
| History | 当前会话导出 | 是否记录、保留规则、批量清理、Purge all |
| Automation | Run / Pause 当前项 | 默认策略、调度行为、历史保留 |
| Layout | Split、Inspector 开关 | 恢复默认布局、启动恢复行为 |

### 5.3 Settings 分类

#### General

- 启动时恢复上次 workspace
- 默认 worktree root
- 默认新 worktree agent command
- 新窗口/新 Terminal 行为
- 启动时是否检查更新

#### Appearance

- Dashboard product theme
- Terminal theme（保留现有 palettes）
- Terminal font family / size / line height
- UI density
- Reduce motion

#### Connections

- Local runtime 状态
- SSH Hosts 列表
- Add / Edit / Test / Remove Host
- HostName、User、Port、IdentityFile、worktreeBase、tmuxPath、twPath
- Mobile Relay 状态和配置
- 配置失败、授权失败和重连诊断
- Secret/token 默认遮罩，不进入普通日志或 diagnostics copy；任何 reveal/copy 都必须由用户显式触发
- 第一阶段保持现有存储兼容，但在 Feishu 落地前单独评审 Keychain/Stronghold 等安全存储迁移

删除 Host 前必须说明受影响的 remote sessions；不能静默删除。

#### Integrations

- Feishu bot 授权状态
- 重新授权
- 默认仅 `@mention` 转发
- 是否携带引用上下文
- 是否发送结构化卡片
- 全部 chat ↔ worktree bindings

当前 worktree 的绑定动作仍在 Inspector/`⌘K`，不要求用户进入 Settings 才能绑定。

#### Agents

- 默认 `aiCmd`
- 已识别 agent adapters/probes
- capability 预览
- 自定义 probe 规则
- interrupt 和 prompt framing 设置

#### History & Privacy

- 默认关闭持久化
- 开启时说明保存位置和内容范围
- 按 worktree / 时间范围查看和删除
- Export
- Purge all
- 不上传、不 telemetry 的明确说明

#### Automation

- 默认 overlap 策略
- 本地时区和 schedule 行为
- run history 保留数量
- Dashboard 关闭时 schedule 不运行的提示

#### Advanced

- 数据文件位置
- 打开日志/诊断目录
- Reset layout
- Reset UI preferences
- Update channel
- Copy diagnostics

---

## 6. `⌘K` 命令面板

命令面板是动作和导航入口，不是 Settings 的复制品。

分组：

- Actions：New worktree、New terminal、Bind Feishu、Rename、Close、Interrupt
- Navigate：切换 worktree/terminal、打开 Inspector tab
- Run Automation
- Recent
- Settings links：只提供少数 deep link，例如 `Manage Hosts…`

交互要求：

- 支持键盘全程操作和清晰焦点。
- 危险动作进入确认流程，不能在命令面板中一击删除。
- 结果随上下文过滤；不可用动作要隐藏或说明原因。

---

## 7. 状态与恢复矩阵

线框只定义了 happy path，实现必须覆盖以下状态：

| Domain | 必须覆盖的状态 | 恢复入口 |
|---|---|---|
| App / Lists | initial loading、empty、search no results、refresh failed | Retry、clear search、打开 Settings/Diagnostics |
| SSH Host | connecting、connected、degraded、offline、auth required、reconnecting | Quick reconnect、Test Host、deep-link Connections |
| Mobile Relay | stopped、starting、connected、retrying、token invalid、broker unavailable | Retry、Stop、Open Connections |
| Terminal / Agent | attaching、ready、running、waiting input、cancelled、crashed、detached、reconnecting、history loading | Reattach、Interrupt、Open raw Terminal、Copy diagnostics |
| Git | loading、clean、dirty、non-git repo、large diff、command failed | Refresh、expand view、copy error |
| Files | loading、empty、permission denied、remote slow、remote offline、save conflict | Retry、reconnect Host、reload/keep local edit |
| Automation | idle、queued、running、skipped、failed、paused | Run again、open run log、edit settings |
| Inspector | no workspace、unsupported capability、loading、error | Select workspace、expand view、retry |
| Settings | dirty、saving、testing、saved、failed、destructive confirmation | Preserve draft、retry、cancel |
| Command Palette | empty query、no results、running action、action failed | Clear query、retry、open diagnostics |

统一反馈原则：

- 当前任务错误就近显示；全局连接错误同时汇总到 Connections footer。
- 失败状态必须说明“发生了什么”和“下一步能做什么”。
- 可重试操作不能清空输入、选择或当前 workspace。
- 连接、Automation 和后台任务状态变化通过可访问 live region 通知，但避免重复播报。
- 破坏性操作优先提供安全确认；能撤销的操作显示短时 Undo。

---

## 8. 视觉与可访问性基线

### 8.1 Product Shell tokens

- 主背景：近黑，不使用大面积高饱和渐变。
- Surface：通过 3 个层级表达 sidebar、workspace、floating panel。
- Accent：单一蓝色用于选中、主按钮和焦点。
- Terminal palette：由用户主题控制，不强制跟随 product accent。
- 默认正文字号不低于 13px；辅助信息原则上不低于 11px。
- 状态使用图标/文字/颜色的组合，禁止只靠红黄绿。

### 8.2 交互细节

- Tab/Inspector 过渡 120–180ms。
- Command Palette 进入 180–220ms。
- 遵守 Reduce Motion，关闭 scale/translate 动效。
- 所有可点击控件必须有 hover、focus-visible、active、disabled 状态。
- 使用统一图标库，不新增 emoji、手写 inline SVG 或 CSS 图形冒充产品图标。

### 8.3 可访问性

- `⌘,`、`⌘K`、Esc、Tab、Shift+Tab、方向键可用。
- Modal/Palette 有 focus trap，关闭后返回原触发点。
- VoiceOver label 覆盖 icon-only control。
- 文字缩放后不裁剪关键操作。
- 以 WCAG 2.2 AA 为目标：正文对比度至少 4.5:1，非文字控件和焦点至少 3:1。
- Panel resize handle 使用可键盘调节的 separator 语义。
- xterm accessibility mode、VoiceOver reading order 和高对比场景进入真实验证清单。
- 对比度、状态文本和错误信息通过视觉 QA 检查。

---

## 9. 前端架构计划

### 9.1 平台接口层

先建立 renderer 可依赖的 `DashboardBackend` 接口，隔离直接的 `invoke()` 和 Tauri event：

```text
app/src/platform/
├── types.ts
├── dashboardBackend.ts
└── tauriBackend.ts
```

接口按 domain 分组：

- sessions
- terminals / pty
- projects / worktrees
- hosts
- git
- files
- automations
- relay
- layout / preferences

第一阶段不要求把 Rust 逻辑搬到 Node；只是让 UI 不再到处直接依赖 Tauri。

平台边界的硬性验收：

- 除 `platform/tauriBackend.ts` 外，Dashboard UI 和 domain hooks 不得直接 import `@tauri-apps/api/*`。
- 提供 `FakeDashboardBackend`，用于 component tests、状态矩阵和视觉预览。
- Tauri adapter 与 fake adapter 共享 contract tests，覆盖 payload、error 和 event unsubscribe。
- PTY facade 必须保持“生成/取得 id → 先订阅 output/exit → 再 open”的顺序，避免丢失早期事件。
- 保留 300 行 history preload、已打开 Terminal hidden-mounted、本地断线重连、remote 不循环重连和 Host identity。

### 9.2 React 边界

目标目录：

```text
app/src/dashboard/
├── DashboardShell.tsx
├── DashboardSidebar.tsx
├── WorkspaceHeader.tsx
├── WorkspaceView.tsx
├── Inspector.tsx
├── CommandPalette.tsx
├── Settings/
│   ├── SettingsDialog.tsx
│   ├── GeneralSettings.tsx
│   ├── AppearanceSettings.tsx
│   ├── ConnectionsSettings.tsx
│   ├── IntegrationsSettings.tsx
│   ├── AgentsSettings.tsx
│   ├── HistorySettings.tsx
│   ├── AutomationSettings.tsx
│   └── AdvancedSettings.tsx
├── hooks/
│   ├── useDashboardData.ts
│   ├── useWorkspaceSelection.ts
│   ├── useLayoutPreferences.ts
│   └── useCommandPalette.ts
└── design/
    └── tokens.css
```

现有组件优先复用：

- `Terminal.tsx`
- `FileTree.tsx`
- `FileEditor.tsx`
- `GitStatusPanel.tsx`
- `DiffViewer.tsx`
- `AutomationPanel.tsx`
- `NewWorktreeModal.tsx`
- `NewTerminalModal.tsx`
- `AddHostModal.tsx`

### 9.3 状态原则

- 后端数据、UI selection、layout preference、modal state 分开管理。
- 不因切 tab 或收起 Inspector 卸载已打开 Terminal。
- Host/Relay/Git 轮询由 domain hook 管理，不由 presentational component 随意创建 interval。
- layout persistence 使用版本化 schema，并提供旧字段迁移。
- Theme 与 xterm/tmux 的同步事件继续保留。
- 不可见窗口和后台 tab 降低轮询频率；同一 domain 的前一次请求未完成时不得启动重叠请求。

---

## 10. 后端与数据计划

### 10.1 第一阶段

- 保持 `app/src-tauri/src/lib.rs` command payload 和行为兼容。
- 不新增 UDS，不迁移 Electron。
- 必要时增加小型聚合 command/event，减少 renderer polling，但不大规模搬迁代码。
- 保持本地与 SSH 的 cwd、Git、file、PTY 语义一致。
- 新增事务化 `update_host`（或语义等价的显式 update API）；不能用会拒绝重复 ID 的 `add_host` 冒充编辑。
- Hosts 和 Mobile Relay 继续以 CLI 共享的 `~/.tmux-worktree.json` 为事实来源；Dashboard-only UI preferences 使用独立、版本化文件。
- Secret/token 禁止写入 localStorage、普通日志、前端 diagnostics 或错误上报。
- 配置和迁移写入采用同目录临时文件 + fsync/close + atomic rename；首次迁移创建 backup，并通过重复执行验证幂等。

### 10.2 Agent adapter（后续阶段）

所有 agent 至少支持 raw terminal fallback；结构化能力按 adapter 声明：

```ts
type AgentCapabilities = {
  structuredEvents: boolean;
  sendPrompt: boolean;
  interrupt: boolean;
  modelInfo: boolean;
  toolCalls: boolean;
};
```

只有 `structuredEvents=true` 时才展示 Chat timeline 和结构化 tool-call。正则解析 tmux scrollback 只能作为 best-effort preview，不能作为唯一事实来源。

### 10.3 历史

- Canonical format：`~/.tw-history/<workspace-id>/<conversation-id>.jsonl`
- Append-only event
- 默认关闭
- 单条、单会话、按 worktree/时间范围和全量删除
- Feishu 来源附带 `chatId`、sender 和 adapter metadata
- 不使用 `better-sqlite3`，除非后续基准证明 JSONL 无法满足索引需求并重新评审

### 10.4 Feishu

实现前先冻结：

- auth ownership
- binding schema
- message idempotency key
- retry/backoff
- redaction rules
- audit log
- terminal output boundary
- group member/permission change handling

绑定流程：选择 chat → 确认 worktree/terminal 和规则 → round-trip test → 成功后显示 Inspector 状态。

---

## 11. 分阶段实施

### Phase 0 — 计划与基线（本阶段）

交付：

- 本最终计划
- 当前分支建立远端 tracking
- 记录当前 build/test 基线
- 建立可复现依赖 bootstrap，检查 root/app lockfile 元数据与 package version 是否一致

验收：

- 计划覆盖产品、Settings、架构、迁移、QA 和 Git 流程。
- 不修改 Dashboard 运行代码。
- 不把当前环境误报为全绿：本 worktree 目前尚未安装 root/app `node_modules`，root 也没有 lockfile；实现开始时先记录安装前状态并确定 lockfile 策略。
- 验证顺序固定为：root install/build 生成 `dist/*` → app install/build/tests → `cargo fmt --check` / `cargo check` / `cargo test`。Tauri resource 依赖 `dist/*`，不能跳过 root build 直接解释 Cargo 失败。

### Phase 1 — 平台边界与组件拆分

预计：2–4 个工作日。

交付：

- `DashboardBackend` + `tauriBackend`
- `FakeDashboardBackend` + adapter contract tests
- 共享 domain types
- 从 `App.tsx` 提取数据 hooks 和主要 presentational shell
- 保持现有布局与功能不变

验收：

- TypeScript build 通过。
- 现有前端测试通过。
- Rust tests 通过相关 command 覆盖。
- 除 `platform/tauriBackend.ts` 外，Dashboard UI 不再直接 import Tauri API。
- 切换 session/terminal 不产生额外 PTY 重连。
- layout、theme、remote context、Mobile Relay 无回归。

### Phase 2 — 新 Shell + Settings + Command Palette

预计：4–7 个工作日。

交付：

- 统一 Sidebar
- Workspace Header + Terminal-first 主视图
- 可折叠 Inspector
- `⌘K` Command Palette
- `⌘,` Settings
- Host / Relay 配置迁入 Connections
- responsive layout

验收：

- 本地和 SSH worktree 都能选择、attach、切换。
- New worktree、New terminal、Automation、Git、File、Diff 核心流程可达。
- Settings 能查看、添加、测试、编辑和删除 Host。
- Relay 状态工作台可见，详细参数只在 Settings。
- 960、1100、1440、1600px 四档无关键操作裁剪或 app-level 横向滚动。
- 键盘导航、focus return 和 Reduce Motion 可用。

### Phase 3 — Dogfood 与运行时决策门

持续：至少 5 个真实工作日。

基准方法：

- 在同一台 Mac、相同电源模式和相同 release/dev 构建类型下做前后对比，并记录机器/OS/WebKit/commit。
- 固定参考数据集：20 个 local worktrees、5 个 remote worktrees、10 个 terminals、10 个 automations、每个 session 300 行 preload，以及一个 10k-line diff。
- 每项至少运行 3 轮，报告 p50/p95；远端 attach 单独记录网络 RTT，不能和本地混算。

记录与预算：

- 冷启动到可交互：不得劣于 Phase 0 baseline 10% 以上。
- 已挂载 Terminal 切换：p95 目标 `<=100ms`，并且不能触发 PTY reopen。
- fresh local attach：p95 目标 `<=1.5s`；remote attach 以扣除 RTT 后不劣于 baseline 10% 为门。
- Terminal 输入到可见 echo：p95 目标 `<=50ms`。
- 10k-line diff：首次可交互目标 `<=1s`，滚动期间没有持续 long task 或明显输入阻塞。
- idle CPU：不得高于 baseline，目标 `<3%`；idle memory 不得高于 baseline 15%。
- 连续 100 次 workspace 切换后：不存在遗留 PTY/listener，稳定内存增长目标 `<10%`。
- polling：同一请求不重叠；窗口不可见时降频；记录 command 次数、p95 和失败率。
- SSH 断开/恢复：不会无限重连或清空当前选择，并给出可操作状态。

Electron spike 只在以下条件同时满足时启动：

1. 新组件和数据流完成后仍有可复现卡顿。
2. Profile 指向 WebKit/CSS/rendering，而非 Rust command、SSH、Git 或 React 更新。
3. Chromium 对目标问题有可验证改善。
4. 已估算移植当前 Tauri commands 的真实成本。

Electron spike 必须复用同一 renderer、同一数据集做 A/B，并完成代表性 parity slice：PTY stream、SSH attach、remote file read/write、Git diff、Relay lifecycle、bundled CLI resource、签名和 packaged launch。只完成静态列表页不算有效 spike。

若未来引入 UDS，需另行冻结 protocol version、消息 framing、event/backpressure、socket `0600` 权限、daemon ownership 和退出清理；不能再以一次 `nc -U` 响应作为完整验收。

若不满足，继续 Tauri；若满足，单独建立 runtime migration 计划，不与功能开发混在同一提交中。

### Phase 4 — Agent conversation capability

交付：

- agent adapter/probe schema
- raw terminal fallback
- structured `ConversationEvent`
- composer send/cancel target
- 本地 JSONL history 和完整管理
- 只有支持的 agent 显示 Chat/tool-call

### Phase 5 — Feishu integration

交付：

- Settings 授权与默认规则
- Inspector 当前绑定
- `⌘K` Bind action
- 3-step bind flow
- round-trip test
- pause/unbind/re-auth/error states
- privacy warning、audit、retry、dedupe

### Phase 6 — Release 与主分支合并

进入条件：

- Phase 1–5 的约定目标完成，或用户明确冻结更小 release scope。
- build、tests、视觉 QA、关键真实流程全部通过。
- layout 和用户配置迁移验证完成。
- 当前分支已 push，提交历史可审阅。

之后再单独执行：

1. 同步最新 `origin/master`。
2. 解决冲突并重跑验收。
3. 经用户确认后合并到 `master`。
4. 合并后再做版本、DMG 和发布流程。

---

## 12. 数据与布局迁移

现有数据文件必须保留：

- `~/.tmux-worktree.json`
- `~/.tmux-worktree/state.json`
- `~/.tw-dashboard-layout.json`
- `~/.tw-dashboard-terminals.json`
- `~/.tw-dashboard-automations.json`
- `~/.tw-dashboard-automation-runs.json`

新增布局 schema 示例：

```json
{
  "schemaVersion": 2,
  "sidebar": { "width": 280, "collapsed": false },
  "inspector": { "width": 420, "open": true, "tab": "git" },
  "workspace": { "mode": "terminal", "split": null },
  "selection": { "kind": "session", "id": "..." },
  "window": { "width": 1440, "height": 900 }
}
```

迁移规则：

- 第一次读取旧 layout 时创建内存中的 v2 结构。
- 写回前备份旧文件为带 schema/version 的 backup；v2 启动失败时允许回滚读取 v1。
- 旧 `{kind: "session", name}` selection 通过当前 session composite key 映射为稳定 workspace id；terminal/automation 使用对应既有 id。
- selection 指向已删除 session、terminal、automation 或未知 Host 时，回退到第一个可用本地 workspace；没有可用项时进入明确空态。
- 旧 `file/main/scratch/editor` column order 不直接复刻；映射为 Inspector、expanded content 和 split 状态。
- 不能恢复的旧字段忽略但不导致启动失败。
- 迁移写入使用临时文件 + atomic rename，连续运行两次得到相同结果。
- 提供 Advanced → Reset layout。

---

## 13. 验证与 QA

### 13.1 自动化验证

- `npm run build`
- root CLI tests
- app TypeScript tests
- Rust unit/integration tests
- layout migration tests
- keyboard command tests
- Settings/Host/Relay contract tests
- Terminal lazy mount/reconnect regression tests
- Fake backend 驱动的 component behavior tests，不把源码 regex 断言当作主要行为验证
- Tauri adapter payload / event ordering / unsubscribe tests
- Vite + fake backend 的关键 UI e2e
- isolated HOME 的 packaged-app smoke test，验证真实资源路径和用户数据隔离

### 13.2 真实流程

至少验证：

1. 本地 worktree 创建、attach、切换、关闭。
2. SSH Host 添加、测试、remote worktree 创建、attach、断线恢复。
3. 独立 Terminal 创建、重命名、切换、关闭。
4. Git status/log/diff。
5. 本地与 remote 文件读取/编辑。
6. Automation 新建、Run、Pause、删除、history。
7. Mobile Relay 查看、配置、启动、停止、重连。
8. layout、window、theme 重启恢复。

### 13.3 视觉 QA

每个实现阶段都对照目标线框和实际截图，检查：

- typography
- spacing/layout rhythm
- colors/tokens
- icons/assets
- copy/content
- responsive states
- keyboard/focus/accessibility

P0/P1/P2 问题修复后才能完成阶段；P3 可记录为后续 polish。

---

## 14. 风险与缓解

| 风险 | 缓解 |
|---|---|
| `App.tsx` 拆分导致行为回归 | 先建立 adapter/hooks，再换视觉；每个 slice 保持可运行 |
| Terminal 切换重连 | 保持 opened terminal 稳定挂载，增加回归测试 |
| 远端与本地能力不对称 | 由 capability/status 显示，不假装功能可用 |
| Inspector 太窄 | 支持 Expand to workspace；窄窗口改抽屉 |
| Settings 变成杂物间 | 严格执行“全局配置 vs 当前动作”边界 |
| 主题重构破坏 xterm/tmux | product shell 与 Terminal palette 解耦，保留 theme event |
| Chat 解析任意 TUI 不可靠 | Terminal-first；只有 structured adapter 才开启 Chat |
| Feishu 泄露 terminal 内容 | 默认仅 @mention、明确 warning、redaction、audit、pause/kill switch |
| Electron 再次成为主观争论 | 以 dogfood profile 和 spike 结果作为唯一决策依据 |
| 长分支偏离 master | 阶段性 push；合并前再同步并完整回归 |

---

## 15. Git 工作流

### 当前阶段

- 工作分支：`tmux-worktree-app-re-ddf7c`
- 远端目标：`origin/tmux-worktree-app-re-ddf7c`
- 当前本地分支初始 upstream 是 `origin/master`；首次发布必须显式执行 `git push -u origin HEAD:refs/heads/tmux-worktree-app-re-ddf7c`，随后验证 upstream 已切到同名远端分支
- upstream 修正前禁止裸 `git push`，全程禁止 `HEAD:master`
- 禁止直接 push `master`
- 禁止在未完成/未验收时合并 `master`

### 提交原则

- 每个 Phase 使用可独立构建和审阅的小提交。
- 计划、重构、视觉、功能、迁移、测试尽量分开提交。
- 不混入版本 bump、release asset 或无关清理。
- 每个阶段结束后 push 当前分支并记录验证结果。

### 合并原则

- 只有全部约定工作完成或用户明确缩小 release scope 后，才准备合并。
- 合并前同步最新 `origin/master` 并重新跑完整验证。
- 合并动作需要单独确认，不把“push 工作分支”视为自动授权合并。

---

## 16. Definition of Done

Dashboard v2 达到完成状态需要：

- 新三栏 IA、Settings、Command Palette 和响应式行为落地。
- 现有本地/SSH/Terminal/Git/File/Automation/Relay 核心能力无回归。
- Host 等低频配置从主工作区移入 Settings，同时状态和恢复动作仍易发现。
- Terminal-first 工作流稳定；没有伪造不可用的 Chat/model 能力。
- 数据和布局迁移安全。
- 自动化测试、真实流程验证和视觉 QA 通过。
- dogfood 结论记录完成，运行时选择有证据。
- 所有工作已提交并 push 当前分支。
- 用户确认后才合并 `master`。
