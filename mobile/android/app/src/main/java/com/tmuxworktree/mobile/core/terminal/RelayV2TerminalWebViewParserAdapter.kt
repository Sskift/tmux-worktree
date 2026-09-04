package com.tmuxworktree.mobile.core.terminal

import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2TerminalParserPort
import com.tmuxworktree.mobile.core.relay.v2.terminal.RelayV2TerminalParserCallbackToken
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.Dispatchers
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
    private val callbackDispatcher: CoroutineDispatcher =
        Dispatchers.IO.limitedParallelism(1),
    private val newCallbackNonce: () -> String = { UUID.randomUUID().toString() },
) : RelayV2TerminalParserPort {
    private val attachmentCallbacks = ParserAttachmentCallbackOwner()
    private val outputFilter = LegacyScreenTitleOutputFilter()

    constructor(
        binding: TerminalWebViewParserBinding,
        callbackScope: CoroutineScope,
    ) : this(
        callbackScope = callbackScope,
        writePort = RelayV2TerminalWebViewWritePort(binding::writeBytesWithAck),
        resetPort = RelayV2TerminalWebViewResetPort(binding::resetWithAck),
    )

    /**
     * Synchronously rejects new registrations and returns the exact drain barrier for parser
     * mutations already owned by this attachment. Runtime detach must await this barrier.
     */
    internal fun fenceAttachment(): RelayV2TerminalParserCallbackBarrier =
        attachmentCallbacks.fenceNewRegistrations()

    override suspend fun write(
        callbackToken: RelayV2TerminalParserCallbackToken,
        bytes: ByteArray,
        completion: suspend (applied: Boolean) -> Unit,
    ): Boolean {
        val filteredBytes = outputFilter.push(bytes)
        return register(callbackToken, completion) { callbackId, callback ->
            if (filteredBytes.isEmpty()) {
                // A complete legacy title sequence mutates only filter state. Settle it through
                // the same registration gate so attachment fencing and callback ordering remain
                // identical to an acknowledged WebView parser mutation.
                callback(true)
                true
            } else {
                writePort.register(callbackId, filteredBytes, callback)
            }
        }
    }

    override suspend fun reset(
        callbackToken: RelayV2TerminalParserCallbackToken,
        completion: suspend (applied: Boolean) -> Unit,
    ): Boolean {
        outputFilter.reset()
        return register(callbackToken, completion) { callbackId, callback ->
            resetPort.register(callbackId, callback)
        }
    }

    @OptIn(DelicateCoroutinesApi::class, ExperimentalCoroutinesApi::class)
    private fun register(
        callbackToken: RelayV2TerminalParserCallbackToken,
        completion: suspend (Boolean) -> Unit,
        platformRegister: (String, (Boolean) -> Unit) -> Boolean,
    ): Boolean {
        val callbackId = "${callbackToken.operationId}.${newCallbackNonce()}"
        require(callbackId.length <= MAX_CALLBACK_ID_CHARS)
        val registration = attachmentCallbacks.beginRegistration() ?: return false
        val gate = ParserCompletionGate(
            completion = { applied ->
                try {
                    // A WebView acknowledgement only needs Main long enough to cross the
                    // Javascript bridge. The durable callback performs Room transitions, sink
                    // journaling and may synchronously dispatch the next replay slice; keeping
                    // that work on viewModelScope/Main starves Compose and the next bridge ACK.
                    // One IO lane per attachment preserves bounded CPU pressure, while the
                    // runtime's keyed handoff gate remains the full suspend-level serializer.
                    callbackScope.launch(
                        context = callbackDispatcher,
                        start = CoroutineStart.ATOMIC,
                    ) {
                        withContext(NonCancellable) { completion(applied) }
                    }.invokeOnCompletion {
                        registration.complete()
                    }
                } catch (failure: Throwable) {
                    registration.complete()
                    throw failure
                }
            },
            registrationRejected = registration::complete,
        )
        val accepted = try {
            platformRegister(callbackId, gate::platformCallback)
        } catch (failure: Throwable) {
            gate.registrationReturned(false)
            throw failure
        }
        return gate.registrationReturned(accepted)
    }

    private companion object {
        const val MAX_CALLBACK_ID_CHARS = 256
    }
}

/**
 * tmux/zsh can emit the screen-compatible title form `ESC k title ESC \\`. The vendored xterm
 * parser does not implement that private sequence and renders `title` as terminal text. Remove
 * only that metadata sequence while preserving every other byte, including sequences split at
 * arbitrary Relay frame boundaries.
 */
internal class LegacyScreenTitleOutputFilter(
    private val maxSequenceBytes: Int = 4_096,
) {
    private enum class State {
        TEXT,
        ESCAPE,
        TITLE,
        TITLE_ESCAPE,
    }

    private var state = State.TEXT
    private val held = ByteArrayOutputStream()

    @Synchronized
    fun push(bytes: ByteArray): ByteArray {
        if (bytes.isEmpty()) return bytes
        val output = ByteArrayOutputStream(bytes.size)
        bytes.forEach { signedByte ->
            val byte = signedByte.toInt() and 0xff
            when (state) {
                State.TEXT -> {
                    if (byte == ESCAPE_BYTE) {
                        held.write(byte)
                        state = State.ESCAPE
                    } else {
                        output.write(byte)
                    }
                }
                State.ESCAPE -> {
                    if (byte == LEGACY_TITLE_FINAL_BYTE) {
                        held.write(byte)
                        state = State.TITLE
                    } else {
                        output.write(held.toByteArray())
                        held.reset()
                        if (byte == ESCAPE_BYTE) {
                            held.write(byte)
                            state = State.ESCAPE
                        } else {
                            output.write(byte)
                            state = State.TEXT
                        }
                    }
                }
                State.TITLE -> {
                    held.write(byte)
                    when (byte) {
                        BELL_BYTE -> discardTitle()
                        ESCAPE_BYTE -> state = State.TITLE_ESCAPE
                        else -> flushOversizedTitleTo(output)
                    }
                }
                State.TITLE_ESCAPE -> {
                    held.write(byte)
                    when (byte) {
                        STRING_TERMINATOR_FINAL_BYTE -> discardTitle()
                        ESCAPE_BYTE -> flushOversizedTitleTo(output)
                        else -> {
                            state = State.TITLE
                            flushOversizedTitleTo(output)
                        }
                    }
                }
            }
        }
        return output.toByteArray()
    }

    @Synchronized
    fun reset() {
        held.reset()
        state = State.TEXT
    }

    private fun discardTitle() {
        held.reset()
        state = State.TEXT
    }

    private fun flushOversizedTitleTo(output: ByteArrayOutputStream) {
        if (held.size() <= maxSequenceBytes) return
        output.write(held.toByteArray())
        held.reset()
        state = State.TEXT
    }

    private companion object {
        const val ESCAPE_BYTE = 0x1b
        const val BELL_BYTE = 0x07
        const val LEGACY_TITLE_FINAL_BYTE = 0x6b
        const val STRING_TERMINATOR_FINAL_BYTE = 0x5c
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
    internal class Registration(
        private val owner: ParserAttachmentCallbackOwner,
    ) {
        private val completed = AtomicBoolean(false)

        fun complete() {
            if (completed.compareAndSet(false, true)) owner.completeRegistration()
        }
    }

    private val lock = Any()
    private var accepting = true
    private var registrations = 0
    private var drainCompletionClaimed = false
    private val drained = CompletableDeferred<Unit>()

    fun beginRegistration(): Registration? = synchronized(lock) {
        if (!accepting) return@synchronized null
        registrations += 1
        Registration(this)
    }

    fun fenceNewRegistrations(): RelayV2TerminalParserCallbackBarrier {
        val completeNow = synchronized(lock) {
            accepting = false
            if (registrations == 0 && !drainCompletionClaimed) {
                drainCompletionClaimed = true
                true
            } else {
                false
            }
        }
        if (completeNow) check(drained.complete(Unit))
        return RelayV2TerminalParserCallbackBarrier(drained)
    }

    private fun completeRegistration() {
        val completeNow = synchronized(lock) {
            check(registrations > 0) { "Parser registration was not owned" }
            registrations -= 1
            if (!accepting && registrations == 0 && !drainCompletionClaimed) {
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
    private val registrationRejected: () -> Unit,
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
                    if (state.compareAndSet(current, next)) {
                        if (!accepted) registrationRejected()
                        return accepted
                    }
                }
                is State.Early -> {
                    val next = if (accepted) State.Settled else State.Rejected
                    if (state.compareAndSet(current, next)) {
                        if (accepted) {
                            completion(current.applied)
                        } else {
                            registrationRejected()
                        }
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
