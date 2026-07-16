package com.tmuxworktree.mobile.core.relay.v2.state

import androidx.room.Entity
import androidx.room.Index

@Entity(
    tableName = "relay_v2_authority",
    primaryKeys = ["profileId", "principalId", "clientInstanceId", "hostId", "hostEpoch"],
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
    val pendingReleaseSnapshotRequestId: String? = null,
    val pendingReleaseSnapshotId: String? = null,
    val pendingReleaseCursorEventSeq: String? = null,
    val pendingReleaseReason: String? = null,
    val pendingReleasePhase: String? = null,
)

@Entity(
    tableName = "relay_v2_scopes",
    primaryKeys = [
        "profileId",
        "principalId",
        "clientInstanceId",
        "hostId",
        "hostEpoch",
        "scopeId",
    ],
    indices = [
        Index(value = ["profileId", "principalId", "clientInstanceId", "hostId", "hostEpoch"]),
    ],
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
    primaryKeys = [
        "profileId",
        "principalId",
        "clientInstanceId",
        "hostId",
        "hostEpoch",
        "scopeId",
        "sessionId",
    ],
    indices = [
        Index(value = ["profileId", "principalId", "clientInstanceId", "hostId", "hostEpoch"]),
        Index(
            value = [
                "profileId",
                "principalId",
                "clientInstanceId",
                "hostId",
                "hostEpoch",
                "scopeId",
            ],
        ),
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
    primaryKeys = [
        "profileId",
        "principalId",
        "clientInstanceId",
        "hostId",
        "hostEpoch",
        "snapshotId",
    ],
    indices = [
        Index(
            value = ["profileId", "principalId", "clientInstanceId", "hostId", "hostEpoch"],
            unique = true,
        ),
    ],
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
    primaryKeys = [
        "profileId",
        "principalId",
        "clientInstanceId",
        "hostId",
        "hostEpoch",
        "snapshotId",
        "recordIndex",
    ],
    indices = [
        Index(
            value = [
                "profileId",
                "principalId",
                "clientInstanceId",
                "hostId",
                "hostEpoch",
                "snapshotId",
                "chunkIndex",
            ],
        ),
        Index(
            value = [
                "profileId",
                "principalId",
                "clientInstanceId",
                "hostId",
                "hostEpoch",
                "snapshotId",
                "scopeId",
                "recordType",
            ],
        ),
        Index(
            value = [
                "profileId",
                "principalId",
                "clientInstanceId",
                "hostId",
                "hostEpoch",
                "snapshotId",
                "scopeId",
                "sessionId",
            ],
        ),
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
    primaryKeys = [
        "profileId",
        "principalId",
        "clientInstanceId",
        "hostId",
        "hostEpoch",
        "eventSeq",
    ],
    indices = [
        Index(
            value = [
                "profileId",
                "principalId",
                "clientInstanceId",
                "hostId",
                "hostEpoch",
                "eventSeqOrder",
            ],
        ),
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

/**
 * One Outbox authority cursor for an isolated Relay v2 profile activation and principal.
 *
 * The canonical payload repeats the explicit columns and is digest protected. Entry content lives
 * in [RelayV2OutboxEntryEntity]; the repository updates both tables in one transaction.
 */
@Entity(
    tableName = "relay_v2_outbox_meta",
    primaryKeys = [
        "profileId",
        "profileActivationGeneration",
        "principalId",
        "clientInstanceId",
    ],
)
internal data class RelayV2OutboxMetaEntity(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val nextCreationOrder: Long,
    val codecVersion: Int,
    val payloadUtf8Bytes: Int,
    val payloadCanonicalJson: String,
    val payloadSha256: String,
)

/** One durable Outbox entry inside an exact activation/principal authority namespace. */
@Entity(
    tableName = "relay_v2_outbox_entries",
    primaryKeys = [
        "profileId",
        "profileActivationGeneration",
        "principalId",
        "clientInstanceId",
        "hostId",
        "expectedHostEpoch",
        "commandId",
    ],
    indices = [
        Index(
            value = [
                "profileId",
                "profileActivationGeneration",
                "principalId",
                "clientInstanceId",
                "createdOrder",
            ],
            unique = true,
        ),
    ],
)
internal data class RelayV2OutboxEntryEntity(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val expectedHostEpoch: String,
    val commandId: String,
    val createdOrder: Long,
    val codecVersion: Int,
    val payloadUtf8Bytes: Int,
    val payloadCanonicalJson: String,
    val payloadSha256: String,
)

/**
 * One atomically replaced terminal checkpoint union for an exact profile activation and target.
 *
 * Host process/generation lineage stays inside the versioned payload because an explicit reset may
 * replace it while retaining the same stable target. Access, refresh, enrollment, and resume token
 * values are never columns or payload fields.
 */
@Entity(
    tableName = "relay_v2_terminal_checkpoints",
    primaryKeys = [
        "profileId",
        "profileActivationGeneration",
        "principalId",
        "clientInstanceId",
        "hostId",
        "hostEpoch",
        "scopeId",
        "sessionId",
        "streamId",
        "pane",
    ],
)
internal data class RelayV2TerminalCheckpointEntity(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val streamId: String,
    val pane: Int,
    val checkpointKind: String,
    val codecVersion: Int,
    val payloadUtf8Bytes: Int,
    val payloadCanonicalJson: String,
    val payloadSha256: String,
)
