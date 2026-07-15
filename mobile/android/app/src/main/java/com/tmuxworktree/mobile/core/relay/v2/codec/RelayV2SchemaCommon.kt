package com.tmuxworktree.mobile.core.relay.v2.codec

import java.math.BigInteger
import java.net.URI
import java.util.Base64

internal typealias RelayV2JsonObject = Map<String, Any?>

internal class RelayV2SchemaException(
    val failureClass: String,
) : IllegalArgumentException("Relay v2 message does not match the frozen schema")

internal fun schemaFailure(failureClass: String): Nothing {
    throw RelayV2SchemaException(failureClass)
}

internal fun jsonObject(value: Any?): RelayV2JsonObject {
    if (value == null) schemaFailure("forbidden-null")
    if (value !is Map<*, *>) schemaFailure("type-coercion")
    if (value.keys.any { it !is String }) schemaFailure("type-coercion")
    @Suppress("UNCHECKED_CAST")
    return value as RelayV2JsonObject
}

internal fun exactKeys(
    value: RelayV2JsonObject,
    required: Collection<String>,
    optional: Collection<String> = emptyList(),
) {
    required.forEach { key ->
        if (!value.containsKey(key)) schemaFailure("missing-field")
    }
    val allowed = required.toSet() + optional
    value.keys.forEach { key ->
        if (key !in allowed) schemaFailure("unknown-field")
    }
}

internal fun required(value: RelayV2JsonObject, name: String): Any? {
    if (!value.containsKey(name)) schemaFailure("missing-field")
    return value[name]
}

internal fun jsonString(
    value: Any?,
    allowEmpty: Boolean = false,
    allowOuterWhitespace: Boolean = false,
    maxBytes: Int = Int.MAX_VALUE,
    maxCharacters: Int = Int.MAX_VALUE,
    allowNul: Boolean = false,
): String {
    if (value == null) schemaFailure("forbidden-null")
    if (value !is String) schemaFailure("type-coercion")
    if (!allowEmpty && value.isEmpty()) schemaFailure("invalid-argument")
    if (!allowNul && '\u0000' in value) schemaFailure("invalid-argument")
    if (!allowOuterWhitespace && value.trim() != value) schemaFailure("invalid-argument")
    if (value.toByteArray(Charsets.UTF_8).size > maxBytes) schemaFailure("id-byte-limit")
    if (Character.codePointCount(value, 0, value.length) > maxCharacters) {
        schemaFailure("invalid-argument")
    }
    return value
}

internal fun jsonId(value: Any?): String = jsonString(value, maxBytes = 128)

internal fun jsonCursor(value: Any?): String = jsonString(value, maxBytes = 1_024)

internal fun jsonBoolean(value: Any?): Boolean {
    if (value == null) schemaFailure("forbidden-null")
    if (value !is Boolean) schemaFailure("type-coercion")
    return value
}

internal fun jsonNull(value: Any?) {
    if (value != null) schemaFailure("schema-mismatch")
}

internal fun jsonInteger(
    value: Any?,
    minimum: Long = 0,
    maximum: Long = 9_007_199_254_740_991L,
): Long {
    if (value == null) schemaFailure("forbidden-null")
    val number = value as? Number ?: schemaFailure("type-coercion")
    val result = when (number) {
        is Byte, is Short, is Int, is Long -> number.toLong()
        is Float, is Double -> {
            val double = number.toDouble()
            if (!double.isFinite() || double % 1.0 != 0.0) schemaFailure("type-coercion")
            if (double > Long.MAX_VALUE || double < Long.MIN_VALUE) schemaFailure("type-coercion")
            double.toLong()
        }
        else -> schemaFailure("type-coercion")
    }
    if (result !in minimum..maximum) schemaFailure("invalid-argument")
    return result
}

internal fun jsonLiteral(value: Any?, expected: Any) {
    val matches = when (expected) {
        is Int -> value is Number && value.toLong() == expected.toLong()
        is Long -> value is Number && value.toLong() == expected
        else -> value == expected
    }
    if (!matches) {
        if (value == null) schemaFailure("forbidden-null")
        schemaFailure("schema-mismatch")
    }
}

internal fun jsonOneOf(value: Any?, allowed: Collection<String>): String {
    if (value == null) schemaFailure("forbidden-null")
    if (value !is String) schemaFailure("type-coercion")
    if (value !in allowed) schemaFailure("schema-mismatch")
    return value
}

internal fun jsonArray(
    value: Any?,
    maximum: Int,
    minimum: Int = 0,
    validator: (Any?) -> Unit,
): List<Any?> {
    if (value == null) schemaFailure("forbidden-null")
    if (value !is List<*>) schemaFailure("type-coercion")
    if (value.size !in minimum..maximum) schemaFailure("invalid-argument")
    value.forEach(validator)
    return value
}

internal fun jsonNullable(value: Any?, validator: (Any?) -> Unit) {
    if (value != null) validator(value)
}

internal fun jsonCounter(value: Any?): String {
    if (value == null) schemaFailure("forbidden-null")
    if (value !is String) schemaFailure("type-coercion")
    if (!COUNTER_REGEX.matches(value)) schemaFailure("non-canonical-counter")
    if (BigInteger(value) > COUNTER_MAX) schemaFailure("counter-overflow")
    return value
}

internal fun jsonCanonicalBase64(value: Any?, maxDecodedBytes: Int): String {
    if (value == null) schemaFailure("forbidden-null")
    if (value !is String) schemaFailure("type-coercion")
    val encoded = value
    if (encoded.isEmpty() || encoded.trim() != encoded || '\u0000' in encoded) {
        schemaFailure("invalid-argument")
    }
    if (!BASE64_REGEX.matches(encoded)) schemaFailure("non-canonical-base64")
    val padding = when {
        encoded.endsWith("==") -> 2
        encoded.endsWith("=") -> 1
        else -> 0
    }
    val decodedLength = (encoded.length / 4) * 3 - padding
    if (decodedLength > maxDecodedBytes) schemaFailure("base64-decoded-limit")
    val decoded = try {
        Base64.getDecoder().decode(encoded)
    } catch (_: IllegalArgumentException) {
        schemaFailure("non-canonical-base64")
    }
    if (Base64.getEncoder().encodeToString(decoded) != encoded) {
        schemaFailure("non-canonical-base64")
    }
    return encoded
}

internal fun jsonCanonicalBase64Url(value: Any?, decodedBytes: Int? = null): String {
    val encoded = jsonString(value, maxBytes = 2_048)
    if (!BASE64_URL_REGEX.matches(encoded) || '=' in encoded) {
        schemaFailure("non-canonical-base64url")
    }
    if (decodedBytes != null && encoded.length != (decodedBytes * 4 + 2) / 3) {
        schemaFailure("non-canonical-base64url")
    }
    val decoded = try {
        Base64.getUrlDecoder().decode(encoded)
    } catch (_: IllegalArgumentException) {
        schemaFailure("non-canonical-base64url")
    }
    if (Base64.getUrlEncoder().withoutPadding().encodeToString(decoded) != encoded) {
        schemaFailure("non-canonical-base64url")
    }
    return encoded
}

internal fun jsonCapabilities(value: Any?): List<String> {
    val seen = hashSetOf<String>()
    return jsonArray(value, maximum = 64) { item ->
        val capability = jsonId(item)
        if (!seen.add(capability)) schemaFailure("schema-mismatch")
    }.map { it as String }
}

internal fun validateStructuredError(value: Any?) {
    val error = jsonObject(value)
    exactKeys(
        error,
        required = listOf("code", "message", "retryable", "commandDisposition"),
        optional = listOf("retryAfterMs", "details"),
    )
    val code = jsonString(required(error, "code"), maxBytes = 128)
    if (code !in ERROR_CODES) schemaFailure("schema-mismatch")
    jsonString(
        required(error, "message"),
        allowOuterWhitespace = true,
        maxBytes = 4_096,
    )
    jsonBoolean(required(error, "retryable"))
    jsonOneOf(required(error, "commandDisposition"), COMMAND_DISPOSITIONS)
    if (error.containsKey("retryAfterMs")) {
        jsonNullable(error["retryAfterMs"]) { jsonInteger(it) }
    }
    if (!error.containsKey("details") || error["details"] == null) return
    val details = jsonObject(error["details"])
    when (code) {
        "HOST_EPOCH_MISMATCH" -> {
            exactKeys(details, listOf("expectedHostEpoch", "actualHostEpoch"))
            jsonId(required(details, "expectedHostEpoch"))
            jsonId(required(details, "actualHostEpoch"))
        }
        "EVENT_CURSOR_AHEAD" -> {
            exactKeys(details, listOf("clientLastEventSeq", "hostEventSeq"))
            jsonCounter(required(details, "clientLastEventSeq"))
            jsonCounter(required(details, "hostEventSeq"))
        }
        "COMMAND_WINDOW_EXPIRED" -> {
            exactKeys(details, listOf("reissueRequired"))
            jsonLiteral(required(details, "reissueRequired"), true)
        }
        "SNAPSHOT_TOO_LARGE" -> {
            exactKeys(details, listOf("useStateSnapshot"))
            jsonLiteral(required(details, "useStateSnapshot"), true)
        }
        "COMMAND_RESULT_EXPIRED" -> {
            exactKeys(details, listOf("finalState"))
            jsonOneOf(required(details, "finalState"), FINAL_COMMAND_STATES)
        }
        else -> schemaFailure("schema-mismatch")
    }
}

internal fun validateScope(value: Any?) {
    val scope = jsonObject(value)
    exactKeys(scope, listOf("scopeId", "displayName", "kind", "reachability"))
    jsonId(required(scope, "scopeId"))
    jsonString(
        required(scope, "displayName"),
        allowOuterWhitespace = true,
        maxBytes = 128,
    )
    jsonOneOf(required(scope, "kind"), setOf("local", "ssh"))
    jsonOneOf(required(scope, "reachability"), setOf("online", "unreachable"))
}

internal fun validateSession(value: Any?) {
    val session = jsonObject(value)
    exactKeys(
        session,
        listOf(
            "scopeId",
            "sessionId",
            "kind",
            "displayName",
            "state",
            "project",
            "label",
            "cwd",
            "attached",
            "windowCount",
            "createdAtMs",
            "activityAtMs",
        ),
    )
    jsonId(required(session, "scopeId"))
    jsonId(required(session, "sessionId"))
    val kind = jsonOneOf(required(session, "kind"), setOf("worktree", "terminal"))
    jsonString(
        required(session, "displayName"),
        allowOuterWhitespace = true,
        maxBytes = 128,
    )
    jsonLiteral(required(session, "state"), "running")
    val project = session["project"]?.also {
        jsonString(it, maxBytes = 128)
    } as? String
    val label = session["label"]?.also {
        jsonString(it, allowOuterWhitespace = true, maxBytes = 128)
    } as? String
    val cwd = session["cwd"]?.also {
        jsonString(it, allowOuterWhitespace = true, maxBytes = 4_096)
    } as? String
    if (kind == "worktree" && (project == null || cwd == null)) {
        schemaFailure("schema-mismatch")
    }
    if (kind == "terminal" && (label == null || cwd == null)) {
        schemaFailure("schema-mismatch")
    }
    jsonBoolean(required(session, "attached"))
    jsonInteger(required(session, "windowCount"))
    jsonInteger(required(session, "createdAtMs"))
    jsonInteger(required(session, "activityAtMs"))
}

internal fun validateTopLevelIdentifiers(frame: RelayV2JsonObject) {
    listOf(
        "requestId",
        "commandId",
        "hostId",
        "expectedHostEpoch",
        "hostEpoch",
        "hostInstanceId",
        "scopeId",
        "sessionId",
        "streamId",
    ).forEach { name ->
        if (frame.containsKey(name)) jsonId(frame[name])
    }
    if (frame.containsKey("eventSeq")) jsonCounter(frame["eventSeq"])
}

internal fun jsonSecret(value: Any?): String = jsonString(value, maxBytes = 8_192)

internal fun jsonExactUrl(value: Any?, scheme: String): String {
    val text = jsonString(value, maxBytes = 2_048)
    val uri = try {
        URI(text)
    } catch (_: Throwable) {
        schemaFailure("invalid-argument")
    }
    if (
        uri.scheme != scheme ||
        uri.userInfo != null ||
        uri.fragment != null ||
        uri.host.isNullOrEmpty()
    ) {
        schemaFailure("invalid-argument")
    }
    return text
}

internal fun jsonHttpsUrl(value: Any?): String = jsonExactUrl(value, "https")

internal fun jsonWssUrl(value: Any?): String = jsonExactUrl(value, "wss")

private val COUNTER_REGEX = Regex("^(?:0|[1-9][0-9]*)$")
private val COUNTER_MAX = BigInteger("18446744073709551615")
private val BASE64_REGEX =
    Regex("^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")
private val BASE64_URL_REGEX = Regex("^[A-Za-z0-9_-]{2,}$")
private val COMMAND_DISPOSITIONS = setOf(
    "not_accepted",
    "accepted",
    "running",
    "completed",
    "in_doubt",
    "not_applicable",
)
private val FINAL_COMMAND_STATES = setOf("succeeded", "failed", "in_doubt")
private val ERROR_CODES = setOf(
    "AUTH_REQUIRED",
    "AUTH_INVALID",
    "PERMISSION_DENIED",
    "GRANT_NOT_FOUND",
    "ROLE_MISMATCH",
    "PROTOCOL_UNSUPPORTED",
    "HOST_DIALECT_UNAVAILABLE",
    "CAPABILITY_UNAVAILABLE",
    "INVALID_ENVELOPE",
    "INVALID_ARGUMENT",
    "HOST_NOT_FOUND",
    "HOST_OFFLINE",
    "HOST_EPOCH_MISMATCH",
    "EVENT_CURSOR_AHEAD",
    "HOST_SUPERSEDED",
    "DUPLICATE_CONNECTOR",
    "SCOPE_NOT_FOUND",
    "SCOPE_UNREACHABLE",
    "SNAPSHOT_EXPIRED",
    "SNAPSHOT_TOO_LARGE",
    "PROJECT_NOT_FOUND",
    "SESSION_NOT_FOUND",
    "PANE_NOT_FOUND",
    "IDEMPOTENCY_CONFLICT",
    "COMMAND_NOT_ACCEPTED",
    "COMMAND_WINDOW_EXPIRED",
    "COMMAND_RESULT_EXPIRED",
    "COMMAND_STATUS_UNKNOWN",
    "COMMAND_IN_DOUBT",
    "COMMAND_FAILED",
    "RATE_LIMITED",
    "BUSY",
    "SLOW_CONSUMER",
    "TERMINAL_STREAM_NOT_FOUND",
    "TERMINAL_STREAM_CONFLICT",
    "TERMINAL_OPEN_CONFLICT",
    "TERMINAL_CLOSE_CONFLICT",
    "TERMINAL_ROUTE_STALE",
    "TERMINAL_GENERATION_STALE",
    "TERMINAL_OFFSET_EXPIRED",
    "TERMINAL_INVALID_ACK",
    "TERMINAL_INPUT_GAP",
    "TERMINAL_INPUT_CONFLICT",
    "TERMINAL_RESIZE_GAP",
    "TERMINAL_RESIZE_CONFLICT",
    "INTERNAL",
)
