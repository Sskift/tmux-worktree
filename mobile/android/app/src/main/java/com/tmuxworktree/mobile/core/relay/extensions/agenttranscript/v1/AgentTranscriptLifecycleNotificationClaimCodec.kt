package com.tmuxworktree.mobile.core.relay.extensions.agenttranscript.v1

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2EncodedPayload
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageException
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageFailure
import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2StorageJson

/** Closed, content-free evidence for one committed notification claim. */
internal object AgentTranscriptLifecycleNotificationClaimCodec {
    const val CODEC_VERSION = 1
    const val MAX_PAYLOAD_UTF8_BYTES = 16_384

    fun encode(
        key: AgentTranscriptLifecycleNotificationClaimKey,
        intent: AgentSystemNotificationIntent,
    ): RelayV2EncodedPayload {
        require(intent.dedupeKey == key.dedupeKey)
        return RelayV2StorageJson.encode(
            CODEC_VERSION,
            linkedMapOf(
                "kind" to PAYLOAD_KIND,
                "namespace" to key.consumer.toStorageMap(),
                "intent" to intent.toStorageMap(),
            ),
        ).also { payload ->
            if (payload.payloadUtf8Bytes > MAX_PAYLOAD_UTF8_BYTES) {
                throw RelayV2StorageException(RelayV2StorageFailure.LIMIT_EXCEEDED)
            }
        }
    }

    fun decode(
        expectedKey: AgentTranscriptLifecycleNotificationClaimKey,
        expectedLocalGeneration: String,
        payload: RelayV2EncodedPayload,
    ): AgentSystemNotificationIntent = try {
        val root = RelayV2StorageJson.decode(
            payload,
            expectedCodecVersion = CODEC_VERSION,
            maxPayloadBytes = MAX_PAYLOAD_UTF8_BYTES,
            limits = JSON_LIMITS,
        )
        RelayV2StorageJson.requireKeys(root, "kind", "namespace", "intent")
        if (RelayV2StorageJson.string(root, "kind") != PAYLOAD_KIND) incompatible()
        val consumer = decodeConsumer(RelayV2StorageJson.objectValue(root, "namespace"))
        val intent = decodeIntent(RelayV2StorageJson.objectValue(root, "intent"))
        val actualKey = AgentTranscriptLifecycleNotificationClaimKey(
            consumer,
            intent.dedupeKey.timelineEpoch,
            intent.dedupeKey.lifecycleEventId,
            intent.dedupeKey.state,
        )
        if (actualKey != expectedKey ||
            intent.dedupeKey != expectedKey.dedupeKey ||
            intent.localGeneration != expectedLocalGeneration
        ) malformed()
        intent
    } catch (error: RelayV2StorageException) {
        throw error
    } catch (_: IllegalArgumentException) {
        malformed()
    } catch (_: IllegalStateException) {
        malformed()
    }

    private fun decodeConsumer(
        value: Map<String, Any?>,
    ): AgentTranscriptLifecycleDurableConsumerIdentity {
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
        )
        val encodedActivation = RelayV2StorageJson.string(
            value,
            "profileActivationGeneration",
        )
        if (!CANONICAL_POSITIVE_DECIMAL.matches(encodedActivation)) malformed()
        val activation = encodedActivation.toLongOrNull() ?: malformed()
        return AgentTranscriptLifecycleDurableConsumerIdentity(
            RelayV2StorageJson.string(value, "profileId"),
            activation,
            RelayV2StorageJson.string(value, "principalId"),
            RelayV2StorageJson.string(value, "clientInstanceId"),
            RelayV2StorageJson.string(value, "hostId"),
            RelayV2StorageJson.string(value, "hostEpoch"),
            RelayV2StorageJson.string(value, "scopeId"),
            RelayV2StorageJson.string(value, "sessionId"),
        )
    }

    private fun decodeIntent(value: Map<String, Any?>): AgentSystemNotificationIntent {
        RelayV2StorageJson.requireKeys(value, "dedupeKey", "localGeneration")
        return AgentSystemNotificationIntent(
            decodeDedupeKey(RelayV2StorageJson.objectValue(value, "dedupeKey")),
            RelayV2StorageJson.string(value, "localGeneration"),
        )
    }

    private fun decodeDedupeKey(value: Map<String, Any?>): AgentNotificationDedupeKey {
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

    private fun AgentTranscriptLifecycleDurableConsumerIdentity.toStorageMap(): Map<String, Any?> =
        linkedMapOf(
            "profileId" to profileId,
            "profileActivationGeneration" to profileActivationGeneration.toString(),
            "principalId" to principalId,
            "clientInstanceId" to clientInstanceId,
            "hostId" to hostId,
            "hostEpoch" to hostEpoch,
            "scopeId" to scopeId,
            "sessionId" to sessionId,
        )

    private fun AgentSystemNotificationIntent.toStorageMap(): Map<String, Any?> = linkedMapOf(
        "dedupeKey" to dedupeKey.toStorageMap(),
        "localGeneration" to localGeneration,
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

    private fun malformed(): Nothing =
        throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)

    private fun incompatible(): Nothing =
        throw RelayV2StorageException(RelayV2StorageFailure.SCHEMA_INCOMPATIBLE)

    private const val PAYLOAD_KIND = "agent_transcript_lifecycle_notification_claim"
    private val CANONICAL_POSITIVE_DECIMAL = Regex("^[1-9][0-9]*$")
    private val JSON_LIMITS = RelayV2JsonLimits(
        maxDepth = 6,
        maxDirectKeys = 16,
        maxTotalKeys = 40,
        maxNodes = 80,
    )
}
