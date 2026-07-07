import { execSync } from "child_process";
import { createInterface } from "readline";
import { CONFIG_PATH, loadConfigFile } from "./config";

interface Dep {
  name: string;
  required: boolean;
  versionCmd: string;
  desc: string;
  brew?: string;
  apt?: string;
  manual?: string;
}

const deps: Dep[] = [
  { name: "git", required: true, versionCmd: "git --version", desc: "版本控制", brew: "git", apt: "git" },
  { name: "tmux", required: true, versionCmd: "tmux -V", desc: "终端复用", brew: "tmux", apt: "tmux" },
  { name: "node", required: true, versionCmd: "node --version", desc: "JS 运行时 (≥20)", brew: "node", manual: "https://nodejs.org 或 nvm" },
  { name: "cloudflared", required: false, versionCmd: "cloudflared --version", desc: "远程隧道 (可选)", brew: "cloudflared", manual: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" },
  { name: "python3", required: false, versionCmd: "python3 --version", desc: "Web 终端桥接 (可选)", brew: "python3", apt: "python3" },
];

function which(cmd: string): string | null {
  try {
    return execSync(`which ${cmd}`, { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function getVersion(cmd: string): string | null {
  try {
    const out = execSync(cmd, { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    // Extract version number
    const m = out.match(/(\d+\.\d+[\.\d]*)/);
    return m ? m[1] : out;
  } catch {
    return null;
  }
}

function detectPkgManager(): "brew" | "apt" | "yum" | "dnf" | null {
  if (which("brew")) return "brew";
  if (which("apt")) return "apt";
  if (which("dnf")) return "dnf";
  if (which("yum")) return "yum";
  return null;
}

function installCmd(dep: Dep, pm: "brew" | "apt" | "yum" | "dnf" | null): string | null {
  if (pm === "brew" && dep.brew) return `brew install ${dep.brew}`;
  if ((pm === "apt") && dep.apt) return `sudo apt install -y ${dep.apt}`;
  if ((pm === "yum" || pm === "dnf") && dep.apt) return `sudo ${pm} install -y ${dep.apt}`;
  if (dep.manual) return dep.manual;
  return null;
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

export async function run() {
  console.log("\n\x1b[1mtw setup\x1b[0m — 检查系统依赖\n");

  const platform = process.platform === "darwin" ? "macOS" : "Linux";
  const pm = detectPkgManager();
  console.log(`  平台: ${platform}  包管理器: ${pm || "未检测到"}\n`);

  const missing: { dep: Dep; cmd: string | null }[] = [];
  let allRequiredOk = true;

  for (const dep of deps) {
    const path = which(dep.name);
    if (path) {
      const ver = getVersion(dep.versionCmd) || "?";
      console.log(`  \x1b[32m✓\x1b[0m ${dep.name.padEnd(14)} ${ver}`);
    } else {
      const tag = dep.required ? "\x1b[31m✗\x1b[0m" : "\x1b[33m-\x1b[0m";
      const suffix = dep.required ? "" : ` (${dep.desc})`;
      console.log(`  ${tag} ${dep.name.padEnd(14)} 未安装${suffix}`);
      const cmd = installCmd(dep, pm);
      if (cmd) console.log(`    → ${cmd}`);
      missing.push({ dep, cmd });
      if (dep.required) allRequiredOk = false;
    }
  }

  console.log();
  try {
    const config = loadConfigFile();
    if (config) {
      const count = Object.keys(config.projects).length;
      console.log(`  \x1b[32m✓\x1b[0m config         ${CONFIG_PATH}`);
      console.log(`    projects: ${count}`);
      console.log(`    worktreeBase: ${config.worktreeBase || "/private/tmp/tmux-worktree/projects"}`);
    } else {
      console.log(`  \x1b[33m-\x1b[0m config         未找到 ${CONFIG_PATH}`);
    }
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m config         读取失败: ${err instanceof Error ? err.message : String(err)}`);
    allRequiredOk = false;
  }

  console.log();

  if (missing.length === 0 && allRequiredOk) {
    console.log("  \x1b[32m所有依赖已就绪。\x1b[0m\n");
    return;
  }
  if (missing.length === 0) {
    process.exitCode = 1;
    return;
  }

  if (allRequiredOk) {
    console.log("  \x1b[32m必须依赖已就绪。\x1b[0m可选依赖可稍后安装。\n");
    return;
  }

  // Offer to install missing required deps
  const toInstall = missing.filter((m) => m.dep.required && m.cmd && !m.cmd.startsWith("http"));
  if (toInstall.length > 0 && pm) {
    const answer = await ask("  是否自动安装缺失的必须依赖？[Y/n] ");
    if (answer !== "n" && answer !== "no") {
      for (const { dep, cmd } of toInstall) {
        console.log(`\n  安装 ${dep.name}...`);
        try {
          execSync(cmd!, { stdio: "inherit", timeout: 120000 });
          console.log(`  \x1b[32m✓\x1b[0m ${dep.name} 安装完成`);
        } catch {
          console.error(`  \x1b[31m✗\x1b[0m ${dep.name} 安装失败，请手动执行: ${cmd}`);
        }
      }
      console.log();
    }
  }
}
