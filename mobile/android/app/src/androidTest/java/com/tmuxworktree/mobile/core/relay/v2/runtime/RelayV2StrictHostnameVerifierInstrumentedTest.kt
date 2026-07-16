package com.tmuxworktree.mobile.core.relay.v2.runtime

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2FrameMetadata
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import java.io.Closeable
import java.io.IOException
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RelayV2StrictHostnameVerifierInstrumentedTest {
    @Test
    fun permissiveProcessDefaultCannotAdmitWrongHostname() {
        val original = HttpsURLConnection.getDefaultHostnameVerifier()
        try {
            HttpsURLConnection.setDefaultHostnameVerifier { _, _ -> true }
            WrongHostnameTlsServer().use { server ->
                server.start()
                val listener = FailureListener()
                val transport = BoundedRelayV2TransportFactory(
                    sslSocketFactory = server.clientSocketFactory,
                    addressResolver = RelayV2AddressResolver {
                        ImmediateResolution(InetAddress.getLoopbackAddress())
                    },
                    connectTimeoutMs = 2_000,
                    handshakeTimeoutMs = 2_000,
                ).open(
                    RelayV2TransportOpenRequest(
                        relayUrl = server.url(),
                        offeredSubprotocols = listOf(RelayV2Profile.RELAY_V2_SUBPROTOCOL),
                        accessToken = "twcap2.instrumented-test",
                    ),
                    listener,
                )

                assertTrue(listener.terminal.await(5, TimeUnit.SECONDS))
                assertEquals(RelayV2TransportFailureKind.TLS_VALIDATION, listener.failure.get()?.kind)
                assertTrue(server.handshakeCompleted.await(5, TimeUnit.SECONDS))
                transport.cancel()
            }
        } finally {
            HttpsURLConnection.setDefaultHostnameVerifier(original)
        }
    }
}

private class ImmediateResolution(
    private val address: InetAddress,
) : RelayV2AddressResolution {
    override fun await(timeoutMs: Int): List<InetAddress> = listOf(address)

    override fun cancel() = Unit
}

private class FailureListener : RelayV2TransportListener {
    val terminal = CountDownLatch(1)
    val failure = AtomicReference<RelayV2TransportFailure?>()

    override fun onOpen(source: RelayV2Transport, selectedSubprotocol: String?) = Unit

    override fun onFrame(
        source: RelayV2Transport,
        bytes: ByteArray,
        metadata: RelayV2FrameMetadata,
    ) = Unit

    override fun onClosed(source: RelayV2Transport, code: Int) = Unit

    override fun onFailure(source: RelayV2Transport, failure: RelayV2TransportFailure) {
        this.failure.set(failure)
        terminal.countDown()
    }
}

private class WrongHostnameTlsServer : Closeable {
    private val certificate = HeldCertificate.Builder()
        .commonName("wrong-host.invalid")
        .addSubjectAlternativeName("wrong-host.invalid")
        .build()
    private val serverCertificates = HandshakeCertificates.Builder()
        .heldCertificate(certificate)
        .build()
    private val clientCertificates = HandshakeCertificates.Builder()
        .addTrustedCertificate(certificate.certificate)
        .build()
    private val serverSocket = serverCertificates.sslContext().serverSocketFactory
        .createServerSocket(0, 1, InetAddress.getLoopbackAddress()) as SSLServerSocket
    private val accepted = AtomicReference<SSLSocket?>()
    private val worker = AtomicReference<Thread?>()

    val clientSocketFactory = clientCertificates.sslSocketFactory()
    val handshakeCompleted = CountDownLatch(1)

    fun url(): String = "wss://localhost:${serverSocket.localPort}/client"

    fun start() {
        serverSocket.soTimeout = 5_000
        worker.set(
            kotlin.concurrent.thread(name = "relay-v2-android-hostname-test", isDaemon = true) {
                try {
                    val socket = serverSocket.accept() as SSLSocket
                    accepted.set(socket)
                    socket.soTimeout = 5_000
                    socket.startHandshake()
                    handshakeCompleted.countDown()
                    socket.inputStream.read()
                } catch (_: SocketTimeoutException) {
                    // A failed assertion will still release resources in close().
                } catch (_: IOException) {
                    // Expected when the post-handshake strict verifier rejects the peer.
                }
            },
        )
    }

    override fun close() {
        runCatching { accepted.getAndSet(null)?.close() }
        runCatching { serverSocket.close() }
        worker.get()?.join(2_000)
    }
}
