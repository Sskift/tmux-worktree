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

        val fresh = repository.applyHelloForTest(
            hello(epochA, "5", null, RelayV2StateHelloDisposition.FRESH),
        )
        assertResync(fresh, RelayV2ResyncReason.FRESH)
        commitCut(repository, epochA, through = "5", session = session("session-a", "old"))

        val matched = repository.applyHelloForTest(
            hello(epochA, "5", RelayV2AppliedCursor("epoch-a", "5"), RelayV2StateHelloDisposition.MATCHED),
        )
        assertTrue(matched is RelayV2StateSyncResult.Live)
        assertEquals("5", store.authority(epochA)?.requiredThroughEventSeq)

        val behind = repository.applyHelloForTest(
            hello(epochA, "7", RelayV2AppliedCursor("epoch-a", "5"), RelayV2StateHelloDisposition.CURSOR_BEHIND),
        )
        assertResync(behind, RelayV2ResyncReason.CURSOR_BEHIND)
        assertEquals("7", store.authority(epochA)?.requiredThroughEventSeq)

        val regressed = repository.applyHelloForTest(
            hello(epochA, "6", RelayV2AppliedCursor("epoch-a", "5"), RelayV2StateHelloDisposition.CURSOR_BEHIND),
        )
        assertRotation(regressed, RelayV2RotationReason.REQUIRED_WATERMARK_REGRESSED)
        assertEquals("7", store.authority(epochA)?.requiredThroughEventSeq)

        val ahead = repository.applyHelloForTest(
            hello(epochA, "5", RelayV2AppliedCursor("epoch-a", "6"), RelayV2StateHelloDisposition.EVENT_CURSOR_AHEAD),
        )
        assertRotation(ahead, RelayV2RotationReason.EVENT_CURSOR_AHEAD)
        assertEquals("5", store.authority(epochA)?.cursorEventSeq)

        val epochB = namespace(hostEpoch = "epoch-b")
        val changed = repository.applyHelloForTest(
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
        repository.applyHelloForTest(
            hello(namespace, "3", null, RelayV2StateHelloDisposition.FRESH),
        )
        commitCut(repository, namespace, "3", session("session-a", "at-3"))

        repository.applyHelloForTest(
            hello(
                namespace,
                "4",
                RelayV2AppliedCursor(namespace.hostEpoch, "3"),
                RelayV2StateHelloDisposition.CURSOR_BEHIND,
            ),
        )
        stageCut(repository, namespace, through = "4", session = session("session-a", "at-4"))

        val ordinaryReconnect = repository.applyHelloForTest(
            hello(
                namespace,
                "4",
                RelayV2AppliedCursor(namespace.hostEpoch, "3"),
                RelayV2StateHelloDisposition.CURSOR_BEHIND,
            ),
        ) as RelayV2StateSyncResult.ResyncRequired
        assertEquals(RelayV2ResyncReason.SNAPSHOT_RESTART_REQUIRED, ordinaryReconnect.reason)
        val interruptedCut = requireNotNull(ordinaryReconnect.release)
        assertEquals("snapshot-4", interruptedCut.snapshotId)
        assertNull(store.snapshot(namespace))
        assertEquals(
            interruptedCut,
            repository.completeSnapshotReleaseUnderApplyLease(interruptedCut)?.release,
        )

        // seq=5 was committed by the host while this route was disconnected and was never buffered.
        val reconnected = repository.applyHelloForTest(
            hello(
                namespace,
                "5",
                RelayV2AppliedCursor(namespace.hostEpoch, "3"),
                RelayV2StateHelloDisposition.CURSOR_BEHIND,
            ),
        ) as RelayV2StateSyncResult.ResyncRequired

        assertEquals(RelayV2ResyncReason.CURSOR_BEHIND, reconnected.reason)
        assertNull(reconnected.release)
        assertNull(store.snapshot(namespace))
        assertEquals("at-3", store.session(namespace, "scope-a", "session-a")?.item?.displayName)

        commitCut(repository, namespace, "5", session("session-a", "at-5"), snapshotSuffix = "5")
        assertEquals("5", store.authority(namespace)?.cursorEventSeq)
        assertEquals("at-5", store.session(namespace, "scope-a", "session-a")?.item?.displayName)
    }

    @Test
    fun `durable release journal survives reopen and blocks a fresh cut until exact proof`() =
        runBlocking {
            val store = FakeStateStore()
            val repository = RelayV2StateSyncRepositoryCore(store)
            val namespace = namespace()
        repository.applyHelloForTest(
                hello(namespace, "2", null, RelayV2StateHelloDisposition.FRESH),
            )
            commitCut(repository, namespace, "2", session("session-a", "stable"))
        repository.applyHelloForTest(
                hello(
                    namespace,
                    "3",
                    RelayV2AppliedCursor(namespace.hostEpoch, "2"),
                    RelayV2StateHelloDisposition.CURSOR_BEHIND,
                ),
            )
            stageCut(repository, namespace, "3", session("session-a", "staged"))

            repeat(16) { offset ->
                repository.applyStateEventUnderApplyLease(
                    event(
                        namespace,
                        seq = (4 + offset).toString(),
                        revision = (2 + offset).toString(),
                        RelayV2StateChange.SessionUpsert(session("session-a", "buffer-$offset")),
                        rawUtf8Bytes = RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES,
                    ),
                )
            }
            val overflow = repository.applyStateEventUnderApplyLease(
                event(
                    namespace,
                    seq = "20",
                    revision = "18",
                    RelayV2StateChange.SessionUpsert(session("session-a", "overflow")),
                    rawUtf8Bytes = RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES,
                ),
            ) as RelayV2StateSyncResult.ResyncRequired
            val pending = requireNotNull(overflow.release)
            assertEquals(RelayV2ResyncReason.EVENT_BUFFER_OVERFLOW, overflow.reason)
            assertEquals("snapshot-3", pending.snapshotId)
            assertNull(store.snapshot(namespace))
            assertTrue(store.events(namespace).isEmpty())
            assertEquals("20", store.authority(namespace)?.requiredThroughEventSeq)

            // Simulate socket/process loss by constructing a new repository over the same store.
            val reopened = RelayV2StateSyncRepositoryCore(store)
            assertRotation(
                reopened.applyHelloForTest(
                    hello(
                        namespace,
                        "3",
                        RelayV2AppliedCursor(namespace.hostEpoch, "2"),
                        RelayV2StateHelloDisposition.CURSOR_BEHIND,
                    ),
                ),
                RelayV2RotationReason.REQUIRED_WATERMARK_REGRESSED,
            )
            val recovered = reopened.applyHelloForTest(
                hello(
                    namespace,
                    "20",
                    RelayV2AppliedCursor(namespace.hostEpoch, "2"),
                    RelayV2StateHelloDisposition.CURSOR_BEHIND,
                ),
            ) as RelayV2StateSyncResult.ReleasePending
            assertEquals(pending, recovered.release)

            val blocked = reopened.stageSnapshotChunkUnderApplyLease(
                snapshotChunk(
                    namespace,
                    through = "3",
                    snapshotSuffix = "fresh-3",
                    session = session("session-a", "fresh"),
                ),
            )
            assertEquals(pending, (blocked as RelayV2StateSyncResult.ReleasePending).release)
            assertNull(
                reopened.completeSnapshotReleaseUnderApplyLease(
                    pending.copy(snapshotId = "different-cut-uuid"),
                ),
            )
            assertEquals(
                pending,
                (reopened.applyHelloForTest(
                    hello(
                        namespace,
                        "20",
                        RelayV2AppliedCursor(namespace.hostEpoch, "2"),
                        RelayV2StateHelloDisposition.CURSOR_BEHIND,
                    ),
                ) as RelayV2StateSyncResult.ReleasePending).release,
            )

            assertEquals(
                pending,
                reopened.completeSnapshotReleaseUnderApplyLease(pending)?.release,
            )
            assertResync(
                reopened.applyHelloForTest(
                    hello(
                        namespace,
                        "20",
                        RelayV2AppliedCursor(namespace.hostEpoch, "2"),
                        RelayV2StateHelloDisposition.CURSOR_BEHIND,
                    ),
                ),
                RelayV2ResyncReason.CURSOR_BEHIND,
            )
            val fresh = reopened.stageSnapshotChunkUnderApplyLease(
                snapshotChunk(
                    namespace,
                    through = "3",
                    snapshotSuffix = "fresh-3",
                    session = session("session-a", "fresh"),
                ),
            )
            assertTrue(fresh is RelayV2StateSyncResult.SnapshotStaged)
            val insufficient = reopened.commitSnapshotUnderApplyLease(
                namespace,
                "snapshot-fresh-3",
            ) as RelayV2StateSyncResult.ResyncRequired
            assertEquals(RelayV2ResyncReason.EVENT_GAP, insufficient.reason)
            assertNotNull(insufficient.release)
            assertNull(store.snapshot(namespace))
        }

    @Test
    fun `release CAS rejects semantically contradictory durable journal facts`() = runBlocking {
        val namespace = namespace()
        val release = RelayV2SnapshotReleaseObligation(
            namespace = namespace,
            snapshotRequestId = "release-request",
            snapshotId = "release-snapshot",
            durableCursorEventSeq = "7",
            reason = RelayV2SnapshotReleaseReason.COMPLETED,
        )
        val valid = RelayV2StoredAuthority(
            namespace = namespace,
            cursorEventSeq = "7",
            requiredThroughEventSeq = "7",
            scopesRevision = "3",
            phase = RelayV2StoredSyncPhase.RESYNCING,
            cacheRecordCount = 0,
            cacheCanonicalBytes = 2,
            pendingRelease = release,
            afterReleasePhase = RelayV2PostReleasePhase.QUERY_PENDING_COMMANDS,
        )
        val otherNamespace = namespace.copy(principalId = "principal-other")
        val contradictions = listOf(
            valid.copy(pendingRelease = release.copy(namespace = otherNamespace)),
            valid.copy(phase = RelayV2StoredSyncPhase.LIVE),
            valid.copy(pendingRelease = release.copy(durableCursorEventSeq = "6")),
            valid.copy(requiredThroughEventSeq = "8"),
            valid.copy(
                pendingRelease = release.copy(reason = RelayV2SnapshotReleaseReason.FRESH),
            ),
        )

        contradictions.forEach { corrupt ->
            val store = FakeStateStore()
            store.transaction { putAuthority(corrupt) }
            val repository = RelayV2StateSyncRepositoryCore(store)
            val failure = runCatching {
                repository.completeSnapshotReleaseUnderApplyLease(release)
            }.exceptionOrNull()
            assertNotNull("Contradictory journal must fail closed: $corrupt", failure)
            assertEquals(corrupt.pendingRelease, store.authority(namespace)?.pendingRelease)
        }
    }

    @Test
    fun `connect plan reopens one durable epoch and rejects ambiguous epochs`() = runBlocking {
        val store = FakeStateStore()
        val repository = RelayV2StateSyncRepositoryCore(store)
        val namespace = namespace()
        val identity = RelayV2StateConnectIdentity(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
        )
        repository.applyHelloForTest(
            hello(namespace, "7", null, RelayV2StateHelloDisposition.FRESH),
        )
        stageCut(repository, namespace, "7", session("session-a", "durable"))
        repository.commitSnapshotUnderApplyLease(namespace, "snapshot-7")

        val reopened = RelayV2StateSyncRepositoryCore(store).loadConnectPlan(identity)
        assertEquals(RelayV2AppliedCursor(namespace.hostEpoch, "7"), reopened.resume)
        assertEquals(RelayV2StateConnectRecovery.RELEASE_PENDING, reopened.recovery)

        store.transaction {
            putAuthority(
                RelayV2StoredAuthority(
                    namespace = namespace.copy(hostEpoch = "epoch-other"),
                    cursorEventSeq = null,
                    requiredThroughEventSeq = "1",
                    scopesRevision = null,
                    phase = RelayV2StoredSyncPhase.RESYNCING,
                    cacheRecordCount = 0,
                    cacheCanonicalBytes = 2,
                ),
            )
        }
        assertNotNull(
            runCatching { repository.loadConnectPlan(identity) }.exceptionOrNull(),
        )
    }

    @Test
    fun `connect plan rejects impossible durable continuation shapes at load`() = runBlocking {
        val namespace = namespace()
        val identity = RelayV2StateConnectIdentity(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
        )
        val base = RelayV2StoredSnapshot(
            namespace = namespace,
            snapshotRequestId = "request-corrupt",
            snapshotId = "snapshot-corrupt",
            snapshotCreatedAtMs = 1,
            snapshotLeaseExpiresAtMs = 2,
            snapshotAbsoluteExpiresAtMs = 3,
            throughEventSeq = "7",
            scopesRevision = "1",
            totalRecords = 3,
            totalCanonicalBytes = 10,
            cutDigest = "corrupt-digest",
            nextChunkIndex = 1,
            nextCursor = "cursor-next",
            receivedRecords = 1,
            receivedRecordCanonicalBytes = 2,
            receivedRawUtf8Bytes = 3,
            lastScopeId = "scope-a",
            lastRecordKind = "scope",
            lastSessionId = null,
            complete = false,
        )
        listOf(
            base.copy(nextChunkIndex = 0),
            base.copy(complete = true),
            base.copy(nextCursor = null),
        ).forEach { corrupt ->
            val store = FakeStateStore()
            store.transaction {
                putAuthority(
                    RelayV2StoredAuthority(
                        namespace,
                        cursorEventSeq = null,
                        requiredThroughEventSeq = "7",
                        scopesRevision = null,
                        phase = RelayV2StoredSyncPhase.RESYNCING,
                        cacheRecordCount = 0,
                        cacheCanonicalBytes = 2,
                    ),
                )
                putSnapshot(corrupt)
            }
            assertNotNull(
                runCatching {
                    RelayV2StateSyncRepositoryCore(store).loadConnectPlan(identity)
                }.exceptionOrNull(),
            )
        }
    }

    @Test
    fun `pending release buffers later event and exact ACK uses latest restart plan`() =
        runBlocking {
            val store = FakeStateStore()
            val repository = RelayV2StateSyncRepositoryCore(store)
            val namespace = namespace()
        repository.applyHelloForTest(
                hello(namespace, "3", null, RelayV2StateHelloDisposition.FRESH),
            )
            stageCut(repository, namespace, "3", session("session-a", "cut-3"))
            val committed = repository.commitSnapshotUnderApplyLease(namespace, "snapshot-3")
                as RelayV2StateSyncResult.SnapshotCommitted
            val token = committed.release.opaqueToken

            val buffered = repository.applyStateEventUnderApplyLease(
                event(
                    namespace,
                    "4",
                    "2",
                    RelayV2StateChange.SessionUpsert(session("session-a", "event-4")),
                ),
            ) as RelayV2StateSyncResult.EventBuffered
            assertEquals("4", buffered.eventSeq)
            assertEquals(token, store.authority(namespace)?.pendingRelease?.opaqueToken)
            assertEquals(1, store.events(namespace).size)

            assertEquals(
                RelayV2SnapshotReleaseCompletion(
                    committed.release,
                    RelayV2PostReleasePhase.RESTART_SNAPSHOT,
                ),
                repository.completeSnapshotReleaseUnderApplyLease(committed.release),
            )
            stageCut(
                repository,
                namespace,
                through = "3",
                session = session("session-a", "cut-3-retry"),
                snapshotSuffix = "retry-3",
            )
            val retried = repository.commitSnapshotUnderApplyLease(
                namespace,
                "snapshot-retry-3",
            ) as RelayV2StateSyncResult.SnapshotCommitted
            assertEquals("4", retried.cursorEventSeq)
            assertEquals("event-4", store.session(
                namespace,
                "scope-a",
                "session-a",
            )?.item?.displayName)
        }

    @Test
    fun `snapshot staging rejects advertised canonical total before writing records`() =
        runBlocking {
            val store = FakeStateStore()
            val repository = RelayV2StateSyncRepositoryCore(store)
            val namespace = namespace()
        repository.applyHelloForTest(
                hello(namespace, "3", null, RelayV2StateHelloDisposition.FRESH),
            )
            val chunk = snapshotChunk(
                namespace,
                through = "3",
                snapshotSuffix = "undersized-total",
                session = session("session-a", "small-payload"),
            )
            val rejected = repository.stageSnapshotChunkUnderApplyLease(
                chunk.copy(totalCanonicalBytes = chunk.totalCanonicalBytes - 1),
            ) as RelayV2StateSyncResult.ResyncRequired
            assertEquals(RelayV2ResyncReason.SNAPSHOT_LIMIT_EXCEEDED, rejected.reason)
            assertEquals(0, store.recordCount(namespace))
            assertNull(store.snapshot(namespace))
        }

    @Test
    fun `conflicting seq20 survives reopen as a required recovery watermark`() = runBlocking {
        val store = FakeStateStore()
        val repository = RelayV2StateSyncRepositoryCore(store)
        val namespace = namespace()
        repository.applyHelloForTest(
            hello(namespace, "2", null, RelayV2StateHelloDisposition.FRESH),
        )
        commitCut(repository, namespace, "2", session("session-a", "stable"))
        repository.applyHelloForTest(
            hello(
                namespace,
                "3",
                RelayV2AppliedCursor(namespace.hostEpoch, "2"),
                RelayV2StateHelloDisposition.CURSOR_BEHIND,
            ),
        )

        assertBuffered(
            repository.applyStateEventUnderApplyLease(
                event(
                    namespace,
                    "20",
                    "2",
                    RelayV2StateChange.SessionUpsert(session("session-a", "first-20")),
                ),
            ),
            "20",
        )
        val conflict = repository.applyStateEventUnderApplyLease(
            event(
                namespace,
                "20",
                "2",
                RelayV2StateChange.SessionUpsert(session("session-a", "conflicting-20")),
            ),
        ) as RelayV2StateSyncResult.ResyncRequired
        assertEquals(RelayV2ResyncReason.EVENT_REVISION_CONFLICT, conflict.reason)
        assertEquals("20", store.authority(namespace)?.requiredThroughEventSeq)
        assertTrue(store.events(namespace).isEmpty())

        val reopened = RelayV2StateSyncRepositoryCore(store)
        assertRotation(
            reopened.applyHelloForTest(
                hello(
                    namespace,
                    "3",
                    RelayV2AppliedCursor(namespace.hostEpoch, "2"),
                    RelayV2StateHelloDisposition.CURSOR_BEHIND,
                ),
            ),
            RelayV2RotationReason.REQUIRED_WATERMARK_REGRESSED,
        )
        stageCut(reopened, namespace, "3", session("session-a", "insufficient"))
        val insufficient = reopened.commitSnapshotUnderApplyLease(namespace, "snapshot-3")
            as RelayV2StateSyncResult.ResyncRequired
        assertEquals(RelayV2ResyncReason.EVENT_GAP, insufficient.reason)
        assertNotNull(insufficient.release)
        assertNull(store.snapshot(namespace))
    }

    @Test
    fun `pending completed release persists restart plan and cannot bypass watermark regression`() =
        runBlocking {
            val store = FakeStateStore()
            val repository = RelayV2StateSyncRepositoryCore(store)
            val namespace = namespace()
        repository.applyHelloForTest(
                hello(namespace, "3", null, RelayV2StateHelloDisposition.FRESH),
            )
            stageCut(repository, namespace, "3", session("session-a", "committed"))
            val committed = repository.commitSnapshotUnderApplyLease(namespace, "snapshot-3")
                as RelayV2StateSyncResult.SnapshotCommitted
            assertEquals(
                RelayV2PostReleasePhase.QUERY_PENDING_COMMANDS,
                committed.afterReleasePhase,
            )
            val pendingFromEvent = repository.applyStateEventUnderApplyLease(
                event(
                    namespace,
                    "20",
                    "2",
                    RelayV2StateChange.SessionUpsert(session("session-a", "observed-20")),
                ),
            ) as RelayV2StateSyncResult.EventBuffered
            assertEquals("20", pendingFromEvent.eventSeq)
            assertEquals(committed.release, store.authority(namespace)?.pendingRelease)
            assertEquals(
                RelayV2PostReleasePhase.RESTART_SNAPSHOT,
                store.authority(namespace)?.afterReleasePhase,
            )
            assertEquals("20", store.authority(namespace)?.requiredThroughEventSeq)

            assertRotation(
        repository.applyHelloForTest(
                    hello(
                        namespace,
                        "4",
                        RelayV2AppliedCursor(namespace.hostEpoch, "3"),
                        RelayV2StateHelloDisposition.CURSOR_BEHIND,
                    ),
                ),
                RelayV2RotationReason.REQUIRED_WATERMARK_REGRESSED,
            )
            val behind = repository.applyHelloForTest(
                hello(
                    namespace,
                    "20",
                    RelayV2AppliedCursor(namespace.hostEpoch, "3"),
                    RelayV2StateHelloDisposition.CURSOR_BEHIND,
                ),
            ) as RelayV2StateSyncResult.ReleasePending
            assertEquals(
                RelayV2PostReleasePhase.RESTART_SNAPSHOT,
                behind.afterReleasePhase,
            )
            assertEquals(RelayV2StoredSyncPhase.RESYNCING, store.authority(namespace)?.phase)

            // Simulate release ACK after process restart. The exact transaction returns the
            // durable post-release plan and leaves the authority ready to stage a fresh cut.
            val reopened = RelayV2StateSyncRepositoryCore(store)
            assertEquals(
                RelayV2SnapshotReleaseCompletion(
                    behind.release,
                    RelayV2PostReleasePhase.RESTART_SNAPSHOT,
                ),
                reopened.completeSnapshotReleaseUnderApplyLease(behind.release),
            )
            assertEquals(RelayV2StoredSyncPhase.RESYNCING, store.authority(namespace)?.phase)
            val fresh = snapshotChunk(
                namespace,
                through = "4",
                snapshotSuffix = "after-release",
                session = session("session-a", "fresh"),
            )
            assertTrue(
                reopened.stageSnapshotChunkUnderApplyLease(fresh) is
                    RelayV2StateSyncResult.SnapshotStaged,
            )
            val insufficient = reopened.commitSnapshotUnderApplyLease(
                namespace,
                "snapshot-after-release",
            ) as RelayV2StateSyncResult.ResyncRequired
            assertEquals(RelayV2ResyncReason.EVENT_GAP, insufficient.reason)
        }

    @Test
    fun `streamed complete cut and durable buffered event commit atomically`() = runBlocking {
        val store = FakeStateStore()
        val repository = RelayV2StateSyncRepositoryCore(store)
        val namespace = namespace()
        repository.applyHelloForTest(
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
        repository.applyHelloForTest(
            hello(namespace, "1", null, RelayV2StateHelloDisposition.FRESH),
        )
        commitCut(repository, namespace, "1", session("session-a", "stable"))
        repository.applyHelloForTest(
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
        assertNotNull((wrongCursor as RelayV2StateSyncResult.ResyncRequired).release)
        assertNull(store.snapshot(namespace))
        assertEquals("stable", store.session(namespace, "scope-a", "session-a")?.item?.displayName)
        completePendingRelease(repository, wrongCursor)

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
        completePendingRelease(repository, wrongOrder)

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
        repository.applyHelloForTest(
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
            assertBuffered(gap, "4")
            assertOldState(store, namespace)
        }

        run {
            val (store, repository) = seeded()
        repository.applyHelloForTest(
                hello(
                    namespace,
                    "4",
                    RelayV2AppliedCursor(namespace.hostEpoch, "2"),
                    RelayV2StateHelloDisposition.CURSOR_BEHIND,
                ),
            )
            stageCut(repository, namespace, "3", session("session-a", "gap-cut"))
            val gap = repository.commitSnapshotUnderApplyLease(namespace, "snapshot-3")
                as RelayV2StateSyncResult.ResyncRequired
            assertEquals(RelayV2ResyncReason.EVENT_GAP, gap.reason)
            assertNotNull(gap.release)
            assertNull(store.snapshot(namespace))
            assertOldState(store, namespace)
        }

        run {
            val (store, repository) = seeded()
        repository.applyHelloForTest(
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
        repository.applyHelloForTest(
                hello(
                    namespace,
                    "3",
                    RelayV2AppliedCursor(namespace.hostEpoch, "2"),
                    RelayV2StateHelloDisposition.CURSOR_BEHIND,
                ),
            )
            val (emptyBytes, emptyDigest) = canonicalSnapshotDigest(emptyList())
            var cursor: String? = null
            repeat(512) { index ->
                val next = "cursor-${index + 1}"
                val staged = repository.stageSnapshotChunkUnderApplyLease(
                    chunk(
                        namespace = namespace,
                        through = "3",
                        records = emptyList(),
                        allRecordCount = 0,
                        allCanonicalBytes = emptyBytes,
                        digest = emptyDigest,
                        chunkIndex = index.toLong(),
                        requestedCursor = cursor,
                        isLast = false,
                        nextCursor = next,
                        snapshotSuffix = "staging-overflow",
                        rawUtf8Bytes = RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES,
                    ),
                )
                assertTrue(staged is RelayV2StateSyncResult.SnapshotStaged)
                cursor = next
            }
            val overflow = repository.stageSnapshotChunkUnderApplyLease(
                chunk(
                    namespace = namespace,
                    through = "3",
                    records = emptyList(),
                    allRecordCount = 0,
                    allCanonicalBytes = emptyBytes,
                    digest = emptyDigest,
                    chunkIndex = 512,
                    requestedCursor = cursor,
                    isLast = false,
                    nextCursor = "cursor-513",
                    snapshotSuffix = "staging-overflow",
                    rawUtf8Bytes = RelayV2StateLimits.MAX_PUBLIC_FRAME_BYTES,
                ),
            ) as RelayV2StateSyncResult.ResyncRequired
            assertEquals(RelayV2ResyncReason.SNAPSHOT_LIMIT_EXCEEDED, overflow.reason)
            assertNotNull(overflow.release)
            assertNull(store.snapshot(namespace))
            assertOldState(store, namespace)
        }

        run {
            val (store, repository) = seeded()
        repository.applyHelloForTest(
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
            assertNull(store.snapshot(namespace))
            assertOldState(store, namespace)
        }

        run {
            val (store, repository) = seeded()
        repository.applyHelloForTest(
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
            assertNotNull((failed as RelayV2StateSyncResult.ResyncRequired).release)
            assertNull(store.snapshot(namespace))
            assertOldState(store, namespace)
        }
    }

    @Test
    fun `unknown epoch cannot pollute current namespace and v1 sentinel remains isolated`() = runBlocking {
        val store = FakeStateStore(v1Sentinel = "v1-host+name-row")
        val repository = RelayV2StateSyncRepositoryCore(store)
        val current = namespace(hostEpoch = "epoch-current")
        repository.applyHelloForTest(
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
        repository.applyHelloForTest(
            hello(first, "1", null, RelayV2StateHelloDisposition.FRESH),
        )
        commitCut(repository, first, "1", session("session-one", "one"))
        repository.applyHelloForTest(
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
        repository.applyHelloForTest(
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
        repository.applyHelloForTest(
            hello(namespace, "1", null, RelayV2StateHelloDisposition.FRESH),
        )
        commitCut(repository, namespace, "1", session("session-a", "old"))
        repository.applyHelloForTest(
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

    @Test
    fun `materialized session read returns one exact committed cut and ignores staging`() =
        runBlocking {
            val store = FakeStateStore()
            val repository = RelayV2StateSyncRepositoryCore(store)
            val namespace = namespace()
            val committedSession = session("session-a", "committed")
            repository.applyHelloForTest(
                hello(namespace, "1", null, RelayV2StateHelloDisposition.FRESH),
            )
            commitCut(repository, namespace, "1", committedSession)

            val committedCut = RelayV2MaterializedSessionReadCut(
                namespace = namespace,
                cursor = RelayV2AppliedCursor(namespace.hostEpoch, "1"),
                scopesRevision = "1",
                scope = scope(),
                sessionsRevision = "1",
                session = committedSession,
            )
            assertEquals(
                committedCut,
                repository.readMaterializedSessionCut(namespace, "scope-a", "session-a"),
            )

            repository.applyHelloForTest(
                hello(
                    namespace,
                    "2",
                    RelayV2AppliedCursor(namespace.hostEpoch, "1"),
                    RelayV2StateHelloDisposition.CURSOR_BEHIND,
                ),
            )
            stageCut(repository, namespace, "2", session("session-a", "staged-newer"))

            assertNotNull(store.snapshot(namespace))
            assertEquals(
                committedCut,
                repository.readMaterializedSessionCut(namespace, "scope-a", "session-a"),
            )
        }

    @Test
    fun `materialized Session projection returns only the exact committed namespace cut`() =
        runBlocking {
            val store = FakeStateStore()
            val repository = RelayV2StateSyncRepositoryCore(store)
            val selectedNamespace = namespace()
            val foreignNamespace = namespace(profileId = "profile-foreign")
            repository.applyHelloForTest(
                hello(selectedNamespace, "1", null, RelayV2StateHelloDisposition.FRESH),
            )
            commitCut(repository, selectedNamespace, "1", session("session-a", "committed"))
            repository.applyHelloForTest(
                hello(foreignNamespace, "1", null, RelayV2StateHelloDisposition.FRESH),
            )
            commitCut(
                repository,
                foreignNamespace,
                "1",
                session("session-foreign", "foreign"),
                snapshotSuffix = "foreign",
            )
            repository.applyHelloForTest(
                hello(
                    selectedNamespace,
                    "2",
                    RelayV2AppliedCursor(selectedNamespace.hostEpoch, "1"),
                    RelayV2StateHelloDisposition.CURSOR_BEHIND,
                ),
            )
            stageCut(
                repository,
                selectedNamespace,
                "2",
                session("session-a", "staged-newer"),
            )

            val projection = repository.readMaterializedSessionCuts(selectedNamespace)

            assertEquals(1, projection.size)
            assertEquals(selectedNamespace, projection.single().namespace)
            assertEquals("session-a", projection.single().session.sessionId)
            assertEquals("committed", projection.single().session.displayName)
        }

    @Test
    fun `materialized session read requires all seven opaque identity dimensions`() = runBlocking {
        val store = FakeStateStore()
        val repository = RelayV2StateSyncRepositoryCore(store)
        val namespace = namespace()
        val selected = session("session-a", "same-display-name")
        repository.applyHelloForTest(
            hello(namespace, "1", null, RelayV2StateHelloDisposition.FRESH),
        )
        commitCut(repository, namespace, "1", selected)
        repository.applyStateEventUnderApplyLease(
            event(
                namespace,
                seq = "2",
                revision = "2",
                RelayV2StateChange.SessionUpsert(
                    session("same-name-other-id", "same-display-name"),
                ),
            ),
        )

        val exact = requireNotNull(
            repository.readMaterializedSessionCut(namespace, "scope-a", "session-a"),
        )
        assertEquals(RelayV2AppliedCursor(namespace.hostEpoch, "2"), exact.cursor)
        assertEquals("1", exact.scopesRevision)
        assertEquals("2", exact.sessionsRevision)
        assertEquals(selected, exact.session)

        val mismatches = listOf(
            "profileId" to Triple(namespace.copy(profileId = "profile-other"), "scope-a", "session-a"),
            "principalId" to Triple(
                namespace.copy(principalId = "principal-other"),
                "scope-a",
                "session-a",
            ),
            "clientInstanceId" to Triple(
                namespace.copy(clientInstanceId = "client-other"),
                "scope-a",
                "session-a",
            ),
            "hostId" to Triple(namespace.copy(hostId = "host-other"), "scope-a", "session-a"),
            "hostEpoch" to Triple(
                namespace.copy(hostEpoch = "epoch-other"),
                "scope-a",
                "session-a",
            ),
            "scopeId" to Triple(namespace, "scope-other", "session-a"),
            "sessionId" to Triple(namespace, "scope-a", "session-other"),
        )
        mismatches.forEach { (dimension, lookup) ->
            assertNull(
                dimension,
                repository.readMaterializedSessionCut(lookup.first, lookup.second, lookup.third),
            )
        }
    }

    @Test
    fun `materialized session read distinguishes normal absence from contradictory rows`() =
        runBlocking {
            val emptyStore = FakeStateStore()
            val emptyRepository = RelayV2StateSyncRepositoryCore(emptyStore)
            val emptyNamespace = namespace(profileId = "profile-empty")
            assertNull(
                emptyRepository.readMaterializedSessionCut(
                    emptyNamespace,
                    "scope-a",
                    "session-a",
                ),
            )
            emptyRepository.applyHelloForTest(
                hello(emptyNamespace, "1", null, RelayV2StateHelloDisposition.FRESH),
            )
            assertNull(
                emptyRepository.readMaterializedSessionCut(
                    emptyNamespace,
                    "scope-a",
                    "session-a",
                ),
            )

            val committedStore = FakeStateStore()
            val committedRepository = RelayV2StateSyncRepositoryCore(committedStore)
            val committedNamespace = namespace(profileId = "profile-committed")
            committedRepository.applyHelloForTest(
                hello(committedNamespace, "1", null, RelayV2StateHelloDisposition.FRESH),
            )
            commitCut(
                committedRepository,
                committedNamespace,
                "1",
                session("session-a", "committed"),
            )
            assertNull(
                committedRepository.readMaterializedSessionCut(
                    committedNamespace,
                    "scope-missing",
                    "session-a",
                ),
            )
            assertNull(
                committedRepository.readMaterializedSessionCut(
                    committedNamespace,
                    "scope-a",
                    "session-missing",
                ),
            )

            val noAuthority = FakeStateStore()
            val noAuthorityNamespace = namespace(profileId = "profile-no-authority")
            noAuthority.transaction {
                putScope(storedScopeForTest(noAuthorityNamespace))
            }

            val orphanSession = FakeStateStore()
            val orphanNamespace = namespace(profileId = "profile-orphan")
            orphanSession.transaction {
                putAuthority(storedAuthorityForTest(orphanNamespace))
                putSession(storedSessionForTest(orphanNamespace, session("session-a", "orphan")))
            }

            val uncommittedRows = FakeStateStore()
            val uncommittedNamespace = namespace(profileId = "profile-uncommitted")
            uncommittedRows.transaction {
                putAuthority(
                    storedAuthorityForTest(
                        uncommittedNamespace,
                        cursorEventSeq = null,
                        scopesRevision = null,
                        phase = RelayV2StoredSyncPhase.RESYNCING,
                    ),
                )
                putScope(storedScopeForTest(uncommittedNamespace))
                putSession(
                    storedSessionForTest(
                        uncommittedNamespace,
                        session("session-a", "uncommitted"),
                    ),
                )
            }

            val invalidRelease = FakeStateStore()
            val invalidReleaseNamespace = namespace(profileId = "profile-invalid-release")
            invalidRelease.transaction {
                putAuthority(
                    storedAuthorityForTest(
                        invalidReleaseNamespace,
                        phase = RelayV2StoredSyncPhase.RESYNCING,
                    ).copy(afterReleasePhase = RelayV2PostReleasePhase.RESTART_SNAPSHOT),
                )
            }

            val invalidCursor = FakeStateStore()
            val invalidCursorNamespace = namespace(profileId = "profile-invalid-cursor")
            invalidCursor.transaction {
                putAuthority(
                    storedAuthorityForTest(
                        invalidCursorNamespace,
                        cursorEventSeq = "not-a-counter",
                    ),
                )
            }

            val invalidScopesRevision = FakeStateStore()
            val invalidScopesNamespace = namespace(profileId = "profile-invalid-scopes")
            invalidScopesRevision.transaction {
                putAuthority(
                    storedAuthorityForTest(
                        invalidScopesNamespace,
                        scopesRevision = "not-a-counter",
                    ),
                )
            }

            val invalidSessionsRevision = FakeStateStore()
            val invalidSessionsNamespace = namespace(profileId = "profile-invalid-sessions")
            invalidSessionsRevision.transaction {
                putAuthority(storedAuthorityForTest(invalidSessionsNamespace))
                putScope(
                    storedScopeForTest(invalidSessionsNamespace).copy(
                        sessionsRevision = "not-a-counter",
                    ),
                )
            }

            listOf(
                Triple(noAuthority, noAuthorityNamespace, "scope without authority"),
                Triple(orphanSession, orphanNamespace, "session without scope"),
                Triple(uncommittedRows, uncommittedNamespace, "rows without committed cut"),
                Triple(invalidRelease, invalidReleaseNamespace, "invalid release journal"),
                Triple(invalidCursor, invalidCursorNamespace, "invalid cursor before scope miss"),
                Triple(
                    invalidScopesRevision,
                    invalidScopesNamespace,
                    "invalid scopes revision before scope miss",
                ),
                Triple(
                    invalidSessionsRevision,
                    invalidSessionsNamespace,
                    "invalid sessions revision before session miss",
                ),
            ).forEach { (store, namespace, contradiction) ->
                assertTrue(
                    contradiction,
                    runCatching {
                        RelayV2StateSyncRepositoryCore(store).readMaterializedSessionCut(
                            namespace,
                            "scope-a",
                            "session-a",
                        )
                    }.isFailure,
                )
            }
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
        val release = (committed as RelayV2StateSyncResult.SnapshotCommitted).release
        assertEquals(
            release,
            repository.completeSnapshotReleaseUnderApplyLease(release)?.release,
        )
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

    private fun snapshotChunk(
        namespace: RelayV2StateNamespace,
        through: String,
        snapshotSuffix: String,
        session: RelayV2SessionResource,
    ): RelayV2SnapshotChunk {
        val records = records(session)
        val (bytes, digest) = canonicalSnapshotDigest(records)
        return chunk(
            namespace = namespace,
            through = through,
            records = records,
            allRecordCount = records.size.toLong(),
            allCanonicalBytes = bytes,
            digest = digest,
            isLast = true,
            snapshotSuffix = snapshotSuffix,
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
        rawUtf8Bytes: Int = records.sumOf { it.canonicalJson().toByteArray().size } + 256,
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
        rawUtf8Bytes = rawUtf8Bytes,
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

    private suspend fun RelayV2StateSyncRepositoryCore.applyHelloForTest(
        hello: RelayV2StateHello,
    ): RelayV2StateSyncResult {
        val namespace = hello.namespace
        val plan = loadConnectPlan(
            RelayV2StateConnectIdentity(
                namespace.profileId,
                namespace.principalId,
                namespace.clientInstanceId,
                namespace.hostId,
            ),
        )
        return applyHelloUnderApplyLease(plan, hello)
    }

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

    private fun storedAuthorityForTest(
        namespace: RelayV2StateNamespace,
        cursorEventSeq: String? = "1",
        scopesRevision: String? = "1",
        phase: RelayV2StoredSyncPhase = RelayV2StoredSyncPhase.LIVE,
    ) = RelayV2StoredAuthority(
        namespace = namespace,
        cursorEventSeq = cursorEventSeq,
        requiredThroughEventSeq = "1",
        scopesRevision = scopesRevision,
        phase = phase,
        cacheRecordCount = 3,
        cacheCanonicalBytes = 3,
    )

    private fun storedScopeForTest(
        namespace: RelayV2StateNamespace,
        item: RelayV2ScopeResource = scope(),
        sessionsRevision: String = "1",
    ) = RelayV2StoredScope(
        namespace = namespace,
        item = item,
        sessionsRevision = sessionsRevision,
        scopeRecordCanonicalJson = RelayV2SnapshotRecord.Scope(item).canonicalJson(),
        sessionsScopeRecordCanonicalJson = RelayV2SnapshotRecord.SessionsScope(
            item.scopeId,
            sessionsRevision,
        ).canonicalJson(),
    )

    private fun storedSessionForTest(
        namespace: RelayV2StateNamespace,
        item: RelayV2SessionResource,
    ) = RelayV2StoredSession(
        namespace = namespace,
        item = item,
        recordCanonicalJson = RelayV2SnapshotRecord.Session(item.scopeId, item).canonicalJson(),
    )

    private fun assertOldState(store: FakeStateStore, namespace: RelayV2StateNamespace) {
        assertEquals("2", store.authority(namespace)?.cursorEventSeq)
        assertEquals("stable", store.session(namespace, "scope-a", "session-a")?.item?.displayName)
    }

    private fun assertResync(result: RelayV2StateSyncResult, reason: RelayV2ResyncReason) {
        assertEquals(reason, (result as RelayV2StateSyncResult.ResyncRequired).reason)
    }

    private fun assertBuffered(result: RelayV2StateSyncResult, eventSeq: String) {
        assertEquals(eventSeq, (result as RelayV2StateSyncResult.EventBuffered).eventSeq)
    }

    private suspend fun completePendingRelease(
        repository: RelayV2StateSyncRepositoryCore,
        result: RelayV2StateSyncResult,
    ) {
        val release = requireNotNull((result as RelayV2StateSyncResult.ResyncRequired).release)
        assertEquals(
            release,
            repository.completeSnapshotReleaseUnderApplyLease(release)?.release,
        )
    }

    private fun assertRotation(result: RelayV2StateSyncResult, reason: RelayV2RotationReason) {
        assertEquals(reason, (result as RelayV2StateSyncResult.RotationRequired).reason)
    }
}

internal class FakeStateStore(
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

    override fun authorities(identity: RelayV2StateConnectIdentity) =
        state.authorities.values.filter { authority ->
            authority.namespace.profileId == identity.profileId &&
                authority.namespace.principalId == identity.principalId &&
                authority.namespace.clientInstanceId == identity.clientInstanceId &&
                authority.namespace.hostId == identity.hostId
        }

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

    override fun scopes(namespace: RelayV2StateNamespace) = state.scopes
        .filterKeys { it.first == namespace }
        .values
        .sortedBy { it.item.scopeId }

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

    override fun sessions(namespace: RelayV2StateNamespace) = state.sessions
        .filterKeys { it.namespace == namespace }
        .values
        .sortedWith(compareBy({ it.item.scopeId }, { it.item.sessionId }))

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
