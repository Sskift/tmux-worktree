package com.tmuxworktree.mobile.core.relay.v2.state

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

internal data class RelayV2SqlStats(
    val itemCount: Long,
    val byteCount: Long,
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
            "ORDER BY recordIndex " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END " +
            "OFFSET :offset",
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
        "SELECT * FROM relay_v2_agent_transcript_entries WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch AND " +
            "(createdAgentSeqOrder > :afterCreatedAgentSeqOrder OR " +
            "(createdAgentSeqOrder = :afterCreatedAgentSeqOrder AND entryId > :afterEntryId)) " +
            "ORDER BY createdAgentSeqOrder, entryId " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun agentTranscriptEntryPageAfter(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        afterCreatedAgentSeqOrder: String,
        afterEntryId: String,
        limit: Int,
    ): List<RelayV2AgentTranscriptEntryEntity>

    @Query(
        "SELECT COUNT(*) AS itemCount, COALESCE(SUM(payloadUtf8Bytes), 0) AS byteCount " +
            "FROM relay_v2_agent_transcript_entries WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch",
    )
    fun agentTranscriptEntryStats(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
    ): RelayV2SqlStats

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertAgentTranscriptEntry(entry: RelayV2AgentTranscriptEntryEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertAgentTranscriptEntries(entries: List<RelayV2AgentTranscriptEntryEntity>)

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
        "DELETE FROM relay_v2_agent_transcript_entries WHERE rowid IN " +
            "(SELECT rowid FROM relay_v2_agent_transcript_entries " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "ORDER BY createdAgentSeqOrder, entryId " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END)",
    )
    fun deleteAgentTranscriptEntryBatch(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        limit: Int,
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
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch",
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
    ): Int

    @Query(
        "SELECT * FROM relay_v2_agent_transcript_snapshot_records " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND snapshotId = :snapshotId AND recordIndex > :afterRecordIndex " +
            "ORDER BY recordIndex " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun agentTranscriptSnapshotRecordPageAfter(
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
        "SELECT COUNT(*) AS itemCount, COALESCE(SUM(payloadRawUtf8Bytes), 0) AS byteCount " +
            "FROM relay_v2_agent_transcript_snapshot_records " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "AND snapshotId = :snapshotId",
    )
    fun agentTranscriptSnapshotRecordStats(
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
    ): RelayV2SqlStats

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertAgentTranscriptSnapshotRecords(
        records: List<RelayV2AgentTranscriptSnapshotRecordEntity>,
    )

    @Query(
        "SELECT * FROM relay_v2_agent_transcript_pending_events " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch AND " +
            "(agentEventSeqOrder > :afterAgentEventSeqOrder OR " +
            "(agentEventSeqOrder = :afterAgentEventSeqOrder AND eventId > :afterEventId)) " +
            "ORDER BY agentEventSeqOrder, eventId " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END",
    )
    fun agentTranscriptPendingEventPageAfter(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        afterAgentEventSeqOrder: String,
        afterEventId: String,
        limit: Int,
    ): List<RelayV2AgentTranscriptPendingEventEntity>

    @Query(
        "SELECT COUNT(*) AS itemCount, COALESCE(SUM(eventRawUtf8Bytes), 0) AS byteCount " +
            "FROM relay_v2_agent_transcript_pending_events " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch",
    )
    fun agentTranscriptPendingEventStats(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
    ): RelayV2SqlStats

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertAgentTranscriptPendingEvent(event: RelayV2AgentTranscriptPendingEventEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertAgentTranscriptPendingEvents(events: List<RelayV2AgentTranscriptPendingEventEntity>)

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
        "DELETE FROM relay_v2_agent_transcript_pending_events WHERE rowid IN " +
            "(SELECT rowid FROM relay_v2_agent_transcript_pending_events " +
            "WHERE profileId = :profileId " +
            "AND profileActivationGeneration = :profileActivationGeneration " +
            "AND principalId = :principalId AND clientInstanceId = :clientInstanceId " +
            "AND hostId = :hostId AND hostEpoch = :hostEpoch AND scopeId = :scopeId " +
            "AND sessionId = :sessionId AND timelineEpoch = :timelineEpoch " +
            "ORDER BY agentEventSeqOrder, eventId " +
            "LIMIT CASE WHEN :limit < 1 THEN 1 WHEN :limit > 256 THEN 256 ELSE :limit END)",
    )
    fun deleteAgentTranscriptPendingEventBatch(
        profileId: String,
        profileActivationGeneration: Long,
        principalId: String,
        clientInstanceId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        timelineEpoch: String,
        limit: Int,
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
