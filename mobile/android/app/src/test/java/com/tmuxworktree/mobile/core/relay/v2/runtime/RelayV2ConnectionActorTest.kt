package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentLocalRequestFence
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleActorRequest
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleCompletedBatchHandoffReceipt
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleDurableRequestIdentity
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRequestAdmission
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRequestKind
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleCompletedHandoffReceipt
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleExactRedriveReplacement
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleTrustedIngress
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineErrorCode
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineErrorCommandDisposition
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineErrorFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineHostEpochMismatchDetails
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineReplayGetFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineReplayRequest
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotGetFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotRequest
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineResetFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineResetReason
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineStatusFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineStructuredError
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineUnavailableReason
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineUnavailableStatus
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1Codec
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1Frame
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2ContractFixtures
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2FrameMetadata
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2WebSocketChannel
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAction
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxArguments
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAuthorityCore
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxDraft
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxResult
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxState
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialBlob
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialCasExpectation
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialCasResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialReference
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialStore
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.state.FakeStateStore
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxAuthorityNamespace
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxBatchResult
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxRecoveryAuthority
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AppliedCursor
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeKind
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeReachability
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeResource
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SessionKind
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SessionResource
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SnapshotChunk
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SnapshotRecord
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateChange
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateHello
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateHelloDisposition
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateNamespace
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateSyncRepositoryCore
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StoredSyncPhase
import com.tmuxworktree.mobile.core.relay.v2.state.canonicalSnapshotDigest
import java.util.UUID
import java.util.concurrent.CancellationException
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2ConnectionActorTest {
    private val codec = RelayV2Codec()
    private val agentExtensionCodec = AgentTranscriptLifecycleV1Codec()
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
    fun `optional agent capability is explicit and requires broker host intersection`() =
        runBlocking {
            assertEquals(6, RelayV2ConnectionActor.REQUIRED_CAPABILITIES.size)
            assertFalse(
                AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY in
                    RelayV2ConnectionActor.REQUIRED_CAPABILITIES,
            )

            val defaultHarness = Harness()
            try {
                assertEquals(
                    RelayV2CurrentRepositoryReadCutResult.Unavailable,
                    defaultHarness.actor.currentRepositoryReadCut(
                        RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE,
                    ),
                )
                val hello = defaultHarness.connectThroughRelayWelcome(null)
                assertEquals(
                    RelayV2ConnectionActor.REQUIRED_CAPABILITIES,
                    hello.payload().stringList("capabilities"),
                )
                assertEquals(
                    RelayV2CurrentRepositoryReadCutResult.Unavailable,
                    defaultHarness.actor.currentRepositoryReadCut(
                        RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE,
                    ),
                )
            } finally {
                defaultHarness.close()
            }

            listOf(false to true, true to false, true to true).forEach { (broker, host) ->
                val harness = Harness(
                    optionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
                )
                try {
                    val brokerOptional = if (broker) {
                        setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY)
                    } else {
                        emptySet()
                    }
                    val hello = harness.connectThroughRelayWelcome(
                        resume = null,
                        brokerOptionalCapabilities = brokerOptional,
                    )
                    assertEquals(
                        RelayV2ConnectionActor.REQUIRED_CAPABILITIES +
                            AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
                        hello.payload().stringList("capabilities"),
                    )
                    assertEquals(
                        RelayV2ConnectionActor.REQUIRED_CAPABILITIES,
                        hello.payload().stringList("requiredCapabilities"),
                    )
                    assertEquals(
                        RelayV2CurrentRepositoryReadCutResult.Unavailable,
                        harness.actor.currentRepositoryReadCut(
                            RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE,
                        ),
                    )
                    val welcome = fixture("host-welcome-snapshot-required")
                    welcome["requestId"] = hello.stringValue("requestId")
                    welcome.payload()["capabilities"] =
                        RelayV2ConnectionActor.REQUIRED_CAPABILITIES +
                        if (host) listOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY) else emptyList()
                    harness.transport().sendFrame(welcome)
                    val effect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                        as RelayV2RuntimeEffect.BeginStateResync
                    assertEquals(
                        broker && host,
                        AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY in
                            effect.context.negotiatedCapabilities,
                    )
                    when (val result = harness.actor.currentRepositoryReadCut(
                        RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE,
                    )) {
                        is RelayV2CurrentRepositoryReadCutResult.Available -> {
                            assertTrue(broker && host)
                            assertEquals(effect.repositoryAuthority, result.cut.authority)
                            assertEquals(
                                RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE,
                                result.cut.capability,
                            )
                            val authority = result.cut.authority
                            assertEquals(harness.profile.profileId, authority.profileId)
                            assertEquals(
                                harness.profile.activationGeneration,
                                authority.profileActivationGeneration,
                            )
                            assertEquals(authority.profileId, authority.generation.profileId)
                            assertEquals(
                                authority.profileActivationGeneration,
                                authority.generation.profileGeneration,
                            )
                            assertTrue(authority.generation.connectionGeneration > 0)
                            assertEquals(harness.profile.principalId, authority.principalId)
                            assertEquals(
                                harness.profile.clientInstanceId,
                                authority.clientInstanceId,
                            )
                            assertEquals(harness.profile.hostId, authority.hostId)
                            assertEquals(HOST_EPOCH, authority.hostEpoch)
                        }
                        RelayV2CurrentRepositoryReadCutResult.Unavailable ->
                            assertFalse(broker && host)
                    }
                } finally {
                    harness.close()
                }
            }

            val failedHarness = Harness(
                optionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
            )
            try {
                failedHarness.negotiateAgentExtension(RelayV2ConnectionPhase.RESYNCING)
                assertTrue(
                    failedHarness.actor.currentRepositoryReadCut(
                        RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE,
                    ) is RelayV2CurrentRepositoryReadCutResult.Available,
                )
                failedHarness.transport().fail(
                    RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK),
                )
                failedHarness.actor.awaitFailure(RelayV2FailureKind.TRANSPORT)
                assertEquals(
                    RelayV2CurrentRepositoryReadCutResult.Unavailable,
                    failedHarness.actor.currentRepositoryReadCut(
                        RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE,
                    ),
                )
            } finally {
                failedHarness.close()
            }

            val disconnectedHarness = Harness(
                optionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
            )
            try {
                disconnectedHarness.negotiateAgentExtension(RelayV2ConnectionPhase.RESYNCING)
                disconnectedHarness.actor.disconnectAndDrain(
                    disconnectedHarness.profile.identity,
                    "read-cut-disconnected",
                )
                assertEquals(
                    RelayV2CurrentRepositoryReadCutResult.Unavailable,
                    disconnectedHarness.actor.currentRepositoryReadCut(
                        RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE,
                    ),
                )
            } finally {
                disconnectedHarness.close()
            }
        }

    @Test
    fun `negotiated agent frames use strict artifacts and isolate correlation faults`() =
        runBlocking {
            val harness = Harness(
                optionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
            )
            try {
                val hello = harness.connectThroughRelayWelcome(
                    resume = null,
                    brokerOptionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
                )
                val welcome = fixture("host-welcome-snapshot-required")
                welcome["requestId"] = hello.stringValue("requestId")
                welcome.payload()["capabilities"] =
                    RelayV2ConnectionActor.REQUIRED_CAPABILITIES +
                    AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY
                harness.transport().sendFrame(welcome)
                val handshake = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.BeginStateResync

                val statusRequest = AgentTranscriptLifecycleActorRequest.Status(
                    authority = handshake.repositoryAuthority,
                    frame = com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineStatusGetFrame(
                        requestId = "agent-status-runtime-1",
                        hostId = HOST_ID,
                        expectedHostEpoch = HOST_EPOCH,
                        scopeId = "scope-local",
                        sessionId = "session-1",
                    ),
                    requestFence = AgentLocalRequestFence("1", "agent-status-runtime-1"),
                )
                assertTrue(harness.actor.send(statusRequest) != null)
                assertEquals(
                    statusRequest.frame,
                    harness.transport().awaitAgentSentFrame(1),
                )

                harness.transport().sendAgentFrame(
                    AgentTimelineStatusFrame(
                        requestId = "agent-status-runtime-1",
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        scopeId = "scope-local",
                        sessionId = "session-1",
                        status = AgentTimelineUnavailableStatus(
                            AgentTimelineUnavailableReason.AGENT_UNSUPPORTED,
                        ),
                    ),
                )
                val delivered = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.DeliverAgentExtensionFrame
                assertTrue(
                    delivered.ingress is AgentTranscriptLifecycleTrustedIngress.CorrelatedStatus,
                )
                assertEquals("agent.timeline.status", delivered.artifact.type)
                assertTrue(
                    harness.actor.acceptDurableHandoff(
                        completedHandoff(requireNotNull(delivered.requestAdmission)),
                    ),
                )

                val replayRequest = AgentTranscriptLifecycleActorRequest.Replay(
                    authority = handshake.repositoryAuthority,
                    frame = AgentTimelineReplayGetFrame(
                        requestId = "agent-replay-runtime-1",
                        hostId = HOST_ID,
                        expectedHostEpoch = HOST_EPOCH,
                        scopeId = "scope-local",
                        sessionId = "session-1",
                        request = AgentTimelineReplayRequest(
                            timelineEpoch = "timeline-1",
                            afterAgentSeq = "8",
                            cursor = null,
                            limit = 256,
                        ),
                    ),
                )
                assertTrue(harness.actor.send(replayRequest) != null)
                assertEquals(replayRequest.frame, harness.transport().awaitAgentSentFrame(2))
                harness.transport().sendAgentFrame(
                    AgentTimelineErrorFrame(
                        requestId = "agent-replay-runtime-1",
                        hostId = HOST_ID,
                        hostEpoch = "host-epoch-runtime-actual",
                        scopeId = "scope-local",
                        sessionId = "session-1",
                        error = AgentTimelineStructuredError(
                            code = AgentTimelineErrorCode.HOST_EPOCH_MISMATCH,
                            message = "host epoch changed",
                            retryable = false,
                            commandDisposition =
                                AgentTimelineErrorCommandDisposition.NOT_APPLICABLE,
                            details = AgentTimelineHostEpochMismatchDetails(
                                expectedHostEpoch = HOST_EPOCH,
                                actualHostEpoch = "host-epoch-runtime-actual",
                            ),
                        ),
                    ),
                )
                val correlatedError = withTimeout(TIMEOUT_MS) {
                    harness.actor.effects.first()
                } as RelayV2RuntimeEffect.DeliverAgentExtensionFrame
                assertTrue(
                    correlatedError.ingress is
                        AgentTranscriptLifecycleTrustedIngress.CorrelatedError,
                )
                assertTrue(
                    harness.actor.acceptDurableHandoff(
                        completedHandoff(requireNotNull(correlatedError.requestAdmission)),
                    ),
                )

                harness.transport().sendAgentFrame(
                    AgentTimelineStatusFrame(
                        requestId = "agent-status-uncorrelated",
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        scopeId = "scope-local",
                        sessionId = "session-1",
                        status = AgentTimelineUnavailableStatus(
                            AgentTimelineUnavailableReason.AGENT_UNSUPPORTED,
                        ),
                    ),
                )
                val isolated = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.AgentExtensionUnavailable
                assertEquals(
                    RelayV2AgentExtensionUnavailableReason.UNCORRELATED_RESPONSE,
                    isolated.reason,
                )

                harness.transport().sendAgentFrame(
                    AgentTimelineResetFrame(
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        scopeId = "scope-local",
                        sessionId = "session-1",
                        previousTimelineEpoch = "timeline-1",
                        newTimelineEpoch = "timeline-2",
                        reason = AgentTimelineResetReason.DELETED,
                    ),
                )
                val live = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.DeliverAgentExtensionFrame
                assertEquals(AgentTranscriptLifecycleTrustedIngress.Live, live.ingress)
                assertEquals(RelayV2ConnectionPhase.RESYNCING, harness.actor.state.value.phase)
                assertTrue(harness.transport().closeCodes.isEmpty())

                harness.transport().sendAgentFrame(
                    AgentTimelineErrorFrame(
                        requestId = "base-error-not-agent-pending",
                        hostId = HOST_ID,
                        hostEpoch = "host-epoch-base-actual",
                        scopeId = "scope-local",
                        sessionId = "session-1",
                        error = AgentTimelineStructuredError(
                            code = AgentTimelineErrorCode.HOST_EPOCH_MISMATCH,
                            message = "base request host epoch changed",
                            retryable = false,
                            commandDisposition =
                                AgentTimelineErrorCommandDisposition.NOT_APPLICABLE,
                            details = AgentTimelineHostEpochMismatchDetails(
                                expectedHostEpoch = HOST_EPOCH,
                                actualHostEpoch = "host-epoch-base-actual",
                            ),
                        ),
                    ),
                )
                val baseFailure = harness.actor.awaitFailure(RelayV2FailureKind.SCHEMA)
                assertEquals("INVALID_ENVELOPE", baseFailure.failure?.code)
                assertEquals(4400, harness.transport().closeCodes.single())
            } finally {
                harness.close()
            }
        }

    @Test
    fun `agent admission reserves exact request capacity until durable handoff`() = runBlocking {
        val harness = Harness(
            optionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
        )
        try {
            val authority = harness.negotiateAgentExtension(RelayV2ConnectionPhase.RESYNCING)
            val requests = (1..64).map { index ->
                agentStatusRequest(authority, "agent-capacity-$index")
            }
            val admissions = requests.map { request ->
                requireNotNull(harness.actor.send(request))
            }

            assertNull(harness.actor.send(agentStatusRequest(authority, "agent-capacity-65")))
            assertNull(harness.actor.send(requests.first()))
            assertEquals(requests.last().frame, harness.transport().awaitAgentSentFrame(64))

            harness.transport().sendAgentFrame(
                agentUnavailableStatus(requests.first().requestId),
            )
            val delivered = withTimeout(TIMEOUT_MS) {
                harness.actor.effects.first {
                    it is RelayV2RuntimeEffect.DeliverAgentExtensionFrame
                }
            } as RelayV2RuntimeEffect.DeliverAgentExtensionFrame
            assertEquals(admissions.first(), delivered.requestAdmission)
            assertNull(harness.actor.send(requests.first()))

            assertTrue(
                harness.actor.acceptDurableHandoff(completedHandoff(admissions.first())),
            )
            assertFalse(
                harness.actor.acceptDurableHandoff(completedHandoff(admissions.first())),
            )
            assertNull(harness.actor.send(requests.first()))
            harness.transport().sendAgentFrame(hostEpochMismatch(requests.first().requestId))
            val lateCompleted = withTimeout(TIMEOUT_MS) {
                harness.actor.effects.first {
                    it is RelayV2RuntimeEffect.AgentExtensionUnavailable
                }
            } as RelayV2RuntimeEffect.AgentExtensionUnavailable
            assertEquals(
                RelayV2AgentExtensionUnavailableReason.UNCORRELATED_RESPONSE,
                lateCompleted.reason,
            )
            assertTrue(
                harness.actor.send(agentStatusRequest(authority, "agent-capacity-fresh")) != null,
            )
            assertEquals(RelayV2ConnectionPhase.RESYNCING, harness.actor.state.value.phase)
            assertTrue(harness.transport().closeCodes.isEmpty())

            harness.transport().fail(
                RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK),
            )
            harness.actor.awaitFailure(RelayV2FailureKind.TRANSPORT)
            val replacementAuthority = harness.negotiateAgentExtension(
                RelayV2ConnectionPhase.RESYNCING,
            )
            assertFalse(replacementAuthority.generation == authority.generation)
            assertTrue(
                harness.actor.send(
                    agentStatusRequest(replacementAuthority, requests.first().requestId),
                ) != null,
            )
        } finally {
            harness.close()
        }
    }

    @Test
    fun `queued agent admission is revoked without send when generation changes`() = runBlocking {
        val sendEntered = CompletableDeferred<Unit>()
        val releaseSend = CompletableDeferred<Unit>()
        val harness = Harness(
            optionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
            beforeAgentExtensionRequestSend = {
                sendEntered.complete(Unit)
                releaseSend.await()
            },
        )
        try {
            val authority = harness.negotiateAgentExtension(RelayV2ConnectionPhase.RESYNCING)
            val admission = requireNotNull(
                harness.actor.send(agentStatusRequest(authority, "agent-generation-old")),
            )
            sendEntered.await()

            val oldTransport = harness.transport()
            oldTransport.fail(
                RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK),
            )
            harness.actor.awaitFailure(RelayV2FailureKind.TRANSPORT)
            releaseSend.complete(Unit)
            delay(25)

            assertEquals(1, oldTransport.sent.size)
            assertFalse(harness.actor.acceptDurableHandoff(completedHandoff(admission)))
            assertEquals(RelayV2ConnectionPhase.FAILED, harness.actor.state.value.phase)

            val replacementAuthority = harness.negotiateAgentExtension(
                RelayV2ConnectionPhase.RESYNCING,
            )
            assertFalse(replacementAuthority.generation == admission.authority.generation)
            oldTransport.sendAgentFrame(agentUnavailableStatus(admission.requestId))
            assertEquals(null, withTimeoutOrNull(50) { harness.actor.effects.first() })
            assertEquals(1, harness.transport().sent.size)
            assertEquals(RelayV2ConnectionPhase.RESYNCING, harness.actor.state.value.phase)
        } finally {
            releaseSend.complete(Unit)
            harness.close()
        }
    }

    @Test
    fun `agent socket failure and timeout isolate exact durable retry identity`() = runBlocking {
        val failedSendHarness = Harness(
            optionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
        )
        try {
            val authority = failedSendHarness.negotiateAgentExtension(
                RelayV2ConnectionPhase.RESYNCING,
            )
            val request = agentStatusRequest(authority, "agent-send-retry-exact")
            failedSendHarness.transport().sendResult = false
            val failedAdmission = requireNotNull(failedSendHarness.actor.send(request))
            val unavailable = withTimeout(TIMEOUT_MS) {
                failedSendHarness.actor.effects.first {
                    it is RelayV2RuntimeEffect.AgentExtensionUnavailable
                }
            } as RelayV2RuntimeEffect.AgentExtensionUnavailable
            assertEquals(
                RelayV2AgentExtensionUnavailableReason.REQUEST_SEND_FAILED,
                unavailable.reason,
            )
            assertEquals(request, unavailable.failedRequest)
            assertEquals(failedAdmission, unavailable.requestAdmission)
            failedSendHarness.transport().sendResult = true
            assertNull(failedSendHarness.actor.send(request))
            val replacementAdmission = requireNotNull(
                failedSendHarness.actor.replaceForExactRedrive(
                    AgentTranscriptLifecycleExactRedriveReplacement(failedAdmission, request),
                ),
            )
            assertNull(
                failedSendHarness.actor.replaceForExactRedrive(
                    AgentTranscriptLifecycleExactRedriveReplacement(failedAdmission, request),
                ),
            )
            assertTrue(replacementAdmission.admissionSequence > failedAdmission.admissionSequence)
            assertEquals(request.frame, failedSendHarness.transport().awaitAgentSentFrame(2))
            assertEquals(
                RelayV2ConnectionPhase.RESYNCING,
                failedSendHarness.actor.state.value.phase,
            )
            assertTrue(failedSendHarness.transport().closeCodes.isEmpty())

            failedSendHarness.transport().fail(
                RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK),
            )
            failedSendHarness.actor.awaitFailure(RelayV2FailureKind.TRANSPORT)
            val replacementAuthority = failedSendHarness.negotiateAgentExtension(
                RelayV2ConnectionPhase.RESYNCING,
            )
            assertFalse(replacementAuthority.generation == authority.generation)
            assertTrue(
                failedSendHarness.actor.send(
                    agentStatusRequest(replacementAuthority, request.requestId),
                ) != null,
            )
        } finally {
            failedSendHarness.close()
        }

        val watchdog = ManualWatchdog()
        val timeoutHarness = Harness(
            optionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
            extensionRequestWatchdogDelay = watchdog::await,
        )
        try {
            val authority = timeoutHarness.negotiateAgentExtension(
                RelayV2ConnectionPhase.RESYNCING,
            )
            val request = agentStatusRequest(authority, "agent-timeout-retry-exact")
            val timedOutAdmission = requireNotNull(timeoutHarness.actor.send(request))
            assertEquals(request.frame, timeoutHarness.transport().awaitAgentSentFrame(1))
            watchdog.fire(0)
            val unavailable = withTimeout(TIMEOUT_MS) {
                timeoutHarness.actor.effects.first {
                    it is RelayV2RuntimeEffect.AgentExtensionUnavailable
                }
            } as RelayV2RuntimeEffect.AgentExtensionUnavailable
            assertEquals(
                RelayV2AgentExtensionUnavailableReason.REQUEST_TIMEOUT,
                unavailable.reason,
            )
            assertEquals(request, unavailable.failedRequest)
            assertEquals(timedOutAdmission, unavailable.requestAdmission)
            val sentBeforeRedelivery = timeoutHarness.transport().sent.size
            val redelivered = withTimeout(TIMEOUT_MS) {
                timeoutHarness.actor.effects.first {
                    it is RelayV2RuntimeEffect.AgentExtensionUnavailable &&
                        it.requestAdmission == timedOutAdmission
                }
            } as RelayV2RuntimeEffect.AgentExtensionUnavailable
            assertEquals(unavailable, redelivered)
            assertEquals(sentBeforeRedelivery, timeoutHarness.transport().sent.size)
            assertNull(timeoutHarness.actor.send(request))
            assertTrue(
                timeoutHarness.actor.replaceForExactRedrive(
                    AgentTranscriptLifecycleExactRedriveReplacement(timedOutAdmission, request),
                ) != null,
            )
            assertEquals(request.frame, timeoutHarness.transport().awaitAgentSentFrame(2))
            assertEquals(RelayV2ConnectionPhase.RESYNCING, timeoutHarness.actor.state.value.phase)
            assertTrue(timeoutHarness.transport().closeCodes.isEmpty())
        } finally {
            timeoutHarness.close()
        }
    }

    @Test
    fun `exact redrive atomically swaps owner before queued late error is routed`() = runBlocking {
        val sendCalls = AtomicInteger()
        val replacementSendEntered = CompletableDeferred<Unit>()
        val releaseReplacementSend = CompletableDeferred<Unit>()
        val redriveEnqueued = CountDownLatch(1)
        val releaseRedriveSwap = CountDownLatch(1)
        val captureLateCallback = AtomicBoolean(false)
        val lateCallbackAdmitted = CompletableDeferred<Unit>()
        val harness = Harness(
            optionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
            beforeAgentExtensionRequestSend = {
                if (sendCalls.incrementAndGet() == 2) {
                    replacementSendEntered.complete(Unit)
                    releaseReplacementSend.await()
                }
            },
            afterAgentExtensionRedriveEnqueuedBeforeSwap = {
                redriveEnqueued.countDown()
                check(releaseRedriveSwap.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            },
            afterCallbackAdmission = {
                if (captureLateCallback.get()) lateCallbackAdmitted.complete(Unit)
            },
        )
        try {
            val authority = harness.negotiateAgentExtension(RelayV2ConnectionPhase.ONLINE)
            val request = agentStatusRequest(authority, "agent-atomic-redrive")
            harness.transport().sendResult = false
            val oldAdmission = requireNotNull(harness.actor.send(request))
            val failed = withTimeout(TIMEOUT_MS) {
                harness.actor.effects.first {
                    it is RelayV2RuntimeEffect.AgentExtensionUnavailable &&
                        it.requestAdmission == oldAdmission
                }
            } as RelayV2RuntimeEffect.AgentExtensionUnavailable
            assertEquals(RelayV2AgentExtensionUnavailableReason.REQUEST_SEND_FAILED, failed.reason)

            harness.transport().sendResult = true
            val replacing = async(Dispatchers.Default) {
                harness.actor.replaceForExactRedrive(
                    AgentTranscriptLifecycleExactRedriveReplacement(oldAdmission, request),
                )
            }
            assertTrue(redriveEnqueued.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            captureLateCallback.set(true)
            val lateFrame = async(Dispatchers.Default) {
                harness.transport().sendAgentFrame(hostEpochMismatch(request.requestId))
            }
            lateCallbackAdmitted.await()
            releaseRedriveSwap.countDown()

            val newAdmission = requireNotNull(replacing.await())
            lateFrame.await()
            replacementSendEntered.await()
            val isolated = withTimeout(TIMEOUT_MS) {
                harness.actor.effects.first {
                    it is RelayV2RuntimeEffect.AgentExtensionUnavailable &&
                        it.reason == RelayV2AgentExtensionUnavailableReason.UNCORRELATED_RESPONSE
                }
            } as RelayV2RuntimeEffect.AgentExtensionUnavailable
            assertNull(isolated.requestAdmission)
            assertFalse(harness.actor.acceptDurableHandoff(completedHandoff(oldAdmission)))
            assertNull(
                harness.actor.replaceForExactRedrive(
                    AgentTranscriptLifecycleExactRedriveReplacement(oldAdmission, request),
                ),
            )
            assertEquals(request.requestId, newAdmission.requestId)
            assertTrue(newAdmission.admissionSequence > oldAdmission.admissionSequence)
            assertEquals(RelayV2ConnectionPhase.ONLINE, harness.actor.state.value.phase)
            assertTrue(harness.transport().closeCodes.isEmpty())

            harness.transport().sendFixture("host-presence-online")
            val base = withTimeout(TIMEOUT_MS) {
                harness.actor.effects.first {
                    it is RelayV2RuntimeEffect.DeliverPostHandshakeFrame
                }
            } as RelayV2RuntimeEffect.DeliverPostHandshakeFrame
            assertEquals("host.presence", base.message.frame["type"])
        } finally {
            releaseRedriveSwap.countDown()
            releaseReplacementSend.complete(Unit)
            harness.close()
        }
    }

    @Test
    fun `queued extension owner isolates overlapping and impossible error throughout recovery`() =
        runBlocking {
            listOf(
                RelayV2ConnectionPhase.QUERYING,
                RelayV2ConnectionPhase.RESYNCING,
            ).forEach { phase ->
                val sendEntered = CompletableDeferred<Unit>()
                val releaseSend = CompletableDeferred<Unit>()
                val harness = Harness(
                    optionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
                    beforeAgentExtensionRequestSend = {
                        sendEntered.complete(Unit)
                        releaseSend.await()
                    },
                )
                try {
                    val authority = harness.negotiateAgentExtension(phase)
                    val request = agentStatusRequest(authority, "agent-queued-owner-${phase.name}")
                    requireNotNull(harness.actor.send(request))
                    sendEntered.await()
                    listOf(
                        hostEpochMismatch(request.requestId),
                        hostEpochMismatch(request.requestId).copy(scopeId = "scope-impossible"),
                    ).forEach { frame ->
                        harness.transport().sendAgentFrame(frame)
                        val isolated = withTimeout(TIMEOUT_MS) {
                            harness.actor.effects.first {
                                it is RelayV2RuntimeEffect.AgentExtensionUnavailable
                            }
                        } as RelayV2RuntimeEffect.AgentExtensionUnavailable
                        assertEquals(
                            RelayV2AgentExtensionUnavailableReason.UNCORRELATED_RESPONSE,
                            isolated.reason,
                        )
                        assertNull(isolated.requestAdmission)
                        assertEquals(phase, harness.actor.state.value.phase)
                        assertTrue(harness.transport().closeCodes.isEmpty())
                    }
                } finally {
                    releaseSend.complete(Unit)
                    harness.close()
                }
            }
        }

    @Test
    fun `failed atomic redrive admission retains old owner for one successful retry`() = runBlocking {
        val sendCalls = AtomicInteger()
        val blockerEntered = CompletableDeferred<Unit>()
        val releaseBlocker = CompletableDeferred<Unit>()
        val oldRequestId = "agent-redrive-aaaaaaaa"
        val probeRequestId = "agent-redrive-bbbbbbbb"
        val freshRequestId = "agent-redrive-cccccccc"
        val responseBytes = agentExtensionCodec
            .encodePublicFrame(agentUnavailableStatus(oldRequestId))
            .size
            .toLong()
        val harness = Harness(
            optionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
            extensionActionCapacity = 1,
            extensionEffectByteCapacity = responseBytes,
            beforeAgentExtensionRequestSend = {
                if (sendCalls.incrementAndGet() == 2) {
                    blockerEntered.complete(Unit)
                    releaseBlocker.await()
                }
            },
        )
        try {
            val authority = harness.negotiateAgentExtension(RelayV2ConnectionPhase.RESYNCING)
            val request = agentStatusRequest(authority, oldRequestId)
            val oldAdmission = requireNotNull(harness.actor.send(request))
            assertEquals(request.frame, harness.transport().awaitAgentSentFrame(1))
            harness.transport().sendAgentFrame(agentUnavailableStatus(request.requestId))
            val oldDelivery = withTimeout(TIMEOUT_MS) {
                harness.actor.effects.first {
                    it is RelayV2RuntimeEffect.DeliverAgentExtensionFrame &&
                        it.requestAdmission == oldAdmission
                }
            } as RelayV2RuntimeEffect.DeliverAgentExtensionFrame
            assertEquals(oldAdmission, oldDelivery.requestAdmission)

            val blocker = agentStatusRequest(authority, "agent-redrive-dddddddd")
            val filler = agentStatusRequest(authority, "agent-redrive-eeeeeeee")
            requireNotNull(harness.actor.send(blocker))
            blockerEntered.await()
            requireNotNull(harness.actor.send(filler))
            assertNull(
                harness.actor.replaceForExactRedrive(
                    AgentTranscriptLifecycleExactRedriveReplacement(oldAdmission, request),
                ),
            )
            assertNull(harness.actor.send(request))

            releaseBlocker.complete(Unit)
            assertEquals(filler.frame, harness.transport().awaitAgentSentFrame(3))
            val probe = agentStatusRequest(authority, probeRequestId)
            val probeAdmission = requireNotNull(harness.actor.send(probe))
            assertEquals(probe.frame, harness.transport().awaitAgentSentFrame(4))
            harness.transport().sendAgentFrame(agentUnavailableStatus(probe.requestId))
            val saturated = withTimeout(TIMEOUT_MS) {
                harness.actor.effects.first {
                    it is RelayV2RuntimeEffect.AgentExtensionUnavailable &&
                        it.requestAdmission == probeAdmission
                }
            } as RelayV2RuntimeEffect.AgentExtensionUnavailable
            assertEquals(
                RelayV2AgentExtensionUnavailableReason.EFFECT_QUEUE_SATURATED,
                saturated.reason,
            )

            val replacement = requireNotNull(
                harness.actor.replaceForExactRedrive(
                    AgentTranscriptLifecycleExactRedriveReplacement(oldAdmission, request),
                ),
            )
            assertEquals(request.frame, harness.transport().awaitAgentSentFrame(5))
            assertEquals(request.requestId, replacement.requestId)
            assertEquals(probeAdmission.admissionSequence + 1, replacement.admissionSequence)
            assertFalse(harness.actor.acceptDurableHandoff(completedHandoff(oldAdmission)))
            assertNull(
                harness.actor.replaceForExactRedrive(
                    AgentTranscriptLifecycleExactRedriveReplacement(oldAdmission, request),
                ),
            )
            val fresh = agentStatusRequest(authority, freshRequestId)
            val freshAdmission = requireNotNull(harness.actor.send(fresh))
            assertEquals(fresh.frame, harness.transport().awaitAgentSentFrame(6))
            harness.transport().sendAgentFrame(agentUnavailableStatus(fresh.requestId))
            val freshDelivery = withTimeout(TIMEOUT_MS) {
                harness.actor.effects.first {
                    it is RelayV2RuntimeEffect.DeliverAgentExtensionFrame &&
                        it.requestAdmission == freshAdmission
                }
            } as RelayV2RuntimeEffect.DeliverAgentExtensionFrame
            assertEquals(freshAdmission, freshDelivery.requestAdmission)
            assertTrue(harness.actor.acceptDurableHandoff(completedHandoff(freshAdmission)))
            assertEquals(RelayV2ConnectionPhase.RESYNCING, harness.actor.state.value.phase)
            assertTrue(harness.transport().closeCodes.isEmpty())
        } finally {
            releaseBlocker.complete(Unit)
            harness.close()
        }
    }

    @Test
    fun `correlated handoff nack retains bytes and redelivers without socket resend`() = runBlocking {
        val firstFrame = agentUnavailableStatus("agent-nack-one")
        val byteCapacity = agentExtensionCodec.encodePublicFrame(firstFrame).size.toLong()
        val harness = Harness(
            optionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
            extensionEffectByteCapacity = byteCapacity,
        )
        try {
            val authority = harness.negotiateAgentExtension(RelayV2ConnectionPhase.ONLINE)
            val firstRequest = agentStatusRequest(authority, "agent-nack-one")
            val firstAdmission = requireNotNull(harness.actor.send(firstRequest))
            assertEquals(firstRequest.frame, harness.transport().awaitAgentSentFrame(1))
            harness.transport().sendAgentFrame(firstFrame)

            val firstDelivery = withTimeout(TIMEOUT_MS) {
                harness.actor.effects.first {
                    it is RelayV2RuntimeEffect.DeliverAgentExtensionFrame
                }
            } as RelayV2RuntimeEffect.DeliverAgentExtensionFrame
            assertEquals(firstAdmission, firstDelivery.requestAdmission)

            val secondRequest = agentStatusRequest(authority, "agent-nack-two")
            val secondAdmission = requireNotNull(harness.actor.send(secondRequest))
            assertEquals(secondRequest.frame, harness.transport().awaitAgentSentFrame(2))
            harness.transport().sendAgentFrame(agentUnavailableStatus(secondRequest.requestId))
            val saturated = withTimeout(TIMEOUT_MS) {
                harness.actor.effects.first {
                    it is RelayV2RuntimeEffect.AgentExtensionUnavailable &&
                        it.requestAdmission == secondAdmission
                }
            } as RelayV2RuntimeEffect.AgentExtensionUnavailable
            assertEquals(
                RelayV2AgentExtensionUnavailableReason.EFFECT_QUEUE_SATURATED,
                saturated.reason,
            )
            assertTrue(
                harness.actor.replaceForExactRedrive(
                    AgentTranscriptLifecycleExactRedriveReplacement(
                        secondAdmission,
                        secondRequest,
                    ),
                ) != null,
            )
            assertEquals(secondRequest.frame, harness.transport().awaitAgentSentFrame(3))

            val sentBeforeRedelivery = harness.transport().sent.size
            val redelivered = withTimeout(TIMEOUT_MS) {
                harness.actor.effects.first {
                    it is RelayV2RuntimeEffect.DeliverAgentExtensionFrame &&
                        it.requestAdmission == firstAdmission
                }
            } as RelayV2RuntimeEffect.DeliverAgentExtensionFrame
            assertEquals(firstDelivery.artifact, redelivered.artifact)
            assertEquals(sentBeforeRedelivery, harness.transport().sent.size)
            assertTrue(harness.actor.acceptDurableHandoff(completedHandoff(firstAdmission)))
            val freshRequest = agentStatusRequest(authority, "agent-nack-new")
            val freshAdmission = requireNotNull(harness.actor.send(freshRequest))
            assertEquals(freshRequest.frame, harness.transport().awaitAgentSentFrame(4))
            harness.transport().sendAgentFrame(agentUnavailableStatus(freshRequest.requestId))
            val freshDelivery = withTimeout(TIMEOUT_MS) {
                harness.actor.effects.first {
                    it is RelayV2RuntimeEffect.DeliverAgentExtensionFrame &&
                        it.requestAdmission == freshAdmission
                }
            } as RelayV2RuntimeEffect.DeliverAgentExtensionFrame
            assertEquals(freshAdmission, freshDelivery.requestAdmission)
            assertTrue(harness.actor.acceptDurableHandoff(completedHandoff(freshAdmission)))
            assertEquals(RelayV2ConnectionPhase.ONLINE, harness.actor.state.value.phase)
            assertTrue(harness.transport().closeCodes.isEmpty())
        } finally {
            harness.close()
        }
    }

    @Test
    fun `correlated error receipt retires status and snapshot sibling exactly`() =
        runBlocking {
            listOf(RelayV2ConnectionPhase.ONLINE, RelayV2ConnectionPhase.RESYNCING).forEach { phase ->
                val harness = Harness(
                    optionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
                )
                try {
                    val authority = harness.negotiateAgentExtension(phase)
                    val status = agentStatusRequest(authority, "retired-status-${phase.name}")
                    val snapshot = agentSnapshotRequest(authority, "retired-snapshot-${phase.name}")
                    val statusAdmission = requireNotNull(harness.actor.send(status))
                    val snapshotAdmission = requireNotNull(harness.actor.send(snapshot))
                    assertEquals(status.frame, harness.transport().awaitAgentSentFrame(1))
                    assertEquals(snapshot.frame, harness.transport().awaitAgentSentFrame(2))
                    harness.transport().sendAgentFrame(agentUnavailableStatus(status.requestId))
                    harness.transport().sendAgentFrame(hostEpochMismatch(snapshot.requestId))
                    val error = withTimeout(TIMEOUT_MS) {
                        harness.actor.effects.first {
                            it is RelayV2RuntimeEffect.DeliverAgentExtensionFrame &&
                                it.requestAdmission == snapshotAdmission
                        }
                    } as RelayV2RuntimeEffect.DeliverAgentExtensionFrame

                    assertTrue(
                        harness.actor.acceptDurableHandoff(
                            AgentTranscriptLifecycleCompletedBatchHandoffReceipt(
                                authority = authority,
                                scopeId = snapshot.scopeId,
                                sessionId = snapshot.sessionId,
                                triggeringAdmission = requireNotNull(error.requestAdmission),
                                retiredRequests = listOf(
                                    AgentTranscriptLifecycleDurableRequestIdentity(
                                        AgentTranscriptLifecycleRequestKind.STATUS,
                                        status.requestId,
                                    ),
                                    AgentTranscriptLifecycleDurableRequestIdentity(
                                        AgentTranscriptLifecycleRequestKind.SNAPSHOT,
                                        snapshot.requestId,
                                    ),
                                ),
                            ),
                        ),
                    )
                    assertFalse(
                        harness.actor.acceptDurableHandoff(completedHandoff(statusAdmission)),
                    )
                    assertFalse(
                        harness.actor.acceptDurableHandoff(completedHandoff(snapshotAdmission)),
                    )

                    suspend fun expectUncorrelatedResponse() {
                        val unavailable = withTimeout(TIMEOUT_MS) {
                            harness.actor.effects.first {
                                it is RelayV2RuntimeEffect.AgentExtensionUnavailable
                            }
                        } as RelayV2RuntimeEffect.AgentExtensionUnavailable
                        assertEquals(
                            RelayV2AgentExtensionUnavailableReason.UNCORRELATED_RESPONSE,
                            unavailable.reason,
                        )
                    }

                    harness.transport().sendAgentFrame(agentUnavailableStatus(status.requestId))
                    expectUncorrelatedResponse()
                    listOf(status.requestId, snapshot.requestId).forEach { retiredRequestId ->
                        harness.transport().sendAgentFrame(hostEpochMismatch(retiredRequestId))
                        expectUncorrelatedResponse()
                        assertEquals(phase, harness.actor.state.value.phase)
                        assertTrue(harness.transport().closeCodes.isEmpty())
                    }

                    if (phase == RelayV2ConnectionPhase.ONLINE) {
                        harness.transport().sendFixture("host-presence-online")
                        val base = withTimeout(TIMEOUT_MS) {
                            harness.actor.effects.first {
                                it is RelayV2RuntimeEffect.DeliverPostHandshakeFrame
                            }
                        } as RelayV2RuntimeEffect.DeliverPostHandshakeFrame
                        assertEquals("host.presence", base.message.frame["type"])
                    }
                    assertEquals(phase, harness.actor.state.value.phase)
                    assertTrue(harness.transport().closeCodes.isEmpty())
                    assertTrue(
                        harness.actor.send(
                            agentStatusRequest(authority, "fresh-status-${phase.name}"),
                        ) != null,
                    )
                    assertTrue(
                        harness.actor.send(
                            agentSnapshotRequest(authority, "fresh-snapshot-${phase.name}"),
                        ) != null,
                    )
                } finally {
                    harness.close()
                }
            }
        }

    @Test
    fun `agent effect saturation leaves online base route available`() = runBlocking {
        data class Saturation(
            val name: String,
            val eventCapacity: Int,
            val byteCapacity: Long,
        )
        val cases = listOf(
            Saturation("count", eventCapacity = 1, byteCapacity = 1_048_576),
            Saturation("bytes", eventCapacity = 1, byteCapacity = 1),
        )

        cases.forEach { case ->
            val harness = Harness(
                optionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
                extensionEventCapacity = case.eventCapacity,
                extensionEffectByteCapacity = case.byteCapacity,
            )
            try {
                val authority = harness.negotiateAgentExtension(RelayV2ConnectionPhase.ONLINE)
                if (case.name == "count") {
                    repeat(2) { index ->
                        harness.transport().sendAgentFrame(
                            AgentTimelineResetFrame(
                                hostId = HOST_ID,
                                hostEpoch = HOST_EPOCH,
                                scopeId = "scope-local",
                                sessionId = "session-1",
                                previousTimelineEpoch = "timeline-${index + 1}",
                                newTimelineEpoch = "timeline-${index + 2}",
                                reason = AgentTimelineResetReason.DELETED,
                            ),
                        )
                    }
                } else {
                    val request = agentStatusRequest(authority, "agent-effect-bytes")
                    assertTrue(harness.actor.send(request) != null)
                    assertEquals(request.frame, harness.transport().awaitAgentSentFrame(1))
                    harness.transport().sendAgentFrame(agentUnavailableStatus(request.requestId))
                }
                delay(25)
                val unavailable = withTimeout(TIMEOUT_MS) {
                    harness.actor.effects.first {
                        it is RelayV2RuntimeEffect.AgentExtensionUnavailable
                    }
                } as RelayV2RuntimeEffect.AgentExtensionUnavailable
                assertEquals(
                    case.name,
                    RelayV2AgentExtensionUnavailableReason.EFFECT_QUEUE_SATURATED,
                    unavailable.reason,
                )
                if (case.name == "bytes") {
                    assertTrue(case.name, unavailable.failedRequest != null)
                    assertTrue(case.name, unavailable.requestAdmission != null)
                    assertNull(harness.actor.send(requireNotNull(unavailable.failedRequest)))
                } else {
                    assertNull(unavailable.failedRequest)
                    assertNull(unavailable.requestAdmission)
                }
                harness.transport().sendFixture("host-presence-online")

                val base = withTimeout(TIMEOUT_MS) {
                    harness.actor.effects.first {
                        it is RelayV2RuntimeEffect.DeliverPostHandshakeFrame
                    }
                } as RelayV2RuntimeEffect.DeliverPostHandshakeFrame
                assertEquals(case.name, "host.presence", base.message.frame["type"])
                assertEquals(case.name, RelayV2ConnectionPhase.ONLINE, harness.actor.state.value.phase)
                assertTrue(case.name, harness.transport().closeCodes.isEmpty())
            } finally {
                harness.close()
            }
        }
    }

    @Test
    fun `overlapping extension errors route by exact owner in querying and online`() = runBlocking {
        listOf(RelayV2ConnectionPhase.QUERYING, RelayV2ConnectionPhase.ONLINE).forEach { phase ->
            val harness = Harness(
                optionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
            )
            try {
                val authority = harness.negotiateAgentExtension(phase)
                val request = agentStatusRequest(authority, "agent-overlap-${phase.name}")
                val admission = requireNotNull(harness.actor.send(request))
                assertEquals(request.frame, harness.transport().awaitAgentSentFrame(1))
                harness.transport().sendAgentFrame(hostEpochMismatch(request.requestId))

                val extension = withTimeout(TIMEOUT_MS) {
                    harness.actor.effects.first {
                        it is RelayV2RuntimeEffect.DeliverAgentExtensionFrame
                    }
                } as RelayV2RuntimeEffect.DeliverAgentExtensionFrame
                assertEquals(admission, extension.requestAdmission)
                assertTrue(
                    extension.ingress is AgentTranscriptLifecycleTrustedIngress.CorrelatedError,
                )
                harness.transport().sendAgentFrame(hostEpochMismatch(request.requestId))
                val duplicate = withTimeout(TIMEOUT_MS) {
                    harness.actor.effects.first {
                        it is RelayV2RuntimeEffect.AgentExtensionUnavailable
                    }
                } as RelayV2RuntimeEffect.AgentExtensionUnavailable
                assertEquals(
                    RelayV2AgentExtensionUnavailableReason.UNCORRELATED_RESPONSE,
                    duplicate.reason,
                )
                assertEquals(phase, harness.actor.state.value.phase)
                assertTrue(harness.transport().closeCodes.isEmpty())
                assertTrue(harness.actor.acceptDurableHandoff(completedHandoff(admission)))

                harness.transport().sendAgentFrame(hostEpochMismatch("base-owned-${phase.name}"))
                if (phase == RelayV2ConnectionPhase.QUERYING) {
                    harness.actor.awaitFailure(RelayV2FailureKind.SCHEMA)
                    assertEquals(4400, harness.transport().closeCodes.single())
                } else {
                    val base = withTimeout(TIMEOUT_MS) {
                        harness.actor.effects.first {
                            it is RelayV2RuntimeEffect.DeliverPostHandshakeFrame
                        }
                    } as RelayV2RuntimeEffect.DeliverPostHandshakeFrame
                    assertEquals("base-owned-${phase.name}", base.message.frame["requestId"])
                    assertEquals(RelayV2ConnectionPhase.ONLINE, harness.actor.state.value.phase)
                    assertTrue(harness.transport().closeCodes.isEmpty())
                }
            } finally {
                harness.close()
            }
        }
    }

    @Test
    fun `unnegotiated agent runtime has zero send and fails inbound closed`() = runBlocking {
        val harness = Harness()
        try {
            val hello = harness.connectThroughRelayWelcome(null)
            harness.transport().sendFixture(
                "host-welcome-snapshot-required",
                hello.stringValue("requestId"),
            )
            val handshake = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.BeginStateResync
            val request = AgentTranscriptLifecycleActorRequest.Status(
                authority = handshake.repositoryAuthority,
                frame = com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineStatusGetFrame(
                    requestId = "agent-status-disabled",
                    hostId = HOST_ID,
                    expectedHostEpoch = HOST_EPOCH,
                    scopeId = "scope-local",
                    sessionId = "session-1",
                ),
                requestFence = AgentLocalRequestFence("1", "agent-status-disabled"),
            )
            assertNull(harness.actor.send(request))
            assertEquals(1, harness.transport().sent.size)

            harness.transport().sendAgentFrame(
                AgentTimelineResetFrame(
                    hostId = HOST_ID,
                    hostEpoch = HOST_EPOCH,
                    scopeId = "scope-local",
                    sessionId = "session-1",
                    previousTimelineEpoch = "timeline-1",
                    newTimelineEpoch = "timeline-2",
                    reason = AgentTimelineResetReason.DELETED,
                ),
            )
            val failed = harness.actor.awaitFailure(RelayV2FailureKind.SCHEMA)
            assertEquals("INVALID_ENVELOPE", failed.failure?.code)
            assertEquals(4400, harness.transport().closeCodes.single())
        } finally {
            harness.close()
        }
    }

    @Test
    fun `matched recovery with no pending commands becomes online without an empty query`() =
        runBlocking {
            val harness = Harness()
            try {
                val hello = harness.connectThroughRelayWelcome(
                    RelayV2ResumeCursor(HOST_EPOCH, "91"),
                )
                val transport = harness.transport()
                transport.sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
                val effect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.QueryPendingCommands

                assertEquals(RelayV2ConnectionPhase.QUERYING, harness.actor.state.value.phase)
                assertEquals(1, transport.sent.size)
                val ready = harness.actor.processCommittedRecoveryReceipt(
                    effect,
                    RelayV2RecoveryReceipt.HelloApplied(
                        binding = effect.recovery,
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        durableCursorEventSeq = "91",
                        pendingCommands = emptyList(),
                    ),
                )
                assertEquals(
                    RelayV2RecoveryReceiptProcessingResult.OnlineReady(
                        effect.repositoryAuthority,
                    ),
                    ready,
                )

                harness.actor.awaitPhase(RelayV2ConnectionPhase.ONLINE)
                assertEquals(1, transport.sent.size)
                assertTrue(transport.closeCodes.isEmpty())
            } finally {
                harness.close()
            }
        }

    @Test
    fun `pending command query fails closed when no admission authority is bound`() = runBlocking {
        val harness = Harness(queryAdmissionComposition = null)
        try {
            val hello = harness.connectThroughRelayWelcome(RelayV2ResumeCursor(HOST_EPOCH, "91"))
            val transport = harness.transport()
            transport.sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
            val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.QueryPendingCommands
            assertEquals(
                RelayV2RecoveryReceiptProcessingResult.StaleOrTerminal,
                harness.actor.processCommittedRecoveryReceipt(
                    helloEffect,
                    RelayV2RecoveryReceipt.HelloApplied(
                        binding = helloEffect.recovery,
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        durableCursorEventSeq = "91",
                        pendingCommands = listOf(
                            RelayV2PendingCommand("default-off-command", "default-off-window"),
                        ),
                    ),
                ),
            )

            val failure = harness.actor.awaitFailure(RelayV2FailureKind.CONFIGURATION)
            assertEquals("COMMAND_QUERY_ADMISSION_UNAVAILABLE", failure.failure?.code)
            assertEquals(1, transport.sent.size)
            val emitted = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
            assertTrue(emitted is RelayV2RuntimeEffect.ConnectionFailed)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `one admission composition binds exactly one actor receiver`() = runBlocking {
        val composition = RelayV2OutboxQueryAdmissionAuthority.composition()
        val owner = Harness(queryAdmissionComposition = composition)
        val contender = Harness(queryAdmissionComposition = composition)
        try {
            val hello = contender.connectThroughRelayWelcome(
                RelayV2ResumeCursor(HOST_EPOCH, "91"),
            )
            val transport = contender.transport()
            transport.sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
            val helloEffect = withTimeout(TIMEOUT_MS) { contender.actor.effects.first() }
                as RelayV2RuntimeEffect.QueryPendingCommands
            assertTrue(
                contender.actor.commitRecoveryReceipt(
                    helloEffect,
                    RelayV2RecoveryReceipt.HelloApplied(
                        binding = helloEffect.recovery,
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        durableCursorEventSeq = "91",
                        pendingCommands = listOf(
                            RelayV2PendingCommand("claimed-command", "claimed-window"),
                        ),
                    ),
                ),
            )

            val failure = contender.actor.awaitFailure(RelayV2FailureKind.CONFIGURATION)
            assertEquals("COMMAND_QUERY_ADMISSION_UNAVAILABLE", failure.failure?.code)
            assertEquals(1, transport.sent.size)
            val emitted = withTimeout(TIMEOUT_MS) { contender.actor.effects.first() }
            assertTrue(emitted is RelayV2RuntimeEffect.ConnectionFailed)
        } finally {
            contender.close()
            owner.close()
        }
    }

    @Test
    fun `matched recovery queries all pending commands in durable batches of at most 32`() =
        runBlocking {
            val harness = Harness()
            try {
                val hello = harness.connectThroughRelayWelcome(
                    RelayV2ResumeCursor(HOST_EPOCH, "91"),
                )
                val transport = harness.transport()
                transport.sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
                val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.QueryPendingCommands
                val pending = (1..33).map { index ->
                    RelayV2PendingCommand("cmd-$index", "dedupe-window-uuid")
                }

                val wrongBinding = helloEffect.recovery.copy(
                    requestId = "00000000-0000-0000-0000-000000000099",
                )
                assertEquals(
                    RelayV2RecoveryReceiptProcessingResult.StaleOrTerminal,
                    harness.actor.processCommittedRecoveryReceipt(
                        helloEffect,
                        RelayV2RecoveryReceipt.HelloApplied(
                            binding = helloEffect.recovery,
                            hostId = HOST_ID,
                            hostEpoch = "wrong-authority-epoch",
                            durableCursorEventSeq = "91",
                            pendingCommands = pending,
                        ),
                    ),
                )
                assertTrue(
                    harness.actor.commitRecoveryReceipt(
                        helloEffect,
                        RelayV2RecoveryReceipt.HelloApplied(
                            binding = wrongBinding,
                            hostId = HOST_ID,
                            hostEpoch = HOST_EPOCH,
                            durableCursorEventSeq = "91",
                            pendingCommands = pending,
                        ),
                    ),
                )
                harness.acknowledgeActorActionsWithStateEvent("92", "2")
                assertEquals(1, transport.sent.size)
                assertEquals(RelayV2ConnectionPhase.QUERYING, harness.actor.state.value.phase)

                assertTrue(
                    harness.actor.commitRecoveryReceipt(
                        helloEffect,
                        RelayV2RecoveryReceipt.HelloApplied(
                            binding = helloEffect.recovery,
                            hostId = HOST_ID,
                            hostEpoch = HOST_EPOCH,
                            durableCursorEventSeq = "91",
                            pendingCommands = pending,
                        ),
                    ),
                )
                val firstRegistration = withTimeout(TIMEOUT_MS) {
                    harness.actor.effects.first()
                } as RelayV2RuntimeEffect.RegisterCommandQueryAttempt
                assertEquals(pending.take(32), firstRegistration.commandBatch.commands)
                assertEquals(1, transport.sent.size)

                val staleGeneration = firstRegistration.recovery.generation.copy(
                    connectionGeneration =
                        firstRegistration.recovery.generation.connectionGeneration + 1,
                )
                val staleEffect = firstRegistration.copy(
                    recovery = firstRegistration.recovery.copy(generation = staleGeneration),
                    generation = staleGeneration,
                    repositoryAuthority = firstRegistration.repositoryAuthority.copy(
                        generation = staleGeneration,
                    ),
                )
                assertFalse(
                    harness.actor.submitRecoveryReceipt(
                        harness.issueCommandQueryReceipt(
                            staleEffect,
                            forceApply = true,
                        ),
                    ),
                )
                val foreignComposition = RelayV2OutboxQueryAdmissionAuthority.composition()
                val wrongReceipts = listOf(
                    issueIndependentCommandQueryReceipt(
                        firstRegistration,
                        composition = foreignComposition,
                        applyLease = harness.actor,
                    ),
                    harness.issueCommandQueryReceipt(
                        firstRegistration.copy(
                            recovery = firstRegistration.recovery.copy(
                                step = firstRegistration.recovery.step + 1,
                            ),
                        ),
                    ),
                    harness.issueCommandQueryReceipt(
                        firstRegistration.copy(
                            recovery = firstRegistration.recovery.copy(
                                requestId = "00000000-0000-0000-0000-000000000098",
                            ),
                        ),
                    ),
                    harness.issueCommandQueryReceipt(
                        firstRegistration.copy(
                            commandBatch = RelayV2CommandQueryBatch(
                                listOf(
                                    RelayV2PendingCommand("wrong-command", "wrong-window"),
                                ),
                            ),
                        ),
                    ),
                    harness.issueCommandQueryReceipt(
                        firstRegistration.copy(
                            hostEpoch = "wrong-query-epoch",
                            repositoryAuthority = firstRegistration.repositoryAuthority.copy(
                                hostEpoch = "wrong-query-epoch",
                            ),
                        ),
                        forceApply = true,
                    ),
                )
                wrongReceipts.forEach { wrongReceipt ->
                    assertTrue(harness.actor.submitRecoveryReceipt(wrongReceipt))
                }
                harness.acknowledgeActorActionsWithStateEvent("93", "3")
                assertEquals(1, transport.sent.size)
                val firstReceipt = harness.issueCommandQueryReceipt(firstRegistration)
                assertTrue(harness.actor.submitRecoveryReceipt(firstReceipt))
                val firstQuery = transport.awaitSentFrame(1)
                assertEquals("command.query", firstQuery.stringValue("type"))
                assertEquals(
                    firstRegistration.recovery.requestId,
                    firstQuery.stringValue("requestId"),
                )
                assertEquals(HOST_ID, firstQuery.stringValue("hostId"))
                assertEquals(HOST_EPOCH, firstQuery.stringValue("expectedHostEpoch"))
                val firstItems = firstQuery.payload().commandItems()
                assertEquals(firstRegistration.commandBatch.commands, firstItems)
                assertTrue(harness.actor.submitRecoveryReceipt(firstReceipt))
                harness.acknowledgeActorActionsWithStateEvent("94", "4")
                assertEquals(2, transport.sent.size)

                transport.sendCommandStatuses(
                    requestId = firstQuery.stringValue("requestId"),
                    commands = firstItems,
                )
                val firstApply = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.ApplyCommandStatuses
                assertEquals(firstItems, firstApply.expectedCommands)
                assertEquals(RelayV2ConnectionPhase.QUERYING, harness.actor.state.value.phase)
                transport.sendCommandStatuses(
                    requestId = firstQuery.stringValue("requestId"),
                    commands = firstItems,
                )
                assertEquals(null, withTimeoutOrNull(50) { harness.actor.effects.first() })
                assertEquals(
                    RelayV2RecoveryReceiptProcessingResult.ContinuedRecovery,
                    harness.actor.processCommittedRecoveryReceipt(
                        firstApply,
                        RelayV2RecoveryReceipt.CommandStatusesApplied(
                            binding = firstApply.recovery,
                            hostId = HOST_ID,
                            hostEpoch = HOST_EPOCH,
                            appliedCommands = firstItems,
                        ),
                    ),
                )

                val secondRegistration = harness.awaitCommandQueryRegistration()
                assertEquals(pending.drop(32), secondRegistration.commandBatch.commands)
                assertEquals(2, transport.sent.size)
                assertTrue(harness.commitCommandQueryRegistration(secondRegistration))
                val secondQuery = transport.awaitSentFrame(2)
                val secondItems = secondQuery.payload().commandItems()
                assertEquals(secondRegistration.commandBatch.commands, secondItems)
                transport.sendCommandStatuses(
                    secondQuery.stringValue("requestId"),
                    secondItems,
                )
                val secondApply = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.ApplyCommandStatuses
                assertEquals(
                    RelayV2RecoveryReceiptProcessingResult.OnlineReady(
                        secondApply.repositoryAuthority,
                    ),
                    harness.actor.processCommittedRecoveryReceipt(
                        secondApply,
                        RelayV2RecoveryReceipt.CommandStatusesApplied(
                            binding = secondApply.recovery,
                            hostId = HOST_ID,
                            hostEpoch = HOST_EPOCH,
                            appliedCommands = secondItems,
                        ),
                    ),
                )

                harness.actor.awaitPhase(RelayV2ConnectionPhase.ONLINE)
                assertEquals(3, transport.sent.size)
                assertTrue(transport.closeCodes.isEmpty())
            } finally {
                harness.close()
            }
        }

    @Test
    fun `command query admission effect saturation fails closed before transport send`() =
        runBlocking {
            val harness = Harness(eventCapacity = 1)
            try {
                val hello = harness.connectThroughRelayWelcome(
                    RelayV2ResumeCursor(HOST_EPOCH, "91"),
                )
                val transport = harness.transport()
                transport.sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
                val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.QueryPendingCommands
                val pending = listOf(RelayV2PendingCommand("effect-full", "effect-window"))

                // This recovery event occupies the sole effect slot before the FIFO hello receipt
                // tries to publish command-query admission.
                transport.sendFrame(sessionUpsertFrame("92", "2"))
                assertTrue(
                    harness.actor.commitRecoveryReceipt(
                        helloEffect,
                        RelayV2RecoveryReceipt.HelloApplied(
                            helloEffect.recovery,
                            HOST_ID,
                            HOST_EPOCH,
                            durableCursorEventSeq = "91",
                            pendingCommands = pending,
                        ),
                    ),
                )

                val failure = harness.actor.awaitFailure(RelayV2FailureKind.QUEUE_SATURATED)
                assertEquals("SLOW_CONSUMER", failure.failure?.code)
                assertEquals(1, transport.sent.size)
                assertEquals(listOf(1013), transport.closeCodes)
            } finally {
                harness.close()
            }
        }

    @Test
    fun `command query admission receipt saturation fails closed before transport send`() =
        runBlocking {
            val watchdog = ManualWatchdog()
            val timeoutClaimEntered = CountDownLatch(1)
            val releaseTimeoutClaim = CountDownLatch(1)
            val harness = Harness(
                normalActionCapacity = 1,
                recoveryWatchdogDelay = watchdog::await,
                beforeRecoveryTimeoutClaim = {
                    timeoutClaimEntered.countDown()
                    check(releaseTimeoutClaim.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                },
            )
            try {
                val hello = harness.connectThroughRelayWelcome(
                    RelayV2ResumeCursor(HOST_EPOCH, "91"),
                )
                val transport = harness.transport()
                transport.sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
                val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.QueryPendingCommands
                assertTrue(
                    harness.actor.commitRecoveryReceipt(
                        helloEffect,
                        RelayV2RecoveryReceipt.HelloApplied(
                            helloEffect.recovery,
                            HOST_ID,
                            HOST_EPOCH,
                            durableCursorEventSeq = "91",
                            pendingCommands = listOf(
                                RelayV2PendingCommand("receipt-full", "receipt-window"),
                            ),
                        ),
                    ),
                )
                val registration = harness.awaitCommandQueryRegistration()
                assertEquals(1, transport.sent.size)
                val wrongReceipt = harness.issueCommandQueryReceipt(
                    registration.copy(
                        recovery = registration.recovery.copy(
                            requestId = "00000000-0000-0000-0000-000000000097",
                        ),
                    ),
                )
                val exactReceipt = harness.issueCommandQueryReceipt(registration)

                watchdog.fire(1)
                assertTrue(timeoutClaimEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                assertTrue(harness.actor.submitRecoveryReceipt(wrongReceipt))
                assertFalse(harness.actor.submitRecoveryReceipt(exactReceipt))
                releaseTimeoutClaim.countDown()

                val failure = harness.actor.awaitPhase(RelayV2ConnectionPhase.FAILED).failure
                assertTrue(failure?.code in setOf("SLOW_CONSUMER", "RECOVERY_TIMEOUT"))
                assertEquals(1, transport.sent.size)
            } finally {
                releaseTimeoutClaim.countDown()
                harness.close()
            }
        }

    @Test
    fun `outbox send is online only and preserves exact synchronous transport result`() =
        runBlocking {
            val harness = Harness()
            try {
                val hello = harness.connectThroughRelayWelcome(
                    RelayV2ResumeCursor(HOST_EPOCH, "91"),
                )
                val transport = harness.transport()
                transport.sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
                val recovery = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.QueryPendingCommands
                val authority = recovery.repositoryAuthority
                harness.actor.awaitPhase(RelayV2ConnectionPhase.QUERYING)
                val beforeQuerying = transport.sendAttemptCount.get()
                assertEquals(
                    RelayV2OutboxExactGenerationSendResult.Stale,
                    harness.actor.sendIfCurrent(authority, "querying".toByteArray()),
                )
                assertEquals(beforeQuerying, transport.sendAttemptCount.get())
                assertTrue(
                    harness.actor.commitRecoveryReceipt(
                        recovery,
                        RelayV2RecoveryReceipt.HelloApplied(
                            binding = recovery.recovery,
                            hostId = HOST_ID,
                            hostEpoch = HOST_EPOCH,
                            durableCursorEventSeq = "91",
                            pendingCommands = emptyList(),
                        ),
                    ),
                )
                harness.actor.awaitPhase(RelayV2ConnectionPhase.ONLINE)

                val mismatches = listOf(
                    authority.copy(
                        generation = authority.generation.copy(profileId = "other-profile"),
                        profileId = "other-profile",
                    ),
                    authority.copy(
                        generation = authority.generation.copy(
                            profileGeneration = authority.generation.profileGeneration + 1,
                        ),
                        profileActivationGeneration =
                            authority.profileActivationGeneration + 1,
                    ),
                    authority.copy(principalId = "other-principal"),
                    authority.copy(clientInstanceId = "other-client"),
                    authority.copy(hostId = "other-host"),
                    authority.copy(hostEpoch = "other-host-epoch"),
                    authority.copy(
                        generation = authority.generation.copy(
                            connectionGeneration =
                                authority.generation.connectionGeneration + 1,
                        ),
                    ),
                )
                val beforeMismatches = transport.sendAttemptCount.get()
                mismatches.forEach { mismatch ->
                    assertEquals(
                        RelayV2OutboxExactGenerationSendResult.Stale,
                        harness.actor.sendIfCurrent(mismatch, "stale".toByteArray()),
                    )
                }
                assertEquals(beforeMismatches, transport.sendAttemptCount.get())

                val callerBytes = "defensive-outbox-payload".toByteArray()
                val originalBytes = callerBytes.copyOf()
                transport.beforeSend = { delivered ->
                    assertFalse(delivered === callerBytes)
                    delivered[0] = 'X'.code.toByte()
                }
                assertEquals(
                    RelayV2OutboxExactGenerationSendResult.Sent,
                    harness.actor.sendIfCurrent(authority, callerBytes),
                )
                assertTrue(callerBytes.contentEquals(originalBytes))
                transport.beforeSend = null

                transport.sendResult = false
                assertEquals(
                    RelayV2OutboxExactGenerationSendResult.NotSent,
                    harness.actor.sendIfCurrent(authority, "not-sent".toByteArray()),
                )

                val failure = IllegalStateException("transport send failed")
                transport.sendFailure = failure
                assertSame(
                    failure,
                    runCatching {
                        harness.actor.sendIfCurrent(authority, "throw".toByteArray())
                    }.exceptionOrNull(),
                )
                transport.sendFailure = null
                assertEquals(beforeMismatches + 3, transport.sendAttemptCount.get())

                assertEquals(
                    RelayV2OutboxExactGenerationSendResult.Stale,
                    harness.actor.sendIfCurrent(
                        authority,
                        ByteArray(RelayV2Codec.PUBLIC_FRAME_BYTES + 1),
                    ),
                )
                assertEquals(beforeMismatches + 3, transport.sendAttemptCount.get())
            } finally {
                harness.close()
            }
        }

    @Test
    fun `outbox send and disconnect fence share one actor owned serial segment`() = runBlocking {
        val sendEntered = CountDownLatch(1)
        val releaseSend = CountDownLatch(1)
        val disconnectStarted = CountDownLatch(1)
        val disconnectOwnerSealed = CountDownLatch(1)
        val harness = Harness(
            afterDisconnectOwnerSeal = { disconnectOwnerSealed.countDown() },
        )
        try {
            val hello = harness.connectThroughRelayWelcome(
                RelayV2ResumeCursor(HOST_EPOCH, "91"),
            )
            val transport = harness.transport()
            transport.sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
            val recovery = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.QueryPendingCommands
            val authority = recovery.repositoryAuthority
            harness.actor.awaitPhase(RelayV2ConnectionPhase.QUERYING)
            assertTrue(
                harness.actor.commitRecoveryReceipt(
                    recovery,
                    RelayV2RecoveryReceipt.HelloApplied(
                        binding = recovery.recovery,
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        durableCursorEventSeq = "91",
                        pendingCommands = emptyList(),
                    ),
                ),
            )
            harness.actor.awaitPhase(RelayV2ConnectionPhase.ONLINE)
            val beforeSend = transport.sendAttemptCount.get()
            transport.beforeSend = {
                sendEntered.countDown()
                check(releaseSend.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            }

            val sending = async(Dispatchers.Default) {
                harness.actor.sendIfCurrent(authority, "serialized".toByteArray())
            }
            assertTrue(sendEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            val disconnect = async(Dispatchers.Default) {
                disconnectStarted.countDown()
                harness.actor.disconnectAndDrain(
                    harness.profile.identity,
                    "outbox-send-fence",
                )
            }
            assertTrue(disconnectStarted.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            assertEquals(1L, disconnectOwnerSealed.count)
            assertFalse(disconnect.isCompleted)

            releaseSend.countDown()
            assertEquals(
                RelayV2OutboxExactGenerationSendResult.Sent,
                withTimeout(TIMEOUT_MS) { sending.await() },
            )
            assertEquals(
                "outbox-send-fence",
                withTimeout(TIMEOUT_MS) { disconnect.await() }.barrierId,
            )
            assertEquals(beforeSend + 1, transport.sendAttemptCount.get())
        } finally {
            releaseSend.countDown()
            harness.close()
        }
    }

    @Test
    fun `outbox send is stale when disconnect fence wins the concurrent race`() = runBlocking {
        val sendCallerReady = CountDownLatch(1)
        val releaseSendCaller = CountDownLatch(1)
        val disconnectOwnerSealed = CountDownLatch(1)
        val releaseDisconnect = CountDownLatch(1)
        val harness = Harness(
            afterDisconnectOwnerSeal = {
                disconnectOwnerSealed.countDown()
                check(releaseDisconnect.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            },
        )
        try {
            val hello = harness.connectThroughRelayWelcome(
                RelayV2ResumeCursor(HOST_EPOCH, "91"),
            )
            val transport = harness.transport()
            transport.sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
            val recovery = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.QueryPendingCommands
            val authority = recovery.repositoryAuthority
            assertTrue(
                harness.actor.commitRecoveryReceipt(
                    recovery,
                    RelayV2RecoveryReceipt.HelloApplied(
                        binding = recovery.recovery,
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        durableCursorEventSeq = "91",
                        pendingCommands = emptyList(),
                    ),
                ),
            )
            harness.actor.awaitPhase(RelayV2ConnectionPhase.ONLINE)
            val beforeSend = transport.sendAttemptCount.get()
            val sending = async(Dispatchers.Default) {
                sendCallerReady.countDown()
                check(releaseSendCaller.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                harness.actor.sendIfCurrent(authority, "disconnect-first".toByteArray())
            }
            assertTrue(sendCallerReady.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            val disconnect = async(start = CoroutineStart.UNDISPATCHED) {
                harness.actor.disconnectAndDrain(
                    harness.profile.identity,
                    "outbox-disconnect-first",
                )
            }
            assertTrue(disconnectOwnerSealed.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))

            releaseSendCaller.countDown()
            assertEquals(
                RelayV2OutboxExactGenerationSendResult.Stale,
                withTimeout(TIMEOUT_MS) { sending.await() },
            )
            assertEquals(beforeSend, transport.sendAttemptCount.get())

            releaseDisconnect.countDown()
            assertEquals(
                "outbox-disconnect-first",
                withTimeout(TIMEOUT_MS) { disconnect.await() }.barrierId,
            )
        } finally {
            releaseSendCaller.countDown()
            releaseDisconnect.countDown()
            harness.close()
        }
    }

    @Test
    fun `outbox send is stale when close fence wins with current online authority`() = runBlocking {
        val executeReadyReadEntered = CountDownLatch(1)
        val releaseExecuteReadyRead = CountDownLatch(1)
        val closeFenceCompleted = CountDownLatch(1)
        val harness = Harness(
            beforeOutboxExecuteReadyRead = {
                executeReadyReadEntered.countDown()
                check(releaseExecuteReadyRead.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            },
        )
        try {
            val hello = harness.connectThroughRelayWelcome(
                RelayV2ResumeCursor(HOST_EPOCH, "91"),
            )
            val transport = harness.transport()
            transport.sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
            val recovery = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.QueryPendingCommands
            val authority = recovery.repositoryAuthority
            assertTrue(
                harness.actor.commitRecoveryReceipt(
                    recovery,
                    RelayV2RecoveryReceipt.HelloApplied(
                        binding = recovery.recovery,
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        durableCursorEventSeq = "91",
                        pendingCommands = emptyList(),
                    ),
                ),
            )
            harness.actor.awaitPhase(RelayV2ConnectionPhase.ONLINE)
            transport.completeTerminationOnCancel = false
            val beforeSend = transport.sendAttemptCount.get()
            val sending = async(Dispatchers.Default) {
                harness.actor.sendIfCurrent(authority, "close-first".toByteArray())
            }
            assertTrue(executeReadyReadEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            val closing = async(Dispatchers.Default) {
                harness.actor.close()
                // close() returns only after SHUTTING_DOWN and ready/owner withdrawal commit.
                closeFenceCompleted.countDown()
            }
            assertTrue(closeFenceCompleted.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            withTimeout(TIMEOUT_MS) { closing.await() }

            releaseExecuteReadyRead.countDown()
            assertEquals(
                RelayV2OutboxExactGenerationSendResult.Stale,
                withTimeout(TIMEOUT_MS) { sending.await() },
            )
            assertEquals(beforeSend, transport.sendAttemptCount.get())

            transport.completeTermination()
            assertEquals(
                RelayV2ConnectionPhase.CLOSED,
                harness.actor.awaitPhase(RelayV2ConnectionPhase.CLOSED).phase,
            )
        } finally {
            releaseExecuteReadyRead.countDown()
            harness.factory.transports.forEach { it.completeTermination() }
            harness.close()
        }
    }

    @Test
    fun `outbox send rejects handshake initial resync and reconnect before transport`() =
        runBlocking {
            val handshake = Harness()
            try {
                val hello = handshake.connectThroughRelayWelcome(null)
                val transport = handshake.transport()
                val state = handshake.actor.awaitPhase(
                    RelayV2ConnectionPhase.AWAITING_HOST_WELCOME,
                )
                val authority = RelayV2RepositoryEffectAuthority(
                    generation = RelayV2EffectGeneration(
                        handshake.profile.profileId,
                        handshake.profile.activationGeneration,
                        state.connectionGeneration,
                    ),
                    profileId = handshake.profile.profileId,
                    profileActivationGeneration = handshake.profile.activationGeneration,
                    principalId = handshake.profile.principalId,
                    clientInstanceId = handshake.profile.clientInstanceId,
                    hostId = handshake.profile.hostId,
                    hostEpoch = HOST_EPOCH,
                )
                val before = transport.sendAttemptCount.get()
                assertEquals(
                    RelayV2OutboxExactGenerationSendResult.Stale,
                    handshake.actor.sendIfCurrent(authority, "handshake".toByteArray()),
                )
                assertEquals(before, transport.sendAttemptCount.get())

                transport.sendFixture(
                    "host-welcome-snapshot-required",
                    hello.stringValue("requestId"),
                )
                val resync = withTimeout(TIMEOUT_MS) { handshake.actor.effects.first() }
                    as RelayV2RuntimeEffect.BeginStateResync
                handshake.actor.awaitPhase(RelayV2ConnectionPhase.RESYNCING)
                val beforeResync = transport.sendAttemptCount.get()
                assertEquals(
                    RelayV2OutboxExactGenerationSendResult.Stale,
                    handshake.actor.sendIfCurrent(
                        resync.repositoryAuthority,
                        "initial-resync".toByteArray(),
                    ),
                )
                assertEquals(beforeResync, transport.sendAttemptCount.get())
            } finally {
                handshake.close()
            }

            val reconnect = Harness()
            try {
                val hello = reconnect.connectThroughRelayWelcome(
                    RelayV2ResumeCursor(HOST_EPOCH, "91"),
                )
                val oldTransport = reconnect.transport()
                oldTransport.sendFixture(
                    "host-welcome-caught-up",
                    hello.stringValue("requestId"),
                )
                val recovery = withTimeout(TIMEOUT_MS) { reconnect.actor.effects.first() }
                    as RelayV2RuntimeEffect.QueryPendingCommands
                val oldAuthority = recovery.repositoryAuthority
                assertTrue(
                    reconnect.actor.commitRecoveryReceipt(
                        recovery,
                        RelayV2RecoveryReceipt.HelloApplied(
                            binding = recovery.recovery,
                            hostId = HOST_ID,
                            hostEpoch = HOST_EPOCH,
                            durableCursorEventSeq = "91",
                            pendingCommands = emptyList(),
                        ),
                    ),
                )
                reconnect.actor.awaitPhase(RelayV2ConnectionPhase.ONLINE)
                val oldAttempts = oldTransport.sendAttemptCount.get()

                assertTrue(reconnect.actor.connect(reconnect.profile))
                reconnect.awaitTransport(1)
                assertEquals(
                    RelayV2OutboxExactGenerationSendResult.Stale,
                    reconnect.actor.sendIfCurrent(oldAuthority, "reconnect".toByteArray()),
                )
                assertEquals(oldAttempts, oldTransport.sendAttemptCount.get())
            } finally {
                reconnect.close()
            }
        }

    @Test
    fun `disconnect and close reject committed query receipt before transport send`() = runBlocking {
        listOf("disconnect", "close").forEach { terminal ->
            val harness = Harness()
            try {
                val hello = harness.connectThroughRelayWelcome(
                    RelayV2ResumeCursor(HOST_EPOCH, "91"),
                )
                val transport = harness.transport()
                transport.sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
                val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.QueryPendingCommands
                assertTrue(
                    harness.actor.commitRecoveryReceipt(
                        helloEffect,
                        RelayV2RecoveryReceipt.HelloApplied(
                            helloEffect.recovery,
                            HOST_ID,
                            HOST_EPOCH,
                            durableCursorEventSeq = "91",
                            pendingCommands = listOf(
                                RelayV2PendingCommand("terminal-$terminal", "terminal-window"),
                            ),
                        ),
                    ),
                )
                val registration = harness.awaitCommandQueryRegistration()
                val committedReceipt = harness.issueCommandQueryReceipt(registration)
                assertEquals(1, transport.sent.size)

                if (terminal == "disconnect") {
                    withTimeout(TIMEOUT_MS) {
                        harness.actor.disconnectAndDrain(
                            harness.profile.identity,
                            "query-admission-disconnect",
                        )
                    }
                } else {
                    harness.actor.close()
                    harness.actor.awaitPhase(RelayV2ConnectionPhase.CLOSED)
                }
                assertFalse(
                    harness.actor.submitRecoveryReceipt(committedReceipt),
                )
                assertEquals(1, transport.sent.size)
            } finally {
                harness.close()
            }
        }
    }

    @Test
    fun `online live gap uses repository proof to reenter resync and request a snapshot`() =
        runBlocking {
            val namespace = RelayV2StateNamespace(
                "profile-primary",
                PRINCIPAL_ID,
                "android-install-primary",
                HOST_ID,
                HOST_EPOCH,
            )
            val store = FakeStateStore()
            val repository = RelayV2StateSyncRepositoryCore(store)
            val records = adapterSnapshotRecords("seed-online")
            val (bytes, digest) = canonicalSnapshotDigest(records)
            repository.applyHelloForActorTest(
                RelayV2StateHello(
                    namespace,
                    "91",
                    null,
                    RelayV2StateHelloDisposition.FRESH,
                ),
            )
            repository.stageSnapshotChunkUnderApplyLease(
                adapterSnapshotChunk(namespace, "seed-online", "91", records, bytes, digest),
            )
            val committed = repository.commitSnapshotUnderApplyLease(
                namespace,
                "snapshot-seed-online",
            ) as com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateSyncResult.SnapshotCommitted
            assertEquals(
                committed.release,
                repository.completeSnapshotReleaseUnderApplyLease(committed.release)?.release,
            )
            val adapter = recoveryAdapter(repository)
            val executeReadyReadEntered = CountDownLatch(1)
            val releaseExecuteReadyRead = CountDownLatch(1)
            val harness = Harness(
                durableConnectPlanSource = adapter,
                beforeOutboxExecuteReadyRead = {
                    executeReadyReadEntered.countDown()
                    check(releaseExecuteReadyRead.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                },
            )
            try {
                val hello = harness.connectThroughRelayWelcome(
                    RelayV2ResumeCursor(HOST_EPOCH, "91"),
                )
                val transport = harness.transport()
                transport.sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
                val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.QueryPendingCommands
                assertEquals(
                    helloEffect.context.repositoryEffectAuthority(helloEffect.generation),
                    helloEffect.repositoryAuthority,
                )
                val helloReceipt = harness.actor.withEffectApplyLease(helloEffect) {
                    adapter.applyHello(
                        helloEffect,
                        emptyList(),
                    )
                } as RelayV2EffectApplyResult.Applied
                assertTrue(harness.actor.submitRecoveryReceipt(helloReceipt.value))
                harness.actor.awaitPhase(RelayV2ConnectionPhase.ONLINE)
                val publicationCut = (
                    harness.actor.currentOnlineCommandCut() as
                        RelayV2CurrentOnlineCommandCutResult.Available
                    ).cut
                val racingExecute = async(Dispatchers.Default) {
                    harness.actor.sendIfCurrent(
                        helloEffect.repositoryAuthority,
                        "racing-online-gap-execute".toByteArray(),
                    )
                }
                assertTrue(executeReadyReadEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))

                val gapFrame = fixture("sessions-changed-upsert")
                gapFrame["eventSeq"] = "93"
                gapFrame["scopeId"] = "scope-a"
                gapFrame.payload()["resourceKey"] = "scope-a"
                gapFrame.payload()["resultingRevision"] = "2"
                gapFrame.payload().mutableObject("change").mutableObject("item")["scopeId"] =
                    "scope-a"
                transport.sendFrame(gapFrame)
                val delivery = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.DeliverPostHandshakeFrame
                assertEquals(null, delivery.recovery)
                val onlineProof = harness.actor.withEffectApplyLease(delivery) {
                    adapter.applyOnlineStateEvent(
                        delivery,
                        emptyList(),
                    )
                } as RelayV2EffectApplyResult.Applied
                val storedEvent = store.events(namespace).single().event
                assertEquals(
                    RelayV2StrictJson.stringify(gapFrame).toByteArray(Charsets.UTF_8).size,
                    delivery.rawUtf8Bytes,
                )
                assertEquals(delivery.rawUtf8Bytes, storedEvent.rawUtf8Bytes)
                assertEquals("93", store.authority(namespace)?.requiredThroughEventSeq)
                assertEquals("93", storedEvent.eventSeq)
                assertEquals("2", storedEvent.resultingRevision)
                assertEquals(
                    RelayV2SessionResource(
                        scopeId = "scope-a",
                        sessionId = "ses_01JOPAQUE",
                        kind = RelayV2SessionKind.WORKTREE,
                        displayName = "demo",
                        project = "demo",
                        label = null,
                        cwd = "/repo/demo",
                        attached = false,
                        windowCount = 1,
                        createdAtMs = 1_783_700_000_000,
                        activityAtMs = 1_783_700_000_000,
                    ),
                    (storedEvent.change as RelayV2StateChange.SessionUpsert).item,
                )
                assertTrue(harness.actor.submitOnlineResyncRequired(requireNotNull(onlineProof.value)))

                val snapshot = transport.awaitSentFrame(1)
                assertEquals("state.snapshot.get", snapshot.stringValue("type"))
                assertEquals(null, snapshot.payload()["snapshotId"])
                assertEquals(RelayV2ConnectionPhase.RESYNCING, harness.actor.state.value.phase)
                var staleProjectionPublished = false
                assertFalse(
                    harness.actor.runIfCurrent(publicationCut) {
                        staleProjectionPublished = true
                    },
                )
                assertFalse(staleProjectionPublished)
                assertEquals(helloEffect.generation, delivery.generation)
                assertEquals(helloEffect.repositoryAuthority, delivery.repositoryAuthority)
                val beforeDelayedExecute = transport.sendAttemptCount.get()
                releaseExecuteReadyRead.countDown()
                assertEquals(
                    RelayV2OutboxExactGenerationSendResult.Stale,
                    withTimeout(TIMEOUT_MS) { racingExecute.await() },
                )
                assertEquals(beforeDelayedExecute, transport.sendAttemptCount.get())
                assertEquals(
                    RelayV2OutboxExactGenerationSendResult.Stale,
                    harness.actor.sendIfCurrent(
                        delivery.repositoryAuthority,
                        "delayed-online-gap-execute".toByteArray(),
                    ),
                )
                assertEquals(beforeDelayedExecute, transport.sendAttemptCount.get())

                val bufferedFrame = deepClone(gapFrame)
                bufferedFrame["eventSeq"] = "94"
                bufferedFrame.payload()["resultingRevision"] = "3"
                transport.sendFrame(bufferedFrame)
                val buffered = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.DeliverPostHandshakeFrame
                val bufferedReceipt = harness.actor.withEffectApplyLease(buffered) {
                    adapter.applyRecoveryStateEvent(buffered, emptyList())
                } as RelayV2EffectApplyResult.Applied
                assertNull(bufferedReceipt.value)
                assertEquals(RelayV2ConnectionPhase.RESYNCING, harness.actor.state.value.phase)
                assertEquals(listOf("93", "94"), store.events(namespace).map {
                    it.event.eventSeq
                })

                val chunk = fixture("state-snapshot-chunk")
                chunk["requestId"] = snapshot.stringValue("requestId")
                chunk.payload()["snapshotRequestId"] =
                    snapshot.payload().stringValue("snapshotRequestId")
                transport.sendFrame(chunk)
                val chunkEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.ApplyStateSnapshotChunk
                assertEquals(
                    snapshot.payload().stringValue("snapshotRequestId"),
                    chunkEffect.snapshotRequestId,
                )
            } finally {
                releaseExecuteReadyRead.countDown()
                harness.close()
            }
        }

    @Test
    fun `repository apply lease rejects a forged principal namespace`() = runBlocking {
        val store = FakeStateStore()
        val adapter = recoveryAdapter(RelayV2StateSyncRepositoryCore(store))
        val harness = Harness()
        try {
            val hello = harness.connectThroughRelayWelcome(null)
            val transport = harness.transport()
            transport.sendFixture(
                "host-welcome-snapshot-required",
                hello.stringValue("requestId"),
            )
            val effect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.BeginStateResync
            val foreignContext = effect.context.copy(principalId = "principal-foreign")
            val contextOnlyForgery = effect.copy(context = foreignContext)
            assertTrue(
                runCatching {
                    harness.actor.withEffectApplyLease(contextOnlyForgery) {
                        adapter.applyHello(contextOnlyForgery, emptyList())
                    }
                }.exceptionOrNull() != null,
            )

            val fullyForged = contextOnlyForgery.copy(
                repositoryAuthority =
                    foreignContext.repositoryEffectAuthority(effect.generation),
            )
            var forgedLeaseEntered = false
            assertEquals(
                RelayV2EffectApplyResult.Stale,
                harness.actor.withEffectApplyLease(fullyForged) {
                    forgedLeaseEntered = true
                    adapter.applyHello(fullyForged, emptyList())
                },
            )
            assertFalse(forgedLeaseEntered)
            assertNull(
                store.authority(
                    RelayV2StateNamespace(
                        "profile-primary",
                        "principal-foreign",
                        "android-install-primary",
                        HOST_ID,
                        HOST_EPOCH,
                    ),
                ),
            )
        } finally {
            harness.close()
        }
    }

    @Test
    fun `reconnect reads durable plan only after the prior apply lease drains`() = runBlocking {
        val harness = Harness()
        try {
            val firstHello = harness.connectThroughRelayWelcome(null)
            val firstTransport = harness.transport()
            firstTransport.sendFixture(
                "host-welcome-snapshot-required",
                firstHello.stringValue("requestId"),
            )
            val priorEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.BeginStateResync
            val leaseEntered = CompletableDeferred<Unit>()
            val releaseLease = CompletableDeferred<Unit>()
            val postLeasePlan = RelayV2ConnectPlan(
                harness.profile.profileId,
                harness.profile.principalId,
                harness.profile.clientInstanceId,
                harness.profile.hostId,
                requestedResume = RelayV2ResumeCursor(HOST_EPOCH, "91"),
                recovery = RelayV2ConnectRecovery.LIVE,
                durableHostEpoch = HOST_EPOCH,
                requiredThroughEventSeq = "91",
            )
            val applying = async(Dispatchers.Default) {
                harness.actor.withEffectApplyLease(priorEffect) {
                    leaseEntered.complete(Unit)
                    releaseLease.await()
                    harness.publishConnectPlan(postLeasePlan)
                }
            }
            leaseEntered.await()
            val leaseReleased = AtomicBoolean(false)
            val prematureLoad = AtomicBoolean(false)
            harness.guardConnectPlanLoad {
                if (!leaseReleased.get()) {
                    prematureLoad.set(true)
                    error("Durable plan loaded before the prior apply lease drained")
                }
            }
            val loadsBeforeReconnect = harness.connectPlanLoadCount()
            assertTrue(harness.actor.connect(harness.profile))
            withTimeout(TIMEOUT_MS) {
                while (firstTransport.closeCodes.isEmpty()) delay(1)
            }
            assertEquals(loadsBeforeReconnect, harness.connectPlanLoadCount())

            leaseReleased.set(true)
            releaseLease.complete(Unit)
            applying.await()
            val secondTransport = harness.awaitTransport(1)
            secondTransport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            secondTransport.sendFixture("relay-welcome")
            val secondHello = secondTransport.awaitSentFrame()
            assertFalse(prematureLoad.get())
            assertEquals(loadsBeforeReconnect + 1, harness.connectPlanLoadCount())
            val resume = secondHello.payload().mutableObject("resume")
            assertEquals(HOST_EPOCH, resume.stringValue("hostEpoch"))
            assertEquals("91", resume.stringValue("lastEventSeq"))
        } finally {
            harness.factory.transports.forEach { it.completeTermination() }
            harness.close()
        }
    }

    @Test
    fun `cursorless reconnect resumes the same durable partial cut after an ordinary close`() =
        runBlocking {
            val namespace = RelayV2StateNamespace(
                "profile-primary",
                PRINCIPAL_ID,
                "android-install-primary",
                HOST_ID,
                HOST_EPOCH,
            )
            val store = FakeStateStore()
            val repository = RelayV2StateSyncRepositoryCore(store)
            val adapter = recoveryAdapter(repository)
            val harness = Harness(durableConnectPlanSource = adapter)
            try {
                val firstHello = harness.connectThroughRelayWelcome(null)
                val firstTransport = harness.transport()
                firstTransport.sendFixture(
                    "host-welcome-snapshot-required",
                    firstHello.stringValue("requestId"),
                )
                val firstHelloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.BeginStateResync
                val firstHelloReceipt = harness.actor.withEffectApplyLease(firstHelloEffect) {
                    adapter.applyHello(firstHelloEffect, emptyList())
                } as RelayV2EffectApplyResult.Applied
                assertTrue(harness.actor.submitRecoveryReceipt(firstHelloReceipt.value))

                val firstGet = firstTransport.awaitSentFrame(1)
                val partial = adapterSnapshotChunkFrame(firstGet, "partial-91", "91")
                partial.payload()["isLast"] = false
                partial.payload()["nextCursor"] = "cursor-partial-1"
                partial.payload()["records"] = listOf(
                    adapterSnapshotRecords("partial-91").first().toWireMapForActorTest(),
                )
                firstTransport.sendFrame(partial)
                val partialEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.ApplyStateSnapshotChunk
                val partialReceipt = harness.actor.withEffectApplyLease(partialEffect) {
                    adapter.applySnapshotChunk(partialEffect, emptyList())
                } as RelayV2EffectApplyResult.Applied
                assertTrue(harness.actor.submitRecoveryReceipt(partialReceipt.value))
                firstTransport.awaitSentFrame(2)

                firstTransport.closed(1000)
                harness.actor.awaitFailure(RelayV2FailureKind.TRANSPORT)
                assertTrue(
                    withTimeout(TIMEOUT_MS) { harness.actor.effects.first() } is
                        RelayV2RuntimeEffect.ConnectionFailed,
                )

                val secondHello = harness.connectThroughRelayWelcome(resume = null)
                val secondTransport = harness.transport()
                secondTransport.sendFixture(
                    "host-welcome-snapshot-required",
                    secondHello.stringValue("requestId"),
                )
                val resumedHelloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.BeginStateResync
                val resumedHelloReceipt = harness.actor.withEffectApplyLease(resumedHelloEffect) {
                    adapter.applyHello(resumedHelloEffect, emptyList())
                } as RelayV2EffectApplyResult.Applied
                assertTrue(harness.actor.submitRecoveryReceipt(resumedHelloReceipt.value))

                val resumedGet = secondTransport.awaitSentFrame(1)
                assertEquals(
                    firstGet.payload().stringValue("snapshotRequestId"),
                    resumedGet.payload().stringValue("snapshotRequestId"),
                )
                assertEquals(
                    partial.payload().stringValue("snapshotId"),
                    resumedGet.payload().stringValue("snapshotId"),
                )
                assertEquals("cursor-partial-1", resumedGet.payload().stringValue("cursor"))
                assertEquals(1L, (resumedGet.payload()["nextChunkIndex"] as Number).toLong())
                assertEquals("91", store.authority(namespace)?.requiredThroughEventSeq)
            } finally {
                harness.close()
            }
        }

    @Test
    fun `reopened complete staging releases the old cut before any new snapshot id`() =
        runBlocking {
            val namespace = RelayV2StateNamespace(
                "profile-primary",
                PRINCIPAL_ID,
                "android-install-primary",
                HOST_ID,
                HOST_EPOCH,
            )
            val store = FakeStateStore()
            val repository = RelayV2StateSyncRepositoryCore(store)
            repository.applyHelloForActorTest(
                RelayV2StateHello(
                    namespace,
                    "91",
                    null,
                    RelayV2StateHelloDisposition.FRESH,
                ),
            )
            val records = adapterSnapshotRecords("complete-before-crash")
            val (bytes, digest) = canonicalSnapshotDigest(records)
            val oldRequestId = "request-complete-before-crash"
            val oldSnapshotId = "snapshot-complete-before-crash"
            val staged = repository.stageSnapshotChunkUnderApplyLease(
                adapterSnapshotChunk(
                    namespace,
                    "complete-before-crash",
                    "91",
                    records,
                    bytes,
                    digest,
                ),
            )
            assertTrue(
                staged is com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateSyncResult.SnapshotStaged &&
                    staged.complete,
            )

            val reopenedAdapter = recoveryAdapter(RelayV2StateSyncRepositoryCore(store))
            val harness = Harness(durableConnectPlanSource = reopenedAdapter)
            try {
                val hello = harness.connectThroughRelayWelcome(null)
                val transport = harness.transport()
                transport.sendFixture(
                    "host-welcome-snapshot-required",
                    hello.stringValue("requestId"),
                )
                val effect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.BeginStateResync
                val receipt = harness.actor.withEffectApplyLease(effect) {
                    reopenedAdapter.applyHello(effect, emptyList())
                } as RelayV2EffectApplyResult.Applied
                assertTrue(harness.actor.submitRecoveryReceipt(receipt.value))

                val release = transport.awaitSentFrame(1)
                assertEquals("state.snapshot.release", release.stringValue("type"))
                assertEquals(oldRequestId, release.payload().stringValue("snapshotRequestId"))
                assertEquals(oldSnapshotId, release.payload().stringValue("snapshotId"))
                assertEquals(RelayV2ConnectionPhase.RESYNCING, harness.actor.state.value.phase)
                assertEquals(2, transport.sent.size)
            } finally {
                harness.close()
            }
        }

    @Test
    fun `events during release and durable completion keep one request and force catchup`(): Unit =
        runBlocking {
            val namespace = RelayV2StateNamespace(
                "profile-primary",
                PRINCIPAL_ID,
                "android-install-primary",
                HOST_ID,
                HOST_EPOCH,
            )
            val store = FakeStateStore()
            val repository = RelayV2StateSyncRepositoryCore(store)
            val adapter = recoveryAdapter(repository)
            val harness = Harness(durableConnectPlanSource = adapter)
            try {
                val hello = harness.connectThroughRelayWelcome(null)
                val transport = harness.transport()
                transport.sendFixture(
                    "host-welcome-snapshot-required",
                    hello.stringValue("requestId"),
                )
                val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.BeginStateResync
                val helloReceipt = harness.actor.withEffectApplyLease(helloEffect) {
                    adapter.applyHello(helloEffect, emptyList())
                } as RelayV2EffectApplyResult.Applied
                assertTrue(harness.actor.submitRecoveryReceipt(helloReceipt.value))

                val firstGet = transport.awaitSentFrame(1)
                transport.sendFrame(adapterSnapshotChunkFrame(firstGet, "base-91", "91"))
                val firstChunk = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.ApplyStateSnapshotChunk
                val firstCommitted = harness.actor.withEffectApplyLease(firstChunk) {
                    adapter.applySnapshotChunk(firstChunk, emptyList())
                } as RelayV2EffectApplyResult.Applied
                assertTrue(harness.actor.submitRecoveryReceipt(firstCommitted.value))
                val releaseA = transport.awaitSentFrame(2)
                val durableRelease = requireNotNull(store.authority(namespace)?.pendingRelease)
                val releaseToken = durableRelease.opaqueToken

                suspend fun bufferEvent(eventSeq: String, revision: String) {
                    val frame = fixture("sessions-changed-upsert")
                    frame["eventSeq"] = eventSeq
                    frame["scopeId"] = "scope-a"
                    frame.payload()["resourceKey"] = "scope-a"
                    frame.payload()["resultingRevision"] = revision
                    frame.payload().mutableObject("change").mutableObject("item")["scopeId"] =
                        "scope-a"
                    transport.sendFrame(frame)
                    val delivery = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                        as RelayV2RuntimeEffect.DeliverPostHandshakeFrame
                    val receipt = harness.actor.withEffectApplyLease(delivery) {
                        adapter.applyRecoveryStateEvent(delivery, emptyList())
                    } as RelayV2EffectApplyResult.Applied
                    assertNull(receipt.value)
                    assertEquals(releaseToken, store.authority(namespace)
                        ?.pendingRelease?.opaqueToken)
                }

                bufferEvent("92", "2")
                assertEquals(3, transport.sent.size)

                val releasedA = fixture("state-snapshot-released")
                releasedA["requestId"] = releaseA.stringValue("requestId")
                releasedA.payload()["snapshotRequestId"] =
                    releaseA.payload().stringValue("snapshotRequestId")
                releasedA.payload()["snapshotId"] = releaseA.payload().stringValue("snapshotId")
                transport.sendFrame(releasedA)
                val completeA = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.CompleteSnapshotRelease

                // The immutable ACK remains valid while a later event transaction changes only
                // the durable after-release plan.
                bufferEvent("93", "3")
                assertEquals(3, transport.sent.size)
                val completedA = harness.actor.withEffectApplyLease(completeA) {
                    requireNotNull(adapter.completeRelease(completeA))
                } as RelayV2EffectApplyResult.Applied
                assertEquals(
                    RelayV2RecoveryRestartDirective.SNAPSHOT,
                    completedA.value.restart,
                )
                assertTrue(harness.actor.submitRecoveryReceipt(completedA.value))
                val secondGet = transport.awaitSentFrame(3)
                assertEquals("state.snapshot.get", secondGet.stringValue("type"))
                assertTrue(
                    secondGet.payload().stringValue("snapshotRequestId") !=
                        firstGet.payload().stringValue("snapshotRequestId"),
                )
                assertTrue(harness.actor.state.value.phase != RelayV2ConnectionPhase.ONLINE)

                transport.sendFrame(adapterSnapshotChunkFrame(secondGet, "base-retry", "91"))
                val retryChunk = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.ApplyStateSnapshotChunk
                val retryCommitted = harness.actor.withEffectApplyLease(retryChunk) {
                    adapter.applySnapshotChunk(retryChunk, emptyList())
                } as RelayV2EffectApplyResult.Applied
                assertTrue(harness.actor.submitRecoveryReceipt(retryCommitted.value))
                assertEquals("93", store.authority(namespace)?.cursorEventSeq)

                val releaseB = transport.awaitSentFrame(4)
                assertEquals("state.snapshot.release", releaseB.stringValue("type"))
            } finally {
                harness.close()
            }
        }

    @Test
    fun `durable gap supersedes release and lease-bound query receipts in either action order`() =
        runBlocking {
            ActionOrder.entries.forEach { actionOrder ->
                val pending = listOf(
                    RelayV2PendingCommand("post-release-race", "window-race"),
                )
                val race = prepareReleaseCompletionRace(pending)
                try {
                    val supersede = race.durablyApplyGap("93", "2", pending)
                    val baselineCount = race.transport.sent.size
                    var delayedQueryReceipt: RelayV2RecoveryReceipt.CommandStatusesApplied? = null
                    val freshFrameIndex = when (actionOrder) {
                        ActionOrder.COMPLETION_FIRST -> {
                            assertTrue(
                                race.harness.actor.submitRecoveryReceipt(race.oldCompletion),
                            )
                            assertTrue(race.harness.commitCommandQueryRegistration())
                            val staleQuery = race.transport.awaitSentFrame(baselineCount)
                            assertEquals("command.query", staleQuery.stringValue("type"))
                            race.transport.sendCommandStatuses(
                                staleQuery.stringValue("requestId"),
                                pending,
                            )
                            val staleApply = withTimeout(TIMEOUT_MS) {
                                race.harness.actor.effects.first()
                            } as RelayV2RuntimeEffect.ApplyCommandStatuses
                            // There is no command-status repository adapter in this foundation.
                            // This lease-bound receipt proves only actor queue ordering; the Room
                            // watermark asserted below is the durable supersede proof.
                            val applied = race.harness.actor.withEffectApplyLease(staleApply) {
                                RelayV2RecoveryReceipt.CommandStatusesApplied(
                                    staleApply.recovery,
                                    HOST_ID,
                                    HOST_EPOCH,
                                    pending,
                                )
                            } as RelayV2EffectApplyResult.Applied
                            delayedQueryReceipt = applied.value
                            assertTrue(
                                race.harness.actor.submitRecoveryReceipt(supersede),
                            )
                            baselineCount + 1
                        }
                        ActionOrder.SUPERSEDE_FIRST -> {
                            assertTrue(
                                race.harness.actor.submitRecoveryReceipt(supersede),
                            )
                            assertTrue(
                                race.harness.actor.submitRecoveryReceipt(race.oldCompletion),
                            )
                            baselineCount
                        }
                    }

                    val freshGet = race.transport.awaitSentFrame(freshFrameIndex)
                    assertEquals("state.snapshot.get", freshGet.stringValue("type"))
                    assertTrue(
                        freshGet.stringValue("requestId") !=
                            race.originalGet.stringValue("requestId"),
                    )
                    assertTrue(
                        freshGet.objectValue("payload").stringValue("snapshotRequestId") !=
                            race.originalGet.objectValue("payload")
                                .stringValue("snapshotRequestId"),
                    )
                    delayedQueryReceipt?.let {
                        assertTrue(race.harness.actor.submitRecoveryReceipt(it))
                    }

                    // The fresh response is a FIFO barrier behind every stale action above.
                    race.transport.sendFrame(
                        adapterSnapshotChunkFrame(
                            freshGet,
                            "race-fresh-${actionOrder.name.lowercase()}",
                            "93",
                        ),
                    )
                    val freshChunk = withTimeout(TIMEOUT_MS) {
                        race.harness.actor.effects.first()
                    } as RelayV2RuntimeEffect.ApplyStateSnapshotChunk
                    assertEquals(
                        freshGet.stringValue("requestId"),
                        freshChunk.recovery.requestId,
                    )
                    assertEquals(
                        freshGet.objectValue("payload").stringValue("snapshotRequestId"),
                        freshChunk.snapshotRequestId,
                    )
                    assertEquals(
                        RelayV2StoredSyncPhase.RESYNCING,
                        race.store.authority(race.namespace)?.phase,
                    )
                    assertEquals("91", race.store.authority(race.namespace)?.cursorEventSeq)
                    assertEquals(
                        "93",
                        race.store.authority(race.namespace)?.requiredThroughEventSeq,
                    )
                    assertEquals(
                        listOf("93"),
                        race.store.events(race.namespace).map { it.event.eventSeq },
                    )
                    assertEquals(
                        RelayV2ConnectionPhase.RESYNCING,
                        race.harness.actor.state.value.phase,
                    )
                } finally {
                    race.harness.close()
                }
            }
        }

    @Test
    fun `late query-bound gap supersedes ONLINE through its completed release lineage`() =
        runBlocking {
            val pending = listOf(
                RelayV2PendingCommand("query-window-race", "window-race"),
            )
            val race = prepareReleaseCompletionRace(pending)
            try {
                val queryFrameIndex = race.transport.sent.size
                assertTrue(race.harness.actor.submitRecoveryReceipt(race.oldCompletion))
                assertTrue(race.harness.commitCommandQueryRegistration())
                val query = race.transport.awaitSentFrame(queryFrameIndex)
                race.transport.sendCommandStatuses(query.stringValue("requestId"), pending)
                val commandApply = withTimeout(TIMEOUT_MS) {
                    race.harness.actor.effects.first()
                } as RelayV2RuntimeEffect.ApplyCommandStatuses
                val commandReceipt = race.harness.actor.withEffectApplyLease(commandApply) {
                    RelayV2RecoveryReceipt.CommandStatusesApplied(
                        commandApply.recovery,
                        HOST_ID,
                        HOST_EPOCH,
                        pending,
                    )
                } as RelayV2EffectApplyResult.Applied

                val supersede = race.durablyApplyGap("93", "2", pending)
                assertEquals(commandApply.recovery, supersede.binding)
                assertEquals(race.oldCompletion.binding, supersede.completedReleaseBinding)
                val freshFrameIndex = race.transport.sent.size
                assertTrue(race.harness.actor.submitRecoveryReceipt(commandReceipt.value))
                race.harness.actor.awaitPhase(RelayV2ConnectionPhase.ONLINE)
                assertTrue(race.harness.actor.submitRecoveryReceipt(supersede))

                val freshGet = race.transport.awaitSentFrame(freshFrameIndex)
                assertEquals("state.snapshot.get", freshGet.stringValue("type"))
                assertEquals(RelayV2ConnectionPhase.RESYNCING, race.harness.actor.state.value.phase)
                assertEquals("93", race.store.authority(race.namespace)?.requiredThroughEventSeq)
                assertEquals(listOf("93"), race.store.events(race.namespace).map {
                    it.event.eventSeq
                })
            } finally {
                race.harness.close()
            }
        }

    @Test
    fun `matched query window retains gap proof across hello and command receipt timing`() =
        runBlocking {
            MatchedGapTiming.entries.forEach { timing ->
                val pending = if (timing == MatchedGapTiming.DURING_COMMAND_RECEIPT) {
                    listOf(RelayV2PendingCommand("matched-gap", "matched-window"))
                } else {
                    emptyList()
                }
                val race = prepareMatchedQueryRace(pending)
                try {
                    val gap = when (timing) {
                        MatchedGapTiming.BEFORE_HELLO_RECEIPT ->
                            race.durablyApplyGap("93", "2", pending)
                                .also { assertEquals(race.helloReceipt.binding, it.binding) }
                        MatchedGapTiming.DURING_COMMAND_RECEIPT -> {
                            assertTrue(
                                race.harness.actor.submitRecoveryReceipt(race.helloReceipt),
                            )
                            assertTrue(race.harness.commitCommandQueryRegistration())
                            val query = race.transport.awaitSentFrame(1)
                            race.transport.sendCommandStatuses(
                                query.stringValue("requestId"),
                                pending,
                            )
                            val commandApply = withTimeout(TIMEOUT_MS) {
                                race.harness.actor.effects.first()
                            } as RelayV2RuntimeEffect.ApplyCommandStatuses
                            val commandReceipt = race.harness.actor.withEffectApplyLease(
                                commandApply,
                            ) {
                                RelayV2RecoveryReceipt.CommandStatusesApplied(
                                    commandApply.recovery,
                                    HOST_ID,
                                    HOST_EPOCH,
                                    pending,
                                )
                            } as RelayV2EffectApplyResult.Applied
                            val proof = race.durablyApplyGap("93", "2", pending)
                            assertEquals(commandApply.recovery, proof.binding)
                            assertTrue(
                                race.harness.actor.submitRecoveryReceipt(commandReceipt.value),
                            )
                            proof
                        }
                    }
                    if (timing == MatchedGapTiming.BEFORE_HELLO_RECEIPT) {
                        assertTrue(
                            race.harness.actor.submitRecoveryReceipt(race.helloReceipt),
                        )
                    }
                    race.harness.actor.awaitPhase(RelayV2ConnectionPhase.ONLINE)
                    val freshFrameIndex = race.transport.sent.size
                    assertTrue(race.harness.actor.submitRecoveryReceipt(gap))

                    val freshGet = race.transport.awaitSentFrame(freshFrameIndex)
                    assertEquals("state.snapshot.get", freshGet.stringValue("type"))
                    assertEquals(RelayV2ConnectionPhase.RESYNCING, race.harness.actor.state.value.phase)
                    assertEquals("93", race.store.authority(race.namespace)?.requiredThroughEventSeq)
                    assertEquals(listOf("93"), race.store.events(race.namespace).map {
                        it.event.eventSeq
                    })
                } finally {
                    race.harness.close()
                }
            }
        }

    @Test
    fun `release replacement keeps the maximum command query window bounded`(): Unit =
        runBlocking {
            val pending = (1..4_096).map {
                RelayV2PendingCommand("bounded-command-$it", "bounded-window")
            }
            // Reopen the real pending release left by a committed cut whose ACK was not applied.
            val seeded = seedSnapshotState("bounded-query", completeRelease = false)
            val adapter = recoveryAdapter(seeded.repository)
            val harness = Harness(durableConnectPlanSource = adapter)
            try {
                val hello = harness.connectThroughRelayWelcome(
                    RelayV2ResumeCursor(HOST_EPOCH, "91"),
                )
                val transport = harness.transport()
                transport.sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
                val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.QueryPendingCommands
                val releaseReceipt = harness.actor.withEffectApplyLease(helloEffect) {
                    adapter.applyHello(helloEffect, pending)
                } as RelayV2EffectApplyResult.Applied
                assertTrue(harness.actor.submitRecoveryReceipt(releaseReceipt.value))

                val release = transport.awaitSentFrame(1)
                val released = fixture("state-snapshot-released")
                released["requestId"] = release.stringValue("requestId")
                released.payload()["snapshotRequestId"] =
                    release.payload().stringValue("snapshotRequestId")
                released.payload()["snapshotId"] = release.payload().stringValue("snapshotId")
                transport.sendFrame(released)
                val completeEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.CompleteSnapshotRelease
                val completed = harness.actor.withEffectApplyLease(completeEffect) {
                    requireNotNull(adapter.completeRelease(completeEffect))
                } as RelayV2EffectApplyResult.Applied
                assertTrue(harness.actor.submitRecoveryReceipt(completed.value))

                repeat(128) { batchIndex ->
                    assertTrue(harness.commitCommandQueryRegistration())
                    val query = transport.awaitSentFrame(batchIndex + 2)
                    val commands = query.payload().commandItems()
                    assertEquals(32, commands.size)
                    transport.sendCommandStatuses(query.stringValue("requestId"), commands)
                    val apply = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                        as RelayV2RuntimeEffect.ApplyCommandStatuses
                    assertTrue(
                        harness.actor.commitRecoveryReceipt(
                            apply,
                            RelayV2RecoveryReceipt.CommandStatusesApplied(
                                apply.recovery,
                                HOST_ID,
                                HOST_EPOCH,
                                commands,
                            ),
                        ),
                    )
                }
                harness.actor.awaitPhase(RelayV2ConnectionPhase.ONLINE)
            } finally {
                harness.close()
            }
        }

    @Test
    fun `late completed release supersede cannot orphan a newer snapshot recovery`() =
        runBlocking {
            val race = prepareReleaseCompletionRace(emptyList())
            try {
                val supersede = race.durablyApplyGap("93", "2", emptyList())
                assertTrue(race.harness.actor.submitRecoveryReceipt(race.oldCompletion))
                race.harness.actor.awaitPhase(RelayV2ConnectionPhase.ONLINE)

                race.transport.sendFrame(sessionUpsertFrame("94", "3"))
                val newerEvent = withTimeout(TIMEOUT_MS) { race.harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.DeliverPostHandshakeFrame
                val newerProof = race.harness.actor.withEffectApplyLease(newerEvent) {
                    requireNotNull(
                        race.adapter.applyOnlineStateEvent(newerEvent, emptyList()),
                    )
                } as RelayV2EffectApplyResult.Applied
                val newerBaselineCount = race.transport.sent.size
                assertTrue(race.harness.actor.submitOnlineResyncRequired(newerProof.value))
                val newerGet = race.transport.awaitSentFrame(newerBaselineCount)
                assertEquals("state.snapshot.get", newerGet.stringValue("type"))

                assertTrue(race.harness.actor.submitRecoveryReceipt(supersede))
                race.transport.sendFrame(
                    adapterSnapshotChunkFrame(newerGet, "newer-recovery", "94"),
                )
                val accepted = withTimeout(TIMEOUT_MS) { race.harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.ApplyStateSnapshotChunk
                assertEquals(newerGet.stringValue("requestId"), accepted.recovery.requestId)
                assertEquals(
                    newerGet.objectValue("payload").stringValue("snapshotRequestId"),
                    accepted.snapshotRequestId,
                )
                assertEquals(RelayV2ConnectionPhase.RESYNCING, race.harness.actor.state.value.phase)
            } finally {
                race.harness.close()
            }
        }

    @Test
    fun `unknown active recovery response id fails closed immediately`() = runBlocking {
        val harness = Harness()
        try {
            val hello = harness.connectThroughRelayWelcome(RelayV2ResumeCursor(HOST_EPOCH, "91"))
            val transport = harness.transport()
            transport.sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
            val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.QueryPendingCommands
            val pending = listOf(RelayV2PendingCommand("unknown-id-command", "window-id"))
            assertEquals(
                RelayV2RecoveryReceiptProcessingResult.ContinuedRecovery,
                harness.actor.processCommittedRecoveryReceipt(
                    helloEffect,
                    RelayV2RecoveryReceipt.HelloApplied(
                        helloEffect.recovery,
                        HOST_ID,
                        HOST_EPOCH,
                        durableCursorEventSeq = "91",
                        pendingCommands = pending,
                    ),
                ),
            )
            assertTrue(harness.commitCommandQueryRegistration())
            val query = transport.awaitSentFrame(1)
            assertEquals("command.query", query.stringValue("type"))

            transport.sendCommandStatuses(
                requestId = "00000000-0000-0000-0000-000000000098",
                commands = pending,
            )

            val failed = harness.actor.awaitFailure(RelayV2FailureKind.SCHEMA)
            assertEquals("INVALID_ENVELOPE", failed.failure?.code)
            assertEquals(listOf(4400), transport.closeCodes)
            assertTrue(harness.actor.state.value.phase != RelayV2ConnectionPhase.ONLINE)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `completed response ledger ignores only exact cross phase duplicates`() = runBlocking {
        run {
            val harness = Harness()
            try {
                val hello = harness.connectThroughRelayWelcome(
                    RelayV2ResumeCursor(HOST_EPOCH, "91"),
                )
                val transport = harness.transport()
                transport.sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
                val effect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.QueryPendingCommands
                val pending = listOf(RelayV2PendingCommand("ledger-command", "ledger-window"))
                val obligation = releaseObligation(
                    "00000000-0000-0000-0000-00000000e001",
                    "00000000-0000-0000-0000-00000000e002",
                    RelayV2RecoveryReleaseReason.ABANDONED,
                    durableCursorEventSeq = "91",
                )
                assertTrue(
                    harness.actor.commitRecoveryReceipt(
                        effect,
                        RelayV2RecoveryReceipt.ReleaseObligationRecovered(
                            effect.recovery,
                            HOST_ID,
                            HOST_EPOCH,
                            "91",
                            pending,
                            obligation,
                            RelayV2RecoveryRestartDirective.QUERY_PENDING_COMMANDS,
                        ),
                    ),
                )
                val release = transport.awaitSentFrame(1)
                val released = fixture("state-snapshot-released")
                released["requestId"] = release.stringValue("requestId")
                released.payload()["snapshotRequestId"] = obligation.snapshotRequestId
                released.payload()["snapshotId"] = obligation.snapshotId
                transport.sendFrame(released)
                val nextEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                assertTrue("unexpected release effect: $nextEffect", nextEffect is RelayV2RuntimeEffect.CompleteSnapshotRelease)
                val complete = nextEffect as RelayV2RuntimeEffect.CompleteSnapshotRelease
                assertTrue(harness.completeSnapshotRelease(complete))
                assertTrue(harness.commitCommandQueryRegistration())
                transport.awaitSentFrame(2)
                assertEquals(RelayV2ConnectionPhase.QUERYING, harness.actor.state.value.phase)

                transport.sendFrame(released)
                delay(25)
                assertEquals(RelayV2ConnectionPhase.QUERYING, harness.actor.state.value.phase)
                val conflicting = deepClone(released)
                conflicting.payload()["released"] = false
                conflicting.payload()["alreadyReleased"] = true
                transport.sendFrame(conflicting)
                assertEquals(
                    "INVALID_ENVELOPE",
                    harness.actor.awaitFailure(RelayV2FailureKind.SCHEMA).failure?.code,
                )
            } finally {
                harness.close()
            }
        }

        run {
            val harness = Harness()
            try {
                val hello = harness.connectThroughRelayWelcome(null)
                val transport = harness.transport()
                transport.sendFixture("host-welcome-snapshot-required", hello.stringValue("requestId"))
                val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.BeginStateResync
                assertTrue(
                    harness.actor.commitRecoveryReceipt(
                        helloEffect,
                        RelayV2RecoveryReceipt.HelloApplied(
                            helloEffect.recovery,
                            HOST_ID,
                            HOST_EPOCH,
                            null,
                            emptyList(),
                        ),
                    ),
                )
                val get = transport.awaitSentFrame(1)
                val chunk = fixture("state-snapshot-chunk")
                chunk["requestId"] = get.stringValue("requestId")
                chunk.payload()["snapshotRequestId"] =
                    get.payload().stringValue("snapshotRequestId")
                transport.sendFrame(chunk)
                val apply = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.ApplyStateSnapshotChunk
                val obligation = releaseObligation(
                    get.payload().stringValue("snapshotRequestId"),
                    chunk.payload().stringValue("snapshotId"),
                    RelayV2RecoveryReleaseReason.COMPLETED,
                    durableCursorEventSeq = "91",
                )
                assertTrue(
                    harness.actor.commitRecoveryReceipt(
                        apply,
                        RelayV2RecoveryReceipt.SnapshotChunkApplied(
                            apply.recovery,
                            HOST_ID,
                            HOST_EPOCH,
                            RelayV2DurableSnapshotApplyResult.Committed(
                                obligation.snapshotRequestId,
                                obligation.snapshotId,
                                "91",
                                obligation,
                            ),
                        ),
                    ),
                )
                val release = transport.awaitSentFrame(2)
                val released = fixture("state-snapshot-released")
                released["requestId"] = release.stringValue("requestId")
                released.payload()["snapshotRequestId"] = obligation.snapshotRequestId
                released.payload()["snapshotId"] = obligation.snapshotId
                transport.sendFrame(released)
                val complete = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.CompleteSnapshotRelease
                assertEquals(
                    RelayV2RecoveryReceiptProcessingResult.OnlineReady(
                        complete.repositoryAuthority,
                    ),
                    harness.processSnapshotRelease(complete),
                )
                harness.actor.awaitPhase(RelayV2ConnectionPhase.ONLINE)

                transport.sendFrame(chunk)
                delay(25)
                assertEquals(RelayV2ConnectionPhase.ONLINE, harness.actor.state.value.phase)
                val conflicting = deepClone(chunk)
                conflicting.payload()["cutDigest"] =
                    "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                transport.sendFrame(conflicting)
                assertEquals(
                    "INVALID_ENVELOPE",
                    harness.actor.awaitFailure(RelayV2FailureKind.SCHEMA).failure?.code,
                )
            } finally {
                harness.close()
            }
        }
    }

    @Test
    fun `snapshot recovery continues commits releases then queries before online`() = runBlocking {
        val harness = Harness()
        try {
            val hello = harness.connectThroughRelayWelcome(null)
            val transport = harness.transport()
            transport.sendFixture(
                "host-welcome-snapshot-required",
                hello.stringValue("requestId"),
            )
            val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.BeginStateResync
            val pending = listOf(RelayV2PendingCommand("cmd-after-snapshot", "window-after"))
            assertTrue(
                harness.actor.commitRecoveryReceipt(
                    helloEffect,
                    RelayV2RecoveryReceipt.HelloApplied(
                        binding = helloEffect.recovery,
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        durableCursorEventSeq = null,
                        pendingCommands = pending,
                    ),
                ),
            )

            val firstGet = transport.awaitSentFrame(1)
            assertEquals("state.snapshot.get", firstGet.stringValue("type"))
            assertEquals(null, firstGet.payload()["snapshotId"])
            assertEquals(null, firstGet.payload()["cursor"])
            assertEquals(0L, firstGet.payload()["nextChunkIndex"])
            val snapshotRequestId = firstGet.payload().stringValue("snapshotRequestId")

            val firstChunk = fixture("state-snapshot-chunk")
            firstChunk["requestId"] = firstGet.stringValue("requestId")
            firstChunk.payload()["snapshotRequestId"] = snapshotRequestId
            firstChunk.payload()["isLast"] = false
            firstChunk.payload()["nextCursor"] = "cursor-1"
            transport.sendFrame(firstChunk)
            val firstStage = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.ApplyStateSnapshotChunk
            val snapshotId = firstChunk.payload().stringValue("snapshotId")
            assertEquals(
                RelayV2RecoveryReceiptProcessingResult.ContinuedRecovery,
                harness.actor.processCommittedRecoveryReceipt(
                    firstStage,
                    RelayV2RecoveryReceipt.SnapshotChunkApplied(
                        binding = firstStage.recovery,
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        result = RelayV2DurableSnapshotApplyResult.Continue(
                            snapshotRequestId = snapshotRequestId,
                            snapshotId = snapshotId,
                            nextChunkIndex = 1,
                            nextCursor = "cursor-1",
                        ),
                    ),
                ),
            )

            val continuation = transport.awaitSentFrame(2)
            assertEquals("state.snapshot.get", continuation.stringValue("type"))
            assertEquals(snapshotRequestId, continuation.payload()["snapshotRequestId"])
            assertEquals(snapshotId, continuation.payload()["snapshotId"])
            assertEquals("cursor-1", continuation.payload()["cursor"])
            assertEquals(1L, continuation.payload()["nextChunkIndex"])

            val lastChunk = fixture("state-snapshot-chunk")
            lastChunk["requestId"] = continuation.stringValue("requestId")
            lastChunk.payload()["snapshotRequestId"] = snapshotRequestId
            lastChunk.payload()["snapshotId"] = snapshotId
            lastChunk.payload()["chunkIndex"] = 1L
            transport.sendFrame(lastChunk)
            val finalStage = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.ApplyStateSnapshotChunk

            assertEquals(
                RelayV2RecoveryReceiptProcessingResult.StaleOrTerminal,
                harness.actor.processCommittedRecoveryReceipt(
                    finalStage,
                    RelayV2RecoveryReceipt.SnapshotChunkApplied(
                        binding = finalStage.recovery,
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        result = RelayV2DurableSnapshotApplyResult.Committed(
                            snapshotRequestId,
                            snapshotId,
                            durableCursorEventSeq = "90",
                            release = releaseObligation(
                                snapshotRequestId,
                                snapshotId,
                                RelayV2RecoveryReleaseReason.COMPLETED,
                                durableCursorEventSeq = "90",
                            ),
                        ),
                    ),
                ),
            )
            delay(25)
            assertEquals(3, transport.sent.size)
            assertEquals(RelayV2ConnectionPhase.RESYNCING, harness.actor.state.value.phase)

            assertEquals(
                RelayV2RecoveryReceiptProcessingResult.ContinuedRecovery,
                harness.actor.processCommittedRecoveryReceipt(
                    finalStage,
                    RelayV2RecoveryReceipt.SnapshotChunkApplied(
                        binding = finalStage.recovery,
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        result = RelayV2DurableSnapshotApplyResult.Committed(
                            snapshotRequestId,
                            snapshotId,
                            durableCursorEventSeq = "91",
                            release = releaseObligation(
                                snapshotRequestId,
                                snapshotId,
                                RelayV2RecoveryReleaseReason.COMPLETED,
                                durableCursorEventSeq = "91",
                            ),
                        ),
                    ),
                ),
            )
            val release = transport.awaitSentFrame(3)
            assertEquals("state.snapshot.release", release.stringValue("type"))
            assertEquals(snapshotRequestId, release.payload()["snapshotRequestId"])
            assertEquals(snapshotId, release.payload()["snapshotId"])
            assertEquals("completed", release.payload()["reason"])
            assertEquals(RelayV2ConnectionPhase.RESYNCING, harness.actor.state.value.phase)

            val released = fixture("state-snapshot-released")
            released["requestId"] = release.stringValue("requestId")
            released.payload()["snapshotRequestId"] = snapshotRequestId
            released.payload()["snapshotId"] = snapshotId
            transport.sendFrame(released)

            val releaseCommit = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.CompleteSnapshotRelease
            assertEquals(RelayV2ReleaseAuthorityProof.RELEASED, releaseCommit.proof)
            assertEquals(
                RelayV2RecoveryReceiptProcessingResult.ContinuedRecovery,
                harness.processSnapshotRelease(releaseCommit),
            )

            assertTrue(harness.commitCommandQueryRegistration())
            val query = transport.awaitSentFrame(4)
            assertEquals("command.query", query.stringValue("type"))
            assertEquals(pending, query.payload().commandItems())
            transport.sendCommandStatuses(query.stringValue("requestId"), pending)
            val commandApply = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.ApplyCommandStatuses
            assertEquals(
                RelayV2RecoveryReceiptProcessingResult.OnlineReady(
                    commandApply.repositoryAuthority,
                ),
                harness.actor.processCommittedRecoveryReceipt(
                    commandApply,
                    RelayV2RecoveryReceipt.CommandStatusesApplied(
                        binding = commandApply.recovery,
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        appliedCommands = pending,
                    ),
                ),
            )

            harness.actor.awaitPhase(RelayV2ConnectionPhase.ONLINE)
            assertEquals(5, transport.sent.size)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `durable repository abandon results release the invalid cut and restart with fresh ids`() =
        runBlocking {
            val cases = listOf(
                RelayV2RecoveryAbandonReason.SNAPSHOT_IDENTITY_CONFLICT to false,
                RelayV2RecoveryAbandonReason.SNAPSHOT_ORDER_CONFLICT to false,
                RelayV2RecoveryAbandonReason.SNAPSHOT_DIGEST_MISMATCH to false,
                RelayV2RecoveryAbandonReason.SNAPSHOT_LIMIT_EXCEEDED to false,
                RelayV2RecoveryAbandonReason.EVENT_GAP to true,
                RelayV2RecoveryAbandonReason.EVENT_BUFFER_OVERFLOW to true,
            )
            cases.forEach { (reason, fromStateEvent) ->
                val harness = Harness()
                try {
                    val hello = harness.connectThroughRelayWelcome(null)
                    val transport = harness.transport()
                    transport.sendFixture(
                        "host-welcome-snapshot-required",
                        hello.stringValue("requestId"),
                    )
                    val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                        as RelayV2RuntimeEffect.BeginStateResync
                    val pending = listOf(
                        RelayV2PendingCommand("pending-${reason.name}", "window-${reason.name}"),
                    )
                    assertTrue(
                        harness.actor.commitRecoveryReceipt(
                            helloEffect,
                            RelayV2RecoveryReceipt.HelloApplied(
                                binding = helloEffect.recovery,
                                hostId = HOST_ID,
                                hostEpoch = HOST_EPOCH,
                                durableCursorEventSeq = null,
                                pendingCommands = pending,
                            ),
                        ),
                    )

                    val firstGet = transport.awaitSentFrame(1)
                    val abandonedSnapshotRequestId =
                        firstGet.payload().stringValue("snapshotRequestId")
                    val abandonedSnapshotId = "cut-${reason.name}"
                    val sourceEffect: RelayV2RuntimeEffect.GenerationScoped = if (fromStateEvent) {
                        transport.sendFixture("sessions-changed-upsert")
                        val delivered = withTimeout(TIMEOUT_MS) {
                            harness.actor.effects.first()
                        } as RelayV2RuntimeEffect.DeliverPostHandshakeFrame
                        assertEquals(
                            firstGet.stringValue("requestId"),
                            delivered.recovery?.requestId,
                        )
                        delivered
                    } else {
                        val chunk = fixture("state-snapshot-chunk")
                        chunk["requestId"] = firstGet.stringValue("requestId")
                        chunk.payload()["snapshotRequestId"] = abandonedSnapshotRequestId
                        chunk.payload()["snapshotId"] = abandonedSnapshotId
                        transport.sendFrame(chunk)
                        withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                            as RelayV2RuntimeEffect.ApplyStateSnapshotChunk
                    }
                    val binding = when (sourceEffect) {
                        is RelayV2RuntimeEffect.ApplyStateSnapshotChunk -> sourceEffect.recovery
                        is RelayV2RuntimeEffect.DeliverPostHandshakeFrame ->
                            requireNotNull(sourceEffect.recovery)
                        else -> error("Unexpected abandon source: $sourceEffect")
                    }
                    val abandoned = RelayV2RecoveryReceipt.RecoveryAbandoned(
                        binding = binding,
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        reason = reason,
                        durableCursorEventSeq = "90",
                        pendingCommands = pending,
                        release = releaseObligation(
                            abandonedSnapshotRequestId,
                            abandonedSnapshotId,
                            RelayV2RecoveryReleaseReason.ABANDONED,
                        ),
                        restart = RelayV2RecoveryRestartDirective.SNAPSHOT,
                    )
                    assertTrue(harness.actor.commitRecoveryReceipt(sourceEffect, abandoned))

                    val release = transport.awaitSentFrame(2)
                    assertEquals("state.snapshot.release", release.stringValue("type"))
                    assertEquals("abandoned", release.payload()["reason"])
                    assertEquals(abandonedSnapshotRequestId, release.payload()["snapshotRequestId"])
                    assertEquals(abandonedSnapshotId, release.payload()["snapshotId"])

                    val released = fixture("state-snapshot-released")
                    released["requestId"] = release.stringValue("requestId")
                    released.payload()["snapshotRequestId"] = abandonedSnapshotRequestId
                    released.payload()["snapshotId"] = abandonedSnapshotId
                    transport.sendFrame(released)

                    val releaseCommit = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                        as RelayV2RuntimeEffect.CompleteSnapshotRelease
                    assertTrue(harness.completeSnapshotRelease(releaseCommit))

                    val restarted = transport.awaitSentFrame(3)
                    assertEquals("state.snapshot.get", restarted.stringValue("type"))
                    assertTrue(
                        restarted.stringValue("requestId") != firstGet.stringValue("requestId"),
                    )
                    assertTrue(
                        restarted.payload().stringValue("snapshotRequestId") !=
                            abandonedSnapshotRequestId,
                    )
                    assertEquals(null, restarted.payload()["snapshotId"])
                    assertEquals(null, restarted.payload()["cursor"])
                    assertEquals(RelayV2ConnectionPhase.RESYNCING, harness.actor.state.value.phase)

                    // The old durable result can still enter the current generation queue, but its
                    // retired step/request cannot release again, restart again, or reach ONLINE.
                    assertTrue(harness.actor.commitRecoveryReceipt(sourceEffect, abandoned))
                    delay(25)
                    assertEquals(4, transport.sent.size)
                    assertEquals(RelayV2ConnectionPhase.RESYNCING, harness.actor.state.value.phase)
                } finally {
                    harness.close()
                }
            }
        }

    @Test
    fun `abandon proof can query only after release and a durable cursor reaches welcome`() =
        runBlocking {
            val harness = Harness()
            try {
                val hello = harness.connectThroughRelayWelcome(
                    RelayV2ResumeCursor(HOST_EPOCH, "90"),
                )
                val transport = harness.transport()
                transport.sendFixture(
                    "host-welcome-cursor-behind",
                    hello.stringValue("requestId"),
                )
                val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.BeginStateResync
                val pending = listOf(RelayV2PendingCommand("pending-after-abandon", "window-after"))
                assertTrue(
                    harness.actor.commitRecoveryReceipt(
                        helloEffect,
                        RelayV2RecoveryReceipt.HelloApplied(
                            helloEffect.recovery,
                            HOST_ID,
                            HOST_EPOCH,
                            durableCursorEventSeq = "90",
                            pendingCommands = pending,
                        ),
                    ),
                )
                val get = transport.awaitSentFrame(1)
                val chunk = fixture("state-snapshot-chunk")
                chunk["requestId"] = get.stringValue("requestId")
                chunk.payload()["snapshotRequestId"] =
                    get.payload().stringValue("snapshotRequestId")
                transport.sendFrame(chunk)
                val apply = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.ApplyStateSnapshotChunk
                assertTrue(
                    harness.actor.commitRecoveryReceipt(
                        apply,
                        RelayV2RecoveryReceipt.RecoveryAbandoned(
                            binding = apply.recovery,
                            hostId = HOST_ID,
                            hostEpoch = HOST_EPOCH,
                            reason = RelayV2RecoveryAbandonReason.SNAPSHOT_DIGEST_MISMATCH,
                            durableCursorEventSeq = "91",
                            pendingCommands = pending,
                            release = releaseObligation(
                                get.payload().stringValue("snapshotRequestId"),
                                chunk.payload().stringValue("snapshotId"),
                                RelayV2RecoveryReleaseReason.ABANDONED,
                                durableCursorEventSeq = "91",
                            ),
                            restart = RelayV2RecoveryRestartDirective.QUERY_PENDING_COMMANDS,
                        ),
                    ),
                )
                val release = transport.awaitSentFrame(2)
                assertEquals("state.snapshot.release", release.stringValue("type"))
                assertEquals(RelayV2ConnectionPhase.RESYNCING, harness.actor.state.value.phase)

                val released = fixture("state-snapshot-released")
                released["requestId"] = release.stringValue("requestId")
                released.payload()["snapshotRequestId"] = release.payload()["snapshotRequestId"]
                released.payload()["snapshotId"] = release.payload()["snapshotId"]
                transport.sendFrame(released)

                val releaseCommit = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.CompleteSnapshotRelease
                assertTrue(harness.completeSnapshotRelease(releaseCommit))

                assertTrue(harness.commitCommandQueryRegistration())
                val query = transport.awaitSentFrame(3)
                assertEquals("command.query", query.stringValue("type"))
                assertEquals(pending, query.payload().commandItems())
                transport.sendCommandStatuses(query.stringValue("requestId"), pending)
                val commandApply = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.ApplyCommandStatuses
                assertTrue(
                    harness.actor.commitRecoveryReceipt(
                        commandApply,
                        RelayV2RecoveryReceipt.CommandStatusesApplied(
                            commandApply.recovery,
                            HOST_ID,
                            HOST_EPOCH,
                            pending,
                        ),
                    ),
                )
                harness.actor.awaitPhase(RelayV2ConnectionPhase.ONLINE)
                assertEquals(4, transport.sent.size)
            } finally {
                harness.close()
            }
        }

    @Test
    fun `snapshot expired proves exact durable release obligation before fresh restart`() =
        runBlocking {
            val harness = Harness()
            try {
                val hello = harness.connectThroughRelayWelcome(null)
                val transport = harness.transport()
                transport.sendFixture("host-welcome-snapshot-required", hello.stringValue("requestId"))
                val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.BeginStateResync
                assertTrue(
                    harness.actor.commitRecoveryReceipt(
                        helloEffect,
                        RelayV2RecoveryReceipt.HelloApplied(
                            helloEffect.recovery,
                            HOST_ID,
                            HOST_EPOCH,
                            durableCursorEventSeq = null,
                            pendingCommands = emptyList(),
                        ),
                    ),
                )
                val firstGet = transport.awaitSentFrame(1)
                val chunk = fixture("state-snapshot-chunk")
                chunk["requestId"] = firstGet.stringValue("requestId")
                chunk.payload()["snapshotRequestId"] =
                    firstGet.payload().stringValue("snapshotRequestId")
                transport.sendFrame(chunk)
                val apply = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.ApplyStateSnapshotChunk
                val releaseDirective = releaseObligation(
                    firstGet.payload().stringValue("snapshotRequestId"),
                    chunk.payload().stringValue("snapshotId"),
                    RelayV2RecoveryReleaseReason.ABANDONED,
                )
                assertTrue(
                    harness.actor.commitRecoveryReceipt(
                        apply,
                        RelayV2RecoveryReceipt.RecoveryAbandoned(
                            apply.recovery,
                            HOST_ID,
                            HOST_EPOCH,
                            RelayV2RecoveryAbandonReason.SNAPSHOT_DIGEST_MISMATCH,
                            durableCursorEventSeq = null,
                            pendingCommands = emptyList(),
                            release = releaseDirective,
                            restart = RelayV2RecoveryRestartDirective.SNAPSHOT,
                        ),
                    ),
                )
                val release = transport.awaitSentFrame(2)

                transport.sendFrame(
                    linkedMapOf(
                        "protocolVersion" to 2L,
                        "kind" to "response",
                        "type" to "error",
                        "requestId" to release.stringValue("requestId"),
                        "hostId" to HOST_ID,
                        "hostEpoch" to HOST_EPOCH,
                        "payload" to null,
                        "error" to linkedMapOf(
                            "code" to "SNAPSHOT_EXPIRED",
                            "message" to "Pinned cut expired",
                            "retryable" to false,
                            "commandDisposition" to "not_applicable",
                        ),
                    ),
                )

                val complete = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.CompleteSnapshotRelease
                assertEquals(RelayV2ReleaseAuthorityProof.SNAPSHOT_EXPIRED, complete.proof)
                assertEquals(releaseDirective, complete.release)
                assertEquals(3, transport.sent.size)
                assertTrue(harness.completeSnapshotRelease(complete))

                val restarted = transport.awaitSentFrame(3)
                assertEquals("state.snapshot.get", restarted.stringValue("type"))
                assertTrue(
                    restarted.payload().stringValue("snapshotRequestId") !=
                        releaseDirective.snapshotRequestId,
                )
                assertEquals(RelayV2ConnectionPhase.RESYNCING, harness.actor.state.value.phase)
            } finally {
                harness.close()
            }
        }

    @Test
    fun `exact expired continuation is durably discarded before a fresh snapshot request`() =
        runBlocking {
            val namespace = RelayV2StateNamespace(
                "profile-primary",
                PRINCIPAL_ID,
                "android-install-primary",
                HOST_ID,
                HOST_EPOCH,
            )
            val store = FakeStateStore()
            val repository = RelayV2StateSyncRepositoryCore(store)
            val seed = adapterSnapshotRecords("cursor-90")
            val (seedBytes, seedDigest) = canonicalSnapshotDigest(seed)
            repository.applyHelloForActorTest(
                RelayV2StateHello(namespace, "90", null, RelayV2StateHelloDisposition.FRESH),
            )
            repository.stageSnapshotChunkUnderApplyLease(
                adapterSnapshotChunk(namespace, "cursor-90", "90", seed, seedBytes, seedDigest),
            )
            val committed = repository.commitSnapshotUnderApplyLease(
                namespace,
                "snapshot-cursor-90",
            ) as com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateSyncResult.SnapshotCommitted
            repository.completeSnapshotReleaseUnderApplyLease(committed.release)
            repository.applyHelloForActorTest(
                RelayV2StateHello(
                    namespace,
                    "91",
                    RelayV2AppliedCursor(HOST_EPOCH, "90"),
                    RelayV2StateHelloDisposition.CURSOR_BEHIND,
                ),
            )
            val cut = adapterSnapshotRecords("continuation")
            val (cutBytes, cutDigest) = canonicalSnapshotDigest(cut)
            repository.stageSnapshotChunkUnderApplyLease(
                RelayV2SnapshotChunk(
                    namespace = namespace,
                    snapshotRequestId = "persisted-snapshot-request",
                    snapshotId = "persisted-snapshot-cut",
                    snapshotCreatedAtMs = 100,
                    snapshotLeaseExpiresAtMs = 200,
                    snapshotAbsoluteExpiresAtMs = 1_000,
                    chunkIndex = 0,
                    requestedCursor = null,
                    isLast = false,
                    nextCursor = "persisted-cursor-1",
                    throughEventSeq = "91",
                    scopesRevision = "1",
                    totalRecords = cut.size.toLong(),
                    totalCanonicalBytes = cutBytes,
                    cutDigest = cutDigest,
                    records = cut.take(2),
                    rawUtf8Bytes = 512,
                ),
            )
            val adapter = recoveryAdapter(repository)
            val harness = Harness(durableConnectPlanSource = adapter)
            try {
                val hello = harness.connectThroughRelayWelcome(
                    RelayV2ResumeCursor(HOST_EPOCH, "90"),
                )
                val transport = harness.transport()
                transport.sendFixture("host-welcome-cursor-behind", hello.stringValue("requestId"))
                val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.BeginStateResync
                val helloReceipt = harness.actor.withEffectApplyLease(helloEffect) {
                    adapter.applyHello(
                        helloEffect,
                        emptyList(),
                    )
                } as RelayV2EffectApplyResult.Applied
                assertTrue(harness.actor.submitRecoveryReceipt(helloReceipt.value))
                val continuation = transport.awaitSentFrame(1)
                assertEquals("persisted-snapshot-request", continuation.payload()["snapshotRequestId"])
                assertEquals("persisted-snapshot-cut", continuation.payload()["snapshotId"])
                assertEquals("persisted-cursor-1", continuation.payload()["cursor"])

                transport.sendFrame(
                    snapshotExpiredError(continuation.stringValue("requestId")),
                )
                val expire = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.ExpireSnapshotContinuation
                val expired = harness.actor.withEffectApplyLease(expire) {
                    requireNotNull(adapter.expireContinuation(expire, emptyList()))
                } as RelayV2EffectApplyResult.Applied
                assertNull(store.snapshot(namespace))
                assertTrue(harness.actor.submitRecoveryReceipt(expired.value))

                val fresh = transport.awaitSentFrame(2)
                assertEquals("state.snapshot.get", fresh.stringValue("type"))
                assertTrue(
                    fresh.payload().stringValue("snapshotRequestId") !=
                        "persisted-snapshot-request",
                )
                assertEquals(null, fresh.payload()["snapshotId"])
            } finally {
                harness.close()
            }
        }

    @Test
    fun `reconnect resumes durable release obligation before issuing a fresh snapshot id`() =
        runBlocking {
            val namespace = RelayV2StateNamespace(
                "profile-primary",
                PRINCIPAL_ID,
                "android-install-primary",
                HOST_ID,
                HOST_EPOCH,
            )
            val store = FakeStateStore()
            val firstRepository = RelayV2StateSyncRepositoryCore(store)
            val firstAdapter = recoveryAdapter(firstRepository)
            val harness = Harness(durableConnectPlanSource = firstAdapter)
            try {
                val firstHello = harness.connectThroughRelayWelcome(null)
                val firstTransport = harness.transport()
                firstTransport.sendFixture(
                    "host-welcome-snapshot-required",
                    firstHello.stringValue("requestId"),
                )
                val firstEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.BeginStateResync
                val helloApplied = harness.actor.withEffectApplyLease(firstEffect) {
                    firstAdapter.applyHello(firstEffect, pendingCommands = emptyList())
                } as RelayV2EffectApplyResult.Applied
                assertTrue(harness.actor.submitRecoveryReceipt(helloApplied.value))
                val firstGet = firstTransport.awaitSentFrame(1)
                val chunkFrame = fixture("state-snapshot-chunk")
                chunkFrame["requestId"] = firstGet.stringValue("requestId")
                chunkFrame.payload()["snapshotRequestId"] =
                    firstGet.payload().stringValue("snapshotRequestId")
                val records = adapterSnapshotRecords("invalid-before-crash")
                val (bytes, _) = canonicalSnapshotDigest(records)
                val invalidDigest = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                chunkFrame.payload().apply {
                    this["snapshotCreatedAtMs"] = 100L
                    this["snapshotLeaseExpiresAtMs"] = 200L
                    this["snapshotAbsoluteExpiresAtMs"] = 1_000L
                    this["throughEventSeq"] = "91"
                    this["scopesRevision"] = "1"
                    this["totalRecords"] = records.size.toLong()
                    this["totalCanonicalBytes"] = bytes
                    this["cutDigest"] = invalidDigest
                    this["records"] = records.map { it.toWireMapForActorTest() }
                }
                firstTransport.sendFrame(chunkFrame)
                val chunkEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.ApplyStateSnapshotChunk
                val durableAbandon = harness.actor.withEffectApplyLease(chunkEffect) {
                    firstAdapter.applySnapshotChunk(
                        chunkEffect,
                        pendingCommands = emptyList(),
                    )
                } as RelayV2EffectApplyResult.Applied
                assertTrue(harness.actor.submitRecoveryReceipt(durableAbandon.value))
                val firstRelease = firstTransport.awaitSentFrame(2)
                assertEquals("state.snapshot.release", firstRelease.stringValue("type"))

                harness.actor.disconnectAndDrain(harness.profile.identity, "release-disconnect")
                withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }

                // Reopen the repository over the same durable store; no intermediate receipt is
                // fabricated by the test.
                val reopenedAdapter = recoveryAdapter(RelayV2StateSyncRepositoryCore(store))
                val reactivated = harness.profile.copy(activationGeneration = 2)
                val secondHello = harness.connectThroughRelayWelcome(null, reactivated)
                val secondTransport = harness.transport()
                secondTransport.sendFixture(
                    "host-welcome-snapshot-required",
                    secondHello.stringValue("requestId"),
                )
                val secondEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.BeginStateResync
                val recovered = harness.actor.withEffectApplyLease(secondEffect) {
                    reopenedAdapter.applyHello(
                        secondEffect,
                        pendingCommands = emptyList(),
                    )
                } as RelayV2EffectApplyResult.Applied
                assertTrue(harness.actor.submitRecoveryReceipt(recovered.value))
                val secondRelease = secondTransport.awaitSentFrame(1)
                assertEquals("state.snapshot.release", secondRelease.stringValue("type"))
                assertTrue(
                    secondRelease.stringValue("requestId") != firstRelease.stringValue("requestId"),
                )
                assertEquals(firstRelease.payload(), secondRelease.payload())

                val released = fixture("state-snapshot-released")
                released["requestId"] = secondRelease.stringValue("requestId")
                released.payload()["snapshotRequestId"] = secondRelease.payload()["snapshotRequestId"]
                released.payload()["snapshotId"] = secondRelease.payload()["snapshotId"]
                secondTransport.sendFrame(released)
                val complete = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.CompleteSnapshotRelease
                val completed = harness.actor.withEffectApplyLease(complete) {
                    requireNotNull(reopenedAdapter.completeRelease(complete))
                } as RelayV2EffectApplyResult.Applied
                assertTrue(harness.actor.submitRecoveryReceipt(completed.value))

                val freshGet = secondTransport.awaitSentFrame(2)
                assertEquals("state.snapshot.get", freshGet.stringValue("type"))
                assertTrue(
                    freshGet.payload().stringValue("snapshotRequestId") !=
                        secondRelease.payload().stringValue("snapshotRequestId"),
                )
                val freshChunkFrame = fixture("state-snapshot-chunk")
                freshChunkFrame["requestId"] = freshGet.stringValue("requestId")
                freshChunkFrame.payload()["snapshotRequestId"] =
                    freshGet.payload().stringValue("snapshotRequestId")
                val freshRecords = adapterSnapshotRecords("after-reopen")
                val (freshBytes, freshDigest) = canonicalSnapshotDigest(freshRecords)
                freshChunkFrame.payload().apply {
                    this["snapshotCreatedAtMs"] = 100L
                    this["snapshotLeaseExpiresAtMs"] = 200L
                    this["snapshotAbsoluteExpiresAtMs"] = 1_000L
                    this["throughEventSeq"] = "91"
                    this["scopesRevision"] = "1"
                    this["totalRecords"] = freshRecords.size.toLong()
                    this["totalCanonicalBytes"] = freshBytes
                    this["cutDigest"] = freshDigest
                    this["records"] = freshRecords.map { it.toWireMapForActorTest() }
                }
                secondTransport.sendFrame(freshChunkFrame)
                val freshChunkEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.ApplyStateSnapshotChunk
                val freshCommitted = harness.actor.withEffectApplyLease(freshChunkEffect) {
                    reopenedAdapter.applySnapshotChunk(
                        freshChunkEffect,
                        pendingCommands = emptyList(),
                    )
                } as RelayV2EffectApplyResult.Applied
                assertTrue(harness.actor.submitRecoveryReceipt(freshCommitted.value))
                val completedRelease = secondTransport.awaitSentFrame(3)
                val completedAck = fixture("state-snapshot-released")
                completedAck["requestId"] = completedRelease.stringValue("requestId")
                completedAck.payload()["snapshotRequestId"] =
                    completedRelease.payload()["snapshotRequestId"]
                completedAck.payload()["snapshotId"] = completedRelease.payload()["snapshotId"]
                secondTransport.sendFrame(completedAck)
                val completeCommitted = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    as RelayV2RuntimeEffect.CompleteSnapshotRelease
                val committedReceipt = harness.actor.withEffectApplyLease(completeCommitted) {
                    requireNotNull(reopenedAdapter.completeRelease(completeCommitted))
                } as RelayV2EffectApplyResult.Applied
                assertTrue(harness.actor.submitRecoveryReceipt(committedReceipt.value))
                harness.actor.awaitPhase(RelayV2ConnectionPhase.ONLINE)
                Unit
            } finally {
                harness.close()
            }
        }

    @Test
    fun `release ack with two authority proofs fails closed`() = runBlocking {
        val harness = Harness()
        try {
            val hello = harness.connectThroughRelayWelcome(null)
            val transport = harness.transport()
            transport.sendFixture("host-welcome-snapshot-required", hello.stringValue("requestId"))
            val effect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.BeginStateResync
            val release = releaseObligation(
                "00000000-0000-0000-0000-00000000d001",
                "00000000-0000-0000-0000-00000000d002",
                RelayV2RecoveryReleaseReason.ABANDONED,
            )
            assertTrue(
                harness.actor.commitRecoveryReceipt(
                    effect,
                    RelayV2RecoveryReceipt.ReleaseObligationRecovered(
                        effect.recovery,
                        HOST_ID,
                        HOST_EPOCH,
                        durableCursorEventSeq = null,
                        pendingCommands = emptyList(),
                        release = release,
                        restart = RelayV2RecoveryRestartDirective.SNAPSHOT,
                    ),
                ),
            )
            val releaseFrame = transport.awaitSentFrame(1)
            val invalid = fixture("state-snapshot-released")
            invalid["requestId"] = releaseFrame.stringValue("requestId")
            invalid.payload()["snapshotRequestId"] = release.snapshotRequestId
            invalid.payload()["snapshotId"] = release.snapshotId
            invalid.payload()["released"] = true
            invalid.payload()["alreadyReleased"] = true
            transport.sendRaw(RelayV2StrictJson.stringify(invalid).toByteArray(Charsets.UTF_8))

            val failed = harness.actor.awaitFailure(RelayV2FailureKind.SCHEMA)
            assertEquals("INVALID_ENVELOPE", failed.failure?.code)
            assertEquals(listOf(4400), transport.closeCodes)
            assertTrue(harness.actor.state.value.phase != RelayV2ConnectionPhase.ONLINE)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `lost durable receipts and abandoned release responses fail closed on recovery deadline`() =
        runBlocking {
            suspend fun awaitDeadline(
                deadlines: CopyOnWriteArrayList<CompletableDeferred<Unit>>,
                count: Int,
            ): CompletableDeferred<Unit> = withTimeout(TIMEOUT_MS) {
                while (deadlines.size < count) delay(1)
                deadlines[count - 1]
            }

            run {
                val deadlines = CopyOnWriteArrayList<CompletableDeferred<Unit>>()
                val harness = Harness(
                    recoveryWatchdogDelay = {
                        CompletableDeferred<Unit>().also(deadlines::add).await()
                    },
                )
                try {
                    val hello = harness.connectThroughRelayWelcome(null)
                    val transport = harness.transport()
                    transport.sendFixture(
                        "host-welcome-snapshot-required",
                        hello.stringValue("requestId"),
                    )
                    withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                    awaitDeadline(deadlines, 1).complete(Unit)

                    val failed = harness.actor.awaitFailure(RelayV2FailureKind.TRANSPORT)
                    assertEquals("RECOVERY_TIMEOUT", failed.failure?.code)
                    assertEquals(listOf(1013), transport.closeCodes)
                    assertTrue(harness.actor.state.value.phase != RelayV2ConnectionPhase.ONLINE)
                } finally {
                    harness.close()
                }
            }

            run {
                val deadlines = CopyOnWriteArrayList<CompletableDeferred<Unit>>()
                val harness = Harness(
                    recoveryWatchdogDelay = {
                        CompletableDeferred<Unit>().also(deadlines::add).await()
                    },
                )
                try {
                    val hello = harness.connectThroughRelayWelcome(null)
                    val transport = harness.transport()
                    transport.sendFixture(
                        "host-welcome-snapshot-required",
                        hello.stringValue("requestId"),
                    )
                    val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                        as RelayV2RuntimeEffect.BeginStateResync
                    assertTrue(
                        harness.actor.commitRecoveryReceipt(
                            helloEffect,
                            RelayV2RecoveryReceipt.HelloApplied(
                                helloEffect.recovery,
                                HOST_ID,
                                HOST_EPOCH,
                                durableCursorEventSeq = null,
                                pendingCommands = emptyList(),
                            ),
                        ),
                    )
                    val get = transport.awaitSentFrame(1)
                    val chunk = fixture("state-snapshot-chunk")
                    chunk["requestId"] = get.stringValue("requestId")
                    chunk.payload()["snapshotRequestId"] =
                        get.payload().stringValue("snapshotRequestId")
                    transport.sendFrame(chunk)
                    val apply = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                        as RelayV2RuntimeEffect.ApplyStateSnapshotChunk
                    assertTrue(
                        harness.actor.commitRecoveryReceipt(
                            apply,
                            RelayV2RecoveryReceipt.RecoveryAbandoned(
                                apply.recovery,
                                HOST_ID,
                                HOST_EPOCH,
                                RelayV2RecoveryAbandonReason.SNAPSHOT_DIGEST_MISMATCH,
                                durableCursorEventSeq = null,
                                pendingCommands = emptyList(),
                                release = releaseObligation(
                                    get.payload().stringValue("snapshotRequestId"),
                                    chunk.payload().stringValue("snapshotId"),
                                    RelayV2RecoveryReleaseReason.ABANDONED,
                                ),
                                restart = RelayV2RecoveryRestartDirective.SNAPSHOT,
                            ),
                        ),
                    )
                    transport.awaitSentFrame(2)
                    val releaseDeadline = withTimeout(TIMEOUT_MS) {
                        while (deadlines.size < 4) delay(1)
                        deadlines.last()
                    }
                    releaseDeadline.complete(Unit)

                    val failed = harness.actor.awaitFailure(RelayV2FailureKind.TRANSPORT)
                    assertEquals("RECOVERY_TIMEOUT", failed.failure?.code)
                    assertEquals(listOf(1013), transport.closeCodes)
                    assertEquals(3, transport.sent.size)
                    assertTrue(harness.actor.state.value.phase != RelayV2ConnectionPhase.ONLINE)
                } finally {
                    harness.close()
                }
            }
        }

    @Test
    fun `stale queued recovery timeout cannot suppress the current stage watchdog`() = runBlocking {
        val armedTimeouts = CopyOnWriteArrayList<() -> Unit>()
        suspend fun fireTimeout(index: Int) = withTimeout(TIMEOUT_MS) {
            while (armedTimeouts.size <= index) delay(1)
            armedTimeouts[index].invoke()
        }
        val responseEntered = CountDownLatch(1)
        val releaseResponse = CountDownLatch(1)
        val staleTimeoutEntered = CountDownLatch(1)
        val releaseStaleTimeout = CountDownLatch(1)
        val blockResponse = AtomicBoolean(true)
        val blockTimeout = AtomicBoolean(true)
        val harness = Harness(
            recoveryWatchdogDelay = { CompletableDeferred<Unit>().await() },
            afterRecoveryWatchdogArmed = { _, fire -> armedTimeouts += fire },
            beforeRecoveryFrameDispatch = {
                if (blockResponse.compareAndSet(true, false)) {
                    responseEntered.countDown()
                    check(releaseResponse.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                }
            },
            beforeRecoveryTimeoutClaim = {
                if (blockTimeout.compareAndSet(true, false)) {
                    staleTimeoutEntered.countDown()
                    check(releaseStaleTimeout.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                }
            },
        )
        try {
            val hello = harness.connectThroughRelayWelcome(null)
            val transport = harness.transport()
            transport.sendFixture("host-welcome-snapshot-required", hello.stringValue("requestId"))
            val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.BeginStateResync
            assertTrue(
                harness.actor.commitRecoveryReceipt(
                    helloEffect,
                    RelayV2RecoveryReceipt.HelloApplied(
                        helloEffect.recovery,
                        HOST_ID,
                        HOST_EPOCH,
                        durableCursorEventSeq = null,
                        pendingCommands = emptyList(),
                    ),
                ),
            )
            val get = transport.awaitSentFrame(1)
            val chunk = fixture("state-snapshot-chunk")
            chunk["requestId"] = get.stringValue("requestId")
            chunk.payload()["snapshotRequestId"] = get.payload().stringValue("snapshotRequestId")
            transport.sendFrame(chunk)
            assertTrue(responseEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))

            // Queue the response-stage timeout behind the already-dispatched valid response.
            fireTimeout(1)
            releaseResponse.countDown()
            assertTrue(staleTimeoutEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))

            // The response advanced to its durable-receipt stage and armed a new exact watchdog.
            // Fire it while the stale timeout action is still at the head of the actor queue.
            fireTimeout(2)
            releaseStaleTimeout.countDown()

            val failed = harness.actor.awaitFailure(RelayV2FailureKind.TRANSPORT)
            assertEquals("RECOVERY_TIMEOUT", failed.failure?.code)
            assertEquals(listOf(1013), transport.closeCodes)
            assertTrue(harness.actor.state.value.phase != RelayV2ConnectionPhase.ONLINE)
        } finally {
            releaseResponse.countDown()
            releaseStaleTimeout.countDown()
            harness.close()
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
            assertTrue(harness.actor.connect(harness.profile))
            val first = harness.awaitTransport(0)
            assertTrue(harness.actor.connect(harness.profile))
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
                as RelayV2RuntimeEffect.BeginStateResync
            assertEquals(
                RelayV2ConnectionPhase.RESYNCING,
                harness.actor.awaitPhase(RelayV2ConnectionPhase.RESYNCING).phase,
            )
            assertTrue(first.closeCodes.contains(1000))

            assertTrue(harness.actor.connect(harness.profile))
            val third = harness.awaitTransport(2)
            assertFalse(
                harness.actor.commitRecoveryReceipt(
                    effect,
                    RelayV2RecoveryReceipt.HelloApplied(
                        binding = effect.recovery,
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        durableCursorEventSeq = null,
                        pendingCommands = emptyList(),
                    ),
                ),
            )
            assertTrue(third.sent.isEmpty())
        } finally {
            harness.close()
        }
    }

    @Test
    fun `reconnect and disconnect receipt wait for the same transport termination fence`() =
        runBlocking {
            val harness = Harness()
            try {
                assertTrue(harness.actor.connect(harness.profile))
                val first = harness.awaitTransport(0)
                first.completeTerminationOnClose = false

                assertTrue(harness.actor.connect(harness.profile))
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
            assertTrue(harness.actor.connect(harness.profile))
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
                assertTrue(harness.actor.connect(harness.profile))
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
                assertTrue(harness.actor.connect(replacement))
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
                    RelayV2RecoveryReceipt.HelloApplied(
                        binding = oldEffect.recovery,
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        durableCursorEventSeq = "91",
                        pendingCommands = listOf(
                            RelayV2PendingCommand("old-command", "old-window"),
                        ),
                    )
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
            val appliedReceipt = withTimeout(TIMEOUT_MS) { applying.await() }
            val durableReceipt = when (appliedReceipt) {
                is RelayV2EffectApplyResult.Applied -> appliedReceipt.value
                RelayV2EffectApplyResult.Stale -> error("Active lease became stale")
            }
            assertFalse(harness.actor.submitRecoveryReceipt(durableReceipt))
            assertEquals("switch-barrier", withTimeout(TIMEOUT_MS) { barrier.await() }.barrierId)
            commits += "barrier-complete"
            withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
            commits += "old-profile-cleared"
            val replacement = harness.installProfile("replacement", activationGeneration = 2)
            assertTrue(harness.actor.connect(replacement))
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
    fun `current repository read lease shares apply drain and rejects noncurrent cuts`() =
        runBlocking {
            val disconnectOwnerSealed = CompletableDeferred<Unit>()
            val releaseHeldRead = CompletableDeferred<Unit>()
            val harness = Harness(
                optionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
                afterDisconnectOwnerSeal = { disconnectOwnerSealed.complete(Unit) },
            )
            val crossActor = Harness()
            try {
                val authority = harness.negotiateAgentExtension(
                    RelayV2ConnectionPhase.RESYNCING,
                )
                val cut = (
                    harness.actor.currentRepositoryReadCut(
                        RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE,
                    ) as RelayV2CurrentRepositoryReadCutResult.Available
                    ).cut
                assertEquals(
                    RelayV2CurrentRepositoryReadLeaseResult.Current("current"),
                    harness.actor.withCurrentRepositoryReadLease(cut) { "current" },
                )

                val blockedInvocations = AtomicInteger(0)
                val forged = object : RelayV2CurrentRepositoryReadCut {
                    override val authority = authority
                    override val capability =
                        RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE
                }
                assertEquals(
                    RelayV2CurrentRepositoryReadLeaseResult.Stale,
                    harness.actor.withCurrentRepositoryReadLease(forged) {
                        blockedInvocations.incrementAndGet()
                    },
                )
                assertEquals(
                    RelayV2CurrentRepositoryReadLeaseResult.Stale,
                    crossActor.actor.withCurrentRepositoryReadLease(cut) {
                        blockedInvocations.incrementAndGet()
                    },
                )
                assertEquals(0, blockedInvocations.get())

                val failure = IllegalStateException("read failed")
                assertSame(
                    failure,
                    runCatching {
                        harness.actor.withCurrentRepositoryReadLease(cut) { throw failure }
                    }.exceptionOrNull(),
                )
                val cancellation = CancellationException("read cancelled")
                assertSame(
                    cancellation,
                    runCatching {
                        harness.actor.withCurrentRepositoryReadLease(cut) {
                            throw cancellation
                        }
                    }.exceptionOrNull(),
                )

                val readEntered = CompletableDeferred<Unit>()
                val heldRead = async(Dispatchers.Default) {
                    harness.actor.withCurrentRepositoryReadLease(cut) {
                        readEntered.complete(Unit)
                        releaseHeldRead.await()
                        "held"
                    }
                }
                withTimeout(TIMEOUT_MS) { readEntered.await() }
                val barrier = async {
                    harness.actor.disconnectAndDrain(
                        harness.profile.identity,
                        "repository-read-drain",
                    )
                }
                withTimeout(TIMEOUT_MS) { disconnectOwnerSealed.await() }
                assertFalse(barrier.isCompleted)
                assertEquals(
                    RelayV2CurrentRepositoryReadCutResult.Unavailable,
                    harness.actor.currentRepositoryReadCut(
                        RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE,
                    ),
                )
                assertEquals(
                    RelayV2CurrentRepositoryReadLeaseResult.Stale,
                    harness.actor.withCurrentRepositoryReadLease(cut) {
                        blockedInvocations.incrementAndGet()
                    },
                )

                releaseHeldRead.complete(Unit)
                assertEquals(
                    RelayV2CurrentRepositoryReadLeaseResult.Current("held"),
                    withTimeout(TIMEOUT_MS) { heldRead.await() },
                )
                assertEquals(
                    "repository-read-drain",
                    withTimeout(TIMEOUT_MS) { barrier.await() }.barrierId,
                )
                withTimeout(TIMEOUT_MS) {
                    harness.actor.effects.first { it is RelayV2RuntimeEffect.Disconnected }
                }
                assertEquals(
                    RelayV2CurrentRepositoryReadLeaseResult.Stale,
                    harness.actor.withCurrentRepositoryReadLease(cut) {
                        blockedInvocations.incrementAndGet()
                    },
                )

                val higherActivation = harness.profile.copy(activationGeneration = 2)
                val higherAuthority = harness.negotiateAgentExtension(
                    RelayV2ConnectionPhase.RESYNCING,
                    connectingProfile = higherActivation,
                )
                val higherCut = (
                    harness.actor.currentRepositoryReadCut(
                        RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE,
                    ) as RelayV2CurrentRepositoryReadCutResult.Available
                    ).cut
                assertEquals(2L, higherAuthority.profileActivationGeneration)
                assertEquals(higherAuthority, higherCut.authority)
                assertEquals(
                    RelayV2CurrentRepositoryReadLeaseResult.Stale,
                    harness.actor.withCurrentRepositoryReadLease(cut) {
                        blockedInvocations.incrementAndGet()
                    },
                )

                harness.actor.disconnectAndDrain(
                    higherActivation.identity,
                    "higher-activation-drain",
                )
                withTimeout(TIMEOUT_MS) {
                    harness.actor.effects.first { it is RelayV2RuntimeEffect.Disconnected }
                }
                val otherProfile = harness.installProfile("read-other", activationGeneration = 1)
                val otherAuthority = harness.negotiateAgentExtension(
                    RelayV2ConnectionPhase.RESYNCING,
                    connectingProfile = otherProfile,
                )
                val otherCut = (
                    harness.actor.currentRepositoryReadCut(
                        RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE,
                    ) as RelayV2CurrentRepositoryReadCutResult.Available
                    ).cut
                assertEquals(otherProfile.profileId, otherAuthority.profileId)
                assertEquals(otherAuthority, otherCut.authority)
                assertEquals(
                    RelayV2CurrentRepositoryReadLeaseResult.Stale,
                    harness.actor.withCurrentRepositoryReadLease(higherCut) {
                        blockedInvocations.incrementAndGet()
                    },
                )
                assertEquals(
                    RelayV2CurrentRepositoryReadLeaseResult.Current("other"),
                    harness.actor.withCurrentRepositoryReadLease(otherCut) { "other" },
                )
                assertEquals(0, blockedInvocations.get())
            } finally {
                releaseHeldRead.complete(Unit)
                harness.close()
                crossActor.close()
            }

            val reconnectRelease = CompletableDeferred<Unit>()
            val reconnectHarness = Harness(
                optionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
            )
            try {
                reconnectHarness.negotiateAgentExtension(RelayV2ConnectionPhase.RESYNCING)
                val oldCut = (
                    reconnectHarness.actor.currentRepositoryReadCut(
                        RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE,
                    ) as RelayV2CurrentRepositoryReadCutResult.Available
                    ).cut
                val reconnectReadEntered = CompletableDeferred<Unit>()
                val heldReconnectRead = async(Dispatchers.Default) {
                    reconnectHarness.actor.withCurrentRepositoryReadLease(oldCut) {
                        reconnectReadEntered.complete(Unit)
                        reconnectRelease.await()
                        "reconnect-held"
                    }
                }
                withTimeout(TIMEOUT_MS) { reconnectReadEntered.await() }
                val transportCount = reconnectHarness.factory.transports.size
                assertTrue(reconnectHarness.actor.connect(reconnectHarness.profile))
                withTimeout(TIMEOUT_MS) {
                    while (reconnectHarness.actor.currentRepositoryReadCut(
                            RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE,
                        ) != RelayV2CurrentRepositoryReadCutResult.Unavailable
                    ) {
                        delay(1)
                    }
                }
                assertEquals(transportCount, reconnectHarness.factory.transports.size)

                reconnectRelease.complete(Unit)
                assertEquals(
                    RelayV2CurrentRepositoryReadLeaseResult.Current("reconnect-held"),
                    withTimeout(TIMEOUT_MS) { heldReconnectRead.await() },
                )
                val replacement = reconnectHarness.awaitTransport(transportCount)
                replacement.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                reconnectHarness.actor.awaitPhase(
                    RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME,
                )
                replacement.sendFixture("relay-welcome")
                val hello = replacement.awaitSentFrame()
                val welcome = fixture("host-welcome-snapshot-required")
                welcome["requestId"] = hello.stringValue("requestId")
                welcome.payload()["capabilities"] =
                    RelayV2ConnectionActor.REQUIRED_CAPABILITIES
                replacement.sendFrame(welcome)
                val effect = withTimeout(TIMEOUT_MS) {
                    reconnectHarness.actor.effects.first {
                        it is RelayV2RuntimeEffect.BeginStateResync
                    }
                } as RelayV2RuntimeEffect.BeginStateResync
                assertFalse(
                    AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY in
                        effect.context.negotiatedCapabilities,
                )
                assertEquals(
                    RelayV2CurrentRepositoryReadCutResult.Unavailable,
                    reconnectHarness.actor.currentRepositoryReadCut(
                        RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE,
                    ),
                )
                var staleRuns = 0
                assertEquals(
                    RelayV2CurrentRepositoryReadLeaseResult.Stale,
                    reconnectHarness.actor.withCurrentRepositoryReadLease(oldCut) {
                        staleRuns += 1
                    },
                )
                assertEquals(0, staleRuns)
            } finally {
                reconnectRelease.complete(Unit)
                reconnectHarness.close()
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

            assertFalse(harness.actor.connect(harness.profile))
            assertEquals(readsBeforeFence, harness.credentialReadCount())
            releaseApply.complete(Unit)
            withTimeout(TIMEOUT_MS) { applying.await() }
            assertEquals("activation-fence", withTimeout(TIMEOUT_MS) { barrier.await() }.barrierId)
            withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }

            assertFalse(harness.actor.connect(harness.profile))
            assertEquals(readsBeforeFence, harness.credentialReadCount())
            val reactivated = harness.profile.copy(activationGeneration = 2)
            assertTrue(harness.actor.connect(reactivated))
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
                assertTrue(harness.actor.connect(harness.profile))
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
                assertTrue(harness.actor.connect(harness.profile))
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
                assertTrue(blockedHarness.actor.connect(blockedHarness.profile))
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
                assertTrue(createdHarness.actor.connect(createdHarness.profile))
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
                assertTrue(openedHarness.actor.connect(openedHarness.profile))
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
                assertTrue(failedHarness.actor.connect(failedHarness.profile))
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
                        throwingHarness.actor.connect(throwingHarness.profile),
                    )
                    throwingHarness.actor.awaitFailure(RelayV2FailureKind.TRANSPORT)
                    val transport = throwingHarness.awaitTransport(0)
                    withTimeout(TIMEOUT_MS) {
                        while (transport.closeCodes.isEmpty()) delay(1)
                    }

                    throwingFactory.failureAfterCreate = null
                    assertTrue(
                        callbackName,
                        throwingHarness.actor.connect(throwingHarness.profile),
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
                assertTrue(timing.name, harness.actor.connect(harness.profile))

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

                assertTrue(timing.name, harness.actor.connect(harness.profile))
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
            assertTrue(harness.actor.connect(harness.profile))
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
            assertTrue(harness.actor.connect(reactivated))
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
            assertTrue(directHarness.actor.connect(directHarness.profile))
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
            assertTrue(harness.actor.connect(harness.profile))
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
            assertTrue(blockedHarness.actor.connect(blockedHarness.profile))
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
                    assertTrue(order, harness.actor.connect(harness.profile))
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

                    assertTrue(order, harness.actor.connect(harness.profile))
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
            assertTrue(harness.actor.connect(harness.profile))
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
            assertTrue(harness.actor.connect(harness.profile))
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

            assertTrue(harness.actor.connect(harness.profile))
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
                    assertTrue("${scenario.name}:$order", harness.actor.connect(harness.profile))
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
                    assertTrue("$name:$order", harness.actor.connect(harness.profile))
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
            assertTrue(harness.actor.connect(harness.profile))
            val first = harness.awaitTransport(0)
            first.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            first.sendFixture("relay-welcome")
            assertTrue(factory.sendEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            first.throwOnSecondClose = true

            assertTrue(harness.actor.connect(harness.profile))
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
                assertTrue(scenario, harness.actor.connect(harness.profile))
                val committed = harness.awaitTransport(0)
                committed.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                harness.actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
                committed.sendFixture("relay-welcome")
                assertTrue(factory.sendEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                factory.onTransportCreated = {
                    secondCreated.countDown()
                    check(releaseSecond.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                }

                assertTrue(scenario, harness.actor.connect(harness.profile))
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
                assertTrue(harness.actor.connect(harness.profile))
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

                assertTrue(harness.actor.connect(harness.profile))
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
                assertTrue(harness.actor.connect(harness.profile))
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
                assertTrue(relayHarness.actor.connect(relayHarness.profile))
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
                    raceHarness.connect(
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
            assertTrue(tlsHarness.actor.connect(tlsHarness.profile))
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
            assertTrue(mismatchHarness.actor.connect(mismatchHarness.profile))
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
            assertTrue(harness.actor.connect(harness.profile))
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
            assertTrue(actionHarness.actor.connect(actionHarness.profile))
            assertTrue(blockingFactory.openEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            assertTrue(actionHarness.actor.connect(actionHarness.profile))
            assertFalse(actionHarness.actor.connect(actionHarness.profile))
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
                eventHarness.connect(
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
            assertTrue(actionByteHarness.actor.connect(actionByteHarness.profile))
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

        val recoveryReceiptByteHarness = Harness(actionByteCapacity = 4_096)
        try {
            val hello = recoveryReceiptByteHarness.connectThroughRelayWelcome(
                RelayV2ResumeCursor(HOST_EPOCH, "91"),
            )
            recoveryReceiptByteHarness.transport().sendFixture(
                "host-welcome-caught-up",
                hello.stringValue("requestId"),
            )
            val effect = withTimeout(TIMEOUT_MS) {
                recoveryReceiptByteHarness.actor.effects.first()
            } as RelayV2RuntimeEffect.QueryPendingCommands
            assertFalse(
                recoveryReceiptByteHarness.actor.commitRecoveryReceipt(
                    effect,
                    RelayV2RecoveryReceipt.HelloApplied(
                        binding = effect.recovery,
                        hostId = HOST_ID,
                        hostEpoch = HOST_EPOCH,
                        durableCursorEventSeq = "91",
                        pendingCommands = (1..24).map {
                            RelayV2PendingCommand(
                                "c$it-${"c".repeat(92)}",
                                "w$it-${"w".repeat(92)}",
                            )
                        },
                    ),
                ),
            )

            val failed = recoveryReceiptByteHarness.actor.awaitFailure(
                RelayV2FailureKind.QUEUE_SATURATED,
            )
            assertEquals("SLOW_CONSUMER", failed.failure?.code)
            assertEquals(listOf(1013), recoveryReceiptByteHarness.transport().closeCodes)
        } finally {
            recoveryReceiptByteHarness.close()
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
            assertTrue(harness.actor.connect(harness.profile))
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
            assertTrue(harness.actor.connect(harness.profile))
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
                assertTrue(harness.actor.connect(harness.profile))
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
                resyncHarness.transport().sendFixture("sessions-changed-upsert")
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
                assertTrue(harness.actor.connect(harness.profile))
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
            assertTrue(harness.actor.connect(harness.profile))
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
            assertTrue(harness.actor.connect(harness.profile))
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
                assertTrue(harness.actor.connect(harness.profile))

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
                assertTrue(harness.actor.connect(recovered))
                harness.awaitTransport(0)
                assertEquals(1, harness.factory.requests.size)
            } finally {
                harness.close()
            }
        }
    }

    private fun completedHandoff(admission: AgentTranscriptLifecycleRequestAdmission) =
        AgentTranscriptLifecycleCompletedHandoffReceipt(admission)

    private fun agentStatusRequest(
        authority: RelayV2RepositoryEffectAuthority,
        requestId: String,
    ) = AgentTranscriptLifecycleActorRequest.Status(
        authority = authority,
        frame =
            com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec
                .AgentTimelineStatusGetFrame(
                    requestId = requestId,
                    hostId = HOST_ID,
                    expectedHostEpoch = HOST_EPOCH,
                    scopeId = "scope-local",
                    sessionId = "session-1",
                ),
        requestFence = AgentLocalRequestFence("1", requestId),
    )

    private fun agentSnapshotRequest(
        authority: RelayV2RepositoryEffectAuthority,
        requestId: String,
    ) = AgentTranscriptLifecycleActorRequest.Snapshot(
        authority = authority,
        frame = AgentTimelineSnapshotGetFrame(
            requestId = requestId,
            hostId = HOST_ID,
            expectedHostEpoch = HOST_EPOCH,
            scopeId = "scope-local",
            sessionId = "session-1",
            request = AgentTimelineSnapshotRequest(
                snapshotRequestId = "snapshot-cut-$requestId",
                snapshotId = null,
                cursor = null,
                nextPageIndex = 0,
            ),
        ),
    )

    private fun agentUnavailableStatus(requestId: String) = AgentTimelineStatusFrame(
        requestId = requestId,
        hostId = HOST_ID,
        hostEpoch = HOST_EPOCH,
        scopeId = "scope-local",
        sessionId = "session-1",
        status = AgentTimelineUnavailableStatus(
            AgentTimelineUnavailableReason.AGENT_UNSUPPORTED,
        ),
    )

    private fun hostEpochMismatch(requestId: String) = AgentTimelineErrorFrame(
        requestId = requestId,
        hostId = HOST_ID,
        hostEpoch = "host-epoch-agent-actual",
        scopeId = "scope-local",
        sessionId = "session-1",
        error = AgentTimelineStructuredError(
            code = AgentTimelineErrorCode.HOST_EPOCH_MISMATCH,
            message = "host epoch changed",
            retryable = false,
            commandDisposition = AgentTimelineErrorCommandDisposition.NOT_APPLICABLE,
            details = AgentTimelineHostEpochMismatchDetails(
                expectedHostEpoch = HOST_EPOCH,
                actualHostEpoch = "host-epoch-agent-actual",
            ),
        ),
    )

    private inner class Harness(
        val factory: FakeTransportFactory = FakeTransportFactory(),
        normalActionCapacity: Int = RelayV2ConnectionActor.DEFAULT_ACTION_CAPACITY,
        reservedActionCapacity: Int = RelayV2ConnectionActor.DEFAULT_RESERVED_ACTION_CAPACITY,
        eventCapacity: Int = RelayV2ConnectionActor.DEFAULT_EVENT_CAPACITY,
        actionByteCapacity: Long = RelayV2ConnectionActor.DEFAULT_ACTION_BYTE_CAPACITY,
        effectByteCapacity: Long = RelayV2ConnectionActor.DEFAULT_EFFECT_BYTE_CAPACITY,
        extensionActionCapacity: Int = 64,
        extensionEventCapacity: Int = RelayV2ConnectionActor.DEFAULT_EXTENSION_EVENT_CAPACITY,
        extensionActionByteCapacity: Long =
            RelayV2ConnectionActor.DEFAULT_EXTENSION_ACTION_BYTE_CAPACITY,
        extensionEffectByteCapacity: Long =
            RelayV2ConnectionActor.DEFAULT_EXTENSION_EFFECT_BYTE_CAPACITY,
        extensionRequestTimeoutMs: Long = RelayV2ConnectionActor.EXTENSION_REQUEST_TIMEOUT_MS,
        extensionRequestWatchdogDelay: suspend (Long) -> Unit = { delay(it) },
        beforeAgentExtensionRequestSend: suspend () -> Unit = {},
        afterAgentExtensionRedriveEnqueuedBeforeSwap: () -> Unit = {},
        watchdogDelay: suspend (Long) -> Unit = { delay(it) },
        recoveryWatchdogDelay: suspend (Long) -> Unit = { delay(it) },
        afterRecoveryWatchdogArmed: (RelayV2RecoveryBinding, () -> Unit) -> Unit =
            { _, _ -> },
        beforeTransportCommit: suspend () -> Unit = {},
        beforeTerminalClaim: () -> Unit = {},
        beforeRecoveryTimeoutClaim: () -> Unit = {},
        beforeRecoveryFrameDispatch: () -> Unit = {},
        betweenTerminalCauseReadAndOwnerRevoke: () -> Unit = {},
        afterCallbackAdmission: (RelayV2Transport) -> Unit = {},
        afterDisconnectOwnerSeal: () -> Unit = {},
        beforeOutboxExecuteReadyRead: () -> Unit = {},
        durableConnectPlanSource: RelayV2ConnectPlanSource? = null,
        optionalCapabilities: Set<String> = emptySet(),
        private val queryAdmissionComposition: RelayV2OutboxQueryAdmissionComposition? =
            RelayV2OutboxQueryAdmissionAuthority.composition(),
    ) {
        private val parent = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        private val credentials = MemoryCredentialStore()
        private val connectPlans = MutableConnectPlanSource()
        val profile = installProfile("primary", activationGeneration = 1)
        val actor = RelayV2ConnectionActor(
            parentScope = parent,
            transportFactory = factory,
            credentialStore = credentials,
            connectPlanSource = durableConnectPlanSource ?: connectPlans,
            codec = codec,
            commandQueryAdmissionComposition = queryAdmissionComposition,
            optionalCapabilities = optionalCapabilities,
            clock = { NOW_MS },
            watchdogDelay = watchdogDelay,
            recoveryWatchdogDelay = recoveryWatchdogDelay,
            afterRecoveryWatchdogArmed = afterRecoveryWatchdogArmed,
            beforeTransportCommit = beforeTransportCommit,
            beforeTerminalClaim = beforeTerminalClaim,
            beforeRecoveryTimeoutClaim = beforeRecoveryTimeoutClaim,
            beforeRecoveryFrameDispatch = beforeRecoveryFrameDispatch,
            betweenTerminalCauseReadAndOwnerRevoke =
                betweenTerminalCauseReadAndOwnerRevoke,
            afterCallbackAdmission = afterCallbackAdmission,
            afterDisconnectOwnerSeal = afterDisconnectOwnerSeal,
            beforeOutboxExecuteReadyRead = beforeOutboxExecuteReadyRead,
            normalActionCapacity = normalActionCapacity,
            reservedActionCapacity = reservedActionCapacity,
            eventCapacity = eventCapacity,
            actionByteCapacity = actionByteCapacity,
            effectByteCapacity = effectByteCapacity,
            extensionActionCapacity = extensionActionCapacity,
            extensionEventCapacity = extensionEventCapacity,
            extensionActionByteCapacity = extensionActionByteCapacity,
            extensionEffectByteCapacity = extensionEffectByteCapacity,
            extensionRequestTimeoutMs = extensionRequestTimeoutMs,
            extensionRequestWatchdogDelay = extensionRequestWatchdogDelay,
            beforeAgentExtensionRequestSend = beforeAgentExtensionRequestSend,
            afterAgentExtensionRedriveEnqueuedBeforeSwap =
                afterAgentExtensionRedriveEnqueuedBeforeSwap,
        )
        private val queryAdmissionRepository = CommittingQueryAdmissionRepository()
        private val queryAdmissionLease = object : RelayV2RepositoryEffectApplyLeasePort {
            var forceApply = false

            override suspend fun <T> withEffectApplyLease(
                authority: RelayV2RepositoryEffectAuthority,
                block: suspend () -> T,
            ): RelayV2EffectApplyResult<T> = if (forceApply) {
                RelayV2EffectApplyResult.Applied(block())
            } else {
                actor.withEffectApplyLease(authority, block)
            }
        }
        private val queryAdmissionAdapter by lazy {
            requireNotNull(queryAdmissionComposition).adapter(
                queryAdmissionLease,
                queryAdmissionRepository,
            )
        }

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
            connectPlans.set(profile, resume = null)
            return profile
        }

        suspend fun connectThroughRelayWelcome(
            resume: RelayV2ResumeCursor?,
            connectingProfile: RelayV2Profile = profile,
            brokerOptionalCapabilities: Set<String> = emptySet(),
        ): MutableMap<String, Any?> {
            val transportIndex = factory.transports.size
            assertTrue(connect(connectingProfile, resume))
            val transport = awaitTransport(transportIndex)
            transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME)
            val relayWelcome = fixture("relay-welcome")
            relayWelcome.payload()["capabilities"] =
                RelayV2ConnectionActor.REQUIRED_CAPABILITIES +
                brokerOptionalCapabilities.sorted()
            transport.sendFrame(relayWelcome)
            val hello = transport.awaitSentFrame()
            actor.awaitPhase(RelayV2ConnectionPhase.AWAITING_HOST_WELCOME)
            return hello
        }

        suspend fun negotiateAgentExtension(
            targetPhase: RelayV2ConnectionPhase,
            connectingProfile: RelayV2Profile = profile,
        ): RelayV2RepositoryEffectAuthority {
            require(
                targetPhase == RelayV2ConnectionPhase.QUERYING ||
                    targetPhase == RelayV2ConnectionPhase.RESYNCING ||
                    targetPhase == RelayV2ConnectionPhase.ONLINE,
            )
            val matched = targetPhase != RelayV2ConnectionPhase.RESYNCING
            val hello = connectThroughRelayWelcome(
                resume = if (matched) RelayV2ResumeCursor(HOST_EPOCH, "91") else null,
                connectingProfile = connectingProfile,
                brokerOptionalCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
            )
            val welcome = fixture(
                if (matched) "host-welcome-caught-up" else "host-welcome-snapshot-required",
            )
            welcome["requestId"] = hello.stringValue("requestId")
            welcome.payload()["capabilities"] =
                RelayV2ConnectionActor.REQUIRED_CAPABILITIES +
                AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY
            transport().sendFrame(welcome)
            val effect = withTimeout(TIMEOUT_MS) {
                actor.effects.first {
                    it is RelayV2RuntimeEffect.QueryPendingCommands ||
                        it is RelayV2RuntimeEffect.BeginStateResync
                }
            }
                as RelayV2RuntimeEffect.RepositoryScoped
            if (targetPhase == RelayV2ConnectionPhase.ONLINE) {
                val query = effect as RelayV2RuntimeEffect.QueryPendingCommands
                assertTrue(
                    actor.commitRecoveryReceipt(
                        query,
                        RelayV2RecoveryReceipt.HelloApplied(
                            binding = query.recovery,
                            hostId = HOST_ID,
                            hostEpoch = HOST_EPOCH,
                            durableCursorEventSeq = "91",
                            pendingCommands = emptyList(),
                        ),
                    ),
                )
                actor.awaitPhase(RelayV2ConnectionPhase.ONLINE)
            } else {
                actor.awaitPhase(targetPhase)
            }
            return effect.repositoryAuthority
        }

        fun connect(
            connectingProfile: RelayV2Profile,
            resume: RelayV2ResumeCursor?,
        ): Boolean {
            connectPlans.set(connectingProfile, resume)
            return actor.connect(connectingProfile)
        }

        suspend fun awaitTransport(index: Int): FakeTransport = withTimeout(TIMEOUT_MS) {
            while (factory.transports.size <= index) delay(1)
            factory.transports[index]
        }

        fun transport(): FakeTransport = factory.transports.last()

        suspend fun completeSnapshotRelease(
            effect: RelayV2RuntimeEffect.CompleteSnapshotRelease,
        ): Boolean = actor.commitRecoveryReceipt(
            effect,
            RelayV2RecoveryReceipt.SnapshotReleaseCompleted(
                binding = effect.recovery,
                hostId = HOST_ID,
                hostEpoch = HOST_EPOCH,
                release = effect.release,
                restart = effect.expectedRestart,
            ),
        )

        suspend fun processSnapshotRelease(
            effect: RelayV2RuntimeEffect.CompleteSnapshotRelease,
        ): RelayV2RecoveryReceiptProcessingResult = actor.processCommittedRecoveryReceipt(
            effect,
            RelayV2RecoveryReceipt.SnapshotReleaseCompleted(
                binding = effect.recovery,
                hostId = HOST_ID,
                hostEpoch = HOST_EPOCH,
                release = effect.release,
                restart = effect.expectedRestart,
            ),
        )

        suspend fun issueCommandQueryReceipt(
            effect: RelayV2RuntimeEffect.RegisterCommandQueryAttempt,
            forceApply: Boolean = false,
        ): RelayV2RecoveryReceipt.CommandQueryAttemptRegistered {
            queryAdmissionRepository.prepare(effect)
            queryAdmissionLease.forceApply = forceApply
            val result = try {
                queryAdmissionAdapter.handle(effect)
            } finally {
                queryAdmissionLease.forceApply = false
            }
            assertEquals(1, queryAdmissionRepository.commitCount)
            return (result as RelayV2OutboxQueryAdmissionApplyResult.Committed).receipt
        }

        suspend fun acknowledgeActorActionsWithStateEvent(
            eventSeq: String,
            resultingRevision: String,
        ) {
            transport().sendFrame(sessionUpsertFrame(eventSeq, resultingRevision))
            withTimeout(TIMEOUT_MS) {
                actor.effects.first { it is RelayV2RuntimeEffect.DeliverPostHandshakeFrame }
            }
        }

        fun credentialReadCount(): Int = credentials.readCount.get()

        fun publishConnectPlan(plan: RelayV2ConnectPlan) {
            connectPlans.publish(profile, plan)
        }

        fun guardConnectPlanLoad(guard: () -> Unit) {
            connectPlans.beforeLoad = guard
        }

        fun connectPlanLoadCount(): Int = connectPlans.loadCount.get()

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

    private class CommittingQueryAdmissionRepository : RelayV2OutboxRecoveryAuthority {
        private val core = RelayV2OutboxAuthorityCore()
        private var state = RelayV2OutboxState.empty()
        private lateinit var expected: RelayV2RuntimeEffect.RegisterCommandQueryAttempt

        var commitCount = 0
            private set

        fun prepare(effect: RelayV2RuntimeEffect.RegisterCommandQueryAttempt) {
            expected = effect
            state = RelayV2OutboxState.empty()
            commitCount = 0
            expected.commandBatch.commands.forEachIndexed { index, command ->
                state = applied(
                    core.reduce(
                        state,
                        RelayV2OutboxAction.Enqueue(
                            draft = RelayV2OutboxDraft(
                                profileId = expected.repositoryAuthority.profileId,
                                principalId = expected.repositoryAuthority.principalId,
                                hostId = expected.hostId,
                                expectedHostEpoch = expected.hostEpoch,
                                dedupeWindowId = command.dedupeWindowId,
                                commandId = command.commandId,
                                scopeId = "scope-query-admission",
                                sessionId = "session-query-admission-$index",
                                arguments = RelayV2OutboxArguments.sendAgentMessage(
                                    pane = 0,
                                    message = "continue",
                                    submit = true,
                                ),
                            ),
                            createdAtMillis = index.toLong() + 1,
                        ),
                    ),
                ).state
            }
            state = applied(
                core.reduce(
                    state,
                    RelayV2OutboxAction.DispatchEligible(
                        attemptRequestIds = state.entries.associate { entry ->
                            entry.id to "execute-query-admission-${entry.createdOrder}"
                        },
                        effectBudget = state.entries.size,
                    ),
                ),
            ).state
        }

        override suspend fun reduceOutboxBatchUnderApplyLease(
            namespace: RelayV2OutboxAuthorityNamespace,
            actionSource: (RelayV2OutboxState) -> List<RelayV2OutboxAction>?,
        ): RelayV2OutboxBatchResult {
            check(namespace.profileId == expected.repositoryAuthority.profileId)
            check(
                namespace.profileActivationGeneration ==
                    expected.repositoryAuthority.profileActivationGeneration,
            )
            check(namespace.principalId == expected.repositoryAuthority.principalId)
            check(namespace.clientInstanceId == expected.repositoryAuthority.clientInstanceId)
            val actions = actionSource(state)
                ?: return RelayV2OutboxBatchResult.Rejected(state, null)
            check(actions.size == 1)
            val result = core.reduce(state, actions.single())
            return when (result) {
                is RelayV2OutboxResult.Rejected ->
                    RelayV2OutboxBatchResult.Rejected(state, result.reason)
                is RelayV2OutboxResult.Applied -> {
                    state = result.state
                    commitCount += 1
                    RelayV2OutboxBatchResult.Applied(state, result.effects)
                }
            }
        }

        private fun applied(result: RelayV2OutboxResult): RelayV2OutboxResult.Applied {
            check(result is RelayV2OutboxResult.Applied)
            return result
        }
    }

    private suspend fun issueIndependentCommandQueryReceipt(
        effect: RelayV2RuntimeEffect.RegisterCommandQueryAttempt,
        composition: RelayV2OutboxQueryAdmissionComposition,
        applyLease: RelayV2RepositoryEffectApplyLeasePort,
    ): RelayV2RecoveryReceipt.CommandQueryAttemptRegistered {
        val repository = CommittingQueryAdmissionRepository()
        repository.prepare(effect)
        val result = composition.adapter(applyLease, repository).handle(effect)
        assertEquals(1, repository.commitCount)
        return (result as RelayV2OutboxQueryAdmissionApplyResult.Committed).receipt
    }

    private class MutableConnectPlanSource : RelayV2ConnectPlanSource {
        private val plans = linkedMapOf<String, RelayV2ConnectPlan>()
        val loadCount = AtomicInteger()
        @Volatile
        var beforeLoad: (() -> Unit)? = null

        fun set(
            profile: RelayV2Profile,
            resume: RelayV2ResumeCursor?,
        ) {
            plans[profile.profileId] = RelayV2ConnectPlan(
                profile.profileId,
                profile.principalId,
                profile.clientInstanceId,
                profile.hostId,
                requestedResume = resume,
                recovery = if (resume == null) {
                    RelayV2ConnectRecovery.EMPTY
                } else {
                    RelayV2ConnectRecovery.LIVE
                },
                durableHostEpoch = resume?.hostEpoch,
                requiredThroughEventSeq = resume?.lastEventSeq,
            )
        }

        fun publish(profile: RelayV2Profile, plan: RelayV2ConnectPlan) {
            plans[profile.profileId] = plan
        }

        override suspend fun load(profile: RelayV2Profile): RelayV2ConnectPlan {
            loadCount.incrementAndGet()
            beforeLoad?.invoke()
            return requireNotNull(plans[profile.profileId])
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
        val sendAttemptCount = AtomicInteger()
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

        @Volatile
        var sendResult: Boolean = true

        @Volatile
        var sendFailure: RuntimeException? = null

        @Volatile
        var beforeSend: ((ByteArray) -> Unit)? = null

        override fun send(bytes: ByteArray): Boolean {
            sendAttemptCount.incrementAndGet()
            if (blockFirstSend && sendCount++ == 0) {
                sendEntered.countDown()
                check(releaseSend.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
            }
            sendFailure?.let { throw it }
            beforeSend?.invoke(bytes)
            sent += bytes.copyOf()
            return sendResult
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

        fun sendCommandStatuses(
            requestId: String,
            commands: List<RelayV2PendingCommand>,
        ) {
            sendFrame(
                linkedMapOf(
                    "protocolVersion" to 2L,
                    "kind" to "response",
                    "type" to "command.statuses",
                    "requestId" to requestId,
                    "hostId" to HOST_ID,
                    "hostEpoch" to HOST_EPOCH,
                    "payload" to linkedMapOf(
                        "dedupeWatermark" to linkedMapOf(
                            "oldestQueryableWindowSeq" to "1",
                            "newestIssuedWindowSeq" to "42",
                            "observedAtMs" to NOW_MS,
                        ),
                        "items" to commands.map { command ->
                            linkedMapOf(
                                "commandId" to command.commandId,
                                "dedupeWindowId" to command.dedupeWindowId,
                                "state" to "accepted",
                                "updatedAtMs" to NOW_MS,
                                "dedupeUntilMs" to null,
                                "retryable" to false,
                                "retryAfterMs" to null,
                                "reissueRequired" to false,
                                "result" to null,
                                "error" to null,
                            )
                        },
                    ),
                ),
            )
        }

        fun sendRaw(bytes: ByteArray) {
            listener.onFrame(this, bytes, RelayV2FrameMetadata())
        }

        fun sendAgentFrame(frame: AgentTranscriptLifecycleV1Frame) {
            sendRaw(agentExtensionCodec.encodePublicFrame(frame))
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

        suspend fun awaitAgentSentFrame(index: Int): AgentTranscriptLifecycleV1Frame =
            withTimeout(TIMEOUT_MS) {
                while (sent.size <= index) delay(1)
                agentExtensionCodec.decodePublicFrame(sent[index])
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

    private fun sessionUpsertFrame(
        eventSeq: String,
        resultingRevision: String,
    ): MutableMap<String, Any?> = fixture("sessions-changed-upsert").apply {
        this["eventSeq"] = eventSeq
        this["scopeId"] = "scope-a"
        payload()["resourceKey"] = "scope-a"
        payload()["resultingRevision"] = resultingRevision
        payload().mutableObject("change").mutableObject("item")["scopeId"] = "scope-a"
    }

    private fun releaseObligation(
        snapshotRequestId: String,
        snapshotId: String,
        reason: RelayV2RecoveryReleaseReason,
        durableCursorEventSeq: String? = null,
    ) = RelayV2RecoveryReleaseDirective.fromDurable(
        profileId = "profile-primary",
        principalId = PRINCIPAL_ID,
        clientInstanceId = "android-install-primary",
        hostId = HOST_ID,
        hostEpoch = HOST_EPOCH,
        snapshotRequestId = snapshotRequestId,
        snapshotId = snapshotId,
        durableCursorEventSeq = durableCursorEventSeq,
        durableReason = if (reason == RelayV2RecoveryReleaseReason.COMPLETED) {
            RelayV2RecoveryDurableReleaseReason.COMPLETED
        } else {
            RelayV2RecoveryDurableReleaseReason.SNAPSHOT_RESTART_REQUIRED
        },
    )

    private fun recoveryAdapter(repository: RelayV2StateSyncRepositoryCore) =
        RelayV2RecoveryRepositoryAdapter(repository)

    private suspend fun prepareReleaseCompletionRace(
        pending: List<RelayV2PendingCommand>,
    ): ReleaseCompletionRace {
        val namespace = RelayV2StateNamespace(
            "profile-primary",
            PRINCIPAL_ID,
            "android-install-primary",
            HOST_ID,
            HOST_EPOCH,
        )
        val store = FakeStateStore()
        val adapter = recoveryAdapter(RelayV2StateSyncRepositoryCore(store))
        val harness = Harness(durableConnectPlanSource = adapter)
        try {
            val hello = harness.connectThroughRelayWelcome(null)
            val transport = harness.transport()
            transport.sendFixture(
                "host-welcome-snapshot-required",
                hello.stringValue("requestId"),
            )
            val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.BeginStateResync
            val helloReceipt = harness.actor.withEffectApplyLease(helloEffect) {
                adapter.applyHello(helloEffect, pending)
            } as RelayV2EffectApplyResult.Applied
            assertTrue(harness.actor.submitRecoveryReceipt(helloReceipt.value))

            val get = transport.awaitSentFrame(1)
            transport.sendFrame(adapterSnapshotChunkFrame(get, "race-91", "91"))
            val chunkEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.ApplyStateSnapshotChunk
            val committed = harness.actor.withEffectApplyLease(chunkEffect) {
                adapter.applySnapshotChunk(chunkEffect, pending)
            } as RelayV2EffectApplyResult.Applied
            assertTrue(harness.actor.submitRecoveryReceipt(committed.value))
            val release = transport.awaitSentFrame(2)

            val released = fixture("state-snapshot-released")
            released["requestId"] = release.stringValue("requestId")
            released.payload()["snapshotRequestId"] =
                release.payload().stringValue("snapshotRequestId")
            released.payload()["snapshotId"] = release.payload().stringValue("snapshotId")
            transport.sendFrame(released)
            val completeEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.CompleteSnapshotRelease
            val oldCompletion = harness.actor.withEffectApplyLease(completeEffect) {
                requireNotNull(adapter.completeRelease(completeEffect))
            } as RelayV2EffectApplyResult.Applied
            assertEquals(
                RelayV2RecoveryRestartDirective.QUERY_PENDING_COMMANDS,
                oldCompletion.value.restart,
            )
            return ReleaseCompletionRace(
                namespace,
                store,
                adapter,
                harness,
                transport,
                get,
                oldCompletion.value,
            )
        } catch (failure: Throwable) {
            harness.close()
            throw failure
        }
    }

    private suspend fun ReleaseCompletionRace.durablyApplyGap(
        eventSeq: String,
        resultingRevision: String,
        pending: List<RelayV2PendingCommand>,
    ): RelayV2RecoveryReceipt.QueryRecoverySuperseded {
        return durablyApplyQueryGap(
            harness,
            transport,
            adapter,
            eventSeq,
            resultingRevision,
            pending,
        ).also {
            assertEquals(oldCompletion.binding, it.completedReleaseBinding)
            assertEquals("91", it.durableCursorEventSeq)
        }
    }

    private suspend fun prepareMatchedQueryRace(
        pending: List<RelayV2PendingCommand>,
    ): MatchedQueryRace {
        val seeded = seedSnapshotState("matched-race", completeRelease = true)
        val adapter = recoveryAdapter(seeded.repository)
        val harness = Harness(durableConnectPlanSource = adapter)
        try {
            val hello = harness.connectThroughRelayWelcome(
                RelayV2ResumeCursor(HOST_EPOCH, "91"),
            )
            val transport = harness.transport()
            transport.sendFixture("host-welcome-caught-up", hello.stringValue("requestId"))
            val helloEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
                as RelayV2RuntimeEffect.QueryPendingCommands
            val applied = harness.actor.withEffectApplyLease(helloEffect) {
                adapter.applyHello(helloEffect, pending)
            } as RelayV2EffectApplyResult.Applied
            return MatchedQueryRace(
                seeded.namespace,
                seeded.store,
                adapter,
                harness,
                transport,
                applied.value as RelayV2RecoveryReceipt.HelloApplied,
            )
        } catch (failure: Throwable) {
            harness.close()
            throw failure
        }
    }

    private suspend fun seedSnapshotState(
        suffix: String,
        completeRelease: Boolean,
    ): SeededSnapshotState {
        val namespace = RelayV2StateNamespace(
            "profile-primary",
            PRINCIPAL_ID,
            "android-install-primary",
            HOST_ID,
            HOST_EPOCH,
        )
        val store = FakeStateStore()
        val repository = RelayV2StateSyncRepositoryCore(store)
        val records = adapterSnapshotRecords(suffix)
        val (bytes, digest) = canonicalSnapshotDigest(records)
        repository.applyHelloForActorTest(
            RelayV2StateHello(
                namespace,
                "91",
                null,
                RelayV2StateHelloDisposition.FRESH,
            ),
        )
        repository.stageSnapshotChunkUnderApplyLease(
            adapterSnapshotChunk(
                namespace,
                suffix,
                "91",
                records,
                bytes,
                digest,
            ),
        )
        val committed = repository.commitSnapshotUnderApplyLease(
            namespace,
            "snapshot-$suffix",
        ) as com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateSyncResult.SnapshotCommitted
        if (completeRelease) {
            requireNotNull(repository.completeSnapshotReleaseUnderApplyLease(committed.release))
        }
        return SeededSnapshotState(namespace, store, repository)
    }

    private suspend fun MatchedQueryRace.durablyApplyGap(
        eventSeq: String,
        resultingRevision: String,
        pending: List<RelayV2PendingCommand>,
    ): RelayV2RecoveryReceipt.QueryRecoverySuperseded = durablyApplyQueryGap(
        harness,
        transport,
        adapter,
        eventSeq,
        resultingRevision,
        pending,
    ).also {
        assertNull(it.completedReleaseBinding)
        assertEquals("91", it.durableCursorEventSeq)
    }

    private suspend fun durablyApplyQueryGap(
        harness: Harness,
        transport: FakeTransport,
        adapter: RelayV2RecoveryRepositoryAdapter,
        eventSeq: String,
        resultingRevision: String,
        pending: List<RelayV2PendingCommand>,
    ): RelayV2RecoveryReceipt.QueryRecoverySuperseded {
        transport.sendFrame(sessionUpsertFrame(eventSeq, resultingRevision))
        val eventEffect = withTimeout(TIMEOUT_MS) { harness.actor.effects.first() }
            as RelayV2RuntimeEffect.DeliverPostHandshakeFrame
        val applied = harness.actor.withEffectApplyLease(eventEffect) {
            requireNotNull(adapter.applyRecoveryStateEvent(eventEffect, pending))
        } as RelayV2EffectApplyResult.Applied
        return (applied.value as RelayV2RecoveryReceipt.QueryRecoverySuperseded).also {
            assertEquals(eventEffect.recovery, it.binding)
            assertEquals(eventEffect.queryLineage, it.queryLineage)
            assertEquals(eventEffect.completedReleaseBinding, it.completedReleaseBinding)
            assertEquals(eventSeq, it.requiredThroughEventSeq)
        }
    }

    private suspend fun RelayV2StateSyncRepositoryCore.applyHelloForActorTest(
        hello: RelayV2StateHello,
    ) = applyHelloUnderApplyLease(
        loadConnectPlan(
            com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateConnectIdentity(
                hello.namespace.profileId,
                hello.namespace.principalId,
                hello.namespace.clientInstanceId,
                hello.namespace.hostId,
            ),
        ),
        hello,
    )

    private fun adapterSession(displayName: String) = RelayV2SessionResource(
        scopeId = "scope-a",
        sessionId = "session-a",
        kind = RelayV2SessionKind.WORKTREE,
        displayName = displayName,
        project = "project",
        label = null,
        cwd = "/repo/$displayName",
        attached = false,
        windowCount = 1,
        createdAtMs = 1,
        activityAtMs = 2,
    )

    private fun adapterSnapshotRecords(displayName: String): List<RelayV2SnapshotRecord> = listOf(
        RelayV2SnapshotRecord.Scope(
            RelayV2ScopeResource(
                "scope-a",
                "Local",
                RelayV2ScopeKind.LOCAL,
                RelayV2ScopeReachability.ONLINE,
            ),
        ),
        RelayV2SnapshotRecord.SessionsScope("scope-a", "1"),
        RelayV2SnapshotRecord.Session("scope-a", adapterSession(displayName)),
    )

    private fun adapterSnapshotChunkFrame(
        request: Map<String, Any?>,
        displayName: String,
        throughEventSeq: String,
    ): MutableMap<String, Any?> {
        val frame = fixture("state-snapshot-chunk")
        val records = adapterSnapshotRecords(displayName)
        val (bytes, digest) = canonicalSnapshotDigest(records)
        @Suppress("UNCHECKED_CAST")
        val requestPayload = request.getValue("payload") as Map<String, Any?>
        frame["requestId"] = request.stringValue("requestId")
        frame.payload().apply {
            this["snapshotRequestId"] = requestPayload.stringValue("snapshotRequestId")
            this["snapshotId"] =
                "snapshot-${requestPayload.stringValue("snapshotRequestId").takeLast(12)}"
            this["snapshotCreatedAtMs"] = 100L
            this["snapshotLeaseExpiresAtMs"] = 200L
            this["snapshotAbsoluteExpiresAtMs"] = 1_000L
            this["throughEventSeq"] = throughEventSeq
            this["scopesRevision"] = "1"
            this["totalRecords"] = records.size.toLong()
            this["totalCanonicalBytes"] = bytes
            this["cutDigest"] = digest
            this["records"] = records.map { it.toWireMapForActorTest() }
        }
        return frame
    }

    private fun RelayV2SnapshotRecord.toWireMapForActorTest(): Map<String, Any?> = when (this) {
        is RelayV2SnapshotRecord.Scope -> linkedMapOf(
            "recordType" to "scope",
            "item" to item.wireMap(),
        )
        is RelayV2SnapshotRecord.SessionsScope -> linkedMapOf(
            "recordType" to "sessions_scope",
            "scopeId" to scopeId,
            "revision" to revision,
            "completeness" to "complete",
        )
        is RelayV2SnapshotRecord.Session -> linkedMapOf(
            "recordType" to "session",
            "scopeId" to scopeId,
            "item" to item.wireMap(),
        )
    }

    private fun adapterSnapshotChunk(
        namespace: RelayV2StateNamespace,
        suffix: String,
        throughEventSeq: String,
        records: List<RelayV2SnapshotRecord>,
        totalCanonicalBytes: Long,
        digest: String,
    ) = RelayV2SnapshotChunk(
        namespace = namespace,
        snapshotRequestId = "request-$suffix",
        snapshotId = "snapshot-$suffix",
        snapshotCreatedAtMs = 100,
        snapshotLeaseExpiresAtMs = 200,
        snapshotAbsoluteExpiresAtMs = 1_000,
        chunkIndex = 0,
        requestedCursor = null,
        isLast = true,
        nextCursor = null,
        throughEventSeq = throughEventSeq,
        scopesRevision = "1",
        totalRecords = records.size.toLong(),
        totalCanonicalBytes = totalCanonicalBytes,
        cutDigest = digest,
        records = records,
        rawUtf8Bytes = records.sumOf { it.canonicalJson().toByteArray().size } + 256,
    )

    private fun snapshotExpiredError(requestId: String): Map<String, Any?> = linkedMapOf(
        "protocolVersion" to 2L,
        "kind" to "response",
        "type" to "error",
        "requestId" to requestId,
        "hostId" to HOST_ID,
        "hostEpoch" to HOST_EPOCH,
        "payload" to null,
        "error" to linkedMapOf(
            "code" to "SNAPSHOT_EXPIRED",
            "message" to "Pinned cut expired",
            "retryable" to false,
            "commandDisposition" to "not_applicable",
        ),
    )

    private fun RelayV2RuntimeEffect.helloOutcome(): RelayV2HelloOutcome = when (this) {
        is RelayV2RuntimeEffect.QueryPendingCommands -> outcome
        is RelayV2RuntimeEffect.BeginStateResync -> outcome
        is RelayV2RuntimeEffect.RejectContinuity -> outcome
        else -> error("Effect is not a hello outcome: $this")
    }

    private suspend fun RelayV2ConnectionActor.commitRecoveryReceipt(
        effect: RelayV2RuntimeEffect.GenerationScoped,
        receipt: RelayV2RecoveryReceipt,
    ): Boolean = when (val applied = withEffectApplyLease(effect) { receipt }) {
        is RelayV2EffectApplyResult.Applied -> submitRecoveryReceipt(applied.value)
        RelayV2EffectApplyResult.Stale -> false
    }

    private suspend fun RelayV2ConnectionActor.processCommittedRecoveryReceipt(
        effect: RelayV2RuntimeEffect.GenerationScoped,
        receipt: RelayV2RecoveryReceipt,
    ): RelayV2RecoveryReceiptProcessingResult =
        when (val applied = withEffectApplyLease(effect) { receipt }) {
            is RelayV2EffectApplyResult.Applied -> processRecoveryReceipt(applied.value)
            RelayV2EffectApplyResult.Stale ->
                RelayV2RecoveryReceiptProcessingResult.StaleOrTerminal
        }

    private suspend fun Harness.awaitCommandQueryRegistration() =
        withTimeout(TIMEOUT_MS) {
            actor.effects.first { it is RelayV2RuntimeEffect.RegisterCommandQueryAttempt }
        } as RelayV2RuntimeEffect.RegisterCommandQueryAttempt

    private suspend fun Harness.commitCommandQueryRegistration(
        effect: RelayV2RuntimeEffect.RegisterCommandQueryAttempt? = null,
    ): Boolean {
        val registration = effect ?: awaitCommandQueryRegistration()
        return actor.submitRecoveryReceipt(issueCommandQueryReceipt(registration))
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

    private data class ReleaseCompletionRace(
        val namespace: RelayV2StateNamespace,
        val store: FakeStateStore,
        val adapter: RelayV2RecoveryRepositoryAdapter,
        val harness: Harness,
        val transport: FakeTransport,
        val originalGet: Map<String, Any?>,
        val oldCompletion: RelayV2RecoveryReceipt.SnapshotReleaseCompleted,
    )

    private data class MatchedQueryRace(
        val namespace: RelayV2StateNamespace,
        val store: FakeStateStore,
        val adapter: RelayV2RecoveryRepositoryAdapter,
        val harness: Harness,
        val transport: FakeTransport,
        val helloReceipt: RelayV2RecoveryReceipt.HelloApplied,
    )

    private data class SeededSnapshotState(
        val namespace: RelayV2StateNamespace,
        val store: FakeStateStore,
        val repository: RelayV2StateSyncRepositoryCore,
    )

    private enum class ActionOrder {
        SUPERSEDE_FIRST,
        COMPLETION_FIRST,
    }

    private enum class MatchedGapTiming {
        BEFORE_HELLO_RECEIPT,
        DURING_COMMAND_RECEIPT,
    }

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

@Suppress("UNCHECKED_CAST")
private fun Map<String, Any?>.objectValue(name: String): Map<String, Any?> =
    getValue(name) as Map<String, Any?>

private fun Map<String, Any?>.stringList(name: String): List<String> =
    (getValue(name) as List<*>).map { it as String }

@Suppress("UNCHECKED_CAST")
private fun Map<String, Any?>.commandItems(): List<RelayV2PendingCommand> =
    (getValue("items") as List<Map<String, Any?>>).map { item ->
        RelayV2PendingCommand(
            commandId = item.getValue("commandId") as String,
            dedupeWindowId = item.getValue("dedupeWindowId") as String,
        )
    }
