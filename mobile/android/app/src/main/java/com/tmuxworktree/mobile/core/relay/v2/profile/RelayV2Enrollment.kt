package com.tmuxworktree.mobile.core.relay.v2.profile

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/**
 * Untrusted enrollment input that is safe to render on a review screen.
 *
 * Parsing has no persistence or transport side effects. The enrollment code stays in memory and is
 * deliberately redacted from string rendering; only [confirm] can turn the draft into an exchange
 * intent for the repository.
 */
internal data class RelayV2EnrollmentReviewDraft(
    val issuerUrl: String,
    val relayUrl: String,
    val hostId: String,
    val enrollmentId: String,
    internal val enrollmentCode: String,
) {
    fun confirm(deviceLabel: String?): RelayV2ConfirmedEnrollment =
        RelayV2ConfirmedEnrollment(
            draft = this,
            deviceLabel = deviceLabel?.trim()?.takeIf(String::isNotEmpty),
        )

    override fun toString(): String =
        "RelayV2EnrollmentReviewDraft(issuerUrl=$issuerUrl, relayUrl=$relayUrl, " +
            "hostId=$hostId, enrollmentId=$enrollmentId, enrollmentCode=<redacted>)"
}

internal data class RelayV2ConfirmedEnrollment(
    val draft: RelayV2EnrollmentReviewDraft,
    val deviceLabel: String?,
) {
    init {
        require(deviceLabel == null || deviceLabel.toByteArray(Charsets.UTF_8).size <= MAX_DEVICE_LABEL_BYTES) {
            "Device label is too long"
        }
        require(deviceLabel?.none { it == '\u0000' || it == '\r' || it == '\n' } != false) {
            "Device label contains invalid characters"
        }
    }

    override fun toString(): String =
        "RelayV2ConfirmedEnrollment(draft=$draft, deviceLabel=$deviceLabel)"

    private companion object {
        const val MAX_DEVICE_LABEL_BYTES = 128
    }
}

internal object RelayV2EnrollmentReviewParser {
    fun parse(raw: String?): RelayV2EnrollmentReviewDraft? {
        val value = raw?.trim().orEmpty()
        if (value.isBlank() || value.length > MAX_PAYLOAD_LENGTH) return null
        val uri = runCatching { URI(value) }.getOrNull() ?: return null
        if (!uri.scheme.equals("tmuxworktree", ignoreCase = true) ||
            !uri.host.equals("enroll", ignoreCase = true)
        ) return null
        if (uri.rawUserInfo != null ||
            uri.port != -1 ||
            uri.rawFragment != null ||
            uri.rawPath.orEmpty() !in setOf("", "/")
        ) return null

        val values = parseClosedQuery(uri.rawQuery) ?: return null
        if (values.keys != REQUIRED_FIELDS || values["v"] != "2") return null

        val issuerUrl = values.getValue("issuerUrl")
        val relayUrl = values.getValue("relayUrl")
        val hostId = values.getValue("hostId")
        val enrollmentId = values.getValue("enrollmentId")
        val enrollmentCode = values.getValue("enrollmentCode")
        if (!RelayV2EndpointValidator.isIssuerUrl(issuerUrl) ||
            !RelayV2EndpointValidator.isRelayUrl(relayUrl)
        ) return null
        if (!isOpaqueId(hostId) || !isOpaqueId(enrollmentId)) return null
        if (!enrollmentCode.startsWith("twenroll2.") ||
            enrollmentCode.length > MAX_ENROLLMENT_CODE_LENGTH ||
            enrollmentCode.any(::isForbiddenValueCharacter)
        ) return null

        return RelayV2EnrollmentReviewDraft(
            issuerUrl = issuerUrl,
            relayUrl = relayUrl,
            hostId = hostId,
            enrollmentId = enrollmentId,
            enrollmentCode = enrollmentCode,
        )
    }

    private fun parseClosedQuery(rawQuery: String?): Map<String, String>? {
        val query = rawQuery ?: return null
        if (query.isBlank() || query.length > MAX_QUERY_LENGTH) return null
        return runCatching {
            query.split('&')
                .also { require(it.size == REQUIRED_FIELDS.size) }
                .map { field ->
                    val separator = field.indexOf('=')
                    require(separator > 0)
                    decode(field.substring(0, separator)) to decode(field.substring(separator + 1))
                }
                .also { pairs -> require(pairs.map { it.first }.distinct().size == pairs.size) }
                .toMap()
        }.getOrNull()
    }

    private fun decode(value: String): String {
        var index = 0
        while (index < value.length) {
            if (value[index] == '%') {
                require(index + 2 < value.length)
                require(Character.digit(value[index + 1], 16) >= 0)
                require(Character.digit(value[index + 2], 16) >= 0)
                index += 3
            } else {
                index++
            }
        }
        val decoded = URLDecoder.decode(value, StandardCharsets.UTF_8.name())
        require('\uFFFD' !in decoded)
        require(decoded.none(::isForbiddenValueCharacter))
        return decoded
    }

    private fun isOpaqueId(value: String): Boolean =
        value.isNotBlank() &&
            value.toByteArray(Charsets.UTF_8).size <= MAX_ID_BYTES &&
            value == value.trim() &&
            value.none(::isForbiddenValueCharacter)

    private fun isForbiddenValueCharacter(character: Char): Boolean =
        character == '\u0000' || character == '\r' || character == '\n'

    private val REQUIRED_FIELDS = setOf(
        "v",
        "issuerUrl",
        "relayUrl",
        "hostId",
        "enrollmentId",
        "enrollmentCode",
    )
    private const val MAX_PAYLOAD_LENGTH = 8_192
    private const val MAX_QUERY_LENGTH = 7_680
    private const val MAX_ID_BYTES = 128
    private const val MAX_ENROLLMENT_CODE_LENGTH = 4_096
}

internal object RelayV2EndpointValidator {
    fun isIssuerUrl(value: String): Boolean = isEndpoint(
        value = value,
        expectedScheme = "https",
        allowedPaths = setOf("", "/"),
    )

    fun isRelayUrl(value: String): Boolean = isEndpoint(
        value = value,
        expectedScheme = "wss",
        allowedPaths = setOf("/client"),
    )

    private fun isEndpoint(
        value: String,
        expectedScheme: String,
        allowedPaths: Set<String>,
    ): Boolean {
        if (value.isBlank() || value.length > MAX_URL_LENGTH || value.any(::isForbiddenCharacter)) {
            return false
        }
        val uri = runCatching { URI(value) }.getOrNull() ?: return false
        if (!uri.scheme.equals(expectedScheme, ignoreCase = true) || uri.host.isNullOrBlank()) return false
        if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return false
        if (uri.port == 0 || uri.port > 65_535) return false
        if (uri.rawPath.orEmpty() !in allowedPaths) return false
        return true
    }

    private fun isForbiddenCharacter(character: Char): Boolean =
        character == '\u0000' || character == '\r' || character == '\n' || character.isWhitespace()

    private const val MAX_URL_LENGTH = 2_048
}
