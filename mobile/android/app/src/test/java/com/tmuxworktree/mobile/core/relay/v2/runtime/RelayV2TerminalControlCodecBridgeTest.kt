package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2CodecException
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2WebSocketChannel
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalBytes
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalControlDispatchClaim
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalControlDispatchLease
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalDeliveryToken
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffect
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffectFence
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalIdentity
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenAttempt
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenFence
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenMode
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenResume
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenTarget
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResumeCredentialInstall
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResumeCredentialOwner
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResumeCredentialStore
import java.security.MessageDigest
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayV2TerminalControlCodecBridgeTest {
    @Test
    fun `terminal open modes encode exact resume shapes and schema rejects cross-mode offsets`() {
        val sender = CapturingSender()
        val bridge = RelayV2TerminalControlCodecBridge(sender)
        val fixture = fixture()
        val reference = "credential-reference-open"
        val token = "opaque-resume-token"
        val credentialFingerprint = fingerprint(token)
        val credentials = ExactCredentialStore(
            RelayV2TerminalResumeCredentialOwner(PROFILE_ID, 7),
            reference,
            token,
        )
        val target = RelayV2TerminalOpenTarget(
            PROFILE_ID,
            7,
            PRINCIPAL_ID,
            CLIENT_ID,
            HOST_ID,
            HOST_EPOCH,
            "scope-local",
            "session-1",
            STREAM_ID,
            0,
        )
        val cases = listOf(
            OpenWireCase(RelayV2TerminalOpenMode.NEW, null, null),
            OpenWireCase(
                RelayV2TerminalOpenMode.RESUME,
                RelayV2TerminalOpenResume(
                    TERMINAL_GENERATION,
                    "12",
                    reference,
                    credentialFingerprint,
                ),
                setOf("generation", "nextOffset", "resumeToken"),
            ),
            OpenWireCase(
                RelayV2TerminalOpenMode.RESET,
                RelayV2TerminalOpenResume(
                    TERMINAL_GENERATION,
                    null,
                    reference,
                    credentialFingerprint,
                ),
                setOf("generation", "resumeToken"),
            ),
        )

        cases.forEachIndexed { index, case ->
            val attempt = RelayV2TerminalOpenAttempt(
                "open-wire-${index + 1}",
                "open-wire-fingerprint-${index + 1}",
            )
            val openFence = RelayV2TerminalOpenFence(
                target,
                RelayV2TerminalDeliveryToken(fixture.authority.generation, 3, index + 1L),
                attempt,
                "parser-continuity-1",
                case.mode,
                120,
                36,
                case.resume,
            )
            val result = bridge.sendCommittedEffect(
                fixture.authority,
                RelayV2TerminalEffect.SendOpen(
                    openFence,
                    "open-wire-request-${index + 1}",
                    case.mode,
                    120,
                    36,
                    case.resume,
                ),
                credentials,
            )

            assertSame(RelayV2TerminalExactGenerationSendResult.Sent, result)
            val frame = decode(sender.calls.last().bytes)
            val payload = objectValue(frame, "payload")
            assertEquals(case.mode.name.lowercase(), payload["mode"])
            if (case.expectedResumeKeys == null) {
                assertFalse(payload.containsKey("resume"))
            } else {
                val encodedResume = objectValue(payload, "resume")
                assertEquals(case.expectedResumeKeys, encodedResume.keys)
                assertEquals(token, encodedResume["resumeToken"])
                val invalidResume = when (case.mode) {
                    RelayV2TerminalOpenMode.RESUME -> encodedResume - "nextOffset"
                    RelayV2TerminalOpenMode.RESET ->
                        encodedResume + ("nextOffset" to "12")
                    RelayV2TerminalOpenMode.NEW -> error("NEW has no resume object")
                }
                val invalidFrame = frame +
                    ("payload" to (payload + ("resume" to invalidResume)))
                val failure = runCatching {
                    RelayV2Codec().encodeWebSocketFrame(
                        RelayV2WebSocketChannel.PUBLIC,
                        invalidFrame,
                    )
                }.exceptionOrNull()
                assertTrue(failure is RelayV2CodecException)
            }
        }
    }

    @Test
    fun `exact input and resize claims encode frozen public frames with original authority`() {
        val sender = CapturingSender()
        val bridge = RelayV2TerminalControlCodecBridge(sender)
        val fixture = fixture()

        assertTrue(bridge.sendInput(fixture.authority, fixture.inputEffect, fixture.inputClaim))
        assertTrue(bridge.sendResize(fixture.authority, fixture.resizeEffect, fixture.resizeClaim))

        assertEquals(2, sender.calls.size)
        assertSame(fixture.authority, sender.calls[0].authority)
        assertSame(fixture.authority, sender.calls[1].authority)
        assertEquals(
            linkedMapOf(
                "protocolVersion" to 2L,
                "kind" to "event",
                "type" to "terminal.input",
                "streamId" to STREAM_ID,
                "payload" to linkedMapOf(
                    "generation" to TERMINAL_GENERATION,
                    "inputSeq" to "1",
                    "encoding" to "base64",
                    "data" to "bHMK",
                ),
            ),
            decode(sender.calls[0].bytes),
        )
        assertEquals(
            linkedMapOf(
                "protocolVersion" to 2L,
                "kind" to "event",
                "type" to "terminal.resize",
                "streamId" to STREAM_ID,
                "payload" to linkedMapOf(
                    "generation" to TERMINAL_GENERATION,
                    "resizeSeq" to "1",
                    "cols" to 132L,
                    "rows" to 40L,
                ),
            ),
            decode(sender.calls[1].bytes),
        )
    }

    @Test
    fun `stale is safe false while not sent and throws are redacted uncertainty`() {
        val sender = CapturingSender(RelayV2TerminalExactGenerationSendResult.Stale)
        val bridge = RelayV2TerminalControlCodecBridge(sender)
        val fixture = fixture()

        assertFalse(bridge.sendInput(fixture.authority, fixture.inputEffect, fixture.inputClaim))

        sender.result = RelayV2TerminalExactGenerationSendResult.NotSent
        assertRedacted {
            bridge.sendResize(fixture.authority, fixture.resizeEffect, fixture.resizeClaim)
        }

        sender.result = RelayV2TerminalExactGenerationSendResult.Sent
        sender.failure = IllegalStateException("sensitive transport detail")
        assertRedacted {
            bridge.sendInput(fixture.authority, fixture.inputEffect, fixture.inputClaim)
        }
        assertEquals(3, sender.calls.size)
    }

    @Test
    fun `mismatched effect and durable claim fail closed before sender`() {
        val sender = CapturingSender()
        val bridge = RelayV2TerminalControlCodecBridge(sender)
        val fixture = fixture()

        assertRedacted {
            bridge.sendInput(
                fixture.authority,
                fixture.inputEffect,
                fixture.inputClaim.copy(inputSeq = "2"),
            )
        }

        assertTrue(sender.calls.isEmpty())
    }

    private fun decode(bytes: ByteArray): Map<String, Any?> =
        RelayV2Codec().decodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            bytes,
        ).frame

    private fun objectValue(value: Map<*, *>, key: String): Map<String, Any?> =
        (value[key] as Map<*, *>).entries.associate { (nestedKey, nestedValue) ->
            require(nestedKey is String)
            nestedKey to nestedValue
        }

    private fun assertRedacted(block: () -> Unit) {
        val failure = runCatching(block).exceptionOrNull()
        assertTrue(failure is RelayV2TerminalControlDispatchException)
        assertEquals(RelayV2TerminalControlDispatchException.MESSAGE, failure?.message)
        assertNull(failure?.cause)
        assertFalse(failure.toString().contains("sensitive transport detail"))
    }

    private data class Fixture(
        val authority: RelayV2RepositoryEffectAuthority,
        val inputEffect: RelayV2TerminalEffect.SendInput,
        val inputClaim: RelayV2TerminalControlDispatchClaim.Input,
        val resizeEffect: RelayV2TerminalEffect.SendResize,
        val resizeClaim: RelayV2TerminalControlDispatchClaim.Resize,
    )

    private data class OpenWireCase(
        val mode: RelayV2TerminalOpenMode,
        val resume: RelayV2TerminalOpenResume?,
        val expectedResumeKeys: Set<String>?,
    )

    private class ExactCredentialStore(
        private val owner: RelayV2TerminalResumeCredentialOwner,
        private val reference: String,
        private val token: String,
    ) : RelayV2TerminalResumeCredentialStore {
        override fun installExact(
            owner: RelayV2TerminalResumeCredentialOwner,
            reference: String,
            resumeToken: String,
        ): RelayV2TerminalResumeCredentialInstall? = error("unexpected credential install")

        override fun read(
            owner: RelayV2TerminalResumeCredentialOwner,
            reference: String,
        ): String? = token.takeIf { owner == this.owner && reference == this.reference }

        override fun clear(owner: RelayV2TerminalResumeCredentialOwner, reference: String) =
            error("unexpected credential clear")

        override fun clearProfile(profileId: String, throughActivationGeneration: Long) =
            error("unexpected profile clear")
    }

    private fun fixture(): Fixture {
        val actorGeneration = RelayV2EffectGeneration(PROFILE_ID, 7, 11)
        val identity = RelayV2TerminalIdentity(
            profileId = PROFILE_ID,
            profileActivationGeneration = 7,
            principalId = PRINCIPAL_ID,
            clientInstanceId = CLIENT_ID,
            hostId = HOST_ID,
            hostEpoch = HOST_EPOCH,
            hostInstanceId = "host-instance-1",
            scopeId = "scope-local",
            sessionId = "session-1",
            streamId = STREAM_ID,
            generation = TERMINAL_GENERATION,
            resumeTokenCredentialReference = "credential-reference-1",
            resumeTokenCredentialFingerprint = "credential-fingerprint-1",
        )
        val fence = RelayV2TerminalEffectFence(
            identity = identity,
            deliveryToken = RelayV2TerminalDeliveryToken(actorGeneration, 3, 5),
            openAttempt = RelayV2TerminalOpenAttempt("open-1", "open-fingerprint-1"),
        )
        val lease = RelayV2TerminalControlDispatchLease(fence)
        val inputBytes = RelayV2TerminalBytes.utf8("ls\n")
        val inputEffect = RelayV2TerminalEffect.SendInput(
            dispatchLease = lease,
            generation = TERMINAL_GENERATION,
            inputSeq = "1",
            bytes = inputBytes,
        )
        val resizeEffect = RelayV2TerminalEffect.SendResize(
            dispatchLease = lease,
            generation = TERMINAL_GENERATION,
            resizeSeq = "1",
            cols = 132,
            rows = 40,
        )
        return Fixture(
            authority = RelayV2RepositoryEffectAuthority(
                generation = actorGeneration,
                profileId = PROFILE_ID,
                profileActivationGeneration = 7,
                principalId = PRINCIPAL_ID,
                clientInstanceId = CLIENT_ID,
                hostId = HOST_ID,
                hostEpoch = HOST_EPOCH,
            ),
            inputEffect = inputEffect,
            inputClaim = RelayV2TerminalControlDispatchClaim.Input(
                dispatchLease = lease,
                attemptId = "dispatch-input-1",
                generation = TERMINAL_GENERATION,
                inputSeq = "1",
                bytes = inputBytes,
            ),
            resizeEffect = resizeEffect,
            resizeClaim = RelayV2TerminalControlDispatchClaim.Resize(
                dispatchLease = lease,
                attemptId = "dispatch-resize-1",
                generation = TERMINAL_GENERATION,
                resizeSeq = "1",
                cols = 132,
                rows = 40,
            ),
        )
    }

    private data class SendCall(
        val authority: RelayV2RepositoryEffectAuthority,
        val bytes: ByteArray,
    )

    private class CapturingSender(
        var result: RelayV2TerminalExactGenerationSendResult =
            RelayV2TerminalExactGenerationSendResult.Sent,
    ) : RelayV2TerminalExactGenerationSendPort {
        val calls = mutableListOf<SendCall>()
        var failure: RuntimeException? = null

        override fun sendTerminalIfCurrent(
            authority: RelayV2RepositoryEffectAuthority,
            canonicalWireBytes: ByteArray,
        ): RelayV2TerminalExactGenerationSendResult {
            calls += SendCall(authority, canonicalWireBytes.copyOf())
            failure?.let { throw it }
            return result
        }
    }

    companion object {
        private const val PROFILE_ID = "profile-v2"
        private const val PRINCIPAL_ID = "principal-1"
        private const val CLIENT_ID = "client-1"
        private const val HOST_ID = "host-1"
        private const val HOST_EPOCH = "host-epoch-1"
        private const val STREAM_ID = "stream-1"
        private const val TERMINAL_GENERATION = "terminal-generation-1"

        private fun fingerprint(token: String): String =
            Base64.getUrlEncoder().withoutPadding().encodeToString(
                MessageDigest.getInstance("SHA-256").digest(token.toByteArray()),
            )
    }
}
