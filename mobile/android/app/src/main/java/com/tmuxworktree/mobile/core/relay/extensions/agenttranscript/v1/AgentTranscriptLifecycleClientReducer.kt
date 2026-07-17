package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import java.math.BigInteger
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

internal data class AgentClientReducerLimits(
    val maxAppliedEventEvidence: Int = PRODUCTION_MAX_APPLIED_EVENT_EVIDENCE,
    val maxEventIdentityWitnesses: Int = PRODUCTION_MAX_EVENT_IDENTITY_WITNESSES,
    val maxLifecycleRecords: Int = PRODUCTION_MAX_LIFECYCLE_RECORDS,
    val maxEverTurnMarkers: Int = PRODUCTION_MAX_EVER_TURN_MARKERS,
    val maxNotificationLedgerEntries: Int = PRODUCTION_MAX_NOTIFICATION_LEDGER_ENTRIES,
    val maxSnapshotRecords: Int = PRODUCTION_MAX_SNAPSHOT_RECORDS,
    val maxRetiredTimelineEpochs: Int = PRODUCTION_MAX_RETIRED_TIMELINE_EPOCHS,
    val maxNotificationDecisionsPerReduction: Int =
        PRODUCTION_MAX_NOTIFICATION_DECISIONS_PER_REDUCTION,
) {
    init {
        require(maxAppliedEventEvidence in 1..PRODUCTION_MAX_APPLIED_EVENT_EVIDENCE)
        require(maxEventIdentityWitnesses in 1..PRODUCTION_MAX_EVENT_IDENTITY_WITNESSES)
        require(maxLifecycleRecords in 1..PRODUCTION_MAX_LIFECYCLE_RECORDS)
        require(maxEverTurnMarkers in 1..PRODUCTION_MAX_EVER_TURN_MARKERS)
        require(maxNotificationLedgerEntries in 1..PRODUCTION_MAX_NOTIFICATION_LEDGER_ENTRIES)
        require(maxSnapshotRecords in 1..PRODUCTION_MAX_SNAPSHOT_RECORDS)
        require(maxRetiredTimelineEpochs in 1..PRODUCTION_MAX_RETIRED_TIMELINE_EPOCHS)
        require(
            maxNotificationDecisionsPerReduction in
                1..PRODUCTION_MAX_NOTIFICATION_DECISIONS_PER_REDUCTION,
        )
    }
}

internal data class AgentLocalRequestFence(
    val localGeneration: String,
    val requestToken: String,
) {
    init {
        requireCanonicalCounter(localGeneration, "Local generation")
        requireOpaqueId(requestToken, "Local request token")
    }
}

internal enum class AgentLocalRequestKind {
    STATUS,
    SNAPSHOT,
}

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

/** Local trusted-adapter provenance; this is not an extension wire field. */
internal enum class AgentEventProvenance {
    LIVE,
    REPLAY,
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

/** SHA-256 of the complete closed event canonical bytes, encoded as unpadded base64url. */
@JvmInline
internal value class AgentClosedEventDigest(val value: String) {
    init {
        require(SHA256_BASE64URL_PATTERN.matches(value)) {
            "Closed event digest must be a 43-character SHA-256 base64url value"
        }
    }
}

/** Exact persisted evidence supplied by the future trusted codec boundary. */
internal data class AgentAppliedEventEvidence(
    val eventId: String,
    val closedEventDigest: AgentClosedEventDigest,
) {
    init {
        requireOpaqueId(eventId, "Event ID")
    }
}

internal data class AgentLifecycleEventIdentityWitness(
    val eventId: String,
    val agentEventSeq: String,
    val lifecycleIdentity: AgentLifecycleIdentity,
    val sourceEpoch: String,
    val state: AgentLifecycleState,
    val closedEventDigest: AgentClosedEventDigest?,
) {
    init {
        requireOpaqueId(eventId, "Event ID")
        requireCanonicalCounter(agentEventSeq, "Event identity sequence")
        require(agentEventSeq != "0") { "Event identity sequence starts at one" }
        requireOpaqueId(sourceEpoch, "Source epoch")
    }

    fun matches(record: AgentLifecycleRecord): Boolean =
        eventId == record.lifecycleEventId &&
            agentEventSeq == record.agentEventSeq &&
            lifecycleIdentity == record.identity &&
            sourceEpoch == record.sourceEpoch &&
            state == record.state
}

internal data class AgentSnapshotCheckpoint(
    val throughAgentSeq: String,
    val localGeneration: String,
) {
    init {
        requireCanonicalCounter(throughAgentSeq, "Snapshot checkpoint sequence")
        requireCanonicalCounter(localGeneration, "Snapshot checkpoint generation")
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

internal data class AgentNotificationLedgerEntry(
    val disposition: AgentNotificationDisposition,
    val eventIdentity: AgentLifecycleEventIdentityWitness,
    val localGeneration: String,
) {
    init {
        requireCanonicalCounter(localGeneration, "Notification local generation")
    }
}

/** Safe system-call intent; it intentionally contains no entry text, failure summary, or label. */
internal data class AgentSystemNotificationIntent(
    val dedupeKey: AgentNotificationDedupeKey,
    val localGeneration: String,
) {
    init {
        requireCanonicalCounter(localGeneration, "Notification intent local generation")
    }

    /**
     * Non-consuming preflight only. A future durable system-notification executor must atomically
     * claim an intent before calling the platform; repeated true results are not one-shot proof.
     */
    fun isPreflightAuthorizedBy(clientState: AgentTranscriptLifecycleClientState): Boolean {
        val identity = clientState.identity
        val extension = clientState.extensionLane
        val ledgerEntry = extension.notificationLedger[dedupeKey] ?: return false
        val eventIdentity = ledgerEntry.eventIdentity
        val currentRecord = extension.currentSourceLifecycleOrNull(eventIdentity.lifecycleIdentity)
        return dedupeKey.profileId == identity.profileId &&
            dedupeKey.hostId == identity.hostId &&
            dedupeKey.hostEpoch == identity.hostEpoch &&
            dedupeKey.scopeId == identity.scopeId &&
            dedupeKey.sessionId == identity.sessionId &&
            extension.timelineEpoch == dedupeKey.timelineEpoch &&
            extension.support == AgentExtensionSupport.AVAILABLE &&
            extension.liveSource == AgentLiveSourceState.CONNECTED &&
            extension.activeSourceEpoch == eventIdentity.sourceEpoch &&
            !extension.requiresSnapshot &&
            localGeneration == extension.localGeneration &&
            ledgerEntry.localGeneration == localGeneration &&
            ledgerEntry.disposition == AgentNotificationDisposition.SHOWN &&
            eventIdentity.eventId == dedupeKey.lifecycleEventId &&
            eventIdentity.state == dedupeKey.state &&
            isNotificationCandidate(eventIdentity.lifecycleIdentity.scope, dedupeKey.state) &&
            currentRecord != null && eventIdentity.matches(currentRecord) &&
            clientState.notificationConfig.profileActive &&
            clientState.notificationConfig.permission == AgentNotificationPermission.GRANTED &&
            clientState.notificationConfig.policy == AgentNotificationPolicy.ALLOW
    }
}

internal data class AgentTranscriptLifecycleExtensionState(
    val localGeneration: String = "0",
    val support: AgentExtensionSupport = AgentExtensionSupport.UNNEGOTIATED,
    val unavailableReason: AgentExtensionUnavailableReason? =
        AgentExtensionUnavailableReason.EXTENSION_NOT_NEGOTIATED,
    val liveSource: AgentLiveSourceState? = null,
    val activeSourceEpoch: String? = null,
    val timelineEpoch: String? = null,
    val lastAgentSeq: String = "0",
    val notificationBaselineAgentSeq: String? = null,
    val lifecycleByIdentity: Map<AgentLifecycleIdentity, AgentLifecycleRecord> = emptyMap(),
    val currentLifecycleIdentityByEventId: Map<String, AgentLifecycleIdentity> = emptyMap(),
    val runsWithTurnRecords: Set<String> = emptySet(),
    val appliedEventsBySeq: Map<String, AgentAppliedEventEvidence> = emptyMap(),
    val eventWitnessById: Map<String, AgentLifecycleEventIdentityWitness> = emptyMap(),
    val eventIdBySeq: Map<String, String> = emptyMap(),
    val notificationLedger: Map<AgentNotificationDedupeKey, AgentNotificationLedgerEntry> = emptyMap(),
    val notificationKeyByLifecycleEventId: Map<String, AgentNotificationDedupeKey> = emptyMap(),
    val retiredTimelineEpochs: Set<String> = emptySet(),
    val retiredEpochCompactionGeneration: String? = null,
    val snapshotCheckpoint: AgentSnapshotCheckpoint? = null,
    val snapshotNotificationSuppressedThroughAgentSeq: String? = null,
    val pendingStatusRequest: AgentLocalRequestFence? = null,
    val pendingSnapshotRequest: AgentLocalRequestFence? = null,
    val requiresSnapshot: Boolean = false,
    val requiresTimelineRotation: Boolean = false,
) {
    init {
        requireCanonicalCounter(localGeneration, "Local generation")
        requireCanonicalCounter(lastAgentSeq, "Last Agent sequence")
        notificationBaselineAgentSeq?.let {
            requireCanonicalCounter(it, "Notification baseline sequence")
            require(compareCounters(it, lastAgentSeq) <= 0) {
                "Notification baseline is ahead of the cursor"
            }
        }
        require(support != AgentExtensionSupport.AVAILABLE || timelineEpoch != null) {
            "An available extension must own a timeline"
        }
        require(support != AgentExtensionSupport.AVAILABLE ||
            liveSource != null && activeSourceEpoch != null
        ) { "An available extension must identify its current source status" }
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
        require(timelineEpoch !in retiredTimelineEpochs) {
            "Current timeline cannot already be retired"
        }
        retiredTimelineEpochs.forEach { requireOpaqueId(it, "Retired timeline epoch") }
        require(retiredTimelineEpochs.size <= PRODUCTION_MAX_RETIRED_TIMELINE_EPOCHS) {
            "Retired timeline capacity exceeded"
        }
        retiredEpochCompactionGeneration?.let {
            requireCanonicalCounter(it, "Retired epoch compaction generation")
            require(compareCounters(it, localGeneration) <= 0) {
                "Retired epoch compaction generation is ahead of the client"
            }
        }
        snapshotCheckpoint?.let {
            require(compareCounters(it.localGeneration, localGeneration) <= 0) {
                "Snapshot checkpoint generation is ahead of the client"
            }
            require(compareCounters(it.throughAgentSeq, lastAgentSeq) <= 0) {
                "Snapshot checkpoint is ahead of the committed cursor"
            }
        }
        snapshotNotificationSuppressedThroughAgentSeq?.let {
            requireCanonicalCounter(it, "Snapshot notification suppression sequence")
            require(compareCounters(it, lastAgentSeq) <= 0) {
                "Snapshot notification suppression is ahead of the cursor"
            }
        }
        pendingStatusRequest?.let {
            require(it.localGeneration == localGeneration) { "Status request generation is stale" }
        }
        pendingSnapshotRequest?.let {
            require(it.localGeneration == localGeneration) { "Snapshot request generation is stale" }
        }
        require(!requiresTimelineRotation || requiresSnapshot) {
            "Timeline rotation quarantine also requires snapshot quarantine"
        }
        lifecycleByIdentity.forEach { (identity, record) ->
            require(identity == record.identity) { "Lifecycle map key does not match its record" }
        }
        require(hasValidLifecycleGraph(lifecycleByIdentity.values)) {
            "Lifecycle graph is inconsistent"
        }
        require(lifecycleByIdentity.size <= PRODUCTION_MAX_LIFECYCLE_RECORDS) {
            "Lifecycle record capacity exceeded"
        }
        require(currentLifecycleIdentityByEventId.size == lifecycleByIdentity.size) {
            "Lifecycle event index size is inconsistent"
        }
        lifecycleByIdentity.forEach { (identity, record) ->
            require(currentLifecycleIdentityByEventId[record.lifecycleEventId] == identity) {
                "Lifecycle event index is inconsistent"
            }
        }
        require(runsWithTurnRecords.containsAll(
            lifecycleByIdentity.keys
                .filter { it.scope == AgentLifecycleScope.TURN }
                .map(AgentLifecycleIdentity::runId),
        )) { "Turn history marker is missing" }
        require(runsWithTurnRecords.size <= PRODUCTION_MAX_EVER_TURN_MARKERS) {
            "Ever-turn marker capacity exceeded"
        }
        runsWithTurnRecords.forEach { requireOpaqueId(it, "Ever-turn run ID") }
        require(appliedEventsBySeq.size <= PRODUCTION_MAX_APPLIED_EVENT_EVIDENCE) {
            "Applied event evidence capacity exceeded"
        }
        appliedEventsBySeq.forEach { (sequence, _) ->
            requireCanonicalCounter(sequence, "Applied event sequence")
            require(compareCounters(sequence, lastAgentSeq) <= 0) {
                "Applied event evidence is ahead of the cursor"
            }
        }
        require(eventWitnessById.size <= PRODUCTION_MAX_EVENT_IDENTITY_WITNESSES) {
            "Event identity witness capacity exceeded"
        }
        require(eventIdBySeq.size == eventWitnessById.size) {
            "Event sequence index size is inconsistent"
        }
        eventWitnessById.forEach { (eventId, witness) ->
            require(eventId == witness.eventId) { "Event witness key is inconsistent" }
            require(eventIdBySeq[witness.agentEventSeq] == eventId) {
                "Event sequence index is inconsistent"
            }
            require(compareCounters(witness.agentEventSeq, lastAgentSeq) <= 0) {
                "Event identity witness is ahead of the cursor"
            }
        }
        appliedEventsBySeq.forEach { (sequence, evidence) ->
            val witness = eventWitnessById[evidence.eventId]
            require(witness?.agentEventSeq == sequence &&
                witness.closedEventDigest == evidence.closedEventDigest
            ) { "Applied evidence is not bound to its event identity" }
        }
        lifecycleByIdentity.forEach { (identity, record) ->
            val witness = eventWitnessById[record.lifecycleEventId]
            require(witness != null && witness.lifecycleIdentity == identity && witness.matches(record)) {
                "Lifecycle record is not bound to its durable event identity"
            }
        }
        require(notificationLedger.size <= PRODUCTION_MAX_NOTIFICATION_LEDGER_ENTRIES) {
            "Notification ledger capacity exceeded"
        }
        require(notificationKeyByLifecycleEventId.size == notificationLedger.size) {
            "Notification event index size is inconsistent"
        }
        notificationLedger.forEach { (key, entry) ->
            require(notificationKeyByLifecycleEventId[key.lifecycleEventId] == key) {
                "Notification event index is inconsistent"
            }
            require(compareCounters(entry.localGeneration, localGeneration) <= 0) {
                "Notification ledger generation is ahead of the client"
            }
            require(eventWitnessById[entry.eventIdentity.eventId] == entry.eventIdentity) {
                "Notification ledger event identity is not durable"
            }
            require(entry.eventIdentity.eventId == key.lifecycleEventId &&
                entry.eventIdentity.state == key.state &&
                isNotificationCandidate(entry.eventIdentity.lifecycleIdentity.scope, key.state)
            ) {
                "Notification ledger scope/state is invalid"
            }
        }
    }

    /** Materialized old-source replay remains history unless this active-source view admits it. */
    fun currentSourceLifecycleOrNull(
        identity: AgentLifecycleIdentity,
    ): AgentLifecycleRecord? = lifecycleByIdentity[identity]?.takeIf { record ->
        support == AgentExtensionSupport.AVAILABLE &&
            liveSource == AgentLiveSourceState.CONNECTED &&
            activeSourceEpoch == record.sourceEpoch &&
            !requiresSnapshot
    }
}

internal data class AgentTranscriptLifecycleClientState(
    val identity: AgentExtensionSessionIdentity,
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
    data class LocalRequestStarted(
        val kind: AgentLocalRequestKind,
        val requestToken: String,
    ) : AgentTranscriptLifecycleClientInput {
        init {
            requireOpaqueId(requestToken, "Local request token")
        }
    }

    data class ClientConfigChanged(
        val config: AgentNotificationConfig,
    ) : AgentTranscriptLifecycleClientInput

    data class StatusAvailable(
        val lineage: AgentTimelineLineage,
        val requestFence: AgentLocalRequestFence,
        val liveSource: AgentLiveSourceState,
        val activeSourceEpoch: String,
    ) : AgentTranscriptLifecycleClientInput {
        init {
            requireOpaqueId(activeSourceEpoch, "Active source epoch")
        }
    }

    data class StatusUnavailable(
        val sessionIdentity: AgentExtensionSessionIdentity,
        val requestFence: AgentLocalRequestFence,
        val reason: AgentExtensionUnavailableReason,
    ) : AgentTranscriptLifecycleClientInput

    data object ExtensionNotNegotiated : AgentTranscriptLifecycleClientInput
    data object ExtensionNegotiated : AgentTranscriptLifecycleClientInput

    data class AgentEvent(
        val lineage: AgentTimelineLineage,
        val agentEventSeq: String,
        val eventId: String,
        val closedEventDigest: AgentClosedEventDigest,
        val record: AgentLifecycleRecord,
        val provenance: AgentEventProvenance,
    ) : AgentTranscriptLifecycleClientInput {
        init {
            requireCanonicalCounter(agentEventSeq, "Agent event sequence")
            require(agentEventSeq != "0") { "Agent event sequence starts at one" }
            requireOpaqueId(eventId, "Event ID")
            AgentAppliedEventEvidence(eventId, closedEventDigest)
        }
    }

    data class SnapshotCommit(
        val lineage: AgentTimelineLineage,
        val requestFence: AgentLocalRequestFence,
        val throughAgentSeq: String,
        val records: List<AgentLifecycleRecord>,
    ) : AgentTranscriptLifecycleClientInput {
        init {
            requireCanonicalCounter(throughAgentSeq, "Snapshot watermark")
            require(records.size <= PRODUCTION_MAX_SNAPSHOT_RECORDS) {
                "Snapshot record capacity exceeded"
            }
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
            newTimelineEpoch?.let { requireOpaqueId(it, "New timeline epoch") }
        }
    }
}

internal enum class AgentClientDisposition {
    APPLIED,
    DUPLICATE,
    GAP_RESYNC,
    CONTINUITY_CONFLICT,
    CONFIG_APPLIED,
    SNAPSHOT_APPLIED,
    STATUS_APPLIED,
    EXTENSION_NOT_ACTIVE,
    TIMELINE_RESET,
}

/**
 * The caller must durably commit [state] before executing intents in [notificationDecisions].
 * The notification ledger is already present in that state when an intent is returned, and the
 * intent must still pass [AgentSystemNotificationIntent.isPreflightAuthorizedBy] immediately
 * before a future durable executor atomically claims it.
 */
internal data class AgentTranscriptLifecycleClientReduction(
    val state: AgentTranscriptLifecycleClientState,
    val disposition: AgentClientDisposition,
    val notificationDecisions: List<AgentNotificationDecision> = emptyList(),
) {
    init {
        require(
            notificationDecisions.size <= PRODUCTION_MAX_NOTIFICATION_DECISIONS_PER_REDUCTION,
        ) { "Notification decision batch capacity exceeded" }
    }
}

internal data class AgentNotificationDecision(
    val dedupeKey: AgentNotificationDedupeKey,
    val ledgerEntry: AgentNotificationLedgerEntry,
    val systemNotificationIntent: AgentSystemNotificationIntent?,
) {
    val disposition: AgentNotificationDisposition
        get() = ledgerEntry.disposition

    init {
        require(isNotificationCandidate(
                ledgerEntry.eventIdentity.lifecycleIdentity.scope,
                dedupeKey.state,
            )
        ) {
            "Notification decision scope/state is invalid"
        }
        require((disposition == AgentNotificationDisposition.SHOWN) ==
            (systemNotificationIntent != null)
        ) { "Only a shown notification has a system intent" }
        systemNotificationIntent?.let { intent ->
            require(intent.dedupeKey == dedupeKey) { "Notification intent key is inconsistent" }
            require(intent.localGeneration == ledgerEntry.localGeneration) {
                "Notification intent generation is inconsistent"
            }
        }
    }
}

internal object AgentTranscriptLifecycleClientReducer {
    fun reduce(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput,
        limits: AgentClientReducerLimits = AgentClientReducerLimits(),
    ): AgentTranscriptLifecycleClientReduction = when (input) {
        is AgentTranscriptLifecycleClientInput.LocalRequestStarted ->
            reduceLocalRequestStarted(state, input)
        is AgentTranscriptLifecycleClientInput.ClientConfigChanged -> reduceConfig(state, input)
        is AgentTranscriptLifecycleClientInput.StatusAvailable ->
            reduceAvailableStatus(state, input, limits)
        is AgentTranscriptLifecycleClientInput.StatusUnavailable ->
            reduceUnavailableStatus(state, input)
        AgentTranscriptLifecycleClientInput.ExtensionNotNegotiated ->
            reduceNegotiationChanged(state, negotiated = false)
        AgentTranscriptLifecycleClientInput.ExtensionNegotiated ->
            reduceNegotiationChanged(state, negotiated = true)
        is AgentTranscriptLifecycleClientInput.AgentEvent -> reduceAgentEvent(state, input, limits)
        is AgentTranscriptLifecycleClientInput.SnapshotCommit -> reduceSnapshot(state, input, limits)
        is AgentTranscriptLifecycleClientInput.TimelineReset -> reduceTimelineReset(state, input, limits)
    }

    private fun reduceLocalRequestStarted(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput.LocalRequestStarted,
    ): AgentTranscriptLifecycleClientReduction {
        val extension = state.extensionLane
        if (extension.support == AgentExtensionSupport.UNNEGOTIATED ||
            input.kind == AgentLocalRequestKind.SNAPSHOT &&
            (extension.support != AgentExtensionSupport.AVAILABLE || extension.timelineEpoch == null)
        ) {
            return inactive(state)
        }
        val fence = AgentLocalRequestFence(extension.localGeneration, input.requestToken)
        val next = when (input.kind) {
            AgentLocalRequestKind.STATUS -> extension.copy(pendingStatusRequest = fence)
            AgentLocalRequestKind.SNAPSHOT -> extension.copy(pendingSnapshotRequest = fence)
        }
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(extensionLane = next),
            disposition = AgentClientDisposition.CONFIG_APPLIED,
        )
    }

    private fun reduceConfig(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput.ClientConfigChanged,
    ): AgentTranscriptLifecycleClientReduction {
        if (input.config == state.notificationConfig) {
            return AgentTranscriptLifecycleClientReduction(
                state = state,
                disposition = AgentClientDisposition.CONFIG_APPLIED,
            )
        }
        val extension = state.extensionLane
        val nextGeneration = incrementCounterOrNull(extension.localGeneration)
            ?: return continuityConflict(state)
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(
                extensionLane = extension.copy(
                    localGeneration = nextGeneration,
                    pendingStatusRequest = null,
                    pendingSnapshotRequest = null,
                ),
                notificationConfig = input.config,
            ),
            disposition = AgentClientDisposition.CONFIG_APPLIED,
        )
    }

    private fun reduceAvailableStatus(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput.StatusAvailable,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleClientReduction {
        if (input.lineage.session != state.identity) return continuityConflict(state)
        val previous = state.extensionLane
        if (previous.support == AgentExtensionSupport.UNNEGOTIATED) return inactive(state)
        if (previous.pendingStatusRequest != input.requestFence) return continuityConflict(state)
        if (input.lineage.timelineEpoch in previous.retiredTimelineEpochs) {
            return continuityConflict(
                state.copy(extensionLane = previous.copy(pendingStatusRequest = null)),
            )
        }
        val extension = if (previous.timelineEpoch == input.lineage.timelineEpoch) {
            val statusChanged = previous.support != AgentExtensionSupport.AVAILABLE ||
                previous.liveSource != input.liveSource ||
                previous.activeSourceEpoch != input.activeSourceEpoch
            val nextGeneration = if (statusChanged) {
                incrementCounterOrNull(previous.localGeneration)
                    ?: return continuityConflict(state)
            } else {
                previous.localGeneration
            }
            previous.copy(
                localGeneration = nextGeneration,
                support = AgentExtensionSupport.AVAILABLE,
                unavailableReason = null,
                liveSource = input.liveSource,
                activeSourceEpoch = input.activeSourceEpoch,
                pendingStatusRequest = null,
                pendingSnapshotRequest = if (statusChanged) null else previous.pendingSnapshotRequest,
            )
        } else {
            val nextGeneration = incrementCounterOrNull(previous.localGeneration)
                ?: return continuityConflict(state)
            val retirement = retireCurrentForNewLineage(previous, limits, nextGeneration)
            clearedTimeline(
                previous = previous,
                localGeneration = nextGeneration,
                support = AgentExtensionSupport.AVAILABLE,
                timelineEpoch = input.lineage.timelineEpoch,
                liveSource = input.liveSource,
                activeSourceEpoch = input.activeSourceEpoch,
                retiredTimelineEpochs = retirement.epochs,
                retiredEpochCompactionGeneration = retirement.compactionGeneration,
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
        val previous = state.extensionLane
        if (previous.support == AgentExtensionSupport.UNNEGOTIATED) return inactive(state)
        if (previous.pendingStatusRequest != input.requestFence) return continuityConflict(state)
        if (input.reason == AgentExtensionUnavailableReason.EXTENSION_NOT_NEGOTIATED) {
            return continuityConflict(
                state.copy(extensionLane = previous.copy(pendingStatusRequest = null)),
            )
        }
        val nextGeneration = incrementCounterOrNull(previous.localGeneration)
            ?: return continuityConflict(state)
        val extension = previous.copy(
            localGeneration = nextGeneration,
            support = AgentExtensionSupport.UNAVAILABLE,
            unavailableReason = input.reason,
            liveSource = null,
            activeSourceEpoch = null,
            pendingStatusRequest = null,
            pendingSnapshotRequest = null,
        )
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(extensionLane = extension),
            disposition = AgentClientDisposition.STATUS_APPLIED,
        )
    }

    private fun reduceNegotiationChanged(
        state: AgentTranscriptLifecycleClientState,
        negotiated: Boolean,
    ): AgentTranscriptLifecycleClientReduction {
        val previous = state.extensionLane
        if (!negotiated && previous.support == AgentExtensionSupport.UNNEGOTIATED ||
            negotiated && previous.support != AgentExtensionSupport.UNNEGOTIATED
        ) {
            return AgentTranscriptLifecycleClientReduction(
                state = state,
                disposition = AgentClientDisposition.STATUS_APPLIED,
            )
        }
        val nextGeneration = incrementCounterOrNull(previous.localGeneration)
            ?: return continuityConflict(state)
        val extension = previous.copy(
            localGeneration = nextGeneration,
            support = if (negotiated) {
                AgentExtensionSupport.UNKNOWN
            } else {
                AgentExtensionSupport.UNNEGOTIATED
            },
            unavailableReason = if (negotiated) {
                null
            } else {
                AgentExtensionUnavailableReason.EXTENSION_NOT_NEGOTIATED
            },
            liveSource = null,
            activeSourceEpoch = null,
            pendingStatusRequest = null,
            pendingSnapshotRequest = null,
        )
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(extensionLane = extension),
            disposition = AgentClientDisposition.STATUS_APPLIED,
        )
    }

    private fun reduceAgentEvent(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput.AgentEvent,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleClientReduction {
        if (input.lineage.session != state.identity) return continuityConflict(state)
        val extension = state.extensionLane
        if (extension.timelineEpoch == null) return inactive(state)
        if (extension.timelineEpoch != input.lineage.timelineEpoch) {
            return quarantine(state)
        }
        if (input.record.agentEventSeq != input.agentEventSeq ||
            input.record.lifecycleEventId != input.eventId
        ) {
            return quarantine(state, AgentClientDisposition.CONTINUITY_CONFLICT)
        }

        val relation = compareCounters(input.agentEventSeq, extension.lastAgentSeq)
        if (relation <= 0) {
            val witness = extension.eventWitnessById[input.eventId]
            val exact = witness?.agentEventSeq == input.agentEventSeq &&
                witness.closedEventDigest == input.closedEventDigest &&
                witness.matches(input.record)
            if (exact) {
                return AgentTranscriptLifecycleClientReduction(
                    state = state,
                    disposition = AgentClientDisposition.DUPLICATE,
                )
            }
            return quarantine(state, AgentClientDisposition.CONTINUITY_CONFLICT)
        }
        if (extension.requiresSnapshot) {
            return continuityConflict(state)
        }
        if (extension.support != AgentExtensionSupport.AVAILABLE) {
            return if (input.provenance == AgentEventProvenance.LIVE) {
                quarantine(state, AgentClientDisposition.CONTINUITY_CONFLICT)
            } else {
                inactive(state)
            }
        }
        if (input.provenance == AgentEventProvenance.LIVE &&
            (extension.liveSource != AgentLiveSourceState.CONNECTED ||
                extension.activeSourceEpoch != input.record.sourceEpoch)
        ) {
            return quarantine(state, AgentClientDisposition.CONTINUITY_CONFLICT)
        }
        val expectedSequence = incrementCounterOrNull(extension.lastAgentSeq)
            ?: return continuityConflict(state)
        if (input.agentEventSeq != expectedSequence) {
            return AgentTranscriptLifecycleClientReduction(
                state = state,
                disposition = AgentClientDisposition.GAP_RESYNC,
            )
        }
        if (input.eventId in extension.eventWitnessById ||
            extension.eventIdBySeq[input.agentEventSeq]?.let { it != input.eventId } == true
        ) {
            return quarantine(state, AgentClientDisposition.CONTINUITY_CONFLICT)
        }
        if (extension.eventWitnessById.size >= limits.maxEventIdentityWitnesses) {
            return quarantine(state, requiresTimelineRotation = true)
        }
        if (extension.appliedEventsBySeq.size >= limits.maxAppliedEventEvidence) {
            return quarantine(state)
        }

        val application = applyLifecycle(extension, input.record, limits)
        when (application) {
            LifecycleApplicationResult.CapacityExceeded -> return quarantine(state)
            LifecycleApplicationResult.Invalid ->
                return quarantine(state, AgentClientDisposition.CONTINUITY_CONFLICT)
            is LifecycleApplicationResult.Applied -> Unit
        }
        application as LifecycleApplicationResult.Applied
        val eventIdentity = AgentLifecycleEventIdentityWitness(
            eventId = input.eventId,
            agentEventSeq = input.agentEventSeq,
            lifecycleIdentity = input.record.identity,
            sourceEpoch = input.record.sourceEpoch,
            state = input.record.state,
            closedEventDigest = input.closedEventDigest,
        )
        var nextExtension = extension.copy(
            lastAgentSeq = input.agentEventSeq,
            lifecycleByIdentity = application.lifecycleByIdentity,
            currentLifecycleIdentityByEventId = application.currentLifecycleIdentityByEventId,
            runsWithTurnRecords = application.runsWithTurnRecords,
            appliedEventsBySeq = extension.appliedEventsBySeq +
                (
                    input.agentEventSeq to AgentAppliedEventEvidence(
                        input.eventId,
                        input.closedEventDigest,
                    )
                    ),
            eventWitnessById = extension.eventWitnessById +
                (input.eventId to eventIdentity),
            eventIdBySeq = extension.eventIdBySeq +
                (input.agentEventSeq to input.eventId),
        )
        var notificationDecisions = emptyList<AgentNotificationDecision>()
        val notification = recordNotificationCandidate(
            identity = state.identity,
            config = state.notificationConfig,
            extension = nextExtension,
            lifecycle = input.record,
            eventIdentity = eventIdentity,
            limits = limits,
        )
        if (notification.capacityExceeded) return quarantine(state)
        nextExtension = notification.extension
        notification.decision?.let { notificationDecisions = listOf(it) }
        if (notificationDecisions.size > limits.maxNotificationDecisionsPerReduction) {
            return quarantine(state)
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
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleClientReduction {
        if (input.lineage.session != state.identity) return continuityConflict(state)
        val previous = state.extensionLane
        if (previous.support != AgentExtensionSupport.AVAILABLE || previous.timelineEpoch == null) {
            return inactive(state)
        }
        if (previous.timelineEpoch != input.lineage.timelineEpoch) {
            return continuityConflict(state)
        }
        if (previous.pendingSnapshotRequest != input.requestFence) return continuityConflict(state)
        if (previous.requiresTimelineRotation ||
            previous.eventWitnessById.size >= limits.maxEventIdentityWitnesses
        ) {
            return quarantine(
                state,
                disposition = AgentClientDisposition.CONTINUITY_CONFLICT,
                clearSnapshotRequest = true,
                requiresTimelineRotation = true,
            )
        }
        if (input.records.size > limits.maxSnapshotRecords ||
            input.records.size > limits.maxLifecycleRecords
        ) {
            return quarantine(state, clearSnapshotRequest = true)
        }
        if (input.records.size > limits.maxEventIdentityWitnesses) {
            return quarantine(
                state,
                clearSnapshotRequest = true,
                requiresTimelineRotation = true,
            )
        }
        if (compareCounters(input.throughAgentSeq, previous.lastAgentSeq) < 0) {
            return quarantine(
                state,
                disposition = AgentClientDisposition.CONTINUITY_CONFLICT,
                clearSnapshotRequest = true,
            )
        }
        val recordSequences = input.records.map(AgentLifecycleRecord::agentEventSeq)
        val recordIds = input.records.map(AgentLifecycleRecord::lifecycleEventId)
        val recordIdentities = input.records.map(AgentLifecycleRecord::identity)
        val snapshotShapeValid = input.records.none { it.agentEventSeq == "0" } &&
            input.records.all { compareCounters(it.agentEventSeq, input.throughAgentSeq) <= 0 } &&
            recordSequences.toSet().size == recordSequences.size &&
            recordIds.toSet().size == recordIds.size &&
            recordIdentities.toSet().size == recordIdentities.size &&
            hasValidLifecycleGraph(input.records) &&
            input.records.all { record ->
                val existingById = previous.eventWitnessById[record.lifecycleEventId]
                val existingIdAtSeq = previous.eventIdBySeq[record.agentEventSeq]
                (existingById == null || existingById.matches(record)) &&
                    (existingIdAtSeq == null || existingIdAtSeq == record.lifecycleEventId)
            }
        if (!snapshotShapeValid) {
            return quarantine(
                state,
                disposition = AgentClientDisposition.CONTINUITY_CONFLICT,
                clearSnapshotRequest = true,
            )
        }
        val lifecycle = input.records.associateBy(AgentLifecycleRecord::identity)
        val lifecycleEventIndex = lifecycle.entries.associate { (identity, record) ->
            record.lifecycleEventId to identity
        }
        val snapshotWitnesses = input.records.associate { record ->
            val existing = previous.eventWitnessById[record.lifecycleEventId]
            record.lifecycleEventId to AgentLifecycleEventIdentityWitness(
                eventId = record.lifecycleEventId,
                agentEventSeq = record.agentEventSeq,
                lifecycleIdentity = record.identity,
                sourceEpoch = record.sourceEpoch,
                state = record.state,
                closedEventDigest = existing?.closedEventDigest,
            )
        }
        val eventWitnesses = previous.eventWitnessById + snapshotWitnesses
        if (eventWitnesses.size > limits.maxEventIdentityWitnesses) {
            return quarantine(
                state,
                clearSnapshotRequest = true,
                requiresTimelineRotation = true,
            )
        }
        val eventIdBySeq = previous.eventIdBySeq + snapshotWitnesses.values.associate {
            it.agentEventSeq to it.eventId
        }
        val retainedRunIds = lifecycle.keys.mapTo(linkedSetOf(), AgentLifecycleIdentity::runId)
        val currentTurnRunIds = lifecycle.keys
            .filter { it.scope == AgentLifecycleScope.TURN }
            .mapTo(linkedSetOf(), AgentLifecycleIdentity::runId)
        val runsWithTurns = previous.runsWithTurnRecords.filterTo(linkedSetOf()) {
            it in retainedRunIds
        }.apply { addAll(currentTurnRunIds) }
        if (runsWithTurns.size > limits.maxEverTurnMarkers) {
            return quarantine(state, clearSnapshotRequest = true)
        }
        val retainedNotificationLedger = previous.notificationLedger.filter { (_, entry) ->
            val record = lifecycle[entry.eventIdentity.lifecycleIdentity]
            val witness = eventWitnesses[entry.eventIdentity.eventId]
            record != null &&
                witness == entry.eventIdentity &&
                entry.eventIdentity.matches(record)
        }
        if (retainedNotificationLedger.size > limits.maxNotificationLedgerEntries) {
            return quarantine(state, clearSnapshotRequest = true)
        }
        val retainedNotificationIndex = retainedNotificationLedger.keys.associateBy {
            it.lifecycleEventId
        }

        val priorBaseline = previous.notificationBaselineAgentSeq
        val initialSnapshotForLineage = priorBaseline == null
        val nextGeneration = incrementCounterOrNull(previous.localGeneration)
            ?: return continuityConflict(state)
        var extension = clearedTimeline(
            previous = previous,
            localGeneration = nextGeneration,
            support = AgentExtensionSupport.AVAILABLE,
            timelineEpoch = input.lineage.timelineEpoch,
            liveSource = previous.liveSource,
            activeSourceEpoch = previous.activeSourceEpoch,
            retiredTimelineEpochs = previous.retiredTimelineEpochs,
            retiredEpochCompactionGeneration = previous.retiredEpochCompactionGeneration,
        ).copy(
            lastAgentSeq = input.throughAgentSeq,
            notificationBaselineAgentSeq = if (initialSnapshotForLineage) {
                input.throughAgentSeq
            } else {
                priorBaseline
            },
            lifecycleByIdentity = lifecycle,
            currentLifecycleIdentityByEventId = lifecycleEventIndex,
            runsWithTurnRecords = runsWithTurns,
            appliedEventsBySeq = emptyMap(),
            eventWitnessById = eventWitnesses,
            eventIdBySeq = eventIdBySeq,
            notificationLedger = retainedNotificationLedger,
            notificationKeyByLifecycleEventId = retainedNotificationIndex,
            snapshotCheckpoint = AgentSnapshotCheckpoint(input.throughAgentSeq, nextGeneration),
            snapshotNotificationSuppressedThroughAgentSeq =
                previous.snapshotNotificationSuppressedThroughAgentSeq,
            pendingSnapshotRequest = null,
            requiresSnapshot = false,
        )
        val decisions = mutableListOf<AgentNotificationDecision>()
        if (!initialSnapshotForLineage) {
            lifecycle.values
                .sortedWith(
                    compareBy<AgentLifecycleRecord> { BigInteger(it.agentEventSeq) }
                        .thenBy { it.lifecycleEventId },
                )
                .forEach { record ->
                    if (decisions.size >= limits.maxNotificationDecisionsPerReduction ||
                        extension.notificationLedger.size >= limits.maxNotificationLedgerEntries
                    ) return@forEach
                    val eventIdentity = snapshotWitnesses.getValue(record.lifecycleEventId)
                    val notification = recordNotificationCandidate(
                        identity = state.identity,
                        config = state.notificationConfig,
                        extension = extension,
                        lifecycle = record,
                        eventIdentity = eventIdentity,
                        limits = limits,
                    )
                    extension = notification.extension
                    notification.decision?.let(decisions::add)
                }
        }
        extension = extension.copy(
            snapshotNotificationSuppressedThroughAgentSeq = input.throughAgentSeq,
        )
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(extensionLane = extension),
            disposition = AgentClientDisposition.SNAPSHOT_APPLIED,
            notificationDecisions = decisions,
        )
    }

    private fun reduceTimelineReset(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput.TimelineReset,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleClientReduction {
        if (input.sessionIdentity != state.identity) return continuityConflict(state)
        val previous = state.extensionLane
        val currentEpoch = previous.timelineEpoch
        if (previous.support != AgentExtensionSupport.AVAILABLE || currentEpoch == null) {
            return inactive(state)
        }
        if (currentEpoch != input.previousTimelineEpoch) return continuityConflict(state)
        val newTimelineEpoch = input.newTimelineEpoch
        if ((input.reason == AgentTimelineResetReason.DELETED &&
                (newTimelineEpoch == null || newTimelineEpoch == input.previousTimelineEpoch)) ||
            (input.reason == AgentTimelineResetReason.STORE_RESET && newTimelineEpoch != null)
        ) return continuityConflict(state)
        if (input.newTimelineEpoch in previous.retiredTimelineEpochs) return continuityConflict(state)
        val nextGeneration = incrementCounterOrNull(previous.localGeneration)
            ?: return continuityConflict(state)
        val retirement = retireCurrentForNewLineage(previous, limits, nextGeneration)
        val extension = when (input.reason) {
            AgentTimelineResetReason.DELETED -> clearedTimeline(
                previous = previous,
                localGeneration = nextGeneration,
                support = AgentExtensionSupport.UNKNOWN,
                timelineEpoch = newTimelineEpoch ?: return continuityConflict(state),
                retiredTimelineEpochs = retirement.epochs,
                retiredEpochCompactionGeneration = retirement.compactionGeneration,
            )
            AgentTimelineResetReason.STORE_RESET -> clearedTimeline(
                previous = previous,
                localGeneration = nextGeneration,
                support = AgentExtensionSupport.UNAVAILABLE,
                unavailableReason = AgentExtensionUnavailableReason.STORE_UNAVAILABLE,
                retiredTimelineEpochs = retirement.epochs,
                retiredEpochCompactionGeneration = retirement.compactionGeneration,
            )
        }
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(extensionLane = extension),
            disposition = AgentClientDisposition.TIMELINE_RESET,
        )
    }

    private sealed interface LifecycleApplicationResult {
        data class Applied(
            val lifecycleByIdentity: Map<AgentLifecycleIdentity, AgentLifecycleRecord>,
            val currentLifecycleIdentityByEventId: Map<String, AgentLifecycleIdentity>,
            val runsWithTurnRecords: Set<String>,
        ) : LifecycleApplicationResult
        data object Invalid : LifecycleApplicationResult
        data object CapacityExceeded : LifecycleApplicationResult
    }

    private fun applyLifecycle(
        extension: AgentTranscriptLifecycleExtensionState,
        record: AgentLifecycleRecord,
        limits: AgentClientReducerLimits,
    ): LifecycleApplicationResult {
        val current = extension.lifecycleByIdentity[record.identity]
        if (current == null && record.state != AgentLifecycleState.RUNNING) {
            return LifecycleApplicationResult.Invalid
        }
        if (current != null) {
            if (current.sourceEpoch != record.sourceEpoch || current.state.terminal) {
                return LifecycleApplicationResult.Invalid
            }
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
            if (record.state !in allowed) return LifecycleApplicationResult.Invalid
        }
        if (record.lifecycleEventId in extension.currentLifecycleIdentityByEventId) {
            return LifecycleApplicationResult.Invalid
        }
        if (current == null && extension.lifecycleByIdentity.size >= limits.maxLifecycleRecords) {
            return LifecycleApplicationResult.CapacityExceeded
        }

        val runIdentity = AgentLifecycleIdentity(AgentLifecycleScope.RUN, record.identity.runId, null)
        val run = extension.lifecycleByIdentity[runIdentity]
        if (record.identity.scope == AgentLifecycleScope.TURN) {
            if (current == null && run?.state != AgentLifecycleState.RUNNING) {
                return LifecycleApplicationResult.Invalid
            }
            if (run != null && run.sourceEpoch != record.sourceEpoch) {
                return LifecycleApplicationResult.Invalid
            }
            val otherActiveTurn = extension.lifecycleByIdentity.values.any {
                it.identity.scope == AgentLifecycleScope.TURN &&
                    it.identity.runId == record.identity.runId &&
                    it.identity != record.identity &&
                    !it.state.terminal
            }
            if (current == null && otherActiveTurn) return LifecycleApplicationResult.Invalid
            if (record.identity.runId !in extension.runsWithTurnRecords &&
                extension.runsWithTurnRecords.size >= limits.maxEverTurnMarkers
            ) {
                return LifecycleApplicationResult.CapacityExceeded
            }
        } else {
            val turns = extension.lifecycleByIdentity.values.filter {
                it.identity.scope == AgentLifecycleScope.TURN &&
                    it.identity.runId == record.identity.runId
            }
            if (turns.any { it.sourceEpoch != record.sourceEpoch }) {
                return LifecycleApplicationResult.Invalid
            }
            if (record.state == AgentLifecycleState.WAITING_FOR_USER &&
                turns.any { it.state != AgentLifecycleState.WAITING_FOR_USER && !it.state.terminal }
            ) return LifecycleApplicationResult.Invalid
            if (record.state.terminal && turns.any { !it.state.terminal }) {
                return LifecycleApplicationResult.Invalid
            }
        }

        val lifecycle = extension.lifecycleByIdentity + (record.identity to record)
        val lifecycleEventIndex = extension.currentLifecycleIdentityByEventId.toMutableMap()
        current?.let { lifecycleEventIndex.remove(it.lifecycleEventId) }
        lifecycleEventIndex[record.lifecycleEventId] = record.identity
        val runsWithTurns = if (record.identity.scope == AgentLifecycleScope.TURN) {
            extension.runsWithTurnRecords + record.identity.runId
        } else {
            extension.runsWithTurnRecords
        }
        if (!hasValidLifecycleGraph(lifecycle.values)) {
            return LifecycleApplicationResult.Invalid
        }
        return LifecycleApplicationResult.Applied(
            lifecycleByIdentity = lifecycle,
            currentLifecycleIdentityByEventId = lifecycleEventIndex,
            runsWithTurnRecords = runsWithTurns,
        )
    }

    private data class NotificationApplication(
        val extension: AgentTranscriptLifecycleExtensionState,
        val decision: AgentNotificationDecision? = null,
        val capacityExceeded: Boolean = false,
    )

    private fun recordNotificationCandidate(
        identity: AgentExtensionSessionIdentity,
        config: AgentNotificationConfig,
        extension: AgentTranscriptLifecycleExtensionState,
        lifecycle: AgentLifecycleRecord,
        eventIdentity: AgentLifecycleEventIdentityWitness,
        limits: AgentClientReducerLimits,
    ): NotificationApplication {
        val baseline = extension.notificationBaselineAgentSeq ?: return NotificationApplication(extension)
        val suppressedThrough = extension.snapshotNotificationSuppressedThroughAgentSeq
        if (compareCounters(lifecycle.agentEventSeq, baseline) <= 0 ||
            suppressedThrough != null && compareCounters(lifecycle.agentEventSeq, suppressedThrough) <= 0
        ) return NotificationApplication(extension)
        val candidate = isNotificationCandidate(lifecycle.identity.scope, lifecycle.state) &&
            (lifecycle.identity.scope != AgentLifecycleScope.RUN ||
                lifecycle.identity.runId !in extension.runsWithTurnRecords)
        if (!candidate) return NotificationApplication(extension)
        if (extension.currentSourceLifecycleOrNull(lifecycle.identity) != lifecycle ||
            !eventIdentity.matches(lifecycle)
        ) return NotificationApplication(extension)

        val timelineEpoch = extension.timelineEpoch ?: return NotificationApplication(extension)
        val key = AgentNotificationDedupeKey(
            profileId = identity.profileId,
            hostId = identity.hostId,
            hostEpoch = identity.hostEpoch,
            scopeId = identity.scopeId,
            sessionId = identity.sessionId,
            timelineEpoch = timelineEpoch,
            lifecycleEventId = lifecycle.lifecycleEventId,
            state = lifecycle.state,
        )
        if (key in extension.notificationLedger) return NotificationApplication(extension)
        val existingKey = extension.notificationKeyByLifecycleEventId[lifecycle.lifecycleEventId]
        if (existingKey != null) {
            val entry = extension.notificationLedger.getValue(existingKey)
            if (existingKey != key || entry.eventIdentity != eventIdentity) {
                return NotificationApplication(extension, capacityExceeded = true)
            }
            return NotificationApplication(extension)
        }
        if (extension.notificationLedger.size >= limits.maxNotificationLedgerEntries) {
            return NotificationApplication(extension, capacityExceeded = true)
        }
        val disposition = when {
            !config.profileActive -> AgentNotificationDisposition.SUPPRESSED_INACTIVE_PROFILE
            config.permission == AgentNotificationPermission.DENIED ->
                AgentNotificationDisposition.SUPPRESSED_PERMISSION
            config.policy == AgentNotificationPolicy.SUPPRESS ->
                AgentNotificationDisposition.SUPPRESSED_POLICY
            else -> AgentNotificationDisposition.SHOWN
        }
        val ledgerEntry = AgentNotificationLedgerEntry(
            disposition = disposition,
            eventIdentity = eventIdentity,
            localGeneration = extension.localGeneration,
        )
        val next = extension.copy(
            notificationLedger = extension.notificationLedger + (key to ledgerEntry),
            notificationKeyByLifecycleEventId =
                extension.notificationKeyByLifecycleEventId + (lifecycle.lifecycleEventId to key),
        )
        val intent = if (disposition == AgentNotificationDisposition.SHOWN) {
            AgentSystemNotificationIntent(key, extension.localGeneration)
        } else {
            null
        }
        return NotificationApplication(
            extension = next,
            decision = AgentNotificationDecision(key, ledgerEntry, intent),
        )
    }

    private fun continuityConflict(
        state: AgentTranscriptLifecycleClientState,
    ): AgentTranscriptLifecycleClientReduction = AgentTranscriptLifecycleClientReduction(
        state = state,
        disposition = AgentClientDisposition.CONTINUITY_CONFLICT,
    )

    private fun inactive(
        state: AgentTranscriptLifecycleClientState,
    ): AgentTranscriptLifecycleClientReduction = AgentTranscriptLifecycleClientReduction(
        state = state,
        disposition = AgentClientDisposition.EXTENSION_NOT_ACTIVE,
    )

    private fun quarantine(
        state: AgentTranscriptLifecycleClientState,
        disposition: AgentClientDisposition = AgentClientDisposition.GAP_RESYNC,
        clearStatusRequest: Boolean = false,
        clearSnapshotRequest: Boolean = false,
        requiresTimelineRotation: Boolean = false,
    ): AgentTranscriptLifecycleClientReduction {
        val previous = state.extensionLane
        val extension = if (previous.requiresSnapshot) {
            previous.copy(
                pendingStatusRequest = if (clearStatusRequest) null else previous.pendingStatusRequest,
                pendingSnapshotRequest = if (clearSnapshotRequest) null else previous.pendingSnapshotRequest,
                requiresTimelineRotation =
                    previous.requiresTimelineRotation || requiresTimelineRotation,
            )
        } else {
            val nextGeneration = incrementCounterOrNull(previous.localGeneration)
                ?: return continuityConflict(state)
            previous.copy(
                localGeneration = nextGeneration,
                pendingStatusRequest = null,
                pendingSnapshotRequest = null,
                requiresSnapshot = true,
                requiresTimelineRotation = requiresTimelineRotation,
            )
        }
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(extensionLane = extension),
            disposition = disposition,
        )
    }

    private data class RetirementResult(
        val epochs: Set<String>,
        val compactionGeneration: String?,
    )

    /** A trusted new-lineage signal checkpoints stale-response fencing when tombstones are full. */
    private fun retireCurrentForNewLineage(
        extension: AgentTranscriptLifecycleExtensionState,
        limits: AgentClientReducerLimits,
        newGeneration: String,
    ): RetirementResult {
        val current = extension.timelineEpoch ?: return RetirementResult(
            extension.retiredTimelineEpochs,
            extension.retiredEpochCompactionGeneration,
        )
        return if (extension.retiredTimelineEpochs.size < limits.maxRetiredTimelineEpochs) {
            RetirementResult(
                extension.retiredTimelineEpochs + current,
                extension.retiredEpochCompactionGeneration,
            )
        } else {
            RetirementResult(setOf(current), newGeneration)
        }
    }

    private fun clearedTimeline(
        previous: AgentTranscriptLifecycleExtensionState,
        localGeneration: String,
        support: AgentExtensionSupport,
        unavailableReason: AgentExtensionUnavailableReason? = null,
        timelineEpoch: String? = null,
        liveSource: AgentLiveSourceState? = null,
        activeSourceEpoch: String? = null,
        retiredTimelineEpochs: Set<String>,
        retiredEpochCompactionGeneration: String?,
    ): AgentTranscriptLifecycleExtensionState = previous.copy(
        localGeneration = localGeneration,
        support = support,
        unavailableReason = unavailableReason,
        liveSource = liveSource,
        activeSourceEpoch = activeSourceEpoch,
        timelineEpoch = timelineEpoch,
        lastAgentSeq = "0",
        notificationBaselineAgentSeq = null,
        lifecycleByIdentity = emptyMap(),
        currentLifecycleIdentityByEventId = emptyMap(),
        runsWithTurnRecords = emptySet(),
        appliedEventsBySeq = emptyMap(),
        eventWitnessById = emptyMap(),
        eventIdBySeq = emptyMap(),
        notificationLedger = emptyMap(),
        notificationKeyByLifecycleEventId = emptyMap(),
        retiredTimelineEpochs = retiredTimelineEpochs,
        retiredEpochCompactionGeneration = retiredEpochCompactionGeneration,
        snapshotCheckpoint = null,
        snapshotNotificationSuppressedThroughAgentSeq = null,
        pendingStatusRequest = null,
        pendingSnapshotRequest = null,
        requiresSnapshot = false,
        requiresTimelineRotation = false,
    )
}

private val UINT64_MAX = BigInteger("18446744073709551615")
private val CANONICAL_COUNTER = Regex("^(?:0|[1-9][0-9]*)$")
private val SHA256_BASE64URL_PATTERN = Regex("^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$")
private const val PRODUCTION_MAX_APPLIED_EVENT_EVIDENCE = 4_096
private const val PRODUCTION_MAX_EVENT_IDENTITY_WITNESSES = 4_096
private const val PRODUCTION_MAX_LIFECYCLE_RECORDS = 2_048
private const val PRODUCTION_MAX_EVER_TURN_MARKERS = 2_048
private const val PRODUCTION_MAX_NOTIFICATION_LEDGER_ENTRIES = 4_096
private const val PRODUCTION_MAX_SNAPSHOT_RECORDS = 2_048
private const val PRODUCTION_MAX_NOTIFICATION_DECISIONS_PER_REDUCTION = 64
private const val PRODUCTION_MAX_RETIRED_TIMELINE_EPOCHS = 256
private const val MAX_OPAQUE_ID_UTF8_BYTES = 128

internal fun requireOpaqueId(value: String?, label: String) {
    require(!value.isNullOrBlank()) { "$label is required" }
    require(value == value.trim()) { "$label cannot contain outer whitespace" }
    require(!value.contains('\u0000')) { "$label contains NUL" }
    val encoder = StandardCharsets.UTF_8.newEncoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
    require(encoder.canEncode(value)) { "$label is not well-formed Unicode" }
    require(value.toByteArray(StandardCharsets.UTF_8).size <= MAX_OPAQUE_ID_UTF8_BYTES) {
        "$label exceeds $MAX_OPAQUE_ID_UTF8_BYTES UTF-8 bytes"
    }
}

private fun requireCanonicalCounter(value: String, label: String) {
    require(CANONICAL_COUNTER.matches(value)) { "$label is not canonical" }
    require(BigInteger(value) <= UINT64_MAX) { "$label exceeds uint64" }
}

private fun compareCounters(left: String, right: String): Int =
    BigInteger(left).compareTo(BigInteger(right))

private fun incrementCounterOrNull(value: String): String? {
    val next = BigInteger(value) + BigInteger.ONE
    return next.takeIf { it <= UINT64_MAX }?.toString()
}

private fun isNotificationCandidate(
    scope: AgentLifecycleScope,
    state: AgentLifecycleState,
): Boolean = when (scope) {
    AgentLifecycleScope.TURN -> state == AgentLifecycleState.WAITING_FOR_USER ||
        state == AgentLifecycleState.FAILED ||
        state == AgentLifecycleState.COMPLETED
    AgentLifecycleScope.RUN -> state == AgentLifecycleState.FAILED ||
        state == AgentLifecycleState.COMPLETED
}

private fun hasValidLifecycleGraph(records: Collection<AgentLifecycleRecord>): Boolean =
    records.groupBy { it.identity.runId }.values.all { runRecords ->
        if (runRecords.map { it.sourceEpoch }.toSet().size != 1) return@all false
        val run = runRecords.singleOrNull { it.identity.scope == AgentLifecycleScope.RUN }
        val turns = runRecords.filter { it.identity.scope == AgentLifecycleScope.TURN }
        if (turns.count { !it.state.terminal } > 1) return@all false
        if (run?.state?.terminal == true && turns.any { !it.state.terminal }) return@all false
        if (run?.state == AgentLifecycleState.WAITING_FOR_USER &&
            turns.any { !it.state.terminal && it.state != AgentLifecycleState.WAITING_FOR_USER }
        ) return@all false
        true
    }
