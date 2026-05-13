# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

`tmux-worktree` (`tw`) is a CLI + desktop app that automates AI-assisted development environments. It creates isolated git worktrees, sets up tmux sessions with split panes (status panel / AI tool / terminal), and provides a Tauri-based dashboard GUI for managing sessions.

Published to `bnpm.byted.org` as `@byted-codebase/tmux-worktree`.

## Build & Dev Commands

### CLI (root)
```bash
npm install                          # install CLI dependencies
npm run build                        # build CLI with tsup (ESM, node20 target)
node dist/cli.js status --once       # test status TUI (single-shot)
node dist/cli.js claude coco         # test dev session creation
```

### Dashboard App (app/)
```bash
cd app
npm install                          # install frontend dependencies
npm run tauri dev                    # run Tauri app in dev mode (Vite + Rust)
npm run tauri build                  # production build (.dmg)
npm run dev                          # Vite dev server only (no Tauri shell)
```

### Publish
```bash
make publish                         # bumps version, builds, publishes to bnpm
```

## Architecture

Two independent artifacts share the same config (`~/.tmux-worktree.json`):

### CLI (`src/`)
- **`src/cli.ts`** — Entry point. Routes to `status` or `dev` subcommand based on `process.argv[2]`.
- **`src/dev.ts`** — Core worktree+tmux session creation. Loads config, detects default branch, creates git worktree, sets up tmux with 3 panes (status | AI cmd | terminal). Supports both interactive and CLI arg modes.
- **`src/status.ts`** — TUI status panel that runs in the leftmost tmux pane. Renders session list with ANSI colors, handles SGR mouse events for click-to-switch and close. Refreshes every 2s.

Built with `tsup` → `dist/cli.js` (single ESM bundle, no runtime deps).

### Dashboard App (`app/`)
A Tauri v2 desktop app (React + Rust) that replaces the terminal-based status panel with a full GUI.

**Frontend** (`app/src/`): React 19 + Vite + xterm.js. `App.tsx` is the main component with a 3-column resizable layout: sidebar (session list + git status) | terminal (tmux attach via PTY) | scratch panel. The scratch panel supports multiple terminals per selection with add/close buttons and draggable section dividers. Sessions and plain terminals are in separate sidebar sections with drag-to-reorder (via `useSortable` hook with directional before/after indicators). Terminal labels support inline rename via double-click.

**Backend** (`app/src-tauri/src/lib.rs`): Single-file Rust backend. All logic is in Tauri commands:
- Session management: `list_sessions`, `create_worktree`, `kill_session` — shells out to tmux/git
- PTY management: `pty_open`, `pty_write`, `pty_resize`, `pty_kill` — uses `portable-pty` crate, streams output via Tauri events (`pty:{id}`, `pty-exit:{id}`)
- Git: `git_status` (porcelain v2 parser), `git_log` (custom format parser)
- Persistence: layout and terminal state saved to `~/.tw-dashboard-layout.json` and `~/.tw-dashboard-terminals.json`
- Utility: `home_dir` — exposes the user's home directory to the frontend (used by NewTerminalModal to default to ~/Desktop)

Key detail: `inherit_shell_env()` runs at startup to import the user's login shell environment (PATH, TMUX_TMPDIR, etc.) since macOS .app bundles launch with minimal env.

### Sidebar Layout Model
The sidebar has three vertically stacked regions: worktrees section, terminals section, and git panel. The worktrees/terminals split uses a pixel-based `sectionSplit` value (default 200px) — the worktrees section gets a fixed height and terminals fills remaining space. The git panel height is also pixel-based and is clamped so it can't push past the terminals section boundary. Legacy ratio-based `sectionSplit` values (< 1) from old layouts are migrated to the default pixel value on load.

### Shared Conventions
- tmux sessions for plain terminals are prefixed `tw-term-` and filtered out of the session list
- Session names follow `<project>-<title>` format; project colors are derived from the prefix before the first `-`
- Both CLI and dashboard detect the default branch via `symbolic-ref refs/remotes/origin/HEAD`, falling back to master/main
- Config at `~/.tmux-worktree.json`: `projects` maps names to repo paths; `worktreeBase` controls where worktrees go (default `/private/tmp/tmux-worktree/projects`)

## Language & UI Notes

User-facing strings in the CLI are in Chinese (简体中文). The dashboard UI is in English.
