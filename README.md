# tmux-worktree

macOS 原生桌面应用，管理 AI 编程 session —— 集成 tmux、git worktree 和远程终端访问。

## Dashboard 桌面应用

基于 Tauri 2 + React 构建的 macOS 原生应用，提供可视化的 AI 开发环境管理。

### 安装

从 [GitHub Releases](https://github.com/Sskift/tmux-worktree/releases) 下载 DMG 安装包，拖入 Applications 即可。

### 功能

| 功能 | 说明 |
|------|------|
| Session 管理 | 查看、切换、关闭 tmux session，拖拽排序 |
| Worktree 创建 | 一键创建新 worktree + tmux session + AI agent |
| 内嵌终端 | 基于 portable-pty 的原生终端，多 split 布局 |
| Scratch 面板 | 可折叠的临时终端，支持多 tab |
| 文件浏览器 | 项目文件树导航 |
| 文件编辑器 | CodeMirror 6 语法高亮、Markdown 预览、图片预览 |
| Git Diff | 内置 diff 查看器 |
| Git 状态 | staged/unstaged/untracked 文件计数 + commit 历史 |
| 项目搜索 | 文件名 + 内容全文搜索 |
| Remote 连接 | 一键 Cloudflare Tunnel，手机远程操控终端 |
| 主题切换 | 多种暗色主题 |
| 布局持久化 | 面板尺寸、终端状态自动保存恢复 |

### 特性

- **剪贴板集成**：tmux copy-mode 选中自动进入系统剪贴板
- **孤儿 worktree 恢复**：检测无关联 session 的 worktree，可一键恢复
- **Kill 自动清理**：删除 session 时自动清除对应 git worktree
- **Shell 环境继承**：从 login shell 继承完整环境变量
- **ESC 聚焦**：当光标在 tmux 位置或进入 copy mode 时，按 ESC 一键聚焦到 AI 对话框

## Remote（手机远程访问）

通过 Cloudflare Quick Tunnel 实现零配置公网访问，在手机/平板上操控你的 tmux session：

1. Dashboard 中点击 Remote 按钮（或 CLI 运行 `tw serve --remote`）
2. 获得公网 URL + Token
3. 手机浏览器打开 → 输入 Token → 操控终端

无需 Cloudflare 账号，使用免费 Quick Tunnel 服务。

**Web 终端特性：**
- 移动端全屏优化（PWA capable、safe-area 适配）
- 触摸滚动（模拟 tmux 鼠标滚轮，含惯性滑动）
- 快捷按钮：Tab、Ctrl-C、Ctrl-D、Ctrl-Z
- IME 输入法支持

## CLI

除了桌面应用，也提供命令行工具：

```bash
# 从源码安装
git clone https://github.com/Sskift/tmux-worktree.git
cd tmux-worktree
npm install && npm run build
npm link          # 全局注册 tw 命令

# 检查系统依赖
tw setup
```

### `tw <ai-command> <project> [session-name]`

创建 AI 开发环境（worktree + tmux session + AI agent）：

```bash
tw claude <repo>                       # 基本用法
tw claude <repo> fix-auth-bug          # 自定义 session 名
tw "claude --model opus" <repo>        # 自定义 AI 命令
tw                                     # 交互模式
```

### `tw status`

终端 TUI 面板，实时展示所有 session，鼠标可点击切换/关闭。

### `tw serve`

启动 HTTP + WebSocket 服务，供 Web 终端和桌面应用连接。

```bash
tw serve                    # 默认端口 8311
tw serve --remote           # 同时启动 Cloudflare Tunnel
```

## 配置

首次运行自动启动交互式向导创建 `~/.tmux-worktree.json`：

```json
{
  "projects": {
    "myapp": "/path/to/myapp",
    "backend": "/path/to/backend"
  },
  "worktreeBase": "/private/tmp/tmux-worktree/projects",
  "notesBase": "/private/tmp/tmux-worktree/notes"
}
```

## 开发

```bash
# Dashboard App
cd app && npm install
npm run tauri dev       # 开发模式
npm run tauri build     # 构建 DMG

# CLI
npm install && npm run build
```

## 技术栈

- **Desktop App**: Tauri 2 (Rust) + React + TypeScript
- **CLI**: TypeScript, Node.js 20+, tmux, git
- **Web Terminal**: xterm.js, WebSocket
- **Remote**: Cloudflare Quick Tunnel (cloudflared)

## License

MIT
