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
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2EncodedPayload
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageException
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageFailure
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateDao
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateDatabase
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateLimits

/** Room adapter for the optional, still-unwired Agent transcript/lifecycle durable consumer. */
internal class AgentTranscriptLifecycleDurableRepository(
    database: RelayV2StateDatabase,
) : AgentTranscriptLifecycleDurableReductionPort {
    private val core = AgentTranscriptLifecycleDurableRepositoryCore(
        RoomAgentTranscriptLifecycleDurableStore(database),
    )

    suspend fun load(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): AgentTranscriptLifecycleDurableRecord? = core.load(consumer)

    suspend fun initializeUnderApplyLease(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        state: AgentTranscriptLifecycleClientState,
    ): AgentTranscriptLifecycleInitializeResult =
        core.initializeUnderApplyLease(namespace, state)

    override suspend fun reduceUnderApplyLease(
        expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
        input: AgentTranscriptLifecycleClientInput,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleClientReduction =
        core.reduceUnderApplyLease(expectedNamespace, input, limits)

    suspend fun claimNotificationUnderApplyLease(
        expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
        intent: AgentSystemNotificationIntent,
    ): AgentTranscriptLifecycleNotificationClaimResult =
        core.claimNotificationUnderApplyLease(expectedNamespace, intent)
}

private class RoomAgentTranscriptLifecycleDurableStore(
    private val database: RelayV2StateDatabase,
) : AgentTranscriptLifecycleDurableStore {
    private val dao = database.stateDao()

    override suspend fun <T> transaction(
        block: AgentTranscriptLifecycleDurableTransaction.() -> T,
    ): T = database.withTransaction {
        RoomAgentTranscriptLifecycleDurableTransaction(dao).block()
    }
}

private class RoomAgentTranscriptLifecycleDurableTransaction(
    private val dao: RelayV2StateDao,
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

    override fun deleteState(namespace: AgentTranscriptLifecycleDurableNamespace): Int {
        val consumer = namespace.consumer
        return dao.deleteAgentTranscriptLifecycleState(
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

    override fun insertState(state: AgentTranscriptLifecyclePersistedState) {
        dao.insertAgentTranscriptLifecycleState(state.toEntity())
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
        return dao.agentTranscriptEntryCount(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
        )
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
        return dao.agentTranscriptEntries(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
            afterCreatedAgentSeqOrder, afterEntryId, limit,
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
        return dao.deleteAgentTranscriptEntries(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
        )
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
        return dao.agentTranscriptSnapshotRecordCount(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, snapshotId,
        )
    }

    override fun snapshotRecords(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        snapshotId: String,
        afterRecordIndex: Long,
        limit: Int,
    ): List<RelayV2AgentTranscriptSnapshotRecordEntity> {
        requireTranscriptBatchLimit(limit)
        val n = namespace.roomTranscriptNamespace()
        return dao.agentTranscriptSnapshotRecords(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch, snapshotId,
            afterRecordIndex, limit,
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
        return dao.agentTranscriptPendingEventCount(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
        )
    }

    override fun pendingEvents(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): List<RelayV2AgentTranscriptPendingEventEntity> {
        val n = namespace.roomTranscriptNamespace()
        return dao.agentTranscriptPendingEvents(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
        )
    }

    override fun insertPendingEvent(event: RelayV2AgentTranscriptPendingEventEntity) {
        dao.insertAgentTranscriptPendingEvent(event)
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
        return dao.deleteAgentTranscriptPendingEvents(
            n.profileId, n.profileActivationGeneration, n.principalId, n.clientInstanceId,
            n.hostId, n.hostEpoch, n.scopeId, n.sessionId, n.timelineEpoch,
        )
    }

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
