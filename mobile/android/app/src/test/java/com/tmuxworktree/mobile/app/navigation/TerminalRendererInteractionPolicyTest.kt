package com.tmuxworktree.mobile.app.navigation

import com.tmuxworktree.mobile.core.model.ConnectionStatus
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalRendererInteractionPolicyTest {
    @Test
    fun `only an online unlocked terminal accepts renderer input`() {
        ConnectionStatus.values()
            .filterNot { it == ConnectionStatus.ONLINE }
            .forEach { status ->
                assertFalse(
                    "$status must keep renderer input fenced",
                    terminalRendererInputEnabled(status, readOnly = false),
                )
            }

        assertFalse(
            terminalRendererInputEnabled(ConnectionStatus.ONLINE, readOnly = true),
        )
        assertTrue(
            terminalRendererInputEnabled(ConnectionStatus.ONLINE, readOnly = false),
        )
    }

    @Test
    fun `only an online terminal reports renderer resize`() {
        ConnectionStatus.values()
            .filterNot { it == ConnectionStatus.ONLINE }
            .forEach { status ->
                assertFalse(
                    "$status must not report a pre-authority renderer resize",
                    terminalRendererResizeEnabled(status),
                )
            }

        assertTrue(terminalRendererResizeEnabled(ConnectionStatus.ONLINE))
    }
}
