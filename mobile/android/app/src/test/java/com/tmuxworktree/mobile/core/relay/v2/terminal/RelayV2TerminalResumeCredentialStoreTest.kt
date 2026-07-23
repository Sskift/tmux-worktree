package com.tmuxworktree.mobile.core.relay.v2.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2TerminalResumeCredentialStoreTest {
    @Test
    fun `profile cleanup is exact through activation and owner-bound keys cannot collide`() {
        val index = RelayV2TerminalCredentialReferenceIndex(
            digest = { value -> "digest-${value.replace(':', '-')}" },
        )
        val profileA1 = RelayV2TerminalResumeCredentialOwner("profile-a", 1)
        val profileA2 = RelayV2TerminalResumeCredentialOwner("profile-a", 2)
        val profileA3 = RelayV2TerminalResumeCredentialOwner("profile-a", 3)
        val profileB2 = RelayV2TerminalResumeCredentialOwner("profile-b", 2)
        val sharedReference = "terminal-2-shared-stream"
        val values = linkedMapOf<String, Any>(
            index.key(profileA1) to setOf("terminal-1-old"),
            index.key(profileA2) to setOf(sharedReference),
            index.key(profileA3) to setOf("terminal-3-current"),
            index.key(profileB2) to setOf(sharedReference),
        )

        val plan = index.clearPlan("profile-a", 2, values)

        assertEquals(listOf(profileA1, profileA2), plan.map { it.owner })
        assertTrue(plan.flatMap { it.references }.contains(sharedReference))
        assertFalse(plan.any { it.owner == profileA3 || it.owner == profileB2 })
        assertFalse(index.key(profileA2) == index.key(profileB2))
        assertFalse(
            index.entryKey(profileA2, sharedReference) ==
                index.entryKey(profileB2, sharedReference),
        )
    }
}
