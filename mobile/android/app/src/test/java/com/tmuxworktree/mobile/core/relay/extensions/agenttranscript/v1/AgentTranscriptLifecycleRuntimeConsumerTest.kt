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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentTranscriptLifecycleRuntimeConsumerTest {
    @Test
    fun `unnegotiated input is neither decoded nor leased`() = runBlocking {
        val harness = Harness(sessionId = "session-shell", statusRequestId = "agent-status-2")

        val result = harness.runtime.consume(
            byteArrayOf(0xc3.toByte()),
            harness.fence(negotiated = false),
        )

        assertEquals(AgentTranscriptLifecycleRuntimeConsumeResult.ExtensionNotNegotiated, result)
        assertEquals(0, harness.lease.blockCount)
        assertTrue(harness.operations.controlCommands.isEmpty())
    }

    @Test
    fun `correlated unavailable waits for durable operation inside apply lease`() =
        runBlocking {
            val harness = Harness(sessionId = "session-shell", statusRequestId = "agent-status-2")
            val applyGate = harness.operations.blockNextApply()
            val applying = async(Dispatchers.Default) {
                harness.runtime.consume(
                    fixtureWire("status-unsupported-agent"),
                    harness.fence(),
                )
            }
            applyGate.entered.await()
            assertFalse(applying.isCompleted)
            assertTrue(harness.lease.insideBlock)
            applyGate.release.complete(Unit)

            val result = applying.await()
            assertTrue(result is AgentTranscriptLifecycleRuntimeConsumeResult.Applied)
            assertFalse(harness.lease.insideBlock)
            assertEquals(1, harness.lease.blockCount)
            val command = harness.operations.controlCommands.single()
            val input = command.input as AgentTranscriptLifecycleClientInput.StatusUnavailable
            assertEquals(
                AgentExtensionUnavailableReason.AGENT_UNSUPPORTED,
                input.reason,
            )
            assertEquals(AgentLocalRequestFence("1", "agent-status-2"), input.requestFence)
        }

    @Test
    fun `cursor bearing inputs close without lease or reduce`() = runBlocking {
        val harness = Harness(
            sessionId = "session-1",
            statusRequestId = "agent-status-1",
            timelineEpoch = "timeline-1",
        )
        val statusAvailable = fixtureWire("status-available")
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
                    AgentTranscriptLifecycleRuntimeUnavailableReason.INVALID_PUBLIC_FRAME,
                ),
                result,
            )
        }

        val fenceMismatches = listOf(
            FenceMismatchCase(
                "public session identity",
                statusAvailable.replaceSingleField(
                    "\"sessionId\":\"session-1\"",
                    "\"sessionId\":\"session-other\"",
                ),
                harness.fence(),
            ),
            FenceMismatchCase(
                "actor principal authority",
                statusAvailable,
                harness.fence(
                    authority = harness.authority.copy(principalId = "principal-other"),
                ),
            ),
            FenceMismatchCase(
                "trusted ingress",
                statusAvailable,
                harness.fence(ingress = AgentTranscriptLifecycleTrustedIngress.Live),
            ),
            FenceMismatchCase(
                "timeline lineage",
                fixtureWire("live-entry-redacted").replaceSingleField(
                    "\"timelineEpoch\":\"timeline-1\"",
                    "\"timelineEpoch\":\"timeline-other\"",
                ),
                harness.fence(ingress = AgentTranscriptLifecycleTrustedIngress.Live),
            ),
        )
        fenceMismatches.forEach { case ->
            val result = harness.runtime.consume(case.wire, case.fence)
            assertEquals(
                case.name,
                AgentTranscriptLifecycleRuntimeConsumeResult.Unavailable(
                    AgentTranscriptLifecycleRuntimeUnavailableReason.EXACT_FENCE_MISMATCH,
                ),
                result,
            )
            assertEquals(case.name, 0, harness.lease.blockCount)
            assertTrue(case.name, harness.operations.controlCommands.isEmpty())
        }

        assertEquals(0, harness.lease.blockCount)
        assertTrue(harness.operations.controlCommands.isEmpty())
    }

    private data class CursorCase(
        val fixture: String,
        val ingress: AgentTranscriptLifecycleTrustedIngress,
    )

    private data class FenceMismatchCase(
        val name: String,
        val wire: ByteArray,
        val fence: AgentTranscriptLifecycleRuntimeFence,
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
        val authority = RelayV2RepositoryEffectAuthority(
            generation = generation,
            profileId = "profile-1",
            profileActivationGeneration = 7,
            principalId = "principal-1",
            clientInstanceId = "client-1",
            hostId = "mac-admin",
            hostEpoch = "host-epoch-1",
        )
        val operations = RecordingDurableOperationPort()
        val lease = RecordingApplyLease(authority)
        val runtime = AgentTranscriptLifecycleRuntimeConsumer(lease, operations)
        private val namespace: AgentTranscriptLifecycleDurableNamespace

        init {
            namespace = AgentTranscriptLifecycleDurableNamespace(consumer, timelineEpoch)
        }

        fun fence(
            negotiated: Boolean = true,
            authority: RelayV2RepositoryEffectAuthority = this.authority,
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

private class RecordingDurableOperationPort : AgentTranscriptLifecycleDurableOperationPort {
    data class ApplyGate(
        val entered: CompletableDeferred<Unit> = CompletableDeferred(),
        val release: CompletableDeferred<Unit> = CompletableDeferred(),
    )

    val controlCommands = mutableListOf<AgentTranscriptLifecycleDurableControlCommand>()
    private var nextApplyGate: ApplyGate? = null

    fun blockNextApply(): ApplyGate = ApplyGate().also { nextApplyGate = it }

    override suspend fun applyControlUnderApplyLease(
        command: AgentTranscriptLifecycleDurableControlCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult {
        nextApplyGate?.also { gate ->
            nextApplyGate = null
            gate.entered.complete(Unit)
            gate.release.await()
        }
        controlCommands += command
        val unavailable = command.input as AgentTranscriptLifecycleClientInput.StatusUnavailable
        val initial = AgentTranscriptLifecycleClientState(
            identity = command.fence.expectedNamespace.consumer.sessionIdentity,
            extensionLane = AgentTranscriptLifecycleExtensionState(
                localGeneration = unavailable.requestFence.localGeneration,
                support = AgentExtensionSupport.UNKNOWN,
                unavailableReason = null,
                pendingStatusRequest = unavailable.requestFence,
            ),
        )
        return AgentTranscriptLifecycleDurableOperationResult(
            AgentTranscriptLifecycleClientReducer.reduce(initial, unavailable, limits),
        )
    }

    override suspend fun consumeLiveEventUnderApplyLease(
        command: AgentTranscriptLifecycleDurableLiveEventCommand,
        limits: AgentClientReducerLimits,
    ) = error("Live events are outside this runtime consumer suite")

    override suspend fun consumeReplayPageUnderApplyLease(
        command: AgentTranscriptLifecycleDurableReplayPageCommand,
        limits: AgentClientReducerLimits,
    ) = error("Replay pages are outside this runtime consumer suite")

    override suspend fun persistSnapshotRequestUnderApplyLease(
        command: AgentTranscriptLifecycleDurableSnapshotRequestCommand,
    ) = error("Snapshot requests are outside this runtime consumer suite")

    override suspend fun consumeSnapshotPageUnderApplyLease(
        command: AgentTranscriptLifecycleDurableSnapshotPageCommand,
        limits: AgentClientReducerLimits,
    ) = error("Snapshot pages are outside this runtime consumer suite")
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

private fun ByteArray.replaceSingleField(
    original: String,
    replacement: String,
): ByteArray {
    val source = toString(StandardCharsets.UTF_8)
    val first = source.indexOf(original)
    assertTrue("fixture must contain $original", first >= 0)
    assertEquals("fixture field must be unique", first, source.lastIndexOf(original))
    val changed = source.replace(original, replacement)
    assertFalse("fixture bytes must change", source == changed)
    assertTrue("fixture must contain $replacement", replacement in changed)
    return changed.toByteArray(StandardCharsets.UTF_8)
}
