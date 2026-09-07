import { execFile, execFileSync } from "node:child_process";
import {
  AGENT_MESSAGE_SUBMIT_PACE_MS,
  MAX_RENDERED_SNAPSHOT_SOURCE_BYTES,
} from "./constants";
import { runTmux } from "./tmuxExec";
import { shellQuote } from "./shellQuote";
import { TERMINAL_CONTROL_CODEX_ENVIRONMENT_HYDRATION_TIMEOUT_MS } from "./timeouts";
import {
  TerminalControlAgentMessageNotAppliedError,
  type TerminalControlAgentRuntimeSettings,
} from "./protocol";

export function buildCodexResumeCommand(
  sessionId?: string,
  runtime?: TerminalControlAgentRuntimeSettings,
  inheritedModel?: string,
): string {
  const args = ["codex", "-c", shellQuote("check_for_update_on_startup=false")];
  const model = runtime === undefined ? inheritedModel : runtime.model ?? undefined;
  if (model !== undefined) {
    args.push("-m", shellQuote(model));
  }
  if (runtime?.reasoningEffort !== null && runtime?.reasoningEffort !== undefined) {
    const effort = JSON.stringify(runtime.reasoningEffort);
    args.push(
      "-c",
      shellQuote(`model_reasoning_effort=${effort}`),
      "-c",
      shellQuote(`plan_mode_reasoning_effort=${effort}`),
    );
  }
  if (sessionId !== undefined) args.push("resume", shellQuote(sessionId));
  return args.join(" ");
}

/** Preserve the model selected by a managed Codex launch across an automatic idle resume. */
export function codexModelFromStartCommand(command: string): string | undefined {
  const segment = /(?:^|;)\s*codex\b([^;\r\n]*)/iu.exec(command)?.[1];
  if (segment === undefined) return undefined;
  const match = /(?:^|\s)(?:-m|--model)(?:\s+|=)(?:'([^'\r\n]*)'|"([^"\r\n]*)"|([^\s;'"\r\n]+))/iu
    .exec(segment);
  const model = match?.[1] ?? match?.[2] ?? match?.[3];
  return model !== undefined && model.length > 0 && model.length <= 128
      && /^[A-Za-z0-9._:-]+$/u.test(model)
    ? model
    : undefined;
}

const CODEX_RESUME_ENVIRONMENT = [
  "ASTERGATE_CODEX_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

let codexResumeEnvironmentHydration: Promise<void> = Promise.resolve();

export function applyCodexResumeEnvironmentSnapshot(
  snapshot: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  for (const entry of snapshot.split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const name = entry.slice(0, separator);
    if (!CODEX_RESUME_ENVIRONMENT.includes(
      name as (typeof CODEX_RESUME_ENVIRONMENT)[number],
    )) continue;
    const value = entry.slice(separator + 1);
    if (!value || Buffer.byteLength(value, "utf8") > 32 * 1024) continue;
    environment[name] = value;
  }
}

/** Hydrate only Codex provider settings inside the otherwise sealed terminal authority. */
export function inheritCodexResumeEnvironmentFromLoginShell(): void {
  const configuredShell = process.env.SHELL?.trim();
  const shell = configuredShell?.startsWith("/") && !configuredShell.includes("\0")
    ? configuredShell
    : "/bin/zsh";
  try {
    const snapshot = execFileSync(
      shell,
      ["-l", "-i", "-c", "printf '\\0'; env -0"],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: TERMINAL_CONTROL_CODEX_ENVIRONMENT_HYDRATION_TIMEOUT_MS,
      },
    );
    applyCodexResumeEnvironmentSnapshot(snapshot);
  } catch {
    // The authority remains usable for providers that do not require shell-exported settings.
  }
}

/**
 * Start the optional login-shell credential hydration without delaying the
 * terminal-control listener. Cold Codex resume awaits the latest hydration;
 * all other terminal-control operations remain independent of user shell
 * startup latency.
 */
export function inheritCodexResumeEnvironmentFromLoginShellAsync(
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<void> {
  const configuredShell = process.env.SHELL?.trim();
  const shell = configuredShell?.startsWith("/") && !configuredShell.includes("\0")
    ? configuredShell
    : "/bin/zsh";
  const hydration = new Promise<void>((resolve) => {
    execFile(
      shell,
      ["-l", "-i", "-c", "printf '\\0'; env -0"],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: TERMINAL_CONTROL_CODEX_ENVIRONMENT_HYDRATION_TIMEOUT_MS,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, snapshot) => {
        if (error === null) applyCodexResumeEnvironmentSnapshot(snapshot);
        resolve();
      },
    );
  });
  codexResumeEnvironmentHydration = hydration;
  return hydration;
}

export async function waitForCodexResumeEnvironmentHydration(): Promise<void> {
  await codexResumeEnvironmentHydration;
}

/** Pass provider credentials to the replacement pane without embedding them in its command. */
export function codexResumeEnvironmentArguments(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const args: string[] = [];
  for (const name of CODEX_RESUME_ENVIRONMENT) {
    const value = environment[name];
    if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > 32 * 1024) continue;
    args.push("-e", `${name}=${value}`);
  }
  return args;
}

export function codexModeFromRenderedSnapshot(snapshot: string): "default" | "plan" | null {
  const status = snapshot
    .split(/\r?\n/u)
    .slice(-12)
    .map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, ""));
  const line = status.find((candidate) => (
    /^\s+[A-Za-z0-9._:-]+\s+(?:default|low|medium|high|xhigh|max|ultra)\s+·\s+\S.*$/u
      .test(candidate)
  ));
  if (line === undefined) return null;
  return /\sPlan mode\s*$/u.test(line) ? "plan" : "default";
}

export async function ensureCodexMode(
  paneTarget: string,
  desired: TerminalControlAgentRuntimeSettings["mode"],
): Promise<void> {
  const capture = async (): Promise<string> => (await runTmux([
    "capture-pane", "-p", "-J", "-S", "-80", "-E", "-", "-t", paneTarget,
  ], { maxStdoutBytes: MAX_RENDERED_SNAPSHOT_SOURCE_BYTES })).stdout;
  const statusDeadline = Date.now() + 1_000;
  let observedMode: "default" | "plan" | null = null;
  while (Date.now() < statusDeadline) {
    observedMode = codexModeFromRenderedSnapshot(await capture());
    if (observedMode === desired) return;
    if (observedMode !== null) break;
    await new Promise<void>((resolve) => setTimeout(resolve, AGENT_MESSAGE_SUBMIT_PACE_MS));
  }
  if (observedMode === null) {
    throw new TerminalControlAgentMessageNotAppliedError(
      "RESOURCE_EXHAUSTED",
      "Codex did not publish its collaboration mode before the input deadline",
      true,
    );
  }
  // Codex's fixed Shift-Tab binding cycles collaboration modes. Check the
  // anchored status line after every step rather than assuming a two-state UI.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await runTmux(["send-keys", "-t", paneTarget, "BTab"]);
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, AGENT_MESSAGE_SUBMIT_PACE_MS));
      if (codexModeFromRenderedSnapshot(await capture()) === desired) return;
    }
  }
  {
    throw new TerminalControlAgentMessageNotAppliedError(
      "INVALID_REQUEST",
      `Codex did not switch to ${desired === "plan" ? "Plan" : "Default"} mode`,
    );
  }
}
