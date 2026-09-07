package com.tmuxworktree.mobile.core.relay.v2.runtime

import com.tmuxworktree.mobile.core.relay.v2.state.RelayV2TerminalCheckpointKey
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalEffect
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserCallbackToken

/**
 * Result of one synchronous effect execution attempt.
 *
 * [COMPLETED] means the exact effect completed before the executor returned.
 * [TRANSFERRED_TO_DURABLE_CALLBACK] means a parser mutation was registered only after its exact
 * callback claim became durable; it does not claim evaluateJavascript/xterm has completed. An
 * attached gate may be settled COMMITTED only after the sink has accepted and retired the current
 * FIFO reservation, so its callback batch cannot overtake the effect that transferred ownership.
 * [REJECTED_WITHOUT_EXECUTION] proves that the executor performed no mutation and retained no
 * ownership for the exact effect.
 */
internal enum class RelayV2TerminalTransferredCallbackSettlement {
    COMMITTED,
    ABORTED,
}

internal fun interface RelayV2TerminalTransferredCallbackGate {
    /** Non-blocking and one-shot; false means this gate was already settled. */
    fun settle(settlement: RelayV2TerminalTransferredCallbackSettlement): Boolean
}

internal fun settleTransferredCallbackGates(
    gates: List<RelayV2TerminalTransferredCallbackGate>,
    settlement: RelayV2TerminalTransferredCallbackSettlement,
): Boolean {
    var allSettled = true
    gates.forEach { gate ->
        val settled = try {
            gate.settle(settlement)
        } catch (_: Throwable) {
            false
        }
        if (!settled) allSettled = false
    }
    return allSettled
}

internal class RelayV2TerminalSynchronousEffectExecutionReceipt private constructor(
    internal val disposition: Disposition,
    internal val transferredCallbackGate: RelayV2TerminalTransferredCallbackGate?,
) {
    internal enum class Disposition {
        COMPLETED,
        TRANSFERRED_TO_DURABLE_CALLBACK,
        REJECTED_WITHOUT_EXECUTION,
    }

    companion object {
        val COMPLETED = RelayV2TerminalSynchronousEffectExecutionReceipt(
            Disposition.COMPLETED,
            transferredCallbackGate = null,
        )
        val TRANSFERRED_TO_DURABLE_CALLBACK =
            RelayV2TerminalSynchronousEffectExecutionReceipt(
                Disposition.TRANSFERRED_TO_DURABLE_CALLBACK,
                transferredCallbackGate = null,
            )
        val REJECTED_WITHOUT_EXECUTION = RelayV2TerminalSynchronousEffectExecutionReceipt(
            Disposition.REJECTED_WITHOUT_EXECUTION,
            transferredCallbackGate = null,
        )

        fun transferredToDurableCallback(
            gate: RelayV2TerminalTransferredCallbackGate?,
        ): RelayV2TerminalSynchronousEffectExecutionReceipt =
            if (gate == null) {
                TRANSFERRED_TO_DURABLE_CALLBACK
            } else {
                RelayV2TerminalSynchronousEffectExecutionReceipt(
                    Disposition.TRANSFERRED_TO_DURABLE_CALLBACK,
                    gate,
                )
            }
    }
}

/** Immutable context supplied for exactly one synchronous effect execution. */
internal data class RelayV2TerminalSynchronousEffectExecution(
    val authority: RelayV2RepositoryEffectAuthority,
    val key: RelayV2TerminalCheckpointKey,
    val callbackToken: RelayV2TerminalParserCallbackToken,
    val effectIndex: Int,
    val effectCount: Int,
    val effect: RelayV2TerminalEffect,
)

/**
 * Narrow synchronous platform/composition boundary.
 *
 * Implementations must finish the exact effect before returning [COMPLETED]. The transfer receipt
 * is reserved for the existing durable parser claim plus exact native callback owner; a plain
 * in-memory asynchronous queue cannot return either accepted receipt.
 */
internal fun interface RelayV2TerminalSynchronousEffectExecutor {
    fun execute(
        execution: RelayV2TerminalSynchronousEffectExecution,
    ): RelayV2TerminalSynchronousEffectExecutionReceipt
}
