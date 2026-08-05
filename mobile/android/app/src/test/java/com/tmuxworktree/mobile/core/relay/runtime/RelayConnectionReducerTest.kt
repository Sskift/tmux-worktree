package com.tmuxworktree.mobile.core.relay.runtime

import com.tmuxworktree.mobile.core.model.TransportPhase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayConnectionReducerTest {
    private val reducer = RelayConnectionReducer(RelayReconnectPolicy { 0.5 })

    @Test
    fun `uses 1 2 4 8 15 second reconnect sequence at midpoint jitter`() {
        var state = reducer.reduce(RelayTransportState(), RelayTransportSignal.Start(0)).state
        val delays = mutableListOf<Long>()
        repeat(5) { index ->
            val reduction = reducer.reduce(
                state,
                RelayTransportSignal.SocketFailed(state.epoch, index * 20_000L, message = "offline"),
            )
            delays += (reduction.effects.single() as RelayTransportEffect.ScheduleRetry).delayMillis
            state = reduction.state.copy(phase = TransportPhase.CONNECTING)
        }
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 15_000L), delays)
    }

    @Test
    fun `401 and 403 require authentication without retry`() {
        val started = reducer.reduce(RelayTransportState(), RelayTransportSignal.Start(0)).state
        val result = reducer.reduce(
            started,
            RelayTransportSignal.SocketFailed(started.epoch, 1, httpCode = 401, message = "Unauthorized"),
        )

        assertEquals(TransportPhase.AUTH_REQUIRED, result.state.phase)
        assertFalse(result.state.shouldRun)
        assertTrue(result.effects.none { it is RelayTransportEffect.ScheduleRetry })
    }

    @Test
    fun `events from replaced socket epoch are ignored`() {
        val first = reducer.reduce(RelayTransportState(), RelayTransportSignal.Start(0)).state
        val second = reducer.reduce(first, RelayTransportSignal.Start(1)).state

        val stale = reducer.reduce(
            second,
            RelayTransportSignal.SocketFailed(first.epoch, 2, message = "old socket"),
        )

        assertFalse(stale.accepted)
        assertEquals(second, stale.state)
        assertTrue(stale.effects.isEmpty())
    }

    @Test
    fun `failure followed by close schedules only one retry`() {
        val started = reducer.reduce(RelayTransportState(), RelayTransportSignal.Start(0)).state
        val failed = reducer.reduce(
            started,
            RelayTransportSignal.SocketFailed(started.epoch, 1, message = "offline"),
        )
        val duplicateClose = reducer.reduce(
            failed.state,
            RelayTransportSignal.SocketClosed(started.epoch, 2, 1006, "closed"),
        )

        assertFalse(duplicateClose.accepted)
        assertTrue(duplicateClose.effects.isEmpty())
    }

    @Test
    fun `socket open keeps retry attempt until protocol ready`() {
        val started = reducer.reduce(RelayTransportState(), RelayTransportSignal.Start(0)).state
        val firstFailure = reducer.reduce(
            started,
            RelayTransportSignal.SocketFailed(started.epoch, 1, message = "offline"),
        ).state
        val retrying = reducer.reduce(
            firstFailure,
            RelayTransportSignal.RetryElapsed(firstFailure.epoch, 1_001),
        ).state

        val opened = reducer.reduce(
            retrying,
            RelayTransportSignal.SocketOpened(retrying.epoch, 1_002),
        ).state
        assertEquals(1, opened.attempt)
        assertEquals(TransportPhase.HANDSHAKING, opened.phase)

        val ready = reducer.reduce(
            opened,
            RelayTransportSignal.Ready(opened.epoch, 1_003),
        ).state
        assertEquals(0, ready.attempt)
        assertEquals(TransportPhase.ONLINE, ready.phase)
    }

    @Test
    fun `network pause stops retries in waiting state`() {
        val started = reducer.reduce(RelayTransportState(), RelayTransportSignal.Start(0)).state
        val failed = reducer.reduce(
            started,
            RelayTransportSignal.SocketFailed(started.epoch, 1, message = "offline"),
        ).state

        val paused = reducer.reduce(failed, RelayTransportSignal.PauseForNetwork(2))

        assertEquals(TransportPhase.WAITING_FOR_NETWORK, paused.state.phase)
        assertFalse(paused.state.shouldRun)
        assertEquals(null, paused.state.retryAtMillis)
        assertEquals("NETWORK_UNAVAILABLE", paused.state.errorCode)
        assertTrue(paused.effects.single() is RelayTransportEffect.CloseSocket)
    }

    @Test
    fun `network available while backing off reconnects immediately`() {
        val started = reducer.reduce(RelayTransportState(), RelayTransportSignal.Start(0)).state
        val backingOff = reducer.reduce(
            started,
            RelayTransportSignal.SocketFailed(started.epoch, 1, message = "offline"),
        ).state
        assertEquals(TransportPhase.BACKING_OFF, backingOff.phase)

        val available = reducer.reduce(backingOff, RelayTransportSignal.NetworkAvailable(2))

        assertTrue(available.accepted)
        assertEquals(TransportPhase.CONNECTING, available.state.phase)
        assertEquals(null, available.state.retryAtMillis)
        val openSocket = available.effects.single { it is RelayTransportEffect.OpenSocket }
            as RelayTransportEffect.OpenSocket
        assertEquals(backingOff.epoch + 1, openSocket.epoch)
    }

    @Test
    fun `network available while waiting for network reconnects immediately`() {
        val started = reducer.reduce(RelayTransportState(), RelayTransportSignal.Start(0)).state
        val waiting = reducer.reduce(started, RelayTransportSignal.PauseForNetwork(1)).state
        assertEquals(TransportPhase.WAITING_FOR_NETWORK, waiting.phase)

        val available = reducer.reduce(waiting, RelayTransportSignal.NetworkAvailable(2))

        assertTrue(available.accepted)
        assertEquals(TransportPhase.CONNECTING, available.state.phase)
        assertTrue(available.effects.any { it is RelayTransportEffect.OpenSocket })
    }

    @Test
    fun `network available while online is a no-op`() {
        val started = reducer.reduce(RelayTransportState(), RelayTransportSignal.Start(0)).state
        val opened = reducer.reduce(
            started,
            RelayTransportSignal.SocketOpened(started.epoch, 1),
        ).state
        val online = reducer.reduce(
            opened,
            RelayTransportSignal.Ready(opened.epoch, 2),
        ).state
        assertEquals(TransportPhase.ONLINE, online.phase)

        val available = reducer.reduce(online, RelayTransportSignal.NetworkAvailable(3))

        assertFalse(available.accepted)
        assertEquals(online, available.state)
        assertTrue(available.effects.isEmpty())
    }

    @Test
    fun `network lost while online closes socket and schedules 60s backoff`() {
        val started = reducer.reduce(RelayTransportState(), RelayTransportSignal.Start(0)).state
        val opened = reducer.reduce(
            started,
            RelayTransportSignal.SocketOpened(started.epoch, 1),
        ).state
        val online = reducer.reduce(
            opened,
            RelayTransportSignal.Ready(opened.epoch, 2),
        ).state

        val lost = reducer.reduce(online, RelayTransportSignal.NetworkLost(3))

        assertTrue(lost.accepted)
        assertEquals(TransportPhase.BACKING_OFF, lost.state.phase)
        assertEquals("NETWORK_UNAVAILABLE", lost.state.errorCode)
        assertEquals(3 + RelayReconnectPolicy.SLOW_BACKOFF_MILLIS, lost.state.retryAtMillis)
        assertTrue(lost.effects.any { it is RelayTransportEffect.CloseSocket })
        val retry = lost.effects.single { it is RelayTransportEffect.ScheduleRetry }
            as RelayTransportEffect.ScheduleRetry
        assertEquals(RelayReconnectPolicy.SLOW_BACKOFF_MILLIS, retry.delayMillis)
    }

    @Test
    fun `network lost while backing off reschedules to 60s`() {
        val started = reducer.reduce(RelayTransportState(), RelayTransportSignal.Start(0)).state
        val backingOff = reducer.reduce(
            started,
            RelayTransportSignal.SocketFailed(started.epoch, 1, message = "offline"),
        ).state
        val shortDelay = (backingOff.retryAtMillis ?: 0L) - 1
        assertTrue(shortDelay < RelayReconnectPolicy.SLOW_BACKOFF_MILLIS)

        val lost = reducer.reduce(backingOff, RelayTransportSignal.NetworkLost(2))

        assertTrue(lost.accepted)
        assertEquals(TransportPhase.BACKING_OFF, lost.state.phase)
        assertEquals(2 + RelayReconnectPolicy.SLOW_BACKOFF_MILLIS, lost.state.retryAtMillis)
        val retry = lost.effects.single { it is RelayTransportEffect.ScheduleRetry }
            as RelayTransportEffect.ScheduleRetry
        assertEquals(RelayReconnectPolicy.SLOW_BACKOFF_MILLIS, retry.delayMillis)
    }

    @Test
    fun `network lost while waiting for network is a no-op`() {
        val started = reducer.reduce(RelayTransportState(), RelayTransportSignal.Start(0)).state
        val waiting = reducer.reduce(started, RelayTransportSignal.PauseForNetwork(1)).state

        val lost = reducer.reduce(waiting, RelayTransportSignal.NetworkLost(2))

        assertFalse(lost.accepted)
        assertEquals(waiting, lost.state)
        assertTrue(lost.effects.isEmpty())
    }

    @Test
    fun `network events are ignored when shouldRun is false`() {
        val stopped = RelayTransportState(shouldRun = false)

        val available = reducer.reduce(stopped, RelayTransportSignal.NetworkAvailable(1))
        assertFalse(available.accepted)

        val lost = reducer.reduce(stopped, RelayTransportSignal.NetworkLost(1))
        assertFalse(lost.accepted)
    }
}
