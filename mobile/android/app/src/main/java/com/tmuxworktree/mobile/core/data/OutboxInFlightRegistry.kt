package com.tmuxworktree.mobile.core.data

/**
 * Tracks Relay v1 message sends that have been written to the socket but have
 * not received an acknowledgement yet.
 *
 * A non-empty request id is authoritative: an unknown id is a stale ACK and
 * must never fall back to a newer message in the same session. The fallback is
 * only for older relay-host builds that omit requestId entirely.
 */
class OutboxInFlightRegistry {
    private val byRequestId = linkedMapOf<String, OutboxInFlightMessage>()

    @Synchronized
    fun register(message: OutboxInFlightMessage) {
        byRequestId[message.requestId] = message
    }

    @Synchronized
    fun remove(requestId: String?): OutboxInFlightMessage? {
        if (requestId.isNullOrBlank()) return null
        return byRequestId.remove(requestId)
    }

    @Synchronized
    fun resolveAcknowledgement(
        requestId: String?,
        hostId: String,
        sessionName: String,
    ): OutboxInFlightMessage? {
        if (!requestId.isNullOrBlank()) return byRequestId.remove(requestId)
        val match = byRequestId.entries.firstOrNull { (_, pending) ->
            pending.sessionName == sessionName &&
                (hostId.isBlank() || pending.hostId == hostId)
        } ?: return null
        byRequestId.remove(match.key)
        return match.value
    }

    @Synchronized
    fun containsCommand(commandId: String): Boolean =
        byRequestId.values.any { it.commandId == commandId }

    @Synchronized
    fun hasSession(hostId: String, sessionName: String): Boolean =
        byRequestId.values.any { it.hostId == hostId && it.sessionName == sessionName }

    @Synchronized
    fun drainCommandIds(): List<String> = byRequestId.values
        .map(OutboxInFlightMessage::commandId)
        .also { byRequestId.clear() }

    @Synchronized
    fun clear() {
        byRequestId.clear()
    }
}

data class OutboxInFlightMessage(
    val requestId: String,
    val commandId: String,
    val hostId: String,
    val sessionName: String,
)
