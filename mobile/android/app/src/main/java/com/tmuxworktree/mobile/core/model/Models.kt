package com.tmuxworktree.mobile.core.model

enum class AgentState {
    WAITING_FOR_USER,
    RUNNING,
    FAILED,
    COMPLETED,
    UNKNOWN,
}

enum class ConnectionStatus {
    ONLINE,
    RECOVERING,
    PAUSED,
    OFFLINE,
    CONNECTING,
    AUTH_REQUIRED,
    INCOMPATIBLE,
    UNKNOWN,
}

enum class TransportPhase {
    STOPPED,
    WAITING_FOR_NETWORK,
    CONNECTING,
    HANDSHAKING,
    ONLINE,
    BACKING_OFF,
    AUTH_REQUIRED,
    INCOMPATIBLE,
}

enum class DeliveryState {
    QUEUED,
    SENDING,
    ACCEPTED,
    SUCCEEDED,
    CONFIRMING,
    FAILED_RETRYABLE,
    FAILED_FINAL,
    EXPIRED,
    CANCELLED,
    AMBIGUOUS,
}

enum class TimelineActor {
    AGENT,
    USER,
    SYSTEM,
}

data class RelayProfile(
    val relayUrl: String = "",
    val hostId: String = "",
    val autoConnect: Boolean = false,
    val hasCredential: Boolean = false,
)

data class RelayHost(
    val hostId: String,
    val displayName: String = hostId,
    val clients: Int = 0,
    val status: ConnectionStatus = ConnectionStatus.ONLINE,
    val lastSeenAtMillis: Long = 0,
)

data class RelayScope(
    val hostId: String,
    val scopeId: String,
    val label: String = scopeId,
    val kind: String = "local",
    val reachable: Boolean = true,
    val sessionCount: Int = 0,
    val error: String = "",
) {
    val stableId: String get() = "$hostId:$scopeId"
}

data class RelaySession(
    val hostId: String,
    val hostName: String = hostId,
    val name: String,
    val rawName: String = "",
    val scopeId: String = "local",
    val scopeLabel: String = "local",
    val kind: String = "session",
    val project: String = "",
    val label: String = "",
    val cwd: String = "",
    val attached: Boolean = false,
    val windows: Int = 1,
    val createdAtSeconds: Long = 0,
    val activityAtSeconds: Long = 0,
    val agentState: AgentState = AgentState.UNKNOWN,
    val summary: String = "",
    val branch: String = "",
) {
    val stableId: String get() = "$hostId:$name"
    val title: String get() = label.ifBlank { rawName.ifBlank { name } }
    val projectName: String
        get() = project.ifBlank {
            val marker = "/.tmux-worktree/worktrees/"
            val normalized = cwd.trimEnd('/')
            val markerIndex = normalized.indexOf(marker)
            if (markerIndex > 0) {
                normalized.substring(0, markerIndex).substringAfterLast('/')
            } else {
                normalized.substringAfterLast('/').takeIf { it.isNotBlank() } ?: "Workspace"
            }
        }
}

data class TimelineEvent(
    val eventId: String,
    val sessionId: String,
    val actor: TimelineActor,
    val body: String,
    val createdAtMillis: Long,
    val code: String = "",
    val deliveryState: DeliveryState? = null,
)

data class OutboxMessage(
    val commandId: String,
    val requestId: String,
    val hostId: String,
    val sessionName: String,
    val body: String,
    val createdAtMillis: Long,
    val expiresAtMillis: Long,
    val state: DeliveryState = DeliveryState.QUEUED,
    val attemptCount: Int = 0,
    val lastError: String = "",
)

data class HealthLayer(
    val id: String,
    val label: String,
    val status: ConnectionStatus,
    val detail: String,
    val lastSuccessAtMillis: Long = 0,
)

data class ConnectionHealth(
    val phase: TransportPhase = TransportPhase.STOPPED,
    val overall: ConnectionStatus = ConnectionStatus.UNKNOWN,
    val layers: List<HealthLayer> = emptyList(),
    val retryAtMillis: Long? = null,
    val attempt: Int = 0,
    val lastSyncedAtMillis: Long = 0,
    val errorCode: String = "",
    val errorMessage: String = "",
    val protocolLabel: String = "v1 compatibility mode",
)

data class TerminalStreamState(
    val streamId: String? = null,
    val sessionId: String = "",
    val status: ConnectionStatus = ConnectionStatus.OFFLINE,
    val generation: Long = 0,
    val lastOutputSequence: Long = 0,
    val resetReason: String = "",
)

object DemoData {
    private val nowSeconds: Long get() = System.currentTimeMillis() / 1000

    fun sessions(): List<RelaySession> = listOf(
        RelaySession(
            hostId = "mac-admin",
            hostName = "Mac admin",
            name = "tmux-worktree-apk-re",
            rawName = "tmux-worktree-apk-re",
            project = "tmux-worktree",
            cwd = "/Users/bytedance/.tmux-worktree/worktrees/tmux-worktree-apk-re",
            activityAtSeconds = nowSeconds - 120,
            agentState = AgentState.WAITING_FOR_USER,
            summary = "Review is ready. Continue with the migration?",
            branch = "main → feature/mobile-v2",
        ),
        RelaySession(
            hostId = "mac-admin",
            hostName = "Mac admin",
            name = "skfiy-func",
            rawName = "skfiy-func",
            project = "skfiy",
            activityAtSeconds = nowSeconds - 300,
            agentState = AgentState.RUNNING,
            summary = "Testing Android recovery · local",
        ),
        RelaySession(
            hostId = "mac-admin",
            hostName = "Mac admin",
            name = "x-adapter",
            rawName = "x-adapter",
            project = "x",
            scopeId = "mew-dev",
            scopeLabel = "mew-dev",
            activityAtSeconds = nowSeconds - 420,
            agentState = AgentState.RUNNING,
            summary = "Updating relay protocol · mew-dev",
        ),
    )

    fun hosts(): List<RelayHost> = listOf(
        RelayHost(hostId = "mac-admin", displayName = "Mac admin", clients = 1),
    )

    fun scopes(): List<RelayScope> = listOf(
        RelayScope(hostId = "mac-admin", scopeId = "local", label = "local", sessionCount = 2),
        RelayScope(hostId = "mac-admin", scopeId = "mew-dev", label = "mew-dev", kind = "ssh", sessionCount = 1),
    )

    fun health(recovering: Boolean = false): ConnectionHealth {
        val now = System.currentTimeMillis()
        return if (recovering) {
            ConnectionHealth(
                phase = TransportPhase.BACKING_OFF,
                overall = ConnectionStatus.RECOVERING,
                layers = listOf(
                    HealthLayer("phone", "Phone", ConnectionStatus.ONLINE, "Online", now),
                    HealthLayer("relay", "Relay", ConnectionStatus.ONLINE, "Online", now),
                    HealthLayer("host", "Mac admin", ConnectionStatus.RECOVERING, "Reconnecting", now - 60_000),
                    HealthLayer("scope", "local", ConnectionStatus.PAUSED, "Paused", now - 60_000),
                ),
                retryAtMillis = now + 3_000,
                attempt = 2,
                lastSyncedAtMillis = now - 60_000,
                errorCode = "HOST_OFFLINE",
                errorMessage = "Mac admin is reconnecting",
            )
        } else {
            ConnectionHealth(
                phase = TransportPhase.ONLINE,
                overall = ConnectionStatus.ONLINE,
                layers = listOf(
                    HealthLayer("phone", "Phone", ConnectionStatus.ONLINE, "Online", now),
                    HealthLayer("relay", "Relay", ConnectionStatus.ONLINE, "Online", now),
                    HealthLayer("host", "Mac admin", ConnectionStatus.ONLINE, "Online", now),
                    HealthLayer("scope", "local", ConnectionStatus.ONLINE, "Online", now),
                ),
                lastSyncedAtMillis = now,
            )
        }
    }

    fun timeline(sessionId: String): List<TimelineEvent> {
        val now = System.currentTimeMillis()
        return listOf(
            TimelineEvent(
                eventId = "agent-build",
                sessionId = sessionId,
                actor = TimelineActor.AGENT,
                body = "Build passed. Install on the emulator and test recovery?",
                code = "BUILD SUCCESSFUL · API 36",
                createdAtMillis = now - 120_000,
            ),
            TimelineEvent(
                eventId = "user-install",
                sessionId = sessionId,
                actor = TimelineActor.USER,
                body = "Install it and test offline recovery.",
                createdAtMillis = now - 30_000,
                deliveryState = DeliveryState.QUEUED,
            ),
            TimelineEvent(
                eventId = "agent-working",
                sessionId = sessionId,
                actor = TimelineActor.AGENT,
                body = "Working…",
                createdAtMillis = now,
            ),
        )
    }
}
