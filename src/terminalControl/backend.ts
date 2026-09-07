import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { managedStatePath, loadManagedStateForMutation, type ManagedSession } from "../state";
import {
  commandThenLoginShell,
  killManagedSessionV2,
  observeManagedSessionIncarnation,
} from "../session";
import { listTmuxSessionLifecycleEntries, tmuxBin } from "../tmux";
import {
  TERMINAL_CONTROL_MAX_AGENT_RESULT_BYTES,
  TERMINAL_CONTROL_MAX_RENDERED_SNAPSHOT_BYTES,
  TerminalControlAgentMessageNotAppliedError,
  TerminalControlProtocolError,
  type TerminalControlAgentResult,
  type TerminalControlAgentRuntimeSettings,
  type TerminalControlAgentProgressStep,
  type TerminalControlAgentSource,
  type TerminalControlOutputChunk,
  type TerminalControlOutputPosition,
} from "./protocol";
import {
  agentProviderFromStartCommand,
  discoverActiveAgentActivity,
  discoverActiveAgentSource,
  discoverLatestResumableAgentSession,
  readAgentProgress,
  readCompletedAgentResult,
  resumedAgentSessionIdFromStartCommand,
} from "./agentTranscript";
import { TERMINAL_CONTROL_AGENT_RESUME_INPUT_TIMEOUT_MS } from "./timeouts";
import {
  AGENT_MESSAGE_SUBMIT_PACE_MS,
  COMMAND_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_RENDERED_SNAPSHOT_SOURCE_BYTES,
  OUTPUT_GENERATION_OPTION,
} from "./constants";
import { tmuxKeyForRawInput, tmuxSendKeyCommand, sgrMouseWheelPayload } from "./tmuxKeys";
import { shellQuote } from "./shellQuote";
import { runTmux, TmuxStdoutLimitError, validateSessionName, type TmuxResult } from "./tmuxExec";
import {
  buildCodexResumeCommand,
  codexModelFromStartCommand,
  codexResumeEnvironmentArguments,
  ensureCodexMode,
  waitForCodexResumeEnvironmentHydration,
} from "./codexResume";
import {
  currentOutputSegments,
  ensureOutputFile,
  establishSegmentedOutputCapture,
  legacyCaptureRequiresRotation,
  outputCaptureBackendState,
  outputCaptureKind,
  outputCapturePaths,
  outputPositionFromSegments,
  pruneObsoleteOutputFiles,
  readSegmentedOutput,
  resumeSegmentedOutputCapture,
} from "./outputCapture";

// Re-export the moved public API so existing importers of "./backend" (the
// barrel, cli.ts, authority.ts) keep working without churn.
export { TerminalControlAgentMessageNotAppliedError } from "./protocol";
export type { TerminalControlOutputChunk, TerminalControlOutputPosition } from "./protocol";
export {
  applyCodexResumeEnvironmentSnapshot,
  buildCodexResumeCommand,
  codexModeFromRenderedSnapshot,
  codexModelFromStartCommand,
  codexResumeEnvironmentArguments,
  inheritCodexResumeEnvironmentFromLoginShell,
  inheritCodexResumeEnvironmentFromLoginShellAsync,
} from "./codexResume";


const TMUX_INSTANCE_OPTION = "@tw_terminal_control_instance_v1";
const AGENT_RESUME_READY_TIMEOUT_MS = 5_000;
const AGENT_RESUME_POLL_MS = 50;
const AGENT_RESUME_SETTLE_MS = 500;
// A cold Codex resume can accept the pasted input immediately while taking
// several more seconds to persist the correlated UserMessage record (update
// notices and provider startup both occur in this window). Keep the retry
// cadence short, but allow enough total time to prove the exact submitted
// turn before handing any remaining source correlation to status polling.
const AGENT_RESUME_INITIAL_SOURCE_WAIT_MS = 2_000;
const AGENT_RESUME_SUBMIT_RETRY_MS = 500;
const RENDERED_SNAPSHOT_HISTORY_LINES = 1024;

export interface TerminalControlRenderedSnapshot {
  dataBase64: string;
  truncated: boolean;
}

export interface TerminalControlAgentStatus {
  agentSupported: boolean;
  agentRunning: boolean;
  provider?: TerminalControlAgentSource["provider"];
  source?: TerminalControlAgentSource;
  progress?: TerminalControlAgentProgressStep[];
}

export interface ResolvedManagedTerminalBackend {
  managedSession: ManagedSession;
  tmuxInstanceId: string;
}

export interface TerminalControlExactTargetObservation {
  managedSession: ManagedSession;
  managedIncarnation: string;
  tmuxInstanceId: string | null;
  paneIdentity: string;
}

export interface TerminalControlExactTargetInspection
  extends TerminalControlExactTargetObservation {
  tmuxInstanceId: string;
}

export interface TerminalControlExactTargetInput {
  managedName: string;
  managedKind: "worktree" | "terminal";
  managedIncarnation: string;
  pane: number;
}

export interface TerminalControlBackend {
  resolveManagedSession(sessionName: string): Promise<ResolvedManagedTerminalBackend>;
  /**
   * Optional Relay v2 closed inspection. Implementations must not establish a
   * tmux identity, attach output, persist a target, or perform any mutation.
   */
  inspectExactTarget?(
    input: TerminalControlExactTargetInput,
  ): Promise<TerminalControlExactTargetInspection>;
  /**
   * Optional closed observation used only to distinguish an exact current
   * record from a stale same-name lifecycle before provisioning.
   */
  observeExactTarget?(
    input: TerminalControlExactTargetInput,
  ): Promise<TerminalControlExactTargetObservation>;
  /**
   * Optional Relay v2 exact provisioning seam. The authority calls this only
   * when no exact current target record exists. It must validate the exact
   * managed kind/incarnation/pane before establishing the tmux lifecycle
   * identity.
   */
  establishExactTarget?(
    input: TerminalControlExactTargetInput,
  ): Promise<TerminalControlExactTargetInspection>;
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
  sendAgentMessageFenced?(
    session: Pick<ManagedSession, "name" | "kind" | "createdAt">,
    tmuxInstanceId: string,
    outputGeneration: string,
    pane: string,
    message: string,
    submit: boolean,
    runtime?: TerminalControlAgentRuntimeSettings,
  ): Promise<void>;
  resize(sessionName: string, pane: string, cols: number, rows: number): Promise<void>;
  scroll(sessionName: string, pane: string, direction: "up" | "down", lines: number): Promise<void>;
  killManaged(sessionName: string): Promise<void>;
  prepareOutput(
    controlTargetId: string,
    sessionName: string,
    pane: string,
    generation?: string,
    capturePane?: boolean,
  ): Promise<TerminalControlOutputPosition>;
  resetOutput(
    controlTargetId: string,
    sessionName: string,
    pane: string,
    previousGeneration: string,
  ): Promise<TerminalControlOutputPosition>;
  recoverOutput(
    controlTargetId: string,
    sessionName: string,
    pane: string,
    previousGeneration: string,
    recoveryGeneration: string,
  ): Promise<TerminalControlOutputPosition>;
  tailOutput(
    controlTargetId: string,
    sessionName: string,
    pane: string,
    generation: string,
    cursor: number,
    maxBytes: number,
  ): Promise<TerminalControlOutputChunk>;
  captureRenderedSnapshot(
    session: Pick<ManagedSession, "name" | "kind" | "createdAt">,
    tmuxInstanceId: string,
    outputGeneration: string,
    pane: string,
    maxBytes: number,
  ): Promise<TerminalControlRenderedSnapshot>;
  agentStatus(
    session: Pick<ManagedSession, "name" | "kind" | "createdAt">,
    tmuxInstanceId: string,
    outputGeneration: string,
    pane: string,
  ): Promise<TerminalControlAgentStatus>;
  agentResult(
    session: Pick<ManagedSession, "name" | "kind" | "createdAt">,
    tmuxInstanceId: string,
    outputGeneration: string,
    pane: string,
    source: TerminalControlAgentSource,
    maxBytes: number,
  ): Promise<TerminalControlAgentResult>;
}

async function pasteRawToPane(paneTarget: string, data: Buffer): Promise<void> {
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

export function agentRunningFromPaneTitle(title: string): boolean {
  const characters = [...title.trimStart()];
  if (characters.length < 2) return false;
  const first = characters[0].codePointAt(0)!;
  return first >= 0x2800 && first <= 0x28ff && /\s/u.test(characters[1]);
}

async function requireFencedTerminalPane(
  expected: Pick<ManagedSession, "name" | "kind" | "createdAt">,
  tmuxInstanceId: string,
  outputGeneration: string,
  pane: string,
): Promise<{
  paneId: string;
  agentRunning: boolean;
  paneStartCommand: string;
  paneCurrentCommand: string;
  paneCurrentPath: string;
  panePid: number;
}> {
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

  const sessionId = await requireTmuxSession(expected.name, "TARGET_GONE");
  const canonicalPaneTarget = `=${expected.name}:`;
  let probe: TmuxResult;
  try {
    probe = await runTmux([
      "display-message",
      "-p",
      "-t",
      canonicalPaneTarget,
      [
        "#{pane_id}",
        "#{session_id}",
        `#{@${TMUX_INSTANCE_OPTION.slice(1)}}`,
        `#{@${OUTPUT_GENERATION_OPTION.slice(1)}}`,
        "#{pane_pipe}",
        "#{session_windows}",
        "#{window_panes}",
        "#{pane_title}",
        "#{pane_start_command}",
        "#{pane_current_command}",
        "#{pane_current_path}",
        "#{pane_pid}",
      ].join("\u001f"),
    ]);
  } catch (error) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      `could not resolve the fenced terminal pane: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const fields = probe.stdout.replace(/\r?\n$/, "").split("\u001f");
  if (
    fields.length !== 12
    || !/^%\d+$/.test(fields[0])
    || fields[1] !== sessionId
    || fields[2] !== tmuxInstanceId
    || fields[3] !== outputGeneration
    || fields[4] !== "1"
    || fields[5] !== "1"
    || fields[6] !== "1"
    || !/^[1-9][0-9]*$/.test(fields[11])
  ) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal backend identity, output capture, or single-pane shape changed before rendered output capture",
    );
  }
  return {
    paneId: fields[0],
    agentRunning: agentRunningFromPaneTitle(fields[7]),
    paneStartCommand: fields[8],
    paneCurrentCommand: fields[9],
    paneCurrentPath: fields[10],
    panePid: Number(fields[11]),
  };
}

function processBasename(command: string): string {
  return command.trim().split("/").at(-1)?.toLowerCase() ?? "";
}

function isAgentProcess(command: string, provider: "claude" | "codex"): boolean {
  const name = processBasename(command);
  return name === provider || name.startsWith(`${provider}-`);
}

function paneAgentProcessState(
  panePid: number,
  provider: "claude" | "codex",
): Promise<"agent" | "idle" | "occupied"> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/ps", ["-axo", "pid=,ppid=,comm="], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: "agent" | "idle" | "occupied") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result ?? "idle");
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(new TerminalControlProtocolError("RECOVERY_REQUIRED", "Agent process observation timed out"));
    }, COMMAND_TIMEOUT_MS);
    timer.unref();
    child.stdout!.on("data", (raw: Buffer) => {
      stdoutBytes += raw.byteLength;
      if (stdoutBytes > MAX_RENDERED_SNAPSHOT_SOURCE_BYTES) {
        try { child.kill("SIGKILL"); } catch {}
        finish(new TerminalControlProtocolError("RESOURCE_EXHAUSTED", "Agent process catalog is too large"));
        return;
      }
      stdout.push(Buffer.from(raw));
    });
    child.stderr!.on("data", (raw: Buffer) => {
      stderrBytes += raw.byteLength;
      if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) {
        try { child.kill("SIGKILL"); } catch {}
        finish(new TerminalControlProtocolError("RESOURCE_EXHAUSTED", "Agent process observation failed"));
        return;
      }
      stderr.push(Buffer.from(raw));
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null) {
        const detail = Buffer.concat(stderr, stderrBytes).toString("utf8").trim();
        finish(new TerminalControlProtocolError(
          "RECOVERY_REQUIRED",
          `Agent process observation failed${detail ? `: ${detail}` : ""}`,
        ));
        return;
      }
      const processes = new Map<number, { parent: number; command: string }>();
      for (const line of Buffer.concat(stdout, stdoutBytes).toString("utf8").split("\n")) {
        const match = /^\s*([0-9]+)\s+([0-9]+)\s+(.+?)\s*$/.exec(line);
        if (!match) continue;
        processes.set(Number(match[1]), { parent: Number(match[2]), command: match[3] });
      }
      const descendants: Array<{ pid: number; command: string }> = [];
      for (const [pid, processInfo] of processes) {
        let current = pid;
        const visited = new Set<number>();
        while (current > 0 && !visited.has(current)) {
          if (current === panePid) {
            if (pid !== panePid) descendants.push({ pid, command: processInfo.command });
            break;
          }
          visited.add(current);
          current = processes.get(current)?.parent ?? 0;
        }
      }
      finish(undefined, descendants.some(({ command }) => isAgentProcess(command, provider))
        ? "agent"
        : descendants.length === 0
          ? "idle"
          : "occupied");
    });
  });
}

function isShellProcess(command: string): boolean {
  return ["sh", "bash", "dash", "fish", "ksh", "mksh", "tcsh", "zsh"]
    .includes(processBasename(command));
}

function agentSourceBoundaryKey(
  expected: Pick<ManagedSession, "name" | "kind" | "createdAt">,
  tmuxInstanceId: string,
  pane: string,
): string {
  return `${expected.name}\0${expected.kind}\0${expected.createdAt}\0${tmuxInstanceId}\0${pane}`;
}

function pendingAgentSource(boundary: AgentSourceBoundary): TerminalControlAgentSource | undefined {
  try {
    return discoverActiveAgentSource({
      provider: boundary.provider,
      cwd: boundary.cwd,
      sessionId: boundary.sessionId,
      startedAtNotBefore: boundary.startedAtNotBefore,
      expectedUserMessage: boundary.expectedUserMessage,
    });
  } catch (error) {
    if (error instanceof TerminalControlProtocolError
      && error.code === "RESOURCE_EXHAUSTED"
      && error.retryable) return undefined;
    throw error;
  }
}

async function waitForAgentSource(
  boundary: AgentSourceBoundary,
  deadline: number,
): Promise<TerminalControlAgentSource | undefined> {
  while (Date.now() < deadline) {
    const found = pendingAgentSource(boundary);
    if (found !== undefined) return found;
    await new Promise<void>((resolve) => setTimeout(
      resolve,
      Math.min(AGENT_RESUME_POLL_MS, Math.max(1, deadline - Date.now())),
    ));
  }
  return undefined;
}

async function pasteAgentMessage(
  paneTarget: string,
  message: string,
  submit: boolean,
): Promise<void> {
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
    // Agent TUIs such as Codex enable bracketed paste and treat the framed
    // payload as one composer edit. Without `-p`, tmux emits a rapid stream of
    // ordinary key events; Codex's paste-burst fallback can still be buffering
    // the tail when the later submit key arrives, which can suppress Enter or
    // submit a truncated message. Keep `-r` so normalized newlines remain
    // literal inside the bracketed payload.
    await runTmux([
      "load-buffer", "-b", bufferName, "-",
      ";", "paste-buffer", "-b", bufferName, "-d", "-p", "-r", "-t", paneTarget,
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

function boundedUtf8Tail(value: string, maxBytes: number): {
  text: string;
  truncated: boolean;
} {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { text: value, truncated: false };
  }
  const characters = [...value];
  let start = characters.length;
  let bytes = 0;
  while (start > 0) {
    const size = Buffer.byteLength(characters[start - 1], "utf8");
    if (bytes + size > maxBytes) break;
    start -= 1;
    bytes += size;
  }
  return { text: characters.slice(start).join(""), truncated: true };
}

async function exactTargetInspection(
  input: TerminalControlExactTargetInput,
  establishIdentity: boolean,
): Promise<TerminalControlExactTargetObservation> {
  const managedSession = exactManagedSession(input.managedName);
  if (managedSession.kind !== input.managedKind) {
    throw new TerminalControlProtocolError(
      "TARGET_GONE",
      "managed session kind no longer matches the exact target",
    );
  }
  let live;
  try {
    const matches = listTmuxSessionLifecycleEntries().filter(
      (candidate) => candidate.rawName === input.managedName,
    );
    if (matches.length !== 1) {
      throw new TerminalControlProtocolError(
        matches.length === 0 ? "TARGET_GONE" : "RECOVERY_REQUIRED",
        "managed tmux incarnation is missing or ambiguous",
      );
    }
    live = matches[0];
  } catch (error) {
    if (error instanceof TerminalControlProtocolError) throw error;
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      `could not inspect the managed tmux incarnation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const observed = observeManagedSessionIncarnation(managedSession, live);
  if (!observed || observed.incarnation !== input.managedIncarnation) {
    throw new TerminalControlProtocolError(
      "TARGET_GONE",
      "managed tmux incarnation no longer matches the exact target",
    );
  }
  const pane = await requirePane(input.managedName, String(input.pane));
  if (pane.sessionId !== live.sessionId) {
    throw new TerminalControlProtocolError(
      "TARGET_GONE",
      "managed pane crossed the exact tmux incarnation",
    );
  }
  let tmuxInstanceId = await currentTmuxInstanceId(pane.sessionId);
  if (!tmuxInstanceId && establishIdentity) {
    tmuxInstanceId = randomUUID();
    await runTmux(["set-option", "-t", pane.sessionId, TMUX_INSTANCE_OPTION, tmuxInstanceId]);
    const confirmed = await currentTmuxInstanceId(pane.sessionId);
    if (confirmed !== tmuxInstanceId) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "could not establish exact tmux backend lifecycle identity",
      );
    }
  }
  return {
    managedSession,
    managedIncarnation: observed.incarnation,
    tmuxInstanceId: tmuxInstanceId ?? null,
    paneIdentity: pane.paneTarget,
  };
}

export class TmuxTerminalControlBackend implements TerminalControlBackend {
  private readonly agentSourceBoundaries = new Map<string, AgentSourceBoundary>();
  private readonly agentResumeInputTimeoutMs: number;

  constructor(options: Readonly<{ agentResumeInputTimeoutMs?: number }> = {}) {
    const timeout = options.agentResumeInputTimeoutMs
      ?? TERMINAL_CONTROL_AGENT_RESUME_INPUT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout)
      || timeout < AGENT_MESSAGE_SUBMIT_PACE_MS
      || timeout > TERMINAL_CONTROL_AGENT_RESUME_INPUT_TIMEOUT_MS) {
      throw new TypeError("Agent resume input timeout is invalid");
    }
    this.agentResumeInputTimeoutMs = timeout;
  }

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

  async inspectExactTarget(
    input: TerminalControlExactTargetInput,
  ): Promise<TerminalControlExactTargetInspection> {
    const observed = await exactTargetInspection(input, false);
    if (observed.tmuxInstanceId === null) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal-control identity has not been established for the exact target",
      );
    }
    return {
      ...observed,
      tmuxInstanceId: observed.tmuxInstanceId,
    };
  }

  observeExactTarget(
    input: TerminalControlExactTargetInput,
  ): Promise<TerminalControlExactTargetObservation> {
    return exactTargetInspection(input, false);
  }

  async establishExactTarget(
    input: TerminalControlExactTargetInput,
  ): Promise<TerminalControlExactTargetInspection> {
    const established = await exactTargetInspection(input, true);
    if (established.tmuxInstanceId === null) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal-control identity was not established for the exact target",
      );
    }
    return {
      ...established,
      tmuxInstanceId: established.tmuxInstanceId,
    };
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
    await pasteRawToPane(paneTarget, data);
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
    const canonicalPaneTarget = `=${expected.name}:`;
    let paneId: string;
    try {
      const probe = await runTmux([
        "display-message",
        "-p",
        "-t",
        canonicalPaneTarget,
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
    if (data.byteLength === 0) return;
    const condition = [
      `#{==:#{pane_id},${paneId}}`,
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
          shellQuote(canonicalPaneTarget),
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
          canonicalPaneTarget,
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
    await pasteAgentMessage(paneTarget, message, submit);
  }

  async sendAgentMessageFenced(
    expected: Pick<ManagedSession, "name" | "kind" | "createdAt">,
    tmuxInstanceId: string,
    outputGeneration: string,
    pane: string,
    message: string,
    submit: boolean,
    runtime?: TerminalControlAgentRuntimeSettings,
  ): Promise<void> {
    let userMessagePasteStarted = false;
    try {
      let observed = await requireFencedTerminalPane(
      expected,
      tmuxInstanceId,
      outputGeneration,
      pane,
    );
    const provider = agentProviderFromStartCommand(observed.paneStartCommand);
    if (!provider) {
      throw new TerminalControlProtocolError(
        "INVALID_REQUEST",
        "managed terminal was not created for a supported Agent",
      );
    }
    if (runtime !== undefined && provider !== "codex") {
      throw new TerminalControlAgentMessageNotAppliedError(
        "INVALID_REQUEST",
        "Agent runtime settings are currently supported only for Codex sessions",
      );
    }
    if (runtime !== undefined && !submit) {
      throw new TerminalControlAgentMessageNotAppliedError(
        "INVALID_REQUEST",
        "Agent runtime settings require a submitted new turn",
      );
    }
    const boundaryKey = agentSourceBoundaryKey(expected, tmuxInstanceId, pane);
    const processState = await paneAgentProcessState(observed.panePid, provider);
    // A long-lived idle Codex TUI keeps the credential snapshot it started
    // with. Resume the same persisted session before a new submitted turn so
    // account changes are picked up without losing conversation history.
    // Active turns still accept steering input through the existing process.
    const refreshIdleCodex = provider === "codex"
      && processState === "agent"
      && !observed.agentRunning
      && submit;
    if (runtime !== undefined && processState === "agent" && !refreshIdleCodex) {
      throw new TerminalControlAgentMessageNotAppliedError(
        "INVALID_REQUEST",
        "Agent runtime settings can only be changed between turns",
      );
    }
    if (processState === "agent" && !refreshIdleCodex) {
      let boundary: AgentSourceBoundary | undefined;
      if (!observed.agentRunning && submit) {
        const sessionId = resumedAgentSessionIdFromStartCommand(
          observed.paneStartCommand,
          provider,
        );
        boundary = {
          paneId: observed.paneId,
          provider,
          cwd: observed.paneCurrentPath,
          ...(sessionId === undefined ? {} : { sessionId }),
          startedAtNotBefore: new Date().toISOString(),
          expectedUserMessage: message,
        };
        this.agentSourceBoundaries.set(boundaryKey, boundary);
      }
      userMessagePasteStarted = true;
      await pasteAgentMessage(observed.paneId, message, submit);
      if (boundary !== undefined) {
        const freshSource = await waitForAgentSource(
          boundary,
          Date.parse(boundary.startedAtNotBefore) + this.agentResumeInputTimeoutMs,
        );
        // tmux has already confirmed delivery into the exact fenced pane. A
        // cold Codex process may publish its correlated UserMessage only after
        // this bounded synchronous confirmation window. Preserve the boundary
        // so Agent status polling can bind that source later; returning an
        // error here would incorrectly journal a delivered operation in-doubt
        // and allow the same user-visible turn to arrive after the failure.
        if (freshSource !== undefined) boundary.capturedSource = freshSource;
      }
      return;
    }
    if (!refreshIdleCodex
      && (processState !== "idle" || !isShellProcess(observed.paneCurrentCommand))) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "managed Agent pane is occupied by a different foreground process",
      );
    }

    if (provider === "codex") await waitForCodexResumeEnvironmentHydration();
    // Environment hydration is daemon startup work, not part of the exact
    // Agent submission budget. Starting this deadline afterward keeps the
    // backend bound aligned with the enclosing transport contract.
    const inputDeadline = Date.now() + this.agentResumeInputTimeoutMs;
    const sessionId = resumedAgentSessionIdFromStartCommand(
      observed.paneStartCommand,
      provider,
    ) ?? discoverLatestResumableAgentSession({ provider, cwd: observed.paneCurrentPath });
    if (Date.now() >= inputDeadline) {
      throw new TerminalControlAgentMessageNotAppliedError(
        "RESOURCE_EXHAUSTED",
        "managed Agent resume discovery exceeded the input deadline",
        true,
      );
    }
    const inheritedCodexModel = runtime === undefined && provider === "codex"
      ? codexModelFromStartCommand(observed.paneStartCommand)
      : undefined;
    const codexCommand = buildCodexResumeCommand(sessionId, runtime, inheritedCodexModel);
    const command = sessionId === undefined
      ? provider === "codex" ? codexCommand : provider
      : provider === "codex"
        ? codexCommand
        : `claude --resume ${shellQuote(sessionId)}`;
    const resumeEnvironment = provider === "codex"
      ? codexResumeEnvironmentArguments()
      : [];
    await runTmux([
      "respawn-pane",
      "-k",
      "-t", observed.paneId,
      "-c", observed.paneCurrentPath,
      ...resumeEnvironment,
      commandThenLoginShell(command, expected.name),
    ]);

    const readyDeadline = Math.min(
      inputDeadline,
      Date.now() + AGENT_RESUME_READY_TIMEOUT_MS,
    );
    while (Date.now() < readyDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, AGENT_RESUME_POLL_MS));
      observed = await requireFencedTerminalPane(
        expected,
        tmuxInstanceId,
        outputGeneration,
        pane,
      );
      if (await paneAgentProcessState(observed.panePid, provider) !== "agent") continue;
      await new Promise<void>((resolve) => setTimeout(resolve, AGENT_RESUME_SETTLE_MS));
      observed = await requireFencedTerminalPane(
        expected,
        tmuxInstanceId,
        outputGeneration,
        pane,
      );
      if (await paneAgentProcessState(observed.panePid, provider) !== "agent") continue;
      if (runtime !== undefined) await ensureCodexMode(observed.paneId, runtime.mode);
      const boundary: AgentSourceBoundary = {
        paneId: observed.paneId,
        provider,
        cwd: observed.paneCurrentPath,
        ...(sessionId === undefined ? {} : { sessionId }),
        startedAtNotBefore: new Date().toISOString(),
        expectedUserMessage: message,
      };
      this.agentSourceBoundaries.set(boundaryKey, boundary);
      userMessagePasteStarted = true;
      await pasteAgentMessage(observed.paneId, message, submit);
      if (submit) {
        const initialSourceDeadline = Math.min(
          inputDeadline,
          Date.now() + AGENT_RESUME_INITIAL_SOURCE_WAIT_MS,
        );
        let freshSource = await waitForAgentSource(boundary, initialSourceDeadline);
        while (freshSource === undefined && Date.now() < inputDeadline) {
          observed = await requireFencedTerminalPane(
            expected,
            tmuxInstanceId,
            outputGeneration,
            pane,
          );
          if (observed.paneId !== boundary.paneId
            || observed.paneCurrentPath !== boundary.cwd
            || agentProviderFromStartCommand(observed.paneStartCommand) !== boundary.provider
            || resumedAgentSessionIdFromStartCommand(
              observed.paneStartCommand,
              boundary.provider,
            ) !== boundary.sessionId
            || await paneAgentProcessState(observed.panePid, provider) !== "agent") {
            throw new TerminalControlProtocolError(
              "RECOVERY_REQUIRED",
              "managed Agent changed before cold-resume submit confirmation",
            );
          }
          await pasteAgentMessage(observed.paneId, "", true);
          freshSource = await waitForAgentSource(
            boundary,
            Math.min(inputDeadline, Date.now() + AGENT_RESUME_SUBMIT_RETRY_MS),
          );
        }
        if (freshSource !== undefined) boundary.capturedSource = freshSource;
      }
      return;
    }
    if (runtime !== undefined) {
      throw new TerminalControlAgentMessageNotAppliedError(
        "RESOURCE_EXHAUSTED",
        "managed Codex could not be resumed before the input deadline",
        true,
      );
    }
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "managed Agent could not be resumed before the input deadline",
    );
    } catch (error) {
      if (runtime !== undefined && !userMessagePasteStarted) {
        if (error instanceof TerminalControlAgentMessageNotAppliedError) throw error;
        if (error instanceof TerminalControlProtocolError) {
          throw new TerminalControlAgentMessageNotAppliedError(
            error.code,
            error.message,
            error.retryable,
          );
        }
        throw new TerminalControlAgentMessageNotAppliedError(
          "RESOURCE_EXHAUSTED",
          error instanceof Error ? error.message : "Codex runtime settings could not be applied",
          true,
        );
      }
      throw error;
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
    const paneState = (await runTmux([
      "display-message",
      "-p",
      "-t",
      paneTarget,
      "#{pane_in_mode}\u001f#{alternate_on}\u001f#{mouse_any_flag}\u001f#{mouse_sgr_flag}\u001f#{pane_width}\u001f#{pane_height}",
    ])).stdout.trim().split("\u001f");
    const inMode = paneState[0] === "1";
    if (!inMode && paneState[1] === "1" && paneState[2] === "1" && paneState[3] === "1") {
      const payload = sgrMouseWheelPayload(
        direction,
        lines,
        Number(paneState[4]),
        Number(paneState[5]),
      );
      if (payload) {
        // Full-screen TUIs such as Claude own their transcript inside the
        // alternate screen, so tmux has no scrollback to navigate. Synthesize
        // only the SGR wheel protocol the pane explicitly requested; generic
        // client mouse reports remain blocked at the controlled attachment.
        await pasteRawToPane(paneTarget, payload);
        return;
      }
    }
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
    const managed = exactManagedSession(sessionName);
    let live;
    try {
      live = listTmuxSessionLifecycleEntries()
        .find((candidate) => candidate.rawName === sessionName);
    } catch (error) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        error instanceof Error ? error.message : "could not read the managed tmux identity",
      );
    }
    if (!live) {
      throw new TerminalControlProtocolError(
        "TARGET_GONE",
        `managed session is not live: ${sessionName}`,
      );
    }
    const observed = observeManagedSessionIncarnation(managed, live);
    if (!observed?.lifecycleMarked) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        `managed session has no authoritative v2 lifecycle identity: ${sessionName}`,
      );
    }
    const result = killManagedSessionV2({
      name: sessionName,
      expectedIncarnation: observed.incarnation,
    });
    if (result.state === "succeeded") return;
    throw new TerminalControlProtocolError(
      result.state === "failed" && result.code === "SESSION_NOT_FOUND"
        ? "TARGET_GONE"
        : "RECOVERY_REQUIRED",
      result.message,
    );
  }

  async prepareOutput(
    controlTargetId: string,
    sessionName: string,
    pane: string,
    generation?: string,
    capturePane = true,
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
        const position = outputPositionFromSegments(generation, segments);
        // A controller can be asked to close while the pane snapshot is not
        // yet observable (for example during app shutdown).  Do not let that
        // empty generation strand the next Relay v2 observer until the pane
        // happens to emit more output: an explicit capture request is the
        // safe point to rotate and seed the current rendered pane again.
        if (capturePane && position.cursor === 0) {
          const nextGeneration = randomUUID();
          return establishSegmentedOutputCapture(
            sessionId,
            target,
            outputCapturePaths(controlTargetId, nextGeneration),
            nextGeneration,
            true,
          );
        }
        pruneObsoleteOutputFiles(paths);
        return position;
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
    return establishSegmentedOutputCapture(sessionId, target, paths, nextGeneration, capturePane);
  }

  async resetOutput(
    controlTargetId: string,
    sessionName: string,
    pane: string,
    previousGeneration: string,
  ): Promise<TerminalControlOutputPosition> {
    const { sessionId, paneTarget: target } = await requirePane(sessionName, pane);
    const configured = await outputCaptureBackendState(target);
    if (configured.generation && configured.generation !== previousGeneration) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal output generation changed outside the authority",
      );
    }
    const nextGeneration = randomUUID();
    return establishSegmentedOutputCapture(
      sessionId,
      target,
      outputCapturePaths(controlTargetId, nextGeneration),
      nextGeneration,
      true,
    );
  }

  async recoverOutput(
    controlTargetId: string,
    sessionName: string,
    pane: string,
    previousGeneration: string,
    recoveryGeneration: string,
  ): Promise<TerminalControlOutputPosition> {
    const { sessionId, paneTarget: target } = await requirePane(sessionName, pane);
    const configured = await outputCaptureBackendState(target);
    const isPreviousGeneration = !configured.generation
      || configured.generation === previousGeneration;
    const isPlannedGeneration = configured.generation === recoveryGeneration;
    if (!isPreviousGeneration && !isPlannedGeneration && configured.pipeActive) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal output generation changed outside the recovery transaction",
      );
    }
    if (configured.pipeActive) {
      // Freeze the exact planned segment set before deciding which file to
      // append. A live writer could otherwise rotate between the scan and the
      // replacement pipe, leaving the resumed writer on a stale full segment.
      await runTmux(["pipe-pane", "-t", target]);
    }
    const paths = outputCapturePaths(controlTargetId, recoveryGeneration);
    const kind = outputCaptureKind(paths);
    if (kind === "missing") {
      return establishSegmentedOutputCapture(
        sessionId,
        target,
        paths,
        recoveryGeneration,
      );
    }
    if (kind === "legacy") {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "planned terminal output recovery has incompatible legacy data",
      );
    }
    return resumeSegmentedOutputCapture(
      sessionId,
      target,
      paths,
      recoveryGeneration,
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

  async captureRenderedSnapshot(
    expected: Pick<ManagedSession, "name" | "kind" | "createdAt">,
    tmuxInstanceId: string,
    outputGeneration: string,
    pane: string,
    maxBytes: number,
  ): Promise<TerminalControlRenderedSnapshot> {
    if (!Number.isSafeInteger(maxBytes)
      || maxBytes < 1
      || maxBytes > TERMINAL_CONTROL_MAX_RENDERED_SNAPSHOT_BYTES) {
      throw new TerminalControlProtocolError(
        "INVALID_REQUEST",
        "rendered terminal snapshot size is invalid",
      );
    }
    const beforePane = await requireFencedTerminalPane(
      expected,
      tmuxInstanceId,
      outputGeneration,
      pane,
    );
    let captured: TmuxResult | undefined;
    let captureError: unknown;
    try {
      captured = await runTmux([
        "capture-pane",
        "-p",
        "-J",
        "-S",
        `-${RENDERED_SNAPSHOT_HISTORY_LINES}`,
        "-E",
        "-",
        "-t",
        beforePane.paneId,
      ], { maxStdoutBytes: MAX_RENDERED_SNAPSHOT_SOURCE_BYTES });
    } catch (error) {
      captureError = error;
    }

    const afterPane = await requireFencedTerminalPane(
      expected,
      tmuxInstanceId,
      outputGeneration,
      pane,
    );
    if (afterPane.paneId !== beforePane.paneId) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "terminal pane identity changed during rendered output capture",
      );
    }
    if (captureError instanceof TmuxStdoutLimitError) {
      throw new TerminalControlProtocolError(
        "RESOURCE_EXHAUSTED",
        "rendered terminal snapshot exceeded its bounded source limit",
      );
    }
    if (captureError) throw captureError;
    const bounded = boundedUtf8Tail(captured!.stdout, maxBytes);
    return {
      dataBase64: Buffer.from(bounded.text, "utf8").toString("base64"),
      truncated: bounded.truncated,
    };
  }

  async agentStatus(
    expected: Pick<ManagedSession, "name" | "kind" | "createdAt">,
    tmuxInstanceId: string,
    outputGeneration: string,
    pane: string,
  ): Promise<TerminalControlAgentStatus> {
    const observed = await requireFencedTerminalPane(
      expected,
      tmuxInstanceId,
      outputGeneration,
      pane,
    );
    const boundaryKey = agentSourceBoundaryKey(expected, tmuxInstanceId, pane);
    const boundary = this.agentSourceBoundaries.get(boundaryKey);
    const provider = agentProviderFromStartCommand(observed.paneStartCommand);
    if (!provider) {
      this.agentSourceBoundaries.delete(boundaryKey);
      return { agentSupported: false, agentRunning: false };
    }
    if (!observed.paneCurrentPath.startsWith("/")) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "the running Agent working directory is not absolute",
      );
    }
    if (boundary !== undefined
      && (boundary.paneId !== observed.paneId
        || boundary.provider !== provider
        || boundary.cwd !== observed.paneCurrentPath)) {
      this.agentSourceBoundaries.delete(boundaryKey);
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "the managed Agent changed across its input source boundary",
      );
    }
    const resumedSessionId = resumedAgentSessionIdFromStartCommand(
      observed.paneStartCommand,
      provider,
    );
    if (boundary !== undefined && boundary.sessionId !== resumedSessionId) {
      this.agentSourceBoundaries.delete(boundaryKey);
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "the resumed Agent session changed across its input source boundary",
      );
    }
    if (boundary !== undefined && boundary.capturedSource === undefined) {
      boundary.capturedSource = pendingAgentSource(boundary);
    }
    if (boundary?.capturedSource !== undefined) {
      const source = boundary.capturedSource;
      let progress: TerminalControlAgentProgressStep[] = [];
      try {
        progress = readAgentProgress({ source, cwd: observed.paneCurrentPath });
      } catch (error) {
        if (!(error instanceof TerminalControlProtocolError
          && error.code === "RESOURCE_EXHAUSTED"
          && error.retryable)) throw error;
      }
      // The boundary exists only to correlate the first status observation
      // after an exact submitted input. Once that source has been handed to
      // the caller, retaining the boundary would rediscover the same completed
      // transcript on every later poll and falsely report the Agent as running
      // forever. The caller keeps the immutable source for the eventual
      // activity.agent-result request, so consume the whole boundary here.
      this.agentSourceBoundaries.delete(boundaryKey);
      return { agentSupported: true, agentRunning: true, provider, source, progress };
    }
    if (!observed.agentRunning) {
      return { agentSupported: true, agentRunning: false, provider };
    }
    const activity = discoverActiveAgentActivity({
      provider,
      cwd: observed.paneCurrentPath,
      sessionId: boundary?.sessionId ?? resumedSessionId,
      startedAtNotBefore: boundary?.startedAtNotBefore,
      expectedUserMessage: boundary?.expectedUserMessage,
    });
    return {
      agentSupported: true,
      agentRunning: true,
      provider,
      source: activity.source,
      progress: activity.progress,
    };
  }

  async agentResult(
    expected: Pick<ManagedSession, "name" | "kind" | "createdAt">,
    tmuxInstanceId: string,
    outputGeneration: string,
    pane: string,
    source: TerminalControlAgentSource,
    maxBytes: number,
  ): Promise<TerminalControlAgentResult> {
    if (!Number.isSafeInteger(maxBytes)
      || maxBytes < 1
      || maxBytes > TERMINAL_CONTROL_MAX_AGENT_RESULT_BYTES) {
      throw new TerminalControlProtocolError("INVALID_REQUEST", "Agent result size is invalid");
    }
    const before = await requireFencedTerminalPane(
      expected,
      tmuxInstanceId,
      outputGeneration,
      pane,
    );
    if (before.agentRunning) {
      throw new TerminalControlProtocolError(
        "RESOURCE_EXHAUSTED",
        "the Agent is still running and has no final response yet",
        true,
      );
    }
    const provider = agentProviderFromStartCommand(before.paneStartCommand);
    if (provider !== source.provider || !before.paneCurrentPath.startsWith("/")) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "the Agent result source no longer matches the managed terminal",
      );
    }
    const result = readCompletedAgentResult({
      source,
      cwd: before.paneCurrentPath,
      maxBytes,
    });
    const after = await requireFencedTerminalPane(
      expected,
      tmuxInstanceId,
      outputGeneration,
      pane,
    );
    if (after.paneId !== before.paneId || after.agentRunning
      || after.paneStartCommand !== before.paneStartCommand
      || after.paneCurrentPath !== before.paneCurrentPath) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        "the managed Agent changed during final response extraction",
      );
    }
    return result;
  }
}
