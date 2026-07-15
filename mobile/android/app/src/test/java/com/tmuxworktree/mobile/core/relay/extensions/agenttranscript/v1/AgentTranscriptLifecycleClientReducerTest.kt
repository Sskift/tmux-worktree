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

class AgentTranscriptLifecycleClientReducerTest {
    @Test
    fun androidReducerConsumesEverySharedClientMachineStep() {
        val cases = readClientMachineCases()
        assertTrue("shared client machine fixture must not be empty", cases.isNotEmpty())

        cases.forEach { fixtureCase ->
            val caseName = fixtureCase.string("name")
            var state = fixtureCase.map("initial").toInitialState()
            fixtureCase.list("steps").forEachIndexed { stepIndex, rawStep ->
                val step = rawStep.asMap()
                val rawInput = step.map("input")
                val input = rawInput.toClientInput(state)
                val reduction = AgentTranscriptLifecycleClientReducer.reduce(state, input)
                val label = "$caseName step ${stepIndex + 1}"

                assertEveryExpectation(label, step.map("expect"), input, reduction)
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
            agentEventSeq = signedLongOverflow,
        )
        val initial = AgentTranscriptLifecycleClientState(
            identity = SESSION_IDENTITY,
            extensionLane = AgentTranscriptLifecycleExtensionState(
                support = AgentExtensionSupport.AVAILABLE,
                unavailableReason = null,
                timelineEpoch = "timeline-large",
                lastAgentSeq = signedLongOverflow,
                notificationBaselineAgentSeq = signedLongOverflow,
                lifecycleByIdentity = mapOf(runIdentity to currentRun),
                currentLifecycleIdentityByEventId = mapOf(currentRun.lifecycleEventId to runIdentity),
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
            record = currentRun.copy(
                lifecycleEventId = "event-wrong-lineage",
                state = AgentLifecycleState.COMPLETED,
                agentEventSeq = "9223372036854775810",
            ),
        )
        val lineageRejected = AgentTranscriptLifecycleClientReducer.reduce(applied.state, wrongHostLineage)
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, lineageRejected.disposition)
        assertEquals(nextSequence, lineageRejected.state.extensionLane.lastAgentSeq)

        val differentTimeline = wrongHostLineage.copy(
            lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-unexpected"),
        )
        val timelineResync = AgentTranscriptLifecycleClientReducer.reduce(applied.state, differentTimeline)
        assertEquals(AgentClientDisposition.GAP_RESYNC, timelineResync.disposition)
        assertEquals(AgentExtensionSupport.AVAILABLE, timelineResync.state.extensionLane.support)
        assertEquals("timeline-large", timelineResync.state.extensionLane.timelineEpoch)
        assertEquals(nextSequence, timelineResync.state.extensionLane.lastAgentSeq)
        assertTrue(timelineResync.state.extensionLane.requiresSnapshot)
    }

    @Test
    fun resyncSnapshotPreservesBaselineAppliesFallbackPolicyAndResetFence() {
        val staleIdentity = AgentLifecycleIdentity(AgentLifecycleScope.RUN, "run-stale", null)
        val initial = AgentTranscriptLifecycleClientState(
            identity = SESSION_IDENTITY,
            commandLane = AgentCommandLaneState(mapOf("command-keep" to AgentCommandState.AMBIGUOUS)),
            extensionLane = AgentTranscriptLifecycleExtensionState(
                support = AgentExtensionSupport.AVAILABLE,
                unavailableReason = null,
                timelineEpoch = "timeline-resync",
                lastAgentSeq = "1",
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
                appliedSeqByEventId = mapOf("event-stale" to "1"),
            ),
            notificationConfig = AgentNotificationConfig(
                permission = AgentNotificationPermission.GRANTED,
                profileActive = true,
            ),
        )
        val snapshotRequested = AgentTranscriptLifecycleClientReducer.reduce(
            initial,
            AgentTranscriptLifecycleClientInput.LocalRequestStarted(
                AgentLocalRequestKind.SNAPSHOT,
                "snapshot-resync",
            ),
        ).state
        val snapshot = AgentTranscriptLifecycleClientInput.SnapshotCommit(
            lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-resync"),
            requestFence = AgentLocalRequestFence("0", "snapshot-resync"),
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
        assertEquals(
            AgentAppliedEventEvidence("event-stale", digestOf("closed-event-stale")),
            resynced.state.extensionLane.appliedEventsBySeq["1"],
        )
        assertEquals(
            setOf("event-run-fallback", "event-turn-completed"),
            resynced.notificationDecisions.map { it.dedupeKey.lifecycleEventId }.toSet(),
        )
        assertTrue(resynced.notificationDecisions.all {
            it.disposition == AgentNotificationDisposition.SHOWN &&
                requireNotNull(it.systemNotificationIntent).isAuthorizedBy(resynced.state)
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
        assertTrue(priorIntents.none { it.isAuthorizedBy(policySuppressedState) })
        val reenabledState = AgentTranscriptLifecycleClientReducer.reduce(
            policySuppressedState,
            AgentTranscriptLifecycleClientInput.ClientConfigChanged(
                policySuppressedState.notificationConfig.copy(policy = AgentNotificationPolicy.ALLOW),
            ),
        ).state
        assertTrue("config toggles cannot reauthorize queued intents", priorIntents.none {
            it.isAuthorizedBy(reenabledState)
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
        assertEquals(AgentCommandState.AMBIGUOUS, reset.state.commandLane.statesByCommandId["command-keep"])
        assertTrue(reset.state.extensionLane.lifecycleByIdentity.isEmpty())
        assertTrue(reset.state.extensionLane.notificationLedger.isEmpty())
        assertNull(reset.state.extensionLane.notificationBaselineAgentSeq)
        assertTrue(priorIntents.none { it.isAuthorizedBy(reset.state) })
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
        assertFalse(oldIntent.isAuthorizedBy(resetApplied.state))
        assertTrue("timeline-reset-old" in resetApplied.state.extensionLane.retiredTimelineEpochs)

        val statusRequested = AgentTranscriptLifecycleClientReducer.reduce(
            resetApplied.state,
            AgentTranscriptLifecycleClientInput.LocalRequestStarted(
                AgentLocalRequestKind.STATUS,
                "status-after-reset",
            ),
        ).state
        val lateOldGeneration = AgentTranscriptLifecycleClientReducer.reduce(
            statusRequested,
            AgentTranscriptLifecycleClientInput.StatusAvailable(
                lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-reset-old"),
                requestFence = AgentLocalRequestFence("0", "status-before-reset"),
                liveSource = AgentLiveSourceState.CONNECTED,
                activeSourceEpoch = "source-before-reset",
            ),
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, lateOldGeneration.disposition)
        assertEquals(statusRequested, lateOldGeneration.state)
        val retiredStatus = AgentTranscriptLifecycleClientReducer.reduce(
            lateOldGeneration.state,
            AgentTranscriptLifecycleClientInput.StatusAvailable(
                lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-reset-old"),
                requestFence = AgentLocalRequestFence("1", "status-after-reset"),
                liveSource = AgentLiveSourceState.CONNECTED,
                activeSourceEpoch = "source-after-reset",
            ),
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, retiredStatus.disposition)
        assertEquals("timeline-reset-new", retiredStatus.state.extensionLane.timelineEpoch)
        assertFalse(oldIntent.isAuthorizedBy(retiredStatus.state))
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
        val staleRequested = AgentTranscriptLifecycleClientReducer.reduce(
            initial,
            AgentTranscriptLifecycleClientInput.LocalRequestStarted(
                AgentLocalRequestKind.SNAPSHOT,
                "snapshot-stale",
            ),
        ).state
        val stale = AgentTranscriptLifecycleClientReducer.reduce(
            staleRequested,
            AgentTranscriptLifecycleClientInput.SnapshotCommit(
                lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-snapshot-safe"),
                requestFence = AgentLocalRequestFence("0", "snapshot-stale"),
                throughAgentSeq = "4",
                records = emptyList(),
            ),
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, stale.disposition)
        assertEquals("5", stale.state.extensionLane.lastAgentSeq)
        assertTrue(stale.state.extensionLane.requiresSnapshot)
        assertTrue(stale.notificationDecisions.isEmpty())

        val freshRequested = AgentTranscriptLifecycleClientReducer.reduce(
            stale.state,
            AgentTranscriptLifecycleClientInput.LocalRequestStarted(
                AgentLocalRequestKind.SNAPSHOT,
                "snapshot-fresh",
            ),
        ).state
        val lateOldRequest = AgentTranscriptLifecycleClientReducer.reduce(
            freshRequested,
            AgentTranscriptLifecycleClientInput.SnapshotCommit(
                lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-snapshot-safe"),
                requestFence = AgentLocalRequestFence("0", "snapshot-stale"),
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
                requestFence = AgentLocalRequestFence("1", "snapshot-fresh"),
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

        val invalidRequested = AgentTranscriptLifecycleClientReducer.reduce(
            recovered.state,
            AgentTranscriptLifecycleClientInput.LocalRequestStarted(
                AgentLocalRequestKind.SNAPSHOT,
                "snapshot-invalid-graph",
            ),
        ).state
        val invalidGraph = AgentTranscriptLifecycleClientReducer.reduce(
            invalidRequested,
            AgentTranscriptLifecycleClientInput.SnapshotCommit(
                lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-snapshot-safe"),
                requestFence = AgentLocalRequestFence("1", "snapshot-invalid-graph"),
                throughAgentSeq = "7",
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
                        sequence = "7",
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
                appliedSeqByEventId = mapOf("event-cap-1" to "1"),
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
    }

    private fun assertEveryExpectation(
        label: String,
        expected: Map<String, Any?>,
        input: AgentTranscriptLifecycleClientInput,
        reduction: AgentTranscriptLifecycleClientReduction,
    ) {
        expected.forEach { (key, value) ->
            when (key) {
                "disposition" -> assertEquals(
                    label,
                    value.asString().toDisposition(),
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
                "commandState" -> assertCommandExpectation(label, value, input, reduction.state)
                "notification" -> assertNotificationExpectation(label, value.asString(), input, reduction)
                else -> error("$label has an unconsumed expectation key $key")
            }
        }
    }

    private fun assertLifecycleExpectation(
        label: String,
        expected: Any?,
        input: AgentTranscriptLifecycleClientInput,
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
        input: AgentTranscriptLifecycleClientInput,
        state: AgentTranscriptLifecycleClientState,
    ) {
        val commandId = when (input) {
            is AgentTranscriptLifecycleClientInput.CommandStatus -> input.commandId
            else -> state.commandLane.statesByCommandId.keys.singleOrNull()
        }
        if (expected == null) {
            assertTrue(label, state.commandLane.statesByCommandId.isEmpty())
        } else {
            assertNotNull("$label has no command identity", commandId)
            assertEquals(
                label,
                expected.asString().toCommandState(),
                state.commandLane.statesByCommandId[commandId],
            )
        }
    }

    private fun assertNotificationExpectation(
        label: String,
        expected: String,
        input: AgentTranscriptLifecycleClientInput,
        reduction: AgentTranscriptLifecycleClientReduction,
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
            assertTrue(label, requireNotNull(decision.systemNotificationIntent).isAuthorizedBy(reduction.state))
        } else {
            assertNull(label, decision.systemNotificationIntent)
        }
    }

    private fun assertAppliedLifecycleIdentityIsPreserved(
        label: String,
        input: AgentTranscriptLifecycleClientInput,
        reduction: AgentTranscriptLifecycleClientReduction,
    ) {
        if (reduction.disposition != AgentClientDisposition.APPLIED) return
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
                agentEventSeq = lastAgentSeq,
            )
        }.toMap()
        val commandStates = map("commandStates").mapValues { (_, value) ->
            value.asString().toCommandState()
        }
        return AgentTranscriptLifecycleClientState(
            identity = SESSION_IDENTITY,
            commandLane = AgentCommandLaneState(commandStates),
            extensionLane = AgentTranscriptLifecycleExtensionState(
                support = string("support").toSupport(),
                unavailableReason = null,
                timelineEpoch = optionalString("timelineEpoch"),
                lastAgentSeq = lastAgentSeq,
                notificationBaselineAgentSeq = optionalString("notificationBaselineAgentSeq"),
                lifecycleByIdentity = lifecycle,
                currentLifecycleIdentityByEventId = lifecycle.entries.associate { (identity, record) ->
                    record.lifecycleEventId to identity
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
        "status_request_started" -> AgentTranscriptLifecycleClientInput.LocalRequestStarted(
            kind = AgentLocalRequestKind.STATUS,
            requestToken = string("requestToken"),
        )
        "snapshot_request_started" -> AgentTranscriptLifecycleClientInput.LocalRequestStarted(
            kind = AgentLocalRequestKind.SNAPSHOT,
            requestToken = string("requestToken"),
        )
        "command_status" -> AgentTranscriptLifecycleClientInput.CommandStatus(
            commandId = string("commandId"),
            state = string("state").toCommandState(),
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
                record = map("record").toLifecycleRecord(eventId, sequence),
            )
        }
        "snapshot_commit" -> AgentTranscriptLifecycleClientInput.SnapshotCommit(
            lineage = AgentTimelineLineage(SESSION_IDENTITY, string("timelineEpoch")),
            requestFence = AgentLocalRequestFence(
                localGeneration = string("localGeneration"),
                requestToken = string("requestToken"),
            ),
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
        agentEventSeq = optionalString("agentEventSeq") ?: fallbackSequence,
    )

    private fun AgentTranscriptLifecycleClientInput.lifecycleIdentityOrNull(): AgentLifecycleIdentity? =
        (this as? AgentTranscriptLifecycleClientInput.AgentEvent)?.record?.identity

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
        timelineEpoch = timelineEpoch,
        lastAgentSeq = lastAgentSeq,
        notificationBaselineAgentSeq = baseline,
        lifecycleByIdentity = lifecycle,
        currentLifecycleIdentityByEventId = lifecycle.entries.associate { (identity, record) ->
            record.lifecycleEventId to identity
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
): AgentTranscriptLifecycleClientInput.AgentEvent =
    AgentTranscriptLifecycleClientInput.AgentEvent(
        lineage = AgentTimelineLineage(
            fixtureSessionIdentity(),
            timelineEpoch,
        ),
        agentEventSeq = sequence,
        eventId = eventId,
        closedEventDigest = digestOf(fingerprint),
        record = lifecycleRecord(
            eventId = eventId,
            sequence = sequence,
            scope = scope,
            runId = runId,
            turnId = turnId,
            state = state,
            sourceEpoch = sourceEpoch,
        ),
    )

private fun lifecycleRecord(
    eventId: String,
    sequence: String,
    scope: AgentLifecycleScope,
    runId: String,
    state: AgentLifecycleState,
    turnId: String? = null,
    sourceEpoch: String = "source-test",
): AgentLifecycleRecord = AgentLifecycleRecord(
    lifecycleEventId = eventId,
    sourceEpoch = sourceEpoch,
    identity = AgentLifecycleIdentity(scope, runId, turnId),
    state = state,
    agentEventSeq = sequence,
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

private fun String.toDisposition(): AgentClientDisposition = when (this) {
    "applied" -> AgentClientDisposition.APPLIED
    "duplicate" -> AgentClientDisposition.DUPLICATE
    "gap_resync" -> AgentClientDisposition.GAP_RESYNC
    "continuity_conflict" -> AgentClientDisposition.CONTINUITY_CONFLICT
    "command_applied" -> AgentClientDisposition.COMMAND_APPLIED
    "config_applied" -> AgentClientDisposition.CONFIG_APPLIED
    "snapshot_applied" -> AgentClientDisposition.SNAPSHOT_APPLIED
    "status_applied" -> AgentClientDisposition.STATUS_APPLIED
    "extension_not_active" -> AgentClientDisposition.EXTENSION_NOT_ACTIVE
    "timeline_reset" -> AgentClientDisposition.TIMELINE_RESET
    else -> error("Unknown client disposition $this")
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

private fun String.toCommandState(): AgentCommandState = when (this) {
    "queued" -> AgentCommandState.QUEUED
    "sending" -> AgentCommandState.SENDING
    "accepted" -> AgentCommandState.ACCEPTED
    "confirming" -> AgentCommandState.CONFIRMING
    "succeeded" -> AgentCommandState.SUCCEEDED
    "failed_final" -> AgentCommandState.FAILED_FINAL
    "ambiguous" -> AgentCommandState.AMBIGUOUS
    else -> error("Unknown command state $this")
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
