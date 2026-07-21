package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import androidx.room.withTransaction
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptEntryBatchMetadata
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptEntryEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptConsumerStats
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptLifecycleNotificationClaimEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptLifecycleStateEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptNamespaceStats
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptPendingEventEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptPendingEventBatchMetadata
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptSnapshotRecordEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptSnapshotRecordBatchMetadata
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptSnapshotStagingEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentLifecycleDao
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentLifecycleCurrentEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentLifecycleEventWitnessEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentNotificationLedgerEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentRecentEventEvidenceEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2EncodedPayload
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectApplyResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectApplyLeasePort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageException
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageFailure
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateDao
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateDatabase
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateLimits
import kotlinx.coroutines.CancellationException

/** Room adapter for the Agent transcript/lifecycle durable consumer. */
internal class AgentTranscriptLifecycleDurableRepository(
    database: RelayV2StateDatabase,
) : AgentTranscriptLifecycleRuntimeDurableRepository,
    AgentTranscriptLifecycleRecoveryCatalogPort {
    private val core = AgentTranscriptLifecycleDurableRepositoryCore(
        RoomAgentTranscriptLifecycleDurableStore(database),
    )

    override suspend fun load(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): AgentTranscriptLifecycleDurableRecord? = core.load(consumer)

    override suspend fun readRecoveryNamespacePage(
        authority: AgentTranscriptLifecycleRecoveryCatalogAuthority,
        cursor: AgentTranscriptLifecycleRecoveryCatalogCursor?,
        limit: Int,
    ): AgentTranscriptLifecycleRecoveryNamespacePage =
        core.readRecoveryNamespacePage(authority, cursor, limit)

    override suspend fun readRevisionPinnedPage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        cursor: AgentTranscriptLifecycleReadCursor?,
        limit: Int,
    ): AgentTranscriptLifecycleRevisionPinnedReadResult =
        core.readRevisionPinnedPage(namespace, cursor, limit)

    suspend fun initializeUnderApplyLease(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        state: AgentTranscriptLifecycleClientState,
    ): AgentTranscriptLifecycleInitializeResult =
        core.initializeUnderApplyLease(namespace, state)

    override suspend fun loadOrInitializeStatusNamespaceUnderApplyLease(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): AgentTranscriptLifecycleDurableRecord =
        core.loadOrInitializeStatusNamespaceUnderApplyLease(namespace)

    override suspend fun claimNotificationUnderApplyLease(
        expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
        intent: AgentSystemNotificationIntent,
    ): AgentTranscriptLifecycleNotificationClaimResult =
        core.claimNotificationUnderApplyLease(expectedNamespace, intent)

    /** Closed operation seam; each call is executed by the core in one Room transaction. */
    override suspend fun prepareRequestUnderApplyLease(
        command: AgentTranscriptLifecycleDurablePrepareRequestCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurablePrepareRequestResult =
        core.prepareRequestUnderApplyLease(command, limits)

    override suspend fun loadPreparedRequestsUnderApplyLease(
        fence: AgentTranscriptLifecycleDurableOperationFence,
    ): List<AgentTranscriptLifecycleDurablePreparedRequest> =
        core.loadPreparedRequestsUnderApplyLease(fence)

    override suspend fun applyControlUnderApplyLease(
        command: AgentTranscriptLifecycleDurableControlCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult =
        core.applyControlUnderApplyLease(command, limits)

    override suspend fun consumeLiveEventUnderApplyLease(
        command: AgentTranscriptLifecycleDurableLiveEventCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult =
        core.consumeLiveEventUnderApplyLease(command, limits)

    override suspend fun consumeCorrelatedErrorUnderApplyLease(
        command: AgentTranscriptLifecycleDurableCorrelatedErrorCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult =
        core.consumeCorrelatedErrorUnderApplyLease(command, limits)

    override suspend fun consumeReplayPageUnderApplyLease(
        command: AgentTranscriptLifecycleDurableReplayPageCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult =
        core.consumeReplayPageUnderApplyLease(command, limits)

    override suspend fun persistSnapshotRequestUnderApplyLease(
        command: AgentTranscriptLifecycleDurableSnapshotRequestCommand,
    ): AgentTranscriptLifecycleDurableOperationResult =
        core.persistSnapshotRequestUnderApplyLease(command)

    override suspend fun consumeSnapshotPageUnderApplyLease(
        command: AgentTranscriptLifecycleDurableSnapshotPageCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult =
        core.consumeSnapshotPageUnderApplyLease(command, limits)
}

/**
 * Default-off actor-fenced bridge for selected-Session status admission.
 *
 * The actor owns generation/disconnect fencing through [applyLease]. The injected operation is the
 * existing durable repository/core transaction and remains the only owner of persisted state.
 */
internal class AgentTranscriptLifecycleDurableLoadOrInitializeAdapter(
    private val applyLease: RelayV2RepositoryEffectApplyLeasePort,
    private val loadOrInitializeUnderApplyLease:
        suspend (AgentTranscriptLifecycleDurableNamespace) ->
            AgentTranscriptLifecycleDurableRecord,
) : AgentTranscriptLifecycleDurableLoadOrInitializePort {
    constructor(
        applyLease: RelayV2RepositoryEffectApplyLeasePort,
        repository: AgentTranscriptLifecycleRuntimeDurableRepository,
    ) : this(applyLease, repository::loadOrInitializeStatusNamespaceUnderApplyLease)

    override suspend fun loadOrInitialize(
        authority: RelayV2RepositoryEffectAuthority,
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): AgentTranscriptLifecycleDurableLoadOrInitializeResult {
        if (!authority.matchesExactly(namespace.consumer)) {
            return AgentTranscriptLifecycleDurableLoadOrInitializeResult.Unavailable
        }
        return try {
            when (
                applyLease.withEffectApplyLease(authority) {
                    loadOrInitializeUnderApplyLease(namespace)
                }
            ) {
                is RelayV2EffectApplyResult.Applied ->
                    AgentTranscriptLifecycleDurableLoadOrInitializeResult.Ready
                RelayV2EffectApplyResult.Stale ->
                    AgentTranscriptLifecycleDurableLoadOrInitializeResult.Unavailable
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: AgentTranscriptLifecyclePersistenceConflictException) {
            AgentTranscriptLifecycleDurableLoadOrInitializeResult.Unavailable
        } catch (_: RelayV2StorageException) {
            AgentTranscriptLifecycleDurableLoadOrInitializeResult.Unavailable
        }
    }
}

private fun RelayV2RepositoryEffectAuthority.matchesExactly(
    consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
): Boolean = generation.profileId == consumer.profileId &&
    generation.profileGeneration == consumer.profileActivationGeneration &&
    profileId == consumer.profileId &&
    profileActivationGeneration == consumer.profileActivationGeneration &&
    principalId == consumer.principalId &&
    clientInstanceId == consumer.clientInstanceId &&
    hostId == consumer.hostId &&
    hostEpoch == consumer.hostEpoch

private class RoomAgentTranscriptLifecycleDurableStore(
    private val database: RelayV2StateDatabase,
) : AgentTranscriptLifecycleDurableStore {
    private val dao = database.stateDao()
    private val lifecycleDao = database.agentLifecycleDao()

    override suspend fun <T> transaction(
        block: AgentTranscriptLifecycleDurableTransaction.() -> T,
    ): T = database.withTransaction {
        RoomAgentTranscriptLifecycleDurableTransaction(dao, lifecycleDao).block()
    }
}

private class RoomAgentTranscriptLifecycleDurableTransaction(
    private val dao: RelayV2StateDao,
    private val lifecycleDao: RelayV2AgentLifecycleDao,
) : AgentTranscriptLifecycleDurableTransaction {
    override fun stateCount(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): Long = dao.agentTranscriptLifecycleStateCount(
        consumer.profileId,
        consumer.profileActivationGeneration,
        consumer.principalId,
        consumer.clientInstanceId,
        consumer.hostId,
        consumer.hostEpoch,
        consumer.scopeId,
        consumer.sessionId,
    )

    override fun states(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): List<AgentTranscriptLifecyclePersistedState> = dao.agentTranscriptLifecycleStates(
        consumer.profileId,
        consumer.profileActivationGeneration,
        consumer.principalId,
        consumer.clientInstanceId,
        consumer.hostId,
        consumer.hostEpoch,
        consumer.scopeId,
        consumer.sessionId,
    ).map(RelayV2AgentTranscriptLifecycleStateEntity::toPersisted)

    override fun recoveryNamespaceCandidates(
        authority: AgentTranscriptLifecycleRecoveryCatalogAuthority,
        afterScopeId: String?,
        afterSessionId: String?,
        limit: Int,
    ): List<AgentTranscriptLifecycleDurableNamespace> {
        require((afterScopeId == null) == (afterSessionId == null))
        require(limit in 1..AGENT_TRANSCRIPT_LIFECYCLE_RECOVERY_CATALOG_PAGE_LIMIT + 1)
        val candidates = if (afterScopeId == null) {
            dao.agentTranscriptRecoveryNamespaceFirstPage(
                authority.profileId,
                authority.profileActivationGeneration,
                authority.principalId,
                authority.clientInstanceId,
                authority.hostId,
                authority.hostEpoch,
                limit,
            )
        } else {
            dao.agentTranscriptRecoveryNamespacePageAfter(
                authority.profileId,
                authority.profileActivationGeneration,
                authority.principalId,
                authority.clientInstanceId,
                authority.hostId,
                authority.hostEpoch,
                afterScopeId,
                requireNotNull(afterSessionId),
                limit,
            )
        }
        return candidates.map { candidate ->
            AgentTranscriptLifecycleDurableNamespace(
                AgentTranscriptLifecycleDurableConsumerIdentity(
                    candidate.profileId,
                    candidate.profileActivationGeneration,
                    candidate.principalId,
                    candidate.clientInstanceId,
                    candidate.hostId,
                    candidate.hostEpoch,
                    candidate.scopeId,
                    candidate.sessionId,
                ),
                candidate.timelineEpochKey.takeIf(String::isNotEmpty),
            )
        }
    }

    override fun insertState(state: AgentTranscriptLifecyclePersistedState) {
        dao.insertAgentTranscriptLifecycleState(state.toEntity())
    }

    override fun compareAndSetState(
        expected: AgentTranscriptLifecyclePersistedState,
        next: AgentTranscriptLifecyclePersistedState,
    ): Int {
        require(expected.namespace == next.namespace)
        val consumer = expected.namespace.consumer
        return lifecycleDao.updateConsumerAuthorityExact(
            profileId = consumer.profileId,
            profileActivationGeneration = consumer.profileActivationGeneration,
            principalId = consumer.principalId,
            clientInstanceId = consumer.clientInstanceId,
            hostId = consumer.hostId,
            hostEpoch = consumer.hostEpoch,
            scopeId = consumer.scopeId,
            sessionId = consumer.sessionId,
            timelineEpoch = expected.namespace.timelineEpochKey,
            expectedCodecVersion = expected.payload.codecVersion,
            expectedPayloadUtf8Bytes = expected.payload.payloadUtf8Bytes,
            expectedPayloadCanonicalJson = expected.payload.canonicalJson,
            expectedPayloadSha256 = expected.payload.sha256,
            newCodecVersion = next.payload.codecVersion,
            newPayloadUtf8Bytes = next.payload.payloadUtf8Bytes,
            newPayloadCanonicalJson = next.payload.canonicalJson,
            newPayloadSha256 = next.payload.sha256,
        )
    }

    override fun deleteStateForTimelineRotation(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): Int {
        val consumer = namespace.consumer
        return lifecycleDao.deleteConsumerAuthorityForTimelineRotation(
            consumer.profileId,
            consumer.profileActivationGeneration,
            consumer.principalId,
            consumer.clientInstanceId,
            consumer.hostId,
            consumer.hostEpoch,
            consumer.scopeId,
            consumer.sessionId,
            namespace.timelineEpochKey,
        )
    }

    override fun transcriptNamespaceStats(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): RelayV2AgentTranscriptNamespaceStats {
        val n = namespace.roomTranscriptNamespace()
        return dao.agentTranscriptNamespaceStats(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
        )
    }

    override fun emptyTimelineNamespaceStats(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): RelayV2AgentTranscriptNamespaceStats = dao.agentTranscriptNamespaceStats(
        consumer.profileId,
        consumer.profileActivationGeneration,
        consumer.principalId,
        consumer.clientInstanceId,
        consumer.hostId,
        consumer.hostEpoch,
        consumer.scopeId,
        consumer.sessionId,
        "",
    )

    override fun transcriptConsumerStats(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): RelayV2AgentTranscriptConsumerStats = dao.agentTranscriptConsumerStats(
        consumer.profileId,
        consumer.profileActivationGeneration,
        consumer.principalId,
        consumer.clientInstanceId,
        consumer.hostId,
        consumer.hostEpoch,
        consumer.scopeId,
        consumer.sessionId,
    )

    override fun entryCount(namespace: AgentTranscriptLifecycleDurableNamespace): Long {
        val n = namespace.roomTranscriptNamespace()
        return dao.agentTranscriptEntryStats(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
        ).itemCount
    }

    override fun entries(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterCreatedAgentSeqOrder: String?,
        afterEntryId: String?,
        limit: Int,
    ): List<RelayV2AgentTranscriptEntryEntity> {
        requireTranscriptBatchLimit(limit)
        require((afterCreatedAgentSeqOrder == null) == (afterEntryId == null))
        val n = namespace.roomTranscriptNamespace()
        return dao.agentTranscriptEntryPageAfter(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
            afterCreatedAgentSeqOrder ?: "", afterEntryId ?: "", limit,
        )
    }

    override fun entryBatchMetadata(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterCreatedAgentSeqOrder: String?,
        afterEntryId: String?,
        limit: Int,
    ): List<RelayV2AgentTranscriptEntryBatchMetadata> {
        requireTranscriptBatchLimit(limit)
        require((afterCreatedAgentSeqOrder == null) == (afterEntryId == null))
        val n = namespace.roomTranscriptNamespace()
        return dao.agentTranscriptEntryBatchMetadata(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
            afterCreatedAgentSeqOrder, afterEntryId, limit,
        )
    }

    override fun insertEntry(entry: RelayV2AgentTranscriptEntryEntity) {
        dao.insertAgentTranscriptEntry(entry)
    }

    override fun entryById(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        entryId: String,
    ) = namespace.roomTranscriptNamespace().let { n ->
        dao.agentTranscriptEntryById(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, entryId,
        )
    }

    override fun compareAndSetEntry(
        expected: RelayV2AgentTranscriptEntryEntity,
        next: RelayV2AgentTranscriptEntryEntity,
    ): Int = dao.compareAndSetAgentTranscriptEntry(
        profileId = expected.profileId,
        profileActivationGeneration = expected.profileActivationGeneration,
        principalId = expected.principalId,
        clientInstanceId = expected.clientInstanceId,
        hostId = expected.hostId,
        hostEpoch = expected.hostEpoch,
        scopeId = expected.scopeId,
        sessionId = expected.sessionId,
        timelineEpoch = expected.timelineEpoch,
        entryId = expected.entryId,
        expectedLastModifiedAgentSeq = expected.lastModifiedAgentSeq,
        expectedLastModifiedAgentSeqOrder = expected.lastModifiedAgentSeqOrder,
        expectedEntryState = expected.entryState,
        expectedPayloadSha256 = expected.payloadSha256,
        lastModifiedAgentSeq = next.lastModifiedAgentSeq,
        lastModifiedAgentSeqOrder = next.lastModifiedAgentSeqOrder,
        entryState = next.entryState,
        text = next.text,
        redactionReason = next.redactionReason,
        tombstoneOrigin = next.tombstoneOrigin,
        tombstoneEvidenceThroughAgentSeq = next.tombstoneEvidenceThroughAgentSeq,
        tombstoneEvidenceThroughAgentSeqOrder = next.tombstoneEvidenceThroughAgentSeqOrder,
        payloadCanonicalJson = next.payloadCanonicalJson,
        payloadUtf8Bytes = next.payloadUtf8Bytes,
        payloadSha256 = next.payloadSha256,
    )

    override fun deleteEntries(namespace: AgentTranscriptLifecycleDurableNamespace): Int {
        val n = namespace.roomTranscriptNamespace()
        var total = 0
        while (true) {
            val deleted = dao.deleteAgentTranscriptEntryBatch(
                n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
                n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
                RelayV2StateLimits.MAX_SNAPSHOT_CHUNK_RECORDS,
            )
            if (deleted == 0) return total
            total = Math.addExact(total, deleted)
        }
    }

    override fun snapshotCount(namespace: AgentTranscriptLifecycleDurableNamespace): Long {
        val n = namespace.roomTranscriptNamespace()
        return dao.agentTranscriptSnapshotCount(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
        )
    }

    override fun snapshots(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): List<RelayV2AgentTranscriptSnapshotStagingEntity> {
        val n = namespace.roomTranscriptNamespace()
        return dao.agentTranscriptSnapshots(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
        )
    }

    override fun insertSnapshot(snapshot: RelayV2AgentTranscriptSnapshotStagingEntity) {
        dao.insertAgentTranscriptSnapshot(snapshot)
    }

    override fun compareAndSetSnapshot(
        expected: RelayV2AgentTranscriptSnapshotStagingEntity,
        next: RelayV2AgentTranscriptSnapshotStagingEntity,
    ): Int = dao.compareAndSetAgentTranscriptSnapshot(
        profileId = expected.profileId,
        profileActivationGeneration = expected.profileActivationGeneration,
        principalId = expected.principalId,
        clientInstanceId = expected.clientInstanceId,
        hostId = expected.hostId,
        hostEpoch = expected.hostEpoch,
        scopeId = expected.scopeId,
        sessionId = expected.sessionId,
        timelineEpoch = expected.timelineEpoch,
        snapshotRequestId = expected.snapshotRequestId,
        requestLocalGeneration = expected.requestLocalGeneration,
        requestNetworkToken = expected.requestNetworkToken,
        nextRequestNetworkToken = next.requestNetworkToken,
        snapshotId = expected.snapshotId,
        throughAgentSeq = expected.throughAgentSeq,
        throughAgentSeqOrder = expected.throughAgentSeqOrder,
        earliestRetainedSeq = expected.earliestRetainedSeq,
        earliestRetainedSeqOrder = expected.earliestRetainedSeqOrder,
        expectedNextPageIndex = expected.nextPageIndex,
        expectedNextCursor = expected.nextCursor,
        expectedReceivedRecordCount = expected.receivedRecordCount,
        expectedReceivedCanonicalBytes = expected.receivedCanonicalBytes,
        expectedReceivedRawUtf8Bytes = expected.receivedRawUtf8Bytes,
        expectedLastAgentSeq = expected.lastAgentSeq,
        expectedLastAgentSeqOrder = expected.lastAgentSeqOrder,
        expectedLastRecordKind = expected.lastRecordKind,
        expectedLastStableIdentity = expected.lastStableIdentity,
        expectedComplete = expected.complete,
        nextPageIndex = next.nextPageIndex,
        nextCursor = next.nextCursor,
        receivedRecordCount = next.receivedRecordCount,
        receivedCanonicalBytes = next.receivedCanonicalBytes,
        receivedRawUtf8Bytes = next.receivedRawUtf8Bytes,
        lastAgentSeq = next.lastAgentSeq,
        lastAgentSeqOrder = next.lastAgentSeqOrder,
        lastRecordKind = next.lastRecordKind,
        lastStableIdentity = next.lastStableIdentity,
        complete = next.complete,
    )

    override fun deleteSnapshot(snapshot: RelayV2AgentTranscriptSnapshotStagingEntity): Int =
        dao.deleteAgentTranscriptSnapshot(
            snapshot.profileId,
            snapshot.profileActivationGeneration,
            snapshot.principalId,
            snapshot.clientInstanceId,
            snapshot.hostId,
            snapshot.hostEpoch,
            snapshot.scopeId,
            snapshot.sessionId,
            snapshot.timelineEpoch,
            snapshot.snapshotId,
        )

    override fun snapshotRecordCount(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        snapshotId: String,
    ): Long {
        val n = namespace.roomTranscriptNamespace()
        return dao.agentTranscriptSnapshotRecordStats(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, snapshotId,
        ).itemCount
    }

    override fun snapshotRecords(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        snapshotId: String,
        afterRecordIndex: Long,
        limit: Int,
    ): List<RelayV2AgentTranscriptSnapshotRecordEntity> {
        requireTranscriptBatchLimit(limit)
        val n = namespace.roomTranscriptNamespace()
        return dao.agentTranscriptSnapshotRecordPageAfter(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, snapshotId,
            afterRecordIndex, limit,
        )
    }

    override fun snapshotRecordsByStableIdentity(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        snapshotId: String,
        stableIdentity: String,
    ): List<RelayV2AgentTranscriptSnapshotRecordEntity> {
        val n = namespace.roomTranscriptNamespace()
        return dao.agentTranscriptSnapshotRecordsByStableIdentity(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, snapshotId,
            stableIdentity,
        )
    }

    override fun snapshotRecordBatchMetadata(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        snapshotId: String,
        afterRecordIndex: Long,
        limit: Int,
    ): List<RelayV2AgentTranscriptSnapshotRecordBatchMetadata> {
        requireTranscriptBatchLimit(limit)
        val n = namespace.roomTranscriptNamespace()
        return dao.agentTranscriptSnapshotRecordBatchMetadata(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, snapshotId,
            afterRecordIndex, limit,
        )
    }

    override fun insertSnapshotRecords(records: List<RelayV2AgentTranscriptSnapshotRecordEntity>) {
        dao.insertAgentTranscriptSnapshotRecords(records)
    }

    override fun pendingEventCount(namespace: AgentTranscriptLifecycleDurableNamespace): Long {
        val n = namespace.roomTranscriptNamespace()
        return dao.agentTranscriptPendingEventStats(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
        ).itemCount
    }

    override fun pendingEvents(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterAgentEventSeqOrder: String?,
        limit: Int,
    ): List<RelayV2AgentTranscriptPendingEventEntity> {
        requireTranscriptBatchLimit(limit)
        val n = namespace.roomTranscriptNamespace()
        return dao.agentTranscriptPendingEventPageAfter(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
            afterAgentEventSeqOrder ?: "", "", limit,
        )
    }

    override fun pendingEventBatchMetadata(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterAgentEventSeqOrder: String?,
        limit: Int,
    ): List<RelayV2AgentTranscriptPendingEventBatchMetadata> {
        requireTranscriptBatchLimit(limit)
        val n = namespace.roomTranscriptNamespace()
        return dao.agentTranscriptPendingEventBatchMetadata(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
            afterAgentEventSeqOrder, limit,
        )
    }

    override fun insertPendingEvent(event: RelayV2AgentTranscriptPendingEventEntity) {
        dao.insertAgentTranscriptPendingEvent(event)
    }

    override fun pendingEventBySeq(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        agentEventSeq: String,
    ) = namespace.roomTranscriptNamespace().let { n ->
        dao.agentTranscriptPendingEventBySeq(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, agentEventSeq,
        )
    }

    override fun pendingEventByEventId(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        eventId: String,
    ) = namespace.roomTranscriptNamespace().let { n ->
        dao.agentTranscriptPendingEventByEventId(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, eventId,
        )
    }

    override fun deletePendingEvent(event: RelayV2AgentTranscriptPendingEventEntity): Int =
        dao.deleteAgentTranscriptPendingEvent(
            event.profileId,
            event.profileActivationGeneration,
            event.principalId,
            event.clientInstanceId,
            event.hostId,
            event.hostEpoch,
            event.scopeId,
            event.sessionId,
            event.timelineEpoch,
            event.agentEventSeq,
            event.eventId,
            event.closedEventDigest,
        )

    override fun deletePendingEvents(namespace: AgentTranscriptLifecycleDurableNamespace): Int {
        val n = namespace.roomTranscriptNamespace()
        var total = 0
        while (true) {
            val deleted = dao.deleteAgentTranscriptPendingEventBatch(
                n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
                n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
                RelayV2StateLimits.MAX_SNAPSHOT_CHUNK_RECORDS,
            )
            if (deleted == 0) return total
            total = Math.addExact(total, deleted)
        }
    }

    override fun lifecycleCurrentStats(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.currentStats(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
        )
    }

    override fun lifecycleWitnessAudit(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.witnessAudit(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
        )
    }

    override fun recentEvidenceAudit(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.recentEvidenceAudit(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
        )
    }

    override fun notificationLedgerAudit(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.notificationAudit(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
        )
    }

    override fun lifecycleCurrentPage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.currentPageAfter(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
            afterAgentEventSeqOrder, afterEventId, limit,
        )
    }

    override fun lifecycleWitnessPage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.witnessPageAfter(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
            afterAgentEventSeqOrder, afterEventId, limit,
        )
    }

    override fun lifecycleWitnessIdentityAuditPage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterLifecycleScope: String,
        afterRunId: String,
        afterTurnIdKey: String,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.witnessIdentityAuditRowsAfter(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
            afterLifecycleScope, afterRunId, afterTurnIdKey, afterAgentEventSeqOrder,
            afterEventId, limit,
        )
    }

    override fun recentEvidencePage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.recentEvidencePageAfter(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
            afterAgentEventSeqOrder, afterEventId, limit,
        )
    }

    override fun notificationLedgerPage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        afterState: String,
        limit: Int,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.notificationPageAfter(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
            afterAgentEventSeqOrder, afterEventId, afterState, limit,
        )
    }

    override fun lifecycleCurrentByIdentity(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        identity: AgentLifecycleIdentity,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.currentByIdentity(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
            identity.scope.name, identity.runId, identity.turnId ?: "",
        )
    }

    override fun lifecycleCurrentByEventId(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        eventId: String,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.currentByEventId(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, eventId,
        )
    }

    override fun lifecycleCurrentByAgentEventSeq(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        agentEventSeq: String,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.currentByAgentEventSeq(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, agentEventSeq,
        )
    }

    override fun currentRun(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        runId: String,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.currentRun(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, runId,
        )
    }

    override fun currentNonterminalTurnsForRun(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        runId: String,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.currentNonterminalTurnsForRun(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, runId,
        )
    }

    override fun currentRunSourceEpochs(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        runId: String,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.currentRunSourceEpochs(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, runId,
        )
    }

    override fun terminalRunEvidence(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        runId: String,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.terminalRunEvidence(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, runId,
        )
    }

    override fun witnessByEventId(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        eventId: String,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.witnessByEventId(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, eventId,
        )
    }

    override fun witnessByAgentEventSeq(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        agentEventSeq: String,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.witnessByAgentEventSeq(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, agentEventSeq,
        )
    }

    override fun highestWitnessForIdentity(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        identity: AgentLifecycleIdentity,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.highestWitnessForIdentity(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
            identity.scope.name, identity.runId, identity.turnId ?: "",
        )
    }

    override fun hasPermanentTurnEvidence(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        runId: String,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.hasPermanentTurnEvidence(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, runId,
        )
    }

    override fun recentEvidenceByEventId(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        eventId: String,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.recentEvidenceByEventId(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, eventId,
        )
    }

    override fun recentEvidenceByAgentEventSeq(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        agentEventSeq: String,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.recentEvidenceByAgentEventSeq(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, agentEventSeq,
        )
    }

    override fun notificationByLifecycleEventId(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        eventId: String,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.notificationByLifecycleEventId(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, eventId,
        )
    }

    override fun notificationByDedupeKey(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        eventId: String,
        state: AgentLifecycleState,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.notificationByDedupeKey(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, eventId, state.name,
        )
    }

    override fun insertLifecycleWitnesses(rows: List<RelayV2AgentLifecycleEventWitnessEntity>) {
        lifecycleDao.insertWitnesses(rows)
    }

    override fun insertLifecycleCurrent(rows: List<RelayV2AgentLifecycleCurrentEntity>) {
        lifecycleDao.insertCurrent(rows)
    }

    override fun updateLifecycleCurrentExact(
        expected: RelayV2AgentLifecycleCurrentEntity,
        next: RelayV2AgentLifecycleCurrentEntity,
    ): Int = lifecycleDao.updateCurrentExact(
        expected.profileId, expected.profileActivationGeneration, expected.principalId,
        expected.clientInstanceId, expected.hostId, expected.hostEpoch, expected.scopeId,
        expected.sessionId, expected.timelineEpoch, expected.lifecycleScope, expected.runId,
        expected.turnIdKey, expected.lifecycleEventId, expected.agentEventSeq,
        expected.agentEventSeqOrder, next.lifecycleEventId, next.agentEventSeq,
        next.agentEventSeqOrder,
    )

    override fun deleteLifecycleCurrentExact(
        expected: RelayV2AgentLifecycleCurrentEntity,
    ): Int = lifecycleDao.deleteCurrentExact(
        expected.profileId, expected.profileActivationGeneration, expected.principalId,
        expected.clientInstanceId, expected.hostId, expected.hostEpoch, expected.scopeId,
        expected.sessionId, expected.timelineEpoch, expected.lifecycleScope, expected.runId,
        expected.turnIdKey, expected.lifecycleEventId, expected.agentEventSeq,
        expected.agentEventSeqOrder,
    )

    override fun insertRecentEvidence(rows: List<RelayV2AgentRecentEventEvidenceEntity>) {
        lifecycleDao.insertRecentEvidence(rows)
    }

    override fun deleteRecentEvidenceExact(
        expected: RelayV2AgentRecentEventEvidenceEntity,
    ): Int = lifecycleDao.deleteRecentEvidenceExact(
        expected.profileId, expected.profileActivationGeneration, expected.principalId,
        expected.clientInstanceId, expected.hostId, expected.hostEpoch, expected.scopeId,
        expected.sessionId, expected.timelineEpoch, expected.agentEventSeq,
        expected.agentEventSeqOrder, expected.eventId, expected.closedEventDigest,
        expected.evidenceCanonicalJson, expected.evidenceCanonicalUtf8Bytes,
        expected.evidenceSha256,
    )

    override fun deleteRecentEvidenceThroughBatch(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        throughAgentEventSeqOrder: String,
        limit: Int,
    ) = namespace.roomTranscriptNamespace().let { n ->
        lifecycleDao.deleteRecentEvidenceThroughBatch(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
            throughAgentEventSeqOrder, limit,
        )
    }

    override fun insertNotificationLedger(rows: List<RelayV2AgentNotificationLedgerEntity>) {
        lifecycleDao.insertNotifications(rows)
    }

    override fun deleteNotificationLedgerExact(
        expected: RelayV2AgentNotificationLedgerEntity,
    ): Int = lifecycleDao.deleteNotificationExact(
        expected.profileId, expected.profileActivationGeneration, expected.principalId,
        expected.clientInstanceId, expected.hostId, expected.hostEpoch, expected.scopeId,
        expected.sessionId, expected.timelineEpoch, expected.lifecycleEventId,
        expected.lifecycleState, expected.agentEventSeq, expected.agentEventSeqOrder,
        expected.disposition, expected.localGeneration, expected.ledgerCanonicalJson,
        expected.ledgerCanonicalUtf8Bytes, expected.ledgerSha256,
    )

    override fun notificationClaims(
        eventIdentity: AgentTranscriptLifecycleNotificationClaimEventIdentity,
    ): List<AgentTranscriptLifecyclePersistedNotificationClaim> {
        val consumer = eventIdentity.consumer
        return dao.agentTranscriptLifecycleNotificationClaims(
            consumer.profileId,
            consumer.profileActivationGeneration,
            consumer.principalId,
            consumer.clientInstanceId,
            consumer.hostId,
            consumer.hostEpoch,
            consumer.scopeId,
            consumer.sessionId,
            eventIdentity.timelineEpoch,
            eventIdentity.lifecycleEventId,
        ).map(RelayV2AgentTranscriptLifecycleNotificationClaimEntity::toPersisted)
    }

    override fun insertNotificationClaim(
        claim: AgentTranscriptLifecyclePersistedNotificationClaim,
    ) {
        dao.insertAgentTranscriptLifecycleNotificationClaim(claim.toEntity())
    }
}

private fun RelayV2AgentTranscriptLifecycleStateEntity.toPersisted():
    AgentTranscriptLifecyclePersistedState {
    val consumer = AgentTranscriptLifecycleDurableConsumerIdentity(
        profileId,
        profileActivationGeneration,
        principalId,
        clientInstanceId,
        hostId,
        hostEpoch,
        scopeId,
        sessionId,
    )
    return AgentTranscriptLifecyclePersistedState(
        AgentTranscriptLifecycleDurableNamespace(
            consumer,
            timelineEpochKey.takeIf(String::isNotEmpty),
        ),
        RelayV2EncodedPayload(
            codecVersion,
            payloadUtf8Bytes,
            payloadCanonicalJson,
            payloadSha256,
        ),
    )
}

private fun AgentTranscriptLifecyclePersistedState.toEntity():
    RelayV2AgentTranscriptLifecycleStateEntity {
    val consumer = namespace.consumer
    return RelayV2AgentTranscriptLifecycleStateEntity(
        profileId = consumer.profileId,
        profileActivationGeneration = consumer.profileActivationGeneration,
        principalId = consumer.principalId,
        clientInstanceId = consumer.clientInstanceId,
        hostId = consumer.hostId,
        hostEpoch = consumer.hostEpoch,
        scopeId = consumer.scopeId,
        sessionId = consumer.sessionId,
        timelineEpochKey = namespace.timelineEpochKey,
        codecVersion = payload.codecVersion,
        payloadUtf8Bytes = payload.payloadUtf8Bytes,
        payloadCanonicalJson = payload.canonicalJson,
        payloadSha256 = payload.sha256,
    )
}

private fun RelayV2AgentTranscriptLifecycleNotificationClaimEntity.toPersisted():
    AgentTranscriptLifecyclePersistedNotificationClaim = try {
        AgentTranscriptLifecyclePersistedNotificationClaim(
            AgentTranscriptLifecycleNotificationClaimKey(
                AgentTranscriptLifecycleDurableConsumerIdentity(
                    profileId,
                    profileActivationGeneration,
                    principalId,
                    clientInstanceId,
                    hostId,
                    hostEpoch,
                    scopeId,
                    sessionId,
                ),
                timelineEpoch,
                lifecycleEventId,
                decodeLifecycleState(lifecycleState),
            ),
            claimedLocalGeneration,
            RelayV2EncodedPayload(
                codecVersion,
                payloadUtf8Bytes,
                payloadCanonicalJson,
                payloadSha256,
            ),
        )
    } catch (error: RelayV2StorageException) {
        throw error
    } catch (_: IllegalArgumentException) {
        throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
    } catch (_: IllegalStateException) {
        throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
    }

private fun decodeLifecycleState(value: String): AgentLifecycleState =
    AgentLifecycleState.entries.singleOrNull { it.name == value }
        ?: throw RelayV2StorageException(RelayV2StorageFailure.SCHEMA_INCOMPATIBLE)

private fun AgentTranscriptLifecyclePersistedNotificationClaim.toEntity():
    RelayV2AgentTranscriptLifecycleNotificationClaimEntity {
    val consumer = key.consumer
    return RelayV2AgentTranscriptLifecycleNotificationClaimEntity(
        profileId = consumer.profileId,
        profileActivationGeneration = consumer.profileActivationGeneration,
        principalId = consumer.principalId,
        clientInstanceId = consumer.clientInstanceId,
        hostId = consumer.hostId,
        hostEpoch = consumer.hostEpoch,
        scopeId = consumer.scopeId,
        sessionId = consumer.sessionId,
        timelineEpoch = key.timelineEpoch,
        lifecycleEventId = key.lifecycleEventId,
        lifecycleState = key.lifecycleState.name,
        claimedLocalGeneration = claimedLocalGeneration,
        codecVersion = payload.codecVersion,
        payloadUtf8Bytes = payload.payloadUtf8Bytes,
        payloadCanonicalJson = payload.canonicalJson,
        payloadSha256 = payload.sha256,
    )
}

private data class RoomAgentTranscriptNamespace(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val timelineEpoch: String,
)

/** The only durable-namespace-to-Room-nine-column conversion. */
private fun AgentTranscriptLifecycleDurableNamespace.roomTranscriptNamespace(
    allowEmptyTimelineEpoch: Boolean = false,
):
    RoomAgentTranscriptNamespace {
    val epoch = timelineEpoch ?: if (allowEmptyTimelineEpoch) {
        timelineEpochKey
    } else {
        throw AgentTranscriptLifecyclePersistenceConflictException()
    }
    val c = consumer
    return RoomAgentTranscriptNamespace(
        profileId = c.profileId,
        profileActivationGeneration = c.profileActivationGeneration,
        principalId = c.principalId,
        clientInstanceId = c.clientInstanceId,
        hostId = c.hostId,
        hostEpoch = c.hostEpoch,
        scopeId = c.scopeId,
        sessionId = c.sessionId,
        timelineEpoch = epoch,
    )
}

private fun requireTranscriptBatchLimit(limit: Int) {
    require(limit in 1..RelayV2StateLimits.MAX_SNAPSHOT_CHUNK_RECORDS)
}
