package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.RelayV2TlsMockServer
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2FrameMetadata
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialBlob
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialCasExpectation
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialCasResult
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialReference
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2CredentialStore
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okio.ByteString.Companion.toByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OkHttpRelayV2TransportFactoryTest {
    @Test
    fun `upgrade keeps bearer out of URL and offers only the v2 subprotocol`() {
        RelayV2TlsMockServer().use { tls ->
            val peer = AtomicReference<WebSocket>()
            val peerOpened = CountDownLatch(1)
            val peerMessage = AtomicReference<String>()
            val peerMessageReceived = CountDownLatch(1)
            tls.server.enqueue(
                websocketResponse(
                    selectedSubprotocol = RelayV2Profile.RELAY_V2_SUBPROTOCOL,
                    listener = object : WebSocketListener() {
                        override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                            peer.set(webSocket)
                            peerOpened.countDown()
                        }

                        override fun onMessage(webSocket: WebSocket, text: String) {
                            peerMessage.set(text)
                            peerMessageReceived.countDown()
                        }
                    },
                ),
            )
            val listener = RecordingListener()
            val accessToken = "twcap2.payload.mac"
            val transport = OkHttpRelayV2TransportFactory(tls.client).open(
                RelayV2TransportOpenRequest(
                    relayUrl = tls.relayUrl,
                    offeredSubprotocols = listOf(RelayV2Profile.RELAY_V2_SUBPROTOCOL),
                    accessToken = accessToken,
                ),
                listener,
            )

            assertTrue(listener.opened.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
            assertTrue(peerOpened.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
            val upgrade = tls.server.takeRequest(TIMEOUT_SECONDS, TimeUnit.SECONDS)
                ?: error("WebSocket Upgrade was not recorded")
            assertEquals("/client", upgrade.requestUrl?.encodedPath)
            assertNull(upgrade.requestUrl?.encodedQuery)
            assertEquals("Bearer $accessToken", upgrade.getHeader("Authorization"))
            assertEquals(
                RelayV2Profile.RELAY_V2_SUBPROTOCOL,
                upgrade.getHeader("Sec-WebSocket-Protocol"),
            )
            assertFalse(upgrade.requestUrl.toString().contains(accessToken))
            assertFalse(transport.toString().contains(accessToken))

            val outbound = "{\"kind\":\"client-test\"}"
            assertTrue(transport.send(outbound.toByteArray()))
            assertTrue(peerMessageReceived.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
            assertEquals(outbound, peerMessage.get())

            peer.get().send("{\"kind\":\"server-test\"}")
            assertTrue(listener.frameReceived.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
            assertEquals("text", listener.frames.single().second.opcode)
            assertEquals(
                "{\"kind\":\"server-test\"}",
                listener.frames.single().first.toString(Charsets.UTF_8),
            )

            peer.get().close(1000, "done")
            assertTrue(listener.terminal.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
            assertEquals(listOf("open", "frame:text", "closed:1000"), listener.events)
            assertFalse(transport.send("late".toByteArray()))
        }
    }

    @Test
    fun `message callback is ordered before one abrupt failure callback`() {
        RelayV2TlsMockServer().use { tls ->
            val peer = AtomicReference<WebSocket>()
            tls.server.enqueue(
                websocketResponse(
                    selectedSubprotocol = RelayV2Profile.RELAY_V2_SUBPROTOCOL,
                    listener = object : WebSocketListener() {
                        override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                            peer.set(webSocket)
                        }
                    },
                ),
            )
            val listener = RecordingListener()
            val transport = OkHttpRelayV2TransportFactory(tls.client).open(openRequest(tls), listener)
            assertTrue(listener.opened.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
            while (peer.get() == null) Thread.yield()

            peer.get().send("tail")
            assertTrue(listener.frameReceived.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
            transport.cancel()
            assertTrue(listener.terminal.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
            assertEquals(listOf("open", "frame:text", "failure:NETWORK:null"), listener.events)
            assertFalse(transport.send("late".toByteArray()))

            val executor = Executors.newFixedThreadPool(4)
            try {
                val operations = (0 until 16).map { index ->
                    executor.submit {
                        if (index % 2 == 0) transport.close(1000, "done") else transport.cancel()
                    }
                }
                operations.forEach { it.get(TIMEOUT_SECONDS, TimeUnit.SECONDS) }
            } finally {
                executor.shutdownNow()
                assertTrue(executor.awaitTermination(TIMEOUT_SECONDS, TimeUnit.SECONDS))
            }
            assertEquals(1, listener.events.count { it.startsWith("failure:") || it.startsWith("closed:") })
        }
    }

    @Test
    fun `binary metadata and oversized text stay bounded for strict codec rejection`() {
        RelayV2TlsMockServer().use { tls ->
            val peer = AtomicReference<WebSocket>()
            tls.server.enqueue(
                websocketResponse(
                    selectedSubprotocol = RelayV2Profile.RELAY_V2_SUBPROTOCOL,
                    listener = object : WebSocketListener() {
                        override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                            peer.set(webSocket)
                        }
                    },
                ),
            )
            val listener = RecordingListener(expectedFrames = 2)
            val transport = OkHttpRelayV2TransportFactory(tls.client).open(openRequest(tls), listener)
            assertTrue(listener.opened.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
            while (peer.get() == null) Thread.yield()

            val binary = byteArrayOf(0x00, 0x01, 0x02)
            peer.get().send(binary.toByteString())
            peer.get().send("x".repeat(RelayV2Codec.PUBLIC_FRAME_BYTES + 100))
            assertTrue(listener.frameReceived.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))

            assertEquals("binary", listener.frames[0].second.opcode)
            assertTrue(binary.contentEquals(listener.frames[0].first))
            assertEquals("text", listener.frames[1].second.opcode)
            assertEquals(RelayV2Codec.PUBLIC_FRAME_BYTES + 1, listener.frames[1].first.size)
            transport.cancel()
            assertTrue(listener.terminal.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
        }
    }

    @Test
    fun `upgrade status and selected subprotocol failures reach actor closed failure kinds`() =
        runBlocking {
            val scenarios = listOf(
                FailureScenario("401", MockResponse().setResponseCode(401), RelayV2FailureKind.AUTH, "AUTH_REQUIRED", false),
                FailureScenario("403", MockResponse().setResponseCode(403), RelayV2FailureKind.AUTH, "PERMISSION_DENIED", false),
                FailureScenario("426", MockResponse().setResponseCode(426), RelayV2FailureKind.DIALECT, "PROTOCOL_UNSUPPORTED", false),
                FailureScenario("503", MockResponse().setResponseCode(503), RelayV2FailureKind.ROUTE, "HOST_OFFLINE", true),
                FailureScenario(
                    "missing subprotocol",
                    websocketResponse(selectedSubprotocol = null),
                    RelayV2FailureKind.DIALECT,
                    "PROTOCOL_UNSUPPORTED",
                    false,
                ),
                FailureScenario(
                    "wrong subprotocol",
                    websocketResponse(selectedSubprotocol = "tw-relay.v1"),
                    RelayV2FailureKind.DIALECT,
                    "PROTOCOL_UNSUPPORTED",
                    false,
                ),
                FailureScenario(
                    "compression selected",
                    websocketResponse(
                        selectedSubprotocol = RelayV2Profile.RELAY_V2_SUBPROTOCOL,
                        selectedExtension = "permessage-deflate",
                    ),
                    RelayV2FailureKind.DIALECT,
                    "PROTOCOL_UNSUPPORTED",
                    false,
                ),
            )

            scenarios.forEach { scenario ->
                RelayV2TlsMockServer().use { tls ->
                    tls.server.enqueue(scenario.response)
                    val parent = CoroutineScope(SupervisorJob() + Dispatchers.Default)
                    val credentials = MemoryCredentialStore()
                    val profile = profile(tls, credentials)
                    val actor = RelayV2ConnectionActor(
                        parentScope = parent,
                        transportFactory = OkHttpRelayV2TransportFactory(tls.client),
                        credentialStore = credentials,
                    )
                    try {
                        assertTrue(scenario.name, actor.connect(profile, resume = null))
                        val failed = withTimeout(TIMEOUT_SECONDS * 1_000) {
                            actor.state.first { it.phase == RelayV2ConnectionPhase.FAILED }
                        }
                        assertEquals(scenario.name, scenario.kind, failed.failure?.kind)
                        assertEquals(scenario.name, scenario.code, failed.failure?.code)
                        assertEquals(scenario.name, scenario.retryable, failed.failure?.retryable)
                        val upgrade = tls.server.takeRequest(TIMEOUT_SECONDS, TimeUnit.SECONDS)
                            ?: error("${scenario.name} Upgrade was not recorded")
                        assertEquals("/client", upgrade.path)
                        assertNull(upgrade.requestUrl?.encodedQuery)
                    } finally {
                        actor.close()
                        parent.cancel()
                    }
                }
            }
        }

    @Test
    fun `relay URL policy rejects cleartext wrong paths and query before network use`() {
        RelayV2TlsMockServer().use { tls ->
            val accessToken = "twcap2.payload.mac"
            val invalidUrls = listOf(
                tls.relayUrl.replaceFirst("wss://", "ws://"),
                tls.relayUrl.removeSuffix("/client") + "/client/",
                "${tls.relayUrl}?accessToken=$accessToken",
            )
            invalidUrls.forEach { url ->
                val error = runCatching {
                    OkHttpRelayV2TransportFactory(tls.client).open(
                        RelayV2TransportOpenRequest(
                            relayUrl = url,
                            offeredSubprotocols = listOf(RelayV2Profile.RELAY_V2_SUBPROTOCOL),
                            accessToken = accessToken,
                        ),
                        RecordingListener(),
                    )
                }.exceptionOrNull() ?: error("Invalid Relay URL was accepted")
                assertFalse(error.toString().contains(accessToken))
            }
            assertEquals(0, tls.server.requestCount)
        }
    }

    private fun openRequest(tls: RelayV2TlsMockServer) = RelayV2TransportOpenRequest(
        relayUrl = tls.relayUrl,
        offeredSubprotocols = listOf(RelayV2Profile.RELAY_V2_SUBPROTOCOL),
        accessToken = "twcap2.payload.mac",
    )

    private fun profile(
        tls: RelayV2TlsMockServer,
        credentials: MemoryCredentialStore,
    ): RelayV2Profile {
        val reference = RelayV2CredentialReference("credential-local-test")
        val profile = RelayV2Profile(
            profileId = "profile-local-test",
            issuerUrl = tls.issuerUrl,
            relayUrl = tls.relayUrl,
            hostId = "mac-admin",
            principalId = "principal-opaque-id",
            grantId = "grant-local-test",
            clientInstanceId = "android-install-local-test",
            credentialReference = reference,
            credentialVersion = 1,
        )
        check(
            credentials.create(
                reference,
                RelayV2CredentialBlob(
                    credentialVersion = 1,
                    issuerUrl = profile.issuerUrl,
                    relayUrl = profile.relayUrl,
                    hostId = profile.hostId,
                    clientInstanceId = profile.clientInstanceId,
                    principalId = profile.principalId,
                    grantId = profile.grantId,
                    accessToken = "twcap2.payload.mac",
                    accessExpiresAtMs = System.currentTimeMillis() + 60_000,
                    refreshToken = "twref2.refresh",
                    refreshExpiresAtMs = System.currentTimeMillis() + 120_000,
                ),
            ),
        )
        return profile
    }

    private class RecordingListener(expectedFrames: Int = 1) : RelayV2TransportListener {
        val opened = CountDownLatch(1)
        val frameReceived = CountDownLatch(expectedFrames)
        val terminal = CountDownLatch(1)
        val events = CopyOnWriteArrayList<String>()
        val frames = CopyOnWriteArrayList<Pair<ByteArray, RelayV2FrameMetadata>>()

        override fun onOpen(source: RelayV2Transport, selectedSubprotocol: String?) {
            events += "open"
            opened.countDown()
        }

        override fun onFrame(
            source: RelayV2Transport,
            bytes: ByteArray,
            metadata: RelayV2FrameMetadata,
        ) {
            frames += bytes.copyOf() to metadata
            events += "frame:${metadata.opcode}"
            frameReceived.countDown()
        }

        override fun onClosed(source: RelayV2Transport, code: Int) {
            events += "closed:$code"
            terminal.countDown()
        }

        override fun onFailure(source: RelayV2Transport, failure: RelayV2TransportFailure) {
            events += "failure:${failure.kind}:${failure.httpStatus}"
            terminal.countDown()
        }
    }

    private class MemoryCredentialStore : RelayV2CredentialStore {
        private val values = linkedMapOf<RelayV2CredentialReference, RelayV2CredentialBlob>()

        override fun read(reference: RelayV2CredentialReference): RelayV2CredentialBlob? =
            synchronized(values) { values[reference] }

        override fun create(
            reference: RelayV2CredentialReference,
            blob: RelayV2CredentialBlob,
        ): Boolean = synchronized(values) {
            if (reference in values) false else {
                values[reference] = blob
                true
            }
        }

        override fun compareAndSet(
            reference: RelayV2CredentialReference,
            expectation: RelayV2CredentialCasExpectation,
            replacement: RelayV2CredentialBlob,
        ): RelayV2CredentialCasResult = error("Credential CAS is not used by transport tests")

        override fun clear(reference: RelayV2CredentialReference) {
            synchronized(values) { values.remove(reference) }
        }
    }

    private data class FailureScenario(
        val name: String,
        val response: MockResponse,
        val kind: RelayV2FailureKind,
        val code: String,
        val retryable: Boolean,
    )

    private companion object {
        const val TIMEOUT_SECONDS = 5L

        fun websocketResponse(
            selectedSubprotocol: String?,
            selectedExtension: String? = null,
            listener: WebSocketListener = object : WebSocketListener() {},
        ): MockResponse = MockResponse()
            .apply {
                if (selectedSubprotocol != null) {
                    addHeader("Sec-WebSocket-Protocol", selectedSubprotocol)
                }
                if (selectedExtension != null) {
                    addHeader("Sec-WebSocket-Extensions", selectedExtension)
                }
            }
            .withWebSocketUpgrade(listener)
    }
}
