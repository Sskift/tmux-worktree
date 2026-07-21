package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1InboundFrame
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CurrentRepositoryReadAuthorityPort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CurrentRepositoryReadCutResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CurrentRepositoryReadLeaseResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectApplyLeasePort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryReadCapability
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RuntimeEffect
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

internal fun interface AgentTranscriptLifecycleRuntimeHandlePort {
    suspend fun handle(
        effect: RelayV2RuntimeEffect,
    ): AgentTranscriptLifecycleRuntimeCompositionResult

    /**
     * Optional post-OnlineReady recovery seam. The default keeps existing lambda/fake handles
     * dormant; only the real Agent composition owns catalog paging and exact durable resume.
     */
    suspend fun recoverPersistedRequestsAfterOnlineReady(
        authority: RelayV2RepositoryEffectAuthority,
        readAuthority: RelayV2CurrentRepositoryReadAuthorityPort,
    ): AgentTranscriptLifecyclePersistedRequestRecoveryResult =
        AgentTranscriptLifecyclePersistedRequestRecoveryResult.Disabled
}

internal sealed interface AgentTranscriptLifecyclePersistedRequestRecoveryResult {
    data object Completed : AgentTranscriptLifecyclePersistedRequestRecoveryResult
    data object SynchronousAdmissionRejected :
        AgentTranscriptLifecyclePersistedRequestRecoveryResult
    data object ExtensionNotNegotiated : AgentTranscriptLifecyclePersistedRequestRecoveryResult
    data object StaleGeneration : AgentTranscriptLifecyclePersistedRequestRecoveryResult
    data object ExtensionFault : AgentTranscriptLifecyclePersistedRequestRecoveryResult
    data object Disabled : AgentTranscriptLifecyclePersistedRequestRecoveryResult
}

internal sealed interface AgentTranscriptLifecycleRuntimeCompositionResult {
    data class NotOwned(
        val effect: RelayV2RuntimeEffect,
    ) : AgentTranscriptLifecycleRuntimeCompositionResult
    data object Disabled : AgentTranscriptLifecycleRuntimeCompositionResult
    data object ExtensionNotNegotiated : AgentTranscriptLifecycleRuntimeCompositionResult
    data object DurableNamespaceUnavailable : AgentTranscriptLifecycleRuntimeCompositionResult
    data object RuntimeFault : AgentTranscriptLifecycleRuntimeCompositionResult

    data class RequestRedrive(
        val result: AgentTranscriptLifecycleRequestSyncResult,
    ) : AgentTranscriptLifecycleRuntimeCompositionResult

    data class Consumed(
        val consumption: AgentTranscriptLifecycleRuntimeConsumeResult,
        val notificationDispatches: List<AgentTranscriptLifecycleNotificationDispatchResult>,
        val requestSyncDispatches: List<AgentTranscriptLifecycleRequestSyncResult>,
    ) : AgentTranscriptLifecycleRuntimeCompositionResult
}

/**
 * Default-off composition seam for the optional Agent transcript/lifecycle runtime.
 *
 * Construction only connects injected owners. It does not create a database, actor, transport,
 * collector, or notification call. An upper layer must explicitly pass each actor effect to
 * [handle]; this class never subscribes to `RelayV2ConnectionActor.effects`.
 */
internal class AgentTranscriptLifecycleRuntimeComposition(
    applyLease: RelayV2RepositoryEffectApplyLeasePort,
    private val durableRepository: AgentTranscriptLifecycleRuntimeDurableRepository,
    durableHandoff: AgentTranscriptLifecycleDurableHandoffPort,
    notificationPlatform: AgentTranscriptLifecycleNotificationPlatformPort,
    private val enabled: Boolean = false,
    requestSender: AgentTranscriptLifecycleExtensionRequestSender? = null,
    nextRequestToken: () -> String = { java.util.UUID.randomUUID().toString() },
) : AgentTranscriptLifecycleRuntimeHandlePort,
    AgentTranscriptLifecycleStatusRequestPort {
    private val runtimeConsumer = AgentTranscriptLifecycleRuntimeConsumer(
        applyLease = applyLease,
        durableRepository = durableRepository,
        durableHandoff = durableHandoff,
        nextRequestToken = nextRequestToken,
    )
    private val notificationDispatch = AgentTranscriptLifecycleNotificationDispatchCoordinator(
        applyLease = applyLease,
        durableClaims = durableRepository,
        platform = notificationPlatform,
    )
    private val requestSync = requestSender?.let { sender ->
        AgentTranscriptLifecycleRequestSyncCoordinator(
            applyLease = applyLease,
            durableRepository = durableRepository,
            requestSender = sender,
            durableHandoff = durableHandoff,
            requestToken = nextRequestToken,
        )
    }
    private val recoveryCatalog =
        durableRepository as? AgentTranscriptLifecycleRecoveryCatalogPort
    private val failedAdmissionRedrive =
        AgentTranscriptLifecycleFailedAdmissionRedriveCoordinator(
            applyLease = applyLease,
            durableRepository = durableRepository,
            durableHandoff = durableHandoff,
        )
    private val readProjection = AgentTranscriptLifecycleRoomReadProjection(durableRepository)

    companion object {
        /**
         * Production durable-consumer seam while capability advertisement remains disabled.
         *
         * The base runtime remains the only effect pump and supplies its actor-owned apply and
         * handoff authorities. System notification delivery deliberately stays disconnected.
         */
        fun dormant(
            applyLease: RelayV2RepositoryEffectApplyLeasePort,
            durableRepository: AgentTranscriptLifecycleRuntimeDurableRepository,
            durableHandoff: AgentTranscriptLifecycleDurableHandoffPort,
            requestSender: AgentTranscriptLifecycleExtensionRequestSender? = null,
        ): AgentTranscriptLifecycleRuntimeComposition =
            AgentTranscriptLifecycleRuntimeComposition(
                applyLease = applyLease,
                durableRepository = durableRepository,
                durableHandoff = durableHandoff,
                notificationPlatform = AgentTranscriptLifecycleNotificationPlatformPort {
                    AgentTranscriptLifecycleNotificationPlatformResult.Suppressed(
                        AgentTranscriptLifecycleNotificationSuppressionReason
                            .NOTIFICATIONS_DISABLED,
                    )
                },
                enabled = true,
                requestSender = requestSender,
            )
    }

    override suspend fun handle(
        effect: RelayV2RuntimeEffect,
    ): AgentTranscriptLifecycleRuntimeCompositionResult = when (effect) {
        is RelayV2RuntimeEffect.DeliverAgentExtensionFrame -> {
            if (!enabled) {
                AgentTranscriptLifecycleRuntimeCompositionResult.Disabled
            } else {
                handleAgentFrame(effect)
            }
        }
        is RelayV2RuntimeEffect.AgentExtensionUnavailable ->
            handleAgentUnavailable(effect)
        else -> AgentTranscriptLifecycleRuntimeCompositionResult.NotOwned(effect)
    }

    override suspend fun recoverPersistedRequestsAfterOnlineReady(
        authority: RelayV2RepositoryEffectAuthority,
        readAuthority: RelayV2CurrentRepositoryReadAuthorityPort,
    ): AgentTranscriptLifecyclePersistedRequestRecoveryResult {
        if (!enabled) return AgentTranscriptLifecyclePersistedRequestRecoveryResult.Disabled
        val catalog = recoveryCatalog
            ?: return AgentTranscriptLifecyclePersistedRequestRecoveryResult.Disabled
        val coordinator = requestSync
            ?: return AgentTranscriptLifecyclePersistedRequestRecoveryResult.Disabled
        val catalogAuthority = AgentTranscriptLifecycleRecoveryCatalogAuthority(
            profileId = authority.profileId,
            profileActivationGeneration = authority.profileActivationGeneration,
            principalId = authority.principalId,
            clientInstanceId = authority.clientInstanceId,
            hostId = authority.hostId,
            hostEpoch = authority.hostEpoch,
        )
        var cursor: AgentTranscriptLifecycleRecoveryCatalogCursor? = null
        while (true) {
            currentCoroutineContext().ensureActive()
            val cut = when (val current = readAuthority.currentRepositoryReadCut(
                RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE,
            )) {
                RelayV2CurrentRepositoryReadCutResult.Unavailable ->
                    return AgentTranscriptLifecyclePersistedRequestRecoveryResult
                        .ExtensionNotNegotiated
                is RelayV2CurrentRepositoryReadCutResult.Available -> current.cut
            }
            if (cut.authority != authority) {
                return AgentTranscriptLifecyclePersistedRequestRecoveryResult.StaleGeneration
            }
            val leasedPage = try {
                readAuthority.withCurrentRepositoryReadLease(cut) {
                    catalog.readRecoveryNamespacePage(
                        authority = catalogAuthority,
                        cursor = cursor,
                        limit = AGENT_TRANSCRIPT_LIFECYCLE_RECOVERY_CATALOG_PAGE_LIMIT,
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                return AgentTranscriptLifecyclePersistedRequestRecoveryResult.ExtensionFault
            }
            val page = when (leasedPage) {
                RelayV2CurrentRepositoryReadLeaseResult.Stale ->
                    return AgentTranscriptLifecyclePersistedRequestRecoveryResult.StaleGeneration
                is RelayV2CurrentRepositoryReadLeaseResult.Current -> leasedPage.value
            }

            // The catalog lease has been released. Each candidate now re-enters the existing A3f
            // exact prepared-request read; a catalog row is never treated as prepared evidence.
            for (candidate in page.candidates) {
                currentCoroutineContext().ensureActive()
                if (!catalogAuthority.owns(candidate.consumer)) {
                    return AgentTranscriptLifecyclePersistedRequestRecoveryResult.ExtensionFault
                }
                val results = try {
                    coordinator.resumePersistedRequests(
                        AgentTranscriptLifecyclePersistedRequestResumeContext(
                            authority = authority,
                            expectedNamespace = candidate,
                        ),
                    )
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Throwable) {
                    return AgentTranscriptLifecyclePersistedRequestRecoveryResult.ExtensionFault
                }
                for (result in results) {
                    when (result) {
                        is AgentTranscriptLifecycleRequestSyncResult.Dispatched ->
                            if (result.admission == null) {
                                return AgentTranscriptLifecyclePersistedRequestRecoveryResult
                                    .SynchronousAdmissionRejected
                            }
                        AgentTranscriptLifecycleRequestSyncResult.StaleGeneration ->
                            return AgentTranscriptLifecyclePersistedRequestRecoveryResult
                                .StaleGeneration
                        AgentTranscriptLifecycleRequestSyncResult.ExtensionNotNegotiated ->
                            return AgentTranscriptLifecyclePersistedRequestRecoveryResult
                                .ExtensionNotNegotiated
                        AgentTranscriptLifecycleRequestSyncResult.NoRequest,
                        is AgentTranscriptLifecycleRequestSyncResult.NotificationReady,
                        -> Unit
                    }
                }
            }
            val next = page.nextCursor
                ?: return AgentTranscriptLifecyclePersistedRequestRecoveryResult.Completed
            if (page.candidates.isEmpty()) {
                return AgentTranscriptLifecyclePersistedRequestRecoveryResult.ExtensionFault
            }
            cursor = next
        }
    }

    override suspend fun requestStatus(
        context: AgentTranscriptLifecycleOutboundStatusRequestContext,
    ): AgentTranscriptLifecycleRequestSyncResult {
        if (!enabled) {
            return AgentTranscriptLifecycleRequestSyncResult.ExtensionNotNegotiated
        }
        val coordinator = requestSync
            ?: return AgentTranscriptLifecycleRequestSyncResult.ExtensionNotNegotiated
        return coordinator.requestStatus(context)
    }

    suspend fun read(
        request: AgentTranscriptLifecycleReadRequest,
    ): AgentTranscriptLifecycleReadState = if (enabled) {
        readProjection.read(request)
    } else {
        AgentTranscriptLifecycleReadState.Unavailable(
            AgentTranscriptLifecycleReadUnavailableReason.EXTENSION_NOT_NEGOTIATED,
        )
    }

    private suspend fun handleAgentFrame(
        effect: RelayV2RuntimeEffect.DeliverAgentExtensionFrame,
    ): AgentTranscriptLifecycleRuntimeCompositionResult {
        if (AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY !in effect.context.negotiatedCapabilities) {
            return AgentTranscriptLifecycleRuntimeCompositionResult.ExtensionNotNegotiated
        }
        val frame = effect.artifact.frame as? AgentTranscriptLifecycleV1InboundFrame
            ?: throw IllegalArgumentException("Agent runtime effect must carry an inbound artifact")
        val consumer = AgentTranscriptLifecycleDurableConsumerIdentity(
            profileId = effect.repositoryAuthority.profileId,
            profileActivationGeneration = effect.repositoryAuthority.profileActivationGeneration,
            principalId = effect.repositoryAuthority.principalId,
            clientInstanceId = effect.repositoryAuthority.clientInstanceId,
            hostId = effect.repositoryAuthority.hostId,
            hostEpoch = effect.repositoryAuthority.hostEpoch,
            scopeId = frame.scopeId,
            sessionId = frame.sessionId,
        )
        // This read-only transaction selects a candidate namespace; it grants no mutation
        // authority. The consumer subsequently enters the actor-owned generation lease, so a
        // stale generation performs no mutation. Its durable transaction then re-loads and
        // exact-matches the namespace. After a frame commit, notification dispatch takes another
        // generation lease and exact claim transaction; namespace changes close as conflict or
        // not-executable before any platform call. When the default-off sender is installed, the
        // existing RequestSync owner consumes the remaining effects only after this durable
        // consume and handoff return.
        val namespace = durableRepository.load(consumer)?.namespace
            ?: return AgentTranscriptLifecycleRuntimeCompositionResult.DurableNamespaceUnavailable
        val fence = AgentTranscriptLifecycleRuntimeFence(
            authority = effect.repositoryAuthority,
            expectedNamespace = namespace,
            negotiatedCapabilities = effect.context.negotiatedCapabilities,
            ingress = effect.ingress,
            requestAdmission = effect.requestAdmission,
        )
        val consumption = runtimeConsumer.consume(effect.artifact, fence)
        val postCommitEffects = consumption.postCommitEffects()
        val notificationResults = mutableListOf<AgentTranscriptLifecycleNotificationDispatchResult>()
        val requestSyncResults = mutableListOf<AgentTranscriptLifecycleRequestSyncResult>()
        postCommitEffects.forEach { postCommitEffect ->
            when (postCommitEffect) {
                is AgentTranscriptLifecycleRuntimePostCommitEffect.Notification -> {
                    notificationResults += notificationDispatch.dispatch(
                        AgentTranscriptLifecycleNotificationDispatchRequest(
                            authority = effect.repositoryAuthority,
                            expectedNamespace = namespace,
                            intent = postCommitEffect.intent,
                        ),
                    )
                }
                else -> requestSync?.let { coordinator ->
                    requestSyncResults += coordinator.dispatchPostCommitEffect(
                        fence,
                        postCommitEffect,
                    )
                }
            }
        }
        return AgentTranscriptLifecycleRuntimeCompositionResult.Consumed(
            consumption = consumption.withoutDispatchedEffects(
                requestSyncEnabled = requestSync != null,
            ),
            notificationDispatches = notificationResults,
            requestSyncDispatches = requestSyncResults,
        )
    }

    private suspend fun handleAgentUnavailable(
        effect: RelayV2RuntimeEffect.AgentExtensionUnavailable,
    ): AgentTranscriptLifecycleRuntimeCompositionResult {
        val failedRequest = effect.failedRequest
            ?: return AgentTranscriptLifecycleRuntimeCompositionResult.NotOwned(effect)
        val failedAdmission = effect.requestAdmission
            ?: return AgentTranscriptLifecycleRuntimeCompositionResult.NotOwned(effect)
        if (!enabled) return AgentTranscriptLifecycleRuntimeCompositionResult.Disabled
        if (AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY !in effect.context.negotiatedCapabilities) {
            return AgentTranscriptLifecycleRuntimeCompositionResult.ExtensionNotNegotiated
        }

        val consumer = AgentTranscriptLifecycleDurableConsumerIdentity(
            profileId = effect.repositoryAuthority.profileId,
            profileActivationGeneration =
                effect.repositoryAuthority.profileActivationGeneration,
            principalId = effect.repositoryAuthority.principalId,
            clientInstanceId = effect.repositoryAuthority.clientInstanceId,
            hostId = effect.repositoryAuthority.hostId,
            hostEpoch = effect.repositoryAuthority.hostEpoch,
            scopeId = failedRequest.scopeId,
            sessionId = failedRequest.sessionId,
        )
        val namespace = durableRepository.load(consumer)?.namespace
            ?: return AgentTranscriptLifecycleRuntimeCompositionResult
                .DurableNamespaceUnavailable
        if (namespace.consumer != consumer) {
            return AgentTranscriptLifecycleRuntimeCompositionResult
                .DurableNamespaceUnavailable
        }
        val result = failedAdmissionRedrive.retryFailedAdmission(
            context = AgentTranscriptLifecycleFailedAdmissionRedriveContext(
                authority = effect.repositoryAuthority,
                expectedNamespace = namespace,
            ),
            failedRequest = failedRequest,
            failedAdmission = failedAdmission,
        )
        return AgentTranscriptLifecycleRuntimeCompositionResult.RequestRedrive(result)
    }
}

private fun AgentTranscriptLifecycleRuntimeConsumeResult.postCommitEffects():
    List<AgentTranscriptLifecycleRuntimePostCommitEffect> = when (this) {
    is AgentTranscriptLifecycleRuntimeConsumeResult.Applied -> postCommitEffects
    is AgentTranscriptLifecycleRuntimeConsumeResult.ExtensionFault -> postCommitEffects
    AgentTranscriptLifecycleRuntimeConsumeResult.ExtensionNotNegotiated,
    is AgentTranscriptLifecycleRuntimeConsumeResult.Unavailable,
    -> emptyList()
}

private fun AgentTranscriptLifecycleRuntimeConsumeResult.withoutDispatchedEffects(
    requestSyncEnabled: Boolean,
): AgentTranscriptLifecycleRuntimeConsumeResult {
    fun List<AgentTranscriptLifecycleRuntimePostCommitEffect>.withoutDispatched() = filter { effect ->
        effect !is AgentTranscriptLifecycleRuntimePostCommitEffect.Notification &&
            !requestSyncEnabled
    }

    return when (this) {
        is AgentTranscriptLifecycleRuntimeConsumeResult.Applied -> copy(
            postCommitEffects = postCommitEffects.withoutDispatched(),
        )
        is AgentTranscriptLifecycleRuntimeConsumeResult.ExtensionFault -> copy(
            postCommitEffects = postCommitEffects.withoutDispatched(),
        )
        AgentTranscriptLifecycleRuntimeConsumeResult.ExtensionNotNegotiated,
        is AgentTranscriptLifecycleRuntimeConsumeResult.Unavailable,
        -> this
    }
}
