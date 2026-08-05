#!/usr/bin/env node
/**
 * Host entry point for the relay v2 interop runner.
 *
 * Starts a v2 host in local-development mode with dashboard management
 * enabled, and runs the dashboard management protocol over stdio.
 *
 * Env vars:
 *   TW_HOST_TRUSTED_HOME           - trusted home directory
 *   TW_HOST_HTTPS_CA               - path to CA cert for HTTPS
 *   TW_HOST_WSS_CA                 - path to CA cert for WSS
 *   TW_HOST_PROFILE_INPUT          - path to provisioning profile (optional)
 *   TW_HOST_BOOTSTRAP_SECRET_INPUT - path to bootstrap secret (optional)
 */
import { stdin, stdout, argv } from "node:process";

process.on("uncaughtException", (error) => {
  console.error("[interop-host uncaughtException]", error?.stack ?? error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[interop-host unhandledRejection]", reason?.stack ?? reason);
});
import { resolve } from "node:path";
import {
  startRelayV2HostDashboardManagementFromLocalDevelopment,
} from "../../dist/relay/v2/hostShippingDeploymentSource.js";

// The host runtime requires the CLI entrypoint to be cli.cjs (for spawning
// the terminal-control daemon). Point argv[1] at the real CLI bundle.
argv[1] = resolve("dist/cli.cjs");

const {
  TW_HOST_TRUSTED_HOME,
  TW_HOST_HTTPS_CA,
  TW_HOST_WSS_CA,
  TW_HOST_PROFILE_INPUT,
  TW_HOST_BOOTSTRAP_SECRET_INPUT,
} = process.env;

if (!TW_HOST_TRUSTED_HOME || !TW_HOST_HTTPS_CA || !TW_HOST_WSS_CA) {
  console.error("Missing required env vars: TW_HOST_TRUSTED_HOME, TW_HOST_HTTPS_CA, TW_HOST_WSS_CA");
  process.exit(1);
}

const options = {
  trustedHome: TW_HOST_TRUSTED_HOME,
  credentialHttpsCaInputPath: TW_HOST_HTTPS_CA,
  carrierWssCaInputPath: TW_HOST_WSS_CA,
  ...(TW_HOST_PROFILE_INPUT ? { provisionProfileInputPath: TW_HOST_PROFILE_INPUT } : {}),
  ...(TW_HOST_BOOTSTRAP_SECRET_INPUT ? { bootstrapSecretInputPath: TW_HOST_BOOTSTRAP_SECRET_INPUT } : {}),
};

const signal = new AbortController().signal;

const handle = await startRelayV2HostDashboardManagementFromLocalDevelopment(options, {
  clock: () => Date.now(),
  runtimeVersion: "0.0.1",
  signal,
  io: {
    input: stdin,
    writeFrame: (frame) => new Promise((resolve, reject) => {
      stdout.write(frame + "\n", "utf8", (err) => err ? reject(err) : resolve());
    }),
  },
});

const exitCode = await handle.runDashboardManagement();
await handle.closeAndDrain();
process.exit(exitCode ?? 0);
