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
import com.tmuxworktree.mobile.core.relay.extensions.larkbindings.v2.LarkBindingsState
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectBarrier
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2ConfirmedEnrollment
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialExchangeException
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2EnrollmentResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2StartupAdmissionResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2RefreshApplyResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2RefreshRequirement
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2SelfRevokeResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2AgentCapabilityAvailability
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimeComposition
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimeFailure
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CreateTerminalInputs
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CreateWorktreeInputs
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2ManualResyncResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2NetworkHintResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2ProductSession
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RetryNowResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2ScopeCreateCut
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2ScopeCreateFailure
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2ScopeCreateResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2SessionKillResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2SessionReplyCut
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2SessionReplyFailure
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalAttachment
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalAttachmentObserver
import com.tmuxworktree.mobile.core.relay.v2.runtime.SelectedSessionReplyReadState
import com.tmuxworktree.mobile.core.relay.v2.runtime.SelectedSessionReplyRow
import com.tmuxworktree.mobile.core.relay.v2.runtime.RELAY_V2_CREDENTIAL_ROLLOVER_UNAVAILABLE
import com.tmuxworktree.mobile.core.relay.v2.runtime.RELAY_V2_GRANT_REVOKED
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag
import com.tmuxworktree.mobile.core.data.AppPreferences
import com.tmuxworktree.mobile.core.data.NotificationKind
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
import com.tmuxworktree.mobile.core.relay.runtime.RelayChatMutation
import com.tmuxworktree.mobile.core.relay.runtime.RelayChatReducer
import com.tmuxworktree.mobile.core.relay.runtime.RelayChatState
import com.tmuxworktree.mobile.core.relay.runtime.RelayV2ConnectionRegistry
import com.tmuxworktree.mobile.core.relay.runtime.RelayConnectionService
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCloseReason
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResetReason
import com.tmuxworktree.mobile.core.terminal.RelayV2TerminalParserCallbackBarrier
import com.tmuxworktree.mobile.core.terminal.RelayV2TerminalWebViewParserAdapter
import com.tmuxworktree.mobile.core.terminal.TerminalWebViewParserBinding
import com.tmuxworktree.mobile.core.terminal.TerminalWebViewRendererLoss
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
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

internal fun V2UiState.beginCreationSubmission(target: CreationTarget): V2UiState? =
    when (target) {
        CreationTarget.WORKTREE -> if (creatingWorktree) null else copy(
            creatingWorktree = true,
            actionError = null,
        )
        CreationTarget.TERMINAL -> if (creatingTerminal) null else copy(
            creatingTerminal = true,
            actionError = null,
        )
    }

internal data class RelayV2CreationUiTransition(
    val state: V2UiState,
    val effect: V2UiEffect,
)

internal fun V2UiState.afterRelayV2Creation(
    target: CreationTarget,
    result: RelayV2ScopeCreateResult,
    rejectionMessage: String,
): RelayV2CreationUiTransition {
    val settledState = when (target) {
        CreationTarget.WORKTREE -> copy(
            creatingWorktree = false,
            actionError = rejectionMessage.takeIf { result is RelayV2ScopeCreateResult.Rejected },
        )
        CreationTarget.TERMINAL -> copy(
            creatingTerminal = false,
            actionError = rejectionMessage.takeIf { result is RelayV2ScopeCreateResult.Rejected },
        )
    }
    val label = when (target) {
        CreationTarget.WORKTREE -> "Worktree"
        CreationTarget.TERMINAL -> "Terminal"
    }
    val effect = when (result) {
        is RelayV2ScopeCreateResult.Queued -> V2UiEffect.CreationQueued(
            target = target,
            message = "$label creation queued",
        )
        is RelayV2ScopeCreateResult.Rejected ->
            V2UiEffect.Notice("$label creation was not queued")
    }
    return RelayV2CreationUiTransition(settledState, effect)
}

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

/**
 * UI attachment identity is only a local route/lifecycle fence. [sessionCut] is the exact
 * admission proof consumed when the composition mints its separate opaque terminal attachment;
 * subsequent Session revisions are revalidated by that composition-owned attachment.
 */
internal class RelayV2TerminalUiAttachmentFence(
    val sessionStableId: String,
    private val attachmentId: String,
    val sessionCut: RelayV2SessionReplyCut,
) {
    fun ownsRoute(expectedAttachmentId: String): Boolean =
        attachmentId == expectedAttachmentId

    fun isCurrent(
        expectedAttachmentId: String,
        currentCuts: Map<String, RelayV2SessionReplyCut>,
    ): Boolean =
        ownsRoute(expectedAttachmentId) &&
            isCurrent(currentCuts)

    fun isCurrent(currentCuts: Map<String, RelayV2SessionReplyCut>): Boolean =
        currentCuts[sessionStableId] === sessionCut

    fun retainsActiveRoute(
        expectedAttachmentId: String,
        terminal: TerminalStreamState,
    ): Boolean =
        ownsRoute(expectedAttachmentId) &&
            terminal.sessionId == sessionStableId &&
            terminal.status in setOf(ConnectionStatus.CONNECTING, ConnectionStatus.ONLINE)
}

class V2ViewModel(
    private val container: AppContainer,
    private val demoMode: Boolean = false,
    private val demoRecovering: Boolean = false,
) : ViewModel() {
    private data class RelayV2UiTerminalAttachment(
        val composition: RelayV2BaseRuntimeComposition,
        val fence: RelayV2TerminalUiAttachmentFence,
        val parser: RelayV2TerminalWebViewParserAdapter,
        val rendererBinding: TerminalWebViewParserBinding,
        val lifecycle: RelayV2TerminalUiAttachmentLifecycle<RelayV2TerminalAttachment> =
            RelayV2TerminalUiAttachmentLifecycle(),
    )

    private sealed interface RelayV2TerminalUiOpenAdmission {
        data object RetainedCurrent : RelayV2TerminalUiOpenAdmission

        data class Open(
            val issued: RelayV2UiTerminalAttachment,
            val previousDetach: Triple<
                RelayV2UiTerminalAttachment,
                RelayV2TerminalAttachmentDetach<RelayV2TerminalAttachment>,
                RelayV2TerminalParserCallbackBarrier,
            >?,
        ) : RelayV2TerminalUiOpenAdmission
    }

    private val preferencesStore = container.preferences
    private val relayV2EnrollmentReviewSession = RelayV2EnrollmentReviewSession(
        confirmationPort = RelayV2EnrollmentConfirmationPort(::confirmRelayV2Enrollment),
        activationPort = RelayV2EnrollmentActivationPort(::activateRelayV2Profile),
        deviceLabel = container.relayV2EnrollmentDeviceLabel,
    )
    private val _relayV2EnrollmentReviewState = MutableStateFlow(
        relayV2EnrollmentReviewSession.state,
    )
    internal val relayV2EnrollmentReviewState = _relayV2EnrollmentReviewState.asStateFlow()
    @Volatile
    private var relayV2Composition: RelayV2BaseRuntimeComposition? = null

    /** Guarded by [relayV2UiFenceLock]; see [reserveRelayV2ExplicitRefresh]. */
    private var relayV2ExplicitRefreshReservation: RelayV2ExplicitRefreshReservation? = null
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
    private var relayV2NotificationPreferencesLoaded = false
    private var notificationPermissionRequestClaim: Any? = null
    private val agentNotificationConfigMutex = Mutex()
    private val notificationPermissionRequestChannel = Channel<Unit>(capacity = 1)
    internal val notificationPermissionRequests: Flow<Unit> =
        notificationPermissionRequestChannel.receiveAsFlow()

    private val _uiState = MutableStateFlow(initialState())
    val uiState = _uiState.asStateFlow()

    private val normalEffectSlots = Semaphore(MAX_PENDING_UI_EFFECTS)
    private val effectInputChannel = Channel<QueuedUiEffect>(
        MAX_PENDING_UI_EFFECTS + MAX_PENDING_CRITICAL_UI_EFFECTS,
    )
    private val effectChannel = Channel<V2UiEffect>(MAX_PENDING_UI_EFFECTS)
    val effects: Flow<V2UiEffect> = effectChannel.receiveAsFlow()

    private var rawHealth = if (demoMode) DemoData.health(recovering = demoRecovering) else ConnectionHealth()
    private var activeNetworkHandle: Long? = null
    private var effectsClosed = false
    private var profileMutationInProgress = false
    private var profileMutationTrackerCount = 0

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
        uiState.map {
            SessionTimelineState(
                events = emptyList(),
                agentEvidenceAvailability = AgentEvidenceAvailability.RELAY_V2_UNAVAILABLE,
            )
        }
    }

    fun reportPairingError(message: String) {
        _uiState.update { it.copy(pairingError = message, isConnecting = false) }
    }

    fun reportTerminalError(message: String) {
        emit(V2UiEffect.Notice(message))
    }

    fun offerRelayV2Enrollment(rawPayload: String) {
        viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            handleRelayV2EnrollmentOffer(
                result = relayV2EnrollmentReviewSession.offer(rawPayload),
                invalidMessage = "This Relay v2 enrollment payload is invalid",
            )
        }
    }

    fun offerManualRelayV2Enrollment(
        issuerUrl: String,
        oneTimeEnrollmentToken: String,
    ) {
        viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            handleRelayV2EnrollmentOffer(
                result = relayV2EnrollmentReviewSession.offerManual(
                    issuerUrl = issuerUrl,
                    oneTimeEnrollmentToken = oneTimeEnrollmentToken,
                ),
                invalidMessage = "This Relay v2 enrollment token or issuer is invalid",
            )
        }
    }

    private suspend fun handleRelayV2EnrollmentOffer(
        result: RelayV2EnrollmentOfferResult,
        invalidMessage: String,
    ) {
        when (result) {
            RelayV2EnrollmentOfferResult.ACCEPTED -> publishRelayV2EnrollmentReviewState()
            RelayV2EnrollmentOfferResult.REJECTED ->
                emit(V2UiEffect.Notice(invalidMessage))
            RelayV2EnrollmentOfferResult.REVIEW_ALREADY_PRESENT ->
                emit(V2UiEffect.Notice("Finish or cancel the current enrollment review first"))
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

    fun showPairing() {
        _uiState.update {
            it.copy(
                pairingRequired = true,
                pairingError = null,
            )
        }
    }

    fun dismissPairing(): Boolean {
        if (!_uiState.value.paired) return false
        _uiState.update {
            it.copy(
                pairingRequired = false,
                pairingError = null,
            )
        }
        return true
    }

    fun forgetPairing() {
        if (demoMode) {
            _uiState.update { it.copy(paired = false, pairingRequired = true) }
            return
        }
        val admission = _uiState.value.relayStartupAdmission
        if (admission != RelayStartupAdmissionState.RELAY_V2 &&
            admission != RelayStartupAdmissionState.RELAY_V2_SELF_REVOKE_QUARANTINED
        ) {
            emit(V2UiEffect.Notice("The active profile cannot be safely removed yet"))
            return
        }
        viewModelScope.launch {
            runCatching {
                when (admission) {
                    RelayStartupAdmissionState.RELAY_V2,
                    RelayStartupAdmissionState.RELAY_V2_SELF_REVOKE_QUARANTINED,
                    -> trackProfileMutation {
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
        _larkBindings.value = LarkBindingsState()
        _uiState.update {
            it.copy(
                relayStartupAdmission = RelayStartupAdmissionState.RELAY_V2_ENROLLMENT_REQUIRED,
                relayV2ProfileConnection = RelayV2ProfileConnectionState.STOPPED,
                relayV2ProfileFailureCode = null,
                agentCapabilityAvailability = AgentCapabilityAvailability.UNAVAILABLE,
                initialized = true,
                paired = false,
                pairingRequired = true,
                pairingError = null,
                isConnecting = false,
                preferences = clearedPreferences,
                hosts = emptyList(),
                scopes = emptyList(),
                sessions = emptyList(),
                terminal = TerminalStreamState(),
                selectedScopeId = null,
            )
        }
        emitAwait(V2UiEffect.ProfileCleared)
    }

    fun retryConnection() {
        if (demoMode) return
        if (_uiState.value.relayStartupAdmission == RelayStartupAdmissionState.RELAY_V2) {
            connectRelayV2ActiveProfile()
            return
        }
        _uiState.update { it.copy(actionError = "Relay v2 is not connected") }
    }

    fun refresh() {
        if (_uiState.value.relayStartupAdmission == RelayStartupAdmissionState.RELAY_V2) {
            val composition = synchronized(relayV2UiFenceLock) { relayV2Composition }
            if (composition == null) {
                _uiState.update {
                    it.copy(actionError = "Reconnect before refreshing Relay v2 sessions")
                }
                return
            }
            viewModelScope.launch {
                val result = composition.manualResync()
                synchronized(relayV2UiFenceLock) {
                    if (relayV2Composition !== composition ||
                        _uiState.value.relayStartupAdmission !=
                        RelayStartupAdmissionState.RELAY_V2
                    ) {
                        return@synchronized
                    }
                    _uiState.value = when (result) {
                        RelayV2ManualResyncResult.Started,
                        RelayV2ManualResyncResult.AlreadyInProgress,
                        -> _uiState.value.copy(actionError = null)
                        RelayV2ManualResyncResult.NotOnline ->
                            _uiState.value.copy(
                                actionError =
                                    "Reconnect before refreshing Relay v2 sessions",
                            )
                        RelayV2ManualResyncResult.ProfileMismatch,
                        RelayV2ManualResyncResult.Unavailable,
                        -> _uiState.value.copy(
                            actionError =
                                "Relay v2 session refresh is unavailable for this connection",
                        )
                    }
                }
            }
            return
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
        _uiState.update { state ->
            state.copy(
                preferences = state.preferences.copy(preferredHostId = normalized),
                selectedScopeId = null,
            )
        }
        refreshDecoratedHealth()
        viewModelScope.launch {
            preferencesStore.setPreferredHostAndScope(normalized, DEFAULT_SCOPE_ID)
        }
    }

    /**
     * Stable chat projection owned by the ViewModel and populated by the v2 composition.
     */
    private val _agentChat: MutableStateFlow<RelayChatState> = MutableStateFlow(RelayChatState())
    val agentChat: kotlinx.coroutines.flow.StateFlow<RelayChatState> = _agentChat.asStateFlow()
    private val _larkBindings = MutableStateFlow(LarkBindingsState())
    val larkBindings: kotlinx.coroutines.flow.StateFlow<LarkBindingsState> =
        _larkBindings.asStateFlow()

    fun sendAgentChatMessage(session: RelaySession, message: String) {
        val normalized = message.trim()
        if (normalized.isBlank()) return
        val composition = synchronized(relayV2UiFenceLock) { relayV2Composition } ?: return
        composition.sendAgentChatMessage(session.scopeId, session.protocolSessionId, normalized)
    }

    fun fetchAgentChatHistory(session: RelaySession) {
        val composition = synchronized(relayV2UiFenceLock) { relayV2Composition } ?: return
        composition.fetchAgentChatHistory(session.scopeId, session.protocolSessionId)
    }

    fun retryFailedAgentChatMessages(session: RelaySession) {
        val composition = synchronized(relayV2UiFenceLock) { relayV2Composition } ?: return
        val failed = _agentChat.value.pending(session.protocolSessionId).filter { it.failed }
        if (failed.isEmpty()) return
        _agentChat.value = RelayChatReducer.reduce(
            _agentChat.value,
            RelayChatMutation.RetryFailed(session.protocolSessionId),
        )
        failed.forEach { pending ->
            composition.sendAgentChatMessage(
                session.scopeId,
                session.protocolSessionId,
                pending.message,
            )
        }
    }

    fun refreshLarkBindings() {
        val composition = synchronized(relayV2UiFenceLock) { relayV2Composition }
        val anchor = _uiState.value.activeSessions.firstOrNull()
        if (composition == null || anchor == null) {
            _larkBindings.value = _larkBindings.value.copy(
                loading = false,
                busyBindingId = null,
                error = if (composition == null) {
                    "Reconnect Relay v2 to manage Lark bindings"
                } else {
                    "A Relay v2 session is required to manage Lark bindings"
                },
            )
            return
        }
        composition.fetchLarkBindings(anchor.scopeId, anchor.protocolSessionId)
    }

    fun updateLarkBindingReplyMode(bindingId: String, replyMode: String) {
        val normalizedId = bindingId.trim()
        if (normalizedId.isEmpty() || (replyMode != "topic" && replyMode != "direct")) return
        val composition = synchronized(relayV2UiFenceLock) { relayV2Composition } ?: return
        val anchor = _uiState.value.activeSessions.firstOrNull() ?: return
        composition.updateLarkBindingReplyMode(
            anchor.scopeId,
            anchor.protocolSessionId,
            normalizedId,
            replyMode,
        )
    }

    fun unlinkLarkBinding(bindingId: String) {
        val normalizedId = bindingId.trim()
        if (normalizedId.isEmpty()) return
        val composition = synchronized(relayV2UiFenceLock) { relayV2Composition } ?: return
        val anchor = _uiState.value.activeSessions.firstOrNull() ?: return
        composition.unlinkLarkBinding(
            anchor.scopeId,
            anchor.protocolSessionId,
            normalizedId,
        )
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
            var submissionAlreadyInFlight = false
            val admittedCreate = synchronized(relayV2UiFenceLock) {
                val composition = relayV2Composition
                val scopeCut = relayV2ScopeCreateCuts.value[hostId to request.scopeId]
                if (_uiState.value.relayStartupAdmission !=
                    RelayStartupAdmissionState.RELAY_V2 ||
                    composition == null || scopeCut == null
                ) {
                    null
                } else {
                    val reservedState = _uiState.value.beginCreationSubmission(
                        CreationTarget.WORKTREE,
                    )
                    if (reservedState == null) {
                        submissionAlreadyInFlight = true
                        null
                    } else {
                        _uiState.value = reservedState
                        composition to scopeCut
                    }
                }
            }
            if (admittedCreate == null) {
                if (submissionAlreadyInFlight) return
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
                val transition = synchronized(relayV2UiFenceLock) {
                    if (relayV2Composition !== composition ||
                        _uiState.value.relayStartupAdmission !=
                        RelayStartupAdmissionState.RELAY_V2
                    ) {
                        null
                    } else {
                        val transition = _uiState.value.afterRelayV2Creation(
                            target = CreationTarget.WORKTREE,
                            result = result,
                            rejectionMessage = (result as? RelayV2ScopeCreateResult.Rejected)
                                ?.failure
                                ?.createWorktreeUserMessage()
                                .orEmpty(),
                        )
                        _uiState.value = transition.state
                        transition
                    }
                }
                transition?.let { emit(it.effect) }
            }
            return
        }

        _uiState.update { it.copy(actionError = "Relay v2 is not connected") }
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
            var submissionAlreadyInFlight = false
            val admittedCreate = synchronized(relayV2UiFenceLock) {
                val composition = relayV2Composition
                val scopeCut = relayV2ScopeCreateCuts.value[selectedHost to scopeId]
                if (_uiState.value.relayStartupAdmission !=
                    RelayStartupAdmissionState.RELAY_V2 ||
                    composition == null || scopeCut == null
                ) {
                    null
                } else {
                    val reservedState = _uiState.value.beginCreationSubmission(
                        CreationTarget.TERMINAL,
                    )
                    if (reservedState == null) {
                        submissionAlreadyInFlight = true
                        null
                    } else {
                        _uiState.value = reservedState
                        composition to scopeCut
                    }
                }
            }
            if (admittedCreate == null) {
                if (submissionAlreadyInFlight) return
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
                val transition = synchronized(relayV2UiFenceLock) {
                    if (relayV2Composition !== composition ||
                        _uiState.value.relayStartupAdmission !=
                        RelayStartupAdmissionState.RELAY_V2
                    ) {
                        null
                    } else {
                        val transition = _uiState.value.afterRelayV2Creation(
                            target = CreationTarget.TERMINAL,
                            result = result,
                            rejectionMessage = (result as? RelayV2ScopeCreateResult.Rejected)
                                ?.failure
                                ?.createTerminalUserMessage()
                                .orEmpty(),
                        )
                        _uiState.value = transition.state
                        transition
                    }
                }
                transition?.let { emit(it.effect) }
            }
            return
        }
        _uiState.update { it.copy(actionError = "Relay v2 is not connected") }
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
        _uiState.update { it.copy(actionError = "Relay v2 is not connected") }
    }

    fun openTerminal(session: RelaySession, attachmentId: String) {
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
        }
    }

    internal fun openTerminal(
        session: RelaySession,
        attachmentId: String,
        rendererBinding: TerminalWebViewParserBinding,
    ) {
        if (demoMode || _uiState.value.relayStartupAdmission != RelayStartupAdmissionState.RELAY_V2) {
            return
        }
        val admitted = synchronized(relayV2UiFenceLock) {
            val composition = relayV2Composition
            val cut = relayV2SessionReplyCuts.value[session.stableId]
            val fence = cut?.let {
                RelayV2TerminalUiAttachmentFence(session.stableId, attachmentId, it)
            }
            if (composition == null || fence == null || !rendererBinding.isCurrent() ||
                !fence.isCurrent(attachmentId, relayV2SessionReplyCuts.value)
            ) {
                null
            } else {
                val previous = relayV2Terminal
                if (previous != null &&
                    previous.fence.retainsActiveRoute(attachmentId, _uiState.value.terminal) &&
                    previous.rendererBinding.isCurrent() &&
                    rendererBinding.isCurrent()
                ) {
                    return@synchronized RelayV2TerminalUiOpenAdmission.RetainedCurrent
                }
                val parser = RelayV2TerminalWebViewParserAdapter(
                    rendererBinding,
                    viewModelScope,
                )
                val issued = RelayV2UiTerminalAttachment(
                    composition = composition,
                    fence = fence,
                    parser = parser,
                    rendererBinding = rendererBinding,
                )
                val previousDetach = previous?.let {
                    val callbacks = it.parser.fenceAttachment()
                    Triple(it, it.lifecycle.requestDetach(), callbacks)
                }
                relayV2Terminal = issued
                _uiState.value = _uiState.value.copy(
                    terminal = TerminalStreamState(
                        sessionId = session.stableId,
                        status = ConnectionStatus.CONNECTING,
                    ),
                    actionError = null,
                )
                RelayV2TerminalUiOpenAdmission.Open(issued, previousDetach)
            }
        }
        if (admitted === RelayV2TerminalUiOpenAdmission.RetainedCurrent) return
        if (admitted == null) {
            _uiState.update { it.copy(actionError = "Relay v2 Session is no longer current") }
            return
        }
        check(admitted is RelayV2TerminalUiOpenAdmission.Open)
        viewModelScope.launch {
            val (issued, previousDetach) = admitted
            val composition = issued.composition
            val fence = issued.fence
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
            try {
                previousDetach?.let { (previous, detach, callbacks) ->
                    detachRelayV2TerminalAttachment(previous, detach, callbacks)
                }
                if (issued.lifecycle.detachRequested() || !rendererBinding.isCurrent()) {
                    issued.lifecycle.abandonOpening()
                    return@launch
                }
                val attachment = composition.attachTerminal(fence.sessionCut, issued.parser, observer)
                if (attachment == null) {
                    issued.parser.fenceAttachment()
                    issued.lifecycle.abandonOpening()
                    clearFailedRelayV2Terminal(
                        issued,
                        session.stableId,
                        "Relay v2 terminal attachment is stale",
                    )
                    return@launch
                }
                when (issued.lifecycle.install(attachment)) {
                    RelayV2TerminalAttachmentInstall.Current -> Unit
                    is RelayV2TerminalAttachmentInstall.Detach -> {
                        detachRelayV2TerminalAttachment(
                            issued,
                            RelayV2TerminalAttachmentDetach.Detach(attachment),
                        )
                        return@launch
                    }
                }
                val current = synchronized(relayV2UiFenceLock) {
                    relayV2Terminal === issued &&
                        relayV2Composition === composition &&
                        issued.fence.ownsRoute(attachmentId) &&
                        rendererBinding.isCurrent()
                }
                val openingCurrent = current && updateCurrentTerminal(issued) {
                    it.copy(
                        terminal = TerminalStreamState(
                            sessionId = session.stableId,
                            status = ConnectionStatus.CONNECTING,
                        ),
                    )
                }
                if (!openingCurrent ||
                    !composition.openTerminal(
                        attachment,
                        DEFAULT_TERMINAL_COLS,
                        DEFAULT_TERMINAL_ROWS,
                    )
                ) {
                    issued.parser.fenceAttachment()
                    detachRelayV2TerminalAttachment(issued)
                    clearFailedRelayV2Terminal(
                        issued,
                        session.stableId,
                        "Relay v2 terminal could not be opened",
                    )
                }
            } catch (cancelled: CancellationException) {
                issued.parser.fenceAttachment()
                if (!issued.lifecycle.abandonOpening()) {
                    try {
                        detachRelayV2TerminalAttachment(issued)
                    } catch (detachFailure: Throwable) {
                        if (detachFailure !== cancelled) {
                            cancelled.addSuppressed(detachFailure)
                        }
                    }
                }
                throw cancelled
            } catch (_: Exception) {
                issued.parser.fenceAttachment()
                if (!issued.lifecycle.abandonOpening()) {
                    try {
                        detachRelayV2TerminalAttachment(issued)
                    } catch (_: Exception) {
                        // Keep the lifecycle failed and any held parser false unsettled.
                    }
                }
                clearFailedRelayV2Terminal(
                    issued,
                    session.stableId,
                    "Relay v2 terminal could not be opened",
                )
            }
        }
    }

    private suspend fun detachRelayV2TerminalAttachment(
        issued: RelayV2UiTerminalAttachment,
        claimed: RelayV2TerminalAttachmentDetach<RelayV2TerminalAttachment> =
            issued.lifecycle.requestDetach(),
        callbackBarrier: RelayV2TerminalParserCallbackBarrier =
            issued.parser.fenceAttachment(),
    ) {
        // Loss/replacement admission synchronously owns this exact fence. Drain every callback
        // admitted before that cut before runtime attachment ownership is withdrawn.
        callbackBarrier.awaitDrained()
        when (val detach = claimed) {
            is RelayV2TerminalAttachmentDetach.Detach -> {
                try {
                    issued.composition.detachTerminal(detach.attachment)
                } catch (failure: Throwable) {
                    issued.lifecycle.failDetach(detach.attachment, failure)
                    throw failure
                }
                issued.lifecycle.completeDetach(detach.attachment)
            }
            RelayV2TerminalAttachmentDetach.Await -> issued.lifecycle.awaitDetached()
            RelayV2TerminalAttachmentDetach.Detached -> Unit
        }
    }

    private fun clearFailedRelayV2Terminal(
        issued: RelayV2UiTerminalAttachment,
        sessionId: String,
        message: String,
    ) {
        synchronized(relayV2UiFenceLock) {
            if (relayV2Terminal !== issued || relayV2Composition !== issued.composition) return
            relayV2Terminal = null
            _uiState.value = _uiState.value.copy(
                terminal = TerminalStreamState(
                    sessionId = sessionId,
                    status = ConnectionStatus.OFFLINE,
                ),
                actionError = message,
            )
        }
    }

    internal fun recoverTerminalRendererLoss(
        attachmentId: String,
        rendererLoss: TerminalWebViewRendererLoss,
    ) {
        if (demoMode ||
            _uiState.value.relayStartupAdmission != RelayStartupAdmissionState.RELAY_V2
        ) {
            rendererLoss.completeAfterAttachmentDetach()
            if (rendererLoss.isRendererLoss) {
                val reason = if (rendererLoss.didCrash) {
                    "renderer_crashed"
                } else {
                    "renderer_gone"
                }
                _uiState.update {
                    it.copy(
                        terminal = TerminalStreamState(
                            sessionId = it.terminal.sessionId,
                            status = ConnectionStatus.OFFLINE,
                            resetReason = reason,
                        ),
                        actionError = "Terminal renderer is unavailable",
                    )
                }
            }
            return
        }
        val current = synchronized(relayV2UiFenceLock) {
            relayV2Terminal?.takeIf {
                it.fence.ownsRoute(attachmentId) &&
                    rendererLoss.fences(it.rendererBinding)
            }?.let {
                val callbacks = it.parser.fenceAttachment()
                relayV2Terminal = null
                Triple(it, it.lifecycle.requestDetach(), callbacks)
            }
        }
        if (current == null) {
            // No matching parser attachment was published for this exact view generation.
            val rebuilt = rendererLoss.completeAfterAttachmentDetach()
            if (!rebuilt && rendererLoss.isRendererLoss) {
                publishTerminalRendererRecoveryPaused(sessionId = null)
            }
            return
        }
        viewModelScope.launch {
            val (issued, detach, callbacks) = current
            try {
                detachRelayV2TerminalAttachment(issued, detach, callbacks)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                emit(V2UiEffect.Notice("Terminal renderer recovery could not fully detach"))
                _uiState.update {
                    it.copy(
                        terminal = TerminalStreamState(
                            sessionId = issued.fence.sessionStableId,
                            status = ConnectionStatus.OFFLINE,
                            resetReason = "terminal_view_detach_failed",
                        ),
                        actionError = "Terminal view recovery could not detach safely",
                    )
                }
                return@launch
            }
            // This settles the controller's held platform false only after the adapter has fenced
            // and drained every pre-cut callback and the production attachment is withdrawn.
            val rebuilt = rendererLoss.completeAfterAttachmentDetach()
            if (!rebuilt && rendererLoss.isRendererLoss) {
                publishTerminalRendererRecoveryPaused(issued.fence.sessionStableId)
            }
        }
    }

    private fun publishTerminalRendererRecoveryPaused(sessionId: String?) {
        _uiState.update {
            it.copy(
                terminal = TerminalStreamState(
                    sessionId = sessionId ?: it.terminal.sessionId,
                    status = ConnectionStatus.OFFLINE,
                    resetReason = "renderer_recovery_exhausted",
                ),
                actionError = "Terminal renderer recovery is paused",
            )
        }
    }

    fun retryTerminalInput(session: RelaySession, attachmentId: String) {
        if (demoMode) {
            openTerminal(session, attachmentId)
        }
    }

    fun closeTerminal(attachmentId: String) {
        if (demoMode) return
        if (_uiState.value.relayStartupAdmission == RelayStartupAdmissionState.RELAY_V2) {
            val current = synchronized(relayV2UiFenceLock) {
                relayV2Terminal?.takeIf { it.fence.ownsRoute(attachmentId) }
                    .also { if (it != null) relayV2Terminal = null }
            } ?: return
            val attachment = current.lifecycle.attached()
            if (attachment == null) {
                current.parser.fenceAttachment()
                viewModelScope.launch { detachRelayV2TerminalAttachment(current) }
                return
            }
            viewModelScope.launch {
                if (!current.composition.closeTerminal(attachment)) {
                    current.composition.detachTerminal(attachment)
                }
            }
        }
    }

    fun sendTerminalInput(data: String, attachmentId: String) {
        if (demoMode) {
            emit(V2UiEffect.TerminalWrite(data))
            return
        }
        when (_uiState.value.relayStartupAdmission) {
            RelayStartupAdmissionState.RELAY_V2 -> {
                val current = synchronized(relayV2UiFenceLock) {
                    relayV2Terminal?.takeIf {
                        it.fence.ownsRoute(attachmentId)
                    }
                } ?: return
                val attachment = current.lifecycle.attached() ?: return
                viewModelScope.launch {
                    if (!current.composition.sendTerminalInput(
                            attachment,
                            data.toByteArray(Charsets.UTF_8),
                        )
                    ) {
                        updateCurrentTerminal(current) {
                            it.copy(actionError = "Relay v2 terminal input was not admitted")
                        }
                    }
                }
            }
            else -> Unit
        }
    }

    fun resizeTerminal(cols: Int, rows: Int, attachmentId: String) {
        if (demoMode) return
        if (_uiState.value.relayStartupAdmission == RelayStartupAdmissionState.RELAY_V2) {
            val current = synchronized(relayV2UiFenceLock) {
                relayV2Terminal?.takeIf {
                    it.fence.ownsRoute(attachmentId)
                }
            } ?: return
            val attachment = current.lifecycle.attached() ?: return
            viewModelScope.launch {
                current.composition.resizeTerminal(attachment, cols, rows)
            }
        }
    }

    private fun updateCurrentTerminal(
        expected: RelayV2UiTerminalAttachment,
        update: (V2UiState) -> V2UiState,
    ): Boolean = synchronized(relayV2UiFenceLock) {
        if (relayV2Terminal !== expected || relayV2Composition !== expected.composition) {
            return@synchronized false
        }
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
            viewModelScope.launch {
                if (enabled) requestNotificationPermissionFromExplicitToggle()
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
            notificationPermissionRequestClaim = null
            relayV2Composition
        }
        composition?.let { current ->
            viewModelScope.launch { syncAgentNotificationConfig(current) }
        }
    }

    private suspend fun requestNotificationPermissionFromExplicitToggle() {
        val composition = synchronized(relayV2UiFenceLock) { relayV2Composition } ?: return
        requestNotificationPermission(composition, automatic = false)
    }

    private suspend fun requestNotificationPermissionForNegotiatedPreferences(
        expectedComposition: RelayV2BaseRuntimeComposition,
    ) = requestNotificationPermission(expectedComposition, automatic = true)

    private suspend fun requestNotificationPermission(
        expectedComposition: RelayV2BaseRuntimeComposition,
        automatic: Boolean,
    ) {
        val requestClaim = synchronized(relayV2UiFenceLock) {
            if (notificationPermissionRequestPending ||
                !notificationPermissionRequestEligibleLocked(expectedComposition, automatic)
            ) {
                null
            } else {
                val claim = Any()
                notificationPermissionRequestClaim = claim
                notificationPermissionRequestPending = true
                claim
            }
        } ?: return
        val durableClaimed = try {
            preferencesStore.claimAutomaticAgentNotificationPermissionOffer()
        } catch (cancelled: CancellationException) {
            clearNotificationPermissionRequestClaim(requestClaim)
            throw cancelled
        } catch (_: Throwable) {
            null
        }
        // Automatic activation owns only a fresh durable claim. An explicit toggle may retry
        // after denial, but still requires the already-offered marker to be durably readable.
        if (durableClaimed == null || (automatic && durableClaimed == false)) {
            clearNotificationPermissionRequestClaim(requestClaim)
            return
        }
        val stillCurrent = synchronized(relayV2UiFenceLock) {
            notificationPermissionRequestClaim === requestClaim &&
                notificationPermissionRequestPending &&
                notificationPermissionRequestEligibleLocked(expectedComposition, automatic)
        }
        if (!stillCurrent) {
            clearNotificationPermissionRequestClaim(requestClaim)
            return
        }
        if (notificationPermissionRequestChannel.trySend(Unit).isFailure) {
            clearNotificationPermissionRequestClaim(requestClaim)
        }
    }

    private fun notificationPermissionRequestEligibleLocked(
        expectedComposition: RelayV2BaseRuntimeComposition,
        automatic: Boolean,
    ): Boolean {
        val state = _uiState.value
        return !notificationPermissionGranted &&
            relayV2Composition === expectedComposition &&
            state.relayStartupAdmission == RelayStartupAdmissionState.RELAY_V2 &&
            state.agentCapabilityAvailability == AgentCapabilityAvailability.AVAILABLE &&
            (!automatic || relayV2NotificationPreferencesLoaded && with(state.preferences) {
                waitingNotifications || failedNotifications || completedNotifications
            })
    }

    private fun clearNotificationPermissionRequestClaim(requestClaim: Any) {
        synchronized(relayV2UiFenceLock) {
            if (notificationPermissionRequestClaim === requestClaim) {
                notificationPermissionRequestClaim = null
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
            val lastActivationFailure = lastRelayV2ActivationFailureCause
            if (lastActivationFailure != null) {
                appendLine("lastActivationFailureAtMs=$lastRelayV2ActivationFailureAtMs")
                appendLine("lastActivationFailure=$lastActivationFailure")
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
        val result = trackProfileMutation {
            requireRelayV2ProfileRuntime().confirmEnrollment(confirmed)
        }
        return result
    }

    private suspend fun activateRelayV2Profile(expectedProfile: RelayV2Profile) {
        try {
            trackProfileMutation {
                val runtime = requireRelayV2ProfileRuntime()
                val admission = runtime.admitStartup()
                check(admission.state == RelayStartupAdmissionState.RELAY_V2)
                val admittedProfile = requireNotNull(admission.relayV2Profile)
                // Reconciliation may repair the durable credential (bump credentialVersion) or a
                // prior partial activation may have already persisted connect consent. Both are
                // benign for the same activation lineage; only identity-bearing drift (endpoint,
                // host, client lineage) must refuse the confirmed activation.
                check(
                    admittedProfile == expectedProfile ||
                        admittedProfile.sharesActivationLineageWith(expectedProfile),
                ) {
                    "Confirmed Relay v2 profile changed before activation"
                }
                // The explicit second Connect is the exact-profile connect consent; the runtime is
                // started from the profile returned by the durable CAS owner. A profile that was
                // already consented (autoConnect == true) is its own consent receipt, matching the
                // explicit Connect/Retry path; the CAS owner stays idempotent for the exact profile.
                val consentedProfile = if (admittedProfile.autoConnect) {
                    admittedProfile
                } else {
                    runtime.consentAutoConnect(admittedProfile)
                        ?: error(
                            "Relay v2 connect consent was rejected by the profile owner; " +
                                "a self-revoke, pending activation, or endpoint change may be in progress",
                        )
                }
                applyStartupAdmission(admission)
                try {
                    startRelayV2BaseRuntime(consentedProfile)
                } catch (failure: Throwable) {
                    applyStartupAdmission(
                        RelayStartupAdmission(
                            state = RelayStartupAdmissionState.RELAY_V2_ADMISSION_FAILED,
                            message = "Relay v2 base runtime activation failed closed.",
                        ),
                    )
                    throw failure
                }
            }
        } catch (failure: Throwable) {
            if (failure is CancellationException) throw failure
            recordRelayV2ActivationFailure(failure)
            throw failure
        }
    }

    /**
     * Bounded in-memory breadcrumb for the last Relay v2 activation failure. Held in state only —
     * the app deliberately has no logging — and surfaced on the existing sanitized diagnostics
     * copy surface. The cause is the same bounded, static-English message shown in the review UI
     * (credential-exchange failures are already redacted by design).
     */
    @Volatile
    private var lastRelayV2ActivationFailureAtMs: Long = 0

    @Volatile
    private var lastRelayV2ActivationFailureCause: String? = null

    private fun recordRelayV2ActivationFailure(failure: Throwable) {
        val cause = failure.message?.takeIf(String::isNotBlank)
            ?: failure::class.simpleName?.takeIf(String::isNotBlank)
            ?: return
        lastRelayV2ActivationFailureAtMs = System.currentTimeMillis()
        lastRelayV2ActivationFailureCause =
            cause.replace('\n', ' ').replace('\r', ' ').trim().take(MAX_ACTIVATION_FAILURE_CAUSE)
    }

    /**
     * Explicit Connect/Retry for the admitted Relay v2 profile after a cold restart with
     * `autoConnect=false`: persists exact-profile consent through the CAS owner, then enters the
     * existing v2 composition owner (or starts it from the consented profile).
     *
     * This explicit action is also the only non-rollover callsite that may reach the network
     * refresh owner. When the probe reports [RelayV2RefreshRequirement.RefreshRequired], one
     * exact action reservation (a double-tap/resurrection fence under [relayV2UiFenceLock]; it
     * owns no credential state and is not a second mutation coordinator) orders the winner as:
     * reserve, await the old composition's exact disconnect drain, finally close and clear the
     * owner reference, refresh through the existing owner, re-run closed startup admission, and
     * only then start the successor; every step binds the exact admitted profile, so identity
     * or slot drift releases the action to a concurrent profile switch without refreshing,
     * consenting, or starting the switched-to profile. A drain failure fails closed without
     * refreshing or starting. The probe runs only while no live composition exists (absent, terminally
     * failed, or never connected), so a live connection is never rotated under or retired.
     * Cold-start admission and background reconnect remain network-free; every refresh failure
     * keeps its typed error on the existing health/pairing surfaces.
     */
    private fun connectRelayV2ActiveProfile() {
        viewModelScope.launch {
            trackProfileMutation {
                val runtime = requireRelayV2ProfileRuntime()
                val admission = runtime.admitStartup()
                if (admission.state != RelayStartupAdmissionState.RELAY_V2) {
                    return@trackProfileMutation
                }
                val admittedProfile = requireNotNull(admission.relayV2Profile)
                val composition = synchronized(relayV2UiFenceLock) { relayV2Composition }
                val connectEligible = composition == null ||
                    synchronized(relayV2UiFenceLock) {
                        val phase = _uiState.value.relayV2ProfileConnection
                        phase == RelayV2ProfileConnectionState.FAILED ||
                            phase == RelayV2ProfileConnectionState.STOPPED
                    }
                var reservation: RelayV2ExplicitRefreshReservation? = null
                try {
                    if (connectEligible) {
                        when (runtime.probeRefreshRequirement(admittedProfile)) {
                            RelayV2RefreshRequirement.NoRefreshRequired -> Unit
                            RelayV2RefreshRequirement.RefreshCredentialExpired -> {
                                reservation = reserveRelayV2ExplicitRefresh(
                                    expectedIdentity = admittedProfile.identity,
                                    retiredComposition = composition,
                                ) ?: return@trackProfileMutation
                                applyStartupAdmission(
                                    RelayStartupAdmission(
                                        state = RelayStartupAdmissionState
                                            .RELAY_V2_REENROLLMENT_REQUIRED,
                                        message = "Relay v2 re-enrollment is required.",
                                    ),
                                )
                                emit(
                                    V2UiEffect.Notice(
                                        "Relay v2 re-enrollment is required.",
                                    ),
                                )
                                return@trackProfileMutation
                            }
                            RelayV2RefreshRequirement.RefreshRequired -> {
                                reservation = reserveRelayV2ExplicitRefresh(
                                    expectedIdentity = admittedProfile.identity,
                                    retiredComposition = composition,
                                ) ?: return@trackProfileMutation
                                if (composition != null) {
                                    // The old owner is retired before any network call: await
                                    // its exact disconnect drain (the same barrier the profile
                                    // disconnect path uses), then finally close and clear the
                                    // owner reference. A failed drain is never replaced with a
                                    // receipt and never reaches the refresh or the successor.
                                    var drainCompleted = false
                                    try {
                                        composition.disconnectAndDrain(
                                            admittedProfile.identity,
                                            "relay-v2-refresh-retire-${UUID.randomUUID()}",
                                        )
                                        drainCompleted = true
                                    } catch (error: Throwable) {
                                        // The actor reports a missing clean drain with its own
                                        // CancellationException; that typed failure is never a
                                        // receipt, while real cancellation still propagates.
                                        if (error is CancellationException &&
                                            coroutineContext[Job]?.isActive != true
                                        ) {
                                            throw error
                                        }
                                    } finally {
                                        runCatching { composition.close() }
                                        RelayV2ConnectionRegistry.clear(composition)
                                        synchronized(relayV2UiFenceLock) {
                                            if (relayV2Composition === composition) {
                                                if (drainCompleted) relayV2Composition = null
                                                relayV2NotificationProfileActive = false
                                                relayV2SessionReplyCuts.value = emptyMap()
                                                relayV2ScopeCreateCuts.value = emptyMap()
                                                relayV2Terminal = null
                                            }
                                        }
                                    }
                                    if (!drainCompleted) {
                                        applyRelayV2RefreshFailure(
                                            code = "RUNTIME_DRAIN_FAILED",
                                            message = "Relay v2 runtime could not finish its " +
                                                "previous connection cleanly.",
                                        )
                                        return@trackProfileMutation
                                    }
                                }
                                // Refresh, exact re-admission, consent, and the exact-owner
                                // install all settle inside the profile runtime's single
                                // coordinator lease, so a concurrent profile switch cannot
                                // interleave between them. The install callback only starts the
                                // successor while this exact reservation and the drained slot
                                // are still current; any drift releases the action without
                                // refreshing, consenting, or starting the switched-to profile.
                                val expectedProfile = admittedProfile
                                var installFailed = false
                                val outcome = try {
                                    runtime.orchestrateExplicitConnectRefresh(expectedProfile) {
                                        consented ->
                                        synchronized(relayV2UiFenceLock) {
                                            val exact = relayV2ExplicitRefreshReservation
                                            if (exact != null &&
                                                exact === reservation &&
                                                exact.expectedIdentity == consented.identity &&
                                                consented.identity == expectedProfile.identity &&
                                                exact.retiredComposition === composition &&
                                                relayV2Composition == null
                                            ) {
                                                try {
                                                    startRelayV2BaseRuntime(consented)
                                                    true
                                                } catch (error: Throwable) {
                                                    installFailed = true
                                                    false
                                                }
                                            } else {
                                                false
                                            }
                                        }
                                    }
                                } catch (error: CancellationException) {
                                    throw error
                                } catch (error: RelayV2CredentialExchangeException) {
                                    applyRelayV2RefreshFailure(
                                        code = error.errorCode ?: error.kind.name,
                                        message = "Relay v2 credential refresh failed " +
                                            "(${error.errorCode ?: error.kind.name}).",
                                    )
                                    return@trackProfileMutation
                                } catch (error: Throwable) {
                                    applyRelayV2RefreshFailure(
                                        code = "REFRESH_UNAVAILABLE",
                                        message = "Relay v2 credential refresh failed " +
                                            "(REFRESH_UNAVAILABLE).",
                                    )
                                    return@trackProfileMutation
                                }
                                when (outcome) {
                                    is RelayV2ExplicitConnectRefreshResult
                                        .SuccessorInstalled,
                                    -> Unit
                                    is RelayV2ExplicitConnectRefreshResult
                                        .ActiveProfileChanged,
                                    -> {
                                        if (installFailed) {
                                            applyRelayV2RefreshFailure(
                                                code = "SUCCESSOR_INSTALL_FAILED",
                                                message = "Relay v2 runtime could not start " +
                                                    "after the credential refresh.",
                                            )
                                        }
                                        // Otherwise identity/slot drift: a concurrent profile
                                        // switch owns the UI now.
                                    }
                                    is RelayV2ExplicitConnectRefreshResult.AdmissionSettled ->
                                        applyStartupAdmission(
                                            outcome.admission.toRelayStartupAdmission(),
                                        )
                                    is RelayV2ExplicitConnectRefreshResult
                                        .ProfileReconciliationFailed,
                                    -> applyRelayV2RefreshFailure(
                                        code = outcome.failure.failure.name,
                                        message = "Relay v2 credential refresh failed " +
                                            "(${outcome.failure.failure.name}).",
                                    )
                                }
                                return@trackProfileMutation
                            }
                        }
                    }
                    // Consent already persisted only needs the composition owner; otherwise the
                    // explicit Connect/Retry persists exact-profile consent through the CAS owner.
                    val consentedProfile = if (admittedProfile.autoConnect) {
                        admittedProfile
                    } else {
                        runtime.consentAutoConnect(admittedProfile) ?: return@trackProfileMutation
                    }
                    val currentComposition = synchronized(relayV2UiFenceLock) {
                        if (relayV2ExplicitRefreshReservation != null) {
                            // An in-flight explicit refresh action owns the pending successor.
                            return@trackProfileMutation
                        }
                        relayV2Composition
                    }
                    if (currentComposition == null) {
                        startRelayV2BaseRuntime(consentedProfile)
                    } else {
                        when (val retry = currentComposition.retryNow(consentedProfile)) {
                            RelayV2RetryNowResult.Started,
                            RelayV2RetryNowResult.ArmedForRecovery,
                            RelayV2RetryNowResult.AlreadyInProgress,
                            -> Unit
                            is RelayV2RetryNowResult.TerminalFailure -> {
                                reservation = reserveRelayV2ExplicitRefresh(
                                    expectedIdentity = consentedProfile.identity,
                                    retiredComposition = currentComposition,
                                ) ?: return@trackProfileMutation
                                replaceTerminalRelayV2Composition(
                                    runtime = runtime,
                                    failedComposition = currentComposition,
                                    expectedProfile = consentedProfile,
                                    reservation = checkNotNull(reservation),
                                )
                            }
                            RelayV2RetryNowResult.Closed ->
                                applyRelayV2RefreshFailure(
                                    code = "RUNTIME_CLOSED",
                                    message = "Relay v2 runtime is closed.",
                                )
                            RelayV2RetryNowResult.ProfileMismatch ->
                                applyRelayV2RefreshFailure(
                                    code = "PROFILE_CHANGED",
                                    message = "Relay v2 profile changed before retry.",
                                )
                        }
                    }
                } finally {
                    if (reservation != null) {
                        synchronized(relayV2UiFenceLock) {
                            if (relayV2ExplicitRefreshReservation === reservation) {
                                relayV2ExplicitRefreshReservation = null
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Retires a terminally failed composition and installs a fresh owner from a newly admitted
     * view of the same exact profile. A missing drain, changed profile, or install failure clears
     * the retired UI slot and fails closed.
     */
    private suspend fun replaceTerminalRelayV2Composition(
        runtime: RelayV2ProfileRuntimeAdapter,
        failedComposition: RelayV2BaseRuntimeComposition,
        expectedProfile: RelayV2Profile,
        reservation: RelayV2ExplicitRefreshReservation,
    ) {
        var drainCompleted = false
        try {
            failedComposition.disconnectAndDrain(
                expectedProfile.identity,
                "relay-v2-retry-retire-${UUID.randomUUID()}",
            )
            drainCompleted = true
        } catch (error: Throwable) {
            if (error is CancellationException &&
                currentCoroutineContext()[Job]?.isActive != true
            ) {
                throw error
            }
        } finally {
            runCatching { failedComposition.close() }
            RelayV2ConnectionRegistry.clear(failedComposition)
            synchronized(relayV2UiFenceLock) {
                if (relayV2Composition === failedComposition &&
                    relayV2ExplicitRefreshReservation === reservation
                ) {
                    relayV2Composition = null
                    relayV2NotificationProfileActive = false
                    relayV2SessionReplyCuts.value = emptyMap()
                    relayV2ScopeCreateCuts.value = emptyMap()
                    relayV2Terminal = null
                    _uiState.value = _uiState.value.copy(
                        agentCapabilityAvailability = AgentCapabilityAvailability.UNAVAILABLE,
                        scopes = emptyList(),
                        sessions = emptyList(),
                        terminal = TerminalStreamState(),
                    )
                }
            }
        }
        if (!drainCompleted) {
            applyRelayV2RefreshFailure(
                code = "RUNTIME_DRAIN_FAILED",
                message = "Relay v2 runtime could not finish its previous connection cleanly.",
            )
            return
        }

        var installFailed = false
        val outcome = runtime.installCurrentRuntimeReplacement(
            expectedIdentity = expectedProfile.identity,
        ) { currentProfile ->
            val installCurrent = synchronized(relayV2UiFenceLock) {
                relayV2ExplicitRefreshReservation === reservation &&
                    reservation.expectedIdentity == currentProfile.identity &&
                    reservation.retiredComposition === failedComposition &&
                    relayV2Composition == null &&
                    _uiState.value.relayStartupAdmission ==
                    RelayStartupAdmissionState.RELAY_V2
            }
            if (!installCurrent) {
                false
            } else {
                try {
                    startRelayV2BaseRuntime(currentProfile)
                    true
                } catch (_: Throwable) {
                    installFailed = true
                    false
                }
            }
        }
        when (outcome) {
            is RelayV2ExplicitConnectRefreshResult.SuccessorInstalled -> Unit
            is RelayV2ExplicitConnectRefreshResult.AdmissionSettled -> {
                if (outcome.admission == RelayV2StartupAdmissionResult.NoActiveProfile) {
                    applyRelayV2RefreshFailure(
                        code = "PROFILE_CHANGED",
                        message = "Relay v2 profile changed before retry.",
                    )
                } else {
                    applyStartupAdmission(outcome.admission.toRelayStartupAdmission())
                }
            }
            is RelayV2ExplicitConnectRefreshResult.ProfileReconciliationFailed ->
                applyRelayV2RefreshFailure(
                    code = outcome.failure.failure.name,
                    message = "Relay v2 runtime could not restart " +
                        "(${outcome.failure.failure.name}).",
                )
            is RelayV2ExplicitConnectRefreshResult.ActiveProfileChanged -> {
                if (installFailed) {
                    applyRelayV2RefreshFailure(
                        code = "SUCCESSOR_INSTALL_FAILED",
                        message = "Relay v2 runtime could not restart.",
                    )
                } else if (outcome.activeProfile == expectedProfile.identity) {
                    applyRelayV2RefreshFailure(
                        code = "PROFILE_CHANGED",
                        message = "Relay v2 profile changed before retry.",
                    )
                }
                // Otherwise the profile or UI slot changed while the retired owner drained.
            }
        }
    }

    /**
     * Registers this explicit Connect/Retry refresh action under [relayV2UiFenceLock], or
     * returns null when another such action is already in flight. The reservation only fences
     * double-taps and old-owner resurrection for the duration of one refresh/retire action; it
     * owns no credential state and is not a second mutation coordinator.
     */
    private fun reserveRelayV2ExplicitRefresh(
        expectedIdentity: RelayActiveProfileIdentity,
        retiredComposition: RelayV2BaseRuntimeComposition?,
    ): RelayV2ExplicitRefreshReservation? = synchronized(relayV2UiFenceLock) {
        if (relayV2ExplicitRefreshReservation != null) {
            null
        } else {
            RelayV2ExplicitRefreshReservation(expectedIdentity, retiredComposition).also {
                relayV2ExplicitRefreshReservation = it
            }
        }
    }

    /** One in-flight explicit refresh action bound to its exact profile and retired owner. */
    private class RelayV2ExplicitRefreshReservation(
        val expectedIdentity: RelayActiveProfileIdentity,
        val retiredComposition: RelayV2BaseRuntimeComposition?,
    )

    /** Surfaces a typed explicit-path refresh failure on the existing health/pairing state. */
    private fun applyRelayV2RefreshFailure(code: String, message: String) {
        rawHealth = rawHealth.copy(errorCode = code, errorMessage = message)
        synchronized(relayV2UiFenceLock) {
            _uiState.value = _uiState.value.copy(
                isConnecting = false,
                pairingError = message,
                health = decorateHealth(rawHealth, _uiState.value),
            )
        }
        emit(V2UiEffect.Notice(message))
    }

    /** Explicit credential maintenance; this does not start or replace a socket. */
    internal suspend fun refreshRelayV2Credential(): RelayV2RefreshApplyResult =
        trackProfileMutation {
            requireRelayV2ProfileRuntime().refreshCredential()
        }

    private fun requireRelayV2ProfileRuntime(): RelayV2ProfileRuntimeAdapter =
        checkNotNull(relayV2ProfileRuntime) {
            "Relay v2 profile runtime is not initialized"
        }

    override fun onCleared() {
        // The v2 composition is owned by RelayV2ConnectionRegistry (process-level) and is kept
        // alive by RelayConnectionService; a recreated ViewModel re-attaches to it. Only detach the
        // UI-facing references here.
        synchronized(relayV2UiFenceLock) {
            relayV2NotificationProfileActive = false
            relayV2Terminal = null
            relayV2SessionReplyCuts.value = emptyMap()
            relayV2ScopeCreateCuts.value = emptyMap()
            relayV2Composition = null
            relayV2ExplicitRefreshReservation = null
        }
        relayV2ProfileRuntime = null
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
                preferredHostId = "mac-admin",
                autoConnect = true,
            ),
            hosts = DemoData.hosts(),
            scopes = DemoData.scopes(),
            sessions = sessions,
            health = DemoData.health(recovering = demoRecovering),
            demoTimelines = sessions.associate { it.stableId to DemoData.timeline(it.stableId) },
        )
    }

    /** Runtime profile entries already own the process-wide mutation coordinator. */
    private suspend fun <T> trackProfileMutation(block: suspend () -> T): T {
        synchronized(relayV2UiFenceLock) {
            profileMutationTrackerCount += 1
            profileMutationInProgress = true
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

    private fun applyStartupAdmission(admission: RelayStartupAdmission) {
        synchronized(relayV2UiFenceLock) {
            if (admission.state != RelayStartupAdmissionState.RELAY_V2) {
                relayV2SessionReplyCuts.value = emptyMap()
                relayV2ScopeCreateCuts.value = emptyMap()
            }
            val current = _uiState.value
            _uiState.value = when {
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
            try {
                val profileRuntime = container.createRelayV2ProfileRuntime(
                    disconnectBarrier = object : RelayProfileDisconnectBarrier {
                        override suspend fun awaitServerGrantRevocation(
                            profile: RelayActiveProfileIdentity,
                        ): Boolean {
                            val composition = synchronized(relayV2UiFenceLock) {
                                relayV2Composition
                            } ?: return false
                            return withTimeoutOrNull(
                                RELAY_V2_SERVER_REVOKE_PROPAGATION_TIMEOUT_MILLIS,
                            ) {
                                composition.state.first { runtime ->
                                    (runtime.failure as? RelayV2BaseRuntimeFailure.Connection)
                                        ?.failure?.code == RELAY_V2_GRANT_REVOKED
                                }
                                true
                            } ?: false
                        }

                        override suspend fun disconnectAndDrain(
                            profile: RelayActiveProfileIdentity,
                            barrierId: String,
                        ): RelayProfileDisconnectReceipt {
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
                                return if (composition == null) {
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
                                        RelayV2ConnectionRegistry.clear(composition)
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
                    },
                    clearEphemeralAfterDisconnect = {
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
                trackProfileMutation {
                    val startupAdmission = profileRuntime.admitStartup()
                    val admitted = startupAdmission
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
                                    "startup is blocked.",
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
                    message = "Relay v2 startup admission failed closed.",
                )
                applyStartupAdmission(failed)
                failed
            }
        }
    }

    /**
     * Retires a stale ViewModel-owned composition before a fresh base-runtime start.
     *
     * A previous partial activation can leave [relayV2Composition] referencing a terminally
     * failed, closed, or otherwise non-reusable composition. The check this replaces guarded
     * against double-starting; retiring the stale owner first preserves that invariant (only one
     * live composition is installed per ViewModel) while making a retried activation self-healing.
     * [RelayV2BaseRuntimeComposition.close] begins the async actor shutdown on the composition's
     * own scope and the registry is cleared so the foreground keep-alive never watches a retired
     * owner, so no old actor/service is leaked.
     */
    private fun retireStaleRelayV2Composition() {
        synchronized(relayV2UiFenceLock) {
            val stale = relayV2Composition ?: return
            runCatching { stale.close() }
            RelayV2ConnectionRegistry.clear(stale)
            relayV2Composition = null
            relayV2NotificationProfileActive = false
            relayV2SessionReplyCuts.value = emptyMap()
            relayV2ScopeCreateCuts.value = emptyMap()
            relayV2Terminal = null
            _larkBindings.value = LarkBindingsState()
            _uiState.value = _uiState.value.copy(
                agentCapabilityAvailability = AgentCapabilityAvailability.UNAVAILABLE,
                scopes = emptyList(),
                sessions = emptyList(),
                terminal = TerminalStreamState(),
            )
        }
    }

    private fun startRelayV2BaseRuntime(profile: RelayV2Profile) {
        retireStaleRelayV2Composition()
        // The composition lives on the process-level scope so it survives Activity/ViewModel
        // recreation. A recreated ViewModel re-attaches to the still-running composition instead of
        // building a fresh one; a stale owner is retired and replaced.
        val existing = RelayV2ConnectionRegistry.composition.value
        val composition: RelayV2BaseRuntimeComposition =
            if (existing != null && existing.isReusableFor(profile.identity)) {
                existing
            } else {
                existing?.close()
                RelayV2ConnectionRegistry.clear(existing)
                container.createRelayV2BaseRuntimeComposition(
                    RelayV2ConnectionRegistry.scope,
                    profile,
                    requireRelayV2ProfileRuntime(),
                ).also { RelayV2ConnectionRegistry.install(it) }
            }
        // Foreground keep-alive: the v2 composition is owned by the service.
        RelayConnectionService.start(container.applicationContext)
        synchronized(relayV2UiFenceLock) {
            relayV2Composition = composition
            _larkBindings.value = LarkBindingsState()
            relayV2NotificationProfileActive = true
            relayV2NotificationPreferencesLoaded = false
            relayV2SessionReplyCuts.value = emptyMap()
            relayV2ScopeCreateCuts.value = emptyMap()
            val state = _uiState.value
            _uiState.value = state.copy(
                agentCapabilityAvailability = AgentCapabilityAvailability.UNAVAILABLE,
                preferences = state.preferences.copy(
                    preferredHostId = profile.hostId,
                    autoConnect = profile.autoConnect,
                ),
                hosts = listOf(
                    RelayHost(
                        hostId = profile.hostId,
                        displayName = relayHostDisplayName(profile.hostId),
                        status = ConnectionStatus.UNKNOWN,
                    ),
                ),
            )
        }
        viewModelScope.launch {
            composition.state.collect { runtime ->
                val connectionFailure =
                    (runtime.failure as? RelayV2BaseRuntimeFailure.Connection)?.failure
                val serverRevoked = synchronized(relayV2UiFenceLock) {
                    if (relayV2Composition !== composition ||
                        _uiState.value.relayStartupAdmission != RelayStartupAdmissionState.RELAY_V2
                    ) return@synchronized false
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
                            "Relay v2 credential rollover failed; re-enrollment is required."
                        } else {
                            projected.pairingError
                        },
                        agentCapabilityAvailability = if (rolloverUnavailable) {
                            AgentCapabilityAvailability.UNAVAILABLE
                        } else {
                            projected.agentCapabilityAvailability
                        },
                    )
                    (runtime.failure as? RelayV2BaseRuntimeFailure.Connection)
                        ?.failure?.code == RELAY_V2_GRANT_REVOKED
                }
                if (serverRevoked) {
                    runCatching {
                        trackProfileMutation {
                            requireRelayV2ProfileRuntime()
                                .removeExternallyRevokedActiveProfile(profile)
                        }
                    }.onSuccess { removed ->
                        if (removed) {
                            publishProfileCleared(preferencesStore.values.first())
                        } else {
                            emit(V2UiEffect.Notice(
                                "The revoked Relay v2 profile changed before local cleanup",
                            ))
                        }
                    }.onFailure { error ->
                        emit(V2UiEffect.Notice(
                            error.message ?: "Could not clear the revoked Relay v2 profile",
                        ))
                    }
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
                if (current) {
                    requestNotificationPermissionForNegotiatedPreferences(composition)
                    syncAgentNotificationConfig(composition)
                }
            }
        }
        viewModelScope.launch {
            composition.negotiatedCapabilities.collect { capabilities ->
                val current = synchronized(relayV2UiFenceLock) {
                    if (relayV2Composition !== composition ||
                        _uiState.value.relayStartupAdmission != RelayStartupAdmissionState.RELAY_V2
                    ) return@synchronized false
                    _uiState.value = _uiState.value.copy(
                        hosts = _uiState.value.hosts.map { host ->
                            host.copy(capabilities = capabilities)
                        },
                    )
                    true
                }
            }
        }
        viewModelScope.launch {
            composition.agentChat.collect { chat ->
                val current = synchronized(relayV2UiFenceLock) {
                    if (relayV2Composition !== composition ||
                        _uiState.value.relayStartupAdmission != RelayStartupAdmissionState.RELAY_V2
                    ) return@synchronized false
                    _agentChat.value = chat
                    true
                }
            }
        }
        viewModelScope.launch {
            composition.larkBindings.collect { bindings ->
                synchronized(relayV2UiFenceLock) {
                    if (relayV2Composition !== composition ||
                        _uiState.value.relayStartupAdmission != RelayStartupAdmissionState.RELAY_V2
                    ) return@synchronized
                    _larkBindings.value = bindings
                }
            }
        }
        viewModelScope.launch {
            preferencesStore.values.collect { preferences ->
                val current = synchronized(relayV2UiFenceLock) {
                    if (relayV2Composition !== composition ||
                        _uiState.value.relayStartupAdmission != RelayStartupAdmissionState.RELAY_V2
                    ) return@synchronized false
                    _uiState.value = _uiState.value.copy(preferences = preferences)
                    relayV2NotificationPreferencesLoaded = true
                    true
                }
                if (current) {
                    requestNotificationPermissionForNegotiatedPreferences(composition)
                    syncAgentNotificationConfig(composition)
                }
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
                    if (projection.available) {
                        _uiState.value = _uiState.value.copy(scopes = scopes, sessions = sessions)
                    }
                    true
                }
                if (current) syncAgentNotificationConfig(composition)
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
                val current = synchronized(relayV2UiFenceLock) {
                    if (relayV2Composition !== composition ||
                        _uiState.value.relayStartupAdmission != RelayStartupAdmissionState.RELAY_V2
                    ) null else composition
                } ?: return@collect
                if (available) {
                    if ((changed || networkChanged) && _uiState.value.preferences.autoConnect) {
                        val hint = current.onNetworkAvailable()
                        if (hint == RelayV2NetworkHintResult.RECONNECTING) {
                            _uiState.update { it.copy(isConnecting = true) }
                        }
                    }
                } else if (changed) {
                    current.onNetworkLost()
                }
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
                            "Relay v2 transport online"
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
        is V2UiEffect.CreationQueued,
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
        private const val MAX_ACTIVATION_FAILURE_CAUSE = 200
        private const val DEFAULT_TERMINAL_COLS = 80
        private const val DEFAULT_TERMINAL_ROWS = 24
        private const val DEFAULT_SCOPE_ID = "local"
        private const val MAX_PENDING_UI_EFFECTS = 64
        private const val MAX_PENDING_CRITICAL_UI_EFFECTS = 16
        private const val RELAY_V2_SERVER_REVOKE_PROPAGATION_TIMEOUT_MILLIS = 5_500L
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
        protocolSessionId = session.sessionId,
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
            currentAgentState = presentation.items
                .filterIsInstance<AgentTranscriptLifecyclePresentationItem.Lifecycle>()
                .lastOrNull { it.isCurrentSource }
                ?.state
                ?.toUiAgentState(),
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

private fun AgentLifecycleState.toUiAgentState(): AgentState = when (this) {
    AgentLifecycleState.RUNNING -> AgentState.RUNNING
    AgentLifecycleState.WAITING_FOR_USER -> AgentState.WAITING_FOR_USER
    AgentLifecycleState.FAILED -> AgentState.FAILED
    AgentLifecycleState.COMPLETED -> AgentState.COMPLETED
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

/**
 * Same activation lineage as [other]: the durable admitted profile may legally differ from the
 * confirmed enrollment profile only through benign repair or prior consent. Reconciliation repairs
 * the credential by bumping [RelayV2Profile.credentialVersion] while preserving identity and
 * lineage, and a prior partial activation may have already persisted [RelayV2Profile.autoConnect].
 * Any identity-bearing or lineage-bearing field (profile ID, endpoints, host, client instance,
 * activation generation, credential reference) difference means the confirmed profile is no
 * longer the durable truth and activation must be refused.
 */
internal fun RelayV2Profile.sharesActivationLineageWith(other: RelayV2Profile): Boolean =
    profileId == other.profileId &&
        issuerUrl == other.issuerUrl &&
        relayUrl == other.relayUrl &&
        hostId == other.hostId &&
        clientInstanceId == other.clientInstanceId &&
        activationGeneration == other.activationGeneration &&
        credentialReference == other.credentialReference
