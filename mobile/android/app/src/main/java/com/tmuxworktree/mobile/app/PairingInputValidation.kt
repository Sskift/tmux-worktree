package com.tmuxworktree.mobile.app

import java.net.URI

internal object PairingInputValidator {
    fun normalizeRelayUrl(value: String): String = value.trim().removeSuffix("/")

    fun relayUrlError(
        relayUrl: String,
        allowDebugLoopbackCleartext: Boolean,
    ): String? {
        if (relayUrl.isBlank()) return "Relay URL is required"
        if (relayUrl.length > MAX_RELAY_URL_LENGTH) return "Relay URL is too long"
        if (relayUrl.any { it.isISOControl() || it.isWhitespace() }) {
            return "Relay URL contains invalid characters"
        }
        val uri = runCatching { URI(relayUrl) }.getOrNull()
            ?: return "Relay URL is invalid"
        val scheme = uri.scheme?.lowercase().orEmpty()
        if (scheme.isBlank()) return "Relay URL must start with wss://"
        val host = uri.host?.lowercase().orEmpty()
        if (host.isBlank()) return "Relay URL must include a host"
        if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) {
            return "Relay URL must not include credentials, a query, or a fragment"
        }
        if (uri.rawPath.orEmpty() !in setOf("", "/")) {
            return "Relay URL must not include a path"
        }
        if (uri.port == 0 || uri.port > 65_535) return "Relay URL includes an invalid port"
        if (scheme == "wss") return null

        val debugLoopback = allowDebugLoopbackCleartext &&
            scheme == "ws" &&
            host in DEBUG_LOOPBACK_HOSTS
        if (debugLoopback) return null
        if (allowDebugLoopbackCleartext && scheme == "ws") {
            return "Debug ws:// is limited to emulator or loopback hosts. " +
                "Use wss:// for .local and other network hosts"
        }
        return "Use wss:// to protect the pairing token and terminal content"
    }

    fun credentialError(token: String, hostId: String): String? {
        if (token.isBlank()) return "Pairing token is required"
        if (token.length > MAX_TOKEN_LENGTH) return "Pairing token is too long"
        if (token.any { it == '\u0000' || it == '\r' || it == '\n' }) {
            return "Pairing token contains invalid characters"
        }
        if (hostId.trim().isNotEmpty() && !HOST_ID_PATTERN.matches(hostId.trim())) {
            return "Computer identifier is invalid"
        }
        return null
    }

    private val DEBUG_LOOPBACK_HOSTS = setOf(
        "10.0.2.2",
        "127.0.0.1",
        "localhost",
    )
    private val HOST_ID_PATTERN = Regex("[A-Za-z0-9._-]{1,80}")
    private const val MAX_RELAY_URL_LENGTH = 2_048
    private const val MAX_TOKEN_LENGTH = 4_096
}
