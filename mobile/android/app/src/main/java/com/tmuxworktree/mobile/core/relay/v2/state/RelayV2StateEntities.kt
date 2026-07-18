package com.tmuxworktree.mobile.core.relay.v2.state

import androidx.room.Entity
import androidx.room.ForeignKey
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

/**
 * One durable optional Agent transcript/lifecycle consumer state.
 *
 * The primary key carries the complete profile activation, authenticated client, host, opaque
 * Session, and timeline lineage. [timelineEpochKey] is the empty string only when the reducer has
 * no current timeline; public timeline IDs themselves cannot be empty. The unique consumer index
 * prevents two current lineages from being selected for one consumer slot.
 */
@Entity(
    tableName = "relay_v2_agent_transcript_lifecycle_states",
    primaryKeys = [
        "profileId",
        "profileActivationGeneration",
        "principalId",
        "clientInstanceId",
        "hostId",
        "hostEpoch",
        "scopeId",
        "sessionId",
        "timelineEpochKey",
    ],
    indices = [
        Index(
            value = [
                "profileId",
                "profileActivationGeneration",
                "principalId",
                "clientInstanceId",
                "hostId",
                "hostEpoch",
                "scopeId",
                "sessionId",
            ],
            unique = true,
        ),
    ],
)
internal data class RelayV2AgentTranscriptLifecycleStateEntity(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val timelineEpochKey: String,
    val codecVersion: Int,
    val payloadUtf8Bytes: Int,
    val payloadCanonicalJson: String,
    val payloadSha256: String,
)

/** Immutable one-shot notification claim; it contains identities and evidence, never body text. */
@Entity(
    tableName = "relay_v2_agent_transcript_lifecycle_notification_claims",
    primaryKeys = [
        "profileId",
        "profileActivationGeneration",
        "principalId",
        "clientInstanceId",
        "hostId",
        "hostEpoch",
        "scopeId",
        "sessionId",
        "timelineEpoch",
        "lifecycleEventId",
    ],
)
internal data class RelayV2AgentTranscriptLifecycleNotificationClaimEntity(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val timelineEpoch: String,
    val lifecycleEventId: String,
    val lifecycleState: String,
    val claimedLocalGeneration: String,
    val codecVersion: Int,
    val payloadUtf8Bytes: Int,
    val payloadCanonicalJson: String,
    val payloadSha256: String,
)

/**
 * One materialized Agent text entry or retained anti-revival tombstone.
 *
 * Room 2.8.4 cannot express a table CHECK for the closed visible/redacted/deleted union. The
 * nullable columns and discriminator are frozen here; the future typed repository adapter must
 * validate the union in the same transaction before using the INSERT-ABORT DAO primitive. A
 * snapshot-absence tombstone is local anti-revival evidence at the frozen snapshot watermark; it
 * is never represented as a synthetic wire delete mutation.
 */
@Entity(
    tableName = "relay_v2_agent_transcript_entries",
    primaryKeys = [
        "profileId",
        "profileActivationGeneration",
        "principalId",
        "clientInstanceId",
        "hostId",
        "hostEpoch",
        "scopeId",
        "sessionId",
        "timelineEpoch",
        "entryId",
    ],
    indices = [
        Index(
            name = "index_agent_transcript_entries_namespace_created_seq",
            value = [
                "profileId",
                "profileActivationGeneration",
                "principalId",
                "clientInstanceId",
                "hostId",
                "hostEpoch",
                "scopeId",
                "sessionId",
                "timelineEpoch",
                "createdAgentSeq",
            ],
            unique = true,
        ),
        Index(
            name = "index_agent_transcript_entries_namespace_created_order",
            value = [
                "profileId",
                "profileActivationGeneration",
                "principalId",
                "clientInstanceId",
                "hostId",
                "hostEpoch",
                "scopeId",
                "sessionId",
                "timelineEpoch",
                "createdAgentSeqOrder",
            ],
        ),
        Index(
            name = "index_agent_transcript_entries_namespace_last_modified_order",
            value = [
                "profileId",
                "profileActivationGeneration",
                "principalId",
                "clientInstanceId",
                "hostId",
                "hostEpoch",
                "scopeId",
                "sessionId",
                "timelineEpoch",
                "lastModifiedAgentSeqOrder",
                "entryId",
            ],
        ),
    ],
)
internal data class RelayV2AgentTranscriptEntryEntity(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val timelineEpoch: String,
    val entryId: String,
    val runId: String,
    val turnId: String,
    val role: String,
    val commandId: String?,
    val createdAtMs: Long,
    val createdAgentSeq: String,
    val createdAgentSeqOrder: String,
    val lastModifiedAgentSeq: String,
    val lastModifiedAgentSeqOrder: String,
    val entryState: String,
    val text: String?,
    val redactionReason: String?,
    val tombstoneOrigin: String?,
    val tombstoneEvidenceThroughAgentSeq: String?,
    val tombstoneEvidenceThroughAgentSeqOrder: String?,
    val payloadCanonicalJson: String,
    val payloadUtf8Bytes: Int,
    val payloadSha256: String,
)

/** One active pinned Agent snapshot header for an exact consumer timeline. */
@Entity(
    tableName = "relay_v2_agent_transcript_snapshot_staging",
    primaryKeys = [
        "profileId",
        "profileActivationGeneration",
        "principalId",
        "clientInstanceId",
        "hostId",
        "hostEpoch",
        "scopeId",
        "sessionId",
        "timelineEpoch",
        "snapshotId",
    ],
    indices = [
        Index(
            name = "index_agent_transcript_snapshot_staging_active_namespace",
            value = [
                "profileId",
                "profileActivationGeneration",
                "principalId",
                "clientInstanceId",
                "hostId",
                "hostEpoch",
                "scopeId",
                "sessionId",
                "timelineEpoch",
            ],
            unique = true,
        ),
    ],
)
internal data class RelayV2AgentTranscriptSnapshotStagingEntity(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val timelineEpoch: String,
    val snapshotRequestId: String,
    val requestLocalGeneration: String,
    val requestNetworkToken: String,
    val snapshotId: String,
    val nextPageIndex: Long,
    val nextCursor: String?,
    val throughAgentSeq: String,
    val throughAgentSeqOrder: String,
    val earliestRetainedSeq: String,
    val earliestRetainedSeqOrder: String,
    val receivedRecordCount: Long,
    val receivedCanonicalBytes: Long,
    val receivedRawUtf8Bytes: Long,
    val lastAgentSeq: String?,
    val lastAgentSeqOrder: String?,
    val lastRecordKind: String?,
    val lastStableIdentity: String?,
    val complete: Boolean,
)

/** One bounded canonical record belonging to one exact pinned Agent snapshot header. */
@Entity(
    tableName = "relay_v2_agent_transcript_snapshot_records",
    primaryKeys = [
        "profileId",
        "profileActivationGeneration",
        "principalId",
        "clientInstanceId",
        "hostId",
        "hostEpoch",
        "scopeId",
        "sessionId",
        "timelineEpoch",
        "snapshotId",
        "recordIndex",
    ],
    foreignKeys = [
        ForeignKey(
            entity = RelayV2AgentTranscriptSnapshotStagingEntity::class,
            parentColumns = [
                "profileId",
                "profileActivationGeneration",
                "principalId",
                "clientInstanceId",
                "hostId",
                "hostEpoch",
                "scopeId",
                "sessionId",
                "timelineEpoch",
                "snapshotId",
            ],
            childColumns = [
                "profileId",
                "profileActivationGeneration",
                "principalId",
                "clientInstanceId",
                "hostId",
                "hostEpoch",
                "scopeId",
                "sessionId",
                "timelineEpoch",
                "snapshotId",
            ],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [
        Index(
            name = "index_agent_transcript_snapshot_records_header",
            value = [
                "profileId",
                "profileActivationGeneration",
                "principalId",
                "clientInstanceId",
                "hostId",
                "hostEpoch",
                "scopeId",
                "sessionId",
                "timelineEpoch",
                "snapshotId",
            ],
        ),
        Index(
            name = "index_agent_transcript_snapshot_records_stable",
            value = [
                "profileId",
                "profileActivationGeneration",
                "principalId",
                "clientInstanceId",
                "hostId",
                "hostEpoch",
                "scopeId",
                "sessionId",
                "timelineEpoch",
                "snapshotId",
                "recordKind",
                "stableIdentity",
            ],
            unique = true,
        ),
        Index(
            name = "index_agent_transcript_snapshot_records_order",
            value = [
                "profileId",
                "profileActivationGeneration",
                "principalId",
                "clientInstanceId",
                "hostId",
                "hostEpoch",
                "scopeId",
                "sessionId",
                "timelineEpoch",
                "snapshotId",
                "agentEventSeqOrder",
                "stableIdentity",
            ],
            unique = true,
        ),
    ],
)
internal data class RelayV2AgentTranscriptSnapshotRecordEntity(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val timelineEpoch: String,
    val snapshotId: String,
    val pageIndex: Long,
    val recordIndex: Long,
    val recordKind: String,
    val stableIdentity: String,
    val agentEventSeq: String,
    val agentEventSeqOrder: String,
    val payloadCanonicalJson: String,
    val payloadRawUtf8Bytes: Int,
    val payloadSha256: String,
)

/**
 * One closed LIVE event retained durably while snapshot/gap handling blocks cursor advancement.
 *
 * REPLAY pages are not staged here; the future consumer applies them sequentially in its own
 * transaction. The future typed adapter must accept only verified closed-LIVE provenance before
 * using the INSERT-ABORT primitive.
 */
@Entity(
    tableName = "relay_v2_agent_transcript_pending_events",
    primaryKeys = [
        "profileId",
        "profileActivationGeneration",
        "principalId",
        "clientInstanceId",
        "hostId",
        "hostEpoch",
        "scopeId",
        "sessionId",
        "timelineEpoch",
        "agentEventSeq",
    ],
    indices = [
        Index(
            name = "index_agent_transcript_pending_events_event_id",
            value = [
                "profileId",
                "profileActivationGeneration",
                "principalId",
                "clientInstanceId",
                "hostId",
                "hostEpoch",
                "scopeId",
                "sessionId",
                "timelineEpoch",
                "eventId",
            ],
            unique = true,
        ),
        Index(
            name = "index_agent_transcript_pending_events_order",
            value = [
                "profileId",
                "profileActivationGeneration",
                "principalId",
                "clientInstanceId",
                "hostId",
                "hostEpoch",
                "scopeId",
                "sessionId",
                "timelineEpoch",
                "agentEventSeqOrder",
            ],
        ),
    ],
)
internal data class RelayV2AgentTranscriptPendingEventEntity(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val timelineEpoch: String,
    val agentEventSeq: String,
    val agentEventSeqOrder: String,
    val eventId: String,
    val closedEventDigest: String,
    val trustedProvenance: String,
    val eventCanonicalJson: String,
    val eventRawUtf8Bytes: Int,
)
