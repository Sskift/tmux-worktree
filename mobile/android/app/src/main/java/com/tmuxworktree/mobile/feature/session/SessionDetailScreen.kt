package com.tmuxworktree.mobile.feature.session

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.tmuxworktree.mobile.core.model.AgentEvidenceAvailability
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.DeliveryState
import com.tmuxworktree.mobile.core.model.DemoData
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.model.SessionTimelineState
import com.tmuxworktree.mobile.core.model.TimelineActor
import com.tmuxworktree.mobile.core.model.TimelineEvent
import com.tmuxworktree.mobile.designsystem.*

@Composable
fun SessionDetailScreen(
    session: RelaySession,
    connectionStatus: ConnectionStatus,
    timelineState: SessionTimelineState,
    draft: String,
    nowMillis: Long,
    onDraftChange: (String) -> Unit,
    onBack: () -> Unit,
    onConnectionStatusClick: () -> Unit,
    onOpenTerminal: () -> Unit,
    onOverflowClick: () -> Unit,
    onSend: (String) -> Unit,
    autoFocusReply: Boolean = false,
    agentStateAvailable: Boolean = true,
    onCancelMessage: (TimelineEvent) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    var showAttachmentNotice by rememberSaveable { mutableStateOf(false) }

    Scaffold(
        modifier = modifier
            .fillMaxSize()
            .testTag("session_screen_${session.stableId}"),
        containerColor = TwBackground,
        topBar = {
            SessionTopBar(
                sessionTitle = session.title,
                connectionStatus = connectionStatus,
                onBack = onBack,
                onConnectionStatusClick = onConnectionStatusClick,
                onOverflowClick = onOverflowClick,
            )
        },
        bottomBar = {
            ReplyComposer(
                draft = draft,
                onDraftChange = onDraftChange,
                onSend = { onSend(draft.trim()) },
                onAttachmentClick = { showAttachmentNotice = true },
                autoFocus = autoFocusReply,
            )
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            SessionSummary(
                session = session,
                agentStateAvailable = agentStateAvailable,
                onOpenTerminal = onOpenTerminal,
            )
            when (timelineState.agentEvidenceAvailability) {
                AgentEvidenceAvailability.AVAILABLE -> Unit
                AgentEvidenceAvailability.RELAY_V1_UNSUPPORTED -> RelayV1SessionNotice()
                AgentEvidenceAvailability.RELAY_V2_UNAVAILABLE -> RelayV2AgentEvidenceNotice()
            }
            HorizontalDivider(
                modifier = Modifier.padding(horizontal = 20.dp),
                color = TwBorder,
                thickness = 1.dp,
            )
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .testTag("session_timeline"),
                contentPadding = PaddingValues(
                    start = 20.dp,
                    top = 16.dp,
                    end = 20.dp,
                    bottom = 24.dp,
                ),
            ) {
                item(key = "timeline_heading") {
                    Text(
                        text = "Timeline",
                        color = TwTextSecondary,
                        style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier
                            .padding(bottom = 8.dp)
                            .semantics { heading() },
                    )
                }
                itemsIndexed(
                    items = timelineState.events,
                    key = { _, event -> event.eventId },
                ) { index, event ->
                    TimelineEventRow(
                        event = event,
                        nowMillis = nowMillis,
                        isLast = index == timelineState.events.lastIndex,
                        onCancelMessage = onCancelMessage,
                    )
                }
            }
        }
    }

    if (showAttachmentNotice) {
        AlertDialog(
            onDismissRequest = { showAttachmentNotice = false },
            containerColor = TwSurface,
            title = { Text("Attachments need Relay v2", color = TwTextPrimary) },
            text = {
                Text(
                    "The connected Relay v1 cannot transfer or safely retry attachments yet. Text replies remain available.",
                    color = TwTextSecondary,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = { showAttachmentNotice = false },
                    modifier = Modifier.testTag("dismiss_attachment_notice"),
                ) {
                    Text("Got it", color = TwAccent)
                }
            },
        )
    }
}

@Composable
private fun SessionTopBar(
    sessionTitle: String,
    connectionStatus: ConnectionStatus,
    onBack: () -> Unit,
    onConnectionStatusClick: () -> Unit,
    onOverflowClick: () -> Unit,
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
                .testTag("topbar_back"),
        ) {
            Icon(
                imageVector = Icons.AutoMirrored.Outlined.ArrowBack,
                contentDescription = "Back",
                tint = TwTextSecondary,
                modifier = Modifier.size(24.dp),
            )
        }
        Spacer(Modifier.width(8.dp))
        Text(
            text = sessionTitle,
            color = TwTextPrimary,
            style = MaterialTheme.typography.titleMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .weight(1f)
                .testTag("session_title"),
        )
        Spacer(Modifier.width(8.dp))
        TwConnectionStatusChip(
            status = connectionStatus,
            onClick = onConnectionStatusClick,
        )
        IconButton(
            onClick = onOverflowClick,
            modifier = Modifier
                .size(48.dp)
                .testTag("session_overflow"),
        ) {
            Icon(
                imageVector = Icons.Outlined.MoreVert,
                contentDescription = "More session actions",
                tint = TwTextSecondary,
                modifier = Modifier.size(24.dp),
            )
        }
    }
}

@Composable
private fun SessionSummary(
    session: RelaySession,
    agentStateAvailable: Boolean,
    onOpenTerminal: () -> Unit,
) {
    val visual = session.agentState.visual()
    val statusLabel = if (agentStateAvailable) visual.label else "Agent state unavailable"
    val statusDescription = if (agentStateAvailable) {
        visual.accessibleLabel
    } else {
        "session-wide agent state unavailable"
    }
    val statusColor = if (agentStateAvailable) visual.color else TwTextMuted
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 20.dp, top = 4.dp, end = 20.dp, bottom = 16.dp),
    ) {
        Column(modifier = Modifier.padding(end = 144.dp)) {
            Row(
                modifier = Modifier
                    .testTag("session_semantic_status")
                    .semantics {
                        contentDescription = "Session status: $statusDescription"
                    },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = if (agentStateAvailable) Icons.Outlined.Schedule else Icons.Outlined.Info,
                    contentDescription = null,
                    tint = statusColor,
                    modifier = Modifier.size(22.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = statusLabel,
                    color = statusColor,
                    style = MaterialTheme.typography.labelLarge,
                )
            }
            Spacer(Modifier.height(12.dp))
            Text(
                text = sessionMetadata(session),
                color = TwTextSecondary,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .testTag("session_metadata"),
            )
        }
        OutlinedButton(
            onClick = onOpenTerminal,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .width(132.dp)
                .height(48.dp)
                .testTag("open_terminal"),
            shape = RoundedCornerShape(12.dp),
            border = BorderStroke(1.dp, TwAccent),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = TwAccent),
            contentPadding = PaddingValues(horizontal = 4.dp),
        ) {
            Icon(
                imageVector = Icons.Outlined.Terminal,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(
                text = "Open terminal",
                style = MaterialTheme.typography.labelMedium,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun RelayV1SessionNotice() {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 20.dp, end = 20.dp, bottom = 14.dp)
            .testTag("relay_v1_session_limitation"),
        shape = RoundedCornerShape(12.dp),
        color = TwSurface,
        border = BorderStroke(1.dp, TwBorder),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(
                imageVector = Icons.Outlined.Info,
                contentDescription = null,
                tint = TwTextSecondary,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(10.dp))
            Text(
                text = "Relay v1 does not provide agent transcript or lifecycle state. Timeline shows only messages queued from this phone.",
                color = TwTextSecondary,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun RelayV2AgentEvidenceNotice() {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 20.dp, end = 20.dp, bottom = 14.dp)
            .testTag("relay_v2_agent_evidence_unavailable"),
        shape = RoundedCornerShape(12.dp),
        color = TwSurface,
        border = BorderStroke(1.dp, TwBorder),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(
                imageVector = Icons.Outlined.Info,
                contentDescription = null,
                tint = TwTextSecondary,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(10.dp))
            Text(
                text = "Agent transcript and lifecycle evidence are unavailable for this Relay v2 session. You can still compose a reply; sending uses the separate command path and requires the session to be currently online.",
                color = TwTextSecondary,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun TimelineEventRow(
    event: TimelineEvent,
    nowMillis: Long,
    isLast: Boolean,
    onCancelMessage: (TimelineEvent) -> Unit,
) {
    val actorVisual = timelineActorVisual(event.actor)
    val deliveryActionLabel = deliveryActionLabel(event.deliveryState)
    val isWorking = event.actor == TimelineActor.AGENT &&
        event.body.trim().removeSuffix(".").equals("Working…", ignoreCase = true)
    val eventDescription = buildString {
        append(actorVisual.label)
        append(", ")
        append(relativeTimeDescription(event.createdAtMillis, nowMillis))
        append(". ")
        append(event.body)
        if (event.code.isNotBlank()) {
            append(". ")
            append(event.code)
        }
        event.deliveryState?.let {
            append(". ")
            append(deliveryVisual(it).label)
        }
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .testTag("timeline_event_${event.eventId}"),
    ) {
        Box(
            modifier = Modifier
                .width(40.dp)
                .fillMaxHeight(),
            contentAlignment = Alignment.TopCenter,
        ) {
            if (!isLast) {
                Box(
                    modifier = Modifier
                        .padding(top = 27.dp)
                        .width(2.dp)
                        .fillMaxHeight()
                        .background(TwBorder),
                )
            }
            Surface(
                modifier = Modifier.size(28.dp),
                shape = CircleShape,
                color = actorVisual.avatarColor,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        imageVector = actorVisual.icon,
                        contentDescription = null,
                        tint = TwTextPrimary,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        }
        Spacer(Modifier.width(4.dp))
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(
                    top = 4.dp,
                    bottom = if (event.code.isNotBlank()) 20.dp else 32.dp,
                )
                .semantics(mergeDescendants = deliveryActionLabel == null) {
                    contentDescription = eventDescription
                },
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = actorVisual.label,
                    color = TwTextSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    text = " · ",
                    color = TwTextSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    text = if (isWorking) event.body else relativeTime(event.createdAtMillis, nowMillis),
                    color = if (isWorking) TwAccent else TwTextSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (isWorking) FontWeight.SemiBold else FontWeight.Normal,
                )
            }
            if (!isWorking && event.body.isNotBlank()) {
                Spacer(Modifier.height(6.dp))
                Text(
                    text = event.body,
                    color = TwTextPrimary,
                    style = MaterialTheme.typography.labelSmall.copy(
                        fontWeight = FontWeight.Normal,
                    ),
                )
            }
            if (event.code.isNotBlank()) {
                Spacer(Modifier.height(12.dp))
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                    color = Color.Transparent,
                    border = BorderStroke(1.dp, TwBorder),
                ) {
                    Text(
                        text = event.code,
                        color = TwSuccess,
                        style = MaterialTheme.typography.bodyMedium,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 13.dp),
                    )
                }
            }
            event.deliveryState?.let { deliveryState ->
                val delivery = deliveryVisual(deliveryState)
                Spacer(Modifier.height(12.dp))
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("delivery_status_${event.eventId}")
                        .semantics {
                            liveRegion = LiveRegionMode.Polite
                            stateDescription = delivery.accessibleLabel
                        },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Outlined.Shield,
                        contentDescription = null,
                        tint = delivery.color,
                        modifier = Modifier.size(20.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = delivery.label,
                        color = delivery.color,
                        style = MaterialTheme.typography.labelMedium,
                    )
                    if (deliveryActionLabel != null) {
                        Spacer(Modifier.weight(1f))
                        TextButton(
                            onClick = { onCancelMessage(event) },
                            modifier = Modifier
                                .heightIn(min = 48.dp)
                                .testTag("message_delivery_action_${event.eventId}")
                                .semantics {
                                    contentDescription = "$deliveryActionLabel this message"
                                },
                            contentPadding = PaddingValues(horizontal = 10.dp),
                        ) {
                            Text(
                                text = deliveryActionLabel,
                                color = TwAccent,
                                style = MaterialTheme.typography.labelMedium,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ReplyComposer(
    draft: String,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    onAttachmentClick: () -> Unit,
    autoFocus: Boolean,
) {
    val sendEnabled = draft.isNotBlank()
    val focusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current
    LaunchedEffect(autoFocus) {
        if (autoFocus) {
            focusRequester.requestFocus()
            keyboardController?.show()
        }
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(TwBackground)
            .imePadding()
            .navigationBarsPadding()
            .padding(start = 20.dp, top = 8.dp, end = 20.dp, bottom = 18.dp),
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 124.dp)
                .testTag("reply_composer"),
            shape = RoundedCornerShape(12.dp),
            color = Color.Transparent,
            border = BorderStroke(1.dp, TwBorder),
        ) {
            Box(modifier = Modifier.padding(16.dp)) {
                BasicTextField(
                    value = draft,
                    onValueChange = onDraftChange,
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focusRequester)
                        .heightIn(min = 48.dp, max = 104.dp)
                        .padding(end = 4.dp, bottom = 48.dp)
                        .testTag("reply_input")
                        .semantics {
                            contentDescription = "Reply to agent"
                        },
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = TwTextPrimary),
                    cursorBrush = SolidColor(TwAccent),
                    decorationBox = { innerTextField ->
                        Box {
                            if (draft.isEmpty()) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(
                                        imageVector = Icons.Outlined.ChatBubbleOutline,
                                        contentDescription = null,
                                        tint = TwTextSecondary,
                                        modifier = Modifier.size(22.dp),
                                    )
                                    Spacer(Modifier.width(12.dp))
                                    Text(
                                        text = "Reply to agent",
                                        color = TwTextSecondary,
                                        style = MaterialTheme.typography.bodyLarge,
                                    )
                                }
                            }
                            innerTextField()
                        }
                    },
                )
                IconButton(
                    onClick = onAttachmentClick,
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .size(48.dp)
                        .testTag("session_attachment"),
                ) {
                    Icon(
                        imageVector = Icons.Outlined.AttachFile,
                        contentDescription = "Add attachment",
                        tint = TwTextSecondary,
                        modifier = Modifier.size(22.dp),
                    )
                }
                Button(
                    onClick = onSend,
                    enabled = sendEnabled,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .width(88.dp)
                        .height(48.dp)
                        .testTag("send_reply")
                        .semantics {
                            contentDescription = "Send reply"
                            stateDescription = if (sendEnabled) "Ready to send" else "No content to send"
                        },
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = TwAccent,
                        contentColor = TwOnAccent,
                        disabledContainerColor = TwSurfaceRaised,
                        disabledContentColor = TwTextMuted,
                    ),
                    contentPadding = PaddingValues(horizontal = 8.dp),
                ) {
                    Text(
                        text = "Send",
                        style = MaterialTheme.typography.labelLarge,
                        maxLines = 1,
                    )
                }
            }
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 44.dp)
                .padding(top = 12.dp)
                .testTag("safe_queue_note")
                .semantics(mergeDescendants = true) {
                    contentDescription = "Replies queue safely if the network changes"
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Outlined.Shield,
                contentDescription = null,
                tint = TwSuccess,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(10.dp))
            Text(
                text = "Replies queue safely if the network changes",
                color = TwTextSecondary,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

private data class TimelineActorVisual(
    val label: String,
    val icon: ImageVector,
    val avatarColor: androidx.compose.ui.graphics.Color,
)

@Composable
private fun timelineActorVisual(actor: TimelineActor): TimelineActorVisual = when (actor) {
    TimelineActor.AGENT -> TimelineActorVisual("Agent", Icons.Outlined.SmartToy, TwAccent)
    TimelineActor.USER -> TimelineActorVisual("You", Icons.Outlined.Person, TwAccentPressed)
    TimelineActor.SYSTEM -> TimelineActorVisual("System", Icons.Outlined.Info, TwTextMuted)
}

@Composable
private fun deliveryVisual(state: DeliveryState): StatusVisual = when (state) {
    DeliveryState.QUEUED -> StatusVisual("Queued safely", TwSuccess, "message queued safely")
    DeliveryState.SENDING -> StatusVisual("Sending…", TwAccent, "message sending")
    DeliveryState.ACCEPTED -> StatusVisual("Accepted", TwSuccess, "message accepted")
    DeliveryState.SUCCEEDED -> StatusVisual("Sent", TwSuccess, "message delivered")
    DeliveryState.CONFIRMING -> StatusVisual("Confirming…", TwWarning, "confirming final delivery")
    DeliveryState.AMBIGUOUS -> StatusVisual(
        "Delivery unknown",
        TwWarning,
        "delivery could not be confirmed and will not be sent again automatically",
    )
    DeliveryState.FAILED_RETRYABLE -> StatusVisual("Will retry", TwError, "send failed and will retry")
    DeliveryState.FAILED_FINAL -> StatusVisual("Send failed", TwError, "send failed")
    DeliveryState.EXPIRED -> StatusVisual("Expired", TwError, "message expired")
    DeliveryState.CANCELLED -> StatusVisual("Cancelled", TwTextMuted, "message cancelled")
}

private fun deliveryActionLabel(state: DeliveryState?): String? = when (state) {
    DeliveryState.QUEUED,
    DeliveryState.FAILED_RETRYABLE -> "Cancel"
    DeliveryState.ACCEPTED,
    DeliveryState.CONFIRMING,
    DeliveryState.AMBIGUOUS -> "Stop tracking"
    else -> null
}

private fun sessionMetadata(session: RelaySession): String = buildString {
    append(session.scopeLabel.ifBlank { session.scopeId })
    if (session.branch.isNotBlank()) {
        append(" · ")
        append(session.branch)
    }
}

@Preview(showBackground = true, backgroundColor = 0xFF070A0E, widthDp = 390, heightDp = 844)
@Composable
private fun SessionDetailScreenPreview() {
    val session = DemoData.sessions().first()
    TwTheme {
        SessionDetailScreen(
            session = session,
            connectionStatus = ConnectionStatus.ONLINE,
            timelineState = SessionTimelineState(
                events = DemoData.timeline(session.stableId),
                agentEvidenceAvailability = AgentEvidenceAvailability.AVAILABLE,
            ),
            draft = "",
            nowMillis = System.currentTimeMillis(),
            onDraftChange = {},
            onBack = {},
            onConnectionStatusClick = {},
            onOpenTerminal = {},
            onOverflowClick = {},
            onSend = {},
        )
    }
}
