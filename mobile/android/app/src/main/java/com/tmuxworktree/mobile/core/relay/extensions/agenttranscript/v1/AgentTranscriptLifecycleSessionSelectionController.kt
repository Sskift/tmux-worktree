package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CurrentRepositoryReadAuthorityPort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CurrentRepositoryReadCutResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CurrentRepositoryReadLeaseResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryReadCapability
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2MaterializedSessionReadCut
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateNamespace
import com.tmuxworktree.mobile.core.relay.v2.state.requireRelayV2Id

internal data class AgentTranscriptLifecycleSessionSelectionIntent(
    val namespace: RelayV2StateNamespace,
    val scopeId: String,
    val sessionId: String,
) {
    init {
        requireRelayV2Id(scopeId)
        requireRelayV2Id(sessionId)
    }
}

/** Complete current authority and committed materialized cut, valid only inside the leased block. */
internal data class AgentTranscriptLifecycleCurrentSession(
    val authority: RelayV2RepositoryEffectAuthority,
    val materializedCut: RelayV2MaterializedSessionReadCut,
)

internal sealed interface AgentTranscriptLifecycleCurrentSessionResult<out T> {
    data object Unavailable : AgentTranscriptLifecycleCurrentSessionResult<Nothing>
    data object Stale : AgentTranscriptLifecycleCurrentSessionResult<Nothing>
    data class Current<T>(val value: T) : AgentTranscriptLifecycleCurrentSessionResult<T>
}

/**
 * Default-off selection boundary for the optional Agent extension. It owns no selection, cut, or
 * authority state and is not wired into production composition. A Current result only describes
 * the interval in which [block] ran under the actor-owned read lease.
 */
internal class AgentTranscriptLifecycleSessionSelectionController(
    private val readAuthority: RelayV2CurrentRepositoryReadAuthorityPort,
    private val stateRepositoryRead: suspend (
        RelayV2StateNamespace,
        String,
        String,
    ) -> RelayV2MaterializedSessionReadCut?,
) {
    suspend fun <T> withCurrentSession(
        intent: AgentTranscriptLifecycleSessionSelectionIntent,
        block: suspend (AgentTranscriptLifecycleCurrentSession) -> T,
    ): AgentTranscriptLifecycleCurrentSessionResult<T> {
        val acquired = readAuthority.currentRepositoryReadCut(
            RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE,
        )
        val cut = when (acquired) {
            RelayV2CurrentRepositoryReadCutResult.Unavailable ->
                return AgentTranscriptLifecycleCurrentSessionResult.Unavailable
            is RelayV2CurrentRepositoryReadCutResult.Available -> acquired.cut
        }
        val leased = readAuthority.withCurrentRepositoryReadLease(
            cut = cut,
            block = lease@{
                val authorityNamespace = cut.authority.stateNamespace()
                if (authorityNamespace != intent.namespace) {
                    return@lease LeasedSelection.Unavailable
                }
                val materialized = stateRepositoryRead(
                    authorityNamespace,
                    intent.scopeId,
                    intent.sessionId,
                ) ?: return@lease LeasedSelection.Unavailable
                if (!materialized.matches(intent)) {
                    return@lease LeasedSelection.Unavailable
                }
                LeasedSelection.Selected(
                    block(
                        AgentTranscriptLifecycleCurrentSession(
                            authority = cut.authority,
                            materializedCut = materialized,
                        ),
                    ),
                )
            },
        )
        return when (leased) {
            RelayV2CurrentRepositoryReadLeaseResult.Stale ->
                AgentTranscriptLifecycleCurrentSessionResult.Stale
            is RelayV2CurrentRepositoryReadLeaseResult.Current -> when (val value = leased.value) {
                LeasedSelection.Unavailable ->
                    AgentTranscriptLifecycleCurrentSessionResult.Unavailable
                is LeasedSelection.Selected ->
                    AgentTranscriptLifecycleCurrentSessionResult.Current(value.value)
            }
        }
    }
}

private fun RelayV2RepositoryEffectAuthority.stateNamespace() = RelayV2StateNamespace(
    profileId = profileId,
    principalId = principalId,
    clientInstanceId = clientInstanceId,
    hostId = hostId,
    hostEpoch = hostEpoch,
)

private fun RelayV2MaterializedSessionReadCut.matches(
    intent: AgentTranscriptLifecycleSessionSelectionIntent,
): Boolean = namespace == intent.namespace &&
    cursor.hostEpoch == intent.namespace.hostEpoch &&
    scope.scopeId == intent.scopeId &&
    session.scopeId == intent.scopeId &&
    session.sessionId == intent.sessionId

private sealed interface LeasedSelection<out T> {
    data object Unavailable : LeasedSelection<Nothing>
    data class Selected<T>(val value: T) : LeasedSelection<T>
}
