package com.tmuxworktree.mobile.feature.chat

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.relay.runtime.PendingChatSend
import com.tmuxworktree.mobile.core.relay.runtime.RelayChatState
import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatRuntimeSettings
import com.tmuxworktree.mobile.designsystem.TwTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class AgentChatScreenInstrumentedTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun failedBubbleShowsRelayErrorAndRoutesRetryToItsExactRequest() {
        val session = RelaySession(
            hostId = "host-1",
            name = "local:demo",
            protocolSessionId = "session-1",
        )
        val retryable = PendingChatSend(
            requestId = "request-1",
            session = session.protocolSessionId,
            message = "Please retry this one",
            sentAtMillis = 100,
            failed = true,
            error = "Relay Agent chat is unavailable",
            errorCode = "AGENT_CHAT_UNAVAILABLE",
            retryable = true,
        )
        val finalFailure = PendingChatSend(
            requestId = "request-2",
            session = session.protocolSessionId,
            message = "Do not retry this one",
            sentAtMillis = 200,
            failed = true,
            error = "The selected Agent session is no longer available",
            errorCode = "AGENT_CHAT_SESSION_UNAVAILABLE",
            retryable = false,
        )
        var retriedRequestId: String? = null

        composeRule.setContent {
            TwTheme {
                AgentChatScreen(
                    session = session,
                    connectionStatus = ConnectionStatus.ONLINE,
                    chatState = RelayChatState(
                        pendingBySession = mapOf(
                            session.protocolSessionId to listOf(retryable, finalFailure),
                        ),
                    ),
                    draft = "",
                    onDraftChange = {},
                    onBack = {},
                    onOpenDetails = {},
                    onOpenTerminal = {},
                    runtimeSettings = AgentChatRuntimeSettings(),
                    onRuntimeSettingsChange = {},
                    runtimeSettingsAvailable = true,
                    onSend = { _, _ -> },
                    onRetryFailed = { retriedRequestId = it },
                )
            }
        }

        composeRule.onNodeWithTag("pending_error_request-1")
            .performScrollTo()
            .assertTextEquals("Relay Agent chat is unavailable")
        composeRule.onNodeWithText("Error code: AGENT_CHAT_UNAVAILABLE")
            .assertIsDisplayed()
        composeRule.onNodeWithTag("retry_failed_request-1")
            .performScrollTo()
            .performClick()

        composeRule.runOnIdle {
            assertEquals("request-1", retriedRequestId)
        }

        composeRule.onNodeWithTag("pending_error_request-2")
            .performScrollTo()
            .assertTextEquals("The selected Agent session is no longer available")
        composeRule.onNodeWithTag("retry_failed_request-2").assertDoesNotExist()
        composeRule.onNodeWithTag("retry_unavailable_request-2").assertIsDisplayed()
    }

    @Test
    fun unavailableRuntimeControlsDoNotReserveSpaceForAnEmptyHint() {
        val session = RelaySession(
            hostId = "host-1",
            name = "local:demo",
            protocolSessionId = "session-1",
        )

        composeRule.setContent {
            TwTheme {
                AgentChatScreen(
                    session = session,
                    connectionStatus = ConnectionStatus.ONLINE,
                    chatState = RelayChatState(),
                    draft = "",
                    onDraftChange = {},
                    onBack = {},
                    onOpenDetails = {},
                    onOpenTerminal = {},
                    runtimeSettings = AgentChatRuntimeSettings(),
                    onRuntimeSettingsChange = {},
                    runtimeSettingsAvailable = false,
                    runtimeSettingsUnavailableMessage = null,
                    onSend = { _, _ -> },
                    onRetryFailed = {},
                )
            }
        }

        composeRule.onNodeWithTag("chat_runtime_settings").assertIsDisplayed()
        composeRule.onNodeWithTag("chat_runtime_settings_unavailable").assertDoesNotExist()
        composeRule.onNodeWithText(
            "Update the Host and reconnect to change model, effort or mode.",
        ).assertDoesNotExist()
    }

}
