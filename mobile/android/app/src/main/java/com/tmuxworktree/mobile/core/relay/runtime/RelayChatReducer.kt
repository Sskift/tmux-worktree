package com.tmuxworktree.mobile.core.relay.runtime

import com.tmuxworktree.mobile.core.relay.v1.AgentChatSteeredMessage
import com.tmuxworktree.mobile.core.relay.v1.AgentChatTurnView

/**
 * Per-session agent chat state.
 *
 * Turns are host-authoritative: [RelayChatMutation.HistoryResult] replaces the local turn list for a
 * session after reconnect reconciliation. Pending sends are tracked locally until the host confirms
 * them via [RelayChatMutation.Sent] (which assigns a [AgentChatTurnView.turnId]).
 */
data class RelayChatState(
    val turnsBySession: Map<String, List<AgentChatTurnView>> = emptyMap(),
    val pendingBySession: Map<String, List<PendingChatSend>> = emptyMap(),
) {
    fun turns(session: String): List<AgentChatTurnView> = turnsBySession[session].orEmpty()

    fun pending(session: String): List<PendingChatSend> = pendingBySession[session].orEmpty()

    fun hasAgentChatCapability(hostCapabilities: Set<String>): Boolean =
        AGENT_CHAT_V1_CAPABILITY in hostCapabilities

    companion object {
        const val AGENT_CHAT_V1_CAPABILITY = "agent-chat-v1"
    }
}

data class PendingChatSend(
    val requestId: String,
    val session: String,
    val message: String,
    val sentAtMillis: Long,
    val failed: Boolean = false,
    val error: String? = null,
)

sealed interface RelayChatMutation {
    data class SendPending(
        val requestId: String,
        val session: String,
        val message: String,
        val nowMillis: Long,
    ) : RelayChatMutation

    data class Sent(
        val requestId: String,
        val session: String,
        val turnId: String,
        val nowMillis: Long,
    ) : RelayChatMutation

    data class TurnUpdated(
        val session: String,
        val turn: AgentChatTurnView,
    ) : RelayChatMutation

    data class HistoryResult(
        val session: String,
        val turns: List<AgentChatTurnView>,
    ) : RelayChatMutation

    data class SendFailed(
        val requestId: String,
        val session: String,
        val error: String,
    ) : RelayChatMutation

    data class RetryFailed(val session: String) : RelayChatMutation

    data class ClearSession(val session: String) : RelayChatMutation
}

object RelayChatReducer {
    fun reduce(state: RelayChatState, mutation: RelayChatMutation): RelayChatState = when (mutation) {
        is RelayChatMutation.SendPending -> addPending(state, mutation)
        is RelayChatMutation.Sent -> confirmSent(state, mutation)
        is RelayChatMutation.TurnUpdated -> upsertTurn(state, mutation)
        is RelayChatMutation.HistoryResult -> mergeHistory(state, mutation)
        is RelayChatMutation.SendFailed -> markFailed(state, mutation)
        is RelayChatMutation.RetryFailed -> retryFailed(state, mutation)
        is RelayChatMutation.ClearSession -> clearSession(state, mutation)
    }

    private fun addPending(state: RelayChatState, mutation: RelayChatMutation.SendPending): RelayChatState {
        val pending = state.pending(mutation.session) + PendingChatSend(
            requestId = mutation.requestId,
            session = mutation.session,
            message = mutation.message,
            sentAtMillis = mutation.nowMillis,
        )
        return state.copy(
            pendingBySession = state.pendingBySession + (mutation.session to pending),
        )
    }

    private fun confirmSent(state: RelayChatState, mutation: RelayChatMutation.Sent): RelayChatState {
        val pending = state.pending(mutation.session)
            .filterNot { it.requestId == mutation.requestId }
        val pendingBySession = if (pending.isEmpty()) {
            state.pendingBySession - mutation.session
        } else {
            state.pendingBySession + (mutation.session to pending)
        }
        // The host will push the authoritative working turn via agent_chat_event; we only drop the
        // pending entry here so the UI stops showing the local "sending" bubble.
        return state.copy(pendingBySession = pendingBySession)
    }

    private fun upsertTurn(state: RelayChatState, mutation: RelayChatMutation.TurnUpdated): RelayChatState {
        val turns = state.turns(mutation.session).toMutableList()
        val existingIndex = turns.indexOfFirst { it.turnId == mutation.turn.turnId }
        if (existingIndex >= 0) {
            turns[existingIndex] = mutation.turn
        } else {
            turns += mutation.turn
        }
        turns.sortBy { it.sentAt }
        return state.copy(
            turnsBySession = state.turnsBySession + (mutation.session to turns),
        )
    }

    /**
     * Host-authoritative history merge. Replaces the local turn list for the session with the host's
     * view, deduplicated by [AgentChatTurnView.turnId]. Pending sends that have not been confirmed by
     * the host are retained so the user can see (and retry) them.
     */
    private fun mergeHistory(state: RelayChatState, mutation: RelayChatMutation.HistoryResult): RelayChatState {
        val deduped = mutation.turns
            .distinctBy { it.turnId }
            .sortedBy { it.sentAt }
        return state.copy(
            turnsBySession = state.turnsBySession + (mutation.session to deduped),
        )
    }

    private fun markFailed(state: RelayChatState, mutation: RelayChatMutation.SendFailed): RelayChatState {
        val pending = state.pending(mutation.session).map { item ->
            if (item.requestId == mutation.requestId) {
                item.copy(failed = true, error = mutation.error)
            } else {
                item
            }
        }
        return state.copy(
            pendingBySession = state.pendingBySession + (mutation.session to pending),
        )
    }

    private fun retryFailed(state: RelayChatState, mutation: RelayChatMutation.RetryFailed): RelayChatState {
        val pending = state.pending(mutation.session).map { item ->
            if (item.failed) item.copy(failed = false, error = null) else item
        }
        return state.copy(
            pendingBySession = state.pendingBySession + (mutation.session to pending),
        )
    }

    private fun clearSession(state: RelayChatState, mutation: RelayChatMutation.ClearSession): RelayChatState {
        return state.copy(
            turnsBySession = state.turnsBySession - mutation.session,
            pendingBySession = state.pendingBySession - mutation.session,
        )
    }
}
