import { CliError } from "./tmux";

const RELEASES_URL = "https://github.com/Sskift/tmux-worktree/releases/latest";
const REPO_URL = "https://github.com/Sskift/tmux-worktree";

type UpdateOptions = {
  dryRun: boolean;
  cliOnly: boolean;
  dashboardOnly: boolean;
};

function printHelp(): void {
  console.log(`tw update — show GitHub release update instructions

Usage:
  tw update [--dry-run] [--cli-only | --dashboard-only]

Updates are published through GitHub Releases:
  ${RELEASES_URL}`);
}

function parseArgs(args: string[]): UpdateOptions {
  const opts: UpdateOptions = {
    dryRun: false,
    cliOnly: false,
    dashboardOnly: false,
  };

  for (const arg of args) {
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "-n" || arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--cli-only") {
      opts.cliOnly = true;
      continue;
    }
    if (arg === "--dashboard-only") {
      opts.dashboardOnly = true;
      continue;
    }
    throw new CliError(`unknown update option: ${arg}`);
  }

  if (opts.cliOnly && opts.dashboardOnly) {
    throw new CliError("--cli-only and --dashboard-only cannot be used together");
  }
  return opts;
}

function printUpdateInstructions(opts: UpdateOptions): void {
  if (opts.dryRun) {
    console.log("dry run: no local changes will be made");
  }

  if (!opts.cliOnly) {
    console.log(`Dashboard: download the latest DMG from ${RELEASES_URL}`);
  }

  if (!opts.dashboardOnly) {
    console.log("CLI source update:");
    console.log("  test -d tmux-worktree/.git || git clone " + `${REPO_URL}.git`);
    console.log("  cd tmux-worktree");
    console.log("  git pull --ff-only");
    console.log("  npm install");
    console.log("  npm run build");
    console.log("  npm link");
  }
}

export async function run(): Promise<void> {
  printUpdateInstructions(parseArgs(process.argv.slice(3)));
}
