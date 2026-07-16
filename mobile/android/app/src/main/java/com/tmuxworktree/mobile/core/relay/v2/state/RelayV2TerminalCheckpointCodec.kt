package com.tmuxworktree.mobile.core.relay.v2.state

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectGeneration
import com.tmuxworktree.mobile.core.relay.v2.terminal.*
import java.util.Base64

/** Exact stable target key. Host process/generation lineage intentionally remains in the payload. */
internal data class RelayV2TerminalCheckpointKey(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val streamId: String,
    val pane: Int,
) {
    init {
        toTarget()
    }

    fun toTarget(): RelayV2TerminalOpenTarget = RelayV2TerminalOpenTarget(
        profileId,
        profileActivationGeneration,
        principalId,
        clientInstanceId,
        hostId,
        hostEpoch,
        scopeId,
        sessionId,
        streamId,
        pane,
    )

    companion object {
        fun from(target: RelayV2TerminalOpenTarget): RelayV2TerminalCheckpointKey =
            RelayV2TerminalCheckpointKey(
                target.profileId,
                target.profileActivationGeneration,
                target.principalId,
                target.clientInstanceId,
                target.hostId,
                target.hostEpoch,
                target.scopeId,
                target.sessionId,
                target.streamId,
                target.pane,
            )
    }
}

internal enum class RelayV2TerminalCheckpointKind {
    PRE_OPEN,
    PRESENT,
}

internal data class RelayV2EncodedTerminalCheckpoint(
    val kind: RelayV2TerminalCheckpointKind,
    val payload: RelayV2EncodedPayload,
)

/** Closed storage codec for the full terminal checkpoint union. */
internal object RelayV2TerminalCheckpointCodec {
    const val CODEC_VERSION = 1
    private const val MAX_PAYLOAD_BYTES = 4 * 1024 * 1024
    private val JSON_LIMITS = RelayV2JsonLimits(
        maxDepth = 24,
        maxDirectKeys = 64,
        maxTotalKeys = 300_000,
        maxNodes = 600_000,
    )

    fun encode(
        key: RelayV2TerminalCheckpointKey,
        stored: RelayV2TerminalStoredCheckpoint,
    ): RelayV2EncodedTerminalCheckpoint {
        val (kind, checkpoint) = when (stored) {
            is RelayV2TerminalStoredCheckpoint.PreOpen -> {
                requireKey(key, stored.checkpoint.target)
                RelayV2TerminalCheckpointKind.PRE_OPEN to encodePreOpen(stored.checkpoint)
            }
            is RelayV2TerminalStoredCheckpoint.Present -> {
                requireKey(key, stored.checkpoint.identity.target())
                RelayV2TerminalCheckpointKind.PRESENT to encodeCheckpoint(stored.checkpoint)
            }
            is RelayV2TerminalStoredCheckpoint.Invalid,
            RelayV2TerminalStoredCheckpoint.Missing,
            -> throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
        }
        val payload = RelayV2StorageJson.encode(
            CODEC_VERSION,
            linkedMapOf(
                "codecVersion" to CODEC_VERSION,
                "kind" to kind.name,
                "checkpoint" to checkpoint,
            ),
        )
        if (payload.payloadUtf8Bytes > MAX_PAYLOAD_BYTES) {
            throw RelayV2StorageException(RelayV2StorageFailure.LIMIT_EXCEEDED)
        }
        return RelayV2EncodedTerminalCheckpoint(kind, payload)
    }

    fun decode(
        key: RelayV2TerminalCheckpointKey,
        encodedKind: String,
        payload: RelayV2EncodedPayload,
    ): RelayV2TerminalStoredCheckpoint = try {
        val kind = RelayV2TerminalCheckpointKind.entries.singleOrNull {
            it.name == encodedKind
        } ?: throw RelayV2StorageException(RelayV2StorageFailure.SCHEMA_INCOMPATIBLE)
        val root = RelayV2StorageJson.decode(
            payload,
            CODEC_VERSION,
            MAX_PAYLOAD_BYTES,
            JSON_LIMITS,
        )
        RelayV2StorageJson.requireKeys(root, "codecVersion", "kind", "checkpoint")
        if (RelayV2StorageJson.int(root, "codecVersion") != CODEC_VERSION ||
            RelayV2StorageJson.string(root, "kind") != kind.name
        ) {
            throw RelayV2StorageException(RelayV2StorageFailure.SCHEMA_INCOMPATIBLE)
        }
        when (kind) {
            RelayV2TerminalCheckpointKind.PRE_OPEN -> {
                val checkpoint = decodePreOpen(
                    RelayV2StorageJson.objectValue(root, "checkpoint"),
                )
                requireKey(key, checkpoint.target)
                RelayV2TerminalStoredCheckpoint.PreOpen(checkpoint)
            }
            RelayV2TerminalCheckpointKind.PRESENT -> {
                val checkpoint = decodeCheckpoint(
                    RelayV2StorageJson.objectValue(root, "checkpoint"),
                )
                requireKey(key, checkpoint.identity.target())
                RelayV2TerminalStoredCheckpoint.Present(checkpoint)
            }
        }
    } catch (failure: RelayV2StorageException) {
        RelayV2TerminalStoredCheckpoint.Invalid(failure.toRestoreInvalidity())
    } catch (_: IllegalArgumentException) {
        RelayV2TerminalStoredCheckpoint.Invalid(RelayV2TerminalRestoreInvalidity.CORRUPT_QUEUE)
    }

    private fun encodeTarget(value: RelayV2TerminalOpenTarget): Map<String, Any?> = linkedMapOf(
        "profileId" to value.profileId,
        "profileActivationGeneration" to value.profileActivationGeneration.toString(),
        "principalId" to value.principalId,
        "clientInstanceId" to value.clientInstanceId,
        "hostId" to value.hostId,
        "hostEpoch" to value.hostEpoch,
        "scopeId" to value.scopeId,
        "sessionId" to value.sessionId,
        "streamId" to value.streamId,
        "pane" to value.pane,
    )

    private fun decodeTarget(value: Map<String, Any?>): RelayV2TerminalOpenTarget {
        RelayV2StorageJson.requireKeys(
            value,
            "profileId",
            "profileActivationGeneration",
            "principalId",
            "clientInstanceId",
            "hostId",
            "hostEpoch",
            "scopeId",
            "sessionId",
            "streamId",
            "pane",
        )
        return RelayV2TerminalOpenTarget(
            RelayV2StorageJson.string(value, "profileId"),
            RelayV2StorageJson.decimalLong(value, "profileActivationGeneration"),
            RelayV2StorageJson.string(value, "principalId"),
            RelayV2StorageJson.string(value, "clientInstanceId"),
            RelayV2StorageJson.string(value, "hostId"),
            RelayV2StorageJson.string(value, "hostEpoch"),
            RelayV2StorageJson.string(value, "scopeId"),
            RelayV2StorageJson.string(value, "sessionId"),
            RelayV2StorageJson.string(value, "streamId"),
            RelayV2StorageJson.int(value, "pane"),
        )
    }

    private fun encodeIdentity(value: RelayV2TerminalIdentity): Map<String, Any?> = linkedMapOf(
        "identityVersion" to value.identityVersion,
        "profileId" to value.profileId,
        "profileActivationGeneration" to value.profileActivationGeneration.toString(),
        "principalId" to value.principalId,
        "clientInstanceId" to value.clientInstanceId,
        "hostId" to value.hostId,
        "hostEpoch" to value.hostEpoch,
        "hostInstanceId" to value.hostInstanceId,
        "scopeId" to value.scopeId,
        "sessionId" to value.sessionId,
        "streamId" to value.streamId,
        "generation" to value.generation,
        "resumeTokenCredentialReference" to value.resumeTokenCredentialReference,
        "resumeTokenCredentialFingerprint" to value.resumeTokenCredentialFingerprint,
        "pane" to value.pane,
    )

    private fun decodeIdentity(value: Map<String, Any?>): RelayV2TerminalIdentity {
        RelayV2StorageJson.requireKeys(
            value,
            "identityVersion",
            "profileId",
            "profileActivationGeneration",
            "principalId",
            "clientInstanceId",
            "hostId",
            "hostEpoch",
            "hostInstanceId",
            "scopeId",
            "sessionId",
            "streamId",
            "generation",
            "resumeTokenCredentialReference",
            "resumeTokenCredentialFingerprint",
            "pane",
        )
        return RelayV2TerminalIdentity(
            RelayV2StorageJson.int(value, "identityVersion"),
            RelayV2StorageJson.string(value, "profileId"),
            RelayV2StorageJson.decimalLong(value, "profileActivationGeneration"),
            RelayV2StorageJson.string(value, "principalId"),
            RelayV2StorageJson.string(value, "clientInstanceId"),
            RelayV2StorageJson.string(value, "hostId"),
            RelayV2StorageJson.string(value, "hostEpoch"),
            RelayV2StorageJson.string(value, "hostInstanceId"),
            RelayV2StorageJson.string(value, "scopeId"),
            RelayV2StorageJson.string(value, "sessionId"),
            RelayV2StorageJson.string(value, "streamId"),
            RelayV2StorageJson.string(value, "generation"),
            RelayV2StorageJson.string(value, "resumeTokenCredentialReference"),
            RelayV2StorageJson.string(value, "resumeTokenCredentialFingerprint"),
            RelayV2StorageJson.int(value, "pane"),
        )
    }

    private fun encodeDelivery(value: RelayV2TerminalDeliveryToken): Map<String, Any?> = mapOf(
        "profileId" to value.actorGeneration.profileId,
        "profileGeneration" to value.actorGeneration.profileGeneration.toString(),
        "connectionGeneration" to value.actorGeneration.connectionGeneration.toString(),
        "authorityGeneration" to value.authorityGeneration.toString(),
        "localDispatchToken" to value.localDispatchToken.toString(),
    )

    private fun decodeDelivery(value: Map<String, Any?>): RelayV2TerminalDeliveryToken {
        RelayV2StorageJson.requireKeys(
            value,
            "profileId",
            "profileGeneration",
            "connectionGeneration",
            "authorityGeneration",
            "localDispatchToken",
        )
        return RelayV2TerminalDeliveryToken(
            RelayV2EffectGeneration(
                RelayV2StorageJson.string(value, "profileId"),
                RelayV2StorageJson.decimalLong(value, "profileGeneration"),
                RelayV2StorageJson.decimalLong(value, "connectionGeneration"),
            ),
            RelayV2StorageJson.decimalLong(value, "authorityGeneration"),
            RelayV2StorageJson.decimalLong(value, "localDispatchToken"),
        )
    }

    private fun encodeOpenAttempt(value: RelayV2TerminalOpenAttempt): Map<String, Any?> = mapOf(
        "openId" to value.openId,
        "fingerprint" to value.fingerprint,
    )

    private fun decodeOpenAttempt(value: Map<String, Any?>): RelayV2TerminalOpenAttempt {
        RelayV2StorageJson.requireKeys(value, "openId", "fingerprint")
        return RelayV2TerminalOpenAttempt(
            RelayV2StorageJson.string(value, "openId"),
            RelayV2StorageJson.string(value, "fingerprint"),
        )
    }

    private fun encodeCloseAttempt(value: RelayV2TerminalCloseAttempt): Map<String, Any?> = mapOf(
        "closeId" to value.closeId,
        "fingerprint" to value.fingerprint,
    )

    private fun decodeCloseAttempt(value: Map<String, Any?>): RelayV2TerminalCloseAttempt {
        RelayV2StorageJson.requireKeys(value, "closeId", "fingerprint")
        return RelayV2TerminalCloseAttempt(
            RelayV2StorageJson.string(value, "closeId"),
            RelayV2StorageJson.string(value, "fingerprint"),
        )
    }

    private fun encodeOpenResume(value: RelayV2TerminalOpenResume): Map<String, Any?> = mapOf(
        "generation" to value.generation,
        "nextOffset" to value.nextOffset,
        "resumeTokenCredentialReference" to value.resumeTokenCredentialReference,
        "resumeTokenCredentialFingerprint" to value.resumeTokenCredentialFingerprint,
    )

    private fun decodeOpenResume(value: Map<String, Any?>): RelayV2TerminalOpenResume {
        RelayV2StorageJson.requireKeys(
            value,
            "generation",
            "nextOffset",
            "resumeTokenCredentialReference",
            "resumeTokenCredentialFingerprint",
        )
        return RelayV2TerminalOpenResume(
            RelayV2StorageJson.string(value, "generation"),
            RelayV2StorageJson.nullableString(value, "nextOffset"),
            RelayV2StorageJson.string(value, "resumeTokenCredentialReference"),
            RelayV2StorageJson.string(value, "resumeTokenCredentialFingerprint"),
        )
    }

    private fun encodeEffectFence(value: RelayV2TerminalEffectFence): Map<String, Any?> = mapOf(
        "identity" to encodeIdentity(value.identity),
        "deliveryToken" to encodeDelivery(value.deliveryToken),
        "openAttempt" to encodeOpenAttempt(value.openAttempt),
    )

    private fun decodeEffectFence(value: Map<String, Any?>): RelayV2TerminalEffectFence {
        RelayV2StorageJson.requireKeys(value, "identity", "deliveryToken", "openAttempt")
        return RelayV2TerminalEffectFence(
            decodeIdentity(RelayV2StorageJson.objectValue(value, "identity")),
            decodeDelivery(RelayV2StorageJson.objectValue(value, "deliveryToken")),
            decodeOpenAttempt(RelayV2StorageJson.objectValue(value, "openAttempt")),
        )
    }

    private fun encodeOpenFence(value: RelayV2TerminalOpenFence): Map<String, Any?> = linkedMapOf(
        "target" to encodeTarget(value.target),
        "deliveryToken" to encodeDelivery(value.deliveryToken),
        "openAttempt" to encodeOpenAttempt(value.openAttempt),
        "parserContinuityId" to value.parserContinuityId,
        "mode" to value.mode.name,
        "cols" to value.cols,
        "rows" to value.rows,
        "resume" to value.resume?.let(::encodeOpenResume),
    )

    private fun decodeOpenFence(value: Map<String, Any?>): RelayV2TerminalOpenFence {
        RelayV2StorageJson.requireKeys(
            value,
            "target",
            "deliveryToken",
            "openAttempt",
            "parserContinuityId",
            "mode",
            "cols",
            "rows",
            "resume",
        )
        return RelayV2TerminalOpenFence(
            decodeTarget(RelayV2StorageJson.objectValue(value, "target")),
            decodeDelivery(RelayV2StorageJson.objectValue(value, "deliveryToken")),
            decodeOpenAttempt(RelayV2StorageJson.objectValue(value, "openAttempt")),
            RelayV2StorageJson.string(value, "parserContinuityId"),
            RelayV2StorageJson.enum(value, "mode"),
            RelayV2StorageJson.int(value, "cols"),
            RelayV2StorageJson.int(value, "rows"),
            RelayV2StorageJson.nullableObject(value, "resume")?.let(::decodeOpenResume),
        )
    }

    private fun encodeParserToken(value: RelayV2TerminalParserCallbackToken): Map<String, Any?> =
        linkedMapOf(
            "fence" to encodeEffectFence(value.fence),
            "parserContinuityId" to value.parserContinuityId,
            "operationId" to value.operationId,
            "startOffset" to value.startOffset,
            "endOffset" to value.endOffset,
        )

    private fun decodeParserToken(value: Map<String, Any?>): RelayV2TerminalParserCallbackToken {
        RelayV2StorageJson.requireKeys(
            value,
            "fence",
            "parserContinuityId",
            "operationId",
            "startOffset",
            "endOffset",
        )
        return RelayV2TerminalParserCallbackToken(
            decodeEffectFence(RelayV2StorageJson.objectValue(value, "fence")),
            RelayV2StorageJson.string(value, "parserContinuityId"),
            RelayV2StorageJson.string(value, "operationId"),
            RelayV2StorageJson.string(value, "startOffset"),
            RelayV2StorageJson.string(value, "endOffset"),
        )
    }

    private fun encodePendingOpen(value: RelayV2TerminalPendingOpen): Map<String, Any?> =
        linkedMapOf(
            "requestId" to value.requestId,
            "issuedRequestIds" to value.issuedRequestIds,
            "deliveryToken" to encodeDelivery(value.deliveryToken),
            "openAttempt" to encodeOpenAttempt(value.openAttempt),
            "mode" to value.mode.name,
            "cols" to value.cols,
            "rows" to value.rows,
            "target" to encodeTarget(value.target),
            "parserContinuityId" to value.parserContinuityId,
            "resume" to value.resume?.let(::encodeOpenResume),
            "requiresDeduplicatedResponse" to value.requiresDeduplicatedResponse,
        )

    private fun decodePendingOpen(value: Map<String, Any?>): RelayV2TerminalPendingOpen {
        RelayV2StorageJson.requireKeys(
            value,
            "requestId",
            "issuedRequestIds",
            "deliveryToken",
            "openAttempt",
            "mode",
            "cols",
            "rows",
            "target",
            "parserContinuityId",
            "resume",
            "requiresDeduplicatedResponse",
        )
        return RelayV2TerminalPendingOpen(
            RelayV2StorageJson.string(value, "requestId"),
            RelayV2StorageJson.stringList(
                value,
                "issuedRequestIds",
                RelayV2TerminalCheckpointLimits.MAX_NETWORK_REQUEST_IDS,
            ),
            decodeDelivery(RelayV2StorageJson.objectValue(value, "deliveryToken")),
            decodeOpenAttempt(RelayV2StorageJson.objectValue(value, "openAttempt")),
            RelayV2StorageJson.enum(value, "mode"),
            RelayV2StorageJson.int(value, "cols"),
            RelayV2StorageJson.int(value, "rows"),
            decodeTarget(RelayV2StorageJson.objectValue(value, "target")),
            RelayV2StorageJson.string(value, "parserContinuityId"),
            RelayV2StorageJson.nullableObject(value, "resume")?.let(::decodeOpenResume),
            RelayV2StorageJson.boolean(value, "requiresDeduplicatedResponse"),
        )
    }

    private fun encodePreOpen(value: RelayV2TerminalPreOpenCheckpoint): Map<String, Any?> =
        linkedMapOf(
            "schemaVersion" to value.schemaVersion,
            "target" to encodeTarget(value.target),
            "deliveryToken" to encodeDelivery(value.deliveryToken),
            "parserContinuityId" to value.parserContinuityId,
            "openRequestIds" to value.openRequestIds,
            "phase" to value.phase.name,
            "pendingOpen" to value.pendingOpen?.let(::encodePendingOpen),
            "resetReason" to value.resetReason?.name,
            "resetFence" to value.resetFence?.let(::encodeOpenFence),
        )

    private fun decodePreOpen(value: Map<String, Any?>): RelayV2TerminalPreOpenCheckpoint {
        RelayV2StorageJson.requireKeys(
            value,
            "schemaVersion",
            "target",
            "deliveryToken",
            "parserContinuityId",
            "openRequestIds",
            "phase",
            "pendingOpen",
            "resetReason",
            "resetFence",
        )
        return RelayV2TerminalPreOpenCheckpoint(
            RelayV2StorageJson.int(value, "schemaVersion"),
            decodeTarget(RelayV2StorageJson.objectValue(value, "target")),
            decodeDelivery(RelayV2StorageJson.objectValue(value, "deliveryToken")),
            RelayV2StorageJson.string(value, "parserContinuityId"),
            RelayV2StorageJson.stringList(
                value,
                "openRequestIds",
                RelayV2TerminalCheckpointLimits.MAX_NETWORK_REQUEST_IDS,
            ),
            RelayV2StorageJson.enum(value, "phase"),
            RelayV2StorageJson.nullableObject(value, "pendingOpen")?.let(::decodePendingOpen),
            RelayV2StorageJson.nullableEnum<RelayV2TerminalResetReason>(value, "resetReason"),
            RelayV2StorageJson.nullableObject(value, "resetFence")?.let(::decodeOpenFence),
        )
    }

    private fun encodeOpenResult(value: RelayV2TerminalOpenResultLineage): Map<String, Any?> =
        linkedMapOf(
            "disposition" to value.disposition.name,
            "generation" to value.generation,
            "hostInstanceId" to value.hostInstanceId,
            "resumeTokenCredentialReference" to value.resumeTokenCredentialReference,
            "resumeTokenCredentialFingerprint" to value.resumeTokenCredentialFingerprint,
            "parserContinuityId" to value.parserContinuityId,
            "cols" to value.cols,
            "rows" to value.rows,
            "replayFromOffset" to value.replayFromOffset,
            "tailOffset" to value.tailOffset,
        )

    private fun decodeOpenResult(value: Map<String, Any?>): RelayV2TerminalOpenResultLineage {
        RelayV2StorageJson.requireKeys(
            value,
            "disposition",
            "generation",
            "hostInstanceId",
            "resumeTokenCredentialReference",
            "resumeTokenCredentialFingerprint",
            "parserContinuityId",
            "cols",
            "rows",
            "replayFromOffset",
            "tailOffset",
        )
        return RelayV2TerminalOpenResultLineage(
            RelayV2StorageJson.enum(value, "disposition"),
            RelayV2StorageJson.string(value, "generation"),
            RelayV2StorageJson.string(value, "hostInstanceId"),
            RelayV2StorageJson.string(value, "resumeTokenCredentialReference"),
            RelayV2StorageJson.string(value, "resumeTokenCredentialFingerprint"),
            RelayV2StorageJson.string(value, "parserContinuityId"),
            RelayV2StorageJson.int(value, "cols"),
            RelayV2StorageJson.int(value, "rows"),
            RelayV2StorageJson.string(value, "replayFromOffset"),
            RelayV2StorageJson.string(value, "tailOffset"),
        )
    }

    private fun encodeParserWrite(value: RelayV2PendingParserWrite): Map<String, Any?> = mapOf(
        "callbackToken" to encodeParserToken(value.callbackToken),
        "bytes" to Base64.getEncoder().encodeToString(value.bytes.copyBytes()),
    )

    private fun decodeParserWrite(value: Map<String, Any?>): RelayV2PendingParserWrite {
        RelayV2StorageJson.requireKeys(value, "callbackToken", "bytes")
        return RelayV2PendingParserWrite(
            decodeParserToken(RelayV2StorageJson.objectValue(value, "callbackToken")),
            decodeBytes(RelayV2StorageJson.string(value, "bytes")),
        )
    }

    private fun encodePendingReplay(value: RelayV2TerminalPendingReplay): Map<String, Any?> = mapOf(
        "requestId" to value.requestId,
        "fence" to encodeEffectFence(value.fence),
        "fromOffset" to value.fromOffset,
    )

    private fun decodePendingReplay(value: Map<String, Any?>): RelayV2TerminalPendingReplay {
        RelayV2StorageJson.requireKeys(value, "requestId", "fence", "fromOffset")
        return RelayV2TerminalPendingReplay(
            RelayV2StorageJson.string(value, "requestId"),
            decodeEffectFence(RelayV2StorageJson.objectValue(value, "fence")),
            RelayV2StorageJson.string(value, "fromOffset"),
        )
    }

    private fun encodePendingInput(value: RelayV2PendingInput): Map<String, Any?> = mapOf(
        "generation" to value.generation,
        "inputSeq" to value.inputSeq,
        "bytes" to Base64.getEncoder().encodeToString(value.bytes.copyBytes()),
        "disposition" to value.disposition.name,
    )

    private fun decodePendingInput(value: Map<String, Any?>): RelayV2PendingInput {
        RelayV2StorageJson.requireKeys(value, "generation", "inputSeq", "bytes", "disposition")
        return RelayV2PendingInput(
            RelayV2StorageJson.string(value, "generation"),
            RelayV2StorageJson.string(value, "inputSeq"),
            decodeBytes(RelayV2StorageJson.string(value, "bytes")),
            RelayV2StorageJson.enum(value, "disposition"),
        )
    }

    private fun encodePendingResize(value: RelayV2PendingResize): Map<String, Any?> = mapOf(
        "generation" to value.generation,
        "resizeSeq" to value.resizeSeq,
        "cols" to value.cols,
        "rows" to value.rows,
        "disposition" to value.disposition.name,
    )

    private fun decodePendingResize(value: Map<String, Any?>): RelayV2PendingResize {
        RelayV2StorageJson.requireKeys(
            value,
            "generation",
            "resizeSeq",
            "cols",
            "rows",
            "disposition",
        )
        return RelayV2PendingResize(
            RelayV2StorageJson.string(value, "generation"),
            RelayV2StorageJson.string(value, "resizeSeq"),
            RelayV2StorageJson.int(value, "cols"),
            RelayV2StorageJson.int(value, "rows"),
            RelayV2StorageJson.enum(value, "disposition"),
        )
    }

    private fun encodeAmbiguousInput(value: RelayV2AmbiguousInput): Map<String, Any?> = mapOf(
        "generation" to value.generation,
        "inputSeq" to value.inputSeq,
        "bytes" to Base64.getEncoder().encodeToString(value.bytes.copyBytes()),
    )

    private fun decodeAmbiguousInput(value: Map<String, Any?>): RelayV2AmbiguousInput {
        RelayV2StorageJson.requireKeys(value, "generation", "inputSeq", "bytes")
        return RelayV2AmbiguousInput(
            RelayV2StorageJson.string(value, "generation"),
            RelayV2StorageJson.string(value, "inputSeq"),
            decodeBytes(RelayV2StorageJson.string(value, "bytes")),
        )
    }

    private fun encodePendingClose(value: RelayV2TerminalPendingClose): Map<String, Any?> = mapOf(
        "closeAttempt" to encodeCloseAttempt(value.closeAttempt),
        "requestId" to value.requestId,
        "issuedRequestIds" to value.issuedRequestIds,
    )

    private fun decodePendingClose(value: Map<String, Any?>): RelayV2TerminalPendingClose {
        RelayV2StorageJson.requireKeys(value, "closeAttempt", "requestId", "issuedRequestIds")
        return RelayV2TerminalPendingClose(
            decodeCloseAttempt(RelayV2StorageJson.objectValue(value, "closeAttempt")),
            RelayV2StorageJson.string(value, "requestId"),
            RelayV2StorageJson.stringList(
                value,
                "issuedRequestIds",
                RelayV2TerminalCheckpointLimits.MAX_NETWORK_REQUEST_IDS,
            ),
        )
    }

    private fun encodeClosed(value: RelayV2TerminalClosedState): Map<String, Any?> = mapOf(
        "tombstone" to mapOf(
            "finalOffset" to value.tombstone.finalOffset,
            "reason" to value.tombstone.reason.name,
            "exitCode" to value.tombstone.exitCode,
            "closeAttempt" to value.tombstone.closeAttempt?.let(::encodeCloseAttempt),
            "generation" to value.tombstone.generation,
            "openId" to value.tombstone.openId,
        ),
        "retainedBuffer" to mapOf(
            "replayAvailable" to value.retainedBuffer.replayAvailable,
            "bufferStartOffset" to value.retainedBuffer.bufferStartOffset,
        ),
    )

    private fun decodeClosed(value: Map<String, Any?>): RelayV2TerminalClosedState {
        RelayV2StorageJson.requireKeys(value, "tombstone", "retainedBuffer")
        val tombstone = RelayV2StorageJson.objectValue(value, "tombstone")
        RelayV2StorageJson.requireKeys(
            tombstone,
            "finalOffset",
            "reason",
            "exitCode",
            "closeAttempt",
            "generation",
            "openId",
        )
        val retained = RelayV2StorageJson.objectValue(value, "retainedBuffer")
        RelayV2StorageJson.requireKeys(retained, "replayAvailable", "bufferStartOffset")
        return RelayV2TerminalClosedState(
            RelayV2TerminalClosedTombstone(
                RelayV2StorageJson.string(tombstone, "finalOffset"),
                RelayV2StorageJson.enum(tombstone, "reason"),
                RelayV2StorageJson.nullableInt(tombstone, "exitCode"),
                RelayV2StorageJson.nullableObject(tombstone, "closeAttempt")
                    ?.let(::decodeCloseAttempt),
                RelayV2StorageJson.string(tombstone, "generation"),
                RelayV2StorageJson.string(tombstone, "openId"),
            ),
            RelayV2TerminalRetainedBuffer(
                RelayV2StorageJson.boolean(retained, "replayAvailable"),
                RelayV2StorageJson.nullableString(retained, "bufferStartOffset"),
            ),
        )
    }

    private fun encodeCheckpoint(value: RelayV2TerminalCheckpoint): Map<String, Any?> =
        linkedMapOf(
            "schemaVersion" to value.schemaVersion,
            "identity" to encodeIdentity(value.identity),
            "openAttempt" to encodeOpenAttempt(value.openAttempt),
            "openMode" to value.openMode.name,
            "openRequestResume" to value.openRequestResume?.let(::encodeOpenResume),
            "openResult" to encodeOpenResult(value.openResult),
            "openRequestIds" to value.openRequestIds,
            "deliveryToken" to encodeDelivery(value.deliveryToken),
            "parserContinuityId" to value.parserContinuityId,
            "phase" to value.phase.name,
            "openedCols" to value.openedCols,
            "openedRows" to value.openedRows,
            "parserAppliedNextOffset" to value.parserAppliedNextOffset,
            "networkReceivedThrough" to value.networkReceivedThrough,
            "nextParserOperationSeq" to value.nextParserOperationSeq,
            "nextReplayRequestSeq" to value.nextReplayRequestSeq,
            "replayRequestIds" to value.replayRequestIds,
            "closeRequestIds" to value.closeRequestIds,
            "parserResetCallbackToken" to value.parserResetCallbackToken?.let(::encodeParserToken),
            "parserInFlightCallbackToken" to
                value.parserInFlightCallbackToken?.let(::encodeParserToken),
            "lastAppliedParserCallbackToken" to
                value.lastAppliedParserCallbackToken?.let(::encodeParserToken),
            "pendingOutput" to value.pendingOutput.map(::encodeParserWrite),
            "pendingOpen" to value.pendingOpen?.let(::encodePendingOpen),
            "pendingReplay" to value.pendingReplay?.let(::encodePendingReplay),
            "replayTargetOffset" to value.replayTargetOffset,
            "nextInputSeq" to value.nextInputSeq,
            "ackedThroughInputSeq" to value.ackedThroughInputSeq,
            "pendingInputs" to value.pendingInputs.map(::encodePendingInput),
            "nextResizeSeq" to value.nextResizeSeq,
            "ackedThroughResizeSeq" to value.ackedThroughResizeSeq,
            "pendingResizes" to value.pendingResizes.map(::encodePendingResize),
            "activeControlDispatchLease" to value.activeControlDispatchLease?.let {
                mapOf("fence" to encodeEffectFence(it.fence))
            },
            "ambiguousInputs" to value.ambiguousInputs.map(::encodeAmbiguousInput),
            "pendingClose" to value.pendingClose?.let(::encodePendingClose),
            "closed" to value.closed?.let(::encodeClosed),
            "resetReason" to value.resetReason?.name,
        )

    private fun decodeCheckpoint(value: Map<String, Any?>): RelayV2TerminalCheckpoint {
        RelayV2StorageJson.requireKeys(
            value,
            "schemaVersion",
            "identity",
            "openAttempt",
            "openMode",
            "openRequestResume",
            "openResult",
            "openRequestIds",
            "deliveryToken",
            "parserContinuityId",
            "phase",
            "openedCols",
            "openedRows",
            "parserAppliedNextOffset",
            "networkReceivedThrough",
            "nextParserOperationSeq",
            "nextReplayRequestSeq",
            "replayRequestIds",
            "closeRequestIds",
            "parserResetCallbackToken",
            "parserInFlightCallbackToken",
            "lastAppliedParserCallbackToken",
            "pendingOutput",
            "pendingOpen",
            "pendingReplay",
            "replayTargetOffset",
            "nextInputSeq",
            "ackedThroughInputSeq",
            "pendingInputs",
            "nextResizeSeq",
            "ackedThroughResizeSeq",
            "pendingResizes",
            "activeControlDispatchLease",
            "ambiguousInputs",
            "pendingClose",
            "closed",
            "resetReason",
        )
        val lease = RelayV2StorageJson.nullableObject(value, "activeControlDispatchLease")
            ?.let { encoded ->
                RelayV2StorageJson.requireKeys(encoded, "fence")
                RelayV2TerminalControlDispatchLease(
                    decodeEffectFence(RelayV2StorageJson.objectValue(encoded, "fence")),
                )
            }
        return RelayV2TerminalCheckpoint(
            schemaVersion = RelayV2StorageJson.int(value, "schemaVersion"),
            identity = decodeIdentity(RelayV2StorageJson.objectValue(value, "identity")),
            openAttempt = decodeOpenAttempt(
                RelayV2StorageJson.objectValue(value, "openAttempt"),
            ),
            openMode = RelayV2StorageJson.enum(value, "openMode"),
            openRequestResume = RelayV2StorageJson.nullableObject(value, "openRequestResume")
                ?.let(::decodeOpenResume),
            openResult = decodeOpenResult(RelayV2StorageJson.objectValue(value, "openResult")),
            openRequestIds = RelayV2StorageJson.stringList(
                value,
                "openRequestIds",
                RelayV2TerminalCheckpointLimits.MAX_NETWORK_REQUEST_IDS,
            ),
            deliveryToken = decodeDelivery(
                RelayV2StorageJson.objectValue(value, "deliveryToken"),
            ),
            parserContinuityId = RelayV2StorageJson.string(value, "parserContinuityId"),
            phase = RelayV2StorageJson.enum(value, "phase"),
            openedCols = RelayV2StorageJson.int(value, "openedCols"),
            openedRows = RelayV2StorageJson.int(value, "openedRows"),
            parserAppliedNextOffset = RelayV2StorageJson.string(
                value,
                "parserAppliedNextOffset",
            ),
            networkReceivedThrough = RelayV2StorageJson.string(
                value,
                "networkReceivedThrough",
            ),
            nextParserOperationSeq = RelayV2StorageJson.string(
                value,
                "nextParserOperationSeq",
            ),
            nextReplayRequestSeq = RelayV2StorageJson.string(value, "nextReplayRequestSeq"),
            replayRequestIds = RelayV2StorageJson.stringList(
                value,
                "replayRequestIds",
                RelayV2TerminalCheckpointLimits.MAX_NETWORK_REQUEST_IDS,
            ),
            closeRequestIds = RelayV2StorageJson.stringList(
                value,
                "closeRequestIds",
                RelayV2TerminalCheckpointLimits.MAX_NETWORK_REQUEST_IDS,
            ),
            parserResetCallbackToken = RelayV2StorageJson.nullableObject(
                value,
                "parserResetCallbackToken",
            )?.let(::decodeParserToken),
            parserInFlightCallbackToken = RelayV2StorageJson.nullableObject(
                value,
                "parserInFlightCallbackToken",
            )?.let(::decodeParserToken),
            lastAppliedParserCallbackToken = RelayV2StorageJson.nullableObject(
                value,
                "lastAppliedParserCallbackToken",
            )?.let(::decodeParserToken),
            pendingOutput = RelayV2StorageJson.list(
                value,
                "pendingOutput",
                RelayV2TerminalCheckpointLimits.MAX_PENDING_OUTPUT_FRAMES,
            ).map { decodeParserWrite(RelayV2StorageJson.objectValue(it)) },
            pendingOpen = RelayV2StorageJson.nullableObject(value, "pendingOpen")
                ?.let(::decodePendingOpen),
            pendingReplay = RelayV2StorageJson.nullableObject(value, "pendingReplay")
                ?.let(::decodePendingReplay),
            replayTargetOffset = RelayV2StorageJson.nullableString(value, "replayTargetOffset"),
            nextInputSeq = RelayV2StorageJson.string(value, "nextInputSeq"),
            ackedThroughInputSeq = RelayV2StorageJson.string(value, "ackedThroughInputSeq"),
            pendingInputs = RelayV2StorageJson.list(
                value,
                "pendingInputs",
                RelayV2TerminalCheckpointLimits.MAX_INPUT_RECORDS,
            ).map { decodePendingInput(RelayV2StorageJson.objectValue(it)) },
            nextResizeSeq = RelayV2StorageJson.string(value, "nextResizeSeq"),
            ackedThroughResizeSeq = RelayV2StorageJson.string(value, "ackedThroughResizeSeq"),
            pendingResizes = RelayV2StorageJson.list(
                value,
                "pendingResizes",
                RelayV2TerminalCheckpointLimits.MAX_RESIZE_RECORDS,
            ).map { decodePendingResize(RelayV2StorageJson.objectValue(it)) },
            activeControlDispatchLease = lease,
            ambiguousInputs = RelayV2StorageJson.list(
                value,
                "ambiguousInputs",
                RelayV2TerminalCheckpointLimits.MAX_INPUT_RECORDS,
            ).map { decodeAmbiguousInput(RelayV2StorageJson.objectValue(it)) },
            pendingClose = RelayV2StorageJson.nullableObject(value, "pendingClose")
                ?.let(::decodePendingClose),
            closed = RelayV2StorageJson.nullableObject(value, "closed")?.let(::decodeClosed),
            resetReason = RelayV2StorageJson.nullableEnum<RelayV2TerminalResetReason>(
                value,
                "resetReason",
            ),
        )
    }

    private fun decodeBytes(value: String): RelayV2TerminalBytes {
        val bytes = try {
            Base64.getDecoder().decode(value)
        } catch (_: IllegalArgumentException) {
            throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
        }
        if (bytes.size > RelayV2TerminalCheckpointLimits.MAX_FRAME_BYTES) {
            throw RelayV2StorageException(RelayV2StorageFailure.LIMIT_EXCEEDED)
        }
        return RelayV2TerminalBytes.of(bytes)
    }

    private fun requireKey(
        key: RelayV2TerminalCheckpointKey,
        target: RelayV2TerminalOpenTarget,
    ) {
        if (key != RelayV2TerminalCheckpointKey.from(target)) {
            throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
        }
    }

    private fun RelayV2StorageException.toRestoreInvalidity(): RelayV2TerminalRestoreInvalidity =
        when (failure) {
            RelayV2StorageFailure.SCHEMA_INCOMPATIBLE ->
                RelayV2TerminalRestoreInvalidity.SCHEMA_INCOMPATIBLE
            RelayV2StorageFailure.MISSING_REQUIRED_FIELD ->
                RelayV2TerminalRestoreInvalidity.MISSING_REQUIRED_FIELD
            RelayV2StorageFailure.MALFORMED -> RelayV2TerminalRestoreInvalidity.CORRUPT_QUEUE
            RelayV2StorageFailure.LIMIT_EXCEEDED ->
                RelayV2TerminalRestoreInvalidity.LIMIT_EXCEEDED
        }
}
