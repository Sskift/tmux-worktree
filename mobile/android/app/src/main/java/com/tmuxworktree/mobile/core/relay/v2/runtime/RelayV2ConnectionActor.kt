package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleActorRequest
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleCompletedBatchHandoffReceipt
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleCompletedHandoffReceipt
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleDurableHandoffPort
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleExactRedriveReplacement
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleExtensionRequestSender
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRequestAdmission
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleRequestKind
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.AgentTranscriptLifecycleTrustedIngress
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineErrorCode
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineErrorFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineEventFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineHostEpochMismatchDetails
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineReplayPageFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineResetFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotPageFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineStatusFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1Codec
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1CodecException
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1FrameMetadata
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1InboundFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1PublicFrameArtifact
import com.tmuxworktree.mobile.core.relay.runtime.BoundedActionQueue
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2CodecException
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2DecodedMessage
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2FrameMetadata
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2WebSocketChannel
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDialect
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectBarrier
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialBlob
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialSecretValidator
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialStore
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.profile.matchesCredentialBinding
import java.io.Closeable
import java.math.BigInteger
import java.security.MessageDigest
import java.util.Base64
import java.util.Collections
import java.util.IdentityHashMap
import java.util.UUID
import java.util.concurrent.CancellationException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select

/**
 * Serialized Relay v2 client runtime seam.
 *
 * The actor owns transport identity and all handshake state. Callback entry atomically binds and
 * fences its source before enqueueing generation-tagged actions; this class has no dependency on
 * the Relay v1 profile, actor, or codec.
 */
internal class RelayV2ConnectionActor(
    parentScope: CoroutineScope,
    private val transportFactory: RelayV2TransportFactory,
    private val credentialStore: RelayV2CredentialStore,
    private val connectPlanSource: RelayV2ConnectPlanSource,
    private val codec: RelayV2Codec = RelayV2Codec(),
    commandQueryAdmissionComposition: RelayV2OutboxQueryAdmissionComposition? = null,
    optionalCapabilities: Set<String> = emptySet(),
    private val agentExtensionCodec: AgentTranscriptLifecycleV1Codec =
        AgentTranscriptLifecycleV1Codec(),
    private val clock: () -> Long = System::currentTimeMillis,
    private val attemptId: () -> String = { UUID.randomUUID().toString() },
    private val watchdogDelay: suspend (Long) -> Unit = { delay(it) },
    private val recoveryWatchdogDelay: suspend (Long) -> Unit = { delay(it) },
    private val afterRecoveryWatchdogArmed: (RelayV2RecoveryBinding, () -> Unit) -> Unit =
        { _, _ -> },
    private val beforeTransportCommit: suspend () -> Unit = {},
    private val beforeTerminalClaim: () -> Unit = {},
    private val beforeRecoveryTimeoutClaim: () -> Unit = {},
    private val beforeRecoveryFrameDispatch: () -> Unit = {},
    private val betweenTerminalCauseReadAndOwnerRevoke: () -> Unit = {},
    private val afterCallbackAdmission: (RelayV2Transport) -> Unit = {},
    private val afterDisconnectOwnerSeal: () -> Unit = {},
    private val beforeOutboxExecuteReadyRead: () -> Unit = {},
    private val relayWelcomeTimeoutMs: Long = RELAY_WELCOME_TIMEOUT_MS,
    private val hostWelcomeTimeoutMs: Long = HOST_WELCOME_TIMEOUT_MS,
    private val recoveryStepTimeoutMs: Long = RECOVERY_STEP_TIMEOUT_MS,
    normalActionCapacity: Int = DEFAULT_ACTION_CAPACITY,
    reservedActionCapacity: Int = DEFAULT_RESERVED_ACTION_CAPACITY,
    eventCapacity: Int = DEFAULT_EVENT_CAPACITY,
    private val actionByteCapacity: Long = DEFAULT_ACTION_BYTE_CAPACITY,
    private val effectByteCapacity: Long = DEFAULT_EFFECT_BYTE_CAPACITY,
    extensionActionCapacity: Int = MAX_PENDING_AGENT_EXTENSION_REQUESTS,
    extensionEventCapacity: Int = DEFAULT_EXTENSION_EVENT_CAPACITY,
    private val extensionActionByteCapacity: Long = DEFAULT_EXTENSION_ACTION_BYTE_CAPACITY,
    private val extensionEffectByteCapacity: Long = DEFAULT_EXTENSION_EFFECT_BYTE_CAPACITY,
    private val extensionRequestTimeoutMs: Long = EXTENSION_REQUEST_TIMEOUT_MS,
    private val extensionRequestWatchdogDelay: suspend (Long) -> Unit = { delay(it) },
    private val beforeAgentExtensionRequestSend: suspend () -> Unit = {},
    private val afterAgentExtensionRedriveEnqueuedBeforeSwap: () -> Unit = {},
) : RelayProfileDisconnectBarrier,
    RelayV2RepositoryEffectApplyLeasePort,
    RelayV2CurrentRepositoryReadAuthorityPort,
    RelayV2OutboxExactGenerationSendPort,
    AgentTranscriptLifecycleExtensionRequestSender,
    AgentTranscriptLifecycleDurableHandoffPort,
    Closeable {
    private val commandQueryReceiverIdentity = Any()
    private val commandQueryAdmissionReceiver =
        commandQueryAdmissionComposition?.claimActorReceiver(commandQueryReceiverIdentity)
    private val actorDispatcher: ExecutorCoroutineDispatcher = Executors
        .newSingleThreadExecutor { runnable ->
            Thread(runnable, "tw-relay-v2-actor").apply { isDaemon = true }
        }
        .asCoroutineDispatcher()
    private val scope = CoroutineScope(
        parentScope.coroutineContext +
            actorDispatcher +
            SupervisorJob(parentScope.coroutineContext[Job]),
    )
    private val actions = BoundedActionQueue<Action>(
        normalCapacity = normalActionCapacity,
        reservedCapacity = reservedActionCapacity,
    )
    private val effectChannel = Channel<QueuedEffect>(
        eventCapacity.also { require(it > 0) { "eventCapacity must be positive" } },
    )
    private val agentExtensionActions = Channel<SendAgentExtensionRequestAction>(
        extensionActionCapacity.also {
            require(it > 0) { "extensionActionCapacity must be positive" }
        },
    )
    private val agentExtensionEffectChannel = Channel<QueuedEffect>(
        extensionEventCapacity.also {
            require(it > 0) { "extensionEventCapacity must be positive" }
        },
    )
    private val agentExtensionHandoffEffectChannel =
        Channel<QueuedEffect>(MAX_PENDING_AGENT_EXTENSION_REQUESTS)
    private val agentExtensionControlEffectChannel = Channel<QueuedEffect>(1)
    private val resourcesClosed = AtomicBoolean(false)
    private val lastTerminationGeneration = AtomicReference<RelayV2EffectGeneration?>(null)
    private val publishedEffectGeneration = AtomicReference<RelayV2EffectGeneration?>(null)
    private val agentExtensionSendFence = AtomicReference<AgentExtensionSendFence?>(null)
    private val queuedActionBytes = AtomicLong(0)
    private val queuedEffectBytes = AtomicLong(0)
    private val queuedAgentExtensionActionBytes = AtomicLong(0)
    private val queuedAgentExtensionEffectBytes = AtomicLong(0)
    private val effectApplyGate = EffectApplyGate()
    private val callbackAdmissions = CallbackAdmissionGate()
    private val lifecycleLock = Any()
    private var lifecycleState = LifecycleState.OPEN
    private var shutdownDrainCompletion: CompletableDeferred<Unit>? = null
    private val fencedActivationGenerations = linkedMapOf<String, Long>()
    private var nextConnectTokenId = 0L
    private var activeConnectToken: ConnectToken? = null
    private var provisionalCallbackOwner: ProvisionalCallbackOwner? = null
    private var committedCallbackOwner: CommittedCallbackOwner? = null
    /** Guarded by lifecycleLock; this is the sole Execute mutation-readiness fact. */
    private var outboxExecuteReadyCut: OutboxExecuteReadyCut? = null
    private var pendingTerminalIntent: PendingTerminalIntent? = null
    private val pendingBarriers = linkedMapOf<
        CompletableDeferred<RelayProfileDisconnectReceipt>,
        RelayProfileDisconnectReceipt,
        >()
    private val advertisedOptionalCapabilities = optionalCapabilities.toSet()

    private val _state = MutableStateFlow(RelayV2ConnectionState(changedAtMs = clock()))
    val state: StateFlow<RelayV2ConnectionState> = _state.asStateFlow()
    val effects: Flow<RelayV2RuntimeEffect> = multiplexedEffectFlow()

    /**
     * Runs a repository/Room commit while holding the actor-owned generation lease.
     *
     * Pulling an effect from [effects] or observing [state] never authorizes a mutation. The
     * complete transaction that applies a generation-scoped effect must execute inside [block].
     */
    suspend fun <T> withEffectApplyLease(
        effect: RelayV2RuntimeEffect.GenerationScoped,
        block: suspend () -> T,
    ): RelayV2EffectApplyResult<T> = withEffectApplyLease(
        generation = effect.generation,
        repositoryAuthority =
            (effect as? RelayV2RuntimeEffect.RepositoryScoped)?.repositoryAuthority,
        block = block,
    )

    override suspend fun <T> withEffectApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        block: suspend () -> T,
    ): RelayV2EffectApplyResult<T> = withEffectApplyLease(
        generation = authority.generation,
        repositoryAuthority = authority,
        block = block,
    )

    private suspend fun <T> withEffectApplyLease(
        generation: RelayV2EffectGeneration,
        repositoryAuthority: RelayV2RepositoryEffectAuthority?,
        block: suspend () -> T,
    ): RelayV2EffectApplyResult<T> {
        val lease = effectApplyGate.begin(
            generation,
            repositoryAuthority,
        )
            ?: return RelayV2EffectApplyResult.Stale
        return try {
            RelayV2EffectApplyResult.Applied(block())
        } finally {
            lease.close()
        }
    }

    /**
     * Atomically checks the actor-issued ONLINE Execute-ready cut and complete authority, then
     * performs its sole transport attempt under the same lifecycle fence. The caller-owned bytes
     * are bounded and detached before the fence; neither array is retained.
     */
    override fun sendIfCurrent(
        authority: RelayV2RepositoryEffectAuthority,
        canonicalWireBytes: ByteArray,
    ): RelayV2OutboxExactGenerationSendResult {
        if (canonicalWireBytes.isEmpty() ||
            canonicalWireBytes.size > RelayV2Codec.PUBLIC_FRAME_BYTES
        ) {
            return RelayV2OutboxExactGenerationSendResult.Stale
        }
        val detachedWireBytes = canonicalWireBytes.copyOf()
        beforeOutboxExecuteReadyRead()
        return synchronized(lifecycleLock) {
            val ready = outboxExecuteReadyCut
                ?: return@synchronized RelayV2OutboxExactGenerationSendResult.Stale
            val profile = activeProfile
                ?: return@synchronized RelayV2OutboxExactGenerationSendResult.Stale
            val context = onlineContext
                ?: return@synchronized RelayV2OutboxExactGenerationSendResult.Stale
            val source = activeTransport
                ?: return@synchronized RelayV2OutboxExactGenerationSendResult.Stale
            val committed = committedCallbackOwner
                ?: return@synchronized RelayV2OutboxExactGenerationSendResult.Stale
            if (ready.authority != authority ||
                ready.owner != committed.key ||
                ready.source !== source ||
                detachedWireBytes.size.toLong() > context.negotiatedLimits.maxPublicFrameBytes ||
                committed.effectGeneration != authority.generation ||
                publishedEffectGeneration.get() != authority.generation ||
                !isCurrentCallbackLocked(committed.key, source) ||
                profile.identity != context.profile ||
                profile.principalId != context.principalId ||
                profile.clientInstanceId != context.clientInstanceId ||
                profile.hostId != context.hostId ||
                context.repositoryEffectAuthority(authority.generation) != authority
            ) {
                return@synchronized RelayV2OutboxExactGenerationSendResult.Stale
            }
            if (source.send(detachedWireBytes)) {
                RelayV2OutboxExactGenerationSendResult.Sent
            } else {
                RelayV2OutboxExactGenerationSendResult.NotSent
            }
        }
    }

    override fun currentRepositoryReadCut(
        capability: RelayV2RepositoryReadCapability,
    ): RelayV2CurrentRepositoryReadCutResult = synchronized(lifecycleLock) {
        val fence = currentRepositoryReadFenceLocked(capability)
            ?: return@synchronized RelayV2CurrentRepositoryReadCutResult.Unavailable
        RelayV2CurrentRepositoryReadCutResult.Available(
            ActorCurrentRepositoryReadCut(
                originActor = this,
                originFence = fence,
                authority = fence.authority,
                capability = capability,
            ),
        )
    }

    override suspend fun <T> withCurrentRepositoryReadLease(
        cut: RelayV2CurrentRepositoryReadCut,
        block: suspend () -> T,
    ): RelayV2CurrentRepositoryReadLeaseResult<T> {
        val actorCut = cut as? ActorCurrentRepositoryReadCut
            ?: return RelayV2CurrentRepositoryReadLeaseResult.Stale
        val lease = synchronized(lifecycleLock) {
            if (actorCut.originActor !== this) return@synchronized null
            val currentFence = currentRepositoryReadFenceLocked(actorCut.capability)
                ?: return@synchronized null
            if (currentFence !== actorCut.originFence ||
                currentFence.authority != actorCut.authority
            ) {
                return@synchronized null
            }
            effectApplyGate.begin(actorCut.authority.generation, actorCut.authority)
        } ?: return RelayV2CurrentRepositoryReadLeaseResult.Stale

        return try {
            RelayV2CurrentRepositoryReadLeaseResult.Current(block())
        } finally {
            lease.close()
        }
    }

    private fun currentRepositoryReadFenceLocked(
        capability: RelayV2RepositoryReadCapability,
    ): AgentExtensionSendFence? {
        if (lifecycleState != LifecycleState.OPEN ||
            _state.value.phase !in AGENT_EXTENSION_INBOUND_PHASES
        ) {
            return null
        }
        val committed = committedCallbackOwner ?: return null
        if (!isCurrentCallbackLocked(committed.key, committed.source)) return null
        val generation = committed.effectGeneration
        val context = onlineContext ?: return null
        val profile = activeProfile ?: return null
        val fence = agentExtensionSendFence.get() ?: return null
        if (publishedEffectGeneration.get() != generation ||
            generation.connectionGeneration != connectionGeneration ||
            context.profile != profile.identity ||
            context.principalId != profile.principalId ||
            context.clientInstanceId != profile.clientInstanceId ||
            context.hostId != profile.hostId ||
            context.repositoryEffectAuthority(generation) != fence.authority ||
            context.negotiatedCapabilities != fence.negotiatedCapabilities ||
            capability.wireIdentity !in context.negotiatedCapabilities
        ) {
            return null
        }
        return fence
    }

    private val RelayV2RepositoryReadCapability.wireIdentity: String
        get() = when (this) {
            RelayV2RepositoryReadCapability.AGENT_TRANSCRIPT_LIFECYCLE ->
                AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY
        }

    // Actor state is serialized below; callback source binding/fences are guarded by lifecycleLock.
    private var connectionGeneration = 0L
    private var activeTransport: RelayV2Transport? = null
    private val transportFences: MutableSet<RelayV2Transport> =
        Collections.newSetFromMap(IdentityHashMap())
    private val transportRetirements: MutableSet<RelayV2Transport> =
        Collections.newSetFromMap(IdentityHashMap())
    private val transportCancellations: MutableSet<RelayV2Transport> =
        Collections.newSetFromMap(IdentityHashMap())
    private val transportClaimedCloseCodes = IdentityHashMap<RelayV2Transport, Int>()
    private val completedTransportRetirements: MutableSet<RelayV2Transport> =
        Collections.newSetFromMap(IdentityHashMap())
    private val queuedTransportCallbacks = IdentityHashMap<RelayV2Transport, Int>()
    private val terminalCallbackLeases = linkedMapOf<
        CallbackOwnerKey,
        MutableSet<RelayV2Transport>,
        >()
    private var activeProfile: RelayV2Profile? = null
    private var requestedResume: RelayV2ResumeCursor? = null
    private var activeConnectPlan: RelayV2ConnectPlan? = null
    private var pendingHelloRequestId: String? = null
    private var brokerEpoch: String? = null
    private var brokerCapabilities: Set<String> = emptySet()
    private var brokerLimits: Map<String, Long>? = null
    private var relayWelcomeWatchdog: Job? = null
    private var hostWelcomeWatchdog: Job? = null
    private var recoveryStepWatchdog: Job? = null
    private var recoveryAttempt: RecoveryAttempt? = null
    private var onlineQueryWindow: OnlineQueryWindow? = null
    @Volatile
    private var onlineContext: RelayV2HandshakeContext? = null
    private val recentIssuedIds = LinkedHashSet<String>()
    private val completedRecoveryResponses = LinkedHashSet<CompletedRecoveryResponse>()
    private val pendingAgentExtensionRequests =
        linkedMapOf<String, PendingAgentExtensionRequest>()
    private val retiredAgentExtensionRequests =
        linkedMapOf<String, RetiredAgentExtensionRequestIdentity>()
    private var nextAgentExtensionAdmissionSequence = 0L

    init {
        require(relayWelcomeTimeoutMs > 0) { "relayWelcomeTimeoutMs must be positive" }
        require(hostWelcomeTimeoutMs > 0) { "hostWelcomeTimeoutMs must be positive" }
        require(recoveryStepTimeoutMs > 0) { "recoveryStepTimeoutMs must be positive" }
        require(actionByteCapacity > 0) { "actionByteCapacity must be positive" }
        require(effectByteCapacity > 0) { "effectByteCapacity must be positive" }
        require(extensionActionByteCapacity > 0) {
            "extensionActionByteCapacity must be positive"
        }
        require(extensionEffectByteCapacity > 0) {
            "extensionEffectByteCapacity must be positive"
        }
        require(extensionRequestTimeoutMs > 0) {
            "extensionRequestTimeoutMs must be positive"
        }
        require(advertisedOptionalCapabilities.all { it in SUPPORTED_OPTIONAL_CAPABILITIES }) {
            "Unsupported Relay v2 optional capability"
        }
        require(advertisedOptionalCapabilities.none { it in REQUIRED_CAPABILITIES }) {
            "Relay v2 optional capabilities must remain separate from required capabilities"
        }
        scope.launch {
            try {
                while (true) {
                    val action = actions.receive() ?: break
                    try {
                        handle(action)
                    } finally {
                        releaseQueuedTransportCallback(action)
                        releaseBytes(queuedActionBytes, action.rawBytes)
                    }
                }
            } finally {
                cancelHandshakeWatchdogs()
                clearRecoveryAttempt()
                clearPendingAgentExtensionRequests()
                invalidateConnectionOwnershipAndDrain()
                val source = activeTransport
                activeTransport = null
                connectionGeneration += 1
                source?.let {
                    beginRetirement(listOf(it), closeCode = null, forceCancel = true)
                }
                finishResources()
            }
        }
        scope.launch {
            for (action in agentExtensionActions) {
                try {
                    beforeAgentExtensionRequestSend()
                    sendAgentExtensionRequest(action)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Throwable) {
                    requestAgentExtensionRetry(
                        action.admission,
                        RelayV2AgentExtensionUnavailableReason.REQUEST_SEND_FAILED,
                    )
                } finally {
                    releaseBytes(queuedAgentExtensionActionBytes, action.rawBytes)
                }
            }
        }
        scope.coroutineContext[Job]?.invokeOnCompletion {
            finishResources()
        }
    }

    fun connect(profile: RelayV2Profile): Boolean {
        val overloadOwner = synchronized(lifecycleLock) {
            if (lifecycleState != LifecycleState.OPEN || isActivationFencedLocked(profile.identity)) {
                return false
            }
            if (actions.trySendNormal(Action.Connect(profile))) return true
            currentCallbackOwnerKeyLocked()
        }
        signalQueueSaturation(overloadOwner, source = null)
        return false
    }

    /**
     * Returns a durable repository receipt to the serialized recovery owner. A true return only
     * means the receipt entered the actor queue; exact generation/step/request/epoch validation is
     * deliberately performed by the actor before any phase transition or network send.
     */
    fun submitRecoveryReceipt(receipt: RelayV2RecoveryReceipt): Boolean {
        return enqueueRecoveryReceipt(receipt, completion = null)
    }

    /**
     * Returns only after this actor has serially validated and consumed the exact receipt. The
     * result is the sole recovery-to-ready handoff; queue admission and observed state are not
     * dispatch authority.
     */
    suspend fun processRecoveryReceipt(
        receipt: RelayV2RecoveryReceipt,
    ): RelayV2RecoveryReceiptProcessingResult {
        val completion = CompletableDeferred<RelayV2RecoveryReceiptProcessingResult>()
        if (!enqueueRecoveryReceipt(receipt, completion)) {
            return RelayV2RecoveryReceiptProcessingResult.StaleOrTerminal
        }
        return completion.await()
    }

    private fun enqueueRecoveryReceipt(
        receipt: RelayV2RecoveryReceipt,
        completion: CompletableDeferred<RelayV2RecoveryReceiptProcessingResult>?,
    ): Boolean {
        val action = Action.RecoveryReceipt(receipt, completion)
        val overload = synchronized(lifecycleLock) {
            if (lifecycleState != LifecycleState.OPEN ||
                publishedEffectGeneration.get() != receipt.binding.generation
            ) {
                return false
            }
            if (!reserveBytes(queuedActionBytes, action.rawBytes, actionByteCapacity)) {
                return@synchronized currentCallbackOwnerKeyLocked() to activeTransport
            }
            if (actions.trySendNormal(action)) return true
            releaseBytes(queuedActionBytes, action.rawBytes)
            currentCallbackOwnerKeyLocked() to activeTransport
        }
        signalQueueSaturation(overload.first, source = overload.second)
        return false
    }

    fun submitOnlineResyncRequired(receipt: RelayV2OnlineResyncRequired): Boolean {
        val action = Action.OnlineResyncRequired(receipt)
        val overload = synchronized(lifecycleLock) {
            if (lifecycleState != LifecycleState.OPEN ||
                publishedEffectGeneration.get() != receipt.generation
            ) {
                return false
            }
            if (!reserveBytes(queuedActionBytes, action.rawBytes, actionByteCapacity)) {
                return@synchronized currentCallbackOwnerKeyLocked() to activeTransport
            }
            if (actions.trySendNormal(action)) return true
            releaseBytes(queuedActionBytes, action.rawBytes)
            currentCallbackOwnerKeyLocked() to activeTransport
        }
        signalQueueSaturation(overload.first, overload.second)
        return false
    }

    override fun send(
        request: AgentTranscriptLifecycleActorRequest,
    ): AgentTranscriptLifecycleRequestAdmission? {
        val encoded = try {
            agentExtensionCodec.encodePublicFrame(request.frame)
        } catch (_: AgentTranscriptLifecycleV1CodecException) {
            return null
        }
        return synchronized(lifecycleLock) {
            val fence = agentExtensionSendFence.get()
            if (lifecycleState != LifecycleState.OPEN ||
                fence == null ||
                fence.authority != request.authority ||
                AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY !in fence.negotiatedCapabilities ||
                _state.value.phase !in AGENT_EXTENSION_INBOUND_PHASES ||
                pendingAgentExtensionRequests.size >= MAX_PENDING_AGENT_EXTENSION_REQUESTS ||
                pendingAgentExtensionRequests.size + retiredAgentExtensionRequests.size >=
                    MAX_TRACKED_AGENT_EXTENSION_REQUESTS ||
                request.requestId in pendingAgentExtensionRequests ||
                request.requestId in retiredAgentExtensionRequests
            ) {
                return@synchronized null
            }
            val sequence = try {
                Math.addExact(nextAgentExtensionAdmissionSequence, 1L)
            } catch (_: ArithmeticException) {
                return@synchronized null
            }
            val admission = AgentTranscriptLifecycleRequestAdmission(
                authority = request.authority,
                requestKind = request.kind,
                requestId = request.requestId,
                admissionSequence = sequence,
            )
            val action = SendAgentExtensionRequestAction(request, admission, encoded)
            if (!reserveBytes(
                    queuedAgentExtensionActionBytes,
                    action.rawBytes,
                    extensionActionByteCapacity,
                )
            ) return@synchronized null
            pendingAgentExtensionRequests[request.requestId] = PendingAgentExtensionRequest(
                request = request,
                admission = admission,
            )
            if (agentExtensionActions.trySend(action).isFailure) {
                pendingAgentExtensionRequests.remove(request.requestId)
                releaseBytes(queuedAgentExtensionActionBytes, action.rawBytes)
                return@synchronized null
            }
            nextAgentExtensionAdmissionSequence = sequence
            admission
        }
    }

    override fun acceptDurableHandoff(
        receipt: AgentTranscriptLifecycleCompletedHandoffReceipt,
    ): Boolean = synchronized(lifecycleLock) {
        val admission = receipt.admission
        val pending = pendingAgentExtensionRequests[admission.requestId]
            ?: return@synchronized false
        if (pending.admission != admission ||
            pending.state != AgentExtensionPendingState.HANDOFF_QUEUED ||
            pending.delivery == null
        ) return@synchronized false
        pending.watchdog?.cancel()
        removeQueuedAgentExtensionDeliveriesLocked(setOf(admission))
        retireAgentExtensionRequestLocked(pending)
        pendingAgentExtensionRequests.remove(admission.requestId)
        releasePendingAgentExtensionDeliveryBytesLocked(pending)
        true
    }

    override fun replaceForExactRedrive(
        replacement: AgentTranscriptLifecycleExactRedriveReplacement,
    ): AgentTranscriptLifecycleRequestAdmission? {
        val request = replacement.exactRequest
        val encoded = try {
            agentExtensionCodec.encodePublicFrame(request.frame)
        } catch (_: AgentTranscriptLifecycleV1CodecException) {
            return null
        }
        return synchronized(lifecycleLock) {
            val oldAdmission = replacement.oldAdmission
            val oldPending = pendingAgentExtensionRequests[oldAdmission.requestId]
                ?: return@synchronized null
            val fence = agentExtensionSendFence.get()
            if (oldPending.admission != oldAdmission ||
                oldPending.request != request ||
                oldPending.state != AgentExtensionPendingState.HANDOFF_QUEUED ||
                oldPending.delivery == null ||
                lifecycleState != LifecycleState.OPEN ||
                fence == null ||
                fence.authority != request.authority ||
                AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY !in fence.negotiatedCapabilities ||
                _state.value.phase !in AGENT_EXTENSION_INBOUND_PHASES ||
                request.requestId in retiredAgentExtensionRequests
            ) return@synchronized null

            val sequence = try {
                Math.addExact(nextAgentExtensionAdmissionSequence, 1L)
            } catch (_: ArithmeticException) {
                return@synchronized null
            }
            val admission = AgentTranscriptLifecycleRequestAdmission(
                authority = request.authority,
                requestKind = request.kind,
                requestId = request.requestId,
                admissionSequence = sequence,
            )
            val action = SendAgentExtensionRequestAction(request, admission, encoded)
            if (!reserveBytes(
                    queuedAgentExtensionActionBytes,
                    action.rawBytes,
                    extensionActionByteCapacity,
                )
            ) return@synchronized null
            if (agentExtensionActions.trySend(action).isFailure) {
                releaseBytes(queuedAgentExtensionActionBytes, action.rawBytes)
                return@synchronized null
            }

            afterAgentExtensionRedriveEnqueuedBeforeSwap()
            oldPending.watchdog?.cancel()
            removeQueuedAgentExtensionDeliveriesLocked(setOf(oldAdmission))
            pendingAgentExtensionRequests.remove(oldAdmission.requestId)
            releasePendingAgentExtensionDeliveryBytesLocked(oldPending)
            pendingAgentExtensionRequests[request.requestId] = PendingAgentExtensionRequest(
                request = request,
                admission = admission,
            )
            nextAgentExtensionAdmissionSequence = sequence
            admission
        }
    }

    override fun acceptDurableHandoff(
        receipt: AgentTranscriptLifecycleCompletedBatchHandoffReceipt,
    ): Boolean = synchronized(lifecycleLock) {
        val triggering = receipt.triggeringAdmission
        val triggeringPending = pendingAgentExtensionRequests[triggering.requestId]
            ?: return@synchronized false
        if (!triggeringPending.matchesRetirementReceipt(receipt) ||
            triggeringPending.admission != triggering ||
            triggeringPending.state != AgentExtensionPendingState.HANDOFF_QUEUED ||
            triggeringPending.delivery == null
        ) return@synchronized false

        val retired = receipt.retiredRequests.map { identity ->
            val pending = pendingAgentExtensionRequests[identity.requestNetworkToken]
                ?: return@map null
            if (pending.request.kind != identity.requestKind ||
                !pending.matchesRetirementReceipt(receipt)
            ) return@synchronized false
            pending
        }.filterNotNull()

        removeQueuedAgentExtensionDeliveriesLocked(retired.map { it.admission }.toSet())
        retired.forEach { pending ->
            pending.watchdog?.cancel()
            retireAgentExtensionRequestLocked(pending)
            pendingAgentExtensionRequests.remove(pending.admission.requestId)
            releasePendingAgentExtensionDeliveryBytesLocked(pending)
        }
        true
    }

    private fun PendingAgentExtensionRequest.matchesRetirementReceipt(
        receipt: AgentTranscriptLifecycleCompletedBatchHandoffReceipt,
    ): Boolean = request.authority == receipt.authority &&
        request.scopeId == receipt.scopeId &&
        request.sessionId == receipt.sessionId

    private fun retireAgentExtensionRequestLocked(pending: PendingAgentExtensionRequest) {
        val identity = pending.request.retiredIdentity()
        val existing = retiredAgentExtensionRequests.putIfAbsent(identity.requestId, identity)
        check(existing == null || existing == identity) {
            "Relay v2 extension request retirement identity conflict"
        }
        check(retiredAgentExtensionRequests.size <= MAX_TRACKED_AGENT_EXTENSION_REQUESTS) {
            "Relay v2 extension request retirement capacity invariant violated"
        }
    }

    override suspend fun disconnectAndDrain(
        profile: RelayActiveProfileIdentity,
        barrierId: String,
    ): RelayProfileDisconnectReceipt {
        require(profile.dialect == RelayProfileDialect.V2) {
            "Relay v2 actor cannot drain another profile dialect"
        }
        require(barrierId.isNotBlank()) { "Barrier ID is required" }
        val receipt = RelayProfileDisconnectReceipt(profile, barrierId)
        val completion = CompletableDeferred<RelayProfileDisconnectReceipt>()
        val shutdownDrain = synchronized(lifecycleLock) {
            fenceActivationLocked(profile)
            when (lifecycleState) {
                LifecycleState.OPEN -> {
                    pendingBarriers[completion] = receipt
                    null
                }
                LifecycleState.SHUTTING_DOWN,
                LifecycleState.CLOSED,
                -> shutdownDrainCompletion
                    ?: throw CancellationException("Relay v2 actor stopped without a clean drain")
            }
        }
        if (shutdownDrain != null) {
            shutdownDrain.await()
            return receipt
        }
        completion.invokeOnCompletion {
            synchronized(lifecycleLock) { pendingBarriers.remove(completion) }
        }
        val action = Action.Disconnect(profile, barrierId, completion)
        try {
            while (true) {
                val enqueue = synchronized(lifecycleLock) {
                    when {
                        lifecycleState != LifecycleState.OPEN || resourcesClosed.get() ->
                            BarrierEnqueue.STOPPED
                        actions.trySendReserved(action) -> BarrierEnqueue.ENQUEUED
                        else -> BarrierEnqueue.RETRY
                    }
                }
                when (enqueue) {
                    BarrierEnqueue.ENQUEUED,
                    BarrierEnqueue.STOPPED,
                    -> break
                    BarrierEnqueue.RETRY -> delay(CONTROL_ENQUEUE_RETRY_MS)
                }
            }
            return completion.await()
        } catch (cancelled: CancellationException) {
            synchronized(lifecycleLock) {
                pendingBarriers.remove(completion)
                completion.cancel(cancelled)
            }
            throw cancelled
        }
    }

    /**
     * Starts the single idempotent shutdown drain. Callers needing a profile-clear barrier use
     * [disconnectAndDrain], which observes this same completion once shutdown has started.
     */
    override fun close() {
        val shutdownQueued = synchronized(lifecycleLock) {
            if (lifecycleState != LifecycleState.OPEN) {
                return
            } else {
                activeConnectToken = null
                revokeCallbackOwnersLocked()
                lifecycleState = LifecycleState.SHUTTING_DOWN
                check(shutdownDrainCompletion == null) { "Relay v2 shutdown drain already exists" }
                shutdownDrainCompletion = CompletableDeferred()
                withdrawPublishedRepositoryAuthorityAndDrainLocked()
                actions.trySendReserved(Action.Shutdown)
            }
        }
        if (!shutdownQueued) {
            scope.launch { enqueueShutdownWhenControlLaneDrains() }
        }
    }

    private suspend fun enqueueShutdownWhenControlLaneDrains() {
        while (!resourcesClosed.get()) {
            val result = synchronized(lifecycleLock) {
                when {
                    lifecycleState != LifecycleState.SHUTTING_DOWN -> ShutdownEnqueue.STOPPED
                    actions.trySendReserved(Action.Shutdown) -> ShutdownEnqueue.ENQUEUED
                    else -> ShutdownEnqueue.RETRY
                }
            }
            when (result) {
                ShutdownEnqueue.ENQUEUED,
                ShutdownEnqueue.STOPPED,
                -> return
                ShutdownEnqueue.RETRY -> delay(CONTROL_ENQUEUE_RETRY_MS)
            }
        }
    }

    private suspend fun handle(action: Action) {
        when (action) {
            is Action.Connect -> connectNow(action.profile)
            is Action.Disconnect -> disconnectNow(action)
            is Action.TransportOpened -> transportOpened(action)
            is Action.TransportFrame -> transportFrame(action)
            is Action.TransportFrameTooLarge -> if (isCurrentCallback(action.owner, action.source)) {
                failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", retryable = false, 4400)
            }
            is Action.TransportSourceMismatch -> processTerminal(action.owner, action.source)
            is Action.TerminateConnection -> processTerminal(action.owner, action.source)
            is Action.HandshakeTimedOut -> processTerminal(action.owner, action.source)
            is Action.QueueSaturated -> processTerminal(action.owner, action.source)
            is Action.RecoveryReceipt -> try {
                val result = handleRecoveryReceipt(action.receipt)
                action.completion?.complete(result)
            } catch (failure: Throwable) {
                action.completion?.completeExceptionally(failure)
                throw failure
            }
            is Action.OnlineResyncRequired -> handleOnlineResyncRequired(action.receipt)
            is Action.RecoveryStepTimedOut -> handleRecoveryTimeout(action)
            Action.Shutdown -> shutdownNow()
        }
    }

    private suspend fun connectNow(profile: RelayV2Profile) {
        val token = claimConnectToken(profile) ?: run {
            if (isLifecycleOpen()) {
                emitEffect(
                    RelayV2RuntimeEffect.ConnectRejected(
                        requestedProfile = profile.identity,
                        failure = RelayV2ConnectionFailure(
                            RelayV2FailureKind.CONFIGURATION,
                            "PROFILE_GENERATION_FENCED",
                            retryable = false,
                        ),
                    ),
                )
            }
            return
        }
        val current = activeProfile
        if (current != null && !current.hasSameRuntimeBinding(profile)) {
            releaseConnectToken(token)
            emitEffect(
                RelayV2RuntimeEffect.ConnectRejected(
                    requestedProfile = profile.identity,
                    failure = RelayV2ConnectionFailure(
                        RelayV2FailureKind.CONFIGURATION,
                        "BUSY",
                        retryable = false,
                    ),
                ),
            )
            return
        }

        var credential: RelayV2CredentialBlob? = null
        var uncommittedTransport: RelayV2Transport? = null
        var provisionalOwner: ProvisionalCallbackOwner? = null
        var transportCommitted = false
        try {
            credential = runCatching { credentialStore.read(profile.credentialReference) }
                .getOrNull()
            val credentialFailure = validateCredential(profile, credential)
            if (credentialFailure != null) {
                failConnectAttempt(token, profile, credentialFailure, closeCode = 4401)
                return
            }

            val preparation = synchronized(lifecycleLock) {
                if (!isConnectTokenCurrentLocked(token)) return@synchronized null
                val applyDrain = withdrawPublishedRepositoryAuthorityAndDrainLocked()
                revokeCallbackOwnersLocked()
                val previous = activeTransport
                activeTransport = null
                connectionGeneration += 1
                lastTerminationGeneration.set(null)
                pendingTerminalIntent = null
                clearRecoveryAttempt()
                clearPendingAgentExtensionRequests()
                recentIssuedIds.clear()
                completedRecoveryResponses.clear()
                onlineQueryWindow = null
                ConnectPreparation(
                    previousTransport = previous,
                    connectionGeneration = connectionGeneration,
                    applyDrain = applyDrain,
                )
            } ?: return
            cancelHandshakeWatchdogs()
            preparation.previousTransport?.let { previous ->
                beginRetirement(listOf(previous), reason = "v2 reconnect")
            }
            val transportTerminated = awaitTransportFences()
            preparation.applyDrain.await()
            if (!isConnectTokenCurrent(token)) return
            if (!transportTerminated) {
                failConnectAttempt(
                    token,
                    profile,
                    RelayV2ConnectionFailure(
                        RelayV2FailureKind.TRANSPORT,
                        "TRANSPORT_TERMINATION_TIMEOUT",
                        retryable = false,
                    ),
                    closeCode = null,
                )
                return
            }

            // The plan read is intentionally after the old generation apply-lease drain. It is
            // the only resume/recovery fact frozen into this connection attempt.
            val connectPlan = runCatching {
                connectPlanSource.load(profile).also { it.requireMatches(profile) }
            }.getOrElse {
                failConnectAttempt(
                    token,
                    profile,
                    RelayV2ConnectionFailure(
                        RelayV2FailureKind.CONFIGURATION,
                        "DURABLE_CONNECT_PLAN_INVALID",
                        retryable = false,
                    ),
                    closeCode = null,
                )
                return
            }
            val resume = connectPlan.requestedResume

            val effectGeneration = RelayV2EffectGeneration(
                profileId = profile.profileId,
                profileGeneration = profile.activationGeneration,
                connectionGeneration = preparation.connectionGeneration,
            )
            val owner = synchronized(lifecycleLock) {
                if (!isConnectTokenCurrentLocked(token)) return@synchronized null
                ProvisionalCallbackOwner(
                    connectToken = token,
                    effectGeneration = effectGeneration,
                    phase = CallbackOwnerPhase.OPENING,
                ).also { provisionalCallbackOwner = it }
            } ?: return
            provisionalOwner = owner
            val listener = listenerFor(owner)
            val request = runCatching {
                RelayV2TransportOpenRequest(
                    relayUrl = profile.relayUrl,
                    offeredSubprotocols = listOf(profile.offeredSubprotocol),
                    accessToken = requireNotNull(credential).accessToken!!,
                )
            }.getOrElse {
                failConnectAttempt(
                    token,
                    profile,
                    RelayV2ConnectionFailure(
                        RelayV2FailureKind.SECURITY,
                        "AUTH_INVALID",
                        retryable = false,
                    ),
                    closeCode = null,
                )
                return
            }
            val opened = runCatching { transportFactory.open(request, listener) }
                .getOrElse {
                    synchronized(lifecycleLock) { owner.factorySourceResolved = true }
                    val sourceMismatch = synchronized(lifecycleLock) { owner.sourceMismatch }
                    failConnectAttempt(
                        token,
                        profile,
                        if (sourceMismatch) {
                            sourceMismatchFailure()
                        } else {
                            RelayV2ConnectionFailure(
                                RelayV2FailureKind.TRANSPORT,
                                "HOST_OFFLINE",
                                retryable = true,
                            )
                        },
                        closeCode = null,
                    )
                    return
                }
            uncommittedTransport = opened
            when (bindFactorySource(owner, opened)) {
                FactorySourceBinding.MATCHED -> Unit
                FactorySourceBinding.STALE -> return
                FactorySourceBinding.MISMATCH -> {
                    failConnectAttempt(
                        token,
                        profile,
                        sourceMismatchFailure(),
                        closeCode = null,
                    )
                    return
                }
            }
            beforeTransportCommit()
            val commitResult = synchronized(lifecycleLock) {
                when {
                    owner.sourceMismatch -> TransportCommitResult.SOURCE_MISMATCH
                    !isConnectTokenCurrentLocked(token) ||
                        provisionalCallbackOwner !== owner ||
                        owner.factorySource !== opened -> TransportCommitResult.STALE
                    else -> {
                        activeProfile = profile
                        requestedResume = resume
                        activeConnectPlan = connectPlan
                        pendingHelloRequestId = null
                        brokerEpoch = null
                        brokerCapabilities = emptySet()
                        brokerLimits = null
                        activeTransport = opened
                        publishedEffectGeneration.set(effectGeneration)
                        committedCallbackOwner = CommittedCallbackOwner(
                            connectTokenId = token.id,
                            effectGeneration = effectGeneration,
                            source = opened,
                        )
                        provisionalCallbackOwner = null
                        activeConnectToken = null
                        updateState(RelayV2ConnectionPhase.CONNECTING, profile)
                        TransportCommitResult.COMMITTED
                    }
                }
            }
            when (commitResult) {
                TransportCommitResult.COMMITTED -> Unit
                TransportCommitResult.STALE -> return
                TransportCommitResult.SOURCE_MISMATCH -> {
                    failConnectAttempt(token, profile, sourceMismatchFailure(), closeCode = null)
                    return
                }
            }
            transportCommitted = true
            uncommittedTransport = null
        } finally {
            credential = null
            if (!transportCommitted) {
                val cancelOnly = synchronized(lifecycleLock) {
                    provisionalOwner?.postSealCallbackSeen == true
                }
                releaseConnectToken(token)
                val staleSources = identitySetOf<RelayV2Transport>().apply {
                    uncommittedTransport?.let(::add)
                    provisionalOwner?.callbackSource?.let(::add)
                    provisionalOwner?.factorySource?.let(::add)
                }
                if (cancelOnly) {
                    beginRetirement(
                        staleSources,
                        closeCode = null,
                        forceCancel = true,
                    )
                } else {
                    beginRetirement(staleSources, reason = "stale v2 connect attempt")
                }
                awaitTransportFences(staleSources)
            }
            releaseConnectToken(token)
        }
    }

    private fun validateCredential(
        profile: RelayV2Profile,
        credential: RelayV2CredentialBlob?,
    ): RelayV2ConnectionFailure? {
        if (profile.offeredSubprotocol != RelayV2Profile.RELAY_V2_SUBPROTOCOL) {
            return RelayV2ConnectionFailure(
                RelayV2FailureKind.DIALECT,
                "PROTOCOL_UNSUPPORTED",
                retryable = false,
            )
        }
        if (credential == null ||
            !profile.matchesCredentialBinding(credential) ||
            credential.pendingAttempt != null ||
            credential.credentialVersion != profile.credentialVersion ||
            !RelayV2CredentialSecretValidator.isAccessToken(credential.accessToken!!)
        ) {
            return RelayV2ConnectionFailure(
                RelayV2FailureKind.AUTH,
                "AUTH_INVALID",
                retryable = false,
            )
        }
        if (credential.accessExpiresAtMs!! <= clock()) {
            return RelayV2ConnectionFailure(
                RelayV2FailureKind.AUTH,
                "AUTH_REQUIRED",
                retryable = false,
            )
        }
        return null
    }

    private fun claimConnectToken(profile: RelayV2Profile): ConnectToken? =
        synchronized(lifecycleLock) {
            if (lifecycleState != LifecycleState.OPEN ||
                isActivationFencedLocked(profile.identity)
            ) {
                return@synchronized null
            }
            check(activeConnectToken == null) { "Relay v2 connect token was not released" }
            ConnectToken(
                id = ++nextConnectTokenId,
                profileId = profile.profileId,
                activationGeneration = profile.activationGeneration,
            ).also { activeConnectToken = it }
        }

    private fun isConnectTokenCurrent(token: ConnectToken): Boolean = synchronized(lifecycleLock) {
        isConnectTokenCurrentLocked(token)
    }

    private fun isConnectTokenCurrentLocked(token: ConnectToken): Boolean =
        lifecycleState == LifecycleState.OPEN &&
            activeConnectToken == token &&
            !isActivationFencedLocked(
                RelayActiveProfileIdentity(
                    profileId = token.profileId,
                    dialect = RelayProfileDialect.V2,
                    activationGeneration = token.activationGeneration,
                ),
            )

    private fun releaseConnectToken(token: ConnectToken) {
        synchronized(lifecycleLock) {
            if (activeConnectToken == token) activeConnectToken = null
            val provisional = provisionalCallbackOwner
            if (provisional?.connectToken == token) {
                callbackAdmissions.sealThrough(provisional.key)
                provisionalCallbackOwner = null
            }
        }
    }

    private fun bindFactorySource(
        owner: ProvisionalCallbackOwner,
        source: RelayV2Transport,
    ): FactorySourceBinding = synchronized(lifecycleLock) {
        owner.factorySource = source
        owner.factorySourceResolved = true
        addTransportFenceLocked(source)
        if (provisionalCallbackOwner !== owner || !isConnectTokenCurrentLocked(owner.connectToken)) {
            return@synchronized FactorySourceBinding.STALE
        }
        val callbackSource = owner.callbackSource
        if (owner.sourceMismatch || (callbackSource != null && callbackSource !== source)) {
            owner.sourceMismatch = true
            addTransportFenceLocked(source)
            callbackSource?.let(::addTransportFenceLocked)
            FactorySourceBinding.MISMATCH
        } else {
            FactorySourceBinding.MATCHED
        }
    }

    private fun registerCallbackSource(
        owner: ProvisionalCallbackOwner,
        source: RelayV2Transport,
    ): CallbackSourceRegistration = synchronized(lifecycleLock) {
        addTransportFenceLocked(source)
        val callbackSource = owner.callbackSource
        val factorySource = owner.factorySource
        val mismatch = owner.sourceMismatch ||
            (callbackSource != null && callbackSource !== source) ||
            (factorySource != null && factorySource !== source)
        if (mismatch) {
            owner.sourceMismatch = true
            val expected = committedCallbackOwner
                ?.takeIf { it.key == owner.key }
                ?.source
                ?: callbackSource
                ?: factorySource
            val sources = identitySetOf<RelayV2Transport>().apply {
                add(source)
                callbackSource?.let(::add)
                factorySource?.let(::add)
            }
            sources.forEach(::addTransportFenceLocked)
            CallbackSourceRegistration.Mismatch(expected, sources)
        } else {
            if (callbackSource == null) owner.callbackSource = source
            val accepted = lifecycleState == LifecycleState.OPEN &&
                ((provisionalCallbackOwner === owner &&
                    isConnectTokenCurrentLocked(owner.connectToken)) ||
                    (committedCallbackOwner?.key == owner.key &&
                        committedCallbackOwner?.source === source))
            if (accepted) {
                CallbackSourceRegistration.Accepted
            } else {
                CallbackSourceRegistration.Stale
            }
        }
    }

    private fun acceptCallbackSource(
        owner: ProvisionalCallbackOwner,
        source: RelayV2Transport,
    ): Boolean = when (val registration = registerCallbackSource(owner, source)) {
        CallbackSourceRegistration.Accepted -> true
        CallbackSourceRegistration.Stale -> {
            beginRetirement(listOf(source), reason = "stale v2 transport callback")
            false
        }
        is CallbackSourceRegistration.Mismatch -> {
            registration.expectedSource?.let { expected ->
                enqueueSourceMismatch(
                    owner.key,
                    expected,
                    registration.sources,
                )
            }
            beginRetirement(
                registration.sources,
                reason = "relay v2 transport source mismatch",
            )
            false
        }
    }

    private fun fenceActivationLocked(profile: RelayActiveProfileIdentity) {
        val fenced = maxOf(
            fencedActivationGenerations[profile.profileId] ?: Long.MIN_VALUE,
            profile.activationGeneration,
        )
        fencedActivationGenerations[profile.profileId] = fenced
        val token = activeConnectToken
        if (token?.profileId == profile.profileId && token.activationGeneration <= fenced) {
            activeConnectToken = null
        }
        val provisional = provisionalCallbackOwner
        if (provisional?.connectToken?.profileId == profile.profileId &&
            provisional.connectToken.activationGeneration <= fenced
        ) {
            callbackAdmissions.sealThrough(provisional.key)
            provisionalCallbackOwner = null
        }
        val committed = committedCallbackOwner
        if (committed?.effectGeneration?.profileId == profile.profileId &&
            committed.effectGeneration.profileGeneration <= fenced
        ) {
            callbackAdmissions.sealThrough(committed.key)
            committedCallbackOwner = null
            clearPublishedEffectAuthorityLocked()
        }
        effectApplyGate.invalidateThrough(profile.profileId, fenced)
    }

    private fun isActivationFencedLocked(profile: RelayActiveProfileIdentity): Boolean =
        profile.activationGeneration <=
            (fencedActivationGenerations[profile.profileId] ?: Long.MIN_VALUE)

    private fun failConnectAttempt(
        token: ConnectToken,
        profile: RelayV2Profile,
        failure: RelayV2ConnectionFailure,
        closeCode: Int?,
    ) {
        val failed = synchronized(lifecycleLock) {
            if (!isConnectTokenCurrentLocked(token)) return
            activeConnectToken = null
            val provisional = provisionalCallbackOwner
            if (provisional?.connectToken == token) {
                callbackAdmissions.sealThrough(provisional.key)
                provisionalCallbackOwner = null
            }
            committedCallbackOwner?.let { callbackAdmissions.sealThrough(it.key) }
            committedCallbackOwner = null
            withdrawPublishedRepositoryAuthorityAndDrainLocked()
            val source = activeTransport
            activeTransport = null
            activeProfile = profile
            pendingHelloRequestId = null
            clearRecoveryAttempt()
            clearPendingAgentExtensionRequests()
            updateState(RelayV2ConnectionPhase.FAILED, profile, failure)
            source
        }
        cancelHandshakeWatchdogs()
        failed?.let { source ->
            beginRetirement(
                listOf(source),
                closeCode = closeCode,
                reason = "relay v2 ${failure.code}",
            )
        }
        emitEffect(
            RelayV2RuntimeEffect.ConnectionFailed(
                profile.identity,
                currentEffectGeneration(profile),
                failure,
            ),
        )
    }

    private fun RelayV2Profile.hasSameRuntimeBinding(other: RelayV2Profile): Boolean =
        identity == other.identity &&
            issuerUrl == other.issuerUrl &&
            relayUrl == other.relayUrl &&
            hostId == other.hostId &&
            principalId == other.principalId &&
            grantId == other.grantId &&
            clientInstanceId == other.clientInstanceId &&
            credentialReference == other.credentialReference

    private fun sourceMismatchFailure(): RelayV2ConnectionFailure =
        RelayV2ConnectionFailure(
            RelayV2FailureKind.SECURITY,
            "TRANSPORT_SOURCE_MISMATCH",
            retryable = false,
        )

    private fun listenerFor(owner: ProvisionalCallbackOwner): RelayV2TransportListener =
        object : RelayV2TransportListener {
            override fun onOpen(source: RelayV2Transport, selectedSubprotocol: String?) {
                withCallbackAdmission(owner, source) {
                    if (!acceptCallbackSource(owner, source)) return@withCallbackAdmission
                    enqueueCallback(
                        Action.TransportOpened(
                            owner.connectToken.id,
                            owner.effectGeneration,
                            source,
                            selectedSubprotocol,
                        ),
                        source,
                        owner.key,
                    )
                }
            }

            override fun onFrame(
                source: RelayV2Transport,
                bytes: ByteArray,
                metadata: RelayV2FrameMetadata,
            ) {
                withCallbackAdmission(owner, source) {
                    if (!acceptCallbackSource(owner, source)) return@withCallbackAdmission
                    val action = if (bytes.size > RelayV2Codec.PUBLIC_FRAME_BYTES) {
                        Action.TransportFrameTooLarge(
                            owner.connectToken.id,
                            owner.effectGeneration,
                            source,
                        )
                    } else {
                        Action.TransportFrame(
                            owner.connectToken.id,
                            owner.effectGeneration,
                            source,
                            bytes.copyOf(),
                            metadata,
                        )
                    }
                    enqueueCallback(action, source, owner.key)
                }
            }

            override fun onClosed(source: RelayV2Transport, code: Int) {
                withCallbackAdmission(owner, source) {
                    if (!acceptCallbackSource(owner, source)) return@withCallbackAdmission
                    if (isClaimedLocalClose(source, code)) return@withCallbackAdmission
                    enqueueTermination(
                        owner.key,
                        source,
                        TerminationCause.TransportClosed(code),
                    )
                }
            }

            override fun onFailure(source: RelayV2Transport, failure: RelayV2TransportFailure) {
                withCallbackAdmission(owner, source) {
                    if (!acceptCallbackSource(owner, source)) return@withCallbackAdmission
                    enqueueTermination(
                        owner.key,
                        source,
                        TerminationCause.TransportFailed(failure),
                    )
                }
            }
        }

    private inline fun withCallbackAdmission(
        owner: ProvisionalCallbackOwner,
        source: RelayV2Transport,
        callback: () -> Unit,
    ) {
        val admission = callbackAdmissions.tryEnter(owner.key)
        if (admission == null) {
            retirePostSealCallbackSource(owner, source)
            return
        }
        try {
            afterCallbackAdmission(source)
            callback()
        } finally {
            admission.close()
            synchronized(lifecycleLock) { clearDrainedCompletedRetirementsLocked() }
        }
    }

    private fun retirePostSealCallbackSource(
        owner: ProvisionalCallbackOwner,
        source: RelayV2Transport,
    ) {
        var cancelUntrackedSource = false
        val command = synchronized(lifecycleLock) {
            val alreadyOwned = activeTransport === source ||
                committedCallbackOwner?.source === source ||
                provisionalCallbackOwner?.callbackSource === source ||
                provisionalCallbackOwner?.factorySource === source ||
                source in transportFences ||
                source in transportRetirements ||
                source in completedTransportRetirements
            if (alreadyOwned) return@synchronized null

            if (owner.factorySourceResolved) {
                cancelUntrackedSource = true
                return@synchronized null
            }
            owner.postSealCallbackSeen = true
            val tracked = owner.postSealRetiredSource
            when {
                tracked == null -> {
                    owner.postSealRetiredSource = source
                    claimRetirementLocked(
                        source,
                        closeCode = null,
                        forceCancel = true,
                    )
                }
                tracked === source -> null
                else -> {
                    cancelUntrackedSource = true
                    null
                }
            }
        }
        command?.execute()
        // A sealed attempt retains one plausible factory source in its normal termination fence.
        // Extra distinct callback sources are rejected through the transport's idempotent cancel
        // without expanding actor-owned identity state.
        if (cancelUntrackedSource) source.cancel()
    }

    private fun enqueueCallback(
        action: Action,
        source: RelayV2Transport,
        owner: CallbackOwnerKey,
    ) {
        val result = synchronized(lifecycleLock) {
            when {
                lifecycleState != LifecycleState.OPEN -> CallbackEnqueue.STOPPED
                !acceptsCallbackLocked(owner, source) -> CallbackEnqueue.STALE
                !reserveBytes(queuedActionBytes, action.rawBytes, actionByteCapacity) ->
                    CallbackEnqueue.SATURATED
                else -> {
                    queuedTransportCallbacks[source] =
                        (queuedTransportCallbacks[source] ?: 0) + 1
                    if (actions.trySendNormal(action)) {
                        CallbackEnqueue.ENQUEUED
                    } else {
                        releaseQueuedTransportCallbackLocked(source)
                        releaseBytes(queuedActionBytes, action.rawBytes)
                        CallbackEnqueue.SATURATED
                    }
                }
            }
        }
        when (result) {
            CallbackEnqueue.ENQUEUED -> Unit
            CallbackEnqueue.STALE ->
                beginRetirement(listOf(source), reason = "stale v2 transport callback")
            CallbackEnqueue.STOPPED -> beginRetirement(listOf(source), closeCode = null)
            CallbackEnqueue.SATURATED -> signalQueueSaturation(owner, source)
            else -> error("Unexpected normal callback enqueue state")
        }
    }

    private fun enqueueTermination(
        owner: CallbackOwnerKey,
        source: RelayV2Transport,
        cause: TerminationCause,
    ) = enqueueTerminalAction(
        owner,
        source,
        Action.TerminateConnection(
            owner.connectTokenId,
            owner.effectGeneration,
            source,
            cause,
        ),
        TerminalIntentCause.Transport(cause),
    )

    private fun enqueueSourceMismatch(
        owner: CallbackOwnerKey,
        source: RelayV2Transport,
        leaseSources: Collection<RelayV2Transport>,
    ) = enqueueTerminalAction(
        owner,
        source,
        Action.TransportSourceMismatch(
            owner.connectTokenId,
            owner.effectGeneration,
            source,
        ),
        TerminalIntentCause.SourceMismatch,
        leaseSources = leaseSources,
    )

    private fun enqueueTerminalAction(
        owner: CallbackOwnerKey,
        source: RelayV2Transport?,
        action: Action,
        intentCause: TerminalIntentCause,
        cancelOnRetry: Boolean = true,
        leaseSources: Collection<RelayV2Transport> = listOfNotNull(source),
        acceptIntentLocked: () -> Boolean = { true },
    ) {
        require(
            action is Action.TerminateConnection ||
                action is Action.TransportSourceMismatch ||
                action is Action.QueueSaturated ||
                action is Action.HandshakeTimedOut,
        ) {
            "Relay v2 terminal lane accepts only terminal transport actions"
        }
        val result = synchronized(lifecycleLock) {
            when {
                lifecycleState != LifecycleState.OPEN -> CallbackEnqueue.STOPPED
                !acceptsCallbackLocked(owner, source) -> CallbackEnqueue.STALE
                !acceptIntentLocked() -> CallbackEnqueue.IGNORED
                else -> {
                    recordTerminalIntentLocked(owner, intentCause)
                    retainTerminalCallbackLeasesLocked(owner, leaseSources)
                    when {
                        !lastTerminationGeneration.compareAndSet(null, owner.effectGeneration) ->
                            CallbackEnqueue.COALESCED
                        actions.trySendNormalOrReserved(action) -> CallbackEnqueue.ENQUEUED
                        else -> CallbackEnqueue.RETRY
                    }
                }
            }
        }
        when (result) {
            CallbackEnqueue.ENQUEUED,
            CallbackEnqueue.COALESCED,
            CallbackEnqueue.IGNORED,
            -> return
            CallbackEnqueue.STALE -> {
                source?.let { beginRetirement(listOf(it), closeCode = null) }
                return
            }
            CallbackEnqueue.STOPPED -> {
                source?.let { beginRetirement(listOf(it), closeCode = null) }
                return
            }
            CallbackEnqueue.RETRY -> Unit
            CallbackEnqueue.SATURATED -> error("Termination cannot reserve raw callback bytes")
        }
        if (cancelOnRetry && source != null) {
            beginRetirement(listOf(source), closeCode = null, forceCancel = true)
        }
        scope.launch {
            var handedOff = false
            try {
                while (!resourcesClosed.get()) {
                    val retry = synchronized(lifecycleLock) {
                        when {
                            lifecycleState != LifecycleState.OPEN ||
                                !acceptsCallbackLocked(owner, source) -> CallbackEnqueue.STOPPED
                            !hasCurrentTerminalIntentLocked(owner) -> {
                                pendingTerminalIntent = null
                                lastTerminationGeneration.compareAndSet(
                                    owner.effectGeneration,
                                    null,
                                )
                                CallbackEnqueue.IGNORED
                            }
                            actions.trySendReserved(action) -> CallbackEnqueue.ENQUEUED
                            else -> CallbackEnqueue.RETRY
                        }
                    }
                    when (retry) {
                        CallbackEnqueue.ENQUEUED -> {
                            handedOff = true
                            return@launch
                        }
                        CallbackEnqueue.STOPPED,
                        CallbackEnqueue.IGNORED,
                        -> return@launch
                        CallbackEnqueue.RETRY -> delay(CONTROL_ENQUEUE_RETRY_MS)
                        else -> error("Unexpected termination retry state")
                    }
                }
            } finally {
                if (!handedOff) {
                    synchronized(lifecycleLock) {
                        releaseTerminalCallbackLeasesLocked(owner)
                    }
                }
            }
        }
    }

    private fun hasCurrentTerminalIntentLocked(owner: CallbackOwnerKey): Boolean {
        val pending = pendingTerminalIntent?.takeIf { it.owner == owner } ?: return false
        return isTerminalIntentCurrentLocked(pending.cause) ||
            pending.fallbackCause?.let(::isTerminalIntentCurrentLocked) == true
    }

    private fun recordTerminalIntentLocked(
        owner: CallbackOwnerKey,
        cause: TerminalIntentCause,
    ) {
        val pending = pendingTerminalIntent
        if (pending == null || pending.owner != owner) {
            pendingTerminalIntent = PendingTerminalIntent(owner, cause)
            return
        }
        val currentPriority = terminalSemanticPriority(pending.cause)
        val candidatePriority = terminalSemanticPriority(cause)
        when {
            pending.cause is TerminalIntentCause.HandshakeTimeout &&
                cause !is TerminalIntentCause.HandshakeTimeout &&
                candidatePriority <= currentPriority -> {
                val fallback = pending.fallbackCause
                if (fallback == null ||
                    candidatePriority > terminalSemanticPriority(fallback)
                ) {
                    pending.fallbackCause = cause
                }
            }
            candidatePriority > currentPriority -> {
                if (cause is TerminalIntentCause.HandshakeTimeout &&
                    pending.cause !is TerminalIntentCause.HandshakeTimeout
                ) {
                    pending.fallbackCause = pending.cause
                } else {
                    pending.fallbackCause = null
                }
                pending.cause = cause
            }
        }
    }

    private fun terminalSemanticPriority(cause: TerminalIntentCause): Int = when (cause) {
        TerminalIntentCause.SourceMismatch -> 4
        TerminalIntentCause.QueueSaturated -> 1
        is TerminalIntentCause.DirectFailure,
        is TerminalIntentCause.HandshakeTimeout,
        is TerminalIntentCause.Transport,
        -> terminalDisposition(cause).let { disposition ->
            when {
                disposition.queueOverridable -> 0
                !disposition.failure.retryable -> 3
                else -> 2
            }
        }
    }

    private fun retainTerminalCallbackLeasesLocked(
        owner: CallbackOwnerKey,
        sources: Collection<RelayV2Transport>,
    ) {
        if (sources.isEmpty()) return
        val leases = terminalCallbackLeases.getOrPut(owner) { identitySetOf() }
        sources.forEach { source ->
            if (leases.add(source)) {
                queuedTransportCallbacks[source] = (queuedTransportCallbacks[source] ?: 0) + 1
            }
        }
    }

    private fun releaseTerminalCallbackLeasesLocked(owner: CallbackOwnerKey) {
        terminalCallbackLeases.remove(owner)?.forEach(::releaseQueuedTransportCallbackLocked)
    }

    private fun signalQueueSaturation(
        owner: CallbackOwnerKey?,
        source: RelayV2Transport?,
    ) {
        if (owner != null) {
            enqueueTerminalAction(
                owner,
                source,
                Action.QueueSaturated(
                    owner.connectTokenId,
                    owner.effectGeneration,
                    source,
                ),
                TerminalIntentCause.QueueSaturated,
                cancelOnRetry = false,
            )
        }
        source?.let {
            beginRetirement(listOf(it), closeCode = 1013, reason = "relay v2 slow consumer")
        }
    }

    private fun transportOpened(action: Action.TransportOpened) {
        if (!isCurrentCallback(action.owner, action.source)) {
            beginRetirement(listOf(action.source), reason = "stale v2 transport")
            return
        }
        if (_state.value.phase != RelayV2ConnectionPhase.CONNECTING) {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
            return
        }
        if (action.selectedSubprotocol != RelayV2Profile.RELAY_V2_SUBPROTOCOL) {
            failConnection(
                RelayV2FailureKind.DIALECT,
                "PROTOCOL_UNSUPPORTED",
                retryable = false,
                closeCode = 4406,
            )
            return
        }
        updateState(RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME, activeProfile)
        scheduleRelayWelcomeWatchdog(action.owner, action.source)
    }

    private fun transportFrame(action: Action.TransportFrame) {
        if (!isCurrentCallback(action.owner, action.source)) return
        val decoded = try {
            codec.decodeWebSocketFrame(
                RelayV2WebSocketChannel.PUBLIC,
                action.bytes,
                action.metadata,
            )
        } catch (_: RelayV2CodecException) {
            handlePotentialAgentExtensionFrame(action.bytes, action.metadata)
            return
        }
        if (routeOverlappingAgentExtensionError(decoded, action.bytes, action.metadata)) return
        when (_state.value.phase) {
            RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME -> handleRelayWelcome(decoded, action.bytes.size)
            RelayV2ConnectionPhase.AWAITING_HOST_WELCOME -> handleHostWelcome(decoded, action.bytes.size)
            RelayV2ConnectionPhase.QUERYING,
            RelayV2ConnectionPhase.RESYNCING,
            -> {
                beforeRecoveryFrameDispatch()
                handleRecoveryFrame(decoded, action.bytes.size)
            }
            RelayV2ConnectionPhase.ONLINE -> deliverOnlineFrame(decoded, action.bytes.size)
            else -> failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
        }
    }

    private fun handlePotentialAgentExtensionFrame(
        bytes: ByteArray,
        metadata: RelayV2FrameMetadata,
    ) {
        val artifact = try {
            agentExtensionCodec.decodePublicFrameArtifact(
                bytes,
                AgentTranscriptLifecycleV1FrameMetadata(
                    opcode = metadata.opcode,
                    compressed = metadata.compressed,
                ),
            )
        } catch (_: AgentTranscriptLifecycleV1CodecException) {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
            return
        }
        deliverAgentExtensionArtifact(artifact)
    }

    /**
     * The base and Agent schemas deliberately overlap only at selected `type=error` codes. Route
     * one such frame to the extension only when it is bound to this generation's exact pending or
     * retired request and the strict extension codec issues the artifact. Every other base error
     * keeps the frozen base route.
     */
    private fun routeOverlappingAgentExtensionError(
        decoded: RelayV2DecodedMessage,
        bytes: ByteArray,
        metadata: RelayV2FrameMetadata,
    ): Boolean {
        if (decoded.type() != "error" || _state.value.phase !in AGENT_EXTENSION_INBOUND_PHASES) {
            return false
        }
        val context = onlineContext ?: return false
        if (AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY !in context.negotiatedCapabilities) return false
        val frame = decoded.frame
        val requestId = frame["requestId"] as? String ?: return false
        val errorCode = (frame["error"] as? Map<*, *>)?.get("code") as? String ?: return false
        if (errorCode !in BASE_AGENT_EXTENSION_OVERLAPPING_ERROR_CODES) return false
        val owner = agentExtensionRequestOwnerForOverlappingError(requestId) ?: return false
        fun isolateOwnedError(): Boolean {
            isolateAgentExtension(RelayV2AgentExtensionUnavailableReason.UNCORRELATED_RESPONSE)
            return true
        }
        val sendFence = agentExtensionSendFence.get() ?: return isolateOwnedError()
        if (owner.identity.authority != sendFence.authority ||
            context.repositoryEffectAuthority(sendFence.authority.generation) != sendFence.authority
        ) return isolateOwnedError()
        val artifact = try {
            agentExtensionCodec.decodePublicFrameArtifact(
                bytes,
                AgentTranscriptLifecycleV1FrameMetadata(
                    opcode = metadata.opcode,
                    compressed = metadata.compressed,
                ),
            )
        } catch (_: AgentTranscriptLifecycleV1CodecException) {
            return isolateOwnedError()
        }
        val extensionError = artifact.frame as? AgentTimelineErrorFrame
            ?: return isolateOwnedError()
        if (extensionError.requestId != requestId || extensionError.error.code.wireValue != errorCode) {
            return isolateOwnedError()
        }
        if (!extensionError.matchesErrorRequest(owner.identity)) return isolateOwnedError()
        if (owner.uncorrelatedOnly) return isolateOwnedError()
        deliverAgentExtensionArtifact(artifact)
        return true
    }

    private fun deliverAgentExtensionArtifact(
        artifact: AgentTranscriptLifecycleV1PublicFrameArtifact,
    ) {
        val phase = _state.value.phase
        val context = onlineContext
        if (phase !in AGENT_EXTENSION_INBOUND_PHASES ||
            context == null ||
            AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY !in context.negotiatedCapabilities
        ) {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
            return
        }
        val resolved = resolveAgentExtensionIngress(artifact, context) ?: return
        val profile = activeProfile ?: return
        emitAgentExtensionDelivery(
            effect = RelayV2RuntimeEffect.DeliverAgentExtensionFrame(
                context = context,
                artifact = artifact,
                ingress = resolved.ingress,
                requestAdmission = resolved.admission,
                generation = currentEffectGeneration(profile),
            ),
            admission = resolved.admission,
        )
    }

    private fun resolveAgentExtensionIngress(
        artifact: AgentTranscriptLifecycleV1PublicFrameArtifact,
        context: RelayV2HandshakeContext,
    ): ResolvedAgentExtensionIngress? = when (val frame = artifact.frame) {
        is AgentTimelineEventFrame,
        is AgentTimelineResetFrame,
        -> if ((frame as AgentTranscriptLifecycleV1InboundFrame).matchesHost(context)) {
            ResolvedAgentExtensionIngress(AgentTranscriptLifecycleTrustedIngress.Live, null)
        } else {
            isolateAgentExtension(RelayV2AgentExtensionUnavailableReason.RESPONSE_ROUTE_MISMATCH)
        }
        is AgentTimelineStatusFrame -> correlateAgentExtensionResponse(
            frame,
            frame.requestId,
            AgentTranscriptLifecycleRequestKind.STATUS,
        )
        is AgentTimelineReplayPageFrame -> correlateAgentExtensionResponse(
            frame,
            frame.requestId,
            AgentTranscriptLifecycleRequestKind.REPLAY,
        )
        is AgentTimelineSnapshotPageFrame -> correlateAgentExtensionResponse(
            frame,
            frame.requestId,
            AgentTranscriptLifecycleRequestKind.SNAPSHOT,
        )
        is AgentTimelineErrorFrame -> {
            val pending = pendingAgentExtensionRequestForResponse(frame.requestId)
                ?: return isolateAgentExtension(
                    RelayV2AgentExtensionUnavailableReason.UNCORRELATED_RESPONSE,
                )
            if (!frame.matchesErrorRequest(pending.request)) {
                isolateAgentExtension(
                    RelayV2AgentExtensionUnavailableReason.RESPONSE_ROUTE_MISMATCH,
                )
            } else {
                ResolvedAgentExtensionIngress(
                    ingress = AgentTranscriptLifecycleTrustedIngress.CorrelatedError(
                        requestKind = pending.request.kind,
                        requestId = frame.requestId,
                        statusRequestFence =
                            (pending.request as? AgentTranscriptLifecycleActorRequest.Status)
                                ?.requestFence,
                    ),
                    admission = pending.admission,
                )
            }
        }
        else -> {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
            null
        }
    }

    private fun correlateAgentExtensionResponse(
        frame: AgentTranscriptLifecycleV1InboundFrame,
        requestId: String,
        expectedKind: AgentTranscriptLifecycleRequestKind,
    ): ResolvedAgentExtensionIngress? {
        val pending = pendingAgentExtensionRequestForResponse(requestId)
            ?: return isolateAgentExtension(
                RelayV2AgentExtensionUnavailableReason.UNCORRELATED_RESPONSE,
            )
        if (pending.request.kind != expectedKind || !frame.matchesRequest(pending.request)) {
            return isolateAgentExtension(
                RelayV2AgentExtensionUnavailableReason.RESPONSE_ROUTE_MISMATCH,
            )
        }
        val ingress = when (val request = pending.request) {
            is AgentTranscriptLifecycleActorRequest.Status ->
                AgentTranscriptLifecycleTrustedIngress.CorrelatedStatus(request.requestFence)
            is AgentTranscriptLifecycleActorRequest.Replay ->
                AgentTranscriptLifecycleTrustedIngress.Replay
            is AgentTranscriptLifecycleActorRequest.Snapshot ->
                AgentTranscriptLifecycleTrustedIngress.Snapshot
        }
        return ResolvedAgentExtensionIngress(ingress, pending.admission)
    }

    private fun isolateAgentExtension(
        reason: RelayV2AgentExtensionUnavailableReason,
    ): ResolvedAgentExtensionIngress? {
        val context = onlineContext ?: return null
        val profile = activeProfile ?: return null
        emitAgentExtensionControlEffect(
            RelayV2RuntimeEffect.AgentExtensionUnavailable(
                context = context,
                reason = reason,
                generation = currentEffectGeneration(profile),
            ),
        )
        return null
    }

    private fun sendAgentExtensionRequest(action: SendAgentExtensionRequestAction) {
        val source = synchronized(lifecycleLock) {
            val pending = pendingAgentExtensionRequests[action.request.requestId]
            val fence = agentExtensionSendFence.get()
            val context = onlineContext
            if (pending?.admission != action.admission ||
                pending.state != AgentExtensionPendingState.QUEUED ||
                fence == null ||
                fence.authority != action.request.authority ||
                context == null ||
                context.repositoryEffectAuthority(fence.authority.generation) != fence.authority ||
                AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY !in fence.negotiatedCapabilities ||
                _state.value.phase !in AGENT_EXTENSION_INBOUND_PHASES
            ) return@synchronized null
            activeTransport
        } ?: return
        if (!runCatching { source.send(action.bytes) }.getOrDefault(false)) {
            requestAgentExtensionRetry(
                action.admission,
                RelayV2AgentExtensionUnavailableReason.REQUEST_SEND_FAILED,
            )
            return
        }
        val admitted = synchronized(lifecycleLock) {
            val pending = pendingAgentExtensionRequests[action.request.requestId]
            if (pending?.admission != action.admission ||
                pending.state != AgentExtensionPendingState.QUEUED
            ) return@synchronized false
            pending.state = AgentExtensionPendingState.SENT
            true
        }
        if (admitted) scheduleAgentExtensionRequestWatchdog(action.admission)
    }

    private fun pendingAgentExtensionRequestForResponse(
        requestId: String,
    ): PendingAgentExtensionRequest? = synchronized(lifecycleLock) {
        pendingAgentExtensionRequests[requestId]
            ?.takeIf { it.state == AgentExtensionPendingState.SENT }
    }

    private fun agentExtensionRequestOwnerForOverlappingError(
        requestId: String,
    ): AgentExtensionOverlappingErrorOwner? = synchronized(lifecycleLock) {
        val pending = pendingAgentExtensionRequests[requestId]
        if (pending != null) {
            return@synchronized AgentExtensionOverlappingErrorOwner(
                identity = pending.request.retiredIdentity(),
                uncorrelatedOnly = pending.state != AgentExtensionPendingState.SENT,
            )
        }
        retiredAgentExtensionRequests[requestId]?.let {
            AgentExtensionOverlappingErrorOwner(it, uncorrelatedOnly = true)
        }
    }

    private fun clearPendingAgentExtensionRequests() = synchronized(lifecycleLock) {
        pendingAgentExtensionRequests.values.forEach {
            it.watchdog?.cancel()
            releasePendingAgentExtensionDeliveryBytesLocked(it)
        }
        pendingAgentExtensionRequests.clear()
        retiredAgentExtensionRequests.clear()
        drainQueuedEffects(agentExtensionHandoffEffectChannel, null)
    }

    private fun scheduleAgentExtensionRequestWatchdog(
        admission: AgentTranscriptLifecycleRequestAdmission,
    ) {
        val job = scope.launch {
            extensionRequestWatchdogDelay(extensionRequestTimeoutMs)
            requestAgentExtensionRetry(
                admission,
                RelayV2AgentExtensionUnavailableReason.REQUEST_TIMEOUT,
            )
        }
        synchronized(lifecycleLock) {
            val pending = pendingAgentExtensionRequests[admission.requestId]
            if (pending?.admission == admission &&
                pending.state == AgentExtensionPendingState.SENT
            ) {
                pending.watchdog?.cancel()
                pending.watchdog = job
            } else {
                job.cancel()
            }
        }
    }

    private fun requestAgentExtensionRetry(
        admission: AgentTranscriptLifecycleRequestAdmission,
        reason: RelayV2AgentExtensionUnavailableReason,
    ) {
        val queued = synchronized(lifecycleLock) {
            val context = onlineContext ?: return
            val profile = activeProfile ?: return
            val pending = pendingAgentExtensionRequests[admission.requestId]
                ?.takeIf {
                    it.admission == admission &&
                        it.state != AgentExtensionPendingState.HANDOFF_QUEUED
                } ?: return
            pending.watchdog?.cancel()
            pending.watchdog = null
            pending.state = AgentExtensionPendingState.HANDOFF_QUEUED
            pending.delivery = PendingAgentExtensionDelivery(
                effect = RelayV2RuntimeEffect.AgentExtensionUnavailable(
                    context = context,
                    reason = reason,
                    failedRequest = pending.request,
                    requestAdmission = admission,
                    generation = currentEffectGeneration(profile),
                ),
                rawBytes = 0,
            )
            enqueueAgentExtensionDeliveryLocked(pending)
        }
        if (!queued) {
            // The exact failure remains actor-owned and will be retried on its bounded lane.
            // Only the optional extension is isolated; base routes remain online.
            isolateAgentExtension(reason)
        }
    }

    private fun AgentTranscriptLifecycleV1InboundFrame.matchesHost(
        context: RelayV2HandshakeContext,
    ): Boolean = hostId == context.hostId && hostEpoch == context.hostEpoch

    private fun AgentTranscriptLifecycleV1InboundFrame.matchesRequest(
        request: AgentTranscriptLifecycleActorRequest,
    ): Boolean = hostId == request.authority.hostId &&
        hostEpoch == request.authority.hostEpoch &&
        scopeId == request.scopeId &&
        sessionId == request.sessionId

    private fun AgentTranscriptLifecycleActorRequest.retiredIdentity() =
        RetiredAgentExtensionRequestIdentity(
            authority = authority,
            requestKind = kind,
            requestId = requestId,
            scopeId = scopeId,
            sessionId = sessionId,
        )

    private fun AgentTimelineErrorFrame.matchesErrorRequest(
        request: RetiredAgentExtensionRequestIdentity,
    ): Boolean {
        if (hostId != request.authority.hostId ||
            scopeId != request.scopeId ||
            sessionId != request.sessionId
        ) return false
        if (error.code != AgentTimelineErrorCode.HOST_EPOCH_MISMATCH) {
            return hostEpoch == request.authority.hostEpoch
        }
        val details = error.details as? AgentTimelineHostEpochMismatchDetails ?: return false
        return details.expectedHostEpoch == request.authority.hostEpoch &&
            details.actualHostEpoch == hostEpoch
    }

    private fun AgentTimelineErrorFrame.matchesErrorRequest(
        request: AgentTranscriptLifecycleActorRequest,
    ): Boolean = matchesErrorRequest(request.retiredIdentity())

    private fun handleRecoveryFrame(decoded: RelayV2DecodedMessage, rawBytes: Int) {
        val profile = activeProfile ?: return
        if (isKnownCompletedDuplicate(decoded)) return
        val allowedTypes = when (_state.value.phase) {
            RelayV2ConnectionPhase.QUERYING -> QUERYING_INBOUND_TYPES
            RelayV2ConnectionPhase.RESYNCING -> RESYNCING_INBOUND_TYPES
            else -> emptySet()
        }
        if (decoded.type() !in allowedTypes) {
            failConnection(
                RelayV2FailureKind.SCHEMA,
                "INVALID_ENVELOPE",
                retryable = false,
                closeCode = 4400,
                rawBytes = rawBytes,
            )
            return
        }
        when (decoded.type()) {
            "command.statuses" -> handleCommandStatuses(decoded, rawBytes)
            "state.snapshot.chunk" -> handleStateSnapshotChunk(decoded, rawBytes)
            "state.snapshot.released" -> handleStateSnapshotReleased(decoded, rawBytes)
            "error" -> handleRecoveryError(decoded, rawBytes)
            else -> deliverPostHandshakeFrame(decoded, rawBytes, profile)
        }
    }

    private fun deliverOnlineFrame(decoded: RelayV2DecodedMessage, rawBytes: Int) {
        val profile = activeProfile ?: return
        if (isKnownCompletedDuplicate(decoded)) return
        if (decoded.type() !in ONLINE_INBOUND_TYPES) {
            failConnection(
                RelayV2FailureKind.SCHEMA,
                "INVALID_ENVELOPE",
                retryable = false,
                closeCode = 4400,
                rawBytes = rawBytes,
            )
            return
        }
        if (decoded.type() == "command.statuses" || decoded.type() == "state.snapshot.released") {
            val kind = if (decoded.type() == "command.statuses") {
                RecoveryResponseKind.COMMAND_STATUSES
            } else {
                RecoveryResponseKind.SNAPSHOT_RELEASED
            }
            if (isKnownCompletedResponse(decoded.frame, kind)) return
            failConnection(
                RelayV2FailureKind.SCHEMA,
                "INVALID_ENVELOPE",
                retryable = false,
                closeCode = 4400,
                rawBytes = rawBytes,
            )
            return
        }
        deliverPostHandshakeFrame(decoded, rawBytes, profile)
    }

    private fun deliverPostHandshakeFrame(
        decoded: RelayV2DecodedMessage,
        rawBytes: Int,
        profile: RelayV2Profile,
    ) {
        val context = recoveryAttempt?.takeIf(::isRecoveryCurrent)?.context ?: onlineContext
        if (decoded.type() in STATE_CHANGE_INBOUND_TYPES) {
            if (context == null ||
                decoded.frame["hostId"] != context.hostId ||
                decoded.frame["hostEpoch"] != context.hostEpoch
            ) {
                failConnection(
                    RelayV2FailureKind.SCHEMA,
                    "INVALID_ENVELOPE",
                    retryable = false,
                    closeCode = 4400,
                    rawBytes = rawBytes,
                )
                return
            }
        }
        if (context == null) {
            failConnection(
                RelayV2FailureKind.SCHEMA,
                "INVALID_ENVELOPE",
                retryable = false,
                closeCode = 4400,
                rawBytes = rawBytes,
            )
            return
        }
        val activeRecovery = recoveryAttempt?.takeIf(::isRecoveryCurrent)
        emitEffect(
            RelayV2RuntimeEffect.DeliverPostHandshakeFrame(
                context = context,
                message = decoded,
                rawUtf8Bytes = rawBytes,
                generation = currentEffectGeneration(profile),
                recovery = activeRecovery?.currentBinding(),
                queryLineage = activeRecovery?.queryWindowLineage,
                completedReleaseBinding =
                    activeRecovery?.completedReleaseBindingForStateEvent(),
            ),
            rawBytes,
        )
    }

    private fun handleCommandStatuses(decoded: RelayV2DecodedMessage, rawBytes: Int) {
        val recovery = recoveryAttempt ?: run {
            rejectUnlessKnownCompleted(decoded.frame, RecoveryResponseKind.COMMAND_STATUSES, rawBytes)
            return
        }
        if (recovery.stage != RecoveryStage.AWAITING_COMMAND_RESPONSE) {
            rejectUnlessKnownCompleted(decoded.frame, RecoveryResponseKind.COMMAND_STATUSES, rawBytes)
            return
        }
        val request = recovery.commandRequest ?: run {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400, rawBytes)
            return
        }
        val frame = decoded.frame
        if (frame["requestId"] != request.binding.requestId) {
            rejectUnlessKnownCompleted(frame, RecoveryResponseKind.COMMAND_STATUSES, rawBytes)
            return
        }
        if (!frameMatchesRecoveryAuthority(frame, recovery)) return
        val responseItems = frame.objectValue("payload").listValue("items").map { value ->
            val item = value as Map<*, *>
            RelayV2PendingCommand(
                commandId = item["commandId"] as String,
                dedupeWindowId = item["dedupeWindowId"] as String,
            )
        }
        if (responseItems.toSet() != request.commands.toSet() ||
            responseItems.size != request.commands.size
        ) {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400, rawBytes)
            return
        }
        rememberCompletedResponse(frame, RecoveryResponseKind.COMMAND_STATUSES)
        recovery.stage = RecoveryStage.AWAITING_COMMAND_RECEIPT
        if (emitEffect(
            RelayV2RuntimeEffect.ApplyCommandStatuses(
                context = recovery.context,
                message = decoded,
                expectedCommands = request.commands,
                recovery = request.binding,
                queryLineage = requireNotNull(recovery.queryWindowLineage),
            ),
            rawBytes,
        )) {
            scheduleRecoveryWatchdog(recovery, request.binding, recovery.stage)
        }
    }

    private fun handleStateSnapshotChunk(decoded: RelayV2DecodedMessage, rawBytes: Int) {
        val recovery = recoveryAttempt ?: run {
            rejectUnlessKnownCompleted(decoded.frame, RecoveryResponseKind.SNAPSHOT_CHUNK, rawBytes)
            return
        }
        if (recovery.stage != RecoveryStage.AWAITING_SNAPSHOT_RESPONSE) {
            rejectUnlessKnownCompleted(decoded.frame, RecoveryResponseKind.SNAPSHOT_CHUNK, rawBytes)
            return
        }
        val request = recovery.snapshotRequest ?: run {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400, rawBytes)
            return
        }
        val frame = decoded.frame
        if (frame["requestId"] != request.binding.requestId) {
            rejectUnlessKnownCompleted(frame, RecoveryResponseKind.SNAPSHOT_CHUNK, rawBytes)
            return
        }
        if (!frameMatchesRecoveryAuthority(frame, recovery)) return
        val payload = frame.objectValue("payload")
        if (payload["snapshotRequestId"] != request.snapshotRequestId ||
            payload.longValue("chunkIndex") != request.nextChunkIndex ||
            (request.snapshotId != null && payload["snapshotId"] != request.snapshotId)
        ) {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400, rawBytes)
            return
        }
        val response = SnapshotChunkResponse(
            snapshotRequestId = payload.stringValue("snapshotRequestId"),
            snapshotId = payload.stringValue("snapshotId"),
            chunkIndex = payload.longValue("chunkIndex"),
            isLast = payload.booleanValue("isLast"),
            nextCursor = payload["nextCursor"] as? String,
        )
        rememberCompletedResponse(frame, RecoveryResponseKind.SNAPSHOT_CHUNK)
        recovery.snapshotChunkResponse = response
        recovery.stage = RecoveryStage.AWAITING_SNAPSHOT_RECEIPT
        if (emitEffect(
            RelayV2RuntimeEffect.ApplyStateSnapshotChunk(
                context = recovery.context,
                message = decoded,
                rawUtf8Bytes = rawBytes,
                snapshotRequestId = request.snapshotRequestId,
                snapshotId = request.snapshotId,
                requestedCursor = request.cursor,
                requestedChunkIndex = request.nextChunkIndex,
                recovery = request.binding,
            ),
            rawBytes,
        )) {
            scheduleRecoveryWatchdog(recovery, request.binding, recovery.stage)
        }
    }

    private fun handleStateSnapshotReleased(decoded: RelayV2DecodedMessage, rawBytes: Int) {
        val recovery = recoveryAttempt ?: run {
            rejectUnlessKnownCompleted(decoded.frame, RecoveryResponseKind.SNAPSHOT_RELEASED, rawBytes)
            return
        }
        if (recovery.stage != RecoveryStage.AWAITING_RELEASE_RESPONSE) {
            rejectUnlessKnownCompleted(decoded.frame, RecoveryResponseKind.SNAPSHOT_RELEASED, rawBytes)
            return
        }
        val request = recovery.releaseRequest ?: run {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400, rawBytes)
            return
        }
        val frame = decoded.frame
        if (frame["requestId"] != request.binding.requestId) {
            rejectUnlessKnownCompleted(frame, RecoveryResponseKind.SNAPSHOT_RELEASED, rawBytes)
            return
        }
        if (!frameMatchesRecoveryAuthority(frame, recovery)) return
        val payload = frame.objectValue("payload")
        val released = payload.booleanValue("released")
        val alreadyReleased = payload.booleanValue("alreadyReleased")
        if (payload["snapshotRequestId"] != request.snapshotRequestId ||
            payload["snapshotId"] != request.snapshotId ||
            released == alreadyReleased
        ) {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400, rawBytes)
            return
        }
        if (recovery.releaseFollowUp == null) {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400, rawBytes)
            return
        }
        rememberCompletedResponse(frame, RecoveryResponseKind.SNAPSHOT_RELEASED)
        awaitDurableReleaseCompletion(
            recovery,
            request,
            if (released) RelayV2ReleaseAuthorityProof.RELEASED else {
                RelayV2ReleaseAuthorityProof.ALREADY_RELEASED
            },
            rawBytes,
        )
    }

    private fun handleRecoveryError(decoded: RelayV2DecodedMessage, rawBytes: Int) {
        val recovery = recoveryAttempt ?: run {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400, rawBytes)
            return
        }
        val frame = decoded.frame
        val requestId = frame["requestId"] as? String
        val request = recovery.releaseRequest
        val error = frame.objectValue("error")
        if (requestId != recovery.pendingRequestId || requestId == null) {
            if (error["code"] == "SNAPSHOT_EXPIRED" &&
                isKnownCompletedResponse(frame, RecoveryResponseKind.SNAPSHOT_EXPIRED)
            ) {
                return
            }
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400, rawBytes)
            return
        }
        if (!errorFrameMatchesRecoveryAuthority(frame, recovery)) return
        val snapshotRequest = recovery.snapshotRequest
        if (error["code"] == "SNAPSHOT_EXPIRED" &&
            recovery.stage == RecoveryStage.AWAITING_SNAPSHOT_RESPONSE &&
            snapshotRequest != null &&
            snapshotRequest.binding.requestId == requestId &&
            snapshotRequest.snapshotId != null
        ) {
            rememberCompletedResponse(frame, RecoveryResponseKind.SNAPSHOT_EXPIRED)
            recovery.stage = RecoveryStage.AWAITING_SNAPSHOT_RECEIPT
            if (emitEffect(
                RelayV2RuntimeEffect.ExpireSnapshotContinuation(
                    context = recovery.context,
                    snapshotRequestId = snapshotRequest.snapshotRequestId,
                    snapshotId = snapshotRequest.snapshotId,
                    recovery = snapshotRequest.binding,
                ),
                rawBytes,
            )) {
                scheduleRecoveryWatchdog(recovery, snapshotRequest.binding, recovery.stage)
            }
            return
        }
        if (error["code"] != "SNAPSHOT_EXPIRED" ||
            recovery.stage != RecoveryStage.AWAITING_RELEASE_RESPONSE ||
            request == null || request.binding.requestId != requestId
        ) {
            failFromStructuredError(error, rawBytes)
            return
        }
        val followUp = recovery.releaseFollowUp
        if (followUp == null) {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400, rawBytes)
            return
        }
        rememberCompletedResponse(frame, RecoveryResponseKind.SNAPSHOT_EXPIRED)
        awaitDurableReleaseCompletion(
            recovery,
            request,
            RelayV2ReleaseAuthorityProof.SNAPSHOT_EXPIRED,
            rawBytes,
        )
    }

    private fun awaitDurableReleaseCompletion(
        recovery: RecoveryAttempt,
        request: SnapshotReleaseRequest,
        proof: RelayV2ReleaseAuthorityProof,
        rawBytes: Int,
    ) {
        recovery.stage = RecoveryStage.AWAITING_RELEASE_RECEIPT
        val expectedRestart = when (val followUp = requireNotNull(recovery.releaseFollowUp)) {
            ReleaseFollowUp.QueryPendingCommands ->
                RelayV2RecoveryRestartDirective.QUERY_PENDING_COMMANDS
            is ReleaseFollowUp.RestartAfterAbandon -> followUp.directive
        }
        if (expectedRestart == RelayV2RecoveryRestartDirective.QUERY_PENDING_COMMANDS) {
            recovery.armQueryWindow(request.binding)
        }
        if (emitEffect(
            RelayV2RuntimeEffect.CompleteSnapshotRelease(
                context = recovery.context,
                release = request.release,
                proof = proof,
                expectedRestart = expectedRestart,
                recovery = request.binding,
            ),
            rawBytes,
        )) {
            scheduleRecoveryWatchdog(recovery, request.binding, recovery.stage)
        }
    }

    private fun rejectUnlessKnownCompleted(
        frame: Map<String, Any?>,
        kind: RecoveryResponseKind,
        rawBytes: Int,
    ) {
        if (!isKnownCompletedResponse(frame, kind)) {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400, rawBytes)
        }
    }

    private fun rememberCompletedResponse(
        frame: Map<String, Any?>,
        kind: RecoveryResponseKind,
    ) {
        val completed = CompletedRecoveryResponse(
            requestId = frame.stringValue("requestId"),
            kind = kind,
            hostId = frame["hostId"] as? String,
            hostEpoch = frame["hostEpoch"] as? String,
            fingerprint = recoveryResponseFingerprint(frame),
        )
        completedRecoveryResponses.remove(completed)
        completedRecoveryResponses.add(completed)
        while (completedRecoveryResponses.size > MAX_COMPLETED_RECOVERY_RESPONSES) {
            completedRecoveryResponses.remove(completedRecoveryResponses.first())
        }
    }

    private fun isKnownCompletedResponse(
        frame: Map<String, Any?>,
        kind: RecoveryResponseKind,
    ): Boolean {
        val requestId = frame["requestId"] as? String ?: return false
        return CompletedRecoveryResponse(
            requestId = requestId,
            kind = kind,
            hostId = frame["hostId"] as? String,
            hostEpoch = frame["hostEpoch"] as? String,
            fingerprint = recoveryResponseFingerprint(frame),
        ) in completedRecoveryResponses
    }

    private fun isKnownCompletedDuplicate(decoded: RelayV2DecodedMessage): Boolean {
        val kind = when (decoded.type()) {
            "command.statuses" -> RecoveryResponseKind.COMMAND_STATUSES
            "state.snapshot.chunk" -> RecoveryResponseKind.SNAPSHOT_CHUNK
            "state.snapshot.released" -> RecoveryResponseKind.SNAPSHOT_RELEASED
            "error" -> if (decoded.frame.objectValue("error")["code"] == "SNAPSHOT_EXPIRED") {
                RecoveryResponseKind.SNAPSHOT_EXPIRED
            } else {
                return false
            }
            else -> return false
        }
        return isKnownCompletedResponse(decoded.frame, kind)
    }

    private fun recoveryResponseFingerprint(frame: Map<String, Any?>): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(
            MessageDigest.getInstance("SHA-256").digest(
                com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
                    .stringify(frame)
                    .toByteArray(Charsets.UTF_8),
            ),
        )

    private fun errorFrameMatchesRecoveryAuthority(
        frame: Map<String, Any?>,
        recovery: RecoveryAttempt,
    ): Boolean {
        val hostId = frame["hostId"] as? String
        val hostEpoch = frame["hostEpoch"] as? String
        if ((hostId == null || hostId == recovery.context.hostId) &&
            (hostEpoch == null || hostEpoch == recovery.context.hostEpoch)
        ) {
            return true
        }
        failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
        return false
    }

    private fun frameMatchesRecoveryAuthority(
        frame: Map<String, Any?>,
        recovery: RecoveryAttempt,
    ): Boolean {
        if (frame["hostId"] == recovery.context.hostId &&
            frame["hostEpoch"] == recovery.context.hostEpoch
        ) {
            return true
        }
        failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
        return false
    }

    private fun handleRelayWelcome(decoded: RelayV2DecodedMessage, rawBytes: Int) {
        when (decoded.type()) {
            "relay.unavailable" -> {
                val profile = activeProfile ?: return
                if (decoded.frame["hostId"] != profile.hostId) {
                    failConnection(
                        RelayV2FailureKind.SCHEMA,
                        "INVALID_ENVELOPE",
                        retryable = false,
                        closeCode = 4400,
                        rawBytes = rawBytes,
                    )
                    return
                }
                val error = decoded.frame.objectValue("payload").objectValue("error")
                failFromStructuredError(error, rawBytes)
            }
            "relay.welcome" -> acceptRelayWelcome(decoded.frame)
            else -> failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
        }
    }

    private fun acceptRelayWelcome(frame: Map<String, Any?>) {
        val profile = activeProfile ?: return
        val payload = frame.objectValue("payload")
        if (payload.stringValue("principalId") != profile.principalId) {
            failConnection(RelayV2FailureKind.AUTH, "AUTH_INVALID", false, 4403)
            return
        }
        val capabilities = payload.stringList("capabilities").toSet()
        if (!capabilities.containsAll(REQUIRED_CAPABILITIES)) {
            failConnection(
                RelayV2FailureKind.CAPABILITY,
                "CAPABILITY_UNAVAILABLE",
                retryable = false,
                closeCode = 4406,
            )
            return
        }
        val limits = payload.objectValue("limits").longMap()
        if (!hasExactFrozenLimits(limits, FROZEN_BROKER_LIMITS)) {
            failConnection(RelayV2FailureKind.CAPABILITY, "CAPABILITY_UNAVAILABLE", false, 4406)
            return
        }

        relayWelcomeWatchdog?.cancel()
        relayWelcomeWatchdog = null
        brokerEpoch = payload.stringValue("brokerEpoch")
        brokerCapabilities = capabilities
        brokerLimits = limits
        val requestId = issueId() ?: return
        pendingHelloRequestId = requestId
        val hello = linkedMapOf<String, Any?>(
            "protocolVersion" to 2L,
            "kind" to "request",
            "type" to "client.hello",
            "requestId" to requestId,
            "hostId" to profile.hostId,
            "payload" to linkedMapOf(
                "clientInstanceId" to profile.clientInstanceId,
                "capabilities" to REQUIRED_CAPABILITIES +
                    advertisedOptionalCapabilities.sorted(),
                "requiredCapabilities" to REQUIRED_CAPABILITIES,
                "resume" to requestedResume?.let {
                    linkedMapOf(
                        "hostEpoch" to it.hostEpoch,
                        "lastEventSeq" to it.lastEventSeq,
                    )
                },
            ),
        )
        val encoded = codec.encodeWebSocketFrame(RelayV2WebSocketChannel.PUBLIC, hello)
        val source = activeTransport
        if (source == null || !source.send(encoded)) {
            failConnection(RelayV2FailureKind.TRANSPORT, "HOST_OFFLINE", true, null)
            return
        }
        val owner = synchronized(lifecycleLock) {
            val current = committedCallbackOwner
            if (
                lifecycleState != LifecycleState.OPEN ||
                current == null ||
                current.source !== source ||
                current.effectGeneration.connectionGeneration != connectionGeneration
            ) {
                null
            } else {
                updateState(RelayV2ConnectionPhase.AWAITING_HOST_WELCOME, profile)
                current.key
            }
        } ?: return
        scheduleHostWelcomeWatchdog(owner, source, requestId)
    }

    private fun handleHostWelcome(decoded: RelayV2DecodedMessage, rawBytes: Int) {
        val frame = decoded.frame
        if (frame["requestId"] != pendingHelloRequestId) {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
            return
        }
        when (decoded.type()) {
            "host.welcome" -> acceptHostWelcome(frame, rawBytes)
            "error" -> {
                val error = frame.objectValue("error")
                if (error.stringValue("code") == "EVENT_CURSOR_AHEAD") {
                    rejectAhead(frame, error, rawBytes)
                } else {
                    failFromStructuredError(error, rawBytes)
                }
            }
            else -> failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
        }
    }

    private fun acceptHostWelcome(frame: Map<String, Any?>, rawBytes: Int) {
        val profile = activeProfile ?: return
        if (frame["hostId"] != profile.hostId) {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
            return
        }
        val payload = frame.objectValue("payload")
        val hostCapabilities = payload.stringList("capabilities").toSet()
        val negotiatedRequired = REQUIRED_CAPABILITIES.toSet()
            .intersect(brokerCapabilities)
            .intersect(hostCapabilities)
        if (!negotiatedRequired.containsAll(REQUIRED_CAPABILITIES)) {
            failConnection(
                RelayV2FailureKind.CAPABILITY,
                "CAPABILITY_UNAVAILABLE",
                retryable = false,
                closeCode = 4406,
            )
            return
        }
        val negotiated = negotiatedRequired + advertisedOptionalCapabilities
            .intersect(brokerCapabilities)
            .intersect(hostCapabilities)
        val hostLimits = payload.objectValue("limits").longMap()
        val negotiatedLimits = negotiateLimits(requireNotNull(brokerLimits), hostLimits)
        if (negotiatedLimits == null) {
            failConnection(RelayV2FailureKind.CAPABILITY, "CAPABILITY_UNAVAILABLE", false, 4406)
            return
        }

        val hostEpoch = frame.stringValue("hostEpoch")
        val eventSeq = payload.stringValue("eventSeq")
        val outcome = expectedHelloOutcome(requestedResume, hostEpoch, eventSeq)
        if (outcome == RelayV2HelloOutcome.EVENT_CURSOR_AHEAD) {
            val resume = requireNotNull(requestedResume)
            rejectContinuity(profile, hostEpoch, resume.lastEventSeq, eventSeq, rawBytes)
            return
        }
        val expectedWire = outcome.expectedWireDisposition()
        if (payload.stringValue("resumeDisposition") != expectedWire.first ||
            payload.stringValue("resumeReason") != expectedWire.second
        ) {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
            return
        }

        val window = payload.objectValue("commandDedupeWindow")
        val context = RelayV2HandshakeContext(
            profile = profile.identity,
            principalId = profile.principalId,
            clientInstanceId = profile.clientInstanceId,
            hostId = profile.hostId,
            brokerEpoch = requireNotNull(brokerEpoch),
            hostEpoch = hostEpoch,
            hostInstanceId = frame.stringValue("hostInstanceId"),
            eventSeq = eventSeq,
            negotiatedCapabilities = negotiated,
            negotiatedLimits = negotiatedLimits,
            commandDedupeWindow = RelayV2CommandDedupeWindow(
                windowId = window.stringValue("windowId"),
                windowSeq = window.stringValue("windowSeq"),
                acceptUntilMs = window.longValue("acceptUntilMs"),
                queryUntilMs = window.longValue("queryUntilMs"),
            ),
        )
        hostWelcomeWatchdog?.cancel()
        hostWelcomeWatchdog = null
        val helloRequestId = requireNotNull(pendingHelloRequestId)
        pendingHelloRequestId = null
        val effectGeneration = currentEffectGeneration(profile)
        if (!activateEffectGenerationIfCurrent(
                context,
                effectGeneration,
            )
        ) {
            return
        }
        val recovery = RelayV2RecoveryBinding(
            generation = effectGeneration,
            step = 1,
            requestId = helloRequestId,
        )
        recoveryAttempt = RecoveryAttempt(
            context = context,
            outcome = outcome,
            connectPlan = requireNotNull(activeConnectPlan),
            generation = effectGeneration,
            helloRequestId = helloRequestId,
            step = recovery.step,
            stage = RecoveryStage.AWAITING_HELLO_RECEIPT,
        )
        if (outcome == RelayV2HelloOutcome.MATCHED) {
            requireNotNull(recoveryAttempt).armQueryWindow(recovery)
        }
        when (outcome) {
            RelayV2HelloOutcome.MATCHED -> {
                updateState(RelayV2ConnectionPhase.QUERYING, profile)
                if (emitEffect(
                    RelayV2RuntimeEffect.QueryPendingCommands(
                        context,
                        effectGeneration,
                        recovery,
                        requireNotNull(activeConnectPlan),
                    ),
                    rawBytes,
                )) {
                    scheduleRecoveryWatchdog(
                        requireNotNull(recoveryAttempt),
                        recovery,
                        RecoveryStage.AWAITING_HELLO_RECEIPT,
                    )
                }
            }
            RelayV2HelloOutcome.FRESH,
            RelayV2HelloOutcome.CURSOR_BEHIND,
            RelayV2HelloOutcome.HOST_EPOCH_CHANGED,
            -> {
                updateState(RelayV2ConnectionPhase.RESYNCING, profile)
                if (emitEffect(
                    RelayV2RuntimeEffect.BeginStateResync(
                        context = context,
                        generation = effectGeneration,
                        outcome = outcome,
                        discardPriorResourceLineage =
                            outcome == RelayV2HelloOutcome.HOST_EPOCH_CHANGED,
                        recovery = recovery,
                        connectPlan = requireNotNull(activeConnectPlan),
                    ),
                    rawBytes,
                )) {
                    scheduleRecoveryWatchdog(
                        requireNotNull(recoveryAttempt),
                        recovery,
                        RecoveryStage.AWAITING_HELLO_RECEIPT,
                    )
                }
            }
            RelayV2HelloOutcome.EVENT_CURSOR_AHEAD -> error("Handled above")
        }
    }

    private fun handleRecoveryReceipt(
        receipt: RelayV2RecoveryReceipt,
    ): RelayV2RecoveryReceiptProcessingResult {
        if (receipt is RelayV2RecoveryReceipt.QueryRecoverySuperseded) {
            return recoveryReceiptResult(
                receipt.binding.generation,
                applyQueryRecoverySuperseded(receipt),
            )
        }
        val recovery = recoveryAttempt
            ?: return RelayV2RecoveryReceiptProcessingResult.StaleOrTerminal
        if (!isRecoveryCurrent(recovery) ||
            receipt.binding.generation != recovery.generation ||
            receipt.binding.step != recovery.step ||
            receipt.hostId != recovery.context.hostId ||
            receipt.hostEpoch != recovery.context.hostEpoch
        ) {
            return RelayV2RecoveryReceiptProcessingResult.StaleOrTerminal
        }
        val consumed = when (receipt) {
            is RelayV2RecoveryReceipt.HelloApplied -> applyHelloReceipt(recovery, receipt)
            is RelayV2RecoveryReceipt.CommandQueryAttemptRegistered ->
                applyCommandQueryAttemptRegistered(recovery, receipt)
            is RelayV2RecoveryReceipt.CommandStatusesApplied ->
                applyCommandStatusesReceipt(recovery, receipt)
            is RelayV2RecoveryReceipt.SnapshotChunkApplied ->
                applySnapshotChunkReceipt(recovery, receipt)
            is RelayV2RecoveryReceipt.RecoveryAbandoned ->
                applyRecoveryAbandonedReceipt(recovery, receipt)
            is RelayV2RecoveryReceipt.RecoveryRestartRequired ->
                applyRecoveryRestartRequiredReceipt(recovery, receipt)
            is RelayV2RecoveryReceipt.QueryRecoverySuperseded ->
                error("Handled before current recovery lookup")
            is RelayV2RecoveryReceipt.ReleaseObligationRecovered ->
                applyRecoveredReleaseReceipt(recovery, receipt)
            is RelayV2RecoveryReceipt.SnapshotReleaseCompleted ->
                applySnapshotReleaseCompletedReceipt(recovery, receipt)
        }
        return recoveryReceiptResult(receipt.binding.generation, consumed)
    }

    private fun recoveryReceiptResult(
        generation: RelayV2EffectGeneration,
        consumed: Boolean,
    ): RelayV2RecoveryReceiptProcessingResult = synchronized(lifecycleLock) {
        if (!consumed) {
            return@synchronized RelayV2RecoveryReceiptProcessingResult.StaleOrTerminal
        }
        val readyAuthority = outboxExecuteReadyCut?.authority?.takeIf { authority ->
            authority.generation == generation &&
                _state.value.phase == RelayV2ConnectionPhase.ONLINE
        }
        readyAuthority?.let { RelayV2RecoveryReceiptProcessingResult.OnlineReady(it) }
            ?: if (publishedEffectGeneration.get() == generation &&
                lifecycleState == LifecycleState.OPEN
            ) {
                RelayV2RecoveryReceiptProcessingResult.ContinuedRecovery
            } else {
                RelayV2RecoveryReceiptProcessingResult.StaleOrTerminal
            }
    }

    private fun applyCommandQueryAttemptRegistered(
        recovery: RecoveryAttempt,
        receipt: RelayV2RecoveryReceipt.CommandQueryAttemptRegistered,
    ): Boolean {
        if (recovery.stage != RecoveryStage.AWAITING_COMMAND_QUERY_COMMIT) return false
        val request = recovery.commandRequest ?: return false
        val receiver = commandQueryAdmissionReceiver ?: return false
        if (!receiver.consume(
                actorReceiverIdentity = commandQueryReceiverIdentity,
                receipt = receipt,
                expectedBinding = request.binding,
                expectedHostId = recovery.context.hostId,
                expectedHostEpoch = recovery.context.hostEpoch,
                expectedCommandBatch = request.commandBatch,
            )
        ) return false
        return sendRegisteredCommandQuery(recovery, request)
    }

    private fun handleOnlineResyncRequired(receipt: RelayV2OnlineResyncRequired) {
        val profile = activeProfile ?: return
        val context = onlineContext ?: return
        if (_state.value.phase != RelayV2ConnectionPhase.ONLINE ||
            recoveryAttempt != null ||
            receipt.generation != currentEffectGeneration(profile) ||
            receipt.hostId != context.hostId ||
            receipt.hostEpoch != context.hostEpoch
        ) {
            return
        }
        receipt.release?.let { release ->
            if (!releaseMatchesContext(release, context)) {
                failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
                return
            }
        }
        val lineageId = issueId() ?: return
        val recovery = RecoveryAttempt(
            context = context,
            outcome = RelayV2HelloOutcome.CURSOR_BEHIND,
            connectPlan = requireNotNull(activeConnectPlan),
            generation = receipt.generation,
            helloRequestId = lineageId,
            step = 1,
            stage = RecoveryStage.AWAITING_HELLO_RECEIPT,
        )
        onlineQueryWindow = null
        recoveryAttempt = recovery
        recovery.pendingCommands = receipt.pendingCommands
        recovery.nextCommandIndex = 0
        recovery.step += 1
        updateState(RelayV2ConnectionPhase.RESYNCING, profile)
        val release = receipt.release
        if (release == null) {
            beginStateSnapshot(recovery, continuation = null)
        } else {
            sendSnapshotRelease(
                recovery,
                release,
                ReleaseFollowUp.RestartAfterAbandon(receipt.restart),
            )
        }
    }

    private fun releaseMatchesContext(
        release: RelayV2RecoveryReleaseDirective,
        context: RelayV2HandshakeContext,
    ): Boolean = release.profileId == context.profile.profileId &&
        release.principalId == activeProfile?.principalId &&
        release.clientInstanceId == activeProfile?.clientInstanceId &&
        release.hostId == context.hostId &&
        release.hostEpoch == context.hostEpoch

    private fun applyHelloReceipt(
        recovery: RecoveryAttempt,
        receipt: RelayV2RecoveryReceipt.HelloApplied,
    ): Boolean {
        if (recovery.stage != RecoveryStage.AWAITING_HELLO_RECEIPT ||
            receipt.binding.requestId != recovery.helloRequestId
        ) {
            return false
        }
        val matched = recovery.outcome == RelayV2HelloOutcome.MATCHED
        val continuation = receipt.snapshotContinuation
        if (matched) {
            val cursor = receipt.durableCursorEventSeq ?: return false
            if (BigInteger(cursor) < BigInteger(recovery.context.eventSeq) ||
                continuation != null
            ) {
                failConnection(
                    RelayV2FailureKind.SCHEMA,
                    "DURABLE_RECOVERY_RECEIPT_INVALID",
                    retryable = false,
                    closeCode = 4400,
                )
                return false
            }
        } else if (continuation != null) {
            val plan = recovery.connectPlan
            val authorized = plan.recovery == RelayV2ConnectRecovery.RESYNCING &&
                plan.durableHostEpoch == recovery.context.hostEpoch &&
                plan.snapshotComplete == false &&
                plan.snapshotRequestId == continuation.snapshotRequestId &&
                plan.snapshotId == continuation.snapshotId &&
                plan.snapshotNextCursor == continuation.cursor &&
                plan.snapshotNextChunkIndex == continuation.nextChunkIndex &&
                (recovery.outcome == RelayV2HelloOutcome.CURSOR_BEHIND ||
                    recovery.outcome == RelayV2HelloOutcome.FRESH)
            if (!authorized) {
                failConnection(
                    RelayV2FailureKind.SCHEMA,
                    "DURABLE_RECOVERY_RECEIPT_INVALID",
                    retryable = false,
                    closeCode = 4400,
                )
                return false
            }
        }
        recovery.pendingCommands = receipt.pendingCommands
        recovery.nextCommandIndex = 0
        recovery.step += 1
        return if (matched) {
            beginCommandQueries(recovery, receipt.binding)
        } else {
            beginStateSnapshot(recovery, continuation)
        }
    }

    private fun applyCommandStatusesReceipt(
        recovery: RecoveryAttempt,
        receipt: RelayV2RecoveryReceipt.CommandStatusesApplied,
    ): Boolean {
        if (recovery.stage != RecoveryStage.AWAITING_COMMAND_RECEIPT) return false
        val request = recovery.commandRequest ?: return false
        if (receipt.binding != request.binding ||
            receipt.appliedCommands != request.commands
        ) {
            return false
        }
        recovery.nextCommandIndex += request.commands.size
        recovery.commandRequest = null
        recovery.step += 1
        return sendNextCommandQuery(recovery)
    }

    private fun applySnapshotChunkReceipt(
        recovery: RecoveryAttempt,
        receipt: RelayV2RecoveryReceipt.SnapshotChunkApplied,
    ): Boolean {
        if (recovery.stage != RecoveryStage.AWAITING_SNAPSHOT_RECEIPT) return false
        val request = recovery.snapshotRequest ?: return false
        val response = recovery.snapshotChunkResponse ?: return false
        if (receipt.binding != request.binding ||
            receipt.result.snapshotRequestId != response.snapshotRequestId ||
            receipt.result.snapshotId != response.snapshotId
        ) {
            return false
        }
        when (val result = receipt.result) {
            is RelayV2DurableSnapshotApplyResult.Continue -> {
                if (response.isLast ||
                    result.nextChunkIndex != response.chunkIndex + 1 ||
                    result.nextCursor != response.nextCursor
                ) {
                    return false
                }
                recovery.step += 1
                recovery.snapshotChunkResponse = null
                return sendStateSnapshotRequest(
                    recovery = recovery,
                    snapshotRequestId = result.snapshotRequestId,
                    snapshotId = result.snapshotId,
                    cursor = result.nextCursor,
                    nextChunkIndex = result.nextChunkIndex,
                )
            }
            is RelayV2DurableSnapshotApplyResult.Committed -> {
                if (!response.isLast || response.nextCursor != null ||
                    BigInteger(result.durableCursorEventSeq) <
                    BigInteger(recovery.context.eventSeq)
                ) {
                    return false
                }
                recovery.step += 1
                recovery.snapshotChunkResponse = null
                recovery.snapshotRequest = null
                return sendSnapshotRelease(
                    recovery = recovery,
                    release = result.release,
                    followUp = ReleaseFollowUp.QueryPendingCommands,
                )
            }
        }
    }

    private fun applyRecoveryAbandonedReceipt(
        recovery: RecoveryAttempt,
        receipt: RelayV2RecoveryReceipt.RecoveryAbandoned,
    ): Boolean {
        if (receipt.binding != recovery.currentBinding()) return false
        if (receipt.restart == RelayV2RecoveryRestartDirective.QUERY_PENDING_COMMANDS) {
            if (recovery.outcome == RelayV2HelloOutcome.FRESH ||
                recovery.outcome == RelayV2HelloOutcome.HOST_EPOCH_CHANGED ||
                BigInteger(requireNotNull(receipt.durableCursorEventSeq)) <
                BigInteger(recovery.context.eventSeq)
            ) {
                return false
            }
        }
        recovery.pendingCommands = receipt.pendingCommands
        recovery.nextCommandIndex = 0

        val restart = ReleaseFollowUp.RestartAfterAbandon(receipt.restart)
        val inFlightRelease = recovery.releaseRequest
        if (recovery.stage == RecoveryStage.AWAITING_RELEASE_RESPONSE &&
            inFlightRelease != null && receipt.release == inFlightRelease.release
        ) {
            recovery.releaseFollowUp = restart
            return true
        }

        recovery.commandRequest = null
        recovery.snapshotRequest = null
        recovery.snapshotChunkResponse = null
        recovery.releaseRequest = null
        recovery.releaseFollowUp = null
        recovery.step += 1
        return sendSnapshotRelease(
            recovery = recovery,
            release = receipt.release,
            followUp = restart,
        )
    }

    private fun applyRecoveryRestartRequiredReceipt(
        recovery: RecoveryAttempt,
        receipt: RelayV2RecoveryReceipt.RecoveryRestartRequired,
    ): Boolean {
        if (receipt.binding != recovery.currentBinding() ||
            !restartReceiptCanAdvance(recovery, receipt.durableCursorEventSeq, receipt.restart)
        ) {
            return false
        }
        recovery.pendingCommands = receipt.pendingCommands
        recovery.nextCommandIndex = 0
        recovery.commandRequest = null
        recovery.snapshotRequest = null
        recovery.snapshotChunkResponse = null
        recovery.releaseRequest = null
        recovery.releaseFollowUp = null
        recovery.step += 1
        return continueAfterAbandon(
            recovery,
            ReleaseFollowUp.RestartAfterAbandon(receipt.restart),
            receipt.binding,
        )
    }

    private fun applyRecoveredReleaseReceipt(
        recovery: RecoveryAttempt,
        receipt: RelayV2RecoveryReceipt.ReleaseObligationRecovered,
    ): Boolean {
        if (receipt.binding != recovery.currentBinding() ||
            !restartReceiptCanAdvance(recovery, receipt.durableCursorEventSeq, receipt.restart)
        ) {
            return false
        }
        recovery.pendingCommands = receipt.pendingCommands
        recovery.nextCommandIndex = 0
        recovery.commandRequest = null
        recovery.snapshotRequest = null
        recovery.snapshotChunkResponse = null
        recovery.releaseRequest = null
        recovery.releaseFollowUp = null
        recovery.step += 1
        return sendSnapshotRelease(
            recovery = recovery,
            release = receipt.release,
            followUp = ReleaseFollowUp.RestartAfterAbandon(receipt.restart),
        )
    }

    private fun applySnapshotReleaseCompletedReceipt(
        recovery: RecoveryAttempt,
        receipt: RelayV2RecoveryReceipt.SnapshotReleaseCompleted,
    ): Boolean {
        if (recovery.stage != RecoveryStage.AWAITING_RELEASE_RECEIPT) return false
        val request = recovery.releaseRequest ?: return false
        recovery.releaseFollowUp ?: return false
        if (receipt.binding != request.binding || receipt.release != request.release) return false
        recovery.step += 1
        recovery.releaseRequest = null
        recovery.releaseFollowUp = null
        return when (receipt.restart) {
            RelayV2RecoveryRestartDirective.SNAPSHOT -> {
                beginStateSnapshot(recovery, continuation = null)
            }
            RelayV2RecoveryRestartDirective.QUERY_PENDING_COMMANDS -> {
                recovery.sourceCompletedReleaseBinding = receipt.binding
                beginCommandQueries(recovery, receipt.binding)
            }
        }
    }

    private fun applyQueryRecoverySuperseded(
        receipt: RelayV2RecoveryReceipt.QueryRecoverySuperseded,
    ): Boolean {
        val profile = activeProfile ?: return false
        val context = onlineContext ?: return false
        if (receipt.binding.generation != currentEffectGeneration(profile) ||
            receipt.hostId != context.hostId || receipt.hostEpoch != context.hostEpoch
        ) {
            return false
        }
        if (!isCanonicalRelayV2RuntimeCounter(receipt.requiredThroughEventSeq) ||
            receipt.durableCursorEventSeq?.let {
                !isCanonicalRelayV2RuntimeCounter(it) ||
                    BigInteger(receipt.requiredThroughEventSeq) <= BigInteger(it)
            } == true
        ) {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
            return false
        }
        val recovery = recoveryAttempt
        val activeWindowMatches = recovery?.let {
            isRecoveryCurrent(it) &&
                it.queryWindowLineage == receipt.queryLineage &&
                receipt.binding in it.queryWindowEffectBindings &&
                it.completedReleaseBindingForStateEvent() ==
                receipt.completedReleaseBinding
        } == true
        val onlineWindowMatches = recovery == null &&
            _state.value.phase == RelayV2ConnectionPhase.ONLINE &&
            onlineQueryWindow?.let {
                it.lineage == receipt.queryLineage &&
                    receipt.binding in it.effectBindings &&
                    it.completedReleaseBinding == receipt.completedReleaseBinding
            } == true
        if (!activeWindowMatches && !onlineWindowMatches) {
            return false
        }
        onlineQueryWindow = null

        val activeRecovery = recovery ?: run {
            if (_state.value.phase != RelayV2ConnectionPhase.ONLINE) return false
            val lineageId = issueId() ?: return false
            RecoveryAttempt(
                context = context,
                outcome = RelayV2HelloOutcome.CURSOR_BEHIND,
                connectPlan = requireNotNull(activeConnectPlan),
                generation = receipt.binding.generation,
                helloRequestId = lineageId,
                step = 1,
                stage = RecoveryStage.AWAITING_HELLO_RECEIPT,
            ).also { recoveryAttempt = it }
        }
        activeRecovery.pendingCommands = receipt.pendingCommands
        activeRecovery.nextCommandIndex = 0
        activeRecovery.commandRequest = null
        activeRecovery.snapshotRequest = null
        activeRecovery.snapshotChunkResponse = null
        activeRecovery.releaseRequest = null
        activeRecovery.releaseFollowUp = null
        activeRecovery.clearQueryWindow()
        activeRecovery.step += 1
        return beginStateSnapshot(activeRecovery, continuation = null)
    }

    private fun restartReceiptCanAdvance(
        recovery: RecoveryAttempt,
        durableCursorEventSeq: String?,
        restart: RelayV2RecoveryRestartDirective,
    ): Boolean {
        if (restart != RelayV2RecoveryRestartDirective.QUERY_PENDING_COMMANDS) return true
        return recovery.outcome != RelayV2HelloOutcome.FRESH &&
            recovery.outcome != RelayV2HelloOutcome.HOST_EPOCH_CHANGED &&
            BigInteger(requireNotNull(durableCursorEventSeq)) >=
            BigInteger(recovery.context.eventSeq)
    }

    private fun continueAfterAbandon(
        recovery: RecoveryAttempt,
        restart: ReleaseFollowUp.RestartAfterAbandon,
        originBinding: RelayV2RecoveryBinding,
    ): Boolean {
        return when (restart.directive) {
            RelayV2RecoveryRestartDirective.SNAPSHOT ->
                beginStateSnapshot(recovery, continuation = null)
            RelayV2RecoveryRestartDirective.QUERY_PENDING_COMMANDS ->
                beginCommandQueries(recovery, originBinding)
        }
    }

    private fun beginStateSnapshot(
        recovery: RecoveryAttempt,
        continuation: RelayV2SnapshotContinuation?,
    ): Boolean {
        if (!isRecoveryCurrent(recovery)) return false
        recovery.clearQueryWindow()
        onlineQueryWindow = null
        updateState(RelayV2ConnectionPhase.RESYNCING, activeProfile)
        return if (continuation == null) {
            val snapshotRequestId = issueId() ?: return false
            sendStateSnapshotRequest(
                recovery = recovery,
                snapshotRequestId = snapshotRequestId,
                snapshotId = null,
                cursor = null,
                nextChunkIndex = 0,
            )
        } else {
            sendStateSnapshotRequest(
                recovery = recovery,
                snapshotRequestId = continuation.snapshotRequestId,
                snapshotId = continuation.snapshotId,
                cursor = continuation.cursor,
                nextChunkIndex = continuation.nextChunkIndex,
            )
        }
    }

    private fun sendStateSnapshotRequest(
        recovery: RecoveryAttempt,
        snapshotRequestId: String,
        snapshotId: String?,
        cursor: String?,
        nextChunkIndex: Long,
    ): Boolean {
        if (!isRecoveryCurrent(recovery)) return false
        val requestId = issueId() ?: return false
        val binding = RelayV2RecoveryBinding(recovery.generation, recovery.step, requestId)
        recovery.snapshotRequest = SnapshotRequest(
            binding = binding,
            snapshotRequestId = snapshotRequestId,
            snapshotId = snapshotId,
            cursor = cursor,
            nextChunkIndex = nextChunkIndex,
        )
        recovery.stage = RecoveryStage.AWAITING_SNAPSHOT_RESPONSE
        val frame = linkedMapOf<String, Any?>(
            "protocolVersion" to 2L,
            "kind" to "request",
            "type" to "state.snapshot.get",
            "requestId" to requestId,
            "hostId" to recovery.context.hostId,
            "expectedHostEpoch" to recovery.context.hostEpoch,
            "payload" to linkedMapOf(
                "snapshotRequestId" to snapshotRequestId,
                "snapshotId" to snapshotId,
                "cursor" to cursor,
                "nextChunkIndex" to nextChunkIndex,
            ),
        )
        if (sendRecoveryFrame(recovery, frame)) {
            scheduleRecoveryWatchdog(recovery, binding, recovery.stage)
            return true
        }
        return false
    }

    private fun sendSnapshotRelease(
        recovery: RecoveryAttempt,
        release: RelayV2RecoveryReleaseDirective,
        followUp: ReleaseFollowUp,
    ): Boolean {
        if (!isRecoveryCurrent(recovery)) return false
        // A release flow replaces any earlier hello/query readiness lineage. If it later resumes
        // querying, the exact release binding becomes that new window's origin.
        recovery.clearQueryWindow()
        onlineQueryWindow = null
        if (!releaseMatchesContext(release, recovery.context)) {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
            return false
        }
        val requestId = issueId() ?: return false
        val binding = RelayV2RecoveryBinding(recovery.generation, recovery.step, requestId)
        recovery.releaseRequest = SnapshotReleaseRequest(
            binding,
            release,
        )
        recovery.releaseFollowUp = followUp
        recovery.stage = RecoveryStage.AWAITING_RELEASE_RESPONSE
        updateState(RelayV2ConnectionPhase.RESYNCING, activeProfile)
        val frame = linkedMapOf<String, Any?>(
            "protocolVersion" to 2L,
            "kind" to "request",
            "type" to "state.snapshot.release",
            "requestId" to requestId,
            "hostId" to recovery.context.hostId,
            "expectedHostEpoch" to recovery.context.hostEpoch,
            "payload" to linkedMapOf(
                "snapshotRequestId" to release.snapshotRequestId,
                "snapshotId" to release.snapshotId,
                "reason" to release.reason.wireValue,
            ),
        )
        if (sendRecoveryFrame(recovery, frame)) {
            scheduleRecoveryWatchdog(recovery, binding, recovery.stage)
            return true
        }
        return false
    }

    private fun beginCommandQueries(
        recovery: RecoveryAttempt,
        originBinding: RelayV2RecoveryBinding,
    ): Boolean {
        if (!isRecoveryCurrent(recovery)) return false
        recovery.armQueryWindow(originBinding)
        updateState(RelayV2ConnectionPhase.QUERYING, activeProfile)
        return sendNextCommandQuery(recovery)
    }

    private fun sendNextCommandQuery(recovery: RecoveryAttempt): Boolean {
        if (!isRecoveryCurrent(recovery)) return false
        if (recovery.nextCommandIndex >= recovery.pendingCommands.size) {
            onlineQueryWindow = recovery.queryWindowLineage?.let {
                OnlineQueryWindow(
                    it,
                    recovery.queryWindowEffectBindings.toSet(),
                    recovery.sourceCompletedReleaseBinding,
                )
            }
            recovery.clearQueryWindow()
            clearRecoveryAttempt()
            return enterOnlineIfCurrent(
                recovery.context,
                recovery.generation,
                activeProfile,
            ) != null
        }
        if (commandQueryAdmissionReceiver == null) {
            failConnection(
                RelayV2FailureKind.CONFIGURATION,
                "COMMAND_QUERY_ADMISSION_UNAVAILABLE",
                retryable = false,
                closeCode = 1013,
            )
            return false
        }
        val maxBatch = minOf(
            32,
            recovery.context.negotiatedLimits.maxCommandQueryIds.toInt(),
        )
        val commands = recovery.pendingCommands.subList(
            recovery.nextCommandIndex,
            minOf(recovery.pendingCommands.size, recovery.nextCommandIndex + maxBatch),
        ).toList()
        val requestId = issueId() ?: return false
        val binding = RelayV2RecoveryBinding(recovery.generation, recovery.step, requestId)
        recovery.armQueryWindow(binding)
        val commandBatch = RelayV2CommandQueryBatch(commands)
        recovery.commandRequest = CommandQueryRequest(binding, commandBatch)
        recovery.stage = RecoveryStage.AWAITING_COMMAND_QUERY_COMMIT
        val emitted = emitEffect(
            RelayV2RuntimeEffect.RegisterCommandQueryAttempt(
                recovery = binding,
                hostId = recovery.context.hostId,
                hostEpoch = recovery.context.hostEpoch,
                commandBatch = commandBatch,
                repositoryAuthority = recovery.context.repositoryEffectAuthority(
                    recovery.generation,
                ),
            ),
        )
        if (emitted) {
            scheduleRecoveryWatchdog(recovery, binding, recovery.stage)
        }
        return emitted
    }

    private fun sendRegisteredCommandQuery(
        recovery: RecoveryAttempt,
        request: CommandQueryRequest,
    ): Boolean {
        if (!isRecoveryCurrent(recovery) ||
            recovery.stage != RecoveryStage.AWAITING_COMMAND_QUERY_COMMIT ||
            recovery.commandRequest !== request
        ) {
            return false
        }
        recovery.stage = RecoveryStage.AWAITING_COMMAND_RESPONSE
        val frame = linkedMapOf<String, Any?>(
            "protocolVersion" to 2L,
            "kind" to "request",
            "type" to "command.query",
            "requestId" to request.binding.requestId,
            "hostId" to recovery.context.hostId,
            "expectedHostEpoch" to recovery.context.hostEpoch,
            "payload" to linkedMapOf(
                "items" to request.commands.map { command ->
                    linkedMapOf(
                        "commandId" to command.commandId,
                        "dedupeWindowId" to command.dedupeWindowId,
                    )
                },
            ),
        )
        if (sendRecoveryFrame(recovery, frame)) {
            scheduleRecoveryWatchdog(recovery, request.binding, recovery.stage)
            return true
        }
        return false
    }

    private fun sendRecoveryFrame(
        recovery: RecoveryAttempt,
        frame: Map<String, Any?>,
    ): Boolean {
        val encoded = try {
            codec.encodeWebSocketFrame(RelayV2WebSocketChannel.PUBLIC, frame)
        } catch (_: RelayV2CodecException) {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
            return false
        }
        val result = synchronized(lifecycleLock) {
            if (!isRecoveryCurrentLocked(recovery)) {
                RecoverySendResult.STALE
            } else {
                val source = activeTransport
                if (source != null && source.send(encoded)) {
                    RecoverySendResult.SENT
                } else {
                    RecoverySendResult.FAILED
                }
            }
        }
        if (result == RecoverySendResult.FAILED) {
            failConnection(RelayV2FailureKind.TRANSPORT, "HOST_OFFLINE", true, null)
        }
        return result == RecoverySendResult.SENT
    }

    private fun isRecoveryCurrent(recovery: RecoveryAttempt): Boolean =
        synchronized(lifecycleLock) { isRecoveryCurrentLocked(recovery) }

    private fun isRecoveryCurrentLocked(recovery: RecoveryAttempt): Boolean {
        val committed = committedCallbackOwner
        return recoveryAttempt === recovery &&
            lifecycleState == LifecycleState.OPEN &&
            committed?.effectGeneration == recovery.generation &&
            publishedEffectGeneration.get() == recovery.generation &&
            activeTransport === committed.source
    }

    private fun issueId(): String? {
        val candidate = attemptId()
        if (!UUID_PATTERN.matches(candidate) || candidate in recentIssuedIds) {
            failConnection(RelayV2FailureKind.CONFIGURATION, "INVALID_ATTEMPT_ID", false, null)
            return null
        }
        recentIssuedIds += candidate
        if (recentIssuedIds.size > MAX_RECENT_ISSUED_IDS) {
            recentIssuedIds.remove(recentIssuedIds.first())
        }
        return candidate
    }

    private fun rejectAhead(
        frame: Map<String, Any?>,
        error: Map<String, Any?>,
        rawBytes: Int,
    ) {
        val profile = activeProfile ?: return
        val resume = requestedResume
        val details = error["details"] as? Map<*, *>
        val clientSeq = details?.get("clientLastEventSeq") as? String
        val hostSeq = details?.get("hostEventSeq") as? String
        val hostEpoch = frame["hostEpoch"] as? String
        if (resume == null ||
            frame["hostId"] != profile.hostId ||
            hostEpoch != resume.hostEpoch ||
            clientSeq != resume.lastEventSeq ||
            hostSeq == null ||
            BigInteger(clientSeq) <= BigInteger(hostSeq)
        ) {
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
            return
        }
        rejectContinuity(profile, hostEpoch, clientSeq, hostSeq, rawBytes)
    }

    private fun rejectContinuity(
        profile: RelayV2Profile,
        hostEpoch: String,
        clientSeq: String,
        hostSeq: String,
        rawBytes: Int = 0,
    ) {
        cancelHandshakeWatchdogs()
        val effectGeneration = currentEffectGeneration(profile)
        val source = synchronized(lifecycleLock) {
            val committed = committedCallbackOwner
            if (lifecycleState != LifecycleState.OPEN ||
                committed?.effectGeneration != effectGeneration ||
                publishedEffectGeneration.get() != effectGeneration
            ) {
                return
            }
            effectApplyGate.activate(effectGeneration)
            callbackAdmissions.sealThrough(committed.key)
            committedCallbackOwner = null
            clearPublishedEffectAuthorityLocked()
            activeTransport.also { activeTransport = null }
        }
        clearRecoveryAttempt()
        clearPendingAgentExtensionRequests()
        source?.let {
            beginRetirement(listOf(it), closeCode = 4400, reason = "event cursor ahead")
        }
        pendingHelloRequestId = null
        updateState(RelayV2ConnectionPhase.CONTINUITY_REJECTED, profile)
        emitEffect(
            RelayV2RuntimeEffect.RejectContinuity(
                profile = profile.identity,
                generation = effectGeneration,
                hostId = profile.hostId,
                hostEpoch = hostEpoch,
                clientLastEventSeq = clientSeq,
                hostEventSeq = hostSeq,
            ),
            rawBytes,
        )
    }

    private fun expectedHelloOutcome(
        resume: RelayV2ResumeCursor?,
        hostEpoch: String,
        eventSeq: String,
    ): RelayV2HelloOutcome = when {
        resume == null -> RelayV2HelloOutcome.FRESH
        resume.hostEpoch != hostEpoch -> RelayV2HelloOutcome.HOST_EPOCH_CHANGED
        BigInteger(resume.lastEventSeq) < BigInteger(eventSeq) -> RelayV2HelloOutcome.CURSOR_BEHIND
        BigInteger(resume.lastEventSeq) == BigInteger(eventSeq) -> RelayV2HelloOutcome.MATCHED
        else -> RelayV2HelloOutcome.EVENT_CURSOR_AHEAD
    }

    private fun RelayV2HelloOutcome.expectedWireDisposition(): Pair<String, String> = when (this) {
        RelayV2HelloOutcome.FRESH -> "snapshot_required" to "fresh"
        RelayV2HelloOutcome.MATCHED -> "caught_up" to "matched"
        RelayV2HelloOutcome.CURSOR_BEHIND -> "snapshot_required" to "cursor_behind"
        RelayV2HelloOutcome.HOST_EPOCH_CHANGED ->
            "snapshot_required" to "host_epoch_changed"
        RelayV2HelloOutcome.EVENT_CURSOR_AHEAD -> error("Cursor ahead has no host.welcome")
    }

    private fun scheduleRelayWelcomeWatchdog(
        owner: CallbackOwnerKey,
        source: RelayV2Transport,
    ) {
        relayWelcomeWatchdog?.cancel()
        relayWelcomeWatchdog = scope.launch {
            watchdogDelay(relayWelcomeTimeoutMs)
            enqueueHandshakeTimeout(
                owner,
                source,
                RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME,
                requestId = null,
            )
        }
    }

    private fun scheduleHostWelcomeWatchdog(
        owner: CallbackOwnerKey,
        source: RelayV2Transport,
        requestId: String,
    ) {
        hostWelcomeWatchdog?.cancel()
        hostWelcomeWatchdog = scope.launch {
            watchdogDelay(hostWelcomeTimeoutMs)
            enqueueHandshakeTimeout(
                owner,
                source,
                RelayV2ConnectionPhase.AWAITING_HOST_WELCOME,
                requestId,
            )
        }
    }

    private fun enqueueHandshakeTimeout(
        owner: CallbackOwnerKey,
        source: RelayV2Transport,
        expectedPhase: RelayV2ConnectionPhase,
        requestId: String?,
    ) {
        enqueueTerminalAction(
            owner,
            source,
            Action.HandshakeTimedOut(
                owner.connectTokenId,
                owner.effectGeneration,
                source,
                expectedPhase,
                requestId,
            ),
            TerminalIntentCause.HandshakeTimeout(expectedPhase, requestId),
            cancelOnRetry = false,
            acceptIntentLocked = {
                _state.value.phase == expectedPhase &&
                    (requestId == null || pendingHelloRequestId == requestId)
            },
        )
    }

    private fun cancelHandshakeWatchdogs() {
        relayWelcomeWatchdog?.cancel()
        relayWelcomeWatchdog = null
        hostWelcomeWatchdog?.cancel()
        hostWelcomeWatchdog = null
    }

    private fun scheduleRecoveryWatchdog(
        recovery: RecoveryAttempt,
        binding: RelayV2RecoveryBinding,
        expectedStage: RecoveryStage,
    ) {
        recoveryStepWatchdog?.cancel()
        fun fireTimeout() {
            val committed = synchronized(lifecycleLock) {
                committedCallbackOwner?.takeIf {
                    isRecoveryCurrentLocked(recovery) &&
                        recovery.stage == expectedStage &&
                        recovery.currentBinding() == binding
                }
            } ?: return
            enqueueRecoveryTimeout(
                Action.RecoveryStepTimedOut(
                    committed.connectTokenId,
                    committed.effectGeneration,
                    committed.source,
                    binding,
                    expectedStage,
                ),
            )
        }
        recoveryStepWatchdog = scope.launch {
            recoveryWatchdogDelay(recoveryStepTimeoutMs)
            fireTimeout()
        }
        afterRecoveryWatchdogArmed(binding, ::fireTimeout)
    }

    private fun enqueueRecoveryTimeout(action: Action.RecoveryStepTimedOut) {
        val first = synchronized(lifecycleLock) {
            when {
                lifecycleState != LifecycleState.OPEN ||
                    !acceptsCallbackLocked(action.owner, action.source) -> CallbackEnqueue.STOPPED
                actions.trySendNormalOrReserved(action) -> CallbackEnqueue.ENQUEUED
                else -> CallbackEnqueue.RETRY
            }
        }
        if (first != CallbackEnqueue.RETRY) return
        scope.launch {
            while (!resourcesClosed.get()) {
                val retry = synchronized(lifecycleLock) {
                    when {
                        lifecycleState != LifecycleState.OPEN ||
                            !acceptsCallbackLocked(action.owner, action.source) ->
                            CallbackEnqueue.STOPPED
                        actions.trySendReserved(action) -> CallbackEnqueue.ENQUEUED
                        else -> CallbackEnqueue.RETRY
                    }
                }
                when (retry) {
                    CallbackEnqueue.ENQUEUED,
                    CallbackEnqueue.STOPPED,
                    -> return@launch
                    CallbackEnqueue.RETRY -> delay(CONTROL_ENQUEUE_RETRY_MS)
                    else -> error("Unexpected recovery timeout retry state")
                }
            }
        }
    }

    private fun handleRecoveryTimeout(action: Action.RecoveryStepTimedOut) {
        beforeRecoveryTimeoutClaim()
        val current = synchronized(lifecycleLock) {
            isCurrentCallbackLocked(action.owner, action.source) &&
                recoveryAttempt?.let { recovery ->
                    recovery.generation == action.effectGeneration &&
                        recovery.stage == action.expectedStage &&
                        recovery.currentBinding() == action.binding
                } == true
        }
        if (!current) return
        failConnection(
            RelayV2FailureKind.TRANSPORT,
            "RECOVERY_TIMEOUT",
            retryable = true,
            closeCode = 1013,
        )
    }

    private fun clearRecoveryAttempt() {
        recoveryStepWatchdog?.cancel()
        recoveryStepWatchdog = null
        recoveryAttempt = null
    }

    private fun hasExactFrozenLimits(
        actual: Map<String, Long>,
        frozen: Map<String, Long>,
    ): Boolean = actual == frozen && actual.values.all { it > 0 }

    private fun negotiateLimits(
        broker: Map<String, Long>,
        host: Map<String, Long>,
    ): RelayV2NegotiatedLimits? {
        if (!hasExactFrozenLimits(broker, FROZEN_BROKER_LIMITS) ||
            !hasExactFrozenLimits(host, FROZEN_HOST_LIMITS)
        ) {
            return null
        }
        val routeHigh = minOf(
            broker.getValue("brokerRouteBufferedBytesPerDirection"),
            host.getValue("brokerRouteBufferedBytesPerDirection"),
        )
        val routeLow = minOf(
            broker.getValue("brokerRouteLowWaterBytesPerDirection"),
            host.getValue("brokerRouteLowWaterBytesPerDirection"),
        )
        if (routeLow >= routeHigh ||
            broker.getValue("brokerCarrierLowWaterBytes") >=
            broker.getValue("brokerCarrierBufferedBytes") ||
            host.getValue("commandResultRetentionMs") >
            host.getValue("commandDedupeRetentionMs") ||
            host.getValue("stateSnapshotChunkBytes") >
            host.getValue("stateSnapshotMaxBytes") ||
            host.getValue("stateSnapshotChunkRecords") >
            host.getValue("stateSnapshotMaxRecords") ||
            host.getValue("stateSnapshotIdleLeaseMs") >
            host.getValue("stateSnapshotMaxLifetimeMs") ||
            host.getValue("stateSnapshotMaxPinnedPerPrincipal") >
            host.getValue("stateSnapshotMaxPinnedPerHost") ||
            host.getValue("stateSnapshotPinnedMetadataBytesPerHost") >
            host.getValue("stateSnapshotPinnedBytesPerHost") ||
            host.getValue("terminalMaxFrameBytes") >
            host.getValue("terminalMaxUnackedBytes") ||
            host.getValue("terminalMaxUnackedBytes") >
            host.getValue("terminalReplayBytesPerStream") ||
            host.getValue("terminalReplayBytesPerStream") >
            host.getValue("terminalReplayBytesPerHost")
        ) {
            return null
        }
        return RelayV2NegotiatedLimits(
            maxPublicFrameBytes = minOf(
                RelayV2Codec.PUBLIC_FRAME_BYTES.toLong(),
                broker.getValue("maxFrameBytes"),
            ),
            maxCarrierFrameBytes = minOf(
                RelayV2Codec.CARRIER_FRAME_BYTES.toLong(),
                broker.getValue("maxCarrierFrameBytes"),
            ),
            routeBufferedBytesPerDirection = routeHigh,
            routeLowWaterBytesPerDirection = routeLow,
            maxQueuedRouteFrames = broker.getValue("maxQueuedRouteFrames"),
            maxInFlightRequestsPerRoute = broker.getValue("maxInFlightRequestsPerRoute"),
            maxCommandQueryIds = minOf(32L, host.getValue("maxCommandQueryIds")),
            stateSnapshotChunkBytes = minOf(
                RelayV2Codec.PUBLIC_FRAME_BYTES.toLong(),
                host.getValue("stateSnapshotChunkBytes"),
            ),
            stateSnapshotChunkRecords = host.getValue("stateSnapshotChunkRecords"),
            stateSnapshotMaxBytes = host.getValue("stateSnapshotMaxBytes"),
            stateSnapshotMaxRecords = host.getValue("stateSnapshotMaxRecords"),
            terminalReplayBytesPerStream = host.getValue("terminalReplayBytesPerStream"),
            terminalReplayBytesPerHost = host.getValue("terminalReplayBytesPerHost"),
            terminalMaxUnackedBytes = host.getValue("terminalMaxUnackedBytes"),
            terminalMaxFrameBytes = minOf(65_536L, host.getValue("terminalMaxFrameBytes")),
            frozenHostLimits = host.toMap(),
        )
    }

    private fun failFromStructuredError(error: Map<String, Any?>, rawBytes: Int = 0) {
        val code = error.stringValue("code")
        val retryable = error.booleanValue("retryable")
        val kind = when (code) {
            "AUTH_REQUIRED", "AUTH_INVALID", "PERMISSION_DENIED", "GRANT_NOT_FOUND",
            "ROLE_MISMATCH",
            -> RelayV2FailureKind.AUTH
            "PROTOCOL_UNSUPPORTED", "HOST_DIALECT_UNAVAILABLE" -> RelayV2FailureKind.DIALECT
            "CAPABILITY_UNAVAILABLE" -> RelayV2FailureKind.CAPABILITY
            "INVALID_ENVELOPE", "INVALID_ARGUMENT" -> RelayV2FailureKind.SCHEMA
            else -> RelayV2FailureKind.ROUTE
        }
        val closeCode = when (kind) {
            RelayV2FailureKind.AUTH -> 4403
            RelayV2FailureKind.DIALECT, RelayV2FailureKind.CAPABILITY -> 4406
            RelayV2FailureKind.SCHEMA -> 4400
            else -> 1013
        }
        failConnection(kind, code, retryable, closeCode, rawBytes)
    }

    private fun processTerminal(
        owner: CallbackOwnerKey,
        source: RelayV2Transport?,
    ) {
        beforeTerminalClaim()
        val claim = synchronized(lifecycleLock) {
            claimPendingTerminalLocked(owner, source)
        } ?: return
        completeTerminalClaim(claim)
    }

    private fun processInlineTerminal(cause: TerminalIntentCause) {
        val candidate = synchronized(lifecycleLock) {
            val committed = committedCallbackOwner ?: return@synchronized null
            val source = activeTransport ?: return@synchronized null
            if (!isCurrentCallbackLocked(committed.key, source)) return@synchronized null
            committed.key to source
        } ?: return
        beforeTerminalClaim()
        val claim = synchronized(lifecycleLock) {
            val (owner, source) = candidate
            if (!isCurrentCallbackLocked(owner, source)) return@synchronized null
            recordTerminalIntentLocked(owner, cause)
            claimPendingTerminalLocked(owner, source)
        } ?: return
        completeTerminalClaim(claim)
    }

    private fun claimPendingTerminalLocked(
        owner: CallbackOwnerKey,
        source: RelayV2Transport?,
    ): ClaimedTerminal? {
        if (!isCurrentCallbackLocked(owner, source)) return null
        val pending = pendingTerminalIntent?.takeIf { it.owner == owner } ?: return null
        val terminalCause = pending.cause.takeIf(::isTerminalIntentCurrentLocked)
            ?: pending.fallbackCause?.takeIf(::isTerminalIntentCurrentLocked)
        if (terminalCause == null) {
            pendingTerminalIntent = null
            lastTerminationGeneration.compareAndSet(owner.effectGeneration, null)
            return null
        }
        val profile = activeProfile
        val terminalSource = activeTransport ?: source
        betweenTerminalCauseReadAndOwnerRevoke()
        withdrawPublishedRepositoryAuthorityAndDrainLocked()
        revokeCallbackOwnersLocked()
        activeTransport = null
        pendingTerminalIntent = null
        clearRecoveryAttempt()
        clearPendingAgentExtensionRequests()
        val retirementCommand = terminalSource?.let {
            claimTerminalRetirementLocked(terminalCause, it)
        }
        return ClaimedTerminal(
            cause = terminalCause,
            profile = profile,
            effectGeneration = owner.effectGeneration,
            retirementCommand = retirementCommand,
        )
    }

    private fun completeTerminalClaim(claim: ClaimedTerminal) {
        cancelHandshakeWatchdogs()
        val disposition = terminalDisposition(claim.cause)
        claim.retirementCommand?.execute()
        pendingHelloRequestId = null
        updateState(RelayV2ConnectionPhase.FAILED, claim.profile, disposition.failure)
        emitEffect(
            RelayV2RuntimeEffect.ConnectionFailed(
                claim.profile?.identity,
                claim.effectGeneration,
                disposition.failure,
            ),
            (claim.cause as? TerminalIntentCause.DirectFailure)?.rawBytes ?: 0,
        )
    }

    private fun claimTerminalRetirementLocked(
        cause: TerminalIntentCause,
        source: RelayV2Transport,
    ): TransportRetirementCommand? = when (cause) {
        is TerminalIntentCause.Transport -> when (cause.cause) {
            is TerminationCause.TransportClosed -> {
                if (addTransportFenceLocked(source)) transportRetirements.add(source)
                null
            }
            is TerminationCause.TransportFailed -> claimRetirementLocked(source, closeCode = null)
        }
        is TerminalIntentCause.HandshakeTimeout -> claimRetirementLocked(
            source,
            closeCode = 4408,
            reason = "relay v2 handshake timeout",
        )
        TerminalIntentCause.QueueSaturated -> claimRetirementLocked(
            source,
            closeCode = 1013,
            reason = "relay v2 slow consumer",
        )
        TerminalIntentCause.SourceMismatch -> claimRetirementLocked(
            source,
            closeCode = 1000,
            reason = "relay v2 transport source mismatch",
        )
        is TerminalIntentCause.DirectFailure -> claimRetirementLocked(
            source,
            closeCode = cause.closeCode,
            reason = "relay v2 ${cause.failure.code}",
        )
    }

    private fun terminalDisposition(cause: TerminalIntentCause): TerminalDisposition = when (cause) {
        TerminalIntentCause.SourceMismatch -> TerminalDisposition(sourceMismatchFailure())
        is TerminalIntentCause.HandshakeTimeout -> TerminalDisposition(
            RelayV2ConnectionFailure(
                RelayV2FailureKind.TRANSPORT,
                "HANDSHAKE_TIMEOUT",
                retryable = true,
            ),
        )
        TerminalIntentCause.QueueSaturated -> TerminalDisposition(
            RelayV2ConnectionFailure(
                RelayV2FailureKind.QUEUE_SATURATED,
                "SLOW_CONSUMER",
                retryable = true,
            ),
        )
        is TerminalIntentCause.DirectFailure -> TerminalDisposition(
            cause.failure,
            queueOverridable = cause.failure.kind == RelayV2FailureKind.TRANSPORT &&
                cause.failure.code == "HOST_OFFLINE" &&
                cause.failure.retryable,
        )
        is TerminalIntentCause.Transport -> when (val transport = cause.cause) {
            is TerminationCause.TransportClosed -> transportClosedDisposition(transport.code)
            is TerminationCause.TransportFailed -> transportFailedDisposition(transport.failure)
        }
    }

    private fun isTerminalIntentCurrentLocked(cause: TerminalIntentCause): Boolean = when (cause) {
        is TerminalIntentCause.HandshakeTimeout ->
            _state.value.phase == cause.expectedPhase &&
                (cause.requestId == null || pendingHelloRequestId == cause.requestId)
        else -> true
    }

    private fun transportClosedDisposition(closeCode: Int): TerminalDisposition =
        when (closeCode) {
            1000 -> TerminalDisposition(
                RelayV2ConnectionFailure(RelayV2FailureKind.TRANSPORT, "HOST_OFFLINE", true),
                queueOverridable = true,
            )
            1002, 1007 -> TerminalDisposition(
                RelayV2ConnectionFailure(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false),
            )
            1008 -> TerminalDisposition(
                RelayV2ConnectionFailure(RelayV2FailureKind.SECURITY, "POLICY_VIOLATION", false),
            )
            1009 -> TerminalDisposition(
                RelayV2ConnectionFailure(RelayV2FailureKind.SCHEMA, "FRAME_TOO_LARGE", false),
            )
            1011 -> TerminalDisposition(
                RelayV2ConnectionFailure(RelayV2FailureKind.ROUTE, "SERVER_ERROR", true),
            )
            4400 -> TerminalDisposition(
                RelayV2ConnectionFailure(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false),
            )
            4401 -> TerminalDisposition(
                RelayV2ConnectionFailure(RelayV2FailureKind.AUTH, "AUTH_REQUIRED", false),
            )
            4403 -> TerminalDisposition(
                RelayV2ConnectionFailure(RelayV2FailureKind.AUTH, "AUTH_INVALID", false),
            )
            4406 -> TerminalDisposition(
                RelayV2ConnectionFailure(
                    RelayV2FailureKind.DIALECT,
                    "PROTOCOL_UNSUPPORTED",
                    false,
                ),
            )
            4408 -> TerminalDisposition(
                RelayV2ConnectionFailure(
                    RelayV2FailureKind.TRANSPORT,
                    "HANDSHAKE_TIMEOUT",
                    true,
                ),
            )
            4409 -> TerminalDisposition(
                RelayV2ConnectionFailure(RelayV2FailureKind.ROUTE, "HOST_SUPERSEDED", false),
            )
            4411 -> TerminalDisposition(
                RelayV2ConnectionFailure(
                    RelayV2FailureKind.ROUTE,
                    "DUPLICATE_CONNECTOR",
                    false,
                ),
            )
            in 4000..4999 -> TerminalDisposition(
                RelayV2ConnectionFailure(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false),
            )
            else -> TerminalDisposition(
                RelayV2ConnectionFailure(RelayV2FailureKind.TRANSPORT, "HOST_OFFLINE", true),
            )
        }

    private fun transportFailedDisposition(
        failure: RelayV2TransportFailure,
    ): TerminalDisposition = when (failure.kind) {
        RelayV2TransportFailureKind.PROTOCOL ->
            TerminalDisposition(
                RelayV2ConnectionFailure(
                    RelayV2FailureKind.SCHEMA,
                    "INVALID_ENVELOPE",
                    false,
                ),
            )
        RelayV2TransportFailureKind.TLS_VALIDATION ->
            TerminalDisposition(
                RelayV2ConnectionFailure(
                    RelayV2FailureKind.SECURITY,
                    "TLS_VALIDATION_FAILED",
                    false,
                ),
            )
        RelayV2TransportFailureKind.NETWORK ->
            TerminalDisposition(
                RelayV2ConnectionFailure(
                    RelayV2FailureKind.TRANSPORT,
                    "HOST_OFFLINE",
                    true,
                ),
                queueOverridable = true,
            )
        RelayV2TransportFailureKind.UPGRADE -> when (failure.httpStatus) {
            101 -> TerminalDisposition(
                RelayV2ConnectionFailure(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false),
            )
            401 -> TerminalDisposition(
                RelayV2ConnectionFailure(RelayV2FailureKind.AUTH, "AUTH_REQUIRED", false),
            )
            403 -> TerminalDisposition(
                RelayV2ConnectionFailure(RelayV2FailureKind.AUTH, "PERMISSION_DENIED", false),
            )
            426 -> TerminalDisposition(
                RelayV2ConnectionFailure(
                    RelayV2FailureKind.DIALECT,
                    "PROTOCOL_UNSUPPORTED",
                    false,
                ),
            )
            503 -> TerminalDisposition(
                RelayV2ConnectionFailure(RelayV2FailureKind.ROUTE, "HOST_OFFLINE", true),
            )
            else -> TerminalDisposition(
                RelayV2ConnectionFailure(
                    RelayV2FailureKind.TRANSPORT,
                    "HOST_OFFLINE",
                    true,
                ),
            )
        }
    }

    private suspend fun disconnectNow(action: Action.Disconnect) {
        val current = activeProfile
        if (current != null && current.identity != action.profile) {
            action.completion.completeExceptionally(
                IllegalStateException("Disconnect barrier profile does not own the active v2 actor"),
            )
            return
        }
        cancelHandshakeWatchdogs()
        val fencedGeneration = current?.let(::currentEffectGeneration)
        val preparation = synchronized(lifecycleLock) {
            val applyDrain = withdrawPublishedRepositoryAuthorityAndDrainLocked()
            revokeCallbackOwnersLocked()
            val source = activeTransport
            activeTransport = null
            connectionGeneration += 1
            clearRecoveryAttempt()
            clearPendingAgentExtensionRequests()
            updateState(_state.value.phase, current, _state.value.failure)
            DisconnectPreparation(source, applyDrain)
        }
        afterDisconnectOwnerSeal()
        preparation.source?.let {
            beginRetirement(listOf(it), reason = "profile disconnect barrier")
        }
        val transportTerminated = awaitTransportFences()
        preparation.applyDrain.await()
        if (!transportTerminated) {
            if (isLifecycleOpen()) {
                val failure = RelayV2ConnectionFailure(
                    RelayV2FailureKind.TRANSPORT,
                    "TRANSPORT_TERMINATION_TIMEOUT",
                    retryable = false,
                )
                updateState(RelayV2ConnectionPhase.FAILED, current, failure)
                action.completion.completeExceptionally(
                    IllegalStateException("Relay v2 transport termination timed out"),
                )
            }
            return
        }
        activeProfile = null
        requestedResume = null
        activeConnectPlan = null
        onlineQueryWindow = null
        pendingHelloRequestId = null
        clearRecoveryAttempt()
        brokerEpoch = null
        brokerCapabilities = emptySet()
        brokerLimits = null
        updateState(RelayV2ConnectionPhase.DISCONNECTED, null)
        drainQueuedEffects()
        if (!isLifecycleOpen()) return
        val receipt = RelayProfileDisconnectReceipt(action.profile, action.barrierId)
        emitEffect(
            RelayV2RuntimeEffect.Disconnected(
                action.profile,
                action.barrierId,
                fencedGeneration,
                connectionGeneration,
            ),
        )
        synchronized(lifecycleLock) {
            if (lifecycleState == LifecycleState.OPEN) {
                action.completion.complete(receipt)
            }
        }
    }

    private fun beginRetirement(
        sources: Collection<RelayV2Transport>,
        closeCode: Int? = 1000,
        reason: String = "",
        forceCancel: Boolean = false,
    ) {
        require(!forceCancel || closeCode == null) {
            "Forced Relay v2 retirement cancellation cannot also send close"
        }
        val commands = synchronized(lifecycleLock) {
            sources.mapNotNull { source ->
                claimRetirementLocked(source, closeCode, reason, forceCancel)
            }
        }
        commands.forEach(TransportRetirementCommand::execute)
    }

    private fun claimRetirementLocked(
        source: RelayV2Transport,
        closeCode: Int?,
        reason: String = "",
        forceCancel: Boolean = false,
    ): TransportRetirementCommand? {
        if (!addTransportFenceLocked(source)) return null
        val first = transportRetirements.add(source)
        return when {
            closeCode != null && first -> {
                transportClaimedCloseCodes[source] = closeCode
                TransportRetirementCommand.Close(source, closeCode, reason)
            }
            closeCode != null -> null
            first -> {
                transportCancellations.add(source)
                TransportRetirementCommand.Cancel(source)
            }
            forceCancel && transportCancellations.add(source) ->
                TransportRetirementCommand.Cancel(source)
            else -> null
        }
    }

    private fun isClaimedLocalClose(source: RelayV2Transport, closeCode: Int): Boolean =
        synchronized(lifecycleLock) { transportClaimedCloseCodes[source] == closeCode }

    private fun <T> identitySetOf(): MutableSet<T> =
        Collections.newSetFromMap(IdentityHashMap())

    private fun addTransportFenceLocked(source: RelayV2Transport): Boolean {
        if (source in completedTransportRetirements) return false
        transportFences.add(source)
        return true
    }

    private suspend fun awaitTransportFences(
        requiredSources: Set<RelayV2Transport>? = null,
    ): Boolean {
        val checkedSources = identitySetOf<RelayV2Transport>()
        var allTerminated = true
        synchronized(lifecycleLock) {
            requiredSources?.forEach(::addTransportFenceLocked)
        }
        while (true) {
            var admissionDrain: CompletableDeferred<Unit>? = null
            val source = synchronized(lifecycleLock) {
                transportFences.firstOrNull { checkedSources.add(it) }.also { candidate ->
                    if (candidate == null) {
                        admissionDrain = callbackAdmissions.sealedDrainOrNull()
                    }
                }
            }
            if (source == null) {
                val drain = admissionDrain ?: return allTerminated
                drain.await()
                continue
            }
            if (!source.awaitTermination()) {
                beginRetirement(listOf(source), closeCode = null, forceCancel = true)
                allTerminated = false
                continue
            }
            synchronized(lifecycleLock) {
                transportFences.remove(source)
                if (source in transportRetirements) {
                    completedTransportRetirements.add(source)
                    clearCompletedRetirementIfDrainedLocked(source)
                }
            }
        }
    }

    private fun releaseQueuedTransportCallback(action: Action) {
        synchronized(lifecycleLock) {
            when (action) {
                is Action.TransportOpened -> releaseQueuedTransportCallbackLocked(action.source)
                is Action.TransportFrame -> releaseQueuedTransportCallbackLocked(action.source)
                is Action.TransportFrameTooLarge ->
                    releaseQueuedTransportCallbackLocked(action.source)
                is Action.TransportSourceMismatch ->
                    releaseTerminalCallbackLeasesLocked(action.owner)
                is Action.TerminateConnection -> releaseTerminalCallbackLeasesLocked(action.owner)
                is Action.QueueSaturated -> releaseTerminalCallbackLeasesLocked(action.owner)
                is Action.HandshakeTimedOut -> releaseTerminalCallbackLeasesLocked(action.owner)
                is Action.RecoveryStepTimedOut -> Unit
                else -> Unit
            }
        }
    }

    private fun releaseQueuedTransportCallbackLocked(source: RelayV2Transport) {
        val count = checkNotNull(queuedTransportCallbacks[source]) {
            "Relay v2 queued callback ownership underflow"
        }
        if (count == 1) {
            queuedTransportCallbacks.remove(source)
            clearCompletedRetirementIfDrainedLocked(source)
        } else {
            queuedTransportCallbacks[source] = count - 1
        }
    }

    private fun clearCompletedRetirementIfDrainedLocked(source: RelayV2Transport) {
        if (queuedTransportCallbacks.containsKey(source) ||
            callbackAdmissions.hasPendingSealedAdmissions() ||
            !completedTransportRetirements.remove(source)
        ) {
            return
        }
        transportFences.remove(source)
        transportRetirements.remove(source)
        transportCancellations.remove(source)
        transportClaimedCloseCodes.remove(source)
    }

    private fun clearDrainedCompletedRetirementsLocked() {
        if (callbackAdmissions.hasPendingSealedAdmissions()) return
        completedTransportRetirements.toList().forEach(::clearCompletedRetirementIfDrainedLocked)
    }

    private fun failConnection(
        failure: RelayV2ConnectionFailure,
        closeCode: Int?,
    ) = failConnection(
        failure.kind,
        failure.code,
        failure.retryable,
        closeCode,
    )

    private fun failConnection(
        kind: RelayV2FailureKind,
        code: String,
        retryable: Boolean,
        closeCode: Int?,
        rawBytes: Int = 0,
    ) {
        processInlineTerminal(
            TerminalIntentCause.DirectFailure(
                failure = RelayV2ConnectionFailure(kind, code, retryable),
                closeCode = closeCode,
                rawBytes = rawBytes,
            ),
        )
    }

    private fun emitEffect(effect: RelayV2RuntimeEffect, rawBytes: Int = 0): Boolean {
        if (!reserveBytes(queuedEffectBytes, rawBytes, effectByteCapacity)) {
            failEffectQueue()
            return false
        }
        if (effectChannel.trySend(QueuedEffect(effect, rawBytes)).isSuccess) return true
        releaseBytes(queuedEffectBytes, rawBytes)
        failEffectQueue()
        return false
    }

    private fun emitAgentExtensionDelivery(
        effect: RelayV2RuntimeEffect.DeliverAgentExtensionFrame,
        admission: AgentTranscriptLifecycleRequestAdmission?,
    ): Boolean {
        val rawBytes = effect.artifact.rawUtf8ByteCount
        if (admission == null) {
            val reserved = reserveBytes(
                queuedAgentExtensionEffectBytes,
                rawBytes,
                extensionEffectByteCapacity,
            )
            if (reserved &&
                agentExtensionEffectChannel.trySend(QueuedEffect(effect, rawBytes)).isSuccess
            ) return true
            if (reserved) releaseBytes(queuedAgentExtensionEffectBytes, rawBytes)
            isolateAgentExtension(RelayV2AgentExtensionUnavailableReason.EFFECT_QUEUE_SATURATED)
            return false
        }

        val enqueued = synchronized(lifecycleLock) {
            val pending = pendingAgentExtensionRequests[admission.requestId]
            if (pending?.admission != admission ||
                pending.state != AgentExtensionPendingState.SENT
            ) return@synchronized false
            pending.watchdog?.cancel()
            pending.watchdog = null
            if (!reserveBytes(
                    queuedAgentExtensionEffectBytes,
                    rawBytes,
                    extensionEffectByteCapacity,
                )
            ) return@synchronized false
            pending.state = AgentExtensionPendingState.HANDOFF_QUEUED
            pending.delivery = PendingAgentExtensionDelivery(
                effect = effect,
                rawBytes = rawBytes,
                ownsByteReservation = true,
            )
            if (enqueueAgentExtensionDeliveryLocked(pending)) {
                true
            } else {
                releasePendingAgentExtensionDeliveryBytesLocked(pending)
                pending.delivery = null
                pending.state = AgentExtensionPendingState.SENT
                false
            }
        }
        if (enqueued) return true
        requestAgentExtensionRetry(
            admission,
            RelayV2AgentExtensionUnavailableReason.EFFECT_QUEUE_SATURATED,
        )
        return false
    }

    private fun emitAgentExtensionControlEffect(effect: RelayV2RuntimeEffect): Boolean {
        val result = agentExtensionControlEffectChannel.trySend(QueuedEffect(effect, 0))
        if (result.isSuccess) return true
        // One already-queued unavailable effect is a bounded coalesced handoff for the lane.
        return !result.isClosed && !resourcesClosed.get()
    }

    private fun enqueueAgentExtensionDeliveryLocked(
        pending: PendingAgentExtensionRequest,
    ): Boolean {
        val delivery = pending.delivery ?: return false
        if (delivery.state != AgentExtensionDeliveryState.READY_TO_EMIT &&
            delivery.state != AgentExtensionDeliveryState.DELIVERED
        ) return false
        val queued = QueuedEffect(
            effect = delivery.effect,
            rawBytes = delivery.rawBytes,
            deliveryAdmission = pending.admission,
        )
        val accepted = agentExtensionHandoffEffectChannel.trySend(queued).isSuccess
        if (accepted) delivery.state = AgentExtensionDeliveryState.QUEUED
        return accepted
    }

    private fun releasePendingAgentExtensionDeliveryBytesLocked(
        pending: PendingAgentExtensionRequest,
    ) {
        val delivery = pending.delivery ?: return
        if (!delivery.ownsByteReservation) return
        delivery.ownsByteReservation = false
        releaseBytes(queuedAgentExtensionEffectBytes, delivery.rawBytes)
    }

    private fun removeQueuedAgentExtensionDeliveriesLocked(
        admissions: Set<AgentTranscriptLifecycleRequestAdmission>,
    ) {
        if (admissions.isEmpty()) return
        val retained = ArrayDeque<QueuedEffect>(MAX_PENDING_AGENT_EXTENSION_REQUESTS)
        while (true) {
            val queued = agentExtensionHandoffEffectChannel.tryReceive().getOrNull() ?: break
            if (queued.deliveryAdmission !in admissions) retained.addLast(queued)
        }
        retained.forEach { queued ->
            check(agentExtensionHandoffEffectChannel.trySend(queued).isSuccess) {
                "Correlated handoff FIFO restore capacity invariant violated"
            }
        }
    }

    private fun failEffectQueue() {
        if (!resourcesClosed.get()) {
            processInlineTerminal(TerminalIntentCause.QueueSaturated)
        }
    }

    private fun drainQueuedEffects() {
        drainQueuedEffects(effectChannel, queuedEffectBytes)
        drainQueuedEffects(agentExtensionEffectChannel, queuedAgentExtensionEffectBytes)
        drainQueuedEffects(agentExtensionHandoffEffectChannel, null)
        drainQueuedEffects(agentExtensionControlEffectChannel, null)
    }

    private fun drainQueuedEffects(channel: Channel<QueuedEffect>, counter: AtomicLong?) {
        while (true) {
            val queued = channel.tryReceive().getOrNull() ?: return
            counter?.let { releaseBytes(it, queued.rawBytes) }
        }
    }

    /**
     * Directly arbitrates the four bounded producer lanes without an intermediate Flow buffer.
     * A correlated emit therefore remains in flight until the downstream collector returns, so
     * its durable ACK can atomically retire the actor-owned artifact before this method requeues.
     */
    private fun multiplexedEffectFlow(): Flow<RelayV2RuntimeEffect> = flow {
        val sources = listOf(
            QueuedEffectSource(effectChannel, queuedEffectBytes),
            QueuedEffectSource(agentExtensionControlEffectChannel, null),
            QueuedEffectSource(agentExtensionEffectChannel, queuedAgentExtensionEffectBytes),
            QueuedEffectSource(agentExtensionHandoffEffectChannel, null, correlatedHandoff = true),
        )
        val openSources = BooleanArray(sources.size) { true }
        var nextSourceIndex = 0

        while (openSources.any { it }) {
            var selected: SelectedQueuedEffect? = null
            repeat(sources.size) { offset ->
                if (selected != null) return@repeat
                val sourceIndex = (nextSourceIndex + offset) % sources.size
                if (!openSources[sourceIndex]) return@repeat
                val result = sources[sourceIndex].channel.tryReceive()
                when {
                    result.isSuccess -> selected = SelectedQueuedEffect(
                        sourceIndex,
                        result.getOrThrow(),
                    )
                    result.isClosed -> openSources[sourceIndex] = false
                }
            }
            if (selected == null && openSources.any { it }) {
                selected = select {
                    repeat(sources.size) { offset ->
                        val sourceIndex = (nextSourceIndex + offset) % sources.size
                        if (!openSources[sourceIndex]) return@repeat
                        sources[sourceIndex].channel.onReceiveCatching { result ->
                            if (result.isClosed) {
                                openSources[sourceIndex] = false
                                null
                            } else {
                                SelectedQueuedEffect(sourceIndex, result.getOrThrow())
                            }
                        }
                    }
                }
            }
            val delivery = selected ?: continue
            nextSourceIndex = (delivery.sourceIndex + 1) % sources.size
            val source = sources[delivery.sourceIndex]
            val queued = delivery.queued
            if (source.correlatedHandoff) {
                val admission = requireNotNull(queued.deliveryAdmission)
                val claimed = claimAgentExtensionDelivery(admission, queued.effect)
                try {
                    if (claimed) emit(queued.effect)
                } finally {
                    if (claimed) requeueUnacknowledgedAgentExtensionDelivery(
                        admission,
                        queued.effect,
                    )
                }
            } else {
                try {
                    emit(queued.effect)
                } finally {
                    source.byteCounter?.let { releaseBytes(it, queued.rawBytes) }
                }
            }
        }
    }

    private fun claimAgentExtensionDelivery(
        admission: AgentTranscriptLifecycleRequestAdmission,
        effect: RelayV2RuntimeEffect,
    ): Boolean = synchronized(lifecycleLock) {
        val pending = pendingAgentExtensionRequests[admission.requestId]
            ?: return@synchronized false
        val delivery = pending.delivery ?: return@synchronized false
        if (pending.admission != admission ||
            pending.state != AgentExtensionPendingState.HANDOFF_QUEUED ||
            delivery.effect !== effect ||
            delivery.state != AgentExtensionDeliveryState.QUEUED
        ) return@synchronized false
        delivery.state = AgentExtensionDeliveryState.IN_FLIGHT
        true
    }

    private fun requeueUnacknowledgedAgentExtensionDelivery(
        admission: AgentTranscriptLifecycleRequestAdmission,
        effect: RelayV2RuntimeEffect,
    ) {
        synchronized(lifecycleLock) {
            val pending = pendingAgentExtensionRequests[admission.requestId]
                ?: return@synchronized
            val delivery = pending.delivery ?: return@synchronized
            if (pending.admission != admission ||
                pending.state != AgentExtensionPendingState.HANDOFF_QUEUED ||
                delivery.effect !== effect ||
                delivery.state != AgentExtensionDeliveryState.IN_FLIGHT
            ) return@synchronized
            delivery.state = AgentExtensionDeliveryState.DELIVERED
            check(enqueueAgentExtensionDeliveryLocked(pending)) {
                "Correlated handoff requeue capacity invariant violated"
            }
        }
    }

    private fun currentEffectGeneration(profile: RelayV2Profile): RelayV2EffectGeneration =
        RelayV2EffectGeneration(
            profileId = profile.profileId,
            profileGeneration = profile.activationGeneration,
            connectionGeneration = connectionGeneration,
        )

    private fun reserveBytes(counter: AtomicLong, bytes: Int, capacity: Long): Boolean {
        if (bytes == 0) return true
        while (true) {
            val current = counter.get()
            if (bytes.toLong() > capacity - current) return false
            if (counter.compareAndSet(current, current + bytes)) return true
        }
    }

    private fun releaseBytes(counter: AtomicLong, bytes: Int) {
        if (bytes == 0) return
        check(counter.addAndGet(-bytes.toLong()) >= 0) { "Relay v2 queue byte accounting underflow" }
    }

    private fun updateState(
        phase: RelayV2ConnectionPhase,
        profile: RelayV2Profile?,
        failure: RelayV2ConnectionFailure? = null,
    ) {
        synchronized(lifecycleLock) { withdrawOutboxExecuteReadyLocked() }
        publishState(phase, profile, failure)
    }

    private fun enterOnlineIfCurrent(
        context: RelayV2HandshakeContext,
        generation: RelayV2EffectGeneration,
        profile: RelayV2Profile?,
    ): RelayV2RepositoryEffectAuthority? = synchronized(lifecycleLock) {
        val currentProfile = profile ?: return@synchronized null
        val committed = committedCallbackOwner ?: return@synchronized null
        val source = activeTransport ?: return@synchronized null
        val authority = context.repositoryEffectAuthority(generation)
        if (activeProfile != currentProfile ||
            onlineContext != context ||
            committed.effectGeneration != generation ||
            publishedEffectGeneration.get() != generation ||
            !isCurrentCallbackLocked(committed.key, source) ||
            currentProfile.identity != context.profile ||
            currentProfile.principalId != context.principalId ||
            currentProfile.clientInstanceId != context.clientInstanceId ||
            currentProfile.hostId != context.hostId
        ) {
            return@synchronized null
        }
        outboxExecuteReadyCut = OutboxExecuteReadyCut(
            authority = authority,
            owner = committed.key,
            source = source,
        )
        publishState(RelayV2ConnectionPhase.ONLINE, currentProfile)
        authority
    }

    private fun publishState(
        phase: RelayV2ConnectionPhase,
        profile: RelayV2Profile?,
        failure: RelayV2ConnectionFailure? = null,
    ) {
        _state.value = RelayV2ConnectionState(
            phase = phase,
            profileId = profile?.profileId,
            activationGeneration = profile?.activationGeneration,
            connectionGeneration = connectionGeneration,
            changedAtMs = clock(),
            failure = failure,
        )
    }

    private fun isLifecycleOpen(): Boolean = synchronized(lifecycleLock) {
        lifecycleState == LifecycleState.OPEN
    }

    private fun currentCallbackOwnerKeyLocked(): CallbackOwnerKey? =
        committedCallbackOwner?.key
            ?: provisionalCallbackOwner
                ?.takeIf { isConnectTokenCurrentLocked(it.connectToken) }
                ?.key

    private fun acceptsCallbackLocked(
        owner: CallbackOwnerKey,
        source: RelayV2Transport?,
    ): Boolean {
        val committed = committedCallbackOwner
        if (committed?.key == owner && (source == null || committed.source === source)) {
            return true
        }
        val provisional = provisionalCallbackOwner
        return provisional?.key == owner &&
            isConnectTokenCurrentLocked(provisional.connectToken) &&
            (source == null ||
                (provisional.callbackSource ?: provisional.factorySource) === source)
    }

    private fun isCurrentCallback(
        owner: CallbackOwnerKey,
        source: RelayV2Transport?,
    ): Boolean = synchronized(lifecycleLock) {
        isCurrentCallbackLocked(owner, source)
    }

    private fun isCurrentCallbackLocked(
        owner: CallbackOwnerKey,
        source: RelayV2Transport?,
    ): Boolean {
        val committed = committedCallbackOwner ?: return false
        return lifecycleState == LifecycleState.OPEN &&
            committed.key == owner &&
            publishedEffectGeneration.get() == owner.effectGeneration &&
            owner.effectGeneration.connectionGeneration == connectionGeneration &&
            (source == null || committed.source === source) &&
            (source == null || activeTransport === source)
    }

    private fun invalidateConnectionOwnershipAndDrain(): CompletableDeferred<Unit> =
        synchronized(lifecycleLock) {
            val applyDrain = withdrawPublishedRepositoryAuthorityAndDrainLocked()
            revokeCallbackOwnersLocked()
            applyDrain
        }

    private fun clearPublishedEffectAuthorityLocked() {
        withdrawOutboxExecuteReadyLocked()
        onlineContext = null
        agentExtensionSendFence.set(null)
        publishedEffectGeneration.set(null)
    }

    private fun withdrawPublishedRepositoryAuthorityAndDrainLocked(): CompletableDeferred<Unit> {
        clearPublishedEffectAuthorityLocked()
        return effectApplyGate.invalidateAndDrain()
    }

    private fun revokeCallbackOwnersLocked() {
        withdrawOutboxExecuteReadyLocked()
        provisionalCallbackOwner?.let { callbackAdmissions.sealThrough(it.key) }
        committedCallbackOwner?.let { callbackAdmissions.sealThrough(it.key) }
        provisionalCallbackOwner = null
        committedCallbackOwner = null
    }

    private fun withdrawOutboxExecuteReadyLocked() {
        outboxExecuteReadyCut = null
    }

    private fun activateEffectGenerationIfCurrent(
        context: RelayV2HandshakeContext,
        generation: RelayV2EffectGeneration,
    ): Boolean = synchronized(lifecycleLock) {
        val committed = committedCallbackOwner
        if (lifecycleState != LifecycleState.OPEN ||
            committed?.effectGeneration != generation ||
            publishedEffectGeneration.get() != generation ||
            activeProfile?.identity != context.profile ||
            activeProfile?.principalId != context.principalId ||
            activeProfile?.clientInstanceId != context.clientInstanceId ||
            activeProfile?.hostId != context.hostId
        ) {
            return@synchronized false
        }
        val repositoryAuthority = context.repositoryEffectAuthority(generation)
        effectApplyGate.activate(generation, repositoryAuthority)
        val fence = AgentExtensionSendFence(
            repositoryAuthority,
            context.negotiatedCapabilities.toSet(),
        )
        onlineContext = context
        publishedEffectGeneration.set(generation)
        agentExtensionSendFence.set(fence)
        true
    }

    private suspend fun shutdownNow() {
        cancelHandshakeWatchdogs()
        val applyDrain = invalidateConnectionOwnershipAndDrain()
        val source = activeTransport
        activeTransport = null
        connectionGeneration += 1
        clearRecoveryAttempt()
        clearPendingAgentExtensionRequests()
        source?.let {
            beginRetirement(listOf(it), closeCode = null, forceCancel = true)
        }
        val transportTerminated = awaitTransportFences()
        applyDrain.await()
        if (!transportTerminated) {
            finishResources()
            return
        }
        activeProfile = null
        onlineQueryWindow = null
        updateState(RelayV2ConnectionPhase.CLOSED, null)
        drainQueuedEffects()
        completeShutdownDrain()
        finishResources()
    }

    private fun completeShutdownDrain() {
        val completion = synchronized(lifecycleLock) {
            check(lifecycleState == LifecycleState.SHUTTING_DOWN) {
                "Relay v2 shutdown completed outside SHUTTING_DOWN"
            }
            val shutdown = checkNotNull(shutdownDrainCompletion) {
                "Relay v2 shutdown drain was not created"
            }
            lifecycleState = LifecycleState.CLOSED
            val barriers = pendingBarriers.toMap()
            pendingBarriers.clear()
            ShutdownCompletion(shutdown, barriers)
        }
        completion.shutdownDrain.complete(Unit)
        completion.barriers.forEach { (barrier, receipt) -> barrier.complete(receipt) }
    }

    private fun finishResources() {
        if (!resourcesClosed.compareAndSet(false, true)) return
        val incomplete = synchronized(lifecycleLock) {
            activeConnectToken = null
            revokeCallbackOwnersLocked()
            lifecycleState = LifecycleState.CLOSED
            val shutdown = shutdownDrainCompletion?.takeUnless { it.isCompleted }
            val barriers = pendingBarriers.keys.toList()
            pendingBarriers.clear()
            shutdown to barriers
        }
        incomplete.first?.completeExceptionally(
            CancellationException("Relay v2 actor stopped before shutdown drain completed"),
        )
        incomplete.second.forEach {
            it.completeExceptionally(CancellationException("Relay v2 actor stopped"))
        }
        actions.close()
        agentExtensionActions.close()
        drainQueuedAgentExtensionActions()
        drainQueuedEffects()
        effectChannel.close()
        agentExtensionEffectChannel.close()
        agentExtensionHandoffEffectChannel.close()
        agentExtensionControlEffectChannel.close()
        scope.cancel()
        actorDispatcher.close()
    }

    private fun drainQueuedAgentExtensionActions() {
        while (true) {
            val action = agentExtensionActions.tryReceive().getOrNull() ?: return
            releaseBytes(queuedAgentExtensionActionBytes, action.rawBytes)
        }
    }

    private sealed interface Action {
        val rawBytes: Int
            get() = 0

        data class Connect(
            val profile: RelayV2Profile,
        ) : Action

        data class Disconnect(
            val profile: RelayActiveProfileIdentity,
            val barrierId: String,
            val completion: CompletableDeferred<RelayProfileDisconnectReceipt>,
        ) : Action

        data class TransportOpened(
            val ownerTokenId: Long,
            val effectGeneration: RelayV2EffectGeneration,
            val source: RelayV2Transport,
            val selectedSubprotocol: String?,
        ) : Action {
            val owner = CallbackOwnerKey(ownerTokenId, effectGeneration)
        }

        data class TransportFrame(
            val ownerTokenId: Long,
            val effectGeneration: RelayV2EffectGeneration,
            val source: RelayV2Transport,
            val bytes: ByteArray,
            val metadata: RelayV2FrameMetadata,
        ) : Action {
            val owner = CallbackOwnerKey(ownerTokenId, effectGeneration)
            override val rawBytes: Int = bytes.size
        }

        data class TransportFrameTooLarge(
            val ownerTokenId: Long,
            val effectGeneration: RelayV2EffectGeneration,
            val source: RelayV2Transport,
        ) : Action {
            val owner = CallbackOwnerKey(ownerTokenId, effectGeneration)
        }

        data class TransportSourceMismatch(
            val ownerTokenId: Long,
            val effectGeneration: RelayV2EffectGeneration,
            val source: RelayV2Transport,
        ) : Action {
            val owner = CallbackOwnerKey(ownerTokenId, effectGeneration)
        }

        data class TerminateConnection(
            val ownerTokenId: Long,
            val effectGeneration: RelayV2EffectGeneration,
            val source: RelayV2Transport,
            val cause: TerminationCause,
        ) : Action {
            val owner = CallbackOwnerKey(ownerTokenId, effectGeneration)
        }

        data class QueueSaturated(
            val ownerTokenId: Long,
            val effectGeneration: RelayV2EffectGeneration,
            val source: RelayV2Transport?,
        ) : Action {
            val owner = CallbackOwnerKey(ownerTokenId, effectGeneration)
        }

        data class HandshakeTimedOut(
            val ownerTokenId: Long,
            val effectGeneration: RelayV2EffectGeneration,
            val source: RelayV2Transport,
            val expectedPhase: RelayV2ConnectionPhase,
            val requestId: String?,
        ) : Action {
            val owner = CallbackOwnerKey(ownerTokenId, effectGeneration)
        }

        data class RecoveryReceipt(
            val receipt: RelayV2RecoveryReceipt,
            val completion: CompletableDeferred<RelayV2RecoveryReceiptProcessingResult>?,
        ) : Action {
            override val rawBytes: Int = receipt.estimatedRawBytes()
        }

        data class OnlineResyncRequired(
            val receipt: RelayV2OnlineResyncRequired,
        ) : Action {
            override val rawBytes: Int = receipt.estimatedRawBytes()
        }

        data class RecoveryStepTimedOut(
            val ownerTokenId: Long,
            val effectGeneration: RelayV2EffectGeneration,
            val source: RelayV2Transport,
            val binding: RelayV2RecoveryBinding,
            val expectedStage: RecoveryStage,
        ) : Action {
            val owner = CallbackOwnerKey(ownerTokenId, effectGeneration)
        }

        data object Shutdown : Action
    }

    private sealed interface TerminationCause {
        data class TransportClosed(val code: Int) : TerminationCause
        data class TransportFailed(val failure: RelayV2TransportFailure) : TerminationCause
    }

    private data class PendingTerminalIntent(
        val owner: CallbackOwnerKey,
        var cause: TerminalIntentCause,
        var fallbackCause: TerminalIntentCause? = null,
    )

    private data class AgentExtensionSendFence(
        val authority: RelayV2RepositoryEffectAuthority,
        val negotiatedCapabilities: Set<String>,
    )

    private data class OutboxExecuteReadyCut(
        val authority: RelayV2RepositoryEffectAuthority,
        val owner: CallbackOwnerKey,
        val source: RelayV2Transport,
    )

    private class ActorCurrentRepositoryReadCut(
        val originActor: RelayV2ConnectionActor,
        val originFence: AgentExtensionSendFence,
        override val authority: RelayV2RepositoryEffectAuthority,
        override val capability: RelayV2RepositoryReadCapability,
    ) : RelayV2CurrentRepositoryReadCut

    private data class ClaimedTerminal(
        val cause: TerminalIntentCause,
        val profile: RelayV2Profile?,
        val effectGeneration: RelayV2EffectGeneration,
        val retirementCommand: TransportRetirementCommand?,
    )

    private sealed class TransportRetirementCommand {
        abstract val source: RelayV2Transport

        data class Close(
            override val source: RelayV2Transport,
            val code: Int,
            val reason: String,
        ) : TransportRetirementCommand()

        data class Cancel(
            override val source: RelayV2Transport,
        ) : TransportRetirementCommand()

        fun execute() {
            when (this) {
                is Close -> source.close(code, reason)
                is Cancel -> source.cancel()
            }
        }
    }

    private data class TerminalDisposition(
        val failure: RelayV2ConnectionFailure,
        val queueOverridable: Boolean = false,
    )

    private sealed interface TerminalIntentCause {
        data class Transport(val cause: TerminationCause) : TerminalIntentCause
        data class DirectFailure(
            val failure: RelayV2ConnectionFailure,
            val closeCode: Int?,
            val rawBytes: Int,
        ) : TerminalIntentCause
        data class HandshakeTimeout(
            val expectedPhase: RelayV2ConnectionPhase,
            val requestId: String?,
        ) : TerminalIntentCause
        data object QueueSaturated : TerminalIntentCause
        data object SourceMismatch : TerminalIntentCause
    }

    private data class QueuedEffect(
        val effect: RelayV2RuntimeEffect,
        val rawBytes: Int,
        val deliveryAdmission: AgentTranscriptLifecycleRequestAdmission? = null,
    )

    private data class QueuedEffectSource(
        val channel: Channel<QueuedEffect>,
        val byteCounter: AtomicLong?,
        val correlatedHandoff: Boolean = false,
    )

    private data class SelectedQueuedEffect(
        val sourceIndex: Int,
        val queued: QueuedEffect,
    )

    private data class ResolvedAgentExtensionIngress(
        val ingress: AgentTranscriptLifecycleTrustedIngress,
        val admission: AgentTranscriptLifecycleRequestAdmission?,
    )

    private data class PendingAgentExtensionRequest(
        val request: AgentTranscriptLifecycleActorRequest,
        val admission: AgentTranscriptLifecycleRequestAdmission,
        var state: AgentExtensionPendingState = AgentExtensionPendingState.QUEUED,
        var watchdog: Job? = null,
        var delivery: PendingAgentExtensionDelivery? = null,
    )

    private data class RetiredAgentExtensionRequestIdentity(
        val authority: RelayV2RepositoryEffectAuthority,
        val requestKind: AgentTranscriptLifecycleRequestKind,
        val requestId: String,
        val scopeId: String,
        val sessionId: String,
    )

    private data class AgentExtensionOverlappingErrorOwner(
        val identity: RetiredAgentExtensionRequestIdentity,
        val uncorrelatedOnly: Boolean,
    )

    private data class PendingAgentExtensionDelivery(
        val effect: RelayV2RuntimeEffect,
        val rawBytes: Int,
        var ownsByteReservation: Boolean = false,
        var state: AgentExtensionDeliveryState = AgentExtensionDeliveryState.READY_TO_EMIT,
    )

    private enum class AgentExtensionDeliveryState {
        READY_TO_EMIT,
        QUEUED,
        IN_FLIGHT,
        DELIVERED,
    }

    private data class SendAgentExtensionRequestAction(
        val request: AgentTranscriptLifecycleActorRequest,
        val admission: AgentTranscriptLifecycleRequestAdmission,
        val bytes: ByteArray,
    ) {
        val rawBytes: Int = bytes.size
    }

    private enum class AgentExtensionPendingState {
        QUEUED,
        SENT,
        HANDOFF_QUEUED,
    }

    private data class ShutdownCompletion(
        val shutdownDrain: CompletableDeferred<Unit>,
        val barriers: Map<
            CompletableDeferred<RelayProfileDisconnectReceipt>,
            RelayProfileDisconnectReceipt,
            >,
    )

    private data class ConnectToken(
        val id: Long,
        val profileId: String,
        val activationGeneration: Long,
    )

    private data class ConnectPreparation(
        val previousTransport: RelayV2Transport?,
        val connectionGeneration: Long,
        val applyDrain: CompletableDeferred<Unit>,
    )

    private data class DisconnectPreparation(
        val source: RelayV2Transport?,
        val applyDrain: CompletableDeferred<Unit>,
    )

    private class RecoveryAttempt(
        val context: RelayV2HandshakeContext,
        val outcome: RelayV2HelloOutcome,
        val connectPlan: RelayV2ConnectPlan,
        val generation: RelayV2EffectGeneration,
        val helloRequestId: String,
        var step: Long,
        var stage: RecoveryStage,
    ) {
        var pendingCommands: List<RelayV2PendingCommand> = emptyList()
        var nextCommandIndex: Int = 0
        var commandRequest: CommandQueryRequest? = null
        var snapshotRequest: SnapshotRequest? = null
        var snapshotChunkResponse: SnapshotChunkResponse? = null
        var releaseRequest: SnapshotReleaseRequest? = null
        var releaseFollowUp: ReleaseFollowUp? = null
        var sourceCompletedReleaseBinding: RelayV2RecoveryBinding? = null
        var queryWindowLineage: RelayV2QueryRecoveryLineage? = null
        val queryWindowEffectBindings = linkedSetOf<RelayV2RecoveryBinding>()

        val pendingRequestId: String?
            get() = commandRequest?.binding?.requestId
                ?: snapshotRequest?.binding?.requestId
                ?: releaseRequest?.binding?.requestId

        fun currentBinding(): RelayV2RecoveryBinding? = when (stage) {
            RecoveryStage.AWAITING_HELLO_RECEIPT ->
                RelayV2RecoveryBinding(generation, step, helloRequestId)
            RecoveryStage.AWAITING_COMMAND_QUERY_COMMIT,
            RecoveryStage.AWAITING_COMMAND_RESPONSE,
            RecoveryStage.AWAITING_COMMAND_RECEIPT,
            -> commandRequest?.binding
            RecoveryStage.AWAITING_SNAPSHOT_RESPONSE,
            RecoveryStage.AWAITING_SNAPSHOT_RECEIPT,
            -> snapshotRequest?.binding
            RecoveryStage.AWAITING_RELEASE_RESPONSE,
            RecoveryStage.AWAITING_RELEASE_RECEIPT,
            -> releaseRequest?.binding
        }

        fun completedReleaseBindingForStateEvent(): RelayV2RecoveryBinding? =
            sourceCompletedReleaseBinding ?: if (stage == RecoveryStage.AWAITING_RELEASE_RECEIPT) {
                releaseRequest?.binding
            } else {
                null
            }

        fun armQueryWindow(originBinding: RelayV2RecoveryBinding) {
            require(originBinding.generation == generation)
            if (queryWindowLineage == null) {
                queryWindowLineage = RelayV2QueryRecoveryLineage(generation, helloRequestId)
            }
            queryWindowEffectBindings += originBinding
            check(queryWindowEffectBindings.size <= MAX_QUERY_WINDOW_BINDINGS)
        }

        fun clearQueryWindow() {
            queryWindowLineage = null
            queryWindowEffectBindings.clear()
            sourceCompletedReleaseBinding = null
        }
    }

    private data class OnlineQueryWindow(
        val lineage: RelayV2QueryRecoveryLineage,
        val effectBindings: Set<RelayV2RecoveryBinding>,
        val completedReleaseBinding: RelayV2RecoveryBinding?,
    )

    private data class CommandQueryRequest(
        val binding: RelayV2RecoveryBinding,
        val commandBatch: RelayV2CommandQueryBatch,
    ) {
        val commands: List<RelayV2PendingCommand>
            get() = commandBatch.commands
    }

    private data class SnapshotRequest(
        val binding: RelayV2RecoveryBinding,
        val snapshotRequestId: String,
        val snapshotId: String?,
        val cursor: String?,
        val nextChunkIndex: Long,
    )

    private data class SnapshotChunkResponse(
        val snapshotRequestId: String,
        val snapshotId: String,
        val chunkIndex: Long,
        val isLast: Boolean,
        val nextCursor: String?,
    )

    private data class SnapshotReleaseRequest(
        val binding: RelayV2RecoveryBinding,
        val release: RelayV2RecoveryReleaseDirective,
    ) {
        val snapshotRequestId: String get() = release.snapshotRequestId
        val snapshotId: String get() = release.snapshotId
    }

    private sealed interface ReleaseFollowUp {
        data object QueryPendingCommands : ReleaseFollowUp

        data class RestartAfterAbandon(
            val directive: RelayV2RecoveryRestartDirective,
        ) : ReleaseFollowUp
    }

    private enum class RecoveryStage {
        AWAITING_HELLO_RECEIPT,
        AWAITING_COMMAND_QUERY_COMMIT,
        AWAITING_COMMAND_RESPONSE,
        AWAITING_COMMAND_RECEIPT,
        AWAITING_SNAPSHOT_RESPONSE,
        AWAITING_SNAPSHOT_RECEIPT,
        AWAITING_RELEASE_RESPONSE,
        AWAITING_RELEASE_RECEIPT,
    }

    private enum class RecoverySendResult { SENT, STALE, FAILED }

    private enum class RecoveryResponseKind {
        COMMAND_STATUSES,
        SNAPSHOT_CHUNK,
        SNAPSHOT_RELEASED,
        SNAPSHOT_EXPIRED,
    }

    private data class CompletedRecoveryResponse(
        val requestId: String,
        val kind: RecoveryResponseKind,
        val hostId: String?,
        val hostEpoch: String?,
        val fingerprint: String,
    )

    private data class CallbackOwnerKey(
        val connectTokenId: Long,
        val effectGeneration: RelayV2EffectGeneration,
    )

    private class ProvisionalCallbackOwner(
        val connectToken: ConnectToken,
        val effectGeneration: RelayV2EffectGeneration,
        val phase: CallbackOwnerPhase,
    ) {
        val key = CallbackOwnerKey(connectToken.id, effectGeneration)
        var callbackSource: RelayV2Transport? = null
        var factorySource: RelayV2Transport? = null
        var sourceMismatch: Boolean = false
        var factorySourceResolved: Boolean = false
        var postSealCallbackSeen: Boolean = false
        var postSealRetiredSource: RelayV2Transport? = null
    }

    private data class CommittedCallbackOwner(
        val connectTokenId: Long,
        val effectGeneration: RelayV2EffectGeneration,
        val source: RelayV2Transport,
    ) {
        val key = CallbackOwnerKey(connectTokenId, effectGeneration)
    }

    private enum class CallbackOwnerPhase { OPENING }
    private enum class FactorySourceBinding { MATCHED, MISMATCH, STALE }
    private enum class TransportCommitResult { COMMITTED, SOURCE_MISMATCH, STALE }

    private sealed interface CallbackSourceRegistration {
        data object Accepted : CallbackSourceRegistration
        data object Stale : CallbackSourceRegistration
        data class Mismatch(
            val expectedSource: RelayV2Transport?,
            val sources: Set<RelayV2Transport>,
        ) : CallbackSourceRegistration
    }

    private enum class BarrierEnqueue { ENQUEUED, RETRY, STOPPED }
    private enum class ShutdownEnqueue { ENQUEUED, RETRY, STOPPED }
    private enum class CallbackEnqueue {
        ENQUEUED,
        RETRY,
        STOPPED,
        STALE,
        COALESCED,
        SATURATED,
        IGNORED,
    }

    private enum class LifecycleState { OPEN, SHUTTING_DOWN, CLOSED }

    private class CallbackAdmissionGate {
        private val lock = Any()
        private var sealedThroughConnectTokenId = Long.MIN_VALUE
        private val inFlight = linkedMapOf<CallbackOwnerKey, Int>()
        private val waiters = mutableListOf<AdmissionWaiter>()

        fun tryEnter(owner: CallbackOwnerKey): Admission? = synchronized(lock) {
            if (owner.connectTokenId <= sealedThroughConnectTokenId) return@synchronized null
            inFlight[owner] = (inFlight[owner] ?: 0) + 1
            Admission(owner)
        }

        fun sealThrough(owner: CallbackOwnerKey) {
            val ready = synchronized(lock) {
                sealedThroughConnectTokenId = maxOf(
                    sealedThroughConnectTokenId,
                    owner.connectTokenId,
                )
                collectReadyWaitersLocked()
            }
            ready.forEach { it.complete(Unit) }
        }

        fun sealedDrainOrNull(): CompletableDeferred<Unit>? = synchronized(lock) {
            val threshold = sealedThroughConnectTokenId
            if (!hasInFlightThroughLocked(threshold)) return@synchronized null
            CompletableDeferred<Unit>().also { waiters += AdmissionWaiter(threshold, it) }
        }

        fun hasPendingSealedAdmissions(): Boolean = synchronized(lock) {
            hasInFlightThroughLocked(sealedThroughConnectTokenId)
        }

        private fun exit(owner: CallbackOwnerKey) {
            val ready = synchronized(lock) {
                val count = checkNotNull(inFlight[owner]) {
                    "Relay v2 callback admission ownership underflow"
                }
                if (count == 1) inFlight.remove(owner) else inFlight[owner] = count - 1
                collectReadyWaitersLocked()
            }
            ready.forEach { it.complete(Unit) }
        }

        private fun hasInFlightThroughLocked(connectTokenId: Long): Boolean =
            inFlight.any { (owner, count) -> owner.connectTokenId <= connectTokenId && count > 0 }

        private fun collectReadyWaitersLocked(): List<CompletableDeferred<Unit>> {
            val ready = waiters.filterNot { hasInFlightThroughLocked(it.connectTokenId) }
            waiters.removeAll(ready.toSet())
            return ready.map(AdmissionWaiter::completion)
        }

        inner class Admission(
            private val owner: CallbackOwnerKey,
        ) : Closeable {
            private val closed = AtomicBoolean(false)

            override fun close() {
                if (closed.compareAndSet(false, true)) exit(owner)
            }
        }

        private data class AdmissionWaiter(
            val connectTokenId: Long,
            val completion: CompletableDeferred<Unit>,
        )
    }

    private class EffectApplyGate {
        private val lock = Any()
        private var acceptingGeneration: RelayV2EffectGeneration? = null
        private var acceptingAuthority: RelayV2RepositoryEffectAuthority? = null
        private var leasedGeneration: RelayV2EffectGeneration? = null
        private var leasedAuthority: RelayV2RepositoryEffectAuthority? = null
        private var activeLeaseCount = 0
        private var drainWaiter: CompletableDeferred<Unit>? = null

        fun activate(
            generation: RelayV2EffectGeneration,
            repositoryAuthority: RelayV2RepositoryEffectAuthority? = null,
        ) = synchronized(lock) {
            check(activeLeaseCount == 0) {
                "Cannot activate a Relay v2 generation while an older apply lease is active"
            }
            check(acceptingGeneration == null || acceptingGeneration == generation) {
                "Relay v2 apply generation changed without a drain barrier"
            }
            check(acceptingAuthority == null || acceptingAuthority == repositoryAuthority) {
                "Relay v2 repository authority changed without a drain barrier"
            }
            acceptingGeneration = generation
            acceptingAuthority = repositoryAuthority
        }

        fun begin(
            generation: RelayV2EffectGeneration,
            repositoryAuthority: RelayV2RepositoryEffectAuthority?,
        ): ApplyLease? = synchronized(lock) {
            if (acceptingGeneration != generation ||
                acceptingAuthority != repositoryAuthority
            ) {
                return@synchronized null
            }
            check(leasedGeneration == null || leasedGeneration == generation) {
                "Relay v2 apply leases crossed generations"
            }
            check(leasedAuthority == null || leasedAuthority == repositoryAuthority) {
                "Relay v2 apply leases crossed repository authorities"
            }
            leasedGeneration = generation
            leasedAuthority = repositoryAuthority
            activeLeaseCount += 1
            ApplyLease(this)
        }

        fun invalidateAndDrain(): CompletableDeferred<Unit> = synchronized(lock) {
            acceptingGeneration = null
            acceptingAuthority = null
            if (activeLeaseCount == 0) {
                CompletableDeferred(Unit)
            } else {
                drainWaiter ?: CompletableDeferred<Unit>().also { drainWaiter = it }
            }
        }

        fun invalidateThrough(
            profileId: String,
            activationGeneration: Long,
        ): CompletableDeferred<Unit>? = synchronized(lock) {
            val owned = acceptingGeneration ?: leasedGeneration ?: return@synchronized null
            if (owned.profileId != profileId ||
                owned.profileGeneration > activationGeneration
            ) {
                return@synchronized null
            }
            acceptingGeneration = null
            acceptingAuthority = null
            if (activeLeaseCount == 0) {
                CompletableDeferred(Unit)
            } else {
                drainWaiter ?: CompletableDeferred<Unit>().also { drainWaiter = it }
            }
        }

        private fun release() {
            val completed = synchronized(lock) {
                check(activeLeaseCount > 0) { "Relay v2 apply lease accounting underflow" }
                activeLeaseCount -= 1
                if (activeLeaseCount == 0) {
                    leasedGeneration = null
                    leasedAuthority = null
                    drainWaiter.also { drainWaiter = null }
                } else {
                    null
                }
            }
            completed?.complete(Unit)
        }

        class ApplyLease(private val gate: EffectApplyGate) : AutoCloseable {
            private val closed = AtomicBoolean(false)

            override fun close() {
                if (closed.compareAndSet(false, true)) gate.release()
            }
        }
    }

    private fun RelayV2DecodedMessage.type(): String =
        (normalized as com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2NormalizedPublicFrame).type

    companion object {
        internal val REQUIRED_CAPABILITIES = listOf(
            "error.structured.v1",
            "command.ledger.v1",
            "command.query.v1",
            "snapshot.revision.v1",
            "event.sequence.v1",
            "terminal.stream.resume.v1",
        )

        private val SUPPORTED_OPTIONAL_CAPABILITIES = setOf(
            AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
        )

        internal const val DEFAULT_ACTION_CAPACITY = 64
        internal const val DEFAULT_RESERVED_ACTION_CAPACITY = 8
        internal const val DEFAULT_EVENT_CAPACITY = 32
        internal const val DEFAULT_ACTION_BYTE_CAPACITY = 1_048_576L
        internal const val DEFAULT_EFFECT_BYTE_CAPACITY = 1_048_576L
        internal const val DEFAULT_EXTENSION_EVENT_CAPACITY = 32
        internal const val DEFAULT_EXTENSION_ACTION_BYTE_CAPACITY = 1_048_576L
        internal const val DEFAULT_EXTENSION_EFFECT_BYTE_CAPACITY = 1_048_576L
        internal const val RELAY_WELCOME_TIMEOUT_MS = 5_000L
        internal const val HOST_WELCOME_TIMEOUT_MS = 10_000L
        internal const val RECOVERY_STEP_TIMEOUT_MS = 15_000L
        internal const val EXTENSION_REQUEST_TIMEOUT_MS = 15_000L
        private const val CONTROL_ENQUEUE_RETRY_MS = 1L
        private const val MAX_RECENT_ISSUED_IDS = 1_024
        private const val MAX_COMPLETED_RECOVERY_RESPONSES = 128
        private const val MAX_QUERY_WINDOW_BINDINGS = 129
        private const val MAX_PENDING_AGENT_EXTENSION_REQUESTS = 64
        private const val MAX_TRACKED_AGENT_EXTENSION_REQUESTS = 1_024

        private val AGENT_EXTENSION_INBOUND_PHASES = setOf(
            RelayV2ConnectionPhase.QUERYING,
            RelayV2ConnectionPhase.RESYNCING,
            RelayV2ConnectionPhase.ONLINE,
        )

        private val BASE_AGENT_EXTENSION_OVERLAPPING_ERROR_CODES = setOf(
            "HOST_EPOCH_MISMATCH",
        )

        private val UUID_PATTERN = Regex(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-" +
                "[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        )

        private val POST_HANDSHAKE_COMMON_INBOUND_TYPES = setOf(
            "error",
            "auth.expiring",
            "host.presence",
            "hosts.snapshot",
            "command.status",
            "command.result",
            "command.statuses",
            "scopes.snapshot",
            "sessions.snapshot",
            "scopes.changed",
            "sessions.changed",
        )

        private val QUERYING_INBOUND_TYPES = POST_HANDSHAKE_COMMON_INBOUND_TYPES

        private val RESYNCING_INBOUND_TYPES = POST_HANDSHAKE_COMMON_INBOUND_TYPES + setOf(
            "state.snapshot.chunk",
            "state.snapshot.released",
        )

        private val ONLINE_INBOUND_TYPES = POST_HANDSHAKE_COMMON_INBOUND_TYPES + setOf(
            "state.snapshot.released",
        )

        private val STATE_CHANGE_INBOUND_TYPES = setOf("scopes.changed", "sessions.changed")

        private val FROZEN_BROKER_LIMITS = linkedMapOf(
            "maxFrameBytes" to 1_048_576L,
            "maxCarrierFrameBytes" to 1_500_000L,
            "brokerRouteBufferedBytesPerDirection" to 1_048_576L,
            "brokerRouteLowWaterBytesPerDirection" to 524_288L,
            "brokerCarrierBufferedBytes" to 16_777_216L,
            "brokerCarrierLowWaterBytes" to 8_388_608L,
            "maxQueuedRouteFrames" to 128L,
            "maxInFlightRequestsPerRoute" to 64L,
        )

        private val FROZEN_HOST_LIMITS = linkedMapOf(
            "commandResultRetentionMs" to 86_400_000L,
            "commandDedupeRetentionMs" to 604_800_000L,
            "maxCommandQueryIds" to 32L,
            "stateSnapshotChunkBytes" to 524_288L,
            "stateSnapshotChunkRecords" to 256L,
            "stateSnapshotMaxBytes" to 268_435_456L,
            "stateSnapshotMaxRecords" to 100_000L,
            "stateSnapshotIdleLeaseMs" to 300_000L,
            "stateSnapshotMaxLifetimeMs" to 3_600_000L,
            "stateSnapshotMaxPinnedPerPrincipal" to 2L,
            "stateSnapshotMaxPinnedPerHost" to 16L,
            "stateSnapshotPinnedBytesPerHost" to 536_870_912L,
            "stateSnapshotPinnedMetadataBytesPerHost" to 16_777_216L,
            "stateSnapshotChunkMaxJsonKeys" to 8_192L,
            "stateSnapshotChunkMaxJsonNodes" to 16_384L,
            "terminalReplayBytesPerStream" to 4_194_304L,
            "terminalReplayBytesPerHost" to 67_108_864L,
            "terminalDetachedLeaseMs" to 120_000L,
            "terminalControlDedupeRetentionMs" to 600_000L,
            "terminalMaxUnackedBytes" to 524_288L,
            "terminalMaxFrameBytes" to 65_536L,
            "terminalInputDedupeEntriesPerStream" to 512L,
            "terminalResizeDedupeEntriesPerStream" to 256L,
            "terminalMaxStreamsPerHost" to 256L,
            "terminalControlRecordsPerHost" to 4_096L,
            "brokerRouteBufferedBytesPerDirection" to 1_048_576L,
            "brokerRouteLowWaterBytesPerDirection" to 524_288L,
        )
    }
}

@Suppress("UNCHECKED_CAST")
private fun Map<String, Any?>.objectValue(name: String): Map<String, Any?> =
    getValue(name) as Map<String, Any?>

private fun Map<String, Any?>.stringValue(name: String): String = getValue(name) as String

private fun Map<String, Any?>.stringList(name: String): List<String> =
    (getValue(name) as List<*>).map { it as String }

private fun Map<String, Any?>.longValue(name: String): Long = (getValue(name) as Number).toLong()

private fun Map<String, Any?>.booleanValue(name: String): Boolean = getValue(name) as Boolean

private fun Map<String, Any?>.listValue(name: String): List<*> = getValue(name) as List<*>

private fun Map<String, Any?>.longMap(): Map<String, Long> =
    entries.associate { (key, value) -> key to (value as Number).toLong() }

private fun RelayV2RecoveryReceipt.estimatedRawBytes(): Int {
    fun String.bytes(): Long = toByteArray(Charsets.UTF_8).size.toLong()
    fun RelayV2PendingCommand.bytes(): Long = commandId.bytes() + dedupeWindowId.bytes()

    var total = binding.requestId.bytes() +
        binding.generation.profileId.bytes() +
        hostId.bytes() +
        hostEpoch.bytes() +
        64L
    total += when (this) {
        is RelayV2RecoveryReceipt.HelloApplied ->
            (durableCursorEventSeq?.bytes() ?: 0L) +
                pendingCommands.sumOf { it.bytes() } +
                (snapshotContinuation?.let { continuation ->
                    continuation.snapshotRequestId.bytes() +
                        continuation.snapshotId.bytes() +
                        continuation.cursor.bytes() +
                        16L
                } ?: 0L)
        is RelayV2RecoveryReceipt.CommandQueryAttemptRegistered ->
            estimatedCommandBytes.toLong()
        is RelayV2RecoveryReceipt.CommandStatusesApplied ->
            appliedCommands.sumOf { it.bytes() }
        is RelayV2RecoveryReceipt.SnapshotChunkApplied -> when (val value = result) {
            is RelayV2DurableSnapshotApplyResult.Continue ->
                value.snapshotRequestId.bytes() +
                    value.snapshotId.bytes() +
                    value.nextCursor.bytes() +
                    16L
            is RelayV2DurableSnapshotApplyResult.Committed ->
                value.snapshotRequestId.bytes() +
                    value.snapshotId.bytes() +
                    value.durableCursorEventSeq.bytes() +
                    value.release.estimatedRawBytes()
        }
        is RelayV2RecoveryReceipt.RecoveryAbandoned ->
                (durableCursorEventSeq?.bytes() ?: 0L) +
                pendingCommands.sumOf { it.bytes() } +
                release.estimatedRawBytes()
        is RelayV2RecoveryReceipt.RecoveryRestartRequired ->
            (durableCursorEventSeq?.bytes() ?: 0L) +
                pendingCommands.sumOf { it.bytes() } +
                32L
        is RelayV2RecoveryReceipt.QueryRecoverySuperseded ->
            (durableCursorEventSeq?.bytes() ?: 0L) +
                requiredThroughEventSeq.bytes() +
                queryLineage.recoveryId.bytes() +
                (completedReleaseBinding?.requestId?.bytes() ?: 0L) +
                pendingCommands.sumOf { it.bytes() } +
                32L
        is RelayV2RecoveryReceipt.ReleaseObligationRecovered ->
                (durableCursorEventSeq?.bytes() ?: 0L) +
                pendingCommands.sumOf { it.bytes() } +
                release.estimatedRawBytes()
        is RelayV2RecoveryReceipt.SnapshotReleaseCompleted ->
            release.estimatedRawBytes()
    }
    return total.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
}

private fun RelayV2OnlineResyncRequired.estimatedRawBytes(): Int {
    fun String.bytes(): Long = toByteArray(Charsets.UTF_8).size.toLong()
    var total = generation.profileId.bytes() + hostId.bytes() + hostEpoch.bytes() + 64L
    total += durableCursorEventSeq?.bytes() ?: 0L
    total += pendingCommands.sumOf {
        it.commandId.bytes() + it.dedupeWindowId.bytes()
    }
    total += release?.estimatedRawBytes() ?: 0L
    return total.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
}

private fun RelayV2RecoveryReleaseDirective.estimatedRawBytes(): Long {
    fun String.bytes(): Long = toByteArray(Charsets.UTF_8).size.toLong()
    return obligationToken.bytes() +
        profileId.bytes() +
        principalId.bytes() +
        clientInstanceId.bytes() +
        hostId.bytes() +
        hostEpoch.bytes() +
        snapshotRequestId.bytes() +
        snapshotId.bytes() +
        (durableCursorEventSeq?.bytes() ?: 0L) +
        durableReason.name.bytes() +
        32L
}
