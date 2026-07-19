package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEntryId
import com.tmuxworktree.mobile.core.relay.v2.state.*
import com.tmuxworktree.mobile.core.relay.v2.terminal.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2TerminalRuntimeAdapterTest {
    @Test
    fun `construction is inert and non edge effects retain ownership upstream`() = runBlocking {
        val fixture = fixture()
        val checkpoint = fixture.checkpoint()
        val effect = RelayV2TerminalEffect.RequestReplay(
            effectFence(checkpoint),
            requestId = "not-owned",
            generation = checkpoint.identity.generation,
            fromOffset = checkpoint.parserAppliedNextOffset,
        )
        val transactionsBefore = fixture.store.transactionCount

        val result = fixture.adapter.handle(fixture.authority, effect)

        assertSame(effect, (result as RelayV2TerminalRuntimeApplyResult.NotOwned).effect)
        assertEquals(transactionsBefore, fixture.store.transactionCount)
        fixture.assertNoExternalCalls()
    }

    @Test
    fun `parser callback hands output ack and next write to bounded upper sink`() = runBlocking {
        val fixture = fixture()
        val first = fixture.enqueueOutput("0", "abc")
        val dispatched = fixture.adapter.handle(fixture.authority, first)
            as RelayV2TerminalRuntimeApplyResult.ParserDispatched
        assertEquals(first.callbackToken, dispatched.callbackToken)
        val firstPending = fixture.parser.writes.single()
        assertArrayEquals("abc".toByteArray(), requireNotNull(firstPending.bytes))

        val afterFirstDispatch = fixture.checkpoint()
        val queuedSecond = fixture.repository.reduceTerminalUnderApplyLease(
            fixture.key,
            RelayV2TerminalAction.Output(
                actionFence(afterFirstDispatch),
                "3",
                RelayV2TerminalBytes.utf8("de"),
            ),
        )
        assertTrue(queuedSecond.effects.isEmpty())

        var activationMarker: RelayV2TerminalParserEffectActivation? = null
        var nextDispatch: RelayV2TerminalRuntimeApplyResult? = null
        var nextClaimToken: RelayV2TerminalParserCallbackToken? = null
        fixture.sink.beforeActivate = { reservation ->
            val checkpoint = runBlocking { fixture.checkpoint() }
            assertEquals(null, checkpoint.pendingParserEffectHandoff)
            activationMarker = checkpoint.pendingParserEffectActivation
            assertEquals(
                reservation.identity,
                RelayV2TerminalPostCommitEffectReservationIdentity(
                    requireNotNull(activationMarker).reservationId,
                    requireNotNull(activationMarker).batchFingerprint,
                ),
            )
        }
        fixture.sink.acceptOwner = { reservation ->
            val nextWrite = reservation.batch.effects
                .filterIsInstance<RelayV2TerminalEffect.WriteParser>()
                .single()
            nextClaimToken = nextWrite.callbackToken
            nextDispatch = runBlocking {
                fixture.adapter.handle(fixture.authority, nextWrite)
            }
            val claimedCheckpoint = runBlocking { fixture.checkpoint() }
            assertEquals(activationMarker, claimedCheckpoint.pendingParserEffectActivation)
            assertEquals(
                nextWrite.callbackToken,
                claimedCheckpoint.pendingParserDispatchClaim?.callbackToken,
            )
        }

        firstPending.completion(true)

        val batch = fixture.sink.batches.single()
        assertEquals(first.callbackToken, batch.callbackToken)
        assertEquals(
            listOf(
                RelayV2TerminalEffect.OutputAck::class,
                RelayV2TerminalEffect.WriteParser::class,
            ),
            batch.effects.map { it::class },
        )
        assertTrue(nextDispatch is RelayV2TerminalRuntimeApplyResult.ParserDispatched)
        assertEquals(2, fixture.parser.writes.size)
        assertEquals("5", fixture.checkpoint().networkReceivedThrough)
        assertEquals("3", fixture.checkpoint().parserAppliedNextOffset)
        assertEquals(null, fixture.checkpoint().pendingParserEffectHandoff)
        assertEquals(null, fixture.checkpoint().pendingParserEffectActivation)
        assertEquals(
            nextClaimToken,
            fixture.checkpoint().pendingParserDispatchClaim?.callbackToken,
        )
        assertNotNull(activationMarker)

        firstPending.completion(true)
        assertEquals(1, fixture.sink.batches.size)
        assertEquals("3", fixture.checkpoint().parserAppliedNextOffset)
    }

    @Test
    fun `external cancellation propagates after exact authority withdrawal`() = runBlocking {
        val parserFixture = fixture()
        val parserWrite = parserFixture.enqueueOutput("0", "cancel-parser")
        val parserCancellation = CancellationException("parser cancelled after mutation")
        parserFixture.parser.writeFailureAfterRecord = parserCancellation
        val parserInvalidationEntered = CompletableDeferred<Unit>()
        val allowParserInvalidation = CompletableDeferred<Unit>()
        parserFixture.fatalInvalidation.beforeInvalidate = {
            parserInvalidationEntered.complete(Unit)
            allowParserInvalidation.await()
        }

        val parserFailure = async(Dispatchers.Default) {
            captureFailure { parserFixture.adapter.handle(parserFixture.authority, parserWrite) }
        }
        parserInvalidationEntered.await()
        val duplicateWhilePoisoned = parserFixture.adapter.handle(
            parserFixture.authority,
            parserWrite,
        )
        assertTrue(duplicateWhilePoisoned is RelayV2TerminalRuntimeApplyResult.Stale)
        assertEquals(1, parserFixture.parser.writes.size)
        allowParserInvalidation.complete(Unit)
        assertSame(parserCancellation, parserFailure.await())
        assertEquals(
            parserWrite.callbackToken,
            parserFixture.checkpoint().pendingParserDispatchClaim?.callbackToken,
        )
        assertEquals(null, parserFixture.lease.currentAuthority)
        assertEquals(
            RelayV2TerminalFatalInvalidationReason.EXTERNAL_SIDE_EFFECT_CANCELLED,
            parserFixture.fatalInvalidation.calls.single().reason,
        )

        val controlFixture = fixture()
        val input = controlFixture.enqueueInput("cancel-control")
        val controlCancellation = CancellationException("transport cancelled after send")
        controlFixture.control.inputFailureAfterRecord = controlCancellation

        val controlFailure = captureFailure {
            controlFixture.adapter.handle(controlFixture.authority, input)
        }

        assertSame(controlCancellation, controlFailure)
        assertEquals(1, controlFixture.control.inputs.size)
        assertEquals(
            RelayV2TerminalControlDispatchClaimPhase.CLAIMED,
            controlFixture.checkpoint().pendingInputs.single().dispatchClaim?.phase,
        )
        assertEquals(null, controlFixture.lease.currentAuthority)
        assertEquals(
            RelayV2TerminalFatalInvalidationReason.EXTERNAL_SIDE_EFFECT_CANCELLED,
            controlFixture.fatalInvalidation.calls.single().reason,
        )

        val activationFixture = fixture()
        val activationWrite = activationFixture.enqueueOutput("0", "cancel-activation")
        activationFixture.adapter.handle(activationFixture.authority, activationWrite)
        val blockedInput = activationFixture.enqueueInput("blocked-after-cleanup-failure")
        val activationCancellation = CancellationException("activation cancelled")
        val withdrawalFailure = IllegalStateException("authority withdrawal failed")
        val teardownFailure = IllegalStateException("sink teardown failed")
        activationFixture.sink.beforeActivate = { throw activationCancellation }
        activationFixture.fatalInvalidation.beforeInvalidate = { throw withdrawalFailure }
        activationFixture.sink.teardownFailureAfterRecord = teardownFailure

        val activationFailure = captureFailure {
            activationFixture.parser.writes.single().completion(true)
        }

        assertSame(activationCancellation, activationFailure)
        assertEquals(
            listOf(withdrawalFailure, teardownFailure),
            activationFailure?.suppressed?.toList(),
        )
        assertEquals(1, activationFixture.sink.reservations.single().activationCalls)
        assertNotNull(activationFixture.checkpoint().pendingParserEffectActivation)
        assertEquals(
            listOf(activationFixture.authority to activationFixture.key),
            activationFixture.sink.teardownCalls,
        )
        assertEquals(
            RelayV2TerminalFatalInvalidationReason.PARSER_EFFECT_ACTIVATION_UNCERTAIN,
            activationFixture.fatalInvalidation.calls.single().reason,
        )
        val transactionsBeforeBlockedRetry = activationFixture.store.transactionCount
        assertTrue(
            activationFixture.adapter.handle(activationFixture.authority, blockedInput) is
                RelayV2TerminalRuntimeApplyResult.Stale,
        )
        assertEquals(transactionsBeforeBlockedRetry, activationFixture.store.transactionCount)
        assertTrue(activationFixture.control.inputs.isEmpty())
        assertEquals(1, activationFixture.fatalInvalidation.calls.size)
        assertEquals(1, activationFixture.sink.teardownCalls.size)
    }

    @Test
    fun `cancelled callback waiter poisons once and late sink teardown stays exact once`() =
        runBlocking {
            val fixture = fixture()
            val firstWrite = fixture.enqueueOutput("0", "first")
            fixture.adapter.handle(fixture.authority, firstWrite)
            val checkpoint = fixture.checkpoint()
            fixture.repository.reduceTerminalUnderApplyLease(
                fixture.key,
                RelayV2TerminalAction.Output(
                    actionFence(checkpoint),
                    "5",
                    RelayV2TerminalBytes.utf8("second"),
                ),
            )

            val secondRegistered = CompletableDeferred<Unit>()
            val allowFirstOwnerToReturn = CompletableDeferred<Unit>()
            fixture.sink.acceptOwner = { reservation ->
                val nextWrite = reservation.batch.effects
                    .filterIsInstance<RelayV2TerminalEffect.WriteParser>()
                    .single()
                runBlocking { fixture.adapter.handle(fixture.authority, nextWrite) }
                secondRegistered.complete(Unit)
                runBlocking { allowFirstOwnerToReturn.await() }
                throw IllegalStateException("activation ownership became unknown")
            }
            val invalidationEntered = CompletableDeferred<Unit>()
            val allowInvalidation = CompletableDeferred<Unit>()
            fixture.fatalInvalidation.beforeInvalidate = {
                invalidationEntered.complete(Unit)
                allowInvalidation.await()
            }

            val firstSettlement = async(Dispatchers.Default) {
                fixture.parser.writes.first().completion(true)
            }
            secondRegistered.await()
            // The current owner still holds the keyed gate, so undispatched start returns only
            // after this child has reached and suspended on that exact gate acquisition.
            val cancelledWaiter = async(start = CoroutineStart.UNDISPATCHED) {
                fixture.parser.writes[1].completion(true)
            }
            assertTrue(cancelledWaiter.isActive)
            cancelledWaiter.cancel(CancellationException("cancel keyed-gate waiter"))
            invalidationEntered.await()

            allowFirstOwnerToReturn.complete(Unit)
            firstSettlement.await()
            assertEquals(1, fixture.fatalInvalidation.calls.size)
            assertTrue(fixture.sink.teardownCalls.isEmpty())

            allowInvalidation.complete(Unit)
            assertTrue(captureFailure { cancelledWaiter.await() } is CancellationException)
            assertEquals(1, fixture.fatalInvalidation.calls.size)
            assertEquals(
                listOf(fixture.authority to fixture.key),
                fixture.sink.teardownCalls,
            )
        }

    @Test
    fun `reset committed before parser registration revokes stale write`() = runBlocking {
        val fixture = fixture()
        val write = fixture.enqueueOutput("0", "stale")
        val checkpoint = fixture.checkpoint()
        fixture.repository.reduceTerminalUnderApplyLease(
            fixture.key,
            RelayV2TerminalAction.AsyncResetRequired(
                actionFence(checkpoint),
                "reset-before-parser",
                RelayV2TerminalResetReason.STREAM_LOST,
                requestedOffset = null,
                bufferStartOffset = null,
                tailOffset = null,
            ),
        )

        val result = fixture.adapter.handle(fixture.authority, write)
            as RelayV2TerminalRuntimeApplyResult.Rejected

        assertEquals(RelayV2TerminalRuntimeRejection.PARSER_REVOKED, result.reason)
        assertTrue(fixture.parser.writes.isEmpty())
        assertTrue(fixture.sink.batches.isEmpty())
    }

    @Test
    fun `parser failure closes registration and callback false hands off the whole reset batch`() =
        runBlocking {
            val fixture = fixture()
            val write = fixture.enqueueOutput("0", "mutated")
            fixture.parser.writeFailureAfterRecord = IllegalStateException("webview callback lost")

            val failed = fixture.adapter.handle(fixture.authority, write)
                as RelayV2TerminalRuntimeApplyResult.ParserFailedClosed

            assertEquals(
                RelayV2TerminalResetReason.PARSER_FAILURE,
                (failed.reduction.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
            )
            assertEquals(RelayV2TerminalPhase.RESET_REQUIRED, fixture.checkpoint().phase)
            assertEquals(1, fixture.parser.writes.size)

            val duplicate = fixture.adapter.handle(fixture.authority, write)
                as RelayV2TerminalRuntimeApplyResult.Rejected
            assertEquals(RelayV2TerminalRuntimeRejection.PARSER_REVOKED, duplicate.reason)
            assertEquals(1, fixture.parser.writes.size)

            val callbackFixture = fixture()
            callbackFixture.enqueueInput("becomes-ambiguous")
            val callbackWrite = callbackFixture.enqueueOutput("0", "callback-false")
            callbackFixture.adapter.handle(callbackFixture.authority, callbackWrite)
            var activationMarker: RelayV2TerminalParserEffectActivation? = null
            callbackFixture.sink.beforeActivate = { reservation ->
                val durable = runBlocking { callbackFixture.checkpoint() }
                assertEquals(null, durable.pendingParserEffectHandoff)
                activationMarker = durable.pendingParserEffectActivation
                assertEquals(reservation.identity.reservationId, activationMarker?.reservationId)
                assertEquals(
                    reservation.identity.batchFingerprint,
                    activationMarker?.batchFingerprint,
                )
            }

            callbackFixture.parser.writes.single().completion(false)

            val resetBatch = callbackFixture.sink.batches.single()
            assertEquals(callbackWrite.callbackToken, resetBatch.callbackToken)
            assertEquals(1, resetBatch.effects.count {
                it is RelayV2TerminalEffect.ControlsBecameAmbiguous
            })
            assertEquals(1, resetBatch.effects.count {
                it is RelayV2TerminalEffect.ResetRequired
            })
            val callbackCheckpoint = callbackFixture.checkpoint()
            assertEquals(RelayV2TerminalPhase.RESET_REQUIRED, callbackCheckpoint.phase)
            assertEquals(
                RelayV2TerminalResetReason.PARSER_FAILURE,
                callbackCheckpoint.resetReason,
            )
            assertEquals(1, callbackCheckpoint.ambiguousInputs.size)
            assertEquals(null, callbackCheckpoint.pendingParserEffectHandoff)
            assertEquals(null, callbackCheckpoint.pendingParserEffectActivation)
            assertNotNull(activationMarker)
            assertTrue(callbackFixture.fatalInvalidation.calls.isEmpty())
        }

    @Test
    fun `failed parser failure commit retains claim and duplicate offer reaches no parser`() =
        runBlocking {
            val fixture = fixture()
            val write = fixture.enqueueOutput("0", "uncertain-mutation")
            fixture.parser.afterWriteRecorded = {
                fixture.store.failNextCommitAfterBlock = true
            }
            fixture.parser.writeFailureAfterRecord = IllegalStateException("mutation uncertain")

            val unknown = fixture.adapter.handle(fixture.authority, write)
                as RelayV2TerminalRuntimeApplyResult.ParserSettlementUnknown

            assertEquals(write.callbackToken, unknown.claim.callbackToken)
            assertEquals(1, fixture.parser.writes.size)
            val durable = fixture.checkpoint()
            assertEquals(write.callbackToken, durable.parserInFlightCallbackToken)
            assertEquals(unknown.claim, durable.pendingParserDispatchClaim)
            assertEquals(RelayV2TerminalPhase.LIVE, durable.phase)
            val duplicate = fixture.adapter.handle(fixture.authority, write)
                as RelayV2TerminalRuntimeApplyResult.Rejected
            assertEquals(
                RelayV2TerminalRuntimeRejection.PARSER_ALREADY_CLAIMED,
                duplicate.reason,
            )
            assertEquals(1, fixture.parser.writes.size)
            val restarted = RelayV2DurableStateRepositoryCore(fixture.store)
            val restored = restarted.restoreTerminalUnderApplyLease(
                fixture.key,
                durable.identity,
                durable.openAttempt,
                durable.deliveryToken,
                durable.parserContinuityId,
            )
            assertEquals(
                RelayV2TerminalResetReason.STREAM_LOST,
                (restored.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
            )
        }

    @Test
    fun `parser claim precedes registration and false or unaccepted callbacks stay inert`() =
        runBlocking {
            val failedClaim = fixture()
            val blockedWrite = failedClaim.enqueueOutput("0", "claim-commit-failure")
            failedClaim.store.failNextCommitAfterBlock = true
            assertNotNull(captureFailure {
                failedClaim.adapter.handle(failedClaim.authority, blockedWrite)
            })
            assertTrue(failedClaim.parser.writes.isEmpty())

            val fixture = fixture()
            val write = fixture.enqueueOutput("0", "not-registered")
            val before = fixture.checkpoint()
            fixture.parser.writeAccepted = false

            val rejected = fixture.adapter.handle(fixture.authority, write)
                as RelayV2TerminalRuntimeApplyResult.Rejected

            assertEquals(
                RelayV2TerminalRuntimeRejection.PARSER_DISPATCH_REJECTED,
                rejected.reason,
            )
            assertEquals(before, fixture.checkpoint())
            assertEquals(1, fixture.parser.writes.size)
            fixture.parser.writes.single().completion(true)
            assertEquals(before, fixture.checkpoint())
            assertTrue(fixture.sink.batches.isEmpty())

            listOf(false, true).forEach { returnedAcceptance ->
                val early = fixture()
                val earlyWrite = early.enqueueOutput("0", "early-$returnedAcceptance")
                early.parser.writeAccepted = returnedAcceptance
                early.parser.completionInsideWrite = true

                val unknown = early.adapter.handle(early.authority, earlyWrite)
                    as RelayV2TerminalRuntimeApplyResult.ParserSettlementUnknown

                assertEquals(unknown.claim, early.checkpoint().pendingParserDispatchClaim)
                assertEquals("0", early.checkpoint().parserAppliedNextOffset)
                assertTrue(early.sink.batches.isEmpty())
            }
        }

    @Test
    fun `claim commits before transport and duplicate same delivery sends zero bytes`() = runBlocking {
        val fixture = fixture()
        val input = fixture.enqueueInput("hello")
        val resize = fixture.enqueueResize(132, 40)
        fixture.control.onInput = { assertFalse(fixture.store.inTransaction) }
        fixture.control.onResize = { assertFalse(fixture.store.inTransaction) }

        val inputResult = fixture.adapter.handle(fixture.authority, input)
            as RelayV2TerminalRuntimeApplyResult.ControlCommitted
        val resizeResult = fixture.adapter.handle(fixture.authority, resize)
            as RelayV2TerminalRuntimeApplyResult.ControlCommitted

        assertEquals("dispatch-1", inputResult.claim.attemptId)
        assertEquals("dispatch-2", resizeResult.claim.attemptId)
        assertEquals(
            RelayV2TerminalControlDisposition.SENT,
            fixture.checkpoint().pendingInputs.single().disposition,
        )
        assertEquals(
            RelayV2TerminalControlDispatchClaimPhase.LOCALLY_SENT,
            fixture.checkpoint().pendingInputs.single().dispatchClaim?.phase,
        )
        assertEquals(
            RelayV2TerminalControlDisposition.SENT,
            fixture.checkpoint().pendingResizes.single().disposition,
        )
        assertEquals(
            RelayV2TerminalControlDispatchClaimPhase.LOCALLY_SENT,
            fixture.checkpoint().pendingResizes.single().dispatchClaim?.phase,
        )
        assertEquals(1, fixture.control.inputs.size)
        assertEquals(1, fixture.control.resizes.size)

        val duplicateInput = fixture.adapter.handle(fixture.authority, input)
            as RelayV2TerminalRuntimeApplyResult.Rejected
        val duplicateResize = fixture.adapter.handle(fixture.authority, resize)
            as RelayV2TerminalRuntimeApplyResult.Rejected
        assertEquals(
            RelayV2TerminalRuntimeRejection.CONTROL_ALREADY_CLAIMED,
            duplicateInput.reason,
        )
        assertEquals(
            RelayV2TerminalRuntimeRejection.CONTROL_ALREADY_CLAIMED,
            duplicateResize.reason,
        )
        assertEquals(1, fixture.control.inputs.size)
        assertEquals(1, fixture.control.resizes.size)
    }

    @Test
    fun `claim or retry permission commit failure reaches no transport port`() = runBlocking {
        val fixture = fixture()
        val input = fixture.enqueueInput("commit-first")
        fixture.store.failNextCommitAfterBlock = true

        val failure = captureFailure {
            fixture.adapter.handle(fixture.authority, input)
        }

        assertNotNull(failure)
        assertTrue(fixture.control.inputs.isEmpty())
        assertEquals(null, fixture.checkpoint().pendingInputs.single().dispatchClaim)
        assertEquals(
            RelayV2TerminalControlDisposition.QUEUED,
            fixture.checkpoint().pendingInputs.single().disposition,
        )

        val rejectedFixture = fixture()
        val rejectedInput = rejectedFixture.enqueueInput("transport-rejected")
        rejectedFixture.control.inputAccepted = false
        val rejected = rejectedFixture.adapter.handle(
            rejectedFixture.authority,
            rejectedInput,
        ) as RelayV2TerminalRuntimeApplyResult.Rejected
        assertEquals(
            RelayV2TerminalRuntimeRejection.CONTROL_TRANSPORT_REJECTED,
            rejected.reason,
        )
        assertEquals(null, rejectedFixture.checkpoint().pendingInputs.single().dispatchClaim)
        assertEquals(
            RelayV2TerminalControlDisposition.QUEUED,
            rejectedFixture.checkpoint().pendingInputs.single().disposition,
        )

        val retryFixture = fixture()
        val sentInput = retryFixture.enqueueInput("retry-commit-first")
        retryFixture.adapter.handle(retryFixture.authority, sentInput)
        val beforeRetry = retryFixture.checkpoint()
        retryFixture.store.failNextCommitAfterBlock = true

        val retryFailure = captureFailure {
            retryFixture.repository.reduceTerminalUnderApplyLease(
                retryFixture.key,
                RelayV2TerminalAction.RetryUnackedControls(beforeRetry.deliveryToken),
            )
        }

        assertNotNull(retryFailure)
        assertEquals(1, retryFixture.control.inputs.size)
        assertEquals(
            beforeRetry.pendingInputs.single().dispatchClaim,
            retryFixture.checkpoint().pendingInputs.single().dispatchClaim,
        )
        val staleOriginal = retryFixture.adapter.handle(retryFixture.authority, sentInput)
            as RelayV2TerminalRuntimeApplyResult.Rejected
        assertEquals(
            RelayV2TerminalRuntimeRejection.CONTROL_ALREADY_CLAIMED,
            staleOriginal.reason,
        )
        assertEquals(1, retryFixture.control.inputs.size)
    }

    @Test
    fun `retry cannot clear a current input or resize transport claim`() = runBlocking {
        val inputFixture = fixture()
        val input = inputFixture.enqueueInput("input-race")
        inputFixture.adapter.handle(inputFixture.authority, input)
        val retryInput = inputFixture.repository.reduceTerminalUnderApplyLease(
            inputFixture.key,
            RelayV2TerminalAction.RetryUnackedControls(
                inputFixture.checkpoint().deliveryToken,
            ),
        ).effects.filterIsInstance<RelayV2TerminalEffect.SendInput>().single()
        inputFixture.control.onInput = {
            inputFixture.control.onInput = {}
            val racedRetry = runBlocking {
                inputFixture.repository.reduceTerminalUnderApplyLease(
                    inputFixture.key,
                    RelayV2TerminalAction.RetryUnackedControls(
                        inputFixture.checkpoint().deliveryToken,
                    ),
                )
            }
            assertTrue(racedRetry.effects.none { it is RelayV2TerminalEffect.SendInput })
            val racedGap = runBlocking {
                val durable = inputFixture.checkpoint()
                inputFixture.repository.reduceTerminalUnderApplyLease(
                    inputFixture.key,
                    RelayV2TerminalAction.InputError(
                        actionFence(durable),
                        inputSeq = "1",
                        ackedThroughInputSeq = "0",
                        error = RelayV2TerminalControlError.GAP,
                    ),
                )
            }
            assertTrue(racedGap.effects.none { it is RelayV2TerminalEffect.SendInput })
            val claimed = runBlocking { inputFixture.checkpoint() }.pendingInputs.single()
            assertEquals(RelayV2TerminalControlDisposition.SENT, claimed.disposition)
            assertEquals(
                RelayV2TerminalControlDispatchClaimPhase.CLAIMED,
                claimed.dispatchClaim?.phase,
            )
        }

        inputFixture.adapter.handle(inputFixture.authority, retryInput)

        assertEquals(2, inputFixture.control.inputs.size)
        assertEquals(
            RelayV2TerminalControlDispatchClaimPhase.LOCALLY_SENT,
            inputFixture.checkpoint().pendingInputs.single().dispatchClaim?.phase,
        )

        val resizeFixture = fixture()
        val resize = resizeFixture.enqueueResize(144, 44)
        resizeFixture.adapter.handle(resizeFixture.authority, resize)
        val retryResize = resizeFixture.repository.reduceTerminalUnderApplyLease(
            resizeFixture.key,
            RelayV2TerminalAction.RetryUnackedControls(
                resizeFixture.checkpoint().deliveryToken,
            ),
        ).effects.filterIsInstance<RelayV2TerminalEffect.SendResize>().single()
        resizeFixture.control.onResize = {
            resizeFixture.control.onResize = {}
            val racedRetry = runBlocking {
                resizeFixture.repository.reduceTerminalUnderApplyLease(
                    resizeFixture.key,
                    RelayV2TerminalAction.RetryUnackedControls(
                        resizeFixture.checkpoint().deliveryToken,
                    ),
                )
            }
            assertTrue(racedRetry.effects.none { it is RelayV2TerminalEffect.SendResize })
            val racedGap = runBlocking {
                val durable = resizeFixture.checkpoint()
                resizeFixture.repository.reduceTerminalUnderApplyLease(
                    resizeFixture.key,
                    RelayV2TerminalAction.ResizeError(
                        actionFence(durable),
                        resizeSeq = "1",
                        ackedThroughResizeSeq = "0",
                        error = RelayV2TerminalControlError.GAP,
                    ),
                )
            }
            assertTrue(racedGap.effects.none { it is RelayV2TerminalEffect.SendResize })
            val claimed = runBlocking { resizeFixture.checkpoint() }.pendingResizes.single()
            assertEquals(RelayV2TerminalControlDisposition.SENT, claimed.disposition)
            assertEquals(
                RelayV2TerminalControlDispatchClaimPhase.CLAIMED,
                claimed.dispatchClaim?.phase,
            )
        }

        resizeFixture.adapter.handle(resizeFixture.authority, retryResize)

        assertEquals(2, resizeFixture.control.resizes.size)
        assertEquals(
            RelayV2TerminalControlDispatchClaimPhase.LOCALLY_SENT,
            resizeFixture.checkpoint().pendingResizes.single().dispatchClaim?.phase,
        )
    }

    @Test
    fun `settle commit failure leaves claim and fresh delivery safely redrives`() = runBlocking {
        val fixture = fixture()
        val input = fixture.enqueueInput("settle-unknown")
        fixture.control.onInput = {
            fixture.control.onInput = {}
            fixture.store.failNextCommitAfterBlock = true
        }

        val unknown = fixture.adapter.handle(fixture.authority, input)
            as RelayV2TerminalRuntimeApplyResult.ControlSettlementUnknown
        assertEquals("dispatch-1", unknown.claim.attemptId)
        assertEquals(1, fixture.control.inputs.size)
        assertNotNull(fixture.checkpoint().pendingInputs.single().dispatchClaim)
        assertEquals(
            RelayV2TerminalControlDispatchClaimPhase.CLAIMED,
            fixture.checkpoint().pendingInputs.single().dispatchClaim?.phase,
        )
        assertEquals(
            RelayV2TerminalControlDisposition.QUEUED,
            fixture.checkpoint().pendingInputs.single().disposition,
        )

        val sameAttempt = fixture.adapter.handle(fixture.authority, input)
            as RelayV2TerminalRuntimeApplyResult.Rejected
        assertEquals(
            RelayV2TerminalRuntimeRejection.CONTROL_ALREADY_CLAIMED,
            sameAttempt.reason,
        )
        assertEquals(1, fixture.control.inputs.size)

        val explicitRetry = fixture.repository.reduceTerminalUnderApplyLease(
            fixture.key,
            RelayV2TerminalAction.RetryUnackedControls(fixture.checkpoint().deliveryToken),
        )
        assertTrue(explicitRetry.effects.isEmpty())
        assertNotNull(explicitRetry.checkpoint?.pendingInputs?.single()?.dispatchClaim)
        assertEquals(1, fixture.control.inputs.size)

        val before = fixture.checkpoint()
        val rebound = fixture.repository.reduceTerminalUnderApplyLease(
            fixture.key,
            RelayV2TerminalAction.RebindDelivery(
                before.identity,
                before.deliveryToken,
                before.deliveryToken.copy(localDispatchToken = 2),
                before.parserContinuityId,
            ),
        )
        val redrive = rebound.effects.filterIsInstance<RelayV2TerminalEffect.SendInput>().single()
        val committed = fixture.adapter.handle(fixture.authority, redrive)
        assertTrue(committed is RelayV2TerminalRuntimeApplyResult.ControlCommitted)
        assertEquals(2, fixture.control.inputs.size)
        assertEquals(listOf("1", "1"), fixture.control.inputs.map { it.effect.inputSeq })
    }

    @Test
    fun `reserve failures reset handoff and withdraw exact sink authority`() = runBlocking {
        SinkReservationFailureMode.entries.flatMap { mode ->
            if (mode == SinkReservationFailureMode.REJECT) {
                listOf(mode to true, mode to false)
            } else {
                listOf(mode to true)
            }
        }.forEach { (mode, callbackApplied) ->
            val fixture = fixture()
            val write = fixture.enqueueOutput("0", "${mode.name}-$callbackApplied")
            fixture.sink.reserveMode = when (mode) {
                SinkReservationFailureMode.REJECT,
                SinkReservationFailureMode.REJECT_AND_RESET_COMMIT_FAIL,
                -> SinkReserveMode.REJECT
                SinkReservationFailureMode.THROW -> SinkReserveMode.THROW_AFTER_RESERVE
                SinkReservationFailureMode.IDENTITY_MISMATCH ->
                    SinkReserveMode.IDENTITY_MISMATCH
            }
            if (mode == SinkReservationFailureMode.REJECT_AND_RESET_COMMIT_FAIL) {
                fixture.sink.beforeReserve = {
                    fixture.store.failNextCommitAfterBlock = true
                }
            }
            fixture.adapter.handle(fixture.authority, write)

            val callbackFailure = captureFailure {
                fixture.parser.writes.single().completion(callbackApplied)
            }

            val afterCallback = fixture.checkpoint()
            assertEquals(write.callbackToken, afterCallback.pendingParserEffectHandoff)
            assertEquals(null, afterCallback.pendingParserEffectActivation)
            if (!callbackApplied) {
                assertEquals(
                    RelayV2TerminalResetReason.PARSER_FAILURE,
                    afterCallback.pendingParserEffectHandoffResetReason,
                )
                assertEquals(RelayV2TerminalResetReason.STREAM_LOST, afterCallback.resetReason)
                val forbiddenActivation = RelayV2TerminalParserEffectActivation(
                    write.callbackToken,
                    reservationId = "reservation-after-failed-handoff",
                    batchFingerprint = "batch-after-failed-handoff",
                )
                val reservationAfterFailure = fixture.repository.reduceTerminalUnderApplyLease(
                    fixture.key,
                    RelayV2TerminalAction.ParserEffectsReserved(forbiddenActivation),
                )
                assertEquals(
                    RelayV2TerminalIgnoredReason.OUT_OF_ORDER_PARSER_CALLBACK,
                    (reservationAfterFailure.outcome as RelayV2TerminalOutcome.Ignored).reason,
                )
                assertEquals(afterCallback, reservationAfterFailure.checkpoint)
            }
            assertTrue(fixture.sink.batches.isEmpty())
            assertEquals(1, fixture.fatalInvalidation.calls.size)
            assertEquals(null, fixture.lease.currentAuthority)
            when (mode) {
                SinkReservationFailureMode.REJECT -> assertEquals(null, callbackFailure)
                SinkReservationFailureMode.THROW,
                SinkReservationFailureMode.IDENTITY_MISMATCH,
                SinkReservationFailureMode.REJECT_AND_RESET_COMMIT_FAIL,
                -> assertNotNull(callbackFailure)
            }
            if (mode == SinkReservationFailureMode.REJECT_AND_RESET_COMMIT_FAIL) {
                assertNotNull(callbackFailure)
                assertEquals(RelayV2TerminalPhase.LIVE, afterCallback.phase)
            } else {
                assertEquals(RelayV2TerminalPhase.RESET_REQUIRED, afterCallback.phase)
            }
            val partiallyReserved = fixture.sink.reservations.singleOrNull()
            if (mode in setOf(
                    SinkReservationFailureMode.THROW,
                    SinkReservationFailureMode.IDENTITY_MISMATCH,
                )
            ) {
                assertNotNull(partiallyReserved)
                assertEquals(SinkReservationState.ABORTED, partiallyReserved?.state)
                assertEquals(1, partiallyReserved?.abortCalls)
                assertEquals(0, partiallyReserved?.activationCalls)
            } else {
                assertEquals(null, partiallyReserved)
            }
            assertEquals(
                if (mode in setOf(
                        SinkReservationFailureMode.THROW,
                        SinkReservationFailureMode.IDENTITY_MISMATCH,
                    )
                ) {
                    listOf(fixture.authority to fixture.key)
                } else {
                    emptyList()
                },
                fixture.sink.teardownCalls,
            )
            val restarted = RelayV2DurableStateRepositoryCore(fixture.store)
            val restored = restarted.restoreTerminalUnderApplyLease(
                fixture.key,
                afterCallback.identity,
                afterCallback.openAttempt,
                afterCallback.deliveryToken,
                afterCallback.parserContinuityId,
            )
            assertEquals(
                RelayV2TerminalResetReason.STREAM_LOST,
                (restored.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
            )
            assertTrue(restored.effects.single() is RelayV2TerminalEffect.ResetRequired)
            val normalized = requireNotNull(restored.checkpoint)
            val secondRestore = RelayV2DurableStateRepositoryCore(fixture.store)
                .restoreTerminalUnderApplyLease(
                    fixture.key,
                    normalized.identity,
                    normalized.openAttempt,
                    normalized.deliveryToken,
                    normalized.parserContinuityId,
                )
            assertEquals(
                RelayV2TerminalResetReason.STREAM_LOST,
                (secondRestore.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
            )
            assertEquals(normalized, secondRestore.checkpoint)
        }
    }

    @Test
    fun `handoff to activation commit failure aborts inert reservation and restores closed`() =
        runBlocking {
            val fixture = fixture()
            val write = fixture.enqueueOutput("0", "handoff-to-activation-failure")
            fixture.sink.afterReserve = {
                fixture.store.failNextCommitAfterBlock = true
            }
            fixture.adapter.handle(fixture.authority, write)

            val failure = captureFailure {
                fixture.parser.writes.single().completion(true)
            }

            assertNotNull(failure)
            val reservation = fixture.sink.reservations.single()
            assertEquals(SinkReservationState.ABORTED, reservation.state)
            assertEquals(0, reservation.activationCalls)
            assertEquals(1, reservation.abortCalls)
            assertTrue(fixture.sink.batches.isEmpty())
            val afterCallback = fixture.checkpoint()
            assertEquals(RelayV2TerminalPhase.RESET_REQUIRED, afterCallback.phase)
            assertEquals(write.callbackToken, afterCallback.pendingParserEffectHandoff)
            assertEquals(null, afterCallback.pendingParserEffectActivation)
            assertEquals(1, fixture.fatalInvalidation.calls.size)

            val restarted = RelayV2DurableStateRepositoryCore(fixture.store)
            val restored = restarted.restoreTerminalUnderApplyLease(
                fixture.key,
                afterCallback.identity,
                afterCallback.openAttempt,
                afterCallback.deliveryToken,
                afterCallback.parserContinuityId,
            )
            assertEquals(
                RelayV2TerminalResetReason.STREAM_LOST,
                (restored.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
            )
        }

    @Test
    fun `activation rejection unknown and throw retain activation proof and invalidate`() =
        runBlocking {
            SinkActivationMode.entries.filterNot { it == SinkActivationMode.ACCEPT }.forEach { mode ->
                val fixture = fixture()
                val write = fixture.enqueueOutput("0", mode.name)
                fixture.sink.activationMode = mode
                fixture.adapter.handle(fixture.authority, write)

                fixture.parser.writes.single().completion(true)

                val reservation = fixture.sink.reservations.single()
                assertEquals(1, reservation.activationCalls)
                assertEquals(0, reservation.abortCalls)
                assertEquals(
                    if (mode == SinkActivationMode.REJECT) {
                        SinkReservationState.REJECTED
                    } else {
                        SinkReservationState.TORN_DOWN
                    },
                    reservation.state,
                )
                assertEquals(
                    if (mode == SinkActivationMode.REJECT) {
                        emptyList()
                    } else {
                        listOf(fixture.authority to fixture.key)
                    },
                    fixture.sink.teardownCalls,
                )
                assertTrue(fixture.sink.batches.isEmpty())
                val afterCallback = fixture.checkpoint()
                assertEquals(RelayV2TerminalPhase.RESET_REQUIRED, afterCallback.phase)
                assertEquals(null, afterCallback.pendingParserEffectHandoff)
                val activation = requireNotNull(afterCallback.pendingParserEffectActivation)
                assertEquals(write.callbackToken, activation.callbackToken)
                assertEquals(reservation.identity.reservationId, activation.reservationId)
                assertEquals(reservation.identity.batchFingerprint, activation.batchFingerprint)
                assertEquals(
                    FatalInvalidationCall(
                        fixture.authority,
                        fixture.key,
                        RelayV2TerminalFatalInvalidationReason
                            .PARSER_EFFECT_ACTIVATION_UNCERTAIN,
                    ),
                    fixture.fatalInvalidation.calls.single(),
                )
                assertEquals(null, fixture.lease.currentAuthority)

                val restarted = RelayV2DurableStateRepositoryCore(fixture.store)
                val restored = restarted.restoreTerminalUnderApplyLease(
                    fixture.key,
                    afterCallback.identity,
                    afterCallback.openAttempt,
                    afterCallback.deliveryToken,
                    afterCallback.parserContinuityId,
                )
                assertEquals(
                    RelayV2TerminalResetReason.STREAM_LOST,
                    (restored.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
                )
            }
        }

    @Test
    fun `accepted sink with failed activation clear is not replayed and restores closed`() =
        runBlocking {
            val fixture = fixture()
            val write = fixture.enqueueOutput("0", "accepted-before-clear-failure")
            fixture.sink.beforeActivate = {
                fixture.sink.beforeActivate = {}
                fixture.store.failNextCommitAfterBlock = true
            }
            fixture.adapter.handle(fixture.authority, write)

            fixture.parser.writes.single().completion(true)

            assertEquals(1, fixture.sink.batches.size)
            val reservation = fixture.sink.reservations.single()
            assertEquals(SinkReservationState.ACTIVATED, reservation.state)
            assertEquals(1, reservation.activationCalls)
            assertEquals(0, reservation.abortCalls)
            val afterCallback = fixture.checkpoint()
            assertEquals(null, afterCallback.pendingParserEffectHandoff)
            assertEquals(
                write.callbackToken,
                requireNotNull(afterCallback.pendingParserEffectActivation).callbackToken,
            )
            assertEquals(1, fixture.fatalInvalidation.calls.size)
            val duplicate = fixture.adapter.handle(fixture.authority, write)
            assertTrue(duplicate is RelayV2TerminalRuntimeApplyResult.Stale)
            assertEquals(1, fixture.parser.writes.size)
            assertEquals(1, fixture.sink.batches.size)

            val restarted = RelayV2DurableStateRepositoryCore(fixture.store)
            val restored = restarted.restoreTerminalUnderApplyLease(
                fixture.key,
                afterCallback.identity,
                afterCallback.openAttempt,
                afterCallback.deliveryToken,
                afterCallback.parserContinuityId,
            )
            assertEquals(
                RelayV2TerminalResetReason.STREAM_LOST,
                (restored.outcome as RelayV2TerminalOutcome.ResetRequired).reason,
            )
        }

    @Test
    fun `parser callback marker commit failure reaches no upper sink`() = runBlocking {
        val fixture = fixture()
        val write = fixture.enqueueOutput("0", "commit-before-sink")
        fixture.adapter.handle(fixture.authority, write)
        fixture.store.failNextCommitAfterBlock = true

        val failure = captureFailure {
            fixture.parser.writes.single().completion(true)
        }

        assertNotNull(failure)
        assertEquals(1, fixture.fatalInvalidation.calls.size)
        assertEquals(null, fixture.lease.currentAuthority)
        assertTrue(fixture.sink.reservations.isEmpty())
        assertTrue(fixture.sink.batches.isEmpty())
        val durable = fixture.checkpoint()
        assertEquals("0", durable.parserAppliedNextOffset)
        assertEquals(null, durable.pendingParserEffectHandoff)
        assertEquals(write.callbackToken, durable.pendingParserDispatchClaim?.callbackToken)
        assertEquals(write.callbackToken, durable.parserInFlightCallbackToken)
    }

    @Test
    fun `corrupt checkpoint reaches no parser control or sink port`() = runBlocking {
        val fixture = fixture()
        val write = fixture.enqueueOutput("0", "parser")
        val input = fixture.enqueueInput("control")
        fixture.store.corruptTerminal(fixture.key)

        assertNotNull(captureFailure { fixture.adapter.handle(fixture.authority, write) })
        assertNotNull(captureFailure { fixture.adapter.handle(fixture.authority, input) })

        fixture.assertNoExternalCalls()
    }

    private suspend fun fixture(): Fixture {
        val store = TerminalStore()
        val repository = RelayV2DurableStateRepositoryCore(store)
        val identity = identity()
        val key = RelayV2TerminalCheckpointKey.from(identity.target())
        val delivery = delivery()
        val attempt = RelayV2TerminalOpenAttempt("open-a", "open-fingerprint-a")
        repository.reduceTerminalUnderApplyLease(
            key,
            RelayV2TerminalAction.BeginOpenAttempt(
                delivery,
                "open-request-a",
                attempt,
                RelayV2TerminalOpenMode.NEW,
                cols = 120,
                rows = 36,
                target = identity.target(),
                parserContinuityId = PARSER_CONTINUITY,
                resume = null,
            ),
        )
        repository.reduceTerminalUnderApplyLease(
            key,
            RelayV2TerminalAction.Opened(
                identity,
                "open-request-a",
                attempt,
                delivery,
                PARSER_CONTINUITY,
                RelayV2TerminalOpenDisposition.NEW,
                cols = 120,
                rows = 36,
                replayFromOffset = "0",
                tailOffset = "0",
            ),
        )
        val authority = RelayV2RepositoryEffectAuthority(
            delivery.actorGeneration,
            identity.profileId,
            identity.profileActivationGeneration,
            identity.principalId,
            identity.clientInstanceId,
            identity.hostId,
            identity.hostEpoch,
        )
        val lease = TestApplyLease(authority)
        val parser = CapturingParser()
        val control = CapturingControl()
        val sink = CapturingSink()
        val fatalInvalidation = CapturingFatalInvalidation(lease)
        return Fixture(
            store,
            repository,
            key,
            authority,
            lease,
            parser,
            control,
            sink,
            fatalInvalidation,
            RelayV2TerminalRuntimeAdapter(
                lease,
                repository,
                parser,
                control,
                sink,
                fatalInvalidation,
            ),
        )
    }

    private data class Fixture(
        val store: TerminalStore,
        val repository: RelayV2DurableStateRepositoryCore,
        val key: RelayV2TerminalCheckpointKey,
        val authority: RelayV2RepositoryEffectAuthority,
        val lease: TestApplyLease,
        val parser: CapturingParser,
        val control: CapturingControl,
        val sink: CapturingSink,
        val fatalInvalidation: CapturingFatalInvalidation,
        val adapter: RelayV2TerminalRuntimeAdapter,
    ) {
        suspend fun checkpoint(): RelayV2TerminalCheckpoint =
            (repository.loadTerminal(key) as RelayV2TerminalStoredCheckpoint.Present).checkpoint

        suspend fun enqueueOutput(
            offset: String,
            text: String,
        ): RelayV2TerminalEffect.WriteParser {
            val checkpoint = checkpoint()
            return repository.reduceTerminalUnderApplyLease(
                key,
                RelayV2TerminalAction.Output(
                    actionFence(checkpoint),
                    offset,
                    RelayV2TerminalBytes.utf8(text),
                ),
            ).effects.filterIsInstance<RelayV2TerminalEffect.WriteParser>().single()
        }

        suspend fun enqueueInput(text: String): RelayV2TerminalEffect.SendInput {
            val checkpoint = checkpoint()
            return repository.reduceTerminalUnderApplyLease(
                key,
                RelayV2TerminalAction.EnqueueInput(
                    checkpoint.deliveryToken,
                    RelayV2TerminalBytes.utf8(text),
                ),
            ).effects.filterIsInstance<RelayV2TerminalEffect.SendInput>().single()
        }

        suspend fun enqueueResize(cols: Int, rows: Int): RelayV2TerminalEffect.SendResize {
            val checkpoint = checkpoint()
            return repository.reduceTerminalUnderApplyLease(
                key,
                RelayV2TerminalAction.EnqueueResize(checkpoint.deliveryToken, cols, rows),
            ).effects.filterIsInstance<RelayV2TerminalEffect.SendResize>().single()
        }

        fun assertNoExternalCalls() {
            assertTrue(parser.writes.isEmpty())
            assertTrue(parser.resets.isEmpty())
            assertTrue(control.inputs.isEmpty())
            assertTrue(control.resizes.isEmpty())
            assertTrue(sink.reservations.isEmpty())
            assertTrue(sink.batches.isEmpty())
            assertTrue(sink.teardownCalls.isEmpty())
            assertTrue(fatalInvalidation.calls.isEmpty())
        }
    }

    private class TestApplyLease(
        var currentAuthority: RelayV2RepositoryEffectAuthority?,
    ) : RelayV2RepositoryEffectApplyLeasePort {
        override suspend fun <T> withEffectApplyLease(
            authority: RelayV2RepositoryEffectAuthority,
            block: suspend () -> T,
        ): RelayV2EffectApplyResult<T> = if (authority == currentAuthority) {
            RelayV2EffectApplyResult.Applied(block())
        } else {
            RelayV2EffectApplyResult.Stale
        }
    }

    private class CapturingParser : RelayV2TerminalParserPort {
        data class Pending(
            val token: RelayV2TerminalParserCallbackToken,
            val bytes: ByteArray?,
            val completion: suspend (Boolean) -> Unit,
        )

        val writes = mutableListOf<Pending>()
        val resets = mutableListOf<Pending>()
        var afterWriteRecorded: () -> Unit = {}
        var writeFailureAfterRecord: RuntimeException? = null
        var writeAccepted = true
        var completionInsideWrite: Boolean? = null

        override suspend fun write(
            callbackToken: RelayV2TerminalParserCallbackToken,
            bytes: ByteArray,
            completion: suspend (Boolean) -> Unit,
        ): Boolean {
            writes += Pending(callbackToken, bytes.copyOf(), completion)
            afterWriteRecorded()
            completionInsideWrite?.let { completion(it) }
            writeFailureAfterRecord?.let { throw it }
            return writeAccepted
        }

        override suspend fun reset(
            callbackToken: RelayV2TerminalParserCallbackToken,
            completion: suspend (Boolean) -> Unit,
        ): Boolean {
            resets += Pending(callbackToken, null, completion)
            return true
        }
    }

    private data class InputCall(
        val effect: RelayV2TerminalEffect.SendInput,
        val claim: RelayV2TerminalControlDispatchClaim.Input,
    )

    private data class ResizeCall(
        val effect: RelayV2TerminalEffect.SendResize,
        val claim: RelayV2TerminalControlDispatchClaim.Resize,
    )

    private class CapturingControl : RelayV2TerminalControlTransportPort {
        val inputs = mutableListOf<InputCall>()
        val resizes = mutableListOf<ResizeCall>()
        var onInput: () -> Unit = {}
        var onResize: () -> Unit = {}
        var inputAccepted = true
        var resizeAccepted = true
        var inputFailureAfterRecord: RuntimeException? = null

        override fun sendInput(
            effect: RelayV2TerminalEffect.SendInput,
            claim: RelayV2TerminalControlDispatchClaim.Input,
        ): Boolean {
            onInput()
            inputs += InputCall(effect, claim)
            inputFailureAfterRecord?.let { throw it }
            return inputAccepted
        }

        override fun sendResize(
            effect: RelayV2TerminalEffect.SendResize,
            claim: RelayV2TerminalControlDispatchClaim.Resize,
        ): Boolean {
            onResize()
            resizes += ResizeCall(effect, claim)
            return resizeAccepted
        }
    }

    private enum class SinkReserveMode {
        RESERVE,
        REJECT,
        THROW_AFTER_RESERVE,
        IDENTITY_MISMATCH,
    }

    private enum class SinkReservationFailureMode {
        REJECT,
        THROW,
        IDENTITY_MISMATCH,
        REJECT_AND_RESET_COMMIT_FAIL,
    }

    private enum class SinkActivationMode { ACCEPT, REJECT, UNKNOWN, THROW }

    private enum class SinkReservationState {
        RESERVED,
        ACTIVATING,
        ACTIVATED,
        REJECTED,
        UNKNOWN,
        ABORTED,
        TORN_DOWN,
    }

    private class CapturingSink : RelayV2TerminalPostCommitEffectSink {
        inner class Reservation(
            val batch: RelayV2TerminalPostCommitEffectBatch,
            override val identity: RelayV2TerminalPostCommitEffectReservationIdentity,
        ) : RelayV2TerminalPostCommitEffectReservation {
            var state = SinkReservationState.RESERVED
                private set
            var activationCalls = 0
                private set
            var abortCalls = 0
                private set

            override fun activate(): RelayV2TerminalPostCommitEffectActivationReceipt {
                check(state == SinkReservationState.RESERVED)
                val index = reservations.indexOf(this)
                check(index >= 0)
                check(reservations.take(index).all { previous ->
                    previous.state !in setOf(
                        SinkReservationState.RESERVED,
                        SinkReservationState.ACTIVATING,
                    )
                }) { "FIFO reservation overtaken" }
                activationCalls += 1
                state = SinkReservationState.ACTIVATING
                beforeActivate(this)
                return when (activationMode) {
                    SinkActivationMode.ACCEPT -> try {
                        acceptOwner(this)
                        state = SinkReservationState.ACTIVATED
                        batches += batch.copy(effects = batch.effects.toList())
                        RelayV2TerminalPostCommitEffectActivationReceipt.ACCEPTED
                    } catch (failure: Exception) {
                        state = SinkReservationState.UNKNOWN
                        throw failure
                    }
                    SinkActivationMode.REJECT -> {
                        state = SinkReservationState.REJECTED
                        RelayV2TerminalPostCommitEffectActivationReceipt.REJECTED
                    }
                    SinkActivationMode.UNKNOWN -> {
                        state = SinkReservationState.UNKNOWN
                        RelayV2TerminalPostCommitEffectActivationReceipt.UNKNOWN
                    }
                    SinkActivationMode.THROW -> {
                        state = SinkReservationState.UNKNOWN
                        throw IllegalStateException("activation outcome unavailable")
                    }
                }
            }

            fun abortBeforeActivation() {
                if (state == SinkReservationState.ABORTED) return
                check(state == SinkReservationState.RESERVED) {
                    "Reservation cannot abort after activation was attempted"
                }
                abortCalls += 1
                state = SinkReservationState.ABORTED
            }

            fun teardown() {
                if (state in setOf(
                        SinkReservationState.RESERVED,
                        SinkReservationState.ACTIVATING,
                        SinkReservationState.UNKNOWN,
                    )
                ) {
                    state = SinkReservationState.TORN_DOWN
                }
            }
        }

        val reservations = mutableListOf<Reservation>()
        private val reservationsById = mutableMapOf<String, Reservation>()
        val batches = mutableListOf<RelayV2TerminalPostCommitEffectBatch>()
        val teardownCalls = mutableListOf<
            Pair<RelayV2RepositoryEffectAuthority, RelayV2TerminalCheckpointKey>
            >()
        var reserveMode = SinkReserveMode.RESERVE
        var activationMode = SinkActivationMode.ACCEPT
        var beforeReserve: (RelayV2TerminalPostCommitEffectBatch) -> Unit = {}
        var afterReserve: (Reservation) -> Unit = {}
        var beforeActivate: (Reservation) -> Unit = {}
        var acceptOwner: (Reservation) -> Unit = {}
        var teardownFailureAfterRecord: RuntimeException? = null

        override fun reserve(
            reservationId: String,
            batch: RelayV2TerminalPostCommitEffectBatch,
        ): RelayV2TerminalPostCommitEffectReservationResult {
            beforeReserve(batch)
            return when (reserveMode) {
                SinkReserveMode.RESERVE,
                SinkReserveMode.THROW_AFTER_RESERVE,
                SinkReserveMode.IDENTITY_MISMATCH,
                -> {
                    val sequence = reservations.size + 1
                    val returnedId = if (reserveMode == SinkReserveMode.IDENTITY_MISMATCH) {
                        "wrong-$reservationId"
                    } else {
                        reservationId
                    }
                    val identity = RelayV2TerminalPostCommitEffectReservationIdentity(
                        reservationId = returnedId,
                        batchFingerprint = "batch-${batch.callbackToken.operationId}-$sequence",
                    )
                    val reservation = Reservation(
                        batch.copy(effects = batch.effects.toList()),
                        identity,
                    )
                    reservations += reservation
                    reservationsById[reservationId] = reservation
                    afterReserve(reservation)
                    if (reserveMode == SinkReserveMode.THROW_AFTER_RESERVE) {
                        throw IllegalStateException("bounded sink ownership uncertain")
                    }
                    RelayV2TerminalPostCommitEffectReservationResult.Reserved(
                        identity,
                        reservation,
                    )
                }
                SinkReserveMode.REJECT ->
                    RelayV2TerminalPostCommitEffectReservationResult.Rejected
            }
        }

        override fun abort(reservationId: String) {
            reservationsById[reservationId]?.abortBeforeActivation()
        }

        override fun teardownAuthority(
            authority: RelayV2RepositoryEffectAuthority,
            key: RelayV2TerminalCheckpointKey,
        ) {
            teardownCalls += authority to key
            teardownFailureAfterRecord?.let { throw it }
            reservations.filter {
                it.batch.authority == authority && it.batch.key == key
            }.forEach(Reservation::teardown)
        }
    }

    private data class FatalInvalidationCall(
        val authority: RelayV2RepositoryEffectAuthority,
        val key: RelayV2TerminalCheckpointKey,
        val reason: RelayV2TerminalFatalInvalidationReason,
    )

    private class CapturingFatalInvalidation(
        private val lease: TestApplyLease,
    ) : RelayV2TerminalFatalInvalidationPort {
        val calls = mutableListOf<FatalInvalidationCall>()
        var beforeInvalidate: suspend (FatalInvalidationCall) -> Unit = {}

        override suspend fun invalidate(
            authority: RelayV2RepositoryEffectAuthority,
            key: RelayV2TerminalCheckpointKey,
            reason: RelayV2TerminalFatalInvalidationReason,
        ) {
            val call = FatalInvalidationCall(authority, key, reason)
            calls += call
            beforeInvalidate(call)
            if (lease.currentAuthority == authority) {
                lease.currentAuthority = null
            }
        }
    }

    private class TerminalStore : RelayV2DurableStateStore, RelayV2DurableStateTransaction {
        private var terminals = linkedMapOf<
            RelayV2TerminalCheckpointKey,
            RelayV2PersistedTerminalCheckpoint
            >()
        var transactionCount = 0
            private set
        var terminalWriteCount = 0
            private set
        var inTransaction = false
            private set
        var failNextCommitAfterBlock = false

        override suspend fun <T> transaction(block: RelayV2DurableStateTransaction.() -> T): T {
            check(!inTransaction) { "Test store does not permit transaction re-entry" }
            val before = LinkedHashMap(terminals)
            val writesBefore = terminalWriteCount
            inTransaction = true
            transactionCount += 1
            return try {
                val result = block(this)
                if (failNextCommitAfterBlock) {
                    failNextCommitAfterBlock = false
                    terminals = before
                    terminalWriteCount = writesBefore
                    throw IllegalStateException("post-block Room commit failed")
                }
                result
            } catch (failure: Throwable) {
                terminals = before
                terminalWriteCount = writesBefore
                throw failure
            } finally {
                inTransaction = false
            }
        }

        fun corruptTerminal(key: RelayV2TerminalCheckpointKey) {
            val row = requireNotNull(terminals[key])
            terminals[key] = row.copy(
                payload = RelayV2StorageJson.encode(
                    RelayV2TerminalCheckpointCodec.CODEC_VERSION,
                    mapOf("corrupt" to true),
                ),
            )
        }

        override fun outboxMeta(
            namespace: RelayV2OutboxAuthorityNamespace,
        ): RelayV2PersistedOutboxMeta? = null

        override fun outboxEntries(
            namespace: RelayV2OutboxAuthorityNamespace,
        ): List<RelayV2PersistedOutboxEntry> = emptyList()

        override fun putOutboxMeta(meta: RelayV2PersistedOutboxMeta) =
            error("Outbox is outside this test")

        override fun insertOutboxEntry(entry: RelayV2PersistedOutboxEntry) =
            error("Outbox is outside this test")

        override fun replaceOutboxEntry(
            namespace: RelayV2OutboxAuthorityNamespace,
            previousId: RelayV2OutboxEntryId,
            replacement: RelayV2PersistedOutboxEntry,
        ): Boolean = error("Outbox is outside this test")

        override fun terminalCheckpoint(
            key: RelayV2TerminalCheckpointKey,
        ): RelayV2PersistedTerminalCheckpoint? = terminals[key]

        override fun putTerminalCheckpoint(checkpoint: RelayV2PersistedTerminalCheckpoint) {
            terminalWriteCount += 1
            terminals[checkpoint.key] = checkpoint
        }
    }

    private fun identity() = RelayV2TerminalIdentity(
        profileId = "profile-v2",
        profileActivationGeneration = 7,
        principalId = "principal-v2",
        clientInstanceId = "android-install-v2",
        hostId = "host-a",
        hostEpoch = "epoch-a",
        hostInstanceId = "host-process-a",
        scopeId = "scope-a",
        sessionId = "session-a",
        streamId = "stream-a",
        generation = "terminal-generation-a",
        resumeTokenCredentialReference = "resume-reference-a",
        resumeTokenCredentialFingerprint = "resume-fingerprint-a",
    )

    private fun delivery() = RelayV2TerminalDeliveryToken(
        RelayV2EffectGeneration("profile-v2", 7, 1),
        authorityGeneration = 1,
        localDispatchToken = 1,
    )

    private suspend fun captureFailure(block: suspend () -> Unit): Throwable? = try {
        block()
        null
    } catch (failure: Throwable) {
        failure
    }

    private companion object {
        const val PARSER_CONTINUITY = "parser-a"

        fun effectFence(checkpoint: RelayV2TerminalCheckpoint) =
            RelayV2TerminalEffectFence(
                checkpoint.identity,
                checkpoint.deliveryToken,
                checkpoint.openAttempt,
            )

        fun actionFence(checkpoint: RelayV2TerminalCheckpoint) =
            RelayV2TerminalActionFence(
                checkpoint.identity.binding(),
                checkpoint.deliveryToken,
                checkpoint.openAttempt.openId,
            )
    }
}
