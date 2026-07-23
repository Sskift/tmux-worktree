package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalCheckpointKey
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalDeliveryToken
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffect
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffectFence
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalIdentity
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenAttempt
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserCallbackToken
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResetReason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.coroutines.runBlocking

class RelayV2SynchronousTerminalPostCommitEffectSinkTest {
    @Test
    fun `bounded FIFO rejects overtaking inactive and activating reservations`() = runBlocking {
        val executions = mutableListOf<String?>()
        lateinit var third: RelayV2TerminalPostCommitEffectReservation
        val sink = RelayV2SynchronousTerminalPostCommitEffectSink(
            executor = RelayV2TerminalSynchronousEffectExecutor { execution ->
                executions += (execution.effect as RelayV2TerminalEffect.ResetRequired)
                    .parserAppliedNextOffset
                if (execution.effectIndex == 0 && executions.last() == "first") {
                    assertEquals(
                        RelayV2TerminalPostCommitEffectActivationReceipt.REJECTED,
                        runBlocking { third.activate() },
                    )
                }
                RelayV2TerminalSynchronousEffectExecutionReceipt.COMPLETED
            },
            reservationCapacity = 3,
        )
        val first = sink.reserve("reservation-first", batch("first")).reservation()
        val second = sink.reserve("reservation-second", batch("second")).reservation()
        third = sink.reserve("reservation-third", batch("third")).reservation()

        assertTrue(
            sink.reserve("reservation-overflow", batch("overflow")) is
                RelayV2TerminalPostCommitEffectReservationResult.Rejected,
        )
        assertEquals(
            RelayV2TerminalPostCommitEffectActivationReceipt.REJECTED,
            second.activate(),
        )
        assertTrue(executions.isEmpty())
        assertEquals(
            RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED,
            first.activate(),
        )
        assertEquals(listOf("first"), executions)

        val after = sink.reserve("reservation-after", batch("after")).reservation()
        assertEquals(
            RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED,
            after.activate(),
        )
        assertEquals(listOf("first", "after"), executions)
    }

    @Test
    fun `inactive abort is exact idempotent and releases capacity`() = runBlocking {
        val executions = mutableListOf<RelayV2TerminalEffect>()
        val sink = RelayV2SynchronousTerminalPostCommitEffectSink(
            executor = RelayV2TerminalSynchronousEffectExecutor { execution ->
                executions += execution.effect
                RelayV2TerminalSynchronousEffectExecutionReceipt.COMPLETED
            },
            reservationCapacity = 1,
        )
        val abandoned = sink.reserve("reservation-abandoned", batch("abandoned")).reservation()

        sink.abort("reservation-foreign")
        sink.abort("reservation-abandoned")
        sink.abort("reservation-abandoned")

        assertEquals(
            RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN,
            abandoned.activate(),
        )
        assertTrue(executions.isEmpty())
        val replacement = sink.reserve(
            "reservation-replacement",
            batch("replacement"),
        ).reservation()
        assertEquals(
            RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED,
            replacement.activate(),
        )
        assertEquals(1, executions.size)
    }

    @Test
    fun `zero execution may reject but partial or throwing execution is unknown and never retried`() = runBlocking {
        var zeroCalls = 0
        val zeroSink = RelayV2SynchronousTerminalPostCommitEffectSink(
            RelayV2TerminalSynchronousEffectExecutor {
                zeroCalls += 1
                RelayV2TerminalSynchronousEffectExecutionReceipt.REJECTED_WITHOUT_EXECUTION
            },
        )
        val zero = zeroSink.reserve("reservation-zero", batch("zero")).reservation()
        assertEquals(
            RelayV2TerminalPostCommitEffectActivationReceipt.REJECTED,
            zero.activate(),
        )
        assertEquals(1, zeroCalls)

        val completed = mutableListOf<Int>()
        var attempts = 0
        val partialSink = RelayV2SynchronousTerminalPostCommitEffectSink(
            RelayV2TerminalSynchronousEffectExecutor { execution ->
                attempts += 1
                if (execution.effectIndex == 1) {
                    throw IllegalStateException("executor outcome unavailable")
                }
                completed += execution.effectIndex
                RelayV2TerminalSynchronousEffectExecutionReceipt.COMPLETED
            },
        )
        val partial = partialSink.reserve(
            "reservation-partial",
            batch("partial-0", "partial-1", "partial-2"),
        ).reservation()

        assertEquals(
            RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN,
            partial.activate(),
        )
        assertEquals(listOf(0), completed)
        assertEquals(2, attempts)
        assertEquals(
            RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN,
            partial.activate(),
        )
        assertEquals(2, attempts)
    }

    @Test
    fun `teardown permanently fences exact authority key and clears its pending reservations`() = runBlocking {
        val executions = mutableListOf<RelayV2TerminalSynchronousEffectExecution>()
        val sink = RelayV2SynchronousTerminalPostCommitEffectSink(
            RelayV2TerminalSynchronousEffectExecutor { execution ->
                executions += execution
                RelayV2TerminalSynchronousEffectExecutionReceipt.COMPLETED
            },
        )
        val authority = authority()
        val firstKey = key("stream-first")
        val secondKey = key("stream-second")
        val first = sink.reserve(
            "reservation-first-key",
            batch("first", authority = authority, key = firstKey),
        ).reservation()
        val sameOwnerPending = sink.reserve(
            "reservation-first-key-2",
            batch("first-2", authority = authority, key = firstKey),
        ).reservation()
        val otherKey = sink.reserve(
            "reservation-second-key",
            batch("second", authority = authority, key = secondKey),
        ).reservation()

        sink.teardownAuthority(authority, firstKey)
        sink.teardownAuthority(authority, firstKey)

        assertEquals(
            RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN,
            first.activate(),
        )
        assertEquals(
            RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN,
            sameOwnerPending.activate(),
        )
        assertTrue(
            sink.reserve(
                "reservation-fenced",
                batch("fenced", authority = authority, key = firstKey),
            ) is RelayV2TerminalPostCommitEffectReservationResult.Rejected,
        )
        assertEquals(
            RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED,
            otherKey.activate(),
        )
        assertEquals(1, executions.size)
        assertSame(authority, executions.single().authority)
        assertEquals(secondKey, executions.single().key)
    }

    private fun RelayV2TerminalPostCommitEffectReservationResult.reservation():
        RelayV2TerminalPostCommitEffectReservation =
        (this as RelayV2TerminalPostCommitEffectReservationResult.Reserved).reservation

    private fun batch(
        vararg offsets: String,
        authority: RelayV2RepositoryEffectAuthority = authority(),
        key: RelayV2TerminalCheckpointKey = key("stream-a"),
    ): RelayV2TerminalPostCommitEffectBatch {
        val callbackToken = callbackToken(key.streamId)
        return RelayV2TerminalPostCommitEffectBatch(
            authority = authority,
            key = key,
            callbackToken = callbackToken,
            effects = offsets.map { offset ->
                RelayV2TerminalEffect.ResetRequired(
                    fence = callbackToken.fence,
                    reason = RelayV2TerminalResetReason.STREAM_LOST,
                    parserAppliedNextOffset = offset,
                )
            },
        )
    }

    private fun authority() = RelayV2RepositoryEffectAuthority(
        generation = RelayV2EffectGeneration("profile-v2", 7, 1),
        profileId = "profile-v2",
        profileActivationGeneration = 7,
        principalId = "principal-v2",
        clientInstanceId = "android-install-v2",
        hostId = "host-a",
        hostEpoch = "epoch-a",
    )

    private fun key(streamId: String) = RelayV2TerminalCheckpointKey(
        profileId = "profile-v2",
        profileActivationGeneration = 7,
        principalId = "principal-v2",
        clientInstanceId = "android-install-v2",
        hostId = "host-a",
        hostEpoch = "epoch-a",
        scopeId = "scope-a",
        sessionId = "session-a",
        streamId = streamId,
        pane = 0,
    )

    private fun callbackToken(streamId: String): RelayV2TerminalParserCallbackToken {
        val identity = RelayV2TerminalIdentity(
            profileId = "profile-v2",
            profileActivationGeneration = 7,
            principalId = "principal-v2",
            clientInstanceId = "android-install-v2",
            hostId = "host-a",
            hostEpoch = "epoch-a",
            hostInstanceId = "host-process-a",
            scopeId = "scope-a",
            sessionId = "session-a",
            streamId = streamId,
            generation = "terminal-generation-a",
            resumeTokenCredentialReference = "resume-reference-a",
            resumeTokenCredentialFingerprint = "resume-fingerprint-a",
        )
        return RelayV2TerminalParserCallbackToken(
            fence = RelayV2TerminalEffectFence(
                identity = identity,
                deliveryToken = RelayV2TerminalDeliveryToken(
                    actorGeneration = RelayV2EffectGeneration("profile-v2", 7, 1),
                    authorityGeneration = 1,
                    localDispatchToken = 1,
                ),
                openAttempt = RelayV2TerminalOpenAttempt(
                    openId = "open-a",
                    fingerprint = "open-fingerprint-a",
                ),
            ),
            parserContinuityId = "parser-a",
            operationId = "operation-$streamId",
            startOffset = "0",
            endOffset = "1",
        )
    }
}
