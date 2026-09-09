package com.tmuxworktree.mobile.feature.terminal

import com.tmuxworktree.mobile.core.model.ConnectionStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalDisconnectReasonPresentationTest {
    private val offlineFallback =
        "The last output is read-only. No keystrokes will be queued."

    @Test
    fun everyProtocolCloseReasonGetsHumanCopy() {
        listOf("client_closed", "backend_exit", "backend_error").forEach { token ->
            val copy = terminalDisconnectDetail(token, ConnectionStatus.OFFLINE)
            assertTrue("empty copy for $token", copy.isNotBlank())
            assertNotEquals("raw enum shown for $token", token, copy)
            assertFalse("enum token leaked: $copy", copy.contains(token))
            assertFalse("snake_case leaked: $copy", copy.contains('_'))
        }
    }

    @Test
    fun everyProtocolResetReasonGetsHumanCopy() {
        listOf(
            "missing_checkpoint",
            "missing_required_identity",
            "schema_incompatible",
            "identity_changed",
            "parser_continuity_lost",
            "checkpoint_invalid",
            "checkpoint_limit_exceeded",
            "stream_lost",
            "generation_stale",
            "offset_expired",
            "slow_consumer",
            "host_buffer_pressure",
            "parser_failure",
            "protocol_order_conflict",
        ).forEach { token ->
            val copy = terminalDisconnectDetail(token, ConnectionStatus.OFFLINE)
            assertTrue("empty copy for $token", copy.isNotBlank())
            assertNotEquals("raw enum shown for $token", token, copy)
            assertFalse("enum token leaked: $copy", copy.contains(token))
            assertFalse("snake_case leaked: $copy", copy.contains('_'))
        }
    }

    @Test
    fun internalViewModelTokensGetHumanCopy() {
        listOf(
            "terminal_open_timeout",
            "terminal_auto_reconnect_paused",
            "detached_open_response",
            "terminal_retirement_failed",
            "terminal_view_detach_failed",
            "renderer_recovery_exhausted",
            "terminal_attachment_unavailable",
            "renderer_crashed",
            "renderer_gone",
        ).forEach { token ->
            val copy = terminalDisconnectDetail(token, ConnectionStatus.OFFLINE)
            assertTrue("empty copy for $token", copy.isNotBlank())
            assertNotEquals("raw token shown for $token", token, copy)
            assertFalse("token leaked: $copy", copy.contains(token))
            assertFalse("snake_case leaked: $copy", copy.contains('_'))
        }
    }

    @Test
    fun unknownOrBlankReasonFallsBackToStatusCopy() {
        assertEquals(
            offlineFallback,
            terminalDisconnectDetail("some_future_reason", ConnectionStatus.OFFLINE),
        )
        assertEquals(
            offlineFallback,
            terminalDisconnectDetail(null, ConnectionStatus.OFFLINE),
        )
        assertEquals(
            offlineFallback,
            terminalDisconnectDetail("   ", ConnectionStatus.OFFLINE),
        )
        // A raw enum-style string must never survive the fallback.
        assertFalse(
            terminalDisconnectDetail("host_offline", ConnectionStatus.OFFLINE)
                .contains("host_offline"),
        )
    }

    @Test
    fun recoveringCopyMentionsAutomaticResume() {
        val copy = terminalDisconnectDetail("stream_lost", ConnectionStatus.RECOVERING)
        assertFalse(copy.contains("stream_lost"))
        assertTrue(copy, copy.contains("automatically", ignoreCase = true))
    }

    @Test
    fun backendExitReadsAsSessionEnded() {
        val copy = terminalDisconnectDetail("backend_exit", ConnectionStatus.OFFLINE)
        assertTrue(copy, copy.contains("ended", ignoreCase = true))
    }
}
