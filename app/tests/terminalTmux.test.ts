import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("ssh tmux terminals use native tmux mouse scrolling", () => {
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const terminalSource = readFileSync(new URL("../src/Terminal.tsx", import.meta.url), "utf8");

  assert.match(appSource, /function buildSshAttachArgs\(host: HostConfig, rawName: string\): string\[\]/);
  assert.match(appSource, /export TERM=xterm-256color/);
  assert.match(appSource, /remoteShellPathExpr\(host\.tmuxPath \|\| "tmux"\)/);
  assert.match(appSource, /\$\{tmux\} has-session -t/);
  assert.match(appSource, /copy-selection-and-cancel/);
  assert.match(appSource, /MouseDragEnd1Pane/);
  assert.doesNotMatch(appSource, /MouseDown1Pane/);
  assert.match(appSource, /exec \$\{tmux\} attach-session -t/);
  assert.doesNotMatch(terminalSource, /tmux_scroll/);
  assert.doesNotMatch(terminalSource, /onTmuxWheel/);
  assert.match(terminalSource, /attachCustomWheelEventHandler/);
});

test("remote tmux clipboard uses local macOS clipboard commands", () => {
  const terminalSource = readFileSync(new URL("../src/Terminal.tsx", import.meta.url), "utf8");
  const rustSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  assert.match(terminalSource, /invoke<boolean>\("copy_tmux_selection"/);
  assert.doesNotMatch(terminalSource, /invoke<string>\("read_clipboard_text"/);
  assert.doesNotMatch(terminalSource, /term\.paste\(text\)/);
  assert.doesNotMatch(terminalSource, /pasteClipboard/);
  assert.doesNotMatch(terminalSource, /Remote: skip pbcopy/);
  assert.match(rustSource, /fn run_remote_tmux_output/);
  assert.match(rustSource, /run_remote_tmux_output\(&host, &\["save-buffer", "-"\]\)/);
  assert.match(rustSource, /copy_bytes_to_clipboard\(&output\.stdout\)/);
});

test("terminal subscribes to pty output before opening the pty", () => {
  const terminalSource = readFileSync(new URL("../src/Terminal.tsx", import.meta.url), "utf8");
  const rustSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const idIndex = terminalSource.indexOf("const id = createPtyId();");
  const listenIndex = terminalSource.indexOf("unlistenChunk = await listen", idIndex);
  const openIndex = terminalSource.indexOf('const openedId = await invoke<string>("pty_open"', idIndex);

  assert.ok(idIndex >= 0, "terminal should create the pty id before opening");
  assert.ok(listenIndex > idIndex, "terminal should register the output listener after creating the id");
  assert.ok(openIndex > listenIndex, "terminal should open the pty after registering listeners");
  assert.match(terminalSource, /args: \{ id, cmd, args, cwd, cols, rows \}/);
  assert.match(rustSource, /id: Option<String>/);
});

test("tmux status bar receives the active dashboard terminal palette", () => {
  const source = readFileSync(new URL("../src/Terminal.tsx", import.meta.url), "utf8");
  const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  assert.match(source, /function tmuxStatusThemeFromPalette\(palette: TerminalPalette\): TmuxStatusTheme/);
  assert.match(source, /function applyTmuxStatusTheme\(tmuxSession: string \| undefined, palette: TerminalPalette\)/);
  assert.match(source, /invoke\("apply_tmux_theme", \{/);
  assert.match(source, /if \(!activeRef\.current\) return;/);
  assert.match(source, /applyTmuxStatusTheme\(tmuxSession, detail\)/);
  assert.match(source, /applyTmuxStatusTheme\(tmuxSession, palette\)/);
  assert.match(rust, /fn apply_tmux_options\(host: Option<&HostConfig>, args: &\[&str\]\) -> Result<\(\), String>/);
  assert.match(rust, /"status-style",\s*&status_style,\s*";",\s*"set-option"/s);
  assert.doesNotMatch(rust, /for args in \[/);
});
