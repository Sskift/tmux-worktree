# tw-dashboard

`tw` 的桌面端 GUI。Tauri + React + xterm.js 包住 tmux 和 git worktree,把 CLI 版的 `tw` 升级成 Warp 风格的三栏面板。

> 用户向说明见飞书文档:<https://bytedance.larkoffice.com/wiki/OYn6whuokihNJUkdirhc2zhmnid>
> CLI 版 tw 文档:<https://bytedance.larkoffice.com/wiki/HmcSwP0jZizIVkkGvi5cWHPZnBz>

## 快速安装

Apple Silicon Mac:

```bash
npx -y --registry=https://bnpm.byted.org -p @byted-codebase/tmux-worktree tw-dashboard-install
```

如果 `~/.npmrc` 已经把 `@byted-codebase` 配到了 `https://bnpm.byted.org`(装过 tw CLI 的多半都有),可以省掉 `--registry`:

```bash
npx -y -p @byted-codebase/tmux-worktree tw-dashboard-install
```

包里带的 dmg 会被挂载、`ditto` 拷到 `/Applications/`,清掉 macOS 隔离属性,装好就能 `open -a tw-dashboard`。Intel Mac 暂未发布(arch 字段已就绪,差个 universal build),自行 [构建 release](#构建-release)。

> **为什么用 npm 包而不是 `curl | bash`?** byted codebase 所有 HTTP 请求(包括 `/raw/`)都走 SSO,匿名 curl 拿不到内容;bnpm tarball 是内部唯一不要 SSO 的渠道,顺势把 dmg 也塞进 npm 包统一分发。
>
> **为什么塞进 `tmux-worktree` 而不是单独发包?** `@byted-codebase` scope 开了 ACL,新包名要找 bnpm oncall 审批;现成的 `@byted-codebase/tmux-worktree`(tw CLI)已经在白名单里,顺手挂个 `tw-dashboard-install` bin 就能蹭通道发版。

## 技术栈

| 层 | 选型 |
|---|---|
| Shell | Tauri 2.11 (Rust + WebKit) |
| 前端 | Vite 7 · React 19 · TypeScript 5 |
| 终端 | xterm.js 5 + addon-fit |
| PTY | portable-pty 0.8(Rust 端) |
| 系统集成 | `tauri-plugin-dialog`(原生选择器),IPC 走 Tauri command |
| 外部 CLI | `tmux` · `git` · `tw` (npm 全局) |

## 架构

```
┌─────────────────────────────────────────────┐
│  React UI                                   │
│  ┌────────┬─────────────┬───────────────┐   │
│  │sessions│ main term   │ scratch term  │   │
│  │ + git  │ (xterm.js)  │ (xterm.js)    │   │
│  └────────┴─────────────┴───────────────┘   │
│       │ invoke()        ▲ event listen      │
└───────┼─────────────────┼───────────────────┘
        ▼                 │
┌─────────────────────────────────────────────┐
│  Rust (Tauri commands)                      │
│  list_sessions / create_worktree / git_*    │
│  pty_open / pty_write / pty_resize          │
└───────┬─────────────────────────────────────┘
        ▼
   tmux | git | portable-pty (zsh / tmux attach)
```

中间栏的 PTY 跑 `tmux attach-session -t <name>`,右栏 PTY 跑一个继承 session cwd 的 `zsh -l`。session 切换时,已打开的 PTY 通过 React 的 `display: none` 保活,不重置滚屏和 AI 上下文。

## 项目结构

```
app/
├── src/                          # React 前端
│   ├── App.tsx                   # 三栏 + 模态框 + splitter 根组件
│   ├── App.css                   # 全部 UI 样式(纯 CSS,无 UI 库)
│   ├── Terminal.tsx              # xterm.js 包装,PTY 桥接
│   ├── GitStatusPanel.tsx        # files / log tab
│   ├── NewWorktreeModal.tsx      # 新建 worktree
│   ├── ThemePicker.tsx           # 主题选择
│   └── themes.ts                 # 5 个主题预设
├── src-tauri/
│   ├── src/lib.rs                # 所有 Tauri command + PtyState
│   ├── tauri.conf.json           # 窗口/bundle 配置
│   ├── Cargo.toml                # Rust 依赖
│   └── capabilities/default.json # 权限白名单
├── installer/                    # 跟随 @byted-codebase/tmux-worktree 一起发布的 dashboard 安装器
│   ├── installer.mjs             # node 安装脚本(挂载 dmg → /Applications),bin 名 tw-dashboard-install
│   └── dmg/                      # 发布时由 release.sh 填充(.gitignore)
├── scripts/
│   └── release.sh                # tauri build + 同步 dmg + 从 repo 根目录 npm publish
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## Tauri command 清单

| command | 说明 |
|---|---|
| `list_sessions` | `tmux list-sessions`,返回 name/attached/window_count/created/activity |
| `list_projects` / `add_project` | 读写 `~/.tmux-worktree.json` 中 `projects` 字段 |
| `create_worktree` | 支持 project 名或自定义 path,内部调 `tw new` |
| `kill_session` | `tmux kill-session -t <name>` |
| `session_cwd` | 取 session 第一个 pane 的 `pane_current_path`,scratch 终端继承用 |
| `git_status` | `git status --porcelain=v2 --branch`,返回分支 + ahead/behind + 文件清单 |
| `git_log` | `git log --all --topo-order --decorate=short`,返回 hash/parents/refs/subject/author/rel_time |
| `pty_open` / `pty_write` / `pty_resize` / `pty_kill` | portable-pty 生命周期。PTY 在 session 切换时保活 |

事件:`pty://<id>/data`(stdout 流式输出)、`pty://<id>/exit`。

## 前置依赖

| 工具 | 版本 | 安装 |
|---|---|---|
| Node.js | ≥ 20 | `brew install node` 或 nvm |
| Rust | stable(1.78+) | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Xcode CLT | — | `xcode-select --install` |
| tmux | ≥ 3.3 | `brew install tmux` |
| git | 现代版本 | 系统自带 |
| tw CLI | 0.1.11+ | `npm i -g @byted-codebase/tmux-worktree --registry=https://bnpm.byted.org` |

## 开发

```bash
cd app
npm install            # 安装前端依赖
npm run tauri dev      # 启动 dev,热更新 + Rust debug 编译
```

首次启动会编译全部 Rust 依赖,1–3 分钟;后续增量秒级。改 React/CSS 立即生效;改 Rust 自动重启。

## 构建 release

```bash
cd app
npm run tauri build
```

产物:

| 产物 | 路径 |
|---|---|
| 独立 .app | `app/src-tauri/target/release/bundle/macos/tw-dashboard.app` |
| DMG | `app/src-tauri/target/release/bundle/dmg/tw-dashboard_<version>_aarch64.dmg` |
| 裸二进制 | `app/src-tauri/target/release/app` |

安装:

```bash
cp -R app/src-tauri/target/release/bundle/macos/tw-dashboard.app /Applications/
# 跨机器分发的 dmg 没签名时首启会拒,清掉隔离属性:
xattr -dr com.apple.quarantine /Applications/tw-dashboard.app
open /Applications/tw-dashboard.app
```

## 发布 release

走 bnpm 分发,**不**走 codebase release(byted 这套 codebase 不是 GitLab,Releases 功能没有;HTTP 路径全要 SSO,匿名 curl 拿不到)。dashboard 的安装器和 tw CLI 共用 `@byted-codebase/tmux-worktree` 这一个 npm 包,因为 `@byted-codebase` scope 开了 ACL,新包名要找 oncall 审批,现成的包顺手加个 bin 即可。

一条命令搞定 bump + 构建 + 同步 dmg + 发布:

```bash
# 1. bump 版本号:
#    - app/src-tauri/tauri.conf.json 的 "version"(决定 dmg 文件名,跟 dashboard 构建版本走)
#    - 仓库根目录 package.json 的 "version"(决定 npm publish 的版本)
# 2. 跑发布脚本(从仓库任意位置都行)
./app/scripts/release.sh
```

脚本做的事:

1. 从 `app/src-tauri/tauri.conf.json` 读 dashboard 版本(决定 dmg 文件名)
2. 从仓库根目录 `package.json` 读 npm 包版本(决定 publish 版本)
3. `npm run tauri build` + `npm run build`(tsup 打 CLI),可加 `--no-build` 跳过两个构建
4. 拷贝 `target/release/bundle/dmg/tw-dashboard_<tauri_ver>_aarch64.dmg` → `app/installer/dmg/tw-dashboard-arm64.dmg`
5. `cd <repo-root> && npm publish --registry=https://bnpm.byted.org`

预览不发布:`./app/scripts/release.sh --dry-run`(会调 `npm pack --dry-run` 列出 tarball 内容)。

发布完毕后用户跑:

```bash
npx -y --registry=https://bnpm.byted.org -p @byted-codebase/tmux-worktree tw-dashboard-install
```

bnpm 拉最新 tarball,内置 `installer.mjs` 自动 mount dmg + ditto 到 `/Applications/` + xattr 去隔离 + 退出。

## 跨架构构建

默认只构建当前架构。Apple Silicon 上是 `aarch64-apple-darwin`,要做 universal:

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

## 权限配置

Tauri 2 默认不放开 `window.startDragging` 和 dialog 插件,在 `src-tauri/capabilities/default.json` 显式声明:

```json
{
  "permissions": [
    "core:default",
    "core:window:allow-start-dragging",
    "dialog:default"
  ]
}
```

## UI 状态持久化

| localStorage key | 含义 |
|---|---|
| `tw-dashboard:cols` | 左/右栏宽度(`{ left, right }`) |
| `tw-dashboard:git-height` | git 面板高度 |
| `tw-dashboard:theme` | 当前主题 id |

## 已知问题

- **Tauri 版本错位**: `@tauri-apps/api` 和 Rust crate `tauri` 的 minor 版本必须对齐,否则 `tauri build` 报错(dev 仅警告)。改一边就 `cargo update -p tauri --precise <版本>` 或 `npm install @tauri-apps/api@<版本>`。
- **Linux 未验证**:目前只在 macOS arm64 上验过。
- **没有 codesign**:dmg 跨机器分发会被 macOS Gatekeeper 标记隔离属性,首次打开会被拒。`installer.mjs` 会自动 `xattr -dr` 处理掉;手动安装的话也可以执行同样的命令,或者走完整 `codesign --deep --force --options runtime ...` + notarize 流程。

## Roadmap

- codesign + notarize → 可直接分发的 dmg
- universal binary + CI 流水线
- git 面板:右键 stage / unstage / discard
- commit 详情:点 commit 显示 diff
