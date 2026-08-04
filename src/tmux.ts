import { spawnSync, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { loadConfigFile } from "./config";

// ============================================
// tmux.ts — 安全执行 git / tmux 的底层模块
//
// 所有外部命令都用 spawn(bin, [args]) 直接调用，不经过 shell，
// 因此路径 / 分支名 / session 名即便含空格或 shell 元字符也不会被解析或注入。
// 这里同时集中 session / worktree 的列举与删除原语，供各命令复用。
// ============================================

const COMMAND_TERMINATION_GRACE_MS = 100;
const COMMAND_KILL_SETTLE_MS = 250;
const COMMAND_MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
const COMMAND_HELPER_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

type CommandMode = "query" | "run" | "exec";

type CommandHelperStatus = {
  kind: "exit" | "timeout" | "descendants" | "output" | "spawn" | "signal" | "unkillable";
  code?: number | null;
  signal?: string | null;
  message?: string;
};

type SyncCommandResult = {
  status?: CommandHelperStatus;
  stdout: string;
  stderr: string;
  helperError?: Error;
};

/**
 * `spawnSync`/`execFileSync` timeouts only send one signal and can block forever
 * when a command ignores it. Run the real command under a tiny asynchronous
 * supervisor instead: the public API remains synchronous, while the supervisor
 * can escalate TERM to KILL and wait for the command process group to disappear.
 *
 * fd 3 is a private status channel, keeping command stdout/stderr byte-for-byte
 * compatible with the old wrappers. The supervisor stays in its caller's
 * process group and forwards shutdown signals to the detached command group, so
 * an outer relay-host group shutdown cannot orphan the supervised command.
 */
const SYNC_COMMAND_HELPER = `
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const spec = JSON.parse(process.argv[1]);
const detached = process.platform !== "win32";
let child;
let pid;
let childClosed = false;
let targetCode = null;
let targetSignal = null;
let failure = null;
let settled = false;
let timeoutTimer;
let forceTimer;
let hardTimer;
let pollTimer;
let pendingSignal = null;
const stdoutChunks = [];
const stderrChunks = [];
let stdoutBytes = 0;
let stderrBytes = 0;

function groupExists() {
  if (!detached || !pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function signalCommand(signal) {
  if (detached && pid) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (_) {}
  }
  try {
    if (child) child.kill(signal);
  } catch (_) {}
}

function cleanup() {
  if (timeoutTimer) clearTimeout(timeoutTimer);
  if (forceTimer) clearTimeout(forceTimer);
  if (hardTimer) clearTimeout(hardTimer);
  if (pollTimer) clearTimeout(pollTimer);
}

function writeFd(fd, value) {
  if (!value || value.length === 0) return;
  try {
    fs.writeSync(fd, value);
  } catch (_) {}
}

function finish(force) {
  if (settled) return;
  if (!force && !childClosed) return;
  if (!force && groupExists()) {
    if (!pollTimer) {
      pollTimer = setTimeout(() => {
        pollTimer = undefined;
        finish(false);
      }, 10);
    }
    return;
  }
  settled = true;
  cleanup();
  if (spec.mode !== "exec") {
    writeFd(1, Buffer.concat(stdoutChunks, stdoutBytes));
    if (spec.mode === "run") writeFd(2, Buffer.concat(stderrChunks, stderrBytes));
  }
  let status = failure || {
    kind: "exit",
    code: targetCode,
    signal: targetSignal,
  };
  if (force && groupExists()) {
    status = {
      kind: "unkillable",
      code: targetCode,
      signal: targetSignal,
      message: "command process group survived SIGKILL",
    };
  }
  writeFd(3, Buffer.from(JSON.stringify(status), "utf8"));
  const success = status.kind === "exit" && status.code === 0 && !status.signal;
  process.exit(success ? 0 : 1);
}

function beginTermination(status) {
  if (settled || failure) return;
  failure = status;
  signalCommand("SIGTERM");
  forceTimer = setTimeout(() => {
    signalCommand("SIGKILL");
    hardTimer = setTimeout(() => {
      signalCommand("SIGKILL");
      try { if (child && child.stdout) child.stdout.destroy(); } catch (_) {}
      try { if (child && child.stderr) child.stderr.destroy(); } catch (_) {}
      finish(true);
    }, spec.killSettleMs);
    finish(false);
  }, spec.graceMs);
}

function onSupervisorSignal(signal) {
  pendingSignal = signal;
  if (child) {
    beginTermination({
      kind: "signal",
      signal,
      message: "command supervisor received " + signal,
    });
  }
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => onSupervisorSignal(signal));
}

if (pendingSignal) {
  failure = { kind: "signal", signal: pendingSignal };
  childClosed = true;
  finish(false);
}

const stdio = spec.mode === "exec"
  ? "inherit"
  : spec.mode === "query"
    ? ["ignore", "pipe", "ignore"]
    : ["ignore", "pipe", "pipe"];

try {
  child = spawn(spec.file, spec.args, { detached, stdio });
  pid = child.pid;
} catch (error) {
  failure = {
    kind: "spawn",
    message: error instanceof Error ? error.message : String(error),
  };
  childClosed = true;
  finish(false);
}

function collect(stream, output) {
  if (!stream) return;
  stream.on("data", (raw) => {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const current = output === "stdout" ? stdoutBytes : stderrBytes;
    if (current + chunk.byteLength > spec.maxOutputBytes) {
      beginTermination({
        kind: "output",
        message: "command " + output + " exceeded " + spec.maxOutputBytes + " bytes",
      });
      return;
    }
    if (output === "stdout") {
      stdoutBytes += chunk.byteLength;
      stdoutChunks.push(Buffer.from(chunk));
    } else {
      stderrBytes += chunk.byteLength;
      stderrChunks.push(Buffer.from(chunk));
    }
  });
}

if (child) {
  collect(child.stdout, "stdout");
  collect(child.stderr, "stderr");
  child.once("error", (error) => {
    if (!failure) {
      failure = {
        kind: "spawn",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
  child.once("exit", (code, signal) => {
    targetCode = code;
    targetSignal = signal;
    if (!failure && groupExists()) {
      beginTermination({
        kind: "descendants",
        code,
        signal,
        message: "command left descendant processes after exit",
      });
    }
  });
  child.once("close", (code, signal) => {
    childClosed = true;
    if (targetCode === null && code !== null) targetCode = code;
    if (targetSignal === null && signal !== null) targetSignal = signal;
    finish(false);
  });
  if (spec.timeout > 0) {
    timeoutTimer = setTimeout(() => {
      beginTermination({
        kind: "timeout",
        message: "command timed out after " + spec.timeout + "ms",
      });
    }, spec.timeout);
  }
  if (pendingSignal) onSupervisorSignal(pendingSignal);
}
`;

function runSyncCommand(
  file: string,
  args: string[],
  timeout: number,
  mode: CommandMode,
): SyncCommandResult {
  const spec = JSON.stringify({
    file,
    args,
    timeout,
    mode,
    graceMs: COMMAND_TERMINATION_GRACE_MS,
    killSettleMs: COMMAND_KILL_SETTLE_MS,
    maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES,
  });
  const stdio: StdioOptions = mode === "exec"
    ? ["inherit", "inherit", "inherit", "pipe"]
    : mode === "query"
      ? ["ignore", "pipe", "ignore", "pipe"]
      : ["ignore", "pipe", "pipe", "pipe"];
  const result = spawnSync(process.execPath, ["-e", SYNC_COMMAND_HELPER, spec], {
    encoding: "utf-8",
    maxBuffer: COMMAND_HELPER_MAX_BUFFER_BYTES,
    stdio,
  });
  const rawStatus = result.output?.[3];
  let status: CommandHelperStatus | undefined;
  if (typeof rawStatus === "string" && rawStatus) {
    try {
      status = JSON.parse(rawStatus) as CommandHelperStatus;
    } catch {}
  }
  return {
    status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    ...(result.error ? { helperError: result.error } : {}),
  };
}

function commandSucceeded(result: SyncCommandResult): boolean {
  return !result.helperError
    && result.status?.kind === "exit"
    && result.status.code === 0
    && !result.status.signal;
}

function commandFailureDetail(result: SyncCommandResult): string {
  if (result.helperError) return result.helperError.message;
  const status = result.status;
  if (!status) return "command supervisor exited without status";
  const stderr = result.stderr.trim();
  const detail = status.message || (
    status.signal
      ? `command exited on ${status.signal}`
      : `command exited with status ${String(status.code)}`
  );
  return stderr ? `${detail}: ${stderr}` : detail;
}

// 内部 session 前缀：dashboard 的临时终端与移动端，CLI 命令族应忽略
const INTERNAL_SESSION_PREFIXES = ["tw-term-", "tw-mobile-"];

export function isInternalSession(name: string): boolean {
  return INTERNAL_SESSION_PREFIXES.some((p) => name.startsWith(p));
}

let cachedTmux: string | null = null;

function isRunnableReference(value: string): boolean {
  return !value.includes("/") || existsSync(value);
}

/** 解析 tmux 可执行文件路径（缓存）。 */
export function tmuxBin(): string {
  if (cachedTmux) return cachedTmux;
  const envTmux = process.env.TW_TMUX?.trim();
  if (envTmux && isRunnableReference(envTmux)) {
    cachedTmux = envTmux;
    return cachedTmux;
  }
  const configuredTmux = loadConfigFile()?.tmuxPath?.trim();
  if (configuredTmux && isRunnableReference(configuredTmux)) {
    cachedTmux = configuredTmux;
    return cachedTmux;
  }
  for (const p of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    if (existsSync(p)) {
      cachedTmux = p;
      return p;
    }
  }
  cachedTmux = "tmux";
  return cachedTmux;
}

/** 运行命令，返回 trim 后的 stdout；失败返回空串（用于查询，不抛错，吞掉 stderr）。 */
export function query(bin: string, args: string[], timeout = 5000): string {
  try {
    const result = runSyncCommand(bin, args, timeout, "query");
    return commandSucceeded(result) ? result.stdout.trim() : "";
  } catch {
    return "";
  }
}

/** 运行命令，stdio 继承到终端；失败抛 CliError（用于会改状态的操作）。 */
export function exec(bin: string, args: string[], timeout = 30000): void {
  try {
    const result = runSyncCommand(bin, args, timeout, "exec");
    if (!commandSucceeded(result)) throw new Error(commandFailureDetail(result));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(`命令失败: ${bin} ${args.join(" ")}\n  ${detail}`);
  }
}

/** 运行命令并捕获 stdout；失败抛 CliError。 */
export function run(bin: string, args: string[], timeout = 30000): string {
  try {
    const result = runSyncCommand(bin, args, timeout, "run");
    if (!commandSucceeded(result)) throw new Error(commandFailureDetail(result));
    return result.stdout.trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(`命令失败: ${bin} ${args.join(" ")}\n  ${detail}`);
  }
}

/** 交互式运行（无超时，stdio 继承），用于 tmux attach 等需要把 TTY 交给子进程、
 *  可能持续很久的命令。返回子进程退出码，不抛错。 */
export function execInteractive(bin: string, args: string[]): number {
  const res = spawnSync(bin, args, { stdio: "inherit" });
  return res.status ?? 0;
}

/** 面向用户的错误：cli 顶层捕获后只打印 message，不打印 stack trace。 */
export class CliError extends Error {}

// ─── git 原语 ───

export function git(repoDir: string, args: string[], timeout = 30000): string {
  return run("git", ["-C", repoDir, ...args], timeout);
}

export function gitQuery(repoDir: string, args: string[], timeout = 10000): string {
  return query("git", ["-C", repoDir, ...args], timeout);
}

export function isGitRepo(dir: string): boolean {
  return gitQuery(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

export interface WorktreeEntry {
  path: string;
  branch: string; // 去掉 refs/heads/ 前缀；detached 时为 "(detached)"
  head: string;
  bare: boolean;
}

/** 解析 `git worktree list --porcelain`，返回该仓库的所有 worktree。 */
export function listWorktrees(repoDir: string): WorktreeEntry[] {
  const raw = gitQuery(repoDir, ["worktree", "list", "--porcelain"]);
  if (!raw) return [];
  const entries: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur.path) entries.push(finishWorktree(cur));
      cur = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line === "bare") {
      cur.bare = true;
    } else if (line === "detached") {
      cur.branch = "(detached)";
    }
  }
  if (cur.path) entries.push(finishWorktree(cur));
  return entries;
}

function finishWorktree(cur: Partial<WorktreeEntry>): WorktreeEntry {
  return {
    path: cur.path!,
    branch: cur.branch ?? "(detached)",
    head: cur.head ?? "",
    bare: cur.bare ?? false,
  };
}

/** 工作区是否有未提交改动（含未跟踪文件）。目录不存在时返回 false。 */
export function worktreeIsDirty(worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false;
  return gitQuery(worktreePath, ["status", "--porcelain"]).length > 0;
}

/** worktree 目录是否仍存在于磁盘。 */
export function worktreeExists(worktreePath: string): boolean {
  return existsSync(worktreePath);
}

/** 删除 worktree；force 时丢弃未提交改动。失败抛 CliError。 */
export function removeWorktree(repoDir: string, worktreePath: string, force = false): void {
  const args = ["worktree", "remove", worktreePath];
  if (force) args.push("--force");
  git(repoDir, args);
}

/** 删除本地分支。默认用安全的 -d（仅删已合并分支，未合并会被 git 拒绝）；
 *  force=true 用 -D 强删。detached 占位名跳过。
 *  返回是否删除成功（false 表示未合并被拒或不存在）。 */
export function deleteBranch(repoDir: string, branch: string, force = false): boolean {
  if (!branch || branch === "(detached)") return false;
  try {
    return commandSucceeded(runSyncCommand(
      "git",
      ["-C", repoDir, "branch", force ? "-D" : "-d", branch],
      10000,
      "query",
    ));
  } catch {
    return false;
  }
}

// ─── tmux 原语 ───

export interface SessionEntry {
  name: string;
  attached: boolean;
  windows: number;
  created: number;
  activity: number;
  cwd: string;
}

/** 列出 tmux session（默认排除内部 tw-term-/tw-mobile-）。 */
export function listSessions(includeInternal = false): SessionEntry[] {
  const tmux = tmuxBin();
  const fmt =
    "#{session_name}\x1f#{session_attached}\x1f#{session_windows}\x1f#{session_created}\x1f#{session_activity}\x1f#{pane_current_path}";
  const raw = query(tmux, ["list-sessions", "-F", fmt]);
  if (!raw) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, att, win, cre, act, cwd] = line.split("\x1f");
      return {
        name,
        attached: att === "1",
        windows: parseInt(win) || 0,
        created: parseInt(cre) || 0,
        activity: parseInt(act) || 0,
        cwd: cwd || "",
      };
    })
    .filter((s) => includeInternal || !isInternalSession(s.name));
}

/** session 是否存在（精确名匹配 `=name`，用 exit code 判定）。 */
export function sessionExists(name: string): boolean {
  try {
    return commandSucceeded(runSyncCommand(
      tmuxBin(),
      ["has-session", "-t", `=${name}`],
      3000,
      "query",
    ));
  } catch {
    return false;
  }
}

export function killSession(name: string): void {
  query(tmuxBin(), ["kill-session", "-t", `=${name}`]);
}

export function insideTmux(): boolean {
  return !!process.env.TMUX;
}

// ─── config 路径辅助 ───

/** worktree 路径中用作 label 的项目名：取倒数第二段目录名。
 *  约定路径形如 <base>/<label>/<branchName>。 */
export function labelFromWorktreePath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : basename(p);
}
