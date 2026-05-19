# @byted-codebase/tmux-worktree

AI + tmux + git worktree 一体化开发环境，附带 macOS 原生桌面 Dashboard 应用。

## 安装

```bash
npm install -g @byted-codebase/tmux-worktree --registry=https://bnpm.byted.org
```

或者通过 npx 直接使用（无需安装）：

```bash
npx @byted-codebase/tmux-worktree claude coco
```

## 快速开始

```bash
# 创建开发 session（tmux + worktree + AI agent）
tw claude coco

# 带自定义 session 名称
tw claude coco fix-auth-bug

# 自定义 AI 命令参数
tw "claude --model opus" coco refactor

# 交互模式（无参数，逐步选择）
tw
```

## CLI 命令

### `tw <ai-command> <project> [session-name]`

创建完整的 AI 开发环境：

1. 从远程仓库拉取最新代码
2. 自动创建 git worktree 分支
3. 启动 tmux session，三栏布局：
   - 左栏：`tw status` 状态面板
   - 中栏：AI agent（claude / coco / aider / codex 等）
   - 右栏：普通终端

支持的 AI 命令示例：`claude`, `coco`, `aider`, `codex`, 或任意自定义命令。

### `tw status`

终端 TUI 状态面板，实时展示所有 tmux session。

```bash
tw status          # TUI 模式，2 秒自动刷新
tw status --once   # 单次输出，适合脚本使用
```

功能：
- 按项目分组，颜色区分
- 鼠标点击切换 session
- 点击 `x` 关闭 session
- CJK 字符正确对齐

### `tw serve`

启动 HTTP + WebSocket 服务，提供 Web 远程终端访问（适合手机/平板）。

```bash
tw serve                    # 默认端口 8311
tw serve --port 9000        # 自定义端口
tw serve --remote           # 同时启动 Cloudflare Tunnel，获取公网 URL
```

**环境变量：**
- `TW_TOKEN`：自定义认证 token（默认随机生成）

**认证机制：**
- Token 自动写入 `~/.tw-serve-token`（桌面 App 可读取）
- Web UI 提供 token 输入页面，支持 localStorage 记住登录

**Web 终端特性：**
- 移动端全屏优化（PWA capable、safe-area 适配）
- xterm.js 终端渲染
- 触摸滚动（模拟 tmux 鼠标滚轮，含惯性滑动）
- 快捷按钮：Tab、Ctrl-C、Ctrl-D、Ctrl-Z
- IME 输入法支持

## Remote Tunnel（公网远程访问）

通过 Cloudflare Quick Tunnel 实现零配置的公网远程访问：

```bash
# CLI 方式
tw serve --remote
# 输出公网 URL（*.trycloudflare.com）和 token
# 手机浏览器打开 URL → 输入 token → 操控 tmux sessions

# 桌面 App 方式
# 点击 Dashboard 中的 Remote (🌐) 按钮，自动启动 serve + tunnel
```

无需 Cloudflare 账号，使用免费 Quick Tunnel 服务。

## Dashboard 桌面应用

基于 Tauri 2 + React 的 macOS 原生应用。

### 安装

```bash
# npm 安装后执行
tw-dashboard-install

# 启动
open -a tw-dashboard
```

### 功能

| 功能 | 说明 |
|------|------|
| Session 管理 | 查看、切换、关闭 tmux session，拖拽排序 |
| Worktree 创建 | 一键创建新 worktree + tmux session + AI agent |
| 内嵌终端 | 基于 portable-pty 的原生终端 |
| Scratch 终端 | 可折叠的临时终端面板，支持多个 split |
| 文件浏览器 | 项目文件树导航 |
| 文件编辑器 | CodeMirror 6 语法高亮、Markdown 预览、图片预览 |
| Git Diff | 内置 diff 查看器 |
| Git 状态 | 实时 staged/unstaged/untracked 文件计数和 commit 历史 |
| 项目搜索 | 文件名搜索 + 内容全文搜索 |
| Remote 连接 | 一键启动 Cloudflare Tunnel，手机远程访问 |
| 主题切换 | 多种暗色主题 |
| 布局持久化 | 面板尺寸、终端状态自动保存恢复 |

### 其他特性

- **剪贴板集成**：tmux copy-mode 选中自动进入系统剪贴板（pbcopy）
- **孤儿 worktree 恢复**：检测无关联 session 的 worktree，可一键恢复
- **Kill 自动清理**：删除 session 时自动清除对应的 git worktree
- **Shell 环境继承**：App 启动时从 login shell 继承完整环境变量

## 配置

首次运行会启动交互式向导创建 `~/.tmux-worktree.json`。

手动创建：

```json
{
  "projects": {
    "coco": "/Users/me/go/src/code.byted.org/nextcode/coco",
    "vecode": "/Users/me/go/src/code.byted.org/vecode/vecode"
  },
  "worktreeBase": "/private/tmp/tmux-worktree/projects",
  "notesBase": "/private/tmp/tmux-worktree/notes"
}
```

| 字段 | 必须 | 说明 | 默认值 |
|------|------|------|--------|
| `projects` | 是 | 项目名 → git 仓库路径 | — |
| `worktreeBase` | 否 | worktree 存放目录 | `/private/tmp/tmux-worktree/projects` |
| `notesBase` | 否 | session 笔记目录 | `/private/tmp/tmux-worktree/notes` |

## 开发

```bash
# CLI 开发
npm install
npm run build
node dist/cli.js status --once
node dist/cli.js serve

# Dashboard App 开发
cd app
npm install
npm run tauri dev       # 开发模式（热重载）
npm run tauri build     # 构建发布包
```

## 发布

```bash
npm run build
npm publish --access public --registry=https://bnpm.byted.org
```

## 技术栈

- **CLI**: TypeScript, Node.js 20+, tmux, git
- **Desktop App**: Tauri 2 (Rust) + React + TypeScript
- **Web Terminal**: xterm.js, WebSocket, Python PTY
- **Remote**: Cloudflare Quick Tunnel (cloudflared)

## License

Internal use only.
