package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2WebSocketChannel
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2CanonicalRequestArguments
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAttemptKind
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxCommand
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEffect
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxLimits
import com.tmuxworktree.mobile.core.relay.v2.outbox.canonicalRelayV2FingerprintRequest
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxRecoveryAuthority
import java.security.MessageDigest
import java.util.Collections
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/** Shared lock-free gate used by both post-commit seals and issued capabilities. */
private class RelayV2OutboxOneShotGate {
    private val claimed = AtomicBoolean(false)

    fun tryClaim(): Boolean = claimed.compareAndSet(false, true)
}

/**
 * Fakeable strict-codec adapter. It receives an immutable frame only for the synchronous encode
 * call, must not retain or log it, and its output must exactly match independently computed
 * canonical bytes before a strict round-trip check.
 */
internal fun interface RelayV2OutboxDispatchFrameEncoder {
    fun encode(frame: Map<String, Any?>): ByteArray
}

private val STRICT_FRAME_ENCODER = RelayV2OutboxDispatchFrameEncoder { frame ->
    RelayV2Codec().encodeWebSocketFrame(RelayV2WebSocketChannel.PUBLIC, frame)
}

/** Exact, non-sensitive correlation returned by the outbound seam. */
internal data class RelayV2OutboxDispatchIdentity(
    val generation: RelayV2EffectGeneration,
    val requestId: String,
    val commandId: String,
)

/** Why a durable recovery effect could not be sealed into dispatch authority. */
internal enum class RelayV2OutboxDispatchIssueFailure {
    COMMIT_AUTHORITY_MISMATCH,
    COMMIT_EFFECT_MISMATCH,
    COMMIT_CHANGED,
    PROVENANCE_ALREADY_ISSUED,
    ENCODING_REJECTED,
    ISSUER_FAILED,
}

/** Optional post-commit output; Disabled preserves the direct recovery adapter behavior. */
internal sealed interface RelayV2OutboxDispatchIssuance {
    data object Disabled : RelayV2OutboxDispatchIssuance

    /** The durable commit contained no Execute effect owned by this seam. */
    data object NoDispatch : RelayV2OutboxDispatchIssuance

    data class Issued(
        val capabilities: List<RelayV2OutboxDispatchCapability>,
    ) : RelayV2OutboxDispatchIssuance {
        init {
            require(capabilities.isNotEmpty())
        }
    }

    data class Rejected(
        val reason: RelayV2OutboxDispatchIssueFailure,
    ) : RelayV2OutboxDispatchIssuance
}

/**
 * Opaque one-time authority. It exposes correlation only: no effect, frame, payload, fingerprint,
 * claim method, byte accessor, constructor, or copy operation.
 */
internal sealed interface RelayV2OutboxDispatchCapability {
    val identity: RelayV2OutboxDispatchIdentity
}

private class RelayV2IssuedOutboxDispatchCapability(
    override val identity: RelayV2OutboxDispatchIdentity,
    private val issuerKey: Any,
    val authority: RelayV2RepositoryEffectAuthority,
    val canonicalWireBytes: ByteArray,
    val wireSha256: ByteArray,
    val provenanceCanonicalBytes: ByteArray,
    val provenanceSha256: ByteArray,
) : RelayV2OutboxDispatchCapability {
    val consumed = RelayV2OutboxOneShotGate()

    fun isIssuedBy(candidate: Any): Boolean = issuerKey === candidate

    override fun toString(): String =
        "RelayV2OutboxDispatchCapability(identity=$identity, <redacted>)"
}

/**
 * Closed composition surface. The paired consume authority and dispatcher implementation never
 * leave its private implementation.
 */
internal interface RelayV2OutboxDispatchRecoveryComposition {
    val recoveryAdapter: RelayV2OutboxRecoveryAdapter

    fun dispatcher(
        sendPort: RelayV2OutboxExactGenerationSendPort,
    ): RelayV2OutboxDispatcher
}

internal fun interface RelayV2OutboxDispatcher {
    fun dispatch(
        capability: RelayV2OutboxDispatchCapability,
    ): RelayV2OutboxDispatchOutcome
}

internal object RelayV2OutboxDispatchAuthority {
    fun recoveryComposition(
        applyLease: RelayV2RepositoryEffectApplyLeasePort,
        outbox: RelayV2OutboxRecoveryAuthority,
        newId: () -> String = { UUID.randomUUID().toString() },
        clock: () -> Long = System::currentTimeMillis,
        frameEncoder: RelayV2OutboxDispatchFrameEncoder = STRICT_FRAME_ENCODER,
    ): RelayV2OutboxDispatchRecoveryComposition =
        RelayV2OutboxDispatchIssuePort.recoveryComposition(
            applyLease,
            outbox,
            newId,
            clock,
            frameEncoder,
        )
}

/**
 * Closed half of the split authority. Its private constructor is used only by the paired factory;
 * the resulting instance is passed only into the recovery adapter's private field.
 */
internal class RelayV2OutboxDispatchIssuePort private constructor(
    private val issuerKey: Any,
    private val frameEncoder: RelayV2OutboxDispatchFrameEncoder,
) {
    /**
     * Called synchronously under the actor apply lease after the durable transaction returned
     * Applied. All caller-owned commit/effect containers are bounded, validated, encoded, and
     * detached here; no alias is retained by the returned seal.
     */
    fun sealCommitted(
        authority: RelayV2RepositoryEffectAuthority,
        commit: RelayV2OutboxRecoveryCommit,
    ): RelayV2OutboxDispatchCommittedSeal = try {
        val snapshots = commit.dispatchSnapshots(authority, frameEncoder)
        if (snapshots.isEmpty()) {
            RelayV2NoDispatchCommittedSeal(issuerKey)
        } else {
            RelayV2ReadyOutboxDispatchCommittedSeal(
                issuerKey,
                Collections.unmodifiableList(snapshots),
            )
        }
    } catch (failure: RelayV2OutboxDispatchIssueException) {
        RelayV2RejectedOutboxDispatchCommittedSeal(issuerKey, failure.reason)
    } catch (_: Exception) {
        RelayV2RejectedOutboxDispatchCommittedSeal(
            issuerKey,
            RelayV2OutboxDispatchIssueFailure.ENCODING_REJECTED,
        )
    }

    /** After sealing, issuance performs only pair verification, one CAS, and capability minting. */
    fun issue(
        seal: RelayV2OutboxDispatchCommittedSeal,
    ): RelayV2OutboxDispatchIssuance {
        val committed = seal as? RelayV2BoundOutboxDispatchCommittedSeal
            ?: return RelayV2OutboxDispatchIssuance.Rejected(
                RelayV2OutboxDispatchIssueFailure.COMMIT_AUTHORITY_MISMATCH,
            )
        return committed.issue(issuerKey)
    }

    internal companion object {
        fun recoveryComposition(
            applyLease: RelayV2RepositoryEffectApplyLeasePort,
            outbox: RelayV2OutboxRecoveryAuthority,
            newId: () -> String,
            clock: () -> Long,
            frameEncoder: RelayV2OutboxDispatchFrameEncoder,
        ): RelayV2OutboxDispatchRecoveryComposition {
            val issuerKey = Any()
            val issuePort = RelayV2OutboxDispatchIssuePort(issuerKey, frameEncoder)
            val consumePort = RelayV2OutboxDispatchConsumePort(issuerKey)
            return RelayV2OutboxDispatchRecoveryCompositionImpl(
                recoveryAdapter = RelayV2OutboxRecoveryAdapter.withDispatchIssuer(
                    applyLease = applyLease,
                    outbox = outbox,
                    newId = newId,
                    clock = clock,
                    dispatchIssuer = issuePort,
                ),
                consumePort = consumePort,
            )
        }
    }
}

/** Opaque private-lease value; it has no fields, constructor, factory, or copy operation. */
internal sealed interface RelayV2OutboxDispatchCommittedSeal

private abstract class RelayV2BoundOutboxDispatchCommittedSeal(
    private val issuerKey: Any,
) : RelayV2OutboxDispatchCommittedSeal {
    private val issued = RelayV2OutboxOneShotGate()

    fun issue(candidate: Any): RelayV2OutboxDispatchIssuance {
        if (issuerKey !== candidate) return authorityMismatch()
        if (!issued.tryClaim()) {
            return RelayV2OutboxDispatchIssuance.Rejected(
                RelayV2OutboxDispatchIssueFailure.PROVENANCE_ALREADY_ISSUED,
            )
        }
        return issueOnce(candidate)
    }

    protected abstract fun issueOnce(candidate: Any): RelayV2OutboxDispatchIssuance
}

private class RelayV2ReadyOutboxDispatchCommittedSeal(
    issuerKey: Any,
    private val snapshots: List<RelayV2OutboxDispatchSnapshot>,
) : RelayV2BoundOutboxDispatchCommittedSeal(issuerKey) {
    override fun issueOnce(candidate: Any): RelayV2OutboxDispatchIssuance {
        val capabilities = snapshots.mapTo(ArrayList(snapshots.size)) { snapshot ->
            RelayV2IssuedOutboxDispatchCapability(
                identity = snapshot.identity,
                issuerKey = candidate,
                authority = snapshot.authority,
                canonicalWireBytes = snapshot.canonicalWireBytes.copyOf(),
                wireSha256 = snapshot.wireSha256.copyOf(),
                provenanceCanonicalBytes = snapshot.provenanceCanonicalBytes.copyOf(),
                provenanceSha256 = snapshot.provenanceSha256.copyOf(),
            )
        }
        return RelayV2OutboxDispatchIssuance.Issued(
            Collections.unmodifiableList(capabilities),
        )
    }
}

private class RelayV2NoDispatchCommittedSeal(
    issuerKey: Any,
) : RelayV2BoundOutboxDispatchCommittedSeal(issuerKey) {
    override fun issueOnce(candidate: Any): RelayV2OutboxDispatchIssuance =
        RelayV2OutboxDispatchIssuance.NoDispatch
}

private class RelayV2RejectedOutboxDispatchCommittedSeal(
    issuerKey: Any,
    private val reason: RelayV2OutboxDispatchIssueFailure,
) : RelayV2BoundOutboxDispatchCommittedSeal(issuerKey) {
    override fun issueOnce(candidate: Any): RelayV2OutboxDispatchIssuance =
        RelayV2OutboxDispatchIssuance.Rejected(reason)
}

private fun authorityMismatch() = RelayV2OutboxDispatchIssuance.Rejected(
    RelayV2OutboxDispatchIssueFailure.COMMIT_AUTHORITY_MISMATCH,
)

private class RelayV2OutboxDispatchRecoveryCompositionImpl(
    override val recoveryAdapter: RelayV2OutboxRecoveryAdapter,
    private val consumePort: RelayV2OutboxDispatchConsumePort,
) : RelayV2OutboxDispatchRecoveryComposition {
    override fun dispatcher(
        sendPort: RelayV2OutboxExactGenerationSendPort,
    ): RelayV2OutboxDispatcher = RelayV2OutboxDispatchAdapter(consumePort, sendPort)
}

private fun interface RelayV2OutboxConsumedDelivery {
    fun deliver(
        authority: RelayV2RepositoryEffectAuthority,
        canonicalWireBytes: ByteArray,
    ): RelayV2OutboxDeliveryResult
}

private sealed interface RelayV2OutboxDeliveryResult {
    data class Returned(
        val result: RelayV2OutboxExactGenerationSendResult,
    ) : RelayV2OutboxDeliveryResult

    data object Threw : RelayV2OutboxDeliveryResult
}

private sealed interface RelayV2OutboxCapabilityConsumeResult {
    val identity: RelayV2OutboxDispatchIdentity

    data class Consumed(
        override val identity: RelayV2OutboxDispatchIdentity,
        val delivery: RelayV2OutboxDeliveryResult,
    ) : RelayV2OutboxCapabilityConsumeResult

    data class AlreadyConsumed(
        override val identity: RelayV2OutboxDispatchIdentity,
    ) : RelayV2OutboxCapabilityConsumeResult

    data class NotIssued(
        override val identity: RelayV2OutboxDispatchIdentity,
    ) : RelayV2OutboxCapabilityConsumeResult

    data class IntegrityRejected(
        override val identity: RelayV2OutboxDispatchIdentity,
    ) : RelayV2OutboxCapabilityConsumeResult
}

private class RelayV2OutboxDispatchConsumePort(
    private val issuerKey: Any,
) {
    fun consume(
        capability: RelayV2OutboxDispatchCapability,
        delivery: RelayV2OutboxConsumedDelivery,
    ): RelayV2OutboxCapabilityConsumeResult {
        val issued = capability as? RelayV2IssuedOutboxDispatchCapability
            ?: return RelayV2OutboxCapabilityConsumeResult.NotIssued(capability.identity)
        if (!issued.isIssuedBy(issuerKey)) {
            return RelayV2OutboxCapabilityConsumeResult.NotIssued(issued.identity)
        }
        if (!issued.consumed.tryClaim()) {
            return RelayV2OutboxCapabilityConsumeResult.AlreadyConsumed(issued.identity)
        }
        val wireDigest = sha256(issued.canonicalWireBytes)
        val provenanceDigest = sha256(issued.provenanceCanonicalBytes)
        if (!MessageDigest.isEqual(wireDigest, issued.wireSha256) ||
            !MessageDigest.isEqual(provenanceDigest, issued.provenanceSha256)
        ) {
            return RelayV2OutboxCapabilityConsumeResult.IntegrityRejected(issued.identity)
        }
        return RelayV2OutboxCapabilityConsumeResult.Consumed(
            issued.identity,
            delivery.deliver(
                issued.authority,
                issued.canonicalWireBytes.copyOf(),
            ),
        )
    }
}

/** Result of the actor-owned atomic generation check plus one transport send attempt. */
internal sealed interface RelayV2OutboxExactGenerationSendResult {
    data object Sent : RelayV2OutboxExactGenerationSendResult
    data object NotSent : RelayV2OutboxExactGenerationSendResult
    data object Stale : RelayV2OutboxExactGenerationSendResult
}

/**
 * Port implemented by the serialized actor owner in a future composition. It compares the full
 * authority and returns Stale before transport. The byte array is a defensive copy for the one
 * synchronous send call; the implementation must neither retain nor log it.
 */
internal fun interface RelayV2OutboxExactGenerationSendPort {
    fun sendIfCurrent(
        authority: RelayV2RepositoryEffectAuthority,
        canonicalWireBytes: ByteArray,
    ): RelayV2OutboxExactGenerationSendResult
}

internal enum class RelayV2OutboxDispatchUncertainty {
    SEND_RETURNED_FALSE,
    SEND_THROWN,
}

internal sealed interface RelayV2OutboxDispatchOutcome {
    val identity: RelayV2OutboxDispatchIdentity

    data class Submitted(
        override val identity: RelayV2OutboxDispatchIdentity,
    ) : RelayV2OutboxDispatchOutcome

    /** Stale consumes the capability; a successor must have a new durable effect. */
    data class Stale(
        override val identity: RelayV2OutboxDispatchIdentity,
    ) : RelayV2OutboxDispatchOutcome

    data class AlreadyDispatched(
        override val identity: RelayV2OutboxDispatchIdentity,
    ) : RelayV2OutboxDispatchOutcome

    data class CapabilityRejected(
        override val identity: RelayV2OutboxDispatchIdentity,
    ) : RelayV2OutboxDispatchOutcome

    data class ConfirmingRequired(
        override val identity: RelayV2OutboxDispatchIdentity,
        val uncertainty: RelayV2OutboxDispatchUncertainty,
    ) : RelayV2OutboxDispatchOutcome
}

/** Constructor is private; only the closed composition can bind it to the paired consume port. */
private class RelayV2OutboxDispatchAdapter(
    private val consumePort: RelayV2OutboxDispatchConsumePort,
    private val sendPort: RelayV2OutboxExactGenerationSendPort,
) : RelayV2OutboxDispatcher {
    override fun dispatch(
        capability: RelayV2OutboxDispatchCapability,
    ): RelayV2OutboxDispatchOutcome {
        val consumed = consumePort.consume(
            capability,
            RelayV2OutboxConsumedDelivery { authority, canonicalWireBytes ->
                try {
                    RelayV2OutboxDeliveryResult.Returned(
                        sendPort.sendIfCurrent(authority, canonicalWireBytes),
                    )
                } catch (_: Exception) {
                    RelayV2OutboxDeliveryResult.Threw
                }
            },
        )
        return when (consumed) {
            is RelayV2OutboxCapabilityConsumeResult.AlreadyConsumed ->
                RelayV2OutboxDispatchOutcome.AlreadyDispatched(consumed.identity)
            is RelayV2OutboxCapabilityConsumeResult.NotIssued,
            is RelayV2OutboxCapabilityConsumeResult.IntegrityRejected,
            -> RelayV2OutboxDispatchOutcome.CapabilityRejected(consumed.identity)
            is RelayV2OutboxCapabilityConsumeResult.Consumed -> consumed.toDispatchOutcome()
        }
    }
}

private data class RelayV2OutboxDispatchSnapshot(
    val authority: RelayV2RepositoryEffectAuthority,
    val identity: RelayV2OutboxDispatchIdentity,
    val canonicalWireBytes: ByteArray,
    val wireSha256: ByteArray,
    val provenanceCanonicalBytes: ByteArray,
    val provenanceSha256: ByteArray,
)

private sealed interface RelayV2OutboxCommitReceiptSnapshot {
    val generation: RelayV2EffectGeneration
    val hostId: String
    val hostEpoch: String
    val orderedCommands: List<RelayV2PendingCommand>

    fun canonicalValue(): Map<String, Any?>

    data class CommandStatuses(
        val binding: RelayV2RecoveryBinding,
        override val hostId: String,
        override val hostEpoch: String,
        override val orderedCommands: List<RelayV2PendingCommand>,
    ) : RelayV2OutboxCommitReceiptSnapshot {
        override val generation: RelayV2EffectGeneration = binding.generation

        override fun canonicalValue(): Map<String, Any?> = linkedMapOf(
            "kind" to "command_statuses",
            "generation" to generation.canonicalValue(),
            "step" to binding.step,
            "requestId" to binding.requestId,
            "hostId" to hostId,
            "hostEpoch" to hostEpoch,
            "commands" to orderedCommands.map { it.canonicalValue() },
        )
    }

    data class CommandEvidence(
        val receipt: RelayV2OutboxEvidenceApplied,
        override val orderedCommands: List<RelayV2PendingCommand>,
    ) : RelayV2OutboxCommitReceiptSnapshot {
        override val generation: RelayV2EffectGeneration = receipt.generation
        override val hostId: String = receipt.entryId.hostId
        override val hostEpoch: String = receipt.entryId.expectedHostEpoch

        override fun canonicalValue(): Map<String, Any?> = linkedMapOf(
            "kind" to "command_evidence",
            "generation" to generation.canonicalValue(),
            "entry" to receipt.entryId.canonicalValue(),
            "dedupeWindowId" to receipt.dedupeWindowId,
            "scopeId" to receipt.scopeId,
            "sessionId" to receipt.sessionId,
            "operation" to receipt.operation.wireValue,
            "source" to receipt.source.name,
            "state" to receipt.state.name,
            "attemptRequestId" to receipt.attemptRequestId,
        )
    }
}

private class RelayV2OutboxDispatchIssueException(
    val reason: RelayV2OutboxDispatchIssueFailure,
) : IllegalArgumentException(reason.name)

private fun RelayV2OutboxRecoveryCommit.dispatchSnapshots(
    authority: RelayV2RepositoryEffectAuthority,
    frameEncoder: RelayV2OutboxDispatchFrameEncoder,
): ArrayList<RelayV2OutboxDispatchSnapshot> {
    val receipt = receiptSnapshot()
    receipt.requireAuthority(authority)
    val effectsSnapshot = effects
    val effectCount = effectsSnapshot.size
    if (effectCount > RelayV2OutboxLimits.MAX_QUERY_ITEMS_PER_BATCH) {
        issueFailure(RelayV2OutboxDispatchIssueFailure.COMMIT_EFFECT_MISMATCH)
    }
    val snapshots = ArrayList<RelayV2OutboxDispatchSnapshot>(effectCount)
    repeat(effectCount) { index ->
        val exactEffect = effectsSnapshot[index]
        exactEffect.dispatchSnapshot(authority, receipt, index, frameEncoder)?.let(snapshots::add)
        if (effectsSnapshot.size != effectCount || effectsSnapshot[index] !== exactEffect) {
            issueFailure(RelayV2OutboxDispatchIssueFailure.COMMIT_CHANGED)
        }
    }
    if (snapshots.map { it.identity.requestId }.distinct().size != snapshots.size ||
        snapshots.map { it.identity.commandId }.distinct().size != snapshots.size
    ) issueFailure(RelayV2OutboxDispatchIssueFailure.COMMIT_EFFECT_MISMATCH)
    return snapshots
}

private fun RelayV2OutboxRecoveryCommit.receiptSnapshot():
    RelayV2OutboxCommitReceiptSnapshot = when (this) {
    is RelayV2OutboxRecoveryCommit.CommandStatuses -> {
        val commands = receipt.appliedCommands.privateSnapshot()
        RelayV2OutboxCommitReceiptSnapshot.CommandStatuses(
            binding = receipt.binding,
            hostId = receipt.hostId,
            hostEpoch = receipt.hostEpoch,
            orderedCommands = commands,
        )
    }
    is RelayV2OutboxRecoveryCommit.CommandEvidence ->
        RelayV2OutboxCommitReceiptSnapshot.CommandEvidence(
            receipt = receipt.copy(),
            orderedCommands = listOf(
                RelayV2PendingCommand(receipt.entryId.commandId, receipt.dedupeWindowId),
            ),
        )
}

private fun RelayV2OutboxCommitReceiptSnapshot.requireAuthority(
    authority: RelayV2RepositoryEffectAuthority,
) {
    if (generation != authority.generation || hostId != authority.hostId ||
        hostEpoch != authority.hostEpoch
    ) issueFailure(RelayV2OutboxDispatchIssueFailure.COMMIT_AUTHORITY_MISMATCH)
    if (this is RelayV2OutboxCommitReceiptSnapshot.CommandEvidence &&
        (receipt.entryId.profileId != authority.profileId ||
            receipt.entryId.principalId != authority.principalId)
    ) issueFailure(RelayV2OutboxDispatchIssueFailure.COMMIT_AUTHORITY_MISMATCH)
}

private fun RelayV2OutboxEffect.dispatchSnapshot(
    authority: RelayV2RepositoryEffectAuthority,
    receipt: RelayV2OutboxCommitReceiptSnapshot,
    effectIndex: Int,
    frameEncoder: RelayV2OutboxDispatchFrameEncoder,
): RelayV2OutboxDispatchSnapshot? = when (this) {
    is RelayV2OutboxEffect.ExecuteCommand ->
        executeSnapshot(authority, receipt, effectIndex, frameEncoder)
    is RelayV2OutboxEffect.QueryCommands,
    is RelayV2OutboxEffect.ConfirmOldLineage,
    is RelayV2OutboxEffect.ReissueCreated,
    is RelayV2OutboxEffect.RevalidateOpaqueTarget,
    -> null
}

private fun RelayV2OutboxEffect.ExecuteCommand.executeSnapshot(
    authority: RelayV2RepositoryEffectAuthority,
    receipt: RelayV2OutboxCommitReceiptSnapshot,
    effectIndex: Int,
    frameEncoder: RelayV2OutboxDispatchFrameEncoder,
): RelayV2OutboxDispatchSnapshot {
    if (attempt.kind != RelayV2OutboxAttemptKind.EXECUTE ||
        retryAfterMs != null && retryAfterMs !in 0..MAX_RELAY_V2_JSON_INTEGER
    ) issueFailure(RelayV2OutboxDispatchIssueFailure.COMMIT_EFFECT_MISMATCH)
    command.requireAuthority(authority)
    command.requireCanonicalBinding()
    val committedPair = RelayV2PendingCommand(
        command.entryId.commandId,
        command.dedupeWindowId,
    )
    if (receipt.orderedCommands.count { it == committedPair } != 1) {
        issueFailure(RelayV2OutboxDispatchIssueFailure.COMMIT_EFFECT_MISMATCH)
    }
    if (receipt is RelayV2OutboxCommitReceiptSnapshot.CommandEvidence &&
        (receipt.receipt.entryId != command.entryId ||
            receipt.receipt.scopeId != command.scopeId ||
            receipt.receipt.sessionId != command.sessionId ||
            receipt.receipt.operation != command.operation)
    ) issueFailure(RelayV2OutboxDispatchIssueFailure.COMMIT_EFFECT_MISMATCH)

    val arguments = command.canonicalRequestArguments.privateSnapshot()
    val frame = linkedMapOf<String, Any?>(
        "protocolVersion" to 2L,
        "kind" to "request",
        "type" to "command.execute",
        "requestId" to attempt.requestId,
        "commandId" to command.entryId.commandId,
        "hostId" to command.entryId.hostId,
        "expectedHostEpoch" to command.entryId.expectedHostEpoch,
        "scopeId" to command.scopeId,
    )
    command.sessionId?.let { frame["sessionId"] = it }
    frame["payload"] = linkedMapOf(
        "dedupeWindowId" to command.dedupeWindowId,
        "operation" to command.operation.wireValue,
        "arguments" to arguments,
    )
    val wire = encode(frame, frameEncoder)
    val provenance = linkedMapOf<String, Any?>(
        "authority" to authority.canonicalValue(),
        "receipt" to receipt.canonicalValue(),
        "effectIndex" to effectIndex,
        "effect" to linkedMapOf(
            "kind" to "execute",
            "requestId" to attempt.requestId,
            "attemptKind" to attempt.kind.name,
            "attemptOrdinal" to attempt.ordinal,
            "retryAfterMs" to retryAfterMs,
            "entry" to command.entryId.canonicalValue(),
            "dedupeWindowId" to command.dedupeWindowId,
            "operation" to command.operation.wireValue,
            "scopeId" to command.scopeId,
            "sessionId" to command.sessionId,
            "arguments" to arguments,
            "requestFingerprint" to linkedMapOf(
                "schemaVersion" to command.requestFingerprint.schemaVersion,
                "sha256Hex" to command.requestFingerprint.sha256Hex,
                "canonicalRequestByteCount" to
                    command.requestFingerprint.canonicalRequestByteCount,
            ),
        ),
    )
    return wire.snapshot(
        authority,
        RelayV2OutboxDispatchIdentity(
            authority.generation,
            attempt.requestId,
            command.entryId.commandId,
        ),
        provenance,
    )
}

private fun RelayV2OutboxCommand.requireAuthority(
    authority: RelayV2RepositoryEffectAuthority,
) {
    if (entryId.profileId != authority.profileId ||
        entryId.principalId != authority.principalId ||
        entryId.hostId != authority.hostId ||
        entryId.expectedHostEpoch != authority.hostEpoch
    ) issueFailure(RelayV2OutboxDispatchIssueFailure.COMMIT_AUTHORITY_MISMATCH)
}

private fun RelayV2OutboxCommand.requireCanonicalBinding() {
    val exactArguments = try {
        RelayV2CanonicalRequestArguments.from(canonicalRequestArguments.value)
    } catch (_: Exception) {
        issueFailure(RelayV2OutboxDispatchIssueFailure.COMMIT_EFFECT_MISMATCH)
    }
    if (canonicalRequestArguments.value.operation != operation ||
        exactArguments != canonicalRequestArguments
    ) issueFailure(RelayV2OutboxDispatchIssueFailure.COMMIT_EFFECT_MISMATCH)
    val fingerprintBytes = canonicalRelayV2FingerprintRequest(
        requestFingerprint.schemaVersion,
        operation,
        dedupeWindowId,
        entryId.expectedHostEpoch,
        entryId.hostId,
        scopeId,
        sessionId,
        exactArguments,
    ).toByteArray(Charsets.UTF_8)
    val fingerprintSha256 = sha256(fingerprintBytes).joinToString(separator = "") { byte ->
        (byte.toInt() and 0xff).toString(16).padStart(2, '0')
    }
    if (requestFingerprint.canonicalRequestByteCount != fingerprintBytes.size ||
        requestFingerprint.sha256Hex != fingerprintSha256
    ) issueFailure(RelayV2OutboxDispatchIssueFailure.COMMIT_EFFECT_MISMATCH)
}

private fun List<RelayV2PendingCommand>.privateSnapshot(): List<RelayV2PendingCommand> {
    val count = size
    if (count !in 1..RelayV2OutboxLimits.MAX_QUERY_ITEMS_PER_BATCH) {
        issueFailure(RelayV2OutboxDispatchIssueFailure.COMMIT_EFFECT_MISMATCH)
    }
    val copied = ArrayList<RelayV2PendingCommand>(count)
    repeat(count) { index ->
        val pending = get(index)
        copied += RelayV2PendingCommand(pending.commandId, pending.dedupeWindowId)
    }
    if (size != count || copied.indices.any { get(it) != copied[it] } ||
        copied.distinctBy { it.commandId }.size != copied.size
    ) issueFailure(RelayV2OutboxDispatchIssueFailure.COMMIT_CHANGED)
    return Collections.unmodifiableList(copied)
}

private fun RelayV2CanonicalRequestArguments.privateSnapshot(): Map<String, Any?> {
    val wire = canonicalJson
    if (wire.toByteArray(Charsets.UTF_8).size != utf8ByteCount) {
        issueFailure(RelayV2OutboxDispatchIssueFailure.COMMIT_EFFECT_MISMATCH)
    }
    val snapshot = RelayV2StrictJson.parseObject(wire, ARGUMENT_SNAPSHOT_LIMITS)
    if (RelayV2StrictJson.stringify(snapshot) != wire) {
        issueFailure(RelayV2OutboxDispatchIssueFailure.COMMIT_EFFECT_MISMATCH)
    }
    return snapshot
}

private fun RelayV2OutboxCapabilityConsumeResult.Consumed.toDispatchOutcome():
    RelayV2OutboxDispatchOutcome = when (val delivered = delivery) {
    is RelayV2OutboxDeliveryResult.Returned -> when (delivered.result) {
        RelayV2OutboxExactGenerationSendResult.Sent ->
            RelayV2OutboxDispatchOutcome.Submitted(identity)
        RelayV2OutboxExactGenerationSendResult.Stale ->
            RelayV2OutboxDispatchOutcome.Stale(identity)
        RelayV2OutboxExactGenerationSendResult.NotSent ->
            RelayV2OutboxDispatchOutcome.ConfirmingRequired(
                identity,
                RelayV2OutboxDispatchUncertainty.SEND_RETURNED_FALSE,
            )
    }
    RelayV2OutboxDeliveryResult.Threw ->
        RelayV2OutboxDispatchOutcome.ConfirmingRequired(
            identity,
            RelayV2OutboxDispatchUncertainty.SEND_THROWN,
        )
}

private fun ByteArray.snapshot(
    authority: RelayV2RepositoryEffectAuthority,
    identity: RelayV2OutboxDispatchIdentity,
    provenance: Map<String, Any?>,
): RelayV2OutboxDispatchSnapshot {
    val provenanceCanonicalBytes =
        RelayV2StrictJson.stringify(provenance).toByteArray(Charsets.UTF_8)
    return RelayV2OutboxDispatchSnapshot(
        authority = authority,
        identity = identity,
        canonicalWireBytes = copyOf(),
        wireSha256 = sha256(this),
        provenanceCanonicalBytes = provenanceCanonicalBytes,
        provenanceSha256 = sha256(provenanceCanonicalBytes),
    )
}

private fun encode(
    frame: Map<String, Any?>,
    frameEncoder: RelayV2OutboxDispatchFrameEncoder,
): ByteArray {
    val frozenFrame = frame.immutableJsonObject()
    val expectedWire = RelayV2StrictJson.stringify(frozenFrame).toByteArray(Charsets.UTF_8)
    val wire = frameEncoder.encode(frozenFrame).copyOf()
    if (!wire.contentEquals(expectedWire)) {
        issueFailure(RelayV2OutboxDispatchIssueFailure.ENCODING_REJECTED)
    }
    val decoded = RelayV2Codec().decodeWebSocketFrame(RelayV2WebSocketChannel.PUBLIC, wire)
    if (decoded.frame != frozenFrame ||
        !wire.contentEquals(decoded.canonicalWire.toByteArray(Charsets.UTF_8))
    ) issueFailure(RelayV2OutboxDispatchIssueFailure.ENCODING_REJECTED)
    return wire.copyOf()
}

@Suppress("UNCHECKED_CAST")
private fun Map<String, Any?>.immutableJsonObject(): Map<String, Any?> =
    immutableJsonValue(this) as Map<String, Any?>

private fun immutableJsonValue(value: Any?): Any? = when (value) {
    is Map<*, *> -> Collections.unmodifiableMap(
        LinkedHashMap<String, Any?>(value.size).also { copied ->
            value.forEach { (key, item) ->
                if (key !is String) issueFailure(
                    RelayV2OutboxDispatchIssueFailure.ENCODING_REJECTED,
                )
                copied[key] = immutableJsonValue(item)
            }
        },
    )
    is List<*> -> Collections.unmodifiableList(
        value.mapTo(ArrayList(value.size), ::immutableJsonValue),
    )
    null, is Boolean, is Number, is String -> value
    else -> issueFailure(RelayV2OutboxDispatchIssueFailure.ENCODING_REJECTED)
}

private fun RelayV2RepositoryEffectAuthority.canonicalValue(): Map<String, Any?> = linkedMapOf(
    "generation" to generation.canonicalValue(),
    "profileId" to profileId,
    "profileActivationGeneration" to profileActivationGeneration,
    "principalId" to principalId,
    "clientInstanceId" to clientInstanceId,
    "hostId" to hostId,
    "hostEpoch" to hostEpoch,
)

private fun RelayV2EffectGeneration.canonicalValue(): Map<String, Any?> = linkedMapOf(
    "profileId" to profileId,
    "profileGeneration" to profileGeneration,
    "connectionGeneration" to connectionGeneration,
)

private fun com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEntryId.canonicalValue():
    Map<String, Any?> = linkedMapOf(
    "profileId" to profileId,
    "principalId" to principalId,
    "hostId" to hostId,
    "expectedHostEpoch" to expectedHostEpoch,
    "commandId" to commandId,
)

private fun RelayV2PendingCommand.canonicalValue(): Map<String, Any?> = linkedMapOf(
    "commandId" to commandId,
    "dedupeWindowId" to dedupeWindowId,
)

private fun issueFailure(reason: RelayV2OutboxDispatchIssueFailure): Nothing =
    throw RelayV2OutboxDispatchIssueException(reason)

private fun sha256(bytes: ByteArray): ByteArray =
    MessageDigest.getInstance("SHA-256").digest(bytes)

private val ARGUMENT_SNAPSHOT_LIMITS = RelayV2JsonLimits(
    maxDepth = 4,
    maxDirectKeys = 8,
    maxTotalKeys = 8,
    maxNodes = 16,
)

private const val MAX_RELAY_V2_JSON_INTEGER = 9_007_199_254_740_991L
