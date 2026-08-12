package com.tmuxworktree.mobile.feature

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.runtime.mutableStateOf
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.RelayHost
import com.tmuxworktree.mobile.core.model.RelayProject
import com.tmuxworktree.mobile.core.model.RelayScope
import com.tmuxworktree.mobile.designsystem.TwTheme
import com.tmuxworktree.mobile.feature.createterminal.NewTerminalForm
import com.tmuxworktree.mobile.feature.createterminal.NewTerminalScreen
import com.tmuxworktree.mobile.feature.createterminal.NewTerminalValidationErrors
import com.tmuxworktree.mobile.feature.createworktree.NewWorktreeForm
import com.tmuxworktree.mobile.feature.createworktree.NewWorktreeScreen
import com.tmuxworktree.mobile.feature.createworktree.NewWorktreeStep
import com.tmuxworktree.mobile.feature.createworktree.NewWorktreeValidationErrors
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class CreationScreensInstrumentedTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun savedDashboardProjectsAreVisibleInBothCreationForms() {
        val host = RelayHost("host")
        val project = RelayProject("tmux-worktree", "/repo/tmux-worktree", "main")
        val scope = RelayScope("host", "local", projects = listOf(project))
        val showTerminal = mutableStateOf(false)
        composeRule.setContent {
            TwTheme {
                if (showTerminal.value) {
                    NewTerminalScreen(
                        form = NewTerminalForm(hostId = host.hostId, scopeId = scope.scopeId),
                        hosts = listOf(host),
                        scopes = listOf(scope),
                        isLoadingTargets = false,
                        isCreating = false,
                        validationErrors = NewTerminalValidationErrors(),
                        targetLoadError = null,
                        creationError = null,
                        onBack = {},
                        onHostSelected = {},
                        onScopeSelected = {},
                        onProjectSelected = {},
                        onWorkingDirectoryChange = {},
                        onLabelChange = {},
                        onRetryLoadTargets = {},
                        onCreate = {},
                    )
                } else NewWorktreeScreen(
                    step = NewWorktreeStep.CONFIGURE,
                    form = NewWorktreeForm(hostId = host.hostId, scopeId = scope.scopeId),
                    hosts = listOf(host),
                    scopes = listOf(scope),
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
                    onProjectSelected = {},
                    onRepositoryPathChange = {},
                    onBaseBranchChange = {},
                    onAiCommandChange = {},
                    onWorktreeNameChange = {},
                    onRetryLoadTargets = {},
                    onCreate = {},
                )
            }
        }
        composeRule.onNodeWithTag("create_saved_project_selector").assertIsDisplayed()
        composeRule.runOnIdle { showTerminal.value = true }
        composeRule.onNodeWithTag("new_terminal_saved_project_selector").assertIsDisplayed()
    }

    @Test
    fun recoveringWorktreeTargetsExposeTheErrorAndRetryInsteadOfAPermanentSpinner() {
        var retries = 0
        composeRule.setContent {
            TwTheme {
                NewWorktreeScreen(
                    step = NewWorktreeStep.TARGET,
                    form = NewWorktreeForm(),
                    hosts = emptyList(),
                    scopes = emptyList(),
                    isLoadingTargets = false,
                    isCreating = false,
                    validationErrors = NewWorktreeValidationErrors(),
                    targetLoadError = "Relay unavailable",
                    creationError = null,
                    onBack = {},
                    onPreviousStep = {},
                    onNextStep = {},
                    onHostSelected = {},
                    onScopeSelected = {},
                    onProjectSelected = {},
                    onRepositoryPathChange = {},
                    onBaseBranchChange = {},
                    onAiCommandChange = {},
                    onWorktreeNameChange = {},
                    onRetryLoadTargets = { retries++ },
                    onCreate = {},
                )
            }
        }

        composeRule.onNodeWithTag("create_targets_loading").assertDoesNotExist()
        composeRule.onNodeWithText("Relay unavailable").assertIsDisplayed()
        composeRule.onNodeWithTag("create_retry_targets").performClick()
        composeRule.runOnIdle { assertEquals(1, retries) }
    }

    @Test
    fun recoveringTerminalTargetsExposeTheErrorAndRetryInsteadOfAPermanentSpinner() {
        var retries = 0
        composeRule.setContent {
            TwTheme {
                NewTerminalScreen(
                    form = NewTerminalForm(),
                    hosts = emptyList(),
                    scopes = emptyList(),
                    isLoadingTargets = false,
                    isCreating = false,
                    validationErrors = NewTerminalValidationErrors(),
                    targetLoadError = "Relay unavailable",
                    creationError = null,
                    onBack = {},
                    onHostSelected = {},
                    onScopeSelected = {},
                    onProjectSelected = {},
                    onWorkingDirectoryChange = {},
                    onLabelChange = {},
                    onRetryLoadTargets = { retries++ },
                    onCreate = {},
                )
            }
        }

        composeRule.onNodeWithTag("new_terminal_loading").assertDoesNotExist()
        composeRule.onNodeWithText("Relay unavailable").assertIsDisplayed()
        composeRule.onNodeWithTag("new_terminal_retry_targets").performClick()
        composeRule.runOnIdle { assertEquals(1, retries) }
    }

    @Test
    fun worktreeCreationDisablesEveryVisibleBackAction() {
        val host = RelayHost("host")
        val scope = RelayScope("host", "local")
        composeRule.setContent {
            TwTheme {
                NewWorktreeScreen(
                    step = NewWorktreeStep.REVIEW,
                    form = NewWorktreeForm(
                        hostId = host.hostId,
                        scopeId = scope.scopeId,
                        repositoryPath = "/tmp/repo",
                        aiCommand = "codex",
                        worktreeName = "created",
                    ),
                    hosts = listOf(host),
                    scopes = listOf(scope),
                    isLoadingTargets = false,
                    isCreating = true,
                    validationErrors = NewWorktreeValidationErrors(),
                    targetLoadError = null,
                    creationError = null,
                    onBack = {},
                    onPreviousStep = {},
                    onNextStep = {},
                    onHostSelected = {},
                    onScopeSelected = {},
                    onProjectSelected = {},
                    onRepositoryPathChange = {},
                    onBaseBranchChange = {},
                    onAiCommandChange = {},
                    onWorktreeNameChange = {},
                    onRetryLoadTargets = {},
                    onCreate = {},
                )
            }
        }

        composeRule.onNodeWithTag("topbar_back").assertIsNotEnabled()
        composeRule.onNodeWithTag("create_back").assertIsNotEnabled()
        composeRule.onNodeWithTag("create_submit").assertIsNotEnabled()
    }
}
