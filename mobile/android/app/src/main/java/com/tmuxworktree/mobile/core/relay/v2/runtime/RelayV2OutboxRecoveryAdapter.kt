package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2DecodedMessage
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2WebSocketChannel
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonInteger
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2CommandDisposition
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2CommandResult
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2CommandStatusEvidence
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2CommandStatusSource
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2CommandStatusState
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2ExpiredFinalState
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAction
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxAttemptKind
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEntry
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEntryId
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxEffect
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxLimits
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxOperation
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxRejection
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxRecovery
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxState
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2ResultSessionKind
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxAuthorityNamespace
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxBatchResult
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxRecoveryAuthority
import java.util.Collections
import java.util.UUID

internal sealed interface RelayV2OutboxRecoveryCommit {
    val effects: List<RelayV2OutboxEffect>

    data class CommandStatuses(
        val receipt: RelayV2RecoveryReceipt.CommandStatusesApplied,
        override val effects: List<RelayV2OutboxEffect>,
    ) : RelayV2OutboxRecoveryCommit

    data class CommandEvidence(
        val receipt: RelayV2OutboxEvidenceApplied,
        override val effects: List<RelayV2OutboxEffect>,
    ) : RelayV2OutboxRecoveryCommit
}

internal data class RelayV2OutboxEvidenceApplied(
    val generation: RelayV2EffectGeneration,
    val entryId: RelayV2OutboxEntryId,
    val dedupeWindowId: String,
    val scopeId: String,
    val sessionId: String?,
    val operation: RelayV2OutboxOperation,
    val source: RelayV2CommandStatusSource,
    val state: RelayV2CommandStatusState,
    val attemptRequestId: String?,
)

internal sealed interface RelayV2OutboxRecoveryApplyResult {
    data class NotOwned(
        val effect: RelayV2RuntimeEffect,
    ) : RelayV2OutboxRecoveryApplyResult

    data class Committed(
        val commit: RelayV2OutboxRecoveryCommit,
        val dispatchIssuance: RelayV2OutboxDispatchIssuance =
            RelayV2OutboxDispatchIssuance.Disabled,
    ) : RelayV2OutboxRecoveryApplyResult

    data class ProtocolViolation(
        val reason: RelayV2OutboxRejection,
    ) : RelayV2OutboxRecoveryApplyResult

    data class Rejected(
        val reason: RelayV2OutboxRejection?,
    ) : RelayV2OutboxRecoveryApplyResult

    data object Stale : RelayV2OutboxRecoveryApplyResult
}

private sealed interface RelayV2OutboxRecoveryLeaseResult {
    data class NotOwned(
        val effect: RelayV2RuntimeEffect,
    ) : RelayV2OutboxRecoveryLeaseResult

    data class Committed(
        val commit: RelayV2OutboxRecoveryCommit,
        val dispatchSeal: RelayV2OutboxDispatchCommittedSeal?,
    ) : RelayV2OutboxRecoveryLeaseResult

    data class Rejected(
        val reason: RelayV2OutboxRejection?,
    ) : RelayV2OutboxRecoveryLeaseResult

    data class ProtocolViolation(
        val reason: RelayV2OutboxRejection,
    ) : RelayV2OutboxRecoveryLeaseResult
}

private data class RelayV2OutboxValidatedFrameSnapshot(
    val frame: Map<String, Any?>,
) {
    val type: String = frame.stringValue("type")
}

private data class RelayV2ExpectedCommandsSnapshot(
    val ordered: List<RelayV2PendingCommand>,
)

/**
 * Unwired bridge from actor-decoded command evidence to the durable Outbox authority.
 *
 * The actor remains the lease owner through [RelayV2RepositoryEffectApplyLeasePort]. This adapter
 * owns no generation or transition state: it acquires that lease around the complete repository
 * transaction, closes the actor binding, uses only locally persisted command identity, and returns
 * a receipt and typed effects only after the transaction commits.
 */
internal class RelayV2OutboxRecoveryAdapter private constructor(
    private val applyLease: RelayV2RepositoryEffectApplyLeasePort,
    private val outbox: RelayV2OutboxRecoveryAuthority,
    private val newId: () -> String,
    private val clock: () -> Long,
    private val dispatchIssuer: RelayV2OutboxDispatchIssuePort?,
) {
    internal constructor(
        applyLease: RelayV2RepositoryEffectApplyLeasePort,
        outbox: RelayV2OutboxRecoveryAuthority,
        newId: () -> String = { UUID.randomUUID().toString() },
        clock: () -> Long = System::currentTimeMillis,
    ) : this(
        applyLease,
        outbox,
        newId,
        clock,
        dispatchIssuer = null,
    )

    internal companion object {
        fun withDispatchIssuer(
            applyLease: RelayV2RepositoryEffectApplyLeasePort,
            outbox: RelayV2OutboxRecoveryAuthority,
            newId: () -> String,
            clock: () -> Long,
            dispatchIssuer: RelayV2OutboxDispatchIssuePort,
        ): RelayV2OutboxRecoveryAdapter = RelayV2OutboxRecoveryAdapter(
            applyLease,
            outbox,
            newId,
            clock,
            dispatchIssuer,
        )
    }

    suspend fun handle(
        effect: RelayV2RuntimeEffect,
    ): RelayV2OutboxRecoveryApplyResult = when (effect) {
        is RelayV2RuntimeEffect.ApplyCommandStatuses -> {
            val expected = effect.expectedCommands.privateSnapshot()
            val snapshot = effect.message.validatedSnapshot()
            require(snapshot.type == "command.statuses")
            applyCommandStatuses(effect, snapshot, expected).toApplyResult(dispatchIssuer)
        }
        is RelayV2RuntimeEffect.DeliverPostHandshakeFrame -> {
            val snapshot = effect.message.validatedSnapshot()
            when (snapshot.type) {
                "command.status", "command.result" ->
                    applyCommandEvidence(effect, snapshot).toApplyResult(dispatchIssuer)
                "error" ->
                    applyCorrelatedExecuteError(effect, snapshot).toApplyResult(dispatchIssuer)
                else -> RelayV2OutboxRecoveryApplyResult.NotOwned(effect)
            }
        }
        else -> RelayV2OutboxRecoveryApplyResult.NotOwned(effect)
    }

    private suspend fun applyCommandStatuses(
        effect: RelayV2RuntimeEffect.ApplyCommandStatuses,
        snapshot: RelayV2OutboxValidatedFrameSnapshot,
        expected: RelayV2ExpectedCommandsSnapshot,
    ): RelayV2EffectApplyResult<RelayV2OutboxRecoveryLeaseResult> =
        applyLease.withEffectApplyLease(effect.repositoryAuthority) {
            applyCommandStatusesUnderLease(effect, snapshot, expected)
        }

    private suspend fun applyCommandStatusesUnderLease(
        effect: RelayV2RuntimeEffect.ApplyCommandStatuses,
        snapshot: RelayV2OutboxValidatedFrameSnapshot,
        expectedSnapshot: RelayV2ExpectedCommandsSnapshot,
    ): RelayV2OutboxRecoveryLeaseResult {
        requireIdentity(effect)
        val frame = snapshot.frame
        require(frame["kind"] == "response")
        require(snapshot.type == "command.statuses")
        require(frame["requestId"] == effect.recovery.requestId)
        require(frame["hostId"] == effect.context.hostId)
        require(frame["hostEpoch"] == effect.context.hostEpoch)

        val expected = expectedSnapshot.ordered
        require(expected.size in 1..RelayV2OutboxLimits.MAX_QUERY_ITEMS_PER_BATCH)
        require(expected.distinctBy { it.commandId }.size == expected.size)
        val statusItems = frame.objectValue("payload").listValue("items").map {
            it.objectValue()
        }
        require(statusItems.size == expected.size)
        val statusPairs = statusItems.map {
            RelayV2PendingCommand(it.stringValue("commandId"), it.stringValue("dedupeWindowId"))
        }
        require(statusPairs.distinctBy { it.commandId }.size == statusPairs.size)
        require(statusPairs.toSet() == expected.toSet())
        val statusByCommand = statusItems.associateBy { it.stringValue("commandId") }

        val namespace = RelayV2OutboxAuthorityNamespace(
            effect.repositoryAuthority.profileId,
            effect.repositoryAuthority.profileActivationGeneration,
            effect.repositoryAuthority.principalId,
            effect.repositoryAuthority.clientInstanceId,
        )
        val result = outbox.reduceOutboxBatchUnderApplyLease(namespace) { current ->
            buildActions(effect, current, expected, statusByCommand)
        }
        return when (result) {
            is RelayV2OutboxBatchResult.Applied -> committed(
                effect.repositoryAuthority,
                RelayV2OutboxRecoveryCommit.CommandStatuses(
                    receipt = RelayV2RecoveryReceipt.CommandStatusesApplied(
                        effect.recovery,
                        effect.context.hostId,
                        effect.context.hostEpoch,
                        expected,
                    ),
                    effects = result.effects,
                ),
            )
            is RelayV2OutboxBatchResult.Rejected ->
                RelayV2OutboxRecoveryLeaseResult.Rejected(result.reason)
        }
    }

    private suspend fun applyCorrelatedExecuteError(
        effect: RelayV2RuntimeEffect.DeliverPostHandshakeFrame,
        snapshot: RelayV2OutboxValidatedFrameSnapshot,
    ): RelayV2EffectApplyResult<RelayV2OutboxRecoveryLeaseResult> =
        applyLease.withEffectApplyLease(effect.repositoryAuthority) {
            applyCorrelatedExecuteErrorUnderLease(effect, snapshot)
        }

    private suspend fun applyCorrelatedExecuteErrorUnderLease(
        effect: RelayV2RuntimeEffect.DeliverPostHandshakeFrame,
        snapshot: RelayV2OutboxValidatedFrameSnapshot,
    ): RelayV2OutboxRecoveryLeaseResult {
        requireIdentity(effect)
        val frame = snapshot.frame
        require(snapshot.type == "error")
        require(frame["kind"] == "response")
        val requestId = frame.stringValue("requestId")
        val namespace = effect.repositoryAuthority.outboxNamespace()
        var notOwned = false
        var protocolViolation: RelayV2OutboxRejection? = null
        var postCommitReceipt: RelayV2OutboxEvidenceApplied? = null
        val result = outbox.reduceOutboxBatchUnderApplyLease(namespace) { current ->
            val owned = current.entries.mapNotNull { entry ->
                entry.takeIf {
                    it.attempts.any { attempt ->
                        attempt.requestId == requestId &&
                            attempt.kind == RelayV2OutboxAttemptKind.EXECUTE
                    }
                }
            }
            if (owned.isEmpty()) {
                notOwned = true
                return@reduceOutboxBatchUnderApplyLease null
            }
            if (owned.size != 1) {
                protocolViolation = RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH
                return@reduceOutboxBatchUnderApplyLease null
            }
            val entry = owned.single()
            if (!entry.matchesAuthority(effect.repositoryAuthority) ||
                !frame.optionalIdentityMatches("commandId", entry.commandId) ||
                !frame.optionalIdentityMatches("hostId", entry.hostId) ||
                !frame.optionalIdentityMatches("hostEpoch", entry.expectedHostEpoch) ||
                !frame.optionalIdentityMatches("scopeId", entry.scopeId) ||
                !frame.optionalIdentityMatches("sessionId", entry.sessionId)
            ) {
                protocolViolation = RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH
                return@reduceOutboxBatchUnderApplyLease null
            }
            val structured = frame.objectValue("error")
            if (structured.stringValue("commandDisposition") !=
                RelayV2CommandDisposition.NOT_ACCEPTED.wireValue
            ) {
                protocolViolation = RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING
                return@reduceOutboxBatchUnderApplyLease null
            }
            val evidence = structured.toExecuteErrorEvidence(entry, requestId)
            postCommitReceipt = evidence.toAppliedReceipt(effect.generation)
            listOf(
                RelayV2OutboxAction.ReconcileStatus(
                    evidence,
                    evidence.toExecuteErrorRecovery(effect.context),
                ),
            )
        }
        return when (result) {
            is RelayV2OutboxBatchResult.Applied -> committed(
                effect.repositoryAuthority,
                RelayV2OutboxRecoveryCommit.CommandEvidence(
                    receipt = requireNotNull(postCommitReceipt),
                    effects = result.effects,
                ),
            )
            is RelayV2OutboxBatchResult.Rejected -> when {
                notOwned -> RelayV2OutboxRecoveryLeaseResult.NotOwned(effect)
                protocolViolation != null -> RelayV2OutboxRecoveryLeaseResult.ProtocolViolation(
                    requireNotNull(protocolViolation),
                )
                else -> RelayV2OutboxRecoveryLeaseResult.ProtocolViolation(
                    result.reason ?: RelayV2OutboxRejection.STATUS_NOT_AUTHORIZING,
                )
            }
        }
    }

    private suspend fun applyCommandEvidence(
        effect: RelayV2RuntimeEffect.DeliverPostHandshakeFrame,
        snapshot: RelayV2OutboxValidatedFrameSnapshot,
    ): RelayV2EffectApplyResult<RelayV2OutboxRecoveryLeaseResult> =
        applyLease.withEffectApplyLease(effect.repositoryAuthority) {
            applyCommandEvidenceUnderLease(effect, snapshot)
        }

    private suspend fun applyCommandEvidenceUnderLease(
        effect: RelayV2RuntimeEffect.DeliverPostHandshakeFrame,
        snapshot: RelayV2OutboxValidatedFrameSnapshot,
    ): RelayV2OutboxRecoveryLeaseResult {
        requireIdentity(effect)
        val frame = snapshot.frame
        val source = when (snapshot.type) {
            "command.status" -> RelayV2CommandStatusSource.EXECUTE_RESPONSE
            "command.result" -> RelayV2CommandStatusSource.RESULT_EVENT
            else -> error("Not a Relay v2 Outbox evidence frame")
        }
        require(frame["kind"] == if (source == RelayV2CommandStatusSource.RESULT_EVENT) {
            "event"
        } else {
            "response"
        })
        val attemptRequestId = frame["requestId"] as? String
        if (source == RelayV2CommandStatusSource.RESULT_EVENT) {
            require(attemptRequestId == null)
        } else {
            require(attemptRequestId != null)
        }
        require(frame["hostId"] == effect.context.hostId)
        require(frame["hostEpoch"] == effect.context.hostEpoch)

        val commandId = frame.stringValue("commandId")
        val entryId = RelayV2OutboxEntryId(
            effect.repositoryAuthority.profileId,
            effect.repositoryAuthority.principalId,
            effect.repositoryAuthority.hostId,
            effect.repositoryAuthority.hostEpoch,
            commandId,
        )
        val namespace = effect.repositoryAuthority.outboxNamespace()
        var postCommitReceipt: RelayV2OutboxEvidenceApplied? = null
        var actionSourceProtocolViolation: RelayV2OutboxRejection? = null
        val result = outbox.reduceOutboxBatchUnderApplyLease(namespace) { current ->
            val entry = current.entry(entryId) ?: run {
                actionSourceProtocolViolation =
                    RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH
                return@reduceOutboxBatchUnderApplyLease null
            }
            val evidence = frame.toEvidence(entry, source, attemptRequestId)
            postCommitReceipt = evidence.toAppliedReceipt(effect.generation)
            listOf(RelayV2OutboxAction.ReconcileStatus(evidence))
        }
        return when (result) {
            is RelayV2OutboxBatchResult.Applied -> committed(
                effect.repositoryAuthority,
                RelayV2OutboxRecoveryCommit.CommandEvidence(
                    receipt = requireNotNull(postCommitReceipt),
                    effects = result.effects,
                ),
            )
            is RelayV2OutboxBatchResult.Rejected -> actionSourceProtocolViolation?.let {
                RelayV2OutboxRecoveryLeaseResult.ProtocolViolation(it)
            } ?: RelayV2OutboxRecoveryLeaseResult.Rejected(result.reason)
        }
    }

    private fun buildActions(
        effect: RelayV2RuntimeEffect.ApplyCommandStatuses,
        state: RelayV2OutboxState,
        expected: List<RelayV2PendingCommand>,
        statusByCommand: Map<String, Map<String, Any?>>,
    ): List<RelayV2OutboxAction>? {
        val actions = ArrayList<RelayV2OutboxAction>(expected.size)
        expected.forEach { pending ->
            val entryId = RelayV2OutboxEntryId(
                effect.repositoryAuthority.profileId,
                effect.repositoryAuthority.principalId,
                effect.repositoryAuthority.hostId,
                effect.repositoryAuthority.hostEpoch,
                pending.commandId,
            )
            val entry = state.entry(entryId) ?: return null
            if (entry.dedupeWindowId != pending.dedupeWindowId) return null
            val item = statusByCommand.getValue(pending.commandId)
            if (item.stringValue("dedupeWindowId") != entry.dedupeWindowId) return null
            val evidence = item.toEvidence(entry, effect.recovery.requestId)
            actions += RelayV2OutboxAction.ReconcileStatus(
                evidence,
                item.toRecovery(effect.context),
            )
        }
        return actions
    }

    private fun Map<String, Any?>.toEvidence(
        entry: RelayV2OutboxEntry,
        queryRequestId: String,
    ): RelayV2CommandStatusEvidence {
        val error = get("error")?.objectValue()
        val retryable = booleanValue("retryable")
        if (error != null) require(error.booleanValue("retryable") == retryable)
        val details = error?.get("details")?.objectValue()
        return RelayV2CommandStatusEvidence(
            entryId = entry.id,
            dedupeWindowId = stringValue("dedupeWindowId"),
            hostEpoch = entry.expectedHostEpoch,
            scopeId = entry.scopeId,
            sessionId = entry.sessionId,
            operation = entry.operation,
            source = RelayV2CommandStatusSource.QUERY_RESPONSE,
            attemptKind = RelayV2OutboxAttemptKind.QUERY,
            state = RelayV2CommandStatusState.valueOf(
                stringValue("state").uppercase(),
            ),
            attemptRequestId = queryRequestId,
            result = parseResult(entry),
            retryable = retryable,
            retryAfterMs = numberOrNull("retryAfterMs"),
            reissueRequired = booleanValue("reissueRequired"),
            errorCode = error?.stringValue("code"),
            commandDisposition = error?.stringValue("commandDisposition")?.let { wire ->
                RelayV2CommandDisposition.entries.single { it.wireValue == wire }
            },
            detailsReissueRequired = details?.get("reissueRequired") as? Boolean,
            expiredFinalState = (details?.get("finalState") as? String)?.let { wire ->
                requireNotNull(RelayV2ExpiredFinalState.fromWireValue(wire))
            },
            errorMessage = error?.stringValue("message"),
        )
    }

    private fun Map<String, Any?>.toEvidence(
        entry: RelayV2OutboxEntry,
        source: RelayV2CommandStatusSource,
        attemptRequestId: String?,
    ): RelayV2CommandStatusEvidence {
        val payload = objectValue("payload")
        val error = get("error")?.objectValue()
        val details = error?.get("details")?.objectValue()
        return RelayV2CommandStatusEvidence(
            entryId = entry.id,
            dedupeWindowId = payload.stringValue("dedupeWindowId"),
            hostEpoch = stringValue("hostEpoch"),
            scopeId = stringValue("scopeId"),
            sessionId = get("sessionId") as? String,
            operation = entry.operation,
            source = source,
            attemptKind = source.attemptKind,
            state = RelayV2CommandStatusState.valueOf(
                payload.stringValue("state").uppercase(),
            ),
            attemptRequestId = attemptRequestId,
            result = payload.parseResult(entry),
            retryable = error?.booleanValue("retryable") ?: false,
            retryAfterMs = error?.numberOrNull("retryAfterMs"),
            reissueRequired = false,
            errorCode = error?.stringValue("code"),
            commandDisposition = error?.stringValue("commandDisposition")?.let { wire ->
                RelayV2CommandDisposition.entries.single { it.wireValue == wire }
            },
            detailsReissueRequired = details?.get("reissueRequired") as? Boolean,
            expiredFinalState = (details?.get("finalState") as? String)?.let { wire ->
                requireNotNull(RelayV2ExpiredFinalState.fromWireValue(wire))
            },
            errorMessage = error?.stringValue("message"),
        )
    }

    private fun Map<String, Any?>.toExecuteErrorEvidence(
        entry: RelayV2OutboxEntry,
        requestId: String,
    ): RelayV2CommandStatusEvidence {
        val details = get("details")?.objectValue()
        return RelayV2CommandStatusEvidence(
            entryId = entry.id,
            dedupeWindowId = entry.dedupeWindowId,
            hostEpoch = entry.expectedHostEpoch,
            scopeId = entry.scopeId,
            sessionId = entry.sessionId,
            operation = entry.operation,
            source = RelayV2CommandStatusSource.EXECUTE_RESPONSE,
            attemptKind = RelayV2OutboxAttemptKind.EXECUTE,
            state = RelayV2CommandStatusState.NOT_ACCEPTED,
            attemptRequestId = requestId,
            retryable = booleanValue("retryable"),
            retryAfterMs = numberOrNull("retryAfterMs"),
            reissueRequired = details?.get("reissueRequired") == true,
            errorCode = stringValue("code"),
            commandDisposition = RelayV2CommandDisposition.entries.singleOrNull {
                it.wireValue == stringValue("commandDisposition")
            },
            detailsReissueRequired = details?.get("reissueRequired") as? Boolean,
            errorMessage = stringValue("message"),
        )
    }

    private fun RelayV2CommandStatusEvidence.toExecuteErrorRecovery(
        context: RelayV2HandshakeContext,
    ): RelayV2OutboxRecovery = when {
        retryable &&
            !reissueRequired &&
            errorCode != null &&
            commandDisposition == RelayV2CommandDisposition.NOT_ACCEPTED &&
            detailsReissueRequired == null -> RelayV2OutboxRecovery.RetrySameCommand(newId())
        !retryable &&
            retryAfterMs == null &&
            reissueRequired &&
            errorCode == "COMMAND_WINDOW_EXPIRED" &&
            commandDisposition == RelayV2CommandDisposition.NOT_ACCEPTED &&
            detailsReissueRequired == true -> RelayV2OutboxRecovery.Reissue(
                replacementCommandId = newId(),
                newDedupeWindowId = context.commandDedupeWindow.windowId,
                replacementCreatedAtMillis = clock(),
            )
        else -> RelayV2OutboxRecovery.None
    }

    private fun Map<String, Any?>.parseResult(
        entry: RelayV2OutboxEntry,
    ): RelayV2CommandResult? {
        val result = get("result")?.objectValue() ?: return null
        return when (entry.operation) {
            RelayV2OutboxOperation.CREATE_WORKTREE,
            RelayV2OutboxOperation.CREATE_TERMINAL,
            -> result.objectValue("session").let { session ->
                RelayV2CommandResult.CreatedSession(
                    session.stringValue("sessionId"),
                    session.stringValue("scopeId"),
                    when (session.stringValue("kind")) {
                        "worktree" -> RelayV2ResultSessionKind.WORKTREE
                        "terminal" -> RelayV2ResultSessionKind.TERMINAL
                        else -> error("Unknown Relay v2 result session kind")
                    },
                )
            }
            RelayV2OutboxOperation.SEND_AGENT_MESSAGE -> RelayV2CommandResult.AgentMessage(
                result.longValue("pane").toInt(),
                result.booleanValue("submit"),
                result.longValue("messageUtf8Bytes").toInt(),
            )
            RelayV2OutboxOperation.KILL_SESSION -> RelayV2CommandResult.KilledSession(
                result.stringValue("sessionId"),
                result.booleanValue("terminated"),
            )
        }
    }

    private fun Map<String, Any?>.toRecovery(
        context: RelayV2HandshakeContext,
    ): RelayV2OutboxRecovery = if (stringValue("state") != "not_accepted") {
        RelayV2OutboxRecovery.None
    } else if (booleanValue("retryable") && !booleanValue("reissueRequired")) {
        RelayV2OutboxRecovery.RetrySameCommand(newId())
    } else if (!booleanValue("retryable") && booleanValue("reissueRequired")) {
        RelayV2OutboxRecovery.Reissue(
            replacementCommandId = newId(),
            newDedupeWindowId = context.commandDedupeWindow.windowId,
            replacementCreatedAtMillis = clock(),
        )
    } else {
        RelayV2OutboxRecovery.None
    }

    private fun requireIdentity(effect: RelayV2RuntimeEffect.ApplyCommandStatuses) {
        requireIdentity(effect.context, effect.generation, effect.repositoryAuthority)
        require(effect.recovery.generation == effect.generation)
    }

    private fun requireIdentity(effect: RelayV2RuntimeEffect.DeliverPostHandshakeFrame) {
        requireIdentity(effect.context, effect.generation, effect.repositoryAuthority)
    }

    private fun requireIdentity(
        context: RelayV2HandshakeContext,
        generation: RelayV2EffectGeneration,
        authority: RelayV2RepositoryEffectAuthority,
    ) {
        require(authority == context.repositoryEffectAuthority(generation))
        require(authority.generation == generation)
        require(generation.profileId == context.profile.profileId)
        require(generation.profileGeneration == context.profile.activationGeneration)
        require(generation.connectionGeneration > 0)
        require(authority.hostId == context.hostId)
        require(authority.hostEpoch == context.hostEpoch)
    }

    /** Called only after reduceOutboxBatchUnderApplyLease returned Applied. */
    private fun committed(
        authority: RelayV2RepositoryEffectAuthority,
        commit: RelayV2OutboxRecoveryCommit,
    ): RelayV2OutboxRecoveryLeaseResult.Committed =
        RelayV2OutboxRecoveryLeaseResult.Committed(
            commit = commit,
            dispatchSeal = dispatchIssuer?.sealCommitted(authority, commit),
        )
}

private fun RelayV2RepositoryEffectAuthority.outboxNamespace() =
    RelayV2OutboxAuthorityNamespace(
        profileId,
        profileActivationGeneration,
        principalId,
        clientInstanceId,
    )

private fun RelayV2OutboxEntry.matchesAuthority(
    authority: RelayV2RepositoryEffectAuthority,
): Boolean = profileId == authority.profileId &&
    principalId == authority.principalId &&
    hostId == authority.hostId &&
    expectedHostEpoch == authority.hostEpoch

private fun Map<String, Any?>.optionalIdentityMatches(
    name: String,
    expected: String?,
): Boolean = !containsKey(name) || get(name) == expected

private fun RelayV2CommandStatusEvidence.toAppliedReceipt(
    generation: RelayV2EffectGeneration,
) = RelayV2OutboxEvidenceApplied(
    generation = generation,
    entryId = entryId,
    dedupeWindowId = dedupeWindowId,
    scopeId = scopeId,
    sessionId = sessionId,
    operation = operation,
    source = source,
    state = state,
    attemptRequestId = attemptRequestId,
)

private fun RelayV2EffectApplyResult<RelayV2OutboxRecoveryLeaseResult>.toApplyResult(
    dispatchIssuer: RelayV2OutboxDispatchIssuePort?,
): RelayV2OutboxRecoveryApplyResult = when (this) {
    is RelayV2EffectApplyResult.Applied -> when (val durable = value) {
        is RelayV2OutboxRecoveryLeaseResult.NotOwned ->
            RelayV2OutboxRecoveryApplyResult.NotOwned(durable.effect)
        is RelayV2OutboxRecoveryLeaseResult.Committed -> {
            val dispatchIssuance = if (dispatchIssuer == null) {
                RelayV2OutboxDispatchIssuance.Disabled
            } else if (durable.dispatchSeal == null) {
                RelayV2OutboxDispatchIssuance.Rejected(
                    RelayV2OutboxDispatchIssueFailure.ISSUER_FAILED,
                )
            } else {
                try {
                    dispatchIssuer.issue(durable.dispatchSeal)
                } catch (_: Exception) {
                    RelayV2OutboxDispatchIssuance.Rejected(
                        RelayV2OutboxDispatchIssueFailure.ISSUER_FAILED,
                    )
                }
            }
            RelayV2OutboxRecoveryApplyResult.Committed(
                durable.commit,
                dispatchIssuance,
            )
        }
        is RelayV2OutboxRecoveryLeaseResult.Rejected ->
            if (durable.reason == RelayV2OutboxRejection.STATUS_IDENTITY_MISMATCH) {
                RelayV2OutboxRecoveryApplyResult.ProtocolViolation(durable.reason)
            } else {
                RelayV2OutboxRecoveryApplyResult.Rejected(durable.reason)
            }
        is RelayV2OutboxRecoveryLeaseResult.ProtocolViolation ->
            RelayV2OutboxRecoveryApplyResult.ProtocolViolation(durable.reason)
    }
    RelayV2EffectApplyResult.Stale -> RelayV2OutboxRecoveryApplyResult.Stale
}

private fun List<RelayV2PendingCommand>.privateSnapshot():
    RelayV2ExpectedCommandsSnapshot {
    val snapshotSize = size
    require(snapshotSize in 1..RelayV2OutboxLimits.MAX_QUERY_ITEMS_PER_BATCH) {
        "Relay v2 expected command batch is invalid"
    }
    val copied = ArrayList<RelayV2PendingCommand>(snapshotSize)
    repeat(snapshotSize) { index ->
        val pending = get(index)
        copied += RelayV2PendingCommand(pending.commandId, pending.dedupeWindowId)
    }
    require(size == snapshotSize) {
        "Relay v2 expected command batch changed while snapshotting"
    }
    repeat(snapshotSize) { index ->
        require(get(index) == copied[index]) {
            "Relay v2 expected command batch changed while snapshotting"
        }
    }
    require(copied.distinctBy { it.commandId }.size == copied.size) {
        "Relay v2 expected command IDs must be unique"
    }
    return RelayV2ExpectedCommandsSnapshot(Collections.unmodifiableList(copied))
}

private fun RelayV2DecodedMessage.validatedSnapshot(): RelayV2OutboxValidatedFrameSnapshot {
    val wireSnapshot = canonicalWire
    val decodedSnapshot = RelayV2Codec().decodeWebSocketFrame(
        RelayV2WebSocketChannel.PUBLIC,
        wireSnapshot.toByteArray(Charsets.UTF_8),
    )
    require(decodedSnapshot.canonicalWire == wireSnapshot) {
        "Relay v2 canonical wire changed after strict validation"
    }
    return RelayV2OutboxValidatedFrameSnapshot(decodedSnapshot.frame)
}

@Suppress("UNCHECKED_CAST")
private fun Any?.objectValue(): Map<String, Any?> = this as Map<String, Any?>

private fun Map<String, Any?>.objectValue(name: String): Map<String, Any?> =
    getValue(name).objectValue()

private fun Map<String, Any?>.stringValue(name: String): String = getValue(name) as String

private fun Map<String, Any?>.longValue(name: String): Long = (getValue(name) as Number).toLong()

private fun Map<String, Any?>.numberOrNull(name: String): Long? =
    get(name)?.let { jsonInteger(it) }

private fun Map<String, Any?>.booleanValue(name: String): Boolean = getValue(name) as Boolean

private fun Map<String, Any?>.listValue(name: String): List<*> = getValue(name) as List<*>
