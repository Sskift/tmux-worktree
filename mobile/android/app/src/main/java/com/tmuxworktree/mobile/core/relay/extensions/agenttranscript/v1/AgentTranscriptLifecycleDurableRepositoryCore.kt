package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineLifecycleRecord
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineLifecycleChangedMutation
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineEntryDeletedMutation as PublicDeleteMutation
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineEntryRedactedMutation as PublicRedactMutation
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineEventRecord as PublicEventRecord
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSourceAvailabilityMutation as PublicSourceAvailabilityMutation
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineTextEntryAppendedMutation as PublicAppendMutation
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineRedactedTextEntryRecord
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotRecord
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineVisibleTextEntryRecord
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1Codec
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2EncodedPayload
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptEntryEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptEntryBatchMetadata
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptPendingEventEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptNamespaceStats
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptConsumerStats
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptSnapshotRecordEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptSnapshotRecordBatchMetadata
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptSnapshotStagingEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentLifecycleCurrentEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentLifecycleEventWitnessEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentLifecycleSqlAudit
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentNotificationLedgerEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentRecentEventEvidenceEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SqlStats
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptPendingEventBatchMetadata
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateLimits
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageException
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageFailure
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageJson
import com.tmuxworktree.mobile.core.relay.v2.state.canonicalArrayBytes
import java.math.BigInteger
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64

/** Stable consumer slot before the host-issued Agent timeline lineage is selected. */
internal data class AgentTranscriptLifecycleDurableConsumerIdentity(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) {
    init {
        require(profileActivationGeneration > 0) { "Profile activation generation must be positive" }
        requireStorageOpaqueIdentity(profileId, "Profile ID")
        requireStorageOpaqueIdentity(principalId, "Principal ID")
        requireStorageOpaqueIdentity(clientInstanceId, "Client instance ID")
        requireStorageOpaqueIdentity(hostId, "Host ID")
        requireStorageOpaqueIdentity(hostEpoch, "Host epoch")
        requireStorageOpaqueIdentity(scopeId, "Scope ID")
        requireStorageOpaqueIdentity(sessionId, "Session ID")
    }

    val sessionIdentity: AgentExtensionSessionIdentity
        get() = AgentExtensionSessionIdentity(profileId, hostId, hostEpoch, scopeId, sessionId)
}

/** Complete durable namespace, including the nullable current Agent timeline lineage. */
internal data class AgentTranscriptLifecycleDurableNamespace(
    val consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    val timelineEpoch: String?,
) {
    init {
        timelineEpoch?.let { requireStorageOpaqueIdentity(it, "Timeline epoch") }
    }

    val timelineEpochKey: String
        get() = timelineEpoch.orEmpty()

    companion object {
        fun from(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
            state: AgentTranscriptLifecycleClientState,
        ): AgentTranscriptLifecycleDurableNamespace {
            require(state.identity == consumer.sessionIdentity) {
                "Agent durable consumer identity does not match reducer state"
            }
            return AgentTranscriptLifecycleDurableNamespace(
                consumer,
                state.extensionLane.timelineEpoch,
            )
        }
    }
}

internal data class AgentTranscriptLifecyclePersistedState(
    val namespace: AgentTranscriptLifecycleDurableNamespace,
    val payload: RelayV2EncodedPayload,
)

internal data class AgentTranscriptLifecycleDurableRecord(
    val namespace: AgentTranscriptLifecycleDurableNamespace,
    val state: AgentTranscriptLifecycleClientState,
    val storageAccounting: AgentTranscriptDurableStorageAccounting,
)

/** Room A/D capacity evidence stored beside, never inside, the pure reducer state. */
internal data class AgentTranscriptDurableStorageAccounting(
    val entryCount: Long,
    val entryCanonicalBytes: Long,
    val entryTextUtf8Bytes: Long,
    val pendingLiveEventCount: Long,
    val pendingLiveEventCanonicalBytes: Long,
    val pendingLiveEventRawUtf8Bytes: Long,
    val lifecycleCurrentCount: Long,
    val lifecycleCurrentCanonicalBytes: Long,
    val lifecycleWitnessCount: Long,
    val lifecycleWitnessCanonicalBytes: Long,
    val recentEventEvidenceCount: Long,
    val recentEventEvidenceCanonicalBytes: Long,
    val notificationLedgerCount: Long,
    val notificationLedgerCanonicalBytes: Long,
) {
    init {
        require(entryCount in 0..MAX_MATERIALIZED_TRANSCRIPT_ROWS)
        require(entryCanonicalBytes in 2..RelayV2StateLimits.MAX_SNAPSHOT_CANONICAL_BYTES)
        require(entryTextUtf8Bytes in 0..entryCanonicalBytes)
        require((entryCount == 0L) == (entryCanonicalBytes == 2L))
        require(
            pendingLiveEventCount in
                0..RelayV2StateLimits.MAX_BUFFERED_STATE_EVENTS.toLong(),
        )
        require(
            pendingLiveEventCanonicalBytes in
                0..RelayV2StateLimits.MAX_BUFFERED_STATE_EVENT_BYTES,
        )
        require(
            pendingLiveEventRawUtf8Bytes in
                pendingLiveEventCanonicalBytes..RelayV2StateLimits.MAX_BUFFERED_STATE_EVENT_BYTES,
        )
        if (pendingLiveEventCount == 0L) {
            require(
                pendingLiveEventCanonicalBytes == 0L && pendingLiveEventRawUtf8Bytes == 0L,
            )
        } else {
            require(pendingLiveEventCanonicalBytes > 0L)
        }
        require(lifecycleCurrentCount >= 0 && lifecycleCurrentCanonicalBytes == 0L)
        require(lifecycleWitnessCount >= 0 && lifecycleWitnessCanonicalBytes >= 0)
        require(recentEventEvidenceCount >= 0 && recentEventEvidenceCanonicalBytes >= 0)
        require(notificationLedgerCount >= 0 && notificationLedgerCanonicalBytes >= 0)
        require((lifecycleWitnessCount == 0L) == (lifecycleWitnessCanonicalBytes == 0L))
        require(
            (recentEventEvidenceCount == 0L) ==
                (recentEventEvidenceCanonicalBytes == 0L),
        )
        require(
            (notificationLedgerCount == 0L) ==
                (notificationLedgerCanonicalBytes == 0L),
        )
    }

    companion object {
        val EMPTY = AgentTranscriptDurableStorageAccounting(
            entryCount = 0,
            entryCanonicalBytes = 2,
            entryTextUtf8Bytes = 0,
            pendingLiveEventCount = 0,
            pendingLiveEventCanonicalBytes = 0,
            pendingLiveEventRawUtf8Bytes = 0,
            lifecycleCurrentCount = 0,
            lifecycleCurrentCanonicalBytes = 0,
            lifecycleWitnessCount = 0,
            lifecycleWitnessCanonicalBytes = 0,
            recentEventEvidenceCount = 0,
            recentEventEvidenceCanonicalBytes = 0,
            notificationLedgerCount = 0,
            notificationLedgerCanonicalBytes = 0,
        )
    }
}

internal data class AgentTranscriptLifecycleDecodedDurablePayload(
    val state: AgentTranscriptLifecycleClientState,
    val storageAccounting: AgentTranscriptDurableStorageAccounting?,
)

private data class DecodedAgentTranscriptLifecycleDurableRecord(
    val namespace: AgentTranscriptLifecycleDurableNamespace,
    val state: AgentTranscriptLifecycleClientState,
    val storageAccounting: AgentTranscriptDurableStorageAccounting?,
    val payload: RelayV2EncodedPayload,
)

private enum class AgentTranscriptEntryTombstoneOrigin(val storageValue: String) {
    WIRE_DELETE("android_wire_delete_v1"),
    SNAPSHOT_ABSENCE("android_snapshot_absence_v1"),
}

/** Closed typed view of Room A. Raw nullable Room columns never escape this validator. */
private sealed interface ValidatedAgentTranscriptEntry {
    val entity: RelayV2AgentTranscriptEntryEntity

    data class Visible(
        override val entity: RelayV2AgentTranscriptEntryEntity,
    ) : ValidatedAgentTranscriptEntry

    data class Redacted(
        override val entity: RelayV2AgentTranscriptEntryEntity,
        val reason: AgentTimelineRedactionReason,
    ) : ValidatedAgentTranscriptEntry

    sealed interface Deleted : ValidatedAgentTranscriptEntry {
        data class Wire(
            override val entity: RelayV2AgentTranscriptEntryEntity,
            val reason: AgentTimelineRedactionReason,
        ) : Deleted

        data class SnapshotAbsence(
            override val entity: RelayV2AgentTranscriptEntryEntity,
            val evidenceThroughAgentSeq: String,
        ) : Deleted
    }
}

private data class ValidatedAgentTranscriptStorage(
    val snapshot: RelayV2AgentTranscriptSnapshotStagingEntity?,
    val accounting: AgentTranscriptDurableStorageAccounting,
)

/** Immutable one-shot key. Local generation is evidence, not a way to reclaim the same event. */
internal data class AgentTranscriptLifecycleNotificationClaimKey(
    val consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    val timelineEpoch: String,
    val lifecycleEventId: String,
    val lifecycleState: AgentLifecycleState,
) {
    init {
        requireStorageOpaqueIdentity(timelineEpoch, "Timeline epoch")
        requireStorageOpaqueIdentity(lifecycleEventId, "Lifecycle event ID")
    }

    val dedupeKey: AgentNotificationDedupeKey
        get() = AgentNotificationDedupeKey(
            consumer.profileId,
            consumer.hostId,
            consumer.hostEpoch,
            consumer.scopeId,
            consumer.sessionId,
            timelineEpoch,
            lifecycleEventId,
            lifecycleState,
        )

    val eventIdentity: AgentTranscriptLifecycleNotificationClaimEventIdentity
        get() = AgentTranscriptLifecycleNotificationClaimEventIdentity(
            consumer,
            timelineEpoch,
            lifecycleEventId,
        )

    companion object {
        fun exactOrNull(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            intent: AgentSystemNotificationIntent,
        ): AgentTranscriptLifecycleNotificationClaimKey? {
            val timelineEpoch = namespace.timelineEpoch ?: return null
            val key = intent.dedupeKey
            val consumer = namespace.consumer
            if (key.profileId != consumer.profileId ||
                key.hostId != consumer.hostId ||
                key.hostEpoch != consumer.hostEpoch ||
                key.scopeId != consumer.scopeId ||
                key.sessionId != consumer.sessionId ||
                key.timelineEpoch != timelineEpoch
            ) return null
            return AgentTranscriptLifecycleNotificationClaimKey(
                consumer,
                timelineEpoch,
                key.lifecycleEventId,
                key.state,
            )
        }
    }
}

/** One-shot storage identity; lifecycle state remains evidence and cannot create another claim. */
internal data class AgentTranscriptLifecycleNotificationClaimEventIdentity(
    val consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    val timelineEpoch: String,
    val lifecycleEventId: String,
) {
    init {
        requireStorageOpaqueIdentity(timelineEpoch, "Timeline epoch")
        requireStorageOpaqueIdentity(lifecycleEventId, "Lifecycle event ID")
    }
}

internal data class AgentTranscriptLifecyclePersistedNotificationClaim(
    val key: AgentTranscriptLifecycleNotificationClaimKey,
    val claimedLocalGeneration: String,
    val payload: RelayV2EncodedPayload,
)

/** Content-free authority emitted only after the immutable claim transaction commits. */
internal data class AgentTranscriptLifecycleNotificationExecutionTicket(
    val claimId: String,
    val namespace: AgentTranscriptLifecycleDurableNamespace,
    val intent: AgentSystemNotificationIntent,
)

internal enum class AgentTranscriptLifecycleNotificationNotExecutableReason {
    STATE_MISSING,
    NAMESPACE_CHANGED,
    INTENT_NOT_CURRENT,
    ALREADY_CLAIMED,
}

internal sealed interface AgentTranscriptLifecycleNotificationClaimResult {
    data class Claimed(
        val ticket: AgentTranscriptLifecycleNotificationExecutionTicket,
    ) : AgentTranscriptLifecycleNotificationClaimResult

    data class NotExecutable(
        val reason: AgentTranscriptLifecycleNotificationNotExecutableReason,
    ) : AgentTranscriptLifecycleNotificationClaimResult
}

internal enum class AgentTranscriptLifecycleInitializeDisposition {
    CREATED,
    UNCHANGED,
}

internal data class AgentTranscriptLifecycleInitializeResult(
    val record: AgentTranscriptLifecycleDurableRecord,
    val disposition: AgentTranscriptLifecycleInitializeDisposition,
)

internal class AgentTranscriptLifecyclePersistenceConflictException :
    IllegalStateException("Agent transcript/lifecycle persisted state conflicts")

internal class AgentTranscriptLifecyclePersistenceMissingException :
    IllegalStateException("Agent transcript/lifecycle persisted state is missing")

/** Transaction port implemented by Room in production and copy-on-write memory stores in tests. */
internal interface AgentTranscriptLifecycleDurableStore {
    suspend fun <T> transaction(block: AgentTranscriptLifecycleDurableTransaction.() -> T): T
}

internal interface AgentTranscriptLifecycleDurableTransaction {
    fun stateCount(consumer: AgentTranscriptLifecycleDurableConsumerIdentity): Long

    fun states(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): List<AgentTranscriptLifecyclePersistedState>

    /** Exact same-timeline parent CAS; callers require an affected-row count of one. */
    fun compareAndSetState(
        expected: AgentTranscriptLifecyclePersistedState,
        next: AgentTranscriptLifecyclePersistedState,
    ): Int

    /** Reserved for trusted timeline rotation; FK-owned rows cascade from this delete. */
    fun deleteStateForTimelineRotation(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): Int

    fun insertState(state: AgentTranscriptLifecyclePersistedState)

    fun transcriptNamespaceStats(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): RelayV2AgentTranscriptNamespaceStats

    /** Read-only empty-key audit; it never authorizes a normal transcript write namespace. */
    fun emptyTimelineNamespaceStats(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): RelayV2AgentTranscriptNamespaceStats

    /** Bounded orphan check across every timeline epoch for one exact eight-column consumer. */
    fun transcriptConsumerStats(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): RelayV2AgentTranscriptConsumerStats
    fun entryCount(namespace: AgentTranscriptLifecycleDurableNamespace): Long
    fun entryBatchMetadata(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterCreatedAgentSeqOrder: String?,
        afterEntryId: String?,
        limit: Int,
    ): List<RelayV2AgentTranscriptEntryBatchMetadata>
    fun entries(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterCreatedAgentSeqOrder: String?,
        afterEntryId: String?,
        limit: Int,
    ): List<RelayV2AgentTranscriptEntryEntity>
    fun insertEntry(entry: RelayV2AgentTranscriptEntryEntity)
    fun entryById(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        entryId: String,
    ): RelayV2AgentTranscriptEntryEntity?
    fun compareAndSetEntry(
        expected: RelayV2AgentTranscriptEntryEntity,
        next: RelayV2AgentTranscriptEntryEntity,
    ): Int
    fun deleteEntries(namespace: AgentTranscriptLifecycleDurableNamespace): Int

    fun snapshotCount(namespace: AgentTranscriptLifecycleDurableNamespace): Long
    fun snapshots(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): List<RelayV2AgentTranscriptSnapshotStagingEntity>
    fun insertSnapshot(snapshot: RelayV2AgentTranscriptSnapshotStagingEntity)
    fun compareAndSetSnapshot(
        expected: RelayV2AgentTranscriptSnapshotStagingEntity,
        next: RelayV2AgentTranscriptSnapshotStagingEntity,
    ): Int
    fun deleteSnapshot(snapshot: RelayV2AgentTranscriptSnapshotStagingEntity): Int

    fun snapshotRecordCount(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        snapshotId: String,
    ): Long
    fun snapshotRecordBatchMetadata(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        snapshotId: String,
        afterRecordIndex: Long,
        limit: Int,
    ): List<RelayV2AgentTranscriptSnapshotRecordBatchMetadata>
    fun snapshotRecords(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        snapshotId: String,
        afterRecordIndex: Long,
        limit: Int,
    ): List<RelayV2AgentTranscriptSnapshotRecordEntity>
    fun snapshotRecordsByStableIdentity(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        snapshotId: String,
        stableIdentity: String,
    ): List<RelayV2AgentTranscriptSnapshotRecordEntity>
    fun insertSnapshotRecords(records: List<RelayV2AgentTranscriptSnapshotRecordEntity>)

    fun pendingEventCount(namespace: AgentTranscriptLifecycleDurableNamespace): Long
    fun pendingEventBatchMetadata(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterAgentEventSeqOrder: String?,
        limit: Int,
    ): List<RelayV2AgentTranscriptPendingEventBatchMetadata>
    fun pendingEvents(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterAgentEventSeqOrder: String?,
        limit: Int,
    ): List<RelayV2AgentTranscriptPendingEventEntity>
    fun insertPendingEvent(event: RelayV2AgentTranscriptPendingEventEntity)
    fun pendingEventBySeq(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        agentEventSeq: String,
    ): RelayV2AgentTranscriptPendingEventEntity?
    fun pendingEventByEventId(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        eventId: String,
    ): RelayV2AgentTranscriptPendingEventEntity?
    fun deletePendingEvent(event: RelayV2AgentTranscriptPendingEventEntity): Int
    fun deletePendingEvents(namespace: AgentTranscriptLifecycleDurableNamespace): Int

    fun lifecycleCurrentStats(namespace: AgentTranscriptLifecycleDurableNamespace): RelayV2SqlStats
    fun lifecycleWitnessAudit(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): RelayV2AgentLifecycleSqlAudit
    fun recentEvidenceAudit(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): RelayV2AgentLifecycleSqlAudit
    fun notificationLedgerAudit(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): RelayV2AgentLifecycleSqlAudit
    fun lifecycleCurrentPage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ): List<RelayV2AgentLifecycleCurrentEntity>
    fun lifecycleWitnessPage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ): List<RelayV2AgentLifecycleEventWitnessEntity>
    fun lifecycleWitnessIdentityAuditPage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterLifecycleScope: String,
        afterRunId: String,
        afterTurnIdKey: String,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ): List<RelayV2AgentLifecycleEventWitnessEntity>
    fun recentEvidencePage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ): List<RelayV2AgentRecentEventEvidenceEntity>
    fun notificationLedgerPage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        afterState: String,
        limit: Int,
    ): List<RelayV2AgentNotificationLedgerEntity>

    fun lifecycleCurrentByIdentity(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        identity: AgentLifecycleIdentity,
    ): RelayV2AgentLifecycleCurrentEntity?
    fun lifecycleCurrentByEventId(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        eventId: String,
    ): RelayV2AgentLifecycleCurrentEntity?
    fun lifecycleCurrentByAgentEventSeq(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        agentEventSeq: String,
    ): RelayV2AgentLifecycleCurrentEntity?
    fun currentRun(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        runId: String,
    ): RelayV2AgentLifecycleEventWitnessEntity?
    fun currentNonterminalTurnsForRun(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        runId: String,
    ): List<RelayV2AgentLifecycleEventWitnessEntity>
    fun currentRunSourceEpochs(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        runId: String,
    ): List<String>
    fun terminalRunEvidence(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        runId: String,
    ): List<RelayV2AgentLifecycleEventWitnessEntity>
    fun witnessByEventId(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        eventId: String,
    ): RelayV2AgentLifecycleEventWitnessEntity?
    fun witnessByAgentEventSeq(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        agentEventSeq: String,
    ): RelayV2AgentLifecycleEventWitnessEntity?
    fun highestWitnessForIdentity(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        identity: AgentLifecycleIdentity,
    ): RelayV2AgentLifecycleEventWitnessEntity?
    fun hasPermanentTurnEvidence(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        runId: String,
    ): Boolean
    fun recentEvidenceByEventId(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        eventId: String,
    ): RelayV2AgentRecentEventEvidenceEntity?
    fun recentEvidenceByAgentEventSeq(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        agentEventSeq: String,
    ): RelayV2AgentRecentEventEvidenceEntity?
    fun notificationByLifecycleEventId(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        eventId: String,
    ): RelayV2AgentNotificationLedgerEntity?
    fun notificationByDedupeKey(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        eventId: String,
        state: AgentLifecycleState,
    ): RelayV2AgentNotificationLedgerEntity?
    fun insertLifecycleWitnesses(rows: List<RelayV2AgentLifecycleEventWitnessEntity>)
    fun insertLifecycleCurrent(rows: List<RelayV2AgentLifecycleCurrentEntity>)
    fun updateLifecycleCurrentExact(
        expected: RelayV2AgentLifecycleCurrentEntity,
        next: RelayV2AgentLifecycleCurrentEntity,
    ): Int
    fun deleteLifecycleCurrentExact(expected: RelayV2AgentLifecycleCurrentEntity): Int
    fun insertRecentEvidence(rows: List<RelayV2AgentRecentEventEvidenceEntity>)
    fun deleteRecentEvidenceExact(expected: RelayV2AgentRecentEventEvidenceEntity): Int
    fun deleteRecentEvidenceThroughBatch(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        throughAgentEventSeqOrder: String,
        limit: Int,
    ): Int
    fun insertNotificationLedger(rows: List<RelayV2AgentNotificationLedgerEntity>)
    fun deleteNotificationLedgerExact(expected: RelayV2AgentNotificationLedgerEntity): Int

    fun notificationClaims(
        eventIdentity: AgentTranscriptLifecycleNotificationClaimEventIdentity,
    ): List<AgentTranscriptLifecyclePersistedNotificationClaim>

    /** Must use INSERT ABORT or an equivalent no-overwrite compare-and-set. */
    fun insertNotificationClaim(claim: AgentTranscriptLifecyclePersistedNotificationClaim)
}

/**
 * Atomic persistence owner for the optional Agent reducer.
 *
 * The caller must hold the future actor apply lease. This core deliberately has no actor, socket,
 * notification executor, or capability-advertisement dependency.
 */
internal class AgentTranscriptLifecycleDurableRepositoryCore(
    private val store: AgentTranscriptLifecycleDurableStore,
    private val publicCodec: AgentTranscriptLifecycleV1Codec = AgentTranscriptLifecycleV1Codec(),
) : AgentTranscriptLifecycleDurableOperationPort {
    suspend fun load(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): AgentTranscriptLifecycleDurableRecord? = store.transaction {
        loadAuditedSingle(consumer)
    }

    suspend fun initializeUnderApplyLease(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        state: AgentTranscriptLifecycleClientState,
    ): AgentTranscriptLifecycleInitializeResult = store.transaction {
        requireNamespaceState(namespace, state)
        val existing = loadAuditedSingle(namespace.consumer)
        if (existing != null) {
            if (existing.namespace == namespace && existing.state == state) {
                return@transaction AgentTranscriptLifecycleInitializeResult(
                    existing,
                    AgentTranscriptLifecycleInitializeDisposition.UNCHANGED,
                )
            }
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        val consumerStats = transcriptConsumerStats(namespace.consumer)
        if (consumerStats.entryCount != 0L || consumerStats.snapshotCount != 0L ||
            consumerStats.snapshotRecordCount != 0L || consumerStats.pendingEventCount != 0L
        ) storageMalformed()
        val emptyStats = transcriptNamespaceStats(namespace)
        validateTranscriptNamespaceStats(emptyStats)
        if (emptyStats.entryCount != 0L || emptyStats.snapshotCount != 0L ||
            emptyStats.snapshotRecordCount != 0L || emptyStats.pendingEventCount != 0L
        ) storageMalformed()
        val accounting = AgentTranscriptDurableStorageAccounting.EMPTY
        val persisted = AgentTranscriptLifecyclePersistedState(
            namespace,
            AgentTranscriptLifecycleDurableStateCodec.encode(namespace, state, accounting),
        )
        insertState(persisted)
        AgentTranscriptLifecycleInitializeResult(
            AgentTranscriptLifecycleDurableRecord(namespace, state, accounting),
            AgentTranscriptLifecycleInitializeDisposition.CREATED,
        )
    }

    override suspend fun applyControlUnderApplyLease(
        command: AgentTranscriptLifecycleDurableControlCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult =
        AgentTranscriptLifecycleDurableOperationResult(
            reduceUnderApplyLease(command.fence.expectedNamespace, command.input, limits),
        )

    override suspend fun persistSnapshotRequestUnderApplyLease(
        command: AgentTranscriptLifecycleDurableSnapshotRequestCommand,
    ): AgentTranscriptLifecycleDurableOperationResult =
        AgentTranscriptLifecycleDurableOperationResult(
            reduceUnderApplyLease(
                command.fence.expectedNamespace,
                AgentTranscriptLifecycleClientInput.SnapshotRequestStarted(
                    command.snapshotRequestId,
                    command.pageZeroNetworkToken,
                ),
                AgentClientReducerLimits(),
            ),
        )

    override suspend fun consumeLiveEventUnderApplyLease(
        command: AgentTranscriptLifecycleDurableLiveEventCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult = store.transaction {
        val namespace = command.fence.expectedNamespace
        val current = requireOperationState(command.fence)
        val closed = closeEvent(command.frame.event, AgentEventProvenance.LIVE)
        val reduction = if (current.state.extensionLane.syncState !=
            AgentTimelineSyncState.Current
        ) {
            bufferLiveEvent(namespace, current, closed, command.artifact.rawUtf8ByteCount)
        } else {
            consumeClosedEvent(
                namespace,
                current,
                closed,
                command.artifact.rawUtf8ByteCount,
                limits,
            ).reduction
        }
        AgentTranscriptLifecycleDurableOperationResult(reduction)
    }

    override suspend fun consumeReplayPageUnderApplyLease(
        command: AgentTranscriptLifecycleDurableReplayPageCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult = store.transaction {
        val namespace = command.fence.expectedNamespace
        var current = requireOperationState(command.fence)
        val artifact = command.artifact
        val replay = current.state.extensionLane.syncState as? AgentTimelineSyncState.Replay
            ?: throw AgentTranscriptLifecyclePersistenceConflictException()
        val pageFence = replay.pageFence
            ?: throw AgentTranscriptLifecyclePersistenceConflictException()
        if (pageFence.currentRequestNetworkToken != artifact.requestId ||
            pageFence.stableAfterAgentSeq != artifact.afterAgentSeq ||
            pageFence.expectedNextCursor == null &&
            pageFence.pinnedReplayThroughAgentSeq != null && artifact.events.isNotEmpty() &&
            current.state.extensionLane.lastAgentSeq == artifact.replayThroughAgentSeq
        ) throw AgentTranscriptLifecyclePersistenceConflictException()
        val pageStart = current.state.extensionLane.lastAgentSeq
        artifact.events.forEach { event ->
            val closed = closeEvent(event, AgentEventProvenance.REPLAY)
            val consumed = consumeClosedEvent(
                namespace,
                current,
                closed,
                artifact.rawUtf8ByteCount,
                limits,
            )
            val reduction = consumed.reduction
            if (reduction.disposition !in setOf(
                    AgentClientDisposition.APPLIED,
                    AgentClientDisposition.DUPLICATE,
                )
            ) throw AgentTranscriptLifecyclePersistenceConflictException()
            current = consumed.record
        }
        val proof = AgentTranscriptLifecycleClientReducer.reduce(
            current.state,
            AgentTranscriptLifecycleClientInput.ReplayPageApplied(
                lineage = AgentTimelineLineage(
                    namespace.consumer.sessionIdentity,
                    namespace.timelineEpoch ?: throw AgentTranscriptLifecyclePersistenceConflictException(),
                ),
                requestNetworkToken = artifact.requestId,
                requestCursor = pageFence.expectedNextCursor,
                stableAfterAgentSeq = artifact.afterAgentSeq,
                replayThroughAgentSeq = artifact.replayThroughAgentSeq,
                pageStartAgentSeq = pageStart,
                eventCount = artifact.events.size.toLong(),
                requestLimit = pageFence.requestedLimit,
                isLast = artifact.isLast,
                nextCursor = artifact.nextCursor,
            ),
            limits,
        )
        if (proof.disposition == AgentClientDisposition.CONTINUITY_CONFLICT) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        val finalReduction = when (command) {
            is AgentTranscriptLifecycleDurableReplayPageCommand.Final -> proof
            is AgentTranscriptLifecycleDurableReplayPageCommand.NonFinal ->
                AgentTranscriptLifecycleClientReducer.reduce(
                    proof.state,
                    AgentTranscriptLifecycleClientInput.ReplayRequestStarted(
                        command.nextRequestNetworkToken,
                        artifact.nextCursor,
                        pageFence.requestedLimit,
                    ),
                    limits,
                )
        }
        current = persistOperationState(current, finalReduction.state, current.storageAccounting)
        AgentTranscriptLifecycleDurableOperationResult(
            finalReduction.copy(state = finalReduction.state.withoutRowOwnedMaterialization()),
        )
    }

    override suspend fun consumeSnapshotPageUnderApplyLease(
        command: AgentTranscriptLifecycleDurableSnapshotPageCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult = store.transaction {
        consumeSnapshotPage(command, limits)
    }

    private suspend fun reduceUnderApplyLease(
        expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
        input: AgentTranscriptLifecycleClientInput,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleClientReduction = store.transaction {
        if (input !is AgentTranscriptLifecycleControlInput) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        if (input is AgentTranscriptLifecycleClientInput.StatusAvailable &&
            input.authority != expectedNamespace.consumer
        ) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        val current = loadSingle(expectedNamespace.consumer)
            ?: throw AgentTranscriptLifecyclePersistenceMissingException()
        if (current.namespace != expectedNamespace) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        val currentAccounting = current.storageAccounting
            ?: throw AgentTranscriptLifecyclePersistenceConflictException()
        val reduction = AgentTranscriptLifecycleClientReducer.reduce(current.state, input, limits)
        // Control transitions invalidate any in-flight snapshot fence.  Clear B by exact
        // identity in this same transaction; the FK removes C.  D remains governed by the
        // reducer's sync semantics and is intentionally not bulk-dropped here.
        if (reduction.state.extensionLane.localGeneration !=
            current.state.extensionLane.localGeneration
        ) {
            clearSnapshotFence(expectedNamespace)
        }
        val nextNamespace = AgentTranscriptLifecycleDurableNamespace.from(
            expectedNamespace.consumer,
            reduction.state,
        )
        requireNamespaceState(nextNamespace, reduction.state)
        if (current.namespace == nextNamespace && current.state == reduction.state) {
            return@transaction reduction
        }

        val replacement = AgentTranscriptLifecyclePersistedState(
            nextNamespace,
            AgentTranscriptLifecycleDurableStateCodec.encode(
                nextNamespace,
                reduction.state,
                currentAccounting,
            ),
        )
        val expected = AgentTranscriptLifecyclePersistedState(
            current.namespace,
            AgentTranscriptLifecycleDurableStateCodec.encode(
                current.namespace,
                current.state,
                currentAccounting,
            ),
        )
        if (current.namespace == nextNamespace) {
            if (compareAndSetState(expected, replacement) != 1) {
                throw AgentTranscriptLifecyclePersistenceConflictException()
            }
        } else {
            if (input !is AgentTranscriptLifecycleClientInput.StatusAvailable) {
                throw AgentTranscriptLifecyclePersistenceConflictException()
            }
            if (deleteStateForTimelineRotation(current.namespace) != 1) {
                throw AgentTranscriptLifecyclePersistenceConflictException()
            }
            insertState(replacement)
        }
        reduction
    }

    private fun AgentTranscriptLifecycleDurableTransaction.clearSnapshotFence(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ) {
        snapshots(namespace).singleOrNull()?.let { snapshot ->
            if (deleteSnapshot(snapshot) != 1) {
                throw AgentTranscriptLifecyclePersistenceConflictException()
            }
        }
    }

    private fun AgentTranscriptLifecycleDurableTransaction.loadAuditedSingle(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): AgentTranscriptLifecycleDurableRecord? {
        val current = loadSingle(consumer) ?: return null
        val audited = validateTranscriptStorage(current.namespace, current.state)
        val storedAccounting = current.storageAccounting
        if (storedAccounting != null && storedAccounting != audited.accounting) {
            storageMalformed()
        }
        if (storedAccounting != null) return AgentTranscriptLifecycleDurableRecord(
            current.namespace,
            current.state,
            storedAccounting,
        )

        val replacement = AgentTranscriptLifecyclePersistedState(
            current.namespace,
            AgentTranscriptLifecycleDurableStateCodec.encode(
                current.namespace,
                current.state,
                audited.accounting,
            ),
        )
        val expected = AgentTranscriptLifecyclePersistedState(
            current.namespace,
            current.payload,
        )
        if (compareAndSetState(expected, replacement) != 1) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        return AgentTranscriptLifecycleDurableRecord(
            current.namespace,
            current.state,
            audited.accounting,
        )
    }

    private fun AgentTranscriptLifecycleDurableTransaction.validateTranscriptStorage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        state: AgentTranscriptLifecycleClientState,
    ): ValidatedAgentTranscriptStorage {
        val stats = transcriptNamespaceStats(namespace)
        validateTranscriptNamespaceStats(stats)
        val lifecycleAccounting = validateLifecycleIndex(namespace, state.extensionLane.lastAgentSeq)
        if (namespace.timelineEpoch == null) {
            if (stats.entryCount != 0L || stats.snapshotCount != 0L ||
                stats.snapshotRecordCount != 0L || stats.pendingEventCount != 0L ||
                lifecycleAccounting != LifecycleIndexAccounting.EMPTY
            ) storageMalformed()
            return ValidatedAgentTranscriptStorage(
                snapshot = null,
                accounting = AgentTranscriptDurableStorageAccounting.EMPTY,
            )
        }

        validateEntryBatches(namespace, state.extensionLane.lastAgentSeq, stats)

        val snapshotRows = snapshots(namespace)
        if (snapshotRows.size.toLong() != stats.snapshotCount) storageMalformed()
        val snapshot = snapshotRows.singleOrNull()
        if (snapshot != null) {
            validateSnapshotHeader(namespace, state, snapshot)
            validateSnapshotRecordBatches(namespace, snapshot, stats)
        } else if (stats.snapshotRecordCount != 0L) {
            storageMalformed()
        }

        validatePendingEventBatches(namespace, state, stats)

        return ValidatedAgentTranscriptStorage(
            snapshot = snapshot,
            accounting = AgentTranscriptDurableStorageAccounting(
                entryCount = stats.entryCount,
                entryCanonicalBytes = canonicalArrayBytes(
                    stats.entryCount,
                    stats.entryPayloadUtf8Bytes,
                ),
                entryTextUtf8Bytes = stats.entryTextUtf8Bytes,
                pendingLiveEventCount = stats.pendingEventCount,
                pendingLiveEventCanonicalBytes = stats.pendingEventPayloadUtf8Bytes,
                pendingLiveEventRawUtf8Bytes = stats.pendingEventRawUtf8Bytes,
                lifecycleCurrentCount = lifecycleAccounting.currentCount,
                lifecycleCurrentCanonicalBytes = 0,
                lifecycleWitnessCount = lifecycleAccounting.witnessCount,
                lifecycleWitnessCanonicalBytes = lifecycleAccounting.witnessBytes,
                recentEventEvidenceCount = lifecycleAccounting.recentCount,
                recentEventEvidenceCanonicalBytes = lifecycleAccounting.recentBytes,
                notificationLedgerCount = lifecycleAccounting.notificationCount,
                notificationLedgerCanonicalBytes = lifecycleAccounting.notificationBytes,
            ),
        )
    }

    private data class LifecycleIndexAccounting(
        val currentCount: Long,
        val witnessCount: Long,
        val witnessBytes: Long,
        val recentCount: Long,
        val recentBytes: Long,
        val notificationCount: Long,
        val notificationBytes: Long,
    ) {
        companion object {
            val EMPTY = LifecycleIndexAccounting(0, 0, 0, 0, 0, 0, 0)
        }
    }

    /** Full restore/final-cut audit. Ordinary operations use only targeted point reads. */
    private fun AgentTranscriptLifecycleDurableTransaction.validateLifecycleIndex(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        lastAgentSeq: String,
    ): LifecycleIndexAccounting {
        val currentStats = lifecycleCurrentStats(namespace)
        val witnessStats = lifecycleWitnessAudit(namespace)
        val recentStats = recentEvidenceAudit(namespace)
        val notificationStats = notificationLedgerAudit(namespace)
        listOf(witnessStats, recentStats, notificationStats).forEach { audit ->
            if (audit.itemCount < 0 || audit.declaredCanonicalBytes < 0 ||
                audit.declaredCanonicalBytes != audit.actualCanonicalBytes ||
                (audit.itemCount == 0L) != (audit.declaredCanonicalBytes == 0L)
            ) storageMalformed()
        }
        if (currentStats.itemCount < 0 || currentStats.byteCount != 0L) storageMalformed()

        validatePermanentWitnessChains(namespace, witnessStats)
        validateCurrentPointers(namespace, currentStats.itemCount)
        validateRecentEvidenceRows(namespace, lastAgentSeq, recentStats)
        validateNotificationRows(namespace, notificationStats)
        return LifecycleIndexAccounting(
            currentCount = currentStats.itemCount,
            witnessCount = witnessStats.itemCount,
            witnessBytes = witnessStats.declaredCanonicalBytes,
            recentCount = recentStats.itemCount,
            recentBytes = recentStats.declaredCanonicalBytes,
            notificationCount = notificationStats.itemCount,
            notificationBytes = notificationStats.declaredCanonicalBytes,
        )
    }

    private fun AgentTranscriptLifecycleDurableTransaction.validatePermanentWitnessChains(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        stats: RelayV2AgentLifecycleSqlAudit,
    ) {
        var processed = 0L
        var afterScope = ""
        var afterRunId = ""
        var afterTurnId = ""
        var afterOrder = ""
        var afterEventId = ""
        var previous: RelayV2AgentLifecycleEventWitnessEntity? = null
        var canonicalBytes = 0L
        while (processed < stats.itemCount) {
            val rows = lifecycleWitnessIdentityAuditPage(
                namespace, afterScope, afterRunId, afterTurnId, afterOrder, afterEventId,
                DURABLE_STORAGE_BATCH_RECORDS,
            )
            if (rows.isEmpty() || rows.size > DURABLE_STORAGE_BATCH_RECORDS) storageMalformed()
            rows.forEach { row ->
                validateWitnessRow(namespace, row)
                val prior = previous
                if (prior != null && prior.lifecycleIdentityKey() == row.lifecycleIdentityKey()) {
                    if (prior.sourceEpoch != row.sourceEpoch ||
                        prior.lifecycleState.toLifecycleState().terminal ||
                        compareStorageCounters(prior.agentEventSeq, row.agentEventSeq) >= 0 ||
                        if (row.closedEventDigest != null) {
                            !isAllowedLifecycleTransition(
                                prior.lifecycleState.toLifecycleState(),
                                row.lifecycleState.toLifecycleState(),
                            )
                        } else {
                            false
                        }
                    ) storageMalformed()
                } else if (row.closedEventDigest != null &&
                    row.lifecycleState.toLifecycleState() != AgentLifecycleState.RUNNING
                ) {
                    storageMalformed()
                }
                if (recentEvidenceByEventId(namespace, row.eventId) != null ||
                    recentEvidenceByAgentEventSeq(namespace, row.agentEventSeq) != null
                ) storageMalformed()
                previous = row
                canonicalBytes = addBounded(
                    canonicalBytes,
                    row.witnessCanonicalUtf8Bytes.toLong(),
                    Long.MAX_VALUE,
                )
            }
            processed += rows.size
            val last = rows.last()
            afterScope = last.lifecycleScope
            afterRunId = last.runId
            afterTurnId = last.turnIdKey
            afterOrder = last.agentEventSeqOrder
            afterEventId = last.eventId
        }
        if (lifecycleWitnessIdentityAuditPage(
                namespace, afterScope, afterRunId, afterTurnId, afterOrder, afterEventId, 1,
            ).isNotEmpty() || processed != stats.itemCount ||
            canonicalBytes != stats.declaredCanonicalBytes
        ) storageMalformed()
    }

    private fun AgentTranscriptLifecycleDurableTransaction.validateCurrentPointers(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        expectedCount: Long,
    ) {
        var processed = 0L
        var afterOrder = ""
        var afterEventId = ""
        while (processed < expectedCount) {
            val rows = lifecycleCurrentPage(
                namespace, afterOrder, afterEventId, DURABLE_STORAGE_BATCH_RECORDS,
            )
            if (rows.isEmpty() || rows.size > DURABLE_STORAGE_BATCH_RECORDS) storageMalformed()
            rows.forEach { row ->
                requireExactLifecycleNamespace(namespace, row)
                requireExactOrderKey(row.agentEventSeq, row.agentEventSeqOrder)
                val identity = row.toLifecycleIdentity()
                val witness = witnessByEventId(namespace, row.lifecycleEventId)
                    ?: storageMalformed()
                val highest = highestWitnessForIdentity(namespace, identity)
                    ?: storageMalformed()
                if (!row.pointsExactlyTo(witness) || highest != witness) storageMalformed()
            }
            processed += rows.size
            afterOrder = rows.last().agentEventSeqOrder
            afterEventId = rows.last().lifecycleEventId
        }
        if (lifecycleCurrentPage(namespace, afterOrder, afterEventId, 1).isNotEmpty() ||
            processed != expectedCount
        ) storageMalformed()
    }

    private fun AgentTranscriptLifecycleDurableTransaction.validateRecentEvidenceRows(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        lastAgentSeq: String,
        stats: RelayV2AgentLifecycleSqlAudit,
    ) {
        var processed = 0L
        var bytes = 0L
        var afterOrder = ""
        var afterEventId = ""
        while (processed < stats.itemCount) {
            val rows = recentEvidencePage(
                namespace, afterOrder, afterEventId, DURABLE_STORAGE_BATCH_RECORDS,
            )
            if (rows.isEmpty() || rows.size > DURABLE_STORAGE_BATCH_RECORDS) storageMalformed()
            rows.forEach { row ->
                requireExactLifecycleNamespace(namespace, row)
                if (compareStorageCounters(row.agentEventSeq, lastAgentSeq) > 0) storageMalformed()
                requireExactOrderKey(row.agentEventSeq, row.agentEventSeqOrder)
                val canonical = strictStorageUtf8(row.evidenceCanonicalJson)
                val event = try {
                    publicCodec.decodeCanonicalPublicEventRecord(canonical)
                } catch (_: IllegalArgumentException) {
                    storageMalformed()
                }
                if (event.mutation is AgentTimelineLifecycleChangedMutation ||
                    event.agentEventSeq != row.agentEventSeq || event.eventId != row.eventId ||
                    canonical.size != row.evidenceCanonicalUtf8Bytes ||
                    sha256Hex(canonical) != row.evidenceSha256 ||
                    digestBase64Url(canonical) != row.closedEventDigest ||
                    witnessByEventId(namespace, row.eventId) != null ||
                    witnessByAgentEventSeq(namespace, row.agentEventSeq) != null
                ) storageMalformed()
                when (val mutation = event.mutation) {
                    is PublicAppendMutation -> {
                        val entry = entryById(namespace, mutation.entry.metadata.entryId)
                            ?: storageMalformed()
                        validateEntry(namespace, entry)
                        if (entry.createdAgentSeq != mutation.entry.metadata.createdAgentSeq ||
                            entry.lastModifiedAgentSeq != mutation.entry.metadata.lastModifiedAgentSeq
                        ) storageMalformed()
                    }
                    is PublicRedactMutation,
                    is PublicDeleteMutation -> {
                        val entryId = when (mutation) {
                            is PublicRedactMutation -> mutation.entryId
                            is PublicDeleteMutation -> mutation.entryId
                            else -> storageMalformed()
                        }
                        val entry = entryById(namespace, entryId) ?: storageMalformed()
                        validateEntry(namespace, entry)
                        if (compareStorageCounters(entry.lastModifiedAgentSeq, row.agentEventSeq) >= 0) {
                            storageMalformed()
                        }
                    }
                    else -> Unit
                }
                bytes = addBounded(bytes, canonical.size.toLong(), Long.MAX_VALUE)
            }
            processed += rows.size
            afterOrder = rows.last().agentEventSeqOrder
            afterEventId = rows.last().eventId
        }
        if (recentEvidencePage(namespace, afterOrder, afterEventId, 1).isNotEmpty() ||
            processed != stats.itemCount || bytes != stats.declaredCanonicalBytes
        ) storageMalformed()
    }

    private fun AgentTranscriptLifecycleDurableTransaction.validateNotificationRows(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        stats: RelayV2AgentLifecycleSqlAudit,
    ) {
        var processed = 0L
        var bytes = 0L
        var afterOrder = ""
        var afterEventId = ""
        var afterState = ""
        while (processed < stats.itemCount) {
            val rows = notificationLedgerPage(
                namespace, afterOrder, afterEventId, afterState, DURABLE_STORAGE_BATCH_RECORDS,
            )
            if (rows.isEmpty() || rows.size > DURABLE_STORAGE_BATCH_RECORDS) storageMalformed()
            rows.forEach { row ->
                requireExactLifecycleNamespace(namespace, row)
                requireExactOrderKey(row.agentEventSeq, row.agentEventSeqOrder)
                val expectedPayload = canonicalNotificationPayload(
                    row.disposition,
                    row.localGeneration,
                )
                val witness = witnessByEventId(namespace, row.lifecycleEventId)
                    ?: storageMalformed()
                if (row.lifecycleState.toLifecycleState() !in setOf(
                        AgentLifecycleState.WAITING_FOR_USER,
                        AgentLifecycleState.FAILED,
                        AgentLifecycleState.COMPLETED,
                    ) || !row.pointsExactlyTo(witness) ||
                    row.ledgerCanonicalJson != expectedPayload.canonicalJson ||
                    row.ledgerCanonicalUtf8Bytes != expectedPayload.payloadUtf8Bytes ||
                    row.ledgerSha256 != expectedPayload.sha256
                ) storageMalformed()
                bytes = addBounded(
                    bytes,
                    row.ledgerCanonicalUtf8Bytes.toLong(),
                    Long.MAX_VALUE,
                )
            }
            processed += rows.size
            val last = rows.last()
            afterOrder = last.agentEventSeqOrder
            afterEventId = last.lifecycleEventId
            afterState = last.lifecycleState
        }
        if (notificationLedgerPage(
                namespace, afterOrder, afterEventId, afterState, 1,
            ).isNotEmpty() || processed != stats.itemCount ||
            bytes != stats.declaredCanonicalBytes
        ) storageMalformed()
    }

    private fun validateWitnessRow(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        row: RelayV2AgentLifecycleEventWitnessEntity,
    ) {
        requireExactLifecycleNamespace(namespace, row)
        requireCanonicalStorageCounter(row.agentEventSeq, positive = true)
        requireExactOrderKey(row.agentEventSeq, row.agentEventSeqOrder)
        storageOpaque(row.eventId)
        storageOpaque(row.runId)
        row.turnIdKey.takeIf(String::isNotEmpty)?.let(::storageOpaque)
        storageOpaque(row.sourceEpoch)
        row.closedEventDigest?.let(::AgentClosedEventDigest)
        val canonical = strictStorageUtf8(row.witnessCanonicalJson)
        val record = try {
            publicCodec.decodeCanonicalPublicSnapshotRecord(canonical)
        } catch (_: IllegalArgumentException) {
            storageMalformed()
        } as? AgentTimelineLifecycleRecord ?: storageMalformed()
        if (canonical.size != row.witnessCanonicalUtf8Bytes ||
            sha256Hex(canonical) != row.witnessSha256 ||
            record.lifecycleEventId != row.eventId ||
            record.agentEventSeq != row.agentEventSeq ||
            record.scope.name != row.lifecycleScope ||
            record.runId != row.runId ||
            (record.turnId ?: "") != row.turnIdKey ||
            record.sourceEpoch != row.sourceEpoch ||
            record.state.name != row.lifecycleState ||
            record.failure?.code != row.failureCode ||
            record.failure?.summary != row.failureSummary ||
            record.occurredAtMs != row.occurredAtMs
        ) storageMalformed()
    }

    private data class ReadyOperationState(
        val namespace: AgentTranscriptLifecycleDurableNamespace,
        val state: AgentTranscriptLifecycleClientState,
        val storageAccounting: AgentTranscriptDurableStorageAccounting,
        val payload: RelayV2EncodedPayload,
    )

    internal data class ClosedDurableEvent(
        val publicRecord: PublicEventRecord,
        val mutation: AgentTimelineMutation,
        val provenance: AgentEventProvenance,
        val canonical: ByteArray,
        val canonicalJson: String,
        val digest: AgentClosedEventDigest,
    )

    private data class EventConsumption(
        val record: ReadyOperationState,
        val reduction: AgentTranscriptLifecycleClientReduction,
    )

    private sealed interface EntryMutationPlan {
        data object None : EntryMutationPlan
        data class Insert(val next: RelayV2AgentTranscriptEntryEntity) : EntryMutationPlan
        data class Update(
            val expected: RelayV2AgentTranscriptEntryEntity,
            val next: RelayV2AgentTranscriptEntryEntity,
        ) : EntryMutationPlan
        data object Conflict : EntryMutationPlan
    }

    private fun AgentTranscriptLifecycleDurableTransaction.requireOperationState(
        fence: AgentTranscriptLifecycleDurableOperationFence,
    ): ReadyOperationState {
        if (fence.authority != fence.expectedNamespace.consumer) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        val decoded = loadSingle(fence.expectedNamespace.consumer)
            ?: throw AgentTranscriptLifecyclePersistenceMissingException()
        if (decoded.namespace != fence.expectedNamespace) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        return ReadyOperationState(
            decoded.namespace,
            decoded.state,
            decoded.storageAccounting
                ?: throw AgentTranscriptLifecyclePersistenceConflictException(),
            decoded.payload,
        )
    }

    private fun AgentTranscriptLifecycleDurableTransaction.persistOperationState(
        current: ReadyOperationState,
        nextState: AgentTranscriptLifecycleClientState,
        nextAccounting: AgentTranscriptDurableStorageAccounting,
    ): ReadyOperationState {
        val stripped = nextState.withoutRowOwnedMaterialization()
        requireNamespaceState(current.namespace, stripped)
        val nextPayload = AgentTranscriptLifecycleDurableStateCodec.encode(
            current.namespace,
            stripped,
            nextAccounting,
        )
        if (current.payload != nextPayload && compareAndSetState(
                AgentTranscriptLifecyclePersistedState(current.namespace, current.payload),
                AgentTranscriptLifecyclePersistedState(current.namespace, nextPayload),
            ) != 1
        ) throw AgentTranscriptLifecyclePersistenceConflictException()
        return ReadyOperationState(current.namespace, stripped, nextAccounting, nextPayload)
    }

    private fun closeEvent(
        record: PublicEventRecord,
        provenance: AgentEventProvenance,
    ): ClosedDurableEvent {
        val canonical = publicCodec.encodeCanonicalPublicEventRecord(record)
        val digest = AgentClosedEventDigest(digestBase64Url(canonical))
        return ClosedDurableEvent(
            publicRecord = record,
            mutation = record.toDomainMutation(),
            provenance = provenance,
            canonical = canonical,
            canonicalJson = strictStorageUtf8String(canonical),
            digest = digest,
        )
    }

    private fun ClosedDurableEvent.bindLineage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): AgentTranscriptLifecycleClientInput.AgentEvent =
        AgentTranscriptLifecycleClientInput.AgentEvent(
            lineage = AgentTimelineLineage(
                namespace.consumer.sessionIdentity,
                namespace.timelineEpoch
                    ?: throw AgentTranscriptLifecyclePersistenceConflictException(),
            ),
            agentEventSeq = publicRecord.agentEventSeq,
            eventId = publicRecord.eventId,
            closedEventDigest = digest,
            mutation = mutation,
            provenance = provenance,
        )

    private fun AgentTranscriptLifecycleDurableTransaction.bufferLiveEvent(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        current: ReadyOperationState,
        unbound: ClosedDurableEvent,
        rawArtifactUtf8Bytes: Int,
        reductionOverride: AgentTranscriptLifecycleClientReduction? = null,
    ): AgentTranscriptLifecycleClientReduction {
        val input = unbound.bindLineage(namespace)
        val bySeq = pendingEventBySeq(namespace, input.agentEventSeq)
        val byId = pendingEventByEventId(namespace, input.eventId)
        if (bySeq != null || byId != null) {
            if (bySeq == byId && bySeq?.closedEventDigest == unbound.digest.value &&
                bySeq.eventCanonicalJson == unbound.canonicalJson
            ) {
                return AgentTranscriptLifecycleClientReduction(
                    current.state,
                    AgentClientDisposition.DUPLICATE,
                )
            }
            val quarantine = continuityQuarantine(current.state)
            persistOperationState(current, quarantine.state, current.storageAccounting)
            return quarantine
        }
        val accounting = current.storageAccounting
        val nextCount = Math.addExact(accounting.pendingLiveEventCount, 1)
        val nextCanonical = Math.addExact(
            accounting.pendingLiveEventCanonicalBytes,
            unbound.canonical.size.toLong(),
        )
        val nextRaw = Math.addExact(
            accounting.pendingLiveEventRawUtf8Bytes,
            rawArtifactUtf8Bytes.toLong(),
        )
        if (nextCount > RelayV2StateLimits.MAX_BUFFERED_STATE_EVENTS ||
            nextCanonical > RelayV2StateLimits.MAX_BUFFERED_STATE_EVENT_BYTES ||
            nextRaw > RelayV2StateLimits.MAX_BUFFERED_STATE_EVENT_BYTES
        ) throw RelayV2StorageException(RelayV2StorageFailure.LIMIT_EXCEEDED)
        insertPendingEvent(unbound.toPendingEntity(namespace, rawArtifactUtf8Bytes))
        val reduction = reductionOverride ?: AgentTranscriptLifecycleClientReducer.reduce(
            current.state,
            input,
        )
        val nextAccounting = accounting.copy(
            pendingLiveEventCount = nextCount,
            pendingLiveEventCanonicalBytes = nextCanonical,
            pendingLiveEventRawUtf8Bytes = nextRaw,
        )
        persistOperationState(current, reduction.state, nextAccounting)
        return reduction.copy(state = reduction.state.withoutRowOwnedMaterialization())
    }

    private fun AgentTranscriptLifecycleDurableTransaction.consumeClosedEvent(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        current: ReadyOperationState,
        unbound: ClosedDurableEvent,
        rawArtifactUtf8Bytes: Int,
        limits: AgentClientReducerLimits,
    ): EventConsumption {
        val input = unbound.bindLineage(namespace)
        val hydrated = hydrateForEvent(namespace, current.state, unbound, input)
        val entryPlan = planEntryMutation(namespace, input)
        if (entryPlan == EntryMutationPlan.Conflict) {
            val quarantine = continuityQuarantine(current.state)
            return EventConsumption(
                persistOperationState(current, quarantine.state, current.storageAccounting),
                quarantine,
            )
        }
        val reduction = AgentTranscriptLifecycleClientReducer.reduce(hydrated, input, limits)
        if (reduction.disposition == AgentClientDisposition.GAP_RESYNC &&
            input.provenance == AgentEventProvenance.LIVE
        ) {
            val buffered = bufferLiveEvent(
                namespace,
                current,
                unbound,
                rawArtifactUtf8Bytes,
                reduction,
            )
            val reloadedDecoded = loadSingle(namespace.consumer)
                ?: throw AgentTranscriptLifecyclePersistenceMissingException()
            val reloaded = ReadyOperationState(
                namespace,
                reloadedDecoded.state,
                reloadedDecoded.storageAccounting
                    ?: throw AgentTranscriptLifecyclePersistenceConflictException(),
                reloadedDecoded.payload,
            )
            return EventConsumption(reloaded, buffered)
        }
        if (reduction.disposition != AgentClientDisposition.APPLIED) {
            val persisted = if (reduction.state.withoutRowOwnedMaterialization() != current.state) {
                persistOperationState(current, reduction.state, current.storageAccounting)
            } else {
                current
            }
            return EventConsumption(
                persisted,
                reduction.copy(state = reduction.state.withoutRowOwnedMaterialization()),
            )
        }

        val nextAccounting = applyAcceptedEventRows(
            namespace,
            current.storageAccounting,
            unbound,
            entryPlan,
            reduction,
        )
        val persisted = persistOperationState(current, reduction.state, nextAccounting)
        return EventConsumption(
            persisted,
            reduction.copy(state = reduction.state.withoutRowOwnedMaterialization()),
        )
    }

    private fun AgentTranscriptLifecycleDurableTransaction.hydrateForEvent(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        state: AgentTranscriptLifecycleClientState,
        closed: ClosedDurableEvent,
        input: AgentTranscriptLifecycleClientInput.AgentEvent,
    ): AgentTranscriptLifecycleClientState {
        val extension = state.extensionLane
        val currentRecords = extension.lifecycleByIdentity.toMutableMap()
        val currentByEvent = extension.currentLifecycleIdentityByEventId.toMutableMap()
        val witnesses = extension.eventWitnessById.toMutableMap()
        val applied = extension.appliedEventsBySeq.toMutableMap()
        val eventIdsBySeq = extension.eventIdBySeq.toMutableMap()
        val ledger = extension.notificationLedger.toMutableMap()
        val ledgerByEvent = extension.notificationKeyByLifecycleEventId.toMutableMap()
        val runsWithTurns = extension.runsWithTurnRecords.toMutableSet()

        fun bindSeq(sequence: String, eventId: String) {
            val prior = eventIdsBySeq.put(sequence, eventId)
            if (prior != null && prior != eventId) storageMalformed()
            if (eventIdsBySeq.any { (otherSeq, otherId) ->
                    otherSeq != sequence && otherId == eventId
                }
            ) storageMalformed()
        }
        fun addWitness(row: RelayV2AgentLifecycleEventWitnessEntity) {
            validateWitnessRow(namespace, row)
            val witness = row.toDomainWitness()
            val prior = witnesses.put(row.eventId, witness)
            if (prior != null && prior != witness) storageMalformed()
            bindSeq(row.agentEventSeq, row.eventId)
            row.closedEventDigest?.let { digest ->
                val evidence = AgentAppliedEventEvidence(row.eventId, AgentClosedEventDigest(digest))
                val old = applied.put(row.agentEventSeq, evidence)
                if (old != null && old != evidence) storageMalformed()
            }
        }
        fun addCurrent(row: RelayV2AgentLifecycleCurrentEntity) {
            requireExactLifecycleNamespace(namespace, row)
            val witness = witnessByEventId(namespace, row.lifecycleEventId)
                ?: storageMalformed()
            if (!row.pointsExactlyTo(witness)) storageMalformed()
            addWitness(witness)
            val record = witness.toDomainRecord()
            val old = currentRecords.put(record.identity, record)
            if (old != null && old != record) storageMalformed()
            val oldIdentity = currentByEvent.put(record.lifecycleEventId, record.identity)
            if (oldIdentity != null && oldIdentity != record.identity) storageMalformed()
        }
        fun addRecent(row: RelayV2AgentRecentEventEvidenceEntity) {
            requireExactLifecycleNamespace(namespace, row)
            val canonical = strictStorageUtf8(row.evidenceCanonicalJson)
            val decoded = try {
                publicCodec.decodeCanonicalPublicEventRecord(canonical)
            } catch (_: IllegalArgumentException) {
                storageMalformed()
            }
            if (decoded.agentEventSeq != row.agentEventSeq || decoded.eventId != row.eventId ||
                canonical.size != row.evidenceCanonicalUtf8Bytes ||
                sha256Hex(canonical) != row.evidenceSha256 ||
                digestBase64Url(canonical) != row.closedEventDigest
            ) storageMalformed()
            val evidence = AgentAppliedEventEvidence(
                row.eventId,
                AgentClosedEventDigest(row.closedEventDigest),
            )
            val old = applied.put(row.agentEventSeq, evidence)
            if (old != null && old != evidence) storageMalformed()
            bindSeq(row.agentEventSeq, row.eventId)
        }
        fun addLedger(row: RelayV2AgentNotificationLedgerEntity) {
            requireExactLifecycleNamespace(namespace, row)
            val witnessRow = witnessByEventId(namespace, row.lifecycleEventId)
                ?: storageMalformed()
            if (!row.pointsExactlyTo(witnessRow)) storageMalformed()
            addWitness(witnessRow)
            val witness = witnessRow.toDomainWitness()
            val key = AgentNotificationDedupeKey(
                namespace.consumer.profileId,
                namespace.consumer.hostId,
                namespace.consumer.hostEpoch,
                namespace.consumer.scopeId,
                namespace.consumer.sessionId,
                namespace.timelineEpoch ?: storageMalformed(),
                row.lifecycleEventId,
                row.lifecycleState.toLifecycleState(),
            )
            val entry = AgentNotificationLedgerEntry(
                AgentNotificationDisposition.valueOf(row.disposition),
                witness,
                row.localGeneration,
            )
            val old = ledger.put(key, entry)
            if (old != null && old != entry) storageMalformed()
            val oldKey = ledgerByEvent.put(row.lifecycleEventId, key)
            if (oldKey != null && oldKey != key) storageMalformed()
        }

        // The point-hydrated evidence and permanent witness namespaces are disjoint for
        // one applied event.  Never merge both sides into a synthetic duplicate: a local
        // corruption containing E xor W violations must abort this operation.
        val recentBySeq = recentEvidenceByAgentEventSeq(namespace, input.agentEventSeq)
        val recentById = recentEvidenceByEventId(namespace, input.eventId)
        val witnessBySeq = witnessByAgentEventSeq(namespace, input.agentEventSeq)
        val witnessById = witnessByEventId(namespace, input.eventId)
        if ((recentBySeq != null || recentById != null) &&
            (witnessBySeq != null || witnessById != null)
        ) storageMalformed()

        listOfNotNull(
            recentBySeq,
            recentById,
        ).distinct().forEach(::addRecent)
        listOfNotNull(
            witnessBySeq,
            witnessById,
        ).distinct().forEach(::addWitness)

        val lifecycle = (input.mutation as? AgentTimelineMutation.Lifecycle)?.record
        if (lifecycle != null) {
            listOfNotNull(
                lifecycleCurrentByIdentity(namespace, lifecycle.identity),
                lifecycleCurrentByEventId(namespace, lifecycle.lifecycleEventId),
                lifecycleCurrentByAgentEventSeq(namespace, lifecycle.agentEventSeq),
            ).distinct().forEach(::addCurrent)
            highestWitnessForIdentity(namespace, lifecycle.identity)?.let(::addWitness)
            currentRun(namespace, lifecycle.identity.runId)?.let { run ->
                addWitness(run)
                val record = run.toDomainRecord()
                currentRecords[record.identity] = record
                currentByEvent[record.lifecycleEventId] = record.identity
            }
            currentNonterminalTurnsForRun(namespace, lifecycle.identity.runId).forEach { turn ->
                addWitness(turn)
                val record = turn.toDomainRecord()
                currentRecords[record.identity] = record
                currentByEvent[record.lifecycleEventId] = record.identity
            }
            val sources = currentRunSourceEpochs(namespace, lifecycle.identity.runId)
            if (sources.size > 1) storageMalformed()
            terminalRunEvidence(namespace, lifecycle.identity.runId).forEach(::addWitness)
            if (hasPermanentTurnEvidence(namespace, lifecycle.identity.runId)) {
                runsWithTurns += lifecycle.identity.runId
            }
            notificationByLifecycleEventId(namespace, lifecycle.lifecycleEventId)
                ?.let(::addLedger)
        }

        return state.copy(
            extensionLane = extension.copy(
                lifecycleByIdentity = currentRecords,
                currentLifecycleIdentityByEventId = currentByEvent,
                runsWithTurnRecords = runsWithTurns,
                appliedEventsBySeq = applied,
                eventWitnessById = witnesses,
                eventIdBySeq = eventIdsBySeq,
                notificationLedger = ledger,
                notificationKeyByLifecycleEventId = ledgerByEvent,
            ),
        )
    }

    private fun AgentTranscriptLifecycleDurableTransaction.planEntryMutation(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        input: AgentTranscriptLifecycleClientInput.AgentEvent,
    ): EntryMutationPlan = when (val mutation = input.mutation) {
        is AgentTimelineMutation.Append -> {
            if (entryById(namespace, mutation.entry.entryId) != null) {
                EntryMutationPlan.Conflict
            } else {
                EntryMutationPlan.Insert(
                    visibleEntryEntity(namespace, mutation.entry),
                )
            }
        }
        is AgentTimelineMutation.Redact -> {
            val row = entryById(namespace, mutation.entryId) ?: return EntryMutationPlan.Conflict
            if (validateEntry(namespace, row) !is ValidatedAgentTranscriptEntry.Visible) {
                EntryMutationPlan.Conflict
            } else {
                EntryMutationPlan.Update(
                    row,
                    row.withEntryPayload(
                        lastModifiedAgentSeq = input.agentEventSeq,
                        entryState = ENTRY_STATE_REDACTED,
                        text = null,
                        redactionReason = mutation.reason.storageValue(),
                        tombstoneOrigin = null,
                        evidenceThrough = null,
                    ),
                )
            }
        }
        is AgentTimelineMutation.Delete -> {
            val row = entryById(namespace, mutation.entryId) ?: return EntryMutationPlan.Conflict
            if (validateEntry(namespace, row) is ValidatedAgentTranscriptEntry.Deleted) {
                EntryMutationPlan.Conflict
            } else {
                EntryMutationPlan.Update(
                    row,
                    row.withEntryPayload(
                        lastModifiedAgentSeq = input.agentEventSeq,
                        entryState = ENTRY_STATE_DELETED,
                        text = null,
                        redactionReason = mutation.reason.storageValue(),
                        tombstoneOrigin = AgentTranscriptEntryTombstoneOrigin.WIRE_DELETE.storageValue,
                        evidenceThrough = null,
                    ),
                )
            }
        }
        is AgentTimelineMutation.Lifecycle,
        is AgentTimelineMutation.SourceAvailability,
        -> EntryMutationPlan.None
    }

    private fun AgentTranscriptLifecycleDurableTransaction.applyAcceptedEventRows(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        accounting: AgentTranscriptDurableStorageAccounting,
        closed: ClosedDurableEvent,
        entryPlan: EntryMutationPlan,
        reduction: AgentTranscriptLifecycleClientReduction,
    ): AgentTranscriptDurableStorageAccounting {
        var next = when (entryPlan) {
            EntryMutationPlan.None -> accounting
            EntryMutationPlan.Conflict -> storageMalformed()
            is EntryMutationPlan.Insert -> {
                insertEntry(entryPlan.next)
                accounting.afterEntryInsert(entryPlan.next)
            }
            is EntryMutationPlan.Update -> {
                if (compareAndSetEntry(entryPlan.expected, entryPlan.next) != 1) {
                    throw AgentTranscriptLifecyclePersistenceConflictException()
                }
                accounting.afterEntryUpdate(entryPlan.expected, entryPlan.next)
            }
        }
        val lifecycle = (closed.publicRecord.mutation as? AgentTimelineLifecycleChangedMutation)
            ?.lifecycle
        if (lifecycle == null) {
            val evidence = closed.toRecentEvidenceEntity(namespace)
            insertRecentEvidence(listOf(evidence))
            next = next.copy(
                recentEventEvidenceCount = Math.addExact(next.recentEventEvidenceCount, 1),
                recentEventEvidenceCanonicalBytes = Math.addExact(
                    next.recentEventEvidenceCanonicalBytes,
                    evidence.evidenceCanonicalUtf8Bytes.toLong(),
                ),
            )
        } else {
            val witness = lifecycle.toWitnessEntity(namespace, closed.digest, publicCodec)
            insertLifecycleWitnesses(listOf(witness))
            val identity = witness.toDomainRecord().identity
            val current = lifecycleCurrentByIdentity(namespace, identity)
            val pointer = witness.toCurrentEntity()
            if (current == null) {
                insertLifecycleCurrent(listOf(pointer))
            } else if (updateLifecycleCurrentExact(current, pointer) != 1) {
                throw AgentTranscriptLifecyclePersistenceConflictException()
            }
            next = next.copy(
                lifecycleCurrentCount = if (current == null) {
                    Math.addExact(next.lifecycleCurrentCount, 1)
                } else {
                    next.lifecycleCurrentCount
                },
                lifecycleWitnessCount = Math.addExact(next.lifecycleWitnessCount, 1),
                lifecycleWitnessCanonicalBytes = Math.addExact(
                    next.lifecycleWitnessCanonicalBytes,
                    witness.witnessCanonicalUtf8Bytes.toLong(),
                ),
            )
        }
        reduction.notificationDecisions.forEach { decision ->
            val row = decision.toLedgerEntity(namespace)
            insertNotificationLedger(listOf(row))
            next = next.copy(
                notificationLedgerCount = Math.addExact(next.notificationLedgerCount, 1),
                notificationLedgerCanonicalBytes = Math.addExact(
                    next.notificationLedgerCanonicalBytes,
                    row.ledgerCanonicalUtf8Bytes.toLong(),
                ),
            )
        }
        return next
    }

    private fun AgentTranscriptLifecycleDurableTransaction.consumeSnapshotPage(
        command: AgentTranscriptLifecycleDurableSnapshotPageCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult {
        val namespace = command.fence.expectedNamespace
        var current = requireOperationState(command.fence)
        val artifact = command.artifact
        val extension = current.state.extensionLane
        if (extension.support != AgentExtensionSupport.AVAILABLE ||
            extension.syncState != AgentTimelineSyncState.Snapshot ||
            extension.effectiveHostLimits == null ||
            artifact.records.size > extension.effectiveHostLimits.maxPageRecords
        ) throw AgentTranscriptLifecyclePersistenceConflictException()

        val existingHeaders = snapshots(namespace)
        if (existingHeaders.size.toLong() != snapshotCount(namespace) ||
            existingHeaders.size > 1
        ) storageMalformed()
        val isFirst = existingHeaders.isEmpty()
        val header = if (isFirst) {
            val preFirst = extension.pendingSnapshotRequest
                ?: throw AgentTranscriptLifecyclePersistenceConflictException()
            if (artifact.pageIndex != 0L || artifact.snapshotRequestId != preFirst.snapshotRequestId ||
                artifact.requestId != preFirst.pageZeroNetworkToken ||
                preFirst.localGeneration != extension.localGeneration
            ) throw AgentTranscriptLifecyclePersistenceConflictException()
            RelayV2AgentTranscriptSnapshotStagingEntity(
                namespace.consumer.profileId,
                namespace.consumer.profileActivationGeneration,
                namespace.consumer.principalId,
                namespace.consumer.clientInstanceId,
                namespace.consumer.hostId,
                namespace.consumer.hostEpoch,
                namespace.consumer.scopeId,
                namespace.consumer.sessionId,
                namespace.timelineEpoch ?: storageMalformed(),
                artifact.snapshotRequestId,
                extension.localGeneration,
                artifact.requestId,
                artifact.snapshotId,
                0,
                null,
                artifact.throughAgentSeq,
                storageOrderKey(artifact.throughAgentSeq),
                artifact.earliestRetainedSeq,
                storageOrderKey(artifact.earliestRetainedSeq),
                0,
                2,
                0,
                null,
                null,
                null,
                null,
                false,
            ).also(::insertSnapshot)
        } else {
            existingHeaders.single().also { stored ->
                validateSnapshotHeader(namespace, current.state, stored)
                if (stored.requestLocalGeneration != extension.localGeneration ||
                    stored.requestNetworkToken != artifact.requestId ||
                    stored.snapshotRequestId != artifact.snapshotRequestId ||
                    stored.snapshotId != artifact.snapshotId ||
                    stored.nextPageIndex != artifact.pageIndex ||
                    stored.throughAgentSeq != artifact.throughAgentSeq ||
                    stored.earliestRetainedSeq != artifact.earliestRetainedSeq ||
                    stored.complete
                ) throw AgentTranscriptLifecyclePersistenceConflictException()
            }
        }

        val staged = closeSnapshotPage(namespace, header, artifact)
        insertSnapshotRecordBatches(staged.rows)
        var stateAfterPage = current.state
        if (isFirst) {
            val accepted = AgentTranscriptLifecycleClientReducer.reduce(
                stateAfterPage,
                AgentTranscriptLifecycleClientInput.SnapshotPageZeroAccepted(
                    stateAfterPage.extensionLane.pendingSnapshotRequest
                        ?: throw AgentTranscriptLifecyclePersistenceConflictException(),
                ),
                limits,
            )
            if (accepted.disposition != AgentClientDisposition.CONFIG_APPLIED) {
                throw AgentTranscriptLifecyclePersistenceConflictException()
            }
            stateAfterPage = accepted.state
        }
        val nextHeader = header.copy(
            requestNetworkToken = when (command) {
                is AgentTranscriptLifecycleDurableSnapshotPageCommand.NonFinalStage ->
                    command.nextRequestNetworkToken
                is AgentTranscriptLifecycleDurableSnapshotPageCommand.FinalPageCut ->
                    header.requestNetworkToken
            },
            nextPageIndex = Math.addExact(header.nextPageIndex, 1),
            nextCursor = artifact.nextCursor,
            receivedRecordCount = staged.totalCount,
            receivedCanonicalBytes = staged.totalCanonicalBytes,
            receivedRawUtf8Bytes = staged.totalRawBytes,
            lastAgentSeq = staged.lastAgentSeq,
            lastAgentSeqOrder = staged.lastAgentSeq?.let(::storageOrderKey),
            lastRecordKind = staged.lastRecordKind,
            lastStableIdentity = staged.lastStableIdentity,
            complete = false,
        )
        return when (command) {
            is AgentTranscriptLifecycleDurableSnapshotPageCommand.NonFinalStage -> {
                if (compareAndSetSnapshot(header, nextHeader) != 1) {
                    throw AgentTranscriptLifecyclePersistenceConflictException()
                }
                current = persistOperationState(
                    current,
                    stateAfterPage,
                    current.storageAccounting,
                )
                val reduction = AgentTranscriptLifecycleClientReduction(
                    current.state,
                    AgentClientDisposition.CONFIG_APPLIED,
                    syncDirective = AgentTimelineSyncDirective.Snapshot(
                        AgentTimelineLineage(
                            namespace.consumer.sessionIdentity,
                            namespace.timelineEpoch ?: storageMalformed(),
                        ),
                    ),
                )
                AgentTranscriptLifecycleDurableOperationResult(reduction)
            }
            is AgentTranscriptLifecycleDurableSnapshotPageCommand.FinalPageCut -> {
                val finalHeader = nextHeader.copy(complete = true)
                val namespaceStats = transcriptNamespaceStats(namespace)
                validateSnapshotRecordBatches(namespace, finalHeader, namespaceStats)
                commitFinalSnapshotCut(
                    namespace,
                    current.copy(state = stateAfterPage),
                    finalHeader,
                    limits,
                )
            }
        }
    }

    private data class ClosedSnapshotPage(
        val rows: List<RelayV2AgentTranscriptSnapshotRecordEntity>,
        val totalCount: Long,
        val totalCanonicalBytes: Long,
        val totalRawBytes: Long,
        val lastAgentSeq: String?,
        val lastRecordKind: String?,
        val lastStableIdentity: String?,
    )

    private fun closeSnapshotPage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        header: RelayV2AgentTranscriptSnapshotStagingEntity,
        artifact: com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotPagePublicFrameArtifact,
    ): ClosedSnapshotPage {
        var priorSeq = header.lastAgentSeq
        var priorIdentity = header.lastStableIdentity
        var index = header.receivedRecordCount
        var recordBytes = 0L
        var lastKind = header.lastRecordKind
        val rows = artifact.records.map { record ->
            val canonical = publicCodec.encodeCanonicalPublicSnapshotRecord(record)
            val identity: String
            val sequence: String
            val kind: String
            when (record) {
                is AgentTimelineVisibleTextEntryRecord -> {
                    identity = record.metadata.entryId
                    sequence = record.metadata.createdAgentSeq
                    kind = SNAPSHOT_RECORD_KIND_TEXT
                    if (compareStorageCounters(record.metadata.createdAgentSeq, artifact.throughAgentSeq) > 0 ||
                        compareStorageCounters(record.metadata.lastModifiedAgentSeq, artifact.throughAgentSeq) > 0
                    ) storageMalformed()
                }
                is AgentTimelineRedactedTextEntryRecord -> {
                    identity = record.metadata.entryId
                    sequence = record.metadata.createdAgentSeq
                    kind = SNAPSHOT_RECORD_KIND_TEXT
                    if (compareStorageCounters(record.metadata.createdAgentSeq, artifact.throughAgentSeq) > 0 ||
                        compareStorageCounters(record.metadata.lastModifiedAgentSeq, artifact.throughAgentSeq) > 0
                    ) storageMalformed()
                }
                is AgentTimelineLifecycleRecord -> {
                    identity = record.lifecycleEventId
                    sequence = record.agentEventSeq
                    kind = SNAPSHOT_RECORD_KIND_LIFECYCLE
                    if (compareStorageCounters(sequence, artifact.throughAgentSeq) > 0) {
                        storageMalformed()
                    }
                }
            }
            if (priorSeq != null && compareCanonicalAgentOrder(
                    priorSeq ?: storageMalformed(),
                    priorIdentity ?: storageMalformed(),
                    sequence,
                    identity,
                ) >= 0
            ) storageMalformed()
            val consumer = namespace.consumer
            RelayV2AgentTranscriptSnapshotRecordEntity(
                consumer.profileId, consumer.profileActivationGeneration, consumer.principalId,
                consumer.clientInstanceId, consumer.hostId, consumer.hostEpoch, consumer.scopeId,
                consumer.sessionId, namespace.timelineEpoch ?: storageMalformed(),
                artifact.snapshotId, artifact.pageIndex, index++, kind, identity, sequence,
                storageOrderKey(sequence), strictStorageUtf8String(canonical), canonical.size,
                sha256Hex(canonical),
            ).also {
                priorSeq = sequence
                priorIdentity = identity
                lastKind = kind
                recordBytes = Math.addExact(recordBytes, canonical.size.toLong())
            }
        }
        val totalCount = Math.addExact(header.receivedRecordCount, rows.size.toLong())
        if (totalCount > MAX_TRANSCRIPT_SNAPSHOT_CUT_RECORDS) {
            throw RelayV2StorageException(RelayV2StorageFailure.LIMIT_EXCEEDED)
        }
        val oldRecordBytes = header.receivedCanonicalBytes - 2L -
            if (header.receivedRecordCount > 0) header.receivedRecordCount - 1 else 0
        val totalCanonical = canonicalArrayBytes(totalCount, oldRecordBytes + recordBytes)
        // Raw accounting is owned by the codec artifact (the complete frame), not by
        // caller-supplied record metadata.  The envelope therefore contributes even when
        // this page has no records.
        val totalRaw = Math.addExact(
            header.receivedRawUtf8Bytes,
            artifact.rawUtf8ByteCount.toLong(),
        )
        if (totalCanonical > RelayV2StateLimits.MAX_SNAPSHOT_CANONICAL_BYTES ||
            totalRaw < totalCanonical ||
            totalRaw > RelayV2StateLimits.MAX_STAGED_RAW_UTF8_BYTES ||
            totalRaw > Math.multiplyExact(
                Math.addExact(header.nextPageIndex, 1),
                RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES.toLong(),
            )
        ) throw RelayV2StorageException(RelayV2StorageFailure.LIMIT_EXCEEDED)
        return ClosedSnapshotPage(
            rows,
            totalCount,
            totalCanonical,
            totalRaw,
            priorSeq,
            lastKind,
            priorIdentity,
        )
    }

    private fun AgentTranscriptLifecycleDurableTransaction.insertSnapshotRecordBatches(
        rows: List<RelayV2AgentTranscriptSnapshotRecordEntity>,
    ) {
        var batch = mutableListOf<RelayV2AgentTranscriptSnapshotRecordEntity>()
        var bytes = 0L
        fun flush() {
            if (batch.isNotEmpty()) insertSnapshotRecords(batch)
            batch = mutableListOf()
            bytes = 0
        }
        rows.forEach { row ->
            val nextBytes = canonicalArrayBytes(
                batch.size.toLong() + 1,
                bytes + row.payloadRawUtf8Bytes,
            )
            if (batch.isNotEmpty() && nextBytes >
                RelayV2StateLimits.MAX_SNAPSHOT_CHUNK_CANONICAL_BYTES
            ) flush()
            batch += row
            bytes += row.payloadRawUtf8Bytes
        }
        flush()
    }

    private fun AgentTranscriptLifecycleDurableTransaction.commitFinalSnapshotCut(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        currentBeforeCut: ReadyOperationState,
        header: RelayV2AgentTranscriptSnapshotStagingEntity,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult {
        // Destructive replacement is forbidden until the complete pre-state has been
        // strictly audited.  In particular, do not clear L/E or prune N and then audit the
        // cleaned graph: corruption must fail closed and leave the transaction unchanged.
        val preStateAudit = validateTranscriptStorage(
            namespace,
            currentBeforeCut.state,
        )
        if (preStateAudit.accounting != currentBeforeCut.storageAccounting) {
            storageMalformed()
        }
        retireSnapshotAbsentEntries(namespace, header)
        clearLifecycleCurrent(namespace, currentBeforeCut.storageAccounting.lifecycleCurrentCount)
        clearRecentEvidence(namespace)

        val nextGeneration = (BigInteger(currentBeforeCut.state.extensionLane.localGeneration) +
            BigInteger.ONE).takeIf { it <= UINT64_MAX_STORAGE }
            ?.toString() ?: throw AgentTranscriptLifecyclePersistenceConflictException()
        val prior = currentBeforeCut.state.extensionLane
        val baseline = prior.notificationBaselineAgentSeq ?: header.throughAgentSeq
        val decisions = mutableListOf<AgentNotificationDecision>()
        var afterRecordIndex = -1L
        var processed = 0L
        while (processed < header.receivedRecordCount) {
            val rows = snapshotRecords(
                namespace,
                header.snapshotId,
                afterRecordIndex,
                DURABLE_STORAGE_BATCH_RECORDS,
            )
            if (rows.isEmpty() || rows.size > DURABLE_STORAGE_BATCH_RECORDS) storageMalformed()
            rows.forEach { row ->
                val record = decodeCanonicalSnapshotRecord(strictStorageUtf8(row.payloadCanonicalJson))
                when (record) {
                    is AgentTimelineVisibleTextEntryRecord ->
                        applySnapshotTextRecord(namespace, record, header.throughAgentSeq)
                    is AgentTimelineRedactedTextEntryRecord ->
                        applySnapshotTextRecord(namespace, record, header.throughAgentSeq)
                    is AgentTimelineLifecycleRecord -> {
                        val witness = applySnapshotLifecycleRecord(namespace, record)
                        val decision = snapshotNotificationDecision(
                            namespace,
                            currentBeforeCut.state.notificationConfig,
                            prior,
                            nextGeneration,
                            baseline,
                            record.toDomainLifecycleRecord(),
                            witness,
                            decisions.size < limits.maxNotificationDecisionsPerReduction,
                        )
                        if (decision != null) decisions += decision
                    }
                }
            }
            processed += rows.size
            afterRecordIndex = rows.last().recordIndex
        }
        if (processed != header.receivedRecordCount ||
            snapshotRecords(namespace, header.snapshotId, afterRecordIndex, 1).isNotEmpty()
        ) storageMalformed()
        validateMaterializedLifecycleGraph(namespace)
        pruneSnapshotNotificationLedger(namespace)

        val nextExtension = prior.copy(
            localGeneration = nextGeneration,
            lastAgentSeq = header.throughAgentSeq,
            syncState = AgentTimelineSyncState.Current,
            notificationBaselineAgentSeq = baseline,
            lifecycleByIdentity = emptyMap(),
            currentLifecycleIdentityByEventId = emptyMap(),
            runsWithTurnRecords = emptySet(),
            appliedEventsBySeq = emptyMap(),
            eventWitnessById = emptyMap(),
            eventIdBySeq = emptyMap(),
            notificationLedger = emptyMap(),
            notificationKeyByLifecycleEventId = emptyMap(),
            snapshotCheckpoint = AgentSnapshotCheckpoint(header.throughAgentSeq, nextGeneration),
            snapshotNotificationSuppressedThroughAgentSeq = header.throughAgentSeq,
            pendingSnapshotRequest = null,
            requiresTimelineRotation = false,
        )
        val nextState = currentBeforeCut.state.copy(extensionLane = nextExtension)
        val rebuiltAccounting = rebuildAccountingAfterSnapshot(
            namespace,
            currentBeforeCut.storageAccounting,
        )
        var current = persistOperationState(
            currentBeforeCut,
            nextState,
            rebuiltAccounting,
        )
        if (deleteSnapshot(header) != 1) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        val bufferedDecisions = mutableListOf<AgentNotificationDecision>()
        while (true) {
            val rows = pendingEvents(namespace, null, DURABLE_STORAGE_BATCH_RECORDS)
            if (rows.isEmpty()) break
            rows.forEach { row ->
                val canonical = strictStorageUtf8(row.eventCanonicalJson)
                val event = try {
                    publicCodec.decodeCanonicalPublicEventRecord(canonical)
                } catch (_: IllegalArgumentException) {
                    storageMalformed()
                }
                if (event.agentEventSeq != row.agentEventSeq || event.eventId != row.eventId ||
                    digestBase64Url(canonical) != row.closedEventDigest
                ) storageMalformed()
                if (compareStorageCounters(row.agentEventSeq, header.throughAgentSeq) > 0) {
                    val consumed = consumeClosedEvent(
                        namespace,
                        current,
                        closeEvent(event, AgentEventProvenance.LIVE),
                        row.eventRawUtf8Bytes,
                        limits,
                    )
                    if (consumed.reduction.disposition !in setOf(
                            AgentClientDisposition.APPLIED,
                            AgentClientDisposition.DUPLICATE,
                        )
                    ) throw AgentTranscriptLifecyclePersistenceConflictException()
                    current = consumed.record
                    consumed.reduction.notificationDecisions.forEach { decision ->
                        if (decisions.size + bufferedDecisions.size <
                            limits.maxNotificationDecisionsPerReduction
                        ) bufferedDecisions += decision
                    }
                } else if (!hasExactAppliedEvidence(namespace, row)) {
                    storageMalformed()
                }
                if (deletePendingEvent(row) != 1) {
                    throw AgentTranscriptLifecyclePersistenceConflictException()
                }
                val nextAccounting = current.storageAccounting.copy(
                    pendingLiveEventCount = Math.subtractExact(
                        current.storageAccounting.pendingLiveEventCount,
                        1,
                    ),
                    pendingLiveEventCanonicalBytes = Math.subtractExact(
                        current.storageAccounting.pendingLiveEventCanonicalBytes,
                        canonical.size.toLong(),
                    ),
                    pendingLiveEventRawUtf8Bytes = Math.subtractExact(
                        current.storageAccounting.pendingLiveEventRawUtf8Bytes,
                        row.eventRawUtf8Bytes.toLong(),
                    ),
                )
                current = persistOperationState(current, current.state, nextAccounting)
            }
        }
        val reduction = AgentTranscriptLifecycleClientReduction(
            current.state,
            AgentClientDisposition.SNAPSHOT_APPLIED,
            decisions + bufferedDecisions,
        )
        return AgentTranscriptLifecycleDurableOperationResult(reduction)
    }

    private fun AgentTranscriptLifecycleDurableTransaction.retireSnapshotAbsentEntries(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        header: RelayV2AgentTranscriptSnapshotStagingEntity,
    ) {
        var afterOrder: String? = null
        var afterId: String? = null
        while (true) {
            val rows = entries(namespace, afterOrder, afterId, DURABLE_STORAGE_BATCH_RECORDS)
            if (rows.isEmpty()) break
            rows.forEach { row ->
                val staged = snapshotRecordsByStableIdentity(
                    namespace,
                    header.snapshotId,
                    row.entryId,
                ).filter { it.recordKind == SNAPSHOT_RECORD_KIND_TEXT }
                if (staged.size > 1) storageMalformed()
                val validated = validateEntry(namespace, row)
                if (staged.isEmpty() && validated !is ValidatedAgentTranscriptEntry.Deleted) {
                    val tombstone = row.withEntryPayload(
                        lastModifiedAgentSeq = row.lastModifiedAgentSeq,
                        entryState = ENTRY_STATE_DELETED,
                        text = null,
                        redactionReason = null,
                        tombstoneOrigin =
                            AgentTranscriptEntryTombstoneOrigin.SNAPSHOT_ABSENCE.storageValue,
                        evidenceThrough = header.throughAgentSeq,
                    )
                    if (compareAndSetEntry(row, tombstone) != 1) {
                        throw AgentTranscriptLifecyclePersistenceConflictException()
                    }
                }
            }
            afterOrder = rows.last().createdAgentSeqOrder
            afterId = rows.last().entryId
        }
    }

    private fun AgentTranscriptLifecycleDurableTransaction.applySnapshotTextRecord(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        record: AgentTimelineSnapshotRecord,
        throughAgentSeq: String,
    ) {
        val metadata = when (record) {
            is AgentTimelineVisibleTextEntryRecord -> record.metadata
            is AgentTimelineRedactedTextEntryRecord -> record.metadata
            else -> storageMalformed()
        }
        if (compareStorageCounters(metadata.createdAgentSeq, throughAgentSeq) > 0 ||
            compareStorageCounters(metadata.lastModifiedAgentSeq, throughAgentSeq) > 0
        ) storageMalformed()
        val base = RelayV2AgentTranscriptEntryEntity(
            namespace.consumer.profileId,
            namespace.consumer.profileActivationGeneration,
            namespace.consumer.principalId,
            namespace.consumer.clientInstanceId,
            namespace.consumer.hostId,
            namespace.consumer.hostEpoch,
            namespace.consumer.scopeId,
            namespace.consumer.sessionId,
            namespace.timelineEpoch ?: storageMalformed(),
            metadata.entryId,
            metadata.runId,
            metadata.turnId,
            metadata.role.name.lowercase(),
            metadata.commandId,
            metadata.createdAtMs,
            metadata.createdAgentSeq,
            storageOrderKey(metadata.createdAgentSeq),
            metadata.lastModifiedAgentSeq,
            storageOrderKey(metadata.lastModifiedAgentSeq),
            if (record is AgentTimelineVisibleTextEntryRecord) {
                ENTRY_STATE_VISIBLE
            } else {
                ENTRY_STATE_REDACTED
            },
            (record as? AgentTimelineVisibleTextEntryRecord)?.text,
            (record as? AgentTimelineRedactedTextEntryRecord)?.redactionReason
                ?.name?.lowercase(),
            null,
            null,
            null,
            "",
            0,
            "",
        ).withCanonicalEntryPayload()
        validateEntry(namespace, base)
        val old = entryById(namespace, metadata.entryId)
        if (old == null) {
            insertEntry(base)
        } else {
            if (validateEntry(namespace, old) is ValidatedAgentTranscriptEntry.Deleted ||
                old.runId != base.runId || old.turnId != base.turnId || old.role != base.role ||
                old.commandId != base.commandId || old.createdAtMs != base.createdAtMs ||
                old.createdAgentSeq != base.createdAgentSeq
            ) storageMalformed()
            if (compareAndSetEntry(old, base) != 1) {
                throw AgentTranscriptLifecyclePersistenceConflictException()
            }
        }
    }

    private fun AgentTranscriptLifecycleDurableTransaction.clearLifecycleCurrent(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        expectedCount: Long,
    ) {
        var deleted = 0L
        while (true) {
            val rows = lifecycleCurrentPage(namespace, "", "", DURABLE_STORAGE_BATCH_RECORDS)
            if (rows.isEmpty()) break
            rows.forEach { row ->
                if (deleteLifecycleCurrentExact(row) != 1) {
                    throw AgentTranscriptLifecyclePersistenceConflictException()
                }
                deleted++
            }
        }
        if (deleted != expectedCount) storageMalformed()
    }

    private fun AgentTranscriptLifecycleDurableTransaction.clearRecentEvidence(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ) {
        while (true) {
            val rows = recentEvidencePage(namespace, "", "", DURABLE_STORAGE_BATCH_RECORDS)
            if (rows.isEmpty()) break
            rows.forEach { row ->
                if (deleteRecentEvidenceExact(row) != 1) {
                    throw AgentTranscriptLifecyclePersistenceConflictException()
                }
            }
        }
    }

    private fun AgentTranscriptLifecycleDurableTransaction.applySnapshotLifecycleRecord(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        record: AgentTimelineLifecycleRecord,
    ): RelayV2AgentLifecycleEventWitnessEntity {
        val existingById = witnessByEventId(namespace, record.lifecycleEventId)
        val existingBySeq = witnessByAgentEventSeq(namespace, record.agentEventSeq)
        if ((existingById == null) != (existingBySeq == null) ||
            existingById != null && existingById != existingBySeq
        ) storageMalformed()
        val identity = record.toDomainLifecycleRecord().identity
        val highest = highestWitnessForIdentity(namespace, identity)
        if (highest != null) {
            when (compareStorageCounters(record.agentEventSeq, highest.agentEventSeq)) {
                -1 -> storageMalformed()
                0 -> if (existingById == null ||
                    existingById.witnessSha256 != record.toWitnessEntity(namespace, null, publicCodec).witnessSha256
                ) storageMalformed()
                else -> if (highest.sourceEpoch != record.sourceEpoch ||
                    highest.lifecycleState.toLifecycleState().terminal
                ) storageMalformed()
            }
        }
        val witness = existingById ?: record.toWitnessEntity(namespace, null, publicCodec).also {
            insertLifecycleWitnesses(listOf(it))
        }
        insertLifecycleCurrent(listOf(witness.toCurrentEntity()))
        return witness
    }

    private fun AgentTranscriptLifecycleDurableTransaction.snapshotNotificationDecision(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        config: AgentNotificationConfig,
        prior: AgentTranscriptLifecycleExtensionState,
        nextGeneration: String,
        baseline: String,
        record: AgentLifecycleRecord,
        witnessRow: RelayV2AgentLifecycleEventWitnessEntity,
        allowNotification: Boolean,
    ): AgentNotificationDecision? {
        if (!allowNotification) return null
        if (prior.notificationBaselineAgentSeq == null ||
            compareStorageCounters(record.agentEventSeq, baseline) <= 0 ||
            prior.snapshotNotificationSuppressedThroughAgentSeq?.let {
                compareStorageCounters(record.agentEventSeq, it) <= 0
            } == true || prior.liveSource != AgentLiveSourceState.CONNECTED ||
            prior.activeSourceEpoch != record.sourceEpoch
        ) return null
        val candidate = when (record.identity.scope) {
            AgentLifecycleScope.TURN -> record.state in setOf(
                AgentLifecycleState.WAITING_FOR_USER,
                AgentLifecycleState.FAILED,
                AgentLifecycleState.COMPLETED,
            )
            AgentLifecycleScope.RUN -> record.state in setOf(
                AgentLifecycleState.FAILED,
                AgentLifecycleState.COMPLETED,
            ) && !hasPermanentTurnEvidence(namespace, record.identity.runId)
        }
        if (!candidate) return null
        val existing = notificationByLifecycleEventId(namespace, record.lifecycleEventId)
        if (existing != null) {
            if (!existing.pointsExactlyTo(witnessRow)) storageMalformed()
            return null
        }
        val disposition = when {
            !config.profileActive -> AgentNotificationDisposition.SUPPRESSED_INACTIVE_PROFILE
            config.permission == AgentNotificationPermission.DENIED ->
                AgentNotificationDisposition.SUPPRESSED_PERMISSION
            config.policy == AgentNotificationPolicy.SUPPRESS ->
                AgentNotificationDisposition.SUPPRESSED_POLICY
            else -> AgentNotificationDisposition.SHOWN
        }
        val witness = witnessRow.toDomainWitness()
        val key = AgentNotificationDedupeKey(
            namespace.consumer.profileId,
            namespace.consumer.hostId,
            namespace.consumer.hostEpoch,
            namespace.consumer.scopeId,
            namespace.consumer.sessionId,
            namespace.timelineEpoch ?: storageMalformed(),
            record.lifecycleEventId,
            record.state,
        )
        val entry = AgentNotificationLedgerEntry(disposition, witness, nextGeneration)
        val intent = if (disposition == AgentNotificationDisposition.SHOWN) {
            AgentSystemNotificationIntent(key, nextGeneration)
        } else {
            null
        }
        return AgentNotificationDecision(key, entry, intent).also {
            insertNotificationLedger(listOf(it.toLedgerEntity(namespace)))
        }
    }

    private fun AgentTranscriptLifecycleDurableTransaction.validateMaterializedLifecycleGraph(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ) {
        var afterOrder = ""
        var afterEventId = ""
        while (true) {
            val rows = lifecycleCurrentPage(
                namespace,
                afterOrder,
                afterEventId,
                DURABLE_STORAGE_BATCH_RECORDS,
            )
            if (rows.isEmpty()) break
            rows.forEach { row ->
                val identity = row.toLifecycleIdentity()
                val sources = currentRunSourceEpochs(namespace, identity.runId)
                if (sources.size != 1) storageMalformed()
                val activeTurns = currentNonterminalTurnsForRun(namespace, identity.runId)
                if (activeTurns.size > 1) storageMalformed()
                val run = currentRun(namespace, identity.runId)
                if (run?.lifecycleState?.toLifecycleState()?.terminal == true &&
                    activeTurns.isNotEmpty()
                ) storageMalformed()
                if (run?.lifecycleState?.toLifecycleState() ==
                    AgentLifecycleState.WAITING_FOR_USER && activeTurns.any {
                        it.lifecycleState.toLifecycleState() !=
                            AgentLifecycleState.WAITING_FOR_USER
                    }
                ) storageMalformed()
            }
            afterOrder = rows.last().agentEventSeqOrder
            afterEventId = rows.last().lifecycleEventId
        }
    }

    private fun AgentTranscriptLifecycleDurableTransaction.pruneSnapshotNotificationLedger(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ) {
        var afterOrder = ""
        var afterEventId = ""
        var afterState = ""
        while (true) {
            val rows = notificationLedgerPage(
                namespace,
                afterOrder,
                afterEventId,
                afterState,
                DURABLE_STORAGE_BATCH_RECORDS,
            )
            if (rows.isEmpty()) break
            rows.forEach { row ->
                val current = lifecycleCurrentByEventId(namespace, row.lifecycleEventId)
                if (current == null || current.lifecycleEventId != row.lifecycleEventId ||
                    current.agentEventSeq != row.agentEventSeq ||
                    row.lifecycleState != witnessByEventId(
                        namespace,
                        row.lifecycleEventId,
                    )?.lifecycleState
                ) {
                    if (deleteNotificationLedgerExact(row) != 1) {
                        throw AgentTranscriptLifecyclePersistenceConflictException()
                    }
                }
            }
            val last = rows.last()
            afterOrder = last.agentEventSeqOrder
            afterEventId = last.lifecycleEventId
            afterState = last.lifecycleState
        }
    }

    private fun AgentTranscriptLifecycleDurableTransaction.rebuildAccountingAfterSnapshot(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        old: AgentTranscriptDurableStorageAccounting,
    ): AgentTranscriptDurableStorageAccounting {
        val stats = transcriptNamespaceStats(namespace)
        validateEntryBatches(namespace, UINT64_MAX_STORAGE.toString(), stats)
        val lifecycle = validateLifecycleIndex(namespace, UINT64_MAX_STORAGE.toString())
        return old.copy(
            entryCount = stats.entryCount,
            entryCanonicalBytes = canonicalArrayBytes(
                stats.entryCount,
                stats.entryPayloadUtf8Bytes,
            ),
            entryTextUtf8Bytes = stats.entryTextUtf8Bytes,
            lifecycleCurrentCount = lifecycle.currentCount,
            lifecycleCurrentCanonicalBytes = 0,
            lifecycleWitnessCount = lifecycle.witnessCount,
            lifecycleWitnessCanonicalBytes = lifecycle.witnessBytes,
            recentEventEvidenceCount = lifecycle.recentCount,
            recentEventEvidenceCanonicalBytes = lifecycle.recentBytes,
            notificationLedgerCount = lifecycle.notificationCount,
            notificationLedgerCanonicalBytes = lifecycle.notificationBytes,
        )
    }

    private fun AgentTranscriptLifecycleDurableTransaction.hasExactAppliedEvidence(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        row: RelayV2AgentTranscriptPendingEventEntity,
    ): Boolean {
        val recent = recentEvidenceByAgentEventSeq(namespace, row.agentEventSeq)
        if (recent != null) {
            return recent.eventId == row.eventId &&
                recent.closedEventDigest == row.closedEventDigest &&
                recentEvidenceByEventId(namespace, row.eventId) == recent
        }
        val witness = witnessByAgentEventSeq(namespace, row.agentEventSeq) ?: return false
        return witness.eventId == row.eventId && witness.closedEventDigest != null &&
            witness.closedEventDigest == row.closedEventDigest &&
            witnessByEventId(namespace, row.eventId) == witness
    }

    private fun validateTranscriptNamespaceStats(
        stats: RelayV2AgentTranscriptNamespaceStats,
    ) {
        if (stats.entryCount !in 0..MAX_MATERIALIZED_TRANSCRIPT_ROWS ||
            stats.entryPayloadUtf8Bytes !in
            0..RelayV2StateLimits.MAX_SNAPSHOT_CANONICAL_BYTES ||
            stats.entryTextUtf8Bytes !in 0..stats.entryPayloadUtf8Bytes ||
            stats.entryMaxBoundedTextUtf8Bytes !in 0..MAX_STORAGE_OPAQUE_ID_UTF8_BYTES ||
            stats.snapshotCount !in 0..1 ||
            stats.snapshotMaxIdUtf8Bytes !in 0..MAX_STORAGE_OPAQUE_ID_UTF8_BYTES ||
            stats.snapshotMaxCursorUtf8Bytes !in
            0..RelayV2StateLimits.MAX_CURSOR_UTF8_BYTES ||
            stats.snapshotRecordCount !in 0..MAX_TRANSCRIPT_SNAPSHOT_CUT_RECORDS ||
            stats.snapshotRecordPayloadUtf8Bytes !in
            0..RelayV2StateLimits.MAX_SNAPSHOT_CANONICAL_BYTES ||
            stats.snapshotRecordRawUtf8Bytes !in
            0..RelayV2StateLimits.MAX_STAGED_RAW_UTF8_BYTES ||
            stats.snapshotRecordMaxBoundedTextUtf8Bytes !in
            0..MAX_STORAGE_OPAQUE_ID_UTF8_BYTES ||
            stats.pendingEventCount !in
            0..RelayV2StateLimits.MAX_BUFFERED_STATE_EVENTS.toLong() ||
            stats.pendingEventPayloadUtf8Bytes !in
            0..RelayV2StateLimits.MAX_BUFFERED_STATE_EVENT_BYTES ||
            stats.pendingEventRawUtf8Bytes !in
            0..RelayV2StateLimits.MAX_BUFFERED_STATE_EVENT_BYTES ||
            stats.pendingEventMaxBoundedTextUtf8Bytes !in
            0..MAX_STORAGE_OPAQUE_ID_UTF8_BYTES
        ) storageMalformed()

        if (stats.entryCount == 0L) {
            if (stats.entryPayloadUtf8Bytes != 0L || stats.entryTextUtf8Bytes != 0L ||
                stats.entryMaxPayloadUtf8Bytes != 0L || stats.entryMaxTextUtf8Bytes != 0L ||
                stats.entryMaxBoundedTextUtf8Bytes != 0L
            ) storageMalformed()
        } else if (stats.entryMaxPayloadUtf8Bytes !in
            1..RelayV2StateLimits.MAX_SNAPSHOT_CHUNK_CANONICAL_BYTES.toLong() ||
            stats.entryMaxTextUtf8Bytes !in
            0..AgentTranscriptLifecycleV1Codec.MAX_TEXT_UTF8_BYTES.toLong() ||
            canonicalArrayBytes(
                stats.entryCount,
                stats.entryPayloadUtf8Bytes,
            ) > RelayV2StateLimits.MAX_SNAPSHOT_CANONICAL_BYTES
        ) storageMalformed()

        if (stats.snapshotRecordCount == 0L) {
            if (stats.snapshotRecordPayloadUtf8Bytes != 0L ||
                stats.snapshotRecordRawUtf8Bytes != 0L ||
                stats.snapshotRecordMinRawUtf8Bytes != 0L ||
                stats.snapshotRecordMaxRawUtf8Bytes != 0L ||
                stats.snapshotRecordMaxPayloadUtf8Bytes != 0L ||
                stats.snapshotRecordMaxBoundedTextUtf8Bytes != 0L
            ) storageMalformed()
        } else if (stats.snapshotCount != 1L ||
            stats.snapshotRecordMinRawUtf8Bytes !in
            1..RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES.toLong() ||
            stats.snapshotRecordMaxRawUtf8Bytes !in
            stats.snapshotRecordMinRawUtf8Bytes..RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES.toLong() ||
            stats.snapshotRecordMaxPayloadUtf8Bytes !in
            1..RelayV2StateLimits.MAX_SNAPSHOT_CHUNK_CANONICAL_BYTES.toLong() ||
            stats.snapshotRecordPayloadUtf8Bytes > stats.snapshotRecordRawUtf8Bytes ||
            canonicalArrayBytes(
                stats.snapshotRecordCount,
                stats.snapshotRecordPayloadUtf8Bytes,
            ) > RelayV2StateLimits.MAX_SNAPSHOT_CANONICAL_BYTES
        ) storageMalformed()

        if (stats.pendingEventCount == 0L) {
            if (stats.pendingEventPayloadUtf8Bytes != 0L ||
                stats.pendingEventRawUtf8Bytes != 0L ||
                stats.pendingEventMinRawUtf8Bytes != 0L ||
                stats.pendingEventMaxRawUtf8Bytes != 0L ||
                stats.pendingEventMaxPayloadUtf8Bytes != 0L ||
                stats.pendingEventMaxBoundedTextUtf8Bytes != 0L
            ) storageMalformed()
        } else if (stats.pendingEventMinRawUtf8Bytes !in
            1..RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES.toLong() ||
            stats.pendingEventMaxRawUtf8Bytes !in
            stats.pendingEventMinRawUtf8Bytes..RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES.toLong() ||
            stats.pendingEventMaxPayloadUtf8Bytes !in
            1..RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES.toLong() ||
            stats.pendingEventPayloadUtf8Bytes > stats.pendingEventRawUtf8Bytes
        ) storageMalformed()
    }

    private fun AgentTranscriptLifecycleDurableTransaction.validateEntryBatches(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        lastAgentSeq: String,
        stats: RelayV2AgentTranscriptNamespaceStats,
    ) {
        val storedEntryCount = stats.entryCount
        var processedCount = 0L
        var totalCanonicalBytes = 0L
        var totalTextBytes = 0L
        var afterOrder: String? = null
        var afterEntryId: String? = null
        var previousSequence: String? = null
        var previousEntryId: String? = null

        while (processedCount < storedEntryCount) {
            val metadata = entryBatchMetadata(
                namespace,
                afterOrder,
                afterEntryId,
                DURABLE_STORAGE_BATCH_RECORDS,
            )
            if (metadata.isEmpty() || metadata.size > DURABLE_STORAGE_BATCH_RECORDS) {
                storageMalformed()
            }
            var selectedCount = 0
            var selectedCanonicalBytes = 0L
            var selectedTextBytes = 0L
            for (item in metadata) {
                storageOpaque(item.entryId)
                requireCanonicalStorageCounter(item.createdAgentSeq, positive = true)
                requireExactOrderKey(item.createdAgentSeq, item.createdAgentSeqOrder)
                if (item.payloadUtf8Bytes.toLong() != item.actualPayloadUtf8Bytes ||
                    item.actualPayloadUtf8Bytes !in
                    1..RelayV2StateLimits.MAX_SNAPSHOT_CHUNK_CANONICAL_BYTES.toLong() ||
                    item.actualTextUtf8Bytes !in
                    0..AgentTranscriptLifecycleV1Codec.MAX_TEXT_UTF8_BYTES.toLong()
                ) storageMalformed()

                val nextCanonicalBytes = selectedCanonicalBytes + item.actualPayloadUtf8Bytes
                val nextTextBytes = selectedTextBytes + item.actualTextUtf8Bytes
                if (canonicalArrayBytes(selectedCount + 1L, nextCanonicalBytes) >
                    RelayV2StateLimits.MAX_SNAPSHOT_CHUNK_CANONICAL_BYTES ||
                    nextTextBytes > RelayV2StateLimits.MAX_SNAPSHOT_CHUNK_CANONICAL_BYTES
                ) {
                    break
                }
                selectedCanonicalBytes = nextCanonicalBytes
                selectedTextBytes = nextTextBytes
                selectedCount += 1
            }
            if (selectedCount == 0) storageMalformed()

            val rows = entries(namespace, afterOrder, afterEntryId, selectedCount)
            if (rows.size != selectedCount) storageMalformed()
            rows.forEachIndexed { index, row ->
                val item = metadata[index]
                val actualPayloadBytes = strictStorageUtf8(row.payloadCanonicalJson).size.toLong()
                val actualTextBytes = row.text?.let(::strictStorageUtf8)?.size?.toLong() ?: 0L
                if (row.createdAgentSeq != item.createdAgentSeq ||
                    row.createdAgentSeqOrder != item.createdAgentSeqOrder ||
                    row.entryId != item.entryId ||
                    row.payloadUtf8Bytes != item.payloadUtf8Bytes ||
                    actualPayloadBytes != item.actualPayloadUtf8Bytes ||
                    actualTextBytes != item.actualTextUtf8Bytes
                ) storageMalformed()
                validateEntry(namespace, row, lastAgentSeq)
                if (previousSequence != null &&
                    compareCanonicalAgentOrder(
                        previousSequence ?: storageMalformed(),
                        previousEntryId ?: storageMalformed(),
                        row.createdAgentSeq,
                        row.entryId,
                    ) >= 0
                ) storageMalformed()
                previousSequence = row.createdAgentSeq
                previousEntryId = row.entryId
            }
            processedCount += selectedCount
            if (processedCount > storedEntryCount) storageMalformed()
            totalCanonicalBytes = addBounded(
                totalCanonicalBytes,
                selectedCanonicalBytes,
                RelayV2StateLimits.MAX_SNAPSHOT_CANONICAL_BYTES,
            )
            totalTextBytes = addBounded(
                totalTextBytes,
                selectedTextBytes,
                RelayV2StateLimits.MAX_SNAPSHOT_CANONICAL_BYTES,
            )
            val last = rows.last()
            afterOrder = last.createdAgentSeqOrder
            afterEntryId = last.entryId
        }

        if (entryBatchMetadata(namespace, afterOrder, afterEntryId, 1).isNotEmpty()) {
            storageMalformed()
        }
        if (totalCanonicalBytes != stats.entryPayloadUtf8Bytes ||
            totalTextBytes != stats.entryTextUtf8Bytes ||
            canonicalArrayBytes(processedCount, totalCanonicalBytes) >
            RelayV2StateLimits.MAX_SNAPSHOT_CANONICAL_BYTES
        ) storageMalformed()
    }

    private fun validateSnapshotHeader(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        state: AgentTranscriptLifecycleClientState,
        row: RelayV2AgentTranscriptSnapshotStagingEntity,
    ) {
        requireExactTranscriptNamespace(
            namespace,
            row.profileId,
            row.profileActivationGeneration,
            row.principalId,
            row.clientInstanceId,
            row.hostId,
            row.hostEpoch,
            row.scopeId,
            row.sessionId,
            row.timelineEpoch,
        )
        storageOpaque(row.snapshotRequestId)
        storageOpaque(row.requestNetworkToken)
        storageOpaque(row.snapshotId)
        requireCanonicalStorageCounter(row.requestLocalGeneration)
        requireCanonicalStorageCounter(row.throughAgentSeq, positive = true)
        requireCanonicalStorageCounter(row.earliestRetainedSeq, positive = true)
        requireExactOrderKey(row.throughAgentSeq, row.throughAgentSeqOrder)
        requireExactOrderKey(row.earliestRetainedSeq, row.earliestRetainedSeqOrder)
        if (compareStorageCounters(row.earliestRetainedSeq, row.throughAgentSeq) > 0 ||
            compareStorageCounters(state.extensionLane.lastAgentSeq, row.throughAgentSeq) > 0 ||
            row.requestLocalGeneration != state.extensionLane.localGeneration ||
            state.extensionLane.syncState != AgentTimelineSyncState.Snapshot ||
            state.extensionLane.pendingSnapshotRequest != null ||
            row.receivedRecordCount !in 0..MAX_TRANSCRIPT_SNAPSHOT_CUT_RECORDS ||
            row.nextPageIndex !in
            1..maximumSnapshotPages(row.receivedRecordCount, row.complete) ||
            row.receivedCanonicalBytes !in
            2..RelayV2StateLimits.MAX_SNAPSHOT_CANONICAL_BYTES ||
            row.receivedRawUtf8Bytes !in
            maxOf(row.nextPageIndex, row.receivedCanonicalBytes)..maximumSnapshotRawBytes(
                row.nextPageIndex,
            ) ||
            row.complete != (row.nextCursor == null)
        ) storageMalformed()
        row.nextCursor?.let(::storageCursor)
        val lastTuple = listOf(
            row.lastAgentSeq,
            row.lastAgentSeqOrder,
            row.lastRecordKind,
            row.lastStableIdentity,
        )
        if (lastTuple.any { it == null } != lastTuple.all { it == null }) storageMalformed()
        if ((row.receivedRecordCount == 0L) != lastTuple.all { it == null }) storageMalformed()
        row.lastAgentSeq?.let { lastSequence ->
            requireCanonicalStorageCounter(lastSequence)
            requireExactOrderKey(lastSequence, row.lastAgentSeqOrder ?: storageMalformed())
            if (row.lastRecordKind !in SNAPSHOT_RECORD_KINDS) storageMalformed()
            storageOpaque(row.lastStableIdentity)
        }
    }

    private fun AgentTranscriptLifecycleDurableTransaction.validateSnapshotRecordBatches(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        header: RelayV2AgentTranscriptSnapshotStagingEntity,
        stats: RelayV2AgentTranscriptNamespaceStats,
    ) {
        val storedRecordCount = stats.snapshotRecordCount
        var processedCount = 0L
        var totalRecordJsonBytes = 0L
        var afterRecordIndex = -1L
        var expectedPageIndex = 0L
        var previousSequence: String? = null
        var previousStableIdentity: String? = null
        var lastRecordKind: String? = null
        var lastSequenceOrder: String? = null

        while (processedCount < storedRecordCount) {
            val metadata = snapshotRecordBatchMetadata(
                namespace,
                header.snapshotId,
                afterRecordIndex,
                DURABLE_STORAGE_BATCH_RECORDS,
            )
            if (metadata.isEmpty() || metadata.size > DURABLE_STORAGE_BATCH_RECORDS) {
                storageMalformed()
            }
            val pageIndex = metadata.first().pageIndex
            if (pageIndex != expectedPageIndex || pageIndex >= header.nextPageIndex) {
                storageMalformed()
            }
            var selectedCount = 0
            var pageCanonicalBytes = 0L
            var pageRecordRawBytes = 0L
            for (item in metadata) {
                if (item.pageIndex != pageIndex) break
                if (item.recordIndex != processedCount + selectedCount ||
                    item.actualPayloadUtf8Bytes !in
                    1..RelayV2StateLimits.MAX_SNAPSHOT_CHUNK_CANONICAL_BYTES.toLong() ||
                    item.payloadRawUtf8Bytes.toLong() !in
                    item.actualPayloadUtf8Bytes..RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES.toLong()
                ) storageMalformed()
                val nextPageCanonicalBytes = pageCanonicalBytes + item.actualPayloadUtf8Bytes
                if (canonicalArrayBytes(
                        selectedCount + 1L,
                        nextPageCanonicalBytes,
                    ) > RelayV2StateLimits.MAX_SNAPSHOT_CHUNK_CANONICAL_BYTES
                ) storageMalformed()
                pageCanonicalBytes = nextPageCanonicalBytes
                pageRecordRawBytes = addBounded(
                    pageRecordRawBytes,
                    item.payloadRawUtf8Bytes.toLong(),
                    RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES.toLong(),
                )
                selectedCount += 1
            }
            if (selectedCount == 0 ||
                selectedCount > RelayV2StateLimits.MAX_SNAPSHOT_CHUNK_RECORDS
            ) storageMalformed()

            val rows = snapshotRecords(
                namespace,
                header.snapshotId,
                afterRecordIndex,
                selectedCount,
            )
            if (rows.size != selectedCount) storageMalformed()
            rows.forEachIndexed { index, row ->
                val item = metadata[index]
                requireExactTranscriptNamespace(
                    namespace,
                    row.profileId,
                    row.profileActivationGeneration,
                    row.principalId,
                    row.clientInstanceId,
                    row.hostId,
                    row.hostEpoch,
                    row.scopeId,
                    row.sessionId,
                    row.timelineEpoch,
                )
                val canonical = strictStorageUtf8(row.payloadCanonicalJson)
                if (row.snapshotId != header.snapshotId ||
                    row.recordIndex != item.recordIndex ||
                    row.pageIndex != item.pageIndex ||
                    row.payloadRawUtf8Bytes != item.payloadRawUtf8Bytes ||
                    canonical.size.toLong() != item.actualPayloadUtf8Bytes ||
                    sha256Hex(canonical) != row.payloadSha256
                ) storageMalformed()
                if (row.recordKind !in SNAPSHOT_RECORD_KINDS) storageMalformed()
                storageOpaque(row.stableIdentity)
                requireCanonicalStorageCounter(row.agentEventSeq, positive = true)
                requireExactOrderKey(row.agentEventSeq, row.agentEventSeqOrder)
                val record = decodeCanonicalSnapshotRecord(canonical)
                requireSnapshotRecordColumns(row, record)
                if (previousSequence != null &&
                    compareCanonicalAgentOrder(
                        previousSequence ?: storageMalformed(),
                        previousStableIdentity ?: storageMalformed(),
                        row.agentEventSeq,
                        row.stableIdentity,
                    ) >= 0
                ) storageMalformed()
                previousSequence = row.agentEventSeq
                previousStableIdentity = row.stableIdentity
                lastSequenceOrder = row.agentEventSeqOrder
                lastRecordKind = row.recordKind
            }
            processedCount += selectedCount
            if (processedCount > storedRecordCount) storageMalformed()
            totalRecordJsonBytes = addBounded(
                totalRecordJsonBytes,
                pageCanonicalBytes,
                RelayV2StateLimits.MAX_SNAPSHOT_CANONICAL_BYTES,
            )
            afterRecordIndex = rows.last().recordIndex
            expectedPageIndex += 1L
        }

        if (snapshotRecordBatchMetadata(
                namespace,
                header.snapshotId,
                afterRecordIndex,
                1,
            ).isNotEmpty()
        ) storageMalformed()
        val hasEmptyFinalPage = header.complete && header.nextPageIndex == expectedPageIndex + 1L
        if (storedRecordCount == 0L) {
            if (!header.complete || header.nextPageIndex != 1L) storageMalformed()
        } else if (header.nextPageIndex != expectedPageIndex && !hasEmptyFinalPage) {
            storageMalformed()
        }
        val totalCanonicalArrayBytes = canonicalArrayBytes(processedCount, totalRecordJsonBytes)
        if (totalRecordJsonBytes != stats.snapshotRecordPayloadUtf8Bytes ||
            header.receivedRecordCount != processedCount ||
            header.receivedCanonicalBytes != totalCanonicalArrayBytes ||
            header.lastAgentSeq != previousSequence ||
            header.lastAgentSeqOrder != lastSequenceOrder ||
            header.lastRecordKind != lastRecordKind ||
            header.lastStableIdentity != previousStableIdentity
        ) storageMalformed()
    }

    private fun requireSnapshotRecordColumns(
        row: RelayV2AgentTranscriptSnapshotRecordEntity,
        record: AgentTimelineSnapshotRecord,
    ) {
        val expected = when (record) {
            is AgentTimelineVisibleTextEntryRecord -> Triple(
                SNAPSHOT_RECORD_KIND_TEXT,
                record.metadata.entryId,
                record.metadata.createdAgentSeq,
            )
            is AgentTimelineRedactedTextEntryRecord -> Triple(
                SNAPSHOT_RECORD_KIND_TEXT,
                record.metadata.entryId,
                record.metadata.createdAgentSeq,
            )
            is AgentTimelineLifecycleRecord -> Triple(
                SNAPSHOT_RECORD_KIND_LIFECYCLE,
                record.lifecycleEventId,
                record.agentEventSeq,
            )
        }
        if (row.recordKind != expected.first ||
            row.stableIdentity != expected.second ||
            row.agentEventSeq != expected.third
        ) storageMalformed()
    }

    private fun decodeCanonicalSnapshotRecord(bytes: ByteArray): AgentTimelineSnapshotRecord =
        try {
            val record = publicCodec.decodeCanonicalPublicSnapshotRecord(bytes)
            if (!MessageDigest.isEqual(
                    publicCodec.encodeCanonicalPublicSnapshotRecord(record),
                    bytes,
                )
            ) {
                storageMalformed()
            }
            record
        } catch (_: IllegalArgumentException) {
            storageMalformed()
        }

    private fun AgentTranscriptLifecycleDurableTransaction.validatePendingEventBatches(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        state: AgentTranscriptLifecycleClientState,
        stats: RelayV2AgentTranscriptNamespaceStats,
    ) {
        if (stats.pendingEventCount != 0L &&
            state.extensionLane.syncState == AgentTimelineSyncState.Current
        ) {
            storageMalformed()
        }
        val eventIdsBySeq = linkedMapOf<String, String>()
        val seqByEventId = linkedMapOf<String, String>()
        var previous: RelayV2AgentTranscriptPendingEventEntity? = null
        var canonicalBytes = 0L
        var rawBytes = 0L
        var processed = 0L
        var afterOrder: String? = null
        while (processed < stats.pendingEventCount) {
            val metadata = pendingEventBatchMetadata(
                namespace,
                afterOrder,
                DURABLE_STORAGE_BATCH_RECORDS,
            )
            if (metadata.isEmpty() || metadata.size > DURABLE_STORAGE_BATCH_RECORDS) {
                storageMalformed()
            }
            val rows = pendingEvents(namespace, afterOrder, metadata.size)
            if (rows.size != metadata.size) storageMalformed()
            rows.forEachIndexed { index, row ->
                val item = metadata[index]
                requireExactTranscriptNamespace(
                    namespace,
                    row.profileId,
                    row.profileActivationGeneration,
                    row.principalId,
                    row.clientInstanceId,
                    row.hostId,
                    row.hostEpoch,
                    row.scopeId,
                    row.sessionId,
                    row.timelineEpoch,
                )
                requireCanonicalStorageCounter(row.agentEventSeq, positive = true)
                requireExactOrderKey(row.agentEventSeq, row.agentEventSeqOrder)
                storageOpaque(row.eventId)
                if (row.agentEventSeq != item.agentEventSeq ||
                    row.agentEventSeqOrder != item.agentEventSeqOrder ||
                    row.eventId != item.eventId ||
                    row.eventRawUtf8Bytes != item.eventRawUtf8Bytes ||
                    item.actualPayloadUtf8Bytes !=
                    strictStorageUtf8(row.eventCanonicalJson).size.toLong() ||
                    eventIdsBySeq.put(row.agentEventSeq, row.eventId) != null ||
                    seqByEventId.put(row.eventId, row.agentEventSeq) != null ||
                    row.trustedProvenance != TRUSTED_LIVE_PROVENANCE ||
                    compareStorageCounters(row.agentEventSeq, state.extensionLane.lastAgentSeq) <= 0
                ) storageMalformed()
                val canonical = strictStorageUtf8(row.eventCanonicalJson)
                if (canonical.isEmpty() ||
                    canonical.size > AgentTranscriptLifecycleV1Codec.MAX_PUBLIC_FRAME_BYTES ||
                    row.eventRawUtf8Bytes !in
                    canonical.size..AgentTranscriptLifecycleV1Codec.MAX_PUBLIC_FRAME_BYTES
                ) storageMalformed()
                val event = try {
                    publicCodec.decodeCanonicalPublicEventRecord(canonical)
                } catch (_: IllegalArgumentException) {
                    storageMalformed()
                }
                val recanonical = publicCodec.encodeCanonicalPublicEventRecord(event)
                if (!MessageDigest.isEqual(canonical, recanonical) ||
                    event.agentEventSeq != row.agentEventSeq ||
                    event.eventId != row.eventId ||
                    digestBase64Url(canonical) != row.closedEventDigest
                ) storageMalformed()
                previous?.let { prior ->
                    if (compareStorageCounters(prior.agentEventSeq, row.agentEventSeq) >= 0) {
                        storageMalformed()
                    }
                }
                previous = row
                canonicalBytes = addBounded(
                    canonicalBytes,
                    canonical.size.toLong(),
                    RelayV2StateLimits.MAX_BUFFERED_STATE_EVENT_BYTES,
                )
                rawBytes = addBounded(
                    rawBytes,
                    row.eventRawUtf8Bytes.toLong(),
                    RelayV2StateLimits.MAX_BUFFERED_STATE_EVENT_BYTES,
                )
            }
            processed += rows.size
            afterOrder = rows.last().agentEventSeqOrder
        }
        if (pendingEventBatchMetadata(namespace, afterOrder, 1).isNotEmpty() ||
            processed != stats.pendingEventCount ||
            canonicalBytes != stats.pendingEventPayloadUtf8Bytes ||
            rawBytes != stats.pendingEventRawUtf8Bytes
        ) storageMalformed()
    }

    suspend fun claimNotificationUnderApplyLease(
        expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
        intent: AgentSystemNotificationIntent,
    ): AgentTranscriptLifecycleNotificationClaimResult {
        val transactionResult = store.transaction {
            val current = loadSingle(expectedNamespace.consumer)
                ?: return@transaction NotificationClaimTransactionResult.NotExecutable(
                    AgentTranscriptLifecycleNotificationNotExecutableReason.STATE_MISSING,
                )
            if (current.namespace != expectedNamespace) {
                return@transaction NotificationClaimTransactionResult.NotExecutable(
                    AgentTranscriptLifecycleNotificationNotExecutableReason.NAMESPACE_CHANGED,
                )
            }
            val key = AgentTranscriptLifecycleNotificationClaimKey.exactOrNull(
                expectedNamespace,
                intent,
            ) ?: return@transaction NotificationClaimTransactionResult.NotExecutable(
                AgentTranscriptLifecycleNotificationNotExecutableReason.INTENT_NOT_CURRENT,
            )

            val existingClaims = notificationClaims(key.eventIdentity).onEach { existing ->
                AgentTranscriptLifecycleNotificationClaimCodec.decode(
                    existing.key,
                    existing.claimedLocalGeneration,
                    existing.payload,
                )
                if (existing.key.eventIdentity != key.eventIdentity) {
                    throw AgentTranscriptLifecyclePersistenceConflictException()
                }
            }
            if (existingClaims.size > 1) {
                throw AgentTranscriptLifecyclePersistenceConflictException()
            }
            val existing = existingClaims.singleOrNull()
            if (existing != null && existing.key != key) {
                throw AgentTranscriptLifecyclePersistenceConflictException()
            }

            if (!intent.isPreflightAuthorizedBy(current.state)) {
                return@transaction NotificationClaimTransactionResult.NotExecutable(
                    AgentTranscriptLifecycleNotificationNotExecutableReason.INTENT_NOT_CURRENT,
                )
            }
            if (existing != null) {
                return@transaction NotificationClaimTransactionResult.NotExecutable(
                    AgentTranscriptLifecycleNotificationNotExecutableReason.ALREADY_CLAIMED,
                )
            }

            val payload = AgentTranscriptLifecycleNotificationClaimCodec.encode(key, intent)
            insertNotificationClaim(
                AgentTranscriptLifecyclePersistedNotificationClaim(
                    key,
                    intent.localGeneration,
                    payload,
                ),
            )
            NotificationClaimTransactionResult.Committed(
                key,
                intent,
                payload.sha256,
            )
        }

        // Room withTransaction returns only after commit. No execution authority escapes earlier.
        return when (transactionResult) {
            is NotificationClaimTransactionResult.Committed ->
                AgentTranscriptLifecycleNotificationClaimResult.Claimed(
                    AgentTranscriptLifecycleNotificationExecutionTicket(
                        transactionResult.claimId,
                        AgentTranscriptLifecycleDurableNamespace(
                            transactionResult.key.consumer,
                            transactionResult.key.timelineEpoch,
                        ),
                        transactionResult.intent,
                    ),
                )
            is NotificationClaimTransactionResult.NotExecutable ->
                AgentTranscriptLifecycleNotificationClaimResult.NotExecutable(
                    transactionResult.reason,
                )
        }
    }

    private fun AgentTranscriptLifecycleDurableTransaction.loadSingle(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): DecodedAgentTranscriptLifecycleDurableRecord? {
        val count = stateCount(consumer)
        val rows = states(consumer)
        if (count != rows.size.toLong() || count > 1L) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        val row = rows.singleOrNull() ?: return null
        if (row.namespace.consumer != consumer) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        val decoded = AgentTranscriptLifecycleDurableStateCodec.decode(row.namespace, row.payload)
        requireNamespaceState(row.namespace, decoded.state)
        return DecodedAgentTranscriptLifecycleDurableRecord(
            row.namespace,
            decoded.state,
            decoded.storageAccounting,
            row.payload,
        )
    }

    private fun requireNamespaceState(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        state: AgentTranscriptLifecycleClientState,
    ) {
        if (state.identity != namespace.consumer.sessionIdentity ||
            state.extensionLane.timelineEpoch != namespace.timelineEpoch
        ) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
    }
}

private fun validateEntry(
    namespace: AgentTranscriptLifecycleDurableNamespace,
    row: RelayV2AgentTranscriptEntryEntity,
    lastAgentSeq: String = UINT64_MAX_STORAGE.toString(),
): ValidatedAgentTranscriptEntry {
    requireExactTranscriptNamespace(
        namespace,
        row.profileId,
        row.profileActivationGeneration,
        row.principalId,
        row.clientInstanceId,
        row.hostId,
        row.hostEpoch,
        row.scopeId,
        row.sessionId,
        row.timelineEpoch,
    )
    storageOpaque(row.entryId)
    storageOpaque(row.runId)
    storageOpaque(row.turnId)
    row.commandId?.let(::storageOpaque)
    if (row.role !in ENTRY_ROLES ||
        row.role == ENTRY_ROLE_AGENT && row.commandId != null ||
        row.createdAtMs !in 0..MAX_STORAGE_WIRE_INTEGER
    ) storageMalformed()
    requireCanonicalStorageCounter(row.createdAgentSeq, positive = true)
    requireCanonicalStorageCounter(row.lastModifiedAgentSeq, positive = true)
    if (compareStorageCounters(row.createdAgentSeq, lastAgentSeq) > 0 ||
        compareStorageCounters(row.lastModifiedAgentSeq, lastAgentSeq) > 0 ||
        row.tombstoneEvidenceThroughAgentSeq?.let {
            compareStorageCounters(it, lastAgentSeq) > 0
        } == true
    ) storageMalformed()
    requireExactOrderKey(row.createdAgentSeq, row.createdAgentSeqOrder)
    requireExactOrderKey(row.lastModifiedAgentSeq, row.lastModifiedAgentSeqOrder)
    if (compareStorageCounters(row.createdAgentSeq, row.lastModifiedAgentSeq) > 0) {
        storageMalformed()
    }

    val validated = when (row.entryState) {
        ENTRY_STATE_VISIBLE -> {
            val text = row.text ?: storageMalformed()
            val textBytes = strictStorageUtf8(text)
            if ('\u0000' in text || textBytes.size > AgentTranscriptLifecycleV1Codec.MAX_TEXT_UTF8_BYTES ||
                row.createdAgentSeq != row.lastModifiedAgentSeq ||
                row.redactionReason != null ||
                row.tombstoneOrigin != null ||
                row.tombstoneEvidenceThroughAgentSeq != null ||
                row.tombstoneEvidenceThroughAgentSeqOrder != null
            ) storageMalformed()
            ValidatedAgentTranscriptEntry.Visible(row)
        }
        ENTRY_STATE_REDACTED -> {
            val reason = decodeStorageRedactionReason(row.redactionReason)
            if (row.text != null ||
                compareStorageCounters(row.createdAgentSeq, row.lastModifiedAgentSeq) >= 0 ||
                row.tombstoneOrigin != null ||
                row.tombstoneEvidenceThroughAgentSeq != null ||
                row.tombstoneEvidenceThroughAgentSeqOrder != null
            ) storageMalformed()
            ValidatedAgentTranscriptEntry.Redacted(row, reason)
        }
        ENTRY_STATE_DELETED -> when (row.tombstoneOrigin) {
            AgentTranscriptEntryTombstoneOrigin.WIRE_DELETE.storageValue -> {
                val reason = decodeStorageRedactionReason(row.redactionReason)
                if (row.text != null ||
                    compareStorageCounters(row.createdAgentSeq, row.lastModifiedAgentSeq) >= 0 ||
                    row.tombstoneEvidenceThroughAgentSeq != null ||
                    row.tombstoneEvidenceThroughAgentSeqOrder != null
                ) storageMalformed()
                ValidatedAgentTranscriptEntry.Deleted.Wire(row, reason)
            }
            AgentTranscriptEntryTombstoneOrigin.SNAPSHOT_ABSENCE.storageValue -> {
                val evidence = row.tombstoneEvidenceThroughAgentSeq ?: storageMalformed()
                val evidenceOrder = row.tombstoneEvidenceThroughAgentSeqOrder ?: storageMalformed()
                requireCanonicalStorageCounter(evidence, positive = true)
                requireExactOrderKey(evidence, evidenceOrder)
                if (row.text != null || row.redactionReason != null ||
                    compareStorageCounters(row.lastModifiedAgentSeq, evidence) > 0
                ) storageMalformed()
                ValidatedAgentTranscriptEntry.Deleted.SnapshotAbsence(row, evidence)
            }
            else -> storageMalformed()
        }
        else -> storageMalformed()
    }

    val payload = RelayV2StorageJson.encode(
        ENTRY_PAYLOAD_CODEC_VERSION,
        linkedMapOf(
            "kind" to ENTRY_PAYLOAD_KIND,
            "profileId" to row.profileId,
            "profileActivationGeneration" to row.profileActivationGeneration.toString(),
            "principalId" to row.principalId,
            "clientInstanceId" to row.clientInstanceId,
            "hostId" to row.hostId,
            "hostEpoch" to row.hostEpoch,
            "scopeId" to row.scopeId,
            "sessionId" to row.sessionId,
            "timelineEpoch" to row.timelineEpoch,
            "entryId" to row.entryId,
            "runId" to row.runId,
            "turnId" to row.turnId,
            "role" to row.role,
            "commandId" to row.commandId,
            "createdAtMs" to row.createdAtMs.toString(),
            "createdAgentSeq" to row.createdAgentSeq,
            "lastModifiedAgentSeq" to row.lastModifiedAgentSeq,
            "entryState" to row.entryState,
            "text" to row.text,
            "redactionReason" to row.redactionReason,
            "tombstoneOrigin" to row.tombstoneOrigin,
            "tombstoneEvidenceThroughAgentSeq" to row.tombstoneEvidenceThroughAgentSeq,
        ),
    )
    if (row.payloadCanonicalJson != payload.canonicalJson ||
        row.payloadUtf8Bytes != payload.payloadUtf8Bytes ||
        row.payloadSha256 != payload.sha256
    ) storageMalformed()
    return validated
}

private fun AgentTranscriptLifecycleClientState.withoutRowOwnedMaterialization():
    AgentTranscriptLifecycleClientState = copy(
    extensionLane = extensionLane.copy(
        lifecycleByIdentity = emptyMap(),
        currentLifecycleIdentityByEventId = emptyMap(),
        runsWithTurnRecords = emptySet(),
        appliedEventsBySeq = emptyMap(),
        eventWitnessById = emptyMap(),
        eventIdBySeq = emptyMap(),
        notificationLedger = emptyMap(),
        notificationKeyByLifecycleEventId = emptyMap(),
    ),
)

private fun continuityQuarantine(
    state: AgentTranscriptLifecycleClientState,
): AgentTranscriptLifecycleClientReduction {
    val extension = state.extensionLane
    if (extension.support != AgentExtensionSupport.AVAILABLE || extension.timelineEpoch == null) {
        return AgentTranscriptLifecycleClientReduction(
            state,
            AgentClientDisposition.CONTINUITY_CONFLICT,
        )
    }
    val next = if (extension.syncState == AgentTimelineSyncState.Snapshot) {
        extension
    } else {
        val generation = (BigInteger(extension.localGeneration) + BigInteger.ONE)
        if (generation > UINT64_MAX_STORAGE) {
            return AgentTranscriptLifecycleClientReduction(
                state,
                AgentClientDisposition.CONTINUITY_CONFLICT,
            )
        }
        extension.copy(
            localGeneration = generation.toString(),
            syncState = AgentTimelineSyncState.Snapshot,
            pendingStatusRequest = null,
            pendingSnapshotRequest = null,
        )
    }
    return AgentTranscriptLifecycleClientReduction(
        state.copy(extensionLane = next),
        AgentClientDisposition.CONTINUITY_CONFLICT,
        syncDirective = AgentTimelineSyncDirective.Snapshot(
            AgentTimelineLineage(state.identity, extension.timelineEpoch),
        ),
    )
}

private fun PublicEventRecord.toDomainMutation(): AgentTimelineMutation = when (val value = mutation) {
    is PublicAppendMutation -> AgentTimelineMutation.Append(value.entry.toDomainVisibleEntry())
    is PublicRedactMutation -> AgentTimelineMutation.Redact(
        value.entryId,
        AgentTimelineRedactionReason.valueOf(value.reason.name),
    )
    is PublicDeleteMutation -> AgentTimelineMutation.Delete(
        value.entryId,
        AgentTimelineRedactionReason.valueOf(value.reason.name),
    )
    is AgentTimelineLifecycleChangedMutation -> AgentTimelineMutation.Lifecycle(
        value.lifecycle.toDomainLifecycleRecord(),
    )
    is PublicSourceAvailabilityMutation -> AgentTimelineMutation.SourceAvailability(
        AgentLiveSourceState.valueOf(value.state.name),
        value.sourceEpoch,
        value.reason?.let { AgentSourceAvailabilityReason.valueOf(it.name) },
    )
}

private fun AgentTimelineVisibleTextEntryRecord.toDomainVisibleEntry(): AgentTimelineVisibleEntry =
    AgentTimelineVisibleEntry(
        entryId = metadata.entryId,
        runId = metadata.runId,
        turnId = metadata.turnId,
        role = AgentTimelineEntryRole.valueOf(metadata.role.name),
        commandId = metadata.commandId,
        createdAtMs = metadata.createdAtMs,
        createdAgentSeq = metadata.createdAgentSeq,
        lastModifiedAgentSeq = metadata.lastModifiedAgentSeq,
        text = text,
    )

private fun AgentTimelineLifecycleRecord.toDomainLifecycleRecord(): AgentLifecycleRecord =
    AgentLifecycleRecord(
        lifecycleEventId = lifecycleEventId,
        sourceEpoch = sourceEpoch,
        identity = AgentLifecycleIdentity(
            AgentLifecycleScope.valueOf(scope.name),
            runId,
            turnId,
        ),
        state = AgentLifecycleState.valueOf(state.name),
        failure = failure?.let { AgentLifecycleFailure(it.code, it.summary) },
        occurredAtMs = occurredAtMs,
        agentEventSeq = agentEventSeq,
    )

private fun RelayV2AgentLifecycleEventWitnessEntity.toDomainRecord(): AgentLifecycleRecord =
    AgentLifecycleRecord(
        lifecycleEventId = eventId,
        sourceEpoch = sourceEpoch,
        identity = AgentLifecycleIdentity(
            lifecycleScope.toLifecycleScope(),
            runId,
            turnIdKey.takeIf(String::isNotEmpty),
        ),
        state = lifecycleState.toLifecycleState(),
        failure = failureCode?.let { AgentLifecycleFailure(it, failureSummary) },
        occurredAtMs = occurredAtMs,
        agentEventSeq = agentEventSeq,
    )

private fun RelayV2AgentLifecycleEventWitnessEntity.toDomainWitness():
    AgentLifecycleEventIdentityWitness = AgentLifecycleEventIdentityWitness(
    eventId = eventId,
    agentEventSeq = agentEventSeq,
    lifecycleIdentity = toDomainRecord().identity,
    sourceEpoch = sourceEpoch,
    state = lifecycleState.toLifecycleState(),
    failure = failureCode?.let { AgentLifecycleFailure(it, failureSummary) },
    occurredAtMs = occurredAtMs,
    closedEventDigest = closedEventDigest?.let(::AgentClosedEventDigest),
)

private fun AgentTimelineRedactionReason.storageValue(): String = when (this) {
    AgentTimelineRedactionReason.USER_REQUEST -> "user_request"
    AgentTimelineRedactionReason.POLICY -> "policy"
    AgentTimelineRedactionReason.RETENTION -> "retention"
}

private fun visibleEntryEntity(
    namespace: AgentTranscriptLifecycleDurableNamespace,
    entry: AgentTimelineVisibleEntry,
): RelayV2AgentTranscriptEntryEntity {
    val consumer = namespace.consumer
    return RelayV2AgentTranscriptEntryEntity(
        consumer.profileId, consumer.profileActivationGeneration, consumer.principalId,
        consumer.clientInstanceId, consumer.hostId, consumer.hostEpoch, consumer.scopeId,
        consumer.sessionId, namespace.timelineEpoch ?: storageMalformed(), entry.entryId,
        entry.runId, entry.turnId, entry.role.name.lowercase(), entry.commandId,
        entry.createdAtMs, entry.createdAgentSeq, storageOrderKey(entry.createdAgentSeq),
        entry.lastModifiedAgentSeq, storageOrderKey(entry.lastModifiedAgentSeq),
        ENTRY_STATE_VISIBLE, entry.text, null, null, null, null, "", 0, "",
    ).withCanonicalEntryPayload()
}

private fun RelayV2AgentTranscriptEntryEntity.withEntryPayload(
    lastModifiedAgentSeq: String,
    entryState: String,
    text: String?,
    redactionReason: String?,
    tombstoneOrigin: String?,
    evidenceThrough: String?,
): RelayV2AgentTranscriptEntryEntity = copy(
    lastModifiedAgentSeq = lastModifiedAgentSeq,
    lastModifiedAgentSeqOrder = storageOrderKey(lastModifiedAgentSeq),
    entryState = entryState,
    text = text,
    redactionReason = redactionReason,
    tombstoneOrigin = tombstoneOrigin,
    tombstoneEvidenceThroughAgentSeq = evidenceThrough,
    tombstoneEvidenceThroughAgentSeqOrder = evidenceThrough?.let(::storageOrderKey),
).withCanonicalEntryPayload()

private fun RelayV2AgentTranscriptEntryEntity.withCanonicalEntryPayload():
    RelayV2AgentTranscriptEntryEntity {
    val payload = canonicalEntryPayload(this)
    return copy(
        payloadCanonicalJson = payload.canonicalJson,
        payloadUtf8Bytes = payload.payloadUtf8Bytes,
        payloadSha256 = payload.sha256,
    )
}

private fun canonicalEntryPayload(row: RelayV2AgentTranscriptEntryEntity): RelayV2EncodedPayload =
    RelayV2StorageJson.encode(
        ENTRY_PAYLOAD_CODEC_VERSION,
        linkedMapOf(
            "kind" to ENTRY_PAYLOAD_KIND,
            "profileId" to row.profileId,
            "profileActivationGeneration" to row.profileActivationGeneration.toString(),
            "principalId" to row.principalId,
            "clientInstanceId" to row.clientInstanceId,
            "hostId" to row.hostId,
            "hostEpoch" to row.hostEpoch,
            "scopeId" to row.scopeId,
            "sessionId" to row.sessionId,
            "timelineEpoch" to row.timelineEpoch,
            "entryId" to row.entryId,
            "runId" to row.runId,
            "turnId" to row.turnId,
            "role" to row.role,
            "commandId" to row.commandId,
            "createdAtMs" to row.createdAtMs.toString(),
            "createdAgentSeq" to row.createdAgentSeq,
            "lastModifiedAgentSeq" to row.lastModifiedAgentSeq,
            "entryState" to row.entryState,
            "text" to row.text,
            "redactionReason" to row.redactionReason,
            "tombstoneOrigin" to row.tombstoneOrigin,
            "tombstoneEvidenceThroughAgentSeq" to row.tombstoneEvidenceThroughAgentSeq,
        ),
    )

private fun AgentTranscriptDurableStorageAccounting.afterEntryInsert(
    row: RelayV2AgentTranscriptEntryEntity,
): AgentTranscriptDurableStorageAccounting = copy(
    entryCount = Math.addExact(entryCount, 1),
    entryCanonicalBytes = Math.addExact(
        entryCanonicalBytes,
        row.payloadUtf8Bytes.toLong() + if (entryCount == 0L) 0L else 1L,
    ),
    entryTextUtf8Bytes = Math.addExact(
        entryTextUtf8Bytes,
        row.text?.let(::strictStorageUtf8)?.size?.toLong() ?: 0L,
    ),
)

private fun AgentTranscriptDurableStorageAccounting.afterEntryUpdate(
    old: RelayV2AgentTranscriptEntryEntity,
    next: RelayV2AgentTranscriptEntryEntity,
): AgentTranscriptDurableStorageAccounting = copy(
    entryCanonicalBytes = Math.addExact(
        Math.subtractExact(entryCanonicalBytes, old.payloadUtf8Bytes.toLong()),
        next.payloadUtf8Bytes.toLong(),
    ),
    entryTextUtf8Bytes = Math.addExact(
        Math.subtractExact(
            entryTextUtf8Bytes,
            old.text?.let(::strictStorageUtf8)?.size?.toLong() ?: 0L,
        ),
        next.text?.let(::strictStorageUtf8)?.size?.toLong() ?: 0L,
    ),
)

private fun AgentTranscriptLifecycleDurableRepositoryCore.ClosedDurableEvent.toPendingEntity(
    namespace: AgentTranscriptLifecycleDurableNamespace,
    rawArtifactUtf8Bytes: Int,
): RelayV2AgentTranscriptPendingEventEntity {
    val consumer = namespace.consumer
    return RelayV2AgentTranscriptPendingEventEntity(
        consumer.profileId, consumer.profileActivationGeneration, consumer.principalId,
        consumer.clientInstanceId, consumer.hostId, consumer.hostEpoch, consumer.scopeId,
        consumer.sessionId, namespace.timelineEpoch ?: storageMalformed(),
        publicRecord.agentEventSeq, storageOrderKey(publicRecord.agentEventSeq),
        publicRecord.eventId, digest.value, TRUSTED_LIVE_PROVENANCE, canonicalJson,
        rawArtifactUtf8Bytes,
    )
}

private fun AgentTranscriptLifecycleDurableRepositoryCore.ClosedDurableEvent
    .toRecentEvidenceEntity(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): RelayV2AgentRecentEventEvidenceEntity {
    val consumer = namespace.consumer
    return RelayV2AgentRecentEventEvidenceEntity(
        consumer.profileId, consumer.profileActivationGeneration, consumer.principalId,
        consumer.clientInstanceId, consumer.hostId, consumer.hostEpoch, consumer.scopeId,
        consumer.sessionId, namespace.timelineEpoch ?: storageMalformed(),
        publicRecord.agentEventSeq, storageOrderKey(publicRecord.agentEventSeq),
        publicRecord.eventId, digest.value, canonicalJson, canonical.size,
        sha256Hex(canonical),
    )
}

private fun AgentTimelineLifecycleRecord.toWitnessEntity(
    namespace: AgentTranscriptLifecycleDurableNamespace,
    digest: AgentClosedEventDigest?,
    codec: AgentTranscriptLifecycleV1Codec,
): RelayV2AgentLifecycleEventWitnessEntity {
    val consumer = namespace.consumer
    val canonical = codec.encodeCanonicalPublicSnapshotRecord(this)
    return RelayV2AgentLifecycleEventWitnessEntity(
        consumer.profileId, consumer.profileActivationGeneration, consumer.principalId,
        consumer.clientInstanceId, consumer.hostId, consumer.hostEpoch, consumer.scopeId,
        consumer.sessionId, namespace.timelineEpoch ?: storageMalformed(), lifecycleEventId,
        agentEventSeq, storageOrderKey(agentEventSeq), scope.name, runId, turnId ?: "",
        sourceEpoch, state.name, failure?.code, failure?.summary, occurredAtMs,
        digest?.value, strictStorageUtf8String(canonical), canonical.size, sha256Hex(canonical),
    )
}

private fun RelayV2AgentLifecycleEventWitnessEntity.toCurrentEntity():
    RelayV2AgentLifecycleCurrentEntity = RelayV2AgentLifecycleCurrentEntity(
    profileId, profileActivationGeneration, principalId, clientInstanceId, hostId, hostEpoch,
    scopeId, sessionId, timelineEpoch, lifecycleScope, runId, turnIdKey, eventId,
    agentEventSeq, agentEventSeqOrder,
)

private fun AgentNotificationDecision.toLedgerEntity(
    namespace: AgentTranscriptLifecycleDurableNamespace,
): RelayV2AgentNotificationLedgerEntity {
    val consumer = namespace.consumer
    val witness = ledgerEntry.eventIdentity
    val payload = canonicalNotificationPayload(
        ledgerEntry.disposition.name,
        ledgerEntry.localGeneration,
    )
    return RelayV2AgentNotificationLedgerEntity(
        consumer.profileId, consumer.profileActivationGeneration, consumer.principalId,
        consumer.clientInstanceId, consumer.hostId, consumer.hostEpoch, consumer.scopeId,
        consumer.sessionId, namespace.timelineEpoch ?: storageMalformed(),
        witness.eventId, witness.state.name, witness.agentEventSeq,
        storageOrderKey(witness.agentEventSeq), ledgerEntry.disposition.name,
        ledgerEntry.localGeneration, payload.canonicalJson, payload.payloadUtf8Bytes,
        payload.sha256,
    )
}

private fun strictStorageUtf8String(bytes: ByteArray): String = try {
    StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(java.nio.ByteBuffer.wrap(bytes))
        .toString()
} catch (_: java.nio.charset.CharacterCodingException) {
    storageMalformed()
}

private fun storageOrderKey(counter: String): String {
    requireCanonicalStorageCounter(counter)
    return counter.padStart(20, '0')
}

private fun requireExactLifecycleNamespace(
    namespace: AgentTranscriptLifecycleDurableNamespace,
    row: RelayV2AgentLifecycleCurrentEntity,
) = requireExactTranscriptNamespace(
    namespace, row.profileId, row.profileActivationGeneration, row.principalId,
    row.clientInstanceId, row.hostId, row.hostEpoch, row.scopeId, row.sessionId,
    row.timelineEpoch,
)

private fun requireExactLifecycleNamespace(
    namespace: AgentTranscriptLifecycleDurableNamespace,
    row: RelayV2AgentLifecycleEventWitnessEntity,
) = requireExactTranscriptNamespace(
    namespace, row.profileId, row.profileActivationGeneration, row.principalId,
    row.clientInstanceId, row.hostId, row.hostEpoch, row.scopeId, row.sessionId,
    row.timelineEpoch,
)

private fun requireExactLifecycleNamespace(
    namespace: AgentTranscriptLifecycleDurableNamespace,
    row: RelayV2AgentRecentEventEvidenceEntity,
) = requireExactTranscriptNamespace(
    namespace, row.profileId, row.profileActivationGeneration, row.principalId,
    row.clientInstanceId, row.hostId, row.hostEpoch, row.scopeId, row.sessionId,
    row.timelineEpoch,
)

private fun requireExactLifecycleNamespace(
    namespace: AgentTranscriptLifecycleDurableNamespace,
    row: RelayV2AgentNotificationLedgerEntity,
) = requireExactTranscriptNamespace(
    namespace, row.profileId, row.profileActivationGeneration, row.principalId,
    row.clientInstanceId, row.hostId, row.hostEpoch, row.scopeId, row.sessionId,
    row.timelineEpoch,
)

private fun RelayV2AgentLifecycleCurrentEntity.toLifecycleIdentity(): AgentLifecycleIdentity =
    AgentLifecycleIdentity(
        scope = lifecycleScope.toLifecycleScope(),
        runId = runId,
        turnId = turnIdKey.takeIf(String::isNotEmpty),
    )

private fun RelayV2AgentLifecycleEventWitnessEntity.lifecycleIdentityKey(): Triple<String, String, String> =
    Triple(lifecycleScope, runId, turnIdKey)

private fun RelayV2AgentLifecycleCurrentEntity.pointsExactlyTo(
    witness: RelayV2AgentLifecycleEventWitnessEntity,
): Boolean = lifecycleEventId == witness.eventId &&
    agentEventSeq == witness.agentEventSeq &&
    agentEventSeqOrder == witness.agentEventSeqOrder &&
    lifecycleScope == witness.lifecycleScope && runId == witness.runId &&
    turnIdKey == witness.turnIdKey

private fun RelayV2AgentNotificationLedgerEntity.pointsExactlyTo(
    witness: RelayV2AgentLifecycleEventWitnessEntity,
): Boolean = lifecycleEventId == witness.eventId &&
    agentEventSeq == witness.agentEventSeq &&
    agentEventSeqOrder == witness.agentEventSeqOrder &&
    lifecycleState == witness.lifecycleState

private fun String.toLifecycleScope(): AgentLifecycleScope = try {
    AgentLifecycleScope.valueOf(this)
} catch (_: IllegalArgumentException) {
    storageMalformed()
}

private fun String.toLifecycleState(): AgentLifecycleState = try {
    AgentLifecycleState.valueOf(this)
} catch (_: IllegalArgumentException) {
    storageMalformed()
}

private fun canonicalNotificationPayload(
    disposition: String,
    localGeneration: String,
): RelayV2EncodedPayload {
    try {
        AgentNotificationDisposition.valueOf(disposition)
    } catch (_: IllegalArgumentException) {
        storageMalformed()
    }
    requireCanonicalStorageCounter(localGeneration)
    return RelayV2StorageJson.encode(
        1,
        linkedMapOf(
            "disposition" to disposition,
            "localGeneration" to localGeneration,
        ),
    )
}

private fun decodeStorageRedactionReason(value: String?): AgentTimelineRedactionReason =
    when (value) {
        "user_request" -> AgentTimelineRedactionReason.USER_REQUEST
        "policy" -> AgentTimelineRedactionReason.POLICY
        "retention" -> AgentTimelineRedactionReason.RETENTION
        else -> storageMalformed()
    }

private fun requireExactTranscriptNamespace(
    namespace: AgentTranscriptLifecycleDurableNamespace,
    profileId: String,
    profileActivationGeneration: Long,
    principalId: String,
    clientInstanceId: String,
    hostId: String,
    hostEpoch: String,
    scopeId: String,
    sessionId: String,
    timelineEpoch: String,
) {
    val consumer = namespace.consumer
    if (profileId != consumer.profileId ||
        profileActivationGeneration != consumer.profileActivationGeneration ||
        principalId != consumer.principalId ||
        clientInstanceId != consumer.clientInstanceId ||
        hostId != consumer.hostId ||
        hostEpoch != consumer.hostEpoch ||
        scopeId != consumer.scopeId ||
        sessionId != consumer.sessionId ||
        timelineEpoch != namespace.timelineEpoch
    ) storageMalformed()
}

private fun requireCanonicalStorageCounter(value: String, positive: Boolean = false) {
    if (!STORAGE_CANONICAL_COUNTER.matches(value)) storageMalformed()
    val decoded = try {
        BigInteger(value)
    } catch (_: NumberFormatException) {
        storageMalformed()
    }
    if (decoded > STORAGE_UINT64_MAX || positive && decoded == BigInteger.ZERO) storageMalformed()
}

private fun requireExactOrderKey(value: String, orderKey: String) {
    requireCanonicalStorageCounter(value)
    if (orderKey.length != STORAGE_ORDER_KEY_LENGTH ||
        orderKey != value.padStart(STORAGE_ORDER_KEY_LENGTH, '0')
    ) storageMalformed()
}

private fun compareStorageCounters(left: String, right: String): Int =
    try {
        BigInteger(left).compareTo(BigInteger(right))
    } catch (_: NumberFormatException) {
        storageMalformed()
    }

private fun storageOpaque(value: String?) {
    try {
        requireStorageOpaqueIdentity(value, "Persisted opaque identity")
    } catch (_: IllegalArgumentException) {
        storageMalformed()
    }
}

private fun storageCursor(value: String) {
    if (!isValidAgentTimelineCursor(value)) storageMalformed()
}

private fun strictStorageUtf8(value: String): ByteArray = try {
    val encoded = StandardCharsets.UTF_8.newEncoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .encode(java.nio.CharBuffer.wrap(value))
    ByteArray(encoded.remaining()).also(encoded::get)
} catch (_: java.nio.charset.CharacterCodingException) {
    storageMalformed()
}

private fun sha256Hex(value: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(value)
    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

private fun digestBase64Url(value: ByteArray): String = Base64.getUrlEncoder()
    .withoutPadding()
    .encodeToString(MessageDigest.getInstance("SHA-256").digest(value))

private fun addBounded(current: Long, addition: Long, maximum: Long): Long {
    if (maximum < 0 ||
        current !in 0..maximum ||
        addition !in 0..maximum ||
        current > maximum - addition
    ) storageMalformed()
    return current + addition
}

private fun maximumSnapshotPages(receivedRecordCount: Long, complete: Boolean): Long {
    if (receivedRecordCount !in 0..MAX_TRANSCRIPT_SNAPSHOT_CUT_RECORDS) {
        storageMalformed()
    }
    if (receivedRecordCount == 0L) return 1L
    return receivedRecordCount + if (complete) 1L else 0L
}

private fun maximumSnapshotRawBytes(receivedPageCount: Long): Long {
    if (receivedPageCount !in
        1..MAX_TRANSCRIPT_SNAPSHOT_CUT_RECORDS + 1L
    ) storageMalformed()
    return minOf(
        RelayV2StateLimits.MAX_STAGED_RAW_UTF8_BYTES,
        receivedPageCount * RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES.toLong(),
    )
}

private fun storageMalformed(): Nothing =
    throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)

private sealed interface NotificationClaimTransactionResult {
    data class Committed(
        val key: AgentTranscriptLifecycleNotificationClaimKey,
        val intent: AgentSystemNotificationIntent,
        val claimId: String,
    ) : NotificationClaimTransactionResult

    data class NotExecutable(
        val reason: AgentTranscriptLifecycleNotificationNotExecutableReason,
    ) : NotificationClaimTransactionResult
}

private const val MAX_STORAGE_OPAQUE_ID_UTF8_BYTES = 128
private val UINT64_MAX_STORAGE = BigInteger("18446744073709551615")
/** Node authority composite: 50k active text rows plus 100k retained delete tombstones. */
private const val MAX_MATERIALIZED_TRANSCRIPT_ROWS = 150_000L
/** One pinned cut may contain 50k runs, 100k turns, and 50k active text entries. */
private const val MAX_TRANSCRIPT_SNAPSHOT_CUT_RECORDS = 200_000L
private const val MAX_STORAGE_WIRE_INTEGER = 9_007_199_254_740_991L
private const val DURABLE_STORAGE_BATCH_RECORDS =
    RelayV2StateLimits.MAX_SNAPSHOT_CHUNK_RECORDS
private const val STORAGE_ORDER_KEY_LENGTH = 20
private const val ENTRY_PAYLOAD_CODEC_VERSION = 1
private const val ENTRY_PAYLOAD_KIND = "android_agent_transcript_entry_v1"
private const val ENTRY_ROLE_AGENT = "agent"
private const val ENTRY_STATE_VISIBLE = "visible"
private const val ENTRY_STATE_REDACTED = "redacted"
private const val ENTRY_STATE_DELETED = "deleted"
private const val SNAPSHOT_RECORD_KIND_TEXT = "text_entry"
private const val SNAPSHOT_RECORD_KIND_LIFECYCLE = "lifecycle"
private const val TRUSTED_LIVE_PROVENANCE = "LIVE"
private val ENTRY_ROLES = setOf("user", ENTRY_ROLE_AGENT)
private val ENTRY_STATES = setOf(
    ENTRY_STATE_VISIBLE,
    ENTRY_STATE_REDACTED,
    ENTRY_STATE_DELETED,
)
private val SNAPSHOT_RECORD_KINDS = setOf(
    SNAPSHOT_RECORD_KIND_TEXT,
    SNAPSHOT_RECORD_KIND_LIFECYCLE,
)
private val STORAGE_UINT64_MAX = BigInteger("18446744073709551615")
private val STORAGE_CANONICAL_COUNTER = Regex("^(?:0|[1-9][0-9]*)$")

/** Storage-boundary copy of the frozen opaque-ID constraints; it does not widen reducer APIs. */
private fun requireStorageOpaqueIdentity(value: String?, label: String) {
    require(!value.isNullOrBlank()) { "$label is required" }
    require(value == value.trim()) { "$label cannot contain outer whitespace" }
    require(!value.contains('\u0000')) { "$label contains NUL" }
    val encoder = StandardCharsets.UTF_8.newEncoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
    require(encoder.canEncode(value)) { "$label is not well-formed Unicode" }
    require(value.toByteArray(StandardCharsets.UTF_8).size <= MAX_STORAGE_OPAQUE_ID_UTF8_BYTES) {
        "$label exceeds $MAX_STORAGE_OPAQUE_ID_UTF8_BYTES UTF-8 bytes"
    }
}
