package com.tmuxworktree.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Label
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.DemoData
import com.tmuxworktree.mobile.core.model.RelayHost
import com.tmuxworktree.mobile.core.model.RelayScope

@Immutable
data class NewTerminalForm(
    val hostId: String = "",
    val scopeId: String = "",
    val workingDirectory: String = "",
    val label: String = "",
)

@Immutable
data class NewTerminalValidationErrors(
    val host: String? = null,
    val scope: String? = null,
    val workingDirectory: String? = null,
    val label: String? = null,
)

@Composable
fun NewTerminalScreen(
    form: NewTerminalForm,
    hosts: List<RelayHost>,
    scopes: List<RelayScope>,
    isLoadingTargets: Boolean,
    isCreating: Boolean,
    validationErrors: NewTerminalValidationErrors,
    targetLoadError: String?,
    creationError: String?,
    onBack: () -> Unit,
    onHostSelected: (RelayHost) -> Unit,
    onScopeSelected: (RelayScope) -> Unit,
    onWorkingDirectoryChange: (String) -> Unit,
    onLabelChange: (String) -> Unit,
    onRetryLoadTargets: () -> Unit,
    onCreate: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val onlineHosts = hosts.filter { it.status == ConnectionStatus.ONLINE }
    val selectedHost = onlineHosts.firstOrNull { it.hostId == form.hostId }
    val reachableScopes = scopes.filter {
        it.hostId == form.hostId && it.reachable
    }
    val selectedScope = reachableScopes.firstOrNull { it.scopeId == form.scopeId }
    val canCreate = selectedHost != null &&
        selectedScope != null &&
        form.workingDirectory.isNotBlank() &&
        validationErrors.host == null &&
        validationErrors.scope == null &&
        validationErrors.workingDirectory == null &&
        validationErrors.label == null &&
        !isLoadingTargets &&
        !isCreating

    Scaffold(
        modifier = modifier
            .fillMaxSize()
            .testTag("new_terminal_screen"),
        containerColor = TwBackground,
        topBar = {
            NewTerminalTopBar(
                isCreating = isCreating,
                onBack = onBack,
            )
        },
        bottomBar = {
            NewTerminalBottomBar(
                canCreate = canCreate,
                isCreating = isCreating,
                onBack = onBack,
                onCreate = onCreate,
            )
        },
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
            contentPadding = PaddingValues(
                start = 20.dp,
                top = 24.dp,
                end = 20.dp,
                bottom = 24.dp,
            ),
        ) {
            item(key = "new_terminal_heading") {
                Text(
                    text = "Create a terminal",
                    color = TwTextPrimary,
                    style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier.semantics { heading() },
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    text = "Start a plain terminal session in the directory you choose.",
                    color = TwTextSecondary,
                    style = MaterialTheme.typography.bodyLarge,
                )
                Spacer(Modifier.height(22.dp))
            }

            if (!creationError.isNullOrBlank()) {
                item(key = "new_terminal_creation_error") {
                    NewTerminalErrorBanner(
                        message = creationError,
                        prefix = "Terminal creation failed",
                        testTag = "new_terminal_error",
                    )
                    Spacer(Modifier.height(16.dp))
                }
            }

            if (!targetLoadError.isNullOrBlank() && onlineHosts.isNotEmpty()) {
                item(key = "new_terminal_target_warning") {
                    NewTerminalErrorBanner(
                        message = targetLoadError,
                        prefix = "Some targets could not be loaded",
                        testTag = "new_terminal_target_error",
                    )
                    Spacer(Modifier.height(16.dp))
                }
            }

            item(key = "new_terminal_form") {
                when {
                    isLoadingTargets -> NewTerminalLoadingState()
                    onlineHosts.isEmpty() -> NewTerminalEmptyTargetsState(
                        message = targetLoadError ?: "No online computers are available.",
                        onRetry = onRetryLoadTargets,
                    )
                    else -> NewTerminalFormContent(
                        form = form,
                        hosts = onlineHosts,
                        scopes = reachableScopes,
                        selectedHost = selectedHost,
                        selectedScope = selectedScope,
                        validationErrors = validationErrors,
                        enabled = !isCreating,
                        onHostSelected = onHostSelected,
                        onScopeSelected = onScopeSelected,
                        onWorkingDirectoryChange = onWorkingDirectoryChange,
                        onLabelChange = onLabelChange,
                    )
                }
            }
        }
    }
}

@Composable
private fun NewTerminalTopBar(
    isCreating: Boolean,
    onBack: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(TwBackground),
    ) {
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
                enabled = !isCreating,
                modifier = Modifier
                    .size(48.dp)
                    .testTag("new_terminal_back"),
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Outlined.ArrowBack,
                    contentDescription = if (isCreating) {
                        "Creating terminal, back unavailable"
                    } else {
                        "Cancel new terminal"
                    },
                    tint = if (isCreating) TwTextMuted else TwTextSecondary,
                    modifier = Modifier.size(24.dp),
                )
            }
            Spacer(Modifier.width(8.dp))
            Text(
                text = "New terminal",
                color = TwTextPrimary,
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f),
            )
        }
        HorizontalDivider(color = TwBorder, thickness = 1.dp)
    }
}

@Composable
private fun NewTerminalFormContent(
    form: NewTerminalForm,
    hosts: List<RelayHost>,
    scopes: List<RelayScope>,
    selectedHost: RelayHost?,
    selectedScope: RelayScope?,
    validationErrors: NewTerminalValidationErrors,
    enabled: Boolean,
    onHostSelected: (RelayHost) -> Unit,
    onScopeSelected: (RelayScope) -> Unit,
    onWorkingDirectoryChange: (String) -> Unit,
    onLabelChange: (String) -> Unit,
) {
    NewTerminalSelector(
        label = "Computer",
        selectedValue = selectedHost?.displayName.orEmpty(),
        placeholder = "Choose an online computer",
        icon = Icons.Outlined.Computer,
        options = hosts,
        optionLabel = { it.displayName },
        optionId = { it.hostId },
        error = validationErrors.host,
        enabled = enabled,
        testTag = "new_terminal_host_selector",
        optionTagPrefix = "new_terminal_host_option",
        onSelected = onHostSelected,
    )
    Spacer(Modifier.height(16.dp))
    NewTerminalSelector(
        label = "Scope",
        selectedValue = selectedScope?.label.orEmpty(),
        placeholder = if (form.hostId.isBlank()) {
            "Choose a computer first"
        } else {
            "Choose an available scope"
        },
        icon = Icons.Outlined.Dns,
        options = scopes,
        optionLabel = { "${it.label} · ${it.kind}" },
        optionId = { it.stableId },
        error = validationErrors.scope ?: if (form.hostId.isNotBlank() && scopes.isEmpty()) {
            "This computer has no reachable scopes."
        } else {
            null
        },
        enabled = enabled && form.hostId.isNotBlank() && scopes.isNotEmpty(),
        testTag = "new_terminal_scope_selector",
        optionTagPrefix = "new_terminal_scope_option",
        onSelected = onScopeSelected,
    )
    Spacer(Modifier.height(18.dp))
    NewTerminalTextField(
        value = form.workingDirectory,
        onValueChange = onWorkingDirectoryChange,
        label = "Working directory",
        placeholder = "/path/to/project",
        icon = Icons.Outlined.FolderOpen,
        error = validationErrors.workingDirectory,
        helper = "Required · the terminal starts in this directory",
        enabled = enabled,
        imeAction = ImeAction.Next,
        testTag = "new_terminal_working_directory",
    )
    Spacer(Modifier.height(14.dp))
    NewTerminalTextField(
        value = form.label,
        onValueChange = onLabelChange,
        label = "Label",
        placeholder = "Build shell",
        icon = Icons.AutoMirrored.Outlined.Label,
        error = validationErrors.label,
        helper = "Optional · shown instead of the generated session name",
        enabled = enabled,
        imeAction = ImeAction.Done,
        testTag = "new_terminal_label",
    )
}

@Composable
private fun <T> NewTerminalSelector(
    label: String,
    selectedValue: String,
    placeholder: String,
    icon: ImageVector,
    options: List<T>,
    optionLabel: (T) -> String,
    optionId: (T) -> String,
    error: String?,
    enabled: Boolean,
    testTag: String,
    optionTagPrefix: String,
    onSelected: (T) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(
            text = label,
            color = TwTextSecondary,
            style = MaterialTheme.typography.labelMedium,
        )
        Spacer(Modifier.height(6.dp))
        BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
            Surface(
                onClick = { expanded = true },
                enabled = enabled,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 56.dp)
                    .testTag(testTag)
                    .semantics {
                        role = Role.Button
                        contentDescription = "$label, ${selectedValue.ifBlank { placeholder }}"
                        stateDescription = if (expanded) "Expanded" else "Collapsed"
                    },
                shape = RoundedCornerShape(12.dp),
                color = Color.Transparent,
                border = BorderStroke(1.dp, if (error == null) TwBorder else TwError),
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = icon,
                        contentDescription = null,
                        tint = if (enabled) TwTextSecondary else TwTextMuted,
                        modifier = Modifier.size(22.dp),
                    )
                    Spacer(Modifier.width(12.dp))
                    Text(
                        text = selectedValue.ifBlank { placeholder },
                        color = when {
                            !enabled -> TwTextMuted
                            selectedValue.isBlank() -> TwTextSecondary
                            else -> TwTextPrimary
                        },
                        style = MaterialTheme.typography.bodyLarge,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Icon(
                        imageVector = Icons.Outlined.ExpandMore,
                        contentDescription = null,
                        tint = if (enabled) TwTextSecondary else TwTextMuted,
                        modifier = Modifier.size(22.dp),
                    )
                }
            }
            DropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false },
                modifier = Modifier
                    .width(maxWidth)
                    .background(TwSurfaceRaised),
            ) {
                options.forEach { option ->
                    DropdownMenuItem(
                        text = {
                            Text(
                                text = optionLabel(option),
                                color = TwTextPrimary,
                                style = MaterialTheme.typography.bodyLarge,
                            )
                        },
                        onClick = {
                            expanded = false
                            onSelected(option)
                        },
                        modifier = Modifier.testTag("${optionTagPrefix}_${optionId(option)}"),
                    )
                }
            }
        }
        NewTerminalFieldError(error)
    }
}

@Composable
private fun NewTerminalTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String,
    icon: ImageVector,
    error: String?,
    helper: String,
    enabled: Boolean,
    imeAction: ImeAction,
    testTag: String,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .testTag(testTag),
        label = { Text(label) },
        placeholder = { Text(placeholder) },
        leadingIcon = {
            Icon(
                imageVector = icon,
                contentDescription = null,
                modifier = Modifier.size(22.dp),
            )
        },
        supportingText = {
            Text(
                text = error ?: helper,
                color = if (error == null) TwTextMuted else TwError,
                modifier = Modifier.semantics {
                    if (error != null) {
                        liveRegion = LiveRegionMode.Assertive
                        contentDescription = "$label error: $error"
                    }
                },
            )
        },
        isError = error != null,
        singleLine = true,
        shape = RoundedCornerShape(12.dp),
        keyboardOptions = KeyboardOptions(imeAction = imeAction),
        colors = OutlinedTextFieldDefaults.colors(
            focusedTextColor = TwTextPrimary,
            unfocusedTextColor = TwTextPrimary,
            disabledTextColor = TwTextMuted,
            focusedBorderColor = TwAccent,
            unfocusedBorderColor = TwBorder,
            disabledBorderColor = TwBorder,
            errorBorderColor = TwError,
            focusedLabelColor = TwAccent,
            unfocusedLabelColor = TwTextSecondary,
            cursorColor = TwAccent,
            focusedLeadingIconColor = TwAccent,
            unfocusedLeadingIconColor = TwTextSecondary,
        ),
    )
}

@Composable
private fun NewTerminalLoadingState() {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 260.dp)
            .testTag("new_terminal_loading")
            .semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = "Loading online computers and scopes"
            },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        CircularProgressIndicator(
            color = TwAccent,
            strokeWidth = 3.dp,
            modifier = Modifier.size(32.dp),
        )
        Spacer(Modifier.height(16.dp))
        Text(
            text = "Loading computers and scopes…",
            color = TwTextSecondary,
            style = MaterialTheme.typography.bodyLarge,
        )
    }
}

@Composable
private fun NewTerminalEmptyTargetsState(
    message: String,
    onRetry: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 260.dp)
            .testTag("new_terminal_empty"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            imageVector = Icons.Outlined.ErrorOutline,
            contentDescription = null,
            tint = TwWarning,
            modifier = Modifier.size(36.dp),
        )
        Spacer(Modifier.height(12.dp))
        Text(
            text = message,
            color = TwTextPrimary,
            style = MaterialTheme.typography.bodyLarge,
        )
        Spacer(Modifier.height(16.dp))
        OutlinedButton(
            onClick = onRetry,
            modifier = Modifier
                .height(48.dp)
                .testTag("new_terminal_retry_targets"),
            shape = RoundedCornerShape(12.dp),
            border = BorderStroke(1.dp, TwAccent),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = TwAccent),
        ) {
            Icon(
                imageVector = Icons.Outlined.Refresh,
                contentDescription = null,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(8.dp))
            Text("Retry")
        }
    }
}

@Composable
private fun NewTerminalErrorBanner(
    message: String,
    prefix: String,
    testTag: String,
) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(testTag)
            .semantics {
                liveRegion = LiveRegionMode.Assertive
                contentDescription = "$prefix: $message"
            },
        color = TwSurface,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, TwError),
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(
                imageVector = Icons.Outlined.ErrorOutline,
                contentDescription = null,
                tint = TwError,
                modifier = Modifier.size(22.dp),
            )
            Spacer(Modifier.width(10.dp))
            Column {
                Text(
                    text = prefix,
                    color = TwError,
                    style = MaterialTheme.typography.labelLarge,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    text = message,
                    color = TwTextPrimary,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

@Composable
private fun NewTerminalFieldError(error: String?) {
    if (error == null) return
    Text(
        text = error,
        color = TwError,
        style = MaterialTheme.typography.labelSmall,
        modifier = Modifier
            .padding(start = 12.dp, top = 4.dp)
            .semantics {
                liveRegion = LiveRegionMode.Assertive
                contentDescription = "Field error: $error"
            },
    )
}

@Composable
private fun NewTerminalBottomBar(
    canCreate: Boolean,
    isCreating: Boolean,
    onBack: () -> Unit,
    onCreate: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(TwSurface)
            .navigationBarsPadding(),
    ) {
        HorizontalDivider(color = TwBorder, thickness = 1.dp)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedButton(
                onClick = onBack,
                enabled = !isCreating,
                modifier = Modifier
                    .weight(1f)
                    .height(48.dp)
                    .testTag("new_terminal_cancel"),
                shape = RoundedCornerShape(12.dp),
                border = BorderStroke(1.dp, TwBorder),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = TwTextSecondary),
            ) {
                Text("Cancel")
            }
            Button(
                onClick = onCreate,
                enabled = canCreate,
                modifier = Modifier
                    .weight(1.5f)
                    .height(48.dp)
                    .testTag("new_terminal_create")
                    .semantics {
                        stateDescription = when {
                            isCreating -> "Creating terminal"
                            canCreate -> "Ready"
                            else -> "Complete the required fields"
                        }
                    },
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = TwAccent,
                    contentColor = TwOnAccent,
                    disabledContainerColor = TwSurfaceRaised,
                    disabledContentColor = TwTextMuted,
                ),
            ) {
                if (isCreating) {
                    CircularProgressIndicator(
                        color = TwTextSecondary,
                        strokeWidth = 2.dp,
                        modifier = Modifier.size(18.dp),
                    )
                } else {
                    Icon(
                        imageVector = Icons.Outlined.Terminal,
                        contentDescription = null,
                        modifier = Modifier.size(20.dp),
                    )
                }
                Spacer(Modifier.width(8.dp))
                Text(
                    text = if (isCreating) "Creating…" else "Create terminal",
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
    }
}

@Preview(showBackground = true, backgroundColor = 0xFF070A0E, widthDp = 390, heightDp = 844)
@Composable
private fun NewTerminalScreenPreview() {
    val hosts = DemoData.hosts()
    val scopes = DemoData.scopes()
    TwTheme {
        NewTerminalScreen(
            form = NewTerminalForm(
                hostId = hosts.first().hostId,
                scopeId = scopes.first().scopeId,
                workingDirectory = "/Users/bytedance/tmux-worktree",
                label = "Build shell",
            ),
            hosts = hosts,
            scopes = scopes,
            isLoadingTargets = false,
            isCreating = false,
            validationErrors = NewTerminalValidationErrors(),
            targetLoadError = null,
            creationError = null,
            onBack = {},
            onHostSelected = {},
            onScopeSelected = {},
            onWorkingDirectoryChange = {},
            onLabelChange = {},
            onRetryLoadTargets = {},
            onCreate = {},
        )
    }
}
