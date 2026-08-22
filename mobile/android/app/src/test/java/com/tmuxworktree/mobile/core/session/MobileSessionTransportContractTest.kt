package com.tmuxworktree.mobile.core.session

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileSessionTransportContractTest {
    @Test
    fun adapterRouteIsOpaqueAndCallbacksRetainExactTransportIdentity() = runBlocking {
        val adapter = InMemoryMobileSessionTransportAdapter<DirectTestRoute>()
        val listener = RecordingMobileSessionListener()
        val route = DirectTestRoute("paired-device")

        val transport = adapter.open(route, listener)
        assertEquals(route, adapter.routes.single())
        assertSame(transport, listener.sources.single())

        val outbound = "input".toByteArray()
        assertTrue(transport.send(outbound))
        outbound.fill(0)
        assertArrayEquals("input".toByteArray(), adapter.outbound.single())

        adapter.deliver("output".toByteArray())
        assertArrayEquals("output".toByteArray(), listener.frames.single())

        transport.close(1000, "done")
        transport.cancel()
        assertTrue(transport.awaitTermination())
        assertEquals(listOf("open", "frame", "closed:1000"), listener.events)
        assertTrue(listener.sources.all { it === transport })
    }

    @Test
    fun reconnectPolicyIsBoundedAndJitteredWithoutChangingTheRetryLadder() {
        val low = ExponentialMobileSessionReconnectPolicy(
            baseDelayMs = 250,
            maxDelayMs = 30_000,
            jitterRatio = 0.2,
            randomUnit = { 0.0 },
        )
        val high = ExponentialMobileSessionReconnectPolicy(
            baseDelayMs = 250,
            maxDelayMs = 30_000,
            jitterRatio = 0.2,
            randomUnit = { 1.0 },
        )

        assertEquals(200L, low.delayMillis(0))
        assertEquals(300L, high.delayMillis(0))
        assertEquals(24_000L, low.delayMillis(30))
        assertEquals(30_000L, high.delayMillis(30))
    }

    private data class DirectTestRoute(val pairingId: String)

    private class InMemoryMobileSessionTransportAdapter<Route> :
        MobileSessionTransportAdapter<Route> {
        val routes = CopyOnWriteArrayList<Route>()
        val outbound = CopyOnWriteArrayList<ByteArray>()
        private lateinit var listener: MobileSessionTransportListener
        private lateinit var transport: InMemoryTransport

        override fun open(
            route: Route,
            listener: MobileSessionTransportListener,
        ): MobileSessionTransport {
            routes += route
            this.listener = listener
            transport = InMemoryTransport(listener, outbound)
            listener.onOpen(transport, null)
            return transport
        }

        fun deliver(bytes: ByteArray) {
            listener.onFrame(transport, bytes.copyOf())
        }
    }

    private class InMemoryTransport(
        private val listener: MobileSessionTransportListener,
        private val outbound: MutableList<ByteArray>,
    ) : MobileSessionTransport {
        private val termination = CompletableDeferred<Unit>()
        private var terminal = false

        override fun send(bytes: ByteArray): Boolean {
            if (terminal) return false
            outbound += bytes.copyOf()
            return true
        }

        override fun close(code: Int, reason: String) {
            if (terminal) return
            terminal = true
            listener.onClosed(this, code)
            termination.complete(Unit)
        }

        override fun cancel() {
            terminal = true
            termination.complete(Unit)
        }

        override suspend fun awaitTermination(): Boolean {
            termination.await()
            return true
        }
    }

    private class RecordingMobileSessionListener : MobileSessionTransportListener {
        val events = CopyOnWriteArrayList<String>()
        val sources = CopyOnWriteArrayList<MobileSessionTransport>()
        val frames = CopyOnWriteArrayList<ByteArray>()

        override fun onOpen(source: MobileSessionTransport, selectedSubprotocol: String?) {
            sources += source
            events += "open"
        }

        override fun onFrame(
            source: MobileSessionTransport,
            bytes: ByteArray,
            metadata: MobileSessionFrameMetadata,
        ) {
            sources += source
            frames += bytes.copyOf()
            events += "frame"
        }

        override fun onClosed(source: MobileSessionTransport, code: Int) {
            sources += source
            events += "closed:$code"
        }

        override fun onFailure(
            source: MobileSessionTransport,
            failure: MobileSessionTransportFailure,
        ) {
            sources += source
            events += "failure:${failure.kind}"
        }
    }
}
