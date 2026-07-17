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

    @Test
    fun `notification claim is one shot and returns only post commit authority`() = runBlocking {
        val store = MemoryStore()
        val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
        val consumer = consumer()
        val state = richState(consumer, "timeline-a")
        val namespace = namespace(consumer, state)
        val intent = notificationIntent(state)
        repository.initializeUnderApplyLease(namespace, state)

        val claimed = repository.claimNotificationUnderApplyLease(namespace, intent)
            as AgentTranscriptLifecycleNotificationClaimResult.Claimed

        assertEquals(namespace, claimed.ticket.namespace)
        assertEquals(intent, claimed.ticket.intent)
        assertEquals(64, claimed.ticket.claimId.length)
        assertEquals(1, store.claimCount)
        val writesAfterClaim = store.writeCount
        assertEquals(
            AgentTranscriptLifecycleNotificationClaimResult.NotExecutable(
                AgentTranscriptLifecycleNotificationNotExecutableReason.ALREADY_CLAIMED,
            ),
            repository.claimNotificationUnderApplyLease(namespace, intent),
        )
        assertEquals(writesAfterClaim, store.writeCount)
        assertEquals(1, store.claimCount)
    }

    @Test
    fun `corrupt claim codec hash and identity fail closed without overwrite`() = runBlocking {
        val consumer = consumer()
        val state = richState(consumer, "timeline-a")
        val namespace = namespace(consumer, state)
        val intent = notificationIntent(state)
        val key = claimKey(namespace, intent)
        val corruptions = listOf<(RelayV2EncodedPayload) -> RelayV2EncodedPayload>(
            { it.copy(sha256 = "0".repeat(64)) },
            {
                it.copy(
                    codecVersion = AgentTranscriptLifecycleNotificationClaimCodec.CODEC_VERSION + 1,
                )
            },
            {
                val wrongKey = key.copy(
                    consumer = key.consumer.copy(principalId = "principal-wrong"),
                )
                AgentTranscriptLifecycleNotificationClaimCodec.encode(wrongKey, intent)
            },
        )

        corruptions.forEach { corrupt ->
            val store = MemoryStore()
            val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
            repository.initializeUnderApplyLease(namespace, state)
            assertTrue(
                repository.claimNotificationUnderApplyLease(namespace, intent) is
                    AgentTranscriptLifecycleNotificationClaimResult.Claimed,
            )
            store.mutateClaimPayload(key, corrupt)
            val writesBeforeRead = store.writeCount

            val failure = runCatching {
                repository.claimNotificationUnderApplyLease(namespace, intent)
            }.exceptionOrNull()

            assertTrue(failure is RelayV2StorageException)
            assertEquals(writesBeforeRead, store.writeCount)
            assertEquals(1, store.claimCount)
        }
    }

    @Test
    fun `stale lineage generation source and notification config never create claims`() =
        runBlocking {
            val consumer = consumer()
            val base = richState(consumer, "timeline-a")
            val baseIntent = notificationIntent(base)
            val cases = listOf(
                "old-generation" to (base to baseIntent.copy(localGeneration = "2")),
                "old-timeline" to (
                    base to baseIntent.copy(
                        dedupeKey = baseIntent.dedupeKey.copy(timelineEpoch = "timeline-old"),
                    )
                    ),
                "inactive-profile" to (
                    base.copy(notificationConfig = base.notificationConfig.copy(profileActive = false))
                        to baseIntent
                    ),
                "permission-denied" to (
                    base.copy(
                        notificationConfig = base.notificationConfig.copy(
                            permission = AgentNotificationPermission.DENIED,
                        ),
                    ) to baseIntent
                    ),
                "policy-suppress" to (
                    base.copy(
                        notificationConfig = base.notificationConfig.copy(
                            policy = AgentNotificationPolicy.SUPPRESS,
                        ),
                    ) to baseIntent
                    ),
                "source-interrupted" to (
                    base.copy(
                        extensionLane = base.extensionLane.copy(
                            liveSource = AgentLiveSourceState.INTERRUPTED,
                        ),
                    ) to baseIntent
                    ),
                "not-shown" to (withLedgerDisposition(
                    base,
                    AgentNotificationDisposition.SUPPRESSED_POLICY,
                ) to baseIntent),
            )

            cases.forEach { (label, stateAndIntent) ->
                val (state, intent) = stateAndIntent
                val store = MemoryStore()
                val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
                val namespace = namespace(consumer, state)
                repository.initializeUnderApplyLease(namespace, state)

                assertEquals(
                    label,
                    AgentTranscriptLifecycleNotificationClaimResult.NotExecutable(
                        AgentTranscriptLifecycleNotificationNotExecutableReason.INTENT_NOT_CURRENT,
                    ),
                    repository.claimNotificationUnderApplyLease(namespace, intent),
                )
                assertEquals(label, 0, store.claimCount)
            }

            val activationStore = MemoryStore()
            val activationRepository = AgentTranscriptLifecycleDurableRepositoryCore(activationStore)
            val namespace = namespace(consumer, base)
            activationRepository.initializeUnderApplyLease(namespace, base)
            val wrongActivation = namespace.copy(
                consumer = consumer.copy(profileActivationGeneration = 8),
            )
            assertEquals(
                AgentTranscriptLifecycleNotificationClaimResult.NotExecutable(
                    AgentTranscriptLifecycleNotificationNotExecutableReason.STATE_MISSING,
                ),
                activationRepository.claimNotificationUnderApplyLease(
                    wrongActivation,
                    baseIntent,
                ),
            )
            assertEquals(0, activationStore.claimCount)
        }

    @Test
    fun `corrupt state and failed claim CAS cannot emit or persist a ticket`() = runBlocking {
        val consumer = consumer()
        val state = richState(consumer, "timeline-a")
        val namespace = namespace(consumer, state)
        val intent = notificationIntent(state)

        val corruptStore = MemoryStore()
        val corruptRepository = AgentTranscriptLifecycleDurableRepositoryCore(corruptStore)
        corruptRepository.initializeUnderApplyLease(namespace, state)
        corruptStore.mutatePayload(consumer) { it.copy(sha256 = "0".repeat(64)) }
        val corrupt = runCatching {
            corruptRepository.claimNotificationUnderApplyLease(namespace, intent)
        }.exceptionOrNull()
        assertTrue(corrupt is RelayV2StorageException)
        assertEquals(0, corruptStore.claimCount)

        val failingStore = MemoryStore()
        val failingRepository = AgentTranscriptLifecycleDurableRepositoryCore(failingStore)
        failingRepository.initializeUnderApplyLease(namespace, state)
        failingStore.failNextClaimInsert = true
        val failedCas = runCatching {
            failingRepository.claimNotificationUnderApplyLease(namespace, intent)
        }.exceptionOrNull()
        assertTrue(failedCas is IllegalStateException)
        assertEquals(0, failingStore.claimCount)
        assertEquals(state, failingRepository.load(consumer)?.state)
    }

    private class MemoryStore :
        AgentTranscriptLifecycleDurableStore,
        AgentTranscriptLifecycleDurableTransaction {
        private var rows = mutableListOf<AgentTranscriptLifecyclePersistedState>()
        private var claims = linkedMapOf<
            AgentTranscriptLifecycleNotificationClaimKey,
            AgentTranscriptLifecyclePersistedNotificationClaim
            >()
        var failNextInsert = false
        var failNextClaimInsert = false
        var writeCount = 0
            private set
        val rowCount: Int
            get() = rows.size
        val claimCount: Int
            get() = claims.size

        override suspend fun <T> transaction(
            block: AgentTranscriptLifecycleDurableTransaction.() -> T,
        ): T {
            val rowsBefore = rows.toMutableList()
            val claimsBefore = LinkedHashMap(claims)
            val writesBefore = writeCount
            return try {
                block(this)
            } catch (failure: Throwable) {
                rows = rowsBefore
                claims = claimsBefore
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

        override fun notificationClaim(
            key: AgentTranscriptLifecycleNotificationClaimKey,
        ): AgentTranscriptLifecyclePersistedNotificationClaim? = claims[key]

        override fun insertNotificationClaim(
            claim: AgentTranscriptLifecyclePersistedNotificationClaim,
        ) {
            if (failNextClaimInsert) {
                failNextClaimInsert = false
                error("injected claim insert failure")
            }
            check(claim.key !in claims)
            claims[claim.key] = claim
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

        fun mutateClaimPayload(
            key: AgentTranscriptLifecycleNotificationClaimKey,
            mutate: (RelayV2EncodedPayload) -> RelayV2EncodedPayload,
        ) {
            val claim = requireNotNull(claims[key])
            claims[key] = claim.copy(payload = mutate(claim.payload))
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

        fun notificationIntent(
            state: AgentTranscriptLifecycleClientState,
        ): AgentSystemNotificationIntent {
            val (key, entry) = state.extensionLane.notificationLedger.entries.single()
            return AgentSystemNotificationIntent(key, entry.localGeneration)
        }

        fun claimKey(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            intent: AgentSystemNotificationIntent,
        ) = requireNotNull(
            AgentTranscriptLifecycleNotificationClaimKey.exactOrNull(namespace, intent),
        )

        fun withLedgerDisposition(
            state: AgentTranscriptLifecycleClientState,
            disposition: AgentNotificationDisposition,
        ): AgentTranscriptLifecycleClientState {
            val (key, entry) = state.extensionLane.notificationLedger.entries.single()
            return state.copy(
                extensionLane = state.extensionLane.copy(
                    notificationLedger = mapOf(key to entry.copy(disposition = disposition)),
                ),
            )
        }

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
