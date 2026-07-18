package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineLifecycleRecord
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
) {
    init {
        require(entryCount in 0..RelayV2StateLimits.MAX_SNAPSHOT_RECORDS.toLong())
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
    }

    companion object {
        val EMPTY = AgentTranscriptDurableStorageAccounting(
            entryCount = 0,
            entryCanonicalBytes = 2,
            entryTextUtf8Bytes = 0,
            pendingLiveEventCount = 0,
            pendingLiveEventCanonicalBytes = 0,
            pendingLiveEventRawUtf8Bytes = 0,
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

    fun deleteState(namespace: AgentTranscriptLifecycleDurableNamespace): Int

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
    fun deletePendingEvent(event: RelayV2AgentTranscriptPendingEventEntity): Int
    fun deletePendingEvents(namespace: AgentTranscriptLifecycleDurableNamespace): Int

    fun notificationClaims(
        eventIdentity: AgentTranscriptLifecycleNotificationClaimEventIdentity,
    ): List<AgentTranscriptLifecyclePersistedNotificationClaim>

    /** Must use INSERT ABORT or an equivalent no-overwrite compare-and-set. */
    fun insertNotificationClaim(claim: AgentTranscriptLifecyclePersistedNotificationClaim)
}

/** Legacy WIP reducer seam retained until the closed operation port has a real Room owner. */
internal interface AgentTranscriptLifecycleDurableReductionPort {
    suspend fun reduceUnderApplyLease(
        expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
        input: AgentTranscriptLifecycleClientInput,
        limits: AgentClientReducerLimits = AgentClientReducerLimits(),
    ): AgentTranscriptLifecycleClientReduction
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
) : AgentTranscriptLifecycleDurableReductionPort {
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
        val emptyStats = transcriptNamespaceStats(namespace)
        validateTranscriptNamespaceStats(emptyStats)
        if (emptyStats.entryCount != 0L || emptyStats.snapshotCount != 0L ||
            emptyStats.snapshotRecordCount != 0L || emptyStats.pendingEventCount != 0L
        ) storageMalformed()
        if (state.extensionLane.durableStorageAccounting !=
            AgentTranscriptDurableStorageAccounting.EMPTY
        ) storageMalformed()
        val persisted = AgentTranscriptLifecyclePersistedState(
            namespace,
            AgentTranscriptLifecycleDurableStateCodec.encode(namespace, state),
        )
        insertState(persisted)
        AgentTranscriptLifecycleInitializeResult(
            AgentTranscriptLifecycleDurableRecord(namespace, state),
            AgentTranscriptLifecycleInitializeDisposition.CREATED,
        )
    }

    override suspend fun reduceUnderApplyLease(
        expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
        input: AgentTranscriptLifecycleClientInput,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleClientReduction = store.transaction {
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
        if (current.state.extensionLane.durableStorageAccounting == null) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        if (input is AgentTranscriptLifecycleClientInput.SnapshotCommit) {
            validateTranscriptStorage(current.namespace, current.state)
        }

        val reduction = AgentTranscriptLifecycleClientReducer.reduce(current.state, input, limits)
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
            AgentTranscriptLifecycleDurableStateCodec.encode(nextNamespace, reduction.state),
        )
        // The state row is singularly replaced under its exact nine-column namespace.
        if (deleteState(current.namespace) != 1) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        insertState(replacement)
        reduction
    }

    private fun AgentTranscriptLifecycleDurableTransaction.loadAuditedSingle(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): AgentTranscriptLifecycleDurableRecord? {
        val current = loadSingle(consumer) ?: return null
        val audited = validateTranscriptStorage(current.namespace, current.state)
        val storedAccounting = current.state.extensionLane.durableStorageAccounting
        if (storedAccounting != null && storedAccounting != audited.accounting) {
            storageMalformed()
        }
        if (storedAccounting != null) return current

        val migratedState = current.state.copy(
            extensionLane = current.state.extensionLane.copy(
                durableStorageAccounting = audited.accounting,
            ),
        )
        val replacement = AgentTranscriptLifecyclePersistedState(
            current.namespace,
            AgentTranscriptLifecycleDurableStateCodec.encode(current.namespace, migratedState),
        )
        if (deleteState(current.namespace) != 1) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        insertState(replacement)
        return AgentTranscriptLifecycleDurableRecord(current.namespace, migratedState)
    }

    private fun AgentTranscriptLifecycleDurableTransaction.validateTranscriptStorage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        state: AgentTranscriptLifecycleClientState,
    ): ValidatedAgentTranscriptStorage {
        val stats = transcriptNamespaceStats(namespace)
        validateTranscriptNamespaceStats(stats)
        if (namespace.timelineEpoch == null) {
            if (stats.entryCount != 0L || stats.snapshotCount != 0L ||
                stats.snapshotRecordCount != 0L || stats.pendingEventCount != 0L
            ) storageMalformed()
            return ValidatedAgentTranscriptStorage(
                snapshot = null,
                pendingEvents = emptyList(),
                accounting = AgentTranscriptDurableStorageAccounting.EMPTY,
            )
        }

        validateEntryBatches(namespace, stats)

        val snapshotRows = snapshots(namespace)
        if (snapshotRows.size.toLong() != stats.snapshotCount) storageMalformed()
        val snapshot = snapshotRows.singleOrNull()
        if (snapshot != null) {
            validateSnapshotHeader(namespace, state, snapshot)
            validateSnapshotRecordBatches(namespace, snapshot, stats)
        } else if (stats.snapshotRecordCount != 0L) {
            storageMalformed()
        }

        val pendingRows = pendingEvents(namespace)
        if (pendingRows.size.toLong() != stats.pendingEventCount) storageMalformed()
        validatePendingEvents(namespace, state, pendingRows, stats)

        return ValidatedAgentTranscriptStorage(
            snapshot = snapshot,
            pendingEvents = pendingRows,
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
            ),
        )
    }

    private fun validateTranscriptNamespaceStats(
        stats: RelayV2AgentTranscriptNamespaceStats,
    ) {
        if (stats.entryCount !in 0..RelayV2StateLimits.MAX_SNAPSHOT_RECORDS.toLong() ||
            stats.entryPayloadUtf8Bytes !in
            0..RelayV2StateLimits.MAX_SNAPSHOT_CANONICAL_BYTES ||
            stats.entryTextUtf8Bytes !in 0..stats.entryPayloadUtf8Bytes ||
            stats.entryMaxBoundedTextUtf8Bytes !in 0..MAX_STORAGE_OPAQUE_ID_UTF8_BYTES ||
            stats.snapshotCount !in 0..1 ||
            stats.snapshotMaxIdUtf8Bytes !in 0..MAX_STORAGE_OPAQUE_ID_UTF8_BYTES ||
            stats.snapshotMaxCursorUtf8Bytes !in
            0..RelayV2StateLimits.MAX_CURSOR_UTF8_BYTES ||
            stats.snapshotRecordCount !in
            0..RelayV2StateLimits.MAX_SNAPSHOT_RECORDS.toLong() ||
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
                validateEntry(namespace, row)
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
            row.receivedRecordCount !in 0..RelayV2StateLimits.MAX_SNAPSHOT_RECORDS.toLong() ||
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
            val record = publicCodec.decodeCanonicalSnapshotRecord(bytes)
            if (!MessageDigest.isEqual(publicCodec.encodeCanonicalSnapshotRecord(record), bytes)) {
                storageMalformed()
            }
            record
        } catch (_: IllegalArgumentException) {
            storageMalformed()
        }

    private fun validatePendingEvents(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        state: AgentTranscriptLifecycleClientState,
        rows: List<RelayV2AgentTranscriptPendingEventEntity>,
        stats: RelayV2AgentTranscriptNamespaceStats,
    ) {
        if (rows.isNotEmpty() && state.extensionLane.syncState == AgentTimelineSyncState.Current) {
            storageMalformed()
        }
        val eventIds = linkedSetOf<String>()
        var previous: RelayV2AgentTranscriptPendingEventEntity? = null
        var canonicalBytes = 0L
        var rawBytes = 0L
        rows.forEach { row ->
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
            if (!eventIds.add(row.eventId) ||
                row.trustedProvenance != TRUSTED_LIVE_PROVENANCE ||
                compareStorageCounters(row.agentEventSeq, state.extensionLane.lastAgentSeq) <= 0
            ) storageMalformed()
            val canonical = strictStorageUtf8(row.eventCanonicalJson)
            if (canonical.isEmpty() || canonical.size > AgentTranscriptLifecycleV1Codec.MAX_PUBLIC_FRAME_BYTES ||
                row.eventRawUtf8Bytes !in canonical.size..AgentTranscriptLifecycleV1Codec.MAX_PUBLIC_FRAME_BYTES
            ) storageMalformed()
            val event = try {
                publicCodec.decodeCanonicalEventRecord(canonical)
            } catch (_: IllegalArgumentException) {
                storageMalformed()
            }
            val recanonical = publicCodec.encodeCanonicalEventRecord(event)
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
        if (canonicalBytes != stats.pendingEventPayloadUtf8Bytes ||
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
    ): AgentTranscriptLifecycleDurableRecord? {
        val count = stateCount(consumer)
        val rows = states(consumer)
        if (count != rows.size.toLong() || count > 1L) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        val row = rows.singleOrNull() ?: return null
        if (row.namespace.consumer != consumer) {
            throw AgentTranscriptLifecyclePersistenceConflictException()
        }
        val state = AgentTranscriptLifecycleDurableStateCodec.decode(row.namespace, row.payload)
        requireNamespaceState(row.namespace, state)
        return AgentTranscriptLifecycleDurableRecord(row.namespace, state)
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
    if (receivedRecordCount !in 0..RelayV2StateLimits.MAX_SNAPSHOT_RECORDS.toLong()) {
        storageMalformed()
    }
    if (receivedRecordCount == 0L) return 1L
    return receivedRecordCount + if (complete) 1L else 0L
}

private fun maximumSnapshotRawBytes(receivedPageCount: Long): Long {
    if (receivedPageCount !in
        1..RelayV2StateLimits.MAX_SNAPSHOT_RECORDS.toLong() + 1L
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
