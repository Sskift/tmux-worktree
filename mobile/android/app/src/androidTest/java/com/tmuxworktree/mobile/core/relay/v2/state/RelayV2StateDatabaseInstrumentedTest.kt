package com.tmuxworktree.mobile.core.relay.v2.state

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDialect
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
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
        val base = namespace("principal-base", "client-base")
        val principalOnly = namespace("principal-other", "client-base")
        val clientOnly = namespace("principal-base", "client-other")
        putAllSixCategories(base, "base")
        putAllSixCategories(principalOnly, "principal")
        putAllSixCategories(clientOnly, "client")

        assertNamespacePresent(base, "base")
        assertNamespacePresent(principalOnly, "principal")
        assertNamespacePresent(clientOnly, "client")

        val result = RelayV2StateRepository(database).applyHelloUnderApplyLease(
            RelayV2StateHello(
                namespace = base,
                welcomeEventSeq = FRESH_REQUIRED_EVENT_SEQ,
                resume = null,
                disposition = RelayV2StateHelloDisposition.FRESH,
            ),
        )

        assertEquals(
            RelayV2StateSyncResult.ResyncRequired(
                namespace = base,
                reason = RelayV2ResyncReason.FRESH,
                release = RelayV2SnapshotReleaseObligation(
                    namespace = base,
                    snapshotRequestId = "request-base",
                    snapshotId = SNAPSHOT_ID,
                    durableCursorEventSeq = null,
                    reason = RelayV2SnapshotReleaseReason.FRESH,
                    phase = RelayV2PostReleasePhase.RESTART_SNAPSHOT,
                ),
            ),
            result,
        )
        assertNamespaceFreshReset(base)
        assertNamespacePresent(principalOnly, "principal")
        assertNamespacePresent(clientOnly, "client")
    }

    @Test
    fun disconnectReceiptClearsEveryActivationAndLeavesAnotherProfile() = runBlocking {
        val stateNamespace = namespace("principal-base", "client-base")
        putAllSixCategories(stateNamespace, "clear")
        val first = durableNamespace("profile", activation = 1)
        val second = durableNamespace("profile", activation = 2)
        val retained = durableNamespace("other-profile", activation = 1)
        listOf(first, second, retained).forEach(::putDurableAuthorities)
        listOf(first, second, retained).forEach(::assertDurablePayloadByteCounts)

        RelayV2StateRepository(database).clearProfileAfterDisconnect(
            RelayProfileDisconnectReceipt(
                RelayActiveProfileIdentity("profile", RelayProfileDialect.V2, 2),
                "disconnect-profile-2",
            ),
        )

        assertNull(authority(stateNamespace))
        assertNull(scope(stateNamespace))
        assertNull(session(stateNamespace))
        assertNull(snapshot(stateNamespace))
        assertEquals(emptyList<RelayV2SnapshotRecordEntity>(), snapshotRecords(stateNamespace))
        assertNull(bufferedEvent(stateNamespace))
        listOf(first, second).forEach { cleared ->
            assertNull(outboxMeta(cleared))
            assertEquals(emptyList<RelayV2OutboxEntryEntity>(), outboxEntries(cleared))
            assertNull(terminalCheckpoint(cleared))
        }
        assertEquals(1L, outboxMeta(retained)?.nextCreationOrder)
        assertEquals(1, outboxEntries(retained).size)
        assertEquals(
            RelayV2TerminalCheckpointKind.PRE_OPEN.name,
            terminalCheckpoint(retained)?.checkpointKind,
        )
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

    private fun putDurableAuthorities(namespace: RelayV2OutboxAuthorityNamespace) {
        fun payload(kind: String) = RelayV2StorageJson.encode(
            codecVersion = 1,
            value = linkedMapOf(
                "fixtureKind" to kind,
                "activation" to namespace.profileActivationGeneration.toString(),
            ),
        )
        val metaPayload = payload("outbox-meta")
        dao.putOutboxMeta(
            RelayV2OutboxMetaEntity(
                profileId = namespace.profileId,
                profileActivationGeneration = namespace.profileActivationGeneration,
                principalId = namespace.principalId,
                clientInstanceId = namespace.clientInstanceId,
                nextCreationOrder = 1,
                codecVersion = metaPayload.codecVersion,
                payloadUtf8Bytes = metaPayload.payloadUtf8Bytes,
                payloadCanonicalJson = metaPayload.canonicalJson,
                payloadSha256 = metaPayload.sha256,
            ),
        )
        val entryPayload = payload("outbox-entry")
        dao.insertOutboxEntry(
            RelayV2OutboxEntryEntity(
                profileId = namespace.profileId,
                profileActivationGeneration = namespace.profileActivationGeneration,
                principalId = namespace.principalId,
                clientInstanceId = namespace.clientInstanceId,
                hostId = "host",
                expectedHostEpoch = "epoch",
                commandId = "command-${namespace.profileActivationGeneration}",
                createdOrder = 0,
                codecVersion = entryPayload.codecVersion,
                payloadUtf8Bytes = entryPayload.payloadUtf8Bytes,
                payloadCanonicalJson = entryPayload.canonicalJson,
                payloadSha256 = entryPayload.sha256,
            ),
        )
        val terminalPayload = payload("terminal-checkpoint")
        dao.putTerminalCheckpoint(
            RelayV2TerminalCheckpointEntity(
                profileId = namespace.profileId,
                profileActivationGeneration = namespace.profileActivationGeneration,
                principalId = namespace.principalId,
                clientInstanceId = namespace.clientInstanceId,
                hostId = "host",
                hostEpoch = "epoch",
                scopeId = SCOPE_ID,
                sessionId = SESSION_ID,
                streamId = "stream-${namespace.profileActivationGeneration}",
                pane = 0,
                checkpointKind = RelayV2TerminalCheckpointKind.PRE_OPEN.name,
                codecVersion = terminalPayload.codecVersion,
                payloadUtf8Bytes = terminalPayload.payloadUtf8Bytes,
                payloadCanonicalJson = terminalPayload.canonicalJson,
                payloadSha256 = terminalPayload.sha256,
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

    private fun assertDurablePayloadByteCounts(namespace: RelayV2OutboxAuthorityNamespace) {
        val meta = requireNotNull(outboxMeta(namespace))
        assertEquals(
            meta.payloadCanonicalJson.toByteArray(Charsets.UTF_8).size,
            meta.payloadUtf8Bytes,
        )
        val entry = outboxEntries(namespace).single()
        assertEquals(
            entry.payloadCanonicalJson.toByteArray(Charsets.UTF_8).size,
            entry.payloadUtf8Bytes,
        )
        val terminal = requireNotNull(terminalCheckpoint(namespace))
        assertEquals(
            terminal.payloadCanonicalJson.toByteArray(Charsets.UTF_8).size,
            terminal.payloadUtf8Bytes,
        )
    }

    private fun assertNamespaceFreshReset(namespace: RelayV2StateNamespace) {
        assertEquals(
            RelayV2AuthorityEntity(
                profileId = namespace.profileId,
                principalId = namespace.principalId,
                clientInstanceId = namespace.clientInstanceId,
                hostId = namespace.hostId,
                hostEpoch = namespace.hostEpoch,
                cursorEventSeq = null,
                requiredThroughEventSeq = FRESH_REQUIRED_EVENT_SEQ,
                scopesRevision = null,
                phase = RelayV2StoredSyncPhase.RESYNCING.name,
                cacheRecordCount = 0,
                cacheCanonicalBytes = 2,
            ),
            authority(namespace),
        )
        assertNull(scope(namespace))
        assertNull(session(namespace))
        assertNull(snapshot(namespace))
        assertEquals(emptyList<RelayV2SnapshotRecordEntity>(), snapshotRecords(namespace))
        assertNull(bufferedEvent(namespace))
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

    private fun durableNamespace(
        profileId: String,
        activation: Long,
    ) = RelayV2OutboxAuthorityNamespace(
        profileId,
        activation,
        "principal-base",
        "client-base",
    )

    private fun outboxMeta(namespace: RelayV2OutboxAuthorityNamespace) = dao.outboxMeta(
        namespace.profileId,
        namespace.profileActivationGeneration,
        namespace.principalId,
        namespace.clientInstanceId,
    )

    private fun outboxEntries(namespace: RelayV2OutboxAuthorityNamespace) = dao.outboxEntries(
        namespace.profileId,
        namespace.profileActivationGeneration,
        namespace.principalId,
        namespace.clientInstanceId,
    )

    private fun terminalCheckpoint(namespace: RelayV2OutboxAuthorityNamespace) =
        dao.terminalCheckpoint(
            namespace.profileId,
            namespace.profileActivationGeneration,
            namespace.principalId,
            namespace.clientInstanceId,
            "host",
            "epoch",
            SCOPE_ID,
            SESSION_ID,
            "stream-${namespace.profileActivationGeneration}",
            0,
        )

    private companion object {
        const val SCOPE_ID = "scope"
        const val SESSION_ID = "session"
        const val SNAPSHOT_ID = "snapshot"
        const val EVENT_SEQ = "1"
        const val FRESH_REQUIRED_EVENT_SEQ = "7"
    }
}
