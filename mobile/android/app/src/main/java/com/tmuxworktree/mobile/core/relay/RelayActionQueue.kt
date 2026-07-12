package com.tmuxworktree.mobile.core.relay

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.sync.Semaphore

internal class BoundedActionQueue<T>(
    normalCapacity: Int,
    reservedCapacity: Int,
) {
    private val validatedNormalCapacity = normalCapacity.also {
        require(it > 0) { "normalCapacity must be positive" }
    }
    private val validatedReservedCapacity = reservedCapacity.also {
        require(it > 0) { "reservedCapacity must be positive" }
    }
    private val enqueueLock = Any()
    private val normalSlots = Semaphore(validatedNormalCapacity)
    private val reservedSlots = Semaphore(validatedReservedCapacity)
    private val channel = Channel<QueuedAction<T>>(
        validatedNormalCapacity + validatedReservedCapacity,
    )

    fun trySendNormal(action: T): Boolean = synchronized(enqueueLock) {
        if (!normalSlots.tryAcquire()) return@synchronized false
        if (channel.trySend(QueuedAction(action, SlotKind.NORMAL)).isSuccess) {
            true
        } else {
            normalSlots.release()
            false
        }
    }

    fun trySendNormalOrReserved(action: T): Boolean = synchronized(enqueueLock) {
        if (normalSlots.tryAcquire()) {
            if (channel.trySend(QueuedAction(action, SlotKind.NORMAL)).isSuccess) {
                return@synchronized true
            }
            normalSlots.release()
        }
        trySendReservedLocked(action)
    }

    fun trySendReserved(action: T): Boolean = synchronized(enqueueLock) {
        trySendReservedLocked(action)
    }

    suspend fun receive(): T? {
        val queued = channel.receiveCatching().getOrNull() ?: return null
        when (queued.slotKind) {
            SlotKind.NORMAL -> normalSlots.release()
            SlotKind.RESERVED -> reservedSlots.release()
        }
        return queued.action
    }

    fun close() {
        channel.close()
    }

    private fun trySendReservedLocked(action: T): Boolean {
        if (!reservedSlots.tryAcquire()) return false
        if (channel.trySend(QueuedAction(action, SlotKind.RESERVED)).isSuccess) return true
        reservedSlots.release()
        return false
    }

    private enum class SlotKind { NORMAL, RESERVED }

    private data class QueuedAction<T>(val action: T, val slotKind: SlotKind)
}
