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
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2TerminalWebViewParserAdapterTest {
    @Test
    fun `registration returns before an early platform callback can settle`() = runBlocking {
        val completion = CompletableDeferred<Boolean>()
        val registrationReturned = AtomicBoolean(false)
        var capturedId = ""
        var capturedBytes = byteArrayOf()
        val adapter = RelayV2TerminalWebViewParserAdapter(
            callbackScope = CoroutineScope(coroutineContext),
            writePort = RelayV2TerminalWebViewWritePort { callbackId, bytes, callback ->
                capturedId = callbackId
                capturedBytes = bytes.copyOf()
                callback(true)
                assertFalse(completion.isCompleted)
                true
            },
            resetPort = RelayV2TerminalWebViewResetPort { _, _ -> false },
            newCallbackNonce = { "nonce" },
        )

        val accepted = adapter.write(token(), byteArrayOf(0, 0x7f, -1)) {
            assertTrue(registrationReturned.get())
            completion.complete(it)
        }
        registrationReturned.set(true)

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
