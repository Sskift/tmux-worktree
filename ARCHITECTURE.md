# 仓库代码文档

这个仓库产出两类发布物，同时保留少量仅开发使用的脚本。

## 发布物

### CLI npm binary

根目录 npm 包发布以下命令：

- `tw`
- `tmux-worktree`

发布路径：

1. `src/*.ts`
2. `npm run build`
3. `dist/cli.js`
4. npm package `bin`

源码边界：

| 文件 | 作用 | 发布状态 |
|---|---|---|
| `src/cli.ts` | CLI 路由，分发 `status`、`serve`、`setup` 和默认 session 创建流程 | 打包进 `dist/cli.js` |
| `src/config.ts` | 读取并归一化 `~/.tmux-worktree.json`，兼容旧版 CLI 字符串映射、对象映射、数组项目和字段别名 | 打包 |
| `src/dev.ts` | 创建 git worktree 和 tmux session，并启动 AI 命令 | 打包 |
| `src/status.ts` | CLI session 左侧 tmux TUI 状态面板 | 打包 |
| `src/serve.ts` | 本地/移动端 Web 终端和 Remote 桥接服务 | 打包 |
| `src/setup.ts` | 系统依赖检查和可选安装 | 打包 |

### Dashboard installer npm binary

根目录 npm 包发布以下命令：

- `tw-dashboard-install`

发布路径：

1. `app/src` 和 `app/src-tauri`
2. `npm run tauri build`，Tauri `beforeBuildCommand` 同时构建根目录 `dist/cli.js`
3. 根目录 `dist/cli.js` 作为 `tw-cli/` resource 打进 `.app`，供 Dashboard remote 启动 `tw serve`
4. DMG 复制到 `app/installer/dmg/tw-dashboard-arm64.dmg`
5. `app/installer/installer.mjs` 挂载 DMG 并安装 `tw-dashboard.app`

发布文件：

| 文件 | 作用 | 发布状态 |
|---|---|---|
| `app/installer/installer.mjs` | macOS DMG 安装器 | 发布 |
| `app/installer/dmg/` | release 脚本填充的 DMG 目录 | 发布时包含 |

## Dashboard 源码

前端入口：

- `app/index.html`
- `app/src/main.tsx`
- `app/src/App.tsx`

前端模块：

| 文件 | 作用 |
|---|---|
| `app/src/App.tsx` | Dashboard 根组件，负责布局持久化、栏目拖拽排序、session/automation 选择、modal 和 remote 控制 |
| `app/src/App.css` | Dashboard 样式 |
| `app/src/AutomationPanel.tsx` | 本地 automation 管理面板，负责新建/编辑、Run now、pause/activate、delete 和运行历史展示 |
| `app/src/automationTypes.ts` | automation 前后端契约转换、表单校验和 cron 调度匹配 helper |
| `app/src/Terminal.tsx` | xterm.js 包装和 Tauri PTY 事件桥接 |
| `app/src/GitStatusPanel.tsx` | Git files/log 面板；按 tmux 实时 cwd 跟踪 session 分支 |
| `app/src/FileTree.tsx` | 文件树、文件名搜索、内容搜索 |
| `app/src/FileEditor.tsx` | CodeMirror 编辑器、Markdown 预览、图片预览 |
| `app/src/DiffViewer.tsx` | Git diff 查看器 |
| `app/src/NewWorktreeModal.tsx` | 创建/恢复 worktree session |
| `app/src/NewTerminalModal.tsx` | 创建独立 tmux terminal |
| `app/src/ThemePicker.tsx` / `themes.ts` | 主题选择和 CSS 变量 |
| `app/src/linkDetect.ts` | 终端/编辑器链接识别、打开文件和 URL |
| `app/src/fileUtils.ts` | 文件类型和 CodeMirror language helper |
| `app/src/useSortable.ts` | 侧边栏 worktree/terminal 列表拖拽排序 |

Rust 后端：

| 文件 | 作用 |
|---|---|
| `app/src-tauri/src/main.rs` | 原生应用入口 |
| `app/src-tauri/src/lib.rs` | 所有 Tauri commands、PTY 状态、git/tmux/file 操作、remote tunnel 生命周期 |
| `app/src-tauri/tauri.conf.json` | App 身份、bundle 配置、CLI resource、窗口默认值 |
| `app/src-tauri/capabilities/default.json` | Tauri v2 权限白名单 |
| `app/src-tauri/icons/` | App 图标 |

主要 Tauri command 分组：

- Session/worktree：`list_sessions`、`create_worktree`、`kill_session`、`list_orphaned_worktrees`、`restore_worktree`、`session_cwd`。
- Git：`git_status`、`git_log`、`git_diff`。
- PTY：`pty_open`、`pty_write`、`pty_resize`、`pty_kill`、`capture_pane_history`。
- 独立终端：`create_plain_terminal`、`ensure_terminal_session`、`kill_plain_terminal`、`load_terminals`、`save_terminals`。
- Automation：`list_automations`、`save_automation`、`delete_automation`、`trigger_automation`、`list_automation_runs`。
- 布局和文件：`load_layout`、`save_layout`、`read_dir`、`read_file`、`write_file`、`search_files`、`file_exists`。
- Remote：`remote_start`、`remote_stop`、`remote_status`。

Automation 设计：

- Dashboard 使用本地 JSON 文件保存 automation 定义和 run 历史，不引入服务端数据库。
- `trigger_automation` 复用现有 `create_worktree` 流程：解析 project/path，创建 git worktree，启动 tmux session，并把 instruction 追加到 `aiCmd`。
- `overlap=skip` 时，如果上一次 running/queued session 仍存在，则记录 `skipped` run；`overlap=queue` 时允许再次启动新 session。
- cron schedule 由前端 Dashboard 运行时按本机本地时间轮询触发；Dashboard 关闭时不会执行后台调度。

Remote 启动顺序：

1. 如果 `127.0.0.1:8311` 已经有 `tw serve`，直接复用。
2. 否则优先使用 `.app` resources 内置的 `tw-cli/cli.js` 启动 `serve`。
3. 如果内置资源不可用，回退到用户全局安装的 `tw` / `tmux-worktree` 命令，兼容已安装 CLI 后端的用户。
4. `cloudflared` 优先使用本机已有安装；缺失时自动下载 Cloudflare 官方 macOS `cloudflared-darwin-{arm64,amd64}.tgz` 到用户目录。

## 仅开发使用

这些文件不进入 npm 包；根目录 `package.json` 的 `files` 字段不会包含它们。

| 路径 | 作用 |
|---|---|
| `app/scripts/dev-common.mjs` | 隔离 dev app 的公共 helper |
| `app/scripts/dev-isolated.mjs` | 使用临时状态启动 Tauri dev app |
| `app/scripts/dev-install.mjs` | 构建并安装一个隔离的 debug `.app` |
| `app/package.json` | Dashboard 开发/构建依赖和脚本 |
| `app/vite.config.ts` | Dashboard Vite 配置 |
| `app/tsconfig*.json` | Dashboard TypeScript 配置 |
| `app/src-tauri/Cargo.toml` / `Cargo.lock` | Rust 构建输入 |

## 仅发布使用

| 路径 | 作用 |
|---|---|
| `app/scripts/release.sh` | 构建 CLI 和 Dashboard、复制 DMG、发布根目录 npm 包 |
| `app/installer/installer.mjs` | `tw-dashboard-install` 运行时安装器 |

## 运行时状态文件

| 文件 | 所属 | 作用 |
|---|---|---|
| `~/.tmux-worktree.json` | CLI 和 Dashboard | 项目映射和 worktree 根目录 |
| `~/.tw-dashboard-layout.json` | Dashboard | 窗口、栏目顺序和宽度、选择、文件树、编辑器/diff、侧边栏布局 |
| `~/.tw-dashboard-terminals.json` | Dashboard | 独立终端定义 |
| `~/.tw-dashboard-automations.json` | Dashboard | 本地 automation 定义 |
| `~/.tw-dashboard-automation-runs.json` | Dashboard | 本地 automation 运行历史，最多保留 200 条 |
| `~/.tw-dashboard-pending-worktree-cleanup.json` | Dashboard | session kill 后待清理 worktree |
| `~/.tw-serve-token` | CLI serve / Dashboard remote | Web 终端认证 token |

`~/.tmux-worktree.json` 兼容格式：

- `projects` / `repositories` / `repos`
- 对象映射：`"name": "/repo/path"` 或 `"name": { "path": "/repo/path", "branch": "develop" }`
- 数组：`[{ "name": "name", "path": "/repo/path" }]`
- 路径别名：`path`、`dir`、`directory`、`root`、`repoPath`
- 分支别名：`branch`、`targetBranch`、`defaultBranch`
- worktree 根目录别名：`worktreeBase`、`worktreeDir`、`worktreeRoot`、`worktreesDir`、`worktreesRoot`

## 文档维护规则

仓库文档只保留两份：

- `README.md`：用户使用和开发指导手册。
- `ARCHITECTURE.md`：代码地图、发布边界、运行时状态说明。

不要在子目录新增重复功能介绍；只有工具强绑定说明或自动生成 API 文档才应单独增加。
