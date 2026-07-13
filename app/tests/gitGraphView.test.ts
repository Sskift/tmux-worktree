import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/GitGraphView.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/GitGraphView.css", import.meta.url), "utf8");

test("GitGraphView owns graph controls but leaves Files and Log tabs to its parent", () => {
  assert.match(source, /value: "head", label: "HEAD"/);
  assert.match(source, /value: "current", label: "Current"/);
  assert.match(source, /value: "all", label: "All"/);
  assert.match(source, /Add comparison branch/);
  assert.match(source, /Showing all local branches, remotes, and tags/);
  assert.match(source, /preset === "all"/);
  assert.match(source, /implicit\.add\(refs\.current\)/);
  assert.match(source, /preset === "current" && refs\?\.upstream/);
  assert.doesNotMatch(source, />Files</);
  assert.doesNotMatch(source, />Log</);
});

test("branch picker and commit list expose complete keyboard paths", () => {
  assert.match(source, /event\.key === "ArrowDown"/);
  assert.match(source, /event\.key === "ArrowUp"/);
  assert.match(source, /event\.key === "Enter"/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /aria-activedescendant=/);
  assert.match(source, /role="combobox"/);
  assert.match(source, /aria-autocomplete="list"/);
  assert.match(source, /scrollIntoView\(\{ block: "nearest" \}\)/);
  assert.match(source, /rowRefs\.current\[nextIndex\]\?\.focus\(\)/);
});

test("topology is encoded with shapes and text as well as lane colour", () => {
  assert.match(source, /git-graph__node--merge/);
  assert.match(source, /git-graph__node--root/);
  assert.match(source, /\{merge && <span className="git-graph__merge-word">merge<\/span>\}/);
  assert.match(source, /\$\{merge \? "Merge commit" : "Commit"\}/);
  assert.match(source, /git-graph__ref-label--\$\{kind\}/);
});

test("selected commit details reserve comparison and diff actions", () => {
  assert.match(source, />Merge base</);
  assert.match(source, /comparisonValue\(comparison\.ahead, "ahead"\)/);
  assert.match(source, /comparisonValue\(comparison\.behind, "behind"\)/);
  assert.match(source, /onOpenDiff\(selectedCommit\.hash\)/);
  assert.match(source, /onCompareRefs\(selectedRefs\)/);
  assert.doesNotMatch(source, /not calculated/);
  assert.match(source, /\{onOpenDiff && \(/);
  assert.match(source, /\{onCompareRefs && \(/);
});

test("graph styling is self-contained and sized for the Git side panel", () => {
  assert.match(styles, /\.git-graph\s*\{[\s\S]*?max-width:\s*440px;/);
  assert.match(styles, /--git-graph-row-height:\s*54px/);
  assert.match(styles, /--git-graph-subject-size:\s*12px/);
  assert.match(styles, /--git-graph-meta-size:\s*10px/);
  assert.match(source, /const ROW_HEIGHT = 54;/);
  assert.match(source, /const LANE_STEP = 16;/);
  assert.match(source, /const MIN_GRAPH_WIDTH = 40;/);
  assert.match(source, /const NODE_RADIUS = 4;/);
  assert.match(source, /const MERGE_NODE_RADIUS = 5;/);
  assert.match(source, /const SELECTED_NODE_RADIUS = 7;/);
  assert.match(styles, /\.git-graph__subject\s*\{[\s\S]*?font-size:\s*var\(--git-graph-subject-size\);[\s\S]*?font-weight:\s*500;/);
  assert.match(styles, /\.git-graph__commit-meta\s*\{[\s\S]*?font-size:\s*var\(--git-graph-meta-size\);/);
  assert.match(styles, /\.git-graph__lane-0/);
  assert.match(styles, /\.git-graph__lane-5/);
  assert.doesNotMatch(source, /gitgraph\.js|@gitgraph|gitgraph-js/iu);
});
