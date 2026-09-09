package com.tmuxworktree.mobile.feature.terminal

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Keyboard
import androidx.compose.material.icons.outlined.KeyboardHide
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.LockOpen
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.TextDecrease
import androidx.compose.material.icons.outlined.TextIncrease
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.designsystem.*

@Composable
fun TerminalScreen(
    sessionTitle: String,
    connectionStatus: ConnectionStatus,
    isReadOnly: Boolean,
    ownershipReadOnly: Boolean,
    keyboardVisible: Boolean,
    terminalFontSizeSp: Int,
    disconnectReason: String?,
    onBack: () -> Unit,
    onConnectionStatusClick: () -> Unit,
    onReconnect: () -> Unit,
    onToggleKeyboard: () -> Unit,
    onDecreaseFont: () -> Unit,
    onIncreaseFont: () -> Unit,
    onToggleReadOnly: () -> Unit,
    onRetryInput: () -> Unit,
    modifier: Modifier = Modifier,
    terminalContent: @Composable BoxScope.() -> Unit,
) {
    val terminalOnline = connectionStatus == ConnectionStatus.ONLINE
    val boundedFontSizeSp = terminalFontSizeSp.coerceIn(MIN_TERMINAL_FONT_SP, MAX_TERMINAL_FONT_SP)
    val density = LocalDensity.current
    val imeAboveNavigation = with(density) {
        (
            WindowInsets.ime.getBottom(this) -
                WindowInsets.navigationBars.getBottom(this)
            )
            .coerceAtLeast(0)
            .toDp()
    }
    Scaffold(
        modifier = modifier
            .fillMaxSize()
            .testTag("terminal_screen"),
        containerColor = TwTerminalBackground,
        topBar = {
            TerminalTopBar(
                sessionTitle = sessionTitle,
                connectionStatus = connectionStatus,
                terminalOnline = terminalOnline,
                isReadOnly = isReadOnly,
                ownershipReadOnly = ownershipReadOnly,
                keyboardVisible = keyboardVisible,
                fontSizeSp = boundedFontSizeSp,
                onBack = onBack,
                onConnectionStatusClick = onConnectionStatusClick,
                onToggleKeyboard = onToggleKeyboard,
                onDecreaseFont = onDecreaseFont,
                onIncreaseFont = onIncreaseFont,
                onToggleReadOnly = onToggleReadOnly,
                onRetryInput = onRetryInput,
            )
        },
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                // Scaffold already reserves the navigation-safe phone bottom. While typing,
                // consume only the part of IME above that inset; the raw IME height includes
                // the navigation bar and would otherwise leave a full system-bar gap.
                .padding(innerPadding)
                .padding(bottom = if (keyboardVisible) imeAboveNavigation else 0.dp),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(TwTerminalBackground)
                    .testTag("terminal_content")
                    .semantics {
                        contentDescription = "$sessionTitle terminal output"
                    },
                content = terminalContent,
            )

            if (ownershipReadOnly && terminalOnline) {
                InputUnavailableBanner(
                    onRetryInput = onRetryInput,
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                )
            }

            if (!terminalOnline) {
                DisconnectedOverlay(
                    status = connectionStatus,
                    reason = disconnectReason,
                    onReconnect = onReconnect,
                )
            }
        }
    }
}

@Composable
private fun TerminalTopBar(
    sessionTitle: String,
    connectionStatus: ConnectionStatus,
    terminalOnline: Boolean,
    isReadOnly: Boolean,
    ownershipReadOnly: Boolean,
    keyboardVisible: Boolean,
    fontSizeSp: Int,
    onBack: () -> Unit,
    onConnectionStatusClick: () -> Unit,
    onToggleKeyboard: () -> Unit,
    onDecreaseFont: () -> Unit,
    onIncreaseFont: () -> Unit,
    onToggleReadOnly: () -> Unit,
    onRetryInput: () -> Unit,
) {
    var controlsExpanded by remember { mutableStateOf(false) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(TwBackground),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .height(64.dp)
                .padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = onBack,
                modifier = Modifier
                    .size(48.dp)
                    .testTag("terminal_back"),
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Outlined.ArrowBack,
                    contentDescription = "Return to session",
                    tint = TwTextSecondary,
                    modifier = Modifier.size(24.dp),
                )
            }
            Spacer(Modifier.width(8.dp))
            Text(
                text = sessionTitle,
                color = TwTextPrimary,
                style = MaterialTheme.typography.titleLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .testTag("terminal_title"),
            )
            Spacer(Modifier.width(8.dp))
            Box(modifier = Modifier.testTag("terminal_stream_status")) {
                TwConnectionStatusChip(
                    status = connectionStatus,
                    onClick = onConnectionStatusClick,
                )
            }
            Box {
                IconButton(
                    onClick = { controlsExpanded = true },
                    modifier = Modifier
                        .size(48.dp)
                        .testTag("terminal_options")
                        .semantics {
                            contentDescription = "Open terminal controls"
                            stateDescription = when {
                                ownershipReadOnly -> "Input unavailable"
                                isReadOnly -> "Read-only enabled"
                                else -> "Terminal input enabled"
                            }
                        },
                ) {
                    Icon(
                        imageVector = if (isReadOnly) Icons.Outlined.Lock else Icons.Outlined.MoreVert,
                        contentDescription = null,
                        tint = if (isReadOnly) TwWarning else TwTextSecondary,
                        modifier = Modifier.size(24.dp),
                    )
                }
                TerminalControlsMenu(
                    expanded = controlsExpanded,
                    terminalOnline = terminalOnline,
                    isReadOnly = isReadOnly,
                    ownershipReadOnly = ownershipReadOnly,
                    keyboardVisible = keyboardVisible,
                    fontSizeSp = fontSizeSp,
                    onDismiss = { controlsExpanded = false },
                    onToggleKeyboard = onToggleKeyboard,
                    onDecreaseFont = onDecreaseFont,
                    onIncreaseFont = onIncreaseFont,
                    onToggleReadOnly = onToggleReadOnly,
                    onRetryInput = onRetryInput,
                )
            }
        }
        HorizontalDivider(color = TwBorder, thickness = 1.dp)
    }
}

@Composable
private fun InputUnavailableBanner(
    onRetryInput: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val description = "Terminal input is temporarily unavailable. Retry input to ask the controller again."
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .testTag("terminal_read_only_banner")
            .semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = description
            },
        color = TwSurface.copy(alpha = 0.96f),
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, TwWarning),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Outlined.LinkOff,
                contentDescription = null,
                tint = TwWarning,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(10.dp))
            Text(
                text = "Input unavailable · controller rejected input",
                color = TwTextPrimary,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            TextButton(
                onClick = onRetryInput,
                modifier = Modifier.testTag("terminal_retry_input"),
            ) {
                Text("Retry input")
            }
        }
    }
}

@Composable
private fun BoxScope.DisconnectedOverlay(
    status: ConnectionStatus,
    reason: String?,
    onReconnect: () -> Unit,
) {
    val title = terminalDisconnectedTitle(status)
    val detail = terminalDisconnectDetail(reason, status)
    val retryAvailable = status == ConnectionStatus.OFFLINE ||
        status == ConnectionStatus.PAUSED ||
        status == ConnectionStatus.RECOVERING ||
        status == ConnectionStatus.UNKNOWN
    val progressVisible = status == ConnectionStatus.CONNECTING ||
        status == ConnectionStatus.RECOVERING

    Surface(
        modifier = Modifier
            .fillMaxSize()
            .align(Alignment.Center)
            .testTag("terminal_disconnected_overlay")
            .semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = "$title. $detail"
            },
        color = TwBackground.copy(alpha = 0.94f),
    ) {
        Box(modifier = Modifier.fillMaxSize()) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .pointerInput(Unit) {
                        awaitPointerEventScope {
                            while (true) {
                                awaitPointerEvent().changes.forEach { it.consume() }
                            }
                        }
                    },
            )
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Icon(
                    imageVector = if (status == ConnectionStatus.CONNECTING ||
                        status == ConnectionStatus.RECOVERING
                    ) {
                        Icons.Outlined.CloudOff
                    } else {
                        Icons.Outlined.LinkOff
                    },
                    contentDescription = null,
                    tint = status.visual().color,
                    modifier = Modifier.size(42.dp),
                )
                Spacer(Modifier.height(16.dp))
                Text(
                    text = title,
                    color = TwTextPrimary,
                    style = MaterialTheme.typography.titleLarge,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    text = detail,
                    color = TwTextSecondary,
                    style = MaterialTheme.typography.bodyLarge,
                )
                if (progressVisible) {
                    Spacer(Modifier.height(20.dp))
                    CircularProgressIndicator(
                        color = TwAccent,
                        strokeWidth = 3.dp,
                        modifier = Modifier.size(30.dp),
                    )
                }
                if (retryAvailable) {
                    Spacer(Modifier.height(20.dp))
                    Button(
                        onClick = onReconnect,
                        modifier = Modifier
                            .width(164.dp)
                            .height(48.dp)
                            .testTag("terminal_reconnect"),
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = TwAccent,
                            contentColor = TwOnAccent,
                        ),
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.Refresh,
                            contentDescription = null,
                            modifier = Modifier.size(20.dp),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = "Reconnect",
                            style = MaterialTheme.typography.labelLarge,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TerminalControlsMenu(
    expanded: Boolean,
    terminalOnline: Boolean,
    isReadOnly: Boolean,
    ownershipReadOnly: Boolean,
    keyboardVisible: Boolean,
    fontSizeSp: Int,
    onToggleKeyboard: () -> Unit,
    onDecreaseFont: () -> Unit,
    onIncreaseFont: () -> Unit,
    onToggleReadOnly: () -> Unit,
    onRetryInput: () -> Unit,
    onDismiss: () -> Unit,
) {
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
        modifier = Modifier
            .width(280.dp)
            .testTag("terminal_controls_menu"),
    ) {
        DropdownMenuItem(
            text = {
                Text(if (keyboardVisible) "Hide keyboard" else "Show keyboard")
            },
            onClick = {
                onDismiss()
                onToggleKeyboard()
            },
            enabled = terminalOnline && !isReadOnly,
            leadingIcon = {
                Icon(
                    imageVector = if (keyboardVisible) {
                        Icons.Outlined.KeyboardHide
                    } else {
                        Icons.Outlined.Keyboard
                    },
                    contentDescription = null,
                )
            },
            modifier = Modifier
                .testTag("terminal_keyboard")
                .semantics {
                    contentDescription = if (keyboardVisible) {
                        "Hide terminal keyboard"
                    } else {
                        "Show terminal keyboard"
                    }
                    stateDescription = if (keyboardVisible) {
                        "Keyboard visible"
                    } else {
                        "Keyboard hidden"
                    }
                },
        )

        HorizontalDivider(color = TwBorder, thickness = 1.dp)

        Text(
            text = "Font size",
            color = TwTextSecondary,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(start = 16.dp, top = 12.dp),
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
                .padding(horizontal = 8.dp)
                .testTag("terminal_font_controls"),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = onDecreaseFont,
                enabled = fontSizeSp > MIN_TERMINAL_FONT_SP,
                modifier = Modifier
                    .size(48.dp)
                    .testTag("terminal_font_decrease")
                    .semantics {
                        contentDescription = "Decrease terminal font size"
                    },
            ) {
                Icon(
                    imageVector = Icons.Outlined.TextDecrease,
                    contentDescription = null,
                    tint = if (fontSizeSp > MIN_TERMINAL_FONT_SP) TwTextPrimary else TwTextMuted,
                    modifier = Modifier.size(24.dp),
                )
            }
            Text(
                text = "${fontSizeSp}sp",
                color = TwTextSecondary,
                style = MaterialTheme.typography.labelMedium,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .width(44.dp)
                    .testTag("terminal_font_size")
                    .semantics {
                        contentDescription = "Terminal font size, $fontSizeSp scale-independent pixels"
                    },
            )
            IconButton(
                onClick = onIncreaseFont,
                enabled = fontSizeSp < MAX_TERMINAL_FONT_SP,
                modifier = Modifier
                    .size(48.dp)
                    .testTag("terminal_font_increase")
                    .semantics {
                        contentDescription = "Increase terminal font size"
                    },
            ) {
                Icon(
                    imageVector = Icons.Outlined.TextIncrease,
                    contentDescription = null,
                    tint = if (fontSizeSp < MAX_TERMINAL_FONT_SP) TwTextPrimary else TwTextMuted,
                    modifier = Modifier.size(24.dp),
                )
            }
        }

        HorizontalDivider(color = TwBorder, thickness = 1.dp)

        DropdownMenuItem(
            text = {
                Text(
                    when {
                        ownershipReadOnly -> "Retry input"
                        isReadOnly -> "Unlock terminal input"
                        else -> "Lock terminal input"
                    },
                )
            },
            onClick = {
                onDismiss()
                if (ownershipReadOnly) onRetryInput() else onToggleReadOnly()
            },
            enabled = terminalOnline,
            leadingIcon = {
                Icon(
                    imageVector = when {
                        ownershipReadOnly -> Icons.Outlined.Refresh
                        isReadOnly -> Icons.Outlined.Lock
                        else -> Icons.Outlined.LockOpen
                    },
                    contentDescription = null,
                    tint = when {
                        !terminalOnline -> TwTextMuted
                        ownershipReadOnly || isReadOnly -> TwWarning
                        else -> TwSuccess
                    },
                )
            },
            modifier = Modifier
                .testTag("terminal_read_only")
                .semantics {
                    contentDescription = when {
                        ownershipReadOnly -> "Retry terminal input"
                        isReadOnly -> "Enable terminal input"
                        else -> "Switch terminal to read-only"
                    }
                    stateDescription = when {
                        ownershipReadOnly -> "Input unavailable"
                        isReadOnly -> "Read-only enabled"
                        else -> "Terminal input enabled"
                    }
                },
        )
    }
}

private const val MIN_TERMINAL_FONT_SP = 10
private const val MAX_TERMINAL_FONT_SP = 24

private fun terminalDisconnectedTitle(status: ConnectionStatus): String = when (status) {
    ConnectionStatus.RECOVERING -> "Reconnecting terminal…"
    ConnectionStatus.CONNECTING -> "Opening terminal…"
    ConnectionStatus.PAUSED -> "Terminal paused"
    ConnectionStatus.OFFLINE -> "Terminal disconnected"
    ConnectionStatus.AUTH_REQUIRED -> "Sign in required"
    ConnectionStatus.INCOMPATIBLE -> "Update required"
    ConnectionStatus.UNKNOWN -> "Terminal unavailable"
    ConnectionStatus.ONLINE -> "Terminal online"
}

private fun terminalDisconnectedDetail(status: ConnectionStatus): String = when (status) {
    ConnectionStatus.RECOVERING -> "The last output remains available while the stream resumes."
    ConnectionStatus.CONNECTING -> "Connecting to the terminal stream."
    ConnectionStatus.PAUSED -> "Terminal input is paused until the connection recovers."
    ConnectionStatus.OFFLINE -> "The last output is read-only. No keystrokes will be queued."
    ConnectionStatus.AUTH_REQUIRED -> "Reconnect your device from Connection health."
    ConnectionStatus.INCOMPATIBLE -> "Update the mobile or desktop app before reopening the terminal."
    ConnectionStatus.UNKNOWN -> "The terminal stream state could not be confirmed."
    ConnectionStatus.ONLINE -> "Terminal input is available."
}

/**
 * User-facing copy for the internal reason token carried on TerminalStreamState.resetReason.
 * That field holds protocol enum names (RelayV2TerminalCloseReason / RelayV2TerminalResetReason
 * lowercased) and ViewModel-internal tokens; none of them may reach the user verbatim. Unknown
 * tokens — including reasons a future host/relay might add — fall back to the status-level copy,
 * so a newer backend can never leak a raw enum onto the screen.
 */
internal fun terminalDisconnectDetail(reason: String?, status: ConnectionStatus): String {
    val token = reason?.trim()?.takeIf { it.isNotEmpty() }
        ?: return terminalDisconnectedDetail(status)
    val copy = TERMINAL_DISCONNECT_REASON_COPY[token]
        ?: return terminalDisconnectedDetail(status)
    // While the stream is actively re-opening, say so; the offline copy already pairs with the
    // on-screen Reconnect button.
    return if (status == ConnectionStatus.RECOVERING) {
        "$copy Reconnecting automatically."
    } else {
        copy
    }
}

private val TERMINAL_DISCONNECT_REASON_COPY: Map<String, String> = mapOf(
    // RelayV2TerminalCloseReason — the session itself ended, no automatic resume.
    "client_closed" to "The terminal session was closed.",
    "backend_exit" to "Terminal session ended.",
    "backend_error" to "Terminal stopped unexpectedly.",
    // RelayV2TerminalResetReason — the stream resets and resumes on its own.
    "missing_checkpoint" to
        "No saved terminal state was found, so the stream is starting fresh.",
    "missing_required_identity" to
        "Terminal credentials are missing, so the stream must restart.",
    "schema_incompatible" to
        "The terminal stream version is incompatible. Update the app and reconnect.",
    "identity_changed" to
        "Terminal credentials changed, so the stream must restart.",
    "parser_continuity_lost" to
        "Terminal output continuity was interrupted; the stream is resuming.",
    "checkpoint_invalid" to
        "Saved terminal state could not be read, so the stream must restart.",
    "checkpoint_limit_exceeded" to
        "Saved terminal state grew past its limit, so the stream must restart.",
    "stream_lost" to "Connection to the terminal stream was lost.",
    "generation_stale" to
        "The terminal stream fell behind; it is resuming from the latest output.",
    "offset_expired" to
        "Terminal output replay expired, so the stream must start fresh.",
    "slow_consumer" to
        "This device could not keep up with terminal output; the stream is resuming.",
    "host_buffer_pressure" to
        "The host is buffering too much terminal output; the stream is resuming.",
    "parser_failure" to
        "Terminal output could not be parsed; the stream is resuming.",
    "protocol_order_conflict" to
        "Terminal stream ordering conflict, so the stream must restart.",
    // ViewModel-internal tokens (V2ViewModel) — already paired with an actionError notice;
    // the overlay must still show prose rather than the raw token.
    "terminal_open_timeout" to
        "Opening the terminal timed out; tap Reconnect to retry.",
    "terminal_auto_reconnect_paused" to
        "Automatic reconnect reached its limit; tap Reconnect to retry.",
    "detached_open_response" to
        "Reconnecting after the terminal stream was interrupted.",
    "terminal_retirement_failed" to
        "The previous terminal stream could not be replaced; tap Reconnect to retry.",
    "terminal_view_detach_failed" to
        "Terminal recovery could not finish cleanly; tap Reconnect to retry.",
    "renderer_recovery_exhausted" to
        "Terminal renderer recovery is paused; tap Reconnect to retry.",
    "terminal_attachment_unavailable" to
        "The terminal stream is unavailable; tap Reconnect to retry.",
    "renderer_crashed" to "The terminal renderer crashed; tap Reconnect to retry.",
    "renderer_gone" to "The terminal renderer became unavailable; tap Reconnect to retry.",
)

@Preview(showBackground = true, backgroundColor = 0xFF020509, widthDp = 390, heightDp = 844)
@Composable
private fun TerminalScreenPreview() {
    TwTheme {
        TerminalScreen(
            sessionTitle = "tmux-worktree-apk-re",
            connectionStatus = ConnectionStatus.ONLINE,
            isReadOnly = false,
            ownershipReadOnly = false,
            keyboardVisible = false,
            terminalFontSizeSp = 14,
            disconnectReason = null,
            onBack = {},
            onConnectionStatusClick = {},
            onReconnect = {},
            onToggleKeyboard = {},
            onDecreaseFont = {},
            onIncreaseFont = {},
            onToggleReadOnly = {},
            onRetryInput = {},
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .background(TwTerminalBackground)
                    .padding(16.dp),
            ) {
                Text(
                    text = "\$ ./gradlew :app:compileDebugKotlin",
                    color = TwTerminalText,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    text = "BUILD SUCCESSFUL",
                    color = TwSuccess,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

@Preview(showBackground = true, backgroundColor = 0xFF020509, widthDp = 390, heightDp = 844)
@Composable
private fun TerminalDisconnectedPreview() {
    TwTheme {
        TerminalScreen(
            sessionTitle = "tmux-worktree-apk-re",
            connectionStatus = ConnectionStatus.OFFLINE,
            isReadOnly = true,
            ownershipReadOnly = false,
            keyboardVisible = false,
            terminalFontSizeSp = 14,
            disconnectReason = null,
            onBack = {},
            onConnectionStatusClick = {},
            onReconnect = {},
            onToggleKeyboard = {},
            onDecreaseFont = {},
            onIncreaseFont = {},
            onToggleReadOnly = {},
            onRetryInput = {},
        ) {
            Text(
                text = "Last known terminal output",
                color = TwTerminalText,
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(16.dp),
            )
        }
    }
}
