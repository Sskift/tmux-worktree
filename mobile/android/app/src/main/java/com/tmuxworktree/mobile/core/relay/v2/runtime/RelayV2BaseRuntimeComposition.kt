package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialStore
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateSyncAuthority
import java.io.Closeable
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** The explicit v2 profile's connection state, not product readiness or capability availability. */
internal enum class RelayV2BaseRuntimePhase {
    STOPPED,
    CONNECTING,
    RESYNCING,
    ONLINE,
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
    suspend fun isEmpty(profile: RelayV2Profile): Boolean
}

/**
 * Production base-sync owner for one already-admitted Relay v2 profile activation.
 *
 * This composition owns exactly one actor, its effect pump, and their close lifecycle. It only
 * consumes the existing state-sync adapter's effects. Outbox dispatch, commands, terminal, Agent
 * extensions, refresh, reconnect, and capability advertisement remain deliberately unowned.
 */
internal class RelayV2BaseRuntimeComposition(
    parentScope: CoroutineScope,
    private val profile: RelayV2Profile,
    credentialStore: RelayV2CredentialStore,
    stateSyncAuthority: RelayV2StateSyncAuthority,
    private val activationOutbox: RelayV2ActivationOutboxReadPort,
    transportFactory: RelayV2TransportFactory = BoundedRelayV2TransportFactory(),
) : Closeable {
    private val closed = AtomicBoolean(false)
    private val terminalFailure = AtomicReference<RelayV2BaseRuntimeFailure?>(null)
    private val stateLock = Any()
    private val admittedEmptyOutbox = AtomicBoolean(false)
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
    private val actor = RelayV2ConnectionActor(
        parentScope = actorScope,
        transportFactory = transportFactory,
        credentialStore = credentialStore,
        connectPlanSource = recoveryAdapter,
        optionalCapabilities = emptySet(),
    )
    private val _state = MutableStateFlow(RelayV2BaseRuntimeState())
    val state: StateFlow<RelayV2BaseRuntimeState> = _state.asStateFlow()

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
        if (profile.autoConnect) {
            pumpScope.launch { connectOnce() }
        }
    }

    suspend fun disconnectAndDrain(
        expectedProfile: RelayActiveProfileIdentity,
        barrierId: String,
    ): RelayProfileDisconnectReceipt = actor.disconnectAndDrain(expectedProfile, barrierId)

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        beginActorShutdown()
        synchronized(stateLock) {
            if (terminalFailure.get() == null) {
                _state.value = RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.STOPPED)
            }
        }
    }

    private suspend fun connectOnce() {
        val outboxEmpty = try {
            activationOutbox.isEmpty(profile)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            failRuntimeIncomplete("DURABLE_OUTBOX_ADMISSION_FAILED")
            return
        }
        if (!outboxEmpty) {
            failRuntimeIncomplete("DURABLE_OUTBOX_RUNTIME_UNAVAILABLE")
            return
        }
        admittedEmptyOutbox.set(true)
        if (!actor.connect(profile)) {
            failRuntimeIncomplete("CONNECT_ADMISSION_REJECTED")
        }
    }

    internal suspend fun consume(effect: RelayV2RuntimeEffect) {
        when (effect) {
            is RelayV2RuntimeEffect.QueryPendingCommands -> applyHello(effect)
            is RelayV2RuntimeEffect.BeginStateResync -> applyHello(effect)
            is RelayV2RuntimeEffect.ApplyStateSnapshotChunk -> applySnapshotChunk(effect)
            is RelayV2RuntimeEffect.CompleteSnapshotRelease -> completeSnapshotRelease(effect)
            is RelayV2RuntimeEffect.ExpireSnapshotContinuation -> expireSnapshot(effect)
            is RelayV2RuntimeEffect.DeliverPostHandshakeFrame -> applyPostHandshakeFrame(effect)

            is RelayV2RuntimeEffect.ConnectionFailed -> failConnection(effect.failure)
            is RelayV2RuntimeEffect.ConnectRejected -> failConnection(effect.failure)
            is RelayV2RuntimeEffect.RejectContinuity -> failConnection(
                RelayV2ConnectionFailure(
                    kind = RelayV2FailureKind.SCHEMA,
                    code = "EVENT_CURSOR_AHEAD",
                    retryable = false,
                ),
            )
            is RelayV2RuntimeEffect.Disconnected -> {
                if (terminalFailure.get() == null) {
                    _state.value = RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.STOPPED)
                }
            }

            is RelayV2RuntimeEffect.RegisterCommandQueryAttempt,
            is RelayV2RuntimeEffect.ApplyCommandStatuses,
            ->
                failRuntimeIncomplete("COMMAND_OUTBOX_RUNTIME_UNAVAILABLE")
            is RelayV2RuntimeEffect.DeliverAgentExtensionFrame,
            is RelayV2RuntimeEffect.AgentExtensionUnavailable,
            -> failRuntimeIncomplete("AGENT_EXTENSION_RUNTIME_UNAVAILABLE")
        }
    }

    private suspend fun applyHello(effect: RelayV2RuntimeEffect.GenerationScoped) {
        requireEmptyOutboxAdmission()
        when (val applied = actor.withEffectApplyLease(effect) {
            recoveryAdapter.applyHello(effect, pendingCommands = emptyList())
        }) {
            is RelayV2EffectApplyResult.Applied -> submitRecovery(applied.value)
            RelayV2EffectApplyResult.Stale -> Unit
        }
    }

    private suspend fun applySnapshotChunk(
        effect: RelayV2RuntimeEffect.ApplyStateSnapshotChunk,
    ) {
        requireEmptyOutboxAdmission()
        when (val applied = actor.withEffectApplyLease(effect) {
            recoveryAdapter.applySnapshotChunk(effect, pendingCommands = emptyList())
        }) {
            is RelayV2EffectApplyResult.Applied -> submitRecovery(applied.value)
            RelayV2EffectApplyResult.Stale -> Unit
        }
    }

    private suspend fun completeSnapshotRelease(
        effect: RelayV2RuntimeEffect.CompleteSnapshotRelease,
    ) {
        when (val applied = actor.withEffectApplyLease(effect) {
            checkNotNull(recoveryAdapter.completeRelease(effect)) {
                "Durable snapshot release did not match the actor effect"
            }
        }) {
            is RelayV2EffectApplyResult.Applied -> submitRecovery(applied.value)
            RelayV2EffectApplyResult.Stale -> Unit
        }
    }

    private suspend fun expireSnapshot(
        effect: RelayV2RuntimeEffect.ExpireSnapshotContinuation,
    ) {
        requireEmptyOutboxAdmission()
        when (val applied = actor.withEffectApplyLease(effect) {
            checkNotNull(
                recoveryAdapter.expireContinuation(effect, pendingCommands = emptyList()),
            ) { "Durable snapshot expiry did not match the actor effect" }
        }) {
            is RelayV2EffectApplyResult.Applied -> submitRecovery(applied.value)
            RelayV2EffectApplyResult.Stale -> Unit
        }
    }

    private suspend fun applyPostHandshakeFrame(
        effect: RelayV2RuntimeEffect.DeliverPostHandshakeFrame,
    ) {
        val type = effect.message.frame["type"] as? String
        if (type !in BASE_STATE_EVENT_TYPES) {
            failRuntimeIncomplete("UNOWNED_EFFECT_${type ?: "UNKNOWN"}")
            return
        }
        requireEmptyOutboxAdmission()
        if (effect.recovery == null) {
            when (val applied = actor.withEffectApplyLease(effect) {
                recoveryAdapter.applyOnlineStateEvent(effect, pendingCommands = emptyList())
            }) {
                is RelayV2EffectApplyResult.Applied -> applied.value?.let {
                    submitOnlineResync(it)
                }
                RelayV2EffectApplyResult.Stale -> Unit
            }
        } else {
            when (val applied = actor.withEffectApplyLease(effect) {
                recoveryAdapter.applyRecoveryStateEvent(effect, pendingCommands = emptyList())
            }) {
                is RelayV2EffectApplyResult.Applied -> applied.value?.let {
                    submitRecovery(it)
                }
                RelayV2EffectApplyResult.Stale -> Unit
            }
        }
    }

    private fun requireEmptyOutboxAdmission() {
        check(admittedEmptyOutbox.get()) {
            "Relay v2 base sync has no durable empty-Outbox admission"
        }
    }

    private suspend fun submitRecovery(receipt: RelayV2RecoveryReceipt) {
        if (!actor.submitRecoveryReceipt(receipt)) {
            awaitRejectedReceiptTerminalCause()
        }
    }

    private suspend fun submitOnlineResync(receipt: RelayV2OnlineResyncRequired) {
        if (!actor.submitOnlineResyncRequired(receipt)) {
            awaitRejectedReceiptTerminalCause()
        }
    }

    private suspend fun awaitRejectedReceiptTerminalCause() {
        if (closed.get() || terminalFailure.get() != null) return
        val terminal = actor.state.first { actorState ->
            closed.get() || terminalFailure.get() != null ||
                actorState.phase in ACTOR_TERMINAL_PHASES
        }
        if (closed.get() || terminalFailure.get() != null) return
        terminal.failure?.let(::failConnection)
    }

    private fun failConnection(failure: RelayV2ConnectionFailure) {
        fail(RelayV2BaseRuntimeFailure.Connection(failure))
    }

    private fun failRuntimeIncomplete(code: String) {
        fail(RelayV2BaseRuntimeFailure.RuntimeIncomplete(code))
    }

    private fun fail(failure: RelayV2BaseRuntimeFailure) {
        if (closed.get() || !terminalFailure.compareAndSet(null, failure)) return
        synchronized(stateLock) {
            _state.value = RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.FAILED, failure)
        }
        beginActorShutdown()
    }

    private fun beginActorShutdown() {
        pumpJob.cancel()
        if (!actorShutdownStarted.compareAndSet(false, true)) return
        actor.close()
        actorScope.launch {
            try {
                actor.disconnectAndDrain(profile.identity, CLOSE_BARRIER_ID)
            } catch (_: Throwable) {
                // A forced transport-fence close completes the same shutdown barrier exceptionally.
            } finally {
                parentCompletionHandle.getAndSet(null)?.dispose()
                actorOwnerJob.cancel()
            }
        }
    }

    private fun publishActorState(actorState: RelayV2ConnectionState) {
        if (closed.get() || terminalFailure.get() != null) return
        val phase = when (actorState.phase) {
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
            RelayV2ConnectionPhase.CONTINUITY_REJECTED,
            RelayV2ConnectionPhase.FAILED,
            -> RelayV2BaseRuntimePhase.FAILED
        }
        val failure = actorState.failure?.let(RelayV2BaseRuntimeFailure::Connection)
        synchronized(stateLock) {
            if (!closed.get() && terminalFailure.get() == null) {
                _state.value = RelayV2BaseRuntimeState(phase, failure)
            }
        }
    }

    private companion object {
        val BASE_STATE_EVENT_TYPES = setOf("scopes.changed", "sessions.changed")
        const val CLOSE_BARRIER_ID = "relay-v2-base-runtime-close"
        val ACTOR_TERMINAL_PHASES = setOf(
            RelayV2ConnectionPhase.CONTINUITY_REJECTED,
            RelayV2ConnectionPhase.FAILED,
            RelayV2ConnectionPhase.DISCONNECTED,
            RelayV2ConnectionPhase.CLOSED,
        )
    }
}
