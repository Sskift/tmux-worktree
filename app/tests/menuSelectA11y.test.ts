import assert from "node:assert/strict";
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
