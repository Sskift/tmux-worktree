package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.core.model.TimelineActor
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentLifecycleIdentity
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentLifecycleScope
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentLifecycleState
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentLiveSourceState
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTimelineEntryRole
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTimelineRedactionReason
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptEntryContent
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleDurableConsumerIdentity
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleDurableNamespace
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecyclePresentation
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecyclePresentationItem
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleReadRevision
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleReadSourceCut
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleSelectedSessionPresentationState
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AppliedCursor
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2MaterializedSessionReadCut
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeKind
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeReachability
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeResource
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SessionKind
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SessionResource
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateNamespace
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2SelectedSessionTimelineProjectionTest {
    @Test
    fun `content maps only scoped transcript rows with injective identities`() = runBlocking {
        val content = projectionContent(
            listOf(
                transcript(
                    entryId = "de",
                    runId = "ab",
                    turnId = "c",
                    role = AgentTimelineEntryRole.USER,
                    content = AgentTranscriptEntryContent.Visible("hello"),
                    createdAtMs = 101,
                    agentEventSeq = "1",
                ),
                transcript(
                    entryId = "cde",
                    runId = "a",
                    turnId = "b",
                    role = AgentTimelineEntryRole.AGENT,
                    content = AgentTranscriptEntryContent.Redacted(
                        AgentTimelineRedactionReason.POLICY,
                    ),
                    createdAtMs = 202,
                    agentEventSeq = "2",
                ),
                AgentTranscriptLifecyclePresentationItem.Lifecycle(
                    identity = AgentLifecycleIdentity(
                        scope = AgentLifecycleScope.TURN,
                        runId = "ab",
                        turnId = "c",
                    ),
                    lifecycleEventId = "lifecycle-running",
                    sourceEpoch = SOURCE_EPOCH,
                    state = AgentLifecycleState.RUNNING,
                    failure = null,
                    occurredAtMs = 303,
                    agentEventSeq = "3",
                    isCurrentSource = true,
                ),
            ),
        )

        val timeline = projectRelayV2SelectedSessionTimeline(
            sessionStableId = "s",
            readPresentation = { content },
            stillCurrent = { true },
        )

        assertEquals(2, timeline.size)
        assertEquals(TimelineActor.USER, timeline[0].actor)
        assertEquals("hello", timeline[0].body)
        assertEquals(101, timeline[0].createdAtMillis)
        assertEquals(TimelineActor.AGENT, timeline[1].actor)
        assertEquals("Message redacted", timeline[1].body)
        assertEquals(202, timeline[1].createdAtMillis)
        assertNotEquals(timeline[0].eventId, timeline[1].eventId)
    }

    @Test
    fun `post read stale fence clears content`() = runBlocking {
        var current = true
        var readCompleted = false

        val timeline = projectRelayV2SelectedSessionTimeline(
            sessionStableId = "session-ui",
            readPresentation = {
                current = false
                readCompleted = true
                projectionContent(
                    listOf(
                        transcript(
                            entryId = "entry-stale",
                            runId = "run-stale",
                            turnId = "turn-stale",
                            role = AgentTimelineEntryRole.AGENT,
                            content = AgentTranscriptEntryContent.Visible("stale"),
                            createdAtMs = 404,
                            agentEventSeq = "1",
                        ),
                    ),
                )
            },
            stillCurrent = {
                assertTrue(readCompleted)
                current
            },
        )

        assertTrue(timeline.isEmpty())
    }
}

private fun projectionContent(
    items: List<AgentTranscriptLifecyclePresentationItem>,
): AgentTranscriptLifecycleSelectedSessionPresentationState.Content {
    val stateNamespace = RelayV2StateNamespace(
        profileId = "profile-projection",
        principalId = "principal-projection",
        clientInstanceId = "client-projection",
        hostId = "host-projection",
        hostEpoch = "host-epoch-projection",
    )
    val consumer = AgentTranscriptLifecycleDurableConsumerIdentity(
        profileId = stateNamespace.profileId,
        profileActivationGeneration = 1,
        principalId = stateNamespace.principalId,
        clientInstanceId = stateNamespace.clientInstanceId,
        hostId = stateNamespace.hostId,
        hostEpoch = stateNamespace.hostEpoch,
        scopeId = SCOPE_ID,
        sessionId = SESSION_ID,
    )
    val durableNamespace = AgentTranscriptLifecycleDurableNamespace(
        consumer = consumer,
        timelineEpoch = "timeline-projection",
    )
    return AgentTranscriptLifecycleSelectedSessionPresentationState.Content(
        materializedSession = RelayV2MaterializedSessionReadCut(
            namespace = stateNamespace,
            cursor = RelayV2AppliedCursor(stateNamespace.hostEpoch, "7"),
            scopesRevision = "8",
            scope = RelayV2ScopeResource(
                scopeId = SCOPE_ID,
                displayName = "Scope",
                kind = RelayV2ScopeKind.LOCAL,
                reachability = RelayV2ScopeReachability.ONLINE,
            ),
            sessionsRevision = "9",
            session = RelayV2SessionResource(
                scopeId = SCOPE_ID,
                sessionId = SESSION_ID,
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
        ),
        presentation = AgentTranscriptLifecyclePresentation.Page(
            revision = AgentTranscriptLifecycleReadRevision(
                namespace = durableNamespace,
                parentPayloadSha256 = "a".repeat(64),
                localGeneration = "1",
                materializedThroughAgentSeq = "3",
                sourceCut = AgentTranscriptLifecycleReadSourceCut.Available(
                    liveSource = AgentLiveSourceState.CONNECTED,
                    activeSourceEpoch = SOURCE_EPOCH,
                    currentSourceAttested = true,
                ),
            ),
            items = items,
            nextCursor = null,
            endReached = true,
        ),
    )
}

private fun transcript(
    entryId: String,
    runId: String,
    turnId: String,
    role: AgentTimelineEntryRole,
    content: AgentTranscriptEntryContent,
    createdAtMs: Long,
    agentEventSeq: String,
) = AgentTranscriptLifecyclePresentationItem.Transcript(
    entryId = entryId,
    runId = runId,
    turnId = turnId,
    role = role,
    commandCorrelationId = null,
    createdAtMs = createdAtMs,
    createdAgentSeq = agentEventSeq,
    lastModifiedAgentSeq = agentEventSeq,
    content = content,
)

private const val SCOPE_ID = "scope-projection"
private const val SESSION_ID = "session-projection"
private const val SOURCE_EPOCH = "source-projection"
