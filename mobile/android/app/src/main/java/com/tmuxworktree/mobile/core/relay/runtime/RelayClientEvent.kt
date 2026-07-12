package com.tmuxworktree.mobile.core.relay.runtime

import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.relay.v1.RelayV1Pane

sealed interface RelayClientEvent {
    data class Ready(val clientId: String, val hostId: String?) : RelayClientEvent

    /**
     * FIFO disconnect marker. Every event caused by commands queued before the matching disconnect
     * action is published before this marker, so consumers can drain to [barrierId] deterministically.
     */
    data class Disconnected(val barrierId: String? = null) : RelayClientEvent

    data class SnapshotUpdated(
        val kind: RelayRequestKind,
        val hostId: String = "",
    ) : RelayClientEvent

    data class WorktreeCreated(
        val requestId: String?,
        val session: RelaySession,
    ) : RelayClientEvent

    data class TerminalCreated(
        val requestId: String?,
        val session: RelaySession,
    ) : RelayClientEvent

    data class AgentMessageSent(
        val requestId: String?,
        val hostId: String,
        val sessionName: String,
        val pane: RelayV1Pane?,
    ) : RelayClientEvent

    data class SessionKilled(
        val requestId: String?,
        val hostId: String,
        val sessionName: String,
    ) : RelayClientEvent

    data class TerminalOpening(
        val streamId: String,
        val hostId: String,
        val sessionName: String,
        val resetDisplay: Boolean,
    ) : RelayClientEvent

    data class TerminalData(val streamId: String, val data: String) : RelayClientEvent
    data class TerminalExit(val streamId: String, val code: Int?) : RelayClientEvent

    data class TerminalReconnecting(
        val hostId: String,
        val sessionName: String,
        val reason: String,
    ) : RelayClientEvent

    data class Error(
        val message: String,
        val request: RelayRequestContext? = null,
        val streamId: String? = null,
    ) : RelayClientEvent

    data class AuthRequired(val message: String) : RelayClientEvent
    data class ProtocolWarning(val message: String, val raw: String = "") : RelayClientEvent
    data class CommandRejected(
        val type: String,
        val reason: String,
        val request: RelayRequestContext? = null,
    ) : RelayClientEvent
}

data class RelayV1ConnectionConfig(
    val relayUrl: String,
    val bearerToken: String,
    val preferredHostId: String = "",
)
