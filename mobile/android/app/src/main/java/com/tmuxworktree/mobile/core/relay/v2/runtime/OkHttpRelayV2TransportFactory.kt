package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2FrameMetadata
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2EndpointValidator
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

/**
 * A single-socket OkHttp adapter for the unwired Relay v2 actor seam.
 *
 * This class deliberately owns no reconnect, handshake phase, or generation state. Its only
 * mutable state makes socket operations and terminal callbacks one-shot; source identity and all
 * protocol decisions remain with [RelayV2ConnectionActor].
 */
internal class OkHttpRelayV2TransportFactory(
    client: OkHttpClient = defaultClient(),
) : RelayV2TransportFactory {
    private val client = client.newBuilder()
        .retryOnConnectionFailure(false)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    override fun open(
        request: RelayV2TransportOpenRequest,
        listener: RelayV2TransportListener,
    ): RelayV2Transport {
        require(RelayV2EndpointValidator.isRelayUrl(request.relayUrl)) {
            "Relay v2 transport endpoint is invalid"
        }
        require(request.offeredSubprotocols == listOf(RelayV2Profile.RELAY_V2_SUBPROTOCOL)) {
            "Relay v2 transport dialect is invalid"
        }
        require(isSafeAuthorizationValue(request.accessToken)) {
            "Relay v2 access credential is invalid"
        }

        val transport = OkHttpRelayV2Transport(listener)
        val upgrade = Request.Builder()
            .url(request.relayUrl)
            .header("Authorization", "Bearer ${request.accessToken}")
            .header("Sec-WebSocket-Protocol", RelayV2Profile.RELAY_V2_SUBPROTOCOL)
            .build()
        transport.attach(client.newWebSocket(upgrade, transport.callback))
        return transport
    }

    private fun isSafeAuthorizationValue(token: String): Boolean =
        token.startsWith("twcap2.") &&
            token.length <= MAX_ACCESS_TOKEN_BYTES &&
            token.all { it.code in VISIBLE_ASCII_RANGE }

    private class OkHttpRelayV2Transport(
        private val listener: RelayV2TransportListener,
    ) : RelayV2Transport {
        private val operationLock = Any()
        private val callbackIngressLock = Any()
        private var socket: WebSocket? = null
        private var closeRequest: CloseRequest? = null
        private var cancelled = false
        private var terminated = false
        private var openDelivered = false

        val callback: WebSocketListener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                attach(webSocket)
                val selected = response.headers.values("Sec-WebSocket-Protocol")
                val extensions = response.headers.values("Sec-WebSocket-Extensions")
                val accepted = selected == listOf(RelayV2Profile.RELAY_V2_SUBPROTOCOL) &&
                    extensions.isEmpty()
                if (!accepted) {
                    terminalCallback {
                        listener.onFailure(
                            this@OkHttpRelayV2Transport,
                            RelayV2TransportFailure(
                                kind = RelayV2TransportFailureKind.UPGRADE,
                                httpStatus = response.code,
                            ),
                        )
                    }
                    cancel()
                    return
                }
                synchronized(callbackIngressLock) {
                    if (terminated || openDelivered) return
                    openDelivered = true
                    listener.onOpen(
                        this@OkHttpRelayV2Transport,
                        RelayV2Profile.RELAY_V2_SUBPROTOCOL,
                    )
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                synchronized(callbackIngressLock) {
                    if (terminated || !openDelivered) return
                    listener.onFrame(
                        this@OkHttpRelayV2Transport,
                        boundedUtf8Copy(text),
                        RelayV2FrameMetadata(opcode = "text", compressed = false),
                    )
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                synchronized(callbackIngressLock) {
                    if (terminated || !openDelivered) return
                    val copy = if (bytes.size <= RelayV2Codec.PUBLIC_FRAME_BYTES) {
                        bytes.toByteArray()
                    } else {
                        bytes.substring(0, RelayV2Codec.PUBLIC_FRAME_BYTES + 1).toByteArray()
                    }
                    listener.onFrame(
                        this@OkHttpRelayV2Transport,
                        copy,
                        RelayV2FrameMetadata(opcode = "binary", compressed = false),
                    )
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                terminalCallback {
                    listener.onClosed(this@OkHttpRelayV2Transport, code)
                }
                val acknowledged = runCatching { webSocket.close(code, reason) }
                    .getOrDefault(false)
                if (!acknowledged) cancel()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                terminalCallback {
                    listener.onClosed(this@OkHttpRelayV2Transport, code)
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                terminalCallback {
                    listener.onFailure(
                        this@OkHttpRelayV2Transport,
                        RelayV2TransportFailure(
                            kind = if (response == null) {
                                RelayV2TransportFailureKind.NETWORK
                            } else {
                                RelayV2TransportFailureKind.UPGRADE
                            },
                            httpStatus = response?.code,
                        ),
                    )
                }
            }
        }

        fun attach(webSocket: WebSocket) {
            val pending = synchronized(operationLock) {
                if (socket != null) return
                socket = webSocket
                when {
                    cancelled || terminated -> PendingOperation.Cancel
                    closeRequest != null -> PendingOperation.Close(requireNotNull(closeRequest))
                    else -> PendingOperation.None
                }
            }
            when (pending) {
                PendingOperation.Cancel -> webSocket.cancel()
                is PendingOperation.Close -> webSocket.close(
                    pending.request.code,
                    pending.request.reason,
                )
                PendingOperation.None -> Unit
            }
        }

        override fun send(bytes: ByteArray): Boolean {
            if (bytes.size > RelayV2Codec.PUBLIC_FRAME_BYTES) return false
            val text = strictUtf8(bytes) ?: return false
            return synchronized(operationLock) {
                if (cancelled || terminated || closeRequest != null) return@synchronized false
                socket?.send(text) ?: false
            }
        }

        override fun close(code: Int, reason: String) {
            val close = CloseRequest(code, safeCloseReason(reason))
            val target = synchronized(operationLock) {
                if (cancelled || terminated || closeRequest != null) return
                closeRequest = close
                socket
            }
            if (target != null && !runCatching { target.close(close.code, close.reason) }
                    .getOrDefault(false)
            ) {
                cancel()
            }
        }

        override fun cancel() {
            val target = synchronized(operationLock) {
                if (cancelled) return
                cancelled = true
                socket
            }
            target?.cancel()
        }

        override fun toString(): String = "OkHttpRelayV2Transport(<redacted>)"

        private fun terminalCallback(block: () -> Unit) {
            synchronized(callbackIngressLock) {
                if (terminated) return
                terminated = true
                synchronized(operationLock) { terminated = true }
                block()
            }
        }

        private fun strictUtf8(bytes: ByteArray): String? = runCatching {
            StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
        }.getOrNull()

        private fun boundedUtf8Copy(text: String): ByteArray {
            val maximum = RelayV2Codec.PUBLIC_FRAME_BYTES
            val capacity = minOf(
                maximum.toLong() + MAX_UTF8_CODE_POINT_BYTES,
                text.length.toLong() * MAX_UTF8_BYTES_PER_UTF16_CODE_UNIT,
            ).toInt()
            val output = ByteBuffer.allocate(capacity)
            val input = CharBuffer.wrap(text)
            val encoder = StandardCharsets.UTF_8.newEncoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            val result = encoder.encode(input, output, true)
            if (result.isError) return byteArrayOf(0xC3.toByte())
            if (result.isOverflow || input.hasRemaining() || output.position() > maximum) {
                return output.array().copyOf(maximum + 1)
            }
            val flushed = encoder.flush(output)
            if (flushed.isError || flushed.isOverflow || output.position() > maximum) {
                return output.array().copyOf(maximum + 1)
            }
            return output.array().copyOf(output.position())
        }

        private fun safeCloseReason(reason: String): String =
            reason.takeIf {
                it.toByteArray(Charsets.UTF_8).size <= MAX_CLOSE_REASON_BYTES &&
                    it.none { character -> character == '\u0000' || character == '\r' || character == '\n' }
            } ?: "relay v2 close"

        private data class CloseRequest(val code: Int, val reason: String)

        private sealed interface PendingOperation {
            data object None : PendingOperation
            data object Cancel : PendingOperation
            data class Close(val request: CloseRequest) : PendingOperation
        }
    }

    private companion object {
        const val MAX_ACCESS_TOKEN_BYTES = 8_192
        const val MAX_CLOSE_REASON_BYTES = 123
        const val MAX_UTF8_CODE_POINT_BYTES = 4
        const val MAX_UTF8_BYTES_PER_UTF16_CODE_UNIT = 3
        val VISIBLE_ASCII_RANGE = 0x21..0x7E

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
    }
}
