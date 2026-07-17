import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../contracts/relay/v2/external-continuity-authority-v1/", import.meta.url);
const load = async (name) => JSON.parse(await readFile(new URL(name, root), "utf8"));
const manifest = await load("manifest.json");
const machine = await load("machine-cases.json");

const sorted = (values) => [...values].sort();
const exactKeys = (value, expected, label) =>
  assert.deepEqual(sorted(Object.keys(value)), sorted(expected), label);
const member = (value, values, label) =>
  assert.ok(values.includes(value), `${label}: ${String(value)}`);
const unique = (values, label) =>
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
const subsetKeys = (value, allowed, label) => {
  for (const key of Object.keys(value)) {
    assert.ok(allowed.includes(key), `${label}: unknown key ${key}`);
  }
};

const initialKeys = [
  "lifecycle", "externalCheckpoint", "externalCasToken", "localCheckpoint",
  "ready", "activeConnections",
];
const actionKeys = [
  "operation", "actors", "candidateCheckpoints", "expectedCasToken",
  "requestIdentity", "fault", "accessBinding",
];
const expectKeys = [
  "outcomes", "externalErrors", "externalCommitDisposition", "continuityError",
  "credentialError", "externalCheckpoint", "externalCasToken", "localCheckpoint",
  "ready", "admission", "connectionFence", "nextAction",
];
const bindingById = new Map(machine.bindings.map((value) => [value.id, value]));
const checkpointById = new Map(machine.checkpoints.map((value) => [value.id, value]));
const errorByCode = new Map(manifest.errors.codes.map((value) => [value.code, value]));

function expandCase(value) {
  exactKeys(value, ["name", "category", "binding", "initial", "action", "expect"], value.name);
  subsetKeys(value.initial, initialKeys, `${value.name}.initial`);
  subsetKeys(value.action, actionKeys, `${value.name}.action`);
  subsetKeys(value.expect, expectKeys, `${value.name}.expect`);
  return {
    ...value,
    initial: { ...machine.defaults.initial, ...value.initial },
    action: { ...machine.defaults.action, ...value.action },
    expect: { ...machine.defaults.expect, ...value.expect },
  };
}

function validateCase(raw) {
  const value = expandCase(raw);
  const { initial, action, expect } = value;
  member(value.category, machine.vocabulary.categories, `${value.name}.category`);
  assert.ok(bindingById.has(value.binding), `${value.name}.binding`);
  member(initial.lifecycle, machine.vocabulary.lifecycles, `${value.name}.lifecycle`);
  member(initial.externalCheckpoint, machine.vocabulary.checkpointRefs, `${value.name}.externalCheckpoint`);
  member(initial.localCheckpoint, machine.vocabulary.checkpointRefs, `${value.name}.localCheckpoint`);
  member(initial.externalCasToken, machine.vocabulary.casTokenRefs, `${value.name}.externalCasToken`);
  assert.equal(typeof initial.ready, "boolean");
  assert.equal(typeof initial.activeConnections, "boolean");

  member(action.operation, machine.vocabulary.operations, `${value.name}.operation`);
  assert.ok(Number.isInteger(action.actors) && action.actors > 0, `${value.name}.actors`);
  assert.ok(action.candidateCheckpoints.every((id) => checkpointById.has(id)), `${value.name}.candidates`);
  member(action.expectedCasToken, machine.vocabulary.casTokenRefs, `${value.name}.expectedCasToken`);
  member(action.requestIdentity, machine.vocabulary.requestIdentities, `${value.name}.requestIdentity`);
  member(action.fault, machine.vocabulary.faults, `${value.name}.fault`);
  assert.ok(action.accessBinding === "same-binding" || bindingById.has(action.accessBinding));

  assert.ok(expect.outcomes.every((item) => machine.vocabulary.outcomes.includes(item)));
  assert.ok(expect.externalErrors.length <= 1, `${value.name}: one external response error at most`);
  assert.ok(expect.externalErrors.every((code) => errorByCode.has(code)));
  member(expect.externalCommitDisposition, machine.vocabulary.externalCommitDispositions, `${value.name}.disposition`);
  assert.equal(expect.externalErrors.length === 0, expect.externalCommitDisposition === null);
  member(expect.continuityError, machine.vocabulary.continuityErrors, `${value.name}.continuityError`);
  member(expect.credentialError, machine.vocabulary.credentialErrors, `${value.name}.credentialError`);
  member(expect.externalCheckpoint, machine.vocabulary.checkpointRefs, `${value.name}.expectedCheckpoint`);
  member(expect.externalCasToken, machine.vocabulary.casTokenRefs, `${value.name}.expectedCasToken`);
  member(expect.localCheckpoint, machine.vocabulary.checkpointRefs, `${value.name}.expectedLocal`);
  assert.equal(typeof expect.ready, "boolean");
  member(expect.admission, machine.vocabulary.admissions, `${value.name}.admission`);
  member(expect.connectionFence, machine.vocabulary.connectionFences, `${value.name}.fence`);
  member(expect.nextAction, machine.vocabulary.nextActions, `${value.name}.nextAction`);
  return value;
}

const cases = new Map(machine.cases.map((value) => [value.name, validateCase(value)]));
unique(machine.cases.map(({ name }) => name), "case names");
const caseNamed = (name) => {
  assert.ok(cases.has(name), `missing semantic case ${name}`);
  return cases.get(name);
};

test("manifest freezes the existing owner chain and production NO-GO", () => {
  exactKeys(manifest, [
    "contract", "contractVersion", "fixtureFormatVersion", "status", "normativeDocument",
    "files", "delivery", "ownership", "scope", "interface", "failureDomain",
    "provisioning", "transport", "requestIdentity", "errors", "recovery",
    "readinessFence", "namespaces", "schemaPolicy", "newNormativeChoices",
    "requiredProductionChoices",
  ], "manifest");
  assert.equal(manifest.status, "frozen-future-contract-production-no-go");
  assert.ok(Object.values(manifest.delivery).every((value) => value === false));
  assert.equal(manifest.ownership.externalBackend, "durable-monotonic-linearizable-record-and-terminal-lifecycle-by-anchorId-only");
  assert.equal(manifest.ownership.continuityAnchor, "local-state-before-anchor-ordering-single-crash-window-reconcile-bounded-timeout");
  assert.equal(manifest.ownership.credentialAuthority, "credential-checkpoint-business-state-ready-withdrawal-and-closed-error-mapping");
  assert.equal(manifest.ownership.brokerCore, "auth-control-authority-consumer-only");
  assert.equal(manifest.ownership.productionComposition, "synchronous-upgrade-route-and-active-data-fence-plus-bounded-transport-close");
  assert.equal(manifest.failureDomain.owner, "externalBackend");
  assert.equal(manifest.provisioning.owner, "externalBackend");
  assert.equal(manifest.provisioning.responsibilityLayer, "control-plane-provisioning-not-runtime-data-plane");
  const ownerValues = [];
  const collectOwners = (value) => {
    if (Array.isArray(value)) return value.forEach(collectOwners);
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "owner") ownerValues.push(child);
      collectOwners(child);
    }
  };
  collectOwners(manifest);
  assert.deepEqual(sorted(new Set(ownerValues)), sorted([
    "externalBackend", "RelayV2ContinuityAnchor", "RelayV2BrokerCredentialAuthority",
    "RelayV2BrokerCore", "owningProductionComposition",
  ]));
  assert.equal(manifest.scope.v1OrBauFallbackAllowed, false);
  assert.equal(manifest.scope.enrollmentOrCapabilityEffect, "none");
});

test("closed config and wire schemas are sufficient for a bounded decoder", () => {
  exactKeys(manifest.interface, [
    "protocolVersion", "recordKey", "typedPort", "checkpointExactKeys",
    "scalarSchemaExactKeys", "scalarSchemas", "monotonicRule", "concurrentCasRule",
    "initializedNeverUninitializedAgain", "casTokenNonRepeating",
  ], "interface");
  exactKeys(manifest.interface.typedPort, [
    "readRequestExactKeys", "casRequestExactKeys", "snapshotStatuses", "casOutcomes",
  ], "typed port");
  exactKeys(manifest.transport, [
    "futureAdapterSeam", "backendGuarantee", "status", "authenticationModes", "operations", "namespaces",
    "secretMaterialInConfigUrlLogsErrorsTracesFixturesAllowed", "objectSchemaExactKeys",
    "configSchema", "namespaceBindingSchema", "namespaceBindingsRules",
    "wireObjectSchemas", "wireUnionRules", "operationTimeoutMs",
    "maxPendingOperations", "newNumericChoices",
  ], "transport");
  const scalarNames = [
    "identifier", "operationId", "casToken", "canonicalUint64", "stateDigest",
    "endpoint", "retryAfterMs",
  ];
  exactKeys(manifest.interface.scalarSchemas, scalarNames, "scalar schemas");
  for (const [name, schema] of Object.entries(manifest.interface.scalarSchemas)) {
    exactKeys(schema, manifest.interface.scalarSchemaExactKeys, `scalar ${name}`);
  }
  assert.deepEqual(
    { min: manifest.interface.scalarSchemas.identifier.minimum, max: manifest.interface.scalarSchemas.identifier.maximum },
    { min: 1, max: 128 },
  );
  assert.equal(manifest.interface.scalarSchemas.casToken.maximum, 512);
  assert.equal(manifest.interface.scalarSchemas.endpoint.maximum, 2048);
  assert.match(manifest.interface.scalarSchemas.identifier.rule, /\{0,127\}/);
  assert.equal(manifest.transport.newNumericChoices[0].field, "endpoint.maximumUtf8Bytes");
  exactKeys(manifest.transport.newNumericChoices[0], ["field", "value", "appliesAt", "rationale"], "endpoint numeric choice");
  exactKeys(manifest.requestIdentity, [
    "futureAdapterSeam", "backendGuarantee", "status", "operationId", "fingerprintCovers",
    "sameIdSameFingerprint", "sameIdDifferentFingerprint", "adapterReplayLimit",
    "casAfterTimeoutOrUncertain", "lateResultAfterDeadline",
  ], "request identity");

  const objectKeys = manifest.transport.objectSchemaExactKeys;
  exactKeys(manifest.transport.wireObjectSchemas, [
    "checkpoint", "snapshot", "requestEnvelope", "readPayload", "casPayload",
    "casResult", "externalError", "responseEnvelope",
  ], "wire object schemas");
  for (const [name, schema] of Object.entries(manifest.transport.wireObjectSchemas)) {
    exactKeys(schema, objectKeys, `wire schema ${name}`);
    exactKeys(schema.fields, schema.exactKeys, `wire fields ${name}`);
    assert.ok(Object.values(schema.fields).every((value) => typeof value === "string" && value.length > 0));
  }
  exactKeys(manifest.transport.configSchema, objectKeys, "config schema");
  exactKeys(manifest.transport.configSchema.fields, manifest.transport.configSchema.exactKeys, "config fields");
  exactKeys(manifest.transport.namespaceBindingSchema, objectKeys, "namespace binding schema");
  exactKeys(manifest.transport.namespaceBindingSchema.fields, ["namespace", "ownerBinding", "anchorId"], "namespace binding fields");
  assert.deepEqual(manifest.transport.namespaceBindingsRules, {
    minimumItems: 1,
    maximumItems: 2,
    maximumSource: "derived-from-two-frozen-v1-namespaces",
    uniqueBy: ["namespace", "anchorId"],
    sameNamespaceDuplicateAllowed: false,
    sameAnchorIdDuplicateAllowed: false,
    securityDomainSource: "enclosing-config-securityDomainId",
    bindingMustMatchProvisionedExactTuple: true,
  });
  assert.match(manifest.transport.configSchema.fields.credentialReference, /opaque-resolver-key-not-secret-not-path$/);
  assert.match(manifest.transport.configSchema.fields.tlsTrustReference, /opaque-resolver-key-not-secret-not-path$/);

  const wire = manifest.transport.wireObjectSchemas;
  assert.deepEqual(wire.snapshot.exactKeys, ["status", "checkpoint", "casToken"]);
  assert.equal(manifest.transport.wireUnionRules.snapshot.uninitialized.checkpoint, null);
  assert.match(manifest.transport.wireUnionRules.snapshot.committed.checkpoint, /anchorId-equals-request$/);
  assert.deepEqual(wire.requestEnvelope.exactKeys, ["contractVersion", "operationId", "securityDomainId", "namespace", "anchorId", "operation", "payload"]);
  assert.deepEqual(wire.responseEnvelope.exactKeys, ["contractVersion", "operationId", "ok", "result", "error"]);
  assert.deepEqual(wire.casResult.exactKeys, ["outcome", "current"]);
  assert.equal(wire.casResult.fields.current, "object:snapshot");
  exactKeys(manifest.transport.wireUnionRules, ["snapshot", "request", "casResult", "response", "typedPortTranslation"], "wire unions");
  exactKeys(manifest.transport.wireUnionRules.snapshot, ["uninitialized", "committed"], "snapshot union");
  exactKeys(manifest.transport.wireUnionRules.snapshot.uninitialized, ["status", "checkpoint", "casToken"], "uninitialized union");
  exactKeys(manifest.transport.wireUnionRules.snapshot.committed, ["status", "checkpoint", "casToken"], "committed union");
  exactKeys(manifest.transport.wireUnionRules.request, ["read", "compareAndSwap"], "request union");
  exactKeys(manifest.transport.wireUnionRules.request.read, ["operation", "payload"], "read request union");
  exactKeys(manifest.transport.wireUnionRules.request.compareAndSwap, ["operation", "payload", "expectedAnchor", "nextAnchor"], "CAS request union");
  exactKeys(manifest.transport.wireUnionRules.casResult, ["swapped", "conflict"], "CAS result union");
  exactKeys(manifest.transport.wireUnionRules.casResult.swapped, ["outcome", "current", "casToken"], "swapped result union");
  exactKeys(manifest.transport.wireUnionRules.casResult.conflict, ["outcome", "current", "casToken"], "conflict result union");
  assert.match(manifest.transport.wireUnionRules.casResult.swapped.current, /checkpoint-exactly-next$/);
  exactKeys(manifest.transport.wireUnionRules.response, ["readSuccess", "casSuccess", "error"], "response union");
  exactKeys(manifest.transport.wireUnionRules.response.readSuccess, ["requestOperation", "ok", "result", "error"], "read response union");
  exactKeys(manifest.transport.wireUnionRules.response.casSuccess, ["requestOperation", "ok", "result", "error"], "CAS response union");
  exactKeys(manifest.transport.wireUnionRules.response.error, ["requestOperation", "ok", "result", "error", "codeOperation", "commitDisposition"], "error response union");
  exactKeys(manifest.transport.wireUnionRules.typedPortTranslation, ["common", "uninitialized", "committed", "cas"], "translation union");
  assert.deepEqual(manifest.transport.wireUnionRules.response.readSuccess, {
    requestOperation: "read", ok: true, result: "exact-snapshot", error: null,
  });
  assert.deepEqual(manifest.transport.wireUnionRules.response.casSuccess, {
    requestOperation: "compare_and_swap", ok: true,
    result: "exact-casResult-current-snapshot", error: null,
  });
  assert.deepEqual(manifest.transport.wireUnionRules.response.error, {
    requestOperation: "read-or-compare_and_swap", ok: false, result: null,
    error: "exact-externalError", codeOperation: "definition-must-contain-request-operation",
    commitDisposition: "errors.operationDispositionRules-for-request-operation",
  });
});

test("external errors have operation-dependent dispositions and existing upper mappings", () => {
  exactKeys(manifest.errors, [
    "namespace", "futureAdapterSeam", "backendGuarantee", "status", "choiceRationale", "exactKeys",
    "codeDefinitionExactKeys", "operationVocabulary", "retryAfterMsValues",
    "commitDispositions", "recordOrSecretDetailsAllowed", "codes",
    "operationDispositionRules", "upperClosedMapping",
  ], "errors");
  assert.deepEqual(manifest.errors.exactKeys, ["code", "retryable", "retryAfterMs", "commitDisposition"]);
  exactKeys(manifest.errors.operationDispositionRules, ["read", "compareAndSwap", "provisioning"], "disposition rules");
  exactKeys(manifest.errors.operationDispositionRules.read, ["allowedCodes", "commitDisposition"], "read disposition");
  exactKeys(manifest.errors.operationDispositionRules.compareAndSwap, ["allowedCodes", "commitDisposition", "allowedDispositions"], "CAS disposition");
  exactKeys(manifest.errors.operationDispositionRules.provisioning, ["allowedCodes", "commitDisposition"], "provisioning disposition");
  assert.equal(manifest.errors.operationDispositionRules.read.commitDisposition, "not_applicable");
  assert.deepEqual(manifest.errors.operationDispositionRules.compareAndSwap.allowedDispositions, ["proven_no_commit", "uncertain"]);
  unique(manifest.errors.codes.map(({ code }) => code), "external error codes");
  for (const definition of manifest.errors.codes) {
    exactKeys(definition, manifest.errors.codeDefinitionExactKeys, definition.code);
    assert.ok(definition.operations.length > 0);
    unique(definition.operations, `${definition.code}.operations`);
    assert.ok(definition.operations.every((operation) => manifest.errors.operationVocabulary.includes(operation)));
    member(definition.retryAfterMsPolicy, ["null", "required-scalar-retryAfterMs"], `${definition.code}.retryAfterMsPolicy`);
    assert.equal(definition.retryAfterMsPolicy === "required-scalar-retryAfterMs", definition.retryable);
    member(definition.casCommitDisposition, manifest.errors.commitDispositions, `${definition.code}.CAS`);
    if (definition.operations.includes("compare_and_swap")) {
      assert.notEqual(definition.casCommitDisposition, "not_applicable");
    }
  }
  for (const value of cases.values()) {
    if (value.expect.externalErrors.length === 0) continue;
    const definition = errorByCode.get(value.expect.externalErrors[0]);
    if (value.action.operation === "compare_and_swap") {
      assert.ok(definition.operations.includes("compare_and_swap"), value.name);
      assert.equal(value.expect.externalCommitDisposition, definition.casCommitDisposition, value.name);
    } else {
      assert.equal(value.expect.externalCommitDisposition, "not_applicable", value.name);
      if (["read", "access"].includes(value.action.operation)) {
        assert.ok(definition.operations.includes("read"), value.name);
      }
      if (value.action.operation === "provision") {
        assert.ok(definition.operations.includes("provisioning"), value.name);
      }
    }
  }
  assert.equal(manifest.errors.upperClosedMapping.backendReadError, "RelayV2ContinuityAnchor.ANCHOR_UNAVAILABLE");
  assert.equal(manifest.errors.upperClosedMapping.backendCasErrorIncludingDefiniteRejection, "RelayV2ContinuityAnchor.ANCHOR_COMMIT_UNCERTAIN");
  assert.equal(caseNamed("capacity-before-cas-linearization").expect.externalCommitDisposition, "proven_no_commit");
  assert.equal(caseNamed("capacity-before-cas-linearization").expect.continuityError, "ANCHOR_COMMIT_UNCERTAIN");
});

test("fixture schema, identifiers, references, and binding anchors are closed", () => {
  exactKeys(machine, ["contract", "contractVersion", "fixtureFormatVersion", "vocabulary", "defaults", "bindings", "checkpoints", "cases"], "machine");
  assert.equal(machine.contract, manifest.contract);
  assert.equal(machine.contractVersion, manifest.contractVersion);
  exactKeys(machine.defaults, ["initial", "action", "expect"], "defaults");
  exactKeys(machine.defaults.initial, initialKeys, "default initial");
  exactKeys(machine.defaults.action, actionKeys, "default action");
  exactKeys(machine.defaults.expect, expectKeys, "default expect");
  exactKeys(machine.vocabulary, [
    "categories", "lifecycles", "operations", "requestIdentities", "faults", "outcomes",
    "externalErrors", "externalCommitDispositions", "continuityErrors", "credentialErrors",
    "checkpointRefs", "casTokenRefs", "admissions", "connectionFences", "nextActions",
  ], "vocabulary");
  for (const [name, values] of Object.entries(machine.vocabulary)) unique(values, `vocabulary.${name}`);
  assert.deepEqual(sorted(machine.vocabulary.externalErrors.filter(Boolean)), sorted(errorByCode.keys()));
  for (const id of checkpointById.keys()) assert.ok(machine.vocabulary.checkpointRefs.includes(id), id);
  unique(manifest.transport.namespaces, "transport namespaces");
  assert.deepEqual(sorted(manifest.transport.namespaces), sorted(manifest.namespaces.map(({ name }) => name)));
  assert.equal(manifest.transport.namespaceBindingsRules.maximumItems, manifest.transport.namespaces.length);

  const identifier = manifest.interface.scalarSchemas.identifier;
  const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
  const assertIdentifier = (value, label) => {
    assert.ok(identifierPattern.test(value), label);
    assert.ok(Buffer.byteLength(value, "utf8") <= identifier.maximum, label);
  };
  unique(machine.bindings.map(({ id }) => id), "binding ids");
  unique(machine.bindings.map(({ anchorId }) => anchorId), "anchor ids");
  for (const binding of machine.bindings) {
    exactKeys(binding, ["id", ...manifest.provisioning.bindingExactKeys], binding.id);
    assertIdentifier(binding.securityDomainId, `${binding.id}.securityDomainId`);
    assertIdentifier(binding.ownerBinding, `${binding.id}.ownerBinding`);
    assertIdentifier(binding.anchorId, `${binding.id}.anchorId`);
    member(binding.namespace, manifest.transport.namespaces, `${binding.id}.namespace`);
  }
  const beforeReset = bindingById.get("broker-a");
  const afterReset = bindingById.get("broker-a-reset");
  assert.equal(manifest.provisioning.resetPreservesExactSecurityDomainNamespaceOwnerBinding, true);
  assert.deepEqual(
    [afterReset.securityDomainId, afterReset.namespace, afterReset.ownerBinding],
    [beforeReset.securityDomainId, beforeReset.namespace, beforeReset.ownerBinding],
  );
  assert.notEqual(afterReset.anchorId, beforeReset.anchorId);

  unique(machine.checkpoints.map(({ id }) => id), "checkpoint ids");
  unique(machine.checkpoints.map(({ commitId }) => commitId), "commit ids");
  const commits = new Map(machine.checkpoints.map((value) => [value.commitId, value]));
  for (const checkpoint of machine.checkpoints) {
    exactKeys(checkpoint, ["id", ...manifest.interface.checkpointExactKeys], checkpoint.id);
    assert.ok(machine.bindings.some(({ anchorId }) => anchorId === checkpoint.anchorId), checkpoint.id);
    assertIdentifier(checkpoint.anchorId, `${checkpoint.id}.anchorId`);
    assertIdentifier(checkpoint.commitId, `${checkpoint.id}.commitId`);
    assert.equal(checkpoint.protocolVersion, manifest.interface.protocolVersion);
    assert.match(checkpoint.sequence, /^(0|[1-9][0-9]*)$/);
    assert.ok(BigInt(checkpoint.sequence) <= 18_446_744_073_709_551_615n, checkpoint.id);
    if (checkpoint.parentCommitId === null) assert.equal(checkpoint.sequence, "0");
    else {
      assertIdentifier(checkpoint.parentCommitId, `${checkpoint.id}.parentCommitId`);
      assert.equal(commits.get(checkpoint.parentCommitId)?.anchorId, checkpoint.anchorId, checkpoint.id);
    }
    assert.match(checkpoint.stateDigest, /^[0-9a-f]{64}$/);
  }
  for (const value of cases.values()) {
    const primary = bindingById.get(value.binding);
    const target = value.action.accessBinding === "same-binding"
      ? primary
      : bindingById.get(value.action.accessBinding);
    for (const id of [value.initial.externalCheckpoint, value.initial.localCheckpoint]) {
      if (checkpointById.has(id)) assert.equal(checkpointById.get(id).anchorId, primary.anchorId, value.name);
    }
    for (const id of value.action.candidateCheckpoints) {
      assert.equal(checkpointById.get(id).anchorId, target.anchorId, value.name);
    }
    for (const id of [value.expect.externalCheckpoint, value.expect.localCheckpoint]) {
      if (checkpointById.has(id)) {
        assert.ok([primary.anchorId, target.anchorId].includes(checkpointById.get(id).anchorId), value.name);
      }
    }
  }
  const unknownField = structuredClone(machine.cases[0]);
  unknownField.action.future = true;
  assert.throws(() => validateCase(unknownField), /unknown key future/);
  const unknownEnum = structuredClone(machine.cases[0]);
  unknownEnum.action.fault = "future_fault";
  assert.throws(() => validateCase(unknownEnum), /future_fault/);
});

test("machine deltas retain independent continuity and lifecycle fault signals", () => {
  assert.deepEqual(caseNamed("concurrent-different-successors-one-winner").expect.outcomes, ["swapped", "conflict"]);
  for (const name of ["cas-ack-loss-requires-read-reconcile", "cas-timeout-late-ack-is-ignored"]) {
    const value = caseNamed(name);
    assert.equal(value.expect.continuityError, "ANCHOR_COMMIT_UNCERTAIN");
    assert.equal(value.expect.nextAction, "linearizable-read-reconcile");
  }
  assert.equal(caseNamed("stale-read-is-not-continuity-evidence").expect.connectionFence, "synchronous-then-bounded-close");
  assert.equal(caseNamed("state-before-anchor-exact-successor-only").expect.outcomes[0], "recovered-successor");
  assert.equal(caseNamed("non-immediate-successor-fails-closed").expect.continuityError, "ROLLBACK_DETECTED");
  for (const name of ["paired-state-witness-rollback-fails-closed", "same-sequence-divergence-fails-closed"]) {
    assert.equal(caseNamed(name).expect.credentialError, "EXTERNAL_CONTINUITY_INVALID");
  }
  assert.equal(caseNamed("service-restart-preserves-high-water").expect.outcomes[0], "preserved");
  assert.equal(caseNamed("old-backup-cannot-serve").expect.outcomes[0], "refused-serving");
  assert.equal(caseNamed("backend-failover-preserves-high-water").expect.outcomes[0], "preserved");
  assert.equal(caseNamed("cross-security-domain-access-is-redacted").expect.externalCheckpoint, "redacted");
  assert.deepEqual(caseNamed("reset-tombstones-old-and-uses-new-anchor").expect.outcomes, ["tombstoned", "provisioned-new-anchor"]);
  assert.equal(caseNamed("tombstone-cannot-be-reprovisioned").expect.externalErrors[0], "ANCHOR_RETIRED");
  assert.ok(caseNamed("broker-and-agent-namespaces-are-independent").expect.outcomes.includes("isolated-from-other-namespace"));
});

test("ready loss has separate credential, production composition, and BrokerCore owners", () => {
  exactKeys(manifest.readinessFence, [
    "trigger", "credentialAuthority", "productionBrokerComposition", "brokerCore",
    "transportCloseCode", "transportCloseDeadlineMs", "sameAuthorityInstanceMayReturnReady",
    "recoveryRequires",
  ], "readiness fence");
  assert.equal(manifest.readinessFence.credentialAuthority.owner, "RelayV2BrokerCredentialAuthority");
  assert.match(manifest.readinessFence.credentialAuthority.readyAndAdmissionWithdrawal, /^synchronous/);
  assert.equal(manifest.readinessFence.productionBrokerComposition.owner, "owningProductionComposition");
  assert.match(manifest.readinessFence.productionBrokerComposition.upgradeRouteAndActiveDataFence, /^synchronous/);
  assert.equal(manifest.readinessFence.brokerCore.owner, "RelayV2BrokerCore");
  assert.match(manifest.readinessFence.brokerCore.role, /consumer-only/);
  assert.match(manifest.readinessFence.transportCloseCode, /^required-production-choice/);
  assert.match(manifest.readinessFence.transportCloseDeadlineMs, /^required-production-choice/);
  assert.doesNotMatch(manifest.readinessFence.transportCloseCode, /\d/);
  assert.doesNotMatch(manifest.readinessFence.transportCloseDeadlineMs, /\d/);
  for (const name of ["post-ready-read-unavailable-fences", "post-ready-cas-uncertain-fences"]) {
    const value = caseNamed(name);
    assert.equal(value.initial.activeConnections, true);
    assert.equal(value.expect.ready, false);
    assert.equal(value.expect.admission, "blocked");
    assert.equal(value.expect.connectionFence, "synchronous-then-bounded-close");
  }
  const qualification = caseNamed("missing-backend-rpo0-dr-evidence-blocks-composition");
  assert.equal(qualification.action.operation, "qualify_backend");
  assert.equal(qualification.action.fault, "backend_rpo0_dr_evidence_missing");
  assert.equal(qualification.expect.outcomes[0], "configuration-blocked");
  assert.equal(qualification.expect.nextAction, "qualify-backend-rpo0-and-dr-evidence");
});
