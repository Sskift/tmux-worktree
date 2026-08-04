export type GitGraphTopologyCommit = {
  id: string;
  parentIds: readonly string[];
};

export type GitGraphNodeLayout = {
  commitId: string;
  row: number;
  lane: number;
  parentCount: number;
  isMerge: boolean;
  isRoot: boolean;
};

export type GitGraphEdgeLayout = {
  fromCommitId: string;
  toCommitId: string;
  fromRow: number;
  toRow: number;
  fromLane: number;
  toLane: number;
  /** A missing parent means the response stopped before the edge did. */
  truncated: boolean;
  /** Stable palette index. Topology remains legible without its colour. */
  colorLane: number;
};

export type GitGraphLayout = {
  nodes: GitGraphNodeLayout[];
  edges: GitGraphEdgeLayout[];
  laneCount: number;
};

type PendingEdge = Omit<GitGraphEdgeLayout, "toRow" | "toLane" | "truncated"> & {
  expectedLane: number;
};

function uniqueParents(commit: GitGraphTopologyCommit): string[] {
  return [...new Set(commit.parentIds.filter((parentId) => (
    parentId.length > 0 && parentId !== commit.id
  )))];
}

function firstVacantLane(lanes: readonly (string | null)[]): number {
  const vacant = lanes.findIndex((value) => value === null);
  return vacant >= 0 ? vacant : lanes.length;
}

function trimVacantTail(lanes: (string | null)[]) {
  while (lanes.length > 0 && lanes.at(-1) === null) lanes.pop();
}

/**
 * Assigns deterministic lanes to a newest-to-oldest, topologically ordered log.
 *
 * The first parent continues in the commit's lane whenever possible. Additional
 * parents get their own lane until their commit is reached. A branch head that
 * is not already pending takes the first vacant lane, so two unrelated roots or
 * several selected refs can share the same graph without relying on input refs.
 */
export function layoutGitGraph(
  commits: readonly GitGraphTopologyCommit[],
): GitGraphLayout {
  const lanes: (string | null)[] = [];
  const nodes: GitGraphNodeLayout[] = [];
  const pendingEdges: PendingEdge[] = [];
  const positionByCommit = new Map<string, { row: number; lane: number }>();
  let laneCount = 0;

  commits.forEach((commit, row) => {
    let lane = lanes.indexOf(commit.id);
    if (lane < 0) {
      lane = firstVacantLane(lanes);
      lanes[lane] = commit.id;
    }

    const parents = uniqueParents(commit);
    positionByCommit.set(commit.id, { row, lane });
    nodes.push({
      commitId: commit.id,
      row,
      lane,
      parentCount: parents.length,
      isMerge: parents.length > 1,
      isRoot: parents.length === 0,
    });

    // The current pending tip has now been consumed. Continue its first parent
    // in place unless that parent already owns another lane.
    lanes[lane] = null;
    parents.forEach((parentId, parentIndex) => {
      let parentLane = lanes.indexOf(parentId);
      if (parentLane < 0) {
        if (parentIndex === 0 && lanes[lane] === null) {
          parentLane = lane;
        } else {
          parentLane = firstVacantLane(lanes);
        }
        lanes[parentLane] = parentId;
      }

      pendingEdges.push({
        fromCommitId: commit.id,
        toCommitId: parentId,
        fromRow: row,
        fromLane: lane,
        expectedLane: parentLane,
        colorLane: parentIndex === 0 ? lane : parentLane,
      });
    });

    trimVacantTail(lanes);
    laneCount = Math.max(laneCount, lanes.length, lane + 1);
  });

  const edges = pendingEdges.map<GitGraphEdgeLayout>((edge) => {
    const target = positionByCommit.get(edge.toCommitId);
    return {
      fromCommitId: edge.fromCommitId,
      toCommitId: edge.toCommitId,
      fromRow: edge.fromRow,
      toRow: target?.row ?? commits.length,
      fromLane: edge.fromLane,
      toLane: target?.lane ?? edge.expectedLane,
      truncated: !target,
      colorLane: edge.colorLane,
    };
  });

  return {
    nodes,
    edges,
    laneCount: Math.max(laneCount, commits.length > 0 ? 1 : 0),
  };
}
