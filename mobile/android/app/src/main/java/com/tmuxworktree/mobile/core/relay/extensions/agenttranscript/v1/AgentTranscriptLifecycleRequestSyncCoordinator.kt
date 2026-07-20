package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineReplayGetFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineReplayRequest
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotGetFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotRequest
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineStatusGetFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1Frame
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectApplyResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectApplyLeasePort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import java.util.UUID

/** A request whose durable token has already committed before it reaches the actor. */
internal sealed interface AgentTranscriptLifecycleActorRequest {
    val authority: RelayV2RepositoryEffectAuthority
    val frame: AgentTranscriptLifecycleV1Frame
    val requestId: String
    val kind: AgentTranscriptLifecycleRequestKind
    val scopeId: String
    val sessionId: String

    data class Status(
        override val authority: RelayV2RepositoryEffectAuthority,
        override val frame: AgentTimelineStatusGetFrame,
        val requestFence: AgentLocalRequestFence,
    ) : AgentTranscriptLifecycleActorRequest {
        override val requestId: String = frame.requestId
        override val kind: AgentTranscriptLifecycleRequestKind =
            AgentTranscriptLifecycleRequestKind.STATUS
        override val scopeId: String = frame.scopeId
        override val sessionId: String = frame.sessionId

        init {
            require(requestFence.requestToken == requestId)
            requireRequestAuthority(authority, frame.hostId, frame.expectedHostEpoch)
        }
    }

    data class Replay(
        override val authority: RelayV2RepositoryEffectAuthority,
        override val frame: AgentTimelineReplayGetFrame,
    ) : AgentTranscriptLifecycleActorRequest {
        override val requestId: String = frame.requestId
        override val kind: AgentTranscriptLifecycleRequestKind =
            AgentTranscriptLifecycleRequestKind.REPLAY
        override val scopeId: String = frame.scopeId
        override val sessionId: String = frame.sessionId

        init {
            requireRequestAuthority(authority, frame.hostId, frame.expectedHostEpoch)
        }
    }

    data class Snapshot(
        override val authority: RelayV2RepositoryEffectAuthority,
        override val frame: AgentTimelineSnapshotGetFrame,
    ) : AgentTranscriptLifecycleActorRequest {
        override val requestId: String = frame.requestId
        override val kind: AgentTranscriptLifecycleRequestKind =
            AgentTranscriptLifecycleRequestKind.SNAPSHOT
        override val scopeId: String = frame.scopeId
        override val sessionId: String = frame.sessionId

        init {
            requireRequestAuthority(authority, frame.hostId, frame.expectedHostEpoch)
        }
    }
}

/** Exact synchronous reservation proving the actor accepted one request identity into its lane. */
internal data class AgentTranscriptLifecycleRequestAdmission(
    val authority: RelayV2RepositoryEffectAuthority,
    val requestKind: AgentTranscriptLifecycleRequestKind,
    val requestId: String,
    val admissionSequence: Long,
) {
    init {
        require(requestId.isNotBlank())
        require(admissionSequence > 0)
    }
}

internal fun interface AgentTranscriptLifecycleExtensionRequestSender {
    /** Null rejects synchronously; a receipt owns exact capacity before it is returned. */
    fun send(request: AgentTranscriptLifecycleActorRequest): AgentTranscriptLifecycleRequestAdmission?
}

/** The durable owner consumed this request; the actor must reject reuse and isolate late wire. */
internal data class AgentTranscriptLifecycleCompletedHandoffReceipt(
    val admission: AgentTranscriptLifecycleRequestAdmission,
)

/**
 * Atomically replaces one failed volatile admission with the same exact durable request. The old
 * admission remains actor-owned unless the replacement action is synchronously admitted.
 */
internal data class AgentTranscriptLifecycleExactRedriveReplacement(
    val oldAdmission: AgentTranscriptLifecycleRequestAdmission,
    val exactRequest: AgentTranscriptLifecycleActorRequest,
) {
    init {
        require(oldAdmission.matches(exactRequest))
    }
}

/** Every listed durable request completed or was atomically retired by the committed operation. */
internal data class AgentTranscriptLifecycleCompletedBatchHandoffReceipt(
    val authority: RelayV2RepositoryEffectAuthority,
    val scopeId: String,
    val sessionId: String,
    val triggeringAdmission: AgentTranscriptLifecycleRequestAdmission,
    val retiredRequests: List<AgentTranscriptLifecycleDurableRequestIdentity>,
) {
    init {
        require(triggeringAdmission.authority == authority)
        require(scopeId.isNotBlank())
        require(sessionId.isNotBlank())
        require(retiredRequests.isNotEmpty())
        require(retiredRequests.size <= 2)
        require(retiredRequests.distinct().size == retiredRequests.size)
        require(
            retiredRequests.map { it.requestNetworkToken }.distinct().size ==
                retiredRequests.size,
        )
        require(
            AgentTranscriptLifecycleDurableRequestIdentity(
                triggeringAdmission.requestKind,
                triggeringAdmission.requestId,
            ) in retiredRequests,
        )
    }
}

internal interface AgentTranscriptLifecycleDurableHandoffPort {
    /** Completes one request after its durable owner committed. */
    fun acceptDurableHandoff(receipt: AgentTranscriptLifecycleCompletedHandoffReceipt): Boolean

    /** Atomically completes every exact admission retired by one committed durable operation. */
    fun acceptDurableHandoff(
        receipt: AgentTranscriptLifecycleCompletedBatchHandoffReceipt,
    ): Boolean

    /** Atomically swaps a failed admission for its exact still-prepared durable request. */
    fun replaceForExactRedrive(
        replacement: AgentTranscriptLifecycleExactRedriveReplacement,
    ): AgentTranscriptLifecycleRequestAdmission?
}

internal sealed interface AgentTranscriptLifecycleRequestSyncResult {
    data object NoRequest : AgentTranscriptLifecycleRequestSyncResult
    data object ExtensionNotNegotiated : AgentTranscriptLifecycleRequestSyncResult
    data object StaleGeneration : AgentTranscriptLifecycleRequestSyncResult

    data class Dispatched(
        val reduction: AgentTranscriptLifecycleClientReduction?,
        val request: AgentTranscriptLifecycleActorRequest,
        val admission: AgentTranscriptLifecycleRequestAdmission?,
    ) : AgentTranscriptLifecycleRequestSyncResult

    /** The coordinator exposes the post-commit intent; it never executes a system notification. */
    data class NotificationReady(
        val intent: AgentSystemNotificationIntent,
    ) : AgentTranscriptLifecycleRequestSyncResult
}

/**
 * Actor-derived authority for one selected-Session outbound status request.
 *
 * Capability admission happened when the selection controller entered the actor's exact
 * repository read cut. This context intentionally carries no caller-assembled negotiated set or
 * inbound ingress provenance; the apply lease and actor sender fence the authority again.
 */
internal data class AgentTranscriptLifecycleOutboundStatusRequestContext(
    val authority: RelayV2RepositoryEffectAuthority,
    val expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
) {
    init {
        val consumer = expectedNamespace.consumer
        require(authority.profileId == consumer.profileId)
        require(authority.profileActivationGeneration == consumer.profileActivationGeneration)
        require(authority.principalId == consumer.principalId)
        require(authority.clientInstanceId == consumer.clientInstanceId)
        require(authority.hostId == consumer.hostId)
        require(authority.hostEpoch == consumer.hostEpoch)
    }
}

/**
 * Actor-derived authority for replacing one exact failed request admission.
 *
 * Capability negotiation remains at the actor/composition boundary. This context deliberately
 * carries neither trusted ingress nor a caller-assembled capability set; the redrive owner only
 * needs the current repository authority and the exact durable namespace it must re-read.
 */
internal data class AgentTranscriptLifecycleFailedAdmissionRedriveContext(
    val authority: RelayV2RepositoryEffectAuthority,
    val expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
) {
    init {
        val consumer = expectedNamespace.consumer
        require(authority.profileId == consumer.profileId)
        require(authority.profileActivationGeneration == consumer.profileActivationGeneration)
        require(authority.principalId == consumer.principalId)
        require(authority.clientInstanceId == consumer.clientInstanceId)
        require(authority.hostId == consumer.hostId)
        require(authority.hostEpoch == consumer.hostEpoch)
    }
}

/**
 * Actor-derived authority for re-reading requests already prepared by the durable owner.
 *
 * This context intentionally carries neither negotiated capabilities, trusted ingress, nor a
 * caller-assembled runtime fence. The actor apply lease and exact durable namespace are the only
 * authority needed to resume previously committed request identities.
 */
internal data class AgentTranscriptLifecyclePersistedRequestResumeContext(
    val authority: RelayV2RepositoryEffectAuthority,
    val expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
) {
    init {
        val consumer = expectedNamespace.consumer
        require(authority.profileId == consumer.profileId)
        require(authority.profileActivationGeneration == consumer.profileActivationGeneration)
        require(authority.principalId == consumer.principalId)
        require(authority.clientInstanceId == consumer.clientInstanceId)
        require(authority.hostId == consumer.hostId)
        require(authority.hostEpoch == consumer.hostEpoch)
    }
}

/**
 * Replaces a failed volatile admission only while its exact durable request remains prepared.
 *
 * This owner never prepares a request, generates a token, calls the ordinary request sender, or
 * owns a WebSocket. The actor apply lease covers both the durable re-read and the exact handoff
 * replacement, so stale or missing evidence leaves the old admission actor-owned.
 */
internal class AgentTranscriptLifecycleFailedAdmissionRedriveCoordinator(
    private val applyLease: RelayV2RepositoryEffectApplyLeasePort,
    private val durableRepository: AgentTranscriptLifecycleDurableOperationPort,
    private val durableHandoff: AgentTranscriptLifecycleDurableHandoffPort,
) {
    suspend fun retryFailedAdmission(
        context: AgentTranscriptLifecycleFailedAdmissionRedriveContext,
        failedRequest: AgentTranscriptLifecycleActorRequest,
        failedAdmission: AgentTranscriptLifecycleRequestAdmission,
    ): AgentTranscriptLifecycleRequestSyncResult {
        if (!failedAdmission.matches(failedRequest) ||
            failedRequest.authority != context.authority ||
            failedRequest.scopeId != context.expectedNamespace.consumer.scopeId ||
            failedRequest.sessionId != context.expectedNamespace.consumer.sessionId
        ) return AgentTranscriptLifecycleRequestSyncResult.StaleGeneration

        val recovered = applyLease.withEffectApplyLease(context.authority) {
            val exact = durableRepository
                .loadPreparedRequestsUnderApplyLease(context.durableOperationFence())
                .singleOrNull {
                    it.requestKind == failedAdmission.requestKind &&
                        it.requestNetworkToken == failedAdmission.requestId
                }
                ?.toActorRequest(
                    authority = context.authority,
                    expectedNamespace = context.expectedNamespace,
                )
                ?.takeIf { it == failedRequest }
            exact?.let {
                failedRequest to durableHandoff.replaceForExactRedrive(
                    AgentTranscriptLifecycleExactRedriveReplacement(
                        oldAdmission = failedAdmission,
                        exactRequest = failedRequest,
                    ),
                )
            }
        }
        return when (recovered) {
            RelayV2EffectApplyResult.Stale ->
                AgentTranscriptLifecycleRequestSyncResult.StaleGeneration
            is RelayV2EffectApplyResult.Applied -> {
                val (request, admission) = recovered.value
                    ?: return AgentTranscriptLifecycleRequestSyncResult.StaleGeneration
                AgentTranscriptLifecycleRequestSyncResult.Dispatched(
                    reduction = null,
                    request = request,
                    admission = admission,
                )
            }
        }
    }
}

/**
 * Persists extension request fences through the existing durable owner, then asks the actor to
 * send under its current generation/authority fence. This coordinator never owns a WebSocket.
 */
internal class AgentTranscriptLifecycleRequestSyncCoordinator(
    private val applyLease: RelayV2RepositoryEffectApplyLeasePort,
    private val durableRepository: AgentTranscriptLifecycleDurableOperationPort,
    private val requestSender: AgentTranscriptLifecycleExtensionRequestSender,
    private val durableHandoff: AgentTranscriptLifecycleDurableHandoffPort,
    private val requestToken: () -> String = { UUID.randomUUID().toString() },
) {
    private val failedAdmissionRedrive =
        AgentTranscriptLifecycleFailedAdmissionRedriveCoordinator(
            applyLease = applyLease,
            durableRepository = durableRepository,
            durableHandoff = durableHandoff,
        )

    suspend fun requestStatus(
        context: AgentTranscriptLifecycleOutboundStatusRequestContext,
    ): AgentTranscriptLifecycleRequestSyncResult {
        val token = requestToken()
        val applied = applyLease.withEffectApplyLease(context.authority) {
            durableRepository.prepareRequestUnderApplyLease(
                AgentTranscriptLifecycleDurablePrepareRequestCommand.Status(
                    context.durableOperationFence(),
                    token,
                ),
            )
        }
        return applied.dispatchPreparedAfterCommit(
            authority = context.authority,
            expectedNamespace = context.expectedNamespace,
        )
    }

    suspend fun requestStatus(
        fence: AgentTranscriptLifecycleRuntimeFence,
    ): AgentTranscriptLifecycleRequestSyncResult {
        if (!fence.isNegotiated()) return AgentTranscriptLifecycleRequestSyncResult.ExtensionNotNegotiated
        return requestStatus(
            AgentTranscriptLifecycleOutboundStatusRequestContext(
                authority = fence.authority,
                expectedNamespace = fence.expectedNamespace,
            ),
        )
    }

    suspend fun requestReplay(
        fence: AgentTranscriptLifecycleRuntimeFence,
        directive: AgentTimelineSyncDirective.Replay,
    ): AgentTranscriptLifecycleRequestSyncResult {
        if (!fence.isNegotiated()) return AgentTranscriptLifecycleRequestSyncResult.ExtensionNotNegotiated
        if (directive.lineage != fence.expectedNamespace.lineageOrNull()) {
            return AgentTranscriptLifecycleRequestSyncResult.StaleGeneration
        }
        val token = requestToken()
        val applied = applyLease.withEffectApplyLease(fence.authority) {
            durableRepository.prepareRequestUnderApplyLease(
                AgentTranscriptLifecycleDurablePrepareRequestCommand.Replay(
                    fence = fence.durableOperationFence(),
                    directive = directive,
                    proposedRequestNetworkToken = token,
                ),
            )
        }
        return applied.dispatchPreparedAfterCommit(
            authority = fence.authority,
            expectedNamespace = fence.expectedNamespace,
        )
    }

    suspend fun requestSnapshot(
        fence: AgentTranscriptLifecycleRuntimeFence,
        directive: AgentTimelineSyncDirective.Snapshot,
    ): AgentTranscriptLifecycleRequestSyncResult {
        if (!fence.isNegotiated()) return AgentTranscriptLifecycleRequestSyncResult.ExtensionNotNegotiated
        if (directive.lineage != fence.expectedNamespace.lineageOrNull()) {
            return AgentTranscriptLifecycleRequestSyncResult.StaleGeneration
        }
        val snapshotRequestId = requestToken()
        val pageToken = requestToken()
        val applied = applyLease.withEffectApplyLease(fence.authority) {
            durableRepository.prepareRequestUnderApplyLease(
                AgentTranscriptLifecycleDurablePrepareRequestCommand.Snapshot(
                    fence = fence.durableOperationFence(),
                    directive = directive,
                    proposedSnapshotRequestId = snapshotRequestId,
                    proposedPageZeroNetworkToken = pageToken,
                ),
            )
        }
        return applied.dispatchPreparedAfterCommit(
            authority = fence.authority,
            expectedNamespace = fence.expectedNamespace,
        )
    }

    suspend fun resumePersistedRequests(
        fence: AgentTranscriptLifecycleRuntimeFence,
        requestKind: AgentTranscriptLifecycleRequestKind? = null,
    ): List<AgentTranscriptLifecycleRequestSyncResult> {
        if (!fence.isNegotiated()) {
            return listOf(AgentTranscriptLifecycleRequestSyncResult.ExtensionNotNegotiated)
        }
        return resumePersistedRequests(
            context = AgentTranscriptLifecyclePersistedRequestResumeContext(
                authority = fence.authority,
                expectedNamespace = fence.expectedNamespace,
            ),
            requestKind = requestKind,
        )
    }

    suspend fun resumePersistedRequests(
        context: AgentTranscriptLifecyclePersistedRequestResumeContext,
        requestKind: AgentTranscriptLifecycleRequestKind? = null,
    ): List<AgentTranscriptLifecycleRequestSyncResult> {
        return when (val applied = applyLease.withEffectApplyLease(context.authority) {
            durableRepository.loadPreparedRequestsUnderApplyLease(
                context.durableOperationFence(),
            )
        }) {
            RelayV2EffectApplyResult.Stale ->
                listOf(AgentTranscriptLifecycleRequestSyncResult.StaleGeneration)
            is RelayV2EffectApplyResult.Applied -> applied.value
                .filter { requestKind == null || it.requestKind == requestKind }
                .map { prepared ->
                    val request = prepared.toActorRequest(
                        authority = context.authority,
                        expectedNamespace = context.expectedNamespace,
                    )
                    AgentTranscriptLifecycleRequestSyncResult.Dispatched(
                        reduction = null,
                        request = request,
                        admission = requestSender.send(request),
                    )
                }
        }
    }

    /** Replaces one failed admission while the exact durable request is fenced by the apply lease. */
    suspend fun retryFailedAdmission(
        fence: AgentTranscriptLifecycleRuntimeFence,
        failedRequest: AgentTranscriptLifecycleActorRequest,
        failedAdmission: AgentTranscriptLifecycleRequestAdmission,
    ): AgentTranscriptLifecycleRequestSyncResult {
        if (!fence.isNegotiated()) {
            return AgentTranscriptLifecycleRequestSyncResult.ExtensionNotNegotiated
        }
        return failedAdmissionRedrive.retryFailedAdmission(
            context = AgentTranscriptLifecycleFailedAdmissionRedriveContext(
                authority = fence.authority,
                expectedNamespace = fence.expectedNamespace,
            ),
            failedRequest = failedRequest,
            failedAdmission = failedAdmission,
        )
    }

    suspend fun dispatchPostCommitEffect(
        fence: AgentTranscriptLifecycleRuntimeFence,
        effect: AgentTranscriptLifecycleRuntimePostCommitEffect,
    ): AgentTranscriptLifecycleRequestSyncResult = when (effect) {
        is AgentTranscriptLifecycleRuntimePostCommitEffect.Notification ->
            dispatchNotification(fence, effect.intent)
        is AgentTranscriptLifecycleRuntimePostCommitEffect.PreparedRequest -> {
            if (!fence.isNegotiated()) {
                AgentTranscriptLifecycleRequestSyncResult.ExtensionNotNegotiated
            } else if (effect.request.authority != fence.authority) {
                AgentTranscriptLifecycleRequestSyncResult.StaleGeneration
            } else {
                AgentTranscriptLifecycleRequestSyncResult.Dispatched(
                    reduction = null,
                    request = effect.request,
                    admission = requestSender.send(effect.request),
                )
            }
        }
        is AgentTranscriptLifecycleRuntimePostCommitEffect.SyncRequired -> when (val directive = effect.directive) {
            AgentTimelineSyncDirective.None -> AgentTranscriptLifecycleRequestSyncResult.NoRequest
            AgentTimelineSyncDirective.StatusRefresh -> requestStatus(fence)
            is AgentTimelineSyncDirective.Replay -> requestReplay(fence, directive)
            is AgentTimelineSyncDirective.Snapshot -> requestSnapshot(fence, directive)
        }
    }

    private suspend fun dispatchNotification(
        fence: AgentTranscriptLifecycleRuntimeFence,
        intent: AgentSystemNotificationIntent,
    ): AgentTranscriptLifecycleRequestSyncResult {
        if (!fence.isNegotiated()) {
            return AgentTranscriptLifecycleRequestSyncResult.ExtensionNotNegotiated
        }
        return when (
            val admitted = applyLease.withEffectApplyLease(fence.authority) {
                AgentTranscriptLifecycleRequestSyncResult.NotificationReady(intent)
            }
        ) {
            RelayV2EffectApplyResult.Stale ->
                AgentTranscriptLifecycleRequestSyncResult.StaleGeneration
            is RelayV2EffectApplyResult.Applied -> admitted.value
        }
    }

    private fun RelayV2EffectApplyResult<AgentTranscriptLifecycleDurablePrepareRequestResult>
        .dispatchPreparedAfterCommit(
            authority: RelayV2RepositoryEffectAuthority,
            expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
        ): AgentTranscriptLifecycleRequestSyncResult = when (this) {
        RelayV2EffectApplyResult.Stale ->
            AgentTranscriptLifecycleRequestSyncResult.StaleGeneration
        is RelayV2EffectApplyResult.Applied -> {
            val prepared = value.preparedRequest.toActorRequest(
                authority = authority,
                expectedNamespace = expectedNamespace,
            )
            AgentTranscriptLifecycleRequestSyncResult.Dispatched(
                reduction = value.reduction,
                request = prepared,
                admission = requestSender.send(prepared),
            )
        }
    }
}

internal fun AgentTranscriptLifecycleDurablePreparedRequest.toActorRequest(
    fence: AgentTranscriptLifecycleRuntimeFence,
): AgentTranscriptLifecycleActorRequest = toActorRequest(
    authority = fence.authority,
    expectedNamespace = fence.expectedNamespace,
)

private fun AgentTranscriptLifecycleDurablePreparedRequest.toActorRequest(
    authority: RelayV2RepositoryEffectAuthority,
    expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
): AgentTranscriptLifecycleActorRequest {
    val consumer = expectedNamespace.consumer
    return when (this) {
        is AgentTranscriptLifecycleDurablePreparedRequest.Status ->
            AgentTranscriptLifecycleActorRequest.Status(
                authority = authority,
                frame = AgentTimelineStatusGetFrame(
                    requestId = requestNetworkToken,
                    hostId = authority.hostId,
                    expectedHostEpoch = authority.hostEpoch,
                    scopeId = consumer.scopeId,
                    sessionId = consumer.sessionId,
                ),
                requestFence = requestFence,
            )
        is AgentTranscriptLifecycleDurablePreparedRequest.Replay ->
            AgentTranscriptLifecycleActorRequest.Replay(
                authority = authority,
                frame = AgentTimelineReplayGetFrame(
                    requestId = requestNetworkToken,
                    hostId = authority.hostId,
                    expectedHostEpoch = authority.hostEpoch,
                    scopeId = consumer.scopeId,
                    sessionId = consumer.sessionId,
                    request = AgentTimelineReplayRequest(
                        timelineEpoch = lineage.timelineEpoch,
                        afterAgentSeq = pageFence.stableAfterAgentSeq,
                        cursor = pageFence.expectedNextCursor,
                        limit = pageFence.requestedLimit,
                    ),
                ),
            )
        is AgentTranscriptLifecycleDurablePreparedRequest.Snapshot ->
            AgentTranscriptLifecycleActorRequest.Snapshot(
                authority = authority,
                frame = AgentTimelineSnapshotGetFrame(
                    requestId = requestNetworkToken,
                    hostId = authority.hostId,
                    expectedHostEpoch = authority.hostEpoch,
                    scopeId = consumer.scopeId,
                    sessionId = consumer.sessionId,
                    request = AgentTimelineSnapshotRequest(
                        snapshotRequestId = snapshotRequestId,
                        snapshotId = snapshotId,
                        cursor = cursor,
                        nextPageIndex = nextPageIndex,
                    ),
                ),
            )
    }
}

private fun AgentTranscriptLifecycleRuntimeFence.isNegotiated(): Boolean =
    AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY in negotiatedCapabilities

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

private fun AgentTranscriptLifecycleOutboundStatusRequestContext.durableOperationFence() =
    AgentTranscriptLifecycleDurableOperationFence(
        authority = expectedNamespace.consumer,
        expectedNamespace = expectedNamespace,
    )

private fun AgentTranscriptLifecycleFailedAdmissionRedriveContext.durableOperationFence() =
    AgentTranscriptLifecycleDurableOperationFence(
        authority = expectedNamespace.consumer,
        expectedNamespace = expectedNamespace,
    )

private fun AgentTranscriptLifecyclePersistedRequestResumeContext.durableOperationFence() =
    AgentTranscriptLifecycleDurableOperationFence(
        authority = expectedNamespace.consumer,
        expectedNamespace = expectedNamespace,
    )

private fun AgentTranscriptLifecycleDurableNamespace.lineageOrNull(): AgentTimelineLineage? =
    timelineEpoch?.let { AgentTimelineLineage(consumer.sessionIdentity, it) }

private fun AgentTranscriptLifecycleRequestAdmission.matches(
    request: AgentTranscriptLifecycleActorRequest,
): Boolean = authority == request.authority &&
    requestKind == request.kind &&
    requestId == request.requestId

private fun requireRequestAuthority(
    authority: RelayV2RepositoryEffectAuthority,
    hostId: String,
    expectedHostEpoch: String,
) {
    require(authority.hostId == hostId)
    require(authority.hostEpoch == expectedHostEpoch)
}
