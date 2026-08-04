package com.tmuxworktree.mobile.core.data

import com.tmuxworktree.mobile.core.model.AgentState
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.DeliveryState
import com.tmuxworktree.mobile.core.model.OutboxMessage
import com.tmuxworktree.mobile.core.model.RelayHost
import com.tmuxworktree.mobile.core.model.RelayScope
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.model.TimelineActor
import com.tmuxworktree.mobile.core.model.TimelineEvent
import org.junit.Assert.assertEquals
import org.junit.Test

class MappersTest {
    @Test
    fun `relay snapshots round trip without losing protocol identity`() {
        val host = RelayHost("mac-admin", "Mac admin", 2, ConnectionStatus.RECOVERING, 42)
        val scope = RelayScope("mac-admin", "mew-dev", "Mew dev", "ssh", false, 3, "offline")
        val session = RelaySession(
            hostId = "mac-admin",
            hostName = "Mac admin",
            name = "mew-dev:feature",
            rawName = "feature",
            scopeId = "mew-dev",
            scopeLabel = "Mew dev",
            kind = "worktree",
            project = "dashboard",
            label = "Feature",
            cwd = "/repo/dashboard",
            attached = true,
            windows = 3,
            createdAtSeconds = 10,
            activityAtSeconds = 20,
            agentState = AgentState.WAITING_FOR_USER,
            summary = "Needs approval",
            branch = "main -> feature",
        )

        assertEquals(host, host.toEntity().toDomain())
        assertEquals(scope, scope.toEntity().toDomain())
        assertEquals(session, session.toEntity(cachedAtMillis = 99).toDomain())
    }

    @Test
    fun `outbox and timeline round trip delivery state`() {
        val outbox = OutboxMessage(
            commandId = "command-1",
            requestId = "agent-command-1",
            hostId = "host",
            sessionName = "local:demo",
            body = "continue",
            createdAtMillis = 100,
            expiresAtMillis = 200,
            state = DeliveryState.FAILED_RETRYABLE,
            attemptCount = 2,
            lastError = "offline",
        )
        val timeline = TimelineEvent(
            eventId = "event-1",
            sessionId = "host:local:demo",
            actor = TimelineActor.USER,
            body = "continue",
            createdAtMillis = 100,
            deliveryState = DeliveryState.CONFIRMING,
        )

        assertEquals(outbox, outbox.toEntity().toDomain())
        assertEquals(timeline, timeline.toEntity().toDomain())
    }

    @Test
    fun `unknown persisted enum values degrade to safe visible states`() {
        val host = HostEntity("host", "Host", 0, "FUTURE_STATUS", 0)
        val session = SessionEntity(
            hostId = "host",
            hostName = "Host",
            name = "local:demo",
            rawName = "demo",
            scopeId = "local",
            scopeLabel = "local",
            kind = "worktree",
            project = "demo",
            label = "",
            cwd = "/repo/demo",
            attached = false,
            windows = 1,
            createdAtSeconds = 0,
            activityAtSeconds = 0,
            agentState = "FUTURE_AGENT_STATE",
            summary = "",
            branch = "",
            cachedAtMillis = 0,
        )
        val outbox = OutboxEntity(
            commandId = "command",
            requestId = "request",
            hostId = "host",
            sessionName = "local:demo",
            body = "body",
            createdAtMillis = 0,
            expiresAtMillis = 1,
            state = "FUTURE_DELIVERY_STATE",
            attemptCount = 0,
            lastError = "",
        )
        val timeline = TimelineEntity(
            eventId = "event",
            sessionId = "host:local:demo",
            actor = "FUTURE_ACTOR",
            body = "body",
            createdAtMillis = 0,
            code = "",
            deliveryState = "FUTURE_DELIVERY_STATE",
        )

        assertEquals(ConnectionStatus.UNKNOWN, host.toDomain().status)
        assertEquals(AgentState.UNKNOWN, session.toDomain().agentState)
        assertEquals(DeliveryState.AMBIGUOUS, outbox.toDomain().state)
        assertEquals(TimelineActor.SYSTEM, timeline.toDomain().actor)
        assertEquals(DeliveryState.AMBIGUOUS, timeline.toDomain().deliveryState)
    }
}
