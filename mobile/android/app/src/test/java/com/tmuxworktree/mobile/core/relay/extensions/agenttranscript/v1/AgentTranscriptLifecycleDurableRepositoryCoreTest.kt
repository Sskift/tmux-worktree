package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineEventFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineEventRecord
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineLifecycleChangedMutation
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineLifecycleRecord
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineLifecycleScope
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineLifecycleState
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotPage
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotPageFrame
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotPagePublicFrameArtifact
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSnapshotRecord
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSourceAvailabilityMutation
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSourceAvailabilityReason
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTimelineSourceAvailabilityState
import com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1.codec.AgentTranscriptLifecycleV1Codec
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptEntryEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptEntryBatchMetadata
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptConsumerStats
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptNamespaceStats
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptPendingEventEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptPendingEventBatchMetadata
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptSnapshotRecordEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptSnapshotRecordBatchMetadata
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentTranscriptSnapshotStagingEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentLifecycleCurrentEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentLifecycleEventWitnessEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentLifecycleSqlAudit
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentNotificationLedgerEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2AgentRecentEventEvidenceEntity
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2EncodedPayload
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2SqlStats
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageJson
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageException
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentTranscriptLifecycleDurableRepositoryCoreTest {
    @Test
    fun `codec artifact feeds the typed live operation command`() {
        val codec = AgentTranscriptLifecycleV1Codec()
        val consumer = consumer()
        val namespace = AgentTranscriptLifecycleDurableNamespace(consumer, "timeline-1")
        val publicRecord = AgentTimelineEventRecord(
            agentEventSeq = "1",
            eventId = "event-1",
            occurredAtMs = 1_000,
            mutation = AgentTimelineSourceAvailabilityMutation(
                state = AgentTimelineSourceAvailabilityState.INTERRUPTED,
                sourceEpoch = "source-1",
                reason = AgentTimelineSourceAvailabilityReason.SOURCE_DISCONNECTED,
            ),
        )
        val wire = codec.encodePublicFrame(
            AgentTimelineEventFrame(
                hostId = consumer.hostId,
                hostEpoch = consumer.hostEpoch,
                scopeId = consumer.scopeId,
                sessionId = consumer.sessionId,
                timelineEpoch = "timeline-1",
                event = publicRecord,
            ),
        )
        val artifact = codec.decodePublicFrameArtifact(wire)
        val command = AgentTranscriptLifecycleDurableLiveEventCommand(
            fence = operationFence(namespace),
            artifact = artifact,
        )

        assertEquals(wire.size, artifact.rawUtf8ByteCount)
        assertEquals(publicRecord, command.frame.event)
        assertEquals(namespace, command.fence.expectedNamespace)
    }

    @Test
    fun `storage identity boundary rejects malformed and oversized UTF8`() {
        val invalid = listOf(
            "",
            " profile",
            "profile ",
            "profile\u0000id",
            "\uD800",
            "a".repeat(129),
            "界".repeat(43),
        )
        invalid.forEach { profileId ->
            assertTrue(
                runCatching { consumer(profileId = profileId) }.exceptionOrNull() is
                    IllegalArgumentException,
            )
        }

        assertEquals("a".repeat(128), consumer(profileId = "a".repeat(128)).profileId)
        assertEquals("界".repeat(42), consumer(profileId = "界".repeat(42)).profileId)
    }

    @Test
    fun `complete namespaces coexist with isolated row owned lifecycle evidence`() = runBlocking {
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
        val firstState = operationalState(firstConsumer, "timeline-a")
        val secondState = operationalState(secondConsumer, "timeline-b")

        val firstNamespace = namespace(firstConsumer, firstState)
        val secondNamespace = namespace(secondConsumer, secondState)
        repository.initializeUnderApplyLease(firstNamespace, firstState)
        repository.initializeUnderApplyLease(secondNamespace, secondState)
        consumeLive(
            repository,
            firstNamespace,
            lifecyclePublicEvent(
                sequence = "1",
                eventId = "event-first-running",
                state = AgentTimelineLifecycleState.RUNNING,
                runId = "run-first",
            ),
        )
        consumeLive(
            repository,
            firstNamespace,
            lifecyclePublicEvent(
                sequence = "2",
                eventId = "event-first-completed",
                state = AgentTimelineLifecycleState.COMPLETED,
                runId = "run-first",
            ),
        )
        consumeLive(
            repository,
            secondNamespace,
            lifecyclePublicEvent(
                sequence = "1",
                eventId = "event-second-running",
                state = AgentTimelineLifecycleState.RUNNING,
                runId = "run-second",
            ),
        )
        consumeLive(
            repository,
            secondNamespace,
            lifecyclePublicEvent(
                sequence = "2",
                eventId = "event-second-completed",
                state = AgentTimelineLifecycleState.COMPLETED,
                runId = "run-second",
            ),
        )

        assertEquals(2, store.rowCount)
        assertEquals(
            "2",
            requireNotNull(repository.load(firstConsumer)).state.extensionLane.lastAgentSeq,
        )
        assertEquals(
            "2",
            requireNotNull(repository.load(secondConsumer)).state.extensionLane.lastAgentSeq,
        )
        assertEquals(setOf("event-first-completed"), store.currentEventIds(firstNamespace))
        assertEquals(setOf("event-second-completed"), store.currentEventIds(secondNamespace))
        assertEquals(
            setOf("event-first-running", "event-first-completed"),
            store.witnessEventIds(firstNamespace),
        )
        assertEquals(
            setOf("event-second-running", "event-second-completed"),
            store.witnessEventIds(secondNamespace),
        )
        assertEquals(setOf("event-first-completed"), store.notificationEventIds(firstNamespace))
        assertEquals(setOf("event-second-completed"), store.notificationEventIds(secondNamespace))
    }

    @Test
    fun `same identity initialization is idempotent but conflicts fail closed`() = runBlocking {
        val store = MemoryStore()
        val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
        val consumer = consumer()
        val state = operationalState(consumer, "timeline-a")
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
    fun `typed live exact duplicate is zero write`() = runBlocking {
        val store = MemoryStore()
        val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
        val consumer = consumer()
        val state = operationalState(consumer, "timeline-duplicate")
        val namespace = namespace(consumer, state)
        repository.initializeUnderApplyLease(namespace, state)
        val event = lifecyclePublicEvent(
            sequence = "1",
            eventId = "event-duplicate",
            state = AgentTimelineLifecycleState.RUNNING,
        )
        assertEquals(
            AgentClientDisposition.APPLIED,
            consumeLive(repository, namespace, event).disposition,
        )
        val imageAfterFirstApply = store.durableImage()

        val duplicate = consumeLive(repository, namespace, event)

        assertEquals(AgentClientDisposition.DUPLICATE, duplicate.disposition)
        assertEquals(imageAfterFirstApply, store.durableImage())
        assertEquals("1", repository.load(consumer)?.state?.extensionLane?.lastAgentSeq)
    }

    @Test
    fun `fresh null lineage initialize and reopen uses sentinel empty audit`() = runBlocking {
        val store = MemoryStore()
        val consumer = consumer()
        val state = AgentTranscriptLifecycleClientState(consumer.sessionIdentity)
        val namespace = AgentTranscriptLifecycleDurableNamespace(consumer, null)
        val firstRepository = AgentTranscriptLifecycleDurableRepositoryCore(store)

        assertEquals(
            AgentTranscriptLifecycleInitializeDisposition.CREATED,
            firstRepository.initializeUnderApplyLease(namespace, state).disposition,
        )
        val reopened = AgentTranscriptLifecycleDurableRepositoryCore(store)
        val restored = requireNotNull(reopened.load(consumer))

        assertEquals(namespace, restored.namespace)
        assertEquals(state, restored.state)
        assertTrue(store.emptyTimelineAuditCount >= 2)
    }

    @Test
    fun `final snapshot cut is checkpoint aware for closed witnesses`() = runBlocking {
        val store = MemoryStore()
        val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
        val consumer = consumer()
        val initial = operationalState(consumer, "timeline-checkpoint", baseline = null)
        val namespace = namespace(consumer, initial)
        repository.initializeUnderApplyLease(namespace, initial)
        consumeLive(
            repository,
            namespace,
            lifecyclePublicEvent(
                sequence = "1",
                eventId = "event-checkpoint-running",
                state = AgentTimelineLifecycleState.RUNNING,
            ),
        )
        consumeLive(
            repository,
            namespace,
            lifecyclePublicEvent(
                sequence = "2",
                eventId = "event-checkpoint-waiting",
                state = AgentTimelineLifecycleState.WAITING_FOR_USER,
            ),
        )
        enterSnapshot(repository, namespace, currentAgentSeq = "4", earliestReplaySeq = "4")
        persistSnapshotRequest(
            repository,
            namespace,
            snapshotRequestId = "snapshot-checkpoint",
            pageZeroNetworkToken = "snapshot-checkpoint-page-zero",
        )
        val limits = AgentClientReducerLimits(
            maxAppliedEventEvidence = 1,
            maxEventIdentityWitnesses = 2,
        )

        val committed = consumeFinalSnapshot(
            repository = repository,
            namespace = namespace,
            requestNetworkToken = "snapshot-checkpoint-page-zero",
            snapshotRequestId = "snapshot-checkpoint",
            snapshotId = "snapshot-checkpoint-pinned",
            throughAgentSeq = "4",
            records = listOf(
                lifecycleSnapshotRecord(
                    sequence = "2",
                    eventId = "event-checkpoint-waiting",
                    state = AgentTimelineLifecycleState.WAITING_FOR_USER,
                ),
            ),
            limits = limits,
        )

        assertEquals(AgentClientDisposition.SNAPSHOT_APPLIED, committed.disposition)
        assertEquals(AgentSnapshotCheckpoint("4", "2"), committed.state.extensionLane.snapshotCheckpoint)
        assertEquals("4", committed.state.extensionLane.lastAgentSeq)
        assertEquals(
            setOf("event-checkpoint-running", "event-checkpoint-waiting"),
            store.witnessEventIds(namespace),
        )
        val imageAfterCut = store.durableImage()
        val historicalDuplicate = consumeLive(
            repository,
            namespace,
            lifecyclePublicEvent(
                sequence = "1",
                eventId = "event-checkpoint-running",
                state = AgentTimelineLifecycleState.RUNNING,
            ),
            limits,
        )
        assertEquals(AgentClientDisposition.DUPLICATE, historicalDuplicate.disposition)
        assertEquals(imageAfterCut, store.durableImage())
    }

    @Test
    fun `tampered notification generation beyond parent load fails closed without writes`() =
        runBlocking {
            val label = "next-parent-generation"
            val store = MemoryStore()
            val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
            val consumer = consumer(sessionId = "session-$label")
            val initial = operationalState(consumer, "timeline-$label")
            val namespace = namespace(consumer, initial)
            repository.initializeUnderApplyLease(namespace, initial)
            consumeLive(
                repository,
                namespace,
                lifecyclePublicEvent(
                    sequence = "1",
                    eventId = "event-$label-running",
                    state = AgentTimelineLifecycleState.RUNNING,
                ),
            )
            consumeLive(
                repository,
                namespace,
                lifecyclePublicEvent(
                    sequence = "2",
                    eventId = "event-$label-completed",
                    state = AgentTimelineLifecycleState.COMPLETED,
                ),
            )
            assertEquals(label, 1, store.notificationCount(namespace))
            store.tamperNotificationLedger(namespace) { row ->
                val payload = RelayV2StorageJson.encode(
                    1,
                    linkedMapOf(
                        "disposition" to row.disposition,
                        "localGeneration" to "3",
                    ),
                )
                row.copy(
                    localGeneration = "3",
                    ledgerCanonicalJson = payload.canonicalJson,
                    ledgerCanonicalUtf8Bytes = payload.payloadUtf8Bytes,
                    ledgerSha256 = payload.sha256,
                )
            }
            val tamperedImage = store.durableImage()

            val failure = runCatching { repository.load(consumer) }.exceptionOrNull()

            assertTrue(label, failure is RelayV2StorageException)
            assertEquals(label, tamperedImage, store.durableImage())
    }

    @Test
    fun `available status rejects every non session authority mismatch before durable writes`() =
        runBlocking {
            val expectedConsumer = consumer()
            val authorityCases = listOf(
                "old activation generation" to expectedConsumer.copy(
                    profileActivationGeneration = expectedConsumer.profileActivationGeneration - 1,
                ),
                "different principal" to expectedConsumer.copy(principalId = "principal-stale"),
                "different client instance" to expectedConsumer.copy(
                    clientInstanceId = "client-stale",
                ),
            )

            authorityCases.forEach { (label, inputAuthority) ->
                val store = MemoryStore()
                val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
                val state = operationalState(expectedConsumer, "timeline-a").let { base ->
                    base.copy(
                        extensionLane = base.extensionLane.copy(
                            pendingStatusRequest = AgentLocalRequestFence(
                                base.extensionLane.localGeneration,
                                "status-authority",
                            ),
                        ),
                    )
                }
                val namespace = namespace(expectedConsumer, state)
                repository.initializeUnderApplyLease(namespace, state)
                val writesBeforeStatus = store.writeCount

                val failure = runCatching {
                    applyControl(
                        repository,
                        namespace,
                        AgentTranscriptLifecycleClientInput.StatusAvailable(
                            authority = inputAuthority,
                            lineage = AgentTimelineLineage(
                                expectedConsumer.sessionIdentity,
                                "timeline-a",
                            ),
                            requestFence = requireNotNull(
                                state.extensionLane.pendingStatusRequest,
                            ),
                            liveSource = AgentLiveSourceState.CONNECTED,
                            activeSourceEpoch = "source-a",
                            currentAgentSeq = "2",
                            earliestReplaySeq = "1",
                            hostLimits = productionHostLimits(),
                        ),
                    )
                }.exceptionOrNull()

                assertTrue(label, failure is AgentTranscriptLifecyclePersistenceConflictException)
                assertEquals(label, writesBeforeStatus, store.writeCount)
                assertEquals(label, state, repository.load(expectedConsumer)?.state)
            }
        }

    @Test
    fun `legacy available text only cut requires fresh snapshot despite matching status cursor`() =
        runBlocking {
            val consumer = consumer()
            val legacyTextOnlyState = operationalState(consumer, "timeline-a").let { base ->
                base.copy(
                    extensionLane = base.extensionLane.copy(
                        localGeneration = "2",
                        lastAgentSeq = "2",
                        notificationBaselineAgentSeq = "2",
                        snapshotCheckpoint = AgentSnapshotCheckpoint("2", "2"),
                        snapshotNotificationSuppressedThroughAgentSeq = null,
                        pendingStatusRequest = null,
                        syncState = AgentTimelineSyncState.Current,
                    ),
                )
            }
            val namespace = namespace(consumer, legacyTextOnlyState)
            val store = MemoryStore()
            val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
            repository.initializeUnderApplyLease(namespace, legacyTextOnlyState)
            store.mutatePayload(consumer, ::encodeAsLegacyV1)

            val migrated = requireNotNull(repository.load(consumer)).state
            assertEquals("2", migrated.extensionLane.lastAgentSeq)
            assertEquals(AgentSnapshotCheckpoint("2", "2"), migrated.extensionLane.snapshotCheckpoint)
            assertEquals("2", migrated.extensionLane.notificationBaselineAgentSeq)
            assertEquals("2", migrated.extensionLane.snapshotNotificationSuppressedThroughAgentSeq)
            assertEquals(
                AgentTimelineSyncState.StatusRefresh(requireSnapshotAfterRefresh = true),
                migrated.extensionLane.syncState,
            )

            val requested = applyControl(
                repository,
                namespace,
                AgentTranscriptLifecycleClientInput.StatusRequestStarted("legacy-status"),
            ).state
            val status = applyControl(
                repository,
                namespace,
                AgentTranscriptLifecycleClientInput.StatusAvailable(
                    authority = consumer,
                    lineage = AgentTimelineLineage(consumer.sessionIdentity, "timeline-a"),
                    requestFence = requireNotNull(requested.extensionLane.pendingStatusRequest),
                    liveSource = AgentLiveSourceState.CONNECTED,
                    activeSourceEpoch = "source-a",
                    currentAgentSeq = "2",
                    earliestReplaySeq = "1",
                    hostLimits = productionHostLimits(),
                ),
            )

            assertEquals(AgentTimelineSyncState.Snapshot, status.state.extensionLane.syncState)
            assertTrue(status.syncDirective is AgentTimelineSyncDirective.Snapshot)
            assertEquals("2", status.state.extensionLane.lastAgentSeq)
        }

    @Test
    fun `integrity codec and identity corruption fail closed without repair writes`() = runBlocking {
        data class Corruption(
            val label: String,
            val expectedFailure: Class<out Throwable> = RelayV2StorageException::class.java,
            val apply: (MemoryStore, AgentTranscriptLifecycleDurableConsumerIdentity) -> Unit,
        )

        val corruptions = listOf(
            Corruption("hash") { store, consumer ->
                store.mutatePayload(consumer) { it.copy(sha256 = "0".repeat(64)) }
            },
            Corruption("codec version") { store, consumer ->
                store.mutatePayload(consumer) {
                    it.copy(
                        codecVersion = AgentTranscriptLifecycleDurableStateCodec.CODEC_VERSION + 1,
                    )
                }
            },
            Corruption("declared byte count") { store, consumer ->
                store.mutatePayload(consumer) {
                    it.copy(payloadUtf8Bytes = it.payloadUtf8Bytes + 1)
                }
            },
            Corruption("noncanonical JSON") { store, consumer ->
                store.mutatePayload(consumer) { it.withCanonicalJson(" ${it.canonicalJson}") }
            },
            Corruption("payload oversize") { store, consumer ->
                store.mutatePayload(consumer) {
                    it.copy(
                        payloadUtf8Bytes =
                            AgentTranscriptLifecycleDurableStateCodec.MAX_PAYLOAD_UTF8_BYTES + 1,
                    )
                }
            },
            Corruption("direct key limit") { store, consumer ->
                store.mutatePayload(consumer) { payload ->
                    payload.withRootMembers(
                        (0 until 62).joinToString(",") { index ->
                            "\"overflow$index\":null"
                        },
                    )
                }
            },
            Corruption("node limit") { store, consumer ->
                store.mutatePayload(consumer) { payload ->
                    payload.withRootMembers("\"overflow\":${nullArray(400_001)}")
                }
            },
            Corruption("noncanonical activation 07") { store, consumer ->
                store.mutatePayload(consumer) { it.withActivationGeneration("07") }
            },
            Corruption("noncanonical activation +7") { store, consumer ->
                store.mutatePayload(consumer) { it.withActivationGeneration("+7") }
            },
            Corruption("zero activation") { store, consumer ->
                store.mutatePayload(consumer) { it.withActivationGeneration("0") }
            },
            Corruption("overflow activation") { store, consumer ->
                store.mutatePayload(consumer) {
                    it.withActivationGeneration("9223372036854775808")
                }
            },
            Corruption("namespace identity") { store, consumer ->
                val wrongConsumer = consumer.copy(principalId = "principal-wrong")
                val wrongState = operationalState(wrongConsumer, "timeline-a")
                store.mutatePayload(consumer) {
                    AgentTranscriptLifecycleDurableStateCodec.encode(
                        namespace(wrongConsumer, wrongState),
                        wrongState,
                        AgentTranscriptDurableStorageAccounting.EMPTY,
                    )
                }
            },
            Corruption(
                "duplicate consumer row",
                AgentTranscriptLifecyclePersistenceConflictException::class.java,
            ) { store, consumer ->
                store.duplicateConsumerRow(consumer)
            },
        )

        corruptions.forEach { corruption ->
            val store = MemoryStore()
            val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
            val consumer = consumer()
            val state = operationalState(consumer, "timeline-a")
            repository.initializeUnderApplyLease(namespace(consumer, state), state)
            corruption.apply(store, consumer)
            val writesBeforeLoad = store.writeCount
            val rowsBeforeLoad = store.rowCount

            val failure = runCatching { repository.load(consumer) }.exceptionOrNull()

            assertTrue(
                corruption.label,
                corruption.expectedFailure.isInstance(failure),
            )
            assertEquals(corruption.label, writesBeforeLoad, store.writeCount)
            assertEquals(corruption.label, rowsBeforeLoad, store.rowCount)
        }
    }

    @Test
    fun `failed replacement transaction preserves cursor records and evidence together`() =
        runBlocking {
            val store = MemoryStore()
            val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
            val consumer = consumer()
            val initial = operationalState(consumer, "timeline-atomic")
            val namespace = namespace(consumer, initial)
            repository.initializeUnderApplyLease(namespace, initial)
            assertEquals(
                AgentClientDisposition.APPLIED,
                consumeLive(
                    repository,
                    namespace,
                    lifecyclePublicEvent(
                        sequence = "1",
                        eventId = "event-atomic-running",
                        state = AgentTimelineLifecycleState.RUNNING,
                    ),
                ).disposition,
            )
            val beforeFailure = store.durableImage()
            store.failNextCompareAndSet = true

            val failure = runCatching {
                consumeLive(
                    repository,
                    namespace,
                    lifecyclePublicEvent(
                        sequence = "2",
                        eventId = "event-atomic-waiting",
                        state = AgentTimelineLifecycleState.WAITING_FOR_USER,
                    ),
                )
            }.exceptionOrNull()

            assertTrue(failure is IllegalStateException)
            val restored = requireNotNull(repository.load(consumer)).state
            assertEquals(beforeFailure, store.durableImage())
            assertEquals("1", restored.extensionLane.lastAgentSeq)
            assertEquals(setOf("event-atomic-running"), store.witnessEventIds(namespace))
        }

    @Test
    fun `notification claim is one shot and returns only post commit authority`() = runBlocking {
        val store = MemoryStore()
        val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
        val fixture = createNotificationFixture(repository, store)

        val claimed = repository.claimNotificationUnderApplyLease(
            fixture.namespace,
            fixture.intent,
        ) as AgentTranscriptLifecycleNotificationClaimResult.Claimed

        assertEquals(fixture.namespace, claimed.ticket.namespace)
        assertEquals(fixture.intent, claimed.ticket.intent)
        assertEquals(64, claimed.ticket.claimId.length)
        assertEquals(1, store.claimCount)
        val writesAfterClaim = store.writeCount
        assertEquals(
            AgentTranscriptLifecycleNotificationClaimResult.NotExecutable(
                AgentTranscriptLifecycleNotificationNotExecutableReason.ALREADY_CLAIMED,
            ),
            repository.claimNotificationUnderApplyLease(fixture.namespace, fixture.intent),
        )
        assertEquals(writesAfterClaim, store.writeCount)
        assertEquals(1, store.claimCount)
    }

    @Test
    fun `alternate state and multiple event claims fail closed without overwrite`() = runBlocking {
        listOf("alternate-state", "multiple-rows").forEach { label ->
            val store = MemoryStore()
            val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
            val fixture = createNotificationFixture(repository, store, sessionId = "session-$label")
            val exactKey = claimKey(fixture.namespace, fixture.intent)
            val alternateIntent = fixture.intent.copy(
                dedupeKey = fixture.intent.dedupeKey.copy(
                    state = AgentLifecycleState.WAITING_FOR_USER,
                ),
            )
            val alternateClaim = persistedClaim(
                claimKey(fixture.namespace, alternateIntent),
                alternateIntent,
            )
            val existingClaims = if (label == "alternate-state") {
                listOf(alternateClaim)
            } else {
                listOf(persistedClaim(exactKey, fixture.intent), alternateClaim)
            }
            existingClaims.forEach(store::putClaimUnchecked)
            val imageBeforeClaim = store.durableImage()

            val failure = runCatching {
                repository.claimNotificationUnderApplyLease(fixture.namespace, fixture.intent)
            }.exceptionOrNull()

            assertTrue(label, failure is AgentTranscriptLifecyclePersistenceConflictException)
            assertEquals(label, imageBeforeClaim, store.durableImage())
            assertEquals(label, existingClaims.size, store.claimCount)
        }
    }

    @Test
    fun `corrupt claim payload hash and identity fail closed without overwrite`() = runBlocking {
        val labels = listOf(
            "payload",
            "declared byte count",
            "hash",
            "codec version",
            "identity",
            "noncanonical activation identity 07",
            "noncanonical activation identity +7",
            "zero activation identity",
            "overflow activation identity",
        )

        labels.forEach { label ->
            val store = MemoryStore()
            val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
            val fixture = createNotificationFixture(repository, store, sessionId = "session-claim-corrupt")
            val key = claimKey(fixture.namespace, fixture.intent)
            assertTrue(
                repository.claimNotificationUnderApplyLease(fixture.namespace, fixture.intent) is
                    AgentTranscriptLifecycleNotificationClaimResult.Claimed,
            )
            store.mutateClaimPayload(key) { payload ->
                when (label) {
                    "payload" -> payload.withCanonicalJson("{}")
                    "declared byte count" -> payload.copy(
                        payloadUtf8Bytes = payload.payloadUtf8Bytes + 1,
                    )
                    "hash" -> payload.copy(sha256 = "0".repeat(64))
                    "codec version" -> payload.copy(
                        codecVersion =
                            AgentTranscriptLifecycleNotificationClaimCodec.CODEC_VERSION + 1,
                    )
                    "identity" -> AgentTranscriptLifecycleNotificationClaimCodec.encode(
                        key.copy(consumer = key.consumer.copy(principalId = "principal-wrong")),
                        fixture.intent,
                    )
                    "noncanonical activation identity 07" ->
                        payload.withActivationGeneration("07")
                    "noncanonical activation identity +7" ->
                        payload.withActivationGeneration("+7")
                    "zero activation identity" -> payload.withActivationGeneration("0")
                    "overflow activation identity" ->
                        payload.withActivationGeneration("9223372036854775808")
                    else -> error("unhandled corruption")
                }
            }
            val imageBeforeRead = store.durableImage()

            val failure = runCatching {
                repository.claimNotificationUnderApplyLease(fixture.namespace, fixture.intent)
            }.exceptionOrNull()

            assertTrue(label, failure is RelayV2StorageException)
            assertEquals(label, imageBeforeRead, store.durableImage())
            assertEquals(label, 1, store.claimCount)
        }
    }

    @Test
    fun `stale lineage generation source and notification config never create claims`() =
        runBlocking {
            val labels = listOf(
                "old-generation",
                "old-timeline",
                "inactive-profile",
                "permission-denied",
                "policy-suppress",
                "source-interrupted",
                "not-shown",
            )
            labels.forEach { label ->
                val store = MemoryStore()
                val repository = AgentTranscriptLifecycleDurableRepositoryCore(store)
                val initialConfig = if (label == "not-shown") {
                    AgentNotificationConfig(
                        permission = AgentNotificationPermission.GRANTED,
                        profileActive = true,
                        policy = AgentNotificationPolicy.SUPPRESS,
                    )
                } else {
                    enabledNotificationConfig()
                }
                val fixture = createNotificationFixture(
                    repository,
                    store,
                    sessionId = "session-$label",
                    notificationConfig = initialConfig,
                    requireExecutableIntent = label != "not-shown",
                )
                val intent = when (label) {
                    "old-generation" -> {
                        applyControl(
                            repository,
                            fixture.namespace,
                            AgentTranscriptLifecycleClientInput.ClientConfigChanged(
                                enabledNotificationConfig().copy(
                                    policy = AgentNotificationPolicy.SUPPRESS,
                                ),
                            ),
                        )
                        applyControl(
                            repository,
                            fixture.namespace,
                            AgentTranscriptLifecycleClientInput.ClientConfigChanged(
                                enabledNotificationConfig(),
                            ),
                        )
                        fixture.intent
                    }
                    "old-timeline" -> fixture.intent.copy(
                        dedupeKey = fixture.intent.dedupeKey.copy(
                            timelineEpoch = "timeline-old",
                        ),
                    )
                    "inactive-profile" -> {
                        applyControl(
                            repository,
                            fixture.namespace,
                            AgentTranscriptLifecycleClientInput.ClientConfigChanged(
                                enabledNotificationConfig().copy(profileActive = false),
                            ),
                        )
                        fixture.intent
                    }
                    "permission-denied" -> {
                        applyControl(
                            repository,
                            fixture.namespace,
                            AgentTranscriptLifecycleClientInput.ClientConfigChanged(
                                enabledNotificationConfig().copy(
                                    permission = AgentNotificationPermission.DENIED,
                                ),
                            ),
                        )
                        fixture.intent
                    }
                    "policy-suppress" -> {
                        applyControl(
                            repository,
                            fixture.namespace,
                            AgentTranscriptLifecycleClientInput.ClientConfigChanged(
                                enabledNotificationConfig().copy(
                                    policy = AgentNotificationPolicy.SUPPRESS,
                                ),
                            ),
                        )
                        fixture.intent
                    }
                    "source-interrupted" -> {
                        consumeLive(
                            repository,
                            fixture.namespace,
                            sourceAvailabilityPublicEvent(sequence = "3"),
                        )
                        fixture.intent
                    }
                    "not-shown" -> fixture.intent
                    else -> error("unhandled stale case")
                }

                assertEquals(
                    label,
                    AgentTranscriptLifecycleNotificationClaimResult.NotExecutable(
                        AgentTranscriptLifecycleNotificationNotExecutableReason.INTENT_NOT_CURRENT,
                    ),
                    repository.claimNotificationUnderApplyLease(fixture.namespace, intent),
                )
                assertEquals(label, 0, store.claimCount)
            }

            val activationStore = MemoryStore()
            val activationRepository = AgentTranscriptLifecycleDurableRepositoryCore(activationStore)
            val fixture = createNotificationFixture(
                activationRepository,
                activationStore,
                sessionId = "session-activation",
            )
            val wrongActivation = fixture.namespace.copy(
                consumer = fixture.namespace.consumer.copy(profileActivationGeneration = 8),
            )
            assertEquals(
                AgentTranscriptLifecycleNotificationClaimResult.NotExecutable(
                    AgentTranscriptLifecycleNotificationNotExecutableReason.STATE_MISSING,
                ),
                activationRepository.claimNotificationUnderApplyLease(
                    wrongActivation,
                    fixture.intent,
                ),
            )
            assertEquals(0, activationStore.claimCount)
        }

    @Test
    fun `corrupt state and failed claim commit cannot emit or persist a ticket`() = runBlocking {
        val corruptStore = MemoryStore()
        val corruptRepository = AgentTranscriptLifecycleDurableRepositoryCore(corruptStore)
        val corruptFixture = createNotificationFixture(
            corruptRepository,
            corruptStore,
            sessionId = "session-corrupt-state",
        )
        corruptStore.mutatePayload(corruptFixture.namespace.consumer) {
            it.copy(sha256 = "0".repeat(64))
        }
        val corrupt = runCatching {
            corruptRepository.claimNotificationUnderApplyLease(
                corruptFixture.namespace,
                corruptFixture.intent,
            )
        }.exceptionOrNull()
        assertTrue(corrupt is RelayV2StorageException)
        assertEquals(0, corruptStore.claimCount)

        val failingStore = MemoryStore()
        val failingRepository = AgentTranscriptLifecycleDurableRepositoryCore(failingStore)
        val failingFixture = createNotificationFixture(
            failingRepository,
            failingStore,
            sessionId = "session-failed-claim-cas",
        )
        val failingImage = failingStore.durableImage()
        failingStore.failNextClaimInsert = true
        val failedCas = runCatching {
            failingRepository.claimNotificationUnderApplyLease(
                failingFixture.namespace,
                failingFixture.intent,
            )
        }.exceptionOrNull()
        assertTrue(failedCas is IllegalStateException)
        assertEquals(0, failingStore.claimCount)
        assertEquals(failingImage, failingStore.durableImage())

        val commitStore = MemoryStore()
        val commitRepository = AgentTranscriptLifecycleDurableRepositoryCore(commitStore)
        val commitFixture = createNotificationFixture(
            commitRepository,
            commitStore,
            sessionId = "session-failed-claim-commit",
        )
        val imageBeforeCommit = commitStore.durableImage()
        commitStore.failCommitAfterBlock = true

        val failedCommit = runCatching {
            commitRepository.claimNotificationUnderApplyLease(
                commitFixture.namespace,
                commitFixture.intent,
            )
        }

        assertTrue(failedCommit.exceptionOrNull() is IllegalStateException)
        assertTrue(failedCommit.getOrNull() == null)
        assertEquals(1, commitStore.claimCountBeforeFailedCommit)
        assertEquals(0, commitStore.claimCount)
        assertEquals(imageBeforeCommit, commitStore.durableImage())
    }

    private class MemoryStore :
        AgentTranscriptLifecycleDurableStore,
        AgentTranscriptLifecycleDurableTransaction {
        private var rows = mutableListOf<AgentTranscriptLifecyclePersistedState>()
        private var entries = mutableListOf<RelayV2AgentTranscriptEntryEntity>()
        private var snapshots = mutableListOf<RelayV2AgentTranscriptSnapshotStagingEntity>()
        private var snapshotRecords = mutableListOf<RelayV2AgentTranscriptSnapshotRecordEntity>()
        private var pendingEvents = mutableListOf<RelayV2AgentTranscriptPendingEventEntity>()
        private var lifecycleCurrent = mutableListOf<RelayV2AgentLifecycleCurrentEntity>()
        private var lifecycleWitnesses = mutableListOf<RelayV2AgentLifecycleEventWitnessEntity>()
        private var recentEvidence = mutableListOf<RelayV2AgentRecentEventEvidenceEntity>()
        private var notificationLedger = mutableListOf<RelayV2AgentNotificationLedgerEntity>()
        private var claims = linkedMapOf<
            AgentTranscriptLifecycleNotificationClaimKey,
            AgentTranscriptLifecyclePersistedNotificationClaim
            >()
        var failNextCompareAndSet = false
        var failNextClaimInsert = false
        var failCommitAfterBlock = false
        var emptyTimelineAuditCount = 0
            private set
        var claimCountBeforeFailedCommit: Int? = null
            private set
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
            val entriesBefore = entries.toMutableList()
            val snapshotsBefore = snapshots.toMutableList()
            val snapshotRecordsBefore = snapshotRecords.toMutableList()
            val pendingEventsBefore = pendingEvents.toMutableList()
            val lifecycleCurrentBefore = lifecycleCurrent.toMutableList()
            val lifecycleWitnessesBefore = lifecycleWitnesses.toMutableList()
            val recentEvidenceBefore = recentEvidence.toMutableList()
            val notificationLedgerBefore = notificationLedger.toMutableList()
            val claimsBefore = LinkedHashMap(claims)
            val writesBefore = writeCount
            return try {
                val result = block(this)
                if (failCommitAfterBlock) {
                    failCommitAfterBlock = false
                    claimCountBeforeFailedCommit = claims.size
                    error("injected commit failure after transaction block")
                }
                result
            } catch (failure: Throwable) {
                rows = rowsBefore
                entries = entriesBefore
                snapshots = snapshotsBefore
                snapshotRecords = snapshotRecordsBefore
                pendingEvents = pendingEventsBefore
                lifecycleCurrent = lifecycleCurrentBefore
                lifecycleWitnesses = lifecycleWitnessesBefore
                recentEvidence = recentEvidenceBefore
                notificationLedger = notificationLedgerBefore
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

        override fun stateCount(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
        ): Long = rows.count { it.namespace.consumer == consumer }.toLong()

        override fun compareAndSetState(
            expected: AgentTranscriptLifecyclePersistedState,
            next: AgentTranscriptLifecyclePersistedState,
        ): Int {
            if (failNextCompareAndSet) {
                failNextCompareAndSet = false
                error("injected state CAS failure")
            }
            val index = rows.indexOf(expected)
            if (index < 0) return 0
            check(rows.none { it !== rows[index] && it.namespace.consumer == next.namespace.consumer })
            rows[index] = next
            writeCount += 1
            return 1
        }

        override fun deleteStateForTimelineRotation(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ): Int {
            val index = rows.indexOfFirst { it.namespace == namespace }
            if (index < 0) return 0
            rows.removeAt(index)
            entries.removeAll { it.belongsTo(namespace) }
            snapshots.removeAll { it.belongsTo(namespace) }
            snapshotRecords.removeAll { it.belongsTo(namespace) }
            pendingEvents.removeAll { it.belongsTo(namespace) }
            lifecycleCurrent.removeAll { it.belongsTo(namespace) }
            lifecycleWitnesses.removeAll { it.belongsTo(namespace) }
            recentEvidence.removeAll { it.belongsTo(namespace) }
            notificationLedger.removeAll { it.belongsTo(namespace) }
            claims.entries.removeAll { it.key.consumer == namespace.consumer &&
                it.key.timelineEpoch == namespace.timelineEpoch }
            writeCount += 1
            return 1
        }

        override fun insertState(state: AgentTranscriptLifecyclePersistedState) {
            check(rows.none { it.namespace.consumer == state.namespace.consumer })
            rows += state
            writeCount += 1
        }

        override fun transcriptNamespaceStats(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ): RelayV2AgentTranscriptNamespaceStats {
            check(namespace.timelineEpoch != null) {
                "normal transcript namespace cannot address the null-lineage sentinel"
            }
            return namespaceStats(
                entries.filter { it.belongsTo(namespace) },
                snapshots.filter { it.belongsTo(namespace) },
                snapshotRecords.filter { it.belongsTo(namespace) },
                pendingEvents.filter { it.belongsTo(namespace) },
            )
        }

        override fun emptyTimelineNamespaceStats(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
        ): RelayV2AgentTranscriptNamespaceStats {
            emptyTimelineAuditCount += 1
            return namespaceStats(
                entries.filter { it.belongsTo(consumer, "") },
                snapshots.filter { it.belongsTo(consumer, "") },
                snapshotRecords.filter { it.belongsTo(consumer, "") },
                pendingEvents.filter { it.belongsTo(consumer, "") },
            )
        }

        override fun transcriptConsumerStats(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
        ): RelayV2AgentTranscriptConsumerStats = RelayV2AgentTranscriptConsumerStats(
            entryCount = entries.count { it.belongsTo(consumer) }.toLong(),
            snapshotCount = snapshots.count { it.belongsTo(consumer) }.toLong(),
            snapshotRecordCount = snapshotRecords.count { it.belongsTo(consumer) }.toLong(),
            pendingEventCount = pendingEvents.count { it.belongsTo(consumer) }.toLong(),
        )

        override fun entryCount(namespace: AgentTranscriptLifecycleDurableNamespace): Long =
            entries.count { it.belongsTo(namespace) }.toLong()

        override fun entryBatchMetadata(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            afterCreatedAgentSeqOrder: String?,
            afterEntryId: String?,
            limit: Int,
        ): List<RelayV2AgentTranscriptEntryBatchMetadata> = selectedEntries(
            namespace, afterCreatedAgentSeqOrder, afterEntryId, limit,
        ).map { row ->
            RelayV2AgentTranscriptEntryBatchMetadata(
                row.createdAgentSeq,
                row.createdAgentSeqOrder,
                row.entryId,
                row.payloadUtf8Bytes,
                row.payloadCanonicalJson.utf8Bytes(),
                row.text?.utf8Bytes() ?: 0,
            )
        }

        override fun entries(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            afterCreatedAgentSeqOrder: String?,
            afterEntryId: String?,
            limit: Int,
        ): List<RelayV2AgentTranscriptEntryEntity> = selectedEntries(
            namespace, afterCreatedAgentSeqOrder, afterEntryId, limit,
        )

        override fun insertEntry(entry: RelayV2AgentTranscriptEntryEntity) {
            check(entries.none { it.belongsToEntry(entry) })
            entries += entry
            writeCount += 1
        }

        override fun entryById(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            entryId: String,
        ): RelayV2AgentTranscriptEntryEntity? = entries.singleOrNull {
            it.belongsTo(namespace) && it.entryId == entryId
        }

        override fun compareAndSetEntry(
            expected: RelayV2AgentTranscriptEntryEntity,
            next: RelayV2AgentTranscriptEntryEntity,
        ): Int = replaceExact(entries, expected, next)

        override fun deleteEntries(namespace: AgentTranscriptLifecycleDurableNamespace): Int =
            removeMatching(entries) { it.belongsTo(namespace) }

        override fun snapshotCount(namespace: AgentTranscriptLifecycleDurableNamespace): Long =
            snapshots.count { it.belongsTo(namespace) }.toLong()

        override fun snapshots(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ): List<RelayV2AgentTranscriptSnapshotStagingEntity> = snapshots.filter {
            it.belongsTo(namespace)
        }.sortedBy { it.snapshotId }

        override fun insertSnapshot(snapshot: RelayV2AgentTranscriptSnapshotStagingEntity) {
            check(snapshots.none { it.belongsTo(namespaceOf(snapshot)) })
            snapshots += snapshot
            writeCount += 1
        }

        override fun compareAndSetSnapshot(
            expected: RelayV2AgentTranscriptSnapshotStagingEntity,
            next: RelayV2AgentTranscriptSnapshotStagingEntity,
        ): Int = replaceExact(snapshots, expected, next)

        override fun deleteSnapshot(snapshot: RelayV2AgentTranscriptSnapshotStagingEntity): Int {
            val snapshotNamespace = namespaceOf(snapshot)
            val index = snapshots.indexOfFirst {
                it.belongsTo(snapshotNamespace) && it.snapshotId == snapshot.snapshotId
            }
            if (index < 0) return 0
            val stored = snapshots.removeAt(index)
            snapshotRecords.removeAll { it.belongsToSnapshot(stored) }
            writeCount += 1
            return 1
        }

        override fun snapshotRecordCount(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            snapshotId: String,
        ): Long = snapshotRecords.count {
            it.belongsTo(namespace) && it.snapshotId == snapshotId
        }.toLong()

        override fun snapshotRecordBatchMetadata(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            snapshotId: String,
            afterRecordIndex: Long,
            limit: Int,
        ): List<RelayV2AgentTranscriptSnapshotRecordBatchMetadata> = snapshotRecords(
            namespace, snapshotId, afterRecordIndex, limit,
        ).map { row ->
            RelayV2AgentTranscriptSnapshotRecordBatchMetadata(
                row.recordIndex,
                row.pageIndex,
                row.payloadRawUtf8Bytes,
                row.payloadCanonicalJson.utf8Bytes(),
            )
        }

        override fun snapshotRecords(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            snapshotId: String,
            afterRecordIndex: Long,
            limit: Int,
        ): List<RelayV2AgentTranscriptSnapshotRecordEntity> = snapshotRecords.filter {
            it.belongsTo(namespace) && it.snapshotId == snapshotId &&
                it.recordIndex > afterRecordIndex
        }.sortedBy { it.recordIndex }.take(limit)

        override fun snapshotRecordsByStableIdentity(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            snapshotId: String,
            stableIdentity: String,
        ): List<RelayV2AgentTranscriptSnapshotRecordEntity> = snapshotRecords.filter {
            it.belongsTo(namespace) && it.snapshotId == snapshotId &&
                it.stableIdentity == stableIdentity
        }

        override fun insertSnapshotRecords(
            records: List<RelayV2AgentTranscriptSnapshotRecordEntity>,
        ) {
            records.forEach { row ->
                check(snapshotRecords.none {
                    it.belongsTo(namespaceOf(row)) && it.snapshotId == row.snapshotId &&
                        (it.recordIndex == row.recordIndex ||
                            it.stableIdentity == row.stableIdentity ||
                            it.agentEventSeqOrder == row.agentEventSeqOrder)
                })
                snapshotRecords += row
            }
            if (records.isNotEmpty()) writeCount += 1
        }

        override fun pendingEventCount(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ): Long = pendingEvents.count { it.belongsTo(namespace) }.toLong()

        override fun pendingEventBatchMetadata(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            afterAgentEventSeqOrder: String?,
            limit: Int,
        ): List<RelayV2AgentTranscriptPendingEventBatchMetadata> = pendingEvents(
            namespace, afterAgentEventSeqOrder, limit,
        ).map { row ->
            RelayV2AgentTranscriptPendingEventBatchMetadata(
                row.agentEventSeq,
                row.agentEventSeqOrder,
                row.eventId,
                row.eventRawUtf8Bytes,
                row.eventCanonicalJson.utf8Bytes(),
            )
        }

        override fun pendingEvents(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            afterAgentEventSeqOrder: String?,
            limit: Int,
        ): List<RelayV2AgentTranscriptPendingEventEntity> = pendingEvents.filter {
            it.belongsTo(namespace) &&
                (afterAgentEventSeqOrder == null ||
                    it.agentEventSeqOrder > afterAgentEventSeqOrder)
        }.sortedBy { it.agentEventSeqOrder }.take(limit)

        override fun insertPendingEvent(event: RelayV2AgentTranscriptPendingEventEntity) {
            check(pendingEvents.none { it.belongsTo(namespaceOf(event)) &&
                (it.agentEventSeq == event.agentEventSeq || it.eventId == event.eventId) })
            pendingEvents += event
            writeCount += 1
        }

        override fun pendingEventBySeq(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            agentEventSeq: String,
        ): RelayV2AgentTranscriptPendingEventEntity? = pendingEvents.singleOrNull {
            it.belongsTo(namespace) && it.agentEventSeq == agentEventSeq
        }

        override fun pendingEventByEventId(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            eventId: String,
        ): RelayV2AgentTranscriptPendingEventEntity? = pendingEvents.singleOrNull {
            it.belongsTo(namespace) && it.eventId == eventId
        }

        override fun deletePendingEvent(event: RelayV2AgentTranscriptPendingEventEntity): Int =
            removeExact(pendingEvents, event)

        override fun deletePendingEvents(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ): Int = removeMatching(pendingEvents) { it.belongsTo(namespace) }

        override fun lifecycleCurrentStats(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ): RelayV2SqlStats = RelayV2SqlStats(
            lifecycleCurrent.count { it.belongsTo(namespace) }.toLong(),
            0,
        )

        override fun lifecycleWitnessAudit(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ): RelayV2AgentLifecycleSqlAudit = lifecycleAudit(
            lifecycleWitnesses.filter { it.belongsTo(namespace) }
                .map { it.witnessCanonicalUtf8Bytes to it.witnessCanonicalJson },
        )

        override fun recentEvidenceAudit(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ): RelayV2AgentLifecycleSqlAudit = lifecycleAudit(
            recentEvidence.filter { it.belongsTo(namespace) }
                .map { it.evidenceCanonicalUtf8Bytes to it.evidenceCanonicalJson },
        )

        override fun notificationLedgerAudit(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ): RelayV2AgentLifecycleSqlAudit = lifecycleAudit(
            notificationLedger.filter { it.belongsTo(namespace) }
                .map { it.ledgerCanonicalUtf8Bytes to it.ledgerCanonicalJson },
        )

        override fun lifecycleCurrentPage(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            afterAgentEventSeqOrder: String,
            afterEventId: String,
            limit: Int,
        ): List<RelayV2AgentLifecycleCurrentEntity> = lifecycleCurrent.filter {
            it.belongsTo(namespace) && afterPair(
                it.agentEventSeqOrder, it.lifecycleEventId,
                afterAgentEventSeqOrder, afterEventId,
            )
        }.sortedWith(compareBy({ it.agentEventSeqOrder }, { it.lifecycleEventId })).take(limit)

        override fun lifecycleWitnessPage(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            afterAgentEventSeqOrder: String,
            afterEventId: String,
            limit: Int,
        ): List<RelayV2AgentLifecycleEventWitnessEntity> = lifecycleWitnesses.filter {
            it.belongsTo(namespace) && afterPair(
                it.agentEventSeqOrder, it.eventId,
                afterAgentEventSeqOrder, afterEventId,
            )
        }.sortedWith(compareBy({ it.agentEventSeqOrder }, { it.eventId })).take(limit)

        override fun lifecycleWitnessIdentityAuditPage(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            afterLifecycleScope: String,
            afterRunId: String,
            afterTurnIdKey: String,
            afterAgentEventSeqOrder: String,
            afterEventId: String,
            limit: Int,
        ): List<RelayV2AgentLifecycleEventWitnessEntity> {
            val after = listOf(
                afterLifecycleScope, afterRunId, afterTurnIdKey,
                afterAgentEventSeqOrder, afterEventId,
            )
            return lifecycleWitnesses.filter {
                it.belongsTo(namespace) && listOf(
                    it.lifecycleScope, it.runId, it.turnIdKey,
                    it.agentEventSeqOrder, it.eventId,
                ).lexicographicallyAfter(after)
            }.sortedWith(compareBy(
                { it.lifecycleScope }, { it.runId }, { it.turnIdKey },
                { it.agentEventSeqOrder }, { it.eventId },
            )).take(limit)
        }

        override fun recentEvidencePage(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            afterAgentEventSeqOrder: String,
            afterEventId: String,
            limit: Int,
        ): List<RelayV2AgentRecentEventEvidenceEntity> = recentEvidence.filter {
            it.belongsTo(namespace) && afterPair(
                it.agentEventSeqOrder, it.eventId,
                afterAgentEventSeqOrder, afterEventId,
            )
        }.sortedWith(compareBy({ it.agentEventSeqOrder }, { it.eventId })).take(limit)

        override fun notificationLedgerPage(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            afterAgentEventSeqOrder: String,
            afterEventId: String,
            afterState: String,
            limit: Int,
        ): List<RelayV2AgentNotificationLedgerEntity> {
            val after = listOf(afterAgentEventSeqOrder, afterEventId, afterState)
            return notificationLedger.filter {
                it.belongsTo(namespace) && listOf(
                    it.agentEventSeqOrder, it.lifecycleEventId, it.lifecycleState,
                ).lexicographicallyAfter(after)
            }.sortedWith(compareBy(
                { it.agentEventSeqOrder }, { it.lifecycleEventId }, { it.lifecycleState },
            )).take(limit)
        }

        override fun lifecycleCurrentByIdentity(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            identity: AgentLifecycleIdentity,
        ): RelayV2AgentLifecycleCurrentEntity? = lifecycleCurrent.singleOrNull {
            it.belongsTo(namespace) && it.lifecycleScope == identity.scope.name &&
                it.runId == identity.runId && it.turnIdKey == (identity.turnId ?: "")
        }

        override fun lifecycleCurrentByEventId(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            eventId: String,
        ): RelayV2AgentLifecycleCurrentEntity? = lifecycleCurrent.singleOrNull {
            it.belongsTo(namespace) && it.lifecycleEventId == eventId
        }

        override fun lifecycleCurrentByAgentEventSeq(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            agentEventSeq: String,
        ): RelayV2AgentLifecycleCurrentEntity? = lifecycleCurrent.singleOrNull {
            it.belongsTo(namespace) && it.agentEventSeq == agentEventSeq
        }

        override fun currentRun(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            runId: String,
        ): RelayV2AgentLifecycleEventWitnessEntity? = currentWitnesses(namespace).singleOrNull {
            it.lifecycleScope == AgentLifecycleScope.RUN.name && it.runId == runId
        }

        override fun currentNonterminalTurnsForRun(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            runId: String,
        ): List<RelayV2AgentLifecycleEventWitnessEntity> = currentWitnesses(namespace).filter {
            it.lifecycleScope == AgentLifecycleScope.TURN.name && it.runId == runId &&
                it.lifecycleState !in setOf(
                    AgentLifecycleState.FAILED.name,
                    AgentLifecycleState.COMPLETED.name,
                )
        }

        override fun currentRunSourceEpochs(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            runId: String,
        ): List<String> = currentWitnesses(namespace).filter {
            it.runId == runId
        }.map { it.sourceEpoch }.distinct()

        override fun terminalRunEvidence(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            runId: String,
        ): List<RelayV2AgentLifecycleEventWitnessEntity> = lifecycleWitnesses.filter {
            it.belongsTo(namespace) && it.lifecycleScope == AgentLifecycleScope.RUN.name &&
                it.runId == runId && it.lifecycleState in setOf(
                    AgentLifecycleState.FAILED.name,
                    AgentLifecycleState.COMPLETED.name,
                )
        }.sortedBy { it.agentEventSeqOrder }

        override fun witnessByEventId(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            eventId: String,
        ): RelayV2AgentLifecycleEventWitnessEntity? = lifecycleWitnesses.singleOrNull {
            it.belongsTo(namespace) && it.eventId == eventId
        }

        override fun witnessByAgentEventSeq(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            agentEventSeq: String,
        ): RelayV2AgentLifecycleEventWitnessEntity? = lifecycleWitnesses.singleOrNull {
            it.belongsTo(namespace) && it.agentEventSeq == agentEventSeq
        }

        override fun highestWitnessForIdentity(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            identity: AgentLifecycleIdentity,
        ): RelayV2AgentLifecycleEventWitnessEntity? = lifecycleWitnesses.filter {
            it.belongsTo(namespace) && it.lifecycleScope == identity.scope.name &&
                it.runId == identity.runId && it.turnIdKey == (identity.turnId ?: "")
        }.maxByOrNull { it.agentEventSeqOrder }

        override fun hasPermanentTurnEvidence(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            runId: String,
        ): Boolean = lifecycleWitnesses.any {
            it.belongsTo(namespace) && it.lifecycleScope == AgentLifecycleScope.TURN.name &&
                it.runId == runId
        }

        override fun recentEvidenceByEventId(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            eventId: String,
        ): RelayV2AgentRecentEventEvidenceEntity? = recentEvidence.singleOrNull {
            it.belongsTo(namespace) && it.eventId == eventId
        }

        override fun recentEvidenceByAgentEventSeq(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            agentEventSeq: String,
        ): RelayV2AgentRecentEventEvidenceEntity? = recentEvidence.singleOrNull {
            it.belongsTo(namespace) && it.agentEventSeq == agentEventSeq
        }

        override fun notificationByLifecycleEventId(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            eventId: String,
        ): RelayV2AgentNotificationLedgerEntity? = notificationLedger.singleOrNull {
            it.belongsTo(namespace) && it.lifecycleEventId == eventId
        }

        override fun notificationByDedupeKey(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            eventId: String,
            state: AgentLifecycleState,
        ): RelayV2AgentNotificationLedgerEntity? = notificationLedger.singleOrNull {
            it.belongsTo(namespace) && it.lifecycleEventId == eventId &&
                it.lifecycleState == state.name
        }

        override fun insertLifecycleWitnesses(rows: List<RelayV2AgentLifecycleEventWitnessEntity>) {
            rows.forEach { row ->
                check(lifecycleWitnesses.none { it.belongsTo(namespaceOf(row)) &&
                    (it.eventId == row.eventId || it.agentEventSeq == row.agentEventSeq) })
                lifecycleWitnesses += row
            }
            if (rows.isNotEmpty()) writeCount += 1
        }

        override fun insertLifecycleCurrent(rows: List<RelayV2AgentLifecycleCurrentEntity>) {
            rows.forEach { row ->
                check(lifecycleCurrent.none { it.belongsTo(namespaceOf(row)) &&
                    (it.lifecycleEventId == row.lifecycleEventId ||
                        it.agentEventSeq == row.agentEventSeq ||
                        it.lifecycleScope == row.lifecycleScope && it.runId == row.runId &&
                            it.turnIdKey == row.turnIdKey) })
                lifecycleCurrent += row
            }
            if (rows.isNotEmpty()) writeCount += 1
        }

        override fun updateLifecycleCurrentExact(
            expected: RelayV2AgentLifecycleCurrentEntity,
            next: RelayV2AgentLifecycleCurrentEntity,
        ): Int = replaceExact(lifecycleCurrent, expected, next)

        override fun deleteLifecycleCurrentExact(
            expected: RelayV2AgentLifecycleCurrentEntity,
        ): Int = removeExact(lifecycleCurrent, expected)

        override fun insertRecentEvidence(rows: List<RelayV2AgentRecentEventEvidenceEntity>) {
            rows.forEach { row ->
                check(recentEvidence.none { it.belongsTo(namespaceOf(row)) &&
                    (it.eventId == row.eventId || it.agentEventSeq == row.agentEventSeq) })
                recentEvidence += row
            }
            if (rows.isNotEmpty()) writeCount += 1
        }

        override fun deleteRecentEvidenceExact(
            expected: RelayV2AgentRecentEventEvidenceEntity,
        ): Int = removeExact(recentEvidence, expected)

        override fun deleteRecentEvidenceThroughBatch(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            throughAgentEventSeqOrder: String,
            limit: Int,
        ): Int {
            val selected = recentEvidence.filter {
                it.belongsTo(namespace) && it.agentEventSeqOrder <= throughAgentEventSeqOrder
            }.sortedBy { it.agentEventSeqOrder }.take(limit).toSet()
            return removeMatching(recentEvidence) { it in selected }
        }

        override fun insertNotificationLedger(rows: List<RelayV2AgentNotificationLedgerEntity>) {
            rows.forEach { row ->
                check(notificationLedger.none { it.belongsTo(namespaceOf(row)) &&
                    it.lifecycleEventId == row.lifecycleEventId &&
                    it.lifecycleState == row.lifecycleState })
                notificationLedger += row
            }
            if (rows.isNotEmpty()) writeCount += 1
        }

        override fun deleteNotificationLedgerExact(
            expected: RelayV2AgentNotificationLedgerEntity,
        ): Int = removeExact(notificationLedger, expected)

        override fun notificationClaims(
            eventIdentity: AgentTranscriptLifecycleNotificationClaimEventIdentity,
        ): List<AgentTranscriptLifecyclePersistedNotificationClaim> = claims.values.filter {
            it.key.eventIdentity == eventIdentity
        }

        override fun insertNotificationClaim(
            claim: AgentTranscriptLifecyclePersistedNotificationClaim,
        ) {
            if (failNextClaimInsert) {
                failNextClaimInsert = false
                error("injected claim insert failure")
            }
            check(claims.values.none { it.key.eventIdentity == claim.key.eventIdentity })
            claims[claim.key] = claim
            writeCount += 1
        }

        fun putClaimUnchecked(
            claim: AgentTranscriptLifecyclePersistedNotificationClaim,
        ) {
            claims[claim.key] = claim
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

        fun duplicateConsumerRow(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
        ) {
            val row = rows.single { it.namespace.consumer == consumer }
            rows += row.copy()
        }

        fun durableImage(): List<Any> = listOf(
            rows.toList(), entries.toList(), snapshots.toList(), snapshotRecords.toList(),
            pendingEvents.toList(), lifecycleCurrent.toList(), lifecycleWitnesses.toList(),
            recentEvidence.toList(), notificationLedger.toList(), claims.toMap(), writeCount,
        )

        fun tamperNotificationLedger(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            mutate: (RelayV2AgentNotificationLedgerEntity) ->
                RelayV2AgentNotificationLedgerEntity,
        ) {
            val index = notificationLedger.indexOfFirst { it.belongsTo(namespace) }
            check(index >= 0)
            notificationLedger[index] = mutate(notificationLedger[index])
        }

        fun witnessEventIds(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ): Set<String> = lifecycleWitnesses.filter {
            it.belongsTo(namespace)
        }.mapTo(linkedSetOf()) { it.eventId }

        fun currentEventIds(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ): Set<String> = lifecycleCurrent.filter {
            it.belongsTo(namespace)
        }.mapTo(linkedSetOf()) { it.lifecycleEventId }

        fun notificationEventIds(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ): Set<String> = notificationLedger.filter {
            it.belongsTo(namespace)
        }.mapTo(linkedSetOf()) { it.lifecycleEventId }

        fun notificationCount(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ): Int = notificationLedger.count { it.belongsTo(namespace) }

        private fun currentWitnesses(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ): List<RelayV2AgentLifecycleEventWitnessEntity> = lifecycleCurrent.filter {
            it.belongsTo(namespace)
        }.map { current ->
            lifecycleWitnesses.single {
                it.belongsTo(namespace) && it.eventId == current.lifecycleEventId &&
                    it.agentEventSeq == current.agentEventSeq
            }
        }

        private fun selectedEntries(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            afterOrder: String?,
            afterEntryId: String?,
            limit: Int,
        ): List<RelayV2AgentTranscriptEntryEntity> = entries.filter { row ->
            row.belongsTo(namespace) && (afterOrder == null || afterPair(
                row.createdAgentSeqOrder,
                row.entryId,
                afterOrder,
                afterEntryId ?: "",
            ))
        }.sortedWith(compareBy({ it.createdAgentSeqOrder }, { it.entryId })).take(limit)

        private fun namespaceStats(
            selectedEntries: List<RelayV2AgentTranscriptEntryEntity>,
            selectedSnapshots: List<RelayV2AgentTranscriptSnapshotStagingEntity>,
            selectedSnapshotRecords: List<RelayV2AgentTranscriptSnapshotRecordEntity>,
            selectedPendingEvents: List<RelayV2AgentTranscriptPendingEventEntity>,
        ): RelayV2AgentTranscriptNamespaceStats {
            val entryPayloads = selectedEntries.map { it.payloadCanonicalJson.utf8Bytes() }
            val entryTexts = selectedEntries.map { it.text?.utf8Bytes() ?: 0L }
            val snapshotPayloads = selectedSnapshotRecords.map {
                it.payloadCanonicalJson.utf8Bytes()
            }
            val snapshotRaw = selectedSnapshotRecords.map { it.payloadRawUtf8Bytes.toLong() }
            val pendingPayloads = selectedPendingEvents.map { it.eventCanonicalJson.utf8Bytes() }
            val pendingRaw = selectedPendingEvents.map { it.eventRawUtf8Bytes.toLong() }
            return RelayV2AgentTranscriptNamespaceStats(
                entryCount = selectedEntries.size.toLong(),
                entryPayloadUtf8Bytes = entryPayloads.sum(),
                entryTextUtf8Bytes = entryTexts.sum(),
                entryMaxPayloadUtf8Bytes = entryPayloads.maxOrNull() ?: 0,
                entryMaxTextUtf8Bytes = entryTexts.maxOrNull() ?: 0,
                entryMaxBoundedTextUtf8Bytes = entryTexts.maxOrNull() ?: 0,
                snapshotCount = selectedSnapshots.size.toLong(),
                snapshotMaxIdUtf8Bytes = selectedSnapshots.maxOfOrNull {
                    it.snapshotId.utf8Bytes()
                } ?: 0,
                snapshotMaxCursorUtf8Bytes = selectedSnapshots.maxOfOrNull {
                    it.nextCursor?.utf8Bytes() ?: 0
                } ?: 0,
                snapshotRecordCount = selectedSnapshotRecords.size.toLong(),
                snapshotRecordPayloadUtf8Bytes = snapshotPayloads.sum(),
                snapshotRecordRawUtf8Bytes = snapshotRaw.sum(),
                snapshotRecordMinRawUtf8Bytes = snapshotRaw.minOrNull() ?: 0,
                snapshotRecordMaxRawUtf8Bytes = snapshotRaw.maxOrNull() ?: 0,
                snapshotRecordMaxPayloadUtf8Bytes = snapshotPayloads.maxOrNull() ?: 0,
                snapshotRecordMaxBoundedTextUtf8Bytes = 0,
                pendingEventCount = selectedPendingEvents.size.toLong(),
                pendingEventPayloadUtf8Bytes = pendingPayloads.sum(),
                pendingEventRawUtf8Bytes = pendingRaw.sum(),
                pendingEventMinRawUtf8Bytes = pendingRaw.minOrNull() ?: 0,
                pendingEventMaxRawUtf8Bytes = pendingRaw.maxOrNull() ?: 0,
                pendingEventMaxPayloadUtf8Bytes = pendingPayloads.maxOrNull() ?: 0,
                pendingEventMaxBoundedTextUtf8Bytes = 0,
            )
        }

        private fun lifecycleAudit(
            payloads: List<Pair<Int, String>>,
        ): RelayV2AgentLifecycleSqlAudit = RelayV2AgentLifecycleSqlAudit(
            itemCount = payloads.size.toLong(),
            declaredCanonicalBytes = payloads.sumOf { it.first.toLong() },
            actualCanonicalBytes = payloads.sumOf { it.second.utf8Bytes() },
        )

        private fun afterPair(
            first: String,
            second: String,
            afterFirst: String,
            afterSecond: String,
        ): Boolean = first > afterFirst || first == afterFirst && second > afterSecond

        private fun List<String>.lexicographicallyAfter(other: List<String>): Boolean {
            indices.forEach { index ->
                val compared = this[index].compareTo(other[index])
                if (compared != 0) return compared > 0
            }
            return false
        }

        private fun String.utf8Bytes(): Long = toByteArray(Charsets.UTF_8).size.toLong()

        private fun <T> replaceExact(target: MutableList<T>, expected: T, next: T): Int {
            val index = target.indexOf(expected)
            if (index < 0) return 0
            target[index] = next
            writeCount += 1
            return 1
        }

        private fun <T> removeExact(target: MutableList<T>, expected: T): Int {
            val removed = target.remove(expected)
            if (removed) writeCount += 1
            return if (removed) 1 else 0
        }

        private fun <T> removeMatching(target: MutableList<T>, predicate: (T) -> Boolean): Int {
            val before = target.size
            target.removeAll(predicate)
            val removed = before - target.size
            if (removed > 0) writeCount += 1
            return removed
        }

        private fun matchesNamespace(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            profileId: String,
            activation: Long,
            principalId: String,
            clientInstanceId: String,
            hostId: String,
            hostEpoch: String,
            scopeId: String,
            sessionId: String,
            timelineEpoch: String,
        ): Boolean = matchesConsumer(
            namespace.consumer, profileId, activation, principalId, clientInstanceId,
            hostId, hostEpoch, scopeId, sessionId,
        ) && namespace.timelineEpoch == timelineEpoch

        private fun matchesConsumer(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
            profileId: String,
            activation: Long,
            principalId: String,
            clientInstanceId: String,
            hostId: String,
            hostEpoch: String,
            scopeId: String,
            sessionId: String,
        ): Boolean = consumer.profileId == profileId &&
            consumer.profileActivationGeneration == activation &&
            consumer.principalId == principalId && consumer.clientInstanceId == clientInstanceId &&
            consumer.hostId == hostId && consumer.hostEpoch == hostEpoch &&
            consumer.scopeId == scopeId && consumer.sessionId == sessionId

        private fun RelayV2AgentTranscriptEntryEntity.belongsTo(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ) = matchesNamespace(namespace, profileId, profileActivationGeneration, principalId,
            clientInstanceId, hostId, hostEpoch, scopeId, sessionId, timelineEpoch)
        private fun RelayV2AgentTranscriptSnapshotStagingEntity.belongsTo(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ) = matchesNamespace(namespace, profileId, profileActivationGeneration, principalId,
            clientInstanceId, hostId, hostEpoch, scopeId, sessionId, timelineEpoch)
        private fun RelayV2AgentTranscriptSnapshotRecordEntity.belongsTo(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ) = matchesNamespace(namespace, profileId, profileActivationGeneration, principalId,
            clientInstanceId, hostId, hostEpoch, scopeId, sessionId, timelineEpoch)
        private fun RelayV2AgentTranscriptPendingEventEntity.belongsTo(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ) = matchesNamespace(namespace, profileId, profileActivationGeneration, principalId,
            clientInstanceId, hostId, hostEpoch, scopeId, sessionId, timelineEpoch)
        private fun RelayV2AgentLifecycleCurrentEntity.belongsTo(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ) = matchesNamespace(namespace, profileId, profileActivationGeneration, principalId,
            clientInstanceId, hostId, hostEpoch, scopeId, sessionId, timelineEpoch)
        private fun RelayV2AgentLifecycleEventWitnessEntity.belongsTo(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ) = matchesNamespace(namespace, profileId, profileActivationGeneration, principalId,
            clientInstanceId, hostId, hostEpoch, scopeId, sessionId, timelineEpoch)
        private fun RelayV2AgentRecentEventEvidenceEntity.belongsTo(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ) = matchesNamespace(namespace, profileId, profileActivationGeneration, principalId,
            clientInstanceId, hostId, hostEpoch, scopeId, sessionId, timelineEpoch)
        private fun RelayV2AgentNotificationLedgerEntity.belongsTo(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ) = matchesNamespace(namespace, profileId, profileActivationGeneration, principalId,
            clientInstanceId, hostId, hostEpoch, scopeId, sessionId, timelineEpoch)

        private fun RelayV2AgentTranscriptEntryEntity.belongsTo(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
            timeline: String? = null,
        ) = matchesConsumer(consumer, profileId, profileActivationGeneration, principalId,
            clientInstanceId, hostId, hostEpoch, scopeId, sessionId) &&
            (timeline == null || timelineEpoch == timeline)
        private fun RelayV2AgentTranscriptSnapshotStagingEntity.belongsTo(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
            timeline: String? = null,
        ) = matchesConsumer(consumer, profileId, profileActivationGeneration, principalId,
            clientInstanceId, hostId, hostEpoch, scopeId, sessionId) &&
            (timeline == null || timelineEpoch == timeline)
        private fun RelayV2AgentTranscriptSnapshotRecordEntity.belongsTo(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
            timeline: String? = null,
        ) = matchesConsumer(consumer, profileId, profileActivationGeneration, principalId,
            clientInstanceId, hostId, hostEpoch, scopeId, sessionId) &&
            (timeline == null || timelineEpoch == timeline)
        private fun RelayV2AgentTranscriptPendingEventEntity.belongsTo(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
            timeline: String? = null,
        ) = matchesConsumer(consumer, profileId, profileActivationGeneration, principalId,
            clientInstanceId, hostId, hostEpoch, scopeId, sessionId) &&
            (timeline == null || timelineEpoch == timeline)

        private fun RelayV2AgentTranscriptEntryEntity.belongsToEntry(
            other: RelayV2AgentTranscriptEntryEntity,
        ) = belongsTo(namespaceOf(other)) && entryId == other.entryId

        private fun RelayV2AgentTranscriptSnapshotRecordEntity.belongsToSnapshot(
            header: RelayV2AgentTranscriptSnapshotStagingEntity,
        ) = belongsTo(namespaceOf(header)) && snapshotId == header.snapshotId

        private fun namespaceOf(row: RelayV2AgentTranscriptEntryEntity) =
            namespaceFrom(row.profileId, row.profileActivationGeneration, row.principalId,
                row.clientInstanceId, row.hostId, row.hostEpoch, row.scopeId, row.sessionId,
                row.timelineEpoch)
        private fun namespaceOf(row: RelayV2AgentTranscriptSnapshotStagingEntity) =
            namespaceFrom(row.profileId, row.profileActivationGeneration, row.principalId,
                row.clientInstanceId, row.hostId, row.hostEpoch, row.scopeId, row.sessionId,
                row.timelineEpoch)
        private fun namespaceOf(row: RelayV2AgentTranscriptSnapshotRecordEntity) =
            namespaceFrom(row.profileId, row.profileActivationGeneration, row.principalId,
                row.clientInstanceId, row.hostId, row.hostEpoch, row.scopeId, row.sessionId,
                row.timelineEpoch)
        private fun namespaceOf(row: RelayV2AgentTranscriptPendingEventEntity) =
            namespaceFrom(row.profileId, row.profileActivationGeneration, row.principalId,
                row.clientInstanceId, row.hostId, row.hostEpoch, row.scopeId, row.sessionId,
                row.timelineEpoch)
        private fun namespaceOf(row: RelayV2AgentLifecycleCurrentEntity) =
            namespaceFrom(row.profileId, row.profileActivationGeneration, row.principalId,
                row.clientInstanceId, row.hostId, row.hostEpoch, row.scopeId, row.sessionId,
                row.timelineEpoch)
        private fun namespaceOf(row: RelayV2AgentLifecycleEventWitnessEntity) =
            namespaceFrom(row.profileId, row.profileActivationGeneration, row.principalId,
                row.clientInstanceId, row.hostId, row.hostEpoch, row.scopeId, row.sessionId,
                row.timelineEpoch)
        private fun namespaceOf(row: RelayV2AgentRecentEventEvidenceEntity) =
            namespaceFrom(row.profileId, row.profileActivationGeneration, row.principalId,
                row.clientInstanceId, row.hostId, row.hostEpoch, row.scopeId, row.sessionId,
                row.timelineEpoch)
        private fun namespaceOf(row: RelayV2AgentNotificationLedgerEntity) =
            namespaceFrom(row.profileId, row.profileActivationGeneration, row.principalId,
                row.clientInstanceId, row.hostId, row.hostEpoch, row.scopeId, row.sessionId,
                row.timelineEpoch)

        private fun namespaceFrom(
            profileId: String,
            activation: Long,
            principalId: String,
            clientInstanceId: String,
            hostId: String,
            hostEpoch: String,
            scopeId: String,
            sessionId: String,
            timelineEpoch: String,
        ) = AgentTranscriptLifecycleDurableNamespace(
            AgentTranscriptLifecycleDurableConsumerIdentity(
                profileId, activation, principalId, clientInstanceId,
                hostId, hostEpoch, scopeId, sessionId,
            ),
            timelineEpoch,
        )
    }

    private companion object {
        data class NotificationFixture(
            val namespace: AgentTranscriptLifecycleDurableNamespace,
            val intent: AgentSystemNotificationIntent,
        )

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

        fun operationFence(
            namespace: AgentTranscriptLifecycleDurableNamespace,
        ) = AgentTranscriptLifecycleDurableOperationFence(namespace.consumer, namespace)

        suspend fun applyControl(
            repository: AgentTranscriptLifecycleDurableRepositoryCore,
            namespace: AgentTranscriptLifecycleDurableNamespace,
            input: AgentTranscriptLifecycleControlInput,
            limits: AgentClientReducerLimits = AgentClientReducerLimits(),
        ): AgentTranscriptLifecycleClientReduction = repository.applyControlUnderApplyLease(
            AgentTranscriptLifecycleDurableControlCommand(operationFence(namespace), input),
            limits,
        ).reduction

        suspend fun consumeLive(
            repository: AgentTranscriptLifecycleDurableRepositoryCore,
            namespace: AgentTranscriptLifecycleDurableNamespace,
            event: AgentTimelineEventRecord,
            limits: AgentClientReducerLimits = AgentClientReducerLimits(),
        ): AgentTranscriptLifecycleClientReduction {
            val codec = AgentTranscriptLifecycleV1Codec()
            val consumer = namespace.consumer
            val artifact = codec.decodePublicFrameArtifact(
                codec.encodePublicFrame(
                    AgentTimelineEventFrame(
                        hostId = consumer.hostId,
                        hostEpoch = consumer.hostEpoch,
                        scopeId = consumer.scopeId,
                        sessionId = consumer.sessionId,
                        timelineEpoch = requireNotNull(namespace.timelineEpoch),
                        event = event,
                    ),
                ),
            )
            return repository.consumeLiveEventUnderApplyLease(
                AgentTranscriptLifecycleDurableLiveEventCommand(
                    operationFence(namespace),
                    artifact,
                ),
                limits,
            ).reduction
        }

        suspend fun createNotificationFixture(
            repository: AgentTranscriptLifecycleDurableRepositoryCore,
            store: MemoryStore,
            sessionId: String = "session-claim",
            notificationConfig: AgentNotificationConfig = enabledNotificationConfig(),
            requireExecutableIntent: Boolean = true,
        ): NotificationFixture {
            val consumer = consumer(sessionId = sessionId)
            val initial = operationalState(consumer, "timeline-$sessionId").copy(
                notificationConfig = notificationConfig,
            )
            val namespace = namespace(consumer, initial)
            repository.initializeUnderApplyLease(namespace, initial)
            consumeLive(
                repository,
                namespace,
                lifecyclePublicEvent(
                    sequence = "1",
                    eventId = "event-$sessionId-running",
                    state = AgentTimelineLifecycleState.RUNNING,
                ),
            )
            val completed = consumeLive(
                repository,
                namespace,
                lifecyclePublicEvent(
                    sequence = "2",
                    eventId = "event-$sessionId-completed",
                    state = AgentTimelineLifecycleState.COMPLETED,
                ),
            )
            val decision = completed.notificationDecisions.single()
            val executable = decision.systemNotificationIntent
            if (requireExecutableIntent) check(executable != null)
            check(store.notificationCount(namespace) == 1)
            return NotificationFixture(
                namespace,
                executable ?: AgentSystemNotificationIntent(
                    decision.dedupeKey,
                    decision.ledgerEntry.localGeneration,
                ),
            )
        }

        suspend fun enterSnapshot(
            repository: AgentTranscriptLifecycleDurableRepositoryCore,
            namespace: AgentTranscriptLifecycleDurableNamespace,
            currentAgentSeq: String,
            earliestReplaySeq: String,
        ): AgentTranscriptLifecycleClientReduction {
            val requestToken = "status-${namespace.consumer.sessionId}-$currentAgentSeq"
            val requested = applyControl(
                repository,
                namespace,
                AgentTranscriptLifecycleClientInput.StatusRequestStarted(requestToken),
            )
            val status = applyControl(
                repository,
                namespace,
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
                    currentAgentSeq = currentAgentSeq,
                    earliestReplaySeq = earliestReplaySeq,
                    hostLimits = productionHostLimits(),
                ),
            )
            check(status.state.extensionLane.syncState == AgentTimelineSyncState.Snapshot)
            return status
        }

        suspend fun persistSnapshotRequest(
            repository: AgentTranscriptLifecycleDurableRepositoryCore,
            namespace: AgentTranscriptLifecycleDurableNamespace,
            snapshotRequestId: String,
            pageZeroNetworkToken: String,
        ): AgentTranscriptLifecycleClientReduction =
            repository.persistSnapshotRequestUnderApplyLease(
                AgentTranscriptLifecycleDurableSnapshotRequestCommand(
                    fence = operationFence(namespace),
                    snapshotRequestId = snapshotRequestId,
                    pageZeroNetworkToken = pageZeroNetworkToken,
                ),
            ).reduction

        suspend fun consumeFinalSnapshot(
            repository: AgentTranscriptLifecycleDurableRepositoryCore,
            namespace: AgentTranscriptLifecycleDurableNamespace,
            requestNetworkToken: String,
            snapshotRequestId: String,
            snapshotId: String,
            throughAgentSeq: String,
            records: List<AgentTimelineSnapshotRecord>,
            limits: AgentClientReducerLimits = AgentClientReducerLimits(),
        ): AgentTranscriptLifecycleClientReduction {
            val codec = AgentTranscriptLifecycleV1Codec()
            val consumer = namespace.consumer
            val artifact = codec.decodePublicFrameArtifact(
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
                            pageIndex = 0,
                            isLast = true,
                            nextCursor = null,
                            throughAgentSeq = throughAgentSeq,
                            earliestRetainedSeq = "1",
                            records = records,
                        ),
                    ),
                ),
            ) as AgentTimelineSnapshotPagePublicFrameArtifact
            return repository.consumeSnapshotPageUnderApplyLease(
                AgentTranscriptLifecycleDurableSnapshotPageCommand.FinalPageCut(
                    operationFence(namespace),
                    artifact,
                ),
                limits,
            ).reduction
        }

        fun lifecycleSnapshotRecord(
            sequence: String,
            eventId: String,
            state: AgentTimelineLifecycleState,
            scope: AgentTimelineLifecycleScope = AgentTimelineLifecycleScope.RUN,
            runId: String = "run-a",
            turnId: String? = null,
            sourceEpoch: String = "source-a",
        ) = AgentTimelineLifecycleRecord(
            lifecycleEventId = eventId,
            sourceEpoch = sourceEpoch,
            scope = scope,
            runId = runId,
            turnId = turnId,
            state = state,
            failure = null,
            occurredAtMs = sequence.toLong() * 1_000,
            agentEventSeq = sequence,
        )

        fun lifecyclePublicEvent(
            sequence: String,
            eventId: String,
            state: AgentTimelineLifecycleState,
            scope: AgentTimelineLifecycleScope = AgentTimelineLifecycleScope.RUN,
            runId: String = "run-a",
            turnId: String? = null,
            sourceEpoch: String = "source-a",
        ) = AgentTimelineEventRecord(
            agentEventSeq = sequence,
            eventId = eventId,
            occurredAtMs = sequence.toLong() * 1_000,
            mutation = AgentTimelineLifecycleChangedMutation(
                AgentTimelineLifecycleRecord(
                    lifecycleEventId = eventId,
                    sourceEpoch = sourceEpoch,
                    scope = scope,
                    runId = runId,
                    turnId = turnId,
                    state = state,
                    failure = null,
                    occurredAtMs = sequence.toLong() * 1_000,
                    agentEventSeq = sequence,
                ),
            ),
        )

        fun sourceAvailabilityPublicEvent(
            sequence: String,
        ) = AgentTimelineEventRecord(
            agentEventSeq = sequence,
            eventId = "event-source-interrupted-$sequence",
            occurredAtMs = sequence.toLong() * 1_000,
            mutation = AgentTimelineSourceAvailabilityMutation(
                state = AgentTimelineSourceAvailabilityState.INTERRUPTED,
                sourceEpoch = "source-a",
                reason = AgentTimelineSourceAvailabilityReason.SOURCE_DISCONNECTED,
            ),
        )

        fun enabledNotificationConfig() = AgentNotificationConfig(
            permission = AgentNotificationPermission.GRANTED,
            profileActive = true,
            policy = AgentNotificationPolicy.ALLOW,
        )

        fun operationalState(
            consumer: AgentTranscriptLifecycleDurableConsumerIdentity,
            timelineEpoch: String,
            baseline: String? = "0",
        ) = AgentTranscriptLifecycleClientState(
            identity = consumer.sessionIdentity,
            extensionLane = AgentTranscriptLifecycleExtensionState(
                support = AgentExtensionSupport.AVAILABLE,
                unavailableReason = null,
                liveSource = AgentLiveSourceState.CONNECTED,
                activeSourceEpoch = "source-a",
                timelineEpoch = timelineEpoch,
                effectiveHostLimits = productionHostLimits(),
                syncState = AgentTimelineSyncState.Current,
                notificationBaselineAgentSeq = baseline,
            ),
            notificationConfig = enabledNotificationConfig(),
        )

        fun claimKey(
            namespace: AgentTranscriptLifecycleDurableNamespace,
            intent: AgentSystemNotificationIntent,
        ) = requireNotNull(
            AgentTranscriptLifecycleNotificationClaimKey.exactOrNull(namespace, intent),
        )

        fun persistedClaim(
            key: AgentTranscriptLifecycleNotificationClaimKey,
            intent: AgentSystemNotificationIntent,
        ) = AgentTranscriptLifecyclePersistedNotificationClaim(
            key,
            intent.localGeneration,
            AgentTranscriptLifecycleNotificationClaimCodec.encode(key, intent),
        )

        fun productionHostLimits() = AgentTimelineEffectiveLimits(
            maxTextUtf8Bytes = 65_536,
            maxPageRecords = 256,
            eventReplayRetentionMs = 604_800_000,
            snapshotLeaseMs = 300_000,
        )

        fun encodeAsLegacyV1(payload: RelayV2EncodedPayload): RelayV2EncodedPayload {
            val root = RelayV2StrictJson.parseObject(
                payload.canonicalJson,
                RelayV2JsonLimits(
                    maxDepth = 32,
                    maxDirectKeys = 256,
                    maxTotalKeys = 32_768,
                    maxNodes = 100_000,
                ),
            ).toMutableMap()
            @Suppress("UNCHECKED_CAST")
            val state = (root.getValue("state") as Map<String, Any?>).toMutableMap()
            @Suppress("UNCHECKED_CAST")
            val extension = (state.getValue("extension") as Map<String, Any?>).toMutableMap()
            extension.remove("effectiveHostLimits")
            extension.remove("syncState")
            extension["lifecycleRecords"] = emptyList<Any?>()
            extension["runsWithTurnRecords"] = emptyList<String>()
            extension["appliedEventEvidence"] = emptyList<Any?>()
            extension["eventIdentityWitnesses"] = emptyList<Any?>()
            extension["notificationLedger"] = emptyList<Any?>()
            extension["requiresSnapshot"] = false
            state["extension"] = extension
            root["state"] = state
            root.remove("storageAccounting")
            return RelayV2StorageJson.encode(codecVersion = 1, value = root)
        }

        fun RelayV2EncodedPayload.withActivationGeneration(
            encodedGeneration: String,
        ): RelayV2EncodedPayload = replaceCanonicalJson(
            "\"profileActivationGeneration\":\"7\"",
            "\"profileActivationGeneration\":\"$encodedGeneration\"",
        )

        fun RelayV2EncodedPayload.withRootMembers(
            members: String,
        ): RelayV2EncodedPayload {
            check(canonicalJson.endsWith('}'))
            return withCanonicalJson(canonicalJson.dropLast(1) + ",$members}")
        }

        fun RelayV2EncodedPayload.replaceCanonicalJson(
            original: String,
            replacement: String,
        ): RelayV2EncodedPayload {
            check(original in canonicalJson)
            check(canonicalJson.indexOf(original) == canonicalJson.lastIndexOf(original))
            return withCanonicalJson(canonicalJson.replace(original, replacement))
        }

        fun RelayV2EncodedPayload.withCanonicalJson(
            tamperedJson: String,
        ): RelayV2EncodedPayload {
            val bytes = tamperedJson.toByteArray(Charsets.UTF_8)
            return copy(
                payloadUtf8Bytes = bytes.size,
                canonicalJson = tamperedJson,
                sha256 = MessageDigest.getInstance("SHA-256")
                    .digest(bytes)
                    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) },
            )
        }

        fun nullArray(size: Int): String = buildString(size * 5 + 2) {
            append('[')
            repeat(size) { index ->
                if (index > 0) append(',')
                append("null")
            }
            append(']')
        }
    }
}
