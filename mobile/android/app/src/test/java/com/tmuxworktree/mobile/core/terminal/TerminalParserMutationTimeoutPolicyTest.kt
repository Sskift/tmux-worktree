package com.tmuxworktree.mobile.core.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalParserMutationTimeoutPolicyTest {
    @Test
    fun `submission remains bounded at fifteen seconds`() {
        assertEquals(15_000L, TerminalParserMutationTimeoutPolicy.SUBMISSION_MILLIS)
    }

    @Test
    fun `callback tolerates a long foreground frame while remaining bounded`() {
        assertEquals(30_000L, TerminalParserMutationTimeoutPolicy.CALLBACK_MILLIS)
        assertTrue(
            TerminalParserMutationTimeoutPolicy.CALLBACK_MILLIS >
                TerminalParserMutationTimeoutPolicy.SUBMISSION_MILLIS,
        )
    }
}
