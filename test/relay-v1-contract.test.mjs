import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const contractRoot = new URL("../contracts/relay/v1/", import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, contractRoot), "utf8"));
}

function fixtures(path) {
  const value = readJson(path);
  assert.ok(Array.isArray(value), `${path} must contain a top-level array`);
  assert.ok(value.length > 0, `${path} must not be empty`);

  const names = new Set();
  for (const fixture of value) {
    assert.equal(typeof fixture.name, "string", `${path} fixture name`);
    assert.ok(fixture.name.length > 0, `${path} fixture name must not be empty`);
    assert.equal(names.has(fixture.name), false, `${path} duplicate ${fixture.name}`);
    names.add(fixture.name);
    assert.equal(typeof fixture.type, "string", `${path}/${fixture.name} type`);
    assert.ok(Object.hasOwn(fixture, "normalized"), `${path}/${fixture.name} normalized`);
    assert.equal(typeof fixture.wire, "string", `${path}/${fixture.name} wire`);
    const wire = JSON.parse(fixture.wire);
    assert.equal(
      JSON.stringify(wire),
      fixture.wire,
      `${path}/${fixture.name} wire must be canonical minified JSON`,
    );
    assert.equal(wire.type, fixture.type, `${path}/${fixture.name} wire type`);
    assert.equal(
      fixture.normalized.type,
      fixture.type,
      `${path}/${fixture.name} normalized type`,
    );
  }
  return value;
}

function byName(values) {
  return new Map(values.map((value) => [value.name, value]));
}

function sortedTypes(values) {
  return [...new Set(values.map((value) => value.type))].sort();
}

function assertRequiredSession(session, label) {
  assert.equal(typeof session.name, "string", `${label}.name`);
  assert.equal(typeof session.attached, "boolean", `${label}.attached`);
  for (const field of ["windows", "created", "activity"]) {
    assert.equal(typeof session[field], "number", `${label}.${field}`);
  }
}

function assertRequiredServerPayload(payload, label) {
  if (payload.type === "hosts") {
    for (const [index, host] of payload.hosts.entries()) {
      assert.equal(typeof host.hostId, "string", `${label}.hosts[${index}].hostId`);
      assert.equal(
        typeof host.connectedAt,
        "number",
        `${label}.hosts[${index}].connectedAt`,
      );
      assert.equal(typeof host.clients, "number", `${label}.hosts[${index}].clients`);
    }
  }
  if (payload.type === "sessions") {
    payload.sessions.forEach((session, index) =>
      assertRequiredSession(session, `${label}.sessions[${index}]`));
  }
  if (payload.type === "worktree_created" || payload.type === "terminal_created") {
    assertRequiredSession(payload.session, `${label}.session`);
  }
  if (payload.type === "scope_statuses") {
    for (const [index, scope] of payload.scopes.entries()) {
      assert.equal(typeof scope.scopeId, "string", `${label}.scopes[${index}].scopeId`);
      assert.ok(
        scope.kind === "local" || scope.kind === "ssh",
        `${label}.scopes[${index}].kind`,
      );
      assert.equal(
        typeof scope.reachable,
        "boolean",
        `${label}.scopes[${index}].reachable`,
      );
    }
  }
}

test("relay v1 manifest freezes all four wire directions", () => {
  assert.deepEqual(readJson("manifest.json"), {
    contract: "tmux-worktree-relay-v1",
    version: 1,
    status: "legacy-frozen",
    encoding: "utf-8-json-text",
    files: [
      { direction: "client-to-broker", path: "client-messages.json" },
      { direction: "broker-to-client", path: "server-messages.json" },
      { direction: "broker-to-host", path: "broker-to-host.json" },
      { direction: "host-to-broker", path: "host-to-broker.json" },
    ],
  });
});

test("relay v1 fixtures freeze the complete message type surface", () => {
  assert.deepEqual(sortedTypes(fixtures("client-messages.json")), [
    "close_terminal",
    "create_terminal",
    "create_worktree",
    "kill_session",
    "list_hosts",
    "list_scope_statuses",
    "list_sessions",
    "open_terminal",
    "resize",
    "send_agent_message",
    "terminal_input",
  ]);
  assert.deepEqual(sortedTypes(fixtures("server-messages.json")), [
    "agent_message_sent",
    "error",
    "hosts",
    "ready",
    "scope_statuses",
    "session_killed",
    "sessions",
    "terminal_created",
    "terminal_data",
    "terminal_exit",
    "worktree_created",
  ]);
  assert.deepEqual(sortedTypes(fixtures("broker-to-host.json")), [
    "client_closed",
    "close_terminal",
    "create_terminal",
    "create_worktree",
    "host_registered",
    "kill_session",
    "list_scope_statuses",
    "list_sessions",
    "open_terminal",
    "resize",
    "send_agent_message",
    "terminal_input",
  ]);
  assert.deepEqual(sortedTypes(fixtures("host-to-broker.json")), [
    "agent_message_sent",
    "error",
    "host_ready",
    "scope_statuses",
    "session_killed",
    "sessions",
    "terminal_created",
    "terminal_data",
    "terminal_exit",
    "worktree_created",
  ]);
});

test("relay v1 normal response fixtures contain every required wire field", () => {
  for (const path of ["server-messages.json", "host-to-broker.json"]) {
    for (const fixture of fixtures(path)) {
      assertRequiredServerPayload(JSON.parse(fixture.wire), `${path}/${fixture.name}`);
    }
  }
});

test("relay v1 broker injection and stripping preserve exact field order and values", () => {
  const clients = byName(fixtures("client-messages.json"));
  const server = byName(fixtures("server-messages.json"));
  const brokerToHost = fixtures("broker-to-host.json");
  const hostToBroker = fixtures("host-to-broker.json");

  const routed = brokerToHost.filter((fixture) => fixture.source);
  assert.equal(routed.length, 10);
  for (const fixture of routed) {
    const source = clients.get(fixture.source);
    assert.ok(source, `${fixture.name} source ${fixture.source}`);
    assert.equal(
      fixture.wire,
      JSON.stringify({ ...JSON.parse(source.wire), clientId: "client-1" }),
      `${fixture.name} must append the authenticated clientId`,
    );
  }

  const delivered = hostToBroker.filter((fixture) => fixture.deliversAs);
  assert.equal(delivered.length, 9);
  for (const fixture of delivered) {
    const target = server.get(fixture.deliversAs);
    assert.ok(target, `${fixture.name} target ${fixture.deliversAs}`);
    const { clientId, ...outbound } = JSON.parse(fixture.wire);
    assert.equal(clientId, "client-1", `${fixture.name} routing clientId`);
    assert.equal(
      JSON.stringify(outbound),
      target.wire,
      `${fixture.name} must strip only clientId before delivery`,
    );
  }
});

test("relay v1 Android compatibility omissions and scalar pane forms stay explicit", () => {
  const clients = byName(fixtures("client-messages.json"));
  const server = byName(fixtures("server-messages.json"));

  const terminal = JSON.parse(clients.get("create-terminal-android-v1").wire);
  assert.equal(Object.hasOwn(terminal, "aiCommand"), false);
  assert.equal(Object.hasOwn(terminal, "aiCmd"), false);

  const kill = JSON.parse(clients.get("kill-session-android-v1").wire);
  assert.equal(Object.hasOwn(kill, "managed"), false);

  const noRequest = JSON.parse(
    clients.get("send-agent-message-number-pane-without-request").wire,
  );
  assert.equal(Object.hasOwn(noRequest, "requestId"), false);
  assert.equal(typeof noRequest.pane, "number");
  assert.equal(
    typeof JSON.parse(clients.get("send-agent-message-text-pane").wire).pane,
    "string",
  );

  const exit = JSON.parse(server.get("terminal-exit-without-code").wire);
  assert.equal(Object.hasOwn(exit, "code"), false);
  assert.equal(server.get("terminal-exit-without-code").normalized.code, null);

  const error = JSON.parse(server.get("error-without-correlation").wire);
  assert.equal(Object.hasOwn(error, "requestId"), false);
  assert.equal(Object.hasOwn(error, "streamId"), false);
  assert.equal(server.get("error-without-correlation").normalized.requestId, null);
  assert.equal(server.get("error-without-correlation").normalized.streamId, null);
});
