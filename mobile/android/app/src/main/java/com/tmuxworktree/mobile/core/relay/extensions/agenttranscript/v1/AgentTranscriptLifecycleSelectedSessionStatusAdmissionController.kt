package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Narrow durable owner used by selected-Session status admission.
 *
 * The implementation owns any apply lease and load-or-initialize transaction. A ready result only
 * says that the exact requested namespace is durable; it exposes no record or mutable state.
 */
internal fun interface AgentTranscriptLifecycleDurableLoadOrInitializePort {
    suspend fun loadOrInitialize(
        authority: RelayV2RepositoryEffectAuthority,
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): AgentTranscriptLifecycleDurableLoadOrInitializeResult
}

internal sealed interface AgentTranscriptLifecycleDurableLoadOrInitializeResult {
    data object Ready : AgentTranscriptLifecycleDurableLoadOrInitializeResult
    data object Unavailable : AgentTranscriptLifecycleDurableLoadOrInitializeResult
}

/** Narrow view of the existing request-sync owner; it alone prepares a token and sends. */
internal fun interface AgentTranscriptLifecycleStatusRequestPort {
    suspend fun requestStatus(
        fence: AgentTranscriptLifecycleRuntimeFence,
    ): AgentTranscriptLifecycleRequestSyncResult
}

internal sealed interface AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult {
    data object Unavailable : AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult

    data class Requested(
        val syncResult: AgentTranscriptLifecycleRequestSyncResult,
    ) : AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult
}

/**
 * Default-off lower composition for one selected-Session Agent status request.
 *
 * Selection remains owned by [AgentTranscriptLifecycleSessionSelectionController], durable state
 * by [AgentTranscriptLifecycleDurableLoadOrInitializePort], and request token commit plus actor
 * send by [AgentTranscriptLifecycleStatusRequestPort]. This controller owns only their ordering and
 * an exact-selection single flight.
 */
internal class AgentTranscriptLifecycleSelectedSessionStatusAdmissionController(
    private val sessionSelection: AgentTranscriptLifecycleSessionSelectionController,
    private val durableLoadOrInitialize: AgentTranscriptLifecycleDurableLoadOrInitializePort,
    private val requestSync: AgentTranscriptLifecycleStatusRequestPort,
    private val enabled: Boolean = false,
) {
    private val inFlightMutex = Mutex()
    private val inFlight = mutableMapOf<SelectionKey, StatusFlight>()

    suspend fun requestStatus(
        intent: AgentTranscriptLifecycleSessionSelectionIntent,
        authority: AgentTranscriptLifecycleRuntimeFence,
    ): AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult {
        if (!enabled || AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY !in authority.negotiatedCapabilities) {
            return AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult.Unavailable
        }

        val selected = sessionSelection.withCurrentSession(intent) { current ->
            val key = current.exactSelectionKey(intent, authority)
                ?: return@withCurrentSession LeasedStatusAdmission.Unavailable
            LeasedStatusAdmission.Claimed(key, claimFlight(key))
        }
        return when (selected) {
            AgentTranscriptLifecycleCurrentSessionResult.Unavailable,
            AgentTranscriptLifecycleCurrentSessionResult.Stale,
            -> AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult.Unavailable
            is AgentTranscriptLifecycleCurrentSessionResult.Current -> when (
                val value = selected.value
            ) {
                LeasedStatusAdmission.Unavailable ->
                    AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult.Unavailable
                is LeasedStatusAdmission.Claimed -> executeClaim(value, authority)
            }
        }
    }

    private suspend fun claimFlight(
        key: SelectionKey,
    ): ClaimedFlight = inFlightMutex.withLock {
        val existing = inFlight[key]
        if (existing != null) {
            ClaimedFlight(existing, leader = false)
        } else {
            val created = StatusFlight()
            inFlight[key] = created
            ClaimedFlight(created, leader = true)
        }
    }

    private suspend fun executeClaim(
        claim: LeasedStatusAdmission.Claimed,
        authority: AgentTranscriptLifecycleRuntimeFence,
    ): AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult {
        val claimed = claim.flight
        if (!claimed.leader) return claimed.flight.result.await()

        try {
            val result = when (
                durableLoadOrInitialize.loadOrInitialize(
                    authority = authority.authority,
                    namespace = authority.expectedNamespace,
                )
            ) {
                AgentTranscriptLifecycleDurableLoadOrInitializeResult.Unavailable ->
                    AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult.Unavailable
                AgentTranscriptLifecycleDurableLoadOrInitializeResult.Ready -> when (
                    val synced = requestSync.requestStatus(authority)
                ) {
                    is AgentTranscriptLifecycleRequestSyncResult.Dispatched ->
                        AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult.Requested(
                            synced,
                        )
                    AgentTranscriptLifecycleRequestSyncResult.ExtensionNotNegotiated,
                    AgentTranscriptLifecycleRequestSyncResult.NoRequest,
                    is AgentTranscriptLifecycleRequestSyncResult.NotificationReady,
                    AgentTranscriptLifecycleRequestSyncResult.StaleGeneration,
                    -> AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult.Unavailable
                }
            }
            claimed.flight.result.complete(result)
            return result
        } catch (failure: Throwable) {
            claimed.flight.result.completeExceptionally(failure)
            throw failure
        } finally {
            withContext(NonCancellable) {
                inFlightMutex.withLock {
                    if (inFlight[claim.key] === claimed.flight) inFlight.remove(claim.key)
                }
            }
        }
    }
}

private fun AgentTranscriptLifecycleCurrentSession.exactSelectionKey(
    intent: AgentTranscriptLifecycleSessionSelectionIntent,
    requested: AgentTranscriptLifecycleRuntimeFence,
): SelectionKey? {
    if (authority != requested.authority) return null
    val consumer = AgentTranscriptLifecycleDurableConsumerIdentity(
        profileId = authority.profileId,
        profileActivationGeneration = authority.profileActivationGeneration,
        principalId = authority.principalId,
        clientInstanceId = authority.clientInstanceId,
        hostId = authority.hostId,
        hostEpoch = authority.hostEpoch,
        scopeId = intent.scopeId,
        sessionId = intent.sessionId,
    )
    if (requested.expectedNamespace.consumer != consumer) return null
    return SelectionKey(
        intent = intent,
        authority = authority,
        namespace = requested.expectedNamespace,
    )
}

private data class SelectionKey(
    val intent: AgentTranscriptLifecycleSessionSelectionIntent,
    val authority: RelayV2RepositoryEffectAuthority,
    val namespace: AgentTranscriptLifecycleDurableNamespace,
)

private class StatusFlight {
    val result =
        CompletableDeferred<AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult>()
}

private data class ClaimedFlight(
    val flight: StatusFlight,
    val leader: Boolean,
)

private sealed interface LeasedStatusAdmission {
    data object Unavailable : LeasedStatusAdmission

    data class Claimed(
        val key: SelectionKey,
        val flight: ClaimedFlight,
    ) : LeasedStatusAdmission
}
