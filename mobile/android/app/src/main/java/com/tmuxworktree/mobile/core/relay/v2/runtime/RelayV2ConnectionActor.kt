package com.tmuxworktree.mobile.core.relay.v2.runtime

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
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialStore
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.profile.matchesCredentialBinding
import java.io.Closeable
import java.math.BigInteger
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

/**
 * Serialized Relay v2 client runtime seam.
 *
 * The actor owns the active transport and all handshake state. Transport callbacks only enqueue
 * generation-tagged actions; this class has no dependency on the Relay v1 profile, actor, or codec.
 */
internal class RelayV2ConnectionActor(
    parentScope: CoroutineScope,
    private val transportFactory: RelayV2TransportFactory,
    private val credentialStore: RelayV2CredentialStore,
    private val codec: RelayV2Codec = RelayV2Codec(),
    private val clock: () -> Long = System::currentTimeMillis,
    private val attemptId: () -> String = { UUID.randomUUID().toString() },
    private val watchdogDelay: suspend (Long) -> Unit = { delay(it) },
    private val beforeTransportCommit: suspend () -> Unit = {},
    private val relayWelcomeTimeoutMs: Long = RELAY_WELCOME_TIMEOUT_MS,
    private val hostWelcomeTimeoutMs: Long = HOST_WELCOME_TIMEOUT_MS,
    normalActionCapacity: Int = DEFAULT_ACTION_CAPACITY,
    reservedActionCapacity: Int = DEFAULT_RESERVED_ACTION_CAPACITY,
    eventCapacity: Int = DEFAULT_EVENT_CAPACITY,
    private val actionByteCapacity: Long = DEFAULT_ACTION_BYTE_CAPACITY,
    private val effectByteCapacity: Long = DEFAULT_EFFECT_BYTE_CAPACITY,
) : RelayProfileDisconnectBarrier, Closeable {
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
    private val resourcesClosed = AtomicBoolean(false)
    private val lastOverloadGeneration = AtomicReference<RelayV2EffectGeneration?>(null)
    private val lastTerminationGeneration = AtomicReference<RelayV2EffectGeneration?>(null)
    private val publishedEffectGeneration = AtomicReference<RelayV2EffectGeneration?>(null)
    private val queuedActionBytes = AtomicLong(0)
    private val queuedEffectBytes = AtomicLong(0)
    private val effectApplyGate = EffectApplyGate()
    private val lifecycleLock = Any()
    private var lifecycleState = LifecycleState.OPEN
    private var shutdownDrainCompletion: CompletableDeferred<Unit>? = null
    private val fencedActivationGenerations = linkedMapOf<String, Long>()
    private var nextConnectTokenId = 0L
    private var activeConnectToken: ConnectToken? = null
    private var provisionalCallbackOwner: ProvisionalCallbackOwner? = null
    private var committedCallbackOwner: CommittedCallbackOwner? = null
    private val pendingBarriers = linkedMapOf<
        CompletableDeferred<RelayProfileDisconnectReceipt>,
        RelayProfileDisconnectReceipt,
        >()

    private val _state = MutableStateFlow(RelayV2ConnectionState(changedAtMs = clock()))
    val state: StateFlow<RelayV2ConnectionState> = _state.asStateFlow()
    val effects: Flow<RelayV2RuntimeEffect> = flow {
        for (queued in effectChannel) {
            try {
                emit(queued.effect)
            } finally {
                releaseBytes(queuedEffectBytes, queued.rawBytes)
            }
        }
    }

    /**
     * Runs a repository/Room commit while holding the actor-owned generation lease.
     *
     * Pulling an effect from [effects] or observing [state] never authorizes a mutation. The
     * complete transaction that applies a generation-scoped effect must execute inside [block].
     */
    suspend fun <T> withEffectApplyLease(
        effect: RelayV2RuntimeEffect.GenerationScoped,
        block: suspend () -> T,
    ): RelayV2EffectApplyResult<T> {
        val lease = effectApplyGate.begin(effect.generation)
            ?: return RelayV2EffectApplyResult.Stale
        return try {
            RelayV2EffectApplyResult.Applied(block())
        } finally {
            lease.close()
        }
    }

    // Actor-owned mutable state. Callback threads only retain immutable generation values.
    private var connectionGeneration = 0L
    private var activeTransport: RelayV2Transport? = null
    private var activeProfile: RelayV2Profile? = null
    private var requestedResume: RelayV2ResumeCursor? = null
    private var pendingHelloRequestId: String? = null
    private var brokerEpoch: String? = null
    private var brokerCapabilities: Set<String> = emptySet()
    private var brokerLimits: Map<String, Long>? = null
    private var relayWelcomeWatchdog: Job? = null
    private var hostWelcomeWatchdog: Job? = null

    init {
        require(relayWelcomeTimeoutMs > 0) { "relayWelcomeTimeoutMs must be positive" }
        require(hostWelcomeTimeoutMs > 0) { "hostWelcomeTimeoutMs must be positive" }
        require(actionByteCapacity > 0) { "actionByteCapacity must be positive" }
        require(effectByteCapacity > 0) { "effectByteCapacity must be positive" }
        scope.launch {
            try {
                while (true) {
                    val action = actions.receive() ?: break
                    try {
                        handle(action)
                    } finally {
                        releaseBytes(queuedActionBytes, action.rawBytes)
                    }
                }
            } finally {
                cancelHandshakeWatchdogs()
                invalidateConnectionOwnershipAndDrain()
                val source = activeTransport
                activeTransport = null
                connectionGeneration += 1
                source?.cancel()
                finishResources()
            }
        }
        scope.coroutineContext[Job]?.invokeOnCompletion {
            finishResources()
        }
    }

    fun connect(profile: RelayV2Profile, resume: RelayV2ResumeCursor?): Boolean {
        val overloadOwner = synchronized(lifecycleLock) {
            if (lifecycleState != LifecycleState.OPEN || isActivationFencedLocked(profile.identity)) {
                return false
            }
            if (actions.trySendNormal(Action.Connect(profile, resume))) return true
            currentCallbackOwnerKeyLocked()
        }
        signalQueueSaturation(overloadOwner, source = null)
        return false
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
                provisionalCallbackOwner = null
                committedCallbackOwner = null
                lifecycleState = LifecycleState.SHUTTING_DOWN
                check(shutdownDrainCompletion == null) { "Relay v2 shutdown drain already exists" }
                shutdownDrainCompletion = CompletableDeferred()
                publishedEffectGeneration.set(null)
                effectApplyGate.invalidateAndDrain()
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
            is Action.Connect -> connectNow(action.profile, action.resume)
            is Action.Disconnect -> disconnectNow(action)
            is Action.TransportOpened -> transportOpened(action)
            is Action.TransportFrame -> transportFrame(action)
            is Action.TransportFrameTooLarge -> if (isCurrentCallback(action.owner, action.source)) {
                failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", retryable = false, 4400)
            }
            is Action.TerminateConnection -> terminateConnection(action)
            is Action.HandshakeTimedOut -> handshakeTimedOut(action)
            is Action.QueueSaturated -> queueSaturated(action)
            Action.Shutdown -> shutdownNow()
        }
    }

    private suspend fun connectNow(profile: RelayV2Profile, resume: RelayV2ResumeCursor?) {
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
                publishedEffectGeneration.set(null)
                committedCallbackOwner = null
                val previous = activeTransport
                activeTransport = null
                connectionGeneration += 1
                lastOverloadGeneration.set(null)
                lastTerminationGeneration.set(null)
                ConnectPreparation(
                    previousTransport = previous,
                    connectionGeneration = connectionGeneration,
                    applyDrain = effectApplyGate.invalidateAndDrain(),
                )
            } ?: return
            cancelHandshakeWatchdogs()
            preparation.previousTransport?.close(1000, "v2 reconnect")
            preparation.applyDrain.await()
            if (!isConnectTokenCurrent(token)) return

            val effectGeneration = RelayV2EffectGeneration(
                profileId = profile.profileId,
                profileGeneration = profile.activationGeneration,
                connectionGeneration = preparation.connectionGeneration,
            )
            val provisionalOwner = synchronized(lifecycleLock) {
                if (!isConnectTokenCurrentLocked(token)) return@synchronized null
                ProvisionalCallbackOwner(
                    connectToken = token,
                    effectGeneration = effectGeneration,
                    phase = CallbackOwnerPhase.OPENING,
                ).also { provisionalCallbackOwner = it }
            } ?: return
            val listener = listenerFor(provisionalOwner)
            val request = RelayV2TransportOpenRequest(
                relayUrl = profile.relayUrl,
                offeredSubprotocols = listOf(profile.offeredSubprotocol),
                accessToken = requireNotNull(credential).accessToken!!,
            )
            val opened = runCatching { transportFactory.open(request, listener) }
                .getOrElse {
                    failConnectAttempt(
                        token,
                        profile,
                        RelayV2ConnectionFailure(
                            RelayV2FailureKind.TRANSPORT,
                            "HOST_OFFLINE",
                            retryable = true,
                        ),
                        closeCode = null,
                    )
                    return
                }
            uncommittedTransport = opened
            beforeTransportCommit()
            val committed = synchronized(lifecycleLock) {
                if (!isConnectTokenCurrentLocked(token) ||
                    provisionalCallbackOwner != provisionalOwner
                ) {
                    return@synchronized false
                }
                activeProfile = profile
                requestedResume = resume
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
                true
            }
            if (!committed) return
            uncommittedTransport = null
        } finally {
            credential = null
            uncommittedTransport?.close(1000, "stale v2 connect attempt")
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
            credential.credentialVersion != profile.credentialVersion
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
            if (provisionalCallbackOwner?.connectToken == token) {
                provisionalCallbackOwner = null
            }
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
            provisionalCallbackOwner = null
        }
        val committed = committedCallbackOwner
        if (committed?.effectGeneration?.profileId == profile.profileId &&
            committed.effectGeneration.profileGeneration <= fenced
        ) {
            committedCallbackOwner = null
            publishedEffectGeneration.set(null)
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
            if (provisionalCallbackOwner?.connectToken == token) {
                provisionalCallbackOwner = null
            }
            committedCallbackOwner = null
            publishedEffectGeneration.set(null)
            effectApplyGate.invalidateAndDrain()
            val source = activeTransport
            activeTransport = null
            activeProfile = profile
            pendingHelloRequestId = null
            updateState(RelayV2ConnectionPhase.FAILED, profile, failure)
            source
        }
        cancelHandshakeWatchdogs()
        if (closeCode != null) {
            failed?.close(closeCode, "relay v2 ${failure.code}")
        } else {
            failed?.cancel()
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

    private fun listenerFor(owner: ProvisionalCallbackOwner): RelayV2TransportListener =
        object : RelayV2TransportListener {
            override fun onOpen(source: RelayV2Transport, selectedSubprotocol: String?) {
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

            override fun onFrame(
                source: RelayV2Transport,
                bytes: ByteArray,
                metadata: RelayV2FrameMetadata,
            ) {
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

            override fun onClosed(source: RelayV2Transport, code: Int) {
                enqueueTermination(
                    owner.key,
                    source,
                    TerminationCause.TransportClosed(code),
                )
            }

            override fun onFailure(source: RelayV2Transport, failure: RelayV2TransportFailure) {
                enqueueTermination(
                    owner.key,
                    source,
                    TerminationCause.TransportFailed(failure),
                )
            }
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
                actions.trySendNormal(action) -> CallbackEnqueue.ENQUEUED
                else -> {
                    releaseBytes(queuedActionBytes, action.rawBytes)
                    CallbackEnqueue.SATURATED
                }
            }
        }
        when (result) {
            CallbackEnqueue.ENQUEUED,
            CallbackEnqueue.STALE,
            -> Unit
            CallbackEnqueue.STOPPED -> source.cancel()
            CallbackEnqueue.SATURATED -> signalQueueSaturation(owner, source)
            else -> error("Unexpected normal callback enqueue state")
        }
    }

    private fun enqueueTermination(
        owner: CallbackOwnerKey,
        source: RelayV2Transport,
        cause: TerminationCause,
    ) {
        val action = Action.TerminateConnection(
            owner.connectTokenId,
            owner.effectGeneration,
            source,
            cause,
        )
        val result = synchronized(lifecycleLock) {
            when {
                lifecycleState != LifecycleState.OPEN -> CallbackEnqueue.STOPPED
                !acceptsCallbackLocked(owner, source) -> CallbackEnqueue.STALE
                !lastTerminationGeneration.compareAndSet(null, owner.effectGeneration) ->
                    CallbackEnqueue.COALESCED
                actions.trySendNormalOrReserved(action) -> CallbackEnqueue.ENQUEUED
                else -> CallbackEnqueue.RETRY
            }
        }
        when (result) {
            CallbackEnqueue.ENQUEUED,
            CallbackEnqueue.STALE,
            CallbackEnqueue.COALESCED,
            -> return
            CallbackEnqueue.STOPPED -> {
                source.cancel()
                return
            }
            CallbackEnqueue.RETRY -> Unit
            CallbackEnqueue.SATURATED -> error("Termination cannot reserve raw callback bytes")
        }
        source.cancel()
        scope.launch {
            while (!resourcesClosed.get()) {
                val retry = synchronized(lifecycleLock) {
                    when {
                        lifecycleState != LifecycleState.OPEN ||
                            !acceptsCallbackLocked(owner, source) -> CallbackEnqueue.STOPPED
                        actions.trySendReserved(action) -> CallbackEnqueue.ENQUEUED
                        else -> CallbackEnqueue.RETRY
                    }
                }
                when (retry) {
                    CallbackEnqueue.ENQUEUED,
                    CallbackEnqueue.STOPPED,
                    -> return@launch
                    CallbackEnqueue.RETRY -> delay(CONTROL_ENQUEUE_RETRY_MS)
                    else -> error("Unexpected termination retry state")
                }
            }
        }
    }

    private fun signalQueueSaturation(
        owner: CallbackOwnerKey?,
        source: RelayV2Transport?,
    ) {
        source?.cancel()
        if (owner == null) return
        val action = Action.QueueSaturated(
            owner.connectTokenId,
            owner.effectGeneration,
            source,
        )
        val result = synchronized(lifecycleLock) {
            when {
                lifecycleState != LifecycleState.OPEN ||
                    !acceptsCallbackLocked(owner, source) -> CallbackEnqueue.STOPPED
                !lastOverloadGeneration.compareAndSet(null, owner.effectGeneration) ->
                    CallbackEnqueue.COALESCED
                actions.trySendReserved(action) -> CallbackEnqueue.ENQUEUED
                else -> CallbackEnqueue.RETRY
            }
        }
        if (result != CallbackEnqueue.RETRY) return
        scope.launch {
            while (!resourcesClosed.get()) {
                val retry = synchronized(lifecycleLock) {
                    when {
                        lifecycleState != LifecycleState.OPEN ||
                            !acceptsCallbackLocked(owner, source) -> CallbackEnqueue.STOPPED
                        actions.trySendReserved(action) -> CallbackEnqueue.ENQUEUED
                        else -> CallbackEnqueue.RETRY
                    }
                }
                when (retry) {
                    CallbackEnqueue.ENQUEUED,
                    CallbackEnqueue.STOPPED,
                    -> return@launch
                    CallbackEnqueue.RETRY -> delay(CONTROL_ENQUEUE_RETRY_MS)
                    else -> error("Unexpected overload retry state")
                }
            }
        }
    }

    private fun transportOpened(action: Action.TransportOpened) {
        if (!isCurrentCallback(action.owner, action.source)) {
            action.source.close(1000, "stale v2 transport")
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
            failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
            return
        }
        when (_state.value.phase) {
            RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME -> handleRelayWelcome(decoded, action.bytes.size)
            RelayV2ConnectionPhase.AWAITING_HOST_WELCOME -> handleHostWelcome(decoded, action.bytes.size)
            RelayV2ConnectionPhase.QUERYING,
            RelayV2ConnectionPhase.RESYNCING,
            -> deliverPostHandshakeFrame(decoded, action.bytes.size)
            else -> failConnection(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false, 4400)
        }
    }

    private fun deliverPostHandshakeFrame(decoded: RelayV2DecodedMessage, rawBytes: Int) {
        val profile = activeProfile ?: return
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
        emitEffect(
            RelayV2RuntimeEffect.DeliverPostHandshakeFrame(
                decoded,
                currentEffectGeneration(profile),
            ),
            rawBytes,
        )
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
        val requestId = attemptId()
        if (!UUID_PATTERN.matches(requestId)) {
            failConnection(RelayV2FailureKind.CONFIGURATION, "INVALID_ATTEMPT_ID", false, null)
            return
        }
        pendingHelloRequestId = requestId
        val hello = linkedMapOf<String, Any?>(
            "protocolVersion" to 2L,
            "kind" to "request",
            "type" to "client.hello",
            "requestId" to requestId,
            "hostId" to profile.hostId,
            "payload" to linkedMapOf(
                "clientInstanceId" to profile.clientInstanceId,
                "capabilities" to REQUIRED_CAPABILITIES,
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
        val negotiated = REQUIRED_CAPABILITIES.toSet()
            .intersect(brokerCapabilities)
            .intersect(hostCapabilities)
        if (!negotiated.containsAll(REQUIRED_CAPABILITIES)) {
            failConnection(
                RelayV2FailureKind.CAPABILITY,
                "CAPABILITY_UNAVAILABLE",
                retryable = false,
                closeCode = 4406,
            )
            return
        }
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
        pendingHelloRequestId = null
        val effectGeneration = currentEffectGeneration(profile)
        if (!activateEffectGenerationIfCurrent(effectGeneration)) return
        when (outcome) {
            RelayV2HelloOutcome.MATCHED -> {
                updateState(RelayV2ConnectionPhase.QUERYING, profile)
                emitEffect(
                    RelayV2RuntimeEffect.QueryPendingCommands(
                        context,
                        effectGeneration,
                    ),
                    rawBytes,
                )
            }
            RelayV2HelloOutcome.FRESH,
            RelayV2HelloOutcome.CURSOR_BEHIND,
            RelayV2HelloOutcome.HOST_EPOCH_CHANGED,
            -> {
                updateState(RelayV2ConnectionPhase.RESYNCING, profile)
                emitEffect(
                    RelayV2RuntimeEffect.BeginStateResync(
                        context = context,
                        generation = effectGeneration,
                        outcome = outcome,
                        discardPriorResourceLineage =
                            outcome == RelayV2HelloOutcome.HOST_EPOCH_CHANGED,
                    ),
                    rawBytes,
                )
            }
            RelayV2HelloOutcome.EVENT_CURSOR_AHEAD -> error("Handled above")
        }
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
            committedCallbackOwner = null
            publishedEffectGeneration.set(null)
            activeTransport.also { activeTransport = null }
        }
        source?.close(4400, "event cursor ahead")
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
        val action = Action.HandshakeTimedOut(
            owner.connectTokenId,
            owner.effectGeneration,
            source,
            expectedPhase,
            requestId,
        )
        val result = synchronized(lifecycleLock) {
            when {
                lifecycleState != LifecycleState.OPEN ||
                    !acceptsCallbackLocked(owner, source) -> CallbackEnqueue.STOPPED
                actions.trySendNormalOrReserved(action) -> CallbackEnqueue.ENQUEUED
                else -> CallbackEnqueue.RETRY
            }
        }
        if (result != CallbackEnqueue.RETRY) return
        scope.launch {
            while (!resourcesClosed.get()) {
                val retry = synchronized(lifecycleLock) {
                    when {
                        lifecycleState != LifecycleState.OPEN ||
                            !acceptsCallbackLocked(owner, source) -> CallbackEnqueue.STOPPED
                        actions.trySendReserved(action) -> CallbackEnqueue.ENQUEUED
                        else -> CallbackEnqueue.RETRY
                    }
                }
                when (retry) {
                    CallbackEnqueue.ENQUEUED,
                    CallbackEnqueue.STOPPED,
                    -> return@launch
                    CallbackEnqueue.RETRY -> delay(CONTROL_ENQUEUE_RETRY_MS)
                    else -> error("Unexpected handshake timeout retry state")
                }
            }
        }
    }

    private fun cancelHandshakeWatchdogs() {
        relayWelcomeWatchdog?.cancel()
        relayWelcomeWatchdog = null
        hostWelcomeWatchdog?.cancel()
        hostWelcomeWatchdog = null
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

    private fun terminateConnection(action: Action.TerminateConnection) {
        if (!isCurrentCallback(action.owner, action.source)) return
        when (val cause = action.cause) {
            is TerminationCause.TransportClosed -> transportClosed(cause.code)
            is TerminationCause.TransportFailed -> transportFailed(cause.failure)
        }
    }

    private fun transportClosed(closeCode: Int) {
        cancelHandshakeWatchdogs()
        val (kind, code, retryable) = when (closeCode) {
            4400 -> Triple(RelayV2FailureKind.SCHEMA, "INVALID_ENVELOPE", false)
            4401 -> Triple(RelayV2FailureKind.AUTH, "AUTH_REQUIRED", false)
            4403 -> Triple(RelayV2FailureKind.AUTH, "AUTH_INVALID", false)
            4406 -> Triple(RelayV2FailureKind.DIALECT, "PROTOCOL_UNSUPPORTED", false)
            4408 -> Triple(RelayV2FailureKind.TRANSPORT, "HANDSHAKE_TIMEOUT", true)
            else -> Triple(RelayV2FailureKind.TRANSPORT, "HOST_OFFLINE", true)
        }
        val generation = activeProfile?.let(::currentEffectGeneration)
        invalidateConnectionOwnershipAndDrain()
        activeTransport = null
        val failure = RelayV2ConnectionFailure(kind, code, retryable)
        updateState(RelayV2ConnectionPhase.FAILED, activeProfile, failure)
        emitEffect(
            RelayV2RuntimeEffect.ConnectionFailed(
                activeProfile?.identity,
                generation,
                failure,
            ),
        )
    }

    private fun transportFailed(failure: RelayV2TransportFailure) {
        val status = failure.httpStatus
        when (status) {
            401 -> failConnection(RelayV2FailureKind.AUTH, "AUTH_REQUIRED", false, null)
            403 -> failConnection(RelayV2FailureKind.AUTH, "PERMISSION_DENIED", false, null)
            426 -> failConnection(RelayV2FailureKind.DIALECT, "PROTOCOL_UNSUPPORTED", false, null)
            503 -> failConnection(RelayV2FailureKind.ROUTE, "HOST_OFFLINE", true, null)
            else -> if (failure.kind == RelayV2TransportFailureKind.UPGRADE && status == 101) {
                failConnection(
                    RelayV2FailureKind.DIALECT,
                    "PROTOCOL_UNSUPPORTED",
                    retryable = false,
                    closeCode = null,
                )
            } else {
                failConnection(RelayV2FailureKind.TRANSPORT, "HOST_OFFLINE", true, null)
            }
        }
    }

    private fun handshakeTimedOut(action: Action.HandshakeTimedOut) {
        if (!isCurrentCallback(action.owner, action.source) ||
            _state.value.phase != action.expectedPhase ||
            (action.requestId != null && pendingHelloRequestId != action.requestId)
        ) {
            return
        }
        if (!lastTerminationGeneration.compareAndSet(null, action.effectGeneration)) return
        failConnection(
            RelayV2FailureKind.TRANSPORT,
            "HANDSHAKE_TIMEOUT",
            retryable = true,
            closeCode = 4408,
        )
    }

    private fun queueSaturated(action: Action.QueueSaturated) {
        if (!isCurrentCallback(action.owner, action.source)) return
        failConnection(
            RelayV2FailureKind.QUEUE_SATURATED,
            "SLOW_CONSUMER",
            retryable = true,
            closeCode = 1013,
        )
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
        val applyDrain = invalidateConnectionOwnershipAndDrain()
        val disconnectedTransport = activeTransport
        activeTransport = null
        connectionGeneration += 1
        disconnectedTransport?.close(1000, "profile disconnect barrier")
        activeProfile = null
        requestedResume = null
        pendingHelloRequestId = null
        brokerEpoch = null
        brokerCapabilities = emptySet()
        brokerLimits = null
        updateState(RelayV2ConnectionPhase.DISCONNECTED, null)
        drainQueuedEffects()
        applyDrain.await()
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

    private fun failConnection(
        kind: RelayV2FailureKind,
        code: String,
        retryable: Boolean,
        closeCode: Int?,
        rawBytes: Int = 0,
    ) {
        cancelHandshakeWatchdogs()
        val generation = activeProfile?.let(::currentEffectGeneration)
        generation?.let { lastTerminationGeneration.compareAndSet(null, it) }
        invalidateConnectionOwnershipAndDrain()
        val source = activeTransport
        activeTransport = null
        if (closeCode != null) source?.close(closeCode, "relay v2 $code") else source?.cancel()
        pendingHelloRequestId = null
        val failure = RelayV2ConnectionFailure(kind, code, retryable)
        updateState(RelayV2ConnectionPhase.FAILED, activeProfile, failure)
        emitEffect(
            RelayV2RuntimeEffect.ConnectionFailed(activeProfile?.identity, generation, failure),
            rawBytes,
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

    private fun failEffectQueue() {
        if (!resourcesClosed.get()) {
            val generation = activeProfile?.let(::currentEffectGeneration)
            generation?.let { lastTerminationGeneration.compareAndSet(null, it) }
            invalidateConnectionOwnershipAndDrain()
            val source = activeTransport
            activeTransport = null
            source?.cancel()
            cancelHandshakeWatchdogs()
            val failure = RelayV2ConnectionFailure(
                RelayV2FailureKind.QUEUE_SATURATED,
                "SLOW_CONSUMER",
                retryable = true,
            )
            updateState(RelayV2ConnectionPhase.FAILED, activeProfile, failure)
        }
    }

    private fun drainQueuedEffects() {
        while (true) {
            val queued = effectChannel.tryReceive().getOrNull() ?: return
            releaseBytes(queuedEffectBytes, queued.rawBytes)
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
            isConnectTokenCurrentLocked(provisional.connectToken)
    }

    private fun isCurrentCallback(
        owner: CallbackOwnerKey,
        source: RelayV2Transport?,
    ): Boolean = synchronized(lifecycleLock) {
        val committed = committedCallbackOwner ?: return@synchronized false
        lifecycleState == LifecycleState.OPEN &&
            committed.key == owner &&
            publishedEffectGeneration.get() == owner.effectGeneration &&
            owner.effectGeneration.connectionGeneration == connectionGeneration &&
            (source == null || committed.source === source) &&
            (source == null || activeTransport === source)
    }

    private fun invalidateConnectionOwnershipAndDrain(): CompletableDeferred<Unit> =
        synchronized(lifecycleLock) {
            provisionalCallbackOwner = null
            committedCallbackOwner = null
            publishedEffectGeneration.set(null)
            effectApplyGate.invalidateAndDrain()
        }

    private fun activateEffectGenerationIfCurrent(
        generation: RelayV2EffectGeneration,
    ): Boolean = synchronized(lifecycleLock) {
        val committed = committedCallbackOwner
        if (lifecycleState != LifecycleState.OPEN ||
            committed?.effectGeneration != generation ||
            publishedEffectGeneration.get() != generation
        ) {
            return@synchronized false
        }
        effectApplyGate.activate(generation)
        true
    }

    private suspend fun shutdownNow() {
        cancelHandshakeWatchdogs()
        val applyDrain = invalidateConnectionOwnershipAndDrain()
        val source = activeTransport
        activeTransport = null
        connectionGeneration += 1
        source?.cancel()
        applyDrain.await()
        activeProfile = null
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
        drainQueuedEffects()
        effectChannel.close()
        scope.cancel()
        actorDispatcher.close()
    }

    private sealed interface Action {
        val rawBytes: Int
            get() = 0

        data class Connect(
            val profile: RelayV2Profile,
            val resume: RelayV2ResumeCursor?,
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

        data object Shutdown : Action
    }

    private sealed interface TerminationCause {
        data class TransportClosed(val code: Int) : TerminationCause
        data class TransportFailed(val failure: RelayV2TransportFailure) : TerminationCause
    }

    private data class QueuedEffect(
        val effect: RelayV2RuntimeEffect,
        val rawBytes: Int,
    )

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

    private data class CallbackOwnerKey(
        val connectTokenId: Long,
        val effectGeneration: RelayV2EffectGeneration,
    )

    private data class ProvisionalCallbackOwner(
        val connectToken: ConnectToken,
        val effectGeneration: RelayV2EffectGeneration,
        val phase: CallbackOwnerPhase,
    ) {
        val key = CallbackOwnerKey(connectToken.id, effectGeneration)
    }

    private data class CommittedCallbackOwner(
        val connectTokenId: Long,
        val effectGeneration: RelayV2EffectGeneration,
        val source: RelayV2Transport,
    ) {
        val key = CallbackOwnerKey(connectTokenId, effectGeneration)
    }

    private enum class CallbackOwnerPhase { OPENING }

    private enum class BarrierEnqueue { ENQUEUED, RETRY, STOPPED }
    private enum class ShutdownEnqueue { ENQUEUED, RETRY, STOPPED }
    private enum class CallbackEnqueue {
        ENQUEUED,
        RETRY,
        STOPPED,
        STALE,
        COALESCED,
        SATURATED,
    }

    private enum class LifecycleState { OPEN, SHUTTING_DOWN, CLOSED }

    private class EffectApplyGate {
        private val lock = Any()
        private var acceptingGeneration: RelayV2EffectGeneration? = null
        private var leasedGeneration: RelayV2EffectGeneration? = null
        private var activeLeaseCount = 0
        private var drainWaiter: CompletableDeferred<Unit>? = null

        fun activate(generation: RelayV2EffectGeneration) = synchronized(lock) {
            check(activeLeaseCount == 0) {
                "Cannot activate a Relay v2 generation while an older apply lease is active"
            }
            check(acceptingGeneration == null || acceptingGeneration == generation) {
                "Relay v2 apply generation changed without a drain barrier"
            }
            acceptingGeneration = generation
        }

        fun begin(generation: RelayV2EffectGeneration): ApplyLease? = synchronized(lock) {
            if (acceptingGeneration != generation) return@synchronized null
            check(leasedGeneration == null || leasedGeneration == generation) {
                "Relay v2 apply leases crossed generations"
            }
            leasedGeneration = generation
            activeLeaseCount += 1
            ApplyLease(this)
        }

        fun invalidateAndDrain(): CompletableDeferred<Unit> = synchronized(lock) {
            acceptingGeneration = null
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

        internal const val DEFAULT_ACTION_CAPACITY = 64
        internal const val DEFAULT_RESERVED_ACTION_CAPACITY = 8
        internal const val DEFAULT_EVENT_CAPACITY = 32
        internal const val DEFAULT_ACTION_BYTE_CAPACITY = 1_048_576L
        internal const val DEFAULT_EFFECT_BYTE_CAPACITY = 1_048_576L
        internal const val RELAY_WELCOME_TIMEOUT_MS = 5_000L
        internal const val HOST_WELCOME_TIMEOUT_MS = 10_000L
        private const val CONTROL_ENQUEUE_RETRY_MS = 1L

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

private fun Map<String, Any?>.longMap(): Map<String, Long> =
    entries.associate { (key, value) -> key to (value as Number).toLong() }
