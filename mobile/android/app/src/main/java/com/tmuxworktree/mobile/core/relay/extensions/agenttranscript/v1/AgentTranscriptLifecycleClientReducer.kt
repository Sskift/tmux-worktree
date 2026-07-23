package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateLimits
import java.math.BigInteger
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
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

/** Host limits after intersecting the four frozen fields with immutable Android caps. */
internal data class AgentTimelineEffectiveLimits(
    val maxTextUtf8Bytes: Long,
    val maxPageRecords: Long,
    val eventReplayRetentionMs: Long,
    val snapshotLeaseMs: Long,
) {
    init {
        require(maxTextUtf8Bytes in 1..PRODUCTION_MAX_TEXT_UTF8_BYTES)
        require(maxPageRecords in 1..PRODUCTION_MAX_PAGE_RECORDS)
        require(
            eventReplayRetentionMs in
                MIN_EVENT_REPLAY_RETENTION_MS..PRODUCTION_MAX_EVENT_REPLAY_RETENTION_MS,
        )
        require(snapshotLeaseMs in 1..PRODUCTION_MAX_SNAPSHOT_LEASE_MS)
    }

    companion object {
        fun intersect(
            maxTextUtf8Bytes: Long,
            maxPageRecords: Long,
            eventReplayRetentionMs: Long,
            snapshotLeaseMs: Long,
        ): AgentTimelineEffectiveLimits {
            require(maxTextUtf8Bytes > 0)
            require(maxPageRecords > 0)
            require(eventReplayRetentionMs >= MIN_EVENT_REPLAY_RETENTION_MS)
            require(snapshotLeaseMs > 0)
            return AgentTimelineEffectiveLimits(
                maxTextUtf8Bytes = maxTextUtf8Bytes.coerceAtMost(PRODUCTION_MAX_TEXT_UTF8_BYTES),
                maxPageRecords = maxPageRecords.coerceAtMost(PRODUCTION_MAX_PAGE_RECORDS),
                eventReplayRetentionMs = eventReplayRetentionMs
                    .coerceAtMost(PRODUCTION_MAX_EVENT_REPLAY_RETENTION_MS),
                snapshotLeaseMs = snapshotLeaseMs.coerceAtMost(PRODUCTION_MAX_SNAPSHOT_LEASE_MS),
            )
        }
    }
}

internal data class AgentReplayPageFence(
    val localGeneration: String,
    val stableAfterAgentSeq: String,
    val currentRequestNetworkToken: String,
    val pinnedReplayThroughAgentSeq: String?,
    val expectedNextCursor: String?,
    val requestedLimit: Long,
) {
    init {
        requireCanonicalCounter(localGeneration, "Replay request generation")
        requireCanonicalCounter(stableAfterAgentSeq, "Replay stable after sequence")
        requireOpaqueId(currentRequestNetworkToken, "Replay network token")
        pinnedReplayThroughAgentSeq?.let {
            requireCanonicalCounter(it, "Pinned replay through sequence")
            require(compareCounters(it, stableAfterAgentSeq) >= 0)
        }
        expectedNextCursor?.let { requireAgentTimelineCursor(it, "Replay cursor") }
        require(requestedLimit in 1..PRODUCTION_MAX_PAGE_RECORDS)
        require(pinnedReplayThroughAgentSeq != null || expectedNextCursor == null) {
            "A pre-first replay request cannot own a continuation cursor"
        }
        require(pinnedReplayThroughAgentSeq == null || expectedNextCursor != null) {
            "An unfinished pinned replay cut must own a continuation cursor"
        }
    }
}

internal sealed interface AgentTimelineSyncState {
    data object Current : AgentTimelineSyncState

    /** Status observations choose replay; only the first exact page freezes its through cut. */
    data class Replay(
        val observedCurrentAgentSeq: String,
        val observedStatusEarliestReplaySeq: String,
        val pageFence: AgentReplayPageFence? = null,
    ) : AgentTimelineSyncState {
        init {
            requireCanonicalCounter(observedCurrentAgentSeq, "Observed current Agent sequence")
            requireCanonicalCounter(
                observedStatusEarliestReplaySeq,
                "Observed status replay floor",
            )
            require(observedCurrentAgentSeq != "0")
            require(observedStatusEarliestReplaySeq != "0")
            require(compareCounters(observedStatusEarliestReplaySeq, observedCurrentAgentSeq) <= 0)
        }
    }

    data object Snapshot : AgentTimelineSyncState

    /** One sync fact, including the legacy-v1 requirement that the next status select snapshot. */
    data class StatusRefresh(
        val requireSnapshotAfterRefresh: Boolean = false,
    ) : AgentTimelineSyncState
}

internal sealed interface AgentTimelineSyncDirective {
    data object None : AgentTimelineSyncDirective

    data class Replay(
        val lineage: AgentTimelineLineage,
        val afterAgentSeq: String,
        val cursor: String?,
        val limit: Long,
    ) : AgentTimelineSyncDirective

    data class Snapshot(val lineage: AgentTimelineLineage) : AgentTimelineSyncDirective
    data object StatusRefresh : AgentTimelineSyncDirective
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

/** Durable only until exact page zero creates Room B; B exclusively owns continuation. */
internal data class AgentSnapshotPreFirstFence(
    val localGeneration: String,
    val snapshotRequestId: String,
    val pageZeroNetworkToken: String,
) {
    init {
        requireCanonicalCounter(localGeneration, "Snapshot request generation")
        requireOpaqueId(snapshotRequestId, "Snapshot request ID")
        requireOpaqueId(pageZeroNetworkToken, "Snapshot page-zero network token")
    }
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

internal enum class AgentTimelineEntryRole {
    USER,
    AGENT,
}

internal enum class AgentTimelineRedactionReason {
    USER_REQUEST,
    POLICY,
    RETENTION,
}

internal data class AgentTimelineVisibleEntry(
    val entryId: String,
    val runId: String,
    val turnId: String,
    val role: AgentTimelineEntryRole,
    val commandId: String?,
    val createdAtMs: Long,
    val createdAgentSeq: String,
    val lastModifiedAgentSeq: String,
    val text: String,
) {
    init {
        requireOpaqueId(entryId, "Entry ID")
        requireOpaqueId(runId, "Entry run ID")
        requireOpaqueId(turnId, "Entry turn ID")
        commandId?.let { requireOpaqueId(it, "Entry command ID") }
        require(createdAtMs in 0..MAX_WIRE_INTEGER)
        requireCanonicalCounter(createdAgentSeq, "Entry created sequence")
        requireCanonicalCounter(lastModifiedAgentSeq, "Entry last-modified sequence")
        require(createdAgentSeq != "0")
        require(createdAgentSeq == lastModifiedAgentSeq) {
            "A visible append must be created and last-modified by the same event"
        }
        require(role != AgentTimelineEntryRole.AGENT || commandId == null) {
            "Agent entries cannot carry a command ID"
        }
        require(!text.contains('\u0000')) { "Entry text contains NUL" }
        require(utf8LengthStrict(text) <= PRODUCTION_MAX_TEXT_UTF8_BYTES) {
            "Entry text exceeds the Android production cap"
        }
    }
}

internal enum class AgentSourceAvailabilityReason {
    SOURCE_DISCONNECTED,
    SOURCE_RESTARTED,
}

/** The reducer's sole closed mutation union; transport DTOs are adapted once at ingress. */
internal sealed interface AgentTimelineMutation {
    data class Append(val entry: AgentTimelineVisibleEntry) : AgentTimelineMutation

    data class Redact(
        val entryId: String,
        val reason: AgentTimelineRedactionReason,
    ) : AgentTimelineMutation {
        init {
            requireOpaqueId(entryId, "Redacted entry ID")
        }
    }

    data class Delete(
        val entryId: String,
        val reason: AgentTimelineRedactionReason,
    ) : AgentTimelineMutation {
        init {
            requireOpaqueId(entryId, "Deleted entry ID")
        }
    }

    data class Lifecycle(val record: AgentLifecycleRecord) : AgentTimelineMutation

    data class SourceAvailability(
        val state: AgentLiveSourceState,
        val sourceEpoch: String,
        val reason: AgentSourceAvailabilityReason?,
    ) : AgentTimelineMutation {
        init {
            requireOpaqueId(sourceEpoch, "Source availability epoch")
            require(
                (state != AgentLiveSourceState.CONNECTED ||
                    reason != AgentSourceAvailabilityReason.SOURCE_DISCONNECTED) &&
                    (state != AgentLiveSourceState.INTERRUPTED ||
                        reason != AgentSourceAvailabilityReason.SOURCE_RESTARTED),
            ) { "Source availability reason contradicts its state" }
        }
    }
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
    val failure: AgentLifecycleFailure?,
    val occurredAtMs: Long,
    val agentEventSeq: String,
) {
    init {
        requireOpaqueId(lifecycleEventId, "Lifecycle event ID")
        requireOpaqueId(sourceEpoch, "Source epoch")
        require((state == AgentLifecycleState.FAILED) == (failure != null)) {
            "Failed lifecycle state and failure evidence must be present together"
        }
        require(occurredAtMs in 0..MAX_WIRE_INTEGER)
        requireCanonicalCounter(agentEventSeq, "Lifecycle event sequence")
    }
}

internal data class AgentLifecycleFailure(
    val code: String,
    val summary: String?,
) {
    init {
        requireOpaqueId(code, "Lifecycle failure code")
        summary?.let {
            require(!it.contains('\u0000')) { "Lifecycle failure summary contains NUL" }
            require(utf8LengthStrict(it) <= MAX_FAILURE_SUMMARY_UTF8_BYTES) {
                "Lifecycle failure summary exceeds the frozen UTF-8 limit"
            }
        }
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
    val failure: AgentLifecycleFailure?,
    val occurredAtMs: Long,
    val closedEventDigest: AgentClosedEventDigest?,
) {
    init {
        requireOpaqueId(eventId, "Event ID")
        requireCanonicalCounter(agentEventSeq, "Event identity sequence")
        require(agentEventSeq != "0") { "Event identity sequence starts at one" }
        requireOpaqueId(sourceEpoch, "Source epoch")
        require((state == AgentLifecycleState.FAILED) == (failure != null))
        require(occurredAtMs in 0..MAX_WIRE_INTEGER)
    }

    fun matches(record: AgentLifecycleRecord): Boolean =
        eventId == record.lifecycleEventId &&
            agentEventSeq == record.agentEventSeq &&
            lifecycleIdentity == record.identity &&
            sourceEpoch == record.sourceEpoch &&
            state == record.state &&
            failure == record.failure &&
            occurredAtMs == record.occurredAtMs
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
    val waitingForUser: Boolean = false,
    val failed: Boolean = false,
    val completed: Boolean = false,
) {
    fun allows(state: AgentLifecycleState): Boolean = when (state) {
        AgentLifecycleState.WAITING_FOR_USER -> waitingForUser
        AgentLifecycleState.FAILED -> failed
        AgentLifecycleState.COMPLETED -> completed
        AgentLifecycleState.RUNNING -> false
    }
}

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
        val extension = clientState.extensionLane
        val ledgerEntry = extension.notificationLedger[dedupeKey] ?: return false
        val eventIdentity = ledgerEntry.eventIdentity
        val currentRecord = extension.currentSourceLifecycleOrNull(eventIdentity.lifecycleIdentity)
        return isPreflightAuthorizedBy(clientState, ledgerEntry, currentRecord)
    }

    internal fun isPreflightAuthorizedBy(
        clientState: AgentTranscriptLifecycleClientState,
        ledgerEntry: AgentNotificationLedgerEntry,
        currentRecord: AgentLifecycleRecord?,
    ): Boolean {
        val identity = clientState.identity
        val extension = clientState.extensionLane
        val eventIdentity = ledgerEntry.eventIdentity
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
            extension.syncState !is AgentTimelineSyncState.StatusRefresh &&
            localGeneration == extension.localGeneration &&
            ledgerEntry.localGeneration == localGeneration &&
            ledgerEntry.disposition == AgentNotificationDisposition.SHOWN &&
            eventIdentity.eventId == dedupeKey.lifecycleEventId &&
            eventIdentity.state == dedupeKey.state &&
            isNotificationCandidate(eventIdentity.lifecycleIdentity.scope, dedupeKey.state) &&
            currentRecord != null && eventIdentity.matches(currentRecord) &&
            clientState.notificationConfig.profileActive &&
            clientState.notificationConfig.permission == AgentNotificationPermission.GRANTED &&
            clientState.notificationConfig.policy == AgentNotificationPolicy.ALLOW &&
            clientState.notificationConfig.allows(dedupeKey.state)
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
    val effectiveHostLimits: AgentTimelineEffectiveLimits? = null,
    val syncState: AgentTimelineSyncState = AgentTimelineSyncState.Current,
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
    val pendingSnapshotRequest: AgentSnapshotPreFirstFence? = null,
    val requiresTimelineRotation: Boolean = false,
) {
    val requiresSnapshot: Boolean
        get() = syncState == AgentTimelineSyncState.Snapshot

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
        val compatibilityRefresh =
            (syncState as? AgentTimelineSyncState.StatusRefresh)
                ?.requireSnapshotAfterRefresh == true
        require(
            support == AgentExtensionSupport.AVAILABLE ||
                syncState == AgentTimelineSyncState.Current ||
                compatibilityRefresh,
        ) { "Only the legacy-incomplete refresh marker may cross unavailable support" }
        require(support == AgentExtensionSupport.AVAILABLE || effectiveHostLimits == null) {
            "Only an available extension may own host limits"
        }
        require(
            support != AgentExtensionSupport.AVAILABLE ||
                effectiveHostLimits != null ||
                syncState is AgentTimelineSyncState.StatusRefresh,
        ) { "An available current/syncing extension must own effective host limits" }
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
            require(syncState == AgentTimelineSyncState.Snapshot) {
                "A pre-first snapshot fence requires snapshot synchronization"
            }
        }
        (syncState as? AgentTimelineSyncState.Replay)?.pageFence?.let { fence ->
            require(fence.localGeneration == localGeneration) { "Replay request generation is stale" }
            require(compareCounters(fence.stableAfterAgentSeq, lastAgentSeq) <= 0) {
                "Replay stable after sequence is ahead of the durable cursor"
            }
            fence.pinnedReplayThroughAgentSeq?.let {
                require(compareCounters(lastAgentSeq, it) <= 0) {
                    "Replay cursor is ahead of its pinned through cut"
                }
            }
            require(fence.requestedLimit <= (effectiveHostLimits?.maxPageRecords ?: 0L)) {
                "Replay request limit exceeds the effective host limit"
            }
        }
        require(
            !requiresTimelineRotation ||
                syncState == AgentTimelineSyncState.Snapshot ||
                (syncState as? AgentTimelineSyncState.StatusRefresh)
                    ?.requireSnapshotAfterRefresh == true,
        ) {
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
        val expectedEventIdBySeq = linkedMapOf<String, String>()
        appliedEventsBySeq.forEach { (sequence, evidence) ->
            val existing = expectedEventIdBySeq.put(sequence, evidence.eventId)
            require(existing == null || existing == evidence.eventId) {
                "Applied event evidence conflicts at one sequence"
            }
        }
        eventWitnessById.values.forEach { witness ->
            val existing = expectedEventIdBySeq.put(witness.agentEventSeq, witness.eventId)
            require(existing == null || existing == witness.eventId) {
                "Lifecycle witness conflicts at one sequence"
            }
        }
        require(expectedEventIdBySeq.values.toSet().size == expectedEventIdBySeq.size) {
            "One event ID cannot bind multiple sequences"
        }
        require(eventIdBySeq == expectedEventIdBySeq) { "Event sequence index is inconsistent" }
        eventWitnessById.forEach { (eventId, witness) ->
            require(eventId == witness.eventId) { "Event witness key is inconsistent" }
            require(eventIdBySeq[witness.agentEventSeq] == eventId) {
                "Event sequence index is inconsistent"
            }
            require(compareCounters(witness.agentEventSeq, lastAgentSeq) <= 0) {
                "Event identity witness is ahead of the cursor"
            }
        }
        require(hasValidPermanentLifecycleWitnessChains(eventWitnessById.values)) {
            "Permanent lifecycle witness chain is inconsistent"
        }
        appliedEventsBySeq.forEach { (sequence, evidence) ->
            val witness = eventWitnessById[evidence.eventId]
            require(eventIdBySeq[sequence] == evidence.eventId) {
                "Applied evidence is not bound to its event identity"
            }
            require(
                witness == null ||
                    witness.agentEventSeq == sequence &&
                    witness.closedEventDigest == evidence.closedEventDigest,
            ) { "Lifecycle evidence is not bound to its event identity" }
        }
        lifecycleByIdentity.forEach { (identity, record) ->
            val witness = eventWitnessById[record.lifecycleEventId]
            val highestWitness = highestLifecycleWitness(eventWitnessById.values, identity)
            require(
                witness != null &&
                    witness.lifecycleIdentity == identity &&
                    witness.matches(record) &&
                    highestWitness == witness,
            ) {
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
            !requiresSnapshot &&
            syncState !is AgentTimelineSyncState.StatusRefresh
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
    data class StatusRequestStarted(
        val requestNetworkToken: String,
    ) : AgentTranscriptLifecycleControlInput {
        init {
            requireOpaqueId(requestNetworkToken, "Status network token")
        }
    }

    data class SnapshotRequestStarted(
        val snapshotRequestId: String,
        val pageZeroNetworkToken: String,
    ) : AgentTranscriptLifecycleControlInput {
        init {
            requireOpaqueId(snapshotRequestId, "Snapshot request ID")
            requireOpaqueId(pageZeroNetworkToken, "Snapshot page-zero network token")
        }
    }

    data class SnapshotPageZeroAccepted(
        val fence: AgentSnapshotPreFirstFence,
    ) : AgentTranscriptLifecycleClientInput

    /** Persist this exact token/cursor fence before sending a replay request. */
    data class ReplayRequestStarted(
        val requestNetworkToken: String,
        val cursor: String?,
        val limit: Long,
    ) : AgentTranscriptLifecycleControlInput {
        init {
            requireOpaqueId(requestNetworkToken, "Replay network token")
            cursor?.let { requireAgentTimelineCursor(it, "Replay cursor") }
            require(limit in 1..PRODUCTION_MAX_PAGE_RECORDS)
        }
    }

    /** Trusted durable-owner proof that one exact persisted request completed with an error. */
    data class CorrelatedRequestFailed(
        val requestKind: AgentTranscriptLifecycleRequestKind,
        val requestNetworkToken: String,
        val requestLocalGeneration: String,
        val snapshotContinuation: Boolean = false,
    ) : AgentTranscriptLifecycleClientInput {
        init {
            requireOpaqueId(requestNetworkToken, "Correlated error request token")
            requireCanonicalCounter(requestLocalGeneration, "Correlated error generation")
            require(!snapshotContinuation || requestKind == AgentTranscriptLifecycleRequestKind.SNAPSHOT)
        }
    }

    data class ClientConfigChanged(
        val config: AgentNotificationConfig,
    ) : AgentTranscriptLifecycleControlInput

    data class StatusAvailable(
        val authority: AgentTranscriptLifecycleDurableConsumerIdentity,
        val lineage: AgentTimelineLineage,
        val requestFence: AgentLocalRequestFence,
        val liveSource: AgentLiveSourceState,
        val activeSourceEpoch: String,
        val currentAgentSeq: String,
        val earliestReplaySeq: String,
        val hostLimits: AgentTimelineEffectiveLimits,
    ) : AgentTranscriptLifecycleControlInput {
        init {
            requireOpaqueId(activeSourceEpoch, "Active source epoch")
            requireCanonicalCounter(currentAgentSeq, "Current Agent sequence")
            requireCanonicalCounter(earliestReplaySeq, "Earliest replay sequence")
            require(currentAgentSeq != "0") { "Available status sequence starts at one" }
            require(earliestReplaySeq != "0") { "Replay floor starts at one" }
            require(authority.sessionIdentity == lineage.session) {
                "Status authority does not match its session lineage"
            }
            require(compareCounters(earliestReplaySeq, currentAgentSeq) <= 0) {
                "Replay floor is ahead of the observed current sequence"
            }
        }
    }

    data class StatusUnavailable(
        val sessionIdentity: AgentExtensionSessionIdentity,
        val requestFence: AgentLocalRequestFence,
        val reason: AgentExtensionUnavailableReason,
    ) : AgentTranscriptLifecycleControlInput

    data object ExtensionNotNegotiated : AgentTranscriptLifecycleControlInput
    data object ExtensionNegotiated : AgentTranscriptLifecycleControlInput

    data class AgentEvent(
        val lineage: AgentTimelineLineage,
        val agentEventSeq: String,
        val eventId: String,
        val closedEventDigest: AgentClosedEventDigest,
        val mutation: AgentTimelineMutation,
        val provenance: AgentEventProvenance,
    ) : AgentTranscriptLifecycleClientInput {
        init {
            requireCanonicalCounter(agentEventSeq, "Agent event sequence")
            require(agentEventSeq != "0") { "Agent event sequence starts at one" }
            requireOpaqueId(eventId, "Event ID")
            AgentAppliedEventEvidence(eventId, closedEventDigest)
            when (mutation) {
                is AgentTimelineMutation.Append -> require(
                    mutation.entry.createdAgentSeq == agentEventSeq &&
                        mutation.entry.lastModifiedAgentSeq == agentEventSeq,
                ) { "Appended entry is not bound to its event sequence" }
                is AgentTimelineMutation.Lifecycle -> require(
                    mutation.record.agentEventSeq == agentEventSeq &&
                        mutation.record.lifecycleEventId == eventId,
                ) { "Lifecycle record is not bound to its event identity" }
                is AgentTimelineMutation.Redact,
                is AgentTimelineMutation.Delete,
                is AgentTimelineMutation.SourceAvailability,
                -> Unit
            }
        }
    }

    /** Page proof after all event variants in this page applied in the same transaction. */
    data class ReplayPageApplied(
        val lineage: AgentTimelineLineage,
        val requestNetworkToken: String,
        val requestCursor: String?,
        val stableAfterAgentSeq: String,
        val replayThroughAgentSeq: String,
        val pageStartAgentSeq: String,
        val eventCount: Long,
        val requestLimit: Long,
        val isLast: Boolean,
        val nextCursor: String?,
    ) : AgentTranscriptLifecycleClientInput {
        init {
            requireOpaqueId(requestNetworkToken, "Replay response network token")
            requestCursor?.let { requireAgentTimelineCursor(it, "Replay response cursor") }
            requireCanonicalCounter(stableAfterAgentSeq, "Replay stable after sequence")
            requireCanonicalCounter(replayThroughAgentSeq, "Replay through sequence")
            requireCanonicalCounter(pageStartAgentSeq, "Replay page start sequence")
            require(eventCount in 0..PRODUCTION_MAX_PAGE_RECORDS)
            require(requestLimit in 1..PRODUCTION_MAX_PAGE_RECORDS)
            nextCursor?.let { requireAgentTimelineCursor(it, "Replay next cursor") }
            require(isLast == (nextCursor == null)) { "Replay final/cursor shape is invalid" }
        }
    }

    data class SnapshotCommit(
        val lineage: AgentTimelineLineage,
        val localGeneration: String,
        val throughAgentSeq: String,
        val records: List<AgentLifecycleRecord>,
    ) : AgentTranscriptLifecycleClientInput {
        init {
            requireCanonicalCounter(localGeneration, "Snapshot commit generation")
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
    ) : AgentTranscriptLifecycleControlInput {
        init {
            requireOpaqueId(previousTimelineEpoch, "Previous timeline epoch")
            newTimelineEpoch?.let { requireOpaqueId(it, "New timeline epoch") }
        }
    }
}

/** Payload-free durable operations that may enter the repository's control-only transaction. */
internal sealed interface AgentTranscriptLifecycleControlInput :
    AgentTranscriptLifecycleClientInput

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
    val syncDirective: AgentTimelineSyncDirective = AgentTimelineSyncDirective.None,
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
        is AgentTranscriptLifecycleClientInput.StatusRequestStarted ->
            reduceStatusRequestStarted(state, input)
        is AgentTranscriptLifecycleClientInput.SnapshotRequestStarted ->
            reduceSnapshotRequestStarted(state, input)
        is AgentTranscriptLifecycleClientInput.SnapshotPageZeroAccepted ->
            reduceSnapshotPageZeroAccepted(state, input)
        is AgentTranscriptLifecycleClientInput.ReplayRequestStarted ->
            reduceReplayRequestStarted(state, input)
        is AgentTranscriptLifecycleClientInput.CorrelatedRequestFailed ->
            reduceCorrelatedRequestFailed(state, input)
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
        is AgentTranscriptLifecycleClientInput.ReplayPageApplied ->
            reduceReplayPageApplied(state, input)
        is AgentTranscriptLifecycleClientInput.SnapshotCommit -> reduceSnapshot(state, input, limits)
        is AgentTranscriptLifecycleClientInput.TimelineReset -> reduceTimelineReset(state, input, limits)
    }

    private fun reduceStatusRequestStarted(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput.StatusRequestStarted,
    ): AgentTranscriptLifecycleClientReduction {
        val extension = state.extensionLane
        if (extension.support == AgentExtensionSupport.UNNEGOTIATED) {
            return inactive(state)
        }
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(
                extensionLane = extension.copy(
                    pendingStatusRequest = AgentLocalRequestFence(
                        extension.localGeneration,
                        input.requestNetworkToken,
                    ),
                ),
            ),
            disposition = AgentClientDisposition.CONFIG_APPLIED,
        )
    }

    private fun reduceSnapshotRequestStarted(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput.SnapshotRequestStarted,
    ): AgentTranscriptLifecycleClientReduction {
        val extension = state.extensionLane
        if (extension.support != AgentExtensionSupport.AVAILABLE ||
            extension.timelineEpoch == null ||
            extension.syncState != AgentTimelineSyncState.Snapshot
        ) return inactive(state)
        val fence = AgentSnapshotPreFirstFence(
            localGeneration = extension.localGeneration,
            snapshotRequestId = input.snapshotRequestId,
            pageZeroNetworkToken = input.pageZeroNetworkToken,
        )
        return AgentTranscriptLifecycleClientReduction(
            state.copy(extensionLane = extension.copy(pendingSnapshotRequest = fence)),
            AgentClientDisposition.CONFIG_APPLIED,
        )
    }

    private fun reduceSnapshotPageZeroAccepted(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput.SnapshotPageZeroAccepted,
    ): AgentTranscriptLifecycleClientReduction {
        val extension = state.extensionLane
        if (extension.support != AgentExtensionSupport.AVAILABLE ||
            extension.syncState != AgentTimelineSyncState.Snapshot ||
            extension.pendingSnapshotRequest != input.fence
        ) return continuityConflict(state)
        return AgentTranscriptLifecycleClientReduction(
            state.copy(extensionLane = extension.copy(pendingSnapshotRequest = null)),
            AgentClientDisposition.CONFIG_APPLIED,
        )
    }

    private fun reduceReplayRequestStarted(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput.ReplayRequestStarted,
    ): AgentTranscriptLifecycleClientReduction {
        val extension = state.extensionLane
        val replay = extension.syncState as? AgentTimelineSyncState.Replay
            ?: return inactive(state)
        val effectiveLimit = extension.effectiveHostLimits?.maxPageRecords
            ?: return continuityConflict(state)
        if (input.limit > effectiveLimit) return continuityConflict(state)
        val currentFence = replay.pageFence
        if (currentFence == null && input.cursor != null ||
            currentFence != null && input.cursor != currentFence.expectedNextCursor ||
            currentFence != null && input.limit != currentFence.requestedLimit
        ) return continuityConflict(state)
        val nextFence = AgentReplayPageFence(
            localGeneration = extension.localGeneration,
            stableAfterAgentSeq = currentFence?.stableAfterAgentSeq ?: extension.lastAgentSeq,
            currentRequestNetworkToken = input.requestNetworkToken,
            pinnedReplayThroughAgentSeq = currentFence?.pinnedReplayThroughAgentSeq,
            expectedNextCursor = input.cursor,
            requestedLimit = input.limit,
        )
        return AgentTranscriptLifecycleClientReduction(
            state.copy(extensionLane = extension.copy(syncState = replay.copy(pageFence = nextFence))),
            AgentClientDisposition.CONFIG_APPLIED,
        )
    }

    private fun reduceCorrelatedRequestFailed(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput.CorrelatedRequestFailed,
    ): AgentTranscriptLifecycleClientReduction {
        val previous = state.extensionLane
        if (previous.support == AgentExtensionSupport.UNNEGOTIATED ||
            previous.localGeneration != input.requestLocalGeneration
        ) return continuityConflict(state)
        val ownsExactRequest = when (input.requestKind) {
            AgentTranscriptLifecycleRequestKind.STATUS ->
                previous.pendingStatusRequest == AgentLocalRequestFence(
                    input.requestLocalGeneration,
                    input.requestNetworkToken,
                )
            AgentTranscriptLifecycleRequestKind.REPLAY ->
                (previous.syncState as? AgentTimelineSyncState.Replay)?.pageFence?.let { page ->
                    page.localGeneration == input.requestLocalGeneration &&
                        page.currentRequestNetworkToken == input.requestNetworkToken
                } == true
            AgentTranscriptLifecycleRequestKind.SNAPSHOT -> if (input.snapshotContinuation) {
                previous.syncState == AgentTimelineSyncState.Snapshot &&
                    previous.pendingSnapshotRequest == null
            } else {
                previous.pendingSnapshotRequest?.let { pending ->
                    pending.localGeneration == input.requestLocalGeneration &&
                        pending.pageZeroNetworkToken == input.requestNetworkToken
                } == true
            }
        }
        if (!ownsExactRequest) return continuityConflict(state)
        val nextGeneration = incrementCounterOrNull(previous.localGeneration)
            ?: return continuityConflict(state)
        val requireSnapshot = input.requestKind != AgentTranscriptLifecycleRequestKind.STATUS ||
            previous.support != AgentExtensionSupport.AVAILABLE ||
            previous.syncState == AgentTimelineSyncState.Snapshot ||
            (previous.syncState as? AgentTimelineSyncState.StatusRefresh)
                ?.requireSnapshotAfterRefresh == true ||
            previous.requiresTimelineRotation
        val extension = previous.copy(
            localGeneration = nextGeneration,
            syncState = AgentTimelineSyncState.StatusRefresh(requireSnapshot),
            pendingStatusRequest = null,
            pendingSnapshotRequest = null,
        )
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(extensionLane = extension),
            disposition = AgentClientDisposition.GAP_RESYNC,
            syncDirective = AgentTimelineSyncDirective.StatusRefresh,
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
        val nextSync = when (val sync = extension.syncState) {
            AgentTimelineSyncState.Current -> AgentTimelineSyncState.Current
            AgentTimelineSyncState.Snapshot -> AgentTimelineSyncState.Snapshot
            is AgentTimelineSyncState.Replay -> AgentTimelineSyncState.StatusRefresh()
            is AgentTimelineSyncState.StatusRefresh -> sync
        }
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(
                extensionLane = extension.copy(
                    localGeneration = nextGeneration,
                    syncState = nextSync,
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
            return continuityConflict(state)
        }
        val sameLineage = previous.timelineEpoch == input.lineage.timelineEpoch
        val selectedSync = when {
            !sameLineage -> AgentTimelineSyncState.Snapshot
            compareCounters(previous.lastAgentSeq, input.currentAgentSeq) > 0 ->
                AgentTimelineSyncState.StatusRefresh()
            previous.syncState == AgentTimelineSyncState.Snapshot ->
                AgentTimelineSyncState.Snapshot
            (previous.syncState as? AgentTimelineSyncState.StatusRefresh)
                ?.requireSnapshotAfterRefresh == true -> AgentTimelineSyncState.Snapshot
            previous.notificationBaselineAgentSeq == null -> AgentTimelineSyncState.Snapshot
            previous.lastAgentSeq == input.currentAgentSeq -> AgentTimelineSyncState.Current
            incrementCounterOrNull(previous.lastAgentSeq)?.let {
                compareCounters(it, input.earliestReplaySeq) >= 0
            } == true -> AgentTimelineSyncState.Replay(
                observedCurrentAgentSeq = input.currentAgentSeq,
                observedStatusEarliestReplaySeq = input.earliestReplaySeq,
            )
            else -> AgentTimelineSyncState.Snapshot
        }
        val extension = if (sameLineage) {
            val statusChanged = previous.support != AgentExtensionSupport.AVAILABLE ||
                previous.liveSource != input.liveSource ||
                previous.activeSourceEpoch != input.activeSourceEpoch ||
                previous.effectiveHostLimits != input.hostLimits ||
                previous.syncState != selectedSync
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
                effectiveHostLimits = input.hostLimits,
                syncState = selectedSync,
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
                effectiveHostLimits = input.hostLimits,
                syncState = AgentTimelineSyncState.Snapshot,
                retiredTimelineEpochs = retirement.epochs,
                retiredEpochCompactionGeneration = retirement.compactionGeneration,
            )
        }
        val directive = when (selectedSync) {
            AgentTimelineSyncState.Current -> AgentTimelineSyncDirective.None
            is AgentTimelineSyncState.Replay -> AgentTimelineSyncDirective.Replay(
                lineage = input.lineage,
                afterAgentSeq = extension.lastAgentSeq,
                cursor = null,
                limit = input.hostLimits.maxPageRecords,
            )
            AgentTimelineSyncState.Snapshot -> AgentTimelineSyncDirective.Snapshot(input.lineage)
            is AgentTimelineSyncState.StatusRefresh -> AgentTimelineSyncDirective.StatusRefresh
        }
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(extensionLane = extension),
            disposition = if (selectedSync is AgentTimelineSyncState.StatusRefresh) {
                AgentClientDisposition.CONTINUITY_CONFLICT
            } else {
                AgentClientDisposition.STATUS_APPLIED
            },
            syncDirective = directive,
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
            return continuityConflict(state)
        }
        val nextGeneration = incrementCounterOrNull(previous.localGeneration)
            ?: return continuityConflict(state)
        val inactiveSync = preserveSnapshotRequirementAcrossInactive(previous.syncState)
        val extension = previous.copy(
            localGeneration = nextGeneration,
            support = AgentExtensionSupport.UNAVAILABLE,
            unavailableReason = input.reason,
            liveSource = null,
            activeSourceEpoch = null,
            effectiveHostLimits = null,
            syncState = inactiveSync,
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
        val inactiveSync = preserveSnapshotRequirementAcrossInactive(previous.syncState)
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
            effectiveHostLimits = null,
            syncState = inactiveSync,
            pendingStatusRequest = null,
            pendingSnapshotRequest = null,
        )
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(extensionLane = extension),
            disposition = AgentClientDisposition.STATUS_APPLIED,
            syncDirective = if (
                negotiated && inactiveSync is AgentTimelineSyncState.StatusRefresh
            ) AgentTimelineSyncDirective.StatusRefresh else AgentTimelineSyncDirective.None,
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
            return continuityConflict(state)
        }
        val lifecycle = (input.mutation as? AgentTimelineMutation.Lifecycle)?.record

        val relation = compareCounters(input.agentEventSeq, extension.lastAgentSeq)
        if (relation <= 0) {
            val evidence = extension.appliedEventsBySeq[input.agentEventSeq]
            val witness = lifecycle?.let { extension.eventWitnessById[input.eventId] }
            val exact = evidence?.eventId == input.eventId &&
                evidence.closedEventDigest == input.closedEventDigest &&
                (lifecycle == null || witness?.matches(lifecycle) == true)
            if (exact) {
                return AgentTranscriptLifecycleClientReduction(
                    state = state,
                    disposition = AgentClientDisposition.DUPLICATE,
                )
            }
            return quarantine(state, AgentClientDisposition.CONTINUITY_CONFLICT)
        }
        if (extension.support != AgentExtensionSupport.AVAILABLE) {
            return if (input.provenance == AgentEventProvenance.REPLAY) inactive(state)
            else continuityConflict(state)
        }
        if (input.provenance == AgentEventProvenance.LIVE && extension.requiresSnapshot) {
            return continuityConflict(state)
        }
        if (input.provenance == AgentEventProvenance.LIVE &&
            extension.syncState != AgentTimelineSyncState.Current
        ) {
            return AgentTranscriptLifecycleClientReduction(
                state = state,
                disposition = AgentClientDisposition.GAP_RESYNC,
                syncDirective = syncDirective(state.identity, extension),
            )
        }
        if (input.provenance == AgentEventProvenance.REPLAY &&
            (extension.syncState as? AgentTimelineSyncState.Replay)?.pageFence == null
        ) return continuityConflict(state)
        if (input.provenance == AgentEventProvenance.LIVE) {
            val validLiveMutation = when (val mutation = input.mutation) {
                is AgentTimelineMutation.Lifecycle ->
                    extension.liveSource == AgentLiveSourceState.CONNECTED &&
                        extension.activeSourceEpoch == mutation.record.sourceEpoch
                is AgentTimelineMutation.SourceAvailability ->
                    extension.activeSourceEpoch == mutation.sourceEpoch &&
                        extension.liveSource != mutation.state
                is AgentTimelineMutation.Append,
                is AgentTimelineMutation.Redact,
                is AgentTimelineMutation.Delete,
                -> extension.liveSource == AgentLiveSourceState.CONNECTED
            }
            if (!validLiveMutation) {
                return quarantine(state, AgentClientDisposition.CONTINUITY_CONFLICT)
            }
        }
        val expectedSequence = incrementCounterOrNull(extension.lastAgentSeq)
            ?: return continuityConflict(state)
        if (input.agentEventSeq != expectedSequence) {
            return if (input.provenance == AgentEventProvenance.LIVE) {
                beginStatusRefresh(state)
            } else {
                quarantine(state, AgentClientDisposition.CONTINUITY_CONFLICT)
            }
        }
        if (input.eventId in extension.eventIdBySeq.values ||
            extension.eventIdBySeq[input.agentEventSeq]?.let { it != input.eventId } == true
        ) {
            return quarantine(state, AgentClientDisposition.CONTINUITY_CONFLICT)
        }
        if (lifecycle != null &&
            extension.eventWitnessById.size >= limits.maxEventIdentityWitnesses
        ) {
            return quarantine(state, requiresTimelineRotation = true)
        }
        if (extension.appliedEventsBySeq.size >= limits.maxAppliedEventEvidence) {
            return quarantine(state)
        }

        val application = lifecycle?.let { applyLifecycle(extension, it, limits) }
        when (application) {
            LifecycleApplicationResult.CapacityExceeded -> return quarantine(state)
            LifecycleApplicationResult.Invalid -> return quarantine(
                state,
                AgentClientDisposition.CONTINUITY_CONFLICT,
            )
            is LifecycleApplicationResult.Applied,
            null,
            -> Unit
        }
        val appliedLifecycle = application as? LifecycleApplicationResult.Applied
        val eventIdentity = lifecycle?.let {
            AgentLifecycleEventIdentityWitness(
                eventId = input.eventId,
                agentEventSeq = input.agentEventSeq,
                lifecycleIdentity = it.identity,
                sourceEpoch = it.sourceEpoch,
                state = it.state,
                failure = it.failure,
                occurredAtMs = it.occurredAtMs,
                closedEventDigest = input.closedEventDigest,
            )
        }
        val liveSource = if (input.provenance == AgentEventProvenance.LIVE &&
            input.mutation is AgentTimelineMutation.SourceAvailability
        ) {
            input.mutation.state
        } else {
            extension.liveSource
        }
        var nextExtension = extension.copy(
            lastAgentSeq = input.agentEventSeq,
            liveSource = liveSource,
            lifecycleByIdentity = appliedLifecycle?.lifecycleByIdentity
                ?: extension.lifecycleByIdentity,
            currentLifecycleIdentityByEventId = appliedLifecycle?.currentLifecycleIdentityByEventId
                ?: extension.currentLifecycleIdentityByEventId,
            runsWithTurnRecords = appliedLifecycle?.runsWithTurnRecords
                ?: extension.runsWithTurnRecords,
            appliedEventsBySeq = extension.appliedEventsBySeq +
                (
                    input.agentEventSeq to AgentAppliedEventEvidence(
                        input.eventId,
                        input.closedEventDigest,
                    )
                    ),
            eventWitnessById = if (eventIdentity == null) {
                extension.eventWitnessById
            } else {
                extension.eventWitnessById + (input.eventId to eventIdentity)
            },
            eventIdBySeq = extension.eventIdBySeq +
                (input.agentEventSeq to input.eventId),
        )
        var notificationDecisions = emptyList<AgentNotificationDecision>()
        if (lifecycle != null && eventIdentity != null) {
            val notification = recordNotificationCandidate(
                identity = state.identity,
                config = state.notificationConfig,
                extension = nextExtension,
                lifecycle = lifecycle,
                eventIdentity = eventIdentity,
                limits = limits,
            )
            if (notification.capacityExceeded) return quarantine(state)
            nextExtension = notification.extension
            notification.decision?.let { notificationDecisions = listOf(it) }
        }
        if (notificationDecisions.size > limits.maxNotificationDecisionsPerReduction) {
            return quarantine(state)
        }
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(extensionLane = nextExtension),
            disposition = AgentClientDisposition.APPLIED,
            notificationDecisions = notificationDecisions,
        )
    }

    private fun reduceReplayPageApplied(
        state: AgentTranscriptLifecycleClientState,
        input: AgentTranscriptLifecycleClientInput.ReplayPageApplied,
    ): AgentTranscriptLifecycleClientReduction {
        if (input.lineage.session != state.identity) return continuityConflict(state)
        val extension = state.extensionLane
        if (extension.support != AgentExtensionSupport.AVAILABLE ||
            extension.timelineEpoch != input.lineage.timelineEpoch
        ) return continuityConflict(state)
        val replay = extension.syncState as? AgentTimelineSyncState.Replay
            ?: return continuityConflict(state)
        val fence = replay.pageFence ?: return continuityConflict(state)
        if (fence.localGeneration != extension.localGeneration ||
            fence.currentRequestNetworkToken != input.requestNetworkToken ||
            fence.expectedNextCursor != input.requestCursor ||
            fence.stableAfterAgentSeq != input.stableAfterAgentSeq ||
            fence.requestedLimit != input.requestLimit ||
            input.eventCount > input.requestLimit ||
            compareCounters(input.pageStartAgentSeq, fence.stableAfterAgentSeq) < 0 ||
            compareCounters(input.pageStartAgentSeq, extension.lastAgentSeq) > 0 ||
            BigInteger(extension.lastAgentSeq) - BigInteger(input.pageStartAgentSeq) !=
            BigInteger.valueOf(input.eventCount) ||
            input.eventCount == 0L && input.pageStartAgentSeq != extension.lastAgentSeq
        ) return continuityConflict(state)
        if (fence.pinnedReplayThroughAgentSeq == null &&
            input.pageStartAgentSeq != fence.stableAfterAgentSeq
        ) return continuityConflict(state)
        val pinnedThrough = fence.pinnedReplayThroughAgentSeq ?: input.replayThroughAgentSeq
        if (input.replayThroughAgentSeq != pinnedThrough ||
            compareCounters(extension.lastAgentSeq, pinnedThrough) > 0
        ) return continuityConflict(state)

        return if (input.isLast) {
            if (input.nextCursor != null || extension.lastAgentSeq != pinnedThrough) {
                continuityConflict(state)
            } else {
                AgentTranscriptLifecycleClientReduction(
                    state.copy(
                        extensionLane = extension.copy(syncState = AgentTimelineSyncState.Current),
                    ),
                    AgentClientDisposition.CONFIG_APPLIED,
                )
            }
        } else {
            val nextCursor = input.nextCursor
            if (nextCursor == null ||
                input.eventCount == 0L ||
                compareCounters(extension.lastAgentSeq, pinnedThrough) >= 0
            ) {
                continuityConflict(state)
            } else {
                val nextReplay = replay.copy(
                    pageFence = fence.copy(
                        pinnedReplayThroughAgentSeq = pinnedThrough,
                        expectedNextCursor = nextCursor,
                    ),
                )
                AgentTranscriptLifecycleClientReduction(
                    state.copy(extensionLane = extension.copy(syncState = nextReplay)),
                    AgentClientDisposition.CONFIG_APPLIED,
                    syncDirective = AgentTimelineSyncDirective.Replay(
                        lineage = input.lineage,
                        afterAgentSeq = fence.stableAfterAgentSeq,
                        cursor = nextCursor,
                        limit = fence.requestedLimit,
                    ),
                )
            }
        }
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
        if (previous.syncState != AgentTimelineSyncState.Snapshot ||
            previous.pendingSnapshotRequest != null ||
            previous.localGeneration != input.localGeneration
        ) return continuityConflict(state)
        if (previous.requiresTimelineRotation ||
            previous.eventWitnessById.size >= limits.maxEventIdentityWitnesses
        ) {
            return continuityConflict(state)
        }
        if (input.records.size > limits.maxSnapshotRecords ||
            input.records.size > limits.maxLifecycleRecords
        ) {
            return continuityConflict(state)
        }
        if (input.records.size > limits.maxEventIdentityWitnesses) {
            return continuityConflict(state)
        }
        if (compareCounters(input.throughAgentSeq, previous.lastAgentSeq) < 0) {
            return continuityConflict(state)
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
                    (existingIdAtSeq == null || existingIdAtSeq == record.lifecycleEventId) &&
                    snapshotRecordPassesPermanentFence(previous, record)
            }
        if (!snapshotShapeValid) {
            return quarantine(state, AgentClientDisposition.CONTINUITY_CONFLICT)
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
                failure = record.failure,
                occurredAtMs = record.occurredAtMs,
                closedEventDigest = existing?.closedEventDigest,
            )
        }
        val eventWitnesses = previous.eventWitnessById + snapshotWitnesses
        if (eventWitnesses.size > limits.maxEventIdentityWitnesses) {
            return continuityConflict(state)
        }
        val eventIdBySeq = eventWitnesses.values.associate {
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
            return continuityConflict(state)
        }
        val retainedNotificationLedger = previous.notificationLedger.filter { (_, entry) ->
            val record = lifecycle[entry.eventIdentity.lifecycleIdentity]
            val witness = eventWitnesses[entry.eventIdentity.eventId]
            record != null &&
                witness == entry.eventIdentity &&
                entry.eventIdentity.matches(record)
        }
        if (retainedNotificationLedger.size > limits.maxNotificationLedgerEntries) {
            return continuityConflict(state)
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
            effectiveHostLimits = previous.effectiveHostLimits,
            syncState = AgentTimelineSyncState.Current,
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
        )
        val decisions = mutableListOf<AgentNotificationDecision>()
        if (!initialSnapshotForLineage) {
            lifecycle.values
                .sortedWith(
                    Comparator { left, right ->
                        compareCanonicalAgentOrder(
                            left.agentEventSeq,
                            left.lifecycleEventId,
                            right.agentEventSeq,
                            right.lifecycleEventId,
                        )
                    },
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
        val permanentFence = highestLifecycleWitness(
            extension.eventWitnessById.values,
            record.identity,
        )
        if (current == null) {
            if (permanentFence != null) {
                return LifecycleApplicationResult.Invalid
            }
            if (record.state != AgentLifecycleState.RUNNING) {
                return LifecycleApplicationResult.Invalid
            }
        } else {
            if (permanentFence?.matches(current) != true ||
                current.sourceEpoch != record.sourceEpoch ||
                current.state.terminal ||
                !isAllowedLifecycleTransition(current.state, record.state)
            ) {
                return LifecycleApplicationResult.Invalid
            }
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
            config.policy == AgentNotificationPolicy.SUPPRESS || !config.allows(lifecycle.state) ->
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

    private fun preserveSnapshotRequirementAcrossInactive(
        syncState: AgentTimelineSyncState,
    ): AgentTimelineSyncState = when (syncState) {
        AgentTimelineSyncState.Snapshot -> AgentTimelineSyncState.StatusRefresh(
            requireSnapshotAfterRefresh = true,
        )
        is AgentTimelineSyncState.StatusRefresh -> if (syncState.requireSnapshotAfterRefresh) {
            syncState
        } else {
            AgentTimelineSyncState.Current
        }
        AgentTimelineSyncState.Current,
        is AgentTimelineSyncState.Replay,
        -> AgentTimelineSyncState.Current
    }

    private fun beginStatusRefresh(
        state: AgentTranscriptLifecycleClientState,
    ): AgentTranscriptLifecycleClientReduction {
        val previous = state.extensionLane
        if (previous.support != AgentExtensionSupport.AVAILABLE) return continuityConflict(state)
        val nextGeneration = incrementCounterOrNull(previous.localGeneration)
            ?: return continuityConflict(state)
        return AgentTranscriptLifecycleClientReduction(
            state.copy(
                extensionLane = previous.copy(
                    localGeneration = nextGeneration,
                    syncState = AgentTimelineSyncState.StatusRefresh(),
                    pendingStatusRequest = null,
                    pendingSnapshotRequest = null,
                ),
            ),
            AgentClientDisposition.GAP_RESYNC,
            syncDirective = AgentTimelineSyncDirective.StatusRefresh,
        )
    }

    private fun syncDirective(
        identity: AgentExtensionSessionIdentity,
        extension: AgentTranscriptLifecycleExtensionState,
    ): AgentTimelineSyncDirective {
        val timelineEpoch = extension.timelineEpoch ?: return AgentTimelineSyncDirective.None
        val lineage = AgentTimelineLineage(identity, timelineEpoch)
        return when (val sync = extension.syncState) {
            AgentTimelineSyncState.Current -> AgentTimelineSyncDirective.None
            AgentTimelineSyncState.Snapshot -> AgentTimelineSyncDirective.Snapshot(lineage)
            is AgentTimelineSyncState.StatusRefresh -> AgentTimelineSyncDirective.StatusRefresh
            is AgentTimelineSyncState.Replay -> AgentTimelineSyncDirective.Replay(
                lineage = lineage,
                afterAgentSeq = sync.pageFence?.stableAfterAgentSeq ?: extension.lastAgentSeq,
                cursor = sync.pageFence?.expectedNextCursor,
                limit = sync.pageFence?.requestedLimit
                    ?: extension.effectiveHostLimits?.maxPageRecords
                    ?: PRODUCTION_MAX_PAGE_RECORDS,
            )
        }
    }

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
        if (previous.support != AgentExtensionSupport.AVAILABLE) return continuityConflict(state)
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
                syncState = AgentTimelineSyncState.Snapshot,
                requiresTimelineRotation = requiresTimelineRotation,
            )
        }
        return AgentTranscriptLifecycleClientReduction(
            state = state.copy(extensionLane = extension),
            disposition = disposition,
            syncDirective = extension.timelineEpoch?.let {
                AgentTimelineSyncDirective.Snapshot(AgentTimelineLineage(state.identity, it))
            } ?: AgentTimelineSyncDirective.None,
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
        effectiveHostLimits: AgentTimelineEffectiveLimits? = null,
        syncState: AgentTimelineSyncState = AgentTimelineSyncState.Current,
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
        effectiveHostLimits = effectiveHostLimits,
        syncState = syncState,
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
private const val PRODUCTION_MAX_TEXT_UTF8_BYTES = 65_536L
private const val PRODUCTION_MAX_PAGE_RECORDS = 256L
private const val MIN_EVENT_REPLAY_RETENTION_MS = 86_400_000L
private const val PRODUCTION_MAX_EVENT_REPLAY_RETENTION_MS = 604_800_000L
private const val PRODUCTION_MAX_SNAPSHOT_LEASE_MS = 300_000L
private const val MAX_FAILURE_SUMMARY_UTF8_BYTES = 1_024
private const val MAX_WIRE_INTEGER = 9_007_199_254_740_991L
private const val MAX_OPAQUE_ID_UTF8_BYTES = 128

private fun strictUtf8Bytes(value: String): ByteArray = try {
    val encoded = StandardCharsets.UTF_8.newEncoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .encode(CharBuffer.wrap(value))
    ByteArray(encoded.remaining()).also(encoded::get)
} catch (_: CharacterCodingException) {
    throw IllegalArgumentException("String is not well-formed Unicode")
}

private fun utf8LengthStrict(value: String): Int = strictUtf8Bytes(value).size

/** Frozen bare UTF-8 ordering shared by snapshot staging and reducer notification selection. */
internal fun compareCanonicalUtf8Bytes(left: String, right: String): Int {
    val leftBytes = strictUtf8Bytes(left)
    val rightBytes = strictUtf8Bytes(right)
    val sharedLength = minOf(leftBytes.size, rightBytes.size)
    for (index in 0 until sharedLength) {
        val comparison = (leftBytes[index].toInt() and 0xff)
            .compareTo(rightBytes[index].toInt() and 0xff)
        if (comparison != 0) return comparison
    }
    return leftBytes.size.compareTo(rightBytes.size)
}

/** Frozen `(uint64 sequence, bare stableIdentity UTF-8)` order; record kind is not a key. */
internal fun compareCanonicalAgentOrder(
    leftSequence: String,
    leftStableIdentity: String,
    rightSequence: String,
    rightStableIdentity: String,
): Int {
    requireCanonicalCounter(leftSequence, "Left Agent order sequence")
    requireCanonicalCounter(rightSequence, "Right Agent order sequence")
    val sequenceComparison = compareCounters(leftSequence, rightSequence)
    return if (sequenceComparison != 0) sequenceComparison else {
        compareCanonicalUtf8Bytes(leftStableIdentity, rightStableIdentity)
    }
}

private fun requireOpaqueId(value: String?, label: String) {
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

internal fun isValidAgentTimelineCursor(value: String): Boolean {
    if (value.isBlank() || value != value.trim() || '\u0000' in value) return false
    val encoder = StandardCharsets.UTF_8.newEncoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
    return encoder.canEncode(value) &&
        value.toByteArray(StandardCharsets.UTF_8).size <= RelayV2StateLimits.MAX_CURSOR_UTF8_BYTES
}

private fun requireAgentTimelineCursor(value: String, label: String) {
    require(isValidAgentTimelineCursor(value)) {
        "$label must be a closed ${RelayV2StateLimits.MAX_CURSOR_UTF8_BYTES}-byte UTF-8 cursor"
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

private fun highestLifecycleWitness(
    witnesses: Collection<AgentLifecycleEventIdentityWitness>,
    identity: AgentLifecycleIdentity,
): AgentLifecycleEventIdentityWitness? = witnesses.asSequence()
    .filter { it.lifecycleIdentity == identity }
    .maxWithOrNull(Comparator { left, right ->
        compareCounters(left.agentEventSeq, right.agentEventSeq)
    })

private fun snapshotRecordPassesPermanentFence(
    extension: AgentTranscriptLifecycleExtensionState,
    record: AgentLifecycleRecord,
): Boolean {
    val fence = highestLifecycleWitness(extension.eventWitnessById.values, record.identity)
        ?: return true
    return when (compareCounters(record.agentEventSeq, fence.agentEventSeq)) {
        -1 -> false
        0 -> fence.matches(record)
        else -> fence.sourceEpoch == record.sourceEpoch && !fence.state.terminal
    }
}

internal fun isAllowedLifecycleTransition(
    previous: AgentLifecycleState,
    next: AgentLifecycleState,
): Boolean = when (previous) {
    AgentLifecycleState.RUNNING -> next == AgentLifecycleState.WAITING_FOR_USER ||
        next == AgentLifecycleState.FAILED ||
        next == AgentLifecycleState.COMPLETED
    AgentLifecycleState.WAITING_FOR_USER -> next == AgentLifecycleState.RUNNING ||
        next == AgentLifecycleState.FAILED ||
        next == AgentLifecycleState.COMPLETED
    AgentLifecycleState.FAILED,
    AgentLifecycleState.COMPLETED,
    -> false
}

internal fun hasValidPermanentLifecycleWitnessChains(
    witnesses: Collection<AgentLifecycleEventIdentityWitness>,
): Boolean = witnesses.groupBy(AgentLifecycleEventIdentityWitness::lifecycleIdentity)
    .values
    .all { identityWitnesses ->
        val ordered = identityWitnesses.sortedWith(Comparator { left, right ->
            compareCounters(left.agentEventSeq, right.agentEventSeq)
        })
        if (ordered.map(AgentLifecycleEventIdentityWitness::sourceEpoch).toSet().size != 1) {
            return@all false
        }
        val first = ordered.firstOrNull() ?: return@all true
        if (first.closedEventDigest != null && first.state != AgentLifecycleState.RUNNING) {
            return@all false
        }
        ordered.zipWithNext().all { (previous, next) ->
            !previous.state.terminal && if (next.closedEventDigest != null) {
                isAllowedLifecycleTransition(previous.state, next.state)
            } else {
                // A pinned snapshot can omit one or more intermediate non-terminal transitions.
                true
            }
        }
    }
