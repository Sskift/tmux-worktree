package com.tmuxworktree.mobile.feature.inbox

import com.tmuxworktree.mobile.app.AgentCapabilityAvailability
import com.tmuxworktree.mobile.app.RelayStartupAdmissionState
import com.tmuxworktree.mobile.app.V2UiState
import com.tmuxworktree.mobile.core.model.AgentState
import com.tmuxworktree.mobile.core.model.RelaySession
import org.junit.Assert.assertEquals
import org.junit.Test

class InboxAgentStatusPresentationTest {
    @Test
    fun runningGroupRequiresPositiveRunningEvidence() {
        val running = session("running", AgentState.RUNNING)
        val unknown = session("unknown", AgentState.UNKNOWN)
        val completed = session("completed", AgentState.COMPLETED)
        val terminal = session("terminal", AgentState.UNKNOWN, kind = "terminal")

        val groups = inboxSessionGroups(
            sessions = listOf(unknown, completed, running, terminal),
            agentStateAvailable = true,
        )

        assertEquals(listOf(running), groups.primary)
        assertEquals(listOf(unknown, completed), groups.other)
    }

    @Test
    fun unavailableLifecycleUsesNeutralSessionsGroup() {
        val unknown = session("unknown", AgentState.UNKNOWN)
        val completed = session("completed", AgentState.COMPLETED)

        val groups = inboxSessionGroups(
            sessions = listOf(unknown, completed),
            agentStateAvailable = false,
        )

        assertEquals(listOf(unknown, completed), groups.primary)
        assertEquals(emptyList<RelaySession>(), groups.other)
    }

    @Test
    fun relayV2NamesTheUnavailableOrUnnegotiatedAgentCapability() {
        val state = V2UiState(
            relayStartupAdmission = RelayStartupAdmissionState.RELAY_V2,
            agentCapabilityAvailability = AgentCapabilityAvailability.UNAVAILABLE,
        )

        assertEquals(
            InboxUnavailableAgentStatus(
                subtitle = "Relay v2 Agent capability is unavailable or was not negotiated",
                emptyContentDescription =
                    "Agent reply state is unavailable because the Relay version 2 Agent " +
                        "capability is unavailable or was not negotiated",
            ),
            inboxUnavailableAgentStatus(state.agentEvidenceAvailability),
        )
    }

    private fun session(
        name: String,
        state: AgentState,
        kind: String = "session",
    ) = RelaySession(
        hostId = "host",
        name = name,
        rawName = name,
        kind = kind,
        agentState = state,
    )
}
