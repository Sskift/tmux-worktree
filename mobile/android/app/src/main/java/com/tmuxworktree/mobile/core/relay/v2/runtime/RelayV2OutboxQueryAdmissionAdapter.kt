package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAction
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEffect
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEntryId
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxQueryAuthority
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxRejection
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxAuthorityNamespace
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxBatchResult
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxRecoveryAuthority
import java.util.concurrent.atomic.AtomicBoolean

internal object RelayV2OutboxQueryAdmissionAuthority {
    fun composition(): RelayV2OutboxQueryAdmissionComposition =
        RelayV2OutboxQueryAdmissionComposition.create()
}

/**
 * Closed construction surface for one exact actor receiver and one Outbox admission adapter.
 *
 * The actor receiver claim is one-shot and records the actor's private identity. The adapter claim
 * is also one-shot, so the paired issuer cannot be copied into parallel effect consumers.
 */
internal class RelayV2OutboxQueryAdmissionComposition private constructor(
    private val pairKey: Any,
) {
    private val actorReceiverClaimed = AtomicBoolean(false)
    private val adapterClaimed = AtomicBoolean(false)
    private val issuer = RelayV2CommandQueryAdmissionIssuer.create(pairKey)

    internal fun claimActorReceiver(
        actorReceiverIdentity: Any,
    ): RelayV2CommandQueryAdmissionReceiver? {
        if (!actorReceiverClaimed.compareAndSet(false, true)) return null
        return RelayV2CommandQueryAdmissionReceiver.create(pairKey, actorReceiverIdentity)
    }

    fun adapter(
        applyLease: RelayV2RepositoryEffectApplyLeasePort,
        outbox: RelayV2OutboxRecoveryAuthority,
    ): RelayV2OutboxQueryAdmissionAdapter {
        check(adapterClaimed.compareAndSet(false, true)) {
            "Command-query admission adapter is already bound"
        }
        return RelayV2OutboxQueryAdmissionAdapter(
            applyLease,
            outbox,
            issuer,
        )
    }

    internal companion object {
        fun create(): RelayV2OutboxQueryAdmissionComposition =
            RelayV2OutboxQueryAdmissionComposition(Any())
    }
}

/** Receiver capability held privately by the exact actor that won the composition's claim. */
internal class RelayV2CommandQueryAdmissionReceiver private constructor(
    private val receiverKey: Any,
    private val claimedActorReceiverIdentity: Any,
) {
    fun consume(
        actorReceiverIdentity: Any,
        receipt: RelayV2RecoveryReceipt.CommandQueryAttemptRegistered,
        expectedBinding: RelayV2RecoveryBinding,
        expectedHostId: String,
        expectedHostEpoch: String,
        expectedCommandBatch: RelayV2CommandQueryBatch,
    ): Boolean {
        if (claimedActorReceiverIdentity !== actorReceiverIdentity) return false
        val issued = receipt as? RelayV2IssuedCommandQueryAttemptRegistered ?: return false
        return issued.consume(
            receiverKey,
            expectedBinding,
            expectedHostId,
            expectedHostEpoch,
            expectedCommandBatch,
        )
    }

    internal companion object {
        fun create(
            receiverKey: Any,
            actorReceiverIdentity: Any,
        ): RelayV2CommandQueryAdmissionReceiver =
            RelayV2CommandQueryAdmissionReceiver(receiverKey, actorReceiverIdentity)
    }
}

/** Issuer half. Its key is available only to the closed composition and its exact adapter. */
internal class RelayV2CommandQueryAdmissionIssuer private constructor(
    private val issuerKey: Any,
) {
    fun issue(
        effect: RelayV2RuntimeEffect.RegisterCommandQueryAttempt,
    ): RelayV2RecoveryReceipt.CommandQueryAttemptRegistered =
        RelayV2IssuedCommandQueryAttemptRegistered(
            binding = effect.recovery,
            hostId = effect.hostId,
            hostEpoch = effect.hostEpoch,
            commandBatch = effect.commandBatch,
            issuerKey = issuerKey,
        )

    internal companion object {
        fun create(issuerKey: Any): RelayV2CommandQueryAdmissionIssuer =
            RelayV2CommandQueryAdmissionIssuer(issuerKey)
    }
}

/** No constructor, copy, batch accessor, claim method, or authority key leaves this file. */
private class RelayV2IssuedCommandQueryAttemptRegistered(
    override val binding: RelayV2RecoveryBinding,
    override val hostId: String,
    override val hostEpoch: String,
    private val commandBatch: RelayV2CommandQueryBatch,
    private val issuerKey: Any,
) : RelayV2RecoveryReceipt.CommandQueryAttemptRegistered {
    private val consumed = AtomicBoolean(false)

    override val estimatedCommandBytes: Int = commandBatch.commands.sumOf { command ->
        command.commandId.toByteArray(Charsets.UTF_8).size +
            command.dedupeWindowId.toByteArray(Charsets.UTF_8).size
    }

    fun consume(
        receiverKey: Any,
        expectedBinding: RelayV2RecoveryBinding,
        expectedHostId: String,
        expectedHostEpoch: String,
        expectedCommandBatch: RelayV2CommandQueryBatch,
    ): Boolean {
        if (issuerKey !== receiverKey || !consumed.compareAndSet(false, true)) return false
        return binding == expectedBinding &&
            hostId == expectedHostId &&
            hostEpoch == expectedHostEpoch &&
            commandBatch == expectedCommandBatch
    }

    override fun toString(): String =
        "CommandQueryAttemptRegistered(binding=$binding, hostId=$hostId, <opaque>)"
}

internal sealed interface RelayV2OutboxQueryAdmissionApplyResult {
    data class NotOwned(
        val effect: RelayV2RuntimeEffect,
    ) : RelayV2OutboxQueryAdmissionApplyResult

    data class Committed(
        val receipt: RelayV2RecoveryReceipt.CommandQueryAttemptRegistered,
    ) : RelayV2OutboxQueryAdmissionApplyResult

    data class Rejected(
        val reason: RelayV2OutboxRejection?,
    ) : RelayV2OutboxQueryAdmissionApplyResult

    /** The transaction committed, but its typed effect did not prove the requested query. */
    data object CommitProofMismatch : RelayV2OutboxQueryAdmissionApplyResult

    data object Stale : RelayV2OutboxQueryAdmissionApplyResult
}

private sealed interface RelayV2OutboxQueryAdmissionLeaseResult {
    data class Committed(
        val receipt: RelayV2RecoveryReceipt.CommandQueryAttemptRegistered,
    ) : RelayV2OutboxQueryAdmissionLeaseResult

    data class Rejected(
        val reason: RelayV2OutboxRejection?,
    ) : RelayV2OutboxQueryAdmissionLeaseResult

    data object CommitProofMismatch : RelayV2OutboxQueryAdmissionLeaseResult
}

/**
 * Default-off bridge that admits an actor-issued command.query only after its Outbox query attempt
 * commits under the same actor apply lease.
 *
 * This adapter does not dispatch the returned [RelayV2OutboxEffect.QueryCommands]. It treats that
 * effect only as post-commit proof that the durable authority registered the actor's exact frozen
 * batch and request ID; the actor remains the sole transport sender after accepting the receipt.
 */
internal class RelayV2OutboxQueryAdmissionAdapter(
    private val applyLease: RelayV2RepositoryEffectApplyLeasePort,
    private val outbox: RelayV2OutboxRecoveryAuthority,
    private val issuer: RelayV2CommandQueryAdmissionIssuer,
) {
    suspend fun handle(
        effect: RelayV2RuntimeEffect,
    ): RelayV2OutboxQueryAdmissionApplyResult {
        if (effect !is RelayV2RuntimeEffect.RegisterCommandQueryAttempt) {
            return RelayV2OutboxQueryAdmissionApplyResult.NotOwned(effect)
        }
        val result = applyLease.withEffectApplyLease(effect.repositoryAuthority) {
            registerUnderLease(effect)
        }
        return when (result) {
            is RelayV2EffectApplyResult.Applied -> when (val durable = result.value) {
                is RelayV2OutboxQueryAdmissionLeaseResult.Committed ->
                    RelayV2OutboxQueryAdmissionApplyResult.Committed(durable.receipt)
                is RelayV2OutboxQueryAdmissionLeaseResult.Rejected ->
                    RelayV2OutboxQueryAdmissionApplyResult.Rejected(durable.reason)
                RelayV2OutboxQueryAdmissionLeaseResult.CommitProofMismatch ->
                    RelayV2OutboxQueryAdmissionApplyResult.CommitProofMismatch
            }
            RelayV2EffectApplyResult.Stale -> RelayV2OutboxQueryAdmissionApplyResult.Stale
        }
    }

    private suspend fun registerUnderLease(
        effect: RelayV2RuntimeEffect.RegisterCommandQueryAttempt,
    ): RelayV2OutboxQueryAdmissionLeaseResult {
        requireIdentity(effect)
        val expectedEntryIds = effect.commandBatch.commands.map { command ->
            RelayV2OutboxEntryId(
                profileId = effect.repositoryAuthority.profileId,
                principalId = effect.repositoryAuthority.principalId,
                hostId = effect.hostId,
                expectedHostEpoch = effect.hostEpoch,
                commandId = command.commandId,
            )
        }
        val namespace = RelayV2OutboxAuthorityNamespace(
            profileId = effect.repositoryAuthority.profileId,
            profileActivationGeneration =
                effect.repositoryAuthority.profileActivationGeneration,
            principalId = effect.repositoryAuthority.principalId,
            clientInstanceId = effect.repositoryAuthority.clientInstanceId,
        )
        val result = outbox.reduceOutboxBatchUnderApplyLease(namespace) {
            listOf(
                RelayV2OutboxAction.BeginQueries(
                    entryIds = expectedEntryIds,
                    attemptRequestIds = listOf(effect.recovery.requestId),
                ),
            )
        }
        return when (result) {
            is RelayV2OutboxBatchResult.Rejected ->
                RelayV2OutboxQueryAdmissionLeaseResult.Rejected(result.reason)
            is RelayV2OutboxBatchResult.Applied -> {
                if (!result.exactlyProves(effect, expectedEntryIds)) {
                    RelayV2OutboxQueryAdmissionLeaseResult.CommitProofMismatch
                } else {
                    RelayV2OutboxQueryAdmissionLeaseResult.Committed(
                        issuer.issue(effect),
                    )
                }
            }
        }
    }

    private fun requireIdentity(effect: RelayV2RuntimeEffect.RegisterCommandQueryAttempt) {
        val authority = effect.repositoryAuthority
        require(effect.generation == effect.recovery.generation)
        require(authority.generation == effect.generation)
        require(authority.profileId == effect.generation.profileId)
        require(authority.profileActivationGeneration == effect.generation.profileGeneration)
        require(authority.hostId == effect.hostId)
        require(authority.hostEpoch == effect.hostEpoch)
    }
}

private fun RelayV2OutboxBatchResult.Applied.exactlyProves(
    effect: RelayV2RuntimeEffect.RegisterCommandQueryAttempt,
    expectedEntryIds: List<RelayV2OutboxEntryId>,
): Boolean {
    val query = effects.singleOrNull() as? RelayV2OutboxEffect.QueryCommands ?: return false
    if (query.authority != RelayV2OutboxQueryAuthority(
            profileId = effect.repositoryAuthority.profileId,
            principalId = effect.repositoryAuthority.principalId,
            hostId = effect.hostId,
            expectedHostEpoch = effect.hostEpoch,
        ) ||
        query.attemptRequestId != effect.recovery.requestId ||
        query.items.size != effect.commandBatch.commands.size
    ) {
        return false
    }
    return query.items.indices.all { index ->
        val item = query.items[index]
        val command = effect.commandBatch.commands[index]
        item.entryId == expectedEntryIds[index] &&
            item.dedupeWindowId == command.dedupeWindowId
    }
}
