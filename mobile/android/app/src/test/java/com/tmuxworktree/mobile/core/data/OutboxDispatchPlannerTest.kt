package com.tmuxworktree.mobile.core.data

import com.tmuxworktree.mobile.core.model.DeliveryState
import com.tmuxworktree.mobile.core.model.OutboxMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboxDispatchPlannerTest {
    @Test
    fun sendsOnlyFirstQueuedMessagePerSessionButAllowsDifferentSessions() {
        val first = message("one", "session-a")
        val second = message("two", "session-a")
        val other = message("three", "session-b")

        val plan = OutboxDispatchPlanner.plan(
            listOf(first, second, other),
            isCommandInFlight = { false },
            isSessionInFlight = { _, _ -> false },
        )

        assertEquals(listOf(first, other), plan.send)
        assertTrue(plan.markAmbiguous.isEmpty())
    }

    @Test
    fun ambiguousMessageBlocksLaterMessageInSameSession() {
        val unknown = message("unknown", "session-a", DeliveryState.AMBIGUOUS)
        val later = message("later", "session-a")

        val plan = OutboxDispatchPlanner.plan(
            listOf(unknown, later),
            isCommandInFlight = { false },
            isSessionInFlight = { _, _ -> false },
        )

        assertTrue(plan.send.isEmpty())
        assertTrue(plan.markAmbiguous.isEmpty())
    }

    @Test
    fun orphanedSendingBecomesAmbiguousAndStillBlocksFollowingMessage() {
        val interrupted = message("interrupted", "session-a", DeliveryState.SENDING)
        val later = message("later", "session-a")

        val plan = OutboxDispatchPlanner.plan(
            listOf(interrupted, later),
            isCommandInFlight = { false },
            isSessionInFlight = { _, _ -> false },
        )

        assertEquals(listOf(interrupted), plan.markAmbiguous)
        assertTrue(plan.send.isEmpty())
    }

    @Test
    fun knownInFlightCommandIsNotMisclassifiedOrDuplicated() {
        val sending = message("sending", "session-a", DeliveryState.SENDING)

        val plan = OutboxDispatchPlanner.plan(
            listOf(sending),
            isCommandInFlight = { it == sending.commandId },
            isSessionInFlight = { host, session -> host == sending.hostId && session == sending.sessionName },
        )

        assertTrue(plan.markAmbiguous.isEmpty())
        assertTrue(plan.send.isEmpty())
    }

    private fun message(
        id: String,
        session: String,
        state: DeliveryState = DeliveryState.QUEUED,
    ) = OutboxMessage(
        commandId = id,
        requestId = "request-$id",
        hostId = "host",
        sessionName = session,
        body = id,
        createdAtMillis = id.hashCode().toLong(),
        expiresAtMillis = Long.MAX_VALUE,
        state = state,
    )
}
