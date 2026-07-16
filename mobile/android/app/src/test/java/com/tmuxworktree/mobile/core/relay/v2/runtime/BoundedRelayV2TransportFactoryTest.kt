package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2FrameMetadata
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialBlob
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialCasExpectation
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialCasResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialReference
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialStore
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.Socket
import java.net.SocketAddress
import java.net.SocketException
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class BoundedRelayV2TransportFactoryTest {
    @Test
    fun exactOneMiBTextUsesExactUpgradeAndClosesOnce() {
        RawTlsWebSocketServer().use { server ->
            val closeReply = AtomicReference<ObservedClientFrame?>()
            server.start { socket ->
                val request = server.readRequest(socket)
                server.writeValidUpgrade(socket, request)
                writeServerFrame(
                    socket.outputStream,
                    final = true,
                    opcode = OPCODE_TEXT,
                    payload = ByteArray(MAX_MESSAGE_BYTES) { 'a'.code.toByte() },
                )
                writeServerFrame(
                    socket.outputStream,
                    final = true,
                    opcode = OPCODE_CLOSE,
                    payload = byteArrayOf(0x03, 0xe8.toByte()),
                )
                socket.outputStream.flush()
                closeReply.set(readClientFrame(socket.inputStream))
            }

            val listener = RecordingListener()
            val request = openRequest(server.url(), TOKEN)
            val transport = server.factory().open(request, listener)

            assertTrue(listener.terminal.await(5, TimeUnit.SECONDS))
            assertEquals(listOf("open", "frame", "closed:1000"), listener.events)
            assertEquals(1, listener.frames.size)
            assertEquals(MAX_MESSAGE_BYTES, listener.frames.single().size)
            assertTrue(listener.frames.single().all { it == 'a'.code.toByte() })
            assertEquals(1, listener.terminalCount.get())
            assertSameTransportForEveryCallback(transport, listener)

            assertTrue(server.awaitRequestCount(1))
            val wireRequest = server.requests.single()
            assertTrue(wireRequest.startsWith("GET /client HTTP/1.1\r\n"))
            assertTrue(wireRequest.contains("Authorization: Bearer $TOKEN\r\n"))
            assertTrue(
                wireRequest.contains(
                    "Sec-WebSocket-Protocol: ${RelayV2Profile.RELAY_V2_SUBPROTOCOL}\r\n",
                ),
            )
            assertFalse(wireRequest.contains("Sec-WebSocket-Extensions", ignoreCase = true))
            assertFalse(wireRequest.substringBefore(" HTTP/1.1").contains(TOKEN))
            assertEquals(OPCODE_CLOSE, closeReply.get()?.opcode)
            assertTrue(closeReply.get()?.masked == true)
            assertFalse(request.toString().contains(TOKEN))
            assertFalse(request.toString().contains(server.url()))
            assertFalse(transport.toString().contains(TOKEN))
        }
    }

    @Test
    fun oversizeSingleAndCumulativeFragmentFailFromHeaderWithoutBody() {
        val singleHeader = serverFrameHeader(
            final = true,
            opcode = OPCODE_TEXT,
            length = MAX_MESSAGE_BYTES.toLong() + 1,
        )
        val singleInput = CountingInputStream(singleHeader)
        assertProtocolFailure { BoundedRfc6455FrameReader(singleInput).readNext() }
        assertEquals(singleHeader.size, singleInput.consumed)

        val prefix = serverFrameHeader(false, OPCODE_TEXT, 10) + ByteArray(10) { 'x'.code.toByte() }
        val overflowHeader = serverFrameHeader(true, OPCODE_CONTINUATION, MAX_MESSAGE_BYTES.toLong())
        val fragmentedInput = CountingInputStream(prefix + overflowHeader)
        assertProtocolFailure { BoundedRfc6455FrameReader(fragmentedInput).readNext() }
        assertEquals(prefix.size + overflowHeader.size, fragmentedInput.consumed)

        RawTlsWebSocketServer().use { server ->
            val headerSent = CountDownLatch(1)
            server.start { socket ->
                val request = server.readRequest(socket)
                server.writeValidUpgrade(socket, request)
                socket.outputStream.write(singleHeader)
                socket.outputStream.flush()
                headerSent.countDown()
                socket.inputStream.read()
            }
            val listener = RecordingListener()
            val transport = server.factory().open(openRequest(server.url()), listener)
            assertTrue(headerSent.await(3, TimeUnit.SECONDS))
            assertTrue("client waited for an absent oversize body", listener.terminal.await(3, TimeUnit.SECONDS))
            assertEquals(RelayV2TransportFailureKind.PROTOCOL, listener.failure?.kind)
            assertNull(listener.failure?.httpStatus)
            assertEquals(1, listener.terminalCount.get())
            assertSameTransportForEveryCallback(transport, listener)
        }
    }

    @Test
    fun fragmentedExactLimitAllowsPingAndPongInterleave() {
        RawTlsWebSocketServer().use { server ->
            val observedPong = AtomicReference<ObservedClientFrame?>()
            server.start { socket ->
                val request = server.readRequest(socket)
                server.writeValidUpgrade(socket, request)
                writeServerFrame(
                    socket.outputStream,
                    final = false,
                    opcode = OPCODE_TEXT,
                    payload = ByteArray(MAX_MESSAGE_BYTES / 2) { 'a'.code.toByte() },
                )
                writeServerFrame(socket.outputStream, true, OPCODE_PING, "hi".toByteArray())
                socket.outputStream.flush()
                observedPong.set(readClientFrame(socket.inputStream))
                writeServerFrame(socket.outputStream, true, OPCODE_PONG, "ok".toByteArray())
                writeServerFrame(
                    socket.outputStream,
                    final = true,
                    opcode = OPCODE_CONTINUATION,
                    payload = ByteArray(MAX_MESSAGE_BYTES / 2) { 'b'.code.toByte() },
                )
                writeServerFrame(
                    socket.outputStream,
                    true,
                    OPCODE_CLOSE,
                    byteArrayOf(0x03, 0xe8.toByte()),
                )
                socket.outputStream.flush()
                readClientFrame(socket.inputStream)
            }

            val listener = RecordingListener()
            val transport = server.factory().open(openRequest(server.url()), listener)
            assertTrue(listener.terminal.await(5, TimeUnit.SECONDS))
            assertEquals(MAX_MESSAGE_BYTES, listener.frames.single().size)
            assertEquals('a'.code.toByte(), listener.frames.single().first())
            assertEquals('b'.code.toByte(), listener.frames.single().last())
            assertEquals(OPCODE_PONG, observedPong.get()?.opcode)
            assertArrayEquals("hi".toByteArray(), observedPong.get()?.payload)
            assertTrue(observedPong.get()?.masked == true)
            assertEquals(listOf("open", "frame", "closed:1000"), listener.events)
            assertSameTransportForEveryCallback(transport, listener)
        }

        val closeDuringFragment = serverFrameHeader(false, OPCODE_TEXT, 0) +
            serverFrameHeader(true, OPCODE_CLOSE, 2) + byteArrayOf(0x03, 0xe8.toByte())
        val close = BoundedRfc6455FrameReader(ByteArrayInputStream(closeDuringFragment)).readNext()
        assertTrue(close is RelayV2InboundFrame.Close)
        close as RelayV2InboundFrame.Close
        assertEquals(1000, close.code)
        assertArrayEquals(byteArrayOf(0x03, 0xe8.toByte()), close.payload)
    }

    @Test
    fun responseExtensionAndRsvBitsFailBeforeCompressedPayload() {
        RawTlsWebSocketServer().use { server ->
            server.start { socket ->
                val request = server.readRequest(socket)
                server.writeValidUpgrade(
                    socket,
                    request,
                    additionalHeaders = listOf("Sec-WebSocket-Extensions: permessage-deflate"),
                )
            }
            val listener = RecordingListener()
            val transport = server.factory().open(openRequest(server.url()), listener)
            assertTrue(listener.terminal.await(3, TimeUnit.SECONDS))
            assertNull(listener.openedSubprotocol)
            assertEquals(RelayV2TransportFailureKind.PROTOCOL, listener.failure?.kind)
            assertNull(listener.failure?.httpStatus)
            assertSameTransportForEveryCallback(transport, listener)
            assertFalse(server.requests.single().contains("Sec-WebSocket-Extensions", true))
        }

        listOf(0x40, 0x20, 0x10, 0x70).forEach { rsv ->
            val bytes = byteArrayOf((0x80 or rsv or OPCODE_TEXT).toByte(), 1, 'z'.code.toByte())
            val input = CountingInputStream(bytes)
            assertProtocolFailure { BoundedRfc6455FrameReader(input).readNext() }
            assertEquals("RSV ${rsv.toString(16)} consumed payload", 1, input.consumed)
        }
    }

    @Test
    fun invalidFrameHeadersAreRejectedAtTheirDecisiveHeaderByte() {
        val cases = listOf(
            HeaderFailureCase("binary", byteArrayOf(0x82.toByte()), 1),
            HeaderFailureCase("reserved opcode", byteArrayOf(0x83.toByte()), 1),
            HeaderFailureCase("continuation without fragment", byteArrayOf(0x80.toByte()), 1),
            HeaderFailureCase("fragmented control", byteArrayOf(0x09), 1),
            HeaderFailureCase("masked server", byteArrayOf(0x81.toByte(), 0x80.toByte()), 2),
            HeaderFailureCase("oversize control", byteArrayOf(0x89.toByte(), 126), 2),
            HeaderFailureCase(
                "noncanonical 126",
                byteArrayOf(0x81.toByte(), 126, 0, 125),
                4,
            ),
            HeaderFailureCase(
                "noncanonical 127",
                byteArrayOf(0x81.toByte(), 127, 0, 0, 0, 0, 0, 0, 0, 125),
                10,
            ),
            HeaderFailureCase(
                "64-bit high bit",
                byteArrayOf(0x81.toByte(), 127, 0x80.toByte()),
                3,
            ),
        )
        cases.forEach { case ->
            val input = CountingInputStream(case.bytes)
            assertProtocolFailure(case.name) { BoundedRfc6455FrameReader(input).readNext() }
            assertEquals(case.name, case.consumed, input.consumed)
        }

        val secondText = serverFrameHeader(false, OPCODE_TEXT, 0) + byteArrayOf(0x81.toByte())
        val input = CountingInputStream(secondText)
        assertProtocolFailure("new data frame during fragmentation") {
            BoundedRfc6455FrameReader(input).readNext()
        }
        assertEquals(secondText.size, input.consumed)

        val malformedUtf8 = serverFrameHeader(true, OPCODE_TEXT, 2) +
            byteArrayOf(0xc3.toByte(), 0x28)
        assertProtocolFailure("malformed UTF-8") {
            BoundedRfc6455FrameReader(ByteArrayInputStream(malformedUtf8)).readNext()
        }
    }

    @Test
    fun redirectChallengeAndServiceStatusesPerformOneUpgradeOnly() {
        val statuses = listOf(301, 401, 407, 426, 503)
        statuses.forEach { status ->
            RawTlsWebSocketServer().use { server ->
                server.start { socket ->
                    server.readRequest(socket)
                    val extra = when (status) {
                        301 -> "Location: wss://elsewhere.invalid/client\r\n"
                        401 -> "WWW-Authenticate: Basic realm=relay\r\n"
                        407 -> "Proxy-Authenticate: Basic realm=proxy\r\n"
                        503 -> "Retry-After: 0\r\n"
                        else -> ""
                    }
                    socket.outputStream.writeAscii(
                        "HTTP/1.1 $status Test\r\n${extra}Content-Length: 0\r\n\r\n",
                    )
                    socket.outputStream.flush()
                }
                val listener = RecordingListener()
                val transport = server.factory().open(openRequest(server.url()), listener)
                assertTrue("status $status", listener.terminal.await(3, TimeUnit.SECONDS))
                assertEquals(status, listener.failure?.httpStatus)
                assertEquals(RelayV2TransportFailureKind.UPGRADE, listener.failure?.kind)
                assertTrue(server.awaitRequestCount(1))
                Thread.sleep(150)
                assertEquals("status $status was followed up", 1, server.acceptedCount.get())
                assertEquals("status $status sent multiple requests", 1, server.requests.size)
                assertEquals(1, listener.terminalCount.get())
                assertSameTransportForEveryCallback(transport, listener)
            }
        }

        RawTlsWebSocketServer().use { server ->
            server.start { socket ->
                server.readRequest(socket)
            }
            val listener = RecordingListener()
            val transport = server.factory().open(openRequest(server.url()), listener)
            assertTrue(listener.terminal.await(3, TimeUnit.SECONDS))
            Thread.sleep(150)
            assertEquals(1, server.acceptedCount.get())
            assertEquals(1, server.requests.size)
            assertEquals(RelayV2TransportFailureKind.NETWORK, listener.failure?.kind)
            assertNull(listener.failure?.httpStatus)
            assertSameTransportForEveryCallback(transport, listener)
        }
    }

    @Test
    fun handshakeStatusAndHeadersAreHardBounded() {
        val oversizedResponses = listOf(
            "status line" to ("HTTP/1.1 101 " + "x".repeat(1_100)),
            "header line" to ("HTTP/1.1 101 OK\r\nX-Test: " + "x".repeat(8_300)),
            "header count" to buildString {
                append("HTTP/1.1 101 OK\r\n")
                repeat(BoundedRfc6455Handshake.MAX_HEADER_COUNT + 1) { append("X-$it: a\r\n") }
            },
            "total bytes" to buildString {
                append("HTTP/1.1 101 OK\r\n")
                repeat(5) { append("X-$it: ${"x".repeat(7_000)}\r\n") }
            },
        )
        oversizedResponses.forEach { (name, prefix) ->
            val response = (prefix + "\r\n\r\n").toByteArray(StandardCharsets.ISO_8859_1)
            try {
                BoundedRfc6455Handshake.perform(
                    ByteArrayInputStream(response),
                    ByteArrayOutputStream(),
                    RelayV2WebSocketEndpoint.parse("wss://localhost/client"),
                    TOKEN,
                    SecureRandom(),
                )
                fail("$name should fail")
            } catch (_: RelayV2WebSocketProtocolException) {
                // Expected at the production handshake reader boundary.
            }
        }
    }

    @Test
    fun trustedHostnameSucceedsButWrongHostnameAndUntrustedChainFailBeforeUpgrade() {
        RawTlsWebSocketServer(certificateHostname = "localhost").use { server ->
            server.start { socket ->
                val request = server.readRequest(socket)
                server.writeValidUpgrade(socket, request)
                socket.inputStream.read()
            }
            val listener = RecordingListener()
            val transport = server.factory().open(openRequest(server.url("localhost")), listener)
            assertTrue(listener.opened.await(3, TimeUnit.SECONDS))
            assertEquals(RelayV2Profile.RELAY_V2_SUBPROTOCOL, listener.openedSubprotocol)
            assertTrue(server.awaitRequestCount(1))
            transport.cancel()
            assertEquals(0, listener.terminalCount.get())
            assertSameTransportForEveryCallback(transport, listener)
        }

        RawTlsWebSocketServer(certificateHostname = "localhost").use { server ->
            server.start { socket -> server.readRequest(socket) }
            val listener = RecordingListener()
            val transport = server.factory().open(openRequest(server.url("127.0.0.1")), listener)
            assertTrue(listener.terminal.await(3, TimeUnit.SECONDS))
            assertEquals(RelayV2TransportFailureKind.TLS_VALIDATION, listener.failure?.kind)
            assertNull(listener.failure?.httpStatus)
            assertEquals(0, server.requests.size)
            assertSameTransportForEveryCallback(transport, listener)
        }

        RawTlsWebSocketServer(certificateHostname = "localhost").use { server ->
            server.start { socket -> server.readRequest(socket) }
            val listener = RecordingListener()
            val transport = BoundedRelayV2TransportFactory().open(
                openRequest(server.url("localhost")),
                listener,
            )
            assertTrue(listener.terminal.await(3, TimeUnit.SECONDS))
            assertEquals(RelayV2TransportFailureKind.TLS_VALIDATION, listener.failure?.kind)
            assertNull(listener.failure?.httpStatus)
            assertEquals(0, server.requests.size)
            assertSameTransportForEveryCallback(transport, listener)
        }
    }

    @Test
    fun selectedSubprotocolMustBePresentAndExactAndDiagnosticsStayRedacted() {
        listOf(null, "tw-relay.v1", "tw-relay.v2, tw-relay.v1").forEach { selected ->
            RawTlsWebSocketServer().use { server ->
                server.start { socket ->
                    val request = server.readRequest(socket)
                    server.writeValidUpgrade(socket, request, selectedSubprotocol = selected)
                }
                val listener = RecordingListener()
                val request = openRequest(server.url(), TOKEN)
                val transport = server.factory().open(request, listener)
                assertTrue("selected=$selected", listener.terminal.await(3, TimeUnit.SECONDS))
                assertNull(listener.openedSubprotocol)
                assertEquals(RelayV2TransportFailureKind.PROTOCOL, listener.failure?.kind)
                assertNull(listener.failure?.httpStatus)
                assertFalse(listener.failure.toString().contains(TOKEN))
                assertFalse(request.toString().contains(TOKEN))
                assertFalse(transport.toString().contains(TOKEN))
                assertFalse(server.requests.single().substringBefore(" HTTP/1.1").contains(TOKEN))
                assertEquals(1, listener.terminalCount.get())
                Thread.sleep(100)
                assertEquals(1, server.acceptedCount.get())
                assertSameTransportForEveryCallback(transport, listener)
            }
        }

        RawTlsWebSocketServer().use { server ->
            server.start { socket ->
                val request = server.readRequest(socket)
                server.writeValidUpgrade(socket, request, acceptOverride = "invalid-accept")
            }
            val listener = RecordingListener()
            val transport = server.factory().open(openRequest(server.url()), listener)
            assertTrue(listener.terminal.await(3, TimeUnit.SECONDS))
            assertEquals(RelayV2TransportFailureKind.PROTOCOL, listener.failure?.kind)
            assertNull(listener.failure?.httpStatus)
            Thread.sleep(100)
            assertEquals(1, server.acceptedCount.get())
            assertEquals(1, server.requests.size)
            assertSameTransportForEveryCallback(transport, listener)
        }
    }

    @Test
    fun endpointAndAuthorizationInputsAreClosedBeforeAnySocketAttempt() {
        val invalidUrls = listOf(
            "ws://localhost/client",
            "https://localhost/client",
            "wss://localhost/",
            "wss://localhost/client/",
            "wss://localhost/client?token=$TOKEN",
            "wss://user:pass@localhost/client",
            "wss://localhost/client#fragment",
        )
        invalidUrls.forEach { url ->
            try {
                BoundedRelayV2TransportFactory().open(openRequest(url), RecordingListener())
                fail("$url should fail")
            } catch (error: IllegalArgumentException) {
                assertFalse(error.message.orEmpty().contains(TOKEN))
                assertFalse(error.toString().contains(TOKEN))
            }
        }

        listOf(
            "twcap2.bad\r\nX-Leak: yes",
            "twcap2.bad token",
            "twcap2." + "x".repeat(8_193),
        ).forEach { token ->
            try {
                openRequest("wss://localhost/client", token)
                fail("unsafe Authorization value should fail")
            } catch (error: IllegalArgumentException) {
                assertFalse(error.message.orEmpty().contains(token))
            }
        }
    }

    @Test
    fun cancelDuringTlsAndPayloadReadIsSilentAndFencesLaterCallbacks() {
        RawTlsWebSocketServer().use { server ->
            val releaseServer = CountDownLatch(1)
            server.start { _ -> releaseServer.await(3, TimeUnit.SECONDS) }
            val listener = RecordingListener()
            val transport = server.factory().open(openRequest(server.url()), listener)
            assertTrue(server.awaitAcceptedCount(1))
            transport.cancel()
            releaseServer.countDown()
            Thread.sleep(100)
            assertTrue(listener.events.isEmpty())
            assertEquals(0, listener.terminalCount.get())
        }

        RawTlsWebSocketServer().use { server ->
            val requestRead = CountDownLatch(1)
            val releaseServer = CountDownLatch(1)
            server.start { socket ->
                server.readRequest(socket)
                requestRead.countDown()
                releaseServer.await(3, TimeUnit.SECONDS)
            }
            val listener = RecordingListener()
            val transport = server.factory().open(openRequest(server.url()), listener)
            assertTrue(requestRead.await(3, TimeUnit.SECONDS))
            transport.cancel()
            releaseServer.countDown()
            Thread.sleep(100)
            assertTrue(listener.events.isEmpty())
            assertEquals(0, listener.terminalCount.get())
        }

        RawTlsWebSocketServer().use { server ->
            val partialBodySent = CountDownLatch(1)
            val releaseServer = CountDownLatch(1)
            server.start { socket ->
                val request = server.readRequest(socket)
                server.writeValidUpgrade(socket, request)
                socket.outputStream.write(serverFrameHeader(true, OPCODE_TEXT, 100))
                socket.outputStream.write('x'.code)
                socket.outputStream.flush()
                partialBodySent.countDown()
                releaseServer.await(3, TimeUnit.SECONDS)
            }
            val listener = RecordingListener()
            val transport = server.factory().open(openRequest(server.url()), listener)
            assertTrue(listener.opened.await(3, TimeUnit.SECONDS))
            assertTrue(partialBodySent.await(3, TimeUnit.SECONDS))
            transport.cancel()
            releaseServer.countDown()
            Thread.sleep(100)
            assertEquals(listOf("open"), listener.events)
            assertEquals(0, listener.terminalCount.get())
            assertSameTransportForEveryCallback(transport, listener)
        }
    }

    @Test
    fun cancelDuringConnectClosesRegisteredProductionTransportSocketWithoutCallback() {
        val blockingSocket = BlockingConnectSocket()
        val listener = RecordingListener()
        val factory = BoundedRelayV2TransportFactory(
            addressResolver = ImmediateAddressResolver(InetAddress.getLoopbackAddress()),
            rawSocketFactory = { blockingSocket },
            connectTimeoutMs = 5_000,
        )
        val transport = factory.open(openRequest("wss://localhost/client"), listener)
        assertTrue(blockingSocket.connectEntered.await(3, TimeUnit.SECONDS))
        val startedAt = System.nanoTime()
        transport.cancel()
        val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt)
        assertTrue("connect cancel took ${elapsedMs}ms", elapsedMs < 500)
        assertTrue(blockingSocket.connectExited.await(3, TimeUnit.SECONDS))
        Thread.sleep(100)
        assertTrue(listener.events.isEmpty())
        assertEquals(0, listener.terminalCount.get())
    }

    @Test
    fun cancelInterruptsProductionTlsSocketWriteBeforeDeclaredPayloadCompletes() = runBlocking {
        assertProductionWriteTeardown("cancel") { transport, socket ->
            val startedAt = System.nanoTime()
            transport.cancel()
            val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt)
            assertTrue("socket write cancel took ${elapsedMs}ms", elapsedMs < 500)
            assertTrue(socket.closed.await(500, TimeUnit.MILLISECONDS))
            assertTrue(transport.awaitTermination())
        }
    }

    @Test
    fun closeDeadlineTerminatesBlockedProductionTlsSocketWriteWithoutLateCallback() = runBlocking {
        assertProductionWriteTeardown("close deadline") { transport, socket ->
            val termination = async { transport.awaitTermination() }
            val startedAt = System.nanoTime()
            transport.close(1000, "client disconnect")
            val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt)
            assertTrue("close call took ${elapsedMs}ms", elapsedMs < 500)
            assertFalse("close skipped its best-effort window", socket.closed.await(250, TimeUnit.MILLISECONDS))
            assertFalse("termination fence completed with an open socket", termination.isCompleted)
            assertTrue("close deadline left the socket open", socket.closed.await(2, TimeUnit.SECONDS))
            assertTrue(termination.await())
        }
    }

    private suspend fun assertProductionWriteTeardown(
        description: String,
        trigger: suspend (RelayV2Transport, CloseObservingSocket) -> Unit,
    ) {
        RawTlsWebSocketServer().use { server ->
            val firstFrameBytes = CountDownLatch(1)
            val releaseDrain = CountDownLatch(1)
            val drainFinished = CountDownLatch(1)
            val receivedFrameBytes = AtomicInteger()
            server.start { socket ->
                socket.receiveBufferSize = 1_024
                val request = server.readRequest(socket)
                server.writeValidUpgrade(socket, request)
                val input = socket.inputStream
                val buffer = ByteArray(512)
                try {
                    val first = input.read(buffer)
                    if (first > 0) {
                        receivedFrameBytes.addAndGet(first)
                        firstFrameBytes.countDown()
                    }
                    releaseDrain.await(3, TimeUnit.SECONDS)
                    while (true) {
                        val count = input.read(buffer)
                        if (count == -1) break
                        if (count > 0) receivedFrameBytes.addAndGet(count)
                    }
                } catch (_: IOException) {
                    // Forced transport teardown may end TLS without a close_notify.
                } finally {
                    drainFinished.countDown()
                }
            }

            val listener = RecordingListener()
            val rawSocket = CloseObservingSocket().apply { sendBufferSize = 1_024 }
            val transport = server.factory(
                rawSocketFactory = { rawSocket },
            ).open(openRequest(server.url()), listener)
            assertTrue(listener.opened.await(3, TimeUnit.SECONDS))
            assertTrue(transport.send(ByteArray(MAX_MESSAGE_BYTES) { 'w'.code.toByte() }))
            assertTrue(firstFrameBytes.await(3, TimeUnit.SECONDS))
            Thread.sleep(100)
            trigger(transport, rawSocket)
            releaseDrain.countDown()
            assertTrue(drainFinished.await(5, TimeUnit.SECONDS))
            assertTrue(receivedFrameBytes.get() > 0)
            assertTrue(
                "entire declared frame reached the peer before $description",
                receivedFrameBytes.get() < CLIENT_ONE_MIB_FRAME_BYTES,
            )
            assertEquals(listOf("open"), listener.events)
            assertEquals(0, listener.terminalCount.get())
            assertSameTransportForEveryCallback(transport, listener)
        }
    }

    @Test
    fun writerMasksSerializesBoundsOutstandingBytesAndPrioritizesControl() {
        val output = GatedOutputStream()
        val failures = AtomicInteger()
        val writer = BoundedRfc6455Writer(
            output,
            SecureRandom(),
            onFailure = { failures.incrementAndGet() },
            onLocalCloseComplete = {},
        )
        writer.start()
        assertTrue(writer.enqueueText("first".toByteArray()))
        assertTrue(output.firstWrite.await(3, TimeUnit.SECONDS))
        assertTrue(writer.enqueueText("second".toByteArray()))
        assertTrue(writer.enqueuePong("ping".toByteArray()))
        output.release.countDown()
        assertTrue(output.awaitFlushCount(3))
        writer.stop()

        val frames = readAllClientFrames(output.bytes())
        assertEquals(listOf(OPCODE_TEXT, OPCODE_PONG, OPCODE_TEXT), frames.map { it.opcode })
        assertEquals(listOf("first", "ping", "second"), frames.map { String(it.payload) })
        assertTrue(frames.all { it.masked })
        assertEquals(0, failures.get())

        val byteBoundOutput = GatedOutputStream()
        val byteBoundWriter = BoundedRfc6455Writer(
            byteBoundOutput,
            SecureRandom(),
            onFailure = {},
            onLocalCloseComplete = {},
        )
        byteBoundWriter.start()
        assertTrue(byteBoundWriter.enqueueText(ByteArray(MAX_MESSAGE_BYTES)))
        assertTrue(byteBoundOutput.firstWrite.await(3, TimeUnit.SECONDS))
        assertEquals(MAX_MESSAGE_BYTES.toLong(), byteBoundWriter.reservedMessageBytesForTest())
        assertFalse(byteBoundWriter.enqueueText(byteArrayOf(1)))
        assertFalse(byteBoundWriter.enqueueText(ByteArray(MAX_MESSAGE_BYTES + 1)))
        assertFalse(byteBoundWriter.enqueueText(byteArrayOf(0xc3.toByte(), 0x28)))
        byteBoundWriter.stop()
        assertTrue(byteBoundOutput.interrupted.await(3, TimeUnit.SECONDS))

        val countBoundOutput = GatedOutputStream()
        val countBoundWriter = BoundedRfc6455Writer(
            countBoundOutput,
            SecureRandom(),
            onFailure = {},
            onLocalCloseComplete = {},
        )
        countBoundWriter.start()
        repeat(BoundedRfc6455Writer.MAX_QUEUED_MESSAGE_COUNT) {
            assertTrue(countBoundWriter.enqueueText(ByteArray(0)))
        }
        assertTrue(countBoundOutput.firstWrite.await(3, TimeUnit.SECONDS))
        assertFalse(countBoundWriter.enqueueText(ByteArray(0)))
        countBoundWriter.stop()

        val controlBoundOutput = GatedOutputStream()
        val controlBoundWriter = BoundedRfc6455Writer(
            controlBoundOutput,
            SecureRandom(),
            onFailure = {},
            onLocalCloseComplete = {},
        )
        controlBoundWriter.start()
        assertTrue(controlBoundWriter.enqueueText("blocked".toByteArray()))
        assertTrue(controlBoundOutput.firstWrite.await(3, TimeUnit.SECONDS))
        repeat(BoundedRfc6455Writer.MAX_QUEUED_CONTROL_COUNT) {
            assertTrue(controlBoundWriter.enqueuePong(ByteArray(125)))
        }
        assertFalse(controlBoundWriter.enqueuePong(byteArrayOf(1)))
        controlBoundWriter.stop()

        val protocolCloseOutput = GatedOutputStream()
        val protocolCloseWriter = BoundedRfc6455Writer(
            protocolCloseOutput,
            SecureRandom(),
            onFailure = {},
            onLocalCloseComplete = {},
        )
        protocolCloseWriter.start()
        assertTrue(protocolCloseWriter.enqueueText("in-flight".toByteArray()))
        assertTrue(protocolCloseOutput.firstWrite.await(3, TimeUnit.SECONDS))
        val closeStartedAt = System.nanoTime()
        assertFalse(protocolCloseWriter.sendProtocolClose(timeoutMs = 100))
        val closeElapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - closeStartedAt)
        assertTrue("protocol close took ${closeElapsedMs}ms", closeElapsedMs < 500)
        protocolCloseWriter.stop()
        assertTrue(protocolCloseOutput.interrupted.await(3, TimeUnit.SECONDS))
    }

    @Test
    fun productionProtocolViolationReachesActorAsNonRetryableInvalidEnvelopeAndSendsClose() =
        runBlocking {
            RawTlsWebSocketServer().use { server ->
                val observedClose = AtomicReference<ObservedClientFrame?>()
                server.start { socket ->
                    val request = server.readRequest(socket)
                    server.writeValidUpgrade(socket, request)
                    socket.outputStream.write(0x82)
                    socket.outputStream.flush()
                    observedClose.set(readClientFrame(socket.inputStream))
                }

                val credentialReference = RelayV2CredentialReference("credential-integration")
                val profile = RelayV2Profile(
                    profileId = "profile-integration",
                    issuerUrl = "https://issuer.example.com",
                    relayUrl = server.url(),
                    hostId = "host-integration",
                    principalId = "principal-integration",
                    grantId = "grant-integration",
                    clientInstanceId = "client-integration",
                    credentialReference = credentialReference,
                    credentialVersion = 1,
                    activationGeneration = 1,
                )
                val credential = RelayV2CredentialBlob(
                    credentialVersion = 1,
                    issuerUrl = profile.issuerUrl,
                    relayUrl = profile.relayUrl,
                    hostId = profile.hostId,
                    clientInstanceId = profile.clientInstanceId,
                    principalId = profile.principalId,
                    grantId = profile.grantId,
                    accessToken = TOKEN,
                    accessExpiresAtMs = 2_000_000,
                    refreshToken = "twref2.integration",
                    refreshExpiresAtMs = 3_000_000,
                )
                val parent = CoroutineScope(SupervisorJob() + Dispatchers.Default)
                val actor = RelayV2ConnectionActor(
                    parentScope = parent,
                    transportFactory = server.factory(),
                    credentialStore = ReadOnlyCredentialStore(credentialReference, credential),
                    codec = RelayV2Codec(),
                    clock = { 1_000_000 },
                )
                try {
                    assertTrue(actor.connect(profile, resume = null))
                    val failed = withTimeout(5_000) {
                        actor.state.first { it.phase == RelayV2ConnectionPhase.FAILED }
                    }
                    assertEquals(RelayV2FailureKind.SCHEMA, failed.failure?.kind)
                    assertEquals("INVALID_ENVELOPE", failed.failure?.code)
                    assertFalse(requireNotNull(failed.failure).retryable)
                    assertTrue(waitUntil { observedClose.get() != null })
                    val close = requireNotNull(observedClose.get())
                    assertEquals(OPCODE_CLOSE, close.opcode)
                    assertTrue(close.masked)
                    assertEquals(4400, close.closeCode())
                    assertEquals(1, server.acceptedCount.get())
                } finally {
                    actor.close()
                    parent.cancel()
                }
            }
        }

    @Test
    fun productionBlockedWriteIsFencedBeforeDisconnectReceipt() = runBlocking {
        RawTlsWebSocketServer().use { server ->
            val firstFrameBytes = CountDownLatch(1)
            val releaseDrain = CountDownLatch(1)
            val drainFinished = CountDownLatch(1)
            server.start { socket ->
                socket.receiveBufferSize = 1_024
                val request = server.readRequest(socket)
                server.writeValidUpgrade(socket, request)
                try {
                    if (socket.inputStream.read(ByteArray(512)) > 0) firstFrameBytes.countDown()
                    releaseDrain.await(5, TimeUnit.SECONDS)
                    while (socket.inputStream.read(ByteArray(512)) != -1) Unit
                } catch (_: IOException) {
                    // The close deadline interrupts the blocked production write.
                } finally {
                    drainFinished.countDown()
                }
            }

            val credentialReference = RelayV2CredentialReference("credential-disconnect-fence")
            val profile = RelayV2Profile(
                profileId = "profile-disconnect-fence",
                issuerUrl = "https://issuer.example.com",
                relayUrl = server.url(),
                hostId = "host-disconnect-fence",
                principalId = "principal-disconnect-fence",
                grantId = "grant-disconnect-fence",
                clientInstanceId = "client-disconnect-fence",
                credentialReference = credentialReference,
                credentialVersion = 1,
                activationGeneration = 1,
            )
            val credential = RelayV2CredentialBlob(
                credentialVersion = 1,
                issuerUrl = profile.issuerUrl,
                relayUrl = profile.relayUrl,
                hostId = profile.hostId,
                clientInstanceId = profile.clientInstanceId,
                principalId = profile.principalId,
                grantId = profile.grantId,
                accessToken = TOKEN,
                accessExpiresAtMs = 2_000_000,
                refreshToken = "twref2.disconnect-fence",
                refreshExpiresAtMs = 3_000_000,
            )
            val rawSocket = CloseObservingSocket().apply { sendBufferSize = 1_024 }
            val openedTransport = AtomicReference<RelayV2Transport?>()
            val delegate = server.factory(rawSocketFactory = { rawSocket })
            val capturingFactory = RelayV2TransportFactory { request, listener ->
                delegate.open(request, listener).also(openedTransport::set)
            }
            val parent = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val actor = RelayV2ConnectionActor(
                parentScope = parent,
                transportFactory = capturingFactory,
                credentialStore = ReadOnlyCredentialStore(credentialReference, credential),
                codec = RelayV2Codec(),
                clock = { 1_000_000 },
            )
            try {
                assertTrue(actor.connect(profile, null))
                withTimeout(5_000) {
                    actor.state.first {
                        it.phase == RelayV2ConnectionPhase.AWAITING_RELAY_WELCOME
                    }
                }
                val transport = requireNotNull(openedTransport.get())
                assertTrue(transport.send(ByteArray(MAX_MESSAGE_BYTES) { 'w'.code.toByte() }))
                assertTrue(firstFrameBytes.await(3, TimeUnit.SECONDS))

                val receipt = async {
                    actor.disconnectAndDrain(profile.identity, "production-resource-fence")
                }
                delay(250)
                assertFalse(receipt.isCompleted)
                assertEquals(1L, rawSocket.closed.count)
                assertTrue(rawSocket.closed.await(2, TimeUnit.SECONDS))
                val resourceClosedAt = rawSocket.closedAtNanos.get()
                val completed = withTimeout(5_000) { receipt.await() }
                val receiptAt = System.nanoTime()
                assertEquals("production-resource-fence", completed.barrierId)
                assertTrue(resourceClosedAt > 0L && resourceClosedAt <= receiptAt)
                val effect = withTimeout(5_000) { actor.effects.first() }
                assertTrue(effect is RelayV2RuntimeEffect.Disconnected)
            } finally {
                releaseDrain.countDown()
                assertTrue(drainFinished.await(5, TimeUnit.SECONDS))
                actor.close()
                parent.cancel()
            }
        }
    }

    @Test
    fun boundedResolverCancelFencesLateResultAndCapsWorkersAndQueuedTasks() {
        RawTlsWebSocketServer().use { server ->
            val lookupEntered = CountDownLatch(1)
            val releaseLookup = CountDownLatch(1)
            val lookupFinished = CountDownLatch(1)
            val resolver = BoundedRelayV2AddressResolver(
                lookup = {
                    lookupEntered.countDown()
                    awaitIgnoringInterrupt(releaseLookup)
                    lookupFinished.countDown()
                    arrayOf(InetAddress.getLoopbackAddress())
                },
                workerCount = 1,
                queuedTaskCapacity = 1,
            )
            try {
                server.start { }
                val listener = RecordingListener()
                val transport = server.factory(
                    addressResolver = resolver,
                    resolveTimeoutMs = 5_000,
                ).open(openRequest(server.url()), listener)
                assertTrue(lookupEntered.await(3, TimeUnit.SECONDS))
                val startedAt = System.nanoTime()
                transport.cancel()
                val cancelMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt)
                assertTrue("DNS cancel took ${cancelMs}ms", cancelMs < 500)
                releaseLookup.countDown()
                assertTrue(lookupFinished.await(3, TimeUnit.SECONDS))
                Thread.sleep(100)
                assertEquals(0, server.acceptedCount.get())
                assertTrue(listener.events.isEmpty())
                assertEquals(0, listener.terminalCount.get())
            } finally {
                resolver.close()
            }
        }

        val workers = CopyOnWriteArrayList<String>()
        val workersEntered = CountDownLatch(2)
        val releaseWorkers = CountDownLatch(1)
        val bounded = BoundedRelayV2AddressResolver(
            lookup = {
                workers += Thread.currentThread().name
                workersEntered.countDown()
                awaitIgnoringInterrupt(releaseWorkers)
                arrayOf(InetAddress.getLoopbackAddress())
            },
        )
        try {
            val admitted = List(18) { bounded.resolve("resolver-test.invalid") }
            assertTrue(workersEntered.await(3, TimeUnit.SECONDS))
            try {
                bounded.resolve("resolver-overflow.invalid")
                fail("resolver queue saturation should fail")
            } catch (error: IOException) {
                assertFalse(error.message.orEmpty().contains("resolver-overflow.invalid"))
            }
            admitted.forEach(RelayV2AddressResolution::cancel)
            admitted.forEach { resolution ->
                val startedAt = System.nanoTime()
                try {
                    resolution.await(5_000)
                    fail("cancelled lookup should not resolve")
                } catch (_: IOException) {
                    val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt)
                    assertTrue("cancelled await took ${elapsedMs}ms", elapsedMs < 500)
                }
            }
            assertEquals(2, workers.distinct().size)
        } finally {
            releaseWorkers.countDown()
            bounded.close()
        }
    }

    private fun openRequest(url: String, token: String = TOKEN) = RelayV2TransportOpenRequest(
        relayUrl = url,
        offeredSubprotocols = listOf(RelayV2Profile.RELAY_V2_SUBPROTOCOL),
        accessToken = token,
    )

    private fun assertSameTransportForEveryCallback(
        transport: RelayV2Transport,
        listener: RecordingListener,
    ) {
        assertTrue(listener.callbackSources.isNotEmpty())
        listener.callbackSources.forEach { assertSame(transport, it) }
    }

    private data class HeaderFailureCase(val name: String, val bytes: ByteArray, val consumed: Int)

    private companion object {
        const val TOKEN = "twcap2.transport-secret"
        const val MAX_MESSAGE_BYTES = BoundedRfc6455FrameReader.MAX_MESSAGE_BYTES
        const val OPCODE_CONTINUATION = 0x0
        const val OPCODE_TEXT = 0x1
        const val OPCODE_CLOSE = 0x8
        const val OPCODE_PING = 0x9
        const val OPCODE_PONG = 0xa
        const val CLIENT_ONE_MIB_FRAME_BYTES = MAX_MESSAGE_BYTES + 14
    }
}

private class RecordingListener : RelayV2TransportListener {
    val events = CopyOnWriteArrayList<String>()
    val frames = CopyOnWriteArrayList<ByteArray>()
    val callbackSources = CopyOnWriteArrayList<RelayV2Transport>()
    val opened = CountDownLatch(1)
    val terminal = CountDownLatch(1)
    val terminalCount = AtomicInteger()

    @Volatile
    var openedSubprotocol: String? = null

    @Volatile
    var failure: RelayV2TransportFailure? = null

    override fun onOpen(source: RelayV2Transport, selectedSubprotocol: String?) {
        callbackSources += source
        openedSubprotocol = selectedSubprotocol
        events += "open"
        opened.countDown()
    }

    override fun onFrame(
        source: RelayV2Transport,
        bytes: ByteArray,
        metadata: RelayV2FrameMetadata,
    ) {
        callbackSources += source
        frames += bytes
        events += "frame"
    }

    override fun onClosed(source: RelayV2Transport, code: Int) {
        callbackSources += source
        events += "closed:$code"
        terminalCount.incrementAndGet()
        terminal.countDown()
    }

    override fun onFailure(source: RelayV2Transport, failure: RelayV2TransportFailure) {
        callbackSources += source
        this.failure = failure
        events += "failure"
        terminalCount.incrementAndGet()
        terminal.countDown()
    }
}

private class ReadOnlyCredentialStore(
    private val reference: RelayV2CredentialReference,
    private val credential: RelayV2CredentialBlob,
) : RelayV2CredentialStore {
    override fun read(reference: RelayV2CredentialReference): RelayV2CredentialBlob? =
        credential.takeIf { reference == this.reference }

    override fun create(
        reference: RelayV2CredentialReference,
        blob: RelayV2CredentialBlob,
    ): Boolean = false

    override fun compareAndSet(
        reference: RelayV2CredentialReference,
        expectation: RelayV2CredentialCasExpectation,
        replacement: RelayV2CredentialBlob,
    ): RelayV2CredentialCasResult = error("Credential mutation is outside transport integration")

    override fun clear(reference: RelayV2CredentialReference) = Unit
}

private class ImmediateAddressResolver(
    private val address: InetAddress,
) : RelayV2AddressResolver {
    override fun resolve(host: String): RelayV2AddressResolution =
        object : RelayV2AddressResolution {
            override fun await(timeoutMs: Int): List<InetAddress> = listOf(address)

            override fun cancel() = Unit
        }
}

private class BlockingConnectSocket : Socket() {
    val connectEntered = CountDownLatch(1)
    val connectExited = CountDownLatch(1)
    private val closed = CountDownLatch(1)

    override fun connect(endpoint: SocketAddress, timeout: Int) {
        connectEntered.countDown()
        try {
            closed.await()
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        } finally {
            connectExited.countDown()
        }
        throw SocketException("test socket was closed")
    }

    override fun close() {
        closed.countDown()
        super.close()
    }
}

private class CloseObservingSocket : Socket() {
    val closed = CountDownLatch(1)
    val closedAtNanos = AtomicLong()

    override fun close() {
        try {
            super.close()
        } finally {
            closedAtNanos.compareAndSet(0L, System.nanoTime())
            closed.countDown()
        }
    }
}

private class RawTlsWebSocketServer(
    certificateHostname: String = "localhost",
) : Closeable {
    private val certificate = HeldCertificate.Builder()
        .commonName(certificateHostname)
        .addSubjectAlternativeName(certificateHostname)
        .build()
    private val serverCertificates = HandshakeCertificates.Builder()
        .heldCertificate(certificate)
        .build()
    private val clientCertificates = HandshakeCertificates.Builder()
        .addTrustedCertificate(certificate.certificate)
        .build()
    private val serverSocket = serverCertificates.sslContext().serverSocketFactory
        .createServerSocket(0, 50, InetAddress.getLoopbackAddress()) as SSLServerSocket
    private val running = AtomicBoolean(true)
    private val activeSockets = CopyOnWriteArrayList<SSLSocket>()
    private val thread = AtomicReference<Thread?>()

    val acceptedCount = AtomicInteger()
    val requests = CopyOnWriteArrayList<String>()

    fun start(handler: (SSLSocket) -> Unit) {
        check(thread.get() == null)
        serverSocket.soTimeout = 100
        thread.set(
            kotlin.concurrent.thread(name = "relay-v2-raw-tls-server", isDaemon = true) {
                while (running.get()) {
                    val socket = try {
                        serverSocket.accept() as SSLSocket
                    } catch (_: SocketTimeoutException) {
                        continue
                    } catch (_: IOException) {
                        return@thread
                    }
                    acceptedCount.incrementAndGet()
                    activeSockets += socket
                    try {
                        socket.soTimeout = 5_000
                        handler(socket)
                    } catch (_: IOException) {
                        // TLS rejection, cancellation, and deliberate disconnects are test inputs.
                    } finally {
                        activeSockets -= socket
                        runCatching { socket.close() }
                    }
                }
            },
        )
    }

    fun url(host: String = "localhost"): String = "wss://$host:${serverSocket.localPort}/client"

    fun factory(
        addressResolver: RelayV2AddressResolver = RelayV2SystemAddressResolver,
        resolveTimeoutMs: Int = 2_000,
        rawSocketFactory: () -> Socket = ::Socket,
    ): BoundedRelayV2TransportFactory = BoundedRelayV2TransportFactory(
        sslSocketFactory = clientCertificates.sslSocketFactory(),
        addressResolver = addressResolver,
        rawSocketFactory = rawSocketFactory,
        resolveTimeoutMs = resolveTimeoutMs,
        connectTimeoutMs = 2_000,
        handshakeTimeoutMs = 2_000,
    )

    fun readRequest(socket: SSLSocket): String {
        val request = readUntilHeaderEnd(socket.inputStream)
        requests += request
        return request
    }

    fun writeValidUpgrade(
        socket: SSLSocket,
        request: String,
        selectedSubprotocol: String? = RelayV2Profile.RELAY_V2_SUBPROTOCOL,
        additionalHeaders: List<String> = emptyList(),
        acceptOverride: String? = null,
    ) {
        val key = request.lineSequence()
            .first { it.startsWith("Sec-WebSocket-Key: ", ignoreCase = true) }
            .substringAfter(':')
            .trim()
        val selectedHeader = selectedSubprotocol?.let { "Sec-WebSocket-Protocol: $it\r\n" }.orEmpty()
        val extra = additionalHeaders.joinToString(separator = "", postfix = if (additionalHeaders.isEmpty()) "" else "") {
            "$it\r\n"
        }
        val accept = acceptOverride ?: webSocketAccept(key)
        socket.outputStream.writeAscii(
            "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "Sec-WebSocket-Accept: $accept\r\n" +
                selectedHeader +
                extra +
                "\r\n",
        )
        socket.outputStream.flush()
    }

    fun awaitRequestCount(count: Int): Boolean = waitUntil { requests.size >= count }

    fun awaitAcceptedCount(count: Int): Boolean = waitUntil { acceptedCount.get() >= count }

    override fun close() {
        running.set(false)
        runCatching { serverSocket.close() }
        activeSockets.forEach { runCatching { it.close() } }
        thread.get()?.join(2_000)
    }
}

private class CountingInputStream(bytes: ByteArray) : ByteArrayInputStream(bytes) {
    var consumed: Int = 0
        private set

    override fun read(): Int = super.read().also { if (it != -1) consumed += 1 }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
        super.read(buffer, offset, length).also { if (it > 0) consumed += it }
}

private class GatedOutputStream : OutputStream() {
    private val delegate = ByteArrayOutputStream()
    private val gateUsed = AtomicBoolean(false)
    private val flushCount = AtomicInteger()

    val firstWrite = CountDownLatch(1)
    val release = CountDownLatch(1)
    val interrupted = CountDownLatch(1)

    override fun write(value: Int) {
        awaitGate()
        synchronized(delegate) { delegate.write(value) }
    }

    override fun write(bytes: ByteArray, offset: Int, length: Int) {
        awaitGate()
        synchronized(delegate) { delegate.write(bytes, offset, length) }
    }

    override fun flush() {
        flushCount.incrementAndGet()
    }

    fun awaitFlushCount(expected: Int): Boolean = waitUntil { flushCount.get() >= expected }

    fun bytes(): ByteArray = synchronized(delegate) { delegate.toByteArray() }

    private fun awaitGate() {
        if (!gateUsed.compareAndSet(false, true)) return
        firstWrite.countDown()
        try {
            if (!release.await(5, TimeUnit.SECONDS)) throw IOException("test output gate timed out")
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
            interrupted.countDown()
            throw IOException("test output gate interrupted", error)
        }
    }
}

private data class ObservedClientFrame(
    val opcode: Int,
    val masked: Boolean,
    val payload: ByteArray,
)

private fun ObservedClientFrame.closeCode(): Int {
    check(payload.size >= 2)
    return ((payload[0].toInt() and 0xff) shl 8) or (payload[1].toInt() and 0xff)
}

private fun readAllClientFrames(bytes: ByteArray): List<ObservedClientFrame> {
    val input = ByteArrayInputStream(bytes)
    val frames = mutableListOf<ObservedClientFrame>()
    while (input.available() > 0) frames += readClientFrame(input)
    return frames
}

private fun readClientFrame(input: InputStream): ObservedClientFrame {
    val first = input.readRequired()
    val second = input.readRequired()
    val masked = second and 0x80 != 0
    val length = when (val marker = second and 0x7f) {
        in 0..125 -> marker
        126 -> (input.readRequired() shl 8) or input.readRequired()
        127 -> {
            repeat(4) { assertEquals(0, input.readRequired()) }
            (input.readRequired() shl 24) or
                (input.readRequired() shl 16) or
                (input.readRequired() shl 8) or
                input.readRequired()
        }
        else -> error("unreachable")
    }
    val mask = ByteArray(4)
    if (masked) input.readFullyTest(mask)
    val payload = ByteArray(length)
    input.readFullyTest(payload)
    if (masked) {
        payload.indices.forEach { index ->
            payload[index] = (payload[index].toInt() xor mask[index and 3].toInt()).toByte()
        }
    }
    return ObservedClientFrame(first and 0x0f, masked, payload)
}

private fun serverFrameHeader(
    final: Boolean,
    opcode: Int,
    length: Long,
    rsv: Int = 0,
): ByteArray = ByteArrayOutputStream().also { output ->
    output.write((if (final) 0x80 else 0) or rsv or opcode)
    when {
        length <= 125 -> output.write(length.toInt())
        length <= 65_535 -> {
            output.write(126)
            output.write((length ushr 8).toInt())
            output.write(length.toInt())
        }
        else -> {
            output.write(127)
            repeat(8) { shift -> output.write((length ushr (56 - shift * 8)).toInt()) }
        }
    }
}.toByteArray()

private fun writeServerFrame(
    output: OutputStream,
    final: Boolean,
    opcode: Int,
    payload: ByteArray,
) {
    output.write(serverFrameHeader(final, opcode, payload.size.toLong()))
    output.write(payload)
}

private fun readUntilHeaderEnd(input: InputStream): String {
    val output = ByteArrayOutputStream()
    var matched = 0
    while (output.size() < 65_536) {
        val value = input.read()
        if (value == -1) throw EOFException("request truncated")
        output.write(value)
        matched = when {
            matched == 0 && value == '\r'.code -> 1
            matched == 1 && value == '\n'.code -> 2
            matched == 2 && value == '\r'.code -> 3
            matched == 3 && value == '\n'.code -> 4
            value == '\r'.code -> 1
            else -> 0
        }
        if (matched == 4) return output.toString(StandardCharsets.ISO_8859_1.name())
    }
    throw IOException("request headers exceeded test server limit")
}

private fun webSocketAccept(key: String): String {
    val digest = MessageDigest.getInstance("SHA-1").digest(
        (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray(StandardCharsets.US_ASCII),
    )
    return Base64.getEncoder().encodeToString(digest)
}

private fun OutputStream.writeAscii(value: String) {
    write(value.toByteArray(StandardCharsets.US_ASCII))
}

private fun InputStream.readRequired(): Int = read().also {
    if (it == -1) throw EOFException("client frame truncated")
}

private fun InputStream.readFullyTest(destination: ByteArray) {
    var offset = 0
    while (offset < destination.size) {
        val count = read(destination, offset, destination.size - offset)
        if (count == -1) throw EOFException("client frame truncated")
        offset += count
    }
}

private fun assertProtocolFailure(name: String = "frame", block: () -> Unit) {
    try {
        block()
        fail("$name should fail")
    } catch (_: RelayV2WebSocketProtocolException) {
        // Expected from the production frame reader.
    }
}

private fun waitUntil(timeoutMs: Long = 3_000, predicate: () -> Boolean): Boolean {
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
    while (System.nanoTime() < deadline) {
        if (predicate()) return true
        Thread.yield()
    }
    return predicate()
}

private fun awaitIgnoringInterrupt(latch: CountDownLatch) {
    while (true) {
        try {
            latch.await()
            return
        } catch (_: InterruptedException) {
            // Model platform resolvers that do not honor Future.cancel(true).
        }
    }
}
