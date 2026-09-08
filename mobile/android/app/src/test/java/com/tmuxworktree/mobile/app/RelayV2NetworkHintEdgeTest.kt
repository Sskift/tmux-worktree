package com.tmuxworktree.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins the edge gating of the process-scope network hint collector (D044 review):
 *
 * - an offline first frame must not fire a spurious LOST (the collector seeds with an
 *   unobserved edge, previously it started `lastAvailable = false` and called onNetworkLost
 *   unconditionally);
 * - LOST must be edge-gated true→false, so repeated offline emissions (a per-failure
 *   composition state re-triggers combine) do not cancel the just-scheduled backoff timer;
 * - AVAILABLE must fire on a false→true edge AND on a network-handle change while still
 *   available (Wi-Fi↔cellular/VPN handover), matching the old UI collector's networkChanged;
 * - an unchanged online replay must not re-fire AVAILABLE.
 */
class RelayV2NetworkHintEdgeTest {
    private fun next(
        edge: RelayV2NetworkHintEdge,
        available: Boolean,
        handle: Long? = null,
    ): Pair<RelayV2NetworkHintAction, RelayV2NetworkHintEdge> =
        relayV2NetworkHintAction(edge, available, handle)

    @Test
    fun offlineFirstFrameDoesNotFireSpuriousLost() {
        val (action, edge) = next(RelayV2NetworkHintEdge.unobserved, available = false, handle = null)
        assertEquals(RelayV2NetworkHintAction.NONE, action)
        // A later offline replay also does not fire.
        assertEquals(
            RelayV2NetworkHintAction.NONE,
            next(edge, available = false, handle = null).first,
        )
    }

    @Test
    fun recoveryEdgeFiresAvailableAndLossEdgeFiresLostOnce() {
        val offline = next(RelayV2NetworkHintEdge.unobserved, available = false).second
        val (back, online) = next(offline, available = true, handle = 10L)
        assertEquals(RelayV2NetworkHintAction.AVAILABLE, back)

        val (lost, lostEdge) = next(online, available = false, handle = null)
        assertEquals(RelayV2NetworkHintAction.LOST, lost)

        // Repeated offline emissions (composition state replays while the network stays down)
        // must not re-fire LOST, which would cancel the rescheduled backoff attempt.
        repeat(3) {
            assertEquals(
                RelayV2NetworkHintAction.NONE,
                next(lostEdge, available = false, handle = null).first,
            )
        }
    }

    @Test
    fun networkHandleChangeWhileAvailableAcceleratesReconnect() {
        val online = next(RelayV2NetworkHintEdge.unobserved, available = true, handle = 10L).second
        // Wi-Fi -> cellular handover: availability stays true but the active network changes.
        val (handover, _) = next(online, available = true, handle = 20L)
        assertEquals(RelayV2NetworkHintAction.AVAILABLE, handover)
    }

    @Test
    fun unchangedOnlineReplayDoesNotRefireAvailable() {
        val online = next(RelayV2NetworkHintEdge.unobserved, available = true, handle = 10L).second
        assertEquals(
            RelayV2NetworkHintAction.NONE,
            next(online, available = true, handle = 10L).first,
        )
        // A composition swap while online replays the same (available, handle) edge and must
        // not spuriously hint; the freshly installed composition starts its own connect.
        assertEquals(
            RelayV2NetworkHintAction.NONE,
            next(online, available = true, handle = 10L).first,
        )
    }

    @Test
    fun handleChangeFromNullWhileOfflineStaysQuiet() {
        // Offline emissions carry a null handle; a null->null replay stays quiet and never
        // escalates to LOST, and a null handle while offline never fires AVAILABLE.
        val offline = next(RelayV2NetworkHintEdge.unobserved, available = false, handle = null).second
        assertEquals(
            RelayV2NetworkHintAction.NONE,
            next(offline, available = false, handle = null).first,
        )
    }
}
