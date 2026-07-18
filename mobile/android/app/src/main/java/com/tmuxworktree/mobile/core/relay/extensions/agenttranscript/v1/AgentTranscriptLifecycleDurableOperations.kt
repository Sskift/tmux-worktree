package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineEventFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineErrorCode
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineErrorFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineHostEpochMismatchDetails
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineReplayPagePublicFrameArtifact
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotPagePublicFrameArtifact
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1PublicFrameArtifact
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateLimits
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

internal enum class AgentTranscriptLifecycleRequestKind {
    STATUS,
    REPLAY,
    SNAPSHOT,
}

/**
 * Exact durable authority supplied by the serialized v2 apply owner.
 *
 * Commands carry no independently assembled wire header or byte count. The public codec owns the
 * closed frame artifact; this fence contributes only trusted activation/principal/client ingress.
 */
internal data class AgentTranscriptLifecycleDurableOperationFence(
    val authority: AgentTranscriptLifecycleDurableConsumerIdentity,
    val expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
) {
    init {
        require(authority == expectedNamespace.consumer)
    }
}

internal data class AgentTranscriptLifecycleDurableControlCommand(
    val fence: AgentTranscriptLifecycleDurableOperationFence,
    val input: AgentTranscriptLifecycleControlInput,
)

/** One strict codec-issued LIVE frame. */
internal data class AgentTranscriptLifecycleDurableLiveEventCommand(
    val fence: AgentTranscriptLifecycleDurableOperationFence,
    val artifact: AgentTranscriptLifecycleV1PublicFrameArtifact,
) {
    val frame: AgentTimelineEventFrame
        get() = artifact.frame as AgentTimelineEventFrame

    init {
        val eventFrame = artifact.frame
        require(eventFrame is AgentTimelineEventFrame)
        requireArtifactNamespace(fence, eventFrame.hostId, eventFrame.hostEpoch,
            eventFrame.scopeId, eventFrame.sessionId, eventFrame.timelineEpoch)
    }
}

/** One codec-closed correlated error whose exact request fence is still owned durably. */
internal data class AgentTranscriptLifecycleDurableCorrelatedErrorCommand(
    val fence: AgentTranscriptLifecycleDurableOperationFence,
    val artifact: AgentTranscriptLifecycleV1PublicFrameArtifact,
    val requestKind: AgentTranscriptLifecycleRequestKind,
    val replacementStatusRequestNetworkToken: String,
) {
    val frame: AgentTimelineErrorFrame
        get() = artifact.frame as AgentTimelineErrorFrame

    init {
        val errorFrame = artifact.frame
        require(errorFrame is AgentTimelineErrorFrame)
        val consumer = fence.expectedNamespace.consumer
        require(errorFrame.hostId == consumer.hostId)
        require(errorFrame.scopeId == consumer.scopeId)
        require(errorFrame.sessionId == consumer.sessionId)
        if (errorFrame.error.code == AgentTimelineErrorCode.HOST_EPOCH_MISMATCH) {
            val details = errorFrame.error.details as? AgentTimelineHostEpochMismatchDetails
            require(details != null)
            require(details.expectedHostEpoch == consumer.hostEpoch)
            require(details.actualHostEpoch == errorFrame.hostEpoch)
        } else {
            require(errorFrame.hostEpoch == consumer.hostEpoch)
        }
        requireOperationOpaqueId(replacementStatusRequestNetworkToken)
        require(replacementStatusRequestNetworkToken != errorFrame.requestId)
    }
}

internal sealed interface AgentTranscriptLifecycleDurablePrepareRequestCommand {
    val fence: AgentTranscriptLifecycleDurableOperationFence
    val requestKind: AgentTranscriptLifecycleRequestKind

    data class Status(
        override val fence: AgentTranscriptLifecycleDurableOperationFence,
        val proposedRequestNetworkToken: String,
    ) : AgentTranscriptLifecycleDurablePrepareRequestCommand {
        override val requestKind = AgentTranscriptLifecycleRequestKind.STATUS
        init {
            requireOperationOpaqueId(proposedRequestNetworkToken)
        }
    }

    data class Replay(
        override val fence: AgentTranscriptLifecycleDurableOperationFence,
        val directive: AgentTimelineSyncDirective.Replay,
        val proposedRequestNetworkToken: String,
    ) : AgentTranscriptLifecycleDurablePrepareRequestCommand {
        override val requestKind = AgentTranscriptLifecycleRequestKind.REPLAY
        init {
            requireOperationOpaqueId(proposedRequestNetworkToken)
        }
    }

    data class Snapshot(
        override val fence: AgentTranscriptLifecycleDurableOperationFence,
        val directive: AgentTimelineSyncDirective.Snapshot,
        val proposedSnapshotRequestId: String,
        val proposedPageZeroNetworkToken: String,
    ) : AgentTranscriptLifecycleDurablePrepareRequestCommand {
        override val requestKind = AgentTranscriptLifecycleRequestKind.SNAPSHOT
        init {
            requireOperationOpaqueId(proposedSnapshotRequestId)
            requireOperationOpaqueId(proposedPageZeroNetworkToken)
        }
    }
}

internal sealed interface AgentTranscriptLifecycleDurablePreparedRequest {
    val requestKind: AgentTranscriptLifecycleRequestKind
    val requestNetworkToken: String

    data class Status(
        val requestFence: AgentLocalRequestFence,
    ) : AgentTranscriptLifecycleDurablePreparedRequest {
        override val requestKind = AgentTranscriptLifecycleRequestKind.STATUS
        override val requestNetworkToken: String = requestFence.requestToken
    }

    data class Replay(
        val lineage: AgentTimelineLineage,
        val pageFence: AgentReplayPageFence,
    ) : AgentTranscriptLifecycleDurablePreparedRequest {
        override val requestKind = AgentTranscriptLifecycleRequestKind.REPLAY
        override val requestNetworkToken: String = pageFence.currentRequestNetworkToken
    }

    data class Snapshot(
        val lineage: AgentTimelineLineage,
        val snapshotRequestId: String,
        override val requestNetworkToken: String,
        val snapshotId: String?,
        val cursor: String?,
        val nextPageIndex: Long,
    ) : AgentTranscriptLifecycleDurablePreparedRequest {
        override val requestKind = AgentTranscriptLifecycleRequestKind.SNAPSHOT

        init {
            requireOperationOpaqueId(snapshotRequestId)
            requireOperationOpaqueId(requestNetworkToken)
            require((snapshotId == null) == (cursor == null))
            require((snapshotId == null) == (nextPageIndex == 0L))
        }
    }
}

internal data class AgentTranscriptLifecycleDurablePrepareRequestResult(
    val reduction: AgentTranscriptLifecycleClientReduction,
    val preparedRequest: AgentTranscriptLifecycleDurablePreparedRequest,
)

/**
 * A complete replay response. The wire artifact owns after/through/cursor/events/raw accounting;
 * only the next outer request token is local durable state.
 */
internal sealed interface AgentTranscriptLifecycleDurableReplayPageCommand {
    val fence: AgentTranscriptLifecycleDurableOperationFence
    val artifact: AgentTimelineReplayPagePublicFrameArtifact

    data class NonFinal(
        override val fence: AgentTranscriptLifecycleDurableOperationFence,
        override val artifact: AgentTimelineReplayPagePublicFrameArtifact,
        val nextRequestNetworkToken: String,
    ) : AgentTranscriptLifecycleDurableReplayPageCommand {
        init {
            require(!artifact.isLast)
            require(artifact.events.isNotEmpty())
            require(artifact.nextCursor != null)
            requireOperationOpaqueId(nextRequestNetworkToken)
            require(nextRequestNetworkToken != artifact.requestId)
            requireReplayArtifactNamespace(fence, artifact)
        }
    }

    data class Final(
        override val fence: AgentTranscriptLifecycleDurableOperationFence,
        override val artifact: AgentTimelineReplayPagePublicFrameArtifact,
    ) : AgentTranscriptLifecycleDurableReplayPageCommand {
        init {
            require(artifact.isLast)
            require(artifact.nextCursor == null)
            if (artifact.events.isEmpty()) {
                // The frozen empty range includes the genesis 0/0 cut.
                require(artifact.afterAgentSeq == artifact.replayThroughAgentSeq)
            }
            requireReplayArtifactNamespace(fence, artifact)
        }
    }
}

/** Durable pre-first-page fence; logical snapshot identity and outer request token stay distinct. */
internal data class AgentTranscriptLifecycleDurableSnapshotRequestCommand(
    val fence: AgentTranscriptLifecycleDurableOperationFence,
    val snapshotRequestId: String,
    val pageZeroNetworkToken: String,
) {
    init {
        requireOperationOpaqueId(snapshotRequestId)
        requireOperationOpaqueId(pageZeroNetworkToken)
    }
}

/**
 * Snapshot non-final pages may be empty. A final command never persists an intermediate complete
 * B row: page staging, cut validation/materialization, D merge, and B/C removal are one operation.
 */
internal sealed interface AgentTranscriptLifecycleDurableSnapshotPageCommand {
    val fence: AgentTranscriptLifecycleDurableOperationFence
    val artifact: AgentTimelineSnapshotPagePublicFrameArtifact

    data class NonFinalStage(
        override val fence: AgentTranscriptLifecycleDurableOperationFence,
        override val artifact: AgentTimelineSnapshotPagePublicFrameArtifact,
        val nextRequestNetworkToken: String,
    ) : AgentTranscriptLifecycleDurableSnapshotPageCommand {
        init {
            require(!artifact.isLast)
            require(artifact.nextCursor != null)
            requireOperationOpaqueId(nextRequestNetworkToken)
            require(nextRequestNetworkToken != artifact.requestId)
            requireSnapshotArtifactNamespace(fence, artifact)
        }
    }

    data class FinalPageCut(
        override val fence: AgentTranscriptLifecycleDurableOperationFence,
        override val artifact: AgentTimelineSnapshotPagePublicFrameArtifact,
    ) : AgentTranscriptLifecycleDurableSnapshotPageCommand {
        init {
            require(artifact.isLast)
            require(artifact.nextCursor == null)
            requireSnapshotArtifactNamespace(fence, artifact)
        }
    }
}

internal data class AgentTranscriptLifecycleDurableOperationResult(
    val reduction: AgentTranscriptLifecycleClientReduction,
    val preparedRequests: List<AgentTranscriptLifecycleDurablePreparedRequest> = emptyList(),
    val retiredRequests: List<AgentTranscriptLifecycleDurableRequestIdentity> = emptyList(),
)

internal data class AgentTranscriptLifecycleDurableRequestIdentity(
    val requestKind: AgentTranscriptLifecycleRequestKind,
    val requestNetworkToken: String,
) {
    init {
        requireOperationOpaqueId(requestNetworkToken)
    }
}

/** One deep production seam: every method maps to one outer Room transaction. */
internal interface AgentTranscriptLifecycleDurableOperationPort {
    suspend fun prepareRequestUnderApplyLease(
        command: AgentTranscriptLifecycleDurablePrepareRequestCommand,
        limits: AgentClientReducerLimits = AgentClientReducerLimits(),
    ): AgentTranscriptLifecycleDurablePrepareRequestResult

    suspend fun loadPreparedRequestsUnderApplyLease(
        fence: AgentTranscriptLifecycleDurableOperationFence,
    ): List<AgentTranscriptLifecycleDurablePreparedRequest>

    suspend fun applyControlUnderApplyLease(
        command: AgentTranscriptLifecycleDurableControlCommand,
        limits: AgentClientReducerLimits = AgentClientReducerLimits(),
    ): AgentTranscriptLifecycleDurableOperationResult

    suspend fun consumeLiveEventUnderApplyLease(
        command: AgentTranscriptLifecycleDurableLiveEventCommand,
        limits: AgentClientReducerLimits = AgentClientReducerLimits(),
    ): AgentTranscriptLifecycleDurableOperationResult

    suspend fun consumeCorrelatedErrorUnderApplyLease(
        command: AgentTranscriptLifecycleDurableCorrelatedErrorCommand,
        limits: AgentClientReducerLimits = AgentClientReducerLimits(),
    ): AgentTranscriptLifecycleDurableOperationResult

    suspend fun consumeReplayPageUnderApplyLease(
        command: AgentTranscriptLifecycleDurableReplayPageCommand,
        limits: AgentClientReducerLimits = AgentClientReducerLimits(),
    ): AgentTranscriptLifecycleDurableOperationResult

    suspend fun persistSnapshotRequestUnderApplyLease(
        command: AgentTranscriptLifecycleDurableSnapshotRequestCommand,
    ): AgentTranscriptLifecycleDurableOperationResult

    suspend fun consumeSnapshotPageUnderApplyLease(
        command: AgentTranscriptLifecycleDurableSnapshotPageCommand,
        limits: AgentClientReducerLimits = AgentClientReducerLimits(),
    ): AgentTranscriptLifecycleDurableOperationResult
}

/**
 * Narrow durable owner for the one-shot notification claim transaction.
 *
 * Callers must invoke this only while holding the serialized actor apply lease. A claimed result
 * is post-commit authority; no platform call belongs inside this port.
 */
internal interface AgentTranscriptLifecycleNotificationClaimPort {
    suspend fun claimNotificationUnderApplyLease(
        expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
        intent: AgentSystemNotificationIntent,
    ): AgentTranscriptLifecycleNotificationClaimResult
}

/**
 * Lower-level durable contract consumed by the optional runtime composition.
 *
 * This is not another repository: one implementation instance must own mutation, current
 * namespace lookup, notification claim, and revision-pinned reads. The Room implementation is
 * [AgentTranscriptLifecycleDurableRepository].
 */
internal interface AgentTranscriptLifecycleRuntimeDurableRepository :
    AgentTranscriptLifecycleDurableOperationPort,
    AgentTranscriptLifecycleNotificationClaimPort,
    AgentTranscriptLifecycleRevisionPinnedReadPort {
    suspend fun load(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): AgentTranscriptLifecycleDurableRecord?
}

private fun requireReplayArtifactNamespace(
    fence: AgentTranscriptLifecycleDurableOperationFence,
    artifact: AgentTimelineReplayPagePublicFrameArtifact,
) {
    requireArtifactNamespace(
        fence, artifact.hostId, artifact.hostEpoch, artifact.scopeId, artifact.sessionId,
        artifact.timelineEpoch,
    )
}

private fun requireSnapshotArtifactNamespace(
    fence: AgentTranscriptLifecycleDurableOperationFence,
    artifact: AgentTimelineSnapshotPagePublicFrameArtifact,
) {
    requireArtifactNamespace(
        fence, artifact.hostId, artifact.hostEpoch, artifact.scopeId, artifact.sessionId,
        artifact.timelineEpoch,
    )
}

private fun requireArtifactNamespace(
    fence: AgentTranscriptLifecycleDurableOperationFence,
    hostId: String,
    hostEpoch: String,
    scopeId: String,
    sessionId: String,
    timelineEpoch: String,
) {
    val consumer = fence.expectedNamespace.consumer
    require(hostId == consumer.hostId)
    require(hostEpoch == consumer.hostEpoch)
    require(scopeId == consumer.scopeId)
    require(sessionId == consumer.sessionId)
    require(timelineEpoch == fence.expectedNamespace.timelineEpoch)
}

private fun requireOperationOpaqueId(value: String) {
    require(value.isNotBlank() && value == value.trim() && '\u0000' !in value)
    val encoder = StandardCharsets.UTF_8.newEncoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
    require(encoder.canEncode(CharBuffer.wrap(value)))
    require(value.toByteArray(StandardCharsets.UTF_8).size <= RelayV2StateLimits.MAX_ID_UTF8_BYTES)
}
