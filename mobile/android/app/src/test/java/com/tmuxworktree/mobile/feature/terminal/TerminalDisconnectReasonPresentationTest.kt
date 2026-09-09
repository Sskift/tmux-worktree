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

    @Test
    fun actionableOpenRejectionProseRendersVerbatim() {
        // These are the exact app-authored messages placed in resetReason/actionError by
        // openRejected / detachedOpenRejected / clearFailedRelayV2Terminal in V2ViewModel.
        // Deterministic open failures must keep their specific, actionable reason on screen.
        listOf(
            "Terminal input is busy on another client",
            // resolveRelayV2TerminalOpenRejection wraps the host's TERMINAL_STREAM_CONFLICT
            // message (hostRuntime.ts: "Relay v2 terminal stream conflicts with retained
            // state") with the Reconnect hint.
            "Relay v2 terminal stream conflicts with retained state; tap Reconnect to retry",
            "Relay v2 terminal could not be opened",
            "Relay v2 terminal attachment is stale",
            "Terminal replacement could not retire its previous owner",
        ).forEach { prose ->
            val copy = terminalDisconnectDetail(prose, ConnectionStatus.OFFLINE)
            assertEquals("actionable prose was replaced: $prose", prose, copy)
        }
    }

    @Test
    fun actionableProseInRecoveringKeepsReasonAndNotesAutoReconnect() {
        val prose = "Terminal input is busy on another client; waiting to retry"
        val copy = terminalDisconnectDetail(prose, ConnectionStatus.RECOVERING)
        assertTrue("reason lost: $copy", copy.startsWith(prose))
        assertTrue(copy, copy.contains("automatically", ignoreCase = true))
    }

    @Test
    fun tokenLikeStringsStillFallBackEvenWhenUnknown() {
        // Unknown snake_case tokens and bare codes (no whitespace) must never render.
        assertEquals(
            offlineFallback,
            terminalDisconnectDetail("some_future_reason", ConnectionStatus.OFFLINE),
        )
        assertEquals(
            offlineFallback,
            terminalDisconnectDetail("BUSY", ConnectionStatus.OFFLINE),
        )
        // Defensive: a message that mixes prose with an underscore looks token-ish, so the
        // raw-enum guard wins over passthrough.
        assertEquals(
            offlineFallback,
            terminalDisconnectDetail("terminal failed with bad_state now", ConnectionStatus.OFFLINE),
        )
    }

    @Test
    fun prosePassthroughTrimsSurroundingWhitespace() {
        val copy = terminalDisconnectDetail(
            "  Relay v2 terminal could not be opened  ",
            ConnectionStatus.OFFLINE,
        )
        assertEquals("Relay v2 terminal could not be opened", copy)
    }
}
