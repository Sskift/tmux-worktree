package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.core.data.AppPreferences
import com.tmuxworktree.mobile.core.model.AgentState
import com.tmuxworktree.mobile.core.model.ConnectionHealth
import com.tmuxworktree.mobile.core.model.RelayHost
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.model.TransportPhase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class V2UiStateTest {
    @Test
    fun activeSessionsAndAttentionBadgeFollowSelectedComputer() {
        val hostAWaiting = RelaySession(
            hostId = "host-a",
            name = "local:same-name",
            agentState = AgentState.WAITING_FOR_USER,
        )
        val hostBRunning = RelaySession(
            hostId = "host-b",
            name = "local:same-name",
            agentState = AgentState.RUNNING,
        )
        val state = V2UiState(
            preferences = AppPreferences(preferredHostId = "host-b"),
            hosts = listOf(RelayHost("host-a"), RelayHost("host-b")),
            sessions = listOf(hostAWaiting, hostBRunning),
        )

        assertEquals("host-b", state.activeHostId)
        assertEquals(listOf(hostBRunning), state.activeSessions)
        assertEquals(0, state.attentionCount)
    }

    @Test
    fun firstCachedHostIsUsedOnlyWhenNoPreferenceExists() {
        val session = RelaySession(hostId = "cached", name = "local:cached")
        val state = V2UiState(
            hosts = listOf(RelayHost("cached"), RelayHost("other")),
            sessions = listOf(session),
        )

        assertEquals("cached", state.activeHostId)
        assertEquals(listOf(session), state.activeSessions)
    }

    @Test
    fun missingPreferredHostFallsBackToAHostThatStillExists() {
        val visible = RelaySession(hostId = "keep", name = "local:visible")
        val state = V2UiState(
            preferences = AppPreferences(preferredHostId = "gone"),
            hosts = listOf(RelayHost("keep")),
            sessions = listOf(visible),
        )

        assertEquals("keep", state.activeHostId)
        assertEquals(listOf(visible), state.activeSessions)
        assertTrue(
            shouldPersistRelaySelectedHost(
                preferredHostId = "gone",
                availableHostIds = setOf("keep"),
                selectedHostId = "keep",
            ),
        )
        assertFalse(
            shouldPersistRelaySelectedHost(
                preferredHostId = "keep",
                availableHostIds = setOf("keep"),
                selectedHostId = "keep",
            ),
        )
    }

    @Test
    fun targetLoadingIsLimitedToAnActiveInitialConnectionAttempt() {
        assertTrue(
            shouldShowTargetLoading(
                V2UiState(health = ConnectionHealth(phase = TransportPhase.HANDSHAKING)),
            ),
        )
        assertFalse(
            shouldShowTargetLoading(
                V2UiState(
                    health = ConnectionHealth(
                        phase = TransportPhase.BACKING_OFF,
                        errorMessage = "Relay unavailable",
                    ),
                ),
            ),
        )
    }
}
