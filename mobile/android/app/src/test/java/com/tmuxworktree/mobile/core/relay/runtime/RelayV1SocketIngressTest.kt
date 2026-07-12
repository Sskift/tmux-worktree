package com.tmuxworktree.mobile.core.relay.runtime

import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import okhttp3.Request
import okhttp3.WebSocket
import okio.ByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV1SocketIngressTest {
    @Test
    fun `failure cannot overtake a message already inside the listener ingress`() {
        val callbackOrder = CopyOnWriteArrayList<String>()
        val messageEntered = CountDownLatch(1)
        val releaseMessage = CountDownLatch(1)
        val failureAboutToEnter = CountDownLatch(1)
        val failureThread = AtomicReference<Thread>()
        val rejected = AtomicInteger(0)
        val callbacks = Executors.newFixedThreadPool(2)
        val socket = FakeWebSocket()
        val listener = RelayV1SocketIngress(
            acceptOpen = { true },
            acceptMessage = {
                messageEntered.countDown()
                check(releaseMessage.await(5, TimeUnit.SECONDS))
                callbackOrder += "message"
                true
            },
            acceptClose = { _, _ -> true },
            acceptFailure = { _, _ ->
                callbackOrder += "failure"
                true
            },
            reject = { rejected.incrementAndGet() },
        )

        var message: Future<*>? = null
        var failure: Future<*>? = null
        try {
            message = callbacks.submit {
                listener.onMessage(socket, "terminal-tail")
            }
            assertTrue("message callback did not enter ingress", messageEntered.await(5, TimeUnit.SECONDS))

            failure = callbacks.submit {
                failureThread.set(Thread.currentThread())
                failureAboutToEnter.countDown()
                listener.onFailure(socket, IOException("closed"), null)
            }
            assertTrue(
                "failure callback task did not start",
                failureAboutToEnter.await(5, TimeUnit.SECONDS),
            )
            awaitBlockedOnIngress(failureThread.get())
            assertTrue("failure ran while message still owned ingress", callbackOrder.isEmpty())

            releaseMessage.countDown()
            message.get(5, TimeUnit.SECONDS)
            failure.get(5, TimeUnit.SECONDS)

            assertEquals(listOf("message", "failure"), callbackOrder)
            assertEquals(0, rejected.get())
        } finally {
            releaseMessage.countDown()
            message?.cancel(true)
            failure?.cancel(true)
            callbacks.shutdownNow()
            assertTrue("callback executor did not stop", callbacks.awaitTermination(5, TimeUnit.SECONDS))
        }
    }

    private fun awaitBlockedOnIngress(thread: Thread) {
        val deadlineNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (thread.state != Thread.State.BLOCKED) {
            if (System.nanoTime() >= deadlineNanos) {
                throw AssertionError("failure callback never blocked on the listener ingress lock")
            }
            Thread.yield()
        }
    }

    private class FakeWebSocket : WebSocket {
        override fun request(): Request = Request.Builder()
            .url("ws://localhost/relay-test")
            .build()

        override fun queueSize(): Long = 0

        override fun send(text: String): Boolean = true

        override fun send(bytes: ByteString): Boolean = true

        override fun close(code: Int, reason: String?): Boolean = true

        override fun cancel() = Unit
    }
}
