package com.tmuxworktree.mobile.feature.terminal

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
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
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.TextDecrease
import androidx.compose.material.icons.outlined.TextIncrease
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
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
    modifier: Modifier = Modifier,
    terminalContent: @Composable BoxScope.() -> Unit,
) {
    val terminalOnline = connectionStatus == ConnectionStatus.ONLINE
    val boundedFontSizeSp = terminalFontSizeSp.coerceIn(MIN_TERMINAL_FONT_SP, MAX_TERMINAL_FONT_SP)
    Scaffold(
        modifier = modifier
            .fillMaxSize()
            .testTag("terminal_screen"),
        containerColor = TwTerminalBackground,
        topBar = {
            TerminalTopBar(
                sessionTitle = sessionTitle,
                connectionStatus = connectionStatus,
                onBack = onBack,
                onConnectionStatusClick = onConnectionStatusClick,
            )
        },
        bottomBar = {
            TerminalControls(
                terminalOnline = terminalOnline,
                isReadOnly = isReadOnly,
                keyboardVisible = keyboardVisible,
                fontSizeSp = boundedFontSizeSp,
                onToggleKeyboard = onToggleKeyboard,
                onDecreaseFont = onDecreaseFont,
                onIncreaseFont = onIncreaseFont,
                onToggleReadOnly = onToggleReadOnly,
            )
        },
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
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

            if (isReadOnly && terminalOnline) {
                ReadOnlyBanner(
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
    onBack: () -> Unit,
    onConnectionStatusClick: () -> Unit,
) {
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
        }
        HorizontalDivider(color = TwBorder, thickness = 1.dp)
    }
}

@Composable
private fun ReadOnlyBanner(modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .testTag("terminal_read_only_banner")
            .semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = "Terminal is read-only. Terminal input is disabled."
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
                imageVector = Icons.Outlined.Lock,
                contentDescription = null,
                tint = TwWarning,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(10.dp))
            Text(
                text = "Read-only · terminal input is disabled",
                color = TwTextPrimary,
                style = MaterialTheme.typography.bodyMedium,
            )
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
    val detail = reason?.takeIf { it.isNotBlank() } ?: terminalDisconnectedDetail(status)
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
private fun TerminalControls(
    terminalOnline: Boolean,
    isReadOnly: Boolean,
    keyboardVisible: Boolean,
    fontSizeSp: Int,
    onToggleKeyboard: () -> Unit,
    onDecreaseFont: () -> Unit,
    onIncreaseFont: () -> Unit,
    onToggleReadOnly: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(TwSurface)
            .imePadding()
            .navigationBarsPadding()
            .testTag("terminal_controls"),
    ) {
        HorizontalDivider(color = TwBorder, thickness = 1.dp)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp)
                .padding(horizontal = 8.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = onToggleKeyboard,
                enabled = terminalOnline && !isReadOnly,
                modifier = Modifier
                    .size(48.dp)
                    .testTag("terminal_keyboard")
                    .semantics {
                        contentDescription = if (keyboardVisible) "Hide terminal keyboard" else "Show terminal keyboard"
                        stateDescription = if (keyboardVisible) "Keyboard visible" else "Keyboard hidden"
                    },
            ) {
                Icon(
                    imageVector = if (keyboardVisible) Icons.Outlined.KeyboardHide else Icons.Outlined.Keyboard,
                    contentDescription = null,
                    tint = if (terminalOnline && !isReadOnly) TwTextPrimary else TwTextMuted,
                    modifier = Modifier.size(24.dp),
                )
            }

            VerticalDivider(
                modifier = Modifier.height(24.dp),
                color = TwBorder,
                thickness = 1.dp,
            )

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

            VerticalDivider(
                modifier = Modifier.height(24.dp),
                color = TwBorder,
                thickness = 1.dp,
            )

            IconButton(
                onClick = onToggleReadOnly,
                enabled = terminalOnline,
                modifier = Modifier
                    .size(48.dp)
                    .testTag("terminal_read_only")
                    .semantics {
                        contentDescription = if (isReadOnly) {
                            "Enable terminal input"
                        } else {
                            "Switch terminal to read-only"
                        }
                        stateDescription = if (isReadOnly) "Read-only enabled" else "Terminal input enabled"
                    },
            ) {
                Icon(
                    imageVector = if (isReadOnly) Icons.Outlined.Lock else Icons.Outlined.LockOpen,
                    contentDescription = null,
                    tint = when {
                        !terminalOnline -> TwTextMuted
                        isReadOnly -> TwWarning
                        else -> TwSuccess
                    },
                    modifier = Modifier.size(24.dp),
                )
            }
        }
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

@Preview(showBackground = true, backgroundColor = 0xFF020509, widthDp = 390, heightDp = 844)
@Composable
private fun TerminalScreenPreview() {
    TwTheme {
        TerminalScreen(
            sessionTitle = "tmux-worktree-apk-re",
            connectionStatus = ConnectionStatus.ONLINE,
            isReadOnly = false,
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
