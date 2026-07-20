package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.core.data.AppPreferences
import com.tmuxworktree.mobile.core.model.AgentState
import com.tmuxworktree.mobile.core.model.ConnectionHealth
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.RelayHost
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.model.TransportPhase
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimePhase
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimeState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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

    @Test
    fun protocolLabelNamesTheImplementedRelayVersionExplicitly() {
        assertEquals("Relay v1", ConnectionHealth().protocolLabel)
    }

    @Test
    fun committedReplyRetainsAnewerRawDraft() {
        val submitted = "  first reply  "
        val unchanged = V2UiState(drafts = mapOf("session-a" to submitted))
        val edited = unchanged.copy(drafts = mapOf("session-a" to "first reply plus more"))

        assertTrue(unchanged.afterCommittedReply("session-a", submitted).drafts.isEmpty())
        assertEquals(
            "first reply plus more",
            edited.afterCommittedReply("session-a", submitted).drafts["session-a"],
        )
    }

    @Test
    fun relayV2SessionIdentityDoesNotCollideWhenOpaqueIdsContainSlashes() {
        val first = relayV2SessionUiStableId("profile", "host", "a/b", "c")
        val second = relayV2SessionUiStableId("profile", "host", "a", "b/c")

        assertNotEquals(first, second)
    }

    @Test
    fun relayV2ReplyCallbackRequiresTheCapturedCompositionCutAndAdmission() {
        val oldComposition = Any()
        val newComposition = Any()
        val oldCut = Any()
        val newCut = Any()
        val fence = RelayV2ReplyUiCallbackFence(oldComposition, "session-a", oldCut)
        val admitted = V2UiState(relayStartupAdmission = RelayStartupAdmissionState.RELAY_V2)

        assertTrue(fence.isCurrent(admitted, oldComposition, mapOf("session-a" to oldCut)))
        assertFalse(fence.isCurrent(admitted, newComposition, mapOf("session-a" to oldCut)))
        assertFalse(fence.isCurrent(admitted, oldComposition, mapOf("session-a" to newCut)))
        assertFalse(
            fence.isCurrent(
                admitted.copy(relayStartupAdmission = RelayStartupAdmissionState.RELAY_V1),
                oldComposition,
                mapOf("session-a" to oldCut),
            ),
        )

        val newProfileState = admitted.copy(
            drafts = mapOf("session-a" to "new profile draft"),
            actionError = "new profile error",
        )
        val staleSuccess = fence.applyIfCurrent(
            newProfileState,
            newComposition,
            mapOf("session-a" to newCut),
        ) { it.afterCommittedReply("session-a", "new profile draft") }
        val staleRejection = fence.applyIfCurrent(
            newProfileState,
            newComposition,
            mapOf("session-a" to newCut),
        ) { it.copy(actionError = "old rejection") }
        assertFalse(staleSuccess.applied)
        assertFalse(staleRejection.applied)
        assertEquals(newProfileState, staleSuccess.state)
        assertEquals(newProfileState, staleRejection.state)
    }

    @Test
    fun relayV2OnlineProjectsTransportHealthWithoutClaimingCapabilityReadiness() {
        val projected = projectRelayV2RuntimeState(
            state = V2UiState(
                relayStartupAdmission = RelayStartupAdmissionState.RELAY_V2,
                hosts = listOf(RelayHost("host-a", status = ConnectionStatus.UNKNOWN)),
            ),
            runtime = RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.ONLINE),
            nowMillis = 1234,
        )

        assertEquals(RelayV2ProfileConnectionState.ONLINE, projected.relayV2ProfileConnection)
        assertEquals(TransportPhase.ONLINE, projected.health.phase)
        assertEquals(ConnectionStatus.ONLINE, projected.health.overall)
        assertEquals(RELAY_V2_TRANSPORT_LABEL, projected.health.protocolLabel)
        assertEquals(ConnectionStatus.ONLINE, projected.hosts.single().status)
        assertFalse(projected.health.protocolLabel.contains("ready", ignoreCase = true))
    }
}
