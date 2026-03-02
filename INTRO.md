# tmux-worktree: 一条命令启动 AI 编程环境

> 还在手动建分支、开 tmux、启动 AI 工具、打开笔记？`tw` 帮你一键搞定。

---

## 它解决什么问题？

用 AI 工具（Claude、Coco、Aider 等）写代码时，你每次都要：

1. 拉最新代码，建一个新分支
2. 开一个 tmux session
3. 分屏：左边跑 AI，右边留个终端
4. 再开个地方记笔记
5. 多任务并行时，在多个 session 之间来回切换

**tmux-worktree 把这些步骤压缩成一条命令。**

---

## 30 秒上手

```bash
# 安装
npm i -g @byted-codebase/tmux-worktree --registry=https://bnpm.byted.org

# 启动（交互模式，跟着提示走）
tw
```

首次运行会引导你配置项目路径，之后直接用。

---

## 它做了什么？

输入 `tw` 或 `tw claude coco`，工具会自动完成：

```
1. git fetch origin master
2. git worktree add -b coco-a3f2k /tmp/.../coco-a3f2k origin/master
3. tmux new-session ...
4. 分屏布局 + 启动 AI 工具 + 打开笔记
```

你拿到的是一个这样的 tmux 环境：

```
┌────────┬──────────────────────────────┬──────────────┐
│        │                              │              │
│ status │        AI 工具 (coco)         │    终端       │
│  面板   │                              │              │
│        │     你的主要工作区域           ├──────────────┤
│ ● coco │                              │    笔记       │
│ ○ other│                              │   (vi)       │
│        │                              │              │
└────────┴──────────────────────────────┴──────────────┘
  10%              50%                       40%
```

- **左侧 status 面板** — 实时显示所有 tmux session，红色 `●` 标记当前 session，点击可切换
- **中间 AI 工具** — 自动启动你指定的 AI 命令
- **右上终端** — 跑测试、看日志、git 操作
- **右下笔记** — 每个 session 独立的 markdown 笔记，用 vi 编辑

---

## 核心特性

### Git Worktree 隔离

每次启动都从 `origin/master` 创建一个独立的 worktree 和分支。你的主仓库不受影响，多个任务可以并行，互不干扰。

```
/tmp/tmux-worktree/projects/
├── coco/
│   ├── fix-bug-a3f2k/     ← session 1 的工作目录
│   └── new-feat-b7x9m/    ← session 2 的工作目录
└── vecode/
    └── refactor-c2d4e/    ← session 3 的工作目录
```

### 交互模式

不带参数直接运行 `tw`，跟着提示选择：

```
🚀 tmux-worktree 交互模式

输入要在左栏启动的 AI 命令，如 coco, claude, aider 等
也可以带参数，如 "claude --model opus"
AI 命令 (默认 coco):

选择项目 (将在 git worktree 中工作):
  1) coco         ~/go/src/.../coco
  2) vecode       ~/go/src/.../vecode
  0) 自定义目录        输入任意路径，跳过 worktree
  也可以直接输入项目名或目录路径

选择项目 (默认 1):

tmux session 名称，用于区分多个工作环境
Session 名称 (默认 coco):
```

### 命令行模式

熟练后直接带参数，更快：

```bash
tw claude coco                  # Claude + coco 项目
tw coco vecode fix-auth         # Coco + vecode 项目，session 名 fix-auth
tw "claude --model opus" coco   # 带参数的 AI 命令
tw claude ~/some/dir            # 自定义目录（跳过 worktree）
```

### 自定义目录支持

项目不在配置里？没关系。直接传路径，工具会跳过 git worktree，在该目录下直接打开 tmux session：

```bash
tw aider ~/personal/side-project
```

交互模式下选 `0) 自定义目录` 也可以。

### 多任务并行 & Session 切换

同时开多个任务，左侧 status 面板实时显示所有 session，点击即可切换：

```
 ● coco          ← 当前
 ○ vecode
 ○ side-project
```

---

## 配置

首次运行自动引导创建 `~/.tmux-worktree.json`，也可以手动编辑：

```json
{
  "projects": {
    "coco": "/home/user/go/src/code.byted.org/nextcode/coco",
    "vecode": "/home/user/go/src/code.byted.org/vecode/vecode"
  },
  "worktreeBase": "/tmp/tmux-worktree/projects",
  "notesBase": "/tmp/tmux-worktree/notes"
}
```

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `projects` | 项目名 → git 仓库路径 | (必填) |
| `worktreeBase` | worktree 创建位置 | `/private/tmp/tmux-worktree/projects` |
| `notesBase` | 笔记文件存放位置 | `/private/tmp/tmux-worktree/notes` |

---

## 前置依赖

- **Node.js** >= 20
- **tmux** (macOS: `brew install tmux`)
- **git**

---

## 安装

```bash
npm i -g @byted-codebase/tmux-worktree --registry=https://bnpm.byted.org
```

安装后可用 `tw` 或 `tmux-worktree` 两个命令。

---

## FAQ

**Q: worktree 用完了怎么清理？**

```bash
# 查看某个项目的所有 worktree
git -C ~/your/repo worktree list

# 清理已删除的 worktree 引用
git -C ~/your/repo worktree prune
```

或者直接删除 `/tmp/tmux-worktree/projects/` 下的目录。

**Q: 支持哪些 AI 工具？**

任何命令行 AI 工具都可以，只要能在终端里启动就行。常见的：`coco`、`claude`、`aider`、`codex`，也可以传带参数的命令如 `"claude --model opus"`。

**Q: 不想用 worktree 怎么办？**

传一个目录路径代替项目名即可，工具会跳过所有 git 操作：

```bash
tw claude ~/my/dir
```

**Q: tmux session 怎么退出？**

正常退出 tmux 即可：`tmux detach`（快捷键 `Ctrl-b d`）或直接关掉所有 pane。
