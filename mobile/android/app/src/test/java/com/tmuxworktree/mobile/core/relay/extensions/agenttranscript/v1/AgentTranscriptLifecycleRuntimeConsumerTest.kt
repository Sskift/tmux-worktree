package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineErrorCode
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineErrorCommandDisposition
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineErrorFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineHostEpochMismatchDetails
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineReplayPageFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotPageFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineStructuredError
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1Codec
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1PublicFrameArtifact
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDialect
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2AgentExtensionUnavailableReason
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2CommandDedupeWindow
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectApplyResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectGeneration
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2HandshakeContext
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2NegotiatedLimits
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectApplyLeasePort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RuntimeEffect
import java.nio.charset.StandardCharsets
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentTranscriptLifecycleRuntimeConsumerTest {
    @Test
    fun `unnegotiated artifact is neither leased nor applied`() = runBlocking {
        val harness = Harness(sessionId = "session-shell", statusRequestId = "agent-status-2")

        val result = harness.runtime.consume(
            artifact("status-unsupported-agent"),
            harness.fence(negotiated = false),
        )

        assertEquals(AgentTranscriptLifecycleRuntimeConsumeResult.ExtensionNotNegotiated, result)
        assertEquals(0, harness.lease.blockCount)
        assertEquals(0, harness.operations.applyCount)
    }

    @Test
    fun `correlated unavailable waits for durable operation inside apply lease`() = runBlocking {
        val harness = Harness(sessionId = "session-shell", statusRequestId = "agent-status-2")
        val applyGate = harness.operations.blockNextApply()
        val admission = harness.admission(
            AgentTranscriptLifecycleRequestKind.STATUS,
            "agent-status-2",
        )
        val applying = async(Dispatchers.Default) {
            harness.runtime.consume(
                artifact("status-unsupported-agent"),
                harness.fence(requestAdmission = admission),
            )
        }
        applyGate.entered.await()
        assertFalse(applying.isCompleted)
        assertTrue(harness.lease.insideBlock)
        assertTrue(harness.handoff.accepted.isEmpty())
        applyGate.release.complete(Unit)

        assertTrue(applying.await() is AgentTranscriptLifecycleRuntimeConsumeResult.Applied)
        assertFalse(harness.lease.insideBlock)
        assertEquals(listOf(admission), harness.handoff.accepted)
        assertEquals(
            listOf(AgentTranscriptLifecycleCompletedHandoffReceipt(admission)),
            harness.handoff.singleReceipts,
        )
        val input = harness.operations.controlCommands.single().input
            as AgentTranscriptLifecycleClientInput.StatusUnavailable
        assertEquals(AgentExtensionUnavailableReason.AGENT_UNSUPPORTED, input.reason)
        assertEquals(AgentLocalRequestFence("1", "agent-status-2"), input.requestFence)
    }

    @Test
    fun `available live replay snapshot and reset dispatch through typed durable operations`() =
        runBlocking {
            data class Case(
                val fixture: String,
                val ingress: AgentTranscriptLifecycleTrustedIngress,
                val assertDispatch: (RecordingDurableOperationPort) -> Unit,
            )

            val cases = listOf(
                Case(
                    "status-available",
                    AgentTranscriptLifecycleTrustedIngress.CorrelatedStatus(
                        AgentLocalRequestFence("1", "agent-status-1"),
                    ),
                ) { operations ->
                    assertTrue(
                        operations.controlCommands.single().input is
                            AgentTranscriptLifecycleClientInput.StatusAvailable,
                    )
                },
                Case("live-entry-redacted", AgentTranscriptLifecycleTrustedIngress.Live) {
                    assertEquals(1, it.liveCommands.size)
                },
                Case("replay-page-lifecycle-and-entry", AgentTranscriptLifecycleTrustedIngress.Replay) {
                    assertTrue(it.replayCommands.single() is AgentTranscriptLifecycleDurableReplayPageCommand.Final)
                },
                Case("snapshot-page-materialized", AgentTranscriptLifecycleTrustedIngress.Snapshot) {
                    assertTrue(it.snapshotPageCommands.single() is AgentTranscriptLifecycleDurableSnapshotPageCommand.FinalPageCut)
                },
                Case("timeline-deleted-reset", AgentTranscriptLifecycleTrustedIngress.Live) {
                    assertTrue(
                        it.controlCommands.single().input is
                            AgentTranscriptLifecycleClientInput.TimelineReset,
                    )
                },
            )

            cases.forEach { case ->
                val harness = Harness(
                    sessionId = "session-1",
                    statusRequestId = "agent-status-1",
                    timelineEpoch = "timeline-1",
                )
                val result = harness.runtime.consume(
                    artifact(case.fixture),
                    harness.fence(ingress = case.ingress),
                )
                assertTrue(case.fixture, result is AgentTranscriptLifecycleRuntimeConsumeResult.Applied)
                assertEquals(case.fixture, 1, harness.lease.blockCount)
                case.assertDispatch(harness.operations)
            }
        }

    @Test
    fun `non-final replay and snapshot pages emit durable-prepared continuations`() = runBlocking {
        val replayFinal = artifact("replay-page-lifecycle-and-entry").frame
            as AgentTimelineReplayPageFrame
        val snapshotFinal = artifact("snapshot-page-materialized").frame
            as AgentTimelineSnapshotPageFrame
        val cases = listOf(
            PUBLIC_CODEC.decodePublicFrameArtifact(
                PUBLIC_CODEC.encodePublicFrame(
                    replayFinal.copy(
                        page = replayFinal.page.copy(
                            replayThroughAgentSeq = "12",
                            isLast = false,
                            nextCursor = "replay-cursor-next",
                        ),
                    ),
                ),
            ) to AgentTranscriptLifecycleTrustedIngress.Replay,
            PUBLIC_CODEC.decodePublicFrameArtifact(
                PUBLIC_CODEC.encodePublicFrame(
                    snapshotFinal.copy(
                        page = snapshotFinal.page.copy(
                            isLast = false,
                            nextCursor = "snapshot-cursor-next",
                        ),
                    ),
                ),
            ) to AgentTranscriptLifecycleTrustedIngress.Snapshot,
        )

        cases.forEach { (decoded, ingress) ->
            val harness = Harness(
                sessionId = "session-1",
                statusRequestId = "agent-status-1",
                timelineEpoch = "timeline-1",
            )
            val result = harness.runtime.consume(decoded, harness.fence(ingress = ingress))
                as AgentTranscriptLifecycleRuntimeConsumeResult.Applied
            val prepared = result.postCommitEffects.single()
                as AgentTranscriptLifecycleRuntimePostCommitEffect.PreparedRequest

            assertEquals("next-page-token", prepared.request.requestId)
            assertEquals(1, harness.operations.applyCount)
            when (ingress) {
                AgentTranscriptLifecycleTrustedIngress.Replay ->
                    assertTrue(
                        harness.operations.replayCommands.single() is
                            AgentTranscriptLifecycleDurableReplayPageCommand.NonFinal,
                    )
                AgentTranscriptLifecycleTrustedIngress.Snapshot ->
                    assertTrue(
                        harness.operations.snapshotPageCommands.single() is
                            AgentTranscriptLifecycleDurableSnapshotPageCommand.NonFinalStage,
                    )
                else -> error("Unexpected page ingress")
            }
        }
    }

    @Test
    fun `durable page gap emits extension resync effect without escaping consumer`() = runBlocking {
        val replayFinal = artifact("replay-page-lifecycle-and-entry").frame
            as AgentTimelineReplayPageFrame
        val decoded = PUBLIC_CODEC.decodePublicFrameArtifact(
            PUBLIC_CODEC.encodePublicFrame(
                replayFinal.copy(
                    page = replayFinal.page.copy(
                        replayThroughAgentSeq = "12",
                        isLast = false,
                        nextCursor = "replay-cursor-next",
                    ),
                ),
            ),
        )
        val harness = Harness(
            sessionId = "session-1",
            statusRequestId = "agent-status-1",
            timelineEpoch = "timeline-1",
        )
        harness.operations.forcedPageDirective = AgentTimelineSyncDirective.StatusRefresh

        val result = harness.runtime.consume(
            decoded,
            harness.fence(ingress = AgentTranscriptLifecycleTrustedIngress.Replay),
        ) as AgentTranscriptLifecycleRuntimeConsumeResult.Applied

        assertEquals(
            AgentTranscriptLifecycleRuntimePostCommitEffect.SyncRequired(
                AgentTimelineSyncDirective.StatusRefresh,
            ),
            result.postCommitEffects.single(),
        )
        assertEquals(1, harness.operations.applyCount)
    }

    @Test
    fun `strict artifact fence rejects route and lineage mismatch before lease`() = runBlocking {
        val harness = Harness(
            sessionId = "session-1",
            statusRequestId = "agent-status-1",
            timelineEpoch = "timeline-1",
        )
        val statusAvailable = fixtureWire("status-available")
        val cases = listOf(
            artifact(
                statusAvailable.replaceSingleField(
                    "\"sessionId\":\"session-1\"",
                    "\"sessionId\":\"session-other\"",
                ),
            ) to harness.fence(),
            artifact("status-available") to harness.fence(
                authority = harness.authority.copy(principalId = "principal-other"),
            ),
            artifact("status-available") to harness.fence(
                ingress = AgentTranscriptLifecycleTrustedIngress.Live,
            ),
            artifact("status-available") to harness.fence(requestAdmission = null),
            artifact(
                fixtureWire("live-entry-redacted").replaceSingleField(
                    "\"timelineEpoch\":\"timeline-1\"",
                    "\"timelineEpoch\":\"timeline-other\"",
                ),
            ) to harness.fence(ingress = AgentTranscriptLifecycleTrustedIngress.Live),
        )

        cases.forEach { (decoded, fence) ->
            assertEquals(
                AgentTranscriptLifecycleRuntimeConsumeResult.Unavailable(
                    AgentTranscriptLifecycleRuntimeUnavailableReason.EXACT_FENCE_MISMATCH,
                ),
                harness.runtime.consume(decoded, fence),
            )
        }
        assertEquals(0, harness.lease.blockCount)
        assertEquals(0, harness.operations.applyCount)
    }

    @Test
    fun `correlated extension errors close exact durable owner before post commit sync`() =
        runBlocking {
            data class ErrorCase(
                val code: AgentTimelineErrorCode,
                val requestKind: AgentTranscriptLifecycleRequestKind,
                val disposition: AgentTranscriptLifecycleRuntimeFaultDisposition,
            )
            val cases = listOf(
                ErrorCase(
                    AgentTimelineErrorCode.AGENT_TIMELINE_UNAVAILABLE,
                    AgentTranscriptLifecycleRequestKind.STATUS,
                    AgentTranscriptLifecycleRuntimeFaultDisposition.EXTENSION_UNAVAILABLE,
                ),
                ErrorCase(
                    AgentTimelineErrorCode.AGENT_CURSOR_EXPIRED,
                    AgentTranscriptLifecycleRequestKind.REPLAY,
                    AgentTranscriptLifecycleRuntimeFaultDisposition.RESYNC_EXTENSION,
                ),
                ErrorCase(
                    AgentTimelineErrorCode.AGENT_CURSOR_AHEAD,
                    AgentTranscriptLifecycleRequestKind.REPLAY,
                    AgentTranscriptLifecycleRuntimeFaultDisposition.RESYNC_EXTENSION,
                ),
                ErrorCase(
                    AgentTimelineErrorCode.AGENT_SNAPSHOT_EXPIRED,
                    AgentTranscriptLifecycleRequestKind.SNAPSHOT,
                    AgentTranscriptLifecycleRuntimeFaultDisposition.RESYNC_EXTENSION,
                ),
                ErrorCase(
                    AgentTimelineErrorCode.AGENT_TIMELINE_EPOCH_MISMATCH,
                    AgentTranscriptLifecycleRequestKind.REPLAY,
                    AgentTranscriptLifecycleRuntimeFaultDisposition.RESYNC_EXTENSION,
                ),
                ErrorCase(
                    AgentTimelineErrorCode.HOST_EPOCH_MISMATCH,
                    AgentTranscriptLifecycleRequestKind.REPLAY,
                    AgentTranscriptLifecycleRuntimeFaultDisposition.RESYNC_EXTENSION,
                ),
            )

            cases.forEachIndexed { index, case ->
                val harness = Harness(
                    sessionId = "session-1",
                    statusRequestId = "agent-status-1",
                )
                val requestId = "agent-error-${case.code.wireValue.lowercase()}"
                val frame = correlatedErrorFrame(requestId, case.code)
                val admission = harness.admission(case.requestKind, requestId, index + 1L)
                val result = harness.runtime.consume(
                    PUBLIC_CODEC.decodePublicFrameArtifact(
                        PUBLIC_CODEC.encodePublicFrame(frame),
                    ),
                    harness.fence(
                        ingress = AgentTranscriptLifecycleTrustedIngress.CorrelatedError(
                            case.requestKind,
                            requestId,
                        ),
                        requestAdmission = admission,
                    ),
                ) as AgentTranscriptLifecycleRuntimeConsumeResult.ExtensionFault

                assertEquals(case.code.wireValue, case.disposition, result.disposition)
                assertEquals(case.code.wireValue, case.requestKind, result.requestKind)
                assertEquals(case.code.wireValue, requestId, result.requestId)
                assertEquals(case.code.wireValue, AgentClientDisposition.GAP_RESYNC,
                    result.reduction.disposition)
                val preparedEffect = result.postCommitEffects.single() as
                    AgentTranscriptLifecycleRuntimePostCommitEffect.PreparedRequest
                val preparedStatus = preparedEffect.request as
                    AgentTranscriptLifecycleActorRequest.Status
                assertEquals(case.code.wireValue, "next-page-token", preparedStatus.requestId)
                assertEquals(
                    case.code.wireValue,
                    AgentLocalRequestFence("2", "next-page-token"),
                    preparedStatus.requestFence,
                )
                assertEquals(case.code.wireValue, 1, harness.lease.blockCount)
                assertEquals(case.code.wireValue, 1, harness.operations.applyCount)
                assertEquals(case.code.wireValue, listOf(admission), harness.handoff.accepted)
                assertEquals(
                    case.code.wireValue,
                    listOf(
                        AgentTranscriptLifecycleDurableRequestIdentity(
                            case.requestKind,
                            requestId,
                        ),
                    ),
                    harness.handoff.receipts.single().retiredRequests,
                )
                val command = harness.operations.correlatedErrorCommands.single()
                assertEquals(case.code.wireValue, case.requestKind, command.requestKind)
                assertEquals(case.code.wireValue, requestId, command.frame.requestId)
                assertEquals(
                    case.code.wireValue,
                    "next-page-token",
                    command.replacementStatusRequestNetworkToken,
                )
            }
        }

    @Test
    fun `correlated error transaction failure releases no handoff or sync effect`() = runBlocking {
        val harness = Harness(sessionId = "session-1", statusRequestId = "agent-status-1")
        val requestId = "agent-error-transaction-failure"
        val admission = harness.admission(AgentTranscriptLifecycleRequestKind.REPLAY, requestId)
        harness.operations.failCorrelatedError = true

        val failed = runCatching {
            harness.runtime.consume(
                PUBLIC_CODEC.decodePublicFrameArtifact(
                    PUBLIC_CODEC.encodePublicFrame(
                        correlatedErrorFrame(
                            requestId,
                            AgentTimelineErrorCode.AGENT_CURSOR_EXPIRED,
                        ),
                    ),
                ),
                harness.fence(
                    ingress = AgentTranscriptLifecycleTrustedIngress.CorrelatedError(
                        AgentTranscriptLifecycleRequestKind.REPLAY,
                        requestId,
                    ),
                    requestAdmission = admission,
                ),
            )
        }

        assertTrue(failed.isFailure)
        assertEquals(1, harness.lease.blockCount)
        assertEquals(0, harness.operations.applyCount)
        assertTrue(harness.handoff.accepted.isEmpty())
    }

    @Test
    fun `stale correlated admission produces zero durable handoff and effect`() = runBlocking {
        val harness = Harness(
            sessionId = "session-1",
            statusRequestId = "agent-status-1",
            timelineEpoch = "timeline-1",
            staleLease = true,
        )
        val admission = harness.admission(
            AgentTranscriptLifecycleRequestKind.STATUS,
            "agent-status-1",
        )

        val result = harness.runtime.consume(
            artifact("status-available"),
            harness.fence(requestAdmission = admission),
        )

        assertEquals(
            AgentTranscriptLifecycleRuntimeConsumeResult.Unavailable(
                AgentTranscriptLifecycleRuntimeUnavailableReason.STALE_GENERATION,
            ),
            result,
        )
        assertEquals(0, harness.operations.applyCount)
        assertTrue(harness.handoff.accepted.isEmpty())
    }

    @Test
    fun `composition is inert until explicit effects and shares its durable owner`() = runBlocking {
        val harness = Harness(
            sessionId = "session-1",
            statusRequestId = "agent-status-1",
            timelineEpoch = "timeline-1",
        )
        val failClosedPlatform = AgentTranscriptLifecycleNotificationPlatformPort {
            error("Platform must not be reached before an enabled negotiated frame")
        }
        val disabled = AgentTranscriptLifecycleRuntimeComposition(
            harness.lease,
            harness.operations,
            harness.handoff,
            failClosedPlatform,
        )
        val guarded = AgentTranscriptLifecycleRuntimeComposition(
            harness.lease,
            harness.operations,
            harness.handoff,
            failClosedPlatform,
            enabled = true,
        )
        suspend fun assertNotOwned(effect: RelayV2RuntimeEffect) = assertSame(
            effect,
            (guarded.handle(effect) as
                AgentTranscriptLifecycleRuntimeCompositionResult.NotOwned).effect,
        )
        val context = compositionHandshakeContext()
        val generation = RelayV2EffectGeneration("profile-1", 7, 11)
        val effect = RelayV2RuntimeEffect.DeliverAgentExtensionFrame(
            context = context,
            artifact = artifact("live-run-failed"),
            ingress = AgentTranscriptLifecycleTrustedIngress.Live,
            requestAdmission = null,
            generation = generation,
        )

        assertEquals(
            AgentTranscriptLifecycleRuntimeCompositionResult.Disabled,
            disabled.handle(effect),
        )
        assertNotOwned(
            RelayV2RuntimeEffect.Disconnected(
                context.profile,
                "not-agent-owned",
                generation,
                generation.connectionGeneration,
            ),
        )
        val failedAdmission = harness.admission(
            AgentTranscriptLifecycleRequestKind.STATUS,
            "agent-status-1",
        )
        val failedRequest = AgentTranscriptLifecycleDurablePreparedRequest.Status(
            AgentLocalRequestFence("1", "agent-status-1"),
        ).toActorRequest(harness.fence())
        val unavailable = RelayV2RuntimeEffect.AgentExtensionUnavailable(
            context = context,
            reason = RelayV2AgentExtensionUnavailableReason.REQUEST_TIMEOUT,
            failedRequest = failedRequest,
            requestAdmission = failedAdmission,
            generation = generation,
        )
        assertNotOwned(unavailable)
        assertEquals(
            AgentTranscriptLifecycleRuntimeCompositionResult.ExtensionNotNegotiated,
            guarded.handle(
                effect.copy(
                    context = compositionHandshakeContext(emptySet()),
                    repositoryAuthority = effect.repositoryAuthority,
                ),
            ),
        )

        harness.operations.compositionNamespace = harness.namespace
        val enabled = AgentTranscriptLifecycleRuntimeComposition(
            harness.lease,
            harness.operations,
            harness.handoff,
            AgentTranscriptLifecycleNotificationPlatformPort {
                AgentTranscriptLifecycleNotificationPlatformResult.Posted
            },
            enabled = true,
        )

        val handled = enabled.handle(effect)
            as AgentTranscriptLifecycleRuntimeCompositionResult.Consumed
        val consumption = handled.consumption
            as AgentTranscriptLifecycleRuntimeConsumeResult.Applied
        assertTrue(
            consumption.postCommitEffects.single() is
                AgentTranscriptLifecycleRuntimePostCommitEffect.SyncRequired,
        )
        assertEquals(
            listOf(
                AgentTranscriptLifecycleNotificationDispatchResult.Completed(
                    AgentTranscriptLifecycleNotificationExecutionResult.Platform(
                        AgentTranscriptLifecycleNotificationPlatformResult.Posted,
                    ),
                ),
            ),
            handled.notificationDispatches,
        )

        val read = enabled.read(compositionReadRequest(harness.namespace))
            as AgentTranscriptLifecycleReadState.Page
        assertEquals(harness.namespace, read.namespace)
    }

    private class Harness(
        sessionId: String,
        private val statusRequestId: String,
        timelineEpoch: String? = null,
        staleLease: Boolean = false,
    ) {
        val consumer = AgentTranscriptLifecycleDurableConsumerIdentity(
            profileId = "profile-1",
            profileActivationGeneration = 7,
            principalId = "principal-1",
            clientInstanceId = "client-1",
            hostId = "mac-admin",
            hostEpoch = "host-epoch-1",
            scopeId = "scope-local",
            sessionId = sessionId,
        )
        private val generation = RelayV2EffectGeneration("profile-1", 7, 11)
        val authority = RelayV2RepositoryEffectAuthority(
            generation = generation,
            profileId = "profile-1",
            profileActivationGeneration = 7,
            principalId = "principal-1",
            clientInstanceId = "client-1",
            hostId = "mac-admin",
            hostEpoch = "host-epoch-1",
        )
        val operations = RecordingDurableOperationPort()
        val lease = RecordingApplyLease(authority, staleLease)
        val handoff = RecordingDurableHandoff { lease.insideBlock }
        val runtime = AgentTranscriptLifecycleRuntimeConsumer(
            lease,
            operations,
            handoff,
            nextRequestToken = { "next-page-token" },
        )
        val namespace = AgentTranscriptLifecycleDurableNamespace(consumer, timelineEpoch)

        fun fence(
            negotiated: Boolean = true,
            authority: RelayV2RepositoryEffectAuthority = this.authority,
            ingress: AgentTranscriptLifecycleTrustedIngress =
                AgentTranscriptLifecycleTrustedIngress.CorrelatedStatus(
                    AgentLocalRequestFence("1", statusRequestId),
                ),
            requestAdmission: AgentTranscriptLifecycleRequestAdmission? =
                defaultAdmission(authority, ingress),
        ) = AgentTranscriptLifecycleRuntimeFence(
            authority = authority,
            expectedNamespace = namespace,
            negotiatedCapabilities = if (negotiated) {
                setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY)
            } else {
                emptySet()
            },
            ingress = ingress,
            requestAdmission = requestAdmission,
        )

        fun admission(
            requestKind: AgentTranscriptLifecycleRequestKind,
            requestId: String,
            sequence: Long = 1,
        ) = AgentTranscriptLifecycleRequestAdmission(
            authority = authority,
            requestKind = requestKind,
            requestId = requestId,
            admissionSequence = sequence,
        )

        private fun defaultAdmission(
            authority: RelayV2RepositoryEffectAuthority,
            ingress: AgentTranscriptLifecycleTrustedIngress,
        ): AgentTranscriptLifecycleRequestAdmission? {
            val (kind, requestId) = when (ingress) {
                is AgentTranscriptLifecycleTrustedIngress.CorrelatedStatus ->
                    AgentTranscriptLifecycleRequestKind.STATUS to ingress.requestFence.requestToken
                is AgentTranscriptLifecycleTrustedIngress.CorrelatedError ->
                    ingress.requestKind to ingress.requestId
                AgentTranscriptLifecycleTrustedIngress.Replay ->
                    AgentTranscriptLifecycleRequestKind.REPLAY to "agent-replay-1"
                AgentTranscriptLifecycleTrustedIngress.Snapshot ->
                    AgentTranscriptLifecycleRequestKind.SNAPSHOT to "agent-snapshot-attempt-1"
                AgentTranscriptLifecycleTrustedIngress.Live -> return null
            }
            return AgentTranscriptLifecycleRequestAdmission(
                authority,
                kind,
                requestId,
                1,
            )
        }
    }

    private companion object {
        val PUBLIC_CODEC = AgentTranscriptLifecycleV1Codec()
    }
}

private class RecordingApplyLease(
    private val expectedAuthority: RelayV2RepositoryEffectAuthority,
    private val stale: Boolean = false,
) : RelayV2RepositoryEffectApplyLeasePort {
    var blockCount: Int = 0
        private set
    var insideBlock: Boolean = false
        private set

    override suspend fun <T> withEffectApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        block: suspend () -> T,
    ): RelayV2EffectApplyResult<T> {
        check(authority == expectedAuthority)
        if (stale) return RelayV2EffectApplyResult.Stale
        blockCount += 1
        insideBlock = true
        return try {
            RelayV2EffectApplyResult.Applied(block())
        } finally {
            insideBlock = false
        }
    }
}

private class RecordingDurableOperationPort : AgentTranscriptLifecycleRuntimeDurableRepository {
    data class ApplyGate(
        val entered: CompletableDeferred<Unit> = CompletableDeferred(),
        val release: CompletableDeferred<Unit> = CompletableDeferred(),
    )

    val controlCommands = mutableListOf<AgentTranscriptLifecycleDurableControlCommand>()
    val liveCommands = mutableListOf<AgentTranscriptLifecycleDurableLiveEventCommand>()
    val correlatedErrorCommands =
        mutableListOf<AgentTranscriptLifecycleDurableCorrelatedErrorCommand>()
    val replayCommands = mutableListOf<AgentTranscriptLifecycleDurableReplayPageCommand>()
    val snapshotRequestCommands = mutableListOf<AgentTranscriptLifecycleDurableSnapshotRequestCommand>()
    val snapshotPageCommands = mutableListOf<AgentTranscriptLifecycleDurableSnapshotPageCommand>()
    val applyCount: Int
        get() = controlCommands.size + liveCommands.size + correlatedErrorCommands.size +
            replayCommands.size +
            snapshotRequestCommands.size + snapshotPageCommands.size
    private var nextApplyGate: ApplyGate? = null
    var forcedPageDirective: AgentTimelineSyncDirective? = null
    var failCorrelatedError: Boolean = false
    var compositionNamespace: AgentTranscriptLifecycleDurableNamespace? = null

    fun blockNextApply(): ApplyGate = ApplyGate().also { nextApplyGate = it }

    override suspend fun load(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ): AgentTranscriptLifecycleDurableRecord? {
        val namespace = compositionNamespace ?: return null
        if (namespace.consumer != consumer) return null
        return AgentTranscriptLifecycleDurableRecord(
            namespace,
            AgentTranscriptLifecycleClientState(namespace.consumer.sessionIdentity),
            AgentTranscriptDurableStorageAccounting.EMPTY,
        )
    }

    override suspend fun claimNotificationUnderApplyLease(
        expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
        intent: AgentSystemNotificationIntent,
    ): AgentTranscriptLifecycleNotificationClaimResult {
        if (expectedNamespace != compositionNamespace) {
            return AgentTranscriptLifecycleNotificationClaimResult.NotExecutable(
                AgentTranscriptLifecycleNotificationNotExecutableReason.NAMESPACE_CHANGED,
            )
        }
        return AgentTranscriptLifecycleNotificationClaimResult.Claimed(
            AgentTranscriptLifecycleNotificationExecutionTicket(
                "0123456789abcdef".repeat(4),
                expectedNamespace,
                intent,
            ),
        )
    }

    override suspend fun readRevisionPinnedPage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        cursor: AgentTranscriptLifecycleReadCursor?,
        limit: Int,
    ): AgentTranscriptLifecycleRevisionPinnedReadResult {
        require(limit in 1..AGENT_TRANSCRIPT_LIFECYCLE_READ_PAGE_LIMIT)
        if (cursor != null && cursor.namespace != namespace) {
            return AgentTranscriptLifecycleRevisionPinnedReadResult.NamespaceChanged
        }
        val storedNamespace = compositionNamespace
            ?: return AgentTranscriptLifecycleRevisionPinnedReadResult.Missing
        if (namespace != storedNamespace) {
            return AgentTranscriptLifecycleRevisionPinnedReadResult.NamespaceChanged
        }
        val revision = AgentTranscriptLifecycleReadRevision(
            namespace = storedNamespace,
            parentPayloadSha256 = "1".repeat(64),
            localGeneration = "1",
            materializedThroughAgentSeq = "14",
        )
        if (cursor != null && cursor.revision != revision) {
            return AgentTranscriptLifecycleRevisionPinnedReadResult.CursorRevisionChanged
        }
        return AgentTranscriptLifecycleRevisionPinnedReadResult.Page(
            revision = revision,
            items = emptyList(),
            nextCursor = null,
            endReached = true,
        )
    }

    override suspend fun prepareRequestUnderApplyLease(
        command: AgentTranscriptLifecycleDurablePrepareRequestCommand,
        limits: AgentClientReducerLimits,
    ) = error("Not used by runtime consumer")

    override suspend fun loadPreparedRequestsUnderApplyLease(
        fence: AgentTranscriptLifecycleDurableOperationFence,
    ) = error("Not used by runtime consumer")

    override suspend fun applyControlUnderApplyLease(
        command: AgentTranscriptLifecycleDurableControlCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult {
        awaitGate()
        controlCommands += command
        return reduction(command.fence)
    }

    override suspend fun consumeLiveEventUnderApplyLease(
        command: AgentTranscriptLifecycleDurableLiveEventCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult {
        liveCommands += command
        val reduced = reduction(command.fence)
        val decision = compositionNamespace?.let(::compositionNotificationDecision)
            ?: return reduced
        return reduced.copy(
            reduction = reduced.reduction.copy(
                notificationDecisions = listOf(decision),
                syncDirective = AgentTimelineSyncDirective.StatusRefresh,
            ),
        )
    }

    override suspend fun consumeCorrelatedErrorUnderApplyLease(
        command: AgentTranscriptLifecycleDurableCorrelatedErrorCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult {
        if (failCorrelatedError) error("correlated durable transaction failed")
        correlatedErrorCommands += command
        val reduced = reduction(
            command.fence,
            AgentTimelineSyncDirective.StatusRefresh,
            AgentClientDisposition.GAP_RESYNC,
        )
        val replacement = AgentLocalRequestFence(
            localGeneration = "2",
            requestToken = command.replacementStatusRequestNetworkToken,
        )
        return reduced.copy(
            reduction = reduced.reduction.copy(
                state = reduced.reduction.state.copy(
                    extensionLane = reduced.reduction.state.extensionLane.copy(
                        localGeneration = "2",
                        pendingStatusRequest = replacement,
                    ),
                ),
            ),
            preparedRequests = listOf(
                AgentTranscriptLifecycleDurablePreparedRequest.Status(replacement),
            ),
            retiredRequests = listOf(
                AgentTranscriptLifecycleDurableRequestIdentity(
                    command.requestKind,
                    command.frame.requestId,
                ),
            ),
        )
    }

    override suspend fun consumeReplayPageUnderApplyLease(
        command: AgentTranscriptLifecycleDurableReplayPageCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult {
        replayCommands += command
        return reduction(
            command.fence,
            forcedPageDirective ?: if (
                command is AgentTranscriptLifecycleDurableReplayPageCommand.NonFinal
            ) {
                AgentTimelineSyncDirective.Replay(
                    lineage = command.fence.expectedNamespace.lineage(),
                    afterAgentSeq = command.artifact.afterAgentSeq,
                    cursor = command.artifact.nextCursor,
                    limit = 256,
                )
            } else {
                AgentTimelineSyncDirective.None
            },
        )
    }

    override suspend fun persistSnapshotRequestUnderApplyLease(
        command: AgentTranscriptLifecycleDurableSnapshotRequestCommand,
    ): AgentTranscriptLifecycleDurableOperationResult {
        snapshotRequestCommands += command
        return reduction(command.fence)
    }

    override suspend fun consumeSnapshotPageUnderApplyLease(
        command: AgentTranscriptLifecycleDurableSnapshotPageCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult {
        snapshotPageCommands += command
        return reduction(
            command.fence,
            forcedPageDirective ?: if (
                command is AgentTranscriptLifecycleDurableSnapshotPageCommand.NonFinalStage
            ) {
                AgentTimelineSyncDirective.Snapshot(
                    command.fence.expectedNamespace.lineage(),
                )
            } else {
                AgentTimelineSyncDirective.None
            },
        )
    }

    private suspend fun awaitGate() {
        nextApplyGate?.also { gate ->
            nextApplyGate = null
            gate.entered.complete(Unit)
            gate.release.await()
        }
    }

    private fun reduction(
        fence: AgentTranscriptLifecycleDurableOperationFence,
        syncDirective: AgentTimelineSyncDirective = AgentTimelineSyncDirective.None,
        disposition: AgentClientDisposition = AgentClientDisposition.APPLIED,
    ) = AgentTranscriptLifecycleDurableOperationResult(
        AgentTranscriptLifecycleClientReduction(
            state = AgentTranscriptLifecycleClientState(
                fence.expectedNamespace.consumer.sessionIdentity,
            ),
            disposition = disposition,
            syncDirective = syncDirective,
        ),
    )
}

private class RecordingDurableHandoff(
    private val insideApplyLease: () -> Boolean,
) : AgentTranscriptLifecycleDurableHandoffPort {
    val accepted = mutableListOf<AgentTranscriptLifecycleRequestAdmission>()
    val singleReceipts = mutableListOf<AgentTranscriptLifecycleCompletedHandoffReceipt>()
    val receipts = mutableListOf<AgentTranscriptLifecycleCompletedBatchHandoffReceipt>()
    var accept = true

    override fun acceptDurableHandoff(
        receipt: AgentTranscriptLifecycleCompletedHandoffReceipt,
    ): Boolean {
        check(insideApplyLease()) { "durable handoff escaped the apply lease" }
        if (accept) {
            singleReceipts += receipt
            accepted += receipt.admission
        }
        return accept
    }

    override fun acceptDurableHandoff(
        receipt: AgentTranscriptLifecycleCompletedBatchHandoffReceipt,
    ): Boolean {
        check(insideApplyLease()) { "durable handoff escaped the apply lease" }
        if (accept) {
            receipts += receipt
            accepted += receipt.triggeringAdmission
        }
        return accept
    }

    override fun replaceForExactRedrive(
        replacement: AgentTranscriptLifecycleExactRedriveReplacement,
    ): AgentTranscriptLifecycleRequestAdmission? = error("runtime consumer cannot redrive")
}

private fun AgentTranscriptLifecycleDurableNamespace.lineage(): AgentTimelineLineage =
    AgentTimelineLineage(consumer.sessionIdentity, requireNotNull(timelineEpoch))

private fun compositionNotificationDecision(
    namespace: AgentTranscriptLifecycleDurableNamespace,
): AgentNotificationDecision {
    val witness = AgentLifecycleEventIdentityWitness(
        eventId = "event-14",
        agentEventSeq = "14",
        lifecycleIdentity = AgentLifecycleIdentity(
            AgentLifecycleScope.RUN,
            "run-startup",
            null,
        ),
        sourceEpoch = "source-startup",
        state = AgentLifecycleState.FAILED,
        failure = AgentLifecycleFailure("agent_start_failed", null),
        occurredAtMs = 1_783_700_900_000,
        closedEventDigest = null,
    )
    val consumer = namespace.consumer
    val key = AgentNotificationDedupeKey(
        profileId = consumer.profileId,
        hostId = consumer.hostId,
        hostEpoch = consumer.hostEpoch,
        scopeId = consumer.scopeId,
        sessionId = consumer.sessionId,
        timelineEpoch = requireNotNull(namespace.timelineEpoch),
        lifecycleEventId = witness.eventId,
        state = witness.state,
    )
    val intent = AgentSystemNotificationIntent(key, localGeneration = "1")
    return AgentNotificationDecision(
        dedupeKey = key,
        ledgerEntry = AgentNotificationLedgerEntry(
            disposition = AgentNotificationDisposition.SHOWN,
            eventIdentity = witness,
            localGeneration = "1",
        ),
        systemNotificationIntent = intent,
    )
}

private fun compositionReadRequest(namespace: AgentTranscriptLifecycleDurableNamespace) =
    AgentTranscriptLifecycleReadRequest(
        selectedNamespace = namespace,
        access = AgentTranscriptLifecycleReadAccess(
            dialect = AgentTranscriptLifecycleReadDialect.RELAY_V2,
            negotiatedCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
            support = AgentExtensionSupport.AVAILABLE,
            activeNamespace = namespace,
        ),
        limit = 16,
    )

private fun compositionHandshakeContext(
    negotiatedCapabilities: Set<String> = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
) = RelayV2HandshakeContext(
    profile = RelayActiveProfileIdentity("profile-1", RelayProfileDialect.V2, 7),
    principalId = "principal-1",
    clientInstanceId = "client-1",
    hostId = "mac-admin",
    brokerEpoch = "broker-epoch-1",
    hostEpoch = "host-epoch-1",
    hostInstanceId = "host-instance-1",
    eventSeq = "10",
    negotiatedCapabilities = negotiatedCapabilities,
    negotiatedLimits = RelayV2NegotiatedLimits(
        1_048_576, 1_500_000, 1_048_576, 524_288, 256, 64, 32, 262_144,
        256, 67_108_864, 100_000, 4_194_304, 16_777_216, 1_048_576, 262_144,
        emptyMap(),
    ),
    commandDedupeWindow = RelayV2CommandDedupeWindow("window-agent", "1", 1_000, 2_000),
)

private fun correlatedErrorFrame(
    requestId: String,
    code: AgentTimelineErrorCode,
): AgentTimelineErrorFrame {
    val hostEpoch = if (code == AgentTimelineErrorCode.HOST_EPOCH_MISMATCH) {
        "host-epoch-2"
    } else {
        "host-epoch-1"
    }
    return AgentTimelineErrorFrame(
        requestId = requestId,
        hostId = "mac-admin",
        hostEpoch = hostEpoch,
        scopeId = "scope-local",
        sessionId = "session-1",
        error = AgentTimelineStructuredError(
            code = code,
            message = "extension request failed",
            retryable = false,
            commandDisposition = AgentTimelineErrorCommandDisposition.NOT_APPLICABLE,
            details = if (code == AgentTimelineErrorCode.HOST_EPOCH_MISMATCH) {
                AgentTimelineHostEpochMismatchDetails(
                    expectedHostEpoch = "host-epoch-1",
                    actualHostEpoch = hostEpoch,
                )
            } else {
                null
            },
        ),
    )
}

private fun artifact(name: String): AgentTranscriptLifecycleV1PublicFrameArtifact =
    artifact(fixtureWire(name))

private fun artifact(wire: ByteArray): AgentTranscriptLifecycleV1PublicFrameArtifact =
    AgentTranscriptLifecycleV1Codec().decodePublicFrameArtifact(wire)

private fun fixtureWire(name: String): ByteArray {
    val resource = "extensions/agent-transcript-lifecycle/v1/golden-frames.json"
    val source = requireNotNull(
        AgentTranscriptLifecycleRuntimeConsumerTest::class.java.classLoader
            ?.getResourceAsStream(resource),
    ).bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
    val wrapper = RelayV2StrictJson.parseObject(
        "{\"fixtures\":$source}",
        RelayV2JsonLimits(64, 1_024, 100_000, 200_000),
    )
    val fixtures = wrapper["fixtures"] as List<*>
    val fixture = fixtures.filterIsInstance<Map<String, Any?>>()
        .single { it["name"] == name }
    return (fixture["wire"] as String).toByteArray(StandardCharsets.UTF_8)
}

private fun ByteArray.replaceSingleField(
    original: String,
    replacement: String,
): ByteArray {
    val source = toString(StandardCharsets.UTF_8)
    val first = source.indexOf(original)
    assertTrue("fixture must contain $original", first >= 0)
    assertEquals("fixture field must be unique", first, source.lastIndexOf(original))
    val changed = source.replace(original, replacement)
    assertFalse("fixture bytes must change", source == changed)
    return changed.toByteArray(StandardCharsets.UTF_8)
}
