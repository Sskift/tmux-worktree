package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY
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
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AppliedCursor
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
            assertEquals(RelayV2BaseRuntimePhase.STOPPED, harness.composition.state.value.phase)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `non-empty durable Outbox or an unowned effect fails closed`() = runBlocking {
        val nonEmpty = Harness(autoConnect = true, outboxEmpty = false)
        try {
            val failed = nonEmpty.awaitPhase(RelayV2BaseRuntimePhase.FAILED)
            assertEquals(
                RelayV2BaseRuntimeFailure.RuntimeIncomplete(
                    "DURABLE_OUTBOX_RUNTIME_UNAVAILABLE",
                ),
                failed.failure,
            )
            assertTrue(nonEmpty.factory.requests.isEmpty())
        } finally {
            nonEmpty.close()
        }

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
    fun `uncomposed command query registration fails closed without durable or network effects`() =
        runBlocking {
            val harness = Harness(autoConnect = true)
            try {
                harness.connectOnline()
                val transport = harness.transport()
                val helloCommits = harness.authority.helloCommits.get()
                val stateEventCommits = harness.authority.stateEventCommits.get()
                val networkSends = transport.sendCount()

                harness.composition.consume(harness.commandQueryRegistration())

                val failed = harness.awaitPhase(RelayV2BaseRuntimePhase.FAILED)
                assertEquals(
                    RelayV2BaseRuntimeFailure.RuntimeIncomplete(
                        "COMMAND_OUTBOX_RUNTIME_UNAVAILABLE",
                    ),
                    failed.failure,
                )
                assertEquals(helloCommits, harness.authority.helloCommits.get())
                assertEquals(stateEventCommits, harness.authority.stateEventCommits.get())
                assertEquals(networkSends, transport.sendCount())
            } finally {
                harness.close()
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
        outboxEmpty: Boolean = true,
    ) {
        private val parent = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        private val credentials = MemoryCredentialStore()
        val authority = FakeDurableAuthority(outboxEmpty)
        val factory = FakeTransportFactory()
        val profile = RelayV2Profile(
            profileId = "profile-primary",
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
                activationOutbox = RelayV2ActivationOutboxReadPort(authority::outboxIsEmpty),
                transportFactory = factory,
            )
        }

        suspend fun connectOnline(): MutableMap<String, Any?> {
            val transport = withTimeout(TIMEOUT_MS) {
                while (factory.transports.isEmpty()) delay(1)
                factory.transports.single()
            }
            transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            transport.sendFixture("relay-welcome")
            val hello = transport.awaitSentFrame()
            val welcome = fixture("host-welcome-caught-up")
            welcome["requestId"] = hello.stringValue("requestId")
            transport.sendFrame(welcome)
            awaitPhase(RelayV2BaseRuntimePhase.ONLINE)
            return hello
        }

        suspend fun awaitPhase(phase: RelayV2BaseRuntimePhase): RelayV2BaseRuntimeState =
            withTimeout(TIMEOUT_MS) { composition.state.first { it.phase == phase } }

        fun transport(): FakeTransport = factory.transports.single()

        fun commandQueryRegistration(): RelayV2RuntimeEffect.RegisterCommandQueryAttempt {
            val generation = RelayV2EffectGeneration(
                profileId = profile.profileId,
                profileGeneration = profile.activationGeneration,
                connectionGeneration = 1,
            )
            return RelayV2RuntimeEffect.RegisterCommandQueryAttempt(
                recovery = RelayV2RecoveryBinding(
                    generation = generation,
                    step = 2,
                    requestId = "query-registration-request",
                ),
                hostId = profile.hostId,
                hostEpoch = HOST_EPOCH,
                commandBatch = RelayV2CommandQueryBatch(
                    listOf(
                        RelayV2PendingCommand(
                            commandId = "pending-command",
                            dedupeWindowId = "dedupe-window",
                        ),
                    ),
                ),
                repositoryAuthority = RelayV2RepositoryEffectAuthority(
                    generation = generation,
                    profileId = profile.profileId,
                    profileActivationGeneration = profile.activationGeneration,
                    principalId = profile.principalId,
                    clientInstanceId = profile.clientInstanceId,
                    hostId = profile.hostId,
                    hostEpoch = HOST_EPOCH,
                ),
            )
        }

        fun close() {
            composition.close()
            parent.cancel()
        }
    }

    private class FakeDurableAuthority(
        private val outboxEmpty: Boolean,
    ) : RelayV2StateSyncAuthority {
        val helloCommits = AtomicInteger()
        val stateEventCommits = AtomicInteger()
        val stateEventApplyEntered = CompletableDeferred<Unit>()
        val releaseStateEventApply = CompletableDeferred<Unit>()

        @Volatile
        var blockStateEvents: Boolean = false

        suspend fun outboxIsEmpty(@Suppress("UNUSED_PARAMETER") profile: RelayV2Profile): Boolean =
            outboxEmpty

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

        fun sendCount(): Int = sent.size

        fun closeCount(): Int = closeCodes.size
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
    private fun Map<String, Any?>.stringList(name: String): List<String> =
        getValue(name) as List<String>

    private companion object {
        const val TIMEOUT_MS = 5_000L
        const val HOST_ID = "mac-admin"
        const val HOST_EPOCH = "authority-uuid"
        const val PRINCIPAL_ID = "principal-opaque-id"
        const val CLIENT_INSTANCE_ID = "android-install-uuid"
    }
}
