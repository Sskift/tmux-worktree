package com.tmuxworktree.mobile.core.session

import kotlin.math.roundToLong
import kotlin.random.Random

/** Owns the retry ladder so every physical Adapter shares one Mobile Session reconnect policy. */
internal fun interface MobileSessionReconnectPolicy {
    fun delayMillis(consecutiveFailure: Int): Long
}

internal class ExponentialMobileSessionReconnectPolicy(
    private val baseDelayMs: Long,
    private val maxDelayMs: Long,
    private val jitterRatio: Double,
    private val randomUnit: () -> Double = { Random.Default.nextDouble() },
) : MobileSessionReconnectPolicy {
    init {
        require(baseDelayMs > 0L)
        require(maxDelayMs >= baseDelayMs)
        require(jitterRatio in 0.0..0.5)
    }

    override fun delayMillis(consecutiveFailure: Int): Long {
        val exponent = consecutiveFailure.coerceIn(0, MAX_EXPONENT)
        val unjittered = (baseDelayMs * (1L shl exponent)).coerceAtMost(maxDelayMs)
        if (jitterRatio == 0.0) return unjittered
        val unit = randomUnit().coerceIn(0.0, 1.0)
        val factor = 1.0 + ((unit * 2.0) - 1.0) * jitterRatio
        return (unjittered * factor).roundToLong().coerceIn(1L, maxDelayMs)
    }

    internal companion object {
        private const val MAX_EXPONENT = 30

        /** Fast first recovery, bounded exponential growth, and jitter to avoid reconnect herds. */
        fun production(): MobileSessionReconnectPolicy =
            ExponentialMobileSessionReconnectPolicy(
                baseDelayMs = 250L,
                maxDelayMs = 30_000L,
                jitterRatio = 0.2,
            )

        fun deterministic(
            baseDelayMs: Long = 1_000L,
            maxDelayMs: Long = 30_000L,
        ): MobileSessionReconnectPolicy =
            ExponentialMobileSessionReconnectPolicy(
                baseDelayMs = baseDelayMs,
                maxDelayMs = maxDelayMs,
                jitterRatio = 0.0,
            )
    }
}
