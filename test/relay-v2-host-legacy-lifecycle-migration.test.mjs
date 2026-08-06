import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const session = await import("../dist/session.js");
const state = await import("../dist/state.js");
const cli = fileURLToPath(new URL("../dist/cli.cjs", import.meta.url));

const BIRTH_OPTION = "@tw_rpc_v2_birth_marker_v1";
const CORR_OPTION = "@tw_rpc_v2_reservation_correlation_v1";
const FIXED_BIRTH_MARKER = "twbirth2.ABCDEFGHIJKLMNOPQRSTUV";
const FIXED_DIGEST = "a".repeat(64);

function withTempDir(prefix, operation) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return operation(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function legacySession(overrides = {}) {
  return {
    name: "tw-term-legacy",
    kind: "terminal",
    profile: "dashboard",
    cwd: "/repo/demo",
    createdAt: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

function legacyLive(overrides = {}) {
  return {
    name: "tw-term-legacy",
    rawName: "tw-term-legacy",
    attached: false,
    windows: 1,
    created: 1783700010,
    activity: 1783700020,
    cwd: "/repo/demo",
    serverSocketPath: "/tmp/tmux-501/default",
    serverPid: "4200",
    serverStarted: "1783700000",
    sessionId: "$7",
    sessionCreated: "1783700010",
    birthMarker: null,
    reservationCorrelation: null,
    lifecycleMarkersValid: true,
    ...overrides,
  };
}

function migrationCorrelation(overrides = {}) {
  return {
    schemaVersion: 1,
    reservationId: "tw-migrate-legacy-v1:tw-term-legacy",
    hostEpoch: "0",
    principalId: "tw-cli-legacy-migration",
    hostId: "localhost",
    commandId: "migrate-legacy:tw-term-legacy",
    requestFingerprint: { schemaVersion: 1, algorithm: "sha256-rfc8785", digest: FIXED_DIGEST },
    ...overrides,
  };
}

function foreignCorrelation(overrides = {}) {
  return {
    schemaVersion: 1,
    reservationId: "res_opaque_1",
    hostEpoch: "host-epoch-1",
    principalId: "principal-1",
    hostId: "mac-admin",
    commandId: "command-1",
    requestFingerprint: { schemaVersion: 1, algorithm: "sha256-rfc8785", digest: FIXED_DIGEST },
    ...overrides,
  };
}

function encoded(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function writeState(path, sessions) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`);
}

function readState(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** In-memory tmux simulator: set-option mutates the live entries that list() returns. */
function makeLive(initialEntries = []) {
  const entries = initialEntries.map((entry) => ({ ...entry }));
  return {
    entries,
    list: () => entries.map((entry) => ({ ...entry })),
    exec: (bin, args) => {
      assert.equal(args[0], "set-option", `unexpected tmux argv: ${args.join(" ")}`);
      const target = args[2].replace(/^=/, "").replace(/:$/, "");
      const entry = entries.find((candidate) => candidate.rawName === target);
      assert.ok(entry, `expected live session ${target}`);
      if (args[3] === BIRTH_OPTION) entry.birthMarker = args[4];
      else if (args[3] === CORR_OPTION) entry.reservationCorrelation = args[4];
      else throw new Error(`unexpected option ${args[3]}`);
    },
  };
}

test("idempotently marks a v1-era legacy managed session into v2 lifecycle authority", () => {
  withTempDir("tw-legacy-mark-", (root) => {
    const path = join(root, "state.json");
    writeState(path, [legacySession()]);
    const live = makeLive([legacyLive()]);
    let tmuxCalls = 0;
    const exec = (bin, args) => { tmuxCalls += 1; live.exec(bin, args); };

    const result = session.markRelayV2HostLegacySessionsLifecycleV1({
      statePath: path,
      listTmuxSessionLifecycleEntries: live.list,
      tmuxBin: () => "tmux",
      exec,
      randomBirthMarker: () => FIXED_BIRTH_MARKER,
    });
    assert.deepEqual(result, { marked: 1, recovered: 0, skipped: 0 });
    assert.equal(tmuxCalls, 2);

    const recorded = readState(path).sessions[0];
    const ext = state.managedSessionLifecycleExtension(recorded);
    assert.ok(ext, "legacy record should carry a lifecycle extension after marking");
    assert.equal(ext.tmux.birthMarker, FIXED_BIRTH_MARKER);
    assert.equal(ext.tmux.rawName, "tw-term-legacy");
    assert.equal(ext.displayLabel, "tw-term-legacy");
    assert.equal(
      ext.reservationCorrelation.reservationId,
      `${session.RELAY_V2_LEGACY_MIGRATION_RESERVATION_ID_PREFIX}:tw-term-legacy`,
    );

    // Idempotent: a second run touches neither tmux nor state.
    let tmuxCallsAfter = 0;
    const again = session.markRelayV2HostLegacySessionsLifecycleV1({
      statePath: path,
      listTmuxSessionLifecycleEntries: live.list,
      tmuxBin: () => "tmux",
      exec: (bin, args) => { tmuxCallsAfter += 1; live.exec(bin, args); },
      randomBirthMarker: () => FIXED_BIRTH_MARKER,
    });
    assert.deepEqual(again, { marked: 0, recovered: 0, skipped: 0 });
    assert.equal(tmuxCallsAfter, 0);
    assert.equal(readState(path).sessions.length, 1);
  });
});

test("recovers a partially applied migration from live tmux markers", () => {
  withTempDir("tw-legacy-recover-", (root) => {
    const path = join(root, "state.json");
    writeState(path, [legacySession()]);
    const correlation = migrationCorrelation();
    const live = makeLive([legacyLive({
      birthMarker: FIXED_BIRTH_MARKER,
      reservationCorrelation: encoded(correlation),
    })]);
    let execCalls = 0;

    const result = session.markRelayV2HostLegacySessionsLifecycleV1({
      statePath: path,
      listTmuxSessionLifecycleEntries: live.list,
      tmuxBin: () => "tmux",
      exec: (bin, args) => { execCalls += 1; },
    });
    assert.deepEqual(result, { marked: 0, recovered: 1, skipped: 0 });
    assert.equal(execCalls, 0, "recovery must not mutate tmux again");

    const recorded = readState(path).sessions[0];
    const ext = state.managedSessionLifecycleExtension(recorded);
    assert.ok(ext, "partial migration should be completed by a later run");
    assert.equal(ext.tmux.birthMarker, FIXED_BIRTH_MARKER);
    assert.equal(ext.displayLabel, "tw-term-legacy");
    assert.deepEqual(ext.reservationCorrelation, correlation);
  });
});

test("repairs an already-migrated record whose display label is null", () => {
  withTempDir("tw-legacy-repair-", (root) => {
    const path = join(root, "state.json");
    // Simulate the pre-fix migration output: a full lifecycle extension whose
    // displayLabel was persisted as null.
    const ext = state.buildManagedSessionLifecycleExtension(
      {
        serverSocketPath: "/tmp/tmux-501/default",
        serverPid: "4200",
        serverStarted: "1783700000",
        sessionId: "$7",
        rawName: "tw-term-legacy",
        sessionCreated: "1783700010",
        birthMarker: FIXED_BIRTH_MARKER,
      },
      migrationCorrelation(),
      null,
    );
    writeState(path, [state.withManagedSessionLifecycleExtension(legacySession(), ext)]);
    const live = makeLive([legacyLive({
      birthMarker: FIXED_BIRTH_MARKER,
      reservationCorrelation: encoded(migrationCorrelation()),
    })]);
    let execCalls = 0;

    const result = session.markRelayV2HostLegacySessionsLifecycleV1({
      statePath: path,
      listTmuxSessionLifecycleEntries: live.list,
      tmuxBin: () => "tmux",
      exec: (bin, args) => { execCalls += 1; live.exec(bin, args); },
    });
    assert.deepEqual(result, { marked: 0, recovered: 1, skipped: 0 });
    assert.equal(execCalls, 0, "the label repair is a state-only fix and must not touch tmux");

    const recorded = readState(path).sessions[0];
    const repaired = state.managedSessionLifecycleExtension(recorded);
    assert.ok(repaired, "the extension must survive the repair");
    assert.equal(repaired.displayLabel, "tw-term-legacy");
    assert.equal(repaired.tmux.birthMarker, FIXED_BIRTH_MARKER);
    assert.equal(repaired.incarnation, ext.incarnation, "repair must not rotate the incarnation");

    // Idempotent: a second run sees a non-null label and writes nothing.
    let execCallsAfter = 0;
    const again = session.markRelayV2HostLegacySessionsLifecycleV1({
      statePath: path,
      listTmuxSessionLifecycleEntries: live.list,
      tmuxBin: () => "tmux",
      exec: (bin, args) => { execCallsAfter += 1; live.exec(bin, args); },
    });
    assert.deepEqual(again, { marked: 0, recovered: 0, skipped: 0 });
    assert.equal(execCallsAfter, 0);
    assert.equal(
      state.managedSessionLifecycleExtension(readState(path).sessions[0]).displayLabel,
      "tw-term-legacy",
    );
  });
});

test("leaves foreign-marked live sessions invisible rather than adopting them", () => {
  withTempDir("tw-legacy-foreign-", (root) => {
    const path = join(root, "state.json");
    writeState(path, [legacySession()]);
    const live = makeLive([legacyLive({
      birthMarker: FIXED_BIRTH_MARKER,
      reservationCorrelation: encoded(foreignCorrelation()),
    })]);

    const result = session.markRelayV2HostLegacySessionsLifecycleV1({
      statePath: path,
      listTmuxSessionLifecycleEntries: live.list,
      tmuxBin: () => "tmux",
      exec: (bin, args) => { throw new Error("foreign markers must never be mutated"); },
    });
    assert.deepEqual(result, { marked: 0, recovered: 0, skipped: 1 });
    assert.equal(state.managedSessionLifecycleExtension(readState(path).sessions[0]), undefined);
  });
});

test("skips already-marked records and non-live records without touching tmux", () => {
  withTempDir("tw-legacy-skip-", (root) => {
    const path = join(root, "state.json");
    const ext = state.buildManagedSessionLifecycleExtension(
      {
        serverSocketPath: "/tmp/tmux-501/default",
        serverPid: "4200",
        serverStarted: "1783700000",
        sessionId: "$7",
        rawName: "tw-term-ext",
        sessionCreated: "1783700010",
        birthMarker: FIXED_BIRTH_MARKER,
      },
      migrationCorrelation({ reservationId: "tw-migrate-legacy-v1:tw-term-ext" }),
      "extended",
    );
    const markedRecord = state.withManagedSessionLifecycleExtension(
      legacySession({ name: "tw-term-ext", cwd: "/ext" }),
      ext,
    );
    const notLive = legacySession({ name: "tw-term-gone" });
    writeState(path, [markedRecord, notLive]);
    const live = makeLive([legacyLive({ name: "tw-term-ext", rawName: "tw-term-ext" })]);
    let execCalls = 0;

    const result = session.markRelayV2HostLegacySessionsLifecycleV1({
      statePath: path,
      listTmuxSessionLifecycleEntries: live.list,
      tmuxBin: () => "tmux",
      exec: (bin, args) => { execCalls += 1; live.exec(bin, args); },
    });
    assert.deepEqual(result, { marked: 0, recovered: 0, skipped: 0 });
    assert.equal(execCalls, 0);
    assert.equal(readState(path).sessions.length, 2);
  });
});

test("an invalid synthetic birth marker is skipped without a state write", () => {
  withTempDir("tw-legacy-invalid-marker-", (root) => {
    const path = join(root, "state.json");
    writeState(path, [legacySession()]);
    const live = makeLive([legacyLive()]);

    const result = session.markRelayV2HostLegacySessionsLifecycleV1({
      statePath: path,
      listTmuxSessionLifecycleEntries: live.list,
      tmuxBin: () => "tmux",
      exec: (bin, args) => { throw new Error("no tmux mutation expected for an invalid marker"); },
      randomBirthMarker: () => "not-a-birth-marker",
    });
    assert.deepEqual(result, { marked: 0, recovered: 0, skipped: 1 });
    assert.equal(state.managedSessionLifecycleExtension(readState(path).sessions[0]), undefined);
  });
});

test("converges an over-long session name into a byte-bounded display label", () => {
  // Helper-level assertions for the persistedDisplayLabel convergence contract.
  assert.equal(session.convergeRpcV2DisplayLabel("a".repeat(200)), "a".repeat(128));
  assert.equal(
    Buffer.byteLength(session.convergeRpcV2DisplayLabel("a".repeat(200)), "utf8"),
    128,
  );
  // A multi-byte character straddling the 128-byte cut must be dropped whole,
  // never split: 42 × 界 (3 bytes each) + "a" = 127 bytes, then another 界
  // would push past the limit, so only "42界 + a" survives.
  const multibyteName = "界".repeat(42) + "a" + "界";
  assert.equal(session.convergeRpcV2DisplayLabel(multibyteName), "界".repeat(42) + "a");
  assert.equal(session.convergeRpcV2DisplayLabel("  padded  "), "padded");
  assert.equal(session.convergeRpcV2DisplayLabel("   "), undefined);

  withTempDir("tw-legacy-label-", (root) => {
    // A >128-byte name cannot be marked at all: the tmux incarnation identity
    // byte-bounds rawName to 128, so the migration skips it without persisting
    // a broken lifecycle extension (and never writes a truncated label that
    // would diverge from the authoritative name).
    const path = join(root, "state.json");
    const longName = "界".repeat(42) + "a" + "界";
    writeState(path, [legacySession({ name: longName })]);
    const live = makeLive([legacyLive({ name: longName, rawName: longName })]);

    const result = session.markRelayV2HostLegacySessionsLifecycleV1({
      statePath: path,
      listTmuxSessionLifecycleEntries: live.list,
      tmuxBin: () => "tmux",
      exec: (bin, args) => live.exec(bin, args),
      randomBirthMarker: () => FIXED_BIRTH_MARKER,
    });
    assert.deepEqual(result, { marked: 0, recovered: 0, skipped: 1 });
    assert.equal(state.managedSessionLifecycleExtension(readState(path).sessions[0]), undefined);
  });
});

test("skips a whitespace-only session name without persisting an extension", () => {
  withTempDir("tw-legacy-blank-", (root) => {
    const path = join(root, "state.json");
    writeState(path, [legacySession({ name: "   " })]);
    const live = makeLive([legacyLive({ name: "   ", rawName: "   " })]);
    let execCalls = 0;

    const result = session.markRelayV2HostLegacySessionsLifecycleV1({
      statePath: path,
      listTmuxSessionLifecycleEntries: live.list,
      tmuxBin: () => "tmux",
      exec: (bin, args) => { execCalls += 1; live.exec(bin, args); },
    });
    assert.deepEqual(result, { marked: 0, recovered: 0, skipped: 1 });
    assert.equal(execCalls, 0);
    assert.equal(state.managedSessionLifecycleExtension(readState(path).sessions[0]), undefined);
  });
});

test("corrupt managed state fails closed before any tmux mutation", () => {
  withTempDir("tw-legacy-corrupt-", (root) => {
    const path = join(root, "state.json");
    writeFileSync(path, "{ invalid json");
    let execCalls = 0;
    assert.throws(
      () => session.markRelayV2HostLegacySessionsLifecycleV1({
        statePath: path,
        listTmuxSessionLifecycleEntries: () => [],
        tmuxBin: () => "tmux",
        exec: () => { execCalls += 1; },
      }),
      /refusing to mutate invalid managed state/,
    );
    assert.equal(execCalls, 0);
  });
});

const FAKE_TMUX_SCRIPT = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const home = process.env.HOME;
const statePath = path.join(home, ".tmux-worktree", "state.json");
const markersPath = path.join(home, ".tmux-worktree", ".fake-tmux-markers.json");
const US = String.fromCharCode(31);

function readMarkers() {
  try { return JSON.parse(fs.readFileSync(markersPath, "utf8")); }
  catch { return {}; }
}
function writeMarkers(markers) {
  fs.mkdirSync(path.dirname(markersPath), { recursive: true });
  fs.writeFileSync(markersPath, JSON.stringify(markers));
}

const args = process.argv.slice(2);
if (args[0] === "list-sessions") {
  let sessions = [];
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    sessions = state.sessions || [];
  } catch { sessions = []; }
  if (sessions.length === 0) process.exit(0);
  const markers = readMarkers();
  const lines = sessions.map((session, index) => {
    const m = markers[session.name] || {};
    return [
      "/tmp/fake-tmux/default",
      "4200",
      "1783700000",
      "$" + (index + 1),
      session.name,
      "1783700010",
      m.birth || "",
      m.corr || "",
      "0",
      "1",
      "1783700020",
      session.cwd || "/",
    ].join(US);
  });
  process.stdout.write(lines.join("\\n") + "\\n");
  process.exit(0);
}
if (args[0] === "set-option") {
  const target = args[2] || "";
  const name = target.replace(/^=/, "").replace(/:$/, "");
  const option = args[3] || "";
  const value = args[4] || "";
  const markers = readMarkers();
  markers[name] = markers[name] || {};
  if (option === "@tw_rpc_v2_birth_marker_v1") markers[name].birth = value;
  else if (option === "@tw_rpc_v2_reservation_correlation_v1") markers[name].corr = value;
  else { process.exit(1); }
  writeMarkers(markers);
  process.exit(0);
}
process.exit(1);
`;

test("tw rpc-v2 list lazily promotes a legacy session and projects lifecycleMarked", () => {
  withTempDir("tw-legacy-cli-", (root) => {
    const home = root;
    const twHome = join(home, ".tmux-worktree");
    mkdirSync(twHome, { recursive: true });
    writeFileSync(
      join(twHome, "state.json"),
      `${JSON.stringify({ version: 1, sessions: [legacySession()] }, null, 2)}\n`,
    );
    const fakeTmux = join(root, "fake-tmux.cjs");
    writeFileSync(fakeTmux, FAKE_TMUX_SCRIPT);
    chmodSync(fakeTmux, 0o755);

    const run = () => spawnSync(process.execPath, [cli, "rpc-v2", "list"], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, HOME: home, TW_TMUX: fakeTmux },
    });

    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const response = JSON.parse(first.stdout);
    assert.equal(response.sessions.length, 1);
    assert.equal(response.sessions[0].name, "tw-term-legacy");
    assert.equal(response.sessions[0].lifecycleMarked, true);
    assert.equal(
      response.sessions[0].label,
      "tw-term-legacy",
      "the persisted display label must be non-null and equal to the session name",
    );
    assert.ok(response.sessions[0].reservationCorrelation, "migration correlation is projected");

    // State now carries a real lifecycle extension.
    const persisted = readState(join(twHome, "state.json")).sessions[0];
    assert.ok(state.managedSessionLifecycleExtension(persisted));

    // A second list is idempotent and still projects the session.
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    const response2 = JSON.parse(second.stdout);
    assert.equal(response2.sessions.length, 1);
    assert.equal(response2.sessions[0].lifecycleMarked, true);
  });
});
