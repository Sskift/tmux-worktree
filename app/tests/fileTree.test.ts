import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createFileTreeRequestGate,
  fileTreeErrorMessage,
  fileTreeSourceKey,
  readFileTreeDirectory,
  type FileTreeDirectoryReader,
} from "../src/fileTreeData";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("file tree directory reads route by host identity", async () => {
  const calls: string[] = [];
  const reader: FileTreeDirectoryReader = {
    async readDirectory(path) {
      calls.push(`local:${path}`);
      return [{
        name: "local",
        path: `${path}/local`,
        is_dir: false,
        is_symlink: false,
        is_hidden: false,
        size: 5,
      }];
    },
    async readRemoteDirectory(hostId, path) {
      calls.push(`remote:${hostId}:${path}`);
      return [{
        name: "remote",
        path: `${path}/remote`,
        is_dir: false,
        is_symlink: false,
        is_hidden: false,
        size: 6,
      }];
    },
  };

  const local = await readFileTreeDirectory(reader, null, "/repo");
  const remote = await readFileTreeDirectory(reader, "build-host", "/srv/repo");

  assert.deepEqual(calls, ["local:/repo", "remote:build-host:/srv/repo"]);
  assert.equal(local[0]?.name, "local");
  assert.equal(remote[0]?.name, "remote");
});

test("file tree request gate rejects superseded and previous-host results", () => {
  const localSource = fileTreeSourceKey("/repo", null);
  const remoteSource = fileTreeSourceKey("/repo", "remote-a");
  const gate = createFileTreeRequestGate(localSource);

  const firstRootRead = gate.issue("/repo");
  const childRead = gate.issue("/repo/src");
  assert.equal(gate.isCurrent(firstRootRead), true);
  assert.equal(gate.isCurrent(childRead), true);

  const retryRootRead = gate.issue("/repo");
  assert.equal(gate.isCurrent(firstRootRead), false);
  assert.equal(gate.isCurrent(retryRootRead), true);
  assert.equal(gate.isCurrent(childRead), true, "unrelated expanded folders remain compatible");

  assert.equal(gate.switchSource(remoteSource), true);
  assert.equal(gate.isCurrent(retryRootRead), false);
  assert.equal(gate.isCurrent(childRead), false);
  assert.equal(gate.switchSource(remoteSource), false);

  const remoteRead = gate.issue("/repo");
  assert.equal(gate.isCurrent(remoteRead), true);
});

test("a committed source change abandons a late directory result before publication", async () => {
  const localSource = fileTreeSourceKey("/repo", null);
  const remoteSource = fileTreeSourceKey("/repo", "remote-a");
  const gate = createFileTreeRequestGate(localSource);
  const localRead = deferred<string>();
  const remoteRead = deferred<string>();
  const published: string[] = [];

  const publish = async (
    request: ReturnType<typeof gate.issue>,
    result: Promise<string>,
  ) => {
    const value = await result;
    if (gate.isCurrent(request)) published.push(value);
  };

  const localRequest = gate.issue("/repo");
  const localPublication = publish(localRequest, localRead.promise);
  gate.switchSource(remoteSource);
  const remoteRequest = gate.issue("/repo");
  const remotePublication = publish(remoteRequest, remoteRead.promise);

  remoteRead.resolve("remote result");
  await remotePublication;
  localRead.resolve("abandoned local result");
  await localPublication;

  assert.deepEqual(published, ["remote result"]);
});

test("file tree source identity distinguishes local and each remote host", () => {
  assert.notEqual(fileTreeSourceKey("/repo", null), fileTreeSourceKey("/repo", "host-a"));
  assert.notEqual(fileTreeSourceKey("/repo", "host-a"), fileTreeSourceKey("/repo", "host-b"));
  assert.notEqual(fileTreeSourceKey("/repo", "host-a"), fileTreeSourceKey("/other", "host-a"));
  assert.equal(fileTreeSourceKey("/repo", undefined), fileTreeSourceKey("/repo", null));
});

test("file tree errors always have an honest retry message", () => {
  assert.equal(fileTreeErrorMessage(new Error("permission denied")), "permission denied");
  assert.equal(fileTreeErrorMessage("host offline"), "host offline");
  assert.equal(fileTreeErrorMessage(null), "Unable to load this folder");
});

test("FileTree disables unsupported remote search and forwards host identity", () => {
  const source = readFileSync(new URL("../src/FileTree.tsx", import.meta.url), "utf8");

  assert.match(source, /hostId\?: string \| null/);
  assert.match(source, /readFileTreeDirectory\(dashboardBackend\.files, hostId, dirPath\)/);
  assert.match(source, /disabled=\{isRemote\}/);
  assert.match(source, /Search is not available for remote files yet/);
  assert.match(source, /onFileSelect\(entry\.path, hostId\)/);
  assert.match(source, /file-tree__retry/);
  assert.match(source, /empty folder/);
  assert.doesNotMatch(source, /<svg/);
});

test("FileTree switches directory sources only after React commits the render", () => {
  const source = readFileSync(new URL("../src/FileTree.tsx", import.meta.url), "utf8");
  const gateStart = source.indexOf("const requestGateRef");
  const layoutEffectStart = source.indexOf("useLayoutEffect(() => {", gateStart);
  const switchSource = source.indexOf("requestGateRef.current?.switchSource(sourceKey)", gateStart);
  const layoutEffectEnd = source.indexOf("}, [sourceKey]);", layoutEffectStart);

  assert.ok(gateStart >= 0);
  assert.ok(layoutEffectStart > gateStart);
  assert.ok(switchSource > layoutEffectStart && switchSource < layoutEffectEnd);
  assert.doesNotMatch(source.slice(gateStart, layoutEffectStart), /switchSource\(/);
});
