package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1InboundFrame
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectApplyLeasePort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RuntimeEffect

internal sealed interface AgentTranscriptLifecycleRuntimeCompositionResult {
    data class NotOwned(
        val effect: RelayV2RuntimeEffect,
    ) : AgentTranscriptLifecycleRuntimeCompositionResult
    data object Disabled : AgentTranscriptLifecycleRuntimeCompositionResult
    data object ExtensionNotNegotiated : AgentTranscriptLifecycleRuntimeCompositionResult
    data object DurableNamespaceUnavailable : AgentTranscriptLifecycleRuntimeCompositionResult

    data class Consumed(
        val consumption: AgentTranscriptLifecycleRuntimeConsumeResult,
        val notificationDispatches: List<AgentTranscriptLifecycleNotificationDispatchResult>,
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
    nextRequestToken: () -> String = { java.util.UUID.randomUUID().toString() },
) {
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
    private val readProjection = AgentTranscriptLifecycleRoomReadProjection(durableRepository)

    suspend fun handle(
        effect: RelayV2RuntimeEffect,
    ): AgentTranscriptLifecycleRuntimeCompositionResult = when (effect) {
        is RelayV2RuntimeEffect.DeliverAgentExtensionFrame -> {
            if (!enabled) {
                AgentTranscriptLifecycleRuntimeCompositionResult.Disabled
            } else {
                handleAgentFrame(effect)
            }
        }
        // The upper-layer dispatcher owns unavailable routing. If the effect carries an exact
        // failed request/admission identity, that dispatcher can return it to RequestSync's
        // redrive owner without losing its generation fence.
        is RelayV2RuntimeEffect.AgentExtensionUnavailable ->
            AgentTranscriptLifecycleRuntimeCompositionResult.NotOwned(effect)
        else -> AgentTranscriptLifecycleRuntimeCompositionResult.NotOwned(effect)
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
        // not-executable before any platform call.
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
        val notificationResults = postCommitEffects
            .filterIsInstance<AgentTranscriptLifecycleRuntimePostCommitEffect.Notification>()
            .map { notification ->
                notificationDispatch.dispatch(
                    AgentTranscriptLifecycleNotificationDispatchRequest(
                        authority = effect.repositoryAuthority,
                        expectedNamespace = namespace,
                        intent = notification.intent,
                    ),
                )
            }
        return AgentTranscriptLifecycleRuntimeCompositionResult.Consumed(
            consumption = consumption.withoutNotificationEffects(),
            notificationDispatches = notificationResults,
        )
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

private fun AgentTranscriptLifecycleRuntimeConsumeResult.withoutNotificationEffects():
    AgentTranscriptLifecycleRuntimeConsumeResult {
    fun List<AgentTranscriptLifecycleRuntimePostCommitEffect>.withoutNotifications() =
        filterNot { it is AgentTranscriptLifecycleRuntimePostCommitEffect.Notification }

    return when (this) {
        is AgentTranscriptLifecycleRuntimeConsumeResult.Applied -> copy(
            postCommitEffects = postCommitEffects.withoutNotifications(),
        )
        is AgentTranscriptLifecycleRuntimeConsumeResult.ExtensionFault -> copy(
            postCommitEffects = postCommitEffects.withoutNotifications(),
        )
        AgentTranscriptLifecycleRuntimeConsumeResult.ExtensionNotNegotiated,
        is AgentTranscriptLifecycleRuntimeConsumeResult.Unavailable,
        -> this
    }
}
