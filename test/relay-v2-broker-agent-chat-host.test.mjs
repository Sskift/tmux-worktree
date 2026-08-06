import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const chatCodec = await import("../dist/relay/extensions/agentChat/v1/codec.js");
const { createRelayAgentChatHostExtension } = await import(
  "../dist/relay/extensions/agentChat/v1/hostExtension.js"
);

const HOST_ID = "mac-admin";
const HOST_EPOCH = randomUUID();
const SESSION_ID = "scope-local:worktrees";

function fakeSink() {
  const publishes = [];
  let ready = null;
  return {
    get ready() {
      return ready;
    },
    publishes,
    apply(value) {
      ready = value;
      return true;
    },
    async publish(delivery) {
      publishes.push(delivery);
    },
    close() {},
  };
}

function stubEngine() {
  const calls = [];
  let turnsBySession = new Map();
  const engine = {
    startOrSteerTurn: async (session, message, callbacks = {}) => {
      calls.push({ kind: "send", session, message });
      const turnId = `turn-${calls.length}`;
      if (callbacks.onEvent) {
        callbacks.onEvent({
          turnId,
          session,
          userMessage: message,
          status: "working",
          sentAt: "2026-08-06T00:00:00.000Z",
        });
        callbacks.onEvent({
          turnId,
          session,
          userMessage: message,
          status: "replied",
          reply: "Here are the worktrees.",
          sentAt: "2026-08-06T00:00:00.000Z",
          completedAt: "2026-08-06T00:00:01.000Z",
        });
      }
      return { turnId };
    },
    listTurns: (session, limit) => {
      calls.push({ kind: "history", session, limit });
      const turns = turnsBySession.get(session) ?? [];
      const sliced = limit === undefined ? turns : turns.slice(-limit);
      return sliced.map((entry) => ({
        turnId: entry.turnId,
        session: entry.session,
        userMessage: entry.userMessage,
        status: entry.status,
        reply: entry.reply,
        sentAt: entry.sentAt,
        completedAt: entry.completedAt,
      }));
    },
    disposeSession: () => {},
  };
  return {
    engine,
    calls,
    seed(session, entries) {
      turnsBySession = new Map([[session, entries]]);
      engine.listTurns = (target, limit) => {
        calls.push({ kind: "history", session: target, limit });
        const turns = turnsBySession.get(target) ?? [];
        const sliced = limit === undefined ? turns : turns.slice(-limit);
        return sliced.map((entry) => ({
          turnId: entry.turnId,
          session: entry.session,
          userMessage: entry.userMessage,
          status: entry.status,
          reply: entry.reply,
          sentAt: entry.sentAt,
          completedAt: entry.completedAt,
        }));
      };
    },
  };
}

function chatSendFrame(requestId = "req-send", message = "list current worktrees") {
  return {
    protocolVersion: 2,
    kind: "request",
    type: "agent.chat.send",
    requestId,
    hostId: HOST_ID,
    expectedHostEpoch: HOST_EPOCH,
    scopeId: "scope-local",
    sessionId: SESSION_ID,
    payload: { session: SESSION_ID, message },
  };
}

test("agent.chat.v1 host attachment advertises, inspects, and bridges to the engine", async () => {
  const { engine, calls } = stubEngine();
  const sink = fakeSink();
  const extension = createRelayAgentChatHostExtension({
    engine,
    hostId: HOST_ID,
    hostEpoch: () => HOST_EPOCH,
  });
  assert.equal(extension.capability, "agent.chat.v1");

  const subscription = extension.subscribe(sink);
  assert.equal(sink.ready, true, "synchronously applies ready before subscribe returns");

  const requestBytes = chatCodec.encodeRelayAgentChatFrame(chatSendFrame());
  const descriptor = extension.inspectRequest(requestBytes, { opcode: "text", compressed: false });
  assert.deepEqual(descriptor, {
    requestId: "req-send",
    hostId: HOST_ID,
    expectedHostEpoch: HOST_EPOCH,
    scopeId: "scope-local",
    sessionId: SESSION_ID,
  });

  const context = {
    principalId: "client-principal",
    clientInstanceId: "android-install",
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    scopeId: "scope-local",
    sessionId: SESSION_ID,
  };
  assert.equal(await extension.authorize(context), true);

  const delivery = await extension.handleRequest(requestBytes, { opcode: "text", compressed: false }, context);
  const sentFrame = delivery.frame;
  assert.equal(sentFrame.type, "agent.chat.sent");
  assert.equal(sentFrame.requestId, "req-send");
  assert.equal(sentFrame.scopeId, "scope-local");
  assert.equal(sentFrame.sessionId, SESSION_ID);
  assert.equal(typeof sentFrame.payload.turnId, "string");
  assert.deepEqual(Buffer.from(delivery.bytes), Buffer.from(JSON.stringify(sentFrame)));
  assert.deepEqual(calls[0], { kind: "send", session: SESSION_ID, message: "list current worktrees" });

  // The engine's onEvent callbacks publish two normalized events (working/replied).
  assert.equal(sink.publishes.length, 2);
  for (const event of sink.publishes) {
    assert.equal(event.frame.type, "agent.chat.event");
    assert.equal(event.frame.scopeId, "scope-local");
    assert.equal(event.frame.sessionId, SESSION_ID);
    const roundTrip = chatCodec.decodeRelayAgentChatFrame(event.bytes);
    assert.equal(roundTrip.canonicalWire, JSON.stringify(event.frame));
  }
  const working = sink.publishes[0].frame.payload.turn;
  assert.equal(working.status, "working");
  assert.equal(working.reply, null);
  assert.equal(working.completedAt, null);
  const replied = sink.publishes[1].frame.payload.turn;
  assert.equal(replied.status, "replied");
  assert.equal(replied.reply, "Here are the worktrees.");
  assert.equal(replied.completedAt, "2026-08-06T00:00:01.000Z");

  subscription.unsubscribe();
  assert.equal(await extension.closeAndDrain(), undefined);
});

test("agent.chat.v1 host attachment serves history from the reused engine", async () => {
  const { engine, calls, seed } = stubEngine();
  const sink = fakeSink();
  const extension = createRelayAgentChatHostExtension({
    engine,
    hostId: HOST_ID,
    hostEpoch: () => HOST_EPOCH,
  });
  extension.subscribe(sink);
  seed(SESSION_ID, [
    {
      turnId: "turn-a",
      session: SESSION_ID,
      userMessage: "first",
      status: "replied",
      reply: "ok",
      sentAt: "2026-08-06T00:00:00.000Z",
      completedAt: "2026-08-06T00:00:01.000Z",
    },
    {
      turnId: "turn-b",
      session: SESSION_ID,
      userMessage: "second",
      status: "working",
      sentAt: "2026-08-06T00:00:02.000Z",
    },
  ]);
  const historyFrame = {
    protocolVersion: 2,
    kind: "request",
    type: "agent.chat.history",
    requestId: "req-history",
    hostId: HOST_ID,
    expectedHostEpoch: HOST_EPOCH,
    scopeId: "scope-local",
    sessionId: SESSION_ID,
    payload: { session: SESSION_ID, limit: 1 },
  };
  const context = {
    principalId: "client-principal",
    clientInstanceId: "android-install",
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    scopeId: "scope-local",
    sessionId: SESSION_ID,
  };
  const delivery = await extension.handleRequest(
    chatCodec.encodeRelayAgentChatFrame(historyFrame),
    { opcode: "text", compressed: false },
    context,
  );
  assert.equal(delivery.frame.type, "agent.chat.history.result");
  assert.equal(delivery.frame.requestId, "req-history");
  assert.deepEqual(calls[0], { kind: "history", session: SESSION_ID, limit: 1 });
  assert.equal(delivery.frame.payload.turns.length, 1);
  const turn = delivery.frame.payload.turns[0];
  assert.equal(turn.turnId, "turn-b");
  assert.equal(turn.status, "working");
  assert.equal(turn.reply, null);
  assert.equal(turn.completedAt, null);
  assert.equal(turn.steeredMessages, null);
});

test("agent.chat.v1 host attachment unavailable path is pure and isolated", async () => {
  const { engine } = stubEngine();
  const sink = fakeSink();
  const extension = createRelayAgentChatHostExtension({
    engine,
    hostId: HOST_ID,
    hostEpoch: () => HOST_EPOCH,
  });
  extension.subscribe(sink);
  const context = {
    principalId: "client-principal",
    clientInstanceId: "android-install",
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    scopeId: "scope-local",
    sessionId: SESSION_ID,
  };
  const delivery = extension.handleUnavailableRequest(
    chatCodec.encodeRelayAgentChatFrame(chatSendFrame("req-u", "hi")),
    { opcode: "text", compressed: false },
    context,
  );
  assert.equal(delivery.frame.type, "error");
  assert.equal(delivery.frame.requestId, "req-u");
  assert.equal(delivery.frame.error.code, "AGENT_CHAT_UNAVAILABLE");
  assert.equal(delivery.frame.error.commandDisposition, "not_applicable");
  assert.equal(delivery.frame.error.retryable, true);

  extension.isolateFailure(new Error("boom"));
  assert.equal(await extension.authorize(context), false, "failure isolates the attachment");
  await extension.closeAndDrain();
  const before = sink.publishes.length;
  const ext2 = createRelayAgentChatHostExtension({
    engine,
    hostId: HOST_ID,
    hostEpoch: () => HOST_EPOCH,
  });
  ext2.subscribe(sink);
  await ext2.closeAndDrain();
  assert.equal(sink.publishes.length, before, "closed attachment publishes nothing");
});
