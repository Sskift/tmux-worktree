# tmux-worktree

`tmux-worktree` 提供两套工具，用于管理 AI 编程 session：

- `tw`：Node.js CLI，创建独立 git worktree、启动 tmux session，并运行指定 AI 命令。
- `tw-dashboard`：macOS Tauri 桌面端，管理 tmux session、worktree、终端、文件、Git 状态和远程访问。

仓库代码结构、开发/发布边界见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 安装

### Dashboard

内部 bnpm 安装：

```bash
npx -y --registry=https://bnpm.byted.org -p @byted-codebase/tmux-worktree tw-dashboard-install
open -a tw-dashboard
```

如果已经有 DMG，也可以手动拖入 `/Applications` 安装。

### CLI

```bash
npm i -g @byted-codebase/tmux-worktree --registry=https://bnpm.byted.org
tw setup
```

## 配置

CLI 和 Dashboard 共用 `~/.tmux-worktree.json`：

```json
{
  "projects": {
    "myapp": "/path/to/myapp",
    "backend": "/path/to/backend"
  },
  "worktreeBase": "/private/tmp/tmux-worktree/projects"
}
```

- `projects`：项目名到 git 仓库路径的映射，供 CLI 和 Dashboard 新建 worktree 使用。
- `worktreeBase`：自动创建 worktree 的父目录。

Dashboard 额外状态文件：

- `~/.tw-dashboard-layout.json`：窗口、栏目、当前选择、文件树、编辑器/diff、侧边栏布局。
- `~/.tw-dashboard-terminals.json`：独立终端列表。
- `~/.tw-dashboard-pending-worktree-cleanup.json`：延迟清理的 worktree 记录。

## CLI 使用

创建 AI 开发环境：

```bash
tw claude myapp
tw claude myapp fix-auth
tw "claude --model opus" backend
tw claude ~/some/repo
tw
```

子命令：

- `tw setup`：检查系统依赖。
- `tw status`：tmux 内的 session 状态面板。
- `tw serve`：启动本地 WebSocket 终端服务。
- `tw serve --remote`：本地终端服务加 Cloudflare Quick Tunnel。

## Dashboard 使用

常用流程：

1. 点击 `+ worktree` 创建或恢复 worktree session。
2. 在左侧选择 session，主区域会 attach 到对应 tmux。
3. 左下角 Git 面板查看分支、文件变更和 commit 历史。
4. 打开文件树后，可以浏览项目并打开编辑器或 diff 栏。
5. 点击 remote access，通过 Cloudflare Quick Tunnel 在手机或其他设备访问 Web 终端。

布局行为：

- 首次打开是默认三栏：侧边栏、主终端、scratch。
- 如果关闭前打开了文件树、编辑器或 diff 栏，重启后会恢复这些栏目和宽度。
- Git 面板会跟随当前 tmux session 的 active pane cwd，因此 agent 在 tmux 中切换目录或分支后，面板分支也会刷新。

## 开发

依赖：

- Node.js 20+
- Rust stable
- Xcode Command Line Tools
- tmux
- git
- cloudflared，可选，仅远程访问需要

CLI：

```bash
npm install
npm run build
node dist/cli.js status --once
```

Dashboard：

```bash
cd app
npm install
npm run tauri dev
```

如果本机已经安装正式版 `tw-dashboard.app`，建议用隔离 dev app：

```bash
cd app
npm run tauri:dev:isolated
npm run tauri:dev:install
```

## 发布

CLI 和 Dashboard installer 共用根目录 npm 包发布：

```bash
./app/scripts/release.sh --dry-run
./app/scripts/release.sh
```

发布脚本会：

1. 构建 Tauri Dashboard DMG。
2. 构建根目录 CLI 到 `dist/cli.js`。
3. 复制 DMG 到 `app/installer/dmg/tw-dashboard-arm64.dmg`。
4. 发布根目录 npm 包到 bnpm。

npm 包只包含：

- `dist`
- `app/installer/installer.mjs`
- `app/installer/dmg/`

## License

MIT
