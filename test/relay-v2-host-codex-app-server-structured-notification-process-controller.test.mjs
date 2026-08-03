import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const controllerModule = await import(
  "../dist/relay/v2/hostCodexAppServerStructuredNotificationProcessController.js"
);
const activationModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/codexAppServerTrustedSourceActivation.js"
);

const OWNER = Object.freeze({ hostId: "host-real-controller", hostEpoch: "epoch-real-controller" });
const TARGET = Object.freeze({ scopeId: "scope-real-controller", sessionId: "session-real-controller" });
const BACKEND_INSTANCE_KEY = "backend-real-controller";
const MANAGED_INCARNATION = `twinc2.${"b".repeat(43)}`;

function fixtureSource(markerPath, codexHome) {
  return `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let pending = "";
const marker = ${JSON.stringify(markerPath)};
const codexHome = ${JSON.stringify(codexHome)};
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.on("SIGTERM", () => {
  writeFileSync(marker, "reaped\\n", "utf8");
  process.exit(0);
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (;;) {
    const newline = pending.indexOf("\\n");
    if (newline < 0) break;
    const raw = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    const message = JSON.parse(raw);
    if (message.method === "initialize") {
      send({
        id: 1,
        result: {
          userAgent: "tmux-worktree-relay-host/0.146.0 (fixture; arm64) fixture (tmux-worktree-relay-host; 1)",
          codexHome,
          platformFamily: "unix",
          platformOs: "macos",
        },
      });
    } else if (message.method === "initialized") {
      send({ method: "warning", params: { message: "filtered structured notification" } });
      send({
        method: "turn/started",
        params: {
          threadId: "thread-real-controller",
          turn: {
            id: "turn-real-controller",
            items: [],
            itemsView: "full",
            status: "inProgress",
            error: null,
            startedAt: 1700000000,
            completedAt: null,
            durationMs: null,
          },
        },
      });
    }
  }
});
`;
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

test("exact 0.146.0 controller resolves H2 twice, filters notifications, and reaps its child", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "tw-host-codex-controller-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const executablePath = join(home, "codex-fixture");
  const markerPath = join(home, "reaped.txt");
  writeFileSync(executablePath, fixtureSource(markerPath, home), "utf8");
  chmodSync(executablePath, 0o700);
  const sha256 = createHash("sha256").update(readFileSync(executablePath)).digest("hex");

  const artifact = await controllerModule.captureRelayV2HostCodexAppServerExecutableArtifact(
    Object.freeze({
      executablePath,
      sha256,
      provider: "codex-app-server",
      providerVersion: "0.146.0",
      schemaVersion: 2,
    }),
  );
  const resolverCalls = [];
  const resolver = {
    async captureToken(hostEpoch) {
      resolverCalls.push(["capture", hostEpoch]);
      return {
        schemaVersion: 1,
        hostEpoch,
        resourceMappingDigest: "mapping-real-controller",
        discoveryGeneration: "discovery-real-controller",
      };
    },
    async resolveSession(token, scopeId, sessionId) {
      resolverCalls.push(["resolve", token.hostEpoch, scopeId, sessionId]);
      return {
        authorization: "evidence_only",
        hostEpoch: OWNER.hostEpoch,
        discoveryGeneration: "discovery-real-controller",
        scopeId: TARGET.scopeId,
        processTarget: { kind: "local", targetId: "process-real-controller" },
        capabilities: [],
        sessionId: TARGET.sessionId,
        backendInstanceKey: BACKEND_INSTANCE_KEY,
        managedTarget: {
          name: "managed-real-controller",
          kind: "worktree",
          incarnation: MANAGED_INCARNATION,
        },
      };
    },
  };
  const controller = new controllerModule
    .RelayV2HostCodexAppServerStructuredNotificationProcessController(
      OWNER.hostId,
      OWNER.hostEpoch,
      resolver,
      Object.freeze({ executableArtifact: artifact, ...TARGET }),
    );
  const ingested = [];
  const runtime = {
    store: { owner: OWNER },
    async ingestTrustedSource(binding, event) {
      ingested.push([binding, event]);
      return { reduction: { disposition: "applied" }, delivery: null };
    },
  };
  const activation = new activationModule.CodexAppServerTrustedSourceActivation({
    controller,
    runtime,
    canonicalResourceResolver: resolver,
  });

  await activation.activate();
  await waitFor(() => ingested.length === 3);
  assert.deepEqual(resolverCalls.map(([operation]) => operation), [
    "capture", "resolve", "capture", "resolve",
  ]);
  assert.deepEqual(ingested.map(([, event]) => event.mutation.mutationType), [
    "source.started", "lifecycle.changed", "lifecycle.changed",
  ]);
  assert.equal(ingested[0][0].scopeId, TARGET.scopeId);
  assert.equal(ingested[0][0].sessionId, TARGET.sessionId);
  assert.equal(
    ingested.some(([, event]) => JSON.stringify(event).includes("filtered structured notification")),
    false,
  );

  await activation.close();
  assert.equal(existsSync(markerPath), true, "close owns TERM, reap, and drain");

  const brokenExecutablePath = join(home, "codex-broken-fixture");
  writeFileSync(brokenExecutablePath, "#!/definitely/missing/codex-interpreter\n", "utf8");
  chmodSync(brokenExecutablePath, 0o700);
  const brokenSha256 = createHash("sha256")
    .update(readFileSync(brokenExecutablePath))
    .digest("hex");
  const brokenArtifact = await controllerModule
    .captureRelayV2HostCodexAppServerExecutableArtifact(Object.freeze({
      executablePath: brokenExecutablePath,
      sha256: brokenSha256,
      provider: "codex-app-server",
      providerVersion: "0.146.0",
      schemaVersion: 2,
    }));
  const brokenController = new controllerModule
    .RelayV2HostCodexAppServerStructuredNotificationProcessController(
      OWNER.hostId,
      OWNER.hostEpoch,
      resolver,
      Object.freeze({ executableArtifact: brokenArtifact, ...TARGET }),
    );
  await assert.rejects(
    brokenController.claimControlledProcess(),
    (error) => (
      error instanceof controllerModule.RelayV2HostCodexAppServerProcessControllerError
      && error.code === "HANDSHAKE_FAILED"
    ),
  );
});
