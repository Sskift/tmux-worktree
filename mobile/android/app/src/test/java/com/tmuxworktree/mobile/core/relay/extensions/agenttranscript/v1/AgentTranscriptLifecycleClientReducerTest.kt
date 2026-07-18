package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private data class FixtureReduction(
    val state: AgentTranscriptLifecycleClientState,
    val disposition: String,
    val notificationDecisions: List<AgentNotificationDecision>,
)

class AgentTranscriptLifecycleClientReducerTest {
    @Test
    fun androidReducerConsumesEverySharedClientMachineStep() {
        val cases = readClientMachineCases()
        assertTrue("shared client machine fixture must not be empty", cases.isNotEmpty())

        cases.forEach { fixtureCase ->
            val caseName = fixtureCase.string("name")
            var state = fixtureCase.map("initial").toInitialState()
            val baseCommandStates = fixtureCase.map("initial").map("commandStates")
                .mapValuesTo(linkedMapOf()) { (_, value) -> value.asString() }
            fixtureCase.list("steps").forEachIndexed { stepIndex, rawStep ->
                val step = rawStep.asMap()
                val rawInput = step.map("input")
                state = prepareFixtureStateForInput(state, rawInput)
                val label = "$caseName step ${stepIndex + 1}"
                val commandId = rawInput.optionalString("commandId")
                val input: AgentTranscriptLifecycleClientInput?
                val reduction: FixtureReduction
                if (rawInput.string("kind") == "command_status") {
                    // Base-owner composition stub: command state is intentionally absent from src/main.
                    input = null
                    baseCommandStates[rawInput.string("commandId")] = rawInput.string("state")
                    reduction = FixtureReduction(state, "command_applied", emptyList())
                } else {
                    input = rawInput.toClientInput(state)
                    val firstReduction = AgentTranscriptLifecycleClientReducer.reduce(state, input)
                    val extensionReduction = if (
                        input is AgentTranscriptLifecycleClientInput.SnapshotRequestStarted
                    ) {
                        AgentTranscriptLifecycleClientReducer.reduce(
                            firstReduction.state,
                            AgentTranscriptLifecycleClientInput.SnapshotPageZeroAccepted(
                                requireNotNull(
                                    firstReduction.state.extensionLane.pendingSnapshotRequest,
                                ),
                            ),
                        )
                    } else {
                        firstReduction
                    }
                    reduction = FixtureReduction(
                        extensionReduction.state,
                        extensionReduction.disposition.toFixtureDisposition(),
                        extensionReduction.notificationDecisions,
                    )
                }

                assertEveryExpectation(
                    label,
                    step.map("expect"),
                    input,
                    reduction,
                    baseCommandStates,
                    commandId,
                )
                assertAppliedLifecycleIdentityIsPreserved(label, input, reduction)
                state = reduction.state
            }
        }
    }

    @Test
    fun canonicalUint64LineageAndPersistedDigestFenceContinuity() {
        val unnegotiated = AgentTranscriptLifecycleClientState(identity = SESSION_IDENTITY)
        val unnegotiatedEvent = lifecycleEvent(
            timelineEpoch = "timeline-unnegotiated",
            sequence = "1",
            eventId = "unnegotiated-event",
            scope = AgentLifecycleScope.RUN,
            runId = "run-unnegotiated",
            state = AgentLifecycleState.RUNNING,
            fingerprint = "closed-event-unnegotiated",
        )
        val rejected = AgentTranscriptLifecycleClientReducer.reduce(unnegotiated, unnegotiatedEvent)
        assertEquals(AgentClientDisposition.EXTENSION_NOT_ACTIVE, rejected.disposition)
        assertEquals(unnegotiated, rejected.state)

        val signedLongOverflow = "9223372036854775808"
        val runIdentity = AgentLifecycleIdentity(AgentLifecycleScope.RUN, "run-large", null)
        val currentRun = AgentLifecycleRecord(
            lifecycleEventId = "event-large-current",
            sourceEpoch = "source-large",
            identity = runIdentity,
            state = AgentLifecycleState.RUNNING,
            failure = null,
            occurredAtMs = 0,
            agentEventSeq = signedLongOverflow,
        )
        val initial = AgentTranscriptLifecycleClientState(
            identity = SESSION_IDENTITY,
            extensionLane = AgentTranscriptLifecycleExtensionState(
                support = AgentExtensionSupport.AVAILABLE,
                unavailableReason = null,
                liveSource = AgentLiveSourceState.CONNECTED,
                activeSourceEpoch = "source-large",
                timelineEpoch = "timeline-large",
                lastAgentSeq = signedLongOverflow,
                effectiveHostLimits = productionHostLimits(),
                notificationBaselineAgentSeq = signedLongOverflow,
                lifecycleByIdentity = mapOf(runIdentity to currentRun),
                currentLifecycleIdentityByEventId = mapOf(currentRun.lifecycleEventId to runIdentity),
                eventWitnessById = mapOf(
                    currentRun.lifecycleEventId to currentRun.toEventIdentityWitness(),
                ),
                eventIdBySeq = mapOf(signedLongOverflow to currentRun.lifecycleEventId),
            ),
        )
        val nextSequence = "9223372036854775809"
        val next = lifecycleEvent(
            timelineEpoch = "timeline-large",
            sequence = nextSequence,
            eventId = "event-large-next",
            scope = AgentLifecycleScope.RUN,
            runId = "run-large",
            state = AgentLifecycleState.WAITING_FOR_USER,
            fingerprint = "closed-event-large-next",
            sourceEpoch = "source-large",
        )
        val applied = AgentTranscriptLifecycleClientReducer.reduce(initial, next)
        assertEquals(AgentClientDisposition.APPLIED, applied.disposition)
        assertEquals(nextSequence, applied.state.extensionLane.lastAgentSeq)

        val changedContentAtSameIdentity = AgentTranscriptLifecycleClientReducer.reduce(
            applied.state,
            next.copy(closedEventDigest = digestOf("closed-event-large-next-mutated")),
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, changedContentAtSameIdentity.disposition)
        assertEquals(nextSequence, changedContentAtSameIdentity.state.extensionLane.lastAgentSeq)
        assertTrue(changedContentAtSameIdentity.state.extensionLane.requiresSnapshot)

        val olderWithoutEvidence = lifecycleEvent(
            timelineEpoch = "timeline-large",
            sequence = signedLongOverflow,
            eventId = "event-old-without-evidence",
            scope = AgentLifecycleScope.RUN,
            runId = "run-large",
            state = AgentLifecycleState.RUNNING,
            fingerprint = "closed-event-old-without-evidence",
            sourceEpoch = "source-large",
        )
        val expiredEvidence = AgentTranscriptLifecycleClientReducer.reduce(
            applied.state,
            olderWithoutEvidence,
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, expiredEvidence.disposition)

        val wrongHostLineage = next.copy(
            lineage = AgentTimelineLineage(
                SESSION_IDENTITY.copy(hostEpoch = "other-host-epoch"),
                "timeline-large",
            ),
            agentEventSeq = "9223372036854775810",
            eventId = "event-wrong-lineage",
            closedEventDigest = digestOf("closed-event-wrong-lineage"),
            mutation = AgentTimelineMutation.Lifecycle(
                currentRun.copy(
                    lifecycleEventId = "event-wrong-lineage",
                    state = AgentLifecycleState.COMPLETED,
                    agentEventSeq = "9223372036854775810",
                ),
            ),
        )
        val lineageRejected = AgentTranscriptLifecycleClientReducer.reduce(applied.state, wrongHostLineage)
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, lineageRejected.disposition)
        assertEquals(nextSequence, lineageRejected.state.extensionLane.lastAgentSeq)

        val differentTimeline = wrongHostLineage.copy(
            lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-unexpected"),
        )
        val timelineResync = AgentTranscriptLifecycleClientReducer.reduce(applied.state, differentTimeline)
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, timelineResync.disposition)
        assertEquals(AgentExtensionSupport.AVAILABLE, timelineResync.state.extensionLane.support)
        assertEquals("timeline-large", timelineResync.state.extensionLane.timelineEpoch)
        assertEquals(nextSequence, timelineResync.state.extensionLane.lastAgentSeq)
        assertFalse(timelineResync.state.extensionLane.requiresSnapshot)
    }

    @Test
    fun liveAndReplayProvenanceFenceCurrentSourceWithoutDroppingHistoricalReplay() {
        val interruptedBase = availableState("timeline-interrupted-live", baseline = "0")
        val interruptedState = interruptedBase.copy(
            extensionLane = interruptedBase.extensionLane.copy(
                liveSource = AgentLiveSourceState.INTERRUPTED,
            ),
        )
        val interruptedLive = AgentTranscriptLifecycleClientReducer.reduce(
            interruptedState,
            lifecycleEvent(
                "timeline-interrupted-live",
                "1",
                "event-interrupted-live",
                AgentLifecycleScope.RUN,
                "run-interrupted-live",
                AgentLifecycleState.RUNNING,
                "closed-interrupted-live",
            ),
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, interruptedLive.disposition)
        assertEquals("0", interruptedLive.state.extensionLane.lastAgentSeq)
        assertTrue(interruptedLive.state.extensionLane.requiresSnapshot)

        val staleSourceLive = AgentTranscriptLifecycleClientReducer.reduce(
            availableState("timeline-stale-live", baseline = "0"),
            lifecycleEvent(
                "timeline-stale-live",
                "1",
                "event-stale-live",
                AgentLifecycleScope.RUN,
                "run-stale-live",
                AgentLifecycleState.RUNNING,
                "closed-stale-live",
                sourceEpoch = "source-before-active",
            ),
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, staleSourceLive.disposition)
        assertEquals("0", staleSourceLive.state.extensionLane.lastAgentSeq)

        val replayRunning = lifecycleEvent(
            "timeline-old-source-replay",
            "1",
            "event-old-source-running",
            AgentLifecycleScope.RUN,
            "run-old-source-replay",
            AgentLifecycleState.RUNNING,
            "closed-old-source-running",
            sourceEpoch = "source-before-active",
            provenance = AgentEventProvenance.REPLAY,
        )
        val replayedRunning = AgentTranscriptLifecycleClientReducer.reduce(
            replayRequestAccepted(
                availableState("timeline-old-source-replay", baseline = "0"),
                "replay-old-source",
                observedCurrentAgentSeq = "2",
            ),
            replayRunning,
        )
        assertEquals(AgentClientDisposition.APPLIED, replayedRunning.disposition)
        assertTrue(replayedRunning.notificationDecisions.isEmpty())
        val replayCompleted = lifecycleEvent(
            "timeline-old-source-replay",
            "2",
            "event-old-source-completed",
            AgentLifecycleScope.RUN,
            "run-old-source-replay",
            AgentLifecycleState.COMPLETED,
            "closed-old-source-completed",
            sourceEpoch = "source-before-active",
            provenance = AgentEventProvenance.REPLAY,
        )
        val replayedCompleted = AgentTranscriptLifecycleClientReducer.reduce(
            replayedRunning.state,
            replayCompleted,
        )
        assertEquals(AgentClientDisposition.APPLIED, replayedCompleted.disposition)
        assertTrue("old-source replay must not notify", replayedCompleted.notificationDecisions.isEmpty())
        assertEquals(
            "source-before-active",
            replayedCompleted.state.extensionLane.lifecycleByIdentity[
                replayCompleted.record.identity
            ]?.sourceEpoch,
        )
        assertNull(
            "old-source replay is materialized history, not current source state",
            replayedCompleted.state.extensionLane.currentSourceLifecycleOrNull(
                replayCompleted.record.identity,
            ),
        )
        val exactDuplicateArrivingOnLivePath = AgentTranscriptLifecycleClientReducer.reduce(
            replayedCompleted.state,
            replayCompleted.copy(provenance = AgentEventProvenance.LIVE),
        )
        assertEquals(AgentClientDisposition.DUPLICATE, exactDuplicateArrivingOnLivePath.disposition)
        assertEquals(replayedCompleted.state, exactDuplicateArrivingOnLivePath.state)
    }

    @Test
    fun resyncSnapshotPreservesBaselineAppliesFallbackPolicyAndResetFence() {
        val staleIdentity = AgentLifecycleIdentity(AgentLifecycleScope.RUN, "run-stale", null)
        val initial = AgentTranscriptLifecycleClientState(
            identity = SESSION_IDENTITY,
            extensionLane = AgentTranscriptLifecycleExtensionState(
                support = AgentExtensionSupport.AVAILABLE,
                unavailableReason = null,
                liveSource = AgentLiveSourceState.CONNECTED,
                activeSourceEpoch = "source-test",
                timelineEpoch = "timeline-resync",
                lastAgentSeq = "1",
                effectiveHostLimits = productionHostLimits(),
                notificationBaselineAgentSeq = "1",
                lifecycleByIdentity = mapOf(
                    staleIdentity to lifecycleRecord(
                        eventId = "event-stale",
                        sequence = "1",
                        scope = AgentLifecycleScope.RUN,
                        runId = "run-stale",
                        state = AgentLifecycleState.RUNNING,
                    ),
                ),
                currentLifecycleIdentityByEventId = mapOf("event-stale" to staleIdentity),
                appliedEventsBySeq = mapOf(
                    "1" to AgentAppliedEventEvidence("event-stale", digestOf("closed-event-stale")),
                ),
                eventWitnessById = mapOf(
                    "event-stale" to lifecycleRecord(
                        eventId = "event-stale",
                        sequence = "1",
                        scope = AgentLifecycleScope.RUN,
                        runId = "run-stale",
                        state = AgentLifecycleState.RUNNING,
                    ).toEventIdentityWitness(digestOf("closed-event-stale")),
                ),
                eventIdBySeq = mapOf("1" to "event-stale"),
            ),
            notificationConfig = AgentNotificationConfig(
                permission = AgentNotificationPermission.GRANTED,
                profileActive = true,
            ),
        )
        val snapshotRequested = snapshotRequestAccepted(initial, "snapshot-resync")
        val snapshot = AgentTranscriptLifecycleClientInput.SnapshotCommit(
            lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-resync"),
            localGeneration = "0",
            throughAgentSeq = "4",
            records = listOf(
                lifecycleRecord(
                    eventId = "event-run-fallback",
                    sequence = "2",
                    scope = AgentLifecycleScope.RUN,
                    runId = "run-fallback",
                    state = AgentLifecycleState.COMPLETED,
                ),
                lifecycleRecord(
                    eventId = "event-run-with-turn",
                    sequence = "3",
                    scope = AgentLifecycleScope.RUN,
                    runId = "run-with-turn",
                    state = AgentLifecycleState.COMPLETED,
                ),
                lifecycleRecord(
                    eventId = "event-turn-completed",
                    sequence = "4",
                    scope = AgentLifecycleScope.TURN,
                    runId = "run-with-turn",
                    turnId = "turn-completed",
                    state = AgentLifecycleState.COMPLETED,
                ),
            ),
        )
        val resynced = AgentTranscriptLifecycleClientReducer.reduce(snapshotRequested, snapshot)
        assertEquals(AgentClientDisposition.SNAPSHOT_APPLIED, resynced.disposition)
        assertEquals("1", resynced.state.extensionLane.notificationBaselineAgentSeq)
        assertFalse(resynced.state.extensionLane.lifecycleByIdentity.containsKey(staleIdentity))
        assertTrue(resynced.state.extensionLane.appliedEventsBySeq.isEmpty())
        assertEquals("4", resynced.state.extensionLane.snapshotCheckpoint?.throughAgentSeq)
        assertEquals(
            setOf("event-run-fallback", "event-turn-completed"),
            resynced.notificationDecisions.map { it.dedupeKey.lifecycleEventId }.toSet(),
        )
        assertTrue(resynced.notificationDecisions.all {
            it.disposition == AgentNotificationDisposition.SHOWN &&
                requireNotNull(it.systemNotificationIntent).isPreflightAuthorizedBy(resynced.state)
        })

        val policySuppressedState = AgentTranscriptLifecycleClientReducer.reduce(
            resynced.state,
            AgentTranscriptLifecycleClientInput.ClientConfigChanged(
                resynced.state.notificationConfig.copy(policy = AgentNotificationPolicy.SUPPRESS),
            ),
        ).state
        val priorIntents = resynced.notificationDecisions.mapNotNull {
            it.systemNotificationIntent
        }
        assertTrue(priorIntents.none { it.isPreflightAuthorizedBy(policySuppressedState) })
        val reenabledState = AgentTranscriptLifecycleClientReducer.reduce(
            policySuppressedState,
            AgentTranscriptLifecycleClientInput.ClientConfigChanged(
                policySuppressedState.notificationConfig.copy(policy = AgentNotificationPolicy.ALLOW),
            ),
        ).state
        assertTrue("config toggles cannot reauthorize queued intents", priorIntents.none {
            it.isPreflightAuthorizedBy(reenabledState)
        })
        val running = AgentTranscriptLifecycleClientReducer.reduce(
            policySuppressedState,
            lifecycleEvent(
                timelineEpoch = "timeline-resync",
                sequence = "5",
                eventId = "event-policy-running",
                scope = AgentLifecycleScope.RUN,
                runId = "run-policy",
                state = AgentLifecycleState.RUNNING,
                fingerprint = "closed-event-policy-running",
            ),
        )
        assertTrue(running.notificationDecisions.isEmpty())
        val policyFailed = AgentTranscriptLifecycleClientReducer.reduce(
            running.state,
            lifecycleEvent(
                timelineEpoch = "timeline-resync",
                sequence = "6",
                eventId = "event-policy-failed",
                scope = AgentLifecycleScope.RUN,
                runId = "run-policy",
                state = AgentLifecycleState.FAILED,
                fingerprint = "closed-event-policy-failed",
            ),
        )
        assertEquals(
            AgentNotificationDisposition.SUPPRESSED_POLICY,
            policyFailed.notificationDecisions.single().disposition,
        )
        assertNull(policyFailed.notificationDecisions.single().systemNotificationIntent)

        val reset = AgentTranscriptLifecycleClientReducer.reduce(
            policyFailed.state,
            AgentTranscriptLifecycleClientInput.TimelineReset(
                sessionIdentity = SESSION_IDENTITY,
                previousTimelineEpoch = "timeline-resync",
                newTimelineEpoch = "timeline-after-reset",
                reason = AgentTimelineResetReason.DELETED,
            ),
        )
        assertTrue(reset.state.extensionLane.lifecycleByIdentity.isEmpty())
        assertTrue(reset.state.extensionLane.notificationLedger.isEmpty())
        assertNull(reset.state.extensionLane.notificationBaselineAgentSeq)
        assertTrue(priorIntents.none { it.isPreflightAuthorizedBy(reset.state) })
    }

    @Test
    fun resyncSnapshotRetainsNotificationDispositionWithoutReplayingShownIntent() {
        val initial = availableState("timeline-notification-resnapshot", baseline = null)
        val initialRequest = snapshotRequestAccepted(
            initial,
            "snapshot-notification-initial",
        )
        val running = lifecycleRecord(
            "event-notification-running",
            "1",
            AgentLifecycleScope.TURN,
            "run-notification-resnapshot",
            AgentLifecycleState.RUNNING,
            turnId = "turn-notification-resnapshot",
        )
        val initialSnapshot = AgentTranscriptLifecycleClientReducer.reduce(
            initialRequest,
            AgentTranscriptLifecycleClientInput.SnapshotCommit(
                AgentTimelineLineage(SESSION_IDENTITY, "timeline-notification-resnapshot"),
                "0",
                "1",
                listOf(running),
            ),
        )
        assertTrue(initialSnapshot.notificationDecisions.isEmpty())
        val waitingEvent = lifecycleEvent(
            "timeline-notification-resnapshot",
            "2",
            "event-notification-waiting",
            AgentLifecycleScope.TURN,
            "run-notification-resnapshot",
            AgentLifecycleState.WAITING_FOR_USER,
            "closed-notification-waiting",
            turnId = "turn-notification-resnapshot",
        )
        val shown = AgentTranscriptLifecycleClientReducer.reduce(initialSnapshot.state, waitingEvent)
        val oldIntent = requireNotNull(shown.notificationDecisions.single().systemNotificationIntent)
        val shownKey = shown.notificationDecisions.single().dedupeKey

        val resnapshotRequest = snapshotRequestAccepted(
            shown.state,
            "snapshot-notification-resync",
        )
        val resnapshot = AgentTranscriptLifecycleClientReducer.reduce(
            resnapshotRequest,
            AgentTranscriptLifecycleClientInput.SnapshotCommit(
                AgentTimelineLineage(SESSION_IDENTITY, "timeline-notification-resnapshot"),
                "1",
                "2",
                listOf(waitingEvent.record),
            ),
        )
        assertEquals(AgentClientDisposition.SNAPSHOT_APPLIED, resnapshot.disposition)
        assertTrue("retained event must not emit a second decision", resnapshot.notificationDecisions.isEmpty())
        assertEquals(setOf(shownKey), resnapshot.state.extensionLane.notificationLedger.keys)
        assertFalse("snapshot generation fences the old intent", oldIntent.isPreflightAuthorizedBy(resnapshot.state))

        val resumed = AgentTranscriptLifecycleClientReducer.reduce(
            resnapshot.state,
            lifecycleEvent(
                "timeline-notification-resnapshot",
                "3",
                "event-notification-resumed",
                AgentLifecycleScope.TURN,
                "run-notification-resnapshot",
                AgentLifecycleState.RUNNING,
                "closed-notification-resumed",
                turnId = "turn-notification-resnapshot",
            ),
        )
        val newlyCompleted = AgentTranscriptLifecycleClientReducer.reduce(
            resumed.state,
            lifecycleEvent(
                "timeline-notification-resnapshot",
                "4",
                "event-notification-completed",
                AgentLifecycleScope.TURN,
                "run-notification-resnapshot",
                AgentLifecycleState.COMPLETED,
                "closed-notification-completed",
                turnId = "turn-notification-resnapshot",
            ),
        )
        assertEquals(AgentClientDisposition.APPLIED, newlyCompleted.disposition)
        assertEquals(1, newlyCompleted.notificationDecisions.size)
        assertTrue(newlyCompleted.notificationDecisions.single().dedupeKey != shownKey)
    }

    @Test
    fun snapshotCheckpointRetainsHistoricalSeenEventBindingAndRejectsReuse() {
        val historicalEvent = lifecycleEvent(
            "timeline-historical-witness",
            "1",
            "event-historical-witness",
            AgentLifecycleScope.RUN,
            "run-historical-witness",
            AgentLifecycleState.RUNNING,
            "closed-historical-witness",
        )
        val applied = AgentTranscriptLifecycleClientReducer.reduce(
            availableState("timeline-historical-witness", baseline = "0"),
            historicalEvent,
        ).state
        val requested = snapshotRequestAccepted(applied, "snapshot-omit-historical")
        val checkpoint = AgentTranscriptLifecycleClientReducer.reduce(
            requested,
            AgentTranscriptLifecycleClientInput.SnapshotCommit(
                AgentTimelineLineage(SESSION_IDENTITY, "timeline-historical-witness"),
                "0",
                "1",
                emptyList(),
            ),
        )
        assertEquals(AgentClientDisposition.SNAPSHOT_APPLIED, checkpoint.disposition)
        assertTrue(checkpoint.state.extensionLane.lifecycleByIdentity.isEmpty())
        assertTrue(checkpoint.state.extensionLane.appliedEventsBySeq.isEmpty())
        assertEquals(
            historicalEvent.record.toEventIdentityWitness(historicalEvent.closedEventDigest),
            checkpoint.state.extensionLane.eventWitnessById[historicalEvent.eventId],
        )
        val reusedId = AgentTranscriptLifecycleClientReducer.reduce(
            checkpoint.state,
            lifecycleEvent(
                "timeline-historical-witness",
                "2",
                historicalEvent.eventId,
                AgentLifecycleScope.RUN,
                "run-reused-historical-id",
                AgentLifecycleState.RUNNING,
                "closed-reused-historical-id",
            ),
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, reusedId.disposition)
        assertEquals("1", reusedId.state.extensionLane.lastAgentSeq)
    }

    @Test
    fun resetRequiresActiveMatchingEpochAndRetiresOldStatusAndIntentGeneration() {
        val reset = AgentTranscriptLifecycleClientInput.TimelineReset(
            sessionIdentity = SESSION_IDENTITY,
            previousTimelineEpoch = "timeline-reset-old",
            newTimelineEpoch = "timeline-reset-new",
            reason = AgentTimelineResetReason.DELETED,
        )
        val unnegotiated = AgentTranscriptLifecycleClientState(identity = SESSION_IDENTITY)
        assertEquals(
            AgentClientDisposition.EXTENSION_NOT_ACTIVE,
            AgentTranscriptLifecycleClientReducer.reduce(unnegotiated, reset).disposition,
        )
        val unavailable = AgentTranscriptLifecycleClientState(
            identity = SESSION_IDENTITY,
            extensionLane = AgentTranscriptLifecycleExtensionState(
                support = AgentExtensionSupport.UNAVAILABLE,
                unavailableReason = AgentExtensionUnavailableReason.STORE_UNAVAILABLE,
            ),
        )
        assertEquals(
            AgentClientDisposition.EXTENSION_NOT_ACTIVE,
            AgentTranscriptLifecycleClientReducer.reduce(unavailable, reset).disposition,
        )

        var active = availableState("timeline-reset-old", baseline = "0")
        active = AgentTranscriptLifecycleClientReducer.reduce(
            active,
            lifecycleEvent(
                timelineEpoch = "timeline-reset-old",
                sequence = "1",
                eventId = "event-reset-running",
                scope = AgentLifecycleScope.RUN,
                runId = "run-reset",
                state = AgentLifecycleState.RUNNING,
                fingerprint = "closed-reset-running",
            ),
        ).state
        val completed = AgentTranscriptLifecycleClientReducer.reduce(
            active,
            lifecycleEvent(
                timelineEpoch = "timeline-reset-old",
                sequence = "2",
                eventId = "event-reset-completed",
                scope = AgentLifecycleScope.RUN,
                runId = "run-reset",
                state = AgentLifecycleState.COMPLETED,
                fingerprint = "closed-reset-completed",
            ),
        )
        val oldIntent = requireNotNull(completed.notificationDecisions.single().systemNotificationIntent)
        val wrongEpoch = AgentTranscriptLifecycleClientReducer.reduce(
            completed.state,
            reset.copy(previousTimelineEpoch = "timeline-other"),
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, wrongEpoch.disposition)
        assertEquals("timeline-reset-old", wrongEpoch.state.extensionLane.timelineEpoch)

        val resetApplied = AgentTranscriptLifecycleClientReducer.reduce(completed.state, reset)
        assertEquals(AgentClientDisposition.TIMELINE_RESET, resetApplied.disposition)
        assertEquals("1", resetApplied.state.extensionLane.localGeneration)
        assertFalse(oldIntent.isPreflightAuthorizedBy(resetApplied.state))
        assertTrue("timeline-reset-old" in resetApplied.state.extensionLane.retiredTimelineEpochs)

        val statusRequested = AgentTranscriptLifecycleClientReducer.reduce(
            resetApplied.state,
            AgentTranscriptLifecycleClientInput.StatusRequestStarted("status-after-reset"),
        ).state
        val lateOldGeneration = AgentTranscriptLifecycleClientReducer.reduce(
            statusRequested,
            AgentTranscriptLifecycleClientInput.StatusAvailable(
                authority = fixtureDurableAuthority(),
                lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-reset-old"),
                requestFence = AgentLocalRequestFence("0", "status-before-reset"),
                liveSource = AgentLiveSourceState.CONNECTED,
                activeSourceEpoch = "source-before-reset",
                currentAgentSeq = "2",
                earliestReplaySeq = "1",
                hostLimits = productionHostLimits(),
            ),
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, lateOldGeneration.disposition)
        assertEquals(statusRequested, lateOldGeneration.state)
        val retiredStatus = AgentTranscriptLifecycleClientReducer.reduce(
            lateOldGeneration.state,
            AgentTranscriptLifecycleClientInput.StatusAvailable(
                authority = fixtureDurableAuthority(),
                lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-reset-old"),
                requestFence = AgentLocalRequestFence("1", "status-after-reset"),
                liveSource = AgentLiveSourceState.CONNECTED,
                activeSourceEpoch = "source-after-reset",
                currentAgentSeq = "2",
                earliestReplaySeq = "1",
                hostLimits = productionHostLimits(),
            ),
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, retiredStatus.disposition)
        assertEquals("timeline-reset-new", retiredStatus.state.extensionLane.timelineEpoch)
        assertFalse(oldIntent.isPreflightAuthorizedBy(retiredStatus.state))
    }

    @Test
    fun snapshotRejectsStaleOrInvalidCommitsAndPreservesEverTurnHistory() {
        val runIdentity = AgentLifecycleIdentity(AgentLifecycleScope.RUN, "run-ever-turn", null)
        val current = lifecycleRecord(
            eventId = "event-ever-current",
            sequence = "5",
            scope = AgentLifecycleScope.RUN,
            runId = "run-ever-turn",
            state = AgentLifecycleState.RUNNING,
            sourceEpoch = "source-ever",
        )
        val initial = availableState(
            timelineEpoch = "timeline-snapshot-safe",
            lastAgentSeq = "5",
            baseline = "2",
            lifecycle = mapOf(runIdentity to current),
            runsWithTurns = setOf("run-ever-turn"),
        )
        val staleRequested = snapshotRequestAccepted(initial, "snapshot-stale")
        val stale = AgentTranscriptLifecycleClientReducer.reduce(
            staleRequested,
            AgentTranscriptLifecycleClientInput.SnapshotCommit(
                lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-snapshot-safe"),
                localGeneration = "0",
                throughAgentSeq = "4",
                records = emptyList(),
            ),
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, stale.disposition)
        assertEquals("5", stale.state.extensionLane.lastAgentSeq)
        assertTrue(stale.state.extensionLane.requiresSnapshot)
        assertTrue(stale.notificationDecisions.isEmpty())

        val freshRequested = snapshotRequestAccepted(
            stale.state.copy(
                extensionLane = stale.state.extensionLane.copy(localGeneration = "1"),
            ),
            "snapshot-fresh",
        )
        val lateOldRequest = AgentTranscriptLifecycleClientReducer.reduce(
            freshRequested,
            AgentTranscriptLifecycleClientInput.SnapshotCommit(
                lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-snapshot-safe"),
                localGeneration = "0",
                throughAgentSeq = "6",
                records = emptyList(),
            ),
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, lateOldRequest.disposition)
        assertEquals(freshRequested, lateOldRequest.state)

        val recovered = AgentTranscriptLifecycleClientReducer.reduce(
            lateOldRequest.state,
            AgentTranscriptLifecycleClientInput.SnapshotCommit(
                lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-snapshot-safe"),
                localGeneration = "1",
                throughAgentSeq = "6",
                records = listOf(
                    lifecycleRecord(
                        eventId = "event-ever-completed",
                        sequence = "6",
                        scope = AgentLifecycleScope.RUN,
                        runId = "run-ever-turn",
                        state = AgentLifecycleState.COMPLETED,
                        sourceEpoch = "source-ever",
                    ),
                ),
            ),
        )
        assertEquals(AgentClientDisposition.SNAPSHOT_APPLIED, recovered.disposition)
        assertEquals("2", recovered.state.extensionLane.notificationBaselineAgentSeq)
        assertTrue("run-ever-turn" in recovered.state.extensionLane.runsWithTurnRecords)
        assertTrue("run fallback must remain suppressed", recovered.notificationDecisions.isEmpty())
        assertFalse(recovered.state.extensionLane.requiresSnapshot)

        val invalidRequested = snapshotRequestAccepted(
            recovered.state,
            "snapshot-invalid-graph",
        )
        val invalidGraph = AgentTranscriptLifecycleClientReducer.reduce(
            invalidRequested,
            AgentTranscriptLifecycleClientInput.SnapshotCommit(
                lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-snapshot-safe"),
                localGeneration = "2",
                throughAgentSeq = "8",
                records = listOf(
                    lifecycleRecord(
                        eventId = "event-graph-run",
                        sequence = "7",
                        scope = AgentLifecycleScope.RUN,
                        runId = "run-graph",
                        state = AgentLifecycleState.RUNNING,
                        sourceEpoch = "source-graph-a",
                    ),
                    lifecycleRecord(
                        eventId = "event-graph-turn",
                        sequence = "8",
                        scope = AgentLifecycleScope.TURN,
                        runId = "run-graph",
                        turnId = "turn-graph",
                        state = AgentLifecycleState.RUNNING,
                        sourceEpoch = "source-graph-b",
                    ),
                ),
            ),
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, invalidGraph.disposition)
        assertEquals("6", invalidGraph.state.extensionLane.lastAgentSeq)
        assertTrue(invalidGraph.state.extensionLane.requiresSnapshot)
    }

    @Test
    fun fixedCapacitySaturationDoesNotAdvanceAndExactDuplicateStillMatches() {
        val duplicate = lifecycleEvent(
            timelineEpoch = "timeline-cap",
            sequence = "1",
            eventId = "event-cap-1",
            scope = AgentLifecycleScope.RUN,
            runId = "run-cap",
            state = AgentLifecycleState.RUNNING,
            fingerprint = "closed-cap-1",
        )
        val identity = duplicate.record.identity
        val base = availableState(
            timelineEpoch = "timeline-cap",
            lastAgentSeq = "1",
            baseline = "1",
            lifecycle = mapOf(identity to duplicate.record),
        )
        val atCapacity = base.copy(
            extensionLane = base.extensionLane.copy(
                appliedEventsBySeq = mapOf(
                    "1" to AgentAppliedEventEvidence("event-cap-1", duplicate.closedEventDigest),
                ),
                eventWitnessById = mapOf(
                    "event-cap-1" to duplicate.record.toEventIdentityWitness(
                        duplicate.closedEventDigest,
                    ),
                ),
                eventIdBySeq = mapOf("1" to "event-cap-1"),
            ),
        )
        val limits = AgentClientReducerLimits(maxAppliedEventEvidence = 1)
        val exact = AgentTranscriptLifecycleClientReducer.reduce(atCapacity, duplicate, limits)
        assertEquals(AgentClientDisposition.DUPLICATE, exact.disposition)
        assertFalse(exact.state.extensionLane.requiresSnapshot)

        val saturated = AgentTranscriptLifecycleClientReducer.reduce(
            exact.state,
            lifecycleEvent(
                timelineEpoch = "timeline-cap",
                sequence = "2",
                eventId = "event-cap-2",
                scope = AgentLifecycleScope.RUN,
                runId = "run-cap",
                state = AgentLifecycleState.WAITING_FOR_USER,
                fingerprint = "closed-cap-2",
            ),
            limits,
        )
        assertEquals(AgentClientDisposition.GAP_RESYNC, saturated.disposition)
        assertEquals("1", saturated.state.extensionLane.lastAgentSeq)
        assertTrue(saturated.state.extensionLane.requiresSnapshot)
        assertEquals(atCapacity.extensionLane.appliedEventsBySeq, saturated.state.extensionLane.appliedEventsBySeq)

        val snapshotRequested = snapshotRequestAccepted(
            saturated.state,
            "snapshot-cap-repair",
            limits,
        )
        val repaired = AgentTranscriptLifecycleClientReducer.reduce(
            snapshotRequested,
            AgentTranscriptLifecycleClientInput.SnapshotCommit(
                lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-cap"),
                localGeneration = "1",
                throughAgentSeq = "1",
                records = listOf(duplicate.record),
            ),
            limits,
        )
        assertEquals(AgentClientDisposition.SNAPSHOT_APPLIED, repaired.disposition)
        assertTrue(repaired.state.extensionLane.appliedEventsBySeq.isEmpty())
        val afterCheckpoint = AgentTranscriptLifecycleClientReducer.reduce(
            repaired.state,
            lifecycleEvent(
                timelineEpoch = "timeline-cap",
                sequence = "2",
                eventId = "event-cap-2",
                scope = AgentLifecycleScope.RUN,
                runId = "run-cap",
                state = AgentLifecycleState.WAITING_FOR_USER,
                fingerprint = "closed-cap-2",
            ),
            limits,
        )
        assertEquals(AgentClientDisposition.APPLIED, afterCheckpoint.disposition)
        assertEquals("2", afterCheckpoint.state.extensionLane.lastAgentSeq)
    }

    @Test
    fun invalidCrossRecordTransitionsAndSnapshotIdentityConflictsFailAtomically() {
        val runWaiting = lifecycleRecord(
            eventId = "event-run-waiting",
            sequence = "1",
            scope = AgentLifecycleScope.RUN,
            runId = "run-cross",
            state = AgentLifecycleState.WAITING_FOR_USER,
        )
        val turnWaiting = lifecycleRecord(
            eventId = "event-turn-waiting",
            sequence = "2",
            scope = AgentLifecycleScope.TURN,
            runId = "run-cross",
            turnId = "turn-cross",
            state = AgentLifecycleState.WAITING_FOR_USER,
        )
        val initial = availableState(
            timelineEpoch = "timeline-cross",
            lastAgentSeq = "2",
            baseline = "2",
            lifecycle = mapOf(runWaiting.identity to runWaiting, turnWaiting.identity to turnWaiting),
        )
        val illegalTurnResume = AgentTranscriptLifecycleClientReducer.reduce(
            initial,
            lifecycleEvent(
                timelineEpoch = "timeline-cross",
                sequence = "3",
                eventId = "event-turn-resume",
                scope = AgentLifecycleScope.TURN,
                runId = "run-cross",
                turnId = "turn-cross",
                state = AgentLifecycleState.RUNNING,
                fingerprint = "closed-turn-resume",
            ),
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, illegalTurnResume.disposition)
        assertEquals("2", illegalTurnResume.state.extensionLane.lastAgentSeq)
        assertEquals(initial.extensionLane.lifecycleByIdentity, illegalTurnResume.state.extensionLane.lifecycleByIdentity)
        assertEquals(initial.extensionLane.notificationLedger, illegalTurnResume.state.extensionLane.notificationLedger)

        val duplicateSeqBase = availableState("timeline-snapshot-seq", baseline = "0")
        val duplicateSeqRequest = snapshotRequestAccepted(
            duplicateSeqBase,
            "snapshot-duplicate-seq",
        )
        val duplicateSeq = AgentTranscriptLifecycleClientReducer.reduce(
            duplicateSeqRequest,
            AgentTranscriptLifecycleClientInput.SnapshotCommit(
                lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-snapshot-seq"),
                localGeneration = "0",
                throughAgentSeq = "1",
                records = listOf(
                    lifecycleRecord("event-seq-a", "1", AgentLifecycleScope.RUN, "run-seq-a", AgentLifecycleState.RUNNING),
                    lifecycleRecord("event-seq-b", "1", AgentLifecycleScope.RUN, "run-seq-b", AgentLifecycleState.RUNNING),
                ),
            ),
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, duplicateSeq.disposition)
        assertEquals("0", duplicateSeq.state.extensionLane.lastAgentSeq)

        val applied = AgentTranscriptLifecycleClientReducer.reduce(
            availableState("timeline-snapshot-bind", baseline = "0"),
            lifecycleEvent(
                timelineEpoch = "timeline-snapshot-bind",
                sequence = "1",
                eventId = "event-bound",
                scope = AgentLifecycleScope.RUN,
                runId = "run-bound",
                state = AgentLifecycleState.RUNNING,
                fingerprint = "closed-bound",
            ),
        ).state
        val bindRequest = snapshotRequestAccepted(applied, "snapshot-rebind")
        val rebound = AgentTranscriptLifecycleClientReducer.reduce(
            bindRequest,
            AgentTranscriptLifecycleClientInput.SnapshotCommit(
                lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-snapshot-bind"),
                localGeneration = "0",
                throughAgentSeq = "2",
                records = listOf(
                    lifecycleRecord("event-bound", "2", AgentLifecycleScope.RUN, "run-other", AgentLifecycleState.RUNNING),
                ),
            ),
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, rebound.disposition)
        assertEquals("1", rebound.state.extensionLane.lastAgentSeq)
        assertEquals("1", rebound.state.extensionLane.eventWitnessById["event-bound"]?.agentEventSeq)
    }

    @Test
    fun temporaryAvailabilityAndSourceChangesPreserveLineageButFenceIntents() {
        var state = availableState("timeline-availability", baseline = "0")
        state = AgentTranscriptLifecycleClientReducer.reduce(
            state,
            lifecycleEvent("timeline-availability", "1", "event-source-run", AgentLifecycleScope.RUN, "run-source", AgentLifecycleState.RUNNING, "closed-source-run"),
        ).state
        val completed = AgentTranscriptLifecycleClientReducer.reduce(
            state,
            lifecycleEvent("timeline-availability", "2", "event-source-done", AgentLifecycleScope.RUN, "run-source", AgentLifecycleState.COMPLETED, "closed-source-done"),
        )
        val oldIntent = requireNotNull(completed.notificationDecisions.single().systemNotificationIntent)
        assertTrue(oldIntent.isPreflightAuthorizedBy(completed.state))
        assertTrue("preflight is deliberately non-consuming", oldIntent.isPreflightAuthorizedBy(completed.state))

        val statusRequest = AgentTranscriptLifecycleClientReducer.reduce(
            completed.state,
            AgentTranscriptLifecycleClientInput.StatusRequestStarted("status-adapter-down"),
        ).state
        val unavailable = AgentTranscriptLifecycleClientReducer.reduce(
            statusRequest,
            AgentTranscriptLifecycleClientInput.StatusUnavailable(
                SESSION_IDENTITY,
                AgentLocalRequestFence("0", "status-adapter-down"),
                AgentExtensionUnavailableReason.ADAPTER_UNAVAILABLE,
            ),
        )
        assertEquals("timeline-availability", unavailable.state.extensionLane.timelineEpoch)
        assertEquals(completed.state.extensionLane.lifecycleByIdentity, unavailable.state.extensionLane.lifecycleByIdentity)
        assertTrue(unavailable.state.extensionLane.retiredTimelineEpochs.isEmpty())
        assertFalse(oldIntent.isPreflightAuthorizedBy(unavailable.state))

        val unnegotiated = AgentTranscriptLifecycleClientReducer.reduce(
            unavailable.state,
            AgentTranscriptLifecycleClientInput.ExtensionNotNegotiated,
        ).state
        assertEquals("timeline-availability", unnegotiated.extensionLane.timelineEpoch)
        val negotiated = AgentTranscriptLifecycleClientReducer.reduce(
            unnegotiated,
            AgentTranscriptLifecycleClientInput.ExtensionNegotiated,
        ).state
        val recoveryRequest = AgentTranscriptLifecycleClientReducer.reduce(
            negotiated,
            AgentTranscriptLifecycleClientInput.StatusRequestStarted("status-recover"),
        ).state
        val recovered = AgentTranscriptLifecycleClientReducer.reduce(
            recoveryRequest,
            AgentTranscriptLifecycleClientInput.StatusAvailable(
                authority = fixtureDurableAuthority(),
                lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-availability"),
                requestFence = AgentLocalRequestFence("3", "status-recover"),
                liveSource = AgentLiveSourceState.CONNECTED,
                activeSourceEpoch = "source-test",
                currentAgentSeq = "2",
                earliestReplaySeq = "1",
                hostLimits = productionHostLimits(),
            ),
        )
        assertEquals(AgentClientDisposition.STATUS_APPLIED, recovered.disposition)
        assertEquals(completed.state.extensionLane.lifecycleByIdentity, recovered.state.extensionLane.lifecycleByIdentity)
        assertTrue(recovered.state.extensionLane.retiredTimelineEpochs.isEmpty())
        assertFalse(oldIntent.isPreflightAuthorizedBy(recovered.state))

        val interruptedRequest = AgentTranscriptLifecycleClientReducer.reduce(
            recovered.state,
            AgentTranscriptLifecycleClientInput.StatusRequestStarted("status-interrupted"),
        ).state
        val interrupted = AgentTranscriptLifecycleClientReducer.reduce(
            interruptedRequest,
            AgentTranscriptLifecycleClientInput.StatusAvailable(
                authority = fixtureDurableAuthority(),
                lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-availability"),
                requestFence = AgentLocalRequestFence("4", "status-interrupted"),
                liveSource = AgentLiveSourceState.INTERRUPTED,
                activeSourceEpoch = "source-test",
                currentAgentSeq = "2",
                earliestReplaySeq = "1",
                hostLimits = productionHostLimits(),
            ),
        )
        assertFalse(oldIntent.isPreflightAuthorizedBy(interrupted.state))
        assertEquals("timeline-availability", interrupted.state.extensionLane.timelineEpoch)

        val storeUnavailableRequest = AgentTranscriptLifecycleClientReducer.reduce(
            interrupted.state,
            AgentTranscriptLifecycleClientInput.StatusRequestStarted("status-store-unavailable"),
        ).state
        val storeUnavailable = AgentTranscriptLifecycleClientReducer.reduce(
            storeUnavailableRequest,
            AgentTranscriptLifecycleClientInput.StatusUnavailable(
                SESSION_IDENTITY,
                AgentLocalRequestFence("5", "status-store-unavailable"),
                AgentExtensionUnavailableReason.STORE_UNAVAILABLE,
            ),
        )
        assertEquals("timeline-availability", storeUnavailable.state.extensionLane.timelineEpoch)
        assertEquals(
            completed.state.extensionLane.lifecycleByIdentity,
            storeUnavailable.state.extensionLane.lifecycleByIdentity,
        )
        assertTrue(storeUnavailable.state.extensionLane.retiredTimelineEpochs.isEmpty())
        val storeRecoveryRequest = AgentTranscriptLifecycleClientReducer.reduce(
            storeUnavailable.state,
            AgentTranscriptLifecycleClientInput.StatusRequestStarted("status-store-recover"),
        ).state
        val storeRecovered = AgentTranscriptLifecycleClientReducer.reduce(
            storeRecoveryRequest,
            AgentTranscriptLifecycleClientInput.StatusAvailable(
                authority = fixtureDurableAuthority(),
                lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-availability"),
                requestFence = AgentLocalRequestFence("6", "status-store-recover"),
                liveSource = AgentLiveSourceState.CONNECTED,
                activeSourceEpoch = "source-test",
                currentAgentSeq = "2",
                earliestReplaySeq = "1",
                hostLimits = productionHostLimits(),
            ),
        )
        assertEquals(AgentClientDisposition.STATUS_APPLIED, storeRecovered.disposition)
        assertEquals(AgentExtensionSupport.AVAILABLE, storeRecovered.state.extensionLane.support)
        assertEquals("timeline-availability", storeRecovered.state.extensionLane.timelineEpoch)
        assertTrue(storeRecovered.state.extensionLane.retiredTimelineEpochs.isEmpty())
    }

    @Test
    fun lifecycleSnapshotNotificationAndRetiredCapacitiesHaveRecoveryPaths() {
        val cases = listOf<Pair<String, () -> Unit>>(
            "lifecycle" to {
                val existing = lifecycleRecord("event-life-1", "1", AgentLifecycleScope.RUN, "run-life-1", AgentLifecycleState.RUNNING)
                val full = availableState("timeline-life-cap", "1", "1", mapOf(existing.identity to existing))
                val limits = AgentClientReducerLimits(maxLifecycleRecords = 1)
                val blocked = AgentTranscriptLifecycleClientReducer.reduce(
                    full,
                    lifecycleEvent("timeline-life-cap", "2", "event-life-2", AgentLifecycleScope.RUN, "run-life-2", AgentLifecycleState.RUNNING, "closed-life-2"),
                    limits,
                )
                assertEquals(AgentClientDisposition.GAP_RESYNC, blocked.disposition)
                assertEquals("1", blocked.state.extensionLane.lastAgentSeq)
                val requested = snapshotRequestAccepted(
                    blocked.state,
                    "snapshot-life-repair",
                    limits,
                )
                val checkpoint = AgentTranscriptLifecycleClientReducer.reduce(
                    requested,
                    AgentTranscriptLifecycleClientInput.SnapshotCommit(
                        AgentTimelineLineage(SESSION_IDENTITY, "timeline-life-cap"),
                        "1",
                        "1",
                        emptyList(),
                    ),
                    limits,
                )
                assertEquals(AgentClientDisposition.SNAPSHOT_APPLIED, checkpoint.disposition)
                assertEquals(
                    AgentClientDisposition.APPLIED,
                    AgentTranscriptLifecycleClientReducer.reduce(
                        checkpoint.state,
                        lifecycleEvent("timeline-life-cap", "2", "event-life-2", AgentLifecycleScope.RUN, "run-life-2", AgentLifecycleState.RUNNING, "closed-life-2"),
                        limits,
                    ).disposition,
                )
            },
            "ever-turn-marker" to {
                val limits = AgentClientReducerLimits(maxEverTurnMarkers = 1)
                var state = availableState("timeline-turn-marker-cap", baseline = "0")
                state = AgentTranscriptLifecycleClientReducer.reduce(
                    state,
                    lifecycleEvent("timeline-turn-marker-cap", "1", "event-marker-run-1", AgentLifecycleScope.RUN, "run-marker-1", AgentLifecycleState.RUNNING, "closed-marker-run-1"),
                    limits,
                ).state
                state = AgentTranscriptLifecycleClientReducer.reduce(
                    state,
                    lifecycleEvent("timeline-turn-marker-cap", "2", "event-marker-turn-1", AgentLifecycleScope.TURN, "run-marker-1", AgentLifecycleState.RUNNING, "closed-marker-turn-1", turnId = "turn-marker-1"),
                    limits,
                ).state
                state = AgentTranscriptLifecycleClientReducer.reduce(
                    state,
                    lifecycleEvent("timeline-turn-marker-cap", "3", "event-marker-run-2", AgentLifecycleScope.RUN, "run-marker-2", AgentLifecycleState.RUNNING, "closed-marker-run-2"),
                    limits,
                ).state
                val blocked = AgentTranscriptLifecycleClientReducer.reduce(
                    state,
                    lifecycleEvent("timeline-turn-marker-cap", "4", "event-marker-turn-2", AgentLifecycleScope.TURN, "run-marker-2", AgentLifecycleState.RUNNING, "closed-marker-turn-2", turnId = "turn-marker-2"),
                    limits,
                )
                assertEquals(AgentClientDisposition.GAP_RESYNC, blocked.disposition)
                assertEquals("3", blocked.state.extensionLane.lastAgentSeq)
                val requested = snapshotRequestAccepted(
                    blocked.state,
                    "snapshot-marker-repair",
                    limits,
                )
                val repaired = AgentTranscriptLifecycleClientReducer.reduce(
                    requested,
                    AgentTranscriptLifecycleClientInput.SnapshotCommit(
                        AgentTimelineLineage(SESSION_IDENTITY, "timeline-turn-marker-cap"),
                        "1",
                        "3",
                        listOf(lifecycleRecord("event-marker-run-2", "3", AgentLifecycleScope.RUN, "run-marker-2", AgentLifecycleState.RUNNING)),
                    ),
                    limits,
                )
                assertEquals(AgentClientDisposition.SNAPSHOT_APPLIED, repaired.disposition)
                assertTrue(repaired.state.extensionLane.runsWithTurnRecords.isEmpty())
                assertEquals(
                    AgentClientDisposition.APPLIED,
                    AgentTranscriptLifecycleClientReducer.reduce(
                        repaired.state,
                        lifecycleEvent("timeline-turn-marker-cap", "4", "event-marker-turn-2", AgentLifecycleScope.TURN, "run-marker-2", AgentLifecycleState.RUNNING, "closed-marker-turn-2", turnId = "turn-marker-2"),
                        limits,
                    ).disposition,
                )
            },
            "event-identity-witness" to {
                val first = lifecycleEvent("timeline-witness-cap", "1", "event-witness-1", AgentLifecycleScope.RUN, "run-witness", AgentLifecycleState.RUNNING, "closed-witness-1")
                val full = AgentTranscriptLifecycleClientReducer.reduce(
                    availableState("timeline-witness-cap", baseline = "0"),
                    first,
                    AgentClientReducerLimits(maxEventIdentityWitnesses = 1),
                ).state
                val limits = AgentClientReducerLimits(maxEventIdentityWitnesses = 1)
                val blocked = AgentTranscriptLifecycleClientReducer.reduce(
                    full,
                    lifecycleEvent("timeline-witness-cap", "2", "event-witness-2", AgentLifecycleScope.RUN, "run-witness", AgentLifecycleState.WAITING_FOR_USER, "closed-witness-2"),
                    limits,
                )
                assertEquals(AgentClientDisposition.GAP_RESYNC, blocked.disposition)
                assertTrue(blocked.state.extensionLane.requiresTimelineRotation)
                assertEquals("1", blocked.state.extensionLane.lastAgentSeq)
                val requested = snapshotRequestAccepted(
                    blocked.state,
                    "snapshot-witness-cannot-forget",
                    limits,
                )
                val refusedSnapshot = AgentTranscriptLifecycleClientReducer.reduce(
                    requested,
                    AgentTranscriptLifecycleClientInput.SnapshotCommit(
                        AgentTimelineLineage(SESSION_IDENTITY, "timeline-witness-cap"),
                        "1",
                        "1",
                        listOf(first.record),
                    ),
                    limits,
                )
                assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, refusedSnapshot.disposition)
                assertEquals(setOf(first.eventId), refusedSnapshot.state.extensionLane.eventWitnessById.keys)
                val reset = AgentTranscriptLifecycleClientReducer.reduce(
                    refusedSnapshot.state,
                    AgentTranscriptLifecycleClientInput.TimelineReset(
                        SESSION_IDENTITY,
                        "timeline-witness-cap",
                        "timeline-witness-rotated",
                        AgentTimelineResetReason.DELETED,
                    ),
                    limits,
                )
                assertEquals(AgentClientDisposition.TIMELINE_RESET, reset.disposition)
                assertTrue(reset.state.extensionLane.eventWitnessById.isEmpty())
                val statusRequested = AgentTranscriptLifecycleClientReducer.reduce(
                    reset.state,
                    AgentTranscriptLifecycleClientInput.StatusRequestStarted("status-witness-rotated"),
                    limits,
                ).state
                val recovered = AgentTranscriptLifecycleClientReducer.reduce(
                    statusRequested,
                    AgentTranscriptLifecycleClientInput.StatusAvailable(
                        authority = fixtureDurableAuthority(),
                        lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-witness-rotated"),
                        requestFence = AgentLocalRequestFence("2", "status-witness-rotated"),
                        liveSource = AgentLiveSourceState.CONNECTED,
                        activeSourceEpoch = "source-test",
                        currentAgentSeq = "1",
                        earliestReplaySeq = "1",
                        hostLimits = productionHostLimits(),
                    ),
                    limits,
                )
                val snapshotReady = snapshotRequestAccepted(
                    recovered.state,
                    "snapshot-witness-rotated",
                    limits,
                )
                val checkpoint = AgentTranscriptLifecycleClientReducer.reduce(
                    snapshotReady,
                    AgentTranscriptLifecycleClientInput.SnapshotCommit(
                        lineage = AgentTimelineLineage(
                            SESSION_IDENTITY,
                            "timeline-witness-rotated",
                        ),
                        localGeneration = snapshotReady.extensionLane.localGeneration,
                        throughAgentSeq = "1",
                        records = emptyList(),
                    ),
                    limits,
                )
                assertEquals(
                    AgentClientDisposition.APPLIED,
                    AgentTranscriptLifecycleClientReducer.reduce(
                        checkpoint.state,
                        lifecycleEvent("timeline-witness-rotated", "2", "event-witness-new-lineage", AgentLifecycleScope.RUN, "run-witness-new", AgentLifecycleState.RUNNING, "closed-witness-new-lineage"),
                        limits,
                    ).disposition,
                )
            },
            "snapshot" to {
                val initial = availableState("timeline-page-cap", baseline = "0")
                val limits = AgentClientReducerLimits(maxSnapshotRecords = 1)
                val requested = snapshotRequestAccepted(
                    initial,
                    "snapshot-too-wide",
                    limits,
                )
                val blocked = AgentTranscriptLifecycleClientReducer.reduce(
                    requested,
                    AgentTranscriptLifecycleClientInput.SnapshotCommit(
                        AgentTimelineLineage(SESSION_IDENTITY, "timeline-page-cap"),
                        "0",
                        "2",
                        listOf(
                            lifecycleRecord("event-page-1", "1", AgentLifecycleScope.RUN, "run-page-1", AgentLifecycleState.RUNNING),
                            lifecycleRecord("event-page-2", "2", AgentLifecycleScope.RUN, "run-page-2", AgentLifecycleState.RUNNING),
                        ),
                    ),
                    limits,
                )
                assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, blocked.disposition)
                assertEquals("0", blocked.state.extensionLane.lastAgentSeq)
                val retry = snapshotRequestAccepted(
                    blocked.state,
                    "snapshot-narrow",
                    limits,
                )
                assertEquals(
                    AgentClientDisposition.SNAPSHOT_APPLIED,
                    AgentTranscriptLifecycleClientReducer.reduce(
                        retry,
                        AgentTranscriptLifecycleClientInput.SnapshotCommit(
                            AgentTimelineLineage(SESSION_IDENTITY, "timeline-page-cap"),
                            "0",
                            "1",
                            listOf(lifecycleRecord("event-page-1", "1", AgentLifecycleScope.RUN, "run-page-1", AgentLifecycleState.RUNNING)),
                        ),
                        limits,
                    ).disposition,
                )
            },
            "notification-ledger" to {
                val limits = AgentClientReducerLimits(maxNotificationLedgerEntries = 1)
                var state = availableState("timeline-ledger-cap", baseline = "0")
                state = AgentTranscriptLifecycleClientReducer.reduce(
                    state,
                    lifecycleEvent("timeline-ledger-cap", "1", "event-ledger-run-1", AgentLifecycleScope.RUN, "run-ledger-1", AgentLifecycleState.RUNNING, "closed-ledger-run-1"),
                    limits,
                ).state
                val firstShown = AgentTranscriptLifecycleClientReducer.reduce(
                    state,
                    lifecycleEvent("timeline-ledger-cap", "2", "event-ledger-done-1", AgentLifecycleScope.RUN, "run-ledger-1", AgentLifecycleState.COMPLETED, "closed-ledger-done-1"),
                    limits,
                )
                assertEquals(1, firstShown.state.extensionLane.notificationLedger.size)
                state = AgentTranscriptLifecycleClientReducer.reduce(
                    firstShown.state,
                    lifecycleEvent("timeline-ledger-cap", "3", "event-ledger-run-2", AgentLifecycleScope.RUN, "run-ledger-2", AgentLifecycleState.RUNNING, "closed-ledger-run-2"),
                    limits,
                ).state
                val blocked = AgentTranscriptLifecycleClientReducer.reduce(
                    state,
                    lifecycleEvent("timeline-ledger-cap", "4", "event-ledger-done-2", AgentLifecycleScope.RUN, "run-ledger-2", AgentLifecycleState.COMPLETED, "closed-ledger-done-2"),
                    limits,
                )
                assertEquals(AgentClientDisposition.GAP_RESYNC, blocked.disposition)
                assertEquals("3", blocked.state.extensionLane.lastAgentSeq)
                val requested = snapshotRequestAccepted(
                    blocked.state,
                    "snapshot-ledger-repair",
                    limits,
                )
                val repaired = AgentTranscriptLifecycleClientReducer.reduce(
                    requested,
                    AgentTranscriptLifecycleClientInput.SnapshotCommit(
                        AgentTimelineLineage(SESSION_IDENTITY, "timeline-ledger-cap"),
                        "1",
                        "3",
                        listOf(lifecycleRecord("event-ledger-run-2", "3", AgentLifecycleScope.RUN, "run-ledger-2", AgentLifecycleState.RUNNING)),
                    ),
                    limits,
                )
                assertEquals(AgentClientDisposition.SNAPSHOT_APPLIED, repaired.disposition)
                assertTrue(repaired.state.extensionLane.notificationLedger.isEmpty())
                val recovered = AgentTranscriptLifecycleClientReducer.reduce(
                    repaired.state,
                    lifecycleEvent("timeline-ledger-cap", "4", "event-ledger-done-2", AgentLifecycleScope.RUN, "run-ledger-2", AgentLifecycleState.COMPLETED, "closed-ledger-done-2"),
                    limits,
                )
                assertEquals(AgentClientDisposition.APPLIED, recovered.disposition)
                assertEquals(1, recovered.notificationDecisions.size)
            },
            "notification-decision-batch" to {
                val initial = availableState("timeline-effect-cap", baseline = "0")
                val requested = snapshotRequestAccepted(initial, "snapshot-effects")
                val limits = AgentClientReducerLimits(
                    maxNotificationDecisionsPerReduction = 1,
                )
                val committed = AgentTranscriptLifecycleClientReducer.reduce(
                    requested,
                    AgentTranscriptLifecycleClientInput.SnapshotCommit(
                        AgentTimelineLineage(SESSION_IDENTITY, "timeline-effect-cap"),
                        "0",
                        "3",
                        listOf(
                            lifecycleRecord("event-effect-1", "1", AgentLifecycleScope.RUN, "run-effect-1", AgentLifecycleState.COMPLETED),
                            lifecycleRecord("event-effect-2", "2", AgentLifecycleScope.RUN, "run-effect-2", AgentLifecycleState.COMPLETED),
                            lifecycleRecord("event-effect-3", "3", AgentLifecycleScope.RUN, "run-effect-3", AgentLifecycleState.COMPLETED),
                        ),
                    ),
                    limits,
                )
                assertEquals(AgentClientDisposition.SNAPSHOT_APPLIED, committed.disposition)
                assertEquals(1, committed.notificationDecisions.size)
                assertEquals(1, committed.state.extensionLane.notificationLedger.size)
                assertEquals("3", committed.state.extensionLane.snapshotNotificationSuppressedThroughAgentSeq)
                assertEquals(
                    AgentClientDisposition.APPLIED,
                    AgentTranscriptLifecycleClientReducer.reduce(
                        committed.state,
                        lifecycleEvent("timeline-effect-cap", "4", "event-effect-4", AgentLifecycleScope.RUN, "run-effect-4", AgentLifecycleState.RUNNING, "closed-effect-4"),
                        limits,
                    ).disposition,
                )
            },
            "retired" to {
                val base = availableState("timeline-retire-current", baseline = "0")
                val full = base.copy(
                    extensionLane = base.extensionLane.copy(
                        retiredTimelineEpochs = setOf("timeline-retire-ancient"),
                    ),
                )
                val limits = AgentClientReducerLimits(maxRetiredTimelineEpochs = 1)
                val unavailableRequested = AgentTranscriptLifecycleClientReducer.reduce(
                    full,
                    AgentTranscriptLifecycleClientInput.StatusRequestStarted("status-retired-temporary"),
                    limits,
                ).state
                val temporarilyUnavailable = AgentTranscriptLifecycleClientReducer.reduce(
                    unavailableRequested,
                    AgentTranscriptLifecycleClientInput.StatusUnavailable(
                        SESSION_IDENTITY,
                        AgentLocalRequestFence("0", "status-retired-temporary"),
                        AgentExtensionUnavailableReason.STORE_UNAVAILABLE,
                    ),
                    limits,
                )
                assertEquals(setOf("timeline-retire-ancient"), temporarilyUnavailable.state.extensionLane.retiredTimelineEpochs)
                assertNull(temporarilyUnavailable.state.extensionLane.retiredEpochCompactionGeneration)
                assertEquals("timeline-retire-current", temporarilyUnavailable.state.extensionLane.timelineEpoch)
                val recoveryRequested = AgentTranscriptLifecycleClientReducer.reduce(
                    temporarilyUnavailable.state,
                    AgentTranscriptLifecycleClientInput.StatusRequestStarted("status-retired-recover"),
                    limits,
                ).state
                val activeAgain = AgentTranscriptLifecycleClientReducer.reduce(
                    recoveryRequested,
                    AgentTranscriptLifecycleClientInput.StatusAvailable(
                        authority = fixtureDurableAuthority(),
                        lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-retire-current"),
                        requestFence = AgentLocalRequestFence("1", "status-retired-recover"),
                        liveSource = AgentLiveSourceState.CONNECTED,
                        activeSourceEpoch = "source-test",
                        currentAgentSeq = "1",
                        earliestReplaySeq = "1",
                        hostLimits = productionHostLimits(),
                    ),
                    limits,
                ).state
                val reset = AgentTranscriptLifecycleClientReducer.reduce(
                    activeAgain,
                    AgentTranscriptLifecycleClientInput.TimelineReset(
                        SESSION_IDENTITY,
                        "timeline-retire-current",
                        "timeline-retire-new",
                        AgentTimelineResetReason.DELETED,
                    ),
                    limits,
                )
                assertEquals(AgentClientDisposition.TIMELINE_RESET, reset.disposition)
                assertEquals(setOf("timeline-retire-current"), reset.state.extensionLane.retiredTimelineEpochs)
                assertEquals("3", reset.state.extensionLane.retiredEpochCompactionGeneration)
                val requested = AgentTranscriptLifecycleClientReducer.reduce(
                    reset.state,
                    AgentTranscriptLifecycleClientInput.StatusRequestStarted("status-after-compaction"),
                    limits,
                ).state
                val recovered = AgentTranscriptLifecycleClientReducer.reduce(
                    requested,
                    AgentTranscriptLifecycleClientInput.StatusAvailable(
                        authority = fixtureDurableAuthority(),
                        lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-retire-new"),
                        requestFence = AgentLocalRequestFence("3", "status-after-compaction"),
                        liveSource = AgentLiveSourceState.CONNECTED,
                        activeSourceEpoch = "source-repaired",
                        currentAgentSeq = "1",
                        earliestReplaySeq = "1",
                        hostLimits = productionHostLimits(),
                    ),
                    limits,
                )
                assertEquals(AgentClientDisposition.STATUS_APPLIED, recovered.disposition)
                assertEquals(AgentExtensionSupport.AVAILABLE, recovered.state.extensionLane.support)
            },
        )
        cases.forEach { (name, verify) ->
            try {
                verify()
            } catch (error: AssertionError) {
                throw AssertionError("capacity recovery case $name failed", error)
            }
        }
    }

    @Test
    fun exhaustedLocalGenerationFailsClosedWithoutThrowingOrWrapping() {
        val maxGeneration = "18446744073709551615"
        val base = availableState("timeline-generation-max", baseline = "0").let { state ->
            state.copy(
                extensionLane = state.extensionLane.copy(localGeneration = maxGeneration),
            )
        }
        val cases = listOf<Pair<String, () -> Pair<AgentTranscriptLifecycleClientState, AgentTranscriptLifecycleClientReduction>>>(
            "config" to {
                base to AgentTranscriptLifecycleClientReducer.reduce(
                    base,
                    AgentTranscriptLifecycleClientInput.ClientConfigChanged(
                        base.notificationConfig.copy(profileActive = false),
                    ),
                )
            },
            "status" to {
                val pending = base.copy(
                    extensionLane = base.extensionLane.copy(
                        pendingStatusRequest = AgentLocalRequestFence(maxGeneration, "status-generation-max"),
                    ),
                )
                pending to AgentTranscriptLifecycleClientReducer.reduce(
                    pending,
                    AgentTranscriptLifecycleClientInput.StatusAvailable(
                        authority = fixtureDurableAuthority(),
                        lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-generation-max"),
                        requestFence = AgentLocalRequestFence(maxGeneration, "status-generation-max"),
                        liveSource = AgentLiveSourceState.INTERRUPTED,
                        activeSourceEpoch = "source-test",
                        currentAgentSeq = "1",
                        earliestReplaySeq = "1",
                        hostLimits = productionHostLimits(),
                    ),
                )
            },
            "snapshot" to {
                val pending = base.copy(
                    extensionLane = base.extensionLane.copy(
                        syncState = AgentTimelineSyncState.Snapshot,
                        pendingSnapshotRequest = null,
                    ),
                )
                pending to AgentTranscriptLifecycleClientReducer.reduce(
                    pending,
                    AgentTranscriptLifecycleClientInput.SnapshotCommit(
                        lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-generation-max"),
                        localGeneration = maxGeneration,
                        throughAgentSeq = "0",
                        records = emptyList(),
                    ),
                )
            },
            "quarantine" to {
                base to AgentTranscriptLifecycleClientReducer.reduce(
                    base,
                    lifecycleEvent(
                        "timeline-generation-max",
                        "1",
                        "event-generation-max-stale-source",
                        AgentLifecycleScope.RUN,
                        "run-generation-max",
                        AgentLifecycleState.RUNNING,
                        "closed-generation-max-stale-source",
                        sourceEpoch = "source-stale",
                    ),
                )
            },
            "reset" to {
                base to AgentTranscriptLifecycleClientReducer.reduce(
                    base,
                    AgentTranscriptLifecycleClientInput.TimelineReset(
                        SESSION_IDENTITY,
                        "timeline-generation-max",
                        "timeline-generation-after-max",
                        AgentTimelineResetReason.DELETED,
                    ),
                )
            },
        )
        cases.forEach { (name, reduceAtLimit) ->
            val (inputState, reduction) = try {
                reduceAtLimit()
            } catch (error: IllegalArgumentException) {
                throw AssertionError("$name generation exhaustion escaped as an exception", error)
            }
            assertEquals(name, AgentClientDisposition.CONTINUITY_CONFLICT, reduction.disposition)
            assertEquals(name, inputState, reduction.state)
        }
    }

    @Test
    fun opaqueIdentifiersAndRequestTokensAreUtf8BoundedAtTrustBoundary() {
        val exactLimit = "x".repeat(128)
        val oversized = "x".repeat(129)
        val multibyteOversized = "界".repeat(43)
        assertEquals(128, exactLimit.toByteArray(StandardCharsets.UTF_8).size)
        AgentExtensionSessionIdentity(exactLimit, "host", "epoch", "scope", "session")
        val invalidValues = listOf(
            "profile" to {
                AgentExtensionSessionIdentity(oversized, "host", "epoch", "scope", "session")
            },
            "multibyte-profile" to {
                AgentExtensionSessionIdentity(
                    multibyteOversized,
                    "host",
                    "epoch",
                    "scope",
                    "session",
                )
            },
            "request-token" to {
                AgentTranscriptLifecycleClientInput.StatusRequestStarted(oversized)
            },
            "ever-turn-marker" to {
                AgentTranscriptLifecycleExtensionState(
                    runsWithTurnRecords = setOf(oversized),
                )
            },
            "malformed-unicode" to {
                AgentExtensionSessionIdentity("\uD800", "host", "epoch", "scope", "session")
            },
        )
        invalidValues.forEach { (name, construct) ->
            try {
                construct()
                throw AssertionError("$name should have been rejected")
            } catch (_: IllegalArgumentException) {
                // Constructor is the current bounded trust boundary until a public codec exists.
            }
        }
    }

    @Test
    fun canonicalSnapshotOrderUsesBareUtf8BytesForSupplementaryAndBmpPrivateUseIds() {
        val supplementary = "\uD800\uDC00"
        val bmpPrivateUse = "\uE000"

        assertTrue("UTF-16 order must exercise the opposite boundary", supplementary < bmpPrivateUse)
        assertTrue(
            "canonical UTF-8 places the BMP private-use identity before the supplementary one",
            compareCanonicalAgentOrder("7", bmpPrivateUse, "7", supplementary) < 0,
        )
        assertTrue(
            "numeric sequence remains the primary key",
            compareCanonicalAgentOrder("8", bmpPrivateUse, "7", supplementary) > 0,
        )
        val boundedPrefix = listOf(supplementary, bmpPrivateUse)
            .sortedWith(Comparator { left, right ->
                compareCanonicalAgentOrder("7", left, "7", right)
            })
            .take(1)
        assertEquals(
            "a full decision batch must retain the canonical prefix",
            listOf(bmpPrivateUse),
            boundedPrefix,
        )
    }

    @Test
    fun permanentLifecycleWitnessRejectsSnapshotRollbackRebindAndPostOmissionResurrection() {
        val session = fixtureSessionIdentity()
        val identity = AgentLifecycleIdentity(AgentLifecycleScope.RUN, "run-permanent", null)
        val limits = AgentTimelineEffectiveLimits(
            maxTextUtf8Bytes = 65_536,
            maxPageRecords = 256,
            eventReplayRetentionMs = 604_800_000,
            snapshotLeaseMs = 300_000,
        )
        fun record(
            eventId: String,
            sequence: String,
            state: AgentLifecycleState,
            sourceEpoch: String = "source-permanent",
        ) = AgentLifecycleRecord(
            lifecycleEventId = eventId,
            sourceEpoch = sourceEpoch,
            identity = identity,
            state = state,
            failure = null,
            occurredAtMs = sequence.toLong() * 1_000,
            agentEventSeq = sequence,
        )
        fun snapshotState(committed: AgentLifecycleRecord): AgentTranscriptLifecycleClientState {
            val witness = AgentLifecycleEventIdentityWitness(
                eventId = committed.lifecycleEventId,
                agentEventSeq = committed.agentEventSeq,
                lifecycleIdentity = committed.identity,
                sourceEpoch = committed.sourceEpoch,
                state = committed.state,
                failure = committed.failure,
                occurredAtMs = committed.occurredAtMs,
                closedEventDigest = null,
            )
            return AgentTranscriptLifecycleClientState(
                identity = session,
                extensionLane = AgentTranscriptLifecycleExtensionState(
                    support = AgentExtensionSupport.AVAILABLE,
                    unavailableReason = null,
                    liveSource = AgentLiveSourceState.CONNECTED,
                    activeSourceEpoch = committed.sourceEpoch,
                    timelineEpoch = "timeline-permanent",
                    lastAgentSeq = committed.agentEventSeq,
                    effectiveHostLimits = limits,
                    syncState = AgentTimelineSyncState.Snapshot,
                    notificationBaselineAgentSeq = "0",
                    lifecycleByIdentity = mapOf(identity to committed),
                    currentLifecycleIdentityByEventId = mapOf(
                        committed.lifecycleEventId to identity,
                    ),
                    eventWitnessById = mapOf(witness.eventId to witness),
                    eventIdBySeq = mapOf(witness.agentEventSeq to witness.eventId),
                ),
            )
        }

        val completed = record("event-completed", "2", AgentLifecycleState.COMPLETED)
        val completedState = snapshotState(completed)
        val runningState = snapshotState(
            record("event-running", "2", AgentLifecycleState.RUNNING),
        )
        val snapshotConflicts = listOf(
            Triple(
                "completed to older running",
                completedState,
                record("event-old-running", "1", AgentLifecycleState.RUNNING),
            ),
            Triple(
                "source epoch rebind",
                runningState,
                record(
                    "event-rebound",
                    "3",
                    AgentLifecycleState.WAITING_FOR_USER,
                    sourceEpoch = "source-rebound",
                ),
            ),
        )
        snapshotConflicts.forEach { (label, inputState, conflictingRecord) ->
            val conflict = AgentTranscriptLifecycleClientReducer.reduce(
                inputState,
                AgentTranscriptLifecycleClientInput.SnapshotCommit(
                    lineage = AgentTimelineLineage(session, "timeline-permanent"),
                    localGeneration = "0",
                    throughAgentSeq = "3",
                    records = listOf(conflictingRecord),
                ),
            )
            assertEquals(label, AgentClientDisposition.CONTINUITY_CONFLICT, conflict.disposition)
            assertEquals(label, inputState, conflict.state)
            assertTrue(label, conflict.syncDirective is AgentTimelineSyncDirective.Snapshot)
        }

        val roundTripStart = snapshotState(
            record("event-round-trip-start", "1", AgentLifecycleState.RUNNING),
        )
        val roundTripEnd = record(
            "event-round-trip-end",
            "3",
            AgentLifecycleState.RUNNING,
        )
        val roundTrip = AgentTranscriptLifecycleClientReducer.reduce(
            roundTripStart,
            AgentTranscriptLifecycleClientInput.SnapshotCommit(
                lineage = AgentTimelineLineage(session, "timeline-permanent"),
                localGeneration = "0",
                throughAgentSeq = "3",
                records = listOf(roundTripEnd),
            ),
        )
        assertEquals(AgentClientDisposition.SNAPSHOT_APPLIED, roundTrip.disposition)
        assertEquals(
            roundTripEnd,
            roundTrip.state.extensionLane.lifecycleByIdentity[identity],
        )

        val omitted = AgentTranscriptLifecycleClientReducer.reduce(
            runningState,
            AgentTranscriptLifecycleClientInput.SnapshotCommit(
                lineage = AgentTimelineLineage(session, "timeline-permanent"),
                localGeneration = "0",
                throughAgentSeq = "2",
                records = emptyList(),
            ),
        ).state
        assertTrue(omitted.extensionLane.lifecycleByIdentity.isEmpty())
        assertTrue(
            omitted.extensionLane.eventWitnessById.containsKey("event-running"),
        )

        AgentEventProvenance.entries.forEach { provenance ->
            val inputState = if (provenance == AgentEventProvenance.REPLAY) {
                omitted.copy(
                    extensionLane = omitted.extensionLane.copy(
                        syncState = AgentTimelineSyncState.Replay(
                            observedCurrentAgentSeq = "3",
                            observedStatusEarliestReplaySeq = "1",
                            pageFence = AgentReplayPageFence(
                                localGeneration = omitted.extensionLane.localGeneration,
                                stableAfterAgentSeq = "2",
                                currentRequestNetworkToken = "replay-permanent",
                                pinnedReplayThroughAgentSeq = null,
                                expectedNextCursor = null,
                                requestedLimit = 256,
                            ),
                        ),
                    ),
                )
            } else {
                omitted
            }
            val resurrected = record(
                "event-resurrected-$provenance",
                "3",
                AgentLifecycleState.WAITING_FOR_USER,
            )
            val conflict = AgentTranscriptLifecycleClientReducer.reduce(
                inputState,
                AgentTranscriptLifecycleClientInput.AgentEvent(
                    lineage = AgentTimelineLineage(session, "timeline-permanent"),
                    agentEventSeq = "3",
                    eventId = resurrected.lifecycleEventId,
                    closedEventDigest = digestOf("closed-resurrected-$provenance"),
                    mutation = AgentTimelineMutation.Lifecycle(resurrected),
                    provenance = provenance,
                ),
            )
            assertEquals(
                provenance.name,
                AgentClientDisposition.CONTINUITY_CONFLICT,
                conflict.disposition,
            )
            assertEquals(provenance.name, "2", conflict.state.extensionLane.lastAgentSeq)
            assertTrue(provenance.name, conflict.state.extensionLane.lifecycleByIdentity.isEmpty())
            assertEquals(
                provenance.name,
                AgentTimelineSyncState.Snapshot,
                conflict.state.extensionLane.syncState,
            )
        }
    }

    @Test
    fun persistedPermanentWitnessChainsRejectCorruptionAndAllowSnapshotRoundTrip() {
        val identity = AgentLifecycleIdentity(AgentLifecycleScope.RUN, "run-chain", null)
        fun witness(
            eventId: String,
            sequence: String,
            state: AgentLifecycleState,
            sourceEpoch: String = "source-chain",
            actual: Boolean = true,
        ) = AgentLifecycleEventIdentityWitness(
            eventId = eventId,
            agentEventSeq = sequence,
            lifecycleIdentity = identity,
            sourceEpoch = sourceEpoch,
            state = state,
            failure = null,
            occurredAtMs = sequence.toLong() * 1_000,
            closedEventDigest = if (actual) digestOf("closed-$eventId") else null,
        )
        fun extension(
            witnesses: List<AgentLifecycleEventIdentityWitness>,
            current: AgentLifecycleRecord? = null,
        ) = AgentTranscriptLifecycleExtensionState(
            lastAgentSeq = witnesses.maxOf { it.agentEventSeq.toLong() }.toString(),
            lifecycleByIdentity = current?.let { mapOf(identity to it) } ?: emptyMap(),
            currentLifecycleIdentityByEventId = current?.let {
                mapOf(it.lifecycleEventId to identity)
            } ?: emptyMap(),
            eventWitnessById = witnesses.associateBy(AgentLifecycleEventIdentityWitness::eventId),
            eventIdBySeq = witnesses.associate {
                it.agentEventSeq to it.eventId
            },
        )

        val corruptChains = listOf(
            "terminal successor" to listOf(
                witness("event-running", "1", AgentLifecycleState.RUNNING),
                witness("event-completed", "2", AgentLifecycleState.COMPLETED),
                witness("event-after-terminal", "3", AgentLifecycleState.RUNNING),
            ),
            "source rebind" to listOf(
                witness("event-source-running", "1", AgentLifecycleState.RUNNING),
                witness(
                    "event-source-waiting",
                    "2",
                    AgentLifecycleState.WAITING_FOR_USER,
                    sourceEpoch = "source-rebound",
                ),
            ),
            "actual first non-running" to listOf(
                witness("event-first-waiting", "1", AgentLifecycleState.WAITING_FOR_USER),
            ),
        )
        corruptChains.forEach { (label, witnesses) ->
            assertTrue(
                label,
                runCatching { extension(witnesses) }.exceptionOrNull() is
                    IllegalArgumentException,
            )
        }

        val start = witness("event-snapshot-start", "1", AgentLifecycleState.RUNNING)
        val snapshotTail = witness(
            "event-snapshot-tail",
            "3",
            AgentLifecycleState.RUNNING,
            actual = false,
        )
        val current = AgentLifecycleRecord(
            lifecycleEventId = snapshotTail.eventId,
            sourceEpoch = snapshotTail.sourceEpoch,
            identity = identity,
            state = snapshotTail.state,
            failure = snapshotTail.failure,
            occurredAtMs = snapshotTail.occurredAtMs,
            agentEventSeq = snapshotTail.agentEventSeq,
        )
        assertEquals(
            current,
            extension(listOf(start, snapshotTail), current).lifecycleByIdentity[identity],
        )
    }

    private fun assertEveryExpectation(
        label: String,
        expected: Map<String, Any?>,
        input: AgentTranscriptLifecycleClientInput?,
        reduction: FixtureReduction,
        baseCommandStates: Map<String, String>,
        commandId: String?,
    ) {
        expected.forEach { (key, value) ->
            when (key) {
                "disposition" -> assertEquals(
                    label,
                    value.asString(),
                    reduction.disposition,
                )
                "lastAgentSeq" -> assertEquals(
                    label,
                    value.asString(),
                    reduction.state.extensionLane.lastAgentSeq,
                )
                "notificationBaselineAgentSeq" -> assertEquals(
                    label,
                    value as String?,
                    reduction.state.extensionLane.notificationBaselineAgentSeq,
                )
                "timelineEpoch" -> assertEquals(
                    label,
                    value as String?,
                    reduction.state.extensionLane.timelineEpoch,
                )
                "support" -> assertEquals(
                    label,
                    value.asString().toSupport(),
                    reduction.state.extensionLane.support,
                )
                "unavailableReason" -> assertEquals(
                    label,
                    value.asString().toUnavailableReason(),
                    reduction.state.extensionLane.unavailableReason,
                )
                "requiresSnapshot" -> assertEquals(
                    label,
                    value as Boolean,
                    reduction.state.extensionLane.requiresSnapshot,
                )
                "lifecycleState" -> assertLifecycleExpectation(label, value, input, reduction.state)
                "commandState" -> assertCommandExpectation(
                    label,
                    value,
                    baseCommandStates,
                    commandId,
                )
                "notification" -> assertNotificationExpectation(label, value.asString(), input, reduction)
                else -> error("$label has an unconsumed expectation key $key")
            }
        }
    }

    private fun assertLifecycleExpectation(
        label: String,
        expected: Any?,
        input: AgentTranscriptLifecycleClientInput?,
        state: AgentTranscriptLifecycleClientState,
    ) {
        val identity = input.lifecycleIdentityOrNull()
        if (expected == null) {
            if (identity == null) {
                assertTrue(label, state.extensionLane.lifecycleByIdentity.isEmpty())
            } else {
                assertNull(label, state.extensionLane.lifecycleByIdentity[identity])
            }
        } else {
            assertNotNull("$label has no lifecycle input identity", identity)
            assertEquals(
                label,
                expected.asString().toLifecycleState(),
                state.extensionLane.lifecycleByIdentity[identity]?.state,
            )
        }
    }

    private fun assertCommandExpectation(
        label: String,
        expected: Any?,
        baseCommandStates: Map<String, String>,
        commandId: String?,
    ) {
        val effectiveCommandId = commandId ?: baseCommandStates.keys.singleOrNull()
        if (expected == null) {
            assertTrue(label, baseCommandStates.isEmpty())
        } else {
            assertNotNull("$label has no command identity", effectiveCommandId)
            assertEquals(
                label,
                expected.asString(),
                baseCommandStates[effectiveCommandId],
            )
        }
    }

    private fun assertNotificationExpectation(
        label: String,
        expected: String,
        input: AgentTranscriptLifecycleClientInput?,
        reduction: FixtureReduction,
    ) {
        if (expected == "none") {
            assertTrue(label, reduction.notificationDecisions.isEmpty())
            return
        }
        val decision = reduction.notificationDecisions.single()
        assertEquals(label, expected.toNotificationDisposition(), decision.disposition)
        val lifecycle = input as? AgentTranscriptLifecycleClientInput.AgentEvent
        assertNotNull("$label notification did not come from lifecycle", lifecycle)
        assertEquals(label, SESSION_IDENTITY.profileId, decision.dedupeKey.profileId)
        assertEquals(label, SESSION_IDENTITY.hostId, decision.dedupeKey.hostId)
        assertEquals(label, SESSION_IDENTITY.hostEpoch, decision.dedupeKey.hostEpoch)
        assertEquals(label, SESSION_IDENTITY.scopeId, decision.dedupeKey.scopeId)
        assertEquals(label, SESSION_IDENTITY.sessionId, decision.dedupeKey.sessionId)
        assertEquals(label, lifecycle!!.record.lifecycleEventId, decision.dedupeKey.lifecycleEventId)
        assertEquals(label, lifecycle.record.state, decision.dedupeKey.state)
        assertEquals(
            label,
            decision.ledgerEntry,
            reduction.state.extensionLane.notificationLedger[decision.dedupeKey],
        )
        if (decision.disposition == AgentNotificationDisposition.SHOWN) {
            assertTrue(
                label,
                requireNotNull(decision.systemNotificationIntent)
                    .isPreflightAuthorizedBy(reduction.state),
            )
        } else {
            assertNull(label, decision.systemNotificationIntent)
        }
    }

    private fun assertAppliedLifecycleIdentityIsPreserved(
        label: String,
        input: AgentTranscriptLifecycleClientInput?,
        reduction: FixtureReduction,
    ) {
        if (reduction.disposition != "applied") return
        val lifecycle = input as? AgentTranscriptLifecycleClientInput.AgentEvent ?: return
        val stored = reduction.state.extensionLane.lifecycleByIdentity[lifecycle.record.identity]
        assertEquals(label, lifecycle.record.identity, stored?.identity)
        assertEquals(label, lifecycle.record.sourceEpoch, stored?.sourceEpoch)
        assertEquals(label, lifecycle.record.lifecycleEventId, stored?.lifecycleEventId)
    }

    private fun Map<String, Any?>.toInitialState(): AgentTranscriptLifecycleClientState {
        val lastAgentSeq = string("lastAgentSeq")
        val lifecycle = map("lifecycleStates").map { (rawIdentity, rawState) ->
            val identity = rawIdentity.toLifecycleIdentity()
            identity to AgentLifecycleRecord(
                lifecycleEventId = "fixture-initial-$rawIdentity",
                sourceEpoch = "source-client",
                identity = identity,
                state = rawState.asString().toLifecycleState(),
                failure = if (rawState.asString() == "failed") {
                    AgentLifecycleFailure("fixture_failure", null)
                } else {
                    null
                },
                occurredAtMs = lastAgentSeq.toLongOrNull() ?: 0,
                agentEventSeq = lastAgentSeq,
            )
        }.toMap()
        return AgentTranscriptLifecycleClientState(
            identity = SESSION_IDENTITY,
            extensionLane = AgentTranscriptLifecycleExtensionState(
                support = string("support").toSupport(),
                unavailableReason = null,
                liveSource = if (string("support") == "available") {
                    AgentLiveSourceState.CONNECTED
                } else {
                    null
                },
                activeSourceEpoch = if (string("support") == "available") {
                    "source-client"
                } else {
                    null
                },
                timelineEpoch = optionalString("timelineEpoch"),
                lastAgentSeq = lastAgentSeq,
                effectiveHostLimits = if (string("support") == "available") {
                    productionHostLimits()
                } else {
                    null
                },
                syncState = if (
                    string("support") == "available" &&
                    optionalString("notificationBaselineAgentSeq") == null
                ) {
                    AgentTimelineSyncState.Snapshot
                } else {
                    AgentTimelineSyncState.Current
                },
                notificationBaselineAgentSeq = optionalString("notificationBaselineAgentSeq"),
                lifecycleByIdentity = lifecycle,
                currentLifecycleIdentityByEventId = lifecycle.entries.associate { (identity, record) ->
                    record.lifecycleEventId to identity
                },
                eventWitnessById = lifecycle.values.associate { record ->
                    record.lifecycleEventId to record.toEventIdentityWitness()
                },
                eventIdBySeq = lifecycle.values.associate { record ->
                    record.agentEventSeq to record.lifecycleEventId
                },
                runsWithTurnRecords = lifecycle.keys
                    .filter { it.scope == AgentLifecycleScope.TURN }
                    .mapTo(linkedSetOf(), AgentLifecycleIdentity::runId),
            ),
            notificationConfig = AgentNotificationConfig(
                permission = string("notificationPermission").toNotificationPermission(),
                profileActive = boolean("profileActive"),
            ),
        )
    }

    private fun Map<String, Any?>.toClientInput(
        state: AgentTranscriptLifecycleClientState,
    ): AgentTranscriptLifecycleClientInput = when (string("kind")) {
        "status_request_started" -> AgentTranscriptLifecycleClientInput.StatusRequestStarted(
            requestNetworkToken = string("requestToken"),
        )
        "snapshot_request_started" -> AgentTranscriptLifecycleClientInput.SnapshotRequestStarted(
            snapshotRequestId = string("requestToken"),
            pageZeroNetworkToken = string("requestToken"),
        )
        "client_config" -> AgentTranscriptLifecycleClientInput.ClientConfigChanged(
            AgentNotificationConfig(
                permission = string("notificationPermission").toNotificationPermission(),
                profileActive = boolean("profileActive"),
                policy = state.notificationConfig.policy,
            ),
        )
        "status" -> when (string("support")) {
            "unavailable" -> AgentTranscriptLifecycleClientInput.StatusUnavailable(
                sessionIdentity = SESSION_IDENTITY,
                requestFence = AgentLocalRequestFence(
                    localGeneration = string("localGeneration"),
                    requestToken = string("requestToken"),
                ),
                reason = string("reason").toUnavailableReason(),
            )
            else -> error("Shared fixture has unsupported status input $this")
        }
        "agent_event" -> {
            val sequence = string("agentEventSeq")
            val eventId = string("eventId")
            AgentTranscriptLifecycleClientInput.AgentEvent(
                lineage = AgentTimelineLineage(SESSION_IDENTITY, string("timelineEpoch")),
                agentEventSeq = sequence,
                eventId = eventId,
                closedEventDigest = digestOf(RelayV2StrictJson.stringify(this)),
                mutation = AgentTimelineMutation.Lifecycle(
                    map("record").toLifecycleRecord(eventId, sequence),
                ),
                provenance = if (state.extensionLane.syncState is AgentTimelineSyncState.Replay) {
                    AgentEventProvenance.REPLAY
                } else {
                    AgentEventProvenance.LIVE
                },
            )
        }
        "snapshot_commit" -> AgentTranscriptLifecycleClientInput.SnapshotCommit(
            lineage = AgentTimelineLineage(SESSION_IDENTITY, string("timelineEpoch")),
            localGeneration = string("localGeneration"),
            throughAgentSeq = string("throughAgentSeq"),
            records = list("records").map { rawRecord ->
                val record = rawRecord.asMap()
                when (record.string("recordType")) {
                    "lifecycle" -> record.toLifecycleRecord(
                        record.string("lifecycleEventId"),
                        record.string("agentEventSeq"),
                    )
                    else -> error("Shared fixture has unsupported snapshot record $record")
                }
            },
        )
        "timeline_reset" -> AgentTranscriptLifecycleClientInput.TimelineReset(
            sessionIdentity = SESSION_IDENTITY,
            previousTimelineEpoch = string("previousTimelineEpoch"),
            newTimelineEpoch = optionalString("newTimelineEpoch"),
            reason = when (string("reason")) {
                "deleted" -> AgentTimelineResetReason.DELETED
                "store_reset" -> AgentTimelineResetReason.STORE_RESET
                else -> error("Unknown timeline reset reason")
            },
        )
        else -> error("Shared fixture has unsupported input $this")
    }

    private fun Map<String, Any?>.toLifecycleRecord(
        fallbackEventId: String,
        fallbackSequence: String,
    ): AgentLifecycleRecord = AgentLifecycleRecord(
        lifecycleEventId = optionalString("lifecycleEventId") ?: fallbackEventId,
        sourceEpoch = string("sourceEpoch"),
        identity = AgentLifecycleIdentity(
            scope = string("scope").toLifecycleScope(),
            runId = string("runId"),
            turnId = optionalString("turnId"),
        ),
        state = string("state").toLifecycleState(),
        failure = if (string("state") == "failed") {
            AgentLifecycleFailure("fixture_failure", null)
        } else {
            null
        },
        occurredAtMs = (optionalString("agentEventSeq") ?: fallbackSequence)
            .toLongOrNull() ?: 0,
        agentEventSeq = optionalString("agentEventSeq") ?: fallbackSequence,
    )

    private fun AgentTranscriptLifecycleClientInput?.lifecycleIdentityOrNull(): AgentLifecycleIdentity? =
        (this as? AgentTranscriptLifecycleClientInput.AgentEvent)?.lifecycleRecord?.identity

    private fun readClientMachineCases(): List<Map<String, Any?>> {
        val path = "extensions/agent-transcript-lifecycle/v1/client-machine-cases.json"
        val raw = requireNotNull(javaClass.classLoader?.getResourceAsStream(path)) {
            "Missing required repo Relay extension fixture $path"
        }.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
        val wrapper = RelayV2StrictJson.parseObject(
            "{\"fixtures\":$raw}",
            RelayV2JsonLimits(
                maxDepth = 32,
                maxDirectKeys = 128,
                maxTotalKeys = 10_000,
                maxNodes = 30_000,
            ),
        )
        return wrapper.list("fixtures").map(Any?::asMap)
    }

    private companion object {
        val SESSION_IDENTITY = AgentExtensionSessionIdentity(
            profileId = "profile-fixture",
            hostId = "mac-admin",
            hostEpoch = "host-epoch-fixture",
            scopeId = "scope-local",
            sessionId = "session-fixture",
        )
    }
}

private fun availableState(
    timelineEpoch: String,
    lastAgentSeq: String = "0",
    baseline: String? = lastAgentSeq,
    lifecycle: Map<AgentLifecycleIdentity, AgentLifecycleRecord> = emptyMap(),
    runsWithTurns: Set<String> = lifecycle.keys
        .filter { it.scope == AgentLifecycleScope.TURN }
        .mapTo(linkedSetOf(), AgentLifecycleIdentity::runId),
): AgentTranscriptLifecycleClientState = AgentTranscriptLifecycleClientState(
    identity = fixtureSessionIdentity(),
    extensionLane = AgentTranscriptLifecycleExtensionState(
        support = AgentExtensionSupport.AVAILABLE,
        unavailableReason = null,
        liveSource = AgentLiveSourceState.CONNECTED,
        activeSourceEpoch = lifecycle.values.firstOrNull()?.sourceEpoch ?: "source-test",
        timelineEpoch = timelineEpoch,
        lastAgentSeq = lastAgentSeq,
        effectiveHostLimits = productionHostLimits(),
        notificationBaselineAgentSeq = baseline,
        lifecycleByIdentity = lifecycle,
        currentLifecycleIdentityByEventId = lifecycle.entries.associate { (identity, record) ->
            record.lifecycleEventId to identity
        },
        eventWitnessById = lifecycle.values.associate { record ->
            record.lifecycleEventId to record.toEventIdentityWitness()
        },
        eventIdBySeq = lifecycle.values.associate { record ->
            record.agentEventSeq to record.lifecycleEventId
        },
        runsWithTurnRecords = runsWithTurns,
    ),
    notificationConfig = AgentNotificationConfig(
        permission = AgentNotificationPermission.GRANTED,
        profileActive = true,
    ),
)

private fun fixtureSessionIdentity(): AgentExtensionSessionIdentity = AgentExtensionSessionIdentity(
    profileId = "profile-fixture",
    hostId = "mac-admin",
    hostEpoch = "host-epoch-fixture",
    scopeId = "scope-local",
    sessionId = "session-fixture",
)

private fun fixtureDurableAuthority(): AgentTranscriptLifecycleDurableConsumerIdentity =
    AgentTranscriptLifecycleDurableConsumerIdentity(
        profileId = "profile-fixture",
        profileActivationGeneration = 1,
        principalId = "principal-fixture",
        clientInstanceId = "client-fixture",
        hostId = "mac-admin",
        hostEpoch = "host-epoch-fixture",
        scopeId = "scope-local",
        sessionId = "session-fixture",
    )

private fun snapshotRequestAccepted(
    state: AgentTranscriptLifecycleClientState,
    snapshotRequestId: String,
    limits: AgentClientReducerLimits = AgentClientReducerLimits(),
): AgentTranscriptLifecycleClientState {
    val snapshotState = state.copy(
        extensionLane = state.extensionLane.copy(
            syncState = AgentTimelineSyncState.Snapshot,
            pendingSnapshotRequest = null,
        ),
    )
    val started = AgentTranscriptLifecycleClientReducer.reduce(
        snapshotState,
        AgentTranscriptLifecycleClientInput.SnapshotRequestStarted(
            snapshotRequestId = snapshotRequestId,
            pageZeroNetworkToken = "$snapshotRequestId-page-zero",
        ),
        limits,
    )
    check(started.disposition == AgentClientDisposition.CONFIG_APPLIED)
    val accepted = AgentTranscriptLifecycleClientReducer.reduce(
        started.state,
        AgentTranscriptLifecycleClientInput.SnapshotPageZeroAccepted(
            requireNotNull(started.state.extensionLane.pendingSnapshotRequest),
        ),
        limits,
    )
    check(accepted.disposition == AgentClientDisposition.CONFIG_APPLIED)
    return accepted.state
}

private fun replayRequestAccepted(
    state: AgentTranscriptLifecycleClientState,
    requestNetworkToken: String,
    observedCurrentAgentSeq: String,
    observedStatusEarliestReplaySeq: String = "1",
    limits: AgentClientReducerLimits = AgentClientReducerLimits(),
): AgentTranscriptLifecycleClientState {
    val replayState = state.copy(
        extensionLane = state.extensionLane.copy(
            syncState = AgentTimelineSyncState.Replay(
                observedCurrentAgentSeq = observedCurrentAgentSeq,
                observedStatusEarliestReplaySeq = observedStatusEarliestReplaySeq,
            ),
        ),
    )
    val requested = AgentTranscriptLifecycleClientReducer.reduce(
        replayState,
        AgentTranscriptLifecycleClientInput.ReplayRequestStarted(
            requestNetworkToken = requestNetworkToken,
            cursor = null,
            limit = requireNotNull(replayState.extensionLane.effectiveHostLimits).maxPageRecords,
        ),
        limits,
    )
    check(requested.disposition == AgentClientDisposition.CONFIG_APPLIED)
    return requested.state
}

private fun prepareFixtureStateForInput(
    state: AgentTranscriptLifecycleClientState,
    rawInput: Map<String, Any?>,
): AgentTranscriptLifecycleClientState {
    val refresh = state.extensionLane.syncState as? AgentTimelineSyncState.StatusRefresh
        ?: return state
    if (refresh.requireSnapshotAfterRefresh || rawInput.string("kind") != "agent_event") {
        return state
    }
    val sequence = rawInput.string("agentEventSeq")
    val statusToken = "fixture-status-$sequence"
    val statusRequested = AgentTranscriptLifecycleClientReducer.reduce(
        state,
        AgentTranscriptLifecycleClientInput.StatusRequestStarted(statusToken),
    ).state
    val available = AgentTranscriptLifecycleClientReducer.reduce(
        statusRequested,
        AgentTranscriptLifecycleClientInput.StatusAvailable(
            authority = fixtureDurableAuthority(),
            lineage = AgentTimelineLineage(
                state.identity,
                requireNotNull(state.extensionLane.timelineEpoch),
            ),
            requestFence = requireNotNull(statusRequested.extensionLane.pendingStatusRequest),
            liveSource = AgentLiveSourceState.CONNECTED,
            activeSourceEpoch = requireNotNull(state.extensionLane.activeSourceEpoch),
            currentAgentSeq = sequence,
            earliestReplaySeq = sequence,
            hostLimits = requireNotNull(state.extensionLane.effectiveHostLimits),
        ),
    ).state
    return replayRequestAccepted(
        available,
        requestNetworkToken = "fixture-replay-$sequence",
        observedCurrentAgentSeq = sequence,
        observedStatusEarliestReplaySeq = sequence,
    )
}

private fun lifecycleEvent(
    timelineEpoch: String,
    sequence: String,
    eventId: String,
    scope: AgentLifecycleScope,
    runId: String,
    state: AgentLifecycleState,
    fingerprint: String,
    turnId: String? = null,
    sourceEpoch: String = "source-test",
    provenance: AgentEventProvenance = AgentEventProvenance.LIVE,
): AgentTranscriptLifecycleClientInput.AgentEvent =
    AgentTranscriptLifecycleClientInput.AgentEvent(
        lineage = AgentTimelineLineage(
            fixtureSessionIdentity(),
            timelineEpoch,
        ),
        agentEventSeq = sequence,
        eventId = eventId,
        closedEventDigest = digestOf(fingerprint),
        mutation = AgentTimelineMutation.Lifecycle(
            lifecycleRecord(
                eventId = eventId,
                sequence = sequence,
                scope = scope,
                runId = runId,
                turnId = turnId,
                state = state,
                sourceEpoch = sourceEpoch,
            ),
        ),
        provenance = provenance,
    )

private fun lifecycleRecord(
    eventId: String,
    sequence: String,
    scope: AgentLifecycleScope,
    runId: String,
    state: AgentLifecycleState,
    turnId: String? = null,
    sourceEpoch: String = "source-test",
    failure: AgentLifecycleFailure? = if (state == AgentLifecycleState.FAILED) {
        AgentLifecycleFailure("test_failure", null)
    } else {
        null
    },
    occurredAtMs: Long = 0,
): AgentLifecycleRecord = AgentLifecycleRecord(
    lifecycleEventId = eventId,
    sourceEpoch = sourceEpoch,
    identity = AgentLifecycleIdentity(scope, runId, turnId),
    state = state,
    failure = failure,
    occurredAtMs = occurredAtMs,
    agentEventSeq = sequence,
)

private fun AgentLifecycleRecord.toEventIdentityWitness(
    digest: AgentClosedEventDigest? = null,
): AgentLifecycleEventIdentityWitness = AgentLifecycleEventIdentityWitness(
    eventId = lifecycleEventId,
    agentEventSeq = agentEventSeq,
    lifecycleIdentity = identity,
    sourceEpoch = sourceEpoch,
    state = state,
    failure = failure,
    occurredAtMs = occurredAtMs,
    closedEventDigest = digest,
)

private val AgentTranscriptLifecycleClientInput.AgentEvent.lifecycleRecord: AgentLifecycleRecord
    get() = (mutation as AgentTimelineMutation.Lifecycle).record

private val AgentTranscriptLifecycleClientInput.AgentEvent.record: AgentLifecycleRecord
    get() = lifecycleRecord

private fun productionHostLimits(): AgentTimelineEffectiveLimits = AgentTimelineEffectiveLimits(
    maxTextUtf8Bytes = 65_536,
    maxPageRecords = 256,
    eventReplayRetentionMs = 604_800_000,
    snapshotLeaseMs = 300_000,
)

private fun digestOf(value: String): AgentClosedEventDigest = AgentClosedEventDigest(
    Base64.getUrlEncoder().withoutPadding().encodeToString(
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray(StandardCharsets.UTF_8)),
    ),
)

private fun String.toLifecycleIdentity(): AgentLifecycleIdentity {
    val parts = split(':')
    return when (parts.firstOrNull()) {
        "run" -> {
            require(parts.size == 2) { "Invalid run lifecycle fixture key $this" }
            AgentLifecycleIdentity(AgentLifecycleScope.RUN, parts[1], null)
        }
        "turn" -> {
            require(parts.size == 3) { "Invalid turn lifecycle fixture key $this" }
            AgentLifecycleIdentity(AgentLifecycleScope.TURN, parts[1], parts[2])
        }
        else -> error("Invalid lifecycle fixture key $this")
    }
}

private fun AgentClientDisposition.toFixtureDisposition(): String = when (this) {
    AgentClientDisposition.APPLIED -> "applied"
    AgentClientDisposition.DUPLICATE -> "duplicate"
    AgentClientDisposition.GAP_RESYNC -> "gap_resync"
    AgentClientDisposition.CONTINUITY_CONFLICT -> "continuity_conflict"
    AgentClientDisposition.CONFIG_APPLIED -> "config_applied"
    AgentClientDisposition.SNAPSHOT_APPLIED -> "snapshot_applied"
    AgentClientDisposition.STATUS_APPLIED -> "status_applied"
    AgentClientDisposition.EXTENSION_NOT_ACTIVE -> "extension_not_active"
    AgentClientDisposition.TIMELINE_RESET -> "timeline_reset"
}

private fun String.toSupport(): AgentExtensionSupport = when (this) {
    "unknown" -> AgentExtensionSupport.UNKNOWN
    "unnegotiated" -> AgentExtensionSupport.UNNEGOTIATED
    "available" -> AgentExtensionSupport.AVAILABLE
    "unavailable" -> AgentExtensionSupport.UNAVAILABLE
    else -> error("Unknown extension support $this")
}

private fun String.toUnavailableReason(): AgentExtensionUnavailableReason = when (this) {
    "extension_not_negotiated" -> AgentExtensionUnavailableReason.EXTENSION_NOT_NEGOTIATED
    "agent_unsupported" -> AgentExtensionUnavailableReason.AGENT_UNSUPPORTED
    "session_not_agent_managed" -> AgentExtensionUnavailableReason.SESSION_NOT_AGENT_MANAGED
    "adapter_unavailable" -> AgentExtensionUnavailableReason.ADAPTER_UNAVAILABLE
    "store_unavailable" -> AgentExtensionUnavailableReason.STORE_UNAVAILABLE
    else -> error("Unknown unavailable reason $this")
}

private fun String.toLifecycleScope(): AgentLifecycleScope = when (this) {
    "run" -> AgentLifecycleScope.RUN
    "turn" -> AgentLifecycleScope.TURN
    else -> error("Unknown lifecycle scope $this")
}

private fun String.toLifecycleState(): AgentLifecycleState = when (this) {
    "running" -> AgentLifecycleState.RUNNING
    "waiting_for_user" -> AgentLifecycleState.WAITING_FOR_USER
    "failed" -> AgentLifecycleState.FAILED
    "completed" -> AgentLifecycleState.COMPLETED
    else -> error("Unknown lifecycle state $this")
}

private fun String.toNotificationPermission(): AgentNotificationPermission = when (this) {
    "granted" -> AgentNotificationPermission.GRANTED
    "denied" -> AgentNotificationPermission.DENIED
    else -> error("Unknown notification permission $this")
}

private fun String.toNotificationDisposition(): AgentNotificationDisposition = when (this) {
    "shown" -> AgentNotificationDisposition.SHOWN
    "suppressed_permission" -> AgentNotificationDisposition.SUPPRESSED_PERMISSION
    "suppressed_inactive_profile" -> AgentNotificationDisposition.SUPPRESSED_INACTIVE_PROFILE
    "suppressed_policy" -> AgentNotificationDisposition.SUPPRESSED_POLICY
    else -> error("Unknown notification disposition $this")
}

private fun Any?.asMap(): Map<String, Any?> {
    @Suppress("UNCHECKED_CAST")
    return this as? Map<String, Any?> ?: error("Fixture value must be an object")
}

private fun Any?.asString(): String = this as? String ?: error("Fixture value must be a string")

private fun Map<String, Any?>.map(name: String): Map<String, Any?> = this[name].asMap()

private fun Map<String, Any?>.list(name: String): List<Any?> =
    this[name] as? List<*> ?: error("Fixture $name must be an array")

private fun Map<String, Any?>.string(name: String): String = this[name].asString()

private fun Map<String, Any?>.optionalString(name: String): String? = when (val value = this[name]) {
    null -> null
    is String -> value
    else -> error("Fixture $name must be a nullable string")
}

private fun Map<String, Any?>.boolean(name: String): Boolean =
    this[name] as? Boolean ?: error("Fixture $name must be a boolean")
