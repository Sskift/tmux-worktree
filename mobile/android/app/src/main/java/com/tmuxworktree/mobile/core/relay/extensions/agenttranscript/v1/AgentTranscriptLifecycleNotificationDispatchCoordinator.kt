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
    DURABLE_PUBLICATION_FAILED,
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
 * Bridge from a reducer notification intent to its durable claim and platform dispatch.
 *
 * This coordinator owns neither actor nor WebSocket state. It borrows the caller-supplied actor
 * lease across both the complete claim transaction and its post-commit platform dispatch. The
 * durable owner returns a ticket only after the Room transaction commits, so the platform remains
 * outside Room while the same generation barrier prevents a profile switch from overtaking it.
 */
internal class AgentTranscriptLifecycleNotificationDispatchCoordinator(
    private val applyLease: RelayV2RepositoryEffectApplyLeasePort,
    private val durableClaims: AgentTranscriptLifecycleNotificationClaimPort,
    private val platform: AgentTranscriptLifecycleNotificationPlatformPort,
    private val postedNotifications: AgentTranscriptLifecyclePostedNotificationDurablePort? = null,
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
                    completeDispatch(claimed)
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

    private suspend fun completeDispatch(
        claimed: AgentTranscriptLifecycleNotificationClaimResult,
    ): AgentTranscriptLifecycleNotificationDispatchResult {
        val execution = executor.execute(claimed)
        val ticket = (claimed as? AgentTranscriptLifecycleNotificationClaimResult.Claimed)?.ticket
        if (ticket == null || execution != AgentTranscriptLifecycleNotificationExecutionResult
                .Platform(AgentTranscriptLifecycleNotificationPlatformResult.Posted)
        ) {
            return AgentTranscriptLifecycleNotificationDispatchResult.Completed(execution)
        }
        val durable = postedNotifications ?: return publicationFailure(ticket)
        val marked = try {
            durable.markNotificationPostedUnderApplyLease(ticket)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: RuntimeException) {
            AgentTranscriptLifecycleMarkNotificationPostedResult.UNAVAILABLE
        }
        if (marked == AgentTranscriptLifecycleMarkNotificationPostedResult.MARKED ||
            marked == AgentTranscriptLifecycleMarkNotificationPostedResult.ALREADY_MARKED
        ) {
            return AgentTranscriptLifecycleNotificationDispatchResult.Completed(execution)
        }
        return publicationFailure(ticket)
    }

    private fun publicationFailure(
        ticket: AgentTranscriptLifecycleNotificationExecutionTicket,
    ): AgentTranscriptLifecycleNotificationDispatchResult {
        // The platform side effect escaped but its durable publication barrier did not. Attempt
        // only the same exact tag/id compensation; never retry or republish the notification.
        try {
            platform.cancel(ticket.postedIdentity())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: RuntimeException) {
            // A cancellation failure remains isolated and content-free.
        }
        return AgentTranscriptLifecycleNotificationDispatchResult.Failed(
            AgentTranscriptLifecycleNotificationDispatchFailureReason.DURABLE_PUBLICATION_FAILED,
        )
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

internal sealed interface AgentTranscriptLifecyclePostedNotificationCancellationResult {
    data class Completed(
        val attempted: Int,
        val failed: Int,
    ) : AgentTranscriptLifecyclePostedNotificationCancellationResult

    data object DurableUnavailable : AgentTranscriptLifecyclePostedNotificationCancellationResult
}

/** Profile-isolation adapter; caller supplies the already-drained exact profile activation. */
internal class AgentTranscriptLifecyclePostedNotificationCancellationCoordinator(
    private val durable: AgentTranscriptLifecyclePostedNotificationDurablePort,
    private val platform: AgentTranscriptLifecycleNotificationPlatformPort,
) {
    suspend fun cancelAfterDisconnect(
        profileId: String,
        profileActivationGeneration: Long,
    ): AgentTranscriptLifecyclePostedNotificationCancellationResult {
        var offset = 0
        var attempted = 0
        var failed = 0
        while (true) {
            if (offset >= MAX_TOTAL_SCANNED_CLAIMS) {
                return AgentTranscriptLifecyclePostedNotificationCancellationResult
                    .DurableUnavailable
            }
            val pageLimit = minOf(
                CANCELLATION_PAGE_SIZE,
                MAX_TOTAL_SCANNED_CLAIMS - offset,
            )
            val page = try {
                durable.readPostedNotificationPage(
                    profileId,
                    profileActivationGeneration,
                    offset,
                    pageLimit,
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: RuntimeException) {
                return AgentTranscriptLifecyclePostedNotificationCancellationResult
                    .DurableUnavailable
            }
            if (page.identities.size > pageLimit) {
                return AgentTranscriptLifecyclePostedNotificationCancellationResult
                    .DurableUnavailable
            }
            page.identities.forEach { identity ->
                if (identity.profileId != profileId ||
                    identity.profileActivationGeneration != profileActivationGeneration
                ) {
                    return AgentTranscriptLifecyclePostedNotificationCancellationResult
                        .DurableUnavailable
                }
                if (attempted >= MAX_TOTAL_CANCELLATION_ATTEMPTS) {
                    return AgentTranscriptLifecyclePostedNotificationCancellationResult
                        .DurableUnavailable
                }
                attempted += 1
                val result = try {
                    platform.cancel(identity)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: RuntimeException) {
                    AgentTranscriptLifecycleNotificationCancellationPlatformResult.Failed
                }
                if (result !=
                    AgentTranscriptLifecycleNotificationCancellationPlatformResult.Cancelled
                ) failed += 1
            }
            val next = page.nextOffset
                ?: return AgentTranscriptLifecyclePostedNotificationCancellationResult.Completed(
                    attempted,
                    failed,
                )
            if (next <= offset) {
                return AgentTranscriptLifecyclePostedNotificationCancellationResult
                    .DurableUnavailable
            }
            if (next > MAX_TOTAL_SCANNED_CLAIMS) {
                return AgentTranscriptLifecyclePostedNotificationCancellationResult
                    .DurableUnavailable
            }
            offset = next
        }
    }

    private companion object {
        const val CANCELLATION_PAGE_SIZE = 128
        const val MAX_TOTAL_SCANNED_CLAIMS = 4_096
        const val MAX_TOTAL_CANCELLATION_ATTEMPTS = 4_096
    }
}

private fun AgentTranscriptLifecycleNotificationExecutionTicket.postedIdentity() =
    AgentTranscriptLifecyclePostedNotificationIdentity(
        profileId = namespace.consumer.profileId,
        profileActivationGeneration = namespace.consumer.profileActivationGeneration,
        claimId = claimId,
    )
