package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectApplyResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectApplyLeasePort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import java.util.concurrent.CancellationException

/** Complete actor and durable identity needed to consume one notification intent. */
internal data class AgentTranscriptLifecycleNotificationDispatchRequest(
    val authority: RelayV2RepositoryEffectAuthority,
    val expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
    val intent: AgentSystemNotificationIntent,
)

internal enum class AgentTranscriptLifecycleNotificationDispatchFailureReason {
    DURABLE_CLAIM_FAILED,
}

/** Closed, content-free result. No variant carries a claim ticket or exception detail. */
internal sealed interface AgentTranscriptLifecycleNotificationDispatchResult {
    data object StaleGeneration : AgentTranscriptLifecycleNotificationDispatchResult

    data class Completed(
        val execution: AgentTranscriptLifecycleNotificationExecutionResult,
    ) : AgentTranscriptLifecycleNotificationDispatchResult

    data class Failed(
        val reason: AgentTranscriptLifecycleNotificationDispatchFailureReason,
    ) : AgentTranscriptLifecycleNotificationDispatchResult
}

/**
 * Unwired bridge from a reducer notification intent to its durable claim and platform dispatch.
 *
 * This coordinator owns neither actor nor WebSocket state. It borrows the caller-supplied actor
 * lease across both the complete claim transaction and its post-commit platform dispatch. The
 * durable owner returns a ticket only after the Room transaction commits, so the platform remains
 * outside Room while the same generation barrier prevents a profile switch from overtaking it.
 */
internal class AgentTranscriptLifecycleNotificationDispatchCoordinator(
    private val applyLease: RelayV2RepositoryEffectApplyLeasePort,
    private val durableClaims: AgentTranscriptLifecycleNotificationClaimPort,
    platform: AgentTranscriptLifecycleNotificationPlatformPort,
) {
    private val executor = AgentTranscriptLifecycleNotificationExecutor(platform)

    suspend fun dispatch(
        request: AgentTranscriptLifecycleNotificationDispatchRequest,
    ): AgentTranscriptLifecycleNotificationDispatchResult {
        if (!request.hasExactIdentity()) {
            return completedNotExecutable(
                AgentTranscriptLifecycleNotificationNotExecutableReason.INTENT_NOT_CURRENT,
            )
        }

        val dispatched = try {
            applyLease.withEffectApplyLease(request.authority) {
                val claimed = durableClaims.claimNotificationUnderApplyLease(
                    request.expectedNamespace,
                    request.intent,
                )
                if (claimed is AgentTranscriptLifecycleNotificationClaimResult.Claimed &&
                    (claimed.ticket.namespace != request.expectedNamespace ||
                        claimed.ticket.intent != request.intent)
                ) {
                    AgentTranscriptLifecycleNotificationDispatchResult.Failed(
                        AgentTranscriptLifecycleNotificationDispatchFailureReason
                            .DURABLE_CLAIM_FAILED,
                    )
                } else {
                    AgentTranscriptLifecycleNotificationDispatchResult.Completed(
                        executor.execute(claimed),
                    )
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: RuntimeException) {
            return AgentTranscriptLifecycleNotificationDispatchResult.Failed(
                AgentTranscriptLifecycleNotificationDispatchFailureReason.DURABLE_CLAIM_FAILED,
            )
        }

        return when (dispatched) {
            RelayV2EffectApplyResult.Stale ->
                AgentTranscriptLifecycleNotificationDispatchResult.StaleGeneration
            is RelayV2EffectApplyResult.Applied -> dispatched.value
        }
    }

    private fun AgentTranscriptLifecycleNotificationDispatchRequest.hasExactIdentity(): Boolean {
        val consumer = expectedNamespace.consumer
        return authority.profileId == consumer.profileId &&
            authority.profileActivationGeneration == consumer.profileActivationGeneration &&
            authority.principalId == consumer.principalId &&
            authority.clientInstanceId == consumer.clientInstanceId &&
            authority.hostId == consumer.hostId &&
            authority.hostEpoch == consumer.hostEpoch &&
            AgentTranscriptLifecycleNotificationClaimKey.exactOrNull(
                expectedNamespace,
                intent,
            ) != null
    }

    private fun completedNotExecutable(
        reason: AgentTranscriptLifecycleNotificationNotExecutableReason,
    ) = AgentTranscriptLifecycleNotificationDispatchResult.Completed(
        AgentTranscriptLifecycleNotificationExecutionResult.NotExecutable(reason),
    )
}
