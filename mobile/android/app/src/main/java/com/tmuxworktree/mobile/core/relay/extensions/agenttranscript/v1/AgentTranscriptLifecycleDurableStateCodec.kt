package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2EncodedPayload
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageException
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageFailure
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageJson
import java.math.BigInteger

/** Closed, digest-protected codec for the complete durable Android consumer reducer state. */
internal object AgentTranscriptLifecycleDurableStateCodec {
    const val CODEC_VERSION = 1
    const val MAX_PAYLOAD_UTF8_BYTES = 16_777_216

    fun encode(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        state: AgentTranscriptLifecycleClientState,
    ): RelayV2EncodedPayload {
        require(state.identity == namespace.consumer.sessionIdentity)
        require(state.extensionLane.timelineEpoch == namespace.timelineEpoch)
        return RelayV2StorageJson.encode(
            CODEC_VERSION,
            linkedMapOf(
                "kind" to PAYLOAD_KIND,
                "namespace" to namespace.toStorageMap(),
                "state" to state.toStorageMap(),
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
    ): AgentTranscriptLifecycleClientState = try {
        val root = RelayV2StorageJson.decode(
            payload,
            expectedCodecVersion = CODEC_VERSION,
            maxPayloadBytes = MAX_PAYLOAD_UTF8_BYTES,
            limits = JSON_LIMITS,
        )
        RelayV2StorageJson.requireKeys(root, "kind", "namespace", "state")
        if (RelayV2StorageJson.string(root, "kind") != PAYLOAD_KIND) incompatible()
        val storedNamespace = decodeNamespace(RelayV2StorageJson.objectValue(root, "namespace"))
        if (storedNamespace != expectedNamespace) malformed()
        decodeState(
            storedNamespace,
            RelayV2StorageJson.objectValue(root, "state"),
        ).also { state ->
            if (state.identity != expectedNamespace.consumer.sessionIdentity ||
                state.extensionLane.timelineEpoch != expectedNamespace.timelineEpoch
            ) malformed()
        }
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
    ): AgentTranscriptLifecycleClientState {
        RelayV2StorageJson.requireKeys(value, "identity", "notificationConfig", "extension")
        val identity = decodeSessionIdentity(RelayV2StorageJson.objectValue(value, "identity"))
        if (identity != namespace.consumer.sessionIdentity) malformed()
        val notificationConfig = decodeNotificationConfig(
            RelayV2StorageJson.objectValue(value, "notificationConfig"),
        )
        val extension = decodeExtension(
            namespace,
            RelayV2StorageJson.objectValue(value, "extension"),
        )
        return AgentTranscriptLifecycleClientState(identity, extension, notificationConfig)
    }

    private fun decodeExtension(
        namespace: AgentTranscriptLifecycleDurableNamespace,
        value: Map<String, Any?>,
    ): AgentTranscriptLifecycleExtensionState {
        RelayV2StorageJson.requireKeys(
            value,
            "localGeneration",
            "support",
            "unavailableReason",
            "liveSource",
            "activeSourceEpoch",
            "timelineEpoch",
            "lastAgentSeq",
            "notificationBaselineAgentSeq",
            "lifecycleRecords",
            "runsWithTurnRecords",
            "appliedEventEvidence",
            "eventIdentityWitnesses",
            "notificationLedger",
            "retiredTimelineEpochs",
            "retiredEpochCompactionGeneration",
            "snapshotCheckpoint",
            "snapshotNotificationSuppressedThroughAgentSeq",
            "pendingStatusRequest",
            "pendingSnapshotRequest",
            "requiresSnapshot",
            "requiresTimelineRotation",
        )
        val timelineEpoch = RelayV2StorageJson.nullableString(value, "timelineEpoch")
        if (timelineEpoch != namespace.timelineEpoch) malformed()

        val lifecycleRecords = RelayV2StorageJson.list(
            value,
            "lifecycleRecords",
            MAX_LIFECYCLE_RECORDS,
        ).map { decodeLifecycleRecord(RelayV2StorageJson.objectValue(it)) }
        val lifecycleByIdentity = uniqueMap(lifecycleRecords, AgentLifecycleRecord::identity)
        val lifecycleEventIndex = uniqueMap(lifecycleRecords, AgentLifecycleRecord::lifecycleEventId)
            .mapValues { (_, record) -> record.identity }

        val appliedEvidence = RelayV2StorageJson.list(
            value,
            "appliedEventEvidence",
            MAX_APPLIED_EVENT_EVIDENCE,
        ).map { decodeAppliedEvidence(RelayV2StorageJson.objectValue(it)) }
        val appliedBySeq = uniqueMap(appliedEvidence) { it.first }
            .mapValues { (_, pair) -> pair.second }

        val witnesses = RelayV2StorageJson.list(
            value,
            "eventIdentityWitnesses",
            MAX_EVENT_IDENTITY_WITNESSES,
        ).map { decodeEventWitness(RelayV2StorageJson.objectValue(it)) }
        val witnessById = uniqueMap(witnesses, AgentLifecycleEventIdentityWitness::eventId)
        val eventIdBySeq = uniqueMap(witnesses, AgentLifecycleEventIdentityWitness::agentEventSeq)
            .mapValues { (_, witness) -> witness.eventId }

        val notificationEntries = RelayV2StorageJson.list(
            value,
            "notificationLedger",
            MAX_NOTIFICATION_LEDGER_ENTRIES,
        ).map { item ->
            decodeNotificationLedgerEntry(
                namespace,
                RelayV2StorageJson.objectValue(item),
                witnessById,
            )
        }
        val notificationLedger = uniqueMap(notificationEntries) { it.first }
            .mapValues { (_, pair) -> pair.second }
        val notificationIndex = uniqueMap(notificationEntries) { it.first.lifecycleEventId }
            .mapValues { (_, pair) -> pair.first }

        return AgentTranscriptLifecycleExtensionState(
            localGeneration = RelayV2StorageJson.string(value, "localGeneration"),
            support = RelayV2StorageJson.enum(value, "support"),
            unavailableReason = RelayV2StorageJson
                .nullableEnum<AgentExtensionUnavailableReason>(value, "unavailableReason"),
            liveSource = RelayV2StorageJson
                .nullableEnum<AgentLiveSourceState>(value, "liveSource"),
            activeSourceEpoch = RelayV2StorageJson.nullableString(value, "activeSourceEpoch"),
            timelineEpoch = timelineEpoch,
            lastAgentSeq = RelayV2StorageJson.string(value, "lastAgentSeq"),
            notificationBaselineAgentSeq = RelayV2StorageJson.nullableString(
                value,
                "notificationBaselineAgentSeq",
            ),
            lifecycleByIdentity = lifecycleByIdentity,
            currentLifecycleIdentityByEventId = lifecycleEventIndex,
            runsWithTurnRecords = RelayV2StorageJson.stringList(
                value,
                "runsWithTurnRecords",
                MAX_EVER_TURN_MARKERS,
            ).toUniqueSet(),
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
            snapshotCheckpoint = RelayV2StorageJson.nullableObject(
                value,
                "snapshotCheckpoint",
            )?.let(::decodeSnapshotCheckpoint),
            snapshotNotificationSuppressedThroughAgentSeq = RelayV2StorageJson.nullableString(
                value,
                "snapshotNotificationSuppressedThroughAgentSeq",
            ),
            pendingStatusRequest = RelayV2StorageJson.nullableObject(
                value,
                "pendingStatusRequest",
            )?.let(::decodeRequestFence),
            pendingSnapshotRequest = RelayV2StorageJson.nullableObject(
                value,
                "pendingSnapshotRequest",
            )?.let(::decodeRequestFence),
            requiresSnapshot = RelayV2StorageJson.boolean(value, "requiresSnapshot"),
            requiresTimelineRotation = RelayV2StorageJson.boolean(
                value,
                "requiresTimelineRotation",
            ),
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
        val activation = RelayV2StorageJson.string(value, "profileActivationGeneration")
            .toLongOrNull()?.takeIf { it > 0 } ?: malformed()
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

    private fun decodeNotificationConfig(value: Map<String, Any?>): AgentNotificationConfig {
        RelayV2StorageJson.requireKeys(value, "permission", "profileActive", "policy")
        return AgentNotificationConfig(
            permission = RelayV2StorageJson.enum(value, "permission"),
            profileActive = RelayV2StorageJson.boolean(value, "profileActive"),
            policy = RelayV2StorageJson.enum(value, "policy"),
        )
    }

    private fun decodeLifecycleRecord(value: Map<String, Any?>): AgentLifecycleRecord {
        RelayV2StorageJson.requireKeys(
            value,
            "lifecycleEventId",
            "sourceEpoch",
            "identity",
            "state",
            "agentEventSeq",
        )
        return AgentLifecycleRecord(
            RelayV2StorageJson.string(value, "lifecycleEventId"),
            RelayV2StorageJson.string(value, "sourceEpoch"),
            decodeLifecycleIdentity(RelayV2StorageJson.objectValue(value, "identity")),
            RelayV2StorageJson.enum(value, "state"),
            RelayV2StorageJson.string(value, "agentEventSeq"),
        )
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
            "notificationBaselineAgentSeq" to notificationBaselineAgentSeq,
            "lifecycleRecords" to lifecycleByIdentity.values
                .sortedWith(lifecycleRecordComparator)
                .map { it.toStorageMap() },
            "runsWithTurnRecords" to runsWithTurnRecords.sorted(),
            "appliedEventEvidence" to appliedEventsBySeq.entries
                .sortedWith(compareByCounter { it.key })
                .map { (sequence, evidence) ->
                    linkedMapOf(
                        "agentEventSeq" to sequence,
                        "eventId" to evidence.eventId,
                        "closedEventDigest" to evidence.closedEventDigest.value,
                    )
                },
            "eventIdentityWitnesses" to eventWitnessById.values
                .sortedWith(eventWitnessComparator)
                .map { it.toStorageMap() },
            "notificationLedger" to notificationLedger.entries
                .sortedWith(compareBy({ it.key.lifecycleEventId }, { it.key.state.name }))
                .map { (key, entry) ->
                    linkedMapOf(
                        "dedupeKey" to key.toStorageMap(),
                        "disposition" to entry.disposition.name,
                        "eventId" to entry.eventIdentity.eventId,
                        "localGeneration" to entry.localGeneration,
                    )
                },
            "retiredTimelineEpochs" to retiredTimelineEpochs.sorted(),
            "retiredEpochCompactionGeneration" to retiredEpochCompactionGeneration,
            "snapshotCheckpoint" to snapshotCheckpoint?.toStorageMap(),
            "snapshotNotificationSuppressedThroughAgentSeq" to
                snapshotNotificationSuppressedThroughAgentSeq,
            "pendingStatusRequest" to pendingStatusRequest?.toStorageMap(),
            "pendingSnapshotRequest" to pendingSnapshotRequest?.toStorageMap(),
            "requiresSnapshot" to requiresSnapshot,
            "requiresTimelineRotation" to requiresTimelineRotation,
        )

    private fun AgentLifecycleRecord.toStorageMap(): Map<String, Any?> = linkedMapOf(
        "lifecycleEventId" to lifecycleEventId,
        "sourceEpoch" to sourceEpoch,
        "identity" to identity.toStorageMap(),
        "state" to state.name,
        "agentEventSeq" to agentEventSeq,
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

    private val lifecycleRecordComparator = compareByCounter<AgentLifecycleRecord> {
        it.agentEventSeq
    }.thenBy { it.lifecycleEventId }

    private val eventWitnessComparator = compareByCounter<AgentLifecycleEventIdentityWitness> {
        it.agentEventSeq
    }.thenBy { it.eventId }

    private fun malformed(): Nothing =
        throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)

    private fun incompatible(): Nothing =
        throw RelayV2StorageException(RelayV2StorageFailure.SCHEMA_INCOMPATIBLE)

    private const val PAYLOAD_KIND = "agent_transcript_lifecycle_client_state"
    private const val MAX_APPLIED_EVENT_EVIDENCE = 4_096
    private const val MAX_EVENT_IDENTITY_WITNESSES = 4_096
    private const val MAX_LIFECYCLE_RECORDS = 2_048
    private const val MAX_EVER_TURN_MARKERS = 2_048
    private const val MAX_NOTIFICATION_LEDGER_ENTRIES = 4_096
    private const val MAX_RETIRED_TIMELINES = 256

    private val JSON_LIMITS = RelayV2JsonLimits(
        maxDepth = 16,
        maxDirectKeys = 64,
        maxTotalKeys = 200_000,
        maxNodes = 400_000,
    )
}
