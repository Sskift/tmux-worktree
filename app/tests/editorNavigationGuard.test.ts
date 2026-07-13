import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  editingFileSourceKey,
  runGuardedEditorNavigation,
  runGuardedWorkspaceNavigation,
  type EditorDirtySnapshot,
} from "../src/editorNavigationGuard.ts";
import {
  beginFileEditorLoad,
  completeFileEditorLoad,
  editFileEditorContent,
  isFileEditorDirty,
  markFileEditorSaved,
} from "../src/fileEditorDirtyState.ts";
import { createLatestRequestGate } from "../src/latestRequestGate.ts";
import { createEditorNavigationController } from "../src/dashboard/navigation/editorNavigationController.ts";
import {
  readRendererImplementationTree,
  rendererImplementationSourceContaining,
} from "./helpers/rendererImplementationSource.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type HookGuard = {
  requestEditorNavigation(
    navigate: () => void,
    options?: { ignoreAutomationDirty?: boolean },
  ): Promise<boolean>;
  handleEditorDirtyChange(dirty: boolean): void;
  handleAutomationDirtyChange(dirty: boolean): void;
};

type HookOptions = {
  dashboardBackend: {
    dialog: {
      confirm(options: { title: string; message: string }): Promise<boolean>;
    };
  };
  editingFile: { path: string; hostId?: string | null } | null;
  automationDraftKey: string | null;
};

type CapturedLayoutEffect = {
  callback: () => void | (() => void);
  dependencies: unknown[];
};

function loadEditorNavigationHookHarness() {
  const refs: Array<{ current: unknown }> = [];
  const committed = new Map<number, CapturedLayoutEffect & { cleanup?: () => void }>();
  let cursor = 0;
  let pending = new Map<number, CapturedLayoutEffect>();
  const source = readFileSync(
    new URL("../src/dashboard/hooks/useEditorNavigationGuard.ts", import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "useEditorNavigationGuard.ts",
  });
  const react = {
    useRef(initial: unknown) {
      const index = cursor++;
      if (!refs[index]) refs[index] = { current: initial };
      return refs[index];
    },
    useLayoutEffect(
      callback: CapturedLayoutEffect["callback"],
      dependencies: unknown[],
    ) {
      pending.set(cursor++, { callback, dependencies });
    },
  };
  const modules = new Map<string, unknown>([
    ["react", react],
    ["../../editorNavigationGuard", { editingFileSourceKey }],
    ["../model/terminalIdentity", {
      basenameFromPath: (path?: string | null) => path?.split("/").filter(Boolean).at(-1) ?? "",
    }],
    ["../navigation/editorNavigationController", { createEditorNavigationController }],
  ]);
  const module = { exports: {} as Record<string, unknown> };
  const evaluate = new Function("require", "exports", "module", output.outputText);
  evaluate((specifier: string) => {
    assert.equal(modules.has(specifier), true, `unexpected module ${specifier}`);
    return modules.get(specifier);
  }, module.exports, module);
  const useEditorNavigationGuard = module.exports.useEditorNavigationGuard as (
    options: HookOptions,
  ) => HookGuard;
  const useEditorNavigationGuardLifecyclePhase =
    module.exports.useEditorNavigationGuardLifecyclePhase as (
      guard: HookGuard,
      options: HookOptions,
    ) => void;

  const sameDependencies = (left: unknown[], right: unknown[]) =>
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

  return {
    render(options: HookOptions) {
      cursor = 0;
      pending = new Map();
      const guard = useEditorNavigationGuard(options);
      useEditorNavigationGuardLifecyclePhase(guard, options);
      const renderedEffects = pending;
      return {
        guard,
        abort() {
          if (pending === renderedEffects) pending = new Map();
        },
        commit() {
          for (const [index, next] of renderedEffects) {
            const previous = committed.get(index);
            if (previous && sameDependencies(previous.dependencies, next.dependencies)) {
              continue;
            }
            previous?.cleanup?.();
            const cleanup = next.callback();
            committed.set(index, {
              ...next,
              ...(typeof cleanup === "function" ? { cleanup } : {}),
            });
          }
          if (pending === renderedEffects) pending = new Map();
        },
      };
    },
    strictModeReplay() {
      const effects = [...committed.entries()].sort(([left], [right]) => left - right);
      for (const [, effect] of effects) effect.cleanup?.();
      for (const [index, effect] of effects) {
        const cleanup = effect.callback();
        committed.set(index, {
          callback: effect.callback,
          dependencies: effect.dependencies,
          ...(typeof cleanup === "function" ? { cleanup } : {}),
        });
      }
    },
    unmount() {
      for (const [, effect] of [...committed.entries()].reverse()) {
        effect.cleanup?.();
      }
      committed.clear();
    },
  };
}

function hookBackend(
  name: string,
  confirm: (options: { title: string; message: string }) => Promise<boolean>,
) {
  const calls: Array<{ title: string; message: string }> = [];
  return {
    name,
    calls,
    backend: {
      dialog: {
        confirm(options: { title: string; message: string }) {
          calls.push(options);
          return confirm(options);
        },
      },
    },
  };
}

test("dirty state resets after save and every file load", () => {
  let state = beginFileEditorLoad("local:a");
  assert.equal(isFileEditorDirty(state), false);

  state = completeFileEditorLoad(state, "local:a", "one");
  assert.equal(isFileEditorDirty(state), false);
  state = editFileEditorContent(state, "local:a", "two");
  assert.equal(isFileEditorDirty(state), true);
  state = markFileEditorSaved(state, "local:a", "two");
  assert.equal(isFileEditorDirty(state), false);

  state = editFileEditorContent(state, "local:a", "three");
  assert.equal(isFileEditorDirty(state), true);
  state = editFileEditorContent(state, "local:a", "four");
  state = markFileEditorSaved(state, "local:a", "three");
  assert.equal(isFileEditorDirty(state), true, "edits made during a save stay dirty");
  state = beginFileEditorLoad("remote:b");
  assert.equal(isFileEditorDirty(state), false);
  state = completeFileEditorLoad(state, "remote:b", "remote content");
  assert.equal(isFileEditorDirty(state), false);
});

test("clean navigation proceeds without prompting and dirty cancellation stays put", async () => {
  const gate = createLatestRequestGate();
  const fileKey = editingFileSourceKey({ path: "/repo/a.ts", hostId: null });
  let snapshot: EditorDirtySnapshot = { fileKey, dirty: false, revision: 1 };
  let navigations = 0;
  let confirmations = 0;

  assert.equal(await runGuardedEditorNavigation({
    gate,
    snapshot,
    getCurrentSnapshot: () => snapshot,
    confirmDiscard: async () => {
      confirmations += 1;
      return true;
    },
    navigate: () => {
      navigations += 1;
    },
  }), true);
  assert.equal(confirmations, 0);
  assert.equal(navigations, 1);

  snapshot = { ...snapshot, dirty: true, revision: 2 };
  assert.equal(await runGuardedEditorNavigation({
    gate,
    snapshot,
    getCurrentSnapshot: () => snapshot,
    confirmDiscard: async () => false,
    navigate: () => {
      navigations += 1;
    },
  }), false);
  assert.equal(navigations, 1);
});

test("late confirmations cannot replay an older navigation intent", async () => {
  const gate = createLatestRequestGate();
  const snapshot: EditorDirtySnapshot = {
    fileKey: editingFileSourceKey({ path: "/repo/a.ts", hostId: "builder" }),
    dirty: true,
    revision: 4,
  };
  const firstConfirm = deferred<boolean>();
  const secondConfirm = deferred<boolean>();
  const navigations: string[] = [];

  const first = runGuardedEditorNavigation({
    gate,
    snapshot,
    getCurrentSnapshot: () => snapshot,
    confirmDiscard: () => firstConfirm.promise,
    navigate: () => navigations.push("first"),
  });
  const second = runGuardedEditorNavigation({
    gate,
    snapshot,
    getCurrentSnapshot: () => snapshot,
    confirmDiscard: () => secondConfirm.promise,
    navigate: () => navigations.push("second"),
  });

  secondConfirm.resolve(true);
  assert.equal(await second, true);
  firstConfirm.resolve(true);
  assert.equal(await first, false);
  assert.deepEqual(navigations, ["second"]);
});

test("a confirmation is stale after the active document revision changes", async () => {
  const gate = createLatestRequestGate();
  let snapshot: EditorDirtySnapshot = {
    fileKey: editingFileSourceKey({ path: "/repo/a.ts", hostId: null }),
    dirty: true,
    revision: 1,
  };
  const confirm = deferred<boolean>();
  let navigated = false;
  const request = runGuardedEditorNavigation({
    gate,
    snapshot,
    getCurrentSnapshot: () => snapshot,
    confirmDiscard: () => confirm.promise,
    navigate: () => {
      navigated = true;
    },
  });

  snapshot = { ...snapshot, dirty: false, revision: 2 };
  confirm.resolve(true);
  assert.equal(await request, false);
  assert.equal(navigated, false);
});

test("workspace navigation protects an unsaved automation draft", async () => {
  const gate = createLatestRequestGate();
  let file = { key: null, dirty: false, revision: 0 };
  let automation = { key: "automation:daily", dirty: true, revision: 3 };
  let navigated = false;

  assert.equal(await runGuardedWorkspaceNavigation({
    gate,
    surfaces: [
      { ...file, getCurrent: () => file, confirmDiscard: async () => true },
      { ...automation, getCurrent: () => automation, confirmDiscard: async () => false },
    ],
    navigate: () => {
      navigated = true;
    },
  }), false);
  assert.equal(navigated, false);

  assert.equal(await runGuardedWorkspaceNavigation({
    gate,
    surfaces: [
      { ...file, getCurrent: () => file, confirmDiscard: async () => true },
      { ...automation, getCurrent: () => automation, confirmDiscard: async () => true },
    ],
    navigate: () => {
      navigated = true;
      automation = { ...automation, dirty: false, revision: 4 };
    },
  }), true);
  assert.equal(navigated, true);
});

test("the editor navigation controller preserves dirty revision and key rollover rules", async () => {
  const backend = {};
  const controller = createEditorNavigationController({
    backendOwner: backend,
    editorKey: "local:a",
    automationKey: "automation:daily",
  });
  controller.activate();

  assert.deepEqual(controller.automationSubmitOwner(), {
    contextKey: "automation:daily",
    revision: 0,
  });
  controller.automationDirtyChanged(true);
  assert.equal(controller.automationSubmitOwner().revision, 1);
  controller.automationDirtyChanged(true);
  assert.equal(controller.automationSubmitOwner().revision, 2);
  controller.automationDirtyChanged(false);
  assert.equal(controller.automationSubmitOwner().revision, 3);
  controller.automationDirtyChanged(false);
  assert.equal(controller.automationSubmitOwner().revision, 3);

  controller.editorDirtyChanged(true);
  controller.syncContext({
    backendOwner: backend,
    editorKey: "local:b",
    automationKey: "automation:next",
  });
  assert.deepEqual(controller.automationSubmitOwner(), {
    contextKey: "automation:next",
    revision: 4,
  });
  let confirmations = 0;
  assert.equal(await controller.request({
    confirmEditorDiscard: async () => {
      confirmations += 1;
      return true;
    },
    confirmAutomationDiscard: async () => {
      confirmations += 1;
      return true;
    },
    navigate: () => {},
  }), true);
  assert.equal(confirmations, 0, "key rollover must reset both dirty surfaces");
  assert.equal(controller.automationSubmitOwner().revision, 5);
});

test("the controller prompts editor then automation and clears both before navigation", async () => {
  const controller = createEditorNavigationController({
    backendOwner: {},
    editorKey: "local:a",
    automationKey: "automation:daily",
  });
  controller.activate();
  controller.editorDirtyChanged(true);
  controller.automationDirtyChanged(true);
  const order: string[] = [];
  const ownerBefore = controller.automationSubmitOwner();

  assert.equal(await controller.request({
    confirmEditorDiscard: async () => {
      order.push("editor");
      return true;
    },
    confirmAutomationDiscard: async () => {
      order.push("automation");
      return true;
    },
    navigate: () => {
      order.push("navigate");
      assert.equal(
        controller.automationSubmitOwner().revision,
        ownerBefore.revision + 1,
        "both surfaces must reset before business navigation",
      );
    },
  }), true);
  assert.deepEqual(order, ["editor", "automation", "navigate"]);

  let promptedAgain = false;
  assert.equal(await controller.request({
    confirmEditorDiscard: async () => {
      promptedAgain = true;
      return true;
    },
    confirmAutomationDiscard: async () => {
      promptedAgain = true;
      return true;
    },
    navigate: () => {},
  }), true);
  assert.equal(promptedAgain, false);
});

test("the controller rechecks every surface and ignore only suppresses the automation prompt", async () => {
  const controller = createEditorNavigationController({
    backendOwner: {},
    editorKey: "local:a",
    automationKey: "automation:daily",
  });
  controller.activate();
  controller.automationDirtyChanged(true);
  const automationConfirm = deferred<boolean>();
  let navigated = false;
  const request = controller.request({
    confirmEditorDiscard: async () => true,
    confirmAutomationDiscard: () => automationConfirm.promise,
    navigate: () => {
      navigated = true;
    },
  });
  controller.editorDirtyChanged(true);
  automationConfirm.resolve(true);
  assert.equal(await request, false, "the final all-surface recheck must see editor changes");
  assert.equal(navigated, false);

  const editorConfirm = deferred<boolean>();
  let automationPrompts = 0;
  const ignored = controller.request({
    confirmEditorDiscard: () => editorConfirm.promise,
    confirmAutomationDiscard: async () => {
      automationPrompts += 1;
      return true;
    },
    ignoreAutomationDirty: true,
    navigate: () => {
      navigated = true;
    },
  });
  controller.automationDirtyChanged(true);
  editorConfirm.resolve(true);
  assert.equal(await ignored, false, "ignored automation dirty must still retain its revision fence");
  assert.equal(automationPrompts, 0);
  assert.equal(navigated, false);
});

test("latest requests, backend owners, and same-owner renders fence confirmations", async () => {
  const backendA = {};
  const backendB = {};
  const controller = createEditorNavigationController({
    backendOwner: backendA,
    editorKey: "local:a",
    automationKey: null,
  });
  controller.activate();
  controller.editorDirtyChanged(true);
  const firstConfirm = deferred<boolean>();
  const secondConfirm = deferred<boolean>();
  const navigations: string[] = [];
  const first = controller.request({
    confirmEditorDiscard: () => firstConfirm.promise,
    confirmAutomationDiscard: async () => true,
    navigate: () => navigations.push("first"),
  });
  const second = controller.request({
    confirmEditorDiscard: () => secondConfirm.promise,
    confirmAutomationDiscard: async () => true,
    navigate: () => navigations.push("second"),
  });
  secondConfirm.resolve(true);
  assert.equal(await second, true);
  firstConfirm.resolve(true);
  assert.equal(await first, false);
  assert.deepEqual(navigations, ["second"]);

  controller.editorDirtyChanged(true);
  const sameOwnerConfirm = deferred<boolean>();
  const sameOwnerRequest = controller.request({
    confirmEditorDiscard: () => sameOwnerConfirm.promise,
    confirmAutomationDiscard: async () => true,
    navigate: () => navigations.push("same-owner"),
  });
  controller.syncContext({
    backendOwner: backendA,
    editorKey: "local:a",
    automationKey: null,
  });
  sameOwnerConfirm.resolve(true);
  assert.equal(await sameOwnerRequest, true, "an identical render must not cancel the request");

  controller.editorDirtyChanged(true);
  const backendAConfirm = deferred<boolean>();
  const backendARequest = controller.request({
    confirmEditorDiscard: () => backendAConfirm.promise,
    confirmAutomationDiscard: async () => true,
    navigate: () => navigations.push("backend-a"),
  });
  controller.syncContext({
    backendOwner: backendB,
    editorKey: "local:a",
    automationKey: null,
  });
  backendAConfirm.resolve(true);
  assert.equal(await backendARequest, false);
  assert.equal(await controller.request({
    confirmEditorDiscard: async () => true,
    confirmAutomationDiscard: async () => true,
    navigate: () => navigations.push("backend-b"),
  }), true);
  assert.deepEqual(navigations, ["second", "same-owner", "backend-b"]);
});

test("inactive, unmounted, and StrictMode-style controllers cannot publish late navigation", async () => {
  const controller = createEditorNavigationController({
    backendOwner: {},
    editorKey: "local:a",
    automationKey: null,
  });
  let navigations = 0;
  let confirmations = 0;
  const options = {
    confirmEditorDiscard: async () => {
      confirmations += 1;
      return true;
    },
    confirmAutomationDiscard: async () => true,
    navigate: () => {
      navigations += 1;
    },
  };
  assert.equal(await controller.request(options), false);
  assert.equal(confirmations, 0);

  controller.activate();
  controller.editorDirtyChanged(true);
  const lateConfirm = deferred<boolean>();
  const late = controller.request({
    ...options,
    confirmEditorDiscard: () => lateConfirm.promise,
  });
  controller.deactivate();
  lateConfirm.resolve(true);
  assert.equal(await late, false);
  assert.equal(navigations, 0);

  controller.activate();
  assert.equal(await controller.request(options), true);
  assert.equal(navigations, 1, "StrictMode cleanup/setup must reactivate the same controller");
});

test("dialog rejection remains a rejection and never navigates", async () => {
  const controller = createEditorNavigationController({
    backendOwner: {},
    editorKey: "local:a",
    automationKey: null,
  });
  controller.activate();
  controller.editorDirtyChanged(true);
  let navigated = false;
  await assert.rejects(
    controller.request({
      confirmEditorDiscard: async () => {
        throw new Error("dialog unavailable");
      },
      confirmAutomationDiscard: async () => true,
      navigate: () => {
        navigated = true;
      },
    }),
    /dialog unavailable/,
  );
  assert.equal(navigated, false);
});

test("a stale terminal callback consults the latest committed editing-file cut", () => {
  const committedEditingFileRef: {
    current: { path: string; hostId: string | null } | null;
  } = {
    current: { path: "/repo/a.ts", hostId: null },
  };
  const staleTerminalCallback = (next: { path: string; hostId: string | null }) =>
    editingFileSourceKey(committedEditingFileRef.current) === editingFileSourceKey(next);

  committedEditingFileRef.current = { path: "/repo/c.ts", hostId: null };
  assert.equal(
    staleTerminalCallback({ path: "/repo/a.ts", hostId: null }),
    false,
    "an async callback captured on A must not bypass the dirty guard after C commits",
  );
  assert.equal(
    staleTerminalCallback({ path: "/repo/c.ts", hostId: null }),
    true,
    "same-file line navigation must still use the latest committed file",
  );
});

test("layout commit publishes the guard while an aborted render cannot replace its backend or file", async () => {
  const harness = loadEditorNavigationHookHarness();
  const sameContextConfirm = deferred<boolean>();
  const backendAResponses = [Promise.resolve(true), sameContextConfirm.promise];
  const backendA = hookBackend("A", async () => (await backendAResponses.shift()) ?? true);
  const backendB = hookBackend("B", async () => true);
  const optionsA: HookOptions = {
    dashboardBackend: backendA.backend,
    editingFile: { path: "/repo/a.ts", hostId: null },
    automationDraftKey: "automation:a",
  };
  const initial = harness.render(optionsA);
  let navigations = 0;
  initial.guard.handleEditorDirtyChange(true);
  assert.equal(await initial.guard.requestEditorNavigation(() => {
    navigations += 1;
  }), false, "the guard must stay inactive before its layout commit");
  assert.equal(backendA.calls.length, 0);

  initial.commit();
  initial.guard.handleEditorDirtyChange(true);
  const suspendedB = harness.render({
    dashboardBackend: backendB.backend,
    editingFile: { path: "/repo/b.ts", hostId: "remote" },
    automationDraftKey: "automation:b",
  });
  suspendedB.abort();
  assert.equal(await initial.guard.requestEditorNavigation(() => {
    navigations += 1;
  }), true);
  assert.equal(navigations, 1);
  assert.equal(backendB.calls.length, 0);
  assert.equal(backendA.calls.at(-1)?.title, "Discard unsaved changes?");
  assert.match(backendA.calls.at(-1)?.message ?? "", /Changes to a\.ts/);

  initial.guard.handleEditorDirtyChange(true);
  const pendingSameContext = initial.guard.requestEditorNavigation(() => {
    navigations += 1;
  });
  const sameCommittedContext = harness.render({
    ...optionsA,
    editingFile: { path: "/repo/a.ts", hostId: null, line: 42 },
  } as HookOptions);
  sameCommittedContext.commit();
  sameContextConfirm.resolve(true);
  assert.equal(
    await pendingSameContext,
    true,
    "an object-only editingFile update must not deactivate a pending confirmation",
  );
  assert.equal(navigations, 2);
});

test("backend layout commits fence pending dialogs and StrictMode replay reactivates before input", async () => {
  const harness = loadEditorNavigationHookHarness();
  const oldBackendConfirm = deferred<boolean>();
  const strictConfirm = deferred<boolean>();
  const unmountConfirm = deferred<boolean>();
  const backendA = hookBackend("A", () => oldBackendConfirm.promise);
  const backendBResponses = [
    Promise.resolve(true),
    strictConfirm.promise,
    Promise.resolve(true),
    unmountConfirm.promise,
  ];
  const backendB = hookBackend("B", async () => (await backendBResponses.shift()) ?? true);
  const mounted = harness.render({
    dashboardBackend: backendA.backend,
    editingFile: { path: "/repo/a.ts" },
    automationDraftKey: null,
  });
  mounted.commit();
  mounted.guard.handleEditorDirtyChange(true);
  let navigations = 0;
  const oldRequest = mounted.guard.requestEditorNavigation(() => {
    navigations += 1;
  });

  const switched = harness.render({
    dashboardBackend: backendB.backend,
    editingFile: { path: "/repo/b.ts", hostId: "builder" },
    automationDraftKey: null,
  });
  switched.commit();
  oldBackendConfirm.resolve(true);
  assert.equal(await oldRequest, false);
  assert.equal(navigations, 0);

  mounted.guard.handleEditorDirtyChange(true);
  assert.equal(await mounted.guard.requestEditorNavigation(() => {
    navigations += 1;
  }), true, "the committed layout setup must activate before interaction");
  assert.match(backendB.calls.at(-1)?.message ?? "", /Changes to b\.ts/);

  mounted.guard.handleEditorDirtyChange(true);
  const strictPending = mounted.guard.requestEditorNavigation(() => {
    navigations += 1;
  });
  harness.strictModeReplay();
  strictConfirm.resolve(true);
  assert.equal(await strictPending, false);
  assert.equal(await mounted.guard.requestEditorNavigation(() => {
    navigations += 1;
  }), true, "StrictMode setup must reactivate the same committed registration");

  mounted.guard.handleEditorDirtyChange(true);
  const unmountedPending = mounted.guard.requestEditorNavigation(() => {
    navigations += 1;
  });
  harness.unmount();
  unmountConfirm.resolve(true);
  assert.equal(await unmountedPending, false);
  assert.equal(navigations, 2);
});

test("the renderer guards every editor-destructive routing entry point", () => {
  const renderer = readRendererImplementationTree();
  const editor = readFileSync(new URL("../src/FileEditor.tsx", import.meta.url), "utf8");

  assert.match(editor, /onDirtyChange\?: \(dirty: boolean\) => void/);
  assert.match(editor, /publishDirty\(isFileEditorDirty\(dirtyStateRef\.current\)\)/);
  assert.match(editor, /markFileEditorSaved/);
  assert.match(editor, /beginFileEditorLoad/);

  for (const handler of [
    "const closeEditingFile = useCallback",
    "const handleOpenFile = useCallback",
    "const selectSession = useCallback",
    "const selectTerminal = useCallback",
    "const selectAutomation = useCallback",
    "const openGitDiff = useCallback",
  ]) {
    const source = rendererImplementationSourceContaining(handler, "requestEditorNavigation").source;
    assert.ok(
      source.indexOf(handler) < source.indexOf("requestEditorNavigation", source.indexOf(handler)),
      `${handler} should route through requestEditorNavigation in the same implementation file`,
    );
  }
  assert.doesNotMatch(renderer, /expandInspectorView|renderExpandedView/);
  const composition = rendererImplementationSourceContaining(
    'diffFile ? (',
    "onDirtyChange={handleEditorDirtyChange}",
    "onDirtyChange={handleAutomationDirtyChange}",
    "onNew={handleNewAutomation}",
  ).source;
  assert.match(composition, /diffFile \? \(\s*<div className="dashboard-workspace__editor">/);
  assert.match(composition, /onDirtyChange=\{handleEditorDirtyChange\}/);
  assert.match(composition, /onDirtyChange=\{handleAutomationDirtyChange\}/);
  assert.match(composition, /onNew=\{handleNewAutomation\}/);
  const automationCoordinator = rendererImplementationSourceContaining(
    "automationSubmitStillOwnsDraft(",
    "originatingDraft",
    "navigateToSavedAutomation",
  ).source;
  assert.match(
    automationCoordinator,
    /automationSubmitStillOwnsDraft\(\s*originatingDraft/,
  );
  const automationSelection = rendererImplementationSourceContaining(
    "automationSelectionIsCurrent(",
    "return Promise.resolve(false)",
  ).source;
  assert.match(automationSelection, /automationSelectionIsCurrent\([\s\S]*?return Promise\.resolve\(false\)/);
});
