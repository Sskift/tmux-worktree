import assert from "node:assert/strict";
import test from "node:test";

const rolloutModule = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/codexRolloutFileSourceAuthority.js"
);

const HOME = "/Users/fixture";
const CWD = "/Users/fixture/.tmux-worktree/worktrees/repo/task";
const SESSION = "tw-repo-task";
const INCARNATION = `twinc2.${"a".repeat(43)}`;
const THREAD_ID = "0198a5c4-3d12-7b21-a1d4-8f23cb697e10";
const ROLLOUT = `${HOME}/.codex/sessions/2026/08/03/rollout-fixture.jsonl`;

function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) value[key] = frozen(value[key]);
    return Object.freeze(value);
  }
  return value;
}

function harness(paths = [ROLLOUT]) {
  const pane = frozen({
    sessionName: SESSION,
    managedIncarnation: INCARNATION,
    paneId: "%7",
    panePid: 100,
    paneTty: "/dev/ttys007",
    cwd: CWD,
  });
  const processes = frozen([
    {
      pid: 100, parentPid: 1, processGroupId: 100, foregroundProcessGroupId: 200,
      tty: "ttys007", startToken: "Mon Aug  3 10:00:00 2026",
      executablePath: "/bin/zsh", trustedExecutable: false,
    },
    {
      pid: 200, parentPid: 100, processGroupId: 200, foregroundProcessGroupId: 200,
      tty: "ttys007", startToken: "Mon Aug  3 10:00:01 2026",
      executablePath: "/Applications/Codex/codex", trustedExecutable: true,
    },
    {
      pid: 201, parentPid: 200, processGroupId: 201, foregroundProcessGroupId: 0,
      tty: "??", startToken: "Mon Aug  3 10:00:02 2026",
      executablePath: "opaque-helper-command", trustedExecutable: false,
    },
  ]);
  const bytes = new TextEncoder().encode(`${JSON.stringify({
    type: "session_meta",
    payload: { id: THREAD_ID, cwd: CWD, cli_version: "0.146.0", ignored: "bounded" },
  })}\n{"type":"event_msg"}\n`);
  let closeCount = 0;
  const stat = frozen({
    resolvedPath: ROLLOUT, device: 11n, inode: 22n, ownerUid: 501n,
    linkCount: 1n, regular: true, size: BigInt(bytes.byteLength),
  });
  const tmux = { async inspectSinglePane() { return pane; } };
  const processPort = { async inspectPaneDescendants() { return processes; } };
  const openFiles = {
    async inspectOpenFiles(pid) {
      return frozen({ pid, trustedExecutableVnode: true, paths });
    },
    async openNoFollow(path) {
      assert.equal(path, ROLLOUT);
      return {
        async inspect() { return stat; },
        async read(position, maximumBytes) {
          assert.equal(position, 0n);
          assert.equal(maximumBytes, 256 * 1024);
          return bytes;
        },
        async close() { closeCount += 1; },
      };
    },
  };
  const authority = new rolloutModule.CodexRolloutFileSourceAuthority(frozen({
    platform: "darwin",
    accountHome: HOME,
    accountUid: 501,
    selection: { sessionName: SESSION, managedIncarnation: INCARNATION, expectedCwd: CWD },
    tmux,
    processes: processPort,
    openFiles,
  }));
  return { authority, get closeCount() { return closeCount; } };
}

test("Darwin rollout owner binds one exact live Codex process and fails closed on ambiguity", async () => {
  assert.equal(
    rolloutModule.CODEX_ROLLOUT_MAX_TRUSTED_EXECUTABLE_BYTES,
    384 * 1024 * 1024,
  );
  assert.equal(
    rolloutModule.CODEX_ROLLOUT_MAX_TRUSTED_EXECUTABLE_BYTES > 271_056_976,
    true,
    "the bounded capture admits the observed official Codex 0.146.0 artifact",
  );
  const h = harness();
  const opened = await h.authority.open();
  assert.equal(opened.providerVersion, "0.146.0");
  assert.equal(opened.sessionName, SESSION);
  assert.equal(opened.managedIncarnation, INCARNATION);
  assert.equal(opened.threadId, THREAD_ID);
  assert.equal(opened.cwd, CWD);
  assert.equal(opened.codexPid, 200);
  assert.equal(Object.isFrozen(opened.sourceIdentity), true);
  assert.deepEqual(Reflect.ownKeys(opened.sourceIdentity), []);
  assert.equal(opened.durableCut.device, 11n);
  assert.equal(opened.durableCut.inode, 22n);
  assert.equal(opened.durableCut.offset > opened.firstRecordEndOffset, true);
  const follower = rolloutModule.claimCodexRolloutOpenByteSource(opened.sourceIdentity);
  assert.equal((await follower.inspectDurableCut()).offset, opened.durableCut.offset);
  await assert.rejects(
    Promise.resolve().then(() => rolloutModule.claimCodexRolloutOpenByteSource(opened.sourceIdentity)),
    (error) => error instanceof rolloutModule.CodexRolloutFileSourceError
      && error.code === "SEALED",
  );
  await h.authority.closeAndDrain();
  assert.equal(h.closeCount, 0, "claim transfers descriptor close ownership to the follower");
  await follower.closeAndDrain();
  assert.equal(h.closeCount, 1);

  const ambiguous = harness([ROLLOUT, `${HOME}/.codex/sessions/2026/08/03/rollout-other.jsonl`]);
  await assert.rejects(
    ambiguous.authority.open(),
    (error) => error instanceof rolloutModule.CodexRolloutFileSourceError
      && error.code === "ROLLOUT_NOT_UNIQUE",
  );
  assert.equal(ambiguous.closeCount, 0);
});
