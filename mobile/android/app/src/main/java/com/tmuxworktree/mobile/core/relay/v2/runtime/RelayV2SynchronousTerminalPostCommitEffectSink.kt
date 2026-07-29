package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalCheckpointKey
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffect
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserCallbackToken
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserEffectActivation
import java.util.ArrayDeque
import java.util.Collections
import java.util.UUID

/**
 * Result of one synchronous effect execution attempt.
 *
 * [COMPLETED] means the exact effect completed before the executor returned.
 * [TRANSFERRED_TO_DURABLE_CALLBACK] means a parser mutation was registered only after its exact
 * callback claim became durable; it does not claim evaluateJavascript/xterm has completed. An
 * attached gate may be settled COMMITTED only after the sink has accepted and retired the current
 * FIFO reservation, so its callback batch cannot overtake the effect that transferred ownership.
 * [REJECTED_WITHOUT_EXECUTION] proves that the executor performed no mutation and retained no
 * ownership for the exact effect.
 */
internal enum class RelayV2TerminalTransferredCallbackSettlement {
    COMMITTED,
    ABORTED,
}

internal fun interface RelayV2TerminalTransferredCallbackGate {
    /** Non-blocking and one-shot; false means this gate was already settled. */
    fun settle(settlement: RelayV2TerminalTransferredCallbackSettlement): Boolean
}

internal fun settleTransferredCallbackGates(
    gates: List<RelayV2TerminalTransferredCallbackGate>,
    settlement: RelayV2TerminalTransferredCallbackSettlement,
): Boolean {
    var allSettled = true
    gates.forEach { gate ->
        val settled = try {
            gate.settle(settlement)
        } catch (_: Throwable) {
            false
        }
        if (!settled) allSettled = false
    }
    return allSettled
}

internal class RelayV2TerminalSynchronousEffectExecutionReceipt private constructor(
    internal val disposition: Disposition,
    internal val transferredCallbackGate: RelayV2TerminalTransferredCallbackGate?,
) {
    internal enum class Disposition {
        COMPLETED,
        TRANSFERRED_TO_DURABLE_CALLBACK,
        REJECTED_WITHOUT_EXECUTION,
    }

    companion object {
        val COMPLETED = RelayV2TerminalSynchronousEffectExecutionReceipt(
            Disposition.COMPLETED,
            transferredCallbackGate = null,
        )
        val TRANSFERRED_TO_DURABLE_CALLBACK =
            RelayV2TerminalSynchronousEffectExecutionReceipt(
                Disposition.TRANSFERRED_TO_DURABLE_CALLBACK,
                transferredCallbackGate = null,
            )
        val REJECTED_WITHOUT_EXECUTION = RelayV2TerminalSynchronousEffectExecutionReceipt(
            Disposition.REJECTED_WITHOUT_EXECUTION,
            transferredCallbackGate = null,
        )

        fun transferredToDurableCallback(
            gate: RelayV2TerminalTransferredCallbackGate?,
        ): RelayV2TerminalSynchronousEffectExecutionReceipt =
            if (gate == null) {
                TRANSFERRED_TO_DURABLE_CALLBACK
            } else {
                RelayV2TerminalSynchronousEffectExecutionReceipt(
                    Disposition.TRANSFERRED_TO_DURABLE_CALLBACK,
                    gate,
                )
            }
    }
}

/** Immutable context supplied for exactly one synchronous effect execution. */
internal data class RelayV2TerminalSynchronousEffectExecution(
    val authority: RelayV2RepositoryEffectAuthority,
    val key: RelayV2TerminalCheckpointKey,
    val callbackToken: RelayV2TerminalParserCallbackToken,
    val effectIndex: Int,
    val effectCount: Int,
    val effect: RelayV2TerminalEffect,
)

/**
 * Narrow synchronous platform/composition boundary.
 *
 * Implementations must finish the exact effect before returning [COMPLETED]. The transfer receipt
 * is reserved for the existing durable parser claim plus exact native callback owner; a plain
 * in-memory asynchronous queue cannot return either accepted receipt.
 */
internal fun interface RelayV2TerminalSynchronousEffectExecutor {
    fun execute(
        execution: RelayV2TerminalSynchronousEffectExecution,
    ): RelayV2TerminalSynchronousEffectExecutionReceipt
}

/**
 * Bounded, synchronous implementation of [RelayV2TerminalPostCommitEffectSink].
 *
 * Reservations own a private exact record and immutable batch snapshot. Activation never runs the
 * executor under the owner monitor. Only the FIFO head may execute; a later activation is rejected
 * with zero execution instead of waiting or overtaking an inactive/activating predecessor. Once
 * any effect completed, every later rejection or throw is UNKNOWN and is never retried.
 *
 * Teardown permanently fences the exact authority/key pair for this sink instance. Fence storage
 * is bounded; exhausting it permanently closes the whole sink, which is a stronger fail-closed
 * state and never re-admits a previously fenced pair.
 */
internal class RelayV2SynchronousTerminalPostCommitEffectSink(
    private val executor: RelayV2TerminalSynchronousEffectExecutor,
    private val reservationCapacity: Int = DEFAULT_RESERVATION_CAPACITY,
    private val fencedAuthorityCapacity: Int = DEFAULT_FENCED_AUTHORITY_CAPACITY,
) : RelayV2TerminalPostCommitEffectSink {
    private data class AuthorityKey(
        val authority: RelayV2RepositoryEffectAuthority,
        val key: RelayV2TerminalCheckpointKey,
    )

    private enum class ReservationState {
        INACTIVE,
        ACTIVATING,
        ACCEPTED,
        REJECTED,
        UNKNOWN,
        ABORTED,
        TORN_DOWN,
    }

    private class ReservationRecord(
        val owner: AuthorityKey,
        val identity: RelayV2TerminalPostCommitEffectReservationIdentity,
        val batch: RelayV2TerminalPostCommitEffectBatch,
        val privateToken: Any,
        var state: ReservationState = ReservationState.INACTIVE,
        var teardownRequested: Boolean = false,
        val transferredCallbackGates: MutableList<RelayV2TerminalTransferredCallbackGate> =
            mutableListOf(),
    )

    private inner class Reservation(
        private val record: ReservationRecord,
        private val privateToken: Any,
    ) : RelayV2TerminalPostCommitEffectReservation {
        override val identity: RelayV2TerminalPostCommitEffectReservationIdentity
            get() = record.identity

        override suspend fun activate(): RelayV2TerminalPostCommitEffectActivationReceipt =
            activate(record, privateToken)
    }

    private val monitor = Any()
    private val fifo = ArrayDeque<ReservationRecord>()
    private val reservationsById = mutableMapOf<String, ReservationRecord>()
    private val fencedAuthorities = linkedSetOf<AuthorityKey>()
    private var globallyClosed = false

    init {
        require(reservationCapacity in 1..MAX_RESERVATION_CAPACITY)
        require(fencedAuthorityCapacity in 1..MAX_FENCED_AUTHORITY_CAPACITY)
    }

    override suspend fun reserve(
        reservationId: String,
        batch: RelayV2TerminalPostCommitEffectBatch,
    ): RelayV2TerminalPostCommitEffectReservationResult {
        var gatesToAbort = emptyList<RelayV2TerminalTransferredCallbackGate>()
        try {
            return synchronized(monitor) {
                if (!validReservationId(reservationId) || globallyClosed) {
                    return@synchronized RelayV2TerminalPostCommitEffectReservationResult.Rejected
                }
                val owner = AuthorityKey(batch.authority, batch.key)
                if (owner in fencedAuthorities || fifo.size >= reservationCapacity) {
                    return@synchronized RelayV2TerminalPostCommitEffectReservationResult.Rejected
                }
                if (reservationId in reservationsById) {
                    gatesToAbort = closeAllLocked()
                    throw IllegalStateException(
                        "Terminal post-commit reservation identity was reused",
                    )
                }

                val immutableBatch = batch.copy(
                    effects = Collections.unmodifiableList(ArrayList(batch.effects)),
                )
                // The fingerprint is an opaque capability name. Exact batch binding comes from
                // the private record/token below, not from a second terminal-effect serializer.
                val identity = RelayV2TerminalPostCommitEffectReservationIdentity(
                    reservationId = reservationId,
                    batchFingerprint = "terminal-post-commit-${UUID.randomUUID()}",
                )
                val privateToken = Any()
                val record = ReservationRecord(owner, identity, immutableBatch, privateToken)
                val reservation = Reservation(record, privateToken)
                fifo.addLast(record)
                reservationsById[reservationId] = record
                RelayV2TerminalPostCommitEffectReservationResult.Reserved(identity, reservation)
            }
        } finally {
            settleTransferredCallbackGates(
                gatesToAbort,
                RelayV2TerminalTransferredCallbackSettlement.ABORTED,
            )
        }
    }

    override suspend fun abort(reservationId: String) {
        synchronized(monitor) {
            val record = reservationsById[reservationId] ?: return
            if (record.state != ReservationState.INACTIVE) return
            retireLocked(record, ReservationState.ABORTED)
        }
    }

    override suspend fun teardownAuthority(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
    ) {
        val gatesToAbort = synchronized(monitor) {
            if (globallyClosed) return@synchronized emptyList()
            val owner = AuthorityKey(authority, key)
            if (owner !in fencedAuthorities &&
                fencedAuthorities.size >= fencedAuthorityCapacity
            ) {
                return@synchronized closeAllLocked()
            }
            fencedAuthorities += owner
            val gates = mutableListOf<RelayV2TerminalTransferredCallbackGate>()
            val iterator = fifo.iterator()
            while (iterator.hasNext()) {
                val record = iterator.next()
                if (record.owner != owner) continue
                gates += takeTransferredCallbackGatesLocked(record)
                when (record.state) {
                    ReservationState.INACTIVE -> {
                        record.state = ReservationState.TORN_DOWN
                        reservationsById.remove(record.identity.reservationId, record)
                        iterator.remove()
                    }
                    ReservationState.ACTIVATING -> record.teardownRequested = true
                    ReservationState.ACCEPTED,
                    ReservationState.REJECTED,
                    ReservationState.UNKNOWN,
                    ReservationState.ABORTED,
                    ReservationState.TORN_DOWN,
                    -> Unit
                }
            }
            gates
        }
        settleTransferredCallbackGates(
            gatesToAbort,
            RelayV2TerminalTransferredCallbackSettlement.ABORTED,
        )
    }

    override suspend fun acknowledgeCheckpointFinalized(
        key: RelayV2TerminalCheckpointKey,
        activation: RelayV2TerminalParserEffectActivation,
    ) = Unit

    private suspend fun activate(
        record: ReservationRecord,
        privateToken: Any,
    ): RelayV2TerminalPostCommitEffectActivationReceipt {
        val admitted = synchronized(monitor) {
            if (record.privateToken !== privateToken ||
                reservationsById[record.identity.reservationId] !== record ||
                record.state != ReservationState.INACTIVE
            ) {
                return@synchronized false
            }
            if (globallyClosed || record.owner in fencedAuthorities) {
                retireLocked(record, ReservationState.TORN_DOWN)
                return@synchronized false
            }
            if (fifo.peekFirst() !== record) {
                retireLocked(record, ReservationState.REJECTED)
                return RelayV2TerminalPostCommitEffectActivationReceipt.REJECTED
            }
            record.state = ReservationState.ACTIVATING
            true
        }
        if (!admitted) return RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN

        var completedEffects = 0
        var receipt = RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED
        record.batch.effects.forEachIndexed { index, effect ->
            if (receipt != RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED) {
                return@forEachIndexed
            }
            if (teardownRequested(record)) {
                receipt = RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN
                return@forEachIndexed
            }
            val executionReceipt = try {
                executor.execute(
                    RelayV2TerminalSynchronousEffectExecution(
                        authority = record.batch.authority,
                        key = record.batch.key,
                        callbackToken = record.batch.callbackToken,
                        effectIndex = index,
                        effectCount = record.batch.effects.size,
                        effect = effect,
                    ),
                )
            } catch (_: Throwable) {
                receipt = RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN
                return@forEachIndexed
            }
            val transferredGate = executionReceipt.transferredCallbackGate
            if (transferredGate != null) {
                val captured = synchronized(monitor) {
                    if (record.state != ReservationState.ACTIVATING ||
                        record.teardownRequested ||
                        globallyClosed ||
                        record.owner in fencedAuthorities
                    ) {
                        false
                    } else {
                        record.transferredCallbackGates += transferredGate
                        true
                    }
                }
                if (!captured) {
                    transferredGate.settle(
                        RelayV2TerminalTransferredCallbackSettlement.ABORTED,
                    )
                    receipt = RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN
                    return@forEachIndexed
                }
            }
            when (executionReceipt.disposition) {
                RelayV2TerminalSynchronousEffectExecutionReceipt.Disposition.COMPLETED,
                RelayV2TerminalSynchronousEffectExecutionReceipt.Disposition
                    .TRANSFERRED_TO_DURABLE_CALLBACK,
                -> {
                    completedEffects += 1
                }
                RelayV2TerminalSynchronousEffectExecutionReceipt.Disposition
                    .REJECTED_WITHOUT_EXECUTION,
                -> {
                    receipt = if (completedEffects == 0) {
                        RelayV2TerminalPostCommitEffectActivationReceipt.REJECTED
                    } else {
                        RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN
                    }
                }
            }
        }

        val (finalReceipt, transferredGates) = synchronized(monitor) {
            val finalReceipt = if (record.teardownRequested ||
                globallyClosed ||
                record.owner in fencedAuthorities
            ) {
                RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN
            } else {
                receipt
            }
            val transferredGates = takeTransferredCallbackGatesLocked(record)
            retireLocked(
                record,
                when (finalReceipt) {
                    RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED ->
                        ReservationState.ACCEPTED
                    RelayV2TerminalPostCommitEffectActivationReceipt.REJECTED ->
                        ReservationState.REJECTED
                    RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN ->
                        ReservationState.UNKNOWN
                },
            )
            finalReceipt to transferredGates
        }
        val gatesSettled = settleTransferredCallbackGates(
            transferredGates,
            if (finalReceipt == RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED) {
                RelayV2TerminalTransferredCallbackSettlement.COMMITTED
            } else {
                RelayV2TerminalTransferredCallbackSettlement.ABORTED
            },
        )
        if (!gatesSettled &&
            finalReceipt == RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED
        ) {
            teardownAuthority(record.owner.authority, record.owner.key)
            return RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN
        }
        if (finalReceipt != RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED) {
            return finalReceipt
        }
        return finalReceipt
    }

    private fun teardownRequested(record: ReservationRecord): Boolean = synchronized(monitor) {
        record.teardownRequested || globallyClosed || record.owner in fencedAuthorities
    }

    private fun retireLocked(
        record: ReservationRecord,
        state: ReservationState,
    ) {
        record.state = state
        reservationsById.remove(record.identity.reservationId, record)
        fifo.remove(record)
    }

    private fun takeTransferredCallbackGatesLocked(
        record: ReservationRecord,
    ): List<RelayV2TerminalTransferredCallbackGate> {
        if (record.transferredCallbackGates.isEmpty()) return emptyList()
        return record.transferredCallbackGates.toList().also {
            record.transferredCallbackGates.clear()
        }
    }

    private fun closeAllLocked(): List<RelayV2TerminalTransferredCallbackGate> {
        globallyClosed = true
        fencedAuthorities.clear()
        val gates = mutableListOf<RelayV2TerminalTransferredCallbackGate>()
        val iterator = fifo.iterator()
        while (iterator.hasNext()) {
            val record = iterator.next()
            gates += takeTransferredCallbackGatesLocked(record)
            if (record.state == ReservationState.ACTIVATING) {
                record.teardownRequested = true
            } else {
                record.state = ReservationState.TORN_DOWN
                reservationsById.remove(record.identity.reservationId, record)
                iterator.remove()
            }
        }
        return gates
    }

    private fun validReservationId(value: String): Boolean =
        value.isNotBlank() && value.toByteArray(Charsets.UTF_8).size <= MAX_RESERVATION_ID_BYTES

    private companion object {
        const val DEFAULT_RESERVATION_CAPACITY = 32
        const val MAX_RESERVATION_CAPACITY = 256
        const val DEFAULT_FENCED_AUTHORITY_CAPACITY = 1_024
        const val MAX_FENCED_AUTHORITY_CAPACITY = 4_096
        const val MAX_RESERVATION_ID_BYTES = 128
    }
}
