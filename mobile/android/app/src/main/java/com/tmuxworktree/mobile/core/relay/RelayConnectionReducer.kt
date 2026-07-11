package com.tmuxworktree.mobile.core.relay

import com.tmuxworktree.mobile.core.model.ConnectionHealth
import com.tmuxworktree.mobile.core.model.ConnectionStatus
import com.tmuxworktree.mobile.core.model.TransportPhase
import kotlin.math.roundToLong

class RelayReconnectPolicy(
    private val random: () -> Double = { kotlin.random.Random.nextDouble() },
) {
    private val baseDelays = longArrayOf(1_000, 2_000, 4_000, 8_000, 15_000)

    fun delayMillis(attempt: Int): Long {
        val base = baseDelays[(attempt - 1).coerceIn(0, baseDelays.lastIndex)]
        val sample = random().coerceIn(0.0, 1.0)
        val factor = 0.85 + (sample * 0.30)
        return (base * factor).roundToLong().coerceIn(250, 15_000)
    }
}

data class RelayTransportState(
    val epoch: Long = 0,
    val phase: TransportPhase = TransportPhase.STOPPED,
    val shouldRun: Boolean = false,
    val attempt: Int = 0,
    val retryAtMillis: Long? = null,
    val lastSyncedAtMillis: Long = 0,
    val errorCode: String = "",
    val errorMessage: String = "",
)

sealed interface RelayTransportSignal {
    data class Start(val nowMillis: Long) : RelayTransportSignal
    data class PauseForNetwork(val nowMillis: Long) : RelayTransportSignal
    data class SocketOpened(val epoch: Long, val nowMillis: Long) : RelayTransportSignal
    data class Ready(val epoch: Long, val nowMillis: Long) : RelayTransportSignal
    data class SocketFailed(
        val epoch: Long,
        val nowMillis: Long,
        val httpCode: Int? = null,
        val message: String = "",
    ) : RelayTransportSignal
    data class SocketClosed(
        val epoch: Long,
        val nowMillis: Long,
        val code: Int,
        val reason: String,
    ) : RelayTransportSignal
    data class RetryElapsed(val epoch: Long, val nowMillis: Long) : RelayTransportSignal
    data class InvalidConfiguration(val nowMillis: Long, val message: String) : RelayTransportSignal
    data class Stop(val nowMillis: Long) : RelayTransportSignal
}

sealed interface RelayTransportEffect {
    data class OpenSocket(val epoch: Long) : RelayTransportEffect
    data class CloseSocket(val code: Int = 1000, val reason: String) : RelayTransportEffect
    data class ScheduleRetry(val epoch: Long, val delayMillis: Long) : RelayTransportEffect
}

data class RelayTransportReduction(
    val state: RelayTransportState,
    val effects: List<RelayTransportEffect> = emptyList(),
    val accepted: Boolean = true,
)

class RelayConnectionReducer(
    private val reconnectPolicy: RelayReconnectPolicy = RelayReconnectPolicy(),
) {
    fun reduce(state: RelayTransportState, signal: RelayTransportSignal): RelayTransportReduction = when (signal) {
        is RelayTransportSignal.Start -> {
            val epoch = state.epoch + 1
            RelayTransportReduction(
                state.copy(
                    epoch = epoch,
                    phase = TransportPhase.CONNECTING,
                    shouldRun = true,
                    attempt = 0,
                    retryAtMillis = null,
                    errorCode = "",
                    errorMessage = "",
                ),
                effects = listOf(
                    RelayTransportEffect.CloseSocket(reason = "reconnect"),
                    RelayTransportEffect.OpenSocket(epoch),
                ),
            )
        }
        is RelayTransportSignal.SocketOpened -> if (!matches(state, signal.epoch)) stale(state) else {
            RelayTransportReduction(
                state.copy(
                    phase = TransportPhase.HANDSHAKING,
                    retryAtMillis = null,
                    errorCode = "",
                    errorMessage = "",
                ),
            )
        }
        is RelayTransportSignal.Ready -> if (!matches(state, signal.epoch)) stale(state) else {
            RelayTransportReduction(
                state.copy(
                    phase = TransportPhase.ONLINE,
                    attempt = 0,
                    retryAtMillis = null,
                    lastSyncedAtMillis = signal.nowMillis,
                    errorCode = "",
                    errorMessage = "",
                ),
            )
        }
        is RelayTransportSignal.PauseForNetwork -> RelayTransportReduction(
            state.copy(
                epoch = state.epoch + 1,
                phase = TransportPhase.WAITING_FOR_NETWORK,
                shouldRun = false,
                retryAtMillis = null,
                errorCode = "NETWORK_UNAVAILABLE",
                errorMessage = "Waiting for network",
            ),
            effects = listOf(RelayTransportEffect.CloseSocket(reason = "network unavailable")),
        )
        is RelayTransportSignal.SocketFailed -> if (!canHandleDisconnect(state, signal.epoch)) stale(state) else {
            if (signal.httpCode == 401 || signal.httpCode == 403) {
                RelayTransportReduction(
                    state.copy(
                        phase = TransportPhase.AUTH_REQUIRED,
                        shouldRun = false,
                        retryAtMillis = null,
                        errorCode = "AUTH_REQUIRED",
                        errorMessage = signal.message.ifBlank { "Authentication required" },
                    ),
                    effects = listOf(RelayTransportEffect.CloseSocket(reason = "authentication required")),
                )
            } else {
                backoff(state, signal.nowMillis, "CONNECTION_FAILED", signal.message)
            }
        }
        is RelayTransportSignal.SocketClosed -> if (!canHandleDisconnect(state, signal.epoch)) stale(state) else {
            backoff(state, signal.nowMillis, "CONNECTION_CLOSED", signal.reason.ifBlank { "Socket closed (${signal.code})" })
        }
        is RelayTransportSignal.RetryElapsed -> {
            if (!matches(state, signal.epoch) || state.phase != TransportPhase.BACKING_OFF) stale(state) else {
                val epoch = state.epoch + 1
                RelayTransportReduction(
                    state.copy(epoch = epoch, phase = TransportPhase.CONNECTING, retryAtMillis = null),
                    effects = listOf(RelayTransportEffect.OpenSocket(epoch)),
                )
            }
        }
        is RelayTransportSignal.InvalidConfiguration -> RelayTransportReduction(
            state.copy(
                epoch = state.epoch + 1,
                phase = TransportPhase.INCOMPATIBLE,
                shouldRun = false,
                retryAtMillis = null,
                errorCode = "INVALID_CONFIGURATION",
                errorMessage = signal.message,
            ),
            effects = listOf(RelayTransportEffect.CloseSocket(reason = "invalid configuration")),
        )
        is RelayTransportSignal.Stop -> RelayTransportReduction(
            state.copy(
                epoch = state.epoch + 1,
                phase = TransportPhase.STOPPED,
                shouldRun = false,
                attempt = 0,
                retryAtMillis = null,
                errorCode = "",
                errorMessage = "",
            ),
            effects = listOf(RelayTransportEffect.CloseSocket(reason = "user disconnect")),
        )
    }

    private fun backoff(
        state: RelayTransportState,
        nowMillis: Long,
        errorCode: String,
        message: String,
    ): RelayTransportReduction {
        if (!state.shouldRun) return RelayTransportReduction(state.copy(phase = TransportPhase.STOPPED))
        val attempt = state.attempt + 1
        val delay = reconnectPolicy.delayMillis(attempt)
        return RelayTransportReduction(
            state.copy(
                phase = TransportPhase.BACKING_OFF,
                attempt = attempt,
                retryAtMillis = nowMillis + delay,
                errorCode = errorCode,
                errorMessage = message,
            ),
            effects = listOf(RelayTransportEffect.ScheduleRetry(state.epoch, delay)),
        )
    }

    private fun matches(state: RelayTransportState, epoch: Long): Boolean = state.shouldRun && epoch == state.epoch
    private fun canHandleDisconnect(state: RelayTransportState, epoch: Long): Boolean =
        matches(state, epoch) && state.phase != TransportPhase.BACKING_OFF
    private fun stale(state: RelayTransportState): RelayTransportReduction = RelayTransportReduction(state, accepted = false)
}

fun RelayTransportState.toConnectionHealth(): ConnectionHealth {
    val overall = when (phase) {
        TransportPhase.ONLINE -> ConnectionStatus.ONLINE
        TransportPhase.CONNECTING, TransportPhase.HANDSHAKING -> ConnectionStatus.CONNECTING
        TransportPhase.BACKING_OFF -> ConnectionStatus.RECOVERING
        TransportPhase.AUTH_REQUIRED -> ConnectionStatus.AUTH_REQUIRED
        TransportPhase.INCOMPATIBLE -> ConnectionStatus.INCOMPATIBLE
        TransportPhase.WAITING_FOR_NETWORK -> ConnectionStatus.PAUSED
        TransportPhase.STOPPED -> ConnectionStatus.OFFLINE
    }
    return ConnectionHealth(
        phase = phase,
        overall = overall,
        retryAtMillis = retryAtMillis,
        attempt = attempt,
        lastSyncedAtMillis = lastSyncedAtMillis,
        errorCode = errorCode,
        errorMessage = errorMessage,
        protocolLabel = "v1 compatibility mode",
    )
}
