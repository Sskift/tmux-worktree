package com.tmuxworktree.mobile.core.relay

data class RelayRequestTimeoutPolicy(
    val hostsMillis: Long = 10_000,
    val sessionsMillis: Long = 10_000,
    val scopesMillis: Long = 10_000,
    val createWorktreeMillis: Long = 60_000,
    val createTerminalMillis: Long = 30_000,
    val sendAgentMessageMillis: Long = 20_000,
    val killSessionMillis: Long = 15_000,
) {
    fun timeoutMillis(kind: RelayRequestKind): Long = when (kind) {
        RelayRequestKind.HOSTS -> hostsMillis
        RelayRequestKind.SESSIONS -> sessionsMillis
        RelayRequestKind.SCOPES -> scopesMillis
        RelayRequestKind.CREATE_WORKTREE -> createWorktreeMillis
        RelayRequestKind.CREATE_TERMINAL -> createTerminalMillis
        RelayRequestKind.SEND_AGENT_MESSAGE -> sendAgentMessageMillis
        RelayRequestKind.KILL_SESSION -> killSessionMillis
    }
}
