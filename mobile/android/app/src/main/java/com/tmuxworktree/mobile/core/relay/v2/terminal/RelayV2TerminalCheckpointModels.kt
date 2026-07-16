package com.tmuxworktree.mobile.core.relay.v2.terminal

/** Frozen and local bounds for the unwired Android terminal checkpoint core. */
internal object RelayV2TerminalCheckpointLimits {
    const val SCHEMA_VERSION = 1
    const val IDENTITY_VERSION = 1
    const val MAX_ID_UTF8_BYTES = 128
    const val MAX_CREDENTIAL_REFERENCE_UTF8_BYTES = 256
    const val MAX_FRAME_BYTES = 65_536
    const val MAX_PENDING_OUTPUT_BYTES = 524_288
    const val MAX_PENDING_OUTPUT_FRAMES = 128
    const val MAX_PENDING_INPUT_BYTES = 524_288
    const val MAX_INPUT_RECORDS = 512
    const val MAX_RESIZE_RECORDS = 256
    const val MAX_CHECKPOINT_BYTES = 2_097_152
}

/** Defensively copied raw terminal bytes. The backing array is never exposed. */
internal class RelayV2TerminalBytes private constructor(
    private val value: ByteArray,
) {
    val size: Int
        get() = value.size

    fun copyBytes(): ByteArray = value.copyOf()

    internal fun drop(count: Int): RelayV2TerminalBytes = of(value.copyOfRange(count, value.size))

    override fun equals(other: Any?): Boolean =
        other is RelayV2TerminalBytes && value.contentEquals(other.value)

    override fun hashCode(): Int = value.contentHashCode()

    override fun toString(): String = "RelayV2TerminalBytes(size=$size)"

    companion object {
        fun of(value: ByteArray): RelayV2TerminalBytes = RelayV2TerminalBytes(value.copyOf())

        fun utf8(value: String): RelayV2TerminalBytes = of(value.toByteArray(Charsets.UTF_8))
    }
}

/**
 * Complete durable identity for one parser timeline.
 *
 * [resumeTokenCredentialReference] is a non-secret credential-store reference. A resume token is
 * never persisted in this checkpoint.
 */
internal data class RelayV2TerminalIdentity(
    val identityVersion: Int = RelayV2TerminalCheckpointLimits.IDENTITY_VERSION,
    val profileId: String,
    val profileActivationGeneration: Long,
    val principalId: String,
    val clientInstanceId: String,
    val hostId: String,
    val hostEpoch: String,
    val hostInstanceId: String,
    val scopeId: String,
    val sessionId: String,
    val streamId: String,
    val generation: String,
    val openId: String,
    val closeId: String,
    val resumeTokenCredentialReference: String,
    val pane: Int = 0,
) {
    init {
        require(identityVersion == RelayV2TerminalCheckpointLimits.IDENTITY_VERSION)
        require(profileActivationGeneration > 0)
        listOf(
            profileId,
            principalId,
            clientInstanceId,
            hostId,
            hostEpoch,
            hostInstanceId,
            scopeId,
            sessionId,
            streamId,
            generation,
            openId,
            closeId,
        ).forEach(::requireTerminalId)
        require(resumeTokenCredentialReference.isNotBlank())
        require(
            resumeTokenCredentialReference.toByteArray(Charsets.UTF_8).size <=
                RelayV2TerminalCheckpointLimits.MAX_CREDENTIAL_REFERENCE_UTF8_BYTES,
        )
        require(pane >= 0)
    }

    fun binding(): RelayV2TerminalBinding = RelayV2TerminalBinding(hostInstanceId, generation)
}

/**
 * Ephemeral socket/effect-delivery fence. It is deliberately not part of terminal timeline
 * identity: a retained generation may explicitly rebind to a newer route without changing bytes.
 */
internal data class RelayV2TerminalDeliveryToken(
    val profileActivationGeneration: Long,
    val connectionGeneration: Long,
    val deliverySequence: Long,
    val routeId: String,
    val routeFence: String,
) {
    init {
        require(profileActivationGeneration > 0)
        require(connectionGeneration > 0)
        require(deliverySequence > 0)
        requireTerminalId(routeId)
        requireTerminalId(routeFence)
    }
}

/** The actor adapter must attach this resolved lineage to stream-scoped wire frames. */
internal data class RelayV2TerminalBinding(
    val hostInstanceId: String,
    val generation: String,
) {
    init {
        requireTerminalId(hostInstanceId)
        requireTerminalId(generation)
    }
}

internal data class RelayV2TerminalActionFence(
    val binding: RelayV2TerminalBinding,
    val deliveryToken: RelayV2TerminalDeliveryToken,
)

internal data class RelayV2TerminalEffectFence(
    val identity: RelayV2TerminalIdentity,
    val deliveryToken: RelayV2TerminalDeliveryToken,
)

/** Exact callback authority for one parser write or reset operation. */
internal data class RelayV2TerminalParserCallbackToken(
    val fence: RelayV2TerminalEffectFence,
    val parserContinuityId: String,
    val operationId: String,
    val startOffset: String,
    val endOffset: String,
)

internal enum class RelayV2TerminalPhase {
    LIVE,
    REPLAYING,
    REPLAY_REQUESTED,
    RESETTING_PARSER,
    CLOSED_WAITING_PARSER,
    FINALIZED,
    RESET_REQUIRED,
}

internal enum class RelayV2TerminalOpenDisposition {
    NEW,
    RESUMED,
    RESET,
}

internal enum class RelayV2TerminalResetReason {
    MISSING_CHECKPOINT,
    MISSING_REQUIRED_IDENTITY,
    SCHEMA_INCOMPATIBLE,
    IDENTITY_CHANGED,
    PARSER_CONTINUITY_LOST,
    CHECKPOINT_INVALID,
    CHECKPOINT_LIMIT_EXCEEDED,
    STREAM_LOST,
    GENERATION_STALE,
    OFFSET_EXPIRED,
    SLOW_CONSUMER,
    HOST_BUFFER_PRESSURE,
    PARSER_FAILURE,
    PROTOCOL_ORDER_CONFLICT,
}

internal enum class RelayV2TerminalCloseReason {
    CLIENT_CLOSED,
    BACKEND_EXIT,
    BACKEND_ERROR,
}

internal enum class RelayV2TerminalControlKind {
    INPUT,
    RESIZE,
}

internal enum class RelayV2TerminalControlDisposition {
    QUEUED,
    SENT,
}

internal enum class RelayV2TerminalControlError {
    GAP,
    CONFLICT,
}

internal data class RelayV2PendingParserWrite(
    val callbackToken: RelayV2TerminalParserCallbackToken,
    val bytes: RelayV2TerminalBytes,
)

internal data class RelayV2PendingInput(
    val generation: String,
    val inputSeq: String,
    val bytes: RelayV2TerminalBytes,
    val disposition: RelayV2TerminalControlDisposition,
)

internal data class RelayV2PendingResize(
    val generation: String,
    val resizeSeq: String,
    val cols: Int,
    val rows: Int,
    val disposition: RelayV2TerminalControlDisposition,
)

internal data class RelayV2AmbiguousInput(
    val generation: String,
    val inputSeq: String,
    val bytes: RelayV2TerminalBytes,
)

internal data class RelayV2TerminalClosedWatermark(
    val finalOffset: String,
    val replayAvailable: Boolean,
    val bufferStartOffset: String?,
    val reason: RelayV2TerminalCloseReason,
    val exitCode: Int?,
    val closeId: String?,
)

internal data class RelayV2TerminalPendingReplay(
    val requestId: String,
    val fence: RelayV2TerminalEffectFence,
    val fromOffset: String,
)

/**
 * Immutable, storage-shaped state. Adapters must atomically replace the whole value; no field is a
 * separately writable cursor.
 */
internal data class RelayV2TerminalCheckpoint(
    val schemaVersion: Int = RelayV2TerminalCheckpointLimits.SCHEMA_VERSION,
    val identity: RelayV2TerminalIdentity,
    val deliveryToken: RelayV2TerminalDeliveryToken,
    val parserContinuityId: String,
    val phase: RelayV2TerminalPhase,
    val openedCols: Int,
    val openedRows: Int,
    val parserAppliedNextOffset: String,
    val networkReceivedThrough: String,
    val nextParserOperationSeq: String,
    val nextReplayRequestSeq: String,
    val parserResetCallbackToken: RelayV2TerminalParserCallbackToken? = null,
    val parserInFlightCallbackToken: RelayV2TerminalParserCallbackToken? = null,
    val lastAppliedParserCallbackToken: RelayV2TerminalParserCallbackToken? = null,
    val pendingOutput: List<RelayV2PendingParserWrite> = emptyList(),
    val pendingReplay: RelayV2TerminalPendingReplay? = null,
    val replayTargetOffset: String? = null,
    val nextInputSeq: String = "1",
    val ackedThroughInputSeq: String = "0",
    val pendingInputs: List<RelayV2PendingInput> = emptyList(),
    val nextResizeSeq: String = "1",
    val ackedThroughResizeSeq: String = "0",
    val pendingResizes: List<RelayV2PendingResize> = emptyList(),
    val ambiguousInputs: List<RelayV2AmbiguousInput> = emptyList(),
    val closeRequested: Boolean = false,
    val closed: RelayV2TerminalClosedWatermark? = null,
    val resetReason: RelayV2TerminalResetReason? = null,
)

internal enum class RelayV2TerminalRestoreInvalidity {
    SCHEMA_INCOMPATIBLE,
    MISSING_REQUIRED_FIELD,
    MALFORMED_COUNTER,
    CORRUPT_QUEUE,
    LIMIT_EXCEEDED,
}

/** A storage adapter maps parse failures or absent columns to Invalid instead of inventing values. */
internal sealed interface RelayV2TerminalStoredCheckpoint {
    data class Present(val checkpoint: RelayV2TerminalCheckpoint) : RelayV2TerminalStoredCheckpoint

    data class Invalid(
        val reason: RelayV2TerminalRestoreInvalidity,
    ) : RelayV2TerminalStoredCheckpoint

    data object Missing : RelayV2TerminalStoredCheckpoint
}

internal sealed interface RelayV2TerminalAction {
    data class Opened(
        val identity: RelayV2TerminalIdentity,
        val deliveryToken: RelayV2TerminalDeliveryToken,
        val parserContinuityId: String,
        val disposition: RelayV2TerminalOpenDisposition,
        val cols: Int,
        val rows: Int,
        val replayFromOffset: String,
        val tailOffset: String,
    ) : RelayV2TerminalAction

    data class VerifyContinuity(
        val identity: RelayV2TerminalIdentity?,
        val deliveryToken: RelayV2TerminalDeliveryToken?,
        val parserContinuityId: String?,
    ) : RelayV2TerminalAction

    data class RebindDelivery(
        val identity: RelayV2TerminalIdentity,
        val currentDeliveryToken: RelayV2TerminalDeliveryToken,
        val newDeliveryToken: RelayV2TerminalDeliveryToken,
        val parserContinuityId: String,
    ) : RelayV2TerminalAction

    data class Output(
        val fence: RelayV2TerminalActionFence,
        val offset: String,
        val bytes: RelayV2TerminalBytes,
    ) : RelayV2TerminalAction

    data class ReplayStarted(
        val identity: RelayV2TerminalIdentity,
        val deliveryToken: RelayV2TerminalDeliveryToken,
        val requestId: String,
        val fromOffset: String,
        val tailOffsetAtStart: String,
    ) : RelayV2TerminalAction

    data class ParserApplied(
        val callbackToken: RelayV2TerminalParserCallbackToken,
    ) : RelayV2TerminalAction

    data class ParserFailed(
        val callbackToken: RelayV2TerminalParserCallbackToken,
    ) : RelayV2TerminalAction

    data class ParserResetApplied(
        val callbackToken: RelayV2TerminalParserCallbackToken,
    ) : RelayV2TerminalAction

    data class EnqueueInput(
        val deliveryToken: RelayV2TerminalDeliveryToken,
        val bytes: RelayV2TerminalBytes,
    ) : RelayV2TerminalAction

    data class InputSent(
        val fence: RelayV2TerminalActionFence,
        val inputSeq: String,
    ) : RelayV2TerminalAction

    data class InputAck(
        val fence: RelayV2TerminalActionFence,
        val ackedThroughInputSeq: String,
    ) : RelayV2TerminalAction

    data class InputError(
        val fence: RelayV2TerminalActionFence,
        val inputSeq: String,
        val ackedThroughInputSeq: String,
        val error: RelayV2TerminalControlError,
    ) : RelayV2TerminalAction

    data class EnqueueResize(
        val deliveryToken: RelayV2TerminalDeliveryToken,
        val cols: Int,
        val rows: Int,
    ) : RelayV2TerminalAction

    data class ResizeSent(
        val fence: RelayV2TerminalActionFence,
        val resizeSeq: String,
    ) : RelayV2TerminalAction

    data class ResizeAck(
        val fence: RelayV2TerminalActionFence,
        val ackedThroughResizeSeq: String,
    ) : RelayV2TerminalAction

    data class ResizeError(
        val fence: RelayV2TerminalActionFence,
        val resizeSeq: String,
        val ackedThroughResizeSeq: String,
        val error: RelayV2TerminalControlError,
    ) : RelayV2TerminalAction

    data class RetryUnackedControls(
        val deliveryToken: RelayV2TerminalDeliveryToken,
    ) : RelayV2TerminalAction

    data class RequestClose(
        val deliveryToken: RelayV2TerminalDeliveryToken,
    ) : RelayV2TerminalAction

    data class Closed(
        val fence: RelayV2TerminalActionFence,
        val finalOffset: String,
        val replayAvailable: Boolean,
        val bufferStartOffset: String?,
        val reason: RelayV2TerminalCloseReason,
        val exitCode: Int?,
        val closeId: String?,
    ) : RelayV2TerminalAction

    data class HostResetRequired(
        val fence: RelayV2TerminalActionFence,
        val reason: RelayV2TerminalResetReason,
        val requestedOffset: String?,
        val bufferStartOffset: String?,
        val tailOffset: String?,
    ) : RelayV2TerminalAction
}

internal enum class RelayV2TerminalEffectPriority {
    CONTROL,
    PARSER_OUTPUT,
}

/** Adapter seam only: no effect owns a WebView, xterm instance, socket, actor, or database. */
internal sealed interface RelayV2TerminalEffect {
    val priority: RelayV2TerminalEffectPriority
    val fence: RelayV2TerminalEffectFence?

    data class WriteParser(
        val callbackToken: RelayV2TerminalParserCallbackToken,
        val bytes: RelayV2TerminalBytes,
        override val fence: RelayV2TerminalEffectFence = callbackToken.fence,
        override val priority: RelayV2TerminalEffectPriority =
            RelayV2TerminalEffectPriority.PARSER_OUTPUT,
    ) : RelayV2TerminalEffect

    data class ResetParser(
        val callbackToken: RelayV2TerminalParserCallbackToken,
        override val fence: RelayV2TerminalEffectFence = callbackToken.fence,
        override val priority: RelayV2TerminalEffectPriority = RelayV2TerminalEffectPriority.CONTROL,
    ) : RelayV2TerminalEffect

    data class OutputAck(
        override val fence: RelayV2TerminalEffectFence,
        val generation: String,
        val nextOffset: String,
        override val priority: RelayV2TerminalEffectPriority = RelayV2TerminalEffectPriority.CONTROL,
    ) : RelayV2TerminalEffect

    data class RequestReplay(
        override val fence: RelayV2TerminalEffectFence,
        val requestId: String,
        val generation: String,
        val fromOffset: String,
        override val priority: RelayV2TerminalEffectPriority = RelayV2TerminalEffectPriority.CONTROL,
    ) : RelayV2TerminalEffect

    data class SendInput(
        override val fence: RelayV2TerminalEffectFence,
        val generation: String,
        val inputSeq: String,
        val bytes: RelayV2TerminalBytes,
        override val priority: RelayV2TerminalEffectPriority = RelayV2TerminalEffectPriority.CONTROL,
    ) : RelayV2TerminalEffect

    data class SendResize(
        override val fence: RelayV2TerminalEffectFence,
        val generation: String,
        val resizeSeq: String,
        val cols: Int,
        val rows: Int,
        val replacesQueued: Boolean = false,
        override val priority: RelayV2TerminalEffectPriority = RelayV2TerminalEffectPriority.CONTROL,
    ) : RelayV2TerminalEffect

    data class SendClose(
        override val fence: RelayV2TerminalEffectFence,
        val generation: String,
        val closeId: String,
        val resumeTokenCredentialReference: String,
        override val priority: RelayV2TerminalEffectPriority = RelayV2TerminalEffectPriority.CONTROL,
    ) : RelayV2TerminalEffect

    data class FinalizeClosed(
        override val fence: RelayV2TerminalEffectFence,
        val generation: String,
        val finalOffset: String,
        val reason: RelayV2TerminalCloseReason,
        val exitCode: Int?,
        override val priority: RelayV2TerminalEffectPriority = RelayV2TerminalEffectPriority.CONTROL,
    ) : RelayV2TerminalEffect

    data class DisplayTruncated(
        override val fence: RelayV2TerminalEffectFence,
        val parserAppliedNextOffset: String,
        val finalOffset: String,
        override val priority: RelayV2TerminalEffectPriority = RelayV2TerminalEffectPriority.CONTROL,
    ) : RelayV2TerminalEffect

    data class ControlsBecameAmbiguous(
        override val fence: RelayV2TerminalEffectFence,
        val inputCount: Int,
        override val priority: RelayV2TerminalEffectPriority = RelayV2TerminalEffectPriority.CONTROL,
    ) : RelayV2TerminalEffect

    data class ResetRequired(
        override val fence: RelayV2TerminalEffectFence?,
        val reason: RelayV2TerminalResetReason,
        val parserAppliedNextOffset: String?,
        override val priority: RelayV2TerminalEffectPriority = RelayV2TerminalEffectPriority.CONTROL,
    ) : RelayV2TerminalEffect
}

internal enum class RelayV2TerminalIgnoredReason {
    DUPLICATE_OUTPUT,
    STALE_GENERATION,
    STALE_DELIVERY,
    STALE_PARSER_CALLBACK,
    FINALIZED_LATE_EVENT,
    DUPLICATE_PARSER_CALLBACK,
    OUT_OF_ORDER_PARSER_CALLBACK,
    DUPLICATE_ACK,
    DUPLICATE_CLOSED,
}

internal enum class RelayV2TerminalControlRejectionReason {
    INVALID_FRAME,
    INVALID_DIMENSIONS,
    ACK_BEYOND_SENT,
    GAP,
    CONFLICT,
    TERMINAL_NOT_WRITABLE,
}

internal sealed interface RelayV2TerminalOutcome {
    data object Applied : RelayV2TerminalOutcome
    data object Restored : RelayV2TerminalOutcome

    data class Ignored(val reason: RelayV2TerminalIgnoredReason) : RelayV2TerminalOutcome

    data class ParserAdvanced(val nextOffset: String) : RelayV2TerminalOutcome

    data class ReplayRequired(val fromOffset: String) : RelayV2TerminalOutcome

    data class ResetRequired(val reason: RelayV2TerminalResetReason) : RelayV2TerminalOutcome

    data class ControlQueued(
        val kind: RelayV2TerminalControlKind,
        val sequence: String,
    ) : RelayV2TerminalOutcome

    data class ControlAcked(
        val kind: RelayV2TerminalControlKind,
        val ackedThrough: String,
    ) : RelayV2TerminalOutcome

    data class ControlRejected(
        val kind: RelayV2TerminalControlKind,
        val reason: RelayV2TerminalControlRejectionReason,
        val sequence: String?,
        val ackedThrough: String,
    ) : RelayV2TerminalOutcome

    data object ClosedFinalized : RelayV2TerminalOutcome
}

internal data class RelayV2TerminalReduction(
    val checkpoint: RelayV2TerminalCheckpoint?,
    val outcome: RelayV2TerminalOutcome,
    val effects: List<RelayV2TerminalEffect>,
) {
    init {
        val firstParserOutput = effects.indexOfFirst {
            it.priority == RelayV2TerminalEffectPriority.PARSER_OUTPUT
        }
        if (firstParserOutput >= 0) {
            require(
                effects.drop(firstParserOutput).none {
                    it.priority == RelayV2TerminalEffectPriority.CONTROL
                },
            ) { "Control effects must have priority over parser output" }
        }
    }
}

private fun requireTerminalId(value: String) {
    require(value.isNotBlank()) { "Terminal identity field is required" }
    require(value.toByteArray(Charsets.UTF_8).size <= RelayV2TerminalCheckpointLimits.MAX_ID_UTF8_BYTES) {
        "Terminal identity field is too long"
    }
    require('\u0000' !in value) { "Terminal identity field contains NUL" }
}
