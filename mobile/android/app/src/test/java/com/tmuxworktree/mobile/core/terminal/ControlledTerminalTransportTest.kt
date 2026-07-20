package com.tmuxworktree.mobile.core.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ControlledTerminalTransportTest {
    @Test
    fun `mouse and focus transport reports are not pane input`() {
        assertTrue(isControlledTerminalTransportReport("\u001B[<0;12;7M"))
        assertTrue(isControlledTerminalTransportReport("\u001B[32;12;7M"))
        assertTrue(isControlledTerminalTransportReport("\u001B[M !!"))
        assertTrue(isControlledTerminalTransportReport("\u001B[I\u001B[O"))

        assertFalse(isControlledTerminalTransportReport("\u001B[3~"))
        assertFalse(isControlledTerminalTransportReport("\u001B[A"))
        assertFalse(isControlledTerminalTransportReport("\u007F"))
        assertFalse(isControlledTerminalTransportReport("text"))
    }

    @Test
    fun `controlled output strips mouse and focus enables across chunk boundaries`() {
        val filter = ControlledTerminalOutputFilter()

        assertEquals("before", filter.push("before\u001B[?1000;"))
        assertEquals("after\u001B[?25h", filter.push("1006hafter\u001B[?25;1004h"))
        assertEquals("\u001B[?1000l\u001B[?2004h", filter.push("\u001B[?1000l\u001B[?2004h"))
    }

    @Test
    fun `reset discards an incomplete output control sequence`() {
        val filter = ControlledTerminalOutputFilter()

        assertEquals("before", filter.push("before\u001B[?1004"))
        filter.reset()
        assertEquals("after", filter.push("after"))
    }

    @Test
    fun `oversized incomplete private control sequence stays bounded and preserves later output`() {
        val filter = ControlledTerminalOutputFilter()

        assertEquals("before", filter.push("before\u001B[?${"1".repeat(1_024)}"))
        assertEquals("", filter.push("2".repeat(1_024)))
        assertEquals("after", filter.push("hafter"))
        assertEquals("tail", filter.push("tail"))
    }

    @Test
    fun `reset exits oversized private control sequence discard state`() {
        val filter = ControlledTerminalOutputFilter()

        assertEquals("", filter.push("\u001B[?${"1".repeat(1_024)}"))
        filter.reset()
        assertEquals("after", filter.push("after"))
    }
}
