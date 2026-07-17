package com.tmuxworktree.mobile.core.relay.v2.state

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.*
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDialect
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
import java.security.MessageDigest
import java.util.Base64
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

        val repository = RelayV2StateRepository(database)
        val connectPlan = repository.loadConnectPlan(
            RelayV2StateConnectIdentity(
                base.profileId,
                base.principalId,
                base.clientInstanceId,
                base.hostId,
            ),
        )
        val result = repository.applyHelloUnderApplyLease(
            connectPlan,
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
                reason = RelayV2ResyncReason.SNAPSHOT_RESTART_REQUIRED,
                release = RelayV2SnapshotReleaseObligation(
                    namespace = base,
                    snapshotRequestId = "request-base",
                    snapshotId = SNAPSHOT_ID,
                    durableCursorEventSeq = null,
                    reason = RelayV2SnapshotReleaseReason.SNAPSHOT_RESTART_REQUIRED,
                ),
                afterReleasePhase = RelayV2PostReleasePhase.RESTART_SNAPSHOT,
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
        listOf(first, second, retained).forEach { putAgentConsumer(it) }
        listOf(first, second, retained).forEach(::assertDurablePayloadByteCounts)
        listOf(first, second, retained).forEach { assertEquals(1, agentRows(it).size) }
        listOf(first, second, retained).forEach { assertTrue(agentClaim(it) != null) }

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
            assertEquals(emptyList<RelayV2AgentTranscriptLifecycleStateEntity>(), agentRows(cleared))
            assertNull(agentClaim(cleared))
        }
        assertEquals(1L, outboxMeta(retained)?.nextCreationOrder)
        assertEquals(1, outboxEntries(retained).size)
        assertEquals(
            RelayV2TerminalCheckpointKind.PRE_OPEN.name,
            terminalCheckpoint(retained)?.checkpointKind,
        )
        assertEquals(1, agentRows(retained).size)
        assertTrue(agentClaim(retained) != null)
    }

    @Test
    fun notificationClaimInsertAbortNeverOverwritesCommittedEvidence() = runBlocking {
        val namespace = durableNamespace("profile", activation = 1)
        putAgentConsumer(namespace)
        val committed = requireNotNull(agentClaim(namespace))

        val failure = runCatching {
            dao.insertAgentTranscriptLifecycleNotificationClaim(
                committed.copy(
                    claimedLocalGeneration = "2",
                    payloadSha256 = "0".repeat(64),
                ),
            )
        }.exceptionOrNull()

        assertTrue(failure != null)
        assertEquals(committed, agentClaim(namespace))
    }

    private fun putAllSixCategories(namespace: RelayV2StateNamespace, suffix: String) {
        val scopeRecord = partialSnapshotScopeRecord(suffix)
        val scopeCanonical = scopeRecord.canonicalJson()
        val (totalCanonicalBytes, cutDigest) = canonicalSnapshotDigest(
            listOf(
                scopeRecord,
                RelayV2SnapshotRecord.SessionsScope(SCOPE_ID, "1"),
            ),
        )
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
                totalRecords = 2,
                totalCanonicalBytes = totalCanonicalBytes,
                cutDigest = cutDigest,
                nextChunkIndex = 1,
                nextCursor = "cursor-$suffix",
                receivedRecords = 1,
                receivedRecordCanonicalBytes = scopeCanonical.toByteArray(Charsets.UTF_8)
                    .size.toLong(),
                receivedRawUtf8Bytes = scopeCanonical.toByteArray(Charsets.UTF_8).size + 256L,
                lastScopeId = SCOPE_ID,
                lastRecordKind = "scope",
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
                    canonicalJson = scopeCanonical,
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

    private suspend fun putAgentConsumer(namespace: RelayV2OutboxAuthorityNamespace) {
        val fixture = agentClaimFixture(namespace)
        val repository = AgentTranscriptLifecycleDurableRepository(database)
        repository.initializeUnderApplyLease(
            fixture.namespace,
            fixture.state,
        )
        assertTrue(
            repository.claimNotificationUnderApplyLease(
                fixture.namespace,
                fixture.intent,
            ) is AgentTranscriptLifecycleNotificationClaimResult.Claimed,
        )
    }

    private fun assertNamespacePresent(namespace: RelayV2StateNamespace, suffix: String) {
        assertEquals(namespace.principalId, authority(namespace)?.principalId)
        assertEquals("scope-$suffix", scope(namespace)?.displayName)
        assertEquals("session-$suffix", session(namespace)?.displayName)
        assertEquals("request-$suffix", snapshot(namespace)?.snapshotRequestId)
        assertEquals(
            partialSnapshotScopeRecord(suffix).canonicalJson(),
            snapshotRecords(namespace).single().canonicalJson,
        )
        assertEquals("{\"event\":\"$suffix\"}", bufferedEvent(namespace)?.canonicalJson)
    }

    private fun partialSnapshotScopeRecord(suffix: String) = RelayV2SnapshotRecord.Scope(
        RelayV2ScopeResource(
            scopeId = SCOPE_ID,
            displayName = "scope-$suffix",
            kind = RelayV2ScopeKind.LOCAL,
            reachability = RelayV2ScopeReachability.ONLINE,
        ),
    )

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
                pendingReleaseSnapshotRequestId = "request-base",
                pendingReleaseSnapshotId = SNAPSHOT_ID,
                pendingReleaseCursorEventSeq = null,
                pendingReleaseReason = RelayV2SnapshotReleaseReason
                    .SNAPSHOT_RESTART_REQUIRED.name,
                pendingReleasePhase = RelayV2PostReleasePhase.RESTART_SNAPSHOT.name,
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

    private fun agentRows(namespace: RelayV2OutboxAuthorityNamespace) = agentConsumer(namespace).let {
        dao.agentTranscriptLifecycleStates(
            it.profileId,
            it.profileActivationGeneration,
            it.principalId,
            it.clientInstanceId,
            it.hostId,
            it.hostEpoch,
            it.scopeId,
            it.sessionId,
        )
    }

    private fun agentClaim(namespace: RelayV2OutboxAuthorityNamespace):
        RelayV2AgentTranscriptLifecycleNotificationClaimEntity? {
        val fixture = agentClaimFixture(namespace)
        val key = fixture.intent.dedupeKey
        val consumer = fixture.namespace.consumer
        return dao.agentTranscriptLifecycleNotificationClaim(
            consumer.profileId,
            consumer.profileActivationGeneration,
            consumer.principalId,
            consumer.clientInstanceId,
            consumer.hostId,
            consumer.hostEpoch,
            consumer.scopeId,
            consumer.sessionId,
            key.timelineEpoch,
            key.lifecycleEventId,
            key.state.name,
        )
    }

    private fun agentClaimFixture(namespace: RelayV2OutboxAuthorityNamespace): AgentClaimFixture {
        val consumer = agentConsumer(namespace)
        val lifecycleIdentity = AgentLifecycleIdentity(
            AgentLifecycleScope.TURN,
            "run-${namespace.profileActivationGeneration}",
            "turn-${namespace.profileActivationGeneration}",
        )
        val record = AgentLifecycleRecord(
            "event-${namespace.profileActivationGeneration}",
            "source",
            lifecycleIdentity,
            AgentLifecycleState.WAITING_FOR_USER,
            "1",
        )
        val closedDigest = digest("claim-${namespace.profileId}-${namespace.profileActivationGeneration}")
        val witness = AgentLifecycleEventIdentityWitness(
            record.lifecycleEventId,
            record.agentEventSeq,
            lifecycleIdentity,
            record.sourceEpoch,
            record.state,
            closedDigest,
        )
        val dedupeKey = AgentNotificationDedupeKey(
            consumer.profileId,
            consumer.hostId,
            consumer.hostEpoch,
            consumer.scopeId,
            consumer.sessionId,
            "timeline",
            record.lifecycleEventId,
            record.state,
        )
        val state = AgentTranscriptLifecycleClientState(
            identity = consumer.sessionIdentity,
            extensionLane = AgentTranscriptLifecycleExtensionState(
                localGeneration = "1",
                support = AgentExtensionSupport.AVAILABLE,
                unavailableReason = null,
                liveSource = AgentLiveSourceState.CONNECTED,
                activeSourceEpoch = record.sourceEpoch,
                timelineEpoch = dedupeKey.timelineEpoch,
                lastAgentSeq = "1",
                notificationBaselineAgentSeq = "0",
                lifecycleByIdentity = mapOf(lifecycleIdentity to record),
                currentLifecycleIdentityByEventId = mapOf(
                    record.lifecycleEventId to lifecycleIdentity,
                ),
                runsWithTurnRecords = setOf(lifecycleIdentity.runId),
                appliedEventsBySeq = mapOf(
                    "1" to AgentAppliedEventEvidence(record.lifecycleEventId, closedDigest),
                ),
                eventWitnessById = mapOf(record.lifecycleEventId to witness),
                eventIdBySeq = mapOf("1" to record.lifecycleEventId),
                notificationLedger = mapOf(
                    dedupeKey to AgentNotificationLedgerEntry(
                        AgentNotificationDisposition.SHOWN,
                        witness,
                        "1",
                    ),
                ),
                notificationKeyByLifecycleEventId = mapOf(
                    record.lifecycleEventId to dedupeKey,
                ),
            ),
            notificationConfig = AgentNotificationConfig(
                permission = AgentNotificationPermission.GRANTED,
                profileActive = true,
                policy = AgentNotificationPolicy.ALLOW,
            ),
        )
        return AgentClaimFixture(
            AgentTranscriptLifecycleDurableNamespace.from(consumer, state),
            state,
            AgentSystemNotificationIntent(dedupeKey, "1"),
        )
    }

    private fun agentConsumer(
        namespace: RelayV2OutboxAuthorityNamespace,
    ) = AgentTranscriptLifecycleDurableConsumerIdentity(
        namespace.profileId,
        namespace.profileActivationGeneration,
        namespace.principalId,
        namespace.clientInstanceId,
        "host",
        "epoch",
        SCOPE_ID,
        SESSION_ID,
    )

    private fun digest(value: String): AgentClosedEventDigest = AgentClosedEventDigest(
        Base64.getUrlEncoder().withoutPadding().encodeToString(
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)),
        ),
    )

    private data class AgentClaimFixture(
        val namespace: AgentTranscriptLifecycleDurableNamespace,
        val state: AgentTranscriptLifecycleClientState,
        val intent: AgentSystemNotificationIntent,
    )

    private companion object {
        const val SCOPE_ID = "scope"
        const val SESSION_ID = "session"
        const val SNAPSHOT_ID = "snapshot"
        const val EVENT_SEQ = "1"
        const val FRESH_REQUIRED_EVENT_SEQ = "7"
    }
}
