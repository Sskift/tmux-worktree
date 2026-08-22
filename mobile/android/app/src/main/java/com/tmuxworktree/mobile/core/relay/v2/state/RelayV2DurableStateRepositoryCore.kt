package com.tmuxworktree.mobile.core.relay.v2.state

import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAction
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAuthorityCore
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2CommandResult
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxDraft
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEntry
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEntryId
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEffect
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxLimits
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxMutation
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxOperation
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxRejection
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxResult
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxState
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxTransactionPlan
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalAction
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCheckpoint
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCheckpointReducer
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCorrelatedError
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalDeliveryToken
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffect
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalIdentity
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalIgnoredReason
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenAttempt
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenMode
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalPendingOpen
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalPendingClose
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenTarget
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenResume
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOutcome
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserRestoreProof
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalPhase
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalPreOpenPhase
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalReduction
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResetReason
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalRestoreInvalidity
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalStoredCheckpoint
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException

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

internal data class RelayV2CreateOutcomeKey(
    val namespace: RelayV2OutboxAuthorityNamespace,
    val hostId: String,
    val expectedHostEpoch: String,
    val commandId: String,
)

internal enum class RelayV2CreateOutcomeState {
    SUCCEEDED,
    FAILED_FINAL,
    AMBIGUOUS,
}

internal data class RelayV2CreateOutcome(
    val key: RelayV2CreateOutcomeKey,
    val createdOrder: Long,
    val scopeId: String,
    val operation: RelayV2OutboxOperation,
    val state: RelayV2CreateOutcomeState,
    val sessionId: String?,
    val errorCode: String?,
    val errorMessage: String?,
    val acknowledged: Boolean,
) {
    init {
        require(operation == RelayV2OutboxOperation.CREATE_WORKTREE ||
            operation == RelayV2OutboxOperation.CREATE_TERMINAL)
        require(createdOrder >= 0)
        when (state) {
            RelayV2CreateOutcomeState.SUCCEEDED -> {
                require(sessionId != null && errorCode == null && errorMessage == null)
            }
            RelayV2CreateOutcomeState.FAILED_FINAL,
            RelayV2CreateOutcomeState.AMBIGUOUS,
            -> require(sessionId == null && errorCode != null && errorMessage != null)
        }
    }
}

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

    fun createOutcomes(
        namespace: RelayV2OutboxAuthorityNamespace,
    ): List<RelayV2CreateOutcome> = emptyList()

    fun putCreateOutcome(outcome: RelayV2CreateOutcome) = Unit

    fun acknowledgeCreateOutcome(key: RelayV2CreateOutcomeKey): Boolean = false

    fun terminalCheckpoint(
        key: RelayV2TerminalCheckpointKey,
    ): RelayV2PersistedTerminalCheckpoint?

    fun terminalCheckpointsForSession(
        selector: RelayV2TerminalResumeSessionSelector,
        hostEpoch: String,
    ): List<RelayV2PersistedTerminalCheckpoint> = emptyList()

    fun deleteTerminalCheckpoint(key: RelayV2TerminalCheckpointKey): Boolean = false

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

internal data class RelayV2OutboxEnqueueReceipt(
    val hostId: String,
    val expectedHostEpoch: String,
    val commandId: String,
    val createdOrder: Long,
)

internal enum class RelayV2OutboxEnqueueFailure {
    DUPLICATE_COMMAND,
    CAPACITY_EXCEEDED,
    FOREIGN_LINEAGE,
    CORRUPT_STATE,
    UNKNOWN_STATE,
    STORE_FAILURE,
}

internal sealed interface RelayV2OutboxEnqueueResult {
    data class Committed(
        val receipt: RelayV2OutboxEnqueueReceipt,
    ) : RelayV2OutboxEnqueueResult

    data class Rejected(
        val failure: RelayV2OutboxEnqueueFailure,
    ) : RelayV2OutboxEnqueueResult
}

/**
 * Narrow durable command-producer port for an already-stable activation namespace and draft.
 *
 * A committed receipt is only non-sensitive row correlation. This authority never exposes the
 * durable state or arguments and never sends, connects, or mints a dispatch capability.
 */
internal interface RelayV2OutboxEnqueueAuthority {
    suspend fun enqueueOutbox(
        namespace: RelayV2OutboxAuthorityNamespace,
        draft: RelayV2OutboxDraft,
        createdAtMillis: Long,
    ): RelayV2OutboxEnqueueResult
}

/** Durable completion evidence used to reconnect an accepted create command to the APK UI. */
internal interface RelayV2CreateOutcomeAuthority {
    suspend fun readCreateOutcomes(
        namespace: RelayV2OutboxAuthorityNamespace,
    ): List<RelayV2CreateOutcome> = emptyList()

    suspend fun acknowledgeCreateOutcome(key: RelayV2CreateOutcomeKey): Boolean = false
}

/** Single production Outbox owner paired into query/recovery and fresh dispatch adapters. */
internal interface RelayV2OutboxRuntimeAuthority :
    RelayV2OutboxRecoveryAuthority,
    RelayV2OutboxFreshDispatchAuthority,
    RelayV2CreateOutcomeAuthority

/**
 * Narrow durable authority used only by the default-off terminal runtime adapter.
 *
 * This interface owns whole-checkpoint transactions only. External parser, socket, and effect-sink
 * calls are adapter work and must never run from inside a store transaction.
 */
internal interface RelayV2TerminalRuntimeAuthority {
    suspend fun loadTerminalUnderApplyLease(
        key: RelayV2TerminalCheckpointKey,
    ): RelayV2TerminalStoredCheckpoint = throw RelayV2TerminalRestoreRequiredException()

    suspend fun reduceTerminalUnderApplyLease(
        key: RelayV2TerminalCheckpointKey,
        action: RelayV2TerminalAction,
    ): RelayV2TerminalReduction
}

/**
 * Result of correlating a generic terminal error after presentation has released its attachment.
 *
 * This is deliberately narrower than a normal terminal reduction. It can prove that an issued
 * request owns the error, but it never retires or rewrites the live Host lineage: doing that
 * requires an acknowledged, route-bound abandon protocol rather than a local Room deletion.
 */
internal sealed interface RelayV2DetachedTerminalErrorResult {
    data class Consumed(
        /** Non-null only when the error rejects the checkpoint's exact current open request. */
        val currentOpenError: RelayV2TerminalCorrelatedError?,
        /** Non-null only when the error rejects the checkpoint's exact current close request. */
        val currentCloseError: RelayV2TerminalCorrelatedError? = null,
    ) : RelayV2DetachedTerminalErrorResult

    data object NotOwned : RelayV2DetachedTerminalErrorResult

    data class ProtocolViolation(
        val code: String,
    ) : RelayV2DetachedTerminalErrorResult
}

/**
 * Correlation of terminal.opened after presentation released its parser attachment. CURRENT has
 * been durably adopted into a renderer-free RESET_REQUIRED checkpoint before it is returned.
 */
internal sealed interface RelayV2DetachedTerminalOpenedResult {
    data object Current : RelayV2DetachedTerminalOpenedResult

    data object IssuedOld : RelayV2DetachedTerminalOpenedResult

    data object NotOwned : RelayV2DetachedTerminalOpenedResult

    data class ProtocolViolation(
        val code: String,
    ) : RelayV2DetachedTerminalOpenedResult
}

/** Startup-only recovery port paired with the durable post-commit journal owner. */
internal interface RelayV2TerminalRecoveryAuthority : RelayV2TerminalRuntimeAuthority {
    suspend fun claimResumableTerminalUnderApplyLease(
        selector: RelayV2TerminalResumeSessionSelector,
        authority: RelayV2RepositoryEffectAuthority,
        requestId: String,
        openAttempt: RelayV2TerminalOpenAttempt,
        cols: Int,
        rows: Int,
    ): RelayV2TerminalResumeClaim?

    suspend fun recoverPostCommitUnknown(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
    ): RelayV2TerminalReduction?

    suspend fun recoverPostCommitUnknownWithContinuity(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        currentParserContinuityId: String,
    ): RelayV2TerminalReduction? = recoverPostCommitUnknown(authority, key)

    suspend fun correlateDetachedTerminalErrorUnderApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        action: RelayV2TerminalAction.CorrelatedError,
    ): RelayV2DetachedTerminalErrorResult = RelayV2DetachedTerminalErrorResult.NotOwned

    suspend fun correlateDetachedTerminalOpenedUnderApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        action: RelayV2TerminalAction.Opened,
    ): RelayV2DetachedTerminalOpenedResult = RelayV2DetachedTerminalOpenedResult.NotOwned

    /** Atomically records disposal before an exact pre-open owner is released. */
    suspend fun ensureTerminalCloseWhenOpenedUnderApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        pendingClose: RelayV2TerminalPendingClose,
    ): RelayV2TerminalReduction? = null

    /** Atomically adopts an exact detached pre-open response directly into pending close. */
    suspend fun adoptDetachedTerminalOpenedForCloseUnderApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        action: RelayV2TerminalAction.Opened,
        pendingClose: RelayV2TerminalPendingClose,
    ): RelayV2TerminalReduction? = null

    /** Atomically finalizes the exact close-only/detached owner without parser replay. */
    suspend fun consumeDetachedTerminalClosedUnderApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        action: RelayV2TerminalAction.Closed,
    ): RelayV2TerminalReduction? = null

    /** Atomically advances a renderer-free discard cursor before its exact OutputAck is sent. */
    suspend fun consumeRendererFreeTerminalOutputUnderApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        action: RelayV2TerminalAction.Output,
    ): RelayV2TerminalReduction? = null

    /** Atomically correlates a renderer-free reset without granting parser/UI authority. */
    suspend fun consumeRendererFreeTerminalResetUnderApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        action: RelayV2TerminalAction,
    ): RelayV2TerminalReduction? = null

    /** Rebinds one durable detached owner to the current actor and atomically requests close. */
    suspend fun claimTerminalCloseUnderApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        pendingClose: RelayV2TerminalPendingClose,
    ): RelayV2TerminalResumeClaim? = null
}

/** UI-free exact Session selector used only to locate a durable terminal checkpoint. */
internal data class RelayV2TerminalResumeSessionSelector(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val scopeId: String,
    val sessionId: String,
    val pane: Int,
)

/** One transaction's one-shot claim of a stored terminal identity for a RESUME attempt. */
internal data class RelayV2TerminalResumeClaim(
    val key: RelayV2TerminalCheckpointKey,
    val reduction: RelayV2TerminalReduction,
)

/**
 * Single transaction owner for the accepted pure Outbox and terminal authorities.
 *
 * The actor apply lease is an entry precondition for effect/recovery methods; enqueue instead
 * requires its caller to supply the already-stable activation namespace and draft. This core
 * deliberately does not inspect actor generation state itself. Pure reducer effects in returned
 * results become dispatchable only after their transaction has committed. External side effects
 * are never invoked in these transactions.
 */
internal class RelayV2DurableStateRepositoryCore(
    private val store: RelayV2DurableStateStore,
    private val outboxAuthority: RelayV2OutboxAuthorityCore = RelayV2OutboxAuthorityCore(),
) : RelayV2OutboxRuntimeAuthority,
    RelayV2OutboxEnqueueAuthority,
    RelayV2TerminalRecoveryAuthority {
    private val restoredTerminalKeys = ConcurrentHashMap.newKeySet<RelayV2TerminalCheckpointKey>()
    private val resetAuthorizedTerminalKeys =
        ConcurrentHashMap.newKeySet<RelayV2TerminalCheckpointKey>()

    suspend fun loadOutbox(
        namespace: RelayV2OutboxAuthorityNamespace,
    ): RelayV2OutboxState = store.transaction {
        decodeOutbox(namespace)
    }

    override suspend fun readCreateOutcomes(
        namespace: RelayV2OutboxAuthorityNamespace,
    ): List<RelayV2CreateOutcome> = store.transaction {
        createOutcomes(namespace)
    }

    override suspend fun acknowledgeCreateOutcome(key: RelayV2CreateOutcomeKey): Boolean =
        store.transaction {
            this.acknowledgeCreateOutcome(key)
        }

    override suspend fun enqueueOutbox(
        namespace: RelayV2OutboxAuthorityNamespace,
        draft: RelayV2OutboxDraft,
        createdAtMillis: Long,
    ): RelayV2OutboxEnqueueResult {
        val action = RelayV2OutboxAction.Enqueue(draft, createdAtMillis)
        val transactionResult = try {
            store.transaction {
                val current = decodeOutbox(namespace)
                if (draft.profileId != namespace.profileId ||
                    draft.principalId != namespace.principalId
                ) {
                    return@transaction RelayV2OutboxEnqueueTransactionResult.Rejected(
                        RelayV2OutboxEnqueueFailure.FOREIGN_LINEAGE,
                    )
                }
                when (val result = outboxAuthority.reduce(current, action)) {
                    is RelayV2OutboxResult.Rejected ->
                        RelayV2OutboxEnqueueTransactionResult.Rejected(
                            result.reason.toEnqueueFailure(),
                        )
                    is RelayV2OutboxResult.Applied -> {
                        when (val validation = validateEnqueueResult(
                            current,
                            draft,
                            createdAtMillis,
                            result,
                        )) {
                            is RelayV2OutboxEnqueueValidation.Rejected ->
                                RelayV2OutboxEnqueueTransactionResult.Rejected(
                                    validation.failure,
                                )
                            is RelayV2OutboxEnqueueValidation.Accepted -> {
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
                                RelayV2OutboxEnqueueTransactionResult.Committed(
                                    hostId = validation.entry.hostId,
                                    expectedHostEpoch = validation.entry.expectedHostEpoch,
                                    commandId = validation.entry.commandId,
                                    createdOrder = validation.entry.createdOrder,
                                )
                            }
                        }
                    }
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: RelayV2StorageException) {
            return RelayV2OutboxEnqueueResult.Rejected(failure.toEnqueueFailure())
        } catch (_: Exception) {
            return RelayV2OutboxEnqueueResult.Rejected(
                RelayV2OutboxEnqueueFailure.STORE_FAILURE,
            )
        }
        return when (transactionResult) {
            is RelayV2OutboxEnqueueTransactionResult.Rejected ->
                RelayV2OutboxEnqueueResult.Rejected(transactionResult.failure)
            is RelayV2OutboxEnqueueTransactionResult.Committed ->
                RelayV2OutboxEnqueueResult.Committed(
                    RelayV2OutboxEnqueueReceipt(
                        hostId = transactionResult.hostId,
                        expectedHostEpoch = transactionResult.expectedHostEpoch,
                        commandId = transactionResult.commandId,
                        createdOrder = transactionResult.createdOrder,
                    ),
                )
        }
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
            persistCreateOutcome(namespace, action, result.state)
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
        applied.forEachIndexed { index, result ->
            applyOutboxPlan(namespace, persistedState, result)
            persistedState = result.state
            persistCreateOutcome(namespace, actions[index], persistedState)
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

    private fun RelayV2DurableStateTransaction.persistCreateOutcome(
        namespace: RelayV2OutboxAuthorityNamespace,
        action: RelayV2OutboxAction,
        state: RelayV2OutboxState,
    ) {
        val reconciliation = action as? RelayV2OutboxAction.ReconcileStatus ?: return
        val evidence = reconciliation.evidence
        if (evidence.operation != RelayV2OutboxOperation.CREATE_WORKTREE &&
            evidence.operation != RelayV2OutboxOperation.CREATE_TERMINAL
        ) return
        val leaf = state.entry(evidence.entryId) ?: return
        val outcomeState = when (leaf.state) {
            RelayV2OutboxStateTag.SUCCEEDED -> RelayV2CreateOutcomeState.SUCCEEDED
            RelayV2OutboxStateTag.FAILED_FINAL -> RelayV2CreateOutcomeState.FAILED_FINAL
            RelayV2OutboxStateTag.AMBIGUOUS -> RelayV2CreateOutcomeState.AMBIGUOUS
            else -> return
        }
        val root = state.createRootFor(leaf) ?: return
        val created = evidence.result as? RelayV2CommandResult.CreatedSession
        val errorCode = when (outcomeState) {
            RelayV2CreateOutcomeState.SUCCEEDED -> null
            RelayV2CreateOutcomeState.FAILED_FINAL -> evidence.errorCode ?: "CREATE_REJECTED"
            RelayV2CreateOutcomeState.AMBIGUOUS ->
                evidence.errorCode ?: "COMMAND_OUTCOME_UNCERTAIN"
        }
        val errorMessage = when (outcomeState) {
            RelayV2CreateOutcomeState.SUCCEEDED -> null
            RelayV2CreateOutcomeState.FAILED_FINAL ->
                evidence.errorMessage ?: "The computer rejected the creation command."
            RelayV2CreateOutcomeState.AMBIGUOUS ->
                evidence.errorMessage ?: "The computer could not confirm whether creation completed."
        }
        val sessionId = if (outcomeState == RelayV2CreateOutcomeState.SUCCEEDED) {
            requireNotNull(created).sessionId
        } else {
            null
        }
        putCreateOutcome(
            RelayV2CreateOutcome(
                key = RelayV2CreateOutcomeKey(
                    namespace = namespace,
                    hostId = root.hostId,
                    expectedHostEpoch = root.expectedHostEpoch,
                    commandId = root.commandId,
                ),
                createdOrder = root.createdOrder,
                scopeId = root.scopeId,
                operation = root.operation,
                state = outcomeState,
                sessionId = sessionId,
                errorCode = errorCode,
                errorMessage = errorMessage,
                acknowledged = false,
            ),
        )
    }

    private fun RelayV2OutboxState.createRootFor(
        terminalEntry: RelayV2OutboxEntry,
    ): RelayV2OutboxEntry? {
        var current = terminalEntry
        val visited = HashSet<String>()
        while (current.reissuedFromCommandId != null) {
            if (!visited.add(current.commandId)) return null
            val parentId = requireNotNull(current.reissuedFromCommandId)
            current = entries.singleOrNull { candidate ->
                candidate.commandId == parentId &&
                    candidate.replacementCommandId == current.commandId &&
                    candidate.operation == current.operation &&
                    candidate.scopeId == current.scopeId
            } ?: return null
        }
        return current
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

    override suspend fun loadTerminalUnderApplyLease(
        key: RelayV2TerminalCheckpointKey,
    ): RelayV2TerminalStoredCheckpoint = loadTerminal(key)

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

    override suspend fun claimResumableTerminalUnderApplyLease(
        selector: RelayV2TerminalResumeSessionSelector,
        authority: RelayV2RepositoryEffectAuthority,
        requestId: String,
        openAttempt: RelayV2TerminalOpenAttempt,
        cols: Int,
        rows: Int,
    ): RelayV2TerminalResumeClaim? {
        requireResumeSelectorAuthority(selector, authority)
        val claim = store.transaction {
            val rowsForSession = terminalCheckpointsForSession(selector, authority.hostEpoch)
            check(rowsForSession.size <= MAX_TERMINAL_CHECKPOINTS_PER_SESSION) {
                "Terminal checkpoint retention is over limit"
            }
            val decoded = rowsForSession.map { row ->
                row.key to decodeTerminalRow(row.key, row)
            }
            val invalid = decoded.firstOrNull { it.second is RelayV2TerminalStoredCheckpoint.Invalid }
            if (invalid != null) {
                throw (invalid.second as RelayV2TerminalStoredCheckpoint.Invalid)
                    .asStorageException()
            }
            decoded.filter { (_, stored) ->
                (stored as? RelayV2TerminalStoredCheckpoint.Present)
                    ?.checkpoint?.phase in setOf(
                    RelayV2TerminalPhase.FINALIZED,
                    RelayV2TerminalPhase.LOST,
                )
            }.forEach { (key, stored) ->
                val checkpoint = (stored as RelayV2TerminalStoredCheckpoint.Present).checkpoint
                check(finalizedCheckpointIsPrunable(checkpoint)) {
                    "Finalized terminal checkpoint still owns callback authority"
                }
                check(deleteTerminalCheckpoint(key)) {
                    "Finalized terminal checkpoint could not be pruned"
                }
            }
            val candidates = decoded.mapNotNull { (key, stored) ->
                when (stored) {
                    is RelayV2TerminalStoredCheckpoint.PreOpen -> key to stored
                    is RelayV2TerminalStoredCheckpoint.Present ->
                        if (stored.checkpoint.phase in setOf(
                                RelayV2TerminalPhase.FINALIZED,
                                RelayV2TerminalPhase.LOST,
                            )
                        ) null
                        else key to stored
                    is RelayV2TerminalStoredCheckpoint.Invalid -> error("Handled above")
                    RelayV2TerminalStoredCheckpoint.Missing -> null
                }
            }
            check(candidates.size <= 1) {
                "Multiple resumable terminal checkpoints exist for one Session"
            }
            val (key, stored) = candidates.singleOrNull() ?: return@transaction null
            val previousDeliveryToken = when (stored) {
                is RelayV2TerminalStoredCheckpoint.PreOpen -> stored.checkpoint.deliveryToken
                is RelayV2TerminalStoredCheckpoint.Present -> stored.checkpoint.deliveryToken
                else -> error("Candidate kind is not resumable")
            }
            check(previousDeliveryToken.authorityGeneration < Long.MAX_VALUE) {
                "Terminal delivery authority generation is exhausted"
            }
            val deliveryToken = RelayV2TerminalDeliveryToken(
                actorGeneration = authority.generation,
                authorityGeneration = previousDeliveryToken.authorityGeneration + 1,
                localDispatchToken = 1,
            )
            val restored = when (stored) {
                is RelayV2TerminalStoredCheckpoint.PreOpen ->
                    RelayV2TerminalCheckpointReducer.restorePreOpen(
                        stored = stored,
                        expectedTarget = key.toTarget(),
                        expectedOpenAttempt = stored.checkpoint.pendingOpen?.openAttempt
                            ?: stored.checkpoint.resetFence?.openAttempt
                            ?: openAttempt,
                        currentDeliveryToken = deliveryToken,
                        currentParserContinuityId = stored.checkpoint.parserContinuityId,
                    )
                is RelayV2TerminalStoredCheckpoint.Present -> {
                    val checkpoint = stored.checkpoint
                    check(key == RelayV2TerminalCheckpointKey.from(checkpoint.identity.target()))
                    RelayV2TerminalCheckpointReducer.restore(
                        stored = stored,
                        expectedIdentity = checkpoint.identity,
                        expectedOpenAttempt = checkpoint.openAttempt,
                        currentDeliveryToken = deliveryToken,
                        currentParserContinuityId = checkpoint.parserContinuityId,
                        parserOperationProof = null,
                    )
                }
                else -> error("Candidate kind is not resumable")
            }
            val reduction = when (stored) {
                is RelayV2TerminalStoredCheckpoint.PreOpen -> {
                    if (restored.outcome is RelayV2TerminalOutcome.Restored) {
                        val current = requireNotNull(restored.preOpenCheckpoint)
                        val pending = requireNotNull(current.pendingOpen)
                        RelayV2TerminalCheckpointReducer.reduce(
                            current,
                            RelayV2TerminalAction.BeginOpenAttempt(
                                deliveryToken = deliveryToken,
                                requestId = requestId,
                                openAttempt = pending.openAttempt,
                                mode = pending.mode,
                                cols = pending.cols,
                                rows = pending.rows,
                                target = pending.target,
                                parserContinuityId = pending.parserContinuityId,
                                resume = pending.resume,
                            ),
                        )
                    } else if (
                        restored.outcome ==
                        RelayV2TerminalOutcome.ResetRequired(
                            RelayV2TerminalResetReason.STREAM_LOST,
                        )
                    ) {
                        val current = requireNotNull(restored.preOpenCheckpoint)
                        check(current.phase == RelayV2TerminalPreOpenPhase.RESET_REQUIRED)
                        val predecessor = requireNotNull(current.resetFence)
                        RelayV2TerminalCheckpointReducer.reduce(
                            current,
                            RelayV2TerminalAction.BeginOpenAttempt(
                                deliveryToken = predecessor.deliveryToken,
                                requestId = requestId,
                                openAttempt = openAttempt,
                                mode = RelayV2TerminalOpenMode.RESET,
                                cols = predecessor.cols,
                                rows = predecessor.rows,
                                target = predecessor.target,
                                parserContinuityId = predecessor.parserContinuityId,
                                resume = null,
                            ),
                        )
                    } else {
                        restored
                    }
                }
                is RelayV2TerminalStoredCheckpoint.Present -> {
                    val current = restored.checkpoint
                    val resetRequired =
                        restored.outcome is RelayV2TerminalOutcome.ResetRequired &&
                            current?.phase == RelayV2TerminalPhase.RESET_REQUIRED
                    if (current?.pendingClose != null) {
                        // A previous actor may have crashed after committing terminal.opened into
                        // pending-close but before the idempotent wire close was accepted. Closing
                        // wins over presentation recovery; never mint a RESUME open for this row.
                        RelayV2TerminalCheckpointReducer.redeliverPendingClose(current)
                    } else if (restored.outcome is RelayV2TerminalOutcome.Restored ||
                        resetRequired
                    ) {
                        checkNotNull(current)
                        val pendingReset = current.pendingOpen?.takeIf { resetRequired }
                        check(
                            pendingReset == null ||
                                pendingReset.mode == RelayV2TerminalOpenMode.RESET
                        )
                        val mode = pendingReset?.mode ?: if (resetRequired) {
                            RelayV2TerminalOpenMode.RESET
                        } else {
                            RelayV2TerminalOpenMode.RESUME
                        }
                        val parserContinuityId = when {
                            pendingReset != null -> pendingReset.parserContinuityId
                            resetRequired -> {
                                // The production caller owns this fresh attempt. Reusing its
                                // bounded openId creates a fresh parser lineage without adding
                                // a second random-ID owner inside the durable transaction.
                                openAttempt.openId
                            }
                            else -> current.parserContinuityId
                        }
                        RelayV2TerminalCheckpointReducer.reduce(
                            current,
                            RelayV2TerminalAction.BeginOpenAttempt(
                                deliveryToken = deliveryToken,
                                requestId = requestId,
                                openAttempt = pendingReset?.openAttempt ?: openAttempt,
                                mode = mode,
                                cols = pendingReset?.cols ?: cols,
                                rows = pendingReset?.rows ?: rows,
                                target = pendingReset?.target ?: current.identity.target(),
                                parserContinuityId = parserContinuityId,
                                resume = pendingReset?.resume ?: RelayV2TerminalOpenResume(
                                    generation = current.identity.generation,
                                    nextOffset = current.parserAppliedNextOffset
                                        .takeUnless { resetRequired },
                                    resumeTokenCredentialReference =
                                        current.identity.resumeTokenCredentialReference,
                                    resumeTokenCredentialFingerprint =
                                        current.identity.resumeTokenCredentialFingerprint,
                                ),
                            ),
                        )
                    } else {
                        restored
                    }
                }
                else -> error("Candidate kind is not resumable")
            }
            persistTerminalReduction(key, reduction)
            RelayV2TerminalResumeClaim(key, reduction)
        }
        claim?.reduction?.rememberRestoreOutcome(claim.key)
        return claim
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

    override suspend fun recoverPostCommitUnknown(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
    ): RelayV2TerminalReduction? = recoverPostCommitUnknown(
        authority,
        key,
        currentParserContinuityId = null,
    )

    override suspend fun recoverPostCommitUnknownWithContinuity(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        currentParserContinuityId: String,
    ): RelayV2TerminalReduction? = recoverPostCommitUnknown(
        authority,
        key,
        currentParserContinuityId,
    )

    override suspend fun correlateDetachedTerminalErrorUnderApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        action: RelayV2TerminalAction.CorrelatedError,
    ): RelayV2DetachedTerminalErrorResult {
        if (authority.profileId != key.profileId ||
            authority.profileActivationGeneration != key.profileActivationGeneration ||
            authority.principalId != key.principalId ||
            authority.clientInstanceId != key.clientInstanceId ||
            authority.hostId != key.hostId ||
            authority.hostEpoch != key.hostEpoch
        ) {
            return RelayV2DetachedTerminalErrorResult.NotOwned
        }
        val result = store.transaction {
            val stored = decodeTerminal(key)
            if (stored is RelayV2TerminalStoredCheckpoint.Invalid) {
                return@transaction RelayV2DetachedTerminalErrorResult.ProtocolViolation(
                    "INVALID_TERMINAL_CHECKPOINT",
                )
            }
            if (stored is RelayV2TerminalStoredCheckpoint.Missing) {
                return@transaction RelayV2DetachedTerminalErrorResult.NotOwned
            }
            val target: RelayV2TerminalOpenTarget
            val deliveryToken: RelayV2TerminalDeliveryToken
            val currentOpenRequestId: String?
            val currentCloseRequestId: String?
            val reduction = when (stored) {
                is RelayV2TerminalStoredCheckpoint.PreOpen -> {
                    target = stored.checkpoint.target
                    deliveryToken = stored.checkpoint.deliveryToken
                    currentOpenRequestId = stored.checkpoint.pendingOpen?.requestId
                    currentCloseRequestId = null
                    RelayV2TerminalCheckpointReducer.reduce(stored.checkpoint, action)
                }
                is RelayV2TerminalStoredCheckpoint.Present -> {
                    target = stored.checkpoint.identity.target()
                    deliveryToken = stored.checkpoint.deliveryToken
                    currentOpenRequestId = stored.checkpoint.pendingOpen?.requestId
                    currentCloseRequestId = stored.checkpoint.pendingClose?.requestId
                    RelayV2TerminalCheckpointReducer.reduce(stored.checkpoint, action)
                }
                is RelayV2TerminalStoredCheckpoint.Invalid,
                RelayV2TerminalStoredCheckpoint.Missing,
                -> error("Handled above")
            }
            if (target != key.toTarget()) {
                return@transaction RelayV2DetachedTerminalErrorResult.ProtocolViolation(
                    "TERMINAL_CHECKPOINT_IDENTITY_MISMATCH",
                )
            }
            if (deliveryToken.actorGeneration != authority.generation) {
                return@transaction RelayV2DetachedTerminalErrorResult.NotOwned
            }
            when (val outcome = reduction.outcome) {
                is RelayV2TerminalOutcome.CorrelatedErrorRejected -> {
                    // Re-persist the reducer result even though correlation currently has no state
                    // delta. This keeps the durable reducer as the sole normalization boundary if
                    // that outcome later gains bookkeeping. In particular, never delete a stream
                    // conflict locally: the Host may still own its backend, lease and close slot.
                    persistTerminalReduction(key, reduction)
                    RelayV2DetachedTerminalErrorResult.Consumed(
                        currentOpenError = action.error.takeIf {
                            action.requestId == currentOpenRequestId
                        },
                        currentCloseError = action.error.takeIf {
                            action.requestId == currentCloseRequestId
                        },
                    )
                }
                is RelayV2TerminalOutcome.ProtocolViolation ->
                    RelayV2DetachedTerminalErrorResult.ProtocolViolation(outcome.code)
                is RelayV2TerminalOutcome.Ignored ->
                    RelayV2DetachedTerminalErrorResult.NotOwned
                else -> RelayV2DetachedTerminalErrorResult.ProtocolViolation(
                    "UNEXPECTED_DETACHED_TERMINAL_ERROR_REDUCTION",
                )
            }
        }
        return result
    }

    override suspend fun correlateDetachedTerminalOpenedUnderApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        action: RelayV2TerminalAction.Opened,
    ): RelayV2DetachedTerminalOpenedResult {
        if (authority.profileId != key.profileId ||
            authority.profileActivationGeneration != key.profileActivationGeneration ||
            authority.principalId != key.principalId ||
            authority.clientInstanceId != key.clientInstanceId ||
            authority.hostId != key.hostId ||
            authority.hostEpoch != key.hostEpoch
        ) {
            return RelayV2DetachedTerminalOpenedResult.NotOwned
        }
        return store.transaction {
            val stored = decodeTerminal(key)
            if (stored is RelayV2TerminalStoredCheckpoint.Invalid) {
                return@transaction RelayV2DetachedTerminalOpenedResult.ProtocolViolation(
                    "INVALID_TERMINAL_CHECKPOINT",
                )
            }
            if (stored is RelayV2TerminalStoredCheckpoint.Missing) {
                return@transaction RelayV2DetachedTerminalOpenedResult.NotOwned
            }
            val target: RelayV2TerminalOpenTarget
            val deliveryToken: RelayV2TerminalDeliveryToken
            val pendingOpen: RelayV2TerminalPendingOpen?
            val reduction = when (stored) {
                is RelayV2TerminalStoredCheckpoint.PreOpen -> {
                    target = stored.checkpoint.target
                    deliveryToken = stored.checkpoint.deliveryToken
                    pendingOpen = stored.checkpoint.pendingOpen
                    RelayV2TerminalCheckpointReducer.reduceDetachedOpened(
                        stored.checkpoint,
                        action,
                    )
                }
                is RelayV2TerminalStoredCheckpoint.Present -> {
                    target = stored.checkpoint.identity.target()
                    deliveryToken = stored.checkpoint.deliveryToken
                    pendingOpen = stored.checkpoint.pendingOpen
                    RelayV2TerminalCheckpointReducer.reduceDetachedOpened(
                        stored.checkpoint,
                        action,
                    )
                }
                is RelayV2TerminalStoredCheckpoint.Invalid,
                RelayV2TerminalStoredCheckpoint.Missing,
                -> error("Handled above")
            }
            if (target != key.toTarget() || action.identity.target() != key.toTarget()) {
                return@transaction RelayV2DetachedTerminalOpenedResult.ProtocolViolation(
                    "TERMINAL_OPENED_IDENTITY_MISMATCH",
                )
            }
            if (deliveryToken.actorGeneration != authority.generation) {
                return@transaction RelayV2DetachedTerminalOpenedResult.NotOwned
            }
            when (val outcome = reduction.outcome) {
                is RelayV2TerminalOutcome.ResetRequired -> if (
                    outcome.reason == RelayV2TerminalResetReason.STREAM_LOST &&
                    pendingOpen != null && action.requestId == pendingOpen.requestId
                ) {
                    val adopted = reduction.checkpoint
                    if (adopted?.phase != RelayV2TerminalPhase.RESET_REQUIRED ||
                        adopted.pendingClose != null || reduction.effects.isNotEmpty()
                    ) {
                        return@transaction RelayV2DetachedTerminalOpenedResult.ProtocolViolation(
                            "INVALID_DETACHED_TERMINAL_ADOPTION",
                        )
                    }
                    persistTerminalReduction(key, reduction)
                    RelayV2DetachedTerminalOpenedResult.Current
                } else {
                    RelayV2DetachedTerminalOpenedResult.ProtocolViolation(
                        "UNEXPECTED_DETACHED_TERMINAL_OPENED_OWNER",
                    )
                }
                is RelayV2TerminalOutcome.Ignored -> if (
                    outcome.reason == RelayV2TerminalIgnoredReason.STALE_OPEN_RESPONSE &&
                    pendingOpen != null &&
                    action.requestId != pendingOpen.requestId &&
                    action.requestId in pendingOpen.issuedRequestIds
                ) {
                    RelayV2DetachedTerminalOpenedResult.IssuedOld
                } else {
                    RelayV2DetachedTerminalOpenedResult.NotOwned
                }
                is RelayV2TerminalOutcome.ProtocolViolation ->
                    RelayV2DetachedTerminalOpenedResult.ProtocolViolation(outcome.code)
                else -> RelayV2DetachedTerminalOpenedResult.ProtocolViolation(
                    "INVALID_DETACHED_TERMINAL_OPENED",
                )
            }
        }
    }

    override suspend fun adoptDetachedTerminalOpenedForCloseUnderApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        action: RelayV2TerminalAction.Opened,
        pendingClose: RelayV2TerminalPendingClose,
    ): RelayV2TerminalReduction? {
        if (authority.profileId != key.profileId ||
            authority.profileActivationGeneration != key.profileActivationGeneration ||
            authority.principalId != key.principalId ||
            authority.clientInstanceId != key.clientInstanceId ||
            authority.hostId != key.hostId ||
            authority.hostEpoch != key.hostEpoch
        ) return null
        val reduction = store.transaction {
            val stored = decodeTerminal(key)
            val reduction = when (stored) {
                is RelayV2TerminalStoredCheckpoint.PreOpen -> {
                    val checkpoint = stored.checkpoint
                    if (checkpoint.target != key.toTarget() ||
                        action.identity.target() != key.toTarget() ||
                        checkpoint.deliveryToken.actorGeneration != authority.generation ||
                        checkpoint.pendingClose != pendingClose
                    ) return@transaction null
                    RelayV2TerminalCheckpointReducer.reduceDetachedOpened(
                        checkpoint = checkpoint,
                        action = action,
                        pendingClose = pendingClose,
                    )
                }
                is RelayV2TerminalStoredCheckpoint.Present -> {
                    val checkpoint = stored.checkpoint
                    if (checkpoint.identity.target() != key.toTarget() ||
                        action.identity.target() != key.toTarget() ||
                        checkpoint.deliveryToken.actorGeneration != authority.generation ||
                        checkpoint.pendingOpen == null ||
                        checkpoint.pendingCloseWhenOpened != pendingClose
                    ) return@transaction null
                    RelayV2TerminalCheckpointReducer.reduceDetachedOpened(
                        checkpoint = checkpoint,
                        action = action,
                    )
                }
                RelayV2TerminalStoredCheckpoint.Missing,
                is RelayV2TerminalStoredCheckpoint.Invalid,
                -> return@transaction null
            }
            reduction.takeIf { result ->
                result.outcome == RelayV2TerminalOutcome.Applied &&
                    result.checkpoint?.pendingClose == pendingClose &&
                    result.checkpoint.pendingCloseWhenOpened == null &&
                    result.effects.singleOrNull() is RelayV2TerminalEffect.SendClose
            }?.also { persistTerminalReduction(key, it) }
        }
        reduction?.rememberReducedKey(key)
        return reduction
    }

    override suspend fun consumeDetachedTerminalClosedUnderApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        action: RelayV2TerminalAction.Closed,
    ): RelayV2TerminalReduction? {
        if (!authorityOwnsKey(authority, key)) return null
        val reduction = store.transaction {
            val stored = decodeTerminal(key) as? RelayV2TerminalStoredCheckpoint.Present
                ?: return@transaction null
            val checkpoint = stored.checkpoint
            if (checkpoint.identity.target() != key.toTarget() ||
                checkpoint.deliveryToken.actorGeneration != authority.generation
            ) return@transaction null
            RelayV2TerminalCheckpointReducer.reduceDetachedClosed(
                checkpoint,
                action,
            ).also { result ->
                if (result.outcome == RelayV2TerminalOutcome.ClosedFinalized) {
                    persistTerminalReduction(key, result)
                }
            }
        }
        if (reduction?.outcome == RelayV2TerminalOutcome.ClosedFinalized) {
            reduction.rememberReducedKey(key)
        }
        return reduction
    }

    override suspend fun consumeRendererFreeTerminalOutputUnderApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        action: RelayV2TerminalAction.Output,
    ): RelayV2TerminalReduction? {
        if (!authorityOwnsKey(authority, key)) return null
        val reduction = store.transaction {
            val stored = decodeTerminal(key) as? RelayV2TerminalStoredCheckpoint.Present
                ?: return@transaction null
            val checkpoint = stored.checkpoint
            if (checkpoint.identity.target() != key.toTarget() ||
                checkpoint.deliveryToken.actorGeneration != authority.generation
            ) return@transaction null
            RelayV2TerminalCheckpointReducer.discardRendererFreeOutput(
                checkpoint,
                action,
            ).also { result ->
                if (result.outcome == RelayV2TerminalOutcome.Applied) {
                    persistTerminalReduction(key, result)
                }
            }
        }
        if (reduction?.outcome == RelayV2TerminalOutcome.Applied) {
            reduction.rememberReducedKey(key)
        }
        return reduction
    }

    override suspend fun consumeRendererFreeTerminalResetUnderApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        action: RelayV2TerminalAction,
    ): RelayV2TerminalReduction? {
        if (!authorityOwnsKey(authority, key) ||
            action !is RelayV2TerminalAction.CorrelatedResetRequired &&
            action !is RelayV2TerminalAction.AsyncResetRequired
        ) return null
        val reduction = store.transaction {
            val stored = decodeTerminal(key) as? RelayV2TerminalStoredCheckpoint.Present
                ?: return@transaction null
            val checkpoint = stored.checkpoint
            if (checkpoint.identity.target() != key.toTarget() ||
                checkpoint.deliveryToken.actorGeneration != authority.generation
            ) return@transaction null
            RelayV2TerminalCheckpointReducer.reduceRendererFreeReset(
                checkpoint,
                action,
            ).also { result ->
                if (result.outcome is RelayV2TerminalOutcome.ResetRequired ||
                    result.outcome == RelayV2TerminalOutcome.LostFinalized ||
                    result.outcome == RelayV2TerminalOutcome.Applied
                ) {
                    persistTerminalReduction(key, result)
                }
            }
        }
        if (reduction != null &&
            (reduction.outcome is RelayV2TerminalOutcome.ResetRequired ||
                reduction.outcome == RelayV2TerminalOutcome.LostFinalized ||
                reduction.outcome == RelayV2TerminalOutcome.Applied)
        ) {
            reduction.rememberReducedKey(key)
        }
        return reduction
    }

    override suspend fun claimTerminalCloseUnderApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        pendingClose: RelayV2TerminalPendingClose,
    ): RelayV2TerminalResumeClaim? {
        if (!authorityOwnsKey(authority, key)) return null
        val claim = store.transaction {
            val stored = decodeTerminal(key) as? RelayV2TerminalStoredCheckpoint.Present
                ?: return@transaction null
            val checkpoint = stored.checkpoint
            if (checkpoint.identity.target() != key.toTarget() ||
                checkpoint.closed != null ||
                checkpoint.deliveryToken.authorityGeneration == Long.MAX_VALUE
            ) return@transaction null
            val rebound = if (checkpoint.deliveryToken.actorGeneration == authority.generation) {
                checkpoint
            } else {
                val delivery = RelayV2TerminalDeliveryToken(
                    actorGeneration = authority.generation,
                    authorityGeneration = checkpoint.deliveryToken.authorityGeneration + 1,
                    localDispatchToken = 1,
                )
                val reboundReduction = RelayV2TerminalCheckpointReducer.reduce(
                    checkpoint,
                    RelayV2TerminalAction.RebindDelivery(
                        identity = checkpoint.identity,
                        currentDeliveryToken = checkpoint.deliveryToken,
                        newDeliveryToken = delivery,
                        parserContinuityId = checkpoint.parserContinuityId,
                    ),
                )
                reboundReduction.checkpoint?.takeIf {
                    it.deliveryToken == delivery
                } ?: return@transaction null
            }
            val requested = if (rebound.pendingOpen != null ||
                rebound.pendingCloseWhenOpened != null
            ) {
                RelayV2TerminalCheckpointReducer.ensureCloseWhenOpened(
                    rebound,
                    pendingClose,
                ).takeIf { result ->
                    result.outcome == RelayV2TerminalOutcome.Applied &&
                        result.checkpoint?.pendingCloseWhenOpened == pendingClose &&
                        result.effects.none {
                            it is RelayV2TerminalEffect.SendClose ||
                                it is RelayV2TerminalEffect.WriteParser ||
                                it is RelayV2TerminalEffect.ResetParser
                        }
                }
            } else {
                RelayV2TerminalCheckpointReducer.requestDetachedClose(
                    rebound,
                    pendingClose,
                ).takeIf { result ->
                    result.outcome == RelayV2TerminalOutcome.Applied &&
                        result.checkpoint?.pendingClose == pendingClose &&
                        result.effects.filterIsInstance<RelayV2TerminalEffect.SendClose>()
                            .size == 1 &&
                        result.effects.none {
                            it is RelayV2TerminalEffect.WriteParser ||
                                it is RelayV2TerminalEffect.ResetParser
                        }
                }
            } ?: return@transaction null
            persistTerminalReduction(key, requested)
            RelayV2TerminalResumeClaim(key, requested)
        }
        claim?.reduction?.rememberRestoreOutcome(claim.key)
        return claim
    }

    override suspend fun ensureTerminalCloseWhenOpenedUnderApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        pendingClose: RelayV2TerminalPendingClose,
    ): RelayV2TerminalReduction? {
        if (authority.profileId != key.profileId ||
            authority.profileActivationGeneration != key.profileActivationGeneration ||
            authority.principalId != key.principalId ||
            authority.clientInstanceId != key.clientInstanceId ||
            authority.hostId != key.hostId ||
            authority.hostEpoch != key.hostEpoch
        ) return null
        val reduction = store.transaction {
            val stored = decodeTerminal(key)
            val reduction = when (stored) {
                is RelayV2TerminalStoredCheckpoint.PreOpen -> {
                    val checkpoint = stored.checkpoint
                    if (checkpoint.target != key.toTarget() ||
                        checkpoint.deliveryToken.actorGeneration != authority.generation
                    ) return@transaction null
                    RelayV2TerminalCheckpointReducer.ensureCloseWhenOpened(
                        checkpoint = checkpoint,
                        pendingClose = pendingClose,
                    )
                }
                is RelayV2TerminalStoredCheckpoint.Present -> {
                    val checkpoint = stored.checkpoint
                    if (checkpoint.identity.target() != key.toTarget() ||
                        checkpoint.deliveryToken.actorGeneration != authority.generation ||
                        (checkpoint.pendingOpen == null &&
                            checkpoint.pendingCloseWhenOpened == null)
                    ) return@transaction null
                    RelayV2TerminalCheckpointReducer.ensureCloseWhenOpened(
                        checkpoint = checkpoint,
                        pendingClose = pendingClose,
                    )
                }
                RelayV2TerminalStoredCheckpoint.Missing,
                is RelayV2TerminalStoredCheckpoint.Invalid,
                -> return@transaction null
            }
            reduction.takeIf { result ->
                result.outcome == RelayV2TerminalOutcome.Applied &&
                    result.effects.none {
                        it is RelayV2TerminalEffect.SendClose ||
                            it is RelayV2TerminalEffect.WriteParser ||
                            it is RelayV2TerminalEffect.ResetParser
                    } &&
                    (result.preOpenCheckpoint?.pendingClose == pendingClose ||
                        result.checkpoint?.pendingCloseWhenOpened == pendingClose)
            }?.also { persistTerminalReduction(key, it) }
        }
        reduction?.rememberReducedKey(key)
        return reduction
    }

    private suspend fun recoverPostCommitUnknown(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        currentParserContinuityId: String?,
    ): RelayV2TerminalReduction? {
        require(authority.profileId == key.profileId)
        require(authority.profileActivationGeneration == key.profileActivationGeneration)
        require(authority.principalId == key.principalId)
        require(authority.clientInstanceId == key.clientInstanceId)
        require(authority.hostId == key.hostId)
        require(authority.hostEpoch == key.hostEpoch)
        val result = store.transaction {
            val stored = decodeTerminal(key) as? RelayV2TerminalStoredCheckpoint.Present
                ?: return@transaction null
            val checkpoint = stored.checkpoint
            if (checkpoint.identity.target() != key.toTarget() ||
                checkpoint.deliveryToken.actorGeneration != authority.generation
            ) return@transaction null
            val reduction = RelayV2TerminalCheckpointReducer.restore(
                stored = stored,
                expectedIdentity = checkpoint.identity,
                expectedOpenAttempt = checkpoint.openAttempt,
                currentDeliveryToken = checkpoint.deliveryToken,
                currentParserContinuityId = currentParserContinuityId,
                parserOperationProof = null,
            )
            if (reduction.outcome !is RelayV2TerminalOutcome.ResetRequired) {
                return@transaction null
            }
            persistTerminalReduction(key, reduction)
            reduction
        }
        result?.rememberRestoreOutcome(key)
        return result
    }

    private fun authorityOwnsKey(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
    ): Boolean = authority.profileId == key.profileId &&
        authority.profileActivationGeneration == key.profileActivationGeneration &&
        authority.principalId == key.principalId &&
        authority.clientInstanceId == key.clientInstanceId &&
        authority.hostId == key.hostId &&
        authority.hostEpoch == key.hostEpoch

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

    private fun validateEnqueueResult(
        current: RelayV2OutboxState,
        draft: RelayV2OutboxDraft,
        createdAtMillis: Long,
        result: RelayV2OutboxResult.Applied,
    ): RelayV2OutboxEnqueueValidation {
        val plan = result.transaction as? RelayV2OutboxTransactionPlan.MutationSet
            ?: return unknownEnqueueState()
        val mutation = plan.mutations.singleOrNull() as? RelayV2OutboxMutation.Insert
            ?: return unknownEnqueueState()
        val entry = mutation.entry
        if (result.effects.isNotEmpty() ||
            result.state.nextCreationOrder != current.nextCreationOrder + 1 ||
            result.state.entries.size != current.entries.size + 1 ||
            result.state.entry(entry.id) != entry ||
            entry.profileId != draft.profileId ||
            entry.principalId != draft.principalId ||
            entry.hostId != draft.hostId ||
            entry.expectedHostEpoch != draft.expectedHostEpoch ||
            entry.dedupeWindowId != draft.dedupeWindowId ||
            entry.commandId != draft.commandId ||
            entry.scopeId != draft.scopeId ||
            entry.sessionId != draft.sessionId ||
            entry.operation != draft.operation ||
            entry.canonicalRequestArguments.value != draft.arguments ||
            entry.requestFingerprint.schemaVersion != draft.requestFingerprintSchemaVersion ||
            entry.state != RelayV2OutboxStateTag.QUEUED ||
            entry.createdOrder != current.nextCreationOrder ||
            entry.createdAtMillis != createdAtMillis
        ) {
            return unknownEnqueueState()
        }
        return RelayV2OutboxEnqueueValidation.Accepted(entry)
    }

    private fun unknownEnqueueState(): RelayV2OutboxEnqueueValidation =
        RelayV2OutboxEnqueueValidation.Rejected(RelayV2OutboxEnqueueFailure.UNKNOWN_STATE)

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

    private fun RelayV2OutboxRejection.toEnqueueFailure(): RelayV2OutboxEnqueueFailure = when (this) {
        RelayV2OutboxRejection.DUPLICATE_COMMAND ->
            RelayV2OutboxEnqueueFailure.DUPLICATE_COMMAND
        RelayV2OutboxRejection.CAPACITY_EXCEEDED ->
            RelayV2OutboxEnqueueFailure.CAPACITY_EXCEEDED
        else -> RelayV2OutboxEnqueueFailure.UNKNOWN_STATE
    }

    private fun RelayV2StorageException.toEnqueueFailure(): RelayV2OutboxEnqueueFailure =
        when (failure) {
            RelayV2StorageFailure.SCHEMA_INCOMPATIBLE ->
                RelayV2OutboxEnqueueFailure.UNKNOWN_STATE
            RelayV2StorageFailure.MISSING_REQUIRED_FIELD,
            RelayV2StorageFailure.MALFORMED,
            RelayV2StorageFailure.LIMIT_EXCEEDED,
            -> RelayV2OutboxEnqueueFailure.CORRUPT_STATE
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
        return decodeTerminalRow(key, row)
    }

    private fun decodeTerminalRow(
        key: RelayV2TerminalCheckpointKey,
        row: RelayV2PersistedTerminalCheckpoint,
    ): RelayV2TerminalStoredCheckpoint {
        if (row.key != key) {
            return RelayV2TerminalStoredCheckpoint.Invalid(
                RelayV2TerminalRestoreInvalidity.CORRUPT_QUEUE,
            )
        }
        return RelayV2TerminalCheckpointCodec.decode(key, row.kind, row.payload)
    }

    private fun requireResumeSelectorAuthority(
        selector: RelayV2TerminalResumeSessionSelector,
        authority: RelayV2RepositoryEffectAuthority,
    ) {
        require(selector.profileId == authority.profileId)
        require(selector.profileActivationGeneration == authority.profileActivationGeneration)
        require(selector.principalId == authority.principalId)
        require(selector.clientInstanceId == authority.clientInstanceId)
        require(selector.hostId == authority.hostId)
        require(selector.pane >= 0)
    }

    private fun finalizedCheckpointIsPrunable(checkpoint: RelayV2TerminalCheckpoint): Boolean =
        checkpoint.pendingParserDispatchClaim == null &&
            checkpoint.pendingParserEffectHandoff == null &&
            checkpoint.pendingParserEffectActivation == null &&
            checkpoint.parserInFlightCallbackToken == null &&
            checkpoint.parserResetCallbackToken == null

    private companion object {
        const val MAX_TERMINAL_CHECKPOINTS_PER_SESSION = 256
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

private sealed interface RelayV2OutboxEnqueueTransactionResult {
    data class Committed(
        val hostId: String,
        val expectedHostEpoch: String,
        val commandId: String,
        val createdOrder: Long,
    ) : RelayV2OutboxEnqueueTransactionResult

    data class Rejected(
        val failure: RelayV2OutboxEnqueueFailure,
    ) : RelayV2OutboxEnqueueTransactionResult
}

private sealed interface RelayV2OutboxEnqueueValidation {
    data class Accepted(
        val entry: RelayV2OutboxEntry,
    ) : RelayV2OutboxEnqueueValidation

    data class Rejected(
        val failure: RelayV2OutboxEnqueueFailure,
    ) : RelayV2OutboxEnqueueValidation
}
