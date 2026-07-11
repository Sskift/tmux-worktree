package com.tmuxworktree.mobile.core.relay

import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.TerminalStreamState

enum class RelayRequestKind {
    HOSTS,
    SESSIONS,
    SCOPES,
    CREATE_WORKTREE,
    CREATE_TERMINAL,
    SEND_AGENT_MESSAGE,
    KILL_SESSION,
}

data class RelayRequestContext(
    val requestId: String,
    val kind: RelayRequestKind,
    val epoch: Long,
    val hostId: String = "",
    val sessionName: String = "",
    val latestKey: String? = null,
)

data class RelayRequestResolution(
    val context: RelayRequestContext,
    val isLatest: Boolean,
)

class RelayRequestRegistry {
    private val requests = linkedMapOf<String, RelayRequestContext>()
    private val latest = mutableMapOf<String, String>()

    @Synchronized
    fun register(context: RelayRequestContext) {
        requests[context.requestId] = context
        context.latestKey?.let { latest[it] = context.requestId }
    }

    @Synchronized
    fun resolve(
        requestId: String?,
        consume: Boolean = true,
        expectedKind: RelayRequestKind? = null,
        fallbackLatestKey: String? = null,
        allowLatestForBlank: Boolean = false,
    ): RelayRequestResolution? {
        val resolvedId = if (!requestId.isNullOrEmpty()) {
            requestId
        } else {
            if (!allowLatestForBlank) return null
            fallbackLatestKey
                ?.let(latest::get)
                ?.takeIf(requests::containsKey)
                ?: requests.values
                    .lastOrNull { expectedKind == null || it.kind == expectedKind }
                    ?.requestId
                ?: return null
        }
        val context = requests[resolvedId] ?: return null
        if (expectedKind != null && context.kind != expectedKind) return null
        if (consume) requests.remove(resolvedId)
        return RelayRequestResolution(
            context = context,
            isLatest = context.latestKey?.let { latest[it] == resolvedId } ?: true,
        )
    }

    @Synchronized
    fun remove(requestId: String?) {
        if (requestId.isNullOrEmpty()) return
        requests.remove(requestId)
    }

    @Synchronized
    fun clear() {
        requests.clear()
        latest.clear()
    }

    @Synchronized
    fun drain(): List<RelayRequestContext> {
        val pending = requests.values.toList()
        requests.clear()
        latest.clear()
        return pending
    }

    @Synchronized
    fun size(): Int = requests.size
}

enum class RelayStreamPhase {
    OPENING,
    OPEN,
    RECOVERING,
    CLOSED,
}

data class RelayStreamContext(
    val streamId: String,
    val hostId: String,
    val sessionName: String,
    val pane: RelayV1Pane? = null,
    val generation: Long,
    val phase: RelayStreamPhase = RelayStreamPhase.OPENING,
)

class RelayStreamRegistry {
    private var generation: Long = 0
    private var current: RelayStreamContext? = null

    @Synchronized
    fun open(
        streamId: String,
        hostId: String,
        sessionName: String,
        pane: RelayV1Pane? = null,
    ): RelayStreamContext {
        generation += 1
        return RelayStreamContext(
            streamId = streamId,
            hostId = hostId,
            sessionName = sessionName,
            pane = pane,
            generation = generation,
        ).also { current = it }
    }

    @Synchronized
    fun current(): RelayStreamContext? = current

    /** Empty stream ids are accepted for compatibility with early relay-host builds. */
    @Synchronized
    fun accepts(streamId: String?): Boolean {
        val active = current ?: return false
        return streamId.isNullOrEmpty() || streamId == active.streamId
    }

    @Synchronized
    fun markOpen(streamId: String): RelayStreamContext? = update(streamId, RelayStreamPhase.OPEN)

    @Synchronized
    fun markRecovering(streamId: String): RelayStreamContext? = update(streamId, RelayStreamPhase.RECOVERING)

    @Synchronized
    fun close(streamId: String? = current?.streamId): RelayStreamContext? {
        val active = current ?: return null
        if (!streamId.isNullOrEmpty() && streamId != active.streamId) return null
        current = null
        return active.copy(phase = RelayStreamPhase.CLOSED)
    }

    @Synchronized
    fun clear(): RelayStreamContext? = close()

    @Synchronized
    fun state(status: ConnectionStatus = phaseStatus(current?.phase)): TerminalStreamState {
        val active = current
        return TerminalStreamState(
            streamId = active?.streamId,
            sessionId = active?.let { "${it.hostId}:${it.sessionName}" }.orEmpty(),
            status = status,
            generation = active?.generation ?: generation,
        )
    }

    private fun update(streamId: String, phase: RelayStreamPhase): RelayStreamContext? {
        val active = current ?: return null
        if (active.streamId != streamId) return null
        return active.copy(phase = phase).also { current = it }
    }

    private companion object {
        fun phaseStatus(phase: RelayStreamPhase?): ConnectionStatus = when (phase) {
            RelayStreamPhase.OPENING, RelayStreamPhase.RECOVERING -> ConnectionStatus.RECOVERING
            RelayStreamPhase.OPEN -> ConnectionStatus.ONLINE
            RelayStreamPhase.CLOSED, null -> ConnectionStatus.OFFLINE
        }
    }
}
