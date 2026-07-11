import assert from "node:assert/strict";
import test from "node:test";
import { layoutGitGraph, type GitGraphTopologyCommit } from "../src/gitGraphLayout";

const commit = (id: string, ...parentIds: string[]): GitGraphTopologyCommit => ({
  id,
  parentIds,
});

test("linear history remains in one stable lane", () => {
  const layout = layoutGitGraph([
    commit("c3", "c2"),
    commit("c2", "c1"),
    commit("c1"),
  ]);

  assert.deepEqual(layout.nodes.map((node) => node.lane), [0, 0, 0]);
  assert.deepEqual(layout.edges.map((edge) => [edge.fromLane, edge.toLane]), [
    [0, 0],
    [0, 0],
  ]);
  assert.equal(layout.laneCount, 1);
});

test("two selected branch heads form a visible fork before their common parent", () => {
  const layout = layoutGitGraph([
    commit("feature", "base"),
    commit("main", "base"),
    commit("base", "root"),
    commit("root"),
  ]);

  assert.deepEqual(layout.nodes.map(({ commitId, lane }) => [commitId, lane]), [
    ["feature", 0],
    ["main", 1],
    ["base", 0],
    ["root", 0],
  ]);
  assert.equal(layout.laneCount, 2);
  assert.deepEqual(
    layout.edges.find((edge) => edge.fromCommitId === "main"),
    {
      fromCommitId: "main",
      toCommitId: "base",
      fromRow: 1,
      toRow: 2,
      fromLane: 1,
      toLane: 0,
      truncated: false,
      colorLane: 1,
    },
  );
});

test("merge history keeps first parent straight and gives the merged parent a lane", () => {
  const layout = layoutGitGraph([
    commit("merge", "main", "feature"),
    commit("main", "base"),
    commit("feature", "base"),
    commit("base"),
  ]);

  assert.deepEqual(layout.nodes.map(({ lane, isMerge }) => [lane, isMerge]), [
    [0, true],
    [0, false],
    [1, false],
    [0, false],
  ]);
  assert.equal(layout.edges.filter((edge) => edge.fromCommitId === "merge").length, 2);
  assert.equal(
    layout.edges.find((edge) => edge.toCommitId === "feature")?.toLane,
    1,
  );
});

test("parents outside a truncated response end at the next row in their lane", () => {
  const layout = layoutGitGraph([
    commit("tip", "not-loaded"),
  ]);

  assert.deepEqual(layout.edges[0], {
    fromCommitId: "tip",
    toCommitId: "not-loaded",
    fromRow: 0,
    toRow: 1,
    fromLane: 0,
    toLane: 0,
    truncated: true,
    colorLane: 0,
  });
});

test("interleaved unrelated roots do not collapse active histories", () => {
  const layout = layoutGitGraph([
    commit("a1", "a0"),
    commit("b1", "b0"),
    commit("a0"),
    commit("b0"),
  ]);

  assert.deepEqual(layout.nodes.map(({ commitId, lane }) => [commitId, lane]), [
    ["a1", 0],
    ["b1", 1],
    ["a0", 0],
    ["b0", 1],
  ]);
  assert.equal(layout.laneCount, 2);
  assert.ok(layout.edges.every((edge) => !edge.truncated));
});
