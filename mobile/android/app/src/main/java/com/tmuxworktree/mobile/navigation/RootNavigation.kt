package com.tmuxworktree.mobile.navigation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DesktopWindows
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.DesktopWindows
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.tmuxworktree.mobile.designsystem.TwAccent
import com.tmuxworktree.mobile.designsystem.TwBackground
import com.tmuxworktree.mobile.designsystem.TwBorder
import com.tmuxworktree.mobile.designsystem.TwOnAccent
import com.tmuxworktree.mobile.designsystem.TwSurface
import com.tmuxworktree.mobile.designsystem.TwTextSecondary
import kotlin.math.max

enum class RootDestination(val label: String, val testTag: String) {
    INBOX("Inbox", "nav_inbox"),
    WORKSPACES("Workspaces", "nav_workspaces"),
    SETTINGS("Settings", "nav_settings"),
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
