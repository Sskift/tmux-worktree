package com.tmuxworktree.mobile.core.relay.v2.state

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2CanonicalRequestArguments
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2ConfirmedTargetStep
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAcceptanceEvidence
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxArguments
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAttempt
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAttemptKind
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEntry
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxLimits
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxOperation
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2QueuedTargetRevalidation
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2ReissueLineageProof
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2ReissueTargetSnapshot
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2RequestFingerprint
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2TargetProvenance

internal data class RelayV2OutboxAuthorityNamespace(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
) {
    init {
        require(profileActivationGeneration > 0)
        listOf(profileId, principalId, clientInstanceId).forEach {
            require(it.isNotBlank())
            require(it.toByteArray(Charsets.UTF_8).size <= 128)
        }
    }
}

/** Closed codecs for Outbox authority metadata and individually keyed immutable entries. */
internal object RelayV2OutboxStorageCodec {
    const val CODEC_VERSION = 1
    private const val MAX_META_PAYLOAD_BYTES = 16 * 1024
    private const val MAX_ENTRY_PAYLOAD_BYTES = 512 * 1024
    private val JSON_LIMITS = RelayV2JsonLimits(
        maxDepth = 16,
        maxDirectKeys = 32,
        maxTotalKeys = 20_000,
        maxNodes = 40_000,
    )

    fun encodeMeta(
        namespace: RelayV2OutboxAuthorityNamespace,
        nextCreationOrder: Long,
    ): RelayV2EncodedPayload {
        require(nextCreationOrder >= 0)
        val payload = RelayV2StorageJson.encode(
            CODEC_VERSION,
            linkedMapOf(
                "codecVersion" to CODEC_VERSION,
                "namespace" to encodeNamespace(namespace),
                "nextCreationOrder" to nextCreationOrder.toString(),
            ),
        )
        if (payload.payloadUtf8Bytes > MAX_META_PAYLOAD_BYTES) {
            throw RelayV2StorageException(RelayV2StorageFailure.LIMIT_EXCEEDED)
        }
        return payload
    }

    fun decodeMeta(
        namespace: RelayV2OutboxAuthorityNamespace,
        explicitNextCreationOrder: Long,
        payload: RelayV2EncodedPayload,
    ): Long = try {
        val root = RelayV2StorageJson.decode(
            payload,
            CODEC_VERSION,
            MAX_META_PAYLOAD_BYTES,
            JSON_LIMITS,
        )
        RelayV2StorageJson.requireKeys(
            root,
            "codecVersion",
            "namespace",
            "nextCreationOrder",
        )
        if (RelayV2StorageJson.int(root, "codecVersion") != CODEC_VERSION ||
            decodeNamespace(RelayV2StorageJson.objectValue(root, "namespace")) != namespace
        ) {
            throw RelayV2StorageException(RelayV2StorageFailure.SCHEMA_INCOMPATIBLE)
        }
        RelayV2StorageJson.decimalLong(root, "nextCreationOrder").also { decoded ->
            if (decoded < 0 || decoded != explicitNextCreationOrder) {
                throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
            }
        }
    } catch (failure: RelayV2StorageException) {
        throw failure
    } catch (_: IllegalArgumentException) {
        throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
    }

    fun encodeEntry(
        namespace: RelayV2OutboxAuthorityNamespace,
        entry: RelayV2OutboxEntry,
    ): RelayV2EncodedPayload {
        requireNamespace(namespace, entry)
        val payload = RelayV2StorageJson.encode(
            CODEC_VERSION,
            linkedMapOf(
                "codecVersion" to CODEC_VERSION,
                "namespace" to encodeNamespace(namespace),
                "entry" to encodeEntryValue(entry),
            ),
        )
        if (payload.payloadUtf8Bytes > MAX_ENTRY_PAYLOAD_BYTES) {
            throw RelayV2StorageException(RelayV2StorageFailure.LIMIT_EXCEEDED)
        }
        return payload
    }

    fun decodeEntry(
        namespace: RelayV2OutboxAuthorityNamespace,
        hostId: String,
        expectedHostEpoch: String,
        commandId: String,
        explicitCreatedOrder: Long,
        payload: RelayV2EncodedPayload,
    ): RelayV2OutboxEntry = try {
        val root = RelayV2StorageJson.decode(
            payload,
            CODEC_VERSION,
            MAX_ENTRY_PAYLOAD_BYTES,
            JSON_LIMITS,
        )
        RelayV2StorageJson.requireKeys(root, "codecVersion", "namespace", "entry")
        if (RelayV2StorageJson.int(root, "codecVersion") != CODEC_VERSION ||
            decodeNamespace(RelayV2StorageJson.objectValue(root, "namespace")) != namespace
        ) {
            throw RelayV2StorageException(RelayV2StorageFailure.SCHEMA_INCOMPATIBLE)
        }
        decodeEntryValue(RelayV2StorageJson.objectValue(root, "entry")).also { entry ->
            requireNamespace(namespace, entry)
            if (entry.hostId != hostId || entry.expectedHostEpoch != expectedHostEpoch ||
                entry.commandId != commandId || entry.createdOrder != explicitCreatedOrder
            ) {
                throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
            }
            entry.validateForRestore()
        }
    } catch (failure: RelayV2StorageException) {
        throw failure
    } catch (_: IllegalArgumentException) {
        throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
    }

    private fun encodeNamespace(
        namespace: RelayV2OutboxAuthorityNamespace,
    ): Map<String, Any?> = mapOf(
        "profileId" to namespace.profileId,
        "profileActivationGeneration" to namespace.profileActivationGeneration.toString(),
        "principalId" to namespace.principalId,
        "clientInstanceId" to namespace.clientInstanceId,
    )

    private fun decodeNamespace(value: Map<String, Any?>): RelayV2OutboxAuthorityNamespace {
        RelayV2StorageJson.requireKeys(
            value,
            "profileId",
            "profileActivationGeneration",
            "principalId",
            "clientInstanceId",
        )
        return RelayV2OutboxAuthorityNamespace(
            RelayV2StorageJson.string(value, "profileId"),
            RelayV2StorageJson.decimalLong(value, "profileActivationGeneration"),
            RelayV2StorageJson.string(value, "principalId"),
            RelayV2StorageJson.string(value, "clientInstanceId"),
        )
    }

    private fun encodeEntryValue(entry: RelayV2OutboxEntry): Map<String, Any?> = linkedMapOf(
        "profileId" to entry.profileId,
        "principalId" to entry.principalId,
        "hostId" to entry.hostId,
        "expectedHostEpoch" to entry.expectedHostEpoch,
        "dedupeWindowId" to entry.dedupeWindowId,
        "commandId" to entry.commandId,
        "operation" to entry.operation.name,
        "scopeId" to entry.scopeId,
        "sessionId" to entry.sessionId,
        "arguments" to encodeArguments(entry.canonicalRequestArguments.value),
        "requestFingerprint" to encodeFingerprint(entry.requestFingerprint),
        "state" to entry.state.name,
        "acceptanceEvidence" to entry.acceptanceEvidence.name,
        "attempts" to entry.attempts.map(::encodeAttempt),
        "createdOrder" to entry.createdOrder.toString(),
        "createdAtMillis" to entry.createdAtMillis.toString(),
        "replacementCommandId" to entry.replacementCommandId,
        "reissuedFromCommandId" to entry.reissuedFromCommandId,
        "targetRevalidation" to entry.targetRevalidation?.let(::encodeRevalidation),
        "reissueLineageProof" to entry.reissueLineageProof?.let(::encodeLineageProof),
        "targetProvenance" to encodeProvenance(entry.targetProvenance),
    )

    private fun decodeEntryValue(value: Map<String, Any?>): RelayV2OutboxEntry {
        RelayV2StorageJson.requireKeys(
            value,
            "profileId",
            "principalId",
            "hostId",
            "expectedHostEpoch",
            "dedupeWindowId",
            "commandId",
            "operation",
            "scopeId",
            "sessionId",
            "arguments",
            "requestFingerprint",
            "state",
            "acceptanceEvidence",
            "attempts",
            "createdOrder",
            "createdAtMillis",
            "replacementCommandId",
            "reissuedFromCommandId",
            "targetRevalidation",
            "reissueLineageProof",
            "targetProvenance",
        )
        val operation = RelayV2StorageJson.enum<RelayV2OutboxOperation>(value, "operation")
        val arguments = decodeArguments(
            operation,
            RelayV2StorageJson.objectValue(value, "arguments"),
        )
        return RelayV2OutboxEntry(
            profileId = RelayV2StorageJson.string(value, "profileId"),
            principalId = RelayV2StorageJson.string(value, "principalId"),
            hostId = RelayV2StorageJson.string(value, "hostId"),
            expectedHostEpoch = RelayV2StorageJson.string(value, "expectedHostEpoch"),
            dedupeWindowId = RelayV2StorageJson.string(value, "dedupeWindowId"),
            commandId = RelayV2StorageJson.string(value, "commandId"),
            operation = operation,
            scopeId = RelayV2StorageJson.string(value, "scopeId"),
            sessionId = RelayV2StorageJson.nullableString(value, "sessionId"),
            canonicalRequestArguments = RelayV2CanonicalRequestArguments.from(arguments),
            requestFingerprint = decodeFingerprint(
                RelayV2StorageJson.objectValue(value, "requestFingerprint"),
            ),
            state = RelayV2StorageJson.enum(value, "state"),
            acceptanceEvidence = RelayV2StorageJson.enum(value, "acceptanceEvidence"),
            attempts = RelayV2StorageJson.list(
                value,
                "attempts",
                RelayV2OutboxLimits.MAX_ATTEMPTS_PER_ENTRY,
            ).map { decodeAttempt(RelayV2StorageJson.objectValue(it)) },
            createdOrder = RelayV2StorageJson.decimalLong(value, "createdOrder"),
            createdAtMillis = RelayV2StorageJson.decimalLong(value, "createdAtMillis"),
            replacementCommandId = RelayV2StorageJson.nullableString(
                value,
                "replacementCommandId",
            ),
            reissuedFromCommandId = RelayV2StorageJson.nullableString(
                value,
                "reissuedFromCommandId",
            ),
            targetRevalidation = RelayV2StorageJson.nullableObject(
                value,
                "targetRevalidation",
            )?.let(::decodeRevalidation),
            reissueLineageProof = RelayV2StorageJson.nullableObject(
                value,
                "reissueLineageProof",
            )?.let(::decodeLineageProof),
            targetProvenance = decodeProvenance(
                RelayV2StorageJson.objectValue(value, "targetProvenance"),
            ),
        )
    }

    private fun encodeArguments(value: RelayV2OutboxArguments): Map<String, Any?> = when (value) {
        is RelayV2OutboxArguments.CreateWorktree -> linkedMapOf(
            "kind" to value.operation.name,
            "project" to value.project,
            "path" to value.path,
            "name" to value.name,
            "branch" to value.branch,
            "aiCommand" to value.aiCommand,
        )
        is RelayV2OutboxArguments.CreateTerminal -> linkedMapOf(
            "kind" to value.operation.name,
            "cwd" to value.cwd,
            "label" to value.label,
        )
        is RelayV2OutboxArguments.SendAgentMessage -> linkedMapOf(
            "kind" to value.operation.name,
            "pane" to value.pane,
            "message" to value.message,
            "submit" to value.submit,
        )
        RelayV2OutboxArguments.KillSession -> mapOf("kind" to value.operation.name)
    }

    private fun decodeArguments(
        operation: RelayV2OutboxOperation,
        value: Map<String, Any?>,
    ): RelayV2OutboxArguments {
        if (RelayV2StorageJson.string(value, "kind") != operation.name) {
            throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
        }
        return when (operation) {
            RelayV2OutboxOperation.CREATE_WORKTREE -> {
                RelayV2StorageJson.requireKeys(
                    value,
                    "kind",
                    "project",
                    "path",
                    "name",
                    "branch",
                    "aiCommand",
                )
                RelayV2OutboxArguments.CreateWorktree(
                    RelayV2StorageJson.nullableString(value, "project"),
                    RelayV2StorageJson.nullableString(value, "path"),
                    RelayV2StorageJson.nullableString(value, "name"),
                    RelayV2StorageJson.nullableString(value, "branch"),
                    RelayV2StorageJson.string(value, "aiCommand"),
                )
            }
            RelayV2OutboxOperation.CREATE_TERMINAL -> {
                RelayV2StorageJson.requireKeys(value, "kind", "cwd", "label")
                RelayV2OutboxArguments.CreateTerminal(
                    RelayV2StorageJson.string(value, "cwd"),
                    RelayV2StorageJson.nullableString(value, "label"),
                )
            }
            RelayV2OutboxOperation.SEND_AGENT_MESSAGE -> {
                RelayV2StorageJson.requireKeys(value, "kind", "pane", "message", "submit")
                RelayV2OutboxArguments.SendAgentMessage(
                    RelayV2StorageJson.int(value, "pane"),
                    RelayV2StorageJson.string(value, "message"),
                    RelayV2StorageJson.boolean(value, "submit"),
                )
            }
            RelayV2OutboxOperation.KILL_SESSION -> {
                RelayV2StorageJson.requireKeys(value, "kind")
                RelayV2OutboxArguments.KillSession
            }
        }
    }

    private fun encodeFingerprint(value: RelayV2RequestFingerprint): Map<String, Any?> = mapOf(
        "schemaVersion" to value.schemaVersion,
        "sha256Hex" to value.sha256Hex,
        "canonicalRequestByteCount" to value.canonicalRequestByteCount,
    )

    private fun decodeFingerprint(value: Map<String, Any?>): RelayV2RequestFingerprint {
        RelayV2StorageJson.requireKeys(
            value,
            "schemaVersion",
            "sha256Hex",
            "canonicalRequestByteCount",
        )
        return RelayV2RequestFingerprint(
            RelayV2StorageJson.int(value, "schemaVersion"),
            RelayV2StorageJson.string(value, "sha256Hex"),
            RelayV2StorageJson.int(value, "canonicalRequestByteCount"),
        )
    }

    private fun encodeAttempt(value: RelayV2OutboxAttempt): Map<String, Any?> = mapOf(
        "requestId" to value.requestId,
        "kind" to value.kind.name,
        "ordinal" to value.ordinal,
    )

    private fun decodeAttempt(value: Map<String, Any?>): RelayV2OutboxAttempt {
        RelayV2StorageJson.requireKeys(value, "requestId", "kind", "ordinal")
        return RelayV2OutboxAttempt(
            RelayV2StorageJson.string(value, "requestId"),
            RelayV2StorageJson.enum<RelayV2OutboxAttemptKind>(value, "kind"),
            RelayV2StorageJson.int(value, "ordinal"),
        )
    }

    private fun encodeTarget(value: RelayV2ReissueTargetSnapshot): Map<String, Any?> = mapOf(
        "expectedHostEpoch" to value.expectedHostEpoch,
        "dedupeWindowId" to value.dedupeWindowId,
        "scopeId" to value.scopeId,
        "sessionId" to value.sessionId,
        "requestFingerprint" to encodeFingerprint(value.requestFingerprint),
    )

    private fun decodeTarget(value: Map<String, Any?>): RelayV2ReissueTargetSnapshot {
        RelayV2StorageJson.requireKeys(
            value,
            "expectedHostEpoch",
            "dedupeWindowId",
            "scopeId",
            "sessionId",
            "requestFingerprint",
        )
        return RelayV2ReissueTargetSnapshot(
            RelayV2StorageJson.string(value, "expectedHostEpoch"),
            RelayV2StorageJson.string(value, "dedupeWindowId"),
            RelayV2StorageJson.string(value, "scopeId"),
            RelayV2StorageJson.nullableString(value, "sessionId"),
            decodeFingerprint(RelayV2StorageJson.objectValue(value, "requestFingerprint")),
        )
    }

    private fun encodeStep(value: RelayV2ConfirmedTargetStep): Map<String, Any?> = mapOf(
        "sourceTarget" to encodeTarget(value.sourceTarget),
        "confirmedTarget" to encodeTarget(value.confirmedTarget),
        "confirmationOrdinal" to value.confirmationOrdinal.toString(),
    )

    private fun decodeStep(value: Map<String, Any?>): RelayV2ConfirmedTargetStep {
        RelayV2StorageJson.requireKeys(
            value,
            "sourceTarget",
            "confirmedTarget",
            "confirmationOrdinal",
        )
        return RelayV2ConfirmedTargetStep(
            decodeTarget(RelayV2StorageJson.objectValue(value, "sourceTarget")),
            decodeTarget(RelayV2StorageJson.objectValue(value, "confirmedTarget")),
            RelayV2StorageJson.decimalLong(value, "confirmationOrdinal"),
        )
    }

    private fun encodeProvenance(value: RelayV2TargetProvenance): Map<String, Any?> = mapOf(
        "initialTarget" to encodeTarget(value.initialTarget),
        "confirmedHistory" to value.confirmedHistory.map(::encodeStep),
    )

    private fun decodeProvenance(value: Map<String, Any?>): RelayV2TargetProvenance {
        RelayV2StorageJson.requireKeys(value, "initialTarget", "confirmedHistory")
        return RelayV2TargetProvenance(
            decodeTarget(RelayV2StorageJson.objectValue(value, "initialTarget")),
            RelayV2StorageJson.list(
                value,
                "confirmedHistory",
                RelayV2OutboxLimits.MAX_TARGET_PROVENANCE_STEPS,
            ).map { decodeStep(RelayV2StorageJson.objectValue(it)) },
        )
    }

    private fun encodeRevalidation(value: RelayV2QueuedTargetRevalidation): Map<String, Any?> =
        mapOf(
            "observedHostEpoch" to value.observedHostEpoch,
            "dedupeWindowId" to value.dedupeWindowId,
            "proposedTarget" to encodeTarget(value.proposedTarget),
            "sourceConfirmedTarget" to encodeTarget(value.sourceConfirmedTarget),
            "confirmationOrdinal" to value.confirmationOrdinal.toString(),
        )

    private fun decodeRevalidation(value: Map<String, Any?>): RelayV2QueuedTargetRevalidation {
        RelayV2StorageJson.requireKeys(
            value,
            "observedHostEpoch",
            "dedupeWindowId",
            "proposedTarget",
            "sourceConfirmedTarget",
            "confirmationOrdinal",
        )
        return RelayV2QueuedTargetRevalidation(
            RelayV2StorageJson.string(value, "observedHostEpoch"),
            RelayV2StorageJson.string(value, "dedupeWindowId"),
            decodeTarget(RelayV2StorageJson.objectValue(value, "proposedTarget")),
            decodeTarget(RelayV2StorageJson.objectValue(value, "sourceConfirmedTarget")),
            RelayV2StorageJson.decimalLong(value, "confirmationOrdinal"),
        )
    }

    private fun encodeLineageProof(value: RelayV2ReissueLineageProof): Map<String, Any?> =
        linkedMapOf(
            "parentProfileId" to value.parentProfileId,
            "parentPrincipalId" to value.parentPrincipalId,
            "parentHostId" to value.parentHostId,
            "parentCommandId" to value.parentCommandId,
            "parentExpectedHostEpoch" to value.parentExpectedHostEpoch,
            "parentDedupeWindowId" to value.parentDedupeWindowId,
            "parentScopeId" to value.parentScopeId,
            "parentSessionId" to value.parentSessionId,
            "parentRequestFingerprint" to encodeFingerprint(value.parentRequestFingerprint),
            "replacementProfileId" to value.replacementProfileId,
            "replacementPrincipalId" to value.replacementPrincipalId,
            "replacementHostId" to value.replacementHostId,
            "replacementCommandId" to value.replacementCommandId,
            "replacementInitialTarget" to encodeTarget(value.replacementInitialTarget),
        )

    private fun decodeLineageProof(value: Map<String, Any?>): RelayV2ReissueLineageProof {
        RelayV2StorageJson.requireKeys(
            value,
            "parentProfileId",
            "parentPrincipalId",
            "parentHostId",
            "parentCommandId",
            "parentExpectedHostEpoch",
            "parentDedupeWindowId",
            "parentScopeId",
            "parentSessionId",
            "parentRequestFingerprint",
            "replacementProfileId",
            "replacementPrincipalId",
            "replacementHostId",
            "replacementCommandId",
            "replacementInitialTarget",
        )
        return RelayV2ReissueLineageProof(
            RelayV2StorageJson.string(value, "parentProfileId"),
            RelayV2StorageJson.string(value, "parentPrincipalId"),
            RelayV2StorageJson.string(value, "parentHostId"),
            RelayV2StorageJson.string(value, "parentCommandId"),
            RelayV2StorageJson.string(value, "parentExpectedHostEpoch"),
            RelayV2StorageJson.string(value, "parentDedupeWindowId"),
            RelayV2StorageJson.string(value, "parentScopeId"),
            RelayV2StorageJson.nullableString(value, "parentSessionId"),
            decodeFingerprint(RelayV2StorageJson.objectValue(value, "parentRequestFingerprint")),
            RelayV2StorageJson.string(value, "replacementProfileId"),
            RelayV2StorageJson.string(value, "replacementPrincipalId"),
            RelayV2StorageJson.string(value, "replacementHostId"),
            RelayV2StorageJson.string(value, "replacementCommandId"),
            decodeTarget(RelayV2StorageJson.objectValue(value, "replacementInitialTarget")),
        )
    }

    private fun requireNamespace(
        namespace: RelayV2OutboxAuthorityNamespace,
        entry: RelayV2OutboxEntry,
    ) {
        if (entry.profileId != namespace.profileId ||
            entry.principalId != namespace.principalId
        ) {
            throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
        }
    }
}
