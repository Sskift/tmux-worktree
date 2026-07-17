package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Test

class AgentTranscriptLifecycleNotificationExecutorTest {
    @Test
    fun `only a claimed durable ticket reaches the platform`() {
        val ticket = ticket()
        var platformCalls = 0
        var received: AgentTranscriptLifecycleNotificationExecutionTicket? = null
        val executor = AgentTranscriptLifecycleNotificationExecutor { posted ->
            platformCalls += 1
            received = posted
            AgentTranscriptLifecycleNotificationPlatformResult.Posted
        }

        val notExecutable = executor.execute(
            AgentTranscriptLifecycleNotificationClaimResult.NotExecutable(
                AgentTranscriptLifecycleNotificationNotExecutableReason.ALREADY_CLAIMED,
            ),
        )

        assertEquals(
            AgentTranscriptLifecycleNotificationExecutionResult.NotExecutable(
                AgentTranscriptLifecycleNotificationNotExecutableReason.ALREADY_CLAIMED,
            ),
            notExecutable,
        )
        assertEquals(0, platformCalls)

        val claimed = executor.execute(
            AgentTranscriptLifecycleNotificationClaimResult.Claimed(ticket),
        )

        assertEquals(
            AgentTranscriptLifecycleNotificationExecutionResult.Platform(
                AgentTranscriptLifecycleNotificationPlatformResult.Posted,
            ),
            claimed,
        )
        assertEquals(1, platformCalls)
        assertSame(ticket, received)
    }

    @Test
    fun `platform exception is an explicit content free closed failure`() {
        val forbiddenContent = "entry-text-failure-summary-cwd-terminal-bytes"
        val ticket = ticket(claimId = "claim-id-must-not-escape")
        val executor = AgentTranscriptLifecycleNotificationExecutor {
            throw IllegalStateException(forbiddenContent)
        }

        val result = executor.execute(
            AgentTranscriptLifecycleNotificationClaimResult.Claimed(ticket),
        )

        assertEquals(
            AgentTranscriptLifecycleNotificationExecutionResult.Failed(
                AgentTranscriptLifecycleNotificationExecutionFailureReason.PLATFORM_CALL_FAILED,
            ),
            result,
        )
        assertFalse(result.toString().contains(forbiddenContent))
        assertFalse(result.toString().contains(ticket.claimId))
        assertFalse(result.toString().contains(ticket.namespace.consumer.sessionId))
    }

    private fun ticket(
        claimId: String = "0123456789abcdef".repeat(4),
    ): AgentTranscriptLifecycleNotificationExecutionTicket {
        val consumer = AgentTranscriptLifecycleDurableConsumerIdentity(
            profileId = "profile-notification-executor",
            profileActivationGeneration = 1,
            principalId = "principal-notification-executor",
            clientInstanceId = "client-notification-executor",
            hostId = "host-notification-executor",
            hostEpoch = "host-epoch-notification-executor",
            scopeId = "scope-notification-executor",
            sessionId = "session-notification-executor",
        )
        val timelineEpoch = "timeline-notification-executor"
        return AgentTranscriptLifecycleNotificationExecutionTicket(
            claimId = claimId,
            namespace = AgentTranscriptLifecycleDurableNamespace(consumer, timelineEpoch),
            intent = AgentSystemNotificationIntent(
                AgentNotificationDedupeKey(
                    profileId = consumer.profileId,
                    hostId = consumer.hostId,
                    hostEpoch = consumer.hostEpoch,
                    scopeId = consumer.scopeId,
                    sessionId = consumer.sessionId,
                    timelineEpoch = timelineEpoch,
                    lifecycleEventId = "event-notification-executor",
                    state = AgentLifecycleState.WAITING_FOR_USER,
                ),
                localGeneration = "1",
            ),
        )
    }
}
