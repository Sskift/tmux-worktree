package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineActiveSourceState
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineAvailableStatus
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineErrorCode
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineErrorFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineHostEpochMismatchDetails
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineEventFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineReplayGetFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineReplayPageFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineReplayPagePublicFrameArtifact
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineReplayRequest
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineResetFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineResetReason as WireAgentTimelineResetReason
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotPageFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotPagePublicFrameArtifact
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotGetFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotRequest
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineStatusFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineUnavailableReason
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineUnavailableStatus
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1InboundFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1Frame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1PublicFrameArtifact
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectApplyResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectApplyLeasePort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import java.util.UUID

/** Trusted call-site provenance. It is deliberately absent from the public frame. */
internal sealed interface AgentTranscriptLifecycleTrustedIngress {
    data class CorrelatedStatus(
        val requestFence: AgentLocalRequestFence,
    ) : AgentTranscriptLifecycleTrustedIngress

    data class CorrelatedError(
        val requestKind: AgentTranscriptLifecycleRequestKind,
        val requestId: String,
        val statusRequestFence: AgentLocalRequestFence? = null,
    ) : AgentTranscriptLifecycleTrustedIngress {
        init {
            require(statusRequestFence == null || requestKind == AgentTranscriptLifecycleRequestKind.STATUS)
            require(statusRequestFence == null || statusRequestFence.requestToken == requestId)
        }
    }

    data object Live : AgentTranscriptLifecycleTrustedIngress
    data object Replay : AgentTranscriptLifecycleTrustedIngress
    data object Snapshot : AgentTranscriptLifecycleTrustedIngress
}

internal data class AgentTranscriptLifecycleRuntimeFence(
    val authority: RelayV2RepositoryEffectAuthority,
    val expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
    val negotiatedCapabilities: Set<String>,
    val ingress: AgentTranscriptLifecycleTrustedIngress,
    val requestAdmission: AgentTranscriptLifecycleRequestAdmission? = null,
)

internal enum class AgentTranscriptLifecycleRuntimeUnavailableReason {
    EXACT_FENCE_MISMATCH,
    STALE_GENERATION,
}

internal enum class AgentTranscriptLifecycleRuntimeFaultDisposition {
    RESYNC_EXTENSION,
    EXTENSION_UNAVAILABLE,
}

internal sealed interface AgentTranscriptLifecycleRuntimePostCommitEffect {
    data class Notification(
        val intent: AgentSystemNotificationIntent,
    ) : AgentTranscriptLifecycleRuntimePostCommitEffect

    data class SyncRequired(
        val directive: AgentTimelineSyncDirective,
    ) : AgentTranscriptLifecycleRuntimePostCommitEffect

    /** Its next request token was committed by the page operation that produced this effect. */
    data class PreparedRequest(
        val request: AgentTranscriptLifecycleActorRequest,
    ) : AgentTranscriptLifecycleRuntimePostCommitEffect
}

internal sealed interface AgentTranscriptLifecycleRuntimeConsumeResult {
    data object ExtensionNotNegotiated : AgentTranscriptLifecycleRuntimeConsumeResult

    data class Unavailable(
        val reason: AgentTranscriptLifecycleRuntimeUnavailableReason,
    ) : AgentTranscriptLifecycleRuntimeConsumeResult

    data class ExtensionFault(
        val reduction: AgentTranscriptLifecycleClientReduction,
        val postCommitEffects: List<AgentTranscriptLifecycleRuntimePostCommitEffect>,
        val disposition: AgentTranscriptLifecycleRuntimeFaultDisposition,
        val requestKind: AgentTranscriptLifecycleRequestKind,
        val requestId: String,
        val code: AgentTimelineErrorCode,
    ) : AgentTranscriptLifecycleRuntimeConsumeResult

    data class Applied(
        val reduction: AgentTranscriptLifecycleClientReduction,
        val postCommitEffects: List<AgentTranscriptLifecycleRuntimePostCommitEffect>,
    ) : AgentTranscriptLifecycleRuntimeConsumeResult
}

/**
 * Strict artifact/fence/apply module. Only the public codec can construct [artifact]; this runtime
 * never accepts raw bytes or independently assembled reducer payloads from a transport caller.
 */
internal class AgentTranscriptLifecycleRuntimeConsumer(
    private val applyLease: RelayV2RepositoryEffectApplyLeasePort,
    private val durableRepository: AgentTranscriptLifecycleDurableOperationPort,
    private val durableHandoff: AgentTranscriptLifecycleDurableHandoffPort,
    private val nextRequestToken: () -> String = { UUID.randomUUID().toString() },
) {
    suspend fun consume(
        artifact: AgentTranscriptLifecycleV1PublicFrameArtifact,
        fence: AgentTranscriptLifecycleRuntimeFence,
    ): AgentTranscriptLifecycleRuntimeConsumeResult {
        if (AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY !in fence.negotiatedCapabilities) {
            return AgentTranscriptLifecycleRuntimeConsumeResult.ExtensionNotNegotiated
        }
        val frame = artifact.frame
        if (!frame.hasExactFence(fence)) {
            return unavailable(AgentTranscriptLifecycleRuntimeUnavailableReason.EXACT_FENCE_MISMATCH)
        }

        val nextToken = when (frame) {
            is AgentTimelineErrorFrame -> nextRequestToken()
            is AgentTimelineReplayPageFrame -> if (frame.page.isLast) null else nextRequestToken()
            is AgentTimelineSnapshotPageFrame -> if (frame.page.isLast) null else nextRequestToken()
            else -> null
        }
        val applied = applyLease.withEffectApplyLease(fence.authority) {
            val operation = dispatchDurableOperation(artifact, frame, fence, nextToken)
            DurableConsumption(
                operation = operation,
                handoffAccepted = acceptDurableHandoff(operation, fence),
            )
        }
        return when (applied) {
            RelayV2EffectApplyResult.Stale ->
                unavailable(AgentTranscriptLifecycleRuntimeUnavailableReason.STALE_GENERATION)
            is RelayV2EffectApplyResult.Applied -> {
                if (!applied.value.handoffAccepted) {
                    return unavailable(
                        AgentTranscriptLifecycleRuntimeUnavailableReason.STALE_GENERATION,
                    )
                }
                val operation = applied.value.operation
                val reduction = operation.reduction
                val effects = operation.postCommitEffects(
                    artifact = artifact,
                    fence = fence,
                    nextToken = nextToken,
                )
                if (frame is AgentTimelineErrorFrame) {
                    correlatedError(frame, fence.ingress, reduction, effects)
                } else {
                    AgentTranscriptLifecycleRuntimeConsumeResult.Applied(
                        reduction = reduction,
                        postCommitEffects = effects,
                    )
                }
            }
        }
    }

    private suspend fun dispatchDurableOperation(
        artifact: AgentTranscriptLifecycleV1PublicFrameArtifact,
        frame: AgentTranscriptLifecycleV1Frame,
        fence: AgentTranscriptLifecycleRuntimeFence,
        nextToken: String?,
    ): AgentTranscriptLifecycleDurableOperationResult {
        val durableFence = fence.durableOperationFence()
        return when (frame) {
            is AgentTimelineErrorFrame -> {
                val ingress = fence.ingress
                    as? AgentTranscriptLifecycleTrustedIngress.CorrelatedError
                    ?: invalidArtifact()
                durableRepository.consumeCorrelatedErrorUnderApplyLease(
                    AgentTranscriptLifecycleDurableCorrelatedErrorCommand(
                        fence = durableFence,
                        artifact = artifact,
                        requestKind = ingress.requestKind,
                        replacementStatusRequestNetworkToken = requireNotNull(nextToken),
                    ),
                )
            }
            is AgentTimelineStatusFrame -> durableRepository.applyControlUnderApplyLease(
                AgentTranscriptLifecycleDurableControlCommand(
                    durableFence,
                    frame.toClientInput(fence),
                ),
            )
            is AgentTimelineEventFrame -> durableRepository.consumeLiveEventUnderApplyLease(
                AgentTranscriptLifecycleDurableLiveEventCommand(durableFence, artifact),
            )
            is AgentTimelineReplayPageFrame -> {
                val replayArtifact = artifact as? AgentTimelineReplayPagePublicFrameArtifact
                    ?: invalidArtifact()
                durableRepository.consumeReplayPageUnderApplyLease(
                    if (frame.page.isLast) {
                        AgentTranscriptLifecycleDurableReplayPageCommand.Final(
                            durableFence,
                            replayArtifact,
                        )
                    } else {
                        AgentTranscriptLifecycleDurableReplayPageCommand.NonFinal(
                            durableFence,
                            replayArtifact,
                            requireNotNull(nextToken),
                        )
                    },
                )
            }
            is AgentTimelineSnapshotPageFrame -> {
                val snapshotArtifact = artifact as? AgentTimelineSnapshotPagePublicFrameArtifact
                    ?: invalidArtifact()
                durableRepository.consumeSnapshotPageUnderApplyLease(
                    if (frame.page.isLast) {
                        AgentTranscriptLifecycleDurableSnapshotPageCommand.FinalPageCut(
                            durableFence,
                            snapshotArtifact,
                        )
                    } else {
                        AgentTranscriptLifecycleDurableSnapshotPageCommand.NonFinalStage(
                            durableFence,
                            snapshotArtifact,
                            requireNotNull(nextToken),
                        )
                    },
                )
            }
            is AgentTimelineResetFrame -> durableRepository.applyControlUnderApplyLease(
                AgentTranscriptLifecycleDurableControlCommand(
                    durableFence,
                    AgentTranscriptLifecycleClientInput.TimelineReset(
                        sessionIdentity = fence.expectedNamespace.consumer.sessionIdentity,
                        previousTimelineEpoch = frame.previousTimelineEpoch,
                        newTimelineEpoch = frame.newTimelineEpoch,
                        reason = when (frame.reason) {
                            WireAgentTimelineResetReason.DELETED ->
                                AgentTimelineResetReason.DELETED
                            WireAgentTimelineResetReason.STORE_RESET ->
                                AgentTimelineResetReason.STORE_RESET
                        },
                    ),
                ),
            )
            else -> invalidArtifact()
        }
    }

    private fun acceptDurableHandoff(
        operation: AgentTranscriptLifecycleDurableOperationResult,
        fence: AgentTranscriptLifecycleRuntimeFence,
    ): Boolean {
        val admission = fence.requestAdmission ?: return true
        if (operation.retiredRequests.isEmpty()) {
            return durableHandoff.acceptDurableHandoff(
                AgentTranscriptLifecycleCompletedHandoffReceipt(admission),
            )
        }
        return durableHandoff.acceptDurableHandoff(
            AgentTranscriptLifecycleCompletedBatchHandoffReceipt(
                authority = fence.authority,
                scopeId = fence.expectedNamespace.consumer.scopeId,
                sessionId = fence.expectedNamespace.consumer.sessionId,
                triggeringAdmission = admission,
                retiredRequests = operation.retiredRequests,
            ),
        )
    }

    private fun AgentTimelineStatusFrame.toClientInput(
        fence: AgentTranscriptLifecycleRuntimeFence,
    ): AgentTranscriptLifecycleControlInput {
        val ingress = fence.ingress as? AgentTranscriptLifecycleTrustedIngress.CorrelatedStatus
            ?: invalidArtifact()
        return when (val observed = status) {
            is AgentTimelineUnavailableStatus ->
                AgentTranscriptLifecycleClientInput.StatusUnavailable(
                    sessionIdentity = fence.expectedNamespace.consumer.sessionIdentity,
                    requestFence = ingress.requestFence,
                    reason = observed.reason.toReducerReason(),
                )
            is AgentTimelineAvailableStatus -> AgentTranscriptLifecycleClientInput.StatusAvailable(
                authority = fence.expectedNamespace.consumer,
                lineage = AgentTimelineLineage(
                    fence.expectedNamespace.consumer.sessionIdentity,
                    observed.timelineEpoch,
                ),
                requestFence = ingress.requestFence,
                liveSource = when (observed.liveSource) {
                    AgentTimelineActiveSourceState.CONNECTED -> AgentLiveSourceState.CONNECTED
                    AgentTimelineActiveSourceState.INTERRUPTED -> AgentLiveSourceState.INTERRUPTED
                },
                activeSourceEpoch = observed.activeSourceEpoch,
                currentAgentSeq = observed.currentAgentSeq,
                earliestReplaySeq = observed.earliestReplaySeq,
                hostLimits = AgentTimelineEffectiveLimits.intersect(
                    maxTextUtf8Bytes = observed.limits.maxTextUtf8Bytes,
                    maxPageRecords = observed.limits.maxPageRecords,
                    eventReplayRetentionMs = observed.limits.eventReplayRetentionMs,
                    snapshotLeaseMs = observed.limits.snapshotLeaseMs,
                ),
            )
        }
    }

    private fun AgentTranscriptLifecycleDurableOperationResult.postCommitEffects(
        artifact: AgentTranscriptLifecycleV1PublicFrameArtifact,
        fence: AgentTranscriptLifecycleRuntimeFence,
        nextToken: String?,
    ): List<AgentTranscriptLifecycleRuntimePostCommitEffect> {
        val committedReduction = reduction
        val effects = committedReduction.notificationDecisions.mapNotNull { decision ->
            decision.systemNotificationIntent?.let(
                AgentTranscriptLifecycleRuntimePostCommitEffect::Notification,
            )
        }.toMutableList<AgentTranscriptLifecycleRuntimePostCommitEffect>()
        if (preparedRequests.isNotEmpty()) {
            effects += preparedRequests.map { prepared ->
                AgentTranscriptLifecycleRuntimePostCommitEffect.PreparedRequest(
                    prepared.toActorRequest(fence),
                )
            }
            return effects
        }
        val frame = artifact.frame
        when {
            frame is AgentTimelineReplayPageFrame &&
                !frame.page.isLast &&
                committedReduction.syncDirective is AgentTimelineSyncDirective.Replay &&
                committedReduction.syncDirective.lineage ==
                fence.expectedNamespace.lineageOrNull() -> {
                val directive = committedReduction.syncDirective
                effects += AgentTranscriptLifecycleRuntimePostCommitEffect.PreparedRequest(
                    AgentTranscriptLifecycleActorRequest.Replay(
                        fence.authority,
                        AgentTimelineReplayGetFrame(
                            requestId = requireNotNull(nextToken),
                            hostId = fence.authority.hostId,
                            expectedHostEpoch = fence.authority.hostEpoch,
                            scopeId = fence.expectedNamespace.consumer.scopeId,
                            sessionId = fence.expectedNamespace.consumer.sessionId,
                            request = AgentTimelineReplayRequest(
                                timelineEpoch = directive.lineage.timelineEpoch,
                                afterAgentSeq = directive.afterAgentSeq,
                                cursor = directive.cursor,
                                limit = directive.limit,
                            ),
                        ),
                    ),
                )
            }
            frame is AgentTimelineSnapshotPageFrame &&
                !frame.page.isLast &&
                committedReduction.syncDirective is AgentTimelineSyncDirective.Snapshot &&
                committedReduction.syncDirective.lineage ==
                fence.expectedNamespace.lineageOrNull() -> {
                effects += AgentTranscriptLifecycleRuntimePostCommitEffect.PreparedRequest(
                    AgentTranscriptLifecycleActorRequest.Snapshot(
                        fence.authority,
                        AgentTimelineSnapshotGetFrame(
                            requestId = requireNotNull(nextToken),
                            hostId = fence.authority.hostId,
                            expectedHostEpoch = fence.authority.hostEpoch,
                            scopeId = fence.expectedNamespace.consumer.scopeId,
                            sessionId = fence.expectedNamespace.consumer.sessionId,
                            request = AgentTimelineSnapshotRequest(
                                snapshotRequestId = frame.page.snapshotRequestId,
                                snapshotId = frame.page.snapshotId,
                                cursor = requireNotNull(frame.page.nextCursor),
                                nextPageIndex = frame.page.pageIndex + 1,
                            ),
                        ),
                    ),
                )
            }
            committedReduction.syncDirective != AgentTimelineSyncDirective.None ->
                effects += AgentTranscriptLifecycleRuntimePostCommitEffect.SyncRequired(
                    committedReduction.syncDirective,
                )
            (frame is AgentTimelineReplayPageFrame && !frame.page.isLast) ||
                (frame is AgentTimelineSnapshotPageFrame && !frame.page.isLast) ->
                effects += AgentTranscriptLifecycleRuntimePostCommitEffect.SyncRequired(
                    AgentTimelineSyncDirective.StatusRefresh,
                )
        }
        return effects
    }

    private fun correlatedError(
        frame: AgentTimelineErrorFrame,
        ingress: AgentTranscriptLifecycleTrustedIngress,
        reduction: AgentTranscriptLifecycleClientReduction,
        postCommitEffects: List<AgentTranscriptLifecycleRuntimePostCommitEffect>,
    ): AgentTranscriptLifecycleRuntimeConsumeResult {
        val correlated = ingress as? AgentTranscriptLifecycleTrustedIngress.CorrelatedError
            ?: return unavailable(AgentTranscriptLifecycleRuntimeUnavailableReason.EXACT_FENCE_MISMATCH)
        return AgentTranscriptLifecycleRuntimeConsumeResult.ExtensionFault(
            reduction = reduction,
            postCommitEffects = postCommitEffects,
            disposition = when (frame.error.code) {
                AgentTimelineErrorCode.AGENT_TIMELINE_UNAVAILABLE ->
                    AgentTranscriptLifecycleRuntimeFaultDisposition.EXTENSION_UNAVAILABLE
                AgentTimelineErrorCode.AGENT_CURSOR_EXPIRED,
                AgentTimelineErrorCode.AGENT_CURSOR_AHEAD,
                AgentTimelineErrorCode.AGENT_SNAPSHOT_EXPIRED,
                AgentTimelineErrorCode.AGENT_TIMELINE_EPOCH_MISMATCH,
                AgentTimelineErrorCode.HOST_EPOCH_MISMATCH,
                -> AgentTranscriptLifecycleRuntimeFaultDisposition.RESYNC_EXTENSION
            },
            requestKind = correlated.requestKind,
            requestId = frame.requestId,
            code = frame.error.code,
        )
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
        if (inbound.hostId != consumer.hostId ||
            inbound.scopeId != consumer.scopeId ||
            inbound.sessionId != consumer.sessionId
        ) return false
        if (this is AgentTimelineErrorFrame &&
            error.code == AgentTimelineErrorCode.HOST_EPOCH_MISMATCH
        ) {
            val details = error.details as? AgentTimelineHostEpochMismatchDetails ?: return false
            if (details.expectedHostEpoch != consumer.hostEpoch ||
                details.actualHostEpoch != hostEpoch
            ) return false
        } else if (inbound.hostEpoch != consumer.hostEpoch) {
            return false
        }

        val ingressMatches = when (this) {
            is AgentTimelineStatusFrame ->
                fence.ingress is AgentTranscriptLifecycleTrustedIngress.CorrelatedStatus
            is AgentTimelineErrorFrame -> {
                val ingress = fence.ingress as? AgentTranscriptLifecycleTrustedIngress.CorrelatedError
                ingress?.requestId == requestId
            }
            is AgentTimelineEventFrame,
            is AgentTimelineResetFrame,
            -> fence.ingress == AgentTranscriptLifecycleTrustedIngress.Live
            is AgentTimelineReplayPageFrame ->
                fence.ingress == AgentTranscriptLifecycleTrustedIngress.Replay
            is AgentTimelineSnapshotPageFrame ->
                fence.ingress == AgentTranscriptLifecycleTrustedIngress.Snapshot
        }
        if (!ingressMatches) return false

        val admission = fence.requestAdmission
        val admissionMatches = when (this) {
            is AgentTimelineStatusFrame -> admission.matches(
                fence.authority,
                AgentTranscriptLifecycleRequestKind.STATUS,
                requestId,
            )
            is AgentTimelineReplayPageFrame -> admission.matches(
                fence.authority,
                AgentTranscriptLifecycleRequestKind.REPLAY,
                requestId,
            )
            is AgentTimelineSnapshotPageFrame -> admission.matches(
                fence.authority,
                AgentTranscriptLifecycleRequestKind.SNAPSHOT,
                requestId,
            )
            is AgentTimelineErrorFrame -> admission.matches(
                fence.authority,
                (fence.ingress as AgentTranscriptLifecycleTrustedIngress.CorrelatedError)
                    .requestKind,
                requestId,
            )
            is AgentTimelineEventFrame,
            is AgentTimelineResetFrame,
            -> admission == null
        }
        if (!admissionMatches) return false

        return when (this) {
            is AgentTimelineStatusFrame ->
                (fence.ingress as AgentTranscriptLifecycleTrustedIngress.CorrelatedStatus)
                    .requestFence.requestToken == requestId
            is AgentTimelineEventFrame -> timelineEpoch == fence.expectedNamespace.timelineEpoch
            is AgentTimelineReplayPageFrame -> page.timelineEpoch == fence.expectedNamespace.timelineEpoch
            is AgentTimelineSnapshotPageFrame -> page.timelineEpoch == fence.expectedNamespace.timelineEpoch
            is AgentTimelineResetFrame -> previousTimelineEpoch == fence.expectedNamespace.timelineEpoch
            is AgentTimelineErrorFrame -> true
        }
    }

    private fun AgentTranscriptLifecycleRuntimeFence.durableOperationFence() =
        AgentTranscriptLifecycleDurableOperationFence(
            AgentTranscriptLifecycleDurableConsumerIdentity(
                profileId = authority.profileId,
                profileActivationGeneration = authority.profileActivationGeneration,
                principalId = authority.principalId,
                clientInstanceId = authority.clientInstanceId,
                hostId = authority.hostId,
                hostEpoch = authority.hostEpoch,
                scopeId = expectedNamespace.consumer.scopeId,
                sessionId = expectedNamespace.consumer.sessionId,
            ),
            expectedNamespace,
        )

    private fun unavailable(
        reason: AgentTranscriptLifecycleRuntimeUnavailableReason,
    ): AgentTranscriptLifecycleRuntimeConsumeResult =
        AgentTranscriptLifecycleRuntimeConsumeResult.Unavailable(reason)

    private fun invalidArtifact(): Nothing =
        throw IllegalArgumentException("Agent extension artifact and trusted ingress disagree")

    private data class DurableConsumption(
        val operation: AgentTranscriptLifecycleDurableOperationResult,
        val handoffAccepted: Boolean,
    )
}

private fun AgentTranscriptLifecycleRequestAdmission?.matches(
    authority: RelayV2RepositoryEffectAuthority,
    requestKind: AgentTranscriptLifecycleRequestKind,
    requestId: String,
): Boolean = this != null &&
    this.authority == authority &&
    this.requestKind == requestKind &&
    this.requestId == requestId

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

private fun AgentTranscriptLifecycleDurableNamespace.lineageOrNull(): AgentTimelineLineage? =
    timelineEpoch?.let { AgentTimelineLineage(consumer.sessionIdentity, it) }
