package com.tmuxworktree.mobile.core.relay.v2.state

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

internal data class RelayV2SqlStats(
    val itemCount: Long,
    val byteCount: Long,
)

/** Small projection used to choose one heap-bounded materialized transcript batch. */
internal data class RelayV2AgentTranscriptEntryBatchMetadata(
    val createdAgentSeq: String,
    val createdAgentSeqOrder: String,
    val entryId: String,
    val payloadUtf8Bytes: Int,
    val actualPayloadUtf8Bytes: Long,
    val actualTextUtf8Bytes: Long,
)

/** Small projection used to choose one heap-bounded pinned snapshot-record batch. */
internal data class RelayV2AgentTranscriptSnapshotRecordBatchMetadata(
    val recordIndex: Long,
    val pageIndex: Long,
    val payloadRawUtf8Bytes: Int,
    val actualPayloadUtf8Bytes: Long,
)

internal data class RelayV2AgentTranscriptPendingEventBatchMetadata(
    val agentEventSeq: String,
    val agentEventSeqOrder: String,
    val eventId: String,
    val eventRawUtf8Bytes: Int,
    val actualPayloadUtf8Bytes: Long,
)

/** One-row, no-payload preflight for the exact nine-column transcript namespace. */
internal data class RelayV2AgentTranscriptNamespaceStats(
    val entryCount: Long,
    val entryPayloadUtf8Bytes: Long,
    val entryTextUtf8Bytes: Long,
    val entryMaxPayloadUtf8Bytes: Long,
    val entryMaxTextUtf8Bytes: Long,
    val entryMaxBoundedTextUtf8Bytes: Long,
    val snapshotCount: Long,
    val snapshotMaxIdUtf8Bytes: Long,
    val snapshotMaxCursorUtf8Bytes: Long,
    val snapshotRecordCount: Long,
    val snapshotRecordPayloadUtf8Bytes: Long,
    val snapshotRecordRawUtf8Bytes: Long,
    val snapshotRecordMinRawUtf8Bytes: Long,
    val snapshotRecordMaxRawUtf8Bytes: Long,
    val snapshotRecordMaxPayloadUtf8Bytes: Long,
    val snapshotRecordMaxBoundedTextUtf8Bytes: Long,
    val pendingEventCount: Long,
    val pendingEventPayloadUtf8Bytes: Long,
    val pendingEventRawUtf8Bytes: Long,
    val pendingEventMinRawUtf8Bytes: Long,
    val pendingEventMaxRawUtf8Bytes: Long,
    val pendingEventMaxPayloadUtf8Bytes: Long,
    val pendingEventMaxBoundedTextUtf8Bytes: Long,
)

/** One-row orphan check across every timeline epoch owned by one exact consumer identity. */
internal data class RelayV2AgentTranscriptConsumerStats(
    val entryCount: Long,
    val snapshotCount: Long,
    val snapshotRecordCount: Long,
    val pendingEventCount: Long,
)

@Dao
internal interface RelayV2StateDao {
    @Query(
        "SELECT * FROM relay_v2_authority WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch LIMIT 1",
    )
    fun authority(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
    ): RelayV2AuthorityEntity?

    @Query(
        "SELECT * FROM relay_v2_authority WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId ORDER BY hostEpoch",
    )
    fun authorities(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
    ): List<RelayV2AuthorityEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun putAuthority(authority: RelayV2AuthorityEntity)

    @Query(
        "SELECT * FROM relay_v2_scopes WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId LIMIT 1",
    )
    fun scope(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
    ): RelayV2ScopeEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun putScope(scope: RelayV2ScopeEntity)

    @Query(
        "DELETE FROM relay_v2_scopes WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId",
    )
    fun deleteScope(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
    )

    @Query(
        "DELETE FROM relay_v2_scopes WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch",
    )
    fun deleteScopes(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
    )

    @Query(
        "SELECT * FROM relay_v2_sessions WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch " +
            "AND scopeId = :scopeId AND sessionId = :sessionId LIMIT 1",
    )
    fun session(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
    ): RelayV2SessionEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun putSession(session: RelayV2SessionEntity)

    @Query(
        "DELETE FROM relay_v2_sessions WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch " +
            "AND scopeId = :scopeId AND sessionId = :sessionId",
    )
    fun deleteSession(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
    )

    @Query(
        "SELECT COUNT(*) AS itemCount, " +
            "COALESCE(SUM(length(CAST(recordCanonicalJson AS BLOB))), 0) AS byteCount " +
            "FROM relay_v2_sessions WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId",
    )
    fun sessionStats(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
    ): RelayV2SqlStats

    @Query(
        "DELETE FROM relay_v2_sessions WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId",
    )
    fun deleteSessionsForScope(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
    )

    @Query(
        "DELETE FROM relay_v2_sessions WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch",
    )
    fun deleteSessions(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
    )

    @Query(
        "SELECT * FROM relay_v2_snapshot_staging WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch LIMIT 1",
    )
    fun snapshot(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
    ): RelayV2SnapshotStagingEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun putSnapshot(snapshot: RelayV2SnapshotStagingEntity)

    @Query(
        "DELETE FROM relay_v2_snapshot_staging WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch",
    )
    fun deleteSnapshot(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
    )

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun putSnapshotRecords(records: List<RelayV2SnapshotRecordEntity>)

    @Query(
        "SELECT * FROM relay_v2_snapshot_records WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND snapshotId = :snapshotId " +
            "ORDER BY recordIndex LIMIT :limit OFFSET :offset",
    )
    fun snapshotRecordPage(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        snapshotId: String,
        limit: Int,
        offset: Long,
    ): List<RelayV2SnapshotRecordEntity>

    @Query(
        "SELECT * FROM relay_v2_snapshot_records WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND snapshotId = :snapshotId " +
            "AND scopeId = :scopeId AND recordType = :recordType LIMIT 1",
    )
    fun stagedRecord(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        snapshotId: String,
        scopeId: String,
        recordType: String,
    ): RelayV2SnapshotRecordEntity?

    @Query(
        "SELECT * FROM relay_v2_snapshot_records WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND snapshotId = :snapshotId " +
            "AND scopeId = :scopeId AND sessionId = :sessionId AND recordType = 'session' LIMIT 1",
    )
    fun stagedSessionRecord(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        snapshotId: String,
        scopeId: String,
        sessionId: String,
    ): RelayV2SnapshotRecordEntity?

    @Query(
        "SELECT COUNT(*) AS itemCount, COALESCE(SUM(length(CAST(canonicalJson AS BLOB))), 0) AS byteCount " +
            "FROM relay_v2_snapshot_records WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND snapshotId = :snapshotId " +
            "AND scopeId = :scopeId AND recordType = 'session'",
    )
    fun stagedSessionStats(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        snapshotId: String,
        scopeId: String,
    ): RelayV2SqlStats

    @Query(
        "DELETE FROM relay_v2_snapshot_records WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch",
    )
    fun deleteSnapshotRecords(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
    )

    @Query(
        "SELECT * FROM relay_v2_state_event_buffer WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND eventSeq = :eventSeq LIMIT 1",
    )
    fun bufferedEvent(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        eventSeq: String,
    ): RelayV2StateEventEntity?

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun putBufferedEvent(event: RelayV2StateEventEntity)

    @Query(
        "SELECT * FROM relay_v2_state_event_buffer WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch ORDER BY eventSeqOrder",
    )
    fun bufferedEvents(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
    ): List<RelayV2StateEventEntity>

    @Query(
        "SELECT COUNT(*) AS itemCount, COALESCE(SUM(rawUtf8Bytes), 0) AS byteCount " +
            "FROM relay_v2_state_event_buffer WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch",
    )
    fun bufferedEventStats(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
    ): RelayV2SqlStats

    @Query(
        "DELETE FROM relay_v2_state_event_buffer WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch",
    )
    fun deleteBufferedEvents(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
    )

    @Query(
        "SELECT * FROM relay_v2_outbox_meta WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId LIMIT 1",
    )
    fun outboxMeta(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
    ): RelayV2OutboxMetaEntity?

    @Query(
        "SELECT * FROM relay_v2_outbox_entries WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "ORDER BY createdOrder, commandId",
    )
    fun outboxEntries(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
    ): List<RelayV2OutboxEntryEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun putOutboxMeta(meta: RelayV2OutboxMetaEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertOutboxEntry(entry: RelayV2OutboxEntryEntity)

    @Query(
        "DELETE FROM relay_v2_outbox_entries WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND expectedHostEpoch = :expectedHostEpoch " +
            "AND commandId = :commandId",
    )
    fun deleteOutboxEntry(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        expectedHostEpoch: String,
        commandId: String,
    ): Int

    @Query("DELETE FROM relay_v2_outbox_entries WHERE profileId = :profileId")
    fun deleteProfileOutboxEntries(profileId: String)

    @Query("DELETE FROM relay_v2_outbox_meta WHERE profileId = :profileId")
    fun deleteProfileOutboxMeta(profileId: String)

    @Query(
        "SELECT * FROM relay_v2_terminal_checkpoints WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND streamId = :streamId AND pane = :pane LIMIT 1",
    )
    fun terminalCheckpoint(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        streamId: String,
        pane: Int,
    ): RelayV2TerminalCheckpointEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun putTerminalCheckpoint(checkpoint: RelayV2TerminalCheckpointEntity)

    @Query("DELETE FROM relay_v2_terminal_checkpoints WHERE profileId = :profileId")
    fun deleteProfileTerminalCheckpoints(profileId: String)

    @Query(
        "WITH entry_stats AS (SELECT COUNT(*) AS entryCount, " +
            "COALESCE(SUM(LENGTH(CAST(payloadCanonicalJson AS BLOB))), 0) " +
            "AS entryPayloadUtf8Bytes, " +
            "COALESCE(SUM(COALESCE(LENGTH(CAST(text AS BLOB)), 0)), 0) " +
            "AS entryTextUtf8Bytes, " +
            "COALESCE(MAX(LENGTH(CAST(payloadCanonicalJson AS BLOB))), 0) " +
            "AS entryMaxPayloadUtf8Bytes, " +
            "COALESCE(MAX(COALESCE(LENGTH(CAST(text AS BLOB)), 0)), 0) " +
            "AS entryMaxTextUtf8Bytes, " +
            "COALESCE(MAX(MAX(LENGTH(CAST(entryId AS BLOB)), " +
            "LENGTH(CAST(runId AS BLOB)), COALESCE(LENGTH(CAST(turnId AS BLOB)), 0), " +
            "COALESCE(LENGTH(CAST(commandId AS BLOB)), 0), LENGTH(CAST(role AS BLOB)), " +
            "LENGTH(CAST(entryState AS BLOB)), " +
            "COALESCE(LENGTH(CAST(redactionReason AS BLOB)), 0), " +
            "COALESCE(LENGTH(CAST(tombstoneOrigin AS BLOB)), 0), " +
            "COALESCE(LENGTH(CAST(tombstoneEvidenceThroughAgentSeq AS BLOB)), 0), " +
            "COALESCE(LENGTH(CAST(tombstoneEvidenceThroughAgentSeqOrder AS BLOB)), 0), " +
            "LENGTH(CAST(createdAgentSeq AS BLOB)), " +
            "LENGTH(CAST(createdAgentSeqOrder AS BLOB)), " +
            "LENGTH(CAST(lastModifiedAgentSeq AS BLOB)), " +
            "LENGTH(CAST(lastModifiedAgentSeqOrder AS BLOB)), " +
            "LENGTH(CAST(payloadSha256 AS BLOB)))), 0) AS entryMaxBoundedTextUtf8Bytes " +
            "FROM relay_v2_agent_transcript_entries WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch), " +
            "snapshot_stats AS (SELECT COUNT(*) AS snapshotCount, " +
            "COALESCE(MAX(MAX(LENGTH(CAST(snapshotRequestId AS BLOB)), " +
            "LENGTH(CAST(requestLocalGeneration AS BLOB)), " +
            "LENGTH(CAST(requestNetworkToken AS BLOB)), LENGTH(CAST(snapshotId AS BLOB)), " +
            "LENGTH(CAST(throughAgentSeq AS BLOB)), LENGTH(CAST(throughAgentSeqOrder AS BLOB)), " +
            "LENGTH(CAST(earliestRetainedSeq AS BLOB)), " +
            "LENGTH(CAST(earliestRetainedSeqOrder AS BLOB)), " +
            "COALESCE(LENGTH(CAST(lastAgentSeq AS BLOB)), 0), " +
            "COALESCE(LENGTH(CAST(lastAgentSeqOrder AS BLOB)), 0), " +
            "COALESCE(LENGTH(CAST(lastRecordKind AS BLOB)), 0), " +
            "COALESCE(LENGTH(CAST(lastStableIdentity AS BLOB)), 0)))), 0) " +
            "AS snapshotMaxIdUtf8Bytes, " +
            "COALESCE(MAX(COALESCE(LENGTH(CAST(nextCursor AS BLOB)), 0)), 0) " +
            "AS snapshotMaxCursorUtf8Bytes " +
            "FROM relay_v2_agent_transcript_snapshot_staging WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch), " +
            "record_stats AS (SELECT COUNT(*) AS snapshotRecordCount, " +
            "COALESCE(SUM(LENGTH(CAST(payloadCanonicalJson AS BLOB))), 0) " +
            "AS snapshotRecordPayloadUtf8Bytes, " +
            "COALESCE(SUM(payloadRawUtf8Bytes), 0) AS snapshotRecordRawUtf8Bytes, " +
            "COALESCE(MIN(payloadRawUtf8Bytes), 0) AS snapshotRecordMinRawUtf8Bytes, " +
            "COALESCE(MAX(payloadRawUtf8Bytes), 0) AS snapshotRecordMaxRawUtf8Bytes, " +
            "COALESCE(MAX(LENGTH(CAST(payloadCanonicalJson AS BLOB))), 0) " +
            "AS snapshotRecordMaxPayloadUtf8Bytes, " +
            "COALESCE(MAX(MAX(LENGTH(CAST(snapshotId AS BLOB)), " +
            "LENGTH(CAST(recordKind AS BLOB)), LENGTH(CAST(stableIdentity AS BLOB)), " +
            "LENGTH(CAST(agentEventSeq AS BLOB)), LENGTH(CAST(agentEventSeqOrder AS BLOB)), " +
            "LENGTH(CAST(payloadSha256 AS BLOB)))), 0) " +
            "AS snapshotRecordMaxBoundedTextUtf8Bytes " +
            "FROM relay_v2_agent_transcript_snapshot_records WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch), " +
            "pending_stats AS (SELECT COUNT(*) AS pendingEventCount, " +
            "COALESCE(SUM(LENGTH(CAST(eventCanonicalJson AS BLOB))), 0) " +
            "AS pendingEventPayloadUtf8Bytes, " +
            "COALESCE(SUM(eventRawUtf8Bytes), 0) AS pendingEventRawUtf8Bytes, " +
            "COALESCE(MIN(eventRawUtf8Bytes), 0) AS pendingEventMinRawUtf8Bytes, " +
            "COALESCE(MAX(eventRawUtf8Bytes), 0) AS pendingEventMaxRawUtf8Bytes, " +
            "COALESCE(MAX(LENGTH(CAST(eventCanonicalJson AS BLOB))), 0) " +
            "AS pendingEventMaxPayloadUtf8Bytes, " +
            "COALESCE(MAX(MAX(LENGTH(CAST(agentEventSeq AS BLOB)), " +
            "LENGTH(CAST(agentEventSeqOrder AS BLOB)), LENGTH(CAST(eventId AS BLOB)), " +
            "LENGTH(CAST(closedEventDigest AS BLOB)), " +
            "LENGTH(CAST(trustedProvenance AS BLOB)))), 0) " +
            "AS pendingEventMaxBoundedTextUtf8Bytes " +
            "FROM relay_v2_agent_transcript_pending_events WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch) " +
            "SELECT * FROM entry_stats, snapshot_stats, record_stats, pending_stats",
    )
    fun agentTranscriptNamespaceStats(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
    ): RelayV2AgentTranscriptNamespaceStats

    @Query(
        "SELECT " +
            "(SELECT COUNT(*) FROM relay_v2_agent_transcript_entries " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId) AS entryCount, " +
            "(SELECT COUNT(*) FROM relay_v2_agent_transcript_snapshot_staging " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId) AS snapshotCount, " +
            "(SELECT COUNT(*) FROM relay_v2_agent_transcript_snapshot_records " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId) AS snapshotRecordCount, " +
            "(SELECT COUNT(*) FROM relay_v2_agent_transcript_pending_events " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId) AS pendingEventCount",
    )
    fun agentTranscriptConsumerStats(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
    ): RelayV2AgentTranscriptConsumerStats

    @Query(
        "SELECT createdAgentSeq, createdAgentSeqOrder, entryId, " +
            "payloadUtf8Bytes, LENGTH(CAST(payloadCanonicalJson AS BLOB)) " +
            "AS actualPayloadUtf8Bytes, " +
            "COALESCE(LENGTH(CAST(text AS BLOB)), 0) AS actualTextUtf8Bytes " +
            "FROM relay_v2_agent_transcript_entries WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND (:afterCreatedAgentSeqOrder IS NULL OR " +
            "createdAgentSeqOrder > :afterCreatedAgentSeqOrder OR " +
            "(createdAgentSeqOrder = :afterCreatedAgentSeqOrder " +
            "AND entryId > :afterEntryId COLLATE BINARY)) " +
            "ORDER BY createdAgentSeqOrder, entryId COLLATE BINARY LIMIT :limit",
    )
    fun agentTranscriptEntryBatchMetadata(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        afterCreatedAgentSeqOrder: String?,
        afterEntryId: String?,
        limit: Int,
    ): List<RelayV2AgentTranscriptEntryBatchMetadata>

    @Query(
        "SELECT * FROM relay_v2_agent_transcript_entries WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND (:afterCreatedAgentSeqOrder IS NULL OR " +
            "createdAgentSeqOrder > :afterCreatedAgentSeqOrder OR " +
            "(createdAgentSeqOrder = :afterCreatedAgentSeqOrder " +
            "AND entryId > :afterEntryId COLLATE BINARY)) " +
            "ORDER BY createdAgentSeqOrder, entryId COLLATE BINARY LIMIT :limit",
    )
    fun agentTranscriptEntries(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        afterCreatedAgentSeqOrder: String?,
        afterEntryId: String?,
        limit: Int,
    ): List<RelayV2AgentTranscriptEntryEntity>

    @Query(
        "SELECT COUNT(*) FROM relay_v2_agent_transcript_entries WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch",
    )
    fun agentTranscriptEntryCount(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
    ): Long

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertAgentTranscriptEntry(entry: RelayV2AgentTranscriptEntryEntity)

    @Query(
        "UPDATE relay_v2_agent_transcript_entries SET " +
            "lastModifiedAgentSeq = :lastModifiedAgentSeq, " +
            "lastModifiedAgentSeqOrder = :lastModifiedAgentSeqOrder, " +
            "entryState = :entryState, text = :text, redactionReason = :redactionReason, " +
            "tombstoneOrigin = :tombstoneOrigin, " +
            "tombstoneEvidenceThroughAgentSeq = :tombstoneEvidenceThroughAgentSeq, " +
            "tombstoneEvidenceThroughAgentSeqOrder = " +
            ":tombstoneEvidenceThroughAgentSeqOrder, " +
            "payloadCanonicalJson = :payloadCanonicalJson, " +
            "payloadUtf8Bytes = :payloadUtf8Bytes, payloadSha256 = :payloadSha256 " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND entryId = :entryId " +
            "AND lastModifiedAgentSeq = :expectedLastModifiedAgentSeq " +
            "AND lastModifiedAgentSeqOrder = :expectedLastModifiedAgentSeqOrder " +
            "AND entryState = :expectedEntryState AND entryState != 'deleted' " +
            "AND payloadSha256 = :expectedPayloadSha256",
    )
    fun compareAndSetAgentTranscriptEntry(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        entryId: String,
        expectedLastModifiedAgentSeq: String,
        expectedLastModifiedAgentSeqOrder: String,
        expectedEntryState: String,
        expectedPayloadSha256: String,
        lastModifiedAgentSeq: String,
        lastModifiedAgentSeqOrder: String,
        entryState: String,
        text: String?,
        redactionReason: String?,
        tombstoneOrigin: String?,
        tombstoneEvidenceThroughAgentSeq: String?,
        tombstoneEvidenceThroughAgentSeqOrder: String?,
        payloadCanonicalJson: String,
        payloadUtf8Bytes: Int,
        payloadSha256: String,
    ): Int

    @Query(
        "DELETE FROM relay_v2_agent_transcript_entries WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch",
    )
    fun deleteAgentTranscriptEntries(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
    ): Int

    @Query(
        "SELECT * FROM relay_v2_agent_transcript_snapshot_staging " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch",
    )
    fun agentTranscriptSnapshots(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
    ): List<RelayV2AgentTranscriptSnapshotStagingEntity>

    @Query(
        "SELECT COUNT(*) FROM relay_v2_agent_transcript_snapshot_staging " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch",
    )
    fun agentTranscriptSnapshotCount(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
    ): Long

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertAgentTranscriptSnapshot(snapshot: RelayV2AgentTranscriptSnapshotStagingEntity)

    @Query(
        "UPDATE relay_v2_agent_transcript_snapshot_staging SET " +
            "requestNetworkToken = :nextRequestNetworkToken, " +
            "nextPageIndex = :nextPageIndex, nextCursor = :nextCursor, " +
            "receivedRecordCount = :receivedRecordCount, " +
            "receivedCanonicalBytes = :receivedCanonicalBytes, " +
            "receivedRawUtf8Bytes = :receivedRawUtf8Bytes, " +
            "lastAgentSeq = :lastAgentSeq, lastAgentSeqOrder = :lastAgentSeqOrder, " +
            "lastRecordKind = :lastRecordKind, lastStableIdentity = :lastStableIdentity, " +
            "complete = :complete WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND snapshotId = :snapshotId AND snapshotRequestId = :snapshotRequestId " +
            "AND requestLocalGeneration = :requestLocalGeneration " +
            "AND requestNetworkToken = :requestNetworkToken " +
            "AND throughAgentSeq = :throughAgentSeq " +
            "AND throughAgentSeqOrder = :throughAgentSeqOrder " +
            "AND earliestRetainedSeq = :earliestRetainedSeq " +
            "AND earliestRetainedSeqOrder = :earliestRetainedSeqOrder " +
            "AND nextPageIndex = :expectedNextPageIndex " +
            "AND nextCursor IS :expectedNextCursor " +
            "AND receivedRecordCount = :expectedReceivedRecordCount " +
            "AND receivedCanonicalBytes = :expectedReceivedCanonicalBytes " +
            "AND receivedRawUtf8Bytes = :expectedReceivedRawUtf8Bytes " +
            "AND lastAgentSeq IS :expectedLastAgentSeq " +
            "AND lastAgentSeqOrder IS :expectedLastAgentSeqOrder " +
            "AND lastRecordKind IS :expectedLastRecordKind " +
            "AND lastStableIdentity IS :expectedLastStableIdentity " +
            "AND complete = :expectedComplete",
    )
    fun compareAndSetAgentTranscriptSnapshot(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        snapshotRequestId: String,
        requestLocalGeneration: String,
        requestNetworkToken: String,
        nextRequestNetworkToken: String,
        snapshotId: String,
        throughAgentSeq: String,
        throughAgentSeqOrder: String,
        earliestRetainedSeq: String,
        earliestRetainedSeqOrder: String,
        expectedNextPageIndex: Long,
        expectedNextCursor: String?,
        expectedReceivedRecordCount: Long,
        expectedReceivedCanonicalBytes: Long,
        expectedReceivedRawUtf8Bytes: Long,
        expectedLastAgentSeq: String?,
        expectedLastAgentSeqOrder: String?,
        expectedLastRecordKind: String?,
        expectedLastStableIdentity: String?,
        expectedComplete: Boolean,
        nextPageIndex: Long,
        nextCursor: String?,
        receivedRecordCount: Long,
        receivedCanonicalBytes: Long,
        receivedRawUtf8Bytes: Long,
        lastAgentSeq: String?,
        lastAgentSeqOrder: String?,
        lastRecordKind: String?,
        lastStableIdentity: String?,
        complete: Boolean,
    ): Int

    @Query(
        "DELETE FROM relay_v2_agent_transcript_snapshot_staging " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND snapshotId = :snapshotId",
    )
    fun deleteAgentTranscriptSnapshot(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        snapshotId: String,
    ): Int

    @Query(
        "SELECT recordIndex, pageIndex, payloadRawUtf8Bytes, " +
            "LENGTH(CAST(payloadCanonicalJson AS BLOB)) AS actualPayloadUtf8Bytes " +
            "FROM relay_v2_agent_transcript_snapshot_records " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND snapshotId = :snapshotId AND recordIndex > :afterRecordIndex " +
            "ORDER BY recordIndex LIMIT :limit",
    )
    fun agentTranscriptSnapshotRecordBatchMetadata(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        snapshotId: String,
        afterRecordIndex: Long,
        limit: Int,
    ): List<RelayV2AgentTranscriptSnapshotRecordBatchMetadata>

    @Query(
        "SELECT * FROM relay_v2_agent_transcript_snapshot_records " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND snapshotId = :snapshotId AND recordIndex > :afterRecordIndex " +
            "ORDER BY recordIndex LIMIT :limit",
    )
    fun agentTranscriptSnapshotRecords(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        snapshotId: String,
        afterRecordIndex: Long,
        limit: Int,
    ): List<RelayV2AgentTranscriptSnapshotRecordEntity>

    @Query(
        "SELECT COUNT(*) FROM relay_v2_agent_transcript_snapshot_records " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND snapshotId = :snapshotId",
    )
    fun agentTranscriptSnapshotRecordCount(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        snapshotId: String,
    ): Long

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertAgentTranscriptSnapshotRecords(
        records: List<RelayV2AgentTranscriptSnapshotRecordEntity>,
    )

    @Query(
        "SELECT agentEventSeq, agentEventSeqOrder, eventId, eventRawUtf8Bytes, " +
            "LENGTH(CAST(eventCanonicalJson AS BLOB)) AS actualPayloadUtf8Bytes " +
            "FROM relay_v2_agent_transcript_pending_events " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND (:afterAgentEventSeqOrder IS NULL OR " +
            "agentEventSeqOrder > :afterAgentEventSeqOrder) " +
            "ORDER BY agentEventSeqOrder LIMIT :limit",
    )
    fun agentTranscriptPendingEventBatchMetadata(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        afterAgentEventSeqOrder: String?,
        limit: Int,
    ): List<RelayV2AgentTranscriptPendingEventBatchMetadata>

    @Query(
        "SELECT * FROM relay_v2_agent_transcript_pending_events " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND (:afterAgentEventSeqOrder IS NULL OR " +
            "agentEventSeqOrder > :afterAgentEventSeqOrder) " +
            "ORDER BY agentEventSeqOrder LIMIT :limit",
    )
    fun agentTranscriptPendingEvents(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        afterAgentEventSeqOrder: String?,
        limit: Int,
    ): List<RelayV2AgentTranscriptPendingEventEntity>

    @Query(
        "SELECT COUNT(*) FROM relay_v2_agent_transcript_pending_events " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch",
    )
    fun agentTranscriptPendingEventCount(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
    ): Long

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertAgentTranscriptPendingEvent(event: RelayV2AgentTranscriptPendingEventEntity)

    @Query(
        "DELETE FROM relay_v2_agent_transcript_pending_events WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND agentEventSeq = :agentEventSeq AND eventId = :eventId " +
            "AND closedEventDigest = :closedEventDigest",
    )
    fun deleteAgentTranscriptPendingEvent(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        agentEventSeq: String,
        eventId: String,
        closedEventDigest: String,
    ): Int

    @Query(
        "DELETE FROM relay_v2_agent_transcript_pending_events WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch",
    )
    fun deleteAgentTranscriptPendingEvents(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
    ): Int

    @Query("DELETE FROM relay_v2_agent_transcript_snapshot_staging WHERE profileId = :profileId")
    fun deleteProfileAgentTranscriptSnapshots(profileId: String)

    @Query("DELETE FROM relay_v2_agent_transcript_pending_events WHERE profileId = :profileId")
    fun deleteProfileAgentTranscriptPendingEvents(profileId: String)

    @Query("DELETE FROM relay_v2_agent_transcript_entries WHERE profileId = :profileId")
    fun deleteProfileAgentTranscriptEntries(profileId: String)

    @Query(
        "SELECT * FROM relay_v2_agent_transcript_lifecycle_states " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch " +
            "AND scopeId = :scopeId AND sessionId = :sessionId ORDER BY timelineEpochKey",
    )
    fun agentTranscriptLifecycleStates(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
    ): List<RelayV2AgentTranscriptLifecycleStateEntity>

    @Query(
        "SELECT COUNT(*) FROM relay_v2_agent_transcript_lifecycle_states " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch " +
            "AND scopeId = :scopeId AND sessionId = :sessionId",
    )
    fun agentTranscriptLifecycleStateCount(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
    ): Long

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertAgentTranscriptLifecycleState(
        state: RelayV2AgentTranscriptLifecycleStateEntity,
    )

    @Query(
        "DELETE FROM relay_v2_agent_transcript_lifecycle_states " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch " +
            "AND scopeId = :scopeId AND sessionId = :sessionId",
    )
    fun deleteAgentTranscriptLifecycleConsumer(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
    )

    @Query(
        "DELETE FROM relay_v2_agent_transcript_lifecycle_states " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch " +
            "AND scopeId = :scopeId AND sessionId = :sessionId " +
            "AND timelineEpochKey = :timelineEpochKey",
    )
    fun deleteAgentTranscriptLifecycleState(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpochKey: String,
    ): Int

    @Query(
        "DELETE FROM relay_v2_agent_transcript_lifecycle_states WHERE profileId = :profileId",
    )
    fun deleteProfileAgentTranscriptLifecycleStates(profileId: String)

    @Query(
        "SELECT * FROM relay_v2_agent_transcript_lifecycle_notification_claims " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch " +
            "AND scopeId = :scopeId AND sessionId = :sessionId " +
            "AND timelineEpoch = :timelineEpoch " +
            "AND lifecycleEventId = :lifecycleEventId",
    )
    fun agentTranscriptLifecycleNotificationClaims(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        lifecycleEventId: String,
    ): List<RelayV2AgentTranscriptLifecycleNotificationClaimEntity>

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertAgentTranscriptLifecycleNotificationClaim(
        claim: RelayV2AgentTranscriptLifecycleNotificationClaimEntity,
    )

    @Query(
        "DELETE FROM relay_v2_agent_transcript_lifecycle_notification_claims " +
            "WHERE profileId = :profileId",
    )
    fun deleteProfileAgentTranscriptLifecycleNotificationClaims(profileId: String)

    @Query(
        "DELETE FROM relay_v2_authority WHERE profileId = :profileId " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch",
    )
    fun deleteNamespaceAuthority(
        profileId: String,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
    )

    // These profile-wide deletes are reserved for the disconnect-receipt barrier. Unlike every
    // namespace operation above, they intentionally remove every isolated binding for profileId.
    @Query("DELETE FROM relay_v2_authority WHERE profileId = :profileId")
    fun deleteProfileAuthorities(profileId: String)

    @Query("DELETE FROM relay_v2_scopes WHERE profileId = :profileId")
    fun deleteProfileScopes(profileId: String)

    @Query("DELETE FROM relay_v2_sessions WHERE profileId = :profileId")
    fun deleteProfileSessions(profileId: String)

    @Query("DELETE FROM relay_v2_snapshot_staging WHERE profileId = :profileId")
    fun deleteProfileSnapshots(profileId: String)

    @Query("DELETE FROM relay_v2_snapshot_records WHERE profileId = :profileId")
    fun deleteProfileSnapshotRecords(profileId: String)

    @Query("DELETE FROM relay_v2_state_event_buffer WHERE profileId = :profileId")
    fun deleteProfileEvents(profileId: String)
}
