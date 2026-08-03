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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.HealthAndSafety
import androidx.compose.material.icons.outlined.VpnKey
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
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
    onHealthClick: () -> Unit,
    onPairedDeviceClick: () -> Unit,
    onManualRelayV2Enrollment: (issuerUrl: String, oneTimeEnrollmentToken: String) -> Unit,
    onNotificationChanged: (NotificationKind, Boolean) -> Unit,
    onDarkThemeChanged: (Boolean) -> Unit,
    onCopyDiagnostics: () -> Unit,
    onBottomDestinationSelected: (RootDestination) -> Unit,
    modifier: Modifier = Modifier,
    notificationsAvailable: Boolean = true,
) {
    var showManualRelayV2Enrollment by remember { mutableStateOf(false) }

    Scaffold(
        modifier = modifier.fillMaxSize().testTag("settings_screen"),
        containerColor = TwBackground,
        topBar = {
            TwRootTopBar(
                title = "Settings",
                connectionStatus = connectionStatus,
                onConnectionStatusClick = {},
                showConnectionStatus = false,
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
            item("appearance_heading") { SectionHeading("Appearance") }
            item("appearance_group") {
                SettingsGroup {
                    PreferenceSwitchRow(
                        title = "Dark mode",
                        subtitle = if (preferences.darkThemeEnabled) {
                            "Use the dark color theme"
                        } else {
                            "Use the light color theme"
                        },
                        checked = preferences.darkThemeEnabled,
                        icon = { Icon(Icons.Outlined.DarkMode, null, tint = TwAccent) },
                        testTag = "settings_dark_theme_switch",
                        onCheckedChange = onDarkThemeChanged,
                    )
                }
            }

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
                    GroupDivider()
                    NavigationSettingRow(
                        title = "Enroll Relay v2",
                        subtitle = "Enter an issuer URL and one-time enrollment token",
                        icon = { Icon(Icons.Outlined.VpnKey, null, tint = TwTextSecondary) },
                        testTag = "settings_relay_v2_enrollment",
                        onClick = { showManualRelayV2Enrollment = true },
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

    if (showManualRelayV2Enrollment) {
        ManualRelayV2EnrollmentDialog(
            onDismiss = { showManualRelayV2Enrollment = false },
            onContinue = { issuerUrl, oneTimeEnrollmentToken ->
                showManualRelayV2Enrollment = false
                onManualRelayV2Enrollment(issuerUrl, oneTimeEnrollmentToken)
            },
        )
    }
}

@Composable
private fun ManualRelayV2EnrollmentDialog(
    onDismiss: () -> Unit,
    onContinue: (issuerUrl: String, oneTimeEnrollmentToken: String) -> Unit,
) {
    // Enrollment input is deliberately not saveable: process/activity recreation must discard it.
    var issuerUrl by remember { mutableStateOf("") }
    var oneTimeEnrollmentToken by remember { mutableStateOf("") }

    fun clearAndDismiss() {
        issuerUrl = ""
        oneTimeEnrollmentToken = ""
        onDismiss()
    }

    AlertDialog(
        onDismissRequest = ::clearAndDismiss,
        containerColor = TwSurface,
        title = { Text("Manual Relay v2 enrollment", color = TwTextPrimary) },
        text = {
            Column {
                Text(
                    "Enter the issuer shown by your relay and paste the complete one-time " +
                        "tmuxworktree://enroll token. Nothing is redeemed until review confirmation.",
                    color = TwTextSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(16.dp))
                OutlinedTextField(
                    value = issuerUrl,
                    onValueChange = { issuerUrl = it },
                    label = { Text("Relay issuer / base URL") },
                    placeholder = { Text("https://relay.example.com") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    colors = manualEnrollmentFieldColors(),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("relay_v2_manual_issuer"),
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = oneTimeEnrollmentToken,
                    onValueChange = { oneTimeEnrollmentToken = it },
                    label = { Text("One-time enrollment token") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    colors = manualEnrollmentFieldColors(),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("relay_v2_manual_token"),
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = issuerUrl.isNotBlank() && oneTimeEnrollmentToken.isNotBlank(),
                onClick = {
                    val submittedIssuerUrl = issuerUrl.trim()
                    val submittedToken = oneTimeEnrollmentToken
                    issuerUrl = ""
                    oneTimeEnrollmentToken = ""
                    onContinue(submittedIssuerUrl, submittedToken)
                },
                modifier = Modifier.testTag("relay_v2_manual_continue"),
            ) {
                Text("Review", color = TwAccent)
            }
        },
        dismissButton = {
            TextButton(
                onClick = ::clearAndDismiss,
                modifier = Modifier.testTag("relay_v2_manual_cancel"),
            ) {
                Text("Cancel", color = TwAccent)
            }
        },
    )
}

@Composable
private fun manualEnrollmentFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = TwTextPrimary,
    unfocusedTextColor = TwTextPrimary,
    focusedBorderColor = TwAccent,
    unfocusedBorderColor = TwBorder,
    focusedLabelColor = TwAccent,
    unfocusedLabelColor = TwTextSecondary,
    cursorColor = TwAccent,
    focusedContainerColor = Color.Transparent,
    unfocusedContainerColor = Color.Transparent,
)

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
private fun PreferenceSwitchRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    icon: @Composable () -> Unit,
    testTag: String,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        icon()
        Spacer(Modifier.width(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(title, color = TwTextPrimary, style = MaterialTheme.typography.bodyLarge)
            Text(subtitle, color = TwTextSecondary, style = MaterialTheme.typography.bodyMedium)
        }
        Spacer(Modifier.width(12.dp))
        Switch(
            checked = checked,
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
