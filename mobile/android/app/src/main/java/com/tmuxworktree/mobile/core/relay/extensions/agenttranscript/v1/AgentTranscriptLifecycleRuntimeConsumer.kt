package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineEventFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineReplayPageFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineResetFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotPageFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineStatusFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineUnavailableReason
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineUnavailableStatus
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1InboundFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1Codec
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1CodecException
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1Frame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1FrameMetadata
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectApplyResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectApplyLeasePort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import java.util.concurrent.CancellationException

/** Trusted call-site provenance. It is deliberately absent from the public frame. */
internal sealed interface AgentTranscriptLifecycleTrustedIngress {
    data class CorrelatedStatus(
        val requestFence: AgentLocalRequestFence,
    ) : AgentTranscriptLifecycleTrustedIngress

    data object Live : AgentTranscriptLifecycleTrustedIngress
    data object Replay : AgentTranscriptLifecycleTrustedIngress
    data object Snapshot : AgentTranscriptLifecycleTrustedIngress
}

internal data class AgentTranscriptLifecycleRuntimeFence(
    val authority: RelayV2RepositoryEffectAuthority,
    val expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
    val negotiatedCapabilities: Set<String>,
    val ingress: AgentTranscriptLifecycleTrustedIngress,
)

internal enum class AgentTranscriptLifecycleRuntimeUnavailableReason {
    INVALID_PUBLIC_FRAME,
    EXACT_FENCE_MISMATCH,
    COMPLETE_CONSUMER_NOT_READY,
    STALE_GENERATION,
    DURABLE_REPOSITORY_UNAVAILABLE,
}

internal sealed interface AgentTranscriptLifecycleRuntimeConsumeResult {
    data object ExtensionNotNegotiated : AgentTranscriptLifecycleRuntimeConsumeResult

    data class Unavailable(
        val reason: AgentTranscriptLifecycleRuntimeUnavailableReason,
    ) : AgentTranscriptLifecycleRuntimeConsumeResult

    data class Applied(
        val reduction: AgentTranscriptLifecycleClientReduction,
    ) : AgentTranscriptLifecycleRuntimeConsumeResult
}

/**
 * Strict public decode/fence/apply module for the unwired Android extension consumer.
 *
 * The current durable owner can safely commit only a correlated `support=unavailable` status.
 * Every cursor-bearing closed input remains extension-unavailable until transcript, replay and
 * snapshot staging have one complete durable owner; none may partially advance lifecycle state.
 */
internal class AgentTranscriptLifecycleRuntimeConsumer(
    private val applyLease: RelayV2RepositoryEffectApplyLeasePort,
    private val durableRepository: AgentTranscriptLifecycleDurableReductionPort,
    private val codec: AgentTranscriptLifecycleV1Codec = AgentTranscriptLifecycleV1Codec(),
) {
    suspend fun consume(
        rawFrame: ByteArray,
        fence: AgentTranscriptLifecycleRuntimeFence,
        metadata: AgentTranscriptLifecycleV1FrameMetadata =
            AgentTranscriptLifecycleV1FrameMetadata(),
    ): AgentTranscriptLifecycleRuntimeConsumeResult {
        if (AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY !in fence.negotiatedCapabilities) {
            return AgentTranscriptLifecycleRuntimeConsumeResult.ExtensionNotNegotiated
        }
        val frame = try {
            codec.decodePublicFrame(rawFrame, metadata)
        } catch (_: AgentTranscriptLifecycleV1CodecException) {
            return unavailable(AgentTranscriptLifecycleRuntimeUnavailableReason.INVALID_PUBLIC_FRAME)
        }
        if (!frame.hasExactFence(fence)) {
            return unavailable(AgentTranscriptLifecycleRuntimeUnavailableReason.EXACT_FENCE_MISMATCH)
        }

        val status = (frame as? AgentTimelineStatusFrame)?.status
        if (status !is AgentTimelineUnavailableStatus) {
            return unavailable(
                AgentTranscriptLifecycleRuntimeUnavailableReason.COMPLETE_CONSUMER_NOT_READY,
            )
        }
        val ingress = fence.ingress as? AgentTranscriptLifecycleTrustedIngress.CorrelatedStatus
            ?: return unavailable(
                AgentTranscriptLifecycleRuntimeUnavailableReason.EXACT_FENCE_MISMATCH,
            )
        if (ingress.requestFence.requestToken != frame.requestId) {
            return unavailable(
                AgentTranscriptLifecycleRuntimeUnavailableReason.EXACT_FENCE_MISMATCH,
            )
        }

        val input = AgentTranscriptLifecycleClientInput.StatusUnavailable(
            sessionIdentity = fence.expectedNamespace.consumer.sessionIdentity,
            requestFence = ingress.requestFence,
            reason = status.reason.toReducerReason(),
        )
        val result = try {
            applyLease.withEffectApplyLease(fence.authority) {
                durableRepository.reduceUnderApplyLease(fence.expectedNamespace, input)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return unavailable(
                AgentTranscriptLifecycleRuntimeUnavailableReason.DURABLE_REPOSITORY_UNAVAILABLE,
            )
        }
        return when (result) {
            RelayV2EffectApplyResult.Stale -> unavailable(
                AgentTranscriptLifecycleRuntimeUnavailableReason.STALE_GENERATION,
            )
            is RelayV2EffectApplyResult.Applied -> {
                if (result.value.disposition != AgentClientDisposition.STATUS_APPLIED) {
                    unavailable(
                        AgentTranscriptLifecycleRuntimeUnavailableReason.EXACT_FENCE_MISMATCH,
                    )
                } else {
                    AgentTranscriptLifecycleRuntimeConsumeResult.Applied(result.value)
                }
            }
        }
    }

    private fun AgentTranscriptLifecycleV1Frame.hasExactFence(
        fence: AgentTranscriptLifecycleRuntimeFence,
    ): Boolean {
        val consumer = fence.expectedNamespace.consumer
        val authority = fence.authority
        if (authority.profileId != consumer.profileId ||
            authority.profileActivationGeneration != consumer.profileActivationGeneration ||
            authority.principalId != consumer.principalId ||
            authority.clientInstanceId != consumer.clientInstanceId ||
            authority.hostId != consumer.hostId ||
            authority.hostEpoch != consumer.hostEpoch
        ) return false

        val inbound = this as? AgentTranscriptLifecycleV1InboundFrame ?: return false
        if (inbound.sessionIdentity(consumer.profileId) != consumer.sessionIdentity) return false

        val ingressMatches = when (this) {
            is AgentTimelineStatusFrame ->
                fence.ingress is AgentTranscriptLifecycleTrustedIngress.CorrelatedStatus
            is AgentTimelineEventFrame,
            is AgentTimelineResetFrame,
            -> fence.ingress == AgentTranscriptLifecycleTrustedIngress.Live
            is AgentTimelineReplayPageFrame ->
                fence.ingress == AgentTranscriptLifecycleTrustedIngress.Replay
            is AgentTimelineSnapshotPageFrame ->
                fence.ingress == AgentTranscriptLifecycleTrustedIngress.Snapshot
            else -> false
        }
        if (!ingressMatches) return false

        return when (this) {
            is AgentTimelineEventFrame -> timelineEpoch == fence.expectedNamespace.timelineEpoch
            is AgentTimelineReplayPageFrame ->
                page.timelineEpoch == fence.expectedNamespace.timelineEpoch
            is AgentTimelineSnapshotPageFrame ->
                page.timelineEpoch == fence.expectedNamespace.timelineEpoch
            is AgentTimelineResetFrame ->
                previousTimelineEpoch == fence.expectedNamespace.timelineEpoch
            else -> true
        }
    }

    private fun unavailable(
        reason: AgentTranscriptLifecycleRuntimeUnavailableReason,
    ): AgentTranscriptLifecycleRuntimeConsumeResult =
        AgentTranscriptLifecycleRuntimeConsumeResult.Unavailable(reason)
}

private fun AgentTranscriptLifecycleV1InboundFrame.sessionIdentity(
    profileId: String,
): AgentExtensionSessionIdentity = AgentExtensionSessionIdentity(
    profileId,
    hostId,
    hostEpoch,
    scopeId,
    sessionId,
)

private fun AgentTimelineUnavailableReason.toReducerReason(): AgentExtensionUnavailableReason =
    when (this) {
        AgentTimelineUnavailableReason.AGENT_UNSUPPORTED ->
            AgentExtensionUnavailableReason.AGENT_UNSUPPORTED
        AgentTimelineUnavailableReason.SESSION_NOT_AGENT_MANAGED ->
            AgentExtensionUnavailableReason.SESSION_NOT_AGENT_MANAGED
        AgentTimelineUnavailableReason.ADAPTER_UNAVAILABLE ->
            AgentExtensionUnavailableReason.ADAPTER_UNAVAILABLE
        AgentTimelineUnavailableReason.STORE_UNAVAILABLE ->
            AgentExtensionUnavailableReason.STORE_UNAVAILABLE
    }
