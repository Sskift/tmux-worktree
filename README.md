# @byted-codebase/tmux-worktree

AI + tmux + git worktree development environment, with a TUI status dashboard.

## Usage

```bash
# Create a dev session (tmux + worktree + AI agent)
npx @byted-codebase/tmux-worktree <ai-command> <project> [session-name]

# Examples
npx @byted-codebase/tmux-worktree claude coco
npx @byted-codebase/tmux-worktree claude coco fix-auth-bug
npx @byted-codebase/tmux-worktree "claude --model opus" coco refactor

# Status TUI (auto-refresh, click to switch session)
npx @byted-codebase/tmux-worktree status

# Single-shot status print
npx @byted-codebase/tmux-worktree status --once
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
