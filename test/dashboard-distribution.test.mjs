import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseChecksumFile,
  releaseDownloadPlan,
} from "../app/installer/installer.mjs";

const repositoryRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, repositoryRoot), "utf8");

test("Dashboard installer pins assets to the npm package release and architecture", () => {
  assert.deepEqual(
    releaseDownloadPlan({ version: "1.2.3", arch: "arm64" }),
    {
      assetName: "tw-dashboard-1.2.3-arm64.dmg",
      checksumName: "tw-dashboard-1.2.3-arm64.dmg.sha256",
      checksumUrl: "https://github.com/Sskift/tmux-worktree/releases/download/v1.2.3/tw-dashboard-1.2.3-arm64.dmg.sha256",
      dmgUrl: "https://github.com/Sskift/tmux-worktree/releases/download/v1.2.3/tw-dashboard-1.2.3-arm64.dmg",
      tag: "v1.2.3",
    },
  );
  assert.equal(
    releaseDownloadPlan({ version: "1.0.5+build.2", arch: "x64" }).dmgUrl,
    "https://github.com/Sskift/tmux-worktree/releases/download/v1.0.5%2Bbuild.2/tw-dashboard-1.0.5+build.2-x64.dmg",
  );
  assert.throws(
    () => releaseDownloadPlan({ version: "latest", arch: "arm64" }),
    /invalid release version/,
  );
  assert.throws(
    () => releaseDownloadPlan({ version: "1.2.3", arch: "ia32" }),
    /unsupported CPU arch/,
  );
});

test("Dashboard installer accepts only the checksum for the exact asset", () => {
  const digest = "ab".repeat(32);
  const asset = "tw-dashboard-1.2.3-arm64.dmg";
  assert.equal(parseChecksumFile(`${digest}  ${asset}\n`, asset), digest);
  assert.equal(parseChecksumFile(`${digest.toUpperCase()} *${asset}\r\n`, asset), digest);
  assert.throws(
    () => parseChecksumFile(`${digest}  another.dmg\n`, asset),
    /does not name/,
  );
  assert.throws(
    () => parseChecksumFile(`${digest}  ${asset}\n${digest}  ${asset}\n`, asset),
    /exactly one entry/,
  );
});

test("npm tarball excludes DMGs and release script emits installer-compatible names", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.deepEqual(manifest.files, ["dist", "app/installer/installer.mjs"]);
  assert.match(manifest.scripts.prepack, /build.*validate:package/);

  const release = read("app/scripts/release.sh");
  assert.match(release, /asset_name="tw-dashboard-\$\{package_version\}-\$\{release_arch\}\.dmg"/);
  assert.match(release, /checksum_dst="\$dmg_dst\.sha256"/);
  assert.match(release, /shasum -a 256 -c/);
});
