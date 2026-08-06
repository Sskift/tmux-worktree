package com.tmuxworktree.mobile.core.relay.runtime

import com.tmuxworktree.mobile.core.relay.v2.runtime.RelayV2BaseRuntimeComposition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Process-level holder for the Relay v2 base runtime composition and its owning scope.
 *
 * The composition is created with [scope] as its parent scope so it outlives any single
 * Activity/ViewModel instance; a recreated ViewModel re-attaches to the still-running composition
 * instead of building a fresh one. The [RelayConnectionService] watches [composition] so the
 * foreground keep-alive stays up while the v2 runtime is not fully stopped.
 */
internal object RelayV2ConnectionRegistry {
    private val lock = Any()
    val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val _composition = MutableStateFlow<RelayV2BaseRuntimeComposition?>(null)
    val composition: StateFlow<RelayV2BaseRuntimeComposition?> = _composition.asStateFlow()

    /** Installs [composition] as the process-wide v2 owner, closing any stale owner first. */
    fun install(composition: RelayV2BaseRuntimeComposition) {
        val previous = synchronized(lock) {
            val prior = _composition.value
            _composition.value = composition
            prior
        }
        previous?.takeIf { it !== composition }?.close()
    }

    /** Clears the registry only if it still holds [expected]. */
    fun clear(expected: RelayV2BaseRuntimeComposition?) {
        synchronized(lock) {
            if (_composition.value === expected) _composition.value = null
        }
    }

    /** Tears down the composition and the process scope. */
    fun close() {
        val current = synchronized(lock) {
            _composition.value.also { _composition.value = null }
        }
        current?.close()
        scope.cancel()
    }
}
