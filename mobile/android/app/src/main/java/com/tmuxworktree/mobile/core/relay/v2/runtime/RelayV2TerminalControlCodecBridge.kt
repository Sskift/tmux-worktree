package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2Codec
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2WebSocketChannel
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalControlDispatchClaim
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalControlDispatchClaimPhase
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffect
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenMode
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalOpenTarget
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResumeCredentialOwner
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalResumeCredentialStore
import java.security.MessageDigest
import java.util.Base64

/** Result of the terminal-owned generation check plus its sole synchronous transport attempt. */
internal sealed interface RelayV2TerminalExactGenerationSendResult {
    data object Sent : RelayV2TerminalExactGenerationSendResult
    data object NotSent : RelayV2TerminalExactGenerationSendResult
    data object Stale : RelayV2TerminalExactGenerationSendResult
}

/**
 * Narrow terminal sender implemented by the actor that already owns apply leases and transport.
 * Stale proves that the actor attempted no transport send for the supplied frame.
 */
internal fun interface RelayV2TerminalExactGenerationSendPort {
    fun sendTerminalIfCurrent(
        authority: RelayV2RepositoryEffectAuthority,
        canonicalWireBytes: ByteArray,
    ): RelayV2TerminalExactGenerationSendResult
}

/** Fixed, detail-free failure used for every possibly attempted terminal control dispatch. */
internal class RelayV2TerminalControlDispatchException private constructor() :
    RuntimeException(MESSAGE, null, false, false) {
    companion object {
        const val MESSAGE = "Relay v2 terminal control dispatch is uncertain"

        fun redacted(): RelayV2TerminalControlDispatchException =
            RelayV2TerminalControlDispatchException()
    }
}

/**
 * Stateless strict-codec bridge for the default-off terminal.input/terminal.resize slice.
 * It neither owns nor reconstructs repository authority, dispatch leases, or transport state.
 */
internal class RelayV2TerminalControlCodecBridge(
    private val sendPort: RelayV2TerminalExactGenerationSendPort,
    private val codec: RelayV2Codec = RelayV2Codec(),
) : RelayV2TerminalControlTransportPort {
    override fun sendInput(
        authority: RelayV2RepositoryEffectAuthority,
        effect: RelayV2TerminalEffect.SendInput,
        claim: RelayV2TerminalControlDispatchClaim.Input,
    ): Boolean = dispatch(authority) {
        requireExactInput(effect, claim)
        linkedMapOf(
            "protocolVersion" to 2L,
            "kind" to "event",
            "type" to "terminal.input",
            "streamId" to effect.fence.identity.streamId,
            "payload" to linkedMapOf(
                "generation" to claim.generation,
                "inputSeq" to claim.inputSeq,
                "encoding" to "base64",
                "data" to Base64.getEncoder().encodeToString(claim.bytes.copyBytes()),
            ),
        )
    }

    override fun sendResize(
        authority: RelayV2RepositoryEffectAuthority,
        effect: RelayV2TerminalEffect.SendResize,
        claim: RelayV2TerminalControlDispatchClaim.Resize,
    ): Boolean = dispatch(authority) {
        requireExactResize(effect, claim)
        linkedMapOf(
            "protocolVersion" to 2L,
            "kind" to "event",
            "type" to "terminal.resize",
            "streamId" to effect.fence.identity.streamId,
            "payload" to linkedMapOf(
                "generation" to claim.generation,
                "resizeSeq" to claim.resizeSeq,
                "cols" to claim.cols.toLong(),
                "rows" to claim.rows.toLong(),
            ),
        )
    }

    fun sendCommittedEffect(
        authority: RelayV2RepositoryEffectAuthority,
        effect: RelayV2TerminalEffect,
        credentials: RelayV2TerminalResumeCredentialStore,
    ): RelayV2TerminalExactGenerationSendResult = dispatchExact(authority) {
        when (effect) {
            is RelayV2TerminalEffect.SendOpen -> effect.openFrame(credentials)
            is RelayV2TerminalEffect.OutputAck -> linkedMapOf(
                "protocolVersion" to 2L,
                "kind" to "event",
                "type" to "terminal.output_ack",
                "streamId" to effect.fence.identity.streamId,
                "payload" to linkedMapOf(
                    "generation" to effect.generation,
                    "nextOffset" to effect.nextOffset,
                ),
            )
            is RelayV2TerminalEffect.RequestReplay -> linkedMapOf(
                "protocolVersion" to 2L,
                "kind" to "request",
                "type" to "terminal.replay_request",
                "requestId" to effect.requestId,
                "hostId" to effect.fence.identity.hostId,
                "expectedHostEpoch" to effect.fence.identity.hostEpoch,
                "scopeId" to effect.fence.identity.scopeId,
                "sessionId" to effect.fence.identity.sessionId,
                "streamId" to effect.fence.identity.streamId,
                "payload" to linkedMapOf(
                    "generation" to effect.generation,
                    "fromOffset" to effect.fromOffset,
                ),
            )
            is RelayV2TerminalEffect.SendClose -> {
                val token = credentials.readExact(
                    effect.fence.identity.target(),
                    effect.resumeTokenCredentialReference,
                    effect.fence.identity.resumeTokenCredentialFingerprint,
                )
                linkedMapOf(
                    "protocolVersion" to 2L,
                    "kind" to "request",
                    "type" to "terminal.close",
                    "requestId" to effect.requestId,
                    "hostId" to effect.fence.identity.hostId,
                    "expectedHostEpoch" to effect.fence.identity.hostEpoch,
                    "scopeId" to effect.fence.identity.scopeId,
                    "sessionId" to effect.fence.identity.sessionId,
                    "streamId" to effect.fence.identity.streamId,
                    "payload" to linkedMapOf(
                        "closeId" to effect.closeId,
                        "generation" to effect.generation,
                        "resumeToken" to token,
                    ),
                )
            }
            else -> error("Terminal effect has no direct wire representation")
        }
    }

    private fun dispatch(
        authority: RelayV2RepositoryEffectAuthority,
        frame: () -> Map<String, Any?>,
    ): Boolean = try {
        when (dispatchExact(authority, frame)) {
            RelayV2TerminalExactGenerationSendResult.Sent -> true
            RelayV2TerminalExactGenerationSendResult.Stale -> false
            RelayV2TerminalExactGenerationSendResult.NotSent ->
                throw RelayV2TerminalControlDispatchException.redacted()
        }
    } catch (_: Exception) {
        throw RelayV2TerminalControlDispatchException.redacted()
    }

    private fun dispatchExact(
        authority: RelayV2RepositoryEffectAuthority,
        frame: () -> Map<String, Any?>,
    ): RelayV2TerminalExactGenerationSendResult {
        val canonicalWireBytes = codec.encodeWebSocketFrame(
            RelayV2WebSocketChannel.PUBLIC,
            frame(),
        )
        return sendPort.sendTerminalIfCurrent(authority, canonicalWireBytes)
    }

    private fun RelayV2TerminalEffect.SendOpen.openFrame(
        credentials: RelayV2TerminalResumeCredentialStore,
    ): Map<String, Any?> {
        val payload = linkedMapOf<String, Any?>(
            "openId" to openFence.openAttempt.openId,
            "pane" to openFence.target.pane.toLong(),
            "cols" to cols.toLong(),
            "rows" to rows.toLong(),
            "mode" to mode.name.lowercase(),
        )
        when (mode) {
            RelayV2TerminalOpenMode.NEW -> check(resume == null)
            RelayV2TerminalOpenMode.RESUME,
            RelayV2TerminalOpenMode.RESET,
            -> {
                val exactResume = requireNotNull(resume)
                val token = credentials.readExact(
                    openFence.target,
                    exactResume.resumeTokenCredentialReference,
                    exactResume.resumeTokenCredentialFingerprint,
                )
                val encoded = linkedMapOf<String, Any?>(
                    "generation" to exactResume.generation,
                )
                when (mode) {
                    RelayV2TerminalOpenMode.RESUME ->
                        encoded["nextOffset"] = requireNotNull(exactResume.nextOffset)
                    RelayV2TerminalOpenMode.RESET -> check(exactResume.nextOffset == null)
                    RelayV2TerminalOpenMode.NEW -> error("unreachable")
                }
                encoded["resumeToken"] = token
                payload["resume"] = encoded
            }
        }
        return linkedMapOf(
            "protocolVersion" to 2L,
            "kind" to "request",
            "type" to "terminal.open",
            "requestId" to requestId,
            "hostId" to openFence.target.hostId,
            "expectedHostEpoch" to openFence.target.hostEpoch,
            "scopeId" to openFence.target.scopeId,
            "sessionId" to openFence.target.sessionId,
            "streamId" to openFence.target.streamId,
            "payload" to payload,
        )
    }

    private fun RelayV2TerminalResumeCredentialStore.readExact(
        target: RelayV2TerminalOpenTarget,
        reference: String,
        expectedFingerprint: String,
    ): String {
        val token = read(
            RelayV2TerminalResumeCredentialOwner(
                target.profileId,
                target.profileActivationGeneration,
            ),
            reference,
        ) ?: error("Terminal resume credential is unavailable")
        val actualFingerprint = Base64.getUrlEncoder().withoutPadding().encodeToString(
            MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8)),
        )
        check(MessageDigest.isEqual(
            actualFingerprint.toByteArray(Charsets.UTF_8),
            expectedFingerprint.toByteArray(Charsets.UTF_8),
        )) { "Terminal resume credential identity conflicted" }
        return token
    }

    private fun requireExactInput(
        effect: RelayV2TerminalEffect.SendInput,
        claim: RelayV2TerminalControlDispatchClaim.Input,
    ) {
        check(claim.phase == RelayV2TerminalControlDispatchClaimPhase.CLAIMED)
        check(effect.dispatchLease == claim.dispatchLease)
        check(effect.fence == effect.dispatchLease.fence)
        check(effect.generation == claim.generation)
        check(effect.inputSeq == claim.inputSeq)
        check(effect.bytes == claim.bytes)
    }

    private fun requireExactResize(
        effect: RelayV2TerminalEffect.SendResize,
        claim: RelayV2TerminalControlDispatchClaim.Resize,
    ) {
        check(claim.phase == RelayV2TerminalControlDispatchClaimPhase.CLAIMED)
        check(effect.dispatchLease == claim.dispatchLease)
        check(effect.fence == effect.dispatchLease.fence)
        check(effect.generation == claim.generation)
        check(effect.resizeSeq == claim.resizeSeq)
        check(effect.cols == claim.cols)
        check(effect.rows == claim.rows)
    }
}
