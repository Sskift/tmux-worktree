package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2DecodedMessage
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2FrameMetadata
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialSecretValidator
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import java.math.BigInteger
import java.security.MessageDigest
import java.util.Base64

internal data class RelayV2ResumeCursor(
    val hostEpoch: String,
    val lastEventSeq: String,
) {
    init {
        require(hostEpoch.isNotBlank()) { "Host epoch is required" }
        require(hostEpoch.toByteArray(Charsets.UTF_8).size <= 128) { "Host epoch is too long" }
        require(COUNTER_PATTERN.matches(lastEventSeq)) { "Event sequence is not canonical" }
        require(BigInteger(lastEventSeq) <= UNSIGNED_COUNTER_MAX) { "Event sequence is too large" }
    }

    private companion object {
        val COUNTER_PATTERN = Regex("^(?:0|[1-9][0-9]*)$")
        val UNSIGNED_COUNTER_MAX = BigInteger("18446744073709551615")
    }
}

internal enum class RelayV2ConnectRecovery {
    EMPTY,
    LIVE,
    RESYNCING,
    RELEASE_PENDING,
}

internal data class RelayV2ConnectPlan(
    val profileId: String,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val requestedResume: RelayV2ResumeCursor?,
    val recovery: RelayV2ConnectRecovery,
    val durableHostEpoch: String?,
    val requiredThroughEventSeq: String?,
    val snapshotRequestId: String? = null,
    val snapshotId: String? = null,
    val snapshotNextCursor: String? = null,
    val snapshotNextChunkIndex: Long? = null,
    val snapshotComplete: Boolean? = null,
    val releaseObligationToken: String? = null,
) {
    fun requireMatches(profile: RelayV2Profile) {
        require(profileId == profile.profileId)
        require(principalId == profile.principalId)
        require(clientInstanceId == profile.clientInstanceId)
        require(hostId == profile.hostId)
        requiredThroughEventSeq?.let { requireRelayV2RuntimeCounter(it, "Required event sequence") }
        durableHostEpoch?.let { requireRelayV2RuntimeId(it, "Durable host epoch") }
        when (recovery) {
            RelayV2ConnectRecovery.EMPTY -> require(
                requestedResume == null && durableHostEpoch == null &&
                    requiredThroughEventSeq == null && snapshotRequestId == null &&
                    releaseObligationToken == null,
            )
            RelayV2ConnectRecovery.LIVE -> require(
                requestedResume != null && durableHostEpoch == requestedResume.hostEpoch &&
                    requiredThroughEventSeq != null && snapshotRequestId == null &&
                    releaseObligationToken == null,
            )
            RelayV2ConnectRecovery.RESYNCING -> require(
                durableHostEpoch != null && requiredThroughEventSeq != null &&
                    releaseObligationToken == null,
            )
            RelayV2ConnectRecovery.RELEASE_PENDING -> require(
                durableHostEpoch != null && requiredThroughEventSeq != null &&
                    releaseObligationToken != null && snapshotRequestId == null,
            )
        }
        require(requestedResume == null || requestedResume.hostEpoch == durableHostEpoch)
        val hasSnapshot = snapshotRequestId != null
        require((snapshotId != null) == hasSnapshot)
        require((snapshotNextChunkIndex != null) == hasSnapshot)
        require((snapshotComplete != null) == hasSnapshot)
        require(!hasSnapshot || recovery == RelayV2ConnectRecovery.RESYNCING)
        require(!hasSnapshot || requireNotNull(snapshotNextChunkIndex) > 0)
        require(!hasSnapshot || (snapshotComplete == true) == (snapshotNextCursor == null))
        require(snapshotNextCursor == null || snapshotNextCursor.isNotEmpty())
        require(hasSnapshot || snapshotNextCursor == null)
    }
}

internal fun interface RelayV2ConnectPlanSource {
    suspend fun load(profile: RelayV2Profile): RelayV2ConnectPlan
}

internal enum class RelayV2ConnectionPhase {
    STOPPED,
    CONNECTING,
    AWAITING_RELAY_WELCOME,
    AWAITING_HOST_WELCOME,
    QUERYING,
    RESYNCING,
    ONLINE,
    CONTINUITY_REJECTED,
    FAILED,
    DISCONNECTED,
    CLOSED,
}

internal enum class RelayV2FailureKind {
    CONFIGURATION,
    SECURITY,
    AUTH,
    DIALECT,
    SCHEMA,
    CAPABILITY,
    TRANSPORT,
    ROUTE,
    QUEUE_SATURATED,
}

internal data class RelayV2ConnectionFailure(
    val kind: RelayV2FailureKind,
    val code: String,
    val retryable: Boolean,
)

internal data class RelayV2ConnectionState(
    val phase: RelayV2ConnectionPhase = RelayV2ConnectionPhase.STOPPED,
    val profileId: String? = null,
    val activationGeneration: Long? = null,
    val connectionGeneration: Long = 0,
    val changedAtMs: Long = 0,
    val failure: RelayV2ConnectionFailure? = null,
) {
    /**
     * Non-atomic generation prefilter only. This deliberately has no phase authority: for example,
     * a current [RelayV2RuntimeEffect.RejectContinuity] remains eligible in CONTINUITY_REJECTED.
     * A true result never authorizes repository or Room mutation; consumers must commit inside
     * [RelayV2ConnectionActor.withEffectApplyLease].
     */
    fun matchesGeneration(generation: RelayV2EffectGeneration): Boolean =
        profileId == generation.profileId &&
            activationGeneration == generation.profileGeneration &&
            connectionGeneration == generation.connectionGeneration
}

/**
 * Identity fence for repository-visible effects.
 *
 * Profile activation and socket generations are deliberately independent: a reconnect must fence
 * callbacks from its prior socket, while a profile switch must also fence work from the prior
 * credential/cache namespace.
 */
internal data class RelayV2EffectGeneration(
    val profileId: String,
    val profileGeneration: Long,
    val connectionGeneration: Long,
)

/** Result of entering the actor-owned repository apply gate. */
internal sealed interface RelayV2EffectApplyResult<out T> {
    data class Applied<T>(val value: T) : RelayV2EffectApplyResult<T>
    data object Stale : RelayV2EffectApplyResult<Nothing>
}

internal enum class RelayV2HelloOutcome {
    FRESH,
    MATCHED,
    CURSOR_BEHIND,
    HOST_EPOCH_CHANGED,
    EVENT_CURSOR_AHEAD,
}

internal data class RelayV2CommandDedupeWindow(
    val windowId: String,
    val windowSeq: String,
    val acceptUntilMs: Long,
    val queryUntilMs: Long,
)

/** Frozen first-slice limits after taking the safe client/broker/host intersection. */
internal data class RelayV2NegotiatedLimits(
    val maxPublicFrameBytes: Long,
    val maxCarrierFrameBytes: Long,
    val routeBufferedBytesPerDirection: Long,
    val routeLowWaterBytesPerDirection: Long,
    val maxQueuedRouteFrames: Long,
    val maxInFlightRequestsPerRoute: Long,
    val maxCommandQueryIds: Long,
    val stateSnapshotChunkBytes: Long,
    val stateSnapshotChunkRecords: Long,
    val stateSnapshotMaxBytes: Long,
    val stateSnapshotMaxRecords: Long,
    val terminalReplayBytesPerStream: Long,
    val terminalReplayBytesPerHost: Long,
    val terminalMaxUnackedBytes: Long,
    val terminalMaxFrameBytes: Long,
    val frozenHostLimits: Map<String, Long>,
)

internal data class RelayV2HandshakeContext(
    val profile: RelayActiveProfileIdentity,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val brokerEpoch: String,
    val hostEpoch: String,
    val hostInstanceId: String,
    val eventSeq: String,
    val negotiatedCapabilities: Set<String>,
    val negotiatedLimits: RelayV2NegotiatedLimits,
    val commandDedupeWindow: RelayV2CommandDedupeWindow,
) {
    init {
        requireRelayV2RuntimeId(principalId, "Principal ID")
        requireRelayV2RuntimeId(clientInstanceId, "Client instance ID")
        require(profile.activationGeneration > 0) { "Profile activation must be positive" }
    }
}

/** Exact namespace authority frozen by the actor for one repository-visible effect. */
internal data class RelayV2RepositoryEffectAuthority(
    val generation: RelayV2EffectGeneration,
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
) {
    init {
        require(profileId == generation.profileId)
        require(profileActivationGeneration == generation.profileGeneration)
        requireRelayV2RuntimeId(principalId, "Principal ID")
        requireRelayV2RuntimeId(clientInstanceId, "Client instance ID")
        requireRelayV2RuntimeId(hostId, "Host ID")
        requireRelayV2RuntimeId(hostEpoch, "Host epoch")
    }
}

internal fun RelayV2HandshakeContext.repositoryEffectAuthority(
    generation: RelayV2EffectGeneration,
): RelayV2RepositoryEffectAuthority = RelayV2RepositoryEffectAuthority(
    generation = generation,
    profileId = profile.profileId,
    profileActivationGeneration = profile.activationGeneration,
    principalId = principalId,
    clientInstanceId = clientInstanceId,
    hostId = hostId,
    hostEpoch = hostEpoch,
)

/** Exact actor-owned recovery step that a durable repository receipt must acknowledge. */
internal data class RelayV2RecoveryBinding(
    val generation: RelayV2EffectGeneration,
    val step: Long,
    val requestId: String,
) {
    init {
        require(step > 0) { "Recovery step must be positive" }
        requireRelayV2RuntimeId(requestId, "Recovery request ID")
    }
}

/** Stable actor lineage for one bounded command-query readiness window. */
internal data class RelayV2QueryRecoveryLineage(
    val generation: RelayV2EffectGeneration,
    val recoveryId: String,
) {
    init {
        requireRelayV2RuntimeId(recoveryId, "Query recovery ID")
    }
}

internal data class RelayV2PendingCommand(
    val commandId: String,
    val dedupeWindowId: String,
) {
    init {
        requireRelayV2RuntimeId(commandId, "Command ID")
        requireRelayV2RuntimeId(dedupeWindowId, "Dedupe window ID")
    }
}

/** Durable continuation proof for a pinned snapshot that survived a prior route. */
internal data class RelayV2SnapshotContinuation(
    val snapshotRequestId: String,
    val snapshotId: String,
    val cursor: String,
    val nextChunkIndex: Long,
) {
    init {
        requireRelayV2RuntimeId(snapshotRequestId, "Snapshot request ID")
        requireRelayV2RuntimeId(snapshotId, "Snapshot ID")
        require(cursor.isNotEmpty()) { "Snapshot cursor is required" }
        require(cursor.toByteArray(Charsets.UTF_8).size <= 1_024) {
            "Snapshot cursor is too long"
        }
        require(nextChunkIndex > 0) { "Snapshot continuation index must be positive" }
    }
}

/** Exact pinned cut that durable state-sync has discarded and the actor must release. */
@ConsistentCopyVisibility
internal data class RelayV2RecoveryReleaseDirective private constructor(
    val profileId: String,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val snapshotRequestId: String,
    val snapshotId: String,
    val durableCursorEventSeq: String?,
    val durableReason: RelayV2RecoveryDurableReleaseReason,
) {
    init {
        requireRelayV2RuntimeId(profileId, "Release profile ID")
        requireRelayV2RuntimeId(principalId, "Release principal ID")
        requireRelayV2RuntimeId(clientInstanceId, "Release client instance ID")
        requireRelayV2RuntimeId(hostId, "Release host ID")
        requireRelayV2RuntimeId(hostEpoch, "Release host epoch")
        requireRelayV2RuntimeId(snapshotRequestId, "Snapshot request ID")
        requireRelayV2RuntimeId(snapshotId, "Snapshot ID")
        durableCursorEventSeq?.let {
            requireRelayV2RuntimeCounter(it, "Release durable cursor")
        }
    }

    val reason: RelayV2RecoveryReleaseReason
        get() = if (durableReason == RelayV2RecoveryDurableReleaseReason.COMPLETED) {
            RelayV2RecoveryReleaseReason.COMPLETED
        } else {
            RelayV2RecoveryReleaseReason.ABANDONED
        }

    val obligationToken: String
        get() = releaseObligationToken(
            profileId,
            principalId,
            clientInstanceId,
            hostId,
            hostEpoch,
            snapshotRequestId,
            snapshotId,
            durableCursorEventSeq,
            durableReason,
        )

    companion object {
        fun fromDurable(
            profileId: String,
            principalId: String,
            clientInstanceId: String,
            hostId: String,
            hostEpoch: String,
            snapshotRequestId: String,
            snapshotId: String,
            durableCursorEventSeq: String?,
            durableReason: RelayV2RecoveryDurableReleaseReason,
        ): RelayV2RecoveryReleaseDirective = RelayV2RecoveryReleaseDirective(
            profileId,
            principalId,
            clientInstanceId,
            hostId,
            hostEpoch,
            snapshotRequestId,
            snapshotId,
            durableCursorEventSeq,
            durableReason,
        )

    }
}

internal enum class RelayV2RecoveryDurableReleaseReason {
    COMPLETED,
    SNAPSHOT_RESTART_REQUIRED,
    SNAPSHOT_IDENTITY_CONFLICT,
    SNAPSHOT_ORDER_CONFLICT,
    SNAPSHOT_LIMIT_EXCEEDED,
    SNAPSHOT_INCOMPLETE,
    SNAPSHOT_COUNT_MISMATCH,
    SNAPSHOT_DIGEST_MISMATCH,
    EVENT_GAP,
    EVENT_REVISION_CONFLICT,
    EVENT_BUFFER_OVERFLOW,
    FRESH,
}

private fun releaseObligationToken(
    profileId: String,
    principalId: String,
    clientInstanceId: String,
    hostId: String,
    hostEpoch: String,
    snapshotRequestId: String,
    snapshotId: String,
    durableCursorEventSeq: String?,
    durableReason: RelayV2RecoveryDurableReleaseReason,
): String {
    val identity = listOf(
        profileId,
        principalId,
        clientInstanceId,
        hostId,
        hostEpoch,
        snapshotRequestId,
        snapshotId,
        durableCursorEventSeq ?: "",
        durableReason.name,
    ).joinToString("\u0000")
    return Base64.getUrlEncoder().withoutPadding().encodeToString(
        MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(Charsets.UTF_8)),
    )
}

internal enum class RelayV2RecoveryReleaseReason(val wireValue: String) {
    COMPLETED("completed"),
    ABANDONED("abandoned"),
}

internal enum class RelayV2ReleaseAuthorityProof {
    RELEASED,
    ALREADY_RELEASED,
    SNAPSHOT_EXPIRED,
}

/** Durable repository reasons that invalidate the current recovery attempt. */
internal enum class RelayV2RecoveryAbandonReason {
    SNAPSHOT_RESTART_REQUIRED,
    SNAPSHOT_IDENTITY_CONFLICT,
    SNAPSHOT_ORDER_CONFLICT,
    SNAPSHOT_LIMIT_EXCEEDED,
    SNAPSHOT_INCOMPLETE,
    SNAPSHOT_COUNT_MISMATCH,
    SNAPSHOT_DIGEST_MISMATCH,
    EVENT_GAP,
    EVENT_REVISION_CONFLICT,
    EVENT_BUFFER_OVERFLOW,
}

internal enum class RelayV2RecoveryRestartDirective {
    SNAPSHOT,
    QUERY_PENDING_COMMANDS,
}

internal sealed interface RelayV2DurableSnapshotApplyResult {
    val snapshotRequestId: String
    val snapshotId: String

    data class Continue(
        override val snapshotRequestId: String,
        override val snapshotId: String,
        val nextChunkIndex: Long,
        val nextCursor: String,
    ) : RelayV2DurableSnapshotApplyResult {
        init {
            requireRelayV2RuntimeId(snapshotRequestId, "Snapshot request ID")
            requireRelayV2RuntimeId(snapshotId, "Snapshot ID")
            require(nextChunkIndex > 0) { "Snapshot continuation index must be positive" }
            require(nextCursor.isNotEmpty()) { "Snapshot continuation cursor is required" }
            require(nextCursor.toByteArray(Charsets.UTF_8).size <= 1_024) {
                "Snapshot continuation cursor is too long"
            }
        }
    }

    data class Committed(
        override val snapshotRequestId: String,
        override val snapshotId: String,
        val durableCursorEventSeq: String,
        val release: RelayV2RecoveryReleaseDirective,
    ) : RelayV2DurableSnapshotApplyResult {
        init {
            requireRelayV2RuntimeId(snapshotRequestId, "Snapshot request ID")
            requireRelayV2RuntimeId(snapshotId, "Snapshot ID")
            requireRelayV2RuntimeCounter(durableCursorEventSeq, "Durable snapshot cursor")
            require(release.snapshotRequestId == snapshotRequestId)
            require(release.snapshotId == snapshotId)
            require(release.reason == RelayV2RecoveryReleaseReason.COMPLETED)
        }
    }
}

/**
 * Proof returned only after an effect consumer commits its complete repository transaction under
 * [RelayV2ConnectionActor.withEffectApplyLease]. The actor treats these values as opaque durable
 * receipts and still rechecks generation, step, request, host and epoch before advancing.
 */
internal sealed interface RelayV2RecoveryReceipt {
    val binding: RelayV2RecoveryBinding
    val hostId: String
    val hostEpoch: String

    data class HelloApplied(
        override val binding: RelayV2RecoveryBinding,
        override val hostId: String,
        override val hostEpoch: String,
        val durableCursorEventSeq: String?,
        val pendingCommands: List<RelayV2PendingCommand>,
        val snapshotContinuation: RelayV2SnapshotContinuation? = null,
    ) : RelayV2RecoveryReceipt {
        init {
            requireRelayV2RuntimeId(hostId, "Host ID")
            requireRelayV2RuntimeId(hostEpoch, "Host epoch")
            durableCursorEventSeq?.let {
                requireRelayV2RuntimeCounter(it, "Durable hello cursor")
            }
            require(pendingCommands.size <= 4_096) { "Too many pending commands" }
            require(pendingCommands.distinctBy { it.commandId }.size == pendingCommands.size) {
                "Pending command IDs must be unique"
            }
        }
    }

    data class CommandStatusesApplied(
        override val binding: RelayV2RecoveryBinding,
        override val hostId: String,
        override val hostEpoch: String,
        val appliedCommands: List<RelayV2PendingCommand>,
    ) : RelayV2RecoveryReceipt {
        init {
            requireRelayV2RuntimeId(hostId, "Host ID")
            requireRelayV2RuntimeId(hostEpoch, "Host epoch")
            require(appliedCommands.size in 1..32) { "Command status receipt batch is invalid" }
            require(appliedCommands.distinctBy { it.commandId }.size == appliedCommands.size) {
                "Applied command IDs must be unique"
            }
        }
    }

    data class SnapshotChunkApplied(
        override val binding: RelayV2RecoveryBinding,
        override val hostId: String,
        override val hostEpoch: String,
        val result: RelayV2DurableSnapshotApplyResult,
    ) : RelayV2RecoveryReceipt {
        init {
            requireRelayV2RuntimeId(hostId, "Host ID")
            requireRelayV2RuntimeId(hostEpoch, "Host epoch")
        }
    }

    /**
     * Proof that the repository discarded invalid staging/buffer state. The actor releases the
     * supplied pinned cut before deciding from the durable cursor whether to snapshot or query.
     */
    data class RecoveryAbandoned(
        override val binding: RelayV2RecoveryBinding,
        override val hostId: String,
        override val hostEpoch: String,
        val reason: RelayV2RecoveryAbandonReason,
        val durableCursorEventSeq: String?,
        val pendingCommands: List<RelayV2PendingCommand>,
        val release: RelayV2RecoveryReleaseDirective,
        val restart: RelayV2RecoveryRestartDirective,
    ) : RelayV2RecoveryReceipt {
        init {
            requireRelayV2RuntimeId(hostId, "Host ID")
            requireRelayV2RuntimeId(hostEpoch, "Host epoch")
            durableCursorEventSeq?.let {
                requireRelayV2RuntimeCounter(it, "Durable recovery cursor")
            }
            require(pendingCommands.size <= 4_096) { "Too many pending commands" }
            require(pendingCommands.distinctBy { it.commandId }.size == pendingCommands.size) {
                "Pending command IDs must be unique"
            }
            require(
                restart != RelayV2RecoveryRestartDirective.QUERY_PENDING_COMMANDS ||
                    durableCursorEventSeq != null
            ) { "Command query restart requires a durable cursor" }
            require(release.reason == RelayV2RecoveryReleaseReason.ABANDONED) {
                "Abandoned recovery requires an abandoned release obligation"
            }
            require(release.hostId == hostId && release.hostEpoch == hostEpoch)
            require(
                restart != RelayV2RecoveryRestartDirective.QUERY_PENDING_COMMANDS ||
                    release.durableCursorEventSeq != null
            )
        }
    }

    /** Durable proof that no pinned cut exists, so recovery may restart without a release. */
    data class RecoveryRestartRequired(
        override val binding: RelayV2RecoveryBinding,
        override val hostId: String,
        override val hostEpoch: String,
        val reason: RelayV2RecoveryAbandonReason,
        val durableCursorEventSeq: String?,
        val pendingCommands: List<RelayV2PendingCommand>,
        val restart: RelayV2RecoveryRestartDirective,
    ) : RelayV2RecoveryReceipt {
        init {
            requireRelayV2RuntimeId(hostId, "Host ID")
            requireRelayV2RuntimeId(hostEpoch, "Host epoch")
            durableCursorEventSeq?.let {
                requireRelayV2RuntimeCounter(it, "Durable recovery cursor")
            }
            require(pendingCommands.size <= 4_096) { "Too many pending commands" }
            require(pendingCommands.distinctBy { it.commandId }.size == pendingCommands.size) {
                "Pending command IDs must be unique"
            }
            require(
                restart != RelayV2RecoveryRestartDirective.QUERY_PENDING_COMMANDS ||
                    durableCursorEventSeq != null
            ) { "Command query restart requires a durable cursor" }
        }
    }

    /** Durable continuity loss that must outlive any in-flight query completion to ONLINE. */
    data class QueryRecoverySuperseded(
        override val binding: RelayV2RecoveryBinding,
        val queryLineage: RelayV2QueryRecoveryLineage,
        val completedReleaseBinding: RelayV2RecoveryBinding?,
        override val hostId: String,
        override val hostEpoch: String,
        val reason: RelayV2RecoveryAbandonReason,
        val durableCursorEventSeq: String?,
        val requiredThroughEventSeq: String,
        val pendingCommands: List<RelayV2PendingCommand>,
    ) : RelayV2RecoveryReceipt {
        init {
            require(queryLineage.generation == binding.generation)
            completedReleaseBinding?.let { require(it.generation == binding.generation) }
            requireRelayV2RuntimeId(hostId, "Host ID")
            requireRelayV2RuntimeId(hostEpoch, "Host epoch")
            durableCursorEventSeq?.let {
                requireRelayV2RuntimeCounter(it, "Durable recovery cursor")
            }
            requireRelayV2RuntimeCounter(
                requiredThroughEventSeq,
                "Required recovery watermark",
            )
            require(
                durableCursorEventSeq == null ||
                    BigInteger(requiredThroughEventSeq) > BigInteger(durableCursorEventSeq)
            ) { "The superseding watermark must be later than the durable cursor" }
            require(reason == RelayV2RecoveryAbandonReason.EVENT_GAP ||
                reason == RelayV2RecoveryAbandonReason.EVENT_REVISION_CONFLICT ||
                reason == RelayV2RecoveryAbandonReason.EVENT_BUFFER_OVERFLOW
            ) { "Query completion can only be superseded by durable state continuity loss" }
            require(pendingCommands.size <= 4_096)
            require(pendingCommands.distinctBy { it.commandId }.size == pendingCommands.size)
        }
    }

    data class ReleaseObligationRecovered(
        override val binding: RelayV2RecoveryBinding,
        override val hostId: String,
        override val hostEpoch: String,
        val durableCursorEventSeq: String?,
        val pendingCommands: List<RelayV2PendingCommand>,
        val release: RelayV2RecoveryReleaseDirective,
        val restart: RelayV2RecoveryRestartDirective,
    ) : RelayV2RecoveryReceipt {
        init {
            requireRelayV2RuntimeId(hostId, "Host ID")
            requireRelayV2RuntimeId(hostEpoch, "Host epoch")
            require(release.hostId == hostId && release.hostEpoch == hostEpoch)
            durableCursorEventSeq?.let {
                requireRelayV2RuntimeCounter(it, "Durable recovery cursor")
            }
            require(pendingCommands.size <= 4_096) { "Too many pending commands" }
            require(pendingCommands.distinctBy { it.commandId }.size == pendingCommands.size) {
                "Pending command IDs must be unique"
            }
            require(
                restart != RelayV2RecoveryRestartDirective.QUERY_PENDING_COMMANDS ||
                    durableCursorEventSeq != null
            ) { "Command query restart requires a durable cursor" }
        }
    }

    data class SnapshotReleaseCompleted(
        override val binding: RelayV2RecoveryBinding,
        override val hostId: String,
        override val hostEpoch: String,
        val release: RelayV2RecoveryReleaseDirective,
        val restart: RelayV2RecoveryRestartDirective,
    ) : RelayV2RecoveryReceipt {
        init {
            requireRelayV2RuntimeId(hostId, "Host ID")
            requireRelayV2RuntimeId(hostEpoch, "Host epoch")
            require(release.hostId == hostId && release.hostEpoch == hostEpoch)
            require(
                restart != RelayV2RecoveryRestartDirective.QUERY_PENDING_COMMANDS ||
                    release.durableCursorEventSeq != null
            )
        }
    }
}

/** Durable repository proof that an ONLINE state event withdrew live readiness. */
internal data class RelayV2OnlineResyncRequired(
    val generation: RelayV2EffectGeneration,
    val hostId: String,
    val hostEpoch: String,
    val durableCursorEventSeq: String?,
    val pendingCommands: List<RelayV2PendingCommand>,
    val release: RelayV2RecoveryReleaseDirective?,
    val restart: RelayV2RecoveryRestartDirective = RelayV2RecoveryRestartDirective.SNAPSHOT,
) {
    init {
        requireRelayV2RuntimeId(hostId, "Host ID")
        requireRelayV2RuntimeId(hostEpoch, "Host epoch")
        durableCursorEventSeq?.let {
            requireRelayV2RuntimeCounter(it, "Durable online resync cursor")
        }
        require(pendingCommands.size <= 4_096)
        require(pendingCommands.distinctBy { it.commandId }.size == pendingCommands.size)
        require(restart == RelayV2RecoveryRestartDirective.SNAPSHOT) {
            "ONLINE resync must re-establish state authority before command query"
        }
        release?.let {
            require(it.hostId == hostId && it.hostEpoch == hostEpoch)
        }
    }
}

/** Explicit repository-facing consequences of the v2 hello barrier. */
internal sealed interface RelayV2RuntimeEffect {
    sealed interface GenerationScoped : RelayV2RuntimeEffect {
        val generation: RelayV2EffectGeneration
    }

    sealed interface RepositoryScoped : GenerationScoped {
        val repositoryAuthority: RelayV2RepositoryEffectAuthority
    }

    data class QueryPendingCommands(
        val context: RelayV2HandshakeContext,
        override val generation: RelayV2EffectGeneration,
        val recovery: RelayV2RecoveryBinding,
        val connectPlan: RelayV2ConnectPlan,
        val outcome: RelayV2HelloOutcome = RelayV2HelloOutcome.MATCHED,
        override val repositoryAuthority: RelayV2RepositoryEffectAuthority =
            context.repositoryEffectAuthority(generation),
    ) : RepositoryScoped {
        val requestedResume: RelayV2ResumeCursor?
            get() = connectPlan.requestedResume
    }

    data class BeginStateResync(
        val context: RelayV2HandshakeContext,
        override val generation: RelayV2EffectGeneration,
        val outcome: RelayV2HelloOutcome,
        val discardPriorResourceLineage: Boolean,
        val recovery: RelayV2RecoveryBinding,
        val connectPlan: RelayV2ConnectPlan,
        val queryPendingCommandsAfterResync: Boolean = true,
        override val repositoryAuthority: RelayV2RepositoryEffectAuthority =
            context.repositoryEffectAuthority(generation),
    ) : RepositoryScoped {
        val requestedResume: RelayV2ResumeCursor?
            get() = connectPlan.requestedResume
    }

    data class ApplyCommandStatuses(
        val context: RelayV2HandshakeContext,
        val message: RelayV2DecodedMessage,
        val expectedCommands: List<RelayV2PendingCommand>,
        val recovery: RelayV2RecoveryBinding,
        override val generation: RelayV2EffectGeneration = recovery.generation,
        override val repositoryAuthority: RelayV2RepositoryEffectAuthority =
            context.repositoryEffectAuthority(generation),
    ) : RepositoryScoped

    data class ApplyStateSnapshotChunk(
        val context: RelayV2HandshakeContext,
        val message: RelayV2DecodedMessage,
        val rawUtf8Bytes: Int,
        val snapshotRequestId: String,
        val snapshotId: String?,
        val requestedCursor: String?,
        val requestedChunkIndex: Long,
        val recovery: RelayV2RecoveryBinding,
        override val generation: RelayV2EffectGeneration = recovery.generation,
        override val repositoryAuthority: RelayV2RepositoryEffectAuthority =
            context.repositoryEffectAuthority(generation),
    ) : RepositoryScoped {
        init {
            require(rawUtf8Bytes in 1..1_048_576)
        }
    }

    data class CompleteSnapshotRelease(
        val context: RelayV2HandshakeContext,
        val release: RelayV2RecoveryReleaseDirective,
        val proof: RelayV2ReleaseAuthorityProof,
        val expectedRestart: RelayV2RecoveryRestartDirective,
        val recovery: RelayV2RecoveryBinding,
        override val generation: RelayV2EffectGeneration = recovery.generation,
        override val repositoryAuthority: RelayV2RepositoryEffectAuthority =
            context.repositoryEffectAuthority(generation),
    ) : RepositoryScoped

    data class ExpireSnapshotContinuation(
        val context: RelayV2HandshakeContext,
        val snapshotRequestId: String,
        val snapshotId: String,
        val recovery: RelayV2RecoveryBinding,
        override val generation: RelayV2EffectGeneration = recovery.generation,
        override val repositoryAuthority: RelayV2RepositoryEffectAuthority =
            context.repositoryEffectAuthority(generation),
    ) : RepositoryScoped

    data class RejectContinuity(
        val profile: RelayActiveProfileIdentity,
        override val generation: RelayV2EffectGeneration,
        val hostId: String,
        val hostEpoch: String,
        val clientLastEventSeq: String,
        val hostEventSeq: String,
        val outcome: RelayV2HelloOutcome = RelayV2HelloOutcome.EVENT_CURSOR_AHEAD,
    ) : GenerationScoped

    /** Bounded handoff seam for repository-owned post-handshake protocol state. */
    data class DeliverPostHandshakeFrame(
        val context: RelayV2HandshakeContext,
        val message: RelayV2DecodedMessage,
        val rawUtf8Bytes: Int,
        override val generation: RelayV2EffectGeneration,
        val recovery: RelayV2RecoveryBinding? = null,
        val queryLineage: RelayV2QueryRecoveryLineage? = null,
        val completedReleaseBinding: RelayV2RecoveryBinding? = null,
        override val repositoryAuthority: RelayV2RepositoryEffectAuthority =
            context.repositoryEffectAuthority(generation),
    ) : RepositoryScoped {
        init {
            require(rawUtf8Bytes in 1..1_048_576)
            recovery?.let { require(it.generation == generation) }
            queryLineage?.let { require(recovery != null && it.generation == generation) }
            completedReleaseBinding?.let {
                require(queryLineage != null && it.generation == generation)
            }
        }
    }

    data class ConnectionFailed(
        val profile: RelayActiveProfileIdentity?,
        val generation: RelayV2EffectGeneration?,
        val failure: RelayV2ConnectionFailure,
    ) : RelayV2RuntimeEffect

    data class ConnectRejected(
        val requestedProfile: RelayActiveProfileIdentity,
        val failure: RelayV2ConnectionFailure,
    ) : RelayV2RuntimeEffect

    data class Disconnected(
        val profile: RelayActiveProfileIdentity,
        val barrierId: String,
        val fencedGeneration: RelayV2EffectGeneration?,
        val barrierConnectionGeneration: Long,
    ) : RelayV2RuntimeEffect
}

/**
 * Sensitive access material crosses only this injected transport boundary. The request deliberately
 * has a redacted string representation and can offer exactly one v2 subprotocol.
 */
internal data class RelayV2TransportOpenRequest(
    val relayUrl: String,
    val offeredSubprotocols: List<String>,
    val accessToken: String,
) {
    init {
        require(offeredSubprotocols == listOf(RelayV2Profile.RELAY_V2_SUBPROTOCOL)) {
            "Relay v2 transport must offer only tw-relay.v2"
        }
        require(RelayV2CredentialSecretValidator.isAccessToken(accessToken)) {
            "Relay v2 access credential is invalid"
        }
    }

    override fun toString(): String =
        "RelayV2TransportOpenRequest(relayUrl=<redacted>, " +
            "offeredSubprotocols=$offeredSubprotocols, accessToken=<redacted>)"
}

internal enum class RelayV2TransportFailureKind {
    NETWORK,
    UPGRADE,
    PROTOCOL,
    TLS_VALIDATION,
}

internal data class RelayV2TransportFailure(
    val kind: RelayV2TransportFailureKind,
    val httpStatus: Int? = null,
)

internal interface RelayV2Transport {
    fun send(bytes: ByteArray): Boolean
    fun close(code: Int, reason: String)
    fun cancel()

    /** Returns only after resources are fenced, or false at the transport-owned hard deadline. */
    suspend fun awaitTermination(): Boolean
}

internal interface RelayV2TransportListener {
    fun onOpen(source: RelayV2Transport, selectedSubprotocol: String?)

    fun onFrame(
        source: RelayV2Transport,
        bytes: ByteArray,
        metadata: RelayV2FrameMetadata = RelayV2FrameMetadata(),
    )

    fun onClosed(source: RelayV2Transport, code: Int)
    fun onFailure(source: RelayV2Transport, failure: RelayV2TransportFailure)
}

internal fun interface RelayV2TransportFactory {
    fun open(
        request: RelayV2TransportOpenRequest,
        listener: RelayV2TransportListener,
    ): RelayV2Transport
}

private fun requireRelayV2RuntimeId(value: String, label: String) {
    require(value.isNotBlank()) { "$label is required" }
    require(value.toByteArray(Charsets.UTF_8).size <= 128) { "$label is too long" }
    require('\u0000' !in value) { "$label contains NUL" }
}

private fun requireRelayV2RuntimeCounter(value: String, label: String) {
    require(isCanonicalRelayV2RuntimeCounter(value)) { "$label is not canonical or is too large" }
}

internal fun isCanonicalRelayV2RuntimeCounter(value: String): Boolean =
    RUNTIME_COUNTER_PATTERN.matches(value) &&
        BigInteger(value) <= RUNTIME_UNSIGNED_COUNTER_MAX

private val RUNTIME_COUNTER_PATTERN = Regex("^(?:0|[1-9][0-9]*)$")
private val RUNTIME_UNSIGNED_COUNTER_MAX = BigInteger("18446744073709551615")
