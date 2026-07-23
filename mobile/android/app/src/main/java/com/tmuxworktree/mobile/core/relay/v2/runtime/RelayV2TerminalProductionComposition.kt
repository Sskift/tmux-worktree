package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2DecodedMessage
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalCheckpointKey
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

internal interface RelayV2TerminalAttachmentObserver {
    fun opened(streamId: String)
    fun reset(reason: RelayV2TerminalResetReason)
    fun closed(reason: RelayV2TerminalCloseReason)
}

internal object RelayV2TerminalNoopAttachmentObserver : RelayV2TerminalAttachmentObserver {
    override fun opened(streamId: String) = Unit
    override fun reset(reason: RelayV2TerminalResetReason) = Unit
    override fun closed(reason: RelayV2TerminalCloseReason) = Unit
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
    private class Attachment(
        val origin: RelayV2TerminalProductionComposition,
        val target: RelayV2TerminalAttachmentTarget,
        val parser: RelayV2TerminalParserPort,
        val observer: RelayV2TerminalAttachmentObserver,
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

    private val lock = Any()
    private val lifecycleMutex = Mutex()
    private var attachment: Attachment? = null
    private var active: Active? = null
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
        fatalInvalidation = fatalInvalidation,
    )

    suspend fun recoverBeforeAdmission(): Boolean = lifecycleMutex.withLock {
        val recovered = sink.recover()
        if (recovered.globallyClosed) return false
        return recovered.recoveredLineages.all { lineage ->
            lineage.disposition == RelayV2TerminalResetDisposition.STREAM_LOST &&
                terminal.recoverPostCommitUnknown(lineage.authority, lineage.key) != null
        }
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
            active.also { active = null }
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
        val reduction: RelayV2TerminalReduction
        val key: RelayV2TerminalCheckpointKey
        val openEffect: RelayV2TerminalEffect.SendOpen
        if (claimed != null) {
            reduction = claimed.reduction
            key = claimed.key
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
            val parserContinuityId = newId()
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
                    parserContinuityId = parserContinuityId,
                    resume = null,
                ),
            )
            openEffect = reduction.effects.filterIsInstance<RelayV2TerminalEffect.SendOpen>()
                .single()
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
        synchronized(lock) {
            if (closed || attachment !== handle || active != null) return false
            active = state
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
        synchronized(lock) {
            if (closed || attachment !== handle || active != null) return false
            active = state
        }
        return dispatchReduction(state, reduction)
    }

    suspend fun enqueueInput(
        issued: RelayV2TerminalAttachment,
        authority: RelayV2RepositoryEffectAuthority,
        bytes: ByteArray,
    ): Boolean = lifecycleMutex.withLock {
        mutateCurrent(issued, authority) { state, checkpoint ->
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
        mutateCurrent(issued, authority) { state, checkpoint ->
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

    suspend fun handlePublicFrame(
        authority: RelayV2RepositoryEffectAuthority,
        message: RelayV2DecodedMessage,
    ): RelayV2TerminalFrameResult = lifecycleMutex.withLock {
        val state = synchronized(lock) { active }
            ?.takeIf { it.authority == authority } ?: return RelayV2TerminalFrameResult.NotOwned
        val frame = message.frame
        val type = frame["type"] as? String ?: return RelayV2TerminalFrameResult.NotOwned
        val streamId = frame["streamId"] as? String
        if (type == "error") {
            val stored = terminal.loadTerminalUnderApplyLease(state.key)
            if (stored is RelayV2TerminalStoredCheckpoint.PreOpen) {
                val action = actionForPreOpenError(stored.checkpoint, frame)
                return dispatchFrameReduction(
                    state,
                    terminal.reduceTerminalUnderApplyLease(state.key, action),
                )
            }
            val present = stored as? RelayV2TerminalStoredCheckpoint.Present
                ?: return RelayV2TerminalFrameResult.NotOwned
            val checkpoint = present.checkpoint
            if (checkpoint.deliveryToken.actorGeneration != authority.generation ||
                checkpoint.identity.target() != state.key.toTarget()
            ) return RelayV2TerminalFrameResult.NotOwned
            return dispatchFrameReduction(
                state,
                terminal.reduceTerminalUnderApplyLease(
                    state.key,
                    actionForFrame(checkpoint, frame, type),
                ),
            )
        }
        if (streamId != null && streamId != state.key.streamId) return RelayV2TerminalFrameResult.NotOwned
        val reduction = if (type == "terminal.opened") {
            opened(state, frame)
        } else {
            val stored = terminal.loadTerminalUnderApplyLease(state.key)
            if (stored is RelayV2TerminalStoredCheckpoint.PreOpen &&
                type == "terminal.reset_required" && frame["kind"] == "response"
            ) {
                return dispatchFrameReduction(
                    state,
                    terminal.reduceTerminalUnderApplyLease(
                        state.key,
                        preOpenResetAction(stored.checkpoint, frame),
                    ),
                )
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

    private fun actionForPreOpenError(
        checkpoint: RelayV2TerminalPreOpenCheckpoint,
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
            ),
        )
    }

    suspend fun detach(issued: RelayV2TerminalAttachment) = lifecycleMutex.withLock {
        val handle = issued as? Attachment ?: return
        if (handle.origin !== this) return
        val previous = synchronized(lock) {
            if (attachment !== handle) return@synchronized null
            attachment = null
            active.also { active = null }
        }
        if (previous != null) teardownActive(previous)
    }

    suspend fun teardownGeneration(
        generation: RelayV2EffectGeneration?,
    ) = lifecycleMutex.withLock {
        val previous = synchronized(lock) {
            active?.takeIf { generation == null || it.authority.generation == generation }
                ?.also { active = null }
        }
        if (previous != null) teardownActive(previous)
    }

    suspend fun dispose() = lifecycleMutex.withLock {
        val previous = synchronized(lock) {
            if (closed) return@synchronized null
            closed = true
            attachment = null
            active.also { active = null }
        }
        if (previous != null) teardownActive(previous)
    }

    private suspend fun mutateCurrent(
        issued: RelayV2TerminalAttachment,
        authority: RelayV2RepositoryEffectAuthority,
        reduce: suspend (Active, RelayV2TerminalCheckpoint) -> RelayV2TerminalReduction,
    ): Boolean {
        val handle = issued as? Attachment ?: return false
        val state = synchronized(lock) { active }
            ?.takeIf { it.attachment === handle && it.authority == authority } ?: return false
        val checkpoint = (terminal.loadTerminalUnderApplyLease(state.key)
            as? RelayV2TerminalStoredCheckpoint.Present)?.checkpoint ?: return false
        if (checkpoint.deliveryToken.actorGeneration != authority.generation) return false
        return dispatchReduction(state, reduce(state, checkpoint))
    }

    private suspend fun opened(
        state: Active,
        frame: Map<String, Any?>,
    ): RelayV2TerminalReduction {
        check(frame["kind"] == "response" && frame["requestId"] == state.requestId)
        check(frame["hostId"] == state.key.hostId && frame["hostEpoch"] == state.key.hostEpoch)
        check(frame["scopeId"] == state.key.scopeId && frame["sessionId"] == state.key.sessionId)
        val payload = frame.objectValue("payload")
        check(payload.string("openId") == state.openAttempt.openId)
        val token = payload.string("resumeToken")
        val disposition = when (payload.string("disposition")) {
            "new" -> RelayV2TerminalOpenDisposition.NEW
            "resumed" -> RelayV2TerminalOpenDisposition.RESUMED
            "reset" -> RelayV2TerminalOpenDisposition.RESET
            else -> error("Invalid terminal disposition")
        }
        val previousReference = (terminal.loadTerminalUnderApplyLease(state.key)
            as? RelayV2TerminalStoredCheckpoint.Present)
            ?.checkpoint?.identity?.resumeTokenCredentialReference
        // A resumed generation must retain the exact credential identity used by its request.
        // NEW/RESET responses establish a replacement generation and therefore a fresh reference.
        val reference = if (disposition == RelayV2TerminalOpenDisposition.RESUMED) {
            previousReference ?: error("Resumed terminal credential is missing")
        } else {
            credentialReference(state)
        }
        val owner = credentialOwner(state.key)
        val installed = credentials.installExact(owner, reference, token)
            ?: error("Terminal resume credential identity conflicted")
        val identity = RelayV2TerminalIdentity(
            profileId = state.key.profileId,
            profileActivationGeneration = state.key.profileActivationGeneration,
            principalId = state.key.principalId,
            clientInstanceId = state.key.clientInstanceId,
            hostId = state.key.hostId,
            hostEpoch = state.key.hostEpoch,
            hostInstanceId = frame.string("hostInstanceId"),
            scopeId = state.key.scopeId,
            sessionId = state.key.sessionId,
            streamId = state.key.streamId,
            generation = payload.string("generation"),
            resumeTokenCredentialReference = reference,
            resumeTokenCredentialFingerprint = installed.fingerprint,
            pane = state.key.pane,
        )
        val reduction = try {
            terminal.reduceTerminalUnderApplyLease(
                state.key,
                RelayV2TerminalAction.Opened(
                    identity = identity,
                    requestId = state.requestId,
                    openAttempt = state.openAttempt,
                    deliveryToken = state.delivery,
                    parserContinuityId = state.parserContinuityId,
                    disposition = disposition,
                    cols = state.cols,
                    rows = state.rows,
                    replayFromOffset = payload.string("replayFromOffset"),
                    tailOffset = payload.string("tailOffset"),
                    deduplicated = payload.boolean("deduplicated"),
                ),
            )
        } catch (failure: Exception) {
            if (installed.created) credentials.clear(owner, reference)
            throw failure
        }
        // From this point Room durably points at [reference]. Never roll it back if retiring the
        // predecessor or notifying presentation fails; the current checkpoint must stay resumable.
        if (previousReference != null && previousReference != reference) {
            credentials.clear(owner, previousReference)
        }
        state.attachment.observer.opened(state.key.streamId)
        return reduction
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
                is RelayV2TerminalEffect.SendInput,
                is RelayV2TerminalEffect.SendResize,
                -> when (runtime.handle(state.authority, effect)) {
                    is RelayV2TerminalRuntimeApplyResult.ParserDispatched,
                    is RelayV2TerminalRuntimeApplyResult.ControlCommitted,
                    -> true
                    else -> false
                }
                is RelayV2TerminalEffect.ResetRequired -> {
                    state.attachment.observer.reset(effect.reason)
                    false
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
            -> when (runtime.handle(execution.authority, effect)) {
                is RelayV2TerminalRuntimeApplyResult.ParserDispatched ->
                    RelayV2TerminalSynchronousEffectExecutionReceipt
                        .TRANSFERRED_TO_DURABLE_CALLBACK
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
                fatalInvalidation.invalidate(
                    execution.authority,
                    execution.key,
                    RelayV2TerminalFatalInvalidationReason.PARSER_EFFECT_ACTIVATION_UNCERTAIN,
                )
                error("Terminal parser callback failed")
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

    private fun actionForFrame(
        checkpoint: RelayV2TerminalCheckpoint,
        frame: Map<String, Any?>,
        type: String,
    ): RelayV2TerminalAction {
        if (type == "error") {
            if (frame["payload"] != null) error("Invalid terminal generic error payload")
            val errorObject = frame["error"] as? Map<*, *> ?: error("Invalid terminal generic error")
            val code = errorObject["code"] as? String
                ?: error("Invalid terminal generic error code")
            val retryable = errorObject["retryable"] as? Boolean
                ?: error("Invalid terminal generic error retryable")
            return RelayV2TerminalAction.CorrelatedError(
                requestId = frame.string("requestId"),
                hostId = frame["hostId"] as? String,
                hostEpoch = frame["hostEpoch"] as? String,
                scopeId = frame["scopeId"] as? String,
                sessionId = frame["sessionId"] as? String,
                streamId = frame["streamId"] as? String,
                commandDisposition = errorObject["commandDisposition"] as? String ?: "",
                error = RelayV2TerminalCorrelatedError(code, retryable),
            )
        }
        val payload = frame.objectValue("payload")
        val fence = RelayV2TerminalActionFence(
            checkpoint.identity.binding(),
            checkpoint.deliveryToken,
            checkpoint.openAttempt.openId,
        )
        return when (type) {
            "terminal.output" -> RelayV2TerminalAction.Output(
                fence,
                payload.string("offset"),
                RelayV2TerminalBytes.of(Base64.getDecoder().decode(payload.string("data"))),
            )
            "terminal.input_ack" -> RelayV2TerminalAction.InputAck(
                fence,
                payload.string("ackedThroughInputSeq"),
            )
            "terminal.input_error" -> RelayV2TerminalAction.InputError(
                fence,
                payload.string("inputSeq"),
                payload.string("ackedThroughInputSeq"),
                payload.controlError("error"),
            )
            "terminal.resize_ack" -> RelayV2TerminalAction.ResizeAck(
                fence,
                payload.string("ackedThroughResizeSeq"),
            )
            "terminal.resize_error" -> RelayV2TerminalAction.ResizeError(
                fence,
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
                RelayV2TerminalAction.CorrelatedResetRequired(
                    fence,
                    when (payload.string("origin")) {
                        "open" -> RelayV2TerminalResetOrigin.OPEN
                        "replay" -> RelayV2TerminalResetOrigin.REPLAY
                        else -> error("Invalid reset origin")
                    },
                    frame.string("requestId"),
                    reason = payload.resetReason(),
                    requestedOffset = payload.nullableString("requestedOffset"),
                    bufferStartOffset = payload.nullableString("bufferStartOffset"),
                    tailOffset = payload.nullableString("tailOffset"),
                )
            } else {
                RelayV2TerminalAction.AsyncResetRequired(
                    fence,
                    newId(),
                    payload.resetReason(),
                    payload.nullableString("requestedOffset"),
                    payload.nullableString("bufferStartOffset"),
                    payload.nullableString("tailOffset"),
                )
            }
            "terminal.closed" -> RelayV2TerminalAction.Closed(
                fence,
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

    private fun credentialReference(state: Active): String =
        "terminal-${state.key.profileActivationGeneration}-${state.key.streamId}-${state.openAttempt.openId}"

    private fun credentialOwner(key: RelayV2TerminalCheckpointKey) =
        RelayV2TerminalResumeCredentialOwner(key.profileId, key.profileActivationGeneration)

    private fun credentialOwner(target: RelayV2TerminalOpenTarget) =
        RelayV2TerminalResumeCredentialOwner(
            target.profileId,
            target.profileActivationGeneration,
        )

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
        when (objectValue(key).string("code")) {
            "TERMINAL_INPUT_GAP", "TERMINAL_RESIZE_GAP" -> RelayV2TerminalControlError.GAP
            "TERMINAL_INPUT_CONFLICT", "TERMINAL_RESIZE_CONFLICT" ->
                RelayV2TerminalControlError.CONFLICT
            else -> error("Invalid terminal control error")
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
}
