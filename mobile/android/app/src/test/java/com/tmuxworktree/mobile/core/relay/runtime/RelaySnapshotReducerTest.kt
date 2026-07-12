package com.tmuxworktree.mobile.core.relay.runtime

import com.tmuxworktree.mobile.core.relay.v1.RelayV1Host
import com.tmuxworktree.mobile.core.relay.v1.RelayV1ScopeStatus
import com.tmuxworktree.mobile.core.relay.v1.RelayV1Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelaySnapshotReducerTest {
    @Test
    fun `injects host context and replaces only that host session snapshot`() {
        var state = RelaySnapshotReducer.reduce(
            RelaySnapshotState(),
            RelaySnapshotMutation.ReplaceHosts(
                hosts = listOf(
                    RelayV1Host("mac-admin", "Mac"),
                    RelayV1Host("other", "Other"),
                ),
                preferredHostId = "mac-admin",
                nowMillis = 1,
            ),
        )
        state = RelaySnapshotReducer.reduce(
            state,
            RelaySnapshotMutation.ReplaceSessions(
                hostId = "other",
                sessions = listOf(RelayV1Session(name = "local:keep", rawName = "keep")),
                nowMillis = 2,
            ),
        )
        state = RelaySnapshotReducer.reduce(
            state,
            RelaySnapshotMutation.ReplaceSessions(
                hostId = "mac-admin",
                sessions = listOf(
                    RelayV1Session(
                        name = "local:new",
                        rawName = "new",
                        project = "demo",
                        windows = 1,
                    ),
                ),
                nowMillis = 3,
            ),
        )

        assertEquals("mac-admin", state.selectedHostId)
        assertTrue(state.sessionsById.containsKey("other:local:keep"))
        val created = state.sessionsById.getValue("mac-admin:local:new")
        assertEquals("Mac", created.hostName)
        assertEquals("demo", created.project)
        assertEquals("local", created.scopeId)
        assertEquals(3L, state.revision)
    }

    @Test
    fun `revision increments once per real snapshot change even when wall clock goes backwards`() {
        val hostsMutation = RelaySnapshotMutation.ReplaceHosts(
            hosts = listOf(RelayV1Host("mac-admin", "Mac")),
            preferredHostId = "mac-admin",
            nowMillis = 100,
        )
        val first = RelaySnapshotReducer.reduce(RelaySnapshotState(), hostsMutation)
        val duplicateHosts = RelaySnapshotReducer.reduce(first, hostsMutation)
        val sessionMutation = RelaySnapshotMutation.ReplaceSessions(
            hostId = "mac-admin",
            sessions = listOf(RelayV1Session(name = "local:demo", rawName = "demo")),
            nowMillis = 50,
        )
        val second = RelaySnapshotReducer.reduce(duplicateHosts, sessionMutation)
        val duplicateSessions = RelaySnapshotReducer.reduce(
            second,
            sessionMutation.copy(nowMillis = 500),
        )
        val missingRemoval = RelaySnapshotReducer.reduce(
            duplicateSessions,
            RelaySnapshotMutation.RemoveSession("mac-admin", "local:missing", nowMillis = 600),
        )
        val third = RelaySnapshotReducer.reduce(
            missingRemoval,
            RelaySnapshotMutation.RemoveSession("mac-admin", "local:demo", nowMillis = 75),
        )

        assertEquals(1L, first.revision)
        assertEquals(first, duplicateHosts)
        assertEquals(2L, second.revision)
        assertEquals(50L, second.updatedAtMillis)
        assertEquals(second, duplicateSessions)
        assertEquals(second, missingRemoval)
        assertEquals(3L, third.revision)
        assertEquals(75L, third.updatedAtMillis)
    }

    @Test
    fun `host replacement removes orphan sessions and scopes including empty host snapshot`() {
        var state = RelaySnapshotReducer.reduce(
            RelaySnapshotState(),
            RelaySnapshotMutation.ReplaceHosts(
                hosts = listOf(RelayV1Host("keep", "Keep"), RelayV1Host("gone", "Gone")),
                preferredHostId = "keep",
                nowMillis = 1,
            ),
        )
        listOf("keep", "gone").forEachIndexed { index, hostId ->
            state = RelaySnapshotReducer.reduce(
                state,
                RelaySnapshotMutation.ReplaceSessions(
                    hostId = hostId,
                    sessions = listOf(RelayV1Session(name = "local:$hostId", rawName = hostId)),
                    nowMillis = 2L + index,
                ),
            )
            state = RelaySnapshotReducer.reduce(
                state,
                RelaySnapshotMutation.ReplaceScopes(
                    hostId = hostId,
                    scopes = listOf(RelayV1ScopeStatus(scopeId = "local", scopeLabel = "Local")),
                    nowMillis = 4L + index,
                ),
            )
        }

        state = RelaySnapshotReducer.reduce(
            state,
            RelaySnapshotMutation.ReplaceHosts(
                hosts = listOf(RelayV1Host("keep", "Keep")),
                preferredHostId = "keep",
                nowMillis = 10,
            ),
        )

        assertEquals(setOf("keep"), state.hostsById.keys)
        assertTrue(state.sessions.all { it.hostId == "keep" })
        assertTrue(state.scopes.all { it.hostId == "keep" })
        assertFalse(state.sessionsById.containsKey("gone:local:gone"))
        assertFalse(state.scopesById.containsKey("gone:local"))

        val empty = RelaySnapshotReducer.reduce(
            state,
            RelaySnapshotMutation.ReplaceHosts(emptyList(), preferredHostId = "keep", nowMillis = 11),
        )
        assertTrue(empty.hostsById.isEmpty())
        assertTrue(empty.sessionsById.isEmpty())
        assertTrue(empty.scopesById.isEmpty())
        assertEquals("", empty.selectedHostId)
        assertEquals(state.revision + 1, empty.revision)
    }
}
