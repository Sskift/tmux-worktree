package com.tmuxworktree.mobile.core.relay.v2.state

import android.content.Context
import androidx.room.Room
import androidx.room.withTransaction
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RelayV2StateDatabaseInstrumentedTest {
    private lateinit var database: RelayV2StateDatabase
    private lateinit var dao: RelayV2StateDao

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        database = Room.inMemoryDatabaseBuilder(context, RelayV2StateDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        dao = database.stateDao()
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun completeNamespaceIdentityAllowsCoexistenceAndExactClear() = runBlocking {
        val first = namespace("principal-one", "client-one")
        val second = namespace("principal-two", "client-two")
        putAllSixCategories(first, "one")
        putAllSixCategories(second, "two")

        assertNamespacePresent(first, "one")
        assertNamespacePresent(second, "two")

        database.withTransaction { clearNamespace(first) }

        assertNamespaceAbsent(first)
        assertNamespacePresent(second, "two")
    }

    private fun putAllSixCategories(namespace: RelayV2StateNamespace, suffix: String) {
        dao.putAuthority(
            RelayV2AuthorityEntity(
                profileId = namespace.profileId,
                principalId = namespace.principalId,
                clientInstanceId = namespace.clientInstanceId,
                hostId = namespace.hostId,
                hostEpoch = namespace.hostEpoch,
                cursorEventSeq = null,
                requiredThroughEventSeq = "1",
                scopesRevision = null,
                phase = RelayV2StoredSyncPhase.RESYNCING.name,
                cacheRecordCount = 0,
                cacheCanonicalBytes = 2,
            ),
        )
        dao.putScope(
            RelayV2ScopeEntity(
                profileId = namespace.profileId,
                principalId = namespace.principalId,
                clientInstanceId = namespace.clientInstanceId,
                hostId = namespace.hostId,
                hostEpoch = namespace.hostEpoch,
                scopeId = SCOPE_ID,
                displayName = "scope-$suffix",
                kind = RelayV2ScopeKind.LOCAL.wireValue,
                reachability = RelayV2ScopeReachability.ONLINE.wireValue,
                sessionsRevision = "1",
                scopeRecordCanonicalJson = "{\"scope\":\"$suffix\"}",
                sessionsScopeRecordCanonicalJson = "{\"sessions\":\"$suffix\"}",
            ),
        )
        dao.putSession(
            RelayV2SessionEntity(
                profileId = namespace.profileId,
                principalId = namespace.principalId,
                clientInstanceId = namespace.clientInstanceId,
                hostId = namespace.hostId,
                hostEpoch = namespace.hostEpoch,
                scopeId = SCOPE_ID,
                sessionId = SESSION_ID,
                kind = RelayV2SessionKind.WORKTREE.wireValue,
                displayName = "session-$suffix",
                project = "project",
                label = null,
                cwd = "/repo/$suffix",
                attached = false,
                windowCount = 1,
                createdAtMs = 1,
                activityAtMs = 2,
                recordCanonicalJson = "{\"session\":\"$suffix\"}",
            ),
        )
        dao.putSnapshot(
            RelayV2SnapshotStagingEntity(
                profileId = namespace.profileId,
                principalId = namespace.principalId,
                clientInstanceId = namespace.clientInstanceId,
                hostId = namespace.hostId,
                hostEpoch = namespace.hostEpoch,
                snapshotRequestId = "request-$suffix",
                snapshotId = SNAPSHOT_ID,
                snapshotCreatedAtMs = 1,
                snapshotLeaseExpiresAtMs = 2,
                snapshotAbsoluteExpiresAtMs = 3,
                throughEventSeq = "1",
                scopesRevision = "1",
                totalRecords = 1,
                totalCanonicalBytes = 2,
                cutDigest = "digest-$suffix",
                nextChunkIndex = 0,
                nextCursor = null,
                receivedRecords = 0,
                receivedRecordCanonicalBytes = 0,
                receivedRawUtf8Bytes = 0,
                lastScopeId = null,
                lastRecordKind = null,
                lastSessionId = null,
                complete = false,
            ),
        )
        dao.putSnapshotRecords(
            listOf(
                RelayV2SnapshotRecordEntity(
                    profileId = namespace.profileId,
                    principalId = namespace.principalId,
                    clientInstanceId = namespace.clientInstanceId,
                    hostId = namespace.hostId,
                    hostEpoch = namespace.hostEpoch,
                    snapshotId = SNAPSHOT_ID,
                    recordIndex = 0,
                    chunkIndex = 0,
                    recordType = "scope",
                    scopeId = SCOPE_ID,
                    sessionId = null,
                    revision = null,
                    displayName = "scope-$suffix",
                    kind = RelayV2ScopeKind.LOCAL.wireValue,
                    reachability = RelayV2ScopeReachability.ONLINE.wireValue,
                    project = null,
                    label = null,
                    cwd = null,
                    attached = null,
                    windowCount = null,
                    createdAtMs = null,
                    activityAtMs = null,
                    canonicalJson = "{\"record\":\"$suffix\"}",
                ),
            ),
        )
        dao.putBufferedEvent(
            RelayV2StateEventEntity(
                profileId = namespace.profileId,
                principalId = namespace.principalId,
                clientInstanceId = namespace.clientInstanceId,
                hostId = namespace.hostId,
                hostEpoch = namespace.hostEpoch,
                eventSeq = EVENT_SEQ,
                eventSeqOrder = EVENT_SEQ.padStart(20, '0'),
                resultingRevision = "1",
                changeType = "scope_delete",
                scopeId = SCOPE_ID,
                sessionId = null,
                displayName = null,
                kind = null,
                reachability = null,
                project = null,
                label = null,
                cwd = null,
                attached = null,
                windowCount = null,
                createdAtMs = null,
                activityAtMs = null,
                rawUtf8Bytes = 128,
                canonicalJson = "{\"event\":\"$suffix\"}",
            ),
        )
    }

    private fun assertNamespacePresent(namespace: RelayV2StateNamespace, suffix: String) {
        assertEquals(namespace.principalId, authority(namespace)?.principalId)
        assertEquals("scope-$suffix", scope(namespace)?.displayName)
        assertEquals("session-$suffix", session(namespace)?.displayName)
        assertEquals("request-$suffix", snapshot(namespace)?.snapshotRequestId)
        assertEquals("{\"record\":\"$suffix\"}", snapshotRecords(namespace).single().canonicalJson)
        assertEquals("{\"event\":\"$suffix\"}", bufferedEvent(namespace)?.canonicalJson)
    }

    private fun assertNamespaceAbsent(namespace: RelayV2StateNamespace) {
        assertNull(authority(namespace))
        assertNull(scope(namespace))
        assertNull(session(namespace))
        assertNull(snapshot(namespace))
        assertEquals(emptyList<RelayV2SnapshotRecordEntity>(), snapshotRecords(namespace))
        assertNull(bufferedEvent(namespace))
    }

    private fun clearNamespace(namespace: RelayV2StateNamespace) {
        dao.deleteBufferedEvents(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        )
        dao.deleteSnapshotRecords(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        )
        dao.deleteSnapshot(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        )
        dao.deleteSessions(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        )
        dao.deleteScopes(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        )
        dao.deleteNamespaceAuthority(
            namespace.profileId,
            namespace.principalId,
            namespace.clientInstanceId,
            namespace.hostId,
            namespace.hostEpoch,
        )
    }

    private fun authority(namespace: RelayV2StateNamespace) = dao.authority(
        namespace.profileId,
        namespace.principalId,
        namespace.clientInstanceId,
        namespace.hostId,
        namespace.hostEpoch,
    )

    private fun scope(namespace: RelayV2StateNamespace) = dao.scope(
        namespace.profileId,
        namespace.principalId,
        namespace.clientInstanceId,
        namespace.hostId,
        namespace.hostEpoch,
        SCOPE_ID,
    )

    private fun session(namespace: RelayV2StateNamespace) = dao.session(
        namespace.profileId,
        namespace.principalId,
        namespace.clientInstanceId,
        namespace.hostId,
        namespace.hostEpoch,
        SCOPE_ID,
        SESSION_ID,
    )

    private fun snapshot(namespace: RelayV2StateNamespace) = dao.snapshot(
        namespace.profileId,
        namespace.principalId,
        namespace.clientInstanceId,
        namespace.hostId,
        namespace.hostEpoch,
    )

    private fun snapshotRecords(namespace: RelayV2StateNamespace) = dao.snapshotRecordPage(
        namespace.profileId,
        namespace.principalId,
        namespace.clientInstanceId,
        namespace.hostId,
        namespace.hostEpoch,
        SNAPSHOT_ID,
        16,
        0,
    )

    private fun bufferedEvent(namespace: RelayV2StateNamespace) = dao.bufferedEvent(
        namespace.profileId,
        namespace.principalId,
        namespace.clientInstanceId,
        namespace.hostId,
        namespace.hostEpoch,
        EVENT_SEQ,
    )

    private fun namespace(principalId: String, clientInstanceId: String) = RelayV2StateNamespace(
        profileId = "profile",
        principalId = principalId,
        clientInstanceId = clientInstanceId,
        hostId = "host",
        hostEpoch = "epoch",
    )

    private companion object {
        const val SCOPE_ID = "scope"
        const val SESSION_ID = "session"
        const val SNAPSHOT_ID = "snapshot"
        const val EVENT_SEQ = "1"
    }
}
