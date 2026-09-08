package com.tmuxworktree.mobile.core.relay.v2.terminal

import java.math.BigInteger
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCheckpointReducer.effectFence
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCheckpointReducer.retainedBufferCovers
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCheckpointReducer.terminalWritable
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCheckpointReducer.validOpenResume
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCheckpointReducer.validRequestIdHistory
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCheckpointReducer.resetResultAdvancesAuthority
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCheckpointReducer.dispositionMatches
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCheckpointReducer.hasConsumedNullResetPredecessor
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCheckpointReducer.validParserContinuity
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCheckpointReducer.pendingResumeMatchesTimeline
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCheckpointReducer.canStartParserDispatch
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalCheckpointReducer.validCloseTombstone

/**
 * Deterministic Android-free validation and sizing authority for Relay v2 terminal
 * checkpoints. Extracted verbatim from [RelayV2TerminalCheckpointReducer]; the leaf counter
 * parsers and the full structural [validateCheckpoint] pass live here. Cross-cutting helpers
 * still owned by the reducer (fences, open lineage, buffer coverage) are member-imported so the
 * moved bodies are byte-for-byte identical.
 */
internal object RelayV2TerminalCheckpointValidation {
    // region checkpoint validation (moved verbatim from the reducer)

    internal fun validateCheckpoint(checkpoint: RelayV2TerminalCheckpoint): CheckpointValidity {
        val applied = parseCounter(checkpoint.parserAppliedNextOffset)
        val received = parseCounter(checkpoint.networkReceivedThrough)
        if (checkpoint.schemaVersion != RelayV2TerminalCheckpointLimits.SCHEMA_VERSION ||
            checkpoint.identity.profileId != checkpoint.deliveryToken.actorGeneration.profileId ||
            checkpoint.identity.profileActivationGeneration !=
            checkpoint.deliveryToken.actorGeneration.profileGeneration ||
            !validParserContinuity(checkpoint.parserContinuityId) ||
            checkpoint.openedCols !in 1..1000 || checkpoint.openedRows !in 1..500 ||
            applied == null || received == null || received < applied ||
            parsePositiveCounter(checkpoint.nextParserOperationSeq) == null ||
            parsePositiveCounter(checkpoint.nextReplayRequestSeq) == null ||
            parsePositiveCounter(checkpoint.nextControlDispatchAttemptSeq) == null ||
            parsePositiveCounter(checkpoint.nextInputSeq) == null ||
            parseCounter(checkpoint.ackedThroughInputSeq) == null ||
            parsePositiveCounter(checkpoint.nextResizeSeq) == null ||
            parseCounter(checkpoint.ackedThroughResizeSeq) == null
        ) {
            return CheckpointValidity.INVALID
        }
        if (!validOpenResume(checkpoint.openMode, checkpoint.openRequestResume)) {
            return CheckpointValidity.INVALID
        }
        if (!validRequestIdHistory(checkpoint.openRequestIds) ||
            !validRequestIdHistory(checkpoint.replayRequestIds, allowEmpty = true) ||
            !validRequestIdHistory(checkpoint.closeRequestIds, allowEmpty = true) ||
            (checkpoint.openMode == RelayV2TerminalOpenMode.RESET &&
                !resetResultAdvancesAuthority(
                    checkpoint.openRequestResume,
                    checkpoint.identity,
                ) && !checkpoint.hasConsumedNullResetPredecessor())
        ) {
            return CheckpointValidity.INVALID
        }
        checkpoint.pendingOpen?.let {
            if (!validOperationId(it.requestId) || it.deliveryToken != checkpoint.deliveryToken ||
                !validRequestIdHistory(it.issuedRequestIds, it.requestId) ||
                it.requestId != checkpoint.openRequestIds.lastOrNull() ||
                (it.issuedRequestIds.size > 1 && !it.requiresDeduplicatedResponse) ||
                it.target != checkpoint.identity.target() ||
                !validParserContinuity(it.parserContinuityId) ||
                !validOpenResume(it.mode, it.resume) ||
                it.cols !in 1..1000 || it.rows !in 1..500 ||
                (it.mode == RelayV2TerminalOpenMode.NEW &&
                    (it.openAttempt != checkpoint.openAttempt ||
                        checkpoint.openMode != RelayV2TerminalOpenMode.NEW)) ||
                (it.mode != RelayV2TerminalOpenMode.RESET &&
                    it.parserContinuityId != checkpoint.parserContinuityId) ||
                (it.openAttempt.openId == checkpoint.openAttempt.openId &&
                    (it.openAttempt != checkpoint.openAttempt || it.mode != checkpoint.openMode ||
                        it.cols != checkpoint.openedCols || it.rows != checkpoint.openedRows ||
                        it.resume != checkpoint.openRequestResume ||
                        it.issuedRequestIds.take(checkpoint.openRequestIds.size) !=
                        checkpoint.openRequestIds)) ||
                (it.openAttempt != checkpoint.openAttempt &&
                    !pendingResumeMatchesTimeline(checkpoint, it)) ||
                (checkpoint.phase == RelayV2TerminalPhase.RESET_REQUIRED &&
                    it.mode != RelayV2TerminalOpenMode.RESET)
            ) {
                return CheckpointValidity.INVALID
            }
        }
        val replayFrom = parseCounter(checkpoint.openResult.replayFromOffset)
        val resultTail = parseCounter(checkpoint.openResult.tailOffset)
        if (!dispositionMatches(checkpoint.openMode, checkpoint.openResult.disposition) ||
            checkpoint.openResult.generation != checkpoint.identity.generation ||
            checkpoint.openResult.hostInstanceId != checkpoint.identity.hostInstanceId ||
            checkpoint.openResult.resumeTokenCredentialReference !=
            checkpoint.identity.resumeTokenCredentialReference ||
            checkpoint.openResult.resumeTokenCredentialFingerprint !=
            checkpoint.identity.resumeTokenCredentialFingerprint ||
            checkpoint.openResult.parserContinuityId != checkpoint.parserContinuityId ||
            checkpoint.openResult.cols != checkpoint.openedCols ||
            checkpoint.openResult.rows != checkpoint.openedRows ||
            replayFrom == null || resultTail == null || resultTail < replayFrom
        ) {
            return CheckpointValidity.INVALID
        }
        if (checkpoint.phase == RelayV2TerminalPhase.RESETTING_PARSER &&
            checkpoint.parserResetCallbackToken == null
        ) {
            return CheckpointValidity.INVALID
        }
        if (checkpoint.parserResetCallbackToken != null &&
            (checkpoint.parserInFlightCallbackToken != null ||
                checkpoint.phase !in setOf(
                    RelayV2TerminalPhase.RESETTING_PARSER,
                    RelayV2TerminalPhase.REPLAY_REQUESTED,
                    RelayV2TerminalPhase.REPLAYING,
                    RelayV2TerminalPhase.CLOSED_WAITING_PARSER,
                    RelayV2TerminalPhase.RESET_REQUIRED,
                ))
        ) {
            return CheckpointValidity.INVALID
        }
        checkpoint.parserResetCallbackToken?.let {
            if (!validCallbackToken(checkpoint, it, requireCurrentDelivery = true) ||
                it.startOffset != "0" || it.endOffset != "0"
            ) {
                return CheckpointValidity.INVALID
            }
        }
        if (checkpoint.pendingOutput.size > RelayV2TerminalCheckpointLimits.MAX_PENDING_OUTPUT_FRAMES ||
            pendingOutputBytes(checkpoint) > RelayV2TerminalCheckpointLimits.MAX_PENDING_OUTPUT_BYTES ||
            checkpoint.pendingInputs.size + checkpoint.ambiguousInputs.size >
            RelayV2TerminalCheckpointLimits.MAX_INPUT_RECORDS ||
            checkpoint.pendingResizes.size >
            RelayV2TerminalCheckpointLimits.MAX_RESIZE_RECORDS ||
            pendingInputBytes(checkpoint) > RelayV2TerminalCheckpointLimits.MAX_PENDING_INPUT_BYTES ||
            checkpointSize(checkpoint) > RelayV2TerminalCheckpointLimits.MAX_CHECKPOINT_BYTES
        ) {
            return CheckpointValidity.LIMIT_EXCEEDED
        }

        var expectedOffset = parseCounter(checkpoint.parserAppliedNextOffset)
            ?: return CheckpointValidity.INVALID
        val operationIds = mutableSetOf<String>()
        for (pending in checkpoint.pendingOutput) {
            val token = pending.callbackToken
            if (pending.bytes.size !in 1..RelayV2TerminalCheckpointLimits.MAX_FRAME_BYTES ||
                !validCallbackToken(
                    checkpoint,
                    token,
                    requireCurrentDelivery = checkpoint.phase != RelayV2TerminalPhase.RESET_REQUIRED,
                ) ||
                parseCounter(token.startOffset) != expectedOffset ||
                !operationIds.add(token.operationId)
            ) {
                return CheckpointValidity.INVALID
            }
            val computedEnd = addCounter(expectedOffset, pending.bytes.size)
                ?: return CheckpointValidity.INVALID
            if (parseCounter(token.endOffset) != computedEnd) return CheckpointValidity.INVALID
            expectedOffset = computedEnd
        }
        if (expectedOffset != received) return CheckpointValidity.INVALID
        if (checkpoint.parserInFlightCallbackToken != null &&
            checkpoint.parserInFlightCallbackToken !=
            checkpoint.pendingOutput.firstOrNull()?.callbackToken
        ) {
            return CheckpointValidity.INVALID
        }
        if (checkpoint.parserInFlightCallbackToken != null &&
            checkpoint.phase !in setOf(
                RelayV2TerminalPhase.LIVE,
                RelayV2TerminalPhase.REPLAYING,
                RelayV2TerminalPhase.REPLAY_REQUESTED,
                RelayV2TerminalPhase.CLOSED_WAITING_PARSER,
                RelayV2TerminalPhase.RESET_REQUIRED,
            )
        ) {
            return CheckpointValidity.INVALID
        }
        checkpoint.lastAppliedParserCallbackToken?.let {
            if (!validCallbackToken(checkpoint, it, requireCurrentDelivery = false)) {
                return CheckpointValidity.INVALID
            }
        }
        if (!validParserDispatchClaim(checkpoint)) {
            return CheckpointValidity.INVALID
        }
        fun ownsParserEffectCallback(token: RelayV2TerminalParserCallbackToken): Boolean =
            token == checkpoint.lastAppliedParserCallbackToken ||
                (checkpoint.phase == RelayV2TerminalPhase.RESET_REQUIRED &&
                    (token == checkpoint.parserInFlightCallbackToken ||
                        token == checkpoint.parserResetCallbackToken))
        val failedHandoffRetainsCallbackProvenance =
            checkpoint.phase == RelayV2TerminalPhase.RESET_REQUIRED &&
                checkpoint.resetReason == RelayV2TerminalResetReason.STREAM_LOST &&
                checkpoint.pendingParserEffectHandoffResetReason != null
        checkpoint.pendingParserEffectHandoff?.let {
            if (!ownsParserEffectCallback(it) ||
                !validCallbackToken(checkpoint, it, requireCurrentDelivery = true) ||
                checkpoint.pendingParserDispatchClaim != null ||
                checkpoint.pendingParserEffectActivation != null ||
                (checkpoint.pendingParserEffectHandoffResetReason != null &&
                    (checkpoint.phase != RelayV2TerminalPhase.RESET_REQUIRED ||
                        checkpoint.pendingParserEffectHandoffResetReason !=
                        checkpoint.resetReason) &&
                    !failedHandoffRetainsCallbackProvenance)
            ) {
                return CheckpointValidity.INVALID
            }
        }
        if (checkpoint.pendingParserEffectHandoff == null &&
            checkpoint.pendingParserEffectHandoffResetReason != null
        ) {
            return CheckpointValidity.INVALID
        }
        checkpoint.pendingParserEffectActivation?.let { activation ->
            if (!ownsParserEffectCallback(activation.callbackToken) ||
                !validCallbackToken(
                    checkpoint,
                    activation.callbackToken,
                    requireCurrentDelivery = true,
                ) || !activationOwnsPendingNextWrite(checkpoint, activation) ||
                checkpoint.pendingParserEffectHandoff != null ||
                checkpoint.pendingParserEffectHandoffResetReason != null ||
                !validOperationId(activation.reservationId) ||
                !validOperationId(activation.batchFingerprint)
            ) {
                return CheckpointValidity.INVALID
            }
        }
        if (checkpoint.phase == RelayV2TerminalPhase.REPLAY_REQUESTED &&
            checkpoint.pendingReplay == null
        ) {
            return CheckpointValidity.INVALID
        }
        checkpoint.pendingReplay?.let {
            if (checkpoint.phase != RelayV2TerminalPhase.REPLAY_REQUESTED ||
                it.fence != effectFence(checkpoint) ||
                parseCounter(it.fromOffset) != received ||
                !validOperationId(it.requestId) ||
                it.requestId != checkpoint.replayRequestIds.lastOrNull()
            ) {
                return CheckpointValidity.INVALID
            }
        }
        if (checkpoint.replayTargetOffset != null &&
            parseCounter(checkpoint.replayTargetOffset) == null
        ) {
            return CheckpointValidity.INVALID
        }
        if ((checkpoint.phase == RelayV2TerminalPhase.REPLAYING) !=
            (checkpoint.replayTargetOffset != null)
        ) {
            return CheckpointValidity.INVALID
        }
        if (checkpoint.phase == RelayV2TerminalPhase.REPLAYING &&
            parseCounter(checkpoint.replayTargetOffset ?: "")?.let { target ->
                target < applied ||
                    (target < received && checkpoint.pendingOutput.none {
                        parseCounter(it.callbackToken.endOffset) == target
                    })
            } != false
        ) {
            return CheckpointValidity.INVALID
        }
        if (checkpoint.pendingOutput.isNotEmpty() &&
            checkpoint.parserInFlightCallbackToken == null &&
            checkpoint.parserResetCallbackToken == null &&
            canStartParserDispatch(checkpoint)
        ) {
            return CheckpointValidity.INVALID
        }
        if (!validInputQueue(checkpoint) || !validResizeQueue(checkpoint) ||
            !validDispatchClaims(checkpoint)
        ) {
            return CheckpointValidity.INVALID
        }
        val writable = terminalWritable(checkpoint)
        if (writable != (checkpoint.activeControlDispatchLease != null) ||
            checkpoint.activeControlDispatchLease?.fence?.let { it != effectFence(checkpoint) } == true
        ) {
            return CheckpointValidity.INVALID
        }
        checkpoint.pendingClose?.let {
            if (!validOperationId(it.closeAttempt.closeId) ||
                !validOperationId(it.closeAttempt.fingerprint) ||
                !validOperationId(it.requestId) ||
                !validRequestIdHistory(it.issuedRequestIds, it.requestId) ||
                it.issuedRequestIds != checkpoint.closeRequestIds ||
                checkpoint.closed?.tombstone?.closeAttempt != null ||
                checkpoint.pendingCloseWhenOpened != null || checkpoint.pendingOpen != null
            ) {
                return CheckpointValidity.INVALID
            }
        }
        checkpoint.pendingCloseWhenOpened?.let {
            if (!validOperationId(it.closeAttempt.closeId) ||
                !validOperationId(it.closeAttempt.fingerprint) ||
                !validOperationId(it.requestId) ||
                !validRequestIdHistory(it.issuedRequestIds, it.requestId) ||
                checkpoint.pendingClose != null || checkpoint.closed != null ||
                (checkpoint.pendingOpen == null &&
                    checkpoint.phase != RelayV2TerminalPhase.RESET_REQUIRED) ||
                it.issuedRequestIds.any { requestId ->
                    requestId in checkpoint.openRequestIds ||
                        requestId in checkpoint.replayRequestIds ||
                        requestId in checkpoint.closeRequestIds
                }
            ) {
                return CheckpointValidity.INVALID
            }
        }
        if (checkpoint.pendingClose == null &&
            (checkpoint.closeRequestIds.isNotEmpty() !=
                (checkpoint.closed?.tombstone?.closeAttempt != null))
        ) {
            return CheckpointValidity.INVALID
        }
        checkpoint.closed?.let { closed ->
            val tombstone = closed.tombstone
            val retained = closed.retainedBuffer
            val finalOffset = parseCounter(tombstone.finalOffset)
                ?: return CheckpointValidity.INVALID
            val bufferStart = retained.bufferStartOffset?.let(::parseCounter)
            if (finalOffset < received ||
                tombstone.generation != checkpoint.identity.generation ||
                tombstone.openId != checkpoint.openAttempt.openId ||
                !validCloseTombstone(tombstone) ||
                (retained.replayAvailable && (bufferStart == null || bufferStart > finalOffset)) ||
                (!retained.replayAvailable && retained.bufferStartOffset != null) ||
                checkpoint.pendingInputs.isNotEmpty() || checkpoint.pendingResizes.isNotEmpty() ||
                checkpoint.phase !in setOf(
                    RelayV2TerminalPhase.REPLAY_REQUESTED,
                    RelayV2TerminalPhase.REPLAYING,
                    RelayV2TerminalPhase.CLOSED_WAITING_PARSER,
                    RelayV2TerminalPhase.CLOSED_WAITING_CLOSE,
                    RelayV2TerminalPhase.FINALIZED,
                    RelayV2TerminalPhase.RESET_REQUIRED,
                )
            ) {
                return CheckpointValidity.INVALID
            }
            if ((checkpoint.phase == RelayV2TerminalPhase.REPLAY_REQUESTED &&
                    finalOffset <= received) ||
                (checkpoint.phase == RelayV2TerminalPhase.REPLAYING &&
                    parseCounter(checkpoint.replayTargetOffset ?: "") != finalOffset)
            ) {
                return CheckpointValidity.INVALID
            }
            if (checkpoint.phase == RelayV2TerminalPhase.REPLAY_REQUESTED &&
                !retainedBufferCovers(retained, received)
            ) {
                return CheckpointValidity.OFFSET_EXPIRED
            }
        }
        if (checkpoint.closed == null &&
            checkpoint.phase in setOf(
                RelayV2TerminalPhase.CLOSED_WAITING_PARSER,
                RelayV2TerminalPhase.CLOSED_WAITING_CLOSE,
                RelayV2TerminalPhase.FINALIZED,
            )
        ) {
            return CheckpointValidity.INVALID
        }
        if (checkpoint.phase == RelayV2TerminalPhase.CLOSED_WAITING_PARSER) {
            val finalOffset = checkpoint.closed?.tombstone?.finalOffset?.let(::parseCounter)
                ?: return CheckpointValidity.INVALID
            if (finalOffset != received || checkpoint.pendingReplay != null ||
                checkpoint.replayTargetOffset != null ||
                (checkpoint.parserResetCallbackToken == null &&
                    checkpoint.pendingOutput.isEmpty())
            ) {
                return CheckpointValidity.INVALID
            }
        }
        if (checkpoint.phase == RelayV2TerminalPhase.CLOSED_WAITING_CLOSE) {
            val finalOffset = checkpoint.closed?.tombstone?.finalOffset?.let(::parseCounter)
                ?: return CheckpointValidity.INVALID
            if (finalOffset != received || finalOffset != applied ||
                checkpoint.pendingClose == null ||
                checkpoint.closed.tombstone.closeAttempt != null ||
                checkpoint.pendingOutput.isNotEmpty() || checkpoint.pendingReplay != null ||
                checkpoint.replayTargetOffset != null ||
                checkpoint.parserResetCallbackToken != null ||
                checkpoint.parserInFlightCallbackToken != null
            ) {
                return CheckpointValidity.INVALID
            }
        }
        if ((checkpoint.phase in setOf(
                RelayV2TerminalPhase.RESET_REQUIRED,
                RelayV2TerminalPhase.LOST,
            )) !=
            (checkpoint.resetReason != null)
        ) {
            return CheckpointValidity.INVALID
        }
        if (checkpoint.phase == RelayV2TerminalPhase.FINALIZED &&
            (checkpoint.pendingOutput.isNotEmpty() || checkpoint.pendingReplay != null ||
                checkpoint.parserInFlightCallbackToken != null || checkpoint.closed == null ||
                checkpoint.closed.tombstone.finalOffset != checkpoint.parserAppliedNextOffset ||
                checkpoint.networkReceivedThrough != checkpoint.parserAppliedNextOffset ||
                checkpoint.pendingInputs.isNotEmpty() || checkpoint.pendingResizes.isNotEmpty() ||
                checkpoint.pendingCloseWhenOpened != null || checkpoint.pendingClose != null ||
                checkpoint.parserResetCallbackToken != null)
        ) {
            return CheckpointValidity.INVALID
        }
        if (checkpoint.phase == RelayV2TerminalPhase.LOST &&
            (checkpoint.closed != null || checkpoint.pendingOpen != null ||
                checkpoint.pendingReplay != null || checkpoint.replayTargetOffset != null ||
                checkpoint.pendingCloseWhenOpened != null || checkpoint.pendingClose != null ||
                checkpoint.closeRequestIds.isNotEmpty() ||
                checkpoint.pendingOutput.isNotEmpty() ||
                checkpoint.parserAppliedNextOffset != checkpoint.networkReceivedThrough ||
                checkpoint.parserResetCallbackToken != null ||
                checkpoint.parserInFlightCallbackToken != null ||
                checkpoint.pendingParserDispatchClaim != null ||
                checkpoint.pendingParserEffectHandoff != null ||
                checkpoint.pendingParserEffectHandoffResetReason != null ||
                checkpoint.pendingParserEffectActivation != null ||
                checkpoint.pendingInputs.isNotEmpty() || checkpoint.pendingResizes.isNotEmpty() ||
                checkpoint.activeControlDispatchLease != null)
        ) {
            return CheckpointValidity.INVALID
        }
        return CheckpointValidity.VALID
    }

    private fun validCallbackToken(
        checkpoint: RelayV2TerminalCheckpoint,
        token: RelayV2TerminalParserCallbackToken,
        requireCurrentDelivery: Boolean,
    ): Boolean = token.fence.identity == checkpoint.identity &&
        token.fence.openAttempt == checkpoint.openAttempt &&
        (!requireCurrentDelivery || token.fence.deliveryToken == checkpoint.deliveryToken) &&
        token.parserContinuityId == checkpoint.parserContinuityId &&
        validOperationId(token.operationId) &&
        parseCounter(token.startOffset) != null &&
        parseCounter(token.endOffset)?.let {
            it >= requireNotNull(parseCounter(token.startOffset))
        } == true

    internal fun validOperationId(value: String): Boolean = value.isNotBlank() &&
        value.toByteArray(Charsets.UTF_8).size <=
        RelayV2TerminalCheckpointLimits.MAX_ID_UTF8_BYTES &&
        '\u0000' !in value

    private fun validInputQueue(checkpoint: RelayV2TerminalCheckpoint): Boolean {
        var expected = parseCounter(checkpoint.ackedThroughInputSeq)?.plus(ONE) ?: return false
        val ambiguousValid = checkpoint.ambiguousInputs.all {
            parsePositiveCounter(it.inputSeq) != null &&
                validOperationId(it.generation) &&
                it.bytes.size in 1..RelayV2TerminalCheckpointLimits.MAX_FRAME_BYTES
        }
        if (!ambiguousValid) return false
        val currentAmbiguous = checkpoint.ambiguousInputs
            .filter { it.generation == checkpoint.identity.generation }
            .mapNotNull { parseCounter(it.inputSeq) }
        val pendingSequences = checkpoint.pendingInputs.map { pending ->
            if (pending.generation != checkpoint.identity.generation ||
                pending.bytes.size !in 1..RelayV2TerminalCheckpointLimits.MAX_FRAME_BYTES
            ) {
                return false
            }
            parseCounter(pending.inputSeq) ?: return false
        }
        if (pendingSequences != pendingSequences.sorted()) return false
        for (sequence in (currentAmbiguous + pendingSequences).sorted()) {
            if (sequence != expected) return false
            expected += ONE
        }
        return parseCounter(checkpoint.nextInputSeq) == expected
    }

    private fun validResizeQueue(checkpoint: RelayV2TerminalCheckpoint): Boolean {
        var expected = parseCounter(checkpoint.ackedThroughResizeSeq)?.plus(ONE) ?: return false
        if (checkpoint.pendingResizes.isEmpty() &&
            (checkpoint.closed != null || checkpoint.phase == RelayV2TerminalPhase.RESET_REQUIRED)
        ) {
            return parseCounter(checkpoint.nextResizeSeq)?.let { it >= expected } == true
        }
        for (pending in checkpoint.pendingResizes) {
            if (pending.generation != checkpoint.identity.generation ||
                parseCounter(pending.resizeSeq) != expected ||
                pending.cols !in 1..1000 || pending.rows !in 1..500
            ) {
                return false
            }
            expected += ONE
        }
        if (parseCounter(checkpoint.nextResizeSeq) != expected) return false
        return true
    }

    private fun validDispatchClaims(checkpoint: RelayV2TerminalCheckpoint): Boolean {
        val nextAttempt = parsePositiveCounter(checkpoint.nextControlDispatchAttemptSeq)
            ?: return false
        val claims = buildList<RelayV2TerminalControlDispatchClaim> {
            checkpoint.pendingInputs.mapNotNullTo(this) { it.dispatchClaim }
            checkpoint.pendingResizes.mapNotNullTo(this) { it.dispatchClaim }
        }
        if (claims.map { it.attemptId }.distinct().size != claims.size) return false
        if (claims.isNotEmpty() && checkpoint.activeControlDispatchLease == null) return false
        fun validAttempt(claim: RelayV2TerminalControlDispatchClaim): Boolean {
            val sequence = claim.attemptId.removePrefix("dispatch-")
            return claim.attemptId == "dispatch-$sequence" && validOperationId(claim.attemptId) &&
                parsePositiveCounter(sequence)?.let { it < nextAttempt } == true &&
                claim.dispatchLease == checkpoint.activeControlDispatchLease &&
                claim.dispatchLease.fence == effectFence(checkpoint) &&
                claim.generation == checkpoint.identity.generation
        }
        checkpoint.pendingInputs.forEachIndexed { index, pending ->
            pending.dispatchClaim?.let { claim ->
                if (!validAttempt(claim) || claim.generation != pending.generation ||
                    claim.inputSeq != pending.inputSeq || claim.bytes != pending.bytes ||
                    (claim.phase == RelayV2TerminalControlDispatchClaimPhase.LOCALLY_SENT &&
                        pending.disposition != RelayV2TerminalControlDisposition.SENT) ||
                    checkpoint.pendingInputs.take(index).any {
                        it.disposition != RelayV2TerminalControlDisposition.SENT
                    }
                ) {
                    return false
                }
            }
        }
        checkpoint.pendingResizes.forEachIndexed { index, pending ->
            pending.dispatchClaim?.let { claim ->
                if (!validAttempt(claim) || claim.generation != pending.generation ||
                    claim.resizeSeq != pending.resizeSeq || claim.cols != pending.cols ||
                    claim.rows != pending.rows ||
                    (claim.phase == RelayV2TerminalControlDispatchClaimPhase.LOCALLY_SENT &&
                        pending.disposition != RelayV2TerminalControlDisposition.SENT) ||
                    checkpoint.pendingResizes.take(index).any {
                        it.disposition != RelayV2TerminalControlDisposition.SENT
                    }
                ) {
                    return false
                }
            }
        }
        return true
    }

    /**
     * While A is being synchronously activated, its batch owner may claim only the exact next
     * queue-head write emitted by that callback. No reset, detached write, or later batch may
     * borrow the still-live reservation authority.
     */
    private fun activationOwnsPendingNextWrite(
        checkpoint: RelayV2TerminalCheckpoint,
        activation: RelayV2TerminalParserEffectActivation,
    ): Boolean {
        val claim = checkpoint.pendingParserDispatchClaim ?: return true
        if (claim !is RelayV2TerminalParserDispatchClaim.Write ||
            activation.callbackToken != checkpoint.lastAppliedParserCallbackToken ||
            activation.callbackToken.fence != claim.fence ||
            claim.authorizedPhase != checkpoint.phase ||
            claim.callbackToken != checkpoint.parserInFlightCallbackToken
        ) {
            return false
        }
        val head = checkpoint.pendingOutput.firstOrNull() ?: return false
        val activationEnd = parseCounter(activation.callbackToken.endOffset) ?: return false
        return head.callbackToken == claim.callbackToken && head.bytes == claim.bytes &&
            activationEnd == parseCounter(checkpoint.parserAppliedNextOffset) &&
            activationEnd == parseCounter(claim.callbackToken.startOffset)
    }

    private fun validParserDispatchClaim(checkpoint: RelayV2TerminalCheckpoint): Boolean {
        val claim = checkpoint.pendingParserDispatchClaim ?: return true
        if (checkpoint.phase in setOf(
                RelayV2TerminalPhase.RESET_REQUIRED,
                RelayV2TerminalPhase.FINALIZED,
                RelayV2TerminalPhase.LOST,
            ) || claim.fence != effectFence(checkpoint) ||
            claim.callbackToken.fence != claim.fence ||
            !validCallbackToken(checkpoint, claim.callbackToken, requireCurrentDelivery = true)
        ) {
            return false
        }
        return when (claim) {
            is RelayV2TerminalParserDispatchClaim.Write ->
                claim.authorizedPhase in setOf(
                    RelayV2TerminalPhase.LIVE,
                    RelayV2TerminalPhase.REPLAYING,
                    RelayV2TerminalPhase.REPLAY_REQUESTED,
                    RelayV2TerminalPhase.CLOSED_WAITING_PARSER,
                ) && claim.callbackToken == checkpoint.parserInFlightCallbackToken &&
                    checkpoint.pendingOutput.firstOrNull()?.let {
                        it.callbackToken == claim.callbackToken && it.bytes == claim.bytes
                    } == true
            is RelayV2TerminalParserDispatchClaim.Reset ->
                claim.authorizedPhase in setOf(
                    RelayV2TerminalPhase.RESETTING_PARSER,
                    RelayV2TerminalPhase.REPLAY_REQUESTED,
                    RelayV2TerminalPhase.REPLAYING,
                    RelayV2TerminalPhase.CLOSED_WAITING_PARSER,
                ) && claim.callbackToken == checkpoint.parserResetCallbackToken
        }
    }

    private fun checkpointSize(checkpoint: RelayV2TerminalCheckpoint): Long {
        var bytes = 512L
        bytes += identityStrings(checkpoint.identity).sumOf {
            it.toByteArray(Charsets.UTF_8).size.toLong()
        }
        bytes += attemptSize(checkpoint.openAttempt)
        bytes += checkpoint.openRequestIds.sumOf { it.toByteArray(Charsets.UTF_8).size.toLong() }
        bytes += checkpoint.replayRequestIds.sumOf { it.toByteArray(Charsets.UTF_8).size.toLong() }
        bytes += checkpoint.closeRequestIds.sumOf { it.toByteArray(Charsets.UTF_8).size.toLong() }
        bytes += checkpoint.openRequestResume?.let(::openResumeSize) ?: 0
        bytes += 96L + checkpoint.openResult.generation.length +
            checkpoint.openResult.hostInstanceId.length +
            checkpoint.openResult.resumeTokenCredentialReference.length +
            checkpoint.openResult.resumeTokenCredentialFingerprint.length +
            checkpoint.openResult.parserContinuityId.length +
            checkpoint.openResult.replayFromOffset.length + checkpoint.openResult.tailOffset.length
        bytes += checkpoint.parserContinuityId.toByteArray(Charsets.UTF_8).size
        bytes += checkpoint.deliveryToken.actorGeneration.profileId
            .toByteArray(Charsets.UTF_8).size
        bytes += checkpoint.pendingOutput.sumOf {
            callbackTokenSize(it.callbackToken) + it.bytes.size.toLong()
        }
        bytes += checkpoint.pendingInputs.sumOf {
            64L + it.generation.length + it.inputSeq.length + it.bytes.size +
                (it.dispatchClaim?.let(::controlClaimSize) ?: 0L)
        }
        bytes += checkpoint.ambiguousInputs.sumOf {
            64L + it.generation.length + it.inputSeq.length + it.bytes.size
        }
        bytes += checkpoint.pendingResizes.sumOf {
            96L + (it.dispatchClaim?.let(::controlClaimSize) ?: 0L)
        }
        bytes += checkpoint.parserResetCallbackToken?.let(::callbackTokenSize) ?: 0
        bytes += checkpoint.lastAppliedParserCallbackToken?.let(::callbackTokenSize) ?: 0
        bytes += checkpoint.pendingParserDispatchClaim?.let(::parserDispatchClaimSize) ?: 0
        bytes += checkpoint.pendingParserEffectHandoff?.let(::callbackTokenSize) ?: 0
        bytes += checkpoint.pendingParserEffectHandoffResetReason?.name?.length ?: 0
        bytes += checkpoint.pendingParserEffectActivation?.let {
            callbackTokenSize(it.callbackToken) + it.reservationId.toByteArray(Charsets.UTF_8).size +
                it.batchFingerprint.toByteArray(Charsets.UTF_8).size + 32L
        } ?: 0
        bytes += checkpoint.activeControlDispatchLease?.let {
            effectFenceSize(it.fence)
        } ?: 0
        bytes += checkpoint.pendingOpen?.let {
            160L + it.requestId.toByteArray(Charsets.UTF_8).size + attemptSize(it.openAttempt) +
                it.issuedRequestIds.sumOf { value ->
                    value.toByteArray(Charsets.UTF_8).size.toLong()
                } +
                it.parserContinuityId.toByteArray(Charsets.UTF_8).size +
                targetStrings(it.target).sumOf { value ->
                    value.toByteArray(Charsets.UTF_8).size.toLong()
                } + (it.resume?.let(::openResumeSize) ?: 0)
        } ?: 0
        bytes += checkpoint.pendingReplay?.let {
            96L + it.requestId.toByteArray(Charsets.UTF_8).size + it.fromOffset.length
        } ?: 0
        bytes += checkpoint.pendingCloseWhenOpened?.let {
            64L + attemptSize(it.closeAttempt) + it.requestId.length +
                it.issuedRequestIds.sumOf { value ->
                    value.toByteArray(Charsets.UTF_8).size.toLong()
                }
        } ?: 0
        bytes += checkpoint.pendingClose?.let {
            64L + attemptSize(it.closeAttempt) + it.requestId.length +
                it.issuedRequestIds.sumOf { value ->
                    value.toByteArray(Charsets.UTF_8).size.toLong()
                }
        } ?: 0
        bytes += checkpoint.closed?.let {
            128L + it.tombstone.finalOffset.length + it.tombstone.generation.length +
                it.tombstone.openId.length +
                (it.tombstone.closeAttempt?.let(::attemptSize) ?: 0) +
                (it.retainedBuffer.bufferStartOffset?.length ?: 0)
        } ?: 0
        return bytes
    }

    private fun callbackTokenSize(token: RelayV2TerminalParserCallbackToken): Long =
        96L + effectFenceSize(token.fence) +
            token.parserContinuityId.toByteArray(Charsets.UTF_8).size +
            token.operationId.toByteArray(Charsets.UTF_8).size +
            token.startOffset.length + token.endOffset.length

    private fun effectFenceSize(fence: RelayV2TerminalEffectFence): Long =
        96L + identityStrings(fence.identity).sumOf {
            it.toByteArray(Charsets.UTF_8).size.toLong()
        } + attemptSize(fence.openAttempt)

    private fun identityStrings(identity: RelayV2TerminalIdentity): List<String> = listOf(
        identity.profileId,
        identity.principalId,
        identity.clientInstanceId,
        identity.hostId,
        identity.hostEpoch,
        identity.hostInstanceId,
        identity.scopeId,
        identity.sessionId,
        identity.streamId,
        identity.generation,
        identity.resumeTokenCredentialReference,
        identity.resumeTokenCredentialFingerprint,
    )

    private fun targetStrings(target: RelayV2TerminalOpenTarget): List<String> = listOf(
        target.profileId,
        target.principalId,
        target.clientInstanceId,
        target.hostId,
        target.hostEpoch,
        target.scopeId,
        target.sessionId,
        target.streamId,
    )

    private fun attemptSize(attempt: RelayV2TerminalOpenAttempt): Long =
        attempt.openId.toByteArray(Charsets.UTF_8).size.toLong() +
            attempt.fingerprint.toByteArray(Charsets.UTF_8).size

    private fun attemptSize(attempt: RelayV2TerminalCloseAttempt): Long =
        attempt.closeId.toByteArray(Charsets.UTF_8).size.toLong() +
            attempt.fingerprint.toByteArray(Charsets.UTF_8).size

    private fun openResumeSize(resume: RelayV2TerminalOpenResume): Long =
        48L + resume.generation.length + (resume.nextOffset?.length ?: 0) +
            resume.resumeTokenCredentialReference.toByteArray(Charsets.UTF_8).size +
            resume.resumeTokenCredentialFingerprint.toByteArray(Charsets.UTF_8).size

    private fun controlClaimSize(claim: RelayV2TerminalControlDispatchClaim): Long =
        96L + effectFenceSize(claim.dispatchLease.fence) + claim.attemptId.length +
            claim.generation.length + claim.sequence.length + claim.phase.name.length + when (claim) {
            is RelayV2TerminalControlDispatchClaim.Input -> claim.bytes.size.toLong()
            is RelayV2TerminalControlDispatchClaim.Resize -> 16L
        }

    private fun parserDispatchClaimSize(claim: RelayV2TerminalParserDispatchClaim): Long =
        64L + effectFenceSize(claim.fence) + callbackTokenSize(claim.callbackToken) + when (claim) {
            is RelayV2TerminalParserDispatchClaim.Write -> claim.bytes.size.toLong()
            is RelayV2TerminalParserDispatchClaim.Reset -> 0L
        }

    internal fun pendingOutputBytes(checkpoint: RelayV2TerminalCheckpoint): Int =
        checkpoint.pendingOutput.sumOf { it.bytes.size }

    internal fun pendingInputBytes(checkpoint: RelayV2TerminalCheckpoint): Int =
        checkpoint.pendingInputs.sumOf { it.bytes.size } +
            checkpoint.ambiguousInputs.sumOf { it.bytes.size }

    // endregion

    // region unsigned-64 counter parsing

    internal fun parseCounter(value: String): BigInteger? {
        if (!COUNTER_PATTERN.matches(value)) return null
        val parsed = runCatching { BigInteger(value) }.getOrNull() ?: return null
        return parsed.takeIf { it <= UNSIGNED_COUNTER_MAX }
    }

    internal fun parsePositiveCounter(value: String): BigInteger? =
        parseCounter(value)?.takeIf { it > ZERO }

    internal fun addCounter(value: BigInteger, increment: Int): BigInteger? =
        (value + BigInteger.valueOf(increment.toLong())).takeIf { it <= UNSIGNED_COUNTER_MAX }

    internal fun incrementCounter(value: BigInteger): BigInteger? =
        (value + ONE).takeIf { it <= UNSIGNED_COUNTER_MAX }

    // endregion

    // region counter bounds
    private val COUNTER_PATTERN = Regex("^(?:0|[1-9][0-9]*)$")
    internal val ZERO = BigInteger.ZERO
    internal val ONE = BigInteger.ONE
    private val UNSIGNED_COUNTER_MAX = BigInteger("18446744073709551615")
    // endregion

    /** Validation verdict for a persisted/transient checkpoint. */
    enum class CheckpointValidity {
        VALID,
        INVALID,
        LIMIT_EXCEEDED,
        OFFSET_EXPIRED,
        SCHEMA_INCOMPATIBLE,
    }
}
