package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2FrameMetadata
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.CertPathValidatorException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import kotlin.concurrent.thread

/**
 * Unwired, bounded RFC6455 transport foundation for the existing Relay v2 actor seam.
 *
 * This adapter owns only one bounded/cancellable address resolution, one TLS socket, one HTTP/1.1
 * Upgrade, RFC6455 framing, and its bounded write queues. It never retries, redirects,
 * authenticates a challenge, reconnects, decodes Relay JSON, or owns an actor generation/phase.
 */
internal class BoundedRelayV2TransportFactory(
    private val sslSocketFactory: SSLSocketFactory = systemTrustSocketFactory(),
    private val additionalHostnameVerifier: HostnameVerifier? = null,
    private val addressResolver: RelayV2AddressResolver = RelayV2SystemAddressResolver,
    private val rawSocketFactory: () -> Socket = ::Socket,
    private val randomFactory: () -> SecureRandom = ::SecureRandom,
    private val resolveTimeoutMs: Int = DEFAULT_RESOLVE_TIMEOUT_MS,
    private val connectTimeoutMs: Int = DEFAULT_CONNECT_TIMEOUT_MS,
    private val handshakeTimeoutMs: Int = DEFAULT_HANDSHAKE_TIMEOUT_MS,
) : RelayV2TransportFactory {
    init {
        require(resolveTimeoutMs > 0)
        require(connectTimeoutMs > 0)
        require(handshakeTimeoutMs > 0)
    }

    override fun open(
        request: RelayV2TransportOpenRequest,
        listener: RelayV2TransportListener,
    ): RelayV2Transport {
        val endpoint = RelayV2WebSocketEndpoint.parse(request.relayUrl)
        return BoundedRelayV2Transport(
            endpoint = endpoint,
            accessToken = request.accessToken,
            listener = listener,
            sslSocketFactory = sslSocketFactory,
            additionalHostnameVerifier = additionalHostnameVerifier,
            addressResolver = addressResolver,
            rawSocketFactory = rawSocketFactory,
            random = randomFactory(),
            resolveTimeoutMs = resolveTimeoutMs,
            connectTimeoutMs = connectTimeoutMs,
            handshakeTimeoutMs = handshakeTimeoutMs,
        ).also(BoundedRelayV2Transport::start)
    }

    private companion object {
        const val DEFAULT_RESOLVE_TIMEOUT_MS = 10_000
        const val DEFAULT_CONNECT_TIMEOUT_MS = 10_000
        const val DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000

        fun systemTrustSocketFactory(): SSLSocketFactory =
            SSLContext.getInstance("TLS").apply { init(null, null, null) }.socketFactory
    }
}

private class BoundedRelayV2Transport(
    private val endpoint: RelayV2WebSocketEndpoint,
    private val accessToken: String,
    private val listener: RelayV2TransportListener,
    private val sslSocketFactory: SSLSocketFactory,
    private val additionalHostnameVerifier: HostnameVerifier?,
    private val addressResolver: RelayV2AddressResolver,
    private val rawSocketFactory: () -> Socket,
    private val random: SecureRandom,
    private val resolveTimeoutMs: Int,
    private val connectTimeoutMs: Int,
    private val handshakeTimeoutMs: Int,
) : RelayV2Transport {
    private val callbackLock = Any()
    private val terminal = AtomicBoolean(false)
    private val protocolFailureInProgress = AtomicBoolean(false)
    private val resolution = AtomicReference<RelayV2AddressResolution?>()
    private val socket = AtomicReference<Socket?>()
    private val writer = AtomicReference<BoundedRfc6455Writer?>()
    private val connectionThread = AtomicReference<Thread?>()
    private val opened = AtomicBoolean(false)

    fun start() {
        connectionThread.set(
            thread(name = "tw-relay-v2-ws-reader", isDaemon = true) {
                connectAndRead()
            },
        )
    }

    override fun send(bytes: ByteArray): Boolean =
        !terminal.get() && opened.get() && writer.get()?.enqueueText(bytes) == true

    override fun close(code: Int, reason: String) {
        val currentWriter = writer.get()
        if (terminal.get()) return
        if (currentWriter == null || !opened.get()) {
            terminateSilently()
        } else {
            if (!currentWriter.close(code, reason)) terminateSilently()
        }
    }

    override fun cancel() {
        terminateSilently()
    }

    override fun toString(): String = "BoundedRelayV2Transport(<redacted>)"

    private fun connectAndRead() {
        var raw: Socket? = null
        try {
            val address = resolveAddress() ?: return
            if (terminal.get()) return
            raw = rawSocketFactory()
            if (!registerSocket(raw)) return
            raw.connect(InetSocketAddress(address, endpoint.port), connectTimeoutMs)
            if (terminal.get()) return

            val tls = sslSocketFactory.createSocket(
                raw,
                endpoint.host,
                endpoint.port,
                true,
            ) as? SSLSocket ?: throw IOException("Relay v2 TLS socket is unavailable")
            if (!replaceSocket(raw, tls)) return
            raw = null
            tls.useClientMode = true
            tls.soTimeout = handshakeTimeoutMs
            tls.sslParameters = tls.sslParameters.apply {
                endpointIdentificationAlgorithm = "HTTPS"
            }
            tls.startHandshake()
            if (additionalHostnameVerifier?.verify(endpoint.host, tls.session) == false) {
                throw RelayV2TlsValidationException()
            }

            val selected = BoundedRfc6455Handshake.perform(
                input = tls.inputStream,
                output = tls.outputStream,
                endpoint = endpoint,
                accessToken = accessToken,
                random = random,
            )
            if (terminal.get()) return
            tls.soTimeout = 0
            val frameWriter = BoundedRfc6455Writer(
                output = tls.outputStream,
                random = random,
                onFailure = {
                    if (!protocolFailureInProgress.get()) {
                        completeFailure(RelayV2TransportFailureKind.NETWORK)
                    }
                },
                onLocalCloseComplete = ::terminateSilently,
            )
            if (!writer.compareAndSet(null, frameWriter) || terminal.get()) {
                frameWriter.stop()
                return
            }
            frameWriter.start()
            if (!emitOpen(selected)) return

            val reader = BoundedRfc6455FrameReader(tls.inputStream)
            while (!terminal.get()) {
                when (val frame = reader.readNext()) {
                    is RelayV2InboundFrame.Text -> emitFrame(frame.bytes)
                    is RelayV2InboundFrame.Ping -> {
                        if (writer.get()?.enqueuePong(frame.payload) != true) {
                            throw RelayV2WebSocketProtocolException()
                        }
                    }
                    RelayV2InboundFrame.Pong -> Unit
                    is RelayV2InboundFrame.Close -> {
                        writer.get()?.replyToClose(frame.payload, CLOSE_REPLY_TIMEOUT_MS)
                        completeClosed(frame.code)
                        return
                    }
                }
            }
        } catch (failure: RelayV2UpgradeException) {
            completeFailure(RelayV2TransportFailureKind.UPGRADE, failure.httpStatus)
        } catch (_: RelayV2WebSocketProtocolException) {
            completeProtocolFailure()
        } catch (_: RelayV2TlsValidationException) {
            completeFailure(RelayV2TransportFailureKind.TLS_VALIDATION)
        } catch (failure: SSLHandshakeException) {
            val kind = if (failure.isCertificateValidationFailure()) {
                RelayV2TransportFailureKind.TLS_VALIDATION
            } else {
                RelayV2TransportFailureKind.NETWORK
            }
            completeFailure(kind)
        } catch (_: SSLPeerUnverifiedException) {
            completeFailure(RelayV2TransportFailureKind.TLS_VALIDATION)
        } catch (_: SocketTimeoutException) {
            completeFailure(RelayV2TransportFailureKind.NETWORK)
        } catch (_: IOException) {
            completeFailure(RelayV2TransportFailureKind.NETWORK)
        } catch (_: RuntimeException) {
            completeFailure(RelayV2TransportFailureKind.NETWORK)
        } finally {
            raw?.closeQuietly()
        }
    }

    private fun resolveAddress(): InetAddress? {
        val pending = addressResolver.resolve(endpoint.host)
        if (!registerResolution(pending)) return null
        return try {
            pending.await(resolveTimeoutMs).firstOrNull()
                ?: throw IOException("Relay v2 address resolution returned no address")
        } finally {
            resolution.compareAndSet(pending, null)
        }
    }

    private fun registerResolution(candidate: RelayV2AddressResolution): Boolean {
        if (terminal.get() || !resolution.compareAndSet(null, candidate)) {
            candidate.cancel()
            return false
        }
        if (terminal.get()) {
            resolution.compareAndSet(candidate, null)
            candidate.cancel()
            return false
        }
        return true
    }

    private fun registerSocket(candidate: Socket): Boolean {
        if (terminal.get()) {
            candidate.closeQuietly()
            return false
        }
        val previous = socket.getAndSet(candidate)
        if (terminal.get()) {
            socket.compareAndSet(candidate, null)
            candidate.closeQuietly()
            previous?.closeQuietly()
            return false
        }
        if (previous !== candidate) previous?.closeQuietly()
        return true
    }

    private fun replaceSocket(previous: Socket, candidate: Socket): Boolean {
        if (!socket.compareAndSet(previous, candidate) || terminal.get()) {
            socket.compareAndSet(candidate, null)
            candidate.closeQuietly()
            return false
        }
        return true
    }

    private fun completeFailure(kind: RelayV2TransportFailureKind, status: Int? = null) {
        if (!beginTerminal()) return
        closeResources()
        synchronized(callbackLock) {
            listener.onFailure(this, RelayV2TransportFailure(kind, status))
        }
    }

    private fun completeProtocolFailure() {
        protocolFailureInProgress.set(true)
        writer.get()?.sendProtocolClose(PROTOCOL_CLOSE_TIMEOUT_MS)
        completeFailure(RelayV2TransportFailureKind.PROTOCOL)
    }

    private fun completeClosed(code: Int) {
        if (!beginTerminal()) return
        closeResources()
        synchronized(callbackLock) {
            listener.onClosed(this, code)
        }
    }

    private fun terminateSilently() {
        if (!beginTerminal()) return
        closeResources()
    }

    private fun emitOpen(selectedSubprotocol: String): Boolean = synchronized(callbackLock) {
        if (terminal.get()) return@synchronized false
        opened.set(true)
        listener.onOpen(this, selectedSubprotocol)
        true
    }

    private fun emitFrame(bytes: ByteArray) {
        synchronized(callbackLock) {
            if (terminal.get()) return
            listener.onFrame(
                this,
                bytes.copyOf(),
                RelayV2FrameMetadata(opcode = "text", compressed = false),
            )
        }
    }

    private fun beginTerminal(): Boolean = synchronized(callbackLock) {
        terminal.compareAndSet(false, true)
    }

    private fun closeResources() {
        opened.set(false)
        resolution.getAndSet(null)?.cancel()
        writer.getAndSet(null)?.stop()
        socket.getAndSet(null)?.closeQuietly()
        connectionThread.get()?.takeUnless { it === Thread.currentThread() }?.interrupt()
    }

    private fun Socket.closeQuietly() {
        runCatching { close() }
    }

    private companion object {
        const val CLOSE_REPLY_TIMEOUT_MS = 1_000L
        const val PROTOCOL_CLOSE_TIMEOUT_MS = 1_000L
    }
}

private class RelayV2TlsValidationException : IOException("Relay v2 TLS validation failed")

private fun SSLHandshakeException.isCertificateValidationFailure(): Boolean {
    var current: Throwable? = this
    while (current != null) {
        if (current is CertificateException || current is CertPathValidatorException) return true
        val next = current.cause
        if (next === current) return false
        current = next
    }
    return false
}
