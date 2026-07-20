package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CurrentRepositoryReadAuthorityPort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CurrentRepositoryReadCut
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CurrentRepositoryReadCutResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CurrentRepositoryReadLeaseResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectGeneration
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryReadCapability
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AppliedCursor
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2MaterializedSessionReadCut
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeKind
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeReachability
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeResource
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SessionKind
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SessionResource
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateNamespace
import java.lang.reflect.Proxy
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentTranscriptLifecycleSelectedSessionStatusAdmissionControllerTest {
    @Test
    fun `invalid admission closes but unexpected load failure propagates before side effects`() =
        runBlocking {
            val fixture = StatusAdmissionFixture()
            val foreignConsumer = fixture.consumer.copy(sessionId = "session-foreign")
            val unexpectedLoadFailure = IllegalStateException("unexpected durable load failure")
            val scenarios = listOf(
                StatusAdmissionScenario(
                    acquired = RelayV2CurrentRepositoryReadCutResult.Unavailable,
                    expectedMaterializedReads = 0,
                    expectedDurableReads = 0,
                ),
                StatusAdmissionScenario(
                    acquired = statusAdmissionAvailableCut(fixture.authority),
                    staleLease = true,
                    expectedMaterializedReads = 0,
                    expectedDurableReads = 0,
                ),
                StatusAdmissionScenario(
                    acquired = statusAdmissionAvailableCut(fixture.authority),
                    materialized = fixture.materialized.copy(
                        session = fixture.materialized.session.copy(
                            sessionId = "session-foreign",
                        ),
                    ),
                    expectedMaterializedReads = 1,
                    expectedDurableReads = 0,
                ),
                StatusAdmissionScenario(
                    acquired = statusAdmissionAvailableCut(fixture.authority),
                    durableRecord = statusAdmissionDurableRecord(foreignConsumer, null),
                    expectedMaterializedReads = 1,
                    expectedDurableReads = 1,
                ),
                StatusAdmissionScenario(
                    acquired = statusAdmissionAvailableCut(fixture.authority),
                    durableFailure = unexpectedLoadFailure,
                    expectedMaterializedReads = 1,
                    expectedDurableReads = 1,
                ),
            )

            scenarios.forEach { scenario ->
                val materializedReads = AtomicInteger(0)
                val initializeCalls = AtomicInteger(0)
                val coordinatorCalls = AtomicInteger(0)
                val readAuthority = FakeStatusAdmissionReadAuthority(
                    acquired = scenario.acquired,
                    staleLease = scenario.staleLease,
                )
                val durableRepository = RecordingStatusAdmissionDurableRepository(
                    inActorLease = { readAuthority.leaseActive },
                    record = scenario.durableRecord,
                    loadFailure = scenario.durableFailure,
                )
                val controller = AgentTranscriptLifecycleSelectedSessionStatusAdmissionController(
                    sessionSelection = AgentTranscriptLifecycleSessionSelectionController(
                        readAuthority = readAuthority,
                        stateRepositoryRead = { _, _, _ ->
                            materializedReads.incrementAndGet()
                            scenario.materialized ?: fixture.materialized
                        },
                    ),
                    durableRepository = durableRepository.repository,
                    durableLoadOrInitialize = AgentTranscriptLifecycleDurableLoadOrInitializePort {
                            _, _ ->
                        initializeCalls.incrementAndGet()
                        AgentTranscriptLifecycleDurableLoadOrInitializeResult.Ready
                    },
                    requestSync = AgentTranscriptLifecycleStatusRequestPort {
                        coordinatorCalls.incrementAndGet()
                        AgentTranscriptLifecycleRequestSyncResult.NoRequest
                    },
                    enabled = true,
                )

                if (scenario.durableFailure == null) {
                    assertSame(
                        AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult.Unavailable,
                        controller.requestStatus(fixture.intent),
                    )
                } else {
                    assertSame(
                        scenario.durableFailure,
                        runCatching { controller.requestStatus(fixture.intent) }.exceptionOrNull(),
                    )
                }
                assertEquals(scenario.expectedMaterializedReads, materializedReads.get())
                assertEquals(scenario.expectedDurableReads, durableRepository.loadCalls)
                assertEquals(0, initializeCalls.get())
                assertEquals(0, coordinatorCalls.get())
            }
        }

    @Test
    fun `actor cut selects progressed or canonical namespace before single flight status`() =
        runBlocking {
            val fixture = StatusAdmissionFixture()
            val progressedNamespace = AgentTranscriptLifecycleDurableNamespace(
                fixture.consumer,
                "timeline-progressed",
            )
            listOf(
                statusAdmissionDurableRecord(
                    fixture.consumer,
                    progressedNamespace.timelineEpoch,
                ) to progressedNamespace,
                null to AgentTranscriptLifecycleDurableNamespace(fixture.consumer, null),
            ).forEach { (existing, expectedNamespace) ->
                val readAuthority = FakeStatusAdmissionReadAuthority(
                    acquired = statusAdmissionAvailableCut(fixture.authority),
                    expectedLeaseBlocks = 2,
                )
                val durableRepository = RecordingStatusAdmissionDurableRepository(
                    inActorLease = { readAuthority.leaseActive },
                    record = existing,
                )
                val initializeStarted = CompletableDeferred<Unit>()
                val releaseInitialize = CompletableDeferred<Unit>()
                val order = mutableListOf<String>()
                val initializedNamespaces = mutableListOf<AgentTranscriptLifecycleDurableNamespace>()
                val coordinatorContexts =
                    mutableListOf<AgentTranscriptLifecycleOutboundStatusRequestContext>()
                val controller = AgentTranscriptLifecycleSelectedSessionStatusAdmissionController(
                    sessionSelection = AgentTranscriptLifecycleSessionSelectionController(
                        readAuthority = readAuthority,
                        stateRepositoryRead = { _, _, _ -> fixture.materialized },
                    ),
                    durableRepository = durableRepository.repository,
                    durableLoadOrInitialize = AgentTranscriptLifecycleDurableLoadOrInitializePort {
                            authority, namespace ->
                        assertEquals(fixture.authority, authority)
                        order += "initialize:start"
                        initializedNamespaces += namespace
                        initializeStarted.complete(Unit)
                        releaseInitialize.await()
                        order += "initialize:committed"
                        AgentTranscriptLifecycleDurableLoadOrInitializeResult.Ready
                    },
                    requestSync = AgentTranscriptLifecycleStatusRequestPort { context ->
                        order += "coordinator"
                        coordinatorContexts += context
                        AgentTranscriptLifecycleRequestSyncResult.NoRequest
                    },
                    enabled = true,
                )

                val first = async { controller.requestStatus(fixture.intent) }
                initializeStarted.await()
                val second = async { controller.requestStatus(fixture.intent) }
                readAuthority.allExpectedLeaseBlocks.await()
                releaseInitialize.complete(Unit)
                first.await()
                second.await()

                assertEquals(2, durableRepository.loadCalls)
                assertTrue(durableRepository.allLoadsInsideActorLease)
                assertEquals(listOf(expectedNamespace), initializedNamespaces)
                assertEquals(
                    listOf(
                        AgentTranscriptLifecycleOutboundStatusRequestContext(
                            fixture.authority,
                            expectedNamespace,
                        ),
                    ),
                    coordinatorContexts,
                )
                assertEquals(
                    listOf("initialize:start", "initialize:committed", "coordinator"),
                    order,
                )
            }
        }
}

private data class StatusAdmissionScenario(
    val acquired: RelayV2CurrentRepositoryReadCutResult,
    val staleLease: Boolean = false,
    val materialized: RelayV2MaterializedSessionReadCut? = null,
    val durableRecord: AgentTranscriptLifecycleDurableRecord? = null,
    val durableFailure: Throwable? = null,
    val expectedMaterializedReads: Int,
    val expectedDurableReads: Int,
)

private class StatusAdmissionFixture {
    val stateNamespace = RelayV2StateNamespace(
        profileId = "profile-status",
        principalId = "principal-status",
        clientInstanceId = "client-status",
        hostId = "host-status",
        hostEpoch = "epoch-status",
    )
    val authority = RelayV2RepositoryEffectAuthority(
        generation = RelayV2EffectGeneration(
            profileId = stateNamespace.profileId,
            profileGeneration = 7,
            connectionGeneration = 11,
        ),
        profileId = stateNamespace.profileId,
        profileActivationGeneration = 7,
        principalId = stateNamespace.principalId,
        clientInstanceId = stateNamespace.clientInstanceId,
        hostId = stateNamespace.hostId,
        hostEpoch = stateNamespace.hostEpoch,
    )
    val intent = AgentTranscriptLifecycleSessionSelectionIntent(
        namespace = stateNamespace,
        scopeId = STATUS_ADMISSION_SCOPE_ID,
        sessionId = STATUS_ADMISSION_SESSION_ID,
    )
    val consumer = AgentTranscriptLifecycleDurableConsumerIdentity(
        profileId = authority.profileId,
        profileActivationGeneration = authority.profileActivationGeneration,
        principalId = authority.principalId,
        clientInstanceId = authority.clientInstanceId,
        hostId = authority.hostId,
        hostEpoch = authority.hostEpoch,
        scopeId = intent.scopeId,
        sessionId = intent.sessionId,
    )
    val materialized = RelayV2MaterializedSessionReadCut(
        namespace = stateNamespace,
        cursor = RelayV2AppliedCursor(stateNamespace.hostEpoch, "5"),
        scopesRevision = "7",
        scope = RelayV2ScopeResource(
            scopeId = intent.scopeId,
            displayName = "Scope",
            kind = RelayV2ScopeKind.LOCAL,
            reachability = RelayV2ScopeReachability.ONLINE,
        ),
        sessionsRevision = "9",
        session = RelayV2SessionResource(
            scopeId = intent.scopeId,
            sessionId = intent.sessionId,
            kind = RelayV2SessionKind.WORKTREE,
            displayName = "Session",
            project = "project",
            label = null,
            cwd = "/repo",
            attached = false,
            windowCount = 1,
            createdAtMs = 1,
            activityAtMs = 2,
        ),
    )
}

private class FakeStatusAdmissionReadAuthority(
    private val acquired: RelayV2CurrentRepositoryReadCutResult,
    private val staleLease: Boolean = false,
    expectedLeaseBlocks: Int = 0,
) : RelayV2CurrentRepositoryReadAuthorityPort {
    private val leaseBlocks = AtomicInteger(0)
    var leaseActive: Boolean = false
        private set
    val allExpectedLeaseBlocks = CompletableDeferred<Unit>().also { completion ->
        if (expectedLeaseBlocks == 0) completion.complete(Unit)
    }
    private val expectedLeaseBlocks = expectedLeaseBlocks

    override fun currentRepositoryReadCut(
        capability: RelayV2RepositoryReadCapability,
    ): RelayV2CurrentRepositoryReadCutResult {
        assertEquals(RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE, capability)
        return acquired
    }

    override suspend fun <T> withCurrentRepositoryReadLease(
        cut: RelayV2CurrentRepositoryReadCut,
        block: suspend () -> T,
    ): RelayV2CurrentRepositoryReadLeaseResult<T> {
        if (staleLease) return RelayV2CurrentRepositoryReadLeaseResult.Stale
        leaseActive = true
        return try {
            if (leaseBlocks.incrementAndGet() == expectedLeaseBlocks) {
                allExpectedLeaseBlocks.complete(Unit)
            }
            RelayV2CurrentRepositoryReadLeaseResult.Current(block())
        } finally {
            leaseActive = false
        }
    }
}

private class RecordingStatusAdmissionDurableRepository(
    private val inActorLease: () -> Boolean,
    var record: AgentTranscriptLifecycleDurableRecord?,
    var loadFailure: Throwable? = null,
) {
    var loadCalls = 0
    var allLoadsInsideActorLease = true

    val repository: AgentTranscriptLifecycleRuntimeDurableRepository = Proxy.newProxyInstance(
        AgentTranscriptLifecycleRuntimeDurableRepository::class.java.classLoader,
        arrayOf(AgentTranscriptLifecycleRuntimeDurableRepository::class.java),
    ) { proxy, method, arguments ->
        when (method.name) {
            "load" -> {
                loadCalls++
                allLoadsInsideActorLease = allLoadsInsideActorLease && inActorLease()
                loadFailure?.let { throw it }
                record
            }
            "toString" -> "RecordingStatusAdmissionDurableRepository"
            "hashCode" -> System.identityHashCode(proxy)
            "equals" -> proxy === arguments?.firstOrNull()
            else -> error("Unexpected durable repository call ${method.name}")
        }
    } as AgentTranscriptLifecycleRuntimeDurableRepository
}

private fun statusAdmissionAvailableCut(
    authority: RelayV2RepositoryEffectAuthority,
) = RelayV2CurrentRepositoryReadCutResult.Available(statusAdmissionReadCut(authority))

private fun statusAdmissionReadCut(
    authority: RelayV2RepositoryEffectAuthority,
) = object : RelayV2CurrentRepositoryReadCut {
    override val authority = authority
    override val capability = RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE
}

private fun statusAdmissionDurableRecord(
    consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    timelineEpoch: String?,
) = AgentTranscriptLifecycleDurableRecord(
    namespace = AgentTranscriptLifecycleDurableNamespace(consumer, timelineEpoch),
    state = AgentTranscriptLifecycleClientState(
        identity = consumer.sessionIdentity,
        extensionLane = if (timelineEpoch == null) {
            AgentTranscriptLifecycleExtensionState()
        } else {
            AgentTranscriptLifecycleExtensionState(
                support = AgentExtensionSupport.UNKNOWN,
                unavailableReason = null,
                timelineEpoch = timelineEpoch,
            )
        },
    ),
    storageAccounting = AgentTranscriptDurableStorageAccounting.EMPTY,
)

private const val STATUS_ADMISSION_SCOPE_ID = "scope-status"
private const val STATUS_ADMISSION_SESSION_ID = "session-status"
