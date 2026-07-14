import assert from "node:assert/strict";
import test from "node:test";
import { readRustProductionSource, readRustSourceFiles } from "./rustSource.ts";

const mobileRelayPaths = [
  "features/mobile_relay/mod.rs",
  "features/mobile_relay/model.rs",
  "features/mobile_relay/persistence.rs",
  "features/mobile_relay/network.rs",
  "features/mobile_relay/runtime.rs",
  "features/mobile_relay/broker.rs",
  "features/mobile_relay/commands.rs",
] as const;

const productionFiles = readRustSourceFiles();
const productionByPath = new Map(productionFiles.map((file) => [file.path, file.source]));
const productionTree = productionFiles
  .map((file) => `// --- ${file.path} ---\n${file.source}`)
  .join("\n");

function source(path: string): string {
  return readRustProductionSource(path);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function definitionOwners(kind: "fn" | "type", name: string): string[] {
  const escaped = escapeRegExp(name);
  const pattern = kind === "fn"
    ? new RegExp(`\\bfn\\s+${escaped}\\b`)
    : new RegExp(`\\b(?:struct|enum|type)\\s+${escaped}\\b`);
  return productionFiles
    .filter((file) => pattern.test(file.source))
    .map((file) => file.path);
}

function rustFunctionSource(rust: string, name: string): string {
  const escaped = escapeRegExp(name);
  const definition = new RegExp(
    `^[ \\t]*(?:(?:pub(?:\\([^)]*\\))?)[ \\t]+)?fn[ \\t]+${escaped}\\b`,
    "m",
  ).exec(rust);
  assert.ok(definition, `expected Rust function ${name}`);
  const start = definition.index;
  const afterDefinition = start + definition[0].length;
  const nextDefinition = /^[ \t]*(?:(?:pub(?:\([^)]*\))?)[ \t]+)?fn[ \t]+[A-Za-z_][A-Za-z0-9_]*\b/m
    .exec(rust.slice(afterDefinition));
  const end = nextDefinition
    ? afterDefinition + nextDefinition.index
    : rust.length;
  return rust.slice(start, end);
}

function assertBundledBeforeInstalled(rust: string, name: string): void {
  const functionSource = rustFunctionSource(rust, name);
  const bundled = functionSource.indexOf("bundled_cli_path");
  const installed = functionSource.indexOf("installed_tw_command");
  assert.notEqual(bundled, -1, `${name} must contain the bundled CLI branch`);
  assert.notEqual(installed, -1, `${name} must contain the installed tw branch`);
  assert.ok(bundled < installed, `${name} must try bundled CLI before installed tw`);
}

function assertRelayHostCredentialsPerBranch(rust: string): void {
  const functionSource = rustFunctionSource(rust, "spawn_relay_host");
  const installedBoundary = /^[ \t]*if let Some\(tw\) = installed_tw_command\(\) \{/m
    .exec(functionSource);
  assert.ok(installedBoundary, "spawn_relay_host must contain the installed tw branch");
  const bundledBranch = functionSource.slice(0, installedBoundary.index);
  const installedBranch = functionSource.slice(installedBoundary.index);

  for (const [branchName, branch] of [
    ["bundled", bundledBranch],
    ["installed", installedBranch],
  ] as const) {
    for (const [credential, argument] of [
      ["TW_RELAY_SECRET", "secret"],
      ["TW_TOKEN", "token"],
    ] as const) {
      const injection = `.env("${credential}", ${argument})`;
      const count = branch.split(injection).length - 1;
      assert.equal(
        count,
        1,
        `${branchName} branch must inject ${credential} exactly once`,
      );
    }
  }
  assert.equal(
    bundledBranch.split('.env("TW_DASHBOARD_CLI", &cli_arg)').length - 1,
    1,
    "bundled relay-host must identify its exact CLI artifact",
  );
  assert.doesNotMatch(installedBranch, /TW_DASHBOARD_CLI/);
}

test("mobile relay production modules and symbols have one frozen owner", () => {
  for (const path of mobileRelayPaths) {
    assert.ok(productionByPath.has(path), `${path} must be production-reachable`);
  }

  for (const dto of [
    "MobileRelayStatus",
    "MobileRelayConfigInput",
    "MobileRelayBrokerInput",
  ]) {
    assert.deepEqual(definitionOwners("type", dto), ["ipc/dashboard.rs"]);
  }

  for (const model of [
    "MobileRelayState",
    "MobileRelayConfig",
    "RelayHostRuntimeStatus",
  ]) {
    assert.deepEqual(definitionOwners("type", model), ["features/mobile_relay/model.rs"]);
  }

  for (const handler of [
    "mobile_relay_start",
    "mobile_relay_start_broker",
    "mobile_relay_save_config",
    "mobile_relay_stop",
    "mobile_relay_status",
    "load_mobile_relay_runtime_status",
  ]) {
    assert.deepEqual(definitionOwners("fn", handler), ["features/mobile_relay/commands.rs"]);
  }

  const expectedFunctions = new Map<string, readonly string[]>([
    ["features/mobile_relay/persistence.rs", [
      "config_string_field",
      "mobile_relay_config_from_value",
      "load_mobile_relay_config_file",
      "preflight_mobile_relay_config_write",
      "env_non_empty",
      "config_or_default",
      "mobile_relay_config",
      "save_mobile_relay_config_file",
      "mobile_relay_status_file",
    ]],
    ["features/mobile_relay/network.rs", [
      "tcp_port_open",
      "is_loopback_host",
      "validate_mobile_relay_connector_url",
      "is_cloudflare_quick_tunnel_url",
      "preserved_mobile_relay_url_after_broker_start",
    ]],
    ["features/mobile_relay/runtime.rs", [
      "read_serve_token",
      "wait_for_serve",
      "spawn_serve",
      "stop_managed_serve",
      "stop_mobile_relay_connector",
      "stop_mobile_relay_processes",
      "spawn_relay_host",
    ]],
    ["features/mobile_relay/broker.rs", [
      "mobile_relay_secret",
      "start_mobile_relay_broker_on_host",
      "start_mobile_relay_quick_tunnel_on_host",
      "stop_mobile_relay_quick_tunnel_on_host",
      "stop_mobile_relay_broker_on_host",
    ]],
  ]);
  for (const [path, names] of expectedFunctions) {
    for (const name of names) assert.deepEqual(definitionOwners("fn", name), [path]);
  }

  const facade = source("features/mobile_relay/mod.rs");
  assert.doesNotMatch(facade, /pub\(crate\) use [^;]*::\*/);
  assert.match(facade, /pub\(crate\) use model::MobileRelayState;/);
  assert.match(facade, /pub\(crate\) use runtime::stop_mobile_relay_processes;/);
});

test("mobile relay dependency graph stays one-way and outside D6 domains", () => {
  const mobileRelayTree = mobileRelayPaths.map(source).join("\n");
  assert.doesNotMatch(
    mobileRelayTree,
    /^\s*use\s+crate::features::(?:sessions|terminals|worktrees|automation|git|files|layout|pty)\b/m,
  );

  const runtime = source("features/mobile_relay/runtime.rs");
  assert.match(runtime, /bundled_cli_path/);
  assert.match(runtime, /node_bin/);
  assert.match(runtime, /installed_tw_command/);
  assert.doesNotMatch(runtime, /resolve_local_tw_rpc_runtime|select_local_tw_rpc_runtime/);
  assertBundledBeforeInstalled(runtime, "spawn_serve");
  assertBundledBeforeInstalled(runtime, "spawn_relay_host");

  for (const file of productionFiles) {
    if (
      file.path.startsWith("features/mobile_relay/")
      || file.path === "features/mod.rs"
      || file.path === "lib.rs"
    ) continue;
    assert.doesNotMatch(
      file.source,
      /^\s*use\s+crate::features::mobile_relay\b/m,
      `${file.path} must not depend on mobile_relay`,
    );
  }
});

test("mobile relay status composition and v1 credential roles remain exact", () => {
  const commands = source("features/mobile_relay/commands.rs");
  const runtime = source("features/mobile_relay/runtime.rs");
  const broker = source("features/mobile_relay/broker.rs");
  const network = source("features/mobile_relay/network.rs");
  const ipc = source("ipc/dashboard.rs");

  assert.match(commands, /fn load_mobile_relay_runtime_status\(/);
  assert.match(commands, /fn mobile_relay_status\(/);
  assert.match(commands, /let connection_state =/);
  assert.match(
    commands,
    /status\.relay_url == resolved_relay_url && status\.host_id == resolved_host_id/,
  );
  assert.match(ipc, /struct MobileRelayStatus \{[\s\S]*connection_state: String/);

  assert.match(runtime, /\.tw-serve-token/);
  assertRelayHostCredentialsPerBranch(runtime);
  assert.match(runtime, /http:\/\/127\.0\.0\.1:8311/);
  assert.equal(runtime.match(/"serve", "--host", "127\.0\.0\.1"/g)?.length, 2);
  assert.match(commands, /args\.port\.unwrap_or\(8787\)/);
  assert.match(commands, /pub\(crate\) async fn mobile_relay_start_broker\(/);
  assert.match(
    commands,
    /spawn_blocking\(move \|\| \{\s*mobile_relay_start_broker_blocking\(app, args, state\)\s*\}\)/,
  );
  assert.match(commands, /preflight_mobile_relay_config_write\(\)\?/);
  assert.match(commands, /broker_host_id: host\.id\.clone\(\)/);
  assert.match(commands, /args\.quick_tunnel\.unwrap_or\(false\)/);
  assert.match(commands, /start_mobile_relay_quick_tunnel_on_host/);
  assert.doesNotMatch(commands, /wait_for_mobile_relay_url_resolution/);
  assert.match(commands, /relay-host already owns reconnect\/backoff/);
  assert.doesNotMatch(commands, /mobile_relay_forward_url_for_host|should_preserve_mobile_relay_url/);
  assert.match(broker, /TW_RELAY_SECRET/);
  assert.match(broker, /chmod 600/);
  assert.match(broker, /tw-cli\.cjs/);
  assert.doesNotMatch(broker, /tw-cli\.js/);
  assert.match(broker, /chmod 700/);
  assert.match(broker, /kill-session -t tw-relay-server/);
  assert.match(broker, /new-session -d -s tw-relay-server/);
  assert.match(broker, /has-session -t tw-relay-server/);
  assert.match(broker, /relay-server --host 127\.0\.0\.1 --port/);
  assert.doesNotMatch(broker, /relay-server --host 0\.0\.0\.0/);
  assert.match(broker, /tw-relay-tunnel/);
  assert.match(broker, /cloudflare\/cloudflared\/releases\/download/);
  assert.match(broker, /cloudflared-linux-amd64/);
  assert.match(broker, /cloudflared-linux-arm64/);
  assert.match(broker, /Downloaded cloudflared failed SHA-256 verification/);
  assert.match(broker, /mv \"\$cloudflared_tmp\" \"\$managed_cloudflared\"/);
  assert.ok(
    broker.indexOf('mv \"$cloudflared_tmp\" \"$managed_cloudflared\"') <
      broker.indexOf('kill-session -t {}'),
    "cloudflared must be provisioned and verified before replacing an existing tunnel",
  );
  assert.match(broker, /cloudflared.*tunnel --no-autoupdate --protocol http2 --url http:\/\/127\.0\.0\.1:/s);
  assert.match(broker, /\.trycloudflare\\\.com/);
  assert.doesNotMatch(broker, /require\("dns"\)\.lookup/);
  assert.doesNotMatch(broker, /TW_RELAY_SECRET[^\n]*(?:trycloudflare|relay-tunnel)/);

  assert.doesNotMatch(network, /Command::new\("\/usr\/bin\/dig"\)/);

  const mobileRelayTree = mobileRelayPaths.map(source).join("\n");
  assert.doesNotMatch(
    mobileRelayTree,
    /\b(?:struct|enum|type)\s+[A-Za-z0-9_]*(?:Relay[A-Za-z0-9_]*(?:Envelope|Message|Wire|Stream|Session)|StreamSession|SessionStream)[A-Za-z0-9_]*\b/,
  );
  assert.doesNotMatch(
    mobileRelayTree,
    /\b(?:twcap2|host_epoch|hostEpoch|relay_v2|RelayV2|v2[A-Za-z0-9_]*capabilit[A-Za-z0-9_]*|capabilit[A-Za-z0-9_]*v2[A-Za-z0-9_]*)\b|\b(?:protocol_version|protocolVersion)\s*[:=]\s*2\b/i,
  );
  assert.doesNotMatch(
    mobileRelayTree,
    /\bfn\s+[A-Za-z0-9_]*(?:pairing(?:_payload)?|qr(?:_code)?)[A-Za-z0-9_]*\s*\(|\b(?:PairingPayload|PairingQr|QrCode)\s*\{/i,
  );
});

test("mobile relay runtime ordering guard rejects import and cross-function decoys", () => {
  const adversarial = `
use crate::control_plane::{bundled_cli_path, installed_tw_command};

fn spawn_serve() {
  installed_tw_command();
  bundled_cli_path();
}

fn spawn_relay_host() {
  bundled_cli_path();
  installed_tw_command();
}
`;
  assert.throws(
    () => assertBundledBeforeInstalled(adversarial, "spawn_serve"),
    /spawn_serve must try bundled CLI before installed tw/,
  );
  assert.doesNotThrow(() => assertBundledBeforeInstalled(adversarial, "spawn_relay_host"));
});

test("mobile relay credential guard rejects duplicate injection in one branch", () => {
  const adversarial = `
fn spawn_relay_host() {
  if let Some(cli) = bundled_cli_path(app) {
    command
      .env("TW_RELAY_SECRET", secret)
      .env("TW_TOKEN", token)
      .env("TW_RELAY_SECRET", secret)
      .env("TW_TOKEN", token);
  }

  if let Some(tw) = installed_tw_command() {
    command.spawn();
  }
}
`;
  assert.throws(
    () => assertRelayHostCredentialsPerBranch(adversarial),
    /bundled branch must inject TW_RELAY_SECRET exactly once/,
  );
});

test("mobile relay persistence keeps locking, aliases, and private atomic writes", () => {
  const persistence = source("features/mobile_relay/persistence.rs");
  const network = source("features/mobile_relay/network.rs");

  for (const env of [
    "TW_RELAY_URL",
    "TW_RELAY_HOST_ID",
    "TW_RELAY_DISPLAY_NAME",
    "TW_RELAY_SECRET",
  ]) assert.match(persistence, new RegExp(`env_non_empty\\("${env}"\\)`));
  assert.match(persistence, /\["secret", "token", "relaySecret"\]/);
  assert.match(persistence, /dashboard_config_write_lock\(\)/);
  assert.match(persistence, /acquire_dashboard_config_file_lock\(\)/);
  assert.match(persistence, /atomic_write_file\(&config_path, format!\("\{pretty\}\\n"\)\.as_bytes\(\)\)/);
  assert.match(persistence, /mobile-relay-status\.json/);
  assert.match(persistence, /"brokerHostId"/);
  assert.match(persistence, /preflight_mobile_relay_config_write/);

  assert.match(network, /validate_mobile_relay_connector_url/);
  assert.match(network, /"ws" if is_loopback_host\(host\)/);
  assert.match(network, /LEGACY_PLACEHOLDER_RELAY_URL/);
  assert.doesNotMatch(network, /ssh|-L|0\.0\.0\.0|\.local|scutil|local_lan_ip/);

  assert.ok(productionTree.includes("tauri::RunEvent::ExitRequested"));
});
