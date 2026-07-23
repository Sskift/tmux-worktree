package com.tmuxworktree.mobile.app

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Process-lifetime serial owner for every profile mutation, independent of Relay dialect. */
internal class ProfileMutationCoordinator {
    private val mutex = Mutex()

    suspend fun <T> mutate(block: suspend () -> T): T = mutex.withLock { block() }
}
