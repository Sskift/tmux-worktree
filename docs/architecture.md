# Architecture

TW is one product with four surfaces and a small set of strict authority boundaries.

```text
                         ┌──────────────────────┐
                         │   TW Dashboard       │
                         │  Tauri + React       │
                         └──────────┬───────────┘
                                    │
           ┌────────────────────────┼────────────────────────┐
           │                        │                        │
  ┌────────▼────────┐      ┌────────▼────────┐      ┌────────▼────────┐
  │ local `tw`      │      │ SSH Host `tw`   │      │ Feishu bridge  │
  │ Git + tmux      │      │ Git + tmux      │      │ exact binding  │
  └────────┬────────┘      └────────┬────────┘      └────────┬────────┘
           │                        │                        │
           └──────────────┬─────────┴────────────────────────┘
                          │ target-scoped terminal control
                          ▼
                 exact session lifecycle

       TW Mobile ── Relay v2 broker/Host connector ──┘
```

## Product surfaces

**Dashboard.** The native macOS application owns presentation: the Mission Control overview, worktree and terminal catalog, file tree, editor, Git panels, settings, layout, and Automation UI. React talks through a `DashboardBackend`; platform mutations remain behind the Tauri boundary.

**CLI.** The `tw` binary owns headless managed lifecycle operations. A new agent task becomes a branch, Git worktree, managed single-pane tmux session, and durable registry entry. The CLI also exposes host, Automation, context, agent inspection, Feishu bridge, Relay, and machine-readable RPC commands.

**Remote Host.** An SSH Host runs its own compatible `tw`, Git, and tmux. The local Dashboard discovers and mutates remote managed tasks through the remote lifecycle contract rather than reproducing worktree creation in the UI.

**Mobile and Relay.** Relay v2 connects an Android client to a Host connector through a broker. Public Relay session identity remains separate from local terminal-control identity; mapping happens at the trusted Host boundary.

**Feishu bridge.** A local daemon owns group event consumption, exact session bindings, turn correlation, steering, and idempotent replies. It requests terminal input through the same local authority as other supported writers.

## Authority boundaries

| Truth | Authority |
| --- | --- |
| Repository, branch, and worktree contents | Git on the target host |
| Live processes and terminal panes | tmux on the target host |
| Managed task lifecycle | `tw` state and lifecycle RPC on the target host |
| Terminal input ownership and ordering | Target host terminal-control authority |
| Dashboard presentation and layout | Dashboard-local state |
| Relay transport, stream generations, and command ledger | Relay v2 runtime |
| Feishu binding, turn, deduplication, and reply disposition | Feishu bridge |

These authorities can consult each other but cannot impersonate each other. A cached Dashboard row does not resurrect a dead tmux session. A Relay stream does not grant terminal input. A Feishu binding status without a current lease does not prove ownership.

## Managed task lifecycle

1. Resolve a configured project or direct Git repository path.
2. Choose a base branch and target host.
3. Create an isolated branch and Git worktree.
4. Create a managed single-pane tmux session in that worktree.
5. Optionally launch the selected agent command; when it exits, return to a login shell.
6. Persist enough identity to discover, restore, or safely remove the task later.

Compatibility discovery may surface older sessions, but new mutations use the canonical lifecycle path. Failure in the managed state or authority chain does not authorize a hidden fallback creator.

## Preview architecture

`app/src/platform/previewBackend.ts` implements a deterministic fake `DashboardBackend`. `app/src/main.tsx` selects it only when `?backend=fake` is requested from a development or localhost page. This gives documentation, tests, and demos a stable product surface without reading real machine state.
