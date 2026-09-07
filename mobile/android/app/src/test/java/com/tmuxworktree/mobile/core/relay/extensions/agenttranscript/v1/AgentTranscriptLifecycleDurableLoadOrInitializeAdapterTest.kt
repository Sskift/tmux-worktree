package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectApplyResult
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectGeneration
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectApplyLeasePort
import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2RepositoryEffectAuthority
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptConsumerStats
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptNamespaceStats
import java.lang.reflect.Proxy
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class AgentTranscriptLifecycleDurableLoadOrInitializeAdapterTest {
    @Test
    fun `current exact authority creates once and preserves progressed exact state inside lease`() =
        runBlocking {
            val consumer = loadOrInitializeConsumer()
            val namespace = AgentTranscriptLifecycleDurableNamespace(consumer, null)
            val lease = LoadOrInitializeApplyLease()
            val store = LoadOrInitializeStore(lease)
            val core = AgentTranscriptLifecycleDurableRepositoryCore(store)
            val adapter = AgentTranscriptLifecycleDurableLoadOrInitializeAdapter(
                lease,
                core::loadOrInitializeStatusNamespaceUnderApplyLease,
            )
            val canonical = AgentTranscriptLifecycleClientState(consumer.sessionIdentity)

            assertSame(
                AgentTranscriptLifecycleDurableLoadOrInitializeResult.Ready,
                adapter.loadOrInitialize(LOAD_OR_INITIALIZE_AUTHORITY, namespace),
            )
            assertEquals(canonical, store.persistedState())
            assertEquals(1, store.insertCount)

            assertSame(
                AgentTranscriptLifecycleDurableLoadOrInitializeResult.Ready,
                adapter.loadOrInitialize(LOAD_OR_INITIALIZE_AUTHORITY, namespace),
            )
            assertEquals(canonical, store.persistedState())
            assertEquals(1, store.insertCount)

            val progressed = canonical.copy(
                extensionLane = canonical.extensionLane.copy(
                    localGeneration = "3",
                    pendingStatusRequest = AgentLocalRequestFence("3", "status-progressed"),
                ),
            )
            store.seed(namespace, progressed)
            val progressedImage = store.durableImage()

            assertSame(
                AgentTranscriptLifecycleDurableLoadOrInitializeResult.Ready,
                adapter.loadOrInitialize(LOAD_OR_INITIALIZE_AUTHORITY, namespace),
            )
            assertEquals(progressed, store.persistedState())
            assertEquals(progressedImage, store.durableImage())
            assertEquals(1, store.insertCount)
            assertEquals(3, store.transactionCount)
            assertEquals(3, lease.admittedBlocks)
            assertEquals(0, store.transactionsOutsideLease)
        }

    @Test
    fun `stale mismatched conflicting and corrupt admissions never rebuild durable state`() =
        runBlocking {
            val consumer = loadOrInitializeConsumer()
            val namespace = AgentTranscriptLifecycleDurableNamespace(consumer, null)

            val staleLease = LoadOrInitializeApplyLease(stale = true)
            val staleStore = LoadOrInitializeStore(staleLease)
            val staleCore = AgentTranscriptLifecycleDurableRepositoryCore(staleStore)
            val staleAdapter = AgentTranscriptLifecycleDurableLoadOrInitializeAdapter(
                staleLease,
                staleCore::loadOrInitializeStatusNamespaceUnderApplyLease,
            )
            assertSame(
                AgentTranscriptLifecycleDurableLoadOrInitializeResult.Unavailable,
                staleAdapter.loadOrInitialize(LOAD_OR_INITIALIZE_AUTHORITY, namespace),
            )
            assertEquals(0, staleStore.transactionCount)
            assertEquals(0, staleStore.insertCount)

            val mismatchLease = LoadOrInitializeApplyLease()
            val mismatchStore = LoadOrInitializeStore(mismatchLease)
            val mismatchCore = AgentTranscriptLifecycleDurableRepositoryCore(mismatchStore)
            val mismatchAdapter = AgentTranscriptLifecycleDurableLoadOrInitializeAdapter(
                mismatchLease,
                mismatchCore::loadOrInitializeStatusNamespaceUnderApplyLease,
            )
            val foreignAuthority = LOAD_OR_INITIALIZE_AUTHORITY.copy(
                principalId = "principal-foreign",
            )
            val foreignNamespace = namespace.copy(
                consumer = consumer.copy(clientInstanceId = "client-foreign"),
            )
            assertSame(
                AgentTranscriptLifecycleDurableLoadOrInitializeResult.Unavailable,
                mismatchAdapter.loadOrInitialize(foreignAuthority, namespace),
            )
            assertSame(
                AgentTranscriptLifecycleDurableLoadOrInitializeResult.Unavailable,
                mismatchAdapter.loadOrInitialize(LOAD_OR_INITIALIZE_AUTHORITY, foreignNamespace),
            )
            assertEquals(0, mismatchLease.attempts)
            assertEquals(0, mismatchStore.transactionCount)

            val conflictLease = LoadOrInitializeApplyLease()
            val conflictStore = LoadOrInitializeStore(conflictLease)
            val conflictCore = AgentTranscriptLifecycleDurableRepositoryCore(conflictStore)
            val conflictAdapter = AgentTranscriptLifecycleDurableLoadOrInitializeAdapter(
                conflictLease,
                conflictCore::loadOrInitializeStatusNamespaceUnderApplyLease,
            )
            val conflictingNamespace = AgentTranscriptLifecycleDurableNamespace(
                consumer,
                "timeline-existing",
            )
            conflictStore.seed(
                conflictingNamespace,
                AgentTranscriptLifecycleClientState(
                    consumer.sessionIdentity,
                    AgentTranscriptLifecycleExtensionState(timelineEpoch = "timeline-existing"),
                ),
            )
            val conflictImage = conflictStore.durableImage()
            assertSame(
                AgentTranscriptLifecycleDurableLoadOrInitializeResult.Unavailable,
                conflictAdapter.loadOrInitialize(LOAD_OR_INITIALIZE_AUTHORITY, namespace),
            )
            assertEquals(conflictImage, conflictStore.durableImage())
            assertEquals(0, conflictStore.insertCount)

            val corruptLease = LoadOrInitializeApplyLease()
            val corruptStore = LoadOrInitializeStore(corruptLease)
            val corruptCore = AgentTranscriptLifecycleDurableRepositoryCore(corruptStore)
            val corruptAdapter = AgentTranscriptLifecycleDurableLoadOrInitializeAdapter(
                corruptLease,
                corruptCore::loadOrInitializeStatusNamespaceUnderApplyLease,
            )
            corruptStore.seed(
                namespace,
                AgentTranscriptLifecycleClientState(consumer.sessionIdentity),
                corruptHash = true,
            )
            val corruptImage = corruptStore.durableImage()
            assertSame(
                AgentTranscriptLifecycleDurableLoadOrInitializeResult.Unavailable,
                corruptAdapter.loadOrInitialize(LOAD_OR_INITIALIZE_AUTHORITY, namespace),
            )
            assertEquals(corruptImage, corruptStore.durableImage())
            assertEquals(0, corruptStore.insertCount)

            val orphanLease = LoadOrInitializeApplyLease()
            val orphanStore = LoadOrInitializeStore(orphanLease).apply {
                consumerStats = RelayV2AgentTranscriptConsumerStats(1, 0, 0, 0)
            }
            val orphanCore = AgentTranscriptLifecycleDurableRepositoryCore(orphanStore)
            val orphanAdapter = AgentTranscriptLifecycleDurableLoadOrInitializeAdapter(
                orphanLease,
                orphanCore::loadOrInitializeStatusNamespaceUnderApplyLease,
            )
            assertSame(
                AgentTranscriptLifecycleDurableLoadOrInitializeResult.Unavailable,
                orphanAdapter.loadOrInitialize(LOAD_OR_INITIALIZE_AUTHORITY, namespace),
            )
            assertEquals(emptyList<AgentTranscriptLifecyclePersistedState>(), orphanStore.durableImage())
            assertEquals(0, orphanStore.insertCount)

            val invariantFailure = IllegalStateException("unexpected repository invariant failure")
            val failureLease = LoadOrInitializeApplyLease()
            val failureAdapter = AgentTranscriptLifecycleDurableLoadOrInitializeAdapter(
                failureLease,
            ) { throw invariantFailure }
            val propagated = try {
                failureAdapter.loadOrInitialize(LOAD_OR_INITIALIZE_AUTHORITY, namespace)
                null
            } catch (failure: IllegalStateException) {
                failure
            }
            assertSame(invariantFailure, propagated)
        }
}

private class LoadOrInitializeApplyLease(
    private val stale: Boolean = false,
) : RelayV2RepositoryEffectApplyLeasePort {
    var attempts = 0
        private set
    var admittedBlocks = 0
        private set
    var insideBlock = false
        private set

    override suspend fun <T> withEffectApplyLease(
        authority: RelayV2RepositoryEffectAuthority,
        block: suspend () -> T,
    ): RelayV2EffectApplyResult<T> {
        attempts += 1
        assertEquals(LOAD_OR_INITIALIZE_AUTHORITY, authority)
        if (stale) return RelayV2EffectApplyResult.Stale
        admittedBlocks += 1
        insideBlock = true
        return try {
            RelayV2EffectApplyResult.Applied(block())
        } finally {
            insideBlock = false
        }
    }
}

private class LoadOrInitializeStore(
    private val lease: LoadOrInitializeApplyLease,
) : AgentTranscriptLifecycleDurableStore {
    private var rows = mutableListOf<AgentTranscriptLifecyclePersistedState>()
    var consumerStats = RelayV2AgentTranscriptConsumerStats(0, 0, 0, 0)
    var insertCount = 0
        private set
    var transactionCount = 0
        private set
    var transactionsOutsideLease = 0
        private set

    private val transaction = Proxy.newProxyInstance(
        AgentTranscriptLifecycleDurableTransaction::class.java.classLoader,
        arrayOf(AgentTranscriptLifecycleDurableTransaction::class.java),
    ) { proxy, method, arguments ->
        when (method.name) {
            "stateCount" -> rows.count {
                it.namespace.consumer == arguments!![0]
            }.toLong()
            "states" -> rows.filter { it.namespace.consumer == arguments!![0] }
            "transcriptConsumerStats" -> consumerStats
            "emptyTimelineNamespaceStats", "transcriptNamespaceStats" -> EMPTY_TRANSCRIPT_STATS
            "insertState" -> {
                val state = arguments!![0] as AgentTranscriptLifecyclePersistedState
                check(rows.none { it.namespace.consumer == state.namespace.consumer })
                rows += state
                insertCount += 1
                null
            }
            "equals" -> proxy === arguments?.get(0)
            "hashCode" -> System.identityHashCode(proxy)
            "toString" -> "LoadOrInitializeTransaction"
            else -> error("Unexpected durable transaction call: ${method.name}")
        }
    } as AgentTranscriptLifecycleDurableTransaction

    override suspend fun <T> transaction(
        block: AgentTranscriptLifecycleDurableTransaction.() -> T,
    ): T {
        transactionCount += 1
        if (!lease.insideBlock) transactionsOutsideLease += 1
        val rowsBefore = rows.toMutableList()
        val insertsBefore = insertCount
        return try {
            block(transaction)
        } catch (failure: Throwable) {
            rows = rowsBefore
            insertCount = insertsBefore
            throw failure
        }
    }

    fun seed(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        state: AgentTranscriptLifecycleClientState,
        corruptHash: Boolean = false,
    ) {
        val payload = AgentTranscriptLifecycleDurableStateCodec.encode(
            namespace,
            state,
            AgentTranscriptDurableStorageAccounting.EMPTY,
        ).let { encoded ->
            if (corruptHash) encoded.copy(sha256 = "0".repeat(64)) else encoded
        }
        rows = mutableListOf(AgentTranscriptLifecyclePersistedState(namespace, payload))
    }

    fun persistedState(): AgentTranscriptLifecycleClientState {
        val row = rows.single()
        return AgentTranscriptLifecycleDurableStateCodec.decode(row.namespace, row.payload).state
    }

    fun durableImage(): List<AgentTranscriptLifecyclePersistedState> = rows.toList()
}

private fun loadOrInitializeConsumer() = AgentTranscriptLifecycleDurableConsumerIdentity(
    profileId = "profile-load-or-initialize",
    profileActivationGeneration = 7,
    principalId = "principal-load-or-initialize",
    clientInstanceId = "client-load-or-initialize",
    hostId = "host-load-or-initialize",
    hostEpoch = "epoch-load-or-initialize",
    scopeId = "scope-load-or-initialize",
    sessionId = "session-load-or-initialize",
)

private val LOAD_OR_INITIALIZE_AUTHORITY = RelayV2RepositoryEffectAuthority(
    generation = RelayV2EffectGeneration(
        profileId = "profile-load-or-initialize",
        profileGeneration = 7,
        connectionGeneration = 11,
    ),
    profileId = "profile-load-or-initialize",
    profileActivationGeneration = 7,
    principalId = "principal-load-or-initialize",
    clientInstanceId = "client-load-or-initialize",
    hostId = "host-load-or-initialize",
    hostEpoch = "epoch-load-or-initialize",
)

private val EMPTY_TRANSCRIPT_STATS = RelayV2AgentTranscriptNamespaceStats(
    entryCount = 0,
    entryPayloadUtf8Bytes = 0,
    entryTextUtf8Bytes = 0,
    entryMaxPayloadUtf8Bytes = 0,
    entryMaxTextUtf8Bytes = 0,
    entryMaxBoundedTextUtf8Bytes = 0,
    snapshotCount = 0,
    snapshotMaxIdUtf8Bytes = 0,
    snapshotMaxCursorUtf8Bytes = 0,
    snapshotRecordCount = 0,
    snapshotRecordPayloadUtf8Bytes = 0,
    snapshotRecordRawUtf8Bytes = 0,
    snapshotRecordMinRawUtf8Bytes = 0,
    snapshotRecordMaxRawUtf8Bytes = 0,
    snapshotRecordMaxPayloadUtf8Bytes = 0,
    snapshotRecordMaxBoundedTextUtf8Bytes = 0,
    pendingEventCount = 0,
    pendingEventPayloadUtf8Bytes = 0,
    pendingEventRawUtf8Bytes = 0,
    pendingEventMinRawUtf8Bytes = 0,
    pendingEventMaxRawUtf8Bytes = 0,
    pendingEventMaxPayloadUtf8Bytes = 0,
    pendingEventMaxBoundedTextUtf8Bytes = 0,
)
