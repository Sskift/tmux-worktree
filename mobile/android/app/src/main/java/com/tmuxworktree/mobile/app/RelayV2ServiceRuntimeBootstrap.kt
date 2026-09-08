package com.tmuxworktree.mobile.app

import android.content.Context
import com.tmuxworktree.mobile.core.relay.runtime.RelayV2ConnectionRegistry
import com.tmuxworktree.mobile.core.relay.runtime.RelayV2ServiceProcessBootstrap
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayActiveProfileIdentity
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectBarrier
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayProfileDisconnectReceipt
import com.tmuxworktree.mobile.core.relay.v2.profile.RelayV2Profile

/**
 * Process-restart entry point invoked by [com.tmuxworktree.mobile.core.relay.runtime.RelayConnectionService]
 * after an Android system kill + START_STICKY recreation (resolved reflectively so the core
 * runtime package never depends on the app/DI layer).
 *
 * It rebuilds the Relay v2 base runtime composition from the persisted autoConnect profile and
 * installs it on the process-level [RelayV2ConnectionRegistry] scope. This deliberately touches
 * no UI state and no ViewModel fence: startup admission is network-free, and a composition
 * installed here is later reused by the ViewModel startup path via `isReusableFor` instead of
 * creating a second owner.
 */
object RelayV2ServiceRuntimeBootstrap : RelayV2ServiceProcessBootstrap {
    override suspend fun bootstrap(context: Context): Boolean {
        val container = AppContainer(context.applicationContext)
        val runtime = container.createRelayV2ProfileRuntime(
            disconnectBarrier = HeadlessRelayV2DisconnectBarrier,
            clearEphemeralAfterDisconnect = {
                // No ViewModel/UI ephemera exist in the service process; durable cleanup (Room
                // state, notification cancellation, credential clear) is performed by the
                // repository isolation boundary itself.
            },
        )
        val admitted = runtime.admitStartup()
        val profile = admitted.relayV2Profile
        // Only an explicitly consented auto-connect profile self-starts after a process kill;
        // every other admission (enrollment required, recovery, quarantine) leaves the service
        // with nothing to guard, so it stops itself once this bootstrap settles.
        if (profile == null || !profile.autoConnect) return false

        val existing = RelayV2ConnectionRegistry.composition.value
        if (existing != null) {
            if (existing.isReusableFor(profile.identity)) return true
            existing.close()
            RelayV2ConnectionRegistry.clear(existing)
        }
        val composition = container.createRelayV2BaseRuntimeComposition(
            RelayV2ConnectionRegistry.scope,
            profile,
            runtime,
        )
        RelayV2ConnectionRegistry.install(composition)
        return true
    }
}

/**
 * Disconnect barrier for the service-owned composition. Self-revoke drain only reaches here
 * while the composition is live; if the registry has no matching owner (e.g. already retired by
 * a ViewModel handoff) the barrier returns the same no-live-runtime receipt the ViewModel uses,
 * which the repository accepts as drain evidence for the identity it holds.
 */
private object HeadlessRelayV2DisconnectBarrier : RelayProfileDisconnectBarrier {
    override suspend fun awaitServerGrantRevocation(
        profile: RelayActiveProfileIdentity,
    ): Boolean = false

    override suspend fun disconnectAndDrain(
        profile: RelayActiveProfileIdentity,
        barrierId: String,
    ): RelayProfileDisconnectReceipt {
        val composition = RelayV2ConnectionRegistry.composition.value
        return if (composition != null && composition.activeProfileIdentity == profile) {
            composition.disconnectAndDrain(profile, barrierId)
        } else {
            RelayProfileDisconnectReceipt(profile, barrierId)
        }
    }
}
