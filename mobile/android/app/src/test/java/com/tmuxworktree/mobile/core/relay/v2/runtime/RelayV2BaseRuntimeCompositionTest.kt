package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2ContractFixtures
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2FrameMetadata
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2WebSocketChannel
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAcceptanceEvidence
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAction
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxArguments
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAuthorityCore
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxDraft
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEffect
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxLimits
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxResult
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxState
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialBlob
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialCasExpectation
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialCasResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialReference
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialStore
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AppliedCursor
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxBatchResult
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxFreshDispatchResult
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxRuntimeAuthority
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ResyncReason
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SnapshotChunk
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SnapshotReleaseCompletion
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SnapshotReleaseObligation
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateConnectIdentity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateConnectPlan
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateConnectRecovery
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateEvent
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateHello
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateNamespace
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateSyncAuthority
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateSyncResult
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2BaseRuntimeCompositionTest {
    private val codec = RelayV2Codec()
    private val fixtures = RelayV2ContractFixtures()

    @Test
    fun `admitted auto-connect profile offers only v2 and applies base state before online`() =
        runBlocking {
            val harness = Harness(autoConnect = true)
            try {
                val hello = harness.connectOnline()

                assertEquals(
                    listOf(RelayV2Profile.RELAY_V2_SUBPROTOCOL),
                    harness.factory.requests.single().offeredSubprotocols,
                )
                assertEquals(
                    RelayV2ConnectionActor.REQUIRED_CAPABILITIES,
                    hello.payload().stringList("capabilities"),
                )
                assertEquals(
                    RelayV2ConnectionActor.REQUIRED_CAPABILITIES,
                    hello.payload().stringList("requiredCapabilities"),
                )
                assertEquals(1, harness.authority.helloCommits.get())

                harness.transport().sendFixture("sessions-changed-upsert")
                withTimeout(TIMEOUT_MS) {
                    while (harness.authority.stateEventCommits.get() != 1) delay(1)
                }
                assertEquals(RelayV2BaseRuntimePhase.ONLINE, harness.composition.state.value.phase)
            } finally {
                harness.close()
            }
        }

    @Test
    fun `auto-connect false remains stopped without opening a socket`() = runBlocking {
        val harness = Harness(autoConnect = false)
        try {
            assertEquals(
                null,
                withTimeoutOrNull(200) {
                    while (harness.factory.requests.isEmpty()) delay(1)
                    harness.factory.requests.single()
                },
            )
            assertEquals(0, harness.authority.outboxReads.get())
            assertEquals(RelayV2BaseRuntimePhase.STOPPED, harness.composition.state.value.phase)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `an unowned effect still fails closed`() = runBlocking {
        val unowned = Harness(autoConnect = true)
        try {
            unowned.connectOnline()
            unowned.transport().sendFixture("host-presence-online")
            val failed = unowned.awaitPhase(RelayV2BaseRuntimePhase.FAILED)
            assertEquals(
                RelayV2BaseRuntimeFailure.RuntimeIncomplete("UNOWNED_EFFECT_host.presence"),
                failed.failure,
            )
        } finally {
            unowned.close()
        }
    }

    @Test
    fun `query commits before send and empty status effects finish recovery`() = runBlocking {
        val harness = Harness(
            autoConnect = true,
            outbox = sendingOutbox("command-b", "command-a"),
        )
        try {
            harness.authority.blockQueryCommit = true
            val transport = harness.openThroughHostWelcome()
            withTimeout(TIMEOUT_MS) { harness.authority.queryCommitEntered.await() }
            assertEquals(1, transport.sendCount())
            assertEquals(0, harness.authority.queryCommits.get())

            harness.authority.releaseQueryCommit.complete(Unit)
            val query = transport.awaitSentType("command.query")
            assertEquals(1, harness.authority.queryCommits.get())
            assertEquals(1, transport.framesOfType("command.query").size)
            assertEquals(
                listOf("command-b", "command-a"),
                query.payload().objectList("items").map { it.stringValue("commandId") },
            )
            transport.sendCommandStatuses(query, StatusMode.ACCEPTED)

            harness.awaitPhase(RelayV2BaseRuntimePhase.ONLINE)
            assertEquals(1, harness.authority.statusCommits.get())
            transport.sendCommandResult("command-b")
            withTimeout(TIMEOUT_MS) {
                while (harness.authority.statusCommits.get() != 2) delay(1)
            }
            assertEquals(RelayV2BaseRuntimePhase.ONLINE, harness.composition.state.value.phase)
            assertTrue(transport.framesOfType("command.execute").isEmpty())
        } finally {
            harness.authority.releaseQueryCommit.complete(Unit)
            harness.close()
        }
    }

    @Test
    fun `recovered retry dispatches only after actor publishes online ready`() = runBlocking {
        val harness = Harness(
            autoConnect = true,
            outbox = sendingOutbox("command-a"),
        )
        try {
            val query = harness.connectToCommandQuery()
            harness.transport().sendCommandStatuses(query, StatusMode.RETRY_IMMEDIATE)

            harness.awaitPhase(RelayV2BaseRuntimePhase.ONLINE)
            val execute = harness.transport().awaitSentType("command.execute")
            assertEquals(1, harness.authority.statusCommits.get())
            assertEquals(
                RelayV2OutboxStateTag.SENDING,
                harness.authority.outboxState().entries.single().state,
            )
            assertEquals("command-a", execute.stringValue("commandId"))
            harness.closeAndAwaitTransportDrain()
            assertEquals(1, harness.transport().framesOfType("command.execute").size)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `empty recovery dispatches fresh queued commands in creation order without query`() =
        runBlocking {
            val harness = Harness(
                autoConnect = true,
                outbox = queuedOutbox("fresh-b", "fresh-a"),
            )
            try {
                harness.connectOnline()
                withTimeout(TIMEOUT_MS) {
                    while (harness.transport().framesOfType("command.execute").size != 2) delay(1)
                }
                assertTrue(harness.transport().framesOfType("command.query").isEmpty())
                assertEquals(
                    listOf("fresh-b", "fresh-a"),
                    harness.transport().framesOfType("command.execute")
                        .map { it.stringValue("commandId") },
                )
                assertEquals(listOf(2), harness.authority.freshBatchSizes)
                assertTrue(
                    harness.authority.outboxState().entries.all {
                        it.state == RelayV2OutboxStateTag.SENDING
                    },
                )
            } finally {
                harness.close()
            }
        }

    @Test
    fun `thirty three fresh commands use bounded durable batches`() = runBlocking {
        val commandIds = (1..33).map { "fresh-${it.toString().padStart(2, '0')}" }
        val harness = Harness(
            autoConnect = true,
            outbox = queuedOutbox(*commandIds.toTypedArray()),
        )
        try {
            harness.connectOnline()
            withTimeout(TIMEOUT_MS) {
                while (harness.transport().framesOfType("command.execute").size != 33) delay(1)
            }
            assertEquals(listOf(32, 1), harness.authority.freshBatchSizes)
            assertEquals(
                commandIds,
                harness.transport().framesOfType("command.execute")
                    .map { it.stringValue("commandId") },
            )
            assertTrue(harness.transport().framesOfType("command.query").isEmpty())
        } finally {
            harness.close()
        }
    }

    @Test
    fun `recovered capabilities flush before fresh queued dispatch`() = runBlocking {
        val harness = Harness(
            autoConnect = true,
            outbox = recoveredAndFreshOutbox(),
        )
        try {
            val query = harness.connectToCommandQuery()
            assertEquals(
                listOf("recovered"),
                query.payload().objectList("items").map { it.stringValue("commandId") },
            )
            harness.transport().sendCommandStatuses(query, StatusMode.RETRY_IMMEDIATE)
            harness.awaitPhase(RelayV2BaseRuntimePhase.ONLINE)
            withTimeout(TIMEOUT_MS) {
                while (harness.transport().framesOfType("command.execute").size != 2) delay(1)
            }
            assertEquals(
                listOf("recovered", "fresh"),
                harness.transport().framesOfType("command.execute")
                    .map { it.stringValue("commandId") },
            )
            assertEquals(listOf(1), harness.authority.freshBatchSizes)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `two recovered batches wait for final online ready then dispatch once in commit order`() =
        runBlocking {
            val commandIds = (1..33).map { "command-${it.toString().padStart(2, '0')}" }
            val harness = Harness(
                autoConnect = true,
                outbox = sendingOutbox(*commandIds.toTypedArray()),
            )
            try {
                val firstQuery = harness.connectToCommandQuery()
                assertEquals(32, firstQuery.payloadReadOnly().objectList("items").size)
                harness.transport().sendCommandStatuses(firstQuery, StatusMode.RETRY_IMMEDIATE)

                val secondQuery = harness.transport().awaitSentType("command.query", index = 1)
                assertEquals(1, secondQuery.payloadReadOnly().objectList("items").size)
                assertEquals(1, harness.authority.statusCommits.get())
                assertTrue(harness.transport().framesOfType("command.execute").isEmpty())

                harness.transport().sendCommandStatuses(secondQuery, StatusMode.RETRY_IMMEDIATE)
                harness.awaitPhase(RelayV2BaseRuntimePhase.ONLINE)
                withTimeout(TIMEOUT_MS) {
                    while (harness.transport().framesOfType("command.execute").size != 33) delay(1)
                }
                val executes = harness.transport().framesOfType("command.execute")
                assertEquals(commandIds, executes.map { it.stringValue("commandId") })
                assertEquals(33, executes.map { it.stringValue("requestId") }.distinct().size)
                assertEquals(2, harness.authority.statusCommits.get())
                harness.closeAndAwaitTransportDrain()
                assertEquals(33, harness.transport().framesOfType("command.execute").size)
            } finally {
                harness.close()
            }
        }

    @Test
    fun `gap after a recovered batch clears capabilities without dispatch`() = runBlocking {
        val commandIds = (1..33).map { "gap-command-$it" }
        val harness = Harness(
            autoConnect = true,
            outbox = sendingOutbox(*commandIds.toTypedArray()),
        )
        try {
            val firstQuery = harness.connectToCommandQuery()
            harness.transport().sendCommandStatuses(firstQuery, StatusMode.RETRY_IMMEDIATE)
            harness.transport().awaitSentType("command.query", index = 1)
            assertTrue(harness.transport().framesOfType("command.execute").isEmpty())

            harness.authority.forceNextEventGap = true
            val gap = fixture("sessions-changed-upsert")
            gap["eventSeq"] = "93"
            harness.transport().sendFrame(gap)
            harness.transport().awaitSentType("state.snapshot.get")
            assertEquals(1, harness.authority.stateEventCommits.get())
            assertTrue(harness.transport().framesOfType("command.execute").isEmpty())
        } finally {
            harness.close()
        }
    }

    @Test
    fun `rebuild after durable retry commit does not blind dispatch`() = runBlocking {
        val first = Harness(autoConnect = true, outbox = sendingOutbox("command-a"))
        var rebuilt: Harness? = null
        try {
            first.authority.blockAfterStatusCommit = true
            val query = first.connectToCommandQuery()
            first.transport().sendCommandStatuses(query, StatusMode.RETRY_IMMEDIATE)
            withTimeout(TIMEOUT_MS) { first.authority.statusCommitCompleted.await() }
            val durableAttempted = first.authority.outboxState()

            first.composition.close()
            first.authority.releaseAfterStatusCommit.complete(Unit)
            first.awaitTransportDrain()
            assertTrue(first.transport().framesOfType("command.execute").isEmpty())

            rebuilt = Harness(autoConnect = true, outbox = durableAttempted)
            rebuilt.connectToCommandQuery()
            assertTrue(rebuilt.transport().framesOfType("command.execute").isEmpty())
        } finally {
            first.authority.releaseAfterStatusCommit.complete(Unit)
            first.close()
            rebuilt?.close()
        }
    }

    @Test
    fun `close after fresh commit leaves sending for restart query with zero blind resend`() =
        runBlocking {
            val first = Harness(
                autoConnect = true,
                outbox = queuedOutbox("fresh-crash"),
            )
            var rebuilt: Harness? = null
            try {
                first.authority.blockAfterFreshCommit = true
                first.openThroughHostWelcome()
                withTimeout(TIMEOUT_MS) { first.authority.freshCommitCompleted.await() }
                val durableAttempted = first.authority.outboxState()

                first.composition.close()
                first.authority.releaseAfterFreshCommit.complete(Unit)
                first.awaitTransportDrain()
                assertTrue(first.transport().framesOfType("command.execute").isEmpty())
                assertEquals(
                    RelayV2OutboxStateTag.SENDING,
                    durableAttempted.entries.single().state,
                )

                rebuilt = Harness(autoConnect = true, outbox = durableAttempted)
                val query = rebuilt.connectToCommandQuery()
                assertEquals(
                    listOf("fresh-crash"),
                    query.payload().objectList("items").map { it.stringValue("commandId") },
                )
                assertTrue(rebuilt.transport().framesOfType("command.execute").isEmpty())
            } finally {
                first.authority.releaseAfterFreshCommit.complete(Unit)
                first.close()
                rebuilt?.close()
            }
        }

    @Test
    fun `startup filters terminal rows and rejects unsupported activation facts`() = runBlocking {
        val filtered = Harness(
            autoConnect = true,
            outbox = activeAndTerminalOutbox(),
        )
        try {
            val query = filtered.connectToCommandQuery()
            assertEquals(
                listOf("sending", "accepted", "confirming", "ambiguous"),
                query.payload().objectList("items").map { it.stringValue("commandId") },
            )
            assertFalse(
                query.payload().objectList("items").any {
                    it.stringValue("commandId") == "succeeded"
                },
            )
        } finally {
            filtered.close()
        }

        val foreign = Harness(
            autoConnect = true,
            outbox = sendingOutbox("foreign", hostEpoch = "foreign-epoch"),
        )
        try {
            foreign.openThroughHostWelcome()
            val failed = foreign.awaitPhase(RelayV2BaseRuntimePhase.FAILED)
            assertEquals(
                RelayV2BaseRuntimeFailure.RuntimeIncomplete(
                    "DURABLE_OUTBOX_FOREIGN_ACTIVE_LINEAGE",
                ),
                failed.failure,
            )
            assertEquals(0, foreign.authority.helloCommits.get())
            assertTrue(foreign.transport().framesOfType("command.query").isEmpty())
        } finally {
            foreign.close()
        }

        val corrupt = Harness(
            autoConnect = true,
            outboxReadFailure = IllegalStateException("corrupt or over limit"),
        )
        try {
            val failed = corrupt.awaitPhase(RelayV2BaseRuntimePhase.FAILED)
            assertEquals(
                RelayV2BaseRuntimeFailure.RuntimeIncomplete("DURABLE_OUTBOX_ADMISSION_FAILED"),
                failed.failure,
            )
            assertTrue(corrupt.factory.requests.isEmpty())
        } finally {
            corrupt.close()
        }
    }

    @Test
    fun `v2 failure never retries another dialect or advertises Agent capability`() = runBlocking {
        val harness = Harness(autoConnect = true)
        try {
            val hello = harness.connectOnline()
            val capabilities = hello.payload().stringList("capabilities")
            assertFalse(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY in capabilities)
            assertEquals(RelayV2ConnectionActor.REQUIRED_CAPABILITIES, capabilities)

            harness.transport().fail(RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK))
            val failed = harness.awaitPhase(RelayV2BaseRuntimePhase.FAILED)
            assertTrue(failed.failure is RelayV2BaseRuntimeFailure.Connection)
            delay(100)
            assertEquals(1, harness.factory.requests.size)
            assertTrue(
                harness.factory.requests.all {
                    it.offeredSubprotocols == listOf(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                },
            )
        } finally {
            harness.close()
        }
    }

    @Test
    fun `transport failure racing a committed apply keeps the actor terminal cause`() = runBlocking {
        val harness = Harness(autoConnect = true)
        try {
            harness.connectOnline()
            harness.authority.blockStateEvents = true
            harness.transport().sendFixture("sessions-changed-upsert")
            withTimeout(TIMEOUT_MS) { harness.authority.stateEventApplyEntered.await() }

            harness.transport().fail(
                RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK),
            )
            harness.authority.releaseStateEventApply.complete(Unit)

            val failed = harness.awaitPhase(RelayV2BaseRuntimePhase.FAILED)
            val cause = failed.failure as RelayV2BaseRuntimeFailure.Connection
            assertEquals(RelayV2FailureKind.TRANSPORT, cause.failure.kind)
            assertEquals(1, harness.authority.stateEventCommits.get())
        } finally {
            harness.authority.releaseStateEventApply.complete(Unit)
            harness.close()
        }
    }

    @Test
    fun `close fences queued old-generation effects before durable commit`() = runBlocking {
        val harness = Harness(autoConnect = true)
        try {
            harness.connectOnline()
            harness.authority.blockStateEvents = true
            harness.transport().sendFixture("sessions-changed-upsert")
            withTimeout(TIMEOUT_MS) { harness.authority.stateEventApplyEntered.await() }

            val second = fixture("sessions-changed-upsert")
            second["eventSeq"] = "93"
            second.payload()["resultingRevision"] = "14"
            harness.transport().sendFrame(second)

            harness.composition.close()
            harness.composition.close()
            harness.authority.releaseStateEventApply.complete(Unit)
            withTimeout(TIMEOUT_MS) {
                while (harness.transport().cancelCount != 1) delay(1)
            }

            assertEquals(0, harness.authority.stateEventCommits.get())
            assertEquals(0, harness.transport().closeCount())
            assertEquals(1, harness.transport().cancelCount)
            assertEquals(RelayV2BaseRuntimePhase.STOPPED, harness.composition.state.value.phase)
        } finally {
            harness.close()
        }
    }

    private inner class Harness(
        autoConnect: Boolean,
        outbox: RelayV2OutboxState = RelayV2OutboxState.empty(),
        outboxReadFailure: Throwable? = null,
    ) {
        private val parent = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        private val credentials = MemoryCredentialStore()
        val authority = FakeDurableAuthority(outbox, outboxReadFailure)
        val factory = FakeTransportFactory()
        val profile = RelayV2Profile(
            profileId = PROFILE_ID,
            issuerUrl = "https://relay.example.com",
            relayUrl = "wss://relay.example.com/client",
            hostId = HOST_ID,
            principalId = PRINCIPAL_ID,
            grantId = "grant-uuid",
            clientInstanceId = CLIENT_INSTANCE_ID,
            credentialReference = RelayV2CredentialReference("credential-primary"),
            credentialVersion = 1,
            activationGeneration = 1,
            autoConnect = autoConnect,
        )
        val composition: RelayV2BaseRuntimeComposition

        init {
            check(
                credentials.create(
                    profile.credentialReference,
                    RelayV2CredentialBlob(
                        credentialVersion = 1,
                        issuerUrl = profile.issuerUrl,
                        relayUrl = profile.relayUrl,
                        hostId = profile.hostId,
                        clientInstanceId = profile.clientInstanceId,
                        principalId = profile.principalId,
                        grantId = profile.grantId,
                        accessToken = "twcap2.test-access",
                        accessExpiresAtMs = System.currentTimeMillis() + 60_000,
                        refreshToken = "twref2.test-refresh",
                        refreshExpiresAtMs = System.currentTimeMillis() + 120_000,
                    ),
                ),
            )
            composition = RelayV2BaseRuntimeComposition(
                parentScope = parent,
                profile = profile,
                credentialStore = credentials,
                stateSyncAuthority = authority,
                activationOutbox = RelayV2ActivationOutboxReadPort(authority::readOutbox),
                outboxAuthority = authority,
                transportFactory = factory,
            )
        }

        suspend fun connectOnline(): MutableMap<String, Any?> {
            val transport = awaitTransport()
            transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            transport.sendFixture("relay-welcome")
            val hello = transport.awaitSentFrame()
            val welcome = fixture("host-welcome-caught-up")
            welcome["requestId"] = hello.stringValue("requestId")
            transport.sendFrame(welcome)
            awaitPhase(RelayV2BaseRuntimePhase.ONLINE)
            return hello
        }

        suspend fun openThroughHostWelcome(): FakeTransport {
            val transport = awaitTransport()
            transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            transport.sendFixture("relay-welcome")
            val hello = transport.awaitSentFrame()
            val welcome = fixture("host-welcome-caught-up")
            welcome["requestId"] = hello.stringValue("requestId")
            transport.sendFrame(welcome)
            return transport
        }

        suspend fun connectToCommandQuery(): MutableMap<String, Any?> {
            val transport = openThroughHostWelcome()
            return transport.awaitSentType("command.query")
        }

        suspend fun awaitPhase(phase: RelayV2BaseRuntimePhase): RelayV2BaseRuntimeState =
            withTimeout(TIMEOUT_MS) { composition.state.first { it.phase == phase } }

        fun transport(): FakeTransport = factory.transports.single()

        suspend fun closeAndAwaitTransportDrain() {
            composition.close()
            awaitTransportDrain()
        }

        suspend fun awaitTransportDrain() {
            withTimeout(TIMEOUT_MS) {
                while (transport().cancelCount != 1) delay(1)
            }
        }

        private suspend fun awaitTransport(): FakeTransport = withTimeout(TIMEOUT_MS) {
            while (factory.transports.isEmpty()) delay(1)
            factory.transports.single()
        }

        fun close() {
            composition.close()
            parent.cancel()
        }
    }

    private class FakeDurableAuthority(
        initialOutbox: RelayV2OutboxState,
        private val outboxReadFailure: Throwable?,
    ) : RelayV2StateSyncAuthority,
        RelayV2OutboxRuntimeAuthority {
        private val outboxCore = RelayV2OutboxAuthorityCore()

        @Volatile
        private var outbox = initialOutbox

        val helloCommits = AtomicInteger()
        val stateEventCommits = AtomicInteger()
        val outboxReads = AtomicInteger()
        val queryCommits = AtomicInteger()
        val statusCommits = AtomicInteger()
        val freshBatchSizes = CopyOnWriteArrayList<Int>()
        val stateEventApplyEntered = CompletableDeferred<Unit>()
        val releaseStateEventApply = CompletableDeferred<Unit>()
        val queryCommitEntered = CompletableDeferred<Unit>()
        val releaseQueryCommit = CompletableDeferred<Unit>()
        val statusCommitCompleted = CompletableDeferred<Unit>()
        val releaseAfterStatusCommit = CompletableDeferred<Unit>()
        val freshCommitCompleted = CompletableDeferred<Unit>()
        val releaseAfterFreshCommit = CompletableDeferred<Unit>()

        @Volatile
        var blockStateEvents: Boolean = false

        @Volatile
        var blockQueryCommit: Boolean = false

        @Volatile
        var blockAfterStatusCommit: Boolean = false

        @Volatile
        var blockAfterFreshCommit: Boolean = false

        @Volatile
        var forceNextEventGap: Boolean = false

        suspend fun readOutbox(profile: RelayV2Profile): RelayV2OutboxState {
            outboxReads.incrementAndGet()
            outboxReadFailure?.let { throw it }
            check(profile.profileId == PROFILE_ID)
            check(profile.principalId == PRINCIPAL_ID)
            return outbox
        }

        fun outboxState(): RelayV2OutboxState = outbox

        override suspend fun reduceOutboxBatchUnderApplyLease(
            namespace: com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxAuthorityNamespace,
            actionSource: (RelayV2OutboxState) -> List<RelayV2OutboxAction>?,
        ): RelayV2OutboxBatchResult {
            check(namespace.profileId == PROFILE_ID)
            check(namespace.principalId == PRINCIPAL_ID)
            check(namespace.clientInstanceId == CLIENT_INSTANCE_ID)
            val current = outbox
            val actions = actionSource(current)
                ?: return RelayV2OutboxBatchResult.Rejected(current, null)
            if (actions.size !in 1..RelayV2OutboxLimits.MAX_QUERY_ITEMS_PER_BATCH) {
                return RelayV2OutboxBatchResult.Rejected(current, null)
            }
            var reduced = current
            val effects = ArrayList<RelayV2OutboxEffect>()
            actions.forEach { action ->
                when (val result = outboxCore.reduce(reduced, action)) {
                    is RelayV2OutboxResult.Rejected ->
                        return RelayV2OutboxBatchResult.Rejected(current, result.reason)
                    is RelayV2OutboxResult.Applied -> {
                        reduced = result.state
                        effects += result.effects
                    }
                }
            }
            val isQuery = actions.all { it is RelayV2OutboxAction.BeginQueries }
            if (isQuery && blockQueryCommit) {
                queryCommitEntered.complete(Unit)
                releaseQueryCommit.await()
            }
            outbox = reduced
            if (isQuery) queryCommits.incrementAndGet() else statusCommits.incrementAndGet()
            if (!isQuery && blockAfterStatusCommit) {
                statusCommitCompleted.complete(Unit)
                releaseAfterStatusCommit.await()
            }
            return RelayV2OutboxBatchResult.Applied(reduced, effects)
        }

        override suspend fun dispatchFreshUnderApplyLease(
            namespace: com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxAuthorityNamespace,
            attemptRequestIds: List<String>,
        ): RelayV2OutboxFreshDispatchResult {
            check(namespace.profileId == PROFILE_ID)
            check(namespace.principalId == PRINCIPAL_ID)
            check(namespace.clientInstanceId == CLIENT_INSTANCE_ID)
            val current = outbox
            val eligible = outboxCore.dispatchEligibleEntryIds(current, attemptRequestIds.size)
            if (eligible.isEmpty()) return RelayV2OutboxFreshDispatchResult.Empty(current)
            val result = outboxCore.reduce(
                current,
                RelayV2OutboxAction.DispatchEligible(
                    eligible.mapIndexed { index, entryId ->
                        entryId to attemptRequestIds[index]
                    }.toMap(),
                    eligible.size,
                ),
            )
            if (result is RelayV2OutboxResult.Rejected) {
                return RelayV2OutboxFreshDispatchResult.Rejected(current, result.reason)
            }
            result as RelayV2OutboxResult.Applied
            val effects = result.effects.mapNotNull {
                it as? RelayV2OutboxEffect.ExecuteCommand
            }
            check(effects.size == result.effects.size)
            outbox = result.state
            freshBatchSizes += effects.size
            if (blockAfterFreshCommit) {
                freshCommitCompleted.complete(Unit)
                releaseAfterFreshCommit.await()
            }
            return RelayV2OutboxFreshDispatchResult.Committed(result.state, effects)
        }

        override suspend fun loadConnectPlan(
            identity: RelayV2StateConnectIdentity,
        ): RelayV2StateConnectPlan = RelayV2StateConnectPlan(
            identity = identity,
            resume = RelayV2AppliedCursor(HOST_EPOCH, "91"),
            recovery = RelayV2StateConnectRecovery.LIVE,
            durableHostEpoch = HOST_EPOCH,
            requiredThroughEventSeq = "91",
        )

        override suspend fun applyHelloUnderApplyLease(
            connectPlan: RelayV2StateConnectPlan,
            hello: RelayV2StateHello,
        ): RelayV2StateSyncResult {
            check(connectPlan.identity.profileId == hello.namespace.profileId)
            helloCommits.incrementAndGet()
            return RelayV2StateSyncResult.Live(hello.namespace, hello.welcomeEventSeq)
        }

        override suspend fun applyStateEventUnderApplyLease(
            event: RelayV2StateEvent,
        ): RelayV2StateSyncResult {
            if (blockStateEvents) {
                stateEventApplyEntered.complete(Unit)
                releaseStateEventApply.await()
            }
            stateEventCommits.incrementAndGet()
            if (forceNextEventGap) {
                forceNextEventGap = false
                return RelayV2StateSyncResult.ResyncRequired(
                    namespace = event.namespace,
                    reason = RelayV2ResyncReason.EVENT_GAP,
                    durableCursorEventSeq = "91",
                    requiredThroughEventSeq = event.eventSeq,
                    supersedesQueryCompletion = true,
                )
            }
            return RelayV2StateSyncResult.Live(event.namespace, event.eventSeq)
        }

        override suspend fun stageSnapshotChunkUnderApplyLease(
            chunk: RelayV2SnapshotChunk,
        ): RelayV2StateSyncResult = error("snapshot is outside matched base-sync test")

        override suspend fun commitSnapshotUnderApplyLease(
            namespace: RelayV2StateNamespace,
            snapshotId: String,
        ): RelayV2StateSyncResult = error("snapshot is outside matched base-sync test")

        override suspend fun completeSnapshotReleaseUnderApplyLease(
            expected: RelayV2SnapshotReleaseObligation,
        ): RelayV2SnapshotReleaseCompletion? = error("release is outside matched base-sync test")

        override suspend fun expireSnapshotContinuationUnderApplyLease(
            namespace: RelayV2StateNamespace,
            snapshotRequestId: String,
            snapshotId: String,
        ): RelayV2StateSyncResult = error("expiry is outside matched base-sync test")
    }

    private inner class FakeTransportFactory : RelayV2TransportFactory {
        val requests = CopyOnWriteArrayList<RelayV2TransportOpenRequest>()
        val transports = CopyOnWriteArrayList<FakeTransport>()

        override fun open(
            request: RelayV2TransportOpenRequest,
            listener: RelayV2TransportListener,
        ): RelayV2Transport {
            requests += request
            return FakeTransport(listener).also(transports::add)
        }
    }

    private inner class FakeTransport(
        private val listener: RelayV2TransportListener,
    ) : RelayV2Transport {
        private val sent = CopyOnWriteArrayList<ByteArray>()
        private val closeCodes = CopyOnWriteArrayList<Int>()
        private val terminated = CompletableDeferred<Boolean>()

        @Volatile
        var cancelCount: Int = 0
            private set

        override fun send(bytes: ByteArray): Boolean {
            sent += bytes.copyOf()
            return true
        }

        override fun close(code: Int, reason: String) {
            closeCodes += code
            terminated.complete(true)
        }

        override fun cancel() {
            cancelCount += 1
            terminated.complete(true)
        }

        override suspend fun awaitTermination(): Boolean = terminated.await()

        fun open(selectedSubprotocol: String?) = listener.onOpen(this, selectedSubprotocol)

        fun sendFixture(name: String) = sendFrame(fixture(name))

        fun sendFrame(frame: Map<String, Any?>) {
            listener.onFrame(
                this,
                codec.encodeWebSocketFrame(RelayV2WebSocketChannel.PUBLIC, frame),
                RelayV2FrameMetadata(),
            )
        }

        fun fail(failure: RelayV2TransportFailure) {
            terminated.complete(true)
            listener.onFailure(this, failure)
        }

        suspend fun awaitSentFrame(index: Int = 0): MutableMap<String, Any?> =
            withTimeout(TIMEOUT_MS) {
                while (sent.size <= index) delay(1)
                LinkedHashMap(deepClone(
                    codec.decodeWebSocketFrame(
                        RelayV2WebSocketChannel.PUBLIC,
                        sent[index],
                    ).frame,
                ))
            }

        suspend fun awaitSentType(
            type: String,
            index: Int = 0,
        ): MutableMap<String, Any?> =
            withTimeout(TIMEOUT_MS) {
                while (true) {
                    framesOfType(type).getOrNull(index)?.let { return@withTimeout it }
                    delay(1)
                }
                error("unreachable")
            }

        fun framesOfType(type: String): List<MutableMap<String, Any?>> = sent.mapNotNull { bytes ->
            val frame = LinkedHashMap(deepClone(
                codec.decodeWebSocketFrame(
                    RelayV2WebSocketChannel.PUBLIC,
                    bytes,
                ).frame,
            ))
            frame.takeIf { it["type"] == type }
        }

        fun sendCommandStatuses(
            query: Map<String, Any?>,
            mode: StatusMode,
        ) {
            val items = query.payloadReadOnly().objectList("items")
            sendFrame(
                linkedMapOf(
                    "protocolVersion" to 2L,
                    "kind" to "response",
                    "type" to "command.statuses",
                    "requestId" to query.stringValue("requestId"),
                    "hostId" to HOST_ID,
                    "hostEpoch" to HOST_EPOCH,
                    "payload" to linkedMapOf(
                        "dedupeWatermark" to linkedMapOf(
                            "oldestQueryableWindowSeq" to "1",
                            "newestIssuedWindowSeq" to "42",
                            "observedAtMs" to NOW_MS,
                        ),
                        "items" to items.map { item -> statusItem(item, mode) },
                    ),
                ),
            )
        }

        fun sendCommandResult(commandId: String) {
            sendFrame(
                linkedMapOf(
                    "protocolVersion" to 2L,
                    "kind" to "event",
                    "type" to "command.result",
                    "commandId" to commandId,
                    "hostId" to HOST_ID,
                    "hostEpoch" to HOST_EPOCH,
                    "scopeId" to "scope-$commandId",
                    "sessionId" to "session-$commandId",
                    "payload" to linkedMapOf(
                        "dedupeWindowId" to "window-$commandId",
                        "state" to "succeeded",
                        "updatedAtMs" to NOW_MS,
                        "result" to linkedMapOf(
                            "sessionId" to "session-$commandId",
                            "terminated" to true,
                        ),
                    ),
                    "error" to null,
                ),
            )
        }

        fun sendCount(): Int = sent.size

        fun closeCount(): Int = closeCodes.size

        private fun statusItem(
            pending: Map<String, Any?>,
            mode: StatusMode,
        ): Map<String, Any?> {
            val retry = mode == StatusMode.RETRY_IMMEDIATE
            return linkedMapOf(
                "commandId" to pending.stringValue("commandId"),
                "dedupeWindowId" to pending.stringValue("dedupeWindowId"),
                "state" to if (retry) "not_accepted" else "accepted",
                "updatedAtMs" to NOW_MS,
                "dedupeUntilMs" to null,
                "retryable" to retry,
                "retryAfterMs" to if (retry) 0L else null,
                "reissueRequired" to false,
                "result" to null,
                "error" to if (retry) linkedMapOf(
                    "code" to "COMMAND_NOT_ACCEPTED",
                    "message" to "retryable status",
                    "retryable" to true,
                    "commandDisposition" to "not_accepted",
                    "details" to null,
                ) else null,
            )
        }
    }

    private class MemoryCredentialStore : RelayV2CredentialStore {
        private val values = linkedMapOf<RelayV2CredentialReference, RelayV2CredentialBlob>()

        override fun read(reference: RelayV2CredentialReference): RelayV2CredentialBlob? =
            synchronized(values) { values[reference] }

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
        ): RelayV2CredentialCasResult = error("credential mutation is outside base-sync runtime")

        override fun clear(reference: RelayV2CredentialReference) {
            synchronized(values) { values.remove(reference) }
        }
    }

    private fun fixture(name: String): MutableMap<String, Any?> = deepClone(
        fixtures.golden.single { it.name == name }.frame,
    )

    private fun sendingOutbox(
        vararg commandIds: String,
        hostEpoch: String = HOST_EPOCH,
    ): RelayV2OutboxState = outbox(commandIds.toList(), hostEpoch, dispatch = true)

    private fun queuedOutbox(vararg commandIds: String): RelayV2OutboxState =
        outbox(commandIds.toList(), HOST_EPOCH, dispatch = false)

    private fun recoveredAndFreshOutbox(): RelayV2OutboxState {
        val core = RelayV2OutboxAuthorityCore()
        val queued = outbox(listOf("recovered", "fresh"), HOST_EPOCH, dispatch = false)
        val recovered = queued.entries.single { it.commandId == "recovered" }
        return applied(
            core.reduce(
                queued,
                RelayV2OutboxAction.DispatchEligible(
                    mapOf(recovered.id to "initial-recovered"),
                    effectBudget = 1,
                ),
            ),
        ).state
    }

    private fun outbox(
        commandIds: List<String>,
        hostEpoch: String,
        dispatch: Boolean,
    ): RelayV2OutboxState {
        val core = RelayV2OutboxAuthorityCore()
        var state = RelayV2OutboxState.empty()
        commandIds.forEachIndexed { index, commandId ->
            state = applied(
                core.reduce(
                    state,
                    RelayV2OutboxAction.Enqueue(
                        RelayV2OutboxDraft(
                            profileId = PROFILE_ID,
                            principalId = PRINCIPAL_ID,
                            hostId = HOST_ID,
                            expectedHostEpoch = hostEpoch,
                            dedupeWindowId = "window-$commandId",
                            commandId = commandId,
                            scopeId = "scope-$commandId",
                            sessionId = "session-$commandId",
                            arguments = RelayV2OutboxArguments.killSession(),
                        ),
                        createdAtMillis = index.toLong() + 1L,
                    ),
                ),
            ).state
        }
        if (!dispatch || state.entries.isEmpty()) return state
        return applied(
            core.reduce(
                state,
                RelayV2OutboxAction.DispatchEligible(
                    attemptRequestIds = state.entries.associate { entry ->
                        entry.id to "initial-${entry.commandId}"
                    },
                    effectBudget = state.entries.size,
                ),
            ),
        ).state
    }

    private fun activeAndTerminalOutbox(): RelayV2OutboxState {
        val state = sendingOutbox(
            "sending",
            "accepted",
            "confirming",
            "ambiguous",
            "succeeded",
            "queued",
        )
        val transformed = state.entries.map { entry ->
            when (entry.commandId) {
                "accepted" -> entry.copy(
                    state = RelayV2OutboxStateTag.ACCEPTED,
                    acceptanceEvidence = RelayV2OutboxAcceptanceEvidence.DURABLE,
                )
                "confirming" -> entry.copy(state = RelayV2OutboxStateTag.CONFIRMING)
                "ambiguous" -> entry.copy(state = RelayV2OutboxStateTag.AMBIGUOUS)
                "succeeded" -> entry.copy(
                    state = RelayV2OutboxStateTag.SUCCEEDED,
                    acceptanceEvidence = RelayV2OutboxAcceptanceEvidence.DURABLE,
                )
                "queued" -> entry.copy(
                    state = RelayV2OutboxStateTag.QUEUED,
                    acceptanceEvidence = RelayV2OutboxAcceptanceEvidence.NONE,
                    attempts = emptyList(),
                )
                else -> entry
            }
        }
        return RelayV2OutboxState.restore(transformed, state.nextCreationOrder)
    }

    private fun applied(result: RelayV2OutboxResult): RelayV2OutboxResult.Applied =
        result as RelayV2OutboxResult.Applied

    @Suppress("UNCHECKED_CAST")
    private fun <T> deepClone(value: T): T = when (value) {
        is Map<*, *> -> LinkedHashMap<String, Any?>().apply {
            value.forEach { (key, item) -> put(key as String, deepClone(item)) }
        } as T
        is List<*> -> value.map(::deepClone) as T
        else -> value
    }

    @Suppress("UNCHECKED_CAST")
    private fun MutableMap<String, Any?>.payload(): MutableMap<String, Any?> =
        getValue("payload") as MutableMap<String, Any?>

    private fun Map<String, Any?>.stringValue(name: String): String = getValue(name) as String

    @Suppress("UNCHECKED_CAST")
    private fun Map<String, Any?>.payloadReadOnly(): Map<String, Any?> =
        getValue("payload") as Map<String, Any?>

    @Suppress("UNCHECKED_CAST")
    private fun Map<String, Any?>.objectList(name: String): List<Map<String, Any?>> =
        getValue(name) as List<Map<String, Any?>>

    @Suppress("UNCHECKED_CAST")
    private fun Map<String, Any?>.stringList(name: String): List<String> =
        getValue(name) as List<String>

    private enum class StatusMode {
        ACCEPTED,
        RETRY_IMMEDIATE,
    }

    private companion object {
        const val TIMEOUT_MS = 5_000L
        const val NOW_MS = 50L
        const val PROFILE_ID = "profile-primary"
        const val HOST_ID = "mac-admin"
        const val HOST_EPOCH = "authority-uuid"
        const val PRINCIPAL_ID = "principal-opaque-id"
        const val CLIENT_INSTANCE_ID = "android-install-uuid"
    }
}
