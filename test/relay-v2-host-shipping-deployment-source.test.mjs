import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    export function defaultTerminalControlStatePath(home) {
      globalThis.__hostDeploymentHarness.events.push(["terminal.state-path", home]);
      return home + "/.tmux-worktree/terminal-control-state-v1.json";
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
    export function readRelayV2HostProductionProfileProvisioningInput(options) {
      const h = globalThis.__hostDeploymentHarness;
      h.events.push(["profile.provisioning.read", options.inputPath]);
      return h.provisioningProfile ?? h.profile;
    }
    export function loadOrCreateRelayV2HostProductionProfile(options) {
      const h = globalThis.__hostDeploymentHarness;
      h.events.push(["profile.create", options.trustedHome, options.profile]);
      h.profile = options.profile;
      return h.profile;
    }
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
    const cuts = new WeakMap();
    export const RELAY_V2_HOST_TLS_CA_MAX_ENTRY_BYTES = 16384;
    export function captureRelayV2HostSystemTlsTrustCut() {
      const h = globalThis.__hostDeploymentHarness;
      const cut = Object.freeze(Object.create(null));
      cuts.set(cut, undefined);
      h.trustCuts.push(cut);
      h.events.push(["tls.cut", cut]);
      return cut;
    }
    export function captureRelayV2HostTlsCaTrustCut(value) {
      const h = globalThis.__hostDeploymentHarness;
      const cut = Object.freeze(Object.create(null));
      cuts.set(cut, value);
      h.trustCuts.push(cut);
      h.events.push(["tls.ca-cut", value]);
      return cut;
    }
    export function isRelayV2HostTlsTrustCut(value) {
      globalThis.__hostDeploymentHarness.events.push(["tls.check", value]);
      return cuts.has(value);
    }
    export function readRelayV2HostTlsCaTrustCut(value) {
      if (!cuts.has(value)) throw new Error("foreign TLS cut");
      return cuts.get(value);
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
  ["./hostRuntimeComposition.js", `
    export function issueRelayV2HostLocalDevelopmentCapabilityActivationHandoff(cell) {
      const h = globalThis.__hostDeploymentHarness;
      const handoff = Object.freeze(Object.create(null));
      h.localCapabilityHandoffs.set(handoff, cell);
      h.localCapabilityHandoffIssueCount += 1;
      h.events.push(["local.capability-handoff.issue", cell, handoff]);
      return handoff;
    }
  `],
  ["./hostNativeCredentialPrivilegedIntakeBridge.js", `
    export async function openRelayV2HostNativeCredentialPrivilegedIntakeBridge(options) {
      const h = globalThis.__hostDeploymentHarness;
      h.events.push(["intake.open", options.profileSnapshot, options.canonical]);
      h.nativeIntakeOptions = options;
      if (Object.hasOwn(options, "localDevelopmentCapabilityActivationHandoff")) {
        throw new Error("production intake received local-development handoff");
      }
      if (h.failIntake) throw new Error("injected intake failure");
      if (options.profileSnapshot !== h.profile) throw new Error("profile snapshot split");
      if (options.canonical.welcome.hostId !== h.profile.hostId) {
        throw new Error("welcome lineage split");
      }
      if (options.credentialHttpsTlsTrust !== undefined
        || options.carrierWssTlsTrust !== undefined) {
        throw new Error("system TLS cuts were replaced");
      }
      h.bootstrapSecretByteSource = options.bootstrapSecretByteSource;
      if (options.bootstrapSecretByteSource !== undefined) {
        const chunks = [];
        for await (const chunk of options.bootstrapSecretByteSource) {
          chunks.push(Buffer.from(chunk));
        }
        h.bootstrapSecretRaw = Buffer.concat(chunks).toString("utf8");
      }
      options.takeNativeModule();
      let closed = false;
      const management = options.canonical.dashboardManagement;
      const intake = Object.freeze({
        inspect: () => ({ status: "stopped", controllerGeneration: "0" }),
        start: async () => {
          h.events.push(["intake.start"]);
          return { status: "failed" };
        },
        stopAndDrain: async () => ({ status: "already_stopped" }),
        ...(management === undefined ? {} : {
          runDashboardManagement: async () => {
            h.events.push(["management.run", management]);
            return 0;
          },
        }),
        closeAndDrain: async () => {
          if (closed) return;
          closed = true;
          h.events.push(["intake.close"]);
          await options.canonical.recoveredH2Spool.close();
          await options.canonical.hostState.close();
        },
      });
      if (h.abortAfterIntakeOpen) h.processSignalController.abort();
      return intake;
    }
  `],
  ["./hostPrivilegedProductionIntakeComposition.js", `
    export async function openRelayV2HostPrivilegedProductionIntakeComposition(options) {
      const h = globalThis.__hostDeploymentHarness;
      h.events.push(["local.intake.open", options.profileSnapshot, options.canonical]);
      if (options.profileSnapshot !== h.profile) throw new Error("profile snapshot split");
      const localCapabilityHandoff =
        options.localDevelopmentCapabilityActivationHandoff;
      if (h.localCapabilityHandoffs.get(localCapabilityHandoff)
        !== options.credentialCell) {
        throw new Error("local capability handoff is not bound to the exact cell");
      }
      h.localIntakeOptions = options;
      const initial = options.credentialCell.runExclusive((transaction) => transaction.read());
      if (initial.bytes !== null) throw new Error("local cell did not start empty");
      const replacement = Uint8Array.from([1, 2, 3]);
      const swapped = options.credentialCell.runExclusive((transaction) =>
        transaction.compareAndSwap(initial.revision, replacement));
      if (swapped.status !== "swapped") throw new Error("local cell did not swap");
      const inheritedThenable = Object.create({ then() {} });
      try {
        options.credentialCell.runExclusive(() => inheritedThenable);
      } catch (error) {
        h.inheritedThenableErrorCode = error?.code;
      }
      const hostileThenable = {};
      Object.defineProperty(hostileThenable, "then", {
        get() {
          h.hostileThenGetterReads += 1;
          throw new Error("then getter must not be assimilated");
        },
      });
      try {
        options.credentialCell.runExclusive(() => hostileThenable);
      } catch (error) {
        h.hostileThenableErrorCode = error?.code;
      }
      h.localCredentialCell = options.credentialCell;
      h.localTlsTrust = {
        credential: options.credentialHttpsTlsTrust,
        carrier: options.carrierWssTlsTrust,
      };
      h.bootstrapSecretByteSource = options.bootstrapSecretByteSource;
      if (options.bootstrapSecretByteSource !== undefined) {
        const chunks = [];
        for await (const chunk of options.bootstrapSecretByteSource) {
          chunks.push(Buffer.from(chunk));
        }
        h.bootstrapSecretRaw = Buffer.concat(chunks).toString("utf8");
      }
      let closed = false;
      const management = options.canonical.dashboardManagement;
      return Object.freeze({
        inspect: () => ({ status: "stopped", controllerGeneration: "0" }),
        start: async () => ({ status: "failed" }),
        stopAndDrain: async () => ({ status: "already_stopped" }),
        ...(management === undefined ? {} : {
          runDashboardManagement: async () => {
            h.events.push(["management.run", management]);
            return 0;
          },
        }),
        closeAndDrain: async () => {
          if (closed) return;
          closed = true;
          h.events.push(["local.intake.close"]);
          await options.canonical.recoveredH2Spool.close();
          await options.canonical.hostState.close();
          await options.credentialCell.closeAndDrain();
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

function localDevelopmentProfile() {
  return Object.freeze(Object.assign(Object.create(null), {
    ...canonicalProfile(),
    relayUrl: "wss://localhost:9443/",
    credentialIssuerUrl: "https://localhost:9443/",
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
    abortAfterIntakeOpen: false,
    processSignalController: null,
    bootstrapSecretByteSource: undefined,
    bootstrapSecretRaw: null,
    localCredentialCell: null,
    localTlsTrust: null,
    localCapabilityHandoffs: new WeakMap(),
    localCapabilityHandoffIssueCount: 0,
    localIntakeOptions: null,
    nativeIntakeOptions: null,
    inheritedThenableErrorCode: null,
    hostileThenableErrorCode: null,
    hostileThenGetterReads: 0,
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
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "tw-v2-host-deployment-")));
  chmodSync(home, 0o700);
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
    const productionRuntimeOptions = first.events[runtimeCreateIndex][1];
    assert.equal(
      Object.hasOwn(productionRuntimeOptions, "configLoader"),
      false,
      "production runtime keeps the real config owner",
    );
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
    assert.equal(
      Object.hasOwn(terminalOptions, "autoStartStatePath"),
      false,
      "production keeps the default terminal-control child contract",
    );
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
    assert.equal(first.localCapabilityHandoffIssueCount, 0);
    assert.equal(
      Object.hasOwn(
        first.nativeIntakeOptions,
        "localDevelopmentCapabilityActivationHandoff",
      ),
      false,
      "production shipping must omit the local-development handoff field",
    );

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

    const dashboardOwned = createHarness(home);
    globalThis.__hostDeploymentHarness = dashboardOwned;
    const dashboardAbort = new AbortController();
    const dashboardInput = Object.freeze({
      async *[Symbol.asyncIterator]() {},
    });
    const dashboardWrite = async () => undefined;
    const dashboardClock = () => 1_783_700_000_000;
    const dashboardHandle =
      await module.startRelayV2HostDashboardManagementFromTrustedDeployment(
        Object.freeze({
          clock: dashboardClock,
          runtimeVersion: "0.0.0-dashboard-trusted-test",
          signal: dashboardAbort.signal,
          io: Object.freeze({
            input: dashboardInput,
            writeFrame: dashboardWrite,
          }),
        }),
      );
    assert.deepEqual(Reflect.ownKeys(dashboardHandle).sort(), [
      "closeAndDrain",
      "inspect",
      "runDashboardManagement",
      "start",
      "stopAndDrain",
    ]);
    assert.deepEqual(dashboardHandle.inspect(), {
      status: "stopped",
      controllerGeneration: "0",
    });
    const dashboardTerminalReady = dashboardOwned.events
      .find(([name]) => name === "terminal.ready");
    assert.strictEqual(dashboardTerminalReady[2].signal, dashboardAbort.signal);
    const dashboardIntake = dashboardOwned.events
      .find(([name]) => name === "intake.open");
    const dashboardManagement = dashboardIntake[2].dashboardManagement;
    assert.strictEqual(dashboardManagement.clock, dashboardClock);
    assert.equal(
      dashboardManagement.runtimeVersion,
      "0.0.0-dashboard-trusted-test",
    );
    assert.strictEqual(dashboardManagement.signal, dashboardAbort.signal);
    assert.strictEqual(dashboardManagement.io.input, dashboardInput);
    assert.strictEqual(dashboardManagement.io.writeFrame, dashboardWrite);
    assert.equal(await dashboardHandle.runDashboardManagement(), 0);
    assert.equal(
      dashboardOwned.events.some(([name]) => name === "intake.start"),
      false,
      "the Dashboard owner never adopts the relay-host auto-start lifecycle",
    );
    assert.equal(
      dashboardOwned.events.some(([name]) => name === "process.run"),
      false,
    );
    await dashboardHandle.closeAndDrain();
    assert.deepEqual(
      dashboardOwned.events
        .filter(([name]) => [
          "management.run",
          "lifecycle.close",
          "intake.close",
          "spool.close",
          "state.close",
          "runtime.close",
          "native.close",
        ].includes(name))
        .map(([name]) => name),
      [
        "management.run",
        "lifecycle.close",
        "intake.close",
        "spool.close",
        "state.close",
        "runtime.close",
        "native.close",
      ],
    );

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

    const bootstrapPath = join(home, "first-host.twhostboot2");
    const bootstrapRecord = "twhostboot2.trusted-file-bootstrap-secret\n";
    writeFileSync(bootstrapPath, bootstrapRecord, { mode: 0o600 });
    chmodSync(bootstrapPath, 0o600);
    const bootstrapOwned = createHarness(home);
    globalThis.__hostDeploymentHarness = bootstrapOwned;
    assert.equal(
      await module.runRelayV2HostShippingFromTrustedDeployment(bootstrapPath),
      78,
    );
    assert.ok(bootstrapOwned.bootstrapSecretByteSource);
    assert.equal(bootstrapOwned.bootstrapSecretRaw, bootstrapRecord);
    assert.ok(
      bootstrapOwned.events.some(([name]) => name === "intake.open"),
      "valid fd-bound input must not depend on an optional O_CLOEXEC fs constant",
    );
    assert.equal(bootstrapOwned.events.at(-1)[0], "signal.close");

    const credentialCaPath = join(home, "local-credential-issuer-ca.pem");
    const carrierCaPath = join(home, "local-carrier-ca.pem");
    const credentialCa = "local-development-credential-ca";
    const carrierCa = "local-development-carrier-ca";
    writeFileSync(credentialCaPath, credentialCa, { mode: 0o600 });
    writeFileSync(carrierCaPath, carrierCa, { mode: 0o600 });
    chmodSync(credentialCaPath, 0o600);
    chmodSync(carrierCaPath, 0o600);
    const localDevelopment = createHarness(home);
    localDevelopment.profile = localDevelopmentProfile();
    localDevelopment.provisioningProfile = localDevelopment.profile;
    globalThis.__hostDeploymentHarness = localDevelopment;
    assert.equal(
      await module.runRelayV2HostShippingFromLocalDevelopment({
        trustedHome: home,
        credentialHttpsCaInputPath: credentialCaPath,
        carrierWssCaInputPath: carrierCaPath,
        provisionProfileInputPath: join(home, "local-profile-input.json"),
        bootstrapSecretInputPath: bootstrapPath,
      }),
      78,
    );
    assert.equal(
      localDevelopment.events.some(([name]) => name === "native.create"),
      false,
      "local development must never probe or manufacture native qualification",
    );
    const localTerminalReady = localDevelopment.events
      .find(([name]) => name === "terminal.ready");
    assert.equal(
      localTerminalReady[2].autoStartStatePath,
      join(home, ".tmux-worktree", "terminal-control-state-v1.json"),
    );
    const localRuntimeOptions = localDevelopment.events
      .find(([name]) => name === "runtime.create")[1];
    assert.equal(typeof localRuntimeOptions.configLoader, "function");
    assert.deepEqual(localRuntimeOptions.configLoader(), { hosts: [] });
    assert.ok(localDevelopment.events.some(([name]) => name === "local.intake.open"));
    assert.equal(localDevelopment.localCapabilityHandoffIssueCount, 1);
    assert.strictEqual(
      localDevelopment.localCapabilityHandoffs.get(
        localDevelopment.localIntakeOptions
          .localDevelopmentCapabilityActivationHandoff,
      ),
      localDevelopment.localCredentialCell,
      "auto-start local shipping passes the handoff bound to its exact cell",
    );
    assert.equal(localDevelopment.trustCuts.length, 2);
    assert.notStrictEqual(localDevelopment.trustCuts[0], localDevelopment.trustCuts[1]);
    assert.equal(
      Buffer.from(
        localDevelopment.localTlsTrust.credential.certificateAuthorities[0],
      ).toString("utf8"),
      credentialCa,
    );
    assert.equal(
      Buffer.from(
        localDevelopment.localTlsTrust.carrier.certificateAuthorities[0],
      ).toString("utf8"),
      carrierCa,
    );
    assert.equal(localDevelopment.bootstrapSecretRaw, bootstrapRecord);
    assert.ok(localDevelopment.events.some(([name, trustedHome]) =>
      name === "profile.create" && trustedHome === home));
    assert.equal(
      localDevelopment.inheritedThenableErrorCode,
      "ASYNC_OPERATION_UNSUPPORTED",
    );
    assert.equal(
      localDevelopment.hostileThenableErrorCode,
      "ASYNC_OPERATION_UNSUPPORTED",
    );
    assert.equal(
      localDevelopment.hostileThenGetterReads,
      0,
      "hostile then getters are identified without assimilation",
    );
    assert.equal(localDevelopment.events.at(-1)[0], "signal.close");
    assert.throws(
      () => localDevelopment.localCredentialCell.runExclusive(
        (transaction) => transaction.read(),
      ),
      (error) => error?.code === "CLOSED",
      "the process-local credential bytes are fenced and discarded at close",
    );

    const localDashboardOwned = createHarness(home);
    localDashboardOwned.profile = localDevelopmentProfile();
    globalThis.__hostDeploymentHarness = localDashboardOwned;
    const localDashboardAbort = new AbortController();
    const localDashboardHandle =
      await module.startRelayV2HostDashboardManagementFromLocalDevelopment(
        Object.freeze({
          trustedHome: home,
          credentialHttpsCaInputPath: credentialCaPath,
          carrierWssCaInputPath: carrierCaPath,
        }),
        Object.freeze({
          clock: dashboardClock,
          runtimeVersion: "0.0.0-dashboard-local-development-test",
          signal: localDashboardAbort.signal,
          io: Object.freeze({
            input: dashboardInput,
            writeFrame: dashboardWrite,
          }),
        }),
      );
    assert.equal(typeof localDashboardHandle.runDashboardManagement, "function");
    const localDashboardIntake = localDashboardOwned.events
      .find(([name]) => name === "local.intake.open");
    assert.strictEqual(
      localDashboardIntake[2].dashboardManagement.signal,
      localDashboardAbort.signal,
    );
    assert.equal(localDashboardOwned.localCapabilityHandoffIssueCount, 1);
    assert.strictEqual(
      localDashboardOwned.localCapabilityHandoffs.get(
        localDashboardOwned.localIntakeOptions
          .localDevelopmentCapabilityActivationHandoff,
      ),
      localDashboardOwned.localCredentialCell,
      "local management shipping reuses the exact-cell handoff path",
    );
    assert.equal(await localDashboardHandle.runDashboardManagement(), 0);
    assert.equal(
      localDashboardOwned.events.some(([name]) => name === "process.run"),
      false,
      "upper-layer management adoption does not start a competing process lifecycle",
    );
    await localDashboardHandle.closeAndDrain();

    const nonLoopback = createHarness(home);
    globalThis.__hostDeploymentHarness = nonLoopback;
    await assert.rejects(
      module.runRelayV2HostShippingFromLocalDevelopment({
        trustedHome: home,
        credentialHttpsCaInputPath: credentialCaPath,
        carrierWssCaInputPath: carrierCaPath,
      }),
      (error) => error?.code === "ACTIVATION_FAILED",
    );
    assert.equal(nonLoopback.events.some(([name]) => name === "terminal.ready"), false);
    assert.equal(nonLoopback.events.some(([name]) => name === "native.create"), false);

    const unsafeLocalTrust = createHarness(home);
    unsafeLocalTrust.profile = localDevelopmentProfile();
    globalThis.__hostDeploymentHarness = unsafeLocalTrust;
    chmodSync(carrierCaPath, 0o644);
    await assert.rejects(
      module.runRelayV2HostShippingFromLocalDevelopment({
        trustedHome: home,
        credentialHttpsCaInputPath: credentialCaPath,
        carrierWssCaInputPath: carrierCaPath,
      }),
      (error) => error?.code === "ACTIVATION_FAILED"
        && !String(error).includes(carrierCaPath),
    );
    assert.equal(unsafeLocalTrust.events.some(([name]) => name === "terminal.ready"), false);
    assert.equal(unsafeLocalTrust.events.some(([name]) => name === "native.create"), false);
    chmodSync(carrierCaPath, 0o600);

    const broadLocalHome = join(home, "broad-local-home");
    mkdirSync(broadLocalHome, { mode: 0o755 });
    chmodSync(broadLocalHome, 0o755);
    const unsafeLocalHome = createHarness(broadLocalHome);
    unsafeLocalHome.profile = localDevelopmentProfile();
    globalThis.__hostDeploymentHarness = unsafeLocalHome;
    await assert.rejects(
      module.runRelayV2HostShippingFromLocalDevelopment({
        trustedHome: broadLocalHome,
        credentialHttpsCaInputPath: credentialCaPath,
        carrierWssCaInputPath: carrierCaPath,
      }),
      (error) => error?.code === "ACTIVATION_FAILED"
        && !String(error).includes(broadLocalHome),
    );
    assert.equal(unsafeLocalHome.profileReads, 0);
    assert.equal(
      unsafeLocalHome.events.some(([name]) => name === "terminal.ready"),
      false,
    );

    const unsafeInputs = [];
    const broadMode = join(home, "bootstrap-broad-mode");
    writeFileSync(broadMode, bootstrapRecord, { mode: 0o600 });
    chmodSync(broadMode, 0o640);
    unsafeInputs.push(broadMode);

    const linkedSource = join(home, "bootstrap-linked-source");
    const linkedInput = join(home, "bootstrap-linked-input");
    writeFileSync(linkedSource, bootstrapRecord, { mode: 0o600 });
    linkSync(linkedSource, linkedInput);
    unsafeInputs.push(linkedInput);

    const symlinkTarget = join(home, "bootstrap-symlink-target");
    const symlinkInput = join(home, "bootstrap-symlink-input");
    writeFileSync(symlinkTarget, bootstrapRecord, { mode: 0o600 });
    symlinkSync(symlinkTarget, symlinkInput);
    unsafeInputs.push(symlinkInput);

    const directoryInput = join(home, "bootstrap-directory");
    mkdirSync(directoryInput, { mode: 0o700 });
    unsafeInputs.push(directoryInput);

    const oversizedInput = join(home, "bootstrap-oversized");
    writeFileSync(oversizedInput, Buffer.alloc(8_194, 0x61), { mode: 0o600 });
    chmodSync(oversizedInput, 0o600);
    unsafeInputs.push(oversizedInput);

    const emptyInput = join(home, "bootstrap-empty");
    writeFileSync(emptyInput, "", { mode: 0o600 });
    chmodSync(emptyInput, 0o600);
    unsafeInputs.push(emptyInput);

    for (const inputPath of unsafeInputs) {
      const rejected = createHarness(home);
      globalThis.__hostDeploymentHarness = rejected;
      await assert.rejects(
        module.runRelayV2HostShippingFromTrustedDeployment(inputPath),
        (error) => error?.code === "ACTIVATION_FAILED"
          && error?.cause === undefined
          && !String(error).includes(inputPath),
      );
      assert.equal(
        rejected.events.some(([name]) => name === "native.create"),
        false,
      );
      assert.equal(rejected.events.at(-1)[0], "signal.close");
    }

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

    const finalFenceInterrupted = createHarness(home);
    finalFenceInterrupted.abortAfterIntakeOpen = true;
    globalThis.__hostDeploymentHarness = finalFenceInterrupted;
    assert.equal(await module.runRelayV2HostShippingFromTrustedDeployment(), 0);
    assert.equal(
      finalFenceInterrupted.events.some(([name]) => name === "process.run"),
      false,
    );
    assert.deepEqual(
      finalFenceInterrupted.events
        .filter(([name]) => [
          "lifecycle.close",
          "intake.close",
          "spool.close",
          "state.close",
          "runtime.close",
          "native.close",
          "signal.close",
        ].includes(name))
        .map(([name]) => name),
      [
        "lifecycle.close",
        "intake.close",
        "spool.close",
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
