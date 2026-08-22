package com.tmuxworktree.mobile.core.session

/** Metadata that survives a physical transport Adapter without naming its protocol. */
data class MobileSessionFrameMetadata(
    val opcode: String = "text",
    val compressed: Boolean = false,
)

internal enum class MobileSessionTransportFailureKind {
    NETWORK,
    UPGRADE,
    PROTOCOL,
    TLS_VALIDATION,
}

internal data class MobileSessionTransportFailure(
    val kind: MobileSessionTransportFailureKind,
    val httpStatus: Int? = null,
)

/**
 * One physical path for a Mobile Session.
 *
 * Implementations own their socket and bounded write queue. They must serialize callbacks, use
 * this exact instance as the callback source, emit at most one terminal callback, and make
 * [awaitTermination] return only after all socket/worker resources have been fenced. Session
 * protocol, reconnect policy, and product state deliberately do not belong here.
 */
internal interface MobileSessionTransport {
    fun send(bytes: ByteArray): Boolean
    fun close(code: Int, reason: String)
    fun cancel()

    /** Returns false only when the Adapter's hard resource-fence deadline expires. */
    suspend fun awaitTermination(): Boolean
}

internal interface MobileSessionTransportListener {
    fun onOpen(source: MobileSessionTransport, selectedSubprotocol: String?)

    fun onFrame(
        source: MobileSessionTransport,
        bytes: ByteArray,
        metadata: MobileSessionFrameMetadata = MobileSessionFrameMetadata(),
    )

    fun onClosed(source: MobileSessionTransport, code: Int)
    fun onFailure(source: MobileSessionTransport, failure: MobileSessionTransportFailure)
}

/**
 * Replaceable physical-path seam. [Route] is Adapter-owned configuration: Relay can carry a WSS
 * route and credential while a direct-LAN Adapter can carry a paired endpoint. Everything above
 * this Interface sees the same [MobileSessionTransport].
 */
internal fun interface MobileSessionTransportAdapter<in Route> {
    fun open(
        route: Route,
        listener: MobileSessionTransportListener,
    ): MobileSessionTransport
}
