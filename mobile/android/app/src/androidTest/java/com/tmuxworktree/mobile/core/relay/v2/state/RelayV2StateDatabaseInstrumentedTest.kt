package com.tmuxworktree.mobile.core.relay.v2.state

import android.content.Context
import androidx.room.Room
import androidx.room.withTransaction
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.*
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.*
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDialect
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
import java.security.MessageDigest
import java.util.Base64
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        listOf(first, second, retained).forEach {
            assertAgentLifecycleNamespaceCounts(
                AgentTranscriptLifecycleDurableNamespace(agentConsumer(it), AGENT_TIMELINE_EPOCH),
                current = 1,
                witness = 2,
                recent = 0,
                notification = 1,
            )
        }

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
            assertAgentLifecycleNamespaceCounts(
                AgentTranscriptLifecycleDurableNamespace(
                    agentConsumer(cleared),
                    AGENT_TIMELINE_EPOCH,
                ),
                current = 0,
                witness = 0,
                recent = 0,
                notification = 0,
            )
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
        assertAgentLifecycleNamespaceCounts(
            AgentTranscriptLifecycleDurableNamespace(agentConsumer(retained), AGENT_TIMELINE_EPOCH),
            current = 1,
            witness = 2,
            recent = 0,
            notification = 1,
        )
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
                lifecycleState = AgentLifecycleState.WAITING_FOR_USER.name,
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
    fun typedReplayConsumesTwoPagesAndKeepsRowOwnedMaterializationOutOfParent() = runBlocking {
        val authority = durableNamespace("replay-profile", activation = 1)
        val consumer = agentConsumer(authority)
        val initial = operationalAgentState(consumer)
        val namespace = AgentTranscriptLifecycleDurableNamespace.from(consumer, initial)
        val repository = AgentTranscriptLifecycleDurableRepository(database)
        repository.initializeUnderApplyLease(namespace, initial)
        enterReplay(repository, namespace, throughAgentSeq = "3")

        val firstPage = replayPageArtifact(
            namespace = namespace,
            requestNetworkToken = "replay-page-zero",
            replayThroughAgentSeq = "3",
            isLast = false,
            nextCursor = "replay-cursor-one",
            events = listOf(
                lifecyclePublicEvent(
                    sequence = "1",
                    eventId = "replay-running",
                    state = AgentTimelineLifecycleState.RUNNING,
                    runId = "replay-run",
                ),
                textAppendPublicEvent(
                    sequence = "2",
                    eventId = "replay-text",
                    entryId = "replay-entry",
                    runId = "replay-run",
                ),
            ),
        )
        val staged = repository.consumeReplayPageUnderApplyLease(
            AgentTranscriptLifecycleDurableReplayPageCommand.NonFinal(
                operationFence(namespace),
                firstPage,
                nextRequestNetworkToken = "replay-page-one",
            ),
        ).reduction

        assertEquals(AgentClientDisposition.CONFIG_APPLIED, staged.disposition)
        assertEquals("2", staged.state.extensionLane.lastAgentSeq)
        assertAgentLifecycleNamespaceCounts(namespace, current = 1, witness = 1, recent = 1,
            notification = 0)
        assertEquals(listOf("replay-entry"), agentEntries(namespace).map { it.entryId })
        assertParentHasNoRowOwnedMaterialization(authority)

        val finalPage = replayPageArtifact(
            namespace = namespace,
            requestNetworkToken = "replay-page-one",
            replayThroughAgentSeq = "3",
            isLast = true,
            nextCursor = null,
            events = listOf(
                lifecyclePublicEvent(
                    sequence = "3",
                    eventId = "replay-completed",
                    state = AgentTimelineLifecycleState.COMPLETED,
                    runId = "replay-run",
                ),
            ),
        )
        val committed = repository.consumeReplayPageUnderApplyLease(
            AgentTranscriptLifecycleDurableReplayPageCommand.Final(
                operationFence(namespace),
                finalPage,
            ),
        ).reduction

        assertEquals(AgentClientDisposition.CONFIG_APPLIED, committed.disposition)
        assertEquals(AgentTimelineSyncState.Current, committed.state.extensionLane.syncState)
        assertEquals("3", committed.state.extensionLane.lastAgentSeq)
        assertAgentLifecycleNamespaceCounts(namespace, current = 1, witness = 2, recent = 1,
            notification = 1)
        assertParentHasNoRowOwnedMaterialization(authority)
    }

    @Test
    fun agentReadProjectionPinsAuditedRoomCutAndFailsClosedOnCorruptRows() = runBlocking {
        val firstAuthority = durableNamespace("read-profile", activation = 1)
        val secondAuthority = durableNamespace("read-profile", activation = 2)
        val firstConsumer = agentConsumer(firstAuthority)
        val secondConsumer = agentConsumer(secondAuthority)
        val firstNamespace = AgentTranscriptLifecycleDurableNamespace.from(
            firstConsumer,
            operationalAgentState(firstConsumer),
        )
        val secondNamespace = AgentTranscriptLifecycleDurableNamespace.from(
            secondConsumer,
            operationalAgentState(secondConsumer),
        )
        val durable = AgentTranscriptLifecycleDurableRepository(database)
        durable.initializeUnderApplyLease(firstNamespace, operationalAgentState(firstConsumer))
        durable.initializeUnderApplyLease(secondNamespace, operationalAgentState(secondConsumer))

        suspend fun materialize(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            suffix: String,
        ) {
            consumeLive(
                durable,
                namespace,
                textAppendPublicEvent("1", "append-$suffix", "entry-$suffix", "run-$suffix"),
            )
            consumeLive(
                durable,
                namespace,
                lifecyclePublicEvent(
                    "2",
                    "running-$suffix",
                    AgentTimelineLifecycleState.RUNNING,
                    "run-$suffix",
                ),
            )
        }
        materialize(firstNamespace, "first")
        materialize(secondNamespace, "second")

        val projection = AgentTranscriptLifecycleRoomReadProjection(database)
        val firstPage = projection.read(readProjectionRequest(firstNamespace, limit = 1))
            as AgentTranscriptLifecycleReadState.Page
        assertEquals(listOf("entry-first"), firstPage.items.map { it.stableIdentity })
        assertFalse(firstPage.endReached)
        val firstCursor = requireNotNull(firstPage.nextCursor)

        val secondPage = projection.read(readProjectionRequest(secondNamespace, limit = 4))
            as AgentTranscriptLifecycleReadState.Page
        assertEquals(
            listOf("entry-second", "running-second"),
            secondPage.items.map { it.stableIdentity },
        )
        assertTrue(secondPage.endReached)
        assertTrue(secondPage.items.none { it.stableIdentity.contains("first") })

        consumeLive(
            durable,
            firstNamespace,
            lifecyclePublicEvent(
                "3",
                "waiting-first",
                AgentTimelineLifecycleState.WAITING_FOR_USER,
                "run-first",
            ),
        )
        val staleContinuation = projection.read(
            readProjectionRequest(firstNamespace, cursor = firstCursor, limit = 4),
        ) as AgentTranscriptLifecycleReadState.Unavailable
        assertEquals(
            AgentTranscriptLifecycleReadUnavailableReason.CURSOR_REVISION_CHANGED,
            staleContinuation.reason,
        )

        val afterPointerUpdate = projection.read(readProjectionRequest(firstNamespace, limit = 4))
            as AgentTranscriptLifecycleReadState.Page
        assertEquals(
            listOf("entry-first", "waiting-first"),
            afterPointerUpdate.items.map { it.stableIdentity },
        )
        assertEquals(
            AgentLifecycleState.WAITING_FOR_USER,
            (afterPointerUpdate.items.last() as
                AgentTranscriptLifecycleReadItem.LifecycleEvidence).lifecycle.state,
        )

        consumeLive(
            durable,
            firstNamespace,
            lifecyclePublicEvent(
                "4",
                "running-extra-first",
                AgentTimelineLifecycleState.RUNNING,
                "run-extra-first",
            ),
        )
        consumeLive(
            durable,
            firstNamespace,
            AgentTimelineEventRecord(
                agentEventSeq = "5",
                eventId = "delete-first",
                occurredAtMs = 5_000,
                mutation = AgentTimelineEntryDeletedMutation(
                    "entry-first",
                    com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec
                        .AgentTimelineRedactionReason.POLICY,
                ),
            ),
        )
        val afterDelete = projection.read(readProjectionRequest(firstNamespace, limit = 4))
            as AgentTranscriptLifecycleReadState.Page
        assertEquals(
            listOf("waiting-first", "running-extra-first"),
            afterDelete.items.map { it.stableIdentity },
        )

        val deleted = agentEntries(firstNamespace).single()
        database.openHelper.writableDatabase.execSQL(
            "UPDATE relay_v2_agent_transcript_entries SET payloadSha256 = ? " +
                "WHERE profileId = ? AND profileActivationGeneration = ? " +
                "AND principalId = ? AND clientInstanceId = ? AND hostId = ? " +
                "AND hostEpoch = ? AND scopeId = ? AND sessionId = ? " +
                "AND timelineEpoch = ? AND entryId = ?",
            arrayOf<Any?>(
                "0".repeat(64), deleted.profileId, deleted.profileActivationGeneration,
                deleted.principalId, deleted.clientInstanceId, deleted.hostId,
                deleted.hostEpoch, deleted.scopeId, deleted.sessionId, deleted.timelineEpoch,
                deleted.entryId,
            ),
        )
        assertInvalidMaterializedProjection(
            projection.read(readProjectionRequest(firstNamespace, limit = 1)),
        )

        val witness = agentWitnessRows(secondNamespace).single()
        database.openHelper.writableDatabase.execSQL(
            "UPDATE relay_v2_agent_lifecycle_event_witnesses SET witnessSha256 = ? " +
                "WHERE profileId = ? AND profileActivationGeneration = ? " +
                "AND principalId = ? AND clientInstanceId = ? AND hostId = ? " +
                "AND hostEpoch = ? AND scopeId = ? AND sessionId = ? " +
                "AND timelineEpoch = ? AND eventId = ?",
            arrayOf<Any?>(
                "0".repeat(64), witness.profileId, witness.profileActivationGeneration,
                witness.principalId, witness.clientInstanceId, witness.hostId,
                witness.hostEpoch, witness.scopeId, witness.sessionId, witness.timelineEpoch,
                witness.eventId,
            ),
        )
        assertInvalidMaterializedProjection(
            projection.read(readProjectionRequest(secondNamespace, limit = 4)),
        )
    }

    @Test
    fun typedSnapshotStagesNonFinalPageAndCommitsFinalCutAtomically() = runBlocking {
        val authority = durableNamespace("snapshot-profile", activation = 1)
        val consumer = agentConsumer(authority)
        val initial = operationalAgentState(consumer)
        val namespace = AgentTranscriptLifecycleDurableNamespace.from(consumer, initial)
        val repository = AgentTranscriptLifecycleDurableRepository(database)
        repository.initializeUnderApplyLease(namespace, initial)
        enterSnapshot(repository, namespace, throughAgentSeq = "3")
        repository.persistSnapshotRequestUnderApplyLease(
            AgentTranscriptLifecycleDurableSnapshotRequestCommand(
                operationFence(namespace),
                snapshotRequestId = "snapshot-request",
                pageZeroNetworkToken = "snapshot-page-zero",
            ),
        )

        val firstPage = snapshotPageArtifact(
            namespace = namespace,
            requestNetworkToken = "snapshot-page-zero",
            snapshotRequestId = "snapshot-request",
            snapshotId = "snapshot-pinned",
            pageIndex = 0,
            isLast = false,
            nextCursor = "snapshot-cursor-one",
            throughAgentSeq = "3",
            records = listOf(snapshotTextRecord("1", "snapshot-entry", "snapshot-run")),
        )
        repository.consumeSnapshotPageUnderApplyLease(
            AgentTranscriptLifecycleDurableSnapshotPageCommand.NonFinalStage(
                operationFence(namespace),
                firstPage,
                nextRequestNetworkToken = "snapshot-page-one",
            ),
        )

        val stagedHeader = agentSnapshots(namespace).single()
        assertEquals(1L, stagedHeader.nextPageIndex)
        assertEquals("snapshot-cursor-one", stagedHeader.nextCursor)
        assertEquals(1L, stagedHeader.receivedRecordCount)
        assertEquals(listOf(0L), agentSnapshotRecords(namespace, "snapshot-pinned")
            .map { it.pageIndex })
        assertEquals(emptyList<RelayV2AgentTranscriptEntryEntity>(), agentEntries(namespace))
        assertAgentLifecycleNamespaceCounts(namespace, current = 0, witness = 0, recent = 0,
            notification = 0)
        assertParentHasNoRowOwnedMaterialization(authority)

        val finalPage = snapshotPageArtifact(
            namespace = namespace,
            requestNetworkToken = "snapshot-page-one",
            snapshotRequestId = "snapshot-request",
            snapshotId = "snapshot-pinned",
            pageIndex = 1,
            isLast = true,
            nextCursor = null,
            throughAgentSeq = "3",
            records = listOf(
                lifecycleSnapshotRecord(
                    sequence = "3",
                    eventId = "snapshot-completed",
                    state = AgentTimelineLifecycleState.COMPLETED,
                    runId = "snapshot-run",
                ),
            ),
        )
        val committed = repository.consumeSnapshotPageUnderApplyLease(
            AgentTranscriptLifecycleDurableSnapshotPageCommand.FinalPageCut(
                operationFence(namespace),
                finalPage,
            ),
        ).reduction

        assertEquals(AgentClientDisposition.SNAPSHOT_APPLIED, committed.disposition)
        assertEquals(AgentTimelineSyncState.Current, committed.state.extensionLane.syncState)
        assertEquals("3", committed.state.extensionLane.lastAgentSeq)
        assertEquals(emptyList<RelayV2AgentTranscriptSnapshotStagingEntity>(),
            agentSnapshots(namespace))
        assertEquals(emptyList<RelayV2AgentTranscriptSnapshotRecordEntity>(),
            agentSnapshotRecords(namespace, "snapshot-pinned"))
        assertEquals(listOf("snapshot-entry"), agentEntries(namespace).map { it.entryId })
        assertAgentLifecycleNamespaceCounts(namespace, current = 1, witness = 1, recent = 0,
            notification = 1)
        assertParentHasNoRowOwnedMaterialization(authority)
    }

    @Test
    fun typedSnapshotFinalPageFailureRollsBackEveryRoomOwnedRow() = runBlocking {
        val authority = durableNamespace("snapshot-rollback-profile", activation = 1)
        val fixture = prepareAgentClaimFixture(authority)
        val repository = AgentTranscriptLifecycleDurableRepository(database)
        enterSnapshot(repository, fixture.namespace, throughAgentSeq = "4")
        repository.persistSnapshotRequestUnderApplyLease(
            AgentTranscriptLifecycleDurableSnapshotRequestCommand(
                operationFence(fixture.namespace),
                snapshotRequestId = "rollback-snapshot-request",
                pageZeroNetworkToken = "rollback-snapshot-page-zero",
            ),
        )
        val firstPage = snapshotPageArtifact(
            namespace = fixture.namespace,
            requestNetworkToken = "rollback-snapshot-page-zero",
            snapshotRequestId = "rollback-snapshot-request",
            snapshotId = "rollback-snapshot-pinned",
            pageIndex = 0,
            isLast = false,
            nextCursor = "rollback-snapshot-cursor-one",
            throughAgentSeq = "4",
            records = emptyList(),
        )
        repository.consumeSnapshotPageUnderApplyLease(
            AgentTranscriptLifecycleDurableSnapshotPageCommand.NonFinalStage(
                operationFence(fixture.namespace),
                firstPage,
                nextRequestNetworkToken = "rollback-snapshot-page-one",
            ),
        )

        val parentBeforeFinal = agentRows(authority).single()
        val headerBeforeFinal = agentSnapshots(fixture.namespace).single()
        val currentBeforeFinal = agentCurrentRows(fixture.namespace)
        val witnessesBeforeFinal = agentWitnessRows(fixture.namespace)
        val evidenceBeforeFinal = agentRecentEvidenceRows(fixture.namespace)
        val notificationsBeforeFinal = agentNotificationRows(fixture.namespace)
        val entriesBeforeFinal = agentEntries(fixture.namespace)
        val finalPage = snapshotPageArtifact(
            namespace = fixture.namespace,
            requestNetworkToken = "rollback-snapshot-page-one",
            snapshotRequestId = "rollback-snapshot-request",
            snapshotId = "rollback-snapshot-pinned",
            pageIndex = 1,
            isLast = true,
            nextCursor = null,
            throughAgentSeq = "4",
            records = listOf(
                lifecycleSnapshotRecord(
                    sequence = "2",
                    eventId = claimCompletedEventId(authority),
                    state = AgentTimelineLifecycleState.WAITING_FOR_USER,
                    runId = claimRunId(authority),
                ),
            ),
        )

        val failure = runCatching {
            repository.consumeSnapshotPageUnderApplyLease(
                AgentTranscriptLifecycleDurableSnapshotPageCommand.FinalPageCut(
                    operationFence(fixture.namespace),
                    finalPage,
                ),
            )
        }.exceptionOrNull()

        assertTrue(failure is RelayV2StorageException)
        assertEquals(RelayV2StorageFailure.MALFORMED,
            (failure as RelayV2StorageException).failure)
        assertEquals(parentBeforeFinal, agentRows(authority).single())
        assertEquals(headerBeforeFinal, agentSnapshots(fixture.namespace).single())
        assertEquals(emptyList<RelayV2AgentTranscriptSnapshotRecordEntity>(),
            agentSnapshotRecords(fixture.namespace, "rollback-snapshot-pinned"))
        assertEquals(currentBeforeFinal, agentCurrentRows(fixture.namespace))
        assertEquals(witnessesBeforeFinal, agentWitnessRows(fixture.namespace))
        assertEquals(evidenceBeforeFinal, agentRecentEvidenceRows(fixture.namespace))
        assertEquals(notificationsBeforeFinal, agentNotificationRows(fixture.namespace))
        assertEquals(entriesBeforeFinal, agentEntries(fixture.namespace))
        assertParentHasNoRowOwnedMaterialization(authority)
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
        val fixture = putAgentConsumer(namespace)
        val committed = requireNotNull(agentClaim(namespace))
        val unknownState = "UNKNOWN_PERSISTED_LIFECYCLE_STATE"
        dao.deleteProfileAgentTranscriptLifecycleNotificationClaims(namespace.profileId)
        dao.insertAgentTranscriptLifecycleNotificationClaim(
            committed.copy(lifecycleState = unknownState),
        )
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

    private suspend fun putAgentConsumer(
        namespace: RelayV2OutboxAuthorityNamespace,
    ): AgentClaimFixture {
        val fixture = prepareAgentClaimFixture(namespace)
        val repository = AgentTranscriptLifecycleDurableRepository(database)
        assertTrue(
            repository.claimNotificationUnderApplyLease(
                fixture.namespace,
                fixture.intent,
            ) is AgentTranscriptLifecycleNotificationClaimResult.Claimed,
        )
        return fixture
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
        val consumer = agentConsumer(namespace)
        return dao.agentTranscriptLifecycleNotificationClaims(
            consumer.profileId,
            consumer.profileActivationGeneration,
            consumer.principalId,
            consumer.clientInstanceId,
            consumer.hostId,
            consumer.hostEpoch,
            consumer.scopeId,
            consumer.sessionId,
            AGENT_TIMELINE_EPOCH,
            claimCompletedEventId(namespace),
        )
    }

    private suspend fun prepareAgentClaimFixture(
        namespace: RelayV2OutboxAuthorityNamespace,
    ): AgentClaimFixture {
        val consumer = agentConsumer(namespace)
        val initial = operationalAgentState(consumer)
        val durableNamespace = AgentTranscriptLifecycleDurableNamespace.from(consumer, initial)
        val repository = AgentTranscriptLifecycleDurableRepository(database)
        repository.initializeUnderApplyLease(durableNamespace, initial)
        consumeLive(
            repository,
            durableNamespace,
            lifecyclePublicEvent(
                sequence = "1",
                eventId = "event-${namespace.profileActivationGeneration}-running",
                state = AgentTimelineLifecycleState.RUNNING,
                runId = claimRunId(namespace),
            ),
        )
        val completed = consumeLive(
            repository,
            durableNamespace,
            lifecyclePublicEvent(
                sequence = "2",
                eventId = claimCompletedEventId(namespace),
                state = AgentTimelineLifecycleState.COMPLETED,
                runId = claimRunId(namespace),
            ),
        )
        val intent = requireNotNull(
            completed.notificationDecisions.single().systemNotificationIntent,
        )
        assertAgentLifecycleNamespaceCounts(
            durableNamespace,
            current = 1,
            witness = 2,
            recent = 0,
            notification = 1,
        )
        assertParentHasNoRowOwnedMaterialization(namespace)
        return AgentClaimFixture(durableNamespace, intent)
    }

    private fun operationalAgentState(
        consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
    ) = AgentTranscriptLifecycleClientState(
        identity = consumer.sessionIdentity,
        extensionLane = AgentTranscriptLifecycleExtensionState(
            support = AgentExtensionSupport.AVAILABLE,
            unavailableReason = null,
            liveSource = AgentLiveSourceState.CONNECTED,
            activeSourceEpoch = "source-a",
            timelineEpoch = AGENT_TIMELINE_EPOCH,
            effectiveHostLimits = productionHostLimits(),
            syncState = AgentTimelineSyncState.Current,
            notificationBaselineAgentSeq = "0",
        ),
        notificationConfig = AgentNotificationConfig(
            permission = AgentNotificationPermission.GRANTED,
            profileActive = true,
            policy = AgentNotificationPolicy.ALLOW,
        ),
    )

    private fun productionHostLimits() = AgentTimelineEffectiveLimits(
        maxTextUtf8Bytes = 65_536,
        maxPageRecords = 256,
        eventReplayRetentionMs = 604_800_000,
        snapshotLeaseMs = 300_000,
    )

    private fun readProjectionRequest(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        cursor: AgentTranscriptLifecycleReadCursor? = null,
        limit: Int,
    ) = AgentTranscriptLifecycleReadRequest(
        selectedNamespace = namespace,
        access = AgentTranscriptLifecycleReadAccess(
            dialect = AgentTranscriptLifecycleReadDialect.RELAY_V2,
            negotiatedCapabilities = setOf(AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY),
            support = AgentExtensionSupport.AVAILABLE,
            activeNamespace = namespace,
        ),
        cursor = cursor,
        limit = limit,
    )

    private fun assertInvalidMaterializedProjection(
        state: AgentTranscriptLifecycleReadState,
    ) {
        val unavailable = state as AgentTranscriptLifecycleReadState.Unavailable
        assertEquals(
            AgentTranscriptLifecycleReadUnavailableReason.MATERIALIZED_STATE_INVALID,
            unavailable.reason,
        )
    }

    private fun operationFence(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ) = AgentTranscriptLifecycleDurableOperationFence(namespace.consumer, namespace)

    private suspend fun consumeLive(
        repository: AgentTranscriptLifecycleDurableRepository,
        namespace: AgentTranscriptLifecycleDurableNamespace,
        event: AgentTimelineEventRecord,
    ): AgentTranscriptLifecycleClientReduction {
        val consumer = namespace.consumer
        val artifact = AgentTranscriptLifecycleV1Codec().let { codec ->
            codec.decodePublicFrameArtifact(
                codec.encodePublicFrame(
                    AgentTimelineEventFrame(
                        consumer.hostId,
                        consumer.hostEpoch,
                        consumer.scopeId,
                        consumer.sessionId,
                        requireNotNull(namespace.timelineEpoch),
                        event,
                    ),
                ),
            )
        }
        return repository.consumeLiveEventUnderApplyLease(
            AgentTranscriptLifecycleDurableLiveEventCommand(
                operationFence(namespace),
                artifact,
            ),
        ).reduction
    }

    private suspend fun enterReplay(
        repository: AgentTranscriptLifecycleDurableRepository,
        namespace: AgentTranscriptLifecycleDurableNamespace,
        throughAgentSeq: String,
    ) {
        val requested = repository.applyControlUnderApplyLease(
            AgentTranscriptLifecycleDurableControlCommand(
                operationFence(namespace),
                AgentTranscriptLifecycleClientInput.StatusRequestStarted(
                    "replay-status-${namespace.consumer.sessionId}",
                ),
            ),
        ).reduction
        val status = repository.applyControlUnderApplyLease(
            AgentTranscriptLifecycleDurableControlCommand(
                operationFence(namespace),
                AgentTranscriptLifecycleClientInput.StatusAvailable(
                    authority = namespace.consumer,
                    lineage = AgentTimelineLineage(
                        namespace.consumer.sessionIdentity,
                        requireNotNull(namespace.timelineEpoch),
                    ),
                    requestFence = requireNotNull(
                        requested.state.extensionLane.pendingStatusRequest,
                    ),
                    liveSource = AgentLiveSourceState.CONNECTED,
                    activeSourceEpoch = "source-a",
                    currentAgentSeq = throughAgentSeq,
                    earliestReplaySeq = "1",
                    hostLimits = productionHostLimits(),
                ),
            ),
        ).reduction
        assertTrue(status.state.extensionLane.syncState is AgentTimelineSyncState.Replay)
        repository.applyControlUnderApplyLease(
            AgentTranscriptLifecycleDurableControlCommand(
                operationFence(namespace),
                AgentTranscriptLifecycleClientInput.ReplayRequestStarted(
                    requestNetworkToken = "replay-page-zero",
                    cursor = null,
                    limit = 256,
                ),
            ),
        )
    }

    private suspend fun enterSnapshot(
        repository: AgentTranscriptLifecycleDurableRepository,
        namespace: AgentTranscriptLifecycleDurableNamespace,
        throughAgentSeq: String,
    ) {
        val requested = repository.applyControlUnderApplyLease(
            AgentTranscriptLifecycleDurableControlCommand(
                operationFence(namespace),
                AgentTranscriptLifecycleClientInput.StatusRequestStarted(
                    "snapshot-status-${namespace.consumer.profileId}-$throughAgentSeq",
                ),
            ),
        ).reduction
        val status = repository.applyControlUnderApplyLease(
            AgentTranscriptLifecycleDurableControlCommand(
                operationFence(namespace),
                AgentTranscriptLifecycleClientInput.StatusAvailable(
                    authority = namespace.consumer,
                    lineage = AgentTimelineLineage(
                        namespace.consumer.sessionIdentity,
                        requireNotNull(namespace.timelineEpoch),
                    ),
                    requestFence = requireNotNull(
                        requested.state.extensionLane.pendingStatusRequest,
                    ),
                    liveSource = AgentLiveSourceState.CONNECTED,
                    activeSourceEpoch = "source-a",
                    currentAgentSeq = throughAgentSeq,
                    earliestReplaySeq = throughAgentSeq,
                    hostLimits = productionHostLimits(),
                ),
            ),
        ).reduction
        assertEquals(AgentTimelineSyncState.Snapshot, status.state.extensionLane.syncState)
    }

    private fun replayPageArtifact(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        requestNetworkToken: String,
        replayThroughAgentSeq: String,
        isLast: Boolean,
        nextCursor: String?,
        events: List<AgentTimelineEventRecord>,
    ): AgentTimelineReplayPagePublicFrameArtifact {
        val consumer = namespace.consumer
        val codec = AgentTranscriptLifecycleV1Codec()
        return codec.decodePublicFrameArtifact(
            codec.encodePublicFrame(
                AgentTimelineReplayPageFrame(
                    requestId = requestNetworkToken,
                    hostId = consumer.hostId,
                    hostEpoch = consumer.hostEpoch,
                    scopeId = consumer.scopeId,
                    sessionId = consumer.sessionId,
                    page = AgentTimelineReplayPage(
                        timelineEpoch = requireNotNull(namespace.timelineEpoch),
                        afterAgentSeq = "0",
                        replayThroughAgentSeq = replayThroughAgentSeq,
                        isLast = isLast,
                        nextCursor = nextCursor,
                        events = events,
                    ),
                ),
            ),
        ) as AgentTimelineReplayPagePublicFrameArtifact
    }

    private fun snapshotPageArtifact(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        requestNetworkToken: String,
        snapshotRequestId: String,
        snapshotId: String,
        pageIndex: Long,
        isLast: Boolean,
        nextCursor: String?,
        throughAgentSeq: String,
        records: List<AgentTimelineSnapshotRecord>,
    ): AgentTimelineSnapshotPagePublicFrameArtifact {
        val consumer = namespace.consumer
        val codec = AgentTranscriptLifecycleV1Codec()
        return codec.decodePublicFrameArtifact(
            codec.encodePublicFrame(
                AgentTimelineSnapshotPageFrame(
                    requestId = requestNetworkToken,
                    hostId = consumer.hostId,
                    hostEpoch = consumer.hostEpoch,
                    scopeId = consumer.scopeId,
                    sessionId = consumer.sessionId,
                    page = AgentTimelineSnapshotPage(
                        timelineEpoch = requireNotNull(namespace.timelineEpoch),
                        snapshotRequestId = snapshotRequestId,
                        snapshotId = snapshotId,
                        pageIndex = pageIndex,
                        isLast = isLast,
                        nextCursor = nextCursor,
                        throughAgentSeq = throughAgentSeq,
                        earliestRetainedSeq = "1",
                        records = records,
                    ),
                ),
            ),
        ) as AgentTimelineSnapshotPagePublicFrameArtifact
    }

    private fun lifecyclePublicEvent(
        sequence: String,
        eventId: String,
        state: AgentTimelineLifecycleState,
        runId: String,
    ) = AgentTimelineEventRecord(
        agentEventSeq = sequence,
        eventId = eventId,
        occurredAtMs = sequence.toLong() * 1_000,
        mutation = AgentTimelineLifecycleChangedMutation(
            lifecycleSnapshotRecord(sequence, eventId, state, runId),
        ),
    )

    private fun lifecycleSnapshotRecord(
        sequence: String,
        eventId: String,
        state: AgentTimelineLifecycleState,
        runId: String,
    ) = AgentTimelineLifecycleRecord(
        lifecycleEventId = eventId,
        sourceEpoch = "source-a",
        scope = AgentTimelineLifecycleScope.RUN,
        runId = runId,
        turnId = null,
        state = state,
        failure = null,
        occurredAtMs = sequence.toLong() * 1_000,
        agentEventSeq = sequence,
    )

    private fun textAppendPublicEvent(
        sequence: String,
        eventId: String,
        entryId: String,
        runId: String,
    ) = AgentTimelineEventRecord(
        agentEventSeq = sequence,
        eventId = eventId,
        occurredAtMs = sequence.toLong() * 1_000,
        mutation = AgentTimelineTextEntryAppendedMutation(
            snapshotTextRecord(sequence, entryId, runId),
        ),
    )

    private fun snapshotTextRecord(
        sequence: String,
        entryId: String,
        runId: String,
    ) = AgentTimelineVisibleTextEntryRecord(
        metadata = AgentTimelineTextEntryMetadata(
            entryId = entryId,
            runId = runId,
            turnId = "turn-$runId",
            role = com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec
                .AgentTimelineEntryRole.AGENT,
            commandId = null,
            createdAtMs = sequence.toLong() * 1_000,
            createdAgentSeq = sequence,
            lastModifiedAgentSeq = sequence,
        ),
        text = "text-$entryId",
    )

    private fun claimRunId(namespace: RelayV2OutboxAuthorityNamespace) =
        "run-${namespace.profileActivationGeneration}"

    private fun claimCompletedEventId(namespace: RelayV2OutboxAuthorityNamespace) =
        "event-${namespace.profileActivationGeneration}-completed"

    private fun agentEntries(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): List<RelayV2AgentTranscriptEntryEntity> = namespace.consumer.let { consumer ->
        dao.agentTranscriptEntryPageAfter(
            consumer.profileId, consumer.profileActivationGeneration, consumer.principalId,
            consumer.clientInstanceId, consumer.hostId, consumer.hostEpoch, consumer.scopeId,
            consumer.sessionId, requireNotNull(namespace.timelineEpoch), "", "", 256,
        )
    }

    private fun agentSnapshots(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): List<RelayV2AgentTranscriptSnapshotStagingEntity> = namespace.consumer.let { consumer ->
        dao.agentTranscriptSnapshots(
            consumer.profileId, consumer.profileActivationGeneration, consumer.principalId,
            consumer.clientInstanceId, consumer.hostId, consumer.hostEpoch, consumer.scopeId,
            consumer.sessionId, requireNotNull(namespace.timelineEpoch),
        )
    }

    private fun agentSnapshotRecords(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        snapshotId: String,
    ): List<RelayV2AgentTranscriptSnapshotRecordEntity> = namespace.consumer.let { consumer ->
        dao.agentTranscriptSnapshotRecordPageAfter(
            consumer.profileId, consumer.profileActivationGeneration, consumer.principalId,
            consumer.clientInstanceId, consumer.hostId, consumer.hostEpoch, consumer.scopeId,
            consumer.sessionId, requireNotNull(namespace.timelineEpoch), snapshotId, -1, 256,
        )
    }

    private fun agentCurrentRows(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): List<RelayV2AgentLifecycleCurrentEntity> = namespace.consumer.let { consumer ->
        lifecycleDao.currentPageAfter(
            consumer.profileId, consumer.profileActivationGeneration, consumer.principalId,
            consumer.clientInstanceId, consumer.hostId, consumer.hostEpoch, consumer.scopeId,
            consumer.sessionId, requireNotNull(namespace.timelineEpoch), "", "", 256,
        )
    }

    private fun agentWitnessRows(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): List<RelayV2AgentLifecycleEventWitnessEntity> = namespace.consumer.let { consumer ->
        lifecycleDao.witnessPageAfter(
            consumer.profileId, consumer.profileActivationGeneration, consumer.principalId,
            consumer.clientInstanceId, consumer.hostId, consumer.hostEpoch, consumer.scopeId,
            consumer.sessionId, requireNotNull(namespace.timelineEpoch), "", "", 256,
        )
    }

    private fun agentRecentEvidenceRows(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): List<RelayV2AgentRecentEventEvidenceEntity> = namespace.consumer.let { consumer ->
        lifecycleDao.recentEvidencePageAfter(
            consumer.profileId, consumer.profileActivationGeneration, consumer.principalId,
            consumer.clientInstanceId, consumer.hostId, consumer.hostEpoch, consumer.scopeId,
            consumer.sessionId, requireNotNull(namespace.timelineEpoch), "", "", 256,
        )
    }

    private fun agentNotificationRows(
        namespace: AgentTranscriptLifecycleDurableNamespace,
    ): List<RelayV2AgentNotificationLedgerEntity> = namespace.consumer.let { consumer ->
        lifecycleDao.notificationPageAfter(
            consumer.profileId, consumer.profileActivationGeneration, consumer.principalId,
            consumer.clientInstanceId, consumer.hostId, consumer.hostEpoch, consumer.scopeId,
            consumer.sessionId, requireNotNull(namespace.timelineEpoch), "", "", "", 256,
        )
    }

    private fun assertAgentLifecycleNamespaceCounts(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        current: Int,
        witness: Int,
        recent: Int,
        notification: Int,
    ) {
        assertEquals(current, agentCurrentRows(namespace).size)
        assertEquals(witness, agentWitnessRows(namespace).size)
        assertEquals(recent, agentRecentEvidenceRows(namespace).size)
        assertEquals(notification, agentNotificationRows(namespace).size)
    }

    private fun assertParentHasNoRowOwnedMaterialization(
        namespace: RelayV2OutboxAuthorityNamespace,
    ) {
        val parent = agentRows(namespace).single()
        assertEquals(AgentTranscriptLifecycleDurableStateCodec.CODEC_VERSION, parent.codecVersion)
        listOf(
            "lifecycleRecords",
            "runsWithTurnRecords",
            "appliedEventEvidence",
            "eventIdentityWitnesses",
            "notificationLedger",
        ).forEach { rowOwnedMember ->
            assertTrue("\"$rowOwnedMember\":" !in parent.payloadCanonicalJson)
        }
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
