import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { managedStatePath, loadManagedStateForMutation, type ManagedSession } from "../state";
import { tmuxBin } from "../tmux";
import {
  TERMINAL_CONTROL_OUTPUT_RETAINED_MIN_BYTES,
  TerminalControlProtocolError,
} from "./protocol";

const TMUX_INSTANCE_OPTION = "@tw_terminal_control_instance_v1";
const OUTPUT_GENERATION_OPTION = "@tw_terminal_control_output_generation_v1";
const COMMAND_TIMEOUT_MS = 5_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_FILE_BYTES = 8 * 1024 * 1024;
const OUTPUT_SEGMENT_BYTES = TERMINAL_CONTROL_OUTPUT_RETAINED_MIN_BYTES;
const MAX_OUTPUT_SEGMENTS = 2;
const AGENT_MESSAGE_SUBMIT_PACE_MS = 100;

// xterm emits client-terminal escape sequences for special keys. Pasting
// those bytes directly into a pane bypasses tmux's key translation, so TUIs
// can receive the trailing characters as text (for example "[D" for Left).
// Route exact single-key frames through `send-keys`; arbitrary text and paste
// payloads still use the load-buffer path below. tmux 3.7 renders a DEL byte
// pasted from a buffer as the two visible bytes "^?", so Backspace uses the
// hexadecimal send-keys form. This preserves one literal 0x7f byte without
// relying on tmux's named BSpace lookup.
const TMUX_KEY_BY_RAW_HEX = new Map<string, string>([
  ["1b5b41", "Up"],
  ["1b4f41", "Up"],
  ["1b5b42", "Down"],
  ["1b4f42", "Down"],
  ["1b5b43", "Right"],
  ["1b4f43", "Right"],
  ["1b5b44", "Left"],
  ["1b4f44", "Left"],
  ["1b5b48", "Home"],
  ["1b4f48", "Home"],
  ["1b5b317e", "Home"],
  ["1b5b377e", "Home"],
  ["1b5b46", "End"],
  ["1b4f46", "End"],
  ["1b5b347e", "End"],
  ["1b5b387e", "End"],
  ["1b5b327e", "IC"],
  ["1b5b337e", "DC"],
  ["1b5b357e", "PPage"],
  ["1b5b367e", "NPage"],
  ["1b5b5a", "BTab"],
  ["0d", "Enter"],
  ["09", "Tab"],
  ["1b", "Escape"],
  ["1b4f50", "F1"],
  ["1b4f51", "F2"],
  ["1b4f52", "F3"],
  ["1b4f53", "F4"],
  ["1b5b31357e", "F5"],
  ["1b5b31377e", "F6"],
  ["1b5b31387e", "F7"],
  ["1b5b31397e", "F8"],
  ["1b5b32307e", "F9"],
  ["1b5b32317e", "F10"],
  ["1b5b32337e", "F11"],
  ["1b5b32347e", "F12"],
]);

type TmuxRawKey =
  | { kind: "named"; value: string }
  | { kind: "hex"; value: string };

function tmuxKeyForRawInput(data: Buffer): TmuxRawKey | undefined {
  const rawHex = data.toString("hex");
  if (rawHex === "7f") return { kind: "hex", value: rawHex };
  const named = TMUX_KEY_BY_RAW_HEX.get(rawHex);
  return named ? { kind: "named", value: named } : undefined;
}

function tmuxSendKeyArgs(paneTarget: string, key: TmuxRawKey): string[] {
  return key.kind === "hex"
    ? ["send-keys", "-H", "-t", paneTarget, key.value]
    : ["send-keys", "-t", paneTarget, key.value];
}

function tmuxSendKeyCommand(paneTarget: string, key: TmuxRawKey): string {
  return tmuxSendKeyArgs(paneTarget, key).join(" ");
}

export interface TerminalControlOutputPosition {
  generation: string;
  cursor: number;
}

export interface TerminalControlOutputChunk extends TerminalControlOutputPosition {
  dataBase64: string;
  nextCursor: number;
}

export interface ResolvedManagedTerminalBackend {
  managedSession: ManagedSession;
  tmuxInstanceId: string;
}

export interface TerminalControlBackend {
  resolveManagedSession(sessionName: string): Promise<ResolvedManagedTerminalBackend>;
  assertCurrent(
    session: Pick<ManagedSession, "name" | "kind" | "createdAt">,
    tmuxInstanceId: string,
  ): Promise<void>;
  writeRaw(sessionName: string, pane: string, data: Buffer): Promise<void>;
  rawInputPosition?(
    controlTargetId: string,
    generation: string,
  ): Promise<TerminalControlOutputPosition>;
  writeRawFenced?(
    session: Pick<ManagedSession, "name" | "kind" | "createdAt">,
    tmuxInstanceId: string,
    outputGeneration: string,
    pane: string,
    data: Buffer,
  ): Promise<void>;
  sendAgentMessage(sessionName: string, pane: string, message: string, submit: boolean): Promise<void>;
  resize(sessionName: string, pane: string, cols: number, rows: number): Promise<void>;
  scroll(sessionName: string, pane: string, direction: "up" | "down", lines: number): Promise<void>;
  killManaged(sessionName: string): Promise<void>;
  prepareOutput(
    controlTargetId: string,
    sessionName: string,
    pane: string,
    generation?: string,
  ): Promise<TerminalControlOutputPosition>;
  resetOutput(
    controlTargetId: string,
    sessionName: string,
    pane: string,
    previousGeneration: string,
  ): Promise<TerminalControlOutputPosition>;
  tailOutput(
    controlTargetId: string,
    sessionName: string,
    pane: string,
    generation: string,
    cursor: number,
    maxBytes: number,
  ): Promise<TerminalControlOutputChunk>;
}

type TmuxResult = {
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};

function validateSessionName(name: string): void {
  if (!name || name.length > 128 || /[\0-\x1f\x7f]/.test(name)) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "managed session name is invalid");
  }
}

function runTmux(
  args: string[],
  options: { input?: Buffer | string; allowFailure?: boolean } = {},
): Promise<TmuxResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tmuxBin(), args, {
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: TmuxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(new Error(`tmux command timed out: ${args[0] || "unknown"}`));
    }, COMMAND_TIMEOUT_MS);
    timer.unref();

    child.stdout!.on("data", (raw: Buffer) => {
      stdoutBytes += raw.byteLength;
      if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) {
        try { child.kill("SIGKILL"); } catch {}
        finish(new Error("tmux stdout exceeded the terminal-control limit"));
        return;
      }
      stdout.push(Buffer.from(raw));
    });
    child.stderr!.on("data", (raw: Buffer) => {
      stderrBytes += raw.byteLength;
      if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) {
        try { child.kill("SIGKILL"); } catch {}
        finish(new Error("tmux stderr exceeded the terminal-control limit"));
        return;
      }
      stderr.push(Buffer.from(raw));
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      const result = {
        stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
        exitCode: code,
        signal,
      };
      if (code === 0 && signal === null) {
        finish(undefined, result);
        return;
      }
      if (options.allowFailure) {
        finish(undefined, result);
        return;
      }
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(code)}${signal ? ` (${signal})` : ""}`;
      finish(new Error(`tmux ${args[0] || "command"} failed: ${detail}`));
    });
    if (child.stdin) {
      child.stdin.once("error", (error) => finish(error));
      child.stdin.end(options.input);
    }
  });
}

function controlCommandMarker(
  stdout: string,
  markers: readonly string[],
): string {
  const expected = new Set(markers);
  let block: { timestamp: string; command: string; output: string[] } | undefined;
  for (const line of stdout.replaceAll("\r\n", "\n").split("\n")) {
    const begin = /^%begin (\d+) (\d+) \d+$/.exec(line);
    if (begin) {
      block = { timestamp: begin[1], command: begin[2], output: [] };
      continue;
    }
    if (!block) continue;
    const end = /^%(end|error) (\d+) (\d+) \d+$/.exec(line);
    if (!end) {
      block.output.push(line);
      continue;
    }
    if (end[2] !== block.timestamp || end[3] !== block.command) {
      throw new Error("tmux control-mode command boundary was malformed");
    }
    const marker = block.output.find((candidate) => expected.has(candidate));
    if (marker) {
      if (end[1] === "error") {
        const detail = block.output.filter((candidate) => candidate !== marker).join(" ").trim();
        throw new Error(`tmux control-mode key command failed${detail ? `: ${detail}` : ""}`);
      }
      return marker;
    }
    block = undefined;
  }
  throw new Error("tmux control-mode client did not confirm the key command boundary");
}

/**
 * A Dashboard observes managed sessions through a read-only tmux client. tmux
 * rejects `send-keys` commands whose command context is that client, even when
 * the caller targets the pane explicitly. Use a short-lived, no-output control
 * client as the command context for translated special keys. It never receives
 * user input, does not resize the session, and returns a structured command
 * block whose `%end` is the proof that the key command and marker both ran.
 */
function runTmuxWritableControlCommand(
  sessionName: string,
  command: string,
  markers: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tmuxBin(), [
      "-C",
      "attach-session",
      "-E",
      "-f",
      "ignore-size,no-output",
      "-t",
      `=${sessionName}`,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(controlCommandMarker(Buffer.concat(stdout, stdoutBytes).toString("utf8"), markers));
      } catch (parseError) {
        reject(parseError);
      }
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(new Error("tmux control-mode key command timed out"));
    }, COMMAND_TIMEOUT_MS);
    timer.unref();

    child.stdout!.on("data", (raw: Buffer) => {
      stdoutBytes += raw.byteLength;
      if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) {
        try { child.kill("SIGKILL"); } catch {}
        finish(new Error("tmux control-mode stdout exceeded the terminal-control limit"));
        return;
      }
      stdout.push(Buffer.from(raw));
    });
    child.stderr!.on("data", (raw: Buffer) => {
      stderrBytes += raw.byteLength;
      if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) {
        try { child.kill("SIGKILL"); } catch {}
        finish(new Error("tmux control-mode stderr exceeded the terminal-control limit"));
        return;
      }
      stderr.push(Buffer.from(raw));
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        finish();
        return;
      }
      const detail = Buffer.concat(stderr, stderrBytes).toString("utf8").trim()
        || Buffer.concat(stdout, stdoutBytes).toString("utf8").trim()
        || `exit ${String(code)}${signal ? ` (${signal})` : ""}`;
      finish(new Error(`tmux control-mode key command failed: ${detail}`));
    });
    child.stdin!.once("error", (error) => finish(error));
    child.stdin!.end(`${command}\ndetach-client\n`);
  });
}

function exactManagedSession(sessionName: string, home = homedir()): ManagedSession {
  validateSessionName(sessionName);
  let state;
  try {
    state = loadManagedStateForMutation(managedStatePath(home));
  } catch (error) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      error instanceof Error ? error.message : "managed state continuity is uncertain",
    );
  }
  const matches = state.sessions.filter((session) => session.name === sessionName);
  if (matches.length === 0) {
    throw new TerminalControlProtocolError(
      "TARGET_NOT_FOUND",
      `session is not TW-managed: ${sessionName}`,
    );
  }
  if (matches.length > 1) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      `managed state contains ambiguous session identity: ${sessionName}`,
    );
  }
  return matches[0];
}

function tmuxSessionDefinitelyMissing(result: TmuxResult): boolean {
  if (result.exitCode === 0 && result.signal === null) return false;
  const detail = `${result.stderr}\n${result.stdout}`;
  return /can't find session|no server running on/i.test(detail);
}

async function requireTmuxSession(
  sessionName: string,
  missingCode: "TARGET_NOT_FOUND" | "TARGET_GONE",
): Promise<string> {
  let result: TmuxResult;
  try {
    result = await runTmux([
      "list-sessions", "-F", "#{session_name}\u001f#{session_id}",
    ], { allowFailure: true });
  } catch (error) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      `could not prove tmux backend identity: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.exitCode !== 0 || result.signal !== null) {
    if (tmuxSessionDefinitelyMissing(result)) {
      throw new TerminalControlProtocolError(missingCode, "tmux backend lifecycle no longer exists");
    }
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "could not prove whether the tmux backend lifecycle still exists",
    );
  }
  const rows = result.stdout.split("\n").filter(Boolean).map((line) => line.split("\u001f"));
  if (rows.some((row) => row.length !== 2 || !/^\$\d+$/.test(row[1]))) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "tmux returned a malformed session identity catalog",
    );
  }
  const matches = rows.filter(([name]) => name === sessionName);
  if (matches.length === 0) {
    throw new TerminalControlProtocolError(missingCode, "tmux backend lifecycle no longer exists");
  }
  if (matches.length !== 1) {
    throw new TerminalControlProtocolError("RECOVERY_REQUIRED", "tmux session identity is ambiguous");
  }
  return matches[0][1];
}

async function currentTmuxInstanceId(sessionId: string): Promise<string | undefined> {
  const result = await runTmux(
    ["show-options", "-v", "-t", sessionId, TMUX_INSTANCE_OPTION],
    { allowFailure: true },
  );
  if (result.exitCode !== 0 || result.signal !== null) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    if (detail && !/(?:unknown|invalid) option/i.test(detail)) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "could not read the tmux backend lifecycle identity",
      );
    }
    return undefined;
  }
  const value = result.stdout.trim();
  return value || undefined;
}

async function requirePane(
  sessionName: string,
  pane: string,
): Promise<{ sessionId: string; paneTarget: string }> {
  if (pane !== "0") {
    throw new TerminalControlProtocolError(
      "INVALID_REQUEST",
      `managed single-pane target has no logical pane: ${pane}`,
    );
  }
  const sessionId = await requireTmuxSession(sessionName, "TARGET_GONE");
  const result = await runTmux([
    "list-panes",
    "-s",
    "-t",
    sessionId,
    "-F",
    "#{pane_index}\u001f#{pane_id}",
  ]);
  const panes = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\u001f"));
  if (
    panes.some((row) => row.length !== 2 || !/^\d+$/.test(row[0]) || !/^%\d+$/.test(row[1]))
  ) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "tmux returned a malformed managed pane identity",
    );
  }
  if (panes.length !== 1) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      `managed single-pane target has ${panes.length} live panes`,
    );
  }
  return { sessionId, paneTarget: panes[0][1] };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function outputRoot(home = homedir()): string {
  return process.env.TW_TERMINAL_CONTROL_OUTPUT_DIR?.trim()
    || join(home, ".tmux-worktree", "terminal-control-output-v1");
}

type OutputCapturePaths = {
  directory: string;
  generationHash: string;
  legacyPath: string;
};

type OutputSegment = {
  path: string;
  start: number;
  size: number;
};

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output directory is not a private real directory",
    );
  }
  chmodSync(path, 0o700);
}

function outputCapturePaths(controlTargetId: string, generation: string): OutputCapturePaths {
  const target = createHash("sha256").update(controlTargetId, "utf8").digest("hex");
  const generationHash = createHash("sha256").update(generation, "utf8").digest("hex");
  const directory = join(outputRoot(), target);
  privateDirectory(outputRoot());
  privateDirectory(directory);
  return {
    directory,
    generationHash,
    legacyPath: join(directory, `${generationHash}.bin`),
  };
}

function segmentPath(paths: OutputCapturePaths, start: number): string {
  return join(paths.legacyPath, `${paths.generationHash}.${start}.segment`);
}

function outputCaptureKind(paths: OutputCapturePaths): "missing" | "legacy" | "segmented" {
  if (!existsSync(paths.legacyPath)) return "missing";
  const stat = lstatSync(paths.legacyPath);
  const uid = process.getuid?.();
  if (stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output generation is not a private owned filesystem entry",
    );
  }
  if (stat.isFile()) return "legacy";
  if (stat.isDirectory()) {
    chmodSync(paths.legacyPath, 0o700);
    return "segmented";
  }
  throw new TerminalControlProtocolError(
    "RECOVERY_REQUIRED",
    "terminal output generation has an unsupported filesystem type",
  );
}

function assertPrivateOutputFile(path: string, maxBytes?: number): Stats {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output capture file is not a private regular file",
    );
  }
  chmodSync(path, 0o600);
  if (maxBytes !== undefined && stat.size > maxBytes) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output capture segment exceeded its bounded size",
    );
  }
  return stat;
}

function ensureOutputFile(path: string): void {
  if (!existsSync(path)) {
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
  }
  const stat = assertPrivateOutputFile(path);
  if (stat.size >= MAX_OUTPUT_FILE_BYTES) {
    throw new TerminalControlProtocolError(
      "RESOURCE_EXHAUSTED",
      "terminal output generation exceeded its bounded capture limit",
    );
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function scanOutputSegments(paths: OutputCapturePaths): OutputSegment[] {
  if (outputCaptureKind(paths) !== "segmented") return [];
  const pattern = new RegExp(`^${paths.generationHash}\\.([0-9]+)\\.segment$`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const segments = readdirSync(paths.legacyPath)
        .flatMap((name): OutputSegment[] => {
          const match = pattern.exec(name);
          if (!match) return [];
          const start = Number(match[1]);
          if (!Number.isSafeInteger(start) || start < 0) {
            throw new TerminalControlProtocolError(
              "RECOVERY_REQUIRED",
              "terminal output capture segment cursor is invalid",
            );
          }
          const path = join(paths.legacyPath, name);
          const stat = assertPrivateOutputFile(path, OUTPUT_SEGMENT_BYTES);
          return [{ path, start, size: stat.size }];
        })
        .sort((left, right) => left.start - right.start);
      for (let index = 0; index < segments.length - 1; index += 1) {
        const current = segments[index];
        const next = segments[index + 1];
        if (current.size !== OUTPUT_SEGMENT_BYTES || next.start !== current.start + current.size) {
          throw new TerminalControlProtocolError(
            "RECOVERY_REQUIRED",
            "terminal output capture segments are not contiguous",
          );
        }
      }
      return segments;
    } catch (error) {
      if (attempt === 0 && isMissingFileError(error)) continue;
      throw error;
    }
  }
  return [];
}

function currentOutputSegments(paths: OutputCapturePaths): OutputSegment[] {
  // The capture writer is the sole owner of current-generation retention.
  // Readers may observe the brief create-before-unlink window and simply use
  // the newest two contiguous segments; they never race the writer by
  // unlinking a live segment themselves.
  return scanOutputSegments(paths).slice(-MAX_OUTPUT_SEGMENTS);
}

function createInitialOutputSegment(paths: OutputCapturePaths): OutputSegment[] {
  mkdirSync(paths.legacyPath, { mode: 0o700 });
  if (outputCaptureKind(paths) !== "segmented") {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output generation directory could not be established",
    );
  }
  const path = segmentPath(paths, 0);
  const fd = openSync(path, "wx", 0o600);
  closeSync(fd);
  return [{ path, start: 0, size: 0 }];
}

function outputPositionFromSegments(
  generation: string,
  segments: OutputSegment[],
): TerminalControlOutputPosition {
  const current = segments.at(-1);
  if (!current) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output capture has no retained segment",
    );
  }
  const cursor = current.start + current.size;
  if (!Number.isSafeInteger(cursor)) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output cursor exceeded the supported range",
    );
  }
  return { generation, cursor };
}

function pruneObsoleteOutputFiles(paths: OutputCapturePaths): void {
  const captureName = /^([0-9a-f]{64})\.bin$/;
  const flatSegmentName = /^([0-9a-f]{64})\.[0-9]+\.segment$/;
  for (const name of readdirSync(paths.directory)) {
    const match = captureName.exec(name) ?? flatSegmentName.exec(name);
    if (!match || match[1] === paths.generationHash) continue;
    const path = join(paths.directory, name);
    try {
      const stat = lstatSync(path);
      const uid = process.getuid?.();
      if (stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) continue;
      if (stat.isFile()) {
        unlinkSync(path);
        continue;
      }
      if (!stat.isDirectory() || !captureName.test(name)) continue;
      const segmentPattern = new RegExp(`^${match[1]}\\.[0-9]+\\.segment$`);
      const children = readdirSync(path);
      const safeChildren = children.every((child) => {
        if (!segmentPattern.test(child)) return false;
        const childStat = lstatSync(join(path, child));
        return childStat.isFile()
          && !childStat.isSymbolicLink()
          && (uid === undefined || childStat.uid === uid);
      });
      if (!safeChildren) continue;
      for (const child of children) unlinkSync(join(path, child));
      rmdirSync(path);
    } catch (error) {
      if (!isMissingFileError(error)) {
        // Capture cleanup is bounded best effort. Unknown or concurrently
        // changing entries must never weaken the current generation's fence.
      }
    }
  }
}

const SEGMENTED_CAPTURE_SCRIPT = [
  "const fs=require('fs')",
  "const directory=process.argv[1]",
  "const generation=process.argv[2]",
  "let start=Number(process.argv[3])",
  "const limit=Number(process.argv[4])",
  "const retain=Number(process.argv[5])",
  "if(!/^[0-9a-f]{64}$/.test(generation)||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(limit)||limit<=0||!Number.isSafeInteger(retain)||retain<2){process.exit(2)}",
  "const segmentPath=(cursor)=>directory+'/'+generation+'.'+cursor+'.segment'",
  "let path=segmentPath(start)",
  "let fd=fs.openSync(path,fs.constants.O_WRONLY|fs.constants.O_APPEND)",
  "let size=fs.fstatSync(fd).size",
  "if(size>limit){process.exit(3)}",
  "const cleanup=()=>{",
  "const pattern=new RegExp('^'+generation+'\\\\.([0-9]+)\\\\.segment$')",
  "const segments=fs.readdirSync(directory).map((name)=>{const match=pattern.exec(name);return match?{name,start:Number(match[1])}:null}).filter(Boolean).filter((entry)=>Number.isSafeInteger(entry.start)).sort((a,b)=>a.start-b.start)",
  "for(const entry of segments.slice(0,-retain)){const candidate=directory+'/'+entry.name;try{const stat=fs.lstatSync(candidate);if(!stat.isFile()||stat.isSymbolicLink()){process.exit(4)}fs.unlinkSync(candidate)}catch(error){if(error.code!=='ENOENT'){throw error}}}",
  "}",
  "cleanup()",
  "const rotate=()=>{",
  "fs.closeSync(fd)",
  "start+=size",
  "if(!Number.isSafeInteger(start)){process.exit(5)}",
  "path=segmentPath(start)",
  "fd=fs.openSync(path,'wx',0o600)",
  "size=0",
  "cleanup()",
  "}",
  "process.stdin.on('data',(chunk)=>{",
  "let offset=0",
  "while(offset<chunk.length){",
  "if(size===limit){rotate()}",
  "const length=Math.min(limit-size,chunk.length-offset)",
  "let written=0",
  "while(written<length){written+=fs.writeSync(fd,chunk,offset+written,length-written)}",
  "offset+=length",
  "size+=length",
  "}",
  "})",
  "process.stdin.on('end',()=>{fs.closeSync(fd)})",
].join(";");

function outputCaptureCommand(paths: OutputCapturePaths, current: OutputSegment): string {
  return [
    "exec",
    shellQuote(process.execPath),
    "-e",
    shellQuote(SEGMENTED_CAPTURE_SCRIPT),
    shellQuote(paths.legacyPath),
    paths.generationHash,
    String(current.start),
    String(OUTPUT_SEGMENT_BYTES),
    String(MAX_OUTPUT_SEGMENTS),
  ].join(" ");
}

async function establishSegmentedOutputCapture(
  sessionId: string,
  paneTarget: string,
  paths: OutputCapturePaths,
  generation: string,
): Promise<TerminalControlOutputPosition> {
  if (outputCaptureKind(paths) !== "missing") {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "new terminal output generation already has capture data",
    );
  }
  const current = createInitialOutputSegment(paths)[0];
  await runTmux(["set-option", "-t", sessionId, OUTPUT_GENERATION_OPTION, generation]);
  await runTmux(["pipe-pane", "-O", "-t", paneTarget, outputCaptureCommand(paths, current)]);
  const confirmed = (await runTmux(
    ["display-message", "-p", "-t", paneTarget, "#{pane_pipe}"],
  )).stdout.trim() === "1";
  if (!confirmed) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output capture could not be established",
    );
  }
  pruneObsoleteOutputFiles(paths);
  return outputPositionFromSegments(generation, currentOutputSegments(paths));
}

function legacyCaptureRequiresRotation(path: string): never {
  ensureOutputFile(path);
  throw new TerminalControlProtocolError(
    "RESOURCE_EXHAUSTED",
    "terminal output legacy capture requires bounded rotation",
  );
}

function readSegmentedOutput(
  paths: OutputCapturePaths,
  generation: string,
  cursor: number,
  maxBytes: number,
): TerminalControlOutputChunk {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const segments = currentOutputSegments(paths);
      const position = outputPositionFromSegments(generation, segments);
      const floor = segments[0].start;
      if (cursor < floor || cursor > position.cursor) {
        throw new TerminalControlProtocolError("STALE_OUTPUT_CURSOR", "terminal output cursor is stale");
      }
      const length = Math.min(maxBytes, position.cursor - cursor);
      const buffer = Buffer.alloc(length);
      let nextCursor = cursor;
      let outputOffset = 0;
      for (const segment of segments) {
        if (outputOffset >= length) break;
        const segmentEnd = segment.start + segment.size;
        if (nextCursor >= segmentEnd) continue;
        if (nextCursor < segment.start) {
          throw new TerminalControlProtocolError(
            "RECOVERY_REQUIRED",
            "terminal output capture contains a retained cursor gap",
          );
        }
        let fd = -1;
        try {
          fd = openSync(segment.path, "r");
          const stat = fstatSync(fd);
          const uid = process.getuid?.();
          if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || stat.size > OUTPUT_SEGMENT_BYTES) {
            throw new TerminalControlProtocolError(
              "RECOVERY_REQUIRED",
              "terminal output capture segment is not a private bounded regular file",
            );
          }
          const fileOffset = nextCursor - segment.start;
          const available = Math.min(segment.size - fileOffset, length - outputOffset);
          const read = available > 0
            ? readSync(fd, buffer, outputOffset, available, fileOffset)
            : 0;
          outputOffset += read;
          nextCursor += read;
          if (read !== available) {
            throw new TerminalControlProtocolError(
              "RECOVERY_REQUIRED",
              "terminal output capture changed during a retained read",
            );
          }
        } finally {
          if (fd >= 0) closeSync(fd);
        }
      }
      if (outputOffset !== length) {
        throw new TerminalControlProtocolError(
          "RECOVERY_REQUIRED",
          "terminal output capture could not satisfy a retained read",
        );
      }
      return {
        generation,
        cursor,
        dataBase64: buffer.toString("base64"),
        nextCursor,
      };
    } catch (error) {
      if (attempt === 0 && isMissingFileError(error)) continue;
      throw error;
    }
  }
  throw new TerminalControlProtocolError(
    "RECOVERY_REQUIRED",
    "terminal output capture changed repeatedly during a retained read",
  );
}

export class TmuxTerminalControlBackend implements TerminalControlBackend {
  async resolveManagedSession(sessionName: string): Promise<ResolvedManagedTerminalBackend> {
    const managedSession = exactManagedSession(sessionName);
    const sessionId = await requireTmuxSession(sessionName, "TARGET_NOT_FOUND");
    let tmuxInstanceId = await currentTmuxInstanceId(sessionId);
    if (!tmuxInstanceId) {
      tmuxInstanceId = randomUUID();
      await runTmux(["set-option", "-t", sessionId, TMUX_INSTANCE_OPTION, tmuxInstanceId]);
      const confirmed = await currentTmuxInstanceId(sessionId);
      if (confirmed !== tmuxInstanceId) {
        throw new TerminalControlProtocolError(
          "RECOVERY_REQUIRED",
          "could not establish exact tmux backend lifecycle identity",
        );
      }
    }
    return { managedSession, tmuxInstanceId };
  }

  async assertCurrent(
    expected: Pick<ManagedSession, "name" | "kind" | "createdAt">,
    tmuxInstanceId: string,
  ): Promise<void> {
    let current: ManagedSession;
    try {
      current = exactManagedSession(expected.name);
    } catch (error) {
      if (error instanceof TerminalControlProtocolError && error.code === "TARGET_NOT_FOUND") {
        throw new TerminalControlProtocolError("TARGET_GONE", "managed session lifecycle no longer exists");
      }
      throw error;
    }
    if (current.kind !== expected.kind || current.createdAt !== expected.createdAt) {
      throw new TerminalControlProtocolError(
        "TARGET_GONE",
        "managed session lifecycle no longer matches the control target",
      );
    }
    const sessionId = await requireTmuxSession(expected.name, "TARGET_GONE");
    const currentInstance = await currentTmuxInstanceId(sessionId);
    if (currentInstance !== tmuxInstanceId) {
      throw new TerminalControlProtocolError(
        "TARGET_GONE",
        "tmux backend lifecycle no longer matches the control target",
      );
    }
  }

  async writeRaw(sessionName: string, pane: string, data: Buffer): Promise<void> {
    const { paneTarget } = await requirePane(sessionName, pane);
    if (data.byteLength === 0) return;
    const key = tmuxKeyForRawInput(data);
    if (key) {
      const marker = `__TW_CONTROL_RAW_COMMITTED_${randomUUID()}__`;
      await runTmuxWritableControlCommand(
        sessionName,
        `${tmuxSendKeyCommand(paneTarget, key)} ; display-message -p ${marker}`,
        [marker],
      );
      return;
    }
    const bufferName = `tw-control-${process.pid}-${randomUUID()}`;
    try {
      await runTmux(
        [
          "load-buffer", "-b", bufferName, "-",
          ";", "paste-buffer", "-b", bufferName, "-d", "-r", "-t", paneTarget,
        ],
        { input: data },
      );
    } catch (error) {
      await runTmux(["delete-buffer", "-b", bufferName], { allowFailure: true }).catch(() => undefined);
      throw error;
    }
  }

  async rawInputPosition(
    controlTargetId: string,
    generation: string,
  ): Promise<TerminalControlOutputPosition> {
    const paths = outputCapturePaths(controlTargetId, generation);
    const segments = currentOutputSegments(paths);
    if (segments.length > 0) {
      return outputPositionFromSegments(generation, segments);
    }
    const kind = outputCaptureKind(paths);
    if (kind === "missing") {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal output capture file is missing",
      );
    }
    if (kind === "segmented") {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal output capture has no retained segment",
      );
    }
    ensureOutputFile(paths.legacyPath);
    return { generation, cursor: statSync(paths.legacyPath).size };
  }

  async writeRawFenced(
    expected: Pick<ManagedSession, "name" | "kind" | "createdAt">,
    tmuxInstanceId: string,
    outputGeneration: string,
    pane: string,
    data: Buffer,
  ): Promise<void> {
    if (pane !== "0") {
      throw new TerminalControlProtocolError(
        "INVALID_REQUEST",
        `managed single-pane target has no logical pane: ${pane}`,
      );
    }
    const current = exactManagedSession(expected.name);
    if (current.kind !== expected.kind || current.createdAt !== expected.createdAt) {
      throw new TerminalControlProtocolError(
        "TARGET_GONE",
        "managed session lifecycle no longer matches the control target",
      );
    }
    if (
      !/^[A-Za-z0-9-]{1,128}$/.test(tmuxInstanceId)
      || !/^[A-Za-z0-9-]{1,128}$/.test(outputGeneration)
    ) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal backend fencing identity is malformed",
      );
    }

    const bufferName = `tw-control-${process.pid}-${randomUUID()}`;
    const committedMarker = `__TW_CONTROL_RAW_COMMITTED_${randomUUID()}__`;
    const rejectedMarker = `__TW_CONTROL_RAW_REJECTED_${randomUUID()}__`;
    let paneId: string;
    try {
      const probe = await runTmux([
        "display-message",
        "-p",
        "-t",
        expected.name,
        [
          "#{pane_id}",
          `#{@${TMUX_INSTANCE_OPTION.slice(1)}}`,
          `#{@${OUTPUT_GENERATION_OPTION.slice(1)}}`,
          "#{pane_pipe}",
          "#{session_windows}",
          "#{window_panes}",
        ].join("\u001f"),
      ]);
      const fields = probe.stdout.trim().split("\u001f");
      if (
        fields.length !== 6
        || !/^%\d+$/.test(fields[0])
        || fields[1] !== tmuxInstanceId
        || fields[2] !== outputGeneration
        || fields[3] !== "1"
        || fields[4] !== "1"
        || fields[5] !== "1"
      ) {
        throw new TerminalControlProtocolError(
          "RECOVERY_REQUIRED",
          "terminal backend identity, output capture, or single-pane shape changed before input",
        );
      }
      paneId = fields[0];
    } catch (error) {
      if (error instanceof TerminalControlProtocolError) throw error;
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        `could not resolve the fenced terminal pane before input: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const condition = [
      `#{==:#{@${TMUX_INSTANCE_OPTION.slice(1)}},${tmuxInstanceId}}`,
      `#{==:#{@${OUTPUT_GENERATION_OPTION.slice(1)}},${outputGeneration}}`,
      "#{==:#{pane_pipe},1}",
      "#{==:#{session_windows},1}",
      "#{==:#{window_panes},1}",
    ].reduceRight((right, left) => `#{&&:${left},${right}}`);
    const key = tmuxKeyForRawInput(data);
    const committed = [
      key
        ? tmuxSendKeyCommand(paneId, key)
        : `load-buffer -b ${bufferName} - ; paste-buffer -b ${bufferName} -d -r -t ${paneId}`,
      `display-message -p ${committedMarker}`,
    ].join(" ; ");
    const rejected = `display-message -p ${rejectedMarker}`;
    const response = key
      ? await runTmuxWritableControlCommand(
        expected.name,
        [
          "if-shell",
          "-F",
          "-t",
          paneId,
          shellQuote(condition),
          shellQuote(committed),
          shellQuote(rejected),
        ].join(" "),
        [committedMarker, rejectedMarker],
      )
      : (await runTmux(
        [
          "if-shell",
          "-F",
          "-t",
          paneId,
          condition,
          committed,
          rejected,
        ],
        { input: data },
      )).stdout.trim();
    if (response === rejectedMarker) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal backend identity, output capture, or single-pane shape changed before input",
      );
    }
    if (response !== committedMarker) {
      throw new Error("tmux did not confirm the fenced raw input boundary");
    }
  }

  async sendAgentMessage(
    sessionName: string,
    pane: string,
    message: string,
    submit: boolean,
  ): Promise<void> {
    const { paneTarget } = await requirePane(sessionName, pane);
    const normalized = message.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized && !submit) return;
    if (!normalized) {
      try {
        await runTmux(["send-keys", "-t", paneTarget, "C-m"]);
      } catch (error) {
        throw new Error(`agent message submit failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const bufferName = `tw-control-${process.pid}-${randomUUID()}`;
    try {
      await runTmux([
        "load-buffer", "-b", bufferName, "-",
        ";", "paste-buffer", "-b", bufferName, "-d", "-r", "-t", paneTarget,
      ], { input: normalized });
    } catch (error) {
      await runTmux(["delete-buffer", "-b", bufferName], { allowFailure: true }).catch(() => undefined);
      throw new Error(`agent message paste failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!submit) return;
    await new Promise<void>((resolve) => setTimeout(resolve, AGENT_MESSAGE_SUBMIT_PACE_MS));
    try {
      await runTmux(["send-keys", "-t", paneTarget, "C-m"]);
    } catch (error) {
      throw new Error(
        `agent message submit failed after paste; input may remain in the target pane: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async resize(sessionName: string, pane: string, cols: number, rows: number): Promise<void> {
    const { sessionId } = await requirePane(sessionName, pane);
    await runTmux([
      "resize-window",
      "-t", sessionId,
      "-x", String(cols),
      "-y", String(rows),
    ]);
  }

  async scroll(
    sessionName: string,
    pane: string,
    direction: "up" | "down",
    lines: number,
  ): Promise<void> {
    if ((direction !== "up" && direction !== "down") || !Number.isSafeInteger(lines) || lines < 1 || lines > 100) {
      throw new TerminalControlProtocolError("INVALID_REQUEST", "tmux scroll input is invalid");
    }
    const { paneTarget } = await requirePane(sessionName, pane);
    const inMode = (await runTmux([
      "display-message", "-p", "-t", paneTarget, "#{pane_in_mode}",
    ])).stdout.trim() === "1";
    if (direction === "down" && !inMode) return;
    if (direction === "up" && !inMode) {
      await runTmux(["copy-mode", "-e", "-t", paneTarget]);
    }
    await runTmux([
      "send-keys", "-X", "-N", String(lines), "-t", paneTarget,
      direction === "up" ? "scroll-up" : "scroll-down",
    ]);
  }

  async killManaged(sessionName: string): Promise<void> {
    const cli = process.env.TW_TERMINAL_CONTROL_CLI?.trim()
      || process.env.TW_DASHBOARD_CLI?.trim()
      || process.argv[1];
    if (!cli) throw new Error("cannot locate the canonical tw CLI for managed kill");
    const result = await new Promise<TmuxResult>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "rpc", "kill-session", "--name", sessionName], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      timer.unref();
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) child.kill("SIGKILL");
        else stdout.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) child.kill("SIGKILL");
        else stderr.push(Buffer.from(chunk));
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        const output = {
          stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
          stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
        };
        if (code === 0 && signal === null) resolve(output);
        else reject(new Error(output.stderr.trim() || output.stdout.trim() || "managed kill failed"));
      });
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("canonical tw managed kill returned invalid JSON");
    }
    if (
      !parsed
      || typeof parsed !== "object"
      || (parsed as Record<string, unknown>).protocolVersion !== 1
      || (parsed as Record<string, unknown>).kind !== "session-killed"
      || (parsed as Record<string, unknown>).session !== sessionName
    ) {
      throw new Error("canonical tw managed kill returned an incompatible response");
    }
  }

  async prepareOutput(
    controlTargetId: string,
    sessionName: string,
    pane: string,
    generation?: string,
  ): Promise<TerminalControlOutputPosition> {
    const { sessionId, paneTarget: target } = await requirePane(sessionName, pane);
    const configured = (await runTmux(
      ["show-options", "-v", "-t", sessionId, OUTPUT_GENERATION_OPTION],
      { allowFailure: true },
    )).stdout.trim();
    const pipeActive = (await runTmux(
      ["display-message", "-p", "-t", target, "#{pane_pipe}"],
    )).stdout.trim() === "1";
    if (generation && pipeActive && configured === generation) {
      const paths = outputCapturePaths(controlTargetId, generation);
      const segments = currentOutputSegments(paths);
      if (segments.length > 0) {
        pruneObsoleteOutputFiles(paths);
        return outputPositionFromSegments(generation, segments);
      }
      if (outputCaptureKind(paths) === "legacy") legacyCaptureRequiresRotation(paths.legacyPath);
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal output capture file is missing",
      );
    }
    if (!pipeActive && generation && configured === generation) {
      const paths = outputCapturePaths(controlTargetId, generation);
      if (outputCaptureKind(paths) === "legacy") legacyCaptureRequiresRotation(paths.legacyPath);
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal output capture stopped before the authority could prove continuity",
      );
    }
    if (pipeActive || configured) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal output capture continuity is owned by another generation",
      );
    }
    const nextGeneration = generation || randomUUID();
    const paths = outputCapturePaths(controlTargetId, nextGeneration);
    const kind = outputCaptureKind(paths);
    if (kind === "legacy") {
      legacyCaptureRequiresRotation(paths.legacyPath);
    }
    if (kind === "segmented") {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal output capture data exists without an established generation",
      );
    }
    return establishSegmentedOutputCapture(sessionId, target, paths, nextGeneration);
  }

  async resetOutput(
    controlTargetId: string,
    sessionName: string,
    pane: string,
    previousGeneration: string,
  ): Promise<TerminalControlOutputPosition> {
    const { sessionId, paneTarget: target } = await requirePane(sessionName, pane);
    const configured = (await runTmux(
      ["show-options", "-v", "-t", sessionId, OUTPUT_GENERATION_OPTION],
      { allowFailure: true },
    )).stdout.trim();
    if (configured && configured !== previousGeneration) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal output generation changed outside the authority",
      );
    }
    const pipeActive = (await runTmux(
      ["display-message", "-p", "-t", target, "#{pane_pipe}"],
    )).stdout.trim() === "1";
    if (pipeActive) await runTmux(["pipe-pane", "-t", target]);
    const nextGeneration = randomUUID();
    return establishSegmentedOutputCapture(
      sessionId,
      target,
      outputCapturePaths(controlTargetId, nextGeneration),
      nextGeneration,
    );
  }

  async tailOutput(
    controlTargetId: string,
    sessionName: string,
    pane: string,
    generation: string,
    cursor: number,
    maxBytes: number,
  ): Promise<TerminalControlOutputChunk> {
    const position = await this.prepareOutput(controlTargetId, sessionName, pane, generation);
    if (cursor > position.cursor) {
      throw new TerminalControlProtocolError("STALE_OUTPUT_CURSOR", "terminal output cursor is stale");
    }
    return readSegmentedOutput(
      outputCapturePaths(controlTargetId, generation),
      generation,
      cursor,
      maxBytes,
    );
  }
}
