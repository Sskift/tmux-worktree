package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2DecodedMessage
import com.tmuxworktree.mobile.core.relay.v2.codec.RelayV2FrameMetadata
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile
import java.math.BigInteger

internal data class RelayV2ResumeCursor(
    val hostEpoch: String,
    val lastEventSeq: String,
) {
    init {
        require(hostEpoch.isNotBlank()) { "Host epoch is required" }
        require(hostEpoch.toByteArray(Charsets.UTF_8).size <= 128) { "Host epoch is too long" }
        require(COUNTER_PATTERN.matches(lastEventSeq)) { "Event sequence is not canonical" }
        require(BigInteger(lastEventSeq) <= UNSIGNED_COUNTER_MAX) { "Event sequence is too large" }
    }

    private companion object {
        val COUNTER_PATTERN = Regex("^(?:0|[1-9][0-9]*)$")
        val UNSIGNED_COUNTER_MAX = BigInteger("18446744073709551615")
    }
}

internal enum class RelayV2ConnectionPhase {
    STOPPED,
    CONNECTING,
    AWAITING_RELAY_WELCOME,
    AWAITING_HOST_WELCOME,
    QUERYING,
    RESYNCING,
    CONTINUITY_REJECTED,
    FAILED,
    DISCONNECTED,
    CLOSED,
}

internal enum class RelayV2FailureKind {
    CONFIGURATION,
    SECURITY,
    AUTH,
    DIALECT,
    SCHEMA,
    CAPABILITY,
    TRANSPORT,
    ROUTE,
    QUEUE_SATURATED,
}

internal data class RelayV2ConnectionFailure(
    val kind: RelayV2FailureKind,
    val code: String,
    val retryable: Boolean,
)

internal data class RelayV2ConnectionState(
    val phase: RelayV2ConnectionPhase = RelayV2ConnectionPhase.STOPPED,
    val profileId: String? = null,
    val activationGeneration: Long? = null,
    val connectionGeneration: Long = 0,
    val changedAtMs: Long = 0,
    val failure: RelayV2ConnectionFailure? = null,
) {
    /**
     * Non-atomic generation prefilter only. This deliberately has no phase authority: for example,
     * a current [RelayV2RuntimeEffect.RejectContinuity] remains eligible in CONTINUITY_REJECTED.
     * A true result never authorizes repository or Room mutation; consumers must commit inside
     * [RelayV2ConnectionActor.withEffectApplyLease].
     */
    fun matchesGeneration(generation: RelayV2EffectGeneration): Boolean =
        profileId == generation.profileId &&
            activationGeneration == generation.profileGeneration &&
            connectionGeneration == generation.connectionGeneration
}

/**
 * Identity fence for repository-visible effects.
 *
 * Profile activation and socket generations are deliberately independent: a reconnect must fence
 * callbacks from its prior socket, while a profile switch must also fence work from the prior
 * credential/cache namespace.
 */
internal data class RelayV2EffectGeneration(
    val profileId: String,
    val profileGeneration: Long,
    val connectionGeneration: Long,
)

/** Result of entering the actor-owned repository apply gate. */
internal sealed interface RelayV2EffectApplyResult<out T> {
    data class Applied<T>(val value: T) : RelayV2EffectApplyResult<T>
    data object Stale : RelayV2EffectApplyResult<Nothing>
}

internal enum class RelayV2HelloOutcome {
    FRESH,
    MATCHED,
    CURSOR_BEHIND,
    HOST_EPOCH_CHANGED,
    EVENT_CURSOR_AHEAD,
}

internal data class RelayV2CommandDedupeWindow(
    val windowId: String,
    val windowSeq: String,
    val acceptUntilMs: Long,
    val queryUntilMs: Long,
)

/** Frozen first-slice limits after taking the safe client/broker/host intersection. */
internal data class RelayV2NegotiatedLimits(
    val maxPublicFrameBytes: Long,
    val maxCarrierFrameBytes: Long,
    val routeBufferedBytesPerDirection: Long,
    val routeLowWaterBytesPerDirection: Long,
    val maxQueuedRouteFrames: Long,
    val maxInFlightRequestsPerRoute: Long,
    val maxCommandQueryIds: Long,
    val stateSnapshotChunkBytes: Long,
    val stateSnapshotChunkRecords: Long,
    val stateSnapshotMaxBytes: Long,
    val stateSnapshotMaxRecords: Long,
    val terminalReplayBytesPerStream: Long,
    val terminalReplayBytesPerHost: Long,
    val terminalMaxUnackedBytes: Long,
    val terminalMaxFrameBytes: Long,
    val frozenHostLimits: Map<String, Long>,
)

internal data class RelayV2HandshakeContext(
    val profile: RelayActiveProfileIdentity,
    val hostId: String,
    val brokerEpoch: String,
    val hostEpoch: String,
    val hostInstanceId: String,
    val eventSeq: String,
    val negotiatedCapabilities: Set<String>,
    val negotiatedLimits: RelayV2NegotiatedLimits,
    val commandDedupeWindow: RelayV2CommandDedupeWindow,
)

/** Explicit repository-facing consequences of the v2 hello barrier. */
internal sealed interface RelayV2RuntimeEffect {
    sealed interface GenerationScoped : RelayV2RuntimeEffect {
        val generation: RelayV2EffectGeneration
    }

    data class QueryPendingCommands(
        val context: RelayV2HandshakeContext,
        override val generation: RelayV2EffectGeneration,
        val outcome: RelayV2HelloOutcome = RelayV2HelloOutcome.MATCHED,
    ) : GenerationScoped

    data class BeginStateResync(
        val context: RelayV2HandshakeContext,
        override val generation: RelayV2EffectGeneration,
        val outcome: RelayV2HelloOutcome,
        val discardPriorResourceLineage: Boolean,
        val queryPendingCommandsAfterResync: Boolean = true,
    ) : GenerationScoped

    data class RejectContinuity(
        val profile: RelayActiveProfileIdentity,
        override val generation: RelayV2EffectGeneration,
        val hostId: String,
        val hostEpoch: String,
        val clientLastEventSeq: String,
        val hostEventSeq: String,
        val outcome: RelayV2HelloOutcome = RelayV2HelloOutcome.EVENT_CURSOR_AHEAD,
    ) : GenerationScoped

    /** Bounded handoff seam for repository-owned post-handshake protocol state. */
    data class DeliverPostHandshakeFrame(
        val message: RelayV2DecodedMessage,
        override val generation: RelayV2EffectGeneration,
    ) : GenerationScoped

    data class ConnectionFailed(
        val profile: RelayActiveProfileIdentity?,
        val generation: RelayV2EffectGeneration?,
        val failure: RelayV2ConnectionFailure,
    ) : RelayV2RuntimeEffect

    data class ConnectRejected(
        val requestedProfile: RelayActiveProfileIdentity,
        val failure: RelayV2ConnectionFailure,
    ) : RelayV2RuntimeEffect

    data class Disconnected(
        val profile: RelayActiveProfileIdentity,
        val barrierId: String,
        val fencedGeneration: RelayV2EffectGeneration?,
        val barrierConnectionGeneration: Long,
    ) : RelayV2RuntimeEffect
}

/**
 * Sensitive access material crosses only this injected transport boundary. The request deliberately
 * has a redacted string representation and can offer exactly one v2 subprotocol.
 */
internal data class RelayV2TransportOpenRequest(
    val relayUrl: String,
    val offeredSubprotocols: List<String>,
    val accessToken: String,
) {
    init {
        require(offeredSubprotocols == listOf(RelayV2Profile.RELAY_V2_SUBPROTOCOL)) {
            "Relay v2 transport must offer only tw-relay.v2"
        }
        require(accessToken.startsWith("twcap2.") &&
            accessToken.length <= 8_192 &&
            accessToken.all { it.code in 0x21..0x7e }
        ) {
            "Relay v2 access credential is invalid"
        }
    }

    override fun toString(): String =
        "RelayV2TransportOpenRequest(relayUrl=<redacted>, " +
            "offeredSubprotocols=$offeredSubprotocols, accessToken=<redacted>)"
}

internal enum class RelayV2TransportFailureKind {
    NETWORK,
    UPGRADE,
    PROTOCOL,
    TLS_VALIDATION,
}

internal data class RelayV2TransportFailure(
    val kind: RelayV2TransportFailureKind,
    val httpStatus: Int? = null,
)

internal interface RelayV2Transport {
    fun send(bytes: ByteArray): Boolean
    fun close(code: Int, reason: String)
    fun cancel()
}

internal interface RelayV2TransportListener {
    fun onOpen(source: RelayV2Transport, selectedSubprotocol: String?)

    fun onFrame(
        source: RelayV2Transport,
        bytes: ByteArray,
        metadata: RelayV2FrameMetadata = RelayV2FrameMetadata(),
    )

    fun onClosed(source: RelayV2Transport, code: Int)
    fun onFailure(source: RelayV2Transport, failure: RelayV2TransportFailure)
}

internal fun interface RelayV2TransportFactory {
    fun open(
        request: RelayV2TransportOpenRequest,
        listener: RelayV2TransportListener,
    ): RelayV2Transport
}
