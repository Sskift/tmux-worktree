import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { CliError, query, run, tmuxBin } from "./tmux";
import { currentRpcV2List, type RpcV2Session } from "./rpcV2";
import { agentProviderFromStartCommand } from "./terminalControl/agentTranscript";
import { agentRunningFromPaneTitle } from "./terminalControl/backend";
import { twDashboardSkillPath } from "./twDashboardBootstrap";

const DEFAULT_OUTPUT_LINES = 60;
const MAX_OUTPUT_LINES = 200;
const MAX_OUTPUT_BYTES = 64 * 1024;

export type TwManagedAgentState = "running" | "idle" | "unknown";

export interface TwPaneObservation {
  title: string;
  startCommand: string;
  currentCommand: string;
  cwd: string;
}

export interface TwPaneCapture {
  text: string;
  truncated: boolean;
}

export interface TwManagedAgentSummary {
  session: string;
  kind: "worktree" | "terminal";
  project: string | null;
  label: string | null;
  branch: string | null;
  cwd: string;
  attached: boolean;
  state: TwManagedAgentState;
  provider: "claude" | "codex" | null;
  currentCommand: string | null;
  lastActivityAt: string;
}

export interface TwDashboardCliDeps {
  list?: () => ReturnType<typeof currentRpcV2List>;
  inspectPane?: (sessionName: string) => TwPaneObservation | null;
  capturePane?: (sessionName: string, lines: number) => TwPaneCapture;
  currentSession?: () => string | null;
  env?: NodeJS.ProcessEnv;
  host?: () => string;
  skillPath?: () => string;
  skillExists?: (path: string) => boolean;
}

function observePane(sessionName: string): TwPaneObservation | null {
  const format = [
    "#{pane_title}",
    "#{pane_start_command}",
    "#{pane_current_command}",
    "#{pane_current_path}",
  ].join("\x1f");
  const output = query(
    tmuxBin(),
    ["display-message", "-p", "-t", `=${sessionName}:`, format],
  );
  if (!output) return null;
  const fields = output.split("\x1f");
  if (fields.length !== 4) return null;
  return {
    title: fields[0],
    startCommand: fields[1],
    currentCommand: fields[2],
    cwd: fields[3],
  };
}

function boundedUtf8Tail(value: string, maxBytes: number): TwPaneCapture {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let offset = bytes.length - maxBytes;
  while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset += 1;
  return { text: bytes.subarray(offset).toString("utf8"), truncated: true };
}

function capturePane(sessionName: string, lines: number): TwPaneCapture {
  const output = run(tmuxBin(), [
    "capture-pane",
    "-p",
    "-J",
    "-S",
    `-${lines}`,
    "-t",
    `=${sessionName}:`,
  ]);
  const sourceLines = output.split("\n");
  const lineTruncated = sourceLines.length > lines;
  const bounded = boundedUtf8Tail(sourceLines.slice(-lines).join("\n"), MAX_OUTPUT_BYTES);
  return {
    text: bounded.text,
    truncated: lineTruncated || bounded.truncated,
  };
}

function activityTimestamp(seconds: number): string {
  return new Date(seconds * 1_000).toISOString();
}

function summarizeSession(
  session: RpcV2Session,
  observation: TwPaneObservation | null,
): TwManagedAgentSummary {
  const provider = observation
    ? agentProviderFromStartCommand(observation.startCommand) ?? null
    : null;
  const running = observation ? agentRunningFromPaneTitle(observation.title) : false;
  return {
    session: session.name,
    kind: session.kind,
    project: session.project,
    label: session.label,
    branch: session.branch,
    cwd: observation?.cwd || session.cwd,
    attached: session.attached,
    state: running ? "running" : provider ? "idle" : "unknown",
    provider,
    currentCommand: observation?.currentCommand || null,
    lastActivityAt: activityTimestamp(session.activity),
  };
}

export function buildTwAgentsList(deps: TwDashboardCliDeps = {}) {
  const response = (deps.list ?? currentRpcV2List)();
  const inspect = deps.inspectPane ?? observePane;
  return {
    protocolVersion: 2 as const,
    kind: "tw-dashboard-agent-list" as const,
    sessions: response.sessions.map((session) => summarizeSession(session, inspect(session.name))),
  };
}

export function buildTwAgentShow(
  sessionName: string,
  lines = DEFAULT_OUTPUT_LINES,
  deps: TwDashboardCliDeps = {},
) {
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > MAX_OUTPUT_LINES) {
    throw new CliError(`--lines must be an integer from 1 to ${MAX_OUTPUT_LINES}`);
  }
  const response = (deps.list ?? currentRpcV2List)();
  const session = response.sessions.find((candidate) => candidate.name === sessionName);
  if (!session) throw new CliError(`managed Agent session not found: ${sessionName}`);
  const inspect = deps.inspectPane ?? observePane;
  const capture = deps.capturePane ?? capturePane;
  const agent = summarizeSession(session, inspect(session.name));
  const output = capture(session.name, lines);
  return {
    protocolVersion: 2 as const,
    kind: "tw-dashboard-agent" as const,
    agent,
    output: {
      source: "tmux-capture-pane" as const,
      lines,
      ...output,
    },
  };
}

function currentTmuxSession(): string | null {
  if (!process.env.TMUX) return null;
  return query(tmuxBin(), ["display-message", "-p", "#{session_name}"]) || null;
}

export function buildTwDashboardContext(deps: TwDashboardCliDeps = {}) {
  const env = deps.env ?? process.env;
  const agents = buildTwAgentsList(deps);
  const injectedSession = env.TW_DASHBOARD_SESSION?.trim();
  const currentName = injectedSession || (deps.currentSession ?? currentTmuxSession)();
  const session = currentName
    ? agents.sessions.find((candidate) => candidate.session === currentName) ?? null
    : null;
  const skillPath = env.TW_DASHBOARD_SKILL?.trim()
    || (deps.skillPath ?? twDashboardSkillPath)();
  return {
    protocolVersion: 2 as const,
    kind: "tw-dashboard-context" as const,
    insideTwDashboard: env.TW_DASHBOARD === "1" || session !== null,
    host: env.TW_DASHBOARD_HOST?.trim() || (deps.host ?? hostname)(),
    session,
    skill: {
      name: "tw-dashboard" as const,
      path: skillPath,
      available: (deps.skillExists ?? existsSync)(skillPath),
    },
    commands: {
      context: "tw context --json",
      listAgents: "tw agents ls --json",
      showAgent: "tw agents show <session> --json",
    },
    output: {
      markdown: "gfm" as const,
      localImages: {
        syntax: "![alt](/absolute/path/image.png)",
        formats: ["png", "jpeg", "gif", "webp"],
        maxBytesEach: 4 * 1024 * 1024,
        maxCount: 6,
        localSessionOnly: true,
      },
    },
  };
}

function printJson(value: unknown, compact: boolean): void {
  console.log(JSON.stringify(value, null, compact ? 0 : 2));
}

export async function twContextCmd(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const unknown = args.find((arg) => arg !== "--json");
  if (unknown) throw new CliError(`unknown context option: ${unknown}`);
  printJson(buildTwDashboardContext(), json);
}

function parseShowArgs(args: string[]): { sessionName: string; lines: number; json: boolean } {
  let sessionName: string | undefined;
  let lines = DEFAULT_OUTPUT_LINES;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--lines") {
      const value = args[++index];
      if (value === undefined) throw new CliError("--lines requires a value");
      lines = Number(value);
    } else if (arg.startsWith("--")) {
      throw new CliError(`unknown agents show option: ${arg}`);
    } else if (sessionName === undefined) {
      sessionName = arg;
    } else {
      throw new CliError("agents show accepts one session name");
    }
  }
  if (!sessionName) throw new CliError("usage: tw agents show <session> [--lines N] [--json]");
  return { sessionName, lines, json };
}

function printAgentList(value: ReturnType<typeof buildTwAgentsList>): void {
  if (value.sessions.length === 0) {
    console.log("No managed Agent sessions.");
    return;
  }
  for (const session of value.sessions) {
    console.log([
      session.state.padEnd(8),
      session.session.padEnd(22),
      (session.provider ?? "-").padEnd(7),
      session.cwd,
    ].join("  "));
  }
}

function printAgentShow(value: ReturnType<typeof buildTwAgentShow>): void {
  console.log(`${value.agent.session}  ${value.agent.state}  ${value.agent.provider ?? "unknown"}`);
  console.log(`${value.agent.cwd}\n`);
  console.log(`Recent terminal output (${value.output.lines} lines):`);
  console.log(value.output.text || "(empty)");
}

export async function twAgentsCmd(args: string[]): Promise<void> {
  const sub = args[0] ?? "ls";
  const rest = args.slice(1);
  if (sub === "ls") {
    const unknown = rest.find((arg) => arg !== "--json");
    if (unknown) throw new CliError(`unknown agents ls option: ${unknown}`);
    const value = buildTwAgentsList();
    if (rest.includes("--json")) printJson(value, true);
    else printAgentList(value);
    return;
  }
  if (sub === "show") {
    const parsed = parseShowArgs(rest);
    const value = buildTwAgentShow(parsed.sessionName, parsed.lines);
    if (parsed.json) printJson(value, true);
    else printAgentShow(value);
    return;
  }
  throw new CliError("usage: tw agents ls [--json] | tw agents show <session> [--lines N] [--json]");
}
