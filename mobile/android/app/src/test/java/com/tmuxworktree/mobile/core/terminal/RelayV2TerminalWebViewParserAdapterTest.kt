package com.tmuxworktree.mobile.core.terminal

import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2EffectGeneration
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalDeliveryToken
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffectFence
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalIdentity
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenAttempt
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserCallbackToken
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2TerminalWebViewParserAdapterTest {
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
    fun `detached parser attachment fences a late false callback without converting it to success`() =
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
            platformCompletion(false)
            barrier.awaitDrained()

            assertFalse(completion.isCompleted)
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
