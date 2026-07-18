package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageException
import java.lang.reflect.Proxy
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentTranscriptLifecycleReadProjectionTest {
    @Test
    fun continuationRevisionChangeReturnsNoContentWithoutMaterializedRead() = runBlocking {
        val namespace = readNamespace()
        val state = operationalReadState(namespace.consumer)
        val parent = AgentTranscriptLifecyclePersistedState(
            namespace,
            AgentTranscriptLifecycleDurableStateCodec.encode(
                namespace,
                state,
                AgentTranscriptDurableStorageAccounting.EMPTY,
            ),
        )
        val store = ParentOnlyDurableStore(parent)
        val core = AgentTranscriptLifecycleDurableRepositoryCore(store)
        val staleRevision = readRevision(namespace).copy(
            parentPayloadSha256 = "0".repeat(64),
        )

        val result = core.readRevisionPinnedPage(
            namespace = namespace,
            cursor = AgentTranscriptLifecycleReadCursor(
                staleRevision,
                "1",
                AgentTranscriptLifecycleReadRecordKind.ENTRY,
                "entry-stale",
            ),
            limit = 10,
        )

        assertEquals(
            AgentTranscriptLifecycleRevisionPinnedReadResult.CursorRevisionChanged,
            result,
        )
        assertEquals(0, store.materializedReads)
    }

    @Test
    fun auditedPagingBoundsMaterializationAndKeepsScanningAfterCandidateCapacity() {
        val revision = readRevision(readNamespace())
        val twoItems = listOf(
            lifecycleItem("1", "event-b"),
            transcriptItem("1", "entry-a"),
        )

        val exactCollector = candidateCollector(limit = 2, items = twoItems)
        val exact = exactCollector.page(revision)
            as AgentTranscriptLifecycleRevisionPinnedReadResult.Page
        assertEquals(listOf("entry-a", "event-b"), exact.items.map { it.stableIdentity })
        assertTrue(exact.endReached)
        assertNull(exact.nextCursor)

        val threeItems = twoItems + transcriptItem("2", "entry-c")
        val lookaheadCollector = candidateCollector(limit = 2, items = threeItems)
        val withLookahead = lookaheadCollector.page(revision)
            as AgentTranscriptLifecycleRevisionPinnedReadResult.Page
        assertFalse(withLookahead.endReached)
        val cursor = requireNotNull(withLookahead.nextCursor)
        assertEquals(revision, cursor.revision)

        val continuation = candidateCollector(
            limit = 2,
            items = threeItems,
            cursor = cursor,
        ).page(revision) as AgentTranscriptLifecycleRevisionPinnedReadResult.Page
        assertEquals(listOf("entry-c"), continuation.items.map { it.stableIdentity })
        assertTrue(continuation.endReached)
        assertNull(continuation.nextCursor)

        val boundedLimit = 3
        val boundedCollector = AgentTranscriptLifecycleReadCandidateCollector(
            cursor = null,
            limit = boundedLimit,
        )
        var auditedKeys = 0
        var materializedBodies = 0
        (1..10_000).forEach { sequence ->
            auditedKeys++
            boundedCollector.considerTranscript(
                readKey(
                    sequence.toString(),
                    AgentTranscriptLifecycleReadRecordKind.ENTRY,
                    "entry-$sequence",
                ),
            ) {
                materializedBodies++
                transcriptItem(sequence.toString(), "entry-$sequence")
            }
        }
        (1..10_000).forEach { sequence ->
            auditedKeys++
            boundedCollector.considerLifecycle(
                readKey(
                    sequence.toString(),
                    AgentTranscriptLifecycleReadRecordKind.LIFECYCLE,
                    "event-$sequence",
                ),
            ) {
                materializedBodies++
                lifecycleItem(sequence.toString(), "event-$sequence")
            }
        }
        assertEquals(20_000, auditedKeys)
        assertEquals(2 * (boundedLimit + 1), boundedCollector.retainedCandidateHardLimit)
        assertEquals(boundedCollector.retainedCandidateHardLimit, materializedBodies)
        assertEquals(materializedBodies, boundedCollector.materializedCandidateCount)
        assertEquals(materializedBodies, boundedCollector.retainedCandidateCount)
        val bounded = boundedCollector.page(revision)
            as AgentTranscriptLifecycleRevisionPinnedReadResult.Page
        assertEquals(boundedLimit, bounded.items.size)
        assertFalse(bounded.endReached)

        val corruptTail = AgentTranscriptLifecycleReadCandidateCollector(null, limit = 1)
        (1..3).forEach { sequence ->
            corruptTail.considerTranscript(
                readKey(
                    sequence.toString(),
                    AgentTranscriptLifecycleReadRecordKind.ENTRY,
                    "entry-$sequence",
                ),
            ) { transcriptItem(sequence.toString(), "entry-$sequence") }
        }
        assertEquals(2, corruptTail.materializedCandidateCount)
        assertThrows(RelayV2StorageException::class.java) {
            corruptTail.considerTranscript(
                readKey("2", AgentTranscriptLifecycleReadRecordKind.ENTRY, "entry-tail-corrupt"),
            ) { transcriptItem("2", "entry-tail-corrupt") }
        }
        assertEquals(2, corruptTail.materializedCandidateCount)
        assertThrows(IllegalArgumentException::class.java) {
            AgentTranscriptLifecycleReadCandidateCollector(null, limit = 257)
        }
    }

    @Test
    fun capabilityAndEveryLineageSwitchClearWithoutCallingDurableOwner() = runBlocking {
        val old = readNamespace()
        val port = CountingReadPort()
        val projection = AgentTranscriptLifecycleReadProjectionCore(port)
        val staleCursor = AgentTranscriptLifecycleReadCursor(
            readRevision(old),
            "1",
            AgentTranscriptLifecycleReadRecordKind.ENTRY,
            "entry-old",
        )
        val switches = listOf(
            old.copyFor(profileId = "profile-new"),
            old.copyFor(profileActivationGeneration = 2),
            old.copyFor(hostEpoch = "host-epoch-new"),
            old.copyFor(timelineEpoch = "timeline-new"),
        )
        switches.forEach { selected ->
            assertUnavailable(
                AgentTranscriptLifecycleReadUnavailableReason.LINEAGE_NOT_ACTIVE,
                projection.read(
                    readRequest(selected, availableAccess(old), limit = 1),
                ),
            )
        }
        val newTimeline = switches.last()
        assertUnavailable(
            AgentTranscriptLifecycleReadUnavailableReason.CURSOR_LINEAGE_CHANGED,
            projection.read(
                readRequest(
                    newTimeline,
                    availableAccess(newTimeline),
                    cursor = staleCursor,
                    limit = 1,
                ),
            ),
        )
        assertUnavailable(
            AgentTranscriptLifecycleReadUnavailableReason.RELAY_V1,
            projection.read(
                readRequest(
                    old,
                    availableAccess(old).copy(
                        dialect = AgentTranscriptLifecycleReadDialect.RELAY_V1,
                    ),
                    limit = 1,
                ),
            ),
        )
        assertUnavailable(
            AgentTranscriptLifecycleReadUnavailableReason.EXTENSION_NOT_NEGOTIATED,
            projection.read(
                readRequest(
                    old,
                    availableAccess(old).copy(negotiatedCapabilities = emptySet()),
                    limit = 1,
                ),
            ),
        )
        assertUnavailable(
            AgentTranscriptLifecycleReadUnavailableReason.EXTENSION_UNAVAILABLE,
            projection.read(
                readRequest(
                    old,
                    availableAccess(old).copy(support = AgentExtensionSupport.UNAVAILABLE),
                    limit = 1,
                ),
            ),
        )
        assertEquals(0, port.calls)
    }
}

private class CountingReadPort : AgentTranscriptLifecycleRevisionPinnedReadPort {
    var calls = 0

    override suspend fun readRevisionPinnedPage(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        cursor: AgentTranscriptLifecycleReadCursor?,
        limit: Int,
    ): AgentTranscriptLifecycleRevisionPinnedReadResult {
        calls++
        return AgentTranscriptLifecycleRevisionPinnedReadResult.Missing
    }
}

private class ParentOnlyDurableStore(
    private val parent: AgentTranscriptLifecyclePersistedState,
) : AgentTranscriptLifecycleDurableStore {
    var materializedReads = 0

    override suspend fun <T> transaction(
        block: AgentTranscriptLifecycleDurableTransaction.() -> T,
    ): T {
        val transaction = Proxy.newProxyInstance(
            AgentTranscriptLifecycleDurableTransaction::class.java.classLoader,
            arrayOf(AgentTranscriptLifecycleDurableTransaction::class.java),
        ) { proxy, method, arguments ->
            when (method.name) {
                "stateCount" -> 1L
                "states" -> listOf(parent)
                "toString" -> "ParentOnlyDurableTransaction"
                "hashCode" -> System.identityHashCode(proxy)
                "equals" -> proxy === arguments?.firstOrNull()
                else -> {
                    materializedReads++
                    error("Revision mismatch touched ${method.name}")
                }
            }
        } as AgentTranscriptLifecycleDurableTransaction
        return transaction.block()
    }
}

private fun candidateCollector(
    limit: Int,
    items: List<AgentTranscriptLifecycleReadItem>,
    cursor: AgentTranscriptLifecycleReadCursor? = null,
): AgentTranscriptLifecycleReadCandidateCollector {
    val collector = AgentTranscriptLifecycleReadCandidateCollector(cursor, limit)
    items.filterIsInstance<AgentTranscriptLifecycleReadItem.TranscriptEntry>()
        .sortedWith { left, right -> compareReadKeys(left.readKey(), right.readKey()) }
        .forEach { item ->
            collector.considerTranscript(item.readKey()) { item }
        }
    items.filterIsInstance<AgentTranscriptLifecycleReadItem.LifecycleEvidence>()
        .sortedWith { left, right -> compareReadKeys(left.readKey(), right.readKey()) }
        .forEach { item ->
            collector.considerLifecycle(item.readKey()) { item }
        }
    return collector
}

private fun readKey(
    sequence: String,
    kind: AgentTranscriptLifecycleReadRecordKind,
    stableIdentity: String,
) = AgentTranscriptLifecycleReadKey(
    readCounterOrderKey(sequence, positive = true),
    kind.storageValue,
    stableIdentity,
)

private fun readRequest(
    namespace: AgentTranscriptLifecycleDurableNamespace,
    access: AgentTranscriptLifecycleReadAccess = availableAccess(namespace),
    cursor: AgentTranscriptLifecycleReadCursor? = null,
    limit: Int,
) = AgentTranscriptLifecycleReadRequest(namespace, access, cursor, limit)

private fun availableAccess(
    namespace: AgentTranscriptLifecycleDurableNamespace,
) = AgentTranscriptLifecycleReadAccess(
    dialect = AgentTranscriptLifecycleReadDialect.RELAY_V2,
    negotiatedCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
    support = AgentExtensionSupport.AVAILABLE,
    activeNamespace = namespace,
)

private fun assertUnavailable(
    expected: AgentTranscriptLifecycleReadUnavailableReason,
    actual: AgentTranscriptLifecycleReadState,
) {
    val unavailable = actual as AgentTranscriptLifecycleReadState.Unavailable
    assertEquals(expected, unavailable.reason)
}

private fun readNamespace(): AgentTranscriptLifecycleDurableNamespace =
    AgentTranscriptLifecycleDurableNamespace(
        AgentTranscriptLifecycleDurableConsumerIdentity(
            profileId = "profile-read",
            profileActivationGeneration = 1,
            principalId = "principal-read",
            clientInstanceId = "client-read",
            hostId = "host-read",
            hostEpoch = "host-epoch-read",
            scopeId = "scope-read",
            sessionId = "session-read",
        ),
        timelineEpoch = "timeline-read",
    )

private fun readRevision(
    namespace: AgentTranscriptLifecycleDurableNamespace,
) = AgentTranscriptLifecycleReadRevision(
    namespace = namespace,
    parentPayloadSha256 = "a".repeat(64),
    localGeneration = "1",
    materializedThroughAgentSeq = "257",
)

private fun operationalReadState(
    consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
) = AgentTranscriptLifecycleClientState(
    identity = consumer.sessionIdentity,
    extensionLane = AgentTranscriptLifecycleExtensionState(
        support = AgentExtensionSupport.AVAILABLE,
        unavailableReason = null,
        liveSource = AgentLiveSourceState.CONNECTED,
        activeSourceEpoch = "source-read",
        timelineEpoch = "timeline-read",
        effectiveHostLimits = AgentTimelineEffectiveLimits(
            maxTextUtf8Bytes = 65_536,
            maxPageRecords = 256,
            eventReplayRetentionMs = 604_800_000,
            snapshotLeaseMs = 300_000,
        ),
        syncState = AgentTimelineSyncState.Current,
        localGeneration = "1",
        lastAgentSeq = "257",
        notificationBaselineAgentSeq = "0",
    ),
)

private fun transcriptItem(
    sequence: String,
    entryId: String,
) = AgentTranscriptLifecycleReadItem.TranscriptEntry(
    AgentTranscriptEntryReadModel(
        entryId = entryId,
        runId = "run-read",
        turnId = "turn-read",
        role = AgentTimelineEntryRole.AGENT,
        commandCorrelationId = null,
        createdAtMs = sequence.toLong(),
        createdAgentSeq = sequence,
        lastModifiedAgentSeq = sequence,
        content = AgentTranscriptEntryContent.Visible("text-$entryId"),
    ),
)

private fun lifecycleItem(
    sequence: String,
    eventId: String,
) = AgentTranscriptLifecycleReadItem.LifecycleEvidence(
    AgentLifecycleRecord(
        lifecycleEventId = eventId,
        sourceEpoch = "source-read",
        identity = AgentLifecycleIdentity(AgentLifecycleScope.RUN, "run-read", null),
        state = AgentLifecycleState.RUNNING,
        failure = null,
        occurredAtMs = sequence.toLong(),
        agentEventSeq = sequence,
    ),
)

private fun AgentTranscriptLifecycleDurableNamespace.copyFor(
    profileId: String = consumer.profileId,
    profileActivationGeneration: Long = consumer.profileActivationGeneration,
    hostEpoch: String = consumer.hostEpoch,
    timelineEpoch: String = requireNotNull(this.timelineEpoch),
): AgentTranscriptLifecycleDurableNamespace = AgentTranscriptLifecycleDurableNamespace(
    consumer.copy(
        profileId = profileId,
        profileActivationGeneration = profileActivationGeneration,
        hostEpoch = hostEpoch,
    ),
    timelineEpoch,
)
