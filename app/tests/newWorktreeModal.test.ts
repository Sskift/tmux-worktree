import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createLatestRequestGate,
  requestSourceKey,
} from "../src/latestRequestGate.ts";
import { shouldApplyWorktreeCatalogDefault } from "../src/NewWorktreeModal.tsx";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, reject, resolve };
}

test("new worktree project picker uses the shared menu select", () => {
  const modal = readFileSync(new URL("../src/NewWorktreeModal.tsx", import.meta.url), "utf8");

  assert.match(modal, /import \{ MenuSelect, type MenuOption \} from "\.\/MenuSelect";/);
  assert.match(modal, /const projectMenuOptions\s*:\s*MenuOption\[\]/);
  assert.match(modal, /<MenuSelect\s+ariaLabel="Project"/);
  assert.doesNotMatch(modal, /<select[^>]*value=\{project\}/);
});

test("new worktree remote hosts can use remote project presets", () => {
  const modal = readFileSync(new URL("../src/NewWorktreeModal.tsx", import.meta.url), "utf8");
  const backend = readFileSync(new URL("../src/platform/dashboardBackend.ts", import.meta.url), "utf8");

  assert.match(modal, /dashboardBackend\.projects\.listRemote\(selectedHost\)/);
  assert.match(
    backend,
    /listRemote: \(hostId\) =>\s*transport\.invoke<ProjectPreset\[\]>\("list_remote_projects", \{ hostId \}\)/s,
  );
  assert.match(modal, /createArgs\.project = project;/);
  assert.doesNotMatch(modal, /const isCustom = project === CUSTOM \|\| isRemote;/);
});

test("new worktree publishes catalogs only for the current Local/Host A/Host B source", async () => {
  const gate = createLatestRequestGate();
  const localProjects = deferred<string[]>();
  const localOrphans = deferred<string[]>();
  const hostAProjects = deferred<string[]>();
  const hostBProjects = deferred<string[]>();
  let projects: string[] = [];
  let orphans: string[] = [];
  let error: string | null = null;

  const loadSource = (
    source: string,
    projectRequest: Promise<string[]>,
    orphanRequest?: Promise<string[]>,
  ) => {
    const token = gate.issue(requestSourceKey("new-worktree-catalog", source));
    projects = [];
    orphans = [];
    error = null;
    const publications = [
      projectRequest.then(
        (list) => {
          if (gate.isCurrent(token)) projects = list;
        },
        (reason) => {
          if (gate.isCurrent(token)) error = String(reason);
        },
      ),
    ];
    if (orphanRequest) {
      publications.push(orphanRequest.then((list) => {
        if (gate.isCurrent(token)) orphans = list;
      }));
    }
    return Promise.all(publications);
  };

  const localPublication = loadSource(
    "__local__",
    localProjects.promise,
    localOrphans.promise,
  );
  const hostAPublication = loadSource("host-a", hostAProjects.promise);
  const hostBPublication = loadSource("host-b", hostBProjects.promise);

  localProjects.resolve(["local-old"]);
  localOrphans.resolve(["orphan-old"]);
  hostAProjects.reject(new Error("host A unavailable"));
  hostBProjects.resolve(["host-b-current"]);
  await Promise.all([localPublication, hostAPublication, hostBPublication]);

  assert.deepEqual(projects, ["host-b-current"]);
  assert.deepEqual(orphans, []);
  assert.equal(error, null);
});

test("new worktree invalidates a catalog immediately when the host menu changes", () => {
  const modal = readFileSync(new URL("../src/NewWorktreeModal.tsx", import.meta.url), "utf8");

  assert.match(modal, /catalogRequestGateRef = useRef\(createLatestRequestGate\(\)\)/);
  assert.match(modal, /requestSourceKey\("new-worktree-catalog", selectedHost\)/);
  assert.match(modal, /if \(!requestGate\.isCurrent\(token\)\) return;/);
  assert.match(modal, /const changeHost = \(hostId: string\) => \{\s*catalogRequestGateRef\.current\.invalidate\(\)/s);
  assert.match(modal, /onChange=\{changeHost\}/);
});

test("new worktree catalog defaults never replace a Custom draft edited for the current source", async () => {
  assert.equal(
    shouldApplyWorktreeCatalogDefault({ source: "host-a", dirty: false }, "host-a"),
    true,
  );
  assert.equal(
    shouldApplyWorktreeCatalogDefault({ source: "host-a", dirty: true }, "host-a"),
    false,
  );
  assert.equal(
    shouldApplyWorktreeCatalogDefault({ source: "host-a", dirty: false }, "host-b"),
    false,
  );

  const delayedCatalog = deferred<string[]>();
  let draftState = { source: "host-a", dirty: false };
  let project = "__custom__";
  let customPath = "";
  const publication = delayedCatalog.promise.then((projects) => {
    if (shouldApplyWorktreeCatalogDefault(draftState, "host-a")) {
      project = projects[0] ?? "__custom__";
    }
  });

  draftState = { source: "host-a", dirty: true };
  customPath = "/srv/repos/custom-dashboard";
  delayedCatalog.resolve(["default-dashboard"]);
  await publication;

  assert.equal(project, "__custom__");
  assert.equal(customPath, "/srv/repos/custom-dashboard");

  const modal = readFileSync(new URL("../src/NewWorktreeModal.tsx", import.meta.url), "utf8");
  assert.match(modal, /catalogDraftStateRef = useRef<WorktreeCatalogDraftState>/);
  assert.match(
    modal,
    /if \(\s*shouldApplyWorktreeCatalogDefault\(catalogDraftStateRef\.current, selectedHost\)/s,
  );
  assert.match(modal, /onChange=\{changeProject\}/);
  assert.match(modal, /markCatalogDraftDirty\(\);\s*setCustomPath/s);
});

test("automation panel reuses the shared menu select component", () => {
  const panel = readFileSync(new URL("../src/AutomationPanel.tsx", import.meta.url), "utf8");

  assert.match(panel, /import \{ MenuSelect, type MenuOption \} from "\.\/MenuSelect";/);
  assert.doesNotMatch(panel, /function AutomationMenuSelect/);
});
