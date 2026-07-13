import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  readRendererImplementationTree,
} from "./helpers/rendererImplementationSource.ts";

const rendererSource = readRendererImplementationTree();
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const workspaceSource = appSource;
const primarySource = readFileSync(
  new URL("../src/dashboard/WorkspacePrimaryView.tsx", import.meta.url),
  "utf8",
);
const presentationSource = readFileSync(
  new URL("../src/dashboard/model/workspacePresentation.ts", import.meta.url),
  "utf8",
);
const selectionHydrationSource = readFileSync(
  new URL(
    "../src/dashboard/hooks/useCatalogSelectionHydration.ts",
    import.meta.url,
  ),
  "utf8",
);
const terminalDeckStateSource = readFileSync(
  new URL("../src/dashboard/hooks/useTerminalDeckState.ts", import.meta.url),
  "utf8",
);
const deckSource = readFileSync(
  new URL("../src/dashboard/TerminalDeck.tsx", import.meta.url),
  "utf8",
);
const headerSource = readFileSync(
  new URL("../src/dashboard/WorkspaceHeader.tsx", import.meta.url),
  "utf8",
);

test("main workspace keeps TerminalDeck mounted while automation owns the visible pane", () => {
  const workspaceStart = workspaceSource.indexOf("const centralWorkspace");
  const primaryIndex = workspaceSource.indexOf("<WorkspacePrimaryView", workspaceStart);
  const workspaceEnd = workspaceSource.indexOf("const overlays", primaryIndex);
  const deckIndex = primarySource.indexOf("<TerminalDeck");
  const automationIndex = primarySource.indexOf('context.kind === "automation"', deckIndex);

  assert.ok(workspaceStart >= 0, "central workspace should exist");
  assert.ok(primaryIndex > workspaceStart, "primary view should be a direct workspace child");
  assert.ok(deckIndex >= 0, "TerminalDeck should be a direct primary-view child");
  assert.ok(
    automationIndex > deckIndex,
    "TerminalDeck should render before the conditional automation pane",
  );
  assert.ok(workspaceEnd > primaryIndex, "the primary view should remain inside the central workspace");
  assert.equal(
    rendererSource.match(/<TerminalDeck\b/g)?.length,
    1,
    "App should have one unconditional terminal deck instance",
  );
  assert.match(presentationSource, /const terminalVisible = metadataPending \|\|/);
  assert.match(workspaceSource, /visible: workspacePresentation\.terminalVisible/);
  assert.match(workspaceSource, /blocked: workspaceInteractionBlocked/);
});

test("display none hides the deck without removing terminal components from the React tree", () => {
  const componentStart = deckSource.indexOf("export function TerminalDeck");
  const hiddenStyleIndex = deckSource.indexOf(
    'style={{ display: visible ? undefined : "none" }}',
    componentStart,
  );
  const sessionMapIndex = deckSource.indexOf("openedSessions.map", hiddenStyleIndex);
  const terminalMapIndex = deckSource.indexOf("openedTerminals.map", sessionMapIndex);

  assert.ok(componentStart >= 0, "TerminalDeck component should exist");
  assert.ok(hiddenStyleIndex > componentStart, "visibility should be a root style toggle");
  assert.ok(sessionMapIndex > hiddenStyleIndex, "session terminals stay below the hidden root");
  assert.ok(terminalMapIndex > sessionMapIndex, "plain terminals stay below the hidden root");
  assert.match(deckSource, /openedSessions\.map\(\(name\) => \{/);
  assert.match(deckSource, /openedTerminals\.map\(\(id\) => \{/);
  assert.match(deckSource, /key=\{`s:\$\{name\}`\}/);
  assert.match(deckSource, /key=\{`t:\$\{id\}`\}/);
  assert.match(deckSource, /data-terminal-slot=\{`session:\$\{name\}`\}/);
  assert.match(deckSource, /data-terminal-slot=\{`terminal:\$\{id\}`\}/);
  assert.match(deckSource, /style=\{\{ display: visible \? undefined : "none" \}\}/);
  assert.doesNotMatch(
    deckSource,
    /selection\?\.kind === "automation"\s*\?\s*\(/,
    "automation selection must not conditionally remove terminal instances",
  );
  assert.doesNotMatch(
    deckSource.slice(componentStart),
    /if \(!visible\) return null|visible\s*&&\s*opened(?:Sessions|Terminals)\.map/,
    "visibility must not prune terminal children from the React tree",
  );
});

test("scratch toggle lives in the unified titlebar and uses Lucide icons", () => {
  assert.match(headerSource, /TerminalSquare/);
  assert.match(headerSource, /onClick=\{onToggleScratch\}/);
  assert.match(headerSource, /aria-pressed=\{scratchOpen\}/);
  assert.doesNotMatch(headerSource, /<svg\b|<path\b|<rect\b/);
  assert.doesNotMatch(deckSource, /pane__bar|scratchCollapsed|onToggleScratch/);
});

test("hidden or blocked decks preserve PTY identity while disabling input", () => {
  assert.match(deckSource, /visible &&\s*!blocked &&\s*selection\?\.kind === "session"/s);
  assert.match(deckSource, /visible &&\s*!blocked &&\s*selection\?\.kind === "terminal"/s);
  assert.match(deckSource, /tmuxSession=\{name\}/);
  assert.match(deckSource, /tmuxSession=\{sessionKey\}/);
  assert.match(deckSource, /hostId=\{session\?\.hostId \?\? null\}/);
  assert.match(deckSource, /hostId=\{terminal\.hostId \?\? null\}/);
  assert.match(deckSource, /initialHistory=\{tmuxPreviews\[name\]\}/);
  assert.match(deckSource, /initialHistory=\{tmuxPreviews\[sessionKey\]\}/);
  assert.match(deckSource, /onOpenFile=\{onOpenFile\}/g);
});

test("scratch terminals stay mounted when the panel is collapsed", () => {
  assert.match(workspaceSource, /<aside[\s\S]*?className="dashboard-scratch"[\s\S]*?hidden=\{workspacePresentation\.metadataPending \|\| scratchCollapsed \|\| !selectionKey\}/);
  assert.match(workspaceSource, /active=\{isActive && !scratchCollapsed && !workspaceInteractionBlocked\}/);
  assert.doesNotMatch(workspaceSource, /\{!scratchCollapsed && selectionKey && \(\s*<aside className="dashboard-scratch"/);
});

test("pending remote selections never fall back to local terminal or workspace commands", () => {
  assert.match(selectionHydrationSource, /const selectionMetadataPending =/);
  assert.match(
    terminalDeckStateSource,
    /if \(!selectedSession \|\| selectionMetadataPending\) return;/,
  );
  assert.match(
    terminalDeckStateSource,
    /if \(!selectedTerminal \|\| selectionMetadataPending\) return;/,
  );
  assert.match(presentationSource, /const metadataPending = !ownerReady \|\| selectionMetadataPending/);
  assert.match(primarySource, /<TerminalDeck key=\{terminalDeckKey\} \{\.\.\.terminalDeckProps\} \/>/);
  assert.match(appSource, /metadataPending: workspacePresentation\.metadataPending/);
  assert.match(presentationSource, /const terminalVisible = metadataPending \|\|/);
  assert.match(presentationSource, /const primary: WorkspacePrimaryContext = metadataPending/);
  assert.match(appSource, /if \(!session \|\| !cwd\) return null;/);
  assert.match(appSource, /useState<PendingCatalogSelection \| null>\(null\)/);
  assert.match(
    appSource,
    /pendingCreatedCatalogSelection\(\s*\{ kind: "session", name: sessionName \},\s*getLatestStartedRefreshGeneration\(\),\s*\)/s,
  );
  assert.match(
    selectionHydrationSource,
    /const catalogSelectionResolution = useMemo\(\s*\(\) =>\s*reconcileCatalogSelection/s,
  );

  assert.match(deckSource, /metadataPending: boolean;/);
  assert.match(deckSource, /data-terminal-pending role="status"/);
  assert.match(deckSource, /if \(!session\) return null;/);
  assert.match(deckSource, /if \(isRemote && !host\) return null;/);
  assert.doesNotMatch(deckSource, /const isRemote = session\?\.hostId/);
});
