package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2EncodedPayload
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalCheckpointCodec
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalCheckpointEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalCheckpointKey
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitBatchEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitFenceEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitJournalState
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitJournalStore
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitJournalTransaction
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCheckpoint
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalControlDispatchLease
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalDeliveryToken
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffect
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffectFence
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalIdentity
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenAttempt
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenDisposition
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenMode
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenResultLineage
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserCallbackToken
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserEffectActivation
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalPhase
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResetReason
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalStoredCheckpoint
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2DurableTerminalPostCommitEffectSinkTest {
    @Test
    fun `complete receipt survives crash until checkpoint barrier and same id never reexecutes`() =
        runBlocking {
            val store = MemoryJournalStore()
            var firstExecutions = 0
            val first = sink(store, "process-first") {
                firstExecutions += 1
                RelayV2TerminalSynchronousEffectExecutionReceipt.COMPLETED
            }
            val batch = batch("0")
            val reserved = first.reserve("reservation-crash-cut", batch).reserved()
            val activation = RelayV2TerminalParserEffectActivation(
                batch.callbackToken,
                reserved.identity.reservationId,
                reserved.identity.batchFingerprint,
            )
            store.installCheckpointActivation(batch, activation)

            assertEquals(
                RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED,
                reserved.reservation.activate(),
            )
            assertEquals(1, firstExecutions)
            assertEquals(
                RelayV2TerminalPostCommitJournalState.ACCEPTED.name,
                store.batch("reservation-crash-cut")?.state,
            )

            var restartedExecutions = 0
            val restarted = sink(store, "process-restarted") {
                restartedExecutions += 1
                RelayV2TerminalSynchronousEffectExecutionReceipt.COMPLETED
            }
            assertTrue(restarted.recover().recoveredLineages.isEmpty())
            val replay = restarted.reserve("reservation-crash-cut", batch).reserved()
            assertEquals(reserved.identity, replay.identity)
            assertEquals(
                RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED,
                replay.reservation.activate(),
            )
            assertEquals(0, restartedExecutions)
            assertNotNull(store.batch("reservation-crash-cut"))

            store.clearCheckpointActivation(batch.key)
            restarted.acknowledgeCheckpointFinalized(batch.key, activation)
            assertNull(store.batch("reservation-crash-cut"))
        }

    @Test
    fun `running recovery becomes stream lost unknown and is never retried`() = runBlocking {
        val store = MemoryJournalStore()
        val batch = batch("running")
        val first = sink(store, "process-before-crash") {
            error("executor must not run in this setup")
        }
        val reserved = first.reserve("reservation-running", batch).reserved()
        val activation = RelayV2TerminalParserEffectActivation(
            batch.callbackToken,
            reserved.identity.reservationId,
            reserved.identity.batchFingerprint,
        )
        store.installCheckpointActivation(batch, activation)
        store.markRunning("reservation-running", 0)

        var restartedExecutions = 0
        val restarted = sink(store, "process-after-crash") {
            restartedExecutions += 1
            RelayV2TerminalSynchronousEffectExecutionReceipt.COMPLETED
        }
        val recovery = restarted.recover()
        assertFalse(recovery.globallyClosed)
        assertEquals(1, recovery.recoveredLineages.size)
        assertEquals(RelayV2TerminalResetDisposition.STREAM_LOST, recovery
            .recoveredLineages.single().disposition)
        assertEquals(
            RelayV2TerminalPostCommitJournalState.UNKNOWN.name,
            store.batch("reservation-running")?.state,
        )

        val replay = restarted.reserve("reservation-running", batch).reserved()
        assertEquals(
            RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN,
            replay.reservation.activate(),
        )
        assertEquals(0, restartedExecutions)
        assertTrue(
            restarted.reserve("reservation-after-poison", batch("later")) is
                RelayV2TerminalPostCommitEffectReservationResult.Rejected,
        )
    }

    @Test
    fun `runner persists running before each strictly ordered synchronous effect`() = runBlocking {
        val store = MemoryJournalStore()
        val seen = mutableListOf<Int>()
        val runner = sink(store, "process-order") { execution ->
            val row = requireNotNull(store.batch("reservation-order"))
            assertEquals(RelayV2TerminalPostCommitJournalState.RUNNING.name, row.state)
            assertEquals(execution.effectIndex, row.runningEffectIndex)
            assertEquals(execution.effectIndex, row.nextEffectIndex)
            seen += execution.effectIndex
            RelayV2TerminalSynchronousEffectExecutionReceipt.COMPLETED
        }
        val reserved = runner.reserve(
            "reservation-order",
            batch("first", "second", "third"),
        ).reserved()

        assertEquals(
            RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED,
            reserved.reservation.activate(),
        )
        assertEquals(listOf(0, 1, 2), seen)
        assertEquals(
            RelayV2TerminalPostCommitJournalState.ACCEPTED.name,
            store.batch("reservation-order")?.state,
        )
    }

    @Test
    fun `partial throw persists unknown and same id cannot retry`() = runBlocking {
        val store = MemoryJournalStore()
        val batch = batch("first", "throws")
        var attempts = 0
        val runner = sink(store, "process-partial") { execution ->
            attempts += 1
            if (execution.effectIndex == 1) error("platform result unavailable")
            RelayV2TerminalSynchronousEffectExecutionReceipt.COMPLETED
        }
        val reserved = runner.reserve("reservation-partial", batch).reserved()
        val activation = RelayV2TerminalParserEffectActivation(
            batch.callbackToken,
            reserved.identity.reservationId,
            reserved.identity.batchFingerprint,
        )
        store.installCheckpointActivation(batch, activation)

        assertEquals(
            RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN,
            reserved.reservation.activate(),
        )
        assertEquals(2, attempts)
        assertEquals(
            RelayV2TerminalPostCommitJournalState.UNKNOWN.name,
            store.batch("reservation-partial")?.state,
        )

        var replayAttempts = 0
        val restarted = sink(store, "process-partial-restarted") {
            replayAttempts += 1
            RelayV2TerminalSynchronousEffectExecutionReceipt.COMPLETED
        }
        val replay = restarted.reserve("reservation-partial", batch).reserved()
        assertEquals(
            RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN,
            replay.reservation.activate(),
        )
        assertEquals(0, replayAttempts)
    }

    @Test
    fun `teardown fence survives restart but does not fence a later connection generation`() =
        runBlocking {
            val store = MemoryJournalStore()
            val exact = batch("fenced")
            val first = sink(store, "process-teardown") {
                RelayV2TerminalSynchronousEffectExecutionReceipt.COMPLETED
            }
            first.teardownAuthority(exact.authority, exact.key)

            assertTrue(
                first.reserve("reservation-fenced", exact) is
                    RelayV2TerminalPostCommitEffectReservationResult.Rejected,
            )

            val restarted = sink(store, "process-after-teardown") {
                RelayV2TerminalSynchronousEffectExecutionReceipt.COMPLETED
            }
            assertTrue(
                restarted.reserve("reservation-still-fenced", exact) is
                    RelayV2TerminalPostCommitEffectReservationResult.Rejected,
            )

            val successor = batchForConnection(4, "successor")
            val successorReservation = restarted.reserve(
                "reservation-successor",
                successor,
            ).reserved()
            restarted.abort(successorReservation.identity.reservationId)
            assertNull(store.batch(successorReservation.identity.reservationId))
        }

    private fun sink(
        store: MemoryJournalStore,
        incarnation: String,
        execute: (RelayV2TerminalSynchronousEffectExecution) ->
            RelayV2TerminalSynchronousEffectExecutionReceipt,
    ) = RelayV2DurableTerminalPostCommitEffectSink(
        journal = store,
        executor = RelayV2TerminalSynchronousEffectExecutor(execute),
        executionContext = Dispatchers.Unconfined,
        ownerIncarnation = incarnation,
    )

    private fun RelayV2TerminalPostCommitEffectReservationResult.reserved() =
        this as RelayV2TerminalPostCommitEffectReservationResult.Reserved

    private fun batch(vararg markers: String): RelayV2TerminalPostCommitEffectBatch {
        return batchForConnection(3, *markers)
    }

    private fun batchForConnection(
        connectionGeneration: Long,
        vararg markers: String,
    ): RelayV2TerminalPostCommitEffectBatch {
        val authority = authority(connectionGeneration)
        val key = key()
        val callback = callbackToken(connectionGeneration)
        return RelayV2TerminalPostCommitEffectBatch(
            authority,
            key,
            callback,
            markers.map { marker ->
                RelayV2TerminalEffect.ResetRequired(
                    fence = callback.fence,
                    reason = RelayV2TerminalResetReason.STREAM_LOST,
                    parserAppliedNextOffset = marker,
                )
            },
        )
    }

    private fun authority(connectionGeneration: Long = 3) = RelayV2RepositoryEffectAuthority(
        generation = RelayV2EffectGeneration("profile-v2", 7, connectionGeneration),
        profileId = "profile-v2",
        profileActivationGeneration = 7,
        principalId = "principal-v2",
        clientInstanceId = "android-v2",
        hostId = "host-v2",
        hostEpoch = "epoch-v2",
    )

    private fun key() = RelayV2TerminalCheckpointKey(
        profileId = "profile-v2",
        profileActivationGeneration = 7,
        principalId = "principal-v2",
        clientInstanceId = "android-v2",
        hostId = "host-v2",
        hostEpoch = "epoch-v2",
        scopeId = "scope-v2",
        sessionId = "session-v2",
        streamId = "stream-v2",
        pane = 0,
    )

    private fun callbackToken(connectionGeneration: Long = 3): RelayV2TerminalParserCallbackToken {
        val identity = RelayV2TerminalIdentity(
            profileId = "profile-v2",
            profileActivationGeneration = 7,
            principalId = "principal-v2",
            clientInstanceId = "android-v2",
            hostId = "host-v2",
            hostEpoch = "epoch-v2",
            hostInstanceId = "host-process-v2",
            scopeId = "scope-v2",
            sessionId = "session-v2",
            streamId = "stream-v2",
            generation = "terminal-generation-v2",
            resumeTokenCredentialReference = "resume-reference-v2",
            resumeTokenCredentialFingerprint = "resume-fingerprint-v2",
        )
        return RelayV2TerminalParserCallbackToken(
            fence = RelayV2TerminalEffectFence(
                identity,
                RelayV2TerminalDeliveryToken(
                    authority(connectionGeneration).generation,
                    2,
                    11,
                ),
                RelayV2TerminalOpenAttempt("open-v2", "open-fingerprint-v2"),
            ),
            parserContinuityId = "parser-v2",
            operationId = "parser-operation-v2",
            startOffset = "0",
            endOffset = "1",
        )
    }

    private class MemoryJournalStore :
        RelayV2TerminalPostCommitJournalStore,
        RelayV2TerminalPostCommitJournalTransaction {
        private val lock = Any()
        private var nextOrder = 1L
        private var rows = linkedMapOf<String, RelayV2TerminalPostCommitBatchEntity>()
        private var fences = linkedMapOf<String, RelayV2TerminalPostCommitFenceEntity>()
        private var checkpoints = linkedMapOf<RelayV2TerminalCheckpointKey, RelayV2TerminalCheckpointEntity>()
        private var closed = false

        override suspend fun <T> transaction(
            block: RelayV2TerminalPostCommitJournalTransaction.() -> T,
        ): T = synchronized(lock) {
            val beforeRows = LinkedHashMap(rows)
            val beforeFences = LinkedHashMap(fences)
            val beforeClosed = closed
            val beforeOrder = nextOrder
            try {
                block()
            } catch (failure: Throwable) {
                rows = beforeRows
                fences = beforeFences
                closed = beforeClosed
                nextOrder = beforeOrder
                throw failure
            }
        }

        fun markRunning(reservationId: String, index: Int) = synchronized(lock) {
            val row = requireNotNull(rows[reservationId])
            rows[reservationId] = row.copy(
                state = RelayV2TerminalPostCommitJournalState.RUNNING.name,
                nextEffectIndex = index,
                runningEffectIndex = index,
            )
        }

        fun installCheckpointActivation(
            batch: RelayV2TerminalPostCommitEffectBatch,
            activation: RelayV2TerminalParserEffectActivation,
        ) = synchronized(lock) {
            val token = batch.callbackToken
            val identity = token.fence.identity
            val checkpoint = RelayV2TerminalCheckpoint(
                identity = identity,
                openAttempt = token.fence.openAttempt,
                openMode = RelayV2TerminalOpenMode.NEW,
                openRequestResume = null,
                openResult = RelayV2TerminalOpenResultLineage(
                    disposition = RelayV2TerminalOpenDisposition.NEW,
                    generation = identity.generation,
                    hostInstanceId = identity.hostInstanceId,
                    resumeTokenCredentialReference = identity.resumeTokenCredentialReference,
                    resumeTokenCredentialFingerprint = identity.resumeTokenCredentialFingerprint,
                    parserContinuityId = token.parserContinuityId,
                    cols = 120,
                    rows = 36,
                    replayFromOffset = "0",
                    tailOffset = token.endOffset,
                ),
                openRequestIds = listOf("open-request-v2"),
                deliveryToken = token.fence.deliveryToken,
                parserContinuityId = token.parserContinuityId,
                phase = RelayV2TerminalPhase.LIVE,
                openedCols = 120,
                openedRows = 36,
                parserAppliedNextOffset = token.endOffset,
                networkReceivedThrough = token.endOffset,
                nextParserOperationSeq = "2",
                nextReplayRequestSeq = "1",
                lastAppliedParserCallbackToken = token,
                pendingParserEffectActivation = activation,
                activeControlDispatchLease = RelayV2TerminalControlDispatchLease(token.fence),
            )
            putCheckpoint(batch.key, checkpoint)
        }

        fun clearCheckpointActivation(key: RelayV2TerminalCheckpointKey) = synchronized(lock) {
            val row = requireNotNull(checkpoints[key])
            val stored = RelayV2TerminalCheckpointCodec.decode(
                key,
                row.checkpointKind,
                RelayV2EncodedPayload(
                    row.codecVersion,
                    row.payloadUtf8Bytes,
                    row.payloadCanonicalJson,
                    row.payloadSha256,
                ),
            ) as RelayV2TerminalStoredCheckpoint.Present
            putCheckpoint(key, stored.checkpoint.copy(pendingParserEffectActivation = null))
        }

        private fun putCheckpoint(
            key: RelayV2TerminalCheckpointKey,
            checkpoint: RelayV2TerminalCheckpoint,
        ) {
            val encoded = RelayV2TerminalCheckpointCodec.encode(
                key,
                RelayV2TerminalStoredCheckpoint.Present(checkpoint),
            )
            checkpoints[key] = RelayV2TerminalCheckpointEntity(
                profileId = key.profileId,
                profileActivationGeneration = key.profileActivationGeneration,
                principalId = key.principalId,
                clientInstanceId = key.clientInstanceId,
                hostId = key.hostId,
                hostEpoch = key.hostEpoch,
                scopeId = key.scopeId,
                sessionId = key.sessionId,
                streamId = key.streamId,
                pane = key.pane,
                checkpointKind = encoded.kind.name,
                codecVersion = encoded.payload.codecVersion,
                payloadUtf8Bytes = encoded.payload.payloadUtf8Bytes,
                payloadCanonicalJson = encoded.payload.canonicalJson,
                payloadSha256 = encoded.payload.sha256,
            )
        }

        override fun unsettledBatches() = rows.values.filter {
            it.state in setOf(
                RelayV2TerminalPostCommitJournalState.RESERVED.name,
                RelayV2TerminalPostCommitJournalState.RUNNING.name,
            )
        }.sortedBy { it.journalOrder }

        override fun allBatches() = rows.values.sortedBy { it.journalOrder }
        override fun batch(reservationId: String) = synchronized(lock) { rows[reservationId] }
        override fun fifoHead() = unsettledBatches().firstOrNull()
        override fun unsettledBatchCount() = unsettledBatches().size
        override fun terminalOutcomeCount() = rows.size - unsettledBatchCount()

        override fun insertBatch(
            batch: RelayV2TerminalPostCommitBatchEntity,
        ): RelayV2TerminalPostCommitBatchEntity {
            check(batch.reservationId !in rows)
            val stored = batch.copy(journalOrder = nextOrder++)
            rows[batch.reservationId] = stored
            return stored
        }

        override fun updateBatch(batch: RelayV2TerminalPostCommitBatchEntity): Boolean {
            if (rows[batch.reservationId]?.journalOrder != batch.journalOrder) return false
            rows[batch.reservationId] = batch
            return true
        }

        override fun deleteBatch(reservationId: String) = rows.remove(reservationId) != null
        override fun fence(authorityFingerprint: String) = fences[authorityFingerprint]
        override fun fenceCount() = fences.size

        override fun insertFence(fence: RelayV2TerminalPostCommitFenceEntity) {
            check(fence.authorityFingerprint !in fences)
            fences[fence.authorityFingerprint] = fence
        }

        override fun batchesForAuthority(authorityFingerprint: String) = rows.values.filter {
            it.authorityFingerprint == authorityFingerprint
        }.sortedBy { it.journalOrder }

        override fun deleteBatchesForAuthority(authorityFingerprint: String) {
            rows.entries.removeAll { it.value.authorityFingerprint == authorityFingerprint }
        }

        override fun globallyClosed() = closed
        override fun closeGlobally() { closed = true }
        override fun deleteAllBatches() { rows.clear() }
        override fun terminalCheckpoint(key: RelayV2TerminalCheckpointKey) = checkpoints[key]
    }
}
