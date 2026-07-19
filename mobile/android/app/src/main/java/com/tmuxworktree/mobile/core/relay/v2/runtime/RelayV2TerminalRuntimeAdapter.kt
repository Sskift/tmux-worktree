package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalCheckpointKey
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalRuntimeAuthority
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalAction
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalControlDispatchAuthorization
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalControlDispatchClaim
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffect
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffectFence
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalIgnoredReason
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOutcome
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserCallbackToken
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserDispatchClaim
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserDispatchAuthorization
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserEffectActivation
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalPhase
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalReduction
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResetReason
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Bounded parser seam. `true` means the exact operation and callback were registered. `false`
 * proves zero parser mutation, no registration, and that the callback will never be invoked.
 * Completion must not run until this method has returned; the adapter independently gates it with
 * a local admission latch. An exception after any parser mutation is an uncertain mutation.
 */
internal interface RelayV2TerminalParserPort {
    suspend fun write(
        callbackToken: RelayV2TerminalParserCallbackToken,
        bytes: ByteArray,
        completion: suspend (applied: Boolean) -> Unit,
    ): Boolean

    suspend fun reset(
        callbackToken: RelayV2TerminalParserCallbackToken,
        completion: suspend (applied: Boolean) -> Unit,
    ): Boolean
}

/**
 * Socket admission runs under the actor apply lease but never inside a Room transaction.
 * `false` must prove that zero bytes and zero transport side effects occurred; only `true` means
 * the exact claim was admitted. Throwing means admission is uncertain and therefore fails closed.
 */
internal interface RelayV2TerminalControlTransportPort {
    fun sendInput(
        effect: RelayV2TerminalEffect.SendInput,
        claim: RelayV2TerminalControlDispatchClaim.Input,
    ): Boolean

    fun sendResize(
        effect: RelayV2TerminalEffect.SendResize,
        claim: RelayV2TerminalControlDispatchClaim.Resize,
    ): Boolean
}

internal data class RelayV2TerminalPostCommitEffectBatch(
    val authority: RelayV2RepositoryEffectAuthority,
    val key: RelayV2TerminalCheckpointKey,
    val callbackToken: RelayV2TerminalParserCallbackToken,
    val effects: List<RelayV2TerminalEffect>,
) {
    init {
        require(effects.isNotEmpty())
        require(effects.size <= MAX_EFFECTS)
    }

    companion object {
        const val MAX_EFFECTS = 16
    }
}

internal data class RelayV2TerminalPostCommitEffectReservationIdentity(
    val reservationId: String,
    /** Opaque sink proof bound to every field of the exact immutable batch passed to reserve. */
    val batchFingerprint: String,
)

/** ACCEPTED is durable ownership, never mere in-memory enqueueing. */
internal enum class RelayV2TerminalPostCommitEffectActivationReceipt {
    ACCEPTED,
    REJECTED,
    UNKNOWN,
}

/**
 * One bounded FIFO reservation. [activate] is one-shot; exact pre-activation abort is owned by the
 * sink and addressed with the adapter-generated reservation id. The reservation is inert before
 * activate. ACCEPTED means every effect was synchronously completed or transferred to a
 * crash-durable/reconstructible owner; an in-memory queue is insufficient. REJECTED proves zero
 * execution and zero ownership and releases its own slot. Throwing is UNKNOWN and must not be
 * retried or followed by abort.
 */
internal interface RelayV2TerminalPostCommitEffectReservation {
    val identity: RelayV2TerminalPostCommitEffectReservationIdentity

    fun activate(): RelayV2TerminalPostCommitEffectActivationReceipt
}

internal sealed interface RelayV2TerminalPostCommitEffectReservationResult {
    data class Reserved(
        val identity: RelayV2TerminalPostCommitEffectReservationIdentity,
        val reservation: RelayV2TerminalPostCommitEffectReservation,
    ) : RelayV2TerminalPostCommitEffectReservationResult

    /** Proves that the supplied reservation id never acquired capacity or a FIFO position. */
    data object Rejected : RelayV2TerminalPostCommitEffectReservationResult
}

/**
 * Synchronously reserves a bounded serial position for the complete immutable batch. Reservations
 * execute strictly in reserve order: a later activated reservation cannot pass an inactive earlier
 * reservation. [RelayV2TerminalPostCommitEffectReservationResult.Reserved] owns only inert
 * capacity until activate; [RelayV2TerminalPostCommitEffectReservationResult.Rejected] proves that
 * the adapter-generated id owns nothing.
 */
internal interface RelayV2TerminalPostCommitEffectSink {
    fun reserve(
        reservationId: String,
        batch: RelayV2TerminalPostCommitEffectBatch,
    ): RelayV2TerminalPostCommitEffectReservationResult

    /** Exact and idempotent; it is valid even when [reserve] threw after partial acquisition. */
    fun abort(reservationId: String)

    /** Rebuilds only this authority's FIFO after ownership became unknown. */
    fun teardownAuthority(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
    )
}

internal enum class RelayV2TerminalFatalInvalidationReason {
    PARSER_EFFECT_ACTIVATION_UNCERTAIN,
    EXTERNAL_SIDE_EFFECT_CANCELLED,
}

/**
 * Returns only after new admission for the exact authority is synchronously withdrawn and an exact
 * disconnect/drain is started. A normal return is the proof of withdrawal; implementations must
 * terminate exceptionally instead of returning an uncertain receipt. The call must not await the
 * caller's current apply lease to drain.
 */
internal interface RelayV2TerminalFatalInvalidationPort {
    suspend fun invalidate(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        reason: RelayV2TerminalFatalInvalidationReason,
    )
}

internal enum class RelayV2TerminalRuntimeRejection {
    AUTHORITY_MISMATCH,
    PARSER_REVOKED,
    PARSER_STALE_AUTHORITY,
    PARSER_PAYLOAD_MISMATCH,
    PARSER_DISPATCH_REJECTED,
    PARSER_ALREADY_CLAIMED,
    PARSER_NOT_DISPATCHABLE,
    CONTROL_REVOKED,
    CONTROL_STALE_AUTHORITY,
    CONTROL_PAYLOAD_MISMATCH,
    CONTROL_NOT_DISPATCHABLE,
    CONTROL_ALREADY_CLAIMED,
    CONTROL_TRANSPORT_REJECTED,
}

internal sealed interface RelayV2TerminalRuntimeApplyResult {
    data class NotOwned(
        val effect: RelayV2TerminalEffect,
    ) : RelayV2TerminalRuntimeApplyResult

    data class ParserDispatched(
        val callbackToken: RelayV2TerminalParserCallbackToken,
    ) : RelayV2TerminalRuntimeApplyResult

    data class ParserFailedClosed(
        val reduction: RelayV2TerminalReduction,
    ) : RelayV2TerminalRuntimeApplyResult

    /** Exact parser claim remains durable and blocks another platform registration. */
    data class ParserSettlementUnknown(
        val claim: RelayV2TerminalParserDispatchClaim,
    ) : RelayV2TerminalRuntimeApplyResult

    data class ControlCommitted(
        val claim: RelayV2TerminalControlDispatchClaim,
        val reduction: RelayV2TerminalReduction,
    ) : RelayV2TerminalRuntimeApplyResult

    data class ControlUncertain(
        val claim: RelayV2TerminalControlDispatchClaim,
        val reduction: RelayV2TerminalReduction,
    ) : RelayV2TerminalRuntimeApplyResult

    /** Claim remains durable; the same delivery/attempt cannot send again. */
    data class ControlSettlementUnknown(
        val claim: RelayV2TerminalControlDispatchClaim,
    ) : RelayV2TerminalRuntimeApplyResult

    data class Rejected(
        val reason: RelayV2TerminalRuntimeRejection,
    ) : RelayV2TerminalRuntimeApplyResult

    data object Stale : RelayV2TerminalRuntimeApplyResult
}

private sealed interface RelayV2TerminalParserAdmission {
    data class Dispatched(
        val claim: RelayV2TerminalParserDispatchClaim,
    ) : RelayV2TerminalParserAdmission

    data class FailedClosed(
        val reduction: RelayV2TerminalReduction,
    ) : RelayV2TerminalParserAdmission

    data class SettlementUnknown(
        val claim: RelayV2TerminalParserDispatchClaim,
    ) : RelayV2TerminalParserAdmission

    data class Rejected(
        val reason: RelayV2TerminalRuntimeRejection,
    ) : RelayV2TerminalParserAdmission

    data object Poisoned : RelayV2TerminalParserAdmission
}

private data class RelayV2TerminalRuntimeAdmissionKey(
    val authority: RelayV2RepositoryEffectAuthority,
    val key: RelayV2TerminalCheckpointKey,
)

private class RelayV2TerminalRuntimeAdmissionPoison(
    var teardownRequired: Boolean,
    var withdrawalCompleted: Boolean = false,
    var withdrawalSucceeded: Boolean = false,
    var teardownClaimed: Boolean = false,
    var teardownSucceeded: Boolean = false,
)

private data class RelayV2TerminalRuntimeCleanupClaim(
    val key: RelayV2TerminalRuntimeAdmissionKey,
    val withdrawalOwner: Boolean,
    val teardownOwner: Boolean,
)

private sealed interface RelayV2TerminalParserHandoffGateResult<out T> {
    data class Entered<T>(val value: T) : RelayV2TerminalParserHandoffGateResult<T>

    data object Poisoned : RelayV2TerminalParserHandoffGateResult<Nothing>

    data class Failed(
        val failure: Exception,
        val cleanup: RelayV2TerminalRuntimeCleanupClaim,
    ) : RelayV2TerminalParserHandoffGateResult<Nothing>
}

private enum class RelayV2TerminalParserLatchState {
    PENDING,
    ACCEPTED,
    MISSED_BEFORE_ACCEPT,
    REJECTED,
    SETTLING,
}

private enum class RelayV2TerminalParserRegistrationAdmission {
    ACCEPTED,
    CALLBACK_MISSED,
}

private enum class RelayV2TerminalParserRejectionAdmission {
    SAFE_FALSE,
    CALLBACK_MISSED,
}

/** Local race gate; only a callback observing ACCEPTED can enter durable settlement. */
private class RelayV2TerminalParserAdmissionLatch {
    private val state = AtomicReference(RelayV2TerminalParserLatchState.PENDING)

    fun acceptRegistration(): RelayV2TerminalParserRegistrationAdmission =
        if (state.compareAndSet(
                RelayV2TerminalParserLatchState.PENDING,
                RelayV2TerminalParserLatchState.ACCEPTED,
            )
        ) {
            RelayV2TerminalParserRegistrationAdmission.ACCEPTED
        } else {
            RelayV2TerminalParserRegistrationAdmission.CALLBACK_MISSED
        }

    fun rejectFalseRegistration(): RelayV2TerminalParserRejectionAdmission {
        while (true) {
            when (val current = state.get()) {
                RelayV2TerminalParserLatchState.PENDING -> if (
                    state.compareAndSet(current, RelayV2TerminalParserLatchState.REJECTED)
                ) {
                    return RelayV2TerminalParserRejectionAdmission.SAFE_FALSE
                }
                RelayV2TerminalParserLatchState.MISSED_BEFORE_ACCEPT ->
                    return RelayV2TerminalParserRejectionAdmission.CALLBACK_MISSED
                RelayV2TerminalParserLatchState.REJECTED,
                RelayV2TerminalParserLatchState.ACCEPTED,
                RelayV2TerminalParserLatchState.SETTLING,
                -> return RelayV2TerminalParserRejectionAdmission.CALLBACK_MISSED
            }
        }
    }

    fun rejectAfterException() {
        state.set(RelayV2TerminalParserLatchState.REJECTED)
    }

    fun tryBeginCallbackSettlement(): Boolean {
        while (true) {
            when (val current = state.get()) {
                RelayV2TerminalParserLatchState.ACCEPTED -> if (
                    state.compareAndSet(current, RelayV2TerminalParserLatchState.SETTLING)
                ) {
                    return true
                }
                RelayV2TerminalParserLatchState.PENDING -> if (
                    state.compareAndSet(
                        current,
                        RelayV2TerminalParserLatchState.MISSED_BEFORE_ACCEPT,
                    )
                ) {
                    return false
                }
                RelayV2TerminalParserLatchState.MISSED_BEFORE_ACCEPT,
                RelayV2TerminalParserLatchState.REJECTED,
                RelayV2TerminalParserLatchState.SETTLING,
                -> return false
            }
        }
    }
}

/**
 * Exact in-process admission poison for every adapter-owned handle and parser callback. Durable
 * claim/H/A ownership remains in the terminal checkpoint. Active users keep a successfully
 * withdrawn poison alive until no already-admitted operation can still upgrade sink teardown.
 */
private class RelayV2TerminalRuntimeAdmissionFence {
    inner class Admission(
        private val admissionKey: RelayV2TerminalRuntimeAdmissionKey,
    ) {
        private var closed = false
        val terminalKey: RelayV2TerminalCheckpointKey get() = admissionKey.key

        fun isOpen(): Boolean = synchronized(monitor) {
            check(!closed)
            admissionKey !in poisoned
        }

        fun poison(teardownRequired: Boolean): RelayV2TerminalRuntimeCleanupClaim =
            synchronized(monitor) {
                check(!closed)
                poisonAndClaimCleanup(admissionKey, teardownRequired)
            }

        fun close() {
            synchronized(monitor) {
                if (closed) return
                closed = true
                val remaining = requireNotNull(activeUsers[admissionKey]) - 1
                if (remaining == 0) activeUsers.remove(admissionKey)
                else activeUsers[admissionKey] = remaining
                clearCompletedPoison(admissionKey)
            }
        }
    }

    private val monitor = Any()
    private val activeUsers = mutableMapOf<RelayV2TerminalRuntimeAdmissionKey, Int>()
    private val poisoned = mutableMapOf<
        RelayV2TerminalRuntimeAdmissionKey,
        RelayV2TerminalRuntimeAdmissionPoison
        >()

    fun tryEnter(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
    ): Admission? = synchronized(monitor) {
        val admissionKey = RelayV2TerminalRuntimeAdmissionKey(authority, key)
        if (admissionKey in poisoned) return@synchronized null
        activeUsers[admissionKey] = (activeUsers[admissionKey] ?: 0) + 1
        Admission(admissionKey)
    }

    fun markWithdrawalCompleted(
        claim: RelayV2TerminalRuntimeCleanupClaim,
        succeeded: Boolean,
    ): RelayV2TerminalRuntimeCleanupClaim = synchronized(monitor) {
        check(claim.withdrawalOwner)
        val poison = requireNotNull(poisoned[claim.key])
        poison.withdrawalCompleted = true
        poison.withdrawalSucceeded = succeeded
        RelayV2TerminalRuntimeCleanupClaim(
            key = claim.key,
            withdrawalOwner = false,
            teardownOwner = claimTeardownIfReady(poison),
        ).also { clearCompletedPoison(claim.key) }
    }

    fun markTeardownSucceeded(claim: RelayV2TerminalRuntimeCleanupClaim) {
        synchronized(monitor) {
            check(claim.teardownOwner)
            val poison = requireNotNull(poisoned[claim.key])
            poison.teardownSucceeded = true
            clearCompletedPoison(claim.key)
        }
    }

    private fun poisonAndClaimCleanup(
        admissionKey: RelayV2TerminalRuntimeAdmissionKey,
        teardownRequired: Boolean,
    ): RelayV2TerminalRuntimeCleanupClaim {
        val existing = poisoned[admissionKey]
        if (existing != null) {
            existing.teardownRequired = existing.teardownRequired || teardownRequired
            return RelayV2TerminalRuntimeCleanupClaim(
                admissionKey,
                withdrawalOwner = false,
                teardownOwner = claimTeardownIfReady(existing),
            )
        }
        poisoned[admissionKey] = RelayV2TerminalRuntimeAdmissionPoison(teardownRequired)
        return RelayV2TerminalRuntimeCleanupClaim(
            admissionKey,
            withdrawalOwner = true,
            teardownOwner = false,
        )
    }

    private fun claimTeardownIfReady(poison: RelayV2TerminalRuntimeAdmissionPoison): Boolean =
        if (poison.withdrawalCompleted &&
            poison.teardownRequired &&
            !poison.teardownClaimed
        ) {
            poison.teardownClaimed = true
            true
        } else {
            false
        }

    private fun clearCompletedPoison(key: RelayV2TerminalRuntimeAdmissionKey) {
        val poison = poisoned[key] ?: return
        if (activeUsers[key] == null &&
            poison.withdrawalSucceeded &&
            (!poison.teardownRequired || poison.teardownSucceeded)
        ) {
            poisoned.remove(key)
        }
    }
}

/** Per-terminal serialization for callbacks admitted concurrently by the actor apply lease. */
private class RelayV2TerminalParserHandoffSerialGate {
    private class Entry(
        val mutex: Mutex = Mutex(),
        var users: Int = 0,
    )

    private val monitor = Any()
    private val entries = mutableMapOf<RelayV2TerminalCheckpointKey, Entry>()

    suspend fun <T> withTerminal(
        admission: RelayV2TerminalRuntimeAdmissionFence.Admission,
        block: suspend (
            poison: (teardownSink: Boolean) -> RelayV2TerminalRuntimeCleanupClaim,
        ) -> T,
    ): RelayV2TerminalParserHandoffGateResult<T> {
        val key = admission.terminalKey
        val entry = synchronized(monitor) {
            entries.getOrPut(key) { Entry() }.also { it.users += 1 }
        }
        return try {
            try {
                entry.mutex.withLock {
                    if (!admission.isOpen()) {
                        return@withLock RelayV2TerminalParserHandoffGateResult.Poisoned
                    }
                    try {
                        RelayV2TerminalParserHandoffGateResult.Entered(
                            block(admission::poison),
                        )
                    } catch (cancelled: CancellationException) {
                        // The exact poison is visible before this holder releases the keyed gate.
                        RelayV2TerminalParserHandoffGateResult.Failed(
                            cancelled,
                            admission.poison(teardownRequired = false),
                        )
                    } catch (failure: Exception) {
                        RelayV2TerminalParserHandoffGateResult.Failed(
                            failure,
                            admission.poison(teardownRequired = false),
                        )
                    }
                }
            } catch (cancelled: CancellationException) {
                // Waiting for the keyed mutex is cancellable. Poison immediately through the
                // independent monitor; do not wait for the current holder to leave first.
                RelayV2TerminalParserHandoffGateResult.Failed(
                    cancelled,
                    admission.poison(teardownRequired = false),
                )
            }
        } finally {
            synchronized(monitor) {
                entry.users -= 1
                if (entry.users == 0) {
                    check(entries[key] === entry)
                    entries.remove(key)
                }
            }
        }
    }
}

private data class RelayV2TerminalPreparedEffectActivation(
    val activation: RelayV2TerminalParserEffectActivation,
    val reservationId: String,
    val reservation: RelayV2TerminalPostCommitEffectReservation,
)

private sealed interface RelayV2TerminalEffectPreparation {
    data class Ready(
        val prepared: RelayV2TerminalPreparedEffectActivation,
    ) : RelayV2TerminalEffectPreparation

    data object SafeNone : RelayV2TerminalEffectPreparation

    data class Invalidate(
        val teardownSink: Boolean,
        val failure: Exception?,
        val cleanup: RelayV2TerminalRuntimeCleanupClaim? = null,
    ) : RelayV2TerminalEffectPreparation
}

private sealed interface RelayV2TerminalParserCallbackPipelineResult {
    data object Complete : RelayV2TerminalParserCallbackPipelineResult

    data class Invalidate(
        val teardownSink: Boolean,
        val failure: Exception? = null,
        val cleanup: RelayV2TerminalRuntimeCleanupClaim? = null,
    ) : RelayV2TerminalParserCallbackPipelineResult
}

private sealed interface RelayV2TerminalControlAdmission {
    data class Completed(
        val result: RelayV2TerminalRuntimeApplyResult,
    ) : RelayV2TerminalControlAdmission

    data class Rejected(
        val reason: RelayV2TerminalRuntimeRejection,
    ) : RelayV2TerminalControlAdmission

    data object Poisoned : RelayV2TerminalControlAdmission
}

/**
 * Default-off adapter between the durable terminal module and platform ports.
 *
 * The reducer grants exact durable parser and control claims before either platform port is called.
 * The adapter retains the actor apply lease across claim, external admission, and exact settlement;
 * the local parser latch additionally prevents an unaccepted callback from reaching durable state.
 * Parser callbacks commit a blocking handoff marker before reserving a FIFO sink position. The
 * exact reservation identity is committed as an activation marker before the inert reservation can
 * activate. ACCEPTED transfers durable ownership; every uncertain path keeps a restore-time marker
 * and withdraws current runtime admission.
 */
internal class RelayV2TerminalRuntimeAdapter(
    private val applyLease: RelayV2RepositoryEffectApplyLeasePort,
    private val terminal: RelayV2TerminalRuntimeAuthority,
    private val parser: RelayV2TerminalParserPort,
    private val control: RelayV2TerminalControlTransportPort,
    private val postCommitEffects: RelayV2TerminalPostCommitEffectSink,
    private val fatalInvalidation: RelayV2TerminalFatalInvalidationPort,
) {
    private val runtimeAdmission = RelayV2TerminalRuntimeAdmissionFence()
    private val parserHandoffSerial = RelayV2TerminalParserHandoffSerialGate()

    suspend fun handle(
        authority: RelayV2RepositoryEffectAuthority,
        effect: RelayV2TerminalEffect,
    ): RelayV2TerminalRuntimeApplyResult = when (effect) {
        is RelayV2TerminalEffect.WriteParser -> handleParser(authority, effect)
        is RelayV2TerminalEffect.ResetParser -> handleParser(authority, effect)
        is RelayV2TerminalEffect.SendInput -> handleControl(authority, effect)
        is RelayV2TerminalEffect.SendResize -> handleControl(authority, effect)
        else -> RelayV2TerminalRuntimeApplyResult.NotOwned(effect)
    }

    private suspend fun handleParser(
        authority: RelayV2RepositoryEffectAuthority,
        effect: RelayV2TerminalEffect,
    ): RelayV2TerminalRuntimeApplyResult {
        val fence = effect.parserFence()
        if (!authority.matches(fence)) {
            return RelayV2TerminalRuntimeApplyResult.Rejected(
                RelayV2TerminalRuntimeRejection.AUTHORITY_MISMATCH,
            )
        }
        val key = RelayV2TerminalCheckpointKey.from(fence.identity.target())
        val admission = runtimeAdmission.tryEnter(authority, key)
            ?: return RelayV2TerminalRuntimeApplyResult.Stale
        try {
            var parserSideEffectMayHaveBeenReached = false
            var cancellationCleanup: RelayV2TerminalRuntimeCleanupClaim? = null
            val leased = try {
                applyLease.withEffectApplyLease(authority) {
                    if (!admission.isOpen()) {
                        return@withEffectApplyLease RelayV2TerminalParserAdmission.Poisoned
                    }
                val claimed = try {
                    terminal.reduceTerminalUnderApplyLease(
                        key,
                        RelayV2TerminalAction.ClaimParserDispatch(effect),
                    )
                } catch (cancelled: CancellationException) {
                    cancellationCleanup = admission.poison(teardownRequired = false)
                    throw cancelled
                }
                val claim = when (val outcome = claimed.outcome) {
                    is RelayV2TerminalOutcome.ParserDispatchClaimed -> outcome.claim
                    is RelayV2TerminalOutcome.ParserDispatchDenied -> {
                        return@withEffectApplyLease RelayV2TerminalParserAdmission.Rejected(
                            outcome.authorization.runtimeRejection(),
                        )
                    }
                    is RelayV2TerminalOutcome.ResetRequired -> {
                        return@withEffectApplyLease RelayV2TerminalParserAdmission.Rejected(
                            RelayV2TerminalRuntimeRejection.PARSER_REVOKED,
                        )
                    }
                    is RelayV2TerminalOutcome.Ignored -> {
                        val reason = if (
                            outcome.reason == RelayV2TerminalIgnoredReason.DUPLICATE_PARSER_DISPATCH
                        ) {
                            RelayV2TerminalRuntimeRejection.PARSER_ALREADY_CLAIMED
                        } else {
                            RelayV2TerminalRuntimeRejection.PARSER_NOT_DISPATCHABLE
                        }
                        return@withEffectApplyLease RelayV2TerminalParserAdmission.Rejected(reason)
                    }
                    else -> return@withEffectApplyLease RelayV2TerminalParserAdmission.Rejected(
                        RelayV2TerminalRuntimeRejection.PARSER_NOT_DISPATCHABLE,
                    )
                }
                if (!admission.isOpen()) {
                    return@withEffectApplyLease RelayV2TerminalParserAdmission.Poisoned
                }
                val token = claim.callbackToken
                val latch = RelayV2TerminalParserAdmissionLatch()
                val completion: suspend (Boolean) -> Unit = { applied ->
                    if (latch.tryBeginCallbackSettlement()) {
                        applyParserCallback(authority, key, claim, applied)
                    }
                }
                parserSideEffectMayHaveBeenReached = true
                val accepted = try {
                    when (effect) {
                        is RelayV2TerminalEffect.WriteParser -> parser.write(
                            token,
                            effect.bytes.copyBytes(),
                            completion,
                        )
                        is RelayV2TerminalEffect.ResetParser -> parser.reset(token, completion)
                        else -> error("Not a parser effect")
                    }
                } catch (cancelled: CancellationException) {
                    latch.rejectAfterException()
                    cancellationCleanup = admission.poison(teardownRequired = false)
                    throw cancelled
                } catch (_: Exception) {
                    latch.rejectAfterException()
                    if (!admission.isOpen()) {
                        return@withEffectApplyLease RelayV2TerminalParserAdmission.Poisoned
                    }
                    return@withEffectApplyLease try {
                        val failed = terminal.reduceTerminalUnderApplyLease(
                            key,
                            RelayV2TerminalAction.ParserFailed(claim),
                        )
                        RelayV2TerminalParserAdmission.FailedClosed(failed)
                    } catch (cancelled: CancellationException) {
                        cancellationCleanup = admission.poison(teardownRequired = false)
                        throw cancelled
                    } catch (_: Exception) {
                        RelayV2TerminalParserAdmission.SettlementUnknown(claim)
                    }
                }
                if (!accepted) {
                    // A conforming false proves the parser was untouched; later cancellation in
                    // exact claim release does not need authority teardown.
                    parserSideEffectMayHaveBeenReached = false
                    if (latch.rejectFalseRegistration() !=
                        RelayV2TerminalParserRejectionAdmission.SAFE_FALSE
                    ) {
                        return@withEffectApplyLease RelayV2TerminalParserAdmission.SettlementUnknown(
                            claim,
                        )
                    }
                    if (!admission.isOpen()) {
                        return@withEffectApplyLease RelayV2TerminalParserAdmission.Poisoned
                    }
                    return@withEffectApplyLease try {
                        terminal.reduceTerminalUnderApplyLease(
                            key,
                            RelayV2TerminalAction.ReleaseParserDispatch(claim),
                        )
                        RelayV2TerminalParserAdmission.Rejected(
                            RelayV2TerminalRuntimeRejection.PARSER_DISPATCH_REJECTED,
                        )
                    } catch (cancelled: CancellationException) {
                        cancellationCleanup = admission.poison(teardownRequired = false)
                        throw cancelled
                    } catch (_: Exception) {
                        RelayV2TerminalParserAdmission.SettlementUnknown(claim)
                    }
                }
                if (latch.acceptRegistration() ==
                    RelayV2TerminalParserRegistrationAdmission.ACCEPTED
                ) {
                    RelayV2TerminalParserAdmission.Dispatched(claim)
                } else {
                    RelayV2TerminalParserAdmission.SettlementUnknown(claim)
                }
                }
            } catch (cancelled: CancellationException) {
                val cleanup = cancellationCleanup ?: if (parserSideEffectMayHaveBeenReached) {
                    admission.poison(teardownRequired = false)
                } else {
                    null
                }
                if (cleanup != null) {
                    settleRuntimePoison(
                        cleanup,
                        cancelled,
                        RelayV2TerminalFatalInvalidationReason.EXTERNAL_SIDE_EFFECT_CANCELLED,
                    )
                }
                throw cancelled
            }
            return when (leased) {
                is RelayV2EffectApplyResult.Applied -> when (val result = leased.value) {
                    is RelayV2TerminalParserAdmission.Dispatched ->
                        RelayV2TerminalRuntimeApplyResult.ParserDispatched(
                            result.claim.callbackToken,
                        )
                    is RelayV2TerminalParserAdmission.FailedClosed ->
                        RelayV2TerminalRuntimeApplyResult.ParserFailedClosed(result.reduction)
                    is RelayV2TerminalParserAdmission.SettlementUnknown ->
                        RelayV2TerminalRuntimeApplyResult.ParserSettlementUnknown(result.claim)
                    is RelayV2TerminalParserAdmission.Rejected ->
                        RelayV2TerminalRuntimeApplyResult.Rejected(result.reason)
                    RelayV2TerminalParserAdmission.Poisoned ->
                        RelayV2TerminalRuntimeApplyResult.Stale
                }
                RelayV2EffectApplyResult.Stale -> RelayV2TerminalRuntimeApplyResult.Stale
            }
        } finally {
            admission.close()
        }
    }

    private suspend fun applyParserCallback(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        claim: RelayV2TerminalParserDispatchClaim,
        applied: Boolean,
    ) {
        val admission = runtimeAdmission.tryEnter(authority, key) ?: return
        try {
            var pipelineCleanup: RelayV2TerminalRuntimeCleanupClaim? = null
            val gated = parserHandoffSerial.withTerminal(admission) { poison ->
                val pipeline = when (val prepared = when (
                    val leased = applyLease.withEffectApplyLease(authority) {
                        if (admission.isOpen()) {
                            val result = try {
                                prepareParserEffectActivation(
                                    admission,
                                    authority,
                                    key,
                                    claim,
                                    applied,
                                )
                            } catch (cancelled: CancellationException) {
                                RelayV2TerminalEffectPreparation.Invalidate(
                                    teardownSink = false,
                                    failure = cancelled,
                                )
                            } catch (failure: Exception) {
                                RelayV2TerminalEffectPreparation.Invalidate(
                                    teardownSink = false,
                                    failure = failure,
                                )
                            }
                            if (result is RelayV2TerminalEffectPreparation.Invalidate &&
                                result.cleanup == null
                            ) {
                                result.copy(
                                    cleanup = admission.poison(result.teardownSink),
                                )
                            } else {
                                result
                            }
                        } else {
                            RelayV2TerminalEffectPreparation.SafeNone
                        }
                    }
                ) {
                    is RelayV2EffectApplyResult.Applied -> leased.value
                    RelayV2EffectApplyResult.Stale ->
                        RelayV2TerminalEffectPreparation.SafeNone
                }) {
                    RelayV2TerminalEffectPreparation.SafeNone ->
                        RelayV2TerminalParserCallbackPipelineResult.Complete
                    is RelayV2TerminalEffectPreparation.Invalidate ->
                        RelayV2TerminalParserCallbackPipelineResult.Invalidate(
                            prepared.teardownSink,
                            prepared.failure,
                            prepared.cleanup,
                        )
                    is RelayV2TerminalEffectPreparation.Ready ->
                        settleParserEffectActivation(
                            admission,
                            authority,
                            key,
                            prepared.prepared,
                        )
                }
                if (pipeline is RelayV2TerminalParserCallbackPipelineResult.Invalidate) {
                    // Install the exact authority-key fence before this holder unlocks.
                    pipelineCleanup = pipeline.cleanup ?: poison(pipeline.teardownSink)
                }
                pipeline
            }
            val pipeline: RelayV2TerminalParserCallbackPipelineResult
            val cleanup: RelayV2TerminalRuntimeCleanupClaim
            when (gated) {
                is RelayV2TerminalParserHandoffGateResult.Entered -> {
                    pipeline = gated.value
                    if (pipeline !is RelayV2TerminalParserCallbackPipelineResult.Invalidate) {
                        return
                    }
                    cleanup = requireNotNull(pipelineCleanup)
                }
                is RelayV2TerminalParserHandoffGateResult.Failed -> {
                    settleRuntimePoison(
                        gated.cleanup,
                        gated.failure,
                        RelayV2TerminalFatalInvalidationReason
                            .PARSER_EFFECT_ACTIVATION_UNCERTAIN,
                    )
                    return
                }
                RelayV2TerminalParserHandoffGateResult.Poisoned -> return
            }
            pipeline as RelayV2TerminalParserCallbackPipelineResult.Invalidate
            settleRuntimePoison(
                cleanup,
                pipeline.failure,
                RelayV2TerminalFatalInvalidationReason.PARSER_EFFECT_ACTIVATION_UNCERTAIN,
            )
        } finally {
            admission.close()
        }
    }

    private suspend fun prepareParserEffectActivation(
        admission: RelayV2TerminalRuntimeAdmissionFence.Admission,
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        claim: RelayV2TerminalParserDispatchClaim,
        applied: Boolean,
    ): RelayV2TerminalEffectPreparation {
        if (!admission.isOpen()) return RelayV2TerminalEffectPreparation.SafeNone
        val token = claim.callbackToken
        val action = when {
            !applied -> RelayV2TerminalAction.ParserFailed(
                claim,
                handoffEffects = true,
            )
            claim is RelayV2TerminalParserDispatchClaim.Write ->
                RelayV2TerminalAction.ParserApplied(claim)
            claim is RelayV2TerminalParserDispatchClaim.Reset ->
                RelayV2TerminalAction.ParserResetApplied(claim)
            else -> error("Not a parser claim")
        }
        val committed = terminal.reduceTerminalUnderApplyLease(key, action)
        val committedCheckpoint = requireNotNull(committed.checkpoint)
        if (committed.effects.isEmpty()) {
            check(committedCheckpoint.pendingParserDispatchClaim == null)
            check(committedCheckpoint.pendingParserEffectHandoff == null)
            check(committedCheckpoint.pendingParserEffectActivation == null)
            return RelayV2TerminalEffectPreparation.SafeNone
        }
        check(committedCheckpoint.pendingParserEffectHandoff == token) {
            "Parser callback effects committed without an exact H marker"
        }
        check(committedCheckpoint.pendingParserEffectActivation == null)

        if (!admission.isOpen()) {
            // H is the durable recovery owner; the existing poison owner withdraws admission.
            return RelayV2TerminalEffectPreparation.SafeNone
        }

        val batch = RelayV2TerminalPostCommitEffectBatch(
            authority,
            key,
            token,
            committed.effects.toList(),
        )
        val reservationId = UUID.randomUUID().toString()
        val reserveResult = try {
            postCommitEffects.reserve(reservationId, batch)
        } catch (cancelled: CancellationException) {
            val abortFailure = abortReservation(reservationId)
            return RelayV2TerminalEffectPreparation.Invalidate(
                teardownSink = true,
                failure = combineFailuresPreservingCancellation(cancelled, abortFailure),
            )
        } catch (failure: Exception) {
            val abortFailure = abortReservation(reservationId)
            val resetFailure = captureParserEffectReservationFailure(admission, key, token)
            return RelayV2TerminalEffectPreparation.Invalidate(
                teardownSink = true,
                failure = combineFailuresPreservingCancellation(
                    failure,
                    abortFailure,
                    resetFailure,
                ),
            )
        }
        if (reserveResult is RelayV2TerminalPostCommitEffectReservationResult.Rejected) {
            val resetFailure = captureParserEffectReservationFailure(admission, key, token)
            return RelayV2TerminalEffectPreparation.Invalidate(
                teardownSink = false,
                failure = resetFailure,
            )
        }
        val reservedResult =
            reserveResult as RelayV2TerminalPostCommitEffectReservationResult.Reserved
        val reservation = reservedResult.reservation

        if (!admission.isOpen()) {
            val abortFailure = abortReservation(reservationId)
            return RelayV2TerminalEffectPreparation.Invalidate(
                teardownSink = abortFailure != null,
                failure = abortFailure,
            )
        }

        val activation = try {
            val identity = reservedResult.identity
            check(identity.reservationId == reservationId) {
                "Sink returned a reservation for a different id"
            }
            check(reservation.identity == identity) {
                "Sink handle identity or batch fingerprint did not match its result"
            }
            RelayV2TerminalParserEffectActivation(
                callbackToken = token,
                reservationId = reservationId,
                batchFingerprint = identity.batchFingerprint,
            )
        } catch (cancelled: CancellationException) {
            val abortFailure = abortReservation(reservationId)
            return RelayV2TerminalEffectPreparation.Invalidate(
                teardownSink = true,
                failure = combineFailuresPreservingCancellation(cancelled, abortFailure),
            )
        } catch (failure: Exception) {
            val abortFailure = abortReservation(reservationId)
            val resetFailure = captureParserEffectReservationFailure(admission, key, token)
            return RelayV2TerminalEffectPreparation.Invalidate(
                // A mismatched result/handle proves that this authority's sink contract is no
                // longer trustworthy even when exact abort reports success.
                teardownSink = true,
                failure = combineFailuresPreservingCancellation(
                    failure,
                    abortFailure,
                    resetFailure,
                ),
            )
        }

        if (!admission.isOpen()) {
            val abortFailure = abortReservation(reservationId)
            return RelayV2TerminalEffectPreparation.Invalidate(
                teardownSink = abortFailure != null,
                failure = abortFailure,
            )
        }

        val reserved = try {
            terminal.reduceTerminalUnderApplyLease(
                key,
                RelayV2TerminalAction.ParserEffectsReserved(activation),
            )
        } catch (cancelled: CancellationException) {
            val abortFailure = abortReservation(reservationId)
            return RelayV2TerminalEffectPreparation.Invalidate(
                teardownSink = abortFailure != null,
                failure = combineFailuresPreservingCancellation(cancelled, abortFailure),
            )
        } catch (failure: Exception) {
            val abortFailure = abortReservation(reservationId)
            val resetFailure = captureParserEffectReservationFailure(admission, key, token)
            return RelayV2TerminalEffectPreparation.Invalidate(
                teardownSink = abortFailure != null,
                failure = combineFailuresPreservingCancellation(
                    failure,
                    abortFailure,
                    resetFailure,
                ),
            )
        }
        val reservedCheckpoint = reserved.checkpoint
        if (reserved.outcome != RelayV2TerminalOutcome.Applied ||
            reservedCheckpoint == null ||
            reservedCheckpoint.pendingParserEffectActivation != activation ||
            reservedCheckpoint.pendingParserEffectHandoff != null
        ) {
            val abortFailure = abortReservation(reservationId)
            val failure = IllegalStateException("H to A transition was not exact")
            val resetFailure = captureParserEffectReservationFailure(admission, key, token)
            return RelayV2TerminalEffectPreparation.Invalidate(
                teardownSink = abortFailure != null,
                failure = combineFailuresPreservingCancellation(
                    failure,
                    abortFailure,
                    resetFailure,
                ),
            )
        }
        return RelayV2TerminalEffectPreparation.Ready(
            RelayV2TerminalPreparedEffectActivation(
                activation,
                reservationId,
                reservation,
            ),
        )
    }

    /** Returns an invalidation request; the caller executes it after leaving both lease and gate. */
    private suspend fun settleParserEffectActivation(
        admission: RelayV2TerminalRuntimeAdmissionFence.Admission,
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        prepared: RelayV2TerminalPreparedEffectActivation,
    ): RelayV2TerminalParserCallbackPipelineResult {
        if (!admission.isOpen()) {
            val abortFailure = abortReservation(prepared.reservationId)
            return RelayV2TerminalParserCallbackPipelineResult.Invalidate(
                teardownSink = abortFailure != null,
                failure = abortFailure,
            )
        }
        var activationAttempted = false
        var activationAccepted = false
        val leased = try {
            applyLease.withEffectApplyLease(authority) {
                val result = try {
                    if (!admission.isOpen()) {
                        val abortFailure = abortReservation(prepared.reservationId)
                        RelayV2TerminalParserCallbackPipelineResult.Invalidate(
                            teardownSink = abortFailure != null,
                            failure = abortFailure,
                        )
                    } else {
                        val receipt = try {
                            activationAttempted = true
                            prepared.reservation.activate()
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (_: Exception) {
                            RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN
                        }
                        when (receipt) {
                            RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED -> {
                                activationAccepted = true
                                if (!admission.isOpen()) {
                                    RelayV2TerminalParserCallbackPipelineResult.Invalidate(
                                        teardownSink = false,
                                    )
                                } else {
                                    val cleared = try {
                                        terminal.reduceTerminalUnderApplyLease(
                                            key,
                                            RelayV2TerminalAction.ParserEffectsActivated(
                                                prepared.activation,
                                            ),
                                        )
                                    } catch (cancelled: CancellationException) {
                                        throw cancelled
                                    } catch (_: Exception) {
                                        null
                                    }
                                    val clearedCheckpoint = cleared?.checkpoint
                                    val uncertain =
                                        cleared?.outcome != RelayV2TerminalOutcome.Applied ||
                                            clearedCheckpoint == null ||
                                            clearedCheckpoint.pendingParserEffectActivation != null ||
                                            clearedCheckpoint.pendingParserEffectHandoff != null
                                    if (uncertain) {
                                        RelayV2TerminalParserCallbackPipelineResult.Invalidate(
                                            teardownSink = false,
                                        )
                                    } else {
                                        RelayV2TerminalParserCallbackPipelineResult.Complete
                                    }
                                }
                            }
                            RelayV2TerminalPostCommitEffectActivationReceipt.REJECTED,
                            RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN,
                            -> if (!admission.isOpen()) {
                                RelayV2TerminalParserCallbackPipelineResult.Invalidate(
                                    teardownSink = receipt ==
                                        RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN,
                                )
                            } else {
                                failParserEffectActivation(key, prepared.activation)
                                RelayV2TerminalParserCallbackPipelineResult.Invalidate(
                                    teardownSink = receipt ==
                                        RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN,
                                )
                            }
                        }
                    }
                } catch (cancelled: CancellationException) {
                    val abortFailure = if (!activationAttempted) {
                        abortReservation(prepared.reservationId)
                    } else {
                        null
                    }
                    RelayV2TerminalParserCallbackPipelineResult.Invalidate(
                        teardownSink = abortFailure != null ||
                            (activationAttempted && !activationAccepted),
                        failure = combineFailuresPreservingCancellation(
                            cancelled,
                            abortFailure,
                        ),
                    )
                } catch (failure: Exception) {
                    val abortFailure = if (!activationAttempted) {
                        abortReservation(prepared.reservationId)
                    } else {
                        null
                    }
                    RelayV2TerminalParserCallbackPipelineResult.Invalidate(
                        teardownSink = abortFailure != null ||
                            (activationAttempted && !activationAccepted),
                        failure = combineFailuresPreservingCancellation(failure, abortFailure),
                    )
                }
                if (result is RelayV2TerminalParserCallbackPipelineResult.Invalidate &&
                    result.cleanup == null
                ) {
                    result.copy(cleanup = admission.poison(result.teardownSink))
                } else {
                    result
                }
            }
        } catch (cancelled: CancellationException) {
            val abortFailure = if (!activationAttempted) {
                abortReservation(prepared.reservationId)
            } else {
                null
            }
            return RelayV2TerminalParserCallbackPipelineResult.Invalidate(
                teardownSink = abortFailure != null ||
                    (activationAttempted && !activationAccepted),
                failure = combineFailuresPreservingCancellation(cancelled, abortFailure),
                cleanup = admission.poison(
                    abortFailure != null || (activationAttempted && !activationAccepted),
                ),
            )
        } catch (failure: Exception) {
            val abortFailure = if (!activationAttempted) {
                abortReservation(prepared.reservationId)
            } else {
                null
            }
            return RelayV2TerminalParserCallbackPipelineResult.Invalidate(
                teardownSink = abortFailure != null ||
                    (activationAttempted && !activationAccepted),
                failure = combineFailuresPreservingCancellation(failure, abortFailure),
                cleanup = admission.poison(
                    abortFailure != null || (activationAttempted && !activationAccepted),
                ),
            )
        }
        return when (leased) {
            is RelayV2EffectApplyResult.Applied -> leased.value
            RelayV2EffectApplyResult.Stale -> {
                val abortFailure = abortReservation(prepared.reservationId)
                RelayV2TerminalParserCallbackPipelineResult.Invalidate(
                    teardownSink = abortFailure != null,
                    failure = abortFailure,
                )
            }
        }
    }

    private suspend fun settleRuntimePoison(
        initialClaim: RelayV2TerminalRuntimeCleanupClaim,
        primaryFailure: Exception?,
        reason: RelayV2TerminalFatalInvalidationReason,
    ) {
        var claim = initialClaim
        var failure = primaryFailure
        if (claim.withdrawalOwner) {
            val withdrawalFailure = captureNonCancellableCleanupFailure {
                // This only withdraws admission and starts exact teardown; it never awaits drain.
                fatalInvalidation.invalidate(claim.key.authority, claim.key.key, reason)
            }
            failure = combineFailuresPreservingCancellation(failure, withdrawalFailure)
            claim = runtimeAdmission.markWithdrawalCompleted(
                claim,
                succeeded = withdrawalFailure == null,
            )
        }
        if (claim.teardownOwner) {
            val teardownFailure = captureNonCancellableCleanupFailure {
                postCommitEffects.teardownAuthority(claim.key.authority, claim.key.key)
            }
            failure = combineFailuresPreservingCancellation(failure, teardownFailure)
            if (teardownFailure == null) runtimeAdmission.markTeardownSucceeded(claim)
        }
        failure?.let { throw it }
    }

    private suspend fun captureNonCancellableCleanupFailure(
        block: suspend () -> Unit,
    ): Exception? = withContext(NonCancellable) {
        try {
            block()
            null
        } catch (cancelled: CancellationException) {
            cancelled
        } catch (failure: Exception) {
            failure
        }
    }

    private suspend fun failParserEffectReservation(
        key: RelayV2TerminalCheckpointKey,
        callbackToken: RelayV2TerminalParserCallbackToken,
    ) {
        val failed = terminal.reduceTerminalUnderApplyLease(
            key,
            RelayV2TerminalAction.ParserEffectReservationFailed(callbackToken),
        )
        val checkpoint = requireNotNull(failed.checkpoint)
        check(failed.outcome == RelayV2TerminalOutcome.ResetRequired(
            RelayV2TerminalResetReason.STREAM_LOST,
        ))
        check(checkpoint.phase == RelayV2TerminalPhase.RESET_REQUIRED)
        check(checkpoint.resetReason == RelayV2TerminalResetReason.STREAM_LOST)
        check(checkpoint.pendingParserEffectHandoff == callbackToken)
        check(checkpoint.pendingParserEffectActivation == null)
    }

    private suspend fun captureParserEffectReservationFailure(
        admission: RelayV2TerminalRuntimeAdmissionFence.Admission,
        key: RelayV2TerminalCheckpointKey,
        callbackToken: RelayV2TerminalParserCallbackToken,
    ): Exception? = if (!admission.isOpen()) {
        null
    } else try {
        failParserEffectReservation(key, callbackToken)
        null
    } catch (cancelled: CancellationException) {
        cancelled
    } catch (failure: Exception) {
        failure
    }

    private suspend fun failParserEffectActivation(
        key: RelayV2TerminalCheckpointKey,
        activation: RelayV2TerminalParserEffectActivation,
    ) {
        val failed = terminal.reduceTerminalUnderApplyLease(
            key,
            RelayV2TerminalAction.ParserEffectActivationFailed(activation),
        )
        val checkpoint = requireNotNull(failed.checkpoint)
        check(failed.outcome == RelayV2TerminalOutcome.ResetRequired(
            RelayV2TerminalResetReason.STREAM_LOST,
        ))
        check(checkpoint.phase == RelayV2TerminalPhase.RESET_REQUIRED)
        check(checkpoint.resetReason == RelayV2TerminalResetReason.STREAM_LOST)
        check(checkpoint.pendingParserEffectHandoff == null)
        check(checkpoint.pendingParserEffectActivation == activation)
    }

    private fun abortReservation(reservationId: String): Exception? = try {
        postCommitEffects.abort(reservationId)
        null
    } catch (cancelled: CancellationException) {
        cancelled
    } catch (failure: Exception) {
        failure
    }

    private fun combineFailuresPreservingCancellation(
        primary: Exception?,
        vararg additional: Exception?,
    ): Exception? {
        val failures = buildList {
            if (primary != null) add(primary)
            additional.filterNotNull().forEach { add(it) }
        }
        val chosen = failures.firstOrNull { it is CancellationException }
            ?: failures.firstOrNull()
            ?: return null
        failures.filter { it !== chosen }.forEach(chosen::addSuppressed)
        return chosen
    }

    private suspend fun handleControl(
        authority: RelayV2RepositoryEffectAuthority,
        effect: RelayV2TerminalEffect,
    ): RelayV2TerminalRuntimeApplyResult {
        val fence = effect.controlFence()
        if (!authority.matches(fence)) {
            return RelayV2TerminalRuntimeApplyResult.Rejected(
                RelayV2TerminalRuntimeRejection.AUTHORITY_MISMATCH,
            )
        }
        val key = RelayV2TerminalCheckpointKey.from(fence.identity.target())
        val admission = runtimeAdmission.tryEnter(authority, key)
            ?: return RelayV2TerminalRuntimeApplyResult.Stale
        try {
            var transportSideEffectMayHaveBeenReached = false
            var cancellationCleanup: RelayV2TerminalRuntimeCleanupClaim? = null
            val leased = try {
                applyLease.withEffectApplyLease(authority) {
                    if (!admission.isOpen()) {
                        return@withEffectApplyLease RelayV2TerminalControlAdmission.Poisoned
                    }
                val claimed = try {
                    terminal.reduceTerminalUnderApplyLease(
                        key,
                        RelayV2TerminalAction.ClaimControlDispatch(effect),
                    )
                } catch (cancelled: CancellationException) {
                    cancellationCleanup = admission.poison(teardownRequired = false)
                    throw cancelled
                }
                val claim = when (val outcome = claimed.outcome) {
                    is RelayV2TerminalOutcome.ControlDispatchClaimed -> outcome.claim
                    is RelayV2TerminalOutcome.ControlDispatchDenied -> {
                        return@withEffectApplyLease RelayV2TerminalControlAdmission.Rejected(
                            outcome.authorization.runtimeRejection(),
                        )
                    }
                    is RelayV2TerminalOutcome.Ignored -> {
                        val reason = if (
                            outcome.reason ==
                            RelayV2TerminalIgnoredReason.DUPLICATE_CONTROL_DISPATCH
                        ) {
                            RelayV2TerminalRuntimeRejection.CONTROL_ALREADY_CLAIMED
                        } else {
                            RelayV2TerminalRuntimeRejection.CONTROL_NOT_DISPATCHABLE
                        }
                        return@withEffectApplyLease RelayV2TerminalControlAdmission.Rejected(reason)
                    }
                    else -> return@withEffectApplyLease RelayV2TerminalControlAdmission.Rejected(
                        RelayV2TerminalRuntimeRejection.CONTROL_NOT_DISPATCHABLE,
                    )
                }
                    RelayV2TerminalControlAdmission.Completed(
                        try {
                            dispatchClaimedControl(admission, key, effect, claim) { reached ->
                                transportSideEffectMayHaveBeenReached = reached
                            }
                        } catch (cancelled: CancellationException) {
                            cancellationCleanup = admission.poison(
                                teardownRequired = false,
                            )
                            throw cancelled
                        },
                    )
                }
            } catch (cancelled: CancellationException) {
                val cleanup = cancellationCleanup ?: if (
                    transportSideEffectMayHaveBeenReached
                ) {
                    admission.poison(teardownRequired = false)
                } else {
                    null
                }
                if (cleanup != null) {
                    settleRuntimePoison(
                        cleanup,
                        cancelled,
                        RelayV2TerminalFatalInvalidationReason.EXTERNAL_SIDE_EFFECT_CANCELLED,
                    )
                }
                throw cancelled
            }
            return when (leased) {
                is RelayV2EffectApplyResult.Applied -> when (val result = leased.value) {
                    is RelayV2TerminalControlAdmission.Completed -> result.result
                    is RelayV2TerminalControlAdmission.Rejected ->
                        RelayV2TerminalRuntimeApplyResult.Rejected(result.reason)
                    RelayV2TerminalControlAdmission.Poisoned ->
                        RelayV2TerminalRuntimeApplyResult.Stale
                }
                RelayV2EffectApplyResult.Stale -> RelayV2TerminalRuntimeApplyResult.Stale
            }
        } finally {
            admission.close()
        }
    }

    private suspend fun dispatchClaimedControl(
        admission: RelayV2TerminalRuntimeAdmissionFence.Admission,
        key: RelayV2TerminalCheckpointKey,
        effect: RelayV2TerminalEffect,
        claim: RelayV2TerminalControlDispatchClaim,
        externalSideEffectMayHaveBeenReached: (Boolean) -> Unit,
    ): RelayV2TerminalRuntimeApplyResult {
        if (!admission.isOpen()) return RelayV2TerminalRuntimeApplyResult.Stale
        val accepted = try {
            when {
                effect is RelayV2TerminalEffect.SendInput &&
                    claim is RelayV2TerminalControlDispatchClaim.Input -> {
                    externalSideEffectMayHaveBeenReached(true)
                    control.sendInput(effect, claim)
                }
                effect is RelayV2TerminalEffect.SendResize &&
                    claim is RelayV2TerminalControlDispatchClaim.Resize -> {
                    externalSideEffectMayHaveBeenReached(true)
                    control.sendResize(effect, claim)
                }
                else -> return RelayV2TerminalRuntimeApplyResult.ControlSettlementUnknown(claim)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            if (!admission.isOpen()) {
                return RelayV2TerminalRuntimeApplyResult.ControlSettlementUnknown(claim)
            }
            return try {
                val reset = terminal.reduceTerminalUnderApplyLease(
                    key,
                    RelayV2TerminalAction.ControlDispatchUncertain(claim),
                )
                RelayV2TerminalRuntimeApplyResult.ControlUncertain(claim, reset)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                RelayV2TerminalRuntimeApplyResult.ControlSettlementUnknown(claim)
            }
        }
        if (!accepted) {
            externalSideEffectMayHaveBeenReached(false)
            if (!admission.isOpen()) return RelayV2TerminalRuntimeApplyResult.Stale
            return try {
                terminal.reduceTerminalUnderApplyLease(
                    key,
                    RelayV2TerminalAction.ReleaseControlDispatch(claim),
                )
                RelayV2TerminalRuntimeApplyResult.Rejected(
                    RelayV2TerminalRuntimeRejection.CONTROL_TRANSPORT_REJECTED,
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                RelayV2TerminalRuntimeApplyResult.ControlSettlementUnknown(claim)
            }
        }
        if (!admission.isOpen()) {
            return RelayV2TerminalRuntimeApplyResult.ControlSettlementUnknown(claim)
        }
        return try {
            val settled = terminal.reduceTerminalUnderApplyLease(
                key,
                when (claim) {
                    is RelayV2TerminalControlDispatchClaim.Input ->
                        RelayV2TerminalAction.InputSent(claim)
                    is RelayV2TerminalControlDispatchClaim.Resize ->
                        RelayV2TerminalAction.ResizeSent(claim)
                },
            )
            RelayV2TerminalRuntimeApplyResult.ControlCommitted(claim, settled)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            RelayV2TerminalRuntimeApplyResult.ControlSettlementUnknown(claim)
        }
    }

    private fun RelayV2RepositoryEffectAuthority.matches(
        fence: RelayV2TerminalEffectFence,
    ): Boolean = generation == fence.deliveryToken.actorGeneration &&
        profileId == fence.identity.profileId &&
        profileActivationGeneration == fence.identity.profileActivationGeneration &&
        principalId == fence.identity.principalId &&
        clientInstanceId == fence.identity.clientInstanceId &&
        hostId == fence.identity.hostId && hostEpoch == fence.identity.hostEpoch

    private fun RelayV2TerminalEffect.parserFence(): RelayV2TerminalEffectFence = when (this) {
        is RelayV2TerminalEffect.WriteParser -> fence
        is RelayV2TerminalEffect.ResetParser -> fence
        else -> error("Not a parser effect")
    }

    private fun RelayV2TerminalEffect.controlFence(): RelayV2TerminalEffectFence = when (this) {
        is RelayV2TerminalEffect.SendInput -> fence
        is RelayV2TerminalEffect.SendResize -> fence
        else -> error("Not a control effect")
    }

    private fun RelayV2TerminalParserDispatchAuthorization.runtimeRejection() = when (this) {
        RelayV2TerminalParserDispatchAuthorization.AUTHORIZED ->
            error("Authorized parser dispatch is not a rejection")
        RelayV2TerminalParserDispatchAuthorization.REVOKED ->
            RelayV2TerminalRuntimeRejection.PARSER_REVOKED
        RelayV2TerminalParserDispatchAuthorization.STALE_AUTHORITY ->
            RelayV2TerminalRuntimeRejection.PARSER_STALE_AUTHORITY
        RelayV2TerminalParserDispatchAuthorization.PAYLOAD_MISMATCH ->
            RelayV2TerminalRuntimeRejection.PARSER_PAYLOAD_MISMATCH
    }

    private fun RelayV2TerminalControlDispatchAuthorization.runtimeRejection() = when (this) {
        RelayV2TerminalControlDispatchAuthorization.AUTHORIZED ->
            error("Authorized control dispatch is not a rejection")
        RelayV2TerminalControlDispatchAuthorization.REVOKED ->
            RelayV2TerminalRuntimeRejection.CONTROL_REVOKED
        RelayV2TerminalControlDispatchAuthorization.STALE_AUTHORITY ->
            RelayV2TerminalRuntimeRejection.CONTROL_STALE_AUTHORITY
        RelayV2TerminalControlDispatchAuthorization.PAYLOAD_MISMATCH ->
            RelayV2TerminalRuntimeRejection.CONTROL_PAYLOAD_MISMATCH
    }
}
