package com.tmuxworktree.mobile.app

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.tmuxworktree.mobile.core.data.AppPreferences
import com.tmuxworktree.mobile.core.data.NotificationKind
import com.tmuxworktree.mobile.core.data.OutboxInFlightMessage
import com.tmuxworktree.mobile.core.data.OutboxInFlightRegistry
import com.tmuxworktree.mobile.core.data.OutboxDispatchPlanner
import com.tmuxworktree.mobile.core.model.AgentState
import com.tmuxworktree.mobile.core.model.ConnectionHealth
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.DeliveryState
import com.tmuxworktree.mobile.core.model.DemoData
import com.tmuxworktree.mobile.core.model.HealthLayer
import com.tmuxworktree.mobile.core.model.RelayHost
import com.tmuxworktree.mobile.core.model.RelayScope
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.model.TerminalStreamState
import com.tmuxworktree.mobile.core.model.TimelineActor
import com.tmuxworktree.mobile.core.model.TimelineEvent
import com.tmuxworktree.mobile.core.model.TransportPhase
import com.tmuxworktree.mobile.core.relay.runtime.RelayClientEvent
import com.tmuxworktree.mobile.core.relay.runtime.RelayRequestKind
import com.tmuxworktree.mobile.core.relay.runtime.RelayV1ConnectionActor
import com.tmuxworktree.mobile.core.relay.runtime.RelayV1ConnectionConfig
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

internal fun shouldPersistRelaySelectedHost(
    preferredHostId: String,
    availableHostIds: Set<String>,
    selectedHostId: String,
): Boolean = selectedHostId.isNotBlank() &&
    selectedHostId != preferredHostId &&
    preferredHostId !in availableHostIds

class V2ViewModel(
    private val container: AppContainer,
    private val demoMode: Boolean = false,
    private val demoRecovering: Boolean = false,
) : ViewModel() {
    private val repository = container.repository
    private val preferencesStore = container.preferences
    private val credentials = container.credentials
    private val relay = RelayV1ConnectionActor(viewModelScope)
    private val outboxMutex = Mutex()
    private val inFlightMessages = OutboxInFlightRegistry()
    private val profileMutationMutex = Mutex()
    private val disconnectBarriers = mutableMapOf<String, CompletableDeferred<Unit>>()

    private val _uiState = MutableStateFlow(initialState())
    val uiState = _uiState.asStateFlow()

    private val normalEffectSlots = Semaphore(MAX_PENDING_UI_EFFECTS)
    private val effectInputChannel = Channel<QueuedUiEffect>(
        MAX_PENDING_UI_EFFECTS + MAX_PENDING_CRITICAL_UI_EFFECTS,
    )
    private val effectChannel = Channel<V2UiEffect>(MAX_PENDING_UI_EFFECTS)
    val effects: Flow<V2UiEffect> = effectChannel.receiveAsFlow()

    private var rawHealth = if (demoMode) DemoData.health(recovering = demoRecovering) else ConnectionHealth()
    private var connectedConfigKey: String? = null
    private var persistedSnapshotRevision = 0L
    private var outboxRetryJob: Job? = null
    private var outboxRetryAttempt = 0
    private var activeNetworkHandle: Long? = null
    private var credentialRecoveryNotified = false
    private var effectsClosed = false
    private var profileMutationInProgress = false
    private var profileExpectationInitialized = false
    private var expectedRelayUrl: String? = null

    init {
        startEffectForwarder()
        if (!demoMode) startRealApp()
    }

    fun timeline(sessionId: String): Flow<List<TimelineEvent>> = if (demoMode) {
        uiState.map { state -> state.demoTimelines[sessionId].orEmpty() }
    } else {
        repository.timeline(sessionId)
    }

    fun setPairingRelayUrl(value: String) {
        _uiState.update {
            it.copy(
                pairingRelayUrl = value,
                pairingRelayUrlError = validateRelayUrl(value),
                pairingError = null,
            )
        }
    }

    fun setPairingToken(value: String) {
        _uiState.update { it.copy(pairingToken = value, pairingError = null) }
    }

    fun reportPairingError(message: String) {
        _uiState.update { it.copy(pairingError = message, isConnecting = false) }
    }

    fun reportTerminalError(message: String) {
        emit(V2UiEffect.Notice(message))
    }

    fun applyPairingPayload(payload: PairingPayload) {
        _uiState.update { state ->
            val importedRelayUrl = payload.relayUrl.ifBlank { state.pairingRelayUrl }
            state.copy(
                pairingRelayUrl = importedRelayUrl,
                pairingToken = payload.token.ifBlank { state.pairingToken },
                pairingHostId = payload.hostId.ifBlank { state.pairingHostId },
                pairingRequired = true,
                pairingRelayUrlError = validateRelayUrl(importedRelayUrl),
                pairingError = null,
            )
        }
    }

    fun showPairing() {
        _uiState.update {
            it.copy(
                pairingRequired = true,
                pairingToken = "",
                pairingRelayUrlError = it.pairingRelayUrl
                    .takeIf(String::isNotBlank)
                    ?.let(::validateRelayUrl),
                pairingError = null,
            )
        }
    }

    fun dismissPairing(): Boolean {
        if (!_uiState.value.paired) return false
        _uiState.update {
            it.copy(
                pairingRequired = false,
                pairingRelayUrlError = null,
                pairingError = null,
            )
        }
        return true
    }

    fun forgetPairing() {
        if (demoMode) {
            _uiState.update { it.copy(paired = false, pairingRequired = true, pairingToken = "") }
            return
        }
        viewModelScope.launch {
            runCatching {
                mutateProfile(expectedUrl = null) {
                    disconnectRelayAndDrain()
                    connectedConfigKey = null
                    outboxRetryJob?.cancel()
                    inFlightMessages.clear()
                    preferencesStore.clearProfile()
                    credentials.clear()
                    repository.clearProfileData()
                    persistedSnapshotRevision = 0
                    val clearedPreferences = preferencesStore.values.first { it.relayUrl.isBlank() }
                    _uiState.update {
                        it.copy(
                            paired = false,
                            pairingRequired = true,
                            pairingRelayUrl = "",
                            pairingToken = "",
                            pairingHostId = "",
                            pairingRelayUrlError = null,
                            pairingError = null,
                            confirmProfileSwitch = false,
                            preferences = clearedPreferences,
                            hosts = emptyList(),
                            scopes = emptyList(),
                            sessions = emptyList(),
                            drafts = emptyMap(),
                            terminal = TerminalStreamState(),
                            selectedScopeId = null,
                        )
                    }
                    emitAwait(V2UiEffect.ProfileCleared)
                }
            }.onFailure { error ->
                emit(V2UiEffect.Notice(error.message ?: "Could not forget the pairing"))
            }
        }
    }

    fun connectPairing() {
        if (demoMode) {
            _uiState.update { it.copy(pairingRequired = false, paired = true) }
            return
        }
        val current = _uiState.value
        val relayUrlInput = current.pairingRelayUrl.trim()
        val token = current.pairingToken.trim()
        val relayUrlError = validateRelayUrl(relayUrlInput)
        if (relayUrlError != null) {
            _uiState.update {
                it.copy(
                    pairingRelayUrlError = relayUrlError,
                    pairingError = null,
                    isConnecting = false,
                )
            }
            return
        }
        val relayUrl = PairingInputValidator.normalizeRelayUrl(relayUrlInput)
        val credentialError = PairingInputValidator.credentialError(
            token,
            current.pairingHostId,
        )
        if (credentialError != null) {
            _uiState.update {
                it.copy(
                    pairingRelayUrlError = null,
                    pairingError = credentialError,
                    isConnecting = false,
                )
            }
            return
        }

        val hostId = current.pairingHostId.trim()
        val existingProfile = current.hasStoredProfile || credentials.hasCredential()
        val changesExistingProfile = existingProfile && (
            PairingInputValidator.normalizeRelayUrl(current.preferences.relayUrl) != relayUrl ||
                current.preferences.preferredHostId != hostId ||
                credentials.read() != token
            )
        if (changesExistingProfile) {
            _uiState.update {
                it.copy(
                    confirmProfileSwitch = true,
                    pairingRelayUrlError = null,
                    pairingError = null,
                )
            }
            return
        }

        // Even a nominally first pairing starts from an empty credential-bound
        // database. This also prevents orphaned outbox rows from a damaged old
        // profile crossing into a new Relay when no readable credential remains.
        persistPairing(
            relayUrl,
            hostId,
            token,
            clearExistingProfile = !current.paired,
        )
    }

    fun confirmProfileSwitch() {
        val current = _uiState.value
        val relayUrlInput = current.pairingRelayUrl.trim()
        val token = current.pairingToken.trim()
        val hostId = current.pairingHostId.trim()
        val relayUrlError = validateRelayUrl(relayUrlInput)
        if (relayUrlError != null) {
            _uiState.update {
                it.copy(
                    confirmProfileSwitch = false,
                    pairingRelayUrlError = relayUrlError,
                    pairingError = null,
                )
            }
            return
        }
        val relayUrl = PairingInputValidator.normalizeRelayUrl(relayUrlInput)
        val credentialError = PairingInputValidator.credentialError(token, hostId)
        if (credentialError != null) {
            _uiState.update {
                it.copy(
                    confirmProfileSwitch = false,
                    pairingRelayUrlError = null,
                    pairingError = credentialError,
                )
            }
            return
        }
        _uiState.update { it.copy(confirmProfileSwitch = false) }
        persistPairing(relayUrl, hostId, token, clearExistingProfile = true)
    }

    fun cancelProfileSwitch() {
        _uiState.update { it.copy(confirmProfileSwitch = false) }
    }

    private fun persistPairing(
        relayUrl: String,
        hostId: String,
        token: String,
        clearExistingProfile: Boolean,
    ) {

        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isConnecting = true,
                    pairingRelayUrlError = null,
                    pairingError = null,
                )
            }
            try {
                mutateProfile(expectedUrl = relayUrl) {
                    if (clearExistingProfile) {
                        disconnectRelayAndDrain()
                        connectedConfigKey = null
                        outboxRetryJob?.cancel()
                        inFlightMessages.clear()
                        // A process death during a switch can only leave the app
                        // unpaired, never with a new secret bound to the old URL.
                        preferencesStore.clearProfile()
                        credentials.clear()
                        repository.clearProfileData()
                        persistedSnapshotRevision = 0
                        _uiState.update {
                            it.copy(
                                paired = false,
                                drafts = emptyMap(),
                                terminal = TerminalStreamState(),
                                selectedScopeId = null,
                                hosts = emptyList(),
                                scopes = emptyList(),
                                sessions = emptyList(),
                            )
                        }
                        emitAwait(V2UiEffect.ProfileCleared)
                    }
                    credentials.write(token)
                    preferencesStore.saveProfile(
                        relayUrl = relayUrl,
                        hostId = hostId,
                        autoConnect = true,
                    )
                    val savedPreferences = preferencesStore.values.first {
                        PairingInputValidator.normalizeRelayUrl(it.relayUrl) == relayUrl &&
                            it.preferredHostId == hostId
                    }
                    _uiState.update {
                        it.copy(
                            paired = true,
                            pairingRequired = false,
                            pairingRelayUrl = relayUrl,
                            pairingToken = "",
                            pairingHostId = hostId,
                            pairingRelayUrlError = null,
                            pairingError = null,
                            isConnecting = true,
                            preferences = savedPreferences,
                        )
                    }
                }
                connectedConfigKey = null
                connectActiveProfile(force = true)
            } catch (_: Throwable) {
                runCatching {
                    mutateProfile(expectedUrl = null) {
                        disconnectRelayAndDrain()
                        connectedConfigKey = null
                        inFlightMessages.clear()
                        preferencesStore.clearProfile()
                        credentials.clear()
                        repository.clearProfileData()
                        emitAwait(V2UiEffect.ProfileCleared)
                    }
                }
                _uiState.update {
                    it.copy(
                        paired = false,
                        pairingRequired = true,
                        isConnecting = false,
                        pairingRelayUrlError = validateRelayUrl(relayUrl),
                        pairingError = "Could not save the connection",
                        preferences = it.preferences.copy(
                            relayUrl = "",
                            preferredHostId = "",
                            preferredScopeId = "local",
                            autoConnect = false,
                        ),
                        hosts = emptyList(),
                        scopes = emptyList(),
                        sessions = emptyList(),
                        drafts = emptyMap(),
                        terminal = TerminalStreamState(),
                    )
                }
            }
        }
    }

    fun retryConnection() {
        if (demoMode) return
        connectedConfigKey = null
        connectActiveProfile(force = true)
    }

    fun refresh() {
        val hostId = selectedHostId()
        relay.refreshHosts()
        if (hostId.isNotBlank()) {
            relay.refreshSessions(hostId)
            relay.refreshScopes(hostId)
        }
    }

    fun selectScope(scopeId: String?) {
        _uiState.update { it.copy(selectedScopeId = scopeId) }
        refreshDecoratedHealth()
        viewModelScope.launch { preferencesStore.setPreferredScope(scopeId ?: DEFAULT_SCOPE_ID) }
    }

    fun selectHost(hostId: String) {
        val normalized = hostId.trim()
        if (normalized.isBlank()) return
        val currentHost = selectedHostId()
        _uiState.update { state ->
            state.copy(
                preferences = state.preferences.copy(preferredHostId = normalized),
                selectedScopeId = null,
            )
        }
        refreshDecoratedHealth()
        viewModelScope.launch {
            preferencesStore.setPreferredHostAndScope(normalized, DEFAULT_SCOPE_ID)
            if (
                rawHealth.overall == ConnectionStatus.ONLINE &&
                (normalized == currentHost || !_uiState.value.preferences.autoConnect)
            ) {
                relay.refreshSessions(normalized)
                relay.refreshScopes(normalized)
            }
        }
    }

    fun updateDraft(sessionId: String, value: String) {
        _uiState.update { state ->
            state.copy(drafts = state.drafts.toMutableMap().apply { put(sessionId, value) })
        }
    }

    fun sendMessage(session: RelaySession, body: String) {
        val normalized = body.trim()
        if (normalized.isBlank()) return
        if (demoMode) {
            val now = System.currentTimeMillis()
            _uiState.update { state ->
                val event = TimelineEvent(
                    eventId = "demo-user-${UUID.randomUUID()}",
                    sessionId = session.stableId,
                    actor = TimelineActor.USER,
                    body = normalized,
                    createdAtMillis = now,
                    deliveryState = DeliveryState.SUCCEEDED,
                )
                state.copy(
                    drafts = state.drafts - session.stableId,
                    demoTimelines = state.demoTimelines +
                        (session.stableId to (state.demoTimelines[session.stableId].orEmpty() + event)),
                )
            }
            return
        }

        viewModelScope.launch {
            runCatching {
                repository.enqueueAgentMessage(session.hostId, session.name, normalized)
            }.onSuccess {
                // Clear only after the durable Room transaction succeeds.
                _uiState.update { state -> state.copy(drafts = state.drafts - session.stableId) }
                flushOutbox()
            }.onFailure { error ->
                _uiState.update { it.copy(actionError = error.message ?: "Message was not queued") }
                emit(V2UiEffect.Notice("Message was not queued"))
            }
        }
    }

    fun cancelMessage(event: TimelineEvent) {
        val commandId = event.eventId.removePrefix(OUTBOX_EVENT_PREFIX)
        if (commandId == event.eventId || event.deliveryState !in CANCELLABLE_DELIVERY_STATES) return
        viewModelScope.launch {
            if (repository.cancelOutboxMessage(commandId)) {
                flushOutbox()
            }
        }
    }

    fun createWorktree(request: NewWorktreeRequest) {
        val hostId = request.hostId.ifBlank { selectedHostId() }
        if (hostId.isBlank()) {
            _uiState.update { it.copy(actionError = "No connected host is available") }
            return
        }
        if (request.aiCommand.isBlank()) {
            _uiState.update { it.copy(actionError = "Choose an agent command") }
            return
        }
        if (demoMode) {
            val session = RelaySession(
                hostId = hostId,
                hostName = _uiState.value.hosts.firstOrNull { it.hostId == hostId }?.displayName ?: hostId,
                name = request.name.ifBlank { "new-worktree" },
                rawName = request.name.ifBlank { "new-worktree" },
                scopeId = request.scopeId.ifBlank { "local" },
                scopeLabel = request.scopeId.ifBlank { "local" },
                project = request.project,
                branch = request.branch,
                agentState = AgentState.RUNNING,
                summary = "Starting ${request.aiCommand}",
                activityAtSeconds = System.currentTimeMillis() / 1_000,
            )
            _uiState.update { it.copy(sessions = listOf(session) + it.sessions, creatingWorktree = false) }
            emit(V2UiEffect.NavigateToSession(session.stableId))
            return
        }

        _uiState.update { it.copy(creatingWorktree = true, actionError = null) }
        relay.createWorktree(
            hostId = hostId,
            scopeId = request.scopeId.ifBlank { "local" },
            project = request.project.takeIf(String::isNotBlank),
            path = request.path.takeIf(String::isNotBlank),
            name = request.name.takeIf(String::isNotBlank),
            branch = request.branch.takeIf(String::isNotBlank),
            aiCommand = request.aiCommand,
        )
    }

    fun createTerminal(
        hostId: String,
        scopeId: String,
        workingDirectory: String,
        label: String,
    ) {
        val selectedHost = hostId.ifBlank { selectedHostId() }
        if (selectedHost.isBlank()) {
            _uiState.update { it.copy(actionError = "No connected host is available") }
            return
        }
        if (workingDirectory.isBlank()) {
            _uiState.update { it.copy(actionError = "Working directory is required") }
            return
        }
        if (demoMode) {
            val session = RelaySession(
                hostId = selectedHost,
                hostName = _uiState.value.hosts.firstOrNull { it.hostId == selectedHost }?.displayName
                    ?: selectedHost,
                name = "tw-term-${UUID.randomUUID().toString().take(5)}",
                rawName = "tw-term-demo",
                scopeId = scopeId.ifBlank { "local" },
                scopeLabel = scopeId.ifBlank { "local" },
                kind = "terminal",
                label = label.ifBlank { workingDirectory.substringAfterLast('/').ifBlank { "Terminal" } },
                cwd = workingDirectory,
                agentState = AgentState.UNKNOWN,
                activityAtSeconds = System.currentTimeMillis() / 1_000,
            )
            _uiState.update { it.copy(sessions = listOf(session) + it.sessions, creatingTerminal = false) }
            emit(V2UiEffect.NavigateToTerminal(session.stableId))
            return
        }
        _uiState.update { it.copy(creatingTerminal = true, actionError = null) }
        relay.createTerminal(
            hostId = selectedHost,
            scopeId = scopeId.ifBlank { "local" },
            cwd = workingDirectory.trim(),
            label = label.trim(),
        )
    }

    fun killSession(session: RelaySession) {
        if (demoMode) {
            _uiState.update { it.copy(sessions = it.sessions.filterNot { row -> row.stableId == session.stableId }) }
        } else {
            relay.killSession(session.hostId, session.name)
        }
    }

    fun openTerminal(session: RelaySession) {
        if (demoMode) {
            _uiState.update {
                it.copy(
                    terminal = TerminalStreamState(
                        streamId = "demo-terminal",
                        sessionId = session.stableId,
                        status = ConnectionStatus.ONLINE,
                    ),
                )
            }
            emit(V2UiEffect.TerminalReset("Connected to ${session.title}\r\n"))
            emit(V2UiEffect.TerminalWrite("\u001b[32m${session.hostName}\u001b[0m:${session.cwd.ifBlank { "~" }}$ "))
        } else {
            relay.openTerminal(session.hostId, session.name)
        }
    }

    fun closeTerminal() {
        if (!demoMode) relay.closeTerminal()
    }

    fun sendTerminalInput(data: String) {
        if (demoMode) {
            emit(V2UiEffect.TerminalWrite(data))
        } else {
            relay.sendTerminalInput(data)
        }
    }

    fun resizeTerminal(cols: Int, rows: Int) {
        if (!demoMode) relay.resizeTerminal(cols, rows)
    }

    fun setNotificationPreference(kind: NotificationKind, enabled: Boolean) {
        if (demoMode) {
            _uiState.update { state ->
                val preferences = when (kind) {
                    NotificationKind.WAITING_FOR_USER -> state.preferences.copy(waitingNotifications = enabled)
                    NotificationKind.FAILED -> state.preferences.copy(failedNotifications = enabled)
                    NotificationKind.COMPLETED -> state.preferences.copy(completedNotifications = enabled)
                }
                state.copy(preferences = preferences)
            }
        } else {
            viewModelScope.launch { preferencesStore.setNotificationPreference(kind, enabled) }
        }
    }

    fun setDarkThemeEnabled(enabled: Boolean) {
        if (demoMode) {
            _uiState.update { state ->
                state.copy(preferences = state.preferences.copy(darkThemeEnabled = enabled))
            }
        } else {
            viewModelScope.launch { preferencesStore.setDarkThemeEnabled(enabled) }
        }
    }

    fun diagnostics(): String {
        val state = _uiState.value
        return buildString {
            appendLine("tmux-worktree Android ${com.tmuxworktree.mobile.BuildConfig.VERSION_NAME}")
            appendLine("transport=${state.health.phase}")
            appendLine("status=${state.health.overall}")
            appendLine("network=${if (state.networkAvailable) "available" else "unavailable"}")
            appendLine("hosts=${state.hosts.size}, scopes=${state.scopes.size}, sessions=${state.sessions.size}")
            appendLine("attempt=${state.health.attempt}")
            appendLine("errorCode=${state.health.errorCode.ifBlank { "none" }}")
            appendLine("protocol=${state.health.protocolLabel}")
        }.trim()
    }

    fun clearActionError() {
        _uiState.update { it.copy(actionError = null) }
    }

    override fun onCleared() {
        relay.close()
        effectsClosed = true
        effectInputChannel.close()
        effectChannel.close()
        super.onCleared()
    }

    private fun initialState(): V2UiState {
        if (!demoMode) return V2UiState()
        val sessions = DemoData.sessions()
        return V2UiState(
            initialized = true,
            demoMode = true,
            paired = true,
            preferences = AppPreferences(
                relayUrl = "wss://relay.example.com",
                preferredHostId = "mac-admin",
                autoConnect = true,
            ),
            pairingRelayUrl = "wss://relay.example.com",
            hosts = DemoData.hosts(),
            scopes = DemoData.scopes(),
            sessions = sessions,
            health = DemoData.health(recovering = demoRecovering),
            demoTimelines = sessions.associate { it.stableId to DemoData.timeline(it.stableId) },
        )
    }

    private suspend fun <T> mutateProfile(
        expectedUrl: String?,
        block: suspend () -> T,
    ): T = profileMutationMutex.withLock {
        profileMutationInProgress = true
        profileExpectationInitialized = true
        expectedRelayUrl = expectedUrl?.let(PairingInputValidator::normalizeRelayUrl)
        try {
            block()
        } finally {
            profileMutationInProgress = false
        }
    }

    private suspend fun disconnectRelayAndDrain() {
        val barrierId = "profile-${UUID.randomUUID()}"
        val drained = CompletableDeferred<Unit>()
        disconnectBarriers[barrierId] = drained
        relay.disconnectAndAwait(barrierId)
        val completed = withTimeoutOrNull(PROFILE_DRAIN_TIMEOUT_MILLIS) { drained.await() } != null
        disconnectBarriers.remove(barrierId)
        check(completed) { "Timed out while draining the previous connection" }
    }

    private fun preferenceMatchesExpectedProfile(preferences: AppPreferences): Boolean {
        if (!profileExpectationInitialized) return true
        return PairingInputValidator.normalizeRelayUrl(preferences.relayUrl) ==
            expectedRelayUrl.orEmpty()
    }

    private fun clearUnreadableProfile(observedRelayUrl: String) {
        if (credentialRecoveryNotified) return
        credentialRecoveryNotified = true
        viewModelScope.launch {
            profileMutationMutex.withLock {
                val latest = preferencesStore.values.first()
                if (PairingInputValidator.normalizeRelayUrl(latest.relayUrl) !=
                    PairingInputValidator.normalizeRelayUrl(observedRelayUrl) ||
                    (latest.relayUrl.isNotBlank() && !credentials.read().isNullOrBlank())
                ) {
                    credentialRecoveryNotified = false
                    return@withLock
                }
                profileMutationInProgress = true
                profileExpectationInitialized = true
                expectedRelayUrl = null
                try {
                    disconnectRelayAndDrain()
                    connectedConfigKey = null
                    inFlightMessages.clear()
                    preferencesStore.clearProfile()
                    credentials.clear()
                    repository.clearProfileData()
                    persistedSnapshotRevision = 0
                    _uiState.update {
                        it.copy(
                            paired = false,
                            pairingRequired = true,
                            pairingRelayUrl = "",
                            pairingToken = "",
                            pairingHostId = "",
                            pairingRelayUrlError = null,
                            preferences = it.preferences.copy(
                                relayUrl = "",
                                preferredHostId = "",
                                preferredScopeId = "local",
                                autoConnect = false,
                            ),
                            hosts = emptyList(),
                            scopes = emptyList(),
                            sessions = emptyList(),
                            drafts = emptyMap(),
                            terminal = TerminalStreamState(),
                            selectedScopeId = null,
                        )
                    }
                    emitAwait(V2UiEffect.ProfileCleared)
                    emit(V2UiEffect.Notice("The saved pairing credential is no longer readable. Pair again."))
                } finally {
                    profileMutationInProgress = false
                }
            }
        }
    }

    private fun startRealApp() {
        viewModelScope.launch {
            runCatching { container.legacyIdentityImporter.importIfNeeded() }
                .onFailure { emit(V2UiEffect.Notice("Existing connection could not be migrated")) }
            runCatching { reconcileInterruptedOutbox() }
                .onFailure {
                    emit(V2UiEffect.Notice("Local cache could not be fully recovered"))
                }
            launchCollectors()
        }
    }

    private fun startEffectForwarder() {
        viewModelScope.launch {
            for (queued in effectInputChannel) {
                val forwarded = runCatching { effectChannel.send(queued.effect) }.isSuccess
                if (queued.usesNormalSlot) normalEffectSlots.release()
                if (!forwarded) break
            }
        }
    }

    private fun launchCollectors() {
        viewModelScope.launch {
            preferencesStore.values.collect { preferences ->
                if (!profileExpectationInitialized) {
                    profileExpectationInitialized = true
                    expectedRelayUrl = PairingInputValidator
                        .normalizeRelayUrl(preferences.relayUrl)
                        .ifBlank { null }
                }
                if (profileMutationInProgress || !preferenceMatchesExpectedProfile(preferences)) {
                    return@collect
                }
                val credential = runCatching { credentials.read() }.getOrNull()
                val paired = preferences.relayUrl.isNotBlank() && !credential.isNullOrBlank()
                if (paired) {
                    credentialRecoveryNotified = false
                } else if (preferences.relayUrl.isNotBlank() || credentials.hasCredential()) {
                    clearUnreadableProfile(preferences.relayUrl)
                }
                _uiState.update { state ->
                    state.copy(
                        initialized = true,
                        paired = paired,
                        pairingRequired = state.pairingRequired || !paired,
                        pairingRelayUrl = state.pairingRelayUrl.ifBlank { preferences.relayUrl },
                        pairingHostId = state.pairingHostId.ifBlank { preferences.preferredHostId },
                        pairingRelayUrlError = state.pairingRelayUrlError
                            ?: preferences.relayUrl
                                .takeIf { !paired && it.isNotBlank() }
                                ?.let(::validateRelayUrl),
                        preferences = preferences,
                        selectedScopeId = state.selectedScopeId ?: preferences.preferredScopeId.takeUnless { it == "local" },
                    )
                }
                refreshDecoratedHealth()
                if (paired && preferences.autoConnect && _uiState.value.networkAvailable) {
                    connectActiveProfile()
                }
            }
        }

        viewModelScope.launch {
            repository.hosts.collect { hosts ->
                _uiState.update { it.copy(hosts = hosts) }
                refreshDecoratedHealth()
            }
        }
        viewModelScope.launch {
            repository.scopes.collect { scopes ->
                _uiState.update { it.copy(scopes = scopes) }
                refreshDecoratedHealth()
            }
        }
        viewModelScope.launch {
            repository.sessions.collect { sessions -> _uiState.update { it.copy(sessions = sessions) } }
        }
        viewModelScope.launch {
            relay.health.collect { health ->
                val wasOnline = rawHealth.overall == ConnectionStatus.ONLINE
                rawHealth = health
                _uiState.update {
                    it.copy(
                        isConnecting = health.overall == ConnectionStatus.CONNECTING,
                        pairingRequired = it.pairingRequired || health.overall == ConnectionStatus.AUTH_REQUIRED,
                        pairingError = if (health.overall == ConnectionStatus.AUTH_REQUIRED) {
                            health.errorMessage.ifBlank { "The pairing token was rejected" }
                        } else {
                            it.pairingError
                        },
                    )
                }
                refreshDecoratedHealth()
                if (wasOnline && health.overall != ConnectionStatus.ONLINE) markInFlightAmbiguous()
                if (health.overall == ConnectionStatus.ONLINE) {
                    outboxRetryJob?.cancel()
                    outboxRetryAttempt = 0
                    _uiState.update {
                        it.copy(
                            pairingRequired = false,
                            pairingRelayUrlError = null,
                            pairingError = null,
                            isConnecting = false,
                        )
                    }
                    flushOutbox()
                }
            }
        }
        viewModelScope.launch {
            relay.terminal.collect { terminal -> _uiState.update { it.copy(terminal = terminal) } }
        }
        viewModelScope.launch { relay.events.collect(::handleRelayEvent) }
        viewModelScope.launch {
            while (true) {
                delay(OUTBOX_EXPIRY_POLL_MILLIS)
                runCatching { repository.expireOutboxMessages() }
                    .onSuccess { expired ->
                        if (expired > 0 && rawHealth.overall == ConnectionStatus.ONLINE) flushOutbox()
                    }
                    .onFailure { emit(V2UiEffect.Notice("Queued message expiry could not be refreshed")) }
            }
        }
        viewModelScope.launch {
            container.networkMonitor.state.collect { network ->
                val available = network.available
                val changed = available != _uiState.value.networkAvailable
                val networkChanged = available && network.networkHandle != activeNetworkHandle
                activeNetworkHandle = network.networkHandle
                _uiState.update { it.copy(networkAvailable = available) }
                refreshDecoratedHealth()
                if (available) {
                    if ((changed || networkChanged) && _uiState.value.preferences.autoConnect) {
                        connectedConfigKey = null
                        connectActiveProfile(force = true)
                    }
                } else if (changed) {
                    connectedConfigKey = null
                    relay.pauseForNetwork()
                    markInFlightAmbiguous()
                }
            }
        }
    }

    private fun connectActiveProfile(force: Boolean = false) {
        val state = _uiState.value
        if (!state.networkAvailable) return
        val relayUrl = state.preferences.relayUrl.ifBlank { state.pairingRelayUrl }
        val token = credentials.read().orEmpty()
        if (relayUrl.isBlank() || token.isBlank()) return
        val hostId = state.activeHostId.ifBlank { state.pairingHostId }
        val relayUrlError = validateRelayUrl(relayUrl)
        val credentialError = PairingInputValidator.credentialError(token, hostId)
        if (relayUrlError != null || credentialError != null) {
            connectedConfigKey = null
            relay.disconnect()
            _uiState.update {
                it.copy(
                    pairingRequired = true,
                    pairingRelayUrl = relayUrl,
                    pairingHostId = hostId,
                    pairingRelayUrlError = relayUrlError?.let {
                        "Saved connection needs review: $it"
                    },
                    pairingError = credentialError?.let {
                        "Saved connection needs review: $it"
                    },
                    isConnecting = false,
                )
            }
            return
        }
        val configKey = "$relayUrl|$hostId|${token.hashCode()}"
        if (!force && configKey == connectedConfigKey && rawHealth.phase != TransportPhase.STOPPED) return
        connectedConfigKey = configKey
        relay.connect(RelayV1ConnectionConfig(relayUrl, token, hostId))
    }

    private suspend fun handleRelayEvent(event: RelayClientEvent) {
        when (event) {
            is RelayClientEvent.Disconnected -> {
                event.barrierId?.let { disconnectBarriers.remove(it)?.complete(Unit) }
            }
            is RelayClientEvent.AgentMessageSent -> {
                val inFlight = inFlightMessages.resolveAcknowledgement(
                    requestId = event.requestId,
                    hostId = event.hostId,
                    sessionName = event.sessionName,
                ) ?: return
                outboxRetryAttempt = 0
                transitionOutboxSafely(inFlight.commandId, DeliveryState.SUCCEEDED)
                flushOutbox()
            }
            is RelayClientEvent.WorktreeCreated -> {
                repository.upsertSession(event.session)
                _uiState.update { it.copy(creatingWorktree = false, actionError = null) }
                emitAwait(V2UiEffect.NavigateToSession(event.session.stableId))
            }
            is RelayClientEvent.TerminalCreated -> {
                repository.upsertSession(event.session)
                _uiState.update { it.copy(creatingTerminal = false, actionError = null) }
                emitAwait(V2UiEffect.NavigateToTerminal(event.session.stableId))
            }
            is RelayClientEvent.SessionKilled -> {
                if (event.hostId.isNotBlank() && event.sessionName.isNotBlank()) {
                    repository.removeSession(event.hostId, event.sessionName)
                }
            }
            is RelayClientEvent.TerminalOpening -> if (event.resetDisplay) {
                emitAwait(V2UiEffect.TerminalReset())
            }
            is RelayClientEvent.TerminalData -> emitAwait(V2UiEffect.TerminalWrite(event.data))
            is RelayClientEvent.TerminalExit -> emit(
                V2UiEffect.Notice("Terminal closed${event.code?.let { " (code $it)" }.orEmpty()}"),
            )
            is RelayClientEvent.TerminalReconnecting -> emit(
                V2UiEffect.Notice("Terminal reconnecting"),
            )
            is RelayClientEvent.Error -> {
                if (event.request?.kind == RelayRequestKind.SEND_AGENT_MESSAGE) {
                    val inFlight = inFlightMessages.remove(event.request.requestId)
                    if (inFlight != null) {
                        val final = event.message.contains("auth", ignoreCase = true) ||
                            event.message.contains("not found", ignoreCase = true) ||
                            event.message.startsWith("[input-ownership:", ignoreCase = true)
                        transitionOutboxSafely(
                            inFlight.commandId,
                            if (final) DeliveryState.FAILED_FINAL else DeliveryState.AMBIGUOUS,
                            event.message,
                        )
                        flushOutbox()
                    }
                } else {
                    _uiState.update {
                        it.copy(
                            creatingWorktree = false,
                            creatingTerminal = false,
                            actionError = event.message,
                        )
                    }
                    emit(V2UiEffect.Notice(event.message))
                }
            }
            is RelayClientEvent.AuthRequired -> {
                _uiState.update {
                    it.copy(
                        pairingRequired = true,
                        pairingToken = "",
                        pairingRelayUrlError = null,
                        pairingError = event.message,
                        isConnecting = false,
                    )
                }
            }
            is RelayClientEvent.CommandRejected -> {
                if (event.type == "send_agent_message") {
                    val pending = event.request?.requestId?.let(inFlightMessages::remove)
                    if (pending != null) {
                        val definitelyUnwritten = event.reason.contains(
                            "command was not written",
                            ignoreCase = true,
                        ) || event.reason.contains(
                            "before it was written",
                            ignoreCase = true,
                        )
                        val deliveryState = if (definitelyUnwritten) {
                            DeliveryState.FAILED_RETRYABLE
                        } else {
                            DeliveryState.AMBIGUOUS
                        }
                        transitionOutboxSafely(pending.commandId, deliveryState, event.reason)
                        if (deliveryState == DeliveryState.FAILED_RETRYABLE) scheduleOutboxRetry()
                        else flushOutbox()
                    }
                } else {
                    val kind = event.request?.kind
                    _uiState.update {
                        it.copy(
                            creatingWorktree = if (kind == null || kind == RelayRequestKind.CREATE_WORKTREE) {
                                false
                            } else {
                                it.creatingWorktree
                            },
                            creatingTerminal = if (kind == null || kind == RelayRequestKind.CREATE_TERMINAL) {
                                false
                            } else {
                                it.creatingTerminal
                            },
                            actionError = event.reason,
                        )
                    }
                    emit(V2UiEffect.Notice(event.reason))
                }
            }
            is RelayClientEvent.ProtocolWarning -> Unit
            is RelayClientEvent.Ready -> Unit
            is RelayClientEvent.SnapshotUpdated -> {
                val snapshot = relay.snapshots.value
                if (snapshot.revision == 0L) return
                persistedSnapshotRevision = snapshot.revision
                runCatching {
                    when (event.kind) {
                        RelayRequestKind.HOSTS -> {
                            // Hosts arrive before session/scope responses. Persist only
                            // the host dimension so cached lists remain visible until
                            // their own complete responses arrive.
                            repository.replaceHosts(snapshot.hosts)
                            val selectedHost = snapshot.selectedHostId
                            val preferredHost = _uiState.value.preferences.preferredHostId
                            if (shouldPersistRelaySelectedHost(
                                    preferredHostId = preferredHost,
                                    availableHostIds = snapshot.hosts.mapTo(mutableSetOf()) { it.hostId },
                                    selectedHostId = selectedHost,
                                )
                            ) {
                                preferencesStore.setPreferredHostAndScope(selectedHost, DEFAULT_SCOPE_ID)
                            }
                        }
                        RelayRequestKind.SESSIONS -> {
                            val hostId = event.hostId.ifBlank { snapshot.selectedHostId }
                            if (hostId.isNotBlank()) {
                                repository.replaceSessions(
                                    hostId,
                                    snapshot.sessions.filter { it.hostId == hostId },
                                )
                            }
                        }
                        RelayRequestKind.SCOPES -> {
                            val hostId = event.hostId.ifBlank { snapshot.selectedHostId }
                            if (hostId.isNotBlank()) {
                                repository.replaceScopes(
                                    hostId,
                                    snapshot.scopes.filter { it.hostId == hostId },
                                )
                            }
                        }
                        else -> Unit
                    }
                }.onFailure {
                    emit(V2UiEffect.Notice("Local relay cache could not be updated"))
                }
            }
        }
    }

    private fun flushOutbox() {
        if (demoMode || rawHealth.overall != ConnectionStatus.ONLINE) return
        viewModelScope.launch {
            outboxMutex.withLock {
                val plan = OutboxDispatchPlanner.plan(
                    messages = repository.pendingOutbox(),
                    isCommandInFlight = inFlightMessages::containsCommand,
                    isSessionInFlight = inFlightMessages::hasSession,
                )
                plan.markAmbiguous.forEach { message ->
                    transitionOutboxSafely(
                        message.commandId,
                        DeliveryState.AMBIGUOUS,
                        "App no longer has the acknowledgement context",
                    )
                }
                plan.send.forEach { message ->
                    if (!transitionOutboxSafely(message.commandId, DeliveryState.SENDING)) {
                        return@forEach
                    }
                    val relayRequestId = relay.sendAgentMessage(
                        hostId = message.hostId,
                        sessionName = message.sessionName,
                        message = message.body,
                    )
                    inFlightMessages.register(
                        OutboxInFlightMessage(
                            requestId = relayRequestId,
                            commandId = message.commandId,
                            hostId = message.hostId,
                            sessionName = message.sessionName,
                        ),
                    )
                }
            }
        }
    }

    private fun markInFlightAmbiguous() {
        val commandIds = inFlightMessages.drainCommandIds()
        if (commandIds.isEmpty()) return
        viewModelScope.launch {
            commandIds.forEach {
                transitionOutboxSafely(it, DeliveryState.AMBIGUOUS, "Connection ended before acknowledgement")
            }
        }
    }

    private suspend fun reconcileInterruptedOutbox() {
        repository.pendingOutbox().forEach { message ->
            if (message.state in setOf(DeliveryState.SENDING, DeliveryState.ACCEPTED, DeliveryState.CONFIRMING)) {
                transitionOutboxSafely(
                    message.commandId,
                    DeliveryState.AMBIGUOUS,
                    "App restarted before acknowledgement",
                )
            }
        }
    }

    private fun scheduleOutboxRetry() {
        if (outboxRetryJob?.isActive == true) return
        outboxRetryAttempt += 1
        val exponent = (outboxRetryAttempt - 1).coerceIn(0, 4)
        val delayMillis = (1_000L * (1 shl exponent)).coerceAtMost(15_000L)
        outboxRetryJob = viewModelScope.launch {
            delay(delayMillis)
            outboxRetryJob = null
            flushOutbox()
        }
    }

    private suspend fun transitionOutboxSafely(
        commandId: String,
        next: DeliveryState,
        error: String = "",
    ): Boolean = try {
        repository.transitionOutbox(commandId, next, error)
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: IllegalArgumentException) {
        false
    }

    private fun selectedHostId(): String = _uiState.value.activeHostId

    private fun refreshDecoratedHealth() {
        _uiState.update { state -> state.copy(health = decorateHealth(rawHealth, state)) }
    }

    private fun decorateHealth(base: ConnectionHealth, state: V2UiState): ConnectionHealth {
        if (demoMode) return base
        val overall = if (state.networkAvailable) base.overall else ConnectionStatus.PAUSED
        val phase = if (state.networkAvailable) base.phase else TransportPhase.WAITING_FOR_NETWORK
        val hostId = state.activeHostId
        val host = state.hosts.firstOrNull { it.hostId == hostId }
        val scopeId = state.selectedScopeId ?: state.preferences.preferredScopeId
        val scope = state.scopes.firstOrNull { it.hostId == hostId && it.scopeId == scopeId }
        val relayStatus = when (base.overall) {
            ConnectionStatus.ONLINE -> ConnectionStatus.ONLINE
            ConnectionStatus.CONNECTING, ConnectionStatus.RECOVERING -> base.overall
            ConnectionStatus.AUTH_REQUIRED, ConnectionStatus.INCOMPATIBLE -> base.overall
            else -> ConnectionStatus.OFFLINE
        }
        val hostStatus = when {
            base.overall != ConnectionStatus.ONLINE -> ConnectionStatus.PAUSED
            host != null -> ConnectionStatus.ONLINE
            else -> ConnectionStatus.RECOVERING
        }
        val scopeStatus = when {
            hostStatus != ConnectionStatus.ONLINE -> ConnectionStatus.PAUSED
            scope == null -> ConnectionStatus.UNKNOWN
            scope.reachable -> ConnectionStatus.ONLINE
            else -> ConnectionStatus.OFFLINE
        }
        return base.copy(
            phase = phase,
            overall = overall,
            layers = listOf(
                HealthLayer(
                    id = "phone",
                    label = "Phone network",
                    status = if (state.networkAvailable) ConnectionStatus.ONLINE else ConnectionStatus.OFFLINE,
                    detail = if (state.networkAvailable) "Internet available" else "Waiting for network",
                    lastSuccessAtMillis = base.lastSyncedAtMillis,
                ),
                HealthLayer(
                    id = "relay",
                    label = "Relay",
                    status = relayStatus,
                    detail = base.errorMessage.ifBlank { relayStatus.label() },
                    lastSuccessAtMillis = base.lastSyncedAtMillis,
                ),
                HealthLayer(
                    id = "host",
                    label = host?.displayName ?: hostId.ifBlank { "Paired host" },
                    status = hostStatus,
                    detail = if (host != null) "Host visible" else hostStatus.label(),
                    lastSuccessAtMillis = host?.lastSeenAtMillis ?: 0,
                ),
                HealthLayer(
                    id = "scope",
                    label = scope?.label ?: scopeId.ifBlank { "local" },
                    status = scopeStatus,
                    detail = scope?.error?.ifBlank { scopeStatus.label() } ?: scopeStatus.label(),
                    lastSuccessAtMillis = base.lastSyncedAtMillis,
                ),
            ),
        )
    }

    private fun validateRelayUrl(value: String): String? =
        PairingInputValidator.relayUrlError(
            relayUrl = value.trim(),
            allowDebugLoopbackCleartext = com.tmuxworktree.mobile.BuildConfig.DEBUG,
        )

    private fun ConnectionStatus.label(): String = name.lowercase().replace('_', ' ')

    private fun emit(effect: V2UiEffect) {
        if (effectsClosed) return
        val usesNormalSlot = !effect.isCritical()
        if (usesNormalSlot && !normalEffectSlots.tryAcquire()) {
            reportEffectOverflow()
            return
        }
        if (effectInputChannel.trySend(QueuedUiEffect(effect, usesNormalSlot)).isSuccess) return
        if (usesNormalSlot) normalEffectSlots.release()
        reportEffectOverflow()
    }

    private fun reportEffectOverflow() {
        _uiState.update { state ->
            state.copy(actionError = state.actionError ?: "UI event buffer is full; retry the action")
        }
    }

    private suspend fun emitAwait(effect: V2UiEffect) {
        if (effectsClosed) return
        val usesNormalSlot = normalEffectSlots.tryAcquire()
        val sent = runCatching {
            effectInputChannel.send(QueuedUiEffect(effect, usesNormalSlot))
        }.isSuccess
        if (!sent && usesNormalSlot) normalEffectSlots.release()
    }

    private fun V2UiEffect.isCritical(): Boolean = when (this) {
        is V2UiEffect.NavigateToSession,
        is V2UiEffect.NavigateToTerminal,
        is V2UiEffect.TerminalReset,
        V2UiEffect.ProfileCleared,
        -> true
        else -> false
    }

    private data class QueuedUiEffect(
        val effect: V2UiEffect,
        val usesNormalSlot: Boolean,
    )

    companion object {
        private const val DEFAULT_SCOPE_ID = "local"
        private const val OUTBOX_EVENT_PREFIX = "outbox-"
        private const val MAX_PENDING_UI_EFFECTS = 64
        private const val MAX_PENDING_CRITICAL_UI_EFFECTS = 16
        private const val OUTBOX_EXPIRY_POLL_MILLIS = 30_000L
        private const val PROFILE_DRAIN_TIMEOUT_MILLIS = 5_000L
        private val CANCELLABLE_DELIVERY_STATES = setOf(
            DeliveryState.QUEUED,
            DeliveryState.FAILED_RETRYABLE,
            DeliveryState.ACCEPTED,
            DeliveryState.CONFIRMING,
            DeliveryState.AMBIGUOUS,
        )

        fun factory(
            container: AppContainer,
            demoMode: Boolean,
            demoRecovering: Boolean = false,
        ): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    require(modelClass.isAssignableFrom(V2ViewModel::class.java))
                    return V2ViewModel(container, demoMode, demoRecovering) as T
                }
            }
    }
}
