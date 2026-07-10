import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const deckSource = readFileSync(
  new URL("../src/dashboard/TerminalDeck.tsx", import.meta.url),
  "utf8",
);

test("main workspace keeps TerminalDeck mounted while automation owns the visible pane", () => {
  const mainStart = appSource.indexOf("<main");
  const deckIndex = appSource.indexOf("<TerminalDeck", mainStart);
  const automationIndex = appSource.indexOf('selection?.kind === "automation"', deckIndex);
  const mainEnd = appSource.indexOf("</main>", automationIndex);

  assert.ok(mainStart >= 0, "main workspace should exist");
  assert.ok(deckIndex > mainStart, "TerminalDeck should be a direct workspace child");
  assert.ok(
    automationIndex > deckIndex,
    "TerminalDeck should render before the conditional automation pane",
  );
  assert.ok(mainEnd > automationIndex, "both panes should remain inside the main workspace");
  assert.equal(
    appSource.match(/<TerminalDeck\b/g)?.length,
    1,
    "App should have one unconditional terminal deck instance",
  );
  assert.match(
    appSource.slice(deckIndex, automationIndex),
    /visible=\{selection\?\.kind === "session" \|\| selection\?\.kind === "terminal"\}/,
  );
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

test("scratch toggle uses the shared Lucide icon system", () => {
  assert.match(deckSource, /import \{ PanelRightClose, PanelRightOpen \} from "lucide-react"/);
  assert.match(deckSource, /scratchCollapsed \? \(/);
  assert.match(deckSource, /<PanelRightOpen size=\{14\}/);
  assert.match(deckSource, /<PanelRightClose size=\{14\}/);
  assert.doesNotMatch(deckSource, /<svg\b|<path\b|<rect\b/);
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
