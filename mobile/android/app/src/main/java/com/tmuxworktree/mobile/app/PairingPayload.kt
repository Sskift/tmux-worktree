package com.tmuxworktree.mobile.app

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

data class PairingPayload(
    val relayUrl: String,
    val token: String,
    val hostId: String = "",
)

object PairingPayloadParser {
    fun parse(raw: String?): PairingPayload? {
        val value = raw?.trim().orEmpty()
        if (value.isBlank() || value.length > MAX_PAYLOAD_LENGTH) return null
        val uri = runCatching { URI(value) }.getOrNull() ?: return null
        if (!uri.scheme.equals("tmuxworktree", ignoreCase = true) ||
            !uri.host.equals("pair", ignoreCase = true)
        ) return null
        if (uri.rawUserInfo != null ||
            uri.port != -1 ||
            uri.rawFragment != null ||
            uri.rawPath.orEmpty() !in setOf("", "/")
        ) return null
        val query = uri.rawQuery.orEmpty()
        if (query.length > MAX_QUERY_LENGTH) return null
        val values = runCatching {
            query.split('&')
                .take(MAX_QUERY_FIELDS + 1)
                .also { require(it.size <= MAX_QUERY_FIELDS) }
                .map { pair ->
                    val separator = pair.indexOf('=')
                    require(separator > 0)
                    decode(pair.substring(0, separator)) to decode(pair.substring(separator + 1))
                }
                .also { pairs -> require(pairs.map { it.first }.distinct().size == pairs.size) }
                .toMap()
        }.getOrNull() ?: return null
        val relayUrl = values.first("relayUrl", "relay", "url")
        val token = values.first("relaySecret", "token", "secret")
        val hostId = values.first("hostId", "host")
        if (relayUrl.isBlank() || token.isBlank()) return null
        if (relayUrl.length > MAX_RELAY_URL_LENGTH ||
            token.length > MAX_TOKEN_LENGTH ||
            hostId.length > MAX_HOST_ID_LENGTH
        ) return null
        return PairingPayload(relayUrl, token, hostId)
    }

    private fun Map<String, String>.first(vararg keys: String): String =
        keys.firstNotNullOfOrNull { key -> this[key]?.takeIf(String::isNotBlank) }.orEmpty()

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
        // URLDecoder replaces malformed UTF-8 byte sequences with U+FFFD.
        // Pairing credentials must round-trip exactly, so replacement and
        // line-control characters make the entire payload invalid.
        require('\uFFFD' !in decoded)
        require(decoded.none { it == '\u0000' || it == '\r' || it == '\n' })
        return decoded
    }

    private const val MAX_PAYLOAD_LENGTH = 8_192
    private const val MAX_QUERY_LENGTH = 7_680
    private const val MAX_QUERY_FIELDS = 16
    private const val MAX_RELAY_URL_LENGTH = 2_048
    private const val MAX_TOKEN_LENGTH = 4_096
    private const val MAX_HOST_ID_LENGTH = 128
}
