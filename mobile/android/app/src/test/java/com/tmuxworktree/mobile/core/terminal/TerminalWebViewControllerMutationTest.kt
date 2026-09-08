package com.tmuxworktree.mobile.core.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private class RecordingTerminalParserCallbackScheduler : TerminalParserCallbackScheduler {
    val posted = mutableListOf<Runnable>()
    val removed = mutableListOf<Runnable>()

    override fun postDelayed(block: Runnable, delayMillis: Long): Boolean {
        posted += block
        return true
    }

    override fun removeCallbacks(block: Runnable) {
        removed += block
    }
}

class TerminalWebViewControllerMutationTest {
    @Test
    fun `successor bind settles displaced view in-flight parser mutation immediately`() {
        val scheduler = RecordingTerminalParserCallbackScheduler()
        val controller = TerminalWebViewController(scheduler)
        val viewA = Any()
        val viewB = Any()

        check(controller.bind(viewA))
        val bindingA = checkNotNull(controller.markReady(viewA))

        // A parser write for view A whose TwBridge ACK never comes back; its bounded timeout is
        // armed but has not fired.
        val settlementsA = mutableListOf<Boolean>()
        assertTrue(
            controller.registerParserMutation(
                bindingA,
                "callback-a",
                "window.twA();",
            ) { applied -> settlementsA += applied },
        )
        assertTrue(scheduler.posted.isNotEmpty())

        // Navigation composes the successor terminal route before disposing the old one, so the
        // old view's loss is never recorded (it is no longer the bound view). The in-flight
        // mutation must be settled as failed at rebind rather than own the slot for up to the
        // bounded callback timeout.
        check(controller.bind(viewB))
        assertEquals(listOf(false), settlementsA)
        assertTrue(scheduler.removed.isNotEmpty())

        val bindingB = checkNotNull(controller.markReady(viewB))
        val settlementsB = mutableListOf<Boolean>()
        val registeredB = controller.registerParserMutation(
            bindingB,
            "callback-b",
            "window.twB();",
        ) { applied -> settlementsB += applied }

        assertTrue(
            "successor parser write must be accepted immediately after the rebind",
            registeredB,
        )
    }

    @Test
    fun `re-binding the same view does not settle its in-flight parser mutation`() {
        val scheduler = RecordingTerminalParserCallbackScheduler()
        val controller = TerminalWebViewController(scheduler)
        val view = Any()

        check(controller.bind(view))
        val binding = checkNotNull(controller.markReady(view))

        val settlements = mutableListOf<Boolean>()
        assertTrue(
            controller.registerParserMutation(
                binding,
                "callback-same",
                "window.twSame();",
            ) { applied -> settlements += applied },
        )

        // A redundant bind of the already-bound view (same generation) must not touch the slot.
        assertTrue(controller.bind(view))
        assertTrue(settlements.isEmpty())
    }
}
