import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRustSourceFiles, readRustSourceTree } from "./rustSource.ts";

function withRustFixture(
  files: Record<string, string>,
  run: (root: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "tw-rust-source-"));
  try {
    for (const [path, source] of Object.entries({ "main.rs": "fn main() {}", ...files })) {
      const fullPath = join(root, path);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, source);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("Rust source tree contains only statically reachable production modules", () => {
  withRustFixture({
    "lib.rs": `
      const OPEN_BRACE: char = '{';
      mod live;
      #[cfg(test)]
      mod test_only;
      #[cfg(test)]
      fn scattered_test_decoy() { const DECOY: &str = "CFG_TEST_DECOY"; }
      #[doc = "DOC_DECOY"]
      #[cfg(test)]
      fn attributed_test_decoy() {}
      #[cfg(test)]
      const TEST_CONST: i32 = if true { 0 } else { ELSE_DECOY };
      struct Probe;
      impl Probe {
        #[cfg(test)]
        fn associated_test_decoy() { const DECOY: &str = "ASSOCIATED_TEST_DECOY"; }
      }
      fn real_entry() {}
    `,
    "live.rs": "pub mod child; pub fn live_marker() {}",
    "live/child.rs": "pub fn child_marker() {}",
    "orphan.rs": "fn ORPHAN_DECOY() {}",
    "test_only.rs": "fn TEST_MODULE_DECOY() {}",
  }, (root) => {
    assert.deepEqual(
      readRustSourceFiles(root).map((file) => file.path),
      ["lib.rs", "live.rs", "live/child.rs", "main.rs"],
    );
    const tree = readRustSourceTree(root);
    assert.match(tree, /real_entry/);
    assert.match(tree, /live_marker/);
    assert.match(tree, /child_marker/);
    assert.doesNotMatch(
      tree,
      /ORPHAN_DECOY|TEST_MODULE_DECOY|CFG_TEST_DECOY|DOC_DECOY|ELSE_DECOY|ASSOCIATED_TEST_DECOY/,
    );
  });
});

test("Rust source graph masks byte and escaped chars without masking lifetimes", () => {
  withRustFixture({
    "lib.rs": `
      const BYTE_OPEN: u8 = b'{';
      const ESCAPED_OPEN: char = '\\u{7b}';
      fn borrow<'a>(value: &'a str) -> &'a str { value }
      mod reachable;
    `,
    "reachable.rs": "pub fn reached_after_char_literals() {}",
  }, (root) => {
    const tree = readRustSourceTree(root);
    assert.match(tree, /borrow<'a>/);
    assert.match(tree, /reached_after_char_literals/);
  });
});

test("Rust source graph excludes module files gated by an inner cfg(test)", () => {
  withRustFixture({
    "lib.rs": "mod gated; fn production_entry() {}",
    "gated.rs": `
      #![cfg(test)]
      mod nested_test_copy;
      fn INNER_CFG_TEST_DECOY() {}
    `,
    "gated/nested_test_copy.rs": "fn NESTED_INNER_CFG_TEST_DECOY() {}",
  }, (root) => {
    assert.deepEqual(
      readRustSourceFiles(root).map((file) => file.path),
      ["lib.rs", "main.rs"],
    );
    const tree = readRustSourceTree(root);
    assert.match(tree, /production_entry/);
    assert.doesNotMatch(tree, /INNER_CFG_TEST_DECOY|NESTED_INNER_CFG_TEST_DECOY/);
  });
});

const unsupportedCases = [
  ["missing module", "mod missing;", /resolved to 0 files/],
  ["inline module", "mod inline { fn decoy() {} }", /inline modules are unsupported/],
  ["path override", "#[path = \"alternate.rs\"] mod alternate;", /#\[path\] is unsupported/],
  ["cfg_attr path override", "#[cfg_attr(unix, path = \"unix.rs\")] mod platform;", /#\[path\] is unsupported/],
  ["conditional module", "#[cfg(unix)] mod unix;", /conditional production modules are unsupported/],
  ["source inclusion", "include!(\"generated.rs\");", /include! is unsupported/],
] as const;

for (const [name, source, expected] of unsupportedCases) {
  test(`Rust source graph fails closed for ${name}`, () => {
    withRustFixture({ "lib.rs": source }, (root) => {
      assert.throws(() => readRustSourceTree(root), expected);
    });
  });
}

test("Rust source graph rejects non-test inner cfg module files", () => {
  withRustFixture({
    "lib.rs": "mod conditional;",
    "conditional.rs": "#![cfg(unix)]\npub fn platform_only() {}",
  }, (root) => {
    assert.throws(
      () => readRustSourceTree(root),
      /conditional production module files are unsupported/,
    );
  });
});

test("Rust source graph rejects ambiguous module candidates", () => {
  withRustFixture({
    "lib.rs": "mod duplicate;",
    "duplicate.rs": "pub fn first() {}",
    "duplicate/mod.rs": "pub fn second() {}",
  }, (root) => {
    assert.throws(() => readRustSourceTree(root), /resolved to 2 files/);
  });
});
