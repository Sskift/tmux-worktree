# Troubleshooting

Start with the command that checks the whole local runtime:

```bash
tw doctor
```

## `tw` is not found

Build and link the CLI again from the repository root:

```bash
npm install
npm run build
npm link
command -v tw
tw version
```

If a remote Host is failing, run the same checks on that Host. The Dashboard and remote lifecycle implementation must be compatible.

## tmux or Node.js is missing

On macOS:

```bash
brew install tmux node
tmux -V
node --version
```

TW expects Node.js 20 or newer. A working SSH connection does not imply that tmux or the remote `tw` runtime is ready.

## The Dashboard cannot read a repository

If the repository or linked main checkout is under Desktop, Documents, or Downloads, allow the macOS folder-access prompt. Then close and reopen the affected workspace.

Also confirm that the path is a Git repository:

```bash
git -C /path/to/repository status
git -C /path/to/repository worktree list
```

## A Host is reachable but shown as not ready

Probe the layers separately:

```bash
tw host probe <host-id> --json
```

Check the result for SSH reachability, tmux, TW version, and lifecycle capabilities. Install or upgrade the missing remote dependency instead of treating every failure as an SSH outage.

## A session is visible but cannot accept input

Input can be intentionally read-only when Feishu owns the exact target, a handoff is draining, a stale client carries an old fence, or authority continuity needs recovery.

Use the Dashboard's visible takeover/recovery action. Do not bypass the controller with raw tmux input unless you explicitly accept that it is outside the protected product path.

## Scheduled Automation did not run

The current scheduler belongs to the Dashboard process.

- Keep the Dashboard running.
- Confirm the Automation is enabled.
- Check the cron expression and timezone.
- Check the overlap policy if a previous run is still active.
- Inspect recent runs in the Automation panel.

## The fake demo opens an empty or real backend

Use the exact localhost URL:

```text
http://127.0.0.1:1420/?backend=fake
```

Launch it with:

```bash
npm run demo
```

The fake backend is intentionally restricted to development or localhost preview contexts.

## Android cannot pair

- Confirm the current debug APK was built from the same repository revision you are evaluating.
- Confirm the Dashboard's Relay surface reports a running Host connector before creating the one-time link.
- Check device time and pairing expiry.
- Use a trusted HTTPS/WSS endpoint outside local development.
- Do not reuse or publish a pairing link.

## Feishu messages do not reach the session

- Confirm `lark-cli` bot identity and scopes outside TW first.
- Confirm the bridge consumer is running in **Settings → Integrations**.
- Confirm the group is bound to the intended exact local session.
- Mention the bot explicitly from a real user account.
- Check whether the binding is paused, stale, draining, or awaiting recovery.
- Do not change the selected `lark-cli` profile while bindings or turns exist.

## Safe cleanup

Inspect orphaned worktrees before deleting anything:

```bash
tw worktree ls
tw worktree prune --dry-run
```

To remove one session and its worktree:

```bash
tw rm <session-name> --worktree
```

TW refuses to delete a dirty worktree unless `--force` is explicitly supplied. Review or commit the changes first whenever possible.
