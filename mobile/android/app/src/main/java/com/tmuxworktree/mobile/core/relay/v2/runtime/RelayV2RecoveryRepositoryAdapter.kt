package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2DecodedMessage
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AppliedCursor
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2BufferedRecoveryAction
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2PostReleasePhase
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ResyncReason
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeKind
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeReachability
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2ScopeResource
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SessionKind
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SessionResource
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SnapshotChunk
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SnapshotRecord
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SnapshotReleaseObligation
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SnapshotReleaseReason
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateChange
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateConnectIdentity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateConnectPlan
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateConnectRecovery
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateEvent
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateHello
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateHelloDisposition
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateNamespace
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateSyncAuthority
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StateSyncResult

/**
 * Unwired bridge between the actor's generation lease and the durable state-sync authority.
 *
 * It owns no phase state. Every method is intended to run inside `withEffectApplyLease`; results
 * are converted to exact actor receipts only after the repository transaction has committed.
 */
internal class RelayV2RecoveryRepositoryAdapter(
    private val state: RelayV2StateSyncAuthority,
) : RelayV2ConnectPlanSource {
    override suspend fun load(profile: com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile):
        RelayV2ConnectPlan {
        val identity = RelayV2StateConnectIdentity(
            profile.profileId,
            profile.principalId,
            profile.clientInstanceId,
            profile.hostId,
        )
        val plan = state.loadConnectPlan(identity)
        return RelayV2ConnectPlan(
            profileId = identity.profileId,
            principalId = identity.principalId,
            clientInstanceId = identity.clientInstanceId,
            hostId = identity.hostId,
            requestedResume = plan.resume?.let {
                RelayV2ResumeCursor(it.hostEpoch, it.eventSeq)
            },
            recovery = RelayV2ConnectRecovery.valueOf(plan.recovery.name),
            durableHostEpoch = plan.durableHostEpoch,
            requiredThroughEventSeq = plan.requiredThroughEventSeq,
            snapshotRequestId = plan.snapshotRequestId,
            snapshotId = plan.snapshotId,
            snapshotNextCursor = plan.snapshotNextCursor,
            snapshotNextChunkIndex = plan.snapshotNextChunkIndex,
            snapshotComplete = plan.snapshotComplete,
            releaseObligationToken = plan.releaseObligationToken,
        )
    }

    suspend fun applyHello(
        effect: RelayV2RuntimeEffect.GenerationScoped,
        pendingCommands: List<RelayV2PendingCommand>,
    ): RelayV2RecoveryReceipt {
        val helloEffect = when (effect) {
            is RelayV2RuntimeEffect.QueryPendingCommands -> HelloEffect(
                effect.context,
                effect.generation,
                effect.recovery,
                effect.outcome,
                effect.connectPlan,
                effect.repositoryAuthority,
            )
            is RelayV2RuntimeEffect.BeginStateResync -> HelloEffect(
                effect.context,
                effect.generation,
                effect.recovery,
                effect.outcome,
                effect.connectPlan,
                effect.repositoryAuthority,
            )
            else -> error("Effect is not a Relay v2 hello apply")
        }
        requireIdentity(
            helloEffect.context,
            helloEffect.generation,
            helloEffect.repositoryAuthority,
        )
        require(helloEffect.binding.generation == helloEffect.generation)
        val resume = helloEffect.connectPlan.requestedResume?.let {
            RelayV2AppliedCursor(it.hostEpoch, it.lastEventSeq)
        }
        val namespace = helloEffect.context.namespace()
        val stateConnectPlan = helloEffect.connectPlan.toStateConnectPlan()
        val result = state.applyHelloUnderApplyLease(
            stateConnectPlan,
            RelayV2StateHello(
                namespace = namespace,
                welcomeEventSeq = helloEffect.context.eventSeq,
                resume = resume,
                disposition = helloEffect.outcome.toStateDisposition(),
            ),
        )
        return when (result) {
            is RelayV2StateSyncResult.Live -> RelayV2RecoveryReceipt.HelloApplied(
                helloEffect.binding,
                namespace.hostId,
                namespace.hostEpoch,
                result.cursorEventSeq,
                pendingCommands,
            )
            is RelayV2StateSyncResult.ResyncRequired -> result.release?.let { release ->
                recoveredRelease(
                    helloEffect.binding,
                    release,
                    requireNotNull(result.afterReleasePhase),
                    pendingCommands,
                )
            } ?: RelayV2RecoveryReceipt.HelloApplied(
                helloEffect.binding,
                namespace.hostId,
                namespace.hostEpoch,
                result.durableCursorEventSeq ?: resume?.eventSeq,
                pendingCommands,
                result.continuation?.let {
                    RelayV2SnapshotContinuation(
                        it.snapshotRequestId,
                        it.snapshotId,
                        it.cursor,
                        it.nextChunkIndex,
                    )
                },
            )
            is RelayV2StateSyncResult.ReleasePending ->
                recoveredRelease(
                    helloEffect.binding,
                    result.release,
                    result.afterReleasePhase,
                    pendingCommands,
                )
            is RelayV2StateSyncResult.RotationRequired ->
                error("Durable Relay v2 continuity rejected: ${result.reason}")
            else -> error("Unexpected hello repository result: $result")
        }
    }

    suspend fun applySnapshotChunk(
        effect: RelayV2RuntimeEffect.ApplyStateSnapshotChunk,
        pendingCommands: List<RelayV2PendingCommand>,
    ): RelayV2RecoveryReceipt {
        val chunk = effect.toStateSnapshotChunk()
        val staged = state.stageSnapshotChunkUnderApplyLease(chunk)
        val result = if (staged is RelayV2StateSyncResult.SnapshotStaged && staged.complete) {
            state.commitSnapshotUnderApplyLease(chunk.namespace, staged.snapshotId)
        } else {
            staged
        }
        return snapshotReceipt(effect, result, pendingCommands)
    }

    suspend fun completeRelease(
        effect: RelayV2RuntimeEffect.CompleteSnapshotRelease,
    ): RelayV2RecoveryReceipt.SnapshotReleaseCompleted? {
        requireIdentity(effect.context, effect.generation, effect.repositoryAuthority)
        require(effect.recovery.generation == effect.generation)
        val expected = effect.release.toStateObligation()
        require(expected.namespace == effect.context.namespace())
        require(expected.opaqueToken == effect.release.obligationToken)
        val completed = state.completeSnapshotReleaseUnderApplyLease(expected) ?: return null
        check(completed.release.opaqueToken == effect.release.obligationToken)
        return RelayV2RecoveryReceipt.SnapshotReleaseCompleted(
            effect.recovery,
            effect.context.hostId,
            effect.context.hostEpoch,
            completed.release.toRuntimeObligation(),
            completed.afterReleasePhase.toRuntimeRestart(),
        )
    }

    suspend fun expireContinuation(
        effect: RelayV2RuntimeEffect.ExpireSnapshotContinuation,
        pendingCommands: List<RelayV2PendingCommand>,
    ): RelayV2RecoveryReceipt.RecoveryRestartRequired? {
        requireIdentity(effect.context, effect.generation, effect.repositoryAuthority)
        require(effect.recovery.generation == effect.generation)
        val result = state.expireSnapshotContinuationUnderApplyLease(
            effect.context.namespace(),
            effect.snapshotRequestId,
            effect.snapshotId,
        )
        val cursor = when (result) {
            is RelayV2StateSyncResult.SnapshotExpired -> result.durableCursorEventSeq
            is RelayV2StateSyncResult.ResyncRequired -> {
                if (result.release != null ||
                    result.reason != RelayV2ResyncReason.SNAPSHOT_RESTART_REQUIRED
                ) {
                    return null
                }
                result.durableCursorEventSeq
            }
            else -> return null
        }
        return RelayV2RecoveryReceipt.RecoveryRestartRequired(
            effect.recovery,
            effect.context.hostId,
            effect.context.hostEpoch,
            RelayV2RecoveryAbandonReason.SNAPSHOT_RESTART_REQUIRED,
            cursor,
            pendingCommands,
            RelayV2RecoveryRestartDirective.SNAPSHOT,
        )
    }

    suspend fun applyOnlineStateEvent(
        effect: RelayV2RuntimeEffect.DeliverPostHandshakeFrame,
        pendingCommands: List<RelayV2PendingCommand>,
    ): RelayV2OnlineResyncRequired? {
        require(effect.recovery == null) { "ONLINE state event unexpectedly retained recovery" }
        val event = effect.toStateEvent()
        return when (val result = state.applyStateEventUnderApplyLease(event)) {
            RelayV2StateSyncResult.DuplicateEvent,
            is RelayV2StateSyncResult.Live,
            -> null
            is RelayV2StateSyncResult.EventBuffered -> RelayV2OnlineResyncRequired(
                effect.generation,
                event.namespace.hostId,
                event.namespace.hostEpoch,
                result.durableCursorEventSeq,
                pendingCommands,
                release = null,
            )
            is RelayV2StateSyncResult.ResyncRequired -> RelayV2OnlineResyncRequired(
                effect.generation,
                event.namespace.hostId,
                event.namespace.hostEpoch,
                result.durableCursorEventSeq,
                pendingCommands,
                result.release?.toRuntimeObligation(),
                result.afterReleasePhase?.toRuntimeRestart()
                    ?: RelayV2RecoveryRestartDirective.SNAPSHOT,
            )
            is RelayV2StateSyncResult.ReleasePending -> RelayV2OnlineResyncRequired(
                effect.generation,
                event.namespace.hostId,
                event.namespace.hostEpoch,
                result.release.durableCursorEventSeq,
                pendingCommands,
                result.release.toRuntimeObligation(),
                result.afterReleasePhase.toRuntimeRestart(),
            )
            else -> error("Unexpected ONLINE state repository result: $result")
        }
    }

    suspend fun applyRecoveryStateEvent(
        effect: RelayV2RuntimeEffect.DeliverPostHandshakeFrame,
        pendingCommands: List<RelayV2PendingCommand>,
    ): RelayV2RecoveryReceipt? {
        val binding = requireNotNull(effect.recovery) {
            "Recovery state event is missing its actor binding"
        }
        val event = effect.toStateEvent()
        return when (val result = state.applyStateEventUnderApplyLease(event)) {
            RelayV2StateSyncResult.DuplicateEvent,
            is RelayV2StateSyncResult.Live,
            -> null
            is RelayV2StateSyncResult.EventBuffered -> when (result.recoveryAction) {
                RelayV2BufferedRecoveryAction.CONTINUE_CURRENT -> null
                RelayV2BufferedRecoveryAction.SUPERSEDE_QUERY_COMPLETION ->
                    RelayV2RecoveryReceipt.QueryRecoverySuperseded(
                        binding,
                        requireNotNull(effect.queryLineage),
                        effect.completedReleaseBinding,
                        event.namespace.hostId,
                        event.namespace.hostEpoch,
                        RelayV2RecoveryAbandonReason.EVENT_GAP,
                        result.durableCursorEventSeq,
                        result.requiredThroughEventSeq,
                        pendingCommands,
                    )
            }
            is RelayV2StateSyncResult.ResyncRequired -> if (
                result.supersedesQueryCompletion
            ) {
                RelayV2RecoveryReceipt.QueryRecoverySuperseded(
                    binding,
                    requireNotNull(effect.queryLineage),
                    effect.completedReleaseBinding,
                    event.namespace.hostId,
                    event.namespace.hostEpoch,
                    result.reason.toRuntimeReason(),
                    result.durableCursorEventSeq,
                    requireNotNull(result.requiredThroughEventSeq),
                    pendingCommands,
                )
            } else result.release?.let { release ->
                RelayV2RecoveryReceipt.RecoveryAbandoned(
                    binding,
                    event.namespace.hostId,
                    event.namespace.hostEpoch,
                    result.reason.toRuntimeReason(),
                    release.durableCursorEventSeq,
                    pendingCommands,
                    release.toRuntimeObligation(),
                    requireNotNull(result.afterReleasePhase).toRuntimeRestart(),
                )
            } ?: RelayV2RecoveryReceipt.RecoveryRestartRequired(
                binding,
                event.namespace.hostId,
                event.namespace.hostEpoch,
                result.reason.toRuntimeReason(),
                result.durableCursorEventSeq,
                pendingCommands,
                RelayV2RecoveryRestartDirective.SNAPSHOT,
            )
            is RelayV2StateSyncResult.ReleasePending -> null
            else -> error("Unexpected recovery state repository result: $result")
        }
    }

    private fun snapshotReceipt(
        effect: RelayV2RuntimeEffect.ApplyStateSnapshotChunk,
        result: RelayV2StateSyncResult,
        pendingCommands: List<RelayV2PendingCommand>,
    ): RelayV2RecoveryReceipt = when (result) {
        is RelayV2StateSyncResult.SnapshotStaged -> RelayV2RecoveryReceipt.SnapshotChunkApplied(
            effect.recovery,
            effect.context.hostId,
            effect.context.hostEpoch,
            RelayV2DurableSnapshotApplyResult.Continue(
                effect.snapshotRequestId,
                result.snapshotId,
                result.nextChunkIndex,
                requireNotNull(result.nextCursor),
            ),
        )
        is RelayV2StateSyncResult.SnapshotCommitted ->
            RelayV2RecoveryReceipt.SnapshotChunkApplied(
                effect.recovery,
                effect.context.hostId,
                effect.context.hostEpoch,
                RelayV2DurableSnapshotApplyResult.Committed(
                    effect.snapshotRequestId,
                    result.release.snapshotId,
                    result.cursorEventSeq,
                    result.release.toRuntimeObligation(),
                ),
            )
        is RelayV2StateSyncResult.ResyncRequired -> result.release?.let { release ->
            RelayV2RecoveryReceipt.RecoveryAbandoned(
                effect.recovery,
                effect.context.hostId,
                effect.context.hostEpoch,
                result.reason.toRuntimeReason(),
                release.durableCursorEventSeq,
                pendingCommands,
                release.toRuntimeObligation(),
                requireNotNull(result.afterReleasePhase).toRuntimeRestart(),
            )
        } ?: RelayV2RecoveryReceipt.RecoveryRestartRequired(
            effect.recovery,
            effect.context.hostId,
            effect.context.hostEpoch,
            result.reason.toRuntimeReason(),
            result.durableCursorEventSeq,
            pendingCommands,
            RelayV2RecoveryRestartDirective.SNAPSHOT,
        )
        is RelayV2StateSyncResult.ReleasePending ->
            recoveredRelease(
                effect.recovery,
                result.release,
                result.afterReleasePhase,
                pendingCommands,
            )
        else -> error("Unexpected snapshot repository result: $result")
    }

    private fun recoveredRelease(
        binding: RelayV2RecoveryBinding,
        release: RelayV2SnapshotReleaseObligation,
        afterReleasePhase: RelayV2PostReleasePhase,
        pendingCommands: List<RelayV2PendingCommand>,
    ) = RelayV2RecoveryReceipt.ReleaseObligationRecovered(
        binding,
        release.namespace.hostId,
        release.namespace.hostEpoch,
        release.durableCursorEventSeq,
        pendingCommands,
        release.toRuntimeObligation(),
        afterReleasePhase.toRuntimeRestart(),
    )

    private fun requireIdentity(
        context: RelayV2HandshakeContext,
        generation: RelayV2EffectGeneration,
        repositoryAuthority: RelayV2RepositoryEffectAuthority,
    ) {
        require(repositoryAuthority == context.repositoryEffectAuthority(generation))
        require(repositoryAuthority.generation == generation)
        require(generation.profileId == context.profile.profileId)
        require(generation.profileGeneration == context.profile.activationGeneration)
        require(generation.connectionGeneration > 0)
        require(context.principalId.isNotBlank())
        require(context.clientInstanceId.isNotBlank())
        require(context.hostId.isNotBlank())
        require(context.hostEpoch.isNotBlank())
    }

    private fun RelayV2RuntimeEffect.ApplyStateSnapshotChunk.toStateSnapshotChunk():
        RelayV2SnapshotChunk {
        requireIdentity(context, generation, repositoryAuthority)
        require(recovery.generation == generation)
        val frame = message.closedFrame()
        require(frame["requestId"] == recovery.requestId)
        require(frame["hostId"] == context.hostId)
        require(frame["hostEpoch"] == context.hostEpoch)
        val payload = frame.objectValue("payload")
        require(payload["snapshotRequestId"] == snapshotRequestId)
        require(payload.longValue("chunkIndex") == requestedChunkIndex)
        snapshotId?.let { require(payload["snapshotId"] == it) }
        val records = payload.listValue("records").map { parseSnapshotRecord(it.objectValue()) }
        val chunk = RelayV2SnapshotChunk(
            namespace = context.namespace(),
            snapshotRequestId = payload.stringValue("snapshotRequestId"),
            snapshotId = payload.stringValue("snapshotId"),
            snapshotCreatedAtMs = payload.longValue("snapshotCreatedAtMs"),
            snapshotLeaseExpiresAtMs = payload.longValue("snapshotLeaseExpiresAtMs"),
            snapshotAbsoluteExpiresAtMs = payload.longValue("snapshotAbsoluteExpiresAtMs"),
            chunkIndex = payload.longValue("chunkIndex"),
            requestedCursor = requestedCursor,
            isLast = payload.booleanValue("isLast"),
            nextCursor = payload["nextCursor"] as? String,
            throughEventSeq = payload.stringValue("throughEventSeq"),
            scopesRevision = payload.stringValue("scopesRevision"),
            totalRecords = payload.longValue("totalRecords"),
            totalCanonicalBytes = payload.longValue("totalCanonicalBytes"),
            cutDigest = payload.stringValue("cutDigest"),
            records = records,
            rawUtf8Bytes = rawUtf8Bytes,
        )
        requireCanonicalEquality(frame, chunk.toResponseFrame(recovery.requestId))
        return chunk
    }

    private fun RelayV2RuntimeEffect.DeliverPostHandshakeFrame.toStateEvent(): RelayV2StateEvent {
        requireIdentity(context, generation, repositoryAuthority)
        recovery?.let { require(it.generation == generation) }
        val frame = message.closedFrame()
        require(frame["hostId"] == context.hostId)
        require(frame["hostEpoch"] == context.hostEpoch)
        val type = frame.stringValue("type")
        val scopeId = frame.stringValue("scopeId")
        val payload = frame.objectValue("payload")
        val change = payload.objectValue("change")
        val stateChange = when (type) {
            "scopes.changed" -> when (change.stringValue("op")) {
                "upsert" -> RelayV2StateChange.ScopeUpsert(
                    parseScope(change.objectValue("item")),
                )
                "delete" -> RelayV2StateChange.ScopeDelete(change.stringValue("scopeId"))
                else -> error("Strict Relay v2 scope change has an unknown operation")
            }
            "sessions.changed" -> when (change.stringValue("op")) {
                "upsert" -> RelayV2StateChange.SessionUpsert(
                    parseSession(change.objectValue("item")),
                )
                "delete" -> RelayV2StateChange.SessionDelete(
                    scopeId,
                    change.stringValue("sessionId"),
                )
                else -> error("Strict Relay v2 session change has an unknown operation")
            }
            else -> error("Effect is not a Relay v2 state event")
        }
        require(stateChange.scopeId == scopeId)
        val event = RelayV2StateEvent(
            namespace = context.namespace(),
            eventSeq = frame.stringValue("eventSeq"),
            resultingRevision = payload.stringValue("resultingRevision"),
            change = stateChange,
            rawUtf8Bytes = rawUtf8Bytes,
        )
        requireCanonicalEquality(frame, event.toEventFrame(type))
        return event
    }

    private fun RelayV2DecodedMessage.closedFrame(): Map<String, Any?> {
        require(RelayV2StrictJson.stringify(frame) == canonicalWire) {
            "Relay v2 decoded frame changed after strict validation"
        }
        return frame
    }

    private fun parseSnapshotRecord(record: Map<String, Any?>): RelayV2SnapshotRecord =
        when (record.stringValue("recordType")) {
            "scope" -> RelayV2SnapshotRecord.Scope(parseScope(record.objectValue("item")))
            "sessions_scope" -> RelayV2SnapshotRecord.SessionsScope(
                record.stringValue("scopeId"),
                record.stringValue("revision"),
            )
            "session" -> RelayV2SnapshotRecord.Session(
                record.stringValue("scopeId"),
                parseSession(record.objectValue("item")),
            )
            else -> error("Strict Relay v2 snapshot has an unknown record type")
        }

    private fun parseScope(item: Map<String, Any?>) = RelayV2ScopeResource(
        scopeId = item.stringValue("scopeId"),
        displayName = item.stringValue("displayName"),
        kind = RelayV2ScopeKind.entries.single { it.wireValue == item["kind"] },
        reachability = RelayV2ScopeReachability.entries.single {
            it.wireValue == item["reachability"]
        },
    )

    private fun parseSession(item: Map<String, Any?>) = RelayV2SessionResource(
        scopeId = item.stringValue("scopeId"),
        sessionId = item.stringValue("sessionId"),
        kind = RelayV2SessionKind.entries.single { it.wireValue == item["kind"] },
        displayName = item.stringValue("displayName"),
        project = item["project"] as? String,
        label = item["label"] as? String,
        cwd = item["cwd"] as? String,
        attached = item.booleanValue("attached"),
        windowCount = item.longValue("windowCount"),
        createdAtMs = item.longValue("createdAtMs"),
        activityAtMs = item.longValue("activityAtMs"),
    )

    private fun RelayV2HandshakeContext.namespace() = RelayV2StateNamespace(
        profile.profileId,
        principalId,
        clientInstanceId,
        hostId,
        hostEpoch,
    )

    private data class HelloEffect(
        val context: RelayV2HandshakeContext,
        val generation: RelayV2EffectGeneration,
        val binding: RelayV2RecoveryBinding,
        val outcome: RelayV2HelloOutcome,
        val connectPlan: RelayV2ConnectPlan,
        val repositoryAuthority: RelayV2RepositoryEffectAuthority,
    )
}

private fun RelayV2ConnectPlan.toStateConnectPlan() = RelayV2StateConnectPlan(
    identity = RelayV2StateConnectIdentity(profileId, principalId, clientInstanceId, hostId),
    resume = requestedResume?.let { RelayV2AppliedCursor(it.hostEpoch, it.lastEventSeq) },
    recovery = RelayV2StateConnectRecovery.valueOf(recovery.name),
    durableHostEpoch = durableHostEpoch,
    requiredThroughEventSeq = requiredThroughEventSeq,
    snapshotRequestId = snapshotRequestId,
    snapshotId = snapshotId,
    snapshotNextCursor = snapshotNextCursor,
    snapshotNextChunkIndex = snapshotNextChunkIndex,
    snapshotComplete = snapshotComplete,
    releaseObligationToken = releaseObligationToken,
)

private fun RelayV2SnapshotChunk.toResponseFrame(requestId: String): Map<String, Any?> =
    linkedMapOf(
        "protocolVersion" to 2L,
        "kind" to "response",
        "type" to "state.snapshot.chunk",
        "requestId" to requestId,
        "hostId" to namespace.hostId,
        "hostEpoch" to namespace.hostEpoch,
        "payload" to linkedMapOf(
            "coverageComplete" to true,
            "snapshotRequestId" to snapshotRequestId,
            "snapshotId" to snapshotId,
            "snapshotCreatedAtMs" to snapshotCreatedAtMs,
            "snapshotLeaseExpiresAtMs" to snapshotLeaseExpiresAtMs,
            "snapshotAbsoluteExpiresAtMs" to snapshotAbsoluteExpiresAtMs,
            "chunkIndex" to chunkIndex,
            "isLast" to isLast,
            "nextCursor" to nextCursor,
            "throughEventSeq" to throughEventSeq,
            "scopesRevision" to scopesRevision,
            "totalRecords" to totalRecords,
            "totalCanonicalBytes" to totalCanonicalBytes,
            "cutDigest" to cutDigest,
            "records" to records.map { it.toWireMap() },
        ),
    )

private fun RelayV2SnapshotRecord.toWireMap(): Map<String, Any?> = when (this) {
    is RelayV2SnapshotRecord.Scope -> linkedMapOf(
        "recordType" to "scope",
        "item" to item.wireMap(),
    )
    is RelayV2SnapshotRecord.SessionsScope -> linkedMapOf(
        "recordType" to "sessions_scope",
        "scopeId" to scopeId,
        "revision" to revision,
        "completeness" to "complete",
    )
    is RelayV2SnapshotRecord.Session -> linkedMapOf(
        "recordType" to "session",
        "scopeId" to scopeId,
        "item" to item.wireMap(),
    )
}

private fun RelayV2StateEvent.toEventFrame(type: String): Map<String, Any?> = linkedMapOf(
    "protocolVersion" to 2L,
    "kind" to "event",
    "type" to type,
    "hostId" to namespace.hostId,
    "hostEpoch" to namespace.hostEpoch,
    "scopeId" to change.scopeId,
    "eventSeq" to eventSeq,
    "payload" to linkedMapOf(
        "dimension" to if (type == "scopes.changed") "scopes" else "sessions",
        "resourceKey" to if (type == "scopes.changed") "scopes" else change.scopeId,
        "resultingRevision" to resultingRevision,
        "change" to change.toWireMap(),
    ),
)

private fun RelayV2StateChange.toWireMap(): Map<String, Any?> = when (this) {
    is RelayV2StateChange.ScopeUpsert -> linkedMapOf("op" to "upsert", "item" to item.wireMap())
    is RelayV2StateChange.ScopeDelete -> linkedMapOf("op" to "delete", "scopeId" to scopeId)
    is RelayV2StateChange.SessionUpsert -> linkedMapOf(
        "op" to "upsert",
        "item" to item.wireMap(),
    )
    is RelayV2StateChange.SessionDelete -> linkedMapOf("op" to "delete", "sessionId" to sessionId)
}

private fun requireCanonicalEquality(actual: Any?, expected: Any?) {
    require(canonicalJson(actual) == canonicalJson(expected)) {
        "Relay v2 effect frame does not equal its closed state domain"
    }
}

private fun canonicalJson(value: Any?): String = RelayV2StrictJson.stringify(canonicalValue(value))

private fun canonicalValue(value: Any?): Any? = when (value) {
    is Map<*, *> -> linkedMapOf<String, Any?>().apply {
        value.entries.sortedBy { it.key as String }.forEach { (key, item) ->
            put(key as String, canonicalValue(item))
        }
    }
    is List<*> -> value.map(::canonicalValue)
    else -> value
}

@Suppress("UNCHECKED_CAST")
private fun Any?.objectValue(): Map<String, Any?> = this as Map<String, Any?>

private fun Map<String, Any?>.objectValue(name: String): Map<String, Any?> =
    getValue(name).objectValue()

private fun Map<String, Any?>.stringValue(name: String): String = getValue(name) as String

private fun Map<String, Any?>.longValue(name: String): Long = (getValue(name) as Number).toLong()

private fun Map<String, Any?>.booleanValue(name: String): Boolean = getValue(name) as Boolean

private fun Map<String, Any?>.listValue(name: String): List<*> = getValue(name) as List<*>

private fun RelayV2HelloOutcome.toStateDisposition() =
    RelayV2StateHelloDisposition.valueOf(name)

private fun RelayV2ResyncReason.toRuntimeReason() =
    RelayV2RecoveryAbandonReason.valueOf(name)

private fun RelayV2PostReleasePhase.toRuntimeRestart() = when (this) {
    RelayV2PostReleasePhase.RESTART_SNAPSHOT -> RelayV2RecoveryRestartDirective.SNAPSHOT
    RelayV2PostReleasePhase.QUERY_PENDING_COMMANDS ->
        RelayV2RecoveryRestartDirective.QUERY_PENDING_COMMANDS
}

private fun RelayV2SnapshotReleaseObligation.toRuntimeObligation() =
    RelayV2RecoveryReleaseDirective.fromDurable(
        profileId = namespace.profileId,
        principalId = namespace.principalId,
        clientInstanceId = namespace.clientInstanceId,
        hostId = namespace.hostId,
        hostEpoch = namespace.hostEpoch,
        snapshotRequestId = snapshotRequestId,
        snapshotId = snapshotId,
        durableCursorEventSeq = durableCursorEventSeq,
        durableReason = RelayV2RecoveryDurableReleaseReason.valueOf(reason.name),
    ).also { check(it.obligationToken == opaqueToken) }

private fun RelayV2RecoveryReleaseDirective.toStateObligation() =
    RelayV2SnapshotReleaseObligation(
        namespace = RelayV2StateNamespace(
            profileId,
            principalId,
            clientInstanceId,
            hostId,
            hostEpoch,
        ),
        snapshotRequestId = snapshotRequestId,
        snapshotId = snapshotId,
        durableCursorEventSeq = durableCursorEventSeq,
        reason = RelayV2SnapshotReleaseReason.valueOf(durableReason.name),
    )
