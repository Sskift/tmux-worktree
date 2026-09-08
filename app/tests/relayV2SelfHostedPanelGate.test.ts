import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  DashboardBackendProvider,
} from "../src/platform/DashboardBackendContext.tsx";
import { createFakeDashboardBackend } from "../src/platform/fakeBackend.ts";
import {
  RelayV2SelfHostedPanel,
  createRelayV2SelfHostedRequestGate,
} from "../src/dashboard/Settings/RelayV2SelfHostedPanel.tsx";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("C035: a user keystroke supersedes the in-flight mount status probe", () => {
  const gate = createRelayV2SelfHostedRequestGate();

  // Mount effect issues the one-shot status() token (RelayV2SelfHostedPanel useEffect).
  const mountRequest = gate.request();
  assert.equal(gate.canPublish(mountRequest), true);

  // User types into the form while the SSH probe is still in flight.
  gate.userEdited();

  // The late mount response must not publish over the user's input.
  assert.equal(
    gate.canPublish(mountRequest),
    false,
    "late mount status() response must be fenced off after a user edit",
  );
});

test("C035: an issued run() supersedes the mount probe and only the newest run publishes", () => {
  const gate = createRelayV2SelfHostedRequestGate();

  const mountRequest = gate.request();
  // A save/deploy/start starts (its backend call is issued after validation).
  const saveRequest = gate.request();
  assert.equal(gate.canPublish(mountRequest), false);
  assert.equal(gate.canPublish(saveRequest), true);

  // A second operation (e.g. user clicks deploy while save resolves) supersedes.
  const deployRequest = gate.request();
  assert.equal(gate.canPublish(saveRequest), false);
  assert.equal(gate.canPublish(deployRequest), true);
});

test("C035: a run() failure surfaces only while it is still the latest request", async () => {
  const gate = createRelayV2SelfHostedRequestGate();
  const mountRequest = gate.request();
  const runRequest = gate.request();

  const notices: string[] = [];
  const publishFailure = (request: ReturnType<typeof gate.request>, message: string) => {
    if (gate.canPublish(request)) notices.push(message);
  };

  // Mount probe fails late; run already issued -> mount error must not surface.
  const mountFailure = deferred<never>();
  const runFailure = deferred<never>();
  void mountFailure.promise.catch(() =>
    publishFailure(mountRequest, "mount ssh error"));
  void runFailure.promise.catch(() =>
    publishFailure(runRequest, "save failed"));

  mountFailure.reject(new Error("mount ssh error"));
  runFailure.reject(new Error("save failed"));
  await Promise.allSettled([mountFailure.promise, runFailure.promise]);

  assert.deepEqual(notices, ["save failed"]);
});

test("C035: panel renders through the dashboard backend provider", () => {
  const { backend } = createFakeDashboardBackend();
  const markup = renderToStaticMarkup(
    createElement(
      DashboardBackendProvider,
      { backend },
      createElement(RelayV2SelfHostedPanel, { hosts: [] }),
    ),
  );
  assert.match(markup, /Relay v2 · self-hosted/);
  assert.match(markup, /HTTPS Relay URL/);
});
