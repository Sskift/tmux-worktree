package com.tmuxworktree.mobile.core.model

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
