package com.tmuxworktree.mobile.core.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface TwDao {
    @Query("SELECT * FROM hosts ORDER BY displayName COLLATE NOCASE")
    fun observeHosts(): Flow<List<HostEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertHosts(hosts: List<HostEntity>)

    @Query("DELETE FROM hosts WHERE hostId NOT IN (:hostIds)")
    suspend fun deleteHostsNotIn(hostIds: List<String>)

    @Query("DELETE FROM hosts")
    suspend fun deleteAllHosts()

    @Query("SELECT * FROM scopes ORDER BY hostId, scopeId")
    fun observeScopes(): Flow<List<ScopeEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertScopes(scopes: List<ScopeEntity>)

    @Query("DELETE FROM scopes WHERE hostId = :hostId")
    suspend fun deleteScopesForHost(hostId: String)

    @Query("DELETE FROM scopes WHERE hostId NOT IN (:hostIds)")
    suspend fun deleteScopesForHostsNotIn(hostIds: List<String>)

    @Query("DELETE FROM scopes")
    suspend fun deleteAllScopes()

    @Query("SELECT * FROM sessions ORDER BY activityAtSeconds DESC, name COLLATE NOCASE")
    fun observeSessions(): Flow<List<SessionEntity>>

    @Query("SELECT * FROM sessions WHERE hostId = :hostId AND name = :name LIMIT 1")
    suspend fun findSession(hostId: String, name: String): SessionEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertSessions(sessions: List<SessionEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertSession(session: SessionEntity)

    @Query("DELETE FROM sessions WHERE hostId = :hostId")
    suspend fun deleteSessionsForHost(hostId: String)

    @Query("DELETE FROM sessions WHERE hostId NOT IN (:hostIds)")
    suspend fun deleteSessionsForHostsNotIn(hostIds: List<String>)

    @Query("DELETE FROM sessions")
    suspend fun deleteAllSessions()

    @Query("DELETE FROM sessions WHERE hostId = :hostId AND name = :name")
    suspend fun deleteSession(hostId: String, name: String)

    @Query("SELECT * FROM outbox ORDER BY createdAtMillis")
    fun observeOutbox(): Flow<List<OutboxEntity>>

    @Query("SELECT * FROM outbox WHERE state IN (:states) AND expiresAtMillis > :nowMillis ORDER BY createdAtMillis")
    suspend fun pendingOutbox(states: List<String>, nowMillis: Long): List<OutboxEntity>

    @Query("SELECT * FROM outbox WHERE commandId = :commandId LIMIT 1")
    suspend fun findOutbox(commandId: String): OutboxEntity?

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertOutbox(item: OutboxEntity)

    @Query(
        "UPDATE outbox SET state = :state, attemptCount = :attemptCount, lastError = :lastError " +
            "WHERE commandId = :commandId",
    )
    suspend fun updateOutboxState(
        commandId: String,
        state: String,
        attemptCount: Int,
        lastError: String,
    ): Int

    @Query(
        "UPDATE outbox SET state = 'EXPIRED' WHERE expiresAtMillis <= :nowMillis " +
            "AND state IN ('QUEUED', 'SENDING', 'ACCEPTED', 'CONFIRMING', " +
            "'FAILED_RETRYABLE', 'AMBIGUOUS')",
    )
    suspend fun expireOutbox(nowMillis: Long): Int

    @Query(
        "UPDATE timeline SET deliveryState = 'EXPIRED' " +
            "WHERE eventId IN (" +
            "SELECT 'outbox-' || commandId FROM outbox " +
            "WHERE expiresAtMillis <= :nowMillis " +
            "AND state IN ('QUEUED', 'SENDING', 'ACCEPTED', 'CONFIRMING', " +
            "'FAILED_RETRYABLE', 'AMBIGUOUS')" +
            ")",
    )
    suspend fun expireOutboxTimeline(nowMillis: Long): Int

    @Query("DELETE FROM outbox WHERE commandId = :commandId AND state = 'QUEUED'")
    suspend fun cancelQueuedOutbox(commandId: String): Int

    @Query("SELECT * FROM timeline WHERE sessionId = :sessionId ORDER BY createdAtMillis, eventId")
    fun observeTimeline(sessionId: String): Flow<List<TimelineEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTimeline(event: TimelineEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTimeline(events: List<TimelineEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertStreamCheckpoint(checkpoint: StreamCheckpointEntity)

    @Query("SELECT * FROM stream_checkpoints WHERE streamId = :streamId LIMIT 1")
    suspend fun findStreamCheckpoint(streamId: String): StreamCheckpointEntity?

    @Query("DELETE FROM stream_checkpoints WHERE updatedAtMillis < :cutoffMillis")
    suspend fun deleteOldStreamCheckpoints(cutoffMillis: Long): Int
}
