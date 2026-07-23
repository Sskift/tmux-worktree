package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2EncodedPayload
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageException
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageFailure
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageJson
import java.math.BigInteger
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

/** Closed, digest-protected codec for the complete durable Android consumer reducer state. */
internal object AgentTranscriptLifecycleDurableStateCodec {
    const val CODEC_VERSION = 3
    const val MAX_PAYLOAD_UTF8_BYTES = 16_777_216

    fun encode(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        state: AgentTranscriptLifecycleClientState,
        storageAccounting: AgentTranscriptDurableStorageAccounting,
    ): RelayV2EncodedPayload {
        require(state.identity == namespace.consumer.sessionIdentity)
        require(state.extensionLane.timelineEpoch == namespace.timelineEpoch)
        require(state.extensionLane.hasNoRowOwnedMaterialization()) {
            "Room L/W/E/N materialization cannot be duplicated in the parent payload"
        }
        return RelayV2StorageJson.encode(
            CODEC_VERSION,
            linkedMapOf(
                "kind" to PAYLOAD_KIND,
                "namespace" to namespace.toStorageMap(),
                "state" to state.toStorageMap(),
                "storageAccounting" to storageAccounting.toStorageMap(),
            ),
        ).also { payload ->
            if (payload.payloadUtf8Bytes > MAX_PAYLOAD_UTF8_BYTES) {
                throw RelayV2StorageException(RelayV2StorageFailure.LIMIT_EXCEEDED)
            }
        }
    }

    fun decode(
        expectedNamespace: AgentTranscriptLifecycleDurableNamespace,
        payload: RelayV2EncodedPayload,
    ): AgentTranscriptLifecycleDecodedDurablePayload = try {
        if (payload.codecVersion !in setOf(
                LEGACY_CODEC_VERSION,
                PREVIOUS_CODEC_VERSION,
                CODEC_VERSION,
            )
        ) incompatible()
        val root = RelayV2StorageJson.decode(
            payload,
            expectedCodecVersion = payload.codecVersion,
            maxPayloadBytes = MAX_PAYLOAD_UTF8_BYTES,
            limits = JSON_LIMITS,
        )
        if (payload.codecVersion == LEGACY_CODEC_VERSION) {
            RelayV2StorageJson.requireKeys(root, "kind", "namespace", "state")
        } else {
            RelayV2StorageJson.requireKeys(
                root,
                "kind",
                "namespace",
                "state",
                "storageAccounting",
            )
        }
        if (RelayV2StorageJson.string(root, "kind") != PAYLOAD_KIND) incompatible()
        val storedNamespace = decodeNamespace(RelayV2StorageJson.objectValue(root, "namespace"))
        if (storedNamespace != expectedNamespace) malformed()
        val state = decodeState(
            storedNamespace,
            RelayV2StorageJson.objectValue(root, "state"),
            payload.codecVersion,
        )
        if (state.identity != expectedNamespace.consumer.sessionIdentity ||
            state.extensionLane.timelineEpoch != expectedNamespace.timelineEpoch
        ) malformed()
        AgentTranscriptLifecycleDecodedDurablePayload(
            state = state,
            storageAccounting = if (payload.codecVersion != LEGACY_CODEC_VERSION) {
                decodeDurableStorageAccounting(
                    RelayV2StorageJson.objectValue(root, "storageAccounting"),
                )
            } else {
                null
            },
        )
    } catch (error: RelayV2StorageException) {
        throw error
    } catch (_: IllegalArgumentException) {
        malformed()
    } catch (_: IllegalStateException) {
        malformed()
    }

    private fun decodeState(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        value: Map<String, Any?>,
        codecVersion: Int,
    ): AgentTranscriptLifecycleClientState {
        RelayV2StorageJson.requireKeys(value, "identity", "notificationConfig", "extension")
        val identity = decodeSessionIdentity(RelayV2StorageJson.objectValue(value, "identity"))
        if (identity != namespace.consumer.sessionIdentity) malformed()
        val notificationConfig = decodeNotificationConfig(
            RelayV2StorageJson.objectValue(value, "notificationConfig"),
            codecVersion,
        )
        val extension = decodeExtension(
            namespace,
            RelayV2StorageJson.objectValue(value, "extension"),
            codecVersion,
        )
        return AgentTranscriptLifecycleClientState(identity, extension, notificationConfig)
    }

    private fun decodeExtension(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        value: Map<String, Any?>,
        codecVersion: Int,
    ): AgentTranscriptLifecycleExtensionState {
        val commonKeys = arrayOf(
            "localGeneration", "support", "unavailableReason", "liveSource",
            "activeSourceEpoch", "timelineEpoch", "lastAgentSeq",
            "notificationBaselineAgentSeq",
            "retiredTimelineEpochs", "retiredEpochCompactionGeneration",
            "snapshotCheckpoint", "snapshotNotificationSuppressedThroughAgentSeq",
            "pendingStatusRequest", "pendingSnapshotRequest", "requiresTimelineRotation",
        )
        if (codecVersion == LEGACY_CODEC_VERSION) {
            RelayV2StorageJson.requireKeys(
                value,
                *(
                    commonKeys + arrayOf(
                        "lifecycleRecords",
                        "runsWithTurnRecords",
                        "appliedEventEvidence",
                        "eventIdentityWitnesses",
                        "notificationLedger",
                        "requiresSnapshot",
                    )
                    ),
            )
        } else {
            RelayV2StorageJson.requireKeys(
                value,
                *(
                    commonKeys + arrayOf(
                        "effectiveHostLimits",
                        "syncState",
                    )
                    ),
            )
        }
        val timelineEpoch = RelayV2StorageJson.nullableString(value, "timelineEpoch")
        if (timelineEpoch != namespace.timelineEpoch) malformed()
        val storedLocalGeneration = RelayV2StorageJson.string(value, "localGeneration")
        val storedLastAgentSeq = RelayV2StorageJson.string(value, "lastAgentSeq")
        val storedSnapshotSuppressedThrough = RelayV2StorageJson.nullableString(
            value,
            "snapshotNotificationSuppressedThroughAgentSeq",
        )
        val storedSnapshotCheckpoint = RelayV2StorageJson.nullableObject(
            value,
            "snapshotCheckpoint",
        )?.let(::decodeSnapshotCheckpoint)
        val support = RelayV2StorageJson.enum<AgentExtensionSupport>(value, "support")
        val notificationBaseline = RelayV2StorageJson.nullableString(
            value,
            "notificationBaselineAgentSeq",
        )
        val pendingStatus = RelayV2StorageJson.nullableObject(
            value,
            "pendingStatusRequest",
        )?.let(::decodeRequestFence)
        val encodedPendingSnapshot = RelayV2StorageJson.nullableObject(
            value,
            "pendingSnapshotRequest",
        )
        val legacyPendingSnapshot = if (codecVersion == LEGACY_CODEC_VERSION) {
            encodedPendingSnapshot?.let(::decodeRequestFence)
        } else {
            null
        }
        val legacyRequiresSnapshot = codecVersion == LEGACY_CODEC_VERSION &&
            RelayV2StorageJson.boolean(value, "requiresSnapshot")
        val requiresTimelineRotation = RelayV2StorageJson.boolean(
            value,
            "requiresTimelineRotation",
        )
        val encodedRunsWithTurns = if (codecVersion == LEGACY_CODEC_VERSION) {
            RelayV2StorageJson.stringList(value, "runsWithTurnRecords", MAX_EVER_TURN_MARKERS)
        } else {
            emptyList()
        }
        if (encodedRunsWithTurns.toSet().size != encodedRunsWithTurns.size) malformed()
        encodedRunsWithTurns.forEach {
            AgentLifecycleIdentity(AgentLifecycleScope.RUN, it, null)
        }

        val encodedLifecycleRecords = if (codecVersion == LEGACY_CODEC_VERSION) {
            RelayV2StorageJson.list(value, "lifecycleRecords", MAX_LIFECYCLE_RECORDS)
        } else {
            emptyList()
        }
        val legacyLifecycleRecords = if (codecVersion == LEGACY_CODEC_VERSION) {
            encodedLifecycleRecords.map {
                decodeLegacyLifecycleRecord(RelayV2StorageJson.objectValue(it))
            }
        } else {
            emptyList()
        }
        val lifecycleRecords = emptyList<AgentLifecycleRecord>()
        val lifecycleByIdentity = uniqueMap(lifecycleRecords, AgentLifecycleRecord::identity)
        val lifecycleEventIndex = uniqueMap(lifecycleRecords, AgentLifecycleRecord::lifecycleEventId)
            .mapValues { (_, record) -> record.identity }

        val encodedAppliedEvidence = if (codecVersion == LEGACY_CODEC_VERSION) {
            RelayV2StorageJson.list(value, "appliedEventEvidence", MAX_APPLIED_EVENT_EVIDENCE)
                .map { decodeAppliedEvidence(RelayV2StorageJson.objectValue(it)) }
        } else {
            emptyList()
        }
        val decodedAppliedBySeq = uniqueMap(encodedAppliedEvidence) { it.first }
            .mapValues { (_, pair) -> pair.second }
        val appliedBySeq = emptyMap<String, AgentAppliedEventEvidence>()

        val encodedWitnesses = if (codecVersion == LEGACY_CODEC_VERSION) {
            RelayV2StorageJson.list(value, "eventIdentityWitnesses", MAX_EVENT_IDENTITY_WITNESSES)
        } else {
            emptyList()
        }
        val legacyWitnesses = if (codecVersion == LEGACY_CODEC_VERSION) {
            encodedWitnesses.map { decodeLegacyEventWitness(RelayV2StorageJson.objectValue(it)) }
        } else {
            emptyList()
        }
        val witnesses = emptyList<AgentLifecycleEventIdentityWitness>()
        val witnessById = uniqueMap(witnesses, AgentLifecycleEventIdentityWitness::eventId)
        val eventIdBySeq = uniqueMap(witnesses, AgentLifecycleEventIdentityWitness::agentEventSeq)
            .mapValues { (_, witness) -> witness.eventId }
            .toMutableMap()
        appliedBySeq.forEach { (sequence, evidence) ->
            val existing = eventIdBySeq.put(sequence, evidence.eventId)
            if (existing != null && existing != evidence.eventId) malformed()
        }

        val encodedNotificationEntries = if (codecVersion == LEGACY_CODEC_VERSION) {
            RelayV2StorageJson.list(
                value,
                "notificationLedger",
                MAX_NOTIFICATION_LEDGER_ENTRIES,
            )
        } else {
            emptyList()
        }
        val notificationEntries = emptyList<Pair<AgentNotificationDedupeKey, AgentNotificationLedgerEntry>>()
        val notificationLedger = uniqueMap(notificationEntries) { it.first }
            .mapValues { (_, pair) -> pair.second }
        val notificationIndex = uniqueMap(notificationEntries) { it.first.lifecycleEventId }
            .mapValues { (_, pair) -> pair.first }

        val legacyHasIncompleteLifecycleMaterialization = if (
            codecVersion == LEGACY_CODEC_VERSION
        ) {
            validateLegacyMaterialization(
                namespace = namespace,
                lifecycleRecords = legacyLifecycleRecords,
                appliedBySeq = decodedAppliedBySeq,
                witnesses = legacyWitnesses,
                notificationEntries = encodedNotificationEntries.map {
                    RelayV2StorageJson.objectValue(it)
                },
                oldLastAgentSeq = storedLastAgentSeq,
                oldLocalGeneration = storedLocalGeneration,
                oldSnapshotSuppressedThrough = storedSnapshotSuppressedThrough,
                runsWithTurnRecords = encodedRunsWithTurns.toSet(),
                pendingStatus = pendingStatus,
                pendingSnapshot = legacyPendingSnapshot,
                requiresSnapshot = legacyRequiresSnapshot,
                requiresTimelineRotation = requiresTimelineRotation,
            )
            encodedLifecycleRecords.isNotEmpty() ||
                encodedAppliedEvidence.isNotEmpty() ||
                encodedWitnesses.isNotEmpty() ||
                encodedNotificationEntries.isNotEmpty() ||
                encodedRunsWithTurns.isNotEmpty()
        } else {
            false
        }

        val legacyHadPendingSnapshot = legacyPendingSnapshot != null
        val legacyNeedsFreshTranscriptMaterialization =
            codecVersion == LEGACY_CODEC_VERSION &&
                (support == AgentExtensionSupport.AVAILABLE ||
                    storedLastAgentSeq != "0" ||
                    storedSnapshotCheckpoint != null)
        val legacyForceSnapshotAfterRefresh = legacyRequiresSnapshot ||
            legacyHadPendingSnapshot ||
            notificationBaseline == null ||
            legacyHasIncompleteLifecycleMaterialization ||
            legacyNeedsFreshTranscriptMaterialization
        val syncState = if (codecVersion != LEGACY_CODEC_VERSION) {
            decodeSyncState(RelayV2StorageJson.objectValue(value, "syncState"))
        } else if (support == AgentExtensionSupport.AVAILABLE) {
            AgentTimelineSyncState.StatusRefresh(
                requireSnapshotAfterRefresh = legacyForceSnapshotAfterRefresh,
            )
        } else if (legacyForceSnapshotAfterRefresh) {
            AgentTimelineSyncState.StatusRefresh(requireSnapshotAfterRefresh = true)
        } else {
            AgentTimelineSyncState.Current
        }
        val migratedSnapshotSuppressedThrough = if (
            codecVersion == LEGACY_CODEC_VERSION &&
            (legacyHasIncompleteLifecycleMaterialization ||
                legacyNeedsFreshTranscriptMaterialization)
        ) {
            maxCounter(storedSnapshotSuppressedThrough, storedLastAgentSeq)
        } else {
            storedSnapshotSuppressedThrough
        }

        return AgentTranscriptLifecycleExtensionState(
            localGeneration = storedLocalGeneration,
            support = support,
            unavailableReason = RelayV2StorageJson
                .nullableEnum<AgentExtensionUnavailableReason>(value, "unavailableReason"),
            liveSource = RelayV2StorageJson
                .nullableEnum<AgentLiveSourceState>(value, "liveSource"),
            activeSourceEpoch = RelayV2StorageJson.nullableString(value, "activeSourceEpoch"),
            timelineEpoch = timelineEpoch,
            lastAgentSeq = storedLastAgentSeq,
            effectiveHostLimits = if (codecVersion != LEGACY_CODEC_VERSION) {
                RelayV2StorageJson.nullableObject(value, "effectiveHostLimits")
                    ?.let(::decodeEffectiveHostLimits)
            } else {
                null
            },
            syncState = syncState,
            notificationBaselineAgentSeq = notificationBaseline,
            lifecycleByIdentity = lifecycleByIdentity,
            currentLifecycleIdentityByEventId = lifecycleEventIndex,
            runsWithTurnRecords = if (codecVersion != LEGACY_CODEC_VERSION) {
                encodedRunsWithTurns.toCollection(linkedSetOf())
            } else {
                emptySet()
            },
            appliedEventsBySeq = appliedBySeq,
            eventWitnessById = witnessById,
            eventIdBySeq = eventIdBySeq,
            notificationLedger = notificationLedger,
            notificationKeyByLifecycleEventId = notificationIndex,
            retiredTimelineEpochs = RelayV2StorageJson.stringList(
                value,
                "retiredTimelineEpochs",
                MAX_RETIRED_TIMELINES,
            ).toUniqueSet(),
            retiredEpochCompactionGeneration = RelayV2StorageJson.nullableString(
                value,
                "retiredEpochCompactionGeneration",
            ),
            snapshotCheckpoint = storedSnapshotCheckpoint,
            snapshotNotificationSuppressedThroughAgentSeq = migratedSnapshotSuppressedThrough,
            pendingStatusRequest = if (
                codecVersion == LEGACY_CODEC_VERSION &&
                syncState is AgentTimelineSyncState.StatusRefresh
            ) null else pendingStatus,
            pendingSnapshotRequest = if (codecVersion != LEGACY_CODEC_VERSION) {
                encodedPendingSnapshot?.let(::decodeSnapshotPreFirstFence)
            } else {
                null
            },
            requiresTimelineRotation = requiresTimelineRotation,
        )
    }

    private fun decodeNamespace(value: Map<String, Any?>): AgentTranscriptLifecycleDurableNamespace {
        RelayV2StorageJson.requireKeys(
            value,
            "profileId",
            "profileActivationGeneration",
            "principalId",
            "clientInstanceId",
            "hostId",
            "hostEpoch",
            "scopeId",
            "sessionId",
            "timelineEpoch",
        )
        val encodedActivation = RelayV2StorageJson.string(
            value,
            "profileActivationGeneration",
        )
        if (!CANONICAL_POSITIVE_DECIMAL.matches(encodedActivation)) malformed()
        val activation = encodedActivation.toLongOrNull() ?: malformed()
        return AgentTranscriptLifecycleDurableNamespace(
            AgentTranscriptLifecycleDurableConsumerIdentity(
                profileId = RelayV2StorageJson.string(value, "profileId"),
                profileActivationGeneration = activation,
                principalId = RelayV2StorageJson.string(value, "principalId"),
                clientInstanceId = RelayV2StorageJson.string(value, "clientInstanceId"),
                hostId = RelayV2StorageJson.string(value, "hostId"),
                hostEpoch = RelayV2StorageJson.string(value, "hostEpoch"),
                scopeId = RelayV2StorageJson.string(value, "scopeId"),
                sessionId = RelayV2StorageJson.string(value, "sessionId"),
            ),
            RelayV2StorageJson.nullableString(value, "timelineEpoch"),
        )
    }

    private fun decodeSessionIdentity(value: Map<String, Any?>): AgentExtensionSessionIdentity {
        RelayV2StorageJson.requireKeys(
            value,
            "profileId",
            "hostId",
            "hostEpoch",
            "scopeId",
            "sessionId",
        )
        return AgentExtensionSessionIdentity(
            RelayV2StorageJson.string(value, "profileId"),
            RelayV2StorageJson.string(value, "hostId"),
            RelayV2StorageJson.string(value, "hostEpoch"),
            RelayV2StorageJson.string(value, "scopeId"),
            RelayV2StorageJson.string(value, "sessionId"),
        )
    }

    private fun decodeDurableStorageAccounting(
        value: Map<String, Any?>,
    ): AgentTranscriptDurableStorageAccounting {
        RelayV2StorageJson.requireKeys(
            value,
            "entryCount",
            "entryCanonicalBytes",
            "entryTextUtf8Bytes",
            "pendingLiveEventCount",
            "pendingLiveEventCanonicalBytes",
            "pendingLiveEventRawUtf8Bytes",
            "lifecycleCurrentCount",
            "lifecycleCurrentCanonicalBytes",
            "lifecycleWitnessCount",
            "lifecycleWitnessCanonicalBytes",
            "recentEventEvidenceCount",
            "recentEventEvidenceCanonicalBytes",
            "notificationLedgerCount",
            "notificationLedgerCanonicalBytes",
        )
        return AgentTranscriptDurableStorageAccounting(
            entryCount = storageLong(value, "entryCount"),
            entryCanonicalBytes = storageLong(value, "entryCanonicalBytes"),
            entryTextUtf8Bytes = storageLong(value, "entryTextUtf8Bytes"),
            pendingLiveEventCount = storageLong(value, "pendingLiveEventCount"),
            pendingLiveEventCanonicalBytes = storageLong(
                value,
                "pendingLiveEventCanonicalBytes",
            ),
            pendingLiveEventRawUtf8Bytes = storageLong(
                value,
                "pendingLiveEventRawUtf8Bytes",
            ),
            lifecycleCurrentCount = storageLong(value, "lifecycleCurrentCount"),
            lifecycleCurrentCanonicalBytes = storageLong(
                value,
                "lifecycleCurrentCanonicalBytes",
            ),
            lifecycleWitnessCount = storageLong(value, "lifecycleWitnessCount"),
            lifecycleWitnessCanonicalBytes = storageLong(
                value,
                "lifecycleWitnessCanonicalBytes",
            ),
            recentEventEvidenceCount = storageLong(value, "recentEventEvidenceCount"),
            recentEventEvidenceCanonicalBytes = storageLong(
                value,
                "recentEventEvidenceCanonicalBytes",
            ),
            notificationLedgerCount = storageLong(value, "notificationLedgerCount"),
            notificationLedgerCanonicalBytes = storageLong(
                value,
                "notificationLedgerCanonicalBytes",
            ),
        )
    }

    private fun storageLong(value: Map<String, Any?>, key: String): Long {
        val encoded = RelayV2StorageJson.string(value, key)
        if (!CANONICAL_NON_NEGATIVE_DECIMAL.matches(encoded)) malformed()
        return encoded.toLongOrNull() ?: malformed()
    }

    private fun decodeNotificationConfig(
        value: Map<String, Any?>,
        codecVersion: Int,
    ): AgentNotificationConfig {
        if (codecVersion == CODEC_VERSION) {
            RelayV2StorageJson.requireKeys(
                value,
                "permission",
                "profileActive",
                "policy",
                "waitingForUser",
                "failed",
                "completed",
            )
        } else {
            RelayV2StorageJson.requireKeys(value, "permission", "profileActive", "policy")
        }
        return AgentNotificationConfig(
            permission = RelayV2StorageJson.enum(value, "permission"),
            profileActive = RelayV2StorageJson.boolean(value, "profileActive"),
            policy = RelayV2StorageJson.enum(value, "policy"),
            waitingForUser = if (codecVersion == CODEC_VERSION) {
                RelayV2StorageJson.boolean(value, "waitingForUser")
            } else {
                // v1/v2 stored only the global gate. Preserve the existing waiting/failed
                // defaults, while keeping completed closed and retaining all three stored gates.
                true
            },
            failed = if (codecVersion == CODEC_VERSION) {
                RelayV2StorageJson.boolean(value, "failed")
            } else {
                true
            },
            completed = if (codecVersion == CODEC_VERSION) {
                RelayV2StorageJson.boolean(value, "completed")
            } else {
                false
            },
        )
    }

    private fun decodeLifecycleRecord(value: Map<String, Any?>): AgentLifecycleRecord {
        RelayV2StorageJson.requireKeys(
            value,
            "lifecycleEventId",
            "sourceEpoch",
            "identity",
            "state",
            "failure",
            "occurredAtMs",
            "agentEventSeq",
        )
        val state = RelayV2StorageJson.enum<AgentLifecycleState>(value, "state")
        return AgentLifecycleRecord(
            lifecycleEventId = RelayV2StorageJson.string(value, "lifecycleEventId"),
            sourceEpoch = RelayV2StorageJson.string(value, "sourceEpoch"),
            identity = decodeLifecycleIdentity(RelayV2StorageJson.objectValue(value, "identity")),
            state = state,
            failure = RelayV2StorageJson.nullableObject(value, "failure")
                ?.let(::decodeLifecycleFailure),
            occurredAtMs = decodeWireInteger(value, "occurredAtMs"),
            agentEventSeq = RelayV2StorageJson.string(value, "agentEventSeq"),
        )
    }

    private data class LegacyLifecycleRecord(
        val lifecycleEventId: String,
        val sourceEpoch: String,
        val identity: AgentLifecycleIdentity,
        val state: AgentLifecycleState,
        val agentEventSeq: String,
    )

    private data class LegacyLifecycleWitness(
        val eventId: String,
        val agentEventSeq: String,
        val lifecycleIdentity: AgentLifecycleIdentity,
        val sourceEpoch: String,
        val state: AgentLifecycleState,
        val closedEventDigest: AgentClosedEventDigest?,
    ) {
        fun matches(record: LegacyLifecycleRecord): Boolean =
            eventId == record.lifecycleEventId &&
                agentEventSeq == record.agentEventSeq &&
                lifecycleIdentity == record.identity &&
                sourceEpoch == record.sourceEpoch &&
                state == record.state
    }

    private fun decodeLegacyLifecycleRecord(value: Map<String, Any?>): LegacyLifecycleRecord {
        RelayV2StorageJson.requireKeys(
            value,
            "lifecycleEventId",
            "sourceEpoch",
            "identity",
            "state",
            "agentEventSeq",
        )
        return LegacyLifecycleRecord(
            lifecycleEventId = RelayV2StorageJson.string(value, "lifecycleEventId"),
            sourceEpoch = RelayV2StorageJson.string(value, "sourceEpoch"),
            identity = decodeLifecycleIdentity(RelayV2StorageJson.objectValue(value, "identity")),
            state = RelayV2StorageJson.enum(value, "state"),
            agentEventSeq = RelayV2StorageJson.string(value, "agentEventSeq"),
        ).also {
            validateLegacyOpaque(it.lifecycleEventId)
            validateLegacyOpaque(it.sourceEpoch)
            AgentLifecycleIdentity(it.identity.scope, it.identity.runId, it.identity.turnId)
            requireLegacyCounter(it.agentEventSeq, positive = true)
        }
    }

    private fun decodeLegacyEventWitness(value: Map<String, Any?>): LegacyLifecycleWitness {
        RelayV2StorageJson.requireKeys(
            value,
            "eventId",
            "agentEventSeq",
            "lifecycleIdentity",
            "sourceEpoch",
            "state",
            "closedEventDigest",
        )
        return LegacyLifecycleWitness(
            eventId = RelayV2StorageJson.string(value, "eventId"),
            agentEventSeq = RelayV2StorageJson.string(value, "agentEventSeq"),
            lifecycleIdentity = decodeLifecycleIdentity(
                RelayV2StorageJson.objectValue(value, "lifecycleIdentity"),
            ),
            sourceEpoch = RelayV2StorageJson.string(value, "sourceEpoch"),
            state = RelayV2StorageJson.enum(value, "state"),
            closedEventDigest = RelayV2StorageJson.nullableString(
                value,
                "closedEventDigest",
            )?.let(::AgentClosedEventDigest),
        ).also {
            validateLegacyOpaque(it.eventId)
            validateLegacyOpaque(it.sourceEpoch)
            requireLegacyCounter(it.agentEventSeq, positive = true)
        }
    }

    private fun validateLegacyMaterialization(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        lifecycleRecords: List<LegacyLifecycleRecord>,
        appliedBySeq: Map<String, AgentAppliedEventEvidence>,
        witnesses: List<LegacyLifecycleWitness>,
        notificationEntries: List<Map<String, Any?>>,
        oldLastAgentSeq: String,
        oldLocalGeneration: String,
        oldSnapshotSuppressedThrough: String?,
        runsWithTurnRecords: Set<String>,
        pendingStatus: AgentLocalRequestFence?,
        pendingSnapshot: AgentLocalRequestFence?,
        requiresSnapshot: Boolean,
        requiresTimelineRotation: Boolean,
    ) {
        requireLegacyCounter(oldLastAgentSeq)
        requireLegacyCounter(oldLocalGeneration)
        oldSnapshotSuppressedThrough?.let { suppressedThrough ->
            requireLegacyCounter(suppressedThrough)
            if (compareLegacyCounters(suppressedThrough, oldLastAgentSeq) > 0) malformed()
        }
        if (pendingStatus?.localGeneration?.let { it != oldLocalGeneration } == true ||
            pendingSnapshot?.localGeneration?.let { it != oldLocalGeneration } == true ||
            requiresTimelineRotation && !requiresSnapshot
        ) malformed()
        val lifecycleByIdentity = uniqueMap(lifecycleRecords, LegacyLifecycleRecord::identity)
        uniqueMap(lifecycleRecords, LegacyLifecycleRecord::lifecycleEventId)
        if (!hasValidLegacyLifecycleGraph(lifecycleRecords)) malformed()
        val turnRunIds = lifecycleRecords.asSequence()
            .filter { it.identity.scope == AgentLifecycleScope.TURN }
            .map { it.identity.runId }
            .toSet()
        if (!runsWithTurnRecords.containsAll(turnRunIds)) malformed()
        val witnessById = uniqueMap(witnesses, LegacyLifecycleWitness::eventId)
        val witnessBySeq = uniqueMap(witnesses, LegacyLifecycleWitness::agentEventSeq)
        val expectedEventIdBySeq = linkedMapOf<String, String>()
        appliedBySeq.forEach { (sequence, evidence) ->
            requireLegacyCounter(sequence, positive = true)
            if (compareLegacyCounters(sequence, oldLastAgentSeq) > 0) malformed()
            val existing = expectedEventIdBySeq.put(sequence, evidence.eventId)
            if (existing != null && existing != evidence.eventId) malformed()
            val witness = witnessById[evidence.eventId] ?: malformed()
            if (witness.agentEventSeq != sequence ||
                witness.closedEventDigest != evidence.closedEventDigest
            ) malformed()
        }
        witnessBySeq.forEach { (sequence, witness) ->
            if (compareLegacyCounters(sequence, oldLastAgentSeq) > 0) malformed()
            val existing = expectedEventIdBySeq.put(sequence, witness.eventId)
            if (existing != null && existing != witness.eventId) malformed()
        }
        if (expectedEventIdBySeq.values.toSet().size != expectedEventIdBySeq.size) malformed()
        if (!hasValidLegacyWitnessChains(witnesses)) malformed()
        lifecycleByIdentity.values.forEach { record ->
            val exact = witnessById[record.lifecycleEventId]
            val highest = witnesses.asSequence()
                .filter { it.lifecycleIdentity == record.identity }
                .maxWithOrNull(Comparator { left, right ->
                    compareLegacyCounters(left.agentEventSeq, right.agentEventSeq)
                })
            if (exact?.matches(record) != true || highest != exact) malformed()
        }
        val keys = linkedSetOf<AgentNotificationDedupeKey>()
        val eventIds = linkedSetOf<String>()
        notificationEntries.forEach { entry ->
            val pair = decodeLegacyNotificationLedgerEntry(namespace, entry, witnessById)
            if (compareLegacyCounters(pair.localGeneration, oldLocalGeneration) > 0 ||
                !keys.add(pair.key) ||
                !eventIds.add(pair.eventId)
            ) malformed()
        }
    }

    private fun hasValidLegacyWitnessChains(
        witnesses: Collection<LegacyLifecycleWitness>,
    ): Boolean = witnesses.groupBy(LegacyLifecycleWitness::lifecycleIdentity)
        .values
        .all { identityWitnesses ->
            val ordered = identityWitnesses.sortedWith(Comparator { left, right ->
                compareLegacyCounters(left.agentEventSeq, right.agentEventSeq)
            })
            if (ordered.map(LegacyLifecycleWitness::sourceEpoch).toSet().size != 1) {
                return@all false
            }
            val first = ordered.firstOrNull() ?: return@all true
            if (first.closedEventDigest != null && first.state != AgentLifecycleState.RUNNING) {
                return@all false
            }
            ordered.zipWithNext().all { (previous, next) ->
                !previous.state.terminal && if (next.closedEventDigest != null) {
                    isAllowedLifecycleTransition(previous.state, next.state)
                } else {
                    true
                }
            }
        }

    private data class LegacyNotificationLedgerEvidence(
        val key: AgentNotificationDedupeKey,
        val eventId: String,
        val localGeneration: String,
    )

    private fun decodeLegacyNotificationLedgerEntry(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        value: Map<String, Any?>,
        witnesses: Map<String, LegacyLifecycleWitness>,
    ): LegacyNotificationLedgerEvidence {
        RelayV2StorageJson.requireKeys(
            value,
            "dedupeKey",
            "disposition",
            "eventId",
            "localGeneration",
        )
        val key = decodeNotificationKey(RelayV2StorageJson.objectValue(value, "dedupeKey"))
        if (key.profileId != namespace.consumer.profileId ||
            key.hostId != namespace.consumer.hostId ||
            key.hostEpoch != namespace.consumer.hostEpoch ||
            key.scopeId != namespace.consumer.scopeId ||
            key.sessionId != namespace.consumer.sessionId ||
            key.timelineEpoch != namespace.timelineEpoch
        ) malformed()
        RelayV2StorageJson.enum<AgentNotificationDisposition>(value, "disposition")
        val localGeneration = RelayV2StorageJson.string(value, "localGeneration")
        requireLegacyCounter(localGeneration)
        val eventId = RelayV2StorageJson.string(value, "eventId")
        val witness = witnesses[eventId] ?: malformed()
        if (key.lifecycleEventId != eventId || key.state != witness.state) malformed()
        val candidate = when (witness.lifecycleIdentity.scope) {
            AgentLifecycleScope.TURN -> witness.state == AgentLifecycleState.WAITING_FOR_USER ||
                witness.state == AgentLifecycleState.FAILED ||
                witness.state == AgentLifecycleState.COMPLETED
            AgentLifecycleScope.RUN -> witness.state == AgentLifecycleState.FAILED ||
                witness.state == AgentLifecycleState.COMPLETED
        }
        if (!candidate) malformed()
        return LegacyNotificationLedgerEvidence(key, eventId, localGeneration)
    }

    private fun hasValidLegacyLifecycleGraph(records: Collection<LegacyLifecycleRecord>): Boolean =
        records.groupBy { it.identity.runId }.values.all { runRecords ->
            if (runRecords.map { it.sourceEpoch }.toSet().size != 1) return@all false
            val run = runRecords.singleOrNull { it.identity.scope == AgentLifecycleScope.RUN }
            val turns = runRecords.filter { it.identity.scope == AgentLifecycleScope.TURN }
            if (turns.count { !it.state.terminal } > 1) return@all false
            if (run?.state?.terminal == true && turns.any { !it.state.terminal }) return@all false
            if (run?.state == AgentLifecycleState.WAITING_FOR_USER &&
                turns.any { !it.state.terminal && it.state != AgentLifecycleState.WAITING_FOR_USER }
            ) return@all false
            true
        }

    private fun requireLegacyCounter(value: String, positive: Boolean = false) {
        if (!CANONICAL_NON_NEGATIVE_DECIMAL.matches(value)) malformed()
        val decoded = try {
            BigInteger(value)
        } catch (_: NumberFormatException) {
            malformed()
        }
        if (decoded > UINT64_MAX || positive && decoded == BigInteger.ZERO) malformed()
    }

    private fun compareLegacyCounters(left: String, right: String): Int =
        try {
            BigInteger(left).compareTo(BigInteger(right))
        } catch (_: NumberFormatException) {
            malformed()
        }

    private fun maxCounter(left: String?, right: String): String = when {
        left == null -> right
        compareLegacyCounters(left, right) >= 0 -> left
        else -> right
    }

    private fun validateLegacyOpaque(value: String) {
        if (value.isBlank() || value != value.trim() || '\u0000' in value) malformed()
        val encoder = StandardCharsets.UTF_8.newEncoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        if (!encoder.canEncode(value) || value.toByteArray(StandardCharsets.UTF_8).size > 128) {
            malformed()
        }
    }

    private fun decodeLifecycleFailure(value: Map<String, Any?>): AgentLifecycleFailure {
        RelayV2StorageJson.requireKeys(value, "code", "summary")
        return AgentLifecycleFailure(
            code = RelayV2StorageJson.string(value, "code"),
            summary = RelayV2StorageJson.nullableString(value, "summary"),
        )
    }

    private fun decodeWireInteger(value: Map<String, Any?>, name: String): Long {
        val encoded = RelayV2StorageJson.string(value, name)
        if (!CANONICAL_NON_NEGATIVE_DECIMAL.matches(encoded)) malformed()
        return encoded.toLongOrNull()?.takeIf { it <= MAX_WIRE_INTEGER } ?: malformed()
    }

    private fun decodeLifecycleIdentity(value: Map<String, Any?>): AgentLifecycleIdentity {
        RelayV2StorageJson.requireKeys(value, "scope", "runId", "turnId")
        return AgentLifecycleIdentity(
            RelayV2StorageJson.enum(value, "scope"),
            RelayV2StorageJson.string(value, "runId"),
            RelayV2StorageJson.nullableString(value, "turnId"),
        )
    }

    private fun decodeAppliedEvidence(
        value: Map<String, Any?>,
    ): Pair<String, AgentAppliedEventEvidence> {
        RelayV2StorageJson.requireKeys(value, "agentEventSeq", "eventId", "closedEventDigest")
        val sequence = RelayV2StorageJson.string(value, "agentEventSeq")
        return sequence to AgentAppliedEventEvidence(
            RelayV2StorageJson.string(value, "eventId"),
            AgentClosedEventDigest(RelayV2StorageJson.string(value, "closedEventDigest")),
        )
    }

    private fun decodeEventWitness(
        value: Map<String, Any?>,
    ): AgentLifecycleEventIdentityWitness {
        RelayV2StorageJson.requireKeys(
            value,
            "eventId",
            "agentEventSeq",
            "lifecycleIdentity",
            "sourceEpoch",
            "state",
            "failure",
            "occurredAtMs",
            "closedEventDigest",
        )
        return AgentLifecycleEventIdentityWitness(
            eventId = RelayV2StorageJson.string(value, "eventId"),
            agentEventSeq = RelayV2StorageJson.string(value, "agentEventSeq"),
            lifecycleIdentity = decodeLifecycleIdentity(
                RelayV2StorageJson.objectValue(value, "lifecycleIdentity"),
            ),
            sourceEpoch = RelayV2StorageJson.string(value, "sourceEpoch"),
            state = RelayV2StorageJson.enum(value, "state"),
            failure = RelayV2StorageJson.nullableObject(value, "failure")
                ?.let(::decodeLifecycleFailure),
            occurredAtMs = decodeWireInteger(value, "occurredAtMs"),
            closedEventDigest = RelayV2StorageJson.nullableString(
                value,
                "closedEventDigest",
            )?.let(::AgentClosedEventDigest),
        )
    }

    private fun decodeNotificationLedgerEntry(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        value: Map<String, Any?>,
        witnesses: Map<String, AgentLifecycleEventIdentityWitness>,
    ): Pair<AgentNotificationDedupeKey, AgentNotificationLedgerEntry> {
        RelayV2StorageJson.requireKeys(
            value,
            "dedupeKey",
            "disposition",
            "eventId",
            "localGeneration",
        )
        val key = decodeNotificationKey(RelayV2StorageJson.objectValue(value, "dedupeKey"))
        if (key.profileId != namespace.consumer.profileId ||
            key.hostId != namespace.consumer.hostId ||
            key.hostEpoch != namespace.consumer.hostEpoch ||
            key.scopeId != namespace.consumer.scopeId ||
            key.sessionId != namespace.consumer.sessionId ||
            key.timelineEpoch != namespace.timelineEpoch
        ) malformed()
        val eventId = RelayV2StorageJson.string(value, "eventId")
        val witness = witnesses[eventId] ?: malformed()
        return key to AgentNotificationLedgerEntry(
            RelayV2StorageJson.enum(value, "disposition"),
            witness,
            RelayV2StorageJson.string(value, "localGeneration"),
        )
    }

    private fun decodeNotificationKey(value: Map<String, Any?>): AgentNotificationDedupeKey {
        RelayV2StorageJson.requireKeys(
            value,
            "profileId",
            "hostId",
            "hostEpoch",
            "scopeId",
            "sessionId",
            "timelineEpoch",
            "lifecycleEventId",
            "state",
        )
        return AgentNotificationDedupeKey(
            RelayV2StorageJson.string(value, "profileId"),
            RelayV2StorageJson.string(value, "hostId"),
            RelayV2StorageJson.string(value, "hostEpoch"),
            RelayV2StorageJson.string(value, "scopeId"),
            RelayV2StorageJson.string(value, "sessionId"),
            RelayV2StorageJson.string(value, "timelineEpoch"),
            RelayV2StorageJson.string(value, "lifecycleEventId"),
            RelayV2StorageJson.enum(value, "state"),
        )
    }

    private fun decodeSnapshotCheckpoint(value: Map<String, Any?>): AgentSnapshotCheckpoint {
        RelayV2StorageJson.requireKeys(value, "throughAgentSeq", "localGeneration")
        return AgentSnapshotCheckpoint(
            RelayV2StorageJson.string(value, "throughAgentSeq"),
            RelayV2StorageJson.string(value, "localGeneration"),
        )
    }

    private fun decodeRequestFence(value: Map<String, Any?>): AgentLocalRequestFence {
        RelayV2StorageJson.requireKeys(value, "localGeneration", "requestToken")
        return AgentLocalRequestFence(
            RelayV2StorageJson.string(value, "localGeneration"),
            RelayV2StorageJson.string(value, "requestToken"),
        )
    }

    private fun decodeSnapshotPreFirstFence(
        value: Map<String, Any?>,
    ): AgentSnapshotPreFirstFence {
        RelayV2StorageJson.requireKeys(
            value,
            "localGeneration",
            "snapshotRequestId",
            "pageZeroNetworkToken",
        )
        return AgentSnapshotPreFirstFence(
            localGeneration = RelayV2StorageJson.string(value, "localGeneration"),
            snapshotRequestId = RelayV2StorageJson.string(value, "snapshotRequestId"),
            pageZeroNetworkToken = RelayV2StorageJson.string(value, "pageZeroNetworkToken"),
        )
    }

    private fun decodeEffectiveHostLimits(
        value: Map<String, Any?>,
    ): AgentTimelineEffectiveLimits {
        RelayV2StorageJson.requireKeys(
            value,
            "maxTextUtf8Bytes",
            "maxPageRecords",
            "eventReplayRetentionMs",
            "snapshotLeaseMs",
        )
        fun decimal(name: String): Long {
            val encoded = RelayV2StorageJson.string(value, name)
            if (!CANONICAL_POSITIVE_DECIMAL.matches(encoded)) malformed()
            return encoded.toLongOrNull() ?: malformed()
        }
        return AgentTimelineEffectiveLimits(
            maxTextUtf8Bytes = decimal("maxTextUtf8Bytes"),
            maxPageRecords = decimal("maxPageRecords"),
            eventReplayRetentionMs = decimal("eventReplayRetentionMs"),
            snapshotLeaseMs = decimal("snapshotLeaseMs"),
        )
    }

    private fun decodeReplayPageFence(value: Map<String, Any?>): AgentReplayPageFence {
        RelayV2StorageJson.requireKeys(
            value,
            "localGeneration",
            "stableAfterAgentSeq",
            "currentRequestNetworkToken",
            "pinnedReplayThroughAgentSeq",
            "expectedNextCursor",
            "requestedLimit",
        )
        val encodedLimit = RelayV2StorageJson.string(value, "requestedLimit")
        if (!CANONICAL_POSITIVE_DECIMAL.matches(encodedLimit)) malformed()
        return AgentReplayPageFence(
            localGeneration = RelayV2StorageJson.string(value, "localGeneration"),
            stableAfterAgentSeq = RelayV2StorageJson.string(value, "stableAfterAgentSeq"),
            currentRequestNetworkToken = RelayV2StorageJson.string(
                value,
                "currentRequestNetworkToken",
            ),
            pinnedReplayThroughAgentSeq = RelayV2StorageJson.nullableString(
                value,
                "pinnedReplayThroughAgentSeq",
            ),
            expectedNextCursor = RelayV2StorageJson.nullableString(value, "expectedNextCursor"),
            requestedLimit = encodedLimit.toLongOrNull() ?: malformed(),
        )
    }

    private fun decodeSyncState(value: Map<String, Any?>): AgentTimelineSyncState {
        RelayV2StorageJson.requireKeys(
            value,
            "kind",
            "requireSnapshotAfterRefresh",
            "observedCurrentAgentSeq",
            "observedStatusEarliestReplaySeq",
            "replayPageFence",
        )
        val forceSnapshot = RelayV2StorageJson.boolean(value, "requireSnapshotAfterRefresh")
        val observedCurrent = RelayV2StorageJson.nullableString(
            value,
            "observedCurrentAgentSeq",
        )
        val observedEarliest = RelayV2StorageJson.nullableString(
            value,
            "observedStatusEarliestReplaySeq",
        )
        val replayFence = RelayV2StorageJson.nullableObject(value, "replayPageFence")
        return when (RelayV2StorageJson.string(value, "kind")) {
            "current" -> AgentTimelineSyncState.Current.also {
                if (forceSnapshot || observedCurrent != null || observedEarliest != null ||
                    replayFence != null
                ) malformed()
            }
            "replay" -> AgentTimelineSyncState.Replay(
                observedCurrentAgentSeq = observedCurrent ?: malformed(),
                observedStatusEarliestReplaySeq = observedEarliest ?: malformed(),
                pageFence = replayFence?.let(::decodeReplayPageFence),
            ).also { if (forceSnapshot) malformed() }
            "snapshot" -> AgentTimelineSyncState.Snapshot.also {
                if (forceSnapshot || observedCurrent != null || observedEarliest != null ||
                    replayFence != null
                ) malformed()
            }
            "status_refresh" -> AgentTimelineSyncState.StatusRefresh(forceSnapshot).also {
                if (observedCurrent != null || observedEarliest != null || replayFence != null) {
                    malformed()
                }
            }
            else -> incompatible()
        }
    }

    private fun AgentTranscriptLifecycleDurableNamespace.toStorageMap(): Map<String, Any?> =
        linkedMapOf(
            "profileId" to consumer.profileId,
            "profileActivationGeneration" to consumer.profileActivationGeneration.toString(),
            "principalId" to consumer.principalId,
            "clientInstanceId" to consumer.clientInstanceId,
            "hostId" to consumer.hostId,
            "hostEpoch" to consumer.hostEpoch,
            "scopeId" to consumer.scopeId,
            "sessionId" to consumer.sessionId,
            "timelineEpoch" to timelineEpoch,
        )

    private fun AgentTranscriptLifecycleClientState.toStorageMap(): Map<String, Any?> =
        linkedMapOf(
            "identity" to identity.toStorageMap(),
            "notificationConfig" to notificationConfig.toStorageMap(),
            "extension" to extensionLane.toStorageMap(),
        )

    private fun AgentExtensionSessionIdentity.toStorageMap(): Map<String, Any?> = linkedMapOf(
        "profileId" to profileId,
        "hostId" to hostId,
        "hostEpoch" to hostEpoch,
        "scopeId" to scopeId,
        "sessionId" to sessionId,
    )

    private fun AgentNotificationConfig.toStorageMap(): Map<String, Any?> = linkedMapOf(
        "permission" to permission.name,
        "profileActive" to profileActive,
        "policy" to policy.name,
        "waitingForUser" to waitingForUser,
        "failed" to failed,
        "completed" to completed,
    )

    private fun AgentTranscriptLifecycleExtensionState.toStorageMap(): Map<String, Any?> =
        linkedMapOf(
            "localGeneration" to localGeneration,
            "support" to support.name,
            "unavailableReason" to unavailableReason?.name,
            "liveSource" to liveSource?.name,
            "activeSourceEpoch" to activeSourceEpoch,
            "timelineEpoch" to timelineEpoch,
            "lastAgentSeq" to lastAgentSeq,
            "effectiveHostLimits" to effectiveHostLimits?.toStorageMap(),
            "syncState" to syncState.toStorageMap(),
            "notificationBaselineAgentSeq" to notificationBaselineAgentSeq,
            "retiredTimelineEpochs" to retiredTimelineEpochs.sorted(),
            "retiredEpochCompactionGeneration" to retiredEpochCompactionGeneration,
            "snapshotCheckpoint" to snapshotCheckpoint?.toStorageMap(),
            "snapshotNotificationSuppressedThroughAgentSeq" to
                snapshotNotificationSuppressedThroughAgentSeq,
            "pendingStatusRequest" to pendingStatusRequest?.toStorageMap(),
            "pendingSnapshotRequest" to pendingSnapshotRequest?.toStorageMap(),
            "requiresTimelineRotation" to requiresTimelineRotation,
        )

    private fun AgentTranscriptLifecycleExtensionState.hasNoRowOwnedMaterialization(): Boolean =
        lifecycleByIdentity.isEmpty() &&
            currentLifecycleIdentityByEventId.isEmpty() &&
            runsWithTurnRecords.isEmpty() &&
            appliedEventsBySeq.isEmpty() &&
            eventWitnessById.isEmpty() &&
            eventIdBySeq.isEmpty() &&
            notificationLedger.isEmpty() &&
            notificationKeyByLifecycleEventId.isEmpty()

    private fun AgentLifecycleRecord.toStorageMap(): Map<String, Any?> = linkedMapOf(
        "lifecycleEventId" to lifecycleEventId,
        "sourceEpoch" to sourceEpoch,
        "identity" to identity.toStorageMap(),
        "state" to state.name,
        "failure" to failure?.toStorageMap(),
        "occurredAtMs" to occurredAtMs.toString(),
        "agentEventSeq" to agentEventSeq,
    )

    private fun AgentLifecycleFailure.toStorageMap(): Map<String, Any?> = linkedMapOf(
        "code" to code,
        "summary" to summary,
    )

    private fun AgentLifecycleIdentity.toStorageMap(): Map<String, Any?> = linkedMapOf(
        "scope" to scope.name,
        "runId" to runId,
        "turnId" to turnId,
    )

    private fun AgentLifecycleEventIdentityWitness.toStorageMap(): Map<String, Any?> = linkedMapOf(
        "eventId" to eventId,
        "agentEventSeq" to agentEventSeq,
        "lifecycleIdentity" to lifecycleIdentity.toStorageMap(),
        "sourceEpoch" to sourceEpoch,
        "state" to state.name,
        "failure" to failure?.toStorageMap(),
        "occurredAtMs" to occurredAtMs.toString(),
        "closedEventDigest" to closedEventDigest?.value,
    )

    private fun AgentNotificationDedupeKey.toStorageMap(): Map<String, Any?> = linkedMapOf(
        "profileId" to profileId,
        "hostId" to hostId,
        "hostEpoch" to hostEpoch,
        "scopeId" to scopeId,
        "sessionId" to sessionId,
        "timelineEpoch" to timelineEpoch,
        "lifecycleEventId" to lifecycleEventId,
        "state" to state.name,
    )

    private fun AgentSnapshotCheckpoint.toStorageMap(): Map<String, Any?> = linkedMapOf(
        "throughAgentSeq" to throughAgentSeq,
        "localGeneration" to localGeneration,
    )

    private fun AgentLocalRequestFence.toStorageMap(): Map<String, Any?> = linkedMapOf(
        "localGeneration" to localGeneration,
        "requestToken" to requestToken,
    )

    private fun AgentSnapshotPreFirstFence.toStorageMap(): Map<String, Any?> = linkedMapOf(
        "localGeneration" to localGeneration,
        "snapshotRequestId" to snapshotRequestId,
        "pageZeroNetworkToken" to pageZeroNetworkToken,
    )

    private fun AgentTimelineEffectiveLimits.toStorageMap(): Map<String, Any?> = linkedMapOf(
        "maxTextUtf8Bytes" to maxTextUtf8Bytes.toString(),
        "maxPageRecords" to maxPageRecords.toString(),
        "eventReplayRetentionMs" to eventReplayRetentionMs.toString(),
        "snapshotLeaseMs" to snapshotLeaseMs.toString(),
    )

    private fun AgentTranscriptDurableStorageAccounting.toStorageMap(): Map<String, Any?> =
        linkedMapOf(
            "entryCount" to entryCount.toString(),
            "entryCanonicalBytes" to entryCanonicalBytes.toString(),
            "entryTextUtf8Bytes" to entryTextUtf8Bytes.toString(),
            "pendingLiveEventCount" to pendingLiveEventCount.toString(),
            "pendingLiveEventCanonicalBytes" to pendingLiveEventCanonicalBytes.toString(),
            "pendingLiveEventRawUtf8Bytes" to pendingLiveEventRawUtf8Bytes.toString(),
            "lifecycleCurrentCount" to lifecycleCurrentCount.toString(),
            "lifecycleCurrentCanonicalBytes" to lifecycleCurrentCanonicalBytes.toString(),
            "lifecycleWitnessCount" to lifecycleWitnessCount.toString(),
            "lifecycleWitnessCanonicalBytes" to lifecycleWitnessCanonicalBytes.toString(),
            "recentEventEvidenceCount" to recentEventEvidenceCount.toString(),
            "recentEventEvidenceCanonicalBytes" to
                recentEventEvidenceCanonicalBytes.toString(),
            "notificationLedgerCount" to notificationLedgerCount.toString(),
            "notificationLedgerCanonicalBytes" to
                notificationLedgerCanonicalBytes.toString(),
        )

    private fun AgentReplayPageFence.toStorageMap(): Map<String, Any?> = linkedMapOf(
        "localGeneration" to localGeneration,
        "stableAfterAgentSeq" to stableAfterAgentSeq,
        "currentRequestNetworkToken" to currentRequestNetworkToken,
        "pinnedReplayThroughAgentSeq" to pinnedReplayThroughAgentSeq,
        "expectedNextCursor" to expectedNextCursor,
        "requestedLimit" to requestedLimit.toString(),
    )

    private fun AgentTimelineSyncState.toStorageMap(): Map<String, Any?> = when (this) {
        AgentTimelineSyncState.Current -> syncStorageMap("current")
        AgentTimelineSyncState.Snapshot -> syncStorageMap("snapshot")
        is AgentTimelineSyncState.StatusRefresh -> syncStorageMap(
            kind = "status_refresh",
            requireSnapshotAfterRefresh = requireSnapshotAfterRefresh,
        )
        is AgentTimelineSyncState.Replay -> syncStorageMap(
            kind = "replay",
            observedCurrentAgentSeq = observedCurrentAgentSeq,
            observedStatusEarliestReplaySeq = observedStatusEarliestReplaySeq,
            replayPageFence = pageFence?.toStorageMap(),
        )
    }

    private fun syncStorageMap(
        kind: String,
        requireSnapshotAfterRefresh: Boolean = false,
        observedCurrentAgentSeq: String? = null,
        observedStatusEarliestReplaySeq: String? = null,
        replayPageFence: Map<String, Any?>? = null,
    ): Map<String, Any?> = linkedMapOf(
        "kind" to kind,
        "requireSnapshotAfterRefresh" to requireSnapshotAfterRefresh,
        "observedCurrentAgentSeq" to observedCurrentAgentSeq,
        "observedStatusEarliestReplaySeq" to observedStatusEarliestReplaySeq,
        "replayPageFence" to replayPageFence,
    )

    private fun <T, K> uniqueMap(values: List<T>, key: (T) -> K): Map<K, T> {
        val result = linkedMapOf<K, T>()
        values.forEach { value ->
            if (result.put(key(value), value) != null) malformed()
        }
        return result
    }

    private fun List<String>.toUniqueSet(): Set<String> {
        val result = toCollection(linkedSetOf())
        if (result.size != size) malformed()
        return result
    }

    private fun <T> compareByCounter(value: (T) -> String): Comparator<T> = Comparator { a, b ->
        BigInteger(value(a)).compareTo(BigInteger(value(b)))
    }

    private val lifecycleRecordComparator = Comparator<AgentLifecycleRecord> { left, right ->
        compareCanonicalAgentOrder(
            left.agentEventSeq,
            left.lifecycleEventId,
            right.agentEventSeq,
            right.lifecycleEventId,
        )
    }

    private val eventWitnessComparator =
        Comparator<AgentLifecycleEventIdentityWitness> { left, right ->
            compareCanonicalAgentOrder(
                left.agentEventSeq,
                left.eventId,
                right.agentEventSeq,
                right.eventId,
            )
        }

    private fun malformed(): Nothing =
        throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)

    private fun incompatible(): Nothing =
        throw RelayV2StorageException(RelayV2StorageFailure.SCHEMA_INCOMPATIBLE)

    private const val PAYLOAD_KIND = "agent_transcript_lifecycle_client_state"
    private const val LEGACY_CODEC_VERSION = 1
    private const val PREVIOUS_CODEC_VERSION = 2
    private const val MAX_APPLIED_EVENT_EVIDENCE = 4_096
    private const val MAX_EVENT_IDENTITY_WITNESSES = 4_096
    private const val MAX_LIFECYCLE_RECORDS = 2_048
    private const val MAX_EVER_TURN_MARKERS = 2_048
    private const val MAX_NOTIFICATION_LEDGER_ENTRIES = 4_096
    private const val MAX_RETIRED_TIMELINES = 256
    private const val MAX_WIRE_INTEGER = 9_007_199_254_740_991L
    private val UINT64_MAX = BigInteger("18446744073709551615")
    private val CANONICAL_NON_NEGATIVE_DECIMAL = Regex("^(?:0|[1-9][0-9]*)$")
    private val CANONICAL_POSITIVE_DECIMAL = Regex("^[1-9][0-9]*$")

    private val JSON_LIMITS = RelayV2JsonLimits(
        maxDepth = 16,
        maxDirectKeys = 64,
        maxTotalKeys = 200_000,
        maxNodes = 400_000,
    )
}
