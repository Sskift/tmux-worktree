import assert from "node:assert/strict";
import test from "node:test";
import type { PlainTerminal, Session } from "../src/platform/domainTypes.ts";
import {
  basenameFromPath,
  isInternalTerminalName,
  isLocalDiscoveredInternalTerminal,
  normalizePlainTerminal,
  sessionDisplayName,
  terminalRawName,
  terminalSessionKey,
} from "../src/dashboard/model/terminalIdentity.ts";

const session: Session = {
  name: "builder:repo-fix",
  rawName: "repo-fix",
  attached: false,
  window_count: 1,
  created: 1,
  activity: 2,
};

const terminal: PlainTerminal = {
  id: "ssh:builder:tw-term-one",
  label: "One",
  cwd: "/work/repo",
  tmuxName: "builder:tw-term-one",
  hostId: "builder",
};

test("terminal identities preserve raw names and host-qualified catalog keys", () => {
  assert.equal(sessionDisplayName(session), "repo-fix");
  assert.equal(sessionDisplayName({ ...session, rawName: "" }), "");
  assert.equal(sessionDisplayName({ ...session, rawName: undefined }), session.name);

  assert.equal(terminalRawName(terminal), "tw-term-one");
  assert.equal(terminalSessionKey(terminal), "builder:tw-term-one");
  assert.equal(
    terminalRawName({ ...terminal, rawName: "explicit", tmuxName: "builder:ignored" }),
    "explicit",
  );
  assert.equal(
    terminalRawName({ ...terminal, tmuxName: "other:tw-term-one" }),
    "other:tw-term-one",
  );
});

test("plain terminal normalization converts only the local sentinel and repairs internal labels", () => {
  assert.deepEqual(
    normalizePlainTerminal({
      id: "local:tw-term-one",
      label: "tw-term-one",
      cwd: "/Users/me/repo",
      tmuxName: "tw-term-one",
      hostId: "local",
    }),
    {
      id: "local:tw-term-one",
      label: "repo",
      cwd: "/Users/me/repo",
      tmuxName: "tw-term-one",
      hostId: null,
      rawName: "tw-term-one",
    },
  );

  assert.deepEqual(
    normalizePlainTerminal({
      id: "discovered-empty",
      label: "",
      cwd: "",
      tmuxName: "tw-term-empty",
      hostId: undefined,
      discovered: true,
    }),
    {
      id: "discovered-empty",
      label: "terminal",
      cwd: "",
      tmuxName: "tw-term-empty",
      hostId: null,
      rawName: "tw-term-empty",
      discovered: true,
    },
  );

  const custom = normalizePlainTerminal({ ...terminal, label: "Review shell" });
  assert.equal(custom.hostId, "builder");
  assert.equal(custom.rawName, "tw-term-one");
  assert.equal(custom.label, "Review shell");
  assert.equal(basenameFromPath("/work/repo/"), "repo");
  assert.equal(basenameFromPath(null), "");
  assert.equal(isInternalTerminalName("tw-term-one"), true);
  assert.equal(isInternalTerminalName("repo-shell"), false);
});

test("local internal discovery filtering ignores discovered metadata but retains managed and remote terminals", () => {
  const localInternal: PlainTerminal = {
    id: "tw-term-one",
    label: "one",
    cwd: "/work",
    tmuxName: "tw-term-one",
    discovered: false,
  };

  assert.equal(isLocalDiscoveredInternalTerminal(localInternal), true);
  assert.equal(isLocalDiscoveredInternalTerminal({ ...localInternal, managed: true }), false);
  assert.equal(isLocalDiscoveredInternalTerminal({ ...localInternal, hostId: "builder" }), false);
  assert.equal(
    isLocalDiscoveredInternalTerminal({ ...localInternal, tmuxName: "plain", rawName: "plain" }),
    false,
  );
});
