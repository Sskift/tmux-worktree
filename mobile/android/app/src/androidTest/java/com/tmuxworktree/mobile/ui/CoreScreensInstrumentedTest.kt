package com.tmuxworktree.mobile.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.tmuxworktree.mobile.core.model.AgentState
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.DeliveryState
import com.tmuxworktree.mobile.core.model.DemoData
import com.tmuxworktree.mobile.core.model.RelayScope
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.model.TimelineActor
import com.tmuxworktree.mobile.core.model.TimelineEvent
import com.tmuxworktree.mobile.feature.pairing.PairingScreen
import com.tmuxworktree.mobile.feature.workspaces.WorkspacesScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Rule
import org.junit.Test

class CoreScreensInstrumentedTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun inboxRoutesEachControlToItsExactCallbackPayload() {
        val waiting = RelaySession(
            hostId = "host",
            name = "local:waiting",
            rawName = "waiting",
            agentState = AgentState.WAITING_FOR_USER,
            activityAtSeconds = 1,
            summary = "Needs a decision",
        )
        val running = RelaySession(
            hostId = "host",
            name = "local:running",
            rawName = "running",
            agentState = AgentState.RUNNING,
            activityAtSeconds = 1,
        )
        val terminal = RelaySession(
            hostId = "host",
            name = "local:terminal",
            rawName = "terminal",
            kind = "terminal",
            agentState = AgentState.UNKNOWN,
            activityAtSeconds = 1,
        )
        var opened: RelaySession? = null
        var replied: RelaySession? = null
        var menuClicks = 0
        var healthClicks = 0
        var newWorktreeClicks = 0
        var destination: RootDestination? = null
        composeRule.setContent {
            TwTheme {
                InboxScreen(
                    sessions = listOf(waiting, running, terminal),
                    connectionStatus = ConnectionStatus.RECOVERING,
                    nowMillis = 60_000,
                    onMenuClick = { menuClicks++ },
                    onConnectionStatusClick = { healthClicks++ },
                    onSessionClick = { opened = it },
                    onReplyClick = { replied = it },
                    onNewWorktreeClick = { newWorktreeClicks++ },
                    onBottomDestinationSelected = { destination = it },
                )
            }
        }

        composeRule.onNodeWithTag("topbar_menu").performClick()
        composeRule.onNodeWithTag("connection_status_chip").performClick()
        composeRule.onNodeWithTag("attention_session_${waiting.stableId}").performClick()
        composeRule.onNodeWithTag("reply_session_${waiting.stableId}").performClick()
        composeRule.onNodeWithTag("new_worktree_button").performClick()
        composeRule.onNodeWithTag("nav_workspaces").performClick()
        composeRule.onNodeWithTag("running_session_${terminal.stableId}")
            .assertDoesNotExist()

        composeRule.runOnIdle {
            assertEquals(1, menuClicks)
            assertEquals(1, healthClicks)
            assertEquals(1, newWorktreeClicks)
            assertSame(waiting, opened)
            assertSame(waiting, replied)
            assertEquals(RootDestination.WORKSPACES, destination)
        }
    }

    @Test
    fun sessionSendDeliversTrimmedTextWithoutClearingDraftBeforeOwnerConfirmsEnqueue() {
        val session = RelaySession(
            hostId = "host",
            name = "local:demo",
            rawName = "demo",
            agentState = AgentState.WAITING_FOR_USER,
        )
        var draft by mutableStateOf("  keep this draft  ")
        var sent: String? = null
        composeRule.setContent {
            TwTheme {
                SessionDetailScreen(
                    session = session,
                    connectionStatus = ConnectionStatus.ONLINE,
                    timeline = emptyList(),
                    draft = draft,
                    nowMillis = 1_000,
                    onDraftChange = { draft = it },
                    onBack = {},
                    onConnectionStatusClick = {},
                    onOpenTerminal = {},
                    onOverflowClick = {},
                    onSend = { sent = it },
                )
            }
        }

        composeRule.onNodeWithTag("send_reply").performClick()

        composeRule.runOnIdle { assertEquals("keep this draft", sent) }
        composeRule.onNodeWithTag("reply_input")
            .assertIsDisplayed()
            .assertTextEquals("  keep this draft  ")
    }

    @Test
    fun connectionHealthRetryTagInvokesRetryAndDiagnosticsIndependently() {
        var retryClicks = 0
        var diagnosticsClicks = 0
        composeRule.setContent {
            TwTheme {
                ConnectionHealthScreen(
                    health = DemoData.health(recovering = true),
                    nowMillis = System.currentTimeMillis(),
                    onBack = {},
                    onRetryNow = { retryClicks++ },
                    onCopyDiagnostics = { diagnosticsClicks++ },
                )
            }
        }

        composeRule.onNodeWithTag("health_retry")
            .assertIsDisplayed()
            .performClick()
        composeRule.onNodeWithTag("health_copy_diagnostics")
            .assertIsDisplayed()
            .performClick()

        composeRule.runOnIdle {
            assertEquals(1, retryClicks)
            assertEquals(1, diagnosticsClicks)
        }
    }

    @Test
    fun relayV1SessionExplainsMissingAgentDataAndExposesSafeMessageActions() {
        val session = RelaySession(
            hostId = "host",
            name = "local:demo",
            rawName = "demo",
            agentState = AgentState.UNKNOWN,
        )
        val queued = TimelineEvent(
            eventId = "outbox:message-1",
            sessionId = session.stableId,
            actor = TimelineActor.USER,
            body = "Keep testing",
            createdAtMillis = 500,
            deliveryState = DeliveryState.QUEUED,
        )
        var cancelled: TimelineEvent? = null
        composeRule.setContent {
            TwTheme {
                SessionDetailScreen(
                    session = session,
                    connectionStatus = ConnectionStatus.ONLINE,
                    timeline = listOf(queued),
                    draft = "",
                    nowMillis = 1_000,
                    onDraftChange = {},
                    onBack = {},
                    onConnectionStatusClick = {},
                    onOpenTerminal = {},
                    onOverflowClick = {},
                    onSend = {},
                    agentStateAvailable = false,
                    onCancelMessage = { cancelled = it },
                )
            }
        }

        composeRule.onNodeWithTag("relay_v1_session_limitation")
            .assertIsDisplayed()
        composeRule.onNodeWithTag("session_attachment")
            .performClick()
        composeRule.onNodeWithText("Attachments need Relay v2")
            .assertIsDisplayed()
        composeRule.onNodeWithTag("dismiss_attachment_notice")
            .performClick()
        composeRule.onNodeWithTag(
            "message_delivery_action_${queued.eventId}",
            useUnmergedTree = true,
        )
            .performScrollTo()
            .performClick()

        composeRule.runOnIdle { assertSame(queued, cancelled) }
    }

    @Test
    fun workspacesSeparatesWorktreesFromTerminalsAndOpensTerminalDirectly() {
        val worktree = RelaySession(
            hostId = "host",
            name = "local:worktree",
            rawName = "worktree",
            kind = "worktree",
            project = "dashboard",
            scopeId = "local",
        )
        val terminal = RelaySession(
            hostId = "host",
            name = "local:shell",
            rawName = "shell",
            kind = "terminal",
            cwd = "/tmp",
            scopeId = "local",
        )
        var openedWorktree: RelaySession? = null
        var openedTerminal: RelaySession? = null
        composeRule.setContent {
            TwTheme {
                WorkspacesScreen(
                    sessions = listOf(worktree, terminal),
                    scopes = listOf(RelayScope("host", "local", sessionCount = 2)),
                    connectionStatus = ConnectionStatus.ONLINE,
                    selectedScopeId = null,
                    attentionCount = 0,
                    onConnectionStatusClick = {},
                    onScopeSelected = {},
                    onSessionClick = { openedWorktree = it },
                    onTerminalClick = { openedTerminal = it },
                    onNewWorktreeClick = {},
                    onBottomDestinationSelected = {},
                    activeHostId = "host",
                )
            }
        }

        composeRule.onNodeWithTag("workspace_worktrees_heading")
            .assertIsDisplayed()
        composeRule.onNodeWithTag("workspace_session_${worktree.stableId}")
            .performClick()
        composeRule.onNodeWithTag("workspace_terminals_heading")
            .performScrollTo()
            .assertIsDisplayed()
        composeRule.onNodeWithTag("workspace_terminal_${terminal.stableId}")
            .performScrollTo()
            .performClick()

        composeRule.runOnIdle {
            assertSame(worktree, openedWorktree)
            assertSame(terminal, openedTerminal)
        }
    }

    @Test
    fun terminalFontControlsRespectTenToTwentyFourSpBoundary() {
        var fontSize by mutableStateOf(10)
        composeRule.setContent {
            TwTheme {
                TerminalScreen(
                    sessionTitle = "demo",
                    connectionStatus = ConnectionStatus.ONLINE,
                    isReadOnly = false,
                    keyboardVisible = true,
                    terminalFontSizeSp = fontSize,
                    disconnectReason = null,
                    onBack = {},
                    onConnectionStatusClick = {},
                    onReconnect = {},
                    onToggleKeyboard = {},
                    onDecreaseFont = { fontSize-- },
                    onIncreaseFont = { fontSize++ },
                    onToggleReadOnly = {},
                    terminalContent = {},
                )
            }
        }

        composeRule.onNodeWithTag("terminal_font_decrease")
            .assertIsNotEnabled()
        composeRule.onNodeWithTag("terminal_font_increase")
            .assertIsEnabled()
            .performClick()
        composeRule.onNodeWithTag("terminal_font_size")
            .assertTextEquals("11sp")

        composeRule.runOnIdle { fontSize = 24 }
        composeRule.onNodeWithTag("terminal_font_increase")
            .assertIsNotEnabled()
        composeRule.onNodeWithTag("terminal_font_decrease")
            .assertIsEnabled()
    }

    @Test
    fun forgettingPairingRequiresExplicitConfirmation() {
        var forgetCount = 0
        composeRule.setContent {
            TwTheme {
                PairingScreen(
                    relayUrl = "wss://relay.example.com",
                    token = "paired-token",
                    isConnecting = false,
                    error = null,
                    onRelayUrlChange = {},
                    onTokenChange = {},
                    onScanQr = {},
                    onConnect = {},
                    onForgetPairing = { forgetCount++ },
                )
            }
        }

        composeRule.onNodeWithTag("pairing_forget")
            .performScrollTo()
            .performClick()
        composeRule.runOnIdle { assertEquals(0, forgetCount) }
        composeRule.onNodeWithTag("cancel_forget_pairing")
            .performClick()
        composeRule.onNodeWithTag("pairing_forget")
            .performScrollTo()
            .performClick()
        composeRule.onNodeWithTag("confirm_forget_pairing")
            .performClick()

        composeRule.runOnIdle { assertEquals(1, forgetCount) }
    }
}
