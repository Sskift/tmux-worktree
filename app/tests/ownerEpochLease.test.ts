import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerEpochLeaseController } from "../src/dashboard/ownerEpochLease.ts";

test("owner epochs advance only when the committed owner changes", () => {
  const controller = createOwnerEpochLeaseController<object>();
  const ownerA = {};
  const ownerB = {};

  assert.deepEqual(controller.commit(ownerA), { changed: true, lease: null });
  assert.deepEqual(controller.commit(ownerA), { changed: false, lease: null });
  const activation = controller.activate();
  const leaseA = controller.capture(ownerA);
  assert.ok(leaseA);
  assert.equal(leaseA.epoch, 1);
  assert.equal(controller.isCurrent(leaseA), true);

  const sameOwner = controller.commit(ownerA);
  assert.equal(sameOwner.changed, false);
  assert.equal(sameOwner.lease, leaseA);

  const leaseB = controller.commit(ownerB).lease;
  assert.ok(leaseB);
  assert.equal(leaseB.epoch, 2);
  assert.equal(controller.capture(ownerA), null);
  assert.equal(controller.isCurrent(leaseA), false);

  const nextLeaseA = controller.commit(ownerA).lease;
  assert.ok(nextLeaseA);
  assert.equal(nextLeaseA.epoch, 3);
  assert.equal(controller.isCurrent(leaseB), false);
  assert.equal(controller.isCurrent(nextLeaseA), true);
  assert.equal(controller.deactivate(activation), true);
});

test("activation cleanup is exact and Strict replay invalidates the old result lease", () => {
  const controller = createOwnerEpochLeaseController<object>();
  const owner = {};
  controller.commit(owner);

  const firstActivation = controller.activate();
  const firstLease = controller.capture(owner);
  assert.ok(firstLease);
  assert.equal(controller.deactivate(firstActivation), true);
  assert.equal(controller.capture(owner), null);
  assert.equal(controller.isCurrent(firstLease), false);

  const secondActivation = controller.activate();
  const secondLease = controller.capture(owner);
  assert.ok(secondLease);
  assert.equal(secondLease.epoch, firstLease.epoch);
  assert.notEqual(secondLease, firstLease);
  assert.equal(controller.isCurrent(secondLease), true);

  assert.equal(controller.deactivate(firstActivation), false);
  assert.equal(controller.capture(owner), secondLease, "stale cleanup must not deactivate replay");
  assert.equal(controller.deactivate(secondActivation), true);
  assert.equal(controller.capture(owner), null);
});
