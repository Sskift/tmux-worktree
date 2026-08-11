package com.tmuxworktree.mobile.feature.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatContentPart
import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatTurnView
import com.tmuxworktree.mobile.core.relay.runtime.PendingChatSend
import com.tmuxworktree.mobile.core.relay.runtime.RelayChatState
import com.tmuxworktree.mobile.designsystem.TwAccent
import com.tmuxworktree.mobile.designsystem.TwAccentPressed
import com.tmuxworktree.mobile.designsystem.TwBackground
import com.tmuxworktree.mobile.designsystem.TwBorder
import com.tmuxworktree.mobile.designsystem.TwError
import com.tmuxworktree.mobile.designsystem.TwOnAccent
import com.tmuxworktree.mobile.designsystem.TwSurface
import com.tmuxworktree.mobile.designsystem.TwSurfaceRaised
import com.tmuxworktree.mobile.designsystem.TwTextMuted
import com.tmuxworktree.mobile.designsystem.TwTextPrimary
import com.tmuxworktree.mobile.designsystem.TwTextSecondary

@Composable
fun AgentChatScreen(
    session: RelaySession,
    connectionStatus: ConnectionStatus,
    chatState: RelayChatState,
    draft: String,
    onDraftChange: (String) -> Unit,
    onBack: () -> Unit,
    onOpenDetails: () -> Unit,
    onOpenTerminal: () -> Unit,
    onSend: (String) -> Unit,
    onRetryFailed: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val turns = chatState.turns(session.protocolSessionId)
    val pending = chatState.pending(session.protocolSessionId)
    val hasWorkingTurn = turns.any { it.status == "working" }
    val listState = rememberLazyListState()
    val isUserDragging by listState.interactionSource.collectIsDraggedAsState()
    var followTail by remember(session.protocolSessionId) { mutableStateOf(true) }
    var userScrollInProgress by remember(session.protocolSessionId) { mutableStateOf(false) }
    val tailIndex = turns.size + pending.size + if (hasWorkingTurn) 1 else 0

    LaunchedEffect(isUserDragging, listState.isScrollInProgress) {
        when {
            isUserDragging -> {
                userScrollInProgress = true
                followTail = false
            }
            userScrollInProgress && !listState.isScrollInProgress -> {
                followTail = !listState.canScrollForward
                userScrollInProgress = false
            }
        }
    }
    LaunchedEffect(
        session.protocolSessionId,
        turns,
        pending,
        followTail,
    ) {
        if (followTail) listState.scrollToItem(tailIndex)
    }

    Scaffold(
        modifier = modifier
            .fillMaxSize()
            .testTag("agent_chat_screen_${session.stableId}"),
        containerColor = TwBackground,
        topBar = {
            ChatTopBar(
                sessionTitle = session.title,
                connectionStatus = connectionStatus,
                onBack = onBack,
                onOpenDetails = onOpenDetails,
                onOpenTerminal = onOpenTerminal,
            )
        },
        bottomBar = {
            ChatComposer(
                draft = draft,
                onDraftChange = onDraftChange,
                onSend = { onSend(draft.trim()) },
                hasWorkingTurn = hasWorkingTurn,
            )
        },
    ) { innerPadding ->
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
            contentPadding = PaddingValues(
                start = 16.dp,
                top = 16.dp,
                end = 16.dp,
                bottom = 16.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(
                items = turns,
                key = { it.turnId },
            ) { turn ->
                TurnBubble(turn = turn, chatState = chatState)
            }
            items(
                items = pending,
                key = { it.requestId },
            ) { pendingSend ->
                PendingBubble(
                    pending = pendingSend,
                    onRetry = onRetryFailed,
                )
            }
            if (hasWorkingTurn) {
                item(key = "typing_indicator") {
                    TypingIndicator()
                }
            }
            item(key = "chat_tail") {
                Spacer(Modifier.height(1.dp))
            }
        }
    }
}

@Composable
private fun ChatTopBar(
    sessionTitle: String,
    connectionStatus: ConnectionStatus,
    onBack: () -> Unit,
    onOpenDetails: () -> Unit,
    onOpenTerminal: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(TwBackground)
            .statusBarsPadding()
            .height(64.dp)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(
            onClick = onBack,
            modifier = Modifier
                .size(48.dp)
                .testTag("chat_back"),
        ) {
            Icon(
                imageVector = Icons.AutoMirrored.Outlined.ArrowBack,
                contentDescription = "Back",
                tint = TwTextSecondary,
                modifier = Modifier.size(24.dp),
            )
        }
        Spacer(Modifier.width(8.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = sessionTitle,
                color = TwTextPrimary,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.testTag("chat_session_title"),
            )
            Text(
                text = connectionStatus.label,
                color = TwTextSecondary,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        IconButton(
            onClick = onOpenDetails,
            modifier = Modifier
                .size(48.dp)
                .testTag("chat_details"),
        ) {
            Icon(
                imageVector = Icons.Outlined.Info,
                contentDescription = "Session details",
                tint = TwTextSecondary,
                modifier = Modifier.size(24.dp),
            )
        }
        IconButton(
            onClick = onOpenTerminal,
            modifier = Modifier
                .size(48.dp)
                .testTag("chat_terminal"),
        ) {
            Icon(
                imageVector = Icons.Outlined.Terminal,
                contentDescription = "Open terminal",
                tint = TwAccent,
                modifier = Modifier.size(24.dp),
            )
        }
    }
    HorizontalDivider(color = TwBorder, thickness = 1.dp)
}

@Composable
private fun TurnBubble(turn: AgentChatTurnView, chatState: RelayChatState) {
    val isFailed = turn.status == "failed" || turn.status == "recovery-required"
    Column(
        modifier = Modifier.fillMaxWidth(),
    ) {
        // User message bubble (right side)
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
        ) {
            UserBubble(text = turn.userMessage)
        }
        // Steering label
        if (turn.steeredMessages.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 4.dp),
                horizontalArrangement = Arrangement.End,
            ) {
                Text(
                    text = "已并入当前任务",
                    color = TwTextMuted,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.testTag("steered_label_${turn.turnId}"),
                )
            }
        }
        // Agent reply or status (left side)
        if (turn.status == "working") {
            // typing indicator is shown at the list level; nothing else here
        } else if (isFailed) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp),
                horizontalArrangement = Arrangement.Start,
            ) {
                ErrorBubble(
                    error = turn.error ?: "Agent task failed",
                    status = turn.status,
                )
            }
        } else if (turn.content.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp),
                horizontalArrangement = Arrangement.Start,
            ) {
                AgentBubble(content = turn.content, chatState = chatState)
            }
        }
    }
}

@Composable
private fun UserBubble(text: String) {
    Surface(
        shape = RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp),
        color = TwAccent,
        modifier = Modifier.testTag("user_bubble"),
    ) {
        Text(
            text = text,
            color = TwOnAccent,
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
        )
    }
}

@Composable
private fun AgentBubble(content: List<AgentChatContentPart>, chatState: RelayChatState) {
    Surface(
        shape = RoundedCornerShape(18.dp, 18.dp, 18.dp, 4.dp),
        color = TwSurfaceRaised,
        modifier = Modifier.testTag("agent_bubble"),
    ) {
        AgentRichContent(
            content = content,
            chatState = chatState,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
        )
    }
}

@Composable
private fun ErrorBubble(error: String, status: String) {
    Surface(
        shape = RoundedCornerShape(18.dp, 18.dp, 18.dp, 4.dp),
        color = TwSurface,
        border = androidx.compose.foundation.BorderStroke(1.dp, TwError),
        modifier = Modifier.testTag("error_bubble"),
    ) {
        Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
            Text(
                text = if (status == "recovery-required") "Recovery required" else "Failed",
                color = TwError,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = error,
                color = TwTextSecondary,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun PendingBubble(
    pending: PendingChatSend,
    onRetry: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End,
    ) {
        if (pending.failed) {
            Column(horizontalAlignment = Alignment.End) {
                Surface(
                    shape = RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp),
                    color = TwSurface,
                    border = androidx.compose.foundation.BorderStroke(1.dp, TwError),
                    modifier = Modifier.testTag("pending_failed_bubble"),
                ) {
                    Text(
                        text = pending.message,
                        color = TwTextSecondary,
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    )
                }
                TextButton(
                    onClick = onRetry,
                    modifier = Modifier.testTag("retry_failed_${pending.requestId}"),
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
                ) {
                    Icon(
                        imageVector = Icons.Outlined.Refresh,
                        contentDescription = null,
                        tint = TwError,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(
                        text = "Retry",
                        color = TwError,
                        style = MaterialTheme.typography.labelMedium,
                    )
                }
            }
        } else {
            Surface(
                shape = RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp),
                color = TwAccentPressed,
                modifier = Modifier.testTag("pending_sending_bubble"),
            ) {
                Text(
                    text = pending.message,
                    color = TwOnAccent,
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                )
            }
        }
    }
}

@Composable
private fun TypingIndicator() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 4.dp, top = 4.dp),
        horizontalArrangement = Arrangement.Start,
    ) {
        Surface(
            shape = RoundedCornerShape(18.dp, 18.dp, 18.dp, 4.dp),
            color = TwSurfaceRaised,
            modifier = Modifier.testTag("typing_indicator"),
        ) {
            Text(
                text = "Agent is working…",
                color = TwTextSecondary,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            )
        }
    }
}

@Composable
private fun ChatComposer(
    draft: String,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    hasWorkingTurn: Boolean,
) {
    val sendEnabled = draft.isNotBlank()
    val focusRequester = remember { FocusRequester() }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(TwBackground)
            .imePadding()
            .navigationBarsPadding()
            .padding(start = 16.dp, top = 8.dp, end = 16.dp, bottom = 16.dp),
    ) {
        if (hasWorkingTurn) {
            Text(
                text = "Another message now will be folded into the current task.",
                color = TwTextMuted,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 6.dp)
                    .testTag("steering_hint"),
            )
        }
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp),
            shape = RoundedCornerShape(16.dp),
            color = Color.Transparent,
            border = androidx.compose.foundation.BorderStroke(1.dp, TwBorder),
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BasicTextField(
                    value = draft,
                    onValueChange = onDraftChange,
                    modifier = Modifier
                        .weight(1f)
                        .focusRequester(focusRequester)
                        .testTag("chat_input")
                        .semantics { contentDescription = "Message to agent" },
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = TwTextPrimary),
                    cursorBrush = SolidColor(TwAccent),
                    decorationBox = { innerTextField ->
                        Box {
                            if (draft.isEmpty()) {
                                Text(
                                    text = "Message agent…",
                                    color = TwTextSecondary,
                                    style = MaterialTheme.typography.bodyLarge,
                                )
                            }
                            innerTextField()
                        }
                    },
                )
                Spacer(Modifier.width(8.dp))
                Button(
                    onClick = onSend,
                    enabled = sendEnabled,
                    modifier = Modifier
                        .size(44.dp)
                        .testTag("chat_send"),
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = TwAccent,
                        contentColor = TwOnAccent,
                        disabledContainerColor = TwSurfaceRaised,
                        disabledContentColor = TwTextMuted,
                    ),
                    contentPadding = PaddingValues(0.dp),
                ) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Outlined.Send,
                        contentDescription = "Send message",
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
        }
    }
}

private val ConnectionStatus.label: String
    get() = when (this) {
        ConnectionStatus.ONLINE -> "Online"
        ConnectionStatus.CONNECTING -> "Connecting…"
        ConnectionStatus.RECOVERING -> "Reconnecting…"
        ConnectionStatus.PAUSED -> "Paused"
        ConnectionStatus.OFFLINE -> "Offline"
        ConnectionStatus.AUTH_REQUIRED -> "Authentication required"
        ConnectionStatus.INCOMPATIBLE -> "Incompatible"
        ConnectionStatus.UNKNOWN -> "Unknown"
    }
