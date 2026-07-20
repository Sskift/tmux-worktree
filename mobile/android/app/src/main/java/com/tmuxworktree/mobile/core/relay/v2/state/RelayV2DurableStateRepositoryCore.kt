package com.tmuxworktree.mobile.core.relay.v2.state

import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAction
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAuthorityCore
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEntry
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEntryId
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEffect
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxLimits
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxMutation
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxRejection
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxResult
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxState
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalAction
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCheckpointReducer
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalDeliveryToken
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalIdentity
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenAttempt
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenMode
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOutcome
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserRestoreProof
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalReduction
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalRestoreInvalidity
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalStoredCheckpoint
import java.util.concurrent.ConcurrentHashMap

internal class RelayV2TerminalRestoreRequiredException :
    IllegalStateException("Terminal checkpoint must pass the restore barrier before reduction")

internal data class RelayV2PersistedOutboxMeta(
    val namespace: RelayV2OutboxAuthorityNamespace,
    val nextCreationOrder: Long,
    val payload: RelayV2EncodedPayload,
)

internal data class RelayV2PersistedOutboxEntry(
    val namespace: RelayV2OutboxAuthorityNamespace,
    val hostId: String,
    val expectedHostEpoch: String,
    val commandId: String,
    val createdOrder: Long,
    val payload: RelayV2EncodedPayload,
)

internal data class RelayV2PersistedTerminalCheckpoint(
    val key: RelayV2TerminalCheckpointKey,
    val kind: String,
    val payload: RelayV2EncodedPayload,
)

/** Minimal transaction port implemented only by Room in production and memory stores in tests. */
internal interface RelayV2DurableStateStore {
    suspend fun <T> transaction(block: RelayV2DurableStateTransaction.() -> T): T
}

internal interface RelayV2DurableStateTransaction {
    fun outboxMeta(namespace: RelayV2OutboxAuthorityNamespace): RelayV2PersistedOutboxMeta?

    fun outboxEntries(
        namespace: RelayV2OutboxAuthorityNamespace,
    ): List<RelayV2PersistedOutboxEntry>

    fun putOutboxMeta(meta: RelayV2PersistedOutboxMeta)

    fun insertOutboxEntry(entry: RelayV2PersistedOutboxEntry)

    fun replaceOutboxEntry(
        namespace: RelayV2OutboxAuthorityNamespace,
        previousId: RelayV2OutboxEntryId,
        replacement: RelayV2PersistedOutboxEntry,
    ): Boolean

    fun terminalCheckpoint(
        key: RelayV2TerminalCheckpointKey,
    ): RelayV2PersistedTerminalCheckpoint?

    fun putTerminalCheckpoint(checkpoint: RelayV2PersistedTerminalCheckpoint)
}

internal sealed interface RelayV2OutboxBatchResult {
    data class Applied(
        val state: RelayV2OutboxState,
        val effects: List<RelayV2OutboxEffect>,
    ) : RelayV2OutboxBatchResult

    data class Rejected(
        val state: RelayV2OutboxState,
        val reason: RelayV2OutboxRejection?,
    ) : RelayV2OutboxBatchResult
}

/** Narrow durable port used by command-query and status-recovery adapters. */
internal interface RelayV2OutboxRecoveryAuthority {
    suspend fun reduceOutboxBatchUnderApplyLease(
        namespace: RelayV2OutboxAuthorityNamespace,
        actionSource: (RelayV2OutboxState) -> List<RelayV2OutboxAction>?,
    ): RelayV2OutboxBatchResult
}

internal sealed interface RelayV2OutboxFreshDispatchResult {
    data class Committed(
        val state: RelayV2OutboxState,
        val effects: List<RelayV2OutboxEffect.ExecuteCommand>,
    ) : RelayV2OutboxFreshDispatchResult

    data class Empty(
        val state: RelayV2OutboxState,
    ) : RelayV2OutboxFreshDispatchResult

    data class Rejected(
        val state: RelayV2OutboxState,
        val reason: RelayV2OutboxRejection?,
    ) : RelayV2OutboxFreshDispatchResult
}

/**
 * Durable producer authority for one bounded, creation-ordered fresh dispatch transaction.
 *
 * Implementations select DispatchEligible rows and commit QUEUED -> SENDING before returning any
 * Execute effects. The actor apply lease remains an entry precondition owned by the caller.
 */
internal interface RelayV2OutboxFreshDispatchAuthority {
    suspend fun dispatchFreshUnderApplyLease(
        namespace: RelayV2OutboxAuthorityNamespace,
        attemptRequestIds: List<String>,
    ): RelayV2OutboxFreshDispatchResult
}

/** Single production Outbox owner paired into query/recovery and fresh dispatch adapters. */
internal interface RelayV2OutboxRuntimeAuthority :
    RelayV2OutboxRecoveryAuthority,
    RelayV2OutboxFreshDispatchAuthority

/**
 * Narrow durable authority used only by the default-off terminal runtime adapter.
 *
 * This interface owns whole-checkpoint transactions only. External parser, socket, and effect-sink
 * calls are adapter work and must never run from inside a store transaction.
 */
internal interface RelayV2TerminalRuntimeAuthority {
    suspend fun reduceTerminalUnderApplyLease(
        key: RelayV2TerminalCheckpointKey,
        action: RelayV2TerminalAction,
    ): RelayV2TerminalReduction
}

/**
 * Single transaction owner for the accepted pure Outbox and terminal authorities.
 *
 * The actor apply lease is an entry precondition; this core deliberately does not inspect actor
 * generation state itself. Pure reducer effects in returned results become dispatchable only after
 * their transaction has committed. External side effects are never invoked in these transactions.
 */
internal class RelayV2DurableStateRepositoryCore(
    private val store: RelayV2DurableStateStore,
    private val outboxAuthority: RelayV2OutboxAuthorityCore = RelayV2OutboxAuthorityCore(),
) : RelayV2OutboxRuntimeAuthority,
    RelayV2TerminalRuntimeAuthority {
    private val restoredTerminalKeys = ConcurrentHashMap.newKeySet<RelayV2TerminalCheckpointKey>()
    private val resetAuthorizedTerminalKeys =
        ConcurrentHashMap.newKeySet<RelayV2TerminalCheckpointKey>()

    suspend fun loadOutbox(
        namespace: RelayV2OutboxAuthorityNamespace,
    ): RelayV2OutboxState = store.transaction {
        decodeOutbox(namespace)
    }

    suspend fun reduceOutboxUnderApplyLease(
        namespace: RelayV2OutboxAuthorityNamespace,
        action: RelayV2OutboxAction,
    ): RelayV2OutboxResult = store.transaction {
        val current = decodeOutbox(namespace)
        val result = outboxAuthority.reduce(current, action)
        requireOutboxNamespace(namespace, result.state)
        if (result is RelayV2OutboxResult.Applied) {
            applyOutboxPlan(namespace, current, result)
            putOutboxMeta(
                RelayV2PersistedOutboxMeta(
                    namespace,
                    result.state.nextCreationOrder,
                    RelayV2OutboxStorageCodec.encodeMeta(
                        namespace,
                        result.state.nextCreationOrder,
                    ),
                ),
            )
        }
        result
    }

    override suspend fun reduceOutboxBatchUnderApplyLease(
        namespace: RelayV2OutboxAuthorityNamespace,
        actionSource: (RelayV2OutboxState) -> List<RelayV2OutboxAction>?,
    ): RelayV2OutboxBatchResult = store.transaction {
        val current = decodeOutbox(namespace)
        val actions = actionSource(current)
            ?: return@transaction RelayV2OutboxBatchResult.Rejected(current, null)
        if (actions.size !in 1..RelayV2OutboxLimits.MAX_QUERY_ITEMS_PER_BATCH) {
            return@transaction RelayV2OutboxBatchResult.Rejected(current, null)
        }

        var reducedState = current
        val applied = ArrayList<RelayV2OutboxResult.Applied>(actions.size)
        actions.forEach { action ->
            when (val result = outboxAuthority.reduce(reducedState, action)) {
                is RelayV2OutboxResult.Rejected ->
                    return@transaction RelayV2OutboxBatchResult.Rejected(
                        current,
                        result.reason,
                    )
                is RelayV2OutboxResult.Applied -> {
                    requireOutboxNamespace(namespace, result.state)
                    applied += result
                    reducedState = result.state
                }
            }
        }

        var persistedState = current
        applied.forEach { result ->
            applyOutboxPlan(namespace, persistedState, result)
            persistedState = result.state
        }
        putOutboxMeta(
            RelayV2PersistedOutboxMeta(
                namespace,
                reducedState.nextCreationOrder,
                RelayV2OutboxStorageCodec.encodeMeta(
                    namespace,
                    reducedState.nextCreationOrder,
                ),
            ),
        )
        RelayV2OutboxBatchResult.Applied(
            reducedState,
            applied.flatMap { it.effects },
        )
    }

    override suspend fun dispatchFreshUnderApplyLease(
        namespace: RelayV2OutboxAuthorityNamespace,
        attemptRequestIds: List<String>,
    ): RelayV2OutboxFreshDispatchResult {
        val requestIdCount = attemptRequestIds.size
        require(requestIdCount in 1..RelayV2OutboxLimits.MAX_DISPATCH_ITEMS_PER_BATCH)
        val requestIds = ArrayList<String>(requestIdCount)
        repeat(requestIdCount) { index -> requestIds += attemptRequestIds[index] }
        require(attemptRequestIds.size == requestIdCount)
        return store.transaction {
            val current = decodeOutbox(namespace)
            val eligibleIds = outboxAuthority.dispatchEligibleEntryIds(
                current,
                requestIds.size,
            )
            if (eligibleIds.isEmpty()) {
                return@transaction RelayV2OutboxFreshDispatchResult.Empty(current)
            }
            val attempts = LinkedHashMap<RelayV2OutboxEntryId, String>(eligibleIds.size)
            eligibleIds.forEachIndexed { index, entryId ->
                attempts[entryId] = requestIds[index]
            }
            when (val result = outboxAuthority.reduce(
                current,
                RelayV2OutboxAction.DispatchEligible(
                    attemptRequestIds = attempts,
                    effectBudget = eligibleIds.size,
                ),
            )) {
                is RelayV2OutboxResult.Rejected ->
                    RelayV2OutboxFreshDispatchResult.Rejected(current, result.reason)
                is RelayV2OutboxResult.Applied -> {
                    requireOutboxNamespace(namespace, result.state)
                    val executeEffects = result.effects.mapNotNull {
                        it as? RelayV2OutboxEffect.ExecuteCommand
                    }
                    check(executeEffects.size == eligibleIds.size &&
                        executeEffects.size == result.effects.size
                    ) { "Fresh Outbox dispatch produced an invalid effect cut" }
                    applyOutboxPlan(namespace, current, result)
                    putOutboxMeta(
                        RelayV2PersistedOutboxMeta(
                            namespace,
                            result.state.nextCreationOrder,
                            RelayV2OutboxStorageCodec.encodeMeta(
                                namespace,
                                result.state.nextCreationOrder,
                            ),
                        ),
                    )
                    RelayV2OutboxFreshDispatchResult.Committed(
                        result.state,
                        executeEffects,
                    )
                }
            }
        }
    }

    suspend fun loadTerminal(
        key: RelayV2TerminalCheckpointKey,
    ): RelayV2TerminalStoredCheckpoint = store.transaction { decodeTerminal(key) }

    override suspend fun reduceTerminalUnderApplyLease(
        key: RelayV2TerminalCheckpointKey,
        action: RelayV2TerminalAction,
    ): RelayV2TerminalReduction {
        val result = store.transaction {
            val stored = decodeTerminal(key)
            val replacesAfterReset = key in resetAuthorizedTerminalKeys &&
                action is RelayV2TerminalAction.BeginOpenAttempt &&
                action.mode == RelayV2TerminalOpenMode.RESET &&
                key == RelayV2TerminalCheckpointKey.from(action.target)
            if (stored is RelayV2TerminalStoredCheckpoint.Invalid && !replacesAfterReset) {
                throw stored.asStorageException()
            }
            if (stored !is RelayV2TerminalStoredCheckpoint.Missing &&
                key !in restoredTerminalKeys && !replacesAfterReset
            ) {
                throw RelayV2TerminalRestoreRequiredException()
            }
            val reduction = if (replacesAfterReset) {
                RelayV2TerminalCheckpointReducer.reduce(null, action)
            } else when (stored) {
                RelayV2TerminalStoredCheckpoint.Missing ->
                    RelayV2TerminalCheckpointReducer.reduce(null, action)
                is RelayV2TerminalStoredCheckpoint.PreOpen ->
                    RelayV2TerminalCheckpointReducer.reduce(stored.checkpoint, action)
                is RelayV2TerminalStoredCheckpoint.Present ->
                    RelayV2TerminalCheckpointReducer.reduce(stored.checkpoint, action)
                is RelayV2TerminalStoredCheckpoint.Invalid -> error("Handled above")
            }
            persistTerminalReduction(key, reduction)
            reduction
        }
        result.rememberReducedKey(key)
        return result
    }

    suspend fun restoreTerminalUnderApplyLease(
        key: RelayV2TerminalCheckpointKey,
        expectedIdentity: RelayV2TerminalIdentity,
        expectedOpenAttempt: RelayV2TerminalOpenAttempt,
        currentDeliveryToken: RelayV2TerminalDeliveryToken,
        currentParserContinuityId: String?,
        parserOperationProof: RelayV2TerminalParserRestoreProof? = null,
    ): RelayV2TerminalReduction {
        val result = store.transaction {
            require(key == RelayV2TerminalCheckpointKey.from(expectedIdentity.target()))
            val stored = decodeTerminal(key)
            val reduction = RelayV2TerminalCheckpointReducer.restore(
                stored,
                expectedIdentity,
                expectedOpenAttempt,
                currentDeliveryToken,
                currentParserContinuityId,
                parserOperationProof,
            )
            if (stored !is RelayV2TerminalStoredCheckpoint.Invalid) {
                persistTerminalReduction(key, reduction)
            }
            reduction
        }
        result.rememberRestoreOutcome(key)
        return result
    }

    suspend fun restorePreOpenTerminalUnderApplyLease(
        key: RelayV2TerminalCheckpointKey,
        expectedOpenAttempt: RelayV2TerminalOpenAttempt,
        currentDeliveryToken: RelayV2TerminalDeliveryToken,
        currentParserContinuityId: String?,
    ): RelayV2TerminalReduction {
        val result = store.transaction {
            val stored = decodeTerminal(key)
            val reduction = RelayV2TerminalCheckpointReducer.restorePreOpen(
                stored,
                key.toTarget(),
                expectedOpenAttempt,
                currentDeliveryToken,
                currentParserContinuityId,
            )
            if (stored !is RelayV2TerminalStoredCheckpoint.Invalid) {
                persistTerminalReduction(key, reduction)
            }
            reduction
        }
        result.rememberRestoreOutcome(key)
        return result
    }

    fun forgetProfileAfterDisconnect(profileId: String) {
        restoredTerminalKeys.removeIf { it.profileId == profileId }
        resetAuthorizedTerminalKeys.removeIf { it.profileId == profileId }
    }

    private fun RelayV2DurableStateTransaction.decodeOutbox(
        namespace: RelayV2OutboxAuthorityNamespace,
    ): RelayV2OutboxState {
        val meta = outboxMeta(namespace)
        val rows = outboxEntries(namespace)
        if (meta == null) {
            if (rows.isNotEmpty()) {
                throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
            }
            return RelayV2OutboxState.empty()
        }
        if (meta.namespace != namespace) {
            throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
        }
        val nextCreationOrder = RelayV2OutboxStorageCodec.decodeMeta(
            namespace,
            meta.nextCreationOrder,
            meta.payload,
        )
        val entries = rows.map { row ->
            if (row.namespace != namespace) {
                throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
            }
            RelayV2OutboxStorageCodec.decodeEntry(
                namespace,
                row.hostId,
                row.expectedHostEpoch,
                row.commandId,
                row.createdOrder,
                row.payload,
            )
        }
        return try {
            RelayV2OutboxState.restore(entries, nextCreationOrder).also {
                requireOutboxNamespace(namespace, it)
            }
        } catch (failure: RelayV2StorageException) {
            throw failure
        } catch (_: IllegalArgumentException) {
            throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
        }
    }

    private fun RelayV2DurableStateTransaction.applyOutboxPlan(
        namespace: RelayV2OutboxAuthorityNamespace,
        current: RelayV2OutboxState,
        result: RelayV2OutboxResult.Applied,
    ) {
        result.transaction.mutations.forEach { mutation ->
            when (mutation) {
                is RelayV2OutboxMutation.Insert -> {
                    requireOutboxEntryNamespace(namespace, mutation.entry)
                    insertOutboxEntry(mutation.entry.toPersisted(namespace))
                }
                is RelayV2OutboxMutation.Replace -> {
                    val previous = current.entry(mutation.previousId)
                        ?: throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
                    requireOutboxEntryNamespace(namespace, mutation.entry)
                    if (previous.createdOrder != mutation.entry.createdOrder ||
                        !replaceOutboxEntry(
                            namespace,
                            mutation.previousId,
                            mutation.entry.toPersisted(namespace),
                        )
                    ) {
                        throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
                    }
                }
            }
        }
    }

    private fun RelayV2OutboxEntry.toPersisted(
        namespace: RelayV2OutboxAuthorityNamespace,
    ): RelayV2PersistedOutboxEntry = RelayV2PersistedOutboxEntry(
        namespace,
        hostId,
        expectedHostEpoch,
        commandId,
        createdOrder,
        RelayV2OutboxStorageCodec.encodeEntry(namespace, this),
    )

    private fun RelayV2TerminalReduction.rememberReducedKey(
        key: RelayV2TerminalCheckpointKey,
    ) {
        if (checkpoint != null || preOpenCheckpoint != null) {
            restoredTerminalKeys += key
            resetAuthorizedTerminalKeys -= key
        } else {
            restoredTerminalKeys -= key
        }
    }

    private fun RelayV2TerminalReduction.rememberRestoreOutcome(
        key: RelayV2TerminalCheckpointKey,
    ) {
        if (checkpoint != null || preOpenCheckpoint != null) {
            restoredTerminalKeys += key
            resetAuthorizedTerminalKeys -= key
        } else {
            restoredTerminalKeys -= key
            if (outcome is RelayV2TerminalOutcome.ResetRequired) {
                resetAuthorizedTerminalKeys += key
            } else {
                resetAuthorizedTerminalKeys -= key
            }
        }
    }

    private fun RelayV2DurableStateTransaction.decodeTerminal(
        key: RelayV2TerminalCheckpointKey,
    ): RelayV2TerminalStoredCheckpoint {
        val row = terminalCheckpoint(key) ?: return RelayV2TerminalStoredCheckpoint.Missing
        if (row.key != key) {
            return RelayV2TerminalStoredCheckpoint.Invalid(
                RelayV2TerminalRestoreInvalidity.CORRUPT_QUEUE,
            )
        }
        return RelayV2TerminalCheckpointCodec.decode(key, row.kind, row.payload)
    }

    private fun RelayV2DurableStateTransaction.persistTerminalReduction(
        key: RelayV2TerminalCheckpointKey,
        result: RelayV2TerminalReduction,
    ) {
        val stored = when {
            result.checkpoint != null -> RelayV2TerminalStoredCheckpoint.Present(result.checkpoint)
            result.preOpenCheckpoint != null ->
                RelayV2TerminalStoredCheckpoint.PreOpen(result.preOpenCheckpoint)
            else -> return
        }
        val encoded = RelayV2TerminalCheckpointCodec.encode(key, stored)
        putTerminalCheckpoint(
            RelayV2PersistedTerminalCheckpoint(
                key = key,
                kind = encoded.kind.name,
                payload = encoded.payload,
            ),
        )
    }

    private fun requireOutboxNamespace(
        namespace: RelayV2OutboxAuthorityNamespace,
        state: RelayV2OutboxState,
    ) {
        if (state.entries.any {
                it.profileId != namespace.profileId || it.principalId != namespace.principalId
            }
        ) {
            throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
        }
    }

    private fun requireOutboxEntryNamespace(
        namespace: RelayV2OutboxAuthorityNamespace,
        entry: RelayV2OutboxEntry,
    ) {
        if (entry.profileId != namespace.profileId || entry.principalId != namespace.principalId) {
            throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
        }
    }

    private fun RelayV2TerminalStoredCheckpoint.Invalid.asStorageException():
        RelayV2StorageException = RelayV2StorageException(
        when (reason) {
            RelayV2TerminalRestoreInvalidity.SCHEMA_INCOMPATIBLE ->
                RelayV2StorageFailure.SCHEMA_INCOMPATIBLE
            RelayV2TerminalRestoreInvalidity.MISSING_REQUIRED_FIELD ->
                RelayV2StorageFailure.MISSING_REQUIRED_FIELD
            RelayV2TerminalRestoreInvalidity.LIMIT_EXCEEDED ->
                RelayV2StorageFailure.LIMIT_EXCEEDED
            RelayV2TerminalRestoreInvalidity.MALFORMED_COUNTER,
            RelayV2TerminalRestoreInvalidity.CORRUPT_QUEUE,
            -> RelayV2StorageFailure.MALFORMED
        },
    )
}
