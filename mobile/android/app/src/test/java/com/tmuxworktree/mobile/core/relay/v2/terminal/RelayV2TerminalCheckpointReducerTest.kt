package com.tmuxworktree.mobile.core.relay.v2.terminal

import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectGeneration
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2TerminalCheckpointReducerTest {
    @Test
    fun `restore binds complete identity delivery and parser continuity and permits explicit rebind`() {
        val identity = identity()
        val checkpoint = open(identity)
        val restored = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(checkpoint),
            identity,
            checkpoint.openAttempt,
            checkpoint.deliveryToken,
            PARSER_CONTINUITY,
        )
        assertTrue(restored.outcome is RelayV2TerminalOutcome.Restored)
        assertEquals(checkpoint, restored.checkpoint)

        data class RestoreResetCase(
            val stored: RelayV2TerminalStoredCheckpoint,
            val expectedIdentity: RelayV2TerminalIdentity,
            val reason: RelayV2TerminalResetReason,
        )

        listOf(
            RestoreResetCase(
                RelayV2TerminalStoredCheckpoint.Missing,
                identity,
                RelayV2TerminalResetReason.MISSING_CHECKPOINT,
            ),
            RestoreResetCase(
                RelayV2TerminalStoredCheckpoint.Invalid(
                    RelayV2TerminalRestoreInvalidity.MISSING_REQUIRED_FIELD,
                ),
                identity,
                RelayV2TerminalResetReason.MISSING_REQUIRED_IDENTITY,
            ),
            RestoreResetCase(
                RelayV2TerminalStoredCheckpoint.Invalid(
                    RelayV2TerminalRestoreInvalidity.SCHEMA_INCOMPATIBLE,
                ),
                identity,
                RelayV2TerminalResetReason.SCHEMA_INCOMPATIBLE,
            ),
            RestoreResetCase(
                RelayV2TerminalStoredCheckpoint.Present(checkpoint.copy(schemaVersion = 9)),
                identity,
                RelayV2TerminalResetReason.SCHEMA_INCOMPATIBLE,
            ),
            RestoreResetCase(
                RelayV2TerminalStoredCheckpoint.Present(checkpoint),
                identity.copy(profileActivationGeneration = 8),
                RelayV2TerminalResetReason.IDENTITY_CHANGED,
            ),
            RestoreResetCase(
                RelayV2TerminalStoredCheckpoint.Present(checkpoint),
                identity.copy(hostInstanceId = "host-process-2"),
                RelayV2TerminalResetReason.STREAM_LOST,
            ),
        ).forEach { case ->
            val result = RelayV2TerminalCheckpointReducer.restore(
                case.stored,
                case.expectedIdentity,
                checkpoint.openAttempt,
                checkpoint.deliveryToken,
                PARSER_CONTINUITY,
            )
            assertEquals(case.reason, (result.outcome as RelayV2TerminalOutcome.ResetRequired).reason)
            assertTrue(result.effects.single() is RelayV2TerminalEffect.ResetRequired)
        }

        val continuityLost = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(checkpoint),
            identity,
            checkpoint.openAttempt,
            checkpoint.deliveryToken,
            "replacement-parser",
        )
        assertEquals(
            RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST,
            (continuityLost.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        val nextDelivery = delivery(deliverySequence = 2, connectionGeneration = 2)
        val restoredFreshAuthority = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(checkpoint),
            identity,
            checkpoint.openAttempt,
            nextDelivery,
            PARSER_CONTINUITY,
        )
        assertTrue(restoredFreshAuthority.outcome is RelayV2TerminalOutcome.Restored)
        assertEquals(nextDelivery, restoredFreshAuthority.checkpoint?.deliveryToken)
        assertTrue(restoredFreshAuthority.effects.isEmpty())
        val rebound = reduce(
            checkpoint,
            RelayV2TerminalAction.RebindDelivery(
                identity,
                checkpoint.deliveryToken,
                nextDelivery,
                PARSER_CONTINUITY,
            ),
        )
        val reboundCheckpoint = requireNotNull(rebound.checkpoint)
        assertEquals(nextDelivery, reboundCheckpoint.deliveryToken)

        val staleRoute = reduce(
            reboundCheckpoint,
            RelayV2TerminalAction.Output(
                actionFence(reboundCheckpoint, deliveryToken = checkpoint.deliveryToken),
                "0",
                RelayV2TerminalBytes.utf8("x"),
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.STALE_DELIVERY,
            (staleRoute.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertEquals(reboundCheckpoint, staleRoute.checkpoint)

        val activationAttempt = openAttempt("open-activation", "activation-fingerprint")
        val activationPending = beginOpen(checkpoint, activationAttempt, "activation-request")
        val activationChanged = reduce(
            activationPending,
            RelayV2TerminalAction.Opened(
                identity.copy(profileActivationGeneration = 8),
                requestId = "activation-request",
                openAttempt = activationAttempt,
                deliveryToken = checkpoint.deliveryToken,
                parserContinuityId = PARSER_CONTINUITY,
                RelayV2TerminalOpenDisposition.RESUMED,
                cols = 120,
                rows = 36,
                replayFromOffset = "0",
                tailOffset = "0",
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.CHECKPOINT_INVALID,
            (activationChanged.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        val resetBarrier = parserResetToken(checkpoint, "restore-reset")
        val exactCorruptClosed = checkpoint.copy(
            phase = RelayV2TerminalPhase.CLOSED_WAITING_PARSER,
            parserResetCallbackToken = resetBarrier,
            closed = closedWatermark(
                finalOffset = "0",
                replayAvailable = true,
                bufferStartOffset = "1",
            ),
        )
        val queued = requireNotNull(output(checkpoint, "0", "x").checkpoint)
        val finalizedClosed = checkpoint.copy(
            phase = RelayV2TerminalPhase.FINALIZED,
            closed = closedWatermark(
                checkpoint = checkpoint,
                finalOffset = "0",
                replayAvailable = false,
                bufferStartOffset = null,
            ),
        )
        val corruptClosedCheckpoints = listOf(
            exactCorruptClosed,
            checkpoint.copy(
                phase = RelayV2TerminalPhase.CLOSED_WAITING_PARSER,
                parserResetCallbackToken = resetBarrier,
            ),
            queued.copy(
                phase = RelayV2TerminalPhase.CLOSED_WAITING_PARSER,
                closed = closedWatermark(
                    finalOffset = "0",
                    replayAvailable = true,
                    bufferStartOffset = "0",
                ),
            ),
            queued.copy(
                phase = RelayV2TerminalPhase.CLOSED_WAITING_PARSER,
                parserResetCallbackToken = resetBarrier,
                closed = closedWatermark(
                    finalOffset = "1",
                    replayAvailable = true,
                    bufferStartOffset = "0",
                ),
            ),
            checkpoint.copy(
                phase = RelayV2TerminalPhase.CLOSED_WAITING_PARSER,
                parserResetCallbackToken = resetBarrier,
                closed = closedWatermark(
                    finalOffset = "0",
                    replayAvailable = false,
                    bufferStartOffset = "0",
                ),
            ),
            finalizedClosed.copy(
                closed = finalizedClosed.closed?.copy(
                    tombstone = finalizedClosed.closed.tombstone.copy(
                        reason = RelayV2TerminalCloseReason.CLIENT_CLOSED,
                        exitCode = null,
                        closeAttempt = null,
                    ),
                ),
            ),
            finalizedClosed.copy(
                closed = finalizedClosed.closed?.copy(
                    tombstone = finalizedClosed.closed.tombstone.copy(exitCode = null),
                ),
            ),
            finalizedClosed.copy(
                closed = finalizedClosed.closed?.copy(
                    tombstone = finalizedClosed.closed.tombstone.copy(
                        generation = "generation-other",
                    ),
                ),
            ),
            finalizedClosed.copy(
                closed = finalizedClosed.closed?.copy(
                    tombstone = finalizedClosed.closed.tombstone.copy(openId = "open-other"),
                ),
            ),
            finalizedClosed.copy(
                pendingClose = RelayV2TerminalPendingClose(
                    closeAttempt(),
                    "close-request-corrupt",
                    listOf("close-request-corrupt"),
                ),
                closed = finalizedClosed.closed?.copy(
                    tombstone = finalizedClosed.closed.tombstone.copy(
                        closeAttempt = closeAttempt(),
                    ),
                ),
            ),
        )
        corruptClosedCheckpoints.forEach { corrupt ->
            val rejected = RelayV2TerminalCheckpointReducer.restore(
                RelayV2TerminalStoredCheckpoint.Present(corrupt),
                identity,
                checkpoint.openAttempt,
                checkpoint.deliveryToken,
                PARSER_CONTINUITY,
            )
            assertEquals(
                RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                (rejected.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
            )
            assertTrue(rejected.effects.single() is RelayV2TerminalEffect.ResetRequired)
        }
    }

    @Test
    fun `network receipt and parser application stay separate across duplicates overlap and one replay`() {
        var checkpoint = open()
        var result = output(checkpoint, "0", "abc")
        checkpoint = requireNotNull(result.checkpoint)
        val firstWrite = result.effects.filterIsInstance<RelayV2TerminalEffect.WriteParser>().single()
        assertEquals("0", checkpoint.parserAppliedNextOffset)
        assertEquals("3", checkpoint.networkReceivedThrough)
        assertFalse(result.effects.any { it is RelayV2TerminalEffect.OutputAck })

        result = output(checkpoint, "3", "def")
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals("0", checkpoint.parserAppliedNextOffset)
        assertEquals("6", checkpoint.networkReceivedThrough)
        assertEquals(2, checkpoint.pendingOutput.size)
        assertTrue(result.effects.isEmpty())

        val fullyPendingDuplicate = output(checkpoint, "3", "def")
        assertEquals(
            RelayV2TerminalIgnoredReason.DUPLICATE_OUTPUT,
            (fullyPendingDuplicate.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertTrue(fullyPendingDuplicate.effects.isEmpty())

        result = output(checkpoint, "4", "efghi")
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals("9", checkpoint.networkReceivedThrough)
        val suffix = checkpoint.pendingOutput.last()
        assertEquals("6", suffix.callbackToken.startOffset)
        assertEquals("9", suffix.callbackToken.endOffset)
        assertArrayEquals("ghi".toByteArray(), suffix.bytes.copyBytes())

        val outOfOrder = reduce(
            checkpoint,
            RelayV2TerminalAction.ParserApplied(suffix.callbackToken),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.OUT_OF_ORDER_PARSER_CALLBACK,
            (outOfOrder.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertEquals("0", outOfOrder.checkpoint?.parserAppliedNextOffset)

        result = reduce(checkpoint, RelayV2TerminalAction.ParserApplied(firstWrite.callbackToken))
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals("3", checkpoint.parserAppliedNextOffset)
        assertEquals("9", checkpoint.networkReceivedThrough)
        assertEquals(
            "3",
            result.effects.filterIsInstance<RelayV2TerminalEffect.OutputAck>().single().nextOffset,
        )
        val secondWrite = result.effects.filterIsInstance<RelayV2TerminalEffect.WriteParser>().single()

        val fullyAppliedDuplicate = output(checkpoint, "0", "abc")
        assertEquals(
            RelayV2TerminalIgnoredReason.DUPLICATE_OUTPUT,
            (fullyAppliedDuplicate.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertEquals(
            "3",
            fullyAppliedDuplicate.effects.filterIsInstance<RelayV2TerminalEffect.OutputAck>()
                .single().nextOffset,
        )

        val duplicateCallback = reduce(
            checkpoint,
            RelayV2TerminalAction.ParserApplied(firstWrite.callbackToken),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.DUPLICATE_PARSER_CALLBACK,
            (duplicateCallback.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )

        result = reduce(checkpoint, RelayV2TerminalAction.ParserApplied(secondWrite.callbackToken))
        checkpoint = requireNotNull(result.checkpoint)
        val thirdWrite = result.effects.filterIsInstance<RelayV2TerminalEffect.WriteParser>().single()
        result = reduce(checkpoint, RelayV2TerminalAction.ParserApplied(thirdWrite.callbackToken))
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals("9", checkpoint.parserAppliedNextOffset)

        result = output(checkpoint, "10", "x")
        checkpoint = requireNotNull(result.checkpoint)
        val replay = result.effects.filterIsInstance<RelayV2TerminalEffect.RequestReplay>().single()
        assertEquals("9", replay.fromOffset)
        assertEquals("replay-1", replay.requestId)
        assertEquals(replay.fence, checkpoint.pendingReplay?.fence)

        val repeatedGap = output(checkpoint, "11", "y")
        assertTrue(repeatedGap.effects.none { it is RelayV2TerminalEffect.RequestReplay })
        assertEquals("replay-1", repeatedGap.checkpoint?.pendingReplay?.requestId)
    }

    @Test
    fun `live output queues behind received replay tail until parser crosses exact boundary`() {
        val initial = open()
        var result = output(initial, "1", "b")
        var checkpoint = requireNotNull(result.checkpoint)
        val replay = result.effects.filterIsInstance<RelayV2TerminalEffect.RequestReplay>().single()
        result = reduce(
            checkpoint,
            RelayV2TerminalAction.ReplayStarted(
                checkpoint.identity,
                checkpoint.openAttempt.openId,
                checkpoint.deliveryToken,
                replay.requestId,
                fromOffset = "0",
                tailOffsetAtStart = "1",
            ),
        )
        checkpoint = requireNotNull(result.checkpoint)

        result = output(checkpoint, "0", "a")
        checkpoint = requireNotNull(result.checkpoint)
        val replayWrite = result.effects.filterIsInstance<RelayV2TerminalEffect.WriteParser>()
            .single()
        result = output(checkpoint, "1", "b")
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals(RelayV2TerminalPhase.REPLAYING, checkpoint.phase)
        assertEquals("1", checkpoint.replayTargetOffset)
        assertEquals("0", checkpoint.parserAppliedNextOffset)
        assertEquals("2", checkpoint.networkReceivedThrough)
        assertEquals(2, checkpoint.pendingOutput.size)
        assertTrue(result.effects.isEmpty())

        result = reduce(
            checkpoint,
            RelayV2TerminalAction.ParserApplied(replayWrite.callbackToken),
        )
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals(RelayV2TerminalPhase.LIVE, checkpoint.phase)
        assertEquals("1", checkpoint.parserAppliedNextOffset)
        val liveWrite = result.effects.filterIsInstance<RelayV2TerminalEffect.WriteParser>().single()
        result = reduce(checkpoint, RelayV2TerminalAction.ParserApplied(liveWrite.callbackToken))
        assertEquals("2", result.checkpoint?.parserAppliedNextOffset)
        assertTrue(result.outcome is RelayV2TerminalOutcome.ParserAdvanced)
    }

    @Test
    fun `parser callback token fences full identity delivery continuity and exact range`() {
        var checkpoint = open()
        val queued = output(checkpoint, "0", "abc")
        checkpoint = requireNotNull(queued.checkpoint)
        val callback = queued.effects.filterIsInstance<RelayV2TerminalEffect.WriteParser>()
            .single().callbackToken

        val staleTokens = listOf(
            callback.copy(parserContinuityId = "rebuilt-parser"),
            callback.copy(
                fence = callback.fence.copy(
                    openAttempt = openAttempt("other-open", "other-fingerprint"),
                ),
            ),
            callback.copy(
                fence = callback.fence.copy(
                    deliveryToken = delivery(deliverySequence = 9, connectionGeneration = 9),
                ),
            ),
        )
        staleTokens.forEach { stale ->
            val result = reduce(checkpoint, RelayV2TerminalAction.ParserApplied(stale))
            assertEquals(
                RelayV2TerminalIgnoredReason.STALE_PARSER_CALLBACK,
                (result.outcome as RelayV2TerminalOutcome.Ignored).reason,
            )
            assertEquals("0", result.checkpoint?.parserAppliedNextOffset)
        }

        val wrongRange = callback.copy(endOffset = "4")
        val wrongRangeResult = reduce(
            checkpoint,
            RelayV2TerminalAction.ParserApplied(wrongRange),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.OUT_OF_ORDER_PARSER_CALLBACK,
            (wrongRangeResult.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertEquals("0", wrongRangeResult.checkpoint?.parserAppliedNextOffset)

        val applied = reduce(checkpoint, RelayV2TerminalAction.ParserApplied(callback))
        assertEquals("3", applied.checkpoint?.parserAppliedNextOffset)
    }

    @Test
    fun `pending byte and item bounds fail closed while control paths stay deliverable`() {
        val itemFull = fillPendingFrames(
            frameCount = RelayV2TerminalCheckpointLimits.MAX_PENDING_OUTPUT_FRAMES,
            frameBytes = 1,
        )
        assertEquals("0", itemFull.parserAppliedNextOffset)
        assertEquals(
            RelayV2TerminalCheckpointLimits.MAX_PENDING_OUTPUT_FRAMES,
            itemFull.pendingOutput.size,
        )

        val replayAtLimit = output(
            itemFull,
            (RelayV2TerminalCheckpointLimits.MAX_PENDING_OUTPUT_FRAMES + 1).toString(),
            "x",
        )
        assertTrue(replayAtLimit.effects.single() is RelayV2TerminalEffect.RequestReplay)

        val closedAtLimit = reduce(
            itemFull,
            closedAction(
                itemFull,
                finalOffset = (RelayV2TerminalCheckpointLimits.MAX_PENDING_OUTPUT_FRAMES + 1)
                    .toString(),
                replayAvailable = true,
                bufferStartOffset = "0",
            ),
        )
        assertTrue(closedAtLimit.effects.single() is RelayV2TerminalEffect.RequestReplay)
        assertNotNull(closedAtLimit.checkpoint?.closed)

        val closeAtLimit = reduce(
            itemFull,
            RelayV2TerminalAction.RequestClose(
                itemFull.deliveryToken,
                closeAttempt(),
                "close-limit-request",
            ),
        )
        assertTrue(closeAtLimit.effects.first() is RelayV2TerminalEffect.SendClose)

        var result = output(itemFull, itemFull.networkReceivedThrough, "x")
        val itemReset = requireNotNull(result.checkpoint)
        assertEquals(
            RelayV2TerminalResetReason.SLOW_CONSUMER,
            (result.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        assertEquals(
            RelayV2TerminalCheckpointLimits.MAX_PENDING_OUTPUT_FRAMES,
            itemReset.pendingOutput.size,
        )
        assertTrue(result.effects.single() is RelayV2TerminalEffect.ResetRequired)

        result = reduce(
            itemReset,
            RelayV2TerminalAction.RequestClose(
                itemReset.deliveryToken,
                closeAttempt(),
                "close-reset-request",
            ),
        )
        assertEquals(
            listOf(
                RelayV2TerminalEffect.SendClose::class,
                RelayV2TerminalEffect.ResetRequired::class,
            ),
            result.effects.map { it::class },
        )

        result = reduce(
            itemReset,
            closedAction(
                itemReset,
                finalOffset = itemReset.networkReceivedThrough,
                replayAvailable = false,
                bufferStartOffset = null,
            ),
        )
        assertNotNull(result.checkpoint?.closed)
        assertTrue(result.effects.single() is RelayV2TerminalEffect.ResetRequired)

        val byteFull = fillPendingFrames(
            frameCount = RelayV2TerminalCheckpointLimits.MAX_PENDING_OUTPUT_BYTES /
                RelayV2TerminalCheckpointLimits.MAX_FRAME_BYTES,
            frameBytes = RelayV2TerminalCheckpointLimits.MAX_FRAME_BYTES,
        )
        assertEquals(
            RelayV2TerminalCheckpointLimits.MAX_PENDING_OUTPUT_BYTES,
            byteFull.pendingOutput.sumOf { it.bytes.size },
        )
        val byteReset = output(byteFull, byteFull.networkReceivedThrough, "x")
        assertEquals(
            RelayV2TerminalResetReason.SLOW_CONSUMER,
            (byteReset.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        assertEquals(
            RelayV2TerminalCheckpointLimits.MAX_PENDING_OUTPUT_BYTES,
            byteReset.checkpoint?.pendingOutput?.sumOf { it.bytes.size },
        )

        val zeroStart = open()
        val zeroFrame = reduce(
            zeroStart,
            RelayV2TerminalAction.Output(
                actionFence(zeroStart),
                "0",
                RelayV2TerminalBytes.of(byteArrayOf()),
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            (zeroFrame.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
    }

    @Test
    fun `closed waits for received bytes to apply and finalized state rejects late revival`() {
        var checkpoint = open()
        val oldDelivery = checkpoint.deliveryToken
        val activeDelivery = delivery(deliverySequence = 2, connectionGeneration = 2)
        checkpoint = requireNotNull(
            reduce(
                checkpoint,
                RelayV2TerminalAction.RebindDelivery(
                    checkpoint.identity,
                    checkpoint.deliveryToken,
                    activeDelivery,
                    checkpoint.parserContinuityId,
                ),
            ).checkpoint,
        )
        val queued = output(checkpoint, "0", "abc")
        checkpoint = requireNotNull(queued.checkpoint)
        val callback = queued.effects.filterIsInstance<RelayV2TerminalEffect.WriteParser>()
            .single().callbackToken

        var result = reduce(
            checkpoint,
            closedAction(
                checkpoint,
                finalOffset = "3",
                replayAvailable = true,
                bufferStartOffset = "0",
            ),
        )
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals(RelayV2TerminalPhase.CLOSED_WAITING_PARSER, checkpoint.phase)
        assertTrue(result.effects.none { it is RelayV2TerminalEffect.RequestReplay })

        result = reduce(checkpoint, RelayV2TerminalAction.ParserApplied(callback))
        val finalized = requireNotNull(result.checkpoint)
        assertEquals(RelayV2TerminalPhase.FINALIZED, finalized.phase)
        assertTrue(result.outcome is RelayV2TerminalOutcome.ClosedFinalized)
        assertEquals(
            listOf(
                RelayV2TerminalEffect.OutputAck::class,
                RelayV2TerminalEffect.FinalizeClosed::class,
            ),
            result.effects.map { it::class },
        )

        val lateActions: List<RelayV2TerminalAction> = listOf(
            RelayV2TerminalAction.VerifyContinuity(
                finalized.identity,
                finalized.deliveryToken,
                finalized.parserContinuityId,
            ),
            RelayV2TerminalAction.RebindDelivery(
                finalized.identity,
                finalized.deliveryToken,
                delivery(deliverySequence = 3, connectionGeneration = 3),
                finalized.parserContinuityId,
            ),
            RelayV2TerminalAction.Output(
                actionFence(finalized),
                "3",
                RelayV2TerminalBytes.utf8("x"),
            ),
            RelayV2TerminalAction.Output(
                actionFence(finalized, deliveryToken = oldDelivery),
                "3",
                RelayV2TerminalBytes.utf8("x"),
            ),
            RelayV2TerminalAction.ReplayStarted(
                finalized.identity,
                finalized.openAttempt.openId,
                finalized.deliveryToken,
                requestId = "late-replay",
                fromOffset = "3",
                tailOffsetAtStart = "3",
            ),
            RelayV2TerminalAction.ParserApplied(callback),
            RelayV2TerminalAction.ParserFailed(callback),
            RelayV2TerminalAction.ParserResetApplied(callback),
            RelayV2TerminalAction.EnqueueInput(
                finalized.deliveryToken,
                RelayV2TerminalBytes.utf8("x"),
            ),
            RelayV2TerminalAction.InputSent(actionFence(finalized), "1"),
            RelayV2TerminalAction.InputAck(actionFence(finalized), "1"),
            RelayV2TerminalAction.InputError(
                actionFence(finalized),
                inputSeq = "1",
                ackedThroughInputSeq = "0",
                error = RelayV2TerminalControlError.GAP,
            ),
            RelayV2TerminalAction.EnqueueResize(finalized.deliveryToken, 120, 36),
            RelayV2TerminalAction.ResizeSent(actionFence(finalized), "1"),
            RelayV2TerminalAction.ResizeAck(actionFence(finalized), "1"),
            RelayV2TerminalAction.ResizeError(
                actionFence(finalized),
                resizeSeq = "1",
                ackedThroughResizeSeq = "0",
                error = RelayV2TerminalControlError.GAP,
            ),
            RelayV2TerminalAction.RetryUnackedControls(finalized.deliveryToken),
            RelayV2TerminalAction.RetryReplay(finalized.deliveryToken, "late-replay-request"),
            RelayV2TerminalAction.RequestClose(
                finalized.deliveryToken,
                closeAttempt(),
                "late-close-request",
            ),
            closedAction(
                finalized,
                finalOffset = "3",
                replayAvailable = true,
                bufferStartOffset = "0",
            ),
            RelayV2TerminalAction.AsyncResetRequired(
                actionFence(finalized),
                correlationProofId = "late-async-reset",
                reason = RelayV2TerminalResetReason.STREAM_LOST,
                requestedOffset = "3",
                bufferStartOffset = null,
                tailOffset = null,
            ),
            RelayV2TerminalAction.AsyncResetRequired(
                actionFence(finalized, deliveryToken = oldDelivery),
                correlationProofId = "late-old-async-reset",
                reason = RelayV2TerminalResetReason.STREAM_LOST,
                requestedOffset = "3",
                bufferStartOffset = null,
                tailOffset = null,
            ),
            RelayV2TerminalAction.CorrelatedResetRequired(
                actionFence(finalized),
                origin = RelayV2TerminalResetOrigin.REPLAY,
                requestId = "late-correlated-reset",
                reason = RelayV2TerminalResetReason.STREAM_LOST,
                requestedOffset = null,
                bufferStartOffset = null,
                tailOffset = null,
            ),
        )
        lateActions.forEach { action ->
            val late = reduce(finalized, action)
            assertEquals(
                RelayV2TerminalIgnoredReason.FINALIZED_LATE_EVENT,
                (late.outcome as RelayV2TerminalOutcome.Ignored).reason,
            )
            assertTrue(finalized === late.checkpoint)
            assertTrue(late.effects.isEmpty())
        }
        val unauthorizedOpenAttempt = openAttempt("late-open", "late-open-fingerprint")
        val unauthorizedOpen = reduce(
            finalized,
            RelayV2TerminalAction.Opened(
                finalized.identity.copy(
                    generation = "generation-late",
                    resumeTokenCredentialReference = "resume-token-ref-late",
                    resumeTokenCredentialFingerprint = "resume-token-fingerprint-late",
                ),
                requestId = "late-open-request",
                openAttempt = unauthorizedOpenAttempt,
                deliveryToken = finalized.deliveryToken,
                parserContinuityId = finalized.parserContinuityId,
                disposition = RelayV2TerminalOpenDisposition.RESET,
                cols = finalized.openedCols,
                rows = finalized.openedRows,
                replayFromOffset = "0",
                tailOffset = "0",
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.FINALIZED_LATE_EVENT,
            (unauthorizedOpen.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertTrue(finalized === unauthorizedOpen.checkpoint)
        assertTrue(unauthorizedOpen.effects.isEmpty())
        val lateBegin = reduce(
            finalized,
            RelayV2TerminalAction.BeginOpenAttempt(
                finalized.deliveryToken,
                requestId = "late-open-request",
                openAttempt = unauthorizedOpenAttempt,
                mode = RelayV2TerminalOpenMode.RESET,
                cols = finalized.openedCols,
                rows = finalized.openedRows,
                target = finalized.identity.target(),
                parserContinuityId = finalized.parserContinuityId,
                resume = openResume(finalized, null),
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.FINALIZED_LATE_EVENT,
            (lateBegin.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertTrue(finalized === lateBegin.checkpoint)
        val authorizedPending = requireNotNull(lateBegin.checkpoint)
        val authorizedOpen = reduce(
            authorizedPending,
            RelayV2TerminalAction.Opened(
                finalized.identity.copy(
                    generation = "generation-late",
                    resumeTokenCredentialReference = "resume-token-ref-late",
                    resumeTokenCredentialFingerprint = "resume-token-fingerprint-late",
                ),
                requestId = "late-open-request",
                openAttempt = unauthorizedOpenAttempt,
                deliveryToken = finalized.deliveryToken,
                parserContinuityId = finalized.parserContinuityId,
                disposition = RelayV2TerminalOpenDisposition.RESET,
                cols = finalized.openedCols,
                rows = finalized.openedRows,
                replayFromOffset = "0",
                tailOffset = "0",
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.FINALIZED_LATE_EVENT,
            (authorizedOpen.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertTrue(finalized === authorizedOpen.checkpoint)
        assertTrue(authorizedOpen.effects.isEmpty())
    }

    @Test
    fun `parser reset remains a hard barrier across closed replay and queued output`() {
        val previous = open()
        val resetIdentity = previous.identity.copy(
            generation = "generation-2",
            resumeTokenCredentialReference = "resume-token-ref-2",
            resumeTokenCredentialFingerprint = "resume-token-fingerprint-2",
        )
        val resetAttempt = openAttempt("open-reset-2", "reset-fingerprint-2")
        val resetPending = beginOpen(
            previous,
            resetAttempt,
            "reset-request-2",
            RelayV2TerminalOpenMode.RESET,
        )
        var result = reduce(
            resetPending,
            RelayV2TerminalAction.Opened(
                resetIdentity,
                requestId = "reset-request-2",
                openAttempt = resetAttempt,
                deliveryToken = previous.deliveryToken,
                parserContinuityId = PARSER_CONTINUITY,
                RelayV2TerminalOpenDisposition.RESET,
                cols = 120,
                rows = 36,
                replayFromOffset = "0",
                tailOffset = "0",
            ),
        )
        var checkpoint = requireNotNull(result.checkpoint)
        val resetCallback = result.effects.filterIsInstance<RelayV2TerminalEffect.ResetParser>()
            .single().callbackToken

        result = reduce(
            checkpoint,
            closedAction(
                checkpoint,
                finalOffset = "2",
                replayAvailable = true,
                bufferStartOffset = "0",
            ),
        )
        checkpoint = requireNotNull(result.checkpoint)
        val replay = result.effects.filterIsInstance<RelayV2TerminalEffect.RequestReplay>().single()
        assertNotNull(checkpoint.parserResetCallbackToken)

        result = reduce(
            checkpoint,
            RelayV2TerminalAction.ReplayStarted(
                checkpoint.identity,
                checkpoint.openAttempt.openId,
                checkpoint.deliveryToken,
                replay.requestId,
                fromOffset = "0",
                tailOffsetAtStart = "2",
            ),
        )
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals(RelayV2TerminalPhase.REPLAYING, checkpoint.phase)
        assertTrue(result.effects.isEmpty())

        result = output(checkpoint, "0", "ab")
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals("2", checkpoint.networkReceivedThrough)
        assertEquals("0", checkpoint.parserAppliedNextOffset)
        assertNull(checkpoint.parserInFlightCallbackToken)
        assertTrue(result.effects.none { it is RelayV2TerminalEffect.WriteParser })
        assertTrue(result.effects.none { it is RelayV2TerminalEffect.OutputAck })
        assertNotNull(checkpoint.closed)

        result = reduce(
            checkpoint,
            RelayV2TerminalAction.ParserResetApplied(resetCallback),
        )
        checkpoint = requireNotNull(result.checkpoint)
        val write = result.effects.filterIsInstance<RelayV2TerminalEffect.WriteParser>().single()
        assertNull(checkpoint.parserResetCallbackToken)
        assertEquals(write.callbackToken, checkpoint.parserInFlightCallbackToken)
        assertNotNull(checkpoint.closed)

        result = reduce(
            checkpoint,
            RelayV2TerminalAction.ParserApplied(write.callbackToken),
        )
        assertEquals(RelayV2TerminalPhase.FINALIZED, result.checkpoint?.phase)
        assertEquals("2", result.checkpoint?.parserAppliedNextOffset)
        assertEquals(
            listOf(
                RelayV2TerminalEffect.OutputAck::class,
                RelayV2TerminalEffect.FinalizeClosed::class,
            ),
            result.effects.map { it::class },
        )
    }

    @Test
    fun `replay started is correlated to full binding request and closed recovery truncates`() {
        val start = open()
        var result = reduce(
            start,
            closedAction(
                start,
                finalOffset = "3",
                replayAvailable = true,
                bufferStartOffset = "0",
            ),
        )
        val replaying = requireNotNull(result.checkpoint)
        val request = result.effects.filterIsInstance<RelayV2TerminalEffect.RequestReplay>().single()
        assertEquals(request.requestId, replaying.pendingReplay?.requestId)

        val wrongCorrelation = reduce(
            replaying,
            RelayV2TerminalAction.ReplayStarted(
                replaying.identity,
                replaying.openAttempt.openId,
                replaying.deliveryToken,
                requestId = "other-request",
                fromOffset = "0",
                tailOffsetAtStart = "3",
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            (wrongCorrelation.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        listOf(
            RelayV2TerminalAction.ReplayStarted(
                replaying.identity,
                replaying.openAttempt.openId,
                replaying.deliveryToken,
                requestId = request.requestId,
                fromOffset = "1",
                tailOffsetAtStart = "3",
            ),
            RelayV2TerminalAction.ReplayStarted(
                replaying.identity,
                replaying.openAttempt.openId,
                delivery(connectionGeneration = 2, deliverySequence = 2),
                requestId = request.requestId,
                fromOffset = "0",
                tailOffsetAtStart = "3",
            ),
        ).forEach { conflictingCurrentResponse ->
            val rejected = reduce(replaying, conflictingCurrentResponse)
            assertEquals(
                RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
                (rejected.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
            )
        }

        result = reduce(
            replaying,
            RelayV2TerminalAction.ReplayStarted(
                replaying.identity,
                replaying.openAttempt.openId,
                replaying.deliveryToken,
                request.requestId,
                request.fromOffset,
                tailOffsetAtStart = "3",
            ),
        )
        var checkpoint = requireNotNull(result.checkpoint)
        assertEquals(RelayV2TerminalPhase.REPLAYING, checkpoint.phase)
        assertNull(checkpoint.pendingReplay)
        val queued = output(checkpoint, "0", "abc")
        checkpoint = requireNotNull(queued.checkpoint)
        val callback = queued.effects.filterIsInstance<RelayV2TerminalEffect.WriteParser>()
            .single().callbackToken
        result = reduce(checkpoint, RelayV2TerminalAction.ParserApplied(callback))
        assertEquals(RelayV2TerminalPhase.FINALIZED, result.checkpoint?.phase)

        val unavailable = reduce(
            start,
            closedAction(
                start,
                finalOffset = "5",
                replayAvailable = false,
                bufferStartOffset = null,
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.OFFSET_EXPIRED,
            (unavailable.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        assertEquals(
            listOf(
                RelayV2TerminalEffect.DisplayTruncated::class,
                RelayV2TerminalEffect.ResetRequired::class,
            ),
            unavailable.effects.map { it::class },
        )
    }

    @Test
    fun `input resize ack resend immutable dispatch gap conflict and reset remain separate`() {
        var checkpoint = open()
        var result = reduce(
            checkpoint,
            RelayV2TerminalAction.EnqueueInput(
                checkpoint.deliveryToken,
                RelayV2TerminalBytes.utf8("a"),
            ),
        )
        checkpoint = requireNotNull(result.checkpoint)
        val firstInput = result.effects.filterIsInstance<RelayV2TerminalEffect.SendInput>().single()
        assertEquals("1", firstInput.inputSeq)

        val retry = reduce(
            checkpoint,
            RelayV2TerminalAction.RetryUnackedControls(checkpoint.deliveryToken),
        ).effects.filterIsInstance<RelayV2TerminalEffect.SendInput>().single()
        assertEquals(firstInput.inputSeq, retry.inputSeq)
        assertEquals(firstInput.bytes, retry.bytes)

        result = reduce(
            checkpoint,
            RelayV2TerminalAction.InputAck(actionFence(checkpoint), "1"),
        )
        assertEquals(
            RelayV2TerminalControlRejectionReason.ACK_BEYOND_SENT,
            (result.outcome as RelayV2TerminalOutcome.ControlRejected).reason,
        )
        checkpoint = requireNotNull(
            reduce(
                checkpoint,
                RelayV2TerminalAction.InputSent(actionFence(checkpoint), "1"),
            ).checkpoint,
        )
        checkpoint = requireNotNull(
            reduce(
                checkpoint,
                RelayV2TerminalAction.InputAck(actionFence(checkpoint), "1"),
            ).checkpoint,
        )
        assertEquals("1", checkpoint.ackedThroughInputSeq)

        result = reduce(
            checkpoint,
            RelayV2TerminalAction.EnqueueResize(checkpoint.deliveryToken, 100, 30),
        )
        checkpoint = requireNotNull(result.checkpoint)
        result = reduce(
            checkpoint,
            RelayV2TerminalAction.EnqueueResize(checkpoint.deliveryToken, 120, 36),
        )
        checkpoint = requireNotNull(result.checkpoint)
        val secondResize = result.effects.filterIsInstance<RelayV2TerminalEffect.SendResize>().single()
        assertEquals("2", secondResize.resizeSeq)
        assertEquals(120, secondResize.cols)
        assertEquals("3", checkpoint.nextResizeSeq)
        assertEquals(listOf(100, 120), checkpoint.pendingResizes.map { it.cols })

        checkpoint = requireNotNull(
            reduce(
                checkpoint,
                RelayV2TerminalAction.ResizeSent(actionFence(checkpoint), "1"),
            ).checkpoint,
        )
        result = reduce(
            checkpoint,
            RelayV2TerminalAction.EnqueueResize(checkpoint.deliveryToken, 140, 40),
        )
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals("3", result.effects.filterIsInstance<RelayV2TerminalEffect.SendResize>()
            .single().resizeSeq)
        assertEquals(listOf("1", "2", "3"), checkpoint.pendingResizes.map { it.resizeSeq })

        result = reduce(
            checkpoint,
            RelayV2TerminalAction.ResizeAck(actionFence(checkpoint), "2"),
        )
        assertEquals(
            RelayV2TerminalControlRejectionReason.ACK_BEYOND_SENT,
            (result.outcome as RelayV2TerminalOutcome.ControlRejected).reason,
        )

        result = reduce(
            checkpoint,
            RelayV2TerminalAction.EnqueueInput(
                checkpoint.deliveryToken,
                RelayV2TerminalBytes.utf8("b"),
            ),
        )
        checkpoint = requireNotNull(result.checkpoint)
        checkpoint = requireNotNull(
            reduce(
                checkpoint,
                RelayV2TerminalAction.InputSent(actionFence(checkpoint), "2"),
            ).checkpoint,
        )
        val gap = reduce(
            checkpoint,
            RelayV2TerminalAction.InputError(
                actionFence(checkpoint),
                inputSeq = "3",
                ackedThroughInputSeq = "1",
                error = RelayV2TerminalControlError.GAP,
            ),
        )
        assertEquals(
            RelayV2TerminalControlRejectionReason.GAP,
            (gap.outcome as RelayV2TerminalOutcome.ControlRejected).reason,
        )
        assertEquals(
            listOf("2"),
            gap.effects.filterIsInstance<RelayV2TerminalEffect.SendInput>().map { it.inputSeq },
        )

        val conflict = reduce(
            checkpoint,
            RelayV2TerminalAction.InputError(
                actionFence(checkpoint),
                inputSeq = "2",
                ackedThroughInputSeq = "1",
                error = RelayV2TerminalControlError.CONFLICT,
            ),
        )
        assertEquals(
            RelayV2TerminalControlRejectionReason.CONFLICT,
            (conflict.outcome as RelayV2TerminalOutcome.ControlRejected).reason,
        )
        assertEquals(1, conflict.checkpoint?.ambiguousInputs?.size)

        val resetIdentity = checkpoint.identity.copy(
            generation = "generation-2",
            resumeTokenCredentialReference = "resume-token-ref-2",
            resumeTokenCredentialFingerprint = "resume-token-fingerprint-2",
        )
        val resetDelivery = delivery(deliverySequence = 2, connectionGeneration = 2)
        val resetSource = requireNotNull(
            reduce(
                checkpoint,
                RelayV2TerminalAction.RebindDelivery(
                    checkpoint.identity,
                    checkpoint.deliveryToken,
                    resetDelivery,
                    PARSER_CONTINUITY,
                ),
            ).checkpoint,
        )
        val controlResetAttempt = openAttempt("open-control-reset", "control-reset-fingerprint")
        val controlResetPending = beginOpen(
            resetSource,
            controlResetAttempt,
            "control-reset-request",
            RelayV2TerminalOpenMode.RESET,
            cols = 80,
            rows = 24,
        )
        result = reduce(
            controlResetPending,
            RelayV2TerminalAction.Opened(
                resetIdentity,
                requestId = "control-reset-request",
                openAttempt = controlResetAttempt,
                deliveryToken = resetDelivery,
                parserContinuityId = PARSER_CONTINUITY,
                RelayV2TerminalOpenDisposition.RESET,
                cols = 80,
                rows = 24,
                replayFromOffset = "0",
                tailOffset = "0",
            ),
        )
        val resetGeneration = requireNotNull(result.checkpoint)
        assertEquals(listOf("2"), resetGeneration.ambiguousInputs.map { it.inputSeq })
        assertTrue(resetGeneration.pendingResizes.isEmpty())
        assertEquals("1", resetGeneration.nextResizeSeq)
        assertEquals(80, resetGeneration.openedCols)
        assertEquals(24, resetGeneration.openedRows)
        assertEquals(
            1,
            result.effects.filterIsInstance<RelayV2TerminalEffect.ControlsBecameAmbiguous>()
                .single().inputCount,
        )
        val resetCallback = result.effects.filterIsInstance<RelayV2TerminalEffect.ResetParser>()
            .single().callbackToken
        val closedBeforeParserReset = reduce(
            resetGeneration,
            closedAction(
                resetGeneration,
                finalOffset = "0",
                replayAvailable = true,
                bufferStartOffset = "0",
            ),
        )
        val waitingForReset = requireNotNull(closedBeforeParserReset.checkpoint)
        assertEquals(RelayV2TerminalPhase.CLOSED_WAITING_PARSER, waitingForReset.phase)
        assertTrue(closedBeforeParserReset.effects.isEmpty())
        val finalizedAfterReset = reduce(
            waitingForReset,
            RelayV2TerminalAction.ParserResetApplied(resetCallback),
        )
        assertEquals(RelayV2TerminalPhase.FINALIZED, finalizedAfterReset.checkpoint?.phase)
        assertTrue(finalizedAfterReset.outcome is RelayV2TerminalOutcome.ClosedFinalized)
    }

    @Test
    fun `stale generation host lineage ack ahead and uint64 overflow are structured`() {
        val checkpoint = open()
        val staleGeneration = reduce(
            checkpoint,
            RelayV2TerminalAction.Output(
                actionFence(checkpoint, generation = "generation-old"),
                "0",
                RelayV2TerminalBytes.utf8("x"),
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.STALE_GENERATION,
            (staleGeneration.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )

        val changedHost = reduce(
            checkpoint,
            RelayV2TerminalAction.Output(
                actionFence(checkpoint, hostInstanceId = "host-process-2"),
                "0",
                RelayV2TerminalBytes.utf8("x"),
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.STREAM_LOST,
            (changedHost.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        val ackAhead = reduce(
            checkpoint,
            RelayV2TerminalAction.InputAck(actionFence(checkpoint), UINT64_MAX),
        )
        assertEquals(
            RelayV2TerminalControlRejectionReason.ACK_BEYOND_SENT,
            (ackAhead.outcome as RelayV2TerminalOutcome.ControlRejected).reason,
        )

        data class OverflowCase(
            val checkpoint: RelayV2TerminalCheckpoint,
            val action: RelayV2TerminalAction,
            val expectedReason: RelayV2TerminalResetReason,
        )

        val inputOverflow = checkpoint.copy(
            ackedThroughInputSeq = UINT64_MAX_MINUS_ONE,
            nextInputSeq = UINT64_MAX,
        )
        val resizeOverflow = checkpoint.copy(
            ackedThroughResizeSeq = UINT64_MAX_MINUS_ONE,
            nextResizeSeq = UINT64_MAX,
        )
        listOf(
            OverflowCase(
                checkpoint.copy(nextParserOperationSeq = UINT64_MAX),
                RelayV2TerminalAction.Output(
                    actionFence(checkpoint),
                    "0",
                    RelayV2TerminalBytes.utf8("x"),
                ),
                RelayV2TerminalResetReason.CHECKPOINT_INVALID,
            ),
            OverflowCase(
                checkpoint.copy(nextReplayRequestSeq = UINT64_MAX),
                RelayV2TerminalAction.Output(
                    actionFence(checkpoint),
                    "1",
                    RelayV2TerminalBytes.utf8("x"),
                ),
                RelayV2TerminalResetReason.CHECKPOINT_INVALID,
            ),
            OverflowCase(
                inputOverflow,
                RelayV2TerminalAction.EnqueueInput(
                    inputOverflow.deliveryToken,
                    RelayV2TerminalBytes.utf8("x"),
                ),
                RelayV2TerminalResetReason.CHECKPOINT_INVALID,
            ),
            OverflowCase(
                resizeOverflow,
                RelayV2TerminalAction.EnqueueResize(resizeOverflow.deliveryToken, 120, 36),
                RelayV2TerminalResetReason.CHECKPOINT_INVALID,
            ),
            OverflowCase(
                checkpoint,
                RelayV2TerminalAction.Output(
                    actionFence(checkpoint),
                    UINT64_MAX,
                    RelayV2TerminalBytes.utf8("x"),
                ),
                RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            ),
        ).forEach { case ->
            val result = reduce(case.checkpoint, case.action)
            assertEquals(
                case.expectedReason,
                (result.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
            )
        }
    }

    @Test
    fun `open attempts rotate independently from stable timeline and conflict fail closed`() {
        val initial = open()
        val resumeAttempt = openAttempt("open-resume", "resume-fingerprint")
        val pendingResume = beginOpen(initial, resumeAttempt, "resume-request")
        val resumed = requireNotNull(
            reduce(
                pendingResume,
                RelayV2TerminalAction.Opened(
                    initial.identity,
                    requestId = "resume-request",
                    openAttempt = resumeAttempt,
                    deliveryToken = initial.deliveryToken,
                    parserContinuityId = PARSER_CONTINUITY,
                    disposition = RelayV2TerminalOpenDisposition.RESUMED,
                    cols = 120,
                    rows = 36,
                    replayFromOffset = "0",
                    tailOffset = "0",
                ),
            ).checkpoint,
        )
        assertEquals(initial.identity, resumed.identity)
        assertEquals(resumeAttempt, resumed.openAttempt)

        val resetAttempt = openAttempt("open-reset", "reset-fingerprint")
        val pendingReset = beginOpen(
            initial,
            resetAttempt,
            "reset-request",
            RelayV2TerminalOpenMode.RESET,
        )
        val resetIdentity = initial.identity.copy(
            generation = "generation-2",
            resumeTokenCredentialReference = "resume-token-ref-2",
            resumeTokenCredentialFingerprint = "resume-token-fingerprint-2",
        )
        val reset = reduce(
            pendingReset,
            RelayV2TerminalAction.Opened(
                resetIdentity,
                requestId = "reset-request",
                openAttempt = resetAttempt,
                deliveryToken = initial.deliveryToken,
                parserContinuityId = PARSER_CONTINUITY,
                disposition = RelayV2TerminalOpenDisposition.RESET,
                cols = 120,
                rows = 36,
                replayFromOffset = "0",
                tailOffset = "0",
            ),
        )
        assertEquals(resetAttempt, reset.checkpoint?.openAttempt)
        assertEquals("generation-2", reset.checkpoint?.identity?.generation)
        assertTrue(reset.effects.single() is RelayV2TerminalEffect.ResetParser)

        val conflictingFingerprint = reduce(
            initial,
            RelayV2TerminalAction.BeginOpenAttempt(
                initial.deliveryToken,
                "conflict-request",
                initial.openAttempt.copy(fingerprint = "different-fingerprint"),
                RelayV2TerminalOpenMode.RESUME,
                initial.openedCols,
                initial.openedRows,
                initial.identity.target(),
                initial.parserContinuityId,
                openResume(initial, initial.parserAppliedNextOffset),
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            (conflictingFingerprint.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        val hostResetAttempt = openAttempt("open-host-reset", "host-reset-fingerprint")
        val pendingHostReset = beginOpen(initial, hostResetAttempt, "host-reset-request")
        val staleHostReset = reduce(
            pendingHostReset,
            RelayV2TerminalAction.CorrelatedResetRequired(
                actionFence(pendingHostReset),
                origin = RelayV2TerminalResetOrigin.OPEN,
                requestId = "old-open-request",
                openAttempt = hostResetAttempt,
                reason = RelayV2TerminalResetReason.STREAM_LOST,
                requestedOffset = null,
                bufferStartOffset = null,
                tailOffset = null,
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.STALE_RESET_RESPONSE,
            (staleHostReset.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        val exactHostReset = reduce(
            pendingHostReset,
            RelayV2TerminalAction.CorrelatedResetRequired(
                actionFence(pendingHostReset),
                origin = RelayV2TerminalResetOrigin.OPEN,
                requestId = "host-reset-request",
                openAttempt = hostResetAttempt,
                reason = RelayV2TerminalResetReason.STREAM_LOST,
                requestedOffset = null,
                bufferStartOffset = null,
                tailOffset = null,
            ),
        )
        assertEquals(RelayV2TerminalPhase.RESET_REQUIRED, exactHostReset.checkpoint?.phase)
    }

    @Test
    fun `replay rebind requires fresh request redrive and stale reset cannot kill timeline`() {
        val initial = open()
        var result = output(initial, "1", "x")
        val requested = requireNotNull(result.checkpoint)
        val firstRequest = result.effects.filterIsInstance<RelayV2TerminalEffect.RequestReplay>()
            .single()
        val duplicateReplayAttempt = reduce(
            requested,
            RelayV2TerminalAction.RetryReplay(
                requested.deliveryToken,
                firstRequest.requestId,
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.NETWORK_REQUEST_ID_REUSED,
            (duplicateReplayAttempt.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertTrue(requested === duplicateReplayAttempt.checkpoint)
        assertTrue(duplicateReplayAttempt.effects.isEmpty())
        val restored = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(requested),
            requested.identity,
            requested.openAttempt,
            requested.deliveryToken,
            requested.parserContinuityId,
        )
        assertTrue(restored.effects.isEmpty())
        result = reduce(
            requireNotNull(restored.checkpoint),
            RelayV2TerminalAction.RetryReplay(
                requested.deliveryToken,
                requestId = "replay-after-restore",
            ),
        )
        val restoredRequested = requireNotNull(result.checkpoint)
        assertEquals(
            "replay-after-restore",
            result.effects.filterIsInstance<RelayV2TerminalEffect.RequestReplay>().single().requestId,
        )
        val reusedReplayRequest = reduce(
            restoredRequested,
            RelayV2TerminalAction.RetryReplay(
                restoredRequested.deliveryToken,
                firstRequest.requestId,
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.NETWORK_REQUEST_ID_REUSED,
            (reusedReplayRequest.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertTrue(restoredRequested === reusedReplayRequest.checkpoint)
        assertTrue(reusedReplayRequest.effects.isEmpty())
        val lateFirstReplay = reduce(
            restoredRequested,
            RelayV2TerminalAction.ReplayStarted(
                restoredRequested.identity,
                restoredRequested.openAttempt.openId,
                restoredRequested.deliveryToken,
                firstRequest.requestId,
                fromOffset = "0",
                tailOffsetAtStart = "0",
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.STALE_REPLAY_RESPONSE,
            (lateFirstReplay.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertTrue(restoredRequested === lateFirstReplay.checkpoint)
        val reboundDelivery = delivery(connectionGeneration = 1, deliverySequence = 2)
        result = reduce(
            restoredRequested,
            RelayV2TerminalAction.RebindDelivery(
                restoredRequested.identity,
                restoredRequested.deliveryToken,
                reboundDelivery,
                restoredRequested.parserContinuityId,
            ),
        )
        var rebound = requireNotNull(result.checkpoint)
        assertTrue(result.effects.isEmpty())
        assertEquals(reboundDelivery, rebound.pendingReplay?.fence?.deliveryToken)

        result = reduce(
            rebound,
            RelayV2TerminalAction.RetryReplay(
                rebound.deliveryToken,
                requestId = "replay-after-rebind",
            ),
        )
        rebound = requireNotNull(result.checkpoint)
        val reboundRequest = result.effects.filterIsInstance<RelayV2TerminalEffect.RequestReplay>()
            .single()
        assertEquals("replay-after-rebind", reboundRequest.requestId)
        assertEquals(reboundDelivery, reboundRequest.fence.deliveryToken)

        val oldCallback = reduce(
            rebound,
            RelayV2TerminalAction.ReplayStarted(
                rebound.identity,
                rebound.openAttempt.openId,
                requested.deliveryToken,
                firstRequest.requestId,
                fromOffset = "0",
                tailOffsetAtStart = "0",
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.STALE_REPLAY_RESPONSE,
            (oldCallback.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )

        rebound = requireNotNull(
            reduce(
                rebound,
                RelayV2TerminalAction.ReplayStarted(
                    rebound.identity,
                    rebound.openAttempt.openId,
                rebound.deliveryToken,
                    reboundRequest.requestId,
                    fromOffset = "0",
                    tailOffsetAtStart = "0",
                ),
            ).checkpoint,
        )
        val staleReset = reduce(
            rebound,
            RelayV2TerminalAction.CorrelatedResetRequired(
                actionFence(rebound),
                origin = RelayV2TerminalResetOrigin.REPLAY,
                requestId = reboundRequest.requestId,
                reason = RelayV2TerminalResetReason.STREAM_LOST,
                requestedOffset = null,
                bufferStartOffset = null,
                tailOffset = null,
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.STALE_RESET_RESPONSE,
            (staleReset.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertEquals(RelayV2TerminalPhase.LIVE, staleReset.checkpoint?.phase)

        result = output(rebound, "1", "x")
        val secondRequested = requireNotNull(result.checkpoint)
        val secondRequest = result.effects.filterIsInstance<RelayV2TerminalEffect.RequestReplay>()
            .single()
        val exactReset = reduce(
            secondRequested,
            RelayV2TerminalAction.CorrelatedResetRequired(
                actionFence(secondRequested),
                origin = RelayV2TerminalResetOrigin.REPLAY,
                requestId = secondRequest.requestId,
                reason = RelayV2TerminalResetReason.STREAM_LOST,
                requestedOffset = null,
                bufferStartOffset = null,
                tailOffset = null,
            ),
        )
        assertEquals(RelayV2TerminalPhase.RESET_REQUIRED, exactReset.checkpoint?.phase)
    }

    @Test
    fun `rebind and resumed redrive pending controls only with the current delivery fence`() {
        var checkpoint = open()
        val oldDelivery = checkpoint.deliveryToken
        checkpoint = requireNotNull(
            reduce(
                checkpoint,
                RelayV2TerminalAction.EnqueueInput(
                    oldDelivery,
                    RelayV2TerminalBytes.utf8("pending-input"),
                ),
            ).checkpoint,
        )
        checkpoint = requireNotNull(
            reduce(
                checkpoint,
                RelayV2TerminalAction.EnqueueResize(oldDelivery, 100, 40),
            ).checkpoint,
        )

        val reboundDelivery = delivery(connectionGeneration = 2, deliverySequence = 1)
        var result = reduce(
            checkpoint,
            RelayV2TerminalAction.RebindDelivery(
                checkpoint.identity,
                oldDelivery,
                reboundDelivery,
                checkpoint.parserContinuityId,
            ),
        )
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals(
            listOf(
                RelayV2TerminalEffect.SendInput::class,
                RelayV2TerminalEffect.SendResize::class,
            ),
            result.effects.map { it::class },
        )
        assertTrue(result.effects.all { it.fence?.deliveryToken == reboundDelivery })

        val staleAck = reduce(
            checkpoint,
            RelayV2TerminalAction.InputAck(
                actionFence(checkpoint, deliveryToken = oldDelivery),
                "1",
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.STALE_DELIVERY,
            (staleAck.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertEquals("0", staleAck.checkpoint?.ackedThroughInputSeq)

        val resumeAttempt = openAttempt("open-controls-resume", "controls-resume-fingerprint")
        checkpoint = beginOpen(checkpoint, resumeAttempt, "controls-resume-request")
        result = reduce(
            checkpoint,
            RelayV2TerminalAction.Opened(
                checkpoint.identity,
                requestId = "controls-resume-request",
                openAttempt = resumeAttempt,
                deliveryToken = reboundDelivery,
                parserContinuityId = checkpoint.parserContinuityId,
                disposition = RelayV2TerminalOpenDisposition.RESUMED,
                cols = checkpoint.openedCols,
                rows = checkpoint.openedRows,
                replayFromOffset = "0",
                tailOffset = "0",
            ),
        )
        assertEquals(
            listOf(
                RelayV2TerminalEffect.SendInput::class,
                RelayV2TerminalEffect.SendResize::class,
            ),
            result.effects.map { it::class },
        )
        assertTrue(result.effects.all { it.fence?.deliveryToken == reboundDelivery })
    }

    @Test
    fun `closed freezes controls advances ring metadata and resumes from local tombstone`() {
        var checkpoint = open()
        var queuedControl = reduce(
            checkpoint,
            RelayV2TerminalAction.EnqueueInput(
                checkpoint.deliveryToken,
                RelayV2TerminalBytes.utf8("input"),
            ),
        )
        checkpoint = requireNotNull(queuedControl.checkpoint)
        val inputEffect = queuedControl.effects.filterIsInstance<
            RelayV2TerminalEffect.SendInput
            >().single()
        queuedControl = reduce(
            checkpoint,
            RelayV2TerminalAction.EnqueueResize(checkpoint.deliveryToken, 90, 30),
        )
        checkpoint = requireNotNull(queuedControl.checkpoint)
        val resizeEffect = queuedControl.effects.filterIsInstance<
            RelayV2TerminalEffect.SendResize
            >().single()
        assertEquals(
            RelayV2TerminalControlDispatchAuthorization.AUTHORIZED,
            RelayV2TerminalCheckpointReducer.authorizeControlDispatch(checkpoint, inputEffect),
        )
        assertEquals(
            RelayV2TerminalControlDispatchAuthorization.AUTHORIZED,
            RelayV2TerminalCheckpointReducer.authorizeControlDispatch(checkpoint, resizeEffect),
        )
        val closedWithGap = reduce(
            checkpoint,
            closedAction(checkpoint, "2", replayAvailable = true, bufferStartOffset = "0"),
        )
        val frozen = requireNotNull(closedWithGap.checkpoint)
        assertEquals(listOf("1"), frozen.ambiguousInputs.map { it.inputSeq })
        assertTrue(frozen.pendingInputs.isEmpty())
        assertTrue(frozen.pendingResizes.isEmpty())
        assertNull(frozen.activeControlDispatchLease)
        listOf(inputEffect, resizeEffect).forEach { issuedBeforeClose ->
            assertEquals(
                RelayV2TerminalControlDispatchAuthorization.REVOKED,
                RelayV2TerminalCheckpointReducer.authorizeControlDispatch(
                    frozen,
                    issuedBeforeClose,
                ),
            )
        }
        assertEquals(
            listOf(
                RelayV2TerminalEffect.ControlsBecameAmbiguous::class,
                RelayV2TerminalEffect.RequestReplay::class,
            ),
            closedWithGap.effects.map { it::class },
        )
        val inputAfterClose = reduce(
            frozen,
            RelayV2TerminalAction.EnqueueInput(
                frozen.deliveryToken,
                RelayV2TerminalBytes.utf8("late"),
            ),
        )
        assertEquals(
            RelayV2TerminalControlRejectionReason.TERMINAL_NOT_WRITABLE,
            (inputAfterClose.outcome as RelayV2TerminalOutcome.ControlRejected).reason,
        )
        assertTrue(
            reduce(
                frozen,
                RelayV2TerminalAction.RetryUnackedControls(frozen.deliveryToken),
            ).effects.isEmpty(),
        )
        assertTrue(
            reduce(
                frozen,
                RelayV2TerminalAction.RequestClose(
                    frozen.deliveryToken,
                    closeAttempt(),
                    "frozen-close-request",
                ),
            ).effects.isEmpty(),
        )

        var sentInput = open()
        val pendingSend = reduce(
            sentInput,
            RelayV2TerminalAction.EnqueueInput(
                sentInput.deliveryToken,
                RelayV2TerminalBytes.utf8("sent-before-close"),
            ),
        )
        sentInput = requireNotNull(pendingSend.checkpoint)
        val issuedBeforeFinalize = pendingSend.effects.filterIsInstance<
            RelayV2TerminalEffect.SendInput
            >().single()
        sentInput = requireNotNull(
            reduce(
                sentInput,
                RelayV2TerminalAction.InputSent(actionFence(sentInput), "1"),
            ).checkpoint,
        )
        val finalizedWithInput = reduce(
            sentInput,
            closedAction(sentInput, "0", replayAvailable = false, bufferStartOffset = null),
        )
        assertEquals(RelayV2TerminalPhase.FINALIZED, finalizedWithInput.checkpoint?.phase)
        assertNull(finalizedWithInput.checkpoint?.activeControlDispatchLease)
        assertEquals(
            RelayV2TerminalControlDispatchAuthorization.REVOKED,
            RelayV2TerminalCheckpointReducer.authorizeControlDispatch(
                requireNotNull(finalizedWithInput.checkpoint),
                issuedBeforeFinalize,
            ),
        )
        assertEquals(listOf("1"), finalizedWithInput.checkpoint?.ambiguousInputs?.map {
            it.inputSeq
        })
        assertEquals(
            1,
            finalizedWithInput.effects
                .filterIsInstance<RelayV2TerminalEffect.ControlsBecameAmbiguous>()
                .single().inputCount,
        )
        assertTrue(finalizedWithInput.checkpoint?.pendingInputs?.isEmpty() == true)

        var ringSource = open()
        ringSource = requireNotNull(output(ringSource, "0", "a").checkpoint)
        var ring = requireNotNull(
            reduce(
                ringSource,
                closedAction(ringSource, "2", replayAvailable = true, bufferStartOffset = "0"),
            ).checkpoint,
        )
        val advanced = reduce(
            ring,
            closedAction(ring, "2", replayAvailable = true, bufferStartOffset = "1"),
        )
        ring = requireNotNull(advanced.checkpoint)
        assertEquals("1", ring.closed?.retainedBuffer?.bufferStartOffset)
        val expired = reduce(
            ring,
            closedAction(ring, "2", replayAvailable = false, bufferStartOffset = null),
        )
        assertEquals(
            RelayV2TerminalResetReason.OFFSET_EXPIRED,
            (expired.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        assertTrue(expired.effects.any { it is RelayV2TerminalEffect.DisplayTruncated })

        val closing = open()
        val knownClosed = requireNotNull(
            reduce(
                closing,
                closedAction(closing, "2", replayAvailable = true, bufferStartOffset = "0"),
            ).checkpoint,
        )
        val resumeAttempt = openAttempt("open-after-close", "after-close-fingerprint")
        val pendingResume = beginOpen(knownClosed, resumeAttempt, "after-close-request")
        var resumed = requireNotNull(
            reduce(
                pendingResume,
                RelayV2TerminalAction.Opened(
                    pendingResume.identity,
                    requestId = "after-close-request",
                    openAttempt = resumeAttempt,
                    deliveryToken = pendingResume.deliveryToken,
                    parserContinuityId = PARSER_CONTINUITY,
                    disposition = RelayV2TerminalOpenDisposition.RESUMED,
                    cols = 120,
                    rows = 36,
                    replayFromOffset = "0",
                    tailOffset = "2",
                ),
            ).checkpoint,
        )
        assertNotNull(resumed.closed)
        assertEquals(RelayV2TerminalPhase.REPLAYING, resumed.phase)
        val resumedOutput = output(resumed, "0", "ab")
        resumed = requireNotNull(resumedOutput.checkpoint)
        val write = resumedOutput.effects.filterIsInstance<RelayV2TerminalEffect.WriteParser>()
            .single()
        val finalized = reduce(resumed, RelayV2TerminalAction.ParserApplied(write.callbackToken))
        assertEquals(RelayV2TerminalPhase.FINALIZED, finalized.checkpoint?.phase)

        val lowAttempt = openAttempt("open-low-tail", "low-tail-fingerprint")
        val lowPending = beginOpen(knownClosed, lowAttempt, "low-tail-request")
        val lowTail = reduce(
            lowPending,
            RelayV2TerminalAction.Opened(
                lowPending.identity,
                requestId = "low-tail-request",
                openAttempt = lowAttempt,
                deliveryToken = lowPending.deliveryToken,
                parserContinuityId = PARSER_CONTINUITY,
                disposition = RelayV2TerminalOpenDisposition.RESUMED,
                cols = 120,
                rows = 36,
                replayFromOffset = "0",
                tailOffset = "1",
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            (lowTail.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        val highAttempt = openAttempt("open-high-tail", "high-tail-fingerprint")
        val highPending = beginOpen(knownClosed, highAttempt, "high-tail-request")
        val highTail = reduce(
            highPending,
            RelayV2TerminalAction.Opened(
                highPending.identity,
                requestId = "high-tail-request",
                openAttempt = highAttempt,
                deliveryToken = highPending.deliveryToken,
                parserContinuityId = PARSER_CONTINUITY,
                disposition = RelayV2TerminalOpenDisposition.RESUMED,
                cols = 120,
                rows = 36,
                replayFromOffset = "0",
                tailOffset = "3",
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            (highTail.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        var noRing = open()
        var noRingResult = output(noRing, "0", "ab")
        noRing = requireNotNull(noRingResult.checkpoint)
        val noRingWrite = noRingResult.effects
            .filterIsInstance<RelayV2TerminalEffect.WriteParser>().single()
        noRing = requireNotNull(
            reduce(
                noRing,
                RelayV2TerminalAction.ParserApplied(noRingWrite.callbackToken),
            ).checkpoint,
        )
        val noRingCloseAttempt = closeAttempt("close-no-ring", "close-no-ring-fingerprint")
        noRing = requireNotNull(
            reduce(
                noRing,
                RelayV2TerminalAction.RequestClose(
                    noRing.deliveryToken,
                    noRingCloseAttempt,
                    "close-no-ring-request",
                ),
            ).checkpoint,
        )
        noRing = requireNotNull(
            reduce(
                noRing,
                closedAction(
                    noRing,
                    finalOffset = "2",
                    replayAvailable = false,
                    bufferStartOffset = null,
                ),
            ).checkpoint,
        )
        assertEquals(RelayV2TerminalPhase.CLOSED_WAITING_CLOSE, noRing.phase)
        val noRingResume = openAttempt("open-no-ring", "open-no-ring-fingerprint")
        val noRingPending = beginOpen(noRing, noRingResume, "open-no-ring-request")
        noRingResult = reduce(
            noRingPending,
            RelayV2TerminalAction.Opened(
                noRingPending.identity,
                requestId = "open-no-ring-request",
                openAttempt = noRingResume,
                deliveryToken = noRingPending.deliveryToken,
                parserContinuityId = noRingPending.parserContinuityId,
                disposition = RelayV2TerminalOpenDisposition.RESUMED,
                cols = noRingPending.openedCols,
                rows = noRingPending.openedRows,
                replayFromOffset = "2",
                tailOffset = "2",
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.OFFSET_EXPIRED,
            (noRingResult.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
    }

    @Test
    fun `close attempt survives rebind resume and natural close converges exact response`() {
        var checkpoint = open()
        val closeAttempt = closeAttempt("close-current", "close-current-fingerprint")
        var result = reduce(
            checkpoint,
            RelayV2TerminalAction.RequestClose(
                checkpoint.deliveryToken,
                closeAttempt,
                "close-current-request",
            ),
        )
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals(
            "close-current-request",
            result.effects.filterIsInstance<RelayV2TerminalEffect.SendClose>().single().requestId,
        )
        val conflictingCurrentClose = reduce(
            checkpoint,
            closedAction(
                checkpoint,
                finalOffset = "0",
                replayAvailable = false,
                bufferStartOffset = null,
                closeId = "close-conflicting",
                requestId = "close-current-request",
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            (conflictingCurrentClose.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        val duplicateCloseAttempt = reduce(
            checkpoint,
            RelayV2TerminalAction.RequestClose(
                checkpoint.deliveryToken,
                closeAttempt,
                "close-current-request",
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.NETWORK_REQUEST_ID_REUSED,
            (duplicateCloseAttempt.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertTrue(checkpoint === duplicateCloseAttempt.checkpoint)
        assertTrue(duplicateCloseAttempt.effects.isEmpty())

        val reboundDelivery = delivery(connectionGeneration = 2, deliverySequence = 2)
        result = reduce(
            checkpoint,
            RelayV2TerminalAction.RebindDelivery(
                checkpoint.identity,
                checkpoint.deliveryToken,
                reboundDelivery,
                checkpoint.parserContinuityId,
            ),
        )
        checkpoint = requireNotNull(result.checkpoint)
        assertTrue(result.effects.isEmpty())
        result = reduce(
            checkpoint,
            RelayV2TerminalAction.RequestClose(
                checkpoint.deliveryToken,
                closeAttempt,
                "close-after-rebind-request",
            ),
        )
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals(
            "close-after-rebind-request",
            result.effects.filterIsInstance<RelayV2TerminalEffect.SendClose>().single().requestId,
        )
        val reusedCloseRequest = reduce(
            checkpoint,
            RelayV2TerminalAction.RequestClose(
                checkpoint.deliveryToken,
                closeAttempt,
                "close-current-request",
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.NETWORK_REQUEST_ID_REUSED,
            (reusedCloseRequest.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertTrue(checkpoint === reusedCloseRequest.checkpoint)
        assertTrue(reusedCloseRequest.effects.isEmpty())

        val resumeAttempt = openAttempt("open-after-disconnect", "disconnect-fingerprint")
        checkpoint = beginOpen(checkpoint, resumeAttempt, "disconnect-resume-request")
        result = reduce(
            checkpoint,
            RelayV2TerminalAction.Opened(
                checkpoint.identity,
                requestId = "disconnect-resume-request",
                openAttempt = resumeAttempt,
                deliveryToken = checkpoint.deliveryToken,
                parserContinuityId = PARSER_CONTINUITY,
                disposition = RelayV2TerminalOpenDisposition.RESUMED,
                cols = 120,
                rows = 36,
                replayFromOffset = "0",
                tailOffset = "0",
            ),
        )
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals(closeAttempt, checkpoint.pendingClose?.closeAttempt)
        assertTrue(result.effects.isEmpty())
        result = reduce(
            checkpoint,
            RelayV2TerminalAction.RequestClose(
                checkpoint.deliveryToken,
                closeAttempt,
                "close-after-resume-request",
            ),
        )
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals(
            "close-after-resume-request",
            result.effects.filterIsInstance<RelayV2TerminalEffect.SendClose>().single().requestId,
        )
        assertEquals(
            RelayV2TerminalControlRejectionReason.TERMINAL_NOT_WRITABLE,
            (reduce(
                checkpoint,
                RelayV2TerminalAction.EnqueueResize(checkpoint.deliveryToken, 100, 40),
            ).outcome as RelayV2TerminalOutcome.ControlRejected).reason,
        )

        val staleClose = reduce(
            checkpoint,
            closedAction(
                checkpoint,
                finalOffset = "0",
                replayAvailable = false,
                bufferStartOffset = null,
                closeId = "close-old",
                requestId = "close-after-rebind-request",
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.STALE_CLOSE_RESPONSE,
            (staleClose.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertEquals(closeAttempt, staleClose.checkpoint?.pendingClose?.closeAttempt)

        result = reduce(
            checkpoint,
            closedAction(checkpoint, "0", replayAvailable = false, bufferStartOffset = null),
        )
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals(RelayV2TerminalPhase.CLOSED_WAITING_CLOSE, checkpoint.phase)
        assertEquals(closeAttempt, checkpoint.pendingClose?.closeAttempt)
        assertNull(checkpoint.closed?.tombstone?.closeAttempt)

        val restoredWaitingClose = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(checkpoint),
            checkpoint.identity,
            checkpoint.openAttempt,
            checkpoint.deliveryToken,
            checkpoint.parserContinuityId,
        )
        checkpoint = requireNotNull(restoredWaitingClose.checkpoint)
        assertTrue(restoredWaitingClose.effects.isEmpty())
        result = reduce(
            checkpoint,
            RelayV2TerminalAction.RequestClose(
                checkpoint.deliveryToken,
                closeAttempt,
                "close-query-after-restore",
            ),
        )
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals(
            "close-query-after-restore",
            result.effects.filterIsInstance<RelayV2TerminalEffect.QueryCloseCorrelation>()
                .single().requestId,
        )

        val closedRebind = delivery(connectionGeneration = 3, deliverySequence = 1)
        result = reduce(
            checkpoint,
            RelayV2TerminalAction.RebindDelivery(
                checkpoint.identity,
                checkpoint.deliveryToken,
                closedRebind,
                checkpoint.parserContinuityId,
            ),
        )
        checkpoint = requireNotNull(result.checkpoint)
        assertTrue(result.effects.isEmpty())
        result = reduce(
            checkpoint,
            RelayV2TerminalAction.RequestClose(
                checkpoint.deliveryToken,
                closeAttempt,
                "close-query-after-rebind",
            ),
        )
        checkpoint = requireNotNull(result.checkpoint)
        val query = result.effects.filterIsInstance<
            RelayV2TerminalEffect.QueryCloseCorrelation
            >().single()
        assertEquals(closeAttempt.closeId, query.closeId)
        assertEquals("close-query-after-rebind", query.requestId)
        assertEquals(closedRebind, query.fence.deliveryToken)

        val correlated = reduce(
            checkpoint,
            closedAction(
                checkpoint,
                finalOffset = "0",
                replayAvailable = false,
                bufferStartOffset = null,
                closeId = closeAttempt.closeId,
            ),
        )
        assertEquals(RelayV2TerminalPhase.FINALIZED, correlated.checkpoint?.phase)
        assertEquals(closeAttempt, correlated.checkpoint?.closed?.tombstone?.closeAttempt)
        assertNull(correlated.checkpoint?.pendingClose)
    }

    @Test
    fun `consumed close keeps earlier issued request stale while parser drains`() {
        var checkpoint = requireNotNull(output(open(), "0", "x").checkpoint)
        val closeAttempt = closeAttempt("close-draining", "close-draining-fingerprint")
        checkpoint = requireNotNull(
            reduce(
                checkpoint,
                RelayV2TerminalAction.RequestClose(
                    checkpoint.deliveryToken,
                    closeAttempt,
                    "close-draining-a",
                ),
            ).checkpoint,
        )
        checkpoint = requireNotNull(
            reduce(
                checkpoint,
                RelayV2TerminalAction.RequestClose(
                    checkpoint.deliveryToken,
                    closeAttempt,
                    "close-draining-b",
                ),
            ).checkpoint,
        )

        checkpoint = requireNotNull(
            reduce(
                checkpoint,
                closedAction(
                    checkpoint,
                    finalOffset = "1",
                    replayAvailable = false,
                    bufferStartOffset = null,
                    closeId = closeAttempt.closeId,
                    requestId = "close-draining-b",
                ),
            ).checkpoint,
        )
        assertEquals(RelayV2TerminalPhase.CLOSED_WAITING_PARSER, checkpoint.phase)
        assertNull(checkpoint.pendingClose)

        val lateIssued = reduce(
            checkpoint,
            closedAction(
                checkpoint,
                finalOffset = "1",
                replayAvailable = false,
                bufferStartOffset = null,
                closeId = closeAttempt.closeId,
                requestId = "close-draining-a",
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.STALE_CLOSE_RESPONSE,
            (lateIssued.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertTrue(checkpoint === lateIssued.checkpoint)
        assertTrue(lateIssued.effects.isEmpty())
    }

    @Test
    fun `restore snapshots collections and drops corrupt or oversized untrusted state`() {
        var checkpoint = open()
        checkpoint = requireNotNull(output(checkpoint, "0", "x").checkpoint)
        checkpoint = requireNotNull(
            reduce(
                checkpoint,
                RelayV2TerminalAction.EnqueueInput(
                    checkpoint.deliveryToken,
                    RelayV2TerminalBytes.utf8("i"),
                ),
            ).checkpoint,
        )
        checkpoint = requireNotNull(
            reduce(
                checkpoint,
                RelayV2TerminalAction.EnqueueResize(checkpoint.deliveryToken, 100, 40),
            ).checkpoint,
        )
        val outputList = checkpoint.pendingOutput.toMutableList()
        val inputList = checkpoint.pendingInputs.toMutableList()
        val resizeList = checkpoint.pendingResizes.toMutableList()
        val ambiguousList = mutableListOf(
            RelayV2AmbiguousInput(
                "generation-old",
                "9",
                RelayV2TerminalBytes.utf8("ambiguous"),
            ),
        )
        val externallyMutable = checkpoint.copy(
            pendingOutput = outputList,
            pendingInputs = inputList,
            pendingResizes = resizeList,
            ambiguousInputs = ambiguousList,
        )
        val restored = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(externallyMutable),
            checkpoint.identity,
            checkpoint.openAttempt,
            checkpoint.deliveryToken,
            checkpoint.parserContinuityId,
            RelayV2TerminalParserRestoreProof(
                callbackToken = requireNotNull(checkpoint.parserInFlightCallbackToken),
                parserAppliedNextOffset = "0",
                status = RelayV2TerminalParserOperationStatus.NOT_APPLIED,
            ),
        )
        val snapshot = requireNotNull(restored.checkpoint)
        outputList.clear()
        inputList.clear()
        resizeList.clear()
        ambiguousList.clear()
        assertEquals(1, snapshot.pendingOutput.size)
        assertEquals(1, snapshot.pendingInputs.size)
        assertEquals(1, snapshot.pendingResizes.size)
        assertEquals(1, snapshot.ambiguousInputs.size)

        val malformed = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(open().copy(nextInputSeq = "bad")),
            identity(),
            openAttempt(),
            delivery(),
            PARSER_CONTINUITY,
        )
        assertNull(malformed.checkpoint)
        assertEquals(
            RelayV2TerminalResetReason.CHECKPOINT_INVALID,
            (malformed.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        val oversizedBytes = RelayV2TerminalBytes.of(
            ByteArray(RelayV2TerminalCheckpointLimits.MAX_FRAME_BYTES) { 1 },
        )
        val oversizedCheckpoint = open().copy(
            ambiguousInputs = MutableList(40) { index ->
                RelayV2AmbiguousInput("generation-old", (index + 1).toString(), oversizedBytes)
            },
        )
        val oversized = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(oversizedCheckpoint),
            oversizedCheckpoint.identity,
            oversizedCheckpoint.openAttempt,
            oversizedCheckpoint.deliveryToken,
            oversizedCheckpoint.parserContinuityId,
        )
        assertNull(oversized.checkpoint)
        assertEquals(
            RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED,
            (oversized.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        assertTrue(oversized.effects.single() is RelayV2TerminalEffect.ResetRequired)
    }

    @Test
    fun `durable pre-open and applied-open dedupe retries preserve logical attempt authority`() {
        val identity = identity()
        val attempt = openAttempt("open-first", "first-fingerprint")
        val firstBegin = RelayV2TerminalAction.BeginOpenAttempt(
            deliveryToken = delivery(),
            requestId = "open-request-a",
            openAttempt = attempt,
            mode = RelayV2TerminalOpenMode.NEW,
            cols = 120,
            rows = 36,
            target = identity.target(),
            parserContinuityId = PARSER_CONTINUITY,
            resume = null,
        )
        var result = RelayV2TerminalCheckpointReducer.reduce(null, firstBegin)
        var preOpen = requireNotNull(result.preOpenCheckpoint)
        assertEquals("open-request-a", preOpen.pendingOpen?.requestId)
        assertEquals(
            "open-request-a",
            result.effects.filterIsInstance<RelayV2TerminalEffect.SendOpen>().single().requestId,
        )
        val conflictingCurrentOpen = RelayV2TerminalCheckpointReducer.reduce(
            preOpen,
            RelayV2TerminalAction.Opened(
                identity = identity,
                requestId = "open-request-a",
                openAttempt = attempt.copy(fingerprint = "conflicting-current-fingerprint"),
                deliveryToken = preOpen.deliveryToken,
                parserContinuityId = PARSER_CONTINUITY,
                disposition = RelayV2TerminalOpenDisposition.NEW,
                cols = 120,
                rows = 36,
                replayFromOffset = "0",
                tailOffset = "0",
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            (conflictingCurrentOpen.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        val retryBegin = firstBegin.copy(requestId = "open-request-b")
        result = RelayV2TerminalCheckpointReducer.reduce(preOpen, retryBegin)
        preOpen = requireNotNull(result.preOpenCheckpoint)
        assertEquals("open-request-b", preOpen.pendingOpen?.requestId)
        assertEquals(
            "open-request-b",
            result.effects.filterIsInstance<RelayV2TerminalEffect.SendOpen>().single().requestId,
        )
        val idempotent = RelayV2TerminalCheckpointReducer.reduce(preOpen, retryBegin)
        assertTrue(preOpen === idempotent.preOpenCheckpoint)
        assertEquals(
            RelayV2TerminalIgnoredReason.NETWORK_REQUEST_ID_REUSED,
            (idempotent.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertTrue(idempotent.effects.isEmpty())
        val reusedEarlierRequest = RelayV2TerminalCheckpointReducer.reduce(preOpen, firstBegin)
        assertEquals(
            RelayV2TerminalIgnoredReason.NETWORK_REQUEST_ID_REUSED,
            (reusedEarlierRequest.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertTrue(preOpen === reusedEarlierRequest.preOpenCheckpoint)
        assertTrue(reusedEarlierRequest.effects.isEmpty())

        val lateFirstOpen = RelayV2TerminalCheckpointReducer.reduce(
            preOpen,
            RelayV2TerminalAction.Opened(
                identity = identity,
                requestId = "open-request-a",
                openAttempt = attempt,
                deliveryToken = preOpen.deliveryToken,
                parserContinuityId = PARSER_CONTINUITY,
                disposition = RelayV2TerminalOpenDisposition.NEW,
                cols = 120,
                rows = 36,
                replayFromOffset = "0",
                tailOffset = "0",
                deduplicated = true,
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.STALE_OPEN_RESPONSE,
            (lateFirstOpen.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertTrue(preOpen === lateFirstOpen.preOpenCheckpoint)

        val restoredDelivery = delivery(connectionGeneration = 2, deliverySequence = 1)
        val processRestored = RelayV2TerminalCheckpointReducer.restorePreOpen(
            RelayV2TerminalStoredCheckpoint.PreOpen(preOpen),
            identity.target(),
            attempt,
            restoredDelivery,
            PARSER_CONTINUITY,
        )
        assertTrue(processRestored.outcome is RelayV2TerminalOutcome.Restored)
        assertTrue(processRestored.effects.isEmpty())
        val restoredPreOpen = requireNotNull(processRestored.preOpenCheckpoint)
        result = RelayV2TerminalCheckpointReducer.reduce(
            restoredPreOpen,
            firstBegin.copy(
                deliveryToken = restoredDelivery,
                requestId = "open-request-restored",
            ),
        )
        val retriedAfterRestore = requireNotNull(result.preOpenCheckpoint)
        assertEquals(
            restoredDelivery,
            result.effects.filterIsInstance<RelayV2TerminalEffect.SendOpen>()
                .single().openFence.deliveryToken,
        )
        assertEquals(
            "open-request-restored",
            result.effects.filterIsInstance<RelayV2TerminalEffect.SendOpen>().single().requestId,
        )

        val firstOpened = RelayV2TerminalAction.Opened(
            identity = identity,
            requestId = "open-request-restored",
            openAttempt = attempt,
            deliveryToken = restoredDelivery,
            parserContinuityId = PARSER_CONTINUITY,
            disposition = RelayV2TerminalOpenDisposition.NEW,
            cols = 120,
            rows = 36,
            replayFromOffset = "0",
            tailOffset = "2",
            deduplicated = true,
        )
        result = RelayV2TerminalCheckpointReducer.reduce(
            retriedAfterRestore,
            firstOpened,
        )
        var active = requireNotNull(result.checkpoint)
        assertEquals(attempt, active.openAttempt)
        assertEquals(RelayV2TerminalPhase.REPLAYING, active.phase)
        assertEquals("2", active.replayTargetOffset)
        result = output(active, "0", "ab")
        active = requireNotNull(result.checkpoint)
        val responseLossReplay = result.effects
            .filterIsInstance<RelayV2TerminalEffect.WriteParser>().single()
        active = requireNotNull(
            reduce(
                active,
                RelayV2TerminalAction.ParserApplied(responseLossReplay.callbackToken),
            ).checkpoint,
        )
        assertEquals(RelayV2TerminalPhase.LIVE, active.phase)

        val unsolicited = RelayV2TerminalCheckpointReducer.reduce(null, firstOpened)
        assertNull(unsolicited.checkpoint)
        assertNull(unsolicited.preOpenCheckpoint)
        assertEquals(
            RelayV2TerminalResetReason.MISSING_CHECKPOINT,
            (unsolicited.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        val activeRetry = firstBegin.copy(deliveryToken = restoredDelivery)
        result = reduce(active, activeRetry.copy(requestId = "open-request-c"))
        val appliedRetry = requireNotNull(result.checkpoint)
        assertEquals(
            "open-request-c",
            result.effects.filterIsInstance<RelayV2TerminalEffect.SendOpen>().single().requestId,
        )
        result = reduce(
            appliedRetry,
            firstOpened.copy(requestId = "open-request-c", deduplicated = true),
        )
        val deduplicated = requireNotNull(result.checkpoint)
        assertNull(deduplicated.pendingOpen)
        assertTrue(result.effects.isEmpty())
        assertEquals(active.openResult, deduplicated.openResult)
        val reusedAppliedRequest = reduce(
            deduplicated,
            activeRetry.copy(requestId = "open-request-c"),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.NETWORK_REQUEST_ID_REUSED,
            (reusedAppliedRequest.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertTrue(deduplicated === reusedAppliedRequest.checkpoint)
        assertTrue(reusedAppliedRequest.effects.isEmpty())

        val mismatchedReplayPending = requireNotNull(
            reduce(deduplicated, activeRetry.copy(requestId = "open-request-d")).checkpoint,
        )
        val mismatchedReplay = reduce(
            mismatchedReplayPending,
            firstOpened.copy(
                requestId = "open-request-d",
                tailOffset = "1",
                deduplicated = true,
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            (mismatchedReplay.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        val changedFingerprint = reduce(
            active,
            activeRetry.copy(
                requestId = "open-request-conflict",
                openAttempt = attempt.copy(fingerprint = "changed-fingerprint"),
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            (changedFingerprint.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        val changedDimensions = reduce(
            active,
            activeRetry.copy(requestId = "open-request-size", cols = 121),
        )
        assertEquals(
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            (changedDimensions.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        val attachmentAttempt = openAttempt("open-attachment", "attachment-fingerprint")
        val attachmentPending = beginOpen(
            active,
            attachmentAttempt,
            "attachment-request",
            cols = 140,
            rows = 50,
        )
        val attachment = reduce(
            attachmentPending,
            RelayV2TerminalAction.Opened(
                identity = active.identity,
                requestId = "attachment-request",
                openAttempt = attachmentAttempt,
                deliveryToken = active.deliveryToken,
                parserContinuityId = PARSER_CONTINUITY,
                disposition = RelayV2TerminalOpenDisposition.RESUMED,
                cols = 140,
                rows = 50,
                replayFromOffset = "2",
                tailOffset = "2",
            ),
        )
        assertEquals(140, attachment.checkpoint?.openedCols)
        assertEquals(50, attachment.checkpoint?.openedRows)
    }

    @Test
    fun `pre-open correlated reset persists the consumed open authority fence`() {
        val identity = identity()
        val firstAttempt = openAttempt("open-pre-reset", "pre-reset-fingerprint")
        var result = RelayV2TerminalCheckpointReducer.reduce(
            null,
            RelayV2TerminalAction.BeginOpenAttempt(
                deliveryToken = delivery(),
                requestId = "pre-reset-request",
                openAttempt = firstAttempt,
                mode = RelayV2TerminalOpenMode.NEW,
                cols = 120,
                rows = 36,
                target = identity.target(),
                parserContinuityId = PARSER_CONTINUITY,
                resume = null,
            ),
        )
        var preOpen = requireNotNull(result.preOpenCheckpoint)
        val consumedFence = result.effects.filterIsInstance<RelayV2TerminalEffect.SendOpen>()
            .single().openFence
        val correlatedReset = RelayV2TerminalAction.PreOpenResetRequired(
            fence = consumedFence,
            requestId = "pre-reset-request",
            reason = RelayV2TerminalResetReason.STREAM_LOST,
            requestedOffset = null,
            bufferStartOffset = null,
            tailOffset = null,
        )
        val conflictingCurrentFence = RelayV2TerminalCheckpointReducer.reduce(
            preOpen,
            correlatedReset.copy(
                fence = consumedFence.copy(cols = consumedFence.cols + 1),
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            (conflictingCurrentFence.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        result = RelayV2TerminalCheckpointReducer.reduce(preOpen, correlatedReset)
        preOpen = requireNotNull(result.preOpenCheckpoint)
        assertEquals(RelayV2TerminalPreOpenPhase.RESET_REQUIRED, preOpen.phase)
        assertEquals(consumedFence, preOpen.resetFence)
        assertEquals(
            consumedFence,
            result.effects.filterIsInstance<RelayV2TerminalEffect.ResetRequired>().single().fence,
        )

        val restored = RelayV2TerminalCheckpointReducer.restorePreOpen(
            RelayV2TerminalStoredCheckpoint.PreOpen(preOpen),
            identity.target(),
            firstAttempt,
            delivery(),
            PARSER_CONTINUITY,
        )
        assertEquals(
            consumedFence,
            restored.effects.filterIsInstance<RelayV2TerminalEffect.ResetRequired>().single().fence,
        )

        val replacementAttempt = openAttempt("open-pre-reset-2", "pre-reset-fingerprint-2")
        result = RelayV2TerminalCheckpointReducer.reduce(
            requireNotNull(restored.preOpenCheckpoint),
            RelayV2TerminalAction.BeginOpenAttempt(
                deliveryToken = delivery(),
                requestId = "pre-reset-request-2",
                openAttempt = replacementAttempt,
                mode = RelayV2TerminalOpenMode.RESET,
                cols = 100,
                rows = 40,
                target = identity.target(),
                parserContinuityId = "parser-pre-reset-2",
                resume = RelayV2TerminalOpenResume(
                    generation = identity.generation,
                    nextOffset = null,
                    resumeTokenCredentialReference = identity.resumeTokenCredentialReference,
                    resumeTokenCredentialFingerprint =
                    identity.resumeTokenCredentialFingerprint,
                ),
            ),
        )
        val replacement = requireNotNull(result.preOpenCheckpoint)
        listOf(
            identity,
            identity.copy(
                generation = "generation-pre-reset-2",
                resumeTokenCredentialReference = "resume-token-ref-pre-reset-2",
            ),
        ).forEach { unrotatedAuthority ->
            val rejected = RelayV2TerminalCheckpointReducer.reduce(
                replacement,
                RelayV2TerminalAction.Opened(
                    identity = unrotatedAuthority,
                    requestId = "pre-reset-request-2",
                    openAttempt = replacementAttempt,
                    deliveryToken = replacement.deliveryToken,
                    parserContinuityId = "parser-pre-reset-2",
                    disposition = RelayV2TerminalOpenDisposition.RESET,
                    cols = 100,
                    rows = 40,
                    replayFromOffset = "0",
                    tailOffset = "0",
                ),
            )
            assertEquals(
                RelayV2TerminalResetReason.GENERATION_STALE,
                (rejected.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
            )
        }
        val late = RelayV2TerminalCheckpointReducer.reduce(replacement, correlatedReset)
        assertEquals(
            RelayV2TerminalIgnoredReason.STALE_RESET_RESPONSE,
            (late.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertTrue(replacement === late.preOpenCheckpoint)
    }

    @Test
    fun `open effects freeze resume authority and new request retries require exact dedupe`() {
        val current = open()
        val attempt = openAttempt("open-frozen-resume", "frozen-resume-fingerprint")
        val frozenResume = openResume(current, current.parserAppliedNextOffset)
        val firstAction = RelayV2TerminalAction.BeginOpenAttempt(
            deliveryToken = current.deliveryToken,
            requestId = "resume-network-1",
            openAttempt = attempt,
            mode = RelayV2TerminalOpenMode.RESUME,
            cols = 101,
            rows = 41,
            target = current.identity.target(),
            parserContinuityId = current.parserContinuityId,
            resume = frozenResume,
        )
        var result = reduce(current, firstAction)
        var pending = requireNotNull(result.checkpoint)
        val firstSend = result.effects.filterIsInstance<RelayV2TerminalEffect.SendOpen>().single()
        assertEquals(RelayV2TerminalOpenMode.RESUME, firstSend.openFence.mode)
        assertEquals(101, firstSend.openFence.cols)
        assertEquals(41, firstSend.openFence.rows)
        assertEquals(frozenResume, firstSend.openFence.resume)
        assertEquals(frozenResume, firstSend.resume)

        result = reduce(pending, firstAction.copy(requestId = "resume-network-2"))
        pending = requireNotNull(result.checkpoint)
        val retrySend = result.effects.filterIsInstance<RelayV2TerminalEffect.SendOpen>().single()
        assertEquals(firstSend.openFence, retrySend.openFence)
        assertEquals("resume-network-2", retrySend.requestId)
        assertTrue(pending.pendingOpen?.requiresDeduplicatedResponse == true)

        val replayedResult = RelayV2TerminalAction.Opened(
            identity = current.identity,
            requestId = "resume-network-2",
            openAttempt = attempt,
            deliveryToken = current.deliveryToken,
            parserContinuityId = current.parserContinuityId,
            disposition = RelayV2TerminalOpenDisposition.RESUMED,
            cols = 101,
            rows = 41,
            replayFromOffset = "0",
            tailOffset = "0",
            deduplicated = true,
        )
        val missingDedupe = reduce(pending, replayedResult.copy(deduplicated = false))
        assertEquals(
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            (missingDedupe.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        val wrongOriginalGeneration = reduce(
            pending,
            replayedResult.copy(
                identity = current.identity.copy(generation = "generation-other"),
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.GENERATION_STALE,
            (wrongOriginalGeneration.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        val wrongOriginalToken = reduce(
            pending,
            replayedResult.copy(
                identity = current.identity.copy(
                    resumeTokenCredentialReference = "resume-token-ref-other",
                    resumeTokenCredentialFingerprint = "resume-token-fingerprint-other",
                ),
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.IDENTITY_CHANGED,
            (wrongOriginalToken.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        val accepted = reduce(pending, replayedResult)
        assertEquals(attempt, accepted.checkpoint?.openAttempt)
        assertEquals(frozenResume, accepted.checkpoint?.openRequestResume)

        val resetAttempt = openAttempt("open-frozen-reset", "frozen-reset-fingerprint")
        result = reduce(
            current,
            RelayV2TerminalAction.BeginOpenAttempt(
                deliveryToken = current.deliveryToken,
                requestId = "reset-network-1",
                openAttempt = resetAttempt,
                mode = RelayV2TerminalOpenMode.RESET,
                cols = 90,
                rows = 30,
                target = current.identity.target(),
                parserContinuityId = "parser-after-frozen-reset",
                resume = openResume(current, null),
            ),
        )
        val resetSend = result.effects.filterIsInstance<RelayV2TerminalEffect.SendOpen>().single()
        assertEquals(current.identity.generation, resetSend.resume?.generation)
        assertNull(resetSend.resume?.nextOffset)
        assertEquals(
            current.identity.resumeTokenCredentialFingerprint,
            resetSend.resume?.resumeTokenCredentialFingerprint,
        )
        val firstResetPending = requireNotNull(result.checkpoint)
        val prematureTail = reduce(
            firstResetPending,
            RelayV2TerminalAction.Opened(
                identity = current.identity.copy(
                    generation = "generation-reset-tail",
                    resumeTokenCredentialReference = "resume-token-ref-reset-tail",
                    resumeTokenCredentialFingerprint = "resume-token-fingerprint-reset-tail",
                ),
                requestId = "reset-network-1",
                openAttempt = resetAttempt,
                deliveryToken = current.deliveryToken,
                parserContinuityId = "parser-after-frozen-reset",
                disposition = RelayV2TerminalOpenDisposition.RESET,
                cols = 90,
                rows = 30,
                replayFromOffset = "0",
                tailOffset = "2",
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.GENERATION_STALE,
            (prematureTail.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        result = reduce(
            firstResetPending,
            RelayV2TerminalAction.BeginOpenAttempt(
                deliveryToken = current.deliveryToken,
                requestId = "reset-network-2",
                openAttempt = resetAttempt,
                mode = RelayV2TerminalOpenMode.RESET,
                cols = 90,
                rows = 30,
                target = current.identity.target(),
                parserContinuityId = "parser-after-frozen-reset",
                resume = openResume(current, null),
            ),
        )
        val retriedReset = requireNotNull(result.checkpoint)
        result = reduce(
            retriedReset,
            RelayV2TerminalAction.Opened(
                identity = current.identity.copy(
                    generation = "generation-reset-tail",
                    resumeTokenCredentialReference = "resume-token-ref-reset-tail",
                    resumeTokenCredentialFingerprint = "resume-token-fingerprint-reset-tail",
                ),
                requestId = "reset-network-2",
                openAttempt = resetAttempt,
                deliveryToken = current.deliveryToken,
                parserContinuityId = "parser-after-frozen-reset",
                disposition = RelayV2TerminalOpenDisposition.RESET,
                cols = 90,
                rows = 30,
                replayFromOffset = "0",
                tailOffset = "2",
                deduplicated = true,
            ),
        )
        var replayingReset = requireNotNull(result.checkpoint)
        assertEquals(RelayV2TerminalPhase.REPLAYING, replayingReset.phase)
        assertEquals("2", replayingReset.replayTargetOffset)
        val resetParser = result.effects.filterIsInstance<RelayV2TerminalEffect.ResetParser>().single()
        result = output(replayingReset, "0", "ab")
        replayingReset = requireNotNull(result.checkpoint)
        assertTrue(result.effects.none { it is RelayV2TerminalEffect.WriteParser })
        result = reduce(
            replayingReset,
            RelayV2TerminalAction.ParserResetApplied(resetParser.callbackToken),
        )
        assertTrue(result.effects.any { it is RelayV2TerminalEffect.WriteParser })
    }

    @Test
    fun `correlated open reset consumes authority and explicit reset replaces parser and host lineage`() {
        val initial = open()
        val resumeAttempt = openAttempt("open-before-reset", "before-reset-fingerprint")
        val pendingResume = beginOpen(initial, resumeAttempt, "before-reset-request")
        var result = reduce(
            pendingResume,
            RelayV2TerminalAction.CorrelatedResetRequired(
                actionFence(pendingResume),
                origin = RelayV2TerminalResetOrigin.OPEN,
                requestId = "before-reset-request",
                openAttempt = resumeAttempt,
                reason = RelayV2TerminalResetReason.STREAM_LOST,
                requestedOffset = null,
                bufferStartOffset = null,
                tailOffset = null,
            ),
        )
        var resetRequired = requireNotNull(result.checkpoint)
        assertEquals(RelayV2TerminalPhase.RESET_REQUIRED, resetRequired.phase)
        assertNull(resetRequired.pendingOpen)

        val resetAttempt = openAttempt("open-explicit-reset", "explicit-reset-fingerprint")
        result = reduce(
            resetRequired,
            RelayV2TerminalAction.BeginOpenAttempt(
                resetRequired.deliveryToken,
                requestId = "explicit-reset-request",
                openAttempt = resetAttempt,
                mode = RelayV2TerminalOpenMode.RESET,
                cols = 90,
                rows = 30,
                target = resetRequired.identity.target(),
                parserContinuityId = "replacement-parser-continuity",
                resume = openResume(resetRequired, null),
            ),
        )
        resetRequired = requireNotNull(result.checkpoint)
        assertEquals(resetAttempt, resetRequired.pendingOpen?.openAttempt)
        val staleResponse = reduce(
            resetRequired,
            RelayV2TerminalAction.Opened(
                initial.identity,
                requestId = "before-reset-request",
                openAttempt = resumeAttempt,
                deliveryToken = initial.deliveryToken,
                parserContinuityId = PARSER_CONTINUITY,
                disposition = RelayV2TerminalOpenDisposition.RESUMED,
                cols = 120,
                rows = 36,
                replayFromOffset = "0",
                tailOffset = "0",
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.STALE_OPEN_RESPONSE,
            (staleResponse.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )

        var withParserWork = open()
        withParserWork = requireNotNull(output(withParserWork, "0", "queued").checkpoint)
        val oldParserCallback = requireNotNull(withParserWork.parserInFlightCallbackToken)
        result = reduce(
            withParserWork,
            RelayV2TerminalAction.AsyncResetRequired(
                actionFence(withParserWork),
                correlationProofId = "actor-correlated-reset",
                reason = RelayV2TerminalResetReason.STREAM_LOST,
                requestedOffset = null,
                bufferStartOffset = null,
                tailOffset = null,
            ),
        )
        val dirtyReset = requireNotNull(result.checkpoint)
        assertEquals(1, dirtyReset.pendingOutput.size)
        assertEquals(oldParserCallback, dirtyReset.parserInFlightCallbackToken)

        val rejectedResume = reduce(
            dirtyReset,
            RelayV2TerminalAction.BeginOpenAttempt(
                dirtyReset.deliveryToken,
                requestId = "resume-dirty-request",
                openAttempt = openAttempt("open-dirty-resume", "dirty-resume-fingerprint"),
                mode = RelayV2TerminalOpenMode.RESUME,
                cols = 120,
                rows = 36,
                target = dirtyReset.identity.target(),
                parserContinuityId = dirtyReset.parserContinuityId,
                resume = openResume(dirtyReset, dirtyReset.parserAppliedNextOffset),
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.STREAM_LOST,
            (rejectedResume.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        val lineageResetAttempt = openAttempt("open-lineage-reset", "lineage-reset-fingerprint")
        result = reduce(
            dirtyReset,
            RelayV2TerminalAction.BeginOpenAttempt(
                dirtyReset.deliveryToken,
                requestId = "lineage-reset-request",
                openAttempt = lineageResetAttempt,
                mode = RelayV2TerminalOpenMode.RESET,
                cols = 80,
                rows = 24,
                target = dirtyReset.identity.target(),
                parserContinuityId = "parser-after-reset",
                resume = openResume(dirtyReset, null),
            ),
        )
        val dirtyPendingReset = requireNotNull(result.checkpoint)
        assertEquals(1, dirtyPendingReset.pendingOutput.size)
        assertEquals(oldParserCallback, dirtyPendingReset.parserInFlightCallbackToken)

        val replacedIdentity = dirtyReset.identity.copy(
            hostInstanceId = "host-process-2",
            generation = "generation-2",
            resumeTokenCredentialReference = "resume-token-ref-2",
            resumeTokenCredentialFingerprint = "resume-token-fingerprint-2",
        )
        result = reduce(
            dirtyPendingReset,
            RelayV2TerminalAction.Opened(
                replacedIdentity,
                requestId = "lineage-reset-request",
                openAttempt = lineageResetAttempt,
                deliveryToken = dirtyReset.deliveryToken,
                parserContinuityId = "parser-after-reset",
                disposition = RelayV2TerminalOpenDisposition.RESET,
                cols = 80,
                rows = 24,
                replayFromOffset = "0",
                tailOffset = "0",
            ),
        )
        val replaced = requireNotNull(result.checkpoint)
        assertEquals(RelayV2TerminalPhase.RESETTING_PARSER, replaced.phase)
        assertEquals("host-process-2", replaced.identity.hostInstanceId)
        assertEquals("parser-after-reset", replaced.parserContinuityId)
        assertTrue(replaced.pendingOutput.isEmpty())
        val resetParserToken = requireNotNull(replaced.parserResetCallbackToken)
        val resetDedupePending = requireNotNull(
            reduce(
                replaced,
                RelayV2TerminalAction.BeginOpenAttempt(
                    replaced.deliveryToken,
                    requestId = "lineage-reset-dedupe-request",
                    openAttempt = lineageResetAttempt,
                    mode = RelayV2TerminalOpenMode.RESET,
                    cols = 80,
                    rows = 24,
                    target = replaced.identity.target(),
                    parserContinuityId = "parser-after-reset",
                    resume = replaced.openRequestResume,
                ),
            ).checkpoint,
        )
        val resetDedupe = reduce(
            resetDedupePending,
            RelayV2TerminalAction.Opened(
                replacedIdentity,
                requestId = "lineage-reset-dedupe-request",
                openAttempt = lineageResetAttempt,
                deliveryToken = replaced.deliveryToken,
                parserContinuityId = "parser-after-reset",
                disposition = RelayV2TerminalOpenDisposition.RESET,
                cols = 80,
                rows = 24,
                replayFromOffset = "0",
                tailOffset = "0",
                deduplicated = true,
            ),
        )
        val resetDeduplicated = requireNotNull(resetDedupe.checkpoint)
        assertEquals(resetParserToken, resetDeduplicated.parserResetCallbackToken)
        assertTrue(resetDedupe.effects.isEmpty())
        val lateParser = reduce(
            resetDeduplicated,
            RelayV2TerminalAction.ParserApplied(oldParserCallback),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.STALE_PARSER_CALLBACK,
            (lateParser.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )

        val ordinaryResumeAttempt = openAttempt("open-wrong-host", "wrong-host-fingerprint")
        val ordinaryResume = beginOpen(initial, ordinaryResumeAttempt, "wrong-host-request")
        val crossedHost = reduce(
            ordinaryResume,
            RelayV2TerminalAction.Opened(
                initial.identity.copy(hostInstanceId = "host-process-2"),
                requestId = "wrong-host-request",
                openAttempt = ordinaryResumeAttempt,
                deliveryToken = initial.deliveryToken,
                parserContinuityId = PARSER_CONTINUITY,
                disposition = RelayV2TerminalOpenDisposition.RESUMED,
                cols = 120,
                rows = 36,
                replayFromOffset = "0",
                tailOffset = "0",
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.STREAM_LOST,
            (crossedHost.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
    }

    @Test
    fun `delivery freshness and closed replay watermarks reject stale or incomplete recovery`() {
        val initial = open()
        val sameGeneration = reduce(
            initial,
            RelayV2TerminalAction.RebindDelivery(
                initial.identity,
                initial.deliveryToken,
                delivery(connectionGeneration = 1, deliverySequence = 2),
                PARSER_CONTINUITY,
            ),
        )
        val sameGenerationCheckpoint = requireNotNull(sameGeneration.checkpoint)
        val staleLocal = reduce(
            sameGenerationCheckpoint,
            RelayV2TerminalAction.RebindDelivery(
                sameGenerationCheckpoint.identity,
                sameGenerationCheckpoint.deliveryToken,
                delivery(connectionGeneration = 1, deliverySequence = 1),
                PARSER_CONTINUITY,
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.STALE_DELIVERY,
            (staleLocal.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )

        val newerConnection = reduce(
            sameGenerationCheckpoint,
            RelayV2TerminalAction.RebindDelivery(
                sameGenerationCheckpoint.identity,
                sameGenerationCheckpoint.deliveryToken,
                delivery(connectionGeneration = 2, deliverySequence = 1),
                PARSER_CONTINUITY,
            ),
        )
        assertEquals(1L, newerConnection.checkpoint?.deliveryToken?.localDispatchToken)
        val oldConnection = reduce(
            requireNotNull(newerConnection.checkpoint),
            RelayV2TerminalAction.RebindDelivery(
                requireNotNull(newerConnection.checkpoint).identity,
                requireNotNull(newerConnection.checkpoint).deliveryToken,
                delivery(connectionGeneration = 1, deliverySequence = 99),
                PARSER_CONTINUITY,
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.STALE_DELIVERY,
            (oldConnection.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )

        val newerProfile = reduce(
            initial,
            RelayV2TerminalAction.RebindDelivery(
                initial.identity,
                initial.deliveryToken,
                delivery(
                    profileActivationGeneration = 8,
                    connectionGeneration = 1,
                    deliverySequence = 1,
                ),
                PARSER_CONTINUITY,
            ),
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.STALE_DELIVERY,
            (newerProfile.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertTrue(initial === newerProfile.checkpoint)

        val restartedAuthority = delivery(
            connectionGeneration = 1,
            deliverySequence = 1,
            authorityGeneration = 2,
        )
        val afterProcessRestart = reduce(
            requireNotNull(newerConnection.checkpoint),
            RelayV2TerminalAction.RebindDelivery(
                requireNotNull(newerConnection.checkpoint).identity,
                requireNotNull(newerConnection.checkpoint).deliveryToken,
                restartedAuthority,
                PARSER_CONTINUITY,
            ),
        )
        assertEquals(restartedAuthority, afterProcessRestart.checkpoint?.deliveryToken)
        val restoredAfterProcessRestart = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(initial),
            initial.identity,
            initial.openAttempt,
            restartedAuthority,
            initial.parserContinuityId,
        )
        assertTrue(restoredAfterProcessRestart.outcome is RelayV2TerminalOutcome.Restored)
        assertEquals(restartedAuthority, restoredAfterProcessRestart.checkpoint?.deliveryToken)

        var closed = open()
        var result = reduce(
            closed,
            closedAction(
                closed,
                finalOffset = "2",
                replayAvailable = true,
                bufferStartOffset = "0",
            ),
        )
        closed = requireNotNull(result.checkpoint)
        val replayRequest = result.effects.filterIsInstance<RelayV2TerminalEffect.RequestReplay>()
            .single()
        listOf(
            RelayV2TerminalRetainedBuffer(false, null),
            RelayV2TerminalRetainedBuffer(true, "1"),
        ).forEach { unavailable ->
            val unavailableReplay = reduce(
                closed.copy(closed = closed.closed?.copy(retainedBuffer = unavailable)),
                RelayV2TerminalAction.ReplayStarted(
                    closed.identity,
                    closed.openAttempt.openId,
                    closed.deliveryToken,
                    replayRequest.requestId,
                    fromOffset = "0",
                    tailOffsetAtStart = "2",
                ),
            )
            assertEquals(
                RelayV2TerminalResetReason.OFFSET_EXPIRED,
                (unavailableReplay.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
            )
        }
        val shortTail = reduce(
            closed,
            RelayV2TerminalAction.ReplayStarted(
                closed.identity,
                closed.openAttempt.openId,
                closed.deliveryToken,
                replayRequest.requestId,
                fromOffset = "0",
                tailOffsetAtStart = "1",
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            (shortTail.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        val exactTail = reduce(
            closed,
            RelayV2TerminalAction.ReplayStarted(
                closed.identity,
                closed.openAttempt.openId,
                closed.deliveryToken,
                replayRequest.requestId,
                fromOffset = "0",
                tailOffsetAtStart = "2",
            ),
        )
        assertEquals(RelayV2TerminalPhase.REPLAYING, exactTail.checkpoint?.phase)
        assertEquals("2", exactTail.checkpoint?.replayTargetOffset)
        val longTail = reduce(
            closed,
            RelayV2TerminalAction.ReplayStarted(
                closed.identity,
                closed.openAttempt.openId,
                closed.deliveryToken,
                replayRequest.requestId,
                fromOffset = "0",
                tailOffsetAtStart = "3",
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            (longTail.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        val expiredStored = closed.copy(
            closed = closed.closed?.copy(
                retainedBuffer = RelayV2TerminalRetainedBuffer(true, "1"),
            ),
        )
        val expired = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(expiredStored),
            closed.identity,
            closed.openAttempt,
            closed.deliveryToken,
            closed.parserContinuityId,
        )
        assertNull(expired.checkpoint)
        assertEquals(
            RelayV2TerminalResetReason.OFFSET_EXPIRED,
            (expired.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        val received = requireNotNull(output(open(), "0", "x").checkpoint)
        val targetBehindReceived = received.copy(
            phase = RelayV2TerminalPhase.REPLAYING,
            replayTargetOffset = "0",
        )
        val impossibleReplay = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(targetBehindReceived),
            received.identity,
            received.openAttempt,
            received.deliveryToken,
            received.parserContinuityId,
        )
        assertNull(impossibleReplay.checkpoint)
        assertEquals(
            RelayV2TerminalResetReason.CHECKPOINT_INVALID,
            (impossibleReplay.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
    }

    @Test
    fun `restore preflights hostile queues proves parser operations and fences current authority`() {
        val initial = open()
        val countGuard = object : AbstractList<RelayV2PendingParserWrite>() {
            override val size: Int
                get() = RelayV2TerminalCheckpointLimits.MAX_PENDING_OUTPUT_FRAMES + 1

            override fun get(index: Int): RelayV2PendingParserWrite =
                error("preflight must reject count before reading elements")
        }
        val overCount = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(initial.copy(pendingOutput = countGuard)),
            initial.identity,
            initial.openAttempt,
            initial.deliveryToken,
            initial.parserContinuityId,
        )
        assertNull(overCount.checkpoint)
        assertEquals(
            RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED,
            (overCount.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        val frame = RelayV2TerminalBytes.of(
            ByteArray(RelayV2TerminalCheckpointLimits.MAX_FRAME_BYTES),
        )
        var offset = 0
        val overByteWrites = List(9) { index ->
            val start = offset
            offset += frame.size
            RelayV2PendingParserWrite(
                RelayV2TerminalParserCallbackToken(
                    RelayV2TerminalEffectFence(
                        initial.identity,
                        initial.deliveryToken,
                        initial.openAttempt,
                    ),
                    initial.parserContinuityId,
                    "oversize-write-$index",
                    start.toString(),
                    offset.toString(),
                ),
                frame,
            )
        }
        val overBytes = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(
                initial.copy(
                    networkReceivedThrough = offset.toString(),
                    parserInFlightCallbackToken = overByteWrites.first().callbackToken,
                    pendingOutput = overByteWrites,
                ),
            ),
            initial.identity,
            initial.openAttempt,
            initial.deliveryToken,
            initial.parserContinuityId,
        )
        assertNull(overBytes.checkpoint)
        assertEquals(
            RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED,
            (overBytes.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        val queued = requireNotNull(output(initial, "0", "x").checkpoint)
        val writeToken = requireNotNull(queued.parserInFlightCallbackToken)
        val notApplied = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(queued),
            queued.identity,
            queued.openAttempt,
            queued.deliveryToken,
            queued.parserContinuityId,
            parserProof(writeToken, "0", RelayV2TerminalParserOperationStatus.NOT_APPLIED),
        )
        assertTrue(notApplied.outcome is RelayV2TerminalOutcome.Restored)
        assertEquals(
            writeToken,
            notApplied.effects.filterIsInstance<RelayV2TerminalEffect.WriteParser>()
                .single().callbackToken,
        )
        val reboundDelivery = delivery(connectionGeneration = 2, deliverySequence = 1)
        val provenBeforeRebind = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(queued),
            queued.identity,
            queued.openAttempt,
            reboundDelivery,
            queued.parserContinuityId,
            parserProof(writeToken, "0", RelayV2TerminalParserOperationStatus.NOT_APPLIED),
        )
        assertEquals(
            reboundDelivery,
            provenBeforeRebind.effects.filterIsInstance<RelayV2TerminalEffect.WriteParser>()
                .single().callbackToken.fence.deliveryToken,
        )
        val rewrittenProofToken = writeToken.copy(
            fence = writeToken.fence.copy(deliveryToken = reboundDelivery),
        )
        val rewrittenBeforeProof = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(queued),
            queued.identity,
            queued.openAttempt,
            reboundDelivery,
            queued.parserContinuityId,
            parserProof(
                rewrittenProofToken,
                "0",
                RelayV2TerminalParserOperationStatus.NOT_APPLIED,
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST,
            (rewrittenBeforeProof.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        assertEquals(reboundDelivery, rewrittenBeforeProof.checkpoint?.deliveryToken)
        assertTrue(
            rewrittenBeforeProof.effects.none { it is RelayV2TerminalEffect.WriteParser },
        )
        val applied = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(queued),
            queued.identity,
            queued.openAttempt,
            queued.deliveryToken,
            queued.parserContinuityId,
            parserProof(writeToken, "1", RelayV2TerminalParserOperationStatus.APPLIED),
        )
        assertEquals("1", applied.checkpoint?.parserAppliedNextOffset)
        assertEquals(
            "1",
            applied.effects.filterIsInstance<RelayV2TerminalEffect.OutputAck>().single().nextOffset,
        )
        val noProof = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(queued),
            queued.identity,
            queued.openAttempt,
            queued.deliveryToken,
            queued.parserContinuityId,
        )
        assertEquals(RelayV2TerminalPhase.RESET_REQUIRED, noProof.checkpoint?.phase)
        assertEquals(
            RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST,
            (noProof.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        val resetAttempt = openAttempt("open-proof-reset", "proof-reset-fingerprint")
        val resetPending = beginOpen(
            initial,
            resetAttempt,
            "proof-reset-request",
            RelayV2TerminalOpenMode.RESET,
            parserContinuityId = "proof-reset-parser",
        )
        val resetting = requireNotNull(
            reduce(
                resetPending,
                RelayV2TerminalAction.Opened(
                    initial.identity.copy(
                        generation = "generation-proof-reset",
                        resumeTokenCredentialReference = "resume-token-ref-proof-reset",
                        resumeTokenCredentialFingerprint =
                            "resume-token-fingerprint-proof-reset",
                    ),
                    requestId = "proof-reset-request",
                    openAttempt = resetAttempt,
                    deliveryToken = initial.deliveryToken,
                    parserContinuityId = "proof-reset-parser",
                    disposition = RelayV2TerminalOpenDisposition.RESET,
                    cols = 120,
                    rows = 36,
                    replayFromOffset = "0",
                    tailOffset = "0",
                ),
            ).checkpoint,
        )
        val resetToken = requireNotNull(resetting.parserResetCallbackToken)
        val priorGenerationProof = parserProof(
            resetToken.copy(
                fence = RelayV2TerminalEffectFence(
                    initial.identity,
                    initial.deliveryToken,
                    initial.openAttempt,
                ),
            ),
            "0",
            RelayV2TerminalParserOperationStatus.NOT_APPLIED,
        )
        val staleResetProof = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(resetting),
            resetting.identity,
            resetting.openAttempt,
            resetting.deliveryToken,
            resetting.parserContinuityId,
            priorGenerationProof,
        )
        assertEquals(
            RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST,
            (staleResetProof.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
        assertTrue(staleResetProof.effects.none { it is RelayV2TerminalEffect.ResetParser })
        val resetNotApplied = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(resetting),
            resetting.identity,
            resetting.openAttempt,
            resetting.deliveryToken,
            resetting.parserContinuityId,
            parserProof(resetToken, "0", RelayV2TerminalParserOperationStatus.NOT_APPLIED),
        )
        assertEquals(
            resetToken,
            resetNotApplied.effects.filterIsInstance<RelayV2TerminalEffect.ResetParser>()
                .single().callbackToken,
        )
        val resetApplied = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(resetting),
            resetting.identity,
            resetting.openAttempt,
            resetting.deliveryToken,
            resetting.parserContinuityId,
            parserProof(resetToken, "0", RelayV2TerminalParserOperationStatus.APPLIED),
        )
        assertEquals(RelayV2TerminalPhase.LIVE, resetApplied.checkpoint?.phase)

        val currentIdentity = initial.identity.copy(profileActivationGeneration = 8)
        val currentDelivery = delivery(
            profileActivationGeneration = 8,
            connectionGeneration = 1,
            deliverySequence = 1,
        )
        val currentAttempt = openAttempt("open-current-authority", "current-authority-fingerprint")
        val staleAuthority = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(queued),
            currentIdentity,
            currentAttempt,
            currentDelivery,
            queued.parserContinuityId,
        )
        assertNull(staleAuthority.checkpoint)
        val currentReset = staleAuthority.effects.filterIsInstance<
            RelayV2TerminalEffect.ResetRequired
            >().single()
        assertEquals(currentIdentity, currentReset.fence?.identity)
        assertEquals(currentDelivery, currentReset.fence?.deliveryToken)
        assertEquals(currentAttempt, currentReset.fence?.openAttempt)
        assertEquals(null, currentReset.parserAppliedNextOffset)
    }

    private fun parserProof(
        token: RelayV2TerminalParserCallbackToken,
        parserAppliedNextOffset: String,
        status: RelayV2TerminalParserOperationStatus,
    ): RelayV2TerminalParserRestoreProof = RelayV2TerminalParserRestoreProof(
        callbackToken = token,
        parserAppliedNextOffset = parserAppliedNextOffset,
        status = status,
    )

    private fun fillPendingFrames(
        frameCount: Int,
        frameBytes: Int,
    ): RelayV2TerminalCheckpoint {
        var checkpoint = open()
        val bytes = RelayV2TerminalBytes.of(ByteArray(frameBytes) { 1 })
        repeat(frameCount) {
            val result = reduce(
                checkpoint,
                RelayV2TerminalAction.Output(
                    actionFence(checkpoint),
                    checkpoint.networkReceivedThrough,
                    bytes,
                ),
            )
            checkpoint = requireNotNull(result.checkpoint)
            assertFalse(result.outcome is RelayV2TerminalOutcome.ResetRequired)
        }
        return checkpoint
    }

    private fun output(
        checkpoint: RelayV2TerminalCheckpoint,
        offset: String,
        data: String,
    ): RelayV2TerminalReduction = reduce(
        checkpoint,
        RelayV2TerminalAction.Output(
            actionFence(checkpoint),
            offset,
            RelayV2TerminalBytes.utf8(data),
        ),
    )

    private fun closedAction(
        checkpoint: RelayV2TerminalCheckpoint,
        finalOffset: String,
        replayAvailable: Boolean,
        bufferStartOffset: String?,
        closeId: String? = null,
        requestId: String? = closeId?.let {
            checkpoint.pendingClose?.takeIf { pending ->
                pending.closeAttempt.closeId == closeId
            }?.requestId ?: "close-request-1"
        },
    ): RelayV2TerminalAction.Closed = RelayV2TerminalAction.Closed(
        actionFence(checkpoint),
        finalOffset,
        replayAvailable,
        bufferStartOffset,
        RelayV2TerminalCloseReason.BACKEND_EXIT,
        exitCode = 0,
        closeId = closeId,
        requestId = requestId,
    )

    private fun closedWatermark(
        checkpoint: RelayV2TerminalCheckpoint = open(),
        finalOffset: String,
        replayAvailable: Boolean,
        bufferStartOffset: String?,
        closeAttempt: RelayV2TerminalCloseAttempt? = null,
    ): RelayV2TerminalClosedState = RelayV2TerminalClosedState(
        tombstone = RelayV2TerminalClosedTombstone(
            finalOffset,
            RelayV2TerminalCloseReason.BACKEND_EXIT,
            exitCode = 0,
            closeAttempt = closeAttempt,
            generation = checkpoint.identity.generation,
            openId = checkpoint.openAttempt.openId,
        ),
        retainedBuffer = RelayV2TerminalRetainedBuffer(
            replayAvailable,
            bufferStartOffset,
        ),
    )

    private fun parserResetToken(
        checkpoint: RelayV2TerminalCheckpoint,
        operationId: String,
    ): RelayV2TerminalParserCallbackToken = RelayV2TerminalParserCallbackToken(
        RelayV2TerminalEffectFence(
            checkpoint.identity,
            checkpoint.deliveryToken,
            checkpoint.openAttempt,
        ),
        checkpoint.parserContinuityId,
        operationId,
        startOffset = "0",
        endOffset = "0",
    )

    private fun open(
        identity: RelayV2TerminalIdentity = identity(),
        deliveryToken: RelayV2TerminalDeliveryToken = delivery(
            profileActivationGeneration = identity.profileActivationGeneration,
        ),
        parserContinuityId: String = PARSER_CONTINUITY,
        openAttempt: RelayV2TerminalOpenAttempt = openAttempt(),
    ): RelayV2TerminalCheckpoint {
        val begun = RelayV2TerminalCheckpointReducer.reduce(
            null,
            RelayV2TerminalAction.BeginOpenAttempt(
                deliveryToken,
                requestId = "open-request-1",
                openAttempt = openAttempt,
                mode = RelayV2TerminalOpenMode.NEW,
                cols = 120,
                rows = 36,
                target = identity.target(),
                parserContinuityId = parserContinuityId,
                resume = null,
            ),
        )
        return requireNotNull(
            RelayV2TerminalCheckpointReducer.reduce(
                requireNotNull(begun.preOpenCheckpoint),
            RelayV2TerminalAction.Opened(
                identity,
                requestId = "open-request-1",
                openAttempt = openAttempt,
                deliveryToken = deliveryToken,
                parserContinuityId = parserContinuityId,
                RelayV2TerminalOpenDisposition.NEW,
                cols = 120,
                rows = 36,
                replayFromOffset = "0",
                tailOffset = "0",
            ),
            ).checkpoint,
        )
    }

    private fun reduce(
        checkpoint: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction,
    ): RelayV2TerminalReduction = RelayV2TerminalCheckpointReducer.reduce(checkpoint, action)

    private fun beginOpen(
        checkpoint: RelayV2TerminalCheckpoint,
        attempt: RelayV2TerminalOpenAttempt,
        requestId: String,
        mode: RelayV2TerminalOpenMode = RelayV2TerminalOpenMode.RESUME,
        cols: Int = checkpoint.openedCols,
        rows: Int = checkpoint.openedRows,
        parserContinuityId: String = checkpoint.parserContinuityId,
        resume: RelayV2TerminalOpenResume? = when (mode) {
            RelayV2TerminalOpenMode.NEW -> null
            RelayV2TerminalOpenMode.RESUME -> openResume(
                checkpoint,
                checkpoint.parserAppliedNextOffset,
            )
            RelayV2TerminalOpenMode.RESET -> openResume(checkpoint, null)
        },
    ): RelayV2TerminalCheckpoint = requireNotNull(
        reduce(
            checkpoint,
            RelayV2TerminalAction.BeginOpenAttempt(
                checkpoint.deliveryToken,
                requestId,
                attempt,
                mode,
                cols,
                rows,
                checkpoint.identity.target(),
                parserContinuityId,
                resume,
            ),
        ).checkpoint,
    )

    private fun actionFence(
        checkpoint: RelayV2TerminalCheckpoint,
        hostInstanceId: String = checkpoint.identity.hostInstanceId,
        generation: String = checkpoint.identity.generation,
        deliveryToken: RelayV2TerminalDeliveryToken = checkpoint.deliveryToken,
        openId: String = checkpoint.openAttempt.openId,
    ): RelayV2TerminalActionFence = RelayV2TerminalActionFence(
        RelayV2TerminalBinding(hostInstanceId, generation),
        deliveryToken,
        openId,
    )

    private fun identity(): RelayV2TerminalIdentity = RelayV2TerminalIdentity(
        profileId = "profile-v2",
        profileActivationGeneration = 7,
        principalId = "principal-v2",
        clientInstanceId = "android-install-v2",
        hostId = "mac-admin",
        hostEpoch = "host-authority-1",
        hostInstanceId = "host-process-1",
        scopeId = "scope-local",
        sessionId = "session-opaque-1",
        streamId = "stream-1",
        generation = "generation-1",
        resumeTokenCredentialReference = "resume-token-ref-1",
        resumeTokenCredentialFingerprint = "resume-token-fingerprint-1",
        pane = 0,
    )

    private fun delivery(
        profileActivationGeneration: Long = 7,
        connectionGeneration: Long = 1,
        deliverySequence: Long = 1,
        authorityGeneration: Long = 1,
    ): RelayV2TerminalDeliveryToken = RelayV2TerminalDeliveryToken(
        actorGeneration = RelayV2EffectGeneration(
            profileId = "profile-v2",
            profileGeneration = profileActivationGeneration,
            connectionGeneration = connectionGeneration,
        ),
        authorityGeneration = authorityGeneration,
        localDispatchToken = deliverySequence,
    )

    private fun openResume(
        checkpoint: RelayV2TerminalCheckpoint,
        nextOffset: String?,
    ): RelayV2TerminalOpenResume = RelayV2TerminalOpenResume(
        generation = checkpoint.identity.generation,
        nextOffset = nextOffset,
        resumeTokenCredentialReference = checkpoint.identity.resumeTokenCredentialReference,
        resumeTokenCredentialFingerprint =
        checkpoint.identity.resumeTokenCredentialFingerprint,
    )

    private fun openAttempt(
        openId: String = "open-1",
        fingerprint: String = "open-fingerprint-1",
    ): RelayV2TerminalOpenAttempt = RelayV2TerminalOpenAttempt(openId, fingerprint)

    private fun closeAttempt(
        closeId: String = "close-1",
        fingerprint: String = "close-fingerprint-1",
    ): RelayV2TerminalCloseAttempt = RelayV2TerminalCloseAttempt(closeId, fingerprint)

    private companion object {
        const val PARSER_CONTINUITY = "xterm-parser-instance-1"
        const val UINT64_MAX = "18446744073709551615"
        const val UINT64_MAX_MINUS_ONE = "18446744073709551614"
    }
}
