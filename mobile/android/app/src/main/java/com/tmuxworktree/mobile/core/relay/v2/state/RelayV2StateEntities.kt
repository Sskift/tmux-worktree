package com.tmuxworktree.mobile.core.relay.v2.state

import androidx.room.Entity
import androidx.room.Index

@Entity(
    tableName = "relay_v2_authority",
    primaryKeys = ["profileId", "hostId", "hostEpoch"],
    indices = [Index(value = ["profileId", "hostId"], unique = true)],
)
internal data class RelayV2AuthorityEntity(
    val profileId: String,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val cursorEventSeq: String?,
    val requiredThroughEventSeq: String,
    val scopesRevision: String?,
    val phase: String,
    val cacheRecordCount: Long,
    val cacheCanonicalBytes: Long,
)

@Entity(
    tableName = "relay_v2_scopes",
    primaryKeys = ["profileId", "hostId", "hostEpoch", "scopeId"],
    indices = [Index(value = ["profileId", "hostId", "hostEpoch"])],
)
internal data class RelayV2ScopeEntity(
    val profileId: String,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val displayName: String,
    val kind: String,
    val reachability: String,
    val sessionsRevision: String,
    val scopeRecordCanonicalJson: String,
    val sessionsScopeRecordCanonicalJson: String,
)

@Entity(
    tableName = "relay_v2_sessions",
    primaryKeys = ["profileId", "hostId", "hostEpoch", "scopeId", "sessionId"],
    indices = [
        Index(value = ["profileId", "hostId", "hostEpoch"]),
        Index(value = ["profileId", "hostId", "hostEpoch", "scopeId"]),
    ],
)
internal data class RelayV2SessionEntity(
    val profileId: String,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val kind: String,
    val displayName: String,
    val project: String?,
    val label: String?,
    val cwd: String?,
    val attached: Boolean,
    val windowCount: Long,
    val createdAtMs: Long,
    val activityAtMs: Long,
    val recordCanonicalJson: String,
)

@Entity(
    tableName = "relay_v2_snapshot_staging",
    primaryKeys = ["profileId", "hostId", "hostEpoch", "snapshotId"],
    indices = [Index(value = ["profileId", "hostId", "hostEpoch"], unique = true)],
)
internal data class RelayV2SnapshotStagingEntity(
    val profileId: String,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val snapshotRequestId: String,
    val snapshotId: String,
    val snapshotCreatedAtMs: Long,
    val snapshotLeaseExpiresAtMs: Long,
    val snapshotAbsoluteExpiresAtMs: Long,
    val throughEventSeq: String,
    val scopesRevision: String,
    val totalRecords: Long,
    val totalCanonicalBytes: Long,
    val cutDigest: String,
    val nextChunkIndex: Long,
    val nextCursor: String?,
    val receivedRecords: Long,
    val receivedRecordCanonicalBytes: Long,
    val receivedRawUtf8Bytes: Long,
    val lastScopeId: String?,
    val lastRecordKind: String?,
    val lastSessionId: String?,
    val complete: Boolean,
)

@Entity(
    tableName = "relay_v2_snapshot_records",
    primaryKeys = ["profileId", "hostId", "hostEpoch", "snapshotId", "recordIndex"],
    indices = [
        Index(value = ["profileId", "hostId", "hostEpoch", "snapshotId", "chunkIndex"]),
        Index(value = ["profileId", "hostId", "hostEpoch", "snapshotId", "scopeId", "recordType"]),
        Index(value = ["profileId", "hostId", "hostEpoch", "snapshotId", "scopeId", "sessionId"]),
    ],
)
internal data class RelayV2SnapshotRecordEntity(
    val profileId: String,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val snapshotId: String,
    val recordIndex: Long,
    val chunkIndex: Long,
    val recordType: String,
    val scopeId: String,
    val sessionId: String?,
    val revision: String?,
    val displayName: String?,
    val kind: String?,
    val reachability: String?,
    val project: String?,
    val label: String?,
    val cwd: String?,
    val attached: Boolean?,
    val windowCount: Long?,
    val createdAtMs: Long?,
    val activityAtMs: Long?,
    val canonicalJson: String,
)

@Entity(
    tableName = "relay_v2_state_event_buffer",
    primaryKeys = ["profileId", "hostId", "hostEpoch", "eventSeq"],
    indices = [
        Index(value = ["profileId", "hostId", "hostEpoch", "eventSeqOrder"]),
    ],
)
internal data class RelayV2StateEventEntity(
    val profileId: String,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val eventSeq: String,
    val eventSeqOrder: String,
    val resultingRevision: String,
    val changeType: String,
    val scopeId: String,
    val sessionId: String?,
    val displayName: String?,
    val kind: String?,
    val reachability: String?,
    val project: String?,
    val label: String?,
    val cwd: String?,
    val attached: Boolean?,
    val windowCount: Long?,
    val createdAtMs: Long?,
    val activityAtMs: Long?,
    val rawUtf8Bytes: Int,
    val canonicalJson: String,
)
