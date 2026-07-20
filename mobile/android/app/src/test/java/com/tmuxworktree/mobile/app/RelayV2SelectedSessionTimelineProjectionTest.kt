package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.core.model.TimelineActor
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentLifecycleFailure
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2SelectedSessionTimelineProjectionTest {
    @Test
    fun `content keeps transcript projection and maps structured lifecycle evidence`() = runBlocking {
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
                lifecycle(
                    scope = AgentLifecycleScope.TURN,
                    runId = "ab",
                    turnId = "c",
                    lifecycleEventId = "lifecycle-running",
                    state = AgentLifecycleState.RUNNING,
                    occurredAtMs = 303,
                    agentEventSeq = "3",
                ),
            ),
        )

        val timeline = projectRelayV2SelectedSessionTimeline(
            sessionStableId = "s",
            readPresentation = { content },
            stillCurrent = { true },
        )

        assertEquals(3, timeline.size)
        assertEquals(TimelineActor.USER, timeline[0].actor)
        assertEquals("hello", timeline[0].body)
        assertEquals(101, timeline[0].createdAtMillis)
        assertEquals(TimelineActor.AGENT, timeline[1].actor)
        assertEquals("Message redacted", timeline[1].body)
        assertEquals(202, timeline[1].createdAtMillis)
        assertNotEquals(timeline[0].eventId, timeline[1].eventId)
        assertEquals(TimelineActor.SYSTEM, timeline[2].actor)
        assertEquals("Turn lifecycle: Running", timeline[2].body)
        assertEquals(303, timeline[2].createdAtMillis)
        assertNull(timeline[2].deliveryState)
    }

    @Test
    fun `lifecycle states use only structured evidence and mark historical sources`() = runBlocking {
        val timeline = projectRelayV2SelectedSessionTimeline(
            sessionStableId = "session-ui",
            readPresentation = {
                projectionContent(
                    listOf(
                        lifecycle(
                            scope = AgentLifecycleScope.RUN,
                            runId = "run-running",
                            turnId = null,
                            lifecycleEventId = "running",
                            state = AgentLifecycleState.RUNNING,
                            occurredAtMs = 301,
                            agentEventSeq = "1",
                        ),
                        lifecycle(
                            scope = AgentLifecycleScope.TURN,
                            runId = "run-waiting",
                            turnId = "turn-waiting",
                            lifecycleEventId = "waiting",
                            state = AgentLifecycleState.WAITING_FOR_USER,
                            occurredAtMs = 302,
                            agentEventSeq = "2",
                        ),
                        lifecycle(
                            scope = AgentLifecycleScope.TURN,
                            runId = "run-failed",
                            turnId = "turn-failed",
                            lifecycleEventId = "failed",
                            state = AgentLifecycleState.FAILED,
                            failure = AgentLifecycleFailure(
                                code = "TOOL_EXIT",
                                summary = "Command returned 17",
                            ),
                            occurredAtMs = 303,
                            agentEventSeq = "3",
                        ),
                        lifecycle(
                            scope = AgentLifecycleScope.RUN,
                            runId = "run-completed",
                            turnId = null,
                            lifecycleEventId = "completed",
                            state = AgentLifecycleState.COMPLETED,
                            occurredAtMs = 304,
                            agentEventSeq = "4",
                            isCurrentSource = false,
                        ),
                        lifecycle(
                            scope = AgentLifecycleScope.TURN,
                            runId = "run-empty-summary",
                            turnId = "turn-empty-summary",
                            lifecycleEventId = "failed-empty-summary",
                            state = AgentLifecycleState.FAILED,
                            failure = AgentLifecycleFailure(
                                code = "EMPTY_SUMMARY",
                                summary = "",
                            ),
                            occurredAtMs = 305,
                            agentEventSeq = "5",
                        ),
                        lifecycle(
                            scope = AgentLifecycleScope.TURN,
                            runId = "run-blank-summary",
                            turnId = "turn-blank-summary",
                            lifecycleEventId = "failed-blank-summary",
                            state = AgentLifecycleState.FAILED,
                            failure = AgentLifecycleFailure(
                                code = "BLANK_SUMMARY",
                                summary = " \t ",
                            ),
                            occurredAtMs = 306,
                            agentEventSeq = "6",
                        ),
                    ),
                )
            },
            stillCurrent = { true },
        )

        assertEquals(
            listOf(
                "Run lifecycle: Running",
                "Turn lifecycle: Waiting for user",
                "Turn lifecycle: Failed (TOOL_EXIT: Command returned 17)",
                "Historical source evidence · Run lifecycle: Completed",
                "Turn lifecycle: Failed (EMPTY_SUMMARY)",
                "Turn lifecycle: Failed (BLANK_SUMMARY)",
            ),
            timeline.map { it.body },
        )
        assertTrue(timeline.all { it.actor == TimelineActor.SYSTEM })
        assertTrue(timeline.all { it.deliveryState == null })
    }

    @Test
    fun `lifecycle identities cover exact source and nullable turn without delimiter collisions`() =
        runBlocking {
            suspend fun eventId(
                sessionStableId: String = "session",
                timelineEpoch: String = "timeline",
                sourceEpoch: String = "source",
                scope: AgentLifecycleScope = AgentLifecycleScope.TURN,
                runId: String = "run",
                turnId: String? = "turn",
                lifecycleEventId: String = "event",
            ): String = projectRelayV2SelectedSessionTimeline(
                sessionStableId = sessionStableId,
                readPresentation = {
                    projectionContent(
                        items = listOf(
                            lifecycle(
                                scope = scope,
                                runId = runId,
                                turnId = turnId,
                                lifecycleEventId = lifecycleEventId,
                                sourceEpoch = sourceEpoch,
                                state = AgentLifecycleState.RUNNING,
                                occurredAtMs = 1,
                                agentEventSeq = "1",
                            ),
                        ),
                        timelineEpoch = timelineEpoch,
                    )
                },
                stillCurrent = { true },
            ).single().eventId

            val identities = listOf(
                eventId(),
                eventId(sessionStableId = "session-other"),
                eventId(timelineEpoch = "timeline-other"),
                eventId(sourceEpoch = "source-other"),
                eventId(scope = AgentLifecycleScope.RUN, turnId = null),
                eventId(runId = "run-other"),
                eventId(turnId = "turn-other"),
                eventId(lifecycleEventId = "event-other"),
                eventId(runId = "a:b", turnId = "c"),
                eventId(runId = "a", turnId = "b:c"),
            )

            assertEquals(identities.size, identities.toSet().size)
        }

    @Test
    fun `non content presentation states stay empty`() = runBlocking {
        val states = listOf(
            AgentTranscriptLifecycleSelectedSessionPresentationState.Disabled,
            AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable,
            AgentTranscriptLifecycleSelectedSessionPresentationState.Stale,
        )

        states.forEach { state ->
            assertTrue(
                projectRelayV2SelectedSessionTimeline(
                    sessionStableId = "session-ui",
                    readPresentation = { state },
                    stillCurrent = { true },
                ).isEmpty(),
            )
        }
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
    timelineEpoch: String = "timeline-projection",
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
        timelineEpoch = timelineEpoch,
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

private fun lifecycle(
    scope: AgentLifecycleScope,
    runId: String,
    turnId: String?,
    lifecycleEventId: String,
    sourceEpoch: String = SOURCE_EPOCH,
    state: AgentLifecycleState,
    failure: AgentLifecycleFailure? = null,
    occurredAtMs: Long,
    agentEventSeq: String,
    isCurrentSource: Boolean = true,
) = AgentTranscriptLifecyclePresentationItem.Lifecycle(
    identity = AgentLifecycleIdentity(
        scope = scope,
        runId = runId,
        turnId = turnId,
    ),
    lifecycleEventId = lifecycleEventId,
    sourceEpoch = sourceEpoch,
    state = state,
    failure = failure,
    occurredAtMs = occurredAtMs,
    agentEventSeq = agentEventSeq,
    isCurrentSource = isCurrentSource,
)

private const val SCOPE_ID = "scope-projection"
private const val SESSION_ID = "session-projection"
private const val SOURCE_EPOCH = "source-projection"
