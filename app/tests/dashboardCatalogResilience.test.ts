import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/dashboard/hooks/useDashboardCatalog.ts", import.meta.url),
  "utf8",
);

test("Host catalog retries until authoritative hydration succeeds", () => {
  assert.match(source, /const request = \+\+hostCatalogRequestRef\.current/);
  assert.match(source, /enabled: hostsHydrationGeneration === 0/);
  assert.match(source, /HOST_CATALOG_RETRY_MS/);
  assert.match(source, /setHostsHydrationGeneration\(\(generation\) => generation \+ 1\)/);
  assert.doesNotMatch(
    source.slice(source.indexOf("const loadHosts"), source.indexOf("useVisibilityAwarePolling(loadHosts")),
    /setHostsState\(\[\]\)/,
  );
});

test("same-ID Host endpoint edits invalidate and gate old status responses", () => {
  assert.match(source, /const hostStatusRefreshKey = useMemo\(\(\) => JSON\.stringify/);
  for (const field of ["host.host", "host.user", "host.port", "host.identityFile", "host.tmuxPath", "host.twPath"]) {
    assert.ok(source.includes(field), `status refresh identity should include ${field}`);
  }
  assert.match(source, /const request = \+\+hostStatusRequestRef\.current/);
  assert.match(source, /request !== hostStatusRequestRef\.current/);
  assert.match(source, /hostStatusRequestRef\.current \+= 1;\s*setHostStatuses\(\{\}\)/);
  assert.match(source, /refreshKey: hostStatusRefreshKey/);
});

test("install failures reject so Settings cannot report false success", () => {
  const installStart = source.indexOf("const installRemoteTw");
  const installEnd = source.indexOf("const hostStatusRefreshKey", installStart);
  const installSource = source.slice(installStart, installEnd);

  assert.match(installSource, /catch \(err\)/);
  assert.match(installSource, /throw err/);
});
