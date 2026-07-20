package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialStore
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEntry
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEffect
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxState
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxLimits
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxRuntimeAuthority
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateSyncAuthority
import java.io.Closeable
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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
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
    suspend fun readSnapshot(profile: RelayV2Profile): RelayV2OutboxState
}

/**
 * Production base-sync owner for one already-admitted Relay v2 profile activation.
 *
 * This composition owns exactly one actor, its effect pump, and their close lifecycle. It consumes
 * state-sync plus durable command query/status recovery. After the actor publishes the exact ONLINE
 * ready cut, it flushes recovered Execute capabilities in commit order and then asks the durable
 * Outbox producer for bounded fresh QUEUED batches. Retryable connection failures are redriven by
 * one bounded backoff owner after the actor's prior transport/apply fence. Agent extensions,
 * refresh, and capability advertisement remain unowned.
 */
internal class RelayV2BaseRuntimeComposition(
    parentScope: CoroutineScope,
    private val profile: RelayV2Profile,
    credentialStore: RelayV2CredentialStore,
    stateSyncAuthority: RelayV2StateSyncAuthority,
    private val activationOutbox: RelayV2ActivationOutboxReadPort,
    outboxAuthority: RelayV2OutboxRuntimeAuthority,
    transportFactory: RelayV2TransportFactory = BoundedRelayV2TransportFactory(),
    private val retryDelay: suspend (Long) -> Unit = { delay(it) },
    private val beforeHelloOutboxAdmissionRead: suspend () -> Unit = {},
    private val afterRetryableFailureAdmissionDetached: () -> Unit = {},
    private val afterActorConnectAdmissionHandoff: () -> Unit = {},
) : Closeable {
    private val closed = AtomicBoolean(false)
    private val terminalFailure = AtomicReference<RelayV2BaseRuntimeFailure?>(null)
    private val stateLock = Any()
    private val recoveredDispatchLock = Any()
    private var recoveredDispatch: RecoveredDispatchBuffer? = null
    private val connectionLock = Any()
    private var reconnectEnabled = profile.autoConnect
    private var retryFence: Any = Any()
    private var connectionAttemptJob: Job? = null
    private var retryAttempt = 0
    private var retryStateFence: RetryStateFence? = null
    private var pendingOutboxAdmission: PendingOutboxAdmission? = null
    private var boundOutboxAdmission: BoundOutboxAdmission? = null
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
        optionalCapabilities = emptySet(),
    )
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
            startInitialConnectionAttempt()
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
        connectionAttempt?.cancelAndJoin()
        clearRecoveredDispatch()
        val receipt = actor.disconnectAndDrain(expectedProfile, barrierId)
        retireConnectionAdmissions()
        return receipt
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        fenceConnectionAttempts()
        clearRecoveredDispatch()
        beginActorShutdown()
        synchronized(stateLock) {
            if (terminalFailure.get() == null) {
                _state.value = RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.STOPPED)
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

    internal suspend fun consume(effect: RelayV2RuntimeEffect) {
        when (effect) {
            is RelayV2RuntimeEffect.QueryPendingCommands -> applyHello(effect)
            is RelayV2RuntimeEffect.BeginStateResync -> applyHello(effect)
            is RelayV2RuntimeEffect.ApplyStateSnapshotChunk -> applySnapshotChunk(effect)
            is RelayV2RuntimeEffect.CompleteSnapshotRelease -> completeSnapshotRelease(effect)
            is RelayV2RuntimeEffect.ExpireSnapshotContinuation -> expireSnapshot(effect)
            is RelayV2RuntimeEffect.DeliverPostHandshakeFrame -> applyPostHandshakeFrame(effect)

            is RelayV2RuntimeEffect.ConnectionFailed -> handleConnectionFailure(effect)
            is RelayV2RuntimeEffect.ConnectRejected -> handleConnectRejected(effect)
            is RelayV2RuntimeEffect.RejectContinuity -> failConnection(
                RelayV2ConnectionFailure(
                    kind = RelayV2FailureKind.SCHEMA,
                    code = "EVENT_CURSOR_AHEAD",
                    retryable = false,
                ),
            )
            is RelayV2RuntimeEffect.Disconnected -> {
                fenceConnectionAttempts()
                retireConnectionAdmissions()
                clearRecoveredDispatch()
                if (terminalFailure.get() == null) {
                    _state.value = RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.STOPPED)
                }
            }

            is RelayV2RuntimeEffect.RegisterCommandQueryAttempt -> applyCommandQueryAttempt(effect)
            is RelayV2RuntimeEffect.ApplyCommandStatuses -> applyOutboxRecovery(effect)
            is RelayV2RuntimeEffect.DeliverAgentExtensionFrame,
            is RelayV2RuntimeEffect.AgentExtensionUnavailable,
            -> failRuntimeIncomplete("AGENT_EXTENSION_RUNTIME_UNAVAILABLE")
        }
    }

    private suspend fun applyHello(effect: RelayV2RuntimeEffect.GenerationScoped) {
        clearRecoveredDispatch()
        when (val applied = actor.withEffectApplyLease(effect) {
            beforeHelloOutboxAdmissionRead()
            val pendingCommands = admitPendingCommands(effect) ?: return@withEffectApplyLease null
            recoveryAdapter.applyHello(effect, pendingCommands)
        }) {
            is RelayV2EffectApplyResult.Applied -> applied.value?.let { submitRecovery(it) }
            RelayV2EffectApplyResult.Stale -> Unit
        }
    }

    private suspend fun applySnapshotChunk(
        effect: RelayV2RuntimeEffect.ApplyStateSnapshotChunk,
    ) {
        clearRecoveredDispatch()
        when (val applied = actor.withEffectApplyLease(effect) {
            val pendingCommands = requireOutboxAdmission(effect.generation)
            recoveryAdapter.applySnapshotChunk(effect, pendingCommands)
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
        clearRecoveredDispatch()
        when (val applied = actor.withEffectApplyLease(effect) {
            val pendingCommands = requireOutboxAdmission(effect.generation)
            checkNotNull(
                recoveryAdapter.expireContinuation(effect, pendingCommands),
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
        if (type in COMMAND_RECOVERY_TYPES) {
            applyOutboxRecovery(effect)
            return
        }
        if (type !in BASE_STATE_EVENT_TYPES) {
            failRuntimeIncomplete("UNOWNED_EFFECT_${type ?: "UNKNOWN"}")
            return
        }
        clearRecoveredDispatch()
        if (effect.recovery == null) {
            when (val applied = actor.withEffectApplyLease(effect) {
                val pendingCommands = requireOutboxAdmission(effect.generation)
                recoveryAdapter.applyOnlineStateEvent(effect, pendingCommands)
            }) {
                is RelayV2EffectApplyResult.Applied -> applied.value?.let {
                    submitOnlineResync(it)
                }
                RelayV2EffectApplyResult.Stale -> Unit
            }
        } else {
            when (val applied = actor.withEffectApplyLease(effect) {
                val pendingCommands = requireOutboxAdmission(effect.generation)
                recoveryAdapter.applyRecoveryStateEvent(effect, pendingCommands)
            }) {
                is RelayV2EffectApplyResult.Applied -> applied.value?.let {
                    submitRecovery(it)
                }
                RelayV2EffectApplyResult.Stale -> Unit
            }
        }
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
            is RelayV2OutboxQueryAdmissionApplyResult.Committed -> submitRecovery(result.receipt)
            is RelayV2OutboxQueryAdmissionApplyResult.NotOwned ->
                failRuntimeIncomplete("COMMAND_OUTBOX_QUERY_NOT_OWNED")
            is RelayV2OutboxQueryAdmissionApplyResult.Rejected,
            RelayV2OutboxQueryAdmissionApplyResult.CommitProofMismatch,
            -> failRuntimeIncomplete("COMMAND_OUTBOX_QUERY_REJECTED")
            RelayV2OutboxQueryAdmissionApplyResult.Stale -> clearRecoveredDispatch()
        }
    }

    private suspend fun applyOutboxRecovery(effect: RelayV2RuntimeEffect) {
        val result = try {
            outboxRecoveryAdapter.handle(effect)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERY_APPLY_FAILED")
            return
        }
        when (result) {
            is RelayV2OutboxRecoveryApplyResult.Committed -> {
                val commit = result.commit
                if (commit is RelayV2OutboxRecoveryCommit.CommandStatuses) {
                    applyRecoveredCommandStatuses(effect, commit, result.dispatchIssuance)
                } else if (commit.effects.isNotEmpty() ||
                    result.dispatchIssuance != RelayV2OutboxDispatchIssuance.NoDispatch
                ) {
                    clearRecoveredDispatch()
                    failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERED_DISPATCH_INVALID")
                }
            }
            is RelayV2OutboxRecoveryApplyResult.NotOwned ->
                failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERY_NOT_OWNED")
            is RelayV2OutboxRecoveryApplyResult.ProtocolViolation ->
                failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERY_PROTOCOL_VIOLATION")
            is RelayV2OutboxRecoveryApplyResult.Rejected ->
                failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERY_REJECTED")
            RelayV2OutboxRecoveryApplyResult.Stale -> clearRecoveredDispatch()
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
            is RelayV2RecoveryReceiptProcessingResult.OnlineReady -> {
                if (processed.authority != statuses.repositoryAuthority) {
                    clearRecoveredDispatch()
                    failRuntimeIncomplete("COMMAND_OUTBOX_RECOVERED_DISPATCH_STALE")
                    return
                }
                if (!markOnline(processed.authority.generation)) {
                    clearRecoveredDispatch()
                    failRuntimeIncomplete("DURABLE_OUTBOX_ADMISSION_STALE")
                    return
                }
                if (flushRecoveredDispatch(queryLineage, processed.authority)) {
                    dispatchFresh(processed.authority)
                }
            }
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
                        if (outboxDispatcher.dispatch(capability) !is
                            RelayV2OutboxDispatchOutcome.Submitted
                        ) {
                            failRuntimeIncomplete("COMMAND_OUTBOX_FRESH_DISPATCH_FAILED")
                            return
                        }
                    }
                }
            }
        }
    }

    private fun clearRecoveredDispatch() {
        synchronized(recoveredDispatchLock) { recoveredDispatch = null }
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
            is RelayV2RecoveryReceiptProcessingResult.OnlineReady -> {
                if (!markOnline(processed.authority.generation)) {
                    failRuntimeIncomplete("DURABLE_OUTBOX_ADMISSION_STALE")
                    return
                }
                dispatchFresh(processed.authority)
            }
            RelayV2RecoveryReceiptProcessingResult.StaleOrTerminal -> {
                clearRecoveredDispatch()
            }
        }
    }

    private suspend fun submitOnlineResync(receipt: RelayV2OnlineResyncRequired) {
        clearRecoveredDispatch()
        actor.submitOnlineResyncRequired(receipt)
    }

    private fun handleConnectionFailure(effect: RelayV2RuntimeEffect.ConnectionFailed) {
        val connectionAttempt = effect.connectionAttempt
        if (connectionAttempt == null) {
            failConnection(effect.failure)
            return
        }
        if (effect.failure.retryable && profile.autoConnect && effect.generation != null) {
            when (scheduleReconnect(connectionAttempt, effect.generation, effect.failure)) {
                RetryScheduleResult.SCHEDULED,
                RetryScheduleResult.FENCED,
                -> clearRecoveredDispatch()
                RetryScheduleResult.STALE -> Unit
            }
            return
        }
        val exactAttempt = detachConnectionAttempt(connectionAttempt, effect.generation)
        if (!exactAttempt) return
        clearRecoveredDispatch()
        failConnection(effect.failure)
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
        synchronized(stateLock) {
            _state.value = RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.FAILED, failure)
        }
        beginActorShutdown()
    }

    private fun beginActorShutdown() {
        if (!actorShutdownStarted.compareAndSet(false, true)) return
        actor.close()
        pumpJob.cancel()
        actorScope.launch {
            try {
                actor.disconnectAndDrain(profile.identity, CLOSE_BARRIER_ID)
            } catch (_: Throwable) {
                // A forced transport-fence close completes the same shutdown barrier exceptionally.
            } finally {
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
            RelayV2ConnectionPhase.CONTINUITY_REJECTED,
            RelayV2ConnectionPhase.FAILED,
            -> RelayV2BaseRuntimePhase.FAILED
        }
        val failure = if (retrying) {
            null
        } else {
            actorState.failure?.let(RelayV2BaseRuntimeFailure::Connection)
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
        val BASE_STATE_EVENT_TYPES = setOf("scopes.changed", "sessions.changed")
        val COMMAND_RECOVERY_TYPES = setOf("command.status", "command.result")
        const val CLOSE_BARRIER_ID = "relay-v2-base-runtime-close"
        const val MAX_RECOVERED_DISPATCH_CAPABILITIES = 4_096
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
}
