package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.TerminalStreamState
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalResetSuccessor
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCorrelatedError
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResetReason
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class V2TerminalOpenRetryPolicyTest {
    @Test
    fun terminalRouteRegistryBoundsTombstonesAndFencesLateOwnerCleanup() {
        val registry = RelayV2TerminalRouteRegistry<Any>(maxClosedRoutes = 3)
        repeat(10) { index ->
            val routeId = "route-$index"
            val owner = Any()
            registry.reopen(routeId)
            registry.assign(routeId, owner)
            registry.rememberClosed(routeId)
            assertTrue(registry.removeOwner(routeId, owner))
        }

        assertEquals(0, registry.ownerCount)
        assertEquals(3, registry.closedRouteCount)
        assertFalse(registry.isClosed("route-0"))
        assertTrue(registry.isClosed("route-9"))

        val retired = Any()
        val successor = Any()
        registry.reopen("reused-route")
        registry.assign("reused-route", retired)
        registry.reopen("reused-route")
        registry.assign("reused-route", successor)

        assertFalse(registry.removeOwner("reused-route", retired))
        assertSame(successor, registry.owner("reused-route"))
        assertTrue(registry.removeOwner("reused-route", successor))
        assertEquals(null, registry.owner("reused-route"))
    }

    @Test
    fun committedSuccessorClosesBeforeTransferredPredecessorButUnsettledLineageKeepsBarrier() {
        val transferred = setOf("A")
        val committed = planRelayV2TerminalCloseLineage(
            lineageNewestFirst = listOf("B", "A"),
            successorOwnsDurableAuthority = true,
            ownsRemoteClose = { it !in transferred },
        )

        assertEquals(
            listOf(
                RelayV2TerminalClosePlanStep("B", closeRemote = true),
                RelayV2TerminalClosePlanStep("A", closeRemote = false),
            ),
            committed,
        )

        val unsettled = planRelayV2TerminalCloseLineage(
            lineageNewestFirst = listOf("B", "A"),
            successorOwnsDurableAuthority = false,
            ownsRemoteClose = { true },
        )
        assertEquals(
            listOf(
                RelayV2TerminalClosePlanStep("A", closeRemote = true),
                RelayV2TerminalClosePlanStep("B", closeRemote = true),
            ),
            unsettled,
        )
    }

    @Test
    fun explicitReconnectStartsWithFreshRetryAndResetBudgets() {
        val intent = RelayV2TerminalUiOpenIntent.explicitReconnect()

        assertEquals(RelayV2TerminalUiOpenMode.REPLACE_EXACT_CURRENT, intent.mode)
        assertEquals(0, intent.openRetryAttempt)
        assertTrue(intent.resetRecoveryBudget.attemptStartedAtMillis.isEmpty())
        assertEquals(null, intent.resetRecoveryClaim)
    }

    @Test
    fun reconnectWaitsForRetirementBarrierAndAttachesExactlyOnce() = runBlocking {
        val barrierEntered = CompletableDeferred<Unit>()
        val releaseRetirement = CompletableDeferred<Unit>()
        var attachCount = 0
        val reconnect = async(start = CoroutineStart.UNDISPATCHED) {
            val current = awaitRelayV2TerminalRetirementForCurrentIntent(
                retirementBarrier = RelayV2TerminalRetirementBarrier {
                    barrierEntered.complete(Unit)
                    releaseRetirement.await()
                },
                intentStillCurrent = { true },
            )
            if (current) attachCount += 1
            current
        }

        barrierEntered.await()
        assertFalse(reconnect.isCompleted)
        assertEquals(0, attachCount)

        releaseRetirement.complete(Unit)
        assertTrue(reconnect.await())
        assertEquals(1, attachCount)
    }

    @Test
    fun staleRouteDoesNotAttachAfterRetirementBarrierCompletes() = runBlocking {
        val barrierEntered = CompletableDeferred<Unit>()
        val releaseRetirement = CompletableDeferred<Unit>()
        var routeCurrent = true
        var attachCount = 0
        val reconnect = async(start = CoroutineStart.UNDISPATCHED) {
            val current = awaitRelayV2TerminalRetirementForCurrentIntent(
                retirementBarrier = RelayV2TerminalRetirementBarrier {
                    barrierEntered.complete(Unit)
                    releaseRetirement.await()
                },
                intentStillCurrent = { routeCurrent },
            )
            if (current) attachCount += 1
            current
        }

        barrierEntered.await()
        routeCurrent = false
        releaseRetirement.complete(Unit)

        assertFalse(reconnect.await())
        assertEquals(0, attachCount)
    }

    @Test
    fun failedRetirementRemainsAFailedBarrierForSupersedingIntents() = runBlocking {
        val releaseA = CompletableDeferred<Unit>()
        val bLineageSettled = CompletableDeferred<Unit>()
        val failure = IllegalStateException("old owner still attached")
        var attachCount = 0

        val bIntent = async(start = CoroutineStart.UNDISPATCHED) {
            runCatching {
                val current = awaitRelayV2TerminalRetirementForCurrentIntent(
                    retirementBarrier = RelayV2TerminalRetirementBarrier { releaseA.await() },
                    retirementSettled = bLineageSettled,
                    intentStillCurrent = { true },
                )
                if (current) attachCount += 1
            }.exceptionOrNull()
        }
        val cIntent = async(start = CoroutineStart.UNDISPATCHED) {
            runCatching {
                bLineageSettled.await()
                attachCount += 1
            }.exceptionOrNull()
        }

        assertFalse(bIntent.isCompleted)
        assertFalse(cIntent.isCompleted)
        releaseA.completeExceptionally(failure)

        val bObserved = bIntent.await()
        val cObserved = cIntent.await()
        assertTrue(bObserved is IllegalStateException)
        assertEquals(failure.message, bObserved?.message)
        assertTrue(cObserved is IllegalStateException)
        assertEquals(failure.message, cObserved?.message)
        assertEquals(0, attachCount)
    }

    @Test
    fun detachedOpenRecoveryInstallsAndWithdrawsTheExactRetiringSentinel() {
        val issued = Any()
        val claim = Any()
        val claimed = requireNotNull(
            claimDetachedRelayV2TerminalRecoverySlot(
                current = RelayV2TerminalRecoverySlot<Any>(owner = null, claim = null),
                issued = issued,
                claim = claim,
            ),
        )

        assertSame(issued, claimed.owner)
        assertSame(claim, claimed.claim)
        val withdrawn = requireNotNull(
            withdrawRetiredRelayV2TerminalRecoverySlot(claimed, issued, claim),
        )
        assertEquals(null, withdrawn.owner)
        assertSame(claim, withdrawn.claim)

        val replacement = Any()
        assertEquals(
            null,
            withdrawRetiredRelayV2TerminalRecoverySlot(
                RelayV2TerminalRecoverySlot(owner = replacement, claim = null),
                issued,
                claim,
            ),
        )
    }

    @Test
    fun delayedOpenRetryRequiresTheExactUiRouteProjection() {
        val rejectedRoute = TerminalStreamState(
            sessionId = "session-a",
            status = ConnectionStatus.RECOVERING,
            resetReason = "retrying",
        )

        assertTrue(relayV2TerminalUiRouteIntentIsCurrent(rejectedRoute, rejectedRoute))
        assertFalse(
            relayV2TerminalUiRouteIntentIsCurrent(
                rejectedRoute,
                rejectedRoute.copy(),
            ),
        )
        assertFalse(
            relayV2TerminalUiRouteIntentIsCurrent(
                rejectedRoute,
                TerminalStreamState(
                    sessionId = "session-b",
                    status = ConnectionStatus.CONNECTING,
                ),
            ),
        )
    }

    @Test
    fun staleRetirementFailureCannotOverwriteANewerPendingRoute() {
        val oldRoute = relayV2TerminalOpeningRouteIntent("session-a")
        val newerRoute = relayV2TerminalOpeningRouteIntent("session-b")
        val newerState = V2UiState(
            terminal = newerRoute,
            actionError = null,
        )

        val projected = projectRelayV2TerminalFailureIfCurrent(
            expectedRouteToken = oldRoute,
            currentState = newerState,
            sessionStableId = "session-a",
            resetReason = "terminal_retirement_failed",
            message = "old retirement failed",
        )

        assertEquals(null, projected)
        assertSame(newerRoute, newerState.terminal)
        assertEquals(null, newerState.actionError)
    }

    @Test
    fun exactRetirementFailureReturnsTheNextTokenForTheRestoredSentinel() {
        val openingRoute = relayV2TerminalOpeningRouteIntent("session-a")
        val projected = requireNotNull(
            projectRelayV2TerminalFailureIfCurrent(
                expectedRouteToken = openingRoute,
                currentState = V2UiState(terminal = openingRoute),
                sessionStableId = "session-a",
                resetReason = "terminal_retirement_failed",
                message = "retirement failed",
            ),
        )

        assertSame(projected.routeToken, projected.state.terminal)
        assertEquals(ConnectionStatus.OFFLINE, projected.routeToken.status)
        assertEquals("terminal_retirement_failed", projected.routeToken.resetReason)
        assertEquals("retirement failed", projected.state.actionError)

        // Once a future route replaces this exact projection, the old restored sentinel can no
        // longer publish another failure over it.
        assertEquals(
            null,
            projectRelayV2TerminalFailureIfCurrent(
                expectedRouteToken = projected.routeToken,
                currentState = projected.state.copy(
                    terminal = relayV2TerminalOpeningRouteIntent("session-b"),
                ),
                sessionStableId = "session-a",
                resetReason = "terminal_view_detach_failed",
                message = "late renderer failure",
            ),
        )
    }

    @Test
    fun admittedRetrySwitchesFromOldCasTokenToItsPublishedOpeningToken() {
        val rejectedRoute = TerminalStreamState(
            sessionId = "session-a",
            status = ConnectionStatus.RECOVERING,
        )
        var currentRoute = rejectedRoute

        // The delayed retry first compares-and-swaps the exact rejected projection.
        assertTrue(relayV2TerminalUiRouteIntentIsCurrent(rejectedRoute, currentRoute))
        val openingRoute = relayV2TerminalOpeningRouteIntent("session-a")
        currentRoute = openingRoute

        // Admission intentionally invalidates the old token; the opener must now own the exact
        // CONNECTING projection it published, including while a predecessor barrier drains.
        assertFalse(relayV2TerminalUiRouteIntentIsCurrent(rejectedRoute, currentRoute))
        assertTrue(relayV2TerminalUiRouteIntentIsCurrent(openingRoute, currentRoute))
        assertEquals(ConnectionStatus.CONNECTING, currentRoute.status)
    }

    @Test
    fun routeChangeDuringSuspendingAttachDetachesWithoutOpening() = runBlocking {
        val attachEntered = CompletableDeferred<Unit>()
        val releaseAttach = CompletableDeferred<Unit>()
        val openingRoute = relayV2TerminalOpeningRouteIntent("session-a")
        var currentRoute = openingRoute
        var openCount = 0
        var detachCount = 0

        val opener = async(start = CoroutineStart.UNDISPATCHED) {
            attachEntered.complete(Unit)
            releaseAttach.await()
            val stillCurrent = relayV2TerminalOpeningIntentIsCurrent(
                attachmentCurrent = true,
                compositionCurrent = true,
                routeCurrent = true,
                rendererCurrent = true,
                openingRouteCurrent =
                    relayV2TerminalUiRouteIntentIsCurrent(openingRoute, currentRoute),
                detachRequested = false,
            )
            if (stillCurrent) openCount += 1 else detachCount += 1
        }

        attachEntered.await()
        currentRoute = TerminalStreamState(
            sessionId = "session-b",
            status = ConnectionStatus.CONNECTING,
        )
        releaseAttach.complete(Unit)
        opener.await()

        assertEquals(0, openCount)
        assertEquals(1, detachCount)
    }

    @Test
    fun routeChangeDuringSuspendingOpenDetachesAndFencesOpenedProjection() = runBlocking {
        val openEntered = CompletableDeferred<Unit>()
        val releaseOpen = CompletableDeferred<Unit>()
        val openingRoute = relayV2TerminalOpeningRouteIntent("session-a")
        var issuedRouteToken = openingRoute
        var currentRoute = openingRoute
        var detachCount = 0
        var openedProjectionCount = 0

        val opener = async(start = CoroutineStart.UNDISPATCHED) {
            openEntered.complete(Unit)
            releaseOpen.await()
            val stillCurrent = relayV2TerminalOpeningIntentIsCurrent(
                attachmentCurrent = true,
                compositionCurrent = true,
                routeCurrent = true,
                rendererCurrent = true,
                openingRouteCurrent =
                    relayV2TerminalUiRouteIntentIsCurrent(issuedRouteToken, currentRoute),
                detachRequested = false,
            )
            if (!stillCurrent) detachCount += 1

            // Models observer.opened's issued-route-token CAS after the old open returns.
            if (relayV2TerminalUiRouteIntentIsCurrent(issuedRouteToken, currentRoute)) {
                issuedRouteToken = TerminalStreamState(
                    streamId = "old-stream",
                    sessionId = "session-a",
                    status = ConnectionStatus.ONLINE,
                )
                currentRoute = issuedRouteToken
                openedProjectionCount += 1
            }
        }

        openEntered.await()
        currentRoute = TerminalStreamState(
            sessionId = "session-b",
            status = ConnectionStatus.CONNECTING,
        )
        releaseOpen.complete(Unit)
        opener.await()

        assertEquals(1, detachCount)
        assertEquals(0, openedProjectionCount)
        assertEquals("session-b", currentRoute.sessionId)
    }

    @Test
    fun failedDetachRemainsABarrierForTheNextReconnect() = runBlocking {
        val lifecycle = RelayV2TerminalUiAttachmentLifecycle<Any>()
        val oldAttachment = Any()
        assertSame(
            RelayV2TerminalAttachmentInstall.Current,
            lifecycle.install(oldAttachment),
        )
        assertTrue(lifecycle.requestDetach() is RelayV2TerminalAttachmentDetach.Detach)
        val failure = IllegalStateException("detach failed")
        lifecycle.failDetach(oldAttachment, failure)
        var attachCount = 0

        val observed = runCatching {
            val current = awaitRelayV2TerminalRetirementForCurrentIntent(
                retirementBarrier = RelayV2TerminalRetirementBarrier {
                    lifecycle.awaitDetached()
                },
                intentStillCurrent = { true },
            )
            if (current) attachCount += 1
        }.exceptionOrNull()

        assertTrue(observed is IllegalStateException)
        assertEquals(failure.message, observed?.message)
        assertEquals(0, attachCount)
        assertSame(RelayV2TerminalAttachmentDetach.Await, lifecycle.requestDetach())
    }

    @Test
    fun closeDispositionRejectsLateDetachedCallbackButDetachedRecoveryRemainsLegal() {
        val lifecycle = RelayV2TerminalUiAttachmentLifecycle<Any>()
        val attachment = Any()
        assertSame(RelayV2TerminalAttachmentInstall.Current, lifecycle.install(attachment))
        var disposition = RelayV2DetachedTerminalCallbackDisposition.RECOVER
        disposition = RelayV2DetachedTerminalCallbackDisposition.CLOSED
        assertTrue(lifecycle.requestDetach() is RelayV2TerminalAttachmentDetach.Detach)
        lifecycle.completeDetach(attachment)
        var slot = RelayV2TerminalRecoverySlot<Any>(owner = null, claim = null)

        if (relayV2DetachedTerminalCallbackMayRecover(disposition)) {
            slot = requireNotNull(
                claimDetachedRelayV2TerminalRecoverySlot(slot, Any(), Any()),
            )
        }

        assertTrue(lifecycle.detachRequested())
        assertFalse(relayV2DetachedTerminalCallbackMayRecover(disposition))
        assertEquals(null, slot.owner)
        assertEquals(null, slot.claim)

        // Renderer/reset retirement also leaves the local lifecycle Detached before the
        // production actor's correlated response arrives. It remains recoverable unless an
        // explicit close/disposal admission installed the tombstone above.
        assertTrue(
            relayV2DetachedTerminalCallbackMayRecover(
                RelayV2DetachedTerminalCallbackDisposition.RECOVER,
            ),
        )
    }

    @Test
    fun losingRendererRetirementCanPauseTheExactResetRecoveryRoute() {
        val resetClaim = Any()
        val recoveringRoute = TerminalStreamState(
            sessionId = "session-a",
            status = ConnectionStatus.RECOVERING,
        )

        assertTrue(
            relayV2TerminalRendererPauseIntentIsCurrent(
                terminalOwnerAbsent = true,
                compositionCurrent = true,
                currentRecoveryClaim = resetClaim,
                retirementRecoveryClaim = resetClaim,
                routeCurrent = relayV2TerminalUiRouteIntentIsCurrent(
                    recoveringRoute,
                    recoveringRoute,
                ),
            ),
        )
        assertFalse(
            relayV2TerminalRendererPauseIntentIsCurrent(
                terminalOwnerAbsent = true,
                compositionCurrent = true,
                currentRecoveryClaim = resetClaim,
                retirementRecoveryClaim = Any(),
                routeCurrent = true,
            ),
        )
        assertFalse(
            relayV2TerminalRendererPauseIntentIsCurrent(
                terminalOwnerAbsent = true,
                compositionCurrent = true,
                currentRecoveryClaim = resetClaim,
                retirementRecoveryClaim = resetClaim,
                routeCurrent = relayV2TerminalUiRouteIntentIsCurrent(
                    recoveringRoute,
                    recoveringRoute.copy(),
                ),
            ),
        )
    }

    @Test
    fun explicitReconnectReplacesAnExactRetainedAttachment() {
        assertTrue(
            shouldRetainExactCurrentRelayV2Terminal(
                mode = RelayV2TerminalUiOpenMode.RETAIN_EXACT_CURRENT,
                previousRetainsRoute = true,
                previousRendererCurrent = true,
                requestedRendererCurrent = true,
            ),
        )
        assertFalse(
            shouldRetainExactCurrentRelayV2Terminal(
                mode = RelayV2TerminalUiOpenMode.REPLACE_EXACT_CURRENT,
                previousRetainsRoute = true,
                previousRendererCurrent = true,
                requestedRendererCurrent = true,
            ),
        )
    }

    @Test
    fun exactCurrentTerminalResetOwnsAtMostThreeAutomaticAttemptsInOneWindow() {
        val first = requireNotNull(admitReset(RelayV2TerminalResetRecoveryBudget(), 100L))
        val second = requireNotNull(admitReset(first.budget, 200L))
        val third = requireNotNull(admitReset(second.budget, 300L))

        assertEquals(1, first.nextAttempt)
        assertEquals(2, second.nextAttempt)
        assertEquals(3, third.nextAttempt)
        assertEquals(250L, relayV2TerminalResetRecoveryDelayMillis(1))
        assertEquals(500L, relayV2TerminalResetRecoveryDelayMillis(2))
        assertEquals(1_000L, relayV2TerminalResetRecoveryDelayMillis(3))
        assertEquals(
            null,
            admitRelayV2TerminalResetRecovery(
                exactCurrentOwner = true,
                reason = RelayV2TerminalResetReason.STREAM_LOST,
                budget = third.budget,
                nowMillis = 400L,
            ),
        )
    }

    @Test
    fun stableWindowExpiryStartsAnIndependentFailureAtAttemptOne() {
        val first = requireNotNull(admitReset(RelayV2TerminalResetRecoveryBudget(), 100L))
        val second = requireNotNull(admitReset(first.budget, 200L))
        val third = requireNotNull(admitReset(second.budget, 300L))

        val afterStableWindow = requireNotNull(
            admitReset(
                third.budget,
                300L + RELAY_V2_TERMINAL_RESET_RECOVERY_WINDOW_MS,
            ),
        )

        assertEquals(1, afterStableWindow.nextAttempt)
        assertEquals(
            listOf(300L + RELAY_V2_TERMINAL_RESET_RECOVERY_WINDOW_MS),
            afterStableWindow.budget.attemptStartedAtMillis,
        )
        assertEquals(250L, relayV2TerminalResetRecoveryDelayMillis(afterStableWindow.nextAttempt))
    }

    @Test
    fun slidingWindowRetainsOnlyRecentAttemptsInsteadOfClearingOnOpened() {
        val first = requireNotNull(admitReset(RelayV2TerminalResetRecoveryBudget(), 0L))
        val second = requireNotNull(
            admitReset(first.budget, RELAY_V2_TERMINAL_RESET_RECOVERY_WINDOW_MS - 100L),
        )

        // The first attempt has expired, but the successful replacement's recent attempt remains.
        // A mere terminal.opened callback therefore cannot reset a replay-failure loop.
        val next = requireNotNull(
            admitReset(second.budget, RELAY_V2_TERMINAL_RESET_RECOVERY_WINDOW_MS),
        )

        assertEquals(2, next.nextAttempt)
        assertEquals(
            listOf(
                RELAY_V2_TERMINAL_RESET_RECOVERY_WINDOW_MS - 100L,
                RELAY_V2_TERMINAL_RESET_RECOVERY_WINDOW_MS,
            ),
            next.budget.attemptStartedAtMillis,
        )
    }

    @Test
    fun removedRouteOwnerAndCorruptCheckpointCannotLaunchAutomaticReplacement() {
        assertEquals(
            null,
            admitRelayV2TerminalResetRecovery(
                // Normal route disposal removes relayV2Terminal before its detach callback.
                exactCurrentOwner = false,
                reason = RelayV2TerminalResetReason.STREAM_LOST,
                budget = RelayV2TerminalResetRecoveryBudget(),
                nowMillis = 1L,
            ),
        )
        assertEquals(
            null,
            admitRelayV2TerminalResetRecovery(
                exactCurrentOwner = true,
                reason = RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                budget = RelayV2TerminalResetRecoveryBudget(),
                nowMillis = 1L,
            ),
        )
        assertEquals(
            null,
            admitRelayV2TerminalResetRecovery(
                exactCurrentOwner = true,
                reason = RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
                budget = RelayV2TerminalResetRecoveryBudget(),
                nowMillis = 1L,
            ),
        )
    }

    @Test
    fun operationalTerminalResetReasonsRemainEligibleForBoundedReplacement() {
        val recoverable = setOf(
            RelayV2TerminalResetReason.STREAM_LOST,
            RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST,
            RelayV2TerminalResetReason.PARSER_FAILURE,
            RelayV2TerminalResetReason.GENERATION_STALE,
            RelayV2TerminalResetReason.OFFSET_EXPIRED,
            RelayV2TerminalResetReason.SLOW_CONSUMER,
            RelayV2TerminalResetReason.HOST_BUFFER_PRESSURE,
        )

        recoverable.forEach { reason ->
            assertEquals(
                1,
                requireNotNull(
                    admitRelayV2TerminalResetRecovery(
                        exactCurrentOwner = true,
                        reason = reason,
                        budget = RelayV2TerminalResetRecoveryBudget(),
                        nowMillis = 1L,
                    ),
                ).nextAttempt,
            )
        }
    }

    @Test
    fun busyOwnerPressureStopsAtTheBoundedRetryBudget() {
        val busy = RelayV2TerminalCorrelatedError(
            code = "BUSY",
            message = "Terminal input is temporarily owned by another client",
            retryable = true,
        )

        assertTrue(shouldRetryRelayV2TerminalOpen(busy, attempt = 4))
        assertFalse(shouldRetryRelayV2TerminalOpen(busy, attempt = 5))
        assertFalse(shouldRetryRelayV2TerminalOpen(busy, attempt = 5_000))
    }

    @Test
    fun ordinaryRetryableFailuresRemainBoundedAndNonRetryableBusyStaysClosed() {
        val ordinary = RelayV2TerminalCorrelatedError(
            code = "INTERNAL",
            message = "temporary failure",
            retryable = true,
        )
        val terminalBusy = RelayV2TerminalCorrelatedError(
            code = "BUSY",
            message = "busy",
            retryable = false,
        )

        assertTrue(shouldRetryRelayV2TerminalOpen(ordinary, attempt = 4))
        assertFalse(shouldRetryRelayV2TerminalOpen(ordinary, attempt = 5))
        assertFalse(shouldRetryRelayV2TerminalOpen(terminalBusy, attempt = 0))
    }

    @Test
    fun terminalStreamConflictIsExposedOfflineForExplicitReconnectWithoutAutomaticRetry() {
        val conflict = RelayV2TerminalCorrelatedError(
            code = "TERMINAL_STREAM_CONFLICT",
            message = "Relay v2 terminal stream conflicts with retained state",
            // The code remains definitive even if an older peer marks it retryable.
            retryable = true,
        )

        val rejection = resolveRelayV2TerminalOpenRejection(conflict, attempt = 0)

        assertFalse(rejection.retry)
        assertEquals(ConnectionStatus.OFFLINE, rejection.status)
        assertTrue(rejection.message.contains("retained state"))
        assertTrue(rejection.message.contains("Reconnect"))
    }

    @Test
    fun retryableOpenRejectionRemainsRecoveringUntilItsBoundedRetry() {
        val retryable = RelayV2TerminalCorrelatedError(
            code = "INTERNAL",
            message = "temporary relay failure",
            retryable = true,
        )

        val retry = resolveRelayV2TerminalOpenRejection(retryable, attempt = 4)
        assertTrue(retry.retry)
        assertEquals(ConnectionStatus.RECOVERING, retry.status)
        assertEquals("temporary relay failure", retry.message)

        val exhausted = resolveRelayV2TerminalOpenRejection(retryable, attempt = 5)
        assertFalse(exhausted.retry)
        assertEquals(ConnectionStatus.OFFLINE, exhausted.status)
        assertEquals("temporary relay failure", exhausted.message)
    }

    @Test
    fun timedOutExactOpeningBecomesRecoverableWithoutOverwritingNewerState() {
        val connecting = V2UiState(
            terminal = TerminalStreamState(
                sessionId = "session-a",
                status = ConnectionStatus.CONNECTING,
            ),
        )

        val recovered = recoverTimedOutTerminalOpen(connecting, "session-a")
        assertEquals(ConnectionStatus.RECOVERING, recovered.terminal.status)
        assertEquals("terminal_open_timeout", recovered.terminal.resetReason)
        assertTrue(recovered.actionError.orEmpty().contains("Reconnect"))

        val online = connecting.copy(
            terminal = connecting.terminal.copy(status = ConnectionStatus.ONLINE),
        )
        assertSame(online, recoverTimedOutTerminalOpen(online, "session-a"))
        assertSame(connecting, recoverTimedOutTerminalOpen(connecting, "session-b"))
    }

    @Test
    fun compositionOwnedResetSuccessorRetainsOnlyItsExactCurrentUiOwner() {
        val online = V2UiState(
            terminal = TerminalStreamState(
                streamId = "stream-a",
                sessionId = "session-a",
                status = ConnectionStatus.ONLINE,
            ),
            actionError = "older error",
        )

        val retained = requireNotNull(
            projectRelayV2RetainedResetSuccessor(
                state = online,
                exactCurrentOwner = true,
                expectedSessionId = "session-a",
                reason = RelayV2TerminalResetReason.STREAM_LOST,
            ),
        )
        assertEquals(ConnectionStatus.RECOVERING, retained.terminal.status)
        assertEquals("session-a", retained.terminal.sessionId)
        assertEquals("stream_lost", retained.terminal.resetReason)
        assertEquals(null, retained.actionError)

        assertEquals(
            null,
            projectRelayV2RetainedResetSuccessor(
                state = online,
                exactCurrentOwner = false,
                expectedSessionId = "session-a",
                reason = RelayV2TerminalResetReason.STREAM_LOST,
            ),
        )
        assertEquals(
            null,
            projectRelayV2RetainedResetSuccessor(
                state = online,
                exactCurrentOwner = true,
                expectedSessionId = "session-b",
                reason = RelayV2TerminalResetReason.STREAM_LOST,
            ),
        )
        assertEquals(ConnectionStatus.ONLINE, online.terminal.status)

        assertTrue(
            isExactRelayV2RetainedResetSuccessorOwner(
                attachmentCurrent = true,
                compositionCurrent = true,
                routeCurrent = true,
            ),
        )
        assertFalse(
            isExactRelayV2RetainedResetSuccessorOwner(
                attachmentCurrent = false,
                compositionCurrent = true,
                routeCurrent = true,
            ),
        )
        assertFalse(
            isExactRelayV2RetainedResetSuccessorOwner(
                attachmentCurrent = true,
                compositionCurrent = false,
                routeCurrent = true,
            ),
        )
        assertFalse(
            isExactRelayV2RetainedResetSuccessorOwner(
                attachmentCurrent = true,
                compositionCurrent = true,
                routeCurrent = false,
            ),
        )
    }

    @Test
    fun resetSuccessorRebindsWatchdogToItsExactRequestAndOpenId() {
        val watchdog = RelayV2TerminalOpenWatchdog()
        val initial = watchdog.currentTicket()
        val first = watchdog.bindSuccessor(
            RelayV2TerminalResetSuccessor(
                requestId = "reset-request-1",
                openId = "reset-open-1",
            ),
        )

        assertTrue(initial.settled.isCompleted)
        assertFalse(watchdog.owns(initial))
        assertTrue(watchdog.owns(first))
        assertEquals("reset-request-1", first.requestId)
        assertEquals("reset-open-1", first.openId)

        val second = watchdog.bindSuccessor(
            RelayV2TerminalResetSuccessor(
                requestId = "reset-request-2",
                openId = "reset-open-2",
            ),
        )
        assertTrue(first.settled.isCompleted)
        assertFalse(watchdog.owns(first))
        assertTrue(watchdog.owns(second))
        assertEquals("reset-request-2", second.requestId)
        assertEquals("reset-open-2", second.openId)

        val timedOut = recoverTimedOutTerminalOpen(
            V2UiState(
                terminal = TerminalStreamState(
                    sessionId = "session-a",
                    status = ConnectionStatus.RECOVERING,
                    resetReason = "stream_lost",
                ),
            ),
            "session-a",
        )
        assertEquals("terminal_open_timeout", timedOut.terminal.resetReason)
        assertTrue(timedOut.actionError.orEmpty().contains("Reconnect"))
    }

    private fun admitReset(
        budget: RelayV2TerminalResetRecoveryBudget,
        nowMillis: Long,
    ): RelayV2TerminalResetRecoveryAdmission? = admitRelayV2TerminalResetRecovery(
        exactCurrentOwner = true,
        reason = RelayV2TerminalResetReason.STREAM_LOST,
        budget = budget,
        nowMillis = nowMillis,
    )
}
