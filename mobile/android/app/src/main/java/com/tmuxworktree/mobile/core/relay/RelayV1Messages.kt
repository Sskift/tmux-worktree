package com.tmuxworktree.mobile.core.relay

/** Wire models for the unversioned relay protocol used by the legacy Android client. */
data class RelayV1Host(
    val hostId: String,
    val displayName: String = "",
    val connectedAt: Long = 0,
    val clients: Int = 0,
)

data class RelayV1Session(
    val name: String,
    val rawName: String = "",
    val scopeId: String = "",
    val scopeLabel: String = "",
    val kind: String = "session",
    val project: String = "",
    val label: String = "",
    val cwd: String = "",
    val attached: Boolean = false,
    val windows: Int = 0,
    val created: Long = 0,
    val activity: Long = 0,
)

data class RelayV1ScopeStatus(
    val scopeId: String,
    val scopeLabel: String = "",
    val kind: String = "",
    val reachable: Boolean = false,
    val sessionCount: Int = 0,
    val error: String = "",
)

sealed interface RelayV1Pane {
    data class Number(val value: Int) : RelayV1Pane
    data class Text(val value: String) : RelayV1Pane
}

sealed interface RelayV1Command {
    val type: String

    data class ListHosts(val requestId: String? = null) : RelayV1Command {
        override val type: String = "list_hosts"
    }

    data class ListSessions(
        val hostId: String? = null,
        val requestId: String? = null,
    ) : RelayV1Command {
        override val type: String = "list_sessions"
    }

    data class ListScopeStatuses(
        val hostId: String? = null,
        val requestId: String? = null,
    ) : RelayV1Command {
        override val type: String = "list_scope_statuses"
    }

    data class CreateWorktree(
        val hostId: String? = null,
        val requestId: String? = null,
        val scopeId: String? = null,
        val project: String? = null,
        val path: String? = null,
        val name: String? = null,
        val branch: String? = null,
        val aiCommand: String? = null,
        val aiCmd: String? = null,
    ) : RelayV1Command {
        override val type: String = "create_worktree"
    }

    data class CreateTerminal(
        val hostId: String? = null,
        val requestId: String? = null,
        val scopeId: String? = null,
        val cwd: String,
        val label: String? = null,
    ) : RelayV1Command {
        override val type: String = "create_terminal"
    }

    data class OpenTerminal(
        val hostId: String? = null,
        val streamId: String,
        val session: String,
        val pane: RelayV1Pane? = null,
    ) : RelayV1Command {
        override val type: String = "open_terminal"
    }

    data class SendAgentMessage(
        val hostId: String? = null,
        val requestId: String? = null,
        val session: String,
        val pane: RelayV1Pane? = null,
        val message: String,
        val submit: Boolean? = null,
    ) : RelayV1Command {
        override val type: String = "send_agent_message"
    }

    data class KillSession(
        val hostId: String? = null,
        val requestId: String? = null,
        val session: String,
    ) : RelayV1Command {
        override val type: String = "kill_session"
    }

    data class TerminalInput(
        val streamId: String,
        val data: String,
    ) : RelayV1Command {
        override val type: String = "terminal_input"
    }

    data class Resize(
        val streamId: String,
        val cols: Int,
        val rows: Int,
    ) : RelayV1Command {
        override val type: String = "resize"
    }

    data class CloseTerminal(val streamId: String) : RelayV1Command {
        override val type: String = "close_terminal"
    }
}

sealed interface RelayV1Event {
    val type: String

    data class Ready(
        val clientId: String,
        val hostId: String? = null,
    ) : RelayV1Event {
        override val type: String = "ready"
    }

    data class Hosts(
        val requestId: String? = null,
        val hosts: List<RelayV1Host>,
    ) : RelayV1Event {
        override val type: String = "hosts"
    }

    data class Sessions(
        val requestId: String? = null,
        val sessions: List<RelayV1Session>,
    ) : RelayV1Event {
        override val type: String = "sessions"
    }

    data class ScopeStatuses(
        val requestId: String? = null,
        val scopes: List<RelayV1ScopeStatus>,
    ) : RelayV1Event {
        override val type: String = "scope_statuses"
    }

    data class WorktreeCreated(
        val requestId: String? = null,
        val session: RelayV1Session,
    ) : RelayV1Event {
        override val type: String = "worktree_created"
    }

    data class TerminalCreated(
        val requestId: String? = null,
        val session: RelayV1Session,
    ) : RelayV1Event {
        override val type: String = "terminal_created"
    }

    data class AgentMessageSent(
        val requestId: String? = null,
        val session: String,
        val pane: RelayV1Pane? = null,
    ) : RelayV1Event {
        override val type: String = "agent_message_sent"
    }

    data class SessionKilled(
        val requestId: String? = null,
        val session: String,
    ) : RelayV1Event {
        override val type: String = "session_killed"
    }

    data class TerminalData(
        val streamId: String? = null,
        val data: String,
    ) : RelayV1Event {
        override val type: String = "terminal_data"
    }

    data class TerminalExit(
        val streamId: String? = null,
        val code: Int? = null,
    ) : RelayV1Event {
        override val type: String = "terminal_exit"
    }

    data class Error(
        val requestId: String? = null,
        val streamId: String? = null,
        val message: String = "unknown error",
    ) : RelayV1Event {
        override val type: String = "error"
    }
}

sealed interface RelayV1DecodeResult {
    data class Message(val event: RelayV1Event) : RelayV1DecodeResult
    data class Unknown(val type: String, val raw: String) : RelayV1DecodeResult
    data class Malformed(val reason: String, val raw: String) : RelayV1DecodeResult
}
