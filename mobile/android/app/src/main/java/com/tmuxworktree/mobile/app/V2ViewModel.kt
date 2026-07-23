package com.tmuxworktree.mobile.app

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentLifecycleScope
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentLifecycleState
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentNotificationConfig
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentNotificationPermission
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentNotificationPolicy
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTimelineEntryRole
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptEntryContent
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecyclePresentationItem
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleSelectedSessionPresentationState
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDialect
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectBarrier
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2ConfirmedEnrollment
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2EnrollmentResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2RefreshApplyResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2SelfRevokeResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2AgentCapabilityAvailability
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimeComposition
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimeFailure
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CreateTerminalInputs
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CreateWorktreeInputs
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2ProductSession
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2ScopeCreateCut
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2ScopeCreateFailure
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2ScopeCreateResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2SessionKillResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2SessionReplyCut
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2SessionReplyFailure
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2SessionReplyResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalAttachment
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalAttachmentObserver
import com.tmuxworktree.mobile.core.relay.v2.runtime.SelectedSessionReplyReadState
import com.tmuxworktree.mobile.core.relay.v2.runtime.SelectedSessionReplyRow
import com.tmuxworktree.mobile.core.relay.v2.runtime.RELAY_V2_CREDENTIAL_ROLLOVER_UNAVAILABLE
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag
import com.tmuxworktree.mobile.core.data.AppPreferences
import com.tmuxworktree.mobile.core.data.NotificationKind
import com.tmuxworktree.mobile.core.data.OutboxInFlightMessage
import com.tmuxworktree.mobile.core.data.OutboxInFlightRegistry
import com.tmuxworktree.mobile.core.data.OutboxDispatchPlanner
import com.tmuxworktree.mobile.core.model.AgentEvidenceAvailability
import com.tmuxworktree.mobile.core.model.AgentState
import com.tmuxworktree.mobile.core.model.ConnectionHealth
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.DeliveryState
import com.tmuxworktree.mobile.core.model.DemoData
import com.tmuxworktree.mobile.core.model.HealthLayer
import com.tmuxworktree.mobile.core.model.RelayHost
import com.tmuxworktree.mobile.core.model.RelayScope
import com.tmuxworktree.mobile.core.model.RelaySession
import com.tmuxworktree.mobile.core.model.SessionTimelineState
import com.tmuxworktree.mobile.core.model.TerminalStreamState
import com.tmuxworktree.mobile.core.model.TimelineActor
import com.tmuxworktree.mobile.core.model.TimelineEvent
import com.tmuxworktree.mobile.core.model.TransportPhase
import com.tmuxworktree.mobile.core.relay.runtime.RelayClientEvent
import com.tmuxworktree.mobile.core.relay.runtime.RelayRequestKind
import com.tmuxworktree.mobile.core.relay.runtime.RelayV1ConnectionActor
import com.tmuxworktree.mobile.core.relay.runtime.RelayV1ConnectionConfig
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCloseReason
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResetReason
import com.tmuxworktree.mobile.core.terminal.RelayV2TerminalWebViewParserAdapter
import com.tmuxworktree.mobile.core.terminal.TerminalWebViewController
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.transformLatest
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

/** Owns one exact selected-Session cut from status admission through its revision collector. */
internal suspend fun collectRelayV2SelectedSessionCut(
    requestAgentStatus: suspend () -> Unit,
    outboxRevisions: Flow<Long>,
    agentRevisions: Flow<Long>,
    collectRevision: suspend (Long, Long) -> Unit,
) {
    requestAgentStatus()
    outboxRevisions.combine(agentRevisions, ::Pair).collectLatest { (outbox, agent) ->
        collectRevision(outbox, agent)
    }
}

class V2ViewModel(
    private val container: AppContainer,
    private val demoMode: Boolean = false,
    private val demoRecovering: Boolean = false,
) : ViewModel() {
    private data class RelayV2UiTerminalAttachment(
        val composition: RelayV2BaseRuntimeComposition,
        val sessionStableId: String,
        val sessionCut: RelayV2SessionReplyCut,
        val attachment: RelayV2TerminalAttachment,
    )

    private val repository = container.repository
    private val preferencesStore = container.preferences
    private val credentials = container.credentials
    private val relayOwner = lazy(LazyThreadSafetyMode.NONE) {
        RelayV1ConnectionActor(viewModelScope)
    }
    private val relay: RelayV1ConnectionActor
        get() = relayOwner.value
    private val relayV2EnrollmentReviewSession = RelayV2EnrollmentReviewSession(
        confirmationPort = RelayV2EnrollmentConfirmationPort(::confirmRelayV2Enrollment),
        activationPort = RelayV2EnrollmentActivationPort(::activateRelayV2Profile),
    )
    private val _relayV2EnrollmentReviewState = MutableStateFlow(
        relayV2EnrollmentReviewSession.state,
    )
    internal val relayV2EnrollmentReviewState = _relayV2EnrollmentReviewState.asStateFlow()
    @Volatile
    private var relayV2Composition: RelayV2BaseRuntimeComposition? = null
    @Volatile
    private var relayV2ProfileRuntime: RelayV2ProfileRuntimeAdapter? = null
    private val relayV2SessionReplyCuts =
        MutableStateFlow<Map<String, RelayV2SessionReplyCut>>(emptyMap())
    private val relayV2ScopeCreateCuts =
        MutableStateFlow<Map<Pair<String, String>, RelayV2ScopeCreateCut>>(emptyMap())
    private val relayV2UiFenceLock = Any()
    private var relayV2Terminal: RelayV2UiTerminalAttachment? = null
    private var relayV2NotificationProfileActive = false
    private var notificationPermissionGranted = false
    private var notificationPermissionRequestPending = false
    private val agentNotificationConfigMutex = Mutex()
    private val notificationPermissionRequestChannel = Channel<Unit>(capacity = 1)
    internal val notificationPermissionRequests: Flow<Unit> =
        notificationPermissionRequestChannel.receiveAsFlow()
    private val outboxMutex = Mutex()
    private val inFlightMessages = OutboxInFlightRegistry()
    private val profileMutationCoordinator = container.profileMutationCoordinator
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
    private var profileMutationTrackerCount = 0
    private var profileExpectationInitialized = false
    private var expectedRelayUrl: String? = null

    init {
        startEffectForwarder()
        if (!demoMode) startRealApp()
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    fun timeline(sessionId: String): Flow<SessionTimelineState> = if (demoMode) {
        uiState.map { state ->
            SessionTimelineState(
                events = state.demoTimelines[sessionId].orEmpty(),
                agentEvidenceAvailability = AgentEvidenceAvailability.AVAILABLE,
            )
        }
    } else if (_uiState.value.relayStartupAdmission == RelayStartupAdmissionState.RELAY_V2) {
        relayV2SessionReplyCuts.transformLatest { observedCuts ->
            emit(relayV2AgentEvidenceUnavailableState())
            val selected = synchronized(relayV2UiFenceLock) {
                val composition = relayV2Composition
                val cut = observedCuts[sessionId]
                if (_uiState.value.relayStartupAdmission !=
                    RelayStartupAdmissionState.RELAY_V2 ||
                    composition == null || cut == null ||
                    relayV2SessionReplyCuts.value[sessionId] !== cut
                ) {
                    null
                } else {
                    composition to cut
                }
            } ?: return@transformLatest
            val (composition, cut) = selected
            collectRelayV2SelectedSessionCut(
                requestAgentStatus = {
                    composition.requestSelectedSessionAgentStatus(cut)
                },
                outboxRevisions = composition.outboxTimelineRevision,
                agentRevisions = composition.agentTimelineRevision,
            ) { expectedOutboxRevision, expectedAgentRevision ->
                val replies = composition.readSelectedSessionReplies(cut, expectedOutboxRevision)
                if (replies == SelectedSessionReplyReadState.Stale) return@collectRelayV2SelectedSessionCut
                val stillCurrent = {
                    synchronized(relayV2UiFenceLock) {
                        relayV2Composition === composition &&
                            _uiState.value.relayStartupAdmission ==
                            RelayStartupAdmissionState.RELAY_V2 &&
                            relayV2SessionReplyCuts.value[sessionId] === cut &&
                            composition.outboxTimelineRevision.value == expectedOutboxRevision &&
                            composition.agentTimelineRevision.value == expectedAgentRevision
                    }
                }
                val timelineState = projectRelayV2SelectedSessionTimeline(
                    sessionStableId = sessionId,
                    readPresentation = { composition.readSelectedSession(cut) },
                    readReplies = { replies },
                    stillCurrent = stillCurrent,
                )
                if (stillCurrent()) emit(timelineState)
            }
        }
    } else {
        repository.timeline(sessionId).map { events ->
            SessionTimelineState(
                events = events,
                agentEvidenceAvailability = AgentEvidenceAvailability.RELAY_V1_UNSUPPORTED,
            )
        }
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

    fun offerRelayV2Enrollment(rawPayload: String) {
        viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            when (relayV2EnrollmentReviewSession.offer(rawPayload)) {
                RelayV2EnrollmentOfferResult.ACCEPTED -> publishRelayV2EnrollmentReviewState()
                RelayV2EnrollmentOfferResult.REJECTED ->
                    emit(V2UiEffect.Notice("This Relay v2 enrollment payload is invalid"))
                RelayV2EnrollmentOfferResult.REVIEW_ALREADY_PRESENT ->
                    emit(V2UiEffect.Notice("Finish or cancel the current enrollment review first"))
            }
        }
    }

    fun cancelRelayV2EnrollmentReview() {
        viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            val result = relayV2EnrollmentReviewSession.cancel()
            publishRelayV2EnrollmentReviewState()
            if (result == RelayV2EnrollmentCancelResult.SUBMISSION_IN_PROGRESS) {
                emit(V2UiEffect.Notice("Enrollment confirmation is already in progress"))
            }
        }
    }

    fun confirmRelayV2EnrollmentReview() {
        viewModelScope.launch {
            val operation = async(start = CoroutineStart.UNDISPATCHED) {
                relayV2EnrollmentReviewSession.confirm()
            }
            publishRelayV2EnrollmentReviewState()
            try {
                operation.await()
            } finally {
                // Direct assignment is safe under cancellation and publishes only non-sensitive
                // state copied from the session owner after its final settlement.
                publishRelayV2EnrollmentReviewState()
            }
        }
    }

    /** Explicit second user action; enrollment confirmation itself never starts a socket. */
    fun activateConfirmedRelayV2Profile() {
        viewModelScope.launch {
            val operation = async(start = CoroutineStart.UNDISPATCHED) {
                relayV2EnrollmentReviewSession.activate()
            }
            publishRelayV2EnrollmentReviewState()
            try {
                operation.await()
            } finally {
                publishRelayV2EnrollmentReviewState()
            }
        }
    }

    private fun publishRelayV2EnrollmentReviewState() {
        _relayV2EnrollmentReviewState.value = relayV2EnrollmentReviewSession.state
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
        val admission = _uiState.value.relayStartupAdmission
        if (admission != RelayStartupAdmissionState.RELAY_V1 &&
            admission != RelayStartupAdmissionState.RELAY_V2 &&
            admission != RelayStartupAdmissionState.RELAY_V2_SELF_REVOKE_QUARANTINED
        ) {
            emit(V2UiEffect.Notice("The active profile cannot be safely removed yet"))
            return
        }
        viewModelScope.launch {
            runCatching {
                when (admission) {
                    RelayStartupAdmissionState.RELAY_V1 -> mutateProfile(expectedUrl = null) {
                        disconnectRelayAndDrain()
                        connectedConfigKey = null
                        outboxRetryJob?.cancel()
                        inFlightMessages.clear()
                        preferencesStore.clearProfile()
                        credentials.clear()
                        repository.clearProfileData()
                        persistedSnapshotRevision = 0
                        publishProfileCleared(
                            preferencesStore.values.first { it.relayUrl.isBlank() },
                        )
                    }

                    RelayStartupAdmissionState.RELAY_V2,
                    RelayStartupAdmissionState.RELAY_V2_SELF_REVOKE_QUARANTINED,
                    -> trackProfileMutation(
                        expectedUrl = null,
                        updateProfileExpectation = false,
                    ) {
                        when (val result = requireRelayV2ProfileRuntime()
                            .selfRevokeActiveProfile()
                        ) {
                            RelayV2SelfRevokeResult.ProfileRemoved -> publishProfileCleared(
                                preferencesStore.values.first(),
                            )
                            is RelayV2SelfRevokeResult.Quarantined -> {
                                val quarantined = selfRevokeQuarantineAdmission(result.phase)
                                applyStartupAdmission(quarantined)
                                emit(V2UiEffect.Notice(requireNotNull(quarantined.message)))
                            }
                        }
                    }

                    else -> error("Profile removal admission changed")
                }
            }.onFailure { error ->
                emit(V2UiEffect.Notice(error.message ?: "Could not forget the pairing"))
            }
        }
    }

    private suspend fun publishProfileCleared(clearedPreferences: AppPreferences) {
        connectedConfigKey = null
        outboxRetryJob?.cancel()
        inFlightMessages.clear()
        persistedSnapshotRevision = 0
        _uiState.update {
            it.copy(
                relayStartupAdmission = RelayStartupAdmissionState.RELAY_V1,
                relayV2ProfileConnection = RelayV2ProfileConnectionState.STOPPED,
                relayV2ProfileFailureCode = null,
                agentCapabilityAvailability = AgentCapabilityAvailability.UNAVAILABLE,
                initialized = true,
                paired = false,
                pairingRequired = true,
                pairingRelayUrl = "",
                pairingToken = "",
                pairingHostId = "",
                pairingRelayUrlError = null,
                pairingError = null,
                confirmProfileSwitch = false,
                isConnecting = false,
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

    fun connectPairing() {
        if (demoMode) {
            _uiState.update { it.copy(pairingRequired = false, paired = true) }
            return
        }
        if (_uiState.value.relayStartupAdmission != RelayStartupAdmissionState.RELAY_V1) {
            _uiState.update {
                it.copy(
                    isConnecting = false,
                    pairingError = it.pairingError
                        ?: "Relay startup admission has not enabled Relay v1.",
                )
            }
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
        val relay = relayV1IfAdmitted() ?: return
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
                relayV1IfAdmitted()?.let { relay ->
                    relay.refreshSessions(normalized)
                    relay.refreshScopes(normalized)
                }
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
        if (_uiState.value.relayStartupAdmission == RelayStartupAdmissionState.RELAY_V2) {
            val admittedReply = synchronized(relayV2UiFenceLock) {
                val composition = relayV2Composition
                val sessionCut = relayV2SessionReplyCuts.value[session.stableId]
                if (composition == null || sessionCut == null) null else composition to sessionCut
            }
            if (admittedReply == null) {
                _uiState.update {
                    it.copy(actionError = "Relay v2 Session is no longer current")
                }
                return
            }
            val (composition, sessionCut) = admittedReply
            val callbackFence = RelayV2ReplyUiCallbackFence(
                composition = composition,
                sessionStableId = session.stableId,
                sessionCut = sessionCut,
            )
            // SessionDetailScreen submits the normalized body. Preserve the exact raw draft so a
            // later commit cannot erase typing that happened while the Room transaction ran.
            val submittedRawDraft = _uiState.value.drafts[session.stableId]
                ?.takeIf { it.trim() == normalized }
            viewModelScope.launch {
                when (val result = composition.submitReply(sessionCut, normalized)) {
                    is RelayV2SessionReplyResult.Committed -> {
                        // The receipt exists only after the durable Room transaction commits.
                        updateCurrentRelayV2Reply(callbackFence) { state ->
                            state.afterCommittedReply(
                                sessionId = session.stableId,
                                submittedRawDraft = submittedRawDraft,
                            )
                        }
                    }
                    is RelayV2SessionReplyResult.Rejected -> {
                        val current = updateCurrentRelayV2Reply(callbackFence) {
                            it.copy(actionError = result.failure.userMessage())
                        }
                        if (current) {
                            emit(V2UiEffect.Notice("Message was not queued"))
                        }
                    }
                }
            }
            return
        }
        if (relayV1IfAdmitted() == null) {
            _uiState.update {
                it.copy(actionError = "The current profile cannot send this message")
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
        if (!demoMode && relayV1IfAdmitted() == null) return
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

        if (_uiState.value.relayStartupAdmission == RelayStartupAdmissionState.RELAY_V2) {
            if (request.scopeId.isBlank()) {
                _uiState.update {
                    it.copy(actionError = "Choose a visible Relay v2 Scope")
                }
                return
            }
            val admittedCreate = synchronized(relayV2UiFenceLock) {
                val composition = relayV2Composition
                val scopeCut = relayV2ScopeCreateCuts.value[hostId to request.scopeId]
                if (_uiState.value.relayStartupAdmission !=
                    RelayStartupAdmissionState.RELAY_V2 ||
                    composition == null || scopeCut == null
                ) {
                    null
                } else {
                    _uiState.value = _uiState.value.copy(
                        creatingWorktree = true,
                        actionError = null,
                    )
                    composition to scopeCut
                }
            }
            if (admittedCreate == null) {
                _uiState.update {
                    it.copy(actionError = "The Relay v2 Scope is no longer current")
                }
                return
            }
            val (composition, scopeCut) = admittedCreate
            viewModelScope.launch {
                val result = composition.submitCreateWorktree(
                    scopeCut = scopeCut,
                    inputs = RelayV2CreateWorktreeInputs(
                        project = request.project.takeIf(String::isNotBlank),
                        path = request.path.takeIf(String::isNotBlank),
                        name = request.name.takeIf(String::isNotBlank),
                        branch = request.branch.takeIf(String::isNotBlank),
                        aiCommand = request.aiCommand,
                    ),
                )
                val current = synchronized(relayV2UiFenceLock) {
                    if (relayV2Composition !== composition ||
                        _uiState.value.relayStartupAdmission !=
                        RelayStartupAdmissionState.RELAY_V2
                    ) {
                        false
                    } else {
                        _uiState.value = when (result) {
                            is RelayV2ScopeCreateResult.Queued -> _uiState.value.copy(
                                creatingWorktree = false,
                                actionError = null,
                            )
                            is RelayV2ScopeCreateResult.Rejected -> _uiState.value.copy(
                                creatingWorktree = false,
                                actionError = result.failure.createWorktreeUserMessage(),
                            )
                        }
                        true
                    }
                }
                if (current) {
                    emit(
                        V2UiEffect.Notice(
                            when (result) {
                                is RelayV2ScopeCreateResult.Queued -> "Worktree creation queued"
                                is RelayV2ScopeCreateResult.Rejected ->
                                    "Worktree creation was not queued"
                            },
                        ),
                    )
                }
            }
            return
        }

        val relay = relayV1IfAdmitted() ?: run {
            _uiState.update { it.copy(actionError = "Relay v2 commands are not connected yet") }
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
        if (_uiState.value.relayStartupAdmission == RelayStartupAdmissionState.RELAY_V2) {
            if (scopeId.isBlank()) {
                _uiState.update {
                    it.copy(actionError = "Choose a visible Relay v2 Scope")
                }
                return
            }
            val admittedCreate = synchronized(relayV2UiFenceLock) {
                val composition = relayV2Composition
                val scopeCut = relayV2ScopeCreateCuts.value[selectedHost to scopeId]
                if (_uiState.value.relayStartupAdmission !=
                    RelayStartupAdmissionState.RELAY_V2 ||
                    composition == null || scopeCut == null
                ) {
                    null
                } else {
                    _uiState.value = _uiState.value.copy(
                        creatingTerminal = true,
                        actionError = null,
                    )
                    composition to scopeCut
                }
            }
            if (admittedCreate == null) {
                _uiState.update {
                    it.copy(actionError = "The Relay v2 Scope is no longer current")
                }
                return
            }
            val (composition, scopeCut) = admittedCreate
            viewModelScope.launch {
                val result = composition.submitCreateTerminal(
                    scopeCut = scopeCut,
                    inputs = RelayV2CreateTerminalInputs(
                        cwd = workingDirectory.trim(),
                        label = label.trim().takeIf(String::isNotEmpty),
                    ),
                )
                val current = synchronized(relayV2UiFenceLock) {
                    if (relayV2Composition !== composition ||
                        _uiState.value.relayStartupAdmission !=
                        RelayStartupAdmissionState.RELAY_V2
                    ) {
                        false
                    } else {
                        _uiState.value = when (result) {
                            is RelayV2ScopeCreateResult.Queued -> _uiState.value.copy(
                                creatingTerminal = false,
                                actionError = null,
                            )
                            is RelayV2ScopeCreateResult.Rejected -> _uiState.value.copy(
                                creatingTerminal = false,
                                actionError = result.failure.createTerminalUserMessage(),
                            )
                        }
                        true
                    }
                }
                if (current) {
                    emit(
                        V2UiEffect.Notice(
                            when (result) {
                                is RelayV2ScopeCreateResult.Queued ->
                                    "Terminal creation queued"
                                is RelayV2ScopeCreateResult.Rejected ->
                                    "Terminal creation was not queued"
                            },
                        ),
                    )
                }
            }
            return
        }
        val relay = relayV1IfAdmitted() ?: run {
            _uiState.update { it.copy(actionError = "Relay v2 commands are not connected yet") }
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
            return
        }
        if (_uiState.value.relayStartupAdmission == RelayStartupAdmissionState.RELAY_V2) {
            val admittedKill = synchronized(relayV2UiFenceLock) {
                val composition = relayV2Composition
                val sessionCut = relayV2SessionReplyCuts.value[session.stableId]
                if (_uiState.value.relayStartupAdmission !=
                    RelayStartupAdmissionState.RELAY_V2 ||
                    composition == null || sessionCut == null
                ) {
                    null
                } else {
                    composition to sessionCut
                }
            }
            if (admittedKill == null) {
                synchronized(relayV2UiFenceLock) {
                    if (_uiState.value.relayStartupAdmission ==
                        RelayStartupAdmissionState.RELAY_V2
                    ) {
                        _uiState.value = _uiState.value.copy(
                            actionError = "Relay v2 Session is no longer current",
                        )
                    }
                }
                return
            }
            val (composition, sessionCut) = admittedKill
            val callbackFence = RelayV2ReplyUiCallbackFence(
                composition = composition,
                sessionStableId = session.stableId,
                sessionCut = sessionCut,
            )
            viewModelScope.launch {
                when (val result = composition.submitKillSession(sessionCut)) {
                    is RelayV2SessionKillResult.Queued -> {
                        // Queued is not terminated. The Session remains until sessions.changed
                        // authoritatively deletes the materialized row.
                        updateCurrentRelayV2Reply(callbackFence) {
                            it.copy(actionError = null)
                        }
                    }
                    is RelayV2SessionKillResult.Rejected -> {
                        val current = updateCurrentRelayV2Reply(callbackFence) {
                            it.copy(actionError = result.failure.killUserMessage())
                        }
                        if (current) emit(V2UiEffect.Notice("Session end was not queued"))
                    }
                }
            }
            return
        }
        relayV1IfAdmitted()?.killSession(session.hostId, session.name)
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
        } else if (_uiState.value.relayStartupAdmission == RelayStartupAdmissionState.RELAY_V2) {
            _uiState.update { it.copy(actionError = "Relay v2 terminal view is not attached") }
        } else {
            relayV1IfAdmitted()?.openTerminal(session.hostId, session.name)
        }
    }

    fun openTerminal(session: RelaySession, controller: TerminalWebViewController) {
        if (demoMode || _uiState.value.relayStartupAdmission != RelayStartupAdmissionState.RELAY_V2) {
            openTerminal(session)
            return
        }
        val admitted = synchronized(relayV2UiFenceLock) {
            val composition = relayV2Composition
            val cut = relayV2SessionReplyCuts.value[session.stableId]
            if (composition == null || cut == null) null else Triple(composition, cut, relayV2Terminal)
        }
        if (admitted == null) {
            _uiState.update { it.copy(actionError = "Relay v2 Session is no longer current") }
            return
        }
        viewModelScope.launch {
            val (composition, cut, previous) = admitted
            previous?.let { stale -> stale.composition.detachTerminal(stale.attachment) }
            val parser = RelayV2TerminalWebViewParserAdapter(controller, viewModelScope)
            lateinit var issued: RelayV2UiTerminalAttachment
            val observer = object : RelayV2TerminalAttachmentObserver {
                override fun opened(streamId: String) {
                    updateCurrentTerminal(issued) {
                        it.copy(
                            terminal = TerminalStreamState(
                                streamId = streamId,
                                sessionId = session.stableId,
                                status = ConnectionStatus.ONLINE,
                            ),
                            actionError = null,
                        )
                    }
                }

                override fun reset(reason: RelayV2TerminalResetReason) {
                    updateCurrentTerminal(issued) {
                        it.copy(
                            terminal = TerminalStreamState(
                                sessionId = session.stableId,
                                status = ConnectionStatus.OFFLINE,
                                resetReason = reason.name.lowercase(),
                            ),
                        )
                    }
                }

                override fun closed(reason: RelayV2TerminalCloseReason) {
                    updateCurrentTerminal(issued) {
                        it.copy(
                            terminal = TerminalStreamState(
                                sessionId = session.stableId,
                                status = ConnectionStatus.OFFLINE,
                                resetReason = reason.name.lowercase(),
                            ),
                        )
                    }
                }
            }
            val attachment = composition.attachTerminal(cut, parser, observer)
            if (attachment == null) {
                _uiState.update { it.copy(actionError = "Relay v2 terminal attachment is stale") }
                return@launch
            }
            issued = RelayV2UiTerminalAttachment(composition, session.stableId, cut, attachment)
            val current = synchronized(relayV2UiFenceLock) {
                val stillCurrent = relayV2Composition === composition &&
                    relayV2SessionReplyCuts.value[session.stableId] === cut
                if (stillCurrent) relayV2Terminal = issued
                stillCurrent
            }
            if (!current || !composition.openTerminal(attachment, DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS)) {
                composition.detachTerminal(attachment)
                synchronized(relayV2UiFenceLock) {
                    if (relayV2Terminal === issued) relayV2Terminal = null
                }
                _uiState.update { it.copy(actionError = "Relay v2 terminal could not be opened") }
            } else {
                _uiState.update {
                    it.copy(
                        terminal = TerminalStreamState(
                            sessionId = session.stableId,
                            status = ConnectionStatus.CONNECTING,
                        ),
                    )
                }
            }
        }
    }

    fun closeTerminal() {
        if (demoMode) return
        if (_uiState.value.relayStartupAdmission == RelayStartupAdmissionState.RELAY_V2) {
            val current = synchronized(relayV2UiFenceLock) { relayV2Terminal } ?: return
            viewModelScope.launch {
                if (!current.composition.closeTerminal(current.attachment)) {
                    current.composition.detachTerminal(current.attachment)
                    synchronized(relayV2UiFenceLock) {
                        if (relayV2Terminal === current) relayV2Terminal = null
                    }
                }
            }
        } else {
            relayV1IfAdmitted()?.closeTerminal()
        }
    }

    fun sendTerminalInput(data: String) {
        if (demoMode) {
            emit(V2UiEffect.TerminalWrite(data))
        } else if (_uiState.value.relayStartupAdmission == RelayStartupAdmissionState.RELAY_V2) {
            val current = synchronized(relayV2UiFenceLock) { relayV2Terminal } ?: return
            viewModelScope.launch {
                if (!current.composition.sendTerminalInput(
                        current.attachment,
                        data.toByteArray(Charsets.UTF_8),
                    )
                ) {
                    updateCurrentTerminal(current) {
                        it.copy(actionError = "Relay v2 terminal input was not admitted")
                    }
                }
            }
        } else {
            relayV1IfAdmitted()?.sendTerminalInput(data)
        }
    }

    fun resizeTerminal(cols: Int, rows: Int) {
        if (demoMode) return
        if (_uiState.value.relayStartupAdmission == RelayStartupAdmissionState.RELAY_V2) {
            val current = synchronized(relayV2UiFenceLock) { relayV2Terminal } ?: return
            viewModelScope.launch {
                current.composition.resizeTerminal(current.attachment, cols, rows)
            }
        } else {
            relayV1IfAdmitted()?.resizeTerminal(cols, rows)
        }
    }

    private fun updateCurrentTerminal(
        expected: RelayV2UiTerminalAttachment,
        update: (V2UiState) -> V2UiState,
    ): Boolean = synchronized(relayV2UiFenceLock) {
        if (relayV2Terminal !== expected || relayV2Composition !== expected.composition ||
            relayV2SessionReplyCuts.value[expected.sessionStableId] !== expected.sessionCut
        ) return@synchronized false
        _uiState.value = update(_uiState.value)
        true
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
            if (enabled) requestNotificationPermissionFromExplicitToggle()
            viewModelScope.launch {
                preferencesStore.setNotificationPreference(kind, enabled)
                val preferences = preferencesStore.values.first()
                val composition = synchronized(relayV2UiFenceLock) {
                    if (relayV2Composition != null &&
                        _uiState.value.relayStartupAdmission ==
                        RelayStartupAdmissionState.RELAY_V2
                    ) {
                        _uiState.value = _uiState.value.copy(preferences = preferences)
                    }
                    relayV2Composition
                }
                composition?.let { syncAgentNotificationConfig(it) }
            }
        }
    }

    /** Activity reports the actual platform result; issuing a request never calls this method. */
    internal fun updateNotificationPermission(granted: Boolean) {
        val composition = synchronized(relayV2UiFenceLock) {
            notificationPermissionGranted = granted
            notificationPermissionRequestPending = false
            relayV2Composition
        }
        composition?.let { current ->
            viewModelScope.launch { syncAgentNotificationConfig(current) }
        }
    }

    private fun requestNotificationPermissionFromExplicitToggle() {
        val shouldRequest = synchronized(relayV2UiFenceLock) {
            if (notificationPermissionGranted || notificationPermissionRequestPending ||
                relayV2Composition == null ||
                _uiState.value.relayStartupAdmission != RelayStartupAdmissionState.RELAY_V2 ||
                _uiState.value.agentCapabilityAvailability !=
                AgentCapabilityAvailability.AVAILABLE
            ) {
                false
            } else {
                notificationPermissionRequestPending = true
                true
            }
        }
        if (!shouldRequest) return
        if (notificationPermissionRequestChannel.trySend(Unit).isFailure) {
            synchronized(relayV2UiFenceLock) {
                notificationPermissionRequestPending = false
            }
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
            if (state.health.protocolLabel == RELAY_V2_TRANSPORT_LABEL) {
                appendLine("capabilityReadiness=not-advertised")
            }
        }.trim()
    }

    fun clearActionError() {
        _uiState.update { it.copy(actionError = null) }
    }

    /** Default-off product port: only a reviewed draft can produce this confirmed input. */
    internal suspend fun confirmRelayV2Enrollment(
        confirmed: RelayV2ConfirmedEnrollment,
    ): RelayV2EnrollmentResult {
        val result = trackProfileMutation(
            expectedUrl = null,
            updateProfileExpectation = false,
        ) {
            requireRelayV2ProfileRuntime().confirmEnrollment(confirmed)
        }
        return result
    }

    private suspend fun activateRelayV2Profile(expectedProfile: RelayV2Profile) {
        trackProfileMutation(
            expectedUrl = null,
            updateProfileExpectation = false,
        ) {
            val admission = requireRelayV2ProfileRuntime().admitStartup()
            check(admission.state == RelayStartupAdmissionState.RELAY_V2)
            val admittedProfile = requireNotNull(admission.relayV2Profile)
            check(admittedProfile == expectedProfile) {
                "Confirmed Relay v2 profile changed before activation"
            }
            container.legacyIdentityImporter.discardForV2Profile()
            applyStartupAdmission(admission)
            try {
                startRelayV2BaseRuntime(admittedProfile)
            } catch (failure: Throwable) {
                applyStartupAdmission(
                    RelayStartupAdmission(
                        state = RelayStartupAdmissionState.RELAY_V2_ADMISSION_FAILED,
                        message = "Relay v2 base runtime activation failed closed; " +
                            "Relay v1 fallback is disabled.",
                    ),
                )
                throw failure
            }
        }
    }

    /** Explicit credential maintenance; this does not start or replace a socket. */
    internal suspend fun refreshRelayV2Credential(): RelayV2RefreshApplyResult =
        trackProfileMutation(
            expectedUrl = null,
            updateProfileExpectation = false,
        ) {
            requireRelayV2ProfileRuntime().refreshCredential()
        }

    private fun requireRelayV2ProfileRuntime(): RelayV2ProfileRuntimeAdapter =
        checkNotNull(relayV2ProfileRuntime) {
            "Relay v2 profile runtime is not initialized"
        }

    override fun onCleared() {
        relayV2Composition?.close()
        synchronized(relayV2UiFenceLock) {
            relayV2NotificationProfileActive = false
            relayV2Terminal = null
            relayV2SessionReplyCuts.value = emptyMap()
            relayV2ScopeCreateCuts.value = emptyMap()
            relayV2Composition = null
        }
        relayV2ProfileRuntime = null
        if (relayOwner.isInitialized()) relay.close()
        effectsClosed = true
        notificationPermissionRequestChannel.close()
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
        updateProfileExpectation: Boolean = true,
        block: suspend () -> T,
    ): T = profileMutationCoordinator.mutate {
        trackProfileMutation(expectedUrl, updateProfileExpectation, block)
    }

    /** Runtime profile entries already own the process-wide mutation coordinator. */
    private suspend fun <T> trackProfileMutation(
        expectedUrl: String?,
        updateProfileExpectation: Boolean = true,
        block: suspend () -> T,
    ): T {
        synchronized(relayV2UiFenceLock) {
            profileMutationTrackerCount += 1
            profileMutationInProgress = true
            if (updateProfileExpectation) {
                profileExpectationInitialized = true
                expectedRelayUrl = expectedUrl?.let(PairingInputValidator::normalizeRelayUrl)
            }
        }
        try {
            return block()
        } finally {
            synchronized(relayV2UiFenceLock) {
                check(profileMutationTrackerCount > 0) {
                    "Profile mutation tracking underflow"
                }
                profileMutationTrackerCount -= 1
                profileMutationInProgress = profileMutationTrackerCount != 0
            }
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

    private fun preferenceMatchesExpectedProfile(preferences: AppPreferences): Boolean =
        synchronized(relayV2UiFenceLock) {
            !profileExpectationInitialized ||
                PairingInputValidator.normalizeRelayUrl(preferences.relayUrl) ==
                expectedRelayUrl.orEmpty()
        }

    private fun clearUnreadableProfile(observedRelayUrl: String) {
        if (credentialRecoveryNotified) return
        credentialRecoveryNotified = true
        viewModelScope.launch {
            profileMutationCoordinator.mutate {
                val latest = preferencesStore.values.first()
                if (PairingInputValidator.normalizeRelayUrl(latest.relayUrl) !=
                    PairingInputValidator.normalizeRelayUrl(observedRelayUrl) ||
                    (latest.relayUrl.isNotBlank() && !credentials.read().isNullOrBlank())
                ) {
                    credentialRecoveryNotified = false
                    return@mutate
                }
                trackProfileMutation(expectedUrl = null) {
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
                }
            }
        }
    }

    private fun applyStartupAdmission(admission: RelayStartupAdmission) {
        synchronized(relayV2UiFenceLock) {
            if (admission.state != RelayStartupAdmissionState.RELAY_V2) {
                relayV2SessionReplyCuts.value = emptyMap()
                relayV2ScopeCreateCuts.value = emptyMap()
            }
            val current = _uiState.value
            _uiState.value = when {
                admission.allowsRelayV1 -> current.copy(
                    relayStartupAdmission = admission.state,
                )
                admission.relayV2Profile != null -> current.copy(
                    relayStartupAdmission = admission.state,
                    initialized = true,
                    paired = true,
                    pairingRequired = false,
                    isConnecting = false,
                    pairingError = null,
                )
                admission.selfRevokePhase != null -> current.copy(
                    relayStartupAdmission = admission.state,
                    relayV2ProfileConnection = RelayV2ProfileConnectionState.STOPPED,
                    relayV2ProfileFailureCode = null,
                    agentCapabilityAvailability = AgentCapabilityAvailability.UNAVAILABLE,
                    initialized = true,
                    paired = true,
                    pairingRequired = true,
                    isConnecting = false,
                    pairingError = admission.message,
                )
                else -> current.copy(
                    relayStartupAdmission = admission.state,
                    initialized = true,
                    paired = false,
                    pairingRequired = true,
                    isConnecting = false,
                    pairingError = admission.message,
                )
            }
        }
    }

    private fun startRealApp() {
        viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            var migrationNotice: String? = null
            val effectiveAdmission = try {
                val profileRuntime = container.createRelayV2ProfileRuntime(
                    disconnectBarrier = object : RelayProfileDisconnectBarrier {
                        override suspend fun disconnectAndDrain(
                            profile: RelayActiveProfileIdentity,
                            barrierId: String,
                        ): RelayProfileDisconnectReceipt = when (profile.dialect) {
                            RelayProfileDialect.V1 -> {
                                relay.disconnectAndAwait(barrierId)
                                RelayProfileDisconnectReceipt(profile, barrierId)
                            }
                            RelayProfileDialect.V2 -> {
                                val composition = synchronized(relayV2UiFenceLock) {
                                    relayV2NotificationProfileActive = false
                                    relayV2Composition
                                }
                                synchronized(relayV2UiFenceLock) {
                                    relayV2SessionReplyCuts.value = emptyMap()
                                    relayV2ScopeCreateCuts.value = emptyMap()
                                    relayV2Terminal = null
                                    _uiState.value = _uiState.value.copy(
                                        agentCapabilityAvailability =
                                            AgentCapabilityAvailability.UNAVAILABLE,
                                    )
                                }
                                if (composition == null) {
                                    noLiveRelayV2RuntimeReceipt(profile, barrierId)
                                } else {
                                    var drainCompleted = false
                                    try {
                                        syncAgentNotificationConfig(
                                            composition = composition,
                                            requireAvailableProjection = false,
                                        )
                                        composition.disconnectAndDrain(profile, barrierId).also {
                                            drainCompleted = true
                                        }
                                    } finally {
                                        // The composition is permanently fenced even when drain
                                        // fails. Never replace a failed exact drain with a receipt.
                                        runCatching { composition.close() }
                                        synchronized(relayV2UiFenceLock) {
                                            if (relayV2Composition === composition) {
                                                if (drainCompleted) relayV2Composition = null
                                                relayV2SessionReplyCuts.value = emptyMap()
                                                relayV2ScopeCreateCuts.value = emptyMap()
                                                relayV2Terminal = null
                                                _uiState.value = _uiState.value.copy(
                                                    agentCapabilityAvailability =
                                                        AgentCapabilityAvailability.UNAVAILABLE,
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    clearEphemeralAfterDisconnect = {
                        connectedConfigKey = null
                        outboxRetryJob?.cancel()
                        inFlightMessages.clear()
                        persistedSnapshotRevision = 0
                        synchronized(relayV2UiFenceLock) {
                            relayV2NotificationProfileActive = false
                            relayV2SessionReplyCuts.value = emptyMap()
                            relayV2ScopeCreateCuts.value = emptyMap()
                            relayV2Terminal = null
                            _uiState.value = V2UiState()
                        }
                    },
                )
                relayV2ProfileRuntime = profileRuntime
                trackProfileMutation(
                    expectedUrl = null,
                    updateProfileExpectation = false,
                ) {
                    val startupAdmission = profileRuntime.admitStartup()
                    val admitted = if (startupAdmission.allowsRelayV1) {
                        try {
                            container.legacyIdentityImporter.importIfNeeded()
                        } catch (error: Throwable) {
                            if (error is kotlinx.coroutines.CancellationException) throw error
                            migrationNotice = "Existing connection could not be migrated"
                        }
                        startupAdmission
                    } else if (startupAdmission.relayV2Profile != null) {
                        try {
                            container.legacyIdentityImporter.discardForV2Profile()
                            startupAdmission
                        } catch (error: Throwable) {
                            if (error is kotlinx.coroutines.CancellationException) throw error
                            RelayStartupAdmission(
                                state = RelayStartupAdmissionState.RELAY_V2_ADMISSION_FAILED,
                                message = "Legacy credential cleanup failed closed; " +
                                    "Relay v1 fallback is disabled.",
                            )
                        }
                    } else {
                        startupAdmission
                    }
                    val settled = admitted.relayV2Profile?.let { profile ->
                        try {
                            applyStartupAdmission(admitted)
                            startRelayV2BaseRuntime(profile)
                            admitted
                        } catch (error: Throwable) {
                            if (error is kotlinx.coroutines.CancellationException) throw error
                            RelayStartupAdmission(
                                state = RelayStartupAdmissionState.RELAY_V2_ADMISSION_FAILED,
                                message = "Relay v2 base runtime composition failed closed; " +
                                    "Relay v1 fallback is disabled.",
                            )
                        }
                    } ?: admitted
                    applyStartupAdmission(settled)
                    settled
                }
            } catch (error: Throwable) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                val failed = RelayStartupAdmission(
                    state = RelayStartupAdmissionState.RELAY_V2_ADMISSION_FAILED,
                    message = "Relay v2 startup admission failed closed; Relay v1 fallback is disabled.",
                )
                applyStartupAdmission(failed)
                failed
            }
            migrationNotice?.let { emit(V2UiEffect.Notice(it)) }

            if (effectiveAdmission.allowsRelayV1) {
                runCatching { reconcileInterruptedOutbox() }
                    .onFailure {
                        emit(V2UiEffect.Notice("Local cache could not be fully recovered"))
                }
                launchCollectors()
            }
        }
    }

    private fun startRelayV2BaseRuntime(profile: RelayV2Profile) {
        check(relayV2Composition == null) { "Relay v2 base runtime already exists" }
        val composition = container.createRelayV2BaseRuntimeComposition(
            viewModelScope,
            profile,
            requireRelayV2ProfileRuntime(),
        )
        synchronized(relayV2UiFenceLock) {
            relayV2Composition = composition
            relayV2NotificationProfileActive = true
            relayV2SessionReplyCuts.value = emptyMap()
            relayV2ScopeCreateCuts.value = emptyMap()
            val state = _uiState.value
            _uiState.value = state.copy(
                agentCapabilityAvailability = AgentCapabilityAvailability.UNAVAILABLE,
                preferences = state.preferences.copy(preferredHostId = profile.hostId),
                hosts = listOf(
                    RelayHost(
                        hostId = profile.hostId,
                        displayName = profile.hostId,
                        status = ConnectionStatus.UNKNOWN,
                    ),
                ),
            )
        }
        viewModelScope.launch {
            composition.state.collect { runtime ->
                synchronized(relayV2UiFenceLock) {
                    if (relayV2Composition !== composition ||
                        _uiState.value.relayStartupAdmission != RelayStartupAdmissionState.RELAY_V2
                    ) return@synchronized
                    val projected = projectRelayV2RuntimeState(
                        state = _uiState.value,
                        runtime = runtime,
                        nowMillis = System.currentTimeMillis(),
                    )
                    rawHealth = projected.health
                    val rolloverUnavailable =
                        (runtime.failure as? RelayV2BaseRuntimeFailure.RuntimeIncomplete)?.code ==
                            RELAY_V2_CREDENTIAL_ROLLOVER_UNAVAILABLE
                    _uiState.value = projected.copy(
                        health = decorateHealth(projected.health, projected),
                        relayStartupAdmission = if (rolloverUnavailable) {
                            RelayStartupAdmissionState.RELAY_V2_REENROLLMENT_REQUIRED
                        } else {
                            projected.relayStartupAdmission
                        },
                        paired = if (rolloverUnavailable) false else projected.paired,
                        pairingRequired = rolloverUnavailable || projected.pairingRequired,
                        pairingError = if (rolloverUnavailable) {
                            "Relay v2 credential rollover failed; re-enrollment is required. " +
                                "Relay v1 fallback is disabled."
                        } else {
                            projected.pairingError
                        },
                        agentCapabilityAvailability = if (rolloverUnavailable) {
                            AgentCapabilityAvailability.UNAVAILABLE
                        } else {
                            projected.agentCapabilityAvailability
                        },
                    )
                }
            }
        }
        viewModelScope.launch {
            composition.agentCapabilityAvailability.collect { availability ->
                val current = synchronized(relayV2UiFenceLock) {
                    if (relayV2Composition !== composition ||
                        _uiState.value.relayStartupAdmission != RelayStartupAdmissionState.RELAY_V2
                    ) return@synchronized false
                    _uiState.value = _uiState.value.copy(
                        agentCapabilityAvailability = when (availability) {
                            is RelayV2AgentCapabilityAvailability.Available ->
                                AgentCapabilityAvailability.AVAILABLE
                            RelayV2AgentCapabilityAvailability.Unavailable ->
                                AgentCapabilityAvailability.UNAVAILABLE
                        },
                    )
                    true
                }
                if (current) syncAgentNotificationConfig(composition)
            }
        }
        viewModelScope.launch {
            preferencesStore.values.collect { preferences ->
                val current = synchronized(relayV2UiFenceLock) {
                    if (relayV2Composition !== composition ||
                        _uiState.value.relayStartupAdmission != RelayStartupAdmissionState.RELAY_V2
                    ) return@synchronized false
                    _uiState.value = _uiState.value.copy(preferences = preferences)
                    true
                }
                if (current) syncAgentNotificationConfig(composition)
            }
        }
        viewModelScope.launch {
            composition.productProjection.collect { projection ->
                val projected = projection.sessions.map { product ->
                    product.toUiSession() to product.replyCut
                }
                val sessions = projected.map { it.first }
                val cuts = projected.associate { (session, cut) -> session.stableId to cut }
                val scopeCreateCuts = projection.scopes.mapNotNull { product ->
                    product.createCut?.let { cut ->
                        (
                            product.materialized.namespace.hostId to
                                product.materialized.scope.scopeId
                            ) to cut
                    }
                }.toMap()
                val sessionCounts = projection.sessions.groupingBy {
                    it.materialized.session.scopeId
                }.eachCount()
                val scopes = projection.scopes
                    .map { product ->
                        val scope = product.materialized.scope
                        RelayScope(
                            hostId = profile.hostId,
                            scopeId = scope.scopeId,
                            label = scope.displayName,
                            kind = scope.kind.wireValue,
                            reachable = scope.reachability.wireValue == "online",
                            sessionCount = sessionCounts[scope.scopeId] ?: 0,
                        )
                    }
                    .sortedBy { it.scopeId }
                val current = synchronized(relayV2UiFenceLock) {
                    if (relayV2Composition !== composition ||
                        _uiState.value.relayStartupAdmission != RelayStartupAdmissionState.RELAY_V2
                    ) return@synchronized false
                    relayV2SessionReplyCuts.value = cuts
                    relayV2ScopeCreateCuts.value = scopeCreateCuts
                    _uiState.value = _uiState.value.copy(scopes = scopes, sessions = sessions)
                    true
                }
                if (current) syncAgentNotificationConfig(composition)
            }
        }
    }

    private suspend fun syncAgentNotificationConfig(
        composition: RelayV2BaseRuntimeComposition,
        requireAvailableProjection: Boolean = true,
    ) {
        agentNotificationConfigMutex.withLock {
            val config = synchronized(relayV2UiFenceLock) {
                if (relayV2Composition !== composition ||
                    _uiState.value.relayStartupAdmission != RelayStartupAdmissionState.RELAY_V2 ||
                    requireAvailableProjection &&
                    _uiState.value.agentCapabilityAvailability !=
                    AgentCapabilityAvailability.AVAILABLE
                ) {
                    return@synchronized null
                }
                val preferences = _uiState.value.preferences
                AgentNotificationConfig(
                    permission = if (notificationPermissionGranted) {
                        AgentNotificationPermission.GRANTED
                    } else {
                        AgentNotificationPermission.DENIED
                    },
                    profileActive = relayV2NotificationProfileActive,
                    policy = AgentNotificationPolicy.ALLOW,
                    waitingForUser = preferences.waitingNotifications,
                    failed = preferences.failedNotifications,
                    completed = preferences.completedNotifications,
                )
            } ?: return@withLock
            composition.updateAgentNotificationConfig(config)
        }
    }

    private inline fun updateCurrentRelayV2Reply(
        fence: RelayV2ReplyUiCallbackFence,
        update: (V2UiState) -> V2UiState,
    ): Boolean = synchronized(relayV2UiFenceLock) {
        val current = _uiState.value
        val mutation = fence.applyIfCurrent(
            state = current,
            currentComposition = relayV2Composition,
            currentCuts = relayV2SessionReplyCuts.value,
            update = update,
        )
        if (mutation.applied) _uiState.value = mutation.state
        mutation.applied
    }

    private fun noLiveRelayV2RuntimeReceipt(
        profile: RelayActiveProfileIdentity,
        barrierId: String,
    ): RelayProfileDisconnectReceipt {
        check(profile.dialect == RelayProfileDialect.V2)
        check(barrierId.isNotBlank())
        return RelayProfileDisconnectReceipt(profile, barrierId)
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
                val mutationFenced = synchronized(relayV2UiFenceLock) {
                    if (!profileExpectationInitialized) {
                        profileExpectationInitialized = true
                        expectedRelayUrl = PairingInputValidator
                            .normalizeRelayUrl(preferences.relayUrl)
                            .ifBlank { null }
                    }
                    profileMutationInProgress ||
                        PairingInputValidator.normalizeRelayUrl(preferences.relayUrl) !=
                        expectedRelayUrl.orEmpty()
                }
                if (mutationFenced) {
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
        if (_uiState.value.relayStartupAdmission != RelayStartupAdmissionState.RELAY_V1) {
            return
        }
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

    private fun relayV1IfAdmitted(): RelayV1ConnectionActor? =
        if (_uiState.value.relayStartupAdmission == RelayStartupAdmissionState.RELAY_V1) {
            relay
        } else {
            null
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
        val isRelayV2Transport = base.protocolLabel == RELAY_V2_TRANSPORT_LABEL
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
            isRelayV2Transport && host != null -> host.status
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
                    detail = when {
                        base.errorMessage.isNotBlank() -> base.errorMessage
                        isRelayV2Transport && base.overall == ConnectionStatus.ONLINE ->
                            "Relay v2 transport online; capability readiness is not advertised"
                        isRelayV2Transport -> "Relay v2 transport ${relayStatus.label()}"
                        else -> relayStatus.label()
                    },
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
        private const val DEFAULT_TERMINAL_COLS = 80
        private const val DEFAULT_TERMINAL_ROWS = 24
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

private fun RelayV2ProductSession.toUiSession(): RelaySession {
    val cut = materialized
    val session = cut.session
    return RelaySession(
        hostId = cut.namespace.hostId,
        hostName = cut.namespace.hostId,
        name = session.displayName,
        rawName = session.displayName,
        scopeId = session.scopeId,
        scopeLabel = cut.scope.displayName,
        kind = session.kind.wireValue,
        project = session.project.orEmpty(),
        label = session.label.orEmpty(),
        cwd = session.cwd.orEmpty(),
        attached = session.attached,
        windows = session.windowCount.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(),
        createdAtSeconds = session.createdAtMs / 1_000L,
        activityAtSeconds = session.activityAtMs / 1_000L,
        agentState = AgentState.UNKNOWN,
        summary = "",
        branch = "",
        stableIdOverride = relayV2SessionUiStableId(
            cut.namespace.profileId,
            cut.namespace.principalId,
            cut.namespace.clientInstanceId,
            cut.namespace.hostId,
            cut.namespace.hostEpoch,
            session.scopeId,
            session.sessionId,
        ),
    )
}

private fun AgentTranscriptLifecycleSelectedSessionPresentationState.toTimelineState(
    sessionStableId: String,
): SessionTimelineState = when (this) {
    AgentTranscriptLifecycleSelectedSessionPresentationState.Disabled,
    AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable,
    AgentTranscriptLifecycleSelectedSessionPresentationState.Stale,
    -> relayV2AgentEvidenceUnavailableState()
    is AgentTranscriptLifecycleSelectedSessionPresentationState.Content -> {
        val timelineEpoch = checkNotNull(presentation.revision.namespace.timelineEpoch)
        SessionTimelineState(
            events = presentation.items.map { item ->
                when (item) {
                    is AgentTranscriptLifecyclePresentationItem.Transcript -> TimelineEvent(
                        eventId = relayV2TranscriptUiStableId(
                            sessionStableId,
                            item.runId,
                            item.turnId,
                            item.entryId,
                        ),
                        sessionId = sessionStableId,
                        actor = when (item.role) {
                            AgentTimelineEntryRole.USER -> TimelineActor.USER
                            AgentTimelineEntryRole.AGENT -> TimelineActor.AGENT
                        },
                        body = when (val content = item.content) {
                            is AgentTranscriptEntryContent.Visible -> content.text
                            is AgentTranscriptEntryContent.Redacted -> "Message redacted"
                        },
                        createdAtMillis = item.createdAtMs,
                    )
                    is AgentTranscriptLifecyclePresentationItem.Lifecycle -> TimelineEvent(
                        eventId = relayV2LifecycleUiStableId(
                            sessionStableId = sessionStableId,
                            timelineEpoch = timelineEpoch,
                            sourceEpoch = item.sourceEpoch,
                            scope = item.identity.scope,
                            runId = item.identity.runId,
                            turnId = item.identity.turnId,
                            lifecycleEventId = item.lifecycleEventId,
                        ),
                        sessionId = sessionStableId,
                        actor = TimelineActor.SYSTEM,
                        body = item.lifecycleTimelineBody(),
                        createdAtMillis = item.occurredAtMs,
                        deliveryState = null,
                    )
                }
            },
            agentEvidenceAvailability = AgentEvidenceAvailability.AVAILABLE,
        )
    }
}

private fun relayV2AgentEvidenceUnavailableState() = SessionTimelineState(
    events = emptyList(),
    agentEvidenceAvailability = AgentEvidenceAvailability.RELAY_V2_UNAVAILABLE,
)

internal suspend fun projectRelayV2SelectedSessionTimeline(
    sessionStableId: String,
    readPresentation: suspend () ->
        AgentTranscriptLifecycleSelectedSessionPresentationState,
    readReplies: suspend () -> SelectedSessionReplyReadState = {
        SelectedSessionReplyReadState.Content(revision = 0L, rows = emptyList())
    },
    stillCurrent: () -> Boolean,
): SessionTimelineState {
    val presentation = readPresentation()
    if (!stillCurrent()) return relayV2AgentEvidenceUnavailableState()
    val replies = readReplies()
    if (!stillCurrent()) return relayV2AgentEvidenceUnavailableState()
    val agentTimeline = presentation.toTimelineState(sessionStableId)
    val replyEvents = when (replies) {
        is SelectedSessionReplyReadState.Content -> replies.rows.mapNotNull { row ->
            row.toTimelineEvent(sessionStableId)
        }
        SelectedSessionReplyReadState.Stale,
        SelectedSessionReplyReadState.Unavailable,
        -> emptyList()
    }
    return agentTimeline.copy(
        events = replyEvents + agentTimeline.events,
    )
}

private fun SelectedSessionReplyRow.toTimelineEvent(
    sessionStableId: String,
): TimelineEvent? {
    val delivery = when (state) {
        RelayV2OutboxStateTag.QUEUED -> DeliveryState.QUEUED
        RelayV2OutboxStateTag.SENDING -> DeliveryState.SENDING
        RelayV2OutboxStateTag.ACCEPTED -> DeliveryState.ACCEPTED
        RelayV2OutboxStateTag.CONFIRMING -> DeliveryState.CONFIRMING
        RelayV2OutboxStateTag.SUCCEEDED -> DeliveryState.SUCCEEDED
        RelayV2OutboxStateTag.FAILED_FINAL -> DeliveryState.FAILED_FINAL
        RelayV2OutboxStateTag.AMBIGUOUS -> DeliveryState.AMBIGUOUS
        RelayV2OutboxStateTag.REISSUED -> return null
    }
    return TimelineEvent(
        eventId = relayV2SessionReplyUiStableId(sessionStableId, commandId),
        sessionId = sessionStableId,
        actor = TimelineActor.USER,
        body = message,
        createdAtMillis = createdAtMillis,
        deliveryState = delivery,
    )
}

/** Injective UI identity that retains the transcript's exact Session/run/turn scope. */
private fun relayV2TranscriptUiStableId(vararg opaqueParts: String): String = buildString {
    append("relay-v2-agent-transcript")
    opaqueParts.forEach { part ->
        append(':')
        append(part.length)
        append(':')
        append(part)
    }
}

/** Injective UI identity retaining the full local Session identity and durable commandId. */
private fun relayV2SessionReplyUiStableId(
    sessionStableId: String,
    commandId: String,
): String = buildString {
    append("relay-v2-session-reply")
    appendRelayV2UiStringPart(sessionStableId)
    appendRelayV2UiStringPart(commandId)
}

private fun relayV2LifecycleUiStableId(
    sessionStableId: String,
    timelineEpoch: String,
    sourceEpoch: String,
    scope: AgentLifecycleScope,
    runId: String,
    turnId: String?,
    lifecycleEventId: String,
): String = buildString {
    append("relay-v2-agent-lifecycle")
    appendRelayV2UiStringPart(sessionStableId)
    appendRelayV2UiStringPart(timelineEpoch)
    appendRelayV2UiStringPart(sourceEpoch)
    appendRelayV2UiStringPart(scope.name)
    appendRelayV2UiStringPart(runId)
    if (turnId == null) {
        append(":null")
    } else {
        append(":value")
        appendRelayV2UiStringPart(turnId)
    }
    appendRelayV2UiStringPart(lifecycleEventId)
}

private fun StringBuilder.appendRelayV2UiStringPart(value: String) {
    append(":string:")
    append(value.length)
    append(':')
    append(value)
}

private fun AgentTranscriptLifecyclePresentationItem.Lifecycle.lifecycleTimelineBody(): String {
    val scopeLabel = when (identity.scope) {
        AgentLifecycleScope.RUN -> "Run"
        AgentLifecycleScope.TURN -> "Turn"
    }
    val lifecycleLabel = when (state) {
        AgentLifecycleState.RUNNING -> "Running"
        AgentLifecycleState.WAITING_FOR_USER -> "Waiting for user"
        AgentLifecycleState.FAILED -> buildString {
            append("Failed")
            failure?.let { structuredFailure ->
                append(" (")
                append(structuredFailure.code)
                structuredFailure.summary?.takeIf { it.isNotBlank() }?.let { summary ->
                    append(": ")
                    append(summary)
                }
                append(')')
            }
        }
        AgentLifecycleState.COMPLETED -> "Completed"
    }
    val evidence = "$scopeLabel lifecycle: $lifecycleLabel"
    return if (isCurrentSource) evidence else "Historical source evidence · $evidence"
}

private fun RelayV2SessionReplyFailure.userMessage(): String = when (this) {
    RelayV2SessionReplyFailure.NOT_ONLINE -> "Relay v2 is not online"
    RelayV2SessionReplyFailure.PROFILE_BARRIER -> "The Relay v2 profile is changing"
    RelayV2SessionReplyFailure.SESSION_STALE -> "The Relay v2 Session is no longer current"
    RelayV2SessionReplyFailure.INVALID_MESSAGE -> "The message is empty or too large"
    RelayV2SessionReplyFailure.CAPACITY_EXCEEDED -> "The Relay v2 Outbox is full"
    RelayV2SessionReplyFailure.DUPLICATE_COMMAND,
    RelayV2SessionReplyFailure.FOREIGN_LINEAGE,
    RelayV2SessionReplyFailure.CORRUPT_STATE,
    RelayV2SessionReplyFailure.STORE_FAILURE,
    -> "The message could not be committed to the Relay v2 Outbox"
}

private fun RelayV2SessionReplyFailure.killUserMessage(): String = when (this) {
    RelayV2SessionReplyFailure.NOT_ONLINE -> "Relay v2 is not online"
    RelayV2SessionReplyFailure.PROFILE_BARRIER -> "The Relay v2 profile is changing"
    RelayV2SessionReplyFailure.SESSION_STALE -> "The Relay v2 Session is no longer current"
    RelayV2SessionReplyFailure.CAPACITY_EXCEEDED -> "The Relay v2 Outbox is full"
    RelayV2SessionReplyFailure.INVALID_MESSAGE,
    RelayV2SessionReplyFailure.DUPLICATE_COMMAND,
    RelayV2SessionReplyFailure.FOREIGN_LINEAGE,
    RelayV2SessionReplyFailure.CORRUPT_STATE,
    RelayV2SessionReplyFailure.STORE_FAILURE,
    -> "The Session end command could not be safely queued"
}

private fun RelayV2ScopeCreateFailure.createWorktreeUserMessage(): String = when (this) {
    RelayV2ScopeCreateFailure.NOT_ONLINE -> "Relay v2 is not online"
    RelayV2ScopeCreateFailure.PROFILE_BARRIER -> "The Relay v2 profile is changing"
    RelayV2ScopeCreateFailure.SCOPE_STALE -> "The Relay v2 Scope is no longer current"
    RelayV2ScopeCreateFailure.INVALID_INPUT -> "The Worktree settings are invalid"
    RelayV2ScopeCreateFailure.CAPACITY_EXCEEDED -> "The Relay v2 Outbox is full"
    RelayV2ScopeCreateFailure.DUPLICATE_COMMAND,
    RelayV2ScopeCreateFailure.FOREIGN_LINEAGE,
    RelayV2ScopeCreateFailure.CORRUPT_STATE,
    RelayV2ScopeCreateFailure.STORE_FAILURE,
    -> "The Worktree command could not be safely queued"
}

private fun RelayV2ScopeCreateFailure.createTerminalUserMessage(): String = when (this) {
    RelayV2ScopeCreateFailure.NOT_ONLINE -> "Relay v2 is not online"
    RelayV2ScopeCreateFailure.PROFILE_BARRIER -> "The Relay v2 profile is changing"
    RelayV2ScopeCreateFailure.SCOPE_STALE -> "The Relay v2 Scope is no longer current"
    RelayV2ScopeCreateFailure.INVALID_INPUT -> "The Terminal settings are invalid"
    RelayV2ScopeCreateFailure.CAPACITY_EXCEEDED -> "The Relay v2 Outbox is full"
    RelayV2ScopeCreateFailure.DUPLICATE_COMMAND,
    RelayV2ScopeCreateFailure.FOREIGN_LINEAGE,
    RelayV2ScopeCreateFailure.CORRUPT_STATE,
    RelayV2ScopeCreateFailure.STORE_FAILURE,
    -> "The Terminal command could not be safely queued"
}
