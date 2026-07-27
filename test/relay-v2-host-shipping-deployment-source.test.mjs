import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { build } = createRequire(import.meta.url)("esbuild");

const sourcePath = new URL(
  "../src/relay/v2/hostShippingDeploymentSource.ts",
  import.meta.url,
).pathname;
const rootPath = new URL("../src/relay/v2/hostShippingRoot.ts", import.meta.url).pathname;

const virtualModules = new Map([
  ["node:os", `
    export function homedir() { return globalThis.__hostDeploymentHarness.home; }
  `],
  ["../../terminalControl/store.js", `
    export function defaultTerminalControlSocketPath(home) {
      globalThis.__hostDeploymentHarness.events.push(["terminal.path", home]);
      return home + "/.tmux-worktree/terminal-control-v1.sock";
    }
  `],
  ["../../terminalControl/client.js", `
    export async function requestTerminalControl(input, options) {
      const h = globalThis.__hostDeploymentHarness;
      h.events.push(["terminal.ready", input, options]);
      return { protocolVersion: 1, authority: "local-terminal-control" };
    }
  `],
  ["./hostProductionProfileStore.js", `
    export function readRelayV2HostProductionProfile(options) {
      const h = globalThis.__hostDeploymentHarness;
      h.events.push(["profile.read", options.trustedHome]);
      h.profileReads += 1;
      return h.profile;
    }
    export function requireRelayV2HostProductionProfileSnapshot(value) {
      const h = globalThis.__hostDeploymentHarness;
      h.events.push(["profile.freeze", value]);
      if (value !== h.profile) throw new Error("profile identity changed");
      return value;
    }
  `],
  ["./hostCredentialNativeLoader.js", `
    export const relayV2HostCredentialNativeModuleTrustedLoader =
      globalThis.__hostDeploymentTrustedLoader;
  `],
  ["./hostCredentialNativeModuleSource.js", `
    export function createRelayV2HostCredentialNativeModuleSource(target, loader) {
      const h = globalThis.__hostDeploymentHarness;
      if (loader !== h.trustedLoader) throw new Error("trusted loader was replaced");
      h.events.push(["native.create", target]);
      const source = {
        capability() {
          h.events.push(["native.capability"]);
          return { status: "supported" };
        },
        takeNativeModule() {
          h.events.push(["native.take"]);
          return h.nativeModule;
        },
        close() {
          if (source.closed) return;
          source.closed = true;
          h.events.push(["native.close"]);
        },
        closed: false,
      };
      h.sources.push(source);
      return source;
    }
  `],
  ["./canonicalHostRuntimeBundle.js", `
    const bundles = new WeakMap();
    export async function createRelayV2CanonicalHostRuntimeBundleOwnerV1(options) {
      const h = globalThis.__hostDeploymentHarness;
      h.events.push(["runtime.create", options]);
      const bundle = Object.freeze(Object.create(null));
      bundles.set(bundle, h.openedRuntime);
      let closed = false;
      return Object.freeze({
        bundle,
        reconfigure: async () => undefined,
        closeAndDrain: async () => {
          if (closed) return;
          closed = true;
          h.events.push(["runtime.close"]);
        },
      });
    }
    export function consumeRelayV2CanonicalHostRuntimeBundleV1(bundle) {
      const h = globalThis.__hostDeploymentHarness;
      const opened = bundles.get(bundle);
      if (opened === undefined) throw new Error("foreign runtime bundle");
      bundles.delete(bundle);
      h.events.push(["runtime.consume"]);
      return opened;
    }
  `],
  ["./hostShippingProcessLifecycle.js", `
    export class RelayV2HostShippingProcessSignalOwner {
      constructor() {
        const h = globalThis.__hostDeploymentHarness;
        this.controller = new AbortController();
        h.processSignalController = this.controller;
        h.events.push(["signal.install"]);
      }
      get signal() { return this.controller.signal; }
      close() {
        globalThis.__hostDeploymentHarness.events.push(["signal.close"]);
      }
    }
    export async function runRelayV2HostShippingProcessLifecycle(handle, options) {
      const h = globalThis.__hostDeploymentHarness;
      if (options.signal !== h.processSignalController.signal) {
        throw new Error("process signal owner was split");
      }
      h.events.push(["process.run", handle.inspect(), options.signal]);
      await handle.closeAndDrain();
      return { status: "superseded", exitCode: 78 };
    }
  `],
  ["./hostTlsTrustMaterial.js", `
    const cuts = new WeakSet();
    export function captureRelayV2HostSystemTlsTrustCut() {
      const h = globalThis.__hostDeploymentHarness;
      const cut = Object.freeze(Object.create(null));
      cuts.add(cut);
      h.trustCuts.push(cut);
      h.events.push(["tls.cut", cut]);
      return cut;
    }
    export function isRelayV2HostTlsTrustCut(value) {
      globalThis.__hostDeploymentHarness.events.push(["tls.check", value]);
      return cuts.has(value);
    }
    export function readRelayV2HostTlsCaTrustCut(value) {
      if (!cuts.has(value)) throw new Error("foreign TLS cut");
      return undefined;
    }
    export function captureRelayV2HostTlsCaTrust(value) { return value; }
  `],
  ["./hostState.js", `
    export function relayV2HostStatePaths(home) {
      globalThis.__hostDeploymentHarness.events.push(["state.paths", home]);
      return { home };
    }
    export class RelayV2HostStateStore {
      static async open({ paths }) {
        const h = globalThis.__hostDeploymentHarness;
        h.events.push(["state.open", paths.home]);
        return {
          hostInstanceId: "host-instance-exact",
          async close() { h.events.push(["state.close"]); },
        };
      }
    }
  `],
  ["./resourceState.js", `
    export class RelayV2MaterializedStateFoundation {
      constructor(options) {
        const h = globalThis.__hostDeploymentHarness;
        h.events.push(["foundation.create", options.hostId, options.discovery]);
        h.foundationProfileHostId = options.hostId;
      }
      async reconcile() {
        globalThis.__hostDeploymentHarness.events.push(["foundation.reconcile"]);
        return {};
      }
      async openStateSnapshotSpool(options) {
        const h = globalThis.__hostDeploymentHarness;
        h.events.push(["spool.open", options.hostId, options.home]);
        h.spoolProfileHostId = options.hostId;
        return {
          async close() { h.events.push(["spool.close"]); },
        };
      }
    }
  `],
  ["./materializedReconcileLifecycleOwner.js", `
    export const RELAY_V2_MATERIALIZED_RECONCILE_LIFECYCLE_MAX_SCAN_INTERVAL_MS =
      2147483647;
    export class RelayV2MaterializedReconcileLifecycleOwner {
      constructor(options) {
        this.options = options;
        this.closed = false;
        globalThis.__hostDeploymentHarness.events.push(["lifecycle.create"]);
      }
      async start() {
        const h = globalThis.__hostDeploymentHarness;
        h.events.push(["lifecycle.start"]);
        await this.options.reconcilePort.reconcile();
        if (h.abortDuringLifecycleStart) h.processSignalController.abort();
        return "reconciled";
      }
      async close() {
        if (this.closed) return;
        this.closed = true;
        globalThis.__hostDeploymentHarness.events.push(["lifecycle.close"]);
      }
    }
  `],
  ["./hostWelcomeSerializer.js", `
    export function createRelayV2HostRuntimeWelcomeSerializer(options) {
      const h = globalThis.__hostDeploymentHarness;
      h.events.push(["welcome.create", options.hostId]);
      h.welcomeProfileHostId = options.hostId;
      return Object.freeze({ hostId: options.hostId });
    }
  `],
  ["./hostNativeCredentialPrivilegedIntakeBridge.js", `
    export async function openRelayV2HostNativeCredentialPrivilegedIntakeBridge(options) {
      const h = globalThis.__hostDeploymentHarness;
      h.events.push(["intake.open", options.profileSnapshot, options.canonical]);
      if (h.failIntake) throw new Error("injected intake failure");
      if (options.profileSnapshot !== h.profile) throw new Error("profile snapshot split");
      if (options.canonical.welcome.hostId !== h.profile.hostId) {
        throw new Error("welcome lineage split");
      }
      if (options.credentialHttpsTlsTrust !== undefined
        || options.carrierWssTlsTrust !== undefined) {
        throw new Error("system TLS cuts were replaced");
      }
      options.takeNativeModule();
      let closed = false;
      return Object.freeze({
        inspect: () => ({ status: "stopped", controllerGeneration: "0" }),
        start: async () => ({ status: "failed" }),
        stopAndDrain: async () => ({ status: "already_stopped" }),
        closeAndDrain: async () => {
          if (closed) return;
          closed = true;
          h.events.push(["intake.close"]);
          await options.canonical.recoveredH2Spool.close();
          await options.canonical.hostState.close();
        },
      });
    }
  `],
]);

const plugin = {
  name: "host-deployment-owner-fixture",
  setup(esbuild) {
    esbuild.onResolve({ filter: /^node:os$/ }, () => ({
      path: "node:os",
      namespace: "host-deployment-stub",
    }));
    esbuild.onResolve({ filter: /^\.\.\/\.\.\/terminalControl\/store\.js$/ }, () => ({
      path: "../../terminalControl/store.js",
      namespace: "host-deployment-stub",
    }));
    esbuild.onResolve({ filter: /^\.\.\/\.\.\/terminalControl\/client\.js$/ }, () => ({
      path: "../../terminalControl/client.js",
      namespace: "host-deployment-stub",
    }));
    esbuild.onResolve({ filter: /^\.\/hostShippingRoot\.js$/ }, () => ({
      path: rootPath,
    }));
    esbuild.onResolve({ filter: /^\.\// }, (args) => (
      virtualModules.has(args.path)
        ? { path: args.path, namespace: "host-deployment-stub" }
        : null
    ));
    esbuild.onLoad({ filter: /.*/, namespace: "host-deployment-stub" }, (args) => ({
      contents: virtualModules.get(args.path),
      loader: "js",
    }));
  },
};

const compiled = await build({
  entryPoints: [sourcePath],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
  plugins: [plugin],
});
globalThis.__hostDeploymentTrustedLoader = Object.freeze(function trustedLoader() {});
const module = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);

function canonicalProfile() {
  return Object.freeze(Object.assign(Object.create(null), {
    contract: "tmux-worktree-relay-v2-host-production-profile",
    schemaVersion: 1,
    hostId: "host-production-exact",
    relayUrl: "wss://relay.example.test/",
    credentialIssuerUrl: "https://issuer.example.test/",
    credentialReference: "relay-v2-host-credential-ref:host-production-exact",
    bootstrapSecretReference: "bootstrap-exact",
    refreshSecretReference: "refresh-exact",
  }));
}

function createHarness(home) {
  return {
    home,
    profile: canonicalProfile(),
    profileReads: 0,
    trustedLoader: globalThis.__hostDeploymentTrustedLoader,
    nativeModule: Object.freeze({ openRelayV2HostCredentialAtomicFileCellV1() {} }),
    events: [],
    sources: [],
    trustCuts: [],
    failIntake: false,
    abortDuringLifecycleStart: false,
    processSignalController: null,
    openedRuntime: Object.freeze(Object.assign(Object.create(null), {
      discovery: Object.freeze({ scan: async () => ({}) }),
      localProcessTarget: Object.freeze({ kind: "local", targetId: "local-exact" }),
      remoteCompoundChannels: Object.freeze({ open: async () => {
        throw new Error("unexpected remote open");
      } }),
      createTargetExecutionPair: Object.freeze(Object.create(null)),
    })),
  };
}

test("Relay v2 Host normal process lifecycle prepares terminal control and freezes one trusted lineage", async () => {
  const home = mkdtempSync(join(tmpdir(), "tw-v2-host-deployment-"));
  const cli = join(home, "cli.cjs");
  writeFileSync(cli, "/* fixture */\n");
  const savedArgv = process.argv;
  try {
    process.argv = [process.execPath, cli];
    const first = createHarness(home);
    globalThis.__hostDeploymentHarness = first;

    await assert.rejects(
      Reflect.apply(module.startRelayV2HostShippingFromTrustedDeployment, undefined, [{}]),
      (error) => error?.code === "ACTIVATION_INVALID",
    );
    assert.equal(first.events.length, 0, "authority input is rejected before profile read");

    const handle = await module.startRelayV2HostShippingFromTrustedDeployment();
    assert.equal(first.profileReads, 1);
    const terminalReadyIndex = first.events.findIndex(([name]) => name === "terminal.ready");
    const runtimeCreateIndex = first.events.findIndex(([name]) => name === "runtime.create");
    assert.ok(terminalReadyIndex >= 0);
    assert.ok(runtimeCreateIndex > terminalReadyIndex);
    const [, terminalRequest, terminalOptions] = first.events[terminalReadyIndex];
    assert.deepEqual(terminalRequest, { type: "ping" });
    assert.equal(terminalOptions.socketPath, join(
      home,
      ".tmux-worktree",
      "terminal-control-v1.sock",
    ));
    assert.equal(terminalOptions.autoStart, true);
    assert.deepEqual(terminalOptions.autoStartCliTarget, {
      executable: process.execPath,
      entrypoint: cli,
    });
    assert.equal(first.foundationProfileHostId, first.profile.hostId);
    assert.equal(first.spoolProfileHostId, first.profile.hostId);
    assert.equal(first.welcomeProfileHostId, first.profile.hostId);
    assert.equal(first.trustCuts.length, 2);
    assert.notStrictEqual(first.trustCuts[0], first.trustCuts[1]);
    assert.deepEqual(Reflect.ownKeys(first.trustCuts[0]), []);
    assert.deepEqual(Reflect.ownKeys(first.trustCuts[1]), []);
    assert.deepEqual(handle.inspect(), { status: "stopped", controllerGeneration: "0" });
    assert.equal(Reflect.get(handle, "profileSnapshot"), undefined);
    assert.equal(Reflect.get(handle, "runtimeBundle"), undefined);
    assert.equal(Reflect.get(handle, "nativeModuleSource"), undefined);

    const close = handle.closeAndDrain();
    assert.strictEqual(handle.closeAndDrain(), close);
    await close;
    const closeOrder = first.events
      .filter(([name]) => [
        "lifecycle.close",
        "intake.close",
        "spool.close",
        "state.close",
        "runtime.close",
        "native.close",
      ].includes(name))
      .map(([name]) => name);
    assert.deepEqual(closeOrder, [
      "lifecycle.close",
      "intake.close",
      "spool.close",
      "state.close",
      "runtime.close",
      "native.close",
    ]);

    const processOwned = createHarness(home);
    globalThis.__hostDeploymentHarness = processOwned;
    assert.equal(await module.runRelayV2HostShippingFromTrustedDeployment(), 78);
    const signalInstallIndex = processOwned.events
      .findIndex(([name]) => name === "signal.install");
    const profileReadIndex = processOwned.events
      .findIndex(([name]) => name === "profile.read");
    assert.ok(signalInstallIndex >= 0 && profileReadIndex > signalInstallIndex);
    const processRun = processOwned.events.find(([name]) => name === "process.run");
    assert.deepEqual(processRun.slice(0, 2), [
      "process.run",
      { status: "stopped", controllerGeneration: "0" },
    ]);
    assert.strictEqual(processRun[2], processOwned.processSignalController.signal);
    assert.ok(processOwned.events.some(([name]) => name === "runtime.close"));
    assert.ok(processOwned.events.some(([name]) => name === "native.close"));
    assert.equal(processOwned.events.at(-1)[0], "signal.close");

    const startupInterrupted = createHarness(home);
    startupInterrupted.abortDuringLifecycleStart = true;
    globalThis.__hostDeploymentHarness = startupInterrupted;
    assert.equal(await module.runRelayV2HostShippingFromTrustedDeployment(), 0);
    assert.equal(
      startupInterrupted.events.some(([name]) => name === "process.run"),
      false,
    );
    assert.deepEqual(
      startupInterrupted.events
        .filter(([name]) => [
          "signal.install",
          "lifecycle.start",
          "lifecycle.close",
          "state.close",
          "runtime.close",
          "native.close",
          "signal.close",
        ].includes(name))
        .map(([name]) => name),
      [
        "signal.install",
        "lifecycle.start",
        "lifecycle.close",
        "state.close",
        "runtime.close",
        "native.close",
        "signal.close",
      ],
    );

    const second = createHarness(home);
    second.failIntake = true;
    globalThis.__hostDeploymentHarness = second;
    await assert.rejects(
      module.startRelayV2HostShippingFromTrustedDeployment(),
      (error) => error?.code === "ACTIVATION_FAILED",
    );
    assert.equal(second.profileReads, 1);
    const rollbackOrder = second.events
      .filter(([name]) => [
        "lifecycle.close",
        "spool.close",
        "state.close",
        "runtime.close",
        "native.close",
      ].includes(name))
      .map(([name]) => name);
    assert.deepEqual(rollbackOrder, [
      "lifecycle.close",
      "spool.close",
      "state.close",
      "runtime.close",
      "native.close",
    ]);
  } finally {
    process.argv = savedArgv;
    delete globalThis.__hostDeploymentHarness;
    delete globalThis.__hostDeploymentTrustedLoader;
    rmSync(home, { recursive: true, force: true });
  }
});
