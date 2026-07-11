package com.tmuxworktree.mobile.core.data

import com.tmuxworktree.mobile.core.model.DeliveryState
import com.tmuxworktree.mobile.core.model.OutboxMessage

data class OutboxDispatchPlan(
    val markAmbiguous: List<OutboxMessage>,
    val send: List<OutboxMessage>,
)

/**
 * Produces a deterministic Relay v1 dispatch plan without performing IO.
 * Only one message per host/session may be in flight because relay-host applies
 * a reply as multiple tmux writes and does not serialize async client handlers.
 */
object OutboxDispatchPlanner {
    fun plan(
        messages: List<OutboxMessage>,
        isCommandInFlight: (String) -> Boolean,
        isSessionInFlight: (hostId: String, sessionName: String) -> Boolean,
    ): OutboxDispatchPlan {
        val blockedSessions = mutableSetOf<String>()
        val ambiguous = mutableListOf<OutboxMessage>()
        val send = mutableListOf<OutboxMessage>()

        messages.forEach { message ->
            val sessionKey = "${message.hostId}:${message.sessionName}"
            when (message.state) {
                DeliveryState.SENDING,
                DeliveryState.ACCEPTED,
                DeliveryState.CONFIRMING,
                -> {
                    if (!isCommandInFlight(message.commandId)) ambiguous += message
                    blockedSessions += sessionKey
                }
                DeliveryState.AMBIGUOUS -> blockedSessions += sessionKey
                DeliveryState.QUEUED,
                DeliveryState.FAILED_RETRYABLE,
                -> if (sessionKey !in blockedSessions &&
                    !isSessionInFlight(message.hostId, message.sessionName)
                ) {
                    send += message
                    blockedSessions += sessionKey
                }
                else -> Unit
            }
        }
        return OutboxDispatchPlan(ambiguous, send)
    }
}
