package com.tmuxworktree.mobile.core.relay.v2.terminal

import java.math.BigInteger

/**
 * Deterministic Android-free authority for a Relay v2 terminal parser checkpoint.
 *
 * Network receipt only appends to [RelayV2TerminalCheckpoint.pendingOutput]. The durable parser
 * watermark and output credit move only through [RelayV2TerminalAction.ParserApplied].
 */
internal object RelayV2TerminalCheckpointReducer {
    fun restore(
        stored: RelayV2TerminalStoredCheckpoint,
        expectedIdentity: RelayV2TerminalIdentity,
        expectedOpenAttempt: RelayV2TerminalOpenAttempt,
        currentDeliveryToken: RelayV2TerminalDeliveryToken,
        currentParserContinuityId: String?,
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
        is RelayV2TerminalStoredCheckpoint.Present -> {
            val checkpoint = snapshotCheckpoint(stored.checkpoint)
            when {
                checkpoint.schemaVersion != RelayV2TerminalCheckpointLimits.SCHEMA_VERSION ||
                    checkpoint.identity.identityVersion !=
                    RelayV2TerminalCheckpointLimits.IDENTITY_VERSION -> missingReset(
                    expectedIdentity,
                    RelayV2TerminalResetReason.SCHEMA_INCOMPATIBLE,
                    currentDeliveryToken,
                    expectedOpenAttempt,
                )
                validateCheckpoint(checkpoint) == CheckpointValidity.LIMIT_EXCEEDED -> missingReset(
                    expectedIdentity,
                    RelayV2TerminalResetReason.CHECKPOINT_LIMIT_EXCEEDED,
                    currentDeliveryToken,
                    expectedOpenAttempt,
                )
                validateCheckpoint(checkpoint) != CheckpointValidity.VALID -> missingReset(
                    expectedIdentity,
                    RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                    currentDeliveryToken,
                    expectedOpenAttempt,
                )
                checkpoint.identity != expectedIdentity -> reset(
                    checkpoint,
                    identityChangeReason(checkpoint.identity, expectedIdentity),
                )
                checkpoint.openAttempt != expectedOpenAttempt -> reset(
                    checkpoint,
                    RelayV2TerminalResetReason.IDENTITY_CHANGED,
                )
                currentParserContinuityId.isNullOrBlank() ||
                    checkpoint.parserContinuityId != currentParserContinuityId -> reset(
                    checkpoint,
                    RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST,
                )
                checkpoint.deliveryToken != currentDeliveryToken -> reduction(
                    checkpoint,
                    RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_DELIVERY),
                )
                checkpoint.phase == RelayV2TerminalPhase.RESET_REQUIRED -> reduction(
                    checkpoint,
                    RelayV2TerminalOutcome.ResetRequired(
                        checkpoint.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                    ),
                    RelayV2TerminalEffect.ResetRequired(
                        effectFence(checkpoint),
                        checkpoint.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                        checkpoint.parserAppliedNextOffset,
                    ),
                )
                else -> reduction(checkpoint, RelayV2TerminalOutcome.Restored)
            }
        }
    }

    fun reduce(
        checkpoint: RelayV2TerminalCheckpoint?,
        action: RelayV2TerminalAction,
    ): RelayV2TerminalReduction {
        if (action is RelayV2TerminalAction.Opened) return opened(checkpoint, action)
        val current = checkpoint ?: return missingReset(null, RelayV2TerminalResetReason.MISSING_CHECKPOINT)
        if (action is RelayV2TerminalAction.BeginOpenAttempt) {
            return beginOpenAttempt(current, action)
        }
        if (current.phase == RelayV2TerminalPhase.FINALIZED) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.FINALIZED_LATE_EVENT),
            )
        }
        actionGuard(current, action)?.let { return it }
        if (current.phase == RelayV2TerminalPhase.RESET_REQUIRED &&
            action !is RelayV2TerminalAction.VerifyContinuity &&
            action !is RelayV2TerminalAction.RebindDelivery
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
            is RelayV2TerminalAction.ParserApplied -> parserApplied(current, action)
            is RelayV2TerminalAction.ParserFailed -> parserFailed(current, action)
            is RelayV2TerminalAction.ParserResetApplied -> parserResetApplied(current, action)
            is RelayV2TerminalAction.EnqueueInput -> enqueueInput(current, action)
            is RelayV2TerminalAction.InputSent -> inputSent(current, action)
            is RelayV2TerminalAction.InputAck -> inputAck(current, action)
            is RelayV2TerminalAction.InputError -> inputError(current, action)
            is RelayV2TerminalAction.EnqueueResize -> enqueueResize(current, action)
            is RelayV2TerminalAction.ResizeSent -> resizeSent(current, action)
            is RelayV2TerminalAction.ResizeAck -> resizeAck(current, action)
            is RelayV2TerminalAction.ResizeError -> resizeError(current, action)
            is RelayV2TerminalAction.RetryUnackedControls -> retryUnacked(current, action)
            is RelayV2TerminalAction.RequestClose -> requestClose(current, action)
            is RelayV2TerminalAction.Closed -> closed(current, action)
            is RelayV2TerminalAction.CorrelatedResetRequired ->
                correlatedResetRequired(current, action)
            is RelayV2TerminalAction.AsyncResetRequired -> asyncResetRequired(current, action)
        }
    }

    private fun beginOpenAttempt(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.BeginOpenAttempt,
    ): RelayV2TerminalReduction {
        deliveryGuard(current, action.deliveryToken)?.let { return it }
        if (!validOperationId(action.requestId)) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        if (action.openAttempt.openId == current.openAttempt.openId &&
            action.openAttempt != current.openAttempt
        ) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        current.pendingOpen?.let { pending ->
            if (pending == RelayV2TerminalPendingOpen(
                    action.requestId,
                    action.deliveryToken,
                    action.openAttempt,
                )
            ) {
                return reduction(current, RelayV2TerminalOutcome.Applied)
            }
            if (pending.openAttempt.openId == action.openAttempt.openId &&
                pending.openAttempt != action.openAttempt
            ) {
                return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
            }
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        if (current.pendingOutput.isNotEmpty() || current.parserInFlightCallbackToken != null ||
            current.parserResetCallbackToken != null
        ) {
            return reset(current, RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST)
        }
        return commit(
            current,
            current.copy(
                pendingOpen = RelayV2TerminalPendingOpen(
                    action.requestId,
                    action.deliveryToken,
                    action.openAttempt,
                ),
            ),
            RelayV2TerminalOutcome.Applied,
        )
    }

    private fun closedWhileResetRequired(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.Closed,
    ): RelayV2TerminalReduction {
        fenceGuard(current, action.fence)?.let { return it }
        val finalOffset = parseCounter(action.finalOffset)
        val bufferStart = action.bufferStartOffset?.let(::parseCounter)
        if (action.fence.openId != current.openAttempt.openId ||
            !validClose(action) || finalOffset == null ||
            (action.replayAvailable && (bufferStart == null || bufferStart > finalOffset)) ||
            (!action.replayAvailable && action.bufferStartOffset != null)
        ) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        val correlatedCloseAttempt = action.closeId?.let { closeId ->
            current.pendingClose?.closeAttempt?.takeIf { it.closeId == closeId }
                ?: return reduction(
                    current,
                    RelayV2TerminalOutcome.Ignored(
                        RelayV2TerminalIgnoredReason.STALE_CLOSE_RESPONSE,
                    ),
                )
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
        previous: RelayV2TerminalCheckpoint?,
        action: RelayV2TerminalAction.Opened,
    ): RelayV2TerminalReduction {
        if (previous != null) {
            deliveryGuard(previous, action.deliveryToken)?.let { return it }
        }
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
            return previous?.let {
                reset(it, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
            } ?: missingReset(
                action.identity,
                RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                action.deliveryToken,
                action.openAttempt,
            )
        }

        if (previous == null) {
            if (action.disposition == RelayV2TerminalOpenDisposition.RESUMED) {
                return missingReset(
                    action.identity,
                    RelayV2TerminalResetReason.MISSING_CHECKPOINT,
                    action.deliveryToken,
                    action.openAttempt,
                )
            }
            if (from != ZERO || tail != ZERO) {
                return missingReset(
                    action.identity,
                    RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                    action.deliveryToken,
                    action.openAttempt,
                )
            }
            return newGenerationCheckpoint(action, emptyList())
        }

        val pendingOpen = previous.pendingOpen
        if (pendingOpen == null || pendingOpen.requestId != action.requestId ||
            pendingOpen.deliveryToken != action.deliveryToken ||
            pendingOpen.openAttempt != action.openAttempt
        ) {
            if ((pendingOpen?.openAttempt?.openId == action.openAttempt.openId &&
                    pendingOpen.openAttempt != action.openAttempt) ||
                (previous.openAttempt.openId == action.openAttempt.openId &&
                    previous.openAttempt != action.openAttempt)
            ) {
                return reset(previous, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
            }
            return reduction(
                previous,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_OPEN_RESPONSE),
            )
        }

        if (previous.identity.hostInstanceId != action.identity.hostInstanceId) {
            return reset(previous, RelayV2TerminalResetReason.STREAM_LOST)
        }
        if (previous.parserContinuityId != action.parserContinuityId) {
            return reset(previous, RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST)
        }
        if (previous.identity.generation != action.identity.generation) {
            if (action.disposition != RelayV2TerminalOpenDisposition.RESET ||
                !sameResetTarget(previous.identity, action.identity) ||
                from != ZERO || tail != ZERO
            ) {
                return reset(previous, RelayV2TerminalResetReason.GENERATION_STALE)
            }
            val ambiguousInputs = previous.ambiguousInputs + previous.pendingInputs.map {
                RelayV2AmbiguousInput(it.generation, it.inputSeq, it.bytes)
            }
            return newGenerationCheckpoint(action, ambiguousInputs)
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
            from != parseCounter(previous.parserAppliedNextOffset) ||
            action.cols != previous.openedCols || action.rows != previous.openedRows
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
        if (knownFinal != null && tail < knownFinal) {
            return reset(previous, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        var candidate = previous.copy(
            openAttempt = action.openAttempt,
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
            closed = previous.closed?.copy(
                tombstone = previous.closed.tombstone.copy(
                    openId = action.openAttempt.openId,
                ),
            ),
            resetReason = null,
        )
        val recovered = recoverClosed(candidate)
        candidate = recovered.checkpoint
        val resumeEffects = recovered.effects + candidate.pendingClose?.takeIf {
            candidate.closed == null
        }?.let {
            listOf(it.sendEffect(candidate))
        }.orEmpty()
        return commit(
            previous,
            candidate,
            if (candidate.phase == RelayV2TerminalPhase.FINALIZED) {
                RelayV2TerminalOutcome.ClosedFinalized
            } else {
                RelayV2TerminalOutcome.Applied
            },
            resumeEffects,
        )
    }

    private fun newGenerationCheckpoint(
        action: RelayV2TerminalAction.Opened,
        ambiguousInputs: List<RelayV2AmbiguousInput>,
    ): RelayV2TerminalReduction {
        val resetting = action.disposition == RelayV2TerminalOpenDisposition.RESET
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
            deliveryToken = action.deliveryToken,
            parserContinuityId = action.parserContinuityId,
            phase = if (resetting) {
                RelayV2TerminalPhase.RESETTING_PARSER
            } else {
                RelayV2TerminalPhase.LIVE
            },
            openedCols = action.cols,
            openedRows = action.rows,
            parserAppliedNextOffset = "0",
            networkReceivedThrough = "0",
            nextParserOperationSeq = if (resetting) "2" else "1",
            nextReplayRequestSeq = "1",
            parserResetCallbackToken = resetCallbackToken,
            ambiguousInputs = ambiguousInputs.toList(),
        )
        val effects = buildList {
            if (ambiguousInputs.isNotEmpty()) {
                add(
                    RelayV2TerminalEffect.ControlsBecameAmbiguous(
                        fence,
                        ambiguousInputs.size,
                    ),
                )
            }
            resetCallbackToken?.let {
                add(RelayV2TerminalEffect.ResetParser(it))
            }
        }
        return commit(
            null,
            checkpoint,
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
            action.newDeliveryToken.actorGeneration.connectionGeneration <
            current.deliveryToken.actorGeneration.connectionGeneration ||
            action.newDeliveryToken.localDispatchToken <=
            current.deliveryToken.localDispatchToken
        ) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_DELIVERY),
            )
        }
        if (current.phase != RelayV2TerminalPhase.RESET_REQUIRED &&
            (current.pendingOutput.isNotEmpty() ||
            current.parserInFlightCallbackToken != null ||
            current.parserResetCallbackToken != null)
        ) {
            return reset(current, RelayV2TerminalResetReason.PARSER_CONTINUITY_LOST)
        }
        var candidate = current.copy(
            deliveryToken = action.newDeliveryToken,
            pendingOpen = current.pendingOpen?.copy(deliveryToken = action.newDeliveryToken),
        )
        candidate = candidate.copy(
            pendingReplay = candidate.pendingReplay?.copy(fence = effectFence(candidate)),
        )
        val effects = buildList<RelayV2TerminalEffect> {
            candidate.pendingClose?.takeIf { candidate.closed == null }
                ?.let { add(it.sendEffect(candidate)) }
            if (candidate.phase == RelayV2TerminalPhase.RESET_REQUIRED) {
                add(
                    RelayV2TerminalEffect.ResetRequired(
                        effectFence(candidate),
                        candidate.resetReason ?: RelayV2TerminalResetReason.CHECKPOINT_INVALID,
                        candidate.parserAppliedNextOffset,
                    ),
                )
            } else {
                candidate.pendingReplay?.let {
                    add(
                        RelayV2TerminalEffect.RequestReplay(
                            it.fence,
                            it.requestId,
                            candidate.identity.generation,
                            it.fromOffset,
                        ),
                    )
                }
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
        if (action.identity != current.identity) {
            return reset(current, identityChangeReason(current.identity, action.identity))
        }
        if (action.openId != current.openAttempt.openId) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_DELIVERY),
            )
        }
        deliveryGuard(current, action.deliveryToken)?.let { return it }
        if (current.phase != RelayV2TerminalPhase.REPLAY_REQUESTED) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        val from = parseCounter(action.fromOffset)
        val tail = parseCounter(action.tailOffsetAtStart)
        val expected = parseCounter(current.networkReceivedThrough)
        val pendingReplay = current.pendingReplay
        if (from == null || tail == null || expected == null || from != expected || tail < from ||
            pendingReplay == null || action.requestId != pendingReplay.requestId ||
            action.fromOffset != pendingReplay.fromOffset ||
            pendingReplay.fence != effectFence(current)
        ) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        val finalOffset = current.closed?.tombstone?.finalOffset?.let(::parseCounter)
        if (finalOffset != null && tail > finalOffset) {
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
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

    private fun parserApplied(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ParserApplied,
    ): RelayV2TerminalReduction {
        parserCallbackGuard(current, action.callbackToken)?.let { return it }
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
        if (action.callbackToken == current.lastAppliedParserCallbackToken) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.DUPLICATE_PARSER_CALLBACK,
                ),
            )
        }
        val head = current.pendingOutput.firstOrNull()
        if (head == null || action.callbackToken != current.parserInFlightCallbackToken ||
            action.callbackToken != head.callbackToken
        ) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.OUT_OF_ORDER_PARSER_CALLBACK,
                ),
            )
        }
        if (head.callbackToken.startOffset != current.parserAppliedNextOffset) {
            return reset(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        }
        val next = parseCounter(head.callbackToken.endOffset)
            ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        if (addCounter(
                parseCounter(head.callbackToken.startOffset)
                    ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID),
                head.bytes.size,
            ) != next
        ) {
            return reset(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
        }

        var candidate = current.copy(
            parserAppliedNextOffset = next.toString(),
            parserInFlightCallbackToken = null,
            lastAppliedParserCallbackToken = action.callbackToken,
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
                ?: return reset(current, RelayV2TerminalResetReason.CHECKPOINT_INVALID)
            when {
                next > target -> return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
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
        return commit(current, candidate, outcome, effects)
    }

    private fun parserFailed(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ParserFailed,
    ): RelayV2TerminalReduction {
        parserCallbackGuard(current, action.callbackToken)?.let { return it }
        if (current.phase == RelayV2TerminalPhase.FINALIZED) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.FINALIZED_LATE_EVENT),
            )
        }
        if (action.callbackToken != current.parserInFlightCallbackToken &&
            action.callbackToken != current.parserResetCallbackToken
        ) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(
                    RelayV2TerminalIgnoredReason.OUT_OF_ORDER_PARSER_CALLBACK,
                ),
            )
        }
        return reset(current, RelayV2TerminalResetReason.PARSER_FAILURE)
    }

    private fun parserResetApplied(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.ParserResetApplied,
    ): RelayV2TerminalReduction {
        parserCallbackGuard(current, action.callbackToken)?.let { return it }
        if (current.phase == RelayV2TerminalPhase.FINALIZED) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.FINALIZED_LATE_EVENT),
            )
        }
        if (action.callbackToken != current.parserResetCallbackToken) {
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
            lastAppliedParserCallbackToken = action.callbackToken,
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
                    effectFence(current),
                    current.identity.generation,
                    seq.toString(),
                    action.bytes,
                ),
            ),
        )
    }

    private fun inputSent(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.InputSent,
    ): RelayV2TerminalReduction {
        fenceGuard(current, action.fence)?.let { return it }
        val seq = parsePositiveCounter(action.inputSeq)
            ?: return controlRejected(
                current,
                RelayV2TerminalControlKind.INPUT,
                RelayV2TerminalControlRejectionReason.GAP,
                action.inputSeq,
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
                action.inputSeq,
                current.ackedThroughInputSeq,
            )
        }
        val existing = current.pendingInputs[index]
        if (existing.disposition == RelayV2TerminalControlDisposition.SENT) {
            return reduction(current, RelayV2TerminalOutcome.Applied)
        }
        val updated = current.pendingInputs.toMutableList().also {
            it[index] = existing.copy(disposition = RelayV2TerminalControlDisposition.SENT)
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
            RelayV2TerminalControlError.GAP -> reduction(
                acked,
                RelayV2TerminalOutcome.ControlRejected(
                    RelayV2TerminalControlKind.INPUT,
                    RelayV2TerminalControlRejectionReason.GAP,
                    action.inputSeq,
                    action.ackedThroughInputSeq,
                ),
                acked.pendingInputs.map {
                    RelayV2TerminalEffect.SendInput(
                        effectFence(acked),
                        it.generation,
                        it.inputSeq,
                        it.bytes,
                    )
                },
            )
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
                    effectFence(current),
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
        fenceGuard(current, action.fence)?.let { return it }
        val seq = parsePositiveCounter(action.resizeSeq)
            ?: return resizeGap(current, action.resizeSeq)
        val index = current.pendingResizes.indexOfFirst { parseCounter(it.resizeSeq) == seq }
        if (index < 0 || current.pendingResizes.take(index).any {
                it.disposition != RelayV2TerminalControlDisposition.SENT
            }
        ) {
            return resizeGap(current, action.resizeSeq)
        }
        val existing = current.pendingResizes[index]
        if (existing.disposition == RelayV2TerminalControlDisposition.SENT) {
            return reduction(current, RelayV2TerminalOutcome.Applied)
        }
        val updated = current.pendingResizes.toMutableList().also {
            it[index] = existing.copy(disposition = RelayV2TerminalControlDisposition.SENT)
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
            RelayV2TerminalControlError.GAP -> reduction(
                acked,
                RelayV2TerminalOutcome.ControlRejected(
                    RelayV2TerminalControlKind.RESIZE,
                    RelayV2TerminalControlRejectionReason.GAP,
                    action.resizeSeq,
                    action.ackedThroughResizeSeq,
                ),
                acked.pendingResizes.map {
                    RelayV2TerminalEffect.SendResize(
                        effectFence(acked),
                        it.generation,
                        it.resizeSeq,
                        it.cols,
                        it.rows,
                    )
                },
            )
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
        val effects = buildList<RelayV2TerminalEffect> {
            current.pendingInputs.forEach {
                add(
                    RelayV2TerminalEffect.SendInput(
                        effectFence(current),
                        it.generation,
                        it.inputSeq,
                        it.bytes,
                    ),
                )
            }
            current.pendingResizes.forEach {
                add(
                    RelayV2TerminalEffect.SendResize(
                        effectFence(current),
                        it.generation,
                        it.resizeSeq,
                        it.cols,
                        it.rows,
                    ),
                )
            }
        }
        return reduction(current, RelayV2TerminalOutcome.Applied, effects)
    }

    private fun requestClose(
        current: RelayV2TerminalCheckpoint,
        action: RelayV2TerminalAction.RequestClose,
    ): RelayV2TerminalReduction {
        deliveryGuard(current, action.deliveryToken)?.let { return it }
        if (current.closed != null) {
            return reduction(current, RelayV2TerminalOutcome.Applied)
        }
        current.pendingClose?.let { pending ->
            if (pending.closeAttempt == action.closeAttempt) {
                return reduction(
                    current,
                    RelayV2TerminalOutcome.Applied,
                    pending.sendEffect(current),
                )
            }
            if (pending.closeAttempt.closeId == action.closeAttempt.closeId) {
                return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
            }
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        val pending = RelayV2TerminalPendingClose(action.closeAttempt)
        return commit(
            current,
            current.copy(pendingClose = pending),
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
        if (action.fence.openId != current.openAttempt.openId) {
            return reset(current, RelayV2TerminalResetReason.IDENTITY_CHANGED)
        }
        val correlatedCloseAttempt = action.closeId?.let { closeId ->
            val pending = current.pendingClose?.closeAttempt
            if (pending == null || pending.closeId != closeId) {
                return reduction(
                    current,
                    RelayV2TerminalOutcome.Ignored(
                        RelayV2TerminalIgnoredReason.STALE_CLOSE_RESPONSE,
                    ),
                )
            }
            pending
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
        val matchesPending = when (action.origin) {
            RelayV2TerminalResetOrigin.OPEN -> current.pendingOpen?.let {
                it.requestId == action.requestId && it.deliveryToken == action.fence.deliveryToken &&
                    it.openAttempt == action.openAttempt
            } == true
            RelayV2TerminalResetOrigin.REPLAY -> current.pendingReplay?.let {
                it.requestId == action.requestId && it.fence == effectFence(current)
            } == true && action.openAttempt == null
        }
        if (!matchesPending) {
            return reduction(
                current,
                RelayV2TerminalOutcome.Ignored(RelayV2TerminalIgnoredReason.STALE_RESET_RESPONSE),
            )
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
            return reset(current, RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT)
        }
        val reason = when (resetReason) {
            RelayV2TerminalResetReason.SLOW_CONSUMER,
            RelayV2TerminalResetReason.HOST_BUFFER_PRESSURE,
            RelayV2TerminalResetReason.GENERATION_STALE,
            RelayV2TerminalResetReason.OFFSET_EXPIRED,
            RelayV2TerminalResetReason.STREAM_LOST,
            -> resetReason
            else -> RelayV2TerminalResetReason.PROTOCOL_ORDER_CONFLICT
        }
        return reset(current, reason)
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
        val candidate = current.copy(
            phase = RelayV2TerminalPhase.REPLAY_REQUESTED,
            nextReplayRequestSeq = next.toString(),
            pendingReplay = RelayV2TerminalPendingReplay(requestId, fence, fromOffset),
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
        is RelayV2TerminalAction.VerifyContinuity,
        -> null
        is RelayV2TerminalAction.RebindDelivery ->
            deliveryGuard(current, action.currentDeliveryToken)
        is RelayV2TerminalAction.Output -> fenceGuard(current, action.fence)
        is RelayV2TerminalAction.ReplayStarted ->
            deliveryGuard(current, action.deliveryToken)
        is RelayV2TerminalAction.ParserApplied ->
            parserCallbackGuard(current, action.callbackToken)
        is RelayV2TerminalAction.ParserFailed ->
            parserCallbackGuard(current, action.callbackToken)
        is RelayV2TerminalAction.ParserResetApplied ->
            parserCallbackGuard(current, action.callbackToken)
        is RelayV2TerminalAction.EnqueueInput -> deliveryGuard(current, action.deliveryToken)
        is RelayV2TerminalAction.InputSent -> fenceGuard(current, action.fence)
        is RelayV2TerminalAction.InputAck -> fenceGuard(current, action.fence)
        is RelayV2TerminalAction.InputError -> fenceGuard(current, action.fence)
        is RelayV2TerminalAction.EnqueueResize -> deliveryGuard(current, action.deliveryToken)
        is RelayV2TerminalAction.ResizeSent -> fenceGuard(current, action.fence)
        is RelayV2TerminalAction.ResizeAck -> fenceGuard(current, action.fence)
        is RelayV2TerminalAction.ResizeError -> fenceGuard(current, action.fence)
        is RelayV2TerminalAction.RetryUnackedControls ->
            deliveryGuard(current, action.deliveryToken)
        is RelayV2TerminalAction.RequestClose -> deliveryGuard(current, action.deliveryToken)
        is RelayV2TerminalAction.Closed -> fenceGuard(current, action.fence)
        is RelayV2TerminalAction.CorrelatedResetRequired -> fenceGuard(current, action.fence)
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
        parserResetCallbackToken = null,
        parserInFlightCallbackToken = null,
        pendingReplay = null,
        replayTargetOffset = null,
        pendingInputs = emptyList(),
        pendingResizes = emptyList(),
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

    private fun snapshotCheckpoint(
        checkpoint: RelayV2TerminalCheckpoint,
    ): RelayV2TerminalCheckpoint = checkpoint.copy(
        pendingOutput = checkpoint.pendingOutput.map {
            it.copy(bytes = RelayV2TerminalBytes.of(it.bytes.copyBytes()))
        },
        pendingInputs = checkpoint.pendingInputs.map {
            it.copy(bytes = RelayV2TerminalBytes.of(it.bytes.copyBytes()))
        },
        pendingResizes = checkpoint.pendingResizes.map { it.copy() },
        ambiguousInputs = checkpoint.ambiguousInputs.map {
            it.copy(bytes = RelayV2TerminalBytes.of(it.bytes.copyBytes()))
        },
    )

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
            parsePositiveCounter(checkpoint.nextInputSeq) == null ||
            parseCounter(checkpoint.ackedThroughInputSeq) == null ||
            parsePositiveCounter(checkpoint.nextResizeSeq) == null ||
            parseCounter(checkpoint.ackedThroughResizeSeq) == null
        ) {
            return CheckpointValidity.INVALID
        }
        checkpoint.pendingOpen?.let {
            if (!validOperationId(it.requestId) || it.deliveryToken != checkpoint.deliveryToken ||
                (it.openAttempt.openId == checkpoint.openAttempt.openId &&
                    it.openAttempt != checkpoint.openAttempt)
            ) {
                return CheckpointValidity.INVALID
            }
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
            )
        ) {
            return CheckpointValidity.INVALID
        }
        checkpoint.lastAppliedParserCallbackToken?.let {
            if (!validCallbackToken(checkpoint, it, requireCurrentDelivery = false)) {
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
                !validOperationId(it.requestId)
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
        if (checkpoint.pendingOutput.isNotEmpty() &&
            checkpoint.parserInFlightCallbackToken == null &&
            checkpoint.parserResetCallbackToken == null &&
            canDispatchParser(checkpoint)
        ) {
            return CheckpointValidity.INVALID
        }
        if (!validInputQueue(checkpoint) || !validResizeQueue(checkpoint)) {
            return CheckpointValidity.INVALID
        }
        checkpoint.pendingClose?.let {
            if (checkpoint.closed?.tombstone?.closeAttempt != null) {
                return CheckpointValidity.INVALID
            }
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

    private fun checkpointSize(checkpoint: RelayV2TerminalCheckpoint): Long {
        var bytes = 512L
        bytes += identityStrings(checkpoint.identity).sumOf {
            it.toByteArray(Charsets.UTF_8).size.toLong()
        }
        bytes += attemptSize(checkpoint.openAttempt)
        bytes += checkpoint.parserContinuityId.toByteArray(Charsets.UTF_8).size
        bytes += checkpoint.deliveryToken.actorGeneration.profileId
            .toByteArray(Charsets.UTF_8).size
        bytes += checkpoint.pendingOutput.sumOf {
            callbackTokenSize(it.callbackToken) + it.bytes.size.toLong()
        }
        bytes += checkpoint.pendingInputs.sumOf {
            64L + it.generation.length + it.inputSeq.length + it.bytes.size
        }
        bytes += checkpoint.ambiguousInputs.sumOf {
            64L + it.generation.length + it.inputSeq.length + it.bytes.size
        }
        bytes += checkpoint.pendingResizes.size * 96L
        bytes += checkpoint.parserResetCallbackToken?.let(::callbackTokenSize) ?: 0
        bytes += checkpoint.lastAppliedParserCallbackToken?.let(::callbackTokenSize) ?: 0
        bytes += checkpoint.pendingOpen?.let {
            96L + it.requestId.toByteArray(Charsets.UTF_8).size + attemptSize(it.openAttempt)
        } ?: 0
        bytes += checkpoint.pendingReplay?.let {
            96L + it.requestId.toByteArray(Charsets.UTF_8).size + it.fromOffset.length
        } ?: 0
        bytes += checkpoint.pendingClose?.let { 64L + attemptSize(it.closeAttempt) } ?: 0
        bytes += checkpoint.closed?.let {
            128L + it.tombstone.finalOffset.length + it.tombstone.generation.length +
                it.tombstone.openId.length +
                (it.tombstone.closeAttempt?.let(::attemptSize) ?: 0) +
                (it.retainedBuffer.bufferStartOffset?.length ?: 0)
        } ?: 0
        return bytes
    }

    private fun callbackTokenSize(token: RelayV2TerminalParserCallbackToken): Long =
        192L + identityStrings(token.fence.identity).sumOf {
            it.toByteArray(Charsets.UTF_8).size.toLong()
        } + attemptSize(token.fence.openAttempt) +
            token.parserContinuityId.toByteArray(Charsets.UTF_8).size +
            token.operationId.toByteArray(Charsets.UTF_8).size +
            token.startOffset.length + token.endOffset.length

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
    )

    private fun attemptSize(attempt: RelayV2TerminalOpenAttempt): Long =
        attempt.openId.toByteArray(Charsets.UTF_8).size.toLong() +
            attempt.fingerprint.toByteArray(Charsets.UTF_8).size

    private fun attemptSize(attempt: RelayV2TerminalCloseAttempt): Long =
        attempt.closeId.toByteArray(Charsets.UTF_8).size.toLong() +
            attempt.fingerprint.toByteArray(Charsets.UTF_8).size

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

    private fun effectFence(
        checkpoint: RelayV2TerminalCheckpoint,
    ): RelayV2TerminalEffectFence = RelayV2TerminalEffectFence(
        checkpoint.identity,
        checkpoint.deliveryToken,
        checkpoint.openAttempt,
    )

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
        checkpoint.identity.resumeTokenCredentialReference,
    )

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

    private fun validClose(action: RelayV2TerminalAction.Closed): Boolean = when (action.reason) {
        RelayV2TerminalCloseReason.CLIENT_CLOSED -> action.exitCode == null && action.closeId != null
        RelayV2TerminalCloseReason.BACKEND_EXIT -> action.exitCode != null
        RelayV2TerminalCloseReason.BACKEND_ERROR -> true
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
        generation = new.generation,
        resumeTokenCredentialReference = new.resumeTokenCredentialReference,
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

    private data class ParserOperation(val id: String, val next: String)

    private data class ClosedRecovery(
        val checkpoint: RelayV2TerminalCheckpoint,
        val effects: List<RelayV2TerminalEffect>,
    )

    private enum class CheckpointValidity {
        VALID,
        INVALID,
        LIMIT_EXCEEDED,
    }

    private val COUNTER_PATTERN = Regex("^(?:0|[1-9][0-9]*)$")
    private val ZERO = BigInteger.ZERO
    private val ONE = BigInteger.ONE
    private val UNSIGNED_COUNTER_MAX = BigInteger("18446744073709551615")
}
