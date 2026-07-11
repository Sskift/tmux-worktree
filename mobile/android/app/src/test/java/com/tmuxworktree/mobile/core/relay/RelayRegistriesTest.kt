package com.tmuxworktree.mobile.core.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayRegistriesTest {
    @Test
    fun `request registry identifies out of order snapshots`() {
        val registry = RelayRequestRegistry()
        registry.register(
            RelayRequestContext(
                requestId = "sessions-1",
                kind = RelayRequestKind.SESSIONS,
                epoch = 1,
                hostId = "mac-admin",
                latestKey = "sessions:mac-admin",
            ),
        )
        registry.register(
            RelayRequestContext(
                requestId = "sessions-2",
                kind = RelayRequestKind.SESSIONS,
                epoch = 1,
                hostId = "mac-admin",
                latestKey = "sessions:mac-admin",
            ),
        )

        val stale = registry.resolve("sessions-1")
        val current = registry.resolve("sessions-2")

        assertEquals("mac-admin", stale?.context?.hostId)
        assertFalse(stale?.isLatest ?: true)
        assertTrue(current?.isLatest ?: false)
        assertNull(registry.resolve("missing"))
    }

    @Test
    fun `stream registry rejects old stream after generation changes`() {
        val registry = RelayStreamRegistry()
        val first = registry.open("stream-1", "mac-admin", "local:one")
        assertTrue(registry.accepts("stream-1"))
        assertFalse(registry.accepts(null))
        assertFalse(registry.accepts(""))

        val second = registry.open("stream-2", "mac-admin", "local:one")

        assertTrue(second.generation > first.generation)
        assertFalse(registry.accepts("stream-1"))
        assertTrue(registry.accepts("stream-2"))
        assertNull(registry.close("stream-1"))
        assertEquals("stream-2", registry.current()?.streamId)
    }

    @Test
    fun `blank request id resolves latest compatible request but unknown id never falls back`() {
        val registry = RelayRequestRegistry()
        registry.register(
            RelayRequestContext(
                requestId = "scopes-1",
                kind = RelayRequestKind.SCOPES,
                epoch = 1,
                hostId = "mac-admin",
                latestKey = "scopes:mac-admin",
            ),
        )

        assertNull(
            registry.resolve(
                requestId = "unknown",
                expectedKind = RelayRequestKind.SCOPES,
                fallbackLatestKey = "scopes:mac-admin",
                allowLatestForBlank = true,
            ),
        )
        assertEquals(1, registry.size())

        val compatible = registry.resolve(
            requestId = null,
            expectedKind = RelayRequestKind.SCOPES,
            fallbackLatestKey = "scopes:mac-admin",
            allowLatestForBlank = true,
        )
        assertEquals("scopes-1", compatible?.context?.requestId)
        assertEquals(0, registry.size())
    }
}
