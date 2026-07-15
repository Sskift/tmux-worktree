package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import java.math.BigInteger

/**
 * Persistence-friendly identity for one optional Agent extension consumer lane.
 *
 * This model deliberately has no Relay v1 name fallback and no terminal/command-derived fields.
 */
internal data class AgentExtensionSessionIdentity(
    val profileId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) {
    init {
        requireOpaqueId(profileId, "Profile ID")
        requireOpaqueId(hostId, "Host ID")
        requireOpaqueId(hostEpoch, "Host epoch")
        requireOpaqueId(scopeId, "Scope ID")
        requireOpaqueId(sessionId, "Session ID")
    }
}

internal data class AgentTimelineLineage(
    val session: AgentExtensionSessionIdentity,
    val timelineEpoch: String,
) {
    init {
        requireOpaqueId(timelineEpoch, "Timeline epoch")
    }
}

internal enum class AgentExtensionSupport {
    UNKNOWN,
    UNNEGOTIATED,
    AVAILABLE,
    UNAVAILABLE,
}

internal enum class AgentExtensionUnavailableReason {
    EXTENSION_NOT_NEGOTIATED,
    AGENT_UNSUPPORTED,
    SESSION_NOT_AGENT_MANAGED,
    ADAPTER_UNAVAILABLE,
    STORE_UNAVAILABLE,
}

internal enum class AgentLiveSourceState {
    CONNECTED,
    INTERRUPTED,
}

internal enum class AgentLifecycleScope {
    RUN,
    TURN,
}

internal enum class AgentLifecycleState {
    RUNNING,
    WAITING_FOR_USER,
    FAILED,
    COMPLETED,
    ;

    val terminal: Boolean
        get() = this == FAILED || this == COMPLETED
}

internal data class AgentLifecycleIdentity(
    val scope: AgentLifecycleScope,
    val runId: String,
    val turnId: String?,
) {
    init {
        requireOpaqueId(runId, "Run ID")
        when (scope) {
            AgentLifecycleScope.RUN -> require(turnId == null) { "Run lifecycle cannot contain a turn ID" }
            AgentLifecycleScope.TURN -> requireOpaqueId(turnId, "Turn ID")
        }
    }
}

internal data class AgentLifecycleRecord(
    val lifecycleEventId: String,
    val sourceEpoch: String,
    val identity: AgentLifecycleIdentity,
    val state: AgentLifecycleState,
    val agentEventSeq: String,
) {
    init {
        requireOpaqueId(lifecycleEventId, "Lifecycle event ID")
        requireOpaqueId(sourceEpoch, "Source epoch")
        requireCanonicalCounter(agentEventSeq, "Lifecycle event sequence")
    }
}

/** Exact persisted evidence supplied from the complete closed event's canonical representation. */
internal data class AgentAppliedEventEvidence(
    val eventId: String,
    val closedEventFingerprint: String,
) {
    init {
        requireOpaqueId(eventId, "Event ID")
        require(closedEventFingerprint.isNotEmpty()) { "Event fingerprint is required" }
        require(!closedEventFingerprint.contains('\u0000')) { "Event fingerprint contains NUL" }
        require(closedEventFingerprint.toByteArray(Charsets.UTF_8).size <= MAX_RAW_FRAME_BYTES) {
            "Event fingerprint is too large"
        }
    }
}

internal enum class AgentCommandState {
    QUEUED,
    SENDING,
    ACCEPTED,
    CONFIRMING,
    SUCCEEDED,
    FAILED_FINAL,
    AMBIGUOUS,
}

internal data class AgentCommandLaneState(
    val statesByCommandId: Map<String, AgentCommandState> = emptyMap(),
) {
    init {
        statesByCommandId.keys.forEach { requireOpaqueId(it, "Command ID") }
    }
}

internal enum class AgentNotificationPermission {
    GRANTED,
    DENIED,
}

internal enum class AgentNotificationPolicy {
    ALLOW,
    SUPPRESS,
}

internal data class AgentNotificationConfig(
    val permission: AgentNotificationPermission = AgentNotificationPermission.DENIED,
    val profileActive: Boolean = false,
    val policy: AgentNotificationPolicy = AgentNotificationPolicy.ALLOW,
)

internal data class AgentNotificationDedupeKey(
    val profileId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val timelineEpoch: String,
    val lifecycleEventId: String,
    val state: AgentLifecycleState,
) {
    init {
        requireOpaqueId(profileId, "Profile ID")
        requireOpaqueId(hostId, "Host ID")
        requireOpaqueId(hostEpoch, "Host epoch")
        requireOpaqueId(scopeId, "Scope ID")
        requireOpaqueId(sessionId, "Session ID")
        requireOpaqueId(timelineEpoch, "Timeline epoch")
        requireOpaqueId(lifecycleEventId, "Lifecycle event ID")
    }
}

internal enum class AgentNotificationDisposition {
    SHOWN,
    SUPPRESSED_PERMISSION,
    SUPPRESSED_INACTIVE_PROFILE,
    SUPPRESSED_POLICY,
}

/** Safe system-call intent; it intentionally contains no entry text, failure summary, or label. */
internal data class AgentSystemNotificationIntent(
    val dedupeKey: AgentNotificationDedupeKey,
    val scope: AgentLifecycleScope,
    val state: AgentLifecycleState,
) {
    /** Reset/timeline change revokes a queued intent because its shown ledger row disappears. */
    fun isAuthorizedBy(clientState: AgentTranscriptLifecycleClientState): Boolean {
        val identity = clientState.identity
        return dedupeKey.profileId == identity.profileId &&
            dedupeKey.hostId == identity.hostId &&
            dedupeKey.hostEpoch == identity.hostEpoch &&
            dedupeKey.scopeId == identity.scopeId &&
            dedupeKey.sessionId == identity.sessionId &&
            clientState.extensionLane.timelineEpoch == dedupeKey.timelineEpoch &&
            clientState.notificationConfig.profileActive &&
            clientState.notificationConfig.permission == AgentNotificationPermission.GRANTED &&
            clientState.notificationConfig.policy == AgentNotificationPolicy.ALLOW &&
            clientState.extensionLane.notificationLedger[dedupeKey] ==
            AgentNotificationDisposition.SHOWN
    }
}

internal data class AgentTranscriptLifecycleExtensionState(
    val support: AgentExtensionSupport = AgentExtensionSupport.UNNEGOTIATED,
    val unavailableReason: AgentExtensionUnavailableReason? =
        AgentExtensionUnavailableReason.EXTENSION_NOT_NEGOTIATED,
    val liveSource: AgentLiveSourceState? = null,
    val activeSourceEpoch: String? = null,
    val timelineEpoch: String? = null,
    val lastAgentSeq: String = "0",
    val notificationBaselineAgentSeq: String? = null,
    val lifecycleByIdentity: Map<AgentLifecycleIdentity, AgentLifecycleRecord> = emptyMap(),
    val runsWithTurnRecords: Set<String> = emptySet(),
    val appliedEventsBySeq: Map<String, AgentAppliedEventEvidence> = emptyMap(),
    val notificationLedger: Map<AgentNotificationDedupeKey, AgentNotificationDisposition> = emptyMap(),
) {
    init {
        requireCanonicalCounter(lastAgentSeq, "Last Agent sequence")
        notificationBaselineAgentSeq?.let {
            requireCanonicalCounter(it, "Notification baseline sequence")
            require(compareCounters(it, lastAgentSeq) <= 0) {
                "Notification baseline is ahead of the cursor"
            }
        }
        require((support == AgentExtensionSupport.AVAILABLE) == (timelineEpoch != null)) {
            "Only an available extension can own a timeline"
        }
        require(
            when (support) {
                AgentExtensionSupport.AVAILABLE,
                AgentExtensionSupport.UNKNOWN,
                -> unavailableReason == null
                AgentExtensionSupport.UNNEGOTIATED ->
                    unavailableReason == AgentExtensionUnavailableReason.EXTENSION_NOT_NEGOTIATED
                AgentExtensionSupport.UNAVAILABLE -> unavailableReason != null &&
                    unavailableReason != AgentExtensionUnavailableReason.EXTENSION_NOT_NEGOTIATED
            },
        ) { "Extension support and unavailable reason are inconsistent" }
        require((activeSourceEpoch == null) == (liveSource == null)) {
            "Active source identity and state must be committed together"
        }
        activeSourceEpoch?.let { requireOpaqueId(it, "Active source epoch") }
        timelineEpoch?.let { requireOpaqueId(it, "Timeline epoch") }
        lifecycleByIdentity.forEach { (identity, record) ->
            require(identity == record.identity) { "Lifecycle map key does not match its record" }
        }
        require(runsWithTurnRecords.containsAll(
            lifecycleByIdentity.keys
                .filter { it.scope == AgentLifecycleScope.TURN }
                .map(AgentLifecycleIdentity::runId),
        )) { "Turn history marker is missing" }
        appliedEventsBySeq.forEach { (sequence, _) ->
            requireCanonicalCounter(sequence, "Applied event sequence")
            require(compareCounters(sequence, lastAgentSeq) <= 0) {
                "Applied event evidence is ahead of the cursor"
            }
        }
    }
}

internal data class AgentTranscriptLifecycleClientState(
    val identity: AgentExtensionSessionIdentity,
    val commandLane: AgentCommandLaneState = AgentCommandLaneState(),
    val extensionLane: AgentTranscriptLifecycleExtensionState =
        AgentTranscriptLifecycleExtensionState(),
    val notificationConfig: AgentNotificationConfig = AgentNotificationConfig(),
) {
    init {
        extensionLane.notificationLedger.keys.forEach { key ->
            require(key.profileId == identity.profileId &&
                key.hostId == identity.hostId &&
                key.hostEpoch == identity.hostEpoch &&
                key.scopeId == identity.scopeId &&
                key.sessionId == identity.sessionId &&
                key.timelineEpoch == extensionLane.timelineEpoch
            ) { "Notification ledger key crosses the client state's lineage" }
        }
    }
}

internal enum class AgentTimelineResetReason {
    DELETED,
    STORE_RESET,
}

internal sealed interface AgentTranscriptLifecycleClientInput {
    data class CommandStatus(
        val commandId: String,
        val state: AgentCommandState,
    ) : AgentTranscriptLifecycleClientInput {
        init {
            requireOpaqueId(commandId, "Command ID")
        }
    }

    data class ClientConfigChanged(
        val config: AgentNotificationConfig,
    ) : AgentTranscriptLifecycleClientInput

    data class StatusAvailable(
        val lineage: AgentTimelineLineage,
        val liveSource: AgentLiveSourceState,
        val activeSourceEpoch: String,
    ) : AgentTranscriptLifecycleClientInput {
        init {
            requireOpaqueId(activeSourceEpoch, "Active source epoch")
        }
    }

    data class StatusUnavailable(
        val sessionIdentity: AgentExtensionSessionIdentity,
        val reason: AgentExtensionUnavailableReason,
    ) : AgentTranscriptLifecycleClientInput {
        init {
            require(reason != AgentExtensionUnavailableReason.EXTENSION_NOT_NEGOTIATED) {
                "Unnegotiated is a local capability state, not a host status"
            }
        }
    }

    data object ExtensionNotNegotiated : AgentTranscriptLifecycleClientInput

    data class AgentEvent(
        val lineage: AgentTimelineLineage,
        val agentEventSeq: String,
        val eventId: String,
        val closedEventFingerprint: String,
        val record: AgentLifecycleRecord,
    ) : AgentTranscriptLifecycleClientInput {
        init {
            requireCanonicalCounter(agentEventSeq, "Agent event sequence")
            require(agentEventSeq != "0") { "Agent event sequence starts at one" }
            requireOpaqueId(eventId, "Event ID")
            AgentAppliedEventEvidence(eventId, closedEventFingerprint)
            require(record.agentEventSeq == agentEventSeq) {
                "Lifecycle record sequence does not match its event"
            }
        }
    }

    data class SnapshotCommit(
        val lineage: AgentTimelineLineage,
        val throughAgentSeq: String,
        val records: List<AgentLifecycleRecord>,
    ) : AgentTranscriptLifecycleClientInput {
        init {
            requireCanonicalCounter(throughAgentSeq, "Snapshot watermark")
            require(records.none { it.agentEventSeq == "0" }) {
                "Snapshot records start at Agent sequence one"
            }
            require(records.all { compareCounters(it.agentEventSeq, throughAgentSeq) <= 0 }) {
                "Snapshot record is ahead of its watermark"
            }
            require(records.map { it.identity }.toSet().size == records.size) {
                "Snapshot repeats a lifecycle identity"
            }
            require(records.map { it.lifecycleEventId }.toSet().size == records.size
            ) { "Snapshot repeats a lifecycle event identity" }
        }
    }

    data class TimelineReset(
        val sessionIdentity: AgentExtensionSessionIdentity,
        val previousTimelineEpoch: String,
        val newTimelineEpoch: String?,
        val reason: AgentTimelineResetReason,
    ) : AgentTranscriptLifecycleClientInput {
        init {
            requireOpaqueId(previousTimelineEpoch, "Previous timeline epoch")
            when (reason) {
                AgentTimelineResetReason.DELETED -> requireOpaqueId(newTimelineEpoch, "New timeline epoch")
                AgentTimelineResetReason.STORE_RESET -> require(newTimelineEpoch == null) {
                    "Store reset cannot identify a new timeline"
                }
            }
        }
    }
}

internal enum class AgentClientDisposition {
    APPLIED,
    DUPLICATE,
    GAP_RESYNC,
    CONTINUITY_CONFLICT,
    COMMAND_APPLIED,
    CONFIG_APPLIED,
    SNAPSHOT_APPLIED,
    STATUS_APPLIED,
    EXTENSION_NOT_ACTIVE,
    TIMELINE_RESET,
}

/**
 * The caller must durably commit [state] before executing intents in [notificationDecisions].
 * The notification ledger is already present in that state when an intent is returned, and the
 * intent must still pass [AgentSystemNotificationIntent.isAuthorizedBy] immediately before use.
 */
internal data class AgentTranscriptLifecycleClientReduction(
    val state: AgentTranscriptLifecycleClientState,
    val disposition: AgentClientDisposition,
    val notificationDecisions: List<AgentNotificationDecision> = emptyList(),
)

internal data class AgentNotificationDecision(
    val dedupeKey: AgentNotificationDedupeKey,
    val disposition: AgentNotificationDisposition,
    val systemNotificationIntent: AgentSystemNotificationIntent?,
) {
    init {
        require((disposition == AgentNotificationDisposition.SHOWN) ==
            (systemNotificationIntent != null)
        ) { "Only a shown notification has a system intent" }
    }
}

internal object AgentTranscriptLifecycleClientReducer {
    fun reduce(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput,
    ): AgentTranscriptLifecycleClientReduction = when (input) {
        is AgentTranscriptLifecycleClientInput.CommandStatus -> reduceCommand(state, input)
        is AgentTranscriptLifecycleClientInput.ClientConfigChanged ->
            AgentTranscriptLifecycleClientReduction(
                state = state.copy(notificationConfig = input.config),
                disposition = AgentClientDisposition.CONFIG_APPLIED,
            )
        is AgentTranscriptLifecycleClientInput.StatusAvailable -> reduceAvailableStatus(state, input)
        is AgentTranscriptLifecycleClientInput.StatusUnavailable -> reduceUnavailableStatus(state, input)
        AgentTranscriptLifecycleClientInput.ExtensionNotNegotiated -> reduceUnnegotiated(state)
        is AgentTranscriptLifecycleClientInput.AgentEvent -> reduceAgentEvent(state, input)
        is AgentTranscriptLifecycleClientInput.SnapshotCommit -> reduceSnapshot(state, input)
        is AgentTranscriptLifecycleClientInput.TimelineReset -> reduceTimelineReset(state, input)
    }

    private fun reduceCommand(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput.CommandStatus,
    ): AgentTranscriptLifecycleClientReduction = AgentTranscriptLifecycleClientReduction(
        state = state.copy(
            commandLane = state.commandLane.copy(
                statesByCommandId = state.commandLane.statesByCommandId +
                    (input.commandId to input.state),
            ),
        ),
        disposition = AgentClientDisposition.COMMAND_APPLIED,
    )

    private fun reduceAvailableStatus(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput.StatusAvailable,
    ): AgentTranscriptLifecycleClientReduction {
        if (input.lineage.session != state.identity) {
            return continuityConflict(state)
        }
        val previous = state.extensionLane
        val extension = if (previous.timelineEpoch == input.lineage.timelineEpoch) {
            previous.copy(
                support = AgentExtensionSupport.AVAILABLE,
                unavailableReason = null,
                liveSource = input.liveSource,
                activeSourceEpoch = input.activeSourceEpoch,
            )
        } else {
            clearedTimeline(
                previous = previous,
                support = AgentExtensionSupport.AVAILABLE,
                timelineEpoch = input.lineage.timelineEpoch,
                liveSource = input.liveSource,
                activeSourceEpoch = input.activeSourceEpoch,
            )
        }
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(extensionLane = extension),
            disposition = AgentClientDisposition.STATUS_APPLIED,
        )
    }

    private fun reduceUnavailableStatus(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput.StatusUnavailable,
    ): AgentTranscriptLifecycleClientReduction {
        if (input.sessionIdentity != state.identity) return continuityConflict(state)
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(
                extensionLane = clearedTimeline(
                    previous = state.extensionLane,
                    support = AgentExtensionSupport.UNAVAILABLE,
                    unavailableReason = input.reason,
                ),
            ),
            disposition = AgentClientDisposition.STATUS_APPLIED,
        )
    }

    private fun reduceUnnegotiated(
        state: AgentTranscriptLifecycleClientState,
    ): AgentTranscriptLifecycleClientReduction = AgentTranscriptLifecycleClientReduction(
        state = state.copy(
            extensionLane = clearedTimeline(
                previous = state.extensionLane,
                support = AgentExtensionSupport.UNNEGOTIATED,
                unavailableReason = AgentExtensionUnavailableReason.EXTENSION_NOT_NEGOTIATED,
            ),
        ),
        disposition = AgentClientDisposition.STATUS_APPLIED,
    )

    private fun reduceAgentEvent(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput.AgentEvent,
    ): AgentTranscriptLifecycleClientReduction {
        if (input.lineage.session != state.identity) return continuityConflict(state)
        val extension = state.extensionLane
        if (extension.support != AgentExtensionSupport.AVAILABLE || extension.timelineEpoch == null) {
            return AgentTranscriptLifecycleClientReduction(
                state = state,
                disposition = AgentClientDisposition.EXTENSION_NOT_ACTIVE,
            )
        }
        if (extension.timelineEpoch != input.lineage.timelineEpoch) {
            return AgentTranscriptLifecycleClientReduction(
                state = state.copy(
                    extensionLane = clearedTimeline(
                        previous = extension,
                        support = AgentExtensionSupport.UNKNOWN,
                    ),
                ),
                disposition = AgentClientDisposition.GAP_RESYNC,
            )
        }

        val relation = compareCounters(input.agentEventSeq, extension.lastAgentSeq)
        if (relation <= 0) {
            val evidence = extension.appliedEventsBySeq[input.agentEventSeq]
            val exact = evidence?.eventId == input.eventId &&
                evidence.closedEventFingerprint == input.closedEventFingerprint
            return AgentTranscriptLifecycleClientReduction(
                state = state,
                disposition = if (exact) {
                    AgentClientDisposition.DUPLICATE
                } else {
                    AgentClientDisposition.CONTINUITY_CONFLICT
                },
            )
        }
        if (input.agentEventSeq != nextCounter(extension.lastAgentSeq)) {
            return AgentTranscriptLifecycleClientReduction(
                state = state,
                disposition = AgentClientDisposition.GAP_RESYNC,
            )
        }
        if (extension.appliedEventsBySeq.values.any { it.eventId == input.eventId }) {
            return continuityConflict(state)
        }

        val application = applyLifecycle(extension, input.record)
        if (application == null) {
            return AgentTranscriptLifecycleClientReduction(
                state = state,
                disposition = AgentClientDisposition.CONTINUITY_CONFLICT,
            )
        }
        var nextExtension = application.extension.copy(
            lastAgentSeq = input.agentEventSeq,
            appliedEventsBySeq = application.extension.appliedEventsBySeq +
                (
                    input.agentEventSeq to AgentAppliedEventEvidence(
                        input.eventId,
                        input.closedEventFingerprint,
                    )
                    ),
        )
        var notificationDecisions = emptyList<AgentNotificationDecision>()
        application.lifecycleCandidate?.let { lifecycle ->
            val notification = recordNotificationCandidate(
                identity = state.identity,
                config = state.notificationConfig,
                extension = nextExtension,
                lifecycle = lifecycle,
            )
            nextExtension = notification.extension
            notification.decision?.let { notificationDecisions = listOf(it) }
        }
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(extensionLane = nextExtension),
            disposition = AgentClientDisposition.APPLIED,
            notificationDecisions = notificationDecisions,
        )
    }

    private fun reduceSnapshot(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput.SnapshotCommit,
    ): AgentTranscriptLifecycleClientReduction {
        if (input.lineage.session != state.identity) return continuityConflict(state)
        if (state.extensionLane.support != AgentExtensionSupport.AVAILABLE) {
            return AgentTranscriptLifecycleClientReduction(
                state = state,
                disposition = AgentClientDisposition.EXTENSION_NOT_ACTIVE,
            )
        }
        if (state.extensionLane.timelineEpoch != input.lineage.timelineEpoch) {
            return continuityConflict(state)
        }
        val lifecycle = input.records.associateBy(AgentLifecycleRecord::identity)
        val priorBaseline = state.extensionLane.notificationBaselineAgentSeq
        val initialSnapshotForLineage = priorBaseline == null
        var extension = clearedTimeline(
            previous = state.extensionLane,
            support = AgentExtensionSupport.AVAILABLE,
            timelineEpoch = input.lineage.timelineEpoch,
            liveSource = state.extensionLane.liveSource,
            activeSourceEpoch = state.extensionLane.activeSourceEpoch,
        ).copy(
            lastAgentSeq = input.throughAgentSeq,
            notificationBaselineAgentSeq = if (initialSnapshotForLineage) {
                input.throughAgentSeq
            } else {
                priorBaseline
            },
            lifecycleByIdentity = lifecycle,
            runsWithTurnRecords = lifecycle.keys
                .filter { it.scope == AgentLifecycleScope.TURN }
                .mapTo(linkedSetOf(), AgentLifecycleIdentity::runId),
            appliedEventsBySeq = state.extensionLane.appliedEventsBySeq.filterKeys {
                compareCounters(it, input.throughAgentSeq) <= 0
            },
            notificationLedger = state.extensionLane.notificationLedger,
        )
        val decisions = mutableListOf<AgentNotificationDecision>()
        if (!initialSnapshotForLineage) {
            lifecycle.values
                .sortedWith(
                    compareBy<AgentLifecycleRecord> { BigInteger(it.agentEventSeq) }
                        .thenBy { it.lifecycleEventId },
                )
                .forEach { record ->
                    val notification = recordNotificationCandidate(
                        identity = state.identity,
                        config = state.notificationConfig,
                        extension = extension,
                        lifecycle = record,
                    )
                    extension = notification.extension
                    notification.decision?.let(decisions::add)
                }
        }
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(extensionLane = extension),
            disposition = AgentClientDisposition.SNAPSHOT_APPLIED,
            notificationDecisions = decisions,
        )
    }

    private fun reduceTimelineReset(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput.TimelineReset,
    ): AgentTranscriptLifecycleClientReduction {
        if (input.sessionIdentity != state.identity) return continuityConflict(state)
        val currentEpoch = state.extensionLane.timelineEpoch
        if (currentEpoch != null && currentEpoch != input.previousTimelineEpoch) {
            return AgentTranscriptLifecycleClientReduction(
                state = state,
                disposition = AgentClientDisposition.CONTINUITY_CONFLICT,
            )
        }
        val extension = when (input.reason) {
            AgentTimelineResetReason.DELETED -> clearedTimeline(
                previous = state.extensionLane,
                support = AgentExtensionSupport.AVAILABLE,
                timelineEpoch = requireNotNull(input.newTimelineEpoch),
            )
            AgentTimelineResetReason.STORE_RESET -> clearedTimeline(
                previous = state.extensionLane,
                support = AgentExtensionSupport.UNAVAILABLE,
                unavailableReason = AgentExtensionUnavailableReason.STORE_UNAVAILABLE,
            )
        }
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(extensionLane = extension),
            disposition = AgentClientDisposition.TIMELINE_RESET,
        )
    }

    private data class MutationApplication(
        val extension: AgentTranscriptLifecycleExtensionState,
        val lifecycleCandidate: AgentLifecycleRecord? = null,
    )

    private fun applyLifecycle(
        extension: AgentTranscriptLifecycleExtensionState,
        record: AgentLifecycleRecord,
    ): MutationApplication? {
        val current = extension.lifecycleByIdentity[record.identity]
        if (current == null && record.state != AgentLifecycleState.RUNNING) return null
        if (current != null) {
            if (current.sourceEpoch != record.sourceEpoch || current.state.terminal) return null
            val allowed = when (current.state) {
                AgentLifecycleState.RUNNING -> setOf(
                    AgentLifecycleState.WAITING_FOR_USER,
                    AgentLifecycleState.FAILED,
                    AgentLifecycleState.COMPLETED,
                )
                AgentLifecycleState.WAITING_FOR_USER -> setOf(
                    AgentLifecycleState.RUNNING,
                    AgentLifecycleState.FAILED,
                    AgentLifecycleState.COMPLETED,
                )
                AgentLifecycleState.FAILED,
                AgentLifecycleState.COMPLETED,
                -> emptySet()
            }
            if (record.state !in allowed) return null
        }
        if (extension.lifecycleByIdentity.values.any {
                it.lifecycleEventId == record.lifecycleEventId
            }
        ) return null
        if (extension.notificationLedger.keys.any {
                it.lifecycleEventId == record.lifecycleEventId
            }
        ) return null

        val runIdentity = AgentLifecycleIdentity(AgentLifecycleScope.RUN, record.identity.runId, null)
        val run = extension.lifecycleByIdentity[runIdentity]
        if (record.identity.scope == AgentLifecycleScope.TURN) {
            if (current == null && run?.state != AgentLifecycleState.RUNNING) return null
            if (run != null && run.sourceEpoch != record.sourceEpoch) return null
            val otherActiveTurn = extension.lifecycleByIdentity.values.any {
                it.identity.scope == AgentLifecycleScope.TURN &&
                    it.identity.runId == record.identity.runId &&
                    it.identity != record.identity &&
                    !it.state.terminal
            }
            if (current == null && otherActiveTurn) return null
        } else {
            val turns = extension.lifecycleByIdentity.values.filter {
                it.identity.scope == AgentLifecycleScope.TURN &&
                    it.identity.runId == record.identity.runId
            }
            if (record.state == AgentLifecycleState.WAITING_FOR_USER &&
                turns.any { it.state != AgentLifecycleState.WAITING_FOR_USER && !it.state.terminal }
            ) return null
            if (record.state.terminal && turns.any { !it.state.terminal }) return null
        }

        val lifecycle = extension.lifecycleByIdentity + (record.identity to record)
        val runsWithTurns = if (record.identity.scope == AgentLifecycleScope.TURN) {
            extension.runsWithTurnRecords + record.identity.runId
        } else {
            extension.runsWithTurnRecords
        }
        return MutationApplication(
            extension = extension.copy(
                lifecycleByIdentity = lifecycle,
                runsWithTurnRecords = runsWithTurns,
            ),
            lifecycleCandidate = record,
        )
    }

    private data class NotificationApplication(
        val extension: AgentTranscriptLifecycleExtensionState,
        val decision: AgentNotificationDecision? = null,
    )

    private fun recordNotificationCandidate(
        identity: AgentExtensionSessionIdentity,
        config: AgentNotificationConfig,
        extension: AgentTranscriptLifecycleExtensionState,
        lifecycle: AgentLifecycleRecord,
    ): NotificationApplication {
        val baseline = extension.notificationBaselineAgentSeq ?: return NotificationApplication(extension)
        if (compareCounters(lifecycle.agentEventSeq, baseline) <= 0) return NotificationApplication(extension)
        val candidate = when (lifecycle.identity.scope) {
            AgentLifecycleScope.TURN -> lifecycle.state == AgentLifecycleState.WAITING_FOR_USER ||
                lifecycle.state == AgentLifecycleState.FAILED ||
                lifecycle.state == AgentLifecycleState.COMPLETED
            AgentLifecycleScope.RUN ->
                (lifecycle.state == AgentLifecycleState.FAILED ||
                    lifecycle.state == AgentLifecycleState.COMPLETED) &&
                    lifecycle.identity.runId !in extension.runsWithTurnRecords
        }
        if (!candidate) return NotificationApplication(extension)

        val key = AgentNotificationDedupeKey(
            profileId = identity.profileId,
            hostId = identity.hostId,
            hostEpoch = identity.hostEpoch,
            scopeId = identity.scopeId,
            sessionId = identity.sessionId,
            timelineEpoch = requireNotNull(extension.timelineEpoch),
            lifecycleEventId = lifecycle.lifecycleEventId,
            state = lifecycle.state,
        )
        if (key in extension.notificationLedger) return NotificationApplication(extension)
        val disposition = when {
            !config.profileActive -> AgentNotificationDisposition.SUPPRESSED_INACTIVE_PROFILE
            config.permission == AgentNotificationPermission.DENIED ->
                AgentNotificationDisposition.SUPPRESSED_PERMISSION
            config.policy == AgentNotificationPolicy.SUPPRESS ->
                AgentNotificationDisposition.SUPPRESSED_POLICY
            else -> AgentNotificationDisposition.SHOWN
        }
        val next = extension.copy(
            notificationLedger = extension.notificationLedger + (key to disposition),
        )
        val intent = if (disposition == AgentNotificationDisposition.SHOWN) {
            AgentSystemNotificationIntent(key, lifecycle.identity.scope, lifecycle.state)
        } else {
            null
        }
        return NotificationApplication(
            extension = next,
            decision = AgentNotificationDecision(key, disposition, intent),
        )
    }

    private fun continuityConflict(
        state: AgentTranscriptLifecycleClientState,
    ): AgentTranscriptLifecycleClientReduction = AgentTranscriptLifecycleClientReduction(
        state = state,
        disposition = AgentClientDisposition.CONTINUITY_CONFLICT,
    )

    private fun clearedTimeline(
        previous: AgentTranscriptLifecycleExtensionState,
        support: AgentExtensionSupport,
        unavailableReason: AgentExtensionUnavailableReason? = null,
        timelineEpoch: String? = null,
        liveSource: AgentLiveSourceState? = null,
        activeSourceEpoch: String? = null,
    ): AgentTranscriptLifecycleExtensionState = previous.copy(
        support = support,
        unavailableReason = unavailableReason,
        liveSource = liveSource,
        activeSourceEpoch = activeSourceEpoch,
        timelineEpoch = timelineEpoch,
        lastAgentSeq = "0",
        notificationBaselineAgentSeq = null,
        lifecycleByIdentity = emptyMap(),
        runsWithTurnRecords = emptySet(),
        appliedEventsBySeq = emptyMap(),
        notificationLedger = emptyMap(),
    )
}

private val UINT64_MAX = BigInteger("18446744073709551615")
private val CANONICAL_COUNTER = Regex("^(?:0|[1-9][0-9]*)$")
private const val MAX_RAW_FRAME_BYTES = 1_048_576

private fun requireOpaqueId(value: String?, label: String) {
    require(!value.isNullOrBlank()) { "$label is required" }
    require(value == value.trim()) { "$label cannot contain outer whitespace" }
    require(!value.contains('\u0000')) { "$label contains NUL" }
}

private fun requireCanonicalCounter(value: String, label: String) {
    require(CANONICAL_COUNTER.matches(value)) { "$label is not canonical" }
    require(BigInteger(value) <= UINT64_MAX) { "$label exceeds uint64" }
}

private fun compareCounters(left: String, right: String): Int =
    BigInteger(left).compareTo(BigInteger(right))

private fun nextCounter(value: String): String {
    val next = BigInteger(value) + BigInteger.ONE
    require(next <= UINT64_MAX) { "Agent event sequence exhausted" }
    return next.toString()
}
