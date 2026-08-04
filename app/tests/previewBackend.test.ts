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
    "kimi",
  ]);
  assert.equal(agents.find((agent) => agent.id === "codex")?.available, true);
  assert.equal(agents.find((agent) => agent.id === "kimi")?.available, true);
  assert.deepEqual(layout, {
    layout: {},
    revision: "twlr1_sXxMImuzfZTgkc_67MCwlyAPnRg6pgLHfSRIUVhE-nY",
  });
  assert.equal("closeLifecycle" in previewDashboardTransport, false);
  assert.equal("closeLifecycle" in previewDashboardBackend.window, false);
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

test("preview Feishu bindings preserve and update reply placement", async () => {
  const created = await previewDashboardBackend.feishu.create({
    chatId: "oc_preview",
    chatName: "TW Preview Group",
    sessionName: "dashboard-redesign",
    sessionSummary: "Dashboard redesign",
    attachmentId: "preview-pty",
    createdBy: "local-dashboard",
    allowedSenderIds: [],
    mentionOnly: true,
    replyMode: "direct",
  });
  assert.equal(created.options.replyMode, "direct");

  const updated = await previewDashboardBackend.feishu.updateReplyMode(created.id, "topic");
  assert.equal(updated.options.replyMode, "topic");
  assert.equal(
    (await previewDashboardBackend.feishu.status()).bindings[0]?.options.replyMode,
    "topic",
  );
});
