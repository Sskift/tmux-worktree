package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2ContractFixtures
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2FrameMetadata
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2WebSocketChannel
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialBlob
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialCasExpectation
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialCasResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialReference
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialStore
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2ConnectionActorTest {
    private val codec = RelayV2Codec()
    private val fixtures = RelayV2ContractFixtures()

    @Test
    fun `five hello outcomes produce query resync or continuity rejection effects`() = runBlocking {
        val scenarios = listOf(
            HelloScenario(
                name = "fresh",
                resume = null,
                responseFixture = "host-welcome-snapshot-required",
                expectedOutcome = RelayV2HelloOutcome.FRESH,
                expectedPhase = RelayV2ConnectionPhase.RESYNCING,
            ),
            HelloScenario(
                name = "matched",
                resume = RelayV2ResumeCursor(HOST_EPOCH, "91"),
                responseFixture = "host-welcome-caught-up",
                expectedOutcome = RelayV2HelloOutcome.MATCHED,
                expectedPhase = RelayV2ConnectionPhase.QUERYING,
            ),
            HelloScenario(
                name = "behind",
                resume = RelayV2ResumeCursor(HOST_EPOCH, "90"),
                responseFixture = "host-welcome-cursor-behind",
                expectedOutcome = RelayV2HelloOutcome.CURSOR_BEHIND,
                expectedPhase = RelayV2ConnectionPhase.RESYNCING,
            ),
            HelloScenario(
                name = "host epoch changed",
                resume = RelayV2ResumeCursor("previous-authority-epoch", "91"),
                responseFixture = "host-welcome-host-epoch-changed",
                expectedOutcome = RelayV2HelloOutcome.HOST_EPOCH_CHANGED,
                expectedPhase = RelayV2ConnectionPhase.RESYNCING,
            ),
            HelloScenario(
                name = "ahead",
                resume = RelayV2ResumeCursor(HOST_EPOCH, "92"),
                responseFixture = "client-hello-cursor-ahead-error",
                expectedOutcome = RelayV2HelloOutcome.EVENT_CURSOR_AHEAD,
                expectedPhase = RelayV2ConnectionPhase.CONTINUITY_REJECTED,
            ),
        )

        scenarios.forEach { scenario ->
            val harness = Harness()
            try {
                val hello = harness.connectThroughRelayWelcome(scenario.resume)
                assertEquals(
                    scenario.name,
                    listOf(RelayV2Profile.RELAY_V2_SUBPROTOCOL),
                    harness.factory.requests.single().offeredSubprotocols,
                )
                assertEquals(
                    scenario.name,
                    RelayV2ConnectionActor.REQUIRED_CAPABILITIES,
                    hello.payload().stringList("capabilities"),
                )
                assertEquals(
                    scenario.name,
                    RelayV2ConnectionActor.REQUIRED_CAPABILITIES,
                    hello.payload().stringList("requiredCapabilities"),
                )
                assertEquals(
                    scenario.name,
                    scenario.resume?.let {
                        mapOf("hostEpoch" to it.hostEpoch, "lastEventSeq" to it.lastEventSeq)
                    },
                    hello.payload()["resume"],
                )
                UUID.fromString(hello.stringValue("requestId"))

                harness.transport().sendFixture(
                    scenario.responseFixture,
                    requestId = hello.stringValue("requestId"),
                )
                val effect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                assertEquals(
                    scenario.name,
                    scenario.expectedOutcome,
                    effect.helloOutcome(),
                )
                assertEquals(
                    scenario.name,
                    scenario.expectedPhase,
                    harness.actor.awaitPhase(scenario.expectedPhase).phase,
                )
                when (effect) {
                    is RelayV2RuntimeEffect.QueryPendingCommands -> {
                        assertEquals("91", effect.context.eventSeq)
                        assertNegotiatedHello(effect.context)
                        assertTrue(harness.transport().closeCodes.isEmpty())
                    }
                    is RelayV2RuntimeEffect.BeginStateResync -> {
                        assertEquals(
                            scenario.expectedOutcome == RelayV2HelloOutcome.HOST_EPOCH_CHANGED,
                            effect.discardPriorResourceLineage,
                        )
                        assertTrue(effect.queryPendingCommandsAfterResync)
                        assertNegotiatedHello(effect.context)
                        assertTrue(harness.transport().closeCodes.isEmpty())
                    }
                    is RelayV2RuntimeEffect.RejectContinuity -> {
                        assertEquals("92", effect.clientLastEventSeq)
                        assertEquals("91", effect.hostEventSeq)
                        assertEquals(4400, harness.transport().closeCodes.single())
                    }
                    else -> error("Unexpected hello effect for ${scenario.name}: $effect")
                }
            } finally {
                harness.close()
            }
        }
    }

    @Test
    fun `current continuity rejection can apply while its fenced generation cannot`() = runBlocking {
        val harness = Harness()
        try {
            val hello = harness.connectThroughRelayWelcome(
                RelayV2ResumeCursor(HOST_EPOCH, "92"),
            )
            harness.transport().sendFixture(
                "client-hello-cursor-ahead-error",
                requestId = hello.stringValue("requestId"),
            )
            val rejection = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.RejectContinuity
            assertEquals(
                RelayV2ConnectionPhase.CONTINUITY_REJECTED,
                harness.actor.awaitPhase(RelayV2ConnectionPhase.CONTINUITY_REJECTED).phase,
            )
            assertTrue(harness.actor.state.value.matchesGeneration(rejection.generation))

            val applied = CopyOnWriteArrayList<String>()
            val current = harness.actor.withEffectApplyLease(rejection) {
                applied += "cursor-ahead-cleanup"
            }
            assertTrue(current is RelayV2EffectApplyResult.Applied)
            assertEquals(listOf("cursor-ahead-cleanup"), applied)

            harness.actor.disconnectAndDrain(harness.profile.identity, "reject-fence")
            withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
            assertFalse(harness.actor.state.value.matchesGeneration(rejection.generation))
            val stale = harness.actor.withEffectApplyLease(rejection) {
                applied += "stale-cleanup"
            }
            assertTrue(stale is RelayV2EffectApplyResult.Stale)
            assertEquals(listOf("cursor-ahead-cleanup"), applied)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `replaced transport callbacks are fenced by connection generation`() = runBlocking {
        val harness = Harness()
        try {
            assertTrue(harness.actor.connect(harness.profile, resume = null))
            val first = harness.awaitTransport(0)
            assertTrue(harness.actor.connect(harness.profile, resume = null))
            val second = harness.awaitTransport(1)

            first.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            first.sendFixture("relay-welcome")

            second.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            second.sendFixture("relay-welcome")
            val hello = second.awaitSentFrame()
            second.sendFixture(
                "host-welcome-snapshot-required",
                requestId = hello.stringValue("requestId"),
            )

            val effect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
            assertTrue(effect is RelayV2RuntimeEffect.BeginStateResync)
            assertEquals(
                RelayV2ConnectionPhase.RESYNCING,
                harness.actor.awaitPhase(RelayV2ConnectionPhase.RESYNCING).phase,
            )
            assertTrue(first.closeCodes.contains(1000))
        } finally {
            harness.close()
        }
    }

    @Test
    fun `reconnect and disconnect receipt wait for the same transport termination fence`() =
        runBlocking {
            val harness = Harness()
            try {
                assertTrue(harness.actor.connect(harness.profile, null))
                val first = harness.awaitTransport(0)
                first.completeTerminationOnClose = false

                assertTrue(harness.actor.connect(harness.profile, null))
                delay(25)
                assertEquals(1, harness.factory.transports.size)
                first.completeTermination()
                val second = harness.awaitTransport(1)

                second.completeTerminationOnClose = false
                val receipt = async {
                    harness.actor.disconnectAndDrain(harness.profile.identity, "resource-fence")
                }
                delay(25)
                assertFalse(receipt.isCompleted)
                second.completeTermination()
                assertEquals(
                    "resource-fence",
                    withTimeout(TIMEOUT_MS) { receipt.await() }.barrierId,
                )
                assertEquals(listOf(1000), first.closeCodes)
                assertEquals(listOf(1000), second.closeCodes)
            } finally {
                harness.factory.transports.forEach { it.completeTermination() }
                harness.close()
            }
        }

    @Test
    fun `termination timeout is bounded fails closed and does not issue a receipt`() = runBlocking {
        val harness = Harness()
        try {
            assertTrue(harness.actor.connect(harness.profile, null))
            val transport = harness.awaitTransport(0)
            transport.completeTerminationOnClose = false
            transport.completeTermination(terminated = false)

            val result = runCatching {
                withTimeout(TIMEOUT_MS) {
                    harness.actor.disconnectAndDrain(harness.profile.identity, "timeout-fence")
                }
            }
            assertTrue(result.exceptionOrNull() is IllegalStateException)
            val failed = harness.actor.awaitFailure(RelayV2FailureKind.TRANSPORT)
            assertEquals("TRANSPORT_TERMINATION_TIMEOUT", failed.failure?.code)
            assertFalse(requireNotNull(failed.failure).retryable)
            assertEquals(listOf(1000), transport.closeCodes)
            assertEquals(1, transport.cancelCount)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `disconnect barrier drains queued callback and fences late callbacks from next profile`() =
        runBlocking {
            val harness = Harness()
            try {
                assertTrue(harness.actor.connect(harness.profile, resume = null))
                val first = harness.awaitTransport(0)
                first.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)

                first.fail(RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK))
                val failureEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.ConnectionFailed
                val receipt = harness.actor.disconnectAndDrain(harness.profile.identity, "barrier-1")
                assertEquals(harness.profile.identity, receipt.profile)
                assertEquals("barrier-1", receipt.barrierId)
                val disconnected = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.Disconnected
                assertEquals(failureEffect.generation, disconnected.fencedGeneration)
                assertFalse(
                    harness.actor.state.value.matchesGeneration(
                        requireNotNull(failureEffect.generation),
                    ),
                )

                val replacement = harness.installProfile("replacement", activationGeneration = 2)
                assertTrue(harness.actor.connect(replacement, resume = null))
                val second = harness.awaitTransport(1)

                first.fail(
                    RelayV2TransportFailure(
                        RelayV2TransportFailureKind.UPGRADE,
                        httpStatus = 401,
                    ),
                )
                second.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
                second.sendFixture("relay-welcome")
                val hello = second.awaitSentFrame()
                second.sendFixture(
                    "host-welcome-snapshot-required",
                    requestId = hello.stringValue("requestId"),
                )

                val effect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.BeginStateResync
                assertEquals(replacement.identity, effect.context.profile)
                assertEquals(
                    RelayV2ConnectionPhase.RESYNCING,
                    harness.actor.awaitPhase(RelayV2ConnectionPhase.RESYNCING).phase,
                )
                assertTrue(harness.actor.state.value.matchesGeneration(effect.generation))
            } finally {
                harness.close()
            }
        }

    @Test
    fun `disconnect waits for active apply lease before profile isolation and replacement`() = runBlocking {
        val harness = Harness()
        try {
            val hello = harness.connectThroughRelayWelcome(RelayV2ResumeCursor(HOST_EPOCH, "91"))
            val first = harness.transport()
            first.sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
            val oldEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.QueryPendingCommands
            assertTrue(harness.actor.state.value.matchesGeneration(oldEffect.generation))

            val applyEntered = CompletableDeferred<Unit>()
            val releaseApply = CompletableDeferred<Unit>()
            val commits = CopyOnWriteArrayList<String>()
            val applying = async {
                harness.actor.withEffectApplyLease(oldEffect) {
                    applyEntered.complete(Unit)
                    releaseApply.await()
                    commits += "old-commit"
                }
            }
            withTimeout(TIMEOUT_MS) { applyEntered.await() }
            val barrier = async {
                harness.actor.disconnectAndDrain(harness.profile.identity, "switch-barrier")
            }
            delay(25)
            assertFalse(barrier.isCompleted)
            assertFalse(harness.actor.state.value.matchesGeneration(oldEffect.generation))
            val stale = harness.actor.withEffectApplyLease(oldEffect) { commits += "stale-commit" }
            assertTrue(stale is RelayV2EffectApplyResult.Stale)

            releaseApply.complete(Unit)
            assertTrue(
                withTimeout(TIMEOUT_MS) { applying.await() } is
                    RelayV2EffectApplyResult.Applied,
            )
            assertEquals("switch-barrier", withTimeout(TIMEOUT_MS) { barrier.await() }.barrierId)
            commits += "barrier-complete"
            withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
            commits += "old-profile-cleared"
            val replacement = harness.installProfile("replacement", activationGeneration = 2)
            assertTrue(harness.actor.connect(replacement, null))
            val second = harness.awaitTransport(1)
            second.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            second.sendFixture("relay-welcome")
            val replacementHello = second.awaitSentFrame()
            second.sendFixture(
                "host-welcome-snapshot-required",
                replacementHello.stringValue("requestId"),
            )
            val replacementEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.BeginStateResync

            assertTrue(harness.actor.state.value.matchesGeneration(replacementEffect.generation))
            val replacementApply = harness.actor.withEffectApplyLease(replacementEffect) {
                commits += "replacement-commit"
            }
            assertTrue(replacementApply is RelayV2EffectApplyResult.Applied)
            assertEquals(
                listOf(
                    "old-commit",
                    "barrier-complete",
                    "old-profile-cleared",
                    "replacement-commit",
                ),
                commits,
            )
            assertEquals(1L, oldEffect.generation.profileGeneration)
            assertEquals(2L, replacementEffect.generation.profileGeneration)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `profile barrier fences queued and future connects until a higher activation`() = runBlocking {
        val harness = Harness()
        try {
            val hello = harness.connectThroughRelayWelcome(RelayV2ResumeCursor(HOST_EPOCH, "91"))
            harness.transport().sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
            val effect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.QueryPendingCommands
            val applyEntered = CompletableDeferred<Unit>()
            val releaseApply = CompletableDeferred<Unit>()
            val applying = async {
                harness.actor.withEffectApplyLease(effect) {
                    applyEntered.complete(Unit)
                    releaseApply.await()
                }
            }
            withTimeout(TIMEOUT_MS) { applyEntered.await() }
            val readsBeforeFence = harness.credentialReadCount()
            val barrier = async(start = CoroutineStart.UNDISPATCHED) {
                harness.actor.disconnectAndDrain(harness.profile.identity, "activation-fence")
            }
            assertFalse(barrier.isCompleted)

            assertFalse(harness.actor.connect(harness.profile, null))
            assertEquals(readsBeforeFence, harness.credentialReadCount())
            releaseApply.complete(Unit)
            withTimeout(TIMEOUT_MS) { applying.await() }
            assertEquals("activation-fence", withTimeout(TIMEOUT_MS) { barrier.await() }.barrierId)
            withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }

            assertFalse(harness.actor.connect(harness.profile, null))
            assertEquals(readsBeforeFence, harness.credentialReadCount())
            val reactivated = harness.profile.copy(activationGeneration = 2)
            assertTrue(harness.actor.connect(reactivated, null))
            val replacement = harness.awaitTransport(1)
            replacement.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            val awaiting = harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            assertEquals(2L, awaiting.activationGeneration)
            assertEquals(readsBeforeFence + 1, harness.credentialReadCount())
        } finally {
            harness.close()
        }
    }

    @Test
    fun `shutdown drain waits for apply lease and is shared by close and disconnect races`() = runBlocking {
        val harness = Harness()
        val releaseApply = CompletableDeferred<Unit>()
        try {
            val hello = harness.connectThroughRelayWelcome(RelayV2ResumeCursor(HOST_EPOCH, "91"))
            harness.transport().sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
            val effect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.QueryPendingCommands
            val applyEntered = CompletableDeferred<Unit>()
            val commits = CopyOnWriteArrayList<String>()
            val applying = async {
                harness.actor.withEffectApplyLease(effect) {
                    applyEntered.complete(Unit)
                    releaseApply.await()
                    commits += "old-room-commit"
                }
            }
            withTimeout(TIMEOUT_MS) { applyEntered.await() }
            harness.transport().sendFixture("host-presence-online")
            val beforeClose = async {
                harness.actor.disconnectAndDrain(harness.profile.identity, "before-close")
            }
            delay(25)
            assertFalse(beforeClose.isCompleted)

            harness.actor.close()
            val afterFirstClose = async {
                harness.actor.disconnectAndDrain(harness.profile.identity, "after-first-close")
            }
            harness.actor.close()
            val afterSecondClose = async {
                harness.actor.disconnectAndDrain(harness.profile.identity, "after-second-close")
            }
            delay(25)
            assertFalse(beforeClose.isCompleted)
            assertFalse(afterFirstClose.isCompleted)
            assertFalse(afterSecondClose.isCompleted)
            assertFalse(harness.actor.state.value.phase == RelayV2ConnectionPhase.CLOSED)

            releaseApply.complete(Unit)
            withTimeout(TIMEOUT_MS) { applying.await() }
            assertEquals("before-close", withTimeout(TIMEOUT_MS) { beforeClose.await() }.barrierId)
            assertEquals(
                "after-first-close",
                withTimeout(TIMEOUT_MS) { afterFirstClose.await() }.barrierId,
            )
            assertEquals(
                "after-second-close",
                withTimeout(TIMEOUT_MS) { afterSecondClose.await() }.barrierId,
            )
            commits += "shutdown-drain-complete"
            commits += "old-profile-cleared"
            assertEquals(
                RelayV2ConnectionPhase.CLOSED,
                harness.actor.state.value.phase,
            )
            assertTrue(withTimeout(TIMEOUT_MS) { harness.actor.effects.toList() }.isEmpty())
            assertEquals(
                listOf("old-room-commit", "shutdown-drain-complete", "old-profile-cleared"),
                commits,
            )
        } finally {
            releaseApply.complete(Unit)
            harness.close()
        }
    }

    @Test
    fun `cancelled disconnects release pending ownership whether queued or waiting for capacity`() =
        runBlocking {
            val factory = FakeTransportFactory(blockFirstOpen = true)
            val harness = Harness(
                factory = factory,
                reservedActionCapacity = 1,
            )
            try {
                assertTrue(harness.actor.connect(harness.profile, null))
                assertTrue(factory.openEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                val queued = async {
                    harness.actor.disconnectAndDrain(harness.profile.identity, "queued-cancel")
                }
                delay(25)
                val waiting = async {
                    harness.actor.disconnectAndDrain(harness.profile.identity, "waiting-cancel")
                }
                delay(25)
                assertFalse(queued.isCompleted)
                assertFalse(waiting.isCompleted)

                queued.cancelAndJoin()
                waiting.cancelAndJoin()
                assertTrue(queued.isCancelled)
                assertTrue(waiting.isCancelled)

                harness.actor.close()
                factory.releaseOpen.countDown()
                val closed = harness.actor.awaitPhase(RelayV2ConnectionPhase.CLOSED)
                assertEquals(3L, closed.connectionGeneration)
            } finally {
                factory.releaseOpen.countDown()
                harness.close()
            }
        }

    @Test
    fun `close orders accepted callbacks before shutdown and rejects later callback pressure`() =
        runBlocking {
            val factory = FakeTransportFactory(blockFirstSend = true)
            val harness = Harness(
                factory = factory,
                normalActionCapacity = 1,
                reservedActionCapacity = 1,
            )
            try {
                assertTrue(harness.actor.connect(harness.profile, null))
                val transport = harness.awaitTransport(0)
                transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
                transport.sendFixture("relay-welcome")
                assertTrue(factory.sendEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))

                transport.sendRaw("{}".toByteArray())
                harness.actor.close()
                repeat(32) { transport.sendRaw("{}".toByteArray()) }
                val shutdownBarrier = async {
                    harness.actor.disconnectAndDrain(harness.profile.identity, "callback-close")
                }
                delay(25)
                assertFalse(shutdownBarrier.isCompleted)

                factory.releaseSend.countDown()
                assertEquals(
                    "callback-close",
                    withTimeout(TIMEOUT_MS) { shutdownBarrier.await() }.barrierId,
                )
                val closed = harness.actor.awaitPhase(RelayV2ConnectionPhase.CLOSED)
                assertEquals(RelayV2ConnectionPhase.CLOSED, closed.phase)
                assertTrue(transport.closeCodes.isNotEmpty() || transport.cancelCount > 0)
                assertTrue(withTimeout(TIMEOUT_MS) { harness.actor.effects.toList() }.isEmpty())
            } finally {
                factory.releaseSend.countDown()
                harness.close()
            }
        }

    @Test
    fun `connect token closes transports when shutdown wins before or after factory creation`() =
        runBlocking {
            val blockedFactory = FakeTransportFactory(blockFirstOpen = true)
            val blockedHarness = Harness(factory = blockedFactory)
            try {
                assertTrue(blockedHarness.actor.connect(blockedHarness.profile, null))
                assertTrue(blockedFactory.openEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                blockedHarness.actor.close()
                val barrier = async {
                    blockedHarness.actor.disconnectAndDrain(
                        blockedHarness.profile.identity,
                        "close-before-open-return",
                    )
                }
                assertFalse(barrier.isCompleted)
                blockedFactory.releaseOpen.countDown()
                val opened = blockedHarness.awaitTransport(0)
                assertEquals(
                    "close-before-open-return",
                    withTimeout(TIMEOUT_MS) { barrier.await() }.barrierId,
                )
                assertEquals(listOf(1000), opened.closeCodes)
                assertEquals(
                    RelayV2ConnectionPhase.CLOSED,
                    blockedHarness.actor.state.value.phase,
                )
            } finally {
                blockedFactory.releaseOpen.countDown()
                blockedHarness.close()
            }

            val createdFactory = FakeTransportFactory()
            val createdHarness = Harness(factory = createdFactory)
            try {
                createdFactory.onTransportCreated = { createdHarness.actor.close() }
                assertTrue(createdHarness.actor.connect(createdHarness.profile, null))
                val opened = createdHarness.awaitTransport(0)
                val receipt = withTimeout(TIMEOUT_MS) {
                    createdHarness.actor.disconnectAndDrain(
                        createdHarness.profile.identity,
                        "close-after-factory-created",
                    )
                }
                assertEquals("close-after-factory-created", receipt.barrierId)
                assertEquals(listOf(1000), opened.closeCodes)
                assertEquals(
                    RelayV2ConnectionPhase.CLOSED,
                    createdHarness.actor.state.value.phase,
                )
            } finally {
                createdHarness.close()
            }
        }

    @Test
    fun `factory callbacks reentrant before return are processed only after owner commit`() =
        runBlocking {
            val openedFactory = FakeTransportFactory()
            val openedHarness = Harness(factory = openedFactory)
            try {
                openedFactory.onTransportCreated = {
                    it.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                }
                assertTrue(openedHarness.actor.connect(openedHarness.profile, null))
                openedHarness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
                assertTrue(openedHarness.transport().closeCodes.isEmpty())
            } finally {
                openedHarness.close()
            }

            val failedFactory = FakeTransportFactory()
            val failedHarness = Harness(factory = failedFactory)
            try {
                failedFactory.onTransportCreated = {
                    it.fail(RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK))
                }
                assertTrue(failedHarness.actor.connect(failedHarness.profile, null))
                val failure = failedHarness.actor.awaitFailure(RelayV2FailureKind.TRANSPORT)
                assertEquals("HOST_OFFLINE", failure.failure?.code)
                assertEquals(1, failedFactory.requests.size)
            } finally {
                failedHarness.close()
            }

            listOf<Pair<String, (FakeTransport) -> Unit>>(
                "onOpen" to { it.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL) },
                "onFrame" to { it.sendRaw(byteArrayOf('{'.code.toByte())) },
            ).forEach { (callbackName, callback) ->
                val throwingFactory = FakeTransportFactory().apply {
                    failureAfterCreate = IllegalStateException("factory failed after callback")
                }
                val throwingHarness = Harness(factory = throwingFactory)
                try {
                    throwingFactory.onTransportCreated = {
                        it.completeTerminationOnClose = false
                        callback(it)
                    }
                    assertTrue(
                        callbackName,
                        throwingHarness.actor.connect(throwingHarness.profile, null),
                    )
                    throwingHarness.actor.awaitFailure(RelayV2FailureKind.TRANSPORT)
                    val transport = throwingHarness.awaitTransport(0)
                    withTimeout(TIMEOUT_MS) {
                        while (transport.closeCodes.isEmpty()) delay(1)
                    }

                    throwingFactory.failureAfterCreate = null
                    assertTrue(
                        callbackName,
                        throwingHarness.actor.connect(throwingHarness.profile, null),
                    )
                    transport.sendRaw(byteArrayOf('{'.code.toByte()))
                    val receipt = async {
                        throwingHarness.actor.disconnectAndDrain(
                            throwingHarness.profile.identity,
                            "callback-source-$callbackName",
                        )
                    }
                    delay(25)
                    assertFalse(callbackName, receipt.isCompleted)
                    assertEquals(callbackName, 1, throwingFactory.requests.size)

                    transport.completeTermination()
                    assertEquals(
                        callbackName,
                        "callback-source-$callbackName",
                        withTimeout(TIMEOUT_MS) { receipt.await() }.barrierId,
                    )
                    assertEquals(callbackName, 1, throwingFactory.requests.size)
                } finally {
                    throwingFactory.transports.forEach { it.completeTermination() }
                    throwingHarness.close()
                }
            }

        }

    @Test
    fun `source mismatch is typed and fenced across factory timing windows`() = runBlocking {
        MismatchTiming.entries.forEach { timing ->
            val commitEntered = CompletableDeferred<Unit>()
            val releaseCommit = CompletableDeferred<Unit>()
            val factory = FakeTransportFactory().apply {
                returnDifferentSource = timing == MismatchTiming.BEFORE_FACTORY_RETURN
            }
            val harness = Harness(
                factory = factory,
                beforeTransportCommit = if (timing == MismatchTiming.BEFORE_COMMIT) {
                    {
                        commitEntered.complete(Unit)
                        releaseCommit.await()
                    }
                } else {
                    {}
                },
            )
            try {
                if (timing == MismatchTiming.BEFORE_FACTORY_RETURN) {
                    factory.onTransportCreated = { callbackSource ->
                        factory.transports.forEach { it.completeTerminationOnClose = false }
                        callbackSource.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                    }
                }
                assertTrue(timing.name, harness.actor.connect(harness.profile, null))

                val sources = when (timing) {
                    MismatchTiming.BEFORE_FACTORY_RETURN -> listOf(
                        harness.awaitTransport(0),
                        harness.awaitTransport(1),
                    )
                    MismatchTiming.BEFORE_COMMIT -> {
                        withTimeout(TIMEOUT_MS) { commitEntered.await() }
                        val returned = harness.awaitTransport(0).apply {
                            completeTerminationOnClose = false
                        }
                        val callbackSource = factory.createCallbackSource().apply {
                            completeTerminationOnClose = false
                            open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                        }
                        releaseCommit.complete(Unit)
                        listOf(returned, callbackSource)
                    }
                    MismatchTiming.AFTER_COMMIT -> {
                        val returned = harness.awaitTransport(0).apply {
                            completeTerminationOnClose = false
                        }
                        harness.actor.awaitPhase(RelayV2ConnectionPhase.CONNECTING)
                        val callbackSource = factory.createCallbackSource().apply {
                            completeTerminationOnClose = false
                            open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                        }
                        listOf(returned, callbackSource)
                    }
                }

                val failure = harness.actor.awaitFailure(RelayV2FailureKind.SECURITY).failure
                assertEquals(timing.name, "TRANSPORT_SOURCE_MISMATCH", failure?.code)
                assertFalse(timing.name, requireNotNull(failure).retryable)
                val effect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.ConnectionFailed
                assertEquals(timing.name, harness.profile.identity, effect.profile)
                assertEquals(timing.name, failure, effect.failure)
                withTimeout(TIMEOUT_MS) {
                    while (sources.any { it.closeCodes.isEmpty() }) delay(1)
                }
                sources.forEach { source ->
                    assertEquals(timing.name, listOf(1000), source.closeCodes)
                }

                assertTrue(timing.name, harness.actor.connect(harness.profile, null))
                val receipt = async {
                    harness.actor.disconnectAndDrain(
                        harness.profile.identity,
                        "mismatch-${timing.name}",
                    )
                }
                delay(25)
                assertFalse(timing.name, receipt.isCompleted)
                assertEquals(timing.name, 1, factory.requests.size)
                sources.first().completeTermination()
                delay(25)
                assertFalse(timing.name, receipt.isCompleted)
                sources.last().completeTermination()
                assertEquals(
                    timing.name,
                    "mismatch-${timing.name}",
                    withTimeout(TIMEOUT_MS) { receipt.await() }.barrierId,
                )
                assertEquals(timing.name, 1, factory.requests.size)
            } finally {
                releaseCommit.complete(Unit)
                factory.transports.forEach { it.completeTermination() }
                harness.close()
            }
        }
    }

    @Test
    fun `synchronous close callback cannot recursively close a retiring source`() = runBlocking {
        val harness = Harness()
        try {
            assertTrue(harness.actor.connect(harness.profile, null))
            val transport = harness.awaitTransport(0)
            transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            transport.completeTerminationOnClose = false
            transport.synchronousClosedOnClose = true
            transport.throwOnSecondClose = true

            val receipt = async {
                harness.actor.disconnectAndDrain(harness.profile.identity, "synchronous-close")
            }
            withTimeout(TIMEOUT_MS) {
                while (transport.closeCodes.isEmpty()) delay(1)
            }
            assertEquals(listOf(1000), transport.closeCodes)
            assertFalse(receipt.isCompleted)

            transport.completeTermination()
            assertEquals(
                "synchronous-close",
                withTimeout(TIMEOUT_MS) { receipt.await() }.barrierId,
            )
            assertEquals(listOf(1000), transport.closeCodes)

            val reactivated = harness.profile.copy(activationGeneration = 2)
            assertTrue(harness.actor.connect(reactivated, null))
            harness.awaitTransport(1)
            assertEquals(2, harness.factory.transports.size)
        } finally {
            harness.factory.transports.forEach { it.completeTermination() }
            harness.close()
        }
    }

    @Test
    fun `direct failures share the terminal claim with higher callback causes`() = runBlocking {
        val directClaimEntered = CountDownLatch(1)
        val releaseDirectClaim = CountDownLatch(1)
        val blockDirectClaim = AtomicBoolean(true)
        val directHarness = Harness(
            beforeTerminalClaim = {
                if (blockDirectClaim.compareAndSet(true, false)) {
                    directClaimEntered.countDown()
                    check(releaseDirectClaim.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                }
            },
        )
        try {
            assertTrue(directHarness.actor.connect(directHarness.profile, null))
            val committed = directHarness.awaitTransport(0)
            committed.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            directHarness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            committed.sendRaw(byteArrayOf('{'.code.toByte()))
            assertTrue(directClaimEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))

            val mismatched = directHarness.factory.createCallbackSource()
            mismatched.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            releaseDirectClaim.countDown()

            val failure = directHarness.actor.awaitFailure(RelayV2FailureKind.SECURITY).failure
            assertEquals("TRANSPORT_SOURCE_MISMATCH", failure?.code)
            assertFalse(requireNotNull(failure).retryable)
            val effect = withTimeout(TIMEOUT_MS) { directHarness.actor.effects.first() }
                as RelayV2RuntimeEffect.ConnectionFailed
            assertEquals(failure, effect.failure)
            assertEquals(null, withTimeoutOrNull(50) { directHarness.actor.effects.first() })
        } finally {
            releaseDirectClaim.countDown()
            directHarness.factory.transports.forEach { it.completeTermination() }
            directHarness.close()
        }

        val queueClaimEntered = CountDownLatch(1)
        val releaseQueueClaim = CountDownLatch(1)
        val blockQueueClaim = AtomicBoolean(true)
        val queueHarness = Harness(
            effectByteCapacity = 64,
            beforeTerminalClaim = {
                if (blockQueueClaim.compareAndSet(true, false)) {
                    queueClaimEntered.countDown()
                    check(releaseQueueClaim.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                }
            },
        )
        try {
            val hello = queueHarness.connectThroughRelayWelcome(null)
            val transport = queueHarness.transport()
            transport.sendFixture(
                "host-welcome-snapshot-required",
                hello.stringValue("requestId"),
            )
            assertTrue(queueClaimEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))

            transport.fail(RelayV2TransportFailure(RelayV2TransportFailureKind.TLS_VALIDATION))
            releaseQueueClaim.countDown()

            val failure = queueHarness.actor.awaitFailure(RelayV2FailureKind.SECURITY).failure
            assertEquals("TLS_VALIDATION_FAILED", failure?.code)
            assertFalse(requireNotNull(failure).retryable)
            val effect = withTimeout(TIMEOUT_MS) { queueHarness.actor.effects.first() }
                as RelayV2RuntimeEffect.ConnectionFailed
            assertEquals(failure, effect.failure)
            assertEquals(1, transport.cancelCount)
        } finally {
            releaseQueueClaim.countDown()
            queueHarness.factory.transports.forEach { it.completeTermination() }
            queueHarness.close()
        }
    }

    @Test
    fun `disconnect recognizes committed source before its first callback`() = runBlocking {
        val ownerSealed = CountDownLatch(1)
        val releaseDisconnect = CountDownLatch(1)
        val harness = Harness(
            afterDisconnectOwnerSeal = {
                ownerSealed.countDown()
                check(releaseDisconnect.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            },
        )
        try {
            assertTrue(harness.actor.connect(harness.profile, null))
            val transport = harness.awaitTransport(0).apply {
                completeTerminationOnClose = false
            }
            harness.actor.awaitPhase(RelayV2ConnectionPhase.CONNECTING)
            val receipt = async(start = CoroutineStart.UNDISPATCHED) {
                harness.actor.disconnectAndDrain(
                    harness.profile.identity,
                    "pre-callback-source",
                )
            }
            assertTrue(ownerSealed.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))

            transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            assertEquals(0, transport.cancelCount)
            assertTrue(transport.closeCodes.isEmpty())
            assertFalse(receipt.isCompleted)

            releaseDisconnect.countDown()
            withTimeout(TIMEOUT_MS) {
                while (transport.closeCodes.isEmpty()) delay(1)
            }
            assertEquals(listOf(1000), transport.closeCodes)
            assertEquals(0, transport.cancelCount)
            assertFalse(receipt.isCompleted)
            transport.completeTermination()
            assertEquals(
                "pre-callback-source",
                withTimeout(TIMEOUT_MS) { receipt.await() }.barrierId,
            )
            assertEquals(listOf(1000), transport.closeCodes)
        } finally {
            releaseDisconnect.countDown()
            harness.factory.transports.forEach { it.completeTermination() }
            harness.close()
        }

        val sourceCreated = CountDownLatch(1)
        val releaseFactoryReturn = CountDownLatch(1)
        val blockedFactory = FakeTransportFactory()
        val blockedHarness = Harness(factory = blockedFactory)
        try {
            blockedFactory.onTransportCreated = { source ->
                source.completeTerminationOnCancel = false
                source.completeTerminationOnClose = false
                sourceCreated.countDown()
                check(releaseFactoryReturn.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            }
            assertTrue(blockedHarness.actor.connect(blockedHarness.profile, null))
            assertTrue(sourceCreated.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            val source = blockedHarness.awaitTransport(0)
            val receipt = async(start = CoroutineStart.UNDISPATCHED) {
                blockedHarness.actor.disconnectAndDrain(
                    blockedHarness.profile.identity,
                    "created-before-return",
                )
            }

            source.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            assertEquals(1, source.cancelCount)
            assertTrue(source.closeCodes.isEmpty())
            assertFalse(receipt.isCompleted)

            releaseFactoryReturn.countDown()
            withTimeout(TIMEOUT_MS) {
                while (source.awaitTerminationCount.get() == 0) delay(1)
            }
            assertEquals(1, source.cancelCount)
            assertTrue(source.closeCodes.isEmpty())
            assertFalse(receipt.isCompleted)

            source.completeTermination()
            assertEquals(
                "created-before-return",
                withTimeout(TIMEOUT_MS) { receipt.await() }.barrierId,
            )
            assertEquals(1, source.cancelCount)
            assertTrue(source.closeCodes.isEmpty())
        } finally {
            releaseFactoryReturn.countDown()
            blockedFactory.transports.forEach { it.completeTermination() }
            blockedHarness.close()
        }
    }

    @Test
    fun `source mismatch dominates ordinary terminal callbacks in either enqueue order`() =
        runBlocking {
            listOf("ordinary-first", "mismatch-first").forEach { order ->
                val factory = FakeTransportFactory(blockFirstSend = true)
                val harness = Harness(factory = factory)
                try {
                    assertTrue(order, harness.actor.connect(harness.profile, null))
                    val committed = harness.awaitTransport(0)
                    committed.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                    harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
                    committed.sendFixture("relay-welcome")
                    assertTrue(factory.sendEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                    val mismatched = factory.createCallbackSource().apply {
                        completeTerminationOnClose = false
                    }
                    if (order == "ordinary-first") {
                        committed.fail(RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK))
                        mismatched.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                    } else {
                        mismatched.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                        committed.fail(RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK))
                    }
                    factory.releaseSend.countDown()

                    val failure = harness.actor.awaitFailure(RelayV2FailureKind.SECURITY).failure
                    assertEquals(order, "TRANSPORT_SOURCE_MISMATCH", failure?.code)
                    assertFalse(order, requireNotNull(failure).retryable)
                    val effect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                        as RelayV2RuntimeEffect.ConnectionFailed
                    assertEquals(order, failure, effect.failure)
                    assertEquals(
                        order,
                        null,
                        withTimeoutOrNull(50) { harness.actor.effects.first() },
                    )

                    assertTrue(order, harness.actor.connect(harness.profile, null))
                    val receipt = async {
                        harness.actor.disconnectAndDrain(
                            harness.profile.identity,
                            "terminal-precedence-$order",
                        )
                    }
                    delay(25)
                    assertFalse(order, receipt.isCompleted)
                    assertEquals(order, 1, factory.requests.size)
                    mismatched.completeTermination()
                    assertEquals(
                        order,
                        "terminal-precedence-$order",
                        withTimeout(TIMEOUT_MS) { receipt.await() }.barrierId,
                    )
                    assertTrue(order, committed.awaitTerminationCount.get() > 0)
                    assertTrue(order, mismatched.awaitTerminationCount.get() > 0)
                    assertEquals(order, 1, factory.requests.size)
                } finally {
                    factory.releaseSend.countDown()
                    factory.transports.forEach { it.completeTermination() }
                    harness.close()
                }
            }
        }

    @Test
    fun `terminal cause and owner revocation share one lifecycle claim`() = runBlocking {
        val claimEntered = CountDownLatch(1)
        val releaseClaim = CountDownLatch(1)
        val harness = Harness(
            betweenTerminalCauseReadAndOwnerRevoke = {
                claimEntered.countDown()
                check(releaseClaim.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            },
        )
        try {
            assertTrue(harness.actor.connect(harness.profile, null))
            val committed = harness.awaitTransport(0)
            committed.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            committed.fail(RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK))
            assertTrue(claimEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))

            val mismatched = harness.factory.createCallbackSource()
            val callbackEntered = CountDownLatch(1)
            val callback = async(Dispatchers.Default) {
                callbackEntered.countDown()
                mismatched.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            }
            assertTrue(callbackEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            delay(25)
            assertFalse(callback.isCompleted)
            releaseClaim.countDown()
            withTimeout(TIMEOUT_MS) { callback.await() }

            val failure = harness.actor.awaitFailure(RelayV2FailureKind.TRANSPORT).failure
            assertEquals("HOST_OFFLINE", failure?.code)
            assertTrue(requireNotNull(failure).retryable)
            val effect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.ConnectionFailed
            assertEquals(failure, effect.failure)
            assertEquals(null, withTimeoutOrNull(50) { harness.actor.effects.first() })
            assertEquals(listOf(1000), mismatched.closeCodes)
        } finally {
            releaseClaim.countDown()
            harness.factory.transports.forEach { it.completeTermination() }
            harness.close()
        }
    }

    @Test
    fun `slow consumer intent dominates synchronous close callback`() = runBlocking {
        val harness = Harness(actionByteCapacity = 64)
        try {
            assertTrue(harness.actor.connect(harness.profile, null))
            val transport = harness.awaitTransport(0)
            transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            transport.completeTerminationOnClose = false
            transport.synchronousClosedOnClose = true
            transport.throwOnSecondClose = true
            transport.sendFixture("relay-welcome")

            val failure = harness.actor.awaitFailure(RelayV2FailureKind.QUEUE_SATURATED).failure
            assertEquals("SLOW_CONSUMER", failure?.code)
            val effect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.ConnectionFailed
            assertEquals(failure, effect.failure)
            assertEquals(listOf(1013), transport.closeCodes)

            assertTrue(harness.actor.connect(harness.profile, null))
            val receipt = async {
                harness.actor.disconnectAndDrain(harness.profile.identity, "slow-consumer-sync-close")
            }
            delay(25)
            assertFalse(receipt.isCompleted)
            assertEquals(1, harness.factory.requests.size)
            transport.completeTermination()
            assertEquals(
                "slow-consumer-sync-close",
                withTimeout(TIMEOUT_MS) { receipt.await() }.barrierId,
            )
            assertEquals(listOf(1013), transport.closeCodes)
            assertEquals(1, harness.factory.requests.size)
        } finally {
            harness.factory.transports.forEach { it.completeTermination() }
            harness.close()
        }
    }

    @Test
    fun `non ordinary terminal causes dominate saturation in either order`() = runBlocking {
        data class Scenario(
            val name: String,
            val expected: RelayV2ConnectionFailure,
            val terminate: (FakeTransport) -> Unit,
        )

        val scenarios = listOf(
            Scenario(
                "tls",
                RelayV2ConnectionFailure(
                    RelayV2FailureKind.SECURITY,
                    "TLS_VALIDATION_FAILED",
                    false,
                ),
            ) { it.fail(RelayV2TransportFailure(RelayV2TransportFailureKind.TLS_VALIDATION)) },
            Scenario(
                "protocol",
                RelayV2ConnectionFailure(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false),
            ) { it.fail(RelayV2TransportFailure(RelayV2TransportFailureKind.PROTOCOL)) },
            Scenario(
                "upgrade-auth",
                RelayV2ConnectionFailure(RelayV2FailureKind.AUTH, "AUTH_REQUIRED", false),
            ) {
                it.fail(
                    RelayV2TransportFailure(
                        RelayV2TransportFailureKind.UPGRADE,
                        httpStatus = 401,
                    ),
                )
            },
            Scenario(
                "close-1002",
                RelayV2ConnectionFailure(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false),
            ) { it.closed(1002) },
            Scenario(
                "close-1007",
                RelayV2ConnectionFailure(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false),
            ) { it.closed(1007) },
            Scenario(
                "close-1008",
                RelayV2ConnectionFailure(RelayV2FailureKind.SECURITY, "POLICY_VIOLATION", false),
            ) { it.closed(1008) },
            Scenario(
                "close-1009",
                RelayV2ConnectionFailure(RelayV2FailureKind.SCHEMA, "FRAME_TOO_LARGE", false),
            ) { it.closed(1009) },
            Scenario(
                "close-1011",
                RelayV2ConnectionFailure(RelayV2FailureKind.ROUTE, "SERVER_ERROR", true),
            ) { it.closed(1011) },
            Scenario(
                "close-4400",
                RelayV2ConnectionFailure(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false),
            ) { it.closed(4400) },
            Scenario(
                "close-4401",
                RelayV2ConnectionFailure(RelayV2FailureKind.AUTH, "AUTH_REQUIRED", false),
            ) { it.closed(4401) },
            Scenario(
                "close-4403",
                RelayV2ConnectionFailure(RelayV2FailureKind.AUTH, "AUTH_INVALID", false),
            ) { it.closed(4403) },
            Scenario(
                "close-4406",
                RelayV2ConnectionFailure(
                    RelayV2FailureKind.DIALECT,
                    "PROTOCOL_UNSUPPORTED",
                    false,
                ),
            ) { it.closed(4406) },
            Scenario(
                "close-4408",
                RelayV2ConnectionFailure(
                    RelayV2FailureKind.TRANSPORT,
                    "HANDSHAKE_TIMEOUT",
                    true,
                ),
            ) { it.closed(4408) },
            Scenario(
                "close-4409",
                RelayV2ConnectionFailure(RelayV2FailureKind.ROUTE, "HOST_SUPERSEDED", false),
            ) { it.closed(4409) },
            Scenario(
                "unknown-private-close",
                RelayV2ConnectionFailure(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false),
            ) { it.closed(4410) },
            Scenario(
                "close-4411",
                RelayV2ConnectionFailure(
                    RelayV2FailureKind.ROUTE,
                    "DUPLICATE_CONNECTOR",
                    false,
                ),
            ) { it.closed(4411) },
        )

        scenarios.forEach { scenario ->
            listOf("terminal-first", "saturation-first").forEach { order ->
                val commitEntered = CompletableDeferred<Unit>()
                val releaseCommit = CompletableDeferred<Unit>()
                val harness = Harness(
                    actionByteCapacity = 64,
                    beforeTransportCommit = {
                        commitEntered.complete(Unit)
                        releaseCommit.await()
                    },
                )
                try {
                    assertTrue("${scenario.name}:$order", harness.actor.connect(harness.profile, null))
                    withTimeout(TIMEOUT_MS) { commitEntered.await() }
                    val transport = harness.awaitTransport(0)
                    val saturate = { transport.sendRaw(ByteArray(65)) }
                    if (order == "terminal-first") {
                        scenario.terminate(transport)
                        saturate()
                    } else {
                        saturate()
                        scenario.terminate(transport)
                    }
                    releaseCommit.complete(Unit)

                    val failure = harness.actor.awaitFailure(scenario.expected.kind).failure
                    assertEquals("${scenario.name}:$order", scenario.expected, failure)
                    val effect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                        as RelayV2RuntimeEffect.ConnectionFailed
                    assertEquals("${scenario.name}:$order", scenario.expected, effect.failure)
                    assertEquals("${scenario.name}:$order", listOf(1013), transport.closeCodes)
                } finally {
                    releaseCommit.complete(Unit)
                    harness.factory.transports.forEach { it.completeTermination() }
                    harness.close()
                }
            }
        }
    }

    @Test
    fun `only normal close and network failure yield to saturation`() = runBlocking {
        val ordinaryCauses = listOf<Pair<String, (FakeTransport) -> Unit>>(
            "close-1000" to { it.closed(1000) },
            "network" to {
                it.fail(RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK))
            },
        )
        ordinaryCauses.forEach { (name, terminate) ->
            listOf("terminal-first", "saturation-first").forEach { order ->
                val commitEntered = CompletableDeferred<Unit>()
                val releaseCommit = CompletableDeferred<Unit>()
                val harness = Harness(
                    actionByteCapacity = 64,
                    beforeTransportCommit = {
                        commitEntered.complete(Unit)
                        releaseCommit.await()
                    },
                )
                try {
                    assertTrue("$name:$order", harness.actor.connect(harness.profile, null))
                    withTimeout(TIMEOUT_MS) { commitEntered.await() }
                    val transport = harness.awaitTransport(0)
                    val saturate = { transport.sendRaw(ByteArray(65)) }
                    if (order == "terminal-first") {
                        terminate(transport)
                        saturate()
                    } else {
                        saturate()
                        terminate(transport)
                    }
                    releaseCommit.complete(Unit)

                    val failure = harness.actor.awaitFailure(
                        RelayV2FailureKind.QUEUE_SATURATED,
                    ).failure
                    assertEquals("$name:$order", "SLOW_CONSUMER", failure?.code)
                    assertTrue("$name:$order", requireNotNull(failure).retryable)
                    assertEquals("$name:$order", listOf(1013), transport.closeCodes)
                } finally {
                    releaseCommit.complete(Unit)
                    harness.factory.transports.forEach { it.completeTermination() }
                    harness.close()
                }
            }
        }
    }

    @Test
    fun `completed retirement remains tombstoned through queued stale callback`() = runBlocking {
        val factory = FakeTransportFactory(blockFirstSend = true)
        val harness = Harness(factory = factory)
        try {
            assertTrue(harness.actor.connect(harness.profile, null))
            val first = harness.awaitTransport(0)
            first.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            first.sendFixture("relay-welcome")
            assertTrue(factory.sendEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            first.throwOnSecondClose = true

            assertTrue(harness.actor.connect(harness.profile, null))
            first.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            factory.releaseSend.countDown()
            val second = harness.awaitTransport(1)
            delay(25)
            assertEquals(listOf(1000), first.closeCodes)
            val completedAwaitCount = first.awaitTerminationCount.get()
            assertTrue(completedAwaitCount > 0)

            val receipt = harness.actor.disconnectAndDrain(
                harness.profile.identity,
                "completed-retirement-tombstone",
            )
            assertEquals("completed-retirement-tombstone", receipt.barrierId)
            assertEquals(2, factory.requests.size)
            assertEquals(listOf(1000), first.closeCodes)
            assertEquals(completedAwaitCount, first.awaitTerminationCount.get())
            second.completeTermination()
        } finally {
            factory.releaseSend.countDown()
            factory.transports.forEach { it.completeTermination() }
            harness.close()
        }
    }

    @Test
    fun `terminal leases tombstone coalesced mismatch and saturation sources`() = runBlocking {
        listOf("source-mismatch", "saturation").forEach { scenario ->
            val factory = FakeTransportFactory(blockFirstSend = true)
            val secondCreated = CountDownLatch(1)
            val releaseSecond = CountDownLatch(1)
            val harness = Harness(
                factory = factory,
                normalActionCapacity = if (scenario == "saturation") {
                    1
                } else {
                    RelayV2ConnectionActor.DEFAULT_ACTION_CAPACITY
                },
            )
            try {
                assertTrue(scenario, harness.actor.connect(harness.profile, null))
                val committed = harness.awaitTransport(0)
                committed.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
                committed.sendFixture("relay-welcome")
                assertTrue(factory.sendEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                factory.onTransportCreated = {
                    secondCreated.countDown()
                    check(releaseSecond.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                }

                assertTrue(scenario, harness.actor.connect(harness.profile, null))
                val retiredSources = if (scenario == "source-mismatch") {
                    committed.fail(RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK))
                    val mismatched = factory.createCallbackSource()
                    mismatched.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                    listOf(committed, mismatched)
                } else {
                    committed.sendRaw(byteArrayOf(0x01))
                    listOf(committed)
                }
                factory.releaseSend.countDown()
                assertTrue(scenario, secondCreated.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))

                val completedAwaitCounts = retiredSources.associateWith {
                    it.awaitTerminationCount.get()
                }
                retiredSources.forEach {
                    assertTrue(scenario, completedAwaitCounts.getValue(it) > 0)
                    it.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                }
                retiredSources.forEach { source ->
                    val expectedClose = if (scenario == "saturation") 1013 else 1000
                    assertEquals(scenario, listOf(expectedClose), source.closeCodes)
                }

                releaseSecond.countDown()
                withTimeout(TIMEOUT_MS) {
                    while (factory.requests.size < 2) delay(1)
                }
                val receipt = harness.actor.disconnectAndDrain(
                    harness.profile.identity,
                    "terminal-lease-$scenario",
                )
                assertEquals("terminal-lease-$scenario", receipt.barrierId)
                retiredSources.forEach { source ->
                    assertEquals(
                        scenario,
                        completedAwaitCounts.getValue(source),
                        source.awaitTerminationCount.get(),
                    )
                }
            } finally {
                factory.releaseSend.countDown()
                releaseSecond.countDown()
                factory.transports.forEach { it.completeTermination() }
                harness.close()
            }
        }
    }

    @Test
    fun `multi source fence awaits every source before reporting any failure`() = runBlocking {
        listOf(0, 1).forEach { falseIndex ->
            val factory = FakeTransportFactory().apply { returnDifferentSource = true }
            val harness = Harness(factory = factory)
            try {
                factory.onTransportCreated = { callbackSource ->
                    factory.transports.forEach { it.completeTerminationOnClose = false }
                    callbackSource.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                }
                assertTrue(harness.actor.connect(harness.profile, null))
                harness.actor.awaitFailure(RelayV2FailureKind.SECURITY)
                val sources = listOf(harness.awaitTransport(0), harness.awaitTransport(1))
                val pendingIndex = 1 - falseIndex
                sources[falseIndex].completeTermination(terminated = false)
                withTimeout(TIMEOUT_MS) {
                    while (sources[pendingIndex].awaitTerminationCount.get() == 0) delay(1)
                }

                val lateSource = factory.createCallbackSource().apply {
                    completeTerminationOnClose = false
                    open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                }
                assertEquals(1, lateSource.cancelCount)
                assertTrue(lateSource.closeCodes.isEmpty())

                assertTrue(harness.actor.connect(harness.profile, null))
                val barrier = async {
                    runCatching {
                        harness.actor.disconnectAndDrain(
                            harness.profile.identity,
                            "multi-source-$falseIndex",
                        )
                    }
                }
                delay(25)
                assertFalse(falseIndex.toString(), barrier.isCompleted)
                assertEquals(falseIndex.toString(), 1, factory.requests.size)
                sources[pendingIndex].completeTermination()
                val result = withTimeout(TIMEOUT_MS) { barrier.await() }
                assertTrue(falseIndex.toString(), result.exceptionOrNull() is IllegalStateException)
                assertTrue(sources[0].awaitTerminationCount.get() > 0)
                assertTrue(sources[1].awaitTerminationCount.get() > 0)
                assertEquals(0, lateSource.awaitTerminationCount.get())
                assertEquals(falseIndex.toString(), 1, factory.requests.size)
            } finally {
                factory.transports.forEach { it.completeTermination() }
                harness.close()
            }
        }
    }

    @Test
    fun `shutdown invalidates provisional callbacks after factory return before commit`() =
        runBlocking {
            val commitEntered = CompletableDeferred<Unit>()
            val releaseCommit = CompletableDeferred<Unit>()
            val harness = Harness(
                beforeTransportCommit = {
                    commitEntered.complete(Unit)
                    releaseCommit.await()
                },
            )
            try {
                assertTrue(harness.actor.connect(harness.profile, null))
                withTimeout(TIMEOUT_MS) { commitEntered.await() }
                val transport = harness.awaitTransport(0)
                transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                assertEquals(RelayV2ConnectionPhase.STOPPED, harness.actor.state.value.phase)
                assertEquals(null, harness.actor.state.value.profileId)

                harness.actor.close()
                val barrier = async {
                    harness.actor.disconnectAndDrain(
                        harness.profile.identity,
                        "close-before-owner-commit",
                    )
                }
                delay(25)
                assertFalse(barrier.isCompleted)
                releaseCommit.complete(Unit)

                assertEquals(
                    "close-before-owner-commit",
                    withTimeout(TIMEOUT_MS) { barrier.await() }.barrierId,
                )
                assertEquals(RelayV2ConnectionPhase.CLOSED, harness.actor.state.value.phase)
                assertTrue(transport.closeCodes.isNotEmpty())
                assertTrue(transport.closeCodes.all { it == 1000 })
                assertTrue(withTimeout(TIMEOUT_MS) { harness.actor.effects.toList() }.isEmpty())
            } finally {
                releaseCommit.complete(Unit)
                harness.close()
            }
        }

    @Test
    fun `relay and host welcome watchdogs close timed out attempts with retryable 4408`() =
        runBlocking {
            val relayWatchdog = ManualWatchdog()
            val relayHarness = Harness(watchdogDelay = relayWatchdog::await)
            try {
                assertTrue(relayHarness.actor.connect(relayHarness.profile, null))
                val transport = relayHarness.awaitTransport(0)
                transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                relayHarness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
                relayWatchdog.fire(0)

                val failed = relayHarness.actor.awaitFailure(RelayV2FailureKind.TRANSPORT)
                assertEquals("HANDSHAKE_TIMEOUT", failed.failure?.code)
                assertTrue(failed.failure?.retryable == true)
                assertEquals(listOf(4408), transport.closeCodes)
            } finally {
                relayHarness.close()
            }

            val hostWatchdog = ManualWatchdog()
            val hostHarness = Harness(watchdogDelay = hostWatchdog::await)
            try {
                hostHarness.connectThroughRelayWelcome(null)
                hostWatchdog.fire(1)

                val failed = hostHarness.actor.awaitFailure(RelayV2FailureKind.TRANSPORT)
                assertEquals("HANDSHAKE_TIMEOUT", failed.failure?.code)
                assertTrue(failed.failure?.retryable == true)
                assertEquals(listOf(4408), hostHarness.transport().closeCodes)
            } finally {
                hostHarness.close()
            }

            val raceFactory = FakeTransportFactory()
            val firstWatchdog = CompletableDeferred<Unit>()
            val firstWatchdogEntered = CompletableDeferred<Unit>()
            val watchdogCalls = AtomicInteger()
            val raceHarness = Harness(
                factory = raceFactory,
                watchdogDelay = {
                    if (watchdogCalls.getAndIncrement() == 0) {
                        firstWatchdogEntered.complete(Unit)
                        firstWatchdog.await()
                    } else {
                        val transport = raceFactory.transports.single()
                        val hello = transport.awaitSentFrame()
                        transport.sendFixture(
                            "host-welcome-caught-up",
                            hello.stringValue("requestId"),
                        )
                    }
                },
            )
            try {
                assertTrue(
                    raceHarness.actor.connect(
                        raceHarness.profile,
                        RelayV2ResumeCursor(HOST_EPOCH, "91"),
                    ),
                )
                val transport = raceHarness.awaitTransport(0)
                transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                raceHarness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
                withTimeout(TIMEOUT_MS) { firstWatchdogEntered.await() }
                transport.sendFixture("relay-welcome")
                withTimeout(TIMEOUT_MS) { raceHarness.actor.effects.first() }
                raceHarness.actor.awaitPhase(RelayV2ConnectionPhase.QUERYING)

                transport.fail(
                    RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK),
                )
                val failed = raceHarness.actor.awaitFailure(RelayV2FailureKind.TRANSPORT)
                assertEquals("HOST_OFFLINE", failed.failure?.code)
            } finally {
                firstWatchdog.complete(Unit)
                raceHarness.close()
            }
        }

    @Test
    fun `handshake timeout shares terminal precedence and atomic claim ownership`() = runBlocking {
        val beforeClaim = CountDownLatch(1)
        val releaseBeforeClaim = CountDownLatch(1)
        val blockBeforeClaim = AtomicBoolean(true)
        val tlsWatchdog = ManualWatchdog()
        val tlsHarness = Harness(
            watchdogDelay = tlsWatchdog::await,
            beforeTerminalClaim = {
                if (blockBeforeClaim.compareAndSet(true, false)) {
                    beforeClaim.countDown()
                    check(releaseBeforeClaim.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                }
            },
        )
        try {
            assertTrue(tlsHarness.actor.connect(tlsHarness.profile, null))
            val transport = tlsHarness.awaitTransport(0)
            transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            tlsHarness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            tlsWatchdog.fire(0)
            assertTrue(beforeClaim.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            transport.fail(RelayV2TransportFailure(RelayV2TransportFailureKind.TLS_VALIDATION))
            releaseBeforeClaim.countDown()

            val failure = tlsHarness.actor.awaitFailure(RelayV2FailureKind.SECURITY).failure
            assertEquals("TLS_VALIDATION_FAILED", failure?.code)
            assertFalse(requireNotNull(failure).retryable)
            assertEquals(1, transport.cancelCount)
        } finally {
            releaseBeforeClaim.countDown()
            tlsHarness.close()
        }

        val claimEntered = CountDownLatch(1)
        val releaseClaim = CountDownLatch(1)
        val callbackAdmitted = CountDownLatch(1)
        val observeAdmission = AtomicBoolean(false)
        val mismatchWatchdog = ManualWatchdog()
        val mismatchHarness = Harness(
            watchdogDelay = mismatchWatchdog::await,
            betweenTerminalCauseReadAndOwnerRevoke = {
                claimEntered.countDown()
                check(releaseClaim.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            },
            afterCallbackAdmission = {
                if (observeAdmission.get()) callbackAdmitted.countDown()
            },
        )
        try {
            assertTrue(mismatchHarness.actor.connect(mismatchHarness.profile, null))
            val committed = mismatchHarness.awaitTransport(0)
            committed.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            mismatchHarness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            mismatchWatchdog.fire(0)
            assertTrue(claimEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))

            val mismatched = mismatchHarness.factory.createCallbackSource()
            observeAdmission.set(true)
            val callback = async(Dispatchers.Default) {
                mismatched.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            }
            assertTrue(callbackAdmitted.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            releaseClaim.countDown()
            withTimeout(TIMEOUT_MS) { callback.await() }

            val failure = mismatchHarness.actor.awaitFailure(RelayV2FailureKind.TRANSPORT).failure
            assertEquals("HANDSHAKE_TIMEOUT", failure?.code)
            assertTrue(requireNotNull(failure).retryable)
            assertEquals(listOf(4408), committed.closeCodes)
            assertEquals(listOf(1000), mismatched.closeCodes)
        } finally {
            releaseClaim.countDown()
            mismatchHarness.factory.transports.forEach { it.completeTermination() }
            mismatchHarness.close()
        }
    }

    @Test
    fun `disconnect seals admitted callback before final empty fence observation`() = runBlocking {
        val callbackEntered = CountDownLatch(1)
        val releaseCallback = CountDownLatch(1)
        val blockCallback = AtomicBoolean(false)
        val harness = Harness(
            afterCallbackAdmission = {
                if (blockCallback.get()) {
                    callbackEntered.countDown()
                    check(releaseCallback.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                }
            },
        )
        try {
            assertTrue(harness.actor.connect(harness.profile, null))
            val committed = harness.awaitTransport(0)
            committed.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)

            val lateSource = harness.factory.createCallbackSource().apply {
                completeTerminationOnClose = false
            }
            blockCallback.set(true)
            val callback = async(Dispatchers.Default) {
                lateSource.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            }
            assertTrue(callbackEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            val receipt = async {
                harness.actor.disconnectAndDrain(
                    harness.profile.identity,
                    "callback-admission-seal",
                )
            }
            withTimeout(TIMEOUT_MS) {
                while (committed.awaitTerminationCount.get() == 0) delay(1)
            }
            delay(25)
            assertFalse(receipt.isCompleted)

            releaseCallback.countDown()
            withTimeout(TIMEOUT_MS) { callback.await() }
            withTimeout(TIMEOUT_MS) {
                while (lateSource.awaitTerminationCount.get() == 0) delay(1)
            }
            delay(25)
            assertFalse(receipt.isCompleted)
            lateSource.completeTermination()
            assertEquals(
                "callback-admission-seal",
                withTimeout(TIMEOUT_MS) { receipt.await() }.barrierId,
            )
            assertEquals(listOf(1000), committed.closeCodes)
            assertEquals(listOf(1000), lateSource.closeCodes)
        } finally {
            releaseCallback.countDown()
            harness.factory.transports.forEach { it.completeTermination() }
            harness.close()
        }
    }

    @Test
    fun `bounded action and event queues fail closed on saturation`() = runBlocking {
        val blockingFactory = FakeTransportFactory(blockFirstOpen = true)
        val actionHarness = Harness(
            factory = blockingFactory,
            normalActionCapacity = 1,
            reservedActionCapacity = 1,
            eventCapacity = 4,
        )
        try {
            assertTrue(actionHarness.actor.connect(actionHarness.profile, null))
            assertTrue(blockingFactory.openEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            assertTrue(actionHarness.actor.connect(actionHarness.profile, null))
            assertFalse(actionHarness.actor.connect(actionHarness.profile, null))
            blockingFactory.releaseOpen.countDown()

            val replacementTransport = actionHarness.awaitTransport(1)
            replacementTransport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            val current = actionHarness.actor.awaitPhase(
                RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME,
            )
            assertEquals(2L, current.connectionGeneration)
            assertEquals(2, blockingFactory.requests.size)
            assertFalse(replacementTransport.closeCodes.contains(1013))
        } finally {
            blockingFactory.releaseOpen.countDown()
            actionHarness.close()
        }

        val eventHarness = Harness(eventCapacity = 1)
        try {
            val firstHello = eventHarness.connectThroughRelayWelcome(
                RelayV2ResumeCursor(HOST_EPOCH, "91"),
            )
            eventHarness.transport().sendFixture(
                "host-welcome-caught-up",
                requestId = firstHello.stringValue("requestId"),
            )
            eventHarness.actor.awaitPhase(RelayV2ConnectionPhase.QUERYING)

            assertTrue(
                eventHarness.actor.connect(
                    eventHarness.profile,
                    RelayV2ResumeCursor(HOST_EPOCH, "91"),
                ),
            )
            val second = eventHarness.awaitTransport(1)
            second.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            eventHarness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            second.sendFixture("relay-welcome")
            val secondHello = second.awaitSentFrame()
            second.sendFixture(
                "host-welcome-caught-up",
                requestId = secondHello.stringValue("requestId"),
            )

            val failed = eventHarness.actor.awaitFailure(RelayV2FailureKind.QUEUE_SATURATED)
            assertEquals("SLOW_CONSUMER", failed.failure?.code)
            assertEquals(listOf(1013), second.closeCodes)
            assertEquals(0, second.cancelCount)
        } finally {
            eventHarness.close()
        }

        val actionByteHarness = Harness(actionByteCapacity = 64)
        try {
            assertTrue(actionByteHarness.actor.connect(actionByteHarness.profile, null))
            val transport = actionByteHarness.awaitTransport(0)
            transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            actionByteHarness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            transport.sendFixture("relay-welcome")

            val failed = actionByteHarness.actor.awaitFailure(RelayV2FailureKind.QUEUE_SATURATED)
            assertEquals("SLOW_CONSUMER", failed.failure?.code)
            assertEquals(listOf(1013), transport.closeCodes)
            assertEquals(0, transport.cancelCount)
        } finally {
            actionByteHarness.close()
        }

        val effectByteHarness = Harness(effectByteCapacity = 64)
        try {
            val hello = effectByteHarness.connectThroughRelayWelcome(null)
            effectByteHarness.transport().sendFixture(
                "host-welcome-snapshot-required",
                hello.stringValue("requestId"),
            )

            val failed = effectByteHarness.actor.awaitFailure(RelayV2FailureKind.QUEUE_SATURATED)
            assertEquals("SLOW_CONSUMER", failed.failure?.code)
            assertEquals(listOf(1013), effectByteHarness.transport().closeCodes)
            assertEquals(0, effectByteHarness.transport().cancelCount)
        } finally {
            effectByteHarness.close()
        }
    }

    @Test
    fun `termination callbacks coalesce without starving a disconnect barrier`() = runBlocking {
        val factory = FakeTransportFactory(blockFirstSend = true)
        val harness = Harness(
            factory = factory,
            normalActionCapacity = 1,
            reservedActionCapacity = 1,
        )
        try {
            assertTrue(harness.actor.connect(harness.profile, null))
            val transport = harness.awaitTransport(0)
            transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            transport.sendFixture("relay-welcome")
            assertTrue(factory.sendEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))

            transport.sendFixture("relay-welcome")
            transport.closed(1006)
            repeat(16) {
                transport.fail(RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK))
                transport.closed(4400)
            }
            val barrier = async {
                harness.actor.disconnectAndDrain(harness.profile.identity, "reserved-saturation")
            }
            delay(25)
            assertFalse(barrier.isCompleted)

            factory.releaseSend.countDown()
            assertEquals("reserved-saturation", withTimeout(TIMEOUT_MS) { barrier.await() }.barrierId)
            assertEquals(
                RelayV2ConnectionPhase.DISCONNECTED,
                harness.actor.awaitPhase(RelayV2ConnectionPhase.DISCONNECTED).phase,
            )
        } finally {
            factory.releaseSend.countDown()
            harness.close()
        }
    }

    @Test
    fun `protocol close 4400 fails closed without retry or fallback`() = runBlocking {
        val harness = Harness()
        try {
            assertTrue(harness.actor.connect(harness.profile, null))
            val transport = harness.awaitTransport(0)
            transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            transport.closed(4400)

            val failed = harness.actor.awaitFailure(RelayV2FailureKind.SCHEMA)
            assertEquals("INVALID_ENVELOPE", failed.failure?.code)
            assertFalse(requireNotNull(failed.failure).retryable)
            delay(25)
            assertEquals(1, harness.factory.requests.size)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `wrong host relay unavailable is a schema violation instead of a trusted route failure`() =
        runBlocking {
            val harness = Harness()
            try {
                assertTrue(harness.actor.connect(harness.profile, null))
                val transport = harness.awaitTransport(0)
                transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
                val unavailable = fixture("relay-unavailable-host-offline")
                unavailable["hostId"] = "different-host"
                transport.sendFrame(unavailable)

                val failed = harness.actor.awaitFailure(RelayV2FailureKind.SCHEMA)
                assertEquals("INVALID_ENVELOPE", failed.failure?.code)
                assertFalse(requireNotNull(failed.failure).retryable)
                assertEquals(listOf(4400), transport.closeCodes)
                delay(25)
                assertEquals(1, harness.factory.requests.size)
            } finally {
                harness.close()
            }
        }

    @Test
    fun `post-handshake direction and phase allowlists protocol-close invalid inbound frames`() =
        runBlocking {
            val scopedHarness = Harness()
            try {
                val hello = scopedHarness.connectThroughRelayWelcome(
                    RelayV2ResumeCursor(HOST_EPOCH, "91"),
                )
                scopedHarness.transport().sendFixture(
                    "host-welcome-caught-up",
                    hello.stringValue("requestId"),
                )
                val handshake = withTimeout(TIMEOUT_MS) { scopedHarness.actor.effects.first() }
                    as RelayV2RuntimeEffect.QueryPendingCommands
                scopedHarness.transport().sendFixture("host-presence-online")
                val delivered = withTimeout(TIMEOUT_MS) { scopedHarness.actor.effects.first() }
                    as RelayV2RuntimeEffect.DeliverPostHandshakeFrame
                assertEquals(handshake.generation, delivered.generation)
                assertTrue(scopedHarness.actor.state.value.matchesGeneration(delivered.generation))
            } finally {
                scopedHarness.close()
            }

            val resyncHarness = Harness()
            try {
                val hello = resyncHarness.connectThroughRelayWelcome(null)
                resyncHarness.transport().sendFixture(
                    "host-welcome-snapshot-required",
                    hello.stringValue("requestId"),
                )
                val handshake = withTimeout(TIMEOUT_MS) { resyncHarness.actor.effects.first() }
                    as RelayV2RuntimeEffect.BeginStateResync
                resyncHarness.transport().sendFixture("state-snapshot-chunk")
                val delivered = withTimeout(TIMEOUT_MS) { resyncHarness.actor.effects.first() }
                    as RelayV2RuntimeEffect.DeliverPostHandshakeFrame
                assertEquals(handshake.generation, delivered.generation)
                assertTrue(resyncHarness.actor.state.value.matchesGeneration(delivered.generation))
            } finally {
                resyncHarness.close()
            }

            val scenarios = listOf(
                "client-to-host command" to "command-execute-create-worktree",
                "querying snapshot chunk" to "state-snapshot-chunk",
                "duplicate welcome" to "host-welcome-caught-up",
            )
            scenarios.forEach { (name, fixtureName) ->
                val harness = Harness()
                try {
                    val hello = harness.connectThroughRelayWelcome(
                        RelayV2ResumeCursor(HOST_EPOCH, "91"),
                    )
                    harness.transport().sendFixture(
                        "host-welcome-caught-up",
                        hello.stringValue("requestId"),
                    )
                    val handshakeEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                        as RelayV2RuntimeEffect.QueryPendingCommands
                    assertTrue(
                        harness.actor.state.value.matchesGeneration(handshakeEffect.generation),
                    )

                    val invalid = fixture(fixtureName)
                    if (fixtureName == "host-welcome-caught-up") {
                        invalid["requestId"] = hello.stringValue("requestId")
                    }
                    harness.transport().sendFrame(invalid)

                    val failed = harness.actor.awaitFailure(RelayV2FailureKind.SCHEMA)
                    assertEquals(name, "INVALID_ENVELOPE", failed.failure?.code)
                    assertFalse(name, requireNotNull(failed.failure).retryable)
                    assertEquals(name, 4400, harness.transport().closeCodes.single())
                } finally {
                    harness.close()
                }
            }
        }

    @Test
    fun `auth schema dialect and capability failures terminate v2 without fallback`() = runBlocking {
        val scenarios = listOf(
            FailureScenario("auth", RelayV2FailureKind.AUTH) { harness, transport ->
                transport.fail(
                    RelayV2TransportFailure(
                        RelayV2TransportFailureKind.UPGRADE,
                        httpStatus = 401,
                    ),
                )
            },
            FailureScenario("schema", RelayV2FailureKind.SCHEMA) { harness, transport ->
                transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
                transport.sendRaw("{}".toByteArray())
            },
            FailureScenario("dialect", RelayV2FailureKind.DIALECT) { _, transport ->
                transport.open("tw-relay.v1")
            },
            FailureScenario("capability", RelayV2FailureKind.CAPABILITY) { harness, transport ->
                transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
                val welcome = fixture("relay-welcome")
                val payload = welcome.payload()
                payload["capabilities"] = RelayV2ConnectionActor.REQUIRED_CAPABILITIES.dropLast(1)
                transport.sendFrame(welcome)
            },
            FailureScenario(
                "host capability intersection",
                RelayV2FailureKind.CAPABILITY,
            ) { harness, transport ->
                transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
                transport.sendFixture("relay-welcome")
                val hello = transport.awaitSentFrame()
                val welcome = fixture("host-welcome-snapshot-required")
                welcome["requestId"] = hello.stringValue("requestId")
                welcome.payload()["capabilities"] =
                    RelayV2ConnectionActor.REQUIRED_CAPABILITIES.dropLast(1)
                transport.sendFrame(welcome)
            },
            FailureScenario("zero broker limit", RelayV2FailureKind.CAPABILITY) { harness, transport ->
                transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
                val welcome = fixture("relay-welcome")
                welcome.payload().mutableObject("limits")["maxQueuedRouteFrames"] = 0L
                transport.sendFrame(welcome)
            },
            FailureScenario("broker limit above frozen bound", RelayV2FailureKind.CAPABILITY) {
                    harness, transport ->
                transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
                val welcome = fixture("relay-welcome")
                welcome.payload().mutableObject("limits")["maxFrameBytes"] = 1_048_577L
                transport.sendFrame(welcome)
            },
            FailureScenario("contradictory host watermarks", RelayV2FailureKind.CAPABILITY) {
                    harness, transport ->
                transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
                transport.sendFixture("relay-welcome")
                val hello = transport.awaitSentFrame()
                val welcome = fixture("host-welcome-snapshot-required")
                welcome["requestId"] = hello.stringValue("requestId")
                welcome.payload().mutableObject("limits")[
                    "brokerRouteLowWaterBytesPerDirection"
                ] = 1_048_576L
                transport.sendFrame(welcome)
            },
        )

        scenarios.forEach { scenario ->
            val harness = Harness()
            try {
                assertTrue(harness.actor.connect(harness.profile, null))
                val transport = harness.awaitTransport(0)
                scenario.trigger(harness, transport)
                val failed = harness.actor.awaitFailure(scenario.expectedKind)

                assertEquals(scenario.name, scenario.expectedKind, failed.failure?.kind)
                assertEquals(scenario.name, 1, harness.factory.requests.size)
                assertEquals(
                    scenario.name,
                    listOf(RelayV2Profile.RELAY_V2_SUBPROTOCOL),
                    harness.factory.requests.single().offeredSubprotocols,
                )
                assertEquals(
                    scenario.name,
                    RelayV2Profile.RELAY_V2_SUBPROTOCOL,
                    harness.profile.offeredSubprotocol,
                )
                delay(25)
                assertEquals(scenario.name, 1, harness.factory.requests.size)
            } finally {
                harness.close()
            }
        }
    }

    @Test
    fun `legacy upgrade 101 classification is non retryable invalid envelope`() = runBlocking {
        val harness = Harness()
        try {
            assertTrue(harness.actor.connect(harness.profile, null))
            val transport = harness.awaitTransport(0)
            transport.fail(
                RelayV2TransportFailure(
                    RelayV2TransportFailureKind.UPGRADE,
                    httpStatus = 101,
                ),
            )

            val failed = harness.actor.awaitFailure(RelayV2FailureKind.SCHEMA)
            assertEquals("INVALID_ENVELOPE", failed.failure?.code)
            assertFalse(requireNotNull(failed.failure).retryable)
            assertEquals(1, transport.cancelCount)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `TLS validation failure is non retryable security failure`() = runBlocking {
        val harness = Harness()
        try {
            assertTrue(harness.actor.connect(harness.profile, null))
            val transport = harness.awaitTransport(0)
            transport.fail(RelayV2TransportFailure(RelayV2TransportFailureKind.TLS_VALIDATION))

            val failed = harness.actor.awaitFailure(RelayV2FailureKind.SECURITY)
            assertEquals("TLS_VALIDATION_FAILED", failed.failure?.code)
            assertFalse(requireNotNull(failed.failure).retryable)
            assertEquals(1, transport.cancelCount)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `malformed persisted access token is typed redacted and recoverable`() = runBlocking {
        val invalidTokens = listOf(
            "twcap2.contains space",
            "twcap2.contains\rcontrol",
            "twcap2.${"x".repeat(8_192)}",
        )
        invalidTokens.forEach { token ->
            val harness = Harness()
            try {
                harness.servePersistedAccessToken(token)
                assertTrue(harness.actor.connect(harness.profile, null))

                val failed = harness.actor.awaitFailure(RelayV2FailureKind.AUTH)
                val effect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.ConnectionFailed
                assertEquals("AUTH_INVALID", failed.failure?.code)
                assertFalse(requireNotNull(failed.failure).retryable)
                assertTrue(harness.factory.requests.isEmpty())
                assertFalse("$failed $effect".contains("twcap2."))

                harness.servePersistedAccessToken(null)
                harness.actor.disconnectAndDrain(harness.profile.identity, "credential-recovery")
                val recovered = harness.profile.copy(activationGeneration = 2)
                assertTrue(harness.actor.connect(recovered, null))
                harness.awaitTransport(0)
                assertEquals(1, harness.factory.requests.size)
            } finally {
                harness.close()
            }
        }
    }

    private inner class Harness(
        val factory: FakeTransportFactory = FakeTransportFactory(),
        normalActionCapacity: Int = RelayV2ConnectionActor.DEFAULT_ACTION_CAPACITY,
        reservedActionCapacity: Int = RelayV2ConnectionActor.DEFAULT_RESERVED_ACTION_CAPACITY,
        eventCapacity: Int = RelayV2ConnectionActor.DEFAULT_EVENT_CAPACITY,
        actionByteCapacity: Long = RelayV2ConnectionActor.DEFAULT_ACTION_BYTE_CAPACITY,
        effectByteCapacity: Long = RelayV2ConnectionActor.DEFAULT_EFFECT_BYTE_CAPACITY,
        watchdogDelay: suspend (Long) -> Unit = { delay(it) },
        beforeTransportCommit: suspend () -> Unit = {},
        beforeTerminalClaim: () -> Unit = {},
        betweenTerminalCauseReadAndOwnerRevoke: () -> Unit = {},
        afterCallbackAdmission: (RelayV2Transport) -> Unit = {},
        afterDisconnectOwnerSeal: () -> Unit = {},
    ) {
        private val parent = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        private val credentials = MemoryCredentialStore()
        val profile = installProfile("primary", activationGeneration = 1)
        val actor = RelayV2ConnectionActor(
            parentScope = parent,
            transportFactory = factory,
            credentialStore = credentials,
            codec = codec,
            clock = { NOW_MS },
            watchdogDelay = watchdogDelay,
            beforeTransportCommit = beforeTransportCommit,
            beforeTerminalClaim = beforeTerminalClaim,
            betweenTerminalCauseReadAndOwnerRevoke =
                betweenTerminalCauseReadAndOwnerRevoke,
            afterCallbackAdmission = afterCallbackAdmission,
            afterDisconnectOwnerSeal = afterDisconnectOwnerSeal,
            normalActionCapacity = normalActionCapacity,
            reservedActionCapacity = reservedActionCapacity,
            eventCapacity = eventCapacity,
            actionByteCapacity = actionByteCapacity,
            effectByteCapacity = effectByteCapacity,
        )

        fun installProfile(suffix: String, activationGeneration: Long): RelayV2Profile {
            val reference = RelayV2CredentialReference("credential-$suffix")
            val profile = RelayV2Profile(
                profileId = "profile-$suffix",
                issuerUrl = "https://relay.example.com",
                relayUrl = "wss://relay.example.com/client",
                hostId = HOST_ID,
                principalId = PRINCIPAL_ID,
                grantId = "grant-$suffix",
                clientInstanceId = "android-install-$suffix",
                credentialReference = reference,
                credentialVersion = 1,
                activationGeneration = activationGeneration,
            )
            check(
                credentials.create(
                    reference,
                    RelayV2CredentialBlob(
                        credentialVersion = 1,
                        issuerUrl = profile.issuerUrl,
                        relayUrl = profile.relayUrl,
                        hostId = profile.hostId,
                        clientInstanceId = profile.clientInstanceId,
                        principalId = profile.principalId,
                        grantId = profile.grantId,
                        accessToken = "twcap2.access-$suffix",
                        accessExpiresAtMs = NOW_MS + 60_000,
                        refreshToken = "twref2.refresh-$suffix",
                        refreshExpiresAtMs = NOW_MS + 120_000,
                    ),
                ),
            )
            return profile
        }

        suspend fun connectThroughRelayWelcome(
            resume: RelayV2ResumeCursor?,
        ): MutableMap<String, Any?> {
            assertTrue(actor.connect(profile, resume))
            val transport = awaitTransport(0)
            transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            transport.sendFixture("relay-welcome")
            val hello = transport.awaitSentFrame()
            actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_HOST_WELCOME)
            return hello
        }

        suspend fun awaitTransport(index: Int): FakeTransport = withTimeout(TIMEOUT_MS) {
            while (factory.transports.size <= index) delay(1)
            factory.transports[index]
        }

        fun transport(): FakeTransport = factory.transports.last()

        fun credentialReadCount(): Int = credentials.readCount.get()

        fun servePersistedAccessToken(accessToken: String?) {
            credentials.readTransform = accessToken?.let { candidate ->
                { blob -> blob.copy(accessToken = candidate) }
            }
        }

        fun close() {
            actor.close()
            parent.cancel()
        }
    }

    private inner class FakeTransportFactory(
        private val blockFirstOpen: Boolean = false,
        private val blockFirstSend: Boolean = false,
    ) : RelayV2TransportFactory {
        val requests = CopyOnWriteArrayList<RelayV2TransportOpenRequest>()
        val transports = CopyOnWriteArrayList<FakeTransport>()
        private val listeners = CopyOnWriteArrayList<RelayV2TransportListener>()
        val openEntered = CountDownLatch(if (blockFirstOpen) 1 else 0)
        val releaseOpen = CountDownLatch(if (blockFirstOpen) 1 else 0)
        val sendEntered = CountDownLatch(if (blockFirstSend) 1 else 0)
        val releaseSend = CountDownLatch(if (blockFirstSend) 1 else 0)
        var onTransportCreated: ((FakeTransport) -> Unit)? = null
        var failureAfterCreate: Throwable? = null
        var returnDifferentSource: Boolean = false

        override fun open(
            request: RelayV2TransportOpenRequest,
            listener: RelayV2TransportListener,
        ): RelayV2Transport {
            requests += request
            listeners += listener
            if (blockFirstOpen && requests.size == 1) {
                openEntered.countDown()
                check(releaseOpen.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            }
            val transport = FakeTransport(
                listener,
                blockFirstSend && transports.isEmpty(),
                sendEntered,
                releaseSend,
            ).also(transports::add)
            val returnedTransport = if (returnDifferentSource) {
                FakeTransport(listener).also(transports::add)
            } else {
                transport
            }
            onTransportCreated?.invoke(transport)
            failureAfterCreate?.let { throw it }
            return returnedTransport
        }

        fun createCallbackSource(attemptIndex: Int = 0): FakeTransport =
            FakeTransport(listeners[attemptIndex]).also(transports::add)
    }

    private inner class FakeTransport(
        private val listener: RelayV2TransportListener,
        private val blockFirstSend: Boolean = false,
        private val sendEntered: CountDownLatch = CountDownLatch(0),
        private val releaseSend: CountDownLatch = CountDownLatch(0),
    ) : RelayV2Transport {
        val sent = CopyOnWriteArrayList<ByteArray>()
        val closeCodes = CopyOnWriteArrayList<Int>()
        val awaitTerminationCount = AtomicInteger()
        @Volatile
        var cancelCount: Int = 0
            private set
        private var sendCount = 0
        private val termination = CompletableDeferred<Boolean>()

        @Volatile
        var completeTerminationOnClose: Boolean = true

        @Volatile
        var completeTerminationOnCancel: Boolean = true

        @Volatile
        var synchronousClosedOnClose: Boolean = false

        @Volatile
        var throwOnSecondClose: Boolean = false

        override fun send(bytes: ByteArray): Boolean {
            if (blockFirstSend && sendCount++ == 0) {
                sendEntered.countDown()
                check(releaseSend.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            }
            sent += bytes.copyOf()
            return true
        }

        override fun close(code: Int, reason: String) {
            closeCodes += code
            if (throwOnSecondClose && closeCodes.size > 1) {
                error("transport close called more than once")
            }
            if (synchronousClosedOnClose) listener.onClosed(this, code)
            if (completeTerminationOnClose) termination.complete(true)
        }

        override fun cancel() {
            cancelCount += 1
            if (completeTerminationOnCancel) termination.complete(true)
        }

        override suspend fun awaitTermination(): Boolean {
            awaitTerminationCount.incrementAndGet()
            return termination.await()
        }

        fun completeTermination(terminated: Boolean = true) {
            termination.complete(terminated)
        }

        fun open(selectedSubprotocol: String?) = listener.onOpen(this, selectedSubprotocol)

        fun sendFixture(name: String, requestId: String? = null) {
            val frame = fixture(name)
            if (requestId != null) frame["requestId"] = requestId
            sendFrame(frame)
        }

        fun sendFrame(frame: Map<String, Any?>) {
            sendRaw(codec.encodeWebSocketFrame(RelayV2WebSocketChannel.PUBLIC, frame))
        }

        fun sendRaw(bytes: ByteArray) {
            listener.onFrame(this, bytes, RelayV2FrameMetadata())
        }

        fun fail(failure: RelayV2TransportFailure) {
            termination.complete(true)
            listener.onFailure(this, failure)
        }

        fun closed(code: Int) {
            termination.complete(true)
            listener.onClosed(this, code)
        }

        suspend fun awaitSentFrame(index: Int = 0): MutableMap<String, Any?> =
            withTimeout(TIMEOUT_MS) {
                while (sent.size <= index) delay(1)
                deepClone(
                    codec.decodeWebSocketFrame(
                        RelayV2WebSocketChannel.PUBLIC,
                        sent[index],
                    ).frame,
                )
            }
    }

    private class MemoryCredentialStore : RelayV2CredentialStore {
        private val values = linkedMapOf<RelayV2CredentialReference, RelayV2CredentialBlob>()
        val readCount = AtomicInteger()
        var readTransform: ((RelayV2CredentialBlob) -> RelayV2CredentialBlob)? = null

        override fun read(reference: RelayV2CredentialReference): RelayV2CredentialBlob? =
            synchronized(values) {
                readCount.incrementAndGet()
                values[reference]?.let { readTransform?.invoke(it) ?: it }
            }

        override fun create(
            reference: RelayV2CredentialReference,
            blob: RelayV2CredentialBlob,
        ): Boolean = synchronized(values) {
            if (values.containsKey(reference)) return@synchronized false
            values[reference] = blob
            true
        }

        override fun compareAndSet(
            reference: RelayV2CredentialReference,
            expectation: RelayV2CredentialCasExpectation,
            replacement: RelayV2CredentialBlob,
        ): RelayV2CredentialCasResult = error("Credential mutation is outside actor tests")

        override fun clear(reference: RelayV2CredentialReference) {
            synchronized(values) { values.remove(reference) }
        }
    }

    private class ManualWatchdog {
        private val waits = CopyOnWriteArrayList<CompletableDeferred<Unit>>()

        suspend fun await(@Suppress("UNUSED_PARAMETER") timeoutMs: Long) {
            val completion = CompletableDeferred<Unit>()
            waits += completion
            completion.await()
        }

        suspend fun fire(index: Int) = withTimeout(TIMEOUT_MS) {
            while (waits.size <= index) delay(1)
            waits[index].complete(Unit)
        }
    }

    private fun fixture(name: String): MutableMap<String, Any?> = deepClone(
        fixtures.golden.single { it.name == name }.frame,
    )

    private fun RelayV2RuntimeEffect.helloOutcome(): RelayV2HelloOutcome = when (this) {
        is RelayV2RuntimeEffect.QueryPendingCommands -> outcome
        is RelayV2RuntimeEffect.BeginStateResync -> outcome
        is RelayV2RuntimeEffect.RejectContinuity -> outcome
        else -> error("Effect is not a hello outcome: $this")
    }

    private fun assertNegotiatedHello(context: RelayV2HandshakeContext) {
        assertEquals(RelayV2ConnectionActor.REQUIRED_CAPABILITIES.toSet(), context.negotiatedCapabilities)
        assertEquals(1_048_576L, context.negotiatedLimits.maxPublicFrameBytes)
        assertEquals(524_288L, context.negotiatedLimits.routeLowWaterBytesPerDirection)
        assertEquals(32L, context.negotiatedLimits.maxCommandQueryIds)
        assertEquals(65_536L, context.negotiatedLimits.terminalMaxFrameBytes)
        assertEquals(
            604_800_000L,
            context.negotiatedLimits.frozenHostLimits.getValue("commandDedupeRetentionMs"),
        )
    }

    private suspend fun RelayV2ConnectionActor.awaitPhase(
        phase: RelayV2ConnectionPhase,
    ): RelayV2ConnectionState = withTimeout(TIMEOUT_MS) {
        state.first { it.phase == phase }
    }

    private suspend fun RelayV2ConnectionActor.awaitFailure(
        kind: RelayV2FailureKind,
    ): RelayV2ConnectionState = withTimeout(TIMEOUT_MS) {
        state.first { it.phase == RelayV2ConnectionPhase.FAILED && it.failure?.kind == kind }
    }

    private data class HelloScenario(
        val name: String,
        val resume: RelayV2ResumeCursor?,
        val responseFixture: String,
        val expectedOutcome: RelayV2HelloOutcome,
        val expectedPhase: RelayV2ConnectionPhase,
    )

    private data class FailureScenario(
        val name: String,
        val expectedKind: RelayV2FailureKind,
        val trigger: suspend (Harness, FakeTransport) -> Unit,
    )

    private enum class MismatchTiming {
        BEFORE_FACTORY_RETURN,
        BEFORE_COMMIT,
        AFTER_COMMIT,
    }

    private companion object {
        const val TIMEOUT_MS = 5_000L
        const val NOW_MS = 1_000_000L
        const val HOST_ID = "mac-admin"
        const val PRINCIPAL_ID = "principal-opaque-id"
        const val HOST_EPOCH = "authority-uuid"
    }
}

@Suppress("UNCHECKED_CAST")
private fun deepClone(source: Map<String, Any?>): MutableMap<String, Any?> =
    linkedMapOf<String, Any?>().apply {
        source.forEach { (key, value) ->
            put(
                key,
                when (value) {
                    is Map<*, *> -> deepClone(value as Map<String, Any?>)
                    is List<*> -> value.map { item ->
                        if (item is Map<*, *>) deepClone(item as Map<String, Any?>) else item
                    }.toMutableList()
                    else -> value
                },
            )
        }
    }

@Suppress("UNCHECKED_CAST")
private fun MutableMap<String, Any?>.payload(): MutableMap<String, Any?> =
    getValue("payload") as MutableMap<String, Any?>

@Suppress("UNCHECKED_CAST")
private fun MutableMap<String, Any?>.mutableObject(name: String): MutableMap<String, Any?> =
    getValue(name) as MutableMap<String, Any?>

private fun Map<String, Any?>.stringValue(name: String): String = getValue(name) as String

private fun Map<String, Any?>.stringList(name: String): List<String> =
    (getValue(name) as List<*>).map { it as String }
