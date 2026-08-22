package com.tmuxworktree.mobile.core.terminal

import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectGeneration
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalDeliveryToken
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffectFence
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalIdentity
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenAttempt
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserCallbackToken
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2TerminalWebViewParserAdapterTest {
    @Test
    fun `default callback dispatcher keeps durable completions off caller and serial`() =
        runBlocking {
            lateinit var firstPlatformCompletion: (Boolean) -> Unit
            lateinit var secondPlatformCompletion: (Boolean) -> Unit
            val registrationIndex = AtomicInteger(0)
            val activeCompletions = AtomicInteger(0)
            val maximumActiveCompletions = AtomicInteger(0)
            val firstEntered = CountDownLatch(1)
            val secondEntered = CountDownLatch(1)
            val releaseFirst = CountDownLatch(1)
            val adapter = RelayV2TerminalWebViewParserAdapter(
                callbackScope = CoroutineScope(coroutineContext),
                writePort = RelayV2TerminalWebViewWritePort { _, _, callback ->
                    when (registrationIndex.getAndIncrement()) {
                        0 -> firstPlatformCompletion = callback
                        1 -> secondPlatformCompletion = callback
                        else -> error("unexpected parser registration")
                    }
                    true
                },
                resetPort = RelayV2TerminalWebViewResetPort { _, _ -> false },
                newCallbackNonce = { "serial-${registrationIndex.get()}" },
            )

            assertTrue(
                adapter.write(token(), byteArrayOf(1)) {
                    val active = activeCompletions.incrementAndGet()
                    maximumActiveCompletions.accumulateAndGet(active, ::maxOf)
                    firstEntered.countDown()
                    check(releaseFirst.await(5, TimeUnit.SECONDS))
                    activeCompletions.decrementAndGet()
                },
            )
            assertTrue(
                adapter.write(token(), byteArrayOf(2)) {
                    val active = activeCompletions.incrementAndGet()
                    maximumActiveCompletions.accumulateAndGet(active, ::maxOf)
                    secondEntered.countDown()
                    activeCompletions.decrementAndGet()
                },
            )

            // Both callbacks cross their platform gate on this JUnit caller. Neither durable
            // completion may run inline here, and the second must not pass the first IO task.
            firstPlatformCompletion(true)
            secondPlatformCompletion(true)
            assertTrue(firstEntered.await(5, TimeUnit.SECONDS))
            assertFalse(secondEntered.await(150, TimeUnit.MILLISECONDS))

            val barrier = adapter.fenceAttachment()
            assertFalse(barrier.isDrained)
            releaseFirst.countDown()
            assertTrue(secondEntered.await(5, TimeUnit.SECONDS))
            withTimeout(5_000) { barrier.awaitDrained() }
            assertEquals(1, maximumActiveCompletions.get())
        }

    @Test
    fun `early callback waits for the platform registration decision`() = runBlocking {
        val completion = CompletableDeferred<Boolean>()
        val platformRegistrationActive = AtomicBoolean(false)
        var capturedId = ""
        var capturedBytes = byteArrayOf()
        val adapter = RelayV2TerminalWebViewParserAdapter(
            callbackScope = CoroutineScope(Dispatchers.Unconfined),
            writePort = RelayV2TerminalWebViewWritePort { callbackId, bytes, callback ->
                capturedId = callbackId
                capturedBytes = bytes.copyOf()
                platformRegistrationActive.set(true)
                try {
                    callback(true)
                    assertFalse(completion.isCompleted)
                    true
                } finally {
                    platformRegistrationActive.set(false)
                }
            },
            resetPort = RelayV2TerminalWebViewResetPort { _, _ -> false },
            newCallbackNonce = { "nonce" },
        )

        val accepted = adapter.write(token(), byteArrayOf(0, 0x7f, -1)) {
            assertFalse(platformRegistrationActive.get())
            completion.complete(it)
        }

        assertTrue(accepted)
        assertEquals("operation.nonce", capturedId)
        assertArrayEquals(byteArrayOf(0, 0x7f, -1), capturedBytes)
        assertTrue(completion.await())
    }

    @Test
    fun `false platform acknowledgement settles asynchronously without throwing`() = runBlocking {
        val completion = CompletableDeferred<Boolean>()
        lateinit var platformCompletion: (Boolean) -> Unit
        val adapter = RelayV2TerminalWebViewParserAdapter(
            callbackScope = CoroutineScope(coroutineContext),
            writePort = RelayV2TerminalWebViewWritePort { _, _, _ -> false },
            resetPort = RelayV2TerminalWebViewResetPort { _, callback ->
                platformCompletion = callback
                true
            },
            newCallbackNonce = { "reset" },
        )

        assertTrue(adapter.reset(token()) { completion.complete(it) })
        assertFalse(completion.isCompleted)
        platformCompletion(false)
        assertFalse(completion.await())
    }

    @Test
    fun `attachment fence drains an accepted late false callback without dropping it`() =
        runBlocking {
            val completion = CompletableDeferred<Boolean>()
            lateinit var platformCompletion: (Boolean) -> Unit
            val adapter = RelayV2TerminalWebViewParserAdapter(
                callbackScope = CoroutineScope(coroutineContext),
                writePort = RelayV2TerminalWebViewWritePort { _, _, callback ->
                    platformCompletion = callback
                    true
                },
                resetPort = RelayV2TerminalWebViewResetPort { _, _ -> false },
                newCallbackNonce = { "renderer-loss" },
            )

            assertTrue(adapter.write(token(), byteArrayOf(1)) { completion.complete(it) })
            val barrier = adapter.fenceAttachment()
            assertFalse(barrier.isDrained)
            platformCompletion(false)
            withTimeout(5_000) { barrier.awaitDrained() }

            assertFalse(completion.await())
            assertTrue(barrier.isDrained)
        }

    @Test
    fun `renderer loss fences aborts drains then releases its WebView generation`() = runBlocking {
        val completion = CompletableDeferred<Boolean>()
        lateinit var platformCompletion: (Boolean) -> Unit
        val adapter = RelayV2TerminalWebViewParserAdapter(
            callbackScope = CoroutineScope(coroutineContext),
            writePort = RelayV2TerminalWebViewWritePort { _, _, callback ->
                platformCompletion = callback
                true
            },
            resetPort = RelayV2TerminalWebViewResetPort { _, _ -> false },
            newCallbackNonce = { "renderer-loss-order" },
        )
        val owner = TerminalWebViewOwnership()
        val deadView = Any()
        assertTrue(owner.bind(deadView))
        assertTrue(adapter.write(token(), byteArrayOf(1)) { completion.complete(it) })
        val loss = requireNotNull(
            owner.beginViewLoss(
                view = deadView,
                kind = TerminalWebViewLossKind.RENDERER_GONE,
                didCrash = true,
                allowAutomaticRebuild = true,
                settleParserFailure = { platformCompletion(false) },
            ),
        )

        val barrier = adapter.fenceAttachment()
        assertFalse(barrier.isDrained)
        assertTrue(loss.abortParserMutationBeforeAttachmentDetach())
        withTimeout(5_000) { barrier.awaitDrained() }
        assertFalse(completion.await())
        assertTrue(loss.completeAfterAttachmentDetach())
        assertEquals(1L, owner.rebuildGeneration.value)
    }

    @Test
    fun `attachment fence rejects new callbacks and drains an admitted completion`() = runBlocking {
        val completionEntered = CompletableDeferred<Unit>()
        val releaseCompletion = CompletableDeferred<Unit>()
        val completionSettled = CompletableDeferred<Boolean>()
        lateinit var platformCompletion: (Boolean) -> Unit
        val adapter = RelayV2TerminalWebViewParserAdapter(
            callbackScope = CoroutineScope(coroutineContext),
            writePort = RelayV2TerminalWebViewWritePort { _, _, callback ->
                platformCompletion = callback
                true
            },
            resetPort = RelayV2TerminalWebViewResetPort { _, _ -> false },
            newCallbackNonce = { "drain" },
        )

        assertTrue(
            adapter.write(token(), byteArrayOf(1)) {
                completionEntered.complete(Unit)
                releaseCompletion.await()
                completionSettled.complete(it)
            },
        )
        platformCompletion(false)
        completionEntered.await()

        val barrier = adapter.fenceAttachment()
        assertFalse(barrier.isDrained)
        assertFalse(adapter.write(token(), byteArrayOf(2)) { Unit })

        releaseCompletion.complete(Unit)
        barrier.awaitDrained()
        assertTrue(barrier.isDrained)
        assertFalse(completionSettled.await())
    }

    @Test
    fun `fence waits for an in progress platform registration decision`() = runBlocking {
        val registrationEntered = CountDownLatch(1)
        val releaseRegistration = CountDownLatch(1)
        val adapter = RelayV2TerminalWebViewParserAdapter(
            callbackScope = CoroutineScope(coroutineContext),
            writePort = RelayV2TerminalWebViewWritePort { _, _, _ ->
                registrationEntered.countDown()
                check(releaseRegistration.await(5, TimeUnit.SECONDS))
                false
            },
            resetPort = RelayV2TerminalWebViewResetPort { _, _ -> false },
            newCallbackNonce = { "registering" },
        )
        val registration = async(Dispatchers.Default) {
            adapter.write(token(), byteArrayOf(1)) { Unit }
        }
        assertTrue(registrationEntered.await(5, TimeUnit.SECONDS))

        val barrier = adapter.fenceAttachment()
        assertFalse(barrier.isDrained)
        releaseRegistration.countDown()

        assertFalse(registration.await())
        withTimeout(5_000) { barrier.awaitDrained() }
        assertTrue(barrier.isDrained)
    }

    @Test
    fun `rejected registration never settles a violating callback`() = runBlocking {
        val completion = CompletableDeferred<Boolean>()
        val adapter = RelayV2TerminalWebViewParserAdapter(
            callbackScope = CoroutineScope(coroutineContext),
            writePort = RelayV2TerminalWebViewWritePort { _, _, callback ->
                callback(true)
                false
            },
            resetPort = RelayV2TerminalWebViewResetPort { _, _ -> false },
            newCallbackNonce = { "rejected" },
        )

        assertFalse(adapter.write(token(), byteArrayOf(1)) { completion.complete(it) })
        assertFalse(completion.isCompleted)
        assertTrue(adapter.fenceAttachment().isDrained)
    }

    @Test
    fun `throwing platform registration releases its attachment lease`() = runBlocking {
        val adapter = RelayV2TerminalWebViewParserAdapter(
            callbackScope = CoroutineScope(coroutineContext),
            writePort = RelayV2TerminalWebViewWritePort { _, _, _ ->
                error("registration failed")
            },
            resetPort = RelayV2TerminalWebViewResetPort { _, _ -> false },
            newCallbackNonce = { "throws" },
        )

        val failure = runCatching {
            adapter.write(token(), byteArrayOf(1)) { Unit }
        }.exceptionOrNull()

        assertTrue(failure is IllegalStateException)
        assertTrue(adapter.fenceAttachment().isDrained)
    }

    private fun token(): RelayV2TerminalParserCallbackToken {
        val generation = RelayV2EffectGeneration("profile", 1, 1)
        val identity = RelayV2TerminalIdentity(
            profileId = "profile",
            profileActivationGeneration = 1,
            principalId = "principal",
            clientInstanceId = "client",
            hostId = "host",
            hostEpoch = "epoch",
            hostInstanceId = "host-instance",
            scopeId = "scope",
            sessionId = "session",
            streamId = "stream",
            generation = "terminal-generation",
            resumeTokenCredentialReference = "resume-reference",
            resumeTokenCredentialFingerprint = "resume-fingerprint",
        )
        return RelayV2TerminalParserCallbackToken(
            fence = RelayV2TerminalEffectFence(
                identity,
                RelayV2TerminalDeliveryToken(generation, 1, 1),
                RelayV2TerminalOpenAttempt("open", "open-fingerprint"),
            ),
            parserContinuityId = "parser",
            operationId = "operation",
            startOffset = "0",
            endOffset = "1",
        )
    }
}
