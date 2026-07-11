# tw-dashboard v2 最终重构计划

> 状态：Dashboard replacement 与 Android V2 客户端已完成并合入 `master`；Relay v2 Android-first contract 已冻结但尚未实现。下一阶段聚焦 SSH 连接稳定性，Phase 4/5 保留为后续能力
>
> 日期：2026-07-11
>
> 已交付分支：`tmux-worktree-app-re-ddf7c`、`tmux-worktree-apk-re-5f44d`（均已按用户授权合入 `master`）
>
> 当前实现基线：`master@ac82272`（Files 常驻 + CodeMirror 编辑器 + Git Graph + CLI/RPC/runtime parity + Compose Android V2 UI + 安全 Relay v1 pairing/backpressure + 旧 Dashboard/Android UI 清理）
>
> 当前验收态：release Tauri bundle 已 ad-hoc 签名并完成真实 worktree/terminal/Host smoke；Android debug/release build、lint 和 API 36 instrumentation 通过。最终门禁为 root CLI 38/38、Dashboard 334/334、Rust 70/70、Android JVM 59/59、Android instrumentation 34/34。release APK 尚未生产签名。
>
> 目标：把现有 Dashboard 从“可自由拆分的终端工具集合”重组为“以 worktree / agent session 为中心的 macOS 工作台”，同时保留现有 Tauri 后端、tmux、SSH、Git、文件、Automation 和 Mobile Relay 能力。

本文档是 Dashboard v2 的实施基线，替代 `~/Desktop/plan-a-tw-dashboard-redesign/PLAN.md` 中与当前仓库不一致的技术路线。后续实现、验收和合并均以本文档为准。

---

## 1. 已冻结的核心决策

1. **实现和日常调试继续使用 Tauri v2 + React。** 当前仓库没有 Electron runtime；新版 renderer 已替换本机旧 Tauri app 进入真实 dogfood，不在功能开发中并行重写 Rust 后端。
2. **接近功能完成时再冻结最终运行时。** 先完成 IA、组件边界和真实交互；收口前基于同一 renderer、同一数据集和真实性能结果决定继续 Tauri，还是做 Electron parity spike。
3. **Terminal-first，不伪造 Chat。** 当前任意 `aiCmd` 只保证 tmux/PTY 输出，不保证结构化 agent event；在正式 agent adapter 完成前，中间主视图以 Terminal 为核心。
4. **三个物理区、四个清晰职责。** 左侧 Sidebar 在 `Workspaces / Files` 两个同级视图间切换，中间承载 Terminal / Editor / Diff，右侧只承载 Git；Files 不再作为 Git 或通用 Inspector 的子 tab。
5. **Settings 收纳低频、全局配置。** Host、Relay 参数、主题、agent probes、历史与隐私等进入 `⌘,` Settings；连接状态和当前 worktree 动作仍留在工作台。
6. **Feishu 是一等集成，但不是第一阶段阻塞项。** 全局授权和默认规则进入 Settings；能力实现前不在 Git 面板伪装占位，未来当前 worktree 的 Bind / Pause / Unbind 使用独立上下文入口和 `⌘K`。
7. **保留自由 `aiCmd`。** 不把 agent 类型收敛成枚举；后续通过可扩展 adapter/probe 描述能力。
8. **历史完全本地、默认关闭。** 后续会话历史以 append-only JSONL 为唯一基线，不引入云同步或 telemetry。
9. **产品外壳与终端主题解耦。** Dashboard 采用统一的深色产品主题；现有终端主题、字体和 tmux palette 继续保留。
10. **重构阶段保持分支隔离，验收后再合并。** Dashboard 与 Android 分别在对应工作分支完成、push 和验收；用户明确授权后已 fast-forward 合入 `master`。后续 SSH/Relay 实现继续使用从最新 `master` 创建的独立任务分支。
11. **CLI 与 Dashboard 只允许一种新 session contract。** `tw`、本地 Dashboard 和远端 Dashboard 都委托 `tw rpc create-worktree` 的 single-pane 核心；`profile` 只记录来源。停止创建旧三 pane/status TUI 格式，但继续兼容已有 session 的发现和 attach。
12. **Files、Git、Diff 是同一 workspace 的三种不同职责。** Files 是可常驻的导航上下文；Git 是可折叠的 source-control 面板；Diff 是从 Git drill down 到中间主内容的阅读视图。切换这些能力不能卸载文件树或已打开 PTY。
13. **中间不展开 Git。** 中间主内容只在 tmux Terminal、真实文件 Editor 和 Diff 之间切换；Git status/log/branch graph 固定留在右栏或响应式 drawer。编辑器继续使用 CodeMirror 6，并以不重建状态为前提补齐主题、查找、跳行、折叠、缩进、定位和状态栏。

---

## 2. 为什么不直接重写 Electron

原方案中“Electron main process 直接复用 `dist/*.js`、后端基本不改”的前提与当前仓库不一致：

- Dashboard 前端根组件 `app/src/App.tsx` 仍是约 2580 行的 orchestration root，但平台调用已集中到 typed backend boundary；业务 UI 不再散落直接依赖 Tauri API。
- 完整 Dashboard 后端位于约 10.4k 行的 `app/src-tauri/src/lib.rs`，包含 PTY、Git、文件、SSH、Host、Automation、布局、Mobile Relay 等 68 个 Tauri command；前端 invoke 与注册 command 为 68/68。
- Node 侧 `src/rpc.ts` 不是常驻 IPC/daemon，而是 `tw rpc` 的一次性 stdout CLI；实际 subcommand 只有 `list`、`capabilities`、`create-worktree`。`managed-state` 只是 capability 名，不是独立可调用 subcommand，远不能替代 Tauri command 层。

因此现在切 Electron 会同时引入 UI 重构、后端迁移、native module 打包、签名与升级四类风险，无法隔离问题来源。

最终策略：

1. 当前 renderer、平台接口层和新 Shell 继续在 Tauri 内完成并调试。
2. 用同一构建替换本机 `/Applications/tw-dashboard.app`，记录启动、渲染、Terminal、Files、Git、Diff 和轮询数据。
3. 接近功能完成时再执行 runtime decision；只有 Chromium 对已定位问题有可验证收益时才进入 Electron parity spike。
4. Electron 若进入评估，必须复用现有 renderer 和后端契约；运行时切换不得和剩余功能修改混在同一提交中。

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
│ product titlebar: icon + tmux-worktree | workspace | Files Git Scratch │
├───────────────┬──────────────────────────────────┬─────────────────────┤
│ Sidebar       │ Workspace                        │ Git panel           │
│               │                                  │                     │
│ Workspaces    │ Terminal                         │ Status / changed    │
│    or         │ File editor                      │ files               │
│ Files         │ Git diff                         │ Git log             │
│               │ Automation manager               │                     │
│ Settings      │ Optional future: Chat            │                     │
├───────────────┴──────────────────────────────────┴─────────────────────┤
│ Optional command palette / modal / settings overlay                    │
└────────────────────────────────────────────────────────────────────────┘
```

这仍是三列物理布局，但左列包含两个互斥且同级的持久视图。Files 不是第四个常驻外栏，也不属于 Git；这样在 960px 原生最小宽度下仍能同时保留 FileTree 和至少 640px Workspace。

### 4.2 左侧 Sidebar

默认宽度 280px，可在 240–360px 的安全范围内调整。顶部是同级 `Workspaces / Files` tabs；两个 view 保持 React mounted，非活动 view 使用 `hidden + inert`，因此切去 Git、编辑文件或暂时返回 Workspaces 时不会丢掉 FileTree 的展开、搜索和滚动上下文。

`Workspaces` 从上到下：

1. `New worktree` 主按钮。
2. 搜索入口；搜索 session/file，`⌘K` 进入全局命令面板。
3. `Pinned`：用户主动 pin 的 worktree/terminal。
4. `Worktrees`：按 `Host + Project` 分组，支持折叠。
5. `Terminals`：独立 tmux terminal。
6. `Automations`：默认收起，只保留数量、快速列表开关和 `Manage`；管理进入带返回路径的二级主页面。

`Files`：

- 根目录始终跟随当前 worktree / terminal / automation 上下文。
- 本地与 SSH 文件使用同一棵树；remote 暂不支持搜索时显示真实能力提示。
- 点击文件只切换中间 Editor，不关闭 FileTree。
- 选择 Workspaces、再次返回 Files、打开/关闭 Git 后，树仍保持挂载。

两种 view 共用单一 `Settings` footer，同时显示本地、SSH Host、Mobile Relay 汇总状态；不再并列两个都进入 Settings 的按钮。

列表状态不能只靠颜色点表达，至少同时提供可读文本或 tooltip：

- Running
- Waiting / Idle
- Stopped
- Unknown
- SSH offline
- Reconnecting

### 4.3 中间 Workspace

#### Merged titlebar

唯一顶栏分成三段：

- 左侧：现有产品 icon + `tmux-worktree` 产品名。
- 中间：当前 worktree / terminal / file 名称、运行状态、branch 和 Host 的轻量单行 breadcrumb；完整 project/cwd 保留在 tooltip。
- 右侧：`Files`、`Git`、`Scratch` 三个同级动作。

窗口最上方 titlebar 承担唯一 workspace header 的职责；正常 session 不再额外渲染 WorkspaceHeader + Terminal pane bar。当前动作语义：

- Files：切换左栏到 Files 并保持其常驻；在 Git 为 modal drawer 时先关闭 Git 以真正露出文件树。
- Git：只打开右侧 Git panel，不再召回一个包含 Files/Diff/Feishu 的通用 Inspector。
- Scratch：打开真实 split；空间不足时与 Git panel 互斥，避免挤压主内容。
- compact 窗口的 Sidebar 召回

顶栏不显示无法解释或无法兑现的 Codex chip、模型选择器和 Share。

#### 主内容

以 Terminal 为默认主视图，并保留当前能力：

- tmux attach
- 本地和 SSH PTY
- history snapshot
- resize
- copy/paste 和 copy mode
- link/file detection
- 选项切换时保持已打开 Terminal 挂载，避免重连和历史丢失

中间 Workspace 同时负责：

- 从 Files 选择普通文件后显示 `FileEditor`；保存、Markdown preview、图片、本地/remote 读写和 unsaved guard 保持有效。
- `FileEditor` 使用 CodeMirror 6 的产品级运行时主题，支持语法高亮、活动行/行号、代码折叠、缩进导线、括号匹配、查找、跳行、自动换行和 Markdown preview。
- 单文件 tab、breadcrumb 和状态栏显示当前光标、缩进、编码、换行符、语言及 Local/Remote；420px 下优先保留光标、语言和连接状态。
- 保存、主题切换、换行切换和同文件定位均通过 transaction/reconfigure 完成，不重建编辑器，因此保留 undo、cursor 和 scroll。重复打开同一文件同一行仍会重新定位；line-only 跳转不会沿用旧 column。
- 从 Git changed files 选择文件后显示 `DiffViewer`；右侧 Git changed list 在 wide 布局继续保留。
- 关闭 Editor 或 Diff 后回到原 Terminal，Terminal 组件不卸载。
- Automation `Manage` 使用带明确 `Back to workspace` 的二级主页面。

不再保留 Files / Git / Diff 的通用 expanded-panel state；每种能力只有一个明确归属。

### 4.4 右侧 Git Panel

默认宽度 400–440px，可折叠。

规则：

- 右栏只显示当前 workspace 的 Git status、changed files 和 log，不再显示 Files、Diff 或 Feishu tabs。
- Log 使用真实 commit parent 拓扑绘制 lane/edge；merge 使用菱形节点和文字标识，不能只靠颜色区分。
- 支持 `HEAD / Current / All` 三种 scope。Current 隐式包含 current branch + upstream；用户可搜索并添加其他 canonical ref 观察交叉状态。
- Add comparison branch 不重复提供当前分支或 Current 已隐式包含的 upstream；切到 All 时清空并隐藏无效 comparison controls。
- 后端只接受 `for-each-ref` catalog 返回的完整 ref 名，并用 catalog snapshot OID 调用 `git log`；ref 名不直接进入 revision argv。
- All 仅包含 HEAD、local/remote branches 和 commit tags，不把 `refs/stash`、`refs/pull/*` 等内部 refs 混入产品语义。
- Git 人类可编辑字段采用固定 7 段 NUL 协议，subject/author 中的控制字符不会破坏解析；默认 160 条，可继续加载到 2,000 条并明确显示截断。
- 点击 changed file 后 Diff 在中间打开；wide 布局下 Git 列表继续可见。
- 关闭 Git panel 后停止 4 秒轮询和远程 SSH Git 请求；保留现有结果供再次打开时快速恢复。
- Automation 不进入 Git panel；统一进入 Sidebar `Manage` 的二级管理页。
- Feishu 能力实现后使用独立上下文入口；未实现前只在 Integrations Settings 中说明，不伪装成 Git 子功能。

### 4.5 响应式行为

| 窗口宽度 | 布局 |
|---|---|
| `>= 1440px` | Sidebar (`Workspaces / Files`) + Workspace + Git panel 三栏 |
| `960–1439px` | Sidebar + 至少 640px Workspace；Git 作为右侧 modal drawer |
| `< 960px` | 仅用于浏览器/调试预览；Sidebar 与 Git 均退化为可召回抽屉 |

补充规则：

- Workspace 的有效宽度不得小于 640px。
- 960–1439px 时 Sidebar 宽度动态限制为 `viewport - 640px`；resize separator 的可访问范围必须报告同一真实上限。
- Files view 在全部原生支持宽度内保持 docked，并可与 Editor 同时显示；只有小于 960px 的非产品调试宽度才使用 drawer。
- 在 960–1439px 从 Git drawer 点 Files，先关闭 Git drawer 和 backdrop，再显示 Files。
- 顶栏空间不足时优先隐藏 breadcrumb 的 Host / status copy 和动作文字，不允许挤掉产品名或主操作。
- 不使用固定 820px composer 或固定 452px Git panel。
- Split Terminal 仅在有足够空间时并排，否则上下分屏。
- Sidebar/Git resize、折叠或窗口缩放后必须触发 xterm fit。
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

左下角只保留一个带连接状态摘要的 Settings 入口，直接进入完整 Settings；不再并列 Connections 与齿轮，也不增加第二层 quick menu。

### 5.2 工作台与 Settings 的职责边界

| 能力 | 工作台保留 | Settings 管理 |
|---|---|---|
| Host | 在线状态、当前 Host、快速重连 | 添加、编辑、测试、删除、SSH 参数 |
| Mobile Relay | Connected / reconnect 状态 | Relay URL、Broker、Host ID、Token |
| Feishu | 当前 worktree 的 Bind / Pause / Unbind | Bot 授权、默认转发规则、全部 bindings |
| Agent | 当前 agent 和运行状态 | 默认命令、agent adapters/probes、自定义能力 |
| Appearance | Git/Files/Diff 内容视图、Scratch 开关 | Dashboard 主题、Terminal 主题、字体、密度、减少动效 |
| History | 当前会话导出 | 是否记录、保留规则、批量清理、Purge all |
| Automation | Run / Pause 当前项 | 默认策略、调度行为、历史保留 |
| Layout | Workspaces/Files 切换、Git/Scratch 开关和 resize | 恢复默认布局、启动恢复行为 |

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

当前 worktree 的绑定动作未来使用独立上下文入口/`⌘K`，不要求用户进入 Settings 才能绑定，也不放进 Git panel。

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
- Navigate：切换 worktree/terminal、打开 Files、打开 Git
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
| Files / Git | no workspace、unsupported capability、loading、error | Select workspace、switch view、retry |
| Settings | dirty、saving、testing、saved、failed、destructive confirmation | Preserve draft、retry、cancel |
| Command Palette | empty query、no results、running action、action failed | Clear query、retry、open diagnostics |

统一反馈原则：

- 当前任务错误就近显示；全局连接错误同时汇总到带状态摘要的 Settings footer。
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

- Sidebar view / Git panel 过渡 120–180ms。
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
├── GitPanel.tsx             # Git-only side panel shell
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
- `dashboard/Settings/ConnectionsSettings.tsx`

### 9.3 状态原则

- 后端数据、UI selection、layout preference、modal state 分开管理。
- 不因切 Workspaces/Files、打开/收起 Git 或切换 Editor/Diff 卸载已打开 Terminal 和 FileTree。
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

绑定流程：选择 chat → 确认 worktree/terminal 和规则 → round-trip test → 成功后显示独立 integration context 状态。

---

## 11. 分阶段实施

### Phase 0 — 计划与基线（已完成）

交付：

- 本最终计划
- 当前分支建立远端 tracking
- 记录当前 build/test 基线
- 建立可复现依赖 bootstrap，检查 root/app lockfile 元数据与 package version 是否一致

验收：

- 计划覆盖产品、Settings、架构、迁移、QA 和 Git 流程。
- 验证顺序固定为：root install/build 生成 `dist/*` → app install/build/tests → `cargo fmt --check` / `cargo check` / `cargo test`。Tauri resource 依赖 `dist/*`，不能跳过 root build 直接解释 Cargo 失败。
- 当前依赖已安装并形成可重复验证基线；root CLI 33 项、app 332 项和 Rust 70 项测试通过。

### Phase 1 — 平台边界与组件拆分（当前 release scope 已完成）

预计：2–4 个工作日。

交付：

- `DashboardBackend` + `tauriBackend`
- `FakeDashboardBackend` + adapter contract tests
- 共享 domain types
- 从 `App.tsx` 提取平台、catalog、layout、polling、settings 和主要 presentational shell；剩余 orchestration 继续按后续 slice 拆分
- 保持现有布局与功能不变

验收：

- TypeScript build 通过。
- 现有前端测试通过。
- Rust tests 通过相关 command 覆盖。
- 除 `platform/tauriBackend.ts` 外，Dashboard UI 不再直接 import Tauri API。
- 切换 session/terminal 不产生额外 PTY 重连。
- layout、theme、remote context、Mobile Relay 无回归。

### Phase 2 — 新 Shell + Settings + Command Palette（已完成）

Shell 实现基线：`f0e3849`；编辑器与 Git Graph 在 Phase 2.1 收口。

交付：

- 统一 Sidebar
- Sidebar `Workspaces / Files` 同级持久视图
- Workspace Header + Terminal-first 主视图
- Git-only 可折叠右栏；Diff 在中间打开
- `⌘K` Command Palette
- `⌘,` Settings
- Host / Relay 配置迁入 Connections
- responsive layout
- Agents 固定 allowlist 探测、theme portal、pinned、Automation 二级页和文件编辑布局修复

验收：

- 本地和 SSH worktree 都能选择、attach、切换。
- New worktree、New terminal、Automation、Git、File、Diff 核心流程可达。
- FileTree 与 Editor 可以常驻并存；切 Git / Workspaces 不卸载树。
- Files / Git / Scratch 有独立可发现入口，Git 关闭时停止后台 Git/SSH polling。
- Settings 能查看、添加、测试、编辑和删除 Host。
- Relay 状态工作台可见，详细参数只在 Settings。
- 960、1100、1440、1600px 四档无关键操作裁剪或 app-level 横向滚动。
- 键盘导航、focus return 和 Reduce Motion 可用。

### Phase 2.1 — 可用编辑器 + Git 拓扑（已完成）

实现基线：`8fd148e`。

交付：

- CodeMirror 6 产品主题与语法高亮；主题从 `.tw-shell` 取值，与 Terminal palette 解耦。
- 单真实文件 tab、breadcrumb、Find、Go to line、word wrap、Markdown preview、fold、indent guides、bracket match 和紧凑状态栏。
- 同文件同位置重复跳转、line-only column 清理、本地/remote 保存、unsaved navigation guard 和 compact drawer 行为。
- 基于真实 parent OID 的 Git lane/edge/merge graph，支持 HEAD / Current / All、canonical ref picker、Load more 和 selected commit 摘要。
- Rust local/SSH graph contract、NUL-safe commit records、catalog OID snapshot、internal-ref exclusion、ref allowlist 和 blocking-task isolation。
- 生产 WebKit fake-backend preview，用真实 TypeScript file tree 和 fork/merge fixture 做可重复视觉验证。
- fake backend 的 production demo 入口只接受 `localhost` / `127.0.0.1` 且必须显式带 `?backend=fake`；Tauri 的 `tauri.localhost` 正式运行路径不会进入 preview backend。

验收：

- `app` 332/332 tests、Rust 70/70 tests、root CLI 33/33 tests 通过。
- app/root build、TypeScript test typecheck、`cargo fmt --check`、`cargo check` 和 `git diff --check` 通过。
- 1487×1058 三栏、960×900 Git drawer、420×820 compact editor/drawer 均无 app-level 横向 overflow；branch picker 不被裁剪。
- 生产 WebKit capture 在三档 viewport 均无 JavaScript console error。
- 视觉 QA 报告为根目录 `design-qa.md`，最终结果为 `passed`。
- Git Graph 的 SSH/进程调用放入 `spawn_blocking`，不能阻塞 Tauri async command runtime。

### Phase 3 — Dogfood 与运行时决策门（当前 release scope 已完成）

长期目标：至少 5 个真实工作日；本轮用户已冻结更小的合并 scope，长期性能样本转为合并后的持续 hardening，不阻塞本次主分支交付。

当前状态：核心真实数据 smoke 已完成。当前分支的 release Tauri bundle 能读取既有 worktree、terminal 和 2/2 Host，Files 常驻、CodeMirror 文件打开、Git status/diff panel 和 tmux 主视图均可达。原生 smoke 发现 Git status/diff/fetch discovery 曾在同步 Tauri command 中阻塞 UI，现已统一隔离到 `spawn_blocking` 并加回归门禁。当前仓库仍没有 Electron target；本轮也不引入 Electron migration。

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

若不满足，继续 Tauri；若满足，在接近功能完成时单独建立 runtime migration 计划，不与功能开发混在同一提交中。

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
- 独立 integration context 当前绑定（不进入 Git panel）
- `⌘K` Bind action
- 3-step bind flow
- round-trip test
- pause/unbind/re-auth/error states
- privacy warning、audit、retry、dedupe

### Phase 6 — 主分支合并（已完成）与正式 Release（后续独立执行）

已完成：

- Dashboard replacement、CLI/RPC/runtime parity 和旧 Dashboard 清理已验收并合入 `master`。
- Compose Android V2 UI、Room/Outbox/terminal hardening、安全 Relay v1 pairing 与 bounded FIFO/backpressure 已从 `tmux-worktree-apk-re-5f44d` fast-forward 合入；`master` 基线为 `ac82272`。
- 旧 Java UI/layout/assets 已删除；仅保留一个升级周期所需的 21 行 `MainActivity` compatibility shim。
- Dashboard/Android/CLI/Rust 全套门禁通过，工作分支与远端 `master` 已核对一致。
- [Relay v2 Android-first contract](docs/relay-v2-contract.md) 已经桌面、Android 和独立 reviewer 多轮交叉审计并冻结为实现基线；当前各端仍只宣告 Relay v1。

尚未执行：

- 正式版本号、tag、DMG、npm、GitHub Release 和 production-signed APK。
- Relay v2 broker/host/Android 实现与互操作发布门禁。

主分支合并不等于正式版本发布；release 仍需单独执行签名与发布流程。

### Phase 7 — SSH 连接稳定性（下一阶段）

目标：在不切 Electron、不提前实现 Relay v2 的前提下，先把本地 Dashboard 到 SSH Host 的发现、attach、文件、Git 和 terminal 长连接做成可诊断、可恢复、不会重复副作用的稳定链路。

首轮工作包：

1. 建立统一 SSH connection state machine：idle / connecting / online / degraded / reconnecting / auth-required / offline，消除组件各自重连。
2. 冻结 connect/command/PTY 的 timeout、cancel、keepalive、指数退避+jitter、最大并发和 single-flight；窗口隐藏/睡眠/网络切换后使用同一恢复路径。
3. 把 Host 探测、session discovery、Git/file 请求与 PTY attach 分开隔离；短请求失败不能拖死 terminal，terminal 断线不能清空缓存或伪造 session 删除。
4. 增加可脱敏诊断：阶段耗时、失败分类、最近成功时间、重连 attempt、SSH exit/status；禁止记录 token、私钥、terminal bytes 和敏感 argv。
5. 覆盖故障注入：DNS 慢、握手超时、认证失效、sleep/wake、Wi-Fi 切换、半开 socket、远端 tmux 重启、并发 Git/File/PTY、进程退出和取消竞态。
6. 用本机与至少一个真实远端 Host 做 30–60 分钟 soak；验收无无限重连、无 actor/child process 泄漏、无 UI 主线程阻塞、无 session/cache 误删。

Phase 7 完成后再按 [Relay v2 contract](docs/relay-v2-contract.md) 拆 broker identity/carrier、host ledger/snapshot、Android persistence 和 terminal resume 四个可独立验收的实现 slice；任一 slice 未通过 contract §10 前不得宣告 V2。

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
  "sidebarWidth": 280,
  "sidebarOpen": true,
  "sidebarView": "files",
  "inspectorWidth": 420,
  "inspectorOpen": true,
  "scratchWidth": 380,
  "scratchCollapsed": true,
  "pinnedItems": [{ "kind": "session", "name": "demo-fix" }],
  "automationSectionCollapsed": true,
  "selection": { "kind": "session", "name": "..." },
  "editingFile": { "path": "/repo/README.md", "hostId": null },
  "window": { "width": 1440, "height": 900, "x": 0, "y": 0, "maximized": false }
}
```

迁移规则：

- 第一次读取旧 layout 时创建内存中的 v2 结构。
- 写回前备份旧文件为带 schema/version 的 backup；v2 启动失败时允许回滚读取 v1。
- 旧 `{kind: "session", name}` selection 通过当前 session composite key 映射为稳定 workspace id；terminal/automation 使用对应既有 id。
- selection 指向已删除 session、terminal、automation 或未知 Host 时，回退到第一个可用本地 workspace；没有可用项时进入明确空态。
- 新写入以 `sidebarView: "workspaces" | "files"` 为 canonical；旧 `fileBrowserOpen=true`，或旧 `inspectorOpen=true + inspectorTab=files`，迁为 Files。旧版明确关闭 Files 时不能强制打开。
- 旧 `inspectorTab=git/diff` 只用于一次兼容读取；Git panel 使用 `inspectorOpen/inspectorWidth`，Diff 使用 `diffFile` 在中间恢复，新版不再写通用 Inspector tab。
- 旧 `file/main/scratch/editor` column order 不直接复刻；映射为 Sidebar view、Workspace Editor/Diff 和 Scratch split 状态。
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
- Workspaces/Files mounted-state、legacy Files migration 和 960px sidebar width tests
- Git hidden-state polling gate、remote Host identity 和 changed-file → center Diff tests
- Settings/Host/Relay contract tests
- Terminal lazy mount/reconnect regression tests
- Fake backend 驱动的 component behavior tests，不把源码 regex 断言当作主要行为验证
- Tauri adapter payload / event ordering / unsubscribe tests
- Vite + fake backend 的关键 UI e2e
- isolated HOME 的 packaged-app smoke test，验证真实资源路径和用户数据隔离
- 当前 release bundle 覆盖 `/Applications/tw-dashboard.app` 后的签名、bundled CLI、process 和窗口启动 smoke test

### 13.2 真实流程

至少验证：

1. 本地 worktree 创建、attach、切换、关闭。
2. SSH Host 添加、测试、remote worktree 创建、attach、断线恢复。
3. 独立 Terminal 创建、重命名、切换、关闭。
4. Git status/log；点击 changed file 后 Diff 在中间打开，wide 下 Git list 保持。
5. 本地与 remote 文件读取/编辑；FileTree 与 Editor 并存，切 Workspaces/Git 后树状态仍在，unsaved guard 可取消导航。
6. Automation 新建、Run、Pause、删除、history。
7. Mobile Relay 查看、配置、启动、停止、重连。
8. `sidebarView`、Git、Editor/Diff、Scratch、window、theme 重启恢复与旧 layout 迁移。
9. `/Applications/tw-dashboard.app` 正式路径启动、bundled CLI resource 和真实用户数据兼容。

### 13.3 视觉 QA

每个实现阶段都对照目标线框和实际截图，检查：

- typography
- spacing/layout rhythm
- colors/tokens
- icons/assets
- copy/content
- responsive states
- keyboard/focus/accessibility

Phase 2.1 已对选定 1+3 组合做两轮同屏比较。最终 source/implementation 对比为 `/tmp/dashboard-design-comparison-pass2.png`，局部可读性对比为 `/tmp/dashboard-design-comparison-focus-pass2.png`。1487px 下 Files + Editor + Git Graph 同时显示；960px 下 Files + Editor 常驻、Git 为可关闭 drawer；420px 下 Files/Git 使用 drawer，选中文件后自动露出 Editor。三档均无 app-level 横向滚动，production capture console errors 为 0。

完整证据、修复历史、必须 fidelity surfaces 和已接受 P3 约束记录在根目录 `design-qa.md`。

P0/P1/P2 问题修复后才能完成阶段；P3 可记录为后续 polish。

---

## 14. 风险与缓解

| 风险 | 缓解 |
|---|---|
| `App.tsx` 拆分导致行为回归 | 先建立 adapter/hooks，再换视觉；每个 slice 保持可运行 |
| Terminal 切换重连 | 保持 opened terminal 稳定挂载，增加回归测试 |
| 远端与本地能力不对称 | 由 capability/status 显示，不假装功能可用 |
| Files 与 Git 混成一个入口 | Files 固定为左栏同级 view，Git 固定为右栏，Diff 固定进入中间 |
| 960px 编辑区被侧栏挤压 | 960–1439 动态限制 Sidebar 为 `viewport - 640px`，Git 使用 drawer |
| 隐藏 Git 仍持续 SSH polling | Git panel 保持 mounted 但 polling 由 active state gate，关闭时停止请求 |
| Settings 变成杂物间 | 严格执行“全局配置 vs 当前动作”边界 |
| 主题重构破坏 xterm/tmux | product shell 与 Terminal palette 解耦，保留 theme event |
| Chat 解析任意 TUI 不可靠 | Terminal-first；只有 structured adapter 才开启 Chat |
| Feishu 泄露 terminal 内容 | 默认仅 @mention、明确 warning、redaction、audit、pause/kill switch |
| Electron 再次成为主观争论 | 以 dogfood profile 和 spike 结果作为唯一决策依据 |
| 长分支偏离 master | 阶段性 push；合并前再同步并完整回归 |
| All scope 遇到极端数量 refs | 当前仅 catalog commit OID 可进入 argv；常规 Current/手选不受影响，后续超大仓库改为 `git log --stdin` 并加压力测试 |
| renderer 主 chunk 偏大 | 当前 production gzip 约 398KB；dogfood 记录启动数据，之后按 Editor/Markdown/language chunk 做真实 code splitting，不在本轮混入无证据重构 |

---

## 15. Git 工作流

### 当前阶段

- Dashboard 分支 `tmux-worktree-app-re-ddf7c` 与 Android 分支 `tmux-worktree-apk-re-5f44d` 已完成验收并按用户授权合入 `master`。
- Android 代码合并基线 `ac82272` 已同时存在于本地/远端 feature branch 与 `origin/master`。
- Relay v2 contract 和本计划的最终状态在 Android 分支提交、push 后 fast-forward 到 `master`；不使用 force push。
- 下一阶段 SSH 稳定性从最新 `origin/master` 新建独立任务分支，不复用已完成的重构分支承载新功能。

### 提交原则

- 每个 Phase 使用可独立构建和审阅的小提交。
- 计划、重构、视觉、功能、迁移、测试尽量分开提交。
- 不混入版本 bump、release asset 或无关清理。
- 每个阶段结束后 push 当前分支并记录验证结果。

### 合并原则

- 只有全部约定工作完成或用户明确缩小 release scope 后，才准备合并。
- 合并前同步最新 `origin/master` 并重新跑完整验证。
- 合并动作需要用户明确授权；本轮 Dashboard/Android 已取得授权并完成，后续任务重新按该门禁执行。

---

## 16. Definition of Done

Dashboard v2 达到完成状态需要：

- 新三栏 IA（Workspaces/Files + Workspace + Git）、Settings、Command Palette 和响应式行为落地。
- 现有本地/SSH/Terminal/Git/File/Automation/Relay 核心能力无回归。
- FileTree 可与 Editor 常驻并存；Files、Git、Diff 不再互相冒充或共享含混入口。
- Host 等低频配置从主工作区移入 Settings，同时状态和恢复动作仍易发现。
- Terminal-first 工作流稳定；没有伪造不可用的 Chat/model 能力。
- 数据和布局迁移安全。
- 自动化测试、真实流程验证和视觉 QA 通过。
- dogfood 结论记录完成，运行时选择有证据。
- Dashboard/Android replacement 和冻结协议文档已提交、push 并合入 `master`。
- 正式 release 与后续 SSH/Relay 实现有独立验收和授权，不因本轮合并自动执行。
