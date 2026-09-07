import { spawn } from "node:child_process";
import { tmuxBin } from "../tmux";
import { COMMAND_TIMEOUT_MS, MAX_COMMAND_OUTPUT_BYTES } from "./constants";
import { TerminalControlProtocolError } from "./protocol";

export type TmuxResult = {
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};

export class TmuxStdoutLimitError extends Error {
  constructor() {
    super("tmux stdout exceeded the terminal-control limit");
    this.name = "TmuxStdoutLimitError";
  }
}

export function validateSessionName(name: string): void {
  if (!name || name.length > 128 || /[\0-\x1f\x7f]/.test(name)) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "managed session name is invalid");
  }
}

export function runTmux(
  args: string[],
  options: {
    input?: Buffer | string;
    allowFailure?: boolean;
    maxStdoutBytes?: number;
  } = {},
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
      if (stdoutBytes > (options.maxStdoutBytes ?? MAX_COMMAND_OUTPUT_BYTES)) {
        try { child.kill("SIGKILL"); } catch {}
        finish(new TmuxStdoutLimitError());
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
