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

    // These six profile-wide deletes are reserved for the disconnect-receipt barrier. Unlike every
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
