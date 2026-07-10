import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getMenuSelectNavigationIndex } from "../src/MenuSelect";

test("MenuSelect keyboard navigation wraps and supports positional keys", () => {
  assert.equal(getMenuSelectNavigationIndex("ArrowDown", 0, 3), 1);
  assert.equal(getMenuSelectNavigationIndex("ArrowDown", 2, 3), 0);
  assert.equal(getMenuSelectNavigationIndex("ArrowUp", 0, 3), 2);
  assert.equal(getMenuSelectNavigationIndex("ArrowUp", 2, 3), 1);
  assert.equal(getMenuSelectNavigationIndex("Home", 2, 3), 0);
  assert.equal(getMenuSelectNavigationIndex("End", 0, 3), 2);
  assert.equal(getMenuSelectNavigationIndex("ArrowDown", 0, 0), -1);
});

test("MenuSelect exposes and operates its listbox from the keyboard", () => {
  const source = readFileSync(new URL("../src/MenuSelect.tsx", import.meta.url), "utf8");

  assert.match(source, /aria-haspopup="listbox"/);
  assert.match(source, /aria-controls=\{menuId\}/);
  assert.match(source, /role="listbox"/);
  assert.match(source, /role="option"/);
  assert.match(source, /onKeyDown=\{handleTriggerKeyDown\}/);
  assert.match(source, /onKeyDown=\{handleMenuKeyDown\}/);
  assert.match(source, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /triggerRef\.current\?\.focus\(\)/);
  assert.match(source, /optionRefs\.current\[activeIndex\]\?\.focus\(\)/);
  assert.match(source, /if \(event\.detail === 0\) selectOption\(option\.value\)/);
});

test("MenuSelect keeps pointer-down selection for embedded WebViews", () => {
  const source = readFileSync(new URL("../src/MenuSelect.tsx", import.meta.url), "utf8");

  assert.match(source, /onPointerDown=\{\(event\) => \{/);
  assert.match(source, /event\.preventDefault\(\);\s+selectOption\(option\.value\);/);
});
