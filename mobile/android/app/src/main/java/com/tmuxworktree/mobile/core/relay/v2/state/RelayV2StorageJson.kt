package com.tmuxworktree.mobile.core.relay.v2.state

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonException
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2JsonLimits
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2StrictJson
import java.security.MessageDigest

internal data class RelayV2EncodedPayload(
    val codecVersion: Int,
    val payloadUtf8Bytes: Int,
    val canonicalJson: String,
    val sha256: String,
) {
    override fun toString(): String =
        "RelayV2EncodedPayload(codecVersion=$codecVersion, bytes=$payloadUtf8Bytes, <redacted>)"
}

internal enum class RelayV2StorageFailure {
    SCHEMA_INCOMPATIBLE,
    MISSING_REQUIRED_FIELD,
    MALFORMED,
    LIMIT_EXCEEDED,
}

/** Redacted fail-closed signal. Persisted payload content is never included in the exception. */
internal class RelayV2StorageException(
    val failure: RelayV2StorageFailure,
) : IllegalStateException("Relay v2 persisted state is invalid")

internal object RelayV2StorageJson {
    fun encode(codecVersion: Int, value: Map<String, Any?>): RelayV2EncodedPayload {
        val canonicalJson = RelayV2StrictJson.stringify(value)
        val bytes = canonicalJson.toByteArray(Charsets.UTF_8)
        return RelayV2EncodedPayload(
            codecVersion = codecVersion,
            payloadUtf8Bytes = bytes.size,
            canonicalJson = canonicalJson,
            sha256 = sha256(bytes),
        )
    }

    fun decode(
        payload: RelayV2EncodedPayload,
        expectedCodecVersion: Int,
        maxPayloadBytes: Int,
        limits: RelayV2JsonLimits,
    ): Map<String, Any?> {
        if (payload.payloadUtf8Bytes !in 1..maxPayloadBytes ||
            payload.canonicalJson.length > maxPayloadBytes
        ) {
            throw RelayV2StorageException(RelayV2StorageFailure.LIMIT_EXCEEDED)
        }
        val bytes = payload.canonicalJson.toByteArray(Charsets.UTF_8)
        if (bytes.size != payload.payloadUtf8Bytes) {
            throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
        }
        val expectedDigest = decodeDigest(payload.sha256)
        val actualDigest = MessageDigest.getInstance("SHA-256").digest(bytes)
        if (!MessageDigest.isEqual(expectedDigest, actualDigest)) {
            throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
        }
        val decoded = try {
            RelayV2StrictJson.parseObject(payload.canonicalJson, limits)
        } catch (_: RelayV2JsonException) {
            throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
        }
        if (RelayV2StrictJson.stringify(decoded) != payload.canonicalJson) {
            throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
        }
        if (payload.codecVersion != expectedCodecVersion) {
            throw RelayV2StorageException(RelayV2StorageFailure.SCHEMA_INCOMPATIBLE)
        }
        return decoded
    }

    fun requireKeys(value: Map<String, Any?>, vararg names: String) {
        val expected = names.toSet()
        if (value.keys != expected) {
            val failure = if (expected.any { it !in value }) {
                RelayV2StorageFailure.MISSING_REQUIRED_FIELD
            } else {
                RelayV2StorageFailure.SCHEMA_INCOMPATIBLE
            }
            throw RelayV2StorageException(failure)
        }
    }

    fun string(value: Map<String, Any?>, name: String): String =
        value[name] as? String
            ?: throw RelayV2StorageException(RelayV2StorageFailure.MISSING_REQUIRED_FIELD)

    fun nullableString(value: Map<String, Any?>, name: String): String? = when (val item = value[name]) {
        null -> null
        is String -> item
        else -> throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
    }

    fun boolean(value: Map<String, Any?>, name: String): Boolean =
        value[name] as? Boolean
            ?: throw RelayV2StorageException(RelayV2StorageFailure.MISSING_REQUIRED_FIELD)

    fun int(value: Map<String, Any?>, name: String): Int {
        val number = value[name] as? Long
            ?: throw RelayV2StorageException(RelayV2StorageFailure.MISSING_REQUIRED_FIELD)
        if (number !in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) {
            throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
        }
        return number.toInt()
    }

    fun nullableInt(value: Map<String, Any?>, name: String): Int? = when (val item = value[name]) {
        null -> null
        is Long -> {
            if (item !in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) {
                throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
            }
            item.toInt()
        }
        else -> throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
    }

    fun decimalLong(value: Map<String, Any?>, name: String): Long =
        string(value, name).toLongOrNull()
            ?: throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)

    fun objectValue(value: Map<String, Any?>, name: String): Map<String, Any?> =
        objectValue(value[name])

    fun nullableObject(value: Map<String, Any?>, name: String): Map<String, Any?>? =
        value[name]?.let(::objectValue)

    fun objectValue(value: Any?): Map<String, Any?> {
        if (value !is Map<*, *>) {
            throw RelayV2StorageException(RelayV2StorageFailure.MISSING_REQUIRED_FIELD)
        }
        if (value.keys.any { it !is String }) {
            throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
        }
        @Suppress("UNCHECKED_CAST")
        return value as Map<String, Any?>
    }

    fun list(value: Map<String, Any?>, name: String, maxSize: Int): List<Any?> {
        val result = value[name] as? List<*>
            ?: throw RelayV2StorageException(RelayV2StorageFailure.MISSING_REQUIRED_FIELD)
        if (result.size > maxSize) {
            throw RelayV2StorageException(RelayV2StorageFailure.LIMIT_EXCEEDED)
        }
        return result
    }

    fun stringList(value: Map<String, Any?>, name: String, maxSize: Int): List<String> =
        list(value, name, maxSize).map { item ->
            item as? String ?: throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
        }

    inline fun <reified T : Enum<T>> enum(value: Map<String, Any?>, name: String): T {
        val encoded = string(value, name)
        return enumValues<T>().singleOrNull { it.name == encoded }
            ?: throw RelayV2StorageException(RelayV2StorageFailure.SCHEMA_INCOMPATIBLE)
    }

    inline fun <reified T : Enum<T>> nullableEnum(value: Map<String, Any?>, name: String): T? =
        nullableString(value, name)?.let { encoded ->
            enumValues<T>().singleOrNull { it.name == encoded }
                ?: throw RelayV2StorageException(RelayV2StorageFailure.SCHEMA_INCOMPATIBLE)
        }

    private fun sha256(value: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(value)
        .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

    private fun decodeDigest(value: String): ByteArray {
        if (!SHA256.matches(value)) {
            throw RelayV2StorageException(RelayV2StorageFailure.MALFORMED)
        }
        return ByteArray(32) { index ->
            value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
    }

    private val SHA256 = Regex("^[0-9a-f]{64}$")
}
