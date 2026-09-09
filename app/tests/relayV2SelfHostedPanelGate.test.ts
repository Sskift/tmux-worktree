import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  DashboardBackendProvider,
} from "../src/platform/DashboardBackendContext.tsx";
import type { MobileRelayV2SelfHostedConfigInput } from "../src/platform/domainTypes.ts";
import type { MobileRelayV2SelfHostedStatus } from "../src/platform/domainTypes.ts";
import type { MobileRelayV2SelfHostedDeploymentPort } from "../src/platform/dashboardBackend.ts";
import { createFakeDashboardBackend } from "../src/platform/fakeBackend.ts";
import { RelayV2SelfHostedPanel } from "../src/dashboard/Settings/RelayV2SelfHostedPanel.tsx";
import { relayV2SelfHostedCenterVersionNotice } from "../src/dashboard/Settings/relayV2SelfHostedModel.ts";
import {
  createRelayV2SelfHostedPanelController,
  createRelayV2SelfHostedRequestGate,
} from "../src/dashboard/Settings/relayV2SelfHostedPanelController.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function savedStatus(config: MobileRelayV2SelfHostedConfigInput): MobileRelayV2SelfHostedStatus {
  return {
    feature: "explicit_self_hosted",
    configured: true,
    config,
    bundleStatus: "ready",
    tlsStatus: "ready",
    centerStatus: "stopped",
    hostBootstrapAvailable: false,
    hostBootstrapPending: false,
    hostCredentialProvisioned: true,
    profileProvisioned: true,
    connectorDesiredRunning: false,
    effective: false,
    bootstrapRotationPending: false,
    remoteTlsKeyPath: "",
    remoteTlsCertificatePath: "",
    remoteTlsCaPath: "",
    remoteProfilePath: "",
    remoteStateDirectory: "",
    runningBundleVersion: null,
    centerVersionStale: false,
    dashboardBundleVersion: "1.0.24",
    error: null,
  };
}

const savedConfig: MobileRelayV2SelfHostedConfigInput = {
  enabled: true,
  brokerHostId: "devbox-old",
  issuerUrl: "https://old-relay.example.com/",
  listenHost: "10.0.0.1",
  listenPort: 8788,
  tlsKeyPath: "/tls/key.pem",
  tlsCertificatePath: "/tls/cert.pem",
  tlsCaPath: "/tls/ca.pem",
  externalTlsManagement: false,
};

function deferredDeployment() {
  const status = deferred<MobileRelayV2SelfHostedStatus>();
  const saveConfig = deferred<MobileRelayV2SelfHostedStatus>();
  const calls: Array<keyof MobileRelayV2SelfHostedDeploymentPort> = [];
  const deployment: MobileRelayV2SelfHostedDeploymentPort = {
    status: () => {
      calls.push("status");
      return status.promise;
    },
    saveConfig: () => {
      calls.push("saveConfig");
      return saveConfig.promise;
    },
    deploy: () => {
      throw new Error("not used in this test");
    },
    startCenter: () => {
      throw new Error("not used in this test");
    },
    rotateExpiredHostBootstrap: () => {
      throw new Error("not used in this test");
    },
    stopCenter: () => {
      throw new Error("not used in this test");
    },
  };
  return { deployment, status, saveConfig, calls };
}

test("C035: a user keystroke supersedes the in-flight mount status probe", () => {
  const gate = createRelayV2SelfHostedRequestGate();

  // Mount effect issues the one-shot status() token (panel controller mount()).
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

// --- Wiring tests: these drive the same controller the panel mounts, so they
// go red if the panel's effect/run/update wiring stops calling the gate. ---

test("C035 wiring: late mount status() response does not overwrite unsaved keystrokes", async () => {
  const { deployment, status } = deferredDeployment();
  const states: string[] = [];
  const controller = createRelayV2SelfHostedPanelController(deployment, (next) => {
    states.push(next.draft.issuerUrl);
  });

  controller.mount();
  // User edits while the SSH status probe is still in flight.
  controller.update("enabled", true);
  controller.update("issuerUrl", "https://typed-by-user.example.com/");
  assert.equal(controller.state.draft.issuerUrl, "https://typed-by-user.example.com/");

  // The slow mount probe finally returns the on-disk (old) config.
  status.resolve(savedStatus(savedConfig));
  await status.promise;
  // Flush the controller's .then() microtask.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    controller.state.draft.issuerUrl,
    "https://typed-by-user.example.com/",
    "late mount status() response must not clobber the user's unsaved input",
  );
  assert.equal(controller.state.status, null, "fenced mount response must not publish status either");
  assert.equal(controller.state.notice, null);
});

test("C035 wiring: unmounted mount probe never publishes on resolve", async () => {
  const { deployment, status } = deferredDeployment();
  let publishes = 0;
  const controller = createRelayV2SelfHostedPanelController(deployment, () => {
    publishes += 1;
  });

  controller.mount();
  controller.unmount();
  status.resolve(savedStatus(savedConfig));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(publishes, 0, "unmounted probe must not publish state");
  assert.equal(controller.state.status, null);
});

test("C035 wiring: run('save') result publishes and a later stale mount response stays fenced", async () => {
  const { deployment, status, saveConfig } = deferredDeployment();
  const controller = createRelayV2SelfHostedPanelController(deployment, () => {});

  controller.mount();
  // Fill in a valid draft (external TLS so no file paths are required).
  controller.update("enabled", true);
  controller.update("brokerHostId", "devbox-new");
  controller.update("issuerUrl", "https://new-relay.example.com/");
  controller.update("listenHost", "10.1.2.3");
  controller.update("externalTlsManagement", true);

  const runComplete = controller.run("save");
  // The save resolves with the freshly persisted config.
  const savedNew: MobileRelayV2SelfHostedConfigInput = {
    ...savedConfig,
    brokerHostId: "devbox-new",
    issuerUrl: "https://new-relay.example.com/",
    listenHost: "10.1.2.3",
    externalTlsManagement: true,
    tlsKeyPath: "",
    tlsCertificatePath: "",
    tlsCaPath: "",
  };
  saveConfig.resolve(savedStatus(savedNew));
  await runComplete;

  assert.equal(controller.state.status?.config?.issuerUrl, "https://new-relay.example.com/");
  assert.equal(controller.state.draft.issuerUrl, "https://new-relay.example.com/");
  assert.match(controller.state.notice ?? "", /saved/);

  // Now the stale mount probe (issued before the save) resolves with the old config.
  status.resolve(savedStatus(savedConfig));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    controller.state.draft.issuerUrl,
    "https://new-relay.example.com/",
    "stale mount probe must not roll the form back after a completed save",
  );
  assert.equal(controller.state.status?.config?.brokerHostId, "devbox-new");
});

test("C035 wiring: late mount probe failure after a user edit shows no error notice", async () => {
  const { deployment, status } = deferredDeployment();
  const controller = createRelayV2SelfHostedPanelController(deployment, () => {});

  controller.mount();
  controller.update("enabled", true);
  status.reject(new Error("ssh probe timed out"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    controller.state.notice,
    null,
    "a fenced-off mount failure must not surface over the user's editing session",
  );
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

function deploymentStatus(
  overrides: Partial<MobileRelayV2SelfHostedStatus> = {},
): MobileRelayV2SelfHostedStatus {
  return {
    ...savedStatus(savedConfig),
    centerStatus: "running",
    hostCredentialProvisioned: true,
    runningBundleVersion: "1.0.23",
    centerVersionStale: true,
    dashboardBundleVersion: "1.0.24",
    ...overrides,
  };
}

test("deploy: success notice says the running Center was restarted onto the new bundle", async () => {
  const result = deploymentStatus({ runningBundleVersion: "1.0.24", centerVersionStale: false });
  const deployment: MobileRelayV2SelfHostedDeploymentPort = {
    status: async () => result,
    saveConfig: async () => result,
    deploy: async () => result,
    startCenter: async () => result,
    rotateExpiredHostBootstrap: async () => result,
    stopCenter: async () => result,
  };
  const controller = createRelayV2SelfHostedPanelController(deployment, () => {});
  controller.update("enabled", true);
  controller.update("brokerHostId", "devbox-old");
  controller.update("issuerUrl", "https://old-relay.example.com/");
  controller.update("listenHost", "10.0.0.1");
  controller.update("externalTlsManagement", true);
  await controller.run("deploy");
  assert.match(controller.state.notice ?? "", /published/);
  assert.match(
    controller.state.notice ?? "",
    /Center was restarted onto the new bundle/,
  );
});

test("deploy: no restart claim when the Center was not running", async () => {
  const stopped = deploymentStatus({ centerStatus: "stopped" });
  const deployment: MobileRelayV2SelfHostedDeploymentPort = {
    status: async () => stopped,
    saveConfig: async () => stopped,
    deploy: async () => stopped,
    startCenter: async () => stopped,
    rotateExpiredHostBootstrap: async () => stopped,
    stopCenter: async () => stopped,
  };
  const controller = createRelayV2SelfHostedPanelController(deployment, () => {});
  controller.update("enabled", true);
  controller.update("brokerHostId", "devbox-old");
  controller.update("issuerUrl", "https://old-relay.example.com/");
  controller.update("listenHost", "10.0.0.1");
  controller.update("externalTlsManagement", true);
  await controller.run("deploy");
  assert.match(controller.state.notice ?? "", /published/);
  assert.doesNotMatch(controller.state.notice ?? "", /restarted/);
});

test("stale status from the deploy/mount probe carries the deploy-to-restart notice the panel renders", async () => {
  // The panel is a thin shell over this controller (its effects can't run under
  // renderToStaticMarkup); a status published here is exactly what the panel
  // mirrors into React state and renders via relayV2SelfHostedCenterVersionNotice.
  const stale = deploymentStatus();
  const deployment: MobileRelayV2SelfHostedDeploymentPort = {
    status: async () => stale,
    saveConfig: async () => stale,
    deploy: async () => stale,
    startCenter: async () => stale,
    rotateExpiredHostBootstrap: async () => stale,
    stopCenter: async () => stale,
  };
  let publishes = 0;
  const controller = createRelayV2SelfHostedPanelController(deployment, () => {
    publishes += 1;
  });
  controller.mount();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(publishes > 0, "the mount probe must publish the stale status into panel state");
  assert.equal(controller.state.status?.centerVersionStale, true);
  assert.equal(controller.state.status?.runningBundleVersion, "1.0.23");
  // The exact node the panel renders inside its stale-notice container.
  const notice = relayV2SelfHostedCenterVersionNotice(controller.state.status);
  assert.match(notice ?? "", /Center is running 1\.0\.23/);
  assert.match(notice ?? "", /Dashboard ships 1\.0\.24/);
  assert.match(notice ?? "", /Deploy restarts the Center/);
});
