package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class AgentTranscriptLifecyclePresentationTest {
    @Test
    fun rowProjectionPresentationKeepsDeliveryCorrelationSeparateFromLifecycleStatus() {
        val namespace = presentationReadNamespace()
        val transcript = AgentTranscriptLifecycleReadItem.TranscriptEntry(
            AgentTranscriptEntryReadModel(
                entryId = "entry-user",
                runId = "run-user",
                turnId = "turn-user",
                role = AgentTimelineEntryRole.USER,
                commandCorrelationId = "command-delivery-owned-elsewhere",
                createdAtMs = 10,
                createdAgentSeq = "1",
                lastModifiedAgentSeq = "1",
                content = AgentTranscriptEntryContent.Visible("hello"),
            ),
        )
        val lifecycle = AgentTranscriptLifecycleReadItem.LifecycleEvidence(
            AgentLifecycleRecord(
                lifecycleEventId = "event-waiting",
                sourceEpoch = "source-read",
                identity = AgentLifecycleIdentity(
                    AgentLifecycleScope.TURN,
                    "run-user",
                    "turn-user",
                ),
                state = AgentLifecycleState.WAITING_FOR_USER,
                failure = null,
                occurredAtMs = 20,
                agentEventSeq = "2",
            ),
        )
        val revision = AgentTranscriptLifecycleReadRevision(
            namespace = namespace,
            parentPayloadSha256 = "a".repeat(64),
            localGeneration = "1",
            materializedThroughAgentSeq = "2",
            sourceCut = presentationReadSourceCut(
                liveSource = AgentLiveSourceState.CONNECTED,
                currentSourceAttested = true,
            ),
        )
        val readPage = AgentTranscriptLifecycleReadState.Page(
            revision = revision,
            items = listOf(transcript, lifecycle),
            nextCursor = AgentTranscriptLifecycleReadCursor(
                revision,
                "2",
                AgentTranscriptLifecycleReadRecordKind.LIFECYCLE,
                "event-waiting",
            ),
            endReached = true,
        )

        val presentation = AgentTranscriptLifecyclePresentationMapper.map(readPage)
            as AgentTranscriptLifecyclePresentation.Page
        val presentedTranscript = presentation.items[0]
            as AgentTranscriptLifecyclePresentationItem.Transcript
        val presentedLifecycle = presentation.items[1]
            as AgentTranscriptLifecyclePresentationItem.Lifecycle

        assertEquals("command-delivery-owned-elsewhere", presentedTranscript.commandCorrelationId)
        assertEquals(AgentTranscriptEntryContent.Visible("hello"), presentedTranscript.content)
        assertEquals(AgentLifecycleState.WAITING_FOR_USER, presentedLifecycle.state)
        assertEquals("event-waiting", presentedLifecycle.lifecycleEventId)

        assertSame(
            AgentTranscriptLifecyclePresentation.Unavailable,
            AgentTranscriptLifecyclePresentationMapper.map(
                AgentTranscriptLifecycleReadState.Unavailable(
                    AgentTranscriptLifecycleReadUnavailableReason.LINEAGE_NOT_ACTIVE,
                ),
            ),
        )
    }

    @Test
    fun rowProjectionOnlyMarksAttestedConnectedExactSourceCurrent() {
        data class Case(
            val label: String,
            val sourceCut: AgentTranscriptLifecycleReadSourceCut.Available,
            val lifecycleSourceEpoch: String,
            val expectedCurrent: Boolean,
        )

        val cases = listOf(
            Case(
                label = "connected exact",
                sourceCut = presentationReadSourceCut(
                    liveSource = AgentLiveSourceState.CONNECTED,
                    currentSourceAttested = true,
                ),
                lifecycleSourceEpoch = "source-read",
                expectedCurrent = true,
            ),
            Case(
                label = "old source",
                sourceCut = presentationReadSourceCut(
                    liveSource = AgentLiveSourceState.CONNECTED,
                    currentSourceAttested = true,
                ),
                lifecycleSourceEpoch = "source-old",
                expectedCurrent = false,
            ),
            Case(
                label = "interrupted source",
                sourceCut = presentationReadSourceCut(
                    liveSource = AgentLiveSourceState.INTERRUPTED,
                    currentSourceAttested = true,
                ),
                lifecycleSourceEpoch = "source-read",
                expectedCurrent = false,
            ),
            Case(
                label = "status refresh unattested",
                sourceCut = presentationReadSourceCut(
                    liveSource = AgentLiveSourceState.CONNECTED,
                    currentSourceAttested = false,
                ),
                lifecycleSourceEpoch = "source-read",
                expectedCurrent = false,
            ),
        )

        cases.forEach { case ->
            val namespace = presentationReadNamespace()
            val revision = AgentTranscriptLifecycleReadRevision(
                namespace = namespace,
                parentPayloadSha256 = "b".repeat(64),
                localGeneration = "2",
                materializedThroughAgentSeq = "1",
                sourceCut = case.sourceCut,
            )
            val lifecycle = AgentTranscriptLifecycleReadItem.LifecycleEvidence(
                AgentLifecycleRecord(
                    lifecycleEventId = "event-${case.label}",
                    sourceEpoch = case.lifecycleSourceEpoch,
                    identity = AgentLifecycleIdentity(
                        AgentLifecycleScope.RUN,
                        "run-${case.label}",
                        null,
                    ),
                    state = AgentLifecycleState.RUNNING,
                    failure = null,
                    occurredAtMs = 1,
                    agentEventSeq = "1",
                ),
            )
            val presentation = AgentTranscriptLifecyclePresentationMapper.map(
                AgentTranscriptLifecycleReadState.Page(
                    revision = revision,
                    items = listOf(lifecycle),
                    nextCursor = null,
                    endReached = true,
                ),
            ) as AgentTranscriptLifecyclePresentation.Page
            val presented = presentation.items.single()
                as AgentTranscriptLifecyclePresentationItem.Lifecycle

            assertEquals(case.label, case.expectedCurrent, presented.isCurrentSource)
        }
    }
}

private fun presentationReadNamespace(): AgentTranscriptLifecycleDurableNamespace =
    AgentTranscriptLifecycleDurableNamespace(
        AgentTranscriptLifecycleDurableConsumerIdentity(
            profileId = "profile-read-presentation",
            profileActivationGeneration = 1,
            principalId = "principal-read-presentation",
            clientInstanceId = "client-read-presentation",
            hostId = "host-read-presentation",
            hostEpoch = "host-epoch-read-presentation",
            scopeId = "scope-read-presentation",
            sessionId = "session-read-presentation",
        ),
        timelineEpoch = "timeline-read-presentation",
    )

private fun presentationReadSourceCut(
    liveSource: AgentLiveSourceState,
    currentSourceAttested: Boolean,
) = AgentTranscriptLifecycleReadSourceCut.Available(
    liveSource = liveSource,
    activeSourceEpoch = "source-read",
    currentSourceAttested = currentSourceAttested,
)
