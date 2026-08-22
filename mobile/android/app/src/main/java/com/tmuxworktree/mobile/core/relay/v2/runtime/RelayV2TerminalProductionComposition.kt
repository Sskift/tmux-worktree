package com.tmuxworktree.mobile.core.relay.v2.runtime

import android.util.Log
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2DecodedMessage
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalCheckpointKey
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2DetachedTerminalErrorResult
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2DetachedTerminalOpenedResult
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalPostCommitJournalStore
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalRecoveryAuthority
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalResumeSessionSelector
import com.tmuxworktree.mobile.core.relay.v2.terminal.*
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal interface RelayV2TerminalAttachment

internal enum class RelayV2TerminalFrameResult { Applied, NotOwned, ProtocolViolation, EffectRejected }

internal data class RelayV2TerminalResetSuccessor(
    val requestId: String,
    val openId: String,
) {
    init {
        require(requestId.isNotBlank())
        require(openId.isNotBlank())
    }
}

internal interface RelayV2TerminalAttachmentObserver {
    fun opened(streamId: String)
    fun reset(reason: RelayV2TerminalResetReason)
    /** Synchronous budget gate before composition commits/sends a RESET successor. */
    fun admitResetSuccessor(reason: RelayV2TerminalResetReason): Boolean = true
    /**
     * The composition already committed and sent the exact fresh RESET successor. Presentation
     * may show recovery and rebind its watchdog, but must retain this attachment and must not issue
     * a second open. Observers that do not distinguish ownership conservatively replace it.
     */
    fun resetSuccessorIssued(
        reason: RelayV2TerminalResetReason,
        successor: RelayV2TerminalResetSuccessor,
    ) {
        reset(reason)
    }
    fun closed(reason: RelayV2TerminalCloseReason)
    fun openRejected(error: RelayV2TerminalCorrelatedError) {
        reset(RelayV2TerminalResetReason.STREAM_LOST)
    }
    /** A durably correlated error arrived after this attachment's parser had been detached. */
    fun detachedOpenRejected(error: RelayV2TerminalCorrelatedError) = Unit

    /**
     * A current terminal.opened response raced after parser detach. The exact actor generation is
     * already withdrawn; presentation may reattach only if this route is still current.
     */
    fun detachedOpenRetryRequired() = Unit
}

internal object RelayV2TerminalNoopAttachmentObserver : RelayV2TerminalAttachmentObserver {
    override fun opened(streamId: String) = Unit
    override fun reset(reason: RelayV2TerminalResetReason) = Unit
    override fun closed(reason: RelayV2TerminalCloseReason) = Unit
}

/**
 * Older hosts may surface authority pressure directly as terminal.*_error instead of retaining it
 * behind their retry scheduler. Treat retryable foreign codes like a GAP (safe replay), while a
 * definitive/ambiguous rejection resets this terminal generation instead of escalating one
 * extension frame into a base Relay protocol failure.
 */
internal fun relayV2TerminalControlError(
    code: String,
    retryable: Boolean,
): RelayV2TerminalControlError = when (code) {
    "TERMINAL_INPUT_GAP", "TERMINAL_RESIZE_GAP" -> RelayV2TerminalControlError.GAP
    "TERMINAL_INPUT_CONFLICT", "TERMINAL_RESIZE_CONFLICT" ->
        RelayV2TerminalControlError.CONFLICT
    else -> if (retryable) RelayV2TerminalControlError.GAP
    else RelayV2TerminalControlError.CONFLICT
}

internal data class RelayV2TerminalAttachmentTarget(
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val scopeId: String,
    val sessionId: String,
    val pane: Int = 0,
)

/**
 * Single production terminal owner for one base composition.
 *
 * The owner binds one model-issued Session target to one parser callback port. Room owns terminal
 * checkpoints, the durable sink owns callback post-commit batches, and the actor remains the sole
 * transport/generation authority. No callback can reconstruct authority from public frame fields.
 */
internal class RelayV2TerminalProductionComposition(
    private val applyLease: RelayV2RepositoryEffectApplyLeasePort,
    private val terminal: RelayV2TerminalRecoveryAuthority,
    journal: RelayV2TerminalPostCommitJournalStore,
    private val credentials: RelayV2TerminalResumeCredentialStore,
    sendPort: RelayV2TerminalExactGenerationSendPort,
    private val fatalInvalidation: RelayV2TerminalFatalInvalidationPort,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    internal data class RecoveryAdmission(
        val connectionGenerationFloor: Long,
    )

    private class Attachment(
        val origin: RelayV2TerminalProductionComposition,
        val target: RelayV2TerminalAttachmentTarget,
        val parser: RelayV2TerminalParserPort,
        val observer: RelayV2TerminalAttachmentObserver,
        var parserContinuityId: String? = null,
        /** One idempotent close intent, consumed by active or exact detached authority. */
        var closeIntent: RelayV2TerminalPendingClose? = null,
        /** Last exact durable lineage; retained across actor teardown for a later close claim. */
        var durableKey: RelayV2TerminalCheckpointKey? = null,
    ) : RelayV2TerminalAttachment

    private data class Active(
        val attachment: Attachment,
        val authority: RelayV2RepositoryEffectAuthority,
        val key: RelayV2TerminalCheckpointKey,
        val delivery: RelayV2TerminalDeliveryToken,
        val openAttempt: RelayV2TerminalOpenAttempt,
        val requestId: String,
        val parserContinuityId: String,
        val cols: Int,
        val rows: Int,
    )

    private class Detached(
        val active: Active,
    ) {
        var openedRecoverySignalled: Boolean = false
    }

    /** Renderer-free exact owner. It may consume frames but never parser/input mutations. */
    private data class Suspended(val active: Active)

    /** Exact response owner retained until terminal.closed durably finalizes the close. */
    private data class Closing(val active: Active)

    private data class OpenedFrameAdmission(
        val action: RelayV2TerminalAction.Opened,
        val token: String,
        val reference: String,
        val previousReference: String?,
    )

    private val lock = Any()
    private val lifecycleMutex = Mutex()
    private var attachment: Attachment? = null
    private var active: Active? = null
    private var detached: Detached? = null
    private var suspended: Suspended? = null
    private var closing: Closing? = null
    private var closed = false
    private val wire = RelayV2TerminalControlCodecBridge(sendPort)
    private val parserProxy = object : RelayV2TerminalParserPort {
        override suspend fun write(
            callbackToken: RelayV2TerminalParserCallbackToken,
            bytes: ByteArray,
            completion: suspend (Boolean) -> Unit,
        ): Boolean = currentParser(callbackToken)?.write(callbackToken, bytes, completion) ?: false

        override suspend fun reset(
            callbackToken: RelayV2TerminalParserCallbackToken,
            completion: suspend (Boolean) -> Unit,
        ): Boolean = currentParser(callbackToken)?.reset(callbackToken, completion) ?: false
    }
    private val sink = RelayV2DurableTerminalPostCommitEffectSink(
        journal = journal,
        executor = RelayV2TerminalSynchronousEffectExecutor(::executePostCommitEffect),
    )
    private val runtime = RelayV2TerminalRuntimeAdapter(
        applyLease = applyLease,
        terminal = terminal,
        parser = parserProxy,
        postCommitEffects = sink,
        control = wire,
        fatalInvalidation = object : RelayV2TerminalFatalInvalidationPort {
            override suspend fun invalidate(
                authority: RelayV2RepositoryEffectAuthority,
                key: RelayV2TerminalCheckpointKey,
                reason: RelayV2TerminalFatalInvalidationReason,
            ) {
                // The Base port first withdraws the exact actor generation. Only after that proof
                // may UI detach the old renderer and wait for the successor generation.
                this@RelayV2TerminalProductionComposition.fatalInvalidation.invalidate(
                    authority,
                    key,
                    reason,
                )
                synchronized(lock) {
                    active?.takeIf { it.authority == authority && it.key == key }
                }?.attachment?.observer?.reset(RelayV2TerminalResetReason.STREAM_LOST)
            }
        },
        terminalScopedReset = RelayV2TerminalScopedResetPort(
            ::normalizePreActivationFailure,
        ),
    )

    private suspend fun normalizePreActivationFailure(
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
    ): Boolean {
        val current = synchronized(lock) {
            active?.takeIf { it.authority == authority && it.key == key }
        } ?: return false
        // A durable sink fence means an older external effect is still uncertain. Rotating the
        // Base generation is then mandatory; a same-generation RESET would be rejected forever.
        if (!sink.isAuthorityReusable(authority, key)) return false
        val normalized = terminal.recoverPostCommitUnknownWithContinuity(
            authority,
            key,
            current.parserContinuityId,
        ) ?: return false
        val checkpoint = normalized.checkpoint ?: return false
        val reset = normalized.outcome as? RelayV2TerminalOutcome.ResetRequired ?: return false
        if (checkpoint.phase != RelayV2TerminalPhase.RESET_REQUIRED ||
            checkpoint.pendingParserDispatchClaim != null ||
            checkpoint.pendingParserEffectHandoff != null ||
            checkpoint.pendingParserEffectHandoffResetReason != null ||
            checkpoint.pendingParserEffectActivation != null ||
            checkpoint.parserInFlightCallbackToken != null ||
            checkpoint.parserResetCallbackToken != null
        ) {
            return false
        }
        // If detach won the race, its teardown already notified that attachment. Otherwise this
        // is the exact current observer and is the handoff that lets UI replace it with RESET.
        current.attachment.observer.reset(reset.reason)
        return true
    }

    suspend fun recoverBeforeAdmission(): RecoveryAdmission? = lifecycleMutex.withLock {
        val recovered = sink.recover()
        if (recovered.globallyClosed) return null
        val lineagesRecovered = recovered.recoveredLineages.all { lineage ->
            lineage.disposition == RelayV2TerminalResetDisposition.STREAM_LOST &&
                terminal.recoverPostCommitUnknown(lineage.authority, lineage.key) != null
        }
        if (!lineagesRecovered) return null
        RecoveryAdmission(recovered.connectionGenerationFloor)
    }

    suspend fun attach(
        target: RelayV2TerminalAttachmentTarget,
        parser: RelayV2TerminalParserPort,
        observer: RelayV2TerminalAttachmentObserver = RelayV2TerminalNoopAttachmentObserver,
    ): RelayV2TerminalAttachment = lifecycleMutex.withLock {
        require(target.profileActivationGeneration > 0 && target.pane >= 0)
        val issued = Attachment(this, target, parser, observer)
        val previous = synchronized(lock) {
            check(!closed) { "Terminal composition is closed" }
            attachment = issued
            active.also { current ->
                active = null
                if (current != null) detached = current.detached()
            }
        }
        if (previous != null) teardownActive(previous)
        return issued
    }

    suspend fun open(
        issued: RelayV2TerminalAttachment,
        authority: RelayV2RepositoryEffectAuthority,
        cols: Int,
        rows: Int,
    ): Boolean = lifecycleMutex.withLock {
        val handle = issued as? Attachment ?: return false
        if (handle.origin !== this || !matches(handle.target, authority)) return false
        synchronized(lock) {
            if (closed || attachment !== handle || active != null) return false
        }
        val requestId = newId()
        val attempt = RelayV2TerminalOpenAttempt(
            newId(),
            newId(),
        )
        val attachmentParserContinuityId = handle.parserContinuityId ?: newId().also {
            handle.parserContinuityId = it
        }
        val claimed = terminal.claimResumableTerminalUnderApplyLease(
            selector = RelayV2TerminalResumeSessionSelector(
                profileId = handle.target.profileId,
                profileActivationGeneration = handle.target.profileActivationGeneration,
                principalId = handle.target.principalId,
                clientInstanceId = handle.target.clientInstanceId,
                hostId = handle.target.hostId,
                scopeId = handle.target.scopeId,
                sessionId = handle.target.sessionId,
                pane = handle.target.pane,
            ),
            authority = authority,
            requestId = requestId,
            openAttempt = attempt,
            cols = cols,
            rows = rows,
        )
        var reduction: RelayV2TerminalReduction
        val key: RelayV2TerminalCheckpointKey
        var openEffect: RelayV2TerminalEffect.SendOpen
        if (claimed != null) {
            reduction = claimed.reduction
            key = claimed.key
            (reduction.preOpenCheckpoint?.pendingClose
                ?: reduction.checkpoint?.pendingClose)?.let { durableClose ->
                handle.closeIntent = durableClose
            }
            openEffect = reduction.effects.filterIsInstance<RelayV2TerminalEffect.SendOpen>()
                .singleOrNull() ?: return dispatchClaimWithoutOpen(handle, authority, key, reduction)
        } else {
            val delivery = RelayV2TerminalDeliveryToken(authority.generation, 1, 1)
            val target = RelayV2TerminalOpenTarget(
                profileId = authority.profileId,
                profileActivationGeneration = authority.profileActivationGeneration,
                principalId = authority.principalId,
                clientInstanceId = authority.clientInstanceId,
                hostId = authority.hostId,
                hostEpoch = authority.hostEpoch,
                scopeId = handle.target.scopeId,
                sessionId = handle.target.sessionId,
                streamId = newId(),
                pane = handle.target.pane,
            )
            key = RelayV2TerminalCheckpointKey.from(target)
            reduction = terminal.reduceTerminalUnderApplyLease(
                key,
                RelayV2TerminalAction.BeginOpenAttempt(
                    deliveryToken = delivery,
                    requestId = requestId,
                    openAttempt = attempt,
                    mode = RelayV2TerminalOpenMode.NEW,
                    cols = cols,
                    rows = rows,
                    target = target,
                    parserContinuityId = attachmentParserContinuityId,
                    resume = null,
                ),
            )
            openEffect = reduction.effects.filterIsInstance<RelayV2TerminalEffect.SendOpen>()
                .single()
        }
        if (openEffect.mode == RelayV2TerminalOpenMode.RESUME &&
            openEffect.openFence.parserContinuityId != attachmentParserContinuityId
        ) {
            val resumed = reduction.checkpoint ?: return false
            val continuityLost = terminal.reduceTerminalUnderApplyLease(
                key,
                RelayV2TerminalAction.VerifyContinuity(
                    identity = resumed.identity,
                    deliveryToken = resumed.deliveryToken,
                    parserContinuityId = attachmentParserContinuityId,
                ),
            )
            val reset = continuityLost.checkpoint?.takeIf {
                it.phase == RelayV2TerminalPhase.RESET_REQUIRED &&
                    it.resetReason == RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST
            } ?: return false
            reduction = terminal.reduceTerminalUnderApplyLease(
                key,
                RelayV2TerminalAction.BeginOpenAttempt(
                    deliveryToken = reset.deliveryToken,
                    requestId = newId(),
                    openAttempt = attempt,
                    mode = RelayV2TerminalOpenMode.RESET,
                    cols = openEffect.cols,
                    rows = openEffect.rows,
                    target = reset.identity.target(),
                    parserContinuityId = attachmentParserContinuityId,
                    resume = RelayV2TerminalOpenResume(
                        generation = reset.identity.generation,
                        nextOffset = null,
                        resumeTokenCredentialReference =
                            reset.identity.resumeTokenCredentialReference,
                        resumeTokenCredentialFingerprint =
                            reset.identity.resumeTokenCredentialFingerprint,
                    ),
                ),
            )
            openEffect = reduction.effects.filterIsInstance<RelayV2TerminalEffect.SendOpen>()
                .singleOrNull() ?: return false
        } else if (openEffect.mode != RelayV2TerminalOpenMode.RESUME) {
            // NEW has not populated a renderer yet; RESET explicitly initializes it. In both
            // cases this exact attachment can safely adopt the durable open lineage.
            handle.parserContinuityId = openEffect.openFence.parserContinuityId
        }
        val state = Active(
            handle,
            authority,
            key,
            openEffect.openFence.deliveryToken,
            openEffect.openFence.openAttempt,
            openEffect.requestId,
            openEffect.openFence.parserContinuityId,
            openEffect.cols,
            openEffect.rows,
        )
        handle.durableKey = key
        synchronized(lock) {
            if (closed || attachment !== handle || active != null) return false
            active = state
            // The fresh active owner uses the same durable checkpoint and can correlate every
            // retained issued request itself. Drop the detached presentation closure promptly.
            detached = null
            suspended = null
            closing = null
        }
        return dispatchReduction(state, reduction)
    }

    private suspend fun dispatchClaimWithoutOpen(
        handle: Attachment,
        authority: RelayV2RepositoryEffectAuthority,
        key: RelayV2TerminalCheckpointKey,
        reduction: RelayV2TerminalReduction,
    ): Boolean {
        val checkpoint = reduction.checkpoint ?: return false
        val closeOnlyRecovery = checkpoint.pendingClose != null &&
            reduction.effects.count { it is RelayV2TerminalEffect.SendClose } == 1
        val state = Active(
            handle,
            authority,
            key,
            checkpoint.deliveryToken,
            checkpoint.openAttempt,
            checkpoint.pendingOpen?.requestId ?: newId(),
            checkpoint.parserContinuityId,
            checkpoint.openedCols,
            checkpoint.openedRows,
        )
        if (closeOnlyRecovery) {
            synchronized(lock) {
                if (closed || attachment !== handle || active != null) return false
                active = null
                detached = null
                suspended = null
                closing = Closing(state)
            }
            handle.durableKey = key
            val dispatched = dispatchReduction(state, reduction)
            if (!dispatched) synchronized(lock) {
                if (closing?.active === state) closing = null
            }
            return dispatched
        }
        synchronized(lock) {
            if (closed || attachment !== handle || active != null) return false
            active = state
            detached = null
            suspended = null
            closing = null
        }
        handle.durableKey = key
        return dispatchReduction(state, reduction)
    }

    suspend fun enqueueInput(
        issued: RelayV2TerminalAttachment,
        authority: RelayV2RepositoryEffectAuthority,
        bytes: ByteArray,
    ): Boolean = lifecycleMutex.withLock {
        mutateCurrent(issued, authority) { state, checkpoint ->
            // Input cannot be attributed until the current open response fixes the generation.
            // In particular, do not let RESET_REQUIRED's generic reducer branch emit another
            // reset and detach the owner that must receive terminal.opened.
            if (checkpoint.openIsPending()) return@mutateCurrent null
            terminal.reduceTerminalUnderApplyLease(
                state.key,
                RelayV2TerminalAction.EnqueueInput(
                    checkpoint.deliveryToken,
                    RelayV2TerminalBytes.of(bytes),
                ),
            )
        }
    }

    suspend fun enqueueResize(
        issued: RelayV2TerminalAttachment,
        authority: RelayV2RepositoryEffectAuthority,
        cols: Int,
        rows: Int,
    ): Boolean = lifecycleMutex.withLock {
        if (cols !in 1..1000 || rows !in 1..500) return@withLock false
        mutateCurrent(issued, authority) { state, checkpoint ->
            // terminal.open already carries the authoritative opening dimensions. onReady/IME
            // fit bursts while that request is pending are safe no-ops; opened/resetParser will
            // produce a fresh fit after the generation is bound.
            if (checkpoint.openIsPending()) {
                return@mutateCurrent RelayV2TerminalReduction(
                    checkpoint = checkpoint,
                    outcome = RelayV2TerminalOutcome.Ignored(
                        RelayV2TerminalIgnoredReason.STALE_DELIVERY,
                    ),
                    effects = emptyList(),
                )
            }
            terminal.reduceTerminalUnderApplyLease(
                state.key,
                RelayV2TerminalAction.EnqueueResize(checkpoint.deliveryToken, cols, rows),
            )
        }
    }

    suspend fun close(
        issued: RelayV2TerminalAttachment,
        authority: RelayV2RepositoryEffectAuthority,
    ): Boolean = lifecycleMutex.withLock {
        mutateCurrent(issued, authority) { state, checkpoint ->
            val closeId = newId()
            terminal.reduceTerminalUnderApplyLease(
                state.key,
                RelayV2TerminalAction.RequestClose(
                    checkpoint.deliveryToken,
                    RelayV2TerminalCloseAttempt(
                        closeId,
                        fingerprint(checkpoint.identity.target(), newId(), closeId, 0, 0),
                    ),
                    newId(),
                ),
            )
        }
    }

    /**
     * Idempotently closes the exact attachment even after local parser detach. A PreOpen owner
     * retains the intent until its correlated opened response can atomically become pending-close.
     */
    suspend fun ensureCloseForDetach(
        issued: RelayV2TerminalAttachment,
        authority: RelayV2RepositoryEffectAuthority,
    ): Boolean = lifecycleMutex.withLock {
        val handle = issued as? Attachment ?: return@withLock false
        if (handle.origin !== this) return@withLock false
        val retainedKey = handle.durableKey
        if (retainedKey != null && synchronized(lock) {
                closing?.active?.let {
                    it.authority == authority && it.key == retainedKey
                } == true
            }
        ) return@withLock true
        val state = synchronized(lock) {
            active?.takeIf {
                it.attachment === handle && it.authority == authority
            } ?: detached?.active?.takeIf {
                it.attachment === handle && it.authority == authority
            } ?: suspended?.active?.takeIf {
                it.attachment === handle && it.authority == authority
            } ?: closing?.active?.takeIf {
                it.attachment === handle && it.authority == authority
            }
        }
        if (state == null) {
            val key = retainedKey ?: return@withLock false
            val stored = terminal.loadTerminalUnderApplyLease(key)
            val durableIntent = when (stored) {
                is RelayV2TerminalStoredCheckpoint.PreOpen -> stored.checkpoint.pendingClose
                is RelayV2TerminalStoredCheckpoint.Present ->
                    stored.checkpoint.pendingClose ?: stored.checkpoint.pendingCloseWhenOpened
                RelayV2TerminalStoredCheckpoint.Missing,
                is RelayV2TerminalStoredCheckpoint.Invalid,
                -> null
            }
            val intent = durableIntent?.also { handle.closeIntent = it }
                ?: ensureCloseIntent(handle, key.toTarget())
            var pendingOpenForClose = stored is RelayV2TerminalStoredCheckpoint.PreOpen
            if (stored is RelayV2TerminalStoredCheckpoint.PreOpen &&
                stored.checkpoint.pendingClose == null
            ) {
                val ensured = terminal.ensureTerminalCloseWhenOpenedUnderApplyLease(
                    authority = authority,
                    key = key,
                    pendingClose = intent,
                ) ?: return@withLock false
                if (ensured.preOpenCheckpoint?.pendingClose != intent ||
                    ensured.effects.isNotEmpty()
                ) return@withLock false
            }
            if (stored is RelayV2TerminalStoredCheckpoint.Present) {
                val claim = terminal.claimTerminalCloseUnderApplyLease(
                    authority = authority,
                    key = key,
                    pendingClose = intent,
                ) ?: return@withLock false
                val checkpoint = claim.reduction.checkpoint ?: return@withLock false
                val claimedState = Active(
                    attachment = handle,
                    authority = authority,
                    key = claim.key,
                    delivery = checkpoint.deliveryToken,
                    openAttempt = checkpoint.openAttempt,
                    requestId = checkpoint.pendingOpen?.requestId ?: newId(),
                    parserContinuityId = checkpoint.parserContinuityId,
                    cols = checkpoint.openedCols,
                    rows = checkpoint.openedRows,
                )
                if (checkpoint.pendingCloseWhenOpened == null) {
                    synchronized(lock) {
                        if (closed || active != null) return@withLock false
                        closing = Closing(claimedState)
                        suspended = null
                        detached = null
                    }
                    return@withLock dispatchReduction(claimedState, claim.reduction)
                }
                // Persist and send the discard ACK under the exact rebound authority before the
                // recovery claim advances its delivery token.
                if (!dispatchReduction(claimedState, claim.reduction)) return@withLock false
                pendingOpenForClose = true
            }
            if (!pendingOpenForClose) return@withLock false
            val present = (terminal.loadTerminalUnderApplyLease(key)
                as? RelayV2TerminalStoredCheckpoint.Present)?.checkpoint
            val cols = present?.pendingOpen?.cols ?: present?.openedCols ?: 80
            val rows = present?.pendingOpen?.rows ?: present?.openedRows ?: 24
            val claimed = terminal.claimResumableTerminalUnderApplyLease(
                selector = RelayV2TerminalResumeSessionSelector(
                    profileId = handle.target.profileId,
                    profileActivationGeneration = handle.target.profileActivationGeneration,
                    principalId = handle.target.principalId,
                    clientInstanceId = handle.target.clientInstanceId,
                    hostId = handle.target.hostId,
                    scopeId = handle.target.scopeId,
                    sessionId = handle.target.sessionId,
                    pane = handle.target.pane,
                ),
                authority = authority,
                requestId = newId(),
                openAttempt = RelayV2TerminalOpenAttempt(newId(), newId()),
                cols = cols,
                rows = rows,
            ) ?: return@withLock false
            val open = claimed.reduction.effects
                .filterIsInstance<RelayV2TerminalEffect.SendOpen>()
                .singleOrNull() ?: return@withLock false
            val rebound = Active(
                attachment = handle,
                authority = authority,
                key = claimed.key,
                delivery = open.openFence.deliveryToken,
                openAttempt = open.openFence.openAttempt,
                requestId = open.requestId,
                parserContinuityId = open.openFence.parserContinuityId,
                cols = open.cols,
                rows = open.rows,
            )
            handle.durableKey = claimed.key
            synchronized(lock) {
                if (closed || active != null) return@withLock false
                closing = Closing(rebound)
                suspended = null
                detached = null
            }
            return@withLock dispatchReduction(rebound, claimed.reduction)
        }
        when (val stored = terminal.loadTerminalUnderApplyLease(state.key)) {
            is RelayV2TerminalStoredCheckpoint.PreOpen -> {
                val checkpoint = stored.checkpoint
                if (checkpoint.target != state.key.toTarget() ||
                    checkpoint.deliveryToken.actorGeneration != authority.generation
                ) return@withLock false
                val intent = ensureCloseIntent(handle, checkpoint.target)
                terminal.ensureTerminalCloseWhenOpenedUnderApplyLease(
                    authority = authority,
                    key = state.key,
                    pendingClose = intent,
                )?.let { reduction ->
                    reduction.outcome == RelayV2TerminalOutcome.Applied &&
                        reduction.effects.isEmpty() &&
                        reduction.preOpenCheckpoint?.pendingClose == intent
                } == true
            }
            is RelayV2TerminalStoredCheckpoint.Present -> {
                val checkpoint = stored.checkpoint
                if (checkpoint.identity.target() != state.key.toTarget() ||
                    checkpoint.deliveryToken.actorGeneration != authority.generation
                ) return@withLock false
                val intent = (checkpoint.pendingClose ?: checkpoint.pendingCloseWhenOpened)
                    ?.also { handle.closeIntent = it }
                    ?: ensureCloseIntent(handle, checkpoint.identity.target())
                if (checkpoint.closed != null ||
                    checkpoint.phase == RelayV2TerminalPhase.FINALIZED
                ) return@withLock true
                if (checkpoint.pendingOpen != null ||
                    checkpoint.pendingCloseWhenOpened != null
                ) {
                    val closeOnOpen = terminal.ensureTerminalCloseWhenOpenedUnderApplyLease(
                        authority = authority,
                        key = state.key,
                        pendingClose = intent,
                    ) ?: return@withLock false
                    val closeOnOpenCheckpoint = closeOnOpen.checkpoint
                        ?: return@withLock false
                    if (closeOnOpenCheckpoint.pendingCloseWhenOpened != intent ||
                        closeOnOpen.effects.any {
                            it is RelayV2TerminalEffect.SendClose ||
                                it is RelayV2TerminalEffect.WriteParser ||
                                it is RelayV2TerminalEffect.ResetParser
                        }
                    ) return@withLock false
                    synchronized(lock) {
                        if (active === state) active = null
                        if (detached?.active === state) detached = null
                        if (suspended?.active === state) suspended = null
                        closing = Closing(state)
                    }
                    return@withLock dispatchReduction(state, closeOnOpen)
                }
                val reduction = terminal.claimTerminalCloseUnderApplyLease(
                    authority = authority,
                    key = state.key,
                    pendingClose = intent,
                )?.reduction ?: return@withLock false
                if (reduction.checkpoint?.pendingClose != intent ||
                    reduction.effects.count { it is RelayV2TerminalEffect.SendClose } != 1 ||
                    reduction.effects.any {
                        it is RelayV2TerminalEffect.WriteParser ||
                            it is RelayV2TerminalEffect.ResetParser
                    }
                ) return@withLock false
                synchronized(lock) {
                    if (active === state) active = null
                    if (detached?.active === state) detached = null
                    if (suspended?.active === state) suspended = null
                    closing = Closing(state)
                }
                dispatchReduction(state, reduction)
            }
            is RelayV2TerminalStoredCheckpoint.Invalid,
            RelayV2TerminalStoredCheckpoint.Missing,
            -> false
        }
    }

    suspend fun handlePublicFrame(
        authority: RelayV2RepositoryEffectAuthority,
        message: RelayV2DecodedMessage,
    ): RelayV2TerminalFrameResult = lifecycleMutex.withLock {
        val frame = message.frame
        val type = frame["type"] as? String ?: return RelayV2TerminalFrameResult.NotOwned
        if (type in TERMINAL_LIFECYCLE_DIAGNOSTIC_TYPES) {
            logTerminalLifecycle(
                "terminal frame received type=$type request=${frame["requestId"] ?: "none"} " +
                    "error=${(frame["error"] as? Map<*, *>)?.get("code") ?: "none"}",
            )
        }
        if (type in TERMINAL_EXACT_GENERATION_TYPES) {
            val payload = frame["payload"] as? Map<*, *>
                ?: return RelayV2TerminalFrameResult.ProtocolViolation
            if (payload["generation"] !is String) {
                return RelayV2TerminalFrameResult.ProtocolViolation
            }
        }
        val state = synchronized(lock) { active }
            ?.takeIf { it.authority == authority }
        if (state == null) {
            val closeOnly = synchronized(lock) { closing }
                ?.takeIf { it.active.authority == authority }
            if (closeOnly != null) {
                return handleRendererFreeFrame(closeOnly.active, frame, type, closingOwner = true)
            }
            val suspendedOwner = synchronized(lock) { suspended }
                ?.takeIf { it.active.authority == authority }
            if (suspendedOwner != null) {
                return handleRendererFreeFrame(
                    suspendedOwner.active,
                    frame,
                    type,
                    closingOwner = false,
                )
            }
            return when (type) {
                "error" -> handleDetachedError(authority, frame)
                "terminal.opened" -> handleDetachedOpened(authority, frame)
                else -> RelayV2TerminalFrameResult.NotOwned
            }
        }
        val streamId = frame["streamId"] as? String
        if (type == "error") {
            val stored = terminal.loadTerminalUnderApplyLease(state.key)
            if (stored is RelayV2TerminalStoredCheckpoint.PreOpen) {
                val action = actionForGenericError(frame)
                val rejected = terminal.reduceTerminalUnderApplyLease(state.key, action)
                if (rejected.outcome !is RelayV2TerminalOutcome.CorrelatedErrorRejected) {
                    return dispatchFrameReduction(state, rejected)
                }
                val pending = stored.checkpoint.pendingOpen
                    ?: return RelayV2TerminalFrameResult.ProtocolViolation
                val reset = terminal.reduceTerminalUnderApplyLease(
                    state.key,
                    RelayV2TerminalAction.PreOpenResetRequired(
                        fence = RelayV2TerminalOpenFence(
                            target = pending.target,
                            deliveryToken = pending.deliveryToken,
                            openAttempt = pending.openAttempt,
                            parserContinuityId = pending.parserContinuityId,
                            mode = pending.mode,
                            cols = pending.cols,
                            rows = pending.rows,
                            resume = pending.resume,
                        ),
                        requestId = action.requestId,
                        reason = RelayV2TerminalResetReason.STREAM_LOST,
                        requestedOffset = null,
                        bufferStartOffset = null,
                        tailOffset = null,
                    ),
                )
                val result = dispatchFrameReduction(state, reset)
                if (result == RelayV2TerminalFrameResult.Applied) {
                    state.attachment.observer.openRejected(action.error)
                }
                return result
            }
            val present = stored as? RelayV2TerminalStoredCheckpoint.Present
                ?: return RelayV2TerminalFrameResult.NotOwned
            val checkpoint = present.checkpoint
            if (checkpoint.deliveryToken.actorGeneration != authority.generation ||
                checkpoint.identity.target() != state.key.toTarget()
            ) return RelayV2TerminalFrameResult.NotOwned
            val action = actionForGenericError(frame)
            val exactPendingOpenError = action
                .takeIf { checkpoint.pendingOpen?.requestId == it.requestId }
            val reduction = terminal.reduceTerminalUnderApplyLease(state.key, action)
            val result = dispatchFrameReduction(state, reduction)
            if (result == RelayV2TerminalFrameResult.Applied &&
                exactPendingOpenError != null &&
                reduction.outcome is RelayV2TerminalOutcome.CorrelatedErrorRejected
            ) {
                // The reducer is the sole owner/identity/disposition authority. Only after it has
                // accepted the exact current pending-open error may presentation settle opening;
                // replay/close errors and stale issued requestIds must not close this attachment.
                state.attachment.observer.openRejected(exactPendingOpenError.error)
            }
            return result
        }
        if (streamId != null && streamId != state.key.streamId) return RelayV2TerminalFrameResult.NotOwned
        if (type == "terminal.opened") {
            return opened(state, frame)
        }
        val reduction = run {
            val stored = terminal.loadTerminalUnderApplyLease(state.key)
            if (stored is RelayV2TerminalStoredCheckpoint.PreOpen &&
                type == "terminal.reset_required" && frame["kind"] == "response"
            ) {
                return handlePreOpenReset(state, stored.checkpoint, frame)
            }
            val present = stored as? RelayV2TerminalStoredCheckpoint.Present
                ?: return RelayV2TerminalFrameResult.NotOwned
            val checkpoint = present.checkpoint
            if (checkpoint.deliveryToken.actorGeneration != authority.generation ||
                checkpoint.identity.target() != state.key.toTarget()
            ) return RelayV2TerminalFrameResult.NotOwned
            terminal.reduceTerminalUnderApplyLease(
                state.key,
                actionForFrame(checkpoint, frame, type),
            )
        }
        return dispatchFrameReduction(state, reduction)
    }

    /**
     * Owns only the exact Host stream response surface after its renderer is gone. Output and
     * control acknowledgements are consumed without reducer/parser admission; terminal.closed is
     * the sole state-changing frame and directly finalizes the durable detached checkpoint.
     */
    private suspend fun handleRendererFreeFrame(
        state: Active,
        frame: Map<String, Any?>,
        type: String,
        closingOwner: Boolean,
    ): RelayV2TerminalFrameResult {
        if ((frame["streamId"] as? String) != state.key.streamId) {
            return RelayV2TerminalFrameResult.NotOwned
        }
        if (type == "error") return handleRendererFreeError(state, frame)
        if (type == "terminal.output") return handleRendererFreeOutput(state, frame)
        if (type == "terminal.reset_required") {
            return handleRendererFreeReset(state, frame, closingOwner)
        }
        if (type == "terminal.opened") {
            val stored = terminal.loadTerminalUnderApplyLease(state.key)
            val hasPendingOpen = when (stored) {
                is RelayV2TerminalStoredCheckpoint.PreOpen ->
                    stored.checkpoint.pendingOpen != null
                is RelayV2TerminalStoredCheckpoint.Present ->
                    stored.checkpoint.pendingOpen != null
                RelayV2TerminalStoredCheckpoint.Missing,
                is RelayV2TerminalStoredCheckpoint.Invalid,
                -> false
            }
            return if (hasPendingOpen) {
                opened(state, frame)
            } else {
                // Duplicated opened after detached adoption cannot mint parser or UI authority.
                RelayV2TerminalFrameResult.Applied
            }
        }
        if (type != "terminal.closed") {
            return if (type in RENDERER_FREE_CONSUMED_TYPES) {
                RelayV2TerminalFrameResult.Applied
            } else {
                RelayV2TerminalFrameResult.NotOwned
            }
        }
        val stored = terminal.loadTerminalUnderApplyLease(state.key)
            as? RelayV2TerminalStoredCheckpoint.Present
            ?: return RelayV2TerminalFrameResult.NotOwned
        val checkpoint = stored.checkpoint
        if (checkpoint.identity.target() != state.key.toTarget() ||
            checkpoint.deliveryToken.actorGeneration != state.authority.generation
        ) return RelayV2TerminalFrameResult.NotOwned
        val action = actionForFrame(checkpoint, frame, type) as RelayV2TerminalAction.Closed
        val reduction = terminal.consumeDetachedTerminalClosedUnderApplyLease(
            authority = state.authority,
            key = state.key,
            action = action,
        ) ?: return RelayV2TerminalFrameResult.NotOwned
        return when (reduction.outcome) {
            RelayV2TerminalOutcome.ClosedFinalized -> {
                if (!dispatchReduction(state, reduction)) {
                    RelayV2TerminalFrameResult.EffectRejected
                } else {
                    // Retain this one exact renderer-free response owner until replacement or
                    // actor teardown. A correlated close receipt may be queued behind the natural
                    // terminal.closed event that just finalized the row; routing it back through
                    // the FINALIZED reducer makes that late response benign instead of UNOWNED.
                    RelayV2TerminalFrameResult.Applied
                }
            }
            RelayV2TerminalOutcome.Applied -> RelayV2TerminalFrameResult.Applied
            is RelayV2TerminalOutcome.Ignored -> RelayV2TerminalFrameResult.Applied
            is RelayV2TerminalOutcome.ProtocolViolation ->
                RelayV2TerminalFrameResult.ProtocolViolation
            else -> if (closingOwner) RelayV2TerminalFrameResult.ProtocolViolation
            else RelayV2TerminalFrameResult.NotOwned
        }
    }

    private suspend fun handleRendererFreeError(
        state: Active,
        frame: Map<String, Any?>,
    ): RelayV2TerminalFrameResult = when (
        val correlated = terminal.correlateDetachedTerminalErrorUnderApplyLease(
            authority = state.authority,
            key = state.key,
            action = actionForGenericError(frame),
        )
    ) {
        is RelayV2DetachedTerminalErrorResult.Consumed -> {
            if (correlated.currentOpenError != null || correlated.currentCloseError != null) {
                // The exact close-on-open/open or close operation was rejected. Force actor
                // recovery so the durable intent is reclaimed; silently consuming this would
                // strand a Host lease with no renderer or watchdog.
                RelayV2TerminalFrameResult.EffectRejected
            } else {
                // A response for an issued-but-superseded request is benign network reordering.
                RelayV2TerminalFrameResult.Applied
            }
        }
        RelayV2DetachedTerminalErrorResult.NotOwned -> RelayV2TerminalFrameResult.NotOwned
        is RelayV2DetachedTerminalErrorResult.ProtocolViolation ->
            RelayV2TerminalFrameResult.ProtocolViolation
    }

    private suspend fun handleRendererFreeOutput(
        state: Active,
        frame: Map<String, Any?>,
    ): RelayV2TerminalFrameResult {
        val stored = terminal.loadTerminalUnderApplyLease(state.key)
            as? RelayV2TerminalStoredCheckpoint.Present
            ?: return RelayV2TerminalFrameResult.NotOwned
        val checkpoint = stored.checkpoint
        if (checkpoint.identity.target() != state.key.toTarget() ||
            checkpoint.deliveryToken.actorGeneration != state.authority.generation
        ) return RelayV2TerminalFrameResult.NotOwned
        val action = actionForFrame(checkpoint, frame, "terminal.output")
            as RelayV2TerminalAction.Output
        val reduction = terminal.consumeRendererFreeTerminalOutputUnderApplyLease(
            authority = state.authority,
            key = state.key,
            action = action,
        ) ?: return RelayV2TerminalFrameResult.NotOwned
        return when (reduction.outcome) {
            RelayV2TerminalOutcome.Applied,
            RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.DUPLICATE_OUTPUT),
            -> if (dispatchReduction(state, reduction)) {
                RelayV2TerminalFrameResult.Applied
            } else {
                RelayV2TerminalFrameResult.EffectRejected
            }
            is RelayV2TerminalOutcome.Ignored -> RelayV2TerminalFrameResult.NotOwned
            is RelayV2TerminalOutcome.ProtocolViolation ->
                RelayV2TerminalFrameResult.ProtocolViolation
            else -> RelayV2TerminalFrameResult.ProtocolViolation
        }
    }

    private suspend fun handleRendererFreeReset(
        state: Active,
        frame: Map<String, Any?>,
        closingOwner: Boolean,
    ): RelayV2TerminalFrameResult {
        val stored = terminal.loadTerminalUnderApplyLease(state.key)
            as? RelayV2TerminalStoredCheckpoint.Present
            ?: return RelayV2TerminalFrameResult.NotOwned
        val checkpoint = stored.checkpoint
        if (checkpoint.identity.target() != state.key.toTarget() ||
            checkpoint.deliveryToken.actorGeneration != state.authority.generation
        ) return RelayV2TerminalFrameResult.NotOwned
        val action = actionForFrame(checkpoint, frame, "terminal.reset_required")
        val reduction = terminal.consumeRendererFreeTerminalResetUnderApplyLease(
            authority = state.authority,
            key = state.key,
            action = action,
        ) ?: return RelayV2TerminalFrameResult.NotOwned
        return when (reduction.outcome) {
            RelayV2TerminalOutcome.LostFinalized -> {
                if (reduction.effects.isNotEmpty()) {
                    RelayV2TerminalFrameResult.ProtocolViolation
                } else {
                    credentials.clear(
                        credentialOwner(checkpoint.identity.target()),
                        checkpoint.identity.resumeTokenCredentialReference,
                    )
                    synchronized(lock) {
                        if (closing?.active === state) closing = null
                        if (suspended?.active === state) suspended = null
                    }
                    RelayV2TerminalFrameResult.Applied
                }
            }
            is RelayV2TerminalOutcome.ResetRequired -> {
                if (reduction.effects.isNotEmpty()) {
                    // Renderer-free reducers must never project ResetRequired into the dead UI.
                    RelayV2TerminalFrameResult.ProtocolViolation
                } else if (closingOwner ||
                    reduction.checkpoint?.pendingCloseWhenOpened != null ||
                    reduction.checkpoint?.pendingClose != null
                ) {
                    // An ambiguous response has been durably retained. Rotate the actor before a
                    // recovery claim retries the exact successor; never close the predecessor.
                    RelayV2TerminalFrameResult.EffectRejected
                } else {
                    RelayV2TerminalFrameResult.Applied
                }
            }
            RelayV2TerminalOutcome.Applied -> if (dispatchReduction(state, reduction)) {
                RelayV2TerminalFrameResult.Applied
            } else {
                RelayV2TerminalFrameResult.EffectRejected
            }
            is RelayV2TerminalOutcome.Ignored -> RelayV2TerminalFrameResult.Applied
            is RelayV2TerminalOutcome.ProtocolViolation ->
                RelayV2TerminalFrameResult.ProtocolViolation
            else -> RelayV2TerminalFrameResult.ProtocolViolation
        }
    }

    private suspend fun handleDetachedError(
        authority: RelayV2RepositoryEffectAuthority,
        frame: Map<String, Any?>,
    ): RelayV2TerminalFrameResult {
        val owner = synchronized(lock) { detached }
            ?.takeIf { it.active.authority == authority }
            ?: return RelayV2TerminalFrameResult.NotOwned
        return when (
            val result = terminal.correlateDetachedTerminalErrorUnderApplyLease(
                authority = authority,
                key = owner.active.key,
                action = actionForGenericError(frame),
            )
        ) {
            is RelayV2DetachedTerminalErrorResult.Consumed -> {
                result.currentOpenError?.let { error ->
                    synchronized(lock) {
                        if (detached == owner) detached = null
                    }
                    owner.active.attachment.observer.detachedOpenRejected(error)
                }
                RelayV2TerminalFrameResult.Applied
            }
            RelayV2DetachedTerminalErrorResult.NotOwned ->
                RelayV2TerminalFrameResult.NotOwned
            is RelayV2DetachedTerminalErrorResult.ProtocolViolation ->
                RelayV2TerminalFrameResult.ProtocolViolation
        }
    }

    private suspend fun handleDetachedOpened(
        authority: RelayV2RepositoryEffectAuthority,
        frame: Map<String, Any?>,
    ): RelayV2TerminalFrameResult {
        if (frame["kind"] != "response") return RelayV2TerminalFrameResult.ProtocolViolation
        val owner = synchronized(lock) { detached }
            ?.takeIf { it.active.authority == authority }
            ?: return RelayV2TerminalFrameResult.NotOwned
        val stored = terminal.loadTerminalUnderApplyLease(owner.active.key)
        val admission = openedFrameAdmission(owner.active, frame, stored)
        // The public codec bounds this secret, but an empty value can never be a resumable Host
        // credential. Reject it before treating this response as a recoverable current owner.
        if (admission.token.isBlank()) return RelayV2TerminalFrameResult.ProtocolViolation
        durablePreOpenCloseIntent(stored, owner.active.attachment)?.let { closeIntent ->
            return openedForClose(owner.active, admission, closeIntent)
        }
        val preview = when (stored) {
            is RelayV2TerminalStoredCheckpoint.PreOpen ->
                RelayV2TerminalCheckpointReducer.reduceDetachedOpened(
                    stored.checkpoint,
                    admission.action,
                )
            is RelayV2TerminalStoredCheckpoint.Present ->
                RelayV2TerminalCheckpointReducer.reduceDetachedOpened(
                    stored.checkpoint,
                    admission.action,
                )
            else -> return RelayV2TerminalFrameResult.NotOwned
        }
        if (preview.outcome != RelayV2TerminalOutcome.ResetRequired(
                RelayV2TerminalResetReason.STREAM_LOST,
            ) || preview.effects.isNotEmpty()
        ) {
            return when (
                val correlated = terminal.correlateDetachedTerminalOpenedUnderApplyLease(
                    authority = authority,
                    key = owner.active.key,
                    action = admission.action,
                )
            ) {
                RelayV2DetachedTerminalOpenedResult.IssuedOld ->
                    RelayV2TerminalFrameResult.Applied
                RelayV2DetachedTerminalOpenedResult.NotOwned ->
                    RelayV2TerminalFrameResult.NotOwned
                is RelayV2DetachedTerminalOpenedResult.ProtocolViolation ->
                    RelayV2TerminalFrameResult.ProtocolViolation
                RelayV2DetachedTerminalOpenedResult.Current ->
                    RelayV2TerminalFrameResult.ProtocolViolation
            }
        }
        val credentialOwner = credentialOwner(owner.active.key)
        val installed = credentials.installExact(
            credentialOwner,
            admission.reference,
            admission.token,
        ) ?: return RelayV2TerminalFrameResult.ProtocolViolation
        val committedAction = admission.action.copy(
            identity = admission.action.identity.copy(
                resumeTokenCredentialFingerprint = installed.fingerprint,
            ),
        )
        return when (
            terminal.correlateDetachedTerminalOpenedUnderApplyLease(
                authority = authority,
                key = owner.active.key,
                action = committedAction,
            )
        ) {
            RelayV2DetachedTerminalOpenedResult.IssuedOld -> {
                if (installed.created) credentials.clear(credentialOwner, admission.reference)
                RelayV2TerminalFrameResult.Applied
            }
            RelayV2DetachedTerminalOpenedResult.Current -> {
                if (admission.previousReference != null &&
                    admission.previousReference != admission.reference
                ) {
                    credentials.clear(credentialOwner, admission.previousReference)
                }
                synchronized(lock) {
                    if (detached === owner) {
                        detached = null
                        suspended = Suspended(owner.active)
                    }
                }
                if (!owner.openedRecoverySignalled) {
                    owner.openedRecoverySignalled = true
                    owner.active.attachment.observer.detachedOpenRetryRequired()
                }
                RelayV2TerminalFrameResult.Applied
            }
            RelayV2DetachedTerminalOpenedResult.NotOwned -> {
                if (installed.created) credentials.clear(credentialOwner, admission.reference)
                RelayV2TerminalFrameResult.NotOwned
            }
            is RelayV2DetachedTerminalOpenedResult.ProtocolViolation -> {
                if (installed.created) credentials.clear(credentialOwner, admission.reference)
                RelayV2TerminalFrameResult.ProtocolViolation
            }
        }
    }

    private suspend fun openedForClose(
        state: Active,
        admission: OpenedFrameAdmission,
        closeIntent: RelayV2TerminalPendingClose,
    ): RelayV2TerminalFrameResult {
        if (admission.token.isBlank()) return RelayV2TerminalFrameResult.ProtocolViolation
        val owner = credentialOwner(state.key)
        val installed = credentials.installExact(
            owner,
            admission.reference,
            admission.token,
        ) ?: return RelayV2TerminalFrameResult.ProtocolViolation
        val committedAction = admission.action.copy(
            identity = admission.action.identity.copy(
                resumeTokenCredentialFingerprint = installed.fingerprint,
            ),
        )
        val reduction = try {
            terminal.adoptDetachedTerminalOpenedForCloseUnderApplyLease(
                authority = state.authority,
                key = state.key,
                action = committedAction,
                pendingClose = closeIntent,
            )
        } catch (failure: Exception) {
            if (installed.created) credentials.clear(owner, admission.reference)
            throw failure
        }
        if (reduction == null) {
            if (installed.created) credentials.clear(owner, admission.reference)
            return RelayV2TerminalFrameResult.NotOwned
        }
        if (admission.previousReference != null &&
            admission.previousReference != admission.reference
        ) {
            credentials.clear(owner, admission.previousReference)
        }
        // The transaction above produced only SendClose; no parser/replay work is admitted after
        // presentation disposal. Commit the wire close before fencing this actor generation so a
        // Host output pump cannot become a new Base-owned stream without a parser owner.
        synchronized(lock) {
            if (active === state) active = null
            if (detached?.active === state) detached = null
            if (suspended?.active === state) suspended = null
            closing = Closing(state)
        }
        val closeSent = dispatchReduction(state, reduction)
        if (!closeSent) synchronized(lock) {
            if (closing?.active === state) closing = null
        }
        return if (closeSent) {
            RelayV2TerminalFrameResult.Applied
        } else {
            RelayV2TerminalFrameResult.EffectRejected
        }
    }

    private suspend fun handlePreOpenReset(
        state: Active,
        checkpoint: RelayV2TerminalPreOpenCheckpoint,
        frame: Map<String, Any?>,
    ): RelayV2TerminalFrameResult {
        val action = preOpenResetAction(checkpoint, frame)
        val resetReduction = terminal.reduceTerminalUnderApplyLease(state.key, action)
        if (action.reason != RelayV2TerminalResetReason.STREAM_LOST ||
            resetReduction.outcome != RelayV2TerminalOutcome.ResetRequired(
                RelayV2TerminalResetReason.STREAM_LOST,
            )
        ) {
            return dispatchFrameReduction(state, resetReduction)
        }
        val resetCheckpoint = resetReduction.preOpenCheckpoint
            ?.takeIf {
                it.phase == RelayV2TerminalPreOpenPhase.RESET_REQUIRED &&
                    it.resetReason == RelayV2TerminalResetReason.STREAM_LOST
            } ?: return RelayV2TerminalFrameResult.ProtocolViolation
        val resetFence = resetCheckpoint.resetFence
            ?: return RelayV2TerminalFrameResult.ProtocolViolation
        val resetEffect = resetReduction.effects.singleOrNull()
            as? RelayV2TerminalEffect.ResetRequired
            ?: return RelayV2TerminalFrameResult.ProtocolViolation
        if (resetEffect.reason != RelayV2TerminalResetReason.STREAM_LOST ||
            resetEffect.fence != resetFence
        ) {
            return RelayV2TerminalFrameResult.ProtocolViolation
        }
        if (!state.attachment.observer.admitResetSuccessor(action.reason)) {
            // RESET_REQUIRED is already durable. Presentation atomically projected the paused
            // state in the admission callback, so neither a generic reset worker nor a second
            // in-composition SendOpen is allowed to race it.
            return RelayV2TerminalFrameResult.Applied
        }

        // This stream-loss response has an in-composition successor owner. Do not dispatch the
        // generic ResetRequired observer effect: doing so would let V2 detach/reopen while this
        // method is also committing and sending a successor. Durable RESET_REQUIRED remains the
        // first committed state; presentation is notified only after the successor wire send wins.
        val successorRequestId = newId()
        val successorAttempt = RelayV2TerminalOpenAttempt(newId(), newId())
        val successorReduction = terminal.reduceTerminalUnderApplyLease(
            state.key,
            RelayV2TerminalAction.BeginOpenAttempt(
                deliveryToken = resetFence.deliveryToken,
                requestId = successorRequestId,
                openAttempt = successorAttempt,
                mode = RelayV2TerminalOpenMode.RESET,
                cols = resetFence.cols,
                rows = resetFence.rows,
                target = resetFence.target,
                parserContinuityId = resetFence.parserContinuityId,
                resume = null,
            ),
        )
        val successorCheckpoint = successorReduction.preOpenCheckpoint
            ?.takeIf { it.phase == RelayV2TerminalPreOpenPhase.PENDING_OPEN }
            ?: return RelayV2TerminalFrameResult.ProtocolViolation
        val openEffect = successorReduction.effects
            .filterIsInstance<RelayV2TerminalEffect.SendOpen>()
            .singleOrNull() ?: return RelayV2TerminalFrameResult.ProtocolViolation
        if (openEffect.openFence.target != resetFence.target ||
            openEffect.openFence.deliveryToken != resetFence.deliveryToken ||
            openEffect.openFence.parserContinuityId != resetFence.parserContinuityId ||
            openEffect.cols != resetFence.cols || openEffect.rows != resetFence.rows ||
            openEffect.mode != RelayV2TerminalOpenMode.RESET ||
            openEffect.resume != null ||
            successorCheckpoint.pendingOpen?.openAttempt != successorAttempt
        ) {
            return RelayV2TerminalFrameResult.ProtocolViolation
        }
        val successor = state.copy(
            delivery = openEffect.openFence.deliveryToken,
            openAttempt = openEffect.openFence.openAttempt,
            requestId = openEffect.requestId,
            parserContinuityId = openEffect.openFence.parserContinuityId,
            cols = openEffect.cols,
            rows = openEffect.rows,
        )
        synchronized(lock) {
            if (active !== state) return RelayV2TerminalFrameResult.NotOwned
            active = successor
        }
        val successorResult = dispatchFrameReduction(successor, successorReduction)
        if (successorResult == RelayV2TerminalFrameResult.Applied) {
            state.attachment.observer.resetSuccessorIssued(
                action.reason,
                RelayV2TerminalResetSuccessor(
                    requestId = openEffect.requestId,
                    openId = openEffect.openFence.openAttempt.openId,
                ),
            )
        }
        return successorResult
    }

    private suspend fun dispatchFrameReduction(
        state: Active,
        reduction: RelayV2TerminalReduction,
    ): RelayV2TerminalFrameResult {
        val accepted = dispatchReduction(state, reduction)
        return when (reduction.outcome) {
            is RelayV2TerminalOutcome.ProtocolViolation -> RelayV2TerminalFrameResult.ProtocolViolation
            is RelayV2TerminalOutcome.Ignored -> RelayV2TerminalFrameResult.NotOwned
            else -> if (accepted) RelayV2TerminalFrameResult.Applied
            else RelayV2TerminalFrameResult.EffectRejected
        }
    }

    private fun preOpenResetAction(
        checkpoint: RelayV2TerminalPreOpenCheckpoint,
        frame: Map<String, Any?>,
    ): RelayV2TerminalAction.PreOpenResetRequired {
        val pending = requireNotNull(checkpoint.pendingOpen)
        val payload = frame.objectValue("payload")
        check(payload.string("origin") == "open")
        return RelayV2TerminalAction.PreOpenResetRequired(
            fence = RelayV2TerminalOpenFence(
                pending.target,
                pending.deliveryToken,
                pending.openAttempt,
                pending.parserContinuityId,
                pending.mode,
                pending.cols,
                pending.rows,
                pending.resume,
            ),
            requestId = frame.string("requestId"),
            reason = payload.resetReason(),
            requestedOffset = payload.nullableString("requestedOffset"),
            bufferStartOffset = payload.nullableString("bufferStartOffset"),
            tailOffset = payload.nullableString("tailOffset"),
        )
    }

    private fun actionForGenericError(
        frame: Map<String, Any?>,
    ): RelayV2TerminalAction.CorrelatedError {
        val errorObject = frame["error"] as? Map<*, *> ?: error("Invalid terminal generic error")
        val code = errorObject["code"] as? String ?: error("Invalid terminal generic error code")
        return RelayV2TerminalAction.CorrelatedError(
            requestId = frame.string("requestId"),
            hostId = frame["hostId"] as? String,
            hostEpoch = frame["hostEpoch"] as? String,
            scopeId = frame["scopeId"] as? String,
            sessionId = frame["sessionId"] as? String,
            streamId = frame["streamId"] as? String,
            commandDisposition = errorObject["commandDisposition"] as? String ?: "",
            error = RelayV2TerminalCorrelatedError(
                code,
                (errorObject["retryable"] as? Boolean)
                    ?: error("Invalid terminal generic error retryable"),
                (errorObject["message"] as? String)
                    ?: error("Invalid terminal generic error message"),
            ),
        )
    }

    suspend fun detach(issued: RelayV2TerminalAttachment) = lifecycleMutex.withLock {
        val handle = issued as? Attachment ?: return
        if (handle.origin !== this) return
        val previous = synchronized(lock) {
            if (attachment !== handle) return@synchronized null
            attachment = null
            active.also { current ->
                active = null
                if (current != null) detached = current.detached()
            }
        }
        if (previous != null) teardownActive(previous)
    }

    /**
     * Releases a UI attachment after its parser adapter has rejected new callbacks and drained
     * every callback admitted before that cut. At this point no post-commit executor can still be
     * using the attachment, so permanently fencing the exact authority/key would be both
     * unnecessary and harmful: a later view attachment may resume on the same Relay connection.
     */
    suspend fun detachAfterParserCallbacksDrained(
        issued: RelayV2TerminalAttachment,
    ) = lifecycleMutex.withLock {
        val handle = issued as? Attachment ?: return
        if (handle.origin !== this) return
        val previous = synchronized(lock) {
            if (attachment !== handle) return@synchronized null
            attachment = null
            active.also { current ->
                active = null
                if (current != null) detached = current.detached()
            }
        }
        if (previous != null) releaseDrainedAttachment(previous)
    }

    suspend fun teardownGeneration(
        generation: RelayV2EffectGeneration?,
    ) = lifecycleMutex.withLock {
        val previous = synchronized(lock) {
            detached?.takeIf {
                generation == null || it.active.authority.generation == generation
            }
                ?.also { detached = null }
            val previousActive = active
                ?.takeIf { generation == null || it.authority.generation == generation }
                ?.also { active = null }
            suspended?.takeIf {
                generation == null || it.active.authority.generation == generation
            }?.also { suspended = null }
            closing?.takeIf {
                generation == null || it.active.authority.generation == generation
            }?.also { closing = null }
            previousActive
        }
        if (previous != null) teardownActive(previous)
    }

    suspend fun dispose() = lifecycleMutex.withLock {
        val previous = synchronized(lock) {
            if (closed) return@synchronized null
            closed = true
            attachment = null
            detached = null
            suspended = null
            closing = null
            active.also { active = null }
        }
        if (previous != null) teardownActive(previous)
    }

    private suspend fun mutateCurrent(
        issued: RelayV2TerminalAttachment,
        authority: RelayV2RepositoryEffectAuthority,
        reduce: suspend (Active, RelayV2TerminalCheckpoint) -> RelayV2TerminalReduction?,
    ): Boolean {
        val handle = issued as? Attachment ?: return false
        val state = synchronized(lock) { active }
            ?.takeIf { it.attachment === handle && it.authority == authority } ?: return false
        val checkpoint = (terminal.loadTerminalUnderApplyLease(state.key)
            as? RelayV2TerminalStoredCheckpoint.Present)?.checkpoint ?: return false
        if (checkpoint.deliveryToken.actorGeneration != authority.generation) return false
        val reduction = reduce(state, checkpoint) ?: return false
        return dispatchReduction(state, reduction)
    }

    private suspend fun opened(
        state: Active,
        frame: Map<String, Any?>,
    ): RelayV2TerminalFrameResult {
        if (frame["kind"] != "response") return RelayV2TerminalFrameResult.ProtocolViolation
        val stored = terminal.loadTerminalUnderApplyLease(state.key)
        val admission = openedFrameAdmission(state, frame, stored)
        val action = admission.action
        val token = admission.token
        val reference = admission.reference
        val previousReference = admission.previousReference
        durablePreOpenCloseIntent(stored, state.attachment)?.let { closeIntent ->
            return openedForClose(state, admission, closeIntent)
        }
        val preview = when (stored) {
            RelayV2TerminalStoredCheckpoint.Missing ->
                RelayV2TerminalCheckpointReducer.reduce(null, action)
            is RelayV2TerminalStoredCheckpoint.PreOpen ->
                RelayV2TerminalCheckpointReducer.reduce(stored.checkpoint, action)
            is RelayV2TerminalStoredCheckpoint.Present ->
                RelayV2TerminalCheckpointReducer.reduce(stored.checkpoint, action)
            is RelayV2TerminalStoredCheckpoint.Invalid ->
                return RelayV2TerminalFrameResult.ProtocolViolation
        }

        // Classify against the durable issued-request history before touching the credential
        // store. A response for a superseded request is valid network reordering, not an
        // unowned Base frame, and must be consumed without changing presentation or secrets.
        if (preview.outcome != RelayV2TerminalOutcome.Applied) {
            val reduction = terminal.reduceTerminalUnderApplyLease(state.key, action)
            return dispatchOpenedReduction(state, reduction)
        }

        val owner = credentialOwner(state.key)
        val installed = credentials.installExact(owner, reference, token)
            ?: error("Terminal resume credential identity conflicted")
        val committedAction = action.copy(
            identity = action.identity.copy(
                resumeTokenCredentialFingerprint = installed.fingerprint,
            ),
        )
        val reduction = try {
            terminal.reduceTerminalUnderApplyLease(
                state.key,
                committedAction,
            )
        } catch (failure: Exception) {
            if (installed.created) credentials.clear(owner, reference)
            throw failure
        }
        val adoptedReplacement = reduction.outcome == RelayV2TerminalOutcome.Applied &&
            reduction.checkpoint?.identity?.resumeTokenCredentialReference == reference
        if (!adoptedReplacement) {
            // The reducer rejected this opened frame and durably retained the predecessor identity.
            // Keep that predecessor credential resumable and discard only a token created for the
            // unadopted response. ResetRequired remains responsible for notifying presentation.
            if (installed.created) credentials.clear(owner, reference)
            return dispatchOpenedReduction(state, reduction)
        }
        // From this point Room durably points at [reference]. Never roll it back if retiring the
        // predecessor or notifying presentation fails; the current checkpoint must stay resumable.
        if (previousReference != null && previousReference != reference) {
            credentials.clear(owner, previousReference)
        }
        state.attachment.observer.opened(state.key.streamId)
        return dispatchOpenedReduction(state, reduction)
    }

    private fun openedFrameAdmission(
        state: Active,
        frame: Map<String, Any?>,
        stored: RelayV2TerminalStoredCheckpoint,
    ): OpenedFrameAdmission {
        val payload = frame.objectValue("payload")
        val requestId = frame.string("requestId")
        val responseOpenId = payload.string("openId")
        val token = payload.string("resumeToken")
        val disposition = when (payload.string("disposition")) {
            "new" -> RelayV2TerminalOpenDisposition.NEW
            "resumed" -> RelayV2TerminalOpenDisposition.RESUMED
            "reset" -> RelayV2TerminalOpenDisposition.RESET
            else -> error("Invalid terminal disposition")
        }
        val present = (stored as? RelayV2TerminalStoredCheckpoint.Present)?.checkpoint
        val pending = when (stored) {
            is RelayV2TerminalStoredCheckpoint.PreOpen -> stored.checkpoint.pendingOpen
            is RelayV2TerminalStoredCheckpoint.Present -> stored.checkpoint.pendingOpen
            else -> null
        }
        val previousReference = present?.identity?.resumeTokenCredentialReference
            ?: pending?.resume?.resumeTokenCredentialReference
        // A resumed generation must retain the exact credential identity used by its request.
        // NEW/RESET responses establish a replacement generation and therefore a fresh reference.
        val reference = if (disposition == RelayV2TerminalOpenDisposition.RESUMED) {
            previousReference ?: credentialReference(state.key, responseOpenId)
        } else {
            credentialReference(state.key, responseOpenId)
        }
        val fallbackAttempt = pending?.openAttempt ?: state.openAttempt
        val responseAttempt = if (fallbackAttempt.openId == responseOpenId) {
            fallbackAttempt
        } else {
            RelayV2TerminalOpenAttempt(
                responseOpenId,
                fingerprint(
                    pending?.target ?: state.key.toTarget(),
                    requestId,
                    responseOpenId,
                    pending?.cols ?: state.cols,
                    pending?.rows ?: state.rows,
                ),
            )
        }
        return OpenedFrameAdmission(
            action = RelayV2TerminalAction.Opened(
                identity = RelayV2TerminalIdentity(
                    profileId = state.key.profileId,
                    profileActivationGeneration = state.key.profileActivationGeneration,
                    principalId = state.key.principalId,
                    clientInstanceId = state.key.clientInstanceId,
                    hostId = frame.string("hostId"),
                    hostEpoch = frame.string("hostEpoch"),
                    hostInstanceId = frame.string("hostInstanceId"),
                    scopeId = frame.string("scopeId"),
                    sessionId = frame.string("sessionId"),
                    streamId = frame.string("streamId"),
                    generation = payload.string("generation"),
                    resumeTokenCredentialReference = reference,
                    resumeTokenCredentialFingerprint = resumeCredentialFingerprint(token),
                    pane = state.key.pane,
                ),
                requestId = requestId,
                openAttempt = responseAttempt,
                deliveryToken = pending?.deliveryToken ?: state.delivery,
                parserContinuityId = pending?.parserContinuityId ?: state.parserContinuityId,
                disposition = disposition,
                cols = pending?.cols ?: state.cols,
                rows = pending?.rows ?: state.rows,
                replayFromOffset = payload.string("replayFromOffset"),
                tailOffset = payload.string("tailOffset"),
                deduplicated = payload.boolean("deduplicated"),
            ),
            token = token,
            reference = reference,
            previousReference = previousReference,
        )
    }

    private suspend fun dispatchOpenedReduction(
        state: Active,
        reduction: RelayV2TerminalReduction,
    ): RelayV2TerminalFrameResult {
        if (reduction.outcome == RelayV2TerminalOutcome.Ignored(
                RelayV2TerminalIgnoredReason.STALE_OPEN_RESPONSE,
            )
        ) {
            return if (reduction.effects.isEmpty()) RelayV2TerminalFrameResult.Applied
            else RelayV2TerminalFrameResult.ProtocolViolation
        }
        return dispatchFrameReduction(state, reduction)
    }

    private suspend fun dispatchReduction(
        state: Active,
        reduction: RelayV2TerminalReduction,
    ): Boolean {
        for (effect in reduction.effects) {
            val accepted = when (effect) {
                is RelayV2TerminalEffect.SendOpen,
                is RelayV2TerminalEffect.OutputAck,
                is RelayV2TerminalEffect.RequestReplay,
                is RelayV2TerminalEffect.SendClose,
                -> wire.sendCommittedEffect(state.authority, effect, credentials) ==
                    RelayV2TerminalExactGenerationSendResult.Sent
                is RelayV2TerminalEffect.WriteParser,
                is RelayV2TerminalEffect.ResetParser,
                -> when (val result = runtime.handle(state.authority, effect)) {
                    is RelayV2TerminalRuntimeApplyResult.ParserDispatched ->
                        result.transferredCallbackGate.settle(
                            RelayV2TerminalTransferredCallbackSettlement.COMMITTED,
                        )
                    else -> false
                }
                is RelayV2TerminalEffect.SendInput,
                is RelayV2TerminalEffect.SendResize,
                -> when (runtime.handle(state.authority, effect)) {
                    is RelayV2TerminalRuntimeApplyResult.ControlCommitted,
                    -> true
                    else -> false
                }
                is RelayV2TerminalEffect.ResetRequired -> {
                    state.attachment.observer.reset(effect.reason)
                    true
                }
                is RelayV2TerminalEffect.FinalizeClosed -> {
                    credentials.clear(
                        credentialOwner(effect.fence.identity.target()),
                        effect.fence.identity.resumeTokenCredentialReference,
                    )
                    state.attachment.observer.closed(effect.reason)
                    true
                }
                is RelayV2TerminalEffect.DisplayTruncated,
                is RelayV2TerminalEffect.ControlsBecameAmbiguous,
                is RelayV2TerminalEffect.QueryCloseCorrelation,
                -> false
            }
            if (!accepted) return false
        }
        return true
    }

    private fun executePostCommitEffect(
        execution: RelayV2TerminalSynchronousEffectExecution,
    ): RelayV2TerminalSynchronousEffectExecutionReceipt = runBlocking {
        val state = synchronized(lock) { active }
        if (state == null || state.authority != execution.authority || state.key != execution.key) {
            return@runBlocking RelayV2TerminalSynchronousEffectExecutionReceipt
                .REJECTED_WITHOUT_EXECUTION
        }
        when (val effect = execution.effect) {
            is RelayV2TerminalEffect.WriteParser,
            is RelayV2TerminalEffect.ResetParser,
            -> when (val result = runtime.handle(execution.authority, effect)) {
                is RelayV2TerminalRuntimeApplyResult.ParserDispatched -> {
                    RelayV2TerminalSynchronousEffectExecutionReceipt
                        .transferredToDurableCallback(result.transferredCallbackGate)
                }
                else -> RelayV2TerminalSynchronousEffectExecutionReceipt.REJECTED_WITHOUT_EXECUTION
            }
            is RelayV2TerminalEffect.SendInput,
            is RelayV2TerminalEffect.SendResize,
            -> when (runtime.handle(execution.authority, effect)) {
                is RelayV2TerminalRuntimeApplyResult.ControlCommitted ->
                    RelayV2TerminalSynchronousEffectExecutionReceipt.COMPLETED
                is RelayV2TerminalRuntimeApplyResult.Rejected,
                RelayV2TerminalRuntimeApplyResult.Stale,
                -> RelayV2TerminalSynchronousEffectExecutionReceipt.REJECTED_WITHOUT_EXECUTION
                else -> error("Terminal control settlement is uncertain")
            }
            is RelayV2TerminalEffect.OutputAck,
            is RelayV2TerminalEffect.RequestReplay,
            is RelayV2TerminalEffect.SendClose,
            -> when (wire.sendCommittedEffect(execution.authority, effect, credentials)) {
                RelayV2TerminalExactGenerationSendResult.Sent ->
                    RelayV2TerminalSynchronousEffectExecutionReceipt.COMPLETED
                RelayV2TerminalExactGenerationSendResult.Stale ->
                    RelayV2TerminalSynchronousEffectExecutionReceipt.REJECTED_WITHOUT_EXECUTION
                RelayV2TerminalExactGenerationSendResult.NotSent ->
                    error("Terminal transport settlement is uncertain")
            }
            is RelayV2TerminalEffect.FinalizeClosed -> {
                credentials.clear(
                    credentialOwner(effect.fence.identity.target()),
                    effect.fence.identity.resumeTokenCredentialReference,
                )
                state.attachment.observer.closed(effect.reason)
                RelayV2TerminalSynchronousEffectExecutionReceipt.COMPLETED
            }
            is RelayV2TerminalEffect.ResetRequired -> {
                state.attachment.observer.reset(effect.reason)
                // ParserFailed has already committed a terminal-scoped RESET_REQUIRED checkpoint
                // before this durable batch is activated. Completing that exact notification is
                // therefore a known outcome, not an uncertain external side effect. Keep the base
                // Relay actor alive so renderer teardown can drain this callback, detach the stale
                // attachment and let its replacement claim the checkpoint with a RESET open.
                // Reservation/activation uncertainty is still fenced by RuntimeAdapter poison.
                RelayV2TerminalSynchronousEffectExecutionReceipt.COMPLETED
            }
            is RelayV2TerminalEffect.ControlsBecameAmbiguous,
            is RelayV2TerminalEffect.DisplayTruncated,
            is RelayV2TerminalEffect.QueryCloseCorrelation,
            is RelayV2TerminalEffect.SendOpen,
            -> RelayV2TerminalSynchronousEffectExecutionReceipt.REJECTED_WITHOUT_EXECUTION
        }
    }

    private suspend fun teardownActive(state: Active) {
        sink.teardownAuthority(state.authority, state.key)
        // A transport/attachment fence is not itself an uncertain external effect. The durable
        // checkpoint remains resumable; any actual callback handoff marker is normalized by the
        // recovery claim before another wire attempt.
        state.attachment.observer.reset(RelayV2TerminalResetReason.STREAM_LOST)
    }

    private fun releaseDrainedAttachment(state: Active) {
        state.attachment.observer.reset(RelayV2TerminalResetReason.STREAM_LOST)
    }

    private fun actionForFrame(
        checkpoint: RelayV2TerminalCheckpoint,
        frame: Map<String, Any?>,
        type: String,
    ): RelayV2TerminalAction {
        if (type == "error") {
            return actionForGenericError(frame)
        }
        val payload = frame.objectValue("payload")
        val fence = RelayV2TerminalActionFence(
            checkpoint.identity.binding(),
            checkpoint.deliveryToken,
            checkpoint.openAttempt.openId,
        )
        val wireGeneration = payload["generation"] as? String
        fun requiredGenerationFence(): RelayV2TerminalActionFence = fence.copy(
            binding = fence.binding.copy(generation = requireNotNull(wireGeneration)),
        )
        return when (type) {
            "terminal.output" -> RelayV2TerminalAction.Output(
                requiredGenerationFence(),
                payload.string("offset"),
                RelayV2TerminalBytes.of(Base64.getDecoder().decode(payload.string("data"))),
            )
            "terminal.input_ack" -> RelayV2TerminalAction.InputAck(
                requiredGenerationFence(),
                payload.string("ackedThroughInputSeq"),
            )
            "terminal.input_error" -> RelayV2TerminalAction.InputError(
                requiredGenerationFence(),
                payload.string("inputSeq"),
                payload.string("ackedThroughInputSeq"),
                payload.controlError("error"),
            )
            "terminal.resize_ack" -> RelayV2TerminalAction.ResizeAck(
                requiredGenerationFence(),
                payload.string("ackedThroughResizeSeq"),
            )
            "terminal.resize_error" -> RelayV2TerminalAction.ResizeError(
                requiredGenerationFence(),
                payload.string("resizeSeq"),
                payload.string("ackedThroughResizeSeq"),
                payload.controlError("error"),
            )
            "terminal.replay_started" -> RelayV2TerminalAction.ReplayStarted(
                checkpoint.identity,
                checkpoint.openAttempt.openId,
                checkpoint.deliveryToken,
                frame.string("requestId"),
                payload.string("fromOffset"),
                payload.string("tailOffsetAtStart"),
            )
            "terminal.reset_required" -> if (frame["kind"] == "response") {
                val origin = when (payload.string("origin")) {
                    "open" -> RelayV2TerminalResetOrigin.OPEN
                    "replay" -> RelayV2TerminalResetOrigin.REPLAY
                    else -> error("Invalid reset origin")
                }
                RelayV2TerminalAction.CorrelatedResetRequired(
                    fence,
                    origin,
                    frame.string("requestId"),
                    openAttempt = if (origin == RelayV2TerminalResetOrigin.OPEN) {
                        checkpoint.pendingOpen?.openAttempt
                    } else {
                        null
                    },
                    reason = payload.resetReason(),
                    requestedOffset = payload.nullableString("requestedOffset"),
                    bufferStartOffset = payload.nullableString("bufferStartOffset"),
                    tailOffset = payload.nullableString("tailOffset"),
                    wireGeneration = wireGeneration,
                )
            } else {
                RelayV2TerminalAction.AsyncResetRequired(
                    fence,
                    newId(),
                    payload.resetReason(),
                    payload.nullableString("requestedOffset"),
                    payload.nullableString("bufferStartOffset"),
                    payload.nullableString("tailOffset"),
                    wireGeneration,
                )
            }
            "terminal.closed" -> RelayV2TerminalAction.Closed(
                requiredGenerationFence(),
                payload.string("finalOffset"),
                payload.boolean("replayAvailable"),
                payload.nullableString("bufferStartOffset"),
                when (payload.string("reason")) {
                    "client_closed" -> RelayV2TerminalCloseReason.CLIENT_CLOSED
                    "backend_exit" -> RelayV2TerminalCloseReason.BACKEND_EXIT
                    "backend_error" -> RelayV2TerminalCloseReason.BACKEND_ERROR
                    else -> error("Invalid terminal close reason")
                },
                (payload["exitCode"] as? Long)?.toInt(),
                payload.nullableString("closeId"),
                frame["requestId"] as? String,
            )
            else -> error("Unsupported terminal frame")
        }
    }

    private fun Active.detached() = Detached(this)

    private fun RelayV2TerminalCheckpoint.openIsPending(): Boolean =
        pendingOpen != null || phase == RelayV2TerminalPhase.RESET_REQUIRED

    private fun currentParser(
        token: RelayV2TerminalParserCallbackToken,
    ): RelayV2TerminalParserPort? = synchronized(lock) {
        active?.takeIf {
            it.key.toTarget() == token.fence.identity.target() &&
                it.authority.generation == token.fence.deliveryToken.actorGeneration
        }?.attachment?.parser
    }

    private fun clearIfCurrent(expected: Active) = synchronized(lock) {
        if (active === expected) active = null
    }

    private fun matches(
        target: RelayV2TerminalAttachmentTarget,
        authority: RelayV2RepositoryEffectAuthority,
    ): Boolean = target.profileId == authority.profileId &&
        target.profileActivationGeneration == authority.profileActivationGeneration &&
        target.principalId == authority.principalId &&
        target.clientInstanceId == authority.clientInstanceId &&
        target.hostId == authority.hostId

    private fun credentialReference(key: RelayV2TerminalCheckpointKey, openId: String): String =
        "terminal-${key.profileActivationGeneration}-${key.streamId}-$openId"

    private fun resumeCredentialFingerprint(token: String): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(
            MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8)),
        )

    private fun credentialOwner(key: RelayV2TerminalCheckpointKey) =
        RelayV2TerminalResumeCredentialOwner(key.profileId, key.profileActivationGeneration)

    private fun credentialOwner(target: RelayV2TerminalOpenTarget) =
        RelayV2TerminalResumeCredentialOwner(
            target.profileId,
            target.profileActivationGeneration,
        )

    private fun ensureCloseIntent(
        attachment: Attachment,
        target: RelayV2TerminalOpenTarget,
    ): RelayV2TerminalPendingClose = attachment.closeIntent ?: run {
        val requestId = newId()
        val closeId = newId()
        RelayV2TerminalPendingClose(
            closeAttempt = RelayV2TerminalCloseAttempt(
                closeId,
                fingerprint(target, requestId, closeId, 0, 0),
            ),
            requestId = requestId,
            issuedRequestIds = listOf(requestId),
        ).also { attachment.closeIntent = it }
    }

    private fun durablePreOpenCloseIntent(
        stored: RelayV2TerminalStoredCheckpoint,
        attachment: Attachment,
    ): RelayV2TerminalPendingClose? {
        val durable = when (stored) {
            is RelayV2TerminalStoredCheckpoint.PreOpen -> stored.checkpoint.pendingClose
            is RelayV2TerminalStoredCheckpoint.Present ->
                stored.checkpoint.pendingCloseWhenOpened
            RelayV2TerminalStoredCheckpoint.Missing,
            is RelayV2TerminalStoredCheckpoint.Invalid,
            -> null
        }
        return durable?.also { attachment.closeIntent = it } ?: attachment.closeIntent
    }

    private fun fingerprint(
        target: RelayV2TerminalOpenTarget,
        requestId: String,
        operationId: String,
        cols: Int,
        rows: Int,
    ): String = Base64.getUrlEncoder().withoutPadding().encodeToString(
        MessageDigest.getInstance("SHA-256").digest(
            listOf(target, requestId, operationId, cols, rows).joinToString("\u0000")
                .toByteArray(Charsets.UTF_8),
        ),
    )

    @Suppress("UNCHECKED_CAST")
    private fun Map<String, Any?>.objectValue(key: String): Map<String, Any?> =
        this[key] as Map<String, Any?>

    private fun Map<String, Any?>.string(key: String): String = this[key] as String
    private fun Map<String, Any?>.nullableString(key: String): String? = this[key] as? String
    private fun Map<String, Any?>.boolean(key: String): Boolean = this[key] as Boolean

    private fun Map<String, Any?>.controlError(key: String): RelayV2TerminalControlError =
        objectValue(key).let { error ->
            relayV2TerminalControlError(
                code = error.string("code"),
                retryable = error["retryable"] as? Boolean ?: false,
            )
        }

    private fun Map<String, Any?>.resetReason(): RelayV2TerminalResetReason =
        when (string("reason")) {
            "generation_stale" -> RelayV2TerminalResetReason.GENERATION_STALE
            "offset_expired" -> RelayV2TerminalResetReason.OFFSET_EXPIRED
            "stream_lost" -> RelayV2TerminalResetReason.STREAM_LOST
            "slow_consumer" -> RelayV2TerminalResetReason.SLOW_CONSUMER
            "host_buffer_pressure" -> RelayV2TerminalResetReason.HOST_BUFFER_PRESSURE
            else -> error("Invalid terminal reset reason")
        }

    private fun logTerminalLifecycle(message: String) {
        // android.jar stubs throw from Log in local JVM tests; the diagnostic remains best-effort
        // and production Android's implementation records it normally.
        runCatching { Log.i(TERMINAL_DIAGNOSTIC_TAG, message) }
    }

    private companion object {
        const val TERMINAL_DIAGNOSTIC_TAG = "TwRelayV2Terminal"
        val TERMINAL_LIFECYCLE_DIAGNOSTIC_TYPES = setOf(
            "error",
            "terminal.opened",
            "terminal.reset_required",
            "terminal.closed",
        )
        val TERMINAL_EXACT_GENERATION_TYPES = setOf(
            "terminal.output",
            "terminal.input_ack",
            "terminal.input_error",
            "terminal.resize_ack",
            "terminal.resize_error",
            "terminal.closed",
        )
        val RENDERER_FREE_CONSUMED_TYPES = setOf(
            "terminal.input_ack",
            "terminal.input_error",
            "terminal.resize_ack",
            "terminal.resize_error",
            "terminal.replay_started",
        )
    }
}
