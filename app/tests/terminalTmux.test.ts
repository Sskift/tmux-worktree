import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("ssh tmux terminals use native tmux mouse scrolling", () => {
  const deckSource = readFileSync(new URL("../src/dashboard/TerminalDeck.tsx", import.meta.url), "utf8");
  const terminalSource = readFileSync(new URL("../src/Terminal.tsx", import.meta.url), "utf8");

  assert.match(deckSource, /function buildSshAttachArgs\(host: HostConfig, rawName: string\): string\[\]/);
  assert.match(deckSource, /export TERM=xterm-256color/);
  assert.match(deckSource, /remoteShellPathExpr\(host\.tmuxPath \|\| "tmux"\)/);
  assert.match(deckSource, /\$\{tmux\} has-session -t/);
  assert.match(deckSource, /copy-selection-and-cancel/);
  assert.match(deckSource, /MouseDragEnd1Pane/);
  assert.doesNotMatch(deckSource, /MouseDown1Pane/);
  assert.match(deckSource, /exec \$\{tmux\} attach-session -t/);
  assert.doesNotMatch(terminalSource, /tmux_scroll/);
  assert.doesNotMatch(terminalSource, /onTmuxWheel/);
  assert.match(terminalSource, /attachCustomWheelEventHandler/);
});

test("remote tmux clipboard uses local macOS clipboard commands", () => {
  const terminalSource = readFileSync(new URL("../src/Terminal.tsx", import.meta.url), "utf8");
  const backendSource = readFileSync(new URL("../src/platform/dashboardBackend.ts", import.meta.url), "utf8");
  const rustSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  assert.match(terminalSource, /dashboardBackend\.sessions\.copySelection\(tmuxSession\)/);
  assert.match(
    backendSource,
    /copySelection: \(name\) =>\s*transport\.invoke<boolean>\("copy_tmux_selection", \{ name \}\)/s,
  );
  assert.doesNotMatch(terminalSource, /readClipboard|read_clipboard_text/);
  assert.doesNotMatch(terminalSource, /term\.paste\(text\)/);
  assert.doesNotMatch(terminalSource, /pasteClipboard/);
  assert.doesNotMatch(terminalSource, /Remote: skip pbcopy/);
  assert.match(rustSource, /fn run_remote_tmux_output/);
  assert.match(rustSource, /run_remote_tmux_output\(&host, &\["save-buffer", "-"\]\)/);
  assert.match(rustSource, /copy_bytes_to_clipboard\(&output\.stdout\)/);
});

test("remote file links keep host identity through the SSH editor", () => {
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const terminalSource = readFileSync(new URL("../src/Terminal.tsx", import.meta.url), "utf8");
  const editorSource = readFileSync(new URL("../src/FileEditor.tsx", import.meta.url), "utf8");
  const backendSource = readFileSync(new URL("../src/platform/dashboardBackend.ts", import.meta.url), "utf8");
  const rustSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  assert.match(terminalSource, /linkCwd\?: string/);
  assert.match(terminalSource, /checkFileExists\(dashboardBackend, resolved, hostId\)/);
  assert.match(terminalSource, /openFile\(resolved, link\.line, link\.col, hostId\)/);
  assert.doesNotMatch(terminalSource, /cwd, linkCwd, tmuxSession/);
  assert.match(appSource, /const nextFile: EditingFile = \{\s*path,\s*hostId: hostId \?\? null,/s);
  assert.match(appSource, /setEditingFile\(nextFile\)/);
  assert.match(appSource, /hostId=\{editingFile\.hostId \?\? null\}/);
  assert.match(editorSource, /dashboardBackend\.files\.readRemote\(hostId, filePath\)/);
  assert.match(editorSource, /dashboardBackend\.files\.writeRemote\(hostId, pathRef\.current, currentContent\)/);
  assert.match(editorSource, /dashboardBackend\.files\.readRemoteBase64\(hostId, filePath\)/);
  assert.match(editorSource, /requestSourceKey\(hostId \?\? null, filePath\)/);
  assert.match(editorSource, /if \(!requestGate\.isCurrent\(request\)\) return;/);
  assert.match(
    backendSource,
    /readRemote: \(hostId, path\) =>\s*transport\.invoke<string>\("remote_read_file", \{ hostId, path \}\)/s,
  );
  assert.match(rustSource, /async fn remote_file_exists/);
  assert.match(rustSource, /async fn remote_read_file/);
  assert.match(rustSource, /async fn remote_write_file/);
});

test("terminal subscribes to pty output before opening the pty", () => {
  const terminalSource = readFileSync(new URL("../src/Terminal.tsx", import.meta.url), "utf8");
  const backendSource = readFileSync(new URL("../src/platform/dashboardBackend.ts", import.meta.url), "utf8");
  const rustSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const idIndex = terminalSource.indexOf("const id = createPtyId();");
  const connectIndex = terminalSource.indexOf("ptyConnection = await dashboardBackend.pty.connect", idIndex);
  const listenDataIndex = backendSource.indexOf("unlistenData = await transport.listen<PtyDataEvent>");
  const listenExitIndex = backendSource.indexOf("unlistenExit = await transport.listen<PtyExitEvent>", listenDataIndex);
  const openIndex = backendSource.indexOf('const openedId = await transport.invoke<string>("pty_open"', listenExitIndex);

  assert.ok(idIndex >= 0, "terminal should create the pty id before opening");
  assert.ok(connectIndex > idIndex, "terminal should connect through the typed PTY facade after creating the id");
  assert.ok(listenDataIndex >= 0, "the PTY facade should register its output listener");
  assert.ok(listenExitIndex > listenDataIndex, "the PTY facade should register its exit listener after output");
  assert.ok(openIndex > listenExitIndex, "the PTY facade should open the pty after registering listeners");
  assert.match(terminalSource, /dashboardBackend\.pty\.connect\(\s*\{ id, cmd, args, cwd, cols, rows \}/s);
  assert.match(backendSource, /transport\.invoke<string>\("pty_open", \{ args \}\)/);
  assert.match(rustSource, /id: Option<String>/);
});

test("reactivating a terminal does not steal an overlay focus return", () => {
  const source = readFileSync(new URL("../src/Terminal.tsx", import.meta.url), "utf8");
  assert.match(source, /function canTerminalClaimFocus/);
  assert.match(source, /focused === document\.body/);
  assert.match(source, /Boolean\(host\?\.contains\(focused\)\)/);
  assert.match(source, /if \(canTerminalClaimFocus\(hostRef\.current\)\) term\.focus\(\)/);
  assert.match(source, /termRef\.current !== term \|\| fitRef\.current !== fit/);
  assert.match(source, /return \(\) => cancelAnimationFrame\(animationFrame\)/);
});

test("tmux status bar receives the active dashboard terminal palette", () => {
  const source = readFileSync(new URL("../src/Terminal.tsx", import.meta.url), "utf8");
  const backend = readFileSync(new URL("../src/platform/dashboardBackend.ts", import.meta.url), "utf8");
  const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  assert.match(source, /function tmuxStatusThemeFromPalette\(palette: TerminalPalette\): TmuxStatusTheme/);
  assert.match(source, /function applyTmuxStatusTheme\(\s*dashboardBackend: DashboardBackend,\s*tmuxSession: string \| undefined,\s*palette: TerminalPalette,/s);
  assert.match(source, /\.applyTheme\(tmuxSession, tmuxStatusThemeFromPalette\(palette\)\)/);
  assert.match(
    backend,
    /applyTheme: \(name, theme\) =>\s*transport\.invoke<void>\("apply_tmux_theme", \{ name, theme \}\)/s,
  );
  assert.match(source, /if \(!activeRef\.current\) return;/);
  assert.match(source, /applyTmuxStatusTheme\(dashboardBackend, tmuxSession, detail\)/);
  assert.match(source, /applyTmuxStatusTheme\(dashboardBackend, tmuxSession, palette\)/);
  assert.match(rust, /fn apply_tmux_options\(host: Option<&HostConfig>, args: &\[&str\]\) -> Result<\(\), String>/);
  assert.match(rust, /"status-style",\s*&status_style,\s*";",\s*"set-option"/s);
  assert.doesNotMatch(rust, /for args in \[/);
});
