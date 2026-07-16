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
            delivery(deliverySequence = 99, connectionGeneration = 99),
            "replacement-parser",
        )
        assertEquals(
            RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST,
            (continuityLost.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )

        val nextDelivery = delivery(deliverySequence = 2, connectionGeneration = 2)
        val requiresRebind = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(checkpoint),
            identity,
            checkpoint.openAttempt,
            nextDelivery,
            PARSER_CONTINUITY,
        )
        assertEquals(
            RelayV2TerminalIgnoredReason.STALE_DELIVERY,
            (requiresRebind.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
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
                pendingClose = RelayV2TerminalPendingClose(closeAttempt()),
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
            RelayV2TerminalAction.RequestClose(itemFull.deliveryToken, closeAttempt()),
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
            RelayV2TerminalAction.RequestClose(itemReset.deliveryToken, closeAttempt()),
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
            RelayV2TerminalAction.RequestClose(finalized.deliveryToken, closeAttempt()),
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
            assertEquals(finalized, late.checkpoint)
            assertTrue(late.effects.isEmpty())
        }
        val unauthorizedOpenAttempt = openAttempt("late-open", "late-open-fingerprint")
        val unauthorizedOpen = reduce(
            finalized,
            RelayV2TerminalAction.Opened(
                finalized.identity.copy(
                    generation = "generation-late",
                    resumeTokenCredentialReference = "resume-token-ref-late",
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
            RelayV2TerminalIgnoredReason.STALE_OPEN_RESPONSE,
            (unauthorizedOpen.outcome as RelayV2TerminalOutcome.Ignored).reason,
        )
        assertEquals(finalized, unauthorizedOpen.checkpoint)
        assertTrue(unauthorizedOpen.effects.isEmpty())
        val authorizedPending = beginOpen(
            finalized,
            unauthorizedOpenAttempt,
            "late-open-request",
        )
        val authorizedOpen = reduce(
            authorizedPending,
            RelayV2TerminalAction.Opened(
                finalized.identity.copy(
                    generation = "generation-late",
                    resumeTokenCredentialReference = "resume-token-ref-late",
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
        assertEquals(RelayV2TerminalPhase.RESETTING_PARSER, authorizedOpen.checkpoint?.phase)
        assertTrue(authorizedOpen.effects.single() is RelayV2TerminalEffect.ResetParser)
    }

    @Test
    fun `parser reset remains a hard barrier across closed replay and queued output`() {
        val previous = open()
        val resetIdentity = previous.identity.copy(
            generation = "generation-2",
            resumeTokenCredentialReference = "resume-token-ref-2",
        )
        val resetAttempt = openAttempt("open-reset-2", "reset-fingerprint-2")
        val resetPending = beginOpen(previous, resetAttempt, "reset-request-2")
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
        val pendingReset = beginOpen(initial, resetAttempt, "reset-request")
        val resetIdentity = initial.identity.copy(
            generation = "generation-2",
            resumeTokenCredentialReference = "resume-token-ref-2",
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
    fun `replay rebind uses actor generation local token and stale reset cannot kill timeline`() {
        val initial = open()
        var result = output(initial, "1", "x")
        val requested = requireNotNull(result.checkpoint)
        val firstRequest = result.effects.filterIsInstance<RelayV2TerminalEffect.RequestReplay>()
            .single()
        val reboundDelivery = delivery(connectionGeneration = 1, deliverySequence = 2)
        result = reduce(
            requested,
            RelayV2TerminalAction.RebindDelivery(
                requested.identity,
                requested.deliveryToken,
                reboundDelivery,
                requested.parserContinuityId,
            ),
        )
        var rebound = requireNotNull(result.checkpoint)
        val reboundRequest = result.effects.filterIsInstance<RelayV2TerminalEffect.RequestReplay>()
            .single()
        assertEquals(firstRequest.requestId, reboundRequest.requestId)
        assertEquals(reboundDelivery, reboundRequest.fence.deliveryToken)
        assertEquals(reboundDelivery, rebound.pendingReplay?.fence?.deliveryToken)

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
            RelayV2TerminalIgnoredReason.STALE_DELIVERY,
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
    fun `closed freezes controls advances ring metadata and resumes from local tombstone`() {
        var checkpoint = open()
        checkpoint = requireNotNull(
            reduce(
                checkpoint,
                RelayV2TerminalAction.EnqueueInput(
                    checkpoint.deliveryToken,
                    RelayV2TerminalBytes.utf8("input"),
                ),
            ).checkpoint,
        )
        checkpoint = requireNotNull(
            reduce(
                checkpoint,
                RelayV2TerminalAction.EnqueueResize(checkpoint.deliveryToken, 90, 30),
            ).checkpoint,
        )
        val closedWithGap = reduce(
            checkpoint,
            closedAction(checkpoint, "2", replayAvailable = true, bufferStartOffset = "0"),
        )
        val frozen = requireNotNull(closedWithGap.checkpoint)
        assertEquals(listOf("1"), frozen.ambiguousInputs.map { it.inputSeq })
        assertTrue(frozen.pendingInputs.isEmpty())
        assertTrue(frozen.pendingResizes.isEmpty())
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
                RelayV2TerminalAction.RequestClose(frozen.deliveryToken, closeAttempt()),
            ).effects.isEmpty(),
        )

        var sentInput = open()
        sentInput = requireNotNull(
            reduce(
                sentInput,
                RelayV2TerminalAction.EnqueueInput(
                    sentInput.deliveryToken,
                    RelayV2TerminalBytes.utf8("sent-before-close"),
                ),
            ).checkpoint,
        )
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
    }

    @Test
    fun `close attempt survives rebind resume and natural close converges exact response`() {
        var checkpoint = open()
        val closeAttempt = closeAttempt("close-current", "close-current-fingerprint")
        var result = reduce(
            checkpoint,
            RelayV2TerminalAction.RequestClose(checkpoint.deliveryToken, closeAttempt),
        )
        checkpoint = requireNotNull(result.checkpoint)
        assertEquals("close-current", result.effects.filterIsInstance<RelayV2TerminalEffect.SendClose>()
            .single().closeId)

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
        assertEquals("close-current", result.effects.filterIsInstance<RelayV2TerminalEffect.SendClose>()
            .single().closeId)

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
        assertEquals("close-current", result.effects.filterIsInstance<RelayV2TerminalEffect.SendClose>()
            .single().closeId)
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
    ): RelayV2TerminalAction.Closed = RelayV2TerminalAction.Closed(
        actionFence(checkpoint),
        finalOffset,
        replayAvailable,
        bufferStartOffset,
        RelayV2TerminalCloseReason.BACKEND_EXIT,
        exitCode = 0,
        closeId = closeId,
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
    ): RelayV2TerminalCheckpoint = requireNotNull(
        RelayV2TerminalCheckpointReducer.reduce(
            null,
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

    private fun reduce(
        checkpoint: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction,
    ): RelayV2TerminalReduction = RelayV2TerminalCheckpointReducer.reduce(checkpoint, action)

    private fun beginOpen(
        checkpoint: RelayV2TerminalCheckpoint,
        attempt: RelayV2TerminalOpenAttempt,
        requestId: String,
    ): RelayV2TerminalCheckpoint = requireNotNull(
        reduce(
            checkpoint,
            RelayV2TerminalAction.BeginOpenAttempt(
                checkpoint.deliveryToken,
                requestId,
                attempt,
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
        pane = 0,
    )

    private fun delivery(
        profileActivationGeneration: Long = 7,
        connectionGeneration: Long = 1,
        deliverySequence: Long = 1,
    ): RelayV2TerminalDeliveryToken = RelayV2TerminalDeliveryToken(
        actorGeneration = RelayV2EffectGeneration(
            profileId = "profile-v2",
            profileGeneration = profileActivationGeneration,
            connectionGeneration = connectionGeneration,
        ),
        localDispatchToken = deliverySequence,
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
