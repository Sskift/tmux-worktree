package com.tmuxworktree.mobile.core.relay.v2.state

import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDialect
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2StateSyncRepositoryCoreTest {
    @Test
    fun `five hello dispositions persist monotonic watermark and isolate epoch changes`() = runBlocking {
        val store = FakeStateStore()
        val repository = RelayV2StateSyncRepositoryCore(store)
        val epochA = namespace(hostEpoch = "epoch-a")

        val fresh = repository.applyHelloUnderApplyLease(
            hello(epochA, "5", null, RelayV2StateHelloDisposition.FRESH),
        )
        assertResync(fresh, RelayV2ResyncReason.FRESH)
        commitCut(repository, epochA, through = "5", session = session("session-a", "old"))

        val matched = repository.applyHelloUnderApplyLease(
            hello(epochA, "5", RelayV2AppliedCursor("epoch-a", "5"), RelayV2StateHelloDisposition.MATCHED),
        )
        assertTrue(matched is RelayV2StateSyncResult.Live)
        assertEquals("5", store.authority(epochA)?.requiredThroughEventSeq)

        val behind = repository.applyHelloUnderApplyLease(
            hello(epochA, "7", RelayV2AppliedCursor("epoch-a", "5"), RelayV2StateHelloDisposition.CURSOR_BEHIND),
        )
        assertResync(behind, RelayV2ResyncReason.CURSOR_BEHIND)
        assertEquals("7", store.authority(epochA)?.requiredThroughEventSeq)

        val regressed = repository.applyHelloUnderApplyLease(
            hello(epochA, "6", RelayV2AppliedCursor("epoch-a", "5"), RelayV2StateHelloDisposition.CURSOR_BEHIND),
        )
        assertRotation(regressed, RelayV2RotationReason.REQUIRED_WATERMARK_REGRESSED)
        assertEquals("7", store.authority(epochA)?.requiredThroughEventSeq)

        val ahead = repository.applyHelloUnderApplyLease(
            hello(epochA, "5", RelayV2AppliedCursor("epoch-a", "6"), RelayV2StateHelloDisposition.EVENT_CURSOR_AHEAD),
        )
        assertRotation(ahead, RelayV2RotationReason.EVENT_CURSOR_AHEAD)
        assertEquals("5", store.authority(epochA)?.cursorEventSeq)

        val epochB = namespace(hostEpoch = "epoch-b")
        val changed = repository.applyHelloUnderApplyLease(
            hello(
                epochB,
                "1",
                RelayV2AppliedCursor("epoch-a", "5"),
                RelayV2StateHelloDisposition.HOST_EPOCH_CHANGED,
            ),
        )
        assertResync(changed, RelayV2ResyncReason.HOST_EPOCH_CHANGED)
        assertNull(store.authority(epochA))
        assertNull(store.session(epochA, "scope-a", "session-a"))
        assertEquals("1", store.authority(epochB)?.requiredThroughEventSeq)
        assertNull(store.authority(epochB)?.cursorEventSeq)
    }

    @Test
    fun `disconnect event without delivery forces newer cut instead of waiting for another event`() = runBlocking {
        val store = FakeStateStore()
        val repository = RelayV2StateSyncRepositoryCore(store)
        val namespace = namespace()
        repository.applyHelloUnderApplyLease(
            hello(namespace, "3", null, RelayV2StateHelloDisposition.FRESH),
        )
        commitCut(repository, namespace, "3", session("session-a", "at-3"))

        repository.applyHelloUnderApplyLease(
            hello(
                namespace,
                "4",
                RelayV2AppliedCursor(namespace.hostEpoch, "3"),
                RelayV2StateHelloDisposition.CURSOR_BEHIND,
            ),
        )
        stageCut(repository, namespace, through = "4", session = session("session-a", "at-4"))

        val ordinaryReconnect = repository.applyHelloUnderApplyLease(
            hello(
                namespace,
                "4",
                RelayV2AppliedCursor(namespace.hostEpoch, "3"),
                RelayV2StateHelloDisposition.CURSOR_BEHIND,
            ),
        ) as RelayV2StateSyncResult.ResyncRequired
        assertEquals(RelayV2ResyncReason.CURSOR_BEHIND, ordinaryReconnect.reason)
        assertNull(ordinaryReconnect.release)
        assertNotNull(store.snapshot(namespace))

        // seq=5 was committed by the host while this route was disconnected and was never buffered.
        val reconnected = repository.applyHelloUnderApplyLease(
            hello(
                namespace,
                "5",
                RelayV2AppliedCursor(namespace.hostEpoch, "3"),
                RelayV2StateHelloDisposition.CURSOR_BEHIND,
            ),
        ) as RelayV2StateSyncResult.ResyncRequired

        assertEquals(RelayV2ResyncReason.SNAPSHOT_RESTART_REQUIRED, reconnected.reason)
        assertEquals("snapshot-4", reconnected.release?.snapshotId)
        assertNull(store.snapshot(namespace))
        assertEquals("at-3", store.session(namespace, "scope-a", "session-a")?.item?.displayName)

        commitCut(repository, namespace, "5", session("session-a", "at-5"), snapshotSuffix = "5")
        assertEquals("5", store.authority(namespace)?.cursorEventSeq)
        assertEquals("at-5", store.session(namespace, "scope-a", "session-a")?.item?.displayName)
    }

    @Test
    fun `streamed complete cut and durable buffered event commit atomically`() = runBlocking {
        val store = FakeStateStore()
        val repository = RelayV2StateSyncRepositoryCore(store)
        val namespace = namespace()
        repository.applyHelloUnderApplyLease(
            hello(namespace, "10", null, RelayV2StateHelloDisposition.FRESH),
        )
        val records = records(session("session-a", "snapshot"), sessionsRevision = "1")
        val (bytes, digest) = canonicalSnapshotDigest(records)

        val first = repository.stageSnapshotChunkUnderApplyLease(
            chunk(
                namespace = namespace,
                through = "10",
                records = records.take(2),
                allRecordCount = records.size.toLong(),
                allCanonicalBytes = bytes,
                digest = digest,
                chunkIndex = 0,
                requestedCursor = null,
                isLast = false,
                nextCursor = "cursor-1",
            ),
        )
        assertEquals("cursor-1", (first as RelayV2StateSyncResult.SnapshotStaged).nextCursor)

        repository.stageSnapshotChunkUnderApplyLease(
            chunk(
                namespace = namespace,
                through = "10",
                records = records.drop(2),
                allRecordCount = records.size.toLong(),
                allCanonicalBytes = bytes,
                digest = digest,
                chunkIndex = 1,
                requestedCursor = "cursor-1",
                isLast = true,
                nextCursor = null,
            ),
        )
        repository.applyStateEventUnderApplyLease(
            event(
                namespace,
                seq = "11",
                revision = "2",
                RelayV2StateChange.SessionUpsert(session("session-a", "event-11")),
            ),
        )

        val committed = repository.commitSnapshotUnderApplyLease(namespace, "snapshot-10")
        assertEquals("11", (committed as RelayV2StateSyncResult.SnapshotCommitted).cursorEventSeq)
        assertEquals("event-11", store.session(namespace, "scope-a", "session-a")?.item?.displayName)
        assertEquals("2", store.scope(namespace, "scope-a")?.sessionsRevision)
        assertNull(store.snapshot(namespace))
        assertTrue(store.events(namespace).isEmpty())
    }

    @Test
    fun `cursor and incomplete scope ordering conflicts roll back staging without touching cache`() = runBlocking {
        val store = FakeStateStore()
        val repository = RelayV2StateSyncRepositoryCore(store)
        val namespace = namespace()
        repository.applyHelloUnderApplyLease(
            hello(namespace, "1", null, RelayV2StateHelloDisposition.FRESH),
        )
        commitCut(repository, namespace, "1", session("session-a", "stable"))
        repository.applyHelloUnderApplyLease(
            hello(
                namespace,
                "2",
                RelayV2AppliedCursor(namespace.hostEpoch, "1"),
                RelayV2StateHelloDisposition.CURSOR_BEHIND,
            ),
        )
        val allRecords = records(session("session-a", "candidate"))
        val (bytes, digest) = canonicalSnapshotDigest(allRecords)
        repository.stageSnapshotChunkUnderApplyLease(
            chunk(
                namespace,
                "2",
                allRecords.take(2),
                allRecords.size.toLong(),
                bytes,
                digest,
                chunkIndex = 0,
                isLast = false,
                nextCursor = "expected-cursor",
            ),
        )

        val wrongCursor = repository.stageSnapshotChunkUnderApplyLease(
            chunk(
                namespace,
                "2",
                allRecords.drop(2),
                allRecords.size.toLong(),
                bytes,
                digest,
                chunkIndex = 1,
                requestedCursor = "wrong-cursor",
                isLast = true,
            ),
        )
        assertResync(wrongCursor, RelayV2ResyncReason.SNAPSHOT_IDENTITY_CONFLICT)
        assertNull(store.snapshot(namespace))
        assertEquals("stable", store.session(namespace, "scope-a", "session-a")?.item?.displayName)

        val reversed = listOf(
            RelayV2SnapshotRecord.SessionsScope("scope-a", "1"),
            RelayV2SnapshotRecord.Scope(scope()),
        )
        val (reversedBytes, reversedDigest) = canonicalSnapshotDigest(reversed)
        val wrongOrder = repository.stageSnapshotChunkUnderApplyLease(
            chunk(
                namespace,
                "2",
                reversed,
                reversed.size.toLong(),
                reversedBytes,
                reversedDigest,
                isLast = true,
            ),
        )
        assertResync(wrongOrder, RelayV2ResyncReason.SNAPSHOT_ORDER_CONFLICT)
        assertNull(store.snapshot(namespace))
        assertEquals("1", store.authority(namespace)?.cursorEventSeq)

        val missingIntermediateSessionsScope = listOf(
            RelayV2SnapshotRecord.Scope(scope("a")),
            RelayV2SnapshotRecord.Scope(scope("b")),
            RelayV2SnapshotRecord.SessionsScope("b", "0"),
        )
        val (missingBytes, missingDigest) = canonicalSnapshotDigest(missingIntermediateSessionsScope)
        val missingIntermediate = repository.stageSnapshotChunkUnderApplyLease(
            chunk(
                namespace,
                "2",
                missingIntermediateSessionsScope,
                missingIntermediateSessionsScope.size.toLong(),
                missingBytes,
                missingDigest,
                isLast = true,
            ),
        )
        assertResync(missingIntermediate, RelayV2ResyncReason.SNAPSHOT_ORDER_CONFLICT)
        assertNull(store.snapshot(namespace))
        assertEquals(0, store.recordCount(namespace))
        assertEquals("1", store.authority(namespace)?.cursorEventSeq)
        assertEquals("stable", store.session(namespace, "scope-a", "session-a")?.item?.displayName)
        assertNull(store.scope(namespace, "b"))
    }

    @Test
    fun `gap overflow partial and digest failures never replace the old cache or cursor`() = runBlocking {
        val namespace = namespace()

        suspend fun seeded(): Pair<FakeStateStore, RelayV2StateSyncRepositoryCore> {
            val store = FakeStateStore()
            val repository = RelayV2StateSyncRepositoryCore(store)
            repository.applyHelloUnderApplyLease(
                hello(namespace, "2", null, RelayV2StateHelloDisposition.FRESH),
            )
            commitCut(repository, namespace, "2", session("session-a", "stable"))
            return store to repository
        }

        run {
            val (store, repository) = seeded()
            val gap = repository.applyStateEventUnderApplyLease(
                event(
                    namespace,
                    seq = "4",
                    revision = "2",
                    RelayV2StateChange.SessionUpsert(session("session-a", "gap")),
                ),
            )
            assertResync(gap, RelayV2ResyncReason.EVENT_GAP)
            assertOldState(store, namespace)
        }

        run {
            val (store, repository) = seeded()
            repository.applyHelloUnderApplyLease(
                hello(
                    namespace,
                    "3",
                    RelayV2AppliedCursor(namespace.hostEpoch, "2"),
                    RelayV2StateHelloDisposition.CURSOR_BEHIND,
                ),
            )
            repeat(16) { offset ->
                repository.applyStateEventUnderApplyLease(
                    event(
                        namespace,
                        seq = (3 + offset).toString(),
                        revision = (2 + offset).toString(),
                        RelayV2StateChange.SessionUpsert(session("session-a", "buffer-$offset")),
                        rawUtf8Bytes = RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES,
                    ),
                )
            }
            val overflow = repository.applyStateEventUnderApplyLease(
                event(
                    namespace,
                    seq = "19",
                    revision = "18",
                    RelayV2StateChange.SessionUpsert(session("session-a", "overflow")),
                    rawUtf8Bytes = RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES,
                ),
            )
            assertResync(overflow, RelayV2ResyncReason.EVENT_BUFFER_OVERFLOW)
            assertTrue(store.events(namespace).isEmpty())
            assertOldState(store, namespace)
        }

        run {
            val (store, repository) = seeded()
            repository.applyHelloUnderApplyLease(
                hello(
                    namespace,
                    "3",
                    RelayV2AppliedCursor(namespace.hostEpoch, "2"),
                    RelayV2StateHelloDisposition.CURSOR_BEHIND,
                ),
            )
            val records = records(session("session-a", "partial"))
            val (bytes, digest) = canonicalSnapshotDigest(records)
            repository.stageSnapshotChunkUnderApplyLease(
                chunk(
                    namespace,
                    "3",
                    records.take(2),
                    records.size.toLong(),
                    bytes,
                    digest,
                    chunkIndex = 0,
                    requestedCursor = null,
                    isLast = false,
                    nextCursor = "continue",
                ),
            )
            val partial = repository.commitSnapshotUnderApplyLease(namespace, "snapshot-3")
            assertResync(partial, RelayV2ResyncReason.SNAPSHOT_INCOMPLETE)
            assertNotNull(store.snapshot(namespace))
            assertOldState(store, namespace)
        }

        run {
            val (store, repository) = seeded()
            repository.applyHelloUnderApplyLease(
                hello(
                    namespace,
                    "3",
                    RelayV2AppliedCursor(namespace.hostEpoch, "2"),
                    RelayV2StateHelloDisposition.CURSOR_BEHIND,
                ),
            )
            stageCut(
                repository,
                namespace,
                through = "3",
                session = session("session-a", "bad-digest"),
                digestOverride = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            )
            val failed = repository.commitSnapshotUnderApplyLease(namespace, "snapshot-3")
            assertResync(failed, RelayV2ResyncReason.SNAPSHOT_DIGEST_MISMATCH)
            assertNull(store.snapshot(namespace))
            assertOldState(store, namespace)
        }
    }

    @Test
    fun `unknown epoch cannot pollute current namespace and v1 sentinel remains isolated`() = runBlocking {
        val store = FakeStateStore(v1Sentinel = "v1-host+name-row")
        val repository = RelayV2StateSyncRepositoryCore(store)
        val current = namespace(hostEpoch = "epoch-current")
        repository.applyHelloUnderApplyLease(
            hello(current, "1", null, RelayV2StateHelloDisposition.FRESH),
        )
        commitCut(repository, current, "1", session("session-a", "current"))

        val unknown = namespace(hostEpoch = "epoch-unknown")
        val result = repository.applyStateEventUnderApplyLease(
            event(
                unknown,
                "2",
                "2",
                RelayV2StateChange.SessionUpsert(session("session-x", "wrong-epoch")),
            ),
        )
        assertRotation(result, RelayV2RotationReason.UNKNOWN_HOST_EPOCH)
        assertNull(store.session(unknown, "scope-a", "session-x"))
        assertEquals("current", store.session(current, "scope-a", "session-a")?.item?.displayName)
        assertEquals("v1-host+name-row", store.v1Sentinel)
    }

    @Test
    fun `profile clear requires exact v2 disconnect receipt for state-sync categories`() = runBlocking {
        val store = FakeStateStore(v1Sentinel = "v1-still-present")
        val repository = RelayV2StateSyncRepositoryCore(store)
        val first = namespace(profileId = "profile-one", hostEpoch = "epoch-one")
        val second = namespace(profileId = "profile-two", hostEpoch = "epoch-two")
        repository.applyHelloUnderApplyLease(
            hello(first, "1", null, RelayV2StateHelloDisposition.FRESH),
        )
        commitCut(repository, first, "1", session("session-one", "one"))
        repository.applyHelloUnderApplyLease(
            hello(
                first,
                "2",
                RelayV2AppliedCursor(first.hostEpoch, "1"),
                RelayV2StateHelloDisposition.CURSOR_BEHIND,
            ),
        )
        val partialRecords = records(session("session-one", "staged"))
        val (partialBytes, partialDigest) = canonicalSnapshotDigest(partialRecords)
        repository.stageSnapshotChunkUnderApplyLease(
            chunk(
                first,
                "2",
                partialRecords.take(2),
                partialRecords.size.toLong(),
                partialBytes,
                partialDigest,
                isLast = false,
                nextCursor = "profile-one-cursor",
            ),
        )
        repository.applyStateEventUnderApplyLease(
            event(
                first,
                "3",
                "2",
                RelayV2StateChange.SessionUpsert(session("session-one", "buffered")),
            ),
        )
        repository.applyHelloUnderApplyLease(
            hello(second, "1", null, RelayV2StateHelloDisposition.FRESH),
        )
        commitCut(repository, second, "1", session("session-two", "two"))

        listOf(
            RelayProfileDisconnectReceipt(
                RelayActiveProfileIdentity("profile-one", RelayProfileDialect.V1, 9),
                "wrong-dialect",
            ),
            RelayProfileDisconnectReceipt(
                RelayActiveProfileIdentity("profile-one", RelayProfileDialect.V2, 0),
                "missing-activation",
            ),
            RelayProfileDisconnectReceipt(
                RelayActiveProfileIdentity("profile-one", RelayProfileDialect.V2, 9),
                "",
            ),
        ).forEach { invalidReceipt ->
            assertTrue(
                runCatching {
                    repository.clearProfileAfterDisconnect(invalidReceipt)
                }.isFailure,
            )
            assertNotNull(store.authority(first))
        }

        repository.clearProfileAfterDisconnect(
            RelayProfileDisconnectReceipt(
                RelayActiveProfileIdentity("profile-one", RelayProfileDialect.V2, 9),
                "disconnect-barrier",
            ),
        )

        assertNull(store.authority(first))
        assertNull(store.session(first, "scope-a", "session-one"))
        assertNull(store.snapshot(first))
        assertTrue(store.events(first).isEmpty())
        assertEquals(0, store.recordCount(first))
        assertNotNull(store.authority(second))
        assertNotNull(store.session(second, "scope-a", "session-two"))
        assertEquals("v1-still-present", store.v1Sentinel)
    }

    @Test
    fun `storage failure rolls back destructive replace cursor and staging together`() = runBlocking {
        val store = FakeStateStore()
        val repository = RelayV2StateSyncRepositoryCore(store)
        val namespace = namespace()
        repository.applyHelloUnderApplyLease(
            hello(namespace, "1", null, RelayV2StateHelloDisposition.FRESH),
        )
        commitCut(repository, namespace, "1", session("session-a", "old"))
        repository.applyHelloUnderApplyLease(
            hello(
                namespace,
                "2",
                RelayV2AppliedCursor(namespace.hostEpoch, "1"),
                RelayV2StateHelloDisposition.CURSOR_BEHIND,
            ),
        )
        stageCut(repository, namespace, "2", session("session-a", "new"))
        store.failOnNextSessionWrite = true

        val failure = runCatching {
            repository.commitSnapshotUnderApplyLease(namespace, "snapshot-2")
        }.exceptionOrNull()

        assertNotNull(failure)
        assertEquals("1", store.authority(namespace)?.cursorEventSeq)
        assertEquals("old", store.session(namespace, "scope-a", "session-a")?.item?.displayName)
        assertNotNull(store.snapshot(namespace))
    }

    private suspend fun commitCut(
        repository: RelayV2StateSyncRepositoryCore,
        namespace: RelayV2StateNamespace,
        through: String,
        session: RelayV2SessionResource,
        snapshotSuffix: String = through,
    ) {
        stageCut(repository, namespace, through, session, snapshotSuffix = snapshotSuffix)
        val committed = repository.commitSnapshotUnderApplyLease(namespace, "snapshot-$snapshotSuffix")
        assertTrue(committed is RelayV2StateSyncResult.SnapshotCommitted)
    }

    private suspend fun stageCut(
        repository: RelayV2StateSyncRepositoryCore,
        namespace: RelayV2StateNamespace,
        through: String,
        session: RelayV2SessionResource,
        snapshotSuffix: String = through,
        digestOverride: String? = null,
    ) {
        val records = records(session)
        val (bytes, digest) = canonicalSnapshotDigest(records)
        repository.stageSnapshotChunkUnderApplyLease(
            chunk(
                namespace = namespace,
                through = through,
                records = records,
                allRecordCount = records.size.toLong(),
                allCanonicalBytes = bytes,
                digest = digestOverride ?: digest,
                isLast = true,
                snapshotSuffix = snapshotSuffix,
            ),
        )
    }

    private fun chunk(
        namespace: RelayV2StateNamespace,
        through: String,
        records: List<RelayV2SnapshotRecord>,
        allRecordCount: Long,
        allCanonicalBytes: Long,
        digest: String,
        chunkIndex: Long = 0,
        requestedCursor: String? = null,
        isLast: Boolean,
        nextCursor: String? = null,
        snapshotSuffix: String = through,
    ) = RelayV2SnapshotChunk(
        namespace = namespace,
        snapshotRequestId = "request-$snapshotSuffix",
        snapshotId = "snapshot-$snapshotSuffix",
        snapshotCreatedAtMs = 100,
        snapshotLeaseExpiresAtMs = 200 + chunkIndex,
        snapshotAbsoluteExpiresAtMs = 1_000,
        chunkIndex = chunkIndex,
        requestedCursor = requestedCursor,
        isLast = isLast,
        nextCursor = nextCursor,
        throughEventSeq = through,
        scopesRevision = "1",
        totalRecords = allRecordCount,
        totalCanonicalBytes = allCanonicalBytes,
        cutDigest = digest,
        records = records,
        rawUtf8Bytes = records.sumOf { it.canonicalJson().toByteArray().size } + 256,
    )

    private fun records(
        session: RelayV2SessionResource,
        sessionsRevision: String = "1",
    ): List<RelayV2SnapshotRecord> = listOf(
        RelayV2SnapshotRecord.Scope(scope()),
        RelayV2SnapshotRecord.SessionsScope("scope-a", sessionsRevision),
        RelayV2SnapshotRecord.Session("scope-a", session),
    )

    private fun event(
        namespace: RelayV2StateNamespace,
        seq: String,
        revision: String,
        change: RelayV2StateChange,
        rawUtf8Bytes: Int = 256,
    ) = RelayV2StateEvent(namespace, seq, revision, change, rawUtf8Bytes)

    private fun hello(
        namespace: RelayV2StateNamespace,
        eventSeq: String,
        resume: RelayV2AppliedCursor?,
        disposition: RelayV2StateHelloDisposition,
    ) = RelayV2StateHello(namespace, eventSeq, resume, disposition)

    private fun namespace(
        profileId: String = "profile-a",
        hostEpoch: String = "epoch-a",
    ) = RelayV2StateNamespace(
        profileId,
        "principal-a",
        "client-a",
        "host-a",
        hostEpoch,
    )

    private fun scope(scopeId: String = "scope-a") = RelayV2ScopeResource(
        scopeId,
        "Local",
        RelayV2ScopeKind.LOCAL,
        RelayV2ScopeReachability.ONLINE,
    )

    private fun session(sessionId: String, displayName: String) = RelayV2SessionResource(
        scopeId = "scope-a",
        sessionId = sessionId,
        kind = RelayV2SessionKind.WORKTREE,
        displayName = displayName,
        project = "project",
        label = null,
        cwd = "/repo/$displayName",
        attached = false,
        windowCount = 1,
        createdAtMs = 1,
        activityAtMs = 2,
    )

    private fun assertOldState(store: FakeStateStore, namespace: RelayV2StateNamespace) {
        assertEquals("2", store.authority(namespace)?.cursorEventSeq)
        assertEquals("stable", store.session(namespace, "scope-a", "session-a")?.item?.displayName)
    }

    private fun assertResync(result: RelayV2StateSyncResult, reason: RelayV2ResyncReason) {
        assertEquals(reason, (result as RelayV2StateSyncResult.ResyncRequired).reason)
    }

    private fun assertRotation(result: RelayV2StateSyncResult, reason: RelayV2RotationReason) {
        assertEquals(reason, (result as RelayV2StateSyncResult.RotationRequired).reason)
    }
}

private class FakeStateStore(
    val v1Sentinel: String = "",
) : RelayV2StateStore {
    private var state = FakeState()
    var failOnNextSessionWrite = false

    override suspend fun <T> transaction(block: RelayV2StateTransaction.() -> T): T {
        val working = state.copyState()
        val transaction = FakeTransaction(working) {
            if (failOnNextSessionWrite) {
                failOnNextSessionWrite = false
                error("injected Room write failure")
            }
        }
        val result = transaction.block()
        state = working
        return result
    }

    fun authority(namespace: RelayV2StateNamespace) = state.authorities[namespace]
    fun scope(namespace: RelayV2StateNamespace, scopeId: String) = state.scopes[namespace to scopeId]
    fun session(namespace: RelayV2StateNamespace, scopeId: String, sessionId: String) =
        state.sessions[SessionKey(namespace, scopeId, sessionId)]

    fun snapshot(namespace: RelayV2StateNamespace) = state.snapshots[namespace]
    fun events(namespace: RelayV2StateNamespace) = state.events.values.filter {
        it.event.namespace == namespace
    }

    fun recordCount(namespace: RelayV2StateNamespace) = state.records[namespace].orEmpty().size
}

private data class FakeState(
    val authorities: MutableMap<RelayV2StateNamespace, RelayV2StoredAuthority> = mutableMapOf(),
    val scopes: MutableMap<Pair<RelayV2StateNamespace, String>, RelayV2StoredScope> = mutableMapOf(),
    val sessions: MutableMap<SessionKey, RelayV2StoredSession> = mutableMapOf(),
    val snapshots: MutableMap<RelayV2StateNamespace, RelayV2StoredSnapshot> = mutableMapOf(),
    val records: MutableMap<RelayV2StateNamespace, MutableList<RelayV2StoredSnapshotRecord>> = mutableMapOf(),
    val events: MutableMap<Pair<RelayV2StateNamespace, String>, RelayV2StoredEvent> = mutableMapOf(),
) {
    fun copyState() = FakeState(
        authorities.toMutableMap(),
        scopes.toMutableMap(),
        sessions.toMutableMap(),
        snapshots.toMutableMap(),
        records.mapValues { it.value.toMutableList() }.toMutableMap(),
        events.toMutableMap(),
    )
}

private data class SessionKey(
    val namespace: RelayV2StateNamespace,
    val scopeId: String,
    val sessionId: String,
)

private class FakeTransaction(
    private val state: FakeState,
    private val beforeSessionWrite: () -> Unit,
) : RelayV2StateTransaction {
    override fun authority(namespace: RelayV2StateNamespace) = state.authorities[namespace]

    override fun putAuthority(authority: RelayV2StoredAuthority) {
        state.authorities[authority.namespace] = authority
    }

    override fun deleteNamespaceState(namespace: RelayV2StateNamespace) {
        state.authorities.remove(namespace)
        state.scopes.keys.removeAll { it.first == namespace }
        state.sessions.keys.removeAll { it.namespace == namespace }
        state.snapshots.remove(namespace)
        state.records.remove(namespace)
        state.events.keys.removeAll { it.first == namespace }
    }

    override fun deleteProfileState(profileId: String) {
        fun RelayV2StateNamespace.matches() = this.profileId == profileId
        state.authorities.keys.removeAll { it.matches() }
        state.scopes.keys.removeAll { it.first.matches() }
        state.sessions.keys.removeAll { it.namespace.matches() }
        state.snapshots.keys.removeAll { it.matches() }
        state.records.keys.removeAll { it.matches() }
        state.events.keys.removeAll { it.first.matches() }
    }

    override fun scope(namespace: RelayV2StateNamespace, scopeId: String) = state.scopes[namespace to scopeId]

    override fun putScope(scope: RelayV2StoredScope) {
        state.scopes[scope.namespace to scope.item.scopeId] = scope
    }

    override fun deleteScope(namespace: RelayV2StateNamespace, scopeId: String) {
        state.scopes.remove(namespace to scopeId)
    }

    override fun deleteScopes(namespace: RelayV2StateNamespace) {
        state.scopes.keys.removeAll { it.first == namespace }
    }

    override fun session(namespace: RelayV2StateNamespace, scopeId: String, sessionId: String) =
        state.sessions[SessionKey(namespace, scopeId, sessionId)]

    override fun putSession(session: RelayV2StoredSession) {
        beforeSessionWrite()
        state.sessions[SessionKey(session.namespace, session.item.scopeId, session.item.sessionId)] = session
    }

    override fun deleteSession(namespace: RelayV2StateNamespace, scopeId: String, sessionId: String) {
        state.sessions.remove(SessionKey(namespace, scopeId, sessionId))
    }

    override fun sessionStats(namespace: RelayV2StateNamespace, scopeId: String): RelayV2StoredSessionStats {
        val rows = state.sessions.filterKeys { it.namespace == namespace && it.scopeId == scopeId }.values
        return RelayV2StoredSessionStats(rows.size.toLong(), rows.sumOf { it.canonicalBytes })
    }

    override fun deleteSessionsForScope(namespace: RelayV2StateNamespace, scopeId: String) {
        state.sessions.keys.removeAll { it.namespace == namespace && it.scopeId == scopeId }
    }

    override fun deleteSessions(namespace: RelayV2StateNamespace) {
        state.sessions.keys.removeAll { it.namespace == namespace }
    }

    override fun snapshot(namespace: RelayV2StateNamespace) = state.snapshots[namespace]

    override fun putSnapshot(snapshot: RelayV2StoredSnapshot) {
        state.snapshots[snapshot.namespace] = snapshot
    }

    override fun deleteSnapshot(namespace: RelayV2StateNamespace) {
        state.snapshots.remove(namespace)
        state.records.remove(namespace)
    }

    override fun putSnapshotRecords(records: List<RelayV2StoredSnapshotRecord>) {
        if (records.isEmpty()) return
        val destination = state.records.getOrPut(records.first().namespace) { mutableListOf() }
        records.forEach { record ->
            check(destination.none { it.snapshotId == record.snapshotId && it.recordIndex == record.recordIndex })
            destination += record
        }
    }

    override fun visitSnapshotRecords(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
        visitor: (RelayV2StoredSnapshotRecord) -> Unit,
    ) {
        state.records[namespace].orEmpty()
            .filter { it.snapshotId == snapshotId }
            .sortedBy { it.recordIndex }
            .forEach(visitor)
    }

    override fun stagedScope(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
        scopeId: String,
    ): RelayV2StoredScope? {
        val records = state.records[namespace].orEmpty().filter { it.snapshotId == snapshotId }
        val scope = records.firstNotNullOfOrNull {
            (it.record as? RelayV2SnapshotRecord.Scope)?.takeIf { value -> value.item.scopeId == scopeId }
                ?.let { value -> it to value }
        } ?: return null
        val sessionsScope = records.firstNotNullOfOrNull {
            (it.record as? RelayV2SnapshotRecord.SessionsScope)?.takeIf { value -> value.scopeId == scopeId }
                ?.let { value -> it to value }
        } ?: return null
        return RelayV2StoredScope(
            namespace,
            scope.second.item,
            sessionsScope.second.revision,
            scope.first.canonicalJson,
            sessionsScope.first.canonicalJson,
        )
    }

    override fun stagedSession(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
        scopeId: String,
        sessionId: String,
    ): RelayV2StoredSession? = state.records[namespace].orEmpty().firstNotNullOfOrNull {
        (it.record as? RelayV2SnapshotRecord.Session)?.takeIf { value ->
            value.scopeId == scopeId && value.item.sessionId == sessionId && it.snapshotId == snapshotId
        }?.let { value -> RelayV2StoredSession(namespace, value.item, it.canonicalJson) }
    }

    override fun stagedSessionStats(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
        scopeId: String,
    ): RelayV2StoredSessionStats {
        val rows = state.records[namespace].orEmpty().filter {
            it.snapshotId == snapshotId &&
                (it.record as? RelayV2SnapshotRecord.Session)?.scopeId == scopeId
        }
        return RelayV2StoredSessionStats(
            rows.size.toLong(),
            rows.sumOf { it.canonicalJson.toByteArray().size.toLong() },
        )
    }

    override fun stagedSessionsRevision(
        namespace: RelayV2StateNamespace,
        snapshotId: String,
        scopeId: String,
    ): String? = state.records[namespace].orEmpty().firstNotNullOfOrNull {
        (it.record as? RelayV2SnapshotRecord.SessionsScope)?.takeIf { value ->
            value.scopeId == scopeId && it.snapshotId == snapshotId
        }?.revision
    }

    override fun bufferedEvent(namespace: RelayV2StateNamespace, eventSeq: String) =
        state.events[namespace to eventSeq]

    override fun putBufferedEvent(event: RelayV2StoredEvent) {
        check(state.events.putIfAbsent(event.event.namespace to event.event.eventSeq, event) == null)
    }

    override fun bufferedEvents(namespace: RelayV2StateNamespace) = state.events.values
        .filter { it.event.namespace == namespace }
        .sortedBy { it.eventSeqOrder }

    override fun bufferedEventCount(namespace: RelayV2StateNamespace) =
        state.events.count { it.key.first == namespace }.toLong()

    override fun bufferedEventRawBytes(namespace: RelayV2StateNamespace) = state.events.values
        .filter { it.event.namespace == namespace }
        .sumOf { it.event.rawUtf8Bytes.toLong() }

    override fun deleteBufferedEvents(namespace: RelayV2StateNamespace) {
        state.events.keys.removeAll { it.first == namespace }
    }
}
