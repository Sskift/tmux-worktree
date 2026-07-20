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
import java.util.concurrent.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentTranscriptLifecycleSelectedSessionReadControllerTest {
    @Test
    fun `default off returns disabled before validation or owner access`() = runBlocking {
        val fixture = SelectedReadFixture(enabled = false)

        assertSame(
            AgentTranscriptLifecycleSelectedSessionReadResult.Disabled,
            fixture.read(limit = 0),
        )
        assertEquals(0, fixture.readAuthority.acquireCalls)
        assertEquals(0, fixture.stateReads)
        assertEquals(0, fixture.durable.loadCalls)
        assertEquals(0, fixture.durable.pinnedReadCalls)
    }

    @Test
    fun `exact selected Session reads and maps one pinned page inside the lease`() = runBlocking {
        val fixture = SelectedReadFixture()
        val cursor = selectedReadCursor(fixture.record.namespace)
        val nextCursor = AgentTranscriptLifecycleReadCursor(
            revision = selectedReadRevision(fixture.record.namespace),
            agentEventSeq = "3",
            recordKind = AgentTranscriptLifecycleReadRecordKind.LIFECYCLE,
            stableIdentity = "event-waiting",
        )
        fixture.durable.pinnedRead = { namespace, actualCursor, limit ->
            assertEquals(fixture.record.namespace, namespace)
            assertEquals(cursor, actualCursor)
            assertEquals(32, limit)
            selectedPinnedPage(namespace, nextCursor)
        }

        val result = fixture.read(cursor = cursor, limit = 32)
            as AgentTranscriptLifecycleSelectedSessionReadResult.Page

        assertEquals(fixture.consumer, fixture.durable.loadConsumer)
        assertEquals(fixture.materialized, result.materializedSession)
        assertEquals(
            listOf("entry-agent", "event-waiting"),
            result.presentation.items.map { item ->
                when (item) {
                    is AgentTranscriptLifecyclePresentationItem.Transcript -> item.entryId
                    is AgentTranscriptLifecyclePresentationItem.Lifecycle -> item.lifecycleEventId
                }
            },
        )
        assertEquals(nextCursor, result.presentation.nextCursor)
        assertEquals(1, fixture.durable.loadCalls)
        assertEquals(1, fixture.durable.pinnedReadCalls)
        assertFalse(fixture.readAuthority.inLease())
    }

    @Test
    fun `selection unavailable and stale never enter the Agent durable path`() = runBlocking {
        listOf(
            SelectedReadFixture(selection = SelectedReadSelection.UNAVAILABLE) to
                AgentTranscriptLifecycleSelectedSessionReadResult.Unavailable,
            SelectedReadFixture(selection = SelectedReadSelection.STALE) to
                AgentTranscriptLifecycleSelectedSessionReadResult.Stale,
        ).forEach { (fixture, expected) ->
            assertSame(expected, fixture.read())
            assertEquals(0, fixture.durable.loadCalls)
            assertEquals(0, fixture.durable.pinnedReadCalls)
        }
    }

    @Test
    fun `durable record access and cursor failures close without content`() = runBlocking {
        val fixture = SelectedReadFixture()
        val exact = fixture.record
        val invalidRecords = listOf(
            selectedDurableRecord(fixture.consumer.copy(principalId = "principal-other")),
            exact.copy(
                state = exact.state.copy(
                    identity = exact.state.identity.copy(sessionId = "session-other"),
                ),
            ),
            exact.copy(
                state = exact.state.copy(
                    extensionLane = exact.state.extensionLane.copy(
                        timelineEpoch = "timeline-other",
                    ),
                ),
            ),
        )
        invalidRecords.forEach { invalid ->
            fixture.durable.record = invalid
            assertSame(
                AgentTranscriptLifecycleSelectedSessionReadResult.Unavailable,
                fixture.read(),
            )
        }
        assertEquals(0, fixture.durable.pinnedReadCalls)

        fixture.durable.record = null
        assertSame(
            AgentTranscriptLifecycleSelectedSessionReadResult.Unavailable,
            fixture.read(),
        )
        assertEquals(0, fixture.durable.pinnedReadCalls)

        fixture.durable.record = selectedDurableRecord(
            fixture.consumer,
            supportAvailable = false,
        )
        assertSame(
            AgentTranscriptLifecycleSelectedSessionReadResult.Unavailable,
            fixture.read(),
        )
        assertEquals(0, fixture.durable.pinnedReadCalls)

        fixture.durable.record = exact
        fixture.durable.pinnedRead = { _, _, _ ->
            AgentTranscriptLifecycleRevisionPinnedReadResult.CursorRevisionChanged
        }
        assertSame(
            AgentTranscriptLifecycleSelectedSessionReadResult.Unavailable,
            fixture.read(cursor = selectedReadCursor(exact.namespace)),
        )
        assertEquals(1, fixture.durable.pinnedReadCalls)
    }

    @Test
    fun `load failure closes unavailable while cancellation propagates and releases lease`() =
        runBlocking {
            val fixture = SelectedReadFixture()
            fixture.durable.loadFailure = IllegalStateException("durable load failed")
            assertSame(
                AgentTranscriptLifecycleSelectedSessionReadResult.Unavailable,
                fixture.read(),
            )
            assertFalse(fixture.readAuthority.inLease())
            assertEquals(0, fixture.durable.pinnedReadCalls)

            val cancellation = CancellationException("durable load cancelled")
            fixture.durable.loadFailure = cancellation
            assertSame(
                cancellation,
                runCatching { fixture.read() }.exceptionOrNull(),
            )
            assertFalse(fixture.readAuthority.inLease())
        }
}

private enum class SelectedReadSelection {
    CURRENT,
    UNAVAILABLE,
    STALE,
}

private class SelectedReadFixture(
    enabled: Boolean = true,
    selection: SelectedReadSelection = SelectedReadSelection.CURRENT,
) {
    val namespace = selectedReadStateNamespace()
    val authority = selectedReadAuthority(namespace)
    val materialized = selectedMaterializedCut(namespace)
    val consumer = selectedConsumer(authority)
    val record = selectedDurableRecord(consumer)
    val readAuthority = FakeSelectedReadAuthority(
        acquired = if (selection == SelectedReadSelection.UNAVAILABLE) {
            RelayV2CurrentRepositoryReadCutResult.Unavailable
        } else {
            RelayV2CurrentRepositoryReadCutResult.Available(selectedReadCut(authority))
        },
        staleLease = selection == SelectedReadSelection.STALE,
    )
    var stateReads = 0
    private val sessionSelection = AgentTranscriptLifecycleSessionSelectionController(
        readAuthority = readAuthority,
        stateRepositoryRead = { _, _, _ ->
            stateReads++
            materialized
        },
    )
    val durable = RecordingSelectedSessionDurableRepository(
        inLease = readAuthority::inLease,
        record = record,
        pinnedRead = { readNamespace, _, _ -> selectedPinnedPage(readNamespace) },
    )
    private val controller = AgentTranscriptLifecycleSelectedSessionReadController(
        sessionSelection = sessionSelection,
        durableRepository = durable.repository,
        enabled = enabled,
    )

    suspend fun read(
        cursor: AgentTranscriptLifecycleReadCursor? = null,
        limit: Int = 8,
    ): AgentTranscriptLifecycleSelectedSessionReadResult = controller.read(
        intent = AgentTranscriptLifecycleSessionSelectionIntent(
            namespace = namespace,
            scopeId = SELECTED_SCOPE_ID,
            sessionId = SELECTED_SESSION_ID,
        ),
        cursor = cursor,
        limit = limit,
    )
}

private class FakeSelectedReadAuthority(
    private val acquired: RelayV2CurrentRepositoryReadCutResult,
    private val staleLease: Boolean = false,
) : RelayV2CurrentRepositoryReadAuthorityPort {
    var acquireCalls = 0
    private var leaseActive = false

    fun inLease(): Boolean = leaseActive

    override fun currentRepositoryReadCut(
        capability: RelayV2RepositoryReadCapability,
    ): RelayV2CurrentRepositoryReadCutResult {
        assertEquals(RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE, capability)
        acquireCalls++
        return acquired
    }

    override suspend fun <T> withCurrentRepositoryReadLease(
        cut: RelayV2CurrentRepositoryReadCut,
        block: suspend () -> T,
    ): RelayV2CurrentRepositoryReadLeaseResult<T> {
        if (staleLease) return RelayV2CurrentRepositoryReadLeaseResult.Stale
        leaseActive = true
        return try {
            RelayV2CurrentRepositoryReadLeaseResult.Current(block())
        } finally {
            leaseActive = false
        }
    }
}

private class RecordingSelectedSessionDurableRepository(
    private val inLease: () -> Boolean,
    var record: AgentTranscriptLifecycleDurableRecord?,
    var pinnedRead: (
        AgentTranscriptLifecycleDurableNamespace,
        AgentTranscriptLifecycleReadCursor?,
        Int,
    ) -> AgentTranscriptLifecycleRevisionPinnedReadResult,
) {
    var loadCalls = 0
    var pinnedReadCalls = 0
    var loadConsumer: AgentTranscriptLifecycleDurableConsumerIdentity? = null
    var loadFailure: Throwable? = null

    val repository: AgentTranscriptLifecycleRuntimeDurableRepository = Proxy.newProxyInstance(
        AgentTranscriptLifecycleRuntimeDurableRepository::class.java.classLoader,
        arrayOf(AgentTranscriptLifecycleRuntimeDurableRepository::class.java),
    ) { proxy, method, arguments ->
        when (method.name) {
            "load" -> {
                assertTrue("durable load must run inside the actor lease", inLease())
                loadCalls++
                loadConsumer = arguments!![0]
                    as AgentTranscriptLifecycleDurableConsumerIdentity
                loadFailure?.let { throw it }
                record
            }
            "readRevisionPinnedPage" -> {
                assertTrue("Room projection must run inside the actor lease", inLease())
                pinnedReadCalls++
                pinnedRead(
                    arguments!![0] as AgentTranscriptLifecycleDurableNamespace,
                    arguments[1] as AgentTranscriptLifecycleReadCursor?,
                    arguments[2] as Int,
                )
            }
            "toString" -> "RecordingSelectedSessionDurableRepository"
            "hashCode" -> System.identityHashCode(proxy)
            "equals" -> proxy === arguments?.firstOrNull()
            else -> error("Unexpected durable repository call ${method.name}")
        }
    } as AgentTranscriptLifecycleRuntimeDurableRepository
}

private fun selectedReadStateNamespace() = RelayV2StateNamespace(
    profileId = "profile-selected",
    principalId = "principal-selected",
    clientInstanceId = "client-selected",
    hostId = "host-selected",
    hostEpoch = "epoch-selected",
)

private fun selectedReadAuthority(
    namespace: RelayV2StateNamespace,
) = RelayV2RepositoryEffectAuthority(
    generation = RelayV2EffectGeneration(
        profileId = namespace.profileId,
        profileGeneration = 7,
        connectionGeneration = 11,
    ),
    profileId = namespace.profileId,
    profileActivationGeneration = 7,
    principalId = namespace.principalId,
    clientInstanceId = namespace.clientInstanceId,
    hostId = namespace.hostId,
    hostEpoch = namespace.hostEpoch,
)

private fun selectedReadCut(
    authority: RelayV2RepositoryEffectAuthority,
) = object : RelayV2CurrentRepositoryReadCut {
    override val authority = authority
    override val capability = RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE
}

private fun selectedMaterializedCut(
    namespace: RelayV2StateNamespace,
) = RelayV2MaterializedSessionReadCut(
    namespace = namespace,
    cursor = RelayV2AppliedCursor(namespace.hostEpoch, "5"),
    scopesRevision = "7",
    scope = RelayV2ScopeResource(
        scopeId = SELECTED_SCOPE_ID,
        displayName = "Scope display only",
        kind = RelayV2ScopeKind.LOCAL,
        reachability = RelayV2ScopeReachability.ONLINE,
    ),
    sessionsRevision = "9",
    session = RelayV2SessionResource(
        scopeId = SELECTED_SCOPE_ID,
        sessionId = SELECTED_SESSION_ID,
        kind = RelayV2SessionKind.WORKTREE,
        displayName = "Session display only",
        project = "project",
        label = null,
        cwd = "/repo",
        attached = false,
        windowCount = 1,
        createdAtMs = 1,
        activityAtMs = 2,
    ),
)

private fun selectedConsumer(
    authority: RelayV2RepositoryEffectAuthority,
) = AgentTranscriptLifecycleDurableConsumerIdentity(
    profileId = authority.profileId,
    profileActivationGeneration = authority.profileActivationGeneration,
    principalId = authority.principalId,
    clientInstanceId = authority.clientInstanceId,
    hostId = authority.hostId,
    hostEpoch = authority.hostEpoch,
    scopeId = SELECTED_SCOPE_ID,
    sessionId = SELECTED_SESSION_ID,
)

private fun selectedDurableRecord(
    consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    supportAvailable: Boolean = true,
): AgentTranscriptLifecycleDurableRecord {
    val extension = AgentTranscriptLifecycleExtensionState(
        localGeneration = "1",
        support = if (supportAvailable) {
            AgentExtensionSupport.AVAILABLE
        } else {
            AgentExtensionSupport.UNAVAILABLE
        },
        unavailableReason = if (supportAvailable) {
            null
        } else {
            AgentExtensionUnavailableReason.ADAPTER_UNAVAILABLE
        },
        liveSource = AgentLiveSourceState.CONNECTED.takeIf { supportAvailable },
        activeSourceEpoch = SELECTED_SOURCE_EPOCH.takeIf { supportAvailable },
        timelineEpoch = SELECTED_TIMELINE_EPOCH,
        lastAgentSeq = "3",
        effectiveHostLimits = selectedHostLimits().takeIf { supportAvailable },
        syncState = AgentTimelineSyncState.Current,
        notificationBaselineAgentSeq = "0",
    )
    return AgentTranscriptLifecycleDurableRecord(
        namespace = AgentTranscriptLifecycleDurableNamespace(
            consumer,
            SELECTED_TIMELINE_EPOCH,
        ),
        state = AgentTranscriptLifecycleClientState(
            identity = consumer.sessionIdentity,
            extensionLane = extension,
        ),
        storageAccounting = AgentTranscriptDurableStorageAccounting.EMPTY,
    )
}

private fun selectedPinnedPage(
    namespace: AgentTranscriptLifecycleDurableNamespace,
    nextCursor: AgentTranscriptLifecycleReadCursor? = null,
) = AgentTranscriptLifecycleRevisionPinnedReadResult.Page(
    revision = selectedReadRevision(namespace),
    items = listOf(
        AgentTranscriptLifecycleReadItem.TranscriptEntry(
            AgentTranscriptEntryReadModel(
                entryId = "entry-agent",
                runId = "run-selected",
                turnId = "turn-selected",
                role = AgentTimelineEntryRole.AGENT,
                commandCorrelationId = null,
                createdAtMs = 20,
                createdAgentSeq = "2",
                lastModifiedAgentSeq = "2",
                content = AgentTranscriptEntryContent.Visible("durable reply"),
            ),
        ),
        AgentTranscriptLifecycleReadItem.LifecycleEvidence(
            AgentLifecycleRecord(
                lifecycleEventId = "event-waiting",
                sourceEpoch = SELECTED_SOURCE_EPOCH,
                identity = AgentLifecycleIdentity(
                    scope = AgentLifecycleScope.TURN,
                    runId = "run-selected",
                    turnId = "turn-selected",
                ),
                state = AgentLifecycleState.WAITING_FOR_USER,
                failure = null,
                occurredAtMs = 30,
                agentEventSeq = "3",
            ),
        ),
    ),
    nextCursor = nextCursor,
    endReached = nextCursor == null,
)

private fun selectedReadCursor(
    namespace: AgentTranscriptLifecycleDurableNamespace,
) = AgentTranscriptLifecycleReadCursor(
    revision = selectedReadRevision(namespace),
    agentEventSeq = "1",
    recordKind = AgentTranscriptLifecycleReadRecordKind.ENTRY,
    stableIdentity = "entry-before",
)

private fun selectedReadRevision(
    namespace: AgentTranscriptLifecycleDurableNamespace,
) = AgentTranscriptLifecycleReadRevision(
    namespace = namespace,
    parentPayloadSha256 = "a".repeat(64),
    localGeneration = "1",
    materializedThroughAgentSeq = "3",
    sourceCut = AgentTranscriptLifecycleReadSourceCut.Available(
        liveSource = AgentLiveSourceState.CONNECTED,
        activeSourceEpoch = SELECTED_SOURCE_EPOCH,
        currentSourceAttested = true,
    ),
)

private fun selectedHostLimits() = AgentTimelineEffectiveLimits(
    maxTextUtf8Bytes = 65_536,
    maxPageRecords = 256,
    eventReplayRetentionMs = 604_800_000,
    snapshotLeaseMs = 300_000,
)

private const val SELECTED_SCOPE_ID = "scope-selected"
private const val SELECTED_SESSION_ID = "session-selected"
private const val SELECTED_TIMELINE_EPOCH = "timeline-selected"
private const val SELECTED_SOURCE_EPOCH = "source-selected"
