package com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.codec

import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatContentPart
import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatProgressStep
import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatImagePart
import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatMarkdownPart
import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatSteeredMessage
import com.tmuxworktree.mobile.core.relay.extensions.agentchat.v2.AgentChatTurnView
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
import java.util.Base64

/** Relay v2 wire name for the optional agent.chat.v2 extension. */
const val AGENT_CHAT_V2_CAPABILITY = "agent.chat.v2"

class AgentChatV2CodecException(
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
data class AgentChatV2FrameMetadata(
    val opcode: String = "text",
    val compressed: Boolean = false,
)

/** Closed public-wire union for the optional agent.chat.v2 extension. */
sealed interface AgentChatV2Frame {
    val kind: String
    val type: String
}

data class AgentChatV2SteeredMessage(
    val message: String,
    val sentAt: String,
)

/**
 * A v2 wire turn. The frozen schema requires every status-derived field to be present
 * (nullable), so this DTO carries explicit nulls. [toView] converts wire DTOs to UI models.
 */
data class AgentChatV2Turn(
    val turnId: String,
    val session: String,
    val userMessage: String,
    val status: String,
    val content: List<AgentChatContentPart>? = null,
    val progress: List<AgentChatProgressStep> = emptyList(),
    val error: String? = null,
    val sentAt: String,
    val completedAt: String? = null,
    val steeredMessages: List<AgentChatV2SteeredMessage> = emptyList(),
) {
    fun toView(): AgentChatTurnView = AgentChatTurnView(
        turnId = turnId,
        session = session,
        userMessage = userMessage,
        status = status,
        content = content.orEmpty(),
        progress = progress,
        error = error,
        sentAt = sentAt,
        completedAt = completedAt,
        steeredMessages = steeredMessages.map { AgentChatSteeredMessage(it.message, it.sentAt) },
    )
}

data class AgentChatV2SendRequest(
    val session: String,
    val message: String,
    val requestId: String,
    val hostId: String,
    val expectedHostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : AgentChatV2Frame {
    override val kind: String = "request"
    override val type: String = "agent.chat.send"
}

data class AgentChatV2HistoryRequest(
    val session: String,
    val limit: Int?,
    val requestId: String,
    val hostId: String,
    val expectedHostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : AgentChatV2Frame {
    override val kind: String = "request"
    override val type: String = "agent.chat.history"
}

data class AgentChatV2ImageGetRequest(
    val session: String,
    val imageId: String,
    val offset: Int,
    val requestId: String,
    val hostId: String,
    val expectedHostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : AgentChatV2Frame {
    override val kind: String = "request"
    override val type: String = "agent.chat.image.get"
}

data class AgentChatV2Sent(
    val session: String,
    val turnId: String,
    val requestId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : AgentChatV2Frame {
    override val kind: String = "response"
    override val type: String = "agent.chat.sent"
}

data class AgentChatV2Event(
    val session: String,
    val turn: AgentChatV2Turn,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : AgentChatV2Frame {
    override val kind: String = "event"
    override val type: String = "agent.chat.event"
}

data class AgentChatV2HistoryResult(
    val session: String,
    val turns: List<AgentChatV2Turn>,
    val requestId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : AgentChatV2Frame {
    override val kind: String = "response"
    override val type: String = "agent.chat.history.result"
}

data class AgentChatV2ImageChunk(
    val session: String,
    val imageId: String,
    val mimeType: String,
    val byteLength: Int,
    val sha256: String,
    val offset: Int,
    val dataBase64: String,
    val nextOffset: Int?,
    val requestId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : AgentChatV2Frame {
    override val kind: String = "response"
    override val type: String = "agent.chat.image.chunk"
}

data class AgentChatV2Error(
    val requestId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val code: String,
    val message: String,
    val retryable: Boolean,
) : AgentChatV2Frame {
    override val kind: String = "response"
    override val type: String = "error"
}

/**
 * Strict codec for the optional public `agent.chat.v2` wire only.
 *
 * This codec does not negotiate the capability and does not consume base frames. Its DTOs carry
 * only structure explicitly frozen by the extension contract (mirroring the Node host/broker
 * codec).
 */
class AgentChatV2Codec {
    fun decodePublicFrame(
        bytes: ByteArray,
        metadata: AgentChatV2FrameMetadata = AgentChatV2FrameMetadata(),
    ): AgentChatV2Frame = mapCodecFailures {
        if (metadata.opcode != "text") {
            throw AgentChatV2CodecException("INVALID_ENVELOPE", "binary-frame")
        }
        if (metadata.compressed) {
            throw AgentChatV2CodecException("PROTOCOL_UNSUPPORTED", "compression-not-allowed")
        }
        if (bytes.size > MAX_PUBLIC_FRAME_BYTES) {
            throw AgentChatV2CodecException("INVALID_ENVELOPE", "frame-limit")
        }
        val source = RelayV2StrictJson.decodeUtf8(bytes)
        val inspection = RelayV2StrictJson.inspect(source, STANDARD_JSON_LIMITS)
        if (inspection.totalKeys > STANDARD_JSON_LIMITS.maxTotalKeys) {
            throw AgentChatV2CodecException("INVALID_ENVELOPE", "json-total-key-limit")
        }
        if (inspection.totalNodes > STANDARD_JSON_LIMITS.maxNodes) {
            throw AgentChatV2CodecException("INVALID_ENVELOPE", "json-node-limit")
        }
        decodeFrame(RelayV2StrictJson.parseObject(source, STANDARD_JSON_LIMITS))
    }

    fun encodePublicFrame(frame: AgentChatV2Frame): ByteArray = mapCodecFailures {
        val wireObject = frame.toWireObject()
        decodeFrame(wireObject)
        val bytes = RelayV2StrictJson.stringify(wireObject).toByteArray(StandardCharsets.UTF_8)
        if (bytes.size > MAX_PUBLIC_FRAME_BYTES) {
            throw AgentChatV2CodecException("INVALID_ENVELOPE", "frame-limit")
        }
        decodePublicFrame(bytes)
        bytes
    }

    private fun decodeFrame(frame: RelayV2JsonObject): AgentChatV2Frame {
        val type = stringValue(required(frame, "type"), maxBytes = MAX_ID_BYTES)
        return when (type) {
            "error" -> decodeError(frame)
            "agent.chat.send" -> decodeSend(frame)
            "agent.chat.history" -> decodeHistory(frame)
            "agent.chat.image.get" -> decodeImageGet(frame)
            "agent.chat.sent" -> decodeSent(frame)
            "agent.chat.event" -> decodeEvent(frame)
            "agent.chat.history.result" -> decodeHistoryResult(frame)
            "agent.chat.image.chunk" -> decodeImageChunk(frame)
            else -> schemaFailure("unknown-message-type")
        }
    }

    private fun decodeSend(frame: RelayV2JsonObject): AgentChatV2SendRequest {
        requestRoot(frame, "agent.chat.send")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(payload, listOf("session", "message"))
        return AgentChatV2SendRequest(
            session = id(required(payload, "session")),
            message = text(required(payload, "message"), MAX_MESSAGE_UTF8_BYTES),
            requestId = id(required(frame, "requestId")),
            hostId = id(required(frame, "hostId")),
            expectedHostEpoch = id(required(frame, "expectedHostEpoch")),
            scopeId = id(required(frame, "scopeId")),
            sessionId = id(required(frame, "sessionId")),
        )
    }

    private fun decodeHistory(frame: RelayV2JsonObject): AgentChatV2HistoryRequest {
        requestRoot(frame, "agent.chat.history")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(payload, listOf("session"), optional = listOf("limit"))
        val limit = if (payload.containsKey("limit")) {
            jsonInteger(required(payload, "limit"), minimum = 1, maximum = MAX_HISTORY_TURNS.toLong())
                .toInt()
        } else {
            null
        }
        return AgentChatV2HistoryRequest(
            session = id(required(payload, "session")),
            limit = limit,
            requestId = id(required(frame, "requestId")),
            hostId = id(required(frame, "hostId")),
            expectedHostEpoch = id(required(frame, "expectedHostEpoch")),
            scopeId = id(required(frame, "scopeId")),
            sessionId = id(required(frame, "sessionId")),
        )
    }

    private fun decodeImageGet(frame: RelayV2JsonObject): AgentChatV2ImageGetRequest {
        requestRoot(frame, "agent.chat.image.get")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(payload, listOf("session", "imageId", "offset"))
        return AgentChatV2ImageGetRequest(
            session = id(required(payload, "session")),
            imageId = id(required(payload, "imageId")),
            offset = jsonInteger(
                required(payload, "offset"),
                minimum = 0,
                maximum = (MAX_IMAGE_BYTES - 1).toLong(),
            ).toInt(),
            requestId = id(required(frame, "requestId")),
            hostId = id(required(frame, "hostId")),
            expectedHostEpoch = id(required(frame, "expectedHostEpoch")),
            scopeId = id(required(frame, "scopeId")),
            sessionId = id(required(frame, "sessionId")),
        )
    }

    private fun decodeSent(frame: RelayV2JsonObject): AgentChatV2Sent {
        responseRoot(frame, "agent.chat.sent")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(payload, listOf("session", "turnId"))
        return AgentChatV2Sent(
            session = id(required(payload, "session")),
            turnId = id(required(payload, "turnId")),
            requestId = id(required(frame, "requestId")),
            hostId = id(required(frame, "hostId")),
            hostEpoch = id(required(frame, "hostEpoch")),
            scopeId = id(required(frame, "scopeId")),
            sessionId = id(required(frame, "sessionId")),
        )
    }

    private fun decodeEvent(frame: RelayV2JsonObject): AgentChatV2Event {
        eventRoot(frame, "agent.chat.event")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(payload, listOf("session", "turn"))
        return AgentChatV2Event(
            session = id(required(payload, "session")),
            turn = decodeTurn(required(payload, "turn")),
            hostId = id(required(frame, "hostId")),
            hostEpoch = id(required(frame, "hostEpoch")),
            scopeId = id(required(frame, "scopeId")),
            sessionId = id(required(frame, "sessionId")),
        )
    }

    private fun decodeHistoryResult(frame: RelayV2JsonObject): AgentChatV2HistoryResult {
        responseRoot(frame, "agent.chat.history.result")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(payload, listOf("session", "turns"))
        val turnsRaw = jsonArray(required(payload, "turns"), maximum = MAX_HISTORY_TURNS) {
            decodeTurn(it)
        }
        return AgentChatV2HistoryResult(
            session = id(required(payload, "session")),
            turns = turnsRaw.map { decodeTurn(it) },
            requestId = id(required(frame, "requestId")),
            hostId = id(required(frame, "hostId")),
            hostEpoch = id(required(frame, "hostEpoch")),
            scopeId = id(required(frame, "scopeId")),
            sessionId = id(required(frame, "sessionId")),
        )
    }

    private fun decodeImageChunk(frame: RelayV2JsonObject): AgentChatV2ImageChunk {
        responseRoot(frame, "agent.chat.image.chunk")
        val payload = jsonObject(required(frame, "payload"))
        exactKeys(
            payload,
            listOf(
                "session", "imageId", "mimeType", "byteLength", "sha256", "offset",
                "dataBase64", "nextOffset",
            ),
        )
        val imageId = id(required(payload, "imageId"))
        val mimeType = jsonOneOf(required(payload, "mimeType"), IMAGE_MIME_TYPES)
        val byteLength = jsonInteger(
            required(payload, "byteLength"),
            minimum = 1,
            maximum = MAX_IMAGE_BYTES.toLong(),
        ).toInt()
        val sha256 = stringValue(required(payload, "sha256"), maxBytes = 64)
        if (!SHA256_REGEX.matches(sha256) || imageId != "image-$sha256") {
            schemaFailure("invalid-argument")
        }
        val offset = jsonInteger(
            required(payload, "offset"),
            minimum = 0,
            maximum = (byteLength - 1).toLong(),
        ).toInt()
        val dataBase64 = stringValue(
            required(payload, "dataBase64"),
            allowOuterWhitespace = true,
            maxBytes = ((IMAGE_CHUNK_BYTES + 2) / 3) * 4,
        )
        val data = decodeCanonicalBase64(dataBase64)
        if (data.isEmpty() || data.size > IMAGE_CHUNK_BYTES || offset + data.size > byteLength) {
            schemaFailure("schema-mismatch")
        }
        val nextOffset = payload["nextOffset"]?.let {
            jsonInteger(
                it,
                minimum = (offset + 1).toLong(),
                maximum = (byteLength - 1).toLong(),
            ).toInt()
        }
        if ((nextOffset == null) != (offset + data.size == byteLength) ||
            (nextOffset != null && nextOffset != offset + data.size)
        ) {
            schemaFailure("schema-mismatch")
        }
        return AgentChatV2ImageChunk(
            session = id(required(payload, "session")),
            imageId = imageId,
            mimeType = mimeType,
            byteLength = byteLength,
            sha256 = sha256,
            offset = offset,
            dataBase64 = dataBase64,
            nextOffset = nextOffset,
            requestId = id(required(frame, "requestId")),
            hostId = id(required(frame, "hostId")),
            hostEpoch = id(required(frame, "hostEpoch")),
            scopeId = id(required(frame, "scopeId")),
            sessionId = id(required(frame, "sessionId")),
        )
    }

    private fun decodeError(frame: RelayV2JsonObject): AgentChatV2Error {
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
        return AgentChatV2Error(
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

    private fun decodeTurn(value: Any?): AgentChatV2Turn {
        val turn = jsonObject(value)
        exactKeys(
            turn,
            required = listOf(
                "turnId", "session", "userMessage", "status", "content", "error", "sentAt",
                "completedAt", "steeredMessages", "progress",
            ),
        )
        val turnId = id(required(turn, "turnId"))
        val session = id(required(turn, "session"))
        val userMessage = text(required(turn, "userMessage"), MAX_MESSAGE_UTF8_BYTES)
        val status = jsonOneOf(required(turn, "status"), TURN_STATUSES)
        val content = turn["content"]?.let { rawContent ->
            jsonArray(
                rawContent,
                maximum = MAX_CONTENT_PARTS,
                minimum = 1,
                validator = { decodeContentPart(it) },
            ).map { decodeContentPart(it) }
        }
        val error = turn["error"]?.let { text(it, MAX_ERROR_MESSAGE_UTF8_BYTES) }
        val progress = jsonArray(
            required(turn, "progress"),
            maximum = MAX_PROGRESS_STEPS,
            validator = { decodeProgressStep(it) },
        ).map { decodeProgressStep(it) }
        val completedAt = turn["completedAt"]?.let { text(it, MAX_TIMESTAMP_BYTES) }
        when (status) {
            "working" -> {
                if (content != null || completedAt != null) schemaFailure("schema-mismatch")
            }
            "replied" -> {
                if (content == null || error != null || completedAt == null) {
                    schemaFailure("schema-mismatch")
                }
            }
            "failed", "recovery-required" -> {
                if (content != null || error == null || completedAt == null) {
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
        return AgentChatV2Turn(
            turnId = turnId,
            session = session,
            userMessage = userMessage,
            status = status,
            content = content,
            progress = progress,
            error = error,
            sentAt = sentAt,
            completedAt = completedAt,
            steeredMessages = steered,
        )
    }

    private fun decodeContentPart(value: Any?): AgentChatContentPart {
        val part = jsonObject(value)
        return when (jsonOneOf(required(part, "type"), CONTENT_PART_TYPES)) {
            "markdown" -> {
                exactKeys(part, listOf("type", "text"))
                AgentChatMarkdownPart(text(required(part, "text"), MAX_TURN_UTF8_BYTES))
            }
            "image" -> {
                exactKeys(
                    part,
                    listOf("type", "imageId", "mimeType", "altText", "byteLength", "sha256"),
                )
                val imageId = id(required(part, "imageId"))
                val sha256 = stringValue(required(part, "sha256"), maxBytes = 64)
                if (!SHA256_REGEX.matches(sha256) || imageId != "image-$sha256") {
                    schemaFailure("invalid-argument")
                }
                AgentChatImagePart(
                    imageId = imageId,
                    mimeType = jsonOneOf(required(part, "mimeType"), IMAGE_MIME_TYPES),
                    altText = text(required(part, "altText"), MAX_ALT_TEXT_UTF8_BYTES),
                    byteLength = jsonInteger(
                        required(part, "byteLength"),
                        minimum = 1,
                        maximum = MAX_IMAGE_BYTES.toLong(),
                    ).toInt(),
                    sha256 = sha256,
                )
            }
            else -> schemaFailure("schema-mismatch")
        }
    }

    private fun decodeProgressStep(value: Any?): AgentChatProgressStep {
        val step = jsonObject(value)
        exactKeys(step, listOf("stepId", "kind", "title", "status"))
        return AgentChatProgressStep(
            stepId = id(required(step, "stepId")),
            kind = jsonOneOf(required(step, "kind"), PROGRESS_KINDS),
            title = text(required(step, "title"), MAX_PROGRESS_TITLE_UTF8_BYTES),
            status = jsonOneOf(required(step, "status"), PROGRESS_STATUSES),
        )
    }

    private fun decodeCanonicalBase64(value: String): ByteArray {
        val decoded = try {
            Base64.getDecoder().decode(value)
        } catch (_: IllegalArgumentException) {
            schemaFailure("invalid-argument")
        }
        if (Base64.getEncoder().encodeToString(decoded) != value) schemaFailure("invalid-argument")
        return decoded
    }

    private fun decodeSteeredMessage(value: Any?): AgentChatV2SteeredMessage {
        val item = jsonObject(value)
        exactKeys(item, listOf("message", "sentAt"))
        return AgentChatV2SteeredMessage(
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
    } catch (error: AgentChatV2CodecException) {
        throw error
    } catch (error: RelayV2JsonException) {
        throw AgentChatV2CodecException("INVALID_ENVELOPE", error.failureClass)
    } catch (error: RelayV2SchemaException) {
        throw AgentChatV2CodecException("INVALID_ENVELOPE", error.failureClass)
    }

    private fun AgentChatV2Frame.toWireObject(): LinkedHashMap<String, Any?> = when (this) {
        is AgentChatV2SendRequest -> requestWire(
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
        is AgentChatV2HistoryRequest -> requestWire(
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
        is AgentChatV2ImageGetRequest -> requestWire(
            type = type,
            requestId = requestId,
            hostId = hostId,
            expectedHostEpoch = expectedHostEpoch,
            scopeId = scopeId,
            sessionId = sessionId,
            payload = linkedMapOf(
                "session" to session,
                "imageId" to imageId,
                "offset" to offset,
            ),
        )
        is AgentChatV2Sent -> responseWire(
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
        is AgentChatV2Event -> eventWire(
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
        is AgentChatV2HistoryResult -> responseWire(
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
        is AgentChatV2ImageChunk -> responseWire(
            type = type,
            requestId = requestId,
            hostId = hostId,
            hostEpoch = hostEpoch,
            scopeId = scopeId,
            sessionId = sessionId,
            payload = linkedMapOf(
                "session" to session,
                "imageId" to imageId,
                "mimeType" to mimeType,
                "byteLength" to byteLength,
                "sha256" to sha256,
                "offset" to offset,
                "dataBase64" to dataBase64,
                "nextOffset" to nextOffset,
            ),
        )
        is AgentChatV2Error -> linkedMapOf(
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

    private fun AgentChatV2Turn.toWireObject(): LinkedHashMap<String, Any?> = linkedMapOf<String, Any?>(
        "turnId" to turnId,
        "session" to session,
        "userMessage" to userMessage,
        "status" to status,
        "content" to content?.map { it.toWireObject() },
        "progress" to progress.map { it.toWireObject() },
        "error" to error,
        "sentAt" to sentAt,
        "completedAt" to completedAt,
        "steeredMessages" to if (steeredMessages.isEmpty()) null else steeredMessages.map {
            linkedMapOf("message" to it.message, "sentAt" to it.sentAt)
        },
    )

    private fun AgentChatProgressStep.toWireObject(): LinkedHashMap<String, Any?> = linkedMapOf(
        "stepId" to stepId,
        "kind" to kind,
        "title" to title,
        "status" to status,
    )

    private fun AgentChatContentPart.toWireObject(): LinkedHashMap<String, Any?> = when (this) {
        is AgentChatMarkdownPart -> linkedMapOf("type" to "markdown", "text" to text)
        is AgentChatImagePart -> linkedMapOf(
            "type" to "image",
            "imageId" to imageId,
            "mimeType" to mimeType,
            "altText" to altText,
            "byteLength" to byteLength,
            "sha256" to sha256,
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
        private const val MAX_CONTENT_PARTS = 16
        const val MAX_IMAGE_BYTES = 4 * 1_024 * 1_024
        const val IMAGE_CHUNK_BYTES = 192 * 1_024
        private const val MAX_HISTORY_TURNS = 256
        private const val MAX_STEERED_MESSAGES = 64
        private const val MAX_ERROR_MESSAGE_UTF8_BYTES = 4_096
        private const val MAX_TIMESTAMP_BYTES = 64
        private const val MAX_ALT_TEXT_UTF8_BYTES = 1_024
        private const val MAX_PROGRESS_STEPS = 16
        private const val MAX_PROGRESS_TITLE_UTF8_BYTES = 240

        private val EXTENSION_ERROR_CODES = setOf(
            "AGENT_CHAT_UNAVAILABLE",
            "AGENT_CHAT_SESSION_UNAVAILABLE",
            "HOST_EPOCH_MISMATCH",
        )
        private val TURN_STATUSES = setOf("working", "replied", "failed", "recovery-required")
        private val CONTENT_PART_TYPES = setOf("markdown", "image")
        private val PROGRESS_KINDS = setOf("status", "tool")
        private val PROGRESS_STATUSES = setOf("running", "completed", "failed")
        private val IMAGE_MIME_TYPES = setOf("image/png", "image/jpeg", "image/gif", "image/webp")
        private val SHA256_REGEX = Regex("^[0-9a-f]{64}$")
        private val STANDARD_JSON_LIMITS = RelayV2JsonLimits(
            maxDepth = 16,
            maxDirectKeys = 256,
            maxTotalKeys = 1_024,
            maxNodes = 4_096,
        )
    }
}
