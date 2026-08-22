package com.tmuxworktree.mobile.feature

import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import com.tmuxworktree.mobile.core.data.AppPreferences
import com.tmuxworktree.mobile.core.model.AgentEvidenceAvailability
import com.tmuxworktree.mobile.core.model.AgentState
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.DeliveryState
import com.tmuxworktree.mobile.core.model.DemoData
import com.tmuxworktree.mobile.core.model.RelayScope
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.model.SessionTimelineState
import com.tmuxworktree.mobile.core.model.TimelineActor
import com.tmuxworktree.mobile.core.model.TimelineEvent
import com.tmuxworktree.mobile.designsystem.TwTheme
import com.tmuxworktree.mobile.feature.connection.ConnectionHealthScreen
import com.tmuxworktree.mobile.feature.inbox.InboxScreen
import com.tmuxworktree.mobile.feature.pairing.PairingScreen
import com.tmuxworktree.mobile.feature.pairing.RelayV2EnrollmentReviewScreen
import com.tmuxworktree.mobile.feature.session.SessionDetailScreen
import com.tmuxworktree.mobile.feature.settings.SettingsScreen
import com.tmuxworktree.mobile.feature.terminal.TerminalScreen
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
        var menuClicks = 0
        var healthClicks = 0
        composeRule.setContent {
            TwTheme {
                InboxScreen(
                    sessions = listOf(waiting, running, terminal),
                    connectionStatus = ConnectionStatus.RECOVERING,
                    nowMillis = 60_000,
                    onMenuClick = { menuClicks++ },
                    onConnectionStatusClick = { healthClicks++ },
                    onSessionClick = { opened = it },
                )
            }
        }

        composeRule.onNodeWithTag("topbar_menu").performClick()
        composeRule.onNodeWithTag("connection_status_chip").performClick()
        composeRule.onNodeWithTag("attention_session_${waiting.stableId}").performClick()
        composeRule.onNodeWithTag("running_session_${terminal.stableId}")
            .assertDoesNotExist()

        composeRule.runOnIdle {
            assertEquals(1, menuClicks)
            assertEquals(1, healthClicks)
            assertSame(waiting, opened)
        }
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
    fun sessionAgentEvidenceUnavailableNoticeKeepsTimelineActionAvailable() {
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
        var agentEvidenceAvailability by mutableStateOf(
            AgentEvidenceAvailability.RELAY_V2_UNAVAILABLE,
        )
        composeRule.setContent {
            TwTheme {
                SessionDetailScreen(
                    session = session,
                    connectionStatus = ConnectionStatus.ONLINE,
                    timelineState = SessionTimelineState(
                        events = listOf(queued),
                        agentEvidenceAvailability = agentEvidenceAvailability,
                    ),
                    nowMillis = 1_000,
                    onBack = {},
                    onConnectionStatusClick = {},
                    onOverflowClick = {},
                    agentStateAvailable = false,
                    onCancelMessage = { cancelled = it },
                )
            }
        }

        composeRule.onNodeWithTag("relay_v2_agent_evidence_unavailable")
            .assertIsDisplayed()
        composeRule.onNodeWithTag(
            "message_delivery_action_${queued.eventId}",
            useUnmergedTree = true,
        )
            .performScrollTo()
            .performClick()

        composeRule.runOnIdle {
            assertSame(queued, cancelled)
        }
        composeRule.onNodeWithText(
            "Agent transcript and lifecycle evidence are unavailable for this Relay v2 session. " +
                "Chat remains disabled until the Host provides that capability.",
        ).assertIsDisplayed()

        composeRule.runOnIdle {
            agentEvidenceAvailability = AgentEvidenceAvailability.AVAILABLE
        }
        composeRule.onNodeWithTag("relay_v2_agent_evidence_unavailable")
            .assertDoesNotExist()
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
                    onConnectionStatusClick = {},
                    onScopeSelected = {},
                    onSessionClick = { openedWorktree = it },
                    onTerminalClick = { openedTerminal = it },
                    onNewWorktreeClick = {},
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
                    ownershipReadOnly = false,
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
                    onRetryInput = {},
                    terminalContent = {},
                )
            }
        }

        composeRule.onNodeWithTag("terminal_font_decrease")
            .assertDoesNotExist()
        composeRule.onNodeWithTag("terminal_options")
            .assertIsDisplayed()
            .performClick()
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
    fun ownershipReadOnlyOffersRetryWithoutTogglingTheLocalReadOnlyControl() {
        var retryCount = 0
        var toggleCount = 0
        composeRule.setContent {
            TwTheme {
                TerminalScreen(
                    sessionTitle = "owned elsewhere",
                    connectionStatus = ConnectionStatus.ONLINE,
                    isReadOnly = true,
                    ownershipReadOnly = true,
                    keyboardVisible = false,
                    terminalFontSizeSp = 14,
                    disconnectReason = null,
                    onBack = {},
                    onConnectionStatusClick = {},
                    onReconnect = {},
                    onToggleKeyboard = {},
                    onDecreaseFont = {},
                    onIncreaseFont = {},
                    onToggleReadOnly = { toggleCount++ },
                    onRetryInput = { retryCount++ },
                    terminalContent = {},
                )
            }
        }

        composeRule.onNodeWithTag("terminal_retry_input")
            .assertIsDisplayed()
            .performClick()
        composeRule.onNodeWithTag("terminal_options")
            .performClick()
        composeRule.onNodeWithTag("terminal_read_only")
            .assertContentDescriptionEquals("Retry terminal input")
            .performClick()

        composeRule.runOnIdle {
            assertEquals(2, retryCount)
            assertEquals(0, toggleCount)
        }
    }

    @Test
    fun localInputLockDoesNotDisposeTerminalContentOrInvokeLifecycleCallbacks() {
        var readOnly by mutableStateOf(false)
        var toggleCount = 0
        var retryCount = 0
        var reconnectCount = 0
        var contentMountCount = 0
        var contentDisposeCount = 0
        composeRule.setContent {
            TwTheme {
                TerminalScreen(
                    sessionTitle = "stable terminal",
                    connectionStatus = ConnectionStatus.ONLINE,
                    isReadOnly = readOnly,
                    ownershipReadOnly = false,
                    keyboardVisible = false,
                    terminalFontSizeSp = 14,
                    disconnectReason = null,
                    onBack = {},
                    onConnectionStatusClick = {},
                    onReconnect = { reconnectCount++ },
                    onToggleKeyboard = {},
                    onDecreaseFont = {},
                    onIncreaseFont = {},
                    onToggleReadOnly = {
                        toggleCount++
                        readOnly = !readOnly
                    },
                    onRetryInput = { retryCount++ },
                    terminalContent = {
                        DisposableEffect(Unit) {
                            contentMountCount++
                            onDispose { contentDisposeCount++ }
                        }
                    },
                )
            }
        }

        composeRule.onNodeWithTag("terminal_options").performClick()
        composeRule.onNodeWithTag("terminal_read_only")
            .assertContentDescriptionEquals("Switch terminal to read-only")
            .performClick()
        composeRule.onNodeWithTag("terminal_options").performClick()
        composeRule.onNodeWithTag("terminal_read_only")
            .assertContentDescriptionEquals("Enable terminal input")
            .performClick()

        composeRule.runOnIdle {
            assertEquals(2, toggleCount)
            assertEquals(0, retryCount)
            assertEquals(0, reconnectCount)
            assertEquals(1, contentMountCount)
            assertEquals(0, contentDisposeCount)
        }
    }

    @Test
    fun forgettingPairingRequiresExplicitConfirmation() {
        var forgetCount = 0
        composeRule.setContent {
            TwTheme {
                PairingScreen(
                    isConnecting = false,
                    error = null,
                    onScanQr = {},
                    onManualRelayV2Enrollment = { _, _ -> },
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

    @Test
    fun pairingScreenExposesOnlyRelayV2EnrollmentActions() {
        val error = "Debug ws:// is limited to emulator or loopback hosts. " +
            "Use wss:// for .local and other network hosts"
        composeRule.setContent {
            TwTheme {
                PairingScreen(
                    isConnecting = false,
                    error = error,
                    onScanQr = {},
                    onManualRelayV2Enrollment = { _, _ -> },
                )
            }
        }

        composeRule.onNodeWithText("This app accepts Relay v2 enrollment only", substring = true)
            .assertIsDisplayed()
        composeRule.onNodeWithTag("pairing_scan_qr").assertIsDisplayed()
        composeRule.onNodeWithTag("pairing_relay_v2_enrollment").assertIsDisplayed()
        composeRule.onNodeWithText(error).assertIsDisplayed()
        composeRule.onNodeWithTag("pairing_connect")
            .assertDoesNotExist()
    }

    @Test
    fun relayV2EnrollmentReviewShowsTheOwnedDeviceLabelBeforeConfirm() {
        var confirmCount = 0
        composeRule.setContent {
            TwTheme {
                RelayV2EnrollmentReviewScreen(
                    issuerUrl = "https://relay.example.com",
                    relayUrl = "wss://relay.example.com/client",
                    hostId = "mac-admin",
                    enrollmentId = "enrollment-1",
                    deviceLabel = "Pixel 9 Pro",
                    submitting = false,
                    completed = false,
                    activating = false,
                    activationFailureMessage = null,
                    failureMessage = null,
                    onConfirm = { confirmCount++ },
                    onActivate = {},
                    onCancel = {},
                )
            }
        }

        composeRule.onNodeWithText("Android device").assertIsDisplayed()
        composeRule.onNodeWithText("Pixel 9 Pro").assertIsDisplayed()
        composeRule.onNodeWithTag("relay_v2_enrollment_confirm").performClick()
        composeRule.runOnIdle { assertEquals(1, confirmCount) }
    }

    @Test
    fun settingsManualRelayV2EnrollmentPassesTheExactEnteredTokenForReview() {
        var submittedIssuer: String? = null
        var submittedToken: String? = null
        val token = "tmuxworktree://enroll?v=2" +
            "&issuerUrl=https%3A%2F%2Frelay.example.com" +
            "&relayUrl=wss%3A%2F%2Frelay.example.com%2Fclient" +
            "&hostId=mac-admin&enrollmentId=enrollment-1" +
            "&enrollmentCode=twenroll2.one-time-code"
        val enteredToken = " $token "
        composeRule.setContent {
            TwTheme {
                SettingsScreen(
                    connectionStatus = ConnectionStatus.ONLINE,
                    preferences = AppPreferences(),
                    pairedDeviceName = "Mac",
                    versionName = "test",
                    onHealthClick = {},
                    onPairedDeviceClick = {},
                    onManualRelayV2Enrollment = { issuer, oneTimeToken ->
                        submittedIssuer = issuer
                        submittedToken = oneTimeToken
                    },
                    onNotificationChanged = { _, _ -> },
                    onDarkThemeChanged = {},
                    onCopyDiagnostics = {},
                )
            }
        }

        composeRule.onNodeWithTag("settings_relay_v2_enrollment")
            .performScrollTo()
            .performClick()
        composeRule.onNodeWithTag("relay_v2_manual_continue").assertIsNotEnabled()
        composeRule.onNodeWithTag("relay_v2_manual_issuer")
            .performTextInput("  https://relay.example.com  ")
        composeRule.onNodeWithTag("relay_v2_manual_token").performTextInput(enteredToken)
        composeRule.onNodeWithTag("relay_v2_manual_continue")
            .assertIsEnabled()
            .performClick()

        composeRule.runOnIdle {
            assertEquals("https://relay.example.com", submittedIssuer)
            assertEquals(enteredToken, submittedToken)
        }
    }

    @Test
    fun freshPairingManualRelayV2EnrollmentRoutesToCallback() {
        var submittedIssuer: String? = null
        var submittedToken: String? = null
        val issuer = "https://relay.example.com"
        val token = "tmuxworktree://enroll?v=2"
        composeRule.setContent {
            TwTheme {
                PairingScreen(
                    isConnecting = false,
                    error = null,
                    onScanQr = {},
                    onManualRelayV2Enrollment = { enteredIssuer, enteredToken ->
                        submittedIssuer = enteredIssuer
                        submittedToken = enteredToken
                    },
                )
            }
        }

        composeRule.onNodeWithTag("pairing_relay_v2_enrollment")
            .performScrollTo()
            .performClick()
        composeRule.onNodeWithText("Manual Relay v2 enrollment").assertIsDisplayed()
        composeRule.onNodeWithTag("relay_v2_manual_issuer").performTextInput(issuer)
        composeRule.onNodeWithTag("relay_v2_manual_token").performTextInput(token)
        composeRule.onNodeWithTag("relay_v2_manual_continue").performClick()

        composeRule.runOnIdle {
            assertEquals(issuer, submittedIssuer)
            assertEquals(token, submittedToken)
        }
    }
}
