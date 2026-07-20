package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2MaterializedSessionReadCut
import kotlinx.coroutines.CancellationException

/**
 * Closed selected-Session read result. Neither unavailable branch retains an older page.
 *
 * [Page] is immutable evidence captured while the actor read lease was held. It does not claim
 * that its Session or Agent source remains current after the controller read returns.
 */
internal sealed interface AgentTranscriptLifecycleSelectedSessionReadResult {
    data object Disabled : AgentTranscriptLifecycleSelectedSessionReadResult
    data object Unavailable : AgentTranscriptLifecycleSelectedSessionReadResult
    data object Stale : AgentTranscriptLifecycleSelectedSessionReadResult

    data class Page(
        val materializedSession: RelayV2MaterializedSessionReadCut,
        val presentation: AgentTranscriptLifecyclePresentation.Page,
    ) : AgentTranscriptLifecycleSelectedSessionReadResult
}

/**
 * Default-off read-only bridge from an exact selected Relay v2 Session to durable Agent rows.
 *
 * This controller owns no selection, authority, lineage, support, cursor, or page state. The
 * selection controller first enters the actor-owned current read lease. Inside that lease this
 * controller derives the complete durable consumer from the actor authority and opaque Session
 * intent, loads the current durable record, reads the same repository through its revision-pinned
 * projection, and maps only those structured rows through the existing presentation mapper.
 */
internal class AgentTranscriptLifecycleSelectedSessionReadController(
    private val sessionSelection: AgentTranscriptLifecycleSessionSelectionController,
    private val durableRepository: AgentTranscriptLifecycleRuntimeDurableRepository,
    private val enabled: Boolean = false,
) {
    private val readProjection = AgentTranscriptLifecycleRoomReadProjection(durableRepository)

    suspend fun read(
        intent: AgentTranscriptLifecycleSessionSelectionIntent,
        cursor: AgentTranscriptLifecycleReadCursor?,
        limit: Int,
    ): AgentTranscriptLifecycleSelectedSessionReadResult {
        if (!enabled) return AgentTranscriptLifecycleSelectedSessionReadResult.Disabled
        require(limit in 1..AGENT_TRANSCRIPT_LIFECYCLE_READ_PAGE_LIMIT) {
            "Agent selected-Session read limit is out of bounds"
        }

        return when (val selected = sessionSelection.withCurrentSession(intent) { current ->
            readCurrentSession(current, intent, cursor, limit)
        }) {
            AgentTranscriptLifecycleCurrentSessionResult.Unavailable ->
                AgentTranscriptLifecycleSelectedSessionReadResult.Unavailable
            AgentTranscriptLifecycleCurrentSessionResult.Stale ->
                AgentTranscriptLifecycleSelectedSessionReadResult.Stale
            is AgentTranscriptLifecycleCurrentSessionResult.Current -> when (
                val value = selected.value
            ) {
                LeasedSelectedSessionRead.Unavailable ->
                    AgentTranscriptLifecycleSelectedSessionReadResult.Unavailable
                is LeasedSelectedSessionRead.Page ->
                    AgentTranscriptLifecycleSelectedSessionReadResult.Page(
                        materializedSession = value.materializedSession,
                        presentation = value.presentation,
                    )
            }
        }
    }

    private suspend fun readCurrentSession(
        current: AgentTranscriptLifecycleCurrentSession,
        intent: AgentTranscriptLifecycleSessionSelectionIntent,
        cursor: AgentTranscriptLifecycleReadCursor?,
        limit: Int,
    ): LeasedSelectedSessionRead {
        if (!current.matches(intent)) return LeasedSelectedSessionRead.Unavailable

        val authority = current.authority
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
        val record = try {
            durableRepository.load(consumer)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return LeasedSelectedSessionRead.Unavailable
        } ?: return LeasedSelectedSessionRead.Unavailable
        if (!record.matches(consumer)) return LeasedSelectedSessionRead.Unavailable

        val extension = record.state.extensionLane
        val readState = readProjection.read(
            AgentTranscriptLifecycleReadRequest(
                selectedNamespace = record.namespace,
                access = AgentTranscriptLifecycleReadAccess(
                    // The actor-issued read lease is available only after an exact v2 welcome and
                    // the single requested capability is in the negotiated three-party cut.
                    dialect = AgentTranscriptLifecycleReadDialect.RELAY_V2,
                    negotiatedCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
                    support = extension.support,
                    activeNamespace = record.namespace,
                ),
                cursor = cursor,
                limit = limit,
            ),
        )
        return when (val presentation = AgentTranscriptLifecyclePresentationMapper.map(readState)) {
            AgentTranscriptLifecyclePresentation.Unavailable ->
                LeasedSelectedSessionRead.Unavailable
            is AgentTranscriptLifecyclePresentation.Page -> {
                if (presentation.namespace != record.namespace) {
                    LeasedSelectedSessionRead.Unavailable
                } else {
                    LeasedSelectedSessionRead.Page(
                        materializedSession = current.materializedCut,
                        presentation = presentation,
                    )
                }
            }
        }
    }
}

private fun AgentTranscriptLifecycleCurrentSession.matches(
    intent: AgentTranscriptLifecycleSessionSelectionIntent,
): Boolean {
    val authority = authority
    val namespace = intent.namespace
    val cut = materializedCut
    return authority.profileId == namespace.profileId &&
        authority.principalId == namespace.principalId &&
        authority.clientInstanceId == namespace.clientInstanceId &&
        authority.hostId == namespace.hostId &&
        authority.hostEpoch == namespace.hostEpoch &&
        cut.namespace == namespace &&
        cut.cursor.hostEpoch == namespace.hostEpoch &&
        cut.scope.scopeId == intent.scopeId &&
        cut.session.scopeId == intent.scopeId &&
        cut.session.sessionId == intent.sessionId
}

private fun AgentTranscriptLifecycleDurableRecord.matches(
    consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
): Boolean = namespace.consumer == consumer &&
    state.identity == consumer.sessionIdentity &&
    state.extensionLane.timelineEpoch == namespace.timelineEpoch

private sealed interface LeasedSelectedSessionRead {
    data object Unavailable : LeasedSelectedSessionRead

    data class Page(
        val materializedSession: RelayV2MaterializedSessionReadCut,
        val presentation: AgentTranscriptLifecyclePresentation.Page,
    ) : LeasedSelectedSessionRead
}
