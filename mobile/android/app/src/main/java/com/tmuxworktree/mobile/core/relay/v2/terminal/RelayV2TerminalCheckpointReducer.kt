package com.tmuxworktree.mobile.core.relay.v2.terminal

import java.math.BigInteger

/**
 * Deterministic Android-free authority for a Relay v2 terminal parser checkpoint.
 *
 * Network receipt only appends to [RelayV2TerminalCheckpoint.pendingOutput]. The durable parser
 * watermark and output credit move only through [RelayV2TerminalAction.ParserApplied].
 */
internal object RelayV2TerminalCheckpointReducer {
    /** Pure apply-time guard for a queued control effect immediately before a socket write. */
    fun authorizeControlDispatch(
        checkpoint: RelayV2TerminalCheckpoint,
        effect: RelayV2TerminalEffect,
    ): RelayV2TerminalControlDispatchAuthorization {
        val lease = when (effect) {
            is RelayV2TerminalEffect.SendInput -> effect.dispatchLease
            is RelayV2TerminalEffect.SendResize -> effect.dispatchLease
            else -> return RelayV2TerminalControlDispatchAuthorization.PAYLOAD_MISMATCH
        }
        if (!terminalWritable(checkpoint) || checkpoint.activeControlDispatchLease == null) {
            return RelayV2TerminalControlDispatchAuthorization.REVOKED
        }
        if (lease != checkpoint.activeControlDispatchLease || lease.fence != effectFence(checkpoint)) {
            return RelayV2TerminalControlDispatchAuthorization.STALE_AUTHORITY
        }
        val payloadMatches = when (effect) {
            is RelayV2TerminalEffect.SendInput -> {
                val index = checkpoint.pendingInputs.indexOfFirst {
                    it.generation == effect.generation && it.inputSeq == effect.inputSeq
                }
                index >= 0 && checkpoint.pendingInputs[index].let {
                    it.bytes == effect.bytes && it.dispatchClaim == null &&
                        checkpoint.pendingInputs.take(index).all { previous ->
                            previous.disposition == RelayV2TerminalControlDisposition.SENT
                        }
                }
            }
            is RelayV2TerminalEffect.SendResize -> {
                val index = checkpoint.pendingResizes.indexOfFirst {
                    it.generation == effect.generation && it.resizeSeq == effect.resizeSeq
                }
                index >= 0 && checkpoint.pendingResizes[index].let {
                    it.cols == effect.cols && it.rows == effect.rows && it.dispatchClaim == null &&
                        checkpoint.pendingResizes.take(index).all { previous ->
                            previous.disposition == RelayV2TerminalControlDisposition.SENT
                        }
                }
            }
            else -> false
        }
        return if (payloadMatches) {
            RelayV2TerminalControlDispatchAuthorization.AUTHORIZED
        } else {
            RelayV2TerminalControlDispatchAuthorization.PAYLOAD_MISMATCH
        }
    }

    /** Pure persisted-state authorization immediately before registering a parser operation. */
    fun authorizeParserDispatch(
        checkpoint: RelayV2TerminalCheckpoint,
        effect: RelayV2TerminalEffect,
    ): RelayV2TerminalParserDispatchAuthorization {
        if (checkpoint.phase in setOf(
                RelayV2TerminalPhase.RESET_REQUIRED,
                RelayV2TerminalPhase.FINALIZED,
            ) || checkpoint.pendingParserDispatchClaim != null ||
            checkpoint.pendingParserEffectHandoff != null
        ) {
            return RelayV2TerminalParserDispatchAuthorization.REVOKED
        }
        return when (effect) {
            is RelayV2TerminalEffect.WriteParser -> {
                val token = effect.callbackToken
                val head = checkpoint.pendingOutput.firstOrNull()
                when {
                    !canDispatchParser(checkpoint) ->
                        RelayV2TerminalParserDispatchAuthorization.REVOKED
                    effect.fence != token.fence || token.fence != effectFence(checkpoint) ||
                        checkpoint.parserInFlightCallbackToken != token ||
                        head?.callbackToken != token ->
                        RelayV2TerminalParserDispatchAuthorization.STALE_AUTHORITY
                    head?.bytes != effect.bytes ->
                        RelayV2TerminalParserDispatchAuthorization.PAYLOAD_MISMATCH
                    else -> RelayV2TerminalParserDispatchAuthorization.AUTHORIZED
                }
            }
            is RelayV2TerminalEffect.ResetParser -> {
                val token = effect.callbackToken
                when {
                    checkpoint.parserResetCallbackToken == null ->
                        RelayV2TerminalParserDispatchAuthorization.REVOKED
                    effect.fence != token.fence || token.fence != effectFence(checkpoint) ||
                        checkpoint.parserResetCallbackToken != token ->
                        RelayV2TerminalParserDispatchAuthorization.STALE_AUTHORITY
                    else -> RelayV2TerminalParserDispatchAuthorization.AUTHORIZED
                }
            }
            else -> RelayV2TerminalParserDispatchAuthorization.PAYLOAD_MISMATCH
        }
    }

    fun restore(
        stored: RelayV2TerminalStoredCheckpoint,
        expectedIdentity: RelayV2TerminalIdentity,
        expectedOpenAttempt: RelayV2TerminalOpenAttempt,
        currentDeliveryToken: RelayV2TerminalDeliveryToken,
        currentParserContinuityId: String?,
        parserOperationProof: RelayV2TerminalParserRestoreProof? = null,
    ): RelayV2TerminalReduction = when (stored) {
        RelayV2TerminalStoredCheckpoint.Missing -> missingReset(
            expectedIdentity,
            RelayV2TerminalResetReason.MISSING_CHECKPOINT,
            currentDeliveryToken,
            expectedOpenAttempt,
        )
        is RelayV2TerminalStoredCheckpoint.Invalid -> missingReset(
            expectedIdentity,
            when (stored.reason) {
                RelayV2TerminalRestoreInvalidity.SCHEMA_INCOMPATIBLE ->
                    RelayV2TerminalResetReason.SCHEMA_INCOMPATIBLE
                RelayV2TerminalRestoreInvalidity.MISSING_REQUIRED_FIELD ->
                    RelayV2TerminalResetReason.MISSING_REQUIRED_IDENTITY
                RelayV2TerminalRestoreInvalidity.LIMIT_EXCEEDED ->
                    RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED
                RelayV2TerminalRestoreInvalidity.MALFORMED_COUNTER,
                RelayV2TerminalRestoreInvalidity.CORRUPT_QUEUE,
                -> RelayV2TerminalResetReason.CHECKPOINT_INVALID
            },
            currentDeliveryToken,
            expectedOpenAttempt,
        )
        is RelayV2TerminalStoredCheckpoint.PreOpen -> missingReset(
            expectedIdentity,
            RelayV2TerminalResetReason.CHECKPOINT_INVALID,
            currentDeliveryToken,
            expectedOpenAttempt,
        )
        is RelayV2TerminalStoredCheckpoint.Present -> {
            val untrusted = stored.checkpoint
            val validity = if (
                untrusted.schemaVersion == RelayV2TerminalCheckpointLimits.SCHEMA_VERSION &&
                untrusted.identity.identityVersion ==
                RelayV2TerminalCheckpointLimits.IDENTITY_VERSION
            ) {
                preflightCheckpoint(untrusted)
            } else {
                CheckpointValidity.SCHEMA_INCOMPATIBLE
            }
            when (validity) {
                CheckpointValidity.SCHEMA_INCOMPATIBLE -> missingReset(
                    expectedIdentity,
                    RelayV2TerminalResetReason.SCHEMA_INCOMPATIBLE,
                    currentDeliveryToken,
                    expectedOpenAttempt,
                )
                CheckpointValidity.LIMIT_EXCEEDED -> missingReset(
                    expectedIdentity,
                    RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED,
                    currentDeliveryToken,
                    expectedOpenAttempt,
                )
                CheckpointValidity.OFFSET_EXPIRED -> missingReset(
                    expectedIdentity,
                    RelayV2TerminalResetReason.OFFSET_EXPIRED,
                    currentDeliveryToken,
                    expectedOpenAttempt,
                )
                CheckpointValidity.INVALID -> missingReset(
                    expectedIdentity,
                    RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                    currentDeliveryToken,
                    expectedOpenAttempt,
                )
                CheckpointValidity.VALID -> restoreValidatedCheckpoint(
                    untrusted,
                    expectedIdentity,
                    expectedOpenAttempt,
                    currentDeliveryToken,
                    currentParserContinuityId,
                    parserOperationProof,
                )
            }
        }
    }

    fun restorePreOpen(
        stored: RelayV2TerminalStoredCheckpoint,
        expectedTarget: RelayV2TerminalOpenTarget,
        expectedOpenAttempt: RelayV2TerminalOpenAttempt,
        currentDeliveryToken: RelayV2TerminalDeliveryToken,
        currentParserContinuityId: String?,
    ): RelayV2TerminalReduction = when (stored) {
        RelayV2TerminalStoredCheckpoint.Missing,
        is RelayV2TerminalStoredCheckpoint.Invalid,
        is RelayV2TerminalStoredCheckpoint.Present,
        -> missingReset(null, RelayV2TerminalResetReason.MISSING_CHECKPOINT)
        is RelayV2TerminalStoredCheckpoint.PreOpen -> {
            val untrusted = stored.checkpoint
            if (!preflightPreOpenCheckpoint(untrusted)) {
                missingReset(null, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
            } else {
                val checkpoint = snapshotPreOpenCheckpoint(untrusted)
                when {
                    !validPreOpenCheckpoint(checkpoint) ->
                        missingReset(null, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
                    checkpoint.target != expectedTarget ||
                        authoritativePreOpenAttempt(checkpoint) != expectedOpenAttempt ->
                        missingReset(null, RelayV2TerminalResetReason.IDENTITY_CHANGED)
                    currentParserContinuityId.isNullOrBlank() ||
                        checkpoint.parserContinuityId != currentParserContinuityId ->
                        missingReset(null, RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST)
                    checkpoint.deliveryToken != currentDeliveryToken -> {
                        if (!deliveryIsStrictlyFresher(
                                checkpoint.deliveryToken,
                                currentDeliveryToken,
                            )
                        ) {
                            missingReset(null, RelayV2TerminalResetReason.IDENTITY_CHANGED)
                        } else {
                            if (checkpoint.phase == RelayV2TerminalPreOpenPhase.RESET_REQUIRED) {
                                val reason = checkpoint.resetReason
                                    ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID
                                preOpenReduction(
                                    checkpoint.copy(
                                        deliveryToken = currentDeliveryToken,
                                        resetFence = checkpoint.resetFence?.copy(
                                            deliveryToken = currentDeliveryToken,
                                        ),
                                    ),
                                    RelayV2TerminalOutcome.ResetRequired(reason),
                                    listOf(
                                        RelayV2TerminalEffect.ResetRequired(
                                            checkpoint.resetFence?.copy(
                                                deliveryToken = currentDeliveryToken,
                                            ),
                                            reason,
                                            null,
                                        ),
                                    ),
                                )
                            } else {
                                val reboundPending = requireNotNull(checkpoint.pendingOpen).copy(
                                    deliveryToken = currentDeliveryToken,
                                )
                                val rebound = checkpoint.copy(
                                    deliveryToken = currentDeliveryToken,
                                    pendingOpen = reboundPending,
                                )
                                preOpenReduction(
                                    rebound,
                                    RelayV2TerminalOutcome.Restored,
                                )
                            }
                        }
                    }
                    checkpoint.phase == RelayV2TerminalPreOpenPhase.RESET_REQUIRED ->
                        preOpenReduction(
                            checkpoint,
                            RelayV2TerminalOutcome.ResetRequired(
                                checkpoint.resetReason
                                    ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                            ),
                            listOf(
                                RelayV2TerminalEffect.ResetRequired(
                                    checkpoint.resetFence,
                                    checkpoint.resetReason
                                        ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                                    null,
                                ),
                            ),
                        )
                    else -> preOpenReduction(
                        checkpoint,
                        RelayV2TerminalOutcome.Restored,
                    )
                }
            }
        }
    }

    fun reduce(
        checkpoint: RelayV2TerminalCheckpoint?,
        action: RelayV2TerminalAction,
    ): RelayV2TerminalReduction {
        if (checkpoint == null) {
            return if (action is RelayV2TerminalAction.BeginOpenAttempt) {
                beginPreOpen(null, action)
            } else {
                missingReset(null, RelayV2TerminalResetReason.MISSING_CHECKPOINT)
            }
        }
        val current = checkpoint
        if (current.phase == RelayV2TerminalPhase.FINALIZED &&
            action !is RelayV2TerminalAction.ParserEffectsReserved &&
            action !is RelayV2TerminalAction.ParserEffectsActivated &&
            action !is RelayV2TerminalAction.ParserEffectReservationFailed &&
            action !is RelayV2TerminalAction.ParserEffectActivationFailed
        ) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.FINALIZED_LATE_EVENT),
            )
        }
        if (action is RelayV2TerminalAction.Opened) return opened(current, action)
        if (action is RelayV2TerminalAction.BeginOpenAttempt) {
            return beginOpenAttempt(current, action)
        }
        actionGuard(current, action)?.let { return it }
        if (current.phase == RelayV2TerminalPhase.RESET_REQUIRED &&
            action !is RelayV2TerminalAction.VerifyContinuity &&
            action !is RelayV2TerminalAction.RebindDelivery &&
            action !is RelayV2TerminalAction.ParserEffectsReserved &&
            action !is RelayV2TerminalAction.ParserEffectsActivated &&
            action !is RelayV2TerminalAction.ParserEffectReservationFailed &&
            action !is RelayV2TerminalAction.ParserEffectActivationFailed
        ) {
            if (action is RelayV2TerminalAction.RequestClose) {
                val requested = requestClose(current, action)
                val requestedCheckpoint = requireNotNull(requested.checkpoint)
                return reduction(
                    requestedCheckpoint,
                    RelayV2TerminalOutcome.ResetRequired(
                        current.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                    ),
                    requested.effects + RelayV2TerminalEffect.ResetRequired(
                        effectFence(requestedCheckpoint),
                        requestedCheckpoint.resetReason
                            ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                        requestedCheckpoint.parserAppliedNextOffset,
                    ),
                )
            }
            if (action is RelayV2TerminalAction.Closed) {
                return closedWhileResetRequired(current, action)
            }
            return reduction(
                current,
                RelayV2TerminalOutcome.ResetRequired(
                    current.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                ),
                RelayV2TerminalEffect.ResetRequired(
                    effectFence(current),
                    current.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                    current.parserAppliedNextOffset,
                ),
            )
        }
        return when (action) {
            is RelayV2TerminalAction.BeginOpenAttempt -> error("Handled above")
            is RelayV2TerminalAction.Opened -> error("Handled above")
            is RelayV2TerminalAction.VerifyContinuity -> verifyContinuity(current, action)
            is RelayV2TerminalAction.RebindDelivery -> rebindDelivery(current, action)
            is RelayV2TerminalAction.Output -> output(current, action)
            is RelayV2TerminalAction.ReplayStarted -> replayStarted(current, action)
            is RelayV2TerminalAction.ClaimParserDispatch ->
                claimParserDispatch(current, action)
            is RelayV2TerminalAction.ReleaseParserDispatch ->
                releaseParserDispatch(current, action)
            is RelayV2TerminalAction.ParserApplied -> parserApplied(current, action)
            is RelayV2TerminalAction.ParserFailed -> parserFailed(current, action)
            is RelayV2TerminalAction.ParserResetApplied -> parserResetApplied(current, action)
            is RelayV2TerminalAction.ParserEffectsReserved ->
                parserEffectsReserved(current, action)
            is RelayV2TerminalAction.ParserEffectsActivated ->
                parserEffectsActivated(current, action)
            is RelayV2TerminalAction.ParserEffectReservationFailed ->
                parserEffectReservationFailed(current, action)
            is RelayV2TerminalAction.ParserEffectActivationFailed ->
                parserEffectActivationFailed(current, action)
            is RelayV2TerminalAction.EnqueueInput -> enqueueInput(current, action)
            is RelayV2TerminalAction.ClaimControlDispatch -> claimControlDispatch(current, action)
            is RelayV2TerminalAction.ReleaseControlDispatch ->
                releaseControlDispatch(current, action)
            is RelayV2TerminalAction.ControlDispatchUncertain ->
                controlDispatchUncertain(current, action)
            is RelayV2TerminalAction.InputSent -> inputSent(current, action)
            is RelayV2TerminalAction.InputAck -> inputAck(current, action)
            is RelayV2TerminalAction.InputError -> inputError(current, action)
            is RelayV2TerminalAction.EnqueueResize -> enqueueResize(current, action)
            is RelayV2TerminalAction.ResizeSent -> resizeSent(current, action)
            is RelayV2TerminalAction.ResizeAck -> resizeAck(current, action)
            is RelayV2TerminalAction.ResizeError -> resizeError(current, action)
            is RelayV2TerminalAction.RetryUnackedControls -> retryUnacked(current, action)
            is RelayV2TerminalAction.RetryReplay -> retryReplay(current, action)
            is RelayV2TerminalAction.RequestClose -> requestClose(current, action)
            is RelayV2TerminalAction.Closed -> closed(current, action)
            is RelayV2TerminalAction.CorrelatedResetRequired ->
                correlatedResetRequired(current, action)
            is RelayV2TerminalAction.AsyncResetRequired -> asyncResetRequired(current, action)
            is RelayV2TerminalAction.CorrelatedError -> correlatedError(current, action)
            is RelayV2TerminalAction.PreOpenResetRequired ->
                reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
    }

    private fun correlatedError(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.CorrelatedError,
    ): RelayV2TerminalReduction {
        val owners = buildList {
            current.pendingOpen?.let { if (action.requestId in it.issuedRequestIds) add("open") }
            current.pendingReplay?.let { if (action.requestId == it.requestId) add("replay") }
            current.pendingClose?.let { if (action.requestId in it.issuedRequestIds) add("close") }
        }
        if (owners.isEmpty()) return reduction(
            current, RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_DELIVERY),
        )
        if (owners.size != 1) return reduction(
            current, RelayV2TerminalOutcome.ProtocolViolation("AMBIGUOUS_TERMINAL_ERROR_OWNER"),
        )
        if (action.commandDisposition != "not_applicable") return reduction(
            current, RelayV2TerminalOutcome.ProtocolViolation("INVALID_COMMAND_DISPOSITION"),
        )
        val identity = current.identity
        val mismatch = (action.hostId != null && action.hostId != identity.hostId) ||
            (action.hostEpoch != null && action.hostEpoch != identity.hostEpoch) ||
            (action.scopeId != null && action.scopeId != identity.scopeId) ||
            (action.sessionId != null && action.sessionId != identity.sessionId) ||
            (action.streamId != null && action.streamId != identity.streamId)
        if (mismatch) return reduction(current, RelayV2TerminalOutcome.ProtocolViolation("TERMINAL_ERROR_IDENTITY_MISMATCH"))
        return reduction(
            current,
            RelayV2TerminalOutcome.CorrelatedErrorRejected(action.requestId, action.error.code),
        )
    }

    fun reduce(
        checkpoint: RelayV2TerminalPreOpenCheckpoint,
        action: RelayV2TerminalAction,
    ): RelayV2TerminalReduction = when (action) {
        is RelayV2TerminalAction.BeginOpenAttempt -> beginPreOpen(checkpoint, action)
        is RelayV2TerminalAction.Opened -> openedPreOpen(checkpoint, action)
        is RelayV2TerminalAction.CorrelatedError -> {
            val pending = checkpoint.pendingOpen
            val owned = pending != null && action.requestId in pending.issuedRequestIds
            if (!owned) preOpenReduction(
                checkpoint,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_DELIVERY),
            ) else if (action.commandDisposition != "not_applicable") preOpenReduction(
                checkpoint,
                RelayV2TerminalOutcome.ProtocolViolation("INVALID_COMMAND_DISPOSITION"),
            ) else if (
                action.requestId in pending!!.issuedRequestIds &&
                (action.streamId == null || action.streamId == pending.target.streamId) &&
                (action.hostId == null || action.hostId == pending.target.hostId) &&
                (action.hostEpoch == null || action.hostEpoch == pending.target.hostEpoch) &&
                (action.scopeId == null || action.scopeId == pending.target.scopeId) &&
                (action.sessionId == null || action.sessionId == pending.target.sessionId)
            ) preOpenReduction(
                checkpoint,
                RelayV2TerminalOutcome.CorrelatedErrorRejected(action.requestId, action.error.code),
            ) else preOpenReduction(
                checkpoint,
                RelayV2TerminalOutcome.ProtocolViolation("TERMINAL_ERROR_IDENTITY_MISMATCH"),
            )
        }
        is RelayV2TerminalAction.PreOpenResetRequired ->
            preOpenResetRequired(checkpoint, action)
        else -> preOpenReduction(
            checkpoint,
            RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_DELIVERY),
        )
    }

    private fun beginOpenAttempt(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.BeginOpenAttempt,
    ): RelayV2TerminalReduction {
        deliveryGuard(current, action.deliveryToken)?.let { return it }
        if (!validOpenRequest(action) || action.target != current.identity.target()) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        if (action.mode != RelayV2TerminalOpenMode.RESET &&
            action.parserContinuityId != current.parserContinuityId
        ) {
            return reset(current, RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST)
        }
        if (current.phase == RelayV2TerminalPhase.RESET_REQUIRED &&
            action.mode != RelayV2TerminalOpenMode.RESET
        ) {
            return reduction(
                current,
                RelayV2TerminalOutcome.ResetRequired(
                    current.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                ),
                RelayV2TerminalEffect.ResetRequired(
                    effectFence(current),
                    current.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                    current.parserAppliedNextOffset,
                ),
            )
        }
        if (action.openAttempt.openId == current.openAttempt.openId &&
            (action.openAttempt != current.openAttempt || action.mode != current.openMode ||
                action.cols != current.openedCols || action.rows != current.openedRows ||
                action.resume != current.openRequestResume)
        ) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        if (action.requestId in current.openRequestIds) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.NETWORK_REQUEST_ID_REUSED,
                ),
            )
        }
        current.pendingOpen?.let { pending ->
            if (!pending.sameLogicalAttempt(action)) {
                return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
            }
            if (action.requestId in pending.issuedRequestIds) {
                return reduction(
                    current,
                    RelayV2TerminalOutcome.Ignored(
                        RelayV2TerminalIgnoredReason.NETWORK_REQUEST_ID_REUSED,
                    ),
                )
            }
            val issuedRequestIds = appendRequestId(pending.issuedRequestIds, action.requestId)
                ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED)
            val openRequestIds = appendRequestId(current.openRequestIds, action.requestId)
                ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED)
            val retried = pending.copy(
                requestId = action.requestId,
                issuedRequestIds = issuedRequestIds,
                deliveryToken = action.deliveryToken,
                requiresDeduplicatedResponse = true,
            )
            return commit(
                current,
                current.copy(
                    pendingOpen = retried,
                    openRequestIds = openRequestIds,
                ),
                RelayV2TerminalOutcome.Applied,
                listOf(retried.sendOpen(current)),
            )
        }
        if (action.openAttempt != current.openAttempt &&
            action.mode == RelayV2TerminalOpenMode.NEW
        ) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        val expectedResume = when {
            action.openAttempt == current.openAttempt -> current.openRequestResume
            action.mode == RelayV2TerminalOpenMode.RESUME -> current.openResume(
                current.parserAppliedNextOffset,
            )
            action.mode == RelayV2TerminalOpenMode.RESET -> current.openResume(null)
            else -> null
        }
        if (action.resume != expectedResume) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        if (action.mode != RelayV2TerminalOpenMode.RESET &&
            (current.pendingOutput.isNotEmpty() ||
                current.parserInFlightCallbackToken != null ||
                current.parserResetCallbackToken != null)
        ) {
            return reset(current, RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST)
        }
        val pending = if (action.openAttempt == current.openAttempt) {
            val issuedRequestIds = appendRequestId(current.openRequestIds, action.requestId)
                ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED)
            action.pendingOpen().copy(
                issuedRequestIds = issuedRequestIds,
                requiresDeduplicatedResponse = true,
            )
        } else {
            action.pendingOpen()
        }
        return commit(
            current,
            current.copy(
                pendingOpen = pending,
                openRequestIds = appendRequestId(current.openRequestIds, action.requestId)
                    ?: return reset(
                        current,
                        RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED,
                    ),
            ),
            RelayV2TerminalOutcome.Applied,
            listOf(pending.sendOpen(current)),
        )
    }

    private fun beginPreOpen(
        current: RelayV2TerminalPreOpenCheckpoint?,
        action: RelayV2TerminalAction.BeginOpenAttempt,
    ): RelayV2TerminalReduction {
        if (!validOpenRequest(action) ||
            action.deliveryToken.actorGeneration.profileId != action.target.profileId ||
            action.deliveryToken.actorGeneration.profileGeneration !=
                action.target.profileActivationGeneration
        ) {
            return missingReset(null, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        }
        if (current == null) {
            if (action.mode == RelayV2TerminalOpenMode.RESUME) {
                return missingReset(null, RelayV2TerminalResetReason.MISSING_CHECKPOINT)
            }
            val pending = action.pendingOpen()
            val checkpoint = RelayV2TerminalPreOpenCheckpoint(
                target = action.target,
                deliveryToken = action.deliveryToken,
                parserContinuityId = action.parserContinuityId,
                openRequestIds = listOf(action.requestId),
                phase = RelayV2TerminalPreOpenPhase.PENDING_OPEN,
                pendingOpen = pending,
            )
            return preOpenReduction(
                checkpoint,
                RelayV2TerminalOutcome.Applied,
                listOf(pending.sendOpen(checkpoint)),
            )
        }
        if (current.phase == RelayV2TerminalPreOpenPhase.RESET_REQUIRED &&
            action.mode != RelayV2TerminalOpenMode.RESET
        ) {
            return preOpenReduction(
                current,
                RelayV2TerminalOutcome.ResetRequired(
                    current.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                ),
            )
        }
        if (!deliveryIsFreshOrSame(current.deliveryToken, action.deliveryToken)) {
            return preOpenReduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_DELIVERY),
            )
        }
        if (action.target != current.target) {
            return preOpenReset(current, RelayV2TerminalResetReason.IDENTITY_CHANGED)
        }
        if (action.requestId in current.openRequestIds) {
            return preOpenReduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.NETWORK_REQUEST_ID_REUSED,
                ),
            )
        }
        val existingPending = current.pendingOpen
        existingPending?.let { pending ->
            if (!pending.sameLogicalAttempt(action)) {
                return preOpenReset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
            }
            if (action.requestId in pending.issuedRequestIds) {
                return preOpenReduction(
                    current,
                    RelayV2TerminalOutcome.Ignored(
                        RelayV2TerminalIgnoredReason.NETWORK_REQUEST_ID_REUSED,
                    ),
                )
            }
        }
        val pending = if (existingPending != null) {
            val issuedRequestIds = appendRequestId(
                existingPending.issuedRequestIds,
                action.requestId,
            ) ?: return preOpenReset(
                current,
                RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED,
            )
            existingPending.copy(
                requestId = action.requestId,
                issuedRequestIds = issuedRequestIds,
                deliveryToken = action.deliveryToken,
                requiresDeduplicatedResponse = true,
            )
        } else {
            action.pendingOpen()
        }
        val candidate = current.copy(
            target = action.target,
            deliveryToken = action.deliveryToken,
            parserContinuityId = action.parserContinuityId,
            openRequestIds = appendRequestId(current.openRequestIds, action.requestId)
                ?: return preOpenReset(
                    current,
                    RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED,
                ),
            phase = RelayV2TerminalPreOpenPhase.PENDING_OPEN,
            pendingOpen = pending,
            resetFence = null,
            resetReason = null,
        )
        return preOpenReduction(
            candidate,
            RelayV2TerminalOutcome.Applied,
            listOf(pending.sendOpen(candidate)),
        )
    }

    private fun openedPreOpen(
        current: RelayV2TerminalPreOpenCheckpoint,
        action: RelayV2TerminalAction.Opened,
    ): RelayV2TerminalReduction {
        val pending = current.pendingOpen
        when (networkResponseCorrelation(
            action.requestId,
            pending?.requestId,
            current.openRequestIds,
        )) {
            NetworkResponseCorrelation.ISSUED_OLD -> return preOpenReduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_OPEN_RESPONSE),
            )
            NetworkResponseCorrelation.UNKNOWN -> return preOpenReset(
                current,
                RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            )
            NetworkResponseCorrelation.CURRENT -> Unit
        }
        pending ?: return preOpenReset(
            current,
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
        )
        if (action.openAttempt != pending.openAttempt ||
            action.deliveryToken != current.deliveryToken
        ) {
            return preOpenReset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        val replayFrom = parseCounter(action.replayFromOffset)
        val tail = parseCounter(action.tailOffset)
        if (!resetResultAdvancesAuthority(pending, action.identity)) {
            return preOpenReset(current, RelayV2TerminalResetReason.GENERATION_STALE)
        }
        if (action.identity.target() != current.target ||
            action.identity.target() != pending.target ||
            action.parserContinuityId != current.parserContinuityId ||
            action.parserContinuityId != pending.parserContinuityId ||
            action.cols != pending.cols || action.rows != pending.rows ||
            (pending.requiresDeduplicatedResponse && !action.deduplicated) ||
            !dispositionMatches(pending.mode, action.disposition) ||
            replayFrom != ZERO || tail == null || tail < ZERO ||
            (tail != ZERO &&
                (!pending.requiresDeduplicatedResponse || !action.deduplicated))
        ) {
            return preOpenReset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        return newGenerationCheckpoint(
            action,
            emptyList(),
            pending,
            current.openRequestIds,
            newlyAmbiguousCount = 0,
        )
    }

    private fun preOpenResetRequired(
        current: RelayV2TerminalPreOpenCheckpoint,
        action: RelayV2TerminalAction.PreOpenResetRequired,
    ): RelayV2TerminalReduction {
        val pending = current.pendingOpen
        when (networkResponseCorrelation(
            action.requestId,
            pending?.requestId,
            current.openRequestIds,
        )) {
            NetworkResponseCorrelation.ISSUED_OLD -> return preOpenReduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_RESET_RESPONSE),
            )
            NetworkResponseCorrelation.UNKNOWN -> return preOpenReset(
                current,
                RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            )
            NetworkResponseCorrelation.CURRENT -> Unit
        }
        pending ?: return preOpenReset(
            current,
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
        )
        if (action.fence != openFence(current, pending)) {
            return preOpenReset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        val reason = validatedHostResetReason(
            action.reason,
            action.requestedOffset,
            action.bufferStartOffset,
            action.tailOffset,
        ) ?: return preOpenReset(
            current,
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            action.fence,
        )
        return preOpenReset(current, reason, action.fence)
    }

    private fun preOpenReset(
        current: RelayV2TerminalPreOpenCheckpoint,
        reason: RelayV2TerminalResetReason,
        fence: RelayV2TerminalOpenFence? = current.pendingOpen?.let {
            openFence(current, it)
        },
    ): RelayV2TerminalReduction {
        val reset = current.copy(
            phase = RelayV2TerminalPreOpenPhase.RESET_REQUIRED,
            pendingOpen = null,
            resetReason = reason,
            resetFence = fence,
        )
        return preOpenReduction(
            reset,
            RelayV2TerminalOutcome.ResetRequired(reason),
            listOf(RelayV2TerminalEffect.ResetRequired(fence, reason, null)),
        )
    }

    private fun closedWhileResetRequired(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.Closed,
    ): RelayV2TerminalReduction {
        val correlatedCloseAttempt = when (val correlation =
            closedResponseCorrelation(current, action)
        ) {
            is ClosedResponseCorrelation.Current -> correlation.closeAttempt
            ClosedResponseCorrelation.Natural -> null
            is ClosedResponseCorrelation.Rejected -> return correlation.reduction
        }
        val finalOffset = parseCounter(action.finalOffset)
        val bufferStart = action.bufferStartOffset?.let(::parseCounter)
        if (action.fence.openId != current.openAttempt.openId ||
            !validClose(action) || finalOffset == null ||
            (action.replayAvailable && (bufferStart == null || bufferStart > finalOffset)) ||
            (!action.replayAvailable && action.bufferStartOffset != null)
        ) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        val incoming = RelayV2TerminalClosedState(
            tombstone = closedTombstone(current, action, correlatedCloseAttempt),
            retainedBuffer = RelayV2TerminalRetainedBuffer(
                action.replayAvailable,
                action.bufferStartOffset,
            ),
        )
        current.closed?.let { existing ->
            if (existing.tombstone.copy(closeAttempt = null) !=
                incoming.tombstone.copy(closeAttempt = null) ||
                !retainedBufferCanAdvance(existing.retainedBuffer, incoming.retainedBuffer)
            ) {
                return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
            }
        }
        val candidate = abandonControlsForClosed(
            current.copy(
                closed = RelayV2TerminalClosedState(
                    tombstone = incoming.tombstone.copy(
                        closeAttempt = incoming.tombstone.closeAttempt
                            ?: current.closed?.tombstone?.closeAttempt,
                    ),
                    retainedBuffer = incoming.retainedBuffer,
                ),
                pendingClose = if (correlatedCloseAttempt != null) {
                    null
                } else {
                    current.pendingClose
                },
            ),
        )
        return commit(
            current,
            candidate,
            RelayV2TerminalOutcome.ResetRequired(
                current.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
            ),
            ambiguousEffect(current, candidate) + listOf(
                RelayV2TerminalEffect.ResetRequired(
                    effectFence(current),
                    current.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                    current.parserAppliedNextOffset,
                ),
            ),
        )
    }

    private fun opened(
        previous: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.Opened,
    ): RelayV2TerminalReduction {
        if (previous.pendingParserDispatchClaim != null ||
            previous.pendingParserEffectHandoff != null ||
            previous.pendingParserEffectActivation != null
        ) {
            return reset(previous, RelayV2TerminalResetReason.STREAM_LOST)
        }
        val pendingOpen = previous.pendingOpen
        val issuedRequestIds = previous.openRequestIds +
            pendingOpen?.issuedRequestIds.orEmpty()
        when (networkResponseCorrelation(
            action.requestId,
            pendingOpen?.requestId,
            issuedRequestIds,
        )) {
            NetworkResponseCorrelation.ISSUED_OLD -> return reduction(
                previous,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.STALE_OPEN_RESPONSE,
                ),
            )
            NetworkResponseCorrelation.UNKNOWN -> return reset(
                previous,
                RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            )
            NetworkResponseCorrelation.CURRENT -> Unit
        }
        pendingOpen ?: return reset(
            previous,
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
        )
        val from = parseCounter(action.replayFromOffset)
        val tail = parseCounter(action.tailOffset)
        if (from == null || tail == null || tail < from ||
            !validOperationId(action.requestId) ||
            !validParserContinuity(action.parserContinuityId) ||
            action.cols !in 1..1000 || action.rows !in 1..500 ||
            action.deliveryToken.actorGeneration.profileId != action.identity.profileId ||
            action.deliveryToken.actorGeneration.profileGeneration !=
                action.identity.profileActivationGeneration
        ) {
            return reset(previous, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        }

        if (pendingOpen.deliveryToken != action.deliveryToken ||
            pendingOpen.openAttempt != action.openAttempt ||
            pendingOpen.cols != action.cols || pendingOpen.rows != action.rows ||
            pendingOpen.target != action.identity.target() ||
            pendingOpen.parserContinuityId != action.parserContinuityId ||
            !dispositionMatches(pendingOpen.mode, action.disposition)
        ) {
            return reset(previous, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        if (pendingOpen.requiresDeduplicatedResponse && !action.deduplicated) {
            return reset(previous, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }

        if (action.openAttempt == previous.openAttempt) {
            if (!action.deduplicated || pendingOpen.mode != previous.openMode ||
                !lineageMatches(previous.openResult, action)
            ) {
                return reset(previous, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
            }
            return commit(
                previous,
                previous.copy(
                    pendingOpen = null,
                    openRequestIds = pendingOpen.issuedRequestIds,
                ),
                RelayV2TerminalOutcome.Applied,
            )
        }

        if (pendingOpen.mode == RelayV2TerminalOpenMode.RESET) {
            if (action.disposition != RelayV2TerminalOpenDisposition.RESET ||
                !resetResultAdvancesAuthority(pendingOpen, action.identity) ||
                !sameResetTarget(previous.identity, action.identity) ||
                from != ZERO ||
                (tail != ZERO &&
                    (!pendingOpen.requiresDeduplicatedResponse || !action.deduplicated))
            ) {
                return reset(previous, RelayV2TerminalResetReason.GENERATION_STALE)
            }
            val newlyAmbiguous = previous.pendingInputs.map {
                RelayV2AmbiguousInput(it.generation, it.inputSeq, it.bytes)
            }
            val ambiguousInputs = previous.ambiguousInputs + newlyAmbiguous
            val openRequestIds = mergeRequestIds(
                previous.openRequestIds,
                pendingOpen.issuedRequestIds,
            ) ?: return reset(
                previous,
                RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED,
            )
            return newGenerationCheckpoint(
                action,
                ambiguousInputs,
                pendingOpen,
                openRequestIds,
                newlyAmbiguous.size,
            )
        }
        if (pendingOpen.mode != RelayV2TerminalOpenMode.RESUME) {
            return reset(previous, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }

        if (previous.identity.hostInstanceId != action.identity.hostInstanceId) {
            return reset(previous, RelayV2TerminalResetReason.STREAM_LOST)
        }
        if (previous.parserContinuityId != action.parserContinuityId) {
            return reset(previous, RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST)
        }
        if (previous.identity.generation != action.identity.generation) {
            return reset(previous, RelayV2TerminalResetReason.GENERATION_STALE)
        }
        if (previous.identity != action.identity) {
            return reset(previous, RelayV2TerminalResetReason.IDENTITY_CHANGED)
        }
        if (previous.phase == RelayV2TerminalPhase.RESET_REQUIRED) {
            return reduction(
                previous,
                RelayV2TerminalOutcome.ResetRequired(
                    previous.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                ),
                RelayV2TerminalEffect.ResetRequired(
                    effectFence(previous),
                    previous.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                    previous.parserAppliedNextOffset,
                ),
            )
        }
        if (action.disposition != RelayV2TerminalOpenDisposition.RESUMED ||
            from != parseCounter(pendingOpen.resume?.nextOffset ?: "")
        ) {
            return reset(previous, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        val pendingTail = parseCounter(previous.networkReceivedThrough) ?: return reset(
            previous,
            RelayV2TerminalResetReason.CHECKPOINT_INVALID,
        )
        if (tail < pendingTail) {
            return reset(previous, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        val knownFinal = previous.closed?.tombstone?.finalOffset?.let(::parseCounter)
        if (knownFinal != null && tail != knownFinal) {
            return reset(previous, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        if (knownFinal != null && !retainedBufferCovers(
                requireNotNull(previous.closed).retainedBuffer,
                from,
            )
        ) {
            return reset(previous, RelayV2TerminalResetReason.OFFSET_EXPIRED)
        }
        val openRequestIds = mergeRequestIds(
            previous.openRequestIds,
            pendingOpen.issuedRequestIds,
        ) ?: return reset(
            previous,
            RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED,
        )
        var candidate = previous.copy(
            openAttempt = action.openAttempt,
            openMode = pendingOpen.mode,
            openRequestResume = pendingOpen.resume,
            openResult = action.openResult(),
            openRequestIds = openRequestIds,
            openedCols = action.cols,
            openedRows = action.rows,
            phase = when {
                knownFinal != null && pendingTail < knownFinal -> RelayV2TerminalPhase.REPLAYING
                knownFinal != null -> RelayV2TerminalPhase.CLOSED_WAITING_PARSER
                tail == from && previous.pendingOutput.isEmpty() -> RelayV2TerminalPhase.LIVE
                else -> RelayV2TerminalPhase.REPLAYING
            },
            replayTargetOffset = when {
                knownFinal != null && pendingTail < knownFinal -> knownFinal.toString()
                knownFinal != null -> null
                tail != from -> action.tailOffset
                else -> null
            },
            pendingOpen = null,
            pendingReplay = null,
            lastAppliedParserCallbackToken = null,
            pendingInputs = previous.pendingInputs.map { it.copy(dispatchClaim = null) },
            pendingResizes = previous.pendingResizes.map { it.copy(dispatchClaim = null) },
            closed = previous.closed?.copy(
                tombstone = previous.closed.tombstone.copy(
                    openId = action.openAttempt.openId,
                ),
            ),
            resetReason = null,
        )
        candidate = candidate.copy(
            activeControlDispatchLease = candidate.controlDispatchLeaseWhenWritable(),
        )
        val recovered = recoverClosed(candidate)
        candidate = recovered.checkpoint
        return commit(
            previous,
            candidate,
            if (candidate.phase == RelayV2TerminalPhase.FINALIZED) {
                RelayV2TerminalOutcome.ClosedFinalized
            } else {
                RelayV2TerminalOutcome.Applied
            },
            recovered.effects + pendingControlEffects(candidate),
        )
    }

    private fun newGenerationCheckpoint(
        action: RelayV2TerminalAction.Opened,
        ambiguousInputs: List<RelayV2AmbiguousInput>,
        pendingOpen: RelayV2TerminalPendingOpen,
        openRequestIds: List<String>,
        newlyAmbiguousCount: Int,
    ): RelayV2TerminalReduction {
        val resetting = action.disposition == RelayV2TerminalOpenDisposition.RESET
        val tail = requireNotNull(parseCounter(action.tailOffset))
        val replaying = tail > ZERO
        val fence = RelayV2TerminalEffectFence(
            action.identity,
            action.deliveryToken,
            action.openAttempt,
        )
        val resetCallbackToken = if (resetting) {
            RelayV2TerminalParserCallbackToken(
                fence,
                action.parserContinuityId,
                "reset-1",
                "0",
                "0",
            )
        } else {
            null
        }
        val checkpoint = RelayV2TerminalCheckpoint(
            identity = action.identity,
            openAttempt = action.openAttempt,
            openMode = pendingOpen.mode,
            openRequestResume = pendingOpen.resume,
            openResult = action.openResult(),
            openRequestIds = openRequestIds,
            deliveryToken = action.deliveryToken,
            parserContinuityId = action.parserContinuityId,
            phase = when {
                replaying -> RelayV2TerminalPhase.REPLAYING
                resetting -> RelayV2TerminalPhase.RESETTING_PARSER
                else -> RelayV2TerminalPhase.LIVE
            },
            openedCols = action.cols,
            openedRows = action.rows,
            parserAppliedNextOffset = "0",
            networkReceivedThrough = "0",
            nextParserOperationSeq = if (resetting) "2" else "1",
            nextReplayRequestSeq = "1",
            parserResetCallbackToken = resetCallbackToken,
            replayTargetOffset = action.tailOffset.takeIf { replaying },
            ambiguousInputs = ambiguousInputs.toList(),
        )
        val authorizedCheckpoint = checkpoint.copy(
            activeControlDispatchLease = checkpoint.controlDispatchLeaseWhenWritable(),
        )
        val effects = buildList {
            if (newlyAmbiguousCount > 0) {
                add(
                    RelayV2TerminalEffect.ControlsBecameAmbiguous(
                        fence,
                        newlyAmbiguousCount,
                    ),
                )
            }
            resetCallbackToken?.let {
                add(RelayV2TerminalEffect.ResetParser(it))
            }
        }
        return commit(
            null,
            authorizedCheckpoint,
            RelayV2TerminalOutcome.Applied,
            effects,
            action.identity,
            action.deliveryToken,
            action.openAttempt,
        )
    }

    private fun verifyContinuity(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.VerifyContinuity,
    ): RelayV2TerminalReduction = when {
        action.identity == null -> reset(current, RelayV2TerminalResetReason.MISSING_REQUIRED_IDENTITY)
        action.identity != current.identity -> reset(
            current,
            identityChangeReason(current.identity, action.identity),
        )
        action.deliveryToken == null -> reset(
            current,
            RelayV2TerminalResetReason.MISSING_REQUIRED_IDENTITY,
        )
        action.deliveryToken != current.deliveryToken -> reduction(
            current,
            RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_DELIVERY),
        )
        action.parserContinuityId.isNullOrBlank() ||
            action.parserContinuityId != current.parserContinuityId -> reset(
            current,
            RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST,
        )
        current.phase == RelayV2TerminalPhase.RESET_REQUIRED -> reduction(
            current,
            RelayV2TerminalOutcome.ResetRequired(
                current.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
            ),
            RelayV2TerminalEffect.ResetRequired(
                effectFence(current),
                current.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                current.parserAppliedNextOffset,
            ),
        )
        else -> reduction(current, RelayV2TerminalOutcome.Applied)
    }

    private fun rebindDelivery(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.RebindDelivery,
    ): RelayV2TerminalReduction {
        if (action.identity != current.identity ||
            action.parserContinuityId != current.parserContinuityId
        ) {
            return reset(current, RelayV2TerminalResetReason.IDENTITY_CHANGED)
        }
        deliveryGuard(current, action.currentDeliveryToken)?.let { return it }
        if (action.newDeliveryToken.actorGeneration.profileId != current.identity.profileId ||
            action.newDeliveryToken.actorGeneration.profileGeneration !=
            current.identity.profileActivationGeneration ||
            !deliveryIsStrictlyFresher(current.deliveryToken, action.newDeliveryToken)
        ) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_DELIVERY),
            )
        }
        if (current.pendingParserDispatchClaim != null ||
            current.pendingParserEffectHandoff != null ||
            current.pendingParserEffectActivation != null
        ) {
            return reset(current, RelayV2TerminalResetReason.STREAM_LOST)
        }
        if (current.phase != RelayV2TerminalPhase.RESET_REQUIRED &&
            (current.pendingOutput.isNotEmpty() ||
            current.parserInFlightCallbackToken != null ||
            current.parserResetCallbackToken != null)
        ) {
            return reset(current, RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST)
        }
        var candidate = rebindStoredFences(
            current,
            current.identity,
            action.newDeliveryToken,
        )
        candidate = candidate.copy(
            pendingReplay = candidate.pendingReplay?.copy(fence = effectFence(candidate)),
        )
        val effects = buildList<RelayV2TerminalEffect> {
            if (candidate.phase == RelayV2TerminalPhase.RESET_REQUIRED) {
                add(
                    RelayV2TerminalEffect.ResetRequired(
                        effectFence(candidate),
                        candidate.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                        candidate.parserAppliedNextOffset,
                    ),
                )
            }
            if (candidate.closed == null) {
                addAll(pendingControlEffects(candidate))
            }
        }
        return commit(
            current,
            candidate,
            if (candidate.phase == RelayV2TerminalPhase.RESET_REQUIRED) {
                RelayV2TerminalOutcome.ResetRequired(
                    candidate.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                )
            } else {
                RelayV2TerminalOutcome.Applied
            },
            effects,
        )
    }

    private fun output(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.Output,
    ): RelayV2TerminalReduction {
        fenceGuard(current, action.fence)?.let { return it }
        if (current.phase == RelayV2TerminalPhase.FINALIZED) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.FINALIZED_LATE_EVENT),
            )
        }
        if (action.bytes.size > RelayV2TerminalCheckpointLimits.MAX_FRAME_BYTES) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        if (action.bytes.size == 0) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        val offset = parseCounter(action.offset)
            ?: return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        val end = addCounter(offset, action.bytes.size)
            ?: return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        val applied = parseCounter(current.parserAppliedNextOffset)
            ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        val expected = parseCounter(current.networkReceivedThrough)
            ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)

        if (end <= expected) {
            val effects = if (end <= applied && current.parserResetCallbackToken == null) {
                listOf(
                    RelayV2TerminalEffect.OutputAck(
                        effectFence(current),
                        current.identity.generation,
                        current.parserAppliedNextOffset,
                    ),
                )
            } else {
                emptyList()
            }
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.DUPLICATE_OUTPUT),
                effects,
            )
        }
        if (current.phase == RelayV2TerminalPhase.REPLAY_REQUESTED) {
            return reduction(
                current,
                RelayV2TerminalOutcome.ReplayRequired(expected.toString()),
            )
        }
        if (offset > expected) return requestReplay(current, expected.toString())

        val prefix = (expected - offset).toInt()
        val accepted = if (prefix == 0) action.bytes else action.bytes.drop(prefix)
        val acceptedOffset = expected.toString()
        val closedFinal = current.closed?.tombstone?.finalOffset?.let(::parseCounter)
        if (closedFinal != null && addCounter(expected, accepted.size)?.let { it > closedFinal } == true) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        if (current.pendingOutput.size + 1 > RelayV2TerminalCheckpointLimits.MAX_PENDING_OUTPUT_FRAMES ||
            pendingOutputBytes(current) + accepted.size >
            RelayV2TerminalCheckpointLimits.MAX_PENDING_OUTPUT_BYTES
        ) {
            return reset(current, RelayV2TerminalResetReason.SLOW_CONSUMER)
        }

        val operation = allocateParserOperation(current)
            ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        val acceptedEnd = addCounter(expected, accepted.size)
            ?: return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        val callbackToken = RelayV2TerminalParserCallbackToken(
            effectFence(current),
            current.parserContinuityId,
            operation.id,
            acceptedOffset,
            acceptedEnd.toString(),
        )
        val pending = RelayV2PendingParserWrite(callbackToken, accepted)
        var candidate = current.copy(
            nextParserOperationSeq = operation.next,
            networkReceivedThrough = acceptedEnd.toString(),
            pendingOutput = current.pendingOutput + pending,
        )
        val effects = mutableListOf<RelayV2TerminalEffect>()
        if (candidate.parserInFlightCallbackToken == null && canDispatchParser(candidate)) {
            candidate = candidate.copy(parserInFlightCallbackToken = pending.callbackToken)
            effects += pending.writeEffect()
        }
        return commit(current, candidate, RelayV2TerminalOutcome.Applied, effects)
    }

    private fun replayStarted(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ReplayStarted,
    ): RelayV2TerminalReduction {
        val pendingReplay = current.pendingReplay
        when (networkResponseCorrelation(
            action.requestId,
            pendingReplay?.requestId,
            current.replayRequestIds,
        )) {
            NetworkResponseCorrelation.ISSUED_OLD -> return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.STALE_REPLAY_RESPONSE,
                ),
            )
            NetworkResponseCorrelation.UNKNOWN -> return reset(
                current,
                RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            )
            NetworkResponseCorrelation.CURRENT -> Unit
        }
        pendingReplay ?: return reset(
            current,
            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
        )
        if (action.identity != current.identity) {
            return reset(current, identityChangeReason(current.identity, action.identity))
        }
        if (action.openId != current.openAttempt.openId ||
            action.deliveryToken != current.deliveryToken ||
            current.phase != RelayV2TerminalPhase.REPLAY_REQUESTED
        ) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        val from = parseCounter(action.fromOffset)
        val tail = parseCounter(action.tailOffsetAtStart)
        val expected = parseCounter(current.networkReceivedThrough)
        if (action.fromOffset != pendingReplay.fromOffset ||
            pendingReplay.fence != effectFence(current) || from == null || tail == null ||
            expected == null || from != expected || tail < from
        ) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        val finalOffset = current.closed?.tombstone?.finalOffset?.let(::parseCounter)
        if (finalOffset != null && tail != finalOffset) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        if (finalOffset != null && !retainedBufferCovers(
                requireNotNull(current.closed).retainedBuffer,
                from,
            )
        ) {
            return reset(current, RelayV2TerminalResetReason.OFFSET_EXPIRED)
        }
        var candidate = current.copy(
            phase = when {
                tail == from && current.closed == null &&
                    current.parserResetCallbackToken != null ->
                    RelayV2TerminalPhase.RESETTING_PARSER
                tail == from && current.closed == null -> RelayV2TerminalPhase.LIVE
                else -> RelayV2TerminalPhase.REPLAYING
            },
            replayTargetOffset = if (tail == from && current.closed == null) {
                null
            } else {
                (finalOffset ?: tail).toString()
            },
            pendingReplay = null,
        )
        val effects = mutableListOf<RelayV2TerminalEffect>()
        if (candidate.parserInFlightCallbackToken == null &&
            candidate.pendingOutput.isNotEmpty() &&
            canDispatchParser(candidate)
        ) {
            val head = candidate.pendingOutput.first()
            candidate = candidate.copy(parserInFlightCallbackToken = head.callbackToken)
            effects += head.writeEffect()
        }
        return commit(current, candidate, RelayV2TerminalOutcome.Applied, effects)
    }

    private fun claimParserDispatch(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ClaimParserDispatch,
    ): RelayV2TerminalReduction {
        current.pendingParserDispatchClaim?.let { existing ->
            return if (existing.matches(action.effect)) {
                reduction(
                    current,
                    RelayV2TerminalOutcome.Ignored(
                        RelayV2TerminalIgnoredReason.DUPLICATE_PARSER_DISPATCH,
                    ),
                )
            } else {
                reduction(
                    current,
                    RelayV2TerminalOutcome.ParserDispatchDenied(
                        RelayV2TerminalParserDispatchAuthorization.REVOKED,
                    ),
                )
            }
        }
        val authorization = authorizeParserDispatch(current, action.effect)
        if (authorization != RelayV2TerminalParserDispatchAuthorization.AUTHORIZED) {
            return reduction(
                current,
                RelayV2TerminalOutcome.ParserDispatchDenied(authorization),
            )
        }
        val claim = when (val effect = action.effect) {
            is RelayV2TerminalEffect.WriteParser -> RelayV2TerminalParserDispatchClaim.Write(
                effect.fence,
                effect.callbackToken,
                current.phase,
                effect.bytes,
            )
            is RelayV2TerminalEffect.ResetParser -> RelayV2TerminalParserDispatchClaim.Reset(
                effect.fence,
                effect.callbackToken,
                current.phase,
            )
            else -> return reduction(
                current,
                RelayV2TerminalOutcome.ParserDispatchDenied(
                    RelayV2TerminalParserDispatchAuthorization.PAYLOAD_MISMATCH,
                ),
            )
        }
        return commit(
            current,
            current.copy(pendingParserDispatchClaim = claim),
            RelayV2TerminalOutcome.ParserDispatchClaimed(claim),
        )
    }

    private fun releaseParserDispatch(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ReleaseParserDispatch,
    ): RelayV2TerminalReduction = if (current.pendingParserDispatchClaim == action.claim) {
        commit(
            current,
            current.copy(pendingParserDispatchClaim = null),
            RelayV2TerminalOutcome.Applied,
        )
    } else {
        reduction(
            current,
            RelayV2TerminalOutcome.Ignored(
                RelayV2TerminalIgnoredReason.DUPLICATE_PARSER_DISPATCH,
            ),
        )
    }

    private fun parserApplied(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ParserApplied,
    ): RelayV2TerminalReduction = parserApplied(
        current,
        action.claim.callbackToken,
        clearDispatchClaim = true,
    )

    private fun parserApplied(
        current: RelayV2TerminalCheckpoint,
        callbackToken: RelayV2TerminalParserCallbackToken,
        clearDispatchClaim: Boolean,
    ): RelayV2TerminalReduction {
        parserCallbackGuard(current, callbackToken)?.let { return it }
        if (current.phase == RelayV2TerminalPhase.FINALIZED) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.FINALIZED_LATE_EVENT),
            )
        }
        if (current.parserResetCallbackToken != null) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.OUT_OF_ORDER_PARSER_CALLBACK,
                ),
            )
        }
        if (callbackToken == current.lastAppliedParserCallbackToken) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.DUPLICATE_PARSER_CALLBACK,
                ),
            )
        }
        val head = current.pendingOutput.firstOrNull()
        if (head == null || callbackToken != current.parserInFlightCallbackToken ||
            callbackToken != head.callbackToken
        ) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.OUT_OF_ORDER_PARSER_CALLBACK,
                ),
            )
        }
        if (head.callbackToken.startOffset != current.parserAppliedNextOffset) {
            return parserCallbackReset(
                current,
                RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                callbackToken,
                markApplied = true,
                handoffEffects = clearDispatchClaim,
            )
        }
        val next = parseCounter(head.callbackToken.endOffset)
            ?: return parserCallbackReset(
                current,
                RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                callbackToken,
                markApplied = true,
                handoffEffects = clearDispatchClaim,
            )
        if (addCounter(
                parseCounter(head.callbackToken.startOffset)
                    ?: return parserCallbackReset(
                        current,
                        RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                        callbackToken,
                        markApplied = true,
                        handoffEffects = clearDispatchClaim,
                    ),
                head.bytes.size,
            ) != next
        ) {
            return parserCallbackReset(
                current,
                RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                callbackToken,
                markApplied = true,
                handoffEffects = clearDispatchClaim,
            )
        }

        var candidate = current.copy(
            parserAppliedNextOffset = next.toString(),
            parserInFlightCallbackToken = null,
            lastAppliedParserCallbackToken = callbackToken,
            pendingParserDispatchClaim = if (clearDispatchClaim) {
                null
            } else {
                current.pendingParserDispatchClaim
            },
            pendingOutput = current.pendingOutput.drop(1),
        )
        val effects = mutableListOf<RelayV2TerminalEffect>(
            RelayV2TerminalEffect.OutputAck(
                effectFence(current),
                current.identity.generation,
                next.toString(),
            ),
        )

        if (candidate.phase == RelayV2TerminalPhase.REPLAYING) {
            val target = candidate.replayTargetOffset?.let(::parseCounter)
                ?: return parserCallbackReset(
                    current,
                    RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                    callbackToken,
                    markApplied = true,
                    handoffEffects = clearDispatchClaim,
                )
            when {
                next > target -> return parserCallbackReset(
                    current,
                    RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
                    callbackToken,
                    markApplied = true,
                    handoffEffects = clearDispatchClaim,
                )
                next == target -> candidate = candidate.copy(
                    phase = if (candidate.closed == null) {
                        RelayV2TerminalPhase.LIVE
                    } else {
                        RelayV2TerminalPhase.CLOSED_WAITING_PARSER
                    },
                    replayTargetOffset = null,
                )
            }
        }

        val recovered = recoverClosed(candidate)
        candidate = recovered.checkpoint
        effects += recovered.effects
        if (candidate.phase !in setOf(
                RelayV2TerminalPhase.FINALIZED,
                RelayV2TerminalPhase.RESET_REQUIRED,
            ) && candidate.parserInFlightCallbackToken == null &&
            candidate.pendingOutput.isNotEmpty() && canDispatchParser(candidate)
        ) {
            val nextWrite = candidate.pendingOutput.first()
            candidate = candidate.copy(parserInFlightCallbackToken = nextWrite.callbackToken)
            effects += nextWrite.writeEffect()
        }
        val outcome = if (candidate.phase == RelayV2TerminalPhase.FINALIZED) {
            RelayV2TerminalOutcome.ClosedFinalized
        } else if (candidate.phase == RelayV2TerminalPhase.RESET_REQUIRED) {
            RelayV2TerminalOutcome.ResetRequired(
                candidate.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
            )
        } else {
            RelayV2TerminalOutcome.ParserAdvanced(next.toString())
        }
        if (effects.isNotEmpty() && clearDispatchClaim) {
            candidate = candidate.copy(
                pendingParserEffectHandoff = callbackToken,
                pendingParserEffectHandoffResetReason = if (
                    candidate.phase == RelayV2TerminalPhase.RESET_REQUIRED
                ) {
                    candidate.resetReason
                } else {
                    null
                },
            )
        }
        return commit(current, candidate, outcome, effects)
    }

    private fun parserFailed(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ParserFailed,
    ): RelayV2TerminalReduction {
        val callbackToken = action.claim.callbackToken
        parserCallbackGuard(current, callbackToken)?.let { return it }
        if (current.phase == RelayV2TerminalPhase.FINALIZED) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.FINALIZED_LATE_EVENT),
            )
        }
        if (callbackToken != current.parserInFlightCallbackToken &&
            callbackToken != current.parserResetCallbackToken
        ) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.OUT_OF_ORDER_PARSER_CALLBACK,
                ),
            )
        }
        return parserCallbackReset(
            current,
            RelayV2TerminalResetReason.PARSER_FAILURE,
            callbackToken,
            markApplied = false,
            handoffEffects = action.handoffEffects,
        )
    }

    private fun parserCallbackReset(
        current: RelayV2TerminalCheckpoint,
        reason: RelayV2TerminalResetReason,
        callbackToken: RelayV2TerminalParserCallbackToken,
        markApplied: Boolean,
        handoffEffects: Boolean,
    ): RelayV2TerminalReduction {
        val settled = if (markApplied) {
            current.copy(lastAppliedParserCallbackToken = callbackToken)
        } else {
            current
        }
        val reset = markResetRequired(settled, reason)
        val candidate = if (handoffEffects) {
            reset.copy(
                pendingParserEffectHandoff = callbackToken,
                pendingParserEffectHandoffResetReason = reason,
            )
        } else {
            reset
        }
        return commit(
            current,
            candidate,
            RelayV2TerminalOutcome.ResetRequired(reason),
            listOf(
                RelayV2TerminalEffect.ResetRequired(
                    effectFence(current),
                    reason,
                    current.parserAppliedNextOffset,
                ),
            ) + ambiguousEffect(current, reset),
        )
    }

    private fun parserResetApplied(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ParserResetApplied,
    ): RelayV2TerminalReduction = parserResetApplied(
        current,
        action.claim.callbackToken,
        clearDispatchClaim = true,
    )

    private fun parserResetApplied(
        current: RelayV2TerminalCheckpoint,
        callbackToken: RelayV2TerminalParserCallbackToken,
        clearDispatchClaim: Boolean,
    ): RelayV2TerminalReduction {
        parserCallbackGuard(current, callbackToken)?.let { return it }
        if (current.phase == RelayV2TerminalPhase.FINALIZED) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.FINALIZED_LATE_EVENT),
            )
        }
        if (callbackToken != current.parserResetCallbackToken) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.OUT_OF_ORDER_PARSER_CALLBACK,
                ),
            )
        }
        var candidate = current.copy(
            phase = if (current.phase == RelayV2TerminalPhase.RESETTING_PARSER) {
                if (current.closed == null) {
                    RelayV2TerminalPhase.LIVE
                } else {
                    RelayV2TerminalPhase.CLOSED_WAITING_PARSER
                }
            } else {
                current.phase
            },
            parserResetCallbackToken = null,
            lastAppliedParserCallbackToken = callbackToken,
            pendingParserDispatchClaim = if (clearDispatchClaim) {
                null
            } else {
                current.pendingParserDispatchClaim
            },
        )
        candidate = candidate.copy(
            activeControlDispatchLease = candidate.controlDispatchLeaseWhenWritable(),
        )
        val effects = mutableListOf<RelayV2TerminalEffect>()
        val recovered = recoverClosed(candidate)
        candidate = recovered.checkpoint
        effects += recovered.effects
        if (candidate.phase !in setOf(
                RelayV2TerminalPhase.FINALIZED,
                RelayV2TerminalPhase.RESET_REQUIRED,
            ) && candidate.parserInFlightCallbackToken == null &&
            candidate.pendingOutput.isNotEmpty() && canDispatchParser(candidate)
        ) {
            val head = candidate.pendingOutput.first()
            candidate = candidate.copy(parserInFlightCallbackToken = head.callbackToken)
            effects += head.writeEffect()
        }
        if (effects.isNotEmpty() && clearDispatchClaim) {
            candidate = candidate.copy(
                pendingParserEffectHandoff = callbackToken,
                pendingParserEffectHandoffResetReason = if (
                    candidate.phase == RelayV2TerminalPhase.RESET_REQUIRED
                ) {
                    candidate.resetReason
                } else {
                    null
                },
            )
        }
        return commit(
            current,
            candidate,
            if (candidate.phase == RelayV2TerminalPhase.FINALIZED) {
                RelayV2TerminalOutcome.ClosedFinalized
            } else {
                RelayV2TerminalOutcome.Applied
            },
            effects,
        )
    }

    private fun parserEffectsReserved(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ParserEffectsReserved,
    ): RelayV2TerminalReduction {
        val activation = action.activation
        if (current.pendingParserEffectHandoff != activation.callbackToken ||
            current.pendingParserEffectActivation != null ||
            (current.phase == RelayV2TerminalPhase.RESET_REQUIRED &&
                (current.pendingParserEffectHandoffResetReason == null ||
                    current.pendingParserEffectHandoffResetReason != current.resetReason)) ||
            (current.phase != RelayV2TerminalPhase.RESET_REQUIRED &&
                current.pendingParserEffectHandoffResetReason != null)
        ) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.OUT_OF_ORDER_PARSER_CALLBACK,
                ),
            )
        }
        return commit(
            current,
            current.copy(
                pendingParserEffectHandoff = null,
                pendingParserEffectHandoffResetReason = null,
                pendingParserEffectActivation = activation,
            ),
            RelayV2TerminalOutcome.Applied,
        )
    }

    private fun parserEffectsActivated(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ParserEffectsActivated,
    ): RelayV2TerminalReduction {
        if (current.pendingParserEffectActivation != action.activation) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.OUT_OF_ORDER_PARSER_CALLBACK,
                ),
            )
        }
        return commit(
            current,
            current.copy(pendingParserEffectActivation = null),
            RelayV2TerminalOutcome.Applied,
        )
    }

    private fun parserEffectReservationFailed(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ParserEffectReservationFailed,
    ): RelayV2TerminalReduction = if (
        current.pendingParserEffectHandoff == action.callbackToken
    ) {
        reset(current, RelayV2TerminalResetReason.STREAM_LOST)
    } else {
        reduction(
            current,
            RelayV2TerminalOutcome.Ignored(
                RelayV2TerminalIgnoredReason.OUT_OF_ORDER_PARSER_CALLBACK,
            ),
        )
    }

    private fun parserEffectActivationFailed(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ParserEffectActivationFailed,
    ): RelayV2TerminalReduction = if (
        current.pendingParserEffectActivation == action.activation
    ) {
        reset(current, RelayV2TerminalResetReason.STREAM_LOST)
    } else {
        reduction(
            current,
            RelayV2TerminalOutcome.Ignored(
                RelayV2TerminalIgnoredReason.OUT_OF_ORDER_PARSER_CALLBACK,
            ),
        )
    }

    private fun enqueueInput(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.EnqueueInput,
    ): RelayV2TerminalReduction {
        deliveryGuard(current, action.deliveryToken)?.let { return it }
        if (!terminalWritable(current)) {
            return controlRejected(
                current,
                RelayV2TerminalControlKind.INPUT,
                RelayV2TerminalControlRejectionReason.TERMINAL_NOT_WRITABLE,
                null,
                current.ackedThroughInputSeq,
            )
        }
        if (action.bytes.size !in 1..RelayV2TerminalCheckpointLimits.MAX_FRAME_BYTES) {
            return controlRejected(
                current,
                RelayV2TerminalControlKind.INPUT,
                RelayV2TerminalControlRejectionReason.INVALID_FRAME,
                null,
                current.ackedThroughInputSeq,
            )
        }
        if (current.pendingInputs.size + current.ambiguousInputs.size + 1 >
            RelayV2TerminalCheckpointLimits.MAX_INPUT_RECORDS ||
            pendingInputBytes(current) + action.bytes.size >
            RelayV2TerminalCheckpointLimits.MAX_PENDING_INPUT_BYTES
        ) {
            return reset(current, RelayV2TerminalResetReason.SLOW_CONSUMER)
        }
        val seq = parsePositiveCounter(current.nextInputSeq)
            ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        val next = incrementCounter(seq)
            ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        val pending = RelayV2PendingInput(
            current.identity.generation,
            seq.toString(),
            action.bytes,
            RelayV2TerminalControlDisposition.QUEUED,
        )
        val candidate = current.copy(
            nextInputSeq = next.toString(),
            pendingInputs = current.pendingInputs + pending,
        )
        return commit(
            current,
            candidate,
            RelayV2TerminalOutcome.ControlQueued(
                RelayV2TerminalControlKind.INPUT,
                seq.toString(),
            ),
            listOf(
                RelayV2TerminalEffect.SendInput(
                    requireNotNull(current.activeControlDispatchLease),
                    current.identity.generation,
                    seq.toString(),
                    action.bytes,
                ),
            ),
        )
    }

    private fun claimControlDispatch(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ClaimControlDispatch,
    ): RelayV2TerminalReduction {
        val effect = action.effect
        val existingClaim = when (effect) {
            is RelayV2TerminalEffect.SendInput -> current.pendingInputs.firstOrNull {
                it.generation == effect.generation && it.inputSeq == effect.inputSeq
            }?.dispatchClaim
            is RelayV2TerminalEffect.SendResize -> current.pendingResizes.firstOrNull {
                it.generation == effect.generation && it.resizeSeq == effect.resizeSeq
            }?.dispatchClaim
            else -> null
        }
        if (existingClaim != null && existingClaim.matches(effect)) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.DUPLICATE_CONTROL_DISPATCH,
                ),
            )
        }
        val authorization = authorizeControlDispatch(current, effect)
        if (authorization != RelayV2TerminalControlDispatchAuthorization.AUTHORIZED) {
            return reduction(
                current,
                RelayV2TerminalOutcome.ControlDispatchDenied(authorization),
            )
        }
        val attempt = parsePositiveCounter(current.nextControlDispatchAttemptSeq)
            ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        val nextAttempt = incrementCounter(attempt)
            ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        val attemptId = "dispatch-$attempt"
        return when (effect) {
            is RelayV2TerminalEffect.SendInput -> {
                val claim = RelayV2TerminalControlDispatchClaim.Input(
                    effect.dispatchLease,
                    attemptId,
                    effect.generation,
                    effect.inputSeq,
                    effect.bytes,
                )
                val updated = current.pendingInputs.map {
                    if (it.generation == effect.generation && it.inputSeq == effect.inputSeq) {
                        it.copy(dispatchClaim = claim)
                    } else {
                        it
                    }
                }
                commit(
                    current,
                    current.copy(
                        nextControlDispatchAttemptSeq = nextAttempt.toString(),
                        pendingInputs = updated,
                    ),
                    RelayV2TerminalOutcome.ControlDispatchClaimed(claim),
                )
            }
            is RelayV2TerminalEffect.SendResize -> {
                val claim = RelayV2TerminalControlDispatchClaim.Resize(
                    effect.dispatchLease,
                    attemptId,
                    effect.generation,
                    effect.resizeSeq,
                    effect.cols,
                    effect.rows,
                )
                val updated = current.pendingResizes.map {
                    if (it.generation == effect.generation && it.resizeSeq == effect.resizeSeq) {
                        it.copy(dispatchClaim = claim)
                    } else {
                        it
                    }
                }
                commit(
                    current,
                    current.copy(
                        nextControlDispatchAttemptSeq = nextAttempt.toString(),
                        pendingResizes = updated,
                    ),
                    RelayV2TerminalOutcome.ControlDispatchClaimed(claim),
                )
            }
            else -> reduction(
                current,
                RelayV2TerminalOutcome.ControlDispatchDenied(
                    RelayV2TerminalControlDispatchAuthorization.PAYLOAD_MISMATCH,
                ),
            )
        }
    }

    private fun releaseControlDispatch(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ReleaseControlDispatch,
    ): RelayV2TerminalReduction = when (val claim = action.claim) {
        is RelayV2TerminalControlDispatchClaim.Input -> {
            val index = current.pendingInputs.indexOfFirst { it.dispatchClaim == claim }
            if (index < 0 || claim.phase != RelayV2TerminalControlDispatchClaimPhase.CLAIMED) {
                reduction(
                    current,
                    RelayV2TerminalOutcome.Ignored(
                        RelayV2TerminalIgnoredReason.DUPLICATE_CONTROL_DISPATCH,
                    ),
                )
            } else {
                val updated = current.pendingInputs.toMutableList().also {
                    it[index] = it[index].copy(dispatchClaim = null)
                }.toList()
                commit(current, current.copy(pendingInputs = updated), RelayV2TerminalOutcome.Applied)
            }
        }
        is RelayV2TerminalControlDispatchClaim.Resize -> {
            val index = current.pendingResizes.indexOfFirst { it.dispatchClaim == claim }
            if (index < 0 || claim.phase != RelayV2TerminalControlDispatchClaimPhase.CLAIMED) {
                reduction(
                    current,
                    RelayV2TerminalOutcome.Ignored(
                        RelayV2TerminalIgnoredReason.DUPLICATE_CONTROL_DISPATCH,
                    ),
                )
            } else {
                val updated = current.pendingResizes.toMutableList().also {
                    it[index] = it[index].copy(dispatchClaim = null)
                }.toList()
                commit(current, current.copy(pendingResizes = updated), RelayV2TerminalOutcome.Applied)
            }
        }
    }

    private fun controlDispatchUncertain(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ControlDispatchUncertain,
    ): RelayV2TerminalReduction = if (current.contains(action.claim)) {
        reset(current, RelayV2TerminalResetReason.STREAM_LOST)
    } else {
        reduction(
            current,
            RelayV2TerminalOutcome.Ignored(
                RelayV2TerminalIgnoredReason.DUPLICATE_CONTROL_DISPATCH,
            ),
        )
    }

    private fun inputSent(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.InputSent,
    ): RelayV2TerminalReduction {
        val claim = action.claim
        val seq = parsePositiveCounter(claim.inputSeq)
            ?: return controlRejected(
                current,
                RelayV2TerminalControlKind.INPUT,
                RelayV2TerminalControlRejectionReason.GAP,
                claim.inputSeq,
                current.ackedThroughInputSeq,
            )
        val index = current.pendingInputs.indexOfFirst { parseCounter(it.inputSeq) == seq }
        if (index < 0 || current.pendingInputs.take(index).any {
                it.disposition != RelayV2TerminalControlDisposition.SENT
            }
        ) {
            return controlRejected(
                current,
                RelayV2TerminalControlKind.INPUT,
                RelayV2TerminalControlRejectionReason.GAP,
                claim.inputSeq,
                current.ackedThroughInputSeq,
            )
        }
        val existing = current.pendingInputs[index]
        if (existing.dispatchClaim != claim) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.DUPLICATE_CONTROL_DISPATCH,
                ),
            )
        }
        val updated = current.pendingInputs.toMutableList().also {
            it[index] = existing.copy(
                disposition = RelayV2TerminalControlDisposition.SENT,
                dispatchClaim = claim.copy(
                    phase = RelayV2TerminalControlDispatchClaimPhase.LOCALLY_SENT,
                ),
            )
        }.toList()
        return commit(
            current,
            current.copy(pendingInputs = updated),
            RelayV2TerminalOutcome.Applied,
        )
    }

    private fun inputAck(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.InputAck,
    ): RelayV2TerminalReduction {
        fenceGuard(current, action.fence)?.let { return it }
        val applied = applyInputAck(current, action.ackedThroughInputSeq)
        return when (applied) {
            is InputAckApply.Duplicate -> reduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.DUPLICATE_ACK),
            )
            is InputAckApply.Rejected -> controlRejected(
                current,
                RelayV2TerminalControlKind.INPUT,
                RelayV2TerminalControlRejectionReason.ACK_BEYOND_SENT,
                action.ackedThroughInputSeq,
                current.ackedThroughInputSeq,
            )
            is InputAckApply.Applied -> commit(
                current,
                applied.checkpoint,
                RelayV2TerminalOutcome.ControlAcked(
                    RelayV2TerminalControlKind.INPUT,
                    action.ackedThroughInputSeq,
                ),
            )
        }
    }

    private fun inputError(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.InputError,
    ): RelayV2TerminalReduction {
        fenceGuard(current, action.fence)?.let { return it }
        val acked = when (val applied = applyInputAck(current, action.ackedThroughInputSeq)) {
            is InputAckApply.Applied -> applied.checkpoint
            InputAckApply.Duplicate -> current
            InputAckApply.Rejected -> return controlRejected(
                current,
                RelayV2TerminalControlKind.INPUT,
                RelayV2TerminalControlRejectionReason.ACK_BEYOND_SENT,
                action.inputSeq,
                current.ackedThroughInputSeq,
            )
        }
        return when (action.error) {
            RelayV2TerminalControlError.GAP -> {
                val retryable = acked.copy(
                    pendingInputs = acked.pendingInputs.map {
                        it.releaseLocallySentDispatchClaim(acked.identity.generation)
                    },
                )
                reduction(
                retryable,
                RelayV2TerminalOutcome.ControlRejected(
                    RelayV2TerminalControlKind.INPUT,
                    RelayV2TerminalControlRejectionReason.GAP,
                    action.inputSeq,
                    action.ackedThroughInputSeq,
                ),
                pendingControlEffects(retryable).filterIsInstance<RelayV2TerminalEffect.SendInput>(),
            )
            }
            RelayV2TerminalControlError.CONFLICT -> reset(
                acked,
                RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
                RelayV2TerminalOutcome.ControlRejected(
                    RelayV2TerminalControlKind.INPUT,
                    RelayV2TerminalControlRejectionReason.CONFLICT,
                    action.inputSeq,
                    action.ackedThroughInputSeq,
                ),
            )
        }
    }

    private fun enqueueResize(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.EnqueueResize,
    ): RelayV2TerminalReduction {
        deliveryGuard(current, action.deliveryToken)?.let { return it }
        if (!terminalWritable(current)) {
            return controlRejected(
                current,
                RelayV2TerminalControlKind.RESIZE,
                RelayV2TerminalControlRejectionReason.TERMINAL_NOT_WRITABLE,
                null,
                current.ackedThroughResizeSeq,
            )
        }
        if (action.cols !in 1..1000 || action.rows !in 1..500) {
            return controlRejected(
                current,
                RelayV2TerminalControlKind.RESIZE,
                RelayV2TerminalControlRejectionReason.INVALID_DIMENSIONS,
                null,
                current.ackedThroughResizeSeq,
            )
        }
        if (current.pendingResizes.size + 1 >
            RelayV2TerminalCheckpointLimits.MAX_RESIZE_RECORDS
        ) {
            return reset(current, RelayV2TerminalResetReason.SLOW_CONSUMER)
        }
        val seq = parsePositiveCounter(current.nextResizeSeq)
            ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        val next = incrementCounter(seq)
            ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        val pending = RelayV2PendingResize(
            current.identity.generation,
            seq.toString(),
            action.cols,
            action.rows,
            RelayV2TerminalControlDisposition.QUEUED,
        )
        return commit(
            current,
            current.copy(
                nextResizeSeq = next.toString(),
                pendingResizes = current.pendingResizes + pending,
            ),
            RelayV2TerminalOutcome.ControlQueued(
                RelayV2TerminalControlKind.RESIZE,
                seq.toString(),
            ),
            listOf(
                RelayV2TerminalEffect.SendResize(
                    requireNotNull(current.activeControlDispatchLease),
                    current.identity.generation,
                    seq.toString(),
                    action.cols,
                    action.rows,
                ),
            ),
        )
    }

    private fun resizeSent(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ResizeSent,
    ): RelayV2TerminalReduction {
        val claim = action.claim
        val seq = parsePositiveCounter(claim.resizeSeq)
            ?: return resizeGap(current, claim.resizeSeq)
        val index = current.pendingResizes.indexOfFirst { parseCounter(it.resizeSeq) == seq }
        if (index < 0 || current.pendingResizes.take(index).any {
                it.disposition != RelayV2TerminalControlDisposition.SENT
            }
        ) {
            return resizeGap(current, claim.resizeSeq)
        }
        val existing = current.pendingResizes[index]
        if (existing.dispatchClaim != claim) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.DUPLICATE_CONTROL_DISPATCH,
                ),
            )
        }
        val updated = current.pendingResizes.toMutableList().also {
            it[index] = existing.copy(
                disposition = RelayV2TerminalControlDisposition.SENT,
                dispatchClaim = claim.copy(
                    phase = RelayV2TerminalControlDispatchClaimPhase.LOCALLY_SENT,
                ),
            )
        }.toList()
        return commit(
            current,
            current.copy(pendingResizes = updated),
            RelayV2TerminalOutcome.Applied,
        )
    }

    private fun resizeAck(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ResizeAck,
    ): RelayV2TerminalReduction {
        fenceGuard(current, action.fence)?.let { return it }
        return when (val applied = applyResizeAck(current, action.ackedThroughResizeSeq)) {
            ResizeAckApply.Duplicate -> reduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.DUPLICATE_ACK),
            )
            ResizeAckApply.Rejected -> controlRejected(
                current,
                RelayV2TerminalControlKind.RESIZE,
                RelayV2TerminalControlRejectionReason.ACK_BEYOND_SENT,
                action.ackedThroughResizeSeq,
                current.ackedThroughResizeSeq,
            )
            is ResizeAckApply.Applied -> commit(
                current,
                applied.checkpoint,
                RelayV2TerminalOutcome.ControlAcked(
                    RelayV2TerminalControlKind.RESIZE,
                    action.ackedThroughResizeSeq,
                ),
            )
        }
    }

    private fun resizeError(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ResizeError,
    ): RelayV2TerminalReduction {
        fenceGuard(current, action.fence)?.let { return it }
        val acked = when (val applied = applyResizeAck(current, action.ackedThroughResizeSeq)) {
            is ResizeAckApply.Applied -> applied.checkpoint
            ResizeAckApply.Duplicate -> current
            ResizeAckApply.Rejected -> return controlRejected(
                current,
                RelayV2TerminalControlKind.RESIZE,
                RelayV2TerminalControlRejectionReason.ACK_BEYOND_SENT,
                action.resizeSeq,
                current.ackedThroughResizeSeq,
            )
        }
        return when (action.error) {
            RelayV2TerminalControlError.GAP -> {
                val retryable = acked.copy(
                    pendingResizes = acked.pendingResizes.map {
                        it.releaseLocallySentDispatchClaim(acked.identity.generation)
                    },
                )
                reduction(
                retryable,
                RelayV2TerminalOutcome.ControlRejected(
                    RelayV2TerminalControlKind.RESIZE,
                    RelayV2TerminalControlRejectionReason.GAP,
                    action.resizeSeq,
                    action.ackedThroughResizeSeq,
                ),
                pendingControlEffects(retryable).filterIsInstance<RelayV2TerminalEffect.SendResize>(),
            )
            }
            RelayV2TerminalControlError.CONFLICT -> reset(
                acked,
                RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
                RelayV2TerminalOutcome.ControlRejected(
                    RelayV2TerminalControlKind.RESIZE,
                    RelayV2TerminalControlRejectionReason.CONFLICT,
                    action.resizeSeq,
                    action.ackedThroughResizeSeq,
                ),
            )
        }
    }

    private fun retryUnacked(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.RetryUnackedControls,
    ): RelayV2TerminalReduction {
        deliveryGuard(current, action.deliveryToken)?.let { return it }
        if (!terminalWritable(current)) {
            return reduction(current, RelayV2TerminalOutcome.Applied)
        }
        /*
         * A settled SENT claim is the durable proof that its prior permission was consumed. Clear
         * it only in the same commit that emits retry effects. The empty claim slot is the new
         * merged permission: old/new duplicate effects may race for it, but ClaimControlDispatch
         * can grant only one of them before transport. CLAIMED may sit on QUEUED or an already-SENT
         * retry record while transport/settlement is in flight, so same-delivery retry must leave it
         * fail closed. Only exact InputSent/ResizeSent advances the claim to LOCALLY_SENT.
         */
        val candidate = current.copy(
            pendingInputs = current.pendingInputs.map {
                it.releaseLocallySentDispatchClaim(current.identity.generation)
            },
            pendingResizes = current.pendingResizes.map {
                it.releaseLocallySentDispatchClaim(current.identity.generation)
            },
        )
        return commit(
            current,
            candidate,
            RelayV2TerminalOutcome.Applied,
            pendingControlEffects(candidate),
        )
    }

    private fun RelayV2PendingInput.releaseLocallySentDispatchClaim(
        currentGeneration: String,
    ): RelayV2PendingInput = if (
        generation == currentGeneration &&
        disposition == RelayV2TerminalControlDisposition.SENT &&
        dispatchClaim?.phase == RelayV2TerminalControlDispatchClaimPhase.LOCALLY_SENT
    ) {
        copy(dispatchClaim = null)
    } else {
        this
    }

    private fun RelayV2PendingResize.releaseLocallySentDispatchClaim(
        currentGeneration: String,
    ): RelayV2PendingResize = if (
        generation == currentGeneration &&
        disposition == RelayV2TerminalControlDisposition.SENT &&
        dispatchClaim?.phase == RelayV2TerminalControlDispatchClaimPhase.LOCALLY_SENT
    ) {
        copy(dispatchClaim = null)
    } else {
        this
    }

    private fun pendingControlEffects(
        checkpoint: RelayV2TerminalCheckpoint,
    ): List<RelayV2TerminalEffect> = buildList {
        val lease = checkpoint.activeControlDispatchLease ?: return@buildList
        checkpoint.pendingInputs.filter { it.dispatchClaim == null }.forEach {
            add(
                RelayV2TerminalEffect.SendInput(
                    lease,
                    it.generation,
                    it.inputSeq,
                    it.bytes,
                ),
            )
        }
        checkpoint.pendingResizes.filter { it.dispatchClaim == null }.forEach {
            add(
                RelayV2TerminalEffect.SendResize(
                    lease,
                    it.generation,
                    it.resizeSeq,
                    it.cols,
                    it.rows,
                ),
            )
        }
    }

    private fun requestClose(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.RequestClose,
    ): RelayV2TerminalReduction {
        deliveryGuard(current, action.deliveryToken)?.let { return it }
        if (!validOperationId(action.requestId)) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        if (action.requestId in current.closeRequestIds) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.NETWORK_REQUEST_ID_REUSED,
                ),
            )
        }
        current.pendingClose?.let { pending ->
            if (pending.closeAttempt == action.closeAttempt) {
                val issuedRequestIds = appendRequestId(
                    pending.issuedRequestIds,
                    action.requestId,
                ) ?: return reset(
                    current,
                    RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED,
                )
                val closeRequestIds = appendRequestId(
                    current.closeRequestIds,
                    action.requestId,
                ) ?: return reset(
                    current,
                    RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED,
                )
                val retried = pending.copy(
                    requestId = action.requestId,
                    issuedRequestIds = issuedRequestIds,
                )
                val candidate = current.copy(
                    pendingClose = retried,
                    closeRequestIds = closeRequestIds,
                    activeControlDispatchLease = null,
                )
                return commit(
                    current,
                    candidate,
                    RelayV2TerminalOutcome.Applied,
                    listOf(retried.deliveryEffect(candidate)),
                )
            }
            if (pending.closeAttempt.closeId == action.closeAttempt.closeId) {
                return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
            }
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        if (current.closed != null) {
            return reduction(current, RelayV2TerminalOutcome.Applied)
        }
        val closeRequestIds = appendRequestId(current.closeRequestIds, action.requestId)
            ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED)
        val pending = RelayV2TerminalPendingClose(
            action.closeAttempt,
            action.requestId,
            listOf(action.requestId),
        )
        return commit(
            current,
            current.copy(
                pendingClose = pending,
                closeRequestIds = closeRequestIds,
                activeControlDispatchLease = null,
            ),
            RelayV2TerminalOutcome.Applied,
            listOf(pending.sendEffect(current)),
        )
    }

    private fun closed(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.Closed,
    ): RelayV2TerminalReduction {
        if (current.phase == RelayV2TerminalPhase.FINALIZED) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.FINALIZED_LATE_EVENT),
            )
        }
        val correlatedCloseAttempt = when (val correlation =
            closedResponseCorrelation(current, action)
        ) {
            is ClosedResponseCorrelation.Current -> correlation.closeAttempt
            ClosedResponseCorrelation.Natural -> null
            is ClosedResponseCorrelation.Rejected -> return correlation.reduction
        }
        if (!validClose(action)) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        val finalOffset = parseCounter(action.finalOffset)
            ?: return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        val bufferStart = action.bufferStartOffset?.let(::parseCounter)
        if ((action.replayAvailable && bufferStart == null) ||
            (!action.replayAvailable && action.bufferStartOffset != null) ||
            (bufferStart != null && bufferStart > finalOffset)
        ) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        var incoming = RelayV2TerminalClosedState(
            tombstone = closedTombstone(current, action, correlatedCloseAttempt),
            retainedBuffer = RelayV2TerminalRetainedBuffer(
                action.replayAvailable,
                action.bufferStartOffset,
            ),
        )
        current.closed?.let { existing ->
            if (existing.tombstone.copy(closeAttempt = null) !=
                incoming.tombstone.copy(closeAttempt = null)
            ) {
                return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
            }
            val resolvedCloseAttempt = when {
                existing.tombstone.closeAttempt == null -> incoming.tombstone.closeAttempt
                incoming.tombstone.closeAttempt == null -> existing.tombstone.closeAttempt
                existing.tombstone.closeAttempt == incoming.tombstone.closeAttempt ->
                    existing.tombstone.closeAttempt
                else -> return reset(
                    current,
                    RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
                )
            }
            incoming = incoming.copy(
                tombstone = incoming.tombstone.copy(closeAttempt = resolvedCloseAttempt),
            )
            if (existing == incoming) {
                return reduction(
                    current,
                    RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.DUPLICATE_CLOSED),
                )
            }
            if (!retainedBufferCanAdvance(existing.retainedBuffer, incoming.retainedBuffer)) {
                return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
            }
        }
        val tail = parseCounter(current.networkReceivedThrough)
            ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        if (finalOffset < tail) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        var candidate = abandonControlsForClosed(
            current.copy(
                closed = incoming,
                pendingClose = if (correlatedCloseAttempt != null) null else current.pendingClose,
            ),
        )
        val closedControlEffects = ambiguousEffect(current, candidate)
        if (finalOffset == tail) {
            if (finalOffset == parseCounter(current.parserAppliedNextOffset) &&
                current.pendingOutput.isEmpty() && current.parserResetCallbackToken == null &&
                candidate.pendingClose == null
            ) {
                val finalized = finalizeClosed(candidate)
                return commit(
                    current,
                    finalized.checkpoint,
                    RelayV2TerminalOutcome.ClosedFinalized,
                    closedControlEffects + finalized.effects,
                )
            }
            candidate = candidate.copy(
                phase = if (candidate.pendingClose != null &&
                    candidate.pendingOutput.isEmpty() && candidate.parserResetCallbackToken == null
                ) {
                    RelayV2TerminalPhase.CLOSED_WAITING_CLOSE
                } else {
                    RelayV2TerminalPhase.CLOSED_WAITING_PARSER
                },
                replayTargetOffset = null,
            )
            return commit(
                current,
                candidate,
                RelayV2TerminalOutcome.Applied,
                closedControlEffects,
            )
        }

        if (current.phase == RelayV2TerminalPhase.REPLAY_REQUESTED &&
            retainedBufferCovers(incoming.retainedBuffer, tail)
        ) {
            return commit(
                current,
                candidate,
                RelayV2TerminalOutcome.ReplayRequired(tail.toString()),
                closedControlEffects,
            )
        }
        return closedNeedsReplayOrReset(current, candidate, tail)
    }

    private fun correlatedResetRequired(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.CorrelatedResetRequired,
    ): RelayV2TerminalReduction {
        val correlation = when (action.origin) {
            RelayV2TerminalResetOrigin.OPEN -> networkResponseCorrelation(
                action.requestId,
                current.pendingOpen?.requestId,
                current.openRequestIds,
            )
            RelayV2TerminalResetOrigin.REPLAY -> networkResponseCorrelation(
                action.requestId,
                current.pendingReplay?.requestId,
                current.replayRequestIds,
            )
        }
        when (correlation) {
            NetworkResponseCorrelation.ISSUED_OLD -> return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_RESET_RESPONSE),
            )
            NetworkResponseCorrelation.UNKNOWN -> return reset(
                current,
                RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
            )
            NetworkResponseCorrelation.CURRENT -> Unit
        }
        val matchesCurrentAuthority = action.fence == actionFence(current) &&
            when (action.origin) {
                RelayV2TerminalResetOrigin.OPEN -> current.pendingOpen?.let {
                    it.deliveryToken == action.fence.deliveryToken &&
                        it.openAttempt == action.openAttempt
                } == true
                RelayV2TerminalResetOrigin.REPLAY -> current.pendingReplay?.let {
                    it.fence == effectFence(current)
                } == true && action.openAttempt == null
            }
        if (!matchesCurrentAuthority) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        return applyHostReset(current, action.reason, action.requestedOffset,
            action.bufferStartOffset, action.tailOffset)
    }

    private fun asyncResetRequired(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.AsyncResetRequired,
    ): RelayV2TerminalReduction {
        if (!validOperationId(action.correlationProofId)) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        return applyHostReset(current, action.reason, action.requestedOffset,
            action.bufferStartOffset, action.tailOffset)
    }

    private fun applyHostReset(
        current: RelayV2TerminalCheckpoint,
        resetReason: RelayV2TerminalResetReason,
        requestedOffset: String?,
        bufferStartOffset: String?,
        tailOffset: String?,
    ): RelayV2TerminalReduction {
        val reason = validatedHostResetReason(
            resetReason,
            requestedOffset,
            bufferStartOffset,
            tailOffset,
        ) ?: RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT
        return reset(current, reason)
    }

    private fun validatedHostResetReason(
        resetReason: RelayV2TerminalResetReason,
        requestedOffset: String?,
        bufferStartOffset: String?,
        tailOffset: String?,
    ): RelayV2TerminalResetReason? {
        val requested = requestedOffset?.let(::parseCounter)
        val bufferStart = bufferStartOffset?.let(::parseCounter)
        val tail = tailOffset?.let(::parseCounter)
        if ((requestedOffset != null && requested == null) ||
            (bufferStartOffset != null && bufferStart == null) ||
            (tailOffset != null && tail == null) ||
            (bufferStart != null && tail != null && bufferStart > tail) ||
            (resetReason == RelayV2TerminalResetReason.OFFSET_EXPIRED &&
                (requested == null || tail == null))
        ) {
            return null
        }
        return when (resetReason) {
            RelayV2TerminalResetReason.SLOW_CONSUMER,
            RelayV2TerminalResetReason.HOST_BUFFER_PRESSURE,
            RelayV2TerminalResetReason.GENERATION_STALE,
            RelayV2TerminalResetReason.OFFSET_EXPIRED,
            RelayV2TerminalResetReason.STREAM_LOST,
            -> resetReason
            else -> null
        }
    }

    private fun requestReplay(
        current: RelayV2TerminalCheckpoint,
        fromOffset: String,
    ): RelayV2TerminalReduction {
        current.pendingReplay?.let {
            return reduction(
                current,
                RelayV2TerminalOutcome.ReplayRequired(it.fromOffset),
            )
        }
        val sequence = parsePositiveCounter(current.nextReplayRequestSeq)
            ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        val next = incrementCounter(sequence)
            ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        val fence = effectFence(current)
        val requestId = "replay-$sequence"
        val requestIds = appendRequestId(current.replayRequestIds, requestId)
            ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED)
        val candidate = current.copy(
            phase = RelayV2TerminalPhase.REPLAY_REQUESTED,
            nextReplayRequestSeq = next.toString(),
            pendingReplay = RelayV2TerminalPendingReplay(requestId, fence, fromOffset),
            replayRequestIds = requestIds,
            replayTargetOffset = null,
        )
        return commit(
            current,
            candidate,
            RelayV2TerminalOutcome.ReplayRequired(fromOffset),
            listOf(
                RelayV2TerminalEffect.RequestReplay(
                    fence,
                    requestId,
                    current.identity.generation,
                    fromOffset,
                ),
            ),
        )
    }

    private fun retryReplay(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.RetryReplay,
    ): RelayV2TerminalReduction {
        deliveryGuard(current, action.deliveryToken)?.let { return it }
        if (!validOperationId(action.requestId)) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        val pending = current.pendingReplay ?: return reduction(
            current,
            RelayV2TerminalOutcome.Applied,
        )
        if (action.requestId in current.replayRequestIds) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.NETWORK_REQUEST_ID_REUSED,
                ),
            )
        }
        val requestIds = appendRequestId(current.replayRequestIds, action.requestId)
            ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED)
        val retried = pending.copy(
            requestId = action.requestId,
            fence = effectFence(current),
        )
        val candidate = current.copy(
            pendingReplay = retried,
            replayRequestIds = requestIds,
        )
        return commit(
            current,
            candidate,
            RelayV2TerminalOutcome.ReplayRequired(retried.fromOffset),
            listOf(
                RelayV2TerminalEffect.RequestReplay(
                    retried.fence,
                    retried.requestId,
                    current.identity.generation,
                    retried.fromOffset,
                ),
            ),
        )
    }

    private fun recoverClosed(current: RelayV2TerminalCheckpoint): ClosedRecovery {
        val closed = current.closed ?: return ClosedRecovery(current, emptyList())
        val finalOffset = parseCounter(closed.tombstone.finalOffset)
            ?: return resetClosedRecovery(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        val applied = parseCounter(current.parserAppliedNextOffset)
            ?: return resetClosedRecovery(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        val tail = parseCounter(current.networkReceivedThrough)
            ?: return resetClosedRecovery(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        if (applied > finalOffset || tail > finalOffset) {
            return resetClosedRecovery(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        if (applied == finalOffset && current.pendingOutput.isEmpty()) {
            if (current.pendingClose != null) {
                return ClosedRecovery(
                    current.copy(
                        phase = RelayV2TerminalPhase.CLOSED_WAITING_CLOSE,
                        pendingReplay = null,
                        replayTargetOffset = null,
                    ),
                    emptyList(),
                )
            }
            return finalizeClosed(current)
        }
        if (current.pendingOutput.isNotEmpty() || current.phase == RelayV2TerminalPhase.REPLAYING ||
            current.phase == RelayV2TerminalPhase.REPLAY_REQUESTED
        ) {
            return ClosedRecovery(current, emptyList())
        }
        return if (retainedBufferCovers(closed.retainedBuffer, tail)) {
            val replay = requestReplay(current, tail.toString())
            ClosedRecovery(requireNotNull(replay.checkpoint), replay.effects)
        } else {
            val reset = markResetRequired(current, RelayV2TerminalResetReason.OFFSET_EXPIRED)
            ClosedRecovery(
                reset,
                listOf(
                    RelayV2TerminalEffect.DisplayTruncated(
                        effectFence(current),
                        current.parserAppliedNextOffset,
                        closed.tombstone.finalOffset,
                    ),
                    RelayV2TerminalEffect.ResetRequired(
                        effectFence(current),
                        RelayV2TerminalResetReason.OFFSET_EXPIRED,
                        current.parserAppliedNextOffset,
                    ),
                ) + ambiguousEffect(current, reset),
            )
        }
    }

    private fun closedNeedsReplayOrReset(
        previous: RelayV2TerminalCheckpoint,
        candidate: RelayV2TerminalCheckpoint,
        from: BigInteger,
    ): RelayV2TerminalReduction {
        val closed = requireNotNull(candidate.closed)
        return if (retainedBufferCovers(closed.retainedBuffer, from)) {
            val replay = requestReplay(candidate, from.toString())
            commit(
                previous,
                requireNotNull(replay.checkpoint),
                replay.outcome,
                ambiguousEffect(previous, candidate) + replay.effects,
            )
        } else {
            val reset = markResetRequired(candidate, RelayV2TerminalResetReason.OFFSET_EXPIRED)
            commit(
                previous,
                reset,
                RelayV2TerminalOutcome.ResetRequired(RelayV2TerminalResetReason.OFFSET_EXPIRED),
                listOf(
                    RelayV2TerminalEffect.DisplayTruncated(
                        effectFence(candidate),
                        candidate.parserAppliedNextOffset,
                        closed.tombstone.finalOffset,
                    ),
                    RelayV2TerminalEffect.ResetRequired(
                        effectFence(candidate),
                        RelayV2TerminalResetReason.OFFSET_EXPIRED,
                        candidate.parserAppliedNextOffset,
                    ),
                ) + ambiguousEffect(previous, candidate) + ambiguousEffect(candidate, reset),
            )
        }
    }

    private fun applyInputAck(
        current: RelayV2TerminalCheckpoint,
        encodedAck: String,
    ): InputAckApply {
        val ack = parseCounter(encodedAck) ?: return InputAckApply.Rejected
        val currentAck = parseCounter(current.ackedThroughInputSeq) ?: return InputAckApply.Rejected
        if (ack <= currentAck) return InputAckApply.Duplicate
        var highestSent = currentAck
        for (pending in current.pendingInputs) {
            val seq = parseCounter(pending.inputSeq) ?: return InputAckApply.Rejected
            if (seq != highestSent + ONE ||
                pending.disposition != RelayV2TerminalControlDisposition.SENT
            ) {
                break
            }
            highestSent = seq
        }
        if (ack > highestSent) return InputAckApply.Rejected
        return InputAckApply.Applied(
            current.copy(
                ackedThroughInputSeq = ack.toString(),
                pendingInputs = current.pendingInputs.filter {
                    requireNotNull(parseCounter(it.inputSeq)) > ack
                },
            ),
        )
    }

    private fun applyResizeAck(
        current: RelayV2TerminalCheckpoint,
        encodedAck: String,
    ): ResizeAckApply {
        val ack = parseCounter(encodedAck) ?: return ResizeAckApply.Rejected
        val currentAck = parseCounter(current.ackedThroughResizeSeq) ?: return ResizeAckApply.Rejected
        if (ack <= currentAck) return ResizeAckApply.Duplicate
        var highestSent = currentAck
        for (pending in current.pendingResizes) {
            val seq = parseCounter(pending.resizeSeq) ?: return ResizeAckApply.Rejected
            if (seq != highestSent + ONE ||
                pending.disposition != RelayV2TerminalControlDisposition.SENT
            ) {
                break
            }
            highestSent = seq
        }
        if (ack > highestSent) return ResizeAckApply.Rejected
        return ResizeAckApply.Applied(
            current.copy(
                ackedThroughResizeSeq = ack.toString(),
                pendingResizes = current.pendingResizes.filter {
                    requireNotNull(parseCounter(it.resizeSeq)) > ack
                },
            ),
        )
    }

    private fun actionGuard(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction,
    ): RelayV2TerminalReduction? = when (action) {
        is RelayV2TerminalAction.BeginOpenAttempt,
        is RelayV2TerminalAction.Opened,
        is RelayV2TerminalAction.PreOpenResetRequired,
        is RelayV2TerminalAction.VerifyContinuity,
        -> null
        is RelayV2TerminalAction.RebindDelivery ->
            deliveryGuard(current, action.currentDeliveryToken)
        is RelayV2TerminalAction.Output -> fenceGuard(current, action.fence)
        is RelayV2TerminalAction.ReplayStarted -> null
        is RelayV2TerminalAction.ClaimParserDispatch -> null
        is RelayV2TerminalAction.ReleaseParserDispatch ->
            parserDispatchClaimGuard(current, action.claim)
        is RelayV2TerminalAction.ParserApplied ->
            parserDispatchClaimGuard(current, action.claim)
        is RelayV2TerminalAction.ParserFailed ->
            parserDispatchClaimGuard(current, action.claim)
        is RelayV2TerminalAction.ParserResetApplied ->
            parserDispatchClaimGuard(current, action.claim)
        is RelayV2TerminalAction.ParserEffectsReserved ->
            parserCallbackGuard(current, action.activation.callbackToken)
        is RelayV2TerminalAction.ParserEffectsActivated ->
            parserCallbackGuard(current, action.activation.callbackToken)
        is RelayV2TerminalAction.ParserEffectReservationFailed ->
            parserCallbackGuard(current, action.callbackToken)
        is RelayV2TerminalAction.ParserEffectActivationFailed ->
            parserCallbackGuard(current, action.activation.callbackToken)
        is RelayV2TerminalAction.EnqueueInput -> deliveryGuard(current, action.deliveryToken)
        is RelayV2TerminalAction.ClaimControlDispatch -> null
        is RelayV2TerminalAction.ReleaseControlDispatch ->
            controlClaimGuard(current, action.claim)
        is RelayV2TerminalAction.ControlDispatchUncertain ->
            controlClaimGuard(current, action.claim)
        is RelayV2TerminalAction.InputSent -> controlClaimGuard(current, action.claim)
        is RelayV2TerminalAction.InputAck -> fenceGuard(current, action.fence)
        is RelayV2TerminalAction.InputError -> fenceGuard(current, action.fence)
        is RelayV2TerminalAction.EnqueueResize -> deliveryGuard(current, action.deliveryToken)
        is RelayV2TerminalAction.ResizeSent -> controlClaimGuard(current, action.claim)
        is RelayV2TerminalAction.ResizeAck -> fenceGuard(current, action.fence)
        is RelayV2TerminalAction.ResizeError -> fenceGuard(current, action.fence)
        is RelayV2TerminalAction.RetryUnackedControls ->
            deliveryGuard(current, action.deliveryToken)
        is RelayV2TerminalAction.RetryReplay -> deliveryGuard(current, action.deliveryToken)
        is RelayV2TerminalAction.RequestClose -> deliveryGuard(current, action.deliveryToken)
        is RelayV2TerminalAction.Closed -> null
        is RelayV2TerminalAction.CorrelatedError -> null
        is RelayV2TerminalAction.CorrelatedResetRequired -> null
        is RelayV2TerminalAction.AsyncResetRequired -> fenceGuard(current, action.fence)
    }

    private fun deliveryGuard(
        current: RelayV2TerminalCheckpoint,
        deliveryToken: RelayV2TerminalDeliveryToken,
    ): RelayV2TerminalReduction? = if (deliveryToken != current.deliveryToken) {
        reduction(
            current,
            RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_DELIVERY),
        )
    } else {
        null
    }

    private fun controlClaimGuard(
        current: RelayV2TerminalCheckpoint,
        claim: RelayV2TerminalControlDispatchClaim,
    ): RelayV2TerminalReduction? = if (
        claim.dispatchLease != current.activeControlDispatchLease ||
        claim.dispatchLease.fence != effectFence(current)
    ) {
        reduction(
            current,
            RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_DELIVERY),
        )
    } else {
        null
    }

    private fun parserDispatchClaimGuard(
        current: RelayV2TerminalCheckpoint,
        claim: RelayV2TerminalParserDispatchClaim,
    ): RelayV2TerminalReduction? {
        parserCallbackGuard(current, claim.callbackToken)?.let { return it }
        return if (current.pendingParserDispatchClaim != claim) {
            reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    if (claim.callbackToken == current.lastAppliedParserCallbackToken) {
                        RelayV2TerminalIgnoredReason.DUPLICATE_PARSER_CALLBACK
                    } else {
                        RelayV2TerminalIgnoredReason.OUT_OF_ORDER_PARSER_CALLBACK
                    },
                ),
            )
        } else {
            null
        }
    }

    private fun RelayV2TerminalParserDispatchClaim.matches(
        effect: RelayV2TerminalEffect,
    ): Boolean = when {
        this is RelayV2TerminalParserDispatchClaim.Write &&
            effect is RelayV2TerminalEffect.WriteParser ->
            fence == effect.fence && callbackToken == effect.callbackToken &&
                bytes == effect.bytes
        this is RelayV2TerminalParserDispatchClaim.Reset &&
            effect is RelayV2TerminalEffect.ResetParser ->
            fence == effect.fence && callbackToken == effect.callbackToken
        else -> false
    }

    private fun RelayV2TerminalControlDispatchClaim.matches(
        effect: RelayV2TerminalEffect,
    ): Boolean = when {
        this is RelayV2TerminalControlDispatchClaim.Input &&
            effect is RelayV2TerminalEffect.SendInput ->
            dispatchLease == effect.dispatchLease && generation == effect.generation &&
                inputSeq == effect.inputSeq && bytes == effect.bytes
        this is RelayV2TerminalControlDispatchClaim.Resize &&
            effect is RelayV2TerminalEffect.SendResize ->
            dispatchLease == effect.dispatchLease && generation == effect.generation &&
                resizeSeq == effect.resizeSeq && cols == effect.cols && rows == effect.rows
        else -> false
    }

    private fun RelayV2TerminalCheckpoint.contains(
        claim: RelayV2TerminalControlDispatchClaim,
    ): Boolean = when (claim) {
        is RelayV2TerminalControlDispatchClaim.Input -> pendingInputs.any {
            it.dispatchClaim == claim
        }
        is RelayV2TerminalControlDispatchClaim.Resize -> pendingResizes.any {
            it.dispatchClaim == claim
        }
    }

    private fun fenceGuard(
        current: RelayV2TerminalCheckpoint,
        fence: RelayV2TerminalActionFence,
    ): RelayV2TerminalReduction? = deliveryGuard(current, fence.deliveryToken) ?: when {
        fence.openId != current.openAttempt.openId -> reduction(
            current,
            RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_DELIVERY),
        )
        else -> bindingGuard(current, fence.binding)
    }

    private fun parserCallbackGuard(
        current: RelayV2TerminalCheckpoint,
        callbackToken: RelayV2TerminalParserCallbackToken,
    ): RelayV2TerminalReduction? = if (
        callbackToken.fence.identity != current.identity ||
        callbackToken.fence.openAttempt != current.openAttempt ||
        callbackToken.fence.deliveryToken != current.deliveryToken ||
        callbackToken.parserContinuityId != current.parserContinuityId
    ) {
        reduction(
            current,
            RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_PARSER_CALLBACK),
        )
    } else {
        null
    }

    private fun bindingGuard(
        current: RelayV2TerminalCheckpoint,
        binding: RelayV2TerminalBinding,
    ): RelayV2TerminalReduction? = when {
        binding.hostInstanceId != current.identity.hostInstanceId ->
            reset(current, RelayV2TerminalResetReason.STREAM_LOST)
        binding.generation != current.identity.generation -> reduction(
            current,
            RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_GENERATION),
        )
        else -> null
    }

    private fun reset(
        current: RelayV2TerminalCheckpoint,
        reason: RelayV2TerminalResetReason,
        outcome: RelayV2TerminalOutcome = RelayV2TerminalOutcome.ResetRequired(reason),
    ): RelayV2TerminalReduction {
        val reset = markResetRequired(current, reason)
        return reduction(
            reset,
            outcome,
            listOf(
                RelayV2TerminalEffect.ResetRequired(
                    effectFence(current),
                    reason,
                    current.parserAppliedNextOffset,
                ),
            ) + ambiguousEffect(current, reset),
        )
    }

    private fun markResetRequired(
        current: RelayV2TerminalCheckpoint,
        reason: RelayV2TerminalResetReason,
    ): RelayV2TerminalCheckpoint = current.copy(
        phase = RelayV2TerminalPhase.RESET_REQUIRED,
        pendingOpen = null,
        pendingReplay = null,
        replayTargetOffset = null,
        pendingParserDispatchClaim = null,
        pendingInputs = emptyList(),
        pendingResizes = emptyList(),
        activeControlDispatchLease = null,
        ambiguousInputs = current.ambiguousInputs + current.pendingInputs.map {
            RelayV2AmbiguousInput(it.generation, it.inputSeq, it.bytes)
        },
        resetReason = reason,
    )

    private fun ambiguousEffect(
        before: RelayV2TerminalCheckpoint,
        after: RelayV2TerminalCheckpoint,
    ): List<RelayV2TerminalEffect> {
        val inputDelta = after.ambiguousInputs.size - before.ambiguousInputs.size
        return if (inputDelta > 0) {
            listOf(
                RelayV2TerminalEffect.ControlsBecameAmbiguous(
                    effectFence(after),
                    inputDelta,
                ),
            )
        } else {
            emptyList()
        }
    }

    private fun abandonControlsForClosed(
        current: RelayV2TerminalCheckpoint,
    ): RelayV2TerminalCheckpoint = current.copy(
        pendingInputs = emptyList(),
        pendingResizes = emptyList(),
        activeControlDispatchLease = null,
        ambiguousInputs = current.ambiguousInputs + current.pendingInputs.map {
            RelayV2AmbiguousInput(it.generation, it.inputSeq, it.bytes)
        },
    )

    private fun finalizeClosed(current: RelayV2TerminalCheckpoint): ClosedRecovery {
        val closed = requireNotNull(current.closed)
        require(current.pendingClose == null)
        val finalized = abandonControlsForClosed(current).copy(
            phase = RelayV2TerminalPhase.FINALIZED,
            pendingOpen = null,
            pendingReplay = null,
            replayTargetOffset = null,
            parserInFlightCallbackToken = null,
        )
        return ClosedRecovery(
            finalized,
            ambiguousEffect(current, finalized) + closed.tombstone.finalizeEffect(finalized),
        )
    }

    private fun missingReset(
        identity: RelayV2TerminalIdentity?,
        reason: RelayV2TerminalResetReason,
        deliveryToken: RelayV2TerminalDeliveryToken? = null,
        openAttempt: RelayV2TerminalOpenAttempt? = null,
    ): RelayV2TerminalReduction = reduction(
        null,
        RelayV2TerminalOutcome.ResetRequired(reason),
        RelayV2TerminalEffect.ResetRequired(
            if (identity != null && deliveryToken != null && openAttempt != null) {
                RelayV2TerminalEffectFence(identity, deliveryToken, openAttempt)
            } else {
                null
            },
            reason,
            null,
        ),
    )

    private fun controlRejected(
        current: RelayV2TerminalCheckpoint,
        kind: RelayV2TerminalControlKind,
        reason: RelayV2TerminalControlRejectionReason,
        sequence: String?,
        ackedThrough: String,
    ): RelayV2TerminalReduction = reduction(
        current,
        RelayV2TerminalOutcome.ControlRejected(kind, reason, sequence, ackedThrough),
    )

    private fun resizeGap(
        current: RelayV2TerminalCheckpoint,
        sequence: String,
    ): RelayV2TerminalReduction = controlRejected(
        current,
        RelayV2TerminalControlKind.RESIZE,
        RelayV2TerminalControlRejectionReason.GAP,
        sequence,
        current.ackedThroughResizeSeq,
    )

    private fun commit(
        previous: RelayV2TerminalCheckpoint?,
        candidate: RelayV2TerminalCheckpoint,
        outcome: RelayV2TerminalOutcome,
        effects: List<RelayV2TerminalEffect> = emptyList(),
        identityWhenMissing: RelayV2TerminalIdentity? = previous?.identity,
        deliveryWhenMissing: RelayV2TerminalDeliveryToken? = previous?.deliveryToken,
        openAttemptWhenMissing: RelayV2TerminalOpenAttempt? = previous?.openAttempt,
    ): RelayV2TerminalReduction = when (validateCheckpoint(candidate)) {
        CheckpointValidity.VALID -> reduction(candidate, outcome, effects)
        CheckpointValidity.SCHEMA_INCOMPATIBLE -> previous?.let {
            reset(it, RelayV2TerminalResetReason.SCHEMA_INCOMPATIBLE)
        } ?: missingReset(
            identityWhenMissing,
            RelayV2TerminalResetReason.SCHEMA_INCOMPATIBLE,
            deliveryWhenMissing,
            openAttemptWhenMissing,
        )
        CheckpointValidity.LIMIT_EXCEEDED -> previous?.let {
            reset(it, RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED)
        } ?: missingReset(
            identityWhenMissing,
            RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED,
            deliveryWhenMissing,
            openAttemptWhenMissing,
        )
        CheckpointValidity.INVALID -> previous?.let {
            reset(it, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        } ?: missingReset(
            identityWhenMissing,
            RelayV2TerminalResetReason.CHECKPOINT_INVALID,
            deliveryWhenMissing,
            openAttemptWhenMissing,
        )
        CheckpointValidity.OFFSET_EXPIRED -> previous?.let {
            reset(it, RelayV2TerminalResetReason.OFFSET_EXPIRED)
        } ?: missingReset(
            identityWhenMissing,
            RelayV2TerminalResetReason.OFFSET_EXPIRED,
            deliveryWhenMissing,
            openAttemptWhenMissing,
        )
    }

    private fun reduction(
        checkpoint: RelayV2TerminalCheckpoint?,
        outcome: RelayV2TerminalOutcome,
        vararg effects: RelayV2TerminalEffect,
    ): RelayV2TerminalReduction = reduction(checkpoint, outcome, effects.toList())

    private fun reduction(
        checkpoint: RelayV2TerminalCheckpoint?,
        outcome: RelayV2TerminalOutcome,
        effects: List<RelayV2TerminalEffect>,
    ): RelayV2TerminalReduction = RelayV2TerminalReduction(
        checkpoint,
        outcome,
        effects.sortedBy(RelayV2TerminalEffect::priority),
    )

    private fun preOpenReduction(
        checkpoint: RelayV2TerminalPreOpenCheckpoint,
        outcome: RelayV2TerminalOutcome,
        effects: List<RelayV2TerminalEffect> = emptyList(),
    ): RelayV2TerminalReduction = RelayV2TerminalReduction(
        checkpoint = null,
        outcome = outcome,
        effects = effects.sortedBy(RelayV2TerminalEffect::priority),
        preOpenCheckpoint = checkpoint,
    )

    private fun snapshotCheckpoint(
        checkpoint: RelayV2TerminalCheckpoint,
    ): RelayV2TerminalCheckpoint = checkpoint.copy(
        openRequestIds = checkpoint.openRequestIds.toList(),
        replayRequestIds = checkpoint.replayRequestIds.toList(),
        closeRequestIds = checkpoint.closeRequestIds.toList(),
        pendingParserDispatchClaim = when (val claim = checkpoint.pendingParserDispatchClaim) {
            is RelayV2TerminalParserDispatchClaim.Write ->
                claim.copy(bytes = claim.bytes.snapshot())
            is RelayV2TerminalParserDispatchClaim.Reset -> claim.copy()
            null -> null
        },
        pendingOutput = checkpoint.pendingOutput.map {
            it.copy(bytes = it.bytes.snapshot())
        },
        pendingInputs = checkpoint.pendingInputs.map {
            it.copy(
                bytes = it.bytes.snapshot(),
                dispatchClaim = it.dispatchClaim?.let { claim ->
                    claim.copy(bytes = claim.bytes.snapshot())
                },
            )
        },
        pendingResizes = checkpoint.pendingResizes.map { it.copy() },
        ambiguousInputs = checkpoint.ambiguousInputs.map {
            it.copy(bytes = it.bytes.snapshot())
        },
        pendingOpen = checkpoint.pendingOpen?.copy(
            issuedRequestIds = checkpoint.pendingOpen.issuedRequestIds.toList(),
        ),
        pendingClose = checkpoint.pendingClose?.copy(
            issuedRequestIds = checkpoint.pendingClose.issuedRequestIds.toList(),
        ),
    )

    private fun snapshotPreOpenCheckpoint(
        checkpoint: RelayV2TerminalPreOpenCheckpoint,
    ): RelayV2TerminalPreOpenCheckpoint = checkpoint.copy(
        openRequestIds = checkpoint.openRequestIds.toList(),
        pendingOpen = checkpoint.pendingOpen?.copy(
            issuedRequestIds = checkpoint.pendingOpen.issuedRequestIds.toList(),
        ),
    )

    private fun authoritativePreOpenAttempt(
        checkpoint: RelayV2TerminalPreOpenCheckpoint,
    ): RelayV2TerminalOpenAttempt? = when (checkpoint.phase) {
        RelayV2TerminalPreOpenPhase.PENDING_OPEN -> checkpoint.pendingOpen?.openAttempt
        RelayV2TerminalPreOpenPhase.RESET_REQUIRED -> checkpoint.resetFence?.openAttempt
    }

    /**
     * Rejects hostile storage shapes before any list is mapped or any terminal bytes are copied.
     * Once the O(1) counts pass, every traversal is bounded by the persisted hard count limits.
     */
    private fun preflightCheckpoint(
        checkpoint: RelayV2TerminalCheckpoint,
    ): CheckpointValidity {
        val outputCount = checkpoint.pendingOutput.size
        val pendingInputCount = checkpoint.pendingInputs.size
        val ambiguousInputCount = checkpoint.ambiguousInputs.size
        val resizeCount = checkpoint.pendingResizes.size
        val openRequestCount = checkpoint.openRequestIds.size
        val replayRequestCount = checkpoint.replayRequestIds.size
        val closeRequestCount = checkpoint.closeRequestIds.size
        val pendingOpenRequestCount = checkpoint.pendingOpen?.issuedRequestIds?.size ?: 0
        val pendingCloseRequestCount = checkpoint.pendingClose?.issuedRequestIds?.size ?: 0
        if (outputCount > RelayV2TerminalCheckpointLimits.MAX_PENDING_OUTPUT_FRAMES ||
            pendingInputCount.toLong() + ambiguousInputCount.toLong() >
            RelayV2TerminalCheckpointLimits.MAX_INPUT_RECORDS.toLong() ||
            resizeCount > RelayV2TerminalCheckpointLimits.MAX_RESIZE_RECORDS ||
            listOf(
                openRequestCount,
                replayRequestCount,
                closeRequestCount,
                pendingOpenRequestCount,
                pendingCloseRequestCount,
            ).any { it > RelayV2TerminalCheckpointLimits.MAX_NETWORK_REQUEST_IDS }
        ) {
            return CheckpointValidity.LIMIT_EXCEEDED
        }

        var outputBytes = 0L
        for (pending in checkpoint.pendingOutput) {
            if (pending.bytes.size !in 1..RelayV2TerminalCheckpointLimits.MAX_FRAME_BYTES) {
                return CheckpointValidity.INVALID
            }
            outputBytes += pending.bytes.size.toLong()
            if (outputBytes > RelayV2TerminalCheckpointLimits.MAX_PENDING_OUTPUT_BYTES) {
                return CheckpointValidity.LIMIT_EXCEEDED
            }
        }
        var inputBytes = 0L
        for (pending in checkpoint.pendingInputs) {
            if (pending.bytes.size !in 1..RelayV2TerminalCheckpointLimits.MAX_FRAME_BYTES) {
                return CheckpointValidity.INVALID
            }
            inputBytes += pending.bytes.size.toLong()
            if (inputBytes > RelayV2TerminalCheckpointLimits.MAX_PENDING_INPUT_BYTES) {
                return CheckpointValidity.LIMIT_EXCEEDED
            }
        }
        for (ambiguous in checkpoint.ambiguousInputs) {
            if (ambiguous.bytes.size !in 1..RelayV2TerminalCheckpointLimits.MAX_FRAME_BYTES) {
                return CheckpointValidity.INVALID
            }
            inputBytes += ambiguous.bytes.size.toLong()
            if (inputBytes > RelayV2TerminalCheckpointLimits.MAX_PENDING_INPUT_BYTES) {
                return CheckpointValidity.LIMIT_EXCEEDED
            }
        }
        return validateCheckpoint(checkpoint)
    }

    private fun restoreValidatedCheckpoint(
        storedCheckpoint: RelayV2TerminalCheckpoint,
        expectedIdentity: RelayV2TerminalIdentity,
        expectedOpenAttempt: RelayV2TerminalOpenAttempt,
        currentDeliveryToken: RelayV2TerminalDeliveryToken,
        currentParserContinuityId: String?,
        parserOperationProof: RelayV2TerminalParserRestoreProof?,
    ): RelayV2TerminalReduction {
        if (storedCheckpoint.identity != expectedIdentity) {
            return missingReset(
                expectedIdentity,
                identityChangeReason(storedCheckpoint.identity, expectedIdentity),
                currentDeliveryToken,
                expectedOpenAttempt,
            )
        }
        if (storedCheckpoint.openAttempt != expectedOpenAttempt) {
            return missingReset(
                expectedIdentity,
                RelayV2TerminalResetReason.IDENTITY_CHANGED,
                currentDeliveryToken,
                expectedOpenAttempt,
            )
        }
        if (!deliveryIsFreshOrSame(storedCheckpoint.deliveryToken, currentDeliveryToken)) {
            return missingReset(
                expectedIdentity,
                RelayV2TerminalResetReason.IDENTITY_CHANGED,
                currentDeliveryToken,
                expectedOpenAttempt,
            )
        }
        if (currentParserContinuityId.isNullOrBlank() ||
            storedCheckpoint.parserContinuityId != currentParserContinuityId
        ) {
            return missingReset(
                expectedIdentity,
                RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST,
                currentDeliveryToken,
                expectedOpenAttempt,
            )
        }
        val storedSnapshot = snapshotCheckpoint(storedCheckpoint)
        val storedOperation = storedSnapshot.parserResetCallbackToken
            ?: storedSnapshot.parserInFlightCallbackToken
        val proofMatchesStoredOperation = storedOperation == null ||
            parserOperationProof?.matches(storedSnapshot, storedOperation) == true
        if (storedSnapshot.pendingParserDispatchClaim != null ||
            storedSnapshot.pendingParserEffectHandoff != null ||
            storedSnapshot.pendingParserEffectActivation != null
        ) {
            return normalizeParserRecoveryMarker(
                storedSnapshot,
                currentDeliveryToken,
            )
        }
        val checkpoint = if (storedSnapshot.deliveryToken != currentDeliveryToken) {
            rebindStoredFences(
                storedSnapshot,
                storedSnapshot.identity,
                currentDeliveryToken,
            )
        } else {
            storedSnapshot
        }
        if (checkpoint.phase == RelayV2TerminalPhase.RESET_REQUIRED) {
            val reason = checkpoint.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID
            return reduction(
                checkpoint,
                RelayV2TerminalOutcome.ResetRequired(reason),
                RelayV2TerminalEffect.ResetRequired(
                    effectFence(checkpoint),
                    reason,
                    checkpoint.parserAppliedNextOffset,
                ),
            )
        }

        if (storedOperation == null) {
            return reduction(checkpoint, RelayV2TerminalOutcome.Restored)
        }
        if (!proofMatchesStoredOperation) {
            return reset(checkpoint, RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST)
        }
        val operation = checkpoint.parserResetCallbackToken
            ?: checkpoint.parserInFlightCallbackToken
            ?: return reset(checkpoint, RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST)
        val proof = requireNotNull(parserOperationProof)
        return when (proof.status) {
            RelayV2TerminalParserOperationStatus.APPLIED -> {
                if (operation == checkpoint.parserResetCallbackToken) {
                    parserResetApplied(
                        checkpoint,
                        operation,
                        clearDispatchClaim = false,
                    )
                } else {
                    parserApplied(checkpoint, operation, clearDispatchClaim = false)
                }
            }
            RelayV2TerminalParserOperationStatus.NOT_APPLIED -> {
                val effect = if (operation == checkpoint.parserResetCallbackToken) {
                    RelayV2TerminalEffect.ResetParser(operation)
                } else {
                    checkpoint.pendingOutput.first().writeEffect()
                }
                reduction(checkpoint, RelayV2TerminalOutcome.Restored, effect)
            }
        }
    }

    /**
     * Restore is the only place that consumes crash-recovery parser markers. The current-process
     * failure paths deliberately retain H/A until this transaction persists a normalized reset.
     */
    private fun normalizeParserRecoveryMarker(
        stored: RelayV2TerminalCheckpoint,
        currentDeliveryToken: RelayV2TerminalDeliveryToken,
    ): RelayV2TerminalReduction {
        val consumed = stored.copy(
            parserResetCallbackToken = null,
            parserInFlightCallbackToken = null,
            lastAppliedParserCallbackToken = null,
            pendingParserDispatchClaim = null,
            pendingParserEffectHandoff = null,
            pendingParserEffectHandoffResetReason = null,
            pendingParserEffectActivation = null,
        )
        val rebound = if (consumed.deliveryToken != currentDeliveryToken) {
            rebindStoredFences(consumed, consumed.identity, currentDeliveryToken)
        } else {
            consumed
        }
        return reset(rebound, RelayV2TerminalResetReason.STREAM_LOST)
    }

    private fun RelayV2TerminalParserRestoreProof.matches(
        checkpoint: RelayV2TerminalCheckpoint,
        operation: RelayV2TerminalParserCallbackToken,
    ): Boolean {
        if (callbackToken != operation ||
            callbackToken.fence.identity != checkpoint.identity ||
            callbackToken.fence.openAttempt != checkpoint.openAttempt ||
            callbackToken.fence.deliveryToken != checkpoint.deliveryToken ||
            callbackToken.parserContinuityId != checkpoint.parserContinuityId ||
            parseCounter(parserAppliedNextOffset) == null
        ) {
            return false
        }
        val expectedApplied = when (status) {
            RelayV2TerminalParserOperationStatus.APPLIED -> operation.endOffset
            RelayV2TerminalParserOperationStatus.NOT_APPLIED -> operation.startOffset
        }
        return parserAppliedNextOffset == expectedApplied &&
            checkpoint.parserAppliedNextOffset == operation.startOffset
    }

    private fun validPreOpenCheckpoint(
        checkpoint: RelayV2TerminalPreOpenCheckpoint,
    ): Boolean {
        if (checkpoint.schemaVersion != RelayV2TerminalCheckpointLimits.SCHEMA_VERSION ||
            checkpoint.deliveryToken.actorGeneration.profileId != checkpoint.target.profileId ||
            checkpoint.deliveryToken.actorGeneration.profileGeneration !=
            checkpoint.target.profileActivationGeneration ||
            !validParserContinuity(checkpoint.parserContinuityId) ||
            !validRequestIdHistory(checkpoint.openRequestIds)
        ) {
            return false
        }
        return when (checkpoint.phase) {
            RelayV2TerminalPreOpenPhase.PENDING_OPEN -> checkpoint.resetReason == null &&
                checkpoint.resetFence == null &&
                checkpoint.pendingOpen?.let { pending ->
                    validOperationId(pending.requestId) &&
                        validRequestIdHistory(
                            pending.issuedRequestIds,
                            pending.requestId,
                        ) &&
                        pending.requestId == checkpoint.openRequestIds.lastOrNull() &&
                        (pending.issuedRequestIds.size == 1 ||
                            pending.requiresDeduplicatedResponse) &&
                        pending.deliveryToken == checkpoint.deliveryToken &&
                        pending.target == checkpoint.target &&
                        pending.parserContinuityId == checkpoint.parserContinuityId &&
                        pending.mode != RelayV2TerminalOpenMode.RESUME &&
                        validOpenResume(pending.mode, pending.resume) &&
                        pending.cols in 1..1000 && pending.rows in 1..500
                } == true
            RelayV2TerminalPreOpenPhase.RESET_REQUIRED ->
                checkpoint.pendingOpen == null && checkpoint.resetReason != null &&
                    checkpoint.resetFence?.let { fence ->
                        fence.target == checkpoint.target &&
                            fence.deliveryToken == checkpoint.deliveryToken &&
                            fence.parserContinuityId == checkpoint.parserContinuityId &&
                            validOpenResume(fence.mode, fence.resume) &&
                            fence.cols in 1..1000 && fence.rows in 1..500
                    } == true
        }
    }

    private fun preflightPreOpenCheckpoint(
        checkpoint: RelayV2TerminalPreOpenCheckpoint,
    ): Boolean {
        val openRequestCount = checkpoint.openRequestIds.size
        val pendingOpenRequestCount = checkpoint.pendingOpen?.issuedRequestIds?.size ?: 0
        if (openRequestCount > RelayV2TerminalCheckpointLimits.MAX_NETWORK_REQUEST_IDS ||
            pendingOpenRequestCount > RelayV2TerminalCheckpointLimits.MAX_NETWORK_REQUEST_IDS
        ) {
            return false
        }
        return validPreOpenCheckpoint(checkpoint)
    }

    private fun validateCheckpoint(checkpoint: RelayV2TerminalCheckpoint): CheckpointValidity {
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
                ))
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
            canDispatchParser(checkpoint)
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
            if (!validOperationId(it.requestId) ||
                !validRequestIdHistory(it.issuedRequestIds, it.requestId) ||
                it.issuedRequestIds != checkpoint.closeRequestIds ||
                checkpoint.closed?.tombstone?.closeAttempt != null
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
        if ((checkpoint.phase == RelayV2TerminalPhase.RESET_REQUIRED) !=
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
                checkpoint.pendingClose != null || checkpoint.parserResetCallbackToken != null)
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

    private fun validOperationId(value: String): Boolean = value.isNotBlank() &&
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

    private fun pendingOutputBytes(checkpoint: RelayV2TerminalCheckpoint): Int =
        checkpoint.pendingOutput.sumOf { it.bytes.size }

    private fun pendingInputBytes(checkpoint: RelayV2TerminalCheckpoint): Int =
        checkpoint.pendingInputs.sumOf { it.bytes.size } +
            checkpoint.ambiguousInputs.sumOf { it.bytes.size }

    private fun allocateParserOperation(
        checkpoint: RelayV2TerminalCheckpoint,
    ): ParserOperation? {
        val current = parsePositiveCounter(checkpoint.nextParserOperationSeq) ?: return null
        val next = incrementCounter(current) ?: return null
        return ParserOperation("write-$current", next.toString())
    }

    private fun RelayV2PendingParserWrite.writeEffect(): RelayV2TerminalEffect.WriteParser =
        RelayV2TerminalEffect.WriteParser(callbackToken, bytes)

    private fun validOpenRequest(action: RelayV2TerminalAction.BeginOpenAttempt): Boolean =
        validOperationId(action.requestId) &&
            validParserContinuity(action.parserContinuityId) &&
            action.cols in 1..1000 && action.rows in 1..500 &&
            validOpenResume(action.mode, action.resume)

    private fun validOpenResume(
        mode: RelayV2TerminalOpenMode,
        resume: RelayV2TerminalOpenResume?,
    ): Boolean = when (mode) {
        RelayV2TerminalOpenMode.NEW -> resume == null
        RelayV2TerminalOpenMode.RESUME -> resume != null &&
            parseCounter(resume.nextOffset ?: "") != null
        RelayV2TerminalOpenMode.RESET -> resume != null && resume.nextOffset == null
    }

    private fun RelayV2TerminalCheckpoint.openResume(
        nextOffset: String?,
    ): RelayV2TerminalOpenResume = RelayV2TerminalOpenResume(
        generation = identity.generation,
        nextOffset = nextOffset,
        resumeTokenCredentialReference = identity.resumeTokenCredentialReference,
        resumeTokenCredentialFingerprint = identity.resumeTokenCredentialFingerprint,
    )

    private fun pendingResumeMatchesTimeline(
        checkpoint: RelayV2TerminalCheckpoint,
        pending: RelayV2TerminalPendingOpen,
    ): Boolean {
        if (pending.mode == RelayV2TerminalOpenMode.NEW) return pending.resume == null
        val resume = pending.resume ?: return false
        if (resume.generation != checkpoint.identity.generation ||
            resume.resumeTokenCredentialReference !=
            checkpoint.identity.resumeTokenCredentialReference ||
            resume.resumeTokenCredentialFingerprint !=
            checkpoint.identity.resumeTokenCredentialFingerprint
        ) {
            return false
        }
        return when (pending.mode) {
            RelayV2TerminalOpenMode.NEW -> false
            RelayV2TerminalOpenMode.RESET -> resume.nextOffset == null
            RelayV2TerminalOpenMode.RESUME -> {
                val frozen = parseCounter(resume.nextOffset ?: "") ?: return false
                val applied = parseCounter(checkpoint.parserAppliedNextOffset) ?: return false
                frozen <= applied
            }
        }
    }

    private fun RelayV2TerminalAction.BeginOpenAttempt.pendingOpen():
        RelayV2TerminalPendingOpen = RelayV2TerminalPendingOpen(
        requestId = requestId,
        issuedRequestIds = listOf(requestId),
        deliveryToken = deliveryToken,
        openAttempt = openAttempt,
        mode = mode,
        cols = cols,
        rows = rows,
        target = target,
        parserContinuityId = parserContinuityId,
        resume = resume,
        requiresDeduplicatedResponse = false,
    )

    private fun RelayV2TerminalPendingOpen.sameLogicalAttempt(
        action: RelayV2TerminalAction.BeginOpenAttempt,
    ): Boolean = openAttempt == action.openAttempt && mode == action.mode &&
        cols == action.cols && rows == action.rows && target == action.target &&
        parserContinuityId == action.parserContinuityId && resume == action.resume

    private fun resetResultAdvancesAuthority(
        pending: RelayV2TerminalPendingOpen,
        identity: RelayV2TerminalIdentity,
    ): Boolean = pending.mode != RelayV2TerminalOpenMode.RESET ||
        resetResultAdvancesAuthority(pending.resume, identity)

    private fun resetResultAdvancesAuthority(
        resume: RelayV2TerminalOpenResume?,
        identity: RelayV2TerminalIdentity,
    ): Boolean = resume != null && identity.generation != resume.generation &&
        identity.resumeTokenCredentialFingerprint != resume.resumeTokenCredentialFingerprint

    private fun appendRequestId(
        issued: List<String>,
        requestId: String,
    ): List<String>? = if (
        validOperationId(requestId) && requestId !in issued &&
        issued.size < RelayV2TerminalCheckpointLimits.MAX_NETWORK_REQUEST_IDS
    ) {
        issued + requestId
    } else {
        null
    }

    private fun networkResponseCorrelation(
        requestId: String,
        currentRequestId: String?,
        issuedRequestIds: List<String>,
    ): NetworkResponseCorrelation = when {
        requestId == currentRequestId -> NetworkResponseCorrelation.CURRENT
        requestId in issuedRequestIds -> NetworkResponseCorrelation.ISSUED_OLD
        else -> NetworkResponseCorrelation.UNKNOWN
    }

    private fun mergeRequestIds(
        existing: List<String>,
        added: List<String>,
    ): List<String>? {
        val merged = existing + added.filterNot(existing::contains)
        return merged.takeIf {
            it.size <= RelayV2TerminalCheckpointLimits.MAX_NETWORK_REQUEST_IDS &&
                it.distinct().size == it.size
        }
    }

    private fun validRequestIdHistory(
        issued: List<String>,
        currentRequestId: String? = null,
        allowEmpty: Boolean = false,
    ): Boolean = (allowEmpty || issued.isNotEmpty()) &&
        issued.size <= RelayV2TerminalCheckpointLimits.MAX_NETWORK_REQUEST_IDS &&
        issued.all(::validOperationId) && issued.distinct().size == issued.size &&
        (currentRequestId == null || issued.lastOrNull() == currentRequestId)

    private fun dispositionMatches(
        mode: RelayV2TerminalOpenMode,
        disposition: RelayV2TerminalOpenDisposition,
    ): Boolean = when (mode) {
        RelayV2TerminalOpenMode.NEW -> disposition == RelayV2TerminalOpenDisposition.NEW
        RelayV2TerminalOpenMode.RESUME -> disposition == RelayV2TerminalOpenDisposition.RESUMED
        RelayV2TerminalOpenMode.RESET -> disposition == RelayV2TerminalOpenDisposition.RESET
    }

    private fun RelayV2TerminalAction.Opened.openResult():
        RelayV2TerminalOpenResultLineage = RelayV2TerminalOpenResultLineage(
        disposition = disposition,
        generation = identity.generation,
        hostInstanceId = identity.hostInstanceId,
        resumeTokenCredentialReference = identity.resumeTokenCredentialReference,
        resumeTokenCredentialFingerprint = identity.resumeTokenCredentialFingerprint,
        parserContinuityId = parserContinuityId,
        cols = cols,
        rows = rows,
        replayFromOffset = replayFromOffset,
        tailOffset = tailOffset,
    )

    private fun lineageMatches(
        lineage: RelayV2TerminalOpenResultLineage,
        action: RelayV2TerminalAction.Opened,
    ): Boolean = lineage == action.openResult() && action.identity.generation == lineage.generation &&
        action.identity.hostInstanceId == lineage.hostInstanceId &&
        action.identity.resumeTokenCredentialReference == lineage.resumeTokenCredentialReference &&
        action.identity.resumeTokenCredentialFingerprint ==
        lineage.resumeTokenCredentialFingerprint

    private fun RelayV2TerminalPendingOpen.sendOpen(
        checkpoint: RelayV2TerminalCheckpoint,
    ): RelayV2TerminalEffect.SendOpen = RelayV2TerminalEffect.SendOpen(
        openFence = RelayV2TerminalOpenFence(
            target,
            deliveryToken,
            openAttempt,
            parserContinuityId,
            mode,
            cols,
            rows,
            resume,
        ),
        requestId = requestId,
        mode = mode,
        cols = cols,
        rows = rows,
        resume = resume,
    )

    private fun RelayV2TerminalPendingOpen.sendOpen(
        checkpoint: RelayV2TerminalPreOpenCheckpoint,
    ): RelayV2TerminalEffect.SendOpen = RelayV2TerminalEffect.SendOpen(
        openFence = openFence(checkpoint, this),
        requestId = requestId,
        mode = mode,
        cols = cols,
        rows = rows,
        resume = resume,
    )

    private fun openFence(
        checkpoint: RelayV2TerminalPreOpenCheckpoint,
        pending: RelayV2TerminalPendingOpen,
    ): RelayV2TerminalOpenFence = RelayV2TerminalOpenFence(
        checkpoint.target,
        checkpoint.deliveryToken,
        pending.openAttempt,
        checkpoint.parserContinuityId,
        pending.mode,
        pending.cols,
        pending.rows,
        pending.resume,
    )

    private fun deliveryIsFreshOrSame(
        old: RelayV2TerminalDeliveryToken,
        new: RelayV2TerminalDeliveryToken,
    ): Boolean = old == new || deliveryIsStrictlyFresher(old, new)

    private fun deliveryIsStrictlyFresher(
        old: RelayV2TerminalDeliveryToken,
        new: RelayV2TerminalDeliveryToken,
    ): Boolean {
        if (old.actorGeneration.profileId != new.actorGeneration.profileId) return false
        if (old.actorGeneration.profileGeneration != new.actorGeneration.profileGeneration) {
            return false
        }
        return when {
            new.authorityGeneration > old.authorityGeneration -> true
            new.authorityGeneration < old.authorityGeneration -> false
            new.actorGeneration.connectionGeneration > old.actorGeneration.connectionGeneration -> true
            new.actorGeneration.connectionGeneration < old.actorGeneration.connectionGeneration -> false
            else -> new.localDispatchToken > old.localDispatchToken
        }
    }

    private fun rebindStoredFences(
        current: RelayV2TerminalCheckpoint,
        identity: RelayV2TerminalIdentity,
        deliveryToken: RelayV2TerminalDeliveryToken,
    ): RelayV2TerminalCheckpoint {
        fun rebind(
            token: RelayV2TerminalParserCallbackToken,
        ): RelayV2TerminalParserCallbackToken = token.copy(
            fence = RelayV2TerminalEffectFence(identity, deliveryToken, current.openAttempt),
        )
        return current.copy(
            identity = identity,
            deliveryToken = deliveryToken,
            parserResetCallbackToken = current.parserResetCallbackToken?.let(::rebind),
            parserInFlightCallbackToken = current.parserInFlightCallbackToken?.let(::rebind),
            lastAppliedParserCallbackToken = null,
            pendingParserEffectHandoff = current.pendingParserEffectHandoff?.let(::rebind),
            pendingParserEffectActivation = current.pendingParserEffectActivation?.let {
                it.copy(callbackToken = rebind(it.callbackToken))
            },
            pendingOutput = current.pendingOutput.map {
                it.copy(callbackToken = rebind(it.callbackToken))
            },
            pendingOpen = current.pendingOpen?.copy(
                deliveryToken = deliveryToken,
            ),
            pendingReplay = current.pendingReplay?.copy(
                fence = RelayV2TerminalEffectFence(identity, deliveryToken, current.openAttempt),
            ),
            pendingInputs = current.pendingInputs.map { it.copy(dispatchClaim = null) },
            pendingResizes = current.pendingResizes.map { it.copy(dispatchClaim = null) },
            activeControlDispatchLease = current.activeControlDispatchLease?.let {
                RelayV2TerminalControlDispatchLease(
                    RelayV2TerminalEffectFence(identity, deliveryToken, current.openAttempt),
                )
            },
        )
    }

    private fun effectFence(
        checkpoint: RelayV2TerminalCheckpoint,
    ): RelayV2TerminalEffectFence = RelayV2TerminalEffectFence(
        checkpoint.identity,
        checkpoint.deliveryToken,
        checkpoint.openAttempt,
    )

    private fun actionFence(
        checkpoint: RelayV2TerminalCheckpoint,
    ): RelayV2TerminalActionFence = RelayV2TerminalActionFence(
        checkpoint.identity.binding(),
        checkpoint.deliveryToken,
        checkpoint.openAttempt.openId,
    )

    private fun RelayV2TerminalCheckpoint.controlDispatchLeaseWhenWritable():
        RelayV2TerminalControlDispatchLease? = if (terminalWritable(this)) {
        RelayV2TerminalControlDispatchLease(effectFence(this))
    } else {
        null
    }

    private fun RelayV2TerminalClosedTombstone.finalizeEffect(
        checkpoint: RelayV2TerminalCheckpoint,
    ): RelayV2TerminalEffect.FinalizeClosed = RelayV2TerminalEffect.FinalizeClosed(
        effectFence(checkpoint),
        checkpoint.identity.generation,
        finalOffset,
        reason,
        exitCode,
    )

    private fun RelayV2TerminalPendingClose.sendEffect(
        checkpoint: RelayV2TerminalCheckpoint,
    ): RelayV2TerminalEffect.SendClose = RelayV2TerminalEffect.SendClose(
        effectFence(checkpoint),
        checkpoint.identity.generation,
        closeAttempt.closeId,
        requestId,
        checkpoint.identity.resumeTokenCredentialReference,
    )

    private fun RelayV2TerminalPendingClose.deliveryEffect(
        checkpoint: RelayV2TerminalCheckpoint,
    ): RelayV2TerminalEffect = if (checkpoint.closed == null) {
        sendEffect(checkpoint)
    } else {
        RelayV2TerminalEffect.QueryCloseCorrelation(
            effectFence(checkpoint),
            checkpoint.identity.generation,
            closeAttempt.closeId,
            requestId,
        )
    }

    private fun closedResponseCorrelation(
        checkpoint: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.Closed,
    ): ClosedResponseCorrelation {
        val requestId = action.requestId
        if (requestId == null) {
            if (action.closeId != null) {
                return ClosedResponseCorrelation.Rejected(
                    reset(checkpoint, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT),
                )
            }
            val guarded = fenceGuard(checkpoint, action.fence)
            return if (guarded == null) {
                ClosedResponseCorrelation.Natural
            } else {
                ClosedResponseCorrelation.Rejected(guarded)
            }
        }
        val pending = checkpoint.pendingClose
        return when (networkResponseCorrelation(
            requestId,
            pending?.requestId,
            checkpoint.closeRequestIds,
        )) {
            NetworkResponseCorrelation.ISSUED_OLD -> ClosedResponseCorrelation.Rejected(
                reduction(
                    checkpoint,
                    RelayV2TerminalOutcome.Ignored(
                        RelayV2TerminalIgnoredReason.STALE_CLOSE_RESPONSE,
                    ),
                ),
            )
            NetworkResponseCorrelation.UNKNOWN -> ClosedResponseCorrelation.Rejected(
                reset(checkpoint, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT),
            )
            NetworkResponseCorrelation.CURRENT -> {
                if (pending == null || action.closeId != pending.closeAttempt.closeId ||
                    action.fence != actionFence(checkpoint)
                ) {
                    ClosedResponseCorrelation.Rejected(
                        reset(
                            checkpoint,
                            RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT,
                        ),
                    )
                } else {
                    ClosedResponseCorrelation.Current(pending.closeAttempt)
                }
            }
        }
    }

    private fun closedTombstone(
        checkpoint: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.Closed,
        closeAttempt: RelayV2TerminalCloseAttempt?,
    ): RelayV2TerminalClosedTombstone = RelayV2TerminalClosedTombstone(
        finalOffset = action.finalOffset,
        reason = action.reason,
        exitCode = action.exitCode,
        closeAttempt = closeAttempt,
        generation = checkpoint.identity.generation,
        openId = checkpoint.openAttempt.openId,
    )

    private fun retainedBufferCovers(
        retained: RelayV2TerminalRetainedBuffer,
        offset: BigInteger,
    ): Boolean = retained.replayAvailable &&
        retained.bufferStartOffset?.let(::parseCounter)?.let { it <= offset } == true

    private fun retainedBufferCanAdvance(
        old: RelayV2TerminalRetainedBuffer,
        new: RelayV2TerminalRetainedBuffer,
    ): Boolean {
        if (!old.replayAvailable) return !new.replayAvailable && new.bufferStartOffset == null
        if (!new.replayAvailable) return new.bufferStartOffset == null
        val oldStart = old.bufferStartOffset?.let(::parseCounter) ?: return false
        val newStart = new.bufferStartOffset?.let(::parseCounter) ?: return false
        return newStart >= oldStart
    }

    private fun validCloseTombstone(tombstone: RelayV2TerminalClosedTombstone): Boolean =
        when (tombstone.reason) {
            RelayV2TerminalCloseReason.CLIENT_CLOSED ->
                tombstone.exitCode == null && tombstone.closeAttempt != null
            RelayV2TerminalCloseReason.BACKEND_EXIT -> tombstone.exitCode != null
            RelayV2TerminalCloseReason.BACKEND_ERROR -> true
        }

    private fun validClose(action: RelayV2TerminalAction.Closed): Boolean {
        if ((action.closeId == null) != (action.requestId == null) ||
            action.requestId?.let(::validOperationId) == false
        ) {
            return false
        }
        return when (action.reason) {
            RelayV2TerminalCloseReason.CLIENT_CLOSED ->
                action.exitCode == null && action.closeId != null
            RelayV2TerminalCloseReason.BACKEND_EXIT -> action.exitCode != null
            RelayV2TerminalCloseReason.BACKEND_ERROR -> true
        }
    }

    private fun terminalWritable(checkpoint: RelayV2TerminalCheckpoint): Boolean =
        checkpoint.closed == null && checkpoint.pendingClose == null && checkpoint.phase in setOf(
            RelayV2TerminalPhase.LIVE,
            RelayV2TerminalPhase.REPLAYING,
            RelayV2TerminalPhase.REPLAY_REQUESTED,
        )

    private fun canDispatchParser(checkpoint: RelayV2TerminalCheckpoint): Boolean =
        checkpoint.parserResetCallbackToken == null && checkpoint.phase in setOf(
            RelayV2TerminalPhase.LIVE,
            RelayV2TerminalPhase.REPLAYING,
            RelayV2TerminalPhase.REPLAY_REQUESTED,
            RelayV2TerminalPhase.CLOSED_WAITING_PARSER,
        )

    private fun sameResetTarget(
        old: RelayV2TerminalIdentity,
        new: RelayV2TerminalIdentity,
    ): Boolean = old.copy(
        hostInstanceId = new.hostInstanceId,
        generation = new.generation,
        resumeTokenCredentialReference = new.resumeTokenCredentialReference,
        resumeTokenCredentialFingerprint = new.resumeTokenCredentialFingerprint,
    ) == new

    private fun identityChangeReason(
        old: RelayV2TerminalIdentity,
        new: RelayV2TerminalIdentity,
    ): RelayV2TerminalResetReason = when {
        old.hostInstanceId != new.hostInstanceId -> RelayV2TerminalResetReason.STREAM_LOST
        old.generation != new.generation -> RelayV2TerminalResetReason.GENERATION_STALE
        old.identityVersion != new.identityVersion -> RelayV2TerminalResetReason.SCHEMA_INCOMPATIBLE
        else -> RelayV2TerminalResetReason.IDENTITY_CHANGED
    }

    private fun validParserContinuity(value: String): Boolean =
        value.isNotBlank() &&
            value.toByteArray(Charsets.UTF_8).size <=
            RelayV2TerminalCheckpointLimits.MAX_ID_UTF8_BYTES &&
            '\u0000' !in value

    private fun parseCounter(value: String): BigInteger? {
        if (!COUNTER_PATTERN.matches(value)) return null
        val parsed = runCatching { BigInteger(value) }.getOrNull() ?: return null
        return parsed.takeIf { it <= UNSIGNED_COUNTER_MAX }
    }

    private fun parsePositiveCounter(value: String): BigInteger? =
        parseCounter(value)?.takeIf { it > ZERO }

    private fun addCounter(value: BigInteger, increment: Int): BigInteger? =
        (value + BigInteger.valueOf(increment.toLong())).takeIf { it <= UNSIGNED_COUNTER_MAX }

    private fun incrementCounter(value: BigInteger): BigInteger? =
        (value + ONE).takeIf { it <= UNSIGNED_COUNTER_MAX }

    private fun resetClosedRecovery(
        current: RelayV2TerminalCheckpoint,
        reason: RelayV2TerminalResetReason,
    ): ClosedRecovery {
        val reset = markResetRequired(current, reason)
        return ClosedRecovery(
            reset,
            listOf(
                RelayV2TerminalEffect.ResetRequired(
                    effectFence(current),
                    reason,
                    current.parserAppliedNextOffset,
                ),
            ) + ambiguousEffect(current, reset),
        )
    }

    private sealed interface InputAckApply {
        data class Applied(val checkpoint: RelayV2TerminalCheckpoint) : InputAckApply
        data object Duplicate : InputAckApply
        data object Rejected : InputAckApply
    }

    private sealed interface ResizeAckApply {
        data class Applied(val checkpoint: RelayV2TerminalCheckpoint) : ResizeAckApply
        data object Duplicate : ResizeAckApply
        data object Rejected : ResizeAckApply
    }

    private sealed interface ClosedResponseCorrelation {
        data object Natural : ClosedResponseCorrelation
        data class Current(
            val closeAttempt: RelayV2TerminalCloseAttempt,
        ) : ClosedResponseCorrelation
        data class Rejected(
            val reduction: RelayV2TerminalReduction,
        ) : ClosedResponseCorrelation
    }

    private enum class NetworkResponseCorrelation {
        CURRENT,
        ISSUED_OLD,
        UNKNOWN,
    }

    private data class ParserOperation(val id: String, val next: String)

    private data class ClosedRecovery(
        val checkpoint: RelayV2TerminalCheckpoint,
        val effects: List<RelayV2TerminalEffect>,
    )

    private enum class CheckpointValidity {
        VALID,
        INVALID,
        LIMIT_EXCEEDED,
        OFFSET_EXPIRED,
        SCHEMA_INCOMPATIBLE,
    }

    private val COUNTER_PATTERN = Regex("^(?:0|[1-9][0-9]*)$")
    private val ZERO = BigInteger.ZERO
    private val ONE = BigInteger.ONE
    private val UNSIGNED_COUNTER_MAX = BigInteger("18446744073709551615")
}
