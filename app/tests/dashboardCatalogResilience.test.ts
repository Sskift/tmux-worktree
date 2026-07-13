import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/dashboard/hooks/useConnectionCatalog.ts", import.meta.url),
  "utf8",
);

test("Host catalog retries until authoritative hydration succeeds", () => {
  assert.match(source, /const request: HostCatalogRequest = \{/);
  assert.match(source, /registration\.hostCatalogRequest = request/);
  assert.match(source, /enabled: connectionCatalog\.hostsHydrationGeneration === 0 \|\|/);
  assert.match(source, /connectionCatalog\.catalogReloadRequired/);
  assert.match(source, /HOST_CATALOG_RETRY_MS/);
  assert.match(source, /registration\.hostsHydrationGeneration \+= 1/);
  assert.doesNotMatch(
    source.slice(source.indexOf("async function loadHostsForOwner"), source.indexOf("function publishHostsForOwner")),
    /registration\.hosts = \[\]/,
  );
});

test("same-ID Host endpoint edits invalidate and gate old status responses", () => {
  assert.match(source, /function hostCatalogSourceKey\(hosts: readonly HostConfig\[\]\)/);
  assert.match(source, /return JSON\.stringify\(hosts\.map\(hostFingerprint\)\)/);
  for (const field of ["host.id", "host.label", "host.host", "host.user", "host.port", "host.identityFile", "host.worktreeBase", "host.tmuxPath", "host.twPath"]) {
    assert.ok(source.includes(field), `status refresh identity should include ${field}`);
  }
  assert.match(source, /const request: HostStatusRequest = \{/);
  assert.match(source, /statusRequestIsCurrent\(registration, request\)/);
  assert.match(source, /registration\.statusRequest = null;\s*registration\.hostStatuses = \{\}/);
  assert.match(source, /refreshKey: hostStatusSourceKey/);
});

test("install failures reject so Settings cannot report false success", () => {
  const installStart = source.indexOf("async function installRemoteTwForOwner");
  const installEnd = source.indexOf("function createConnectionCatalogRegistration", installStart);
  const installSource = source.slice(installStart, installEnd);

  assert.match(installSource, /previousStatus: registration\.hostStatuses\[hostId\] \?\? null/);
  assert.match(installSource, /catch \(error\)/);
  assert.match(installSource, /throw error/);
});
