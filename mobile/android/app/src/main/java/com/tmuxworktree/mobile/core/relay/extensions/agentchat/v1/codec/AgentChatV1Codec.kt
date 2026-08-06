package com.tmuxworktree.mobile.core.relay.extensions.agentchat.v1.codec

import com.tmuxworktree.mobile.core.relay.v1.AgentChatSteeredMessage
import com.tmuxworktree.mobile.core.relay.v1.AgentChatTurnView
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonException
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonObject
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2SchemaException
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
import com.tmuxworktree.mobile.core.relay.v2.codec.exactKeys
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonArray
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonBoolean
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonId
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonInteger
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonLiteral
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonNull
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonObject
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonOneOf
import com.tmuxworktree.mobile.core.relay.v2.codec.jsonString
import com.tmuxworktree.mobile.core.relay.v2.codec.required
import com.tmuxworktree.mobile.core.relay.v2.codec.schemaFailure
import java.nio.charset.StandardCharsets

/** Relay v2 wire name for the optional agent.chat.v1 extension. See the relay v1 sibling
 *  [com.tmuxworktree.mobile.core.relay.runtime.RelayChatState.V1_AGENT_CHAT_CAPABILITY]
 *  ("agent-chat-v1"). */
const val AGENT_CHAT_V1_CAPABILITY = "agent.chat.v1"

class AgentChatV1CodecException(
    val code: String,
    val failureClass: String,
) : IllegalArgumentException(
    if (code == "PROTOCOL_UNSUPPORTED") {
        "Agent chat transport encoding is unsupported"
    } else {
        "Agent chat public frame is invalid"
    },
)

/** Transport metadata required by the strict public-frame boundary. */
data class AgentChatV1FrameMetadata(
    val opcode: String = "text",
    val compressed: Boolean = false,
)

/** Closed public-wire union for the optional agent.chat.v1 extension. */
sealed interface AgentChatV1Frame {
    val kind: String
    val type: String
}

data class AgentChatV1SteeredMessage(
    val message: String,
    val sentAt: String,
)

/**
 * A v2 wire turn. The frozen schema requires every status-derived field to be present
 * (nullable), so this DTO carries explicit nulls. [toView] converts to the v1 UI view that
 * omits undefined fields.
 */
data class AgentChatV1Turn(
    val turnId: String,
    val session: String,
    val userMessage: String,
    val status: String,
    val reply: String? = null,
    val error: String? = null,
    val sentAt: String,
    val completedAt: String? = null,
    val steeredMessages: List<AgentChatV1SteeredMessage> = emptyList(),
) {
    fun toView(): AgentChatTurnView = AgentChatTurnView(
        turnId = turnId,
        session = session,
        userMessage = userMessage,
        status = status,
        reply = reply,
        error = error,
        sentAt = sentAt,
        completedAt = completedAt,
        steeredMessages = steeredMessages.map { AgentChatSteeredMessage(it.message, it.sentAt) },
    )
}

data class AgentChatV1SendRequest(
    val session: String,
    val message: String,
    val requestId: String,
    val hostId: String,
    val expectedHostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : AgentChatV1Frame {
    override val kind: String = "request"
    override val type: String = "agent.chat.send"
}

data class AgentChatV1HistoryRequest(
    val session: String,
    val limit: Int?,
    val requestId: String,
    val hostId: String,
    val expectedHostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : AgentChatV1Frame {
    override val kind: String = "request"
    override val type: String = "agent.chat.history"
}

data class AgentChatV1Sent(
    val session: String,
    val turnId: String,
    val requestId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : AgentChatV1Frame {
    override val kind: String = "response"
    override val type: String = "agent.chat.sent"
}

data class AgentChatV1Event(
    val session: String,
    val turn: AgentChatV1Turn,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : AgentChatV1Frame {
    override val kind: String = "event"
    override val type: String = "agent.chat.event"
}

data class AgentChatV1HistoryResult(
    val session: String,
    val turns: List<AgentChatV1Turn>,
    val requestId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : AgentChatV1Frame {
    override val kind: String = "response"
    override val type: String = "agent.chat.history.result"
}

data class AgentChatV1Error(
    val requestId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val code: String,
    val message: String,
    val retryable: Boolean,
) : AgentChatV1Frame {
    override val kind: String = "response"
    override val type: String = "error"
}

/**
 * Strict codec for the optional public `agent.chat.v1` wire only.
 *
 * This codec does not negotiate the capability and does not consume base frames. Its DTOs carry
 * only structure explicitly frozen by the extension contract (mirroring the Node host/broker
 * codec).
 */
class AgentChatV1Codec {
    fun decodePublicFrame(
        bytes: ByteArray,
        metadata: AgentChatV1FrameMetadata = AgentChatV1FrameMetadata(),
    ): AgentChatV1Frame = mapCodecFailures {
        if (metadata.opcode != "text") {
            throw AgentChatV1CodecException("INVALID_ENVELOPE", "binary-frame")
        }
        if (metadata.compressed) {
            throw AgentChatV1CodecException("PROTOCOL_UNSUPPORTED", "compression-not-allowed")
        }
        if (bytes.size > MAX_PUBLIC_FRAME_BYTES) {
            throw AgentChatV1CodecException("INVALID_ENVELOPE", "frame-limit")
        }
        val source = RelayV2StrictJson.decodeUtf8(bytes)
        val inspection = RelayV2StrictJson.inspect(source, STANDARD_JSON_LIMITS)
        if (inspection.totalKeys > STANDARD_JSON_LIMITS.maxTotalKeys) {
            throw AgentChatV1CodecException("INVALID_ENVELOPE", "json-total-key-limit")
        }
        if (inspection.totalNodes > STANDARD_JSON_LIMITS.maxNodes) {
            throw AgentChatV1CodecException("INVALID_ENVELOPE", "json-node-limit")
        }
        decodeFrame(RelayV2StrictJson.parseObject(source, STANDARD_JSON_LIMITS))
    }

    fun encodePublicFrame(frame: AgentChatV1Frame): ByteArray = mapCodecFailures {
        val wireObject = frame.toWireObject()
        decodeFrame(wireObject)
        val bytes = RelayV2StrictJson.stringify(wireObject).toByteArray(StandardCharsets.UTF_8)
        if (bytes.size > MAX_PUBLIC_FRAME_BYTES) {
            throw AgentChatV1CodecException("INVALID_ENVELOPE", "frame-limit")
        }
        decodePublicFrame(bytes)
        bytes
    }

    private fun decodeFrame(frame: RelayV2JsonObject): AgentChatV1Frame {
        val type = stringValue(required(frame, "type"), maxBytes = MAX_ID_BYTES)
        return when (type) {
            "error" -> decodeError(frame)
            "agent.chat.send" -> decodeSend(frame)
            "agent.chat.history" -> decodeHistory(frame)
            "agent.chat.sent" -> decodeSent(frame)
            "agent.chat.event" -> decodeEvent(frame)
            "agent.chat.history.result" -> decodeHistoryResult(frame)
            else -> schemaFailure("unknown-message-type")
        }
    }

    private fun decodeSend(frame: RelayV2JsonObject): AgentChatV1SendRequest {
        requestRoot(frame, "agent.chat.send")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(payload, listOf("session", "message"))
        return AgentChatV1SendRequest(
            session = id(required(payload, "session")),
            message = text(required(payload, "message"), MAX_MESSAGE_UTF8_BYTES),
            requestId = id(required(frame, "requestId")),
            hostId = id(required(frame, "hostId")),
            expectedHostEpoch = id(required(frame, "expectedHostEpoch")),
            scopeId = id(required(frame, "scopeId")),
            sessionId = id(required(frame, "sessionId")),
        )
    }

    private fun decodeHistory(frame: RelayV2JsonObject): AgentChatV1HistoryRequest {
        requestRoot(frame, "agent.chat.history")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(payload, listOf("session"), optional = listOf("limit"))
        val limit = if (payload.containsKey("limit")) {
            jsonInteger(required(payload, "limit"), minimum = 1, maximum = MAX_HISTORY_TURNS.toLong())
                .toInt()
        } else {
            null
        }
        return AgentChatV1HistoryRequest(
            session = id(required(payload, "session")),
            limit = limit,
            requestId = id(required(frame, "requestId")),
            hostId = id(required(frame, "hostId")),
            expectedHostEpoch = id(required(frame, "expectedHostEpoch")),
            scopeId = id(required(frame, "scopeId")),
            sessionId = id(required(frame, "sessionId")),
        )
    }

    private fun decodeSent(frame: RelayV2JsonObject): AgentChatV1Sent {
        responseRoot(frame, "agent.chat.sent")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(payload, listOf("session", "turnId"))
        return AgentChatV1Sent(
            session = id(required(payload, "session")),
            turnId = id(required(payload, "turnId")),
            requestId = id(required(frame, "requestId")),
            hostId = id(required(frame, "hostId")),
            hostEpoch = id(required(frame, "hostEpoch")),
            scopeId = id(required(frame, "scopeId")),
            sessionId = id(required(frame, "sessionId")),
        )
    }

    private fun decodeEvent(frame: RelayV2JsonObject): AgentChatV1Event {
        eventRoot(frame, "agent.chat.event")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(payload, listOf("session", "turn"))
        return AgentChatV1Event(
            session = id(required(payload, "session")),
            turn = decodeTurn(required(payload, "turn")),
            hostId = id(required(frame, "hostId")),
            hostEpoch = id(required(frame, "hostEpoch")),
            scopeId = id(required(frame, "scopeId")),
            sessionId = id(required(frame, "sessionId")),
        )
    }

    private fun decodeHistoryResult(frame: RelayV2JsonObject): AgentChatV1HistoryResult {
        responseRoot(frame, "agent.chat.history.result")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(payload, listOf("session", "turns"))
        val turnsRaw = jsonArray(required(payload, "turns"), maximum = MAX_HISTORY_TURNS) {
            decodeTurn(it)
        }
        return AgentChatV1HistoryResult(
            session = id(required(payload, "session")),
            turns = turnsRaw.map { decodeTurn(it) },
            requestId = id(required(frame, "requestId")),
            hostId = id(required(frame, "hostId")),
            hostEpoch = id(required(frame, "hostEpoch")),
            scopeId = id(required(frame, "scopeId")),
            sessionId = id(required(frame, "sessionId")),
        )
    }

    private fun decodeError(frame: RelayV2JsonObject): AgentChatV1Error {
        errorRoot(frame)
        val error = jsonObject(required(frame, "error"))
        exactKeys(
            error,
            required = listOf("code", "message", "retryable", "commandDisposition"),
            optional = listOf("retryAfterMs", "details"),
        )
        val code = jsonOneOf(
            required(error, "code"),
            EXTENSION_ERROR_CODES,
        )
        val message = text(required(error, "message"), MAX_ERROR_MESSAGE_UTF8_BYTES)
        val retryable = jsonBoolean(required(error, "retryable"))
        jsonOneOf(required(error, "commandDisposition"), setOf("not_applicable"))
        if (error.containsKey("retryAfterMs")) {
            if (error["retryAfterMs"] != null) jsonInteger(error["retryAfterMs"])
        }
        when (code) {
            "HOST_EPOCH_MISMATCH" -> {
                val details = jsonObject(required(error, "details"))
                exactKeys(details, listOf("expectedHostEpoch", "actualHostEpoch"))
                id(required(details, "expectedHostEpoch"))
                id(required(details, "actualHostEpoch"))
            }
            else -> {
                if (error.containsKey("details") && error["details"] != null) {
                    schemaFailure("schema-mismatch")
                }
            }
        }
        return AgentChatV1Error(
            requestId = id(required(frame, "requestId")),
            hostId = id(required(frame, "hostId")),
            hostEpoch = id(required(frame, "hostEpoch")),
            scopeId = id(required(frame, "scopeId")),
            sessionId = id(required(frame, "sessionId")),
            code = code,
            message = message,
            retryable = retryable,
        )
    }

    private fun decodeTurn(value: Any?): AgentChatV1Turn {
        val turn = jsonObject(value)
        exactKeys(
            turn,
            required = listOf("turnId", "session", "userMessage", "status", "sentAt"),
            optional = listOf("reply", "error", "completedAt", "steeredMessages"),
        )
        val turnId = id(required(turn, "turnId"))
        val session = id(required(turn, "session"))
        val userMessage = text(required(turn, "userMessage"), MAX_MESSAGE_UTF8_BYTES)
        val status = jsonOneOf(required(turn, "status"), TURN_STATUSES)
        val reply = turn["reply"]?.let { text(it, MAX_TURN_UTF8_BYTES) }
        val error = turn["error"]?.let { text(it, MAX_ERROR_MESSAGE_UTF8_BYTES) }
        val completedAt = turn["completedAt"]?.let { text(it, MAX_TIMESTAMP_BYTES) }
        when (status) {
            "working" -> {
                if (reply != null || completedAt != null) schemaFailure("schema-mismatch")
            }
            "replied" -> {
                if (reply == null || error != null || completedAt == null) {
                    schemaFailure("schema-mismatch")
                }
            }
            "failed", "recovery-required" -> {
                if (reply != null || error == null || completedAt == null) {
                    schemaFailure("schema-mismatch")
                }
            }
            else -> schemaFailure("schema-mismatch")
        }
        val sentAt = text(required(turn, "sentAt"), MAX_TIMESTAMP_BYTES)
        val steered = turn["steeredMessages"]?.let { steeredValue ->
            val steeredRaw = jsonArray(steeredValue, maximum = MAX_STEERED_MESSAGES) {
                decodeSteeredMessage(it)
            }
            steeredRaw.map { decodeSteeredMessage(it) }
        } ?: emptyList()
        if (steered.isNotEmpty() && status == "working") schemaFailure("schema-mismatch")
        return AgentChatV1Turn(
            turnId = turnId,
            session = session,
            userMessage = userMessage,
            status = status,
            reply = reply,
            error = error,
            sentAt = sentAt,
            completedAt = completedAt,
            steeredMessages = steered,
        )
    }

    private fun decodeSteeredMessage(value: Any?): AgentChatV1SteeredMessage {
        val item = jsonObject(value)
        exactKeys(item, listOf("message", "sentAt"))
        return AgentChatV1SteeredMessage(
            message = text(required(item, "message"), MAX_MESSAGE_UTF8_BYTES),
            sentAt = text(required(item, "sentAt"), MAX_TIMESTAMP_BYTES),
        )
    }

    private fun requestRoot(frame: RelayV2JsonObject, type: String) {
        exactKeys(
            frame,
            listOf(
                "protocolVersion",
                "kind",
                "type",
                "requestId",
                "hostId",
                "expectedHostEpoch",
                "scopeId",
                "sessionId",
                "payload",
            ),
        )
        jsonLiteral(required(frame, "protocolVersion"), 2)
        jsonLiteral(required(frame, "kind"), "request")
        jsonLiteral(required(frame, "type"), type)
        id(required(frame, "requestId"))
        id(required(frame, "hostId"))
        id(required(frame, "expectedHostEpoch"))
        id(required(frame, "scopeId"))
        id(required(frame, "sessionId"))
    }

    private fun responseRoot(frame: RelayV2JsonObject, type: String) {
        exactKeys(
            frame,
            listOf(
                "protocolVersion",
                "kind",
                "type",
                "requestId",
                "hostId",
                "hostEpoch",
                "scopeId",
                "sessionId",
                "payload",
            ),
        )
        jsonLiteral(required(frame, "protocolVersion"), 2)
        jsonLiteral(required(frame, "kind"), "response")
        jsonLiteral(required(frame, "type"), type)
        id(required(frame, "requestId"))
        id(required(frame, "hostId"))
        id(required(frame, "hostEpoch"))
        id(required(frame, "scopeId"))
        id(required(frame, "sessionId"))
    }

    private fun eventRoot(frame: RelayV2JsonObject, type: String) {
        exactKeys(
            frame,
            listOf(
                "protocolVersion",
                "kind",
                "type",
                "hostId",
                "hostEpoch",
                "scopeId",
                "sessionId",
                "payload",
            ),
        )
        jsonLiteral(required(frame, "protocolVersion"), 2)
        jsonLiteral(required(frame, "kind"), "event")
        jsonLiteral(required(frame, "type"), type)
        id(required(frame, "hostId"))
        id(required(frame, "hostEpoch"))
        id(required(frame, "scopeId"))
        id(required(frame, "sessionId"))
    }

    private fun errorRoot(frame: RelayV2JsonObject) {
        exactKeys(
            frame,
            listOf(
                "protocolVersion",
                "kind",
                "type",
                "requestId",
                "hostId",
                "hostEpoch",
                "scopeId",
                "sessionId",
                "payload",
                "error",
            ),
        )
        jsonLiteral(required(frame, "protocolVersion"), 2)
        jsonLiteral(required(frame, "kind"), "response")
        jsonLiteral(required(frame, "type"), "error")
        jsonNull(required(frame, "payload"))
        id(required(frame, "requestId"))
        id(required(frame, "hostId"))
        id(required(frame, "hostEpoch"))
        id(required(frame, "scopeId"))
        id(required(frame, "sessionId"))
    }

    private fun id(value: Any?): String = stringValue(value, maxBytes = MAX_ID_BYTES)

    private fun text(value: Any?, maxBytes: Int): String = stringValue(
        value,
        allowEmpty = true,
        allowOuterWhitespace = true,
        maxBytes = maxBytes,
    )

    private fun stringValue(
        value: Any?,
        allowEmpty: Boolean = false,
        allowOuterWhitespace: Boolean = false,
        maxBytes: Int = Int.MAX_VALUE,
    ): String = jsonString(
        value,
        allowEmpty = allowEmpty,
        allowOuterWhitespace = allowOuterWhitespace,
        maxBytes = maxBytes,
    )

    private inline fun <T> mapCodecFailures(block: () -> T): T = try {
        block()
    } catch (error: AgentChatV1CodecException) {
        throw error
    } catch (error: RelayV2JsonException) {
        throw AgentChatV1CodecException("INVALID_ENVELOPE", error.failureClass)
    } catch (error: RelayV2SchemaException) {
        throw AgentChatV1CodecException("INVALID_ENVELOPE", error.failureClass)
    }

    private fun AgentChatV1Frame.toWireObject(): LinkedHashMap<String, Any?> = when (this) {
        is AgentChatV1SendRequest -> requestWire(
            type = type,
            requestId = requestId,
            hostId = hostId,
            expectedHostEpoch = expectedHostEpoch,
            scopeId = scopeId,
            sessionId = sessionId,
            payload = linkedMapOf(
                "session" to session,
                "message" to message,
            ),
        )
        is AgentChatV1HistoryRequest -> requestWire(
            type = type,
            requestId = requestId,
            hostId = hostId,
            expectedHostEpoch = expectedHostEpoch,
            scopeId = scopeId,
            sessionId = sessionId,
            payload = linkedMapOf<String, Any?>("session" to session).apply {
                if (limit != null) put("limit", limit)
            },
        )
        is AgentChatV1Sent -> responseWire(
            type = type,
            requestId = requestId,
            hostId = hostId,
            hostEpoch = hostEpoch,
            scopeId = scopeId,
            sessionId = sessionId,
            payload = linkedMapOf(
                "session" to session,
                "turnId" to turnId,
            ),
        )
        is AgentChatV1Event -> eventWire(
            type = type,
            hostId = hostId,
            hostEpoch = hostEpoch,
            scopeId = scopeId,
            sessionId = sessionId,
            payload = linkedMapOf(
                "session" to session,
                "turn" to turn.toWireObject(),
            ),
        )
        is AgentChatV1HistoryResult -> responseWire(
            type = type,
            requestId = requestId,
            hostId = hostId,
            hostEpoch = hostEpoch,
            scopeId = scopeId,
            sessionId = sessionId,
            payload = linkedMapOf(
                "session" to session,
                "turns" to turns.map { it.toWireObject() },
            ),
        )
        is AgentChatV1Error -> linkedMapOf(
            "protocolVersion" to 2,
            "kind" to "response",
            "type" to "error",
            "requestId" to requestId,
            "hostId" to hostId,
            "hostEpoch" to hostEpoch,
            "scopeId" to scopeId,
            "sessionId" to sessionId,
            "payload" to null,
            "error" to linkedMapOf(
                "code" to code,
                "message" to message,
                "retryable" to retryable,
                "commandDisposition" to "not_applicable",
            ),
        )
    }

    private fun AgentChatV1Turn.toWireObject(): LinkedHashMap<String, Any?> = linkedMapOf<String, Any?>(
        "turnId" to turnId,
        "session" to session,
        "userMessage" to userMessage,
        "status" to status,
        "sentAt" to sentAt,
    ).apply {
        put("reply", reply)
        put("error", error)
        put("completedAt", completedAt)
        put(
            "steeredMessages",
            if (steeredMessages.isEmpty()) null else steeredMessages.map {
                linkedMapOf("message" to it.message, "sentAt" to it.sentAt)
            },
        )
    }

    private fun requestWire(
        type: String,
        requestId: String,
        hostId: String,
        expectedHostEpoch: String,
        scopeId: String,
        sessionId: String,
        payload: Any?,
    ): LinkedHashMap<String, Any?> = linkedMapOf(
        "protocolVersion" to 2,
        "kind" to "request",
        "type" to type,
        "requestId" to requestId,
        "hostId" to hostId,
        "expectedHostEpoch" to expectedHostEpoch,
        "scopeId" to scopeId,
        "sessionId" to sessionId,
        "payload" to payload,
    )

    private fun responseWire(
        type: String,
        requestId: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        payload: Any?,
    ): LinkedHashMap<String, Any?> = linkedMapOf(
        "protocolVersion" to 2,
        "kind" to "response",
        "type" to type,
        "requestId" to requestId,
        "hostId" to hostId,
        "hostEpoch" to hostEpoch,
        "scopeId" to scopeId,
        "sessionId" to sessionId,
        "payload" to payload,
    )

    private fun eventWire(
        type: String,
        hostId: String,
        hostEpoch: String,
        scopeId: String,
        sessionId: String,
        payload: Any?,
    ): LinkedHashMap<String, Any?> = linkedMapOf(
        "protocolVersion" to 2,
        "kind" to "event",
        "type" to type,
        "hostId" to hostId,
        "hostEpoch" to hostEpoch,
        "scopeId" to scopeId,
        "sessionId" to sessionId,
        "payload" to payload,
    )

    companion object {
        const val MAX_PUBLIC_FRAME_BYTES = 1_048_576

        private const val MAX_ID_BYTES = 128
        private const val MAX_MESSAGE_UTF8_BYTES = 65_536
        private const val MAX_TURN_UTF8_BYTES = 262_144
        private const val MAX_HISTORY_TURNS = 256
        private const val MAX_STEERED_MESSAGES = 64
        private const val MAX_ERROR_MESSAGE_UTF8_BYTES = 4_096
        private const val MAX_TIMESTAMP_BYTES = 64

        private val EXTENSION_ERROR_CODES = setOf(
            "AGENT_CHAT_UNAVAILABLE",
            "AGENT_CHAT_SESSION_UNAVAILABLE",
            "HOST_EPOCH_MISMATCH",
        )
        private val TURN_STATUSES = setOf("working", "replied", "failed", "recovery-required")
        private val STANDARD_JSON_LIMITS = RelayV2JsonLimits(
            maxDepth = 16,
            maxDirectKeys = 256,
            maxTotalKeys = 1_024,
            maxNodes = 4_096,
        )
    }
}
