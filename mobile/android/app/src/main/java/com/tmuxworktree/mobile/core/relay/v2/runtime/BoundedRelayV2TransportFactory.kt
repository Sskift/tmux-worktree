package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2FrameMetadata
import com.tmuxworktree.mobile.core.session.MobileSessionTransport
import com.tmuxworktree.mobile.core.session.MobileSessionTransportAdapter
import com.tmuxworktree.mobile.core.session.MobileSessionTransportListener
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.CertPathValidatorException
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import kotlin.concurrent.thread
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Unwired, bounded RFC6455 transport foundation for the existing Relay v2 actor seam.
 *
 * This adapter owns only one bounded/cancellable address resolution, one bounded raw-address
 * connect attempt, one TLS socket, one HTTP/1.1 Upgrade, RFC6455 framing, and its bounded write
 * queues. It retries only raw address candidates before TLS; it never retries TLS or Upgrade,
 * redirects, authenticates a challenge, reconnects, decodes Relay JSON, or owns an actor
 * generation/phase.
 */
internal class RelayV2WebSocketTransportAdapter(
    private val sslSocketFactory: SSLSocketFactory = systemTrustSocketFactory(),
    private val additionalHostnameVerifier: HostnameVerifier? = null,
    private val addressResolver: RelayV2AddressResolver = RelayV2SystemAddressResolver,
    private val rawSocketFactory: () -> Socket = ::Socket,
    private val randomFactory: () -> SecureRandom = ::SecureRandom,
    private val resolveTimeoutMs: Int = DEFAULT_RESOLVE_TIMEOUT_MS,
    private val connectTimeoutMs: Int = DEFAULT_CONNECT_TIMEOUT_MS,
    private val handshakeTimeoutMs: Int = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    private val inboundSilenceTimeoutMs: Int = DEFAULT_INBOUND_SILENCE_TIMEOUT_MS,
) : MobileSessionTransportAdapter<RelayV2TransportOpenRequest> {
    init {
        require(resolveTimeoutMs > 0)
        require(connectTimeoutMs > 0)
        require(handshakeTimeoutMs > 0)
        require(inboundSilenceTimeoutMs > 0)
    }

    override fun open(
        route: RelayV2TransportOpenRequest,
        listener: MobileSessionTransportListener,
    ): MobileSessionTransport {
        val endpoint = RelayV2WebSocketEndpoint.parse(route.relayUrl)
        return BoundedRelayV2Transport(
            endpoint = endpoint,
            accessToken = route.accessToken,
            listener = listener,
            sslSocketFactory = sslSocketFactory,
            additionalHostnameVerifier = additionalHostnameVerifier,
            addressResolver = addressResolver,
            rawSocketFactory = rawSocketFactory,
            random = randomFactory(),
            resolveTimeoutMs = resolveTimeoutMs,
            connectTimeoutMs = connectTimeoutMs,
            handshakeTimeoutMs = handshakeTimeoutMs,
            inboundSilenceTimeoutMs = inboundSilenceTimeoutMs,
        ).also(BoundedRelayV2Transport::start)
    }

    private companion object {
        const val DEFAULT_RESOLVE_TIMEOUT_MS = 10_000
        const val DEFAULT_CONNECT_TIMEOUT_MS = 10_000
        const val DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000
        // Broker sends a ping every 15s. Four quiet intervals detect a half-open mobile path while
        // tolerating short radio/app scheduling stalls.
        const val DEFAULT_INBOUND_SILENCE_TIMEOUT_MS = 60_000

        fun systemTrustSocketFactory(): SSLSocketFactory =
            SSLContext.getInstance("TLS").apply { init(null, null, null) }.socketFactory
    }
}

/** Temporary source-compatible name for tests and downstream Relay-only wiring. */
internal typealias BoundedRelayV2TransportFactory = RelayV2WebSocketTransportAdapter

private class BoundedRelayV2Transport(
    private val endpoint: RelayV2WebSocketEndpoint,
    private val accessToken: String,
    private val listener: MobileSessionTransportListener,
    private val sslSocketFactory: SSLSocketFactory,
    private val additionalHostnameVerifier: HostnameVerifier?,
    private val addressResolver: RelayV2AddressResolver,
    private val rawSocketFactory: () -> Socket,
    private val random: SecureRandom,
    private val resolveTimeoutMs: Int,
    private val connectTimeoutMs: Int,
    private val handshakeTimeoutMs: Int,
    private val inboundSilenceTimeoutMs: Int,
) : MobileSessionTransport {
    private val callbackLock = Any()
    private val terminal = AtomicBoolean(false)
    private val protocolFailureInProgress = AtomicBoolean(false)
    private val resolution = AtomicReference<RelayV2AddressResolution?>()
    private val wireSocket = AtomicReference<Socket?>()
    private val socket = AtomicReference<Socket?>()
    private val writer = AtomicReference<BoundedRfc6455Writer?>()
    private val connectionThread = AtomicReference<Thread?>()
    private val closeDeadline = AtomicReference<RelayV2CloseDeadline?>()
    private val opened = AtomicBoolean(false)
    private val resourcesFenced = AtomicBoolean(false)
    private val readerStopped = AtomicBoolean(false)
    private val writerStarted = AtomicBoolean(false)
    private val writerStopped = AtomicBoolean(false)
    private val deadlineTasks = AtomicInteger()
    private val termination = CompletableDeferred<Unit>()

    fun start() {
        connectionThread.set(
            thread(name = "tw-relay-v2-ws-reader", isDaemon = true) {
                try {
                    connectAndRead()
                } finally {
                    readerStopped.set(true)
                    completeTerminationIfFenced()
                }
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
            return
        }

        deadlineTasks.incrementAndGet()
        val deadline = RelayV2CloseDeadlineScheduler.schedule(
            action = ::terminateSilently,
            onFinished = {
                deadlineTasks.decrementAndGet()
                completeTerminationIfFenced()
            },
        )
            ?: run {
                deadlineTasks.decrementAndGet()
                terminateSilently()
                return
            }
        if (!closeDeadline.compareAndSet(null, deadline)) {
            deadline.cancel()
            return
        }
        if (terminal.get()) {
            closeDeadline.compareAndSet(deadline, null)
            deadline.cancel()
            return
        }
        if (!currentWriter.close(code, reason)) terminateSilently()
    }

    override fun cancel() {
        terminateSilently()
    }

    override suspend fun awaitTermination(): Boolean =
        withTimeoutOrNull(TERMINATION_FENCE_TIMEOUT_MS) {
            termination.await()
            true
        } ?: false

    override fun toString(): String = "BoundedRelayV2Transport(<redacted>)"

    private fun connectAndRead() {
        var raw: Socket? = null
        try {
            val addresses = resolveAddresses() ?: return
            if (terminal.get()) return
            raw = connectRaw(addresses) ?: return
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
            val session = tls.session
            if (!RelayV2StrictHostnameVerifier.verify(endpoint.host, session) ||
                additionalHostnameVerifier?.let { verifier ->
                    runCatching { verifier.verify(endpoint.host, session) }.getOrDefault(false)
                } == false
            ) {
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
            // A server-side heartbeat cannot always deliver its close through a suspended or
            // migrated phone network. Bound inbound silence locally so the Session reconnect
            // owner sees a failed path instead of retaining a zombie socket indefinitely.
            tls.soTimeout = inboundSilenceTimeoutMs
            val frameWriter = BoundedRfc6455Writer(
                output = tls.outputStream,
                random = random,
                onFailure = {
                    if (!protocolFailureInProgress.get()) {
                        completeFailure(RelayV2TransportFailureKind.NETWORK)
                    }
                },
                onLocalCloseComplete = ::terminateSilently,
                onStopped = {
                    writerStopped.set(true)
                    completeTerminationIfFenced()
                },
            )
            writerStarted.set(true)
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

    private fun resolveAddresses(): List<InetAddress>? {
        val pending = addressResolver.resolve(endpoint.host)
        if (!registerResolution(pending)) return null
        return try {
            pending.await(resolveTimeoutMs)
                .asSequence()
                .distinct()
                .take(MAX_RESOLVED_ADDRESSES)
                .toList()
                .ifEmpty { throw IOException("Relay v2 address resolution returned no address") }
        } finally {
            resolution.compareAndSet(pending, null)
        }
    }

    /**
     * Tries only raw TCP candidates for the same exact WSS hostname. All candidates share one
     * connect deadline, and TLS continues to use [endpoint.host] as the identity authority.
     */
    private fun connectRaw(addresses: List<InetAddress>): Socket? {
        val deadlineNanos = System.nanoTime() +
            TimeUnit.MILLISECONDS.toNanos(connectTimeoutMs.toLong())
        addresses.forEachIndexed { index, address ->
            if (terminal.get()) return null
            val remainingNanos = deadlineNanos - System.nanoTime()
            if (remainingNanos <= 0L) throw SocketTimeoutException()
            val remainingCandidates = addresses.size - index
            val candidateTimeoutMs = TimeUnit.NANOSECONDS.toMillis(
                remainingNanos / remainingCandidates,
            ).coerceIn(1L, Int.MAX_VALUE.toLong()).toInt()
            val candidate = rawSocketFactory()
            if (!registerSocket(candidate)) return null
            try {
                // Ask the kernel to probe a quiet socket as a second line of defense around
                // display-off network policy. Broker WebSocket pings remain the primary liveness
                // signal; SO_KEEPALIVE helps surface a dead radio path instead of leaving it stale.
                candidate.keepAlive = true
                candidate.connect(
                    InetSocketAddress(address, endpoint.port),
                    candidateTimeoutMs,
                )
                return candidate
            } catch (_: IOException) {
                unregisterSocket(candidate)
                if (terminal.get()) return null
            }
        }
        throw IOException("Relay v2 address candidates are unreachable")
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
        if (!wireSocket.compareAndSet(null, candidate)) {
            candidate.closeQuietly()
            return false
        }
        val previous = socket.getAndSet(candidate)
        if (terminal.get()) {
            socket.compareAndSet(candidate, null)
            wireSocket.compareAndSet(candidate, null)
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

    private fun unregisterSocket(candidate: Socket) {
        socket.compareAndSet(candidate, null)
        wireSocket.compareAndSet(candidate, null)
        candidate.closeQuietly()
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
        closeDeadline.getAndSet(null)?.cancel()
        resolution.getAndSet(null)?.cancel()
        // Close the connected raw socket before touching the TLS wrapper: some providers serialize
        // SSLSocket.close() behind an in-flight write/flush. The raw close interrupts kernel I/O.
        wireSocket.getAndSet(null)?.closeQuietly()
        writer.getAndSet(null)?.stop()
        socket.getAndSet(null)?.closeQuietly()
        connectionThread.get()?.takeUnless { it === Thread.currentThread() }?.interrupt()
        resourcesFenced.set(true)
        completeTerminationIfFenced()
    }

    private fun completeTerminationIfFenced() {
        if (terminal.get() && resourcesFenced.get() && readerStopped.get() &&
            (!writerStarted.get() || writerStopped.get()) && deadlineTasks.get() == 0
        ) {
            termination.complete(Unit)
        }
    }

    private fun Socket.closeQuietly() {
        runCatching { close() }
    }

    private companion object {
        const val MAX_RESOLVED_ADDRESSES = 16
        const val CLOSE_REPLY_TIMEOUT_MS = 1_000L
        const val PROTOCOL_CLOSE_TIMEOUT_MS = 1_000L
        const val TERMINATION_FENCE_TIMEOUT_MS = 2_000L
    }
}

private interface RelayV2CloseDeadline {
    fun cancel()
}

/** One process-wide daemon and a hard admission cap; saturation fails closed immediately. */
private object RelayV2CloseDeadlineScheduler {
    private const val CLOSE_DEADLINE_MS = 1_000L
    private const val MAX_PENDING_DEADLINES = 64

    private val threadSequence = AtomicInteger()
    private val permits = Semaphore(MAX_PENDING_DEADLINES)
    private val executor = ScheduledThreadPoolExecutor(
        1,
        { runnable ->
            Thread(
                runnable,
                "tw-relay-v2-close-deadline-${threadSequence.incrementAndGet()}",
            ).apply { isDaemon = true }
        },
        java.util.concurrent.ThreadPoolExecutor.AbortPolicy(),
    ).apply {
        removeOnCancelPolicy = true
        setExecuteExistingDelayedTasksAfterShutdownPolicy(false)
    }

    fun schedule(action: () -> Unit, onFinished: () -> Unit): RelayV2CloseDeadline? {
        if (!permits.tryAcquire()) return null
        val ticket = Ticket(action, onFinished)
        return try {
            ticket.future = executor.schedule(ticket::run, CLOSE_DEADLINE_MS, TimeUnit.MILLISECONDS)
            ticket
        } catch (_: RejectedExecutionException) {
            permits.release()
            null
        }
    }

    private class Ticket(
        private val action: () -> Unit,
        private val onFinished: () -> Unit,
    ) : RelayV2CloseDeadline {
        private val finished = AtomicBoolean(false)
        lateinit var future: ScheduledFuture<*>

        fun run() {
            try {
                action()
            } finally {
                finish()
            }
        }

        override fun cancel() {
            if (future.cancel(false)) finish()
        }

        fun finish() {
            if (finished.compareAndSet(false, true)) {
                permits.release()
                onFinished()
            }
        }
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
