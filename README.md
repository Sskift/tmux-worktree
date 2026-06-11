# tmux-worktree

`tmux-worktree` 提供两套工具，用于管理 AI 编程 session：

- `tw`：Node.js CLI，创建独立 git worktree、启动 tmux session，并运行指定 AI 命令。
- `tw-dashboard`：macOS Tauri 桌面端，管理 tmux session、worktree、终端、本地 automation、文件、Git 状态和远程访问。

仓库代码结构、开发/发布边界见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 安装

### Dashboard

内部 bnpm 安装：

```bash
npx -y --registry=https://bnpm.byted.org -p @byted-codebase/tmux-worktree tw-dashboard-install
open -a tw-dashboard
```

> 如果之前全局装过 `@byted-codebase/tmux-worktree`，`npx` 会优先用旧的全局包（连同里面打包的旧 DMG），装上的可能不是最新版。先升级再装：`npm i -g @byted-codebase/tmux-worktree@latest --registry=https://bnpm.byted.org`。

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

兼容旧版 CLI 和手写配置，下面这些形态也会被正确读取：

```json
{
  "projects": {
    "myapp": { "path": "~/code/myapp", "branch": "develop" }
  },
  "worktreeRoot": "/private/tmp/tmux-worktree/projects"
}
```

```json
{
  "repositories": [
    { "name": "backend", "repoPath": "/path/to/backend", "targetBranch": "master" }
  ],
  "worktreeRoot": "/private/tmp/tmux-worktree/projects"
}
```

项目字段支持 `path`、`dir`、`directory`、`root`、`repoPath` 等别名；分支字段支持 `branch`、`targetBranch`、`defaultBranch` 等别名；worktree 根目录支持 `worktreeBase`、`worktreeDir`、`worktreeRoot`、`worktreesDir`、`worktreesRoot`。

Dashboard 额外状态文件：

- `~/.tw-dashboard-layout.json`：窗口、栏目、当前选择、文件树、编辑器/diff、侧边栏布局。
- `~/.tw-dashboard-terminals.json`：独立终端列表。
- `~/.tw-dashboard-automations.json`：Dashboard 本地 automation 定义。
- `~/.tw-dashboard-automation-runs.json`：Dashboard 本地 automation 运行历史，最多保留 200 条。
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
- `tw automation ls` / `tw auto ls`：列出 Dashboard 可见的本地 automation。
- `tw automation create --instruction <text> [--name <name>] [--cmd <ai-cmd>] [--project <name> | --path <path>] [--schedule <cron>] [--timezone <tz>] [--overlap skip|queue] [--disabled]`：写入 `~/.tw-dashboard-automations.json`，可用 `add` / `new` 作为 `create` 别名。
- `tw automation rm <id|name>`：删除 automation，可用 `delete` 作为别名。

Automation create 目标推断：

- 传 `--project` 时必须命中 `~/.tmux-worktree.json` 里的项目配置。
- 传 `--path` 时保存该路径。
- 都不传时，如果当前目录位于某个配置项目路径下，则保存该 project；否则保存当前目录 path。

## Dashboard 使用

常用流程：

1. 点击 `+ worktree` 创建或恢复 worktree session。
2. 在左侧选择 session，主区域会 attach 到对应 tmux。
3. 左下角 Git 面板查看分支、文件变更和 commit 历史。
4. 打开文件树后，可以浏览项目并打开编辑器或 diff 栏。
5. 在左侧 Automations 区域创建可手动或 cron 调度的本地 automation；运行时会复用 worktree 创建链路启动新的 tmux session。
6. 点击 remote access，通过 Cloudflare Quick Tunnel 在手机或其他设备访问 Web 终端。

Remote 运行时：

- Dashboard 包会内置 `tw serve` 所需的 CLI JS，优先使用内置资源启动后端。
- 如果内置资源不可用，会兼容用户已经全局安装的 `tw` / `tmux-worktree` 命令。
- `cloudflared` 优先使用本机已有安装；缺失时 Dashboard 会自动下载 Cloudflare 官方 macOS 二进制到用户目录。自动下载失败时再提示 `brew install cloudflared`。
- Remote 后端仍需要 Node.js 20+ 来运行 `tw serve`。

布局行为：

- 首次打开是默认三栏：侧边栏、主终端、scratch。
- 侧边栏固定在最左侧；文件树、主终端、scratch、编辑器/diff 等右侧栏目可以拖动标题栏左侧握把重排。
- Automations 固定在左侧 worktrees 和 terminals 之间；选中后主区域显示配置、Run now、pause/activate、delete 和运行历史。
- 如果关闭前打开了文件树、编辑器或 diff 栏，重启后会恢复这些栏目、顺序和宽度。
- scratch 的展开/收起按钮在主终端标题栏右侧。收起后 scratch 整列隐藏；再次展开时默认回到主终端右侧。
- Git 面板会跟随当前 tmux session 的 active pane cwd，因此 agent 在 tmux 中切换目录或分支后，面板分支也会刷新。

## 开发

依赖：

- Node.js 20+
- Rust stable
- Xcode Command Line Tools
- tmux
- git
- cloudflared，可选，仅远程访问需要；Dashboard 会在缺失时尝试自动下载

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

本地验证默认只用 `npm run tauri dev`。它不会在 `/Applications` 下生成带 hash 的 dev app，也能直接反映当前工作区代码。

如果需要隔离 Dashboard 状态，可以用热更新 dev app：

```bash
cd app
npm run tauri:dev:isolated
```

`npm run tauri:dev:install` 会构建一个唯一命名的 debug `.app` 并安装到 `/Applications`，只应在必须验证 Finder/open 真实启动行为时使用。日常本地调试和功能验收不要用它，避免堆积多个 `tw-dashboard-dev-<hash>.app`。

如果确实运行了 `tauri:dev:install`，必须按输出中的 `uninstall` 和 `cleanup state` 命令立即清理。

## 发布

CLI 和 Dashboard installer 共用根目录 npm 包发布：

```bash
./app/scripts/release.sh --dry-run
./app/scripts/release.sh
```

发布脚本会：

1. 构建 Tauri Dashboard DMG。
2. 构建根目录 CLI 到单文件 `dist/cli.js`，并把它打进 Dashboard app resources，供 remote serve 使用。
3. 复制 DMG 到 `app/installer/dmg/tw-dashboard-arm64.dmg`。
4. 发布根目录 npm 包到 bnpm。

npm 包只包含：

- `dist`
- `app/installer/installer.mjs`
- `app/installer/dmg/`

### Feat/Bugfix 完成后的标准工作流

每次完成一个 feature 或 bugfix 后，按下面顺序推进。不要跳过构建测试，也不要在测试失败时 bump 或发布。

1. 确认工作区和分支。

```bash
git status --short --branch
git diff --check
```

2. 构建和测试。

```bash
npm install
npm run build

cd app
npm install
npm run build

cd src-tauri
cargo fmt --check
cargo check
cargo test
```

3. 及时更新文档。

代码行为、发布步骤、配置、运行时状态或开发/发布边界发生变化时，必须同步更新：

- `README.md`：用户使用、开发、发布和操作流程。
- `ARCHITECTURE.md`：代码结构、开发/发布边界、状态文件和关键 command 分组。

不要新增重复文档；优先维护这两份。

4. Bump 版本号。

需要同步更新：

- `package.json`：npm 包版本，决定 bnpm 发布版本。
- `app/src-tauri/tauri.conf.json`：Dashboard 构建版本，决定 DMG 文件名。
- `app/src-tauri/Cargo.toml`：Rust crate 版本，保持本地构建元数据一致。

`app/package.json` 是私有前端工程版本，默认不作为发布版本来源，除非明确需要一起维护。

5. 提交并同步 feature/bugfix 分支到两个远端。

```bash
git add <changed-files>
git commit -m "fix: ..."
git push origin HEAD:<branch>
git push github HEAD:<branch>
```

6. 合入 `origin/master`。

在 Codebase 创建 MR：`<branch> -> master`。确认 diff、checks 和 mergeability 后再合入。

```bash
codebase mr create -R jiangyunong/tmux-worktree --source <branch> --target master --title "<title>" --body "<summary>"
codebase mr status -R jiangyunong/tmux-worktree -N <mr>
codebase mr checks list -R jiangyunong/tmux-worktree -N <mr>
```

如果是自己负责的小改动且明确不需要人工 review，可以按仓库当前流程 skip review：

```bash
codebase mr bypass -R jiangyunong/tmux-worktree -N <mr> --review --reason no_need_for_review --yes
codebase mr merge -R jiangyunong/tmux-worktree -N <mr> --merge --no-delete-branch --yes
```

7. 同步 `github/master`。

```bash
git fetch origin master
git push github origin/master:master
git fetch github master
```

确认两边主分支一致：

```bash
git rev-parse --short origin/master github/master
git log --oneline --left-right --cherry-pick origin/master...github/master
```

8. 启动本地 Dashboard 做 smoke test。

```bash
cd app
npm run tauri dev
```

如需隔离状态验证，可改用热更新隔离 dev app：

```bash
cd app
npm run tauri:dev:isolated
```

只有在必须验证 Finder/open 真实启动行为时才使用 `npm run tauri:dev:install`。该命令会在 `/Applications` 生成 `tw-dashboard-dev-<hash>.app`；验证后必须按输出中的 `uninstall` 和 `cleanup state` 清理。

9. 构建安装包并发布 release。

先预览包内容：

```bash
./app/scripts/release.sh --dry-run
```

确认无误后发布：

```bash
./app/scripts/release.sh
```

10. 更新本地验证仓库。

```bash
cd ~/Desktop/test/tmux-worktree
git fetch origin master
git fetch github master
git merge --ff-only origin/master
git status --short --branch
```

11. 更新本机已安装的 Dashboard App。

发布到 bnpm 后，用正式安装器更新 `/Applications/tw-dashboard.app`。

DMG 是打包在 npm 包里的，而 `npx` 会优先用已经装好的全局 bin，而不是去拉最新版。如果本机已经全局装过 `@byted-codebase/tmux-worktree`（比如装过 CLI），直接 `npx ... tw-dashboard-install` 会挂载**旧版全局包里的旧 DMG**，装上的还是旧版本。所以先把全局包升到最新，再用它自带的安装器：

```bash
npm i -g @byted-codebase/tmux-worktree@latest --registry=https://bnpm.byted.org
tw-dashboard-install
open -a tw-dashboard
```

确认装上的版本和刚发布的一致（两条命令输出应当相同）：

```bash
/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' /Applications/tw-dashboard.app/Contents/Info.plist
npm view @byted-codebase/tmux-worktree version --registry=https://bnpm.byted.org
```

## License

MIT
