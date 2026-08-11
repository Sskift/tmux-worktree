package com.tmuxworktree.mobile.feature.inbox

import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tmuxworktree.mobile.core.model.AgentEvidenceAvailability
import com.tmuxworktree.mobile.core.model.AgentState
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.DemoData
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.designsystem.*

@Composable
fun InboxScreen(
    sessions: List<RelaySession>,
    connectionStatus: ConnectionStatus,
    nowMillis: Long,
    onMenuClick: () -> Unit,
    onConnectionStatusClick: () -> Unit,
    onSessionClick: (RelaySession) -> Unit,
    modifier: Modifier = Modifier,
    agentEvidenceAvailability: AgentEvidenceAvailability = AgentEvidenceAvailability.AVAILABLE,
) {
    // Inbox is the agent workflow. Plain terminal sessions remain available
    // under Workspaces > Terminals and must not be presented as agents.
    val agentSessions = sessions.filterNot { it.kind.equals("terminal", ignoreCase = true) }
    val attentionSessions = agentSessions.filter {
        it.agentState == AgentState.WAITING_FOR_USER || it.agentState == AgentState.FAILED
    }
    // Keep sessions visible when the current protocol/capability cut cannot
    // provide lifecycle evidence instead of silently dropping them from the inbox.
    val runningSessions = agentSessions.filter {
        it.agentState == AgentState.RUNNING ||
            it.agentState == AgentState.UNKNOWN ||
            it.agentState == AgentState.COMPLETED
    }
    val unavailableAgentStatus = inboxUnavailableAgentStatus(agentEvidenceAvailability)
    val agentStateAvailable = unavailableAgentStatus == null

    Scaffold(
        modifier = modifier
            .fillMaxSize()
            .testTag("inbox_screen"),
        containerColor = TwBackground,
        topBar = {
            TwRootTopBar(
                title = "tw-dashboard",
                connectionStatus = connectionStatus,
                onMenuClick = onMenuClick,
                onConnectionStatusClick = onConnectionStatusClick,
            )
        },
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
            contentPadding = PaddingValues(
                start = 20.dp,
                top = 20.dp,
                end = 20.dp,
                bottom = 32.dp,
            ),
        ) {
            item(key = "attention_header") {
                Text(
                    text = if (agentStateAvailable) "Needs attention" else "Agent status",
                    color = TwTextPrimary,
                    style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier
                        .testTag("inbox_attention_heading")
                        .semantics { heading() },
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    text = unavailableAgentStatus?.subtitle
                        ?: attentionSubtitle(attentionSessions.size),
                    color = TwTextSecondary,
                    style = MaterialTheme.typography.bodyLarge,
                )
            }

            if (attentionSessions.isEmpty()) {
                item(key = "attention_empty") {
                    Text(
                        text = if (agentStateAvailable) {
                            "You're all caught up."
                        } else {
                            "All sessions remain available below."
                        },
                        color = TwTextSecondary,
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 56.dp)
                            .padding(top = 12.dp)
                            .testTag("inbox_attention_empty")
                            .semantics {
                                contentDescription = unavailableAgentStatus?.emptyContentDescription
                                    ?: "No sessions need your attention"
                            },
                    )
                }
            } else {
                items(
                    items = attentionSessions,
                    key = { "attention_${it.stableId}" },
                ) { session ->
                    AttentionSessionRow(
                        session = session,
                        nowMillis = nowMillis,
                        onOpen = { onSessionClick(session) },
                    )
                }
            }

            item(key = "attention_divider") {
                HorizontalDivider(color = TwBorder, thickness = 1.dp)
                Spacer(Modifier.height(16.dp))
            }

            item(key = "running_header") {
                Text(
                    text = if (agentStateAvailable) "Running" else "Sessions",
                    color = TwTextPrimary,
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier
                        .testTag("inbox_running_heading")
                        .semantics { heading() },
                )
            }

            if (runningSessions.isEmpty()) {
                item(key = "running_empty") {
                    Text(
                        text = "No agents are running.",
                        color = TwTextSecondary,
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 76.dp)
                            .padding(vertical = 20.dp)
                            .testTag("inbox_running_empty"),
                    )
                }
            } else {
                items(
                    items = runningSessions,
                    key = { "running_${it.stableId}" },
                ) { session ->
                    RunningSessionRow(
                        session = session,
                        onClick = { onSessionClick(session) },
                    )
                    if (session != runningSessions.last()) {
                        HorizontalDivider(color = TwBorder, thickness = 1.dp)
                    }
                }
            }
        }
    }
}

internal data class InboxUnavailableAgentStatus(
    val subtitle: String,
    val emptyContentDescription: String,
)

internal fun inboxUnavailableAgentStatus(
    availability: AgentEvidenceAvailability,
): InboxUnavailableAgentStatus? = when (availability) {
    AgentEvidenceAvailability.AVAILABLE -> null
    AgentEvidenceAvailability.RELAY_V2_UNAVAILABLE -> InboxUnavailableAgentStatus(
        subtitle = "Relay v2 Agent capability is unavailable or was not negotiated",
        emptyContentDescription =
            "Agent reply state is unavailable because the Relay version 2 Agent capability " +
                "is unavailable or was not negotiated",
    )
}

@Composable
private fun AttentionSessionRow(
    session: RelaySession,
    nowMillis: Long,
    onOpen: () -> Unit,
) {
    val visual = session.agentState.visual()
    val age = relativeTimeFromSeconds(session.activityAtSeconds, nowMillis).ifBlank { "now" }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 88.dp)
            .clickable(role = Role.Button, onClick = onOpen)
            .testTag("attention_session_${session.stableId}")
            .semantics(mergeDescendants = true) {
                role = Role.Button
                contentDescription = "${session.title}, ${visual.accessibleLabel}, " +
                    "${relativeTimeDescriptionFromSeconds(session.activityAtSeconds, nowMillis)}. ${session.summary}"
            }
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier.size(28.dp),
            contentAlignment = Alignment.TopStart,
        ) {
            Icon(
                imageVector = Icons.Outlined.ErrorOutline,
                contentDescription = null,
                tint = visual.color,
                modifier = Modifier.size(24.dp),
            )
        }
        Spacer(Modifier.width(10.dp))
        Column(
            modifier = Modifier.weight(1f),
        ) {
            Text(
                text = session.title,
                color = TwTextPrimary,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = visual.label,
                color = visual.color,
                style = MaterialTheme.typography.labelLarge,
            )
            if (session.summary.isNotBlank()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    text = session.summary,
                    color = TwTextPrimary,
                    style = MaterialTheme.typography.labelSmall.copy(
                        fontWeight = FontWeight.Normal,
                        fontSize = 11.sp,
                    ),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Spacer(Modifier.width(12.dp))
        Column(
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = age,
                color = TwTextSecondary,
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.height(4.dp))
            Icon(
                imageVector = Icons.Outlined.ChevronRight,
                contentDescription = null,
                tint = TwTextSecondary,
                modifier = Modifier.size(24.dp),
            )
        }
    }
}

@Composable
private fun RunningSessionRow(
    session: RelaySession,
    onClick: () -> Unit,
) {
    val visual = session.agentState.visual()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .testTag("running_session_${session.stableId}")
            .semantics(mergeDescendants = true) {
                role = Role.Button
                contentDescription = "${session.title}, ${visual.accessibleLabel}. ${session.summary}"
            }
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Filled.Circle,
            contentDescription = null,
            tint = visual.color,
            modifier = Modifier.size(10.dp),
        )
        Spacer(Modifier.width(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = session.title,
                color = TwTextPrimary,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (session.summary.isNotBlank()) {
                Spacer(Modifier.height(3.dp))
                Text(
                    text = session.summary,
                    color = TwTextSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Spacer(Modifier.width(12.dp))
        Icon(
            imageVector = Icons.Outlined.ChevronRight,
            contentDescription = null,
            tint = TwTextSecondary,
            modifier = Modifier.size(24.dp),
        )
    }
}

private fun attentionSubtitle(count: Int): String = when (count) {
    0 -> "No agents are waiting for you"
    1 -> "1 agent is waiting for you"
    else -> "$count agents are waiting for you"
}

@Preview(showBackground = true, backgroundColor = 0xFF070A0E, widthDp = 390, heightDp = 844)
@Composable
private fun InboxScreenPreview() {
    TwTheme {
        InboxScreen(
            sessions = DemoData.sessions(),
            connectionStatus = ConnectionStatus.ONLINE,
            nowMillis = System.currentTimeMillis(),
            onMenuClick = {},
            onConnectionStatusClick = {},
            onSessionClick = {},
        )
    }
}
