package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentClientDisposition
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentLocalRequestFence
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptDurableStorageAccounting
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleClientReduction
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleClientState
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleCompletedBatchHandoffReceipt
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleCompletedHandoffReceipt
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleDurableConsumerIdentity
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleDurableLiveEventCommand
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleDurableNamespace
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleDurableOperationResult
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleDurableOperationFence
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleDurablePreparedRequest
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleDurableRecord
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleDurableHandoffPort
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleExactRedriveReplacement
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleExtensionRequestSender
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleExtensionState
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecyclePersistedRequestRecoveryResult
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRecoveryCatalogAuthority
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRecoveryCatalogCursor
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRecoveryCatalogPort
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRecoveryNamespacePage
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRequestAdmission
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRuntimeComposition
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRuntimeCompositionResult
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRuntimeConsumeResult
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRuntimeDurableRepository
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRuntimeHandlePort
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRuntimeUnavailableReason
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleSelectedSessionPresentationState
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleTrustedIngress
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2ContractFixtures
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2FrameMetadata
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2WebSocketChannel
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAcceptanceEvidence
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAction
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxArguments
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2CommandDisposition
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2CommandStatusEvidence
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2CommandStatusSource
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2CommandStatusState
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAuthorityCore
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxDraft
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEffect
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxLimits
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAttemptKind
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxRecovery
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
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2MaterializedSessionReadAuthority
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2MaterializedSessionReadCut
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxAuthorityNamespace
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxBatchResult
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxEnqueueAuthority
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxEnqueueFailure
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxEnqueueReceipt
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxEnqueueResult
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxFreshDispatchResult
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxRuntimeAuthority
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ResyncReason
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeKind
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeReachability
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeResource
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SessionKind
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SessionResource
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
import java.lang.reflect.Proxy
import java.nio.charset.StandardCharsets
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
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
    fun `exact current generation delegates Agent effect without degrading base`() = runBlocking {
        val agent = SeededAgentDurableRepository()
        val harness = Harness(
            autoConnect = true,
            agentDurableRepository = agent.repository,
        )
        try {
            harness.connectOnline()
            val effect = harness.agentEffect()

            val result = harness.composition.consume(effect)

            val consumed = result as AgentTranscriptLifecycleRuntimeCompositionResult.Consumed
            assertTrue(consumed.consumption is AgentTranscriptLifecycleRuntimeConsumeResult.Applied)
            assertEquals(agent.namespace, agent.record().namespace)
            assertEquals("12", agent.record().state.extensionLane.lastAgentSeq)
            assertEquals(1, agent.mutationCommits.get())
            assertEquals(RelayV2BaseRuntimePhase.ONLINE, harness.composition.state.value.phase)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `empty negotiated capabilities keep dormant Agent consumer inert`() = runBlocking {
        val agent = SeededAgentDurableRepository()
        val harness = Harness(
            autoConnect = true,
            agentDurableRepository = agent.repository,
        )
        try {
            val hello = harness.connectOnline()
            val result = harness.composition.consume(
                harness.agentEffect(negotiatedCapabilities = emptySet()),
            )

            assertEquals(
                RelayV2ConnectionActor.REQUIRED_CAPABILITIES,
                hello.payload().stringList("capabilities"),
            )
            assertFalse(
                AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY in
                    hello.payload().stringList("capabilities"),
            )
            assertEquals(
                AgentTranscriptLifecycleRuntimeCompositionResult.ExtensionNotNegotiated,
                result,
            )
            assertEquals(0, agent.loadCalls.get())
            assertEquals(0, agent.mutationCommits.get())
            assertEquals("11", agent.record().state.extensionLane.lastAgentSeq)
            assertEquals(1, harness.transport().sendCount())
            assertEquals(RelayV2BaseRuntimePhase.ONLINE, harness.composition.state.value.phase)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `selected Session read is unavailable before any Room read without capability`() =
        runBlocking {
            val agent = SeededAgentDurableRepository()
            val harness = Harness(
                autoConnect = true,
                agentDurableRepository = agent.repository,
            )
            try {
                harness.connectOnline()
                val product = withTimeout(TIMEOUT_MS) {
                    harness.composition.sessions.first { it.isNotEmpty() }.single()
                }

                assertEquals(
                    AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable,
                    harness.composition.readSelectedSession(product.replyCut),
                )
                assertEquals(0, harness.authority.materializedSessionCutReads.get())
                assertEquals(0, agent.loadCalls.get())
                assertEquals(0, agent.mutationCommits.get())
                assertEquals(1, harness.transport().sendCount())
            } finally {
                harness.close()
            }
        }

    @Test
    fun `foreign and disconnected selected Session cuts close unavailable`() = runBlocking {
        val ownerAgent = SeededAgentDurableRepository()
        val foreignAgent = SeededAgentDurableRepository()
        val owner = Harness(
            autoConnect = true,
            agentDurableRepository = ownerAgent.repository,
        )
        val foreign = Harness(
            autoConnect = true,
            agentDurableRepository = foreignAgent.repository,
        )
        try {
            owner.connectOnline()
            foreign.connectOnline()
            val ownerCut = withTimeout(TIMEOUT_MS) {
                owner.composition.sessions.first { it.isNotEmpty() }.single().replyCut
            }
            val foreignCut = withTimeout(TIMEOUT_MS) {
                foreign.composition.sessions.first { it.isNotEmpty() }.single().replyCut
            }

            assertEquals(
                AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable,
                owner.composition.readSelectedSession(foreignCut),
            )
            owner.composition.disconnectAndDrain(
                owner.profile.identity,
                "selected-session-disconnect",
            )
            assertEquals(
                AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable,
                owner.composition.readSelectedSession(ownerCut),
            )
            assertTrue(owner.composition.sessions.value.isEmpty())
            assertEquals(0, owner.authority.materializedSessionCutReads.get())
            assertEquals(0, ownerAgent.loadCalls.get())
        } finally {
            owner.close()
            foreign.close()
        }
    }

    @Test
    fun `selected Session replies isolate bounded rows omit reissued parent and fence revision`() =
        runBlocking {
            val readGate = BlockingOutboxReadGate(blockAtRead = 4)
            val harness = Harness(
                autoConnect = true,
                newCommandId = { "revision-reply" },
                beforeOutboxRead = readGate::intercept,
            )
            try {
                harness.connectOnline()
                val product = withTimeout(TIMEOUT_MS) {
                    harness.composition.sessions.first { it.isNotEmpty() }.single()
                }
                harness.authority.replaceOutbox(selectedSessionReplyOutbox())

                val bounded = harness.composition.readSelectedSessionReplies(
                    product.replyCut,
                    expectedRevision = 0L,
                ) as SelectedSessionReplyReadState.Content

                assertEquals(0L, bounded.revision)
                assertEquals(256, bounded.rows.size)
                assertEquals(
                    (4 until 260).map { "exact-${it.toString().padStart(3, '0')}" },
                    bounded.rows.map { it.commandId },
                )
                assertEquals(
                    bounded.rows.map { it.commandId.removePrefix("exact-").toLong() },
                    bounded.rows.map { it.createdAtMillis },
                )
                assertTrue(bounded.rows.all { it.state == RelayV2OutboxStateTag.QUEUED })
                assertTrue(bounded.rows.all { it.message == "message-${it.commandId}" })

                harness.authority.replaceOutbox(reissuedSelectedSessionReplyOutbox())
                val reissued = harness.composition.readSelectedSessionReplies(
                    product.replyCut,
                    expectedRevision = 0L,
                ) as SelectedSessionReplyReadState.Content

                assertEquals(listOf("replacement-command"), reissued.rows.map { it.commandId })
                assertEquals(listOf("replacement body"), reissued.rows.map { it.message })
                assertEquals(listOf(RelayV2OutboxStateTag.QUEUED), reissued.rows.map { it.state })

                harness.authority.replaceOutbox(RelayV2OutboxState.empty())
                assertEquals(0L, harness.composition.outboxTimelineRevision.value)
                val staleRead = async(Dispatchers.Default) {
                    harness.composition.readSelectedSessionReplies(
                        product.replyCut,
                        expectedRevision = 0L,
                    )
                }
                withTimeout(TIMEOUT_MS) { readGate.entered.await() }

                assertTrue(
                    harness.composition.submitReply(product.replyCut, "revision body") is
                        RelayV2SessionReplyResult.Committed,
                )
                assertEquals(2L, harness.composition.outboxTimelineRevision.value)
                readGate.release.complete(Unit)

                assertEquals(
                    SelectedSessionReplyReadState.Stale,
                    withTimeout(TIMEOUT_MS) { staleRead.await() },
                )
                val current = harness.composition.readSelectedSessionReplies(
                    product.replyCut,
                    expectedRevision = 2L,
                ) as SelectedSessionReplyReadState.Content
                assertEquals(listOf("revision-reply"), current.rows.map { it.commandId })
                assertEquals(listOf(RelayV2OutboxStateTag.SENDING), current.rows.map { it.state })
            } finally {
                readGate.release.complete(Unit)
                harness.close()
            }
        }

    @Test
    fun `stale generation and disconnect barrier reject late Agent mutation`() = runBlocking {
        data class Case(
            val name: String,
            val connectionGeneration: Long,
            val disconnectBeforeLease: Boolean,
        )

        for (case in listOf(
            Case("stale generation", 2, false),
            Case("disconnect late callback", 1, true),
        )) {
            val agent = SeededAgentDurableRepository(
                blockLoad = case.disconnectBeforeLease,
            )
            val harness = Harness(
                autoConnect = true,
                agentDurableRepository = agent.repository,
            )
            try {
                harness.connectOnline()
                val pending = async(Dispatchers.Default) {
                    harness.composition.consume(
                        harness.agentEffect(
                            connectionGeneration = case.connectionGeneration,
                        ),
                    )
                }
                if (case.disconnectBeforeLease) {
                    assertTrue(case.name, agent.awaitLoad())
                    harness.composition.disconnectAndDrain(
                        harness.profile.identity,
                        "agent-disconnect-barrier",
                    )
                    agent.releaseLoad()
                }

                val result = pending.await()
                    as AgentTranscriptLifecycleRuntimeCompositionResult.Consumed
                assertEquals(
                    case.name,
                    AgentTranscriptLifecycleRuntimeConsumeResult.Unavailable(
                        AgentTranscriptLifecycleRuntimeUnavailableReason.STALE_GENERATION,
                    ),
                    result.consumption,
                )
                assertEquals(case.name, 0, agent.mutationCommits.get())
                assertEquals(case.name, "11", agent.record().state.extensionLane.lastAgentSeq)
                assertEquals(
                    case.name,
                    if (case.disconnectBeforeLease) {
                        RelayV2BaseRuntimePhase.STOPPED
                    } else {
                        RelayV2BaseRuntimePhase.ONLINE
                    },
                    harness.composition.state.value.phase,
                )
            } finally {
                agent.releaseLoad()
                harness.close()
            }
        }
    }

    @Test
    fun `Agent fault stays extension scoped while base state sync continues`() =
        runBlocking {
            val harness = Harness(
                autoConnect = true,
                agentRuntimeFactory = {
                    AgentTranscriptLifecycleRuntimeHandlePort {
                        error("injected Agent extension fault")
                    }
                },
            )
            try {
                harness.connectOnline()
                assertEquals(
                    AgentTranscriptLifecycleRuntimeCompositionResult.RuntimeFault,
                    harness.composition.consume(harness.agentEffect()),
                )
                assertEquals(RelayV2BaseRuntimePhase.ONLINE, harness.composition.state.value.phase)

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
    fun `exact OnlineReady hands off bounded Agent recovery after Outbox and fences every generation`() =
        runBlocking {
            data class ReadyPath(
                val name: String,
                val outbox: RelayV2OutboxState,
                val expectedCommands: List<String>,
                val recovered: Boolean,
            )

            val paths = listOf(
                ReadyPath("direct ready", queuedOutbox("fresh"), listOf("fresh"), false),
                ReadyPath(
                    "query ready",
                    recoveredAndFreshOutbox(),
                    listOf("recovered", "fresh"),
                    true,
                ),
            )
            paths.forEachIndexed { index, path ->
                val probe = PostReadyRecoveryProbe()
                val harness = Harness(
                    autoConnect = true,
                    outbox = path.outbox,
                    agentRuntimeFactory = { probe.runtime },
                )
                try {
                    if (path.recovered) {
                        val query = harness.connectToCommandQuery()
                        assertEquals(
                            "${path.name} before OnlineReady",
                            null,
                            withTimeoutOrNull(100) { probe.started.await() },
                        )
                        harness.transport().sendCommandStatuses(query, StatusMode.RETRY_IMMEDIATE)
                    } else {
                        harness.connectOnline()
                    }
                    withTimeout(TIMEOUT_MS) { probe.started.await() }

                    assertEquals(
                        path.name,
                        path.expectedCommands,
                        harness.transport().framesOfType("command.execute")
                            .map { it.stringValue("commandId") },
                    )
                    assertEquals(
                        path.name,
                        RelayV2BaseRuntimePhase.ONLINE,
                        harness.composition.state.value.phase,
                    )
                    assertEquals(path.name, 1, probe.authorities.size)
                    assertEquals(path.name, 1L, probe.authorities.single().generation.connectionGeneration)
                    assertEquals(
                        path.name,
                        null,
                        withTimeoutOrNull(100) { probe.finished.await() },
                    )

                    if (index == 0) {
                        harness.composition.consume(harness.staleHello(connectionGeneration = 77))
                        assertEquals("stale Hello", 1, probe.authorities.size)
                        assertEquals(
                            "stale Hello",
                            null,
                            withTimeoutOrNull(100) { probe.finished.await() },
                        )
                    }
                } finally {
                    probe.release.complete(Unit)
                    withTimeout(TIMEOUT_MS) { probe.finished.await() }
                    harness.close()
                }
            }

            val lateAppliedGate = BeforeHelloAdmissionGate()
            val lateAppliedProbe = PostReadyRecoveryProbe()
            val lateAppliedHarness = Harness(
                autoConnect = true,
                beforeHelloOutboxAdmissionRead = lateAppliedGate::awaitRelease,
                agentRuntimeFactory = { lateAppliedProbe.runtime },
            )
            try {
                lateAppliedHarness.openThroughHostWelcome()
                withTimeout(TIMEOUT_MS) { lateAppliedGate.entered.await() }
                val disconnect = async {
                    lateAppliedHarness.composition.disconnectAndDrain(
                        lateAppliedHarness.profile.identity,
                        "post-fence-applied-hello",
                    )
                }
                assertEquals(null, withTimeoutOrNull(100) { disconnect.await() })

                // The admitted Hello completes after disconnect took its recovery-job snapshot.
                // Its Applied branch must observe the permanent admission fence, so the later
                // OnlineReady/StaleOrTerminal processing cannot create an unjoined recovery job.
                lateAppliedGate.release.complete(Unit)
                assertEquals(
                    "post-fence-applied-hello",
                    withTimeout(TIMEOUT_MS) { disconnect.await() }.barrierId,
                )
                assertTrue(lateAppliedProbe.authorities.isEmpty())
                assertEquals(
                    null,
                    withTimeoutOrNull(100) { lateAppliedProbe.started.await() },
                )
                assertEquals(
                    RelayV2BaseRuntimePhase.STOPPED,
                    lateAppliedHarness.composition.state.value.phase,
                )
            } finally {
                lateAppliedGate.release.complete(Unit)
                lateAppliedProbe.release.complete(Unit)
                lateAppliedHarness.close()
            }

            val paging = PersistedRecoveryPagingFixture(candidateCount = 66, capacity = 64)
            assertEquals(
                AgentTranscriptLifecyclePersistedRequestRecoveryResult
                    .SynchronousAdmissionRejected,
                paging.runtime.recoverPersistedRequestsAfterOnlineReady(
                    paging.authority,
                    paging.readAuthority,
                ),
            )
            assertEquals(listOf(32, 32, 32), paging.requestedLimits)
            assertEquals(3, paging.catalogAuthorities.size)
            assertTrue(paging.catalogAuthorities.all { it == paging.catalogAuthority })
            assertEquals(3, paging.readCuts.get())
            assertEquals(3, paging.readLeases.get())
            assertEquals(65, paging.preparedReads.get())
            assertEquals(65, paging.sendAttempts.get())
            assertEquals(64, paging.admissions.get())

            val fault = PostReadyRecoveryProbe(
                failure = IllegalStateException("namespace recovery fault"),
            )
            val faultHarness = Harness(
                autoConnect = true,
                outbox = queuedOutbox("base-command"),
                agentRuntimeFactory = { fault.runtime },
            )
            try {
                faultHarness.connectOnline()
                withTimeout(TIMEOUT_MS) { fault.finished.await() }
                assertEquals(
                    listOf("base-command"),
                    faultHarness.transport().framesOfType("command.execute")
                        .map { it.stringValue("commandId") },
                )
                faultHarness.transport().sendFixture("sessions-changed-upsert")
                withTimeout(TIMEOUT_MS) {
                    while (faultHarness.authority.stateEventCommits.get() != 1) delay(1)
                }
                assertEquals(
                    RelayV2BaseRuntimePhase.ONLINE,
                    faultHarness.composition.state.value.phase,
                )
            } finally {
                fault.release.complete(Unit)
                faultHarness.close()
            }

            val retry = ControlledRetryDelay()
            val generations = MultiGenerationRecoveryProbe(3)
            val generationHarness = Harness(
                autoConnect = true,
                retryDelayBlock = retry::awaitDelay,
                agentRuntimeFactory = { generations.runtime },
            )
            try {
                generationHarness.connectOnline(0)
                generations.awaitStarted(1)
                generationHarness.authority.replaceOutbox(
                    sendingOutbox("generation-2-pending"),
                )
                generationHarness.transport(0).fail(
                    RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK),
                )
                assertTrue(retry.awaitCount(1))
                retry.release(0)

                val generation2 = generationHarness.openThroughHostWelcome(1)
                val generation2Query = generation2.awaitSentType("command.query")
                generations.awaitCancelled(1)
                assertEquals(
                    "Applied QueryPendingCommands must not start recovery before OnlineReady",
                    1,
                    generations.authorities.size,
                )
                assertEquals(
                    RelayV2BaseRuntimePhase.CONNECTING,
                    generationHarness.composition.state.value.phase,
                )
                generation2.sendCommandStatuses(
                    generation2Query,
                    StatusMode.RETRY_IMMEDIATE,
                )
                generations.awaitStarted(2)
                generationHarness.authority.replaceOutbox(RelayV2OutboxState.empty())
                generationHarness.transport(1).fail(
                    RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK),
                )
                assertTrue(retry.awaitCount(2))
                retry.release(1)

                generationHarness.connectOnline(2)
                generations.awaitStarted(3)
                assertEquals(
                    listOf(1L, 2L, 3L),
                    generations.authorities.map { it.generation.connectionGeneration },
                )

                val disconnect = async {
                    generationHarness.composition.disconnectAndDrain(
                        generationHarness.profile.identity,
                        "three-generation-agent-barrier",
                    )
                }
                assertEquals(null, withTimeoutOrNull(100) { disconnect.await() })
                generations.release(0)
                generations.release(1)
                assertEquals(null, withTimeoutOrNull(100) { disconnect.await() })
                generations.release(2)
                assertEquals(
                    "three-generation-agent-barrier",
                    withTimeout(TIMEOUT_MS) { disconnect.await() }.barrierId,
                )
                assertEquals(3, generations.exits.get())
                assertEquals(
                    RelayV2BaseRuntimePhase.STOPPED,
                    generationHarness.composition.state.value.phase,
                )
            } finally {
                generations.releaseAll()
                generationHarness.close()
            }
        }

    @Test
    fun `auto-connect false remains stopped without opening a socket`() = runBlocking {
        val retry = ControlledRetryDelay()
        val harness = Harness(autoConnect = false, retryDelayBlock = retry::awaitDelay)
        try {
            assertEquals(
                null,
                withTimeoutOrNull(200) {
                    while (harness.factory.requests.isEmpty()) delay(1)
                    harness.factory.requests.single()
                },
            )
            assertEquals(0, harness.authority.outboxReads.get())
            assertTrue(retry.delays.isEmpty())
            assertEquals(RelayV2BaseRuntimePhase.STOPPED, harness.composition.state.value.phase)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `an unowned effect still fails closed without retry`() = runBlocking {
        val retry = ControlledRetryDelay()
        val unowned = Harness(autoConnect = true, retryDelayBlock = retry::awaitDelay)
        try {
            unowned.connectOnline()
            unowned.transport().sendFixture("host-presence-online")
            val failed = unowned.awaitPhase(RelayV2BaseRuntimePhase.FAILED)
            assertEquals(
                RelayV2BaseRuntimeFailure.RuntimeIncomplete("UNOWNED_EFFECT_host.presence"),
                failed.failure,
            )
            assertFalse(retry.awaitCount(1, 200))
            assertEquals(1, unowned.factory.requests.size)
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
            assertEquals(1L, harness.composition.outboxTimelineRevision.value)
            assertEquals(1, transport.framesOfType("command.query").size)
            assertEquals(
                listOf("command-b", "command-a"),
                query.payload().objectList("items").map { it.stringValue("commandId") },
            )
            transport.sendCommandStatuses(query, StatusMode.ACCEPTED)

            harness.awaitPhase(RelayV2BaseRuntimePhase.ONLINE)
            assertEquals(1, harness.authority.statusCommits.get())
            assertEquals(2L, harness.composition.outboxTimelineRevision.value)
            transport.sendCommandResult("command-b")
            withTimeout(TIMEOUT_MS) {
                while (harness.authority.statusCommits.get() != 2) delay(1)
            }
            withTimeout(TIMEOUT_MS) {
                while (harness.composition.outboxTimelineRevision.value != 3L) delay(1)
            }
            assertEquals(3L, harness.composition.outboxTimelineRevision.value)
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
                assertEquals(1L, harness.composition.outboxTimelineRevision.value)
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
    fun `online Session reply commits fixed command once before fresh dispatch`() = runBlocking {
        val harness = Harness(autoConnect = true, newCommandId = { "reply-command" })
        try {
            harness.connectOnline()
            val product = withTimeout(TIMEOUT_MS) {
                harness.composition.sessions.first { it.size == 1 }.single()
            }

            val result = harness.composition.submitReply(product.replyCut, "hello\r\nagent")

            assertTrue(result is RelayV2SessionReplyResult.Committed)
            val entry = harness.authority.outboxState().entries.single()
            assertEquals("reply-command", entry.commandId)
            assertEquals("scope-a", entry.scopeId)
            assertEquals("session-a", entry.sessionId)
            assertEquals(HOST_EPOCH, entry.expectedHostEpoch)
            assertEquals("dedupe-window-uuid", entry.dedupeWindowId)
            assertEquals(RelayV2OutboxStateTag.SENDING, entry.state)
            val arguments = entry.canonicalRequestArguments.value
                as RelayV2OutboxArguments.SendAgentMessage
            assertEquals(0, arguments.pane)
            assertTrue(arguments.submit)
            assertEquals("hello\nagent", arguments.message)
            val execute = harness.transport().awaitSentType("command.execute")
            assertEquals("reply-command", execute.stringValue("commandId"))
            assertEquals(1, harness.authority.enqueueCommits.get())
            assertEquals(2L, harness.composition.outboxTimelineRevision.value)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `disconnect withdraws reply admission and waits an entered enqueue transaction`() =
        runBlocking {
            val harness = Harness(autoConnect = true, newCommandId = { "reply-race" })
            try {
                harness.connectOnline()
                val product = withTimeout(TIMEOUT_MS) {
                    harness.composition.sessions.first { it.size == 1 }.single()
                }
                harness.authority.blockReplyEnqueue = true
                val reply = async {
                    harness.composition.submitReply(product.replyCut, "held reply")
                }
                withTimeout(TIMEOUT_MS) { harness.authority.enqueueEntered.await() }

                val disconnect = async {
                    harness.composition.disconnectAndDrain(
                        harness.profile.identity,
                        "reply-profile-switch",
                    )
                }
                assertEquals(null, withTimeoutOrNull(200) { disconnect.await() })

                harness.authority.releaseEnqueue.complete(Unit)
                assertTrue(
                    withTimeout(TIMEOUT_MS) { reply.await() } is
                        RelayV2SessionReplyResult.Committed,
                )
                assertEquals(
                    "reply-profile-switch",
                    withTimeout(TIMEOUT_MS) { disconnect.await() }.barrierId,
                )
                assertEquals(
                    RelayV2OutboxStateTag.QUEUED,
                    harness.authority.outboxState().entries.single().state,
                )
                assertTrue(harness.transport().framesOfType("command.execute").isEmpty())
                assertTrue(harness.composition.sessions.value.isEmpty())
            } finally {
                harness.authority.releaseEnqueue.complete(Unit)
                harness.close()
            }
        }

    @Test
    fun `disconnect barrier prevents a late Session projection from reviving`() = runBlocking {
        val projectionGate = BeforeHelloAdmissionGate()
        val harness = Harness(
            autoConnect = true,
            beforeSessionProjectionPublish = projectionGate::awaitRelease,
        )
        try {
            harness.connectOnline()
            withTimeout(TIMEOUT_MS) { projectionGate.entered.await() }

            val disconnect = async {
                harness.composition.disconnectAndDrain(
                    harness.profile.identity,
                    "projection-disconnect",
                )
            }
            assertEquals(null, withTimeoutOrNull(200) { disconnect.await() })

            projectionGate.release.complete(Unit)
            assertEquals(
                "projection-disconnect",
                withTimeout(TIMEOUT_MS) { disconnect.await() }.barrierId,
            )
            assertTrue(harness.composition.sessions.value.isEmpty())
        } finally {
            projectionGate.release.complete(Unit)
            harness.close()
        }
    }

    @Test
    fun `resync snapshot mutation waits for an entered reply enqueue commit`() = runBlocking {
        val resyncGate = BeforeHelloAdmissionGate()
        val harness = Harness(
            autoConnect = true,
            newCommandId = { "reply-before-resync" },
            beforeOnlineResyncReceiptSubmit = resyncGate::awaitRelease,
        )
        try {
            harness.connectOnline()
            val product = withTimeout(TIMEOUT_MS) {
                harness.composition.sessions.first { it.size == 1 }.single()
            }
            harness.authority.forceNextEventGap = true
            harness.transport().sendFixture("sessions-changed-upsert")
            withTimeout(TIMEOUT_MS) { resyncGate.entered.await() }

            harness.authority.blockReplyEnqueue = true
            val reply = async {
                harness.composition.submitReply(product.replyCut, "commit before snapshot")
            }
            withTimeout(TIMEOUT_MS) { harness.authority.enqueueEntered.await() }

            resyncGate.release.complete(Unit)
            val snapshot = harness.transport().awaitSentType("state.snapshot.get")
            val chunk = fixture("state-snapshot-chunk")
            chunk["requestId"] = snapshot.stringValue("requestId")
            chunk.payload()["snapshotRequestId"] =
                snapshot.payload().stringValue("snapshotRequestId")
            harness.transport().sendFrame(chunk)
            assertEquals(
                null,
                withTimeoutOrNull(200) { harness.authority.snapshotApplyEntered.await() },
            )

            harness.authority.releaseEnqueue.complete(Unit)
            assertTrue(
                withTimeout(TIMEOUT_MS) { reply.await() } is RelayV2SessionReplyResult.Committed,
            )
            withTimeout(TIMEOUT_MS) { harness.authority.snapshotApplyEntered.await() }
            assertEquals(1, harness.authority.enqueueCommits.get())
            assertEquals(1, harness.authority.snapshotCommits.get())
        } finally {
            resyncGate.release.complete(Unit)
            harness.authority.releaseEnqueue.complete(Unit)
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
    fun `retry backoff resets only after exact online and never changes dialect`() = runBlocking {
        val retry = ControlledRetryDelay()
        val harness = Harness(autoConnect = true, retryDelayBlock = retry::awaitDelay)
        try {
            val first = harness.awaitTransport(0)
            first.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            first.fail(RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK))
            assertTrue(retry.awaitCount(1))
            delay(50)
            assertEquals(
                RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.CONNECTING),
                harness.composition.state.value,
            )
            assertEquals(listOf(1_000L), retry.delays)
            assertEquals(1, harness.factory.requests.size)

            retry.release(0)
            val second = harness.awaitTransport(1)
            second.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            second.fail(RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK))
            assertTrue(retry.awaitCount(2))
            delay(50)
            assertEquals(
                RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.CONNECTING),
                harness.composition.state.value,
            )
            assertEquals(listOf(1_000L, 2_000L), retry.delays)

            retry.release(1)
            val hello = harness.connectOnline(2)
            val capabilities = hello.payload().stringList("capabilities")
            assertFalse(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY in capabilities)
            assertEquals(RelayV2ConnectionActor.REQUIRED_CAPABILITIES, capabilities)

            harness.transport(2).fail(
                RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK),
            )
            assertTrue(retry.awaitCount(3))
            assertEquals(listOf(1_000L, 2_000L, 1_000L), retry.delays)
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
    fun `non-retryable connection failure never schedules a successor`() = runBlocking {
        val retry = ControlledRetryDelay()
        val harness = Harness(autoConnect = true, retryDelayBlock = retry::awaitDelay)
        try {
            harness.awaitTransport(0).fail(
                RelayV2TransportFailure(RelayV2TransportFailureKind.TLS_VALIDATION),
            )
            val failed = harness.awaitPhase(RelayV2BaseRuntimePhase.FAILED)
            val cause = failed.failure as RelayV2BaseRuntimeFailure.Connection
            assertFalse(cause.failure.retryable)
            assertFalse(retry.awaitCount(1, 200))
            assertEquals(failed, harness.composition.state.value)
            assertEquals(1, harness.factory.requests.size)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `close during retry delay fences the pending successor`() = runBlocking {
        val retry = ControlledRetryDelay()
        val harness = Harness(autoConnect = true, retryDelayBlock = retry::awaitDelay)
        try {
            harness.awaitTransport(0).fail(
                RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK),
            )
            assertTrue(retry.awaitCount(1))
            harness.composition.close()
            retry.release(0)
            delay(100)
            assertEquals(1, harness.factory.requests.size)
            assertEquals(RelayV2BaseRuntimePhase.STOPPED, harness.composition.state.value.phase)
        } finally {
            harness.close()
        }
    }

    @Test
    fun `disconnect racing retry ownership cannot terminalize the barrier`() = runBlocking {
        val retry = ControlledRetryDelay()
        val retryClaim = RetryScheduleClaimGate()
        val harness = Harness(
            autoConnect = true,
            retryDelayBlock = retry::awaitDelay,
            afterRetryableFailureAdmissionDetached = retryClaim::awaitRelease,
        )
        try {
            harness.connectOnline()
            harness.transport().fail(
                RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK),
            )
            assertTrue(retryClaim.entered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))

            val disconnectThread = AtomicReference<Thread>()
            val disconnect = async(Dispatchers.Default) {
                disconnectThread.set(Thread.currentThread())
                harness.composition.disconnectAndDrain(
                    harness.profile.identity,
                    "profile-switch-during-retry-claim",
                )
            }
            withTimeout(TIMEOUT_MS) {
                while (disconnectThread.get()?.state != Thread.State.BLOCKED) delay(1)
            }

            retryClaim.release.countDown()
            assertEquals(
                "profile-switch-during-retry-claim",
                withTimeout(TIMEOUT_MS) { disconnect.await() }.barrierId,
            )
            withTimeout(TIMEOUT_MS) {
                harness.composition.state.first {
                    it == RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.STOPPED)
                }
            }
            delay(50)

            assertEquals(
                RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.STOPPED),
                harness.composition.state.value,
            )
            assertEquals(1, harness.factory.requests.size)
        } finally {
            retryClaim.release.countDown()
            harness.close()
        }
    }

    @Test
    fun `disconnect joins initial and retry snapshot reads before returning its barrier`() =
        runBlocking {
            val initialRead = BlockingFailingOutboxRead(blockAtRead = 1)
            val initialHarness = Harness(
                autoConnect = true,
                beforeOutboxRead = initialRead::intercept,
            )
            try {
                withTimeout(TIMEOUT_MS) { initialRead.entered.await() }
                val disconnect = async {
                    initialHarness.composition.disconnectAndDrain(
                        initialHarness.profile.identity,
                        "initial-read-profile-switch",
                    )
                }
                assertEquals(null, withTimeoutOrNull(200) { disconnect.await() })

                initialRead.release.complete(Unit)
                assertEquals(
                    "initial-read-profile-switch",
                    withTimeout(TIMEOUT_MS) { disconnect.await() }.barrierId,
                )
                delay(50)
                assertEquals(
                    RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.STOPPED),
                    initialHarness.composition.state.value,
                )
                assertTrue(initialHarness.factory.requests.isEmpty())
            } finally {
                initialRead.release.complete(Unit)
                initialHarness.close()
            }

            val retry = ControlledRetryDelay()
            val retryRead = BlockingFailingOutboxRead(blockAtRead = 2)
            val retryHarness = Harness(
                autoConnect = true,
                retryDelayBlock = retry::awaitDelay,
                beforeOutboxRead = retryRead::intercept,
            )
            try {
                retryHarness.connectOnline()
                retryHarness.transport().fail(
                    RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK),
                )
                assertTrue(retry.awaitCount(1))
                retry.release(0)
                withTimeout(TIMEOUT_MS) { retryRead.entered.await() }

                val disconnect = async {
                    retryHarness.composition.disconnectAndDrain(
                        retryHarness.profile.identity,
                        "retry-read-profile-switch",
                    )
                }
                assertEquals(null, withTimeoutOrNull(200) { disconnect.await() })

                retryRead.release.complete(Unit)
                assertEquals(
                    "retry-read-profile-switch",
                    withTimeout(TIMEOUT_MS) { disconnect.await() }.barrierId,
                )
                withTimeout(TIMEOUT_MS) {
                    retryHarness.composition.state.first {
                        it == RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.STOPPED)
                    }
                }
                delay(50)
                assertEquals(
                    RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.STOPPED),
                    retryHarness.composition.state.value,
                )
                assertEquals(1, retryHarness.factory.requests.size)
            } finally {
                retryRead.release.complete(Unit)
                retryHarness.close()
            }
        }

    @Test
    fun `immediate retryable transport open failure claims successor after actor handoff`() =
        runBlocking {
            val retry = ControlledRetryDelay()
            val actorHandoff = ActorConnectAdmissionHandoffGate()
            val harness = Harness(
                autoConnect = true,
                retryDelayBlock = retry::awaitDelay,
                transportOpenFailure = IllegalStateException("relay offline"),
                afterActorConnectAdmissionHandoff = actorHandoff::awaitRelease,
            )
            try {
                assertTrue(actorHandoff.entered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS))
                assertTrue(retry.awaitCount(1))

                assertEquals(listOf(1_000L), retry.delays)
                assertEquals(1, harness.factory.requests.size)
                assertTrue(harness.factory.transports.isEmpty())
                assertEquals(
                    RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.CONNECTING),
                    harness.composition.state.value,
                )
            } finally {
                actorHandoff.release.countDown()
                harness.close()
            }
        }

    @Test
    fun `reconnect rereads attempted outbox and old callbacks cannot consume successor admission`() =
        runBlocking {
            val retry = ControlledRetryDelay()
            val harness = Harness(
                autoConnect = true,
                outbox = sendingOutbox("old-command"),
                retryDelayBlock = retry::awaitDelay,
            )
            try {
                val oldTransport = harness.awaitTransport(0)
                oldTransport.fail(
                    RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK),
                )
                assertTrue(retry.awaitCount(1))
                harness.authority.replaceOutbox(sendingOutbox("successor-command"))

                retry.release(0)
                harness.awaitTransport(1)
                oldTransport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
                oldTransport.sendFixture("relay-welcome")
                oldTransport.sendFixture("host-welcome-caught-up")

                val successor = harness.openThroughHostWelcome(1)
                val query = successor.awaitSentType("command.query")
                assertEquals(
                    listOf("successor-command"),
                    query.payload().objectList("items").map { it.stringValue("commandId") },
                )
                assertEquals(2, harness.authority.outboxReads.get())
                assertEquals(1, harness.authority.helloCommits.get())
                assertTrue(successor.framesOfType("command.execute").isEmpty())
            } finally {
                harness.close()
            }
        }

    @Test
    fun `transport failure racing a committed apply enters retry after the commit`() = runBlocking {
        val retry = ControlledRetryDelay()
        val harness = Harness(autoConnect = true, retryDelayBlock = retry::awaitDelay)
        try {
            harness.connectOnline()
            harness.authority.blockStateEvents = true
            harness.transport().sendFixture("sessions-changed-upsert")
            withTimeout(TIMEOUT_MS) { harness.authority.stateEventApplyEntered.await() }

            harness.transport().fail(
                RelayV2TransportFailure(RelayV2TransportFailureKind.NETWORK),
            )
            harness.authority.releaseStateEventApply.complete(Unit)

            assertTrue(retry.awaitCount(1))
            delay(50)
            assertEquals(1, harness.authority.stateEventCommits.get())
            assertEquals(
                RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.CONNECTING),
                harness.composition.state.value,
            )
        } finally {
            harness.authority.releaseStateEventApply.complete(Unit)
            harness.close()
        }
    }

    @Test
    fun `disconnect and close retire outbox admission only after admitted apply drains`() =
        runBlocking {
            val disconnectGate = BeforeHelloAdmissionGate()
            val disconnectHarness = Harness(
                autoConnect = true,
                beforeHelloOutboxAdmissionRead = disconnectGate::awaitRelease,
            )
            try {
                disconnectHarness.openThroughHostWelcome()
                withTimeout(TIMEOUT_MS) { disconnectGate.entered.await() }

                val disconnect = async {
                    disconnectHarness.composition.disconnectAndDrain(
                        disconnectHarness.profile.identity,
                        "profile-switch",
                    )
                }
                assertEquals(null, withTimeoutOrNull(200) { disconnect.await() })
                assertEquals(0, disconnectHarness.authority.helloCommits.get())

                disconnectGate.release.complete(Unit)
                assertEquals(
                    "profile-switch",
                    withTimeout(TIMEOUT_MS) { disconnect.await() }.barrierId,
                )
                assertEquals(1, disconnectHarness.authority.helloCommits.get())
                assertEquals(
                    RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.STOPPED),
                    disconnectHarness.composition.state.value,
                )
            } finally {
                disconnectGate.release.complete(Unit)
                disconnectHarness.close()
            }

            val closeGate = BeforeHelloAdmissionGate()
            val closeHarness = Harness(
                autoConnect = true,
                beforeHelloOutboxAdmissionRead = closeGate::awaitRelease,
            )
            try {
                closeHarness.openThroughHostWelcome()
                withTimeout(TIMEOUT_MS) { closeGate.entered.await() }

                closeHarness.composition.close()
                assertEquals(0, closeHarness.authority.helloCommits.get())
                closeGate.release.complete(Unit)
                withTimeout(TIMEOUT_MS) {
                    while (closeHarness.authority.helloCommits.get() != 1) delay(1)
                }
                closeHarness.awaitTransportDrain()

                assertEquals(
                    RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.STOPPED),
                    closeHarness.composition.state.value,
                )
            } finally {
                closeGate.release.complete(Unit)
                closeHarness.close()
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
        newCommandId: () -> String = { "reply-${System.nanoTime()}" },
        retryDelayBlock: suspend (Long) -> Unit = { millis -> delay(millis) },
        beforeHelloOutboxAdmissionRead: suspend () -> Unit = {},
        beforeSessionProjectionPublish: suspend () -> Unit = {},
        beforeOnlineResyncReceiptSubmit: suspend () -> Unit = {},
        afterRetryableFailureAdmissionDetached: () -> Unit = {},
        beforeOutboxRead: suspend (Int) -> Unit = {},
        transportOpenFailure: Throwable? = null,
        afterActorConnectAdmissionHandoff: () -> Unit = {},
        agentDurableRepository: AgentTranscriptLifecycleRuntimeDurableRepository? = null,
        agentRuntimeFactory: ((RelayV2RepositoryEffectApplyLeasePort) ->
            AgentTranscriptLifecycleRuntimeHandlePort)? = null,
    ) {
        private val parent = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        private val credentials = MemoryCredentialStore()
        val authority = FakeDurableAuthority(outbox, outboxReadFailure, beforeOutboxRead)
        val factory = FakeTransportFactory(transportOpenFailure)
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
                materializedSessions = authority,
                activationOutbox = RelayV2ActivationOutboxReadPort(authority::readOutbox),
                outboxAuthority = authority,
                outboxEnqueueAuthority = authority,
                agentDurableRepository = agentDurableRepository,
                agentRuntimeFactory = agentRuntimeFactory,
                transportFactory = factory,
                newCommandId = newCommandId,
                clock = { NOW_MS },
                retryDelay = retryDelayBlock,
                beforeHelloOutboxAdmissionRead = beforeHelloOutboxAdmissionRead,
                beforeSessionProjectionPublish = beforeSessionProjectionPublish,
                beforeOnlineResyncReceiptSubmit = beforeOnlineResyncReceiptSubmit,
                afterRetryableFailureAdmissionDetached =
                    afterRetryableFailureAdmissionDetached,
                afterActorConnectAdmissionHandoff = afterActorConnectAdmissionHandoff,
            )
        }

        suspend fun connectOnline(index: Int = 0): MutableMap<String, Any?> {
            val transport = awaitTransport(index)
            transport.open(RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            transport.sendFixture("relay-welcome")
            val hello = transport.awaitSentFrame()
            val welcome = fixture("host-welcome-caught-up")
            welcome["requestId"] = hello.stringValue("requestId")
            transport.sendFrame(welcome)
            awaitPhase(RelayV2BaseRuntimePhase.ONLINE)
            return hello
        }

        fun agentEffect(
            negotiatedCapabilities: Set<String> =
                setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
            connectionGeneration: Long = 1,
        ): RelayV2RuntimeEffect.DeliverAgentExtensionFrame {
            val generation = RelayV2EffectGeneration(
                profileId = PROFILE_ID,
                profileGeneration = profile.activationGeneration,
                connectionGeneration = connectionGeneration,
            )
            return RelayV2RuntimeEffect.DeliverAgentExtensionFrame(
                context = agentContext(negotiatedCapabilities),
                artifact = agentArtifact(),
                ingress = AgentTranscriptLifecycleTrustedIngress.Live,
                requestAdmission = null,
                generation = generation,
            )
        }

        fun staleHello(
            connectionGeneration: Long,
        ): RelayV2RuntimeEffect.QueryPendingCommands {
            val generation = RelayV2EffectGeneration(
                profileId = PROFILE_ID,
                profileGeneration = profile.activationGeneration,
                connectionGeneration = connectionGeneration,
            )
            return RelayV2RuntimeEffect.QueryPendingCommands(
                context = agentContext(emptySet()),
                generation = generation,
                connectionAttempt = RelayV2ConnectionAttemptIdentity(profile.identity),
                recovery = RelayV2RecoveryBinding(
                    generation = generation,
                    step = 1,
                    requestId = "stale-hello-recovery",
                ),
                connectPlan = RelayV2ConnectPlan(
                    profileId = PROFILE_ID,
                    principalId = PRINCIPAL_ID,
                    clientInstanceId = CLIENT_INSTANCE_ID,
                    hostId = HOST_ID,
                    requestedResume = null,
                    recovery = RelayV2ConnectRecovery.EMPTY,
                    durableHostEpoch = null,
                    requiredThroughEventSeq = null,
                ),
            )
        }

        private fun agentContext(
            negotiatedCapabilities: Set<String>,
        ) = RelayV2HandshakeContext(
            profile = profile.identity,
            principalId = PRINCIPAL_ID,
            clientInstanceId = CLIENT_INSTANCE_ID,
            hostId = HOST_ID,
            brokerEpoch = "broker-process-uuid",
            hostEpoch = HOST_EPOCH,
            hostInstanceId = "host-process-uuid",
            eventSeq = "91",
            negotiatedCapabilities = negotiatedCapabilities,
            negotiatedLimits = RelayV2NegotiatedLimits(
                1_048_576,
                1_500_000,
                1_048_576,
                524_288,
                256,
                64,
                32,
                262_144,
                256,
                67_108_864,
                100_000,
                4_194_304,
                16_777_216,
                1_048_576,
                262_144,
                emptyMap(),
            ),
            commandDedupeWindow = RelayV2CommandDedupeWindow(
                windowId = "dedupe-window-uuid",
                windowSeq = "42",
                acceptUntilMs = NOW_MS + 5_000,
                queryUntilMs = NOW_MS + 10_000,
            ),
        )

        suspend fun openThroughHostWelcome(index: Int = 0): FakeTransport {
            val transport = awaitTransport(index)
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

        fun transport(index: Int = 0): FakeTransport = factory.transports[index]

        suspend fun closeAndAwaitTransportDrain() {
            composition.close()
            awaitTransportDrain()
        }

        suspend fun awaitTransportDrain() {
            withTimeout(TIMEOUT_MS) {
                while (transport().cancelCount != 1) delay(1)
            }
        }

        suspend fun awaitTransport(index: Int = 0): FakeTransport = withTimeout(TIMEOUT_MS) {
            while (factory.transports.size <= index) delay(1)
            factory.transports[index]
        }

        fun close() {
            composition.close()
            parent.cancel()
        }
    }

    private class SeededAgentDurableRepository(
        private val blockLoad: Boolean = false,
    ) {
        val namespace = AgentTranscriptLifecycleDurableNamespace(
            consumer = AgentTranscriptLifecycleDurableConsumerIdentity(
                profileId = PROFILE_ID,
                profileActivationGeneration = 1,
                principalId = PRINCIPAL_ID,
                clientInstanceId = CLIENT_INSTANCE_ID,
                hostId = HOST_ID,
                hostEpoch = HOST_EPOCH,
                scopeId = "scope-local",
                sessionId = "session-1",
            ),
            timelineEpoch = "timeline-1",
        )
        val loadCalls = AtomicInteger()
        val mutationCommits = AtomicInteger()
        private val current = AtomicReference(
            AgentTranscriptLifecycleDurableRecord(
                namespace = namespace,
                state = AgentTranscriptLifecycleClientState(
                    identity = namespace.consumer.sessionIdentity,
                    extensionLane = AgentTranscriptLifecycleExtensionState(
                        localGeneration = "1",
                        timelineEpoch = namespace.timelineEpoch,
                        lastAgentSeq = "11",
                    ),
                ),
                storageAccounting = AgentTranscriptDurableStorageAccounting.EMPTY,
            ),
        )
        private val loadEntered = CountDownLatch(if (blockLoad) 1 else 0)
        private val loadRelease = CountDownLatch(if (blockLoad) 1 else 0)

        val repository: AgentTranscriptLifecycleRuntimeDurableRepository =
            Proxy.newProxyInstance(
                AgentTranscriptLifecycleRuntimeDurableRepository::class.java.classLoader,
                arrayOf(AgentTranscriptLifecycleRuntimeDurableRepository::class.java),
            ) { proxy, method, arguments ->
                when (method.name) {
                    "load" -> {
                        loadCalls.incrementAndGet()
                        if (blockLoad) {
                            loadEntered.countDown()
                            check(loadRelease.await(TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                                "Agent durable load release timed out"
                            }
                        }
                        current.get().takeIf {
                            it.namespace.consumer == arguments!![0]
                        }
                    }
                    "consumeLiveEventUnderApplyLease" -> {
                        val command = arguments!![0]
                            as AgentTranscriptLifecycleDurableLiveEventCommand
                        val before = current.get()
                        check(command.fence.expectedNamespace == before.namespace)
                        val nextState = before.state.copy(
                            extensionLane = before.state.extensionLane.copy(
                                lastAgentSeq = command.frame.event.agentEventSeq,
                            ),
                        )
                        current.set(before.copy(state = nextState))
                        mutationCommits.incrementAndGet()
                        AgentTranscriptLifecycleDurableOperationResult(
                            AgentTranscriptLifecycleClientReduction(
                                state = nextState,
                                disposition = AgentClientDisposition.APPLIED,
                            ),
                        )
                    }
                    "toString" -> "SeededAgentDurableRepository"
                    "hashCode" -> System.identityHashCode(proxy)
                    "equals" -> proxy === arguments?.firstOrNull()
                    else -> error("Unexpected Agent durable repository call ${method.name}")
                }
            } as AgentTranscriptLifecycleRuntimeDurableRepository

        fun record(): AgentTranscriptLifecycleDurableRecord = current.get()

        fun awaitLoad(): Boolean = loadEntered.await(TIMEOUT_MS, TimeUnit.MILLISECONDS)

        fun releaseLoad() {
            loadRelease.countDown()
        }
    }

    private class PostReadyRecoveryProbe(
        private val failure: Throwable? = null,
    ) {
        val authorities = CopyOnWriteArrayList<RelayV2RepositoryEffectAuthority>()
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val finished = CompletableDeferred<Unit>()
        val runtime = object : AgentTranscriptLifecycleRuntimeHandlePort {
            override suspend fun handle(
                effect: RelayV2RuntimeEffect,
            ): AgentTranscriptLifecycleRuntimeCompositionResult =
                AgentTranscriptLifecycleRuntimeCompositionResult.NotOwned(effect)

            override suspend fun recoverPersistedRequestsAfterOnlineReady(
                authority: RelayV2RepositoryEffectAuthority,
                readAuthority: RelayV2CurrentRepositoryReadAuthorityPort,
            ): AgentTranscriptLifecyclePersistedRequestRecoveryResult = try {
                authorities += authority
                started.complete(Unit)
                failure?.let { throw it }
                release.await()
                AgentTranscriptLifecyclePersistedRequestRecoveryResult.Completed
            } finally {
                finished.complete(Unit)
            }
        }
    }

    private class MultiGenerationRecoveryProbe(count: Int) {
        val authorities = CopyOnWriteArrayList<RelayV2RepositoryEffectAuthority>()
        val exits = AtomicInteger()
        private val next = AtomicInteger()
        private val started = List(count) { CompletableDeferred<Unit>() }
        private val cancelled = List(count) { CompletableDeferred<Unit>() }
        private val releases = List(count) { CompletableDeferred<Unit>() }
        val runtime = object : AgentTranscriptLifecycleRuntimeHandlePort {
            override suspend fun handle(
                effect: RelayV2RuntimeEffect,
            ): AgentTranscriptLifecycleRuntimeCompositionResult =
                AgentTranscriptLifecycleRuntimeCompositionResult.NotOwned(effect)

            override suspend fun recoverPersistedRequestsAfterOnlineReady(
                authority: RelayV2RepositoryEffectAuthority,
                readAuthority: RelayV2CurrentRepositoryReadAuthorityPort,
            ): AgentTranscriptLifecyclePersistedRequestRecoveryResult {
                val index = next.getAndIncrement()
                check(index < started.size)
                authorities += authority
                started[index].complete(Unit)
                val ownerJob = checkNotNull(currentCoroutineContext()[Job])
                try {
                    withContext(NonCancellable) {
                        while (!ownerJob.isCancelled) delay(1)
                        cancelled[index].complete(Unit)
                        releases[index].await()
                    }
                } finally {
                    exits.incrementAndGet()
                }
                return AgentTranscriptLifecyclePersistedRequestRecoveryResult.Completed
            }
        }

        suspend fun awaitStarted(count: Int) {
            withTimeout(TIMEOUT_MS) { started[count - 1].await() }
        }

        suspend fun awaitCancelled(count: Int) {
            withTimeout(TIMEOUT_MS) { cancelled[count - 1].await() }
        }

        fun release(index: Int) {
            releases[index].complete(Unit)
        }

        fun releaseAll() {
            releases.forEach { it.complete(Unit) }
        }
    }

    private class PersistedRecoveryPagingFixture(
        candidateCount: Int,
        private val capacity: Int,
    ) {
        val authority = RelayV2RepositoryEffectAuthority(
            generation = RelayV2EffectGeneration(PROFILE_ID, 1, 9),
            profileId = PROFILE_ID,
            profileActivationGeneration = 1,
            principalId = PRINCIPAL_ID,
            clientInstanceId = CLIENT_INSTANCE_ID,
            hostId = HOST_ID,
            hostEpoch = HOST_EPOCH,
        )
        val catalogAuthority = AgentTranscriptLifecycleRecoveryCatalogAuthority(
            profileId = PROFILE_ID,
            profileActivationGeneration = 1,
            principalId = PRINCIPAL_ID,
            clientInstanceId = CLIENT_INSTANCE_ID,
            hostId = HOST_ID,
            hostEpoch = HOST_EPOCH,
        )
        val catalogAuthorities = CopyOnWriteArrayList<AgentTranscriptLifecycleRecoveryCatalogAuthority>()
        val requestedLimits = CopyOnWriteArrayList<Int>()
        val readCuts = AtomicInteger()
        val readLeases = AtomicInteger()
        val preparedReads = AtomicInteger()
        val sendAttempts = AtomicInteger()
        val admissions = AtomicInteger()
        private val catalogReads = AtomicInteger()
        private val catalogIssuer = Any()
        private val candidates = List(candidateCount) { index ->
            AgentTranscriptLifecycleDurableNamespace(
                consumer = AgentTranscriptLifecycleDurableConsumerIdentity(
                    profileId = PROFILE_ID,
                    profileActivationGeneration = 1,
                    principalId = PRINCIPAL_ID,
                    clientInstanceId = CLIENT_INSTANCE_ID,
                    hostId = HOST_ID,
                    hostEpoch = HOST_EPOCH,
                    scopeId = "scope-${index.toString().padStart(3, '0')}",
                    sessionId = "session-${index.toString().padStart(3, '0')}",
                ),
                timelineEpoch = "timeline-${index.toString().padStart(3, '0')}",
            )
        }
        private var expectedCursor: AgentTranscriptLifecycleRecoveryCatalogCursor? = null
        private val repository = Proxy.newProxyInstance(
            AgentTranscriptLifecycleRuntimeDurableRepository::class.java.classLoader,
            arrayOf(
                AgentTranscriptLifecycleRuntimeDurableRepository::class.java,
                AgentTranscriptLifecycleRecoveryCatalogPort::class.java,
            ),
        ) { proxy, method, arguments ->
            when (method.name) {
                "readRecoveryNamespacePage" -> {
                    val requestedAuthority = arguments!![0]
                        as AgentTranscriptLifecycleRecoveryCatalogAuthority
                    val cursor = arguments[1] as AgentTranscriptLifecycleRecoveryCatalogCursor?
                    val limit = arguments[2] as Int
                    check(requestedAuthority == catalogAuthority)
                    check(cursor === expectedCursor)
                    check(limit == 32)
                    catalogAuthorities += requestedAuthority
                    requestedLimits += limit
                    val pageIndex = catalogReads.getAndIncrement()
                    val start = pageIndex * limit
                    val end = minOf(start + limit, candidates.size)
                    val page = candidates.subList(start, end)
                    expectedCursor = if (end < candidates.size) {
                        AgentTranscriptLifecycleRecoveryCatalogCursor.issue(
                            requestedAuthority,
                            page.last(),
                            catalogIssuer,
                        )
                    } else {
                        null
                    }
                    AgentTranscriptLifecycleRecoveryNamespacePage(page, expectedCursor)
                }
                "loadPreparedRequestsUnderApplyLease" -> {
                    val fence = arguments!![0]
                        as AgentTranscriptLifecycleDurableOperationFence
                    check(fence.authority == fence.expectedNamespace.consumer)
                    val index = candidates.indexOf(fence.expectedNamespace)
                    check(index >= 0)
                    preparedReads.incrementAndGet()
                    listOf(
                        AgentTranscriptLifecycleDurablePreparedRequest.Status(
                            AgentLocalRequestFence("1", "request-$index"),
                        ),
                    )
                }
                "toString" -> "PersistedRecoveryPagingRepository"
                "hashCode" -> System.identityHashCode(proxy)
                "equals" -> proxy === arguments?.firstOrNull()
                else -> error("Unexpected persisted recovery repository call ${method.name}")
            }
        } as AgentTranscriptLifecycleRuntimeDurableRepository
        private val applyLease = object : RelayV2RepositoryEffectApplyLeasePort {
            override suspend fun <T> withEffectApplyLease(
                authority: RelayV2RepositoryEffectAuthority,
                block: suspend () -> T,
            ): RelayV2EffectApplyResult<T> =
                if (authority == this@PersistedRecoveryPagingFixture.authority) {
                    RelayV2EffectApplyResult.Applied(block())
                } else {
                    RelayV2EffectApplyResult.Stale
                }
        }
        private val handoff = object : AgentTranscriptLifecycleDurableHandoffPort {
            override fun acceptDurableHandoff(
                receipt: AgentTranscriptLifecycleCompletedHandoffReceipt,
            ): Boolean = false

            override fun acceptDurableHandoff(
                receipt: AgentTranscriptLifecycleCompletedBatchHandoffReceipt,
            ): Boolean = false

            override fun replaceForExactRedrive(
                replacement: AgentTranscriptLifecycleExactRedriveReplacement,
            ): AgentTranscriptLifecycleRequestAdmission? = null
        }
        private val requestSender = AgentTranscriptLifecycleExtensionRequestSender { request ->
                    val attempt = sendAttempts.incrementAndGet()
                    if (attempt > capacity) {
                        null
                    } else {
                        admissions.incrementAndGet()
                        AgentTranscriptLifecycleRequestAdmission(
                            authority = request.authority,
                            requestKind = request.kind,
                            requestId = request.requestId,
                            admissionSequence = attempt.toLong(),
                        )
                    }
                }
        val runtime = AgentTranscriptLifecycleRuntimeComposition.dormant(
            applyLease = applyLease,
            durableRepository = repository,
            durableHandoff = handoff,
            requestSender = requestSender,
        )
        private val cut = object : RelayV2CurrentRepositoryReadCut {
            override val authority = this@PersistedRecoveryPagingFixture.authority
            override val capability =
                RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE
        }
        val readAuthority = object : RelayV2CurrentRepositoryReadAuthorityPort {
            override fun currentRepositoryReadCut(
                capability: RelayV2RepositoryReadCapability,
            ): RelayV2CurrentRepositoryReadCutResult {
                check(capability == RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE)
                readCuts.incrementAndGet()
                return RelayV2CurrentRepositoryReadCutResult.Available(cut)
            }

            override suspend fun <T> withCurrentRepositoryReadLease(
                cut: RelayV2CurrentRepositoryReadCut,
                block: suspend () -> T,
            ): RelayV2CurrentRepositoryReadLeaseResult<T> {
                check(cut === this@PersistedRecoveryPagingFixture.cut)
                readLeases.incrementAndGet()
                return RelayV2CurrentRepositoryReadLeaseResult.Current(block())
            }
        }
    }

    private class BeforeHelloAdmissionGate {
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()

        suspend fun awaitRelease() {
            withContext(NonCancellable) {
                entered.complete(Unit)
                release.await()
            }
        }
    }

    private class RetryScheduleClaimGate {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)

        fun awaitRelease() {
            entered.countDown()
            check(release.await(TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                "Timed out holding retryable failure admission claim"
            }
        }
    }

    private class BlockingFailingOutboxRead(private val blockAtRead: Int) {
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()

        suspend fun intercept(readNumber: Int) {
            if (readNumber != blockAtRead) return
            withContext(NonCancellable) {
                entered.complete(Unit)
                release.await()
                throw IllegalStateException("post-fence Outbox read failure")
            }
        }
    }

    private class BlockingOutboxReadGate(private val blockAtRead: Int) {
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()

        suspend fun intercept(readNumber: Int) {
            if (readNumber != blockAtRead) return
            withContext(NonCancellable) {
                entered.complete(Unit)
                release.await()
            }
        }
    }

    private class ActorConnectAdmissionHandoffGate {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)

        fun awaitRelease() {
            entered.countDown()
            check(release.await(TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                "Timed out holding admitted actor-connect wrapper"
            }
        }
    }

    private class FakeDurableAuthority(
        initialOutbox: RelayV2OutboxState,
        private val outboxReadFailure: Throwable?,
        private val beforeOutboxRead: suspend (Int) -> Unit,
    ) : RelayV2StateSyncAuthority,
        RelayV2OutboxRuntimeAuthority,
        RelayV2OutboxEnqueueAuthority,
        RelayV2MaterializedSessionReadAuthority {
        private val outboxCore = RelayV2OutboxAuthorityCore()

        @Volatile
        private var outbox = initialOutbox

        val helloCommits = AtomicInteger()
        val stateEventCommits = AtomicInteger()
        val outboxReads = AtomicInteger()
        val queryCommits = AtomicInteger()
        val statusCommits = AtomicInteger()
        val enqueueCommits = AtomicInteger()
        val materializedSessionCutReads = AtomicInteger()
        val freshBatchSizes = CopyOnWriteArrayList<Int>()
        val stateEventApplyEntered = CompletableDeferred<Unit>()
        val releaseStateEventApply = CompletableDeferred<Unit>()
        val queryCommitEntered = CompletableDeferred<Unit>()
        val releaseQueryCommit = CompletableDeferred<Unit>()
        val statusCommitCompleted = CompletableDeferred<Unit>()
        val releaseAfterStatusCommit = CompletableDeferred<Unit>()
        val freshCommitCompleted = CompletableDeferred<Unit>()
        val releaseAfterFreshCommit = CompletableDeferred<Unit>()
        val enqueueEntered = CompletableDeferred<Unit>()
        val releaseEnqueue = CompletableDeferred<Unit>()
        val snapshotApplyEntered = CompletableDeferred<Unit>()
        val snapshotCommits = AtomicInteger()

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

        @Volatile
        var blockReplyEnqueue: Boolean = false

        suspend fun readOutbox(profile: RelayV2Profile): RelayV2OutboxState {
            val readNumber = outboxReads.incrementAndGet()
            beforeOutboxRead(readNumber)
            outboxReadFailure?.let { throw it }
            check(profile.profileId == PROFILE_ID)
            check(profile.principalId == PRINCIPAL_ID)
            return outbox
        }

        fun outboxState(): RelayV2OutboxState = outbox

        fun replaceOutbox(replacement: RelayV2OutboxState) {
            outbox = replacement
        }

        override suspend fun readMaterializedSessionCuts(
            namespace: RelayV2StateNamespace,
        ): List<RelayV2MaterializedSessionReadCut> = listOf(materializedSession(namespace))

        override suspend fun readMaterializedSessionCut(
            namespace: RelayV2StateNamespace,
            scopeId: String,
            sessionId: String,
        ): RelayV2MaterializedSessionReadCut? {
            materializedSessionCutReads.incrementAndGet()
            return materializedSession(namespace).takeIf {
                it.session.scopeId == scopeId && it.session.sessionId == sessionId
            }
        }

        override suspend fun enqueueOutbox(
            namespace: RelayV2OutboxAuthorityNamespace,
            draft: RelayV2OutboxDraft,
            createdAtMillis: Long,
        ): RelayV2OutboxEnqueueResult {
            check(namespace.profileId == PROFILE_ID)
            check(namespace.profileActivationGeneration == 1L)
            check(namespace.principalId == PRINCIPAL_ID)
            check(namespace.clientInstanceId == CLIENT_INSTANCE_ID)
            if (blockReplyEnqueue) {
                withContext(NonCancellable) {
                    enqueueEntered.complete(Unit)
                    releaseEnqueue.await()
                }
            }
            return when (val reduced = outboxCore.reduce(
                outbox,
                RelayV2OutboxAction.Enqueue(draft, createdAtMillis),
            )) {
                is RelayV2OutboxResult.Rejected -> RelayV2OutboxEnqueueResult.Rejected(
                    when (reduced.reason) {
                        com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxRejection.DUPLICATE_COMMAND ->
                            RelayV2OutboxEnqueueFailure.DUPLICATE_COMMAND
                        com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxRejection.CAPACITY_EXCEEDED ->
                            RelayV2OutboxEnqueueFailure.CAPACITY_EXCEEDED
                        else -> RelayV2OutboxEnqueueFailure.CORRUPT_STATE
                    },
                )
                is RelayV2OutboxResult.Applied -> {
                    outbox = reduced.state
                    val entry = reduced.state.entries.single { it.commandId == draft.commandId }
                    enqueueCommits.incrementAndGet()
                    RelayV2OutboxEnqueueResult.Committed(
                        RelayV2OutboxEnqueueReceipt(
                            hostId = entry.hostId,
                            expectedHostEpoch = entry.expectedHostEpoch,
                            commandId = entry.commandId,
                            createdOrder = entry.createdOrder,
                        ),
                    )
                }
            }
        }

        private fun materializedSession(
            namespace: RelayV2StateNamespace,
        ): RelayV2MaterializedSessionReadCut {
            check(namespace == RelayV2StateNamespace(
                profileId = PROFILE_ID,
                principalId = PRINCIPAL_ID,
                clientInstanceId = CLIENT_INSTANCE_ID,
                hostId = HOST_ID,
                hostEpoch = HOST_EPOCH,
            ))
            val scope = RelayV2ScopeResource(
                scopeId = "scope-a",
                displayName = "Local",
                kind = RelayV2ScopeKind.LOCAL,
                reachability = RelayV2ScopeReachability.ONLINE,
            )
            return RelayV2MaterializedSessionReadCut(
                namespace = namespace,
                cursor = RelayV2AppliedCursor(HOST_EPOCH, "91"),
                scopesRevision = "13",
                scope = scope,
                sessionsRevision = "13",
                session = RelayV2SessionResource(
                    scopeId = scope.scopeId,
                    sessionId = "session-a",
                    kind = RelayV2SessionKind.WORKTREE,
                    displayName = "Session A",
                    project = "project-a",
                    label = null,
                    cwd = "/work/project-a",
                    attached = false,
                    windowCount = 1,
                    createdAtMs = 1,
                    activityAtMs = 2,
                ),
            )
        }

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
        ): RelayV2StateSyncResult {
            snapshotApplyEntered.complete(Unit)
            snapshotCommits.incrementAndGet()
            return RelayV2StateSyncResult.SnapshotStaged(
                namespace = chunk.namespace,
                snapshotId = chunk.snapshotId,
                nextChunkIndex = chunk.chunkIndex + 1,
                nextCursor = "next-snapshot-cursor",
                complete = false,
            )
        }

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

    private inner class FakeTransportFactory(
        private val openFailure: Throwable?,
    ) : RelayV2TransportFactory {
        val requests = CopyOnWriteArrayList<RelayV2TransportOpenRequest>()
        val transports = CopyOnWriteArrayList<FakeTransport>()

        override fun open(
            request: RelayV2TransportOpenRequest,
            listener: RelayV2TransportListener,
        ): RelayV2Transport {
            requests += request
            openFailure?.let { throw it }
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

    private class ControlledRetryDelay {
        val delays = CopyOnWriteArrayList<Long>()
        private val releases = CopyOnWriteArrayList<CompletableDeferred<Unit>>()

        suspend fun awaitDelay(delayMs: Long) {
            val release = CompletableDeferred<Unit>()
            releases += release
            delays += delayMs
            release.await()
        }

        suspend fun awaitCount(count: Int, timeoutMs: Long = TIMEOUT_MS): Boolean =
            withTimeoutOrNull(timeoutMs) {
                while (delays.size < count) delay(1)
                true
            } ?: false

        fun release(index: Int) {
            releases[index].complete(Unit)
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

    private fun agentArtifact() = AgentTranscriptLifecycleV1Codec().decodePublicFrameArtifact(
        agentFixtureWire("live-entry-redacted"),
    )

    private fun agentFixtureWire(name: String): ByteArray {
        val resource = "extensions/agent-transcript-lifecycle/v1/golden-frames.json"
        val source = requireNotNull(
            RelayV2BaseRuntimeCompositionTest::class.java.classLoader
                ?.getResourceAsStream(resource),
        ).bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
        val wrapper = RelayV2StrictJson.parseObject(
            "{\"fixtures\":$source}",
            RelayV2JsonLimits(64, 1_024, 100_000, 200_000),
        )
        val fixture = (wrapper["fixtures"] as List<*>)
            .filterIsInstance<Map<String, Any?>>()
            .single { it["name"] == name }
        val wire = fixture["wire"] as String
        val oldEpoch = "\"hostEpoch\":\"host-epoch-1\""
        check(wire.indexOf(oldEpoch) >= 0 && wire.indexOf(oldEpoch) == wire.lastIndexOf(oldEpoch))
        return wire.replace(
            oldEpoch,
            "\"hostEpoch\":\"$HOST_EPOCH\"",
        ).toByteArray(StandardCharsets.UTF_8)
    }

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

    private fun selectedSessionReplyOutbox(): RelayV2OutboxState {
        val core = RelayV2OutboxAuthorityCore()
        var state = RelayV2OutboxState.empty()
        repeat(260) { index ->
            val commandId = "exact-${index.toString().padStart(3, '0')}"
            state = enqueueSelectedSessionReply(
                core = core,
                state = state,
                commandId = commandId,
                message = "message-$commandId",
                createdAtMillis = index.toLong(),
            )
        }
        state = enqueueSelectedSessionReply(
            core,
            state,
            commandId = "wrong-host",
            message = "wrong host",
            createdAtMillis = 300,
            hostId = "other-host",
        )
        state = enqueueSelectedSessionReply(
            core,
            state,
            commandId = "wrong-epoch",
            message = "wrong epoch",
            createdAtMillis = 301,
            hostEpoch = "other-epoch",
        )
        state = enqueueSelectedSessionReply(
            core,
            state,
            commandId = "wrong-scope",
            message = "wrong scope",
            createdAtMillis = 302,
            scopeId = "scope-b",
        )
        state = enqueueSelectedSessionReply(
            core,
            state,
            commandId = "wrong-session",
            message = "wrong Session",
            createdAtMillis = 303,
            sessionId = "session-b",
        )
        return applied(
            core.reduce(
                state,
                RelayV2OutboxAction.Enqueue(
                    RelayV2OutboxDraft(
                        profileId = PROFILE_ID,
                        principalId = PRINCIPAL_ID,
                        hostId = HOST_ID,
                        expectedHostEpoch = HOST_EPOCH,
                        dedupeWindowId = "window-other-operation",
                        commandId = "other-operation",
                        scopeId = "scope-a",
                        sessionId = "session-a",
                        arguments = RelayV2OutboxArguments.killSession(),
                    ),
                    createdAtMillis = 304,
                ),
            ),
        ).state
    }

    private fun reissuedSelectedSessionReplyOutbox(): RelayV2OutboxState {
        val core = RelayV2OutboxAuthorityCore()
        var state = enqueueSelectedSessionReply(
            core = core,
            state = RelayV2OutboxState.empty(),
            commandId = "parent-command",
            message = "replacement body",
            createdAtMillis = 1,
        )
        val parent = state.entries.single()
        state = applied(
            core.reduce(
                state,
                RelayV2OutboxAction.DispatchEligible(
                    attemptRequestIds = mapOf(parent.id to "parent-attempt"),
                    effectBudget = 1,
                ),
            ),
        ).state
        val attemptedParent = state.entries.single()
        return applied(
            core.reduce(
                state,
                RelayV2OutboxAction.ReconcileStatus(
                    evidence = RelayV2CommandStatusEvidence(
                        entryId = attemptedParent.id,
                        dedupeWindowId = attemptedParent.dedupeWindowId,
                        hostEpoch = attemptedParent.expectedHostEpoch,
                        scopeId = attemptedParent.scopeId,
                        sessionId = attemptedParent.sessionId,
                        operation = attemptedParent.operation,
                        source = RelayV2CommandStatusSource.EXECUTE_RESPONSE,
                        attemptKind = RelayV2OutboxAttemptKind.EXECUTE,
                        state = RelayV2CommandStatusState.NOT_ACCEPTED,
                        attemptRequestId = "parent-attempt",
                        reissueRequired = true,
                        errorCode = "COMMAND_WINDOW_EXPIRED",
                        commandDisposition = RelayV2CommandDisposition.NOT_ACCEPTED,
                        detailsReissueRequired = true,
                    ),
                    recovery = RelayV2OutboxRecovery.Reissue(
                        replacementCommandId = "replacement-command",
                        newDedupeWindowId = "replacement-window",
                        replacementCreatedAtMillis = 2,
                    ),
                ),
            ),
        ).state
    }

    private fun enqueueSelectedSessionReply(
        core: RelayV2OutboxAuthorityCore,
        state: RelayV2OutboxState,
        commandId: String,
        message: String,
        createdAtMillis: Long,
        hostId: String = HOST_ID,
        hostEpoch: String = HOST_EPOCH,
        scopeId: String = "scope-a",
        sessionId: String = "session-a",
    ): RelayV2OutboxState = applied(
        core.reduce(
            state,
            RelayV2OutboxAction.Enqueue(
                RelayV2OutboxDraft(
                    profileId = PROFILE_ID,
                    principalId = PRINCIPAL_ID,
                    hostId = hostId,
                    expectedHostEpoch = hostEpoch,
                    dedupeWindowId = "window-$commandId",
                    commandId = commandId,
                    scopeId = scopeId,
                    sessionId = sessionId,
                    arguments = RelayV2OutboxArguments.sendAgentMessage(
                        pane = 0,
                        message = message,
                        submit = true,
                    ),
                ),
                createdAtMillis = createdAtMillis,
            ),
        ),
    ).state

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
