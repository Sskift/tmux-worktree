package com.tmuxworktree.mobile.app

import com.tmuxworktree.mobile.core.data.AppPreferences
import com.tmuxworktree.mobile.core.model.AgentState
import com.tmuxworktree.mobile.core.model.ConnectionHealth
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.RelayHost
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.model.TerminalStreamState
import com.tmuxworktree.mobile.core.model.TransportPhase
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimePhase
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimeState
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2SessionReplyCut
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2ScopeCreateResult
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxEnqueueReceipt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
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
        assertEquals("Relay v2", ConnectionHealth().protocolLabel)
    }

    @Test
    fun dashboardHostUsesTheMacDeviceName() {
        assertEquals(
            "D2N6M7MMCX",
            relayHostDisplayName("dashboard-c6777640f11d1abb6e6e83afa8d6e911"),
        )
        assertEquals("devbox", relayHostDisplayName("devbox"))
    }

    @Test
    fun relayV2CreateSubmissionIsFencedUntilQueuedResultLeavesTheForm() {
        val initial = V2UiState(relayStartupAdmission = RelayStartupAdmissionState.RELAY_V2)

        val submitting = requireNotNull(
            initial.beginCreationSubmission(CreationTarget.TERMINAL),
        )
        assertTrue(submitting.creatingTerminal)
        assertNull(submitting.beginCreationSubmission(CreationTarget.TERMINAL))

        val queued = submitting.afterRelayV2Creation(
            target = CreationTarget.TERMINAL,
            result = RelayV2ScopeCreateResult.Queued(
                receipt = RelayV2OutboxEnqueueReceipt(
                    hostId = "host-a",
                    expectedHostEpoch = "11111111-1111-4111-8111-111111111111",
                    commandId = "22222222-2222-4222-8222-222222222222",
                    createdOrder = 1,
                ),
            ),
            rejectionMessage = "",
        )

        assertFalse(queued.state.creatingTerminal)
        assertNull(queued.state.actionError)
        assertEquals(
            V2UiEffect.CreationQueued(
                target = CreationTarget.TERMINAL,
                message = "Terminal creation queued",
            ),
            queued.effect,
        )
    }

    @Test
    fun relayV2SessionIdentityDoesNotCollideWhenOpaqueIdsContainSlashes() {
        val first = relayV2SessionUiStableId("profile", "host", "a/b", "c")
        val second = relayV2SessionUiStableId("profile", "host", "a", "b/c")

        assertNotEquals(first, second)
    }

    @Test
    fun relayV2SessionCallbackRequiresTheCapturedCompositionCutAndAdmission() {
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
                admitted.copy(
                    relayStartupAdmission =
                        RelayStartupAdmissionState.RELAY_V2_ENROLLMENT_REQUIRED,
                ),
                oldComposition,
                mapOf("session-a" to oldCut),
            ),
        )

        val newProfileState = admitted.copy(actionError = "new profile error")
        val staleSuccess = fence.applyIfCurrent(
            newProfileState,
            newComposition,
            mapOf("session-a" to newCut),
        ) { it.copy(actionError = null) }
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
    fun relayV2TerminalAttachmentRequiresFreshCutAndExactRoute() {
        val staleCut = object : RelayV2SessionReplyCut {}
        val freshCut = object : RelayV2SessionReplyCut {}
        val stale = RelayV2TerminalUiAttachmentFence("session-a", "route-old", staleCut)
        val fresh = RelayV2TerminalUiAttachmentFence("session-a", "route-new", freshCut)

        assertTrue(stale.isCurrent("route-old", mapOf("session-a" to staleCut)))
        assertFalse(stale.isCurrent("route-old", emptyMap()))
        assertFalse(stale.isCurrent("route-old", mapOf("session-a" to freshCut)))
        assertFalse(stale.ownsRoute("route-new"))
        assertTrue(fresh.isCurrent("route-new", mapOf("session-a" to freshCut)))
        assertFalse(fresh.ownsRoute("route-old"))
    }

    @Test
    fun relayV2TerminalAttachmentRetainsOnlyAnActiveOpenForTheExactRoute() {
        val cut = object : RelayV2SessionReplyCut {}
        val fence = RelayV2TerminalUiAttachmentFence("session-a", "route-a", cut)

        assertTrue(
            fence.retainsActiveRoute(
                "route-a",
                TerminalStreamState(
                    sessionId = "session-a",
                    status = ConnectionStatus.CONNECTING,
                ),
            ),
        )
        assertTrue(
            fence.retainsActiveRoute(
                "route-a",
                TerminalStreamState(
                    sessionId = "session-a",
                    status = ConnectionStatus.ONLINE,
                ),
            ),
        )
        assertFalse(
            fence.retainsActiveRoute(
                "route-a",
                TerminalStreamState(
                    sessionId = "session-a",
                    status = ConnectionStatus.OFFLINE,
                ),
            ),
        )
        assertFalse(
            fence.retainsActiveRoute(
                "route-b",
                TerminalStreamState(
                    sessionId = "session-a",
                    status = ConnectionStatus.CONNECTING,
                ),
            ),
        )
        assertFalse(
            fence.retainsActiveRoute(
                "route-a",
                TerminalStreamState(
                    sessionId = "session-b",
                    status = ConnectionStatus.CONNECTING,
                ),
            ),
        )
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
