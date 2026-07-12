package com.tmuxworktree.mobile.feature.workspaces

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tmuxworktree.mobile.core.model.AgentState
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.RelayScope
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.designsystem.TwAccent
import com.tmuxworktree.mobile.designsystem.TwBackground
import com.tmuxworktree.mobile.designsystem.TwBorder
import com.tmuxworktree.mobile.designsystem.TwError
import com.tmuxworktree.mobile.designsystem.TwRootTopBar
import com.tmuxworktree.mobile.designsystem.TwSuccess
import com.tmuxworktree.mobile.designsystem.TwSurfaceRaised
import com.tmuxworktree.mobile.designsystem.TwTextPrimary
import com.tmuxworktree.mobile.designsystem.TwTextSecondary
import com.tmuxworktree.mobile.designsystem.TwTextMuted
import com.tmuxworktree.mobile.designsystem.TwWarning
import com.tmuxworktree.mobile.navigation.RootDestination
import com.tmuxworktree.mobile.navigation.TwRootBottomBar

@Composable
fun WorkspacesScreen(
    sessions: List<RelaySession>,
    scopes: List<RelayScope>,
    connectionStatus: ConnectionStatus,
    selectedScopeId: String?,
    attentionCount: Int,
    onConnectionStatusClick: () -> Unit,
    onScopeSelected: (String?) -> Unit,
    onSessionClick: (RelaySession) -> Unit,
    onTerminalClick: (RelaySession) -> Unit,
    onNewWorktreeClick: () -> Unit,
    onBottomDestinationSelected: (RootDestination) -> Unit,
    modifier: Modifier = Modifier,
    onNewTerminalClick: () -> Unit = {},
    activeHostId: String = "",
) {
    val hostSessions = if (activeHostId.isBlank()) sessions else sessions.filter { it.hostId == activeHostId }
    val visibleScopes = if (activeHostId.isBlank()) scopes else scopes.filter { it.hostId == activeHostId }
    val visibleSessions = if (selectedScopeId == null) {
        hostSessions
    } else {
        hostSessions.filter { it.scopeId == selectedScopeId }
    }
    val terminalSessions = visibleSessions.filter { it.kind.equals("terminal", ignoreCase = true) }
    val worktreeSessions = visibleSessions.filterNot { it.kind.equals("terminal", ignoreCase = true) }
    val worktreeGroups = worktreeSessions.groupBy { it.projectName to it.scopeLabel.ifBlank { it.scopeId } }

    Scaffold(
        modifier = modifier.fillMaxSize().testTag("workspaces_screen"),
        containerColor = TwBackground,
        topBar = {
            TwRootTopBar(
                title = "Workspaces",
                connectionStatus = connectionStatus,
                onConnectionStatusClick = onConnectionStatusClick,
            )
        },
        bottomBar = {
            TwRootBottomBar(
                selectedDestination = RootDestination.WORKSPACES,
                attentionCount = attentionCount,
                onDestinationSelected = onBottomDestinationSelected,
            )
        },
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(innerPadding),
            contentPadding = PaddingValues(start = 20.dp, top = 20.dp, end = 20.dp, bottom = 28.dp),
        ) {
            item("scope_filters") {
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    ScopeFilterChip(
                        label = "All",
                        selected = selectedScopeId == null,
                        enabled = true,
                        description = "All scopes",
                        testTag = "scope_filter_all",
                        onClick = { onScopeSelected(null) },
                    )
                    visibleScopes.forEach { scope ->
                        ScopeFilterChip(
                            label = scope.label,
                            selected = selectedScopeId == scope.scopeId,
                            enabled = scope.reachable,
                            description = "Scope ${scope.label}, ${if (scope.reachable) "online" else "offline"}, ${scope.sessionCount} sessions",
                            testTag = "scope_filter_${scope.scopeId}",
                            onClick = { onScopeSelected(scope.scopeId) },
                        )
                    }
                }
                Spacer(Modifier.height(20.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    OutlinedButton(
                        onClick = onNewWorktreeClick,
                        border = BorderStroke(1.dp, TwAccent),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = TwAccent),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.weight(1f).height(48.dp).testTag("workspace_new_worktree"),
                        contentPadding = PaddingValues(horizontal = 8.dp),
                    ) {
                        Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Worktree", maxLines = 1)
                    }
                    OutlinedButton(
                        onClick = onNewTerminalClick,
                        border = BorderStroke(1.dp, TwBorder),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = TwTextSecondary),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.weight(1f).height(48.dp).testTag("workspace_new_terminal"),
                        contentPadding = PaddingValues(horizontal = 8.dp),
                    ) {
                        Icon(Icons.Outlined.Terminal, contentDescription = null, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Terminal", maxLines = 1)
                    }
                }
                Spacer(Modifier.height(8.dp))
            }

            item("worktrees_heading") {
                WorkspaceSectionHeading(
                    title = "Worktrees",
                    testTag = "workspace_worktrees_heading",
                    topPadding = 18.dp,
                )
            }
            if (worktreeGroups.isEmpty()) {
                item("worktrees_empty") {
                    WorkspaceEmptyRow(
                        text = if (visibleScopes.any { it.scopeId == selectedScopeId && !it.reachable }) {
                            "This scope is offline. Cached worktrees will appear when available."
                        } else {
                            "No worktrees in this scope."
                        },
                        testTag = "workspace_worktrees_empty",
                    )
                }
            } else {
                worktreeGroups.forEach { (group, groupSessions) ->
                    item("header_${group.first}_${group.second}") {
                        Text(
                            text = if (group.second == "local") group.first else "${group.first} · ${group.second}",
                            color = TwTextSecondary,
                            style = MaterialTheme.typography.labelLarge,
                            modifier = Modifier
                                .padding(top = 12.dp)
                                .testTag("workspace_group_${group.second}")
                                .semantics { heading() },
                        )
                        Spacer(Modifier.height(8.dp))
                    }
                    items(groupSessions, key = { it.stableId }) { session ->
                        WorkspaceSessionRow(session = session, onClick = { onSessionClick(session) })
                        if (session != groupSessions.last()) HorizontalDivider(color = TwBorder)
                    }
                }
            }

            item("terminals_heading") {
                WorkspaceSectionHeading(
                    title = "Terminals",
                    testTag = "workspace_terminals_heading",
                    topPadding = 28.dp,
                )
            }
            if (terminalSessions.isEmpty()) {
                item("terminals_empty") {
                    WorkspaceEmptyRow(
                        text = "No plain terminals in this scope.",
                        testTag = "workspace_terminals_empty",
                    )
                }
            } else {
                items(terminalSessions, key = { "terminal_${it.stableId}" }) { session ->
                    WorkspaceTerminalRow(
                        session = session,
                        onClick = { onTerminalClick(session) },
                    )
                    if (session != terminalSessions.last()) HorizontalDivider(color = TwBorder)
                }
            }
        }
    }
}

@Composable
private fun WorkspaceSectionHeading(
    title: String,
    testTag: String,
    topPadding: androidx.compose.ui.unit.Dp,
) {
    Text(
        text = title,
        color = TwTextPrimary,
        style = MaterialTheme.typography.titleLarge,
        modifier = Modifier
            .padding(top = topPadding, bottom = 6.dp)
            .testTag(testTag)
            .semantics { heading() },
    )
}

@Composable
private fun WorkspaceEmptyRow(text: String, testTag: String) {
    Text(
        text = text,
        color = TwTextSecondary,
        style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .padding(vertical = 14.dp)
            .testTag(testTag),
    )
}

@Composable
private fun ScopeFilterChip(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    description: String,
    testTag: String,
    onClick: () -> Unit,
) {
    AssistChip(
        onClick = onClick,
        label = { Text(label) },
        enabled = enabled,
        border = AssistChipDefaults.assistChipBorder(
            enabled = enabled,
            borderColor = if (selected) TwAccent else TwBorder,
        ),
        colors = AssistChipDefaults.assistChipColors(
            containerColor = if (selected) TwSurfaceRaised else Color.Transparent,
            labelColor = if (selected) TwAccent else TwTextSecondary,
            disabledContainerColor = Color.Transparent,
            disabledLabelColor = TwTextMuted,
        ),
        modifier = Modifier
            .height(36.dp)
            .testTag(testTag)
            .semantics { contentDescription = description },
    )
}

@Composable
private fun WorkspaceSessionRow(session: RelaySession, onClick: () -> Unit) {
    val stateColor = when (session.agentState) {
        AgentState.WAITING_FOR_USER -> TwWarning
        AgentState.RUNNING, AgentState.COMPLETED -> TwSuccess
        AgentState.FAILED -> TwError
        AgentState.UNKNOWN -> TwTextMuted
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 76.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .testTag("workspace_session_${session.stableId}")
            .semantics(mergeDescendants = true) {
                role = Role.Button
                contentDescription = "${session.title}, ${session.summary.ifBlank { session.kind }}, open worktree details"
            }
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Circle, contentDescription = null, tint = stateColor, modifier = Modifier.size(10.dp))
        Spacer(Modifier.width(18.dp))
        Column(Modifier.weight(1f)) {
            Text(session.title, color = TwTextPrimary, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(3.dp))
            Text(
                session.summary.ifBlank { "${session.scopeLabel.ifBlank { session.scopeId }} · ${session.windows} window${if (session.windows == 1) "" else "s"}" },
                color = TwTextSecondary,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(Icons.Outlined.ChevronRight, contentDescription = null, tint = TwTextSecondary, modifier = Modifier.size(24.dp))
    }
}

@Composable
private fun WorkspaceTerminalRow(session: RelaySession, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 76.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .testTag("workspace_terminal_${session.stableId}")
            .semantics(mergeDescendants = true) {
                role = Role.Button
                contentDescription = "${session.title}, ${session.cwd.ifBlank { session.scopeLabel }}, open terminal"
            }
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Outlined.Terminal,
            contentDescription = null,
            tint = TwAccent,
            modifier = Modifier.size(22.dp),
        )
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = session.title,
                color = TwTextPrimary,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(3.dp))
            Text(
                text = session.cwd.ifBlank { session.scopeLabel.ifBlank { session.scopeId } },
                color = TwTextSecondary,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(Icons.Outlined.ChevronRight, contentDescription = null, tint = TwTextSecondary, modifier = Modifier.size(24.dp))
    }
}
