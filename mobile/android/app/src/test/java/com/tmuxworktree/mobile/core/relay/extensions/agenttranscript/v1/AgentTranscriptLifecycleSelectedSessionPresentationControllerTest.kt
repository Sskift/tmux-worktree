package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AppliedCursor
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2MaterializedSessionReadCut
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeKind
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeReachability
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeResource
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SessionKind
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SessionResource
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateNamespace
import java.util.concurrent.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentTranscriptLifecycleSelectedSessionPresentationControllerTest {
    @Test
    fun `initial read starts at null cursor and publishes only structured Agent rows`() =
        runBlocking {
            val fixture = PresentationFixture(pageLimit = 2)
            val firstItems = listOf(
                presentationTranscript("1", "entry-user"),
                presentationLifecycle("2", "event-running"),
            )
            fixture.readOwner.enqueue(
                presentationPage(
                    fixture,
                    items = firstItems,
                    endReached = false,
                ),
            )

            val content = fixture.controller.read(fixture.intent)
                as AgentTranscriptLifecycleSelectedSessionPresentationState.Content

            assertEquals(1, fixture.readOwner.calls.size)
            assertNull(fixture.readOwner.calls.single().cursor)
            assertEquals(2, fixture.readOwner.calls.single().limit)
            assertEquals(firstItems, content.presentation.items)
            assertEquals(fixture.revision, content.presentation.revision)
            assertSame(content, fixture.controller.state)
        }

    @Test
    fun `load more uses exact cursor aggregates one revision in Agent sequence and stops at end`() =
        runBlocking {
            val fixture = PresentationFixture(pageLimit = 2)
            val firstItems = listOf(
                presentationTranscript("1", "entry-user"),
                presentationLifecycle("2", "event-running"),
            )
            val first = presentationPage(
                fixture,
                items = firstItems,
                endReached = false,
            )
            val exactCursor = requireNotNull(first.presentation.nextCursor)
            val secondItems = listOf(
                presentationTranscript("3", "entry-agent"),
                presentationLifecycle("4", "event-waiting"),
            )
            fixture.readOwner.enqueue(first)
            fixture.readOwner.enqueue(
                presentationPage(
                    fixture,
                    items = secondItems,
                    endReached = true,
                    materialized = fixture.materialized.copy(sessionsRevision = "10"),
                ),
            )

            fixture.controller.read(fixture.intent)
            val complete = fixture.controller.loadMore()
                as AgentTranscriptLifecycleSelectedSessionPresentationState.Content

            assertEquals(exactCursor, fixture.readOwner.calls[1].cursor)
            assertEquals(
                listOf("1", "2", "3", "4"),
                complete.presentation.items.map { it.sequence() },
            )
            assertEquals(fixture.revision, complete.presentation.revision)
            assertEquals("10", complete.materializedSession.sessionsRevision)
            assertTrue(complete.presentation.endReached)
            assertNull(complete.presentation.nextCursor)

            assertSame(complete, fixture.controller.loadMore())
            assertEquals("endReached must not call the lower owner", 2, fixture.readOwner.calls.size)
        }

    @Test
    fun `disabled unavailable and stale replace prior content and retain no paging owner`() =
        runBlocking {
            val cases = listOf(
                AgentTranscriptLifecycleSelectedSessionReadResult.Disabled to
                    AgentTranscriptLifecycleSelectedSessionPresentationState.Disabled,
                AgentTranscriptLifecycleSelectedSessionReadResult.Unavailable to
                    AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable,
                AgentTranscriptLifecycleSelectedSessionReadResult.Stale to
                    AgentTranscriptLifecycleSelectedSessionPresentationState.Stale,
            )

            cases.forEach { (readResult, expected) ->
                val fixture = PresentationFixture(pageLimit = 1)
                fixture.readOwner.enqueue(
                    presentationPage(
                        fixture,
                        items = listOf(presentationTranscript("1", "entry-old")),
                        endReached = false,
                    ),
                )
                fixture.readOwner.enqueue(readResult)

                fixture.controller.read(fixture.intent)
                assertSame(expected, fixture.controller.loadMore())
                assertSame(expected, fixture.controller.state)

                val callsAtClosure = fixture.readOwner.calls.size
                assertSame(expected, fixture.controller.loadMore())
                assertEquals(callsAtClosure, fixture.readOwner.calls.size)
            }
        }

    @Test
    fun `revision or durable namespace change fails closed and clears accumulated rows`() =
        runBlocking {
            val fixtureSeed = PresentationFixture(pageLimit = 1)
            val changedNamespace = presentationNamespace(
                timelineEpoch = "timeline-presentation-other",
            )
            val changedRevisions = listOf(
                fixtureSeed.revision.copy(localGeneration = "2"),
                presentationRevision(changedNamespace),
            )

            changedRevisions.forEach { changedRevision ->
                val fixture = PresentationFixture(pageLimit = 1)
                fixture.readOwner.enqueue(
                    presentationPage(
                        fixture,
                        items = listOf(presentationTranscript("1", "entry-first")),
                        endReached = false,
                    ),
                )
                fixture.readOwner.enqueue(
                    presentationPage(
                        fixture,
                        revision = changedRevision,
                        items = listOf(presentationTranscript("2", "entry-next")),
                        endReached = true,
                    ),
                )

                fixture.controller.read(fixture.intent)
                assertSame(
                    AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable,
                    fixture.controller.loadMore(),
                )
                assertSame(
                    AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable,
                    fixture.controller.state,
                )

                fixture.controller.loadMore()
                assertEquals(2, fixture.readOwner.calls.size)
            }
        }

    @Test
    fun `non advancing cursor or duplicate structured item fails closed`() = runBlocking {
        InvalidContinuation.entries.forEach { invalid ->
            val fixture = PresentationFixture(pageLimit = 1)
            val first = presentationPage(
                fixture,
                items = listOf(presentationTranscript("1", "entry-repeat")),
                endReached = false,
            )
            val requestedCursor = requireNotNull(first.presentation.nextCursor)
            val invalidPage = when (invalid) {
                InvalidContinuation.CURSOR_NOT_ADVANCING -> presentationPage(
                    fixture,
                    items = listOf(presentationTranscript("2", "entry-next")),
                    endReached = false,
                    nextCursor = requestedCursor,
                )
                InvalidContinuation.DUPLICATE_ITEM -> presentationPage(
                    fixture,
                    items = listOf(presentationTranscript("2", "entry-repeat")),
                    endReached = true,
                )
            }
            fixture.readOwner.enqueue(first)
            fixture.readOwner.enqueue(invalidPage)

            fixture.controller.read(fixture.intent)
            assertSame(
                AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable,
                fixture.controller.loadMore(),
            )
            assertSame(
                AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable,
                fixture.controller.state,
            )
        }
    }

    @Test
    fun `ordinary owner failure clears content while cancellation propagates unchanged`() =
        runBlocking {
            val ordinary = PresentationFixture(pageLimit = 1)
            ordinary.readOwner.enqueue(
                presentationPage(
                    ordinary,
                    items = listOf(presentationTranscript("1", "entry-before-failure")),
                    endReached = false,
                ),
            )
            ordinary.readOwner.enqueueFailure(IllegalStateException("read failed"))
            ordinary.controller.read(ordinary.intent)

            assertSame(
                AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable,
                ordinary.controller.loadMore(),
            )
            assertSame(
                AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable,
                ordinary.controller.state,
            )

            val cancelled = PresentationFixture(pageLimit = 1)
            cancelled.readOwner.enqueue(
                presentationPage(
                    cancelled,
                    items = listOf(presentationTranscript("1", "entry-before-cancel")),
                    endReached = false,
                ),
            )
            val cancellation = CancellationException("read cancelled")
            cancelled.readOwner.enqueueFailure(cancellation)
            cancelled.controller.read(cancelled.intent)

            assertSame(
                cancellation,
                runCatching { cancelled.controller.loadMore() }.exceptionOrNull(),
            )
        }
}

private data class PresentationReadCall(
    val intent: AgentTranscriptLifecycleSessionSelectionIntent,
    val cursor: AgentTranscriptLifecycleReadCursor?,
    val limit: Int,
)

private enum class InvalidContinuation {
    CURSOR_NOT_ADVANCING,
    DUPLICATE_ITEM,
}

private class RecordingPresentationReadOwner :
    AgentTranscriptLifecycleSelectedSessionPresentationReadPort {
    val calls = mutableListOf<PresentationReadCall>()
    private val queued =
        mutableListOf<suspend (PresentationReadCall) ->
            AgentTranscriptLifecycleSelectedSessionReadResult>()

    fun enqueue(result: AgentTranscriptLifecycleSelectedSessionReadResult) {
        queued += { result }
    }

    fun enqueueFailure(failure: Throwable) {
        queued += { throw failure }
    }

    override suspend fun read(
        intent: AgentTranscriptLifecycleSessionSelectionIntent,
        cursor: AgentTranscriptLifecycleReadCursor?,
        limit: Int,
    ): AgentTranscriptLifecycleSelectedSessionReadResult {
        val call = PresentationReadCall(intent, cursor, limit)
        calls += call
        return queued.removeAt(0)(call)
    }
}

private class PresentationFixture(pageLimit: Int) {
    val stateNamespace = presentationStateNamespace()
    val intent = AgentTranscriptLifecycleSessionSelectionIntent(
        namespace = stateNamespace,
        scopeId = PRESENTATION_SCOPE_ID,
        sessionId = PRESENTATION_SESSION_ID,
    )
    val namespace = presentationNamespace()
    val revision = presentationRevision(namespace)
    val materialized = presentationMaterializedSession(stateNamespace)
    val readOwner = RecordingPresentationReadOwner()
    val controller = AgentTranscriptLifecycleSelectedSessionPresentationController(
        readOwner = readOwner,
        pageLimit = pageLimit,
    )
}

private fun presentationPage(
    fixture: PresentationFixture,
    revision: AgentTranscriptLifecycleReadRevision = fixture.revision,
    items: List<AgentTranscriptLifecyclePresentationItem>,
    endReached: Boolean,
    nextCursor: AgentTranscriptLifecycleReadCursor? = if (endReached) {
        null
    } else {
        presentationCursor(revision, items.last())
    },
    materialized: RelayV2MaterializedSessionReadCut = fixture.materialized,
) = AgentTranscriptLifecycleSelectedSessionReadResult.Page(
    materializedSession = materialized,
    presentation = AgentTranscriptLifecyclePresentation.Page(
        revision = revision,
        items = items,
        nextCursor = nextCursor,
        endReached = endReached,
    ),
)

private fun presentationCursor(
    revision: AgentTranscriptLifecycleReadRevision,
    item: AgentTranscriptLifecyclePresentationItem,
): AgentTranscriptLifecycleReadCursor = when (item) {
    is AgentTranscriptLifecyclePresentationItem.Transcript -> AgentTranscriptLifecycleReadCursor(
        revision = revision,
        agentEventSeq = item.createdAgentSeq,
        recordKind = AgentTranscriptLifecycleReadRecordKind.ENTRY,
        stableIdentity = item.entryId,
    )
    is AgentTranscriptLifecyclePresentationItem.Lifecycle -> AgentTranscriptLifecycleReadCursor(
        revision = revision,
        agentEventSeq = item.agentEventSeq,
        recordKind = AgentTranscriptLifecycleReadRecordKind.LIFECYCLE,
        stableIdentity = item.lifecycleEventId,
    )
}

private fun AgentTranscriptLifecyclePresentationItem.sequence(): String = when (this) {
    is AgentTranscriptLifecyclePresentationItem.Transcript -> createdAgentSeq
    is AgentTranscriptLifecyclePresentationItem.Lifecycle -> agentEventSeq
}

private fun presentationTranscript(
    sequence: String,
    entryId: String,
) = AgentTranscriptLifecyclePresentationItem.Transcript(
    entryId = entryId,
    runId = "run-presentation",
    turnId = "turn-presentation",
    role = AgentTimelineEntryRole.AGENT,
    commandCorrelationId = null,
    createdAtMs = sequence.toLong(),
    createdAgentSeq = sequence,
    lastModifiedAgentSeq = sequence,
    content = AgentTranscriptEntryContent.Visible("text-$entryId"),
)

private fun presentationLifecycle(
    sequence: String,
    eventId: String,
) = AgentTranscriptLifecyclePresentationItem.Lifecycle(
    identity = AgentLifecycleIdentity(
        scope = AgentLifecycleScope.TURN,
        runId = "run-presentation",
        turnId = "turn-presentation",
    ),
    lifecycleEventId = eventId,
    sourceEpoch = PRESENTATION_SOURCE_EPOCH,
    state = AgentLifecycleState.RUNNING,
    failure = null,
    occurredAtMs = sequence.toLong(),
    agentEventSeq = sequence,
    isCurrentSource = true,
)

private fun presentationStateNamespace() = RelayV2StateNamespace(
    profileId = "profile-presentation-owner",
    principalId = "principal-presentation-owner",
    clientInstanceId = "client-presentation-owner",
    hostId = "host-presentation-owner",
    hostEpoch = "host-epoch-presentation-owner",
)

private fun presentationNamespace(
    timelineEpoch: String = PRESENTATION_TIMELINE_EPOCH,
) = AgentTranscriptLifecycleDurableNamespace(
    consumer = AgentTranscriptLifecycleDurableConsumerIdentity(
        profileId = "profile-presentation-owner",
        profileActivationGeneration = 1,
        principalId = "principal-presentation-owner",
        clientInstanceId = "client-presentation-owner",
        hostId = "host-presentation-owner",
        hostEpoch = "host-epoch-presentation-owner",
        scopeId = PRESENTATION_SCOPE_ID,
        sessionId = PRESENTATION_SESSION_ID,
    ),
    timelineEpoch = timelineEpoch,
)

private fun presentationRevision(
    namespace: AgentTranscriptLifecycleDurableNamespace,
) = AgentTranscriptLifecycleReadRevision(
    namespace = namespace,
    parentPayloadSha256 = "c".repeat(64),
    localGeneration = "1",
    materializedThroughAgentSeq = "8",
    sourceCut = AgentTranscriptLifecycleReadSourceCut.Available(
        liveSource = AgentLiveSourceState.CONNECTED,
        activeSourceEpoch = PRESENTATION_SOURCE_EPOCH,
        currentSourceAttested = true,
    ),
)

private fun presentationMaterializedSession(
    namespace: RelayV2StateNamespace,
) = RelayV2MaterializedSessionReadCut(
    namespace = namespace,
    cursor = RelayV2AppliedCursor(namespace.hostEpoch, "5"),
    scopesRevision = "7",
    scope = RelayV2ScopeResource(
        scopeId = PRESENTATION_SCOPE_ID,
        displayName = "Scope",
        kind = RelayV2ScopeKind.LOCAL,
        reachability = RelayV2ScopeReachability.ONLINE,
    ),
    sessionsRevision = "9",
    session = RelayV2SessionResource(
        scopeId = PRESENTATION_SCOPE_ID,
        sessionId = PRESENTATION_SESSION_ID,
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

private const val PRESENTATION_SCOPE_ID = "scope-presentation-owner"
private const val PRESENTATION_SESSION_ID = "session-presentation-owner"
private const val PRESENTATION_TIMELINE_EPOCH = "timeline-presentation-owner"
private const val PRESENTATION_SOURCE_EPOCH = "source-presentation-owner"
