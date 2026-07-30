package com.tmuxworktree.mobile.core.terminal

import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalParserPort
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserCallbackToken
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal fun interface RelayV2TerminalWebViewWritePort {
    fun register(
        callbackId: String,
        bytes: ByteArray,
        completion: (Boolean) -> Unit,
    ): Boolean
}

internal fun interface RelayV2TerminalWebViewResetPort {
    fun register(
        callbackId: String,
        completion: (Boolean) -> Unit,
    ): Boolean
}

/** Platform adapter only; terminal authority and parser callback settlement remain in v2 runtime. */
internal class RelayV2TerminalWebViewParserAdapter(
    private val callbackScope: CoroutineScope,
    private val writePort: RelayV2TerminalWebViewWritePort,
    private val resetPort: RelayV2TerminalWebViewResetPort,
    private val newCallbackNonce: () -> String = { UUID.randomUUID().toString() },
) : RelayV2TerminalParserPort {
    private val attachmentCallbacks = ParserAttachmentCallbackOwner()

    constructor(
        binding: TerminalWebViewParserBinding,
        callbackScope: CoroutineScope,
    ) : this(
        callbackScope = callbackScope,
        writePort = RelayV2TerminalWebViewWritePort(binding::writeBytesWithAck),
        resetPort = RelayV2TerminalWebViewResetPort(binding::resetWithAck),
    )

    /**
     * Synchronously rejects new callbacks and returns the exact drain barrier for callbacks that
     * were already admitted. Runtime detach must await this barrier.
     */
    internal fun fenceAttachment(): RelayV2TerminalParserCallbackBarrier =
        attachmentCallbacks.fenceNewCallbacks()

    override suspend fun write(
        callbackToken: RelayV2TerminalParserCallbackToken,
        bytes: ByteArray,
        completion: suspend (applied: Boolean) -> Unit,
    ): Boolean = register(callbackToken, completion) { callbackId, callback ->
        writePort.register(callbackId, bytes, callback)
    }

    override suspend fun reset(
        callbackToken: RelayV2TerminalParserCallbackToken,
        completion: suspend (applied: Boolean) -> Unit,
    ): Boolean = register(callbackToken, completion) { callbackId, callback ->
        resetPort.register(callbackId, callback)
    }

    @OptIn(DelicateCoroutinesApi::class, ExperimentalCoroutinesApi::class)
    private fun register(
        callbackToken: RelayV2TerminalParserCallbackToken,
        completion: suspend (Boolean) -> Unit,
        platformRegister: (String, (Boolean) -> Unit) -> Boolean,
    ): Boolean {
        if (!attachmentCallbacks.acceptingCallbacks()) return false
        val callbackId = "${callbackToken.operationId}.${newCallbackNonce()}"
        require(callbackId.length <= MAX_CALLBACK_ID_CHARS)
        val gate = ParserCompletionGate { applied ->
            val admission = attachmentCallbacks.admitCallback() ?: return@ParserCompletionGate
            try {
                callbackScope.launch(start = CoroutineStart.ATOMIC) {
                    withContext(NonCancellable) { completion(applied) }
                }.invokeOnCompletion {
                    admission.complete()
                }
            } catch (failure: Throwable) {
                admission.complete()
                throw failure
            }
        }
        val accepted = platformRegister(callbackId, gate::platformCallback)
        return gate.registrationReturned(accepted)
    }

    private companion object {
        const val MAX_CALLBACK_ID_CHARS = 256
    }
}

internal class RelayV2TerminalParserCallbackBarrier internal constructor(
    private val drained: CompletableDeferred<Unit>,
) {
    internal suspend fun awaitDrained() {
        drained.await()
    }

    internal val isDrained: Boolean
        get() = drained.isCompleted
}

private class ParserAttachmentCallbackOwner {
    internal class Admission(
        private val owner: ParserAttachmentCallbackOwner,
    ) {
        private val completed = AtomicBoolean(false)

        fun complete() {
            if (completed.compareAndSet(false, true)) owner.completeAdmission()
        }
    }

    private val lock = Any()
    private var accepting = true
    private var admitted = 0
    private var drainCompletionClaimed = false
    private val drained = CompletableDeferred<Unit>()

    fun acceptingCallbacks(): Boolean = synchronized(lock) { accepting }

    fun admitCallback(): Admission? = synchronized(lock) {
        if (!accepting) return@synchronized null
        admitted += 1
        Admission(this)
    }

    fun fenceNewCallbacks(): RelayV2TerminalParserCallbackBarrier {
        val completeNow = synchronized(lock) {
            accepting = false
            if (admitted == 0 && !drainCompletionClaimed) {
                drainCompletionClaimed = true
                true
            } else {
                false
            }
        }
        if (completeNow) check(drained.complete(Unit))
        return RelayV2TerminalParserCallbackBarrier(drained)
    }

    private fun completeAdmission() {
        val completeNow = synchronized(lock) {
            check(admitted > 0) { "Parser callback admission was not owned" }
            admitted -= 1
            if (!accepting && admitted == 0 && !drainCompletionClaimed) {
                drainCompletionClaimed = true
                true
            } else {
                false
            }
        }
        if (completeNow) check(drained.complete(Unit))
    }
}

private class ParserCompletionGate(
    private val completion: (Boolean) -> Unit,
) {
    private sealed interface State {
        data object Registering : State
        data class Early(val applied: Boolean) : State
        data object Accepted : State
        data object Rejected : State
        data object Settled : State
    }

    private val state = AtomicReference<State>(State.Registering)

    fun platformCallback(applied: Boolean) {
        while (true) {
            when (val current = state.get()) {
                State.Registering -> if (state.compareAndSet(current, State.Early(applied))) return
                is State.Early,
                State.Rejected,
                State.Settled,
                -> return
                State.Accepted -> if (state.compareAndSet(current, State.Settled)) {
                    completion(applied)
                    return
                }
            }
        }
    }

    fun registrationReturned(accepted: Boolean): Boolean {
        while (true) {
            when (val current = state.get()) {
                State.Registering -> {
                    val next = if (accepted) State.Accepted else State.Rejected
                    if (state.compareAndSet(current, next)) return accepted
                }
                is State.Early -> {
                    val next = if (accepted) State.Settled else State.Rejected
                    if (state.compareAndSet(current, next)) {
                        if (accepted) completion(current.applied)
                        return accepted
                    }
                }
                State.Accepted -> return true
                State.Rejected -> return false
                State.Settled -> return accepted
            }
        }
    }
}
