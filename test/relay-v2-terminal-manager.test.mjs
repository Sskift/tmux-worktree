import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const codec = await import("../dist/relay/v2/codec.js");
const terminal = await import("../dist/relay/v2/terminalManager.js");
const fixtures = loadRelayV2FixtureCorpus();

const HOST_ID = "mac-admin";
const HOST_EPOCH = "authority-uuid";
const HOST_INSTANCE_ID = "host-process-uuid";
const AUTH = {
  principalId: "principal-opaque-id",
  clientInstanceId: "android-install-uuid",
};
const TARGET = {
  hostId: HOST_ID,
  scopeId: "scope-local",
  sessionId: "ses_01JOPAQUE",
};
const RESOLVED_TARGET = {
  ...TARGET,
  pane: 0,
  canonicalTargetId: "canonical-target-opaque",
  controlTargetId: "control-target-opaque",
};
const ROUTE_ONE = {
  connectorId: "connector-one",
  routeId: "route-one",
  routeFence: "fence-one",
  runtimeBindingToken: "runtime-binding-one",
};

function clone(value) {
  return structuredClone(value);
}

function resumeTokenHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactRoute(route) {
  route.runtimeBindingToken ??= [
    "runtime-binding",
    route.connectorId,
    route.routeId,
    route.routeFence,
  ].join(":");
  return clone(route);
}

function managerError(code) {
  return (error) => {
    assert.ok(error instanceof terminal.RelayV2TerminalManagerError);
    assert.equal(error.code, code);
    return true;
  };
}

class FakeByteHandle {
  constructor(observer, trace) {
    this.observer = observer;
    this.trace = trace;
    this.closeCalls = 0;
    this.pauseCalls = 0;
    this.resumeCalls = 0;
    this.paused = false;
    this.displayHints = [];
  }

  async pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }

  async resume() {
    this.resumeCalls += 1;
    this.paused = false;
  }

  async close() {
    this.closeCalls += 1;
    this.trace.push("backend.close");
  }

  async setDisplaySizeHint(size) {
    this.displayHints.push(clone(size));
  }

  async emit(data) {
    await this.observer.onBytes(Buffer.from(data));
  }

  async emitRaw(data) {
    await this.observer.onBytes(data);
  }

  async exit(reason = "backend_exit", exitCode = 0) {
    await this.observer.onClosed({ reason, exitCode });
  }
}

class FakeByteBackend {
  constructor(trace = []) {
    this.trace = trace;
  }

  opens = [];
  openResults = [];

  async open(target, options, observer) {
    this.trace.push("backend.open");
    const result = this.openResults.shift();
    if (result instanceof Error) throw result;
    const handle = new FakeByteHandle(observer, this.trace);
    this.opens.push({ target: clone(target), options: clone(options), handle });
    return handle;
  }
}

class FakeTerminalControl {
  constructor(now, trace = []) {
    this.now = now;
    this.trace = trace;
  }

  acquireCalls = [];
  renewCalls = [];
  releaseCalls = [];
  continuityCalls = [];
  inputCalls = [];
  resizeCalls = [];
  inputResults = [];
  resizeResults = [];
  acquireResults = [];
  renewResults = [];
  releaseResults = [];
  continuityResults = [];
  continuous = true;
  leaseCounter = 0;

  lease(target, owner) {
    const id = ++this.leaseCounter;
    return {
      controlTargetId: target.controlTargetId,
      controlEpoch: `control-epoch-${id}`,
      leaseId: `lease-${id}`,
      fence: `lease-fence-${id}`,
      owner: clone(owner),
      expiresAt: new Date(this.now() + 60_000).toISOString(),
    };
  }

  async acquire(input) {
    this.trace.push("control.acquire");
    this.acquireCalls.push(clone(input));
    const result = this.acquireResults.shift();
    if (result instanceof Error) throw result;
    return result ?? { status: "accepted", lease: this.lease(input.target, input.owner) };
  }

  async renew(input) {
    this.renewCalls.push(clone(input));
    const result = this.renewResults.shift();
    if (result instanceof Error) throw result;
    return result ?? {
      status: "accepted",
      lease: {
        ...clone(input.lease),
        expiresAt: new Date(this.now() + 60_000).toISOString(),
      },
    };
  }

  async release(input) {
    this.trace.push("control.release");
    this.releaseCalls.push(clone(input));
    const result = this.releaseResults.shift();
    if (result instanceof Error) throw result;
  }

  async hasContinuity(input) {
    this.continuityCalls.push(clone(input));
    const result = this.continuityResults.shift();
    if (result instanceof Error) throw result;
    return result ?? this.continuous;
  }

  async writeInput(input) {
    this.inputCalls.push({ ...input, data: Buffer.from(input.data) });
    return this.inputResults.shift() ?? { accepted: true };
  }

  async resize(input) {
    this.trace.push("control.resize");
    this.resizeCalls.push(clone(input));
    return this.resizeResults.shift() ?? { accepted: true };
  }
}

class FakeResolver {
  constructor(trace = []) {
    this.trace = trace;
  }

  calls = [];
  resolved = clone(RESOLVED_TARGET);

  async resolve(input) {
    this.trace.push("resolver.resolve");
    this.calls.push(clone(input));
    return { ...clone(this.resolved), pane: input.pane };
  }
}

class FakeDurableLineage {
  constructor(trace = []) {
    this.trace = trace;
  }

  opens = new Map();
  streams = new Map();
  closes = new Map();
  claimOpenCalls = [];
  completeOpenCalls = [];
  failOpenCalls = [];
  claimCloseCalls = [];
  finalizeCloseCalls = [];
  markStreamClosedCalls = [];
  releaseStreamReservationCalls = [];
  failFinalizeOnce = false;
  claimCounter = 0;
  completeOpenReplayOutcome = undefined;
  failCompleteOpenOnce = false;
  failFailOpenOnce = false;
  busyClaimOpenOnce = false;
  rejectGenerationReuseOnce = false;
  markStreamClosedWait = undefined;
  markStreamClosedResults = [];
  releaseStreamReservationResults = [];
  usedGenerations = new Set();

  async claimOpen(claim) {
    this.claimOpenCalls.push(clone(claim));
    const retained = this.opens.get(claim.key);
    if (retained) {
      if (retained.fingerprint !== claim.fingerprint) {
        return { status: "conflict", reason: "open_conflict" };
      }
      if (retained.state === "pending") {
        retained.state = "final";
        retained.outcome = {
          kind: "reset",
          generation: retained.previousGeneration,
          reason: "stream_lost",
          requestedOffset: retained.requestedOffset,
          bufferStartOffset: null,
          tailOffset: null,
        };
      }
      return { status: "replay", outcome: clone(retained.outcome) };
    }
    if (this.busyClaimOpenOnce) {
      this.busyClaimOpenOnce = false;
      return { status: "busy", reason: "control_record_quota" };
    }
    const active = this.streams.get(claim.streamKey);
    const streamAuthority = !active || active.status === "released"
      ? { status: "absent" }
      : {
          status: active.status,
          generation: active.generation,
          target: clone(active.target),
          pane: active.pane,
          resumeTokenHash: active.resumeTokenHash,
        };
    if (streamAuthority.status !== "absent" && claim.mode === "new") {
      return { status: "conflict", reason: "stream_conflict" };
    }
    if (streamAuthority.status !== "absent" && claim.mode === "reset") {
      const replacing = claim.previousGeneration !== null
        && streamAuthority.generation === claim.previousGeneration;
      if (!replacing) return { status: "conflict", reason: "stream_conflict" };
    }
    const claimNumber = ++this.claimCounter;
    const claimToken = `claim-token-${claimNumber}`;
    const fence = `claim-fence-${claimNumber}`;
    const copy = {
      ...clone(claim),
      state: "pending",
      claimToken,
      fence,
      streamAuthority: clone(streamAuthority),
    };
    this.opens.set(claim.key, copy);
    return { status: "claimed", claimToken, fence, streamAuthority: clone(streamAuthority) };
  }

  async completeOpen(input) {
    this.completeOpenCalls.push(clone(input));
    this.trace.push("lineage.open.complete");
    if (this.failCompleteOpenOnce) {
      this.failCompleteOpenOnce = false;
      throw new Error("injected crash before durable open completion");
    }
    if (this.completeOpenReplayOutcome !== undefined) {
      const retained = this.opens.get(input.key);
      if (!retained) throw new Error("open claim lost");
      retained.state = "final";
      retained.outcome = clone(this.completeOpenReplayOutcome);
      if (retained.outcome.kind === "opened") {
        this.usedGenerations.add(retained.outcome.generation);
        this.streams.set(retained.streamKey, {
          status: "live",
          generation: retained.outcome.generation,
          hostInstanceId: retained.hostInstanceId,
          target: clone(retained.target),
          pane: retained.pane,
          resumeTokenHash: retained.outcome.resumeTokenHash,
        });
      }
      this.completeOpenReplayOutcome = undefined;
      return { status: "replay", outcome: clone(retained.outcome) };
    }
    return this.settleOpen(input);
  }

  async failOpen(input) {
    this.failOpenCalls.push(clone(input));
    this.trace.push("lineage.open.fail");
    if (this.failFailOpenOnce) {
      this.failFailOpenOnce = false;
      throw new Error("injected crash before durable open failure");
    }
    return this.settleOpen(input);
  }

  settleOpen(input) {
    const retained = this.opens.get(input.key);
    if (!retained || retained.fingerprint !== input.fingerprint) throw new Error("open claim lost");
    if (retained.state === "final") {
      return { status: "replay", outcome: clone(retained.outcome) };
    }
    if (retained.claimToken !== input.claimToken || retained.fence !== input.fence) {
      throw new Error("open claim authority lost");
    }
    if (input.outcome.kind === "opened") {
      const exactResume = retained.mode === "resume"
        && retained.streamAuthority.status !== "absent"
        && retained.streamAuthority.generation === input.outcome.generation;
      if (this.rejectGenerationReuseOnce || (!exactResume && this.usedGenerations.has(input.outcome.generation))) {
        this.rejectGenerationReuseOnce = false;
        return { status: "rejected", reason: "generation_reuse" };
      }
    }
    retained.state = "final";
    retained.outcome = clone(input.outcome);
    if (retained.outcome.kind === "opened") {
      this.usedGenerations.add(retained.outcome.generation);
      if (retained.outcome.disposition === "resumed") {
        const current = this.streams.get(retained.streamKey);
        if (!current || current.generation !== retained.outcome.generation) {
          throw new Error("resume source authority lost");
        }
      } else {
        this.streams.set(retained.streamKey, {
          status: "live",
          generation: retained.outcome.generation,
          hostInstanceId: retained.hostInstanceId,
          target: clone(retained.target),
          pane: retained.pane,
          resumeTokenHash: retained.outcome.resumeTokenHash,
        });
      }
    } else if (input.streamEffect?.kind === "retire_previous") {
      const current = this.streams.get(retained.streamKey);
      if (!current || current.generation !== input.streamEffect.generation) {
        throw new Error("retired stream generation mismatched");
      }
      current.status = "released";
    }
    return { status: "committed", outcome: clone(retained.outcome) };
  }

  serializedSnapshot() {
    return JSON.stringify({
      opens: [...this.opens.entries()],
      streams: [...this.streams.entries()],
      closes: [...this.closes.entries()],
    });
  }

  async claimClose(input) {
    this.claimCloseCalls.push(clone(input));
    this.trace.push("lineage.close.claim");
    const existing = this.closes.get(input.key);
    if (existing) {
      if (existing.value.fingerprint !== input.fingerprint) return { status: "close_conflict" };
      return existing.state === "final"
        ? { status: "final", tombstone: clone(existing.value) }
        : { status: "existing_intent", intent: clone(existing.value) };
    }
    if (!input.intent) return { status: "not_found" };
    this.closes.set(input.key, { state: "intent", value: clone(input.intent) });
    return { status: "claimed", intent: clone(input.intent) };
  }

  async finalizeClose(input) {
    this.finalizeCloseCalls.push(clone(input));
    this.trace.push("lineage.close.finalize");
    if (this.failFinalizeOnce) {
      this.failFinalizeOnce = false;
      throw new Error("injected crash before final close tombstone");
    }
    const existing = this.closes.get(input.key);
    if (!existing || existing.value.fingerprint !== input.fingerprint) {
      throw new Error("close intent lost");
    }
    existing.state = "final";
    const stream = this.streams.get(existing.value.streamKey);
    if (stream && stream.generation === existing.value.generation) stream.status = "closed";
    return clone(existing.value);
  }

  async markStreamClosed(input) {
    this.markStreamClosedCalls.push(clone(input));
    this.trace.push("lineage.stream.closed");
    if (this.markStreamClosedWait) await this.markStreamClosedWait;
    const configured = this.markStreamClosedResults.shift();
    if (configured instanceof Error) throw configured;
    if (configured) return clone(configured);
    const stream = this.streams.get(input.streamKey);
    if (
      !stream
      || stream.generation !== input.generation
      || stream.hostInstanceId !== input.hostInstanceId
      || (stream.status !== "live" && stream.status !== "closed")
    ) {
      return { status: "conflict", reason: "stream_identity_mismatch" };
    }
    stream.expiresAtMs = Math.max(stream.expiresAtMs ?? 0, input.expiresAtMs);
    if (stream.status === "closed") return { status: "already_closed" };
    stream.status = "closed";
    return { status: "closed" };
  }

  async releaseStreamReservation(input) {
    this.releaseStreamReservationCalls.push(clone(input));
    this.trace.push("lineage.stream.release");
    const configured = this.releaseStreamReservationResults.shift();
    if (configured instanceof Error) throw configured;
    if (configured) return clone(configured);
    const stream = this.streams.get(input.streamKey);
    if (!stream || stream.status === "released") return { status: "already_released" };
    if (stream.generation !== input.generation) {
      return { status: "conflict", reason: "generation_mismatch" };
    }
    stream.status = "released";
    return { status: "released" };
  }
}

function harness(options = {}) {
  const trace = [];
  const backend = new FakeByteBackend(trace);
  const sent = [];
  const drops = [];
  let nextId = 0;
  let nextToken = 0;
  let now = 1_000_000;
  const authority = options.authority ?? new FakeTerminalControl(() => now, trace);
  const resolver = options.resolver ?? new FakeResolver(trace);
  const lineage = options.lineage ?? new FakeDurableLineage(trace);
  const manager = new terminal.RelayV2TerminalManager({
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    hostInstanceId: options.hostInstanceId ?? HOST_INSTANCE_ID,
    resolver,
    lineage,
    backend,
    terminalControl: authority,
    now: () => now,
    issueId: options.issueId ?? (() => `generation-${++nextId}`),
    issueToken: () => `resume-token-${++nextToken}`,
    limits: options.limits,
    send: async (route, frame, responseLineage) => {
      // Every manager output must remain consumable by the frozen production codec.
      codec.encodeRelayV2WebSocketFrame("public", frame);
      if (frame.kind === "event" && frame.type === "terminal.closed") {
        trace.push("terminal.closed.event");
      }
      const dropIndex = drops.findIndex((drop) => (
        drop.type === frame.type && (drop.kind === undefined || drop.kind === frame.kind)
      ));
      if (dropIndex >= 0) {
        drops.splice(dropIndex, 1);
        return;
      }
      sent.push({
        route: clone(route),
        frame: clone(frame),
        responseLineage: responseLineage === undefined ? null : clone(responseLineage),
      });
    },
  });
  return {
    manager,
    backend,
    authority,
    resolver,
    lineage,
    trace,
    sent,
    dropNext(type, kind) {
      drops.push({ type, kind });
    },
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

function goldenOpen(overrides = {}) {
  const frame = clone(fixtures.goldenByName.get("terminal-open-new").frame);
  return {
    auth: clone(AUTH),
    requestId: frame.requestId,
    expectedHostEpoch: frame.expectedHostEpoch,
    target: clone(TARGET),
    pane: frame.payload.pane,
    streamId: frame.streamId,
    openId: frame.payload.openId,
    cols: frame.payload.cols,
    rows: frame.payload.rows,
    mode: frame.payload.mode,
    ...overrides,
    route: exactRoute(overrides.route ?? ROUTE_ONE),
  };
}

function opened(sent, requestId) {
  return sent.find(({ frame }) => (
    frame.type === "terminal.opened" && frame.requestId === requestId
  ))?.frame;
}

function streamContext(openedFrame, route = ROUTE_ONE, overrides = {}) {
  return {
    auth: clone(AUTH),
    route: exactRoute(route),
    streamId: openedFrame.streamId,
    generation: openedFrame.payload.generation,
    ...overrides,
  };
}

function closeRequest(openedFrame, route = ROUTE_ONE, overrides = {}) {
  return {
    auth: clone(AUTH),
    route: exactRoute(route),
    requestId: "close-attempt",
    expectedHostEpoch: HOST_EPOCH,
    target: clone(TARGET),
    streamId: openedFrame.streamId,
    closeId: "logical-close-id",
    generation: openedFrame.payload.generation,
    resumeToken: openedFrame.payload.resumeToken,
    ...overrides,
  };
}

function outputBytes(messages) {
  return Buffer.concat(messages
    .filter(({ frame }) => frame.type === "terminal.output")
    .map(({ frame }) => Buffer.from(frame.payload.data, "base64")));
}

test("durable control quota BUSY is not cached and the same openId can claim after release", async () => {
  const lineage = new FakeDurableLineage();
  lineage.busyClaimOpenOnce = true;
  const h = harness({ lineage });
  const request = goldenOpen({ requestId: "quota-busy-first" });

  await assert.rejects(
    h.manager.open(request),
    (error) => {
      assert.ok(error instanceof terminal.RelayV2TerminalManagerError);
      assert.equal(error.code, "BUSY");
      assert.equal(error.message, "Relay v2 terminal control record quota is full");
      return true;
    },
  );
  assert.equal(lineage.claimOpenCalls.length, 1);
  assert.equal(lineage.completeOpenCalls.length, 0);
  assert.equal(lineage.failOpenCalls.length, 0);
  assert.equal(h.resolver.calls.length, 0);
  assert.equal(h.backend.opens.length, 0);
  assert.equal(h.manager.stats().controlRecords, 0);

  await h.manager.open({ ...request, requestId: "quota-busy-retry" });
  assert.equal(lineage.claimOpenCalls.length, 2);
  assert.equal(h.resolver.calls.length, 1);
  assert.equal(h.backend.opens.length, 1);
  assert.ok(opened(h.sent, "quota-busy-retry"));
});

test("lost open and close responses replay retained control results without duplicating the backend", async () => {
  const h = harness();
  const first = goldenOpen();
  h.dropNext("terminal.opened", "response");
  await h.manager.open(first);
  assert.equal(h.backend.opens.length, 1);
  assert.equal(opened(h.sent, first.requestId), undefined);
  assert.deepEqual(h.trace.slice(0, 3), [
    "resolver.resolve",
    "backend.open",
    "lineage.open.complete",
  ]);
  assert.deepEqual(h.backend.opens[0].options, {
    maxChunkBytes: terminal.RELAY_V2_TERMINAL_MAX_FRAME_BYTES,
    displaySizeHint: { cols: first.cols, rows: first.rows },
  });
  assert.equal(h.authority.acquireCalls.length, 0);
  assert.equal(h.authority.resizeCalls.length, 0);
  h.resolver.resolved = {
    ...h.resolver.resolved,
    canonicalTargetId: "resolver-output-changed-after-response-loss",
    controlTargetId: "control-output-changed-after-response-loss",
  };

  const reboundRoute = { connectorId: "connector-two", routeId: "route-two", routeFence: "fence-two" };
  const retry = { ...first, route: exactRoute(reboundRoute), requestId: "open-retry" };
  await h.manager.open(retry);
  const retryOpened = opened(h.sent, "open-retry");
  assert.ok(retryOpened);
  assert.equal(retryOpened.payload.generation, "generation-1");
  assert.equal(retryOpened.payload.resumeToken, "resume-token-1");
  assert.equal(retryOpened.payload.deduplicated, true);
  assert.equal(h.backend.opens.length, 1);
  assert.equal(h.resolver.calls.length, 1, "exact retry must not re-resolve or refingerprint");
  const durableSnapshot = h.lineage.serializedSnapshot();
  assert.equal(durableSnapshot.includes(retryOpened.payload.resumeToken), false);
  assert.equal(JSON.stringify(h.lineage.completeOpenCalls).includes(retryOpened.payload.resumeToken), false);
  assert.match(h.lineage.completeOpenCalls[0].outcome.resumeTokenHash, /^[0-9a-f]{64}$/);

  h.dropNext("terminal.closed", "response");
  await h.manager.close(closeRequest(retryOpened, reboundRoute));
  assert.equal(h.backend.opens[0].handle.closeCalls, 1);
  assert.equal(h.sent.some(({ frame }) => frame.type === "terminal.closed"), false);
  assert.equal(
    Object.hasOwn(h.lineage.claimCloseCalls[0].intent.requestRoute, "runtimeBindingToken"),
    false,
    "process-local binding tokens must not enter durable lineage",
  );
  assert.deepEqual(
    Reflect.ownKeys(h.lineage.claimCloseCalls[0].intent.requestRoute).sort(),
    ["connectorId", "routeFence", "routeId"],
  );
  assert.equal(h.lineage.serializedSnapshot().includes("runtimeBindingToken"), false);
  assert.equal(
    h.sent.find(({ frame }) => frame.requestId === "open-retry").route.runtimeBindingToken,
    reboundRoute.runtimeBindingToken,
    "the typed in-memory adapter must retain the exact runtime token",
  );

  const closeRetryRoute = { connectorId: "connector-three", routeId: "route-three", routeFence: "fence-three" };
  await h.manager.close(closeRequest(retryOpened, closeRetryRoute, {
    requestId: "close-retry",
  }));
  const closeRetry = h.sent.find(({ frame }) => frame.requestId === "close-retry").frame;
  assert.equal(closeRetry.type, "terminal.closed");
  assert.equal(closeRetry.payload.generation, retryOpened.payload.generation);
  assert.equal(closeRetry.payload.finalOffset, "0");
  assert.equal(closeRetry.payload.reason, "client_closed");
  assert.equal(closeRetry.payload.deduplicated, true);
  assert.equal(h.backend.opens[0].handle.closeCalls, 1);

  h.advance(terminal.RELAY_V2_TERMINAL_DETACHED_LEASE_MS + 1);
  await h.manager.sweep();
  await h.manager.close(closeRequest(retryOpened, closeRetryRoute, {
    requestId: "close-after-ring-expiry",
  }));
  const expiredRingClose = h.sent.find(
    ({ frame }) => frame.requestId === "close-after-ring-expiry",
  ).frame;
  assert.equal(expiredRingClose.payload.replayAvailable, false);
  assert.equal(expiredRingClose.payload.bufferStartOffset, null);

  await assert.rejects(
    h.manager.close(closeRequest(retryOpened, closeRetryRoute, {
      requestId: "close-conflict",
      resumeToken: "different-token",
    })),
    managerError("TERMINAL_CLOSE_CONFLICT"),
  );
});

test("resume emits opened then contiguous raw-byte replay, live output, and final closed", async () => {
  const h = harness();
  const request = goldenOpen();
  await h.manager.open(request);
  const firstOpened = opened(h.sent, request.requestId);
  const handle = h.backend.opens[0].handle;
  const initial = Buffer.from([0xff, 0x00, 0x61, 0xc3, 0x28]);
  await handle.emit(initial);
  await h.manager.acknowledgeOutput({
    ...streamContext(firstOpened),
    nextOffset: String(initial.byteLength),
  });
  await h.manager.unbind(AUTH, ROUTE_ONE);

  const replayed = Buffer.from([0x80, 0x81, 0x0d, 0x0a, 0x7f]);
  await handle.emit(replayed);
  const routeTwo = { connectorId: "connector-two", routeId: "route-two", routeFence: "fence-two" };
  const beforeResume = h.sent.length;
  await h.manager.open(goldenOpen({
    route: routeTwo,
    requestId: "resume-attempt",
    openId: "logical-resume-id",
    mode: "resume",
    resume: {
      generation: firstOpened.payload.generation,
      nextOffset: String(initial.byteLength),
      resumeToken: firstOpened.payload.resumeToken,
    },
  }));
  const live = Buffer.from([0x1b, 0x5b, 0x41, 0xfe]);
  await handle.emit(live);
  await handle.exit("backend_exit", 0);

  const resumed = h.sent.slice(beforeResume).filter(({ route }) => route.routeId === routeTwo.routeId);
  assert.deepEqual(resumed.map(({ frame }) => frame.type), [
    "terminal.opened",
    "terminal.output",
    "terminal.output",
    "terminal.closed",
  ]);
  assert.equal(resumed[0].frame.payload.disposition, "resumed");
  assert.equal(resumed[1].frame.payload.offset, String(initial.byteLength));
  assert.equal(
    resumed[2].frame.payload.offset,
    String(initial.byteLength + replayed.byteLength),
  );
  assert.deepEqual(outputBytes(resumed), Buffer.concat([replayed, live]));
  assert.equal(resumed.at(-1).frame.payload.finalOffset, String(
    initial.byteLength + replayed.byteLength + live.byteLength,
  ));
});

test("route and generation fences reject stale input, and output ACK cannot exceed sent bytes", async () => {
  const h = harness();
  const request = goldenOpen();
  await h.manager.open(request);
  const firstOpened = opened(h.sent, request.requestId);
  await assert.rejects(
    h.manager.acknowledgeOutput({ ...streamContext(firstOpened), nextOffset: "1" }),
    managerError("TERMINAL_INVALID_ACK"),
  );

  const routeTwo = { connectorId: "connector-two", routeId: "route-two", routeFence: "fence-two" };
  await h.manager.open({ ...request, route: exactRoute(routeTwo), requestId: "open-rebind" });
  const rebound = opened(h.sent, "open-rebind");
  await assert.rejects(
    h.manager.input({
      ...streamContext(rebound, {
        ...routeTwo,
        runtimeBindingToken: "forged-runtime-binding-token",
      }),
      inputSeq: "1",
      data: Buffer.from([0x61]),
    }),
    managerError("TERMINAL_ROUTE_STALE"),
  );
  await assert.rejects(
    h.manager.input({
      ...streamContext(rebound, {
        ...routeTwo,
        connectorId: "stale-connector-with-same-route-and-fence",
      }),
      inputSeq: "1",
      data: Buffer.from([0x61]),
    }),
    managerError("TERMINAL_ROUTE_STALE"),
  );
  await assert.rejects(
    h.manager.input({
      ...streamContext(rebound, ROUTE_ONE),
      inputSeq: "1",
      data: Buffer.from([0x61]),
    }),
    managerError("TERMINAL_ROUTE_STALE"),
  );
  await assert.rejects(
    h.manager.input({
      ...streamContext(rebound, routeTwo, { generation: "old-generation" }),
      inputSeq: "1",
      data: Buffer.from([0x61]),
    }),
    managerError("TERMINAL_GENERATION_STALE"),
  );
  assert.equal(h.authority.inputCalls.length, 0);

  await h.manager.input({
    ...streamContext(rebound, routeTwo),
    inputSeq: "1",
    data: Buffer.from([0x61]),
  });
  await h.manager.input({
    ...streamContext(rebound, routeTwo),
    inputSeq: "1",
    data: Buffer.from([0x61]),
  });
  assert.equal(h.authority.inputCalls.length, 1, "same sequence/hash must only re-ACK");

  await h.manager.input({
    ...streamContext(rebound, routeTwo),
    inputSeq: "1",
    data: Buffer.from([0x62]),
  });
  await h.manager.input({
    ...streamContext(rebound, routeTwo),
    inputSeq: "3",
    data: Buffer.from([0x63]),
  });
  const errors = h.sent.filter(({ frame }) => frame.type === "terminal.input_error");
  assert.deepEqual(errors.slice(-2).map(({ frame }) => frame.payload.error.code), [
    "TERMINAL_INPUT_CONFLICT",
    "TERMINAL_INPUT_GAP",
  ]);
  assert.equal(h.authority.inputCalls.length, 1);

  await h.manager.requestReplay({
    auth: clone(AUTH),
    route: routeTwo,
    requestId: "stale-generation-replay",
    expectedHostEpoch: HOST_EPOCH,
    target: clone(TARGET),
    streamId: rebound.streamId,
    generation: "old-generation",
    fromOffset: "0",
  });
  const replayReset = h.sent.find(
    ({ frame }) => frame.requestId === "stale-generation-replay",
  ).frame;
  assert.equal(replayReset.type, "terminal.reset_required");
  assert.equal(replayReset.payload.origin, "replay");
  assert.equal(replayReset.payload.reason, "generation_stale");
});

test("changed connector route releases old control before observer rebind and fresh acquire", async () => {
  const h = harness();
  const request = goldenOpen();
  await h.manager.open(request);
  const first = opened(h.sent, request.requestId);
  await h.manager.input({
    ...streamContext(first),
    inputSeq: "1",
    data: Buffer.from("old-route"),
  });
  const firstOwner = clone(h.authority.acquireCalls[0].owner);
  const firstLease = clone(h.authority.inputCalls[0].lease);

  await h.manager.open({ ...request, requestId: "same-route-exact-retry" });
  assert.equal(h.authority.releaseCalls.length, 0, "same route exact retry keeps its control lease");

  const routeTwo = {
    connectorId: "route-handoff-connector",
    routeId: "route-handoff-route",
    routeFence: "route-handoff-fence",
  };
  await h.manager.open(goldenOpen({
    route: routeTwo,
    requestId: "route-handoff-resume",
    openId: "route-handoff-open",
    mode: "resume",
    resume: {
      generation: first.payload.generation,
      nextOffset: "0",
      resumeToken: first.payload.resumeToken,
    },
  }));
  const resumed = opened(h.sent, "route-handoff-resume");
  assert.equal(h.authority.releaseCalls.length, 1);
  assert.deepEqual(h.authority.releaseCalls[0].owner, firstOwner);
  assert.deepEqual(h.authority.releaseCalls[0].lease, firstLease);
  assert.equal(h.authority.acquireCalls.length, 1, "resume remains observer-only");

  await h.manager.input({
    ...streamContext(resumed, routeTwo),
    inputSeq: "2",
    data: Buffer.from("new-route"),
  });
  assert.equal(h.authority.acquireCalls.length, 2);
  assert.deepEqual(h.authority.acquireCalls[1].owner, firstOwner);
  assert.notEqual(h.authority.inputCalls[1].lease.leaseId, firstLease.leaseId);
});

test("uncertain route release keeps observer replay but fences control until authority converges", async () => {
  const h = harness();
  const request = goldenOpen();
  await h.manager.open(request);
  const first = opened(h.sent, request.requestId);
  await h.manager.input({
    ...streamContext(first),
    inputSeq: "1",
    data: Buffer.from("held-before-route-change"),
  });
  h.authority.releaseResults.push(new Error("release result was lost"));

  const routeTwo = {
    connectorId: "uncertain-release-connector",
    routeId: "uncertain-release-route",
    routeFence: "uncertain-release-fence",
  };
  await h.manager.open(goldenOpen({
    route: routeTwo,
    requestId: "uncertain-release-resume",
    openId: "uncertain-release-open",
    mode: "resume",
    resume: {
      generation: first.payload.generation,
      nextOffset: "0",
      resumeToken: first.payload.resumeToken,
    },
  }));
  const resumed = opened(h.sent, "uncertain-release-resume");
  assert.ok(resumed, "observer rebind still receives terminal.opened");
  await h.backend.opens[0].handle.emit(Buffer.from("observer-output"));
  assert.equal(h.sent.at(-1).frame.type, "terminal.output");

  h.authority.continuityResults.push(new Error("continuity unavailable"));
  await h.manager.input({
    ...streamContext(resumed, routeTwo),
    inputSeq: "2",
    data: Buffer.from("must-not-cross"),
  });
  assert.equal(h.sent.at(-1).frame.type, "terminal.input_error");
  assert.equal(h.sent.at(-1).frame.payload.error.code, "COMMAND_IN_DOUBT");
  assert.equal(h.authority.acquireCalls.length, 1);
  assert.equal(h.authority.inputCalls.length, 1);

  h.authority.continuityResults.push(false);
  await h.manager.input({
    ...streamContext(resumed, routeTwo),
    inputSeq: "2",
    data: Buffer.from("after-convergence"),
  });
  assert.equal(h.authority.acquireCalls.length, 2);
  assert.equal(h.authority.inputCalls.length, 2);
  assert.equal(h.sent.at(-1).frame.type, "terminal.input_ack");
});

test("detached lease expiry fences the generation and exact open retry never creates a second backend", async () => {
  const h = harness();
  const request = goldenOpen();
  await h.manager.open(request);
  await h.manager.unbind(AUTH, ROUTE_ONE);
  h.advance(terminal.RELAY_V2_TERMINAL_DETACHED_LEASE_MS + 1);
  await h.manager.sweep();
  assert.equal(h.backend.opens[0].handle.closeCalls, 1);

  await h.manager.open({
    ...request,
    route: exactRoute({
      connectorId: "connector-after-expiry",
      routeId: "route-after-expiry",
      routeFence: "fence-after-expiry",
    }),
    requestId: "open-after-expiry",
  });
  const reset = h.sent.find(({ frame }) => frame.requestId === "open-after-expiry").frame;
  const resetDelivery = h.sent.find(({ frame }) => frame.requestId === "open-after-expiry");
  assert.equal(reset.type, "terminal.reset_required");
  assert.equal(reset.payload.reason, "stream_lost");
  assert.deepEqual(resetDelivery.responseLineage, {
    owner: "terminal.open",
    requestId: "open-after-expiry",
    openId: request.openId,
    mode: "new",
    generation: reset.payload.generation,
    requestedOffset: "0",
  });
  assert.equal(h.backend.opens.length, 1);
});

test("retention sweep releases the exact durable stream reservation before local deletion", async () => {
  const h = harness();
  const request = goldenOpen({ requestId: "release-before-delete-open" });
  await h.manager.open(request);
  const frame = opened(h.sent, request.requestId);
  await h.manager.close(closeRequest(frame, ROUTE_ONE, {
    requestId: "release-before-delete-close",
  }));

  h.advance(terminal.RELAY_V2_TERMINAL_CONTROL_RETENTION_MS + 1);
  await h.manager.sweep();
  assert.deepEqual(h.lineage.releaseStreamReservationCalls, [{
    streamKey: h.lineage.claimOpenCalls[0].streamKey,
    generation: frame.payload.generation,
    hostInstanceId: HOST_INSTANCE_ID,
  }]);
  assert.equal(h.manager.stats().retainedStreams, 0);
});

test("retention sweep fails closed and retains the stream on release generation mismatch", async () => {
  const h = harness();
  const request = goldenOpen({ requestId: "release-mismatch-open" });
  await h.manager.open(request);
  const frame = opened(h.sent, request.requestId);
  await h.manager.close(closeRequest(frame, ROUTE_ONE, {
    requestId: "release-mismatch-close",
  }));
  h.lineage.releaseStreamReservationResults.push({
    status: "conflict",
    reason: "generation_mismatch",
  });
  h.advance(terminal.RELAY_V2_TERMINAL_CONTROL_RETENTION_MS + 1);

  await assert.rejects(h.manager.sweep(), managerError("INTERNAL"));
  assert.equal(h.manager.stats().retainedStreams, 1);
  assert.equal(h.manager.stats().controlRecords, 0);
  assert.equal(h.lineage.releaseStreamReservationCalls[0].generation, frame.payload.generation);

  await h.manager.sweep();
  assert.equal(h.manager.stats().retainedStreams, 0);
  assert.equal(h.lineage.releaseStreamReservationCalls.length, 2);
});

test("open remains an observer while Feishu holds control and output stays available", async () => {
  const h = harness();
  h.authority.acquireResults.push({
    status: "rejected",
    error: {
      code: "PERMISSION_DENIED",
      message: "terminal input is owned by feishu",
      retryable: false,
      details: null,
    },
  });

  const request = goldenOpen();
  await h.manager.open(request);
  const frame = opened(h.sent, request.requestId);

  assert.deepEqual(h.trace, [
    "resolver.resolve",
    "backend.open",
    "lineage.open.complete",
  ]);
  assert.equal(h.backend.opens.length, 1);
  assert.equal(h.authority.acquireCalls.length, 0, "terminal.open must not acquire control");
  assert.equal(h.authority.resizeCalls.length, 0, "terminal.open size is attachment-local only");
  await h.backend.opens[0].handle.emit(Buffer.from("still-observable"));
  assert.equal(h.sent.at(-1).frame.type, "terminal.output");

  await h.manager.input({
    ...streamContext(frame),
    inputSeq: "1",
    data: Buffer.from("blocked"),
  });
  assert.equal(h.authority.acquireCalls.length, 1);
  assert.equal(h.authority.inputCalls.length, 0);
  assert.equal(h.sent.at(-1).frame.type, "terminal.input_error");
  assert.equal(h.sent.at(-1).frame.payload.error.code, "PERMISSION_DENIED");
  await h.backend.opens[0].handle.emit(Buffer.from("after-reject"));
  assert.equal(h.sent.at(-1).frame.type, "terminal.output");
  assert.equal(h.backend.opens[0].handle.closeCalls, 0);
  await h.manager.input({
    ...streamContext(frame),
    inputSeq: "1",
    data: Buffer.from("blocked"),
  });
  assert.equal(h.authority.acquireCalls.length, 2);
  assert.equal(h.authority.inputCalls.length, 1);
  assert.equal(h.sent.at(-1).frame.type, "terminal.input_ack");
  assert.equal(h.sent.at(-1).frame.payload.ackedThroughInputSeq, "1");
});

test("controller streams keep exact isolated owner identities through acquire, use, and release", async () => {
  const h = harness();
  const firstRequest = goldenOpen({ streamId: "owner-stream-one", openId: "owner-open-one" });
  const routeTwo = {
    connectorId: "owner-connector-two",
    routeId: "owner-route-two",
    routeFence: "owner-fence-two",
  };
  const secondRequest = goldenOpen({
    route: routeTwo,
    requestId: "owner-open-two-attempt",
    streamId: "owner-stream-two",
    openId: "owner-open-two",
  });
  await h.manager.open(firstRequest);
  await h.manager.open(secondRequest);
  const first = opened(h.sent, firstRequest.requestId);
  const second = opened(h.sent, secondRequest.requestId);
  assert.equal(h.authority.acquireCalls.length, 0);

  await h.manager.input({
    ...streamContext(first),
    inputSeq: "1",
    data: Buffer.from("one"),
  });
  await h.manager.resize({
    ...streamContext(second, routeTwo),
    resizeSeq: "1",
    cols: 132,
    rows: 44,
  });
  assert.equal(h.authority.acquireCalls.length, 2);
  const [firstOwner, secondOwner] = h.authority.acquireCalls.map((call) => call.owner);
  assert.equal(firstOwner.kind, "relay-v2");
  assert.equal(secondOwner.kind, "relay-v2");
  assert.notEqual(firstOwner.instanceId, secondOwner.instanceId);
  assert.deepEqual(h.authority.inputCalls[0].owner, firstOwner);
  assert.deepEqual(h.authority.inputCalls[0].lease.owner, firstOwner);
  assert.deepEqual(h.authority.resizeCalls[0].owner, secondOwner);
  assert.deepEqual(h.authority.resizeCalls[0].lease.owner, secondOwner);

  await h.manager.close(closeRequest(first, ROUTE_ONE, {
    closeId: "owner-close-one",
    requestId: "owner-close-one-attempt",
  }));
  await h.manager.unbind(AUTH, routeTwo);
  assert.deepEqual(h.authority.releaseCalls[0].owner, firstOwner);
  assert.deepEqual(h.authority.releaseCalls[0].lease.owner, firstOwner);
  assert.deepEqual(h.authority.releaseCalls[1].owner, secondOwner);
  assert.deepEqual(h.authority.releaseCalls[1].lease.owner, secondOwner);
});

test("uncertain lazy acquire is stream-scoped IN_DOUBT and never retries the pending sequence", async () => {
  const h = harness();
  h.authority.acquireResults.push({
    status: "uncertain",
    error: {
      code: "COMMAND_IN_DOUBT",
      message: "lease acquisition outcome is uncertain",
      retryable: false,
      details: null,
    },
  });
  const request = goldenOpen();
  await h.manager.open(request);
  const frame = opened(h.sent, request.requestId);
  const input = {
    ...streamContext(frame),
    inputSeq: "1",
    data: Buffer.from("maybe"),
  };
  await h.manager.input(input);
  await h.manager.input(input);
  await h.manager.resize({
    ...streamContext(frame),
    resizeSeq: "1",
    cols: 101,
    rows: 31,
  });
  assert.equal(h.authority.acquireCalls.length, 1);
  assert.equal(h.authority.inputCalls.length, 0);
  assert.equal(h.authority.resizeCalls.length, 0);
  const errors = h.sent.filter(({ frame: candidate }) => candidate.type === "terminal.input_error");
  assert.equal(errors.length, 2);
  assert.equal(errors[0].frame.payload.ackedThroughInputSeq, "0");
  assert.equal(errors[0].frame.payload.error.code, "COMMAND_IN_DOUBT");
  assert.equal(errors[0].frame.payload.error.commandDisposition, "in_doubt");
  assert.equal(h.sent.at(-1).frame.type, "terminal.resize_error");
  assert.equal(h.sent.at(-1).frame.payload.error.code, "COMMAND_IN_DOUBT");
});

test("input and resize sequence zero fail protocol without reaching terminal-control", async () => {
  const h = harness();
  const request = goldenOpen();
  await h.manager.open(request);
  const frame = opened(h.sent, request.requestId);

  await assert.rejects(
    h.manager.input({
      ...streamContext(frame),
      inputSeq: "0",
      data: Buffer.from([1]),
    }),
    managerError("INVALID_ARGUMENT"),
  );
  await assert.rejects(
    h.manager.resize({
      ...streamContext(frame),
      resizeSeq: "0",
      cols: 100,
      rows: 30,
    }),
    managerError("INVALID_ARGUMENT"),
  );
  assert.equal(h.authority.inputCalls.length, 0);
  assert.equal(h.authority.resizeCalls.length, 0);
});

test("retained explicit close isolates the old request and replays it for a new route request", async () => {
  const h = harness();
  const request = goldenOpen();
  await h.manager.open(request);
  const firstOpened = opened(h.sent, request.requestId);
  const bytes = Buffer.from([0xff, 0x00, 0x1b, 0x5b, 0x41]);
  await h.backend.opens[0].handle.emit(bytes);

  h.dropNext("terminal.closed", "response");
  await h.manager.close(closeRequest(firstOpened));
  assert.equal(h.backend.opens[0].handle.closeCalls, 1);
  await h.manager.unbind(AUTH, ROUTE_ONE);

  const routeTwo = {
    connectorId: "connector-resume",
    routeId: "route-resume",
    routeFence: "fence-resume",
  };
  const before = h.sent.length;
  await h.manager.open(goldenOpen({
    route: routeTwo,
    requestId: "resume-closed-attempt",
    openId: "resume-closed-open-id",
    mode: "resume",
    resume: {
      generation: firstOpened.payload.generation,
      nextOffset: "0",
      resumeToken: firstOpened.payload.resumeToken,
    },
  }));

  const resumed = h.sent.slice(before);
  assert.deepEqual(resumed.map(({ frame }) => frame.type), [
    "terminal.opened",
    "terminal.output",
  ]);
  assert.deepEqual(outputBytes(resumed), bytes);
  assert.equal(
    h.sent.some(({ frame }) => frame.requestId === "close-attempt"),
    false,
  );

  const resumedOpened = opened(h.sent, "resume-closed-attempt");
  await h.manager.close(closeRequest(resumedOpened, routeTwo, {
    requestId: "close-retry-new-route",
  }));
  const retried = h.sent.find(({ frame }) => frame.requestId === "close-retry-new-route");
  assert.ok(retried);
  assert.deepEqual(retried.route, routeTwo);
  assert.equal(retried.frame.kind, "response");
  assert.equal(retried.frame.payload.deduplicated, true);
  assert.equal(retried.frame.payload.reason, "client_closed");
  assert.equal(retried.frame.payload.exitCode, null);
  assert.equal(retried.frame.payload.finalOffset, String(bytes.byteLength));
  assert.equal(retried.frame.payload.replayAvailable, true);
  assert.equal(h.backend.opens[0].handle.closeCalls, 1);
});

test("lost closed-resume opened response replays the same generation and token without a close slot", async () => {
  const h = harness();
  const request = goldenOpen({ requestId: "closed-resume-loss-source" });
  await h.manager.open(request);
  const first = opened(h.sent, request.requestId);
  await h.manager.close(closeRequest(first, ROUTE_ONE, {
    requestId: "closed-resume-loss-close",
  }));
  assert.equal(h.manager.stats().reservedCloseRecords, 0);

  const routeTwo = {
    connectorId: "closed-resume-loss-connector",
    routeId: "closed-resume-loss-route",
    routeFence: "closed-resume-loss-fence",
  };
  const resume = goldenOpen({
    route: routeTwo,
    requestId: "closed-resume-loss-first",
    openId: "closed-resume-loss-open-id",
    mode: "resume",
    resume: {
      generation: first.payload.generation,
      nextOffset: "0",
      resumeToken: first.payload.resumeToken,
    },
  });
  h.dropNext("terminal.opened", "response");
  await h.manager.open(resume);
  assert.equal(opened(h.sent, resume.requestId), undefined);
  assert.equal(h.manager.stats().reservedCloseRecords, 0);

  await h.manager.open({ ...resume, requestId: "closed-resume-loss-retry" });
  const replay = opened(h.sent, "closed-resume-loss-retry");
  assert.equal(replay.payload.deduplicated, true);
  assert.equal(replay.payload.generation, first.payload.generation);
  assert.equal(replay.payload.resumeToken, first.payload.resumeToken);
  assert.equal(h.backend.opens.length, 1);
  assert.equal(h.backend.opens[0].handle.closeCalls, 1);
  assert.equal(h.manager.stats().reservedCloseRecords, 0);

  await h.manager.close(closeRequest(replay, routeTwo, {
    requestId: "closed-resume-loss-close-retry",
  }));
  const closeRetry = h.sent.find(
    ({ frame }) => frame.requestId === "closed-resume-loss-close-retry",
  )?.frame;
  assert.equal(closeRetry.type, "terminal.closed");
  assert.equal(closeRetry.payload.deduplicated, true);
});

test("stale closed retention clears its ring before absent-authority takeover", async () => {
  const lineage = new FakeDurableLineage();
  const h = harness({ lineage });
  const request = goldenOpen({
    requestId: "stale-closed-source-open",
    streamId: "stale-closed-stream",
    openId: "stale-closed-source-open-id",
  });
  await h.manager.open(request);
  const first = opened(h.sent, request.requestId);
  await h.backend.opens[0].handle.emit(Buffer.from("retained-before-takeover"));
  await h.manager.close(closeRequest(first, ROUTE_ONE, {
    requestId: "stale-closed-source-close",
  }));
  assert.ok(h.manager.stats().ringBytes > 0);

  const streamKey = lineage.claimOpenCalls[0].streamKey;
  lineage.streams.set(streamKey, {
    status: "live",
    generation: "durable-takeover-generation",
    hostInstanceId: HOST_INSTANCE_ID,
    target: clone(TARGET),
    pane: 0,
    resumeTokenHash: resumeTokenHash(first.payload.resumeToken),
  });
  await h.manager.open(goldenOpen({
    requestId: "stale-closed-unavailable-resume",
    streamId: request.streamId,
    openId: "stale-closed-unavailable-open-id",
    mode: "resume",
    resume: {
      generation: "durable-takeover-generation",
      nextOffset: "0",
      resumeToken: first.payload.resumeToken,
    },
  }));
  const unavailable = h.sent.find(
    ({ frame }) => frame.requestId === "stale-closed-unavailable-resume",
  )?.frame;
  assert.equal(unavailable.type, "terminal.reset_required");
  assert.equal(unavailable.payload.reason, "stream_lost");
  assert.equal(h.backend.opens.length, 1);
  assert.equal(h.manager.stats().ringBytes, 0);

  lineage.streams.delete(streamKey);
  await h.manager.open(goldenOpen({
    requestId: "stale-closed-takeover",
    streamId: request.streamId,
    openId: "stale-closed-takeover-open-id",
  }));

  const takeover = opened(h.sent, "stale-closed-takeover");
  assert.ok(takeover);
  assert.notEqual(takeover.payload.generation, first.payload.generation);
  assert.equal(h.backend.opens.length, 2);
  assert.equal(h.backend.opens[0].handle.closeCalls, 1);
  assert.equal(h.manager.stats().ringBytes, 0);
});

test("an invalid reset preserves the exact live generation so it can still be closed", async () => {
  const h = harness();
  const request = goldenOpen({ requestId: "preserved-reset-source-open" });
  await h.manager.open(request);
  const first = opened(h.sent, request.requestId);

  await h.manager.open(goldenOpen({
    requestId: "invalid-reset-attempt",
    openId: "invalid-reset-open-id",
    mode: "reset",
    resume: {
      generation: first.payload.generation,
      nextOffset: "0",
      resumeToken: "invalid-reset-token",
    },
  }));
  const reset = h.sent.find(({ frame }) => frame.requestId === "invalid-reset-attempt")?.frame;
  assert.equal(reset.type, "terminal.reset_required");
  assert.deepEqual(h.lineage.failOpenCalls.at(-1).streamEffect, { kind: "preserve" });
  assert.equal(h.backend.opens.length, 1);
  assert.equal(h.backend.opens[0].handle.closeCalls, 0);

  await h.manager.close(closeRequest(first, ROUTE_ONE, {
    requestId: "close-preserved-reset-source",
  }));
  const closed = h.sent.find(
    ({ frame }) => frame.requestId === "close-preserved-reset-source",
  )?.frame;
  assert.equal(closed.type, "terminal.closed");
  assert.equal(closed.payload.generation, first.payload.generation);
  assert.equal(h.backend.opens[0].handle.closeCalls, 1);
});

test("a reset backend failure retires only the already-fenced previous generation", async () => {
  const h = harness();
  const request = goldenOpen({ requestId: "retire-source-open" });
  await h.manager.open(request);
  const first = opened(h.sent, request.requestId);
  h.backend.openResults.push(new Error("injected replacement backend failure"));

  await h.manager.open(goldenOpen({
    requestId: "retire-reset-attempt",
    openId: "retire-reset-open-id",
    mode: "reset",
    resume: {
      generation: first.payload.generation,
      nextOffset: "0",
      resumeToken: first.payload.resumeToken,
    },
  }));

  assert.equal(h.backend.opens[0].handle.closeCalls, 1);
  assert.deepEqual(h.lineage.failOpenCalls.at(-1).streamEffect, {
    kind: "retire_previous",
    generation: first.payload.generation,
  });
  const reset = h.sent.find(({ frame }) => frame.requestId === "retire-reset-attempt")?.frame;
  assert.equal(reset.type, "terminal.reset_required");
  assert.equal(opened(h.sent, "retire-reset-attempt"), undefined);
});

test("natural-close tombstone query responds on the current request route", async () => {
  const h = harness();
  const request = goldenOpen();
  await h.manager.open(request);
  const frame = opened(h.sent, request.requestId);
  await h.backend.opens[0].handle.emit(Buffer.from([1, 2, 3]));
  await h.backend.opens[0].handle.exit("backend_exit", 7);

  const queryRoute = {
    connectorId: "connector-query",
    routeId: "route-query",
    routeFence: "fence-query",
  };
  await h.manager.close(closeRequest(frame, queryRoute, {
    requestId: "natural-close-query",
  }));
  const response = h.sent.find(({ frame: candidate }) => (
    candidate.requestId === "natural-close-query"
  ));
  assert.deepEqual(response.route, queryRoute);
  assert.equal(response.frame.kind, "response");
  assert.equal(response.frame.payload.reason, "backend_exit");
  assert.equal(response.frame.payload.finalOffset, "3");
});

test("natural backend close durably marks the exact stream before local closed visibility", async () => {
  const h = harness();
  const request = goldenOpen({ requestId: "natural-durable-order-open" });
  await h.manager.open(request);
  const frame = opened(h.sent, request.requestId);
  await h.backend.opens[0].handle.emit(Buffer.from([1, 2, 3]));

  let releaseDurableClose;
  h.lineage.markStreamClosedWait = new Promise((resolve) => {
    releaseDurableClose = resolve;
  });
  const closing = h.backend.opens[0].handle.exit("backend_exit", 7);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(h.lineage.markStreamClosedCalls, [{
    streamKey: h.lineage.claimOpenCalls[0].streamKey,
    generation: frame.payload.generation,
    hostInstanceId: HOST_INSTANCE_ID,
    expiresAtMs: 1_000_000 + terminal.RELAY_V2_TERMINAL_CONTROL_RETENTION_MS,
  }]);
  assert.equal(
    h.sent.some(({ frame: candidate }) => (
      candidate.kind === "event" && candidate.type === "terminal.closed"
    )),
    false,
    "process-local closed replay must wait for the durable transition",
  );

  releaseDurableClose();
  await closing;
  const durableIndex = h.trace.indexOf("lineage.stream.closed");
  const eventIndex = h.trace.indexOf("terminal.closed.event");
  assert.ok(durableIndex >= 0 && durableIndex < eventIndex);
  assert.equal(h.sent.at(-1).frame.type, "terminal.closed");
  assert.equal(h.sent.at(-1).frame.payload.reason, "backend_exit");
  assert.equal(h.sent.at(-1).frame.payload.finalOffset, "3");
});

test("natural backend close failure never exposes a local closed event", async () => {
  const scenarios = [
    new Error("durable close unavailable"),
    { status: "closed", unexpected: true },
    { status: "conflict", reason: "stream_identity_mismatch" },
  ];
  for (const [index, result] of scenarios.entries()) {
    const h = harness();
    const request = goldenOpen({
      requestId: `natural-durable-failure-open-${index}`,
      streamId: `natural-durable-failure-stream-${index}`,
      openId: `natural-durable-failure-open-id-${index}`,
    });
    await h.manager.open(request);
    h.lineage.markStreamClosedResults.push(result);

    await assert.rejects(
      h.backend.opens[0].handle.exit("backend_exit", 0),
      managerError("INTERNAL"),
    );
    assert.equal(h.lineage.markStreamClosedCalls.length, 1);
    assert.equal(
      h.sent.some(({ frame }) => frame.kind === "event" && frame.type === "terminal.closed"),
      false,
    );
    assert.equal(h.manager.stats().liveOrDetachedStreams, 0);
    await h.manager.open({
      ...request,
      requestId: `natural-durable-failure-retry-${index}`,
    });
    const retry = h.sent.find(
      ({ frame }) => frame.requestId === `natural-durable-failure-retry-${index}`,
    )?.frame;
    assert.equal(retry.type, "terminal.reset_required");
    assert.equal(retry.payload.reason, "stream_lost");
    assert.equal(h.backend.opens.length, 1);
  }
});

test("durable close route validation rejects process tokens and every extra key", async () => {
  for (const forbidden of ["runtimeBindingToken", "unexpectedRouteField"]) {
    const lineage = new FakeDurableLineage();
    const first = harness({ lineage });
    const request = goldenOpen({ requestId: `durable-route-open-${forbidden}` });
    await first.manager.open(request);
    const frame = opened(first.sent, request.requestId);
    await first.manager.close(closeRequest(frame));
    const retained = [...lineage.closes.values()][0];
    retained.value.requestRoute[forbidden] = "must-not-survive";

    const restarted = harness({ lineage });
    await assert.rejects(
      restarted.manager.close(closeRequest(frame, {
        connectorId: `durable-route-${forbidden}`,
        routeId: `durable-route-id-${forbidden}`,
        routeFence: `durable-route-fence-${forbidden}`,
      }, {
        requestId: `durable-route-retry-${forbidden}`,
      })),
      managerError("INTERNAL"),
    );
  }
});

test("durable lineage fences process-restart open retry and serves close tombstone", async () => {
  const lineage = new FakeDurableLineage();
  const first = harness({ lineage, hostInstanceId: "host-process-one" });
  const request = goldenOpen();
  await first.manager.open(request);
  const frame = opened(first.sent, request.requestId);
  await first.manager.close(closeRequest(frame));
  await first.manager.shutdown();

  const restarted = harness({ lineage, hostInstanceId: "host-process-two" });
  await restarted.manager.open({ ...request, requestId: "open-after-process-restart" });
  const reset = restarted.sent.find(({ frame: candidate }) => (
    candidate.requestId === "open-after-process-restart"
  )).frame;
  assert.equal(reset.type, "terminal.reset_required");
  assert.equal(reset.payload.reason, "stream_lost");
  assert.equal(restarted.backend.opens.length, 0);
  assert.equal(restarted.resolver.calls.length, 0);

  const queryRoute = {
    connectorId: "connector-after-restart",
    routeId: "route-after-restart",
    routeFence: "fence-after-restart",
  };
  await restarted.manager.close(closeRequest(frame, queryRoute, {
    requestId: "close-after-process-restart",
  }));
  const close = restarted.sent.find(({ frame: candidate }) => (
    candidate.requestId === "close-after-process-restart"
  ));
  assert.deepEqual(close.route, queryRoute);
  assert.equal(close.frame.payload.deduplicated, true);
  assert.equal(close.frame.payload.replayAvailable, false);
  assert.equal(close.frame.payload.reason, "client_closed");
});

test("restart-like reset retires only an exact durable binding before admitting a replacement", async () => {
  const lineage = new FakeDurableLineage();
  const first = harness({ lineage, hostInstanceId: "restart-retire-host-one" });
  const request = goldenOpen({
    requestId: "restart-retire-source-open",
    streamId: "restart-retire-stream",
    openId: "restart-retire-source-open-id",
  });
  await first.manager.open(request);
  const source = opened(first.sent, request.requestId);
  const streamKey = lineage.claimOpenCalls[0].streamKey;

  let restartedGeneration = 0;
  const restarted = harness({
    lineage,
    hostInstanceId: "restart-retire-host-two",
    issueId: () => `restart-retire-generation-${++restartedGeneration}`,
  });
  const exactResume = {
    generation: source.payload.generation,
    nextOffset: "0",
    resumeToken: source.payload.resumeToken,
  };
  const wrongResumeSecret = "private-capability-not-used-by-any-request-identity";
  const mismatches = [
    {
      name: "target",
      overrides: { target: { ...clone(TARGET), sessionId: "ses_wrong_target" } },
      expectedTokenHash: resumeTokenHash(source.payload.resumeToken),
    },
    {
      name: "pane",
      overrides: { pane: 1 },
      expectedTokenHash: resumeTokenHash(source.payload.resumeToken),
    },
    {
      name: "token",
      overrides: {
        resume: { ...exactResume, resumeToken: wrongResumeSecret },
      },
      expectedTokenHash: resumeTokenHash(wrongResumeSecret),
    },
  ];
  for (const mismatch of mismatches) {
    const attempt = goldenOpen({
      requestId: `restart-retire-wrong-${mismatch.name}`,
      streamId: request.streamId,
      openId: `restart-retire-wrong-${mismatch.name}-open-id`,
      mode: "reset",
      resume: exactResume,
      ...mismatch.overrides,
    });
    await restarted.manager.open(attempt);
    const reset = restarted.sent.find(
      ({ frame }) => frame.requestId === attempt.requestId,
    )?.frame;
    assert.equal(reset.type, "terminal.reset_required");
    assert.equal(reset.payload.reason, "stream_lost");
    assert.deepEqual(lineage.failOpenCalls.at(-1).streamEffect, { kind: "preserve" });
    assert.equal(lineage.streams.get(streamKey).status, "live");
    assert.equal(restarted.resolver.calls.length, 0);
    assert.equal(restarted.backend.opens.length, 0);

    const claim = lineage.claimOpenCalls.at(-1);
    assert.deepEqual(claim.target, attempt.target);
    assert.equal(claim.pane, attempt.pane);
    assert.equal(claim.resumeTokenHash, mismatch.expectedTokenHash);
    assert.equal(Object.hasOwn(claim, "resumeToken"), false);
    assert.equal(JSON.stringify(claim).includes(attempt.resume.resumeToken), false);
  }

  await assert.rejects(
    restarted.manager.open(goldenOpen({
      requestId: "restart-retire-new-before-exact",
      streamId: request.streamId,
      openId: "restart-retire-new-before-exact-open-id",
    })),
    managerError("TERMINAL_STREAM_CONFLICT"),
  );
  assert.equal(lineage.streams.get(streamKey).status, "live");
  assert.equal(restarted.backend.opens.length, 0);

  const exactAttempt = goldenOpen({
    requestId: "restart-retire-exact-reset",
    streamId: request.streamId,
    openId: "restart-retire-exact-reset-open-id",
    mode: "reset",
    resume: exactResume,
  });
  await restarted.manager.open(exactAttempt);

  const reset = restarted.sent.find(
    ({ frame }) => frame.requestId === exactAttempt.requestId,
  )?.frame;
  assert.equal(reset.type, "terminal.reset_required");
  assert.equal(reset.payload.reason, "stream_lost");
  assert.deepEqual(lineage.failOpenCalls.at(-1).streamEffect, {
    kind: "retire_previous",
    generation: source.payload.generation,
  });
  assert.equal(lineage.streams.get(streamKey).status, "released");
  assert.equal(restarted.resolver.calls.length, 0);
  assert.equal(restarted.backend.opens.length, 0);

  const replacement = goldenOpen({
    requestId: "restart-retire-new-after-exact",
    streamId: request.streamId,
    openId: "restart-retire-new-after-exact-open-id",
  });
  await restarted.manager.open(replacement);
  assert.ok(opened(restarted.sent, replacement.requestId));
  assert.equal(restarted.backend.opens.length, 1);
});

test("durable open claims every mode and retains fingerprints and reset outcomes across restart", async () => {
  const lineage = new FakeDurableLineage();
  const first = harness({ lineage, hostInstanceId: "durable-host-one" });
  const newRequest = goldenOpen({ openId: "durable-new-open" });
  await first.manager.open(newRequest);
  const initial = opened(first.sent, newRequest.requestId);
  await first.manager.open(goldenOpen({
    requestId: "durable-resume-attempt",
    openId: "durable-resume-open",
    mode: "resume",
    resume: {
      generation: initial.payload.generation,
      nextOffset: "0",
      resumeToken: initial.payload.resumeToken,
    },
  }));
  const resumed = opened(first.sent, "durable-resume-attempt");
  await first.manager.open(goldenOpen({
    requestId: "durable-reset-attempt",
    openId: "durable-reset-open",
    mode: "reset",
    resume: {
      generation: resumed.payload.generation,
      nextOffset: "0",
      resumeToken: resumed.payload.resumeToken,
    },
  }));
  assert.deepEqual(lineage.claimOpenCalls.map((claim) => claim.mode), ["new", "resume", "reset"]);
  assert.deepEqual(
    lineage.claimOpenCalls.map(({ target, pane, resumeTokenHash: hash }) => ({
      target,
      pane,
      resumeTokenHash: hash,
    })),
    [
      { target: TARGET, pane: 0, resumeTokenHash: null },
      { target: TARGET, pane: 0, resumeTokenHash: resumeTokenHash(initial.payload.resumeToken) },
      { target: TARGET, pane: 0, resumeTokenHash: resumeTokenHash(resumed.payload.resumeToken) },
    ],
  );
  assert.equal(
    lineage.claimOpenCalls.some((claim) => Object.hasOwn(claim, "resumeToken")),
    false,
  );
  assert.equal(
    JSON.stringify(lineage.claimOpenCalls).includes(initial.payload.resumeToken),
    false,
  );
  assert.equal(lineage.completeOpenCalls.length, 3);

  const restarted = harness({ lineage, hostInstanceId: "durable-host-two" });
  await assert.rejects(
    restarted.manager.open({
      ...newRequest,
      requestId: "durable-conflicting-retry",
      cols: newRequest.cols + 1,
    }),
    managerError("TERMINAL_OPEN_CONFLICT"),
  );
  assert.equal(restarted.backend.opens.length, 0);

  const missingLineage = new FakeDurableLineage();
  const missing = harness({ lineage: missingLineage, hostInstanceId: "missing-host-one" });
  const missingResume = goldenOpen({
    requestId: "missing-resume-attempt",
    streamId: "missing-stream",
    openId: "missing-resume-open",
    mode: "resume",
    resume: {
      generation: "missing-generation",
      nextOffset: "7",
      resumeToken: "missing-resume-token",
    },
  });
  await missing.manager.open(missingResume);
  assert.equal(missing.sent.at(-1).frame.payload.reason, "stream_lost");
  const missingRestarted = harness({
    lineage: missingLineage,
    hostInstanceId: "missing-host-two",
  });
  await missingRestarted.manager.open({
    ...missingResume,
    requestId: "missing-resume-retry",
  });
  assert.equal(missingRestarted.sent.at(-1).frame.payload.reason, "stream_lost");
  assert.equal(missingRestarted.resolver.calls.length, 0);
  assert.equal(missingRestarted.backend.opens.length, 0);
});

test("absent durable authority fences an unregistered local backend and fails INTERNAL", async () => {
  const lineage = new FakeDurableLineage();
  const h = harness({ lineage });
  const request = goldenOpen({ requestId: "authority-divergence-source" });
  await h.manager.open(request);
  const first = opened(h.sent, request.requestId);
  const streamKey = lineage.claimOpenCalls[0].streamKey;
  lineage.streams.delete(streamKey);
  const resume = goldenOpen({
    requestId: "authority-divergence-resume",
    openId: "authority-divergence-open-id",
    mode: "resume",
    resume: {
      generation: first.payload.generation,
      nextOffset: "0",
      resumeToken: first.payload.resumeToken,
    },
  });

  await assert.rejects(h.manager.open(resume), managerError("INTERNAL"));
  assert.equal(h.backend.opens[0].handle.closeCalls, 1);
  assert.equal(opened(h.sent, resume.requestId), undefined);
  assert.equal(
    h.sent.some(({ frame }) => frame.requestId === resume.requestId),
    false,
    "authority divergence must not become a normal reset response",
  );
  assert.deepEqual(lineage.failOpenCalls.at(-1).streamEffect, { kind: "preserve" });
  assert.equal(h.manager.stats().liveOrDetachedStreams, 0);
  await assert.rejects(
    h.manager.input({
      ...streamContext(first),
      inputSeq: "1",
      data: Buffer.from("must-stay-fenced"),
    }),
    managerError("TERMINAL_STREAM_NOT_FOUND"),
  );
});

test("generation mismatch exposes watermarks only from the exact durable source", async () => {
  const lineage = new FakeDurableLineage();
  const h = harness({ lineage, hostInstanceId: "watermark-source-instance" });
  const request = goldenOpen({ requestId: "watermark-source-open" });
  await h.manager.open(request);
  const first = opened(h.sent, request.requestId);
  const restarted = harness({ lineage, hostInstanceId: "watermark-source-instance" });

  await restarted.manager.open(goldenOpen({
    requestId: "watermark-mismatch-resume",
    openId: "watermark-mismatch-open-id",
    mode: "resume",
    resume: {
      generation: "stale-request-generation",
      nextOffset: "0",
      resumeToken: first.payload.resumeToken,
    },
  }));
  const reset = restarted.sent.find(
    ({ frame }) => frame.requestId === "watermark-mismatch-resume",
  )?.frame;
  assert.equal(reset.type, "terminal.reset_required");
  assert.equal(reset.payload.reason, "generation_stale");
  assert.equal(reset.payload.bufferStartOffset, null);
  assert.equal(reset.payload.tailOffset, null);
  assert.equal(restarted.backend.opens.length, 0);
});

test("claimed durable authority divergence fences the local backend before INTERNAL", async () => {
  for (const scenario of [
    {
      name: "generation",
      authority: { generation: "durable-other-generation" },
      requestGeneration: "durable-other-generation",
    },
    { name: "status", authority: { status: "closed" } },
    {
      name: "target",
      authority: { target: { ...clone(TARGET), sessionId: "ses_durable_other" } },
    },
    { name: "pane", authority: { pane: 1 } },
    {
      name: "token",
      authority: { resumeTokenHash: resumeTokenHash("durable-other-resume-token") },
    },
  ]) {
    const lineage = new FakeDurableLineage();
    const h = harness({ lineage });
    const request = goldenOpen({
      requestId: `claimed-${scenario.name}-source`,
      streamId: `claimed-${scenario.name}-stream`,
      openId: `claimed-${scenario.name}-source-open`,
    });
    await h.manager.open(request);
    const first = opened(h.sent, request.requestId);
    const streamKey = lineage.claimOpenCalls[0].streamKey;
    lineage.streams.set(streamKey, {
      status: "live",
      generation: first.payload.generation,
      hostInstanceId: HOST_INSTANCE_ID,
      target: clone(TARGET),
      pane: 0,
      resumeTokenHash: resumeTokenHash(first.payload.resumeToken),
      ...scenario.authority,
    });
    const resume = goldenOpen({
      requestId: `claimed-${scenario.name}-resume`,
      streamId: request.streamId,
      openId: `claimed-${scenario.name}-resume-open`,
      mode: "resume",
      resume: {
        generation: scenario.requestGeneration ?? first.payload.generation,
        nextOffset: "0",
        resumeToken: first.payload.resumeToken,
      },
    });

    await assert.rejects(h.manager.open(resume), managerError("INTERNAL"));
    assert.equal(h.backend.opens[0].handle.closeCalls, 1);
    await assert.rejects(
      h.manager.input({
        ...streamContext(first),
        inputSeq: "1",
        data: Buffer.from("fenced-after-divergence"),
      }),
      managerError("TERMINAL_STREAM_NOT_FOUND"),
    );
    assert.equal(h.authority.inputCalls.length, 0);

    h.advance(terminal.RELAY_V2_TERMINAL_CONTROL_RETENTION_MS + 1);
    await h.manager.sweep();
    assert.equal(h.lineage.releaseStreamReservationCalls.length, 0);
    assert.equal(h.manager.stats().retainedStreams, 0);
    assert.equal(h.manager.stats().ringBytes, 0);
  }
});

test("claimed or replayed generation divergence drops a previously lost local stream without release", async () => {
  for (const kind of ["claimed", "replay"]) {
    const lineage = new FakeDurableLineage();
    const h = harness({ lineage });
    const request = goldenOpen({
      requestId: `lost-divergence-${kind}-source`,
      streamId: `lost-divergence-${kind}-stream`,
      openId: `lost-divergence-${kind}-source-open-id`,
    });
    await h.manager.open(request);
    const first = opened(h.sent, request.requestId);
    await h.manager.unbind(AUTH, ROUTE_ONE);
    h.advance(terminal.RELAY_V2_TERMINAL_DETACHED_LEASE_MS + 1);
    await h.manager.sweep();
    assert.equal(h.backend.opens[0].handle.closeCalls, 1);
    assert.equal(h.manager.stats().retainedStreams, 1);

    const firstClaim = lineage.claimOpenCalls[0];
    lineage.streams.set(firstClaim.streamKey, {
      status: "live",
      generation: `durable-${kind}-generation-b`,
      hostInstanceId: HOST_INSTANCE_ID,
      target: clone(TARGET),
      pane: 0,
      resumeTokenHash: resumeTokenHash(first.payload.resumeToken),
    });
    let attempt;
    if (kind === "claimed") {
      attempt = goldenOpen({
        requestId: "lost-divergence-claimed-attempt",
        streamId: request.streamId,
        openId: "lost-divergence-claimed-open-id",
        mode: "resume",
        resume: {
          generation: "durable-claimed-generation-b",
          nextOffset: "0",
          resumeToken: first.payload.resumeToken,
        },
      });
    } else {
      const retained = lineage.opens.get(firstClaim.key);
      retained.outcome.generation = "durable-replay-generation-b";
      attempt = { ...request, requestId: "lost-divergence-replay-attempt" };
    }

    await h.manager.open(attempt);
    const reset = h.sent.find(({ frame }) => frame.requestId === attempt.requestId)?.frame;
    assert.equal(reset.type, "terminal.reset_required");
    assert.equal(reset.payload.reason, "stream_lost");
    assert.equal(h.manager.stats().retainedStreams, 0);
    assert.equal(h.manager.stats().ringBytes, 0);

    h.advance(terminal.RELAY_V2_TERMINAL_CONTROL_RETENTION_MS + 1);
    await h.manager.sweep();
    assert.equal(lineage.releaseStreamReservationCalls.length, 0);
    assert.equal(h.manager.stats().retainedStreams, 0);
    assert.equal(h.manager.stats().ringBytes, 0);
  }
});

test("durable opened replay mismatch fences its local backend instead of emitting reset", async () => {
  const lineage = new FakeDurableLineage();
  const h = harness({ lineage });
  const request = goldenOpen({ requestId: "opened-replay-divergence-source" });
  await h.manager.open(request);
  const first = opened(h.sent, request.requestId);
  const record = lineage.opens.get(lineage.claimOpenCalls[0].key);
  record.outcome.generation = "durable-replayed-other-generation";

  await assert.rejects(
    h.manager.open({ ...request, requestId: "opened-replay-divergence-retry" }),
    managerError("INTERNAL"),
  );
  assert.equal(h.backend.opens[0].handle.closeCalls, 1);
  assert.equal(
    h.sent.some(({ frame }) => frame.requestId === "opened-replay-divergence-retry"),
    false,
  );
  await assert.rejects(
    h.manager.input({
      ...streamContext(first),
      inputSeq: "1",
      data: Buffer.from("must-not-reach-old-backend"),
    }),
    managerError("TERMINAL_STREAM_NOT_FOUND"),
  );
  assert.equal(h.authority.inputCalls.length, 0);
});

test("durable open conflicts are atomic across same-process and restart retries", async () => {
  const lineage = new FakeDurableLineage();
  const first = harness({ lineage, hostInstanceId: "cas-host-one" });
  const request = goldenOpen({ streamId: "cas-stream", openId: "cas-open-one" });
  await first.manager.open(request);
  const completedBeforeConflicts = lineage.completeOpenCalls.length;
  const failedBeforeConflicts = lineage.failOpenCalls.length;

  await assert.rejects(
    first.manager.open(goldenOpen({
      requestId: "cas-same-stream-new-open",
      streamId: request.streamId,
      openId: "cas-open-two",
    })),
    managerError("TERMINAL_STREAM_CONFLICT"),
  );
  assert.equal(lineage.completeOpenCalls.length, completedBeforeConflicts);
  assert.equal(lineage.failOpenCalls.length, failedBeforeConflicts);
  assert.equal(first.backend.opens.length, 1);

  await assert.rejects(
    first.manager.open({
      ...request,
      requestId: "cas-same-open-different-fingerprint",
      rows: request.rows + 1,
    }),
    managerError("TERMINAL_OPEN_CONFLICT"),
  );
  const restarted = harness({ lineage, hostInstanceId: "cas-host-two" });
  await assert.rejects(
    restarted.manager.open({
      ...request,
      requestId: "cas-restart-different-fingerprint",
      cols: request.cols + 1,
    }),
    managerError("TERMINAL_OPEN_CONFLICT"),
  );
  assert.equal(restarted.backend.opens.length, 0);
});

test("provisional generation loses every replayed CAS winner without publishing a ghost stream", async () => {
  const cases = [
    {
      name: "reset",
      winner: {
        kind: "reset",
        generation: "winner-reset-generation",
        reason: "stream_lost",
        requestedOffset: null,
        bufferStartOffset: null,
        tailOffset: null,
      },
      expectedCode: undefined,
      activeWinner: false,
    },
    {
      name: "error",
      winner: {
        kind: "error",
        code: "BUSY",
        message: "durable winner rejected admission",
      },
      expectedCode: "BUSY",
      activeWinner: false,
    },
    {
      name: "opened",
      winner: {
        kind: "opened",
        generation: "winner-opened-generation",
        resumeTokenHash: createHash("sha256").update("resume-token-1").digest("hex"),
        disposition: "new",
        replayFromOffset: "0",
      },
      expectedCode: undefined,
      activeWinner: true,
    },
  ];

  for (const scenario of cases) {
    const lineage = new FakeDurableLineage();
    lineage.completeOpenReplayOutcome = scenario.winner;
    const h = harness({ lineage, hostInstanceId: `loser-host-${scenario.name}` });
    const request = goldenOpen({
      requestId: `loser-${scenario.name}-attempt`,
      streamId: `loser-stream-${scenario.name}`,
      openId: `loser-open-${scenario.name}`,
    });
    if (scenario.expectedCode) {
      await assert.rejects(h.manager.open(request), managerError(scenario.expectedCode));
    } else {
      await h.manager.open(request);
      const reset = h.sent.find(({ frame }) => frame.requestId === request.requestId).frame;
      assert.equal(reset.type, "terminal.reset_required");
      assert.equal(reset.payload.reason, "stream_lost");
    }
    const handle = h.backend.opens[0].handle;
    assert.equal(handle.closeCalls, 1);
    assert.deepEqual(h.manager.stats(), {
      liveOrDetachedStreams: 0,
      retainedStreams: 0,
      controlRecords: 0,
      reservedCloseRecords: 0,
      controlSlots: 0,
      ringBytes: 0,
      pausedBackends: 0,
    });
    const sentBeforeLateCallback = h.sent.length;
    await handle.emit(Buffer.from("late-provisional-output"));
    await handle.exit("backend_exit", 0);
    assert.equal(h.sent.length, sentBeforeLateCallback, "late provisional callbacks stay fenced");

    if (scenario.expectedCode) {
      await assert.rejects(
        h.manager.open({ ...request, requestId: `loser-${scenario.name}-exact-retry` }),
        managerError(scenario.expectedCode),
      );
    } else {
      await h.manager.open({ ...request, requestId: `loser-${scenario.name}-exact-retry` });
      assert.equal(h.sent.at(-1).frame.type, "terminal.reset_required");
    }
    assert.equal(h.backend.opens.length, 1, "durable winner replay never allocates another backend");

    const nextOpen = goldenOpen({
      requestId: `loser-${scenario.name}-next-open`,
      streamId: request.streamId,
      openId: `loser-${scenario.name}-next-open-id`,
    });
    if (scenario.activeWinner) {
      await assert.rejects(h.manager.open(nextOpen), managerError("TERMINAL_STREAM_CONFLICT"));
      assert.equal(h.backend.opens.length, 1);
    } else {
      await h.manager.open(nextOpen);
      assert.ok(opened(h.sent, nextOpen.requestId));
      assert.equal(h.backend.opens.length, 2);
    }
  }
});

test("generation reuse rejection destroys the provisional reset and exactly retires its source claim", async () => {
  const lineage = new FakeDurableLineage();
  const h = harness({ lineage });
  const request = goldenOpen({ requestId: "generation-reuse-source-open" });
  await h.manager.open(request);
  const first = opened(h.sent, request.requestId);
  lineage.rejectGenerationReuseOnce = true;
  const resetRequest = goldenOpen({
    requestId: "generation-reuse-reset",
    openId: "generation-reuse-reset-open-id",
    mode: "reset",
    resume: {
      generation: first.payload.generation,
      nextOffset: "0",
      resumeToken: first.payload.resumeToken,
    },
  });

  await assert.rejects(h.manager.open(resetRequest), managerError("INTERNAL"));
  assert.equal(h.backend.opens.length, 2);
  assert.equal(h.backend.opens[0].handle.closeCalls, 1);
  assert.equal(h.backend.opens[1].handle.closeCalls, 1);
  assert.equal(opened(h.sent, resetRequest.requestId), undefined);
  assert.deepEqual(lineage.failOpenCalls.at(-1).streamEffect, {
    kind: "retire_previous",
    generation: first.payload.generation,
  });
  const durableReset = lineage.opens.get(lineage.failOpenCalls.at(-1).key);
  assert.equal(durableReset.state, "final", "the rejected completion must not leave a pending claim");
  assert.equal(lineage.streams.values().next().value.status, "released");
  assert.equal(h.manager.stats().controlRecords, 1, "the rejected reset must not enter local cache");
  assert.equal(h.manager.stats().reservedCloseRecords, 0);

  h.advance(terminal.RELAY_V2_TERMINAL_CONTROL_RETENTION_MS + 1);
  await h.manager.sweep();
  assert.equal(h.manager.stats().retainedStreams, 0);
  assert.equal(lineage.releaseStreamReservationCalls.at(-1).generation, first.payload.generation);
});

test("pending resume and reset claims recover their generation and requested offset after restart", async () => {
  const resumeLineage = new FakeDurableLineage();
  resumeLineage.failFailOpenOnce = true;
  const resumeFirst = harness({ lineage: resumeLineage, hostInstanceId: "pending-resume-host-one" });
  const resumeRequest = goldenOpen({
    requestId: "pending-resume-attempt",
    streamId: "pending-resume-stream",
    openId: "pending-resume-open",
    mode: "resume",
    resume: {
      generation: "pending-resume-generation",
      nextOffset: "17",
      resumeToken: "pending-resume-secret",
    },
  });
  await assert.rejects(resumeFirst.manager.open(resumeRequest), /injected crash/);
  const resumeRestarted = harness({
    lineage: resumeLineage,
    hostInstanceId: "pending-resume-host-two",
  });
  await resumeRestarted.manager.open({
    ...resumeRequest,
    requestId: "pending-resume-restart",
  });
  const resumedReset = resumeRestarted.sent.at(-1).frame;
  assert.equal(resumedReset.type, "terminal.reset_required");
  assert.equal(resumedReset.payload.reason, "stream_lost");
  assert.equal(resumedReset.payload.generation, "pending-resume-generation");
  assert.equal(resumedReset.payload.requestedOffset, "17");
  assert.equal(resumeRestarted.backend.opens.length, 0);

  const resetLineage = new FakeDurableLineage();
  resetLineage.failCompleteOpenOnce = true;
  const resetFirst = harness({ lineage: resetLineage, hostInstanceId: "pending-reset-host-one" });
  const resetRequest = goldenOpen({
    requestId: "pending-reset-attempt",
    streamId: "pending-reset-stream",
    openId: "pending-reset-open",
    mode: "reset",
    resume: {
      generation: "pending-reset-generation",
      nextOffset: "23",
      resumeToken: "pending-reset-secret",
    },
  });
  await assert.rejects(resetFirst.manager.open(resetRequest), /injected crash/);
  assert.equal(resetFirst.backend.opens[0].handle.closeCalls, 1);
  assert.equal(resetFirst.manager.stats().retainedStreams, 0);
  const resetRestarted = harness({
    lineage: resetLineage,
    hostInstanceId: "pending-reset-host-two",
  });
  await resetRestarted.manager.open({
    ...resetRequest,
    requestId: "pending-reset-restart",
  });
  const resetRequired = resetRestarted.sent.at(-1).frame;
  assert.equal(resetRequired.type, "terminal.reset_required");
  assert.equal(resetRequired.payload.reason, "stream_lost");
  assert.equal(resetRequired.payload.generation, "pending-reset-generation");
  assert.equal(resetRequired.payload.requestedOffset, "23");
  assert.equal(resetRestarted.backend.opens.length, 0);
  assert.equal(resetLineage.serializedSnapshot().includes("pending-reset-secret"), false);
});

test("explicit close intent is durable before cleanup and a failed finalization converges once", async () => {
  const h = harness();
  const request = goldenOpen();
  await h.manager.open(request);
  const frame = opened(h.sent, request.requestId);
  await h.manager.input({
    ...streamContext(frame),
    inputSeq: "1",
    data: Buffer.from("owned"),
  });
  h.lineage.failFinalizeOnce = true;
  await assert.rejects(h.manager.close(closeRequest(frame)), /injected crash/);
  assert.equal(h.backend.opens[0].handle.closeCalls, 1);
  assert.equal(h.authority.releaseCalls.length, 1);
  await h.backend.opens[0].handle.exit("backend_exit", 0);
  assert.equal(h.lineage.markStreamClosedCalls.length, 0);
  const claimIndex = h.trace.indexOf("lineage.close.claim");
  const releaseIndex = h.trace.indexOf("control.release", claimIndex);
  const closeIndex = h.trace.indexOf("backend.close", releaseIndex);
  const finalizeIndex = h.trace.indexOf("lineage.close.finalize", closeIndex);
  assert.ok(claimIndex >= 0 && claimIndex < releaseIndex);
  assert.ok(releaseIndex < closeIndex && closeIndex < finalizeIndex);

  const recoveryRoute = {
    connectorId: "close-recovery-connector",
    routeId: "close-recovery-route",
    routeFence: "close-recovery-fence",
  };
  await h.manager.close(closeRequest(frame, recoveryRoute, {
    requestId: "close-recovery-attempt",
  }));
  assert.equal(h.backend.opens[0].handle.closeCalls, 1);
  assert.equal(h.authority.releaseCalls.length, 1);
  assert.equal(h.lineage.claimCloseCalls.length, 2);
  assert.equal(h.lineage.finalizeCloseCalls.length, 2);
  const response = h.sent.find(({ frame: candidate }) => candidate.requestId === "close-recovery-attempt");
  assert.deepEqual(response.route, recoveryRoute);
  assert.equal(response.frame.payload.deduplicated, true);
});

test("credit-blocked close survives rebind and same close retry responds on the new connector route", async () => {
  const h = harness({
    limits: {
      streamRingBytes: 16,
      hostRingBytes: 32,
      maxUnackedBytes: 4,
      maxFrameBytes: 4,
    },
  });
  const request = goldenOpen();
  await h.manager.open(request);
  const first = opened(h.sent, request.requestId);
  await h.backend.opens[0].handle.emit(Buffer.from([1, 2, 3, 4]));
  await h.backend.opens[0].handle.emit(Buffer.from([5, 6, 7, 8]));
  await h.manager.close(closeRequest(first));
  assert.equal(
    h.sent.some(({ frame }) => frame.type === "terminal.closed"),
    false,
    "close response must wait until all output frames are sent",
  );
  await h.manager.unbind(AUTH, ROUTE_ONE);

  const routeTwo = {
    connectorId: "credit-close-connector-two",
    routeId: "credit-close-route-two",
    routeFence: "credit-close-fence-two",
  };
  await h.manager.open(goldenOpen({
    route: routeTwo,
    requestId: "credit-close-resume",
    openId: "credit-close-resume-open",
    mode: "resume",
    resume: {
      generation: first.payload.generation,
      nextOffset: "0",
      resumeToken: first.payload.resumeToken,
    },
  }));
  await h.manager.close(closeRequest(first, routeTwo, {
    requestId: "credit-close-retry",
  }));
  assert.equal(
    h.sent.some(({ frame }) => frame.requestId === "credit-close-retry"),
    false,
  );
  const resumed = opened(h.sent, "credit-close-resume");
  await h.manager.acknowledgeOutput({
    ...streamContext(resumed, routeTwo),
    nextOffset: "4",
  });
  const retry = h.sent.find(({ frame }) => frame.requestId === "credit-close-retry");
  assert.ok(retry);
  assert.deepEqual(retry.route, routeTwo);
  assert.equal(retry.frame.kind, "response");
  assert.equal(retry.frame.payload.finalOffset, "8");
  assert.equal(retry.frame.payload.deduplicated, true);
  assert.equal(
    h.sent.some(({ frame }) => frame.kind === "event"
      && frame.type === "terminal.closed"
      && frame.payload.reason === "client_closed"),
    false,
  );
  assert.equal(h.backend.opens[0].handle.closeCalls, 1);
});

test("an uncertain input remains generation-bound and is never applied to a reset backend", async () => {
  const h = harness();
  h.authority.inputResults.push({
    accepted: false,
    uncertain: true,
    error: {
      code: "INTERNAL",
      message: "terminal-control result is uncertain",
      retryable: true,
      details: null,
    },
  });
  const request = goldenOpen();
  await h.manager.open(request);
  const firstOpened = opened(h.sent, request.requestId);
  const oldInput = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  await h.manager.input({
    ...streamContext(firstOpened),
    inputSeq: "1",
    data: oldInput,
  });
  assert.equal(h.authority.inputCalls.length, 1);
  assert.equal(h.sent.at(-1).frame.type, "terminal.input_error");

  const routeTwo = { connectorId: "connector-two", routeId: "route-two", routeFence: "fence-two" };
  const resetRequest = goldenOpen({
    route: routeTwo,
    requestId: "reset-attempt",
    openId: "logical-reset-id",
    mode: "reset",
    resume: {
      generation: firstOpened.payload.generation,
      nextOffset: "0",
      resumeToken: firstOpened.payload.resumeToken,
    },
  });
  await h.manager.open(resetRequest);
  const resetOpened = opened(h.sent, "reset-attempt");
  assert.equal(resetOpened.payload.disposition, "reset");
  assert.notEqual(resetOpened.payload.generation, firstOpened.payload.generation);
  assert.equal(h.backend.opens.length, 2);
  assert.equal(h.backend.opens[0].handle.closeCalls, 1);

  await h.manager.open({ ...resetRequest, requestId: "reset-retry" });
  const resetRetry = opened(h.sent, "reset-retry");
  assert.equal(resetRetry.payload.deduplicated, true);
  assert.equal(resetRetry.payload.generation, resetOpened.payload.generation);
  assert.equal(h.backend.opens.length, 2);

  await assert.rejects(
    h.manager.input({
      ...streamContext(firstOpened, routeTwo),
      inputSeq: "1",
      data: oldInput,
    }),
    managerError("TERMINAL_GENERATION_STALE"),
  );
  assert.equal(h.authority.inputCalls.length, 1);

  const newInput = Buffer.from([0x01, 0x02]);
  await h.manager.input({
    ...streamContext(resetOpened, routeTwo),
    inputSeq: "1",
    data: newInput,
  });
  assert.equal(h.authority.inputCalls.length, 2);
  assert.deepEqual(h.authority.inputCalls[1].data, newInput);
  assert.notDeepEqual(h.authority.inputCalls[1].data, oldInput);
  assert.match(h.authority.inputCalls[0].operationId, /generation-1:input:1$/);
  assert.match(h.authority.inputCalls[1].operationId, /generation-2:input:1$/);
});

test("producer lease detach clears pending windows, renews, and continuity loss fences writes", async () => {
  const h = harness();
  const request = goldenOpen();
  await h.manager.open(request);
  const frame = opened(h.sent, request.requestId);
  await h.manager.input({
    ...streamContext(frame),
    inputSeq: "1",
    data: Buffer.from("one"),
  });
  h.authority.inputResults.push({
    accepted: false,
    uncertain: true,
    error: {
      code: "INTERNAL",
      message: "write boundary uncertain",
      retryable: true,
      details: null,
    },
  });
  await h.manager.input({
    ...streamContext(frame),
    inputSeq: "2",
    data: Buffer.from("old-pending"),
  });
  assert.equal(h.authority.inputCalls.length, 2);

  await h.manager.unbind(AUTH, ROUTE_ONE);
  assert.equal(h.authority.releaseCalls.length, 0, "uncertain write already fenced the local lease");
  const routeTwo = {
    connectorId: "connector-lease-two",
    routeId: "route-lease-two",
    routeFence: "fence-lease-two",
  };
  await h.manager.open(goldenOpen({
    route: routeTwo,
    requestId: "lease-resume-attempt",
    openId: "lease-resume-open",
    mode: "resume",
    resume: {
      generation: frame.payload.generation,
      nextOffset: "0",
      resumeToken: frame.payload.resumeToken,
    },
  }));
  const resumed = opened(h.sent, "lease-resume-attempt");
  assert.equal(h.authority.acquireCalls.length, 1, "resume must remain observer-only");

  await h.manager.input({
    ...streamContext(resumed, routeTwo),
    inputSeq: "1",
    data: Buffer.from("different-acked-prefix"),
  });
  assert.equal(h.authority.inputCalls.length, 2, "cleared ACK prefix must not be replayed");
  await h.manager.input({
    ...streamContext(resumed, routeTwo),
    inputSeq: "2",
    data: Buffer.from("new-owner-retry"),
  });
  assert.equal(h.authority.inputCalls.length, 3, "cleared pending entry may retry on new lease");
  assert.equal(h.authority.acquireCalls.length, 2);
  assert.notEqual(
    h.authority.inputCalls[1].lease.leaseId,
    h.authority.inputCalls[2].lease.leaseId,
  );

  h.advance(30_001);
  await h.manager.sweep();
  assert.equal(h.authority.renewCalls.length, 1);
  h.authority.continuous = false;
  await h.manager.input({
    ...streamContext(resumed, routeTwo),
    inputSeq: "3",
    data: Buffer.from("must-not-write"),
  });
  assert.equal(h.authority.inputCalls.length, 3);
  assert.equal(h.backend.opens[0].handle.closeCalls, 0);
  assert.equal(h.sent.at(-1).frame.type, "terminal.input_error");
  assert.equal(h.sent.at(-1).frame.payload.error.code, "PERMISSION_DENIED");
});

test("renewal cannot rotate epoch, lease, fence, or owner identity", async () => {
  const h = harness();
  const request = goldenOpen();
  await h.manager.open(request);
  const frame = opened(h.sent, request.requestId);
  await h.manager.input({
    ...streamContext(frame),
    inputSeq: "1",
    data: Buffer.from("first"),
  });
  const current = clone(h.authority.inputCalls[0].lease);
  h.advance(30_001);
  h.authority.renewResults.push({
    status: "accepted",
    lease: {
      ...current,
      controlEpoch: "unexpected-control-epoch",
      leaseId: "unexpected-lease-id",
      fence: "unexpected-fence",
      expiresAt: new Date(1_000_000 + 90_001).toISOString(),
    },
  });
  await h.manager.input({
    ...streamContext(frame),
    inputSeq: "2",
    data: Buffer.from("must-not-write"),
  });
  assert.equal(h.authority.renewCalls.length, 1);
  assert.equal(h.authority.inputCalls.length, 1);
  assert.equal(h.sent.at(-1).frame.type, "terminal.input_error");
  assert.equal(h.sent.at(-1).frame.payload.error.code, "PERMISSION_DENIED");
  assert.equal(h.authority.releaseCalls.length, 1);
  assert.deepEqual(h.authority.releaseCalls[0].lease, current);
  await h.backend.opens[0].handle.emit(Buffer.from("observer-still-live"));
  assert.equal(h.sent.at(-1).frame.type, "terminal.output");
  assert.equal(h.backend.opens[0].handle.closeCalls, 0);
});

test("authority details and backend close reason are runtime-allowlisted before output", async () => {
  const invalidAuthority = harness();
  const request = goldenOpen();
  await invalidAuthority.manager.open(request);
  const frame = opened(invalidAuthority.sent, request.requestId);
  invalidAuthority.authority.inputResults.push({
    accepted: false,
    uncertain: false,
    error: {
      code: "INTERNAL",
      message: "poisoned details",
      retryable: false,
      details: { untrusted: true },
    },
  });
  await invalidAuthority.manager.input({
    ...streamContext(frame),
    inputSeq: "1",
    data: Buffer.from([1]),
  });
  assert.equal(
    invalidAuthority.sent.some(({ frame: candidate }) => candidate.type === "terminal.input_error"),
    true,
  );
  assert.equal(invalidAuthority.sent.at(-1).frame.payload.error.code, "COMMAND_IN_DOUBT");
  assert.equal(invalidAuthority.sent.at(-1).frame.payload.error.commandDisposition, "in_doubt");
  assert.equal(invalidAuthority.backend.opens[0].handle.closeCalls, 0);

  const invalidDomain = harness();
  const domainRequest = goldenOpen({ requestId: "invalid-domain-open" });
  await invalidDomain.manager.open(domainRequest);
  const domainFrame = opened(invalidDomain.sent, domainRequest.requestId);
  invalidDomain.authority.inputResults.push({
    accepted: false,
    uncertain: false,
    error: {
      code: "TERMINAL_RESIZE_GAP",
      message: "wrong operation domain",
      retryable: true,
      details: null,
    },
  });
  await invalidDomain.manager.input({
    ...streamContext(domainFrame),
    inputSeq: "1",
    data: Buffer.from([2]),
  });
  assert.equal(
    invalidDomain.sent.some(({ frame: candidate }) => candidate.type === "terminal.input_error"),
    true,
  );
  assert.equal(invalidDomain.sent.at(-1).frame.payload.error.code, "COMMAND_IN_DOUBT");

  const invalidClose = harness();
  const secondRequest = goldenOpen({ requestId: "invalid-close-open" });
  await invalidClose.manager.open(secondRequest);
  await invalidClose.backend.opens[0].handle.exit("client_closed", 123);
  const closed = invalidClose.sent.at(-1).frame;
  assert.equal(closed.type, "terminal.closed");
  assert.equal(closed.payload.reason, "backend_error");
  assert.equal(closed.payload.exitCode, null);
});

test("cumulative input and resize windows evict only ACKed prefixes and never repeat old effects", async () => {
  const h = harness({
    limits: {
      streamRingBytes: 16,
      hostRingBytes: 32,
      maxUnackedBytes: 8,
      maxFrameBytes: 4,
      inputDedupeEntries: 2,
      resizeDedupeEntries: 2,
    },
  });
  const request = goldenOpen();
  await h.manager.open(request);
  const frame = opened(h.sent, request.requestId);
  for (let seq = 1; seq <= 3; seq += 1) {
    await h.manager.input({
      ...streamContext(frame),
      inputSeq: String(seq),
      data: Buffer.from([seq]),
    });
    await h.manager.resize({
      ...streamContext(frame),
      resizeSeq: String(seq),
      cols: 100 + seq,
      rows: 30 + seq,
    });
  }
  assert.equal(h.authority.inputCalls.length, 3);
  assert.equal(h.authority.resizeCalls.length, 3);

  await h.manager.input({
    ...streamContext(frame),
    inputSeq: "1",
    data: Buffer.from([0xff]),
  });
  await h.manager.resize({
    ...streamContext(frame),
    resizeSeq: "1",
    cols: 999,
    rows: 499,
  });
  assert.equal(h.authority.inputCalls.length, 3);
  assert.equal(h.authority.resizeCalls.length, 3);
  assert.equal(h.sent.at(-2).frame.type, "terminal.input_ack");
  assert.equal(h.sent.at(-2).frame.payload.ackedThroughInputSeq, "3");
  assert.equal(h.sent.at(-1).frame.type, "terminal.resize_ack");
  assert.equal(h.sent.at(-1).frame.payload.ackedThroughResizeSeq, "3");
});

test("ACK reclaim and host high/low watermarks resume paused backends within hard credit", async () => {
  const limits = {
    streamRingBytes: 8,
    hostRingBytes: 12,
    maxUnackedBytes: 4,
    maxFrameBytes: 4,
    maxStreams: 2,
    maxControlRecords: 8,
  };
  const h = harness({ limits });
  const firstRequest = goldenOpen({ streamId: "pressure-one", openId: "pressure-open-one" });
  await h.manager.open(firstRequest);
  const first = opened(h.sent, firstRequest.requestId);
  const routeTwo = {
    connectorId: "connector-pressure-two",
    routeId: "route-pressure-two",
    routeFence: "fence-pressure-two",
  };
  const secondRequest = goldenOpen({
    route: routeTwo,
    requestId: "pressure-open-two-attempt",
    streamId: "pressure-two",
    openId: "pressure-open-two",
  });
  await h.manager.open(secondRequest);
  const second = opened(h.sent, secondRequest.requestId);

  const firstHandle = h.backend.opens[0].handle;
  const secondHandle = h.backend.opens[1].handle;
  await firstHandle.emit(Buffer.from([1, 2, 3, 4]));
  await firstHandle.emit(Buffer.from([5, 6, 7, 8]));
  assert.equal(firstHandle.pauseCalls, 1, "stream high water pauses at its hard ring bound");
  await secondHandle.emit(Buffer.from([9, 10, 11, 12]));
  assert.equal(secondHandle.pauseCalls, 1, "host high water pauses a stream below its own bound");
  assert.equal(h.manager.stats().ringBytes, limits.hostRingBytes);
  const secondOutput = h.sent.filter(({ frame }) => (
    frame.type === "terminal.output" && frame.streamId === second.streamId
  ));
  assert.equal(outputBytes(secondOutput).byteLength, limits.maxUnackedBytes);

  await h.manager.acknowledgeOutput({
    ...streamContext(second, routeTwo),
    nextOffset: "4",
  });
  assert.equal(h.manager.stats().ringBytes, 8, "ACK must reclaim the retained prefix");
  assert.equal(secondHandle.resumeCalls, 1, "host low water must resume an eligible backend");
  await h.manager.acknowledgeOutput({
    ...streamContext(first),
    nextOffset: "4",
  });
  assert.equal(firstHandle.resumeCalls, 1, "stream low water must recover from pause");
  assert.ok(h.manager.stats().ringBytes <= limits.hostRingBytes);
});

test("oversize backend callback is rejected before byte copying and cannot grow the ring", async () => {
  const h = harness({
    limits: {
      streamRingBytes: 8,
      hostRingBytes: 16,
      maxUnackedBytes: 4,
      maxFrameBytes: 4,
    },
  });
  await h.manager.open(goldenOpen());
  const raw = new Proxy({}, {
    get(_target, property) {
      if (property === "byteLength") return 5;
      throw new Error(`oversize callback was inspected through ${String(property)}`);
    },
  });
  await h.backend.opens[0].handle.emitRaw(raw);
  assert.equal(h.manager.stats().ringBytes, 0);
  assert.equal(h.backend.opens[0].handle.closeCalls, 1);
  assert.equal(h.sent.at(-1).frame.type, "terminal.reset_required");
  assert.equal(h.sent.at(-1).frame.payload.reason, "stream_lost");
});

test("ring, stream, and control pressure remain bounded and return explicit reset or BUSY", async () => {
  const limits = {
    streamRingBytes: 8,
    hostRingBytes: 12,
    maxUnackedBytes: 4,
    maxFrameBytes: 4,
    maxStreams: 2,
    maxControlRecords: 6,
  };
  const h = harness({ limits });
  const firstRequest = goldenOpen({ streamId: "stream-one", openId: "open-one" });
  await h.manager.open(firstRequest);
  const firstOpened = opened(h.sent, firstRequest.requestId);
  const firstHandle = h.backend.opens[0].handle;
  await firstHandle.emit(Buffer.from([1, 2, 3, 4]));
  await h.manager.acknowledgeOutput({ ...streamContext(firstOpened), nextOffset: "4" });
  await firstHandle.emit(Buffer.from([5, 6, 7, 8]));
  await h.manager.acknowledgeOutput({ ...streamContext(firstOpened), nextOffset: "8" });
  await h.manager.unbind(AUTH, ROUTE_ONE);

  const secondRoute = { connectorId: "connector-two", routeId: "route-two", routeFence: "fence-two" };
  const secondRequest = goldenOpen({
    route: secondRoute,
    requestId: "open-two-attempt",
    streamId: "stream-two",
    openId: "open-two",
  });
  await h.manager.open(secondRequest);
  const secondOpened = opened(h.sent, secondRequest.requestId);
  const secondHandle = h.backend.opens[1].handle;
  await secondHandle.emit(Buffer.from([9, 10, 11, 12]));
  await secondHandle.emit(Buffer.from([13, 14, 15, 16]));
  assert.ok(h.manager.stats().ringBytes <= limits.hostRingBytes);

  await h.manager.open(goldenOpen({
    route: { connectorId: "connector-three", routeId: "route-three", routeFence: "fence-three" },
    requestId: "resume-evicted",
    streamId: "stream-one",
    openId: "resume-evicted-open",
    mode: "resume",
    resume: {
      generation: firstOpened.payload.generation,
      nextOffset: "0",
      resumeToken: firstOpened.payload.resumeToken,
    },
  }));
  const reset = h.sent.find(({ frame }) => frame.requestId === "resume-evicted").frame;
  assert.equal(reset.type, "terminal.reset_required");
  assert.equal(reset.payload.reason, "offset_expired");
  assert.equal(reset.payload.bufferStartOffset, "8");

  await assert.rejects(
    h.manager.open(goldenOpen({
      requestId: "open-three-attempt",
      streamId: "stream-three",
      openId: "open-three",
    })),
    managerError("BUSY"),
  );
  assert.equal(h.backend.opens.length, 2, "quota rejection must happen before backend.open");

  await h.manager.acknowledgeOutput({
    ...streamContext(secondOpened, secondRoute),
    nextOffset: "4",
  });
  await h.manager.acknowledgeOutput({
    ...streamContext(secondOpened, secondRoute),
    nextOffset: "8",
  });
  await secondHandle.emit(Buffer.from([17, 18, 19, 20]));
  await secondHandle.emit(Buffer.from([21, 22, 23, 24]));
  await secondHandle.emit(Buffer.from([25, 26, 27, 28]));
  assert.equal(h.sent.at(-1).frame.type, "terminal.reset_required");
  assert.equal(h.sent.at(-1).frame.payload.reason, "slow_consumer");
  assert.equal(secondHandle.closeCalls, 1);
  assert.ok(h.manager.stats().ringBytes <= limits.hostRingBytes);
});

test("live stream admission is enforced before allocating a byte backend", async () => {
  const h = harness({
    limits: {
      streamRingBytes: 8,
      hostRingBytes: 16,
      maxUnackedBytes: 4,
      maxFrameBytes: 4,
      maxStreams: 1,
      maxControlRecords: 10,
    },
  });
  await h.manager.open(goldenOpen({ streamId: "stream-one", openId: "open-one" }));
  await assert.rejects(
    h.manager.open(goldenOpen({
      requestId: "open-two",
      streamId: "stream-two",
      openId: "open-two",
    })),
    managerError("BUSY"),
  );
  assert.equal(h.backend.opens.length, 1);
});

test("control admission reserves close tombstones before opening or resetting a backend", async () => {
  const h = harness({
    limits: {
      streamRingBytes: 8,
      hostRingBytes: 16,
      maxUnackedBytes: 4,
      maxFrameBytes: 4,
      maxStreams: 2,
      maxControlRecords: 3,
    },
  });
  const request = goldenOpen();
  await h.manager.open(request);
  let current = opened(h.sent, request.requestId);
  assert.equal(h.manager.stats().controlSlots, 2);

  const firstReset = goldenOpen({
    requestId: "reset-one",
    openId: "reset-open-one",
    mode: "reset",
    resume: {
      generation: current.payload.generation,
      nextOffset: "0",
      resumeToken: current.payload.resumeToken,
    },
  });
  await h.manager.open(firstReset);
  current = opened(h.sent, "reset-one");
  assert.equal(h.manager.stats().controlSlots, 3);
  assert.equal(h.backend.opens.length, 2);

  await h.manager.open({ ...firstReset, requestId: "reset-one-replay-at-capacity" });
  const replay = opened(h.sent, "reset-one-replay-at-capacity");
  assert.equal(replay.payload.deduplicated, true);
  assert.equal(replay.payload.generation, current.payload.generation);
  assert.equal(h.backend.opens.length, 2, "durable replay must precede local capacity checks");

  await assert.rejects(
    h.manager.open(goldenOpen({
      requestId: "reset-two",
      openId: "reset-open-two",
      mode: "reset",
      resume: {
        generation: current.payload.generation,
        nextOffset: "0",
        resumeToken: current.payload.resumeToken,
      },
    })),
    managerError("BUSY"),
  );
  assert.equal(h.backend.opens.length, 2);
  assert.equal(h.manager.stats().controlSlots, 3);
});
