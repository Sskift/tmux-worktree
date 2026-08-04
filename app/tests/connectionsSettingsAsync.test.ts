import assert from "node:assert/strict";
import test from "node:test";
import {
  createConnectionsAsyncCoordinator,
  hostCatalogFingerprint,
} from "../src/dashboard/Settings/connectionsAsyncCoordinator.ts";
import type { HostConfig } from "../src/platform/domainTypes.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("switching from Host A to Host B publishes A's committed list without A editor feedback", async () => {
  const coordinator = createConnectionsAsyncCoordinator();
  const hostAResponse = deferred<readonly string[]>();
  const hostBResponse = deferred<string>();
  const publishedLists: Array<readonly string[]> = [];
  const publishedNotices: string[] = [];
  const publishedEditors: string[] = [];

  const saveA = async () => {
    const feedbackRequest = coordinator.issue("hostFeedback", "save", "host-a");
    const catalogRequest = coordinator.issue("hostCatalog", "save", "host-a");
    const hosts = await hostAResponse.promise;
    if (coordinator.isCurrent(catalogRequest)) publishedLists.push(hosts);
    if (!coordinator.isCurrent(feedbackRequest)) return;
    publishedEditors.push("host-a");
    publishedNotices.push("Host A saved");
  };
  const testB = async () => {
    const request = coordinator.issue("hostFeedback", "test", "host-b");
    const message = await hostBResponse.promise;
    if (!coordinator.isCurrent(request)) return;
    publishedNotices.push(message);
  };

  const pendingSaveA = saveA();
  coordinator.invalidate("hostFeedback"); // select Host B
  const pendingTestB = testB();
  hostBResponse.resolve("Host B connected");
  await pendingTestB;
  hostAResponse.resolve(["host-a", "authoritative-host-list"]);
  await pendingSaveA;

  assert.deepEqual(publishedLists, [["host-a", "authoritative-host-list"]]);
  assert.deepEqual(publishedEditors, []);
  assert.deepEqual(publishedNotices, ["Host B connected"]);
});

test("a later operation on the same Host owns success and failure feedback", async () => {
  const coordinator = createConnectionsAsyncCoordinator();
  const firstTest = deferred<string>();
  const laterInstall = deferred<string>();
  const published: string[] = [];

  const publish = async (intent: string, response: Promise<string>) => {
    const request = coordinator.issue("hostFeedback", intent, "host-a");
    try {
      const message = await response;
      if (coordinator.isCurrent(request)) published.push(message);
    } catch (error) {
      if (coordinator.isCurrent(request)) published.push(String(error));
    }
  };

  const stale = publish("test", firstTest.promise);
  const latest = publish("install", laterInstall.promise);
  laterInstall.resolve("tw installed");
  await latest;
  firstTest.reject(new Error("late SSH failure"));
  await stale;

  assert.deepEqual(published, ["tw installed"]);
});

test("a genuine external Host catalog change invalidates an in-flight full-list response", async () => {
  const coordinator = createConnectionsAsyncCoordinator();
  const initialHosts: HostConfig[] = [
    { id: "host-a", label: "Host A", host: "a.internal" },
    { id: "host-b", label: "Host B", host: "b.internal" },
  ];
  const sameHostsFromAnotherRender = initialHosts.map((host) => ({ ...host }));
  const externallyUpdatedHosts = [
    ...sameHostsFromAnotherRender,
    { id: "host-c", label: "Host C", host: "c.internal" },
  ];
  const staleSave = deferred<HostConfig[]>();
  const publishedLists: HostConfig[][] = [];

  let currentFingerprint = hostCatalogFingerprint(initialHosts);
  const request = coordinator.issue("hostCatalog", "save", "host-a", currentFingerprint);
  const publishSave = staleSave.promise.then((hosts) => {
    if (coordinator.isCurrent(request)) publishedLists.push(hosts);
  });

  const equivalentFingerprint = hostCatalogFingerprint(sameHostsFromAnotherRender);
  assert.equal(equivalentFingerprint, currentFingerprint);
  assert.equal(coordinator.isCurrent(request), true, "equivalent props are not a catalog revision");

  const externalFingerprint = hostCatalogFingerprint(externallyUpdatedHosts);
  assert.notEqual(externalFingerprint, currentFingerprint);
  currentFingerprint = externalFingerprint;
  coordinator.invalidate("hostCatalog");

  staleSave.resolve(initialHosts);
  await publishSave;
  assert.deepEqual(publishedLists, []);
});

test("a later save or delete owns the authoritative Host list", async () => {
  const coordinator = createConnectionsAsyncCoordinator();
  const olderSave = deferred<readonly string[]>();
  const laterDelete = deferred<readonly string[]>();
  const publishedLists: Array<readonly string[]> = [];

  const publishMutation = async (
    intent: "save" | "delete",
    hostId: string,
    response: Promise<readonly string[]>,
  ) => {
    coordinator.issue("hostFeedback", intent, hostId);
    const catalogRequest = coordinator.issue("hostCatalog", intent, hostId);
    const hosts = await response;
    if (coordinator.isCurrent(catalogRequest)) publishedLists.push(hosts);
  };

  const stale = publishMutation("save", "host-a", olderSave.promise);
  const latest = publishMutation("delete", "host-b", laterDelete.promise);
  laterDelete.resolve(["host-a"]);
  await latest;
  olderSave.resolve(["host-a", "host-b"]);
  await stale;

  assert.deepEqual(publishedLists, [["host-a"]]);
});

test("unmounted add update and remove settlements request an A2 reload without publishing A1 payloads", async () => {
  for (const intent of ["add", "update", "remove"] as const) {
    const coordinator = createConnectionsAsyncCoordinator();
    const mutation = deferred<HostConfig[]>();
    const acceptedPayloads: HostConfig[][] = [];
    const authoritativeCatalogs: HostConfig[][] = [];
    const staleCallbacks: string[] = [];
    const backendA = {};
    const backendB = {};
    let currentBackend = backendA;
    const originatingBackend = backendA;
    const catalogRequest = coordinator.issue("hostCatalog", intent, "host-a");
    const acceptPayload = () => currentBackend === originatingBackend && false;
    const settleMutation = mutation.promise.then((payload) => {
      if (coordinator.isCurrent(catalogRequest) && acceptPayload()) {
        acceptedPayloads.push(payload);
        return;
      }
      staleCallbacks.push(intent);
      if (currentBackend !== originatingBackend) return;
      authoritativeCatalogs.push([
        { id: "host-a", label: "A2", host: "authoritative-a2.example" },
      ]);
    });

    coordinator.invalidateAll(); // owner-key unmount of A1
    currentBackend = backendB;
    currentBackend = backendA; // A2 already hydrated before A1 settles
    mutation.resolve([
      { id: "host-a", label: "A1 payload", host: "untrusted-a1.example" },
    ]);
    await settleMutation;

    assert.deepEqual(acceptedPayloads, [], intent);
    assert.deepEqual(staleCallbacks, [intent]);
    assert.deepEqual(authoritativeCatalogs, [[
      { id: "host-a", label: "A2", host: "authoritative-a2.example" },
    ]]);
  }
});

test("Relay actions reject stale completion without cancelling current Host feedback", async () => {
  const coordinator = createConnectionsAsyncCoordinator();
  const relayStart = coordinator.issue("relay", "start");
  const hostTest = coordinator.issue("hostFeedback", "test", "host-a");
  const relayStop = coordinator.issue("relay", "stop");

  assert.equal(coordinator.isCurrent(relayStart), false);
  assert.equal(coordinator.isCurrent(relayStop), true);
  assert.equal(coordinator.isCurrent(hostTest), true);
});
