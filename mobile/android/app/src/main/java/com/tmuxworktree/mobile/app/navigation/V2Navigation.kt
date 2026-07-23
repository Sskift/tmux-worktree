@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.tmuxworktree.mobile.app.navigation

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.material3.DrawerValue
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.tmuxworktree.mobile.BuildConfig
import com.tmuxworktree.mobile.app.AgentCapabilityAvailability
import com.tmuxworktree.mobile.app.NewWorktreeRequest
import com.tmuxworktree.mobile.app.RelayV2EnrollmentReviewState
import com.tmuxworktree.mobile.app.RelayStartupAdmissionState
import com.tmuxworktree.mobile.app.V2UiEffect
import com.tmuxworktree.mobile.app.V2UiState
import com.tmuxworktree.mobile.app.V2ViewModel
import com.tmuxworktree.mobile.app.shouldShowTargetLoading
import com.tmuxworktree.mobile.core.model.AgentEvidenceAvailability
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.model.SessionTimelineState
import com.tmuxworktree.mobile.core.terminal.TerminalWebView
import com.tmuxworktree.mobile.core.terminal.TerminalWebViewController
import com.tmuxworktree.mobile.core.terminal.rememberTerminalWebViewController
import com.tmuxworktree.mobile.designsystem.TwAccent
import com.tmuxworktree.mobile.designsystem.TwBackground
import com.tmuxworktree.mobile.designsystem.TwBorder
import com.tmuxworktree.mobile.designsystem.TwError
import com.tmuxworktree.mobile.designsystem.TwOnAccent
import com.tmuxworktree.mobile.designsystem.TwSurface
import com.tmuxworktree.mobile.designsystem.TwTextPrimary
import com.tmuxworktree.mobile.designsystem.TwTextSecondary
import com.tmuxworktree.mobile.feature.connection.ConnectionHealthScreen
import com.tmuxworktree.mobile.feature.createterminal.NewTerminalForm
import com.tmuxworktree.mobile.feature.createterminal.NewTerminalScreen
import com.tmuxworktree.mobile.feature.createterminal.NewTerminalValidationErrors
import com.tmuxworktree.mobile.feature.createworktree.NewWorktreeForm
import com.tmuxworktree.mobile.feature.createworktree.NewWorktreeScreen
import com.tmuxworktree.mobile.feature.createworktree.NewWorktreeStep
import com.tmuxworktree.mobile.feature.createworktree.NewWorktreeValidationErrors
import com.tmuxworktree.mobile.feature.inbox.InboxScreen
import com.tmuxworktree.mobile.feature.pairing.PairingScreen
import com.tmuxworktree.mobile.feature.pairing.RelayV2EnrollmentReviewScreen
import com.tmuxworktree.mobile.feature.session.SessionDetailScreen
import com.tmuxworktree.mobile.feature.settings.SettingsScreen
import com.tmuxworktree.mobile.feature.terminal.TerminalScreen
import com.tmuxworktree.mobile.feature.workspaces.WorkspacesScreen
import com.tmuxworktree.mobile.navigation.RootDestination
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal object V2Routes {
    const val INBOX = "inbox"
    const val WORKSPACES = "workspaces"
    const val SETTINGS = "settings"
    const val HEALTH = "health"
    const val NEW_WORKTREE = "new-worktree"
    const val NEW_TERMINAL = "new-terminal"
    const val SESSION = "session/{sessionKey}?focusReply={focusReply}"
    const val TERMINAL = "terminal/{sessionKey}"

    fun session(sessionId: String, focusReply: Boolean = false): String =
        "session/${encodeRouteValue(sessionId)}?focusReply=$focusReply"
    fun terminal(sessionId: String): String = "terminal/${encodeRouteValue(sessionId)}"
}

internal fun NavHostController.navigateAfterCreation(
    destinationRoute: String,
    formRoute: String,
) {
    val removeSubmittedForm = currentDestination?.route == formRoute
    navigate(destinationRoute) {
        if (removeSubmittedForm) {
            popUpTo(formRoute) { inclusive = true }
        }
        launchSingleTop = true
    }
}

@Composable
internal fun V2Navigation(
    viewModel: V2ViewModel,
    onScanQr: () -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val enrollmentReview by viewModel.relayV2EnrollmentReviewState.collectAsStateWithLifecycle()
    val navController = rememberNavController()
    val terminalController = rememberTerminalWebViewController()
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(viewModel, navController, terminalController) {
        viewModel.effects.collect { effect ->
            when (effect) {
                is V2UiEffect.NavigateToSession -> navController.navigateAfterCreation(
                    destinationRoute = V2Routes.session(effect.sessionId),
                    formRoute = V2Routes.NEW_WORKTREE,
                )
                is V2UiEffect.NavigateToTerminal -> navController.navigateAfterCreation(
                    destinationRoute = V2Routes.terminal(effect.sessionId),
                    formRoute = V2Routes.NEW_TERMINAL,
                )
                is V2UiEffect.TerminalReset -> terminalController.reset(effect.message)
                is V2UiEffect.TerminalWrite -> terminalController.write(effect.data)
                V2UiEffect.ProfileCleared -> terminalController.clear()
                is V2UiEffect.Notice -> launch {
                    snackbarHostState.showSnackbar(effect.message)
                }
            }
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(TwBackground)
            .testTag("v2_app"),
    ) {
        when {
            enrollmentReview != RelayV2EnrollmentReviewState.Idle -> RelayV2EnrollmentReviewGate(
                state = enrollmentReview,
                viewModel = viewModel,
            )
            !state.initialized -> LoadingApp()
            state.pairingRequired || !state.paired -> PairingGate(
                state = state,
                viewModel = viewModel,
                onScanQr = onScanQr,
            )
            else -> MainNavigation(
                state = state,
                viewModel = viewModel,
                navController = navController,
                terminalController = terminalController,
            )
        }

        SnackbarHost(
            hostState = snackbarHostState,
            modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
        )
    }
}

@Composable
private fun RelayV2EnrollmentReviewGate(
    state: RelayV2EnrollmentReviewState,
    viewModel: V2ViewModel,
) {
    val facts = when (state) {
        is RelayV2EnrollmentReviewState.Review -> state.facts
        is RelayV2EnrollmentReviewState.Submitting -> state.facts
        is RelayV2EnrollmentReviewState.Completed -> state.facts
        is RelayV2EnrollmentReviewState.Activating -> state.facts
        is RelayV2EnrollmentReviewState.ActivationFailure -> state.facts
        is RelayV2EnrollmentReviewState.Failure -> state.facts
        RelayV2EnrollmentReviewState.Idle -> return
    }
    RelayV2EnrollmentReviewScreen(
        issuerUrl = facts.issuerUrl,
        relayUrl = facts.relayUrl,
        hostId = facts.hostId,
        enrollmentId = facts.enrollmentId,
        submitting = state is RelayV2EnrollmentReviewState.Submitting,
        completed = state is RelayV2EnrollmentReviewState.Completed ||
            state is RelayV2EnrollmentReviewState.ActivationFailure,
        activating = state is RelayV2EnrollmentReviewState.Activating,
        activationFailureMessage =
            (state as? RelayV2EnrollmentReviewState.ActivationFailure)?.message,
        failureMessage = (state as? RelayV2EnrollmentReviewState.Failure)?.message,
        onConfirm = viewModel::confirmRelayV2EnrollmentReview,
        onActivate = viewModel::activateConfirmedRelayV2Profile,
        onCancel = viewModel::cancelRelayV2EnrollmentReview,
    )
}

@Composable
private fun LoadingApp() {
    Box(
        modifier = Modifier.fillMaxSize().testTag("app_loading"),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator(color = TwAccent)
    }
}

@Composable
private fun PairingGate(
    state: V2UiState,
    viewModel: V2ViewModel,
    onScanQr: () -> Unit,
) {
    val canReturn = state.paired && state.health.overall != ConnectionStatus.AUTH_REQUIRED
    if (canReturn) BackHandler { viewModel.dismissPairing() }
    PairingScreen(
        relayUrl = state.pairingRelayUrl,
        token = state.pairingToken,
        isConnecting = state.isConnecting,
        relayUrlError = state.pairingRelayUrlError,
        error = state.pairingError,
        onRelayUrlChange = viewModel::setPairingRelayUrl,
        onTokenChange = viewModel::setPairingToken,
        onScanQr = onScanQr,
        onConnect = viewModel::connectPairing,
        onBack = if (canReturn) ({ viewModel.dismissPairing() }) else null,
        onForgetPairing = if (state.paired) viewModel::forgetPairing else null,
    )
    if (state.confirmProfileSwitch) {
        AlertDialog(
            onDismissRequest = viewModel::cancelProfileSwitch,
            containerColor = TwSurface,
            title = { Text("Switch paired computer?", color = TwTextPrimary) },
            text = {
                Text(
                    "Cached sessions and unsent messages from the current pairing will be removed before connecting to the new relay.",
                    color = TwTextSecondary,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = viewModel::confirmProfileSwitch,
                    modifier = Modifier.testTag("confirm_profile_switch"),
                ) { Text("Switch", color = TwError) }
            },
            dismissButton = {
                TextButton(
                    onClick = viewModel::cancelProfileSwitch,
                    modifier = Modifier.testTag("cancel_profile_switch"),
                ) { Text("Keep current pairing", color = TwAccent) }
            },
        )
    }
}

@Composable
private fun MainNavigation(
    state: V2UiState,
    viewModel: V2ViewModel,
    navController: NavHostController,
    terminalController: TerminalWebViewController,
) {
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val agentCapabilityAvailable =
        state.agentCapabilityAvailability == AgentCapabilityAvailability.AVAILABLE
    val navigateRoot: (RootDestination) -> Unit = { destination ->
        val route = destination.route()
        navController.navigate(route) {
            popUpTo(V2Routes.INBOX) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }
    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            DeviceDrawer(
                state = state,
                onRefresh = {
                    scope.launch { drawerState.close() }
                    viewModel.refresh()
                },
                onHostSelected = { hostId ->
                    scope.launch { drawerState.close() }
                    viewModel.selectHost(hostId)
                },
                onPairing = {
                    scope.launch { drawerState.close() }
                    viewModel.showPairing()
                },
            )
        },
    ) {
        NavHost(
            navController = navController,
            startDestination = V2Routes.INBOX,
            modifier = Modifier.fillMaxSize(),
        ) {
            composable(V2Routes.INBOX) {
                InboxScreen(
                    sessions = state.activeSessions,
                    connectionStatus = state.health.overall,
                    nowMillis = rememberNowMillis(),
                    onMenuClick = { scope.launch { drawerState.open() } },
                    onConnectionStatusClick = { navController.navigate(V2Routes.HEALTH) },
                    onSessionClick = { navController.navigate(V2Routes.session(it.stableId)) },
                    onReplyClick = { navController.navigate(V2Routes.session(it.stableId, focusReply = true)) },
                    onBottomDestinationSelected = navigateRoot,
                    agentStateAvailable = agentCapabilityAvailable,
                )
            }
            composable(V2Routes.WORKSPACES) {
                WorkspacesScreen(
                    sessions = state.sessions,
                    scopes = state.scopes,
                    connectionStatus = state.health.overall,
                    selectedScopeId = state.selectedScopeId,
                    attentionCount = state.attentionCount,
                    onConnectionStatusClick = { navController.navigate(V2Routes.HEALTH) },
                    onScopeSelected = viewModel::selectScope,
                    onSessionClick = { navController.navigate(V2Routes.session(it.stableId)) },
                    onTerminalClick = { navController.navigate(V2Routes.terminal(it.stableId)) },
                    onNewWorktreeClick = { navController.navigate(V2Routes.NEW_WORKTREE) },
                    onNewTerminalClick = { navController.navigate(V2Routes.NEW_TERMINAL) },
                    onBottomDestinationSelected = navigateRoot,
                    activeHostId = state.activeHostId,
                )
            }
            composable(V2Routes.SETTINGS) {
                SettingsScreen(
                    connectionStatus = state.health.overall,
                    preferences = state.preferences,
                    pairedDeviceName = state.hosts.firstOrNull {
                        it.hostId == state.activeHostId
                    }?.displayName.orEmpty(),
                    attentionCount = state.attentionCount,
                    versionName = BuildConfig.VERSION_NAME,
                    onHealthClick = { navController.navigate(V2Routes.HEALTH) },
                    onPairedDeviceClick = viewModel::showPairing,
                    onNotificationChanged = viewModel::setNotificationPreference,
                    onDarkThemeChanged = viewModel::setDarkThemeEnabled,
                    onCopyDiagnostics = {
                        copyText(context, "tmux-worktree diagnostics", viewModel.diagnostics())
                    },
                    onBottomDestinationSelected = navigateRoot,
                    notificationsAvailable = agentCapabilityAvailable,
                )
            }
            composable(V2Routes.HEALTH) {
                ConnectionHealthScreen(
                    health = state.health,
                    nowMillis = rememberNowMillis(),
                    onBack = { navController.popBackStack() },
                    onRetryNow = viewModel::retryConnection,
                    onCopyDiagnostics = {
                        copyText(context, "tmux-worktree diagnostics", viewModel.diagnostics())
                    },
                )
            }
            composable(V2Routes.NEW_WORKTREE) {
                NewWorktreeRoute(
                    state = state,
                    viewModel = viewModel,
                    onBack = { navController.popBackStack() },
                )
            }
            composable(V2Routes.NEW_TERMINAL) {
                NewTerminalRoute(
                    state = state,
                    viewModel = viewModel,
                    onBack = { navController.popBackStack() },
                )
            }
            composable(
                route = V2Routes.SESSION,
                arguments = listOf(
                    navArgument("sessionKey") { type = NavType.StringType },
                    navArgument("focusReply") {
                        type = NavType.BoolType
                        defaultValue = false
                    },
                ),
            ) { entry ->
                val sessionId = decodeRouteValue(entry.arguments?.getString("sessionKey").orEmpty())
                val focusReply = entry.arguments?.getBoolean("focusReply") ?: false
                val session = state.session(sessionId)
                if (session == null) {
                    MissingSession(onBack = { navController.popBackStack() })
                } else {
                    SessionRoute(
                        session = session,
                        state = state,
                        viewModel = viewModel,
                        onBack = { navController.popBackStack() },
                        onHealth = { navController.navigate(V2Routes.HEALTH) },
                        onTerminal = { navController.navigate(V2Routes.terminal(session.stableId)) },
                        autoFocusReply = focusReply,
                    )
                }
            }
            composable(
                route = V2Routes.TERMINAL,
                arguments = listOf(navArgument("sessionKey") { type = NavType.StringType }),
            ) { entry ->
                val sessionId = decodeRouteValue(entry.arguments?.getString("sessionKey").orEmpty())
                val session = state.session(sessionId)
                if (session == null) {
                    MissingSession(onBack = { navController.popBackStack() })
                } else {
                    TerminalRoute(
                        session = session,
                        state = state,
                        viewModel = viewModel,
                        controller = terminalController,
                        onBack = { navController.popBackStack() },
                        onHealth = { navController.navigate(V2Routes.HEALTH) },
                    )
                }
            }
        }
    }
}

@Composable
private fun DeviceDrawer(
    state: V2UiState,
    onRefresh: () -> Unit,
    onHostSelected: (String) -> Unit,
    onPairing: () -> Unit,
) {
    ModalDrawerSheet(
        drawerContainerColor = TwSurface,
        modifier = Modifier.width(310.dp),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
        ) {
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 28.dp)) {
            Text("tw-dashboard", color = TwTextPrimary, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            Text(
                state.hosts.firstOrNull { it.hostId == state.activeHostId }?.displayName
                    ?: state.activeHostId.ifBlank { "Paired computer" },
                color = TwTextSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        HorizontalDivider(color = TwBorder)
        if (state.hosts.size > 1) {
            Text(
                text = "Computers",
                color = TwTextSecondary,
                style = androidx.compose.material3.MaterialTheme.typography.labelLarge,
                modifier = Modifier.padding(start = 28.dp, top = 14.dp, end = 20.dp, bottom = 6.dp),
            )
            state.hosts.forEach { host ->
                NavigationDrawerItem(
                    label = { Text(host.displayName) },
                    selected = host.hostId == state.activeHostId,
                    onClick = { onHostSelected(host.hostId) },
                    icon = { Icon(Icons.Outlined.Devices, null) },
                    badge = { Text(host.status.name.lowercase().replace('_', ' ')) },
                    modifier = Modifier
                        .padding(horizontal = 12.dp)
                        .testTag("drawer_host_${host.hostId}"),
                )
            }
            HorizontalDivider(color = TwBorder, modifier = Modifier.padding(vertical = 10.dp))
        }
        NavigationDrawerItem(
            label = { Text("Refresh sessions") },
            selected = false,
            onClick = onRefresh,
            icon = { Icon(Icons.Outlined.Refresh, null) },
            modifier = Modifier.padding(horizontal = 12.dp).testTag("drawer_refresh"),
        )
        NavigationDrawerItem(
            label = { Text("Pair another computer") },
            selected = false,
            onClick = onPairing,
            icon = { Icon(Icons.Outlined.Devices, null) },
            modifier = Modifier.padding(horizontal = 12.dp).testTag("drawer_pairing"),
        )
        }
    }
}

@Composable
private fun SessionRoute(
    session: RelaySession,
    state: V2UiState,
    viewModel: V2ViewModel,
    onBack: () -> Unit,
    onHealth: () -> Unit,
    onTerminal: () -> Unit,
    autoFocusReply: Boolean,
) {
    val timelineFlow = remember(
        session.stableId,
        state.demoMode,
        state.relayStartupAdmission,
    ) {
        viewModel.timeline(session.stableId)
    }
    val timelineState by key(
        session.stableId,
        state.demoMode,
        state.relayStartupAdmission,
    ) {
        timelineFlow.collectAsStateWithLifecycle(
            initialValue = SessionTimelineState(
                events = emptyList(),
                agentEvidenceAvailability = when {
                    state.demoMode -> AgentEvidenceAvailability.AVAILABLE
                    state.relayStartupAdmission == RelayStartupAdmissionState.RELAY_V2 ->
                        AgentEvidenceAvailability.RELAY_V2_UNAVAILABLE
                    else -> AgentEvidenceAvailability.RELAY_V1_UNSUPPORTED
                },
            ),
        )
    }
    var showActions by rememberSaveable(session.stableId) { mutableStateOf(false) }
    var confirmEndSession by rememberSaveable(session.stableId) { mutableStateOf(false) }
    val context = LocalContext.current

    SessionDetailScreen(
        session = session,
        connectionStatus = state.health.overall,
        timelineState = timelineState,
        draft = state.drafts[session.stableId].orEmpty(),
        nowMillis = rememberNowMillis(),
        onDraftChange = { viewModel.updateDraft(session.stableId, it) },
        onBack = onBack,
        onConnectionStatusClick = onHealth,
        onOpenTerminal = onTerminal,
        onOverflowClick = { showActions = true },
        onSend = { viewModel.sendMessage(session, it) },
        autoFocusReply = autoFocusReply,
        agentStateAvailable =
            state.agentCapabilityAvailability == AgentCapabilityAvailability.AVAILABLE,
        onCancelMessage = viewModel::cancelMessage,
    )

    if (showActions) {
        ModalBottomSheet(
            onDismissRequest = { showActions = false },
            containerColor = TwSurface,
        ) {
            Text(
                session.title,
                color = TwTextPrimary,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp),
            )
            ListItem(
                headlineContent = { Text("Copy session identifier") },
                leadingContent = { Icon(Icons.Outlined.Link, null) },
                colors = ListItemDefaults.colors(containerColor = TwSurface),
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable {
                        copyText(context, "Session identifier", session.stableId)
                        showActions = false
                    }
                    .testTag("session_copy_id"),
            )
            HorizontalDivider(color = TwBorder)
            TextButton(
                onClick = {
                    showActions = false
                    confirmEndSession = true
                },
                modifier = Modifier.fillMaxWidth().testTag("session_kill"),
            ) {
                Icon(Icons.Outlined.DeleteOutline, null, tint = TwError)
                Spacer(Modifier.width(8.dp))
                Text("End session", color = TwError)
            }
            Spacer(Modifier.height(24.dp))
        }
    }

    if (confirmEndSession) {
        AlertDialog(
            onDismissRequest = { confirmEndSession = false },
            containerColor = TwSurface,
            title = { Text("End this session?", color = TwTextPrimary) },
            text = {
                Text(
                    "This ends the tmux session on ${session.hostName.ifBlank { "the paired computer" }}. Running work in that session will stop.",
                    color = TwTextSecondary,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmEndSession = false
                        viewModel.killSession(session)
                        onBack()
                    },
                    modifier = Modifier.testTag("confirm_end_session"),
                ) {
                    Text("End session", color = TwError)
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { confirmEndSession = false },
                    modifier = Modifier.testTag("cancel_end_session"),
                ) {
                    Text("Keep session", color = TwAccent)
                }
            },
        )
    }
}

@Composable
private fun NewWorktreeRoute(
    state: V2UiState,
    viewModel: V2ViewModel,
    onBack: () -> Unit,
) {
    var stepName by rememberSaveable { mutableStateOf(NewWorktreeStep.TARGET.name) }
    var hostId by rememberSaveable { mutableStateOf("") }
    var scopeId by rememberSaveable { mutableStateOf("") }
    var repositoryPath by rememberSaveable { mutableStateOf("") }
    var baseBranch by rememberSaveable { mutableStateOf("") }
    var aiCommand by rememberSaveable { mutableStateOf("codex") }
    var worktreeName by rememberSaveable { mutableStateOf("") }
    var errors by remember { mutableStateOf(NewWorktreeValidationErrors()) }
    val step = NewWorktreeStep.valueOf(stepName)
    val form = NewWorktreeForm(
        hostId = hostId,
        scopeId = scopeId,
        repositoryPath = repositoryPath,
        baseBranch = baseBranch,
        aiCommand = aiCommand,
        worktreeName = worktreeName,
    )
    val previousStep: () -> Unit = {
        stepName = when (step) {
            NewWorktreeStep.TARGET -> NewWorktreeStep.TARGET.name
            NewWorktreeStep.CONFIGURE -> NewWorktreeStep.TARGET.name
            NewWorktreeStep.REVIEW -> NewWorktreeStep.CONFIGURE.name
        }
    }

    BackHandler(enabled = step != NewWorktreeStep.TARGET) {
        if (!state.creatingWorktree) previousStep()
    }

    LaunchedEffect(Unit) { viewModel.clearActionError() }

    LaunchedEffect(state.hosts, hostId) {
        if (hostId.isBlank() || state.hosts.none { it.hostId == hostId }) {
            hostId = state.activeHostId
        }
    }
    LaunchedEffect(state.scopes, hostId, scopeId) {
        if (scopeId.isBlank() || state.scopes.none { it.hostId == hostId && it.scopeId == scopeId }) {
            scopeId = state.scopes.firstOrNull { it.hostId == hostId && it.reachable }?.scopeId.orEmpty()
        }
    }

    NewWorktreeScreen(
        step = step,
        form = form,
        hosts = state.hosts,
        scopes = state.scopes,
        isLoadingTargets = shouldShowTargetLoading(state),
        isCreating = state.creatingWorktree,
        validationErrors = errors,
        targetLoadError = state.health.errorMessage.takeIf(String::isNotBlank),
        creationError = state.actionError,
        onBack = onBack,
        onPreviousStep = previousStep,
        onNextStep = {
            when (step) {
                NewWorktreeStep.TARGET -> {
                    errors = NewWorktreeValidationErrors(
                        host = "Choose a computer".takeIf { hostId.isBlank() },
                        scope = "Choose an available scope".takeIf { scopeId.isBlank() },
                    )
                    if (errors.host == null && errors.scope == null) stepName = NewWorktreeStep.CONFIGURE.name
                }
                NewWorktreeStep.CONFIGURE -> {
                    errors = NewWorktreeValidationErrors(
                        repositoryPath = "Repository is required".takeIf { repositoryPath.isBlank() },
                        aiCommand = "Agent command is required".takeIf { aiCommand.isBlank() },
                        worktreeName = "Worktree name is required".takeIf { worktreeName.isBlank() },
                    )
                    if (!errors.hasConfigurationError()) stepName = NewWorktreeStep.REVIEW.name
                }
                NewWorktreeStep.REVIEW -> Unit
            }
        },
        onHostSelected = {
            hostId = it.hostId
            scopeId = ""
            errors = errors.copy(host = null, scope = null)
            viewModel.selectHost(it.hostId)
        },
        onScopeSelected = {
            scopeId = it.scopeId
            errors = errors.copy(scope = null)
        },
        onRepositoryPathChange = {
            repositoryPath = it
            errors = errors.copy(repositoryPath = null)
        },
        onBaseBranchChange = {
            baseBranch = it
            errors = errors.copy(baseBranch = null)
        },
        onAiCommandChange = {
            aiCommand = it
            errors = errors.copy(aiCommand = null)
        },
        onWorktreeNameChange = {
            worktreeName = it
            errors = errors.copy(worktreeName = null)
        },
        onRetryLoadTargets = viewModel::refresh,
        onCreate = {
            val looksLikePath = repositoryPath.startsWith("/") || repositoryPath.startsWith("~") ||
                repositoryPath.startsWith(".")
            viewModel.createWorktree(
                NewWorktreeRequest(
                    hostId = hostId,
                    scopeId = scopeId,
                    project = repositoryPath.takeUnless { looksLikePath }.orEmpty(),
                    path = repositoryPath.takeIf { looksLikePath }.orEmpty(),
                    name = worktreeName,
                    branch = baseBranch,
                    aiCommand = aiCommand,
                ),
            )
        },
    )
}

@Composable
private fun NewTerminalRoute(
    state: V2UiState,
    viewModel: V2ViewModel,
    onBack: () -> Unit,
) {
    var hostId by rememberSaveable { mutableStateOf("") }
    var scopeId by rememberSaveable { mutableStateOf("") }
    var workingDirectory by rememberSaveable { mutableStateOf("") }
    var label by rememberSaveable { mutableStateOf("") }
    var errors by remember { mutableStateOf(NewTerminalValidationErrors()) }

    BackHandler(enabled = state.creatingTerminal) { /* Creation result owns navigation. */ }

    LaunchedEffect(Unit) { viewModel.clearActionError() }
    LaunchedEffect(state.hosts, hostId) {
        if (hostId.isBlank() || state.hosts.none { it.hostId == hostId }) {
            hostId = state.activeHostId
        }
    }
    LaunchedEffect(state.scopes, hostId, scopeId) {
        if (scopeId.isBlank() || state.scopes.none { it.hostId == hostId && it.scopeId == scopeId }) {
            scopeId = state.scopes.firstOrNull { it.hostId == hostId && it.reachable }?.scopeId.orEmpty()
        }
    }

    NewTerminalScreen(
        form = NewTerminalForm(
            hostId = hostId,
            scopeId = scopeId,
            workingDirectory = workingDirectory,
            label = label,
        ),
        hosts = state.hosts,
        scopes = state.scopes,
        isLoadingTargets = shouldShowTargetLoading(state),
        isCreating = state.creatingTerminal,
        validationErrors = errors,
        targetLoadError = state.health.errorMessage.takeIf(String::isNotBlank),
        creationError = state.actionError,
        onBack = onBack,
        onHostSelected = {
            hostId = it.hostId
            scopeId = ""
            errors = errors.copy(host = null, scope = null)
            viewModel.selectHost(it.hostId)
        },
        onScopeSelected = {
            scopeId = it.scopeId
            errors = errors.copy(scope = null)
        },
        onWorkingDirectoryChange = {
            workingDirectory = it
            errors = errors.copy(workingDirectory = null)
        },
        onLabelChange = {
            label = it
            errors = errors.copy(label = null)
        },
        onRetryLoadTargets = viewModel::refresh,
        onCreate = {
            errors = NewTerminalValidationErrors(
                host = "Choose a computer".takeIf { hostId.isBlank() },
                scope = "Choose an available scope".takeIf { scopeId.isBlank() },
                workingDirectory = "Working directory is required".takeIf { workingDirectory.isBlank() },
            )
            if (errors.host == null && errors.scope == null && errors.workingDirectory == null) {
                viewModel.createTerminal(
                    hostId = hostId,
                    scopeId = scopeId,
                    workingDirectory = workingDirectory,
                    label = label,
                )
            }
        },
    )
}

@Composable
private fun TerminalRoute(
    session: RelaySession,
    state: V2UiState,
    viewModel: V2ViewModel,
    controller: TerminalWebViewController,
    onBack: () -> Unit,
    onHealth: () -> Unit,
) {
    var userReadOnly by rememberSaveable(session.stableId) { mutableStateOf(false) }
    var keyboardVisible by rememberSaveable(session.stableId) { mutableStateOf(true) }
    var fontSize by rememberSaveable(session.stableId) { mutableIntStateOf(14) }
    val connectionStatus = state.terminal.status
    val ownershipReadOnly = state.terminal.inputReadOnly
    val readOnly = userReadOnly || ownershipReadOnly

    LaunchedEffect(readOnly) { controller.setReadOnly(readOnly) }
    LaunchedEffect(fontSize) { controller.setFontSize(fontSize) }
    DisposableEffect(session.stableId) {
        onDispose { viewModel.closeTerminal() }
    }

    TerminalScreen(
        sessionTitle = session.title,
        connectionStatus = connectionStatus,
        isReadOnly = readOnly,
        keyboardVisible = keyboardVisible,
        terminalFontSizeSp = fontSize,
        disconnectReason = state.terminal.resetReason.ifBlank { state.health.errorMessage }.ifBlank { null },
        onBack = onBack,
        onConnectionStatusClick = onHealth,
        onReconnect = { viewModel.openTerminal(session, controller) },
        onToggleKeyboard = {
            keyboardVisible = !keyboardVisible
            if (keyboardVisible) controller.focus() else controller.blur()
        },
        onDecreaseFont = { fontSize = (fontSize - 1).coerceAtLeast(10) },
        onIncreaseFont = { fontSize = (fontSize + 1).coerceAtMost(24) },
        onToggleReadOnly = { if (!ownershipReadOnly) userReadOnly = !userReadOnly },
        terminalContent = {
            TerminalWebView(
                controller = controller,
                onReady = {
                    controller.setReadOnly(readOnly)
                    controller.setFontSize(fontSize)
                    controller.fit()
                    viewModel.openTerminal(session, controller)
                },
                onFailure = viewModel::reportTerminalError,
                onInput = { if (!readOnly) viewModel.sendTerminalInput(it) },
                onResize = viewModel::resizeTerminal,
                modifier = Modifier.fillMaxSize().focusRequester(remember { FocusRequester() }),
            )
        },
    )
}

@Composable
private fun MissingSession(onBack: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(Icons.Outlined.Terminal, null, tint = TwTextSecondary, modifier = Modifier.size(40.dp))
        Spacer(Modifier.height(16.dp))
        Text("This session is no longer available", color = TwTextPrimary)
        Spacer(Modifier.height(20.dp))
        OutlinedButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Outlined.ArrowBack, null)
            Spacer(Modifier.width(8.dp))
            Text("Back")
        }
    }
}

@Composable
private fun rememberNowMillis(): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            now = System.currentTimeMillis()
        }
    }
    return now
}

private fun RootDestination.route(): String = when (this) {
    RootDestination.INBOX -> V2Routes.INBOX
    RootDestination.WORKSPACES -> V2Routes.WORKSPACES
    RootDestination.SETTINGS -> V2Routes.SETTINGS
}

private fun encodeRouteValue(value: String): String = Base64.encodeToString(
    value.toByteArray(Charsets.UTF_8),
    Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
)

private fun decodeRouteValue(value: String): String = runCatching {
    String(Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING), Charsets.UTF_8)
}.getOrDefault("")

private fun copyText(context: Context, label: String, value: String) {
    val clipboard = context.getSystemService(ClipboardManager::class.java)
    clipboard.setPrimaryClip(ClipData.newPlainText(label, value))
}
