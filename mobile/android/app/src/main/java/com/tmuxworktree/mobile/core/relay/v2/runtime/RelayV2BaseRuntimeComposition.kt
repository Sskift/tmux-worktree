package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialStore
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEntry
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEffect
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxState
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxStateTag
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxRecoveryAuthority
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
 * state-sync plus durable command query/status recovery, and dispatches only Execute capabilities
 * recovered by that status flow after the actor publishes the exact ONLINE ready cut. Fresh command
 * production, terminal, Agent extensions, refresh, reconnect, and capability advertisement remain
 * unowned.
 */
internal class RelayV2BaseRuntimeComposition(
    parentScope: CoroutineScope,
    private val profile: RelayV2Profile,
    credentialStore: RelayV2CredentialStore,
    stateSyncAuthority: RelayV2StateSyncAuthority,
    private val activationOutbox: RelayV2ActivationOutboxReadPort,
    outboxAuthority: RelayV2OutboxRecoveryAuthority,
    transportFactory: RelayV2TransportFactory = BoundedRelayV2TransportFactory(),
) : Closeable {
    private val closed = AtomicBoolean(false)
    private val terminalFailure = AtomicReference<RelayV2BaseRuntimeFailure?>(null)
    private val stateLock = Any()
    private val recoveredDispatchLock = Any()
    private var recoveredDispatch: RecoveredDispatchBuffer? = null
    private val activationOutboxSnapshot = AtomicReference<ActivationOutboxSnapshot?>(null)
    private val admittedPendingCommands = AtomicReference<List<RelayV2PendingCommand>?>(null)
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
        RelayV2OutboxDispatchAuthority.recoveryComposition(actor, outboxAuthority)
    private val outboxRecoveryAdapter = outboxDispatchComposition.recoveryAdapter
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
            pumpScope.launch { connectOnce() }
        }
    }

    suspend fun disconnectAndDrain(
        expectedProfile: RelayActiveProfileIdentity,
        barrierId: String,
    ): RelayProfileDisconnectReceipt = actor.disconnectAndDrain(expectedProfile, barrierId)

    override fun close() {
        val shouldClose = synchronized(recoveredDispatchLock) {
            if (!closed.compareAndSet(false, true)) {
                false
            } else {
                recoveredDispatch = null
                true
            }
        }
        if (!shouldClose) return
        beginActorShutdown()
        synchronized(stateLock) {
            if (terminalFailure.get() == null) {
                _state.value = RelayV2BaseRuntimeState(RelayV2BaseRuntimePhase.STOPPED)
            }
        }
    }

    private suspend fun connectOnce() {
        val snapshot = try {
            activationOutbox.readSnapshot(profile).toActivationSnapshot(profile)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            failRuntimeIncomplete("DURABLE_OUTBOX_ADMISSION_FAILED")
            return
        }
        activationOutboxSnapshot.set(snapshot)
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
        val pendingCommands = admitPendingCommands(effect) ?: return
        when (val applied = actor.withEffectApplyLease(effect) {
            recoveryAdapter.applyHello(effect, pendingCommands)
        }) {
            is RelayV2EffectApplyResult.Applied -> submitRecovery(applied.value)
            RelayV2EffectApplyResult.Stale -> Unit
        }
    }

    private suspend fun applySnapshotChunk(
        effect: RelayV2RuntimeEffect.ApplyStateSnapshotChunk,
    ) {
        clearRecoveredDispatch()
        val pendingCommands = requireOutboxAdmission()
        when (val applied = actor.withEffectApplyLease(effect) {
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
        val pendingCommands = requireOutboxAdmission()
        when (val applied = actor.withEffectApplyLease(effect) {
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
        val pendingCommands = requireOutboxAdmission()
        if (effect.recovery == null) {
            when (val applied = actor.withEffectApplyLease(effect) {
                recoveryAdapter.applyOnlineStateEvent(effect, pendingCommands)
            }) {
                is RelayV2EffectApplyResult.Applied -> applied.value?.let {
                    submitOnlineResync(it)
                }
                RelayV2EffectApplyResult.Stale -> Unit
            }
        } else {
            when (val applied = actor.withEffectApplyLease(effect) {
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
                flushRecoveredDispatch(queryLineage, processed.authority)
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
    ) {
        var failureCode: String? = null
        synchronized(recoveredDispatchLock) {
            if (closed.get() || terminalFailure.get() != null) {
                recoveredDispatch = null
                return
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
                RelayV2OutboxStateTag.QUEUED ->
                    error("Queued Relay v2 Outbox commands have no production dispatcher")
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
        val context = when (effect) {
            is RelayV2RuntimeEffect.QueryPendingCommands -> effect.context
            is RelayV2RuntimeEffect.BeginStateResync -> effect.context
            else -> error("Effect is not a Relay v2 hello apply")
        }
        val snapshot = checkNotNull(activationOutboxSnapshot.get()) {
            "Relay v2 runtime has no exact activation Outbox snapshot"
        }
        if (snapshot.activeEntries.any {
                it.hostId != context.hostId || it.expectedHostEpoch != context.hostEpoch
            }
        ) {
            failRuntimeIncomplete("DURABLE_OUTBOX_FOREIGN_ACTIVE_LINEAGE")
            return null
        }
        val pending = snapshot.activeEntries.map { entry ->
            RelayV2PendingCommand(entry.commandId, entry.dedupeWindowId)
        }
        val prior = admittedPendingCommands.get()
        if (prior != null) {
            if (prior != pending) {
                failRuntimeIncomplete("DURABLE_OUTBOX_ADMISSION_CHANGED")
                return null
            }
            return prior
        }
        if (!admittedPendingCommands.compareAndSet(null, pending)) {
            return requireOutboxAdmission()
        }
        return pending
    }

    private fun requireOutboxAdmission(): List<RelayV2PendingCommand> =
        checkNotNull(admittedPendingCommands.get()) {
            "Relay v2 base sync has no exact activation Outbox admission"
        }

    private suspend fun submitRecovery(receipt: RelayV2RecoveryReceipt) {
        when (actor.processRecoveryReceipt(receipt)) {
            RelayV2RecoveryReceiptProcessingResult.ContinuedRecovery,
            is RelayV2RecoveryReceiptProcessingResult.OnlineReady,
            -> Unit
            RelayV2RecoveryReceiptProcessingResult.StaleOrTerminal -> {
                clearRecoveredDispatch()
            }
        }
    }

    private suspend fun submitOnlineResync(receipt: RelayV2OnlineResyncRequired) {
        clearRecoveredDispatch()
        actor.submitOnlineResyncRequired(receipt)
    }

    private fun failConnection(failure: RelayV2ConnectionFailure) {
        fail(RelayV2BaseRuntimeFailure.Connection(failure))
    }

    private fun failRuntimeIncomplete(code: String) {
        fail(RelayV2BaseRuntimeFailure.RuntimeIncomplete(code))
    }

    private fun fail(failure: RelayV2BaseRuntimeFailure) {
        val shouldFail = synchronized(recoveredDispatchLock) {
            if (closed.get() || !terminalFailure.compareAndSet(null, failure)) {
                false
            } else {
                recoveredDispatch = null
                true
            }
        }
        if (!shouldFail) return
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
        val COMMAND_RECOVERY_TYPES = setOf("command.status", "command.result")
        const val CLOSE_BARRIER_ID = "relay-v2-base-runtime-close"
        const val MAX_RECOVERED_DISPATCH_CAPABILITIES = 4_096
    }

    private data class ActivationOutboxSnapshot(
        val activeEntries: List<RelayV2OutboxEntry>,
    )

    private data class RecoveredDispatchLineage(
        val queryLineage: RelayV2QueryRecoveryLineage,
        val authority: RelayV2RepositoryEffectAuthority,
    )

    private data class RecoveredDispatchBuffer(
        val lineage: RecoveredDispatchLineage,
        val capabilities: ArrayList<RelayV2OutboxDispatchCapability>,
    )
}
