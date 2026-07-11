@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.tmuxworktree.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.DesktopWindows
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.DesktopWindows
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tmuxworktree.mobile.core.model.AgentState
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import kotlin.math.max

enum class RootDestination(val label: String, val testTag: String) {
    INBOX("Inbox", "nav_inbox"),
    WORKSPACES("Workspaces", "nav_workspaces"),
    SETTINGS("Settings", "nav_settings"),
}

internal data class StatusVisual(
    val label: String,
    val color: Color,
    val accessibleLabel: String,
)

internal fun ConnectionStatus.visual(): StatusVisual = when (this) {
    ConnectionStatus.ONLINE -> StatusVisual("Online", TwSuccess, "online")
    ConnectionStatus.RECOVERING -> StatusVisual("Recovering", TwWarning, "recovering")
    ConnectionStatus.PAUSED -> StatusVisual("Paused", TwTextMuted, "paused")
    ConnectionStatus.OFFLINE -> StatusVisual("Offline", TwError, "offline")
    ConnectionStatus.CONNECTING -> StatusVisual("Connecting", TwWarning, "connecting")
    ConnectionStatus.AUTH_REQUIRED -> StatusVisual("Sign in", TwError, "authentication required")
    ConnectionStatus.INCOMPATIBLE -> StatusVisual("Update required", TwError, "update required")
    ConnectionStatus.UNKNOWN -> StatusVisual("Unknown", TwTextMuted, "unknown")
}

internal fun AgentState.visual(): StatusVisual = when (this) {
    AgentState.WAITING_FOR_USER -> StatusVisual("Waiting for reply", TwWarning, "waiting for reply")
    AgentState.RUNNING -> StatusVisual("Running", TwSuccess, "running")
    AgentState.FAILED -> StatusVisual("Failed", TwError, "failed")
    AgentState.COMPLETED -> StatusVisual("Completed", TwSuccess, "completed")
    AgentState.UNKNOWN -> StatusVisual("Unknown", TwTextMuted, "unknown")
}

@Composable
fun TwRootTopBar(
    title: String,
    connectionStatus: ConnectionStatus,
    onConnectionStatusClick: () -> Unit,
    modifier: Modifier = Modifier,
    onMenuClick: (() -> Unit)? = null,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(TwBackground)
            .statusBarsPadding()
            .height(64.dp)
            .padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onMenuClick != null) {
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clickable(role = Role.Button, onClick = onMenuClick)
                    .testTag("topbar_menu"),
                contentAlignment = Alignment.CenterStart,
            ) {
                Icon(
                    imageVector = Icons.Outlined.Menu,
                    contentDescription = "Open device menu",
                    tint = TwTextPrimary,
                    modifier = Modifier.size(24.dp),
                )
            }
        }

        Text(
            text = title,
            color = TwTextPrimary,
            style = MaterialTheme.typography.titleLarge,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(12.dp))
        TwConnectionStatusChip(
            status = connectionStatus,
            onClick = onConnectionStatusClick,
        )
    }
}

@Composable
fun TwConnectionStatusChip(
    status: ConnectionStatus,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val visual = status.visual()
    Box(
        modifier = modifier
            .height(48.dp)
            .testTag("connection_status_chip")
            .clickable(role = Role.Button, onClick = onClick)
            .semantics {
                role = Role.Button
                contentDescription = "Connection status: ${visual.accessibleLabel}. Open connection details"
                stateDescription = visual.accessibleLabel
                liveRegion = LiveRegionMode.Polite
            },
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            modifier = Modifier.height(28.dp),
            shape = RoundedCornerShape(14.dp),
            color = Color.Transparent,
            border = BorderStroke(1.dp, TwBorder),
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Filled.Circle,
                    contentDescription = null,
                    tint = visual.color,
                    modifier = Modifier.size(9.dp),
                )
                Text(
                    text = visual.label,
                    color = visual.color,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
    }
}

@Composable
fun TwRootBottomBar(
    selectedDestination: RootDestination,
    attentionCount: Int,
    onDestinationSelected: (RootDestination) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(TwSurface)
            .testTag("bottom_nav"),
    ) {
        HorizontalDivider(color = TwBorder, thickness = 1.dp)
        NavigationBar(
            containerColor = TwSurface,
            tonalElevation = 0.dp,
            windowInsets = WindowInsets(0, 0, 0, 0),
            modifier = Modifier
                .fillMaxWidth()
                .height(72.dp),
        ) {
            RootDestination.entries.forEach { destination ->
                val selected = destination == selectedDestination
                NavigationBarItem(
                    selected = selected,
                    onClick = { onDestinationSelected(destination) },
                    modifier = Modifier
                        .testTag(destination.testTag)
                        .semantics {
                            if (destination == RootDestination.INBOX && attentionCount > 0) {
                                contentDescription = "Inbox, $attentionCount item${if (attentionCount == 1) "" else "s"} need attention"
                            }
                        },
                    icon = {
                        if (destination == RootDestination.INBOX && attentionCount > 0) {
                            BadgedBox(
                                badge = {
                                    Badge(
                                        containerColor = TwAccent,
                                        contentColor = TwOnAccent,
                                    ) {
                                        Text(max(1, attentionCount).coerceAtMost(99).toString())
                                    }
                                },
                            ) {
                                Icon(
                                    imageVector = destination.icon(selected),
                                    contentDescription = null,
                                    modifier = Modifier.size(26.dp),
                                )
                            }
                        } else {
                            Icon(
                                imageVector = destination.icon(selected),
                                contentDescription = null,
                                modifier = Modifier.size(26.dp),
                            )
                        }
                    },
                    label = {
                        Text(
                            text = destination.label,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                        )
                    },
                    colors = NavigationBarItemDefaults.colors(
                        selectedIconColor = TwAccent,
                        selectedTextColor = TwAccent,
                        indicatorColor = Color.Transparent,
                        unselectedIconColor = TwTextSecondary,
                        unselectedTextColor = TwTextSecondary,
                    ),
                )
            }
        }
        Spacer(
            modifier = Modifier
                .fillMaxWidth()
                .windowInsetsBottomHeight(WindowInsets.navigationBars)
                .background(TwBackground),
        )
    }
}

private fun RootDestination.icon(selected: Boolean): ImageVector = when (this) {
    RootDestination.INBOX -> if (selected) Icons.Filled.Inbox else Icons.Outlined.Inbox
    RootDestination.WORKSPACES -> if (selected) Icons.Filled.DesktopWindows else Icons.Outlined.DesktopWindows
    RootDestination.SETTINGS -> if (selected) Icons.Filled.Settings else Icons.Outlined.Settings
}

internal fun relativeTimeFromSeconds(timestampSeconds: Long, nowMillis: Long): String {
    if (timestampSeconds <= 0L) return ""
    return relativeTime(timestampSeconds * 1_000L, nowMillis)
}

internal fun relativeTime(timestampMillis: Long, nowMillis: Long): String {
    val seconds = ((nowMillis - timestampMillis).coerceAtLeast(0L) / 1_000L)
    return when {
        seconds < 60L -> "now"
        seconds < 3_600L -> "${seconds / 60L}m"
        seconds < 86_400L -> "${seconds / 3_600L}h"
        else -> "${seconds / 86_400L}d"
    }
}

internal fun relativeTimeDescription(timestampMillis: Long, nowMillis: Long): String {
    val short = relativeTime(timestampMillis, nowMillis)
    return if (short == "now") "just now" else "$short ago"
}

internal fun relativeTimeDescriptionFromSeconds(timestampSeconds: Long, nowMillis: Long): String {
    if (timestampSeconds <= 0L) return "recently"
    return relativeTimeDescription(timestampSeconds * 1_000L, nowMillis)
}
