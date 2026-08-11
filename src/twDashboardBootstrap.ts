import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import skillMarkdown from "../.codex/skills/tw-dashboard/SKILL.md";
import skillOpenAiYaml from "../.codex/skills/tw-dashboard/agents/openai.yaml";

const SKILL_NAME = "tw-dashboard";
const MANAGED_MARKER = "tw-dashboard-managed-v1\n";
const SUPPORT_RELATIVE_PATH = join(".tmux-worktree", "agent-support");
const SKILL_RELATIVE_PATH = join(
  SUPPORT_RELATIVE_PATH,
  "skills",
  SKILL_NAME,
);

export const TW_DASHBOARD_AGENT_INSTRUCTIONS =
  "You are running inside a tw-dashboard managed session. Run `tw context --json` "
  + "before environment-sensitive work. This session pins `tw` to its Dashboard CLI. "
  + "Use `$tw-dashboard` plus `tw agents` "
  + "when you need to inspect or coordinate with other managed Agents.";

export type TwDashboardSkillInstallState = "installed" | "current" | "conflict";

export interface TwDashboardSkillInstallation {
  path: string;
  commandPath: string;
  codex: TwDashboardSkillInstallState;
  claude: TwDashboardSkillInstallState;
}

export interface TwDashboardBootstrapContext {
  sessionName: string;
  host?: string;
  skillPath?: string;
  commandPath?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writeFileAtomically(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx", mode });
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function writeFileIfChanged(path: string, content: string, mode = 0o600): void {
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`tw-dashboard managed path is not a regular file: ${path}`);
    }
    if (readFileSync(path, "utf8") === content) {
      if ((metadata.mode & 0o777) !== mode) chmodSync(path, mode);
      return;
    }
  }
  writeFileAtomically(path, content, mode);
}

function writeManagedSkill(skillDirectory: string): void {
  writeFileIfChanged(join(skillDirectory, "SKILL.md"), skillMarkdown);
  writeFileIfChanged(join(skillDirectory, "agents", "openai.yaml"), skillOpenAiYaml);
  writeFileIfChanged(join(skillDirectory, ".tw-dashboard-managed"), MANAGED_MARKER);
}

function installDiscoveredSkill(skillDirectory: string): TwDashboardSkillInstallState {
  const skillPath = join(skillDirectory, "SKILL.md");
  if (existsSync(skillPath)) {
    const metadata = lstatSync(skillPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return "conflict";
    const markerPath = join(skillDirectory, ".tw-dashboard-managed");
    const managed = existsSync(markerPath)
      && lstatSync(markerPath).isFile()
      && readFileSync(markerPath, "utf8") === MANAGED_MARKER;
    const current = readFileSync(skillPath, "utf8") === skillMarkdown;
    if (!current && !managed) return "conflict";
    writeManagedSkill(skillDirectory);
    return current ? "current" : "installed";
  }
  writeManagedSkill(skillDirectory);
  return "installed";
}

function managedTwWrapper(executable: string, entrypoint: string): string {
  return `#!/bin/sh\nexec ${shellQuote(executable)} ${shellQuote(entrypoint)} "$@"\n`;
}

export function twDashboardSkillPath(home = homedir()): string {
  return join(home, SKILL_RELATIVE_PATH, "SKILL.md");
}

export function twDashboardCommandPath(home = homedir()): string {
  return join(home, SUPPORT_RELATIVE_PATH, "bin", "tw");
}

/**
 * Materialize the bundled Skill in app-owned storage and publish non-destructive
 * discovery copies for Codex and Claude. A user-owned conflicting Skill is
 * preserved and reported instead of overwritten.
 */
export function ensureTwDashboardSkillInstalled(options: {
  home?: string;
  codexHome?: string;
  claudeHome?: string;
  executable?: string;
  cliEntrypoint?: string;
} = {}): TwDashboardSkillInstallation {
  const home = options.home ?? homedir();
  const managedDirectory = join(home, SKILL_RELATIVE_PATH);
  writeManagedSkill(managedDirectory);
  const commandPath = twDashboardCommandPath(home);
  const cliEntrypoint = resolve(options.cliEntrypoint ?? process.argv[1]);
  writeFileIfChanged(
    commandPath,
    managedTwWrapper(options.executable ?? process.execPath, cliEntrypoint),
    0o700,
  );
  const codexHome = options.codexHome
    ?? process.env.CODEX_HOME?.trim()
    ?? join(home, ".codex");
  const claudeHome = options.claudeHome ?? join(home, ".claude");
  return {
    path: join(managedDirectory, "SKILL.md"),
    commandPath,
    codex: installDiscoveredSkill(join(codexHome, "skills", SKILL_NAME)),
    claude: installDiscoveredSkill(join(claudeHome, "skills", SKILL_NAME)),
  };
}

function unquoteExecutable(token: string): string {
  if (token.length >= 2
    && ((token.startsWith("'") && token.endsWith("'"))
      || (token.startsWith('"') && token.endsWith('"')))) {
    return token.slice(1, -1);
  }
  return token;
}

/** Add one provider-native startup instruction without creating an initial user turn. */
export function bootstrapTwDashboardAgentCommand(command: string): string {
  const match = /^(\s*)(('[^']*'|"[^"]*"|[^\s;]+))(.*)$/su.exec(command);
  if (!match) return command;
  const [, leading, token, , rest] = match;
  const executable = basename(unquoteExecutable(token));
  if (executable === "codex") {
    const override = `developer_instructions=${JSON.stringify(TW_DASHBOARD_AGENT_INSTRUCTIONS)}`;
    return `${leading}${token} -c ${shellQuote(override)}${rest}`;
  }
  if (executable === "claude") {
    return `${leading}${token} --append-system-prompt ${shellQuote(TW_DASHBOARD_AGENT_INSTRUCTIONS)}${rest}`;
  }
  return command;
}

export function twDashboardShellPrelude(context: TwDashboardBootstrapContext): string {
  const sessionName = context.sessionName.trim();
  if (!sessionName || sessionName.includes("\0")) {
    throw new Error("tw-dashboard session identity is invalid");
  }
  const commandPath = context.commandPath ?? twDashboardCommandPath();
  return [
    `export PATH=${shellQuote(dirname(commandPath))}:"$PATH"`,
    "TW_DASHBOARD=1",
    `TW_DASHBOARD_SESSION=${shellQuote(sessionName)}`,
    `TW_DASHBOARD_HOST=${shellQuote(context.host ?? hostname())}`,
    `TW_DASHBOARD_SKILL=${shellQuote(context.skillPath ?? twDashboardSkillPath())}`,
    `TW_DASHBOARD_CLI=${shellQuote(commandPath)}`,
  ].join(" ");
}
