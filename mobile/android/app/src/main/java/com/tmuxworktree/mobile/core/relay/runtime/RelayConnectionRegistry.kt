package com.tmuxworktree.mobile.core.relay.runtime

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

/**
 * Process-level holder for the relay connection actor and its owning scope.
 *
 * The [RelayConnectionService] is the lifecycle owner: it creates the scope and actor, and it is
 * responsible for closing them. The [com.tmuxworktree.mobile.app.V2ViewModel] reads the actor from
 * here so the connection outlives the ViewModel (which is cleared when the app is backgrounded).
 */
object RelayConnectionRegistry {
    val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val actor: RelayV1ConnectionActor by lazy { RelayV1ConnectionActor(scope) }

    /** Tears down the actor and its scope. Called by the service when it is destroyed. */
    fun close() {
        actor.close()
        scope.cancel()
    }
}
