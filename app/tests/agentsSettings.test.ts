import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LOCAL_AGENT_TARGET_KEY,
  agentProbeTargetKey,
  buildAgentProbeTargetOptions,
  resolveAgentProbeTarget,
} from "../src/dashboard/Settings/agentsSettingsModel.ts";

const hosts = [
  { id: "build-mac", label: "Build Mac", host: "build.internal", user: "dev" },
  { id: "lab", label: "Lab", host: "lab.internal" },
];

test("agent scan targets round-trip between local and configured hosts", () => {
  assert.equal(agentProbeTargetKey({ kind: "local" }), LOCAL_AGENT_TARGET_KEY);
  assert.equal(
    agentProbeTargetKey({ kind: "host", hostId: "build-mac" }),
    "host:build-mac",
  );
  assert.deepEqual(resolveAgentProbeTarget("host:build-mac", hosts), {
    kind: "host",
    hostId: "build-mac",
  });
  assert.deepEqual(resolveAgentProbeTarget("host:removed", hosts), { kind: "local" });
});

test("agent scan target options include local and each injected Host", () => {
  assert.deepEqual(buildAgentProbeTargetOptions(hosts), [
    { value: "local", label: "This Mac", detail: "Local environment" },
    { value: "host:build-mac", label: "Build Mac", detail: "dev@build.internal" },
    { value: "host:lab", label: "Lab", detail: "lab.internal" },
  ]);
});

test("Agents Settings probes only through the typed backend and guards stale results", () => {
  const source = readFileSync(
    new URL("../src/dashboard/Settings/AgentsSettings.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /dashboardBackend\.agents\.probe\(selectedTarget\)/);
  assert.match(source, /createLatestRequestGate\(\)/);
  assert.match(source, /isCurrent\(request\)/);
  assert.match(source, /Detection never runs this full command/);
  assert.doesNotMatch(source, /exec\(|eval\(|Command::new/);
});
