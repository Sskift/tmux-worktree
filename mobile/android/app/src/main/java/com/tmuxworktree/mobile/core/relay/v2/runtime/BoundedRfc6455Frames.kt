package com.tmuxworktree.mobile.core.relay.v2.runtime

import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.SecureRandom
import java.util.ArrayDeque
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.math.max

internal sealed interface RelayV2InboundFrame {
    data class Text(val bytes: ByteArray) : RelayV2InboundFrame
    data class Ping(val payload: ByteArray) : RelayV2InboundFrame
    data object Pong : RelayV2InboundFrame
    data class Close(val code: Int, val payload: ByteArray) : RelayV2InboundFrame
}

/**
 * Stateful RFC6455 server-frame reader with all message limits decided from headers before body
 * reads or payload-sized allocations.
 */
internal class BoundedRfc6455FrameReader(
    private val input: InputStream,
) {
    private var fragmented: FragmentAccumulator? = null

    fun readNext(): RelayV2InboundFrame {
        while (true) {
            val first = readHeaderByte()
            val final = first and 0x80 != 0
            if (first and 0x70 != 0) throw RelayV2WebSocketProtocolException()
            val opcode = first and 0x0f
            validateOpcodeBeforeSecondByte(opcode, final)

            val second = readHeaderByte()
            if (second and 0x80 != 0) throw RelayV2WebSocketProtocolException()
            val marker = second and 0x7f
            if (opcode >= OPCODE_CLOSE && marker > 125) {
                throw RelayV2WebSocketProtocolException()
            }
            val length = readCanonicalLength(marker)
            if (length > MAX_MESSAGE_BYTES) throw RelayV2WebSocketProtocolException()

            when (opcode) {
                OPCODE_TEXT -> {
                    if (!final) {
                        val accumulator = FragmentAccumulator()
                        accumulator.readAppend(input, length)
                        fragmented = accumulator
                        continue
                    }
                    val message = readPayload(length)
                    requireStrictUtf8(message)
                    return RelayV2InboundFrame.Text(message)
                }
                OPCODE_CONTINUATION -> {
                    val accumulator = fragmented ?: throw RelayV2WebSocketProtocolException()
                    accumulator.readAppend(input, length)
                    if (!final) continue
                    fragmented = null
                    val message = accumulator.finish()
                    requireStrictUtf8(message)
                    return RelayV2InboundFrame.Text(message)
                }
                OPCODE_PING -> return RelayV2InboundFrame.Ping(readPayload(length))
                OPCODE_PONG -> {
                    readPayload(length)
                    return RelayV2InboundFrame.Pong
                }
                OPCODE_CLOSE -> return parseClose(readPayload(length))
                else -> throw RelayV2WebSocketProtocolException()
            }
        }
    }

    private fun validateOpcodeBeforeSecondByte(opcode: Int, final: Boolean) {
        when (opcode) {
            OPCODE_CONTINUATION -> if (fragmented == null) throw RelayV2WebSocketProtocolException()
            OPCODE_TEXT -> if (fragmented != null) throw RelayV2WebSocketProtocolException()
            OPCODE_CLOSE, OPCODE_PING, OPCODE_PONG -> if (!final) {
                throw RelayV2WebSocketProtocolException()
            }
            else -> throw RelayV2WebSocketProtocolException()
        }
    }

    private fun readCanonicalLength(marker: Int): Int = when (marker) {
        in 0..125 -> marker
        126 -> {
            val value = (readHeaderByte() shl 8) or readHeaderByte()
            if (value < 126) throw RelayV2WebSocketProtocolException()
            value
        }
        127 -> {
            val first = readHeaderByte()
            if (first and 0x80 != 0) throw RelayV2WebSocketProtocolException()
            var value = first.toLong()
            repeat(7) {
                value = (value shl 8) or readHeaderByte().toLong()
                if (value > MAX_MESSAGE_BYTES) throw RelayV2WebSocketProtocolException()
            }
            if (value <= 65_535L) throw RelayV2WebSocketProtocolException()
            value.toInt()
        }
        else -> throw RelayV2WebSocketProtocolException()
    }

    private fun readPayload(length: Int): ByteArray {
        val payload = ByteArray(length)
        input.readFully(payload, 0, length)
        return payload
    }

    private fun parseClose(payload: ByteArray): RelayV2InboundFrame.Close {
        if (payload.size == 1) throw RelayV2WebSocketProtocolException()
        if (payload.isEmpty()) return RelayV2InboundFrame.Close(1005, payload)
        val code = ((payload[0].toInt() and 0xff) shl 8) or (payload[1].toInt() and 0xff)
        if (!isValidCloseCode(code)) throw RelayV2WebSocketProtocolException()
        requireStrictUtf8(payload, 2, payload.size - 2)
        return RelayV2InboundFrame.Close(code, payload)
    }

    private fun readHeaderByte(): Int {
        val value = input.read()
        if (value == -1) throw EOFException("Relay v2 WebSocket frame was truncated")
        return value
    }

    private class FragmentAccumulator {
        private var bytes = ByteArray(0)
        private var size = 0

        fun readAppend(input: InputStream, declaredLength: Int) {
            val remaining = MAX_MESSAGE_BYTES - size
            if (declaredLength > remaining) throw RelayV2WebSocketProtocolException()
            ensureCapacity(size + declaredLength)
            input.readFully(bytes, size, declaredLength)
            size += declaredLength
        }

        fun finish(): ByteArray = if (bytes.size == size) bytes else bytes.copyOf(size)

        private fun ensureCapacity(required: Int) {
            if (required <= bytes.size) return
            var capacity = max(256, bytes.size)
            while (capacity < required) {
                capacity = minOf(MAX_MESSAGE_BYTES, max(required, capacity * 2))
            }
            bytes = bytes.copyOf(capacity)
        }
    }

    companion object {
        const val MAX_MESSAGE_BYTES = 1_048_576
        private const val OPCODE_CONTINUATION = 0x0
        private const val OPCODE_TEXT = 0x1
        private const val OPCODE_CLOSE = 0x8
        private const val OPCODE_PING = 0x9
        private const val OPCODE_PONG = 0xa
    }
}

internal class BoundedRfc6455Writer(
    private val output: OutputStream,
    private val random: SecureRandom,
    private val onFailure: (IOException) -> Unit,
    private val onLocalCloseComplete: () -> Unit,
    private val onStopped: () -> Unit = {},
) {
    private val lock = Object()
    private val controls = ArrayDeque<OutboundFrame>()
    private val messages = ArrayDeque<OutboundFrame>()
    private var reservedMessageBytes = 0L
    private var reservedMessageCount = 0
    private var queuedControlBytes = 0L
    private var acceptingMessages = true
    private var stopped = false
    private var worker: Thread? = null
    private val stoppedNotified = AtomicBoolean(false)

    fun start() {
        val notifyStopped = synchronized(lock) {
            check(worker == null)
            if (stopped) {
                true
            } else {
                worker = thread(name = "tw-relay-v2-ws-writer", isDaemon = true) {
                    try {
                        writeLoop()
                    } finally {
                        notifyStopped()
                    }
                }
                false
            }
        }
        if (notifyStopped) notifyStopped()
    }

    fun enqueueText(bytes: ByteArray): Boolean {
        if (bytes.size > MAX_QUEUED_MESSAGE_BYTES || !isStrictUtf8(bytes, 0, bytes.size)) return false
        return synchronized(lock) {
            if (stopped || !acceptingMessages ||
                reservedMessageCount >= MAX_QUEUED_MESSAGE_COUNT ||
                bytes.size.toLong() > MAX_QUEUED_MESSAGE_BYTES - reservedMessageBytes
            ) {
                return@synchronized false
            }
            val copy = bytes.copyOf()
            messages += OutboundFrame(OPCODE_TEXT, copy)
            reservedMessageBytes += copy.size
            reservedMessageCount += 1
            lock.notifyAll()
            true
        }
    }

    fun enqueuePong(payload: ByteArray): Boolean = enqueueControl(OPCODE_PONG, payload, null, false)

    fun replyToClose(payload: ByteArray, timeoutMs: Long): Boolean {
        val completion = CountDownLatch(1)
        if (!enqueueTerminalClose(payload, completion)) return false
        return awaitCompletion(completion, timeoutMs)
    }

    fun sendProtocolClose(timeoutMs: Long): Boolean {
        val payload = closePayload(4400, "protocol violation") ?: return false
        val completion = CountDownLatch(1)
        if (!enqueueTerminalClose(payload, completion)) return false
        return awaitCompletion(completion, timeoutMs)
    }

    fun close(code: Int, reason: String): Boolean {
        val payload = closePayload(code, reason) ?: return false
        val queued = synchronized(lock) {
            if (stopped || !acceptingMessages) return false
            acceptingMessages = false
            clearQueuedMessagesLocked()
            controls.clear()
            queuedControlBytes = 0
            enqueueControlLocked(OPCODE_CLOSE, payload, null, true)
        }
        if (!queued) stop()
        return queued
    }

    fun stop() {
        val thread = synchronized(lock) {
            if (stopped) return
            stopped = true
            acceptingMessages = false
            clearQueuedMessagesLocked()
            controls.clear()
            queuedControlBytes = 0
            lock.notifyAll()
            worker
        }
        if (thread == null) {
            notifyStopped()
        } else if (thread !== Thread.currentThread()) {
            thread.interrupt()
        }
    }

    internal fun reservedMessageBytesForTest(): Long = synchronized(lock) { reservedMessageBytes }

    private fun enqueueControl(
        opcode: Int,
        payload: ByteArray,
        completion: CountDownLatch?,
        localClose: Boolean,
    ): Boolean = synchronized(lock) {
        enqueueControlLocked(opcode, payload.copyOf(), completion, localClose)
    }

    private fun enqueueTerminalClose(payload: ByteArray, completion: CountDownLatch): Boolean =
        synchronized(lock) {
            if (stopped || payload.size > 125) return@synchronized false
            acceptingMessages = false
            clearQueuedMessagesLocked()
            controls.clear()
            queuedControlBytes = 0
            enqueueControlLocked(OPCODE_CLOSE, payload.copyOf(), completion, false)
        }

    private fun awaitCompletion(completion: CountDownLatch, timeoutMs: Long): Boolean = try {
        completion.await(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        false
    }

    private fun enqueueControlLocked(
        opcode: Int,
        payload: ByteArray,
        completion: CountDownLatch?,
        localClose: Boolean,
    ): Boolean {
        if (stopped || payload.size > 125 || controls.size >= MAX_QUEUED_CONTROL_COUNT ||
            payload.size.toLong() > MAX_QUEUED_CONTROL_BYTES - queuedControlBytes
        ) {
            return false
        }
        controls += OutboundFrame(opcode, payload, completion, localClose)
        queuedControlBytes += payload.size
        lock.notifyAll()
        return true
    }

    private fun writeLoop() {
        while (true) {
            val frame = synchronized(lock) {
                while (!stopped && controls.isEmpty() && messages.isEmpty()) {
                    try {
                        lock.wait()
                    } catch (_: InterruptedException) {
                        if (stopped) return
                    }
                }
                if (stopped) return
                val next = if (controls.isNotEmpty()) controls.removeFirst() else messages.removeFirst()
                if (next.opcode != OPCODE_TEXT) queuedControlBytes -= next.payload.size
                next
            }
            try {
                writeMaskedFrame(output, frame.opcode, frame.payload, random)
                output.flush()
                releaseMessageReservation(frame)
                frame.completion?.countDown()
                if (frame.localClose) {
                    stop()
                    onLocalCloseComplete()
                    return
                }
            } catch (error: IOException) {
                releaseMessageReservation(frame)
                frame.completion?.countDown()
                stop()
                onFailure(error)
                return
            } catch (_: RuntimeException) {
                releaseMessageReservation(frame)
                frame.completion?.countDown()
                stop()
                onFailure(IOException("Relay v2 WebSocket write failed"))
                return
            }
        }
    }

    private fun releaseMessageReservation(frame: OutboundFrame) {
        if (frame.opcode != OPCODE_TEXT) return
        synchronized(lock) {
            reservedMessageBytes -= frame.payload.size
            reservedMessageCount -= 1
        }
    }

    private fun clearQueuedMessagesLocked() {
        while (messages.isNotEmpty()) {
            val removed = messages.removeFirst()
            reservedMessageBytes -= removed.payload.size
            reservedMessageCount -= 1
        }
    }

    private fun notifyStopped() {
        if (stoppedNotified.compareAndSet(false, true)) onStopped()
    }

    private data class OutboundFrame(
        val opcode: Int,
        val payload: ByteArray,
        val completion: CountDownLatch? = null,
        val localClose: Boolean = false,
    )

    companion object {
        const val MAX_QUEUED_MESSAGE_BYTES = 1_048_576L
        const val MAX_QUEUED_MESSAGE_COUNT = 64
        const val MAX_QUEUED_CONTROL_BYTES = 2_048L
        const val MAX_QUEUED_CONTROL_COUNT = 16
        private const val OPCODE_TEXT = 0x1
        private const val OPCODE_CLOSE = 0x8
        private const val OPCODE_PONG = 0xa

        internal fun writeMaskedFrame(
            output: OutputStream,
            opcode: Int,
            payload: ByteArray,
            random: SecureRandom,
        ) {
            val mask = ByteArray(4).also(random::nextBytes)
            output.write(0x80 or opcode)
            when {
                payload.size <= 125 -> output.write(0x80 or payload.size)
                payload.size <= 65_535 -> {
                    output.write(0x80 or 126)
                    output.write(payload.size ushr 8)
                    output.write(payload.size)
                }
                else -> {
                    output.write(0x80 or 127)
                    repeat(4) { output.write(0) }
                    output.write(payload.size ushr 24)
                    output.write(payload.size ushr 16)
                    output.write(payload.size ushr 8)
                    output.write(payload.size)
                }
            }
            output.write(mask)
            val chunk = ByteArray(minOf(8_192, payload.size))
            var offset = 0
            while (offset < payload.size) {
                val count = minOf(chunk.size, payload.size - offset)
                for (index in 0 until count) {
                    chunk[index] = (payload[offset + index].toInt() xor
                        mask[(offset + index) and 3].toInt()).toByte()
                }
                output.write(chunk, 0, count)
                offset += count
            }
            chunk.fill(0)
            mask.fill(0)
        }

        private fun closePayload(code: Int, reason: String): ByteArray? {
            if (!isValidCloseCode(code) || reason.length > 123) return null
            val encoded = strictUtf8Bytes(reason) ?: return null
            if (encoded.size > 123) return null
            return ByteArray(encoded.size + 2).also {
                it[0] = (code ushr 8).toByte()
                it[1] = code.toByte()
                encoded.copyInto(it, 2)
            }
        }
    }
}

private fun InputStream.readFully(destination: ByteArray, offset: Int, length: Int) {
    var consumed = 0
    while (consumed < length) {
        val read = read(destination, offset + consumed, length - consumed)
        if (read == -1) throw EOFException("Relay v2 WebSocket payload was truncated")
        if (read == 0) continue
        consumed += read
    }
}

private fun requireStrictUtf8(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size) {
    if (!isStrictUtf8(bytes, offset, length)) throw RelayV2WebSocketProtocolException()
}

private fun isStrictUtf8(bytes: ByteArray, offset: Int, length: Int): Boolean {
    val decoder = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
    val input = ByteBuffer.wrap(bytes, offset, length)
    val output = CharBuffer.allocate(1_024)
    while (true) {
        val result = decoder.decode(input, output, true)
        if (result.isError) return false
        if (result.isUnderflow) break
        output.clear()
    }
    output.clear()
    return !decoder.flush(output).isError
}

private fun strictUtf8Bytes(value: String): ByteArray? {
    val encoder = Charsets.UTF_8.newEncoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
    return try {
        val buffer = encoder.encode(CharBuffer.wrap(value))
        ByteArray(buffer.remaining()).also(buffer::get)
    } catch (_: CharacterCodingException) {
        null
    }
}

private fun isValidCloseCode(code: Int): Boolean =
    code in 3_000..4_999 || code in setOf(1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014)
