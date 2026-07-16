package com.tmuxworktree.mobile.core.relay.v2.terminal

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
                checkpoint.deliveryToken,
                PARSER_CONTINUITY,
            )
            assertEquals(case.reason, (result.outcome as RelayV2TerminalOutcome.ResetRequired).reason)
            assertTrue(result.effects.single() is RelayV2TerminalEffect.ResetRequired)
        }

        val continuityLost = RelayV2TerminalCheckpointReducer.restore(
            RelayV2TerminalStoredCheckpoint.Present(checkpoint),
            identity,
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

        val activationChanged = reduce(
            checkpoint,
            RelayV2TerminalAction.Opened(
                identity.copy(profileActivationGeneration = 8),
                checkpoint.deliveryToken,
                PARSER_CONTINUITY,
                RelayV2TerminalOpenDisposition.RESUMED,
                cols = 120,
                rows = 36,
                replayFromOffset = "0",
                tailOffset = "0",
            ),
        )
        assertEquals(
            RelayV2TerminalResetReason.IDENTITY_CHANGED,
            (activationChanged.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
        )
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
                    identity = callback.fence.identity.copy(openId = "other-open"),
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
            RelayV2TerminalAction.RequestClose(itemFull.deliveryToken),
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

        result = reduce(itemReset, RelayV2TerminalAction.RequestClose(itemReset.deliveryToken))
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

        val lateOutput = output(finalized, "3", "x")
        val lateCallback = reduce(finalized, RelayV2TerminalAction.ParserApplied(callback))
        listOf(lateOutput, lateCallback).forEach { late ->
            assertEquals(
                RelayV2TerminalIgnoredReason.FINALIZED_LATE_EVENT,
                (late.outcome as RelayV2TerminalOutcome.Ignored).reason,
            )
            assertEquals(finalized, late.checkpoint)
            assertTrue(late.effects.isEmpty())
        }
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
    fun `input resize ack resend coalesce gap conflict and generation reset remain separate`() {
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
        val replacement = result.effects.filterIsInstance<RelayV2TerminalEffect.SendResize>().single()
        assertEquals("1", replacement.resizeSeq)
        assertTrue(replacement.replacesQueued)
        assertEquals("2", checkpoint.nextResizeSeq)
        assertEquals(120, checkpoint.pendingResizes.single().cols)

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
        assertEquals("2", result.effects.filterIsInstance<RelayV2TerminalEffect.SendResize>()
            .single().resizeSeq)
        assertEquals(listOf("1", "2"), checkpoint.pendingResizes.map { it.resizeSeq })

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
        result = reduce(
            resetSource,
            RelayV2TerminalAction.Opened(
                resetIdentity,
                resetDelivery,
                PARSER_CONTINUITY,
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
    ): RelayV2TerminalAction.Closed = RelayV2TerminalAction.Closed(
        actionFence(checkpoint),
        finalOffset,
        replayAvailable,
        bufferStartOffset,
        RelayV2TerminalCloseReason.BACKEND_EXIT,
        exitCode = 0,
        closeId = null,
    )

    private fun open(
        identity: RelayV2TerminalIdentity = identity(),
        deliveryToken: RelayV2TerminalDeliveryToken = delivery(
            profileActivationGeneration = identity.profileActivationGeneration,
        ),
        parserContinuityId: String = PARSER_CONTINUITY,
    ): RelayV2TerminalCheckpoint = requireNotNull(
        RelayV2TerminalCheckpointReducer.reduce(
            null,
            RelayV2TerminalAction.Opened(
                identity,
                deliveryToken,
                parserContinuityId,
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

    private fun actionFence(
        checkpoint: RelayV2TerminalCheckpoint,
        hostInstanceId: String = checkpoint.identity.hostInstanceId,
        generation: String = checkpoint.identity.generation,
        deliveryToken: RelayV2TerminalDeliveryToken = checkpoint.deliveryToken,
    ): RelayV2TerminalActionFence = RelayV2TerminalActionFence(
        RelayV2TerminalBinding(hostInstanceId, generation),
        deliveryToken,
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
        openId = "open-1",
        closeId = "close-1",
        resumeTokenCredentialReference = "resume-token-ref-1",
        pane = 0,
    )

    private fun delivery(
        profileActivationGeneration: Long = 7,
        connectionGeneration: Long = 1,
        deliverySequence: Long = 1,
    ): RelayV2TerminalDeliveryToken = RelayV2TerminalDeliveryToken(
        profileActivationGeneration,
        connectionGeneration,
        deliverySequence,
        routeId = "route-$connectionGeneration-$deliverySequence",
        routeFence = "fence-$connectionGeneration-$deliverySequence",
    )

    private companion object {
        const val PARSER_CONTINUITY = "xterm-parser-instance-1"
        const val UINT64_MAX = "18446744073709551615"
        const val UINT64_MAX_MINUS_ONE = "18446744073709551614"
    }
}
