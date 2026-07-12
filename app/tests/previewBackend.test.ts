import assert from "node:assert/strict";
import test from "node:test";
import {
  previewDashboardBackend,
  previewDashboardTransport,
} from "../src/platform/previewBackend.ts";

test("preview backend supplies the dashboard startup state", async () => {
  const [sessions, projects, hosts, statuses, terminals, agents, layout] = await Promise.all([
    previewDashboardBackend.sessions.list(),
    previewDashboardBackend.projects.list(),
    previewDashboardBackend.hosts.list(),
    previewDashboardBackend.hosts.statuses(),
    previewDashboardBackend.terminals.listTmux(),
    previewDashboardBackend.agents.probe({ kind: "local" }),
    previewDashboardBackend.persistence.loadLayout(),
  ]);

  assert.ok(sessions.length >= 3);
  assert.ok(projects.length >= 2);
  assert.equal(hosts[0]?.id, "builder-1");
  assert.equal(statuses[0]?.reachable, true);
  assert.ok(terminals.length >= 1);
  assert.deepEqual(agents.map((agent) => agent.command), [
    "claude",
    "codex",
    "gemini",
    "opencode",
    "aider",
  ]);
  assert.equal(agents.find((agent) => agent.id === "codex")?.available, true);
  assert.deepEqual(layout, {
    layout: {},
    revision: "twlr1_sXxMImuzfZTgkc_67MCwlyAPnRg6pgLHfSRIUVhE-nY",
  });
});

test("preview PTY follows the same facade and emits deterministic output", async () => {
  const id = "preview-test-pty";
  const chunks: string[] = [];
  const connection = await previewDashboardBackend.pty.connect(
    { id, cmd: "zsh", args: [], cwd: "/tmp", cols: 80, rows: 24 },
    {
      onData: (event) => chunks.push(event.data),
      onExit: () => {},
    },
  );
  await Promise.resolve();

  assert.equal(connection.active, true);
  assert.match(chunks.join(""), /preview backend connected/);
  await connection.close();
  assert.equal(previewDashboardTransport.listenerCount(`pty:${id}`), 0);
  assert.equal(previewDashboardTransport.listenerCount(`pty-exit:${id}`), 0);
});
