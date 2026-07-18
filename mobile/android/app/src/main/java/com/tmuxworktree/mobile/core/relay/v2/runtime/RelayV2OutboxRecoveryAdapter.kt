package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2DecodedMessage
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
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
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxRecovery
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2OutboxState
import com.tmuxworktree.mobile.core.relay.v2.outbox.RelayV2ResultSessionKind
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxAuthorityNamespace
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxBatchResult
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2OutboxRecoveryAuthority
import java.util.UUID

internal data class RelayV2OutboxRecoveryCommit(
    val receipt: RelayV2RecoveryReceipt.CommandStatusesApplied,
    val effects: List<RelayV2OutboxEffect>,
)

/**
 * Unwired bridge from actor-decoded command statuses to the durable Outbox authority.
 *
 * The actor remains the lease owner through [RelayV2RepositoryEffectApplyLeasePort]. This adapter
 * owns no generation or transition state: it acquires that lease around the complete repository
 * transaction, closes the actor binding, uses only locally persisted command identity, and returns
 * a receipt and typed effects only after the transaction commits.
 */
internal class RelayV2OutboxRecoveryAdapter(
    private val applyLease: RelayV2RepositoryEffectApplyLeasePort,
    private val outbox: RelayV2OutboxRecoveryAuthority,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val clock: () -> Long = System::currentTimeMillis,
) {
    suspend fun applyCommandStatuses(
        effect: RelayV2RuntimeEffect.ApplyCommandStatuses,
    ): RelayV2EffectApplyResult<RelayV2OutboxRecoveryCommit?> =
        applyLease.withEffectApplyLease(effect.repositoryAuthority) {
            applyCommandStatusesUnderLease(effect)
        }

    private suspend fun applyCommandStatusesUnderLease(
        effect: RelayV2RuntimeEffect.ApplyCommandStatuses,
    ): RelayV2OutboxRecoveryCommit? {
        requireIdentity(effect)
        val frame = effect.message.closedFrame()
        require(frame["kind"] == "response")
        require(frame["type"] == "command.statuses")
        require(frame["requestId"] == effect.recovery.requestId)
        require(frame["hostId"] == effect.context.hostId)
        require(frame["hostEpoch"] == effect.context.hostEpoch)

        val expected = effect.expectedCommands
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
        if (result !is RelayV2OutboxBatchResult.Applied) return null
        return RelayV2OutboxRecoveryCommit(
            receipt = RelayV2RecoveryReceipt.CommandStatusesApplied(
                effect.recovery,
                effect.context.hostId,
                effect.context.hostEpoch,
                expected,
            ),
            effects = result.effects,
        )
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
        require(
            effect.repositoryAuthority ==
                effect.context.repositoryEffectAuthority(effect.generation),
        )
        require(effect.repositoryAuthority.generation == effect.generation)
        require(effect.recovery.generation == effect.generation)
        require(effect.generation.profileId == effect.context.profile.profileId)
        require(effect.generation.profileGeneration == effect.context.profile.activationGeneration)
        require(effect.generation.connectionGeneration > 0)
        require(effect.repositoryAuthority.hostId == effect.context.hostId)
        require(effect.repositoryAuthority.hostEpoch == effect.context.hostEpoch)
    }
}

private fun RelayV2DecodedMessage.closedFrame(): Map<String, Any?> {
    require(RelayV2StrictJson.stringify(frame) == canonicalWire) {
        "Relay v2 decoded frame changed after strict validation"
    }
    return frame
}

@Suppress("UNCHECKED_CAST")
private fun Any?.objectValue(): Map<String, Any?> = this as Map<String, Any?>

private fun Map<String, Any?>.objectValue(name: String): Map<String, Any?> =
    getValue(name).objectValue()

private fun Map<String, Any?>.stringValue(name: String): String = getValue(name) as String

private fun Map<String, Any?>.longValue(name: String): Long = (getValue(name) as Number).toLong()

private fun Map<String, Any?>.numberOrNull(name: String): Long? =
    (getValue(name) as? Number)?.toLong()

private fun Map<String, Any?>.booleanValue(name: String): Boolean = getValue(name) as Boolean

private fun Map<String, Any?>.listValue(name: String): List<*> = getValue(name) as List<*>
