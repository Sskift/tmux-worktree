package com.tmuxworktree.mobile.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboxInFlightRegistryTest {
    @Test
    fun unknownNonEmptyRequestIdNeverConsumesNewerMessageInSameSession() {
        val registry = OutboxInFlightRegistry()
        val current = message("request-new", "command-new")
        registry.register(current)

        assertNull(
            registry.resolveAcknowledgement(
                requestId = "request-old",
                hostId = current.hostId,
                sessionName = current.sessionName,
            ),
        )
        assertTrue(registry.containsCommand(current.commandId))
        assertEquals(current, registry.remove(current.requestId))
    }

    @Test
    fun missingRequestIdUsesLegacySessionFallbackOnlyForExactHost() {
        val registry = OutboxInFlightRegistry()
        val first = message("one", "command-one", hostId = "host-a")
        val second = message("two", "command-two", hostId = "host-b")
        registry.register(first)
        registry.register(second)

        assertEquals(
            second,
            registry.resolveAcknowledgement(null, "host-b", second.sessionName),
        )
        assertTrue(registry.containsCommand(first.commandId))
        assertFalse(registry.containsCommand(second.commandId))
    }

    @Test
    fun sessionAndDrainQueriesPreserveCommandIdentity() {
        val registry = OutboxInFlightRegistry()
        val first = message("one", "command-one")
        val second = message("two", "command-two", sessionName = "local:other")
        registry.register(first)
        registry.register(second)

        assertTrue(registry.hasSession(first.hostId, first.sessionName))
        assertEquals(listOf(first.commandId, second.commandId), registry.drainCommandIds())
        assertFalse(registry.hasSession(first.hostId, first.sessionName))
    }

    private fun message(
        requestId: String,
        commandId: String,
        hostId: String = "host-a",
        sessionName: String = "local:session",
    ) = OutboxInFlightMessage(requestId, commandId, hostId, sessionName)
}
