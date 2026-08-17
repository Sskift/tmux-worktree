import { runTerminalControlServer } from "../../dist/terminalControl/index.js";

const [socketPath, statePath] = process.argv.slice(2);
if (!socketPath || !statePath) process.exit(64);

const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

try {
  await runTerminalControlServer({
    socketPath,
    statePath,
    signal: controller.signal,
    // This fixture represents a daemon left running from before the private
    // Relay v2 exact ingress was introduced.
    relayV2RemoteExactCompoundV1: false,
  });
} finally {
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
}
