package com.tmuxworktree.mobile.feature.inbox

import com.tmuxworktree.mobile.app.AgentCapabilityAvailability
import com.tmuxworktree.mobile.app.RelayStartupAdmissionState
import com.tmuxworktree.mobile.app.V2UiState
import org.junit.Assert.assertEquals
import org.junit.Test

class InboxAgentStatusPresentationTest {
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
}
