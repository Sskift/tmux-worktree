package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2EndpointValidator
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

internal data class RelayV2WebSocketEndpoint(
    val host: String,
    val port: Int,
    val hostHeader: String,
) {
    companion object {
        fun parse(value: String): RelayV2WebSocketEndpoint {
            if (!RelayV2EndpointValidator.isRelayUrl(value)) {
                throw IllegalArgumentException("Relay v2 WebSocket endpoint is invalid")
            }
            val uri = runCatching { URI(value) }.getOrNull()
                ?: throw IllegalArgumentException("Relay v2 WebSocket endpoint is invalid")
            val host = requireNotNull(uri.host).removeSurrounding("[", "]")
            val port = if (uri.port == -1) 443 else uri.port
            val headerHost = if (':' in host) "[$host]" else host
            return RelayV2WebSocketEndpoint(
                host = host,
                port = port,
                hostHeader = if (port == 443) headerHost else "$headerHost:$port",
            )
        }
    }
}

internal class RelayV2UpgradeException(
    val httpStatus: Int? = null,
) : IOException("Relay v2 WebSocket upgrade failed")

internal class RelayV2WebSocketProtocolException :
    IOException("Relay v2 WebSocket protocol violation")

internal object BoundedRfc6455Handshake {
    const val MAX_STATUS_LINE_BYTES = 1_024
    const val MAX_HEADER_LINE_BYTES = 8_192
    const val MAX_HEADER_COUNT = 64
    const val MAX_HEADER_BYTES = 32_768

    private const val WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    fun perform(
        input: InputStream,
        output: OutputStream,
        endpoint: RelayV2WebSocketEndpoint,
        accessToken: String,
        random: SecureRandom,
    ): String {
        val nonce = ByteArray(16).also(random::nextBytes)
        val key = Base64.getEncoder().encodeToString(nonce)
        nonce.fill(0)
        writeRequest(output, endpoint, accessToken, key)

        val response = readResponse(input)
        if (response.status != 101) throw RelayV2UpgradeException(response.status)
        if (response.headers.containsKey("sec-websocket-extensions")) {
            throw RelayV2WebSocketProtocolException()
        }
        val upgrade = response.singleHeader("upgrade")
        val connectionTokens = response.singleHeader("connection")
            .split(',')
            .map(String::trim)
        val accept = response.singleHeader("sec-websocket-accept")
        val selected = response.singleHeader("sec-websocket-protocol")
        if (!upgrade.equals("websocket", ignoreCase = true) ||
            connectionTokens.none { it.equals("upgrade", ignoreCase = true) } ||
            accept != expectedAccept(key) ||
            selected != RelayV2Profile.RELAY_V2_SUBPROTOCOL
        ) {
            throw RelayV2WebSocketProtocolException()
        }
        return selected
    }

    private fun writeRequest(
        output: OutputStream,
        endpoint: RelayV2WebSocketEndpoint,
        accessToken: String,
        key: String,
    ) {
        output.writeAscii("GET /client HTTP/1.1\r\n")
        output.writeAscii("Host: ${endpoint.hostHeader}\r\n")
        output.writeAscii("Upgrade: websocket\r\n")
        output.writeAscii("Connection: Upgrade\r\n")
        output.writeAscii("Sec-WebSocket-Key: $key\r\n")
        output.writeAscii("Sec-WebSocket-Version: 13\r\n")
        output.writeAscii("Sec-WebSocket-Protocol: ${RelayV2Profile.RELAY_V2_SUBPROTOCOL}\r\n")
        output.writeAscii("Authorization: Bearer ")
        val tokenBytes = accessToken.toByteArray(Charsets.US_ASCII)
        try {
            output.write(tokenBytes)
        } finally {
            tokenBytes.fill(0)
        }
        output.writeAscii("\r\n\r\n")
        output.flush()
    }

    private fun readResponse(input: InputStream): UpgradeResponse {
        val total = HeaderByteBudget(MAX_HEADER_BYTES)
        val statusLine = readCrlfLine(input, MAX_STATUS_LINE_BYTES, total)
        val match = STATUS_LINE.matchEntire(statusLine) ?: throw RelayV2WebSocketProtocolException()
        val status = match.groupValues[1].toInt()
        val headers = linkedMapOf<String, MutableList<String>>()
        var count = 0
        while (true) {
            val line = readCrlfLine(input, MAX_HEADER_LINE_BYTES, total)
            if (line.isEmpty()) break
            count += 1
            if (count > MAX_HEADER_COUNT || line.startsWith(' ') || line.startsWith('\t')) {
                throw RelayV2WebSocketProtocolException()
            }
            val separator = line.indexOf(':')
            if (separator <= 0) throw RelayV2WebSocketProtocolException()
            val name = line.substring(0, separator)
            val value = line.substring(separator + 1).trim()
            if (!name.all(::isHeaderNameCharacter) || value.any(::isForbiddenHeaderValueCharacter)) {
                throw RelayV2WebSocketProtocolException()
            }
            headers.getOrPut(name.lowercase()) { mutableListOf() } += value
        }
        return UpgradeResponse(status, headers)
    }

    private fun readCrlfLine(
        input: InputStream,
        maximumBytes: Int,
        total: HeaderByteBudget,
    ): String {
        val output = ByteArrayOutputStream(minOf(maximumBytes, 256))
        while (true) {
            val value = input.readHeaderByte(total)
            when (value) {
                '\r'.code -> {
                    if (input.readHeaderByte(total) != '\n'.code) {
                        throw RelayV2WebSocketProtocolException()
                    }
                    return output.toString(Charsets.ISO_8859_1.name())
                }
                '\n'.code -> throw RelayV2WebSocketProtocolException()
                else -> {
                    if (output.size() >= maximumBytes) throw RelayV2WebSocketProtocolException()
                    output.write(value)
                }
            }
        }
    }

    private fun InputStream.readHeaderByte(total: HeaderByteBudget): Int {
        val value = read()
        if (value == -1) throw EOFException("Relay v2 WebSocket upgrade was truncated")
        total.consume()
        return value
    }

    private fun UpgradeResponse.singleHeader(name: String): String {
        val values = headers[name] ?: throw RelayV2WebSocketProtocolException()
        if (values.size != 1 || ',' in values.single() && name != "connection") {
            throw RelayV2WebSocketProtocolException()
        }
        return values.single()
    }

    private fun expectedAccept(key: String): String {
        val digest = MessageDigest.getInstance("SHA-1")
            .digest((key + WEBSOCKET_GUID).toByteArray(Charsets.US_ASCII))
        return Base64.getEncoder().encodeToString(digest)
    }

    private fun OutputStream.writeAscii(value: String) {
        write(value.toByteArray(Charsets.US_ASCII))
    }

    private fun isHeaderNameCharacter(value: Char): Boolean =
        value.isLetterOrDigit() || value in "!#$%&'*+-.^_`|~"

    private fun isForbiddenHeaderValueCharacter(value: Char): Boolean =
        value == '\u0000' || value == '\r' || value == '\n' ||
            (value.code < 0x20 && value != '\t') || value.code == 0x7f

    private data class UpgradeResponse(
        val status: Int,
        val headers: Map<String, List<String>>,
    )

    private class HeaderByteBudget(private val maximum: Int) {
        private var consumed = 0

        fun consume() {
            consumed += 1
            if (consumed > maximum) throw RelayV2WebSocketProtocolException()
        }
    }

    private val STATUS_LINE = Regex("^HTTP/1\\.1 ([0-9]{3})(?: [^\\r\\n]*)?$")
}
