package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
import java.nio.charset.StandardCharsets
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
    fun canonicalUint64LineageAndPersistedFingerprintFenceContinuity() {
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
            next.copy(closedEventFingerprint = "closed-event-large-next-mutated"),
        )
        assertEquals(AgentClientDisposition.CONTINUITY_CONFLICT, changedContentAtSameIdentity.disposition)
        assertEquals(applied.state, changedContentAtSameIdentity.state)

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
            closedEventFingerprint = "closed-event-wrong-lineage",
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
        assertEquals(AgentExtensionSupport.UNKNOWN, timelineResync.state.extensionLane.support)
        assertNull(timelineResync.state.extensionLane.timelineEpoch)
        assertEquals("0", timelineResync.state.extensionLane.lastAgentSeq)
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
                appliedEventsBySeq = mapOf(
                    "1" to AgentAppliedEventEvidence("event-stale", "closed-event-stale"),
                ),
            ),
            notificationConfig = AgentNotificationConfig(
                permission = AgentNotificationPermission.GRANTED,
                profileActive = true,
            ),
        )
        val snapshot = AgentTranscriptLifecycleClientInput.SnapshotCommit(
            lineage = AgentTimelineLineage(SESSION_IDENTITY, "timeline-resync"),
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
        val resynced = AgentTranscriptLifecycleClientReducer.reduce(initial, snapshot)
        assertEquals(AgentClientDisposition.SNAPSHOT_APPLIED, resynced.disposition)
        assertEquals("1", resynced.state.extensionLane.notificationBaselineAgentSeq)
        assertFalse(resynced.state.extensionLane.lifecycleByIdentity.containsKey(staleIdentity))
        assertEquals(
            AgentAppliedEventEvidence("event-stale", "closed-event-stale"),
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
            decision.disposition,
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
                closedEventFingerprint = RelayV2StrictJson.stringify(this),
                record = map("record").toLifecycleRecord(eventId, sequence),
            )
        }
        "snapshot_commit" -> AgentTranscriptLifecycleClientInput.SnapshotCommit(
            lineage = AgentTimelineLineage(SESSION_IDENTITY, string("timelineEpoch")),
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
            AgentExtensionSessionIdentity(
                profileId = "profile-fixture",
                hostId = "mac-admin",
                hostEpoch = "host-epoch-fixture",
                scopeId = "scope-local",
                sessionId = "session-fixture",
            ),
            timelineEpoch,
        ),
        agentEventSeq = sequence,
        eventId = eventId,
        closedEventFingerprint = fingerprint,
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
