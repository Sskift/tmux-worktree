@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.tmuxworktree.mobile.feature.createworktree

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.RocketLaunch
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.Workspaces
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
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
import com.tmuxworktree.mobile.designsystem.*

enum class NewWorktreeStep(val number: Int, val heading: String, val description: String) {
    TARGET(1, "Choose a target", "Select the computer and scope that will run this worktree."),
    CONFIGURE(2, "Configure worktree", "Choose the repository, branch, and worktree name."),
    REVIEW(3, "Review and create", "Confirm the target and Git details before creating."),
}

@Immutable
data class NewWorktreeForm(
    val hostId: String = "",
    val scopeId: String = "",
    val repositoryPath: String = "",
    val baseBranch: String = "",
    val aiCommand: String = "codex",
    val worktreeName: String = "",
)

@Immutable
data class NewWorktreeValidationErrors(
    val host: String? = null,
    val scope: String? = null,
    val repositoryPath: String? = null,
    val baseBranch: String? = null,
    val aiCommand: String? = null,
    val worktreeName: String? = null,
) {
    fun hasConfigurationError(): Boolean = listOf(
        repositoryPath,
        aiCommand,
        worktreeName,
    ).any { it != null }
}

@Composable
fun NewWorktreeScreen(
    step: NewWorktreeStep,
    form: NewWorktreeForm,
    hosts: List<RelayHost>,
    scopes: List<RelayScope>,
    isLoadingTargets: Boolean,
    isCreating: Boolean,
    validationErrors: NewWorktreeValidationErrors,
    targetLoadError: String?,
    creationError: String?,
    onBack: () -> Unit,
    onPreviousStep: () -> Unit,
    onNextStep: () -> Unit,
    onHostSelected: (RelayHost) -> Unit,
    onScopeSelected: (RelayScope) -> Unit,
    onRepositoryPathChange: (String) -> Unit,
    onBaseBranchChange: (String) -> Unit,
    onAiCommandChange: (String) -> Unit,
    onWorktreeNameChange: (String) -> Unit,
    onRetryLoadTargets: () -> Unit,
    onCreate: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val selectedHost = hosts.firstOrNull { it.hostId == form.hostId }
    val visibleScopes = scopes.filter { it.hostId == form.hostId }
    val selectedScope = visibleScopes.firstOrNull { it.scopeId == form.scopeId }
    val canContinue = when (step) {
        NewWorktreeStep.TARGET -> selectedHost?.status == ConnectionStatus.ONLINE &&
            selectedScope?.reachable == true &&
            validationErrors.host == null &&
            validationErrors.scope == null
        NewWorktreeStep.CONFIGURE -> form.repositoryPath.isNotBlank() &&
            form.aiCommand.isNotBlank() &&
            form.worktreeName.isNotBlank() &&
            !validationErrors.hasConfigurationError()
        NewWorktreeStep.REVIEW -> !isCreating
    }

    Scaffold(
        modifier = modifier
            .fillMaxSize()
            .testTag("new_worktree_screen"),
        containerColor = TwBackground,
        topBar = {
            NewWorktreeTopBar(
                step = step,
                isCreating = isCreating,
                onBack = if (step == NewWorktreeStep.TARGET) onBack else onPreviousStep,
            )
        },
        bottomBar = {
            NewWorktreeBottomBar(
                step = step,
                canContinue = canContinue,
                isCreating = isCreating,
                onBack = if (step == NewWorktreeStep.TARGET) onBack else onPreviousStep,
                onNext = onNextStep,
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
            item(key = "step_heading") {
                Text(
                    text = step.heading,
                    color = TwTextPrimary,
                    style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier.semantics { heading() },
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    text = step.description,
                    color = TwTextSecondary,
                    style = MaterialTheme.typography.bodyLarge,
                )
                Spacer(Modifier.height(22.dp))
            }

            if (!creationError.isNullOrBlank()) {
                item(key = "creation_error") {
                    WorktreeErrorBanner(
                        message = creationError,
                        testTag = "create_error",
                    )
                    Spacer(Modifier.height(16.dp))
                }
            }

            when (step) {
                NewWorktreeStep.TARGET -> item(key = "target_step") {
                    when {
                        isLoadingTargets -> LoadingTargetsState()
                        hosts.isEmpty() -> EmptyTargetsState(
                            message = targetLoadError ?: "No connected computers are available.",
                            onRetry = onRetryLoadTargets,
                        )
                        else -> TargetStep(
                            form = form,
                            hosts = hosts,
                            scopes = visibleScopes,
                            selectedHost = selectedHost,
                            selectedScope = selectedScope,
                            errors = validationErrors,
                            onHostSelected = onHostSelected,
                            onScopeSelected = onScopeSelected,
                        )
                    }
                }

                NewWorktreeStep.CONFIGURE -> item(key = "configure_step") {
                    ConfigureStep(
                        form = form,
                        errors = validationErrors,
                        onRepositoryPathChange = onRepositoryPathChange,
                        onBaseBranchChange = onBaseBranchChange,
                        onAiCommandChange = onAiCommandChange,
                        onWorktreeNameChange = onWorktreeNameChange,
                    )
                }

                NewWorktreeStep.REVIEW -> item(key = "review_step") {
                    ReviewStep(
                        form = form,
                        hostLabel = selectedHost?.displayName ?: form.hostId,
                        scopeLabel = selectedScope?.label ?: form.scopeId,
                        isCreating = isCreating,
                    )
                }
            }
        }
    }
}

@Composable
private fun NewWorktreeTopBar(
    step: NewWorktreeStep,
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
                    .testTag("topbar_back"),
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Outlined.ArrowBack,
                    contentDescription = when {
                        isCreating -> "Creating worktree, back unavailable"
                        step == NewWorktreeStep.TARGET -> "Cancel new worktree"
                        else -> "Return to step ${step.number - 1}"
                    },
                    tint = if (isCreating) TwTextMuted else TwTextSecondary,
                    modifier = Modifier.size(24.dp),
                )
            }
            Spacer(Modifier.width(8.dp))
            Text(
                text = "New worktree",
                color = TwTextPrimary,
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = "Step ${step.number} of 3",
                color = TwTextSecondary,
                style = MaterialTheme.typography.labelMedium,
            )
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 20.dp, end = 20.dp, bottom = 12.dp)
                .testTag("create_step_indicator")
                .semantics {
                    stateDescription = "Step ${step.number} of 3, ${step.heading}"
                },
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            repeat(3) { index ->
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(4.dp)
                        .background(
                            color = if (index < step.number) TwAccent else TwBorder,
                            shape = RoundedCornerShape(2.dp),
                        ),
                )
            }
        }
        HorizontalDivider(color = TwBorder, thickness = 1.dp)
    }
}

@Composable
private fun TargetStep(
    form: NewWorktreeForm,
    hosts: List<RelayHost>,
    scopes: List<RelayScope>,
    selectedHost: RelayHost?,
    selectedScope: RelayScope?,
    errors: NewWorktreeValidationErrors,
    onHostSelected: (RelayHost) -> Unit,
    onScopeSelected: (RelayScope) -> Unit,
) {
    SelectorField(
        label = "Computer",
        selectedValue = selectedHost?.displayName.orEmpty(),
        placeholder = "Choose a computer",
        icon = Icons.Outlined.Computer,
        options = hosts,
        optionLabel = { host ->
            val status = host.status.visual().label
            "${host.displayName} · $status"
        },
        optionId = { it.hostId },
        optionEnabled = { it.status == ConnectionStatus.ONLINE },
        error = errors.host,
        testTag = "create_host_selector",
        optionTagPrefix = "create_host_option",
        onSelected = onHostSelected,
    )
    Spacer(Modifier.height(16.dp))
    SelectorField(
        label = "Scope",
        selectedValue = selectedScope?.label.orEmpty(),
        placeholder = if (form.hostId.isBlank()) "Choose a computer first" else "Choose a scope",
        icon = Icons.Outlined.Dns,
        options = scopes,
        optionLabel = { scope ->
            "${scope.label} · ${if (scope.reachable) scope.kind else "Unavailable"}"
        },
        optionId = { it.stableId },
        optionEnabled = { it.reachable },
        enabled = form.hostId.isNotBlank() && scopes.isNotEmpty(),
        error = errors.scope ?: if (form.hostId.isNotBlank() && scopes.isEmpty()) {
            "This computer has no available scopes."
        } else {
            null
        },
        testTag = "create_scope_selector",
        optionTagPrefix = "create_scope_option",
        onSelected = onScopeSelected,
    )
}

@Composable
private fun <T> SelectorField(
    label: String,
    selectedValue: String,
    placeholder: String,
    icon: ImageVector,
    options: List<T>,
    optionLabel: (T) -> String,
    optionId: (T) -> String,
    optionEnabled: (T) -> Boolean,
    error: String?,
    testTag: String,
    optionTagPrefix: String,
    onSelected: (T) -> Unit,
    enabled: Boolean = true,
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
                                color = if (optionEnabled(option)) TwTextPrimary else TwTextMuted,
                                style = MaterialTheme.typography.bodyLarge,
                            )
                        },
                        onClick = {
                            expanded = false
                            onSelected(option)
                        },
                        enabled = optionEnabled(option),
                        modifier = Modifier.testTag("${optionTagPrefix}_${optionId(option)}"),
                    )
                }
            }
        }
        FieldError(error = error)
    }
}

@Composable
private fun ConfigureStep(
    form: NewWorktreeForm,
    errors: NewWorktreeValidationErrors,
    onRepositoryPathChange: (String) -> Unit,
    onBaseBranchChange: (String) -> Unit,
    onAiCommandChange: (String) -> Unit,
    onWorktreeNameChange: (String) -> Unit,
) {
    WorktreeTextField(
        value = form.repositoryPath,
        onValueChange = onRepositoryPathChange,
        label = "Repository project or path",
        placeholder = "project-name or /path/to/repository",
        icon = Icons.Outlined.FolderOpen,
        error = errors.repositoryPath,
        testTag = "create_repository_path",
        imeAction = ImeAction.Next,
    )
    Spacer(Modifier.height(14.dp))
    WorktreeTextField(
        value = form.baseBranch,
        onValueChange = onBaseBranchChange,
        label = "Base branch (optional)",
        placeholder = "Auto-detect from project config",
        icon = Icons.Outlined.AccountTree,
        error = errors.baseBranch,
        testTag = "create_base_branch",
        imeAction = ImeAction.Next,
    )
    Spacer(Modifier.height(14.dp))
    WorktreeTextField(
        value = form.aiCommand,
        onValueChange = onAiCommandChange,
        label = "Agent command",
        placeholder = "codex",
        icon = Icons.Outlined.Terminal,
        error = errors.aiCommand,
        testTag = "create_ai_command",
        imeAction = ImeAction.Next,
    )
    Spacer(Modifier.height(14.dp))
    WorktreeTextField(
        value = form.worktreeName,
        onValueChange = onWorktreeNameChange,
        label = "Worktree name",
        placeholder = "mobile-v2",
        icon = Icons.Outlined.Workspaces,
        error = errors.worktreeName,
        testTag = "create_worktree_name",
        imeAction = ImeAction.Done,
    )
}

@Composable
private fun WorktreeTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String,
    icon: ImageVector,
    error: String?,
    testTag: String,
    imeAction: ImeAction,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
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
        supportingText = if (error == null) {
            null
        } else {
            {
                Text(
                    text = error,
                    modifier = Modifier.semantics {
                        liveRegion = LiveRegionMode.Assertive
                        contentDescription = "$label error: $error"
                    },
                )
            }
        },
        isError = error != null,
        singleLine = true,
        shape = RoundedCornerShape(12.dp),
        keyboardOptions = KeyboardOptions(imeAction = imeAction),
        colors = OutlinedTextFieldDefaults.colors(
            focusedTextColor = TwTextPrimary,
            unfocusedTextColor = TwTextPrimary,
            focusedBorderColor = TwAccent,
            unfocusedBorderColor = TwBorder,
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
private fun ReviewStep(
    form: NewWorktreeForm,
    hostLabel: String,
    scopeLabel: String,
    isCreating: Boolean,
) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .testTag("create_review"),
        shape = RoundedCornerShape(12.dp),
        color = TwSurface,
        border = BorderStroke(1.dp, TwBorder),
    ) {
        Column {
            ReviewRow(Icons.Outlined.Computer, "Computer", hostLabel)
            HorizontalDivider(color = TwBorder, thickness = 1.dp)
            ReviewRow(Icons.Outlined.Dns, "Scope", scopeLabel)
            HorizontalDivider(color = TwBorder, thickness = 1.dp)
            ReviewRow(Icons.Outlined.FolderOpen, "Repository", form.repositoryPath)
            HorizontalDivider(color = TwBorder, thickness = 1.dp)
            ReviewRow(
                Icons.Outlined.AccountTree,
                "Base branch",
                form.baseBranch.ifBlank { "Auto-detect" },
            )
            HorizontalDivider(color = TwBorder, thickness = 1.dp)
            ReviewRow(Icons.Outlined.Workspaces, "Worktree", form.worktreeName)
            HorizontalDivider(color = TwBorder, thickness = 1.dp)
            ReviewRow(Icons.Outlined.Terminal, "Agent", form.aiCommand)
        }
    }
    if (isCreating) {
        Spacer(Modifier.height(20.dp))
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .testTag("create_progress")
                .semantics {
                    liveRegion = LiveRegionMode.Polite
                    contentDescription = "Creating worktree"
                },
        ) {
            LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth(),
                color = TwAccent,
                trackColor = TwBorder,
            )
            Spacer(Modifier.height(10.dp))
            Text(
                text = "Creating worktree…",
                color = TwTextSecondary,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun ReviewRow(icon: ImageVector, label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 58.dp)
            .padding(horizontal = 16.dp, vertical = 10.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = "$label: $value"
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = TwAccent,
            modifier = Modifier.size(22.dp),
        )
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = label,
                color = TwTextSecondary,
                style = MaterialTheme.typography.labelSmall,
            )
            Text(
                text = value.ifBlank { "Not selected" },
                color = TwTextPrimary,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun LoadingTargetsState() {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 220.dp)
            .testTag("create_targets_loading")
            .semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = "Loading computers and scopes"
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
private fun EmptyTargetsState(message: String, onRetry: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 220.dp)
            .testTag("create_targets_empty"),
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
                .testTag("create_retry_targets"),
            border = BorderStroke(1.dp, TwAccent),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = TwAccent),
            shape = RoundedCornerShape(12.dp),
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
private fun WorktreeErrorBanner(message: String, testTag: String) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(testTag)
            .semantics {
                liveRegion = LiveRegionMode.Assertive
                contentDescription = "Creation error: $message"
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
            Text(
                text = message,
                color = TwTextPrimary,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun FieldError(error: String?) {
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
private fun NewWorktreeBottomBar(
    step: NewWorktreeStep,
    canContinue: Boolean,
    isCreating: Boolean,
    onBack: () -> Unit,
    onNext: () -> Unit,
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
                    .testTag("create_back"),
                shape = RoundedCornerShape(12.dp),
                border = BorderStroke(1.dp, TwBorder),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = TwTextSecondary),
            ) {
                Text(if (step == NewWorktreeStep.TARGET) "Cancel" else "Back")
            }

            Button(
                onClick = if (step == NewWorktreeStep.REVIEW) onCreate else onNext,
                enabled = canContinue && !isCreating,
                modifier = Modifier
                    .weight(1.45f)
                    .height(48.dp)
                    .testTag(if (step == NewWorktreeStep.REVIEW) "create_submit" else "create_next")
                    .semantics {
                        stateDescription = when {
                            isCreating -> "Creating worktree"
                            canContinue -> "Ready"
                            else -> "Complete required fields"
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
                    Spacer(Modifier.width(8.dp))
                } else {
                    Icon(
                        imageVector = if (step == NewWorktreeStep.REVIEW) {
                            Icons.Outlined.RocketLaunch
                        } else {
                            Icons.Outlined.ChevronRight
                        },
                        contentDescription = null,
                        modifier = Modifier.size(20.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                }
                Text(
                    text = when {
                        isCreating -> "Creating…"
                        step == NewWorktreeStep.REVIEW -> "Create worktree"
                        else -> "Continue"
                    },
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
    }
}

@Preview(showBackground = true, backgroundColor = 0xFF070A0E, widthDp = 390, heightDp = 844)
@Composable
private fun NewWorktreeTargetPreview() {
    val hosts = DemoData.hosts()
    val scopes = DemoData.scopes()
    TwTheme {
        NewWorktreeScreen(
            step = NewWorktreeStep.TARGET,
            form = NewWorktreeForm(hostId = hosts.first().hostId, scopeId = scopes.first().scopeId),
            hosts = hosts,
            scopes = scopes,
            isLoadingTargets = false,
            isCreating = false,
            validationErrors = NewWorktreeValidationErrors(),
            targetLoadError = null,
            creationError = null,
            onBack = {},
            onPreviousStep = {},
            onNextStep = {},
            onHostSelected = {},
            onScopeSelected = {},
            onRepositoryPathChange = {},
            onBaseBranchChange = {},
            onAiCommandChange = {},
            onWorktreeNameChange = {},
            onRetryLoadTargets = {},
            onCreate = {},
        )
    }
}

@Preview(showBackground = true, backgroundColor = 0xFF070A0E, widthDp = 390, heightDp = 844)
@Composable
private fun NewWorktreeReviewPreview() {
    val hosts = DemoData.hosts()
    val scopes = DemoData.scopes()
    TwTheme {
        NewWorktreeScreen(
            step = NewWorktreeStep.REVIEW,
            form = NewWorktreeForm(
                hostId = hosts.first().hostId,
                scopeId = scopes.first().scopeId,
                repositoryPath = "/Users/bytedance/tmux-worktree",
                baseBranch = "main",
                aiCommand = "codex",
                worktreeName = "mobile-v2",
            ),
            hosts = hosts,
            scopes = scopes,
            isLoadingTargets = false,
            isCreating = false,
            validationErrors = NewWorktreeValidationErrors(),
            targetLoadError = null,
            creationError = null,
            onBack = {},
            onPreviousStep = {},
            onNextStep = {},
            onHostSelected = {},
            onScopeSelected = {},
            onRepositoryPathChange = {},
            onBaseBranchChange = {},
            onAiCommandChange = {},
            onWorktreeNameChange = {},
            onRetryLoadTargets = {},
            onCreate = {},
        )
    }
}
