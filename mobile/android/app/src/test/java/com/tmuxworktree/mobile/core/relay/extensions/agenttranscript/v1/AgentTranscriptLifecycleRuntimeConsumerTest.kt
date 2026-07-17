package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectApplyResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectGeneration
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectApplyLeasePort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import java.nio.charset.StandardCharsets
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentTranscriptLifecycleRuntimeConsumerTest {
    @Test
    fun `unnegotiated input is neither decoded nor leased`() = runBlocking {
        val harness = Harness(sessionId = "session-shell", statusRequestId = "agent-status-2")
        val before = harness.repository.load(harness.consumer)

        val result = harness.runtime.consume(
            byteArrayOf(0xc3.toByte()),
            harness.fence(negotiated = false),
        )

        assertEquals(AgentTranscriptLifecycleRuntimeConsumeResult.ExtensionNotNegotiated, result)
        assertEquals(0, harness.lease.blockCount)
        assertEquals(before, harness.repository.load(harness.consumer))
    }

    @Test
    fun `correlated unavailable waits for commit inside the controlled lease block`() =
        runBlocking {
            val harness = Harness(sessionId = "session-shell", statusRequestId = "agent-status-2")
            val commit = harness.store.blockNextCommit()
            val applying = async(Dispatchers.Default) {
                harness.runtime.consume(
                    fixtureWire("status-unsupported-agent"),
                    harness.fence(),
                )
            }
            commit.entered.await()
            assertFalse(applying.isCompleted)
            assertTrue(harness.lease.insideBlock)
            commit.release.complete(Unit)

            val result = applying.await()
            assertTrue(result is AgentTranscriptLifecycleRuntimeConsumeResult.Applied)
            assertFalse(harness.lease.insideBlock)
            assertEquals(1, harness.lease.blockCount)
            val restored = requireNotNull(harness.repository.load(harness.consumer)).state
            assertEquals(AgentExtensionSupport.UNAVAILABLE, restored.extensionLane.support)
            assertEquals(
                AgentExtensionUnavailableReason.AGENT_UNSUPPORTED,
                restored.extensionLane.unavailableReason,
            )
            assertEquals("0", restored.extensionLane.lastAgentSeq)
        }

    @Test
    fun `cursor bearing inputs close without lease or reduce`() = runBlocking {
        val harness = Harness(
            sessionId = "session-1",
            statusRequestId = "agent-status-1",
            timelineEpoch = "timeline-1",
        )
        val before = harness.repository.load(harness.consumer)
        val cases = listOf(
            CursorCase(
                "status-available",
                AgentTranscriptLifecycleTrustedIngress.CorrelatedStatus(
                    AgentLocalRequestFence("1", "agent-status-1"),
                ),
            ),
            CursorCase("snapshot-page-materialized", AgentTranscriptLifecycleTrustedIngress.Snapshot),
            CursorCase(
                "replay-page-lifecycle-and-entry",
                AgentTranscriptLifecycleTrustedIngress.Replay,
            ),
            CursorCase("live-entry-redacted", AgentTranscriptLifecycleTrustedIngress.Live),
            CursorCase("live-entry-deleted", AgentTranscriptLifecycleTrustedIngress.Live),
            CursorCase("live-run-failed", AgentTranscriptLifecycleTrustedIngress.Live),
            CursorCase("timeline-deleted-reset", AgentTranscriptLifecycleTrustedIngress.Live),
        )

        cases.forEach { case ->
            val result = harness.runtime.consume(
                fixtureWire(case.fixture),
                harness.fence(ingress = case.ingress),
            )
            assertEquals(
                case.fixture,
                AgentTranscriptLifecycleRuntimeConsumeResult.Unavailable(
                    AgentTranscriptLifecycleRuntimeUnavailableReason.COMPLETE_CONSUMER_NOT_READY,
                ),
                result,
            )
        }

        assertEquals(0, harness.lease.blockCount)
        assertEquals(before, harness.repository.load(harness.consumer))
        assertEquals("8", requireNotNull(before).state.extensionLane.lastAgentSeq)
    }

    private data class CursorCase(
        val fixture: String,
        val ingress: AgentTranscriptLifecycleTrustedIngress,
    )

    private class Harness(
        sessionId: String,
        private val statusRequestId: String,
        timelineEpoch: String? = null,
    ) {
        val consumer = AgentTranscriptLifecycleDurableConsumerIdentity(
            profileId = "profile-1",
            profileActivationGeneration = 7,
            principalId = "principal-1",
            clientInstanceId = "client-1",
            hostId = "mac-admin",
            hostEpoch = "host-epoch-1",
            scopeId = "scope-local",
            sessionId = sessionId,
        )
        private val generation = RelayV2EffectGeneration("profile-1", 7, 11)
        private val authority = RelayV2RepositoryEffectAuthority(
            generation = generation,
            profileId = "profile-1",
            profileActivationGeneration = 7,
            principalId = "principal-1",
            clientInstanceId = "client-1",
            hostId = "mac-admin",
            hostEpoch = "host-epoch-1",
        )
        val store = SingleRowStore()
        val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
        val lease = RecordingApplyLease(authority)
        val runtime = AgentTranscriptLifecycleRuntimeConsumer(lease, repository)
        private val namespace: AgentTranscriptLifecycleDurableNamespace

        init {
            val extension = if (timelineEpoch == null) {
                AgentTranscriptLifecycleExtensionState(
                    localGeneration = "1",
                    support = AgentExtensionSupport.UNKNOWN,
                    unavailableReason = null,
                    pendingStatusRequest = AgentLocalRequestFence("1", statusRequestId),
                )
            } else {
                AgentTranscriptLifecycleExtensionState(
                    localGeneration = "1",
                    support = AgentExtensionSupport.AVAILABLE,
                    unavailableReason = null,
                    liveSource = AgentLiveSourceState.CONNECTED,
                    activeSourceEpoch = "source-1",
                    timelineEpoch = timelineEpoch,
                    lastAgentSeq = "8",
                    notificationBaselineAgentSeq = "8",
                )
            }
            val state = AgentTranscriptLifecycleClientState(consumer.sessionIdentity, extension)
            namespace = AgentTranscriptLifecycleDurableNamespace(consumer, timelineEpoch)
            runBlocking { repository.initializeUnderApplyLease(namespace, state) }
        }

        fun fence(
            negotiated: Boolean = true,
            ingress: AgentTranscriptLifecycleTrustedIngress =
                AgentTranscriptLifecycleTrustedIngress.CorrelatedStatus(
                    AgentLocalRequestFence("1", statusRequestId),
                ),
        ) = AgentTranscriptLifecycleRuntimeFence(
            authority = authority,
            expectedNamespace = namespace,
            negotiatedCapabilities = if (negotiated) {
                setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY)
            } else {
                emptySet()
            },
            ingress = ingress,
        )
    }
}

private class RecordingApplyLease(
    private val expectedAuthority: RelayV2RepositoryEffectAuthority,
) : RelayV2RepositoryEffectApplyLeasePort {
    var blockCount: Int = 0
        private set
    var insideBlock: Boolean = false
        private set

    override suspend fun <T> withEffectApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        block: suspend () -> T,
    ): RelayV2EffectApplyResult<T> {
        check(authority == expectedAuthority)
        check(!insideBlock)
        blockCount += 1
        insideBlock = true
        return try {
            RelayV2EffectApplyResult.Applied(block())
        } finally {
            insideBlock = false
        }
    }
}

private class SingleRowStore : AgentTranscriptLifecycleDurableStore {
    data class CommitGate(
        val entered: CompletableDeferred<Unit> = CompletableDeferred(),
        val release: CompletableDeferred<Unit> = CompletableDeferred(),
    )

    private val mutex = Mutex()
    private var row: AgentTranscriptLifecyclePersistedState? = null
    private var nextCommitGate: CommitGate? = null

    fun blockNextCommit(): CommitGate = CommitGate().also { nextCommitGate = it }

    override suspend fun <T> transaction(
        block: AgentTranscriptLifecycleDurableTransaction.() -> T,
    ): T {
        mutex.lock()
        try {
            val transaction = Transaction(row)
            val result = transaction.block()
            if (transaction.changed) {
                nextCommitGate?.also { gate ->
                    nextCommitGate = null
                    gate.entered.complete(Unit)
                    gate.release.await()
                }
                row = transaction.row
            }
            return result
        } finally {
            mutex.unlock()
        }
    }

    private class Transaction(
        var row: AgentTranscriptLifecyclePersistedState?,
    ) : AgentTranscriptLifecycleDurableTransaction {
        var changed = false

        override fun states(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
        ): List<AgentTranscriptLifecyclePersistedState> =
            listOfNotNull(row?.takeIf { it.namespace.consumer == consumer })

        override fun deleteConsumer(consumer: AgentTranscriptLifecycleDurableConsumerIdentity) {
            if (row?.namespace?.consumer == consumer) {
                row = null
                changed = true
            }
        }

        override fun insertState(state: AgentTranscriptLifecyclePersistedState) {
            check(row == null)
            row = state
            changed = true
        }

        override fun notificationClaims(
            eventIdentity: AgentTranscriptLifecycleNotificationClaimEventIdentity,
        ): List<AgentTranscriptLifecyclePersistedNotificationClaim> = emptyList()

        override fun insertNotificationClaim(
            claim: AgentTranscriptLifecyclePersistedNotificationClaim,
        ) = error("Notification claim is outside this consumer test")
    }
}

private fun fixtureWire(name: String): ByteArray {
    val resource = "extensions/agent-transcript-lifecycle/v1/golden-frames.json"
    val source = requireNotNull(
        AgentTranscriptLifecycleRuntimeConsumerTest::class.java.classLoader
            ?.getResourceAsStream(resource),
    ).bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
    val wrapper = RelayV2StrictJson.parseObject(
        "{\"fixtures\":$source}",
        RelayV2JsonLimits(64, 1_024, 100_000, 200_000),
    )
    val fixtures = wrapper["fixtures"] as List<*>
    val fixture = fixtures.filterIsInstance<Map<String, Any?>>()
        .single { it["name"] == name }
    return (fixture["wire"] as String).toByteArray(StandardCharsets.UTF_8)
}
