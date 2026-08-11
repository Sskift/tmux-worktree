package com.tmuxworktree.mobile.feature.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tmuxworktree.mobile.core.relay.extensions.larkbindings.v2.LarkBindingView
import com.tmuxworktree.mobile.core.relay.extensions.larkbindings.v2.LarkBindingsState
import com.tmuxworktree.mobile.designsystem.TwAccent
import com.tmuxworktree.mobile.designsystem.TwBackground
import com.tmuxworktree.mobile.designsystem.TwBorder
import com.tmuxworktree.mobile.designsystem.TwError
import com.tmuxworktree.mobile.designsystem.TwSurface
import com.tmuxworktree.mobile.designsystem.TwTextPrimary
import com.tmuxworktree.mobile.designsystem.TwTextSecondary

@Composable
fun LarkBindingsScreen(
    state: LarkBindingsState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onReplyModeChange: (bindingId: String, replyMode: String) -> Unit,
    onUnlink: (bindingId: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var pendingUnlink by remember { mutableStateOf<LarkBindingView?>(null) }
    val operationInFlight = state.loading || state.busyBindingId != null
    Scaffold(
        modifier = modifier.fillMaxSize().testTag("lark_bindings_screen"),
        containerColor = TwBackground,
        topBar = {
            LarkBindingsTopBar(
                refreshing = operationInFlight,
                onBack = onBack,
                onRefresh = onRefresh,
            )
        },
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .navigationBarsPadding(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (!state.available) {
                item("unavailable") {
                    LarkBindingsNotice(
                        title = "Lark management unavailable",
                        message = state.error
                            ?: "Reconnect to a Mac that supports Lark binding management.",
                    )
                }
            } else if (state.loading && state.bindings.isEmpty()) {
                item("loading") {
                    Box(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 28.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(
                            color = TwAccent,
                            modifier = Modifier.size(28.dp),
                        )
                    }
                }
            } else if (!state.loaded && state.error == null) {
                item("not_loaded") {
                    LarkBindingsNotice(
                        title = "Bindings not checked",
                        message = "Refresh to load the groups linked on this Mac.",
                    )
                }
            } else {
                state.error?.let { message ->
                    item("error") {
                        LarkBindingsNotice(title = "Could not update bindings", message = message)
                    }
                }
                if (state.bindings.isEmpty() && state.error == null) {
                    item("empty") {
                        LarkBindingsNotice(
                            title = "No linked groups",
                            message = "Link a Lark group from the Mac Dashboard, then refresh here.",
                        )
                    }
                } else {
                    items(state.bindings, key = { it.id }) { binding ->
                        LarkBindingCard(
                            binding = binding,
                            busy = operationInFlight,
                            onReplyModeChange = { onReplyModeChange(binding.id, it) },
                            onUnlink = { pendingUnlink = binding },
                        )
                    }
                }
            }
        }
    }

    pendingUnlink?.let { binding ->
        AlertDialog(
            onDismissRequest = { pendingUnlink = null },
            containerColor = TwSurface,
            title = { Text("Unlink Lark group?", color = TwTextPrimary) },
            text = {
                Text(
                    "${binding.chatName} will stop forwarding messages to ${binding.sessionName}. " +
                        "Any in-progress Lark turn will be cancelled.",
                    color = TwTextSecondary,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        pendingUnlink = null
                        onUnlink(binding.id)
                    },
                    modifier = Modifier.testTag("confirm_unlink_${binding.id}"),
                ) {
                    Text("Unlink", color = TwError)
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingUnlink = null }) {
                    Text("Keep linked", color = TwAccent)
                }
            },
        )
    }
}

@Composable
private fun LarkBindingsTopBar(
    refreshing: Boolean,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().background(TwBackground)) {
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
                modifier = Modifier.size(48.dp).testTag("topbar_back"),
            ) {
                Icon(
                    Icons.AutoMirrored.Outlined.ArrowBack,
                    contentDescription = "Back",
                    tint = TwTextSecondary,
                )
            }
            Spacer(Modifier.width(8.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    "Settings",
                    color = TwTextSecondary,
                    style = MaterialTheme.typography.labelMedium,
                )
                Text(
                    "Lark bindings",
                    color = TwTextPrimary,
                    style = MaterialTheme.typography.titleMedium,
                )
            }
            IconButton(
                onClick = onRefresh,
                enabled = !refreshing,
                modifier = Modifier.size(48.dp).testTag("lark_bindings_refresh"),
            ) {
                if (refreshing) {
                    CircularProgressIndicator(
                        color = TwAccent,
                        strokeWidth = 2.dp,
                        modifier = Modifier.size(20.dp),
                    )
                } else {
                    Icon(Icons.Outlined.Refresh, contentDescription = "Refresh", tint = TwAccent)
                }
            }
        }
        HorizontalDivider(color = TwBorder)
    }
}

@Composable
private fun LarkBindingCard(
    binding: LarkBindingView,
    busy: Boolean,
    onReplyModeChange: (String) -> Unit,
    onUnlink: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth().testTag("lark_binding_${binding.id}"),
        color = TwSurface,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, TwBorder),
    ) {
        Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Outlined.Link,
                    contentDescription = null,
                    tint = TwAccent,
                    modifier = Modifier.size(20.dp),
                )
                Spacer(Modifier.width(10.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        binding.chatName,
                        color = TwTextPrimary,
                        style = MaterialTheme.typography.titleSmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        binding.sessionName,
                        color = TwTextSecondary,
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(
                    binding.status.replaceFirstChar(Char::uppercase),
                    color = if (binding.status == "active") TwAccent else TwTextSecondary,
                    style = MaterialTheme.typography.labelMedium,
                )
            }
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Reply placement",
                    color = TwTextSecondary,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ReplyModeChip(
                        label = "Topic",
                        selected = binding.replyMode == "topic",
                        enabled = !busy,
                        onClick = { onReplyModeChange("topic") },
                    )
                    ReplyModeChip(
                        label = "Direct",
                        selected = binding.replyMode == "direct",
                        enabled = !busy,
                        onClick = { onReplyModeChange("direct") },
                    )
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
            ) {
                TextButton(
                    onClick = onUnlink,
                    enabled = !busy,
                    contentPadding = PaddingValues(horizontal = 8.dp),
                    modifier = Modifier.testTag("unlink_lark_binding_${binding.id}"),
                ) {
                    Icon(
                        Icons.Outlined.DeleteOutline,
                        contentDescription = null,
                        tint = TwError,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text("Unlink", color = TwError)
                }
            }
        }
    }
}

@Composable
private fun ReplyModeChip(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    FilterChip(
        selected = selected,
        onClick = { if (!selected) onClick() },
        enabled = enabled,
        label = { Text(label, style = MaterialTheme.typography.labelMedium) },
    )
}

@Composable
private fun LarkBindingsNotice(title: String, message: String) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = TwSurface,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, TwBorder),
    ) {
        Row(modifier = Modifier.padding(14.dp), verticalAlignment = Alignment.Top) {
            Icon(
                Icons.Outlined.Info,
                contentDescription = null,
                tint = TwTextSecondary,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(10.dp))
            Column {
                Text(title, color = TwTextPrimary, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(3.dp))
                Text(message, color = TwTextSecondary, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}
