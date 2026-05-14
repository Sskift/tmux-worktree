# @byted-codebase/tmux-worktree

AI + tmux + git worktree development environment, with a native macOS dashboard app.

## Install

```bash
npm install -g @byted-codebase/tmux-worktree --registry=https://bnpm.byted.org
```

Or run directly with npx (no install needed):

```bash
npx @byted-codebase/tmux-worktree claude coco
```

## Dashboard App

A native macOS (Tauri) app for managing tmux sessions, worktrees, and files.

```bash
# Install the dashboard after npm install
tw-dashboard-install

# Launch
open -a tw-dashboard
```

### Features

- **Session management**: view, switch, kill tmux sessions with drag-and-drop reordering
- **Plain terminals**: create standalone zsh terminals with custom labels
- **File browser**: browse project files with tree navigation
- **File editor**: syntax-highlighted code editing (CodeMirror 6), Markdown preview, image preview
- **Project search**: full-text content search and filename search across the project
- **Git status**: live staged/unstaged/untracked file counts and commit log
- **Scratch terminals**: per-session scratch shells with resizable splits
- **Theme picker**: multiple dark themes

## Configuration

First run will start an interactive wizard to create `~/.tmux-worktree.json` if it doesn't exist.

You can also create it manually:

```json
{
  "projects": {
    "coco": "/home/user/go/src/code.byted.org/nextcode/coco",
    "vecode": "/home/user/go/src/code.byted.org/vecode/vecode"
  },
  "worktreeBase": "/tmp/worktrees",
  "notesBase": "/tmp/notes"
}
```

- `projects` (required): project name to git repo path mapping
- `worktreeBase` (optional): where to create worktrees, default `/private/tmp/tmux-worktree/projects`
- `notesBase` (optional): where to store session notes, default `/private/tmp/tmux-worktree/notes`

## Usage

```bash
# Create a dev session (tmux + worktree + AI agent)
tmux-worktree <ai-command> <project> [session-name]

# Examples
tmux-worktree claude coco
tmux-worktree claude coco fix-auth-bug
tmux-worktree "claude --model opus" coco refactor

# Status TUI (auto-refresh, click to switch session)
tmux-worktree status

# Single-shot status print
tmux-worktree status --once
```

If not installed globally, prefix with `npx`:

```bash
npx @byted-codebase/tmux-worktree claude coco
```

## Development

```bash
npm install
npm run build
node dist/cli.js status --once          # test status
node dist/cli.js claude coco            # test dev
```

## Publish

```bash
npm run build
npm publish --access public --registry=https://bnpm.byted.org
```
