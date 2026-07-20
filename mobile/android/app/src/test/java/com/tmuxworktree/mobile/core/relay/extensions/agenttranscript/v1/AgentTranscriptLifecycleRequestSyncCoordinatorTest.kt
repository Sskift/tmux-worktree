package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectApplyResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectGeneration
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectApplyLeasePort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentTranscriptLifecycleRequestSyncCoordinatorTest {
    @Test
    fun `unnegotiated request has zero durable operation and zero actor send`() = runBlocking {
        val harness = CoordinatorHarness()
        val fence = harness.fence(negotiated = false)

        val result = harness.coordinator.requestStatus(fence)
        val resumed = harness.coordinator.resumePersistedRequests(fence)

        assertEquals(AgentTranscriptLifecycleRequestSyncResult.ExtensionNotNegotiated, result)
        assertEquals(
            listOf(AgentTranscriptLifecycleRequestSyncResult.ExtensionNotNegotiated),
            resumed,
        )
        assertEquals(0, harness.operations.applyCount)
        assertEquals(0, harness.operations.preparedReadCount)
        assertTrue(harness.sent.isEmpty())
    }

    @Test
    fun `durable handoff receipt rejects more identities than one transaction can retire`() {
        val authority = CoordinatorHarness().fence().authority
        val admission = AgentTranscriptLifecycleRequestAdmission(
            authority,
            AgentTranscriptLifecycleRequestKind.STATUS,
            "status-current",
            1,
        )

        val failure = runCatching {
            AgentTranscriptLifecycleCompletedBatchHandoffReceipt(
                authority = authority,
                scopeId = "scope-local",
                sessionId = "session-1",
                triggeringAdmission = admission,
                retiredRequests = listOf(
                    AgentTranscriptLifecycleDurableRequestIdentity(
                        AgentTranscriptLifecycleRequestKind.STATUS,
                        "status-current",
                    ),
                    AgentTranscriptLifecycleDurableRequestIdentity(
                        AgentTranscriptLifecycleRequestKind.REPLAY,
                        "replay-sibling",
                    ),
                    AgentTranscriptLifecycleDurableRequestIdentity(
                        AgentTranscriptLifecycleRequestKind.SNAPSHOT,
                        "snapshot-sibling",
                    ),
                ),
            )
        }.exceptionOrNull()

        assertTrue(failure is IllegalArgumentException)
    }

    @Test
    fun `status replay and snapshot tokens commit before actor send`() = runBlocking {
        val harness = CoordinatorHarness(
            tokens = ArrayDeque(
                listOf(
                    "status-token-1",
                    "replay-token-1",
                    "snapshot-logical-1",
                    "snapshot-page-1",
                ),
            ),
        )
        val lineage = AgentTimelineLineage(harness.consumer.sessionIdentity, "timeline-1")

        val status = harness.coordinator.requestStatus(harness.fence())
        val replay = harness.coordinator.requestReplay(
            harness.fence(),
            AgentTimelineSyncDirective.Replay(lineage, "8", null, 256),
        )
        val snapshot = harness.coordinator.requestSnapshot(
            harness.fence(),
            AgentTimelineSyncDirective.Snapshot(lineage),
        )

        assertTrue(status is AgentTranscriptLifecycleRequestSyncResult.Dispatched)
        assertTrue(replay is AgentTranscriptLifecycleRequestSyncResult.Dispatched)
        assertTrue(snapshot is AgentTranscriptLifecycleRequestSyncResult.Dispatched)
        assertEquals(
            listOf("status-token-1", "replay-token-1", "snapshot-page-1"),
            harness.sent.map { it.requestId },
        )
        assertEquals(harness.sent.map { it.requestId }.toSet(), harness.operations.committedTokens)
        assertEquals(3, harness.operations.applyCount)
        assertFalse(harness.lease.insideBlock)
    }

    @Test
    fun `post commit retry and reconnect reuse exact replay and snapshot identities`() =
        runBlocking {
            val harness = CoordinatorHarness(
                tokens = ArrayDeque(),
                admitSends = false,
            )
            val lineage = AgentTimelineLineage(harness.consumer.sessionIdentity, "timeline-1")
            val resumeContext = harness.resumeContext()

            val empty = harness.coordinator.resumePersistedRequests(resumeContext)
            assertTrue(empty.isEmpty())
            assertTrue(harness.sent.isEmpty())

            harness.operations.seedPrepared(
                AgentTranscriptLifecycleDurablePreparedRequest.Replay(
                    lineage = lineage,
                    pageFence = AgentReplayPageFence(
                        localGeneration = "1",
                        stableAfterAgentSeq = "8",
                        currentRequestNetworkToken = "replay-exact-token",
                        pinnedReplayThroughAgentSeq = "12",
                        expectedNextCursor = "replay-exact-cursor",
                        requestedLimit = 256,
                    ),
                ),
                AgentTranscriptLifecycleDurablePreparedRequest.Snapshot(
                    lineage = lineage,
                    snapshotRequestId = "snapshot-exact-id",
                    requestNetworkToken = "snapshot-exact-page-token",
                    snapshotId = "snapshot-cut-exact",
                    cursor = "snapshot-exact-cursor",
                    nextPageIndex = 1,
                ),
            )

            val postCommitCrash = harness.coordinator.resumePersistedRequests(resumeContext)
            assertTrue(
                postCommitCrash.all {
                    it is AgentTranscriptLifecycleRequestSyncResult.Dispatched &&
                        it.admission == null
                },
            )

            harness.admitSends = true
            val firstReconnect = harness.coordinator.resumePersistedRequests(resumeContext)
            val secondReconnect = harness.coordinator.resumePersistedRequests(resumeContext)

            assertTrue(
                firstReconnect.all {
                    it is AgentTranscriptLifecycleRequestSyncResult.Dispatched &&
                        it.admission != null
                },
            )
            assertTrue(
                secondReconnect.all {
                    it is AgentTranscriptLifecycleRequestSyncResult.Dispatched &&
                        it.admission != null
                },
            )
            val replayRequests = harness.sent
                .filterIsInstance<AgentTranscriptLifecycleActorRequest.Replay>()
            assertEquals(3, replayRequests.size)
            assertEquals(setOf("replay-exact-token"), replayRequests.map { it.requestId }.toSet())
            assertEquals(
                setOf("replay-exact-cursor"),
                replayRequests.map { it.frame.request.cursor }.toSet(),
            )
            val snapshotRequests = harness.sent
                .filterIsInstance<AgentTranscriptLifecycleActorRequest.Snapshot>()
            assertEquals(3, snapshotRequests.size)
            assertEquals(
                setOf("snapshot-exact-page-token"),
                snapshotRequests.map { it.requestId }.toSet(),
            )
            assertEquals(
                setOf("snapshot-exact-id"),
                snapshotRequests.map { it.frame.request.snapshotRequestId }.toSet(),
            )
            assertEquals(
                setOf("snapshot-cut-exact"),
                snapshotRequests.map { it.frame.request.snapshotId }.toSet(),
            )
            assertEquals(
                setOf("snapshot-exact-cursor"),
                snapshotRequests.map { it.frame.request.cursor }.toSet(),
            )
            assertEquals(setOf(1L), snapshotRequests.map { it.frame.request.nextPageIndex }.toSet())
            assertEquals(
                setOf("replay-exact-token", "snapshot-exact-page-token"),
                harness.operations.committedTokens,
            )
            assertEquals(0, harness.operations.applyCount)
            assertEquals(4, harness.operations.preparedReadCount)
            assertFalse(harness.lease.insideBlock)
        }

    @Test
    fun `failed admission is atomically replaced from exact prepared request`() = runBlocking {
        val harness = CoordinatorHarness(admitSends = false)
        val lineage = AgentTimelineLineage(harness.consumer.sessionIdentity, "timeline-1")
        harness.operations.seedPrepared(
            AgentTranscriptLifecycleDurablePreparedRequest.Replay(
                lineage = lineage,
                pageFence = AgentReplayPageFence(
                    localGeneration = "1",
                    stableAfterAgentSeq = "8",
                    currentRequestNetworkToken = "replay-failed-token",
                    pinnedReplayThroughAgentSeq = "12",
                    expectedNextCursor = "replay-failed-cursor",
                    requestedLimit = 256,
                ),
            ),
        )
        val failedRequest = (
            harness.coordinator.resumePersistedRequests(harness.fence()).single()
                as AgentTranscriptLifecycleRequestSyncResult.Dispatched
            ).request
        val failedAdmission = AgentTranscriptLifecycleRequestAdmission(
            failedRequest.authority,
            failedRequest.kind,
            failedRequest.requestId,
            91,
        )

        val retry = harness.coordinator.retryFailedAdmission(
            harness.fence(),
            failedRequest,
            failedAdmission,
        ) as AgentTranscriptLifecycleRequestSyncResult.Dispatched
        assertTrue(retry.admission != null)
        assertEquals(1, harness.sent.size)
        assertEquals(
            listOf(
                AgentTranscriptLifecycleExactRedriveReplacement(
                    oldAdmission = failedAdmission,
                    exactRequest = failedRequest,
                ),
            ),
            harness.handoff.replacements,
        )
        assertFalse(harness.lease.insideBlock)
        assertEquals(failedRequest.requestId, retry.request.requestId)
        assertEquals(failedRequest.requestId, retry.admission?.requestId)
        assertEquals(setOf("replay-failed-token"), harness.operations.committedTokens)
    }

    @Test
    fun `stale generation cannot persist send or release notification`() = runBlocking {
        val harness = CoordinatorHarness(staleLease = true)

        val result = harness.coordinator.requestStatus(harness.fence())
        val resumed = harness.coordinator.resumePersistedRequests(harness.resumeContext())
        val notification = harness.coordinator.dispatchPostCommitEffect(
            harness.fence(),
            AgentTranscriptLifecycleRuntimePostCommitEffect.Notification(
                AgentSystemNotificationIntent(
                    dedupeKey = AgentNotificationDedupeKey(
                        profileId = harness.consumer.profileId,
                        hostId = harness.consumer.hostId,
                        hostEpoch = harness.consumer.hostEpoch,
                        scopeId = harness.consumer.scopeId,
                        sessionId = harness.consumer.sessionId,
                        timelineEpoch = "timeline-1",
                        lifecycleEventId = "event-stale",
                        state = AgentLifecycleState.WAITING_FOR_USER,
                    ),
                    localGeneration = "1",
                ),
            ),
        )

        assertEquals(AgentTranscriptLifecycleRequestSyncResult.StaleGeneration, result)
        assertEquals(
            listOf(AgentTranscriptLifecycleRequestSyncResult.StaleGeneration),
            resumed,
        )
        assertEquals(AgentTranscriptLifecycleRequestSyncResult.StaleGeneration, notification)
        assertEquals(0, harness.operations.applyCount)
        assertTrue(harness.sent.isEmpty())
    }

    private class CoordinatorHarness(
        tokens: ArrayDeque<String> = ArrayDeque(listOf("status-token")),
        staleLease: Boolean = false,
        admitSends: Boolean = true,
    ) {
        val consumer = AgentTranscriptLifecycleDurableConsumerIdentity(
            profileId = "profile-1",
            profileActivationGeneration = 7,
            principalId = "principal-1",
            clientInstanceId = "client-1",
            hostId = "mac-admin",
            hostEpoch = "host-epoch-1",
            scopeId = "scope-local",
            sessionId = "session-1",
        )
        private val generation = RelayV2EffectGeneration("profile-1", 7, 11)
        private val authority = RelayV2RepositoryEffectAuthority(
            generation = generation,
            profileId = "profile-1",
            profileActivationGeneration = 7,
            principalId = "principal-1",
            clientInstanceId = "client-1",
            hostId = "mac-admin",
            hostEpoch = "host-epoch-1",
        )
        val lease = CoordinatorApplyLease(authority, staleLease)
        val operations = CoordinatorDurableOperations(consumer, lease)
        val handoff = CoordinatorDurableHandoff(lease)
        val sent = mutableListOf<AgentTranscriptLifecycleActorRequest>()
        var admitSends: Boolean = admitSends
        private var admissionSequence = 0L
        val coordinator = AgentTranscriptLifecycleRequestSyncCoordinator(
            applyLease = lease,
            durableRepository = operations,
            requestSender = AgentTranscriptLifecycleExtensionRequestSender { request ->
                check(!lease.insideBlock) { "actor send happened before apply lease committed" }
                check(request.requestId in operations.committedTokens) {
                    "actor send happened before its request token committed"
                }
                sent += request
                if (!this@CoordinatorHarness.admitSends) {
                    return@AgentTranscriptLifecycleExtensionRequestSender null
                }
                admissionSequence += 1
                AgentTranscriptLifecycleRequestAdmission(
                    request.authority,
                    request.kind,
                    request.requestId,
                    admissionSequence,
                )
            },
            durableHandoff = handoff,
            requestToken = { tokens.removeFirst() },
        )

        fun fence(negotiated: Boolean = true) = AgentTranscriptLifecycleRuntimeFence(
            authority = authority,
            expectedNamespace = AgentTranscriptLifecycleDurableNamespace(
                consumer,
                "timeline-1",
            ),
            negotiatedCapabilities = if (negotiated) {
                setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY)
            } else {
                emptySet()
            },
            ingress = AgentTranscriptLifecycleTrustedIngress.Live,
        )

        fun resumeContext() = AgentTranscriptLifecyclePersistedRequestResumeContext(
            authority = authority,
            expectedNamespace = AgentTranscriptLifecycleDurableNamespace(
                consumer,
                "timeline-1",
            ),
        )
    }
}

private class CoordinatorDurableHandoff(
    private val lease: CoordinatorApplyLease,
) : AgentTranscriptLifecycleDurableHandoffPort {
    val replacements = mutableListOf<AgentTranscriptLifecycleExactRedriveReplacement>()
    private var replacementSequence = 1_000L

    override fun acceptDurableHandoff(
        receipt: AgentTranscriptLifecycleCompletedHandoffReceipt,
    ): Boolean {
        check(lease.insideBlock) { "durable handoff escaped the apply lease" }
        return true
    }

    override fun acceptDurableHandoff(
        receipt: AgentTranscriptLifecycleCompletedBatchHandoffReceipt,
    ): Boolean {
        check(lease.insideBlock) { "durable handoff escaped the apply lease" }
        return true
    }

    override fun replaceForExactRedrive(
        replacement: AgentTranscriptLifecycleExactRedriveReplacement,
    ): AgentTranscriptLifecycleRequestAdmission? {
        check(lease.insideBlock) { "durable redrive escaped the apply lease" }
        replacements += replacement
        replacementSequence += 1
        return AgentTranscriptLifecycleRequestAdmission(
            authority = replacement.exactRequest.authority,
            requestKind = replacement.exactRequest.kind,
            requestId = replacement.exactRequest.requestId,
            admissionSequence = replacementSequence,
        )
    }
}

private class CoordinatorApplyLease(
    private val expectedAuthority: RelayV2RepositoryEffectAuthority,
    private val stale: Boolean,
) : RelayV2RepositoryEffectApplyLeasePort {
    var insideBlock: Boolean = false
        private set

    override suspend fun <T> withEffectApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        block: suspend () -> T,
    ): RelayV2EffectApplyResult<T> {
        check(authority == expectedAuthority)
        if (stale) return RelayV2EffectApplyResult.Stale
        insideBlock = true
        return try {
            RelayV2EffectApplyResult.Applied(block())
        } finally {
            insideBlock = false
        }
    }
}

private class CoordinatorDurableOperations(
    private val consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    private val lease: CoordinatorApplyLease,
) : AgentTranscriptLifecycleDurableOperationPort {
    val committedTokens = linkedSetOf<String>()
    private val prepared = linkedMapOf<
        AgentTranscriptLifecycleRequestKind,
        AgentTranscriptLifecycleDurablePreparedRequest,
        >()
    var applyCount = 0
        private set
    var preparedReadCount = 0
        private set

    fun seedPrepared(vararg requests: AgentTranscriptLifecycleDurablePreparedRequest) {
        requests.forEach { request ->
            prepared[request.requestKind] = request
            committedTokens += request.requestNetworkToken
        }
    }

    override suspend fun prepareRequestUnderApplyLease(
        command: AgentTranscriptLifecycleDurablePrepareRequestCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurablePrepareRequestResult {
        check(lease.insideBlock)
        applyCount += 1
        val existing = prepared[command.requestKind]
        if (existing != null) {
            return AgentTranscriptLifecycleDurablePrepareRequestResult(
                reductionForPrepared(existing),
                existing,
            )
        }
        val next = when (command) {
            is AgentTranscriptLifecycleDurablePrepareRequestCommand.Status -> {
                committedTokens += command.proposedRequestNetworkToken
                AgentTranscriptLifecycleDurablePreparedRequest.Status(
                    AgentLocalRequestFence("1", command.proposedRequestNetworkToken),
                )
            }
            is AgentTranscriptLifecycleDurablePrepareRequestCommand.Replay -> {
                committedTokens += command.proposedRequestNetworkToken
                AgentTranscriptLifecycleDurablePreparedRequest.Replay(
                    command.directive.lineage,
                    AgentReplayPageFence(
                        localGeneration = "1",
                        stableAfterAgentSeq = command.directive.afterAgentSeq,
                        currentRequestNetworkToken = command.proposedRequestNetworkToken,
                        pinnedReplayThroughAgentSeq = null,
                        expectedNextCursor = command.directive.cursor,
                        requestedLimit = command.directive.limit,
                    ),
                )
            }
            is AgentTranscriptLifecycleDurablePrepareRequestCommand.Snapshot -> {
                committedTokens += command.proposedPageZeroNetworkToken
                AgentTranscriptLifecycleDurablePreparedRequest.Snapshot(
                    lineage = command.directive.lineage,
                    snapshotRequestId = command.proposedSnapshotRequestId,
                    requestNetworkToken = command.proposedPageZeroNetworkToken,
                    snapshotId = null,
                    cursor = null,
                    nextPageIndex = 0,
                )
            }
        }
        prepared[next.requestKind] = next
        return AgentTranscriptLifecycleDurablePrepareRequestResult(
            reductionForPrepared(next),
            next,
        )
    }

    override suspend fun loadPreparedRequestsUnderApplyLease(
        fence: AgentTranscriptLifecycleDurableOperationFence,
    ): List<AgentTranscriptLifecycleDurablePreparedRequest> {
        check(lease.insideBlock)
        check(fence.authority == consumer)
        check(fence.expectedNamespace.consumer == consumer)
        preparedReadCount += 1
        return prepared.values.toList()
    }

    override suspend fun applyControlUnderApplyLease(
        command: AgentTranscriptLifecycleDurableControlCommand,
        limits: AgentClientReducerLimits,
    ): AgentTranscriptLifecycleDurableOperationResult {
        check(lease.insideBlock)
        applyCount += 1
        return when (val input = command.input) {
            is AgentTranscriptLifecycleClientInput.StatusRequestStarted -> {
                committedTokens += input.requestNetworkToken
                reduction(
                    AgentTranscriptLifecycleExtensionState(
                        localGeneration = "1",
                        support = AgentExtensionSupport.UNKNOWN,
                        unavailableReason = null,
                        pendingStatusRequest = AgentLocalRequestFence(
                            "1",
                            input.requestNetworkToken,
                        ),
                    ),
                )
            }
            is AgentTranscriptLifecycleClientInput.ReplayRequestStarted -> {
                committedTokens += input.requestNetworkToken
                reduction(
                    availableState(
                        AgentTimelineSyncState.Replay(
                            observedCurrentAgentSeq = "8",
                            observedStatusEarliestReplaySeq = "1",
                            pageFence = AgentReplayPageFence(
                                localGeneration = "1",
                                stableAfterAgentSeq = "8",
                                currentRequestNetworkToken = input.requestNetworkToken,
                                pinnedReplayThroughAgentSeq = null,
                                expectedNextCursor = input.cursor,
                                requestedLimit = input.limit,
                            ),
                        ),
                    ),
                )
            }
            else -> error("Unexpected coordinator control input: $input")
        }
    }

    override suspend fun persistSnapshotRequestUnderApplyLease(
        command: AgentTranscriptLifecycleDurableSnapshotRequestCommand,
    ): AgentTranscriptLifecycleDurableOperationResult {
        check(lease.insideBlock)
        applyCount += 1
        committedTokens += command.pageZeroNetworkToken
        return reduction(
            availableState(
                syncState = AgentTimelineSyncState.Snapshot,
                pendingSnapshotRequest = AgentSnapshotPreFirstFence(
                    localGeneration = "1",
                    snapshotRequestId = command.snapshotRequestId,
                    pageZeroNetworkToken = command.pageZeroNetworkToken,
                ),
            ),
        )
    }

    override suspend fun consumeLiveEventUnderApplyLease(
        command: AgentTranscriptLifecycleDurableLiveEventCommand,
        limits: AgentClientReducerLimits,
    ) = error("Not used by request coordinator")

    override suspend fun consumeCorrelatedErrorUnderApplyLease(
        command: AgentTranscriptLifecycleDurableCorrelatedErrorCommand,
        limits: AgentClientReducerLimits,
    ) = error("Not used by request coordinator")

    override suspend fun consumeReplayPageUnderApplyLease(
        command: AgentTranscriptLifecycleDurableReplayPageCommand,
        limits: AgentClientReducerLimits,
    ) = error("Not used by request coordinator")

    override suspend fun consumeSnapshotPageUnderApplyLease(
        command: AgentTranscriptLifecycleDurableSnapshotPageCommand,
        limits: AgentClientReducerLimits,
    ) = error("Not used by request coordinator")

    private fun availableState(
        syncState: AgentTimelineSyncState,
        pendingSnapshotRequest: AgentSnapshotPreFirstFence? = null,
    ) = AgentTranscriptLifecycleExtensionState(
        localGeneration = "1",
        support = AgentExtensionSupport.AVAILABLE,
        unavailableReason = null,
        liveSource = AgentLiveSourceState.CONNECTED,
        activeSourceEpoch = "source-1",
        timelineEpoch = "timeline-1",
        lastAgentSeq = "8",
        effectiveHostLimits = AgentTimelineEffectiveLimits.intersect(
            maxTextUtf8Bytes = 65_536,
            maxPageRecords = 256,
            eventReplayRetentionMs = 604_800_000,
            snapshotLeaseMs = 300_000,
        ),
        syncState = syncState,
        pendingSnapshotRequest = pendingSnapshotRequest,
    )

    private fun reduction(
        extensionState: AgentTranscriptLifecycleExtensionState,
    ) = AgentTranscriptLifecycleDurableOperationResult(
        AgentTranscriptLifecycleClientReduction(
            state = AgentTranscriptLifecycleClientState(consumer.sessionIdentity, extensionState),
            disposition = AgentClientDisposition.CONFIG_APPLIED,
        ),
    )

    private fun reductionForPrepared(
        request: AgentTranscriptLifecycleDurablePreparedRequest,
    ): AgentTranscriptLifecycleClientReduction = when (request) {
        is AgentTranscriptLifecycleDurablePreparedRequest.Status ->
            reduction(
                AgentTranscriptLifecycleExtensionState(
                    localGeneration = "1",
                    support = AgentExtensionSupport.UNKNOWN,
                    unavailableReason = null,
                    pendingStatusRequest = request.requestFence,
                ),
            ).reduction
        is AgentTranscriptLifecycleDurablePreparedRequest.Replay ->
            reduction(availableState(AgentTimelineSyncState.Replay(
                observedCurrentAgentSeq = "8",
                observedStatusEarliestReplaySeq = "1",
                pageFence = request.pageFence,
            ))).reduction
        is AgentTranscriptLifecycleDurablePreparedRequest.Snapshot ->
            reduction(availableState(
                syncState = AgentTimelineSyncState.Snapshot,
                pendingSnapshotRequest = AgentSnapshotPreFirstFence(
                    localGeneration = "1",
                    snapshotRequestId = request.snapshotRequestId,
                    pageZeroNetworkToken = request.requestNetworkToken,
                ),
            )).reduction
    }
}
