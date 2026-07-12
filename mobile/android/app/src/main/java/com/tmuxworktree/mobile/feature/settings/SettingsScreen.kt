package com.tmuxworktree.mobile.feature.settings

import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.HealthAndSafety
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import androidx.compose.ui.unit.dp
import com.tmuxworktree.mobile.core.data.AppPreferences
import com.tmuxworktree.mobile.core.data.NotificationKind
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.designsystem.TwAccent
import com.tmuxworktree.mobile.designsystem.TwBackground
import com.tmuxworktree.mobile.designsystem.TwBorder
import com.tmuxworktree.mobile.designsystem.TwRootTopBar
import com.tmuxworktree.mobile.designsystem.TwSurface
import com.tmuxworktree.mobile.designsystem.TwTextPrimary
import com.tmuxworktree.mobile.designsystem.TwTextSecondary
import com.tmuxworktree.mobile.navigation.RootDestination
import com.tmuxworktree.mobile.navigation.TwRootBottomBar

@Composable
fun SettingsScreen(
    connectionStatus: ConnectionStatus,
    preferences: AppPreferences,
    pairedDeviceName: String,
    attentionCount: Int,
    versionName: String,
    onConnectionStatusClick: () -> Unit,
    onHealthClick: () -> Unit,
    onPairedDeviceClick: () -> Unit,
    onNotificationChanged: (NotificationKind, Boolean) -> Unit,
    onCopyDiagnostics: () -> Unit,
    onBottomDestinationSelected: (RootDestination) -> Unit,
    modifier: Modifier = Modifier,
    notificationsAvailable: Boolean = true,
) {
    Scaffold(
        modifier = modifier.fillMaxSize().testTag("settings_screen"),
        containerColor = TwBackground,
        topBar = {
            TwRootTopBar(
                title = "Settings",
                connectionStatus = connectionStatus,
                onConnectionStatusClick = onConnectionStatusClick,
            )
        },
        bottomBar = {
            TwRootBottomBar(
                selectedDestination = RootDestination.SETTINGS,
                attentionCount = attentionCount,
                onDestinationSelected = onBottomDestinationSelected,
            )
        },
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(innerPadding),
            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 20.dp),
        ) {
            item("connection_heading") { SectionHeading("Connection & devices") }
            item("connection_group") {
                SettingsGroup {
                    NavigationSettingRow(
                        title = "Connection health",
                        subtitle = connectionStatus.name.lowercase().replace('_', ' '),
                        icon = { Icon(Icons.Outlined.HealthAndSafety, null, tint = TwAccent) },
                        testTag = "settings_connection_health",
                        onClick = onHealthClick,
                    )
                    GroupDivider()
                    NavigationSettingRow(
                        title = "Paired device",
                        subtitle = pairedDeviceName.ifBlank { "No device selected" },
                        icon = { Icon(Icons.Outlined.Devices, null, tint = TwTextSecondary) },
                        testTag = "settings_paired_device",
                        onClick = onPairedDeviceClick,
                    )
                }
            }

            item("notifications_heading") { SectionHeading("Notifications") }
            if (!notificationsAvailable) {
                item("notifications_unavailable") {
                    Text(
                        text = "Agent-state notifications require Relay v2 and are unavailable with the connected Relay v1.",
                        color = TwTextSecondary,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(bottom = 10.dp),
                    )
                }
            }
            item("notifications_group") {
                SettingsGroup {
                    NotificationRow(
                        title = "Needs reply",
                        checked = notificationsAvailable && preferences.waitingNotifications,
                        enabled = notificationsAvailable,
                        testTag = "notification_waiting_switch",
                        onCheckedChange = { onNotificationChanged(NotificationKind.WAITING_FOR_USER, it) },
                    )
                    GroupDivider()
                    NotificationRow(
                        title = "Failed",
                        checked = notificationsAvailable && preferences.failedNotifications,
                        enabled = notificationsAvailable,
                        testTag = "notification_failed_switch",
                        onCheckedChange = { onNotificationChanged(NotificationKind.FAILED, it) },
                    )
                    GroupDivider()
                    NotificationRow(
                        title = "Completed",
                        checked = notificationsAvailable && preferences.completedNotifications,
                        enabled = notificationsAvailable,
                        testTag = "notification_completed_switch",
                        onCheckedChange = { onNotificationChanged(NotificationKind.COMPLETED, it) },
                    )
                }
            }

            item("diagnostics_heading") { SectionHeading("Diagnostics & app") }
            item("diagnostics_group") {
                SettingsGroup {
                    NavigationSettingRow(
                        title = "Copy diagnostics",
                        subtitle = "Secrets and terminal content are excluded",
                        icon = { Icon(Icons.Outlined.ContentCopy, null, tint = TwTextSecondary) },
                        testTag = "settings_copy_diagnostics",
                        showChevron = false,
                        onClick = onCopyDiagnostics,
                    )
                    GroupDivider()
                    Row(
                        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Version", color = TwTextPrimary, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                        Text(versionName, color = TwTextSecondary, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("settings_version"))
                    }
                }
                Spacer(Modifier.height(20.dp))
            }
        }
    }
}

@Composable
private fun SectionHeading(text: String) {
    Spacer(Modifier.height(8.dp))
    Text(
        text = text,
        color = TwTextSecondary,
        style = MaterialTheme.typography.labelLarge,
        modifier = Modifier.padding(bottom = 10.dp).semantics { heading() },
    )
}

@Composable
private fun SettingsGroup(content: @Composable () -> Unit) {
    Surface(color = TwSurface, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
        Column(content = { content() })
    }
}

@Composable
private fun NavigationSettingRow(
    title: String,
    subtitle: String,
    icon: @Composable () -> Unit,
    testTag: String,
    showChevron: Boolean = true,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .testTag(testTag)
            .semantics(mergeDescendants = true) {
                role = Role.Button
                contentDescription = "$title. $subtitle"
            }
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        icon()
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = TwTextPrimary, style = MaterialTheme.typography.bodyLarge)
            if (subtitle.isNotBlank()) Text(subtitle, color = TwTextSecondary, style = MaterialTheme.typography.bodyMedium)
        }
        if (showChevron) Icon(Icons.Outlined.ChevronRight, null, tint = TwTextSecondary, modifier = Modifier.size(22.dp))
    }
}

@Composable
private fun NotificationRow(
    title: String,
    checked: Boolean,
    enabled: Boolean = true,
    testTag: String,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, color = TwTextPrimary, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Switch(
            checked = checked,
            enabled = enabled,
            onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(checkedTrackColor = TwAccent),
            modifier = Modifier.testTag(testTag),
        )
    }
}

@Composable
private fun GroupDivider() {
    HorizontalDivider(color = TwBorder, modifier = Modifier.padding(start = 16.dp))
}
