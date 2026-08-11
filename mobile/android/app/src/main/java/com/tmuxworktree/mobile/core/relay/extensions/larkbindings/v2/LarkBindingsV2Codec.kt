package com.tmuxworktree.mobile.core.relay.extensions.larkbindings.v2

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2FrameMetadata
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonException
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson

const val LARK_BINDINGS_V2_CAPABILITY = "lark.bindings.v2"

data class LarkBindingView(
    val id: String,
    val chatName: String,
    val sessionName: String,
    val status: String,
    val replyMode: String,
)

data class LarkBindingsState(
    val available: Boolean = false,
    val loaded: Boolean = false,
    val loading: Boolean = false,
    val bindings: List<LarkBindingView> = emptyList(),
    val busyBindingId: String? = null,
    val error: String? = null,
)

sealed interface LarkBindingsV2Frame

data class LarkBindingsV2GetRequest(
    val requestId: String,
    val hostId: String,
    val expectedHostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : LarkBindingsV2Frame

data class LarkBindingReplyModeUpdateRequest(
    val bindingId: String,
    val replyMode: String,
    val requestId: String,
    val hostId: String,
    val expectedHostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : LarkBindingsV2Frame

data class LarkBindingUnlinkRequest(
    val bindingId: String,
    val requestId: String,
    val hostId: String,
    val expectedHostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : LarkBindingsV2Frame

data class LarkBindingsV2Result(
    val bindings: List<LarkBindingView>,
    val requestId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : LarkBindingsV2Frame

data class LarkBindingV2Updated(
    val binding: LarkBindingView,
    val requestId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : LarkBindingsV2Frame

data class LarkBindingV2Unlinked(
    val bindingId: String,
    val requestId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
) : LarkBindingsV2Frame

data class LarkBindingsV2Error(
    val requestId: String,
    val hostId: String,
    val hostEpoch: String,
    val scopeId: String,
    val sessionId: String,
    val code: String,
    val message: String,
    val retryable: Boolean,
) : LarkBindingsV2Frame

class LarkBindingsV2CodecException : IllegalArgumentException(
    "Relay v2 Lark binding frame is invalid",
)

class LarkBindingsV2Codec {
    fun decodePublicFrame(
        bytes: ByteArray,
        metadata: RelayV2FrameMetadata = RelayV2FrameMetadata(),
    ): LarkBindingsV2Frame = mapFailures {
        if (metadata.opcode != "text" || metadata.compressed || bytes.size > MAX_FRAME_BYTES) {
            invalid()
        }
        val source = RelayV2StrictJson.decodeUtf8(bytes)
        val frame = RelayV2StrictJson.parseObject(source, JSON_LIMITS)
        when (string(frame, "type")) {
            "lark.bindings.get" -> decodeGet(frame)
            "lark.binding.reply_mode.update" -> decodeReplyModeUpdate(frame)
            "lark.binding.unlink" -> decodeUnlink(frame)
            "lark.bindings.result" -> decodeResult(frame)
            "lark.binding.updated" -> decodeUpdated(frame)
            "lark.binding.unlinked" -> decodeUnlinked(frame)
            "error" -> decodeError(frame)
            else -> invalid()
        }
    }

    fun encodePublicFrame(frame: LarkBindingsV2Frame): ByteArray = mapFailures {
        val value = when (frame) {
            is LarkBindingsV2GetRequest -> requestRoot(
                frame.requestId,
                frame.hostId,
                frame.expectedHostEpoch,
                frame.scopeId,
                frame.sessionId,
                "lark.bindings.get",
                emptyMap(),
            )
            is LarkBindingReplyModeUpdateRequest -> requestRoot(
                frame.requestId,
                frame.hostId,
                frame.expectedHostEpoch,
                frame.scopeId,
                frame.sessionId,
                "lark.binding.reply_mode.update",
                linkedMapOf(
                    "bindingId" to id(frame.bindingId),
                    "replyMode" to replyMode(frame.replyMode),
                ),
            )
            is LarkBindingUnlinkRequest -> requestRoot(
                frame.requestId,
                frame.hostId,
                frame.expectedHostEpoch,
                frame.scopeId,
                frame.sessionId,
                "lark.binding.unlink",
                linkedMapOf("bindingId" to id(frame.bindingId)),
            )
            else -> invalid()
        }
        val encoded = RelayV2StrictJson.stringify(value).toByteArray(Charsets.UTF_8)
        if (encoded.size > MAX_FRAME_BYTES) invalid()
        encoded
    }

    private fun decodeGet(frame: Map<String, Any?>): LarkBindingsV2GetRequest {
        requestRoot(frame, "lark.bindings.get")
        exact(objectValue(frame, "payload"), emptySet())
        return LarkBindingsV2GetRequest(
            requestId = id(frame["requestId"]),
            hostId = id(frame["hostId"]),
            expectedHostEpoch = id(frame["expectedHostEpoch"]),
            scopeId = id(frame["scopeId"]),
            sessionId = id(frame["sessionId"]),
        )
    }

    private fun decodeReplyModeUpdate(
        frame: Map<String, Any?>,
    ): LarkBindingReplyModeUpdateRequest {
        requestRoot(frame, "lark.binding.reply_mode.update")
        val payload = objectValue(frame, "payload")
        exact(payload, setOf("bindingId", "replyMode"))
        return LarkBindingReplyModeUpdateRequest(
            bindingId = id(payload["bindingId"]),
            replyMode = replyMode(payload["replyMode"]),
            requestId = id(frame["requestId"]),
            hostId = id(frame["hostId"]),
            expectedHostEpoch = id(frame["expectedHostEpoch"]),
            scopeId = id(frame["scopeId"]),
            sessionId = id(frame["sessionId"]),
        )
    }

    private fun decodeUnlink(frame: Map<String, Any?>): LarkBindingUnlinkRequest {
        requestRoot(frame, "lark.binding.unlink")
        val payload = objectValue(frame, "payload")
        exact(payload, setOf("bindingId"))
        return LarkBindingUnlinkRequest(
            bindingId = id(payload["bindingId"]),
            requestId = id(frame["requestId"]),
            hostId = id(frame["hostId"]),
            expectedHostEpoch = id(frame["expectedHostEpoch"]),
            scopeId = id(frame["scopeId"]),
            sessionId = id(frame["sessionId"]),
        )
    }

    private fun decodeResult(frame: Map<String, Any?>): LarkBindingsV2Result {
        responseRoot(frame, "lark.bindings.result")
        val payload = objectValue(frame, "payload")
        exact(payload, setOf("bindings"))
        return LarkBindingsV2Result(
            bindings = bindings(payload["bindings"]),
            requestId = id(frame["requestId"]),
            hostId = id(frame["hostId"]),
            hostEpoch = id(frame["hostEpoch"]),
            scopeId = id(frame["scopeId"]),
            sessionId = id(frame["sessionId"]),
        )
    }

    private fun decodeUpdated(frame: Map<String, Any?>): LarkBindingV2Updated {
        responseRoot(frame, "lark.binding.updated")
        val payload = objectValue(frame, "payload")
        exact(payload, setOf("binding"))
        return LarkBindingV2Updated(
            binding = binding(objectValue(payload, "binding")),
            requestId = id(frame["requestId"]),
            hostId = id(frame["hostId"]),
            hostEpoch = id(frame["hostEpoch"]),
            scopeId = id(frame["scopeId"]),
            sessionId = id(frame["sessionId"]),
        )
    }

    private fun decodeUnlinked(frame: Map<String, Any?>): LarkBindingV2Unlinked {
        responseRoot(frame, "lark.binding.unlinked")
        val payload = objectValue(frame, "payload")
        exact(payload, setOf("bindingId"))
        return LarkBindingV2Unlinked(
            bindingId = id(payload["bindingId"]),
            requestId = id(frame["requestId"]),
            hostId = id(frame["hostId"]),
            hostEpoch = id(frame["hostEpoch"]),
            scopeId = id(frame["scopeId"]),
            sessionId = id(frame["sessionId"]),
        )
    }

    private fun decodeError(frame: Map<String, Any?>): LarkBindingsV2Error {
        responseRoot(frame, "error", hasError = true)
        if (frame["payload"] != null) invalid()
        val error = objectValue(frame, "error")
        exact(error, setOf("code", "message", "retryable", "commandDisposition"))
        val code = string(error, "code")
        if (code !in ERROR_CODES || string(error, "commandDisposition") != "not_applicable") {
            invalid()
        }
        val message = nonEmptyText(error["message"], MAX_ERROR_MESSAGE_BYTES)
        return LarkBindingsV2Error(
            requestId = id(frame["requestId"]),
            hostId = id(frame["hostId"]),
            hostEpoch = id(frame["hostEpoch"]),
            scopeId = id(frame["scopeId"]),
            sessionId = id(frame["sessionId"]),
            code = code,
            message = message,
            retryable = error["retryable"] as? Boolean ?: invalid(),
        )
    }

    private fun requestRoot(frame: Map<String, Any?>, type: String) {
        exact(frame, REQUEST_KEYS)
        if (frame["protocolVersion"] != 2L || frame["kind"] != "request" || frame["type"] != type) {
            invalid()
        }
        listOf("requestId", "hostId", "expectedHostEpoch", "scopeId", "sessionId")
            .forEach { id(frame[it]) }
    }

    private fun responseRoot(
        frame: Map<String, Any?>,
        type: String,
        hasError: Boolean = false,
    ) {
        exact(frame, if (hasError) RESPONSE_KEYS + "error" else RESPONSE_KEYS)
        if (frame["protocolVersion"] != 2L || frame["kind"] != "response" || frame["type"] != type) {
            invalid()
        }
        listOf("requestId", "hostId", "hostEpoch", "scopeId", "sessionId")
            .forEach { id(frame[it]) }
    }

    private fun requestRoot(
        requestId: String,
        hostId: String,
        expectedHostEpoch: String,
        scopeId: String,
        sessionId: String,
        type: String,
        payload: Map<String, Any?>,
    ): Map<String, Any?> = linkedMapOf(
        "protocolVersion" to 2,
        "kind" to "request",
        "type" to type,
        "requestId" to id(requestId),
        "hostId" to id(hostId),
        "expectedHostEpoch" to id(expectedHostEpoch),
        "scopeId" to id(scopeId),
        "sessionId" to id(sessionId),
        "payload" to payload,
    )

    private fun bindings(value: Any?): List<LarkBindingView> {
        val values = value as? List<*> ?: invalid()
        if (values.size > MAX_BINDINGS) invalid()
        return values.map { binding(it as? Map<*, *> ?: invalid()) }
    }

    private fun binding(raw: Map<*, *>): LarkBindingView {
        val value = raw.entries.associate { (key, item) ->
            (key as? String ?: invalid()) to item
        }
        exact(value, setOf("id", "chatName", "sessionName", "status", "replyMode"))
        val status = string(value, "status")
        if (status !in STATUSES) invalid()
        return LarkBindingView(
            id = id(value["id"]),
            chatName = nonEmptyText(value["chatName"], MAX_TEXT_BYTES),
            sessionName = nonEmptyText(value["sessionName"], MAX_TEXT_BYTES),
            status = status,
            replyMode = replyMode(value["replyMode"]),
        )
    }

    private fun objectValue(value: Map<String, Any?>, key: String): Map<String, Any?> {
        val raw = value[key] as? Map<*, *> ?: invalid()
        return raw.entries.associate { (itemKey, itemValue) ->
            (itemKey as? String ?: invalid()) to itemValue
        }
    }

    private fun exact(value: Map<String, Any?>, keys: Set<String>) {
        if (value.keys != keys) invalid()
    }

    private fun string(value: Map<String, Any?>, key: String): String =
        value[key] as? String ?: invalid()

    private fun id(value: Any?): String {
        val result = value as? String ?: invalid()
        if (result.isEmpty() || result.trim() != result || result.contains('\u0000') ||
            result.toByteArray(Charsets.UTF_8).size > MAX_ID_BYTES
        ) invalid()
        return result
    }

    private fun nonEmptyText(value: Any?, maxBytes: Int): String {
        val result = value as? String ?: invalid()
        if (result.isEmpty() || result.contains('\u0000') ||
            result.toByteArray(Charsets.UTF_8).size > maxBytes
        ) invalid()
        return result
    }

    private fun replyMode(value: Any?): String {
        val result = value as? String ?: invalid()
        if (result != "topic" && result != "direct") invalid()
        return result
    }

    private fun invalid(): Nothing = throw LarkBindingsV2CodecException()

    private inline fun <T> mapFailures(block: () -> T): T = try {
        block()
    } catch (error: LarkBindingsV2CodecException) {
        throw error
    } catch (_: RelayV2JsonException) {
        throw LarkBindingsV2CodecException()
    } catch (_: RuntimeException) {
        throw LarkBindingsV2CodecException()
    }

    private companion object {
        const val MAX_FRAME_BYTES = 1_048_576
        const val MAX_ID_BYTES = 128
        const val MAX_TEXT_BYTES = 1_024
        const val MAX_ERROR_MESSAGE_BYTES = 4_096
        const val MAX_BINDINGS = 256
        val JSON_LIMITS = RelayV2JsonLimits(12, 128, 2_048, 8_192)
        val REQUEST_KEYS = setOf(
            "protocolVersion", "kind", "type", "requestId", "hostId",
            "expectedHostEpoch", "scopeId", "sessionId", "payload",
        )
        val RESPONSE_KEYS = setOf(
            "protocolVersion", "kind", "type", "requestId", "hostId",
            "hostEpoch", "scopeId", "sessionId", "payload",
        )
        val STATUSES = setOf("active", "pausing", "paused", "stale")
        val ERROR_CODES = setOf("LARK_BINDINGS_UNAVAILABLE", "LARK_BINDING_INVALID")
    }
}
