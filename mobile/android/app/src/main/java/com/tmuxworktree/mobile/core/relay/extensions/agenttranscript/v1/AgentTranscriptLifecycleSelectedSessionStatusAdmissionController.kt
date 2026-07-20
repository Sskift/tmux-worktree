package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageException
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
        context: AgentTranscriptLifecycleOutboundStatusRequestContext,
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
 * Selection and capability admission remain owned by
 * [AgentTranscriptLifecycleSessionSelectionController]. The same durable repository chooses the
 * existing namespace for the actor-derived consumer, while
 * [AgentTranscriptLifecycleDurableLoadOrInitializePort] and
 * [AgentTranscriptLifecycleStatusRequestPort] revalidate that exact authority before mutation and
 * send. This controller owns only their ordering and an exact-selection single flight.
 */
internal class AgentTranscriptLifecycleSelectedSessionStatusAdmissionController(
    private val sessionSelection: AgentTranscriptLifecycleSessionSelectionController,
    private val durableRepository: AgentTranscriptLifecycleRuntimeDurableRepository,
    private val durableLoadOrInitialize: AgentTranscriptLifecycleDurableLoadOrInitializePort,
    private val requestSync: AgentTranscriptLifecycleStatusRequestPort,
    private val enabled: Boolean = false,
) {
    private val inFlightMutex = Mutex()
    private val inFlight = mutableMapOf<SelectionKey, StatusFlight>()

    suspend fun requestStatus(
        intent: AgentTranscriptLifecycleSessionSelectionIntent,
    ): AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult {
        if (!enabled) {
            return AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult.Unavailable
        }

        val selected = sessionSelection.withCurrentSession(intent) { current ->
            selectInsideActorReadLease(current, intent)
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
                is LeasedStatusAdmission.Claimed -> executeClaim(value)
            }
        }
    }

    private suspend fun selectInsideActorReadLease(
        current: AgentTranscriptLifecycleCurrentSession,
        intent: AgentTranscriptLifecycleSessionSelectionIntent,
    ): LeasedStatusAdmission {
        val consumer = current.exactConsumer(intent)
            ?: return LeasedStatusAdmission.Unavailable
        val existing = try {
            durableRepository.load(consumer)
        } catch (_: AgentTranscriptLifecyclePersistenceConflictException) {
            return LeasedStatusAdmission.Unavailable
        } catch (_: RelayV2StorageException) {
            return LeasedStatusAdmission.Unavailable
        }
        val namespace = when {
            existing == null -> AgentTranscriptLifecycleDurableNamespace(consumer, null)
            existing.matchesExactly(consumer) -> existing.namespace
            else -> return LeasedStatusAdmission.Unavailable
        }
        val context = AgentTranscriptLifecycleOutboundStatusRequestContext(
            authority = current.authority,
            expectedNamespace = namespace,
        )
        val key = SelectionKey(context)
        return LeasedStatusAdmission.Claimed(
            key = key,
            context = context,
            flight = claimFlight(key),
        )
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
    ): AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult {
        val claimed = claim.flight
        if (!claimed.leader) return claimed.flight.result.await()

        try {
            val result = when (
                durableLoadOrInitialize.loadOrInitialize(
                    authority = claim.context.authority,
                    namespace = claim.context.expectedNamespace,
                )
            ) {
                AgentTranscriptLifecycleDurableLoadOrInitializeResult.Unavailable ->
                    AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult.Unavailable
                AgentTranscriptLifecycleDurableLoadOrInitializeResult.Ready -> when (
                    val synced = requestSync.requestStatus(claim.context)
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

private fun AgentTranscriptLifecycleCurrentSession.exactConsumer(
    intent: AgentTranscriptLifecycleSessionSelectionIntent,
): AgentTranscriptLifecycleDurableConsumerIdentity? {
    val namespace = intent.namespace
    val cut = materializedCut
    if (authority.profileId != namespace.profileId ||
        authority.principalId != namespace.principalId ||
        authority.clientInstanceId != namespace.clientInstanceId ||
        authority.hostId != namespace.hostId ||
        authority.hostEpoch != namespace.hostEpoch ||
        cut.namespace != namespace ||
        cut.cursor.hostEpoch != namespace.hostEpoch ||
        cut.scope.scopeId != intent.scopeId ||
        cut.session.scopeId != intent.scopeId ||
        cut.session.sessionId != intent.sessionId
    ) return null

    return AgentTranscriptLifecycleDurableConsumerIdentity(
        profileId = authority.profileId,
        profileActivationGeneration = authority.profileActivationGeneration,
        principalId = authority.principalId,
        clientInstanceId = authority.clientInstanceId,
        hostId = authority.hostId,
        hostEpoch = authority.hostEpoch,
        scopeId = intent.scopeId,
        sessionId = intent.sessionId,
    )
}

private fun AgentTranscriptLifecycleDurableRecord.matchesExactly(
    consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
): Boolean = namespace.consumer == consumer &&
    state.identity == consumer.sessionIdentity &&
    state.extensionLane.timelineEpoch == namespace.timelineEpoch

private data class SelectionKey(
    val context: AgentTranscriptLifecycleOutboundStatusRequestContext,
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
        val context: AgentTranscriptLifecycleOutboundStatusRequestContext,
        val flight: ClaimedFlight,
    ) : LeasedStatusAdmission
}
