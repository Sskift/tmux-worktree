package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleDurableLoadOrInitializeAdapter
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentNotificationConfig
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleDisabledNotificationPlatform
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleDurableConsumerIdentity
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleNotificationConfigMutationAdapter
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleNotificationConfigMutationCommand
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleNotificationConfigMutationResult
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleNotificationPlatformPort
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRuntimeComposition
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRuntimeCompositionResult
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRuntimeDurableRepository
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRuntimeHandlePort
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleSelectedSessionPresentationController
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleSelectedSessionPresentationState
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleSelectedSessionReadController
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleSelectedSessionStatusAdmissionController
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleSessionSelectionController
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleSessionSelectionIntent
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialStore
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEntry
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxArguments
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxDraft
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEffect
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxState
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxLimits
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxOperation
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxRuntimeAuthority
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2MaterializedSessionReadAuthority
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2MaterializedSessionReadCut
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxAuthorityNamespace
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxEnqueueAuthority
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxEnqueueFailure
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxEnqueueReceipt
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxEnqueueResult
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeResource
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateNamespace
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateSyncAuthority
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalCheckpointKey
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitJournalStore
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalRecoveryAuthority
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalBytes
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffect
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResetReason
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResumeCredentialStore
import java.io.Closeable
import java.util.UUID
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal const val RELAY_V2_CREDENTIAL_ROLLOVER_UNAVAILABLE =
    "V2_CREDENTIAL_ROLLOVER_UNAVAILABLE"

internal sealed interface RelayV2CredentialRolloverResult {
    data class Refreshed(val profile: RelayV2Profile) : RelayV2CredentialRolloverResult
    data object Unavailable : RelayV2CredentialRolloverResult
}

internal fun interface RelayV2CredentialRolloverPort {
    suspend fun rollover(expectedProfile: RelayV2Profile): RelayV2CredentialRolloverResult
}

/** The explicit v2 profile's connection state, not product readiness or capability availability. */
internal enum class RelayV2BaseRuntimePhase {
    STOPPED,
    CONNECTING,
    RESYNCING,
    ONLINE,
    SUSPENDED,
    FAILED,
}

internal sealed interface RelayV2BaseRuntimeFailure {
    data class Connection(val failure: RelayV2ConnectionFailure) : RelayV2BaseRuntimeFailure

    data class RuntimeIncomplete(val code: String) : RelayV2BaseRuntimeFailure
}

internal data class RelayV2BaseRuntimeState(
    val phase: RelayV2BaseRuntimePhase = RelayV2BaseRuntimePhase.STOPPED,
    val failure: RelayV2BaseRuntimeFailure? = null,
)

/** Exact activation-scoped admission port; implementations must fail closed on corrupt state. */
internal fun interface RelayV2ActivationOutboxReadPort {
    suspend fun readSnapshot(profile: RelayV2Profile): RelayV2OutboxState
}

/** Opaque product cut; only its issuing base composition can consume it. */
internal interface RelayV2SessionReplyCut

/** Opaque Scope authority; only its issuing base composition can consume it. */
internal interface RelayV2ScopeCreateCut

internal data class RelayV2ProductSession(
    val materialized: RelayV2MaterializedSessionReadCut,
    val replyCut: RelayV2SessionReplyCut,
    val scopeCreateCut: RelayV2ScopeCreateCut,
)

internal data class RelayV2CreateWorktreeInputs(
    val project: String?,
    val path: String?,
    val name: String?,
    val branch: String?,
    val aiCommand: String,
)

internal enum class RelayV2ScopeCreateFailure {
    NOT_ONLINE,
    PROFILE_BARRIER,
    SCOPE_STALE,
    INVALID_INPUT,
    DUPLICATE_COMMAND,
    CAPACITY_EXCEEDED,
    FOREIGN_LINEAGE,
    CORRUPT_STATE,
    STORE_FAILURE,
}

internal sealed interface RelayV2ScopeCreateResult {
    data class Queued(
        val receipt: RelayV2OutboxEnqueueReceipt,
    ) : RelayV2ScopeCreateResult

    data class Rejected(
        val failure: RelayV2ScopeCreateFailure,
    ) : RelayV2ScopeCreateResult
}

internal fun interface RelayV2ScopeCreateCommandPort {
    suspend fun submitCreateWorktree(
        scopeCut: RelayV2ScopeCreateCut,
        inputs: RelayV2CreateWorktreeInputs,
    ): RelayV2ScopeCreateResult
}

internal enum class RelayV2SessionReplyFailure {
    NOT_ONLINE,
    PROFILE_BARRIER,
    SESSION_STALE,
    INVALID_MESSAGE,
    DUPLICATE_COMMAND,
    CAPACITY_EXCEEDED,
    FOREIGN_LINEAGE,
    CORRUPT_STATE,
    STORE_FAILURE,
}

internal sealed interface RelayV2SessionReplyResult {
    data class Committed(
        val receipt: RelayV2OutboxEnqueueReceipt,
    ) : RelayV2SessionReplyResult

    data class Rejected(
        val failure: RelayV2SessionReplyFailure,
    ) : RelayV2SessionReplyResult
}

internal fun interface RelayV2SessionReplyCommandPort {
    suspend fun submitReply(
        sessionCut: RelayV2SessionReplyCut,
        message: String,
    ): RelayV2SessionReplyResult
}

internal sealed interface RelayV2SessionKillResult {
    data class Queued(
        val receipt: RelayV2OutboxEnqueueReceipt,
    ) : RelayV2SessionKillResult

    data class Rejected(
        val failure: RelayV2SessionReplyFailure,
    ) : RelayV2SessionKillResult
}

internal fun interface RelayV2SessionKillCommandPort {
    suspend fun submitKillSession(
        sessionCut: RelayV2SessionReplyCut,
    ): RelayV2SessionKillResult
}

internal data class SelectedSessionReplyRow(
    val commandId: String,
    val message: String,
    val createdAtMillis: Long,
    val state: RelayV2OutboxStateTag,
)

internal sealed interface SelectedSessionReplyReadState {
    data class Content(
        val revision: Long,
        val rows: List<SelectedSessionReplyRow>,
    ) : SelectedSessionReplyReadState

    data object Unavailable : SelectedSessionReplyReadState

    data object Stale : SelectedSessionReplyReadState
}

/**
 * Production base-sync owner for one already-admitted Relay v2 profile activation.
 *
 * This composition owns exactly one actor, its effect pump, and their close lifecycle. It consumes
 * state-sync plus durable command query/status recovery. After the actor publishes the exact ONLINE
 * ready cut, it flushes recovered Execute capabilities in commit order and then asks the durable
 * Outbox producer for bounded fresh QUEUED batches. Retryable connection failures are redriven by
 * one bounded backoff owner after the actor's prior transport/apply fence. The Agent durable
 * consumer remains dormant unless its optional capability is offered and negotiated by all three
 * peers; its durable presentation revision is wired for live invalidation.
 */
internal class RelayV2BaseRuntimeComposition(
    parentScope: CoroutineScope,
    @Volatile private var profile: RelayV2Profile,
    credentialStore: RelayV2CredentialStore,
    private val credentialRollover: RelayV2CredentialRolloverPort,
    stateSyncAuthority: RelayV2StateSyncAuthority,
    terminalRuntimeAuthority: RelayV2TerminalRecoveryAuthority,
    terminalPostCommitJournal: RelayV2TerminalPostCommitJournalStore,
    terminalResumeCredentials: RelayV2TerminalResumeCredentialStore,
    private val materializedSessions: RelayV2MaterializedSessionReadAuthority,
    private val activationOutbox: RelayV2ActivationOutboxReadPort,
    outboxAuthority: RelayV2OutboxRuntimeAuthority,
    private val outboxEnqueueAuthority: RelayV2OutboxEnqueueAuthority,
    agentDurableRepository: AgentTranscriptLifecycleRuntimeDurableRepository? = null,
    agentNotificationPlatform: AgentTranscriptLifecycleNotificationPlatformPort =
        AgentTranscriptLifecycleDisabledNotificationPlatform,
    agentRuntimeFactory: ((RelayV2RepositoryEffectApplyLeasePort) ->
        AgentTranscriptLifecycleRuntimeHandlePort)? = null,
    agentOptionalCapabilities: Set<String> = emptySet(),
    transportFactory: RelayV2TransportFactory = BoundedRelayV2TransportFactory(),
    private val newCommandId: () -> String = { UUID.randomUUID().toString() },
    private val clock: () -> Long = System::currentTimeMillis,
    private val retryDelay: suspend (Long) -> Unit = { delay(it) },
    private val actorRecoveryWatchdogDelay: suspend (Long) -> Unit = { delay(it) },
    private val beforeHelloOutboxAdmissionRead: suspend () -> Unit = {},
    private val beforeSessionProjectionPublish: suspend () -> Unit = {},
    private val beforeOnlineResyncReceiptSubmit: suspend () -> Unit = {},
    private val afterRetryableFailureAdmissionDetached: () -> Unit = {},
    private val afterActorConnectAdmissionHandoff: () -> Unit = {},
) : RelayV2SessionReplyCommandPort,
    RelayV2SessionKillCommandPort,
    RelayV2ScopeCreateCommandPort,
    Closeable {
    private val closed = AtomicBoolean(false)
    private val terminalFailure = AtomicReference<RelayV2BaseRuntimeFailure?>(null)
    private val stateLock = Any()
    private val recoveredDispatchLock = Any()
    private var recoveredDispatch: RecoveredDispatchBuffer? = null
    private val agentRecoveryLock = Any()
    private var agentRecoveryAdmissionFenced = false
    private var agentRecoveryGeneration: RelayV2EffectGeneration? = null
    private var agentRecoveryStartedGeneration: RelayV2EffectGeneration? = null
    private val agentRecoveryJobs = LinkedHashSet<Job>()
    private val connectionLock = Any()
    private val productMutationLock = Mutex()
    private val outboxTimelineRevisionLock = Any()
    private val agentTimelineRevisionLock = Any()
    private var reconnectEnabled = profile.autoConnect
    private var retryFence: Any = Any()
    private var connectionAttemptJob: Job? = null
    private var retryAttempt = 0
    private var retryStateFence: RetryStateFence? = null
    private var pendingOutboxAdmission: PendingOutboxAdmission? = null
    private var boundOutboxAdmission: BoundOutboxAdmission? = null
    private var credentialRolloverAdmission: CredentialRolloverAdmission? = null
    private val actorShutdownStarted = AtomicBoolean(false)
    private val actorOwnerJob = SupervisorJob()
    private val actorScope = CoroutineScope(
        parentScope.coroutineContext.minusKey(Job) + actorOwnerJob,
    )
    private val pumpJob = SupervisorJob(actorOwnerJob)
    private val pumpScope = CoroutineScope(
        parentScope.coroutineContext.minusKey(Job) + pumpJob,
    )
    private val parentCompletionHandle = AtomicReference<kotlinx.coroutines.DisposableHandle?>(null)
    private val recoveryAdapter = RelayV2RecoveryRepositoryAdapter(stateSyncAuthority)
    private val queryAdmissionComposition = RelayV2OutboxQueryAdmissionAuthority.composition()
    private val actor = RelayV2ConnectionActor(
        parentScope = actorScope,
        transportFactory = transportFactory,
        credentialStore = credentialStore,
        connectPlanSource = recoveryAdapter,
        commandQueryAdmissionComposition = queryAdmissionComposition,
        optionalCapabilities = agentOptionalCapabilities,
        recoveryWatchdogDelay = actorRecoveryWatchdogDelay,
    )
    private val terminalRuntime = RelayV2TerminalProductionComposition(
        applyLease = actor,
        terminal = terminalRuntimeAuthority,
        journal = terminalPostCommitJournal,
        credentials = terminalResumeCredentials,
        sendPort = actor,
        fatalInvalidation = object : RelayV2TerminalFatalInvalidationPort {
            override suspend fun invalidate(
                authority: RelayV2RepositoryEffectAuthority,
                key: RelayV2TerminalCheckpointKey,
                reason: RelayV2TerminalFatalInvalidationReason,
            ) {
                check(authority.profileId == profile.profileId)
                check(authority.profileActivationGeneration == profile.activationGeneration)
                check(key.profileId == authority.profileId)
                check(key.profileActivationGeneration == authority.profileActivationGeneration)
                failRuntimeIncomplete("TERMINAL_RUNTIME_INVALIDATED")
            }
        },
    )
    private val agentRuntimeComposition = agentDurableRepository?.let {
        AgentTranscriptLifecycleRuntimeComposition.dormant(
            applyLease = actor,
            durableRepository = it,
            durableHandoff = actor,
            notificationPlatform = agentNotificationPlatform,
            requestSender = actor,
            onDurablePresentationCommit = ::markAgentTimelineCommit,
        )
    }
    private val agentRuntime = run {
        require(agentRuntimeFactory == null || agentDurableRepository == null) {
            "Agent runtime factory and durable repository are mutually exclusive"
        }
        agentRuntimeFactory?.invoke(actor)
            ?: agentRuntimeComposition
    }
    private val agentNotificationConfigMutation = agentDurableRepository?.let { repository ->
        AgentTranscriptLifecycleNotificationConfigMutationAdapter(actor, repository)
    }
    private val selectedSessionSelection = agentDurableRepository?.let {
        AgentTranscriptLifecycleSessionSelectionController(
            readAuthority = actor,
            stateRepositoryRead = materializedSessions::readMaterializedSessionCut,
        )
    }
    private val selectedSessionPresentation = agentDurableRepository?.let { durableRepository ->
        val read = AgentTranscriptLifecycleSelectedSessionReadController(
            sessionSelection = requireNotNull(selectedSessionSelection),
            durableRepository = durableRepository,
            enabled = true,
        )
        AgentTranscriptLifecycleSelectedSessionPresentationController(
            readController = read,
            pageLimit = SELECTED_SESSION_PRESENTATION_PAGE_LIMIT,
        )
    }
    private val selectedSessionStatusAdmission = agentDurableRepository?.let { durableRepository ->
        AgentTranscriptLifecycleSelectedSessionStatusAdmissionController(
            sessionSelection = requireNotNull(selectedSessionSelection),
            durableRepository = durableRepository,
            durableLoadOrInitialize = AgentTranscriptLifecycleDurableLoadOrInitializeAdapter(
                applyLease = actor,
                repository = durableRepository,
            ),
            requestSync = requireNotNull(agentRuntimeComposition),
            enabled = true,
        )
    }
    private val queryAdmissionAdapter = queryAdmissionComposition.adapter(actor, outboxAuthority)
    private val outboxDispatchComposition =
        RelayV2OutboxDispatchAuthority.recoveryComposition(
            actor,
            outboxAuthority,
        )
    private val outboxRecoveryAdapter = outboxDispatchComposition.recoveryAdapter
    private val freshOutboxProducer = outboxDispatchComposition.freshProducer
    private val outboxDispatcher = outboxDispatchComposition.dispatcher(actor)
    private val _state = MutableStateFlow(RelayV2BaseRuntimeState())
    val state: StateFlow<RelayV2BaseRuntimeState> = _state.asStateFlow()
    private val _sessions = MutableStateFlow<List<RelayV2ProductSession>>(emptyList())
    val sessions: StateFlow<List<RelayV2ProductSession>> = _sessions.asStateFlow()
    private val _outboxTimelineRevision = MutableStateFlow(0L)
    val outboxTimelineRevision: StateFlow<Long> = _outboxTimelineRevision.asStateFlow()
    private val _agentTimelineRevision = MutableStateFlow(0L)
    val agentTimelineRevision: StateFlow<Long> = _agentTimelineRevision.asStateFlow()
    val agentCapabilityAvailability: StateFlow<RelayV2AgentCapabilityAvailability> =
        actor.agentCapabilityAvailability

    init {
        val completionHandle = parentScope.coroutineContext[Job]?.invokeOnCompletion { close() }
        parentCompletionHandle.set(completionHandle)
        if (actorShutdownStarted.get()) {
            parentCompletionHandle.getAndSet(null)?.dispose()
        }
        pumpScope.launch {
            actor.state.collect(::publishActorState)
        }
        pumpScope.launch {
            try {
                actor.effects.collect { effect ->
                    if (terminalFailure.get() == null && !closed.get()) {
                        consume(effect)
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                failRuntimeIncomplete("BASE_SYNC_APPLY_FAILED")
            }
        }
        pumpScope.launch {
            val recovered = try {
                terminalRuntime.recoverBeforeAdmission()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                false
            }
            if (!recovered) {
                failRuntimeIncomplete("TERMINAL_POST_COMMIT_RECOVERY_FAILED")
            } else if (profile.autoConnect) {
                startInitialConnectionAttempt()
            }
        }
    }

    private class CompositionTerminalAttachment(
        val origin: RelayV2BaseRuntimeComposition,
        val sessionCut: CompositionSessionReplyCut,
        val runtimeAttachment: RelayV2TerminalAttachment,
    ) : RelayV2TerminalAttachment

    internal suspend fun attachTerminal(
        sessionCut: RelayV2SessionReplyCut,
        parser: RelayV2TerminalParserPort,
        observer: RelayV2TerminalAttachmentObserver,
    ): RelayV2TerminalAttachment? {
        val issued = currentIssuedSession(sessionCut) ?: return null
        val materialized = issued.materialized
        val runtimeAttachment = terminalRuntime.attach(
            RelayV2TerminalAttachmentTarget(
                profileId = profile.profileId,
                profileActivationGeneration = profile.activationGeneration,
                principalId = profile.principalId,
                clientInstanceId = profile.clientInstanceId,
                hostId = profile.hostId,
                scopeId = materialized.session.scopeId,
                sessionId = materialized.session.sessionId,
            ),
            parser,
            observer,
        )
        return CompositionTerminalAttachment(this, issued, runtimeAttachment)
    }

    internal suspend fun openTerminal(
        attachment: RelayV2TerminalAttachment,
        cols: Int,
        rows: Int,
    ): Boolean = withTerminalOnline(attachment) { issued, authority ->
        terminalRuntime.open(issued.runtimeAttachment, authority, cols, rows)
    }

    internal suspend fun sendTerminalInput(
        attachment: RelayV2TerminalAttachment,
        bytes: ByteArray,
    ): Boolean = withTerminalOnline(attachment) { issued, authority ->
        terminalRuntime.enqueueInput(issued.runtimeAttachment, authority, bytes)
    }

    internal suspend fun resizeTerminal(
        attachment: RelayV2TerminalAttachment,
        cols: Int,
        rows: Int,
    ): Boolean = withTerminalOnline(attachment) { issued, authority ->
        terminalRuntime.enqueueResize(issued.runtimeAttachment, authority, cols, rows)
    }

    internal suspend fun closeTerminal(attachment: RelayV2TerminalAttachment): Boolean =
        withTerminalOnline(attachment) { issued, authority ->
            terminalRuntime.close(issued.runtimeAttachment, authority)
        }

    internal suspend fun detachTerminal(attachment: RelayV2TerminalAttachment) {
        val issued = attachment as? CompositionTerminalAttachment ?: return
        if (issued.origin !== this) return
        terminalRuntime.detach(issued.runtimeAttachment)
    }

    private suspend fun withTerminalOnline(
        attachment: RelayV2TerminalAttachment,
        block: suspend (
            CompositionTerminalAttachment,
            RelayV2RepositoryEffectAuthority,
        ) -> Boolean,
    ): Boolean {
        val issued = attachment as? CompositionTerminalAttachment ?: return false
        if (issued.origin !== this || currentIssuedSession(issued.sessionCut) !== issued.sessionCut) {
            return false
        }
        val cut = when (val current = actor.currentOnlineCommandCut()) {
            is RelayV2CurrentOnlineCommandCutResult.Available -> current.cut
            RelayV2CurrentOnlineCommandCutResult.Unavailable -> return false
        }
        return when (val leased = actor.withCurrentOnlineCommandLease(cut) { context ->
            if (currentIssuedSession(issued.sessionCut) !== issued.sessionCut) false
            else block(issued, context.authority)
        }) {
            is RelayV2CurrentOnlineCommandLeaseResult.Current -> leased.value
            RelayV2CurrentOnlineCommandLeaseResult.Stale -> false
        }
    }

    suspend fun disconnectAndDrain(
        expectedProfile: RelayActiveProfileIdentity,
        barrierId: String,
    ): RelayProfileDisconnectReceipt {
        require(expectedProfile == profile.identity) {
            "Relay v2 base runtime disconnect profile does not match its activation"
        }
        val connectionAttempt = fenceConnectionAttempts()
        val agentRecoveryJobs = fenceAgentRecovery()
        connectionAttempt?.cancelAndJoin()
        terminalRuntime.teardownGeneration(generation = null)
        clearRecoveredDispatch()
        try {
            return actor.disconnectAndDrain(expectedProfile, barrierId).also {
                clearSessionProjection()
                retireConnectionAdmissions()
            }
        } finally {
            // The actor first drains transport/apply authority. Only then may the explicit
            // disconnect barrier complete after its generation-scoped Agent extension job.
            agentRecoveryJobs.forEach { it.cancelAndJoin() }
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        fenceConnectionAttempts()
        clearRecoveredDispatch()
        clearSessionProjection()
        beginActorShutdown()
        synchronized(stateLock) {
            if (terminalFailure.get() == null) {
                _state.value = RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.STOPPED)
            }
        }
    }

    override suspend fun submitReply(
        sessionCut: RelayV2SessionReplyCut,
        message: String,
    ): RelayV2SessionReplyResult {
        if (closed.get() || terminalFailure.get() != null) {
            return RelayV2SessionReplyResult.Rejected(
                RelayV2SessionReplyFailure.PROFILE_BARRIER,
            )
        }
        val issuedSession = sessionCut as? CompositionSessionReplyCut
            ?: return RelayV2SessionReplyResult.Rejected(
                RelayV2SessionReplyFailure.SESSION_STALE,
            )
        if (issuedSession.origin !== this) {
            return RelayV2SessionReplyResult.Rejected(
                RelayV2SessionReplyFailure.SESSION_STALE,
            )
        }
        val normalized = message.trim()
        val arguments = try {
            if (normalized.isEmpty()) error("empty reply")
            RelayV2OutboxArguments.sendAgentMessage(
                pane = 0,
                message = normalized,
                submit = true,
            ) as RelayV2OutboxArguments.SendAgentMessage
        } catch (_: Exception) {
            return RelayV2SessionReplyResult.Rejected(
                RelayV2SessionReplyFailure.INVALID_MESSAGE,
            )
        }
        val leased = actor.withCurrentOnlineCommandLease(issuedSession.onlineCut) { current ->
            productMutationLock.withLock {
                enqueueSessionCommandUnderLease(issuedSession, current, arguments)
            }
        }
        val committed = when (leased) {
            RelayV2CurrentOnlineCommandLeaseResult.Stale ->
                return RelayV2SessionReplyResult.Rejected(
                    RelayV2SessionReplyFailure.NOT_ONLINE,
                )
            is RelayV2CurrentOnlineCommandLeaseResult.Current -> leased.value
        }
        if (committed is ReplyCommit.Committed) {
            // The actor lease is deliberately released first. A concurrent generation/profile
            // fence may now make dispatch stale; the committed row remains for successor recovery.
            dispatchFresh(committed.authority)
            return RelayV2SessionReplyResult.Committed(committed.receipt)
        }
        return RelayV2SessionReplyResult.Rejected((committed as ReplyCommit.Rejected).failure)
    }

    override suspend fun submitKillSession(
        sessionCut: RelayV2SessionReplyCut,
    ): RelayV2SessionKillResult {
        if (closed.get() || terminalFailure.get() != null) {
            return RelayV2SessionKillResult.Rejected(
                RelayV2SessionReplyFailure.PROFILE_BARRIER,
            )
        }
        val issuedSession = sessionCut as? CompositionSessionReplyCut
            ?: return RelayV2SessionKillResult.Rejected(
                RelayV2SessionReplyFailure.SESSION_STALE,
            )
        if (issuedSession.origin !== this) {
            return RelayV2SessionKillResult.Rejected(
                RelayV2SessionReplyFailure.SESSION_STALE,
            )
        }
        val leased = actor.withCurrentOnlineCommandLease(issuedSession.onlineCut) { current ->
            productMutationLock.withLock {
                enqueueSessionCommandUnderLease(
                    issuedSession,
                    current,
                    RelayV2OutboxArguments.killSession(),
                )
            }
        }
        val committed = when (leased) {
            RelayV2CurrentOnlineCommandLeaseResult.Stale ->
                return RelayV2SessionKillResult.Rejected(
                    RelayV2SessionReplyFailure.NOT_ONLINE,
                )
            is RelayV2CurrentOnlineCommandLeaseResult.Current -> leased.value
        }
        if (committed is ReplyCommit.Committed) {
            // A queued kill never mutates the Session projection. Only a later authoritative
            // sessions.changed delete may remove it; a stale dispatch stays durable for recovery.
            dispatchFresh(committed.authority)
            return RelayV2SessionKillResult.Queued(committed.receipt)
        }
        return RelayV2SessionKillResult.Rejected((committed as ReplyCommit.Rejected).failure)
    }

    override suspend fun submitCreateWorktree(
        scopeCut: RelayV2ScopeCreateCut,
        inputs: RelayV2CreateWorktreeInputs,
    ): RelayV2ScopeCreateResult {
        if (closed.get() || terminalFailure.get() != null) {
            return RelayV2ScopeCreateResult.Rejected(
                RelayV2ScopeCreateFailure.PROFILE_BARRIER,
            )
        }
        val issuedScope = scopeCut as? CompositionScopeCreateCut
            ?: return RelayV2ScopeCreateResult.Rejected(
                RelayV2ScopeCreateFailure.SCOPE_STALE,
            )
        if (issuedScope.origin !== this) {
            return RelayV2ScopeCreateResult.Rejected(
                RelayV2ScopeCreateFailure.SCOPE_STALE,
            )
        }
        val leased = actor.withCurrentOnlineCommandLease(issuedScope.onlineCut) { current ->
            productMutationLock.withLock {
                enqueueCreateWorktreeUnderLease(issuedScope, current, inputs)
            }
        }
        val committed = when (leased) {
            RelayV2CurrentOnlineCommandLeaseResult.Stale ->
                return RelayV2ScopeCreateResult.Rejected(
                    RelayV2ScopeCreateFailure.NOT_ONLINE,
                )
            is RelayV2CurrentOnlineCommandLeaseResult.Current -> leased.value
        }
        if (committed is ScopeCreateCommit.Committed) {
            // The Room commit is the only success boundary. If the actor becomes stale after it,
            // dispatch withdraws and the queued create lane remains for successor recovery.
            dispatchFresh(committed.authority)
            return RelayV2ScopeCreateResult.Queued(committed.receipt)
        }
        return RelayV2ScopeCreateResult.Rejected(
            (committed as ScopeCreateCommit.Rejected).failure,
        )
    }

    /**
     * Reads one bounded structured Agent page for an exact product Session cut.
     *
     * The existing selected-Session controllers own capability admission, the actor read lease,
     * materialized Session revalidation, durable namespace derivation and Room projection. This
     * composition adds only its product-cut fence and never turns production capability input on.
     */
    suspend fun readSelectedSession(
        sessionCut: RelayV2SessionReplyCut,
    ): AgentTranscriptLifecycleSelectedSessionPresentationState {
        val issuedSession = currentIssuedSession(sessionCut)
            ?: return AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable
        val presentation = selectedSessionPresentation
            ?: return AgentTranscriptLifecycleSelectedSessionPresentationState.Disabled
        val result = presentation.read(
            AgentTranscriptLifecycleSessionSelectionIntent(
                namespace = issuedSession.materialized.namespace,
                scopeId = issuedSession.materialized.session.scopeId,
                sessionId = issuedSession.materialized.session.sessionId,
            ),
        )
        if (currentIssuedSession(sessionCut) !== issuedSession) {
            return AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable
        }
        return when (result) {
            is AgentTranscriptLifecycleSelectedSessionPresentationState.Content -> {
                if (result.materializedSession == issuedSession.materialized) {
                    result
                } else {
                    AgentTranscriptLifecycleSelectedSessionPresentationState.Unavailable
                }
            }
            else -> result
        }
    }

    /** Requests one structured Agent status refresh for an exact current product Session cut. */
    suspend fun requestSelectedSessionAgentStatus(
        sessionCut: RelayV2SessionReplyCut,
    ): AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult {
        val issuedSession = currentIssuedSession(sessionCut)
            ?: return AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult.Unavailable
        val admission = selectedSessionStatusAdmission
            ?: return AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult.Unavailable
        val result = try {
            admission.requestStatus(
                AgentTranscriptLifecycleSessionSelectionIntent(
                    namespace = issuedSession.materialized.namespace,
                    scopeId = issuedSession.materialized.session.scopeId,
                    sessionId = issuedSession.materialized.session.sessionId,
                ),
            )
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult.Unavailable
        }
        if (currentIssuedSession(sessionCut) !== issuedSession) {
            return AgentTranscriptLifecycleSelectedSessionStatusAdmissionResult.Unavailable
        }
        return result
    }

    /**
     * Applies one user/platform notification configuration to every exact current product
     * Session. The actor's optional-capability lease rejects stale generations and profiles before
     * the sole durable repository can initialize or mutate a consumer.
     */
    suspend fun updateAgentNotificationConfig(
        config: AgentNotificationConfig,
    ): AgentTranscriptLifecycleNotificationConfigMutationResult = productMutationLock.withLock {
        val mutation = agentNotificationConfigMutation
            ?: return@withLock AgentTranscriptLifecycleNotificationConfigMutationResult.Unavailable
        for (product in _sessions.value) {
            val issued = currentIssuedSession(product.replyCut)
                ?: return@withLock AgentTranscriptLifecycleNotificationConfigMutationResult.Unavailable
            val materialized = issued.materialized
            val consumer = AgentTranscriptLifecycleDurableConsumerIdentity(
                profileId = profile.profileId,
                profileActivationGeneration = profile.activationGeneration,
                principalId = profile.principalId,
                clientInstanceId = profile.clientInstanceId,
                hostId = profile.hostId,
                hostEpoch = materialized.cursor.hostEpoch,
                scopeId = materialized.session.scopeId,
                sessionId = materialized.session.sessionId,
            )
            if (mutation.mutate(
                    AgentTranscriptLifecycleNotificationConfigMutationCommand(consumer, config),
                ) != AgentTranscriptLifecycleNotificationConfigMutationResult.Applied
            ) {
                return@withLock AgentTranscriptLifecycleNotificationConfigMutationResult.Unavailable
            }
        }
        AgentTranscriptLifecycleNotificationConfigMutationResult.Applied
    }

    /**
     * Reads the latest bounded local send_agent_message rows for one exact product Session cut.
     *
     * The existing activation Outbox port performs the full namespace strict restore. This
     * composition only applies the current product-cut/revision fence and projects non-sensitive
     * reply fields; it never reads Room or a DAO directly.
     */
    suspend fun readSelectedSessionReplies(
        sessionCut: RelayV2SessionReplyCut,
        expectedRevision: Long,
    ): SelectedSessionReplyReadState {
        val issuedSession = currentIssuedSession(sessionCut)
            ?: return SelectedSessionReplyReadState.Unavailable
        if (_outboxTimelineRevision.value != expectedRevision) {
            return SelectedSessionReplyReadState.Stale
        }
        val rows = try {
            val snapshot = activationOutbox.readSnapshot(profile)
            check(snapshot.entries.all { entry ->
                entry.profileId == profile.profileId &&
                    entry.principalId == profile.principalId
            }) { "Relay v2 selected Session Outbox escaped the activation namespace" }
            snapshot.entries.asSequence()
                .filter { entry ->
                    entry.hostId == issuedSession.materialized.namespace.hostId &&
                        entry.expectedHostEpoch == issuedSession.materialized.namespace.hostEpoch &&
                        entry.scopeId == issuedSession.materialized.session.scopeId &&
                        entry.sessionId == issuedSession.materialized.session.sessionId &&
                        entry.operation == RelayV2OutboxOperation.SEND_AGENT_MESSAGE &&
                        entry.state != RelayV2OutboxStateTag.REISSUED
                }
                .sortedWith(compareBy<RelayV2OutboxEntry> { it.createdOrder }
                    .thenBy { it.commandId })
                .toList()
                .takeLast(MAX_SELECTED_SESSION_REPLY_ROWS)
                .map { entry ->
                    val arguments = entry.canonicalRequestArguments.value
                        as? RelayV2OutboxArguments.SendAgentMessage
                        ?: error("Relay v2 reply row does not contain send_agent_message arguments")
                    SelectedSessionReplyRow(
                        commandId = entry.commandId,
                        message = arguments.message,
                        createdAtMillis = entry.createdAtMillis,
                        state = entry.state,
                    )
                }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return SelectedSessionReplyReadState.Unavailable
        }
        if (currentIssuedSession(sessionCut) !== issuedSession ||
            _outboxTimelineRevision.value != expectedRevision
        ) {
            return SelectedSessionReplyReadState.Stale
        }
        return SelectedSessionReplyReadState.Content(expectedRevision, rows)
    }

    private fun currentIssuedSession(
        sessionCut: RelayV2SessionReplyCut,
    ): CompositionSessionReplyCut? {
        if (closed.get() || terminalFailure.get() != null) return null
        val issuedSession = sessionCut as? CompositionSessionReplyCut ?: return null
        if (issuedSession.origin !== this) return null
        return issuedSession.takeIf { expected ->
            _sessions.value.any { product ->
                product.replyCut === expected && product.materialized == expected.materialized
            }
        }
    }

    private fun currentIssuedScope(
        scopeCut: RelayV2ScopeCreateCut,
    ): CompositionScopeCreateCut? {
        if (closed.get() || terminalFailure.get() != null) return null
        val issuedScope = scopeCut as? CompositionScopeCreateCut ?: return null
        if (issuedScope.origin !== this) return null
        return issuedScope.takeIf { expected ->
            _sessions.value.any { product ->
                product.scopeCreateCut === expected &&
                    ScopeCreateAuthority.from(
                        product.materialized,
                        expected.authority.activationNamespace,
                    ) == expected.authority
            }
        }
    }

    private fun startInitialConnectionAttempt() {
        val attempt = synchronized(connectionLock) {
            val fence = retryFence
            if (!canConnectLocked(fence)) return@synchronized null
            check(connectionAttemptJob == null) {
                "Relay v2 connection attempt already exists"
            }
            val job = pumpScope.launch(start = CoroutineStart.LAZY) {
                connectOnce(fence, currentCoroutineContext()[Job]!!)
            }
            trackConnectionAttemptLocked(job)
            job
        }
        attempt?.start()
    }

    private suspend fun connectOnce(expectedFence: Any, expectedJob: Job) {
        if (!ownsConnectionAttempt(expectedFence, expectedJob)) return
        val snapshot = try {
            activationOutbox.readSnapshot(profile).toActivationSnapshot(profile)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            if (ownsConnectionAttempt(expectedFence, expectedJob)) {
                failRuntimeIncomplete("DURABLE_OUTBOX_ADMISSION_FAILED")
            }
            return
        }
        val connectionAttempt = RelayV2ConnectionAttemptIdentity(profile.identity)
        val accepted = synchronized(connectionLock) {
            if (!ownsConnectionAttemptLocked(expectedFence, expectedJob)) {
                return@synchronized null
            }
            check(pendingOutboxAdmission == null && boundOutboxAdmission == null) {
                "Relay v2 runtime already owns a connection Outbox admission"
            }
            pendingOutboxAdmission = PendingOutboxAdmission(connectionAttempt, snapshot)
            actor.connect(profile, connectionAttempt).also { connected ->
                if (!connected) {
                    pendingOutboxAdmission = null
                } else {
                    synchronized(stateLock) {
                        if (!closed.get() && terminalFailure.get() == null) {
                            _state.value =
                                RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.CONNECTING)
                        }
                    }
                    check(
                        connectionAttemptJob === expectedJob && retryFence === expectedFence,
                    ) {
                        "Relay v2 connection attempt ownership changed during actor admission"
                    }
                    // The actor barrier now owns this admitted attempt. Relinquish the wrapper
                    // before releasing connectionLock so an immediate failure can claim exactly
                    // one successor and disconnect cannot mistake completed Room work as active.
                    connectionAttemptJob = null
                }
            }
        } ?: return
        if (!accepted) {
            if (ownsConnectionAttempt(expectedFence, expectedJob)) {
                failRuntimeIncomplete("CONNECT_ADMISSION_REJECTED")
            }
            return
        }
        afterActorConnectAdmissionHandoff()
    }

    internal suspend fun consume(
        effect: RelayV2RuntimeEffect,
    ): AgentTranscriptLifecycleRuntimeCompositionResult? {
        when (effect) {
            is RelayV2RuntimeEffect.QueryPendingCommands -> applyHello(effect)
            is RelayV2RuntimeEffect.BeginStateResync -> applyHello(effect)
            is RelayV2RuntimeEffect.ApplyStateSnapshotChunk -> applySnapshotChunk(effect)
            is RelayV2RuntimeEffect.CompleteSnapshotRelease -> completeSnapshotRelease(effect)
            is RelayV2RuntimeEffect.ExpireSnapshotContinuation -> expireSnapshot(effect)
            is RelayV2RuntimeEffect.DeliverPostHandshakeFrame -> applyPostHandshakeFrame(effect)
            is RelayV2RuntimeEffect.ReconnectAfterHostPresence ->
                reconnectAfterHostPresence(effect)
            is RelayV2RuntimeEffect.AuthRolloverRequested -> applyAuthExpiring(effect)

            is RelayV2RuntimeEffect.ConnectionFailed -> {
                terminalRuntime.teardownGeneration(effect.generation)
                handleConnectionFailure(effect)
            }
            is RelayV2RuntimeEffect.ConnectRejected -> handleConnectRejected(effect)
            is RelayV2RuntimeEffect.RejectContinuity -> failConnection(
                RelayV2ConnectionFailure(
                    kind = RelayV2FailureKind.SCHEMA,
                    code = "EVENT_CURSOR_AHEAD",
                    retryable = false,
                ),
            )
            is RelayV2RuntimeEffect.Disconnected -> {
                terminalRuntime.teardownGeneration(effect.fencedGeneration)
                fenceConnectionAttempts()
                val agentRecoveryJobs = fenceAgentRecovery()
                retireConnectionAdmissions()
                clearRecoveredDispatch()
                clearSessionProjection()
                agentRecoveryJobs.forEach { it.cancelAndJoin() }
                if (terminalFailure.get() == null) {
                    _state.value = RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.STOPPED)
                }
            }

            is RelayV2RuntimeEffect.RegisterCommandQueryAttempt -> applyCommandQueryAttempt(effect)
            is RelayV2RuntimeEffect.ApplyCommandStatuses -> {
                if (!applyOutboxRecovery(effect)) {
                    failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERY_NOT_OWNED")
                }
            }
            is RelayV2RuntimeEffect.DeliverAgentExtensionFrame,
            is RelayV2RuntimeEffect.AgentExtensionUnavailable,
            -> return consumeAgentEffect(effect)
        }
        return null
    }

    private suspend fun consumeAgentEffect(
        effect: RelayV2RuntimeEffect,
    ): AgentTranscriptLifecycleRuntimeCompositionResult {
        val runtime = agentRuntime
            ?: return AgentTranscriptLifecycleRuntimeCompositionResult.Disabled
        return try {
            runtime.handle(effect)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            AgentTranscriptLifecycleRuntimeCompositionResult.RuntimeFault
        }
    }

    private suspend fun applyHello(effect: RelayV2RuntimeEffect.GenerationScoped) {
        clearRecoveredDispatch()
        when (val applied = actor.withEffectApplyLease(effect) {
            productMutationLock.withLock {
                beforeHelloOutboxAdmissionRead()
                val pendingCommands = admitPendingCommands(effect)
                    ?: return@withLock null
                recoveryAdapter.applyHello(effect, pendingCommands)
            }
        }) {
            is RelayV2EffectApplyResult.Applied -> {
                // Only the actor's exact apply lease may advance Agent recovery generation.
                // Late/forged Hello effects close as Stale below without touching job ownership.
                activateAgentRecoveryGeneration(effect.generation)
                applied.value?.let { submitRecovery(it) }
            }
            RelayV2EffectApplyResult.Stale -> Unit
        }
    }

    private suspend fun applySnapshotChunk(
        effect: RelayV2RuntimeEffect.ApplyStateSnapshotChunk,
    ) {
        clearRecoveredDispatch()
        when (val applied = actor.withEffectApplyLease(effect) {
            productMutationLock.withLock {
                val pendingCommands = requireOutboxAdmission(effect.generation)
                recoveryAdapter.applySnapshotChunk(effect, pendingCommands)
            }
        }) {
            is RelayV2EffectApplyResult.Applied -> submitRecovery(applied.value)
            RelayV2EffectApplyResult.Stale -> Unit
        }
    }

    private suspend fun completeSnapshotRelease(
        effect: RelayV2RuntimeEffect.CompleteSnapshotRelease,
    ) {
        clearRecoveredDispatch()
        when (val applied = actor.withEffectApplyLease(effect) {
            productMutationLock.withLock {
                checkNotNull(recoveryAdapter.completeRelease(effect)) {
                    "Durable snapshot release did not match the actor effect"
                }
            }
        }) {
            is RelayV2EffectApplyResult.Applied -> submitRecovery(applied.value)
            RelayV2EffectApplyResult.Stale -> Unit
        }
    }

    private suspend fun expireSnapshot(
        effect: RelayV2RuntimeEffect.ExpireSnapshotContinuation,
    ) {
        clearRecoveredDispatch()
        when (val applied = actor.withEffectApplyLease(effect) {
            productMutationLock.withLock {
                val pendingCommands = requireOutboxAdmission(effect.generation)
                checkNotNull(
                    recoveryAdapter.expireContinuation(effect, pendingCommands),
                ) { "Durable snapshot expiry did not match the actor effect" }
            }
        }) {
            is RelayV2EffectApplyResult.Applied -> submitRecovery(applied.value)
            RelayV2EffectApplyResult.Stale -> Unit
        }
    }

    private suspend fun applyPostHandshakeFrame(
        effect: RelayV2RuntimeEffect.DeliverPostHandshakeFrame,
    ) {
        val type = effect.message.frame["type"] as? String
        if (type == "error" && applyOutboxRecovery(effect)) {
            return
        }
        if (type in COMMAND_RECOVERY_TYPES) {
            if (!applyOutboxRecovery(effect)) {
                failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERY_NOT_OWNED")
            }
            return
        }
        if (type in TERMINAL_PUBLIC_TYPES) {
            when (val applied = actor.withEffectApplyLease(effect) {
                terminalRuntime.handlePublicFrame(effect.repositoryAuthority, effect.message)
            }) {
                is RelayV2EffectApplyResult.Applied -> when (applied.value) {
                    RelayV2TerminalFrameResult.ProtocolViolation ->
                        failRuntimeIncomplete("TERMINAL_FRAME_PROTOCOL_VIOLATION")
                    RelayV2TerminalFrameResult.NotOwned ->
                        failRuntimeIncomplete("UNOWNED_EFFECT_$type")
                    RelayV2TerminalFrameResult.EffectRejected ->
                        failRuntimeIncomplete("TERMINAL_FRAME_NOT_CURRENT")
                    RelayV2TerminalFrameResult.Applied -> Unit
                }
                RelayV2EffectApplyResult.Stale -> Unit
            }
            return
        }
        if (type !in BASE_STATE_EVENT_TYPES) {
            failRuntimeIncomplete("UNOWNED_EFFECT_${type ?: "UNKNOWN"}")
            return
        }
        clearRecoveredDispatch()
        if (effect.recovery == null) {
            val applied = actor.withEffectApplyLease(effect) {
                productMutationLock.withLock {
                    val pendingCommands = requireOutboxAdmission(effect.generation)
                    recoveryAdapter.applyOnlineStateEvent(effect, pendingCommands)
                }
            }
            when (applied) {
                is RelayV2EffectApplyResult.Applied -> if (applied.value == null) {
                    refreshSessionProjection()
                } else {
                    clearSessionProjection()
                    beforeOnlineResyncReceiptSubmit()
                    submitOnlineResync(applied.value)
                }
                RelayV2EffectApplyResult.Stale -> Unit
            }
        } else {
            when (val applied = actor.withEffectApplyLease(effect) {
                productMutationLock.withLock {
                    val pendingCommands = requireOutboxAdmission(effect.generation)
                    recoveryAdapter.applyRecoveryStateEvent(effect, pendingCommands)
                }
            }) {
                is RelayV2EffectApplyResult.Applied -> applied.value?.let {
                    submitRecovery(it)
                }
                RelayV2EffectApplyResult.Stale -> Unit
            }
        }
    }

    private fun applyAuthExpiring(
        effect: RelayV2RuntimeEffect.AuthRolloverRequested,
    ) {
        val admission = synchronized(connectionLock) {
            val currentProfile = profile
            val bound = boundOutboxAdmission
            val pending = pendingOutboxAdmission
            val ownsBound = bound?.generation == effect.generation &&
                bound.connectionAttempt === effect.connectionAttempt
            val ownsPending = pending?.connectionAttempt === effect.connectionAttempt
            if (credentialRolloverAdmission != null ||
                (!ownsBound && !ownsPending) ||
                (ownsBound && ownsPending) ||
                currentProfile.identity != effect.profile ||
                currentProfile.grantId != effect.grantId ||
                closed.get() || terminalFailure.get() != null
            ) {
                return@synchronized null
            }
            CredentialRolloverAdmission(
                expectedProfile = currentProfile,
                generation = effect.generation,
                connectionAttempt = effect.connectionAttempt,
            ).also { credentialRolloverAdmission = it }
        }
        admission ?: return
        pumpScope.launch {
            val result = try {
                credentialRollover.rollover(admission.expectedProfile)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                RelayV2CredentialRolloverResult.Unavailable
            }
            when (result) {
                is RelayV2CredentialRolloverResult.Refreshed ->
                    completeCredentialRollover(admission, result.profile)
                RelayV2CredentialRolloverResult.Unavailable ->
                    failCredentialRollover(admission)
            }
        }
    }

    private fun completeCredentialRollover(
        admission: CredentialRolloverAdmission,
        refreshed: RelayV2Profile,
    ) {
        var invalid = false
        val attempt = synchronized(connectionLock) {
            if (credentialRolloverAdmission !== admission ||
                closed.get() || terminalFailure.get() != null
            ) return@synchronized null
            val expected = admission.expectedProfile
            val exactSuccess = expected.credentialVersion < Long.MAX_VALUE &&
                refreshed == expected.copy(credentialVersion = expected.credentialVersion + 1)
            val bound = boundOutboxAdmission
            val pending = pendingOutboxAdmission
            val ownsBound = bound?.generation == admission.generation &&
                bound.connectionAttempt === admission.connectionAttempt
            val ownsPending = pending?.connectionAttempt === admission.connectionAttempt
            val ownsLostAdmission = admission.transportLost &&
                bound == null && pending == null
            if (!exactSuccess || connectionAttemptJob != null ||
                (!ownsBound && !ownsPending && !ownsLostAdmission) ||
                (ownsBound && ownsPending)
            ) {
                credentialRolloverAdmission = null
                invalid = true
                return@synchronized null
            }
            if (ownsBound) boundOutboxAdmission = null
            if (ownsPending) pendingOutboxAdmission = null
            profile = refreshed
            credentialRolloverAdmission = null
            retryStateFence = null
            val fence = retryFence
            val job = pumpScope.launch(start = CoroutineStart.LAZY) {
                connectOnce(fence, currentCoroutineContext()[Job]!!)
            }
            trackConnectionAttemptLocked(job)
            job
        }
        if (invalid) {
            failRuntimeIncomplete(RELAY_V2_CREDENTIAL_ROLLOVER_UNAVAILABLE)
            return
        }
        if (attempt == null) return
        cancelAgentRecoveryGeneration(admission.generation)
        clearRecoveredDispatch()
        attempt.start()
    }

    private fun failCredentialRollover(admission: CredentialRolloverAdmission) {
        val current = synchronized(connectionLock) {
            if (credentialRolloverAdmission !== admission) return@synchronized false
            detachConnectionAttemptLocked(admission.connectionAttempt, admission.generation)
            credentialRolloverAdmission = null
            true
        }
        if (!current) return
        cancelAgentRecoveryGeneration(admission.generation)
        clearRecoveredDispatch()
        failRuntimeIncomplete(RELAY_V2_CREDENTIAL_ROLLOVER_UNAVAILABLE)
    }

    private suspend fun applyCommandQueryAttempt(
        effect: RelayV2RuntimeEffect.RegisterCommandQueryAttempt,
    ) {
        val result = try {
            queryAdmissionAdapter.handle(effect)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            failRuntimeIncomplete("COMMAND_OUTBOX_QUERY_COMMIT_FAILED")
            return
        }
        when (result) {
            is RelayV2OutboxQueryAdmissionApplyResult.Committed -> {
                markOutboxTimelineCommit()
                submitRecovery(result.receipt)
            }
            is RelayV2OutboxQueryAdmissionApplyResult.NotOwned ->
                failRuntimeIncomplete("COMMAND_OUTBOX_QUERY_NOT_OWNED")
            is RelayV2OutboxQueryAdmissionApplyResult.Rejected,
            RelayV2OutboxQueryAdmissionApplyResult.CommitProofMismatch,
            -> failRuntimeIncomplete("COMMAND_OUTBOX_QUERY_REJECTED")
            RelayV2OutboxQueryAdmissionApplyResult.Stale -> clearRecoveredDispatch()
        }
    }

    private suspend fun applyOutboxRecovery(effect: RelayV2RuntimeEffect): Boolean {
        val result = try {
            outboxRecoveryAdapter.handle(effect)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERY_APPLY_FAILED")
            return true
        }
        when (result) {
            is RelayV2OutboxRecoveryApplyResult.Committed -> {
                markOutboxTimelineCommit()
                val commit = result.commit
                if (commit is RelayV2OutboxRecoveryCommit.CommandStatuses) {
                    applyRecoveredCommandStatuses(effect, commit, result.dispatchIssuance)
                } else {
                    applyOnlineCommandEvidence(effect, commit, result.dispatchIssuance)
                }
                return true
            }
            is RelayV2OutboxRecoveryApplyResult.NotOwned -> return false
            is RelayV2OutboxRecoveryApplyResult.ProtocolViolation ->
                failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERY_PROTOCOL_VIOLATION")
            is RelayV2OutboxRecoveryApplyResult.Rejected ->
                failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERY_REJECTED")
            RelayV2OutboxRecoveryApplyResult.Stale -> clearRecoveredDispatch()
        }
        return true
    }

    private suspend fun applyOnlineCommandEvidence(
        effect: RelayV2RuntimeEffect,
        commit: RelayV2OutboxRecoveryCommit,
        issuance: RelayV2OutboxDispatchIssuance,
    ) {
        val delivered = effect as? RelayV2RuntimeEffect.DeliverPostHandshakeFrame
        val evidence = commit as? RelayV2OutboxRecoveryCommit.CommandEvidence
        if (delivered == null || evidence == null ||
            evidence.receipt.generation != delivered.generation
        ) {
            failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERED_DISPATCH_INVALID")
            return
        }
        val onlyEffect = evidence.effects.singleOrNull()
        when (onlyEffect) {
            null -> if (evidence.effects.isNotEmpty() ||
                issuance != RelayV2OutboxDispatchIssuance.NoDispatch
            ) {
                failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERED_DISPATCH_INVALID")
            }
            is RelayV2OutboxEffect.ExecuteCommand -> {
                val issued = issuance as? RelayV2OutboxDispatchIssuance.Issued
                val capability = issued?.capabilities?.singleOrNull()
                if (capability == null ||
                    capability.identity.generation != delivered.generation ||
                    capability.identity.commandId != onlyEffect.command.entryId.commandId ||
                    capability.identity.requestId != onlyEffect.attempt.requestId ||
                    outboxDispatcher.dispatch(capability) !is RelayV2OutboxDispatchOutcome.Submitted
                ) {
                    failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERED_DISPATCH_INVALID")
                }
            }
            is RelayV2OutboxEffect.ReissueCreated -> {
                if (issuance != RelayV2OutboxDispatchIssuance.NoDispatch ||
                    onlyEffect.originalEntryId != evidence.receipt.entryId
                ) {
                    failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERED_DISPATCH_INVALID")
                    return
                }
                dispatchFresh(delivered.repositoryAuthority)
            }
            else -> failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERED_DISPATCH_INVALID")
        }
    }

    private suspend fun applyRecoveredCommandStatuses(
        effect: RelayV2RuntimeEffect,
        commit: RelayV2OutboxRecoveryCommit.CommandStatuses,
        issuance: RelayV2OutboxDispatchIssuance,
    ) {
        val statuses = effect as? RelayV2RuntimeEffect.ApplyCommandStatuses
        val queryLineage = statuses?.queryLineage
        if (statuses == null || queryLineage == null ||
            statuses.recovery != commit.receipt.binding ||
            statuses.expectedCommands != commit.receipt.appliedCommands ||
            !accumulateRecoveredDispatch(statuses, commit, issuance)
        ) {
            clearRecoveredDispatch()
            failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERED_DISPATCH_INVALID")
            return
        }
        when (val processed = actor.processRecoveryReceipt(commit.receipt)) {
            RelayV2RecoveryReceiptProcessingResult.ContinuedRecovery -> Unit
            is RelayV2RecoveryReceiptProcessingResult.OnlineReady -> completeOnlineReady(
                authority = processed.authority,
                expectedAuthority = statuses.repositoryAuthority,
                recoveredDispatch = { flushRecoveredDispatch(queryLineage, it) },
            )
            RelayV2RecoveryReceiptProcessingResult.StaleOrTerminal -> {
                clearRecoveredDispatch()
            }
        }
    }

    private fun accumulateRecoveredDispatch(
        effect: RelayV2RuntimeEffect.ApplyCommandStatuses,
        commit: RelayV2OutboxRecoveryCommit.CommandStatuses,
        issuance: RelayV2OutboxDispatchIssuance,
    ): Boolean {
        val queryLineage = requireNotNull(effect.queryLineage)
        val executeEffects = commit.effects.mapNotNull { it as? RelayV2OutboxEffect.ExecuteCommand }
        if (executeEffects.size != commit.effects.size) return false
        val capabilities = when (issuance) {
            RelayV2OutboxDispatchIssuance.NoDispatch -> {
                if (commit.effects.isNotEmpty()) return false
                emptyList()
            }
            is RelayV2OutboxDispatchIssuance.Issued -> {
                if (issuance.capabilities.size != executeEffects.size) return false
                issuance.capabilities
            }
            RelayV2OutboxDispatchIssuance.Disabled,
            is RelayV2OutboxDispatchIssuance.Rejected,
            -> return false
        }
        capabilities.forEachIndexed { index, capability ->
            val execute = executeEffects[index]
            if (capability.identity.generation != effect.generation ||
                capability.identity.commandId != execute.command.entryId.commandId ||
                capability.identity.requestId != execute.attempt.requestId
            ) return false
        }
        val lineage = RecoveredDispatchLineage(queryLineage, effect.repositoryAuthority)
        return synchronized(recoveredDispatchLock) {
            if (closed.get() || terminalFailure.get() != null) return@synchronized false
            val current = recoveredDispatch
            if (current != null && current.lineage != lineage) return@synchronized false
            val buffer = current ?: RecoveredDispatchBuffer(lineage, ArrayList()).also {
                recoveredDispatch = it
            }
            if (buffer.capabilities.size + capabilities.size > MAX_RECOVERED_DISPATCH_CAPABILITIES) {
                return@synchronized false
            }
            val existing = buffer.capabilities.mapTo(HashSet()) { it.identity }
            if (capabilities.any { !existing.add(it.identity) }) return@synchronized false
            buffer.capabilities.addAll(capabilities)
            true
        }
    }

    private fun flushRecoveredDispatch(
        queryLineage: RelayV2QueryRecoveryLineage,
        authority: RelayV2RepositoryEffectAuthority,
    ): Boolean {
        var failureCode: String? = null
        synchronized(recoveredDispatchLock) {
            if (closed.get() || terminalFailure.get() != null) {
                recoveredDispatch = null
                return false
            }
            val buffer = recoveredDispatch
            if (buffer == null ||
                buffer.lineage != RecoveredDispatchLineage(queryLineage, authority)
            ) {
                recoveredDispatch = null
                failureCode = "COMMAND_OUTBOX_RECOVERED_DISPATCH_STALE"
                return@synchronized
            }
            recoveredDispatch = null
            for (capability in buffer.capabilities) {
                if (outboxDispatcher.dispatch(capability) !is
                    RelayV2OutboxDispatchOutcome.Submitted
                ) {
                    failureCode = "COMMAND_OUTBOX_RECOVERED_DISPATCH_FAILED"
                    break
                }
            }
        }
        failureCode?.let(::failRuntimeIncomplete)
        return failureCode == null
    }

    private suspend fun dispatchFresh(
        authority: RelayV2RepositoryEffectAuthority,
    ) {
        val issuedIdentities = HashSet<RelayV2OutboxDispatchIdentity>()
        var issuedCount = 0
        while (!closed.get() && terminalFailure.get() == null) {
            val production = try {
                freshOutboxProducer.produceBatch(authority)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                failRuntimeIncomplete("COMMAND_OUTBOX_FRESH_DISPATCH_COMMIT_FAILED")
                return
            }
            when (production) {
                RelayV2OutboxFreshDispatchProduction.Empty,
                RelayV2OutboxFreshDispatchProduction.Stale,
                -> return
                is RelayV2OutboxFreshDispatchProduction.Rejected -> {
                    failRuntimeIncomplete("COMMAND_OUTBOX_FRESH_DISPATCH_REJECTED")
                    return
                }
                is RelayV2OutboxFreshDispatchProduction.Issued -> {
                    markOutboxTimelineCommit()
                    val capabilities = production.capabilities
                    if (issuedCount + capabilities.size > RelayV2OutboxLimits.MAX_ENTRIES ||
                        capabilities.any {
                            it.identity.generation != authority.generation ||
                                !issuedIdentities.add(it.identity)
                        }
                    ) {
                        failRuntimeIncomplete("COMMAND_OUTBOX_FRESH_DISPATCH_OVERLIMIT")
                        return
                    }
                    issuedCount += capabilities.size
                    for (capability in capabilities) {
                        if (closed.get() || terminalFailure.get() != null) return
                        when (outboxDispatcher.dispatch(capability)) {
                            is RelayV2OutboxDispatchOutcome.Submitted -> Unit
                            is RelayV2OutboxDispatchOutcome.Stale -> return
                            else -> {
                                failRuntimeIncomplete("COMMAND_OUTBOX_FRESH_DISPATCH_FAILED")
                                return
                            }
                        }
                    }
                }
            }
        }
    }

    private suspend fun enqueueSessionCommandUnderLease(
        sessionCut: CompositionSessionReplyCut,
        current: RelayV2CurrentOnlineCommandContext,
        arguments: RelayV2OutboxArguments,
    ): ReplyCommit {
        if (closed.get() || terminalFailure.get() != null) {
            return ReplyCommit.Rejected(RelayV2SessionReplyFailure.PROFILE_BARRIER)
        }
        val authority = current.authority
        val namespace = authority.stateNamespace()
        val issued = sessionCut.materialized
        if (namespace != issued.namespace ||
            issued.cursor.hostEpoch != authority.hostEpoch
        ) {
            return ReplyCommit.Rejected(RelayV2SessionReplyFailure.SESSION_STALE)
        }
        val materialized = try {
            materializedSessions.readMaterializedSessionCut(
                namespace,
                issued.session.scopeId,
                issued.session.sessionId,
            )
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: IllegalStateException) {
            return ReplyCommit.Rejected(RelayV2SessionReplyFailure.CORRUPT_STATE)
        } catch (_: Exception) {
            return ReplyCommit.Rejected(RelayV2SessionReplyFailure.STORE_FAILURE)
        }
        if (materialized != issued) {
            return ReplyCommit.Rejected(RelayV2SessionReplyFailure.SESSION_STALE)
        }
        val enqueue = try {
            val commandId = newCommandId()
            outboxEnqueueAuthority.enqueueOutbox(
                namespace = authority.outboxNamespace(),
                draft = RelayV2OutboxDraft(
                    profileId = authority.profileId,
                    principalId = authority.principalId,
                    hostId = authority.hostId,
                    expectedHostEpoch = authority.hostEpoch,
                    dedupeWindowId = current.dedupeWindow.windowId,
                    commandId = commandId,
                    scopeId = materialized.session.scopeId,
                    sessionId = materialized.session.sessionId,
                    arguments = arguments,
                ),
                createdAtMillis = clock(),
            )
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return ReplyCommit.Rejected(RelayV2SessionReplyFailure.STORE_FAILURE)
        }
        return when (enqueue) {
            is RelayV2OutboxEnqueueResult.Committed -> {
                markOutboxTimelineCommit()
                ReplyCommit.Committed(authority, enqueue.receipt)
            }
            is RelayV2OutboxEnqueueResult.Rejected -> ReplyCommit.Rejected(
                when (enqueue.failure) {
                    RelayV2OutboxEnqueueFailure.DUPLICATE_COMMAND ->
                        RelayV2SessionReplyFailure.DUPLICATE_COMMAND
                    RelayV2OutboxEnqueueFailure.CAPACITY_EXCEEDED ->
                        RelayV2SessionReplyFailure.CAPACITY_EXCEEDED
                    RelayV2OutboxEnqueueFailure.FOREIGN_LINEAGE ->
                        RelayV2SessionReplyFailure.FOREIGN_LINEAGE
                    RelayV2OutboxEnqueueFailure.CORRUPT_STATE,
                    RelayV2OutboxEnqueueFailure.UNKNOWN_STATE,
                    -> RelayV2SessionReplyFailure.CORRUPT_STATE
                    RelayV2OutboxEnqueueFailure.STORE_FAILURE ->
                        RelayV2SessionReplyFailure.STORE_FAILURE
                },
            )
        }
    }

    private suspend fun enqueueCreateWorktreeUnderLease(
        scopeCut: CompositionScopeCreateCut,
        current: RelayV2CurrentOnlineCommandContext,
        inputs: RelayV2CreateWorktreeInputs,
    ): ScopeCreateCommit {
        if (closed.get() || terminalFailure.get() != null) {
            return ScopeCreateCommit.Rejected(RelayV2ScopeCreateFailure.PROFILE_BARRIER)
        }
        if (currentIssuedScope(scopeCut) !== scopeCut) {
            return ScopeCreateCommit.Rejected(RelayV2ScopeCreateFailure.SCOPE_STALE)
        }
        val authority = current.authority
        val namespace = authority.stateNamespace()
        val issued = scopeCut.authority
        if (authority.outboxNamespace() != issued.activationNamespace ||
            namespace != issued.namespace ||
            namespace.hostEpoch != authority.hostEpoch
        ) {
            return ScopeCreateCommit.Rejected(RelayV2ScopeCreateFailure.SCOPE_STALE)
        }
        val projection = try {
            materializedSessions.readMaterializedSessionCuts(namespace)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: IllegalStateException) {
            return ScopeCreateCommit.Rejected(RelayV2ScopeCreateFailure.CORRUPT_STATE)
        } catch (_: Exception) {
            return ScopeCreateCommit.Rejected(RelayV2ScopeCreateFailure.STORE_FAILURE)
        }
        if (projection.any { materialized ->
                materialized.namespace != namespace ||
                    materialized.cursor.hostEpoch != authority.hostEpoch ||
                    materialized.scope.scopeId != materialized.session.scopeId
            }
        ) {
            return ScopeCreateCommit.Rejected(RelayV2ScopeCreateFailure.CORRUPT_STATE)
        }
        val scopeSessions = projection.filter { materialized ->
            materialized.scope.scopeId == issued.scope.scopeId
        }
        if (scopeSessions.isEmpty()) {
            return ScopeCreateCommit.Rejected(RelayV2ScopeCreateFailure.SCOPE_STALE)
        }
        val materializedScopeAuthorities = scopeSessions
            .map { materialized -> materialized.scopesRevision to materialized.scope }
            .distinct()
        if (materializedScopeAuthorities.size != 1) {
            return ScopeCreateCommit.Rejected(RelayV2ScopeCreateFailure.CORRUPT_STATE)
        }
        if (materializedScopeAuthorities.single() != (issued.scopesRevision to issued.scope)) {
            return ScopeCreateCommit.Rejected(RelayV2ScopeCreateFailure.SCOPE_STALE)
        }
        val arguments = try {
            RelayV2OutboxArguments.createWorktree(
                project = inputs.project,
                path = inputs.path,
                name = inputs.name,
                branch = inputs.branch,
                aiCommand = inputs.aiCommand,
            )
        } catch (_: Exception) {
            return ScopeCreateCommit.Rejected(RelayV2ScopeCreateFailure.INVALID_INPUT)
        }
        val enqueue = try {
            outboxEnqueueAuthority.enqueueOutbox(
                namespace = authority.outboxNamespace(),
                draft = RelayV2OutboxDraft(
                    profileId = authority.profileId,
                    principalId = authority.principalId,
                    hostId = authority.hostId,
                    expectedHostEpoch = authority.hostEpoch,
                    dedupeWindowId = current.dedupeWindow.windowId,
                    commandId = newCommandId(),
                    scopeId = issued.scope.scopeId,
                    sessionId = null,
                    arguments = arguments,
                ),
                createdAtMillis = clock(),
            )
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return ScopeCreateCommit.Rejected(RelayV2ScopeCreateFailure.STORE_FAILURE)
        }
        return when (enqueue) {
            is RelayV2OutboxEnqueueResult.Committed -> {
                markOutboxTimelineCommit()
                ScopeCreateCommit.Committed(authority, enqueue.receipt)
            }
            is RelayV2OutboxEnqueueResult.Rejected -> ScopeCreateCommit.Rejected(
                when (enqueue.failure) {
                    RelayV2OutboxEnqueueFailure.DUPLICATE_COMMAND ->
                        RelayV2ScopeCreateFailure.DUPLICATE_COMMAND
                    RelayV2OutboxEnqueueFailure.CAPACITY_EXCEEDED ->
                        RelayV2ScopeCreateFailure.CAPACITY_EXCEEDED
                    RelayV2OutboxEnqueueFailure.FOREIGN_LINEAGE ->
                        RelayV2ScopeCreateFailure.FOREIGN_LINEAGE
                    RelayV2OutboxEnqueueFailure.CORRUPT_STATE,
                    RelayV2OutboxEnqueueFailure.UNKNOWN_STATE,
                    -> RelayV2ScopeCreateFailure.CORRUPT_STATE
                    RelayV2OutboxEnqueueFailure.STORE_FAILURE ->
                        RelayV2ScopeCreateFailure.STORE_FAILURE
                },
            )
        }
    }

    private suspend fun refreshSessionProjection() {
        if (closed.get() || terminalFailure.get() != null) {
            clearSessionProjection()
            return
        }
        val issued = when (val result = actor.currentOnlineCommandCut()) {
            RelayV2CurrentOnlineCommandCutResult.Unavailable -> {
                clearSessionProjection()
                return
            }
            is RelayV2CurrentOnlineCommandCutResult.Available -> result.cut
        }
        val published = try {
            actor.withCurrentOnlineCommandLease(issued) { current ->
                productMutationLock.withLock {
                    val scopeCuts = LinkedHashMap<ScopeCreateAuthority, CompositionScopeCreateCut>()
                    val projection = materializedSessions.readMaterializedSessionCuts(
                        current.authority.stateNamespace(),
                    ).map { materialized ->
                        check(materialized.namespace == current.authority.stateNamespace()) {
                            "Relay v2 Session projection crossed current actor authority"
                        }
                        val scopeAuthority = ScopeCreateAuthority.from(
                            materialized,
                            current.authority.outboxNamespace(),
                        )
                        val scopeCreateCut = scopeCuts.getOrPut(scopeAuthority) {
                            CompositionScopeCreateCut(
                                origin = this,
                                onlineCut = issued,
                                authority = scopeAuthority,
                            )
                        }
                        RelayV2ProductSession(
                            materialized = materialized,
                            replyCut = CompositionSessionReplyCut(
                                origin = this,
                                onlineCut = issued,
                                materialized = materialized,
                            ),
                            scopeCreateCut = scopeCreateCut,
                        )
                    }
                    beforeSessionProjectionPublish()
                    val published = !closed.get() && terminalFailure.get() == null &&
                        actor.runIfCurrent(issued) {
                            _sessions.value = projection
                        }
                    if (!published) {
                        clearSessionProjection()
                    }
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            clearSessionProjection()
            failRuntimeIncomplete("SESSION_PROJECTION_READ_FAILED")
            return
        }
        when (published) {
            RelayV2CurrentOnlineCommandLeaseResult.Stale -> clearSessionProjection()
            is RelayV2CurrentOnlineCommandLeaseResult.Current -> Unit
        }
    }

    private fun clearSessionProjection() {
        _sessions.value = emptyList()
    }

    private fun clearRecoveredDispatch() {
        synchronized(recoveredDispatchLock) { recoveredDispatch = null }
    }

    /** The sole publication marker for a successfully completed durable Outbox transaction. */
    private fun markOutboxTimelineCommit() {
        synchronized(outboxTimelineRevisionLock) {
            _outboxTimelineRevision.value = _outboxTimelineRevision.value + 1L
        }
    }

    /** Replay-latest invalidation for an eligible Agent durable presentation commit. */
    private fun markAgentTimelineCommit() {
        synchronized(agentTimelineRevisionLock) {
            _agentTimelineRevision.value = _agentTimelineRevision.value + 1L
        }
    }

    private fun RelayV2OutboxState.toActivationSnapshot(
        expectedProfile: RelayV2Profile,
    ): ActivationOutboxSnapshot {
        val active = ArrayList<RelayV2OutboxEntry>()
        entries.forEach { entry ->
            if (entry.profileId != expectedProfile.profileId ||
                entry.principalId != expectedProfile.principalId
            ) {
                error("Relay v2 Outbox escaped the exact activation namespace")
            }
            when (entry.state) {
                RelayV2OutboxStateTag.QUEUED,
                RelayV2OutboxStateTag.SENDING,
                RelayV2OutboxStateTag.ACCEPTED,
                RelayV2OutboxStateTag.CONFIRMING,
                RelayV2OutboxStateTag.AMBIGUOUS,
                -> {
                    if (entry.hostId != expectedProfile.hostId) {
                        error("Relay v2 Outbox contains a foreign active host lineage")
                    }
                    active += entry
                }
                RelayV2OutboxStateTag.SUCCEEDED,
                RelayV2OutboxStateTag.FAILED_FINAL,
                RelayV2OutboxStateTag.REISSUED,
                -> Unit
            }
        }
        return ActivationOutboxSnapshot(active.toList())
    }

    private fun admitPendingCommands(
        effect: RelayV2RuntimeEffect.GenerationScoped,
    ): List<RelayV2PendingCommand>? {
        val (context, connectionAttempt) = when (effect) {
            is RelayV2RuntimeEffect.QueryPendingCommands ->
                effect.context to effect.connectionAttempt
            is RelayV2RuntimeEffect.BeginStateResync ->
                effect.context to effect.connectionAttempt
            else -> error("Effect is not a Relay v2 hello apply")
        }
        val admission = synchronized(connectionLock) {
            checkNotNull(pendingOutboxAdmission?.takeIf {
                it.connectionAttempt === connectionAttempt
            }) {
                "Relay v2 hello does not own the pending connection Outbox admission"
            }
        }
        val snapshot = admission.snapshot
        if (snapshot.activeEntries.any {
                it.hostId != context.hostId || it.expectedHostEpoch != context.hostEpoch
            }
        ) {
            failRuntimeIncomplete("DURABLE_OUTBOX_FOREIGN_ACTIVE_LINEAGE")
            return null
        }
        val pending = snapshot.activeEntries.filter {
            it.state != RelayV2OutboxStateTag.QUEUED
        }.map { entry ->
            RelayV2PendingCommand(entry.commandId, entry.dedupeWindowId)
        }.toList()
        return synchronized(connectionLock) {
            check(pendingOutboxAdmission === admission) {
                "Relay v2 connection Outbox admission changed during hello apply"
            }
            check(boundOutboxAdmission == null) {
                "Relay v2 connection Outbox admission was already bound"
            }
            pendingOutboxAdmission = null
            BoundOutboxAdmission(
                connectionAttempt = connectionAttempt,
                generation = effect.generation,
                pendingCommands = pending,
            ).also { boundOutboxAdmission = it }.pendingCommands
        }
    }

    private fun requireOutboxAdmission(
        generation: RelayV2EffectGeneration,
    ): List<RelayV2PendingCommand> = synchronized(connectionLock) {
        checkNotNull(boundOutboxAdmission?.takeIf { it.generation == generation }) {
            "Relay v2 base sync has no exact connection Outbox admission"
        }.pendingCommands
    }

    private fun markOnline(generation: RelayV2EffectGeneration): Boolean =
        synchronized(connectionLock) {
            if (boundOutboxAdmission?.generation != generation) return@synchronized false
            retryAttempt = 0
            true
        }

    private suspend fun submitRecovery(receipt: RelayV2RecoveryReceipt) {
        when (val processed = actor.processRecoveryReceipt(receipt)) {
            RelayV2RecoveryReceiptProcessingResult.ContinuedRecovery -> Unit
            is RelayV2RecoveryReceiptProcessingResult.OnlineReady ->
                completeOnlineReady(processed.authority)
            RelayV2RecoveryReceiptProcessingResult.StaleOrTerminal -> {
                clearRecoveredDispatch()
            }
        }
    }

    private suspend fun completeOnlineReady(
        authority: RelayV2RepositoryEffectAuthority,
        expectedAuthority: RelayV2RepositoryEffectAuthority = authority,
        recoveredDispatch: (RelayV2RepositoryEffectAuthority) -> Boolean = { true },
    ) {
        // OnlineReady is the sole handoff. Its actor-issued authority is never reconstructed or
        // inferred from the ordinary ONLINE projection.
        if (authority != expectedAuthority) {
            clearRecoveredDispatch()
            failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERED_DISPATCH_STALE")
            return
        }
        if (!markOnline(authority.generation)) {
            clearRecoveredDispatch()
            failRuntimeIncomplete("DURABLE_OUTBOX_ADMISSION_STALE")
            return
        }
        refreshSessionProjection()
        if (!recoveredDispatch(authority)) return
        dispatchFresh(authority)
        startAgentRecovery(authority)
    }

    private fun activateAgentRecoveryGeneration(generation: RelayV2EffectGeneration) {
        synchronized(agentRecoveryLock) {
            if (agentRecoveryAdmissionFenced) return
            if (agentRecoveryGeneration == generation) return
            agentRecoveryGeneration = generation
            agentRecoveryStartedGeneration = null
            agentRecoveryJobs.forEach(Job::cancel)
        }
    }

    private fun startAgentRecovery(authority: RelayV2RepositoryEffectAuthority) {
        val runtime = agentRuntime ?: return
        var recovery: Job? = null
        synchronized(agentRecoveryLock) {
            if (agentRecoveryAdmissionFenced || closed.get() || terminalFailure.get() != null ||
                agentRecoveryGeneration != authority.generation ||
                agentRecoveryStartedGeneration == authority.generation
            ) return
            val job = pumpScope.launch(start = CoroutineStart.LAZY) {
                currentCoroutineContext().ensureActive()
                val ownJob = currentCoroutineContext()[Job]
                val current = synchronized(agentRecoveryLock) {
                    ownJob in agentRecoveryJobs &&
                        agentRecoveryGeneration == authority.generation &&
                        agentRecoveryStartedGeneration == authority.generation
                }
                if (!current) return@launch
                try {
                    runtime.recoverPersistedRequestsAfterOnlineReady(authority, actor)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Throwable) {
                    // Agent recovery is extension-scoped. Base ONLINE, command Outbox, terminal
                    // routing, and credential authority are deliberately unaffected.
                }
            }
            agentRecoveryStartedGeneration = authority.generation
            agentRecoveryJobs += job
            job.invokeOnCompletion {
                synchronized(agentRecoveryLock) {
                    agentRecoveryJobs.remove(job)
                }
            }
            recovery = job
        }
        recovery?.start()
    }

    private fun fenceAgentRecovery(): List<Job> = synchronized(agentRecoveryLock) {
        agentRecoveryAdmissionFenced = true
        agentRecoveryGeneration = null
        agentRecoveryStartedGeneration = null
        agentRecoveryJobs.toList().also { jobs -> jobs.forEach(Job::cancel) }
    }

    private fun cancelAgentRecoveryGeneration(generation: RelayV2EffectGeneration?) {
        if (generation == null) return
        synchronized(agentRecoveryLock) {
            if (agentRecoveryGeneration != generation) return
            agentRecoveryGeneration = null
            agentRecoveryStartedGeneration = null
            agentRecoveryJobs.forEach(Job::cancel)
        }
    }

    private suspend fun submitOnlineResync(receipt: RelayV2OnlineResyncRequired) {
        clearRecoveredDispatch()
        actor.submitOnlineResyncRequired(receipt)
    }

    private fun handleConnectionFailure(effect: RelayV2RuntimeEffect.ConnectionFailed) {
        if (claimCredentialRolloverTransportLoss(effect)) {
            cancelAgentRecoveryGeneration(effect.generation)
            clearRecoveredDispatch()
            return
        }
        val connectionAttempt = effect.connectionAttempt
        if (connectionAttempt == null) {
            failConnection(effect.failure)
            return
        }
        if (effect.failure.retryable && profile.autoConnect && effect.generation != null) {
            when (scheduleReconnect(connectionAttempt, effect.generation, effect.failure)) {
                RetryScheduleResult.SCHEDULED,
                RetryScheduleResult.FENCED,
                -> {
                    cancelAgentRecoveryGeneration(effect.generation)
                    clearRecoveredDispatch()
                }
                RetryScheduleResult.STALE -> Unit
            }
            return
        }
        val exactAttempt = detachConnectionAttempt(connectionAttempt, effect.generation)
        if (!exactAttempt) return
        cancelAgentRecoveryGeneration(effect.generation)
        clearRecoveredDispatch()
        failConnection(effect.failure)
    }

    private fun claimCredentialRolloverTransportLoss(
        effect: RelayV2RuntimeEffect.ConnectionFailed,
    ): Boolean = synchronized(connectionLock) {
        val admission = credentialRolloverAdmission ?: return@synchronized false
        if (effect.generation != admission.generation ||
            effect.connectionAttempt !== admission.connectionAttempt ||
            (!effect.failure.retryable &&
                !(effect.failure.kind == RelayV2FailureKind.AUTH &&
                    effect.failure.code == "AUTH_REQUIRED"))
        ) return@synchronized false
        detachConnectionAttemptLocked(admission.connectionAttempt, admission.generation)
        admission.transportLost = true
        true
    }

    private fun reconnectAfterHostPresence(
        effect: RelayV2RuntimeEffect.ReconnectAfterHostPresence,
    ) {
        if (effect.profile != profile.identity) return
        var conflicted = false
        val attempt = synchronized(connectionLock) {
            credentialRolloverAdmission?.let { rollover ->
                if (rollover.generation == effect.generation &&
                    rollover.connectionAttempt === effect.connectionAttempt
                ) return@synchronized null
            }
            val bound = boundOutboxAdmission
            val ownsBound = bound?.generation == effect.generation &&
                bound.connectionAttempt === effect.connectionAttempt
            val ownsPending = pendingOutboxAdmission?.connectionAttempt === effect.connectionAttempt
            if ((!ownsBound && !ownsPending) ||
                !reconnectEnabled || closed.get() || terminalFailure.get() != null
            ) {
                return@synchronized null
            }
            if ((ownsBound && ownsPending) || connectionAttemptJob != null) {
                conflicted = true
                return@synchronized null
            }
            if (ownsBound) boundOutboxAdmission = null else pendingOutboxAdmission = null
            retryStateFence = null
            val fence = retryFence
            val job = pumpScope.launch(start = CoroutineStart.LAZY) {
                connectOnce(fence, currentCoroutineContext()[Job]!!)
            }
            trackConnectionAttemptLocked(job)
            job
        }
        if (conflicted) {
            failRuntimeIncomplete("HOST_PRESENCE_RECONNECT_CONFLICT")
            return
        }
        if (attempt == null) return
        cancelAgentRecoveryGeneration(effect.generation)
        clearRecoveredDispatch()
        attempt.start()
    }

    private fun handleConnectRejected(effect: RelayV2RuntimeEffect.ConnectRejected) {
        if (!detachConnectionAttempt(effect.connectionAttempt, generation = null)) return
        failConnection(effect.failure)
    }

    private fun detachConnectionAttempt(
        connectionAttempt: RelayV2ConnectionAttemptIdentity,
        generation: RelayV2EffectGeneration?,
    ): Boolean = synchronized(connectionLock) {
        detachConnectionAttemptLocked(connectionAttempt, generation)
    }

    private fun detachConnectionAttemptLocked(
        connectionAttempt: RelayV2ConnectionAttemptIdentity,
        generation: RelayV2EffectGeneration?,
    ): Boolean {
        val pending = pendingOutboxAdmission
        if (pending?.connectionAttempt === connectionAttempt) {
            pendingOutboxAdmission = null
            return true
        }
        val bound = boundOutboxAdmission
        if (bound?.connectionAttempt === connectionAttempt &&
            generation != null && bound.generation == generation
        ) {
            boundOutboxAdmission = null
            return true
        }
        return false
    }

    private fun matchesConnectionAttemptLocked(
        connectionAttempt: RelayV2ConnectionAttemptIdentity,
        generation: RelayV2EffectGeneration,
    ): Boolean {
        val pending = pendingOutboxAdmission
        if (pending?.connectionAttempt === connectionAttempt) return true
        val bound = boundOutboxAdmission
        return bound?.connectionAttempt === connectionAttempt && bound.generation == generation
    }

    private fun scheduleReconnect(
        connectionAttempt: RelayV2ConnectionAttemptIdentity,
        failedGeneration: RelayV2EffectGeneration,
        failure: RelayV2ConnectionFailure,
    ): RetryScheduleResult {
        var timer: Job? = null
        val result = synchronized(connectionLock) {
            if (!matchesConnectionAttemptLocked(connectionAttempt, failedGeneration)) {
                return@synchronized RetryScheduleResult.STALE
            }
            if (!reconnectEnabled || closed.get() || terminalFailure.get() != null) {
                return@synchronized RetryScheduleResult.FENCED
            }
            check(detachConnectionAttemptLocked(connectionAttempt, failedGeneration))
            afterRetryableFailureAdmissionDetached()
            check(connectionAttemptJob == null) { "Relay v2 connection attempt already exists" }
            check(pendingOutboxAdmission == null && boundOutboxAdmission == null)
            val fence = retryFence
            val delayMs = retryDelayMillis(retryAttempt)
            retryAttempt = minOf(retryAttempt + 1, MAX_RETRY_EXPONENT)
            retryStateFence = RetryStateFence(failedGeneration, failure)
            val scheduledTimer = pumpScope.launch(start = CoroutineStart.LAZY) {
                try {
                    retryDelay(delayMs)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Throwable) {
                    failRuntimeIncomplete("RECONNECT_BACKOFF_FAILED")
                    return@launch
                }
                connectOnce(fence, currentCoroutineContext()[Job]!!)
            }
            timer = scheduledTimer
            trackConnectionAttemptLocked(scheduledTimer)
            synchronized(stateLock) {
                if (!closed.get() && terminalFailure.get() == null) {
                    _state.value = RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.CONNECTING)
                }
            }
            RetryScheduleResult.SCHEDULED
        }
        if (result == RetryScheduleResult.SCHEDULED) checkNotNull(timer).start()
        return result
    }

    private fun retryDelayMillis(attempt: Int): Long {
        val multiplier = 1L shl minOf(attempt, MAX_RETRY_EXPONENT)
        return minOf(RETRY_BASE_DELAY_MS * multiplier, RETRY_MAX_DELAY_MS)
    }

    private fun canConnectLocked(expectedFence: Any): Boolean =
        reconnectEnabled && retryFence === expectedFence && !closed.get() &&
            terminalFailure.get() == null

    private fun ownsConnectionAttempt(expectedFence: Any, expectedJob: Job): Boolean =
        synchronized(connectionLock) {
            ownsConnectionAttemptLocked(expectedFence, expectedJob)
        }

    private fun ownsConnectionAttemptLocked(expectedFence: Any, expectedJob: Job): Boolean =
        connectionAttemptJob === expectedJob && canConnectLocked(expectedFence)

    private fun trackConnectionAttemptLocked(job: Job) {
        check(connectionAttemptJob == null) { "Relay v2 connection attempt already exists" }
        connectionAttemptJob = job
        job.invokeOnCompletion {
            synchronized(connectionLock) {
                if (connectionAttemptJob === job) connectionAttemptJob = null
            }
        }
    }

    private fun fenceConnectionAttempts(): Job? {
        val attempt = synchronized(connectionLock) {
            reconnectEnabled = false
            retryFence = Any()
            retryStateFence = null
            connectionAttemptJob.also { connectionAttemptJob = null }
        }
        attempt?.cancel()
        return attempt
    }

    private fun retireConnectionAdmissions() {
        synchronized(connectionLock) {
            pendingOutboxAdmission = null
            boundOutboxAdmission = null
            credentialRolloverAdmission = null
        }
    }

    private fun failConnection(failure: RelayV2ConnectionFailure) {
        fail(RelayV2BaseRuntimeFailure.Connection(failure))
    }

    private fun failRuntimeIncomplete(code: String) {
        fail(RelayV2BaseRuntimeFailure.RuntimeIncomplete(code))
    }

    private fun fail(failure: RelayV2BaseRuntimeFailure) {
        if (closed.get() || !terminalFailure.compareAndSet(null, failure)) return
        fenceConnectionAttempts()
        clearRecoveredDispatch()
        clearSessionProjection()
        synchronized(stateLock) {
            _state.value = RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.FAILED, failure)
        }
        beginActorShutdown()
    }

    private fun beginActorShutdown() {
        if (!actorShutdownStarted.compareAndSet(false, true)) return
        val agentRecoveryJobs = fenceAgentRecovery()
        actor.close()
        // actor.close() withdraws ONLINE publication under lifecycleLock; this synchronous clear
        // therefore cannot be followed by a cut that was current before shutdown.
        clearSessionProjection()
        pumpJob.cancel()
        actorScope.launch {
            try {
                terminalRuntime.dispose()
                actor.disconnectAndDrain(profile.identity, CLOSE_BARRIER_ID)
            } catch (_: Throwable) {
                // A forced transport-fence close completes the same shutdown barrier exceptionally.
            } finally {
                agentRecoveryJobs.forEach { it.cancelAndJoin() }
                clearSessionProjection()
                retireConnectionAdmissions()
                parentCompletionHandle.getAndSet(null)?.dispose()
                actorOwnerJob.cancel()
            }
        }
    }

    private fun publishActorState(actorState: RelayV2ConnectionState) {
        if (closed.get() || terminalFailure.get() != null) return
        val retrying = shouldProjectRetryAsConnecting(actorState)
        val phase = if (retrying) RelayV2BaseRuntimePhase.CONNECTING else when (actorState.phase) {
            RelayV2ConnectionPhase.STOPPED,
            RelayV2ConnectionPhase.DISCONNECTED,
            RelayV2ConnectionPhase.CLOSED,
            -> RelayV2BaseRuntimePhase.STOPPED

            RelayV2ConnectionPhase.CONNECTING,
            RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME,
            RelayV2ConnectionPhase.AWAITING_HOST_WELCOME,
            RelayV2ConnectionPhase.QUERYING,
            -> RelayV2BaseRuntimePhase.CONNECTING

            RelayV2ConnectionPhase.RESYNCING -> RelayV2BaseRuntimePhase.RESYNCING
            RelayV2ConnectionPhase.ONLINE -> RelayV2BaseRuntimePhase.ONLINE
            RelayV2ConnectionPhase.SUSPENDED -> RelayV2BaseRuntimePhase.SUSPENDED
            RelayV2ConnectionPhase.CONTINUITY_REJECTED,
            RelayV2ConnectionPhase.FAILED,
            -> RelayV2BaseRuntimePhase.FAILED
        }
        val failure = if (retrying) {
            null
        } else {
            actorState.failure?.let(RelayV2BaseRuntimeFailure::Connection)
        }
        if (phase != RelayV2BaseRuntimePhase.ONLINE &&
            phase != RelayV2BaseRuntimePhase.SUSPENDED
        ) {
            clearSessionProjection()
        }
        synchronized(stateLock) {
            if (!closed.get() && terminalFailure.get() == null) {
                _state.value = RelayV2BaseRuntimeState(phase, failure)
            }
        }
    }

    private fun shouldProjectRetryAsConnecting(
        actorState: RelayV2ConnectionState,
    ): Boolean = synchronized(connectionLock) {
        val failure = actorState.failure
        val sameActivation = actorState.profileId == profile.profileId &&
            actorState.activationGeneration == profile.activationGeneration
        val fence = retryStateFence
        val fencedFailedState = sameActivation && fence != null &&
            actorState.connectionGeneration <= fence.generation.connectionGeneration &&
            failure == fence.failure
        if (sameActivation && fence != null &&
            actorState.connectionGeneration > fence.generation.connectionGeneration &&
            !(actorState.phase == RelayV2ConnectionPhase.FAILED && failure?.retryable == true)
        ) {
            retryStateFence = null
        }
        reconnectEnabled && actorState.phase == RelayV2ConnectionPhase.FAILED &&
            (failure?.retryable == true || fencedFailedState)
    }

    private companion object {
        val TERMINAL_PUBLIC_TYPES = setOf(
            "error",
            "terminal.opened",
            "terminal.output",
            "terminal.replay_started",
            "terminal.reset_required",
            "terminal.input_ack",
            "terminal.input_error",
            "terminal.resize_ack",
            "terminal.resize_error",
            "terminal.closed",
        )
        val BASE_STATE_EVENT_TYPES = setOf("scopes.changed", "sessions.changed")
        val COMMAND_RECOVERY_TYPES = setOf("command.status", "command.result")
        const val CLOSE_BARRIER_ID = "relay-v2-base-runtime-close"
        const val MAX_RECOVERED_DISPATCH_CAPABILITIES = 4_096
        const val SELECTED_SESSION_PRESENTATION_PAGE_LIMIT = 64
        const val MAX_SELECTED_SESSION_REPLY_ROWS = 256
        const val RETRY_BASE_DELAY_MS = 1_000L
        const val RETRY_MAX_DELAY_MS = 30_000L
        const val MAX_RETRY_EXPONENT = 5
    }

    private data class ActivationOutboxSnapshot(
        val activeEntries: List<RelayV2OutboxEntry>,
    )

    private data class PendingOutboxAdmission(
        val connectionAttempt: RelayV2ConnectionAttemptIdentity,
        val snapshot: ActivationOutboxSnapshot,
    )

    private data class BoundOutboxAdmission(
        val connectionAttempt: RelayV2ConnectionAttemptIdentity,
        val generation: RelayV2EffectGeneration,
        val pendingCommands: List<RelayV2PendingCommand>,
    )

    private class CredentialRolloverAdmission(
        val expectedProfile: RelayV2Profile,
        val generation: RelayV2EffectGeneration,
        val connectionAttempt: RelayV2ConnectionAttemptIdentity,
        var transportLost: Boolean = false,
    )

    private data class RetryStateFence(
        val generation: RelayV2EffectGeneration,
        val failure: RelayV2ConnectionFailure,
    )

    private enum class RetryScheduleResult {
        SCHEDULED,
        FENCED,
        STALE,
    }

    private data class RecoveredDispatchLineage(
        val queryLineage: RelayV2QueryRecoveryLineage,
        val authority: RelayV2RepositoryEffectAuthority,
    )

    private data class RecoveredDispatchBuffer(
        val lineage: RecoveredDispatchLineage,
        val capabilities: ArrayList<RelayV2OutboxDispatchCapability>,
    )

    private class CompositionSessionReplyCut(
        val origin: RelayV2BaseRuntimeComposition,
        val onlineCut: RelayV2CurrentOnlineCommandCut,
        val materialized: RelayV2MaterializedSessionReadCut,
    ) : RelayV2SessionReplyCut

    private data class ScopeCreateAuthority(
        val activationNamespace: RelayV2OutboxAuthorityNamespace,
        val namespace: RelayV2StateNamespace,
        val scopesRevision: String,
        val scope: RelayV2ScopeResource,
    ) {
        companion object {
            fun from(
                materialized: RelayV2MaterializedSessionReadCut,
                activationNamespace: RelayV2OutboxAuthorityNamespace,
            ) = ScopeCreateAuthority(
                activationNamespace = activationNamespace,
                namespace = materialized.namespace,
                scopesRevision = materialized.scopesRevision,
                scope = materialized.scope,
            )
        }
    }

    private class CompositionScopeCreateCut(
        val origin: RelayV2BaseRuntimeComposition,
        val onlineCut: RelayV2CurrentOnlineCommandCut,
        val authority: ScopeCreateAuthority,
    ) : RelayV2ScopeCreateCut

    private sealed interface ReplyCommit {
        data class Committed(
            val authority: RelayV2RepositoryEffectAuthority,
            val receipt: RelayV2OutboxEnqueueReceipt,
        ) : ReplyCommit

        data class Rejected(val failure: RelayV2SessionReplyFailure) : ReplyCommit
    }

    private sealed interface ScopeCreateCommit {
        data class Committed(
            val authority: RelayV2RepositoryEffectAuthority,
            val receipt: RelayV2OutboxEnqueueReceipt,
        ) : ScopeCreateCommit

        data class Rejected(val failure: RelayV2ScopeCreateFailure) : ScopeCreateCommit
    }
}

private fun RelayV2RepositoryEffectAuthority.stateNamespace() =
    com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateNamespace(
        profileId = profileId,
        principalId = principalId,
        clientInstanceId = clientInstanceId,
        hostId = hostId,
        hostEpoch = hostEpoch,
    )

private fun RelayV2RepositoryEffectAuthority.outboxNamespace() =
    RelayV2OutboxAuthorityNamespace(
        profileId = profileId,
        profileActivationGeneration = profileActivationGeneration,
        principalId = principalId,
        clientInstanceId = clientInstanceId,
    )
