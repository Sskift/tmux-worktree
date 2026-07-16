package com.tmuxworktree.mobile.core.relay.v2.runtime

import java.io.Closeable
import java.io.IOException
import java.io.InterruptedIOException
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger

/** A submitted lookup. [cancel] must release [await] without waiting for the platform resolver. */
internal interface RelayV2AddressResolution {
    @Throws(IOException::class)
    fun await(timeoutMs: Int): List<InetAddress>

    fun cancel()
}

/** Submits, but never synchronously performs, a hostname lookup. */
internal fun interface RelayV2AddressResolver {
    @Throws(IOException::class)
    fun resolve(host: String): RelayV2AddressResolution
}

/**
 * Bounded wrapper around the platform resolver. Some platform DNS implementations ignore thread
 * interruption; fixed workers and a bounded queue prevent repeated cancellation from leaking
 * threads or admitting unbounded tasks while a late lookup unwinds.
 */
internal class BoundedRelayV2AddressResolver(
    private val lookup: (String) -> Array<InetAddress> = InetAddress::getAllByName,
    workerCount: Int = DEFAULT_WORKER_COUNT,
    queuedTaskCapacity: Int = DEFAULT_QUEUED_TASK_CAPACITY,
) : RelayV2AddressResolver, Closeable {
    private val threadSequence = AtomicInteger()
    private val executor = ThreadPoolExecutor(
        workerCount,
        workerCount,
        0L,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(queuedTaskCapacity),
        { runnable ->
            Thread(
                runnable,
                "tw-relay-v2-dns-${threadSequence.incrementAndGet()}",
            ).apply { isDaemon = true }
        },
        ThreadPoolExecutor.AbortPolicy(),
    )

    init {
        require(workerCount > 0)
        require(queuedTaskCapacity > 0)
    }

    override fun resolve(host: String): RelayV2AddressResolution {
        val task = FutureTask { lookup(host).toList() }
        try {
            executor.execute(task)
        } catch (_: RejectedExecutionException) {
            throw IOException("Relay v2 address resolution is unavailable")
        }
        return FutureAddressResolution(task, executor)
    }

    override fun close() {
        executor.shutdownNow()
    }

    private class FutureAddressResolution(
        private val task: FutureTask<List<InetAddress>>,
        private val executor: ThreadPoolExecutor,
    ) : RelayV2AddressResolution {
        override fun await(timeoutMs: Int): List<InetAddress> = try {
            task.get(timeoutMs.toLong(), TimeUnit.MILLISECONDS).also {
                if (it.isEmpty()) throw IOException("Relay v2 address resolution returned no address")
            }
        } catch (_: TimeoutException) {
            cancel()
            throw SocketTimeoutException("Relay v2 address resolution timed out")
        } catch (_: CancellationException) {
            throw InterruptedIOException("Relay v2 address resolution was cancelled")
        } catch (error: InterruptedException) {
            cancel()
            Thread.currentThread().interrupt()
            throw InterruptedIOException("Relay v2 address resolution was interrupted").apply {
                initCause(error)
            }
        } catch (_: ExecutionException) {
            throw IOException("Relay v2 address resolution failed")
        }

        override fun cancel() {
            task.cancel(true)
            executor.remove(task)
        }
    }

    private companion object {
        const val DEFAULT_WORKER_COUNT = 2
        const val DEFAULT_QUEUED_TASK_CAPACITY = 16
    }
}

internal object RelayV2SystemAddressResolver : RelayV2AddressResolver {
    private val delegate = BoundedRelayV2AddressResolver()

    override fun resolve(host: String): RelayV2AddressResolution = delegate.resolve(host)
}
