package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentTranscriptLifecyclePresentationTest {
    @Test
    fun lifecycleAndNotificationPresentationIsCapabilityAndLineageFenced() {
        val state = presentationState()
        val capability = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY)
        val activeLineage = AgentTimelineLineage(
            state.identity,
            requireNotNull(state.extensionLane.timelineEpoch),
        )
        fun present(
            source: AgentTranscriptLifecycleClientState = state,
            capabilities: Set<String> = capability,
            lineage: AgentTimelineLineage? = activeLineage,
            selected: AgentExtensionSessionIdentity? = source.identity,
        ): AgentLifecycleNotificationPresentation =
            AgentLifecycleNotificationPresentationMapper.map(
                source,
                capabilities,
                lineage,
                selected,
            )

        val otherSession = state.identity.copy(sessionId = "session-other")
        listOf(
            present(capabilities = emptySet()),
            present(lineage = null),
            present(lineage = activeLineage.copy(timelineEpoch = "timeline-other")),
            present(selected = otherSession),
            present(lineage = AgentTimelineLineage(otherSession, activeLineage.timelineEpoch)),
            present(source = state.copy(
                extensionLane = state.extensionLane.copy(syncState = AgentTimelineSyncState.Snapshot),
            )),
        ).forEach { presentation ->
            assertSame(AgentLifecycleNotificationPresentation.Unavailable, presentation)
        }

        val available = present() as AgentLifecycleNotificationPresentation.Available
        assertEquals(
            listOf("run-a", "run-b", "run-c"),
            available.runLifecycles.map { it.identity.runId },
        )
        assertEquals(
            listOf(
                AgentLifecycleState.WAITING_FOR_USER,
                AgentLifecycleState.FAILED,
                AgentLifecycleState.COMPLETED,
            ),
            available.runLifecycles.map(AgentLifecyclePresentation::state),
        )
        assertEquals(
            listOf(AgentLifecycleIdentity(AgentLifecycleScope.TURN, "run-a", "turn-a")),
            available.turnLifecycles.map(AgentLifecyclePresentation::identity),
        )
        assertEquals(
            AgentLifecycleState.WAITING_FOR_USER,
            available.turnLifecycles.single().state,
        )
        assertTrue(
            (available.runLifecycles + available.turnLifecycles)
                .all(AgentLifecyclePresentation::isCurrentSource),
        )

        val preflightCandidateEventIds = available.preflightNotificationCandidates.map {
            it.systemIntent.dedupeKey.lifecycleEventId
        }
        assertEquals(listOf("event-turn-a-waiting"), preflightCandidateEventIds)
        assertTrue(available.preflightNotificationCandidates.single()
            .systemIntent.isPreflightAuthorizedBy(state))
        assertFalse(
            "reducer suppression must not be restored after config changes",
            "event-run-c-completed" in preflightCandidateEventIds,
        )

        val interruptedState = state.copy(
            extensionLane = state.extensionLane.copy(liveSource = AgentLiveSourceState.INTERRUPTED),
        )
        val interrupted = present(
            source = interruptedState,
        ) as AgentLifecycleNotificationPresentation.Available
        assertTrue(
            (interrupted.runLifecycles + interrupted.turnLifecycles)
                .none(AgentLifecyclePresentation::isCurrentSource),
        )
        assertTrue(interrupted.preflightNotificationCandidates.isEmpty())
    }
}

private fun presentationState(): AgentTranscriptLifecycleClientState {
    val identity = AgentExtensionSessionIdentity(
        "profile-presentation",
        "host-presentation",
        "host-epoch-presentation",
        "scope-presentation",
        "session-presentation",
    )
    val records = listOf(
        presentationRecord(
            "event-run-c-completed",
            "1",
            AgentLifecycleScope.RUN,
            "run-c",
            AgentLifecycleState.COMPLETED,
        ),
        presentationRecord(
            "event-turn-a-waiting",
            "3",
            AgentLifecycleScope.TURN,
            "run-a",
            AgentLifecycleState.WAITING_FOR_USER,
            "turn-a",
        ),
        presentationRecord(
            "event-run-b-failed",
            "4",
            AgentLifecycleScope.RUN,
            "run-b",
            AgentLifecycleState.FAILED,
        ),
        presentationRecord(
            "event-run-a-waiting",
            "2",
            AgentLifecycleScope.RUN,
            "run-a",
            AgentLifecycleState.WAITING_FOR_USER,
        ),
    ).associateByTo(linkedMapOf(), AgentLifecycleRecord::identity)
    val witnesses = records.values.associate { record ->
        record.lifecycleEventId to record.presentationWitness()
    }
    val timelineEpoch = "timeline-presentation"
    val notifications = listOf(
        presentationNotification(
            identity,
            timelineEpoch,
            records.getValue(AgentLifecycleIdentity(
                AgentLifecycleScope.TURN,
                "run-a",
                "turn-a",
            )),
            witnesses,
            AgentNotificationDisposition.SHOWN,
            "7",
        ),
        presentationNotification(
            identity,
            timelineEpoch,
            records.getValue(AgentLifecycleIdentity(
                AgentLifecycleScope.RUN,
                "run-c",
                null,
            )),
            witnesses,
            AgentNotificationDisposition.SUPPRESSED_PERMISSION,
            "6",
        ),
    ).toMap(linkedMapOf())
    return AgentTranscriptLifecycleClientState(
        identity = identity,
        extensionLane = AgentTranscriptLifecycleExtensionState(
            localGeneration = "7",
            support = AgentExtensionSupport.AVAILABLE,
            unavailableReason = null,
            liveSource = AgentLiveSourceState.CONNECTED,
            activeSourceEpoch = PRESENTATION_SOURCE_EPOCH,
            timelineEpoch = timelineEpoch,
            lastAgentSeq = "4",
            effectiveHostLimits = presentationHostLimits(),
            syncState = AgentTimelineSyncState.Current,
            notificationBaselineAgentSeq = "0",
            lifecycleByIdentity = records,
            currentLifecycleIdentityByEventId = records.entries.associate { (key, record) ->
                record.lifecycleEventId to key
            },
            runsWithTurnRecords = setOf("run-a"),
            eventWitnessById = witnesses,
            eventIdBySeq = records.values.associate { it.agentEventSeq to it.lifecycleEventId },
            notificationLedger = notifications,
            notificationKeyByLifecycleEventId = notifications.keys.associateBy {
                it.lifecycleEventId
            },
        ),
        notificationConfig = AgentNotificationConfig(
            permission = AgentNotificationPermission.GRANTED,
            profileActive = true,
            policy = AgentNotificationPolicy.ALLOW,
        ),
    )
}

private fun presentationRecord(
    eventId: String,
    sequence: String,
    scope: AgentLifecycleScope,
    runId: String,
    state: AgentLifecycleState,
    turnId: String? = null,
): AgentLifecycleRecord = AgentLifecycleRecord(
    lifecycleEventId = eventId,
    sourceEpoch = PRESENTATION_SOURCE_EPOCH,
    identity = AgentLifecycleIdentity(scope, runId, turnId),
    state = state,
    failure = if (state == AgentLifecycleState.FAILED) {
        AgentLifecycleFailure("presentation_failure", "presentation failure")
    } else {
        null
    },
    occurredAtMs = sequence.toLong(),
    agentEventSeq = sequence,
)

private fun AgentLifecycleRecord.presentationWitness(): AgentLifecycleEventIdentityWitness =
    AgentLifecycleEventIdentityWitness(
        eventId = lifecycleEventId,
        agentEventSeq = agentEventSeq,
        lifecycleIdentity = identity,
        sourceEpoch = sourceEpoch,
        state = state,
        failure = failure,
        occurredAtMs = occurredAtMs,
        closedEventDigest = null,
    )

private fun presentationNotification(
    session: AgentExtensionSessionIdentity,
    timelineEpoch: String,
    record: AgentLifecycleRecord,
    witnesses: Map<String, AgentLifecycleEventIdentityWitness>,
    disposition: AgentNotificationDisposition,
    localGeneration: String,
): Pair<AgentNotificationDedupeKey, AgentNotificationLedgerEntry> {
    val key = AgentNotificationDedupeKey(
        session.profileId,
        session.hostId,
        session.hostEpoch,
        session.scopeId,
        session.sessionId,
        timelineEpoch,
        record.lifecycleEventId,
        record.state,
    )
    return key to AgentNotificationLedgerEntry(
        disposition,
        witnesses.getValue(record.lifecycleEventId),
        localGeneration,
    )
}

private const val PRESENTATION_SOURCE_EPOCH = "source-presentation"

private fun presentationHostLimits(): AgentTimelineEffectiveLimits = AgentTimelineEffectiveLimits(
    maxTextUtf8Bytes = 65_536,
    maxPageRecords = 256,
    eventReplayRetentionMs = 604_800_000,
    snapshotLeaseMs = 300_000,
)
