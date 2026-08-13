# Demo and product film

The built-in preview is the fastest way to understand TW. It uses deterministic fictional data, so it is safe to present, record, or share without exposing repositories, terminal history, hostnames, credentials, or user files.

## Launch the interactive preview

```bash
git clone https://github.com/Sskift/tmux-worktree.git
cd tmux-worktree
npm install
npm --prefix app install
npm run demo
```

Open `http://127.0.0.1:1420/?backend=fake` if the browser does not open automatically.

The query parameter is accepted only in a development or localhost preview context. The fake backend contains three worktrees, one SSH Build Mac, one terminal, one Automation, Git changes and history, and two fictional Android devices.

## A 90-second guided walkthrough

1. **Begin at Overview.** Point out the Agent Inbox, running count, remote Host, paired phones, and Automation count. The story is “everything that needs attention is visible,” not “here is a sidebar.”
2. **Open `dashboard-redesign`.** Show that one click returns to the task's terminal and branch.
3. **Open Git.** Move from changed files to the commit graph. The story is “review in context.”
4. **Open Files → `app/src/GitGraphView.tsx`.** Show that the worktree itself is browsable and editable without leaving the task.
5. **Open Settings → Connections → Relay.** Show the paired devices and one-time enrollment surface. Do not click destructive fake controls during a public walkthrough.
6. **Return to Overview.** End on “Your agents. Your machines. One control room.”

## Official 52-second film

The rendered MP4 is intentionally not checked into Git. Generate it locally with:

```bash
./docs/demo/render-film.sh
```

This writes `docs/assets/tw-dashboard-film.mp4`. The latest hosted version is also embedded in the [Feishu product page](https://bytedance.larkoffice.com/docx/RIHEd0fEyoPTjPx9p7KcEbmWnzc).

The film uses only real preview UI plus a generated launch key visual. It contains no user data. Its rhythm follows a product launch rather than a tutorial:

| Time | Picture | Message |
| --- | --- | --- |
| 00–05s | Black title card and brand orbit | AI is working. You do not have to watch it work. |
| 05–12s | Mission Control overview | One person. A team of agents. |
| 12–20s | Active agent terminal | Every task gets its own workspace. |
| 20–29s | Source editor and Git changes | Terminal, code, and review stay together. |
| 29–37s | Commit topology | Understand the change, not just the answer. |
| 37–44s | Relay and connected phones | Leave the desk. Keep the thread. |
| 44–52s | Cinematic hero and CTA | Your agents. Your machines. One control room. |

## Recording rules

- Record the fake backend unless a real task is necessary to prove a specific behavior.
- Use a fresh browser profile or the native app with notifications hidden.
- Never show `~/.tmux-worktree.json`, SSH identity paths, Relay credentials, pairing URLs, Feishu profile secrets, or real terminal scrollback.
- Keep each shot about one user outcome. Avoid a rapid tour of every button.
- Pair the Overview with one end-to-end task story: start, run, review, hand off, return.

The checked-in stills under `docs/assets/` are all captured from the deterministic preview at 1440×900.
