package com.tmuxworktree.mobile.core.model

import org.junit.Assert.assertEquals
import org.junit.Test

class RelaySessionTest {
    @Test
    fun `stable identity is host plus protocol session name`() {
        val session = RelaySession(
            hostId = "mac-admin",
            name = "mew-dev:feature-one",
            rawName = "feature-one",
            label = "Friendly title",
        )

        assertEquals("mac-admin:mew-dev:feature-one", session.stableId)
        assertEquals("Friendly title", session.title)
    }

    @Test
    fun `title falls back from label to raw name then protocol name`() {
        assertEquals(
            "raw-name",
            RelaySession(hostId = "host", name = "local:wire", rawName = "raw-name").title,
        )
        assertEquals(
            "local:wire",
            RelaySession(hostId = "host", name = "local:wire").title,
        )
    }

    @Test
    fun `project name is recovered from a tmux worktree path`() {
        val session = RelaySession(
            hostId = "host",
            name = "local:feature",
            cwd = "/Users/alice/code/dashboard/.tmux-worktree/worktrees/dashboard/feature",
        )

        assertEquals("dashboard", session.projectName)
    }

    @Test
    fun `explicit project wins over path inference`() {
        val session = RelaySession(
            hostId = "host",
            name = "local:feature",
            project = "canonical-project",
            cwd = "/tmp/not-the-project",
        )

        assertEquals("canonical-project", session.projectName)
    }
}
