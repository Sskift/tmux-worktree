package com.tmuxworktree.mobile.feature.connection

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.Autorenew
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.LaptopMac
import androidx.compose.material.icons.outlined.PauseCircle
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.Refresh
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
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.tmuxworktree.mobile.core.model.ConnectionHealth
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.DemoData
import com.tmuxworktree.mobile.core.model.HealthLayer
import com.tmuxworktree.mobile.designsystem.*
import kotlin.math.ceil

@Composable
fun ConnectionHealthScreen(
    health: ConnectionHealth,
    nowMillis: Long,
    onBack: () -> Unit,
    onRetryNow: () -> Unit,
    onCopyDiagnostics: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier
            .fillMaxSize()
            .testTag("health_screen"),
        containerColor = TwBackground,
        topBar = {
            HealthTopBar(
                status = health.overall,
                onBack = onBack,
            )
        },
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .navigationBarsPadding(),
            contentPadding = PaddingValues(
                start = 20.dp,
                top = 9.dp,
                end = 20.dp,
                bottom = 16.dp,
            ),
        ) {
            item(key = "health_chain") {
                HealthChain(layers = health.layers)
                HorizontalDivider(
                    modifier = Modifier.padding(top = 8.dp),
                    color = TwBorder,
                    thickness = 1.dp,
                )
            }

            item(key = "recovery_summary") {
                RecoverySummary(
                    health = health,
                    nowMillis = nowMillis,
                    onRetryNow = onRetryNow,
                    onCopyDiagnostics = onCopyDiagnostics,
                )
                HorizontalDivider(
                    modifier = Modifier.padding(top = 12.dp),
                    color = TwBorder,
                    thickness = 1.dp,
                )
            }

            item(key = "affected_now") {
                AffectedNow(
                    health = health,
                    nowMillis = nowMillis,
                )
            }
        }
    }
}

@Composable
private fun HealthTopBar(
    status: ConnectionStatus,
    onBack: () -> Unit,
) {
    val visual = status.visual()
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(TwBackground),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .height(72.dp)
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
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "Settings",
                    color = TwTextSecondary,
                    style = MaterialTheme.typography.labelMedium,
                )
                Text(
                    text = "Connection health",
                    color = TwTextPrimary,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.width(8.dp))
            Row(
                modifier = Modifier
                    .testTag("health_summary")
                    .semantics {
                        contentDescription = "Overall connection status: ${visual.accessibleLabel}"
                        stateDescription = visual.accessibleLabel
                        liveRegion = LiveRegionMode.Polite
                    },
                horizontalArrangement = Arrangement.spacedBy(7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Filled.Circle,
                    contentDescription = null,
                    tint = visual.color,
                    modifier = Modifier.size(8.dp),
                )
                Text(
                    text = visual.label,
                    color = visual.color,
                    style = MaterialTheme.typography.labelMedium,
                )
            }
        }
        HorizontalDivider(color = TwBorder, thickness = 1.dp)
    }
}

@Composable
private fun HealthChain(layers: List<HealthLayer>) {
    Column(modifier = Modifier.fillMaxWidth()) {
        layers.forEachIndexed { index, layer ->
            HealthLayerRow(
                layer = layer,
                previousStatus = layers.getOrNull(index - 1)?.status,
                hasNext = index < layers.lastIndex,
            )
        }
    }
}

@Composable
private fun HealthLayerRow(
    layer: HealthLayer,
    previousStatus: ConnectionStatus?,
    hasNext: Boolean,
) {
    val visual = layer.status.visual()
    val onlineConnectorColor = TwSuccess
    val offlineConnectorColor = TwTextMuted
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .heightIn(min = 72.dp)
            .testTag("health_step_${layer.id}")
            .semantics(mergeDescendants = true) {
                contentDescription = "${layer.label}, ${visual.accessibleLabel}. ${layer.detail}"
            },
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            modifier = Modifier
                .width(80.dp)
                .fillMaxHeight(),
            contentAlignment = Alignment.TopCenter,
        ) {
            Canvas(modifier = Modifier.fillMaxSize()) {
                val centerX = size.width / 2f
                val circleCenterY = 36.dp.toPx()
                if (previousStatus != null) {
                    drawConnector(
                        start = Offset(centerX, 0f),
                        end = Offset(centerX, circleCenterY),
                        status = previousStatus,
                        onlineColor = onlineConnectorColor,
                        offlineColor = offlineConnectorColor,
                    )
                }
                if (hasNext) {
                    drawConnector(
                        start = Offset(centerX, circleCenterY),
                        end = Offset(centerX, size.height),
                        status = layer.status,
                        onlineColor = onlineConnectorColor,
                        offlineColor = offlineConnectorColor,
                    )
                }
            }
            Surface(
                modifier = Modifier
                    .padding(top = 12.dp)
                    .size(46.dp),
                shape = CircleShape,
                color = TwBackground,
                border = BorderStroke(2.dp, visual.color),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        imageVector = layerIcon(layer.id),
                        contentDescription = null,
                        tint = visual.color,
                        modifier = Modifier.size(22.dp),
                    )
                }
            }
        }
        Spacer(Modifier.width(12.dp))
        Column(
            modifier = Modifier.padding(top = 15.dp, bottom = 12.dp),
        ) {
            Text(
                text = layer.label,
                color = TwTextPrimary,
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(3.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = statusIcon(layer.status),
                    contentDescription = null,
                    tint = visual.color,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(7.dp))
                Text(
                    text = layer.detail.ifBlank { visual.label },
                    color = visual.color,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawConnector(
    start: Offset,
    end: Offset,
    status: ConnectionStatus,
    onlineColor: androidx.compose.ui.graphics.Color,
    offlineColor: androidx.compose.ui.graphics.Color,
) {
    val online = status == ConnectionStatus.ONLINE
    drawLine(
        color = if (online) onlineColor else offlineColor,
        start = start,
        end = end,
        strokeWidth = 2.dp.toPx(),
        pathEffect = if (online) null else {
            PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 6.dp.toPx()))
        },
    )
}

@Composable
private fun RecoverySummary(
    health: ConnectionHealth,
    nowMillis: Long,
    onRetryNow: () -> Unit,
    onCopyDiagnostics: () -> Unit,
) {
    val isOnline = health.overall == ConnectionStatus.ONLINE
    val retrySeconds = health.retryAtMillis?.let {
        ceil(((it - nowMillis).coerceAtLeast(0L)) / 1_000.0).toInt()
    }
    val recoveringTarget = health.layers.firstOrNull {
        it.status == ConnectionStatus.RECOVERING || it.status == ConnectionStatus.OFFLINE
    }?.label

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(
                imageVector = Icons.Outlined.Info,
                contentDescription = null,
                tint = TwAccent,
                modifier = Modifier.size(24.dp),
            )
            Spacer(Modifier.width(16.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = if (isOnline) "All systems are healthy." else "Your sessions are safe.",
                    color = TwTextPrimary,
                    style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                    modifier = Modifier.semantics { heading() },
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    text = when {
                        isOnline -> "Everything is up to date."
                        recoveringTarget != null -> "Reconnecting to $recoveringTarget…"
                        health.errorMessage.isNotBlank() -> health.errorMessage
                        else -> "Restoring your connection…"
                    },
                    color = TwTextPrimary,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                if (!isOnline && retrySeconds != null) {
                    Spacer(Modifier.height(14.dp))
                    Row(
                        modifier = Modifier.testTag("health_retry_countdown"),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator(
                            color = TwTextSecondary,
                            strokeWidth = 2.dp,
                            modifier = Modifier.size(18.dp),
                        )
                        Spacer(Modifier.width(10.dp))
                        Text(
                            text = "Retrying in ${retrySeconds}s",
                            color = TwTextSecondary,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }
        }

        if (!isOnline) {
            Spacer(Modifier.height(16.dp))
            Button(
                onClick = onRetryNow,
                modifier = Modifier
                    .width(260.dp)
                    .height(44.dp)
                    .testTag("health_retry")
                    .semantics {
                        role = Role.Button
                        contentDescription = "Retry connection now"
                    },
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = TwAccent,
                    contentColor = TwOnAccent,
                ),
            ) {
                Icon(
                    imageVector = Icons.Outlined.Refresh,
                    contentDescription = null,
                    modifier = Modifier.size(22.dp),
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    text = "Retry now",
                    style = MaterialTheme.typography.labelMedium,
                )
            }
        }

        TextButton(
            onClick = onCopyDiagnostics,
            modifier = Modifier
                .height(48.dp)
                .testTag("health_copy_diagnostics")
                .semantics {
                    contentDescription = "Copy sanitized connection diagnostics"
                },
            colors = ButtonDefaults.textButtonColors(contentColor = TwAccent),
        ) {
            Icon(
                imageVector = Icons.Outlined.ContentCopy,
                contentDescription = null,
                modifier = Modifier.size(19.dp),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = "Copy diagnostics",
                style = MaterialTheme.typography.labelMedium,
            )
        }
    }
}

@Composable
private fun AffectedNow(
    health: ConnectionHealth,
    nowMillis: Long,
) {
    val isOnline = health.overall == ConnectionStatus.ONLINE
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 20.dp)
            .testTag("health_affected_list"),
    ) {
        Text(
            text = if (isOnline) "Available now" else "Affected now",
            color = TwTextPrimary,
            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
            modifier = Modifier.semantics { heading() },
        )
        Spacer(Modifier.height(10.dp))
        AffectedRow(
            icon = if (isOnline) Icons.Outlined.CheckCircle else Icons.Outlined.PauseCircle,
            color = if (isOnline) TwSuccess else TwWarning,
            text = if (isOnline) "New commands are available" else "New commands are paused",
        )
        AffectedRow(
            icon = Icons.Outlined.CheckCircle,
            color = TwSuccess,
            text = if (isOnline) "Sessions are up to date" else "Cached sessions remain available",
        )
        AffectedRow(
            icon = Icons.Outlined.AccessTime,
            color = TwTextMuted,
            text = if (health.lastSyncedAtMillis > 0L) {
                "Last synced ${relativeTimeDescription(health.lastSyncedAtMillis, nowMillis)}"
            } else {
                "Not synced yet"
            },
            testTag = "health_last_synced",
        )
    }
}

@Composable
private fun AffectedRow(
    icon: ImageVector,
    color: Color,
    text: String,
    testTag: String? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .then(if (testTag != null) Modifier.testTag(testTag) else Modifier)
            .semantics(mergeDescendants = true) {
                contentDescription = text
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = color,
            modifier = Modifier.size(22.dp),
        )
        Spacer(Modifier.width(16.dp))
        Text(
            text = text,
            color = if (color == TwTextMuted) TwTextSecondary else TwTextPrimary,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

private fun layerIcon(id: String): ImageVector = when {
    id.contains("phone", ignoreCase = true) -> Icons.Outlined.PhoneAndroid
    id.contains("relay", ignoreCase = true) -> Icons.Outlined.Public
    id.contains("host", ignoreCase = true) || id.contains("mac", ignoreCase = true) -> Icons.Outlined.LaptopMac
    else -> Icons.Outlined.Dns
}

private fun statusIcon(status: ConnectionStatus): ImageVector = when (status) {
    ConnectionStatus.ONLINE -> Icons.Outlined.CheckCircle
    ConnectionStatus.RECOVERING, ConnectionStatus.CONNECTING -> Icons.Outlined.Autorenew
    ConnectionStatus.PAUSED -> Icons.Outlined.PauseCircle
    ConnectionStatus.OFFLINE,
    ConnectionStatus.AUTH_REQUIRED,
    ConnectionStatus.INCOMPATIBLE,
    ConnectionStatus.UNKNOWN,
    -> Icons.Outlined.ErrorOutline
}

@Preview(showBackground = true, backgroundColor = 0xFF070A0E, widthDp = 390, heightDp = 844)
@Composable
private fun ConnectionHealthScreenPreview() {
    TwTheme {
        ConnectionHealthScreen(
            health = DemoData.health(recovering = true),
            nowMillis = System.currentTimeMillis(),
            onBack = {},
            onRetryNow = {},
            onCopyDiagnostics = {},
        )
    }
}
