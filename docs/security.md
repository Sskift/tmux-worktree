# Security model

TW coordinates terminals and code, so its security model is built around explicit machine ownership, exact task identity, and fail-closed input.

## Local first by default

Local worktrees, tmux sessions, Git repositories, terminal metadata, layout, and Automation definitions stay on the machine that owns them. TW does not require uploading a repository to a hosted IDE and does not provide a vendor SaaS control plane.

Common local state includes:

| Path | Purpose |
| --- | --- |
| `~/.tmux-worktree.json` | Projects, SSH Hosts, worktree base, and non-sensitive integration selection. |
| `~/.tmux-worktree/state.json` | Managed session and worktree registry. |
| `~/.tw-dashboard-layout.json` | Window, panel, ordering, and selection state. |
| `~/.tw-dashboard-terminals.json` | Saved standalone terminal metadata. |
| `~/.tw-dashboard-automations.json` | Automation definitions. |
| `~/.tw-dashboard-automation-runs.json` | Recent bounded run history. |
| `~/.tmux-worktree/terminal-control-state-v1.json` | Terminal target, epoch, ownership, lease, and fencing state. |

These files are control metadata, not substitutes for Git or tmux authority. Git owns repository and worktree truth; the target host's tmux server owns live session truth.

## Exact targets, not reusable names

Terminal input is authorized against an opaque `controlTargetId` representing one exact backend lifecycle. If a tmux session is deleted and recreated with the same visible name, it receives a different target identity. A Feishu binding or stale input lease cannot silently follow the reused name.

## One input authority

Supported Dashboard, controlled CLI, Relay, Android, and Feishu input paths converge on the target host's terminal-control authority. Every write carries an authority epoch, lease, fence, owner identity, and operation identity.

Observation does not grant input permission. Opening a terminal stream, reading output, reconnecting a phone, or seeing a session in the catalog cannot become an implicit keyboard lease.

Interactive writers can share the interactive ownership class and are serialized by the same target-scoped writer. Feishu ownership is exclusive. Moving between Feishu and interactive control advances fencing so callbacks or cached writers from the old class are rejected before backend input.

## Fail closed on uncertainty

TW does not automatically replay terminal input when it cannot prove whether a previous write executed. Unknown operation disposition, lost ownership continuity, an in-progress handoff, or an unprovable exact target moves the task into a recovery path and rejects new input until a controlled owner resolves it.

Lifecycle deletion follows the same principle. Dirty worktrees are not removed without an explicit force choice.

## SSH and self-hosted Relay

SSH Hosts are machines the operator configures and controls. TW uses an isolated SSH ControlMaster and probes SSH, tmux, and TW lifecycle compatibility separately.

Relay v2's current self-hosted deployment is an explicit personal/single-node profile. Use trusted HTTPS/WSS certificates, owner-only files for private material, and a host you administer. It is not a multi-tenant service boundary for unrelated users.

Pairing links and credentials must be treated as secrets even when short-lived. Do not include them in screenshots, tickets, chat messages, or repository files.

## Android credentials

The Android client stores durable product state in its local databases and keeps sensitive credential material behind Android Keystore-backed encryption. Cached mobile state is not remote authority: an offline or incomplete cache cannot prove that a remote task has been deleted.

The repository currently produces a debug device-test APK. Treat it accordingly and do not present it as a signed production distribution.

## Feishu credentials and bindings

Feishu bot secrets and authorization belong to `lark-cli`. TW stores the selected profile name, binding lifecycle, deduplication state, and reply disposition, but does not copy the bot secret into Dashboard configuration.

A binding targets one exact local managed session. Authorized group messages must explicitly mention the bot. Handoff between Feishu and local control is a state transition, not a best-effort convention.

## Responsible disclosure

If you believe you found a security issue, avoid posting credentials, pairing links, real terminal output, or exploit details in a public issue. Contact the repository maintainer privately first and include the minimum reproduction needed to identify the affected version and boundary.
