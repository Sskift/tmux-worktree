package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2EncodedPayload
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalCheckpointKey
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalCheckpointCodec
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitBatchCodec
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitBatchEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitFenceEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitJournalState
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitJournalStore
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitJournalTransaction
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserEffectActivation
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalStoredCheckpoint
import java.util.Collections
import java.util.UUID
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal data class RelayV2TerminalPostCommitRecoveredLineage(
    val authority: RelayV2RepositoryEffectAuthority,
    val key: RelayV2TerminalCheckpointKey,
    val authorityFingerprint: String,
    val disposition: RelayV2TerminalResetDisposition,
)

internal enum class RelayV2TerminalResetDisposition {
    STREAM_LOST,
}

internal data class RelayV2TerminalPostCommitRecoveryReceipt(
    val recoveredLineages: List<RelayV2TerminalPostCommitRecoveredLineage>,
    val globallyClosed: Boolean,
    val connectionGenerationFloor: Long,
)

/**
 * Crash-durable owner for parser post-commit effect batches.
 *
 * The full batch is committed before reserve returns. Each effect is durably RUNNING before the
 * injected synchronous executor can observe it. A process restart never replays either RESERVED
 * or RUNNING work because the exact connection authority cannot survive that restart; recovery
 * permanently fences the lineage and reports STREAM_LOST. Executor cancellation/throw, a partial
 * batch, or an uncertain journal transition has the same no-retry UNKNOWN outcome.
 *
 * Room transactions are suspend boundaries and the synchronous platform executor is dispatched
 * on [executionContext], so this owner never blocks Compose Main with storage or platform work.
 */
internal class RelayV2DurableTerminalPostCommitEffectSink(
    private val journal: RelayV2TerminalPostCommitJournalStore,
    private val executor: RelayV2TerminalSynchronousEffectExecutor,
    private val executionContext: CoroutineContext = Dispatchers.IO,
    private val reservationCapacity: Int = DEFAULT_RESERVATION_CAPACITY,
    private val outcomeCapacity: Int = DEFAULT_OUTCOME_CAPACITY,
    private val fencedAuthorityCapacity: Int = DEFAULT_FENCED_AUTHORITY_CAPACITY,
    private val ownerIncarnation: String = UUID.randomUUID().toString(),
) : RelayV2TerminalPostCommitEffectSink {
    private enum class HandleState {
        INACTIVE,
        ACTIVATING,
        TERMINAL,
    }

    private class HandleRecord(
        val privateToken: Any,
        val identity: RelayV2TerminalPostCommitEffectReservationIdentity,
        val authorityFingerprint: String,
        val batch: RelayV2TerminalPostCommitEffectBatch,
        val replayReceipt: RelayV2TerminalPostCommitEffectActivationReceipt? = null,
        var state: HandleState = HandleState.INACTIVE,
        val transferredCallbackGates: MutableList<RelayV2TerminalTransferredCallbackGate> =
            mutableListOf(),
    )

    private inner class Reservation(
        private val record: HandleRecord,
        private val privateToken: Any,
    ) : RelayV2TerminalPostCommitEffectReservation {
        override val identity: RelayV2TerminalPostCommitEffectReservationIdentity
            get() = record.identity

        override suspend fun activate(): RelayV2TerminalPostCommitEffectActivationReceipt =
            activate(record, privateToken)
    }

    private val mutex = Mutex()
    private val handles = mutableMapOf<String, HandleRecord>()
    private val transferredCallbackGatesPendingAbort =
        mutableListOf<RelayV2TerminalTransferredCallbackGate>()
    private var recovered = false
    private var globallyClosed = false
    private var connectionGenerationFloor = 0L
    private val recoveredLineages = mutableListOf<RelayV2TerminalPostCommitRecoveredLineage>()

    init {
        require(reservationCapacity in 1..MAX_RESERVATION_CAPACITY)
        require(outcomeCapacity in reservationCapacity..MAX_OUTCOME_CAPACITY)
        require(fencedAuthorityCapacity in 1..MAX_FENCED_AUTHORITY_CAPACITY)
        require(ownerIncarnation.isNotBlank())
    }

    suspend fun recover(): RelayV2TerminalPostCommitRecoveryReceipt = try {
        mutex.withLock {
            recoverLocked()
            RelayV2TerminalPostCommitRecoveryReceipt(
                recoveredLineages = recoveredLineages.toList(),
                globallyClosed = globallyClosed,
                connectionGenerationFloor = connectionGenerationFloor,
            )
        }
    } finally {
        settlePendingTransferredCallbackAborts()
    }

    override suspend fun reserve(
        reservationId: String,
        batch: RelayV2TerminalPostCommitEffectBatch,
    ): RelayV2TerminalPostCommitEffectReservationResult {
        if (!validReservationId(reservationId)) {
            return RelayV2TerminalPostCommitEffectReservationResult.Rejected
        }
        requireExactOwner(batch)
        val immutableBatch = batch.copy(
            effects = Collections.unmodifiableList(ArrayList(batch.effects)),
        )
        val encoded = RelayV2TerminalPostCommitBatchCodec.encode(immutableBatch)
        val identity = RelayV2TerminalPostCommitEffectReservationIdentity(
            reservationId = reservationId,
            batchFingerprint = encoded.payload.sha256,
        )
        val token = Any()

        return try {
            mutex.withLock {
                recoverLocked()
                if (globallyClosed) {
                    return@withLock RelayV2TerminalPostCommitEffectReservationResult.Rejected
                }
                if (reservationId in handles) {
                    journal.transaction { closeGloballyLocked() }
                    throw IllegalStateException(
                        "Terminal post-commit reservation identity was reused",
                    )
                }
                val storedAndReceipt = journal.transaction {
                    pruneTerminalOutcomesInTransaction()
                    if (globallyClosed()) return@transaction null
                    val existing = batch(reservationId)
                    if (existing != null) {
                        if (!existing.matchesEncodedBatch(
                                immutableBatch,
                                encoded.payload,
                                encoded.authorityFingerprint,
                            )
                        ) {
                            closeGloballyLocked()
                            throw IllegalStateException(
                                "Terminal post-commit reservation identity conflicted",
                            )
                        }
                        val replay = existing.terminalReceipt()
                        if (replay == null) {
                            closeGloballyLocked()
                            throw IllegalStateException(
                                "Live terminal post-commit reservation identity was reused",
                            )
                        }
                        return@transaction existing to replay
                    }
                    if (fence(encoded.authorityFingerprint) != null ||
                        allBatches().size >= outcomeCapacity ||
                        unsettledBatchCount() >= reservationCapacity
                    ) {
                        return@transaction null
                    }
                    insertBatch(
                        entity(
                            reservationId,
                            immutableBatch,
                            encoded.payload,
                            encoded.authorityFingerprint,
                        ),
                    ) to null
                } ?: return@withLock RelayV2TerminalPostCommitEffectReservationResult.Rejected
                check(storedAndReceipt.first.batchFingerprint == identity.batchFingerprint)
                val record = HandleRecord(
                    privateToken = token,
                    identity = identity,
                    authorityFingerprint = encoded.authorityFingerprint,
                    batch = immutableBatch,
                    replayReceipt = storedAndReceipt.second,
                )
                handles[reservationId] = record
                val reservation = Reservation(record, token)
                RelayV2TerminalPostCommitEffectReservationResult.Reserved(identity, reservation)
            }
        } finally {
            settlePendingTransferredCallbackAborts()
        }
    }

    override suspend fun abort(reservationId: String) {
        try {
            mutex.withLock {
                recoverLocked()
                val record = handles[reservationId] ?: return@withLock
                if (record.state != HandleState.INACTIVE) return@withLock
                if (record.replayReceipt != null) {
                    retireLocked(record)
                    return@withLock
                }
                val removed = journal.transaction {
                    val row = batch(reservationId) ?: return@transaction false
                    if (row.ownerIncarnation != ownerIncarnation ||
                        row.state != RelayV2TerminalPostCommitJournalState.RESERVED.name ||
                        row.nextEffectIndex != 0 || row.runningEffectIndex != null
                    ) {
                        return@transaction false
                    }
                    deleteBatch(reservationId)
                }
                if (removed) retireLocked(record) else poisonAuthorityLocked(record)
            }
        } finally {
            settlePendingTransferredCallbackAborts()
        }
    }

    override suspend fun teardownAuthority(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
    ) {
        requireAuthorityMatchesKey(authority, key)
        val fingerprint = RelayV2TerminalPostCommitBatchCodec.ownerFingerprint(authority, key)
        var gatesToAbort = emptyList<RelayV2TerminalTransferredCallbackGate>()
        try {
            mutex.withLock {
                val matching = handles.values.filter {
                    it.authorityFingerprint == fingerprint
                }
                gatesToAbort = matching.flatMap(::takeTransferredCallbackGatesLocked)
                try {
                    recoverLocked()
                    if (!globallyClosed) {
                        journal.transaction {
                            fenceExactOrClose(authority, key, fingerprint)
                            markAuthorityUnknown(fingerprint)
                        }
                    }
                } finally {
                    matching.forEach {
                        it.state = HandleState.TERMINAL
                    }
                    handles.entries.removeAll {
                        it.value.authorityFingerprint == fingerprint
                    }
                    gatesToAbort += takePendingTransferredCallbackAbortsLocked()
                }
            }
        } finally {
            settleTransferredCallbackGates(
                gatesToAbort,
                RelayV2TerminalTransferredCallbackSettlement.ABORTED,
            )
        }
    }

    override suspend fun acknowledgeCheckpointFinalized(
        key: RelayV2TerminalCheckpointKey,
        activation: RelayV2TerminalParserEffectActivation,
    ) {
        try {
            mutex.withLock {
                recoverLocked()
                if (globallyClosed) return@withLock
                journal.transaction {
                    val row = batch(activation.reservationId) ?: return@transaction
                    if (row.batchFingerprint != activation.batchFingerprint || row.key() != key ||
                        row.terminalReceipt() == null
                    ) {
                        closeGloballyLocked()
                        return@transaction
                    }
                    if (checkpointOwnsActivation(key, activation)) return@transaction
                    check(deleteBatch(row.reservationId))
                }
            }
        } finally {
            settlePendingTransferredCallbackAborts()
        }
    }

    private suspend fun activate(
        record: HandleRecord,
        privateToken: Any,
    ): RelayV2TerminalPostCommitEffectActivationReceipt {
        record.replayReceipt?.let { replay ->
            val receipt = mutex.withLock {
                if (record.privateToken !== privateToken ||
                    handles[record.identity.reservationId] !== record ||
                    record.state != HandleState.INACTIVE
                ) {
                    RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN
                } else {
                    retireLocked(record)
                    replay
                }
            }
            settlePendingTransferredCallbackAborts()
            return receipt
        }
        val admitted = try {
            withContext(NonCancellable) {
                mutex.withLock {
                    recoverLocked()
                    if (record.privateToken !== privateToken ||
                        handles[record.identity.reservationId] !== record ||
                        record.state != HandleState.INACTIVE
                    ) {
                        return@withLock null
                    }
                    if (globallyClosed) {
                        retireLocked(record)
                        return@withLock null
                    }
                    val outcome = journal.transaction {
                        val row = batch(record.identity.reservationId) ?: return@transaction null
                        if (!row.exactlyMatches(record, ownerIncarnation) ||
                            fence(record.authorityFingerprint) != null
                        ) {
                            return@transaction null
                        }
                        if (fifoHead()?.reservationId != row.reservationId) {
                            check(
                                updateBatch(
                                    row.terminal(
                                        RelayV2TerminalPostCommitJournalState.REJECTED,
                                        nextEffectIndex = 0,
                                    ),
                                ),
                            )
                            return@transaction RelayV2TerminalPostCommitEffectActivationReceipt
                                .REJECTED
                        }
                        RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED
                    }
                    if (outcome ==
                        RelayV2TerminalPostCommitEffectActivationReceipt.REJECTED
                    ) {
                        retireLocked(record)
                        return@withLock outcome
                    }
                    if (outcome == null) {
                        poisonAuthorityLocked(record)
                        return@withLock null
                    }
                    record.state = HandleState.ACTIVATING
                    outcome
                }
            }
        } catch (failure: Throwable) {
            settlePendingTransferredCallbackAborts()
            throw failure
        }
        if (admitted == null) {
            settlePendingTransferredCallbackAborts()
            return RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN
        }
        if (admitted == RelayV2TerminalPostCommitEffectActivationReceipt.REJECTED) return admitted

        for (index in record.batch.effects.indices) {
            val markedRunning = try {
                withContext(NonCancellable) {
                    mutex.withLock { markRunningLocked(record, index) }
                }
            } catch (_: Throwable) {
                return finishUnknown(record)
            }
            if (!markedRunning) return finishUnknown(record)

            val executionReceipt = try {
                withContext(NonCancellable) {
                    val receipt = withContext(executionContext.minusKey(Job)) {
                        executor.execute(
                            RelayV2TerminalSynchronousEffectExecution(
                                authority = record.batch.authority,
                                key = record.batch.key,
                                callbackToken = record.batch.callbackToken,
                                effectIndex = index,
                                effectCount = record.batch.effects.size,
                                effect = record.batch.effects[index],
                            ),
                        )
                    }
                    mutex.withLock {
                        receipt.transferredCallbackGate?.let {
                            record.transferredCallbackGates += it
                        }
                    }
                    receipt
                }
            } catch (_: Throwable) {
                return finishUnknown(record)
            }

            val (settled, terminalGates) = try {
                withContext(NonCancellable) {
                    mutex.withLock {
                        val receipt = settleExecutionLocked(record, index, executionReceipt)
                        val gates = if (
                            receipt != RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED ||
                            index == record.batch.effects.lastIndex
                        ) {
                            takeTransferredCallbackGatesLocked(record) +
                                takePendingTransferredCallbackAbortsLocked()
                        } else {
                            emptyList()
                        }
                        receipt to gates
                    }
                }
            } catch (_: Throwable) {
                return finishUnknown(record)
            }
            val gatesSettled = settleTransferredCallbackGates(
                terminalGates,
                if (settled == RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED) {
                    RelayV2TerminalTransferredCallbackSettlement.COMMITTED
                } else {
                    RelayV2TerminalTransferredCallbackSettlement.ABORTED
                },
            )
            if (!gatesSettled) return finishUnknown(record)
            when (settled) {
                RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED -> {
                    if (index == record.batch.effects.lastIndex) return settled
                }
                RelayV2TerminalPostCommitEffectActivationReceipt.REJECTED,
                RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN,
                -> return settled
            }
        }
        return finishUnknown(record)
    }

    private suspend fun markRunningLocked(record: HandleRecord, index: Int): Boolean {
        if (globallyClosed || record.state != HandleState.ACTIVATING) return false
        return journal.transaction {
            if (globallyClosed() || fence(record.authorityFingerprint) != null) return@transaction false
            val row = batch(record.identity.reservationId) ?: return@transaction false
            if (!row.exactlyMatches(record, ownerIncarnation) ||
                row.state != RelayV2TerminalPostCommitJournalState.RESERVED.name ||
                row.nextEffectIndex != index || row.runningEffectIndex != null
            ) {
                return@transaction false
            }
            updateBatch(
                row.copy(
                    state = RelayV2TerminalPostCommitJournalState.RUNNING.name,
                    runningEffectIndex = index,
                ),
            )
        }
    }

    private suspend fun settleExecutionLocked(
        record: HandleRecord,
        index: Int,
        receipt: RelayV2TerminalSynchronousEffectExecutionReceipt,
    ): RelayV2TerminalPostCommitEffectActivationReceipt {
        if (globallyClosed || record.state != HandleState.ACTIVATING) {
            return poisonAuthorityLocked(record)
        }
        val settled = journal.transaction {
            val row = batch(record.identity.reservationId)
            if (row == null || fence(record.authorityFingerprint) != null ||
                !row.exactlyMatches(record, ownerIncarnation) ||
                row.state != RelayV2TerminalPostCommitJournalState.RUNNING.name ||
                row.runningEffectIndex != index || row.nextEffectIndex != index
            ) {
                return@transaction poisonAuthorityInTransaction(record)
            }
            when (receipt.disposition) {
                RelayV2TerminalSynchronousEffectExecutionReceipt.Disposition.COMPLETED,
                RelayV2TerminalSynchronousEffectExecutionReceipt.Disposition
                    .TRANSFERRED_TO_DURABLE_CALLBACK,
                -> {
                    if (index == record.batch.effects.lastIndex) {
                        check(
                            updateBatch(
                                row.terminal(
                                    RelayV2TerminalPostCommitJournalState.ACCEPTED,
                                    nextEffectIndex = record.batch.effects.size,
                                ),
                            ),
                        )
                        RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED
                    } else {
                        val advanced = updateBatch(
                            row.copy(
                                state = RelayV2TerminalPostCommitJournalState.RESERVED.name,
                                nextEffectIndex = index + 1,
                                runningEffectIndex = null,
                            ),
                        )
                        if (!advanced) poisonAuthorityInTransaction(record)
                        else RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED
                    }
                }
                RelayV2TerminalSynchronousEffectExecutionReceipt.Disposition
                    .REJECTED_WITHOUT_EXECUTION,
                -> {
                    if (index == 0) {
                        check(
                            updateBatch(
                                row.terminal(
                                    RelayV2TerminalPostCommitJournalState.REJECTED,
                                    nextEffectIndex = 0,
                                ),
                            ),
                        )
                        RelayV2TerminalPostCommitEffectActivationReceipt.REJECTED
                    } else {
                        poisonAuthorityInTransaction(record)
                    }
                }
            }
        }
        if (settled != RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED ||
            index == record.batch.effects.lastIndex
        ) {
            retireLocked(record)
        }
        return settled
    }

    private suspend fun finishUnknown(
        record: HandleRecord,
    ): RelayV2TerminalPostCommitEffectActivationReceipt = withContext(NonCancellable) {
        val gatesToAbort = mutex.withLock {
            takeTransferredCallbackGatesLocked(record) +
                takePendingTransferredCallbackAbortsLocked()
        }
        try {
            mutex.withLock { poisonAuthorityLocked(record) }
        } finally {
            settleTransferredCallbackGates(
                gatesToAbort,
                RelayV2TerminalTransferredCallbackSettlement.ABORTED,
            )
            settlePendingTransferredCallbackAborts()
        }
    }

    private suspend fun poisonAuthorityLocked(
        record: HandleRecord,
    ): RelayV2TerminalPostCommitEffectActivationReceipt {
        if (!globallyClosed) {
            journal.transaction { poisonAuthorityInTransaction(record) }
        }
        retireLocked(record)
        return RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN
    }

    private fun RelayV2TerminalPostCommitJournalTransaction.poisonAuthorityInTransaction(
        record: HandleRecord,
    ): RelayV2TerminalPostCommitEffectActivationReceipt {
        fenceExactOrClose(
            record.batch.authority,
            record.batch.key,
            record.authorityFingerprint,
        )
        markAuthorityUnknown(record.authorityFingerprint)
        return RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN
    }

    private suspend fun recoverLocked() {
        if (recovered) return
        val receipt = journal.transaction {
            if (globallyClosed()) {
                return@transaction RelayV2TerminalPostCommitRecoveryReceipt(
                    emptyList(),
                    true,
                    0,
                )
            }
            val rows = unsettledBatches()
            if (rows.size > reservationCapacity) {
                closeGloballyLocked()
                return@transaction RelayV2TerminalPostCommitRecoveryReceipt(
                    emptyList(),
                    true,
                    0,
                )
            }
            val recoveredRows = mutableListOf<RelayV2TerminalPostCommitRecoveredLineage>()
            for (row in rows) {
                val lineage = try {
                    row.validateForRecovery()
                } catch (_: Exception) {
                    closeGloballyLocked()
                    return@transaction RelayV2TerminalPostCommitRecoveryReceipt(
                        recoveredRows,
                        true,
                        0,
                    )
                }
                fenceExactOrClose(
                    lineage.authority,
                    lineage.key,
                    lineage.authorityFingerprint,
                )
                markAuthorityUnknown(lineage.authorityFingerprint)
                recoveredRows += lineage
            }
            val maximumFencedGeneration = maximumFencedConnectionGeneration()
            if (maximumFencedGeneration != null &&
                maximumFencedGeneration !in 1 until Long.MAX_VALUE
            ) {
                closeGloballyLocked()
                return@transaction RelayV2TerminalPostCommitRecoveryReceipt(
                    recoveredRows,
                    true,
                    0,
                )
            }
            RelayV2TerminalPostCommitRecoveryReceipt(
                recoveredRows,
                globallyClosed(),
                maximumFencedGeneration ?: 0,
            )
        }
        recoveredLineages += receipt.recoveredLineages
        globallyClosed = receipt.globallyClosed
        connectionGenerationFloor = receipt.connectionGenerationFloor
        recovered = true
    }

    private fun RelayV2TerminalPostCommitBatchEntity.validateForRecovery():
        RelayV2TerminalPostCommitRecoveredLineage {
        require(ownerIncarnation.isNotBlank())
        require(effectCount in 1..RelayV2TerminalPostCommitEffectBatch.MAX_EFFECTS)
        require(nextEffectIndex in 0 until effectCount)
        val stateValue = RelayV2TerminalPostCommitJournalState.entries.singleOrNull {
            it.name == state
        } ?: error("Invalid terminal post-commit journal state")
        when (stateValue) {
            RelayV2TerminalPostCommitJournalState.RESERVED -> require(runningEffectIndex == null)
            RelayV2TerminalPostCommitJournalState.RUNNING ->
                require(runningEffectIndex == nextEffectIndex)
            RelayV2TerminalPostCommitJournalState.ACCEPTED,
            RelayV2TerminalPostCommitJournalState.REJECTED,
            RelayV2TerminalPostCommitJournalState.UNKNOWN,
            -> error("Terminal receipt appeared in unsettled recovery")
        }
        RelayV2TerminalPostCommitBatchCodec.validate(encodedPayload())
        require(payloadSha256 == batchFingerprint)
        val authority = authority()
        val key = key()
        requireAuthorityMatchesKey(authority, key)
        val expected = RelayV2TerminalPostCommitBatchCodec.ownerFingerprint(authority, key)
        require(expected == authorityFingerprint)
        return RelayV2TerminalPostCommitRecoveredLineage(
            authority = authority,
            key = key,
            authorityFingerprint = authorityFingerprint,
            disposition = RelayV2TerminalResetDisposition.STREAM_LOST,
        )
    }

    private fun RelayV2TerminalPostCommitBatchEntity.exactlyMatches(
        record: HandleRecord,
        expectedIncarnation: String,
    ): Boolean = reservationId == record.identity.reservationId &&
        ownerIncarnation == expectedIncarnation &&
        authorityFingerprint == record.authorityFingerprint &&
        batchFingerprint == record.identity.batchFingerprint &&
        effectCount == record.batch.effects.size &&
        payloadSha256 == batchFingerprint

    private fun RelayV2TerminalPostCommitBatchEntity.matchesEncodedBatch(
        batch: RelayV2TerminalPostCommitEffectBatch,
        payload: RelayV2EncodedPayload,
        expectedAuthorityFingerprint: String,
    ): Boolean = authorityFingerprint == expectedAuthorityFingerprint &&
        batchFingerprint == payload.sha256 &&
        payloadSha256 == payload.sha256 &&
        payloadUtf8Bytes == payload.payloadUtf8Bytes &&
        payloadCanonicalJson == payload.canonicalJson &&
        codecVersion == payload.codecVersion &&
        effectCount == batch.effects.size &&
        key() == batch.key && authority() == batch.authority

    private fun RelayV2TerminalPostCommitBatchEntity.terminalReceipt():
        RelayV2TerminalPostCommitEffectActivationReceipt? = when (state) {
        RelayV2TerminalPostCommitJournalState.ACCEPTED.name ->
            RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED
        RelayV2TerminalPostCommitJournalState.REJECTED.name ->
            RelayV2TerminalPostCommitEffectActivationReceipt.REJECTED
        RelayV2TerminalPostCommitJournalState.UNKNOWN.name ->
            RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN
        else -> null
    }

    private fun RelayV2TerminalPostCommitBatchEntity.terminal(
        terminalState: RelayV2TerminalPostCommitJournalState,
        nextEffectIndex: Int = this.nextEffectIndex,
    ): RelayV2TerminalPostCommitBatchEntity {
        require(terminalState in setOf(
            RelayV2TerminalPostCommitJournalState.ACCEPTED,
            RelayV2TerminalPostCommitJournalState.REJECTED,
            RelayV2TerminalPostCommitJournalState.UNKNOWN,
        ))
        return copy(
            state = terminalState.name,
            nextEffectIndex = nextEffectIndex,
            runningEffectIndex = null,
        )
    }

    private fun RelayV2TerminalPostCommitJournalTransaction.markAuthorityUnknown(
        authorityFingerprint: String,
    ) {
        batchesForAuthority(authorityFingerprint).forEach { row ->
            if (row.terminalReceipt() == null) {
                check(updateBatch(row.terminal(RelayV2TerminalPostCommitJournalState.UNKNOWN)))
            }
        }
    }

    private fun RelayV2TerminalPostCommitJournalTransaction.pruneTerminalOutcomesInTransaction() {
        for (row in allBatches()) {
            if (row.terminalReceipt() == null) continue
            val valid = try {
                RelayV2TerminalPostCommitBatchCodec.validate(row.encodedPayload())
                val authority = row.authority()
                val key = row.key()
                requireAuthorityMatchesKey(authority, key)
                RelayV2TerminalPostCommitBatchCodec.ownerFingerprint(authority, key) ==
                    row.authorityFingerprint && row.payloadSha256 == row.batchFingerprint
            } catch (_: Exception) {
                false
            }
            if (!valid) {
                closeGloballyLocked()
                return
            }
            if (!checkpointOwnsReceipt(row.key(), row.reservationId, row.batchFingerprint)) {
                check(deleteBatch(row.reservationId))
            }
        }
    }

    private fun RelayV2TerminalPostCommitJournalTransaction.checkpointOwnsActivation(
        key: RelayV2TerminalCheckpointKey,
        activation: RelayV2TerminalParserEffectActivation,
    ): Boolean = checkpointOwnsReceipt(
        key,
        activation.reservationId,
        activation.batchFingerprint,
    )

    private fun RelayV2TerminalPostCommitJournalTransaction.checkpointOwnsReceipt(
        key: RelayV2TerminalCheckpointKey,
        reservationId: String,
        batchFingerprint: String,
    ): Boolean {
        val row = terminalCheckpoint(key) ?: return false
        val stored = RelayV2TerminalCheckpointCodec.decode(
            key,
            row.checkpointKind,
            RelayV2EncodedPayload(
                row.codecVersion,
                row.payloadUtf8Bytes,
                row.payloadCanonicalJson,
                row.payloadSha256,
            ),
        )
        val checkpoint = when (stored) {
            is RelayV2TerminalStoredCheckpoint.Present -> stored.checkpoint
            is RelayV2TerminalStoredCheckpoint.PreOpen,
            RelayV2TerminalStoredCheckpoint.Missing,
            -> return false
            is RelayV2TerminalStoredCheckpoint.Invalid -> {
                closeGloballyLocked()
                return true
            }
        }
        val marker = checkpoint.pendingParserEffectActivation ?: return false
        if (marker.reservationId == reservationId && marker.batchFingerprint != batchFingerprint) {
            closeGloballyLocked()
            return true
        }
        return marker.reservationId == reservationId &&
            marker.batchFingerprint == batchFingerprint
    }

    private fun RelayV2TerminalPostCommitJournalTransaction.fenceExactOrClose(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        fingerprint: String,
    ) {
        val expected = fenceEntity(authority, key, fingerprint)
        val existing = fence(fingerprint)
        if (existing != null) {
            if (existing != expected) closeGloballyLocked()
            return
        }
        if (fenceCount() >= fencedAuthorityCapacity) {
            closeGloballyLocked()
            return
        }
        insertFence(expected)
    }

    private fun RelayV2TerminalPostCommitJournalTransaction.closeGloballyLocked() {
        closeGlobally()
        allBatches().filter { it.terminalReceipt() == null }.forEach { row ->
            updateBatch(row.terminal(RelayV2TerminalPostCommitJournalState.UNKNOWN))
        }
        globallyClosed = true
        handles.values.forEach {
            transferredCallbackGatesPendingAbort += takeTransferredCallbackGatesLocked(it)
        }
    }

    private fun entity(
        reservationId: String,
        batch: RelayV2TerminalPostCommitEffectBatch,
        payload: RelayV2EncodedPayload,
        authorityFingerprint: String,
    ): RelayV2TerminalPostCommitBatchEntity = RelayV2TerminalPostCommitBatchEntity(
        reservationId = reservationId,
        ownerIncarnation = ownerIncarnation,
        authorityFingerprint = authorityFingerprint,
        profileId = batch.authority.profileId,
        profileActivationGeneration = batch.authority.profileActivationGeneration,
        connectionGeneration = batch.authority.generation.connectionGeneration,
        principalId = batch.authority.principalId,
        clientInstanceId = batch.authority.clientInstanceId,
        hostId = batch.authority.hostId,
        hostEpoch = batch.authority.hostEpoch,
        scopeId = batch.key.scopeId,
        sessionId = batch.key.sessionId,
        streamId = batch.key.streamId,
        pane = batch.key.pane,
        batchFingerprint = payload.sha256,
        callbackOperationId = batch.callbackToken.operationId,
        effectCount = batch.effects.size,
        nextEffectIndex = 0,
        runningEffectIndex = null,
        state = RelayV2TerminalPostCommitJournalState.RESERVED.name,
        codecVersion = payload.codecVersion,
        payloadUtf8Bytes = payload.payloadUtf8Bytes,
        payloadCanonicalJson = payload.canonicalJson,
        payloadSha256 = payload.sha256,
    )

    private fun fenceEntity(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        fingerprint: String,
    ) = RelayV2TerminalPostCommitFenceEntity(
        authorityFingerprint = fingerprint,
        profileId = authority.profileId,
        profileActivationGeneration = authority.profileActivationGeneration,
        connectionGeneration = authority.generation.connectionGeneration,
        principalId = authority.principalId,
        clientInstanceId = authority.clientInstanceId,
        hostId = authority.hostId,
        hostEpoch = authority.hostEpoch,
        scopeId = key.scopeId,
        sessionId = key.sessionId,
        streamId = key.streamId,
        pane = key.pane,
    )

    private fun RelayV2TerminalPostCommitBatchEntity.authority() =
        RelayV2RepositoryEffectAuthority(
            generation = RelayV2EffectGeneration(
                profileId,
                profileActivationGeneration,
                connectionGeneration,
            ),
            profileId = profileId,
            profileActivationGeneration = profileActivationGeneration,
            principalId = principalId,
            clientInstanceId = clientInstanceId,
            hostId = hostId,
            hostEpoch = hostEpoch,
        )

    private fun RelayV2TerminalPostCommitBatchEntity.key() = RelayV2TerminalCheckpointKey(
        profileId = profileId,
        profileActivationGeneration = profileActivationGeneration,
        principalId = principalId,
        clientInstanceId = clientInstanceId,
        hostId = hostId,
        hostEpoch = hostEpoch,
        scopeId = scopeId,
        sessionId = sessionId,
        streamId = streamId,
        pane = pane,
    )

    private fun RelayV2TerminalPostCommitBatchEntity.encodedPayload() = RelayV2EncodedPayload(
        codecVersion,
        payloadUtf8Bytes,
        payloadCanonicalJson,
        payloadSha256,
    )

    private fun requireExactOwner(batch: RelayV2TerminalPostCommitEffectBatch) {
        requireAuthorityMatchesKey(batch.authority, batch.key)
        val fence = batch.callbackToken.fence
        require(fence.identity.target() == batch.key.toTarget())
        require(fence.deliveryToken.actorGeneration == batch.authority.generation)
        require(batch.effects.all { effect ->
            effect.fence == null ||
                (effect.fence?.target == batch.key.toTarget() &&
                    effect.fence?.deliveryToken?.actorGeneration == batch.authority.generation)
        })
    }

    private fun requireAuthorityMatchesKey(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
    ) {
        require(key.profileId == authority.profileId)
        require(key.profileActivationGeneration == authority.profileActivationGeneration)
        require(key.principalId == authority.principalId)
        require(key.clientInstanceId == authority.clientInstanceId)
        require(key.hostId == authority.hostId)
        require(key.hostEpoch == authority.hostEpoch)
    }

    private fun retireLocked(record: HandleRecord) {
        record.state = HandleState.TERMINAL
        handles.remove(record.identity.reservationId, record)
    }

    private fun takeTransferredCallbackGatesLocked(
        record: HandleRecord,
    ): List<RelayV2TerminalTransferredCallbackGate> {
        if (record.transferredCallbackGates.isEmpty()) return emptyList()
        return record.transferredCallbackGates.toList().also {
            record.transferredCallbackGates.clear()
        }
    }

    private fun takePendingTransferredCallbackAbortsLocked():
        List<RelayV2TerminalTransferredCallbackGate> {
        if (globallyClosed) {
            handles.values.forEach {
                transferredCallbackGatesPendingAbort += takeTransferredCallbackGatesLocked(it)
                it.state = HandleState.TERMINAL
            }
            handles.clear()
        }
        if (transferredCallbackGatesPendingAbort.isEmpty()) return emptyList()
        return transferredCallbackGatesPendingAbort.toList().also {
            transferredCallbackGatesPendingAbort.clear()
        }
    }

    private suspend fun settlePendingTransferredCallbackAborts() =
        withContext(NonCancellable) {
            val gates = mutex.withLock { takePendingTransferredCallbackAbortsLocked() }
            settleTransferredCallbackGates(
                gates,
                RelayV2TerminalTransferredCallbackSettlement.ABORTED,
            )
        }

    private fun validReservationId(value: String): Boolean =
        value.isNotBlank() && value.toByteArray(Charsets.UTF_8).size <= MAX_RESERVATION_ID_BYTES

    private companion object {
        const val DEFAULT_RESERVATION_CAPACITY = 32
        const val MAX_RESERVATION_CAPACITY = 256
        const val DEFAULT_OUTCOME_CAPACITY = 1_024
        const val MAX_OUTCOME_CAPACITY = 4_096
        const val DEFAULT_FENCED_AUTHORITY_CAPACITY = 1_024
        const val MAX_FENCED_AUTHORITY_CAPACITY = 4_096
        const val MAX_RESERVATION_ID_BYTES = 128
    }
}
