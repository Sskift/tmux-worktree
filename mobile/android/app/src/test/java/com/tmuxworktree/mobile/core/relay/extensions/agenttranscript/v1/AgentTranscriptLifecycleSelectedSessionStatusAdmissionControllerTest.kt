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
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class AgentTranscriptLifecycleSelectedSessionStatusAdmissionControllerTest {
    @Test
    fun `unnegotiated and stale selection never materialize initialize or request status`() =
        runBlocking {
            val fixture = StatusAdmissionFixture()
            listOf(
                StatusAdmissionScenario(
                    negotiated = false,
                    readAuthority = FakeStatusAdmissionReadAuthority(
                        RelayV2CurrentRepositoryReadCutResult.Available(
                            statusAdmissionReadCut(fixture.authority),
                        ),
                    ),
                ),
                StatusAdmissionScenario(
                    negotiated = true,
                    readAuthority = FakeStatusAdmissionReadAuthority(
                        RelayV2CurrentRepositoryReadCutResult.Available(
                            statusAdmissionReadCut(fixture.authority),
                        ),
                        staleLease = true,
                    ),
                ),
            ).forEach { scenario ->
                val materializedReads = AtomicInteger(0)
                val initializeCalls = AtomicInteger(0)
                val coordinatorCalls = AtomicInteger(0)
                val controller = AgentTranscriptLifecycleSelectedSessionStatusAdmissionController(
                    sessionSelection = AgentTranscriptLifecycleSessionSelectionController(
                        readAuthority = scenario.readAuthority,
                        stateRepositoryRead = { _, _, _ ->
                            materializedReads.incrementAndGet()
                            fixture.materialized
                        },
                    ),
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

                assertSame(
                    AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult.Unavailable,
                    controller.requestStatus(
                        fixture.intent,
                        fixture.runtimeFence(negotiated = scenario.negotiated),
                    ),
                )
                assertEquals(0, materializedReads.get())
                assertEquals(0, initializeCalls.get())
                assertEquals(0, coordinatorCalls.get())
            }
        }

    @Test
    fun `concurrent exact selection single flights initialize before status request`() =
        runBlocking {
            val fixture = StatusAdmissionFixture()
            val readAuthority = FakeStatusAdmissionReadAuthority(
                RelayV2CurrentRepositoryReadCutResult.Available(
                    statusAdmissionReadCut(fixture.authority),
                ),
                expectedLeaseBlocks = 2,
            )
            val initializeStarted = CompletableDeferred<Unit>()
            val releaseInitialize = CompletableDeferred<Unit>()
            val order = mutableListOf<String>()
            val initializedNamespaces = mutableListOf<AgentTranscriptLifecycleDurableNamespace>()
            val coordinatorFences = mutableListOf<AgentTranscriptLifecycleRuntimeFence>()
            val controller = AgentTranscriptLifecycleSelectedSessionStatusAdmissionController(
                sessionSelection = AgentTranscriptLifecycleSessionSelectionController(
                    readAuthority = readAuthority,
                    stateRepositoryRead = { _, _, _ -> fixture.materialized },
                ),
                durableLoadOrInitialize = AgentTranscriptLifecycleDurableLoadOrInitializePort {
                        _, namespace ->
                    order += "initialize:start"
                    initializedNamespaces += namespace
                    initializeStarted.complete(Unit)
                    releaseInitialize.await()
                    order += "initialize:committed"
                    AgentTranscriptLifecycleDurableLoadOrInitializeResult.Ready
                },
                requestSync = AgentTranscriptLifecycleStatusRequestPort { fence ->
                    order += "coordinator"
                    coordinatorFences += fence
                    AgentTranscriptLifecycleRequestSyncResult.NoRequest
                },
                enabled = true,
            )
            val fence = fixture.runtimeFence(negotiated = true)

            val first = async { controller.requestStatus(fixture.intent, fence) }
            initializeStarted.await()
            val second = async { controller.requestStatus(fixture.intent, fence) }
            readAuthority.allExpectedLeaseBlocks.await()
            releaseInitialize.complete(Unit)
            first.await()
            second.await()

            assertEquals(listOf(fence.expectedNamespace), initializedNamespaces)
            assertEquals(listOf(fence), coordinatorFences)
            assertEquals(
                listOf("initialize:start", "initialize:committed", "coordinator"),
                order,
            )
        }
}

private data class StatusAdmissionScenario(
    val negotiated: Boolean,
    val readAuthority: FakeStatusAdmissionReadAuthority,
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

    fun runtimeFence(negotiated: Boolean) = AgentTranscriptLifecycleRuntimeFence(
        authority = authority,
        expectedNamespace = AgentTranscriptLifecycleDurableNamespace(consumer, null),
        negotiatedCapabilities = if (negotiated) {
            setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY)
        } else {
            emptySet()
        },
        ingress = AgentTranscriptLifecycleTrustedIngress.Live,
    )
}

private class FakeStatusAdmissionReadAuthority(
    private val acquired: RelayV2CurrentRepositoryReadCutResult,
    private val staleLease: Boolean = false,
    expectedLeaseBlocks: Int = 0,
) : RelayV2CurrentRepositoryReadAuthorityPort {
    private val leaseBlocks = AtomicInteger(0)
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
        if (leaseBlocks.incrementAndGet() == expectedLeaseBlocks) {
            allExpectedLeaseBlocks.complete(Unit)
        }
        return RelayV2CurrentRepositoryReadLeaseResult.Current(block())
    }
}

private fun statusAdmissionReadCut(
    authority: RelayV2RepositoryEffectAuthority,
) = object : RelayV2CurrentRepositoryReadCut {
    override val authority = authority
    override val capability = RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE
}

private const val STATUS_ADMISSION_SCOPE_ID = "scope-status"
private const val STATUS_ADMISSION_SESSION_ID = "session-status"
