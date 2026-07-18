package com.tmuxworktree.mobile.core.relay.v2.state

import android.content.Context
import androidx.room.Room
import androidx.room.withTransaction
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
    private lateinit var lifecycleDao: RelayV2AgentLifecycleDao

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        database = Room.inMemoryDatabaseBuilder(context, RelayV2StateDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        dao = database.stateDao()
        lifecycleDao = database.agentLifecycleDao()
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
        listOf(first, second, retained).forEach(::putAgentTranscriptStorage)
        listOf(first, second, retained).forEach(::assertDurablePayloadByteCounts)
        listOf(first, second, retained).forEach { assertEquals(1, agentRows(it).size) }
        listOf(first, second, retained).forEach { assertTrue(agentClaim(it) != null) }
        listOf(first, second, retained).forEach { assertAgentTranscriptStorageCount(it, 1) }

        val committedPending = agentTranscriptPendingEvents(retained).single()
        val insertedBeforeConflict = pendingEvent(
            retained,
            agentEventSeq = "7",
            eventId = "live-event-new",
            canonicalJson = "{\"live\":\"new-before-conflict\"}",
        )
        val conflicting = pendingEvent(
            retained,
            agentEventSeq = "8",
            eventId = committedPending.eventId,
            canonicalJson = "{\"live\":\"different-conflict\"}",
        )
        val conflictFailure = runCatching {
            database.withTransaction {
                dao.insertAgentTranscriptPendingEvent(insertedBeforeConflict)
                dao.insertAgentTranscriptPendingEvent(conflicting)
            }
        }.exceptionOrNull()

        assertTrue(conflictFailure != null)
        assertEquals(listOf(committedPending), agentTranscriptPendingEvents(retained))

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
            assertAgentTranscriptStorageCount(cleared, 0)
        }
        assertEquals(1L, outboxMeta(retained)?.nextCreationOrder)
        assertEquals(1, outboxEntries(retained).size)
        assertEquals(
            RelayV2TerminalCheckpointKind.PRE_OPEN.name,
            terminalCheckpoint(retained)?.checkpointKind,
        )
        assertEquals(1, agentRows(retained).size)
        assertTrue(agentClaim(retained) != null)
        assertAgentTranscriptStorageCount(retained, 1)
        assertEquals(listOf(committedPending), agentTranscriptPendingEvents(retained))
    }

    @Test
    fun notificationClaimInsertAbortNeverOverwritesCommittedEvidence() = runBlocking {
        val namespace = durableNamespace("profile", activation = 1)
        putAgentConsumer(namespace)
        val committed = requireNotNull(agentClaim(namespace))
        val conflicts = listOf(
            committed.copy(
                claimedLocalGeneration = "2",
                payloadSha256 = "0".repeat(64),
            ),
            committed.copy(
                lifecycleState = AgentLifecycleState.COMPLETED.name,
                claimedLocalGeneration = "2",
                payloadSha256 = "f".repeat(64),
            ),
        )

        conflicts.forEach { conflict ->
            val failure = runCatching {
                dao.insertAgentTranscriptLifecycleNotificationClaim(conflict)
            }.exceptionOrNull()

            assertTrue(failure != null)
            assertEquals(committed, agentClaim(namespace))
        }
    }

    @Test
    fun rowOrientedAgentPointersUseExactCasAndPreserveWitnessesOnParentAdvance() {
        val rows = agentLifecycleRows(durableNamespace("profile", activation = 1))
        dao.insertAgentTranscriptLifecycleState(rows.parent)
        lifecycleDao.insertWitnesses(listOf(rows.waiting, rows.completed))

        assertTrue(
            runCatching {
                lifecycleDao.insertCurrent(listOf(rows.current.copy(runId = "wrong-run")))
            }.exceptionOrNull() != null,
        )
        lifecycleDao.insertCurrent(listOf(rows.current))
        assertEquals(0, updateCurrent(rows, expectedAgentEventSeq = "wrong-sequence"))
        assertEquals(1, updateCurrent(rows, expectedAgentEventSeq = rows.waiting.agentEventSeq))

        lifecycleDao.insertRecentEvidence(listOf(rows.recent))
        assertEquals(0, deleteRecentEvidence(rows.recent, expectedSha256 = "wrong-hash"))

        assertTrue(
            runCatching {
                lifecycleDao.insertNotifications(
                    listOf(rows.notification.copy(lifecycleState = "COMPLETED")),
                )
            }.exceptionOrNull() != null,
        )
        lifecycleDao.insertNotifications(listOf(rows.notification))
        assertAgentLifecycleFamilyCounts(current = 1, witness = 2, recent = 1, notification = 1)

        assertEquals(0, updateConsumerAuthority(rows, expectedSha256 = "wrong-hash"))
        assertEquals(1, updateConsumerAuthority(rows, expectedSha256 = rows.parent.payloadSha256))
        assertAgentLifecycleFamilyCounts(current = 1, witness = 2, recent = 1, notification = 1)

        assertEquals(1, rotateConsumerAuthority(rows.parent))
        assertAgentLifecycleFamilyCounts(current = 0, witness = 0, recent = 0, notification = 0)
    }

    @Test
    fun unknownNotificationClaimLifecycleStateFailsClosedWithoutOverwrite() = runBlocking {
        val namespace = durableNamespace("profile", activation = 1)
        putAgentConsumer(namespace)
        val committed = requireNotNull(agentClaim(namespace))
        val unknownState = "UNKNOWN_PERSISTED_LIFECYCLE_STATE"
        dao.deleteProfileAgentTranscriptLifecycleNotificationClaims(namespace.profileId)
        dao.insertAgentTranscriptLifecycleNotificationClaim(
            committed.copy(lifecycleState = unknownState),
        )
        val fixture = agentClaimFixture(namespace)
        val repository = AgentTranscriptLifecycleDurableRepository(database)

        val failure = runCatching {
            repository.claimNotificationUnderApplyLease(
                fixture.namespace,
                fixture.intent,
            )
        }.exceptionOrNull()

        assertTrue(failure is RelayV2StorageException)
        assertEquals(
            RelayV2StorageFailure.SCHEMA_INCOMPATIBLE,
            (failure as RelayV2StorageException).failure,
        )
        assertTrue(unknownState !in failure.toString())
        assertEquals(listOf(unknownState), agentClaims(namespace).map { it.lifecycleState })
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

    private fun agentLifecycleRows(
        namespace: RelayV2OutboxAuthorityNamespace,
    ): AgentLifecycleRowFixture {
        val consumer = agentConsumer(namespace)
        fun payload(kind: String) = RelayV2StorageJson.encode(1, linkedMapOf("kind" to kind))
        val parentPayload = payload("parent-old")
        val parent = RelayV2AgentTranscriptLifecycleStateEntity(
            profileId = consumer.profileId,
            profileActivationGeneration = consumer.profileActivationGeneration,
            principalId = consumer.principalId,
            clientInstanceId = consumer.clientInstanceId,
            hostId = consumer.hostId,
            hostEpoch = consumer.hostEpoch,
            scopeId = consumer.scopeId,
            sessionId = consumer.sessionId,
            timelineEpochKey = AGENT_TIMELINE_EPOCH,
            codecVersion = parentPayload.codecVersion,
            payloadUtf8Bytes = parentPayload.payloadUtf8Bytes,
            payloadCanonicalJson = parentPayload.canonicalJson,
            payloadSha256 = parentPayload.sha256,
        )
        fun witness(eventId: String, agentEventSeq: String, lifecycleState: String):
            RelayV2AgentLifecycleEventWitnessEntity {
            val witnessPayload = payload("witness-$eventId")
            return RelayV2AgentLifecycleEventWitnessEntity(
                profileId = consumer.profileId,
                profileActivationGeneration = consumer.profileActivationGeneration,
                principalId = consumer.principalId,
                clientInstanceId = consumer.clientInstanceId,
                hostId = consumer.hostId,
                hostEpoch = consumer.hostEpoch,
                scopeId = consumer.scopeId,
                sessionId = consumer.sessionId,
                timelineEpoch = AGENT_TIMELINE_EPOCH,
                eventId = eventId,
                agentEventSeq = agentEventSeq,
                agentEventSeqOrder = orderKey(agentEventSeq),
                lifecycleScope = "TURN",
                runId = "run",
                turnIdKey = "turn",
                sourceEpoch = "source",
                lifecycleState = lifecycleState,
                failureCode = null,
                failureSummary = null,
                occurredAtMs = agentEventSeq.toLong(),
                closedEventDigest = digest("closed-$eventId").value,
                witnessCanonicalJson = witnessPayload.canonicalJson,
                witnessCanonicalUtf8Bytes = witnessPayload.payloadUtf8Bytes,
                witnessSha256 = witnessPayload.sha256,
            )
        }
        val waiting = witness("turn-waiting", "1", "WAITING_FOR_USER")
        val completed = witness("turn-completed", "2", "COMPLETED")
        val recentPayload = payload("recent")
        val ledgerPayload = payload("ledger")
        return AgentLifecycleRowFixture(
            parent = parent,
            nextParentPayload = payload("parent-new"),
            waiting = waiting,
            completed = completed,
            current = RelayV2AgentLifecycleCurrentEntity(
                profileId = waiting.profileId,
                profileActivationGeneration = waiting.profileActivationGeneration,
                principalId = waiting.principalId,
                clientInstanceId = waiting.clientInstanceId,
                hostId = waiting.hostId,
                hostEpoch = waiting.hostEpoch,
                scopeId = waiting.scopeId,
                sessionId = waiting.sessionId,
                timelineEpoch = waiting.timelineEpoch,
                lifecycleScope = waiting.lifecycleScope,
                runId = waiting.runId,
                turnIdKey = waiting.turnIdKey,
                lifecycleEventId = waiting.eventId,
                agentEventSeq = waiting.agentEventSeq,
                agentEventSeqOrder = waiting.agentEventSeqOrder,
            ),
            recent = RelayV2AgentRecentEventEvidenceEntity(
                profileId = waiting.profileId,
                profileActivationGeneration = waiting.profileActivationGeneration,
                principalId = waiting.principalId,
                clientInstanceId = waiting.clientInstanceId,
                hostId = waiting.hostId,
                hostEpoch = waiting.hostEpoch,
                scopeId = waiting.scopeId,
                sessionId = waiting.sessionId,
                timelineEpoch = waiting.timelineEpoch,
                agentEventSeq = "3",
                agentEventSeqOrder = orderKey("3"),
                eventId = "non-lifecycle",
                closedEventDigest = digest("non-lifecycle").value,
                evidenceCanonicalJson = recentPayload.canonicalJson,
                evidenceCanonicalUtf8Bytes = recentPayload.payloadUtf8Bytes,
                evidenceSha256 = recentPayload.sha256,
            ),
            notification = RelayV2AgentNotificationLedgerEntity(
                profileId = waiting.profileId,
                profileActivationGeneration = waiting.profileActivationGeneration,
                principalId = waiting.principalId,
                clientInstanceId = waiting.clientInstanceId,
                hostId = waiting.hostId,
                hostEpoch = waiting.hostEpoch,
                scopeId = waiting.scopeId,
                sessionId = waiting.sessionId,
                timelineEpoch = waiting.timelineEpoch,
                lifecycleEventId = waiting.eventId,
                lifecycleState = waiting.lifecycleState,
                agentEventSeq = waiting.agentEventSeq,
                agentEventSeqOrder = waiting.agentEventSeqOrder,
                disposition = "SHOWN",
                localGeneration = "1",
                ledgerCanonicalJson = ledgerPayload.canonicalJson,
                ledgerCanonicalUtf8Bytes = ledgerPayload.payloadUtf8Bytes,
                ledgerSha256 = ledgerPayload.sha256,
            ),
        )
    }

    private fun updateCurrent(
        rows: AgentLifecycleRowFixture,
        expectedAgentEventSeq: String,
    ): Int = rows.current.let { current ->
        lifecycleDao.updateCurrentExact(
            current.profileId, current.profileActivationGeneration, current.principalId,
            current.clientInstanceId, current.hostId, current.hostEpoch, current.scopeId,
            current.sessionId, current.timelineEpoch, current.lifecycleScope, current.runId,
            current.turnIdKey, current.lifecycleEventId, expectedAgentEventSeq,
            current.agentEventSeqOrder, rows.completed.eventId, rows.completed.agentEventSeq,
            rows.completed.agentEventSeqOrder,
        )
    }

    private fun deleteRecentEvidence(
        evidence: RelayV2AgentRecentEventEvidenceEntity,
        expectedSha256: String,
    ): Int = lifecycleDao.deleteRecentEvidenceExact(
        evidence.profileId, evidence.profileActivationGeneration, evidence.principalId,
        evidence.clientInstanceId, evidence.hostId, evidence.hostEpoch, evidence.scopeId,
        evidence.sessionId, evidence.timelineEpoch, evidence.agentEventSeq,
        evidence.agentEventSeqOrder, evidence.eventId, evidence.closedEventDigest,
        evidence.evidenceCanonicalJson, evidence.evidenceCanonicalUtf8Bytes, expectedSha256,
    )

    private fun updateConsumerAuthority(
        rows: AgentLifecycleRowFixture,
        expectedSha256: String,
    ): Int = rows.parent.let { parent ->
        lifecycleDao.updateConsumerAuthorityExact(
            parent.profileId, parent.profileActivationGeneration, parent.principalId,
            parent.clientInstanceId, parent.hostId, parent.hostEpoch, parent.scopeId,
            parent.sessionId, parent.timelineEpochKey, parent.codecVersion,
            parent.payloadUtf8Bytes, parent.payloadCanonicalJson, expectedSha256,
            rows.nextParentPayload.codecVersion, rows.nextParentPayload.payloadUtf8Bytes,
            rows.nextParentPayload.canonicalJson, rows.nextParentPayload.sha256,
        )
    }

    private fun rotateConsumerAuthority(
        parent: RelayV2AgentTranscriptLifecycleStateEntity,
    ): Int = lifecycleDao.deleteConsumerAuthorityForTimelineRotation(
        parent.profileId, parent.profileActivationGeneration, parent.principalId,
        parent.clientInstanceId, parent.hostId, parent.hostEpoch, parent.scopeId,
        parent.sessionId, parent.timelineEpochKey,
    )

    private fun assertAgentLifecycleFamilyCounts(
        current: Int,
        witness: Int,
        recent: Int,
        notification: Int,
    ) {
        val currentStats = lifecycleDao.currentGlobalStats()
        assertEquals(current.toLong(), currentStats.itemCount)
        assertEquals(0L, currentStats.byteCount)
        assertEquals(witness.toLong(), lifecycleDao.witnessGlobalStats().itemCount)
        assertEquals(recent.toLong(), lifecycleDao.recentEvidenceGlobalStats().itemCount)
        assertEquals(notification.toLong(), lifecycleDao.notificationGlobalStats().itemCount)
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

    private fun putAgentTranscriptStorage(namespace: RelayV2OutboxAuthorityNamespace) {
        val consumer = agentConsumer(namespace)
        val entryId = "entry-${namespace.profileActivationGeneration}"
        val entryText = "agent text ${namespace.profileId}"
        val entryPayload = RelayV2StorageJson.encode(
            codecVersion = 1,
            value = linkedMapOf(
                "entryId" to entryId,
                "state" to "visible",
                "text" to entryText,
            ),
        )
        dao.insertAgentTranscriptEntry(
            RelayV2AgentTranscriptEntryEntity(
                profileId = consumer.profileId,
                profileActivationGeneration = consumer.profileActivationGeneration,
                principalId = consumer.principalId,
                clientInstanceId = consumer.clientInstanceId,
                hostId = consumer.hostId,
                hostEpoch = consumer.hostEpoch,
                scopeId = consumer.scopeId,
                sessionId = consumer.sessionId,
                timelineEpoch = AGENT_TIMELINE_EPOCH,
                entryId = entryId,
                runId = "run-${namespace.profileActivationGeneration}",
                turnId = "turn-${namespace.profileActivationGeneration}",
                role = "agent",
                commandId = null,
                createdAtMs = 10,
                createdAgentSeq = "4",
                createdAgentSeqOrder = orderKey("4"),
                lastModifiedAgentSeq = "4",
                lastModifiedAgentSeqOrder = orderKey("4"),
                entryState = "visible",
                text = entryText,
                redactionReason = null,
                tombstoneOrigin = null,
                tombstoneEvidenceThroughAgentSeq = null,
                tombstoneEvidenceThroughAgentSeqOrder = null,
                payloadCanonicalJson = entryPayload.canonicalJson,
                payloadUtf8Bytes = entryPayload.payloadUtf8Bytes,
                payloadSha256 = entryPayload.sha256,
            ),
        )

        val snapshotId = agentSnapshotId(namespace)
        dao.insertAgentTranscriptSnapshot(
            RelayV2AgentTranscriptSnapshotStagingEntity(
                profileId = consumer.profileId,
                profileActivationGeneration = consumer.profileActivationGeneration,
                principalId = consumer.principalId,
                clientInstanceId = consumer.clientInstanceId,
                hostId = consumer.hostId,
                hostEpoch = consumer.hostEpoch,
                scopeId = consumer.scopeId,
                sessionId = consumer.sessionId,
                timelineEpoch = AGENT_TIMELINE_EPOCH,
                snapshotRequestId = "agent-snapshot-request-${namespace.profileActivationGeneration}",
                requestLocalGeneration = "4",
                requestNetworkToken = "network-request-${namespace.profileActivationGeneration}",
                snapshotId = snapshotId,
                nextPageIndex = 1,
                nextCursor = null,
                throughAgentSeq = "5",
                throughAgentSeqOrder = orderKey("5"),
                earliestRetainedSeq = "1",
                earliestRetainedSeqOrder = orderKey("1"),
                receivedRecordCount = 1,
                receivedCanonicalBytes = entryPayload.payloadUtf8Bytes.toLong(),
                receivedRawUtf8Bytes = entryPayload.payloadUtf8Bytes + 7L,
                lastAgentSeq = "4",
                lastAgentSeqOrder = orderKey("4"),
                lastRecordKind = "text_entry",
                lastStableIdentity = entryId,
                complete = true,
            ),
        )
        dao.insertAgentTranscriptSnapshotRecords(
            listOf(
                RelayV2AgentTranscriptSnapshotRecordEntity(
                    profileId = consumer.profileId,
                    profileActivationGeneration = consumer.profileActivationGeneration,
                    principalId = consumer.principalId,
                    clientInstanceId = consumer.clientInstanceId,
                    hostId = consumer.hostId,
                    hostEpoch = consumer.hostEpoch,
                    scopeId = consumer.scopeId,
                    sessionId = consumer.sessionId,
                    timelineEpoch = AGENT_TIMELINE_EPOCH,
                    snapshotId = snapshotId,
                    pageIndex = 0,
                    recordIndex = 0,
                    recordKind = "text_entry",
                    stableIdentity = entryId,
                    agentEventSeq = "4",
                    agentEventSeqOrder = orderKey("4"),
                    payloadCanonicalJson = entryPayload.canonicalJson,
                    payloadRawUtf8Bytes = entryPayload.payloadUtf8Bytes + 7,
                    payloadSha256 = entryPayload.sha256,
                ),
            ),
        )
        dao.insertAgentTranscriptPendingEvent(
            pendingEvent(
                namespace,
                agentEventSeq = "6",
                eventId = "live-event-${namespace.profileActivationGeneration}",
                canonicalJson = "{\"live\":\"${namespace.profileId}-6\"}",
            ),
        )
    }

    private fun pendingEvent(
        namespace: RelayV2OutboxAuthorityNamespace,
        agentEventSeq: String,
        eventId: String,
        canonicalJson: String,
    ): RelayV2AgentTranscriptPendingEventEntity {
        val consumer = agentConsumer(namespace)
        return RelayV2AgentTranscriptPendingEventEntity(
            profileId = consumer.profileId,
            profileActivationGeneration = consumer.profileActivationGeneration,
            principalId = consumer.principalId,
            clientInstanceId = consumer.clientInstanceId,
            hostId = consumer.hostId,
            hostEpoch = consumer.hostEpoch,
            scopeId = consumer.scopeId,
            sessionId = consumer.sessionId,
            timelineEpoch = AGENT_TIMELINE_EPOCH,
            agentEventSeq = agentEventSeq,
            agentEventSeqOrder = orderKey(agentEventSeq),
            eventId = eventId,
            closedEventDigest = digest(canonicalJson).value,
            trustedProvenance = AgentEventProvenance.LIVE.name,
            eventCanonicalJson = canonicalJson,
            eventRawUtf8Bytes = canonicalJson.toByteArray(Charsets.UTF_8).size,
        )
    }

    private fun assertAgentTranscriptStorageCount(
        namespace: RelayV2OutboxAuthorityNamespace,
        expected: Long,
    ) {
        val consumer = agentConsumer(namespace)
        val identity = arrayOf(
            consumer.profileId,
            consumer.principalId,
            consumer.clientInstanceId,
            consumer.hostId,
            consumer.hostEpoch,
            consumer.scopeId,
            consumer.sessionId,
        )
        assertEquals(
            expected,
            dao.agentTranscriptEntryStats(
                identity[0], consumer.profileActivationGeneration, identity[1], identity[2],
                identity[3], identity[4], identity[5], identity[6], AGENT_TIMELINE_EPOCH,
            ).itemCount,
        )
        assertEquals(
            expected,
            dao.agentTranscriptSnapshotCount(
                identity[0], consumer.profileActivationGeneration, identity[1], identity[2],
                identity[3], identity[4], identity[5], identity[6], AGENT_TIMELINE_EPOCH,
            ),
        )
        assertEquals(
            expected,
            dao.agentTranscriptSnapshotRecordStats(
                identity[0], consumer.profileActivationGeneration, identity[1], identity[2],
                identity[3], identity[4], identity[5], identity[6], AGENT_TIMELINE_EPOCH,
                agentSnapshotId(namespace),
            ).itemCount,
        )
        assertEquals(
            expected,
            dao.agentTranscriptPendingEventStats(
                identity[0], consumer.profileActivationGeneration, identity[1], identity[2],
                identity[3], identity[4], identity[5], identity[6], AGENT_TIMELINE_EPOCH,
            ).itemCount,
        )
    }

    private fun agentTranscriptPendingEvents(
        namespace: RelayV2OutboxAuthorityNamespace,
    ): List<RelayV2AgentTranscriptPendingEventEntity> {
        val consumer = agentConsumer(namespace)
        return dao.agentTranscriptPendingEventPageAfter(
            consumer.profileId,
            consumer.profileActivationGeneration,
            consumer.principalId,
            consumer.clientInstanceId,
            consumer.hostId,
            consumer.hostEpoch,
            consumer.scopeId,
            consumer.sessionId,
            AGENT_TIMELINE_EPOCH,
            "",
            "",
            256,
        )
    }

    private fun agentSnapshotId(namespace: RelayV2OutboxAuthorityNamespace): String =
        "agent-snapshot-${namespace.profileActivationGeneration}"

    private fun orderKey(value: String): String = value.padStart(20, '0')

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
        return agentClaims(namespace).singleOrNull()
    }

    private fun agentClaims(
        namespace: RelayV2OutboxAuthorityNamespace,
    ): List<RelayV2AgentTranscriptLifecycleNotificationClaimEntity> {
        val fixture = agentClaimFixture(namespace)
        val key = fixture.intent.dedupeKey
        val consumer = fixture.namespace.consumer
        return dao.agentTranscriptLifecycleNotificationClaims(
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

    private data class AgentLifecycleRowFixture(
        val parent: RelayV2AgentTranscriptLifecycleStateEntity,
        val nextParentPayload: RelayV2EncodedPayload,
        val waiting: RelayV2AgentLifecycleEventWitnessEntity,
        val completed: RelayV2AgentLifecycleEventWitnessEntity,
        val current: RelayV2AgentLifecycleCurrentEntity,
        val recent: RelayV2AgentRecentEventEvidenceEntity,
        val notification: RelayV2AgentNotificationLedgerEntity,
    )

    private companion object {
        const val SCOPE_ID = "scope"
        const val SESSION_ID = "session"
        const val SNAPSHOT_ID = "snapshot"
        const val EVENT_SEQ = "1"
        const val FRESH_REQUIRED_EVENT_SEQ = "7"
        const val AGENT_TIMELINE_EPOCH = "timeline"
    }
}
