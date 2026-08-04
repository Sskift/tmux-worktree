package com.tmuxworktree.mobile.designsystem

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tmuxworktree.mobile.core.model.AgentState
import com.tmuxworktree.mobile.core.model.ConnectionStatus

internal data class StatusVisual(
    val label: String,
    val color: Color,
    val accessibleLabel: String,
)

@Composable
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

@Composable
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
    showConnectionStatus: Boolean = true,
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
        if (showConnectionStatus) {
            Spacer(Modifier.width(12.dp))
            TwConnectionStatusChip(
                status = connectionStatus,
                onClick = onConnectionStatusClick,
            )
        }
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
