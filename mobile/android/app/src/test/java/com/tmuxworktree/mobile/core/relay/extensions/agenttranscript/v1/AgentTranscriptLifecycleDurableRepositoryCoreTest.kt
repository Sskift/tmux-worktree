package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2EncodedPayload
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageException
import java.security.MessageDigest
import java.util.Base64
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentTranscriptLifecycleDurableRepositoryCoreTest {
    @Test
    fun `complete namespaces coexist and retain reducer continuity evidence`() = runBlocking {
        val store = MemoryStore()
        val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
        val firstConsumer = consumer()
        val secondConsumer = consumer(
            profileId = "profile-other",
            activation = 9,
            principalId = "principal-other",
            clientInstanceId = "client-other",
            hostId = "host-other",
            hostEpoch = "host-epoch-other",
            scopeId = "scope-other",
            sessionId = "session-other",
        )
        val firstState = richState(firstConsumer, "timeline-a")
        val secondState = richState(secondConsumer, "timeline-b")

        repository.initializeUnderApplyLease(namespace(firstConsumer, firstState), firstState)
        repository.initializeUnderApplyLease(namespace(secondConsumer, secondState), secondState)

        assertEquals(2, store.rowCount)
        assertEquals(firstState, repository.load(firstConsumer)?.state)
        assertEquals(secondState, repository.load(secondConsumer)?.state)
        val restored = requireNotNull(repository.load(firstConsumer)).state.extensionLane
        assertEquals("2", restored.lastAgentSeq)
        assertEquals(setOf("1", "2"), restored.appliedEventsBySeq.keys)
        assertEquals(setOf("event-run", "event-turn"), restored.eventWitnessById.keys)
        assertEquals(2, restored.lifecycleByIdentity.size)
        assertEquals(1, restored.notificationLedger.size)
        assertEquals(AgentSnapshotCheckpoint("2", "2"), restored.snapshotCheckpoint)
        assertEquals(AgentLocalRequestFence("3", "status-after-restore"), restored.pendingStatusRequest)
        assertEquals(setOf("timeline-retired"), restored.retiredTimelineEpochs)
    }

    @Test
    fun `same identity is idempotent but conflicting initialization fails closed`() = runBlocking {
        val store = MemoryStore()
        val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
        val consumer = consumer()
        val state = richState(consumer, "timeline-a")
        val namespace = namespace(consumer, state)

        assertEquals(
            AgentTranscriptLifecycleInitializeDisposition.CREATED,
            repository.initializeUnderApplyLease(namespace, state).disposition,
        )
        val writesAfterCreate = store.writeCount
        assertEquals(
            AgentTranscriptLifecycleInitializeDisposition.UNCHANGED,
            repository.initializeUnderApplyLease(namespace, state).disposition,
        )
        assertEquals(writesAfterCreate, store.writeCount)

        val duplicate = repository.reduceUnderApplyLease(
            namespace,
            event(
                consumer,
                "timeline-a",
                "2",
                "event-turn",
                AgentLifecycleScope.TURN,
                AgentLifecycleState.WAITING_FOR_USER,
                "closed-turn",
                turnId = "turn-a",
            ),
        )
        assertEquals(AgentClientDisposition.DUPLICATE, duplicate.disposition)
        assertEquals(writesAfterCreate, store.writeCount)

        val conflict = runCatching {
            repository.initializeUnderApplyLease(
                namespace,
                state.copy(notificationConfig = state.notificationConfig.copy(profileActive = false)),
            )
        }.exceptionOrNull()
        assertTrue(conflict is AgentTranscriptLifecyclePersistenceConflictException)
        assertEquals(state, repository.load(consumer)?.state)
        assertEquals(writesAfterCreate, store.writeCount)
    }

    @Test
    fun `integrity codec and identity corruption fail closed without repair writes`() = runBlocking {
        val corruptions = listOf<(RelayV2EncodedPayload, AgentTranscriptLifecycleDurableConsumerIdentity) -> RelayV2EncodedPayload>(
            { payload, _ -> payload.copy(sha256 = "0".repeat(64)) },
            { payload, _ -> payload.copy(codecVersion = AgentTranscriptLifecycleDurableStateCodec.CODEC_VERSION + 1) },
            { _, consumer ->
                val wrongConsumer = consumer.copy(principalId = "principal-wrong")
                val wrongState = richState(wrongConsumer, "timeline-a")
                AgentTranscriptLifecycleDurableStateCodec.encode(
                    namespace(wrongConsumer, wrongState),
                    wrongState,
                )
            },
        )

        corruptions.forEach { corrupt ->
            val store = MemoryStore()
            val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
            val consumer = consumer()
            val state = richState(consumer, "timeline-a")
            repository.initializeUnderApplyLease(namespace(consumer, state), state)
            store.mutatePayload(consumer) { corrupt(it, consumer) }
            val writesBeforeLoad = store.writeCount

            val failure = runCatching { repository.load(consumer) }.exceptionOrNull()

            assertTrue(failure is RelayV2StorageException)
            assertEquals(writesBeforeLoad, store.writeCount)
            assertEquals(1, store.rowCount)
        }
    }

    @Test
    fun `failed replacement transaction preserves cursor records and evidence together`() =
        runBlocking {
            val store = MemoryStore()
            val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
            val consumer = consumer()
            val initial = richState(consumer, "timeline-a")
            val namespace = namespace(consumer, initial)
            repository.initializeUnderApplyLease(namespace, initial)
            store.failNextInsert = true

            val failure = runCatching {
                repository.reduceUnderApplyLease(
                    namespace,
                    event(
                        consumer,
                        "timeline-a",
                        "3",
                        "event-completed",
                        AgentLifecycleScope.TURN,
                        AgentLifecycleState.COMPLETED,
                        "closed-completed",
                        turnId = "turn-a",
                    ),
                )
            }.exceptionOrNull()

            assertTrue(failure is IllegalStateException)
            val restored = requireNotNull(repository.load(consumer)).state
            assertEquals(initial, restored)
            assertEquals("2", restored.extensionLane.lastAgentSeq)
            assertEquals(setOf("1", "2"), restored.extensionLane.appliedEventsBySeq.keys)
            assertEquals(2, restored.extensionLane.lifecycleByIdentity.size)
            assertEquals(1, restored.extensionLane.notificationLedger.size)
        }

    private class MemoryStore :
        AgentTranscriptLifecycleDurableStore,
        AgentTranscriptLifecycleDurableTransaction {
        private var rows = mutableListOf<AgentTranscriptLifecyclePersistedState>()
        var failNextInsert = false
        var writeCount = 0
            private set
        val rowCount: Int
            get() = rows.size

        override suspend fun <T> transaction(
            block: AgentTranscriptLifecycleDurableTransaction.() -> T,
        ): T {
            val rowsBefore = rows.toMutableList()
            val writesBefore = writeCount
            return try {
                block(this)
            } catch (failure: Throwable) {
                rows = rowsBefore
                writeCount = writesBefore
                throw failure
            }
        }

        override fun states(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
        ): List<AgentTranscriptLifecyclePersistedState> = rows.filter {
            it.namespace.consumer == consumer
        }

        override fun deleteConsumer(consumer: AgentTranscriptLifecycleDurableConsumerIdentity) {
            val removed = rows.removeAll { it.namespace.consumer == consumer }
            if (removed) writeCount += 1
        }

        override fun insertState(state: AgentTranscriptLifecyclePersistedState) {
            if (failNextInsert) {
                failNextInsert = false
                error("injected insert failure")
            }
            check(rows.none { it.namespace.consumer == state.namespace.consumer })
            rows += state
            writeCount += 1
        }

        fun mutatePayload(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
            mutate: (RelayV2EncodedPayload) -> RelayV2EncodedPayload,
        ) {
            val index = rows.indexOfFirst { it.namespace.consumer == consumer }
            check(index >= 0)
            rows[index] = rows[index].copy(payload = mutate(rows[index].payload))
        }
    }

    private companion object {
        fun consumer(
            profileId: String = "profile-a",
            activation: Long = 7,
            principalId: String = "principal-a",
            clientInstanceId: String = "client-a",
            hostId: String = "host-a",
            hostEpoch: String = "host-epoch-a",
            scopeId: String = "scope-a",
            sessionId: String = "session-a",
        ) = AgentTranscriptLifecycleDurableConsumerIdentity(
            profileId,
            activation,
            principalId,
            clientInstanceId,
            hostId,
            hostEpoch,
            scopeId,
            sessionId,
        )

        fun namespace(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
            state: AgentTranscriptLifecycleClientState,
        ) = AgentTranscriptLifecycleDurableNamespace.from(consumer, state)

        fun richState(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
            timelineEpoch: String,
        ): AgentTranscriptLifecycleClientState {
            val runIdentity = AgentLifecycleIdentity(AgentLifecycleScope.RUN, "run-a", null)
            val turnIdentity = AgentLifecycleIdentity(AgentLifecycleScope.TURN, "run-a", "turn-a")
            val runRecord = AgentLifecycleRecord(
                "event-run",
                "source-a",
                runIdentity,
                AgentLifecycleState.RUNNING,
                "1",
            )
            val turnRecord = AgentLifecycleRecord(
                "event-turn",
                "source-a",
                turnIdentity,
                AgentLifecycleState.WAITING_FOR_USER,
                "2",
            )
            val runWitness = witness(runRecord, "closed-run")
            val turnWitness = witness(turnRecord, "closed-turn")
            val notificationKey = AgentNotificationDedupeKey(
                consumer.profileId,
                consumer.hostId,
                consumer.hostEpoch,
                consumer.scopeId,
                consumer.sessionId,
                timelineEpoch,
                turnRecord.lifecycleEventId,
                turnRecord.state,
            )
            return AgentTranscriptLifecycleClientState(
                identity = consumer.sessionIdentity,
                extensionLane = AgentTranscriptLifecycleExtensionState(
                    localGeneration = "3",
                    support = AgentExtensionSupport.AVAILABLE,
                    unavailableReason = null,
                    liveSource = AgentLiveSourceState.CONNECTED,
                    activeSourceEpoch = "source-a",
                    timelineEpoch = timelineEpoch,
                    lastAgentSeq = "2",
                    notificationBaselineAgentSeq = "0",
                    lifecycleByIdentity = linkedMapOf(
                        runIdentity to runRecord,
                        turnIdentity to turnRecord,
                    ),
                    currentLifecycleIdentityByEventId = linkedMapOf(
                        runRecord.lifecycleEventId to runIdentity,
                        turnRecord.lifecycleEventId to turnIdentity,
                    ),
                    runsWithTurnRecords = setOf("run-a"),
                    appliedEventsBySeq = linkedMapOf(
                        "1" to AgentAppliedEventEvidence("event-run", digest("closed-run")),
                        "2" to AgentAppliedEventEvidence("event-turn", digest("closed-turn")),
                    ),
                    eventWitnessById = linkedMapOf(
                        runWitness.eventId to runWitness,
                        turnWitness.eventId to turnWitness,
                    ),
                    eventIdBySeq = linkedMapOf("1" to "event-run", "2" to "event-turn"),
                    notificationLedger = mapOf(
                        notificationKey to AgentNotificationLedgerEntry(
                            AgentNotificationDisposition.SHOWN,
                            turnWitness,
                            "3",
                        ),
                    ),
                    notificationKeyByLifecycleEventId = mapOf(
                        turnRecord.lifecycleEventId to notificationKey,
                    ),
                    retiredTimelineEpochs = setOf("timeline-retired"),
                    retiredEpochCompactionGeneration = "2",
                    snapshotCheckpoint = AgentSnapshotCheckpoint("2", "2"),
                    snapshotNotificationSuppressedThroughAgentSeq = "1",
                    pendingStatusRequest = AgentLocalRequestFence("3", "status-after-restore"),
                ),
                notificationConfig = AgentNotificationConfig(
                    permission = AgentNotificationPermission.GRANTED,
                    profileActive = true,
                    policy = AgentNotificationPolicy.ALLOW,
                ),
            )
        }

        fun event(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
            timelineEpoch: String,
            sequence: String,
            eventId: String,
            scope: AgentLifecycleScope,
            state: AgentLifecycleState,
            fingerprint: String,
            turnId: String? = null,
        ): AgentTranscriptLifecycleClientInput.AgentEvent {
            val identity = AgentLifecycleIdentity(scope, "run-a", turnId)
            return AgentTranscriptLifecycleClientInput.AgentEvent(
                AgentTimelineLineage(consumer.sessionIdentity, timelineEpoch),
                sequence,
                eventId,
                digest(fingerprint),
                AgentLifecycleRecord(eventId, "source-a", identity, state, sequence),
                AgentEventProvenance.LIVE,
            )
        }

        fun witness(
            record: AgentLifecycleRecord,
            fingerprint: String,
        ) = AgentLifecycleEventIdentityWitness(
            record.lifecycleEventId,
            record.agentEventSeq,
            record.identity,
            record.sourceEpoch,
            record.state,
            digest(fingerprint),
        )

        fun digest(value: String): AgentClosedEventDigest = AgentClosedEventDigest(
            Base64.getUrlEncoder().withoutPadding().encodeToString(
                MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)),
            ),
        )
    }
}
